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

export interface MorphPlacement { x: number; y: number; rotation?: number; skewX?: number; skewY?: number }

/**
 * A's placement → B's at `t`: x/y/skews linear (missing skew = 0), rotation along the SHORTEST
 * turn (difference normalised into (−180, 180]). Exact at the ends: t ≤ 0 is A's, t ≥ 1 B's.
 */
export function lerpPlacement(a: MorphPlacement, b: MorphPlacement, t: number): Required<MorphPlacement> {
  const ra = a.rotation ?? 0, rb = b.rotation ?? 0
  if (t <= 0) return { x: a.x, y: a.y, rotation: ra, skewX: a.skewX ?? 0, skewY: a.skewY ?? 0 }
  if (t >= 1) return { x: b.x, y: b.y, rotation: rb, skewX: b.skewX ?? 0, skewY: b.skewY ?? 0 }
  let dr = (((rb - ra) % 360) + 540) % 360 - 180
  if (dr === -180) dr = 180
  const lin = (p: number, q: number) => p + (q - p) * t
  return {
    x: lin(a.x, b.x), y: lin(a.y, b.y), rotation: ra + dr * t,
    skewX: lin(a.skewX ?? 0, b.skewX ?? 0), skewY: lin(a.skewY ?? 0, b.skewY ?? 0),
  }
}
