import { describe, it, expect } from 'vitest'
import { scatter } from '~/lib/frame/patterns/patterns/scatter'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('scatter', () => {
  it('fits a single word', () => { expect(scatter.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = scatter.place(ctxFor({ elements: word() }))
    const b = scatter.place(ctxFor({ elements: word() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('scatters the glyphs: a perChar expressive title op with a box', () => {
    const title = scatter.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(title.expressive?.perChar).toBe(true)
    expect(title.expressive?.placement).toBe('random')
    expect(title.w).toBeGreaterThan(0)
    expect(title.boxH).toBeGreaterThan(0)
    expect(title.fontSize).toBeGreaterThan(0)
  })
  it('varies with the seed', () => {
    const a = JSON.stringify(scatter.place(ctxFor({ elements: word(), seed: 1 })).ops)
    const b = JSON.stringify(scatter.place(ctxFor({ elements: word(), seed: 2 })).ops)
    expect(a).not.toBe(b)
  })
})
