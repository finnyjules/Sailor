// frontend/app/lib/studio/moves/phase.ts
/**
 * Pure phase / window / band math over the shared Move shape (reads only
 * `phase`/`duration`/`ease`/`play`). Studio-agnostic — NOTHING here may
 * import from lib/vectortype.
 *
 * In runs [0, duration]; Out runs [clip − duration, clip] but never starts
 * before the longest In; Loop runs the whole clip with phase 0 at
 * `longestIn`. `play` shapes each pass (once / back-and-forth / repeat) and
 * the ease is applied to the pass's local progress.
 */
import { easeSample } from './ease'
import type { Move } from './types'

type MoveTiming = Pick<Move, 'phase' | 'duration' | 'ease' | 'play'>

export interface MoveWindow<T extends MoveTiming> { move: T; start: number; end: number }

export function moveWindows<T extends MoveTiming>(moves: readonly T[], clip: number): { longestIn: number; windows: MoveWindow<T>[] } {
  const W = Math.max(0.001, clip)
  let longestIn = 0
  for (const m of moves) if (m.phase === 'in') longestIn = Math.max(longestIn, Math.min(W, m.duration))
  const windows = moves.map((m) => {
    if (m.phase === 'in') return { move: m, start: 0, end: Math.min(W, m.duration) }
    if (m.phase === 'out') return { move: m, start: Math.max(longestIn, W - m.duration), end: W }
    return { move: m, start: longestIn, end: W }
  })
  return { longestIn, windows }
}

export function movePhase(move: MoveTiming, gt: number, clip: number, longestIn: number): number | null {
  const W = Math.max(0.001, clip)
  const t = Math.max(0, gt)
  if (move.phase === 'in') {
    const dur = Math.max(0.05, move.duration)
    if (t >= dur) return null
    return playAndEase(move, t / dur)
  }
  if (move.phase === 'out') {
    const start = Math.max(longestIn, W - move.duration)
    if (t < start || W <= longestIn) return null
    const eff = Math.max(0.05, W - start)
    return playAndEase(move, Math.min(1, (t - start) / eff))
  }
  const cycle = Math.max(0.1, move.duration)
  const local = t - longestIn
  if (local < 0) return null
  const cyclePhase = ((local / cycle) % 1 + 1) % 1
  if (move.play.mode === 'backAndForth') {
    const p = cyclePhase < 0.5 ? cyclePhase * 2 : (1 - cyclePhase) * 2
    return easeSample(move.ease, p)
  }
  return easeSample(move.ease, cyclePhase)
}

function playAndEase(move: MoveTiming, p: number): number {
  const { mode, times } = move.play
  if (mode === 'once') return easeSample(move.ease, p)
  if (mode === 'repeat') { const local = (p * Math.max(1, times)) % 1; return easeSample(move.ease, p >= 1 ? 1 : local) }
  const cyc = (p * Math.max(1, times)) % 1
  const tri = cyc < 0.5 ? cyc * 2 : (1 - cyc) * 2
  return easeSample(move.ease, tri)
}

export function bandSpans(moves: readonly MoveTiming[], clip: number): { inFrac: number; loopFrac: number; outFrac: number } {
  const W = Math.max(0.001, clip)
  let inn = 0
  let out = 0
  for (const m of moves) {
    if (m.phase === 'in') inn = Math.max(inn, Math.min(W, m.duration))
    if (m.phase === 'out') out = Math.max(out, Math.min(W, m.duration))
  }
  const inFrac = inn / W
  const outFrac = out / W
  return { inFrac, loopFrac: Math.max(0, 1 - inFrac - outFrac), outFrac }
}
