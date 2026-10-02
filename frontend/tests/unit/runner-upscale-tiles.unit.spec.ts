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
import { afterAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import {
  UPSCALE_2X_CLASS, UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_SLUG, UPSCALE_2X_TILED_MAX_PIXELS, UPSCALE_2X_TILED_MAX_TILES, UPSCALE_2X_WORDS, localModelCalls, upscale2xTiles,
} from '#shared/runner/localModels'
import { UPSCALE_TILE_MIN_SIDE, UPSCALE_TILE_OVERLAP, tileCount, tileCountBound, tileGrid, tooThinToTile } from '#shared/runner/upscaleTiles'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { LARGEST_INPUT_PIXELS } from '#shared/pricing/editSettings'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { cropRgb, tiledBandBytes, tiledCanvas } from '~~/server/runner/generators/tiles'
import { localModelStartProblems, tiledPictureBytesBound } from '~~/server/runner/localModelStart'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import type { MediaValueIO } from '~~/server/media/values'
import { estimateUsdForNodes } from '~/lib/costEstimate'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'upscale-2x'])
/** A clip's frames in and out in memory while `on` (the L3 clip case); the real writer otherwise. */
const FAKE_FRAMES = vi.hoisted(() => ({ on: null as null | { frames: Uint8Array[]; put: Uint8Array[] } }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    framesOf: (...a: Parameters<typeof real.framesOf>) => {
      const fake = FAKE_FRAMES.on
      if (!fake) return real.framesOf(...a)
      return { async* [Symbol.asyncIterator]() { for (const f of fake.frames) yield f } }
    },
    framesSink: (...a: Parameters<typeof real.framesSink>) => {
      const fake = FAKE_FRAMES.on
      if (!fake) return real.framesSink(...a)
      const [w, h] = a
      return {
        put: async (rgb: Uint8Array) => { fake.put.push(rgb) },
        done: async () => ({ kind: 'frames' as const, file: { filename: 'out.mkv', subfolder: 'run', type: 'kept' }, count: fake.put.length, w, h }),
        abort: async () => {},
      }
    },
  }
})
const ON_CLIP: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'upscale-2x'])
const CAP = UPSCALE_2X_MAX_PIXELS
/** One tile at the measured limit; sums of them are rounded to 1e-8 dollars as the price rounds them. */
const CAP_USD = 0.006290112 // 2 096 704 px (1448², the GPU limit Replicate stated on 2026-10-01) × $0.003 a megapixel
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

  it('at or under the service\'s largest (2 096 704 px, fix round 2): one tile, the whole picture (R7.2\'s one call); 1440p now two; a 4K picture: five tiles of 794 × 2160', () => {
    expect(CAP).toBe(2_096_704)
    expect(tileGrid(1448, 1448, CAP)).toEqual({ cols: 1, rows: 1, tw: 1448, th: 1448, xs: [0], ys: [0] })
    expect(tileGrid(1920, 1080, CAP).cols * tileGrid(1920, 1080, CAP).rows).toBe(1)
    // Over the measured limit but under R7.2's old 1440p cap: tiled now (Replicate refused such a picture whole).
    expect(tileCount(2560, 1440, CAP)).toBe(2)
    expect(tileCount(1302, 2160, CAP)).toBe(2)
    expect(tileGrid(3840, 2160, CAP)).toEqual({ cols: 5, rows: 1, tw: 794, th: 2160, xs: [0, 761, 1523, 2284, 3046], ys: [0] })
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
    expect(bound).toBe(10)
    expect(tileCountBound(4096 * 4096, CAP)).toBe(9)
    for (let w = 1; w <= P; w = Math.ceil(w * 1.07) + 1) expect(tileCount(w, Math.floor(P / w), CAP)).toBeLessThanOrEqual(bound)
    expect(tileCountBound(3840 * 2160, CAP)).toBe(5)
    expect(tileCountBound(CAP, CAP)).toBe(1)
  })

  it('fix round 2: no tile of any picture up to the largest tiled is over 2 096 704 px (Replicate\'s measured GPU limit), nor any count over the bound', () => {
    const P = UPSCALE_2X_TILED_MAX_PIXELS
    const bound = tileCountBound(P, CAP)
    let checked = 0
    // Every width from 1 to 6000, then ever wider (both orientations), each with the tallest height it can have and a few under it.
    for (let w = 1; w <= P; w = w < 6000 ? w + 1 : Math.ceil(w * 1.01)) {
      const top = Math.floor(P / w)
      for (const h of [top, Math.max(1, top - 1), Math.max(1, Math.floor(top / 2)), Math.max(1, Math.floor(top * 0.9))]) {
        for (const [a, b] of [[w, h], [h, w]] as const) {
          const g = tileGrid(a, b, CAP)
          expect(g.tw * g.th).toBeLessThanOrEqual(2_096_704)
          expect(g.cols * g.rows).toBeLessThanOrEqual(bound)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(40_000)
  })

  it('the hold\'s count: the start\'s count from the shapes, never above the pixel bound; one at or under 1440p', () => {
    // Fix round 1 (H1): not measured (the canvas): the most the largest tiled picture makes.
    expect(upscale2xTiles(null)).toBe(10)
    expect(UPSCALE_2X_TILED_MAX_TILES).toBe(10)
    expect(upscale2xTiles(CAP)).toBe(1)
    expect(upscale2xTiles(3840 * 2160)).toBe(5)
    expect(upscale2xTiles(4096 * 4096)).toBe(9)
    expect(upscale2xTiles(4096 * 4096, 4)).toBe(4)
    expect(upscale2xTiles(3840 * 2160, 9)).toBe(5)
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
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { frames: 1, picturePixels: 3840 * 2160, pictureTiles: 5 } })).toEqual({ usd: 0.03145055, credits: creditsForUsd(0.03145055) })
    // Two pictures, each held at the most tiles any of them makes.
    expect(localModelCalls(UPSCALE_2X_CLASS, 2, inputs, { picturePixels: 3840 * 2160, pictureTiles: 5 })).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: CAP }, times: 10 }] })
    // The pixel bound alone (a generator's stated largest): its worst shape's tiles.
    expect(localModelCalls(UPSCALE_2X_CLASS, 1, inputs, { picturePixels: 4096 * 4096 })).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: CAP }, times: 9 }] })
    expect(localModelCalls(UPSCALE_2X_CLASS, 1, inputs, { picturePixels: 1000 * 1000 })).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: 1_000_000 }, times: 1 }] })
    // Every tile's own price is never above the held one.
    const g = tileGrid(3840, 2160, CAP)
    expect(paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: g.tw * g.th })!).toBeLessThanOrEqual(CAP_USD)
  })

  it('the start of the run: a 4K picture is tiled (five, from its file\'s shape), its 2× picture counted in the kept room; past the largest tiled left', async () => {
    const prompt: ApiPrompt = { l: LOAD, n: upNode() }
    const shapes = async () => new Map()
    const fourK = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#406080' } }).png().toBuffer()
    const got = await localModelStartProblems(prompt, ON, { hosted: true, shapes, read: async () => new Uint8Array(fourK) })
    expect(got).toMatchObject({ counts: { n: 1 }, pictures: { n: 3840 * 2160 }, tiles: { n: 5 }, problem: null })
    expect(got.keptBytes).toBe(tiledPictureBytesBound(3840 * 2160))
    expect(got.keptByNode?.n).toBe(tiledPictureBytesBound(3840 * 2160))
    expect(tiledPictureBytesBound(3840 * 2160)).toBeGreaterThan(4 * 3840 * 2160 * 3)
    // A generator's stated largest, 4K Nano Banana or an Empty image: from the pixels, or the widgets' shape.
    const empty: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 4000, height: 3000, batch_size: 2, color: 0 } }, n: upNode(['e', 0]) }
    expect(await localModelStartProblems(empty, ON, { hosted: true, shapes })).toMatchObject({ counts: { n: 2 }, tiles: { n: tileCount(4000, 3000, CAP) }, problem: null })
    const past: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 5000, height: 4000, batch_size: 1, color: 0 } }, n: upNode(['e', 0]) }
    expect((await localModelStartProblems(past, ON, { hosted: true, shapes })).problem?.message).toBe(UPSCALE_2X_WORDS.tooLarge)
    // Fix round 1: the largest picture Sailor makes or takes, so a generator's stated largest is tiled, never left.
    expect(UPSCALE_2X_TILED_MAX_PIXELS).toBe(LARGEST_INPUT_PIXELS)
    // Under 1440p nothing changes: no tiles, nothing kept counted.
    const small: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } }, n: upNode(['e', 0]) }
    expect(await localModelStartProblems(small, ON, { hosted: true, shapes })).toMatchObject({ tiles: {}, keptBytes: 0, problem: null })
  })
})

// ── The plan, run by hand ───────────────────────────────────────────────────

async function planFor(measured: Record<string, number>, o: { pictures?: number; frames?: Extract<RunnerValue, { kind: 'frames' }> } = {}): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: { l: o.frames ? { class_type: 'LoadVideoFrames', inputs: {} } : LOAD, n: upNode() }, nodeId: 'n', gateOpen: false, families: o.frames ? ON_CLIP : ON,
    filesFrom: link => (link[0] === 'l' ? Array.from({ length: o.pictures ?? 1 }, (_x, i) => ({ filename: `p${i}.png`, subfolder: '', type: 'input' } as OutputFile)) : []),
    ...(o.frames ? { valueFrom: () => o.frames } : {}),
    toUrl: async f => `https://fal.storage/${f.filename}`,
    measured: { frames: 1, ...measured },
  })
  if (p.kind !== 'pipeline') throw new Error('Upscale (2×) is a pipeline')
  return p
}

/** A hand-run io: tile uploads remembered by name, each call answered with its tile doubled (or `fail(k)`). */
function handIo(pic: Uint8Array | Uint8Array[], o: { fail?: (k: number) => boolean; abortAfter?: number; prior?: OutputFile; media?: MediaValueIO } = {}) {
  const pics = Array.isArray(pic) ? pic : [pic]
  const saved: [string, string][] = []
  const uploads = new Map<string, Uint8Array>()
  const calls: PipelineCall[] = []
  const undelivered: [string, string][] = []
  const kept = new Map<string, Uint8Array>()
  const ac = new AbortController()
  let inFlight = 0
  let most = 0
  const io = {
    signal: ac.signal,
    read: async (f: OutputFile) => (f.type === 'input' ? pics[Number(/^p(\d+)\.png$/.exec(f.filename)![1])]! : kept.get(f.filename)!),
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
      // A tile's upload, else (one call, the whole picture) the picture itself.
      const t = await rawOf(uploads.get(name) ?? pics[Number(/^p(\d+)\.png$/.exec(name)![1])]!)
      return { bytes: await png(nearest2x(t.data, t.w, t.h), 2 * t.w, 2 * t.h), contentType: 'image/png' }
    },
    keep: async (bytes: Uint8Array, ext: string) => {
      const f: OutputFile = { filename: `k${kept.size}.${ext}`, subfolder: 'run', type: 'kept' }
      kept.set(f.filename, bytes)
      return f
    },
    // A resumed node finds `prior` already kept on its call (fix round 1, L1).
    savedOnce: async (c: string, k: string, make: () => Promise<OutputFile>) => {
      saved.push([c, k])
      return o.prior && k === 'tiled' ? o.prior : make()
    },
    ...(o.media ? { media: o.media } : {}),
    savePreview: async () => ({ filename: 'live_preview_n_00001.png', subfolder: '', type: 'temp' } as OutputFile),
    undelivered: async (key: string, why: string) => { undelivered.push([key, why]) },
  } as unknown as PipelineIO
  return { io, calls, undelivered, kept, saved, most: () => most }
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
    const huge = new Uint8Array(await sharp({ create: { width: 4400, height: 4400, channels: 3, background: '#000' } }).png().toBuffer())
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
  it('Load image → Upscale (2×) → Save image, hosted: quoted and held at five tiles, five calls of at most 2 096 704 px, a 7680 × 4320 picture with no seam, charged what the tiles cost', LONG, async () => {
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
    const tileUsd = paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: 794 * 2160 })!
    const quoted = await k.engine.quoteRun({ userId: k.userId, takes: [prompt], ...START })
    // Fix round 2: the quote for a 3840 × 2160 picture — five tiles at the measured limit's price.
    expect(quoted.credits).toBe(creditsForUsd(5 * CAP_USD) + 1)
    expect(quoted.usd).toBe(0.03145055)
    expect(quoted.credits).toBe(8)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.n?.seconds).toMatchObject({ frames: 1, picturePixels: w * h, pictureTiles: 5 })
    expect(replicate.submitted().length).toBe(5)
    // Every picture sent within the service's measured limit.
    for (const x of replicate.submitted()) {
      const t = await rawOf(uploads.get(String(x.payload.image))!)
      expect(t.w * t.h).toBeLessThanOrEqual(2_096_704)
    }
    // Held at five tiles at the service's largest; charged the five tiles' own prices (marked up once).
    expect(charged(k)).toEqual([[creditsForUsd(5 * CAP_USD) + 1, creditsForUsd(5 * tileUsd) + 1]])
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

// ── Fix round 1 ─────────────────────────────────────────────────────────────

describe('fix round 1', () => {
  it('H1: priced without the picture\'s size (the canvas), Upscale is held up to the largest tiled picture\'s tiles, marked "up to": never below the hold', () => {
    const inputs = { frames: ['l', 0], tile_size: 512 }
    const unmeasured = priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { frames: 1 } })
    expect(unmeasured).toEqual({ usd: 0.0629011, credits: creditsForUsd(0.0629011) })
    // At least the hold of any picture the run can take: the largest tiled, 4096², a 4K picture.
    for (const s of [{ picturePixels: UPSCALE_2X_TILED_MAX_PIXELS }, { picturePixels: 4096 * 4096 }, { picturePixels: 3840 * 2160, pictureTiles: 5 }, { picturePixels: CAP }]) {
      const held = priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { frames: 1, ...s } })
      expect('usd' in unmeasured && 'usd' in held && unmeasured.usd >= held.usd).toBe(true)
    }
    // The canvas's estimate (the run-confirm gate): ten tiles, "(up to)".
    const node = { id: 'n', type: UPSCALE_2X_CLASS, title: 'Upscale (2×)', widgetDefs: [{ name: 'tile_size' }], widgetsValues: [512], linkedInputs: ['frames'], pictures: 1 }
    const est = estimateUsdForNodes([node], { hosted: true, families: ON })!
    expect(est.breakdown).toEqual([{ id: 'n', label: 'Upscale (2×) (up to)', usd: 0.0629011, upTo: true }])
    expect(est.hostedCredits).toBe(creditsForUsd(0.0629011) + 1)
    // A 4K clip "up to" 300 frames: the gate shows at least what the server holds for it (300 × 5 tiles).
    const clip = estimateUsdForNodes([{ ...node, pictures: null }], { hosted: true, families: ON })!
    expect(clip.usd).toBeGreaterThanOrEqual(300 * 5 * CAP_USD)
  })

  it('M1: the blend keeps only the overlap rows besides the picture (a few MB), and still gives the whole picture back across rows of tiles', () => {
    // Column strips (one row of tiles): no band at all.
    expect(tiledBandBytes(tileGrid(3840, 2160, CAP), 3840, 2)).toBe(0)
    // The largest grids by rows: the band is the 2× width × about 64 overlap rows.
    for (const [w, h] of [[4096, 4096], [1536, 12288], [2160, 3840]] as const) {
      const g = tileGrid(w, h, CAP)
      expect(tiledBandBytes(g, w, 2)).toBeLessThanOrEqual(2 * w * 70 * 3)
    }
    // Several rows and columns, exact.
    const w = 300
    const h = 260
    const rgb = testRgb(w, h)
    const g = tileGrid(w, h, 110 * 100)
    expect(g.rows).toBeGreaterThan(2)
    expect(g.cols).toBeGreaterThan(2)
    const canvas = tiledCanvas(g, w, h, 2)
    for (const [row, y] of g.ys.entries()) for (const [col, x] of g.xs.entries()) canvas.put(row, col, nearest2x(cropRgb(rgb, w, x, y, g.tw, g.th), g.tw, g.th))
    expect(Buffer.from(canvas.done()).equals(Buffer.from(nearest2x(rgb, w, h)))).toBe(true)
  })

  it(`L2: tiles are never thinner than ${UPSCALE_TILE_MIN_SIDE} pixels: such a picture is refused plainly before the hold (and before any call); under 1440p any shape is one call`, LONG, async () => {
    expect(UPSCALE_TILE_MIN_SIDE).toBe(64)
    expect(tooThinToTile(65_000, 63, CAP)).toBe(true)
    expect(tooThinToTile(1, 16_000_000, CAP)).toBe(true)
    expect(tooThinToTile(65_000, 64, CAP)).toBe(false)
    expect(tooThinToTile(10_000, 30, CAP)).toBe(false)
    expect(tooThinToTile(3840, 2160, CAP)).toBe(false)
    // The start of the run: a shape known, refused (not left to the engine), in both places.
    const thin: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 65_000, height: 60, batch_size: 1, color: 0 } }, n: upNode(['e', 0]) }
    for (const hosted of [true, false]) {
      const got = await localModelStartProblems(thin, ON, { hosted, shapes: async () => new Map() })
      expect(got.problem).toBeNull()
      expect(got.refused?.message).toBe(UPSCALE_2X_WORDS.tooThin)
    }
    expect(UPSCALE_2X_WORDS.tooThin).toBe('This picture is too long and thin to upscale here. Make its shorter side at least 64 pixels.')
    // The turn, a backstop: refused before any call.
    const pic = new Uint8Array(await sharp({ create: { width: 65_000, height: 60, channels: 3, background: '#123456' } }).png().toBuffer())
    const r = handIo(pic)
    await expect((await planFor({ picturePixels: 65_000 * 60 })).run(r.io)).rejects.toThrow(UPSCALE_2X_WORDS.tooThin)
    expect(r.calls).toEqual([])
  })

  it('L1: the tiled 2× picture is kept once, on the last tile\'s call; a resumed node finds it there and keeps no second copy', LONG, async () => {
    const w = 2600
    const h = 1500
    const pic = await png(testRgb(w, h), w, h)
    const first = handIo(pic)
    await (await planFor({ picturePixels: w * h, pictureTiles: 2 })).run(first.io)
    expect(first.saved).toEqual([['up-0-tile-1', 'tiled']])
    expect(first.kept.size).toBe(1)
    const prior: OutputFile = { filename: 'kept-before.png', subfolder: 'run', type: 'kept' }
    const resumed = handIo(pic, { prior })
    const made = await (await planFor({ picturePixels: w * h, pictureTiles: 2 })).run(resumed.io)
    expect(resumed.kept.size).toBe(0)
    expect((made.values[0] as Extract<RunnerValue, { kind: 'files' }>).files).toEqual([prior])
  })

  it('L3: a batch of a tiled picture and a small one: one call at a time, keys by picture and tile, each picture its own 2×', LONG, async () => {
    const big = testRgb(2600, 1500)
    const small = testRgb(40, 30)
    const pics = [await png(big, 2600, 1500), await png(small, 40, 30)]
    const r = handIo(pics)
    // Held as the start holds it: two pictures, each up to the larger's two tiles.
    const made = await (await planFor({ frames: 2, picturePixels: 2600 * 1500, pictureTiles: 2 }, { pictures: 2 })).run(r.io)
    expect(r.calls.map(c => c.key)).toEqual(['up-0-tile-0', 'up-0-tile-1', 'up-1'])
    expect(r.most()).toBe(1)
    const files = (made.values[0] as Extract<RunnerValue, { kind: 'files' }>).files
    const a = await rawOf(r.kept.get(files[0]!.filename)!)
    expect(Buffer.from(a.data).equals(Buffer.from(nearest2x(big, 2600, 1500)))).toBe(true)
    expect([files.length, (await rawOf(r.kept.get(files[1]!.filename)!)).w]).toEqual([2, 80])
    expect(localModelCalls(UPSCALE_2X_CLASS, 2, {}, { picturePixels: 2600 * 1500, pictureTiles: 2 })).toMatchObject({ steps: [{ times: 4 }] })
  })

  it('L3: a clip of two 2600 × 1500 frames: four calls (two tiles a frame), a batch of two frames at 2× with no seam', LONG, async () => {
    // The frames in and out in memory (FAKE_FRAMES): the kept FFV1 writer can't take 5200 × 3000 frames on a
    // loaded machine (R5.2's writer, a finding of this fix round, not this node's).
    const w = 2600
    const h = 1500
    const frames = [testRgb(w, h), testRgb(w, h).map(v => 255 - v)]
    const v = { kind: 'frames' as const, file: { filename: 'in.mkv', subfolder: 'run', type: 'kept' } as OutputFile, count: 2, w, h }
    FAKE_FRAMES.on = { frames, put: [] }
    try {
      const r = handIo(new Uint8Array(0), { media: { userId: null, hosted: false, runId: 'r' } as unknown as MediaValueIO })
      const made = await (await planFor({ frames: 2, picturePixels: w * h, pictureTiles: 2 }, { frames: v })).run(r.io)
      expect(r.calls.map(c => c.key)).toEqual(['up-0-tile-0', 'up-0-tile-1', 'up-1-tile-0', 'up-1-tile-1'])
      expect(r.most()).toBe(1)
      const out = made.values[0] as Extract<RunnerValue, { kind: 'frames' }>
      expect([out.kind, out.count, out.w, out.h]).toEqual(['frames', 2, 2 * w, 2 * h])
      expect(FAKE_FRAMES.on.put.length).toBe(2)
      for (const [i, f] of frames.entries()) expect(Buffer.from(FAKE_FRAMES.on.put[i]!).equals(Buffer.from(nearest2x(f, w, h)))).toBe(true)
    }
    finally {
      FAKE_FRAMES.on = null
    }
    // The start holds a clip at frames × tiles.
    const p: ApiPrompt = { v: { class_type: 'LoadVideoFrames', inputs: {} }, n: upNode(['v', 0]) }
    const start = await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: async () => new Map([['v:0', { count: 2, w, h, exact: true }]]) })
    expect(start).toMatchObject({ counts: { n: 2 }, tiles: { n: 2 }, problem: null })
    expect(localModelCalls(UPSCALE_2X_CLASS, 2, {}, { picturePixels: w * h, pictureTiles: 2 })).toMatchObject({ steps: [{ times: 4 }] })
  })

  it('L3: a generator\'s stated largest alone (2K Develop, 4.7 MP: three tiles): tiled from the pixel bound, never left', async () => {
    const p: ApiPrompt = {
      z: LOAD,
      g: { class_type: 'DevelopImageNode', inputs: { resolution: '2K', image: ['z', 0] } },
      n: upNode(['g', 0]),
    }
    const got = await localModelStartProblems(p, ON, { hosted: true, shapes: async () => new Map() })
    expect(got).toMatchObject({ counts: { n: 1 }, pictures: { n: 4_718_592 }, tiles: { n: tileCountBound(4_718_592, CAP) }, problem: null })
    expect(got.tiles?.n).toBe(3)
    // A 4K Nano Banana (its widest, 12288 × 1536's pixels) is tiled too: the largest tiled picture.
    const fourK: ApiPrompt = { ...p, g: { class_type: 'DevelopImageNode', inputs: { resolution: '4K', image: ['z', 0] } } }
    expect(await localModelStartProblems(fourK, ON, { hosted: true, shapes: async () => new Map() })).toMatchObject({ tiles: { n: 10 }, problem: null })
  })
})

describe('L3: a count from the picture\'s shape below the pixel bound, through the engine', () => {
  it('Empty image 2850 × 1450 → Upscale (2×) → Save image: held at two tiles (its shape\'s), not the pixels\' three; two calls', LONG, async () => {
    const w = 2850
    const h = 1450
    expect([tileCount(w, h, CAP), tileCountBound(w * h, CAP)]).toEqual([2, 3])
    const prompt: ApiPrompt = {
      e: { class_type: 'EmptyImage', inputs: { width: w, height: h, batch_size: 1, color: 0 } },
      n: upNode(['e', 0]),
      s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } },
    }
    const g = tileGrid(w, h, CAP)
    const black = await png(new Uint8Array(4 * g.tw * g.th * 3), 2 * g.tw, 2 * g.th)
    const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/tile/black.png' })
    const dir = mkdtempSync(join(scratch, 'kit-'))
    const k = makeKit({ hosted: true, dir, root: mkdtempSync(join(scratch, 'root-')), replicate, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')), download: async () => ({ bytes: black, contentType: 'image/png' }) } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['e', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.n?.seconds).toMatchObject({ picturePixels: w * h, pictureTiles: 2 })
    expect(replicate.submitted().length).toBe(2)
    const tileUsd = paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: g.tw * g.th })!
    expect(charged(k)).toEqual([[creditsForUsd(2 * CAP_USD) + 1, creditsForUsd(2 * tileUsd) + 1]])
    rmSync(k.root, { recursive: true, force: true })
  })
})
