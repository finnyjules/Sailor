/**
 * R11.9c fix round 5: who takes a LoadImage's animated batch, and what the
 * start of a run checks for it before the hold.
 *
 * Python's LoadImage makes a batch of every frame of an animated GIF or WebP
 * (cards/loadImage.ts). Most readers use its first picture only (a paid
 * node's `tensor[0]`, the Frame, Smart Layout…): for them the runner decodes
 * frame 0 alone, as it did before R11.9c, and the batch caps don't apply (I2).
 * The batch is decoded, capped and counted in the run's kept room only when a
 * reader takes it, followed on through what hands a picture on unchanged (an
 * Image card fed by a wire, a Gate, an action with nothing to do, Pose
 * Mannequin's pass-through):
 *   - pictures: Save image, Preview image, the Shader effect, Image to mask,
 *     Text mask with a source (when it has a render), the local-model picture
 *     nodes and Slow motion (AI);
 *   - masks: an effect's mask input, a local-model node's mask;
 *   - an Image card picking a frame past the first (`batch_index` ≥ 1).
 * Get image size reads the count from the header (cards/utilities.ts), Face
 * swap and the picture effects refuse an animation from the header: none of
 * them needs the frames.
 *
 * I1: each reader that takes the batch is checked against its own limits
 * before the hold, from the header (frames × size): the cards' 268 million
 * pixels (CARD_MAX_PIXELS, Save image's after its scale too), an effect's
 * masks and outputs. Over → refused plainly, naming the node. Nothing fails at
 * its turn for a reason known at the start.
 */
import { GATE_CLASS, isLink, linksOf, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { CARD_MAX_PIXELS, PROVIDER_TYPES } from '#shared/runner/eligibility'
import { EFFECT_START_SIZED_CLASSES, effectFamilyOn, effectSchemaOf } from '#shared/runner/effects'
import { FRAME_INTERP_AI_CLASS, LOCAL_MODEL_PICTURE_INPUT, localModelOn } from '#shared/runner/localModels'
import { LOADER_FRAMES_TOO_MUCH, pictureBatchOverCaps } from '#shared/runner/media'
import { pyTruthy } from '#shared/runner/pyText'
import { actionPassThrough } from '../generators/actions'
import { bakeParams, parseInputFileRef } from '../inputs'
import { floatReadBy } from '../effects/tensorFiles'
import { hasAlphaAsPil } from '../pictures/mask'
import { pictureFrameCount, pictureHasFrames, pictureMeta } from '../pictures/pythonView'
import { linkPictureSize, pictureSize } from '../../utils/graphInputPixels'
import type { OutputFile } from '../types'

/** A reader that takes a LoadImage's batch: the node, the input it is wired into, and what the wire carries. */
export interface LoaderBatchReader {
  nodeId: string
  classType: string
  input: string
  carries: 'picture' | 'mask'
  /** An Image card picking one frame (`batch_index` ≥ 1): it needs the frames, and hands on one. */
  pick?: true
  /** Reached through Pose Mannequin, which hands the batch on only when it makes no call (an upper bound). */
  viaPose?: true
}

/** Words for a reader past its own limit with every frame of a loader's animation. */
export const LOADER_BATCH_TOO_LARGE = `This works on every frame of the animation at once, more than ${Math.floor(CARD_MAX_PIXELS / 1_000_000)} million pixels in all. Use a shorter or smaller animation.`

/** Whether `input` of a `cls` node takes the batch a wire carrying `carries` brings. */
function takesBatch(cls: string, input: string, inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>, carries: 'picture' | 'mask'): boolean {
  if (carries === 'mask') {
    const fx = effectSchemaOf(cls)
    if (fx && effectFamilyOn(cls, families) && fx.masks.some(m => m.name === input)) return true
    return localModelOn(cls, families) && input === 'mask'
  }
  if ((cls === 'SaveImage' || cls === 'PreviewImage') && input === 'images') return true
  if (cls === 'ShaderEffect' && input === 'image') return true
  if (cls === 'ImageToMask' && input === 'image') return true
  // As Python: with no render, Text mask gives its blank whatever the source, and never reads it.
  if (cls === 'TextMask' && input === 'source') return pyTruthy(bakeParams(inputs.params).rendered)
  if (cls === FRAME_INTERP_AI_CLASS && input === 'frames') return localModelOn(cls, families)
  return localModelOn(cls, families) && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, cls) && LOCAL_MODEL_PICTURE_INPUT[cls] === input
}

/** Every reader that takes LoadImage `loaderId`'s batch (its pictures, slot 0, or its masks, slot 1); none: frame 0 is enough. */
export function loaderBatchReaders(prompt: ApiPrompt, loaderId: string, families: ReadonlySet<RunnerFamily>): LoaderBatchReader[] {
  const out: LoaderBatchReader[] = []
  const seen = new Set<string>()
  const walk = (id: string, slot: number, carries: 'picture' | 'mask', viaPose: boolean, depth: number) => {
    if (depth > 64) return
    for (const [rid, node] of Object.entries(prompt)) {
      for (const l of linksOf(node)) {
        if (l.from !== id || l.slot !== slot) continue
        const key = `${rid}:${l.input}:${carries}`
        if (seen.has(key)) continue
        seen.add(key)
        const cls = node.class_type
        const inputs = node.inputs ?? {}
        const pose = viaPose ? { viaPose: true as const } : {}
        if (cls === 'Image' && l.input === 'images') {
          // executors.ts: a numeric batch_index ≥ 0 picks one picture of a batch; 0 is frame 0, which needs no batch.
          const bi = inputs.batch_index
          if (typeof bi === 'number' && bi >= 0) {
            if (bi >= 1) out.push({ nodeId: rid, classType: cls, input: l.input, carries, pick: true, ...pose })
            continue
          }
          walk(rid, 0, carries, viaPose, depth + 1)
          continue
        }
        if (cls === GATE_CLASS && l.input === 'data_in') { walk(rid, 0, carries, viaPose, depth + 1); continue }
        if (PROVIDER_TYPES.has(cls) && actionPassThrough(cls, inputs) === l.input) { walk(rid, 0, carries, viaPose, depth + 1); continue }
        if (cls === 'PoseMannequin' && l.input === 'character') { walk(rid, 0, carries, true, depth + 1); continue }
        if (takesBatch(cls, l.input, inputs, families, carries)) out.push({ nodeId: rid, classType: cls, input: l.input, carries, ...pose })
      }
    }
  }
  walk(loaderId, 0, 'picture', false, 0)
  walk(loaderId, 1, 'mask', false, 0)
  return out
}

/** Whether any reader takes LoadImage `loaderId`'s batch (else it decodes frame 0 alone). */
export function loaderBatchTaken(prompt: ApiPrompt, loaderId: string, families: ReadonlySet<RunnerFamily> | undefined): boolean {
  return !!families && loaderBatchReaders(prompt, loaderId, families).length > 0
}

/** What the start of a run knows of an animated loader's batch, from its header. */
export interface LoaderBatchShape {
  count: number
  w: number
  h: number
  /** Its masks are 1 − alpha at the frame's size (Pillow hands every frame on as RGBA), else 64 × 64 zeros. */
  alpha: boolean
}

/** save_images' output size (cards/saveImage.ts saveSize, handed in: that module reads this one's neighbours). */
export type SaveSizeOf = (w: number, h: number, scale: number, maxDimension: number) => { w: number; h: number }

/** Save image's output size from its widgets, or null when a wired one can't be known before the run. */
function savedSize(cls: string, inputs: Record<string, unknown>, w: number, h: number, saveSize: SaveSizeOf): { w: number; h: number } | null {
  if (cls === 'PreviewImage') return { w, h }
  if (isLink(inputs.scale) || isLink(inputs.max_dimension)) return null
  const scale = typeof inputs.scale === 'number' ? inputs.scale : Number(inputs.scale ?? 1)
  const max = typeof inputs.max_dimension === 'number' ? Math.trunc(inputs.max_dimension) : Number.parseInt(String(inputs.max_dimension ?? 0), 10)
  if (!Number.isFinite(scale) || !Number.isFinite(max)) return null
  return saveSize(w, h, scale, max)
}

/**
 * I1: the words a reader is refused in, before the hold, for every frame of
 * this batch past its own limits, or null. `pictureOf`: an effect's first
 * picture's size, where it is known exactly (its output's size).
 */
export async function loaderBatchReaderRefusal(
  prompt: ApiPrompt, r: LoaderBatchReader, s: LoaderBatchShape,
  o: { saveSize: SaveSizeOf; pictureOf: (link: unknown) => Promise<{ px: number; exact: boolean } | null> },
): Promise<string | null> {
  if (r.pick) return null
  const inputs = prompt[r.nodeId]?.inputs ?? {}
  const px = s.w * s.h
  switch (r.classType) {
    case 'SaveImage':
    case 'PreviewImage': {
      // cards/utilities.ts sizes(…, cap): every distinct frame read; then save_images' size for each.
      if (s.count * px > CARD_MAX_PIXELS) return LOADER_BATCH_TOO_LARGE
      const out = savedSize(r.classType, inputs, s.w, s.h, o.saveSize)
      return out && s.count * out.w * out.h > CARD_MAX_PIXELS ? LOADER_BATCH_TOO_LARGE : null
    }
    case 'ImageToMask':
    case 'TextMask':
      return s.count * px > CARD_MAX_PIXELS ? LOADER_BATCH_TOO_LARGE : null
  }
  const fx = r.carries === 'mask' ? effectSchemaOf(r.classType) : undefined
  if (fx) {
    // effects/plan.ts planJobs: every distinct mask read (a see-through animation's, one a frame; else one 64 × 64 mask) …
    const maskPx = s.alpha ? px : 64 * 64
    if ((s.alpha ? s.count * maskPx : maskPx) > CARD_MAX_PIXELS) return LOADER_BATCH_TOO_LARGE
    // … and its outputs, one each a frame, at its first picture's size (else the first mask's), where it is known.
    if (EFFECT_START_SIZED_CLASSES.includes(r.classType)) return null
    const firstPicture = fx.images.find(i => isLink(inputs[i.name]))
    let outPx: number | null = maskPx
    if (firstPicture) {
      const size = await o.pictureOf(inputs[firstPicture.name])
      outPx = size?.exact ? size.px : null
      // Its picture is read with the masks, within the same total.
      if (outPx !== null && (s.alpha ? s.count * maskPx : maskPx) + outPx > CARD_MAX_PIXELS) return LOADER_BATCH_TOO_LARGE
    }
    if (outPx !== null && outPx * s.count * fx.outputs.length > CARD_MAX_PIXELS) return LOADER_BATCH_TOO_LARGE
    return null
  }
  // The Shader effect, the local-model nodes and Slow motion (AI) check the batch themselves before the hold.
  return null
}

/** The most bytes a loader batch keeps for the run: each frame's RGB PNG and 16-bit mask PNG, and (read as a float) its mask tensor. */
export function loaderBatchKeptBytes(s: LoaderBatchShape, float: boolean): number {
  const px = s.w * s.h
  // An RGB PNG and a 16-bit mask PNG, at most their raw size and a margin each (a 64 × 64 mask is far below).
  let bytes = s.count * (Math.ceil(px * 5 * 1.01) + 2 * s.h + 2 * 64 * 1024)
  // M2: a float mask read by an effect or a Frame is kept beside each (a 4-byte float a pixel).
  if (float) bytes += s.count * ((s.alpha ? 4 * px : 4 * 64 * 64) + 64 * 1024)
  return bytes
}

/** One loader's batch problem before the hold (the node it names and the words), or what it keeps. */
export interface LoaderBatchStart {
  problem: { message: string; nodeId: string; classType: string; code: 'too-much-work' } | null
  /** Every taken batch's kept bytes (the run's kept room counts them). */
  keptBytes: number
  /** The first loader whose frames count in that room. */
  first: { nodeId: string; classType: string } | null
}

/**
 * The start of a run for every animated LoadImage whose batch some reader
 * takes (I1, I2, M2): its frames against R5's batch caps (LOADER_FRAMES_TOO_MUCH),
 * each reader against its own limits (LOADER_BATCH_TOO_LARGE), and its kept
 * bytes. A loader no reader takes the batch of is skipped: frame 0 is all it
 * decodes. `only`: the loader ids to check (a live preview's own nodes).
 */
export async function loaderBatchStartProblems(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  o: {
    hosted: boolean; read: (f: OutputFile) => Promise<Uint8Array>; exists?: (f: OutputFile) => Promise<boolean>; saveSize: SaveSizeOf; only?: ReadonlySet<string>
  },
): Promise<LoaderBatchStart> {
  let keptBytes = 0
  let first: LoaderBatchStart['first'] = null
  const pictureOf = (link: unknown) => linkPictureSize(prompt, link, async (value: string) => {
    const f = parseInputFileRef(value)
    return f ? pictureSize(await o.read(f)) : null
  }).catch(() => null)
  for (const [id, n] of Object.entries(prompt)) {
    if (n.class_type !== 'LoadImage' || (o.only && !o.only.has(id))) continue
    const f = parseInputFileRef(n.inputs?.image)
    if (!f || (o.exists && !(await o.exists(f)))) continue
    const readers = loaderBatchReaders(prompt, id, families)
    if (!readers.length) continue
    let bytes: Uint8Array
    let meta: Awaited<ReturnType<typeof pictureMeta>>
    try {
      bytes = await o.read(f)
      meta = await pictureMeta(bytes)
    }
    catch { continue }
    // An APNG (sharp reads one page) is refused by its readers from the header (bakeReplay.ts cardPictureFiles).
    if (!pictureHasFrames(meta, bytes) || (meta.pages ?? 1) < 2 || !meta.width || !meta.height) continue
    const s: LoaderBatchShape = {
      count: pictureFrameCount(meta, bytes), w: meta.width, h: meta.pageHeight ?? meta.height,
      alpha: hasAlphaAsPil(bytes, meta.hasAlpha, meta.format),
    }
    if (pictureBatchOverCaps(s.count, s.w, s.h, o.hosted)) return { problem: { message: LOADER_FRAMES_TOO_MUCH, nodeId: id, classType: n.class_type, code: 'too-much-work' }, keptBytes, first }
    for (const r of readers) {
      const words = await loaderBatchReaderRefusal(prompt, r, s, { saveSize: o.saveSize, pictureOf })
      if (words) return { problem: { message: words, nodeId: r.nodeId, classType: r.classType, code: 'too-much-work' }, keptBytes, first }
    }
    keptBytes += loaderBatchKeptBytes(s, floatReadBy(prompt, id, 1, families, 'mask'))
    first ??= { nodeId: id, classType: n.class_type }
  }
  return { problem: null, keptBytes, first }
}

/**
 * M4: the LoadImage whose whole batch a picture wire brings (through what hands
 * a picture on unchanged; an Image card picking one picture ends it), or null.
 */
export function loaderBatchBehind(prompt: ApiPrompt, link: unknown, depth = 0): { nodeId: string; file: OutputFile } | null {
  if (!isLink(link) || depth > 64) return null
  const node = prompt[link[0]]
  if (!node) return null
  const inputs = node.inputs ?? {}
  if (node.class_type === 'LoadImage') {
    const file = link[1] === 0 ? parseInputFileRef(inputs.image) : null
    return file ? { nodeId: link[0], file } : null
  }
  if (link[1] !== 0) return null
  if (node.class_type === 'Image') return typeof inputs.batch_index === 'number' && inputs.batch_index >= 0 ? null : loaderBatchBehind(prompt, inputs.images, depth + 1)
  if (node.class_type === GATE_CLASS) return loaderBatchBehind(prompt, inputs.data_in, depth + 1)
  const pass = PROVIDER_TYPES.has(node.class_type) ? actionPassThrough(node.class_type, inputs) : null
  return pass ? loaderBatchBehind(prompt, inputs[pass], depth + 1) : null
}

/**
 * M4: Get image size's batch size for a LoadImage's animation, from its header
 * (Python's LoadImage makes a batch of every frame; cheap and exact, as the
 * frames all have the first's size): null when the wire brings no such batch.
 */
export async function loaderBatchSizeOf(prompt: ApiPrompt, link: unknown, read: (f: OutputFile) => Promise<Uint8Array>): Promise<number | null> {
  const behind = loaderBatchBehind(prompt, link)
  if (!behind) return null
  try {
    const bytes = await read(behind.file)
    const meta = await pictureMeta(bytes)
    return pictureHasFrames(meta, bytes) ? pictureFrameCount(meta, bytes) : null
  }
  catch { return null }
}
