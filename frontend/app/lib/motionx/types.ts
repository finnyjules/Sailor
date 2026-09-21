import type { GradientStop } from '~/lib/color/harmony'

export type NamedEase = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
/** CSS-style cubic-bézier handles [x1, y1, x2, y2]: x in 0..1, y free (overshoot allowed). */
export type BezierEase = [number, number, number, number]
/** A duration-relative spring (DialKit/Motion's "time" spring): the segment length is the
 *  visual duration; `bounce` 0..1. It may overshoot and keeps settling past the segment. */
export interface SpringEase { type: 'spring'; bounce: number }
/** Progresses in stairs instead of along a curve: `count` even jumps, holding still between
 *  them. Always within [0, 1] — no overshoot, so (unlike a spring) it never runs past its bar. */
export interface StepsEase { type: 'steps'; count: number }
export type Ease = NamedEase | BezierEase | SpringEase | StepsEase
export type PropertyType = 'number' | 'color' | 'gradient'
export type PropertyValue = number | string | GradientStop[]

export interface Keyframe { t: number; value: PropertyValue; ease: Ease }
export interface Track {
  path: string
  type: PropertyType
  keyframes: Keyframe[]
  loop?: boolean                   // when true, evaluateTrack wraps t into the keyframe span
  mode?: 'crossfade' | 'travel'    // gradient tracks only
  /** Colour-blend space. Gradient + colour tracks: 'oklab' (default) | 'hybrid'. Colour tracks
   *  may also use 'oklch' | 'srgb' — the mix spaces of the legacy effect-dial tracks, so a
   *  converted colour track shows the same in-between colours. */
  space?: 'oklab' | 'hybrid' | 'oklch' | 'srgb'
  behaviourId?: string             // set on tracks compiled from a live Behaviour; the
                                   // evaluator ignores it (byte-identity preserved). Property
                                   // bands are untagged; a tagged track belongs to its band.
}
export interface Timing { start: number; duration: number; loop?: boolean; hold?: number; delay?: number }
export interface Behaviour { id: string; kind: string; timing: Timing; params?: Record<string, unknown> }
/** A Behaviour bound to a specific Frame layer, as persisted on the doc (author state). */
export interface StoredBehaviour extends Behaviour { layerId: string }
/** A behaviour compiles against a target that can read current property values. */
export interface BehaviourTarget {
  get(path: string): PropertyValue | undefined
  has(path: string): boolean
}
