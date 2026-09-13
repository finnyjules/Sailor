import { describe, it, expect } from 'vitest'
import { knockout } from '~/lib/frame/patterns/patterns/knockout'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('knockout', () => {
  it('needs a shape', () => { expect(knockout.needs?.shape).toBe(true) })
  it('is deterministic and sane (fixture has a shape)', () => {
    const a = knockout.place(ctxFor()); const b = knockout.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('draws a solid shape and reverses the title out of it', () => {
    const out = knockout.place(ctxFor())
    const shape = out.ops.find(o => o.kind === 'shape')!
    const title = out.ops.find(o => o.target === 'title')!
    expect(shape.fill).toBe('solid')
    expect(title.colorRole).toBe('field')   // knocked out of the solid shape
    expect((shape.z ?? 0)).toBeLessThan(title.z ?? 0)   // shape behind, title over
  })
})
