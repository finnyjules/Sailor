/**
 * Step 3, LC10: Frame Animate's keyer in Sailor's own server code
 * (server/frame/clipKey.ts, a port of scripts/clip_key.py), and the decode →
 * key → PNG pipeline around it (server/frame/clipKeyRun.ts) with the bundled
 * ffmpeg. The two golden hashes are the Python keyer's own output for the same
 * synthetic frames (scripts/clip_key.py key_frames, Pillow 12.1, numpy 2.4).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ClipKeyer, dilateMask, fit, flattenOnto, gaussianBlur, pickKeyColour, pilResize, pyRound, reachPx, type RGB,
} from '../../server/frame/clipKey'
import { flattenStill, keyClip, readStill } from '../../server/frame/clipKeyRun'
import { encodeVideo } from '../../server/media/encode'
import { MediaError, mediaLimiter } from '../../server/media/run'

const W = 48
const H = 48
const ROSE: RGB = [200, 60, 90]

/** The disc the Python golden used: opaque inside r 13, half at 13–14. */
function disc(cx: number): Uint8Array {
  const a = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - 24)
    a[y * W + x] = d < 13 ? 255 : d < 14 ? 128 : 0
  }
  return a
}
function stillRgba(): Uint8Array {
  const a = disc(24)
  const s = new Uint8Array(W * H * 4)
  for (let p = 0; p < W * H; p++) if (a[p]) { s.set(ROSE, p * 4); s[p * 4 + 3] = a[p]! }
  return s
}
/** The disc moved `shift` px right, over an off-key textured green (40, 225, 70) ± 2. */
function frame(shift: number): Uint8Array {
  const a = disc(24 + shift)
  const f = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x
    const t = ((x * 7 + y * 13) % 5) - 2
    const al = a[p]! / 255
    const bg = [40 + t, 225 + t, 70 + t]
    for (let c = 0; c < 3; c++) f[p * 3 + c] = Math.trunc(Math.min(255, Math.max(0, ROSE[c]! * al + bg[c]! * (1 - al))))
  }
  return f
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const alphaAt = (rgba: Uint8Array, x: number, y: number, w = W) => rgba[(y * w + x) * 4 + 3]!

describe('the keyer, on synthetic frames', () => {
  const keyer = new ClipKeyer(stillRgba(), W, H, [0, 255, 0], W, H)

  it('equals the Python keyer byte for byte', () => {
    expect(sha(keyer.keyFrame(frame(0)))).toBe('5f2bc35eca9b13f75e349e9cf679f534e59811d1b9c35c9c2bb917b291b8cb4b')
    expect(sha(keyer.keyFrame(frame(2)))).toBe('5a7988811adb96a3f7fe0a8857dc36a7e3eb9610b7384190349b561c8c4538da')
  })

  it('keys the off-key background out and keeps the subject', () => {
    const out = keyer.keyFrame(frame(2))
    expect(alphaAt(out, 0, 0)).toBe(0)
    expect(alphaAt(out, 5, 40)).toBe(0)
    expect(alphaAt(out, 26, 24)).toBe(255)
    // Hidden colour is zeroed.
    expect([...out.subarray(0, 3)]).toEqual([0, 0, 0])
    // The edge is soft: some levels strictly between.
    let soft = 0
    for (let p = 0; p < W * H; p++) { const a = out[p * 4 + 3]!; if (a > 0 && a < 255) soft++ }
    expect(soft).toBeGreaterThan(20)
  })

  it('keeps a subject-coloured blob outside the still\'s guard transparent', () => {
    const f = frame(0)
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) f.set(ROSE, (y * W + x) * 3)
    const out = keyer.keyFrame(f)
    expect(alphaAt(out, 4, 4)).toBe(0)
  })

  it('suppresses green spill on partly transparent pixels only', () => {
    const out = keyer.keyFrame(frame(0))
    for (let p = 0; p < W * H; p++) {
      const a = out[p * 4 + 3]!
      if (a > 0 && a < 254) expect(out[p * 4 + 1]!).toBeLessThanOrEqual(Math.max(out[p * 4]!, out[p * 4 + 2]!))
    }
  })

  it('writes at the still\'s longest edge when the frames are larger (Lanczos down)', () => {
    const big = pilResize(frame(0), W, H, 3, 96, 96, 'lanczos')
    const k = new ClipKeyer(stillRgba(), W, H, [0, 255, 0], 96, 96)
    expect([k.ow, k.oh]).toEqual([48, 48])
    expect(k.keyFrame(big).length).toBe(48 * 48 * 4)
  })
})

describe('the pieces', () => {
  it('picks green for a rose and blue once over 3 % of the opaque still is green', () => {
    expect(pickKeyColour(stillRgba())).toBe('#00ff00')
    // 8 × 8 rose, its top two rows green leaves: 25 %.
    const s = new Uint8Array(64 * 4)
    for (let p = 0; p < 64; p++) s.set(p < 16 ? [30, 200, 40, 255] : [200, 60, 90, 255], p * 4)
    expect(pickKeyColour(s)).toBe('#0000ff')
    // Transparent green does not count.
    const t = new Uint8Array(16).fill(0); t.set([30, 200, 40, 0], 0); t.set([200, 60, 90, 255], 4)
    expect(pickKeyColour(t)).toBe('#00ff00')
  })

  it('flattens onto the key colour behind transparent pixels', () => {
    const rgb = flattenOnto(new Uint8Array([0, 0, 0, 0, 200, 60, 90, 255]), [0, 255, 0])
    expect([...rgb]).toEqual([0, 255, 0, 200, 60, 90])
  })

  it('rounds like Python and fits like _fit', () => {
    expect([pyRound(2.5), pyRound(3.5), pyRound(-0.5), pyRound(1.2)]).toEqual([2, 4, -0, 1])
    expect(reachPx(1020)).toBe(26)
    expect(reachPx(980)).toBe(24) // 24.5 → 24, half to even
    expect(fit(960, 960, 786)).toEqual([786, 786])
    expect(fit(1280, 720, 960)).toEqual([960, 540])
    expect(fit(640, 360, 800)).toEqual([640, 360])
  })

  it('dilates as a square of the reach, never wrapping round the edges', () => {
    const m = new Uint8Array(10 * 6); m[0] = 1
    const d = dilateMask(m, 10, 6, 2)
    expect(d[2 * 10 + 2]).toBe(1)
    expect(d[3 * 10 + 0]).toBe(0)
    expect(d[0 * 10 + 9]).toBe(0)
  })

  it('blurs an impulse as PIL\'s GaussianBlur(0.8) does', () => {
    const a = new Uint8Array(15); a[7] = 255
    expect([...gaussianBlur(a, 15, 1, 0.8)]).toEqual([0, 0, 0, 0, 0, 7, 52, 138, 52, 7, 0, 0, 0, 0, 0])
  })
})

describe('decode, key and write a clip with the bundled ffmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clip-key-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  async function clip(n: number, size = 64): Promise<string> {
    const out = join(dir, `c${n}_${size}.mp4`)
    if (existsSync(out)) return out
    async function* each() {
      for (let i = 0; i < n; i++) {
        const f = pilResize(frame(i % 3), W, H, 3, size, size, 'bilinear')
        yield f
      }
    }
    await encodeVideo({ input: { kind: 'rgb', w: size, h: size, frames: each() }, out, fps: { num: 24, den: 1 }, quality: { crf: 17, preset: 'medium' }, userId: null, outRoots: [dir] })
    return out
  }
  async function stillPng(): Promise<Buffer> {
    return sharp(stillRgba(), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  }

  it('reads and flattens the still', async () => {
    const still = await readStill(await stillPng())
    expect([still.w, still.h]).toEqual([W, H])
    const { keyHex, flat } = await flattenStill(still)
    expect(keyHex).toBe('#00ff00')
    const m = await sharp(flat).metadata()
    expect([m.width, m.height, m.channels]).toEqual([W, H, 3])
  })

  it('writes every frame but the returning last one, clip.json and source.mp4', async () => {
    const video = await clip(6)
    const out = join(dir, 'out1'); mkdirSync(out)
    const meta = await keyClip({ video, roots: [dir], still: await readStill(await stillPng()), key: '#00ff00', outDir: out, trimLast: true, userId: null, maxFrames: 100 })
    expect(meta).toEqual({ frames: 5, fps: 24, width: 48, height: 48 })
    const files = readdirSync(out).sort()
    expect(files).toEqual(['000000.png', '000001.png', '000002.png', '000003.png', '000004.png', 'clip.json', 'source.mp4'])
    expect(JSON.parse(readFileSync(join(out, 'clip.json'), 'utf8'))).toEqual({ ...meta, key: '#00ff00' })
    const { data, info } = await sharp(join(out, '000000.png')).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    expect(data[3]).toBe(0)
    expect(data[(24 * 48 + 24) * 4 + 3]).toBe(255)
  })

  it('refuses past maxFrames and past maxBytes', async () => {
    const video = await clip(6)
    const still = await readStill(await stillPng())
    const o2 = join(dir, 'out2'); mkdirSync(o2)
    await expect(keyClip({ video, roots: [dir], still, key: '#00ff00', outDir: o2, trimLast: true, userId: null, maxFrames: 3 })).rejects.toMatchObject({ word: 'tooManyFrames' })
    const o3 = join(dir, 'out3'); mkdirSync(o3)
    await expect(keyClip({ video, roots: [dir], still, key: '#00ff00', outDir: o3, trimLast: true, userId: null, maxFrames: 100, maxBytes: 200 })).rejects.toMatchObject({ word: 'tooBig' })
  })

  it('Stop kills the decode: it fails as stopped and leaves no job running', async () => {
    const video = await clip(40, 256)
    const out = join(dir, 'out4'); mkdirSync(out)
    const ac = new AbortController()
    const run = keyClip({ video, roots: [dir], still: await readStill(await stillPng()), key: '#00ff00', outDir: out, trimLast: true, userId: 'user_stop', maxFrames: 100, signal: ac.signal })
    const t0 = Date.now()
    while (!readdirSync(out).some(n => n.endsWith('.png')) && Date.now() - t0 < 20_000) await new Promise(r => setTimeout(r, 5))
    ac.abort()
    const err = await run.catch(e => e)
    expect(err).toBeInstanceOf(MediaError)
    expect((err as MediaError).word).toBe('stopped')
    expect(mediaLimiter().pending('user_stop')).toBe(0)
    expect(readdirSync(out)).not.toContain('clip.json')
  })
})
