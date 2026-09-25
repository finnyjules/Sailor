// frontend/tests/unit/toolbar-anchor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { toolbarAnchor, unionBox } from '~/lib/canvas/toolbarAnchor'

describe('toolbarAnchor', () => {
  it('centres above the node in screen space', () => {
    expect(toolbarAnchor({ x: 100, y: 200, width: 240, height: 300 }, { x: 10, y: 20, zoom: 0.5 })).toEqual({ left: 10 + (100 + 120) * 0.5, top: 20 + 200 * 0.5 - 10, placement: 'above' })
  })
  it('flips below when there is no room above', () => {
    const r = toolbarAnchor({ x: 0, y: 0, width: 200, height: 100 }, { x: 0, y: 30, zoom: 1 })
    expect(r.placement).toBe('below')
    expect(r.top).toBe(30 + 100 + 10)
  })
  it('scales the anchor’s horizontal position with zoom', () => {
    const a = toolbarAnchor({ x: 0, y: 400, width: 200, height: 100 }, { x: 0, y: 0, zoom: 2 })
    expect(a.left).toBe(200)
  })
})

describe('unionBox', () => {
  it('bounds several boxes', () => expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 20 }])).toEqual({ x: 0, y: 0, width: 30, height: 25 }))
  it('is null for none', () => expect(unionBox([])).toBeNull())
})
