import { describe, it, expect } from 'vitest'
import { footer } from '~/lib/frame/patterns/patterns/footer'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const els = () => inferElements([
  { id: 't', kind: 'text', text: 'NOISE FLOOR', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'a festival', fontSize: 0.02 },
  { id: 'dt', kind: 'text', text: '2026', fontSize: 0.02 },
])

describe('footer', () => {
  it('is deterministic and sane', () => {
    const a = footer.place(ctxFor({ elements: els() }))
    expect(a).toEqual(footer.place(ctxFor({ elements: els() }))); assertSaneOps(a.ops)
  })
  it('keeps the title above the footer row with no overlap', () => {
    const ops = footer.place(ctxFor({ elements: els() })).ops
    const title = ops.find(o => o.target === 'title')!
    const feet = ops.filter(o => o.target !== 'title')
    expect(feet.length).toBeGreaterThan(0)
    // Pixels: y normalises to HEIGHT, boxH/fontSize to WIDTH. The title's box bottom
    // is a conservative bound (its text renders inside the box), and it clears the row.
    const W = 800, H = 1000                                          // ctxFor's default frame
    const titleBottomPx = title.y * H + ((title.boxH ?? title.fontSize) * W) / 2
    for (const f of feet) {
      const fTopPx = f.y * H - (f.fontSize * W) / 2
      expect(fTopPx).toBeGreaterThanOrEqual(titleBottomPx - 1e-6)
    }
  })
})
