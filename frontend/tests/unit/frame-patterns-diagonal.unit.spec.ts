import { describe, it, expect } from 'vitest'
import { diagonal } from '~/lib/frame/patterns/patterns/diagonal'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('diagonal', () => {
  it('is deterministic and sane', () => {
    const a = diagonal.place(ctxFor()); const b = diagonal.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('rotates the title on a strong diagonal (>= 30 degrees)', () => {
    const title = diagonal.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(Math.abs(title.rotation!)).toBeGreaterThanOrEqual(30)
  })
  it('stacks a multi-word title one word per line', () => {
    const elements = inferElements([{ id: 't', kind: 'text', text: 'SOUND AND CITY', fontSize: 0.2 }])
    const title = diagonal.place(ctxFor({ elements })).ops.find(o => o.target === 'title')!
    expect(title.lineBreak).toBe('SOUND\nAND\nCITY')
  })
  it('keeps the details clear of a long, rotated title (no overlap)', () => {
    // 10 words → a tall stacked block; at 45deg its rotated corner used to dip into a corner detail.
    const long = inferElements([
      { id: 't', kind: 'text', text: 'ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN', fontSize: 0.2 },
      { id: 'd', kind: 'text', text: 'a detail line', fontSize: 0.03 },
    ])
    const out = diagonal.place(ctxFor({ elements: long }))
    const title = out.ops.find(o => o.target === 'title')!
    const detail = out.ops.find(o => o.target !== 'title')!
    const frameW = 800, frameH = 1000
    const rad = Math.abs(title.rotation!) * Math.PI / 180
    const colW = title.w! * frameW
    const lines = title.lineBreak!.split('\n').length
    const blockH = title.fontSize! * frameW * 0.86 * lines
    const rotatedHalfH = (colW / 2) * Math.sin(rad) + (blockH / 2) * Math.cos(rad)
    const titleBottomPx = title.y! * frameH + rotatedHalfH             // title's rotated bottom edge
    const detailTopPx = detail.y! * frameH - (detail.fontSize! * frameW) / 2  // detail box top
    expect(detailTopPx).toBeGreaterThanOrEqual(titleBottomPx - 1e-6)   // detail is below the rotated title
  })
})
