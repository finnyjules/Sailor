// frontend/tests/unit/responsive-view-edit.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import { settleAxis, axisInfo, moveUnitAtView } from '~/lib/frame/responsive/viewEdit'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: LocalLayer[], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})
const unitAt = (layers: LocalLayer[], id: string, extra: Partial<FrameDoc> = {}) =>
  resolveLayout(doc(layers, extra), 3000, 500, { withBoxes: true }).units.get(id)!

// A left-hugging 100×100 rect: design 50..150, drawn at 550..650.
const leftRect = () => createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })

describe('settleAxis (the drop rule on one axis)', () => {
  it('stays automatic when the pin it had still fits', () => {
    const ax = axisInfo(unitAt([leftRect()], 'a'), 'h')
    const s = settleAxis(ax, 650, 750, 100)                 // moved +100: still in the left half
    expect(s.near).toBeCloseTo(150, 9); expect(s.far).toBeCloseTo(250, 9)
    expect(s.pin).toEqual({ clear: true })
  })
  it('takes the pin read from where it now sits in the view when that fits (left → right)', () => {
    const ax = axisInfo(unitAt([leftRect()], 'a'), 'h')
    const s = settleAxis(ax, 2050, 2150, 100)               // centre 2100: right half of the view
    expect(s.near).toBeCloseTo(550, 9); expect(s.far).toBeCloseTo(650, 9)   // 2100 − 1500 = 600
    expect(s.pin).toEqual({ clear: true })
  })
  it('keeps the pin you were looking at, stored, when no automatic pin fits', () => {
    const ax = axisInfo(unitAt([leftRect()], 'a'), 'h')
    const s = settleAxis(ax, 1750, 1850, 100)               // centre 1800
    // right would put it at 300 (reads as left); left puts it at 1300 (reads as right): neither agrees.
    expect(s.near).toBeCloseTo(1250, 9); expect(s.far).toBeCloseTo(1350, 9)
    expect(s.pin).toEqual({ set: 'left' })
  })
  it('an explicit pin maps straight back and is left alone', () => {
    const a = createRectLayer({ id: 'a', x: 0.9, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right' } })  // drawn at 2350..2450
    const ax = axisInfo(unitAt([a], 'a'), 'h')
    const s = settleAxis(ax, 2250, 2350, 100)               // centre 2300 → 2300 − 1500 = 800
    expect(s.near).toBeCloseTo(750, 9); expect(s.far).toBeCloseTo(850, 9)
    expect(s.pin).toBeNull()
  })
})

describe('moveUnitAtView', () => {
  it('drop: moves and stays automatic', () => {
    const l = [leftRect()]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, 100, 0, 'drop')
    expect(e.patches).toHaveLength(1)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.2, 9)
    expect(e.patches[0]!.patch.y).toBeCloseTo(0.5, 9)
    expect(e.pins).toStrictEqual({ unitId: 'a', onGroup: false, patch: { h: undefined, v: undefined } })
  })
  it('drag holds the pin it had; drop then flips it to the automatic one — same place on screen', () => {
    const l = [leftRect()]
    const u = unitAt(l, 'a')
    const drag = moveUnitAtView(u, l, 1000, 500, 1500, 0, 'drag')
    expect(drag.patches[0]!.patch.x).toBeCloseTo(1.6, 9)          // held left: 2100 − 500 = 1600
    expect(drag.pins!.patch).toEqual({ h: 'left', v: 'middle' })
    const drop = moveUnitAtView(u, l, 1000, 500, 1500, 0, 'drop')
    expect(drop.patches[0]!.patch.x).toBeCloseTo(0.6, 9)          // right: 2100 − 1500 = 600
    expect(drop.pins!.patch).toStrictEqual({ h: undefined, v: undefined })
  })
  it('drop: keeps the held pin, stored, when nothing automatic fits', () => {
    const l = [leftRect()]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, 1200, 0, 'drop')
    expect(e.patches[0]!.patch.x).toBeCloseTo(1.3, 9)
    expect(e.pins!.patch.h).toBe('left')
  })
  it('an explicit axis is not written', () => {
    const l = [createRectLayer({ id: 'a', x: 0.9, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right' } })]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, -100, 0, 'drop')
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.8, 9)
    expect('h' in e.pins!.patch).toBe(false)
    expect(e.pins!.patch).toStrictEqual({ v: undefined })
  })
  it('a group moves every member by the same design delta; pins go on the group', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.3, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const l = [a, b]
    const e = moveUnitAtView(unitAt(l, 'a', { groups: [{ id: 'g' }] }), l, 1000, 500, 100, 0, 'drop')
    const by = Object.fromEntries(e.patches.map(p => [p.id, p.patch]))
    expect(by.a!.x).toBeCloseTo(0.2, 9); expect(by.b!.x).toBeCloseTo(0.4, 9)
    expect(e.pins).toMatchObject({ unitId: 'g', onGroup: true })
  })
  it('a full-bleed background does not move (its edges are welded to the frame)', () => {
    const l = [createRectLayer({ id: 'bg', x: 0.5, y: 0.5, w: 1, h: 0.5 })]
    const e = moveUnitAtView(unitAt(l, 'bg'), l, 1000, 500, 40, 30, 'drop')
    expect(e.patches).toEqual([])
    expect(e.pins).toBeNull()
  })
  it('a stretched axis dragged past the frame edge stops just inside it (never welds)', () => {
    // design 50..950, 'both'; drawn 550..2450. −600 would put the near edge at design −550.
    const l = [createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, -600, 0, 'drop')
    const x = e.patches[0]!.patch.x as number
    expect(x).toBeGreaterThan(0.45); expect(x).toBeLessThan(0.4501)   // 0.01..900.01: width unchanged
  })
})

describe('re-wrapped text', () => {
  // 10px per character: 45 + 1 + 45 chars = 910px > the 900px design box → 2 lines (100px);
  // stretched to ~2900px at 3000 wide → 1 line (50px), held to its top edge.
  const measureCtx = { measureText: (s: string) => ({ width: s.length * 10 }), set font(_v: string) {}, letterSpacing: '0px' } as unknown as CanvasRenderingContext2D
  const text = () => createTextLayer({ id: 't', x: 0.5, y: 0.1, boxW: 0.9, fontSize: 0.05, lineHeight: 1, text: 'a'.repeat(45) + ' ' + 'b'.repeat(45) })
  const unitT = (l: LocalLayer[]) => resolveLayout(doc(l), 3000, 500, { measureCtx, withBoxes: true }).units.get('t')!

  it('reports the span the pins place (mappedBox) apart from the drawn, re-wrapped box (viewBox)', () => {
    const u = unitT([text()])
    expect(u.mappedBox.h).toBeCloseTo(100, 9)
    expect(u.viewBox.h).toBeCloseTo(50, 9)
  })
  it('a horizontal move does not drift it vertically', () => {
    const l = [text()]
    const e = moveUnitAtView(unitT(l), l, 1000, 500, 10, 0, 'drop')
    expect(e.patches[0]!.patch.y).toBeCloseTo(0.1, 9)
  })
})
