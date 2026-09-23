/**
 * Pure helpers over the API prompt the canvas builds (app/lib/graph/graphToPrompt.ts):
 * `{ [nodeId]: { class_type, inputs } }`, where an input wired to another node
 * is a link `[sourceNodeId, outputSlot]`. Used by the browser (routing) and
 * by the server (the runner). Keep this file free of imports.
 */
export type ApiLink = [string, number]
export interface ApiNode { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }
export type ApiPrompt = Record<string, ApiNode>

export const GATE_CLASS = 'ComfyGateNode'

/** Port of comfy_execution.graph_utils.is_link. */
export function isLink(v: unknown): v is ApiLink {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
}

export function linksOf(node: ApiNode | undefined): { input: string; from: string; slot: number }[] {
  const out: { input: string; from: string; slot: number }[] = []
  for (const [input, v] of Object.entries(node?.inputs ?? {})) {
    if (isLink(v)) out.push({ input, from: v[0], slot: v[1] })
  }
  return out
}

/** Distinct nodes this one reads from that exist in the prompt. */
export function dependenciesOf(prompt: ApiPrompt, nodeId: string): string[] {
  return [...new Set(linksOf(prompt[nodeId]).map(l => l.from))].filter(id => id in prompt)
}

/** Port of server.py _get_upstream_stage: everything between this Gate and
 *  the previous Gate (or the start). Other Gates are the boundary. */
export function upstreamStage(prompt: ApiPrompt, gateId: string): Set<string> {
  const upstream = new Set<string>()
  const visited = new Set<string>()
  const queue = linksOf(prompt[gateId]).map(l => l.from)
  while (queue.length) {
    const id = queue.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = prompt[id]
    if (node?.class_type === GATE_CLASS) continue
    upstream.add(id)
    for (const l of linksOf(node)) queue.push(l.from)
  }
  return upstream
}

/** Port of server.py _get_downstream_nodes. */
export function downstreamNodes(prompt: ApiPrompt, gateId: string): Set<string> {
  const downstream = new Set<string>()
  const visited = new Set<string>()
  const queue = [gateId]
  while (queue.length) {
    const id = queue.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const [otherId, node] of Object.entries(prompt)) {
      if (visited.has(otherId)) continue
      if (linksOf(node).some(l => l.from === id)) {
        downstream.add(otherId)
        queue.push(otherId)
      }
    }
  }
  return downstream
}

export interface TakeGateState {
  /** Nodes already finished (a Gate you continued past counts as finished). */
  done: ReadonlySet<string>
  /** Gates you continued past for this take. */
  open: ReadonlySet<string>
  /** Gates where this take was not picked — nothing behind them runs. */
  dropped: ReadonlySet<string>
}

/**
 * The nodes one leg will execute for one take: not finished, every input
 * either finished or produced in this same leg, and nothing behind a Gate
 * that is still closed or was dropped. A closed Gate is itself in the leg —
 * it is reached, and it pauses. A Gate with pass-through on
 * (`inputs.bypass === true`) never closes.
 */
export function legNodes(prompt: ApiPrompt, s: TakeGateState): Set<string> {
  const leg = new Set<string>()
  const closed = (id: string) =>
    prompt[id]?.class_type === GATE_CLASS && prompt[id]!.inputs?.bypass !== true && !s.open.has(id)
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(prompt)) {
      if (leg.has(id) || s.done.has(id) || s.dropped.has(id)) continue
      const ok = dependenciesOf(prompt, id).every(d =>
        (s.done.has(d) || leg.has(d)) && !s.dropped.has(d) && !closed(d))
      if (ok) { leg.add(id); changed = true }
    }
  }
  return leg
}
