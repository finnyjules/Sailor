// frontend/app/lib/studio/moves/phase.ts
/**
 * Pure window / phase math over the shared Move shape (reads only
 * `at`/`duration`/`loop`/`bounce`/`ease`). Studio-agnostic — NOTHING here
 * may import from lib/vectortype.
 *
 * A move's window is `at`-anchored: a transition (`loop: false`) is live
 * only inside `[at, at+duration]`; a loop (`loop: true`) is live inside
 * `[at, clip]` and its local phase wraps continuously every `duration`
 * seconds (no snap at the wrap — `((gt-at)/duration) mod 1` is a plain
 * sawtooth). `bounce: true` folds that local (pre-ease) progress into a
 * triangle — forward across the first half of the window/cycle, back
 * across the second half — before the ease is applied.
 */
import { easeSample } from './ease'
import type { Move } from './types'

export type MoveTiming = Pick<Move, 'at' | 'duration' | 'loop' | 'bounce' | 'ease'>

export interface MoveWindow<T extends MoveTiming> { move: T; start: number; end: number }

/** Each move's `[start, end]` window: `[at, at+duration]` for a transition, `[at, clip]` for a loop. */
export function moveWindows<T extends MoveTiming>(moves: readonly T[], clip: number): MoveWindow<T>[] {
  const c = Math.max(0.001, clip)
  return moves.map(m => ({ move: m, start: m.at, end: m.loop ? c : m.at + Math.max(0.001, m.duration) }))
}

/** Folds a progress value into a forward-then-back triangle (0→1→0 over one period), wrapping first like a sawtooth. */
function triangleFold(p: number): number {
  const cyc = ((p % 1) + 1) % 1
  return cyc < 0.5 ? cyc * 2 : (1 - cyc) * 2
}

/**
 * The move's eased local progress at global time `gt` within a clip of
 * `clip` seconds, or `null` when the move isn't live at `gt`.
 *
 * - Transition (`!loop`): live within `[at, at+duration]` (inclusive both
 *   ends); raw progress is `(gt-at)/duration`.
 * - Loop (`loop: true`): live within `[at, clip]`; raw progress is
 *   `((gt-at)/duration) mod 1` — a continuous sawtooth, not a source of
 *   any wrap discontinuity a caller would have to guard against.
 *
 * `bounce: true` runs the raw progress through `triangleFold` before the
 * ease is applied.
 */
export function movePhase(move: MoveTiming, gt: number, clip: number): number | null {
  const dur = Math.max(0.001, move.duration)
  if (move.loop) {
    const end = Math.max(0.001, clip)
    if (gt < move.at || gt > end) return null
    const raw = (gt - move.at) / dur
    const cyc = ((raw % 1) + 1) % 1
    const p = move.bounce ? triangleFold(cyc) : cyc
    return easeSample(move.ease, p)
  }
  const end = move.at + dur
  if (gt < move.at || gt > end) return null
  const raw = (gt - move.at) / dur
  const p = move.bounce ? triangleFold(raw) : raw
  return easeSample(move.ease, p)
}
