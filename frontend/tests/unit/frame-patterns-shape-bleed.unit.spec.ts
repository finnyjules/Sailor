import { describe, it, expect } from 'vitest'
import { shapeBleed } from '~/lib/frame/patterns/patterns/shapeBleed'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('shape bleed', () => {
  it('needs a shape', () => { expect(shapeBleed.needs?.shape).toBe(true) })
  it('is deterministic and sane', () => {
    const a = shapeBleed.place(ctxFor()); const b = shapeBleed.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('runs the shape off an edge (its centre sits outside the margin box on one axis)', () => {
    const shape = shapeBleed.place(ctxFor()).ops.find(o => o.kind === 'shape')!
    const offX = shape.x < 0.1 || shape.x > 0.9
    const offY = shape.y < 0.1 || shape.y > 0.9
    expect(offX || offY).toBe(true)
  })
  it('places the title clear of the shape on every edge', () => {
    const seen = new Set<string>()
    for (let s = 1; s <= 60 && seen.size < 4; s++) {
      const out = shapeBleed.place(ctxFor({ seed: s }))
      const edge = (['top', 'bottom', 'left', 'right'] as const).find(e => out.did.includes(`the ${e} edge`))
      if (!edge || seen.has(edge)) continue
      seen.add(edge)
      const title = out.ops.find(o => o.target === 'title')!
      if (edge === 'left') expect(title.x).toBeGreaterThan(0.5)   // shape left → title right half
      if (edge === 'right') expect(title.x).toBeLessThan(0.5)     // shape right → title left half
      if (edge === 'top') expect(title.y).toBeGreaterThan(0.5)    // shape top → title low
      if (edge === 'bottom') expect(title.y).toBeLessThan(0.5)    // shape bottom → title high
    }
    expect(seen.size).toBe(4)   // all four edges exercised, each with the title on the clear side
  })
})
