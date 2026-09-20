import type { Params } from '../effect'

/** Shared placement maths for the Showcase layouts. Pure — no three.js. */

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export const pmod = (a: number, m: number) => ((a % m) + m) % m

export const dirOf = (p: Params): 1 | -1 => (String(p.direction) === 'ccw' ? -1 : 1)

/** Trips round the path per loop. May be a fraction (Speed 0.25 = a quarter trip per loop):
 *  the engine then plays as many loops as it takes for the travel to come back to a whole
 *  number (see loop.ts's loopMultiplier), which is why `loopRatesOf` must report the TRUE
 *  rate. A partial trip is never a seam on its own — it would put different cards in the
 *  same slots. */
export const tripsOf = (p: Params) => Math.max(0, Number(p.speed) || 0)

/** Direction "There and back" runs out and returns within ONE loop, so it closes every loop
 *  whatever the speed; the one-way directions close when the trips come to a whole number. */
const isThereAndBack = (p: Params) => String(p.direction) === 'alternate'
export const loopRatesOf = (p: Params) => (tripsOf(p) > 0 ? [isThereAndBack(p) ? 1 : tripsOf(p)] : [])

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1)))
  return t * t * (3 - 2 * t)
}

/** Signed trips travelled so far, before Motion shapes them. Out-and-back eases through
 *  its two turnarounds, so the reversal never snaps. */
export function travelOf(p: Params, t01: number): number {
  if (isThereAndBack(p)) return tripsOf(p) * (1 - Math.cos(2 * Math.PI * t01)) / 2
  return dirOf(p) * tripsOf(p) * t01
}

// ── easing ─────────────────────────────────────────────────────────────────────────
const backOut = (t: number) => { const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2 }
const bounceOut = (t: number): number => {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
/** How one card-step gets from rest to rest. Every curve runs 0 → 1; a few overshoot on
 *  the way (that is their character). `smooth` is the long-standing default. */
export const EASINGS: Record<string, (t: number) => number> = {
  smooth: t => t * t * (3 - 2 * t),
  natural: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  slowdown: t => 1 - (1 - t) ** 3,
  accelerate: t => t * t * t,
  snappy: t => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  overshoot: backOut,
  swing: t => { const c = 1.70158 * 1.525; return t < 0.5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2 },
  elastic: t => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  bounce: bounceOut,
  linear: t => t,
}
export const EASING_IDS = /* @__PURE__ */ Object.keys(EASINGS)
export const EASING_LABELS = ['Smooth', 'Natural', 'Slow down', 'Accelerate', 'Snappy', 'Overshoot', 'Swing', 'Elastic', 'Bounce', 'Linear']

/** A layout's own habit: gliding steadily, or moving a card at a time with a rest between. */
export type MotionHabit = 'glide' | 'step'
const DEFAULT_HOLD = 0.6

/** Trips travelled, as the Motion dial shapes them — THE number every layout's movement is
 *  built on. `n` is how many card slots make one trip; `own` is what this layout does when
 *  Motion is left on "Layout default".
 *
 *  Step per card: each slot's worth of travel rests for `Hold` of its time (split before and
 *  after) and moves through the rest along `Easing`. On "Layout default" a stepping layout
 *  uses the built-in Smooth / 0.6 whatever those (hidden) dials hold — default means default.
 *  Whole trips still land on whole numbers, so the loop closes exactly as before. */
export function travel(p: Params, t01: number, n: number, own: MotionHabit = 'glide'): number {
  const raw = travelOf(p, t01)
  const chosen = String(p.motion ?? 'auto')
  const habit: MotionHabit = chosen === 'continuous' ? 'glide' : chosen === 'stepped' ? 'step' : own
  if (habit === 'glide') return raw
  const custom = chosen === 'stepped'
  const hold = custom ? Math.min(0.95, Math.max(0, Number(p.hold ?? DEFAULT_HOLD))) : DEFAULT_HOLD
  const ease = (custom && EASINGS[String(p.easing)]) || EASINGS.smooth!
  const slots = Math.max(1, n), phase = raw * slots, whole = Math.floor(phase)
  const g = Math.min(1, Math.max(0, (phase - whole - hold / 2) / (1 - hold || 1)))
  return (whole + ease(g)) / slots
}

/** Card i's position along a closed path, 0…1, advancing with the loop. */
export function pathU(i: number, n: number, p: Params, t01: number): number {
  return pmod(i / Math.max(1, n) + travel(p, t01, n), 1)
}

/** Like `pathU`, but for layouts whose habit is to move a card at a time, so each card
 *  dwells in the hero slot instead of sliding through it. */
export function steppedU(i: number, n: number, p: Params, t01: number): number {
  return pmod(i / Math.max(1, n) + travel(p, t01, n, 'step'), 1)
}

/** The loop's travel in card slots, for a layout that moves a card at a time. */
export function steppedPhase(n: number, p: Params, t01: number): number {
  return travel(p, t01, n, 'step') * Math.max(1, n)
}

/** Card i's place in a queue that shows one card at a time: 0 is the card on show, 1 the
 *  next up, and so on; the card that has just left wraps to just under n and counts down
 *  to n−1. Fractions are mid-move. Card 0 opens the loop on show. */
export function queuePos(i: number, n: number, p: Params, t01: number): number {
  return pmod(i - steppedPhase(n, p, t01), Math.max(1, n))
}

/** A repeatable 0…1 scatter value for card/slot `i` — the same every frame and every
 *  build, so a scattered layout never reshuffles. */
export function hash01(i: number, salt = 0): number {
  const v = Math.sin(i * 127.1 + salt * 311.7 + 1.3) * 43758.5453
  return v - Math.floor(v)
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Interpolate two angles the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t
}

/** 1 in the middle of a path, easing to 0 at both ends — hides the jump where a card
 *  leaves one end and re-enters at the other. `w` is the faded share at each end. */
export function endFade(u: number, w = 0.12): number {
  return smoothstep(0, w, u) * smoothstep(0, w, 1 - u)
}

/** Where card `i` sits in a scrolling row, when the tiles are dealt round-robin into
 *  `rows` rows (row = i % rows). Widths are aspect × card size, so a strip of mixed-ratio
 *  photos spaces by what is actually drawn; `gap` is in card sizes. The row travels
 *  `travel` whole row-lengths (so the loop closes) and wraps end to end.
 *  Returns x (centred on 0), the row length, and a fade that hides the wrap. */
export function rowPlace(
  i: number, n: number, rows: number, aspects: readonly number[] | undefined,
  cardSize: number, gap: number, travel: number,
): { x: number; length: number; fade: number } {
  const row = i % rows
  let at = 0, centre = 0
  for (let k = row; k < n; k += rows) {
    const w = (aspects?.[k] || 1) * cardSize
    if (k === i) centre = at + w / 2
    at += w + gap * cardSize
  }
  const length = at || 1
  const x = pmod(centre + travel * length + length / 2, length) - length / 2
  return { x, length, fade: smoothstep(0, cardSize, length / 2 - Math.abs(x)) }
}
