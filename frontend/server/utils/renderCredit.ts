/**
 * When a stage that did not finish earns the render credit — one rule for
 * both paths: the runner's stage settle (server/runner/engine.ts runTakeLeg)
 * and the ComfyUI path's partial charge (settleWatcher.ts partialCharge,
 * Task G2).
 *
 * The render credit rides only on something made and shown. A failed or
 * stopped stage earns it only when it DELIVERED SOMETHING TO AN OUTPUT:
 *
 *   an output node ran to the end in this stage, and it is, or reads —
 *   directly or through other nodes — a node that made something in this
 *   stage. Output nodes: priceBook OUTPUT_CLASS_TYPES (the classes whose
 *   presence puts the render credit in the hold), and the Frame render
 *   (FRAME_RENDER_TYPES), which shows its render on the canvas — so a
 *   finished Frame render earns the render credit on its own (R1.5 ruling).
 *
 * "Ran to the end in this stage": the runner, status 'done' and not reused
 * from an earlier run; ComfyUI, in the failure's `executed` list and not
 * served from its cache. "Made something": a charged node that ran to the end
 * (the runner, credits charged for it; ComfyUI, a priced node), or a Frame
 * render that ran to the end (FRAME_RENDER_TYPES, free but a render). A paid
 * node that failed partway made nothing, whatever calls it finished: those
 * calls are charged, the render credit is not. A source card (an Image card
 * showing an uploaded picture) is an output class, but shows nothing the run
 * made, so it delivers nothing.
 *
 * A stage that finishes is not judged by this rule: it is charged as before.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { FRAME_RENDER_TYPES } from '#shared/runner/eligibility'
import { OUTPUT_CLASS_TYPES } from './priceBook'

/** Whether a node shows what it holds: an output class, or a Frame render (the Frame shows its render on the canvas). */
const shows = (classType: string | undefined) => !!classType && (OUTPUT_CLASS_TYPES.has(classType) || FRAME_RENDER_TYPES.has(classType))

/** Each output node (and each Frame render) → itself and every node it reads, directly or through others (sorted). */
export function outputReadsOf(prompt: ApiPrompt): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, node] of Object.entries(prompt)) {
    if (!shows(node?.class_type)) continue
    const seen = new Set<string>([id])
    const queue = [id]
    while (queue.length) {
      const at = prompt[queue.pop()!]
      for (const v of Object.values(at?.inputs ?? {})) {
        if (!isLink(v) || seen.has(v[0]) || !(v[0] in prompt)) continue
        seen.add(v[0])
        queue.push(v[0])
      }
    }
    out[id] = [...seen].sort()
  }
  return out
}

/**
 * Whether a stage that did not finish delivered something to an output (see
 * above). `ran`: the nodes that ran to the end in this stage; `made`: those of
 * them that made something.
 */
export function deliveredToOutput(
  outputReads: Readonly<Record<string, readonly string[]>>,
  ran: ReadonlySet<string>,
  made: ReadonlySet<string>,
): boolean {
  return Object.entries(outputReads).some(([id, reads]) => ran.has(id) && reads.some(r => made.has(r)))
}
