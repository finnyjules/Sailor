import { describe, it, expect } from 'vitest'
import { indexPattern } from '~/lib/frame/patterns/patterns/indexPattern'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import type { ResolvedGrid } from '~/lib/frame/patterns/types'

describe('indexPattern', () => {
  it('is deterministic and sane', () => {
    const a = indexPattern.place(ctxFor()); const b = indexPattern.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('sets the date large and in the accent role', () => {
    const { ops } = indexPattern.place(ctxFor())
    const date = ops.find(o => o.target === 'date')!
    const title = ops.find(o => o.target === 'title')!
    const caption = ops.find(o => o.target === 'caption')
    expect(date.colorRole).toBe('accent')
    expect(date.fontSize!).toBeGreaterThan(caption ? caption.fontSize! : 0)
    expect(title).toBeTruthy()
  })
  it('snaps the details column to a grid line when a grid is present', () => {
    const grid: ResolvedGrid = { xs: [40, 240, 440, 560, 760], ys: [40, 500, 960], regions: [] }
    const { ops } = indexPattern.place(ctxFor({ grid }))
    const details = ops.find(o => o.target === 'details')!
    // the details left edge (centre.x*w - w/2) must sit on one of the xs (±1px)
    const leftPx = details.x * 800 - (details.w! * 800) / 2
    const onLine = grid.xs.some(e => Math.abs(e - leftPx) < 1.5)
    expect(onLine).toBe(true)
  })
})
