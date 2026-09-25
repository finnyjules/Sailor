import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRouterPayload, meterRouterCall, readRouterInput } from '../../server/lib/promptRouterRequest'
import { __resetMeterContextForTests, __setLedgerForTests, bindMeterContext, MeterRefusalError } from '../../server/utils/requestMeter'
import { __setSystemControlsDbForTests } from '../../server/utils/systemControls'
import { creditsForUsd, maxCreditsForCall, usdForUsage } from '../../server/utils/anthropicPrices'
import { AI_TIERS } from '../../server/lib/aiModels'
import { NITRO_API_PATHS } from '../../server/lib/nitroApiPaths'
import { ROUTER_MAX_TOKENS, ROUTER_SCHEMA, ROUTER_SYSTEM } from '~~/shared/promptRouter/router'

const input = { request: 'what does this do?', host: 'canvas' as const, selection: [{ kind: 'artifact-image', name: 'Rainy shop' }], mode: null }

describe('readRouterInput', () => {
  it('reads a full body and defaults the host to canvas', () => {
    expect(readRouterInput({ request: 'hi', selection: [{ kind: 'k', name: 'n' }], mode: 'Tune' }))
      .toEqual({ request: 'hi', host: 'canvas', selection: [{ kind: 'k', name: 'n' }], mode: 'Tune' })
    expect(readRouterInput({ request: 'hi' })).toEqual({ request: 'hi', host: 'canvas', selection: [], mode: null })
  })
  it('rejects a missing or long request, an unknown host, and a bad selection', () => {
    expect(() => readRouterInput({})).toThrow('request is required')
    expect(() => readRouterInput({ request: 'x'.repeat(4001) })).toThrow('request too long')
    expect(() => readRouterInput({ request: 'x', host: 'moon' })).toThrow("unknown host 'moon'")
    expect(() => readRouterInput({ request: 'x', selection: 'no' })).toThrow('selection must be an array of at most 20 items')
    expect(() => readRouterInput({ request: 'x', selection: Array.from({ length: 21 }, () => ({ kind: 'k', name: 'n' })) })).toThrow('at most 20')
    expect(() => readRouterInput({ request: 'x', selection: [{ kind: 'k' }] })).toThrow('selection.name is required')
  })
})

describe('buildRouterPayload', () => {
  it('uses Haiku (patch tier), the router schema, no effort, and a small output cap', () => {
    const p = buildRouterPayload(input)
    expect(p.model).toBe(AI_TIERS.patch)
    expect(p.max_tokens).toBe(ROUTER_MAX_TOKENS)
    expect(p.system).toBe(ROUTER_SYSTEM)
    expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: ROUTER_SCHEMA } }) // Haiku 400s on effort
    expect(p.messages[0].role).toBe('user')
    expect(p.messages[0].content).toContain('"""what does this do?"""')
  })
  it('is reachable (listed for Nitro, not proxied to ComfyUI)', () => {
    expect(NITRO_API_PATHS).toContain('/api/prompt-route')
  })
})

describe('meterRouterCall', () => {
  const KEY = 'NUXT_CLERK_SECRET_KEY'
  const savedKey = process.env[KEY]
  const payload = buildRouterPayload(input)
  const promptChars = payload.messages[0].content.length + ROUTER_SYSTEM.length
  const HOLD = maxCreditsForCall(AI_TIERS.patch, promptChars, 0, ROUTER_MAX_TOKENS)!
  const reply = (text: string, usage?: unknown) => JSON.stringify({ content: [{ type: 'text', text }], ...(usage ? { usage } : {}) })
  let ledger: any
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env[KEY] = 'sk_test_hosted'
    __resetMeterContextForTests()
    ledger = {
      getAvailable: vi.fn(async () => 1000),
      hold: vi.fn(async () => ({ ok: true, holdId: 7 })),
      settleHold: vi.fn(async () => ({ ok: true, balance: 999, settled: true })),
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
  const hosted = (name: string, fn: () => Promise<void>) => it(name, async () => { bindMeterContext({ userId: 'u1' }); await fn() })

  hosted('holds the worst case before calling, then settles to real usage and returns the parsed kind', async () => {
    const usage = { input_tokens: 900, output_tokens: 20 }
    const call = vi.fn(async () => reply('{"kind":"answer","followUps":["Lower glass blur"]}', usage))
    const out = await meterRouterCall(payload, call)
    expect(ledger.hold).toHaveBeenCalledWith('u1', HOLD, expect.stringMatching(/^anthropic:/))
    expect(ledger.hold.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0])
    const expected = creditsForUsd(usdForUsage(AI_TIERS.patch, usage)!)
    expect(ledger.settleHold).toHaveBeenCalledWith(7, expected, `anthropic:${AI_TIERS.patch}`)
    expect(out).toEqual({ kind: 'answer', followUps: ['Lower glass blur'], credits: expected })
  })

  hosted('refuses an unpriced model before any hold or call', async () => {
    const call = vi.fn()
    await expect(meterRouterCall({ ...payload, model: 'claude-mystery-9' }, call)).rejects.toBeInstanceOf(MeterRefusalError)
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  hosted('a failed call releases the hold and rethrows the same error', async () => {
    const err = Object.assign(new Error('model error: overloaded'), { statusCode: 529 })
    await expect(meterRouterCall(payload, async () => { throw err })).rejects.toBe(err)
    expect(ledger.releaseHold).toHaveBeenCalledWith(7)
    expect(ledger.settleHold).not.toHaveBeenCalled()
  })

  hosted('an OK reply that is not JSON is charged the full hold, then rethrows', async () => {
    await expect(meterRouterCall(payload, async () => 'garbage')).rejects.toThrow()
    expect(ledger.settleHold).toHaveBeenCalledWith(7, HOLD, `anthropic:${AI_TIERS.patch}`)
  })

  hosted('an unreadable model answer still settles, and parses to plan', async () => {
    const out = await meterRouterCall(payload, async () => reply('not json at all', { input_tokens: 10, output_tokens: 5 }))
    expect(out.kind).toBe('plan')
    expect(ledger.settleHold).toHaveBeenCalled()
  })

  it('local mode: no ledger, credits null', async () => {
    delete process.env[KEY]
    const out = await meterRouterCall(payload, async () => reply('{"kind":"fix","followUps":[]}'))
    expect(out).toEqual({ kind: 'fix', followUps: [], credits: null })
    expect(ledger.hold).not.toHaveBeenCalled()
  })
})
