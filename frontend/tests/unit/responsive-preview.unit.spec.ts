import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LayoutGrid } from '~/lib/frame/layoutGrid'
import { effectivePins, guideLinesFor } from '~/lib/frame/responsive/preview'
import { axisMap } from '~/lib/frame/responsive/axis'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})

/** An own layout grid: 2 columns of 500 on the 1000-wide design (margin 0, gutter 0), rows off, unit 20. */
const own = (over: Partial<LayoutGrid> = {}): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 2, fit: 'stretch', margin: 0, gutter: 0, width: 0 },
  rows: { mode: 'off', count: 4 }, ...over,
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
  it('grid availability follows the columns', () => {
    const inside = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1 })  // in column 1 (0..500)
    const straddle = createRectLayer({ id: 'b', x: 0.5, y: 0.5, w: 0.4, h: 0.1 })   // 300..700, across the divide
    expect(effectivePins(doc([inside], { grid: own() }), 'a', null)!.gridAvailable).toBe(true)
    expect(effectivePins(doc([straddle], { grid: own() }), 'b', null)!.gridAvailable).toBe(false)
    expect(effectivePins(doc([inside], { grid: own() }), 'a', null)!.holdTo).toBe('grid')
    expect(effectivePins(doc([straddle], { grid: own() }), 'b', null)!.holdTo).toBe('frame')
  })
  it('holdTo frame overrides an available grid', () => {
    const l = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'frame' } })
    const e = effectivePins(doc([l], { grid: own() }), 'a', null)!
    expect(e.holdTo).toBe('frame'); expect(e.holdAuto).toBe(false); expect(e.gridAvailable).toBe(true)
  })
  it('pins are inferred against what the layer holds to, as the resolver infers them', () => {
    // 425..475: at the right of column 1, but left of the frame's centre
    const l = createRectLayer({ id: 'a', x: 0.45, y: 0.5, w: 0.05, h: 0.1 })
    expect(effectivePins(doc([l], { grid: own() }), 'a', null)!.h).toBe('right')
    expect(effectivePins(doc([l]), 'a', null)!.h).toBe('left')
  })
  it('an unknown stored holdTo reads as automatic', () => {
    const l = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'section' as any } })
    const e = effectivePins(doc([l], { grid: own() }), 'a', null)!
    expect(e.holdTo).toBe('grid'); expect(e.holdAuto).toBe(true)
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
