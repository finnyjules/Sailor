import { describe, expect, it } from 'vitest'
import { buildShaderGenPayload, SHADERGEN_MAX_TOKENS } from '../../server/lib/shaderGenRequest'
import { AI_TIERS } from '../../server/lib/aiModels'
import { SHADERGEN_TAKE_SCHEMA } from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'

describe('buildShaderGenPayload', () => {
  it('defaults to the plan tier with capped effort, the cached system prompt and the take schema', () => {
    const p = buildShaderGenPayload({ prompt: 'Request: "rain"' }) as any
    expect(p.model).toBe(AI_TIERS.plan)
    expect(p.max_tokens).toBe(SHADERGEN_MAX_TOKENS)
    expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA }, effort: 'low' })
    expect(p.system).toEqual([{ type: 'text', text: SHADERGEN_SYSTEM, cache_control: { type: 'ephemeral' } }])
    expect(p.messages).toEqual([{ role: 'user', content: 'Request: "rain"' }])
  })

  it('patch tier uses Haiku and sends no effort (Haiku rejects it with a 400)', () => {
    const p = buildShaderGenPayload({ prompt: 'x', tier: 'patch' }) as any
    expect(p.model).toBe(AI_TIERS.patch)
    expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA } })
  })

  it('rejects a missing prompt and an unknown tier', () => {
    expect(() => buildShaderGenPayload({})).toThrow('prompt is required')
    expect(() => buildShaderGenPayload({ prompt: 'x', tier: 'turbo' })).toThrow("unknown tier 'turbo'")
  })
})
