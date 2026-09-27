/**
 * Which nodes of a run need the local engine (ComfyUI). Sailor boots and runs
 * without it; only the workflows the runner can't take are refused, and the
 * refusal names those nodes by their titles. The rule is the runner's own
 * (`runnerTakesNode` / `isRunnerEligible`, shared/runner/eligibility.ts) —
 * this file only turns it into titles. Pure helpers, relative imports only:
 * layouts/default.vue (through app/lib/runner/needsEngine.ts) and the server
 * (server/utils/blockedModels.ts) share them, so there is one rule.
 */
import type { ApiPrompt } from './graph'
import { isRunnerEligible, runnerTakesNode } from './eligibility'
import { pruneInvalidOutputs } from './validate'
import { NO_FAMILIES, type RunnerFamily } from './families'
import { blockedModelRefusal, blockedModelUses, blockedModelsResponse, promptNodeTitle } from './blockedModels'
import { shaderEngineReason } from './shaderBakeKey'

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
  if (!opts.runnerOn) return [...new Set(Object.keys(prompt).map(id => opts.titleOf(id)))]
  return [...new Set(blockedNodes(prompt, opts.families ?? NO_FAMILIES).ids.map(id => opts.titleOf(id)))]
}

/** The ids (in the prompt ComfyUI would run) the runner refuses, with that prompt. */
function blockedNodes(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): { run: ApiPrompt; ids: string[] } {
  // What ComfyUI would run: outputs that fail validation are dropped first
  // (shared/runner/validate.ts). When every output fails, the runner itself
  // refuses the workflow with ComfyUI's message: nothing needs the engine.
  const pruned = pruneInvalidOutputs(prompt, families)
  if (pruned.failed) return { run: {}, ids: [] }
  const run = pruned.prompt
  const ids = Object.keys(run)
  const blocked = ids.filter(id => !runnerTakesNode(run, id, families))
  if (!blocked.length && !isRunnerEligible(run, families, { afterPruning: pruned.dropped.length > 0 })) return { run, ids }
  return { run, ids: blocked }
}

/**
 * The plain reasons the shared rule gives for the nodes that need the engine
 * (nodesNeedingEngine's nodes), each once, in prompt order (R2.10: a Shader
 * effect whose picture is made in the same run). Empty with the runner off.
 */
export function needsEngineReasons(
  prompt: ApiPrompt,
  opts: { runnerOn: boolean; families?: ReadonlySet<RunnerFamily> },
): string[] {
  if (!opts.runnerOn) return []
  const families = opts.families ?? NO_FAMILIES
  const { run, ids } = blockedNodes(prompt, families)
  const reasons = ids.map(id => shaderEngineReason(run, id, families)).filter((r): r is string => !!r)
  return [...new Set(reasons)]
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
 * The refusal's description: the nodes by their own titles, quoted, then any
 * plain reasons (needsEngineReasons), each a sentence.
 * `Only the engine can run “Upscale” and “Blur image”.`
 */
export function needsEngineDescription(titles: string[], reasons: readonly string[] = []): string {
  const quoted = titles.slice(0, MAX_NAMED).map(t => `“${t}”`)
  const more = titles.length - quoted.length
  if (more > 0) quoted.push(`${more} more`)
  const list = quoted.length <= 1
    ? (quoted[0] ?? 'this workflow')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
  return [`Only the engine can run ${list}.`, ...reasons.map(r => `${r}.`)].join(' ')
}

/**
 * The refusal for a run about to go to ComfyUI (the runner declined or was
 * skipped) that uses a model ComfyUI can't run: a discontinued one, or a
 * runner-only one. Null when every take is fine. Names the first such node
 * by its title. A runner-only model whose switch is on was left out because
 * other nodes need the engine: the reason names them (needsEngineDescription);
 * with its switch off, the reason says so.
 */
export function blockedRunRefusal(
  takes: { prompt: ApiPrompt | null | undefined; titleOf: (id: string) => string }[],
  opts: { runnerOn: boolean; families?: ReadonlySet<RunnerFamily> },
): { title: string; description: string } | null {
  const families = opts.runnerOn ? (opts.families ?? NO_FAMILIES) : NO_FAMILIES
  for (const take of takes) {
    const prompt = take.prompt
    if (!prompt) continue
    const use = blockedModelUses(prompt, { families })[0]
    if (!use) continue
    const title = take.titleOf(use.nodeId)
    const needs = nodesNeedingEngine(prompt, { runnerOn: opts.runnerOn, families, titleOf: take.titleOf }).filter(t => t !== title)
    return blockedModelRefusal(use, {
      title,
      families,
      ...(needs.length ? { engineReason: needsEngineDescription(needs) } : {}),
    })
  }
  return null
}

/**
 * The server's refusal body for a prompt about to be forwarded to ComfyUI
 * that uses a discontinued or runner-only model (shared/runner/blockedModels.ts
 * `blockedModelsResponse`: ComfyUI's `{ error, node_errors }`), or null when
 * none does. The prompt carries no node titles, so nodes are named by their
 * `_meta.title` or their class's plain name.
 */
export function blockedPromptBody(
  prompt: ApiPrompt | null | undefined,
  opts: { families?: ReadonlySet<RunnerFamily> } = {},
): ReturnType<typeof blockedModelsResponse> | null {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return null
  const families = opts.families ?? NO_FAMILIES
  const uses = blockedModelUses(prompt, { families })
  if (!uses.length) return null
  const titleOf = (id: string) => promptNodeTitle(prompt, id)
  const title = titleOf(uses[0]!.nodeId)
  // Only read when the first model's switch is on (the runner is on): why the runner left it.
  const needs = families.size ? nodesNeedingEngine(prompt, { runnerOn: true, families, titleOf }).filter(t => t !== title) : []
  return blockedModelsResponse(prompt, uses, { families, titleOf, ...(needs.length ? { engineReason: needsEngineDescription(needs) } : {}) })
}
