// Pure gradient-transition core: resolve a crossfade / travel / scroll to a colour
// LUT or stop array at a given time. No Vue/DOM/canvas. Reuses convert.ts + mix.ts;
// uses harmony.ts's GradientStop shape. See
// docs/superpowers/specs/2026-09-16-gradient-transitions-design.md.
import { hexToOklab, hexToRgb, oklabToRgb, rgbToHex } from './convert'
import { mixHex } from './mix'
import type { GradientStop } from './harmony'

export type BlendSpace = 'oklab' | 'hybrid'
export const BLEND_SPACES = ['oklab', 'hybrid'] as const

/**
 * Blend two hex colours at `t` in the given space. Byte-exact at the ends.
 * OKLab: the shared `mixHex`. Hybrid: OKLab straight-line DIRECTION (never flips)
 * with chroma re-inflated to the linear value so complementary midpoints stay vivid.
 */
export function blendHex(from: string, to: string, t: number, space: BlendSpace = 'oklab'): string {
  if (t <= 0) return from
  if (t >= 1) return to
  if (space === 'oklab') return mixHex(from, to, t, 'oklab')
  const [L1, a1, b1] = hexToOklab(from)
  const [L2, a2, b2] = hexToOklab(to)
  const L = L1 + (L2 - L1) * t
  let a = a1 + (a2 - a1) * t
  let b = b1 + (b2 - b1) * t
  const cStraight = Math.hypot(a, b)
  const cWant = Math.hypot(a1, b1) + (Math.hypot(a2, b2) - Math.hypot(a1, b1)) * t
  if (cStraight > 1e-6 && cWant > cStraight) { const s = cWant / cStraight; a *= s; b *= s }
  return rgbToHex(...oklabToRgb(L, a, b))
}

function sortStops(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((x, y) => x.pos - y.pos)
}

/**
 * Sample a static ramp of stops at `u`, blending piecewise between the
 * bracketing stops in the given space. Clamped to the end stops outside
 * `[first.pos, last.pos]`. Stops are sorted by `pos` before sampling, so
 * input order does not matter.
 */
export function sampleRamp(stops: GradientStop[], u: number, space: BlendSpace = 'oklab'): string {
  const s = sortStops(stops)
  if (s.length === 0) return '#000000'
  if (u <= s[0].pos) return s[0].color
  const last = s[s.length - 1]
  if (u >= last.pos) return last.color
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1]
    if (u >= a.pos && u <= b.pos) {
      const lt = (u - a.pos) / ((b.pos - a.pos) || 1)
      return blendHex(a.color, b.color, lt, space)
    }
  }
  return last.color
}

/**
 * Build a `size*3`-byte RGB lookup table by sampling the ramp at
 * `u = i/(size-1)` for row `i`. Default `size = 256`.
 */
export function buildLUT(stops: GradientStop[], space: BlendSpace = 'oklab', size = 256): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 3)
  for (let i = 0; i < size; i++) {
    const u = size === 1 ? 0 : i / (size - 1)
    const [r, g, b] = hexToRgb(sampleRamp(stops, u, space))
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}

/**
 * Re-express a ramp as `n` evenly-positioned stops (appearance-preserving):
 * sample the existing ramp at u = i/(n-1) for each new stop. Returns a copy
 * of the (sorted) input when `stops.length === n`.
 */
export function resampleStops(stops: GradientStop[], n: number, space: BlendSpace = 'oklab'): GradientStop[] {
  const s = sortStops(stops)
  if (s.length === n) return s.map(x => ({ pos: x.pos, color: x.color }))
  const out: GradientStop[] = []
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0.5 : i / (n - 1)
    out.push({ pos: u, color: sampleRamp(s, u, space) })
  }
  return out
}

/**
 * Resample both ramps to `N = max(from.length, to.length)` evenly-positioned
 * stops so index `i` pairs across `from`/`to` for a stop-by-stop tween.
 */
export function pairStops(
  from: GradientStop[],
  to: GradientStop[],
  space: BlendSpace = 'oklab',
): [GradientStop[], GradientStop[]] {
  const N = Math.max(from.length, to.length)
  return [resampleStops(from, N, space), resampleStops(to, N, space)]
}
