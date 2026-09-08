import { describe, it, expect } from 'vitest'
import { statement } from '~/lib/frame/patterns/patterns/statement'
import { ctxFor, assertSaneOps, stubMeasure } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('statement', () => {
  it('is deterministic and sane', () => {
    const a = statement.place(ctxFor()); const b = statement.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('breaks a multi-word title one word per line', () => {
    const elements = inferElements([
      { id: 't', kind: 'text', text: 'SOUND AND SILENCE', fontSize: 0.2 },
    ])
    const title = statement.place(ctxFor({ elements })).ops.find(o => o.target === 'title')!
    expect(title.lineBreak).toBe('SOUND\nAND\nSILENCE')
    expect(title.align).toMatch(/left|center|right/)
  })
  it('fits the widest word inside the margin box (never wider than the frame)', () => {
    const title = statement.place(ctxFor()).ops.find(o => o.target === 'title')!
    // fontSize normalized to width; the single word NOISE must fit within margins
    const marginW = (1 - 2 * 0.05)
    const widthEm = stubMeasure('NOISE') / 100        // width per unit font size
    expect(title.fontSize! * widthEm).toBeLessThanOrEqual(marginW + 1e-6)
  })
})
