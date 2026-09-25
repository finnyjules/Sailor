// frontend/tests/unit/toolbar-anchor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { toolbarAnchor, unionBox } from '~/lib/canvas/toolbarAnchor'

describe('toolbarAnchor', () => {
  it('centres below the node in screen space', () => {
    expect(toolbarAnchor({ x: 100, y: 200, width: 240, height: 300 }, { x: 10, y: 20, zoom: 0.5 }, 1000))
      .toEqual({ left: 10 + (100 + 120) * 0.5, top: 20 + (200 + 300) * 0.5 + 10, placement: 'below' })
  })
  it('stays below when the pane height is unknown', () => {
    expect(toolbarAnchor({ x: 0, y: 0, width: 200, height: 100 }, { x: 0, y: 0, zoom: 1 }).placement).toBe('below')
  })
  it('flips above when there is no room under the node', () => {
    const r = toolbarAnchor({ x: 0, y: 500, width: 200, height: 400 }, { x: 0, y: 0, zoom: 1 }, 920)
    expect(r.placement).toBe('above')
    expect(r.top).toBe(500 - 10)
  })
  it('flips above when the bar would land on the bottom prompt stack', () => {
    // Node bottom at 560 → bar at 570..634; the stack starts at 600 and spans the middle.
    const r = toolbarAnchor({ x: 400, y: 380, width: 320, height: 180 }, { x: 0, y: 0, zoom: 1 }, 720, 10, { left: 300, right: 1050, top: 600 })
    expect(r.placement).toBe('above')
    expect(r.top).toBe(380 - 10)
  })
  it('stays below when the stack is off to the side', () => {
    const r = toolbarAnchor({ x: 1200, y: 380, width: 200, height: 180 }, { x: 0, y: 0, zoom: 1 }, 720, 10, { left: 300, right: 1050, top: 600 })
    expect(r.placement).toBe('below')
  })
  it('scales the anchor’s horizontal position with zoom', () => {
    const a = toolbarAnchor({ x: 0, y: 400, width: 200, height: 100 }, { x: 0, y: 0, zoom: 2 }, 5000)
    expect(a.left).toBe(200)
  })
})

describe('unionBox', () => {
  it('bounds several boxes', () => expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 20 }])).toEqual({ x: 0, y: 0, width: 30, height: 25 }))
  it('is null for none', () => expect(unionBox([])).toBeNull())
})
