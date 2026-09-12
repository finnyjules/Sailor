import { describe, it, expect } from 'vitest'
import { block } from '~/lib/frame/patterns/patterns/block'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const sentence = () => inferElements([
  { id: 't', kind: 'text', text: 'A FESTIVAL OF SOUND AND THE CITY THIS OCTOBER', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'more', fontSize: 0.03 },
])

describe('block', () => {
  it('does not fit a single word', () => { expect(block.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = block.place(ctxFor({ elements: sentence() }))
    const b = block.place(ctxFor({ elements: sentence() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('sets a justified box and keeps the words for the layer to wrap', () => {
    const title = block.place(ctxFor({ elements: sentence() })).ops.find(o => o.target === 'title')!
    expect(title.align).toBe('justify')
    expect(title.w).toBeGreaterThan(0)          // boxW set ⇒ the layer auto-wraps
    expect(title.lineBreak).toBeUndefined()     // content untouched
    expect(title.expressive).toBeUndefined()
  })
  it('shrinks a long title below the unclamped floor so the justified block fits the page', () => {
    // A very long title: long enough that the fit bound drops below the smallest
    // size the pattern would ever pick UNCLAMPED (frame.w * 0.05 = 40px), so an
    // emitted size below that floor proves the clamp actually engaged.
    const longText = ('SOUND AND THE CITY ').repeat(40).trim()   // ~759 chars
    const long = inferElements([
      { id: 't', kind: 'text', text: longText, fontSize: 0.2 },
      { id: 'd', kind: 'text', text: 'more', fontSize: 0.03 },
    ])
    const title = block.place(ctxFor({ elements: long })).ops.find(o => o.target === 'title')!
    const frameW = 800, mbH = 1000 - 2 * 0.05 * 800   // margin-box height px = 920
    const sizePx = title.fontSize! * frameW
    // Recompute the fit bound with the SAME stub measure the fixture uses (len*60).
    const colWpx = title.w! * frameW
    const at100 = longText.length * 60
    const C = (at100 / 100 / colWpx) * 1.15
    const fitSizePx = Math.sqrt(mbH / C)
    expect(sizePx).toBeGreaterThan(1)                       // not degenerate / NaN
    expect(sizePx).toBeLessThan(frameW * 0.05)              // BELOW the unclamped floor ⇒ clamp engaged
    expect(sizePx).toBeLessThanOrEqual(fitSizePx + 1e-6)    // clamped to the fit bound ⇒ block fits mb.h
  })
})
