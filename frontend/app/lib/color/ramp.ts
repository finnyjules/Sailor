/**
 * A fills list read as a smooth ramp: `stops` are evenly spaced over 0..1 and
 * the colour at `t` is the perceptual mix of the two nearest (`mixHex`'s default
 * space — see mix.ts for why OKLab). Used by Shape Studio's "Colour ramp" and,
 * in phase two, the Frame's Blend layer.
 *
 * Solids mix colour to colour. GRADIENTS mix too — stop by stop: the mixed
 * gradient carries the union of both stop offsets, and at each offset the colour
 * is the perceptual mix of what each gradient shows there, so a purple→magenta
 * ramp fades into a red→yellow one across the clones instead of flipping at the
 * midpoint. A solid next to a gradient is read as a flat gradient of the other's
 * kind and angle, so it blends in the same way. Two linear gradients also
 * interpolate their angle (shortest arc); a linear next to a radial keeps each
 * kind on its own side of the midpoint (there is no in-between geometry) while
 * the colours still mix.
 *
 * A pattern / image / shader stop has no colour to mix, so it is used as-is on
 * its own side of the midpoint — the ramp degrades to a hard step there rather
 * than inventing a colour.
 */
import { mixHex } from './mix'
import { isGradient, type Gradient, type GradientStop, type Paint } from '~/lib/compositor/paint'

const FALLBACK = '#808080'

export function rampColour(stops: Paint[], t: number): Paint {
  if (stops.length === 0) return FALLBACK
  if (stops.length === 1) return stops[0]!
  const tt = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  const u = tt * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(u))
  const f = u - i
  const a = stops[i]!, b = stops[i + 1]!
  if (f <= 0) return a
  if (f >= 1) return b
  if (typeof a === 'string' && typeof b === 'string') return mixHex(a, b, f)
  const ga = asGradient(a, b), gb = asGradient(b, a)
  if (ga && gb) return mixGradient(ga, gb, f)
  return f < 0.5 ? a : b
}

/** `p` as a gradient: itself when it is one; a flat two-stop gradient wearing
 *  `other`'s kind and angle when `p` is a solid (so solid↔gradient blends);
 *  null for a pattern/image/shader, which has no colour to mix. */
function asGradient(p: Paint, other: Paint): Gradient | null {
  if (isGradient(p)) return p
  if (typeof p !== 'string') return null
  const flat: GradientStop[] = [{ offset: 0, color: p }, { offset: 1, color: p }]
  if (isGradient(other) && other.type === 'radial') return { type: 'radial', stops: flat }
  return { type: 'linear', angle: isGradient(other) && other.type === 'linear' ? other.angle : 0, stops: flat }
}

/** The colour `g` shows at offset `t` — its stops interpolated with the shared mixer. */
export function sampleGradient(g: Gradient, t: number): string {
  const st = [...g.stops].filter((s) => Number.isFinite(s.offset)).sort((x, y) => x.offset - y.offset)
  if (st.length === 0) return FALLBACK
  const tt = Math.max(0, Math.min(1, t))
  if (tt <= st[0]!.offset) return st[0]!.color
  const last = st[st.length - 1]!
  if (tt >= last.offset) return last.color
  for (let k = 0; k + 1 < st.length; k++) {
    const s0 = st[k]!, s1 = st[k + 1]!
    if (tt >= s0.offset && tt <= s1.offset) {
      const span = s1.offset - s0.offset
      return span <= 0 ? s1.color : mixHex(s0.color, s1.color, (tt - s0.offset) / span)
    }
  }
  return last.color
}

/** Shortest-arc interpolation between two angles in degrees. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180
  return a + d * f
}

/** `a` faded `f` of the way to `b`, stop by stop over the union of their offsets. */
export function mixGradient(a: Gradient, b: Gradient, f: number): Gradient {
  const offsets = [...new Set([...a.stops, ...b.stops].map((s) => Math.max(0, Math.min(1, s.offset))))].sort((x, y) => x - y)
  if (offsets.length === 0) offsets.push(0, 1)
  const stops: GradientStop[] = offsets.map((o) => ({ offset: o, color: mixHex(sampleGradient(a, o), sampleGradient(b, o), f) }))
  const type = a.type === b.type ? a.type : (f < 0.5 ? a.type : b.type)
  if (type === 'radial') return { type: 'radial', stops }
  const aa = a.type === 'linear' ? a.angle : (b.type === 'linear' ? b.angle : 0)
  const ab = b.type === 'linear' ? b.angle : aa
  return { type: 'linear', angle: lerpAngle(aa ?? 0, ab ?? 0, f), stops }
}
