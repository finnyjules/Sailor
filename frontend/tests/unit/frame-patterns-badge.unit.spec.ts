import { describe, it, expect } from 'vitest'
import { badge } from '~/lib/frame/patterns/patterns/badge'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('badge', () => {
  it('needs a shape', () => { expect(badge.needs?.shape).toBe(true) })
  it('is deterministic and sane', () => {
    const a = badge.place(ctxFor()); const b = badge.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('makes a small badge shape and reverses a small text out of it', () => {
    const out = badge.place(ctxFor())  // fixture has date + caption
    const shape = out.ops.find(o => o.kind === 'shape')!
    expect(shape.fill).toBe('solid')
    // the badge is small relative to the frame
    expect(shape.w!).toBeLessThan(0.45)
    // some small text is reversed (field colour) — the badge's contents
    const reversed = out.ops.find(o => o.kind === 'text' && o.colorRole === 'field')
    expect(reversed).toBeTruthy()
  })
})
