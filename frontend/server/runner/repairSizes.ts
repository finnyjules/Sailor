/**
 * R3.5 (family `image-repair`), hosted: the size of the picture each Upscale
 * and Enhance detail node is sent, known at the start of the run, before the
 * hold. Both are billed by that size (the line-up's editCalls), so the hold
 * is priced on it (TakeRecord.measured) and a picture the price can't cover
 * is refused before anything is held.
 *
 * The sizes come from the hosted /prompt gate's own walk (Task G1,
 * server/utils/graphInputPixels.ts graphInputSizes), not a copy of it: a
 * loaded file's header, an Image card, another Upscale (× its engine's
 * factor on each side), Enhance detail (in place), the Frame, Resize /
 * Scale by / Crop, a generator's stated largest. Its refusals are the gate's:
 * a picture above the input cap (requestRules.ts measuredInputProblems),
 * one it can't size, a loaded file whose size can't be read, one past the
 * read budget. Files are read from the run's own store (the ownership check
 * has already run).
 *
 * Fix round 1 (ruling 1): a size the walk PREDICTS (from an upstream node's
 * factor, a generator's stated largest…) rather than reads from a file is
 * held with a margin: 1.1× each side (PREDICTED_MARGIN, 1.21× the area),
 * never above the input cap. At the node's turn such a picture is refused
 * only when it is larger than that; inside it, it is charged at its real
 * size. A size read from a file (a LoadImage or an Image card's own file,
 * through Image cards) keeps the exact rule.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { LARGEST_INPUT_PIXELS } from '#shared/pricing/editSettings'
import { REPAIR_SIZE_PRICED_CLASSES } from '#shared/runner/repair'
import { createGateReads, graphInputSizes, pictureSize } from '../utils/graphInputPixels'
import { parseInputFileRef } from './inputs'
import { measuredInputProblems, type RequestProblem } from './requestRules'
import type { OutputFile } from './types'

/** A predicted picture's margin on each side (ruling 1: 1.1, so 1.21× the area). */
export const PREDICTED_MARGIN = 1.1

/** The pixels a predicted size is held at: 1.1× each side, never above the input cap. */
export function predictedHoldPixels(px: number): number {
  // 1.1² = 121/100, in whole numbers (1.1 × 1.1 in floating point is a hair above 1.21).
  return Math.min(LARGEST_INPUT_PIXELS, Math.ceil(px * 121 / 100))
}

/** What the start of a hosted run knows of its Upscale / Enhance detail pictures. */
export interface StartPictureSizes {
  /** Node id → the pixels its picture has (exact), or at most has (a stated largest at or under the cap). */
  pixels: Record<string, number>
  /** The nodes whose size is predicted, not read from a file (held with the margin). */
  predicted: string[]
  /** The first refusal, or null. */
  problem: RequestProblem | null
}

/** The G1 walk over one prompt, kept to its Upscale and Enhance detail nodes. */
export async function startPictureSizes(prompt: ApiPrompt, read: (f: OutputFile) => Promise<Uint8Array>): Promise<StartPictureSizes> {
  const mine = (id: string) => REPAIR_SIZE_PRICED_CLASSES.includes(prompt[id]?.class_type ?? '')
  if (!Object.keys(prompt).some(mine)) return { pixels: {}, predicted: [], problem: null }
  // A file value as the runner names it (LoadImage, an Image card): its header, from the run's store.
  const readFile = async (value: string) => {
    const f = parseInputFileRef(value)
    return f ? pictureSize(await read(f)) : null
  }
  const sizes = await graphInputSizes(prompt, readFile, createGateReads())
  const pixels = Object.fromEntries(Object.entries(sizes.pixels).filter(([id]) => mine(id)))
  const problems = [...measuredInputProblems(prompt, pixels), ...sizes.problems.filter(p => mine(p.nodeId))]
  const predicted = Object.keys(pixels).filter(id => !readFromFile(prompt, prompt[id]?.inputs?.image))
  return { pixels, predicted, problem: problems[0] ?? null }
}

/**
 * Whether a picture wire leads to a file the start reads (a LoadImage, or an
 * Image card's own file), through Image cards that hand a wired picture on:
 * its size is measured, not predicted.
 */
function readFromFile(prompt: ApiPrompt, link: unknown, depth = 0): boolean {
  if (!isLink(link) || depth > 64) return false
  const node = prompt[link[0]]
  if (!node) return false
  if (node.class_type === 'LoadImage') return true
  if (node.class_type === 'Image') {
    const wired = node.inputs?.images
    return wired !== undefined ? readFromFile(prompt, wired, depth + 1) : typeof node.inputs?.image === 'string' && !!node.inputs.image
  }
  return false
}
