import { describe, it, expect } from 'vitest'
import { fourCorners } from '~/lib/frame/patterns/patterns/fourCorners'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('four corners', () => {
  it('is deterministic and sane', () => {
    const a = fourCorners.place(ctxFor()); const b = fourCorners.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('centres the title', () => {
    const title = fourCorners.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(title.x).toBeGreaterThan(0.3); expect(title.x).toBeLessThan(0.7)
    expect(title.y).toBeGreaterThan(0.3); expect(title.y).toBeLessThan(0.7)
  })
  it('sends the small texts to distinct corners', () => {
    const out = fourCorners.place(ctxFor()) // fixture has details, date, caption
    const smalls = out.ops.filter(o => o.target !== 'title')
    const keys = smalls.map(o => `${o.x < 0.5 ? 'l' : 'r'}${o.y < 0.5 ? 't' : 'b'}`)
    expect(new Set(keys).size).toBe(keys.length) // no two share a corner
  })
})
