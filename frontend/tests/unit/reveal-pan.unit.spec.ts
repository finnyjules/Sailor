import { describe, it, expect } from 'vitest'
import { revealDelta } from '~/lib/canvas/revealPan'

const view = { left: 0, top: 0, right: 1000, bottom: 600 }
const box = (left: number, top: number, w = 200, h = 150) => ({ left, top, right: left + w, bottom: top + h })

describe('revealDelta', () => {
  it('does nothing when the node is already in view', () => {
    expect(revealDelta(box(100, 100), view)).toEqual({ dx: 0, dy: 0 })
  })
  it('pans just enough from each side (32px margin)', () => {
    expect(revealDelta(box(-300, 100), view)).toEqual({ dx: 332, dy: 0 })
    expect(revealDelta(box(900, 100), view)).toEqual({ dx: -132, dy: 0 })
    expect(revealDelta(box(100, -50), view)).toEqual({ dx: 0, dy: 82 })
    expect(revealDelta(box(100, 500), view)).toEqual({ dx: 0, dy: -82 })
  })
  it('a node bigger than the room aligns its top-left', () => {
    expect(revealDelta(box(-100, -100, 2000, 2000), view)).toEqual({ dx: 132, dy: 132 })
  })
  it('respects a custom margin', () => {
    expect(revealDelta(box(-10, 100), view, 0)).toEqual({ dx: 10, dy: 0 })
  })
})
