import { describe, it, expect } from 'vitest'
import { spacedLines } from '~/lib/frame/patterns/patterns/spacedLines'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([
  { id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'a festival', fontSize: 0.03 },
])

describe('spaced lines', () => {
  it('fits phrase and sentence, not a single word', () => {
    expect(spacedLines.fits).toContain('phrase')
    expect(spacedLines.fits).toContain('sentence')
    expect(spacedLines.fits).not.toContain('word')
  })
  it('is deterministic and sane', () => {
    const a = spacedLines.place(ctxFor({ elements: phrase() }))
    const b = spacedLines.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('puts the title into expressive layout spread down the height', () => {
    const title = spacedLines.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive).toBeTruthy()
    expect(title.expressive!.wordsPerLine).toBe(1)
    expect(title.valign).toBe('justify')
    expect(title.boxH).toBeGreaterThan(0)
    expect(title.lineBreak).toBeUndefined() // words kept whole; the engine splits them
  })
})
