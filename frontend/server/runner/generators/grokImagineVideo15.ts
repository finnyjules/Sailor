/**
 * Grok Imagine Video 1.5 (xAI; model line-up, Task F19): runner-only, family
 * `grok-imagine-video-1.5`. It makes its own sound from the prompt; it takes
 * no sound in.
 *
 * Three endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-25):
 *
 *   fal (first)    xai/grok-imagine-video/v1.5/text-to-video    no first frame
 *                  xai/grok-imagine-video/v1.5/image-to-video   a first frame
 *                  "Priced per second of output video, by resolution: 480p
 *                  at $0.08/sec, 720p at $0.14/sec, 1080p at $0.25/sec."
 *                  (both llms.txt); image-to-video adds "Each reference
 *                  image adds $0.01", priced on its one picture
 *                  (videoRates.ts inputImageUsd)
 *   Replicate      xai/grok-imagine-video-1.5 (xAI's own, version 2378f08d…),
 *   (the backup)   "This preview release is image-to-video only": 480p or
 *                  720p, $0.08 per second of output video whatever the
 *                  resolution (its model page)
 *
 * The brief put Replicate first. It can't be for the whole model: Replicate
 * has no text-to-video and no 1080p, and a route (twins.ts) and a price
 * (videoRates.ts) name one first service per model. fal is first because it
 * alone takes every setting the node offers; Replicate is the backup where it
 * can carry the request (image-to-video at 480p or 720p), at its lower rate
 * covered at cost, so the price is fal's marked up (twins.ts header).
 *
 * It sends fal, from "Generate a video":
 *   prompt        as typed; both schemas require one and set a maxLength of
 *                 4,096 (refused before sending: requestRules.ts); neither
 *                 sets a minimum, so an empty or spaces-only prompt is refused
 *                 by a ruling (PROMPT_MIN_LENGTH_RULINGS, as Grok Imagine 2's)
 *   aspect_ratio  text-to-video only (the first frame sets the shape): one of
 *                 the node's five that fal lists (fal also takes 3:2 and 2:3,
 *                 which the node's ratio list lacks); anything else 16:9
 *   resolution    480p, 720p or 1080p; anything else 720p (the schema's own
 *                 default, sent rather than relied on)
 *   duration      a whole second from 1 to 15, the closest to the node's
 *   image_url     image-to-video: the linked picture, else `image_url` in the
 *                 node's options
 * No seed on either service.
 *
 * One picture at most: a last frame, reference pictures, or reference videos
 * or sounds left in the node's options are refused in plain words, never
 * dropped (GROK_IMAGINE_VIDEO_15_ONE_PICTURE; requestRules.ts judges the same
 * before the hold). A linked sound never reaches the runner (eligibility.ts).
 * fal's reference-to-video endpoint is not built here.
 *
 * The backup (`grokImagineVideo15OnReplicate`) is built from the fal request:
 * the same prompt, length and resolution, the first frame as `image`, and
 * `aspect_ratio` "auto" (the picture's shape, as fal's image-to-video makes
 * it). None for text-to-video or at 1080p.
 */
import { arOr, firstFrame, hasMediaExtras, optEnum, optStr } from './opts'
import { durOr } from './video'
import type { VideoBuildArgs, VideoModelDesc } from './types'
import type { ServiceCall } from './twins'

export const GROK_IMAGINE_VIDEO_15_ID = 'grok-imagine-video-1.5'
export const GROK_IMAGINE_VIDEO_15_APP = 'xai/grok-imagine-video/v1.5'
export const GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO = `${GROK_IMAGINE_VIDEO_15_APP}/text-to-video`
export const GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO = `${GROK_IMAGINE_VIDEO_15_APP}/image-to-video`
export const GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG = 'xai/grok-imagine-video-1.5'

/** Every fal endpoint the family calls (the backup is GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG). */
export const GROK_IMAGINE_VIDEO_15_ENDPOINTS = [GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO, GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO] as const

/** `duration`: an integer from 1 to 15 (every schema). */
export const GROK_IMAGINE_VIDEO_15_SECONDS: readonly number[] = Array.from({ length: 15 }, (_, i) => i + 1)
/** fal's own default length (Replicate's is 5; always sent). */
export const GROK_IMAGINE_VIDEO_15_DEFAULT_SECONDS = 6
/** fal `resolution` (both endpoints). */
export const GROK_IMAGINE_VIDEO_15_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export const GROK_IMAGINE_VIDEO_15_DEFAULT_RESOLUTION = '720p'
/** Replicate `resolution`: a request at 1080p has no backup. */
export const GROK_IMAGINE_VIDEO_15_REPLICATE_RESOLUTIONS: ReadonlySet<string> = new Set(['480p', '720p'])
/** fal text-to-video `aspect_ratio`. */
const FAL_AR = new Set(['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'])
/** Both fal prompts' `maxLength`. */
export const GROK_IMAGINE_VIDEO_15_PROMPT_MAX = 4096

export const GROK_IMAGINE_VIDEO_15_ONE_PICTURE
  = 'Grok Imagine Video 1.5 starts from one picture at most and takes no sound. Remove the last frame and any reference pictures, videos or sounds, or pick another model.'
export const GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT = 'Grok Imagine Video 1.5 needs a prompt. Describe the clip, or how the picture should move.'
export const GROK_IMAGINE_VIDEO_15_LONG_PROMPT = 'Grok Imagine Video 1.5 takes a prompt of at most 4,096 characters. Shorten it.'

/** The clip length sent: the whole second from 1 to 15 closest to the node's. */
export function grokImagineVideo15Seconds(duration: number): number {
  return durOr([...GROK_IMAGINE_VIDEO_15_SECONDS], duration, GROK_IMAGINE_VIDEO_15_DEFAULT_SECONDS)
}

/** The request for either fal endpoint; `image_url` (a first frame) sends it to image-to-video. */
export function grokImagineVideo15(a: VideoBuildArgs): Record<string, unknown> {
  const { prompt, aspectRatio, duration, image, adv } = a
  if (hasMediaExtras(adv, { lastFrame: true })) throw new Error(GROK_IMAGINE_VIDEO_15_ONE_PICTURE)
  const first = firstFrame(image, adv)
  const inp: Record<string, unknown> = first ? { image_url: first, prompt } : { prompt, aspect_ratio: arOr(FAL_AR, aspectRatio, '16:9') }
  inp.resolution = optEnum(
    { resolution: optStr(adv, 'resolution', GROK_IMAGINE_VIDEO_15_DEFAULT_RESOLUTION).toLowerCase() },
    'resolution', GROK_IMAGINE_VIDEO_15_RESOLUTIONS, GROK_IMAGINE_VIDEO_15_DEFAULT_RESOLUTION,
  )
  inp.duration = grokImagineVideo15Seconds(duration)
  return inp
}

/**
 * The backup: the same clip on Replicate, from the fal request. Null for
 * text-to-video (Replicate's is image-to-video only) and at 1080p (Replicate
 * makes 480p or 720p): no backup then.
 */
export function grokImagineVideo15OnReplicate(falPayload: Record<string, unknown>): ServiceCall | null {
  if (typeof falPayload.image_url !== 'string') return null
  if (!GROK_IMAGINE_VIDEO_15_REPLICATE_RESOLUTIONS.has(String(falPayload.resolution))) return null
  return {
    provider: 'replicate',
    endpoint: GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG,
    payload: {
      prompt: falPayload.prompt,
      image: falPayload.image_url,
      duration: falPayload.duration,
      resolution: falPayload.resolution,
      // The picture's own shape, as fal's image-to-video (which takes no ratio) makes it.
      aspect_ratio: 'auto',
    },
  }
}

export const GROK_IMAGINE_VIDEO_15: VideoModelDesc = {
  id: GROK_IMAGINE_VIDEO_15_ID,
  label: 'Grok Imagine Video 1.5',
  app: GROK_IMAGINE_VIDEO_15_APP,
  defaultDuration: GROK_IMAGINE_VIDEO_15_DEFAULT_SECONDS,
  // No reference mode: the builder never sends references.
  fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video' },
  build: grokImagineVideo15,
}

/** Grok Imagine Video 1.5 by id (planNode's lookup). */
export const RUNNER_GROK_IMAGINE_VIDEO_15_MODELS: Readonly<Record<string, VideoModelDesc>> = {
  [GROK_IMAGINE_VIDEO_15_ID]: GROK_IMAGINE_VIDEO_15,
}
