// tests/unit/cleanup-badges.unit.spec.ts
// Where Clean up's badges sit (pen stage 5): one per fix, up and right of its
// spot, stacked rather than overlapping, inside the overlay; more than 20
// collapse into one per kind with a count. Across a switch, a badge that is
// still there keeps its place, so the one just clicked stays under the pointer.
import { describe, it, expect } from 'vitest'
import { cleanupBadges, BADGE_COLLAPSE_AT } from '~/lib/sketch/cleanup'
import type { CleanupFix } from '~/lib/sketch/cleanup'

const same = (p: { x: number; y: number }) => p
const fix = (i: number, kind: CleanupFix['kind'], label: string, x: number, y: number, on = true): CleanupFix =>
  ({ id: `${kind}:${i}`, kind, label, on, at: { x, y } })

describe('cleanupBadges', () => {
  it('one badge per fix, up and right of its spot', () => {
    const b = cleanupBadges([fix(1, 'join', 'Joined', 100, 100), fix(2, 'tangent', 'Tangent', 300, 200, false)], same, 680, 460)
    expect(b.map(x => [x.key, x.label, x.on, x.collapsed])).toEqual([['join:1', 'Joined', true, false], ['tangent:2', 'Tangent', false, false]])
    expect(b[0]).toMatchObject({ x: 106, y: 80, ax: 100, ay: 100 })
  })
  it('badges on one spot stack instead of covering each other', () => {
    const b = cleanupBadges([fix(1, 'join', 'Joined', 100, 100), fix(2, 'tangent', 'Tangent', 100, 100)], same, 680, 460)
    expect(Math.abs(b[1]!.y - b[0]!.y)).toBeGreaterThanOrEqual(18)
  })
  it('stay inside the overlay', () => {
    const [b] = cleanupBadges([fix(1, 'join', 'Joined', 678, 2)], same, 680, 460)
    expect(b!.x + b!.w).toBeLessThanOrEqual(676)
    expect(b!.y).toBeGreaterThanOrEqual(16)
  })
  it('at the bottom edge, stacked badges step upward instead of piling on one spot', () => {
    const b = cleanupBadges([fix(1, 'join', 'Joined', 100, 458), fix(2, 'tangent', 'Tangent', 100, 458)], same, 680, 460)
    expect(Math.abs(b[1]!.y - b[0]!.y)).toBeGreaterThanOrEqual(18)
    expect(b[1]!.y + 16).toBeLessThanOrEqual(456)
  })
  it(`more than ${BADGE_COLLAPSE_AT} collapse into one per kind with a count`, () => {
    const fixes = [
      ...Array.from({ length: 18 }, (_, i) => fix(i, 'tangent', 'Tangent', i * 30, 50)),
      ...Array.from({ length: 4 }, (_, i) => fix(i, 'join', 'Joined', i * 30, 300, i !== 0)),
    ]
    const b = cleanupBadges(fixes, same, 680, 460)
    expect(b.map(x => [x.label, x.collapsed, x.on, x.ids.length])).toEqual([['Tangent ×18', true, true, 18], ['Joined ×4', true, false, 4]])
    expect(b[0]!.key).toBe('kind:tangent')
  })

  describe('across a switch (the previous layout passed back)', () => {
    it('a badge whose neighbour went away stays where it was', () => {
      const first = cleanupBadges([fix(1, 'join', 'Joined', 100, 100), fix(2, 'tangent', 'Tangent', 100, 100)], same, 680, 460)
      const clicked = first[1]!
      // the fix before it disappeared: without `prev` it would move up into the freed place
      const next = cleanupBadges([fix(2, 'tangent', 'Tangent', 100, 100, false)], same, 680, 460, first)
      expect(next[0]).toMatchObject({ key: clicked.key, x: clicked.x, y: clicked.y, on: false })
    })
    it('its spot shifting a little (the preview re-solved) does not move it; its dot follows the spot', () => {
      const first = cleanupBadges([fix(1, 'join', 'Joined', 100, 100)], same, 680, 460)
      const next = cleanupBadges([fix(1, 'join', 'Joined', 104, 97, false)], same, 680, 460, first)
      expect(next[0]).toMatchObject({ x: first[0]!.x, y: first[0]!.y, ax: 104, ay: 97 })
    })
    it('a spot that moved far is placed afresh', () => {
      const first = cleanupBadges([fix(1, 'join', 'Joined', 100, 100)], same, 680, 460)
      const next = cleanupBadges([fix(1, 'join', 'Joined', 300, 300)], same, 680, 460, first)
      expect(next[0]).toMatchObject({ x: 306, y: 280 })
    })
    it('a fix that newly appears never covers a badge that kept its place', () => {
      const first = cleanupBadges([fix(1, 'join', 'Joined', 100, 100)], same, 680, 460)
      const next = cleanupBadges([fix(0, 'tangent', 'Tangent', 100, 100), fix(1, 'join', 'Joined', 100, 100, false)], same, 680, 460, first)
      expect(next.map(b => b.key)).toEqual(['tangent:0', 'join:1'])   // order follows the fixes
      expect(next[1]).toMatchObject({ x: first[0]!.x, y: first[0]!.y })
      expect(Math.abs(next[0]!.y - next[1]!.y)).toBeGreaterThanOrEqual(18)
    })
  })
})
