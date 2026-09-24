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
 */
export function creditsForUsd(usd: number): number {
  if (!(usd > 0)) return 0
  const price = Math.round(usd * 1e9) / 1e9
  const markup = price <= 0.10 ? 2 : 1.5
  const credits = Math.round(price * 100 * markup * 1e6) / 1e6
  return Math.max(1, Math.ceil(credits))
}
