/**
 * The start of a run for R7's picture nodes (ruling (f): a clip runs in
 * Sailor, one call per frame, with a frame cap and the hold at frames ×
 * price). Before anything is held, each taken node's pictures are counted —
 * a TRUE upper bound (rule 6), never a guess:
 *   - a frame batch: R6's start pass (./video/shapes.ts frameShapes, the
 *     packets counted), the clip's own count;
 *   - a picture: what its source can hand on, followed back through Gates
 *     and Image cards: one for a loader, an Image card, a Frame, a provider's
 *     picture (each paid picture class takes its first answer); Empty
 *     image's batch; an effect, the most of what it reads.
 * The count is recorded on the take (TakeRecord.measured's `frames`), so the
 * hold and the charge are priced on it, and the node's turn refuses more
 * than it (../generators/localModels.ts). A count that can't be known, or
 * one over the cap (LOCAL_MODEL_MAX_FRAMES), leaves the whole workflow to
 * the engine (RUNNER_NOT_ELIGIBLE), never a refusal: switching a family on
 * never makes a working graph fail. Both are stop-gaps while ComfyUI exists
 * (R7.1's report says how each closes).
 *
 * R7.2: a class whose service states a largest picture (LOCAL_MODEL_MAX_PIXELS,
 * Upscale (2×)'s Real-ESRGAN) is sized here too, as a true upper bound: a
 * clip by its frame shape, a picture by the hosted gate's own walk
 * (../utils/graphInputPixels.ts linkPictureBound: a loaded file's header, an
 * Image card, Empty image, the Frame, a generator's stated largest…). One
 * larger, or one whose size can't be known, leaves the workflow to the engine
 * the same way (a stop-gap named in R7.2's report). R11.6 (ruling (i)): a
 * picture over Real-ESRGAN's largest is cut into tiles, up to
 * UPSCALE_2X_TILED_MAX_PIXELS: the most tiles any of its pictures makes is
 * worked out here (`tiles`, shared/runner/upscaleTiles.ts: from a clip's
 * frame shape, the pictures' exact shapes, else the pixel bound alone — a
 * true upper bound whatever the shape), and its 2× pictures are counted in
 * the kept room.
 *
 * R7.6: Slow motion (AI) sends its whole clip in one RIFE call (not a call
 * per frame): its clip's count T and size (R6's frame shapes) are recorded
 * for the hold (`counts`, `sizes`). A clip over SLOW_MOTION_AI_MAX_FRAMES,
 * an output past R5's batch caps, or, for a multiplier RIFE doesn't make or
 * a clip too small to encode (Sailor's own interpolation), a frame past
 * R6.6's own limits leaves the
 * workflow to the engine the same way (stop-gaps named in R7.6's report).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS } from '#shared/runner/media'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, PAID_PICTURE_SLOTS, outputKindsFor } from '#shared/runner/eligibility'
import { EFFECT_PICTURE_OUTPUTS, effectFamilyOn, effectSchemaOf } from '#shared/runner/effects'
import { outputKind } from '#shared/runner/values'
import { pyIntOf } from '#shared/runner/pyText'
import {
  BG_REMOVE_CLASS, FRAME_INTERP_AI_CLASS, SLOW_MOTION_AI_MAX_FRAMES, SLOW_MOTION_AI_WORDS, rifeTakes, slowMotionAiCount, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_MAX_PIXELS, LOCAL_MODEL_OUTPUT_KINDS, LOCAL_MODEL_PICTURE_INPUT, LOCAL_MODEL_WORDS, OBJECT_REMOVE_CLASS,
  OBJECT_REMOVE_WORDS, SAM_MASK_CLASSES, SUBJECT_MASK_CLASS, UPSCALE_2X_CLASS, UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_WORDS, localModelMaskSlot, localModelOn, localModelPictureSlot, overCapWords,
} from '#shared/runner/localModels'
import { tileCount, tileCountBound, tooThinToTile } from '#shared/runner/upscaleTiles'
import { linkPictureBound, linkPictureShapes, pictureSize, type Shape } from '../utils/graphInputPixels'
import { pictureMeta } from './pictures/pythonView'
import { hasAlphaAsPil } from './pictures/mask'
import type { FrameShape } from './video/table'
import { keptBatchBound, keptPeak } from './video/start'
import { batchSlotOf } from './video/shapes'
import { VIDEO_EFFECTS } from './video/table'
import { parseInputFileRef } from './inputs'
import type { OutputFile } from './types'
import type { SoundShape } from './video/table'
import { MUSIC_MAX_SECONDS, MUSIC_MIN_SECONDS } from '#shared/runner/audioGen'

/** Sources that hand on one picture (a provider's first answer, a loader's first frame, a render). */
const ONE_PICTURE: ReadonlySet<string> = new Set(['LoadImage', 'Compositor', 'Scene3DStudio', 'TextOnPath', 'TextMask', 'ShaderEffect'])
/** Masks that are one: LoadImage's, the bake cards'. */
const ONE_MASK: ReadonlySet<string> = new Set(['LoadImage', 'TextOnPath', 'TextMask'])

function intOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyIntOf(v)
  return null
}

/** The most masks a mask wire can bring, or null when that can't be known. */
function maskBound(prompt: ApiPrompt, link: ApiLink, families: ReadonlySet<RunnerFamily>, depth: number): number | null {
  const from = prompt[link[0]]
  if (!from || depth > 64) return null
  const inputs = from.inputs ?? {}
  if (from.class_type === GATE_CLASS) return isLink(inputs.data_in) ? maskBound(prompt, inputs.data_in, families, depth + 1) : null
  if (ONE_MASK.has(from.class_type)) return 1
  // R7.4: Mask by text and Mask extractor hand on one mask ([1, H, W]), while their family is on.
  if (SAM_MASK_CLASSES.has(from.class_type) && link[1] === 0 && localModelOn(from.class_type, families)) return 1
  if (from.class_type === 'ImageToMask') return isLink(inputs.image) ? pictureBound(prompt, inputs.image, families, depth + 1) : null
  // A picture class's mask (Background remove's slot 1, R7.5 Subject mask's slot 0): one per picture.
  if (localModelOn(from.class_type, families) && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, from.class_type) && link[1] === localModelMaskSlot(from.class_type)) {
    const name = LOCAL_MODEL_PICTURE_INPUT[from.class_type]!
    return isLink(inputs[name]) ? pictureBound(prompt, inputs[name], families, depth + 1) : null
  }
  if (effectSchemaOf(from.class_type) && effectFamilyOn(from.class_type, families)) return effectBound(prompt, from.class_type, inputs, families, depth)
  return null
}

/** An effect's batch: the most any of its wired pictures and masks brings (one with none wired). */
function effectBound(prompt: ApiPrompt, cls: string, inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>, depth: number): number | null {
  const schema = effectSchemaOf(cls)!
  let most = 1
  for (const i of schema.images) {
    const v = inputs[i.name]
    if (!isLink(v)) continue
    const n = pictureBound(prompt, v, families, depth + 1)
    if (n === null) return null
    most = Math.max(most, n)
  }
  for (const m of schema.masks) {
    const v = inputs[m.name]
    if (!isLink(v)) continue
    const n = maskBound(prompt, v, families, depth + 1)
    if (n === null) return null
    most = Math.max(most, n)
  }
  return most
}

/**
 * The most pictures a picture wire can bring (an upper bound), or null when
 * that can't be known before the run.
 */
export function pictureBound(prompt: ApiPrompt, link: ApiLink, families: ReadonlySet<RunnerFamily>, depth = 0): number | null {
  const from = prompt[link[0]]
  if (!from || depth > 64) return null
  const inputs = from.inputs ?? {}
  const cls = from.class_type
  if (cls === GATE_CLASS) return link[1] === 0 && isLink(inputs.data_in) ? pictureBound(prompt, inputs.data_in, families, depth + 1) : null
  if (cls === 'Image') return isLink(inputs.images) ? pictureBound(prompt, inputs.images, families, depth + 1) : link[1] === 0 ? 1 : null
  if (cls === 'EmptyImage') {
    const n = intOf(inputs.batch_size ?? 1)
    return n !== null && n >= 1 ? n : null
  }
  if (localModelOn(cls, families)) {
    const name = LOCAL_MODEL_PICTURE_INPUT[cls]!
    // Its picture's slot (R7.5: Subject mask's cutout is slot 1).
    return link[1] === localModelPictureSlot(cls) && isLink(inputs[name]) ? pictureBound(prompt, inputs[name], families, depth + 1) : null
  }
  if (Object.prototype.hasOwnProperty.call(EFFECT_PICTURE_OUTPUTS, cls)) {
    return EFFECT_PICTURE_OUTPUTS[cls]!.includes(link[1]) && effectFamilyOn(cls, families) ? effectBound(prompt, cls, inputs, families, depth) : null
  }
  if (ONE_PICTURE.has(cls)) return 1
  if (Object.prototype.hasOwnProperty.call(PAID_PICTURE_FAMILY, cls)) {
    const slots = Object.prototype.hasOwnProperty.call(PAID_PICTURE_SLOTS, cls) ? PAID_PICTURE_SLOTS[cls]! : [0]
    return slots.includes(link[1]) ? 1 : null
  }
  if (IMAGE_OUTPUT_CLASSES.has(cls) && link[1] === 0) return 1
  return null
}

export interface LocalModelStart {
  /** Node id → the pictures it works through (at most), for the hold. */
  counts: Record<string, number>
  /** R7.6: node id → the clip's frame size and where it runs, for the hold (Slow motion (AI) is priced by its frames' size; locally RIFE takes 4K at most). */
  sizes?: Record<string, { w: number; h: number; place: 'hosted' | 'local' }>
  /** R7.11: node id → the largest picture (pixels) it sends, for a class with a largest picture (Upscale (2×), priced by it). */
  pictures?: Record<string, number>
  /** R11.6: node id → the most tiles any one of its pictures is cut into (Upscale (2×) over its service's largest), for the hold. */
  tiles?: Record<string, number>
  /**
   * The most bytes this take keeps for its frame batches while it runs (R6's peak, every batch kept
   * to the end, a clip's cut-out batch among them), plus each clip's masks (16-bit PNGs, at most
   * raw size and a margin): 0 with no clip. The engine sums the takes against the run's kept room.
   */
  keptBytes: number
  /**
   * R7.8 fix round 1: node id → the most bytes that node itself keeps for the run (a clip's output
   * batch, its masks; Slow motion (AI)'s output batch), for the run's kept room before each leg's
   * hold (engine.ts keptRoomBeforeHold). A single picture keeps nothing sized here, but for R11.6's
   * tiled 2× pictures (Upscale (2×) over its service's largest), counted in `keptBytes` too.
   */
  keptByNode?: Record<string, number>
  /** The first node whose count can't be known or is over the cap: the workflow goes to the engine. */
  problem: { message: string; nodeId: string; classType: string } | null
  /**
   * R7.3 (fix round 1): a node Python itself would fail on, known before the hold (Object removal's
   * mask of another size than its picture): refused plainly, nothing held or charged.
   */
  refused?: { message: string; nodeId: string; classType: string }
}

type ShapeOf = (link: ApiLink) => Promise<readonly Shape[] | null>

/**
 * Every size the mask on `link` may have, 'empty' when it is certainly all
 * black (LoadImage's file with no alpha: its 64 × 64 zero mask, which Python's
 * Object removal hands on unchanged whatever its size), or null when that
 * can't be known before the run. Sized: LoadImage's mask (its file's, when it
 * has an alpha), Image to mask (its picture's), Background remove's mask (its
 * own picture's: the cut-out is fitted to it), Mask by text's and Mask
 * extractor's (R7.4: their first picture's; SAM 3's answer is fitted to it),
 * Subject mask's (R7.5: its pictures'), through Gates. Any other maker
 * is checked at the node's turn (generators/localModels.ts, the backstop).
 */
async function maskShapes(prompt: ApiPrompt, link: ApiLink, families: ReadonlySet<RunnerFamily>, shapeOf: ShapeOf, read: ((f: OutputFile) => Promise<Uint8Array>) | undefined, depth = 0): Promise<readonly Shape[] | 'empty' | null> {
  const from = prompt[link[0]]
  if (!from || depth > 64) return null
  const inputs = from.inputs ?? {}
  if (from.class_type === GATE_CLASS) return isLink(inputs.data_in) ? maskShapes(prompt, inputs.data_in, families, shapeOf, read, depth + 1) : null
  if (from.class_type === 'LoadImage' && link[1] === 1) {
    const f = read ? parseInputFileRef(inputs.image) : null
    if (!f || !read) return null
    let bytes: Uint8Array
    try { bytes = await read(f) }
    catch { return null }
    const meta = await pictureMeta(bytes).catch(() => null)
    if (!meta) return null
    if (!hasAlphaAsPil(bytes, meta.hasAlpha, meta.format)) return 'empty'
    return shapeOf([link[0], 0])
  }
  if (from.class_type === 'ImageToMask' && link[1] === 0) return isLink(inputs.image) ? shapeOf(inputs.image) : null
  if (from.class_type === BG_REMOVE_CLASS && link[1] === 1 && localModelOn(BG_REMOVE_CLASS, families)) return isLink(inputs.frames) ? shapeOf(inputs.frames) : null
  // R7.5: Subject mask's masks are its pictures' size (SAM 3's answer is fitted to each).
  if (from.class_type === SUBJECT_MASK_CLASS && link[1] === 0 && localModelOn(SUBJECT_MASK_CLASS, families)) return isLink(inputs.frames) ? shapeOf(inputs.frames) : null
  // R7.4: the mask is the first picture's size (a picture list's sizes are all among its shapes).
  if (SAM_MASK_CLASSES.has(from.class_type) && link[1] === 0 && localModelOn(from.class_type, families)) return isLink(inputs.image) ? shapeOf(inputs.image) : null
  return null
}

/** A clip's masks kept as 16-bit greyscale PNGs: at most their raw size, a filter byte a row, and a margin each. */
export function maskBytesBound(s: FrameShape): number {
  return s.count * (2 * s.w * s.h + s.h + 64 * 1024)
}

/** Whether a class hands on a mask per picture (a mask slot in LOCAL_MODEL_OUTPUT_KINDS). */
function keepsMasks(classType: string): boolean {
  const row = Object.prototype.hasOwnProperty.call(LOCAL_MODEL_OUTPUT_KINDS, classType) ? LOCAL_MODEL_OUTPUT_KINDS[classType]! : {}
  return Object.values(row).includes('mask')
}

/** A gate file reader over the run's store: a file value as the runner names it (LoadImage, an Image card) → its header's size. */
function readerOf(read: ((f: OutputFile) => Promise<Uint8Array>) | undefined) {
  return async (value: string) => {
    const f = read ? parseInputFileRef(value) : null
    return f && read ? pictureSize(await read(f)) : null
  }
}

/** Whether the prompt has an R7 picture node the runner takes with these families on. */
export function hasLocalModelPicture(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): boolean {
  return Object.values(prompt).some(n => localModelOn(n.class_type, families)
    && (Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, n.class_type) || n.class_type === FRAME_INTERP_AI_CLASS))
}

/**
 * R7.6: Slow motion (AI)'s clip, before the hold: its count and size, or why
 * the workflow goes to the engine. `shape`: its input's frame shape (null
 * when it can't be known).
 */
export function slowMotionAiStart(inputs: Record<string, unknown>, shape: FrameShape | null | undefined, hosted: boolean): { frames: number; w: number; h: number } | { problem: string } {
  if (!shape || !(shape.count >= 0)) return { problem: LOCAL_MODEL_WORDS.unknownCount }
  const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  if (shape.count > (hosted ? SLOW_MOTION_AI_MAX_FRAMES.hosted : SLOW_MOTION_AI_MAX_FRAMES.local)) return { problem: SLOW_MOTION_AI_WORDS.overCap }
  if (shape.w * shape.h > caps.framePixels) return { problem: SLOW_MOTION_AI_WORDS.tooBig }
  const m = inputs.multiplier as number
  const out = slowMotionAiCount(shape.count, m)
  // The batch it hands on, held to R5's batch caps (values.ts keepFrames).
  if (out > caps.batchFrames || out * shape.w * shape.h > caps.batchPixels) return { problem: SLOW_MOTION_AI_WORDS.outTooLong }
  if (shape.count >= 2 && !rifeTakes(m, shape.w, shape.h, hosted ? 'hosted' : 'local')) {
    // Sailor's own interpolation (R6.6's Slow motion): its memory, its largest frame and its work, as R6.6's start pass judges them.
    const spec = VIDEO_EFFECTS.FrameInterpolate!
    const w = { multiplier: m }
    const outShape = { count: out, w: shape.w, h: shape.h, exact: shape.exact }
    if (spec.heldBytes(w, [shape]) > caps.heldFrameBytes || spec.work(w, [shape], outShape) > caps.effectWork) return { problem: SLOW_MOTION_AI_WORDS.tooBig }
    for (const f of spec.limits?.(w, [shape]) ?? []) if (f.value > f.limit) return { problem: SLOW_MOTION_AI_WORDS.tooBig }
  }
  return { frames: shape.count, w: shape.w, h: shape.h }
}

/**
 * Every R7 picture node's count, before the hold. `shapes`: R6's frame
 * shapes for this prompt (asked for only when a node reads a frame batch).
 */
export async function localModelStartProblems(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  o: {
    hosted: boolean; shapes: () => Promise<ReadonlyMap<string, FrameShape>>
    /** A file of the run's store (a loaded picture's header, for LOCAL_MODEL_MAX_PIXELS). Absent: a loaded picture can't be sized. */
    read?: (f: OutputFile) => Promise<Uint8Array>
  },
): Promise<LocalModelStart> {
  const counts: Record<string, number> = {}
  const sizes: Record<string, { w: number; h: number; place: 'hosted' | 'local' }> = {}
  const pictures: Record<string, number> = {}
  const tiles: Record<string, number> = {}
  let tiledKept = 0
  const cap = o.hosted ? LOCAL_MODEL_MAX_FRAMES.hosted : LOCAL_MODEL_MAX_FRAMES.local
  const kinds = outputKindsFor(families)
  let shapes: ReadonlyMap<string, FrameShape> | null = null
  let masks = 0
  const keptByNode: Record<string, number> = {}
  for (const [nodeId, n] of Object.entries(prompt)) {
    // R7.6: Slow motion (AI), its clip's count and size (one call for the whole clip).
    if (n.class_type === FRAME_INTERP_AI_CLASS && localModelOn(n.class_type, families)) {
      const link = n.inputs?.frames
      if (!isLink(link)) continue
      shapes ??= await o.shapes()
      const got = slowMotionAiStart(n.inputs ?? {}, shapes.get(`${link[0]}:${link[1]}`), o.hosted)
      if ('problem' in got) return { counts, keptBytes: 0, problem: { message: got.problem, nodeId, classType: n.class_type } }
      counts[nodeId] = got.frames
      sizes[nodeId] = { w: got.w, h: got.h, place: o.hosted ? 'hosted' : 'local' }
      // Its output batch: (T − 1)·m + 1 frames of the clip's size.
      const out = shapes.get(`${nodeId}:0`) ?? { count: slowMotionAiCount(got.frames, n.inputs?.multiplier as number), w: got.w, h: got.h, exact: false }
      keptByNode[nodeId] = keptBatchBound(out)
      continue
    }
    if (!localModelOn(n.class_type, families) || !Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, n.class_type)) continue
    const link = n.inputs?.[LOCAL_MODEL_PICTURE_INPUT[n.class_type]!]
    if (!isLink(link)) continue
    let count: number | null
    const maxPixels = Object.prototype.hasOwnProperty.call(LOCAL_MODEL_MAX_PIXELS, n.class_type) ? LOCAL_MODEL_MAX_PIXELS[n.class_type]! : null
    let pixels: number | null = null
    // R11.6: the pictures' exact shapes where known (a clip's frame shape; a picture's, by the gate's walk).
    let shapesIn: readonly (readonly [number, number])[] | null = null
    if (outputKind(prompt, link, kinds) === 'frames') {
      shapes ??= await o.shapes()
      const s = shapes.get(`${link[0]}:${link[1]}`)
      count = s?.count ?? null
      // A class with a mask slot (Background remove) keeps a mask per frame too.
      if (s && keepsMasks(n.class_type)) masks += maskBytesBound(s)
      if (s) {
        pixels = s.w * s.h
        shapesIn = [[s.w, s.h]]
      }
      // What it keeps itself: its output batch (R6's shape of it; else its input's, twice each side for
      // Upscale (2×)), and its masks.
      if (s) {
        const scale = n.class_type === UPSCALE_2X_CLASS ? 2 : 1
        const out = shapes.get(`${nodeId}:${batchSlotOf(n.class_type)}`) ?? { ...s, w: s.w * scale, h: s.h * scale }
        keptByNode[nodeId] = keptBatchBound(out) + (keepsMasks(n.class_type) ? maskBytesBound(s) : 0)
      }
    }
    else {
      count = pictureBound(prompt, link, families)
      if (maxPixels) {
        pixels = await linkPictureBound(prompt, link, readerOf(o.read))
        if (pixels !== null && pixels > UPSCALE_2X_MAX_PIXELS) shapesIn = await linkPictureShapes(prompt, link, readerOf(o.read))
      }
    }
    if (count === null || !Number.isFinite(count) || count < 0) {
      return { counts, keptBytes: 0, problem: { message: LOCAL_MODEL_WORDS.unknownCount, nodeId, classType: n.class_type } }
    }
    if (count > cap) return { counts, keptBytes: 0, problem: { message: overCapWords(n.class_type), nodeId, classType: n.class_type } }
    if (maxPixels) {
      if (pixels === null || !Number.isFinite(pixels) || pixels <= 0) return { counts, keptBytes: 0, problem: { message: UPSCALE_2X_WORDS.unknownSize, nodeId, classType: n.class_type } }
      if (pixels > maxPixels) return { counts, keptBytes: 0, problem: { message: UPSCALE_2X_WORDS.tooLarge, nodeId, classType: n.class_type } }
      pictures[nodeId] = pixels
      // R11.6: over the service's largest, in tiles: the most any picture makes (its shapes', else the pixel bound's).
      if (pixels > UPSCALE_2X_MAX_PIXELS) {
        // Fix round 1 (L2): a shape whose tiles would be thinner than the floor is refused plainly, before the hold.
        if (shapesIn?.some(([w, h]) => tooThinToTile(w, h, UPSCALE_2X_MAX_PIXELS))) {
          return { counts, keptBytes: 0, problem: null, refused: { message: UPSCALE_2X_WORDS.tooThin, nodeId, classType: n.class_type } }
        }
        const bound = tileCountBound(pixels, UPSCALE_2X_MAX_PIXELS)
        const byShape = shapesIn?.length ? Math.max(...shapesIn.map(([w, h]) => tileCount(w, h, UPSCALE_2X_MAX_PIXELS))) : bound
        tiles[nodeId] = Math.min(byShape, bound)
        // Its 2× pictures kept for the run (a clip's batch is counted above): each at most its raw RGB PNG.
        if (outputKind(prompt, link, kinds) !== 'frames') {
          const bytes = Math.max(1, count) * tiledPictureBytesBound(pixels)
          tiledKept += bytes
          keptByNode[nodeId] = (keptByNode[nodeId] ?? 0) + bytes
        }
      }
    }
    counts[nodeId] = Math.max(1, count)
    // R7.3 (fix round 1): Object removal's mask must be its picture's size (Python fails in numpy's
    // composite otherwise, after any earlier paid node ran): refused before the hold when certain.
    if (n.class_type === OBJECT_REMOVE_CLASS && isLink(n.inputs?.mask)) {
      const shapeOf: ShapeOf = async (l) => {
        if (outputKind(prompt, l, kinds) === 'frames') {
          shapes ??= await o.shapes()
          const s = shapes.get(`${l[0]}:${l[1]}`)
          return s ? [[s.w, s.h]] : null
        }
        return linkPictureShapes(prompt, l, readerOf(o.read))
      }
      const picture = await shapeOf(link)
      const mask = picture ? await maskShapes(prompt, n.inputs.mask, families, shapeOf, o.read) : null
      if (picture && mask && mask !== 'empty' && !picture.some(([w, h]) => mask.some(([mw, mh]) => mw === w && mh === h))) {
        return { counts, keptBytes: 0, problem: null, refused: { message: OBJECT_REMOVE_WORDS.maskSize, nodeId, classType: n.class_type } }
      }
    }
  }
  if (!shapes) return { counts, sizes, pictures, tiles, keptBytes: tiledKept, keptByNode, problem: null }
  const peak = keptPeak(prompt, families, shapes, { release: false })
  if (!peak) {
    const first = Object.keys(counts)[0]!
    return { counts, keptBytes: 0, problem: { message: LOCAL_MODEL_WORDS.unknownCount, nodeId: first, classType: prompt[first]!.class_type } }
  }
  return { counts, sizes, pictures, tiles, keptBytes: peak.bytes + masks + tiledKept, keptByNode, problem: null }
}

/**
 * R11.6: the most a tiled 2× picture of a picture of at most `pixels` keeps:
 * an 8-bit RGB PNG of 4 × pixels, at most its raw bytes, a filter byte a row
 * (at most a row a pixel), deflate's stored-block overhead and a margin.
 */
export function tiledPictureBytesBound(pixels: number): number {
  const raw = 4 * pixels * 3 + 2 * pixels
  return Math.ceil(raw * 1.001) + 64 * 1024
}

/** Generate music and its twin: the sound is its `duration` setting long (IO.Int 1–30; MusicGen makes that many seconds). */
const MUSIC_CLASSES: ReadonlySet<string> = new Set(['GenerateMusicNode', 'MusicGenRemoteNode'])

/**
 * The resample to 16 kHz adds at most a sample (torchaudio's ceil): a bound
 * taken from an exact length (the empty card, Empty audio) is widened by
 * this so it stays a bound on what Whisper is sent and charged.
 */
export const WHISPER_RESAMPLE_SLACK = 1e-3

/**
 * R7.7 fix round 1: the most seconds of sound a Whisper node may get, before
 * the run, from the sound's maker — a TRUE upper bound, or null where it
 * can't be known:
 *   - R6.9's sound start pass (`shapes`, ./video/soundShapes.ts): Load audio,
 *     Record audio and an Audio card's own file by their header (plus a
 *     second), Get video components' sound, the empty card's second of
 *     silence, and every R6 sound effect's output from its inputs (a trim, a
 *     concat, Empty audio…), followed back to the measured sources;
 *   - Generate music (and its twin), through Gates and Audio cards: its
 *     typed `duration` (a wired one: the most it takes, 30 s), plus a second;
 *   - anything else (Generate speech, Clone a singing voice): null — held at
 *     the place's longest sound, with the node's turn as the backstop (named
 *     in R7.7's report).
 */
export function whisperSoundBound(prompt: ApiPrompt, link: ApiLink, shapes: ReadonlyMap<string, SoundShape>): number | null {
  return soundBoundOf(prompt, link, shapes)?.seconds ?? null
}

/**
 * whisperSoundBound's bound, and whether it is exact (R7.8): `exact` only
 * where every source in the chain is known to the sample (the empty card,
 * Empty audio and the effects over them); a header source (a loaded file, a
 * video's sound) or a music node's duration carries a second of slack, so a
 * caller refusing past a cap adds that second only then (R7.7's re-review).
 */
export function soundBoundOf(prompt: ApiPrompt, link: ApiLink, shapes: ReadonlyMap<string, SoundShape>): { seconds: number; exact: boolean } | null {
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const s = shapes.get(`${at[0]}:${at[1]}`)
    if (s && s.rate > 0) return { seconds: s.samples / s.rate + WHISPER_RESAMPLE_SLACK, exact: s.exact }
    const n = prompt[at[0]]
    if (!n) return null
    const inputs = n.inputs ?? {}
    if (n.class_type === GATE_CLASS && at[1] === 0 && isLink(inputs.data_in)) { at = inputs.data_in; continue }
    if (n.class_type === 'Audio' && at[1] === 0 && isLink(inputs.source)) { at = inputs.source; continue }
    if (MUSIC_CLASSES.has(n.class_type) && at[1] === 0) {
      const d = inputs.duration
      const typed = typeof d === 'number' && Number.isFinite(d) ? Math.min(Math.max(Math.trunc(d), MUSIC_MIN_SECONDS), MUSIC_MAX_SECONDS) : MUSIC_MAX_SECONDS
      return { seconds: typed + 1, exact: false }
    }
    return null
  }
  return null
}
