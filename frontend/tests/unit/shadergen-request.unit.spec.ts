import { describe, expect, it } from 'vitest'
import { buildShaderGenPayload, readShaderGenReply, SHADERGEN_MAX_PROMPT_CHARS, SHADERGEN_MAX_TOKENS } from '../../server/lib/shaderGenRequest'
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

  it('allows 10000 output tokens per take', () => {
    expect(SHADERGEN_MAX_TOKENS).toBe(10_000)
  })

  it('caps the prompt at 80,000 characters', () => {
    expect(SHADERGEN_MAX_PROMPT_CHARS).toBe(80_000)
    expect(() => buildShaderGenPayload({ prompt: 'x'.repeat(80_000) })).not.toThrow()
    expect(() => buildShaderGenPayload({ prompt: 'x'.repeat(80_001) })).toThrow('prompt too long')
  })

  it('rejects a missing prompt and an unknown tier', () => {
    expect(() => buildShaderGenPayload({})).toThrow('prompt is required')
    expect(() => buildShaderGenPayload({ prompt: 'x', tier: 'turbo' })).toThrow("unknown tier 'turbo'")
  })
})

describe('readShaderGenReply', () => {
  it('returns the text, the usage and why the model stopped', () => {
    const usage = { input_tokens: 5, output_tokens: 10000, cache_read_input_tokens: 900 }
    expect(readShaderGenReply({ content: [{ type: 'text', text: '{"name":' }], usage, stop_reason: 'max_tokens' }))
      .toEqual({ text: '{"name":', usage, stop_reason: 'max_tokens' })
    expect(readShaderGenReply({ content: [{ type: 'text', text: '{}' }] })).toEqual({ text: '{}', usage: null, stop_reason: null })
  })
})
