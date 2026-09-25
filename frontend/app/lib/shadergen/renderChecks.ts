/**
 * Cheap automatic checks on a rendered take (AI in Sailor spec §7.2), with the
 * spike page's thresholds. They catch breakage, not taste: in the spike they
 * passed every bad-looking take, which is why the engine also asks a model to
 * look at the renders. Inputs are small RGBA samples (24×24 in the renderer).
 */
export type Flag = 'black' | 'blown out' | 'flat' | 'no visible change' | 'heavy' | 'does not move' | 'does not loop'

/** Flags that reject a take. 'does not move' only warns. */
export const HARD_FLAGS: readonly Flag[] = ['black', 'blown out', 'flat', 'no visible change', 'heavy', 'does not loop']

export const THRESHOLDS = {
  black: 0.03,
  blown: 0.97,
  flatStd: 0.012,
  noChange: 0.012,
  moves: 0.002,
  heavyMs: 8,
  /** The frame at the loop's end may differ from the first by this much (precision noise). */
  loopEnds: 0.01,
  /** The step across the wrap (just before the end → the first frame) may be this many times
   *  an ordinary step (the first frame → one step in) — or `loopEnds`, whichever is larger. */
  loopWrapStep: 3,
} as const

export function frameStats(px: ArrayLike<number>): { mean: number; std: number } {
  let s = 0, s2 = 0, n = 0
  for (let i = 0; i + 3 < px.length; i += 4) {
    const l = (px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114) / 255
    s += l; s2 += l * l; n++
  }
  if (!n) return { mean: 0, std: 0 }
  const mean = s / n
  return { mean, std: Math.sqrt(Math.max(s2 / n - mean * mean, 0)) }
}

export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0, n = 0
  for (let i = 0; i + 3 < a.length && i + 3 < b.length; i += 4) {
    s += (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)) / 765
    n++
  }
  return n ? s / n : 0
}

export interface JudgeInput {
  /** frame at t = 2.0 */
  a: ArrayLike<number>
  /** frame at t = 3.37 — a non-harmonic gap, so periodic motion can't alias to "still" */
  b: ArrayLike<number>
  /** the input image, same sample size */
  source: ArrayLike<number>
  generative: boolean
  animated: boolean
  /** ms per 1024² frame over a plain copy */
  extraMs: number
  /** Frames for the seamless-loop check, with u_loop = L: `start` at t = 0, `end` at t = L,
   *  `beforeEnd` one step before L, `step` one step after 0. Absent: no loop check. */
  loop?: { start: ArrayLike<number>; end: ArrayLike<number>; beforeEnd: ArrayLike<number>; step: ArrayLike<number> }
}

/** Motion that repeats seamlessly over the host's loop: the loop's end is its first frame, and the
 *  step across the wrap is no bigger than an ordinary step. Raw growing u_time fails the first; a
 *  sawtooth (fract of time) that only matches at the end points fails the second. */
export function loopsSeamlessly(l: NonNullable<JudgeInput['loop']>): boolean {
  if (meanAbsDiff(l.end, l.start) > THRESHOLDS.loopEnds) return false
  const wrap = meanAbsDiff(l.beforeEnd, l.start)
  return wrap <= Math.max(THRESHOLDS.loopEnds, THRESHOLDS.loopWrapStep * meanAbsDiff(l.start, l.step))
}

export function judgeFrames(i: JudgeInput): { pass: boolean; flags: Flag[] } {
  const flags: Flag[] = []
  const st = frameStats(i.a)
  if (st.mean < THRESHOLDS.black) flags.push('black')
  else if (st.mean > THRESHOLDS.blown) flags.push('blown out')
  else if (st.std < THRESHOLDS.flatStd) flags.push('flat')
  if (!i.generative && meanAbsDiff(i.a, i.source) < THRESHOLDS.noChange) flags.push('no visible change')
  if (i.animated && meanAbsDiff(i.a, i.b) <= THRESHOLDS.moves) flags.push('does not move')
  if (i.loop && !loopsSeamlessly(i.loop)) flags.push('does not loop')
  if (i.extraMs > THRESHOLDS.heavyMs) flags.push('heavy')
  return { pass: !flags.some(f => HARD_FLAGS.includes(f)), flags }
}
