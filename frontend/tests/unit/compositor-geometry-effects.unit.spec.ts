import { describe, it, expect } from 'vitest'
import { applyGeometry, GEOMETRY_EFFECT_LABELS } from '~/lib/compositor/geometryEffects'
import { flatten, pathLength, type Pt2 } from '~/lib/vector/pathOps'

// 100×100 square: perimeter 400. Same shape the pathOps spec uses.
const SQUARE_D = 'M0 0 L100 0 L100 100 L0 100 Z'
const W = 100

const flat = (d: string) => flatten(d)
const lenOf = (d: string) => {
  const subs = flatten(d)
  return subs.reduce((a, s) => a + pathLength(s.pts, s.closed), 0)
}

// Distance from a point to a segment [a,b].
function distToSeg(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
// Nearest distance from p to a closed polyline outline.
function distToOutline(p: Pt2, pts: Pt2[]): number {
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    best = Math.min(best, distToSeg(p, a, b))
  }
  return best
}
const hasPointNear = (pts: Pt2[], q: Pt2, tol = 0.5) =>
  pts.some(p => Math.hypot(p.x - q.x, p.y - q.y) <= tol)

describe('geometryEffects: labels single-source', () => {
  it('exposes sentence-case labels for the four geometry kinds', () => {
    expect(GEOMETRY_EFFECT_LABELS.trim).toBe('Trim path')
    expect(GEOMETRY_EFFECT_LABELS.roughen).toBe('Roughen')
    expect(GEOMETRY_EFFECT_LABELS.offset).toBe('Offset path')
    expect(GEOMETRY_EFFECT_LABELS.round_corners).toBe('Round corners')
  })
})

describe('geometryEffects: identity', () => {
  it('returns the SAME string when there are no effects', () => {
    expect(applyGeometry(SQUARE_D, [], { W })).toBe(SQUARE_D)
  })
  it('returns the SAME string when every effect is invisible', () => {
    const eff = [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: false }]
    expect(applyGeometry(SQUARE_D, eff, { W })).toBe(SQUARE_D)
  })
  it('ignores non-geometry kinds (they never reach the outline path)', () => {
    const eff = [{ type: 'bloom', visible: true }]
    expect(applyGeometry(SQUARE_D, eff, { W })).toBe(SQUARE_D)
  })
})

describe('geometryEffects: trim', () => {
  it('{0,0.5,0} keeps ~half the perimeter', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }], { W })
    expect(lenOf(d)).toBeCloseTo(200, 0)
  })
  it('{0,1,0} keeps ~the full outline', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 1, offset: 0, visible: true }], { W })
    expect(lenOf(d)).toBeCloseTo(400, 0)
  })
  it('a trimmed closed loop becomes an OPEN polyline', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }], { W })
    expect(flat(d)[0]!.closed).toBe(false)
  })
  it('offset rotates which segment survives', () => {
    const d0 = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }], { W })
    const d25 = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0.25, visible: true }], { W })
    const p0 = flat(d0)[0]!.pts
    const p25 = flat(d25)[0]!.pts
    // The origin corner is on the surviving half at offset 0, and off it at offset 0.25.
    expect(hasPointNear(p0, { x: 0, y: 0 })).toBe(true)
    expect(hasPointNear(p25, { x: 0, y: 0 })).toBe(false)
    // Both keep the same arc length; only the location moved.
    expect(lenOf(d25)).toBeCloseTo(200, 0)
  })
  it('start >= end yields an empty path', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0.6, end: 0.4, offset: 0, visible: true }], { W })
    expect(d).toBe('')
    expect(lenOf(d)).toBe(0)
  })
})

describe('geometryEffects: roughen', () => {
  const rough = (seed: number, amount = 0.05, detail = 8) =>
    applyGeometry(SQUARE_D, [{ type: 'roughen', amount, detail, seed, visible: true }], { W })

  it('is deterministic — same seed gives an identical d', () => {
    expect(rough(7)).toBe(rough(7))
  })
  it('a different seed gives a different d', () => {
    expect(rough(7)).not.toBe(rough(8))
  })
  it('amount 0 ≈ identity (same subpath count, ~same perimeter)', () => {
    const d = rough(7, 0)
    expect(flat(d).length).toBe(1)
    expect(lenOf(d)).toBeCloseTo(400, 0)
  })
  it('keeps the subpath count and closedness', () => {
    const subs = flat(rough(7))
    expect(subs.length).toBe(1)
    expect(subs[0]!.closed).toBe(true)
  })
  it('stays near the original — max displacement ≤ amount·W', () => {
    const amount = 0.05
    const subs = flat(rough(7, amount))
    const orig = flatten(SQUARE_D)[0]!.pts
    let maxD = 0
    for (const p of subs[0]!.pts) maxD = Math.max(maxD, distToOutline(p, orig))
    expect(maxD).toBeLessThanOrEqual(amount * W + 1e-6)
    // and it actually roughened (non-zero displacement somewhere)
    expect(maxD).toBeGreaterThan(0)
  })
})
