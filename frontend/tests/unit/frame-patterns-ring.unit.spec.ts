import { describe, it, expect } from 'vitest'
import { ring } from '~/lib/frame/patterns/patterns/ring'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('ring', () => {
  it('fits a single word', () => { expect(ring.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = ring.place(ctxFor({ elements: word() }))
    expect(a).toEqual(ring.place(ctxFor({ elements: word() }))); assertSaneOps(a.ops)
  })
  it('emits a perChar ring title op with a square box', () => {
    const t = ring.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(t.expressive?.perChar).toBe(true)
    expect(t.expressive?.placement).toBe('ring')
    expect(t.boxH).toBeGreaterThan(0)
  })
})
