import { describe, it, expect } from 'vitest'
import { bakePile, FRAME_HALF_H, PILE_SAMPLES } from '~/lib/spacetype/pile/physics'
import type { PileTokenSpec } from '~/lib/spacetype/pile/tokens'

const FRAME = { width: 960, height: 540 }
function boxes(n: number): PileTokenSpec[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'shape' as const, shapeId: 'x', w: 0.8, h: 0.8, fillIndex: i }))
}
const params = (over: Record<string, unknown> = {}) =>
  ({ container: 0.8, gravity: 1, bounciness: 0.1, dropSpread: 0.5, settleTime: 0.6, seed: 1, ...over }) as any

describe('bakePile', () => {
  it('produces a fixed-length trajectory, one pose per token per sample', () => {
    const traj = bakePile(boxes(5), params(), FRAME)
    expect(traj).toHaveLength(PILE_SAMPLES)
    expect(traj[0]).toHaveLength(5)
    expect(traj[PILE_SAMPLES - 1]).toHaveLength(5)
  })

  it('every token rests ON or ABOVE the floor at the final sample', () => {
    const traj = bakePile(boxes(8), params(), FRAME)
    const last = traj[PILE_SAMPLES - 1]!
    for (const pose of last) {
      // token centre minus half-height stays at/above the floor line (small tolerance)
      expect(pose.y - 0.4).toBeGreaterThanOrEqual(-FRAME_HALF_H - 0.15)
    }
  })

  it('tokens have descended by the final sample (they fell)', () => {
    const traj = bakePile(boxes(6), params(), FRAME)
    for (let t = 0; t < 6; t++) {
      expect(traj[PILE_SAMPLES - 1]![t]!.y).toBeLessThan(traj[0]![t]!.y)
    }
  })

  it('holds the settled pose after the fall (last sample == the settle-fraction sample)', () => {
    const SETTLE_FRACTION = 0.8 // mirrors physics.ts (control removed; length = loop duration)
    const traj = bakePile(boxes(4), params(), FRAME)
    const settleIdx = Math.round((PILE_SAMPLES - 1) * SETTLE_FRACTION)
    expect(traj[PILE_SAMPLES - 1]).toEqual(traj[settleIdx])
  })

  it('a small pile settles INSIDE the frame, not frozen at its spawn above the top', () => {
    // Regression: single-step rest detection false-fired during the slow start of
    // free-fall, freezing 2-token (text-only) piles at their spawn point above the frame.
    const traj = bakePile(boxes(2), params(), FRAME)
    for (const pose of traj[PILE_SAMPLES - 1]!) {
      expect(pose.y).toBeLessThan(FRAME_HALF_H) // came down into the frame, didn't stay up top
    }
  })

  it('deterministic: identical trajectories for identical inputs', () => {
    const a = bakePile(boxes(7), params(), FRAME)
    const b = bakePile(boxes(7), params(), FRAME)
    expect(b).toEqual(a)
  })

  it('empty specs -> empty-per-sample trajectory', () => {
    const traj = bakePile([], params(), FRAME)
    expect(traj).toHaveLength(PILE_SAMPLES)
    expect(traj[0]).toEqual([])
  })
})
