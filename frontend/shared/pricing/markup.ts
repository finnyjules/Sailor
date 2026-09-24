/**
 * The house markup — the ONE place provider USD turns into credits
 * (1 credit = $0.01). The server charge (server/utils/priceBook.ts, as
 * `creditsForUsdServer`), the node badge and the run estimate
 * (app/lib/pricing.ts re-exports this) all read this function.
 *
 * Policy: 2× on a provider cost up to $0.10, 1.5× above, never below 1 credit,
 * applied per node. A cost of 0 or less (or not a number) is 0 credits.
 *
 * A guard in price-graph.unit.spec.ts fails if the markup is re-implemented
 * anywhere outside frontend/shared/pricing/.
 */
export function creditsForUsd(usd: number): number {
  if (!(usd > 0)) return 0
  const markup = usd <= 0.10 ? 2 : 1.5
  return Math.max(1, Math.ceil(usd * 100 * markup))
}
