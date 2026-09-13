import { describe, it, expect } from 'vitest'
import { split } from '~/lib/frame/patterns/patterns/split'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('split', () => {
  it('needs an image', () => { expect(split.needs?.image).toBe(true) })
  it('is deterministic and sane', () => {
    const a = split.place(ctxFor()); const b = split.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('keeps the title column clear of the photo on both sides, even at a large margin', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const margin of [0.05, 0.12]) {   // 0.12 > the old 0.06 threshold where the overlap used to appear
        const out = split.place(ctxFor({ seed, margin }))
        const photo = out.ops.find(o => o.fill === 'photo')!
        const title = out.ops.find(o => o.target === 'title')!
        const pL = photo.x - photo.w! / 2, pR = photo.x + photo.w! / 2   // photo x-extent
        const tL = title.x - title.w! / 2, tR = title.x + title.w! / 2   // title x-extent
        expect(tL < pR && tR > pL).toBe(false)   // no horizontal overlap between photo and title column
      }
    }
  })
  it('emits a sentinel image op when there is no real image', () => {
    const { ops } = split.place(ctxFor({ elements: inferElements([
      { id: 't', kind: 'text', text: 'WORD', fontSize: 0.2 },
    ]) }))
    const photo = ops.find(o => o.fill === 'photo')!
    expect(photo).toBeDefined()
    expect(photo.target).toBe('image')
    expect(photo.w!).toBeGreaterThan(0)
  })
})
