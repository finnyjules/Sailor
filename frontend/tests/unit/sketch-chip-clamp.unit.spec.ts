import { describe, it, expect } from 'vitest'
import { clampRange, clampChipOrigin } from '~/lib/sketch/chipClamp'

describe('clampRange', () => {
  it('passes a value already inside the range through', () => {
    expect(clampRange(10, 4, 20)).toBe(10)
  })
  it('clamps below the low bound up to it', () => {
    expect(clampRange(-5, 4, 20)).toBe(4)
  })
  it('clamps above the high bound down to it', () => {
    expect(clampRange(50, 4, 20)).toBe(20)
  })
  it('falls back to lo when the range is degenerate (lo > hi)', () => {
    expect(clampRange(50, 30, 10)).toBe(30)
  })
})

describe('clampChipOrigin', () => {
  const width = 400, height = 300, chipWidth = 34

  it('leaves a chip that already fits untouched', () => {
    expect(clampChipOrigin(100, 100, chipWidth, width, height)).toEqual({ x: 100, y: 100 })
  })

  it('pulls a chip on the right edge back inside — the "R" cut off case', () => {
    const raw = { x: width - 5, y: 100 } // s.x + 6 landed at width-5, mostly off-canvas
    const r = clampChipOrigin(raw.x, raw.y, chipWidth, width, height)
    expect(r.x).toBe(width - chipWidth - 4)
    expect(r.x + chipWidth).toBeLessThanOrEqual(width - 4)
  })

  it('pulls a chip on the left edge back inside', () => {
    const r = clampChipOrigin(-20, 100, chipWidth, width, height)
    expect(r.x).toBe(4)
  })

  it('pulls a chip above the top back inside', () => {
    const r = clampChipOrigin(100, -30, chipWidth, width, height)
    expect(r.y).toBe(16)
  })

  it('pulls a chip below the bottom back inside', () => {
    const r = clampChipOrigin(100, height + 50, chipWidth, width, height)
    expect(r.y).toBe(height - 4)
  })

  it('never produces NaN when the overlay is smaller than the chip', () => {
    const r = clampChipOrigin(5, 5, chipWidth, 10, 10)
    expect(Number.isFinite(r.x)).toBe(true)
    expect(Number.isFinite(r.y)).toBe(true)
  })
})
