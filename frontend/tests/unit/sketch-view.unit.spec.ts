import { describe, it, expect } from 'vitest'
import { applyView, invertView, pxPerUnit, isMirrored, viewToSvg } from '~/lib/sketch/view'

// the dev page's y-up view at default zoom: sx = 40 + 34x, sy = 400 − 34y
const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

describe('view matrix', () => {
  it('maps like the dev page sx/sy', () => {
    expect(applyView(DEV, { x: 1, y: 2 })).toEqual({ x: 74, y: 332 })
  })
  it('inverts back to the drawing point', () => {
    const inv = invertView(DEV)!
    const p = applyView(inv, applyView(DEV, { x: 3.5, y: -1.25 }))
    expect(p.x).toBeCloseTo(3.5, 12); expect(p.y).toBeCloseTo(-1.25, 12)
  })
  it('reports scale and mirroring', () => {
    expect(pxPerUnit(DEV)).toBeCloseTo(34, 12)
    expect(isMirrored(DEV)).toBe(true)
    const rot = { a: Math.cos(0.5) * 2, b: Math.sin(0.5) * 2, c: -Math.sin(0.5) * 2, d: Math.cos(0.5) * 2, e: 0, f: 0 }
    expect(pxPerUnit(rot)).toBeCloseTo(2, 12)
    expect(isMirrored(rot)).toBe(false)
  })
  it('returns null for a singular matrix', () => {
    expect(invertView({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBeNull()
  })
  it('serialises for an SVG transform', () => {
    expect(viewToSvg(DEV)).toBe('matrix(34 0 0 -34 40 400)')
  })
})
