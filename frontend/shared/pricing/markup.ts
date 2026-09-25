/**
 * The house markup — the ONE place provider USD turns into credits
 * (1 credit = $0.01). The server charge (server/utils/priceBook.ts, as
 * `creditsForUsdServer`), the node badge and the run estimate
 * (app/lib/pricing.ts re-exports this) all read this function.
 *
 * Policy: 2× on a provider cost up to $0.10, 1.5× above, never below 1 credit,
 * applied per node. A cost of 0 or less (or not a number) is 0 credits.
 *
 * Binary float noise is dropped before rounding up: 0.035 × 200 is
 * 7.000000000000001 in floating point, and must charge 7 credits, not 8. The
 * price is read to the nano-dollar and the credits to the micro-credit
 * ($0.00000001), so any real fraction of a credit still rounds up.
 *
 * A guard in price-graph.unit.spec.ts fails if the markup is re-implemented
 * anywhere outside frontend/shared/pricing/.
 *
 * Model calls metered by the token (Anthropic) use their own flat markup instead:
 * `anthropicCallCredits` in shared/pricing/anthropicTokens.ts.
 */
export function creditsForUsd(usd: number): number {
  if (!(usd > 0)) return 0
  const price = Math.round(usd * 1e9) / 1e9
  const markup = price <= 0.10 ? 2 : 1.5
  const credits = Math.round(price * 100 * markup * 1e6) / 1e6
  return Math.max(1, Math.ceil(credits))
}

/**
 * The provider price whose marked-up credits equal `usd` charged at cost (no
 * markup) — for a rarely-taken fallback that must never be charged below what
 * it costs, but should not carry the house markup either. The inverse of the
 * policy above: half the cost up to a $0.10 price, two thirds of it above.
 */
export function usdChargedAtCost(usd: number): number {
  if (!(usd > 0)) return 0
  const half = usd / 2
  const price = half <= 0.10 ? half : usd / 1.5
  // Rounded DOWN to 1e-8: creditsForUsd rounds its credits up, so this can
  // only drop float noise, never land a credit above the cost.
  return Math.floor(price * 1e8) / 1e8
}
