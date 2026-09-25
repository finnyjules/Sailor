/**
 * HappyHorse 1.1 (Alibaba; model line-up, Task F18): runner-only, family
 * `happyhorse-1.1`. It makes its sound itself, dialogue and lip-sync
 * included, from the prompt: it takes no sound in.
 *
 * Three endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-25):
 *
 *   fal (first)    alibaba/happy-horse/v1.1/text-to-video    no first frame
 *                  alibaba/happy-horse/v1.1/image-to-video   a first frame
 *                  "For every second of 720p video you generated, you will
 *                  be charged $0.14/second. For 1080p video you will be
 *                  charged $0.18/second." (both llms.txt)
 *   Replicate      alibaba/happyhorse-1.1 (Alibaba's own, version 57e8eee0…),
 *   (the backup)   one model for both modes: no picture is text-to-video, one
 *                  in `images` is image-to-video. Billing: 720p $0.14, 1080p
 *                  $0.18 per second of output video (its model page).
 *
 * The two services charge the same, so "cheaper first" is a tie. fal is first
 * for the better fit: it takes every ratio the node offers (Replicate has no
 * 21:9) and pictures up to 20 MB (Replicate 10 MB), and names each mode's
 * endpoint.
 *
 * It sends fal, from "Generate a video":
 *   prompt        as typed; text-to-video's schema asks for at least 1
 *                 character (refused before sending: requestRules.ts), and
 *                 image-to-video's is optional. Both schemas' descriptions say
 *                 "Max 2500 characters" (no maxLength): a longer prompt is
 *                 refused before sending (controller ruling, F18 fix round 1)
 *   aspect_ratio  text-to-video only (the first frame sets the shape): one of
 *                 the node's six (fal's schema also lists 9:21, 5:4 and 4:5,
 *                 which the node's ratio list lacks); anything else 16:9
 *   resolution    720p or 1080p; anything else 720p (Sailor's default: the
 *                 schema's own default, 1080p, is never relied on)
 *   duration      a whole second from 3 to 15, the closest to the node's
 *   seed          at most 2³¹ − 1 (the schema's range; a larger one wraps,
 *                 still repeatable); 0 sends none
 *   image_url     image-to-video: the linked picture, else `image_url` in the
 *                 node's options
 * Not sent: `enable_safety_checker` (the schema's default applies).
 *
 * One picture at most: a last frame, reference pictures, or reference videos
 * or sounds left in the node's options are refused in plain words, never
 * dropped (HAPPYHORSE_11_ONE_PICTURE; requestRules.ts judges the same before
 * the hold). A linked sound never reaches the runner (eligibility.ts). fal's
 * reference-to-video endpoint is not built here.
 *
 * The backup (`happyHorse11OnReplicate`) is built from the fal request: the
 * same prompt, length, resolution and seed; the first frame as the one
 * picture in `images`, or the ratio without one. Replicate's ratios are 16:9,
 * 9:16, 1:1, 4:3 and 3:4, so a 21:9 request has no backup. A picture over
 * Replicate's 10 MB can't be seen from the request; the backup refuses it
 * like any other failed job.
 *
 * The picture's size (F18 fix round 1, controller ruling): the engine reads
 * the linked picture's bytes before anything is uploaded (requestRules.ts
 * linkedFileCheck). Over fal's 20 MB the node is refused; over Replicate's
 * 10 MB it runs on fal with no backup for that run. Both limits are read as
 * the smaller number (20,000,000 and 10,000,000 bytes), as Product shot's.
 */
import { arOr, firstFrame, hasMediaExtras, maybeSetSeed, optEnum, optStr } from './opts'
import { durOr } from './video'
import type { VideoBuildArgs, VideoModelDesc } from './types'
import type { ServiceCall } from './twins'

export const HAPPYHORSE_11_ID = 'happyhorse-1.1'
export const HAPPYHORSE_11_APP = 'alibaba/happy-horse/v1.1'
export const HAPPYHORSE_11_TEXT_TO_VIDEO = `${HAPPYHORSE_11_APP}/text-to-video`
export const HAPPYHORSE_11_IMAGE_TO_VIDEO = `${HAPPYHORSE_11_APP}/image-to-video`
export const HAPPYHORSE_11_REPLICATE_SLUG = 'alibaba/happyhorse-1.1'

/** Every fal endpoint the family calls (the backup is HAPPYHORSE_11_REPLICATE_SLUG). */
export const HAPPYHORSE_11_ENDPOINTS = [HAPPYHORSE_11_TEXT_TO_VIDEO, HAPPYHORSE_11_IMAGE_TO_VIDEO] as const

/** `duration`: an integer from 3 to 15 (both services). */
export const HAPPYHORSE_11_SECONDS: readonly number[] = Array.from({ length: 13 }, (_, i) => i + 3)
/** Both schemas' own default length. */
export const HAPPYHORSE_11_DEFAULT_SECONDS = 5
/** `resolution` (both services). */
export const HAPPYHORSE_11_RESOLUTIONS = ['720p', '1080p'] as const
export const HAPPYHORSE_11_DEFAULT_RESOLUTION = '720p'
/** fal text-to-video `aspect_ratio`. */
const FAL_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '5:4', '4:5'])
/** Replicate `aspect_ratio`: a request at any other ratio has no backup. */
export const HAPPYHORSE_11_REPLICATE_RATIOS: ReadonlySet<string> = new Set(['16:9', '9:16', '1:1', '4:3', '3:4'])
/** `seed` range (both schemas' descriptions: 0–2147483647). */
const SEED_MAX = 2147483647

export const HAPPYHORSE_11_ONE_PICTURE
  = 'HappyHorse 1.1 starts from one picture at most and takes no sound. Remove the last frame and any reference pictures, videos or sounds, or pick another model.'
export const HAPPYHORSE_11_NEEDS_PROMPT = 'HappyHorse 1.1 needs a prompt. Describe the clip, or link a picture to start from it.'
/** Both fal schemas' prompt descriptions: "Max 2500 characters." (no maxLength; a ruling). */
export const HAPPYHORSE_11_PROMPT_MAX = 2500
export const HAPPYHORSE_11_LONG_PROMPT = 'HappyHorse 1.1 takes a prompt of at most 2,500 characters. Shorten it.'
/** fal image-to-video `image_url`: "Max 20 MB." */
export const HAPPYHORSE_11_MAX_PICTURE_BYTES = 20_000_000
/** Replicate `images`: "<=10MB each". A larger picture runs with no backup. */
export const HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES = 10_000_000
export const HAPPYHORSE_11_PICTURE_TOO_LARGE = 'HappyHorse 1.1 takes pictures up to 20 MB. Make this one smaller first.'

/** The clip length sent: the whole second from 3 to 15 closest to the node's. */
export function happyHorse11Seconds(duration: number): number {
  return durOr([...HAPPYHORSE_11_SECONDS], duration, HAPPYHORSE_11_DEFAULT_SECONDS)
}

/** The request for either fal endpoint; `image_url` (a first frame) sends it to image-to-video. */
export function happyHorse11(a: VideoBuildArgs): Record<string, unknown> {
  const { prompt, aspectRatio, duration, seed, image, adv } = a
  if (hasMediaExtras(adv, { lastFrame: true })) throw new Error(HAPPYHORSE_11_ONE_PICTURE)
  const first = firstFrame(image, adv)
  const inp: Record<string, unknown> = first ? { image_url: first, prompt } : { prompt, aspect_ratio: arOr(FAL_AR, aspectRatio, '16:9') }
  inp.resolution = optEnum(
    { resolution: optStr(adv, 'resolution', HAPPYHORSE_11_DEFAULT_RESOLUTION).toLowerCase() },
    'resolution', HAPPYHORSE_11_RESOLUTIONS, HAPPYHORSE_11_DEFAULT_RESOLUTION,
  )
  inp.duration = happyHorse11Seconds(duration)
  maybeSetSeed(inp, seed > SEED_MAX ? ((seed - 1) % SEED_MAX) + 1 : seed)
  return inp
}

/**
 * The backup: the same clip on Replicate, from the fal request. Null when the
 * request's ratio is one Replicate doesn't take (21:9): no backup then.
 */
export function happyHorse11OnReplicate(falPayload: Record<string, unknown>): ServiceCall | null {
  const inp: Record<string, unknown> = { prompt: falPayload.prompt }
  if (typeof falPayload.image_url === 'string') inp.images = [falPayload.image_url]
  else if (HAPPYHORSE_11_REPLICATE_RATIOS.has(String(falPayload.aspect_ratio))) inp.aspect_ratio = falPayload.aspect_ratio
  else return null
  inp.resolution = falPayload.resolution
  inp.duration = falPayload.duration
  if (falPayload.seed !== undefined) inp.seed = falPayload.seed
  return { provider: 'replicate', endpoint: HAPPYHORSE_11_REPLICATE_SLUG, payload: inp }
}

export const HAPPYHORSE_11: VideoModelDesc = {
  id: HAPPYHORSE_11_ID,
  label: 'HappyHorse 1.1',
  app: HAPPYHORSE_11_APP,
  defaultDuration: HAPPYHORSE_11_DEFAULT_SECONDS,
  // No reference mode: the builder never sends references.
  fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video' },
  build: happyHorse11,
}

/** HappyHorse 1.1 by id (planNode's lookup). */
export const RUNNER_HAPPYHORSE_11_MODELS: Readonly<Record<string, VideoModelDesc>> = {
  [HAPPYHORSE_11_ID]: HAPPYHORSE_11,
}
