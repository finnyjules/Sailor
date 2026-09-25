/**
 * Wan 3.0 (model line-up, Task F1): runner-only, family `wan-3`.
 *
 * Four fal endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/fal/alibaba__wan-3.0*.json, read
 * 2026-09-24):
 *   alibaba/wan-3.0/text-to-video        wan-3.0, no first frame, no references
 *   alibaba/wan-3.0/image-to-video       wan-3.0 with a first frame (and an optional last frame)
 *   alibaba/wan-3.0/reference-to-video   wan-3.0 with reference pictures and no first frame
 *   alibaba/wan-3.0-prime/image-to-video wan-3.0-prime, which always has a first frame
 *
 * The node's settings, as the schemas name them:
 *   duration          `duration`, a whole second from 2 to 30 (the closest one)
 *   resolution        `resolution` 480p / 720p / 1080p; anything else 720p
 *   generate_audio    `audio`, on unless turned off
 *   enhance_prompt    `enable_prompt_expansion`, on unless turned off
 *   seed              `seed`, at most 2³¹ − 1 (a larger one wraps, still repeatable); 0 sends none
 *   aspect ratio      `aspect_ratio` without a first frame; with one the
 *                     picture sets it (the schema's "adaptive" default)
 *
 * The first frame is the linked picture, else `image_url` in the node's
 * options; the last frame is `end_image_url`, sent only beside a first frame.
 * Reference pictures are `image_urls` in the options, where Shot Director
 * writes Seedance 2.0's (video.ts seedance20): at most 10. A first frame AND
 * references (pictures, videos or sounds) is refused in plain words
 * (FIRST_FRAME_AND_REFERENCES), never sent with the references dropped. No
 * control sets references or a last frame yet (Shot Director drives only
 * Seedance); the catalogue text doesn't offer them. Shot Director's prompt
 * tags (`@Image1`) are rewritten to Wan's positional words ("Image 1").
 * Reference videos and sounds, video editing and document-to-video are a
 * later task (line-up ruling 4): options carrying reference videos or sounds
 * are refused in plain words, not sent without them.
 *
 * No backup service (line-up Ruling 11): Replicate's alibaba/wan-3 (read
 * 2026-09-24) has no sound switch, no last frame and no reference pictures,
 * and its page still shows an expired half-price offer, so it can't carry
 * every setting these requests carry. Not sent: `enable_thinking`,
 * `enable_safety_checker`, `web_url`, `file_url` (the schemas' defaults apply).
 */
import { arOr, maybeSetSeed, optBool, optEnum, optStr } from './opts'
import type { VideoBuildArgs } from './types'
import { durOr } from './video'
import type { ServiceCall } from './twins'

export const WAN_30_APP = 'alibaba/wan-3.0'
export const WAN_30_PRIME_APP = 'alibaba/wan-3.0-prime'
export const WAN_30_TEXT_TO_VIDEO = `${WAN_30_APP}/text-to-video`
export const WAN_30_IMAGE_TO_VIDEO = `${WAN_30_APP}/image-to-video`
export const WAN_30_REFERENCE_TO_VIDEO = `${WAN_30_APP}/reference-to-video`
export const WAN_30_PRIME_IMAGE_TO_VIDEO = `${WAN_30_PRIME_APP}/image-to-video`

/** Every endpoint the family calls. */
export const WAN_3_ENDPOINTS = [WAN_30_TEXT_TO_VIDEO, WAN_30_IMAGE_TO_VIDEO, WAN_30_REFERENCE_TO_VIDEO, WAN_30_PRIME_IMAGE_TO_VIDEO] as const

/** `duration`: an integer from 2 to 30 (each schema). */
export const WAN_3_SECONDS: readonly number[] = Array.from({ length: 29 }, (_, i) => i + 2)
export const WAN_3_DEFAULT_SECONDS = 5
/** `resolution` (each schema). Sailor's default is 720p; the schema's own default is 1080p, which is never relied on. */
export const WAN_3_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export const WAN_3_DEFAULT_RESOLUTION = '720p'
/** `aspect_ratio` without "adaptive" (the node always names a ratio); anything else 16:9. */
const WAN_3_AR = new Set(['16:9', '4:3', '1:1', '3:4', '9:16'])
/** `reference_image_urls` maxItems. */
export const WAN_3_MAX_REFERENCE_PICTURES = 10
/** `seed` maximum (each schema). */
const WAN_3_SEED_MAX = 2147483647

export const WAN_3_NEEDS_PROMPT = 'Wan 3.0 needs a prompt.'
export const WAN_3_TOO_MANY_REFERENCES = `Wan 3.0 takes at most ${WAN_3_MAX_REFERENCE_PICTURES} reference pictures.`
export const WAN_3_PICTURES_ONLY = 'Wan 3.0 takes reference pictures only for now, not reference videos or sounds.'
export const WAN_3_PRIME_NEEDS_FIRST_FRAME = 'Wan 3.0 Prime needs a first frame: link a picture.'
/** A first frame and references together (Wan 3.0 and Seedance 2.0): refused, never a silent drop. */
export const FIRST_FRAME_AND_REFERENCES = 'Pick either a first frame or reference pictures, not both.'

export type Wan3Id = 'wan-3.0' | 'wan-3.0-prime'
export type Wan3Mode = 'text' | 'image' | 'reference'

/** The first frame the request carries: the linked picture, else the options' `image_url`. */
export function wan3FirstFrame(image: string | null, adv: Record<string, unknown>): string {
  return image || optStr(adv, 'image_url', '')
}

/** The reference pictures in the options (Shot Director's `image_urls`), or null for none. */
export function wan3ReferencePictures(adv: Record<string, unknown>): unknown[] | null {
  const v = adv.image_urls
  return Array.isArray(v) && v.length ? v : null
}

/** Whether the options carry any reference: pictures, videos or sounds. */
export function wan3HasAnyReferences(adv: Record<string, unknown>): boolean {
  return !!wan3ReferencePictures(adv) || wan3HasMediaReferences(adv)
}

/**
 * Shot Director's reference tags (`@Image1`, `@Video2`, `@Audio1`) as the
 * positional words Wan 3.0's schema reads ("the subject in Image 1").
 */
export function wan3PromptTags(prompt: string): string {
  return prompt.replace(/@(Image|Video|Audio)(\d+)/g, '$1 $2')
}

/** Whether the options carry reference videos or sounds (a later task; refused). */
export function wan3HasMediaReferences(adv: Record<string, unknown>): boolean {
  return ['video_urls', 'audio_urls'].some(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
}

/**
 * Which endpoint a request goes to: Prime always image-to-video; Wan 3.0
 * image-to-video with a first frame, reference-to-video with reference
 * pictures and no first frame, else text-to-video.
 */
export function wan3Mode(id: Wan3Id, hasFirstFrame: boolean, adv: Record<string, unknown>): Wan3Mode {
  if (id === 'wan-3.0-prime' || hasFirstFrame) return 'image'
  return wan3ReferencePictures(adv) ? 'reference' : 'text'
}

/** The settings every Wan 3.0 endpoint shares, in the schemas' order. */
function common({ prompt, duration, seed, adv }: VideoBuildArgs): Record<string, unknown> {
  const inp: Record<string, unknown> = {
    prompt,
    resolution: optEnum({ resolution: optStr(adv, 'resolution', WAN_3_DEFAULT_RESOLUTION).toLowerCase() }, 'resolution', WAN_3_RESOLUTIONS, WAN_3_DEFAULT_RESOLUTION),
    duration: wan3Seconds(duration),
    audio: optBool(adv, 'generate_audio', true),
    enable_prompt_expansion: optBool(adv, 'enhance_prompt', true),
  }
  maybeSetSeed(inp, seed > WAN_3_SEED_MAX ? ((seed - 1) % WAN_3_SEED_MAX) + 1 : seed)
  return inp
}

/** The clip length sent: the whole second from 2 to 30 closest to the node's (video.ts durOr). */
export function wan3Seconds(duration: number): number {
  return durOr([...WAN_3_SECONDS], duration, WAN_3_DEFAULT_SECONDS)
}

/** alibaba/wan-3.0/text-to-video. */
export function wan30TextToVideo(a: VideoBuildArgs): Record<string, unknown> {
  if (wan3HasMediaReferences(a.adv)) throw new Error(WAN_3_PICTURES_ONLY)
  return { ...common(a), aspect_ratio: arOr(WAN_3_AR, a.aspectRatio, '16:9') }
}

/** image-to-video (standard and Prime share the schema): the first frame, and the last one if set. */
function imageToVideo(a: VideoBuildArgs, missing: string): Record<string, unknown> {
  const first = wan3FirstFrame(a.image, a.adv)
  if (!first) throw new Error(missing)
  if (wan3HasAnyReferences(a.adv)) throw new Error(FIRST_FRAME_AND_REFERENCES)
  const inp: Record<string, unknown> = { ...common(a), start_image_url: first }
  const last = optStr(a.adv, 'end_image_url', '')
  if (last) inp.end_image_url = last
  return inp
}

/** alibaba/wan-3.0/image-to-video. */
export function wan30ImageToVideo(a: VideoBuildArgs): Record<string, unknown> {
  return imageToVideo(a, 'Wan 3.0 image-to-video needs a first frame.')
}

/** alibaba/wan-3.0-prime/image-to-video. */
export function wan30PrimeImageToVideo(a: VideoBuildArgs): Record<string, unknown> {
  return imageToVideo(a, WAN_3_PRIME_NEEDS_FIRST_FRAME)
}

/** alibaba/wan-3.0/reference-to-video: the pictures in the order the options list them; `@Image1` tags as "Image 1". */
export function wan30ReferenceToVideo(a: VideoBuildArgs): Record<string, unknown> {
  if (wan3HasMediaReferences(a.adv)) throw new Error(WAN_3_PICTURES_ONLY)
  const refs = wan3ReferencePictures(a.adv)
  if (!refs) throw new Error('Wan 3.0 reference-to-video needs a reference picture.')
  return { ...common({ ...a, prompt: wan3PromptTags(a.prompt) }), aspect_ratio: arOr(WAN_3_AR, a.aspectRatio, '16:9'), reference_image_urls: [...refs] }
}

/** The family's models, each with its label and clip default. */
export const RUNNER_WAN3_MODELS: Readonly<Record<Wan3Id, { id: Wan3Id, label: string, defaultDuration: number }>> = {
  'wan-3.0': { id: 'wan-3.0', label: 'Wan 3.0', defaultDuration: WAN_3_DEFAULT_SECONDS },
  'wan-3.0-prime': { id: 'wan-3.0-prime', label: 'Wan 3.0 Prime', defaultDuration: WAN_3_DEFAULT_SECONDS },
}

export function isWan3Model(id: string): id is Wan3Id {
  return Object.prototype.hasOwnProperty.call(RUNNER_WAN3_MODELS, id)
}

/** The request for one Wan 3.0 node: its endpoint (by mode) and payload. fal only; no backup. */
export function wan3Call(id: Wan3Id, a: VideoBuildArgs): ServiceCall {
  const mode = wan3Mode(id, !!wan3FirstFrame(a.image, a.adv), a.adv)
  if (id === 'wan-3.0-prime') return { provider: 'fal', endpoint: WAN_30_PRIME_IMAGE_TO_VIDEO, payload: wan30PrimeImageToVideo(a) }
  if (mode === 'image') return { provider: 'fal', endpoint: WAN_30_IMAGE_TO_VIDEO, payload: wan30ImageToVideo(a) }
  if (mode === 'reference') return { provider: 'fal', endpoint: WAN_30_REFERENCE_TO_VIDEO, payload: wan30ReferenceToVideo(a) }
  return { provider: 'fal', endpoint: WAN_30_TEXT_TO_VIDEO, payload: wan30TextToVideo(a) }
}
