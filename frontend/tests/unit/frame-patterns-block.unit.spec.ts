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
})
