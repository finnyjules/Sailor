/**
 * The estimate shown BEFORE a shader-generation request runs (spec §7.2).
 * A request is SHADER_GEN_TAKES parallel takes, each one call plus the odd
 * repair; every call is metered on its own (hold, then settle real usage ×2).
 * The envelope is per call, from the stage 5 paid measurement (2026-09-27, Opus 5.5
 * at effort medium, 5 requests × 3 takes, 16 calls): input 4.5–6.0k tokens, output
 * 1.4–4.6k (median ~2.7k); 20 calls for 18 takes over 6 requests. Sets cost
 * $0.18–0.38 (36–76 credits) — the top is a set where a take needed a repair call,
 * so the top of the range allows for one. Billing settles real usage either way.
 */
import { SHADER_GEN_MODEL, SHADER_GEN_TAKES } from '../shadergen/model'
import { ANTHROPIC_USD_PER_MTOK, anthropicCallCredits } from './anthropicTokens'

export const SHADER_GEN_ENVELOPE = {
  inputTokens: [4500, 6000],
  outputTokens: [1500, 4000],
  /** calls per take: 1 at best; 1.2 allows for a repair in the set (measured 20 calls for 18 takes) */
  callsPerTake: [1, 1.2],
} as const

/** A reference picture (the look to aim for) is one more image on EVERY call of the set,
 *  sent at the product's picture size: long edge ≤ 512 px (productRequest's imageForModel).
 *  Anthropic's image-token rule (vision docs): tokens ≈ width × height / 750, so a
 *  512 × 512 picture is 349.5 → 350 input tokens at most; a non-square one is fewer. */
const REFERENCE_IMAGE_EDGE = 512
export const REFERENCE_IMAGE_TOKENS = Math.ceil((REFERENCE_IMAGE_EDGE * REFERENCE_IMAGE_EDGE) / 750)

export interface ShaderGenEstimate { usd: [number, number]; credits: [number, number] }

export function estimateShaderGen(takes: number = SHADER_GEN_TAKES, o: { reference?: boolean } = {}): ShaderGenEstimate {
  const p = ANTHROPIC_USD_PER_MTOK[SHADER_GEN_MODEL.model]!
  const extra = o.reference ? REFERENCE_IMAGE_TOKENS : 0
  const perCall = (i: 0 | 1) => ((SHADER_GEN_ENVELOPE.inputTokens[i] + extra) * p.input + SHADER_GEN_ENVELOPE.outputTokens[i] * p.output) / 1_000_000
  const calls = (i: 0 | 1) => takes * SHADER_GEN_ENVELOPE.callsPerTake[i]
  return {
    usd: [perCall(0) * calls(0), perCall(1) * calls(1)],
    credits: [Math.ceil(calls(0)) * anthropicCallCredits(perCall(0)), Math.ceil(calls(1)) * anthropicCallCredits(perCall(1))],
  }
}
