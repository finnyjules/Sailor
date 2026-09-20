import { describe, it, expect } from 'vitest'
import { kicker } from '~/lib/frame/patterns/patterns/kicker'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

// title + a caption that becomes the eyebrow
const els = () => inferElements([
  { id: 't', kind: 'text', text: 'SOUND AND VISION', fontSize: 0.2 },
  { id: 'c', kind: 'text', text: 'a festival of noise', fontSize: 0.02 },
])

describe('kicker', () => {
  it('fits a phrase, not a single word', () => { expect(kicker.fits).toContain('phrase'); expect(kicker.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = kicker.place(ctxFor({ elements: els() }))
    expect(a).toEqual(kicker.place(ctxFor({ elements: els() }))); assertSaneOps(a.ops)
  })
  it('places the eyebrow strictly above the title with no overlap', () => {
    const ops = kicker.place(ctxFor({ elements: els() })).ops
    const title = ops.find(o => o.target === 'title')!
    const eyebrow = ops.find(o => o.target !== 'title')
    expect(eyebrow).toBeTruthy()
    // Convert to pixels: y normalises to HEIGHT, fontSize (a one-line height) to WIDTH,
    // so a same-unit comparison is required — this is the real box clearance.
    const W = 800, H = 1000                                          // ctxFor's default frame
    const titleTopPx = title.y * H - (title.fontSize * W) / 2
    const eyebrowBottomPx = eyebrow!.y * H + (eyebrow!.fontSize * W) / 2
    expect(eyebrowBottomPx).toBeLessThanOrEqual(titleTopPx + 1e-6)   // real clearance, not "above the centre"
  })
})
