/**
 * Luma Ray 3.2 (Luma; model line-up, Task F21): runner-only, family
 * `luma-ray-3.2`. It replaces the hidden Luma Ray 2 (720p) in the gallery;
 * that model stays hidden and runs for saved projects as before
 * (video.ts lumaRay2720p), at its own price.
 *
 * Two endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-25):
 *
 *   Replicate (first)   luma/ray-3.2 (Luma's own, "official", version
 *                       6e0a5501…), one model for both modes: a picture in
 *                       `start_image` makes it image-to-video. Billed per
 *                       output video (its model page's billingConfig, "sdr"):
 *                       5 s $0.15 / $0.30 / $1.20 and 10 s $0.45 / $0.90 /
 *                       $3.60 at 540p / 720p / 1080p
 *   fal (the backup)    luma/agent/ray/v3.2/image-to-video (Luma's Agents
 *                       API, the same ray-3.2; the id has no `fal-ai/`
 *                       prefix): "For 5s video your request will cost $0.15
 *                       for 540p, $0.30 for 720p and $1.20 for 1080p"
 *                       (its llms.txt), the same as Replicate
 *
 * Replicate is first: it alone takes both modes at Replicate's price, and fal's
 * text-to-video (luma/agent/ray/v3.2/text-to-video) costs $0.50 / $1 / $2 for
 * 5 s and $1 / $2 / $4 for 10 s, 1.7–3.3 times Replicate. fal backs up
 * image-to-video only, where it costs the same, so covering it at cost never
 * raises the price. Text-to-video has no backup: covered at cost, fal's would
 * raise the price of every text clip but 10 s at 1080p (5 s at 720p: 45
 * credits against 100), a higher price on every run for a rare stall.
 *
 * It sends Replicate, from "Generate a video":
 *   prompt        as typed; the schema requires one and sets no limits, so an
 *                 empty or spaces-only prompt is refused by a ruling
 *                 (requestRules.ts PROMPT_MIN_LENGTH_RULINGS). fal's 6,000
 *                 maximum only drops the backup (planNode)
 *   start_image   the first frame: the linked picture, else `image_url` in
 *                 the node's options; none for text-to-video
 *   end_image     `end_image_url` in the options, beside a first frame only
 *                 (a last frame alone is refused: fal's has no field for it)
 *   duration      5 or 10, the closer to the node's (the shorter on a tie).
 *                 "10s is not supported with hdr, start_image, end_image, or
 *                 loop": a 10 s clip from a picture, or looping, is refused
 *   resolution    540p, 720p or 1080p; anything else 720p (the schema's own
 *                 default, sent rather than relied on)
 *   aspect_ratio  one of the six the schema lists; anything else 16:9. Sent
 *                 with a picture too (Replicate then takes the picture's
 *                 shape; fal's image-to-video takes the ratio)
 *   loop          the node's "Seamless loop" option (default off). Not with
 *                 10 s or a last frame (both schemas): refused
 * No seed (neither schema has one). HDR and the EXR file are not offered: fal's
 * needs HDR access on the account, and Replicate returns one file, the MP4.
 *
 * Reference pictures, videos or sounds left in the node's options are refused
 * in plain words, never dropped (LUMA_RAY_32_EXTRAS; requestRules.ts judges
 * the same before the hold). A linked sound never reaches the runner
 * (eligibility.ts). Neither schema states a picture size limit, so no picture
 * is read before the hand-off. fal's keyframes are not built.
 *
 * The backup (`lumaRay32OnFal`) is built from the Replicate request: the same
 * prompt, frames, length ("5s"), resolution, ratio and loop. None for
 * text-to-video.
 */
import { durOr } from './video'
import { arOr, optBool, optStr } from './opts'
import type { VideoBuildArgs } from './types'
import type { ServiceCall } from './twins'

export const LUMA_RAY_32_ID = 'luma-ray-3.2'
export const LUMA_RAY_32_REPLICATE_SLUG = 'luma/ray-3.2'
/** fal's image-to-video, the backup (the one fal endpoint the family calls). */
export const LUMA_RAY_32_FAL_IMAGE_TO_VIDEO = 'luma/agent/ray/v3.2/image-to-video'

/** Replicate `duration` (its enum). */
export const LUMA_RAY_32_SECONDS: readonly number[] = [5, 10]
/** Replicate's own default length (always sent). */
export const LUMA_RAY_32_DEFAULT_SECONDS = 5
/** Replicate `resolution` (and fal's). */
export const LUMA_RAY_32_RESOLUTIONS = ['540p', '720p', '1080p'] as const
export const LUMA_RAY_32_DEFAULT_RESOLUTION = '720p'
/** Replicate `aspect_ratio` (and fal's, in another order). */
export const LUMA_RAY_32_ASPECT_RATIOS: ReadonlySet<string> = new Set(['9:16', '3:4', '1:1', '4:3', '16:9', '21:9'])
/** fal's image-to-video prompt `maxLength` (Replicate states none). */
export const LUMA_RAY_32_FAL_PROMPT_MAX = 6000

export const LUMA_RAY_32_EXTRAS
  = 'Luma Ray 3.2 starts from a first picture and, if you like, a last one. It takes no reference pictures, videos or sounds. Remove them, or pick another model.'
export const LUMA_RAY_32_LAST_NEEDS_FIRST = 'Luma Ray 3.2 needs a first picture to end on a last one. Link a first picture, or remove the last one.'
export const LUMA_RAY_32_LONG_FROM_PICTURE = 'Luma Ray 3.2 makes 10-second clips from a prompt alone. Pick 5 seconds, or remove the picture.'
export const LUMA_RAY_32_LOOP_TOO_LONG = 'Luma Ray 3.2 makes a seamless loop only at 5 seconds. Pick 5 seconds, or turn off the loop.'
export const LUMA_RAY_32_LOOP_WITH_LAST = 'Luma Ray 3.2 can\'t loop a clip that ends on a last picture. Turn off the loop, or remove the last picture.'
export const LUMA_RAY_32_NEEDS_PROMPT = 'Luma Ray 3.2 needs a prompt. Describe the clip, or how the picture should move.'
export const LUMA_RAY_32_LONG_PROMPT = 'Luma Ray 3.2 takes a prompt of at most 6,000 characters. Shorten it.'

/** The first frame: the linked picture, else `image_url` in the options, else ''. */
export function lumaRay32FirstFrame(image: string | null, adv: Record<string, unknown>): string {
  return image || optStr(adv, 'image_url', '')
}

/** True when the options carry what the model doesn't take: reference pictures, videos or sounds. */
export function lumaRay32HasExtras(adv: Record<string, unknown>): boolean {
  return ['image_urls', 'video_urls', 'audio_urls'].some(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
}

/** The clip length sent: 5 or 10, the closer to the node's. */
export function lumaRay32Seconds(duration: number): number {
  return durOr([...LUMA_RAY_32_SECONDS], duration, LUMA_RAY_32_DEFAULT_SECONDS)
}

/** The resolution sent: 540p, 720p or 1080p (any case); anything else 720p. */
export function lumaRay32Resolution(adv: Record<string, unknown>): string {
  const r = optStr(adv, 'resolution', LUMA_RAY_32_DEFAULT_RESOLUTION).toLowerCase()
  return (LUMA_RAY_32_RESOLUTIONS as readonly string[]).includes(r) ? r : LUMA_RAY_32_DEFAULT_RESOLUTION
}

/**
 * What the model won't take in these settings, or null: references; a last
 * frame with no first; 10 s from a picture; a loop at 10 s or ending on a
 * last frame. `firstFrame`: a first frame is linked or in the options.
 */
export function lumaRay32Problem(adv: Record<string, unknown>, duration: number, firstFrame: boolean): string | null {
  if (lumaRay32HasExtras(adv)) return LUMA_RAY_32_EXTRAS
  const last = !!optStr(adv, 'end_image_url', '')
  if (last && !firstFrame) return LUMA_RAY_32_LAST_NEEDS_FIRST
  const long = lumaRay32Seconds(duration) > LUMA_RAY_32_DEFAULT_SECONDS
  if (long && firstFrame) return LUMA_RAY_32_LONG_FROM_PICTURE
  if (optBool(adv, 'loop', false)) {
    if (long) return LUMA_RAY_32_LOOP_TOO_LONG
    if (last) return LUMA_RAY_32_LOOP_WITH_LAST
  }
  return null
}

/** The Replicate request (the first service). Throws the plain message for settings the model doesn't take. */
export function lumaRay32(a: VideoBuildArgs): Record<string, unknown> {
  const { prompt, aspectRatio, duration, image, adv } = a
  const first = lumaRay32FirstFrame(image, adv)
  const problem = lumaRay32Problem(adv, duration, !!first)
  if (problem) throw new Error(problem)
  const inp: Record<string, unknown> = { prompt }
  if (first) {
    inp.start_image = first
    const last = optStr(adv, 'end_image_url', '')
    if (last) inp.end_image = last
  }
  inp.duration = lumaRay32Seconds(duration)
  inp.resolution = lumaRay32Resolution(adv)
  inp.aspect_ratio = arOr(LUMA_RAY_32_ASPECT_RATIOS, aspectRatio, '16:9')
  inp.loop = optBool(adv, 'loop', false)
  return inp
}

/**
 * The backup: the same clip on fal's image-to-video, from the Replicate
 * request. Null for text-to-video (fal's costs more than Replicate's; see
 * the header) and for anything but a 5 s clip (fal's image-to-video makes no
 * 10 s from a picture; the builder never sends one).
 */
export function lumaRay32OnFal(repPayload: Record<string, unknown>): ServiceCall | null {
  if (typeof repPayload.start_image !== 'string') return null
  if (repPayload.duration !== LUMA_RAY_32_DEFAULT_SECONDS) return null
  const inp: Record<string, unknown> = { prompt: repPayload.prompt, image_url: repPayload.start_image }
  if (typeof repPayload.end_image === 'string') inp.end_image_url = repPayload.end_image
  inp.aspect_ratio = repPayload.aspect_ratio
  inp.resolution = repPayload.resolution
  inp.duration = `${LUMA_RAY_32_DEFAULT_SECONDS}s`
  inp.loop = repPayload.loop
  return { provider: 'fal', endpoint: LUMA_RAY_32_FAL_IMAGE_TO_VIDEO, payload: inp }
}

/** The request for Generate a video: Replicate first, with fal's backup where it can carry it. */
export function lumaRay32Call(a: VideoBuildArgs): { call: ServiceCall, backup: ServiceCall | null } {
  const payload = lumaRay32(a)
  return { call: { provider: 'replicate', endpoint: LUMA_RAY_32_REPLICATE_SLUG, payload }, backup: lumaRay32OnFal(payload) }
}

/** Generate a video's model ids this builder serves. */
export function isLumaRay32Model(id: unknown): id is typeof LUMA_RAY_32_ID {
  return id === LUMA_RAY_32_ID
}
