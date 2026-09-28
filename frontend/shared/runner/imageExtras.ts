/**
 * Text effect, sketch to image and face references (step 3, R3.12, family
 * `image-extras`): what the runner (server/runner/generators/textEffects.ts
 * and imageExtras.ts), the rule rows (./eligibility.ts) and the price module
 * (shared/pricing/paidSettings.ts) all read about the three classes of
 * comfy_api_nodes/nodes_replicate.py:
 *
 *  - TextEffectNode (:3638-3713, text_effects.py): one Replicate call, Ideogram
 *    V3 Turbo to generate the word, or Flux Kontext Pro to restyle a wired
 *    picture of it (`build_text_effect_request`, text_effects.py:200-244);
 *  - SketchToImageNode (:5113-5143): Nano Banana, `{prompt, image_input}`;
 *  - ConsistentFaceNode (:5254-5294): Ideogram Character, `{prompt,
 *    character_reference_image, aspect_ratio, seed?}`.
 *
 * Each is priced per call (paidRates.ts; Sketch's Nano Banana by its edit
 * card, editRates.ts). Pure; relative imports only.
 */
import { isLink } from './graph'
import { pyIntOf, pyStrip } from './pyText'

export const TEXT_GENERATE_SLUG = 'ideogram-ai/ideogram-v3-turbo'
export const TEXT_RESTYLE_SLUG = 'black-forest-labs/flux-kontext-pro'
export const SKETCH_SLUG = 'google/nano-banana'
export const FACE_SLUG = 'ideogram-ai/ideogram-character'

/** The three classes, in the order the task lists them. */
export const IMAGE_EXTRAS_CLASSES = ['TextEffectNode', 'SketchToImageNode', 'ConsistentFaceNode'] as const
export type ImageExtrasClass = typeof IMAGE_EXTRAS_CLASSES[number]

/** The effect ids, in text_effects.py's order (`EFFECTS`; the node's options). */
export const TEXT_EFFECT_IDS = [
  'liquid-chrome', 'inflated-gloss', 'iridescent-holo', 'chromatic-glitch', 'acid-graphics', 'distressed-screenprint', 'gradient-mesh',
  'brutalist-concrete', 'ink-in-water', 'smoke-vapor', 'frosted-glass', 'wireframe-mesh', 'risograph', 'crystalline', 'light-trails', 'molten-metal',
] as const
export const TEXT_EFFECT_DEFAULT_ID = 'liquid-chrome'
/** `MATCH_INPUT_AR`: in restyle, keep the input picture's own crop. */
export const MATCH_INPUT_AR = 'Match input'
/** The node's ratios (`_TEXT_EFFECT_AR`, nodes_replicate.py:3635). */
export const TEXT_EFFECT_ASPECT_RATIOS = [MATCH_INPUT_AR, '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16'] as const

export const SKETCH_MODELS = ['Nano Banana'] as const
export const FACE_MODELS = ['Ideogram Character'] as const
export const FACE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '16:10', '10:16'] as const

/**
 * The largest seed Replicate's Ideogram models take (the published schemas
 * of ideogram-v3-turbo and ideogram-character: `seed` maximum 2147483647).
 * The nodes offer up to 0xFFFFFFFF; Python sends a larger one and Replicate
 * refuses it. Flux Kontext Pro's seed has no maximum.
 */
export const IDEOGRAM_SEED_MAX = 2_147_483_647

/** Python's own words (text_effects.py:236) for a generate-mode Text effect with no text. */
export const TEXT_EFFECT_NEEDS_TEXT = 'Enter some text to render.'
export const TEXT_EFFECT_SEED_TOO_LARGE = 'Text effect takes a seed up to 2147483647. Pick a smaller one.'
export const FACE_SEED_TOO_LARGE = 'Generate face references takes a seed up to 2147483647. Pick a smaller one.'

/** Whether a Text effect restyles (a picture is wired into `image`) rather than generates. */
export function textEffectRestyles(inputs: Record<string, unknown>): boolean {
  return isLink(inputs.image)
}

/** The Replicate slug a Text effect calls: Flux Kontext Pro with a wired picture, else Ideogram V3 Turbo. */
export function textEffectSlug(inputs: Record<string, unknown>): string {
  return textEffectRestyles(inputs) ? TEXT_RESTYLE_SLUG : TEXT_GENERATE_SLUG
}

/**
 * int() of a typed INT widget as the builder reads it (Python's `int()`,
 * `pyIntOf`: underscores between digits, as in "2_147_483_648"), or null when
 * it isn't a number (the rule row leaves that to the engine).
 */
function intOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') return pyIntOf(v)
  return null
}

/**
 * What the runner refuses in an image-extras node before the hold, from the
 * prompt as sent, or null:
 *  - a generate-mode Text effect whose typed text is blank (Python raises
 *    TEXT_EFFECT_NEEDS_TEXT before its call; a wired text is judged at the
 *    node's turn);
 *  - a seed an Ideogram model refuses (above IDEOGRAM_SEED_MAX): a generate-mode
 *    Text effect and Generate face references. Python sends it and Replicate
 *    refuses the call.
 * A wired setting is left alone (the rule row sends a wired widget to the engine).
 */
export function imageExtrasRequestProblem(classType: string, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (classType === 'TextEffectNode') {
    if (textEffectRestyles(inputs)) return null
    const text = inputs.text
    if (!isLink(text) && (text === undefined || text === null || (typeof text === 'string' && !pyStrip(text)))) {
      return { input: 'text', message: TEXT_EFFECT_NEEDS_TEXT }
    }
    const seed = intOf(inputs.seed)
    if (seed !== null && seed > IDEOGRAM_SEED_MAX) return { input: 'seed', message: TEXT_EFFECT_SEED_TOO_LARGE }
    return null
  }
  if (classType === 'ConsistentFaceNode') {
    const seed = intOf(inputs.seed)
    if (seed !== null && seed > IDEOGRAM_SEED_MAX) return { input: 'seed', message: FACE_SEED_TOO_LARGE }
  }
  return null
}
