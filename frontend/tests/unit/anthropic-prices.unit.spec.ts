/**
 * Token prices for the Anthropic calls that are metered per call from real
 * usage (today: /api/shader-gen). 1 credit = $0.01, charged at 2× Sailor's cost.
 */
import { describe, expect, it } from 'vitest'
import { ANTHROPIC_USD_PER_MTOK, ASSIST_MARKUP, creditsForUsd, maxCreditsForCall, usdForUsage } from '../../server/utils/anthropicPrices'
import { AI_TIERS, DEV_MODEL_OVERRIDES } from '../../server/lib/aiModels'

describe('ANTHROPIC_USD_PER_MTOK', () => {
  it('prices every model /api/shader-gen can call', () => {
    for (const model of [...Object.values(AI_TIERS), ...Object.values(DEV_MODEL_OVERRIDES)]) {
      expect(ANTHROPIC_USD_PER_MTOK[model], model).toBeDefined()
    }
  })

  it('has the list prices (cache write = 1.25× input)', () => {
    expect(ANTHROPIC_USD_PER_MTOK['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(ANTHROPIC_USD_PER_MTOK['claude-opus-5']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(ANTHROPIC_USD_PER_MTOK['claude-sonnet-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
    expect(ANTHROPIC_USD_PER_MTOK['claude-haiku-4-5']).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
  })

  it('markup is 2×', () => {
    expect(ASSIST_MARKUP).toBe(2)
  })
})

describe('usdForUsage', () => {
  it('charges each token kind at its own rate', () => {
    const M = 1_000_000
    expect(usdForUsage('claude-opus-5-5', { input_tokens: M })).toBeCloseTo(4, 10)
    expect(usdForUsage('claude-opus-5-5', { output_tokens: M })).toBeCloseTo(20, 10)
    expect(usdForUsage('claude-opus-5-5', { cache_read_input_tokens: M })).toBeCloseTo(0.2, 10)
    expect(usdForUsage('claude-opus-5-5', { cache_creation_input_tokens: M })).toBeCloseTo(5, 10)
  })

  it('sums all four fields', () => {
    const usd = usdForUsage('claude-sonnet-5', {
      input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 4000,
    })
    expect(usd).toBeCloseTo((1000 * 2 + 2000 * 10 + 3000 * 0.2 + 4000 * 2.5) / 1_000_000, 12)
  })

  it('missing fields count as zero', () => {
    expect(usdForUsage('claude-haiku-4-5', {})).toBe(0)
  })

  it('is null for an unknown model', () => {
    expect(usdForUsage('claude-mystery-9', { input_tokens: 10 })).toBeNull()
  })
})

describe('creditsForUsd', () => {
  it('never charges zero for a real call', () => {
    expect(creditsForUsd(0.0049)).toBe(1)
    expect(creditsForUsd(0)).toBe(1)
  })

  it('exact cents do not round up from float noise', () => {
    expect(creditsForUsd(0.25)).toBe(50)
  })

  it('rounds any fraction of a credit up', () => {
    expect(creditsForUsd(0.2501)).toBe(51)
  })
})

describe('maxCreditsForCall', () => {
  it('Opus 5.5, 40,000-char prompt, 1 image, 10,000 max tokens', () => {
    // Worst-case input: ceil(chars / 3) + 1600 per image + 2000 overhead (system prompt + schema).
    const inputTokens = Math.ceil(40_000 / 3) + 1 * 1600 + 2000 // 16,934
    const usd = (inputTokens * 4 + 10_000 * 20) / 1_000_000 // $0.267736
    const expected = Math.ceil(usd * 2 * 100) // 54
    expect(expected).toBe(54)
    expect(maxCreditsForCall('claude-opus-5-5', 40_000, 1, 10_000)).toBe(expected)
  })

  it('is null for an unknown model', () => {
    expect(maxCreditsForCall('claude-mystery-9', 10, 0, 100)).toBeNull()
  })
})
