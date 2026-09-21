import { describe, it, expect } from 'vitest'
import { snapGroupDelta, computeGroupResize, neighbourGaps, type ResizeMember } from '../../shared/timeline/groupEdit'

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

const member = (id: string, over: Partial<ResizeMember> = {}): ResizeMember => ({
  id, start_frame: 100, in_frame: 30, length: 60, anchored: true,
  sourceFrames: null, speed: 1, gapBefore: null, gapAfter: null, ...over,
})

describe('computeGroupResize — right edge', () => {
  it('applies one delta to every member', () => {
    const r = computeGroupResize([member('a'), member('b', { start_frame: 300, length: 20 })], 'right', 10)
    expect(r.delta).toBe(10)
    expect(r.patches.get('a')).toEqual({ start_frame: 100, in_frame: 30, length: 70 })
    expect(r.patches.get('b')).toEqual({ start_frame: 300, in_frame: 30, length: 30 })
  })

  it('the shortest member limits shrinking (min length 1)', () => {
    const r = computeGroupResize([member('a'), member('b', { length: 5 })], 'right', -40)
    expect(r.delta).toBe(-4)
    expect(r.patches.get('b')!.length).toBe(1)
    expect(r.patches.get('a')!.length).toBe(56)
  })

  it('the source length limits growing, scaled by speed', () => {
    // 200 source frames, in 30, speed 2 → room for floor(170 / 2) = 85 frames; has 60 → +25.
    const r = computeGroupResize([member('a', { sourceFrames: 200, speed: 2 })], 'right', 100)
    expect(r.delta).toBe(25)
  })

  it('a clip already longer than its source cannot grow but is not forced to shrink', () => {
    const r = computeGroupResize([member('a', { sourceFrames: 50 })], 'right', 10)
    expect(r.delta).toBe(0)
  })

  it('stops at the neighbour', () => {
    expect(computeGroupResize([member('a', { gapAfter: 7 })], 'right', 50).delta).toBe(7)
  })
})

describe('computeGroupResize — left edge', () => {
  it('moves start, in_frame and length together for anchored clips', () => {
    const r = computeGroupResize([member('a')], 'left', 10)
    expect(r.patches.get('a')).toEqual({ start_frame: 110, in_frame: 40, length: 50 })
  })

  it('cannot rewind before the source start: the tightest in_frame wins', () => {
    const r = computeGroupResize([member('a'), member('b', { in_frame: 4 })], 'left', -50)
    expect(r.delta).toBe(-4)
    expect(r.patches.get('b')).toEqual({ start_frame: 96, in_frame: 0, length: 64 })
    expect(r.patches.get('a')).toEqual({ start_frame: 96, in_frame: 26, length: 64 })
  })

  it('unanchored clips keep in_frame and are limited by frame 0', () => {
    const r = computeGroupResize([member('a', { anchored: false, start_frame: 12 })], 'left', -50)
    expect(r.delta).toBe(-12)
    expect(r.patches.get('a')).toEqual({ start_frame: 0, in_frame: 30, length: 72 })
  })

  it('stops at the neighbour and never shrinks below 1 frame', () => {
    expect(computeGroupResize([member('a', { gapBefore: 3 })], 'left', -50).delta).toBe(-3)
    expect(computeGroupResize([member('a')], 'left', 500).delta).toBe(59)
  })

  it('every patch keeps start + length (the right edge) fixed', () => {
    const r = computeGroupResize([member('a'), member('b', { start_frame: 40, length: 9 })], 'left', 6)
    for (const [id, p] of r.patches) {
      const m = id === 'a' ? 160 : 49
      expect(p.start_frame + p.length).toBe(m)
    }
  })
})

describe('neighbourGaps', () => {
  const clips = [
    { id: 'x', start_frame: 0, length: 50 },
    { id: 'a', start_frame: 60, length: 40 },
    { id: 'b', start_frame: 100, length: 20 },
    { id: 'y', start_frame: 150, length: 10 },
  ]
  it('measures to the nearest clip that is not being trimmed', () => {
    expect(neighbourGaps(clips, 'a', new Set(['a', 'b']))).toEqual({ gapBefore: 10, gapAfter: 50 })
  })
  it('null when nothing is there', () => {
    // Nearest clip before y (150) is b, which ends at 120 → 30 frames of room.
    expect(neighbourGaps(clips, 'y', new Set(['y']))).toEqual({ gapBefore: 30, gapAfter: null })
    expect(neighbourGaps(clips, 'x', new Set(['x']))).toEqual({ gapBefore: null, gapAfter: 10 })
  })
  it('already-overlapping neighbours count as zero room, not negative', () => {
    const over = [{ id: 'a', start_frame: 0, length: 50 }, { id: 'n', start_frame: 40, length: 30 }]
    expect(neighbourGaps(over, 'a', new Set(['a'])).gapAfter).toBe(0)
  })
})
