/**
 * Upscale, enhance, restore and remove background (step 3, R3.5, family
 * `image-repair`): what the runner (server/runner/generators/repair.ts), the
 * rule rows (./eligibility.ts) and the price module
 * (shared/pricing/paidSettings.ts) all read about the six classes of
 * comfy_api_nodes/nodes_replicate.py:
 *
 *  - UpscaleImageNode (:4120): one of five Replicate upscalers by its engine
 *    (`_UPSCALE_SLUGS`, editSettings.ts UPSCALE_ENGINE_SLUGS);
 *  - EnhanceDetailNode (:4261): `build_enhance_input` (replicate_refs.py:387),
 *    one of three engines, in place (editSettings.ts ENHANCE_ENGINE_SLUGS);
 *  - RemoveBackgroundNode (:4347) and its hidden twin RemoveBackgroundRemoteNode
 *    (:2028): 851-labs/background-remover, `{image}`;
 *  - RestorePhotoNode (:4381) and its hidden twin RestorePhotoRemoteNode
 *    (:2062): flux-kontext-apps/restore-image, `{input_image,
 *    safety_tolerance, output_format}`.
 *
 * Upscale and Enhance detail keep their price by the picture's size
 * (editSettings.ts editCalls, the line-up's cards); the four others are
 * priced per call (paidRates.ts). Fix faces is not here: it moved whole onto
 * fal's Topaz (family `fix-faces`) and CodeFormer, with its hidden twin, was
 * removed (non-commercial licence). Pure; relative imports only.
 */
import { pyIsDigit } from './pyText'

export const BACKGROUND_REMOVER_SLUG = '851-labs/background-remover'
export const RESTORE_IMAGE_SLUG = 'flux-kontext-apps/restore-image'

/** The six classes, in the order the task lists them. */
export const REPAIR_CLASSES = [
  'UpscaleImageNode', 'EnhanceDetailNode', 'RestorePhotoNode', 'RestorePhotoRemoteNode', 'RemoveBackgroundNode', 'RemoveBackgroundRemoteNode',
] as const
export type RepairClass = typeof REPAIR_CLASSES[number]

/** The classes priced per call (each one endpoint, whatever its settings). */
export const REPAIR_PER_CALL_ENDPOINTS = {
  RestorePhotoNode: RESTORE_IMAGE_SLUG,
  RestorePhotoRemoteNode: RESTORE_IMAGE_SLUG,
  RemoveBackgroundNode: BACKGROUND_REMOVER_SLUG,
  RemoveBackgroundRemoteNode: BACKGROUND_REMOVER_SLUG,
} as const
export type RepairPerCallClass = keyof typeof REPAIR_PER_CALL_ENDPOINTS
export const REPAIR_PER_CALL_CLASSES = Object.keys(REPAIR_PER_CALL_ENDPOINTS) as RepairPerCallClass[]

/**
 * Upscale's engines (`_UPSCALE_MODELS`, the node's options, in order) and
 * Enhance detail's (`ENHANCE_ENGINES`). Literals, not read from
 * editSettings.ts (which imports eligibility.ts, which imports this: a
 * top-level read would meet an unfinished module); a test holds them to
 * editSettings.ts UPSCALE_ENGINE_SLUGS / ENHANCE_ENGINE_SLUGS, which name each one's slug.
 */
export const UPSCALE_ENGINES = ['Clarity', 'Crystal', 'Real-ESRGAN', 'Recraft Crisp', 'Topaz'] as const
export const ENHANCE_ENGINES = ['Creative', 'Faithful', 'Diffusion Refine'] as const

/** Topaz's own settings (topazlabs/image-upscale's enums, as the node offers them). */
export const TOPAZ_ENHANCE_MODELS = ['Standard V2', 'Low Resolution V2', 'CGI', 'High Fidelity V2', 'Text Refine'] as const
export const TOPAZ_UPSCALE_FACTORS = ['None', '2x', '4x', '6x'] as const
export const TOPAZ_SUBJECT_DETECTION = ['None', 'All', 'Foreground', 'Background'] as const
/** The picture formats the node offers (Topaz, Crystal, Restore). */
export const REPAIR_OUTPUT_FORMATS = ['png', 'jpg'] as const

/** Remove background's and Restore's one-option model pickers (their Python ignores the value). */
export const REMOVE_BACKGROUND_MODELS = ['851-labs/bg-remover'] as const
export const RESTORE_PHOTO_MODELS = ['Flux Kontext · Restore'] as const

/** Upscale and Enhance detail: priced by the size of the picture they are sent (the line-up's editCalls). */
export const REPAIR_SIZE_PRICED_CLASSES: readonly string[] = ['UpscaleImageNode', 'EnhanceDetailNode']

// ── Restore photo's hidden twin: its safety level as text ──

/**
 * The twin's safety level (nodes_replicate.py:2084): Python's
 * `int(s) if str(s).isdigit() else 2`. Plain digits are the number; text
 * that isn't all digits is 2. Digits Python's `isdigit()` takes that aren't
 * plain 0–9 (a superscript ², which `int()` then refuses; an Arabic-Indic
 * digit, which it reads) and a number past what JSON carries exactly are
 * refused in plain words (runner only; before the hold, requestRules.ts).
 */
export function restoreTwinSafety(s: string): number | { refused: string } {
  if (!s || ![...s].every(pyIsDigit)) return 2
  if (!/^[0-9]+$/.test(s)) return { refused: RESTORE_SAFETY_DIGITS }
  const n = Number.parseInt(s, 10)
  return Number.isSafeInteger(n) ? n : { refused: RESTORE_SAFETY_DIGITS }
}

export const RESTORE_SAFETY_DIGITS = 'Restore photo takes its safety level as a whole number in plain digits, like 2.'

/**
 * What the runner refuses in an image-repair node before the hold, from the
 * prompt as sent, or null: Restore photo's twin with a safety level it
 * can't send as Python would (restoreTwinSafety). A wired one is left alone
 * (the rule row sends a wired widget to the engine).
 */
export function repairRequestProblem(classType: string, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (classType !== 'RestorePhotoRemoteNode') return null
  const v = inputs.safety_tolerance
  if (typeof v !== 'string') return null
  const r = restoreTwinSafety(v)
  return typeof r === 'number' ? null : { input: 'safety_tolerance', message: r.refused }
}
