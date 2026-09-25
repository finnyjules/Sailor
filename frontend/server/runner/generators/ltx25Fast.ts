/**
 * LTX-2.5 Fast (Lightricks; model line-up, Task F20): runner-only, family
 * `ltx-2.5-fast`. It replaces the hidden LTX-Video in the gallery; that model
 * stays hidden and runs for saved projects as before (video.ts ltxVideo).
 *
 * Three endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-25):
 *
 *   Replicate      lightricks/ltx-2.5-fast (Lightricks' own, version 52475fac…),
 *   (first)        one model for both modes: a picture in `image` makes it
 *                  image-to-video. Billing "per second of output video" by
 *                  target resolution: 720p $0.03, 1080p $0.06, 2k $0.12,
 *                  4k $0.24 (its model page)
 *   fal            lightricks/ltx-2.5/text-to-video/fast   no first frame
 *   (the backup)   lightricks/ltx-2.5/image-to-video/fast  a first frame
 *                  "For 720p, your request will cost $0.09 per second; for
 *                  1080p, $0.13 per second; for 1440p, $0.19 per second; and
 *                  for 4K, $0.30 per second." (both llms.txt)
 *
 * Replicate is first: it is a third to a half of fal's price at every
 * resolution the node offers, and it alone makes 2 to 5 second clips (fal's
 * shortest is 6 s).
 *
 * It sends Replicate, from "Generate a video":
 *   prompt            as typed; the schema requires one and sets no limits, so
 *                     an empty or spaces-only prompt is refused by a ruling
 *                     (requestRules.ts PROMPT_MIN_LENGTH_RULINGS)
 *   image             the first frame: the linked picture, else `image_url` in
 *                     the node's options; none for text-to-video
 *   last_frame_image  `end_image_url` in the options, beside a first frame only
 *                     (a last frame alone is refused)
 *   duration          2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18 or 20: the closest
 *                     to the node's. Over 10 s only at 720p or 1080p (the
 *                     schema's description): a longer 4k clip is refused
 *   resolution        720p, 1080p or 4k; anything else 1080p (the schema's own
 *                     default, sent rather than relied on). 2k is not offered
 *   aspect_ratio      16:9 or 9:16, in both modes; anything else 16:9
 *   generate_audio    the node's "Generate audio" option (default on)
 * No seed on either service. No frame-rate setting: both default to 25 fps,
 * the rate that allows clips over 10 s.
 *
 * Reference pictures, videos or sounds left in the node's options are
 * refused in plain words, never dropped (LTX_25_FAST_EXTRAS; requestRules.ts
 * judges the same before the hold). A linked sound never reaches the runner
 * (eligibility.ts).
 *
 * The backup (`ltx25FastOnFal`) is built from the Replicate request: the same
 * prompt, frames, length, resolution (4k is fal's 2160p), ratio and sound.
 * None for a clip shorter than 6 s (fal has none), and none for a prompt over
 * fal's 5,000 characters (planNode drops a backup its own service refuses).
 */
import { durOr } from './video'
import { optBool, optStr } from './opts'
import type { VideoBuildArgs } from './types'
import type { ServiceCall } from './twins'

export const LTX_25_FAST_ID = 'ltx-2.5-fast'
export const LTX_25_FAST_REPLICATE_SLUG = 'lightricks/ltx-2.5-fast'
export const LTX_25_FAST_TEXT_TO_VIDEO = 'lightricks/ltx-2.5/text-to-video/fast'
export const LTX_25_FAST_IMAGE_TO_VIDEO = 'lightricks/ltx-2.5/image-to-video/fast'

/** Every fal endpoint the family calls (the backup); the first service is LTX_25_FAST_REPLICATE_SLUG. */
export const LTX_25_FAST_FAL_ENDPOINTS = [LTX_25_FAST_TEXT_TO_VIDEO, LTX_25_FAST_IMAGE_TO_VIDEO] as const

/** Replicate `duration` (its enum). */
export const LTX_25_FAST_SECONDS: readonly number[] = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20]
/** Replicate's own default length (fal's is "auto"; always sent). */
export const LTX_25_FAST_DEFAULT_SECONDS = 6
/** fal `duration` (its enum, less "auto"): a shorter clip has no backup. */
export const LTX_25_FAST_FAL_SECONDS: ReadonlySet<number> = new Set([6, 8, 10, 12, 14, 16, 18, 20])
/** The resolutions the node offers (Replicate's names). */
export const LTX_25_FAST_RESOLUTIONS = ['720p', '1080p', '4k'] as const
export const LTX_25_FAST_DEFAULT_RESOLUTION = '1080p'
/** Replicate's resolution → fal's name for it. */
export const LTX_25_FAST_FAL_RESOLUTION: Readonly<Record<string, string>> = { '720p': '720p', '1080p': '1080p', '4k': '2160p' }
/** Over this many seconds, only 720p and 1080p (both schemas' duration descriptions, at 24 or 25 fps). */
export const LTX_25_FAST_LONG_SECONDS = 10
const LONG_OK: ReadonlySet<string> = new Set(['720p', '1080p'])
/** Both services' `aspect_ratio` (fal's image-to-video also takes "auto", not sent). */
const AR: ReadonlySet<string> = new Set(['16:9', '9:16'])
/** Both fal prompts' `maxLength` (the backup's; Replicate states none). */
export const LTX_25_FAST_FAL_PROMPT_MAX = 5000

export const LTX_25_FAST_EXTRAS
  = 'LTX-2.5 Fast starts from a first picture and, if you like, a last one. It takes no reference pictures, videos or sounds. Remove them, or pick another model.'
export const LTX_25_FAST_LAST_NEEDS_FIRST = 'LTX-2.5 Fast needs a first picture to end on a last one. Link a first picture, or remove the last one.'
export const LTX_25_FAST_TOO_LONG_AT_4K = 'LTX-2.5 Fast makes clips over 10 seconds only at 720p or 1080p. Pick a shorter clip or a lower resolution.'
export const LTX_25_FAST_NEEDS_PROMPT = 'LTX-2.5 Fast needs a prompt. Describe the clip, or how the picture should move.'
export const LTX_25_FAST_LONG_PROMPT = 'LTX-2.5 Fast takes a prompt of at most 5,000 characters. Shorten it.'

/** The first frame: the linked picture, else `image_url` in the options, else ''. */
export function ltx25FastFirstFrame(image: string | null, adv: Record<string, unknown>): string {
  return image || optStr(adv, 'image_url', '')
}

/** True when the options carry what neither service takes: reference pictures, videos or sounds. */
export function ltx25FastHasExtras(adv: Record<string, unknown>): boolean {
  return ['image_urls', 'video_urls', 'audio_urls'].some(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
}

/** The clip length sent: the closest of Replicate's lengths to the node's. */
export function ltx25FastSeconds(duration: number): number {
  return durOr([...LTX_25_FAST_SECONDS], duration, LTX_25_FAST_DEFAULT_SECONDS)
}

/** The resolution sent: 720p, 1080p or 4k (any case); anything else 1080p. */
export function ltx25FastResolution(adv: Record<string, unknown>): string {
  const r = optStr(adv, 'resolution', LTX_25_FAST_DEFAULT_RESOLUTION).toLowerCase()
  return (LTX_25_FAST_RESOLUTIONS as readonly string[]).includes(r) ? r : LTX_25_FAST_DEFAULT_RESOLUTION
}

/**
 * What neither service would take in these settings, or null: references;
 * a last frame with no first; a clip over 10 s at 4k. `firstFrame`: a first
 * frame is linked or in the options.
 */
export function ltx25FastProblem(adv: Record<string, unknown>, duration: number, firstFrame: boolean): string | null {
  if (ltx25FastHasExtras(adv)) return LTX_25_FAST_EXTRAS
  if (optStr(adv, 'end_image_url', '') && !firstFrame) return LTX_25_FAST_LAST_NEEDS_FIRST
  if (ltx25FastSeconds(duration) > LTX_25_FAST_LONG_SECONDS && !LONG_OK.has(ltx25FastResolution(adv))) return LTX_25_FAST_TOO_LONG_AT_4K
  return null
}

/** The Replicate request (the first service). Throws the plain message for settings neither service takes. */
export function ltx25Fast(a: VideoBuildArgs): Record<string, unknown> {
  const { prompt, aspectRatio, duration, image, adv } = a
  const first = ltx25FastFirstFrame(image, adv)
  const problem = ltx25FastProblem(adv, duration, !!first)
  if (problem) throw new Error(problem)
  const inp: Record<string, unknown> = { prompt }
  if (first) {
    inp.image = first
    const last = optStr(adv, 'end_image_url', '')
    if (last) inp.last_frame_image = last
  }
  inp.duration = ltx25FastSeconds(duration)
  inp.resolution = ltx25FastResolution(adv)
  inp.aspect_ratio = AR.has(aspectRatio) ? aspectRatio : '16:9'
  inp.generate_audio = optBool(adv, 'generate_audio', true)
  return inp
}

/** The request for Generate a video: Replicate first, with fal's backup where it can carry it. */
export function ltx25FastCall(a: VideoBuildArgs): { call: ServiceCall, backup: ServiceCall | null } {
  const payload = ltx25Fast(a)
  return { call: { provider: 'replicate', endpoint: LTX_25_FAST_REPLICATE_SLUG, payload }, backup: ltx25FastOnFal(payload) }
}

/**
 * The backup: the same clip on fal, from the Replicate request. Null for a
 * clip shorter than 6 s (fal's shortest) or at a resolution fal has no name
 * for (never sent).
 */
export function ltx25FastOnFal(repPayload: Record<string, unknown>): ServiceCall | null {
  const seconds = Number(repPayload.duration)
  if (!LTX_25_FAST_FAL_SECONDS.has(seconds)) return null
  const resolution = LTX_25_FAST_FAL_RESOLUTION[String(repPayload.resolution)]
  if (!resolution) return null
  const first = typeof repPayload.image === 'string' ? repPayload.image : null
  const inp: Record<string, unknown> = {}
  if (first) {
    inp.image_url = first
    if (typeof repPayload.last_frame_image === 'string') inp.end_image_url = repPayload.last_frame_image
  }
  inp.prompt = repPayload.prompt
  inp.duration = seconds
  inp.resolution = resolution
  inp.aspect_ratio = repPayload.aspect_ratio
  inp.generate_audio = repPayload.generate_audio
  return { provider: 'fal', endpoint: first ? LTX_25_FAST_IMAGE_TO_VIDEO : LTX_25_FAST_TEXT_TO_VIDEO, payload: inp }
}

/** Generate a video's model ids this builder serves. */
export function isLtx25FastModel(id: unknown): id is typeof LTX_25_FAST_ID {
  return id === LTX_25_FAST_ID
}
