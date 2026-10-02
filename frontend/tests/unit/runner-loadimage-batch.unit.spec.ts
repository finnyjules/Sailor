/**
 * R11.9c fix round 5: a LoadImage's animated GIF or WebP as Python's batch of
 * frames, made only where a reader takes it, decoded in one pass, and checked
 * before the hold against every reader's limits and the run's kept room.
 *
 *   I1 — each reader that takes the batch checked (frames × size) before the hold
 *   I2 — first-frame readers decode frame 0 alone (no batch caps); one decode pass
 *   I3 — local-model nodes' per-picture keeps counted with the loader's frames
 *   M1 — Pillow's mode for the whole file decides every frame's mask
 *   M2 — float mask tensors counted
 *   M3 — the abandon tombstone stands before the bake folder exists
 *   M4 — APNG words, Get image size's batch, Image to mask takes the batch
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { bigGif } from './__runner__/bigGif'
import { GATE_CLASS, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import { LOADER_FRAMES_TOO_MUCH, MEDIA_CAPS } from '#shared/runner/media'
import { LOCAL_MODEL_WORDS, UPSCALE_2X_CLASS } from '#shared/runner/localModels'
import { planNode, type DeriveIO, type Derived } from '~~/server/runner/executors'
import { LOADER_BATCH_TOO_LARGE, loaderBatchKeptBytes, loaderBatchReaderRefusal, loaderBatchReaders, loaderBatchStartProblems, loaderBatchTaken } from '~~/server/runner/cards/loaderBatch'
import { LOADER_APNG_WORDS, cardPictureFiles } from '~~/server/runner/cards/bakeReplay'
import { decodeFramesOnce } from '~~/server/runner/cards/loadImage'
import { saveSize } from '~~/server/runner/cards/saveImage'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { localModelStartProblems, pictureCallKeptBound } from '~~/server/runner/localModelStart'
import { abandonShaderBake, bakeFolderAbandoned } from '~~/server/runner/shaderBakeFiles'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

// Every sharp call's options, to prove an animation is decoded in one pass (I2).
const sharpCalls = vi.hoisted(() => [] as unknown[])
vi.mock('sharp', async (importOriginal) => {
  const real = (await importOriginal<typeof import('sharp')>()).default
  const wrapped = new Proxy(real, {
    apply(target, thisArg, args: unknown[]) {
      sharpCalls.push(args[1])
      return Reflect.apply(target, thisArg, args)
    },
  })
  return { default: wrapped }
})
const { default: sharp } = await import('sharp')

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const EDIT_CARDS: ReadonlySet<RunnerFamily> = new Set(['cards', 'fal-edit'])
const MASK_FX: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-mask'] as RunnerFamily[])
const UPSCALE: ReadonlySet<RunnerFamily> = new Set(['cards', 'upscale-2x'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const load = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const save = (from: [string, number], over: Record<string, unknown> = {}) => ({ class_type: 'SaveImage', inputs: { images: from, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false, ...over } })
const edit = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const card = (from: [string, number], batchIndex: number) => ({ class_type: 'Image', inputs: { image: '', export: false, images: from, batch_index: batchIndex } })
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** A WebP of `n` frames of w × h; `alpha(f)`: frame f's alpha (255: opaque). */
async function webpOf(n: number, w: number, h: number, alpha: (f: number, i: number) => number = () => 255): Promise<Uint8Array> {
  const px = new Uint8Array(w * h * n * 4)
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < w * h; i++) {
      const o = (f * w * h + i) * 4
      px[o] = (f * 37) & 0xFF
      px[o + 1] = (i * 7) & 0xFF
      px[o + 2] = 128
      px[o + 3] = alpha(f, i)
    }
  }
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h * n, channels: 4, pageHeight: h } as never, limitInputPixels: false }).webp({ lossless: true }).toBuffer())
}

/** LoadImage's card run on its own (as cards-bake does): its derived values, and the files it kept. */
async function loaded(prompt: ApiPrompt, files: Record<string, Uint8Array>, families: ReadonlySet<RunnerFamily> = CARDS) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([name, b]) => [`input::${name}`, b]))
  let seq = 0
  const plan = await planNode({ prompt, nodeId: 'l', families, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
  expect(plan.kind).toBe('derive')
  const io = {
    read: async (f: OutputFile) => {
      const b = store.get(keyOf(f))
      if (!b) throw new Error(`no such file ${keyOf(f)}`)
      return b
    },
    // Kept by content, as the run's store keeps them (the same bytes are one file).
    keep: async (bytes: Uint8Array, ext: string) => {
      const same = [...store.entries()].find(([k, b]) => k.startsWith('kept:') && Buffer.compare(Buffer.from(b), Buffer.from(bytes)) === 0)
      if (same) return { filename: same[0].split(':')[2]!, subfolder: '', type: 'kept' as never } as OutputFile
      const f: OutputFile = { filename: `k${seq++}.${ext}`, subfolder: '', type: 'kept' as never }
      store.set(keyOf(f), bytes)
      return f
    },
    signal: new AbortController().signal,
  } as unknown as DeriveIO
  const made = await (plan as { derive: (io: DeriveIO) => Promise<Derived> }).derive(io)
  const filesOf = (slot: number) => (made.values[slot] as Extract<RunnerValue, { kind: 'files' | 'mask' }>).files
  return { made, filesOf, bytes: (f: OutputFile) => store.get(keyOf(f))! }
}

describe('I2: the batch is made only where a reader takes it', () => {
  it('who takes the batch: Save, Shader, Image to mask, Text mask with a render, an effect\'s mask, a local model, a picking Image card; not a paid node, the Frame, Get image size or Face swap', () => {
    const taken = (p: ApiPrompt, f: ReadonlySet<RunnerFamily> = CARDS) => loaderBatchTaken(p, 'l', f)
    expect(taken({ l: load('a.gif'), e: edit(['l', 0]) }, EDIT_CARDS)).toBe(false)
    expect(taken({ l: load('a.gif'), c: { class_type: 'Compositor', inputs: { layer1: ['l', 0], layer1_mask: ['l', 1] } } })).toBe(false)
    expect(taken({ l: load('a.gif'), g: { class_type: 'GetImageSize', inputs: { image: ['l', 0] } } })).toBe(false)
    expect(taken({ l: load('a.gif'), f: { class_type: 'FaceSwap', inputs: { source_face: ['l', 0], target_frames: ['l', 0] } } })).toBe(false)
    expect(taken({ l: load('a.gif'), s: save(['l', 0]) })).toBe(true)
    // Through a Gate and an Image card with no pick; an Image card picking frame 0 needs no batch, past it does.
    expect(taken({ l: load('a.gif'), g: { class_type: GATE_CLASS, inputs: { data_in: ['l', 0], bypass: true } }, i: card(['g', 0], -1), s: save(['i', 0]) })).toBe(true)
    expect(taken({ l: load('a.gif'), i: card(['l', 0], 0), s: save(['i', 0]) })).toBe(false)
    expect(loaderBatchReaders({ l: load('a.gif'), i: card(['l', 0], 2), e: edit(['i', 0]) }, 'l', EDIT_CARDS)).toEqual([expect.objectContaining({ nodeId: 'i', pick: true })])
    expect(taken({ l: load('a.gif'), m: { class_type: 'ImageToMask', inputs: { image: ['l', 0], channel: 'red' } } })).toBe(true)
    expect(taken({ l: load('a.gif'), t: { class_type: 'TextMask', inputs: { source: ['l', 0], params: '{}' } } })).toBe(false)
    expect(taken({ l: load('a.gif'), x: { class_type: 'MatteGrowShrink', inputs: { mask: ['l', 1], amount: 2, feather: 0 } } }, MASK_FX)).toBe(true)
    expect(taken({ l: load('a.gif'), u: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['l', 0], tile_size: 512 } } }, UPSCALE)).toBe(true)
  })

  it('a paid node reads frame 0 alone: LoadImage decodes one frame; Save image takes every frame', async () => {
    const gif = bigGif(12, 8, 6)
    const first = await loaded({ l: load('a.gif'), e: edit(['l', 0]) }, { 'a.gif': gif }, EDIT_CARDS)
    expect(first.filesOf(0)).toHaveLength(1)
    expect(first.filesOf(1)).toHaveLength(1)
    const all = await loaded({ l: load('a.gif'), s: save(['l', 0]) }, { 'a.gif': gif })
    expect(all.filesOf(0)).toHaveLength(6)
    // The first frame is the same picture either way.
    const px = async (b: Uint8Array) => (await sharp(b).raw().toBuffer()).toString('hex')
    expect(await px(all.bytes(all.filesOf(0)[0]!))).toBe(await px(first.bytes(first.filesOf(0)[0]!)))
  })

  it('hosted: a 601-frame animation read only by a paid node is not refused for the batch caps (only frame 0 is sent); read by Save image it is, before the hold', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => EDIT_CARDS } })
    writeFileSync(join(k.root, 'input', 'long.gif'), bigGif(4, 4, 601))
    const read = async (f: OutputFile) => new Uint8Array(readFileSync(join(k.root, f.type, f.subfolder, f.filename)))
    const paid: ApiPrompt = { l: load('long.gif'), e: edit(['l', 0]) }
    expect((await loaderBatchStartProblems(paid, EDIT_CARDS, { hosted: true, read, saveSize })).problem).toBeNull()
    const saved: ApiPrompt = { l: load('long.gif'), s: save(['l', 0]) }
    expect((await loaderBatchStartProblems(saved, EDIT_CARDS, { hosted: true, read, saveSize })).problem).toMatchObject({ message: LOADER_FRAMES_TOO_MUCH, nodeId: 'l' })
    await expect(k.engine.startRun({ userId: k.userId, takes: [saved], ...START })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(LOADER_FRAMES_TOO_MUCH) })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('every frame is decoded in ONE sharp pass (pages: −1), never a page at a time: a 240-frame WebP', async () => {
    const webp = await webpOf(240, 32, 18)
    const meta = await sharp(webp).metadata()
    const scratch = () => readdirSync(tmpdir()).filter(d => d.startsWith('sailor-frames-')).length
    const before = scratch()
    sharpCalls.length = 0
    const frames: string[] = []
    const n = await decodeFramesOnce(webp, meta, 3, async (px, w, h) => {
      expect([w, h, px.length]).toEqual([32, 18, 32 * 18 * 3])
      frames.push(Buffer.from(px).toString('hex'))
    })
    expect(n).toBe(240)
    expect(frames).toHaveLength(240)
    const opts = sharpCalls.map(o => (o ?? {}) as { page?: number; pages?: number })
    expect(opts.filter(o => o.pages === -1)).toHaveLength(1)
    expect(opts.filter(o => o.page !== undefined)).toHaveLength(0)
    expect(sharpCalls).toHaveLength(1)
    // The frames are libvips' own, in order: as decoding each page on its own gives them.
    for (const k of [0, 1, 119, 239]) {
      const ref = await sharp(webp, { page: k, pages: 1 }).removeAlpha().raw().toBuffer()
      expect(frames[k], `frame ${k}`).toBe(ref.toString('hex'))
    }
    // Its scratch folder is gone once the frames are read.
    expect(scratch()).toBeLessThanOrEqual(before)
  })

  it('Stop between frames: the decode ends, its scratch folder deleted', async () => {
    const webp = await webpOf(6, 8, 4)
    const meta = await sharp(webp).metadata()
    const scratch = () => readdirSync(tmpdir()).filter(d => d.startsWith('sailor-frames-')).length
    const before = scratch()
    const stop = new AbortController()
    let seen = 0
    await expect(decodeFramesOnce(webp, meta, 3, async () => { if (++seen === 2) stop.abort() }, stop.signal)).rejects.toThrow('Stopped')
    expect(seen).toBe(2)
    expect(scratch()).toBeLessThanOrEqual(before)
  })

  it('LoadImage of the 240-frame WebP into Save image decodes it once (its PNGs encoded a frame each)', async () => {
    const webp = await webpOf(240, 16, 9)
    sharpCalls.length = 0
    const all = await loaded({ l: load('a.webp'), s: save(['l', 0]) }, { 'a.webp': webp })
    expect(all.filesOf(0)).toHaveLength(240)
    const decodes = sharpCalls.filter(o => o && typeof o === 'object' && ('pages' in o || 'page' in o)) as { page?: number; pages?: number }[]
    expect(decodes.filter(o => o.pages === -1)).toHaveLength(1)
    expect(decodes.filter(o => o.page !== undefined && o.page > 0)).toHaveLength(0)
  })
})

describe('I1: a reader that takes the batch is checked against its own limits before the hold', () => {
  // 17 frames of 4096 × 4096: 285 million pixels, past the cards' 268 million (each frame within every cap).
  const big = bigGif(4096, 4096, 17)

  it('Save image, Image to mask: refused plainly before the hold, naming the reader; a paid node reading frame 0 is not', async () => {
    // Image to mask's mask shown through an effect on a small still (an output reads it).
    const shown: ApiPrompt = {
      e: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
      a: { class_type: 'ApplyMask', inputs: { image: ['e', 0], mask: ['r', 0], invert: false } }, s: save(['a', 0]),
    }
    for (const [reader, rest] of [[save(['l', 0]), {}], [{ class_type: 'ImageToMask', inputs: { image: ['l', 0], channel: 'red' } }, shown]] as const) {
      const k = makeKit({ deps: { families: () => new Set([...EDIT_CARDS, ...MASK_FX]) } })
      writeFileSync(join(k.root, 'input', 'big.gif'), big)
      const p: ApiPrompt = { l: load('big.gif'), r: reader, ...rest }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), reader.class_type)
        // Named: the reader's title, then the words.
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(new RegExp(`^“[^”]+”: ${LOADER_BATCH_TOO_LARGE.replace(/[.()]/g, '\\$&')}$`)) })
      expect(k.ledger.hold).not.toHaveBeenCalled()
    }
    const read = async () => big
    expect((await loaderBatchStartProblems({ l: load('big.gif'), e: edit(['l', 0]) }, EDIT_CARDS, { hosted: false, read, saveSize })).problem).toBeNull()
  })

  it('the limits from the header: frames × size; Save image\'s after its scale; an effect\'s masks and outputs', async () => {
    const pictureOf = async () => null
    const o = { saveSize, pictureOf }
    const r = (classType: string, input: string, carries: 'picture' | 'mask' = 'picture') => ({ nodeId: 'r', classType, input, carries })
    const at = (count: number, w: number, h: number, alpha = false) => ({ count, w, h, alpha })
    // The 1080p case the review measured: 130 frames, 269.6 million pixels.
    const p: ApiPrompt = { l: load('a.webp'), r: save(['l', 0]) }
    expect(await loaderBatchReaderRefusal(p, r('SaveImage', 'images'), at(130, 1920, 1080), o)).toBe(LOADER_BATCH_TOO_LARGE)
    expect(await loaderBatchReaderRefusal(p, r('SaveImage', 'images'), at(129, 1920, 1080), o)).toBeNull()
    // Within the cards' limit unscaled, past it at scale 2 (save_images' size).
    const scaled: ApiPrompt = { l: load('a.webp'), r: save(['l', 0], { scale: 2 }) }
    expect(await loaderBatchReaderRefusal(scaled, r('SaveImage', 'images'), at(40, 1920, 1080), o)).toBe(LOADER_BATCH_TOO_LARGE)
    expect(await loaderBatchReaderRefusal(scaled, r('SaveImage', 'images'), at(32, 1920, 1080), o)).toBeNull()
    // A wired scale can't be known before the run: only the unscaled frames are checked.
    const wired: ApiPrompt = { l: load('a.webp'), n: { class_type: 'PrimitiveFloat', inputs: { value: 4 } }, r: save(['l', 0], { scale: ['n', 0] }) }
    expect(await loaderBatchReaderRefusal(wired, r('SaveImage', 'images'), at(40, 1920, 1080), o)).toBeNull()
    expect(await loaderBatchReaderRefusal(p, r('PreviewImage', 'images'), at(130, 1920, 1080), o)).toBe(LOADER_BATCH_TOO_LARGE)
    expect(await loaderBatchReaderRefusal(p, r('TextMask', 'source'), at(130, 1920, 1080), o)).toBe(LOADER_BATCH_TOO_LARGE)
    // An effect on the masks: a see-through animation's masks are one a frame at its size; an opaque one's a
    // single 64 × 64 mask in, and an output a frame at that size.
    const fx: ApiPrompt = { l: load('a.webp'), r: { class_type: 'MatteGrowShrink', inputs: { mask: ['l', 1], amount: 2, feather: 0 } } }
    expect(await loaderBatchReaderRefusal(fx, r('MatteGrowShrink', 'mask', 'mask'), at(130, 1920, 1080, true), o)).toBe(LOADER_BATCH_TOO_LARGE)
    expect(await loaderBatchReaderRefusal(fx, r('MatteGrowShrink', 'mask', 'mask'), at(130, 1920, 1080, false), o)).toBeNull()
    // ApplyMask's outputs at its picture's size, when it is known exactly.
    const apply: ApiPrompt = { l: load('a.webp'), i: load('still.png'), r: { class_type: 'ApplyMask', inputs: { image: ['i', 0], mask: ['l', 1], invert: false } } }
    const known = { saveSize, pictureOf: async () => ({ px: 4096 * 4096, exact: true }) }
    expect(await loaderBatchReaderRefusal(apply, r('ApplyMask', 'mask', 'mask'), at(17, 64, 64), known)).toBe(LOADER_BATCH_TOO_LARGE)
    expect(await loaderBatchReaderRefusal(apply, r('ApplyMask', 'mask', 'mask'), at(15, 64, 64), known)).toBeNull()
    expect(17 * 4096 * 4096).toBeGreaterThan(CARD_MAX_PIXELS)
  })
})

describe('I3, M2: the run\'s kept room counts what the frames keep, and what each local-model call keeps', () => {
  it('hosted: a 250-frame 1080p animation into Upscale (2×) is refused before the hold, never partway', async () => {
    const replicate = createFakeReplicate()
    const k = makeKit({ hosted: true, replicate, deps: { families: () => UPSCALE } })
    writeFileSync(join(k.root, 'input', 'long.gif'), bigGif(1920, 1080, 250))
    const p: ApiPrompt = { l: load('long.gif'), u: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['l', 0], tile_size: 512 } }, s: save(['u', 0]) }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(LOCAL_MODEL_WORDS.overCap) })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
    // Its count and what it keeps, a true upper bound: every 2× answer kept for the run.
    const read = async () => bigGif(1920, 1080, 250)
    const counted = await localModelStartProblems(p, UPSCALE, { hosted: true, shapes: async () => new Map(), read })
    expect(counted.counts).toEqual({ u: 250 })
    expect(counted.keptBytes).toBeGreaterThanOrEqual(250 * 4 * 1920 * 1080 * 3)
    expect(counted.keptBytes).toBe(250 * pictureCallKeptBound(UPSCALE_2X_CLASS, 1920 * 1080))
    expect(counted.keptByNode?.u).toBe(counted.keptBytes)
    // The loader's own frames, counted with it.
    const frames = await loaderBatchStartProblems(p, UPSCALE, { hosted: true, read, saveSize })
    expect(frames.keptBytes).toBe(loaderBatchKeptBytes({ count: 250, w: 1920, h: 1080, alpha: false }, false))
    expect(frames.keptBytes + counted.keptBytes).toBeGreaterThan(MEDIA_CAPS.hosted.keptBytesPerRun)
  })

  it('a short small animation into Upscale (2×) is held for every frame and runs within the room', async () => {
    const read = async () => bigGif(64, 36, 20)
    const p: ApiPrompt = { l: load('a.gif'), u: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['l', 0], tile_size: 512 } } }
    const counted = await localModelStartProblems(p, UPSCALE, { hosted: true, shapes: async () => new Map(), read })
    expect(counted).toMatchObject({ problem: null, counts: { u: 20 } })
    expect(counted.keptBytes).toBe(20 * pictureCallKeptBound(UPSCALE_2X_CLASS, 64 * 36))
  })

  it('M2: a mask read as a float (a Frame, an effect) keeps its tensor too, counted', async () => {
    const webp = await webpOf(3, 8, 4, (f, i) => (f === 1 && i < 4 ? 0 : 255))
    const read = async () => webp
    const plain: ApiPrompt = { l: load('a.webp'), s: save(['l', 0]) }
    const float: ApiPrompt = { ...plain, x: { class_type: 'MatteGrowShrink', inputs: { mask: ['l', 1], amount: 2, feather: 0 } } }
    const a = await loaderBatchStartProblems(plain, MASK_FX, { hosted: true, read, saveSize })
    const b = await loaderBatchStartProblems(float, MASK_FX, { hosted: true, read, saveSize })
    expect(a.keptBytes).toBe(loaderBatchKeptBytes({ count: 3, w: 8, h: 4, alpha: true }, false))
    expect(b.keptBytes).toBe(loaderBatchKeptBytes({ count: 3, w: 8, h: 4, alpha: true }, true))
    expect(b.keptBytes - a.keptBytes).toBeGreaterThanOrEqual(3 * 4 * 8 * 4)
    // What the card keeps fits the count: three tensors of 8 × 4 floats beside the masks.
    const got = await loaded(float, { 'a.webp': webp }, MASK_FX)
    const mask = got.made.values[1] as Extract<RunnerValue, { kind: 'mask' }>
    expect(mask.tensors).toHaveLength(3)
    for (const t of mask.tensors!) expect(got.bytes(t).length).toBeLessThanOrEqual(4 * 8 * 4 + 64 * 1024)
  })
})

describe('M1: Pillow\'s mode for the whole file decides every frame\'s mask', () => {
  it('an animated WebP with alpha: every frame\'s mask is 1 − alpha at its size, zeros on an opaque frame', async () => {
    // Frame 0 opaque, frame 1 half see-through, frame 2 opaque.
    const webp = await webpOf(3, 8, 4, (f, i) => (f === 1 && i < 16 ? 0 : 255))
    const got = await loaded({ l: load('a.webp'), s: save(['l', 0]) }, { 'a.webp': webp })
    const masks = await Promise.all(got.filesOf(1).map(f => decodeMask(got.bytes(f))))
    expect(masks.map(m => [m.w, m.h])).toEqual([[8, 4], [8, 4], [8, 4]])
    expect([...masks[0]!.data].every(v => v === 0)).toBe(true)
    expect(masks[1]!.data[0]).toBe(1)
    expect(masks[1]!.data[31]).toBe(0)
    expect([...masks[2]!.data].every(v => v === 0)).toBe(true)
  })

  it('an opaque GIF (Pillow: RGB on every frame): 64 × 64 zeros each, kept once', async () => {
    const got = await loaded({ l: load('a.gif'), s: save(['l', 0]) }, { 'a.gif': bigGif(10, 6, 4) })
    const masks = got.filesOf(1)
    expect(masks).toHaveLength(4)
    expect(new Set(masks.map(f => f.filename)).size).toBe(1)
    const m = await decodeMask(got.bytes(masks[0]!))
    expect([m.w, m.h]).toEqual([64, 64])
  })
})

describe('M3: an abandon before the folder exists still leaves its tombstone', () => {
  it('the B2 repro: the abandon lands before the first frame\'s upload made the folder', async () => {
    const input = mkdtempSync(join(tmpdir(), 'r119c-m3-'))
    const folder = `shader_bake/${'ab'.repeat(16)}`
    expect(existsSync(join(input, folder))).toBe(false)
    expect(await abandonShaderBake(input, folder, async () => true)).toBe(false)
    expect(await bakeFolderAbandoned(input, folder)).toBe(true)
    // A name that isn't a bake folder writes nothing.
    expect(await abandonShaderBake(input, 'shader_bake/../../etc', async () => true)).toBe(false)
    expect(await abandonShaderBake(input, `shader_bake/${'zz'.repeat(16)}`, async () => true)).toBe(false)
    expect(await bakeFolderAbandoned(input, `shader_bake/${'zz'.repeat(16)}`)).toBe(false)
  })
})

describe('M4: an APNG\'s words, Get image size\'s batch, Image to mask takes the batch', () => {
  it('Get image size: a LoadImage\'s animation is a batch of its frames (from the header), though only frame 0 is decoded', async () => {
    const gif = bigGif(10, 6, 5)
    const prompt: ApiPrompt = { l: load('a.gif'), g: { class_type: 'GetImageSize', inputs: { image: ['l', 0] } } }
    const first = await loaded(prompt, { 'a.gif': gif })
    expect(first.filesOf(0)).toHaveLength(1)
    const store = new Map<string, Uint8Array>([['input::a.gif', gif], [keyOf(first.filesOf(0)[0]!), first.bytes(first.filesOf(0)[0]!)]])
    const sized = async (p: ApiPrompt, files: OutputFile[]) => {
      const plan = await planNode({ prompt: p, nodeId: 'g', families: CARDS, gateOpen: false, filesFrom: () => files, toUrl: async () => '' })
      const io = { read: async (f: OutputFile) => store.get(keyOf(f))!, signal: new AbortController().signal } as unknown as DeriveIO
      const made = await (plan as { derive: (io: DeriveIO) => Promise<Derived> }).derive(io)
      return [0, 1, 2].map(s => (made.values[s] as { value: number }).value)
    }
    expect(await sized(prompt, first.filesOf(0))).toEqual([10, 6, 5])
    // An Image card picking one picture hands on one.
    const picked: ApiPrompt = { ...prompt, i: card(['l', 0], 0), g: { class_type: 'GetImageSize', inputs: { image: ['i', 0] } } }
    expect(await sized(picked, first.filesOf(0))).toEqual([10, 6, 1])
  })

  it('a LoadImage APNG: Save image, Preview image, Image to mask and Text mask are refused in the one set of words', () => {
    for (const reader of [
      save(['l', 0]),
      { class_type: 'PreviewImage', inputs: { images: ['l', 0] } },
      { class_type: 'ImageToMask', inputs: { image: ['l', 0], channel: 'red' } },
    ]) {
      const files = cardPictureFiles({ l: load('a.png'), r: reader }, CARDS)
      expect(files, reader.class_type).toContainEqual(expect.objectContaining({ classType: 'LoadImage', oneFrame: true, loaderBatch: true, animated: LOADER_APNG_WORDS }))
    }
    expect(LOADER_APNG_WORDS).toMatch(/Save it as a GIF or WebP/)
  })
})
