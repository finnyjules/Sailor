/**
 * LC9 fix round 1: what the Image cards with `export` on will write to the
 * output folder, bounded before the hold (cards/saveImage.ts
 * imageCardExporting saves it as Save image does), so the run's kept room
 * (hosted: MEDIA_CAPS.hosted.keptBytesPerRun) counts it with the run's other
 * kept bytes (engine.ts, beside Save image's saved frames).
 *
 * Each exporting card's pictures are bounded from what the start of the run
 * can know:
 *  - Smart Layout's list (through Image cards and Gates): its outputs' pixels
 *    (#shared/runner/smartLayout smartLayoutPixels), one file per output;
 *  - anything else: the picture's largest (../../utils/graphInputPixels.ts
 *    linkPictureBound: a loaded file's header, a generator's stated largest,
 *    an effect's size…) times how many pictures it may be
 *    (../localModelStart.ts pictureBound, `batch_index` picking one). A
 *    picture whose size can't be known (a paid node's answer, a 3D Studio
 *    bake) is at most 8192² (MAX_INPUT_PIXELS): every picture is decoded
 *    before it is saved, and the decoder refuses a larger one. A count that
 *    can't be known is held at the most one save may write: Save image
 *    refuses a batch past CARD_MAX_PIXELS before writing it (saveImage.ts
 *    SAVE_TOO_LARGE).
 * The saved size is the picture's times `scale` (a wired one at its most, 4;
 * `max_dimension` only makes it smaller), each side rounded up a pixel.
 * Each file at most four bytes a pixel plus 1 % (zlib's stored blocks), a
 * filter byte a row, 64 KiB for its chunks, and, for a PNG with metadata on,
 * the run's prompt and workflow as tEXt (saveImage.ts savedFrameTextBytes).
 * One count isn't a true bound: a batch whose number of pictures can't be
 * known is counted as one file's chunks (its pixels are still held at the
 * save's cap).
 *
 * Pure but for the file headers it reads through `read`.
 */
import { isLink, GATE_CLASS, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import { parseLayout, resolveOutputs, smartLayoutPixels } from '#shared/runner/smartLayout'
import { pyFloatOf, pyTruthy } from '#shared/runner/pyText'
import { linkPictureBound, pictureSize } from '../../utils/graphInputPixels'
import { pictureBound } from '../localModelStart'
import { parseInputFileRef } from '../inputs'
import { MAX_INPUT_PIXELS } from '../compositor/decode'
import type { OutputFile } from '../types'
import { imageCardExports, savedFrameTextBytes } from './saveImage'

/** Words for exports past the run's kept room. */
export const IMAGE_EXPORT_TOO_MUCH = 'Exporting these pictures would write more than one run can keep here. Turn export off on some Image cards, or lower their scale.'

/** The most side one saved picture has (the renderer's and the decoder's limit). */
const MAX_SIDE = 16384

/** Smart Layout's node, when an Image card's picture wire brings its list (through Image cards and Gates). */
function smartLayoutBehind(prompt: ApiPrompt, link: ApiLink, depth = 0): Record<string, unknown> | null {
  const node = prompt[link[0]]
  if (!node || depth > 64) return null
  const inputs = node.inputs ?? {}
  if (node.class_type === 'SmartLayout') return link[1] === 0 ? inputs : null
  const next = node.class_type === 'Image' ? inputs.images : node.class_type === GATE_CLASS ? inputs.data_in : undefined
  return isLink(next) ? smartLayoutBehind(prompt, next, depth + 1) : null
}

function scaleAtMost(v: unknown): number {
  if (isLink(v)) return 4
  const s = typeof v === 'number' ? v : typeof v === 'string' ? pyFloatOf(v) : typeof v === 'boolean' ? Number(v) : 1
  return s === null || !Number.isFinite(s) ? 4 : Math.min(4, Math.max(1, s))
}

/**
 * Every exporting Image card's bound (bytes), the total, and the first card
 * (to name in a refusal), or none when no card exports.
 */
export async function imageExportKeptBytes(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  o: { read?: (f: OutputFile) => Promise<Uint8Array>; workflow?: unknown },
): Promise<{ bytes: number; first: { nodeId: string; classType: string } | null }> {
  const readFile = async (value: string) => {
    const f = o.read ? parseInputFileRef(value) : null
    return f && o.read ? pictureSize(await o.read(f)) : null
  }
  let text: number | null = null
  let bytes = 0
  let first: { nodeId: string; classType: string } | null = null
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'Image') continue
    const inputs = n.inputs ?? {}
    if (!imageCardExports(inputs)) continue
    if (!isLink(inputs.images) && !parseInputFileRef(inputs.image)) continue
    first ??= { nodeId, classType: 'Image' }
    const s = scaleAtMost(inputs.scale)
    const png = isLink(inputs.format) || String(inputs.format ?? 'png').toLowerCase() === 'png'
    const embeds = png && (isLink(inputs.embed_metadata) || pyTruthy(inputs.embed_metadata ?? true))
    // A byte bound, not a price (step 4, C5: written factor-first so the markup guard, price-graph.unit.spec.ts, does not take it for one).
    const perFile = 64 * 1024 + MAX_SIDE + 4 * Math.ceil(2 * s * MAX_SIDE + 1) + (embeds ? (text ??= savedFrameTextBytes(prompt, o.workflow ?? null)) : 0)
    const sl = isLink(inputs.images) ? smartLayoutBehind(prompt, inputs.images) : null
    let pixels: number
    let count: number
    if (sl) {
      const px = smartLayoutPixels(sl)
      pixels = px === null ? CARD_MAX_PIXELS : px * s * s
      try { count = Math.max(1, resolveOutputs(parseLayout(sl.layout), typeof sl.aspects === 'string' ? sl.aspects : '').length) }
      catch { count = 1 }
    }
    else {
      const self: ApiLink = [nodeId, 0]
      const px = await linkPictureBound(prompt, self, readFile)
      const n = pictureBound(prompt, self, families)
      count = n ?? 1
      const one = px !== null && Number.isFinite(px) ? Math.min(px, MAX_INPUT_PIXELS) : MAX_INPUT_PIXELS
      pixels = n !== null ? Math.min(CARD_MAX_PIXELS, n * one * s * s) : CARD_MAX_PIXELS
    }
    bytes += Math.ceil(pixels * 4 * 1.01) + count * perFile
  }
  return { bytes, first }
}
