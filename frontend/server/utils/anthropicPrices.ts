/**
 * Per-token prices for Anthropic calls that are metered from their REAL usage
 * (today: /api/shader-gen — one take is up to 10,000 output tokens, far past
 * what anthropicMeter's flat 2-credit assist charge was sized for).
 *
 * Source: Anthropic list prices (USD per million tokens), cached 2026-06-24;
 * Opus 5.5 at its launch price. `cacheWrite` is the 5-minute ephemeral
 * cache-write rate (1.25× input) — the only cache TTL these routes use.
 *
 * Policy (same as priceBook.ts / anthropicMeter.ts): 1 credit = $0.01,
 * charge 2× Sailor's cost.
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

export const ASSIST_MARKUP = 2 // Sailor charges 2× its own cost (priceBook policy)

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Characters per token used to estimate a prompt's input tokens GENEROUSLY
 *  (real English/GLSL runs nearer 4 chars per token). */
const CHARS_PER_TOKEN_ESTIMATE = 3
/** Worst-case input tokens for one attached image. */
const TOKENS_PER_IMAGE_ESTIMATE = 1600
/** System prompt + output schema overhead, estimated generously. */
const OVERHEAD_TOKENS_ESTIMATE = 2000

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** Sailor's USD cost for a call's usage; null for a model this table can't price. */
export function usdForUsage(model: string, usage: AnthropicUsage): number | null {
  const p = ANTHROPIC_USD_PER_MTOK[model]
  if (!p) return null
  return (
    count(usage?.input_tokens) * p.input
    + count(usage?.output_tokens) * p.output
    + count(usage?.cache_read_input_tokens) * p.cacheRead
    + count(usage?.cache_creation_input_tokens) * p.cacheWrite
  ) / 1_000_000
}

/** USD cost → integer credits at the markup. Never zero for a real call; the
 *  epsilon keeps an exact number of cents from rounding up on float noise. */
export function creditsForUsd(usd: number): number {
  return Math.max(1, Math.ceil(usd * ASSIST_MARKUP * 100 - 1e-9))
}

/**
 * The worst case a call can cost, for the ledger hold: input estimated
 * generously (every token at the full, uncached input rate) plus `maxTokens`
 * of output. null for an unpriced model.
 */
export function maxCreditsForCall(model: string, promptChars: number, imageCount: number, maxTokens: number): number | null {
  const p = ANTHROPIC_USD_PER_MTOK[model]
  if (!p) return null
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN_ESTIMATE)
    + imageCount * TOKENS_PER_IMAGE_ESTIMATE
    + OVERHEAD_TOKENS_ESTIMATE
  return creditsForUsd((inputTokens * p.input + maxTokens * p.output) / 1_000_000)
}
