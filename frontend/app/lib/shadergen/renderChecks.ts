/**
 * Cheap automatic checks on a rendered take (AI in Sailor spec §7.2), with the
 * spike page's thresholds. They catch breakage, not taste: in the spike they
 * passed every bad-looking take, which is why the engine also asks a model to
 * look at the renders. Inputs are small RGBA samples (24×24 in the renderer), except the
 * seamless-loop frames, which are full thumbnail size (256×256) so thin features count.
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
  /** Seamless loop (see loopsSeamlessly). A pixel's change counts only above this (8-bit rounding). */
  loopPixelQuiet: 3 / 255,
  /** A wrap that changes less than this many whole pixels' worth (of 65 536) is too small to see. */
  loopMinMass: 12,
  /** The step across the wrap may be this many times an ordinary step of the same size. Continuous
   *  motion measures ≈ 1× at this step; lenient on purpose — a false "does not loop" costs a paid
   *  repair call and can lose a good take, and the hosts' seam blend softens what slips through. */
  loopWrapStep: 4,
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
  /** Frames for the seamless-loop check, with u_loop = L and a tiny step δ (L / 5000), at a size
   *  where a 1–3 px feature still shows (not the 24 px samples above): `start` at t = 0 and
   *  `again` at t = 0 once more (the noise floor), `step` at δ, `beforeEnd` at L − δ and
   *  `beforeEnd2` at L − 2δ. Absent: no loop check. */
  loop?: LoopFrames
}

export interface LoopFrames {
  start: ArrayLike<number>
  again: ArrayLike<number>
  step: ArrayLike<number>
  beforeEnd: ArrayLike<number>
  beforeEnd2: ArrayLike<number>
}

/** How much changed between two frames, in whole pixels' worth, counted where it changed: each
 *  pixel adds its largest channel change (0..1) above `loopPixelQuiet`. Not an image mean — a thin
 *  beam that jumps is a few hundred pixels of a 65 000-pixel frame, far under any mean threshold. */
export function changeMass(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const q = THRESHOLDS.loopPixelQuiet
  let s = 0
  for (let i = 0; i + 3 < a.length && i + 3 < b.length; i += 4) {
    const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) / 255
    if (d > q) s += d - q
  }
  return s
}

/** Motion that repeats seamlessly over the host's loop: the step across the wrap (L − δ → 0) is
 *  no bigger than an ordinary step of the same tiny size (0 → δ, L − 2δ → L − δ). With δ tiny,
 *  continuous motion's step shrinks toward nothing while a jump stays the size of the jump — a
 *  beam teleporting, raw growing u_time, a sawtooth — so the two separate. (The frame AT L is
 *  no evidence: for any body built on fract(u_time / LOOP()) it is the first frame by definition.)
 *  The floor is the noise between two renders of the same t, or a few pixels, whichever is more. */
export function loopsSeamlessly(l: LoopFrames): boolean {
  const noise = changeMass(l.start, l.again)
  const wrap = changeMass(l.beforeEnd, l.start)
  if (wrap <= Math.max(THRESHOLDS.loopMinMass, 3 * noise)) return true
  const ordinary = Math.max(changeMass(l.start, l.step), changeMass(l.beforeEnd2, l.beforeEnd))
  return wrap <= THRESHOLDS.loopWrapStep * Math.max(ordinary, noise)
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
