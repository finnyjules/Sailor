import { describe, it, expect } from 'vitest'
import { ragged } from '~/lib/frame/patterns/patterns/ragged'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('ragged', () => {
  it('does not fit a single word', () => { expect(ragged.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = ragged.place(ctxFor({ elements: phrase() }))
    const b = ragged.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('uses random expressive placement with horizontal jitter', () => {
    const title = ragged.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive!.placement).toBe('random')
    expect(title.expressive!.jitterX).toBeGreaterThan(0)
    expect(title.valign).toBeUndefined()
  })
})
