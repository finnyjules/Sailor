// A "living image": an image layer's optional frame sequence. Pure maths only — no
// DOM, no Vue — so the modal, the Frame card and the bake all pick the same frame
// for the same clock. See docs/superpowers/specs/2026-09-10-frame-living-image-clip-design.md.

export interface ImageClip {
  /** Folder under ComfyUI input/, e.g. "sailor_clips/clip_1725970000_ab12". */
  dir: string
  /** PNG count: 000000.png … (frames-1). */
  frames: number
  /** Rate the model returned (24 or 25 today). */
  fps: number
  /** Playback multiplier, 0.25..4. 1 = as returned. */
  speed: number
  prompt: string
  model: string
}

export const CLIP_SPEED_MIN = 0.25
export const CLIP_SPEED_MAX = 4

/** How long one loop of the clip lasts on screen, in seconds. */
export function clipPlayedSeconds(clip: ImageClip): number {
  const fps = clip.fps > 0 ? clip.fps : 0
  const speed = clip.speed > 0 ? clip.speed : 1
  if (!fps || clip.frames <= 0) return 0
  return clip.frames / fps / speed
}

/**
 * Which frame to draw at `tSec` for clone `k` of `n`. Nearest frame (not floor) so a
 * 24 fps clip inside a 30 fps Frame does not stutter on every fifth frame. Clone `k`
 * starts `k × playedLength × phase / n` seconds ahead of clone 0, so phase 1 spreads
 * the copies evenly around the loop and phase 0 plays them together.
 */
export function clipFrameIndex(clip: ImageClip, tSec: number, k = 0, n = 1, phase = 1): number {
  const frames = Math.floor(clip.frames)
  if (frames <= 1) return 0
  const speed = clip.speed > 0 ? clip.speed : 1
  const played = clipPlayedSeconds(clip)
  const copies = Math.max(1, Math.floor(n))
  const offset = played > 0 ? (Math.max(0, k) * played * Math.max(0, Math.min(1, phase))) / copies : 0
  const f = Math.round((tSec + offset) * speed * clip.fps)
  return ((f % frames) + frames) % frames
}

/** The /view URL of one frame, same shape `imageLayerUrl` uses for stills. */
export function clipFrameUrl(clip: ImageClip, index: number): string {
  const filename = `${String(Math.max(0, Math.floor(index))).padStart(6, '0')}.png`
  return `/view?${new URLSearchParams({ filename, subfolder: clip.dir, type: 'input' })}`
}
