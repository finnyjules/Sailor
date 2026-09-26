/**
 * Per-token prices for Anthropic calls metered from their REAL usage
 * (/api/shader-gen, /api/prompt-route). Moved here from
 * server/utils/anthropicPrices.ts so the client's shader-generation estimate
 * reads the numbers the server settles with. Anthropic list prices (USD per
 * million tokens), cached 2026-06-24; Opus 5.5 at its launch price.
 * `cacheWrite` is the 5-minute ephemeral rate (1.25× input).
 * Policy: 1 credit = $0.01, each call charged at 2× Sailor's cost.
 */
// NOTE: no commas in trailing comments on `export const` lines — mlly's regex
// export scanner splits declarations on commas (see priceBook.ts).

export interface AnthropicTokenPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

export const ANTHROPIC_USD_PER_MTOK: Record<string, AnthropicTokenPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export const ASSIST_MARKUP = 2

/** The flat charge for one short "assist" call (/api/vibe and its siblings) in hosted mode:
 *  server/utils/anthropicMeter.ts debits exactly this. Shared so the client can quote it. */
export const ASSIST_CALL_CREDITS = 2
/** What one assist call costs the operator locally: a Haiku call of at most 2048 tokens out,
 *  about a cent. An estimate for the badge, never a charge. */
export const ASSIST_CALL_USD = 0.01

/** One call's USD cost → integer credits at the markup. Never zero for a real
 *  call; the epsilon keeps an exact number of cents from rounding up on float noise. */
export function anthropicCallCredits(usd: number): number {
  return Math.max(1, Math.ceil(usd * ASSIST_MARKUP * 100 - 1e-9))
}
