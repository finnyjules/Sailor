import { describe, it, expect } from 'vitest'
import { cascade } from '~/lib/frame/patterns/patterns/cascade'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('cascade', () => {
  it('fits a single word', () => { expect(cascade.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = cascade.place(ctxFor({ elements: word() }))
    const b = cascade.place(ctxFor({ elements: word() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('steps the glyphs down: perChar staircase, one glyph per line', () => {
    const title = cascade.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(title.expressive?.perChar).toBe(true)
    expect(title.expressive?.placement).toBe('staircase')
    expect(title.expressive?.wordsPerLine).toBe(1)
    expect(title.boxH).toBeGreaterThan(0)
  })
})
