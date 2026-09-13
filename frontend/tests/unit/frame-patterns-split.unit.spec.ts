import { describe, it, expect } from 'vitest'
import { split } from '~/lib/frame/patterns/patterns/split'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('split', () => {
  it('needs an image', () => { expect(split.needs?.image).toBe(true) })
  it('is deterministic and sane', () => {
    const a = split.place(ctxFor()); const b = split.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('places a photo op and a title op on opposite sides', () => {
    const out = split.place(ctxFor())
    const photo = out.ops.find(o => o.fill === 'photo')!
    const title = out.ops.find(o => o.target === 'title')!
    expect(photo).toBeTruthy()
    expect(Math.abs(photo.x - title.x)).toBeGreaterThan(0.2)  // opposite halves
  })
})
