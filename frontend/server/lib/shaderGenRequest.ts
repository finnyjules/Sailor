/**
 * Payload for one /api/shader-gen call: one take, strict JSON (the shared take
 * schema), the static system prompt as a cached block. Kept out of the route so
 * it is unit-testable without h3 (same pattern as agentRequest.ts).
 */
import { SHADERGEN_TAKE_SCHEMA } from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { effortForTier, modelForTier } from './aiModels'
import { MAX_PROMPT_CHARS, optionalTier, requireString } from './agentRequest'

/** One take: ~1–3k tokens of GLSL + dials, with headroom. */
export const SHADERGEN_MAX_TOKENS = 6000

export function buildShaderGenPayload(body: { tier?: unknown; prompt?: unknown }): Record<string, unknown> {
  const prompt = requireString(body?.prompt, 'prompt', MAX_PROMPT_CHARS)
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
