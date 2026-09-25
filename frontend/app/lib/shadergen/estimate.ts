import { estimateShaderGen, type ShaderGenEstimate } from '~~/shared/pricing/shaderGenEstimate'

/** "~$0.24–0.42" locally (the operator's own spend), "~48–88 cr" hosted. */
export function shaderGenEstimateText(hosted: boolean, e: ShaderGenEstimate = estimateShaderGen()): string {
  return hosted ? `~${e.credits[0]}–${e.credits[1]} cr` : `~$${e.usd[0].toFixed(2)}–${e.usd[1].toFixed(2)}`
}
