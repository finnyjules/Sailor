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
})
