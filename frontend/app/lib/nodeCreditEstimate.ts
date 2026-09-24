/**
 * Model-aware credit estimate for a node's cost badge (hosted mode).
 *
 * WHY THIS EXISTS: the badge Python ships on each node (`price_badge`) is a
 * single static USD figure. On the five model-PICKER classes that figure is a
 * fiction — GenerateVideoNode's badge quotes one price while its model widget
 * spans $0.04 (LTX) to $3.20 (Veo 3.1), an 8x divergence from what the server
 * will actually charge. A badge that reads "~7 cr" on a run that debits 480 is
 * worse than no badge, so for those five classes the badge prices from the
 * node's widgets as they are RIGHT NOW.
 *
 * ONE CALCULATION: the price is `priceNode` / `providerUsd` from
 * shared/pricing/nodePrice.ts — the same function the server's `priceGraph`
 * charges with — given the node's whole widget map. Not a mirror, the same
 * code. `priceGraph` at submit time stays authoritative (it never reads this
 * label).
 *
 * FALLS BACK, NEVER THROWS: the server FAILS CLOSED on an unknown model (it
 * refuses the graph). A badge must not — an unpriceable model returns null and
 * the caller drops back to the static regex estimate.
 */
import {
  SHARED_PRICED_CLASS_SET,
  priceNode,
  providerUsd,
  type NodeInputs,
  type PriceOptions,
} from '#shared/pricing/nodePrice'

/** Flat credits the graph pricer adds once for producing a deliverable. */
export const BASE_RENDER_CREDITS = 1

/**
 * (The name is historical: it began as the five model pickers. It now holds
 * every class the badge prices from its widgets rather than from Python's
 * static price_badge.)
 *
 * The classes whose price depends on their widgets — the server's
 * MODEL_PRICED_NODE_CLASSES (a `model` widget) and SETTING_PRICED_NODE_CLASSES
 * (the image edit tools: model, resolution, size), as a set (the badge only
 * asks "is this one?"). The badge prices these from the node's widgets, as
 * the charge does, rather than from the static Python price_badge.
 */
export const MODEL_PRICED_BADGE_CLASSES: ReadonlySet<string> = SHARED_PRICED_CLASS_SET

/**
 * Provider USD for `nodeType` as configured by `inputs` (the whole widget
 * map), or null when the class isn't model-priced / the model is missing or
 * unknown.
 */
export function modelPricedUsd(nodeType: string, inputs: NodeInputs | null | undefined): number | null {
  return providerUsd(nodeType, inputs)
}

/**
 * THE BADGE RULE for size-priced nodes (Upscale, Enhance detail, FLUX.2 edit;
 * P4 fix round 1): the badge is never below the charge. Where the canvas can
 * see the picture's size (an upstream generator's settings: costEstimate.ts
 * upstreamInputPixels, the same sourceOutputPixels the hosted gate reads) it
 * passes it as `opts.inputPixels` and the badge equals the charge. Where it
 * can't (a loaded file), the badge shows the input-cap ceiling, and the
 * charge, which reads the file's real size, may be lower.
 *
 * Total credits the graph pricer would charge for this node as configured:
 * the shared node price plus the one-off base render. Null when the estimate
 * can't be derived — the caller keeps its static badge.
 */
export function nodeCreditEstimate(nodeType: string, inputs: NodeInputs | null | undefined, opts: PriceOptions = {}): number | null {
  const price = priceNode(nodeType, inputs, opts)
  if ('refused' in price || !(price.usd > 0)) return null
  return price.credits + BASE_RENDER_CREDITS
}
