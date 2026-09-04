import { describe, it, expect } from 'vitest'
import { computeSnapAdjust } from '~/lib/compositor/layerEdits'

const box = { cx: 0.31, cy: 0.5, hx: 0.1, hy: 0.1 }  // left edge at 0.21

describe('computeSnapAdjust grid targets', () => {
  it('snaps a box edge to a nearby grid line', () => {
    const r = computeSnapAdjust(box, [], 0.02, 0.02, [], [0.2, 0.4, 0.6], [])
    expect(r.guideX).toBe(0.2)              // left edge 0.21 snaps to 0.2
    expect(r.dx).toBeCloseTo(-0.01, 5)
  })
  it('ignores grid lines beyond the threshold', () => {
    const r = computeSnapAdjust(box, [], 0.005, 0.005, [], [0.2], [])
    expect(r.guideX).toBeNull()
  })
  it('no grid args → unchanged behaviour', () => {
    const r = computeSnapAdjust(box, [], 0.02, 0.02)
    expect(r.guideX).toBeNull()             // canvasTargets default [0,0.5,1], none within 0.02 of edges
  })
})
