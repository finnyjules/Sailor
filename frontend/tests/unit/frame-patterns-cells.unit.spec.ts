import { describe, it, expect } from 'vitest'
import { cells } from '~/lib/frame/patterns/patterns/cells'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('cells', () => {
  it('fits a word or phrase', () => { expect(cells.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = cells.place(ctxFor({ elements: word() }))
    expect(a).toEqual(cells.place(ctxFor({ elements: word() }))); assertSaneOps(a.ops)
  })
  it('packs the letters into a grid: perChar with both axes justified', () => {
    const t = cells.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(t.expressive?.perChar).toBe(true)
    expect(t.align).toBe('justify')
    expect(t.valign).toBe('justify')
    expect(t.boxH).toBeGreaterThan(0)
  })
})
