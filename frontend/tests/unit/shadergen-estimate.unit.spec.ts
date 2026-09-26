import { describe, it, expect } from 'vitest'
import { SHADER_GEN_MODEL, SHADER_GEN_TAKES } from '~~/shared/shadergen/model'
import { ANTHROPIC_USD_PER_MTOK, anthropicCallCredits } from '~~/shared/pricing/anthropicTokens'
import { estimateShaderGen, REFERENCE_IMAGE_TOKENS, SHADER_GEN_ENVELOPE } from '~~/shared/pricing/shaderGenEstimate'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
import * as serverPrices from '../../server/utils/anthropicPrices'

describe('shader generation setting', () => {
  it('is Opus 5.5 at medium effort, three takes (spec §7.2)', () => {
    expect(SHADER_GEN_MODEL).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
    expect(SHADER_GEN_TAKES).toBe(3)
  })
  it('is priced in the one shared table the server settles with', () => {
    expect(ANTHROPIC_USD_PER_MTOK[SHADER_GEN_MODEL.model]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(serverPrices.ANTHROPIC_USD_PER_MTOK).toBe(ANTHROPIC_USD_PER_MTOK)
    expect(serverPrices.creditsForUsd).toBe(anthropicCallCredits)
  })
})

describe('estimateShaderGen', () => {
  it('reproduces spec §7.2’s 25–40¢ from the token envelope', () => {
    const e = estimateShaderGen()
    expect(e.usd[0]).toBeCloseTo(0.24, 4)   // 3 × (5k in × $4 + 3k out × $20) / 1M
    expect(e.usd[1]).toBeCloseTo(0.4212, 4) // 3 × 1.3 × (7k × $4 + 4k × $20) / 1M
    expect(e.credits).toEqual([48, 88])     // per call ×2, rounded up per call; 4 calls at the top end
  })
  it('scales with the take count', () => {
    expect(estimateShaderGen(1).usd[0]).toBeCloseTo(0.08, 4)
  })
  it('has an envelope of plain numbers (replaced after the owed measurement)', () => {
    expect(SHADER_GEN_ENVELOPE.inputTokens).toEqual([5000, 7000])
    expect(SHADER_GEN_ENVELOPE.outputTokens).toEqual([3000, 4000])
  })
})

describe('estimateShaderGen with a reference picture', () => {
  it('a 512 px picture is 350 input tokens by the image-token rule (w × h / 750)', () => {
    expect(REFERENCE_IMAGE_TOKENS).toBe(350)
  })
  it('adds the picture to every call', () => {
    const e = estimateShaderGen(SHADER_GEN_TAKES, { reference: true })
    expect(e.usd[0]).toBeCloseTo(3 * (5350 * 4 + 3000 * 20) / 1e6, 6)
    expect(e.usd[1]).toBeCloseTo(3 * 1.3 * (7350 * 4 + 4000 * 20) / 1e6, 6)
    expect(e.credits).toEqual([51, 88])
    expect(estimateShaderGen(SHADER_GEN_TAKES, { reference: false })).toEqual(estimateShaderGen())
  })
})

describe('shaderGenEstimateText', () => {
  it('credits locally and hosted alike', () => {
    expect(shaderGenEstimateText(false)).toBe('48–88 credits')
    expect(shaderGenEstimateText(true)).toBe('48–88 credits')
  })
  it('higher with a reference picture', () => {
    expect(shaderGenEstimateText(false, estimateShaderGen(SHADER_GEN_TAKES, { reference: true }))).toBe('51–88 credits')
    expect(shaderGenEstimateText(true, estimateShaderGen(SHADER_GEN_TAKES, { reference: true }))).toBe('51–88 credits')
  })
})

describe('creditsText', () => {
  it('says credits in words: singular, plural, a range, about, from — never a "~" or a "$"', async () => {
    const { creditsText, usdAsCreditsText } = await import('~/lib/pricing')
    expect(creditsText(1)).toBe('1 credit')
    expect(creditsText(2)).toBe('2 credits')
    expect(creditsText([48, 88])).toBe('48–88 credits')
    expect(creditsText([6, 6])).toBe('6 credits')
    expect(creditsText(24, { approximate: true })).toBe('about 24 credits')
    expect(creditsText(240, { from: true })).toBe('from 240 credits')
    expect(usdAsCreditsText(0.12, { approximate: true })).toBe('about 18 credits') // the server's markup (1.5× above $0.10)
  })
})
