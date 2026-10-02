/**
 * Step 3, R11.6 (ruling (i)): Upscale (2×) over 1440p, in tiles.
 *
 * A picture over Real-ESRGAN's largest (2560 × 1440) is cut into overlapping
 * tiles under it (shared/runner/upscaleTiles.ts), one call a tile, the 2×
 * tiles faded back into one picture (server/runner/generators/tiles.ts).
 * Python's `_tiled_forward` (comfy_extras/nodes_upscale.py:57-86) averages
 * the overlaps; the fade is the fix-bugs rule's version of it ("looks the
 * same side by side"). The tile count is a TRUE upper bound before the hold;
 * hold = tiles × the per-tile price; a tile that fails, or Stop, charges
 * nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import {
  UPSCALE_2X_CLASS, UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_SLUG, UPSCALE_2X_TILED_MAX_PIXELS, UPSCALE_2X_WORDS, localModelCalls, upscale2xTiles,
} from '#shared/runner/localModels'
import { UPSCALE_TILE_OVERLAP, tileCount, tileCountBound, tileGrid } from '#shared/runner/upscaleTiles'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { MEDIA_CAPS } from '#shared/runner/media'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { cropRgb, tiledCanvas } from '~~/server/runner/generators/tiles'
import { localModelStartProblems, tiledPictureBytesBound } from '~~/server/runner/localModelStart'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'upscale-2x'])
const CAP = UPSCALE_2X_MAX_PIXELS
const CAP_USD = 0.0110592 // 2560 × 1440 = 3.6864 MP × $0.003
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const LOAD = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
const upNode = (from: [string, number] = ['l', 0]) => ({ class_type: UPSCALE_2X_CLASS, inputs: { frames: from, tile_size: 512 } })
const scratch = mkdtempSync(join(tmpdir(), 'upscale-tiles-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A fixed test picture: detail everywhere (x xor y, per channel shifted), small as a PNG. */
function testRgb(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      px[i] = (x ^ y) & 255
      px[i + 1] = ((x >> 1) ^ (y >> 2)) & 255
      px[i + 2] = (x + 2 * y) & 255
    }
  }
  return px
}

/** A stand-in for the model: every pixel doubled each way (what a perfect, tile-blind upscaler agrees on). */
function nearest2x(rgb: Uint8Array, w: number, h: number, offset = 0): Uint8Array {
  const out = new Uint8Array(4 * w * h * 3)
  const W = 2 * w
  for (let y = 0; y < 2 * h; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((y >> 1) * w + (x >> 1)) * 3
      const o = (y * W + x) * 3
      for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.max(0, rgb[s + c]! + offset))
    }
  }
  return out
}

const png = async (rgb: Uint8Array, w: number, h: number) => new Uint8Array(await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer())
const rawOf = async (b: Uint8Array) => {
  const { data, info } = await sharp(b, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), w: info.width, h: info.height, channels: info.channels }
}

// ── The tiles (shared maths) ────────────────────────────────────────────────

describe('the tiles (shared/runner/upscaleTiles.ts)', () => {
  /** Every tile at most the cap, the grid covering the picture, neighbours overlapping by at least 32. */
  const checkGrid = (w: number, h: number) => {
    const g = tileGrid(w, h, CAP)
    expect(g.tw * g.th).toBeLessThanOrEqual(CAP)
    expect([g.xs.length, g.ys.length]).toEqual([g.cols, g.rows])
    expect([g.xs[0], g.ys[0]]).toEqual([0, 0])
    expect([g.xs.at(-1)! + g.tw, g.ys.at(-1)! + g.th]).toEqual([w, h])
    for (let i = 1; i < g.cols; i++) expect(g.xs[i - 1]! + g.tw - g.xs[i]!).toBeGreaterThanOrEqual(Math.min(UPSCALE_TILE_OVERLAP, g.tw))
    for (let j = 1; j < g.rows; j++) expect(g.ys[j - 1]! + g.th - g.ys[j]!).toBeGreaterThanOrEqual(Math.min(UPSCALE_TILE_OVERLAP, g.th))
    expect(tileCount(w, h, CAP)).toBe(g.cols * g.rows)
    return g
  }

  it('at or under 1440p: one tile, the whole picture (R7.2\'s one call); a 4K picture: three tiles of 1302 × 2160', () => {
    expect(tileGrid(2560, 1440, CAP)).toEqual({ cols: 1, rows: 1, tw: 2560, th: 1440, xs: [0], ys: [0] })
    expect(tileGrid(3840, 2160, CAP)).toEqual({ cols: 3, rows: 1, tw: 1302, th: 2160, xs: [0, 1269, 2538], ys: [0] })
    expect(UPSCALE_TILE_OVERLAP).toBe(32)
    for (const [w, h] of [[2561, 1440], [2600, 1500], [3840, 2160], [2160, 3840], [4096, 4096], [12288, 1536], [1, 16_000_000], [5000, 700]] as const) checkGrid(w, h)
  })

  it('the count from the pixels alone is a TRUE upper bound of the tiles of every shape (brute force on a small cap, sampled on the real one)', () => {
    // A small cap: every W × H with W·H ≤ P, for many P.
    for (let p = 101; p < 3000; p += 41) {
      const bound = tileCountBound(p, 100, 4)
      for (let w = 1; w <= p; w++) for (const h of [Math.floor(p / w), Math.max(1, Math.floor(p / w) - 1)]) expect(tileCount(w, h, 100, 4)).toBeLessThanOrEqual(bound)
    }
    // The real cap: shapes up to the largest tiled.
    const P = UPSCALE_2X_TILED_MAX_PIXELS
    const bound = tileCountBound(P, CAP)
    expect(bound).toBe(5)
    for (let w = 1; w <= P; w = Math.ceil(w * 1.07) + 1) expect(tileCount(w, Math.floor(P / w), CAP)).toBeLessThanOrEqual(bound)
    expect(tileCountBound(3840 * 2160, CAP)).toBe(3)
    expect(tileCountBound(CAP, CAP)).toBe(1)
  })

  it('the hold\'s count: the start\'s count from the shapes, never above the pixel bound; one at or under 1440p', () => {
    expect(upscale2xTiles(null)).toBe(1)
    expect(upscale2xTiles(CAP)).toBe(1)
    expect(upscale2xTiles(3840 * 2160)).toBe(3)
    expect(upscale2xTiles(4096 * 4096)).toBe(5)
    expect(upscale2xTiles(4096 * 4096, 4)).toBe(4)
    expect(upscale2xTiles(3840 * 2160, 9)).toBe(3)
  })
})

// ── The blend ───────────────────────────────────────────────────────────────

describe('the blend (server/runner/generators/tiles.ts)', () => {
  /** A picture through the tiles, each tile "upscaled" by `up`, faded back. */
  const through = (rgb: Uint8Array, w: number, h: number, cap: number, up: (tile: Uint8Array, tw: number, th: number, k: number) => Uint8Array) => {
    const g = tileGrid(w, h, cap)
    const canvas = tiledCanvas(g, w, h, 2)
    let k = 0
    for (const [row, y] of g.ys.entries()) for (const [col, x] of g.xs.entries()) canvas.put(row, col, up(cropRgb(rgb, w, x, y, g.tw, g.th), g.tw, g.th, k++))
    return { out: canvas.done(), g }
  }

  it('tiles that agree give back exactly the whole picture upscaled: no seam in the fixed test picture (a grid of 3 × 2)', () => {
    const w = 300
    const h = 200
    const rgb = testRgb(w, h)
    const { out, g } = through(rgb, w, h, 120 * 110, (t, tw, th) => nearest2x(t, tw, th))
    expect(g.cols * g.rows).toBeGreaterThan(4)
    expect(Buffer.from(out).equals(Buffer.from(nearest2x(rgb, w, h)))).toBe(true)
  })

  it('tiles that disagree (each a different brightness) fade into each other across the overlap: no step anywhere', () => {
    const w = 400
    const h = 400
    const rgb = new Uint8Array(w * h * 3).fill(128)
    const offsets = [-12, 12, -12, 12, -12, 12, -12, 12, -12, 12]
    const { out, g } = through(rgb, w, h, 160 * 160, (t, tw, th, k) => nearest2x(t, tw, th, offsets[k]!))
    expect(g.cols).toBeGreaterThan(1)
    expect(g.rows).toBeGreaterThan(1)
    // A 24-level jump spread over the 64-pixel overlap of the 2× picture: at most a level or two between neighbours.
    let most = 0
    const W = 2 * w
    for (let y = 0; y < 2 * h; y++) {
      for (let x = 1; x < W; x++) most = Math.max(most, Math.abs(out[(y * W + x) * 3]! - out[(y * W + x - 1) * 3]!))
    }
    for (let y = 1; y < 2 * h; y++) {
      for (let x = 0; x < W; x++) most = Math.max(most, Math.abs(out[(y * W + x) * 3]! - out[((y - 1) * W + x) * 3]!))
    }
    expect(most).toBeLessThanOrEqual(2)
    // Away from the overlaps each tile is its own (Python's average does the same there).
    expect(out[0]).toBe(116)
  })

  it('tiles must come in order and at their 2× size', () => {
    const g = tileGrid(10, 10, 60, 2)
    const canvas = tiledCanvas(g, 10, 10, 2)
    expect(() => canvas.put(0, 1, new Uint8Array(4 * g.tw * g.th * 3))).toThrow('in order')
    expect(() => canvas.put(0, 0, new Uint8Array(3))).toThrow('wrong size')
    expect(() => canvas.done()).toThrow('Not every tile')
  })
})

// ── The price and the start of the run ──────────────────────────────────────

describe('the hold: tiles × the per-tile price, counted before it', () => {
  it('a picture over 1440p is priced at its tiles, each at the service\'s largest; under it as before', () => {
    const inputs = { frames: ['l', 0], tile_size: 512 }
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { frames: 1, picturePixels: 3840 * 2160, pictureTiles: 3 } })).toEqual({ usd: 3 * CAP_USD, credits: creditsForUsd(3 * CAP_USD) })
    // Two pictures, each held at the most tiles any of them makes.
    expect(localModelCalls(UPSCALE_2X_CLASS, 2, inputs, { picturePixels: 3840 * 2160, pictureTiles: 3 })).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: CAP }, times: 6 }] })
    // The pixel bound alone (a generator's stated largest): its worst shape's tiles.
    expect(localModelCalls(UPSCALE_2X_CLASS, 1, inputs, { picturePixels: 4096 * 4096 })).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: CAP }, times: 5 }] })
    expect(localModelCalls(UPSCALE_2X_CLASS, 1, inputs, { picturePixels: 1000 * 1000 })).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: 1_000_000 }, times: 1 }] })
    // Every tile's own price is never above the held one.
    const g = tileGrid(3840, 2160, CAP)
    expect(paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: g.tw * g.th })!).toBeLessThanOrEqual(CAP_USD)
  })

  it('the start of the run: a 4K picture is tiled (three, from its file\'s shape), its 2× picture counted in the kept room; past 4096 × 4096 left', async () => {
    const prompt: ApiPrompt = { l: LOAD, n: upNode() }
    const shapes = async () => new Map()
    const fourK = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#406080' } }).png().toBuffer()
    const got = await localModelStartProblems(prompt, ON, { hosted: true, shapes, read: async () => new Uint8Array(fourK) })
    expect(got).toMatchObject({ counts: { n: 1 }, pictures: { n: 3840 * 2160 }, tiles: { n: 3 }, problem: null })
    expect(got.keptBytes).toBe(tiledPictureBytesBound(3840 * 2160))
    expect(got.keptByNode?.n).toBe(tiledPictureBytesBound(3840 * 2160))
    expect(tiledPictureBytesBound(3840 * 2160)).toBeGreaterThan(4 * 3840 * 2160 * 3)
    // A generator's stated largest, 4K Nano Banana or an Empty image: from the pixels, or the widgets' shape.
    const empty: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 4000, height: 3000, batch_size: 2, color: 0 } }, n: upNode(['e', 0]) }
    expect(await localModelStartProblems(empty, ON, { hosted: true, shapes })).toMatchObject({ counts: { n: 2 }, tiles: { n: tileCount(4000, 3000, CAP) }, problem: null })
    const past: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 4097, height: 4096, batch_size: 1, color: 0 } }, n: upNode(['e', 0]) }
    expect((await localModelStartProblems(past, ON, { hosted: true, shapes })).problem?.message).toBe(UPSCALE_2X_WORDS.tooLarge)
    expect(UPSCALE_2X_TILED_MAX_PIXELS).toBe(MEDIA_CAPS.hosted.framePixels)
    // Under 1440p nothing changes: no tiles, nothing kept counted.
    const small: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } }, n: upNode(['e', 0]) }
    expect(await localModelStartProblems(small, ON, { hosted: true, shapes })).toMatchObject({ tiles: {}, keptBytes: 0, problem: null })
  })
})

// ── The plan, run by hand ───────────────────────────────────────────────────

async function planFor(measured: Record<string, number>): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: { l: LOAD, n: upNode() }, nodeId: 'n', gateOpen: false, families: ON,
    filesFrom: link => (link[0] === 'l' ? [{ filename: 'p0.png', subfolder: '', type: 'input' } as OutputFile] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
    measured: { frames: 1, ...measured },
  })
  if (p.kind !== 'pipeline') throw new Error('Upscale (2×) is a pipeline')
  return p
}

/** A hand-run io: tile uploads remembered by name, each call answered with its tile doubled (or `fail(k)`). */
function handIo(pic: Uint8Array, o: { fail?: (k: number) => boolean; abortAfter?: number } = {}) {
  const uploads = new Map<string, Uint8Array>()
  const calls: PipelineCall[] = []
  const undelivered: [string, string][] = []
  const kept = new Map<string, Uint8Array>()
  const ac = new AbortController()
  let inFlight = 0
  let most = 0
  const io = {
    signal: ac.signal,
    read: async (f: OutputFile) => (f.type === 'input' ? pic : kept.get(f.filename)!),
    handOff: async (bytes: Uint8Array, name: string) => {
      uploads.set(name, bytes)
      return `https://fal.storage/${name}`
    },
    call: async (x: PipelineCall) => {
      calls.push(x)
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      const k = calls.length - 1
      if (o.abortAfter !== undefined && k >= o.abortAfter) {
        ac.abort()
        throw new Error('stopped')
      }
      if (o.fail?.(k)) throw new Error('The service failed')
      return { result: { output: (x.payload as { image: string }).image.replace('fal.storage', 'replicate.delivery') }, raw: null, urls: [] }
    },
    download: async (url: string) => {
      const name = /\/([^/]+)$/.exec(url)![1]!
      const t = await rawOf(uploads.get(name)!)
      return { bytes: await png(nearest2x(t.data, t.w, t.h), 2 * t.w, 2 * t.h), contentType: 'image/png' }
    },
    keep: async (bytes: Uint8Array, ext: string) => {
      const f: OutputFile = { filename: `k${kept.size}.${ext}`, subfolder: 'run', type: 'kept' }
      kept.set(f.filename, bytes)
      return f
    },
    savedOnce: async (_c: string, _k: string, make: () => Promise<OutputFile>) => make(),
    savePreview: async () => ({ filename: 'live_preview_n_00001.png', subfolder: '', type: 'temp' } as OutputFile),
    undelivered: async (key: string, why: string) => { undelivered.push([key, why]) },
  } as unknown as PipelineIO
  return { io, calls, undelivered, kept, most: () => most }
}

describe('a picture over 1440p (the plan, run by hand)', () => {
  const w = 2600
  const h = 1500
  const rgb = testRgb(w, h)
  let pic: Uint8Array

  it('two tiles, one call each, one at a time, each at its own size\'s price; the 2× picture is the whole picture upscaled, no seam', LONG, async () => {
    pic = await png(rgb, w, h)
    const plan = await planFor({ picturePixels: w * h, pictureTiles: 2 })
    const r = handIo(pic)
    const made = await plan.run(r.io)
    const g = tileGrid(w, h, CAP)
    expect(g.cols * g.rows).toBe(2)
    expect(r.calls.map(c => c.key)).toEqual(['up-0-tile-0', 'up-0-tile-1'])
    expect(r.most()).toBe(1)
    for (const c of r.calls) {
      expect(c.endpoint).toBe(UPSCALE_2X_SLUG)
      expect(c.payload).toMatchObject({ scale: 2, face_enhance: false })
      expect(c.usd).toBe(paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: g.tw * g.th }))
    }
    const out = (made.values[0] as Extract<RunnerValue, { kind: 'files' }>).files[0]!
    const px = await rawOf(r.kept.get(out.filename)!)
    expect([px.w, px.h, px.channels]).toEqual([2 * w, 2 * h, 3])
    expect(Buffer.from(px.data).equals(Buffer.from(nearest2x(rgb, w, h)))).toBe(true)
    expect(r.undelivered).toEqual([])
    expect(made.ui).toMatchObject({ animated: [false] })
  })

  it('more tiles than the start held for: refused before any call; past the largest tiled: refused', LONG, async () => {
    pic ??= await png(rgb, w, h)
    const r = handIo(pic)
    await expect((await planFor({ picturePixels: CAP })).run(r.io)).rejects.toThrow(UPSCALE_2X_WORDS.moreThanHeld)
    expect(r.calls).toEqual([])
    const huge = new Uint8Array(await sharp({ create: { width: 4097, height: 4096, channels: 3, background: '#000' } }).png().toBuffer())
    const r2 = handIo(huge)
    await expect((await planFor({ picturePixels: 4096 * 4096, pictureTiles: 9 })).run(r2.io)).rejects.toThrow(UPSCALE_2X_WORDS.tooLarge)
    expect(r2.calls).toEqual([])
    for (const t of Object.values(UPSCALE_2X_WORDS)) expect(t).not.toMatch(/Node|_|Replicate|ESRGAN|tile/i)
  })

  it('a tile that fails: no more calls, and the tile already answered is marked undelivered (charged 0, Sailor absorbs it)', LONG, async () => {
    pic ??= await png(rgb, w, h)
    const r = handIo(pic, { fail: k => k === 1 })
    await expect((await planFor({ picturePixels: w * h, pictureTiles: 2 })).run(r.io)).rejects.toThrow('The service failed')
    expect(r.calls.length).toBe(2)
    expect(r.undelivered).toEqual([['up-0-tile-0', 'sailor-fault']])
    expect(r.kept.size).toBe(0)
  })

  it('Stop during the second tile: nothing more is sent, the first tile is not charged, nothing is kept', LONG, async () => {
    pic ??= await png(rgb, w, h)
    const r = handIo(pic, { abortAfter: 1 })
    await expect((await planFor({ picturePixels: w * h, pictureTiles: 2 })).run(r.io)).rejects.toThrow()
    expect(r.calls.length).toBe(2)
    expect(r.undelivered).toEqual([['up-0-tile-0', 'sailor-fault']])
    expect(r.kept.size).toBe(0)
  })
})

// ── Through the engine, ComfyUI off ─────────────────────────────────────────

/** A fake Replicate whose answer to each call is its tile doubled (the tile read back from the upload). */
function tileServing(o: { failAt?: number; holdAt?: number } = {}) {
  const replicate = createFakeReplicate({
    answer: (req: { input: Record<string, unknown> }) => {
      const k = replicate.submitted().findIndex(r => r.payload === req.input)
      return k === o.failAt ? null : `https://replicate.delivery/tile/${k}.png`
    },
  })
  const submit = replicate.client.submit
  replicate.client.submit = (async (slug: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
    if (replicate.submitted().length === o.holdAt) replicate.holdNext(1)
    return (submit as (...a: unknown[]) => Promise<unknown>)(slug, payload, ...rest)
  }) as typeof submit
  return replicate
}

async function kitFor(replicate: ReturnType<typeof createFakeReplicate>, pic: Uint8Array) {
  const dir = mkdtempSync(join(scratch, 'kit-'))
  const uploads = new Map<string, Uint8Array>()
  const k = makeKit({
    hosted: true, dir, root: mkdtempSync(join(scratch, 'root-')), replicate,
    deps: {
      families: () => ON,
      kept: createFileKeptBytes(join(dir, 'kept')),
      download: async (url: string) => {
        // The k-th call's tile: what was uploaded for it (its payload's image).
        const i = Number(/\/tile\/(\d+)\.png$/.exec(url)![1])
        const image = String(replicate.submitted()[i]!.payload.image)
        const t = await rawOf(uploads.get(image)!)
        return { bytes: await png(nearest2x(t.data, t.w, t.h), 2 * t.w, 2 * t.h), contentType: 'image/png' }
      },
    },
  })
  writeFileSync(join(k.root, 'input', 'image.png'), pic)
  return { k, uploads }
}

const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])

describe('the acceptance: a 3840 × 2160 picture upscales with ComfyUI off', () => {
  it('Load image → Upscale (2×) → Save image, hosted: quoted and held at three tiles, three calls, a 7680 × 4320 picture with no seam, charged what the tiles cost', LONG, async () => {
    const w = 3840
    const h = 2160
    const rgb = testRgb(w, h)
    const pic = await png(rgb, w, h)
    const prompt: ApiPrompt = { l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    const replicate = tileServing()
    const { k, uploads } = await kitFor(replicate, pic)
    // The tiles the node uploads, by their link (the kit's upload names the link after the file).
    const realSubmit = replicate.client.submit
    replicate.client.submit = (async (slug: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      const image = String(payload.image)
      if (!uploads.has(image)) {
        const name = /\/([^/]+)$/.exec(image)![1]!
        const g = tileGrid(w, h, CAP)
        const kk = Number(/^upscale_tile_0_(\d+)\.png$/.exec(name)![1])
        const x = g.xs[kk % g.cols]!
        const y = g.ys[Math.floor(kk / g.cols)]!
        uploads.set(image, await png(cropRgb(rgb, w, x, y, g.tw, g.th), g.tw, g.th))
      }
      return (realSubmit as (...a: unknown[]) => Promise<unknown>)(slug, payload, ...rest)
    }) as typeof realSubmit
    const tileUsd = paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: 1302 * 2160 })!
    const quoted = await k.engine.quoteRun({ userId: k.userId, takes: [prompt], ...START })
    expect(quoted.credits).toBe(creditsForUsd(3 * CAP_USD) + 1)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.n?.seconds).toMatchObject({ frames: 1, picturePixels: w * h, pictureTiles: 3 })
    expect(replicate.submitted().length).toBe(3)
    // Held at three tiles at the service's largest; charged the three tiles' own prices (marked up once).
    expect(charged(k)).toEqual([[creditsForUsd(3 * CAP_USD) + 1, creditsForUsd(3 * tileUsd) + 1]])
    const saved = take.nodes.s!.outputs[0]!
    const px = await rawOf(new Uint8Array(readFileSync(join(k.root, saved.type, saved.subfolder, saved.filename))))
    expect([px.w, px.h, px.channels]).toEqual([2 * w, 2 * h, 3])
    expect(Buffer.from(px.data).equals(Buffer.from(nearest2x(rgb, w, h)))).toBe(true)
    rmSync(k.root, { recursive: true, force: true })
  })
})

describe('money through the engine (R11.5\'s ruling for pieces)', () => {
  const w = 2600
  const h = 1500
  const rgb = testRgb(w, h)
  const prompt: ApiPrompt = { l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
  const serve = (replicate: ReturnType<typeof createFakeReplicate>, uploads: Map<string, Uint8Array>) => {
    const realSubmit = replicate.client.submit
    replicate.client.submit = (async (slug: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      const image = String(payload.image)
      const kk = Number(/upscale_tile_0_(\d+)\.png$/.exec(image)![1])
      const g = tileGrid(w, h, CAP)
      uploads.set(image, await png(cropRgb(rgb, w, g.xs[kk % g.cols]!, g.ys[Math.floor(kk / g.cols)]!, g.tw, g.th), g.tw, g.th))
      return (realSubmit as (...a: unknown[]) => Promise<unknown>)(slug, payload, ...rest)
    }) as typeof realSubmit
  }

  it('the second tile answers with no picture: the node fails, nothing is charged, the hold released', LONG, async () => {
    const replicate = tileServing({ failAt: 1 })
    const { k, uploads } = await kitFor(replicate, await png(rgb, w, h))
    serve(replicate, uploads)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.nodes.n!.status).toBe('error')
    expect(take.nodes.n!.error).toBe(UPSCALE_2X_WORDS.noAnswer)
    expect(replicate.submitted().length).toBe(2)
    expect(charged(k)).toEqual([[creditsForUsd(2 * CAP_USD) + 1, 0]])
    rmSync(k.root, { recursive: true, force: true })
  })

  it('Stop while the second tile runs: its call is cancelled, no third is sent, nothing is charged', LONG, async () => {
    const replicate = tileServing({ holdAt: 1 })
    const { k, uploads } = await kitFor(replicate, await png(rgb, w, h))
    serve(replicate, uploads)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    for (let i = 0; i < 4000 && replicate.submitted().length < 2; i++) await new Promise(r => setTimeout(r, 5))
    expect(replicate.submitted().length).toBe(2)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(replicate.client.cancel).toHaveBeenCalled()
    expect(replicate.submitted()[1]!.cancelled).toBe(true)
    expect(replicate.submitted().length).toBe(2)
    expect(charged(k)).toEqual([[creditsForUsd(2 * CAP_USD) + 1, 0]])
    rmSync(k.root, { recursive: true, force: true })
  })
})
