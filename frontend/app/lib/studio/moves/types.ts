// frontend/app/lib/studio/moves/types.ts
/**
 * Shared move/ease vocabulary. Studio-agnostic — NOTHING under
 * lib/studio/moves may import from lib/vectortype. `Move.kind` is opened to
 * a string so a studio adapter can add its own kinds ('tracks' is the
 * universal one every studio gets for free); `tracks` on 'tracks' moves
 * carries the shared track shape minus easing/timing, since the owning Move
 * supplies those.
 *
 * A move's placement on the timeline is `at`-anchored, not phase-bucketed:
 * `at` is where its window starts (seconds from clip start), `loop` says
 * whether that window is a one-shot transition (`[at, at+duration]`) or an
 * open-ended cycle (`[at, clip]`, wrapping every `duration` seconds), and
 * `bounce` ping-pongs the local progress within that window/cycle instead
 * of running it straight through. See `./phase.ts` for the window math.
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

/**
 * Retired from `Move` (see below) — kept exported only so the migration that
 * upgrades a 2026-09-03-or-earlier document's `phase`+`play` moves to the
 * `at`/`loop`/`bounce` model has a type for the shape it is reading.
 */
export interface MovePlay {
  mode: 'once' | 'backAndForth' | 'repeat'
  times: number
}

export interface Move {
  id: string
  /** 'tracks' is the universal kind. Studios may add kinds through their adapter. */
  kind: string
  /** for 'tracks': the track preset it was made from, or 'custom' */
  presetId?: string
  /** seconds from clip start where this move's window begins. */
  at: number
  /** window length in seconds for a transition; cycle length in seconds for a loop. */
  duration: number
  /** false: a one-shot transition, live only within [at, at+duration]. true: an open-ended cycle running [at, clip], wrapping every `duration` seconds. */
  loop: boolean
  /** ping-pong (triangle: forward then back) the local progress within the window/cycle instead of running it straight through. */
  bounce?: boolean
  ease: MoveEase
  params?: Record<string, number>
  tracks?: MoveTrack[]
}

export interface MotionClip {
  moves: Move[]
  duration: number
  fps: number
}
