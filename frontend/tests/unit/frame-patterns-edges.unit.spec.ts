import { describe, it, expect } from 'vitest'
import { edges } from '~/lib/frame/patterns/patterns/edges'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('edges', () => {
  it('does not fit a single word', () => { expect(edges.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = edges.place(ctxFor({ elements: phrase() }))
    const b = edges.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('uses edge placement', () => {
    const title = edges.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive!.placement).toBe('edges')
  })
})
