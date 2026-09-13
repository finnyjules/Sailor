import { describe, it, expect } from 'vitest'
import { fullBleed } from '~/lib/frame/patterns/patterns/fullBleed'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('full bleed', () => {
  it('needs an image', () => { expect(fullBleed.needs?.image).toBe(true) })
  it('is deterministic and sane', () => {
    const a = fullBleed.place(ctxFor()); const b = fullBleed.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('covers the frame with the photo and overprints the title on top', () => {
    const out = fullBleed.place(ctxFor())
    const photo = out.ops.find(o => o.fill === 'photo')!
    const title = out.ops.find(o => o.target === 'title')!
    expect(photo.w).toBeGreaterThanOrEqual(1)                 // full width
    expect((photo.z ?? 0)).toBeLessThan(title.z ?? 0)         // photo behind the title
    expect(title.colorRole).toBe('field')                     // reversed for contrast
  })
})
