/**
 * Person swap (video), PersonSwapVideo, on Pixverse Swap through fal (family
 * person-swap-video). Replaces the video half of the InsightFace face swap.
 * Pixverse's person mode swaps the whole person (face, hair, clothes), not
 * only the face. Pricing (llms.txt, read 2026-09-26): "For 5s video your
 * request will cost $0.15 for 360p and 540p, $0.2 for 720p … If input video
 * duration is greater than 5 s the cost will double." fal names no maximum
 * length, so Sailor stops at 10 s: at most the doubled price.
 * Pure; relative imports only.
 */
type Inputs = Record<string, unknown>

export const PIXVERSE_SWAP_ENDPOINT = 'fal-ai/pixverse/swap'
export const PERSON_SWAP_RESOLUTIONS: readonly string[] = ['360p', '540p', '720p']
export const PERSON_SWAP_BASE_SECONDS = 5
export const PERSON_SWAP_MAX_SECONDS = 10

export const PERSON_SWAP_UNKNOWN_SETTING = 'Choose a size (360p, 540p or 720p) on the node.'
export const PERSON_SWAP_TOO_LONG = `Person swap takes videos up to ${PERSON_SWAP_MAX_SECONDS} seconds long. Trim this one first.`
export const PERSON_SWAP_UNMEASURED = 'Sailor can’t read this video’s length, so it can’t price the swap. Try an MP4 video.'

/** The node's `resolution` (default "720p" when absent), or null for a value it doesn't offer. */
export function personSwapResolution(inputs: Inputs): string | null {
  const r = inputs.resolution === undefined ? '720p' : inputs.resolution
  return typeof r === 'string' && PERSON_SWAP_RESOLUTIONS.includes(r) ? r : null
}

/**
 * A measured length rounded to the microsecond before it meets a boundary (5 s
 * or 10 s), so a container's 5.0000001 s is 5 s, as the engine's own checks
 * read it (server/runner/personSwapMedia.ts).
 */
export const personSwapSeconds = (s: number): number => Math.round(s * 1e6) / 1e6

/** The rate card key: the resolution, with "/long" once the video is over 5 s (fal doubles it). */
export function personSwapRateKey(resolution: string, seconds: number): string {
  return personSwapSeconds(seconds) > PERSON_SWAP_BASE_SECONDS ? `${resolution}/long` : resolution
}
