import { describe, it, expect } from 'vitest'
import { groupTipStrokes } from '~/lib/brushTips/coverage'
import { replayStroke } from '~/lib/brushTips/replay'
import { defaultSettings } from '~/lib/brushTips/tips'
import type { TipStroke } from '~/lib/brushTips/record'

const mk = (tip: 'spray' | 'round' | 'bristle', erase = false): TipStroke => ({ tip, v: 1, size: 0.05, settings: defaultSettings(tip), seed: 1, pts: [0.1, 0.1, 0, 0.2, 0.2, 100], erase })
const legacy = { points: [{ x: 0, y: 0 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }

describe('groupTipStrokes', () => {
  it('joins consecutive same-tip paint, splits on tip change and on erase, skips legacy', () => {
    const g = groupTipStrokes([mk('spray'), mk('spray'), legacy, mk('round'), mk('round', true), mk('round')])
    expect(g.map(x => [x.tip, x.erase, x.strokes.length])).toEqual([['spray', false, 2], ['round', false, 1], ['round', true, 1], ['round', false, 1]])
  })
})
describe('replayStroke', () => {
  it('memoises finished strokes by object identity', () => {
    const s = mk('spray')
    const a = replayStroke(s), b = replayStroke(s)
    expect(a).toBe(b)
    expect(a.kind).toBe('dabs')
  })
})
