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
 * the same way (a stop-gap named in R7.2's report).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, PAID_PICTURE_SLOTS, outputKindsFor } from '#shared/runner/eligibility'
import { EFFECT_PICTURE_OUTPUTS, effectFamilyOn, effectSchemaOf } from '#shared/runner/effects'
import { outputKind } from '#shared/runner/values'
import { pyIntOf } from '#shared/runner/pyText'
import {
  BG_REMOVE_CLASS, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_MAX_PIXELS, LOCAL_MODEL_OUTPUT_KINDS, LOCAL_MODEL_PICTURE_INPUT, LOCAL_MODEL_WORDS, OBJECT_REMOVE_CLASS,
  OBJECT_REMOVE_WORDS, SAM_MASK_CLASSES, UPSCALE_2X_WORDS, localModelOn, overCapWords,
} from '#shared/runner/localModels'
import { linkPictureBound, linkPictureShapes, pictureSize, type Shape } from '../utils/graphInputPixels'
import { pictureMeta } from './pictures/pythonView'
import { hasAlphaAsPil } from './pictures/mask'
import type { FrameShape } from './video/table'
import { keptPeak } from './video/start'
import { parseInputFileRef } from './inputs'
import type { OutputFile } from './types'

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
  if (localModelOn(from.class_type, families) && link[1] === 1) {
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
    return link[1] === 0 && isLink(inputs[name]) ? pictureBound(prompt, inputs[name], families, depth + 1) : null
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
  /**
   * The most bytes this take keeps for its frame batches while it runs (R6's peak, every batch kept
   * to the end, a clip's cut-out batch among them), plus each clip's masks (16-bit PNGs, at most
   * raw size and a margin): 0 with no clip. The engine sums the takes against the run's kept room.
   */
  keptBytes: number
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
 * through Gates. Any other maker
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
  return Object.values(prompt).some(n => localModelOn(n.class_type, families) && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, n.class_type))
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
  const cap = o.hosted ? LOCAL_MODEL_MAX_FRAMES.hosted : LOCAL_MODEL_MAX_FRAMES.local
  const kinds = outputKindsFor(families)
  let shapes: ReadonlyMap<string, FrameShape> | null = null
  let masks = 0
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (!localModelOn(n.class_type, families) || !Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, n.class_type)) continue
    const link = n.inputs?.[LOCAL_MODEL_PICTURE_INPUT[n.class_type]!]
    if (!isLink(link)) continue
    let count: number | null
    const maxPixels = Object.prototype.hasOwnProperty.call(LOCAL_MODEL_MAX_PIXELS, n.class_type) ? LOCAL_MODEL_MAX_PIXELS[n.class_type]! : null
    let pixels: number | null = null
    if (outputKind(prompt, link, kinds) === 'frames') {
      shapes ??= await o.shapes()
      const s = shapes.get(`${link[0]}:${link[1]}`)
      count = s?.count ?? null
      // A class with a mask slot (Background remove) keeps a mask per frame too.
      if (s && keepsMasks(n.class_type)) masks += maskBytesBound(s)
      if (s) pixels = s.w * s.h
    }
    else {
      count = pictureBound(prompt, link, families)
      if (maxPixels) pixels = await linkPictureBound(prompt, link, readerOf(o.read))
    }
    if (count === null || !Number.isFinite(count) || count < 0) {
      return { counts, keptBytes: 0, problem: { message: LOCAL_MODEL_WORDS.unknownCount, nodeId, classType: n.class_type } }
    }
    if (count > cap) return { counts, keptBytes: 0, problem: { message: overCapWords(n.class_type), nodeId, classType: n.class_type } }
    if (maxPixels) {
      if (pixels === null || !Number.isFinite(pixels) || pixels <= 0) return { counts, keptBytes: 0, problem: { message: UPSCALE_2X_WORDS.unknownSize, nodeId, classType: n.class_type } }
      if (pixels > maxPixels) return { counts, keptBytes: 0, problem: { message: UPSCALE_2X_WORDS.tooLarge, nodeId, classType: n.class_type } }
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
  if (!shapes) return { counts, keptBytes: 0, problem: null }
  const peak = keptPeak(prompt, families, shapes, { release: false })
  if (!peak) {
    const first = Object.keys(counts)[0]!
    return { counts, keptBytes: 0, problem: { message: LOCAL_MODEL_WORDS.unknownCount, nodeId: first, classType: prompt[first]!.class_type } }
  }
  return { counts, keptBytes: peak.bytes + masks, problem: null }
}
