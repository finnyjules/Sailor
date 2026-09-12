import { describe, it, expect } from 'vitest'
import { bottomHeavy } from '~/lib/frame/patterns/patterns/bottomHeavy'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('bottom-heavy', () => {
  it('is deterministic and sane', () => {
    const a = bottomHeavy.place(ctxFor()); const b = bottomHeavy.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('sits the title in the lower half of the page', () => {
    const title = bottomHeavy.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(title.y).toBeGreaterThan(0.5) // centre below the midline
  })
  it('places details above the title', () => {
    const out = bottomHeavy.place(ctxFor())
    const title = out.ops.find(o => o.target === 'title')!
    const details = out.ops.find(o => o.target === 'details')
    if (details) expect(details.y).toBeLessThan(title.y)
  })
})
