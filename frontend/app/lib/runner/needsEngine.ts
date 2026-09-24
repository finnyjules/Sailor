/**
 * Which nodes of a run need the local engine (ComfyUI). Sailor boots and runs
 * without it; only the workflows the runner can't take are refused, and the
 * refusal names those nodes by their titles. The rule is the runner's own
 * (`runnerTakesNode` / `isRunnerEligible`, shared/runner/eligibility.ts) —
 * this file only turns it into titles. Pure helpers, used by layouts/default.vue.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { pruneInvalidOutputs } from '#shared/runner/validate'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'

/** The fallback title for a node with neither a title nor a known display name. */
export const UNNAMED_NODE = 'Unnamed node'

/**
 * The titles of the nodes that need the engine, in prompt order, each once.
 * Runner off → every node. Runner on → every node the runner refuses (a type it
 * doesn't take, a model it doesn't run, several pictures, wired sound, a link
 * out of the prompt); when no single node is at fault but the runner still
 * refuses the whole (no provider node), every node. Empty = the runner takes it.
 * Outputs ComfyUI would drop for failing validation (and what only they
 * need) are left out first, as ComfyUI leaves them out.
 * `families`: the switched-on runner families (none by default).
 */
export function nodesNeedingEngine(
  prompt: ApiPrompt,
  opts: { runnerOn: boolean; families?: ReadonlySet<RunnerFamily>; titleOf: (id: string) => string },
): string[] {
  const families = opts.families ?? NO_FAMILIES
  if (!opts.runnerOn) return [...new Set(Object.keys(prompt).map(id => opts.titleOf(id)))]
  // What ComfyUI would run: outputs that fail validation are dropped first
  // (shared/runner/validate.ts). When every output fails, the runner itself
  // refuses the workflow with ComfyUI's message: nothing needs the engine.
  const pruned = pruneInvalidOutputs(prompt)
  if (pruned.failed) return []
  const run = pruned.prompt
  const ids = Object.keys(run)
  let blocked = ids.filter(id => !runnerTakesNode(run, id, families))
  if (!blocked.length && !isRunnerEligible(run, families, { afterPruning: pruned.dropped.length > 0 })) blocked = ids
  return [...new Set(blocked.map(id => opts.titleOf(id)))]
}

interface WorkflowNodeLike { id: string | number; type?: string; title?: string }

/**
 * Title lookup over the run's own workflow (prompt keys are `String(node.id)`,
 * app/lib/graph/graphToPrompt.ts): the node's title, else its type's display
 * name from /object_info, else a plain "Unnamed node" — never a class name.
 */
export function workflowNodeTitles(
  workflow: { nodes?: WorkflowNodeLike[] } | null | undefined,
  objectInfo: Record<string, { display_name?: string } | undefined> | null | undefined,
): (id: string) => string {
  const byId = new Map<string, WorkflowNodeLike>()
  for (const n of workflow?.nodes ?? []) byId.set(String(n.id), n)
  return (id: string) => {
    const n = byId.get(id)
    const title = n?.title?.trim()
    if (title) return title
    const display = n?.type ? objectInfo?.[n.type]?.display_name?.trim() : undefined
    return display || UNNAMED_NODE
  }
}

/** How many titles the refusal names before "and N more". */
const MAX_NAMED = 4

/**
 * The refusal's description: the nodes by their own titles, quoted.
 * `Only the engine can run “Upscale” and “Blur image”.`
 */
export function needsEngineDescription(titles: string[]): string {
  const quoted = titles.slice(0, MAX_NAMED).map(t => `“${t}”`)
  const more = titles.length - quoted.length
  if (more > 0) quoted.push(`${more} more`)
  const list = quoted.length <= 1
    ? (quoted[0] ?? 'this workflow')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
  return `Only the engine can run ${list}.`
}
