/**
 * Which nodes of a run need the local engine (ComfyUI). Sailor boots and runs
 * without it; only the workflows the runner can't take are refused, and the
 * refusal names those nodes by their titles. The rule is the runner's own
 * (`runnerTakesNode` / `isRunnerEligible`, shared/runner/eligibility.ts) —
 * this file only turns it into titles. Pure helpers, relative imports only:
 * layouts/default.vue (through app/lib/runner/needsEngine.ts) and the server
 * (server/utils/blockedModels.ts) share them, so there is one rule.
 */
import { isLink, type ApiNode, type ApiPrompt } from './graph'
import { isRunnerEligible, runnerTakesNode, svgReaderProblems } from './eligibility'
import { isLocalOnlyClass } from './localOnly'
import { prunedAny, pruneInvalidOutputs } from './validate'
import { EVERY_KNOWN_FAMILY, NO_FAMILIES, type RunnerFamily } from './families'
import { blockedModelRefusal, blockedModelUses, blockedModelsResponse, promptNodeTitle } from './blockedModels'
import { shaderEngineReason } from './shaderBakeKey'
import { switchedOffNodes } from './stopGaps'
import { NOT_TAKEN_NODE_WORDS, switchedOffWords } from './messages'
import { isEditorOnlyClass, retiredAdviceOf, retiredNodeIds, type IsOutputClass } from './retired'

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
  // (shared/runner/validate.ts). When every output fails, or there is none,
  // the runner itself refuses the workflow in plain words: nothing needs the engine.
  const pruned = pruneInvalidOutputs(prompt, families)
  // No output node (R3.8 fix round 2), like every output failing: the runner
  // itself refuses it in plain words ("Nothing here shows or saves a result"),
  // so nothing needs the engine, which would only refuse it too.
  if (pruned.failed) return { run: {}, ids: [] }
  const run = pruned.prompt
  const ids = Object.keys(run)
  // R11.9a: a node the runner refuses in plain words (./stopGaps.ts) doesn't need the engine: the runner says why.
  const lenient = { plainRefusals: true }
  const blocked = ids.filter(id => !runnerTakesNode(run, id, families, lenient))
  if (!blocked.length && !isRunnerEligible(run, families, { ...lenient, afterPruning: prunedAny(pruned) })) return { run, ids }
  return { run, ids: blocked }
}

/**
 * The plain reasons the shared rule gives for the nodes that need the engine
 * (nodesNeedingEngine's nodes), each once, in prompt order (R2.10: a Shader
 * effect whose picture is made in the same run; R11.9a, row 25: a node whose
 * family is off, "“Name” is switched off right now.", named by `titleOf`).
 * Empty with the runner off.
 */
export function needsEngineReasons(
  prompt: ApiPrompt,
  opts: { runnerOn: boolean; families?: ReadonlySet<RunnerFamily>; titleOf?: (id: string) => string },
): string[] {
  if (!opts.runnerOn) return []
  const families = opts.families ?? NO_FAMILIES
  const { run, ids } = blockedNodes(prompt, families)
  const off = new Set(switchedOffNodes(run, families))
  const titleOf = opts.titleOf ?? ((id: string) => promptNodeTitle(run, id))
  const reasons = ids.map(id => shaderEngineReason(run, id, families) ?? (off.has(id) ? switchedOffWords(titleOf(id)) : null)).filter((r): r is string => !!r)
  return [...new Set(reasons)]
}

// ── R10.2: the canvas never falls back silently ─────────────────────────────

/**
 * What a refused node's output is replaced with when judging the nodes it
 * feeds (`engineRoute`): a runner source of the same type, so a node the runner
 * refuses only because it reads a refused node (Save image after VAE decode,
 * or after a switched-off Blur) isn't counted as refused itself. Any other
 * type stands in as a picture: ComfyUI itself checks a wire's type.
 */
const STAND_IN_SOURCES: Readonly<Record<string, { node: ApiNode; slot: number }>> = {
  IMAGE: { node: { class_type: 'LoadImage', inputs: { image: 'stand-in.png', upload: 'image' } }, slot: 0 },
  MASK: { node: { class_type: 'LoadImage', inputs: { image: 'stand-in.png', upload: 'image' } }, slot: 1 },
  STRING: { node: { class_type: 'PrimitiveString', inputs: { value: '' } }, slot: 0 },
  INT: { node: { class_type: 'PrimitiveInt', inputs: { value: 0 } }, slot: 0 },
  FLOAT: { node: { class_type: 'PrimitiveFloat', inputs: { value: 0 } }, slot: 0 },
  BOOLEAN: { node: { class_type: 'PrimitiveBoolean', inputs: { value: false } }, slot: 0 },
  AUDIO: { node: { class_type: 'LoadAudio', inputs: { audio: 'stand-in.wav' } }, slot: 0 },
  VIDEO: { node: { class_type: 'LoadVideo', inputs: { file: 'stand-in.mp4' } }, slot: 0 },
}

/** The output types of a class (/object_info's `output`), or undefined when not known. */
export type OutputTypesOf = (classType: string) => readonly string[] | undefined

/**
 * The run with every wire from a `refused` node reading a stand-in source of
 * its type instead (STAND_IN_SOURCES): each node is then judged on its own.
 */
function withStandIns(run: ApiPrompt, refused: ReadonlySet<string>, outputTypesOf?: OutputTypesOf): ApiPrompt {
  const out: ApiPrompt = {}
  for (const [id, node] of Object.entries(run)) {
    let inputs: Record<string, unknown> | null = null
    for (const [name, v] of Object.entries(node.inputs ?? {})) {
      if (!isLink(v) || !refused.has(v[0]) || !run[v[0]]) continue
      const type = outputTypesOf?.(run[v[0]]!.class_type)?.[v[1]]
      const stand = STAND_IN_SOURCES[type ?? 'IMAGE'] ?? STAND_IN_SOURCES.IMAGE!
      const standId = `stand-in:${v[0]}:${v[1]}`
      out[standId] = { class_type: stand.node.class_type, inputs: { ...stand.node.inputs } }
      inputs ??= { ...node.inputs }
      inputs[name] = [standId, stand.slot]
    }
    out[id] = inputs ? { ...node, inputs } : node
  }
  return out
}

/** Where a run that isn't going to the runner goes: the local engine, or nowhere, with words. */
export type EngineRoute =
  | { to: 'engine' }
  | { to: 'refused'; title: string; description: string }

/**
 * R10.2: whether a run the runner won't take (declined, or skipped because the
 * browser already knows it won't) may go to the local engine. Only when:
 *   - this is local, not hosted;
 *   - the engine is up;
 *   - every node the runner refuses is one of decision 4's local-only classes
 *     (./localOnly.ts). A node the runner refuses only because it reads a
 *     refused node (Save image after VAE decode) rides along: it is judged
 *     with a stand-in source in that node's place, so only the node at fault
 *     is named.
 * Otherwise the run is refused in the runner's words, naming each node:
 *   - a node refused for its own sake (not local-only): its reason (a Shader
 *     effect's cause, "is switched off right now", or NOT_TAKEN_NODE_WORDS);
 *   - nothing refused here but the runner still declined (or is off): the
 *     runner's own words (`declined`: the server's message, or RUNNER_OFF_WORDS);
 *   - only local-only nodes, in hosted: they run only on the local engine;
 *   - only local-only nodes, locally with the engine off: "This workflow needs
 *     the local engine" (the old toast, kept for these classes only).
 * `titleOf` names a take's nodes (workflowNodeTitles).
 */
export function engineRoute(
  takes: { prompt: ApiPrompt | null | undefined; titleOf: (id: string) => string }[],
  opts: {
    runnerOn: boolean
    families?: ReadonlySet<RunnerFamily>
    hosted: boolean
    engineUp: boolean
    outputTypesOf?: OutputTypesOf
    /** The runner's words when it declined the run (the server's refusal message). */
    declined?: string | null
  },
): EngineRoute {
  // With the runner off, nodes are judged as the runner would judge them with every family on: a
  // local-only graph still goes to the engine, and anything else is refused in `declined`'s words.
  const families = opts.runnerOn ? (opts.families ?? NO_FAMILIES) : EVERY_KNOWN_FAMILY
  const lenient = { plainRefusals: true }
  const refused = new Map<string, string>()
  const localOnly = new Set<string>()
  for (const take of takes) {
    if (!take.prompt) continue
    const { run, ids } = blockedNodes(take.prompt, families)
    if (!ids.length) continue
    const local = ids.filter(id => isLocalOnlyClass(run[id]!.class_type))
    for (const id of local) localOnly.add(take.titleOf(id))
    const judged = withStandIns(run, new Set(ids), opts.outputTypesOf)
    const off = new Set(switchedOffNodes(run, families))
    for (const id of ids) {
      if (isLocalOnlyClass(run[id]!.class_type)) continue
      if (runnerTakesNode(judged, id, families, lenient)) continue
      const title = take.titleOf(id)
      if (refused.has(title)) continue
      const why = shaderEngineReason(run, id, families) ?? (off.has(id) ? switchedOffWords(title) : NOT_TAKEN_NODE_WORDS)
      refused.set(title, why)
    }
  }
  if (refused.size) {
    const titles = [...refused.keys()]
    const named = titles.slice(0, MAX_NAMED).map((t) => {
      const why = refused.get(t)!
      return why.startsWith(`“${t}”`) ? why : `“${t}”: ${why}`
    })
    const more = titles.length - named.length
    return {
      to: 'refused',
      title: titles.length === 1 ? `“${titles[0]}” can’t run` : `${titles.length} nodes can’t run`,
      description: [...named, ...(more > 0 ? [`And ${more} more.`] : [])].join(' '),
    }
  }
  if (!localOnly.size) {
    return { to: 'refused', title: 'This workflow can’t run', description: opts.declined?.trim() || WORKFLOW_CANT_RUN_WORDS }
  }
  const titles = [...localOnly]
  if (opts.hosted) return { to: 'refused', title: 'This workflow can’t run here', description: localOnlyHostedWords(titles) }
  if (!opts.engineUp) return { to: 'refused', title: 'This workflow needs the local engine', description: needsEngineDescription(titles) }
  return { to: 'engine' }
}

/** The words for a run while the runner is switched off (in this browser's settings, or a 404 from the server). */
export const RUNNER_OFF_WORDS = 'Running workflows in Sailor is switched off on this server right now.'

/** A run the runner declined though no node of it is refused here (the server's families differ), with no words of its own. */
export const WORKFLOW_CANT_RUN_WORDS = 'Sailor can’t run this workflow yet.'

/** In hosted, a run whose only refused nodes are local-only: they run only on the local engine, on one's own computer. */
export function localOnlyHostedWords(titles: string[]): string {
  return `${quotedList(titles)} ${titles.length === 1 ? 'runs' : 'run'} only on the local engine, on your own computer.`
}

interface WorkflowNodeLike { id: string | number; type?: string; title?: string }

/**
 * Title lookup over the run's own workflow (prompt keys are `String(node.id)`,
 * app/lib/graph/graphToPrompt.ts): the node's title, else its type's display
 * name from /object_info, else a plain "Unnamed node" — never a class name.
 * A node inside a subgraph (its prompt id is the instance's id followed by
 * its own, padded to 4 digits: app/lib/graph/flattenSubgraphs.ts, nested
 * likewise) is named by the subgraph card the user sees, the outermost one:
 * its title, else its subgraph's name (R4.1 fix round 1).
 */
export function workflowNodeTitles(
  workflow: { nodes?: WorkflowNodeLike[], definitions?: { subgraphs?: { id?: string, name?: string }[] } } | null | undefined,
  objectInfo: Record<string, { display_name?: string } | undefined> | null | undefined,
): (id: string) => string {
  const byId = new Map<string, WorkflowNodeLike>()
  for (const n of workflow?.nodes ?? []) byId.set(String(n.id), n)
  const subgraphNames = new Map<string, string>()
  for (const sg of workflow?.definitions?.subgraphs ?? []) if (sg?.id && sg.name?.trim()) subgraphNames.set(sg.id, sg.name.trim())
  const visible = (id: string): WorkflowNodeLike | undefined => {
    const exact = byId.get(id)
    if (exact || !/^\d{5,}$/.test(id)) return exact
    for (let k = Math.floor((id.length - 1) / 4); k >= 1; k--) {
      const card = byId.get(id.slice(0, id.length - 4 * k))
      if (card) return card
    }
    return undefined
  }
  return (id: string) => {
    const n = visible(id)
    const title = n?.title?.trim()
    if (title) return title
    const display = n?.type ? (objectInfo?.[n.type]?.display_name?.trim() || subgraphNames.get(n.type)) : undefined
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
  return [`Only the engine can run ${quotedList(titles)}.`, ...reasons.map(r => (/[.!?]$/.test(r) ? r : `${r}.`))].join(' ')
}

/** “A”, “B” and “C” (at most MAX_NAMED, then "and N more"); "this workflow" when empty. */
function quotedList(titles: string[]): string {
  const quoted = titles.slice(0, MAX_NAMED).map(t => `“${t}”`)
  const more = titles.length - quoted.length
  if (more > 0) quoted.push(`${more} more`)
  return quoted.length <= 1
    ? (quoted[0] ?? 'this workflow')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/**
 * The refusal for a run about to go to ComfyUI (the runner declined or was
 * skipped) that holds a retired partner node (shared/runner/retired.ts),
 * uses a model ComfyUI can't run (a discontinued one, one with no price yet,
 * or a runner-only one), or wires a Recraft SVG model's SVG into a node that
 * needs a picture (R11.4, only with `recraft-svg` on). Null when every take is fine. Names the first such node
 * by its title. A runner-only model whose switch is on was left out because
 * other nodes need the engine: the reason names them (needsEngineDescription);
 * with its switch off, the reason says so.
 */
export function blockedRunRefusal(
  takes: { prompt: ApiPrompt | null | undefined; titleOf: (id: string) => string }[],
  opts: { runnerOn: boolean; families?: ReadonlySet<RunnerFamily>; isOutputClass?: IsOutputClass },
): { title: string; description: string } | null {
  const families = opts.runnerOn ? (opts.families ?? NO_FAMILIES) : NO_FAMILIES
  // A retired partner node runs nowhere (Task R4.1): refused first, by its
  // title, when an output reads it. One nothing reads is pruned, as ComfyUI
  // prunes it (`isOutputClass`: /object_info's output test, ./validate.ts
  // outputClassesOf; without it every retired node counts).
  // An editor-only node (the Timeline, Task R9.1) is refused the same way,
  // saying where its result is made instead.
  for (const take of takes) {
    const id = retiredNodeIds(take.prompt, opts.isOutputClass)[0]
    if (id === undefined) continue
    const classType = (take.prompt as ApiPrompt)[id]?.class_type
    const title = isEditorOnlyClass(classType) ? `“${take.titleOf(id)}” can’t run in a workflow` : `“${take.titleOf(id)}” was retired`
    return { title, description: retiredAdviceOf(classType) }
  }
  // A Recraft SVG model's SVG wired into a node that needs pixels (R11.4):
  // neither the runner nor ComfyUI can read it, so it is refused here, before the
  // model check (the reader is why the runner left it).
  for (const take of takes) {
    const problem = svgReaderProblems(take.prompt, families)[0]
    if (!problem) continue
    return svgReaderRefusal(take.titleOf(problem.nodeId))
  }
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

/** What Save image and Preview image say they take, the description of an SVG refusal. */
export const SVG_READERS_ADVICE = 'Only Save image and Preview image take an SVG.'

/** The toast for an SVG wired into a node that needs a picture (R11.4), naming that node. */
export function svgReaderRefusal(title: string): { title: string; description: string } {
  return { title: `“${title}” needs a picture, not an SVG`, description: SVG_READERS_ADVICE }
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
