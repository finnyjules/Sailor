/**
 * Gemini Omni Flash (model line-up, Task F4): runner-only, family
 * `gemini-omni-flash`, on fal.
 *
 * Two fal endpoints, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/fal/google__gemini-omni-flash*.json,
 * read 2026-09-24):
 *   google/gemini-omni-flash                  text-to-video (the bare app id:
 *                                             fal has no `/text-to-video`, a GET
 *                                             of that id is a 404)
 *   google/gemini-omni-flash/image-to-video   a first frame (the linked picture,
 *                                             else `image_url` in the options)
 *
 * Both take only `prompt`, `aspect_ratio` (16:9 or 9:16) and `duration` (a
 * whole second from 3 to 10; the node offers 4, 6, 8 and 10), plus `image_url`
 * on image-to-video. There is no resolution (fal renders 720p), no seed, no
 * negative prompt and no sound switch (the clip always has sound).
 *
 * Not built here:
 *  - `google/gemini-omni-flash/reference-to-video` (reference pictures) and
 *    `google/gemini-omni-flash/edit` (video editing, which needs a video input
 *    on Generate a video: a later task, ruling 4).
 * So a last frame, or reference pictures, videos or sounds left in the node's
 * options, are refused in plain words rather than dropped
 * (GEMINI_OMNI_FLASH_ONE_PICTURE; requestRules.ts judges it before the hold).
 *
 * No backup service: Replicate's nearest model, google/gemini-omni-1.1
 * (version ca4def55…, read 2026-09-24), has no length setting (so it can't
 * carry the seconds the price reads), offers 360p to 4k, and is named a
 * different version. google/gemini-omni-flash on Replicate is a 404.
 */
import { durOr } from './video'
import { arOr, firstFrame, hasMediaExtras } from './opts'
import type { VideoBuildArgs, VideoModelDesc } from './types'

export const GEMINI_OMNI_FLASH_ID = 'gemini-omni-flash'
export const GEMINI_OMNI_FLASH_APP = 'google/gemini-omni-flash'
/** Text-to-video is the app itself (its schema's x-fal-metadata.endpointId). */
export const GEMINI_OMNI_FLASH_TEXT_TO_VIDEO = GEMINI_OMNI_FLASH_APP
export const GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO = `${GEMINI_OMNI_FLASH_APP}/image-to-video`

/** Every endpoint the family calls. */
export const GEMINI_OMNI_FLASH_ENDPOINTS = [GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO] as const

/** The lengths the node offers (the schema takes 3–10 s); anything else is sent as the closest. */
export const GEMINI_OMNI_FLASH_SECONDS = [4, 6, 8, 10]
/** The schema's own default length. */
export const GEMINI_OMNI_FLASH_DEFAULT_SECONDS = 8
const ASPECT_RATIOS = new Set(['16:9', '9:16'])

export const GEMINI_OMNI_FLASH_ONE_PICTURE
  = 'Gemini Omni Flash starts from one picture at most. Remove the last frame and any reference pictures, videos or sounds, or pick another model.'

/** The request for either endpoint; `image_url` (a first frame) sends it to image-to-video. */
export function geminiOmniFlash(a: VideoBuildArgs): Record<string, unknown> {
  const { prompt, aspectRatio, duration, image, adv } = a
  if (hasMediaExtras(adv, { lastFrame: true })) throw new Error(GEMINI_OMNI_FLASH_ONE_PICTURE)
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(ASPECT_RATIOS, aspectRatio, '16:9'),
    duration: durOr(GEMINI_OMNI_FLASH_SECONDS, duration, GEMINI_OMNI_FLASH_DEFAULT_SECONDS),
  }
  const first = firstFrame(image, adv)
  if (first) inp.image_url = first
  return inp
}

export const GEMINI_OMNI_FLASH: VideoModelDesc = {
  id: GEMINI_OMNI_FLASH_ID,
  label: 'Gemini Omni Flash',
  app: GEMINI_OMNI_FLASH_APP,
  defaultDuration: GEMINI_OMNI_FLASH_DEFAULT_SECONDS,
  // '' submits to the app itself (text-to-video).
  fnByMode: { t2v: '', firstLast: 'image-to-video' },
  build: geminiOmniFlash,
}

/** Gemini Omni Flash by id (planNode's lookup). */
export const RUNNER_GEMINI_OMNI_FLASH_MODELS: Readonly<Record<string, VideoModelDesc>> = {
  [GEMINI_OMNI_FLASH_ID]: GEMINI_OMNI_FLASH,
}
