/**
 * costEstimate — pure USD estimation from node price badges.
 *
 * Spans two billing modes:
 * - Replicate BYOK nodes (class names end in "RemoteNode", see
 *   comfy_api_nodes/nodes_replicate.py) declare a price_badge whose expr is
 *   either a static JSON literal (`{"type":"usd","usd":0.04,...}`) or a dynamic
 *   JSONata expression. Static parses exactly; dynamic contributes its first
 *   numeric "usd" value as a floor and marks the whole estimate approximate.
 * - Credit-billed API nodes (category starts with "api node", e.g. Kling,
 *   OpenAI) use the same badge structure as a USD-equivalent estimate for
 *   pre-run warning; post-run actual tally via credit-delta (Replicate-only).
 * Used pre-run (Run button + confirm guard) and post-run (status bar tally).
 *
 * HOSTED (opt-in, `{ hosted: true }`): the static badge is a fiction on the
 * five model-PICKER classes — GenerateVideoNode ships ONE badge figure for a
 * model range spanning $0.04 to $3.20 — so those nodes are re-priced from the
 * node's whole widget map through the one shared price calculation
 * (shared/pricing/nodePrice.ts), the one the node badge and the server charge
 * read too. The result carries `hostedCredits`, the credits figure to
 * DISPLAY: the run surfaces must
 * not re-convert it (creditsForUsd would ceil a second time and the dialog
 * would disagree with the badge it sits next to). Local mode never takes any
 * of this path — the flag is a parameter, never read from runtime config here,
 * so this module stays pure and unit-testable.
 */
import { BASE_RENDER_CREDITS } from '~/lib/nodeCreditEstimate'
import { creditsForUsd } from '~/lib/pricing'
import { priceNode } from '#shared/pricing/nodePrice'
import { sizePricedInput, sourceOutputPixels } from '#shared/pricing/editSettings'

export interface BadgeCost { usd: number; approximate: boolean }

export function parseBadgeUsd(expr: string | null | undefined): BadgeCost | null {
  if (!expr) return null
  const s = String(expr).trim()
  try {
    const parsed = JSON.parse(s)
    if (typeof parsed?.usd === 'number') {
      return { usd: parsed.usd, approximate: !!parsed?.format?.approximate }
    }
  } catch { /* not a JSON literal — fall through to the JSONata floor */ }
  const match = s.match(/"usd"\s*:\s*([0-9]+\.?[0-9]*)/)
  if (match) return { usd: parseFloat(match[1]!), approximate: true }
  return null
}

export interface EstimateInputNode {
  id: string
  type: string
  title?: string
  badgeExpr?: string | null
  category?: string | null
  /** Ordered widget definitions (Vue node `data.widgetDefs`). Carried so the
   *  hosted path can price the node from its widgets; unused in local mode. */
  widgetDefs?: { name?: string }[] | null
  /** Widget values, positionally aligned with `widgetDefs`. */
  widgetsValues?: unknown[] | null
  /** Names of the node's inputs fed by a link (see `linkedInputNames`). */
  linkedInputs?: string[] | null
  /** Size-priced nodes: the picture size the canvas can see upstream (upstreamInputPixels), else absent (the cap). */
  inputPixels?: number | null
}
export interface CostBreakdownItem { id: string; label: string; usd: number; credits?: boolean }
export interface CostEstimate {
  usd: number
  approximate: boolean
  breakdown: CostBreakdownItem[]
  /** Hosted only: the total to DISPLAY, already through the markup policy.
   *  Null/absent in local mode. Never feed this back through creditsForUsd. */
  hostedCredits?: number | null
}

/** A node's widgets as a name → value map — the input map the shared price
 *  calculation takes. widgetsValues is positional against widgetDefs, so each
 *  name is resolved by index. Unnamed defs are skipped; a name that appears
 *  twice keeps its first value (the one `widgetIndex(name)` finds). */
export function widgetValueMap(
  widgetDefs: readonly ({ name?: string } | null | undefined)[] | null | undefined,
  widgetsValues: readonly unknown[] | null | undefined,
  linkedInputs?: Iterable<string> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const defs = widgetDefs || []
  for (let i = 0; i < defs.length; i++) {
    const name = defs[i]?.name
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue
    out[name] = widgetsValues?.[i]
  }
  // A linked input wins over its widget value, as graphToPrompt does: the API
  // prompt carries a [nodeId, slot] reference there, whose value is known only
  // at run time. The shared price reads such a reference as "linked" and
  // prices it at its most expensive — so the badge marks it the same way.
  for (const name of linkedInputs ?? []) out[name] = [LINKED_INPUT_SOURCE, 0]
  return out
}

/** Stand-in origin id for a linked input in the badge's map (only its array shape matters). */
export const LINKED_INPUT_SOURCE = 'linked'

/**
 * Names of a canvas node's inputs that are fed by a link: those whose saved
 * `.link` is set, or that a live Vue Flow edge targets (`input-<index>`; Vue
 * Flow's connect only updates edges, never `.link`).
 */
export function linkedInputNames(
  nodeId: string,
  inputs: readonly ({ name?: string, link?: unknown } | null | undefined)[] | null | undefined,
  edges?: readonly ({ target?: unknown, targetHandle?: string | null } | null | undefined)[] | null,
): string[] {
  const list = inputs || []
  const idx = new Set<number>()
  for (let i = 0; i < list.length; i++) if (list[i]?.link != null) idx.add(i)
  for (const e of edges || []) {
    if (String(e?.target) !== String(nodeId)) continue
    const m = /^input-(\d+)$/.exec(e?.targetHandle ?? '')
    if (m) idx.add(Number(m[1]))
  }
  const names: string[] = []
  for (const i of [...idx].sort((a, b) => a - b)) {
    const name = list[i]?.name
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** A node bills the user in USD (Replicate BYOK) rather than Comfy credits.
 *  Most are class-named `*RemoteNode` (comfy_api_nodes/nodes_replicate.py), but
 *  the Sailor wrappers that call Replicate from comfy_extras (Person Swap,
 *  Pose Mannequin) aren't — they're caught by their `…/Replicate` category.
 *  Stock Comfy API nodes (OpenAI, Kling, …) are credit-billed and excluded. */
export function isReplicateBilled(n: EstimateInputNode): boolean {
  return !!n.type?.endsWith('RemoteNode') || /\/Replicate$/.test(n.category || '')
}

/** Stock Comfy API nodes (Kling, OpenAI, …) bill in Comfy credits. Their
 *  price_badge carries the same {"usd":N} literals, so the parsed floor doubles
 *  as a USD-equivalent estimate — approximate by nature. */
export function isApiCreditBilled(n: EstimateInputNode): boolean {
  return !isReplicateBilled(n) && (n.category || '').startsWith('api node')
}

/** Sum USD across Replicate BYOK and credit-billed API nodes in the list. Null when none are priced.
 *
 *  `opts.hosted` (default false → local mode unchanged) re-prices the five
 *  model-picker classes off their selected model and fills `hostedCredits`.
 *  Credits are summed PER NODE and only then totalled: the markup policy has a
 *  tier boundary at $0.10, so converting the summed dollars in one shot
 *  under-quotes any mix of cheap nodes ($0.10 + $0.10 → 30cr one-shot vs 40cr
 *  per node) and disagrees with the per-node badges.
 *
 *  base_render is added ONCE per run — priceGraph's semantics, since the run is
 *  one graph submit. (The per-node badge adds it per node; for a single-node
 *  run, the common case, both land on the same figure.) A run whose graph has
 *  no terminal output node would not be charged base_render at all, so this
 *  can over-quote by 1 credit — deliberate, an estimate should err high. */
export function estimateUsdForNodes(
  nodes: EstimateInputNode[],
  opts: { hosted?: boolean } = {},
): CostEstimate | null {
  const hosted = opts.hosted === true
  let usd = 0
  let approximate = false
  let credits = 0
  const breakdown: CostBreakdownItem[] = []
  for (const n of nodes) {
    const creditBilled = isApiCreditBilled(n)
    // Hosted: a model-priced picker is charged by the server whatever its
    // billing class, so price it even if the badge/category filter misses it.
    // Priced from the WHOLE widget map, the same way the server charges it.
    const shared = hosted ? priceNode(n.type, widgetValueMap(n.widgetDefs, n.widgetsValues, n.linkedInputs), { inputPixels: n.inputPixels }) : null
    const modelPrice = shared && !('refused' in shared) ? shared : null
    if (modelPrice == null && !isReplicateBilled(n) && !creditBilled) continue
    // The selected model's real price beats the static badge when we have it.
    const cost = modelPrice != null ? { usd: modelPrice.usd, approximate: true } : parseBadgeUsd(n.badgeExpr)
    if (!cost) continue
    usd += cost.usd
    // A model-priced node carries its credits from the shared calculation; a
    // static badge's USD goes through the same markup function.
    if (hosted) credits += modelPrice != null ? modelPrice.credits : creditsForUsd(cost.usd)
    approximate = approximate || cost.approximate || creditBilled
    breakdown.push({
      id: n.id,
      label: (n.title || n.type) + (creditBilled ? ' (credits)' : ''),
      usd: cost.usd,
      ...(creditBilled ? { credits: true } : {}),
    })
  }
  if (!breakdown.length) return null
  return { usd, approximate, breakdown, ...(hosted ? { hostedCredits: credits + BASE_RENDER_CREDITS } : {}) }
}

/** Adapt Vue Flow canvas nodes (ComfyNode data shape) to estimate input.
 *  The LiteGraph class name lives in data.nodeType (data.type is the Vue Flow
 *  renderer type). Disabled nodes (mode 2) are excluded — they don't run.
 *  widgetDefs/widgetsValues ride along so the hosted estimate can price the
 *  node from its widgets; local mode ignores them. `edges` (the canvas's live
 *  Vue Flow edges) mark the linked inputs, as the node badge does. */
export function vueNodesToEstimateInput(nodes: any[], edges?: any[] | null): EstimateInputNode[] {
  return (nodes || [])
    .filter((n: any) => ((n?.data?.mode ?? 0) !== 2))
    .map((n: any) => ({
      id: String(n.id),
      type: String(n?.data?.nodeType || ''),
      title: n?.data?.title,
      badgeExpr: n?.data?.priceBadge?.expr ?? null,
      category: n?.data?.category ?? null,
      widgetDefs: n?.data?.widgetDefs ?? null,
      widgetsValues: n?.data?.widgetsValues ?? null,
      linkedInputs: linkedInputNames(String(n.id), n?.data?.inputs, edges),
      inputPixels: upstreamInputPixels(n, nodes, edges),
    }))
}

/**
 * The size of the picture a size-priced canvas node (Upscale, Enhance detail,
 * FLUX.2 edit) will be sent, when the canvas can tell: the live edge into its
 * picture input comes from a GenerateImageNode whose settings say how large
 * its picture is (sourceOutputPixels — the hosted gate reads the same). Null
 * otherwise: the badge then shows the input-cap ceiling, never below the charge.
 */
export function upstreamInputPixels(node: any, nodes?: readonly any[] | null, edges?: readonly any[] | null): number | null {
  const data = node?.data
  if (!data || !nodes || !edges) return null
  const own = widgetValueMap(data.widgetDefs, data.widgetsValues, linkedInputNames(String(node.id), data.inputs, edges))
  const name = sizePricedInput(String(data.nodeType || ''), own)
  const port = name ? (data.inputs || []).findIndex((i: any) => i?.name === name) : -1
  if (port < 0) return null
  const edge = edges.find((e: any) => String(e?.target) === String(node.id) && e?.targetHandle === `input-${port}`)
  const src = edge ? nodes.find((m: any) => String(m?.id) === String(edge.source)) : null
  if (!src?.data) return null
  const srcInputs = widgetValueMap(src.data.widgetDefs, src.data.widgetsValues, linkedInputNames(String(src.id), src.data.inputs, edges))
  return sourceOutputPixels(String(src.data.nodeType || ''), srcInputs)
}
