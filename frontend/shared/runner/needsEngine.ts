/**
 * Which nodes of a run the runner refuses, and the refusal built on it. Sailor
 * runs every workflow on its runner; there is no local engine (step 4, C5).
 * A workflow the runner can't take is refused, and the refusal names those
 * nodes by their titles. The rule is the runner's own (`runnerTakesNode` /
 * `isRunnerEligible`, shared/runner/eligibility.ts) — this file only turns it
 * into titles. (The file keeps its old name: "needs the engine" meant "the
 * runner refuses".) Pure helpers, relative imports only: layouts/default.vue
 * (through app/lib/runner/needsEngine.ts) and the server
 * (server/utils/blockedModels.ts) share them, so there is one rule.
 */
import { isLink, type ApiNode, type ApiPrompt } from './graph'
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES, RUNNER_SPECIAL_CLASSES, filmShotRefusalWords, filmShotTaken, isRunnerEligible, nodeValidationErrors, runnerTakesNode, svgReaderProblems } from './eligibility'
import { NOT_RUN_WORDS, isStockClass, stockClassAdvice } from './stockClasses'
import { NO_OUTPUTS_MESSAGE, NO_VALID_OUTPUTS_MESSAGE, RUNNER_OUTPUT_CLASSES, prunedAny, pruneInvalidOutputs, readByOutputs, showsMadeResult } from './validate'
import { EVERY_KNOWN_FAMILY, NO_FAMILIES, type RunnerFamily } from './families'
import { blockedModelRefusal, blockedModelUses, blockedModelsResponse, promptNodeTitle } from './blockedModels'
import { shaderEngineReason } from './shaderBakeKey'
import { switchedOffNodes } from './stopGaps'
import { NOT_TAKEN_NODE_WORDS, switchedOffWords } from './messages'
import { RETIRED_CLASSES, isEditorOnlyClass, retiredAdviceOf, retiredNodeIds, type IsOutputClass } from './retired'

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
  if (!blocked.length && !isRunnerEligible(run, families, { ...lenient, afterPruning: prunedAny(pruned), showsMadeResult: showsMadeResult(run) })) return { run, ids }
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
 * feeds (`runRefusal`): a runner source of the same type, so a node the runner
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

/** The node catalogue as /object_info gives it (only what the engine route reads). */
export type NodeCatalog = Readonly<Record<string, {
  input?: { required?: Readonly<Record<string, unknown>>; optional?: Readonly<Record<string, unknown>> }
  output?: readonly string[]
  output_node?: unknown
} | undefined>>

/** A class's entry in the catalogue, or undefined. */
const catalogEntry = (catalog: NodeCatalog | null | undefined, ct: string) =>
  catalog && Object.prototype.hasOwnProperty.call(catalog, ct) ? catalog[ct] : undefined

/** The widget types (/object_info): a required input of any other type is a wire. */
const WIDGET_TYPES: ReadonlySet<string> = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

/** The required wired inputs of a class (ComfyUI refuses a node missing one: required_input_missing). */
function requiredWires(catalog: NodeCatalog | null | undefined, ct: string): string[] {
  const req = catalogEntry(catalog, ct)?.input?.required
  if (!req) return []
  return Object.entries(req).filter(([, spec]) => {
    const t = Array.isArray(spec) ? spec[0] : undefined
    // Fix round 3 (M-1): the V3 meta-types (autogrow, dynamic combo, match type) arrive under other keys
    // (`images.image0`…): not counted as a missing wire.
    return typeof t === 'string' && !WIDGET_TYPES.has(t) && !/^COMFY_.*_V3$/.test(t)
  }).map(([name]) => name)
}

/**
 * LC8 (B3): ComfyUI's `return_type_mismatch` (execution.py validate_inputs,
 * comfy_execution/validation.py validate_node_input): a wire whose source
 * output's type (RETURN_TYPES) shares no type with the input's. Judged only
 * where the catalogue gives both as plain types: a COMBO or list input, '*',
 * the V3 meta-types (COMFY_…_V3), and an input or class the catalogue doesn't
 * list are left alone, as the safe side (the node isn't dropped for them).
 * An Image card wired from Load video frames' rate (FLOAT into IMAGE) is one.
 */
export function wireTypeMismatch(prompt: ApiPrompt, id: string, catalog: NodeCatalog | null | undefined): boolean {
  if (!catalog) return false
  const node = prompt[id]
  if (!node) return false
  const def = catalogEntry(catalog, node.class_type)
  if (!def) return false
  const plain = (t: unknown): t is string => typeof t === 'string' && t !== '' && t !== 'COMBO' && !/^COMFY_.*_V3$/.test(t)
  const types = (t: string) => new Set(t.split(',').map(x => x.trim()))
  for (const [name, v] of Object.entries(node.inputs ?? {})) {
    if (!isLink(v)) continue
    const from = prompt[v[0]]
    if (!from) continue
    const spec = def.input?.required?.[name] ?? def.input?.optional?.[name]
    const want = Array.isArray(spec) ? spec[0] : undefined
    const got = catalogEntry(catalog, from.class_type)?.output?.[v[1]]
    if (!plain(want) || !plain(got) || got === want) continue
    const a = types(got)
    const b = types(want)
    if (a.has('*') || b.has('*')) continue
    if (![...a].some(t => b.has(t))) return true
  }
  return false
}

/**
 * Step 4, C4: a wire from an output its source class doesn't have (the
 * catalogue lists fewer outputs): ComfyUI's validate_inputs reads
 * `RETURN_TYPES[slot]`, which raises, so validate_prompt drops the output
 * reading it and runs the rest. A Text card wired to a LoRA node's old second
 * output (its log, which the LoRA nodes no longer have) is one: dropped, it
 * keeps its saved text. Judged only where the catalogue lists the source class.
 */
export function wireFromMissingOutput(prompt: ApiPrompt, id: string, catalog: NodeCatalog | null | undefined): boolean {
  if (!catalog) return false
  for (const v of Object.values(prompt[id]?.inputs ?? {})) {
    if (!isLink(v)) continue
    const from = prompt[v[0]]
    const outputs = from ? catalogEntry(catalog, from.class_type)?.output : undefined
    if (Array.isArray(outputs) && v[1] >= outputs.length) return true
  }
  return false
}

/**
 * The run with node `id`'s wires from a `refused` node reading a stand-in
 * source of its type instead (STAND_IN_SOURCES): the node is then judged on
 * its own (what reads it is left as it is).
 */
function withStandIns(run: ApiPrompt, id: string, refused: ReadonlySet<string>, catalog?: NodeCatalog | null): ApiPrompt {
  const node = run[id]!
  const out: ApiPrompt = { ...run }
  let inputs: Record<string, unknown> | null = null
  for (const [name, v] of Object.entries(node.inputs ?? {})) {
    if (!isLink(v) || !refused.has(v[0]) || !run[v[0]]) continue
    const type = catalogEntry(catalog, run[v[0]]!.class_type)?.output?.[v[1]]
    const stand = STAND_IN_SOURCES[type ?? 'IMAGE'] ?? STAND_IN_SOURCES.IMAGE!
    const standId = `stand-in:${v[0]}:${v[1]}`
    out[standId] = { class_type: stand.node.class_type, inputs: { ...stand.node.inputs } }
    inputs ??= { ...node.inputs }
    inputs[name] = [standId, stand.slot]
  }
  if (inputs) out[id] = { ...node, inputs }
  return out
}

/** The refusal of a run the runner didn't take: a title and the words naming each node at fault. */
export interface RunRefusal { title: string; description: string }

/** A class the runner knows (a runner type, a rule row, or Film a shot), whatever its families. */
const runnerKnowsClass = (ct: string) => RUNNER_NODE_TYPES.has(ct) || Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, ct) || RUNNER_SPECIAL_CLASSES.has(ct)

/**
 * Fix round 1: what ComfyUI would run of a prompt (validate_prompt): an output
 * whose own subgraph fails validation is dropped, with what only it reads.
 * The runner's own pruning (./validate.ts) does this only when it knows every
 * class; here a node is invalid on the runner's own checks or when it misses a
 * wire the catalogue says is required (an Upscale with no picture); a class
 * the runner doesn't know is an output when the catalogue says so (one it
 * doesn't list counts as one: the safe side). 'failed': every output fails;
 * 'no-outputs': nothing shows or saves a result ("Prompt has no outputs").
 */
function engineRunPart(prompt: ApiPrompt, catalog?: NodeCatalog | null, o: { wireTypes?: boolean } = {}): ApiPrompt | 'failed' | 'no-outputs' {
  const ids = Object.keys(prompt)
  const isOutput = outputTest(catalog)
  const outputs = ids.filter(id => isOutput(prompt[id]!.class_type))
  if (!outputs.length) return ids.length ? 'no-outputs' : prompt
  const valid = new Map<string, boolean>()
  const check = (id: string, seen: Set<string>): boolean => {
    const known = valid.get(id)
    if (known !== undefined) return known
    const node = prompt[id]
    if (!node || seen.has(id)) return true
    seen.add(id)
    let ok = !nodeValidationErrors(node.class_type, node.inputs ?? {}).length
      && requiredWires(catalog, node.class_type).every(name => node.inputs?.[name] !== undefined)
      // LC8 (B3): a wire of the wrong type, as ComfyUI's validate_inputs refuses it (the output is dropped, the
      // rest runs). Only for the runner's hand-off (engineRunPrompt): runRefusal still names such a node.
      // C4: so is a wire from an output its source doesn't have (wireFromMissingOutput).
      && !(o.wireTypes && (wireTypeMismatch(prompt, id, catalog) || wireFromMissingOutput(prompt, id, catalog)))
    for (const v of Object.values(node.inputs ?? {})) if (isLink(v) && !check(v[0], seen)) ok = false
    valid.set(id, ok)
    return ok
  }
  const good = outputs.filter(o => check(o, new Set()))
  if (!good.length) return 'failed'
  const keep = readByOutputs(prompt, good)
  if (keep.size === ids.length) return prompt
  return Object.fromEntries(ids.filter(id => keep.has(id)).map(id => [id, prompt[id]!]))
}

/** Whether a class is an output node: the runner's own list for a class it knows, else the catalogue (one it doesn't list counts as one: the safe side). */
function outputTest(catalog?: NodeCatalog | null): (ct: string) => boolean {
  return (ct) => {
    if (runnerKnowsClass(ct)) return RUNNER_OUTPUT_CLASSES.has(ct)
    const def = catalogEntry(catalog, ct)
    return !def || def.output_node === true
  }
}

/**
 * LC8 (B2): a prompt whose every output fails validation, judged again: the
 * outputs that read a stock class Sailor doesn't run (./stockClasses.ts) and
 * what they read, or null when none does. A stock node's own settings can't be
 * judged (a Load Checkpoint's model list is empty), so such a node is named as
 * one Sailor doesn't run, not as a failed setting.
 */
function stockOutputsPart(prompt: ApiPrompt, catalog?: NodeCatalog | null): ApiPrompt | null {
  const isOutput = outputTest(catalog)
  const ids = Object.keys(prompt)
  const outputs = ids.filter(id => isOutput(prompt[id]!.class_type))
    .filter(o => [...readByOutputs(prompt, [o])].some(id => isStockClass(prompt[id]!.class_type)))
  if (!outputs.length) return null
  const keep = readByOutputs(prompt, outputs)
  return Object.fromEntries(ids.filter(id => keep.has(id)).map(id => [id, prompt[id]!]))
}

/**
 * Fix round 1: what ComfyUI would run of a prompt (engineRunPart), or null
 * when nothing of it would run. The canvas hands this to the runner when the
 * runner won't take the prompt as it is but takes this (a result missing a
 * wire it needs, with what only it reads, no longer keeps the rest off the
 * runner: ComfyUI would have dropped it and run the rest). LC8 (B3): so is a
 * result wired from an output of the wrong type (wireTypeMismatch).
 */
export function engineRunPrompt(prompt: ApiPrompt, catalog?: NodeCatalog | null): ApiPrompt | null {
  const part = engineRunPart(prompt, catalog, { wireTypes: true })
  if (typeof part === 'string') return null
  // LC8 round 2 (R10.2): a node Sailor doesn't run is never left out silently: such a run is no runner hand-off
  // (runRefusal names it).
  if (Object.entries(prompt).some(([id, n]) => !(id in part) && notRunBySailor(n.class_type))) return null
  return part
}

/** C5: a class Sailor doesn't run at all: a stock class (./stockClasses.ts) or a custom node. */
export function notRunBySailor(classType: string): boolean {
  return isStockClass(classType) || isCustomClass(classType)
}

/**
 * Fix round 3 (M-2): the toast for nodes a pruned run left out
 * (engineRunPrompt), by their titles, each once, or null when none was: ComfyUI
 * used to report them as node errors.
 */
export function leftOutNotice(
  takes: { prompt: ApiPrompt | null | undefined; pruned: ApiPrompt | null | undefined; titleOf: (id: string) => string }[],
): { title: string; description: string } | null {
  const titles = new Set<string>()
  for (const t of takes) {
    if (!t.prompt || !t.pruned || t.pruned === t.prompt) continue
    for (const id of Object.keys(t.prompt)) if (!(id in t.pruned)) titles.add(t.titleOf(id))
  }
  if (!titles.size) return null
  const list = [...titles]
  return { title: 'Some nodes were left out', description: `${quotedList(list)} won’t run: something ${list.length === 1 ? 'it needs' : 'they need'} isn’t wired in.` }
}

/**
 * R10.2, step 4 C5: the refusal of a run the runner won't take (declined, or
 * skipped because the browser already knows it won't), naming each node at
 * fault by its title, here and hosted alike: there is no local engine. Judged
 * on what ComfyUI would have run of it (engineRunPart: an empty Frame or a
 * Save image with nothing wired in is dropped, as ComfyUI dropped it). A node
 * the runner refuses only because it reads a refused node (Save image after
 * VAE decode) is judged with a stand-in source in that node's place, so only
 * the node at fault is named. The words:
 *   - a stock class or a custom node: "Sailor doesn’t run this node.", with
 *     what to use instead where Sailor has an equivalent (STOCK_CLASS_ADVICE);
 *   - a node refused for its own sake: its reason (a Shader effect's cause,
 *     Film a shot's, "is switched off right now", or NOT_TAKEN_NODE_WORDS);
 *   - every result fails validation: NO_VALID_OUTPUTS_MESSAGE;
 *   - nothing refused here but the runner still declined (or is off): the
 *     runner's own words (`declined`: the server's message, or RUNNER_OFF_WORDS).
 * `titleOf` names a take's nodes (workflowNodeTitles).
 */
export function runRefusal(
  takes: { prompt: ApiPrompt | null | undefined; titleOf: (id: string) => string }[],
  opts: {
    runnerOn: boolean
    families?: ReadonlySet<RunnerFamily>
    /** The node catalogue (/object_info): outputs, required wires, output types (never which classes are custom: isCustomClass). */
    catalog?: NodeCatalog | null
    /** The runner's words when it declined the run (the server's refusal message). */
    declined?: string | null
  },
): RunRefusal {
  // With the runner off, nodes are judged as the runner would judge them with every family on: a
  // node Sailor doesn't run is still named, and anything else is refused in `declined`'s words.
  const families = opts.runnerOn ? (opts.families ?? NO_FAMILIES) : EVERY_KNOWN_FAMILY
  const lenient = { plainRefusals: true }
  const refused = new Map<string, string>()
  /** Nodes Sailor doesn't run (a stock class or a custom node), by title, with their class. */
  const notRun = new Map<string, string>()
  let allFailed = false
  let noOutputs = false
  /** LC8 (F1): a take of nodes the runner takes one by one, with nothing to do (no work, no output reading anything). */
  let nothingToRun = false
  for (const take of takes) {
    if (!take.prompt) continue
    let part = engineRunPart(take.prompt, opts.catalog)
    // LC8 (B2): stock classes are judged before setting validation: an output reading one is named as a node
    // Sailor doesn't run, not as a failed setting.
    if (part === 'failed') part = stockOutputsPart(take.prompt, opts.catalog) ?? 'failed'
    // LC8 round 2 (R10.2): a node Sailor doesn't run is never left out: one the pruning dropped is still named.
    const judged = typeof part === 'string' ? null : part
    for (const [id, node] of Object.entries(take.prompt)) {
      if (judged && id in judged) continue
      if (notRunBySailor(node.class_type)) { const title = take.titleOf(id); if (!notRun.has(title)) notRun.set(title, node.class_type) }
    }
    if (part === 'failed') { allFailed = true; continue }
    if (part === 'no-outputs') { noOutputs = true; continue }
    const { run, ids } = blockedNodes(part, families)
    if (!ids.length) continue
    // LC8 (F1): every node taken on its own, the whole still not: there is nothing to do.
    if (ids.length === Object.keys(run).length && ids.every(id => runnerTakesNode(run, id, families, lenient))) nothingToRun = true
    const blocked = new Set(ids)
    const off = new Set(switchedOffNodes(run, families))
    for (const id of ids) {
      const title = take.titleOf(id)
      // C5: a stock class or a custom node: Sailor doesn't run it, named.
      if (notRunBySailor(run[id]!.class_type)) { if (!notRun.has(title)) notRun.set(title, run[id]!.class_type); continue }
      if (runnerTakesNode(withStandIns(run, id, blocked, opts.catalog), id, families, lenient)) continue
      if (refused.has(title) || notRun.has(title)) continue
      const shaderWhy = shaderEngineReason(run, id, families)
      // Fix round 3 (M-3): a Shader effect the browser didn't bake (it bakes only for a run the runner takes)
      // with nothing wrong of its own isn't named: the run's other nodes are why it can't run.
      if (!shaderWhy && isUnbakedShader(run[id]!)) continue
      refused.set(title, shaderWhy ?? filmShotWhy(run[id]!, families, title) ?? missingOutputWhy(run, id, opts.catalog) ?? (off.has(id) ? switchedOffWords(title) : NOT_TAKEN_NODE_WORDS))
    }
  }
  if (refused.size || notRun.size) {
    const titles = [...notRun.keys(), ...[...refused.keys()].filter(t => !notRun.has(t))]
    const description = [...(notRun.size ? [notRunWords(notRun)] : []), ...(refused.size ? [namedWords(refused)] : [])].join(' ')
    return { title: titles.length === 1 ? `“${titles[0]}” can’t run` : `${titles.length} nodes can’t run`, description }
  }
  if (allFailed) return { title: 'This workflow can’t run', description: `${NO_VALID_OUTPUTS_MESSAGE}.` }
  if (noOutputs) return { title: 'This workflow can’t run', description: NO_OUTPUTS_MESSAGE }
  const declined = opts.declined?.trim()
  // LC8 (F1): nothing refused and nothing to do: say so, unless the runner gave words of its own.
  if (nothingToRun && (!declined || declined === WORKFLOW_CANT_RUN_WORDS)) return { title: 'Nothing to run', description: NOTHING_TO_RUN_WORDS }
  return { title: 'This workflow can’t run', description: declined || WORKFLOW_CANT_RUN_WORDS }
}

/**
 * C5: the words for nodes Sailor doesn't run (`classOf`: title → class), named,
 * with what to use instead where Sailor has an equivalent:
 * `“KSampler”: Sailor doesn’t run this node. Use Generate an image instead.`
 * `“KSampler” and “Load Checkpoint”: Sailor doesn’t run these nodes. Instead of “KSampler”, use Generate an image.`
 */
export function notRunWords(classOf: ReadonlyMap<string, string>): string {
  const titles = [...classOf.keys()]
  if (titles.length === 1) {
    const use = stockClassAdvice(classOf.get(titles[0]!))
    return [`“${titles[0]}”: ${NOT_RUN_WORDS}`, ...(use ? [`Use ${use} instead.`] : [])].join(' ')
  }
  const head = `${quotedList(titles)}: Sailor doesn’t run these nodes.`
  // Every node with an equivalent (at most MAX_NAMED), whether or not the head named it.
  const advice = titles.flatMap((t) => {
    const use = stockClassAdvice(classOf.get(t))
    return use ? [`Instead of “${t}”, use ${use}.`] : []
  }).slice(0, MAX_NAMED)
  return [head, ...advice].join(' ')
}

/**
 * Fix round 3 (I-1): a class the committed node catalogue
 * (server/native/objectInfo.baseline.json.gz) doesn't hold and Sailor doesn't
 * know: a custom node (one a saved project holds from an old local install).
 * Judged without the served /object_info: every catalogue class is a stock
 * class, runner-known, retired or editor-only (held to the catalogue by
 * tests/unit/runner-no-silent-engine.unit.spec.ts), so a class that is none
 * of these isn't in it.
 */
export function isCustomClass(classType: string): boolean {
  return !isStockClass(classType) && !runnerKnowsClass(classType) && !RETIRED_CLASSES.has(classType)
    && !isEditorOnlyClass(classType)
}

/**
 * Step 4, C4: why a Film a shot isn't taken, by name: its family (or its
 * model's) off, as switched off; else what to change (filmShotRefusalWords).
 * Null for any other node, or one taken.
 */
function filmShotWhy(node: ApiNode, families: ReadonlySet<RunnerFamily>, title: string): string | null {
  if (node.class_type !== 'FilmShotNode') return null
  const inputs = node.inputs ?? {}
  if (filmShotTaken(inputs, families)) return null
  return filmShotRefusalWords(inputs) ?? switchedOffWords(title)
}

/** C4: a node reading an output its source no longer has (wireFromMissingOutput), when the rest can't run without it. */
export const MISSING_OUTPUT_WORDS = 'This reads a result the node it’s wired to no longer makes. Remove that wire.'

function missingOutputWhy(run: ApiPrompt, id: string, catalog: NodeCatalog | null | undefined): string | null {
  return wireFromMissingOutput(run, id, catalog) ? MISSING_OUTPUT_WORDS : null
}

/** A Shader effect with no bake on it yet (fix round 3, M-3). */
function isUnbakedShader(node: ApiNode): boolean {
  return node.class_type === 'ShaderEffect' && (node.inputs?.sailor_baked === undefined || node.inputs?.sailor_baked === '')
}

/** “A”: why. “B”: why. (at most MAX_NAMED, then "And N more."); a reason that already names its node stands as it is. */
function namedWords(byTitle: ReadonlyMap<string, string>): string {
  const titles = [...byTitle.keys()]
  const named = titles.slice(0, MAX_NAMED).map((t) => {
    const why = byTitle.get(t)!
    return why.startsWith(`“${t}”`) ? why : `“${t}”: ${why}`
  })
  const more = titles.length - named.length
  return [...named, ...(more > 0 ? [`And ${more} more.`] : [])].join(' ')
}

/** The words for a run while the runner is switched off (in this browser's settings, or a 404 from the server). */
export const RUNNER_OFF_WORDS = 'Running workflows in Sailor is switched off on this server right now.'

/** A run the runner declined though no node of it is refused here (the server's families differ), with no words of its own. */
export const WORKFLOW_CANT_RUN_WORDS = 'Sailor can’t run this workflow yet.'

/** LC8 (F1): a workflow of cards that make nothing (an Image card alone): nothing to run. */
export const NOTHING_TO_RUN_WORDS = 'No node here makes or changes anything. Wire a node that makes a result into a card, then run.'

/**
 * LC8 (F4), C5: the refusal for a class neither the node catalogue the app
 * holds nor Sailor knows (the build can't read it), before anything is built
 * or sent, by its title: a custom node from an old local install. Sailor
 * doesn't run it, here and hosted alike. Null for a class Sailor knows (the
 * builder's own error stands).
 */
export function unknownClassRefusal(classType: string, title: string): RunRefusal | null {
  if (!isCustomClass(classType)) return null
  return { title: `“${title}” can’t run`, description: `“${title}”: ${NOT_RUN_WORDS}` }
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
 * LC8 (F2): why a runner-only model's workflow wasn't taken, naming the other
 * nodes the runner refused: never the engine, which can't run that model.
 * `“Save video” can’t take this as it’s set up. Change what it’s wired to, or show the result in a card.`
 */
export function cantTakeItWords(titles: string[]): string {
  return `${quotedList(titles)} can’t take this as ${titles.length === 1 ? 'it’s' : 'they’re'} set up. Change what ${titles.length === 1 ? 'it’s' : 'they’re'} wired to, or show the result in a card.`
}

/**
 * LC8 (F2): why a workflow with a runner-only model wasn't taken, by the
 * other nodes the runner refused (nodesNeedingEngine's), or null when none
 * is: a stock class or a custom node is named as one Sailor doesn't run
 * (notRunWords); a node whose family is off, as switched off; any other
 * Sailor node, in cantTakeItWords.
 */
function notTakenReason(
  prompt: ApiPrompt,
  opts: { runnerOn: boolean; families: ReadonlySet<RunnerFamily>; titleOf: (id: string) => string },
  except: string,
): string | null {
  const { run, ids } = opts.runnerOn ? blockedNodes(prompt, opts.families) : { run: prompt, ids: Object.keys(prompt) }
  const off = new Set(opts.runnerOn ? switchedOffNodes(run, opts.families) : [])
  const notRun = new Map<string, string>()
  const switched: string[] = []
  const other: string[] = []
  for (const id of ids) {
    const title = opts.titleOf(id)
    if (title === except || notRun.has(title) || switched.includes(title) || other.includes(title)) continue
    const ct = run[id]?.class_type ?? ''
    if (notRunBySailor(ct)) notRun.set(title, ct)
    else if (off.has(id)) switched.push(title)
    else other.push(title)
  }
  const parts = [
    ...(notRun.size ? [notRunWords(notRun)] : []),
    ...switched.map(t => switchedOffWords(t)),
    ...(other.length ? [cantTakeItWords(other)] : []),
  ]
  return parts.length ? parts.join(' ') : null
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
 * The refusal for a run the runner declined or skipped that holds a retired
 * partner node (shared/runner/retired.ts), uses a model Sailor can't run here
 * (a discontinued one, one with no price yet, or a runner-only one), or wires
 * a Recraft SVG model's SVG into a node that needs a picture (R11.4, only with
 * `recraft-svg` on). Null when every take is fine. Names the first such node
 * by its title. A runner-only model whose switch is on was left out because of
 * other nodes: the reason names them (notTakenReason); with its switch off,
 * the reason says so.
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
    const reason = notTakenReason(prompt, { runnerOn: opts.runnerOn, families, titleOf: take.titleOf }, title)
    return blockedModelRefusal(use, {
      title,
      families,
      ...(reason ? { engineReason: reason } : {}),
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
  const reason = families.size ? notTakenReason(prompt, { runnerOn: true, families, titleOf }, title) : null
  return blockedModelsResponse(prompt, uses, { families, titleOf, ...(reason ? { engineReason: reason } : {}) })
}
