/**
 * Requests no provider takes, refused in plain words before they are sent
 * (Task S1b fix round 1, controller rulings a and d). Both paths use this:
 *  - the runner: planNode checks the payload it built (`checkRequest`), and
 *    the engine checks every node before anything is held (`requestProblems`);
 *  - the ComfyUI path: the /prompt gate (server/utils/blockedModels.ts, the
 *    local proxy and the hosted meter) checks the same nodes (`requestProblems`).
 *
 * The rules come from the providers' saved schemas
 * (tests/unit/fixtures/provider-schemas/; a test holds this table to them):
 *  - a prompt shorter than the schema's `minLength` (Nano Banana 3, Hailuo H3 1,
 *    GPT Image 2.5 1), and a transparent JPEG from GPT Image 2.5;
 *  - Wan 3.0 reference pictures over its schema's 10, and reference videos or
 *    sounds, which the runner doesn't send it yet (wan3.ts);
 *  - Seedance 2.0 references over the schema's counts (9 pictures, 3 videos,
 *    3 sounds). Their combined length (15 s of video, 15 s of sound) needs the
 *    files read, which only the gate can do (graphInputSeconds.ts
 *    seedanceReferenceSeconds);
 *  - a first frame (the linked picture, or `image_url` in the options) AND
 *    references, on Wan 3.0 or Seedance 2.0 (F1 fix round 1): the builders
 *    would send the first frame and drop the references without a word, so
 *    the node is refused instead (FIRST_FRAME_AND_REFERENCES);
 *  - Gemini Omni Flash with a last frame, or reference pictures, videos or
 *    sounds, in its options: its endpoints take one first frame at most, so
 *    the node is refused (geminiOmniFlash.ts GEMINI_OMNI_FLASH_ONE_PICTURE).
 * References are never dropped, to make a request fit or otherwise. (Film a
 * shot, which the runner doesn't take and this file doesn't judge, still
 * drops them on the ComfyUI path, as its Python builder does.)
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { resolveVideoModelId } from '#shared/runner/eligibility'
import { composeImagePrompt } from './generators/image'
import { RUNNER_VIDEO_MODELS } from './generators/video'
import { H3_MAX_TURBO_APP, H3_MAX_TURBO_ENDPOINTS, H3_MAX_TURBO_ID } from './generators/h3MaxTurbo'
import { GEMINI_OMNI_FLASH_ID, GEMINI_OMNI_FLASH_ONE_PICTURE, geminiOmniFlashHasExtras } from './generators/geminiOmniFlash'
import { asText, parseJsonObject } from './generators/opts'
import { moodboardFiles } from './inputs'
import {
  WAN_30_REFERENCE_TO_VIDEO, WAN_30_TEXT_TO_VIDEO, WAN_3_MAX_REFERENCE_PICTURES, WAN_3_NEEDS_PROMPT, WAN_3_PICTURES_ONLY,
  WAN_3_TOO_MANY_REFERENCES, FIRST_FRAME_AND_REFERENCES, isWan3Model, wan3FirstFrame, wan3HasAnyReferences, wan3HasMediaReferences,
  wan3Mode, wan3ReferencePictures, type Wan3Id,
} from './generators/wan3'
import {
  GPT_IMAGE_25_EDIT_APP, GPT_IMAGE_25_EDIT_OPTION, GPT_IMAGE_25_FAL_ENDPOINTS, GPT_IMAGE_25_NEEDS_PROMPT, GPT_IMAGE_25_TRANSPARENT_JPEG,
  gptImage25FalTextToImage, gptImage25TransparentJpeg, gptImage25Variant, isGptImage25Model,
} from './generators/gptImage25'

export { FIRST_FRAME_AND_REFERENCES }

export const NANO_BANANA_SHORT_PROMPT = 'Nano Banana needs a prompt of at least 3 characters.'
export const H3_SHORT_PROMPT = 'Hailuo H3 needs a prompt.'

/** `<provider> <endpoint>` → the prompt's minimum length in characters (the schema's `minLength`), and what to say. */
export const PROMPT_MIN_LENGTH: Readonly<Record<string, { min: number, message: string }>> = {
  'fal fal-ai/nano-banana-2': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-2/edit': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  // Recraft V4 on fal is only ever a backup (twins.ts): an empty prompt drops the backup, never the node.
  'fal fal-ai/recraft/v4/text-to-image': { min: 1, message: 'Recraft V4 needs a prompt.' },
  'fal fal-ai/recraft/v4/pro/text-to-image': { min: 1, message: 'Recraft V4 Pro needs a prompt.' },
  'fal fal-ai/nano-banana-pro': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-pro/edit': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal minimax/h3/text-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3/image-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3/reference-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3-max/text-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3-max/image-to-video': { min: 1, message: H3_SHORT_PROMPT },
  // Hailuo H3 Max Turbo (h3MaxTurbo.ts): H3 Max's schema, so the same rule.
  ...Object.fromEntries(H3_MAX_TURBO_ENDPOINTS.map(e => [`fal ${e}`, { min: 1, message: H3_SHORT_PROMPT }])),
  // Wan 3.0: only text-to-video requires a prompt (image- and reference-to-video take none).
  [`fal ${WAN_30_TEXT_TO_VIDEO}`]: { min: 1, message: WAN_3_NEEDS_PROMPT },
  // GPT Image 2.5 (gptImage25.ts): every fal endpoint requires a prompt; Replicate's (the backup) states no minimum.
  ...Object.fromEntries(GPT_IMAGE_25_FAL_ENDPOINTS.map(e => [`fal ${e}`, { min: 1, message: GPT_IMAGE_25_NEEDS_PROMPT }])),
}

/** JSON Schema counts characters as code points. */
const chars = (s: string) => [...s].length

/** Seedance 2.0 reference-to-video limits (its schema: image_urls ≤ 9, video_urls ≤ 3, audio_urls ≤ 3). */
export const SEEDANCE_REFERENCE_LIMITS = [
  { key: 'image_urls', max: 9, message: 'Seedance 2.0 takes at most 9 reference pictures.' },
  { key: 'video_urls', max: 3, message: 'Seedance 2.0 takes at most 3 reference videos.' },
  { key: 'audio_urls', max: 3, message: 'Seedance 2.0 takes at most 3 reference sounds.' },
] as const
/** Combined length of the reference videos, and of the reference sounds (its schema's descriptions). */
export const SEEDANCE_REFERENCE_MAX_SECONDS = 15
export const SEEDANCE_TOO_MUCH_VIDEO = 'Seedance 2.0 takes at most 15 s of reference video in all.'
export const SEEDANCE_TOO_MUCH_SOUND = 'Seedance 2.0 takes at most 15 s of reference sound in all.'
/** Hosted: a reference whose length can't be read (an external link, say) can't be checked, so it isn't sent. */
export const SEEDANCE_UNMEASURED_REFERENCE = 'Seedance 2.0 can’t check how long a reference video or sound is. Use one uploaded to Sailor.'

/**
 * What is wrong with Seedance 2.0's reference lists in these options, or null.
 * A first frame (the linked image, or `image_url`) beside any reference is
 * refused (the builder would drop the references); otherwise the counts.
 */
export function seedanceReferenceProblem(adv: Record<string, unknown>, firstFrame: boolean): { key: string, message: string } | null {
  if (firstFrame || asText(adv.image_url)) {
    const key = SEEDANCE_REFERENCE_LIMITS.map(l => l.key).find(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
    return key ? { key, message: FIRST_FRAME_AND_REFERENCES } : null
  }
  for (const l of SEEDANCE_REFERENCE_LIMITS) {
    const v = adv[l.key]
    if (Array.isArray(v) && v.length > l.max) return { key: l.key, message: l.message }
  }
  return null
}

/** The payload's problem for this endpoint, or null (the runner, after building it). */
export function requestProblem(provider: string, endpoint: string, payload: Record<string, unknown>): string | null {
  const rule = PROMPT_MIN_LENGTH[`${provider} ${endpoint}`]
  if (rule && chars(typeof payload.prompt === 'string' ? payload.prompt : '') < rule.min) return rule.message
  // GPT Image 2.5 makes no transparent JPEG (either service); the request is refused, never sent.
  if ((GPT_IMAGE_25_FAL_ENDPOINTS as readonly string[]).includes(endpoint) || endpoint.startsWith('openai/gpt-image-2.5-')) {
    if (payload.background === 'transparent' && payload.output_format === 'jpeg') return GPT_IMAGE_25_TRANSPARENT_JPEG
  }
  if (`${provider} ${endpoint}` === 'fal bytedance/seedance-2.0/reference-to-video') {
    for (const l of SEEDANCE_REFERENCE_LIMITS) {
      const v = payload[l.key]
      if (Array.isArray(v) && v.length > l.max) return l.message
    }
  }
  if (`${provider} ${endpoint}` === `fal ${WAN_30_REFERENCE_TO_VIDEO}`) {
    const v = payload.reference_image_urls
    if (Array.isArray(v) && v.length > WAN_3_MAX_REFERENCE_PICTURES) return WAN_3_TOO_MANY_REFERENCES
  }
  return null
}

/**
 * What is wrong with a Wan 3.0 node's request before it is built, or null:
 * the input it is about and the plain message. Judged the way wan3Call picks
 * the endpoint (a linked `image` counts as a first frame).
 */
export function wan3RequestProblem(id: Wan3Id, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (isLink(inputs.model_options)) return null
  const adv = parseJsonObject(inputs.model_options)
  const first = isLink(inputs.image) || !!wan3FirstFrame(null, adv)
  if (first && wan3HasAnyReferences(adv)) return { input: 'model_options', message: FIRST_FRAME_AND_REFERENCES }
  const mode = wan3Mode(id, first, adv)
  if (mode === 'image') return null
  if (wan3HasMediaReferences(adv)) return { input: 'model_options', message: WAN_3_PICTURES_ONLY }
  if (mode === 'reference') {
    const refs = wan3ReferencePictures(adv)!
    return refs.length > WAN_3_MAX_REFERENCE_PICTURES ? { input: 'model_options', message: WAN_3_TOO_MANY_REFERENCES } : null
  }
  if (!isLink(inputs.prompt) && chars(asText(inputs.prompt)) < 1) return { input: 'prompt', message: WAN_3_NEEDS_PROMPT }
  return null
}

/** planNode's check: throws the plain message for a request no provider takes. */
export function checkRequest(provider: string, endpoint: string, payload: Record<string, unknown>): void {
  const problem = requestProblem(provider, endpoint, payload)
  if (problem) throw new Error(problem)
}

export interface RequestProblem {
  nodeId: string
  classType: string
  /** The input the problem is about. */
  input: string
  message: string
}

/** GenerateImageNode's Nano Banana models → their fal apps (text-to-image, and edit when moodboard pictures ride along). */
const NANO_BANANA_IMAGE_APPS: Readonly<Record<string, { text: string, refs: string }>> = {
  'nano-banana-2': { text: 'fal-ai/nano-banana-2', refs: 'fal-ai/nano-banana-2/edit' },
  'nano-banana-pro': { text: 'fal-ai/nano-banana-pro', refs: 'fal-ai/nano-banana-pro/edit' },
}
/** GenerateVideoNode's Hailuo H3 models → their fal apps (from the video table, and H3 Max Turbo's). */
const H3_VIDEO_APPS: Readonly<Record<string, string>> = Object.fromEntries([
  ...['hailuo-h3', 'hailuo-h3-max'].map(id => [id, RUNNER_VIDEO_MODELS[id]!.app]),
  [H3_MAX_TURBO_ID, H3_MAX_TURBO_APP],
])

/**
 * Every node of a prompt whose request no provider would take, read from its
 * widgets the way the node composes its request (Python and the runner alike):
 * the prompt as sent, after any style text is added, judged by the endpoint's
 * rule in PROMPT_MIN_LENGTH. A prompt part that is wired in can't be read
 * before the run, so that node is not judged here.
 */
export function requestProblems(prompt: ApiPrompt): RequestProblem[] {
  const out: RequestProblem[] = []
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const inputs = node?.inputs ?? {}
    const ct = node?.class_type
    /** The prompt `text` against the rule of `fal <endpoint>`. */
    const judge = (endpoint: string, text: string) => {
      const rule = PROMPT_MIN_LENGTH[`fal ${endpoint}`]
      if (!rule) throw new Error(`No prompt rule for fal ${endpoint}`)
      if (chars(text) < rule.min) out.push({ nodeId, classType: ct, input: 'prompt', message: rule.message })
    }
    const nb = ct === 'GenerateImageNode' && Object.prototype.hasOwnProperty.call(NANO_BANANA_IMAGE_APPS, String(inputs.model))
      ? NANO_BANANA_IMAGE_APPS[String(inputs.model)]!
      : null
    if (nb) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      const hasRefs = moodboardFiles(inputs.style_refs).length > 0
      judge(hasRefs ? nb.refs : nb.text, composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs,
      }))
    }
    else if (ct === 'EditImageNode' && inputs.model === 'Nano Banana 2') {
      if (!isLink(inputs.prompt)) judge('fal-ai/nano-banana-2/edit', asText(inputs.prompt))
    }
    // GPT Image 2.5 (gptImage25.ts): the prompt as sent, and no transparent JPEG.
    else if (ct === 'GenerateImageNode' && isGptImage25Model(inputs.model)) {
      const adv = isLink(inputs.model_options) ? null : parseJsonObject(inputs.model_options)
      if (adv && gptImage25TransparentJpeg(adv)) out.push({ nodeId, classType: ct, input: 'model_options', message: GPT_IMAGE_25_TRANSPARENT_JPEG })
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      judge(gptImage25FalTextToImage(gptImage25Variant(adv ?? {})), composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs: false,
      }))
    }
    else if (ct === 'EditImageNode' && inputs.model === GPT_IMAGE_25_EDIT_OPTION) {
      if (!isLink(inputs.prompt)) judge(GPT_IMAGE_25_EDIT_APP, asText(inputs.prompt))
    }
    else if (ct === 'GenerateFromReferencesNode' && inputs.model === 'nano-banana-2') {
      if (!isLink(inputs.prompt) && (inputs.prompt === undefined || typeof inputs.prompt === 'string')) judge('fal-ai/nano-banana-2/edit', asText(inputs.prompt))
    }
    else if (ct === 'GenerateVideoNode') {
      const id = resolveVideoModelId(inputs.model)
      const h3 = Object.prototype.hasOwnProperty.call(H3_VIDEO_APPS, id) ? H3_VIDEO_APPS[id]! : null
      if (h3 && !isLink(inputs.prompt)) judge(`${h3}/${isLink(inputs.image) ? 'image-to-video' : 'text-to-video'}`, asText(inputs.prompt))
      if (id === 'seedance-2.0' && !isLink(inputs.model_options)) {
        const p = seedanceReferenceProblem(parseJsonObject(inputs.model_options), isLink(inputs.image))
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p.message })
      }
      if (isWan3Model(id)) {
        const p = wan3RequestProblem(id, inputs)
        if (p) out.push({ nodeId, classType: ct, input: p.input, message: p.message })
      }
      // Gemini Omni Flash: one first frame at most (its builder refuses the same at planning).
      if (id === GEMINI_OMNI_FLASH_ID && !isLink(inputs.model_options) && geminiOmniFlashHasExtras(parseJsonObject(inputs.model_options))) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: GEMINI_OMNI_FLASH_ONE_PICTURE })
      }
    }
  }
  return out
}
