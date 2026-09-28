/**
 * The user's own words a generator node sends from inside its `model_options`
 * (rule 10, G3; R3.11 fix rounds 1 and 2): Generate a video, Film a shot and
 * Generate an image forward these option fields to the provider as typed text
 * (the gallery's "Negative prompt"). One list per class, read by the builders
 * themselves (server/runner/generators/opts.ts `optText` takes only a key
 * listed here) and by moderation on both paths
 * (server/utils/graphPromptText.ts extractGraphPromptTexts: the ComfyUI path's
 * hosted meter and the runner's start of a take).
 *
 * tests/unit/runner-model-option-texts.unit.spec.ts guards the lists: every
 * option field any builder of the class sends as free text is listed, and
 * every listed field is sent.
 */
import { isLink } from './graph'

export const MODEL_OPTION_TEXT_KEYS = {
  GenerateVideoNode: ['negative_prompt'],
  FilmShotNode: ['negative_prompt'],
  GenerateImageNode: ['negative_prompt'],
} as const satisfies Readonly<Record<string, readonly string[]>>

export type ModelOptionTextClass = keyof typeof MODEL_OPTION_TEXT_KEYS
export type ModelOptionTextKey = typeof MODEL_OPTION_TEXT_KEYS[ModelOptionTextClass][number]

/** The classes whose typed `model_options` carry the user's words. */
export const MODEL_OPTION_TEXT_CLASSES: ReadonlySet<string> = new Set(Object.keys(MODEL_OPTION_TEXT_KEYS))

/**
 * An option's text as the builders read it (opts.ts optStr with a blank
 * default; Python's `_opt_str`): absent or null is none, a bool is
 * True/False, anything else its string.
 */
export function modelOptionText(adv: Record<string, unknown>, key: ModelOptionTextKey): string {
  if (!Object.prototype.hasOwnProperty.call(adv, key)) return ''
  const v = adv[key]
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * Each non-blank option text a node's typed `model_options` sends, in its
 * class's list order. The options read as the node reads them: a JSON
 * object, anything else nothing. Wired options are not read here: the
 * runner never takes them for these classes, and the ComfyUI path's meter
 * reads a wired static card's text itself (staticWiredTexts).
 */
export function modelOptionTexts(classType: string, inputs: Record<string, unknown> | null | undefined): string[] {
  if (!MODEL_OPTION_TEXT_CLASSES.has(classType) || !inputs) return []
  const raw = inputs.model_options
  if (typeof raw !== 'string' || isLink(raw) || !raw.trim()) return []
  let adv: unknown
  try { adv = JSON.parse(raw) }
  catch { return [] }
  if (!adv || typeof adv !== 'object' || Array.isArray(adv)) return []
  const keys: readonly ModelOptionTextKey[] = MODEL_OPTION_TEXT_KEYS[classType as ModelOptionTextClass]
  return keys.map(k => modelOptionText(adv as Record<string, unknown>, k)).filter(t => t.trim())
}
