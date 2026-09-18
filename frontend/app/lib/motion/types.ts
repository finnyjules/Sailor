// frontend/app/lib/motion/types.ts
/**
 * Motion data for the Frame/Compositor unified layer stack.
 *
 * A layer's `animation` describes WHEN it is on screen (offset/duration within
 * the frame's motion timeline) and HOW it enters/exits/loops (preset ids from
 * the kinetic catalog, evaluated in pure canvas math — see evaluate.ts).
 * Offsets/durations are SECONDS. Spatial deltas produced by evaluation are in
 * UNIT-BOX units (1 = the animated unit's own box height) so they scale with
 * the layer; the painter converts to px.
 */

export interface LayerAnimSpec {
  presetId: string      // kinetic preset id (subset supported; see evaluate.ts)
  duration: number      // seconds the in/out phase takes (loop: cycle length)
  stagger?: number      // seconds between units (chars); default 0.04
  ease?: string         // GSAP-style ease name; preset default when absent
  /** Per-preset knob values (Jitter-style). Absent keys fall back to the
   *  preset's defaults (PRESET_PARAM_DEFAULTS in evaluate.ts). Numeric only. */
  params?: Record<string, number>
}

/** Transform/opacity keyframe, seconds relative to the layer's offset.
 *  Mirrors shared/timeline/types.ts Keyframe semantics (full snapshot,
 *  ease into the NEXT keyframe — hence the same narrow ease union, not the
 *  GSAP names presets use), but in seconds and with optional fields treated
 *  as "inherit identity". Unlike per-unit preset deltas (UNIT-BOX units),
 *  keyframes move the WHOLE layer, so dx/dy are canvas-normalized. */
export interface LayerKeyframe {
  t: number
  dx?: number           // normalized canvas-width offset (additive)
  dy?: number           // normalized canvas-HEIGHT offset (additive)
  scale?: number        // multiplicative, 1 = none
  rotation?: number     // degrees, additive
  opacity?: number      // multiplicative, 1 = none
  ease?: 'linear' | 'easeInOut'
}

export interface LayerAnimation {
  offset: number        // seconds from frame start when the layer enters
  duration?: number     // seconds on screen; undefined = to end of frame
  in?: LayerAnimSpec
  out?: LayerAnimSpec   // anchored to the END of the layer's window
  loop?: LayerAnimSpec  // active between in-end and out-start
  keyframes?: LayerKeyframe[]
}

export interface FrameMotion {
  fps: number
  duration: number      // seconds
  loop?: boolean
}

export const DEFAULT_FRAME_MOTION: FrameMotion = { fps: 30, duration: 4 }

export function createLayerAnimation(partial: Partial<LayerAnimation> = {}): LayerAnimation {
  return { offset: 0, ...partial }
}
