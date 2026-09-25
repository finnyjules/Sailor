/**
 * LTX-2.5 Fast (Lightricks; model line-up, Task F20): runner-only, family
 * `ltx-2.5-fast`. It replaces the hidden LTX-Video in the gallery; that model
 * stays hidden and runs for saved projects as before (video.ts ltxVideo).
 *
 * One endpoint, its builder written from its saved schema
 * (tests/unit/fixtures/provider-schemas/replicate/lightricks__ltx-2.5-fast.json,
 * read 2026-09-25): lightricks/ltx-2.5-fast (Lightricks' own, version
 * 52475fac…), one model for both modes: a picture in `image` makes it
 * image-to-video. Billing "per second of output video" by target resolution:
 * 720p $0.03, 1080p $0.06, 2k $0.12, 4k $0.24 (its model page).
 *
 * No backup (controller ruling, F20 fix round 1). fal hosts the same model
 * (lightricks/ltx-2.5/{text,image}-to-video/fast) at $0.09 / $0.13 / $0.30 a
 * second with no 2–5 s clips: covering it at cost would double the price of
 * every clip of 6 s or more for a rare stall, and this model's point is its
 * price.
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
 * No seed (the schema has none). No frame-rate setting: the default is 25
 * fps, a rate that allows clips over 10 s.
 *
 * Reference pictures, videos or sounds left in the node's options are
 * refused in plain words, never dropped (LTX_25_FAST_EXTRAS; requestRules.ts
 * judges the same before the hold). A linked sound never reaches the runner
 * (eligibility.ts).
 */
import { durOr } from './video'
import { optBool, optStr } from './opts'
import type { VideoBuildArgs } from './types'

export const LTX_25_FAST_ID = 'ltx-2.5-fast'
export const LTX_25_FAST_REPLICATE_SLUG = 'lightricks/ltx-2.5-fast'

/** Replicate `duration` (its enum). */
export const LTX_25_FAST_SECONDS: readonly number[] = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20]
/** Replicate's own default length (always sent). */
export const LTX_25_FAST_DEFAULT_SECONDS = 6
/** The resolutions the node offers (Replicate's names). */
export const LTX_25_FAST_RESOLUTIONS = ['720p', '1080p', '4k'] as const
export const LTX_25_FAST_DEFAULT_RESOLUTION = '1080p'
/** Over this many seconds, only 720p and 1080p (the schema's duration description, at 24 or 25 fps). */
export const LTX_25_FAST_LONG_SECONDS = 10
const LONG_OK: ReadonlySet<string> = new Set(['720p', '1080p'])
/** Replicate's `aspect_ratio`. */
const AR: ReadonlySet<string> = new Set(['16:9', '9:16'])

export const LTX_25_FAST_EXTRAS
  = 'LTX-2.5 Fast starts from a first picture and, if you like, a last one. It takes no reference pictures, videos or sounds. Remove them, or pick another model.'
export const LTX_25_FAST_LAST_NEEDS_FIRST = 'LTX-2.5 Fast needs a first picture to end on a last one. Link a first picture, or remove the last one.'
export const LTX_25_FAST_TOO_LONG_AT_4K = 'LTX-2.5 Fast makes clips over 10 seconds only at 720p or 1080p. Pick a shorter clip or a lower resolution.'
export const LTX_25_FAST_NEEDS_PROMPT = 'LTX-2.5 Fast needs a prompt. Describe the clip, or how the picture should move.'

/** The first frame: the linked picture, else `image_url` in the options, else ''. */
export function ltx25FastFirstFrame(image: string | null, adv: Record<string, unknown>): string {
  return image || optStr(adv, 'image_url', '')
}

/** True when the options carry what the model doesn't take: reference pictures, videos or sounds. */
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
 * What the model won't take in these settings, or null: references;
 * a last frame with no first; a clip over 10 s at 4k. `firstFrame`: a first
 * frame is linked or in the options.
 */
export function ltx25FastProblem(adv: Record<string, unknown>, duration: number, firstFrame: boolean): string | null {
  if (ltx25FastHasExtras(adv)) return LTX_25_FAST_EXTRAS
  if (optStr(adv, 'end_image_url', '') && !firstFrame) return LTX_25_FAST_LAST_NEEDS_FIRST
  if (ltx25FastSeconds(duration) > LTX_25_FAST_LONG_SECONDS && !LONG_OK.has(ltx25FastResolution(adv))) return LTX_25_FAST_TOO_LONG_AT_4K
  return null
}

/** The Replicate request. Throws the plain message for settings the model doesn't take. */
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

/** Generate a video's model ids this builder serves. */
export function isLtx25FastModel(id: unknown): id is typeof LTX_25_FAST_ID {
  return id === LTX_25_FAST_ID
}
