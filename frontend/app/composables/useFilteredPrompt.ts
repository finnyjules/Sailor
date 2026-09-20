import type { LiteGraphWorkflow, LiteGraphNode } from '~/composables/useVueNodes'
import { VARS_TYPE } from '~/lib/collection/types'

/**
 * Whether an INT widget carries a sibling `control_after_generate` slot in
 * `widgets_values`. Mirrors ComfyUI's bundled frontend EXACTLY:
 *
 *   control_after_generate ?? ["seed","noise_seed"].includes(name)
 *
 * i.e. an explicit schema flag wins; when the flag is unset, any INT named
 * `seed`/`noise_seed` still gets the control widget. Sailor must agree, or
 * every widget after the seed shifts by one slot when the graph round-trips
 * through the iframe's LiteGraph. That shift is what made EditImageNode's
 * `safety_tolerance` read the next value (`0`, below its min of 1): ComfyUI then
 * fails validation for that node and silently drops the whole downstream branch
 * from the run (the Edit + its output never execute).
 */
export function seedHasControlWidget(name: string, type: string, config: any): boolean {
  if (String(type) !== 'INT') return false
  return Boolean(config?.control_after_generate ?? ['seed', 'noise_seed'].includes(name))
}

/** Minimal shape of a Vue Flow edge that link assembly reads. */
export interface VueEdgeLike {
  source: string | number
  target: string | number
  sourceHandle?: string | null
  targetHandle?: string | null
  data?: { dataType?: string } | null
}

/** A node whose id was invalid (null/NaN/non-numeric) and got reassigned. */
export interface RepairedNodeId {
  oldId: any
  newId: number
  type: string
}

/**
 * Heal nodes persisted with an invalid `id` (null, NaN, or a non-numeric
 * string like "null"). Such a node poisons the whole workflow: `convertTo
 * LiteGraph` does `Number(id)` → NaN → serializes as `null`, so every link
 * touching it ends up with a `null` origin/target. ComfyUI then can't resolve
 * those links, drops them, and the downstream input dangles → "No link found in
 * parent graph" aborts the run (or, once that input is healed, the chain is
 * silently severed and the run produces nothing).
 *
 * The root: a Vue node id of `"null"`/undefined round-trips through
 * `Number()`→NaN→`null` and re-loads as `"null"` again, so the corruption is
 * self-perpetuating until repaired. We assign each invalid-id node a fresh
 * unique numeric id and remap the links **structurally** — via the node's own
 * `inputs[].link` (rewrite that link's target) and `outputs[].links` (rewrite
 * its origin) — which is unambiguous even when several nodes are corrupt.
 *
 * Mutates `workflow` in place; returns the list of reassignments (empty = the
 * workflow's ids were all valid).
 */
export function repairInvalidNodeIds(workflow: any): RepairedNodeId[] {
  const repaired: RepairedNodeId[] = []
  if (!workflow?.nodes?.length) return repaired

  const isValidId = (id: any) =>
    (typeof id === 'number' && Number.isFinite(id)) ||
    (typeof id === 'string' && /^\d+$/.test(id))

  const links: any[] = Array.isArray(workflow.links) ? workflow.links : []
  let next = 1
  for (const n of workflow.nodes) {
    if (isValidId(n.id)) next = Math.max(next, Number(n.id) + 1)
  }

  for (const node of workflow.nodes) {
    if (isValidId(node.id)) continue
    const newId = next++
    for (const inp of node.inputs || []) {
      if (inp?.link == null) continue
      const l = links.find((t) => Array.isArray(t) && t[0] === inp.link)
      if (l) l[3] = newId // target id
    }
    for (const out of node.outputs || []) {
      for (const L of out?.links || []) {
        const l = links.find((t) => Array.isArray(t) && t[0] === L)
        if (l) l[1] = newId // origin id
      }
    }
    repaired.push({ oldId: node.id, newId, type: String(node.type ?? '') })
    node.id = newId
  }

  if (repaired.length) {
    const ids = workflow.nodes.map((n: any) => Number(n.id)).filter(Number.isFinite)
    workflow.last_node_id = ids.length ? Math.max(...ids) : 0
  }
  return repaired
}

/** A node input whose `link` referenced a link id absent from `links[]`. */
export interface DanglingLinkReport {
  nodeId: number | string
  nodeType: string
  slot: number
  inputName: string
  linkId: number
}

/**
 * Final-boundary invariant: every `node.inputs[].link` MUST point at a link id
 * present in `links[]`. ComfyUI's `graphToPrompt` resolves each input via
 * `graph.getLink(input.linkId)` and throws "No link found in parent graph for
 * id [N] slot [S]" (aborting the entire run) the instant one input references a
 * link the table doesn't contain. A dangling ref can survive any number of
 * transforms (a link dropped by filtering/locks, a node swapped out, ComfyUI's
 * own configure-time link repair), so we enforce the invariant once, in place,
 * right before the workflow crosses into the bridge iframe.
 *
 * Heals by nulling each dangling `input.link` (the node then serializes as a
 * leaf on that slot) and pruning stale ids from `output.links`. Returns the list
 * of healed inputs so the caller can log what it found — an empty list means the
 * workflow was already consistent. Also walks `definitions[].nodes` so subgraph
 * bodies (the "parent graph" the error names) are covered too.
 */
export function healDanglingLinks(workflow: any): DanglingLinkReport[] {
  const report: DanglingLinkReport[] = []
  if (!workflow || typeof workflow !== 'object') return report

  const healGraph = (graph: any) => {
    if (!graph?.nodes) return
    const nodeIds = new Set<number>()
    for (const n of graph.nodes) nodeIds.add(Number(n.id))
    // A subgraph body wires its I/O through synthetic boundary nodes whose ids
    // (default -10 inputNode / -20 outputNode) live OUTSIDE `nodes`. Seed them so
    // a legitimate boundary link (origin_id -10 / target_id -20) is NOT mistaken
    // for a dangling origin and nulled — which would sever the subgraph's inputs.
    if (graph.inputNode || graph.outputNode) {
      nodeIds.add(Number(graph.inputNode?.id ?? -10))
      nodeIds.add(Number(graph.outputNode?.id ?? -20))
      nodeIds.add(-10); nodeIds.add(-20)
    }
    const linkIds = new Set<number>()
    const originByLink = new Map<number, number>() // link id → origin node id
    for (const l of graph.links || []) {
      if (Array.isArray(l) && l.length) { linkIds.add(Number(l[0])); originByLink.set(Number(l[0]), Number(l[1])) }
      else if (l && typeof l === 'object' && 'id' in l) { linkIds.add(Number(l.id)); originByLink.set(Number(l.id), Number(l.origin_id)) }
    }
    for (const node of graph.nodes) {
      const inputs = node?.inputs
      for (let s = 0; s < (inputs?.length || 0); s++) {
        const inp = inputs[s]
        if (!inp || inp.link == null) continue
        const lid = Number(inp.link)
        // Two ways an input can't resolve, both fatal at graphToPrompt:
        //   1. the link id isn't in links[] ("No link found in parent graph"), or
        //   2. the link IS in links[] but its origin node was deleted — a
        //      re-splice minted a new upstream id and left this tuple pointing at
        //      the gone node. litegraph's resolveInput does getNodeById(origin)
        //      and throws InvalidLinkError "No input node found for id [N] slot
        //      [S]". Membership-of-link-id alone misses this; check the endpoint.
        const originMissing = originByLink.has(lid) && !nodeIds.has(originByLink.get(lid)!)
        if (!linkIds.has(lid) || originMissing) {
          report.push({
            nodeId: node.id,
            nodeType: String(node.type ?? ''),
            slot: s,
            inputName: String(inp.name ?? ''),
            linkId: lid,
          })
          inp.link = null
        }
      }
      for (const out of node?.outputs || []) {
        if (Array.isArray(out?.links)) {
          out.links = out.links.filter((id: any) => linkIds.has(Number(id)))
        }
      }
    }
  }

  healGraph(workflow)
  // Subgraph bodies. The PRODUCTION shape is `{ subgraphs: [...] }` (see
  // useSubgraphNavigation/useVueNodes); a bare array of definitions and a plain
  // object-map are also accepted for older data / other call sites. The previous
  // code only handled the array/object-map forms, so `Object.values({subgraphs})`
  // yielded `[subgraphsArray]` and healGraph(array) bailed — subgraph bodies were
  // silently never healed in production. Descend into `.subgraphs` explicitly.
  const defs = workflow.definitions
  const defList: any[] = Array.isArray(defs)
    ? defs
    : Array.isArray(defs?.subgraphs)
      ? defs.subgraphs
      : (defs && typeof defs === 'object') ? Object.values(defs) : []
  for (const d of defList) healGraph(d)
  return report
}

/**
 * Build the LiteGraph `links` table from Vue Flow edges, wiring each link onto
 * both endpoint nodes' `outputs[].links` / `inputs[].link`. Clears every node's
 * existing link refs first, then rebuilds from `edges`. Mutates `lgNodes`
 * in place and returns the link tuples ([id, originId, originSlot, targetId,
 * targetSlot, type]); link ids are 1..N contiguous, so the caller can take
 * `last_link_id` from the returned length.
 *
 * Orphaned edges — ones whose source OR target node isn't in `lgNodes` — are
 * skipped entirely (no tuple emitted, no input.link set). This is load-bearing:
 * a node can be removed from the serialized set while an edge to it lingers
 * (e.g. a leftover auto-materialized sink whose generator was deleted, or an
 * edge to a synthetic subgraph-I/O node the serializer drops). Emitting a link
 * for such an edge yields a tuple that references a non-existent node. ComfyUI's
 * `loadGraphData` then deletes that invalid link during its configure pass, but
 * the surviving node input keeps the dangling `link` id — so `graphToPrompt`
 * aborts the whole run with "No link found in parent graph for id [N] slot [S]".
 * Skipping the orphan leaves the node serializing cleanly as a leaf instead.
 *
 * VARS edges (Collection → Smart Layout) ARE emitted here like any other edge.
 * This is the sole link-builder feeding BOTH execution (runVueWorkflow) AND
 * persistence (getWorkflow → snapshotActiveCanvasIntoDoc's autosave/durable-doc
 * path), so skipping VARS here would silently drop the Collection→target wire
 * on every save/reload cycle even though nodes and bindings survive. Collection
 * still has no backend class_type, so VARS links must never reach ComfyUI's
 * `graphToPrompt` — that guard lives at the execution boundary instead
 * (`stripVarsLinks`, called from `runVueWorkflow` right before the workflow is
 * sent to the bridge iframe).
 */
export function assembleWorkflowLinks(
  lgNodes: LiteGraphNode[],
  edges: VueEdgeLike[],
): any[] {
  const nodeById = new Map<number, LiteGraphNode>()
  for (const n of lgNodes) nodeById.set(n.id, n)

  // Compute the DESIRED link state from `edges` into scratch maps first, without
  // touching the node objects. `convertToLiteGraph` passes the live Vue Flow node
  // data in by reference (`inputs: d.inputs` / `outputs: d.outputs`), so those
  // objects are reactive — a write here is a write the deep autosave graph watch
  // observes. The old code cleared and rebuilt every input.link/output.links up
  // front, which reassigned `output.links` to a fresh `[]` on EVERY call even when
  // connectivity was unchanged; the watch then saw a change on every serialize,
  // re-dirtied the canvas, and re-serialized — a feedback loop that froze the UI
  // for seconds whenever a Frame editor opened (each open dirties once, then the
  // loop thrashes). Diff-assigning below (write only on an ACTUAL change) makes a
  // no-op serialize perform zero reactive writes, so it can no longer re-trigger
  // the watch. The returned tuples and the final per-node link values are
  // byte-identical to before.
  const wantInputLink = new Map<LiteGraphNode, Map<number, number>>()
  const wantOutputLinks = new Map<LiteGraphNode, Map<number, number[]>>()

  const lgLinks: any[] = []
  let linkId = 0
  for (const edge of edges) {
    const sourceNode = nodeById.get(Number(edge.source))
    const targetNode = nodeById.get(Number(edge.target))
    // Orphaned edge — would emit a link referencing a node not in the graph.
    if (!sourceNode || !targetNode) continue

    const originSlot = parseInt(edge.sourceHandle?.replace('output-', '') || '0')
    const targetSlot = parseInt(edge.targetHandle?.replace('input-', '') || '0')
    linkId++
    lgLinks.push([
      linkId,
      Number(edge.source),
      originSlot,
      Number(edge.target),
      targetSlot,
      edge.data?.dataType || '*',
    ])

    if (sourceNode.outputs?.[originSlot]) {
      let bySlot = wantOutputLinks.get(sourceNode)
      if (!bySlot) wantOutputLinks.set(sourceNode, (bySlot = new Map()))
      let arr = bySlot.get(originSlot)
      if (!arr) bySlot.set(originSlot, (arr = []))
      arr.push(linkId)
    }
    if (targetNode.inputs?.[targetSlot]) {
      let bySlot = wantInputLink.get(targetNode)
      if (!bySlot) wantInputLink.set(targetNode, (bySlot = new Map()))
      bySlot.set(targetSlot, linkId)
    }
  }

  // Diff-assign: an unconnected input's desired link is `null`, an unconnected
  // output's desired links is `[]`. Write only when the live value differs — a
  // `null → []` normalisation (fresh nodes load `links: null`) happens once, then
  // stays stable, so it never loops.
  for (const node of lgNodes) {
    const inWant = wantInputLink.get(node)
    let slot = 0
    for (const input of node.inputs || []) {
      const want = inWant?.get(slot++) ?? null
      if (input.link !== want) input.link = want
    }
    const outWant = wantOutputLinks.get(node)
    slot = 0
    for (const output of node.outputs || []) {
      // Fresh `[]` for the unconnected case (not a shared sentinel): after the
      // one-time `null → []` normalisation the `sameLinkList` guard skips the
      // write, so a per-output array can't be aliased across nodes and corrupted
      // by an in-place mutation elsewhere.
      const want = outWant?.get(slot++) ?? []
      if (!sameLinkList(output.links, want)) output.links = want
    }
  }
  return lgLinks
}

/** Shallow array equality; a non-array (null/undefined) is never equal, forcing
 *  the one-time `null → []` normalisation the callers/tests expect. */
function sameLinkList(a: number[] | null | undefined, b: number[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Build a snapshot of `workflow` that runs only the work needed to produce
 * outputs from `targetNodeIds`. Forgiving semantics: any nodes the targets
 * depend on (transitively) stay active too — so users can right-click a
 * single output node and get a working subgraph automatically.
 *
 * Strategy: strip nodes outside the keep set entirely (along with any links
 * touching them). Earlier versions set `node.mode = 2` (mute) instead, which
 * worked at queue time but persisted into the bridge's LiteGraph state — so
 * a per-node Run on the middle sink of a fan-out would leave the other two
 * sinks visibly muted on the live canvas afterwards. Stripping avoids that:
 * the bridge sees only the active subgraph, never the mute flag.
 *
 * The keep set is built by walking upstream from targets only, so anything
 * we strip is guaranteed not to be referenced by anything we kept. Links
 * touching stripped nodes are removed too.
 */

/** Build the set of nodes to keep (targets + all transitive upstream deps). */
export function collectKeepSet(
  workflow: LiteGraphWorkflow,
  targetNodeIds: number[],
): Set<number> {
  // Index links by their consumer (target_id) so we can walk upstream cheaply.
  // Link tuple shape: [linkId, originId, originSlot, targetId, targetSlot, type]
  const upstreamByNode = new Map<number, number[]>()
  for (const link of workflow.links || []) {
    if (!Array.isArray(link) || link.length < 4) continue
    const originId = Number(link[1])
    const targetId = Number(link[3])
    if (!Number.isFinite(originId) || !Number.isFinite(targetId)) continue
    const list = upstreamByNode.get(targetId)
    if (list) list.push(originId)
    else upstreamByNode.set(targetId, [originId])
  }

  const keep = new Set<number>()
  const queue: number[] = []
  for (const id of targetNodeIds) {
    if (!keep.has(id)) {
      keep.add(id)
      queue.push(id)
    }
  }
  while (queue.length) {
    const id = queue.shift()!
    const ups = upstreamByNode.get(id)
    if (!ups) continue
    for (const u of ups) {
      if (keep.has(u)) continue
      keep.add(u)
      queue.push(u)
    }
  }
  return keep
}

/**
 * Build the keep set for a "run from here → end" request: the target node(s),
 * everything they feed (transitive consumers, walking forward), PLUS the
 * upstream dependencies of every node in that downstream cone.
 *
 * The upstream backfill is load-bearing — a downstream node usually pulls a
 * second input from outside the target's subtree (a Save node fed by both the
 * target image and a filename string; a compositor layer fed by the target and
 * a separate background). Keeping only the forward cone would leave those slots
 * dangling and Comfy would abort the run. So after the forward walk we run the
 * same upstream sweep `collectKeepSet` does, seeded from the whole cone.
 */
export function collectKeepSetDownstream(
  workflow: LiteGraphWorkflow,
  targetNodeIds: number[],
): Set<number> {
  // Index links both ways. Tuple: [linkId, originId, originSlot, targetId, …]
  const upstreamByNode = new Map<number, number[]>()
  const downstreamByNode = new Map<number, number[]>()
  for (const link of workflow.links || []) {
    if (!Array.isArray(link) || link.length < 4) continue
    const originId = Number(link[1])
    const targetId = Number(link[3])
    if (!Number.isFinite(originId) || !Number.isFinite(targetId)) continue
    const ups = upstreamByNode.get(targetId)
    if (ups) ups.push(originId)
    else upstreamByNode.set(targetId, [originId])
    const downs = downstreamByNode.get(originId)
    if (downs) downs.push(targetId)
    else downstreamByNode.set(originId, [targetId])
  }

  const keep = new Set<number>()

  // Forward BFS: targets + everything they transitively feed.
  const fwd: number[] = []
  for (const id of targetNodeIds) {
    if (!keep.has(id)) {
      keep.add(id)
      fwd.push(id)
    }
  }
  while (fwd.length) {
    const id = fwd.shift()!
    for (const d of downstreamByNode.get(id) || []) {
      if (keep.has(d)) continue
      keep.add(d)
      fwd.push(d)
    }
  }

  // Backfill: pull in the upstream deps of every node now in the cone so each
  // kept node has all of its inputs satisfied.
  const up = [...keep]
  while (up.length) {
    const id = up.shift()!
    for (const u of upstreamByNode.get(id) || []) {
      if (keep.has(u)) continue
      keep.add(u)
      up.push(u)
    }
  }
  return keep
}

/**
 * Returns a deep-cloned workflow with nodes outside the keep set removed
 * entirely, along with any links that touch them. Pre-existing mode=4
 * (bypass) on kept nodes is preserved so a user's explicit bypass still
 * applies inside the run.
 *
 * `direction` selects how the keep set is grown from the targets: `'upstream'`
 * (default) = the target + everything it depends on (run up to here);
 * `'downstream'` = the target + everything it feeds + those nodes' other inputs
 * (push this node's result through the rest of the graph).
 */
export function buildFilteredWorkflow(
  workflow: LiteGraphWorkflow,
  targetNodeIds: (string | number)[],
  direction: 'upstream' | 'downstream' = 'upstream',
): LiteGraphWorkflow {
  const targetIds = targetNodeIds.map(Number).filter(Number.isFinite)
  const keep = direction === 'downstream'
    ? collectKeepSetDownstream(workflow, targetIds)
    : collectKeepSet(workflow, targetIds)

  const cloned: LiteGraphWorkflow = JSON.parse(JSON.stringify(workflow))
  cloned.nodes = ((cloned.nodes as LiteGraphNode[]) || []).filter(
    (n) => keep.has(n.id),
  )
  // Drop links that reference a stripped node on either end. Tuple shape:
  // [linkId, originId, originSlot, targetId, targetSlot, type]
  if (Array.isArray(cloned.links)) {
    cloned.links = cloned.links.filter((link: any) => {
      if (!Array.isArray(link) || link.length < 4) return false
      const originId = Number(link[1])
      const targetId = Number(link[3])
      return keep.has(originId) && keep.has(targetId)
    })
  }
  stripVarsLinks(cloned)
  return cloned
}

/**
 * Execution-boundary guard: null out any node input still carrying a
 * VARS-typed link and drop matching link tuples. VARS links (Collection →
 * Smart Layout) are intentionally persisted everywhere else — `assembleWorkflowLinks`
 * emits them like any other edge so saves/reloads keep the Collection→target
 * wire intact — but Collection is a frontend-only data-table node with no
 * backend class_type, so a VARS link reaching ComfyUI's `graphToPrompt` would
 * abort the whole run ("No link found in parent graph"). This function is the
 * one place that strips them, called from `runVueWorkflow` right before the
 * workflow is sent to the bridge iframe (and from `buildFilteredWorkflow`,
 * which shares that same execution path for per-node/filtered runs).
 */
export function stripVarsLinks(workflow: LiteGraphWorkflow): void {
  const nodes = (workflow.nodes as LiteGraphNode[]) || []
  const varsLinkIds = new Set<number>()
  for (const node of nodes) {
    for (const input of node.inputs || []) {
      if (String((input as any).type) !== VARS_TYPE) continue
      if (input.link != null) varsLinkIds.add(Number(input.link))
      input.link = null
    }
  }
  if (!varsLinkIds.size) return
  for (const node of nodes) {
    for (const output of node.outputs || []) {
      if (Array.isArray(output.links)) {
        output.links = output.links.filter((id: any) => !varsLinkIds.has(Number(id)))
      }
    }
  }
  if (Array.isArray(workflow.links)) {
    workflow.links = workflow.links.filter((link: any) => {
      if (!Array.isArray(link)) return true
      return !varsLinkIds.has(Number(link[0]))
    })
  }
}

/**
 * Convenience for "Run Selection" semantics — treats every selected node as
 * a target. Identical to `buildFilteredWorkflow` but here as a named entry
 * point so call sites read clearly.
 */
export function buildSelectionWorkflow(
  workflow: LiteGraphWorkflow,
  selectedNodeIds: (string | number)[],
): LiteGraphWorkflow {
  return buildFilteredWorkflow(workflow, selectedNodeIds)
}

/**
 * Realign every node's `widgets_values` array to the current schema's widget
 * count. Without this, a node persisted from a workflow saved against an
 * older schema (one widget added or removed since) ships a wrong-length
 * array — values land in the wrong widget slots and Comfy rejects the
 * prompt with errors like "Value not in list: resolution: 'False'" (the
 * boolean from camera_fixed showing up where the resolution combo expects
 * an option string).
 *
 * For each node, we walk the current schema's widget order and rebuild the
 * array. Existing positional values that still line up are preserved;
 * missing slots get the schema's default; extras are dropped.
 *
 * Length-matching arrays still get a combo-validity sweep: a slot that holds
 * a value outside its combo's option list (e.g. a Compositor `layerN_blend`
 * carrying the integer 0 after a mid-array schema drift) is reset to the
 * combo default. Otherwise Comfy prunes just that node with
 * "value_not_in_list" — the rest of the prompt succeeds, so the run reports
 * success while the pruned node silently produces no output.
 */
export function realignWidgetValues(
  workflow: LiteGraphWorkflow,
  objectInfo: Record<string, any>,
): LiteGraphWorkflow {
  if (!workflow?.nodes?.length) return workflow
  let mutated = false
  const cloned: LiteGraphWorkflow = JSON.parse(JSON.stringify(workflow))

  for (const node of cloned.nodes as LiteGraphNode[]) {
    const info = objectInfo[node.type as string]
    if (!info) continue
    // Build expected widget order from the schema: required first, then
    // optional. Skip port-type inputs and forceInput widgets — those don't
    // occupy a slot in widgets_values.
    const expected: { name: string; defaultValue: any; options?: any[]; control?: boolean }[] = []
    const collect = (group: Record<string, any> | undefined) => {
      if (!group) return
      for (const [name, spec] of Object.entries(group)) {
        const specArr = Array.isArray(spec) ? spec : [spec]
        const type = specArr[0]
        const cfg = specArr[1] || {}
        // COMBO widget. Two on-the-wire shapes: legacy ComfyUI puts the option
        // list directly as spec[0] (an array); v3 IO nodes (e.g. Compositor's
        // layerN_blend) emit the string "COMBO" with options in cfg.options.
        // Missing either shape drops the widget from the expected order and
        // shifts every value after it — the bug that scrambled the Compositor.
        if (Array.isArray(type) || type === 'COMBO') {
          const options = Array.isArray(type)
            ? type
            : (Array.isArray(cfg.options) ? cfg.options : null)
          expected.push({ name, defaultValue: cfg.default ?? options?.[0] ?? null, options: options ?? undefined })
          continue
        }
        if (cfg.forceInput) continue
        if (['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(String(type))) {
          expected.push({ name, defaultValue: cfg.default ?? null })
          // Seed-type INT inputs carry a sibling control_after_generate slot
          // in LiteGraph's widgets_values — preserve it so our positional
          // mapping matches Comfy's bundled frontend (flag OR seed/noise_seed name).
          if (seedHasControlWidget(name, String(type), cfg)) {
            expected.push({ name: `${name}_control`, defaultValue: 'randomize', control: true })
          }
        }
      }
    }
    collect(info?.input?.required)
    collect(info?.input?.optional)

    const current = Array.isArray(node.widgets_values) ? node.widgets_values : []

    // Rebuild only when the length drifted; otherwise keep positions as-is.
    let realigned = current
    let changed = false
    const controlCount = expected.filter((e: any) => e.control).length
    if (current.length !== expected.length) {
      if (controlCount > 0 && current.length === expected.length - controlCount) {
        // Legacy array saved before a seed's control_after_generate slot was
        // accounted for (a name-only `seed` whose slot Sailor used to omit).
        // Interleave the control defaults back in, consuming a current value
        // only for non-control slots. The naive positional rebuild below would
        // otherwise shift every post-seed widget by one — the bug that fed `0`
        // into EditImageNode's min=1 `safety_tolerance` and got it dropped.
        let ci = 0
        realigned = expected.map((e: any) => (e.control ? e.defaultValue : current[ci++]))
      } else {
        realigned = expected.map((e, i) =>
          i < current.length ? current[i] : e.defaultValue,
        )
      }
      changed = true
    }

    // Combo-validity sweep (runs even for length-matched arrays). A combo slot
    // holding a value outside its option list is a strong signal the positional
    // array is misaligned — e.g. a Float/Int landing in a blend combo after a
    // mid-array schema drift. Left alone, Comfy prunes just that node with
    // "value_not_in_list", so the run reports success while the node silently
    // produces nothing.
    const comboInvalid = expected.some(
      (e, i) => e?.options && !e.options.includes(realigned[i]),
    )
    if (comboInvalid) {
      if (node.type === 'Compositor') {
        // The Compositor's 114-slot array can't be un-scrambled in place, so
        // rebuild it from schema defaults. injectCompositorOverlays re-applies
        // z from the saved stack order and bakes local layers, and width=0
        // falls back to layer 1's native size — so a clean default array
        // composites correctly. Custom per-layer transforms on an already-
        // corrupt frame are unrecoverable and reset to identity.
        realigned = expected.map((e) => e.defaultValue)
      } else {
        // Other node types: coerce only the offending combo slots so the rest
        // of the (presumed-aligned) array is preserved.
        realigned = realigned.map((v: any, i: number) => {
          const e = expected[i]
          return e?.options && !e.options.includes(v) ? e.defaultValue : v
        })
      }
      changed = true
    }

    if (changed) {
      node.widgets_values = realigned
      mutated = true
    }
  }

  return mutated ? cloned : workflow
}

/**
 * Strip incoming links for artifact nodes the user has "locked." A locked
 * artifact carries a frozen copy of its current preview in its file widget,
 * so it loads from disk instead of executing the upstream chain. Removing
 * its incoming links here means `collectKeepSet` stops walking upstream at
 * the locked node — the upstream generators (and any paid API calls they
 * make) get stripped from the run.
 *
 * `liveNodes` is the Vue Flow `nodes.value` array. We read the lock flag
 * from `node.data.properties.locked` there so the workflow JSON (which
 * comes from convertToLiteGraph) doesn't need its own copy of the flag —
 * `properties` round-trips through LiteGraph naturally.
 */
export function applyArtifactLocks(
  workflow: LiteGraphWorkflow,
  liveNodes: any[],
  /** Extra node ids to freeze for THIS run (not user-locked) — e.g. upstream
   *  artifacts that already have a result, so a targeted "run this node" reuses
   *  them instead of re-executing the chain that produced them. */
  extraFrozenIds?: Set<number>,
): LiteGraphWorkflow {
  const lockedIds = new Set<number>(extraFrozenIds ?? [])
  for (const n of liveNodes || []) {
    if (n?.data?.properties?.locked) {
      const id = Number(n.id)
      if (Number.isFinite(id)) lockedIds.add(id)
    }
  }
  if (!lockedIds.size) return workflow
  const cloned: LiteGraphWorkflow = JSON.parse(JSON.stringify(workflow))
  if (Array.isArray(cloned.links)) {
    cloned.links = cloned.links.filter((link: any) => {
      if (!Array.isArray(link) || link.length < 4) return true
      const targetId = Number(link[3])
      return !lockedIds.has(targetId)
    })
  }
  // Removing the links above leaves the locked nodes' input slots pointing at
  // link ids that no longer exist. LiteGraph's serializer (graphToPrompt) walks
  // those references and throws "No link found in parent graph for id [N] slot
  // [S]". Null the dangling input.link refs so a locked node serializes cleanly
  // as a leaf that loads from its frozen file widget.
  for (const node of (cloned.nodes as LiteGraphNode[]) || []) {
    if (!lockedIds.has(Number(node.id))) continue
    for (const inp of (node.inputs as any[]) || []) {
      if (inp && inp.link != null) inp.link = null
    }
  }
  return cloned
}

/**
 * Variant fan-out: when N `Image` sinks share one upstream IMAGE output,
 * mutate the workflow JSON so the upstream produces a batch of N and each
 * sink slices a different index. The Vue Flow display stays unchanged —
 * users see N wires from one source, the backend gets a batch + N indices.
 *
 * The mutation is in-place on the passed workflow (callers typically deep-
 * clone first via buildFilteredWorkflow / JSON.parse(JSON.stringify(...))).
 *
 * `objectInfo` is the schema map from `/api/object_info`, used to find the
 * positional index of `batch_size` / `batch_index` widgets per node type.
 */
export function applyVariantFanOut(
  workflow: LiteGraphWorkflow,
  objectInfo: Record<string, any>,
): LiteGraphWorkflow {
  // Pre-index nodes by id for O(1) lookup.
  const nodeById = new Map<number, LiteGraphNode>()
  for (const n of workflow.nodes || []) nodeById.set(n.id, n)

  // Group links by (originId, originSlot) — that's a single output handle.
  const linksByOrigin = new Map<string, any[]>()
  for (const link of workflow.links || []) {
    if (!Array.isArray(link) || link.length < 6) continue
    const key = `${link[1]}-${link[2]}`
    const list = linksByOrigin.get(key)
    if (list) list.push(link)
    else linksByOrigin.set(key, [link])
  }

  for (const [, links] of linksByOrigin) {
    if (links.length < 2) continue
    const dataType = String(links[0][5] || '').toUpperCase()
    if (dataType !== 'IMAGE') continue  // only IMAGE fan-out for v1

    // Origin must be a non-Image node (an actual generator/op).
    const originId = Number(links[0][1])
    const origin = nodeById.get(originId)
    if (!origin || origin.type === 'Image') continue

    // Sort sinks by target id for deterministic index assignment. Without
    // this, the same wires could swap indices between runs.
    const imageSinks = links
      .map((l) => ({ link: l, target: nodeById.get(Number(l[3])) }))
      .filter((t) => t.target?.type === 'Image')
      .sort((a, b) => Number(a.target!.id) - Number(b.target!.id))
    if (imageSinks.length < 2) continue

    const N = imageSinks.length

    // Bump the upstream batch_size if it has one. Many generators expose this
    // (SDXL/Flux samplers, EmptyLatentImage, Replicate Generate, …); the rest
    // get a single shared image — fan-out degrades gracefully rather than
    // erroring. Re-run fan-out (re-execute N times with different seeds) is
    // the universal fallback and lives in a follow-up.
    setNamedWidget(origin, 'batch_size', N, objectInfo)

    // Distribute indices: sink 0 → batch[0], sink 1 → batch[1], …
    for (let i = 0; i < imageSinks.length; i++) {
      setNamedWidget(imageSinks[i].target!, 'batch_index', i, objectInfo)
    }
  }

  return workflow
}

/**
 * Set a positional widget value on a LiteGraph node by widget name. Uses
 * objectInfo to find the index of the named widget in the node type's
 * declared input order. Returns false (without writing) when the node type —
 * per the *cached* objectInfo — doesn't have that widget, so callers can tell
 * a real write from a stale-schema no-op instead of failing silently.
 */
/**
 * The ordered list of widget names for a node type, matching the positional
 * layout of `widgets_values`. Required widgets first, then optional; ports
 * (IMAGE/MASK/LATENT…) and forced-input widgets are skipped because they don't
 * occupy a `widgets_values` slot.
 */
function orderedWidgetNames(info: any): string[] {
  const widgetNames: string[] = []
  const collect = (group: Record<string, any> | undefined) => {
    if (!group) return
    for (const [name, spec] of Object.entries(group)) {
      const specArr = Array.isArray(spec) ? spec : [spec]
      const type = specArr[0]
      const cfg = specArr[1] || {}
      // Combo widgets: legacy array-of-options OR v3 "COMBO" string. Both
      // occupy a widgets_values slot; missing the string shape skips them and
      // throws off every index after the combo.
      if (Array.isArray(type) || type === 'COMBO') {
        widgetNames.push(name)
        continue
      }
      if (cfg.forceInput) continue  // forced-port widgets aren't in widgets_values
      if (['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(String(type))) {
        widgetNames.push(name)
      }
    }
  }
  collect(info?.input?.required)
  collect(info?.input?.optional)
  return widgetNames
}

export function setNamedWidget(
  node: LiteGraphNode,
  widgetName: string,
  value: any,
  objectInfo: Record<string, any>,
): boolean {
  const info = objectInfo[node.type]
  if (!info) return false
  const idx = orderedWidgetNames(info).indexOf(widgetName)
  if (idx < 0) return false  // widget not in the (possibly stale) cached schema

  // Ensure widgets_values is an array of the right length.
  if (!Array.isArray(node.widgets_values)) node.widgets_values = []
  while (node.widgets_values.length <= idx) node.widgets_values.push(null)
  node.widgets_values[idx] = value
  return true
}

/** Read the current value of a named widget (null/undefined if unset). */
export function getNamedWidget(
  node: LiteGraphNode,
  widgetName: string,
  objectInfo: Record<string, any>,
): any {
  const info = objectInfo[node.type]
  if (!info || !Array.isArray(node.widgets_values)) return undefined
  const idx = orderedWidgetNames(info).indexOf(widgetName)
  if (idx < 0) return undefined
  return node.widgets_values[idx]
}

/**
 * Make a *displayed* artifact-image result usable as a real input.
 *
 * An `Image` artifact card can show a generated result (its `data.images`
 * preview) while having nothing wired into it and no file widget set — e.g.
 * you generated something, then wired that card into a new op. At run time the
 * backend node would see no source and emit a black 1×1 placeholder, silently
 * feeding black downstream (you upscale/restyle and get black). Yet the card
 * clearly shows an image, so this reads as a bug.
 *
 * This bridges the gap: for any `Image` node in the run that (a) has no
 * incoming link, (b) has an empty file widget, and (c) is showing a result,
 * we point its `image` widget at the shown file via ComfyUI's annotated-path
 * syntax ("name [output]" / "name [temp]"). The backend then loads exactly
 * what's on screen — what you see is what gets used. Results saved to the
 * output dir (export-on cards) resolve durably; an ephemeral temp preview that
 * was already wiped fails loudly via VALIDATE_INPUTS instead of going black.
 */
export function backfillStandaloneArtifactImages(
  workflow: LiteGraphWorkflow,
  liveNodes: any[],
  objectInfo: Record<string, any>,
): LiteGraphWorkflow {
  const cloned: LiteGraphWorkflow = JSON.parse(JSON.stringify(workflow))
  const hasIncoming = new Set<number>()
  for (const link of cloned.links || []) {
    if (Array.isArray(link) && link.length >= 4) hasIncoming.add(Number(link[3]))
  }
  const liveById = new Map<number, any>()
  for (const n of liveNodes || []) liveById.set(Number(n.id), n)

  const annotate = (url: string): string | null => {
    const q = url.split('?')[1]
    if (!q) return null
    const p = new URLSearchParams(q)
    const filename = p.get('filename')
    if (!filename) return null
    const type = p.get('type') || 'input'
    const subfolder = p.get('subfolder') || ''
    const name = subfolder ? `${subfolder}/${filename}` : filename
    // A bare name resolves to the input dir; output/temp need the annotation.
    return type && type !== 'input' ? `${name} [${type}]` : name
  }

  // Image / Video / Audio artifacts are dual save/load nodes — feed their shown
  // result into the load widget so they serialize as a leaf instead of re-running
  // upstream. (Video URL lives in data.images[0]; audio in data.audios[0].)
  const LOADERS: { type: string; widget: string; src: (d: any) => unknown }[] = [
    { type: 'Image', widget: 'image', src: d => d?.images?.[0] },
    { type: 'Video', widget: 'video', src: d => d?.images?.[0] },
    { type: 'Audio', widget: 'audio', src: d => d?.audios?.[0] },
  ]
  for (const node of (cloned.nodes as LiteGraphNode[]) || []) {
    const loader = LOADERS.find(l => l.type === (node as any).type)
    if (!loader) continue
    if (hasIncoming.has(Number(node.id))) continue        // upstream drives it
    if (getNamedWidget(node, loader.widget, objectInfo)) continue // explicit pick/lock — leave it
    const shown = loader.src(liveById.get(Number(node.id))?.data)
    if (typeof shown !== 'string') continue
    const annotated = annotate(shown)
    if (annotated) setNamedWidget(node, loader.widget, annotated, objectInfo)
  }
  return cloned
}
