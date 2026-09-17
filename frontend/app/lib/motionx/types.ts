import type { GradientStop } from '~/lib/color/harmony'

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
export type PropertyType = 'number' | 'color' | 'gradient'
export type PropertyValue = number | string | GradientStop[]

export interface Keyframe { t: number; value: PropertyValue; ease: Ease }
export interface Track {
  path: string
  type: PropertyType
  keyframes: Keyframe[]
  loop?: boolean                   // when true, evaluateTrack wraps t into the keyframe span
  mode?: 'crossfade' | 'travel'    // gradient tracks only
  space?: 'oklab' | 'hybrid'       // colour/gradient tracks only
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
