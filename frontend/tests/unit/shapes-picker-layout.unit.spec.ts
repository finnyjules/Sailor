import { describe, it, expect } from 'vitest'
import { anchorAbove } from '../../app/lib/shapes/pickerLayout'

describe('anchorAbove', () => {
  it('falls back to a fixed corner when there is no rect', () => {
    expect(anchorAbove(null)).toEqual({ x: 16, y: 16 })
  })
  it('anchors above the rect, offset by the picker height', () => {
    expect(anchorAbove({ left: 100, top: 900 } as DOMRect)).toEqual({ x: 100, y: 900 - 316 })
  })
  it('clamps to an 8px minimum when the rect is too close to the top', () => {
    expect(anchorAbove({ left: 100, top: 50 } as DOMRect)).toEqual({ x: 100, y: 8 })
  })
})
