/**
 * "Enhance a video" (EnhanceVideoNode) on Topaz video upscale through fal
 * (model line-up F23, family `topaz-video`): how the runner reads the node
 * and turns the video it measured into the request's settings and the price's.
 * One reading for the request builder (server/runner/generators/topazVideo.ts)
 * and the price (../pricing/clipSettings.ts), so the price reads what is sent.
 *
 * The node (comfy_api_nodes/nodes_replicate.py EnhanceVideoNode) asks for a
 * target size, `target_resolution` 720p, 1080p or 4k, and a frame rate, `fps`
 * original, 30 or 60. fal's Topaz (its saved schema,
 * tests/unit/fixtures/provider-schemas/fal/fal-ai__topaz__upscale__video.json,
 * read 2026-09-25) takes an `upscale_factor` from 1 to 4 instead, so the
 * factor fits the video inside the target's 16:9 box, either way round (720p
 * is 720 × 1280, 1080p 1080 × 1920, 4K 2160 × 3840): the smaller of the
 * target's short side over the video's short side and the target's long side
 * over the video's long side (F23 fix round 1, so an 854 × 480 video asking
 * 720p makes 1280 × 720, not 1281 × 720 in the next band up):
 *   - rounded DOWN to 1/10,000 (never a pixel outside the target's box, so
 *     never a dearer size band than the target's);
 *   - 1 when the video is already at or above the target (Topaz only
 *     enhances it, at its own size; it can't make a video smaller);
 *   - above 4, refused in plain words (the schema's maximum).
 * The output is the measured size × the factor. A video already above 4K
 * (4096 × 2160, either way round) is refused; so would be an output above it
 * (only reachable at factor 1, i.e. from such a video: a separate message).
 *
 * fal's price ("For every second a video your request will cost $0.01 for up
 * to 720p, $0.02 for 720p to 1080p, and $0.08 for above 1080p output. Price
 * doubles for 60fps output.") is read per second of the video, by the size
 * band of the output and whether it is a high frame rate:
 *   - the band, from the output's LONGER side (controller ruling, F23: never
 *     its height, so a portrait or ultra-wide video is never under-charged):
 *     720p when the long side is at most 1280, 1080p at most 1920, else "4k"
 *     (above 1080p); and never below the short side's band (720 / 1080), so
 *     a square output isn't banded under its own height either;
 *   - the frame rate: doubled when 60 is asked for, or when the video's own
 *     rate is above 32 frames a second (50, 60), or couldn't be measured —
 *     the safe side again, since fal doesn't say what "60fps output" covers
 *     or whether a 30 fps target lowers a 60 fps video.
 *
 * Pure; relative imports only.
 */
type Inputs = Record<string, unknown>

/** fal's Topaz video upscale app (its saved schema's `x-fal-metadata.endpointId`). */
export const TOPAZ_VIDEO_ENDPOINT = 'fal-ai/topaz/upscale/video'

/** The Topaz model sent: the schema's default ("Proteus fits most footage"), sent so a new default can't change the price. */
export const TOPAZ_VIDEO_MODEL = 'Proteus'

/** The node's `target_resolution` values → the short side each asks for. */
export const TOPAZ_VIDEO_TARGETS: Readonly<Record<string, number>> = { '720p': 720, '1080p': 1080, '4k': 2160 }

/** The node's `target_resolution` values → the long side of the target's 16:9 box. */
export const TOPAZ_VIDEO_TARGET_LONG_SIDES: Readonly<Record<string, number>> = { '720p': 1280, '1080p': 1920, '4k': 3840 }

/** The node's `fps` values. */
export const TOPAZ_VIDEO_FPS: readonly string[] = ['original', '30', '60']

/** The schema's `upscale_factor` range. */
export const TOPAZ_VIDEO_MIN_FACTOR = 1
export const TOPAZ_VIDEO_MAX_FACTOR = 4

/** The largest video Topaz makes here, either way round: 4K, the node's largest target. */
export const TOPAZ_VIDEO_MAX_LONG_SIDE = 4096
export const TOPAZ_VIDEO_MAX_SHORT_SIDE = 2160

/**
 * The longest video the runner upscales (a Sailor limit; the schema states
 * none): the hold, the badge's "up to" and the most any video is billed.
 */
export const TOPAZ_VIDEO_MAX_SECONDS = 60

/** A frame rate above this is priced as fal's "60fps output" (doubled). */
export const TOPAZ_VIDEO_HIGH_FPS_ABOVE = 32

/** The size bands of fal's price, the dearest last. */
export type TopazVideoBand = '720p' | '1080p' | '4k'

/** What the runner measured about the video, before anything is sent. */
export interface TopazVideoFacts {
  width: number | null | undefined
  height: number | null | undefined
  /** Frames a second; null when it couldn't be measured (priced as a high rate). */
  fps: number | null | undefined
}

/** The request's settings and the price's, from the node and the measured video. */
export interface TopazVideoPlan {
  /** `upscale_factor`, sent. */
  factor: number
  /** The output's size (the measured size × the factor, rounded up). */
  width: number
  height: number
  /** `target_fps`, sent when the node asks for 30 or 60; null for "original" (not sent). */
  targetFps: number | null
  band: TopazVideoBand
  /** Priced at fal's doubled "60fps output" rate. */
  highFps: boolean
}

export const TOPAZ_VIDEO_UNMEASURED = 'Sailor can’t read this video’s size and length, so it can’t upscale or price it. Try an MP4 video.'
export const TOPAZ_VIDEO_TOO_LARGE = 'Topaz makes videos up to 4K (4096 × 2160), and this one is already larger. Make it smaller first.'
export const TOPAZ_VIDEO_OUTPUT_TOO_LARGE = 'At this size the upscaled video would be larger than 4K (4096 × 2160). Choose a smaller size.'
export const TOPAZ_VIDEO_SWITCHED_OFF = 'Topaz video upscale in Sailor was switched off after you pressed Run, so this video wasn’t sent. Run it again.'
export const TOPAZ_VIDEO_TOO_LONG = `Topaz upscales videos up to ${TOPAZ_VIDEO_MAX_SECONDS} seconds long. Trim this one first.`
export const TOPAZ_VIDEO_UNKNOWN_SETTING = 'Choose a size (720p, 1080p or 4K) and a frame rate (original, 30 or 60) on the node.'

const LABEL: Readonly<Record<string, string>> = { '720p': '720p', '1080p': '1080p', '4k': '4K' }

/** A video too small for the target: at most 4 times larger, and the largest size it can reach, if any. */
export function topazVideoTooSmall(width: number, height: number): string {
  const reachable = Object.keys(TOPAZ_VIDEO_TARGETS).filter(k => exactFactor(k, width, height) <= TOPAZ_VIDEO_MAX_FACTOR).map(k => LABEL[k]!)
  const size = `${width} × ${height}`
  return reachable.length
    ? `Topaz can make a video at most 4 times larger, and this one is ${size}. Choose ${reachable[reachable.length - 1]} or lower.`
    : `Topaz can make a video at most 4 times larger, and this one is ${size}, too small even for 720p. Use a larger video.`
}

/** The short side the node asks for, or null for a value it doesn't offer. */
export function topazVideoTarget(inputs: Inputs): number | null {
  const v = inputs.target_resolution
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TOPAZ_VIDEO_TARGETS, v) ? TOPAZ_VIDEO_TARGETS[v]! : null
}

/** `target_fps` as EnhanceVideoNode.execute sends it (`int(fps)` unless "original"): null for original, undefined for a value it doesn't offer. */
export function topazVideoTargetFps(inputs: Inputs): number | null | undefined {
  const v = inputs.fps
  if (typeof v !== 'string' || !TOPAZ_VIDEO_FPS.includes(v)) return undefined
  return v === 'original' ? null : Number(v)
}

/** The factor that fits a `width` × `height` video inside a target's box, either way round (before rounding). */
function exactFactor(target: string, width: number, height: number): number {
  return Math.min(TOPAZ_VIDEO_TARGETS[target]! / Math.min(width, height), TOPAZ_VIDEO_TARGET_LONG_SIDES[target]! / Math.max(width, height))
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** A size to the millionth, then rounded up (a factor's float noise never loses a pixel). */
const outSide = (side: number, factor: number) => Math.ceil(Math.round(side * factor * 1e6) / 1e6)

/** fal's size band for an output of `width` × `height`: its longer side's band, never below its shorter side's. */
export function topazVideoBand(width: number, height: number): TopazVideoBand {
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  if (short <= 720 && long <= 1280) return '720p'
  if (short <= 1080 && long <= 1920) return '1080p'
  return '4k'
}

/**
 * The node's settings for this video, or the plain refusal: a setting the
 * node doesn't offer, a video that couldn't be measured, too small for the
 * target (over 4 times), already above 4K, or an output that would be.
 */
export function topazVideoPlan(inputs: Inputs, facts: TopazVideoFacts): TopazVideoPlan | { refused: string } {
  const target = topazVideoTarget(inputs)
  const targetFps = topazVideoTargetFps(inputs)
  if (target == null || targetFps === undefined) return { refused: TOPAZ_VIDEO_UNKNOWN_SETTING }
  if (!positive(facts.width) || !positive(facts.height)) return { refused: TOPAZ_VIDEO_UNMEASURED }
  const w = facts.width
  const h = facts.height
  if (Math.max(w, h) > TOPAZ_VIDEO_MAX_LONG_SIDE || Math.min(w, h) > TOPAZ_VIDEO_MAX_SHORT_SIDE) return { refused: TOPAZ_VIDEO_TOO_LARGE }
  const exact = exactFactor(inputs.target_resolution as string, w, h)
  if (exact > TOPAZ_VIDEO_MAX_FACTOR) return { refused: topazVideoTooSmall(w, h) }
  const factor = Math.max(TOPAZ_VIDEO_MIN_FACTOR, Math.floor(exact * 1e4) / 1e4)
  const width = outSide(w, factor)
  const height = outSide(h, factor)
  if (Math.max(width, height) > TOPAZ_VIDEO_MAX_LONG_SIDE || Math.min(width, height) > TOPAZ_VIDEO_MAX_SHORT_SIDE) return { refused: TOPAZ_VIDEO_OUTPUT_TOO_LARGE }
  const highFps = targetFps === 60 || !positive(facts.fps) || facts.fps > TOPAZ_VIDEO_HIGH_FPS_ABOVE
  return { factor, width, height, targetFps, band: topazVideoBand(width, height), highFps }
}

/** The rate card's key for a band and frame rate (shared/pricing/clipRates.ts). */
export function topazVideoRateKey(band: TopazVideoBand, highFps: boolean): string {
  return highFps ? `${band}/60fps` : band
}
