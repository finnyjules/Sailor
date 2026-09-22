import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import { defaultGrid } from '~/lib/frame/grid'
import { effectivePins, guideLinesFor } from '~/lib/frame/responsive/preview'
import { axisMap } from '~/lib/frame/responsive/axis'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})

describe('effectivePins', () => {
  it('returns inferred pins flagged automatic when nothing is stored', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })   // near the left edge
    const e = effectivePins(doc([l]), 'a', null)!
    expect(e.h).toBe('left'); expect(e.v).toBe('middle')
    expect(e.hAuto).toBe(true); expect(e.vAuto).toBe(true); expect(e.keepAuto).toBe(true)
    expect(e.keepSize).toBe(false); expect(e.unitId).toBe('a')
  })
  it('a stored pin overrides the inferred one and is not flagged automatic', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right', keepSize: true } })
    const e = effectivePins(doc([l]), 'a', null)!
    expect(e.h).toBe('right'); expect(e.hAuto).toBe(false)
    expect(e.keepSize).toBe(true); expect(e.keepAuto).toBe(false)
    expect(e.v).toBe('middle'); expect(e.vAuto).toBe(true)   // v still inferred
  })
  it('for a grouped layer the pins belong to the group unit', () => {
    const a = createRectLayer({ id: 'a', x: 0.2, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.6, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const e = effectivePins(doc([a, b], { groups: [{ id: 'g', pins: { h: 'right' } }] }), 'a', null)!
    expect(e.unitId).toBe('g'); expect(e.h).toBe('right'); expect(e.hAuto).toBe(false)
  })
  it('section availability follows the grid', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    const inside = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1 })  // inside section 0 (0..500)
    const straddle = createRectLayer({ id: 'b', x: 0.5, y: 0.5, w: 0.4, h: 0.1 })   // spans the divide
    expect(effectivePins(doc([inside], { grid }), 'a', null)!.sectionAvailable).toBe(true)
    expect(effectivePins(doc([straddle], { grid }), 'b', null)!.sectionAvailable).toBe(false)
    expect(effectivePins(doc([inside], { grid }), 'a', null)!.holdTo).toBe('section')
  })
  it('holdTo frame overrides an available section', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    const l = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'frame' } })
    const e = effectivePins(doc([l], { grid }), 'a', null)!
    expect(e.holdTo).toBe('frame'); expect(e.holdAuto).toBe(false); expect(e.sectionAvailable).toBe(true)
  })
  it('returns null for an unknown layer id', () => {
    expect(effectivePins(doc([createRectLayer({ id: 'a' })]), 'zzz', null)).toBeNull()
  })
})

describe('guideLinesFor', () => {
  const box = { x: 100, y: 50, w: 200, h: 100 }
  it('a left/top unit draws guides to the left and top edges', () => {
    const g = guideLinesFor(box, { h: axisMap('left', 1000, 1, 0, 0), v: axisMap('left', 500, 1, 0, 0) }, 1000, 500)
    expect(g.left).toBeCloseTo(0.1, 9)     // box.x / W
    expect(g.top).toBeCloseTo(0.1, 9)      // box.y / H
    expect(g.right).toBeUndefined(); expect(g.bottom).toBeUndefined()
  })
  it('a both unit draws guides to both edges on that axis', () => {
    const g = guideLinesFor(box, { h: axisMap('both', 1000, 1, 500, 0), v: axisMap('center', 500, 1, 0, 0) }, 1000, 500)
    expect(g.left).toBeCloseTo(0.1, 9); expect(g.right).toBeCloseTo(0.3, 9)  // (box.x+box.w)/W
    expect(g.centerY).toBe(true)
  })
  it('a relative pin draws no guide on that axis; a vertical right (=bottom) draws to the bottom', () => {
    // The resolver builds vertical maps in axis-neutral names, so a bottom-held axis is kind 'right'.
    const g = guideLinesFor(box, { h: axisMap('relative', 1000, 1, 500, 0), v: axisMap('right', 500, 1, 250, 0) }, 1000, 500)
    expect(g.left).toBeUndefined(); expect(g.right).toBeUndefined()
    expect(g.bottom).toBeCloseTo((50 + 100) / 500, 9)
  })
})
