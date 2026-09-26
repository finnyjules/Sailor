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
describe('groupTipStrokes keeps per-group settings apart', () => {
  const round = (seed: number, over: Record<string, number>): TipStroke => ({ tip: 'round', v: 1, size: 0.05, settings: { ...defaultSettings('round'), ...over }, seed, pts: [0.1, 0.1, 0, 0.2, 0.2, 100] })
  it('round strokes with different relief or grain form separate groups', () => {
    expect(groupTipStrokes([round(1, {}), round(2, { relief: 1 })]).map(g => g.strokes.length)).toEqual([1, 1])
    expect(groupTipStrokes([round(1, {}), round(2, { grain: 0 })]).map(g => g.strokes.length)).toEqual([1, 1])
    expect(groupTipStrokes([round(1, {}), round(2, { softness: 0 })]).map(g => g.strokes.length)).toEqual([2])   // per-dab setting: may share
  })
  it("changing stroke 2's settings leaves stroke 1's group unchanged", () => {
    const s1 = round(1, { relief: 0.5, grain: 1 })
    const before = groupTipStrokes([s1, round(2, { relief: 0.5, grain: 1 })])
    for (const over of [{ relief: 2 }, { grain: 3 }, { relief: 0, grain: 0 }]) {
      const g = groupTipStrokes([s1, round(2, over)])
      expect(g[0]!.strokes).toEqual([s1])
      expect(g[0]!.strokes[0]!.settings).toEqual({ ...defaultSettings('round'), relief: 0.5, grain: 1 })
    }
    expect(before.length).toBe(1)   // equal settings still merge
  })
  it('relief splits spray and bristle groups too', () => {
    const b = (relief: number): TipStroke => ({ tip: 'bristle', v: 1, size: 0.05, settings: { ...defaultSettings('bristle'), relief }, seed: 1, pts: [0.1, 0.1, 0] })
    expect(groupTipStrokes([b(0), b(0.35), b(0.35)]).map(g => g.strokes.length)).toEqual([1, 2])
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
