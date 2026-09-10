// The mesh-warp ENGINE (F3 Task 4a), tested purely — no canvas, no DOM. Each field displaces a
// KNOWN point to a concrete expected coordinate (not merely "changed"): bulge pushes a rim point
// outward, pinch inward, wave shears sinusoidally, twist rotates about the centre; amount 0 is the
// identity; the bbox centre is fixed for bulge/pinch/twist. The 100×100 square (bbox centre 50,50,
// half-extent 50) is the shared fixture so every expected value is hand-computable.
import { describe, it, expect } from 'vitest'
import {
  radialWarpPoint, waveWarpPoint, twistWarpPoint, warpPoint, warpPathD,
  bboxOfPolylines, smoothstep01,
  type WarpBBox,
} from '~/lib/compositor/meshWarp'
import { flatten, type Pt2 } from '~/lib/vector/pathOps'

const BOX: WarpBBox = { minX: 0, minY: 0, w: 100, h: 100 } // centre (50,50), half-extent 50
const CENTRE: Pt2 = { x: 50, y: 50 }
const CORNER: Pt2 = { x: 0, y: 0 } // top-left, normalized (u,v)=(-1,-1), rn=√2
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol

describe('meshWarp: bbox', () => {
  it('computes the bbox of a flattened outline', () => {
    const b = bboxOfPolylines(flatten('M0 0 L100 0 L100 100 L0 100 Z'))
    expect(b).toEqual({ minX: 0, minY: 0, w: 100, h: 100 })
  })
  it('is null for an empty outline', () => {
    expect(bboxOfPolylines([])).toBeNull()
  })
})

describe('meshWarp: smoothstep', () => {
  it('is 0 at 0, 1 at 1, 0.5 at 0.5, clamped outside', () => {
    expect(smoothstep01(0)).toBe(0)
    expect(smoothstep01(1)).toBe(1)
    expect(smoothstep01(0.5)).toBe(0.5)
    expect(smoothstep01(-3)).toBe(0)
    expect(smoothstep01(3)).toBe(1) // clamped, so a corner (rn>1) saturates at full strength
  })
})

describe('meshWarp: radial (bulge / pinch)', () => {
  it('bulge pushes the top-left corner further out (away from the centre)', () => {
    // rn=√2 → smoothstep01(clamp√2)=1; dispN=+0.5; ndir=(-1/√2,-1/√2).
    // u'=-1+(-0.7071)(0.5)=-1.35355 → x=50+(-1.35355)(50)=-17.6777.
    const out = radialWarpPoint(CORNER, BOX, 0.5)
    expect(near(out.x, -17.677669, 1e-4)).toBe(true)
    expect(near(out.y, -17.677669, 1e-4)).toBe(true)
    // Strictly further from centre than the original corner.
    expect(Math.hypot(out.x - 50, out.y - 50)).toBeGreaterThan(Math.hypot(CORNER.x - 50, CORNER.y - 50))
  })
  it('pinch (negative amount) pulls the same corner inward, toward the centre', () => {
    const out = radialWarpPoint(CORNER, BOX, -0.5)
    expect(near(out.x, 17.677669, 1e-4)).toBe(true)
    expect(near(out.y, 17.677669, 1e-4)).toBe(true)
    expect(Math.hypot(out.x - 50, out.y - 50)).toBeLessThan(Math.hypot(CORNER.x - 50, CORNER.y - 50))
  })
  it('leaves the bbox centre fixed (radial direction undefined there)', () => {
    const out = radialWarpPoint(CENTRE, BOX, 0.9)
    expect(out).toEqual(CENTRE)
  })
  it('amount 0 is the identity', () => {
    expect(radialWarpPoint(CORNER, BOX, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('meshWarp: wave', () => {
  it('shears X by amount·sin(2π·freq·v) as a function of vertical position', () => {
    // Point on the right edge, a quarter up from centre: (100, 25) → (u,v)=(1,-0.5).
    // freq=1: sin(2π·1·−0.5)=sin(−π)=0 → no shift. Choose freq=0.5: sin(2π·0.5·−0.5)=sin(−π/2)=−1.
    const p: Pt2 = { x: 100, y: 25 }
    const out = waveWarpPoint(p, BOX, 0.2, 0.5)
    // u'=1 + 0.2·(−1) = 0.8 → x = 50 + 0.8·50 = 90; y unchanged.
    expect(near(out.x, 90, 1e-6)).toBe(true)
    expect(near(out.y, 25, 1e-6)).toBe(true)
  })
  it('leaves a point on the centre line unshifted (default phase 0 → sin(0)=0)', () => {
    const p: Pt2 = { x: 90, y: 50 } // v=0
    const out = waveWarpPoint(p, BOX, 0.3, 3)
    expect(near(out.x, 90, 1e-6)).toBe(true)
    expect(near(out.y, 50, 1e-6)).toBe(true)
  })
  it('amount 0 is the identity', () => {
    expect(waveWarpPoint(CORNER, BOX, 0, 3)).toEqual({ x: 0, y: 0 })
  })
})

describe('meshWarp: twist', () => {
  it('rotates a point about the centre, strongest near the centre', () => {
    // A point close to the centre feels almost the full angle; a rim point barely rotates.
    const inner: Pt2 = { x: 55, y: 50 } // (u,v)=(0.1,0), rn=0.1
    const out = twistWarpPoint(inner, BOX, 0.5)
    // It must move OFF the horizontal (y changes) while staying ~the same distance from centre.
    expect(Math.abs(out.y - 50)).toBeGreaterThan(0.01)
    const rBefore = Math.hypot(inner.x - 50, inner.y - 50)
    const rAfter = Math.hypot(out.x - 50, out.y - 50)
    expect(near(rAfter, rBefore, 1e-6)).toBe(true) // pure rotation preserves radius
  })
  it('twists the centre-adjacent point MORE than a rim point, but the rim still turns', () => {
    const inner: Pt2 = { x: 60, y: 50 } // rn=0.2
    const rim: Pt2 = { x: 100, y: 50 } // rn=1 → decayed but non-zero angle → still rotates
    const oi = twistWarpPoint(inner, BOX, 0.6)
    const orm = twistWarpPoint(rim, BOX, 0.6)
    const angInner = Math.abs(Math.atan2(oi.y - 50, oi.x - 50)) // was 0
    const angRim = Math.abs(Math.atan2(orm.y - 50, orm.x - 50)) // was 0
    expect(angRim).toBeGreaterThan(0.01)      // the rim is not fixed (a rectangle can twist)
    expect(angInner).toBeGreaterThan(angRim)  // but the centre leads
  })
  it('leaves the exact centre fixed (it is the pivot)', () => {
    expect(twistWarpPoint(CENTRE, BOX, 0.9)).toEqual(CENTRE)
  })
  it('amount 0 is the identity', () => {
    expect(twistWarpPoint(CORNER, BOX, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('meshWarp: warpPoint dispatch', () => {
  it('bulge and pinch are the same field with opposite sign', () => {
    const b = warpPoint(CORNER, BOX, 'bulge', { amount: 0.4 })
    const p = warpPoint(CORNER, BOX, 'pinch', { amount: 0.4 })
    expect(b).toEqual(radialWarpPoint(CORNER, BOX, 0.4))
    expect(p).toEqual(radialWarpPoint(CORNER, BOX, -0.4))
  })
})

describe('meshWarp: warpPathD', () => {
  const SQUARE = 'M0 0 L100 0 L100 100 L0 100 Z'
  it('empty in → empty (input) out', () => {
    expect(warpPathD('', 'bulge', { amount: 0.5 })).toBe('')
  })
  it('a degenerate (zero-area) outline is returned unchanged', () => {
    const line = 'M0 50 L100 50' // h = 0
    expect(warpPathD(line, 'bulge', { amount: 0.5 })).toBe(line)
  })
  it('bulge grows the square outline (bbox expands past its original extent)', () => {
    const out = warpPathD(SQUARE, 'bulge', { amount: 0.5 })
    const b = bboxOfPolylines(flatten(out))!
    expect(b.minX).toBeLessThan(0)
    expect(b.minY).toBeLessThan(0)
    expect(b.w).toBeGreaterThan(100)
    expect(b.h).toBeGreaterThan(100)
  })
  it('pinch shrinks the square outline (bbox contracts)', () => {
    const out = warpPathD(SQUARE, 'pinch', { amount: 0.5 })
    const b = bboxOfPolylines(flatten(out))!
    expect(b.w).toBeLessThan(100)
    expect(b.h).toBeLessThan(100)
  })
  it('is deterministic — same input, same output', () => {
    expect(warpPathD(SQUARE, 'twist', { amount: 0.3 })).toBe(warpPathD(SQUARE, 'twist', { amount: 0.3 }))
  })
})
