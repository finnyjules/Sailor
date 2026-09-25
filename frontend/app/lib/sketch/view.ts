import type { Vec2 } from './geom'

/** Drawing → screen, in SVG/DOMMatrix order: x' = a·x + c·y + e, y' = b·x + d·y + f.
 *  One matrix is the whole contract between the pen and a host: it may translate,
 *  scale (unevenly), rotate and mirror. */
export interface ViewMatrix { a: number; b: number; c: number; d: number; e: number; f: number }

export function applyView(m: ViewMatrix, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function invertView(m: ViewMatrix): ViewMatrix | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** Screen pixels per drawing unit (geometric mean of the two axis scales). */
export function pxPerUnit(m: ViewMatrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
}

/** A mirrored view reverses arc winding on screen. Only screen-space drawing of
 *  arcs (live previews) needs this; the outline itself is drawn in drawing space
 *  under `viewToSvg`, which needs no correction. */
export function isMirrored(m: ViewMatrix): boolean {
  return m.a * m.d - m.b * m.c < 0
}

export function viewToSvg(m: ViewMatrix): string {
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`
}
