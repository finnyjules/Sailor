/**
 * The estimate shown BEFORE a shader-generation request runs (spec §7.2).
 * A request is SHADER_GEN_TAKES parallel takes, each one call plus the odd
 * repair; every call is metered on its own (hold, then settle real usage ×2).
 * The envelope is per take and reproduces the spec's 25–40¢ until the stage 5
 * paid measurement (owed) replaces these four numbers with measured ones.
 */
import { SHADER_GEN_MODEL, SHADER_GEN_TAKES } from '../shadergen/model'
import { ANTHROPIC_USD_PER_MTOK, anthropicCallCredits } from './anthropicTokens'

export const SHADER_GEN_ENVELOPE = {
  inputTokens: [5000, 7000],
  outputTokens: [3000, 4000],
  /** calls per take: 1 at best; 1.3 with typical repairs (spec §7.2) */
  callsPerTake: [1, 1.3],
} as const

export interface ShaderGenEstimate { usd: [number, number]; credits: [number, number] }

export function estimateShaderGen(takes: number = SHADER_GEN_TAKES): ShaderGenEstimate {
  const p = ANTHROPIC_USD_PER_MTOK[SHADER_GEN_MODEL.model]!
  const perCall = (i: 0 | 1) => (SHADER_GEN_ENVELOPE.inputTokens[i] * p.input + SHADER_GEN_ENVELOPE.outputTokens[i] * p.output) / 1_000_000
  const calls = (i: 0 | 1) => takes * SHADER_GEN_ENVELOPE.callsPerTake[i]
  return {
    usd: [perCall(0) * calls(0), perCall(1) * calls(1)],
    credits: [Math.ceil(calls(0)) * anthropicCallCredits(perCall(0)), Math.ceil(calls(1)) * anthropicCallCredits(perCall(1))],
  }
}
