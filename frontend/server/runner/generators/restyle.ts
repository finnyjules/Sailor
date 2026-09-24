/**
 * Restyle from image (family `restyle`, Task B8).
 *
 * Ports, verbatim:
 *   comfy_api_nodes/replicate_refs.py  RESTYLE_DEFAULT_PROMPT,
 *     RESTYLE_STYLE_EMPHASIS and build_restyle_instruction (:274–378)
 *   comfy_api_nodes/nodes_replicate.py _STYLE_REFS_INSTRUCTION (:2492),
 *     _RESTYLE_MODELS / _NANO_BANANA_SLUGS (:3055–3068) and
 *     RestyleFromImageNode.execute's request (:3140–3221)
 *
 * Only the first call of _run_image_edit_prediction is made: Nano Banana 2
 * and Pro go to their fal edit endpoint (no fal Pro step, no Replicate
 * fallback), the original Nano Banana and IP-Adapter Style Transfer go to
 * Replicate. Python never sends a seed to the Nano Banana models here.
 */
import { pyStrip } from '#shared/runner/pyText'
import { pyFloatOf } from './opts'
import { imageEditCall } from './refEdits'

// ── replicate_refs.py ────────────────────────────────────────────────────

export const RESTYLE_DEFAULT_PROMPT = (
  'Redraw the first image in the visual art style of the second image. '
  + 'Preserve the first image\'s composition, subject, pose and layout — '
  + 'change only the rendering style, colors, texture, lighting and finish.'
)

export const RESTYLE_STYLE_EMPHASIS = (
  ' The second image is ONLY a style reference: apply its art style —'
  + ' its colors, texture, brushwork, lighting and finish — to the first image'
  + ' strongly and unmistakably, so the restyling is clearly visible. Take none'
  + ' of the second image\'s subject or content. Do not return the first image'
  + ' unchanged or only lightly altered.'
)

const RESTYLE_LOCK_SUBJECT = (
  ' Keep the subject\'s identity, clothing, pose, framing and'
  + ' background composition exactly as in the first image —'
  + ' restyle only colour, texture, lighting and finish; add'
  + ' nothing and remove nothing.'
)

const RESTYLE_REINTERPRET = ' You may loosely reinterpret the content while matching the style.'

/**
 * build_restyle_instruction: the structure dial as words (≥ 0.66 locks the
 * subject, ≤ 0.33 lets it be reinterpreted, in between says neither), then
 * the extra direction when it isn't blank.
 */
export function buildRestyleInstruction(structureStrength: number, extraDirection = ''): string {
  let instruction = RESTYLE_DEFAULT_PROMPT + RESTYLE_STYLE_EMPHASIS
  if (structureStrength >= 0.66) instruction += RESTYLE_LOCK_SUBJECT
  else if (structureStrength <= 0.33) instruction += RESTYLE_REINTERPRET
  const extra = pyStrip(extraDirection)
  if (extra) instruction += ` Additional style direction: ${extra}.`
  return instruction
}

// ── nodes_replicate.py ───────────────────────────────────────────────────

/** Said after the instruction when moodboard pictures are the style source. */
export const STYLE_REFS_INSTRUCTION = (
  'Use the attached reference images strictly as STYLE references — match '
  + 'their palette, light, grain and mood; do not copy their subjects or '
  + 'composition.'
)

/** The node's `model` options (_RESTYLE_MODELS), in display order. */
export const RESTYLE_MODELS = ['Nano Banana 2', 'Nano Banana Pro', 'Nano Banana', 'Style Transfer · IP-Adapter'] as const
export type RestyleModel = typeof RESTYLE_MODELS[number]

/** _NANO_BANANA_SLUGS: display name → Replicate slug. */
export const RESTYLE_NANO_BANANA_SLUGS: Readonly<Record<string, string>> = {
  'Nano Banana': 'google/nano-banana',
  'Nano Banana 2': 'google/nano-banana-2',
  'Nano Banana Pro': 'google/nano-banana-pro',
}

export const STYLE_TRANSFER_SLUG = 'fofr/style-transfer'

/** Python's RuntimeError texts, word for word. */
export const RESTYLE_NO_STYLE_SOURCE = 'Restyle needs a style image or a wired moodboard — neither was provided.'
export const STYLE_TRANSFER_NO_PICTURE = 'Style Transfer needs a style image or a moodboard image — a taste block alone can\'t feed IP-Adapter.'

export const isRestyleModel = (m: string): m is RestyleModel => (RESTYLE_MODELS as readonly string[]).includes(m)
export const isNanoBananaRestyle = (m: string): boolean => Object.prototype.hasOwnProperty.call(RESTYLE_NANO_BANANA_SLUGS, m)

/**
 * RestyleFromImageNode.execute's style-source guards, in Python's order:
 * no board picture, no style picture and no taste text fails every model;
 * IP-Adapter also fails without a picture (taste text alone can't feed it).
 */
export function checkStyleSource(model: string, o: { hasBoard: boolean; hasStyleImage: boolean; taste: string }): void {
  if (!o.hasBoard && !o.hasStyleImage && !o.taste) throw new Error(RESTYLE_NO_STYLE_SOURCE)
  if (!isNanoBananaRestyle(model) && !o.hasBoard && !o.hasStyleImage) throw new Error(STYLE_TRANSFER_NO_PICTURE)
}

/**
 * The structure_strength widget: missing is the node's 0.65. A number is
 * itself; a bool or numeric text is read the way ComfyUI's FLOAT check
 * (float(val)) reads it. Anything else fails the node.
 */
export function structureStrengthOf(v: unknown): number {
  if (v === undefined) return 0.65
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const f = typeof v === 'string' ? pyFloatOf(v) : null
  if (f === null) throw new Error('The structure strength must be a number')
  return f
}

// The file errors Python's open() raises as OSError: a board picture that
// can't be read is skipped, as _moodboard_ref_data_urls skips it. Anything
// else (an upload that failed, say) fails the node rather than quietly
// restyling without the board.
const UNREADABLE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'])

export function isUnreadableFile(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && UNREADABLE_CODES.has(code)
}

export interface RestyleRequest {
  model: RestyleModel
  content: string
  /** The moodboard pictures that could be read (Python's board_urls). */
  board: string[]
  /** The style picture, or null when it isn't linked (or isn't needed). */
  styleImage: string | null
  /** The prompt widget, stripped. */
  guidance: string
  /** The taste text (style_in), stripped. */
  taste: string
  structureStrength: number
  resolution: unknown
  outputFormat: unknown
  seed: number
}

/** The first provider call RestyleFromImageNode makes. */
export function restyleCall(r: RestyleRequest): { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> } {
  checkStyleSource(r.model, { hasBoard: r.board.length > 0, hasStyleImage: r.styleImage !== null, taste: r.taste })
  const extraDirection = r.taste ? pyStrip(`${r.guidance} ${r.taste}`) : r.guidance

  if (isNanoBananaRestyle(r.model)) {
    let prompt: string
    let imageInput: string[]
    if (r.board.length) {
      // Content first, then the board pictures as style-only references.
      prompt = pyStrip(`${buildRestyleInstruction(r.structureStrength, extraDirection)} ${STYLE_REFS_INSTRUCTION}`)
      imageInput = [r.content, ...r.board]
    }
    else if (r.styleImage !== null) {
      prompt = buildRestyleInstruction(r.structureStrength, extraDirection)
      imageInput = [r.content, r.styleImage]
    }
    else {
      // A board whose pictures are gone: the taste text carries the restyle alone.
      prompt = buildRestyleInstruction(r.structureStrength, extraDirection)
      imageInput = [r.content]
    }
    const input: Record<string, unknown> = { prompt, image_input: imageInput, output_format: r.outputFormat }
    // Only the newer two take a resolution; google/nano-banana would 422.
    if (r.model !== 'Nano Banana') input.resolution = r.resolution
    return imageEditCall(RESTYLE_NANO_BANANA_SLUGS[r.model]!, input)
  }

  // Style Transfer · IP-Adapter: one style picture (the first board picture wins).
  const basePrompt = r.guidance || 'a high quality image'
  const input: Record<string, unknown> = {
    prompt: r.taste ? pyStrip(`${basePrompt} ${r.taste}`) : basePrompt,
    style_image: r.board.length ? r.board[0] : r.styleImage,
    structure_image: r.content,
    structure_denoising_strength: r.structureStrength,
    output_format: r.outputFormat,
    number_of_images: 1,
  }
  if (r.seed && r.seed > 0) input.seed = r.seed
  return imageEditCall(STYLE_TRANSFER_SLUG, input)
}
