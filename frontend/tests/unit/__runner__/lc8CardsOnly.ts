// LC8 (F1, a ruled difference for the family-off pins): a cards-only graph whose output shows what a
// card made (an Empty image or a 3D Studio's picture in an Image card) is taken by the runner while
// `cards` is on, free (showsMadeResult); before, the runner declined it for having no work and every
// node was named as needing the engine, which is gone. True only for a graph taken because of that rule.
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { prunedAny, pruneInvalidOutputs, showsMadeResult } from '#shared/runner/validate'

export function takenOnlyByLc8CardsRule(p: ApiPrompt, families: ReadonlySet<RunnerFamily>): boolean {
  if (!families.has('cards')) return false
  const r = pruneInvalidOutputs(p, families)
  if (r.failed || !showsMadeResult(r.prompt)) return false
  const opts = { plainRefusals: true, afterPruning: prunedAny(r) }
  return !isRunnerEligible(r.prompt, families, opts) && isRunnerEligible(r.prompt, families, { ...opts, showsMadeResult: true })
}
