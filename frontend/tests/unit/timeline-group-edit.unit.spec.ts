import { describe, it, expect } from 'vitest'
import { snapGroupDelta } from '../../shared/timeline/groupEdit'

describe('snapGroupDelta', () => {
  const members = [{ start: 100, end: 160 }, { start: 200, end: 230 }]

  it('no target in range: delta passes through', () => {
    expect(snapGroupDelta(members, 7, [500], 5)).toEqual({ delta: 7, guideFrame: null })
  })

  it('snaps on the dragged clip start', () => {
    // 100 + 8 = 108, target 110 is 2 away.
    expect(snapGroupDelta(members, 8, [110], 5)).toEqual({ delta: 10, guideFrame: 110 })
  })

  it('snaps on ANOTHER member end when that is closest', () => {
    // second member end 230 + 8 = 238; target 239 is 1 away; target 111 is 3 away from 108.
    expect(snapGroupDelta(members, 8, [111, 239], 5)).toEqual({ delta: 9, guideFrame: 239 })
  })

  it('threshold is strict', () => {
    expect(snapGroupDelta(members, 8, [113], 5)).toEqual({ delta: 8, guideFrame: null })
  })

  it('never pushes the earliest member below frame 0, and drops the guide', () => {
    expect(snapGroupDelta(members, -150, [], 5)).toEqual({ delta: -100, guideFrame: null })
  })

  it('a snap that would go below 0 is clamped too', () => {
    const m = [{ start: 3, end: 10 }, { start: 20, end: 30 }]
    // second end 30 - 5 = 25, target 21 → delta -9 → first start -6 → clamp to -3.
    expect(snapGroupDelta(m, -5, [21], 5)).toEqual({ delta: -3, guideFrame: null })
  })

  it('returns integer deltas for fractional input', () => {
    expect(snapGroupDelta(members, 7.6, [], 5).delta).toBe(8)
  })
})
