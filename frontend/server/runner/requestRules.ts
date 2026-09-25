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
 *    GPT Image 2.5 1, Muse Image 1, Reve 2.1 1, Recraft V4.1 1), and a transparent JPEG
 *    from GPT Image 2.5;
 *  - a prompt longer than the schema's `maxLength` where the table
 *    PROMPT_MAX_LENGTH names the endpoint (Reve 2.1 4,000, F15; Recraft V4.1
 *    10,000, F16; Krea 2 5,000, F17);
 *  - Krea 2 Large and Medium (F17) with an empty prompt (the schema's
 *    minLength 1) or one over 5,000 characters, as sent: on a runner run
 *    ONLY (`requestProblems(prompt, { runner: true })`). They are not
 *    runner-only, and the ComfyUI path keeps sending what it sent before
 *    (Python falls over to Replicate, whose schema sets no limit);
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
 *    the node is refused (geminiOmniFlash.ts GEMINI_OMNI_FLASH_ONE_PICTURE);
 *  - Veo 3.1, Veo 3.1 Fast and Veo 3.1 Lite with a last frame, or reference
 *    pictures, videos or sounds, in their options (F6 follow-up): their shared
 *    builder takes one first frame at most, so the node is refused on
 *    Generate a video and on Film a shot (video.ts VEO_31_ONE_PICTURE);
 *  - Gemini Omni Flash text-to-video with an empty prompt (controller ruling
 *    after F4: the schema requires a prompt but sets no minimum, so an empty
 *    one would fail only at the result). It is the one row of the prompt table
 *    that comes from a ruling, not a schema (PROMPT_MIN_LENGTH_RULINGS);
 *  - Qwen Image 3 and Grok Imagine 2 with an empty prompt, as sent (controller
 *    ruling after F6: their Replicate schemas require a prompt but set no
 *    minimum). Two more ruled rows of the prompt table;
 *  - Ideogram 4 with an empty prompt, as sent (F8: fal's ideogram/v4 schema
 *    requires a prompt but sets no minimum, as Qwen's and Grok's). Ruled too.
 *    Every ruled row judges the prompt with its surrounding whitespace
 *    trimmed (controller ruling after F7), so a prompt of spaces is refused;
 *    the rows from a schema's `minLength` count exactly what is sent, as the
 *    provider does;
 *  - Seedream 5 Pro in Edit an image (F9 fix round 1, controller rulings): a
 *    resolution it doesn't make (4K), an empty or spaces-only prompt, or one
 *    over its schema's 4,000 characters (seedream5ProEdit.ts
 *    seedream5ProEditProblems; a node rule, since Generate from references
 *    sends the same endpoint an empty prompt today);
 *  - Film a shot on Seedance 2.0 with a first frame AND references (parked
 *    minor M5): Film a shot runs only on the ComfyUI path, whose Python
 *    builder would send the first frame and drop the references, so the
 *    /prompt gate refuses it with the same words as Generate a video;
 *  - Rotate camera on Qwen Image Edit 2511 (F10 fix round 1, controller
 *    ruling) with a picture above the input cap (LARGEST_INPUT_PIXELS, about
 *    19 MP): fal makes the picture at the input's size with no stated limit,
 *    and the price stops at the cap, so a larger one could cost more than it
 *    is charged. The size is only known once the runner has the file, so the
 *    engine checks it (`measuredInputProblem`) after measuring and before
 *    sending; the node fails and its hold is released. An input it can't
 *    measure is charged at the cap, as before.
 *  - Product shot on Bria Product Shot (F12 fix round 1, controller ruling)
 *    with a picture over 12 MB, or not JPEG, PNG or WebP (read from its first
 *    bytes): the engine reads that one file (`linkedFileProblem`) before the
 *    hand-off; the node fails and its hold is released. No other node's file
 *    is read.
 * References are never dropped, to make a request fit or otherwise.
 */
import { isLink, type ApiNode, type ApiPrompt } from '#shared/runner/graph'
import { classUpgradeOn, resolveVideoModelId } from '#shared/runner/eligibility'
import type { RunnerFamily } from '#shared/runner/families'
import { LARGEST_INPUT_PIXELS } from '#shared/pricing/editSettings'
import { composeImagePrompt } from './generators/image'
import { RUNNER_VIDEO_MODELS, VEO_31_ONE_PICTURE, veo31HasExtras } from './generators/video'
import { H3_MAX_TURBO_APP, H3_MAX_TURBO_ENDPOINTS, H3_MAX_TURBO_ID } from './generators/h3MaxTurbo'
import {
  GEMINI_OMNI_FLASH_ID, GEMINI_OMNI_FLASH_ONE_PICTURE, GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, geminiOmniFlashFirstFrame, geminiOmniFlashHasExtras,
} from './generators/geminiOmniFlash'
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
import { QWEN_IMAGE_3_SLUG, isQwenImage3Model } from './generators/qwenImage3'
import { GROK_IMAGINE_2_SLUG, isGrokImagine2Model } from './generators/grokImagine2'
import { IDEOGRAM_4_FAL_APP, IDEOGRAM_4_NEEDS_PROMPT, isIdeogram4Model } from './generators/ideogram4'
import { MUSE_IMAGE_FAL_APP, MUSE_IMAGE_NEEDS_PROMPT, isMuseImageModel } from './generators/museImage'
import { NANO_BANANA_2_LITE_NEEDS_PROMPT, NANO_BANANA_2_LITE_SLUG, isNanoBanana2LiteModel } from './generators/nanoBanana2Lite'
import { REVE_21_FAL_APP, REVE_21_LONG_PROMPT, REVE_21_NEEDS_PROMPT, REVE_21_PROMPT_MAX, isReve21Model } from './generators/reve21'
import {
  RECRAFT_V41_FAL_APP, RECRAFT_V41_LONG_PROMPT, RECRAFT_V41_NEEDS_PROMPT, RECRAFT_V41_PROMPT_MAX, isRecraftV41Model,
} from './generators/recraftV41'
import { KREA_2_FAL_APPS, KREA_2_IDS, KREA_2_LONG_PROMPT, KREA_2_NEEDS_PROMPT, KREA_2_PROMPT_MAX, isKrea2Model } from './generators/krea2'
import { isSeedream5ProEdit, seedream5ProEditProblems } from './generators/seedream5ProEdit'

export { FIRST_FRAME_AND_REFERENCES }

export const NANO_BANANA_SHORT_PROMPT = 'Nano Banana needs a prompt of at least 3 characters.'
export const H3_SHORT_PROMPT = 'Hailuo H3 needs a prompt.'
export const GEMINI_OMNI_FLASH_NEEDS_PROMPT = 'Gemini Omni Flash needs a prompt. Describe the clip, or link a picture to start from it.'
export const QWEN_IMAGE_3_NEEDS_PROMPT = 'Qwen Image 3 needs a prompt. Describe the picture you want.'
export const GROK_IMAGINE_2_NEEDS_PROMPT = 'Grok Imagine 2 needs a prompt. Describe the picture you want.'

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
  // Gemini Omni Flash text-to-video (geminiOmniFlash.ts): a ruling, not the schema (see PROMPT_MIN_LENGTH_RULINGS).
  [`fal ${GEMINI_OMNI_FLASH_TEXT_TO_VIDEO}`]: { min: 1, message: GEMINI_OMNI_FLASH_NEEDS_PROMPT },
  // Qwen Image 3 (qwenImage3.ts) and Grok Imagine 2 (grokImagine2.ts) on Replicate: rulings, not the schemas.
  [`replicate ${QWEN_IMAGE_3_SLUG}`]: { min: 1, message: QWEN_IMAGE_3_NEEDS_PROMPT },
  [`replicate ${GROK_IMAGINE_2_SLUG}`]: { min: 1, message: GROK_IMAGINE_2_NEEDS_PROMPT },
  // Ideogram 4 on fal (ideogram4.ts): a ruling, not the schema. Its Replicate backup's prompt is optional.
  [`fal ${IDEOGRAM_4_FAL_APP}`]: { min: 1, message: IDEOGRAM_4_NEEDS_PROMPT },
  // Muse Image on fal (museImage.ts): the schema's own minLength 1.
  [`fal ${MUSE_IMAGE_FAL_APP}`]: { min: 1, message: MUSE_IMAGE_NEEDS_PROMPT },
  // Nano Banana 2 Lite on Replicate (nanoBanana2Lite.ts): a ruling, not the schema
  // (Replicate's sets no minimum; fal's schema for the same model asks for 3 characters).
  [`replicate ${NANO_BANANA_2_LITE_SLUG}`]: { min: 1, message: NANO_BANANA_2_LITE_NEEDS_PROMPT },
  // Reve 2.1 on fal (reve21.ts): the schema's own minLength 1.
  [`fal ${REVE_21_FAL_APP}`]: { min: 1, message: REVE_21_NEEDS_PROMPT },
  // Recraft V4.1 on fal (recraftV41.ts): the schema's own minLength 1. Its
  // Replicate backup is built from a request that passed this.
  [`fal ${RECRAFT_V41_FAL_APP}`]: { min: 1, message: RECRAFT_V41_NEEDS_PROMPT },
  // Krea 2 Large and Medium on fal (krea2.ts, F17): the schemas' own minLength 1.
  // Judged before the run only on a runner run (requestProblems' `runner`).
  ...Object.fromEntries(KREA_2_IDS.map(id => [`fal ${KREA_2_FAL_APPS[id]}`, { min: 1, message: KREA_2_NEEDS_PROMPT }])),
}

/**
 * `<provider> <endpoint>` → the prompt's maximum length in characters (the
 * schema's `maxLength`, counted as sent), and what to say. Only endpoints
 * whose builder lets a longer prompt through are listed (a test holds each
 * row to its saved schema).
 */
export const PROMPT_MAX_LENGTH: Readonly<Record<string, { max: number, message: string }>> = {
  // Reve 2.1 on fal (reve21.ts, Task F15).
  [`fal ${REVE_21_FAL_APP}`]: { max: REVE_21_PROMPT_MAX, message: REVE_21_LONG_PROMPT },
  // Recraft V4.1 on fal (recraftV41.ts, Task F16).
  [`fal ${RECRAFT_V41_FAL_APP}`]: { max: RECRAFT_V41_PROMPT_MAX, message: RECRAFT_V41_LONG_PROMPT },
  // Krea 2 Large and Medium on fal (krea2.ts, Task F17).
  ...Object.fromEntries(KREA_2_IDS.map(id => [`fal ${KREA_2_FAL_APPS[id]}`, { max: KREA_2_PROMPT_MAX, message: KREA_2_LONG_PROMPT }])),
}

/**
 * The rows of PROMPT_MIN_LENGTH that come from a controller ruling rather
 * than the schema's `minLength` (a test holds every other row to the schemas).
 * These judge the prompt with its surrounding whitespace trimmed (ruling after
 * F7): a prompt of spaces says nothing.
 */
export const PROMPT_MIN_LENGTH_RULINGS: readonly string[] = [
  `fal ${GEMINI_OMNI_FLASH_TEXT_TO_VIDEO}`,
  `replicate ${QWEN_IMAGE_3_SLUG}`,
  `replicate ${GROK_IMAGINE_2_SLUG}`,
  `fal ${IDEOGRAM_4_FAL_APP}`,
  `replicate ${NANO_BANANA_2_LITE_SLUG}`,
]

/** JSON Schema counts characters as code points. */
const chars = (s: string) => [...s].length

/**
 * The prompt's length as the rule of `key` (`<provider> <endpoint>`) counts it:
 * trimmed for a ruled row, exactly as sent for a schema's `minLength`.
 */
function promptLength(key: string, text: string): number {
  return chars(PROMPT_MIN_LENGTH_RULINGS.includes(key) ? text.trim() : text)
}

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
  const key = `${provider} ${endpoint}`
  const rule = PROMPT_MIN_LENGTH[key]
  if (rule && promptLength(key, typeof payload.prompt === 'string' ? payload.prompt : '') < rule.min) return rule.message
  const max = PROMPT_MAX_LENGTH[key]
  if (max && typeof payload.prompt === 'string' && chars(payload.prompt) > max.max) return max.message
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

export const ROTATE_CAMERA_TOO_LARGE = 'Rotate camera takes pictures up to about 19 megapixels. Make this one smaller first.'

/**
 * A node's measured input picture that its model must not be sent (the
 * engine asks after measuring, before sending): Rotate camera on Qwen Image
 * Edit 2511, while that switch is on, above the input cap. Null otherwise,
 * and for a picture that couldn't be measured (priced at the cap).
 */
export function measuredInputProblem(classType: string, inputPixels: number | undefined, families: ReadonlySet<RunnerFamily>): string | null {
  if (classType !== 'RotateCameraNode' || !classUpgradeOn(classType, families)) return null
  return inputPixels !== undefined && inputPixels > LARGEST_INPUT_PIXELS ? ROTATE_CAMERA_TOO_LARGE : null
}

export const PRODUCT_SHOT_MAX_BYTES = 12_000_000
export const PRODUCT_SHOT_TOO_LARGE = 'Product shot takes pictures up to 12 MB. Make this one smaller first.'
export const PRODUCT_SHOT_WRONG_FORMAT = 'Product shot takes JPEG, PNG or WebP pictures.'

/**
 * A picture's format from its first bytes (never its name): JPEG (FF D8 FF),
 * PNG (the 8-byte signature) or WebP (RIFF….WEBP); null for anything else.
 */
export function pictureFormat(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  const at = (i: number, sig: readonly number[]) => sig.every((b, k) => bytes[i + k] === b)
  if (at(0, [0xFF, 0xD8, 0xFF])) return 'jpeg'
  if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp'
  return null
}

/**
 * The input whose file must be checked before it is handed off, or null (no
 * file is read): Product shot's `image` while Bria Product Shot's switch is
 * on (F12 fix round 1). Every other node, and Product shot with the switch
 * off, reads nothing.
 */
export function checkedInputFile(classType: string, families: ReadonlySet<RunnerFamily>): string | null {
  return classType === 'ProductShotNode' && classUpgradeOn(classType, families) ? 'image' : null
}

/**
 * What is wrong with the file a node would send, or null. Bria Product Shot
 * (fal-ai/bria/product-shot, its schema: "Accepted formats are jpeg, jpg,
 * png, webp. Maximum file size 12MB.") refuses a larger file or another
 * format only after the call, so it is refused here. 12 MB is read as
 * 12,000,000 bytes, the smaller reading. Null while the switch is off.
 */
export function inputFileProblem(classType: string, bytes: Uint8Array, families: ReadonlySet<RunnerFamily>): string | null {
  if (!checkedInputFile(classType, families)) return null
  if (bytes.byteLength > PRODUCT_SHOT_MAX_BYTES) return PRODUCT_SHOT_TOO_LARGE
  return pictureFormat(bytes) ? null : PRODUCT_SHOT_WRONG_FORMAT
}

/**
 * The engine's check, before planning (and so before the hand-off): reads
 * the one file the builder sends (the first on the link) only when
 * checkedInputFile names an input. A file that can't be read is left to the
 * hand-off, which reads it too.
 */
export async function linkedFileProblem<F>(
  node: ApiNode,
  filesFrom: (link: [string, number]) => F[],
  read: (f: F) => Promise<Uint8Array>,
  families: ReadonlySet<RunnerFamily>,
): Promise<string | null> {
  const name = checkedInputFile(node.class_type, families)
  const link = name ? node.inputs?.[name] : undefined
  if (!isLink(link)) return null
  const f = filesFrom(link as [string, number])[0]
  if (f === undefined) return null
  let bytes: Uint8Array
  try { bytes = await read(f) }
  catch { return null }
  return inputFileProblem(node.class_type, bytes, families)
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
/** The models Veo 3.1's builder serves (video.ts veo31; Lite through veo31Lite.ts). */
export const VEO_31_MODEL_IDS: readonly string[] = ['veo-3.1', 'veo-3.1-fast', 'veo-3.1-lite']

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
 *
 * `runner`: the prompt runs on the Sailor runner (the engine's check). A
 * model that runs on both paths but whose rules are the runner's alone
 * (Krea 2, F17) is judged only then; the ComfyUI path's gate leaves it out.
 */
export function requestProblems(prompt: ApiPrompt, opts: { runner?: boolean } = {}): RequestProblem[] {
  const out: RequestProblem[] = []
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const inputs = node?.inputs ?? {}
    const ct = node?.class_type
    /** The prompt `text` against the rule of `<provider> <endpoint>` (fal unless named). */
    const judge = (endpoint: string, text: string, provider = 'fal') => {
      const key = `${provider} ${endpoint}`
      const rule = PROMPT_MIN_LENGTH[key]
      if (!rule) throw new Error(`No prompt rule for ${key}`)
      const max = PROMPT_MAX_LENGTH[key]
      if (promptLength(key, text) < rule.min) out.push({ nodeId, classType: ct, input: 'prompt', message: rule.message })
      else if (max && chars(text) > max.max) out.push({ nodeId, classType: ct, input: 'prompt', message: max.message })
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
    // Qwen Image 3, Grok Imagine 2 and Nano Banana 2 Lite (Replicate, text-to-image): the prompt as sent must not be empty.
    else if (ct === 'GenerateImageNode' && (isQwenImage3Model(inputs.model) || isGrokImagine2Model(inputs.model) || isNanoBanana2LiteModel(inputs.model))) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      const slug = isQwenImage3Model(inputs.model) ? QWEN_IMAGE_3_SLUG : isGrokImagine2Model(inputs.model) ? GROK_IMAGINE_2_SLUG : NANO_BANANA_2_LITE_SLUG
      judge(slug, composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs: false,
      }), 'replicate')
    }
    // Ideogram 4, Muse Image, Reve 2.1 and Recraft V4.1 (fal, text-to-image): the prompt as sent must
    // not be empty (and, for Reve 2.1 and Recraft V4.1, not over its schema's maxLength).
    else if (ct === 'GenerateImageNode' && (isIdeogram4Model(inputs.model) || isMuseImageModel(inputs.model) || isReve21Model(inputs.model) || isRecraftV41Model(inputs.model))) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      const app = isIdeogram4Model(inputs.model) ? IDEOGRAM_4_FAL_APP
        : isMuseImageModel(inputs.model) ? MUSE_IMAGE_FAL_APP
          : isReve21Model(inputs.model) ? REVE_21_FAL_APP : RECRAFT_V41_FAL_APP
      judge(app, composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs: false,
      }))
    }
    // Krea 2 Large and Medium (fal, text-to-image, F17), on a runner run only: the
    // prompt as sent must not be empty nor over its schema's 5,000 characters.
    else if (ct === 'GenerateImageNode' && isKrea2Model(inputs.model)) {
      if (!opts.runner) continue
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      judge(KREA_2_FAL_APPS[inputs.model], composeImagePrompt({
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
    // Seedream 5 Pro (seedream5ProEdit.ts): a size it makes, and a prompt of 1 to 4,000 characters.
    else if (ct === 'EditImageNode' && isSeedream5ProEdit(inputs.model)) {
      for (const p of seedream5ProEditProblems({ prompt: inputs.prompt, resolution: inputs.resolution })) {
        out.push({ nodeId, classType: ct, input: p.input, message: p.message })
      }
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
      // Veo 3.1 (all three): one first frame at most (their builder refuses the same at planning).
      if (VEO_31_MODEL_IDS.includes(id) && !isLink(inputs.model_options) && veo31HasExtras(parseJsonObject(inputs.model_options))) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: VEO_31_ONE_PICTURE })
      }
      // Gemini Omni Flash: one first frame at most (its builder refuses the same at planning).
      if (id === GEMINI_OMNI_FLASH_ID && !isLink(inputs.model_options) && geminiOmniFlashHasExtras(parseJsonObject(inputs.model_options))) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: GEMINI_OMNI_FLASH_ONE_PICTURE })
      }
      // Gemini Omni Flash text-to-video (no linked picture, no `image_url`): an empty prompt is refused.
      // With the options wired in, the first frame can't be read, so the node isn't judged here.
      if (id === GEMINI_OMNI_FLASH_ID && !isLink(inputs.prompt) && !isLink(inputs.image) && !isLink(inputs.model_options)
        && !geminiOmniFlashFirstFrame(null, parseJsonObject(inputs.model_options))) {
        judge(GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, asText(inputs.prompt))
      }
    }
    // Film a shot on Seedance 2.0 (ComfyUI path only): a first frame beside references is refused,
    // never sent with the references dropped; the counts too (the same check as Generate a video's).
    else if (ct === 'FilmShotNode' && inputs.model === 'seedance-2.0' && !isLink(inputs.model_options)) {
      const p = seedanceReferenceProblem(parseJsonObject(inputs.model_options), isLink(inputs.image))
      if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p.message })
    }
    // Film a shot on Veo 3.1 (ComfyUI path only): Python's builder, like the runner's, sends no last frame
    // and no references, so they are refused with the same words as Generate a video.
    else if (ct === 'FilmShotNode' && VEO_31_MODEL_IDS.includes(resolveVideoModelId(inputs.model)) && !isLink(inputs.model_options)
      && veo31HasExtras(parseJsonObject(inputs.model_options))) {
      out.push({ nodeId, classType: ct, input: 'model_options', message: VEO_31_ONE_PICTURE })
    }
  }
  return out
}
