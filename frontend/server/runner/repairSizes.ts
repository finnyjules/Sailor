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
 */
import type { ApiPrompt } from '#shared/runner/graph'
import { REPAIR_SIZE_PRICED_CLASSES } from '#shared/runner/repair'
import { createGateReads, graphInputSizes, pictureSize } from '../utils/graphInputPixels'
import { parseInputFileRef } from './inputs'
import { measuredInputProblems, type RequestProblem } from './requestRules'
import type { OutputFile } from './types'

/** What the start of a hosted run knows of its Upscale / Enhance detail pictures. */
export interface StartPictureSizes {
  /** Node id → the pixels its picture has (exact), or at most has (a stated largest at or under the cap). */
  pixels: Record<string, number>
  /** The first refusal, or null. */
  problem: RequestProblem | null
}

/** The G1 walk over one prompt, kept to its Upscale and Enhance detail nodes. */
export async function startPictureSizes(prompt: ApiPrompt, read: (f: OutputFile) => Promise<Uint8Array>): Promise<StartPictureSizes> {
  const mine = (id: string) => REPAIR_SIZE_PRICED_CLASSES.includes(prompt[id]?.class_type ?? '')
  if (!Object.keys(prompt).some(mine)) return { pixels: {}, problem: null }
  // A file value as the runner names it (LoadImage, an Image card): its header, from the run's store.
  const readFile = async (value: string) => {
    const f = parseInputFileRef(value)
    return f ? pictureSize(await read(f)) : null
  }
  const sizes = await graphInputSizes(prompt, readFile, createGateReads())
  const pixels = Object.fromEntries(Object.entries(sizes.pixels).filter(([id]) => mine(id)))
  const problems = [...measuredInputProblems(prompt, pixels), ...sizes.problems.filter(p => mine(p.nodeId))]
  return { pixels, problem: problems[0] ?? null }
}
