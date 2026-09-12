import { describe, it, expect } from 'vitest'
import { staircase } from '~/lib/frame/patterns/patterns/staircase'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('staircase', () => {
  it('does not fit a single word', () => { expect(staircase.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = staircase.place(ctxFor({ elements: phrase() }))
    const b = staircase.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('uses staircase placement, one word per line', () => {
    const title = staircase.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive!.placement).toBe('staircase')
    expect(title.expressive!.wordsPerLine).toBe(1)
  })
})
