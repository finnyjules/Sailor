/**
 * Step 3, LC10: POST /api/frame/animate end to end with the model faked, locally
 * and in hosted. The keyer is Sailor's own (server/frame/clipKey.ts) and the
 * clip is decoded by the bundled ffmpeg, so no Python is started anywhere.
 * Everything knowable before the paid call is refused before it; Stop, in the
 * model's call or in the keying, leaves no folder and no ffmpeg running.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  // ffmpeg is allowed (runMedia uses spawn); no execFile — the old Python path — at all.
  return { ...real, execFile: (...args: unknown[]) => { spawned.calls.push(args); throw new Error('no execFile in this spec') } }
})

type FalMode = 'video' | 'none' | 'wait'
const fal = vi.hoisted(() => ({
  mode: 'video' as FalMode, runs: [] as Array<{ endpoint: string; input: Record<string, unknown>; signal?: AbortSignal }>,
  uploads: 0, clip: '', order: [] as string[],
}))
vi.mock('../../server/utils/falRun', () => ({
  runFal: async (endpoint: string, input: Record<string, unknown>, opts: { signal?: AbortSignal }) => {
    fal.order.push('runFal')
    fal.runs.push({ endpoint, input, signal: opts?.signal })
    if (fal.mode === 'wait') {
      await new Promise<void>((resolve) => { if (opts.signal?.aborted) resolve(); else opts.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      throw new Error('Stopped')
    }
    return fal.mode === 'none' ? {} : { video: { url: 'https://fal.media/files/clip.mp4' } }
  },
  firstFalVideoUrl: (r: { video?: { url?: string } }) => r?.video?.url ?? null,
}))
vi.mock('../../server/utils/falStorage', () => ({
  uploadToFalStorage: async () => { fal.uploads++; return 'https://fal.media/files/still.png' },
}))
vi.mock('../../server/runner/falQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/runner/falQueue')>()),
  downloadResult: async () => ({ bytes: new Uint8Array(readFileSync(fal.clip)), contentType: 'video/mp4' }),
}))
const tools = vi.hoisted(() => ({ missing: false }))
vi.mock('../../server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/media/tools')>()
  return { ...real, mediaTools: async () => (tools.missing ? null : real.mediaTools()) }
})

const g = globalThis as any
g.createError = (opts: { statusCode: number; message?: string }) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => { event.__bodyRead = true; return event.__body }

import { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { encodeVideo } from '../../server/media/encode'
import { mediaLimiter } from '../../server/media/run'
import { _resetRateLimits } from '../../server/lib/rateLimit'
import { animateKeptBound } from '../../server/utils/frameAnimate'
import { MEDIA_CAPS } from '#shared/runner/media'
import { CLIP_MODELS } from '~~/app/data/clip-models'

let route: { default: (e: any) => Promise<any>; ANIMATE_TOO_LARGE: string }
const scratch = mkdtempSync(join(tmpdir(), 'animate-route-'))
let root = ''
const CLERK = 'NUXT_CLERK_SECRET_KEY'
const savedClerk = process.env[CLERK]
const db = { rows: [] as Array<[string, string]>, query: async (sql: string, params?: unknown[]) => {
  fal.order.push('recordUpload')
  if (/INSERT INTO input_uploads/.test(sql)) db.rows.push([String(params![0]), String(params![1])])
  return { rows: [] }
} }

/** A clip of `n` frames: a rose disc moving over off-key green, `size`². */
async function makeClip(name: string, n: number, size: number): Promise<string> {
  const out = join(scratch, name)
  async function* each() {
    for (let i = 0; i < n; i++) {
      const f = new Uint8Array(size * size * 3)
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const inside = Math.hypot(x - size / 2 - (i % 4), y - size / 2) < size * 0.3
        f.set(inside ? [200, 60, 90] : [40, 225, 70], (y * size + x) * 3)
      }
      yield f
    }
  }
  await encodeVideo({ input: { kind: 'rgb', w: size, h: size, frames: each() }, out, fps: { num: 24, den: 1 }, quality: { crf: 17, preset: 'medium' }, userId: null, outRoots: [scratch] })
  return out
}
async function stillDataUrl(size = 64, w = size, h = size): Promise<string> {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.3) rgba.set([200, 60, 90, 255], (y * w + x) * 4)
  }
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()
  return 'data:image/png;base64,' + png.toString('base64')
}

let n = 0
function event(body: unknown, userId: string | null = 'user_lc10') {
  const res = Object.assign(new EventEmitter(), { writableEnded: false })
  return {
    __body: body, __bodyRead: false,
    node: { req: { headers: {}, socket: { remoteAddress: `10.10.${(n >> 8) & 255}.${n++ & 255}` } }, res },
    context: userId ? { userId } : {},
  }
}
const clipsDir = () => join(root, 'input', 'sailor_clips')
const leftovers = () => (existsSync(clipsDir()) ? readdirSync(clipsDir()) : [])
async function refusal(p: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  try { await p } catch (e) { return e as any }
  throw new Error('expected a refusal')
}

let small = ''
let long = ''
beforeAll(async () => {
  route = await import('../../server/api/frame/animate.post') as any
  small = await makeClip('small.mp4', 6, 64)
  long = await makeClip('long.mp4', 60, 320)
}, 60_000)
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (savedClerk === undefined) delete process.env[CLERK]; else process.env[CLERK] = savedClerk
  __setInputUploadsDbForTests(null)
})
beforeEach(() => {
  root = mkdtempSync(join(scratch, 'engine-'))
  mkdirSync(join(root, 'input'))
  __setInputUploadsEngineRootForTests(root)
  __setInputUploadsDbForTests(db)
  db.rows.length = 0
  fal.mode = 'video'; fal.runs.length = 0; fal.uploads = 0; fal.clip = small; fal.order.length = 0
  tools.missing = false
  spawned.calls.length = 0
  _resetRateLimits()
})
afterEach(() => { delete process.env[CLERK] })

for (const mode of ['local', 'hosted'] as const) {
  describe(`Animate ${mode}`, () => {
    beforeEach(() => { if (mode === 'hosted') process.env[CLERK] = 'sk_test_lc10'; else delete process.env[CLERK] })

    it('makes a keyed clip folder with no Python', async () => {
      const ev = event({ image: await stillDataUrl(), model: 'seedance-2.0', prompt: 'petals sway', seconds: 5 })
      const res = await route.default(ev)
      expect(res).toMatchObject({ frames: 5, fps: 24, model: 'seedance-2.0', prompt: 'petals sway' })
      expect(res.dir).toMatch(/^sailor_clips\/clip_\d+_[0-9a-f]{12}$/)
      const dir = join(root, 'input', res.dir)
      expect(readdirSync(dir).sort()).toEqual(['000000.png', '000001.png', '000002.png', '000003.png', '000004.png', 'clip.json', 'source.mp4'])
      expect(JSON.parse(readFileSync(join(dir, 'clip.json'), 'utf8'))).toEqual({ frames: 5, fps: 24, width: 64, height: 64, key: '#00ff00', model: 'seedance-2.0', prompt: 'petals sway' })
      // Only the finished folder is left (no staging folder).
      expect(leftovers()).toEqual([res.dir.split('/')[1]])
      expect(fal.runs).toHaveLength(1)
      expect(fal.runs[0]!.endpoint).toBe('bytedance/seedance-2.0/image-to-video')
      expect(String(fal.runs[0]!.input.prompt)).toMatch(/^petals sway, on a solid green screen background/)
      expect(fal.runs[0]!.signal).toBeInstanceOf(AbortSignal)
      expect(spawned.calls).toHaveLength(0)
      const { data } = await sharp(join(dir, '000000.png')).raw().toBuffer({ resolveWithObject: true })
      expect(data[3]).toBe(0)
      expect(data[(32 * 64 + 32) * 4 + 3]).toBe(255)
      if (mode === 'hosted') {
        // The name is claimed for the person before the paid call.
        expect(db.rows).toEqual([[`input:${res.dir}:clip.json`, 'user_lc10']])
        expect(fal.order.indexOf('recordUpload')).toBeLessThan(fal.order.indexOf('runFal'))
      }
      else expect(db.rows).toEqual([])
    })

    it('Stop during the model call leaves nothing', async () => {
      fal.mode = 'wait'
      const ev = event({ image: await stillDataUrl(), model: 'hailuo-h3', seconds: 5 })
      const run = route.default(ev)
      while (!fal.runs.length) await new Promise(r => setTimeout(r, 2))
      ev.node.res.emit('close')
      const err = await refusal(run)
      expect(err.statusCode).toBe(499)
      expect(fal.runs[0]!.signal!.aborted).toBe(true)
      expect(leftovers()).toEqual([])
    })

    it('Stop during the keying kills ffmpeg and leaves nothing', async () => {
      fal.clip = long
      const ev = event({ image: await stillDataUrl(320), model: 'seedance-2.0', seconds: 5 })
      const run = route.default(ev)
      const t0 = Date.now()
      const pngs = () => leftovers().flatMap(d => (d.startsWith('.') ? readdirSync(join(clipsDir(), d)) : [])).filter(f => f.endsWith('.png'))
      while (pngs().length < 2 && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 2))
      expect(pngs().length).toBeGreaterThan(0)
      ev.node.res.emit('close')
      const err = await refusal(run)
      expect(err.statusCode).toBe(499)
      expect(leftovers()).toEqual([])
      expect(mediaLimiter().pending('user_lc10')).toBe(0)
      expect(mediaLimiter().pending(null)).toBe(0)
    }, 60_000)

    it('a model with no video fails and leaves nothing', async () => {
      fal.mode = 'none'
      const err = await refusal(route.default(event({ image: await stillDataUrl(), model: 'kling-v3-pro', seconds: 5 })))
      expect(err.statusCode).toBe(502)
      expect(leftovers()).toEqual([])
    })

    it('refuses before the paid call when the video tools are missing', async () => {
      tools.missing = true
      const err = await refusal(route.default(event({ image: await stillDataUrl(), model: 'seedance-2.0', seconds: 5 })))
      expect(err.statusCode).toBe(503)
      expect(err.message).toMatch(/Nothing was charged\.$/)
      expect(fal.runs).toHaveLength(0)
      expect(fal.uploads).toBe(0)
      expect(leftovers()).toEqual([])
    })

    it('refuses an image that is not a real PNG before anything', async () => {
      const bogus = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('nope')]).toString('base64')
      const err = await refusal(route.default(event({ image: bogus, model: 'seedance-2.0', seconds: 5 })))
      expect(err.statusCode).toBe(400)
      expect(fal.runs).toHaveLength(0)
    })
  })
}

describe('Animate hosted only', () => {
  beforeEach(() => { process.env[CLERK] = 'sk_test_lc10' })

  it('refuses a signed-out caller before reading the body', async () => {
    const ev = event({ image: 'x', model: 'seedance-2.0' }, null)
    const err = await refusal(route.default(ev))
    expect(err.statusCode).toBe(401)
    expect(ev.__bodyRead).toBe(false)
    expect(fal.runs).toHaveLength(0)
  })

  it('refuses a picture over the hosted picture cap before the paid call', async () => {
    const err = await refusal(route.default(event({ image: await stillDataUrl(0, 4100, 4100), model: 'seedance-2.0', seconds: 5 })))
    expect(err.statusCode).toBe(413)
    expect(err.message).toBe(route.ANIMATE_TOO_LARGE)
    expect(fal.runs).toHaveLength(0)
    expect(db.rows).toEqual([])
  }, 30_000)
})

describe('the room an attempt may keep', () => {
  it('every catalog model at every length fits hosted, even from the largest picture', () => {
    for (const m of CLIP_MODELS) for (const s of m.durations) {
      expect(animateKeptBound(m.resolution, s, { w: 4096, h: 4096 }), `${m.id} ${s}s`).toBeLessThanOrEqual(MEDIA_CAPS.hosted.keptBytesPerRun)
    }
  })
  it('a 1080p minute would not', () => {
    expect(animateKeptBound('1080p', 60, { w: 2048, h: 2048 })).toBeGreaterThan(MEDIA_CAPS.hosted.keptBytesPerRun)
  })
})
