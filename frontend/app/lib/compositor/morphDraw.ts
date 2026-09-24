/**
 * Frame Morph transition — the pure pieces of drawing one frame of a morph (spec
 * 2026-09-23). The compositor-coupled part (`resolveMorphs`) lives in useCompositorLayers.ts.
 */
import type { Paint } from '~/lib/compositor/paint'
import { mixHex } from '~/lib/color/mix'
import { ringsFromD } from '~/lib/vector/morphPieces'

// `mixHex` reads all three through `parseHexA` (8-digit keeps its alpha; 3-digit expands).
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function morphFillOf(layer: { kind: string; fill?: Paint; color?: Paint }): Paint | undefined {
  return layer.kind === 'text' ? layer.color : layer.fill
}

/** Solid ↔ solid blends (exact at the ends); anything else switches at the midpoint. */
export function blendMorphPaint(a: Paint | undefined, b: Paint | undefined, t: number): Paint {
  if (typeof a === 'string' && typeof b === 'string' && HEX.test(a) && HEX.test(b)) return mixHex(a, b, t)
  return (t < 0.5 ? a : b) ?? ''
}

export function ringsBBoxOfD(d: string): { w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of ringsFromD(d)) for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 }
}
