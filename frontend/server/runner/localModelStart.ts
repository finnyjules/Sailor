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
 * than it (../generators/localModels.ts). R11.7 (ruling (j)): a count over
 * the cap (LOCAL_MODEL_MAX_FRAMES, kept at 300 hosted and 900 locally until a
 * Fly measurement) is refused plainly before the hold, the cap in words, when
 * the count is sure (a clip's packets counted). R11.8 (ruling (k)): a count
 * that can't be known, or is only an upper bound over the cap, is held at the
 * cap, never left to the engine: the node's turn refuses a clip past it, the
 * cap in words, before anything is sent.
 *
 * R7.2: a class whose service states a largest picture (LOCAL_MODEL_MAX_PIXELS,
 * Upscale (2×)'s Real-ESRGAN) is sized here too, as a true upper bound: a
 * clip by its frame shape, a picture by the hosted gate's own walk
 * (../utils/graphInputPixels.ts linkPictureBound: a loaded file's header, an
 * Image card, Empty image, the Frame, a generator's stated largest, R11.8's
 * effects and cards…). One whose size can't be known, or is only bounded
 * above the largest tiled, is held at UPSCALE_2X_TILED_MAX_PIXELS (R11.8,
 * ruling (k)); one known exactly to be larger is still refused (hosted) or
 * left to the engine (locally, R11.9's plain words). R11.6 (ruling (i)): a
 * picture over Real-ESRGAN's largest is cut into tiles, up to
 * UPSCALE_2X_TILED_MAX_PIXELS: the most tiles any of its pictures makes is
 * worked out here (`tiles`, shared/runner/upscaleTiles.ts: from a clip's
 * frame shape, the pictures' exact shapes, else the pixel bound alone — a
 * true upper bound whatever the shape), and its 2× pictures are counted in
 * the kept room.
 *
 * R7.6: Slow motion (AI) sends its clip to RIFE (not a call per frame): its
 * clip's count T and size (R6's frame shapes) are recorded for the hold
 * (`counts`, `sizes`). R11.7: a clip over 240 frames goes in segments
 * (#shared/runner/clipSegments), the hold priced on them; a clip over
 * SLOW_MOTION_AI_MAX_FRAMES, an output past R5's batch caps, a frame past the
 * largest it takes there, or (Sailor's own interpolation) one past R6.6's
 * limits is refused plainly before the hold (slowMotionAiStart). A still
 * picture is handed on (count 1, nothing held). R11.8: a clip that can't be
 * sized, or whose count is only an upper bound, is held at the cap (its frame
 * cap, RIFE's largest frame there), and its turn refuses past the caps.
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS } from '#shared/runner/media'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, PAID_PICTURE_SLOTS, outputKindsFor } from '#shared/runner/eligibility'
import { EFFECT_PICTURE_OUTPUTS, effectFamilyOn, effectSchemaOf } from '#shared/runner/effects'
import { outputKind } from '#shared/runner/values'
import { pyIntOf } from '#shared/runner/pyText'
import {
  BG_REMOVE_CLASS, FRAME_INTERP_AI_CLASS, RIFE_LOCAL_MAX, SLOW_MOTION_AI_MAX_FRAMES, SLOW_MOTION_AI_PAST_4K_WORDS, SLOW_MOTION_AI_WORDS, SLOW_MOTION_OWN_MAX_FRAMES, fitsRifeLocal, rifeTakes, slowMotionAiCount, slowMotionAiOutWords, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_MAX_PIXELS, LOCAL_MODEL_OUTPUT_KINDS, LOCAL_MODEL_PICTURE_INPUT, LOCAL_MODEL_WORDS, OBJECT_REMOVE_CLASS,
  OBJECT_REMOVE_WORDS, SAM_MASK_CLASSES, SUBJECT_MASK_CLASS, UPSCALE_2X_CLASS, UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_WORDS, localModelMaskSlot, localModelOn, localModelPictureSlot, overCapWords,
} from '#shared/runner/localModels'
import { tileCount, tileCountBound, tooThinToTile } from '#shared/runner/upscaleTiles'
import { linkPictureShapes, linkPictureSize, pictureSize, type Shape } from '../utils/graphInputPixels'
import { pictureFrameCount, pictureHasFrames, pictureMeta } from './pictures/pythonView'
import { hasAlphaAsPil } from './pictures/mask'
import type { FrameShape } from './video/table'
import { keptBatchBoundWithin, keptPeak } from './video/start'
import { batchSlotOf, clipAtCaps } from './video/shapes'
import { VIDEO_EFFECTS } from './video/table'
import { parseInputFileRef } from './inputs'
import { loaderFileBehind } from './cards/bakeReplay'
import type { OutputFile } from './types'
import type { SoundShape } from './video/table'
import { madeSoundShapeOf } from './video/soundShapes'

/** R11.9c fix round 3: LoadImage node id → the frames it hands on (an animated GIF's or WebP's pages), read before the hold. */
export type LoaderFrames = ReadonlyMap<string, number>

/** Each LoadImage's frame count from its file's header (pages; 1 for a still or what can't be read). */
export async function loaderFramesOf(prompt: ApiPrompt, read?: (f: OutputFile) => Promise<Uint8Array>): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!read) return out
  for (const [id, n] of Object.entries(prompt)) {
    if (n.class_type !== 'LoadImage') continue
    const f = parseInputFileRef(n.inputs?.image)
    if (!f) continue
    try {
      // The count the Shader effect's check uses too (pythonView.ts pictureFrameCount): an upper bound of the frames kept.
      const bytes = await read(f)
      const meta = await pictureMeta(bytes)
      out.set(id, pictureHasFrames(meta, bytes) ? pictureFrameCount(meta, bytes) : 1)
    }
    catch { /* unreadable: its turn (and the start's card check) refuse it */ }
  }
  return out
}

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
function maskBound(prompt: ApiPrompt, link: ApiLink, families: ReadonlySet<RunnerFamily>, depth: number, lf?: LoaderFrames): number | null {
  const from = prompt[link[0]]
  if (!from || depth > 64) return null
  const inputs = from.inputs ?? {}
  if (from.class_type === GATE_CLASS) return isLink(inputs.data_in) ? maskBound(prompt, inputs.data_in, families, depth + 1, lf) : null
  // R11.9c fix round 3 (B1): LoadImage's masks, one a frame of its animation.
  if (from.class_type === 'LoadImage') return lf?.get(link[0]) ?? 1
  if (ONE_MASK.has(from.class_type)) return 1
  // R7.4: Mask by text and Mask extractor hand on one mask ([1, H, W]), while their family is on.
  if (SAM_MASK_CLASSES.has(from.class_type) && link[1] === 0 && localModelOn(from.class_type, families)) return 1
  if (from.class_type === 'ImageToMask') return isLink(inputs.image) ? pictureBound(prompt, inputs.image, families, depth + 1, lf) : null
  // A picture class's mask (Background remove's slot 1, R7.5 Subject mask's slot 0): one per picture.
  if (localModelOn(from.class_type, families) && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, from.class_type) && link[1] === localModelMaskSlot(from.class_type)) {
    const name = LOCAL_MODEL_PICTURE_INPUT[from.class_type]!
    return isLink(inputs[name]) ? pictureBound(prompt, inputs[name], families, depth + 1, lf) : null
  }
  if (effectSchemaOf(from.class_type) && effectFamilyOn(from.class_type, families)) return effectBound(prompt, from.class_type, inputs, families, depth, lf)
  return null
}

/** An effect's batch: the most any of its wired pictures and masks brings (one with none wired). */
function effectBound(prompt: ApiPrompt, cls: string, inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>, depth: number, lf?: LoaderFrames): number | null {
  const schema = effectSchemaOf(cls)!
  let most = 1
  for (const i of schema.images) {
    const v = inputs[i.name]
    if (!isLink(v)) continue
    const n = pictureBound(prompt, v, families, depth + 1, lf)
    if (n === null) return null
    most = Math.max(most, n)
  }
  for (const m of schema.masks) {
    const v = inputs[m.name]
    if (!isLink(v)) continue
    const n = maskBound(prompt, v, families, depth + 1, lf)
    if (n === null) return null
    most = Math.max(most, n)
  }
  return most
}

/**
 * The most pictures a picture wire can bring (an upper bound), or null when
 * that can't be known before the run.
 */
export function pictureBound(prompt: ApiPrompt, link: ApiLink, families: ReadonlySet<RunnerFamily>, depth = 0, lf?: LoaderFrames): number | null {
  const from = prompt[link[0]]
  if (!from || depth > 64) return null
  const inputs = from.inputs ?? {}
  const cls = from.class_type
  if (cls === GATE_CLASS) return link[1] === 0 && isLink(inputs.data_in) ? pictureBound(prompt, inputs.data_in, families, depth + 1, lf) : null
  if (cls === 'Image') return isLink(inputs.images) ? pictureBound(prompt, inputs.images, families, depth + 1, lf) : link[1] === 0 ? 1 : null
  if (cls === 'EmptyImage') {
    const n = intOf(inputs.batch_size ?? 1)
    return n !== null && n >= 1 ? n : null
  }
  // R11.7: Slow motion (AI) hands a still picture on as it came (more than one goes to the engine before the run).
  if (cls === FRAME_INTERP_AI_CLASS) return localModelOn(cls, families) && link[1] === 0 && isLink(inputs.frames) ? pictureBound(prompt, inputs.frames, families, depth + 1, lf) : null
  if (localModelOn(cls, families) && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, cls)) {
    const name = LOCAL_MODEL_PICTURE_INPUT[cls]!
    // Its picture's slot (R7.5: Subject mask's cutout is slot 1).
    return link[1] === localModelPictureSlot(cls) && isLink(inputs[name]) ? pictureBound(prompt, inputs[name], families, depth + 1, lf) : null
  }
  if (Object.prototype.hasOwnProperty.call(EFFECT_PICTURE_OUTPUTS, cls)) {
    return EFFECT_PICTURE_OUTPUTS[cls]!.includes(link[1]) && effectFamilyOn(cls, families) ? effectBound(prompt, cls, inputs, families, depth, lf) : null
  }
  // R11.9c fix round 3 (B1): LoadImage hands on every frame of an animated GIF or WebP (cards/loadImage.ts).
  if (cls === 'LoadImage') return link[1] === 0 ? (lf?.get(link[0]) ?? 1) : null
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
  /**
   * R7.6: node id → the clip's frame size and where it runs, for the hold (Slow motion (AI) is priced by its frames'
   * size; locally RIFE takes 4K at most). R11.8: `upTo`, a clip held at the cap, priced at the place's ceiling.
   */
  sizes?: Record<string, { w: number; h: number; place: 'hosted' | 'local'; upTo?: true }>
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
  /** The first node whose count or size can't be known, or several stills into Slow motion (AI): refused plainly (R11.9a, engine.ts). */
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
 * it can't run here. `shape`: its input's frame shape (null when it can't be
 * known: the workflow goes to the engine, a stop-gap R11.8 closes). R11.7
 * (ruling (j)): a clip over the frame cap, a slowed-down batch past R5's batch
 * caps, a frame past the largest it can take there, or (Sailor's own
 * interpolation) past R6.6's limits is refused plainly, before the hold, with
 * the cap in words where there is one; RIFE takes a long clip in segments
 * (#shared/runner/clipSegments), the hold priced on them. A refusal that
 * rests on the count needs the count to be sure (the packets counted, as the
 * run's start pass does, or exact); an upper bound alone proves nothing over
 * a cap, so that clip goes to the engine as before (LC2's rule; R11.8).
 */
export function slowMotionAiStart(inputs: Record<string, unknown>, shape: FrameShape | null | undefined, hosted: boolean): { frames: number; w: number; h: number; upTo?: true } | { problem: string } | { refused: string } {
  const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  // R11.8 (ruling (k)): a clip that can't be sized before the run (or one held at the caps, a paid video's) is held
  // at the cap: the canvas's own ceiling where it runs (`upTo`); its turn refuses past the caps.
  if (!shape || !(shape.count >= 0) || shape.capped) return slowMotionAiAtCap(inputs.multiplier, hosted)
  const m = inputs.multiplier as number
  const rife = shape.count < 2 || rifeTakes(m, shape.w, shape.h, hosted ? 'hosted' : 'local')
  // RIFE's cap (in segments), else Sailor's own interpolation's (hosted unchanged until its memory is measured on Fly).
  const cap = rife ? (hosted ? SLOW_MOTION_AI_MAX_FRAMES.hosted : SLOW_MOTION_AI_MAX_FRAMES.local) : (hosted ? SLOW_MOTION_OWN_MAX_FRAMES.hosted : SLOW_MOTION_OWN_MAX_FRAMES.local)
  const sure = shape.exact || shape.counted === true
  if (shape.w * shape.h > caps.framePixels) return { refused: SLOW_MOTION_AI_WORDS.tooBig }
  // Sailor's own interpolation (R6.6's Slow motion): its memory and its largest frame rest on the frame's size alone.
  // Locally past 4K, where it can't take the clip either: refused plainly, 4K in words (ruling (j)).
  const tooBig = !hosted && !fitsRifeLocal(shape.w, shape.h) && rifeTakes(m, shape.w, shape.h, 'hosted') ? SLOW_MOTION_AI_PAST_4K_WORDS : SLOW_MOTION_AI_WORDS.tooBig
  const spec = VIDEO_EFFECTS.FrameInterpolate!
  const w = { multiplier: m }
  if (!rife) {
    if (spec.heldBytes(w, [shape]) > caps.heldFrameBytes) return { refused: tooBig }
    for (const f of spec.limits?.(w, [shape]) ?? []) if (f.value > f.limit) return { refused: tooBig }
  }
  // R11.8 (M3): a count that is only an upper bound proves nothing over a cap resting on the count. It is held at
  // the cap instead (never above the bound): the node's turn judges the clip itself against these caps, in the same
  // words, before anything is sent (slowMotionAiTurnRefusal).
  if (!sure) return { frames: Math.max(1, Math.min(shape.count, cap, slowMotionAiLongest(m, shape.w * shape.h, caps))), w: shape.w, h: shape.h }
  if (shape.count > cap) return { refused: overCapWords(FRAME_INTERP_AI_CLASS, cap) }
  const out = slowMotionAiCount(shape.count, m)
  // The batch it hands on, held to R5's batch caps (values.ts keepFrames): refused plainly with the most frames that fit.
  if (out > caps.batchFrames || out * shape.w * shape.h > caps.batchPixels) {
    return { refused: slowMotionAiOutWords(Math.max(1, Math.min(caps.batchFrames, Math.floor(caps.batchPixels / Math.max(1, shape.w * shape.h))))) }
  }
  // Sailor's own interpolation's work, as R6.6's start pass judges it.
  if (!rife && spec.work(w, [shape], { count: out, w: shape.w, h: shape.h, exact: shape.exact }) > caps.effectWork) return { refused: tooBig }
  return { frames: shape.count, w: shape.w, h: shape.h }
}

/**
 * R11.8: the start's checks on the clip itself, at Slow motion (AI)'s turn
 * (its count now exact): the words it is refused with, before anything is
 * sent, or null. A clip held at the cap, or on a count that was only an upper
 * bound, is judged here.
 */
export function slowMotionAiTurnRefusal(multiplier: unknown, clip: { count: number; w: number; h: number }, hosted: boolean): string | null {
  const got = slowMotionAiStart({ multiplier }, { ...clip, exact: true }, hosted)
  return 'refused' in got ? got.refused : 'problem' in got ? got.problem : null
}

/**
 * R11.8: the most frames a clip of `pixels` a frame may have at multiplier
 * `m` and still hand on a batch within R5's batch caps ((T − 1)·m + 1 frames
 * of that size), the most a sure clip passes the start with.
 */
export function slowMotionAiLongest(m: number, pixels: number, caps: { batchFrames: number; batchPixels: number }): number {
  const most = Math.min(caps.batchFrames, Math.floor(caps.batchPixels / Math.max(1, pixels)))
  return Number.isInteger(m) && m >= 2 ? Math.floor((most - 1) / m) + 1 : most
}

/**
 * R11.8 (ruling (k)): Slow motion (AI) held at the cap where it runs, for a
 * clip that can't be sized before the run: `upTo`, so its hold is the
 * canvas's own ceiling there (slowMotionAiCalls with `framesUpTo`: the
 * longest clip let through, each call at its most frame-pixels), and the
 * frames and size recorded are the most its turn takes (its frame cap within
 * the batch's frames; the largest frame RIFE is sent there). Its turn refuses
 * a clip past these, before anything is sent.
 */
export function slowMotionAiAtCap(multiplier: unknown, hosted: boolean): { frames: number; w: number; h: number; upTo: true } {
  const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const m = typeof multiplier === 'number' && Number.isInteger(multiplier) ? multiplier : 2
  const frames = Math.min(hosted ? SLOW_MOTION_AI_MAX_FRAMES.hosted : SLOW_MOTION_AI_MAX_FRAMES.local, Math.floor((caps.batchFrames - 1) / Math.max(1, m)) + 1)
  if (hosted) {
    const side = Math.floor(Math.sqrt(caps.framePixels))
    return { frames, w: side, h: side, upTo: true }
  }
  return { frames, w: RIFE_LOCAL_MAX.long, h: RIFE_LOCAL_MAX.short, upTo: true }
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
  const sizes: Record<string, { w: number; h: number; place: 'hosted' | 'local'; upTo?: true }> = {}
  const pictures: Record<string, number> = {}
  const tiles: Record<string, number> = {}
  let tiledKept = 0
  const cap = o.hosted ? LOCAL_MODEL_MAX_FRAMES.hosted : LOCAL_MODEL_MAX_FRAMES.local
  const caps = o.hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const kinds = outputKindsFor(families)
  let shapes: ReadonlyMap<string, FrameShape> | null = null
  let masks = 0
  const keptByNode: Record<string, number> = {}
  // R11.9c fix round 3 (B1): an animated LoadImage's frames, a call each.
  const lf = await loaderFramesOf(prompt, o.read)
  for (const [nodeId, n] of Object.entries(prompt)) {
    // R7.6: Slow motion (AI), its clip's count and size (one call for the whole clip).
    if (n.class_type === FRAME_INTERP_AI_CLASS && localModelOn(n.class_type, families)) {
      const link = n.inputs?.frames
      if (!isLink(link)) continue
      // R11.7: a still picture is handed on as Python does (one frame, no call); a batch of pictures, which
      // Python would slow down, goes to the engine (a stop-gap R11.9 closes with plain words).
      let clip: FrameShape | undefined
      let fromPictures = false
      if (outputKind(prompt, link, kinds) !== 'frames') {
        const pictures = pictureBound(prompt, link, families, 0, lf)
        // R11.9c fix round 4: a LoadImage's animated GIF or WebP (its frames a picture each) is the clip Python
        // interpolates: measured from its header (the frame count every reader uses) and held as any clip.
        const loader = pictures !== null && pictures > 1 ? loaderFileBehind(prompt, link) : null
        let size: { w: number; h: number } | null = null
        if (loader?.classType === 'LoadImage' && o.read) {
          try {
            const meta = await pictureMeta(await o.read(loader.file))
            if (meta.width && meta.height) size = (meta.orientation ?? 1) >= 5 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }
          }
          catch { size = null }
        }
        if (loader?.classType === 'LoadImage' && size) {
          clip = { count: pictures!, w: size.w, h: size.h, exact: true, counted: true }
          fromPictures = true
        }
        else {
          // Fix round 1 (L3): a count that can't be known goes to the engine as before (a batch fails at the turn after
          // earlier paid nodes otherwise); R11.9's plain words close it.
          if (pictures !== 1) return { counts, keptBytes: 0, problem: { message: pictures === null ? LOCAL_MODEL_WORDS.unknownCount : SLOW_MOTION_AI_WORDS.pictureBatch, nodeId, classType: n.class_type } }
          counts[nodeId] = 1
          continue
        }
      }
      if (!clip) {
        shapes ??= await o.shapes()
        clip = shapes.get(`${link[0]}:${link[1]}`)
      }
      const got = slowMotionAiStart(n.inputs ?? {}, clip, o.hosted)
      if ('refused' in got) return { counts, keptBytes: 0, problem: null, refused: { message: got.refused, nodeId, classType: n.class_type } }
      if ('problem' in got) return { counts, keptBytes: 0, problem: { message: got.problem, nodeId, classType: n.class_type } }
      counts[nodeId] = got.frames
      sizes[nodeId] = { w: got.w, h: got.h, place: o.hosted ? 'hosted' : 'local', ...('upTo' in got && got.upTo ? { upTo: true as const } : {}) }
      // Its output batch: (T − 1)·m + 1 frames of the clip's size, at most what R5's batch caps keep (R11.8).
      const out = shapes?.get(`${nodeId}:0`) ?? { count: slowMotionAiCount(got.frames, n.inputs?.multiplier as number), w: got.w, h: got.h, exact: false }
      keptByNode[nodeId] = keptBatchBoundWithin(out, caps)
      // R11.9c fix round 4: a picture batch is kept as a clip first, and its result handed on as pictures again.
      if (fromPictures) keptByNode[nodeId] += keptBatchBoundWithin(clip!, caps) + out.count * (Math.ceil(out.w * out.h * 3 * 1.01) + 64 * 1024)
      continue
    }
    if (!localModelOn(n.class_type, families) || !Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, n.class_type)) continue
    const link = n.inputs?.[LOCAL_MODEL_PICTURE_INPUT[n.class_type]!]
    if (!isLink(link)) continue
    let count: number | null
    // R11.7: whether the count is sure (a picture source's own count; a clip's packets counted), for a plain refusal over the cap.
    let countSure = true
    const maxPixels = Object.prototype.hasOwnProperty.call(LOCAL_MODEL_MAX_PIXELS, n.class_type) ? LOCAL_MODEL_MAX_PIXELS[n.class_type]! : null
    let pixels: number | null = null
    // R11.8: whether `pixels` is the picture's exact size (a clip's frames, a measured file), for a plain refusal over the largest.
    let pixelsSure = false
    // R11.6: the pictures' exact shapes where known (a clip's frame shape; a picture's, by the gate's walk).
    let shapesIn: readonly (readonly [number, number])[] | null = null
    // LC2: a batch this node writes at another size than its clip's (Upscale (2×)), for R5's batch caps below.
    let resized: FrameShape | null = null
    if (outputKind(prompt, link, kinds) === 'frames') {
      shapes ??= await o.shapes()
      // R11.8 (ruling (k)): a clip that can't be sized before the run is held at the place's caps (frameShapes holds
      // a paid video's there too, `capped`): its count and frame size are each only the most the run lets through.
      const s = shapes.get(`${link[0]}:${link[1]}`) ?? clipAtCaps(caps)
      count = s.count
      countSure = !s.capped && (s.exact === true || s.counted === true)
      // A class with a mask slot (Background remove) keeps a mask per frame too: at most one a frame it is let work on.
      const maskShape = { ...s, count: Math.min(s.count, cap) }
      if (keepsMasks(n.class_type)) masks += maskBytesBound(maskShape)
      if (!s.capped) {
        pixels = s.w * s.h
        pixelsSure = true
        shapesIn = [[s.w, s.h]]
      }
      // What it keeps itself: its output batch (R6's shape of it; else its input's, twice each side for
      // Upscale (2×)), within R5's batch caps where it is kept (R11.8), and its masks.
      const scale = n.class_type === UPSCALE_2X_CLASS ? 2 : 1
      const out = shapes.get(`${nodeId}:${batchSlotOf(n.class_type)}`) ?? { ...s, w: s.w * scale, h: s.h * scale }
      keptByNode[nodeId] = keptBatchBoundWithin(out, caps) + (keepsMasks(n.class_type) ? maskBytesBound(maskShape) : 0)
      if (!s.capped && (out.w !== s.w || out.h !== s.h)) resized = out
    }
    else {
      count = pictureBound(prompt, link, families, 0, lf)
      if (maxPixels) {
        const size = await linkPictureSize(prompt, link, readerOf(o.read))
        pixels = size?.px ?? null
        pixelsSure = size?.exact === true
        if (pixels !== null && pixels > UPSCALE_2X_MAX_PIXELS) shapesIn = await linkPictureShapes(prompt, link, readerOf(o.read))
      }
    }
    // R11.8 (ruling (k)): a count that can't be known before the run is held at the cap; the node's turn refuses more.
    if (count === null || !Number.isFinite(count) || count < 0) {
      count = cap
      countSure = false
    }
    // R11.7 (ruling (j)): over the frame cap, refused plainly before the hold, the cap in words (raised only after a Fly
    // measurement). R11.8 (M3): a count that is only an upper bound (its packets not counted) proves nothing over the
    // cap: it is held at the cap, and the node's turn refuses a clip past it, in the same words, before any call.
    if (count > cap) {
      if (countSure) return { counts, keptBytes: 0, problem: null, refused: { message: overCapWords(n.class_type, cap), nodeId, classType: n.class_type } }
      count = cap
    }
    if (maxPixels) {
      // R11.8 (ruling (k)): a size that can't be known, or is only bounded above the largest tiled, is held at the
      // largest tiled (its most tiles); the node's turn refuses a larger picture before any call. One known exactly
      // to be larger is refused (hosted) or left to the engine (locally), as before (R11.9's plain words).
      if (pixels === null || !Number.isFinite(pixels) || pixels <= 0 || (!pixelsSure && pixels > maxPixels)) {
        pixels = maxPixels
        shapesIn = null
      }
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
    // LC2: the batch it writes is held to R5's batch caps (values.ts keepFrames, batchWord) as it is
    // written, after its first paid calls: a 2× clip over them (its frames past MEDIA_CAPS' largest, or
    // its pixels past the batch's) is refused plainly here, before the hold. R11.8: a count that is only an
    // upper bound (`exact: false`) proves nothing over the batch's pixels: it is taken, and the node's turn
    // refuses the clip itself past the caps, in the same words, before any call (planUpscale2x).
    if (resized) {
      const words = { message: UPSCALE_2X_WORDS.clipTooLarge, nodeId, classType: n.class_type }
      const overCount = resized.count > caps.batchFrames || resized.count * resized.w * resized.h > caps.batchPixels
      // Fix round 1 (L2): a count whose packets were counted is sure too.
      if (resized.w * resized.h > caps.framePixels || (overCount && (resized.exact || resized.counted === true))) return { counts, keptBytes: 0, problem: null, refused: words }
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
  const peak = keptPeak(prompt, families, shapes, { release: false, caps })
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
 *   - R11.8 (ruling (k)): the paid makers from their own settings
 *     (#shared/runner/sourceBounds, through Gates and Audio cards): Generate
 *     music by its `duration` (a wired one: the most it takes, 30 s), Generate
 *     speech by its text over the slowest speaking rate, Clone a singing voice
 *     by its input's first 60 s, each plus a second;
 *   - anything else: null — held at one call's longest sound, with the node's
 *     turn as the backstop.
 */
export function whisperSoundBound(prompt: ApiPrompt, link: ApiLink, shapes: ReadonlyMap<string, SoundShape>): number | null {
  return soundBoundOf(prompt, link, shapes)?.seconds ?? null
}

/** soundBoundOf's answer: the bound in seconds, and what it rests on. */
export interface SoundBound {
  seconds: number
  /** Every source in the chain is known to the sample (the empty card, Empty audio and the effects over them). */
  exact: boolean
  /** R11.8: a header source's second of slack is in it (a loaded file, a video's sound): a cap may be passed by that second. */
  header?: true
  /** R11.8: a paid maker's bound from its settings: held on, never refused on (the node's turn judges the sound). */
  upTo?: true
}

/**
 * whisperSoundBound's bound, and what it rests on (R7.8, R11.8): `exact` only
 * where every source in the chain is known to the sample; `header` where a
 * header source's second of slack is in it, so a caller refusing past a cap
 * adds that second only then (R7.7's parked cap + 1, R11.8); `upTo` where a
 * paid maker's settings bound it, so a caller holds on it and refuses nothing.
 */
export function soundBoundOf(prompt: ApiPrompt, link: ApiLink, shapes: ReadonlyMap<string, SoundShape>): SoundBound | null {
  const of = (s: SoundShape): SoundBound => ({
    seconds: s.samples / s.rate + WHISPER_RESAMPLE_SLACK, exact: s.exact,
    ...(s.header ? { header: true as const } : {}), ...(s.upTo ? { upTo: true as const } : {}),
  })
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const s = shapes.get(`${at[0]}:${at[1]}`)
    if (s && s.rate > 0) return of(s)
    const n = prompt[at[0]]
    if (!n) return null
    const inputs = n.inputs ?? {}
    if (n.class_type === GATE_CLASS && at[1] === 0 && isLink(inputs.data_in)) { at = inputs.data_in; continue }
    if (n.class_type === 'Audio' && at[1] === 0 && isLink(inputs.source)) { at = inputs.source; continue }
    // R11.8: a paid maker's sound, from its settings (a speech text made in the run: the longest it reads).
    const made = at[1] === 0 ? madeSoundShapeOf(n.class_type, inputs, v => (isLink(v) ? shapes.get(`${v[0]}:${v[1]}`) : undefined)) : undefined
    return made ? of(made) : null
  }
  return null
}
