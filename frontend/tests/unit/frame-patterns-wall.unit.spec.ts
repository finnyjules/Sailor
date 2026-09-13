import { describe, it, expect } from 'vitest'
import { wall } from '~/lib/frame/patterns/patterns/wall'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('wall', () => {
  it('does not fit a single word', () => { expect(wall.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = wall.place(ctxFor({ elements: phrase() }))
    const b = wall.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('packs the title edge to edge: expressive with both axes justified', () => {
    const title = wall.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive).toBeTruthy()
    expect(title.align).toBe('justify')      // justify-X
    expect(title.valign).toBe('justify')     // justify-Y
    expect(title.boxH).toBeGreaterThan(0)
    expect(title.lineBreak).toBeUndefined()  // words kept whole; the engine splits them
  })
})
