// warp is a SELF-ONLY geometry kind (no sibling rail) whose maths live in meshWarp.ts (pure).
// These tests drive it THROUGH `applyGeometry` — the real dispatch + cache path — proving the
// byte-identity guarantees and that the effect actually transforms the outline.
import { describe, it, expect } from 'vitest'
import { applyGeometry } from '~/lib/compositor/geometryEffects'
import { flatten } from '~/lib/vector/pathOps'

const SQUARE = 'M0 0 L100 0 L100 100 L0 100 Z'
const W = 100

function bbox(d: string) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of flatten(d)) for (const p of s.pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY }
}

describe('geometryEffects warp: byte-identity / no-op', () => {
  it('an empty stack returns the SAME string (reference identity)', () => {
    expect(applyGeometry(SQUARE, [], { W })).toBe(SQUARE)
  })
  it('an invisible warp is a no-op (reference identity)', () => {
    const eff = [{ type: 'warp', field: 'bulge', amount: 0.5, frequency: 3, visible: false }]
    expect(applyGeometry(SQUARE, eff, { W })).toBe(SQUARE)
  })
  it('amount 0 returns the input d BY REFERENCE — no reserialisation', () => {
    const eff = [{ type: 'warp', field: 'bulge', amount: 0, frequency: 3, visible: true }]
    expect(applyGeometry(SQUARE, eff, { W })).toBe(SQUARE)
  })
  it('a negligible amount (≤ eps) is also an exact no-op', () => {
    const eff = [{ type: 'warp', field: 'twist', amount: 1e-5, frequency: 3, visible: true }]
    expect(applyGeometry(SQUARE, eff, { W })).toBe(SQUARE)
  })
})

describe('geometryEffects warp: transforms the outline', () => {
  it('bulge grows the square (bbox expands beyond its extent)', () => {
    const eff = [{ type: 'warp', field: 'bulge', amount: 0.5, frequency: 3, visible: true }]
    const out = applyGeometry(SQUARE, eff, { W })
    expect(out).not.toBe(SQUARE)
    const b = bbox(out)
    expect(b.minX).toBeLessThan(0)
    expect(b.w).toBeGreaterThan(100)
  })
  it('pinch shrinks the square (bbox contracts)', () => {
    const eff = [{ type: 'warp', field: 'pinch', amount: 0.5, frequency: 3, visible: true }]
    const b = bbox(applyGeometry(SQUARE, eff, { W }))
    expect(b.w).toBeLessThan(100)
    expect(b.h).toBeLessThan(100)
  })
  it('wave shears the outline (freq that lands the corners off the sine nodes)', () => {
    // A flattened square samples the sine only at its corners (v=±1); an integer/half-integer
    // frequency has nodes there. freq 0.75 → sin(±1.5π)=∓1 shears the corners horizontally.
    const eff = [{ type: 'warp', field: 'wave', amount: 0.3, frequency: 0.75, visible: true }]
    const out = applyGeometry(SQUARE, eff, { W })
    expect(out).not.toBe(SQUARE)
  })
  it('an unknown field falls back to bulge rather than throwing', () => {
    const eff = [{ type: 'warp', field: 'nonsense', amount: 0.5, frequency: 3, visible: true }]
    const out = applyGeometry(SQUARE, eff, { W })
    const b = bbox(out)
    expect(b.w).toBeGreaterThan(100) // behaved like bulge
  })
})

describe('geometryEffects warp: needs no sibling rail', () => {
  it('warps with no resolveSibling supplied (self-only)', () => {
    const eff = [{ type: 'warp', field: 'twist', amount: 0.4, frequency: 3, visible: true }]
    const out = applyGeometry(SQUARE, eff, { W }) // no resolveSibling in ctx
    expect(out).not.toBe(SQUARE)
  })
})
