/**
 * Payload for one /api/shader-gen call: one take, strict JSON (the shared take
 * schema), the static system prompt as a cached block. Kept out of the route so
 * it is unit-testable without h3 (same pattern as agentRequest.ts).
 */
import { SHADERGEN_TAKE_SCHEMA } from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { effortForTier, modelForTier } from './aiModels'
import { optionalTier, requireString } from './agentRequest'
import { extractModelText } from './modelText'

/** One take: ~1–3k tokens of GLSL + dials, with generous headroom so a long
 *  body isn't cut off mid-JSON. */
export const SHADERGEN_MAX_TOKENS = 10_000
/** A take prompt is the request, at most a base and a few references, and one
 *  rejected body — far below the general agent cap. */
export const SHADERGEN_MAX_PROMPT_CHARS = 80_000

export function buildShaderGenPayload(body: { tier?: unknown; prompt?: unknown }): Record<string, unknown> {
  const prompt = requireString(body?.prompt, 'prompt', SHADERGEN_MAX_PROMPT_CHARS)
  const tier = optionalTier(body?.tier) ?? 'plan'
  const effort = effortForTier(tier)
  return {
    model: modelForTier(tier),
    max_tokens: SHADERGEN_MAX_TOKENS,
    system: [{ type: 'text', text: SHADERGEN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: {
      format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA },
      ...(effort ? { effort } : {}),
    },
    messages: [{ role: 'user', content: prompt }],
  }
}

/** What the route returns: the reply text, the raw usage (cache counts included)
 *  and why the model stopped ('max_tokens' means the reply was cut off). */
export function readShaderGenReply(json: any): { text: string; usage: Record<string, number> | null; stop_reason: string | null } {
  return { text: extractModelText(json), usage: json?.usage ?? null, stop_reason: json?.stop_reason ?? null }
}
