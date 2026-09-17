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
