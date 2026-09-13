import { describe, it, expect } from 'vitest'
import { shapeBleed } from '~/lib/frame/patterns/patterns/shapeBleed'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('shape bleed', () => {
  it('needs a shape', () => { expect(shapeBleed.needs?.shape).toBe(true) })
  it('is deterministic and sane', () => {
    const a = shapeBleed.place(ctxFor()); const b = shapeBleed.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('bleeds off every edge and keeps the shape and title from overlapping', () => {
    const seen = new Set<string>()
    for (let s = 1; s <= 80 && seen.size < 4; s++) {
      const out = shapeBleed.place(ctxFor({ seed: s }))
      const edge = (['top', 'bottom', 'left', 'right'] as const).find(e => out.did.includes(`the ${e} edge`))
      if (!edge || seen.has(edge)) continue
      seen.add(edge)
      const shape = out.ops.find(o => o.kind === 'shape')!
      const title = out.ops.find(o => o.target === 'title')!
      const shHalfW = shape.w! / 2, tHalfW = title.w! / 2
      if (edge === 'left') {
        expect(shape.x - shHalfW).toBeLessThan(0)                       // bleeds off the left
        expect(shape.x + shHalfW).toBeLessThanOrEqual(title.x - tHalfW) // shape right edge clears the title's left edge
      } else if (edge === 'right') {
        expect(shape.x + shHalfW).toBeGreaterThan(1)                    // bleeds off the right
        expect(title.x + tHalfW).toBeLessThanOrEqual(shape.x - shHalfW) // title right edge clears the shape's left edge
      } else if (edge === 'top') {
        expect(shape.y).toBeLessThan(0.4)                               // shape sits high (bleeds off top)
        expect(title.y).toBeGreaterThan(0.5)                           // title in the lower band
      } else {
        expect(shape.y).toBeGreaterThan(0.6)                           // shape sits low (bleeds off bottom)
        expect(title.y).toBeLessThan(0.5)                              // title in the upper band
      }
    }
    expect(seen.size).toBe(4)   // all four edges exercised
  })
})
