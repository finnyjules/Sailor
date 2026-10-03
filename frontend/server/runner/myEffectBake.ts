/**
 * LC13: a Shader effect showing one of your own effects (a My effect,
 * `mine_…~vN`), replayed from the browser's bake like any other Shader effect
 * (cards/shaderEffect.ts). The browser draws it as the canvas does, with the
 * code and dials of that version, and names their digest in the bake
 * (`sailor_baked.source`, covered by the key: #shared/runner/shaderBakeKey.ts).
 * Here, before the hold, that digest is checked against the My effects store:
 * the record must be the person's own (hosted: the owner registry; locally
 * every record, as /api/my-effects shows them), its version must carry the
 * code the digest names, and an effect that isn't generative needs a picture.
 *
 * The server never compiles or runs the effect's code. It reads the stored
 * body as text, assembles it with the shared preamble (string concatenation:
 * #shared/shadergen/contract.ts assembleSource) and hashes it. The code only
 * ever runs in the person's own browser, in its WebGL sandbox.
 */
import { assembleSource } from '#shared/shadergen/contract'
import type { MyEffectRecord } from '#shared/myEffects/record'
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { SHADER_ENGINE_WORDS, SHADER_MY_EFFECT_WORDS, myEffectRefOf, myEffectSourceDigest, parseShaderBaked } from '#shared/runner/shaderBakeKey'

/** Reads a My effect for the person running (null: not there, or not theirs). */
export type ReadMyEffect = (id: string) => Promise<MyEffectRecord | null>

/** The digest of a stored version's code and dials (null: no code at that version). Text only: nothing is compiled. */
export function myEffectRecordDigest(rec: MyEffectRecord, codeIndex: number): string | null {
  const v = rec.versions[codeIndex]
  if (!v || v.body === undefined) return null
  return myEffectSourceDigest(assembleSource(v.body), v.params ?? [])
}

/**
 * Why this baked Shader effect's My effect can't run (plain words), or null:
 * not a My effect, not baked, or the store agrees with its bake.
 */
export async function myEffectBakeProblem(prompt: ApiPrompt, nodeId: string, read: ReadMyEffect): Promise<string | null> {
  const inputs = prompt[nodeId]?.inputs ?? {}
  const ref = myEffectRefOf(inputs.effect)
  if (!ref) return null
  const baked = parseShaderBaked(inputs.sailor_baked)
  if (!baked) return null
  // A store that can't be read (its registry down) fails the start as an error, never as "not yours".
  const rec = await read(ref.id)
  if (!rec || rec.id !== ref.id) return SHADER_MY_EFFECT_WORDS.missing
  const digest = myEffectRecordDigest(rec, ref.codeIndex)
  if (!digest || digest !== baked.source) return SHADER_MY_EFFECT_WORDS.changed
  // Python's rule for a catalogue effect, held to the effect's own flag: with no picture, only one that makes its own.
  if (!isLink(inputs.image) && !rec.generative) return SHADER_ENGINE_WORDS.needsPicture
  return null
}
