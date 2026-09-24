import { describe, expect, it } from 'vitest'
import { buildShaderGenPayload, readShaderGenReply, SHADERGEN_MAX_PROMPT_CHARS, SHADERGEN_MAX_TOKENS } from '../../server/lib/shaderGenRequest'
import { AI_TIERS, DEV_MODEL_OVERRIDES } from '../../server/lib/aiModels'
import { MAX_IMAGE_CHARS } from '../../server/lib/agentRequest'
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

  describe('effort', () => {
    it('high replaces the tier effort on plan', () => {
      const p = buildShaderGenPayload({ prompt: 'x', tier: 'plan', effort: 'high' }) as any
      expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA }, effort: 'high' })
    })

    it('rejects any value other than high', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', effort: 'low' })).toThrow("effort must be 'high' when set")
    })

    it('is rejected on the patch tier (Haiku rejects effort)', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', tier: 'patch', effort: 'high' })).toThrow("effort can't be set on the patch tier")
    })

    it('reports the patch-tier reason (not the generic one) when both are wrong at once', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', tier: 'patch', effort: 'low' })).toThrow("effort can't be set on the patch tier")
    })
  })

  describe('model override', () => {
    it('is used only when allowModelOverride is true', () => {
      const p = buildShaderGenPayload({ prompt: 'x', model: 'opus' }, { allowModelOverride: true }) as any
      expect(p.model).toBe(DEV_MODEL_OVERRIDES.opus)
    })

    it('throws a 403 when overrides are not allowed', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', model: 'opus' })).toThrow('Model overrides are only available on a local dev server')
      try {
        buildShaderGenPayload({ prompt: 'x', model: 'opus' })
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as any).statusCode).toBe(403)
      }
    })

    it('rejects an unknown model value', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', model: 'gpt5' }, { allowModelOverride: true })).toThrow()
    })
  })

  describe('images', () => {
    const img = (n = 10) => `data:image/png;base64,${'a'.repeat(n)}`

    it('become image blocks before the text', () => {
      const p = buildShaderGenPayload({ prompt: 'Request: "rain"', images: [img()] }) as any
      expect(p.messages).toEqual([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(10) } },
          { type: 'text', text: 'Request: "rain"' },
        ],
      }])
    })

    it('allows up to 2 images', () => {
      const p = buildShaderGenPayload({ prompt: 'x', images: [img(), img(5)] }) as any
      expect(p.messages[0].content).toHaveLength(3)
    })

    it('rejects 3 images', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', images: [img(), img(), img()] })).toThrow()
    })

    it('rejects a non-data-URL image', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', images: ['not-a-data-url'] })).toThrow()
    })

    it('rejects an image longer than MAX_IMAGE_CHARS', () => {
      expect(() => buildShaderGenPayload({ prompt: 'x', images: [img(MAX_IMAGE_CHARS + 1)] })).toThrow()
    })
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
