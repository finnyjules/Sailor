import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildShaderGenPayload, meterShaderGenCall, readShaderGenReply, SHADERGEN_MAX_PROMPT_CHARS, SHADERGEN_MAX_TOKENS } from '../../server/lib/shaderGenRequest'
import { __resetMeterContextForTests, __setLedgerForTests, bindMeterContext, MeterRefusalError } from '../../server/utils/requestMeter'
import { __setSystemControlsDbForTests } from '../../server/utils/systemControls'
import { creditsForUsd, maxCreditsForCall, usdForUsage } from '../../server/utils/anthropicPrices'
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

/**
 * The route's metering (server/api/shader-gen.post.ts → meterShaderGenCall):
 * refuse an unpriced model before any hold, hold the worst case, call the
 * model, then settle to real usage — or release on a failed call.
 */
describe('meterShaderGenCall', () => {
  const KEY = 'NUXT_CLERK_SECRET_KEY'
  const savedKey = process.env[KEY]
  const MODEL = 'claude-opus-5-5'
  const prompt = 'Request: "rain"'.repeat(100)
  const img = `data:image/png;base64,${'a'.repeat(10)}`
  const payloadFor = (model = MODEL, images?: string[]) =>
    ({ ...buildShaderGenPayload({ prompt, images }), model })
  const HOLD = maxCreditsForCall(MODEL, prompt.length, 1, SHADERGEN_MAX_TOKENS)!

  let ledger: any
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env[KEY] = 'sk_test_hosted'
    __resetMeterContextForTests()
    ledger = {
      getAvailable: vi.fn(async () => 1000),
      hold: vi.fn(async () => ({ ok: true, holdId: 3 })),
      settleHold: vi.fn(async () => ({ ok: true, balance: 900, settled: true })),
      releaseHold: vi.fn(async () => {}),
      debit: vi.fn(async () => ({ ok: true })),
    }
    __setLedgerForTests(ledger)
    __setSystemControlsDbForTests({ query: async () => ({ rows: [] as any[] }) })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]
    else process.env[KEY] = savedKey
    __setLedgerForTests(null)
    __setSystemControlsDbForTests(null)
    __resetMeterContextForTests()
    errorSpy.mockRestore()
  })

  // The meter context lives in AsyncLocalStorage: bound in beforeEach it would
  // not reach the test body, so each case binds its own (as the meter specs do).
  const hosted = (name: string, fn: () => Promise<void>) =>
    it(name, async () => { bindMeterContext({ userId: 'u1' }); await fn() })

  // `call` returns the raw response body; meterShaderGenCall parses it.
  const reply = (usage?: unknown) => JSON.stringify({ content: [{ type: 'text', text: '{"name":"rain"}' }], stop_reason: 'end_turn', ...(usage ? { usage } : {}) })

  hosted('holds the worst case from the prompt, images and max tokens', async () => {
    const call = vi.fn(async () => reply({ input_tokens: 1, output_tokens: 1 }))
    await meterShaderGenCall(payloadFor(MODEL, [img]), call)
    expect(ledger.hold).toHaveBeenCalledWith('u1', HOLD, expect.stringMatching(/^anthropic:/))
    expect(ledger.hold.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0])
  })

  hosted('refuses an unpriced model with 500 before any hold or call', async () => {
    const call = vi.fn()
    const p = meterShaderGenCall(payloadFor('claude-mystery-9'), call)
    await expect(p).rejects.toBeInstanceOf(MeterRefusalError)
    await expect(meterShaderGenCall(payloadFor('claude-mystery-9'), call)).rejects.toMatchObject({
      statusCode: 500, message: 'unpriced model refused: claude-mystery-9',
    })
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  hosted('an insufficient balance refuses (402) before the model is called', async () => {
    ledger.hold.mockResolvedValue({ ok: false, reason: 'insufficient' })
    const call = vi.fn()
    await expect(meterShaderGenCall(payloadFor(), call)).rejects.toMatchObject({ statusCode: 402 })
    expect(call).not.toHaveBeenCalled()
  })

  hosted('success: settles to the real usage and returns it with the reply', async () => {
    const usage = { input_tokens: 2000, output_tokens: 3000, cache_read_input_tokens: 8000 }
    const out = await meterShaderGenCall(payloadFor(), async () => reply(usage))
    const expected = creditsForUsd(usdForUsage(MODEL, usage)!)
    expect(ledger.settleHold).toHaveBeenCalledWith(3, expected, `anthropic:${MODEL}`)
    expect(ledger.releaseHold).not.toHaveBeenCalled()
    expect(out).toEqual({ text: '{"name":"rain"}', usage, stop_reason: 'end_turn', credits: expected })
  })

  hosted('a reply without usage charges the full hold (never free)', async () => {
    const out = await meterShaderGenCall(payloadFor(), async () => reply())
    const hold = maxCreditsForCall(MODEL, prompt.length, 0, SHADERGEN_MAX_TOKENS)
    expect(ledger.settleHold).toHaveBeenCalledWith(3, hold, `anthropic:${MODEL}`)
    expect(out.credits).toBe(hold)
  })

  hosted('a failed call (model error / thrown fetch) releases the hold and rethrows the same error', async () => {
    const err = Object.assign(new Error('model error: overloaded'), { statusCode: 529 })
    await expect(meterShaderGenCall(payloadFor(), async () => { throw err })).rejects.toBe(err)
    expect(ledger.releaseHold).toHaveBeenCalledWith(3)
    expect(ledger.settleHold).not.toHaveBeenCalled()
  })

  hosted('a release that itself fails does not mask the call\'s error', async () => {
    ledger.releaseHold.mockRejectedValue(new Error('db down'))
    const err = new Error('fetch failed')
    await expect(meterShaderGenCall(payloadFor(), async () => { throw err })).rejects.toBe(err)
  })

  hosted('an empty reply (502) is still paid for: settles the usage, then rethrows', async () => {
    const usage = { input_tokens: 2000, output_tokens: 50 }
    await expect(meterShaderGenCall(payloadFor(), async () => JSON.stringify({ content: [], usage }))).rejects.toMatchObject({ statusCode: 502 })
    expect(ledger.settleHold).toHaveBeenCalledWith(3, creditsForUsd(usdForUsage(MODEL, usage)!), `anthropic:${MODEL}`)
    expect(ledger.releaseHold).not.toHaveBeenCalled()
  })

  hosted('an OK reply whose body is not JSON was still billed: charges the full hold, logs, rethrows the parse error', async () => {
    await expect(meterShaderGenCall(payloadFor(), async () => '{"content": [trunc')).rejects.toBeInstanceOf(SyntaxError)
    expect(ledger.settleHold).toHaveBeenCalledWith(3, maxCreditsForCall(MODEL, prompt.length, 0, SHADERGEN_MAX_TOKENS), `anthropic:${MODEL}`)
    expect(ledger.releaseHold).not.toHaveBeenCalled()
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).toContain('shader-gen')
    expect(logged).toContain(MODEL)
  })

  hosted('local mode: no ledger, credits null', async () => {
    delete process.env[KEY]
    const usage = { input_tokens: 1, output_tokens: 1 }
    const out = await meterShaderGenCall(payloadFor(), async () => reply(usage))
    expect(out.credits).toBeNull()
    for (const fn of Object.values(ledger)) expect(fn).not.toHaveBeenCalled()
  })
})
