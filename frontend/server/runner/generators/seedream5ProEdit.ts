/**
 * Seedream 5 Pro on "Edit an image" (model line-up, Task F9): runner-only,
 * family `seedream-5-pro-edit`, on Replicate, no backup.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/replicate/bytedance__seedream-5-pro.json,
 * version 91daad99…, re-read 2026-09-24): `bytedance/seedream-5-pro`, the
 * same model Generate from references already sends there. Its request is
 * that node's builder (refEdits.ts IMAGE_EDIT_MODELS['seedream-5-pro']), with
 * the one picture, plus the output format, which this node has and the
 * references node doesn't. It sends:
 *   prompt        the node's prompt, as it is
 *   image_input   [the picture]
 *   size          1K or 2K from the node's resolution (editSettings.ts
 *                 seedream5ProEditSize)
 *   aspect_ratio  the node's ratio: every Edit an image ratio, match_input_image
 *                 included, is in the schema's list
 *   output_format png, or jpeg for the node's jpg (the schema says "jpeg")
 * Not sent: the seed (the schema has none), `layer_decomposition` (a
 * different job: Layerize), and the Kontext-only safety and upsampling.
 *
 * Refused in plain words, never sent (F9 fix round 1, controller rulings),
 * by `seedream5ProEditProblems`: the builder throws the first one at
 * planning, and requestRules.ts refuses the node with them before any hold.
 *   - a resolution Seedream doesn't make (4K): SEEDREAM_5_PRO_EDIT_SIZE_REFUSAL;
 *   - an empty prompt, or one of only spaces (the schema's prompt is
 *     optional, but an edit with no instruction says nothing; a ruling, as
 *     Qwen Image 3's). This is a node rule, not a PROMPT_MIN_LENGTH row: that
 *     table is keyed by endpoint, and Generate from references sends an empty
 *     prompt to the same endpoint today;
 *   - a prompt over the schema's `maxLength` of 4,000 characters (counted
 *     as JSON Schema counts them, in code points). For this node only.
 *
 * No backup service. fal's `bytedance/seedream/v5/pro/edit` publishes only
 * "Tentative pricing" ($0.0675 up to 1536², $0.135 up to 2048², plus
 * $0.0045 per extra input picture; https://fal.ai/models/bytedance/seedream/v5/pro/edit/llms.txt,
 * read 2026-09-24), dearer than Replicate's $0.045 / $0.09 and not a
 * price that can be relied on, so S3 allows no backup there.
 */
import {
  SEEDREAM_5_PRO_EDIT_OPTION, SEEDREAM_5_PRO_EDIT_SIZE_REFUSAL, SEEDREAM_5_PRO_SLUG, seedream5ProEditSize,
} from '#shared/pricing/editSettings'
import { IMAGE_EDIT_MODELS } from './refEdits'
import { outputFormatIn } from './opts'
import type { ServiceCall } from './twins'

export { SEEDREAM_5_PRO_EDIT_OPTION, SEEDREAM_5_PRO_EDIT_SIZE_REFUSAL, SEEDREAM_5_PRO_SLUG }

/** bytedance/seedream-5-pro `prompt.maxLength`. */
export const SEEDREAM_5_PRO_PROMPT_MAX = 4000
export const SEEDREAM_5_PRO_NEEDS_PROMPT = 'Seedream 5 Pro needs a prompt. Describe the edit you want.'
export const SEEDREAM_5_PRO_LONG_PROMPT = 'Seedream 5 Pro takes a prompt of at most 4,000 characters. Shorten it.'

/**
 * What stops an Edit an image node on Seedream 5 Pro from being sent, read
 * from its widgets as the builder reads them: the input and the plain
 * message, each. A linked widget can't be read before the run, so it isn't
 * judged (the runner doesn't take a wired prompt; a wired resolution is sent
 * as the widget's 1K).
 */
export function seedream5ProEditProblems(inputs: { prompt: unknown, resolution: unknown }): { input: string, message: string }[] {
  const out: { input: string, message: string }[] = []
  if (!Array.isArray(inputs.resolution) && seedream5ProEditSize(inputs.resolution) === null) {
    out.push({ input: 'resolution', message: SEEDREAM_5_PRO_EDIT_SIZE_REFUSAL })
  }
  if (!Array.isArray(inputs.prompt)) {
    const text = typeof inputs.prompt === 'string' ? inputs.prompt : ''
    if (!text.trim()) out.push({ input: 'prompt', message: SEEDREAM_5_PRO_NEEDS_PROMPT })
    else if ([...text].length > SEEDREAM_5_PRO_PROMPT_MAX) out.push({ input: 'prompt', message: SEEDREAM_5_PRO_LONG_PROMPT })
  }
  return out
}

/** bytedance/seedream-5-pro `output_format` (its schema's enum). */
export const SEEDREAM_5_PRO_FORMATS = ['png', 'jpeg'] as const

export function isSeedream5ProEdit(model: unknown): boolean {
  return model === SEEDREAM_5_PRO_EDIT_OPTION
}

export interface Seedream5ProEditArgs {
  image: string
  prompt: string
  /** The node's resolution widget, as it is. */
  resolution: unknown
  /** The node's aspect_ratio widget, as it is. */
  aspectRatio: unknown
  /** The node's output_format widget, as it is. */
  outputFormat: unknown
}

/** "Edit an image" on Seedream 5 Pro: the Replicate request. */
export function seedream5ProEdit(a: Seedream5ProEditArgs): ServiceCall {
  const problem = seedream5ProEditProblems({ prompt: a.prompt, resolution: a.resolution })[0]
  if (problem) throw new Error(problem.message)
  const desc = IMAGE_EDIT_MODELS['seedream-5-pro']!
  const payload = desc.build(a.prompt, [a.image], 0, {
    size: seedream5ProEditSize(a.resolution)!,
    aspect_ratio: a.aspectRatio,
  })
  payload.output_format = outputFormatIn({ output_format: typeof a.outputFormat === 'string' && a.outputFormat ? a.outputFormat : 'png' }, SEEDREAM_5_PRO_FORMATS, 'png')
  return { provider: 'replicate', endpoint: desc.slug, payload }
}
