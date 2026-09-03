import { describe, it, expect } from 'vitest'
import { createOcclusionRepaintGate } from '~/lib/studio/occlusion'

describe('createOcclusionRepaintGate', () => {
  it('paints immediately while visible, and owes nothing', () => {
    const gate = createOcclusionRepaintGate()
    expect(gate.shouldPaint()).toBe(true)
    expect(gate.owed).toBe(false)
  })

  it('swallows paint requests while occluded and marks a repaint owed', () => {
    const gate = createOcclusionRepaintGate()
    gate.setOccluded(true)
    expect(gate.shouldPaint()).toBe(false)
    expect(gate.owed).toBe(true)
  })

  it('setOccluded(false) returns true exactly once when a repaint is owed', () => {
    const gate = createOcclusionRepaintGate()
    gate.setOccluded(true)
    gate.shouldPaint() // marks owed
    expect(gate.setOccluded(false)).toBe(true)
    expect(gate.owed).toBe(false)
    expect(gate.setOccluded(false)).toBe(false)
  })

  it('setOccluded(false) returns false when no repaint is owed', () => {
    const gate = createOcclusionRepaintGate()
    gate.setOccluded(true)
    expect(gate.setOccluded(false)).toBe(false)
  })

  it('setOccluded(true) never returns true', () => {
    const gate = createOcclusionRepaintGate()
    expect(gate.setOccluded(true)).toBe(false)
    gate.shouldPaint()
    expect(gate.setOccluded(true)).toBe(false)
  })
})
