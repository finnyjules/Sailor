/**
 * Per-token prices for Anthropic calls that are metered from their REAL usage
 * (today: /api/shader-gen — one take is up to 10,000 output tokens, far past
 * what anthropicMeter's flat 2-credit assist charge was sized for).
 *
 * The table, markup and per-call credit function live in
 * shared/pricing/anthropicTokens.ts so the client's shader-generation
 * estimate reads the exact numbers this server settles with. Re-exported here
 * so every existing caller of this module keeps working unchanged.
 */
import { ANTHROPIC_USD_PER_MTOK, ASSIST_MARKUP, anthropicCallCredits, type AnthropicTokenPrice } from '../../shared/pricing/anthropicTokens'

export { ANTHROPIC_USD_PER_MTOK, ASSIST_MARKUP, type AnthropicTokenPrice }
export const creditsForUsd = anthropicCallCredits

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
