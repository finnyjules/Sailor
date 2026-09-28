/**
 * The user's own words a video node sends from inside its `model_options`
 * (R3.11 fix round 1, rule 10): Generate a video and Film a shot forward
 * these option fields to the provider as typed text (the gallery's "Negative
 * prompt"). One list, read by the builders themselves (server/runner/generators/
 * opts.ts `optText` takes only a key listed here) and by moderation on both
 * paths (server/utils/graphPromptText.ts extractGraphPromptTexts: the ComfyUI
 * path's hosted meter and the runner's start of a take).
 *
 * tests/unit/runner-video-option-texts.unit.spec.ts guards the list: every
 * option field any video builder sends as free text is here, and every field
 * here is sent.
 */
import { isLink } from './graph'

export const VIDEO_OPTION_TEXT_KEYS = ['negative_prompt'] as const
export type VideoOptionTextKey = typeof VIDEO_OPTION_TEXT_KEYS[number]

/** The classes whose `model_options` a video builder reads. */
export const VIDEO_OPTION_TEXT_CLASSES: ReadonlySet<string> = new Set(['GenerateVideoNode', 'FilmShotNode'])

/**
 * An option's text as the builders read it (opts.ts optStr with a blank
 * default; Python's `_opt_str`): absent or null is none, a bool is
 * True/False, anything else its string.
 */
export function videoOptionText(adv: Record<string, unknown>, key: VideoOptionTextKey): string {
  if (!Object.prototype.hasOwnProperty.call(adv, key)) return ''
  const v = adv[key]
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * Each non-blank option text a video node's typed `model_options` sends, in
 * the list's order. The options read as the node reads them: a JSON object,
 * anything else nothing. Wired options are not read here (the runner never
 * takes them for these classes).
 */
export function videoOptionTexts(classType: string, inputs: Record<string, unknown> | null | undefined): string[] {
  if (!VIDEO_OPTION_TEXT_CLASSES.has(classType) || !inputs) return []
  const raw = inputs.model_options
  if (typeof raw !== 'string' || isLink(raw) || !raw.trim()) return []
  let adv: unknown
  try { adv = JSON.parse(raw) }
  catch { return [] }
  if (!adv || typeof adv !== 'object' || Array.isArray(adv)) return []
  return VIDEO_OPTION_TEXT_KEYS.map(k => videoOptionText(adv as Record<string, unknown>, k)).filter(t => t.trim())
}
