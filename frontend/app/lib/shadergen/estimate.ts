import { estimateShaderGen, type ShaderGenEstimate } from '~~/shared/pricing/shaderGenEstimate'
import { SHADER_GEN_TAKES } from '~~/shared/shadergen/model'
import { creditsText } from '~/lib/pricing'

/** "48–88 credits", locally and hosted alike: the credits the server holds and settles with
 *  (prices are credits everywhere; `hosted` no longer changes the text). */
export function shaderGenEstimateText(_hosted: boolean, e: ShaderGenEstimate = estimateShaderGen()): string {
  return creditsText(e.credits)
}

/** The price of one set, a little higher while a reference picture goes with every call. */
export function shaderGenPriceText(hosted: boolean, reference: boolean): string {
  return shaderGenEstimateText(hosted, estimateShaderGen(SHADER_GEN_TAKES, { reference }))
}
