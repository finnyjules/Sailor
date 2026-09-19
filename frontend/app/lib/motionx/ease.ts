import type { Ease, BezierEase, NamedEase, SpringEase } from './types'

export function isSpringEase(e: unknown): e is SpringEase {
  return !!e && typeof e === 'object' && !Array.isArray(e) && (e as SpringEase).type === 'spring'
}

export function applyEase(p: number, e: Ease): number {
  // A spring is NOT clamped at p = 1: it keeps settling past the end of its segment.
  if (isSpringEase(e)) return springProgress(p, e.bounce)
  const t = p < 0 ? 0 : p > 1 ? 1 : p
  if (typeof e !== 'string') return Array.isArray(e) ? cubicBezier(t, e) : t
  switch (e) {
    case 'easeIn': return t * t
    case 'easeOut': return 1 - (1 - t) * (1 - t)
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    default: return t
  }
}

// Spring maths ported from DialKit's transition-math.ts (MIT), which mirrors Motion's
// visualDuration/bounce → stiffness/damping mapping. With p = elapsed / visualDuration the
// curve depends on p and bounce only, so a segment's LENGTH is the spring's duration.
const SPRING_W0 = (2 * Math.PI) / 1.2
const springZeta = (bounce: number) => Math.min(1, Math.max(0.05, 1 - (Number.isFinite(bounce) ? bounce : 0)))

/** p (in segment lengths) after which the spring is within 0.5% of its target. */
export function springSettle(bounce: number): number {
  return Math.log(200) / (springZeta(bounce) * SPRING_W0)
}
/** Normalized spring position 0 → 1 (may overshoot) at p segment-lengths after the start. */
export function springProgress(p: number, bounce: number): number {
  if (!(p > 0)) return 0
  const zeta = springZeta(bounce), w0 = SPRING_W0
  if (p >= springSettle(bounce)) return 1
  if (zeta < 0.9999) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * p) * (Math.cos(wd * p) + ((zeta * w0) / wd) * Math.sin(wd * p))
  }
  return 1 - Math.exp(-w0 * p) * (1 + w0 * p)
}

/** y at x on the CSS cubic-bézier (0,0)-(x1,y1)-(x2,y2)-(1,1). x handles are clamped to
 *  0..1 so x(s) is monotonic and always solvable; y is left free (overshoot / anticipation). */
function cubicBezier(x: number, e: BezierEase): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (!e.every(Number.isFinite)) return x
  const x1 = Math.min(1, Math.max(0, e[0])), y1 = e[1]
  const x2 = Math.min(1, Math.max(0, e[2])), y2 = e[3]
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  // Newton from s = x, then bisection if the slope is too flat to converge.
  let s = x
  for (let i = 0; i < 8; i++) {
    const err = sx(s) - x
    if (Math.abs(err) < 1e-7) return ((ay * s + by) * s + cy) * s
    const d = dx(s)
    if (Math.abs(d) < 1e-6) break
    s -= err / d
  }
  let lo = 0, hi = 1
  s = x
  for (let i = 0; i < 40; i++) {
    const v = sx(s)
    if (Math.abs(v - x) < 1e-7) break
    if (v < x) lo = s
    else hi = s
    s = (lo + hi) / 2
  }
  return ((ay * s + by) * s + cy) * s
}

/** Handles to SHOW for an ease in the curve editor. Linear / in / out are exact (a quadratic
 *  is a cubic); easeInOut is piecewise, so its handles are the closest single curve. */
const NAMED_HANDLES: Record<NamedEase, BezierEase> = {
  linear: [0, 0, 1, 1],
  easeIn: [1 / 3, 0, 2 / 3, 1 / 3],
  easeOut: [1 / 3, 2 / 3, 2 / 3, 1],
  easeInOut: [0.45, 0.03, 0.55, 0.97],
}
export function easeToBezier(e: Ease): BezierEase {
  if (isSpringEase(e)) return [...NAMED_HANDLES.easeInOut] as BezierEase
  return typeof e === 'string' ? [...(NAMED_HANDLES[e] ?? NAMED_HANDLES.linear)] as BezierEase : [...e] as BezierEase
}

export function easeEquals(a: Ease, b: Ease): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (isSpringEase(a) || isSpringEase(b)) return isSpringEase(a) && isSpringEase(b) && a.bounce === b.bounce
  return a.length === b.length && a.every((v, i) => v === b[i])
}
