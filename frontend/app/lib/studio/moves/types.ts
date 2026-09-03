// frontend/app/lib/studio/moves/types.ts
/**
 * Shared move/ease/play vocabulary. Studio-agnostic — NOTHING under
 * lib/studio/moves may import from lib/vectortype. `Move.kind` is opened to
 * a string so a studio adapter can add its own kinds ('tracks' is the
 * universal one every studio gets for free); `tracks` on 'tracks' moves
 * carries the shared track shape minus easing/loops, since the owning Move
 * supplies those.
 */

export interface MoveTrack {
  path: string
  from: number
  to: number
  hold?: number
  cycleOffset?: number
  delay?: number
  fromColor?: string
  toColor?: string
  mix?: string
}

export type MoveEaseName =
  | 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate'
  | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'

export type MoveEase =
  | { kind: 'named'; name: MoveEaseName }
  | { kind: 'bezier'; cps: [number, number, number, number] }

export interface MovePlay {
  mode: 'once' | 'backAndForth' | 'repeat'
  times: number
}

export interface Move {
  id: string
  phase: 'in' | 'loop' | 'out'
  /** 'tracks' is the universal kind. Studios may add kinds through their adapter. */
  kind: string
  /** for 'tracks': the track preset it was made from, or 'custom' */
  presetId?: string
  duration: number
  ease: MoveEase
  play: MovePlay
  params?: Record<string, number>
  tracks?: MoveTrack[]
}

export interface MotionClip {
  moves: Move[]
  duration: number
  fps: number
}
