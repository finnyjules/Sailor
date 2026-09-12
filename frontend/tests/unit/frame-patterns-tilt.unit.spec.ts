import { describe, it, expect } from 'vitest'
import { tilt } from '~/lib/frame/patterns/patterns/tilt'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('tilt', () => {
  it('is deterministic and sane', () => {
    const a = tilt.place(ctxFor()); const b = tilt.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('rotates the title by a non-zero angle', () => {
    const title = tilt.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(typeof title.rotation).toBe('number')
    expect(Math.abs(title.rotation!)).toBeGreaterThan(0)
  })
  it('stacks a multi-word title one word per line', () => {
    const elements = inferElements([{ id: 't', kind: 'text', text: 'SOUND AND CITY', fontSize: 0.2 }])
    const title = tilt.place(ctxFor({ elements })).ops.find(o => o.target === 'title')!
    expect(title.lineBreak).toBe('SOUND\nAND\nCITY')
  })
})
