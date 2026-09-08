import { describe, it, expect } from 'vitest'
import { runOff } from '~/lib/frame/patterns/patterns/runOff'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('runOff', () => {
  it('is deterministic', () => {
    expect(runOff.place(ctxFor())).toEqual(runOff.place(ctxFor()))
  })
  it('emits a title op that is oversize (wider than the frame) and cropped off an edge', () => {
    const { ops, did } = runOff.place(ctxFor())
    const title = ops.find(o => o.target === 'title')!
    expect(title.kind).toBe('text')
    expect(title.fontSize).toBeGreaterThan(0)
    // oversize: the normalized title width exceeds 1 (runs off the frame)
    expect(title.w!).toBeGreaterThan(1)
    // cropped: its centre sits outside [0,1] on x, so part is off-page
    expect(title.x < 0 || title.x > 1).toBe(true)
    expect(did).toMatch(/cropped by the (left|right) edge/)
  })
  it('places details and caption and keeps every op finite/on-page-ish', () => {
    const { ops } = runOff.place(ctxFor())
    expect(ops.find(o => o.target === 'details')).toBeTruthy()
    expect(ops.find(o => o.target === 'caption')).toBeTruthy()
    assertSaneOps(ops.filter(o => o.target !== 'title')) // title is intentionally off-page
  })
})
