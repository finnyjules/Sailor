import { describe, it, expect } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})

describe('resolveLayout withBoxes', () => {
  it('without withBoxes, units stay empty (unchanged behaviour)', () => {
    const r = resolveLayout(doc([createRectLayer({ id: 'a' })]), 1000, 500)
    expect(r.identity).toBe(true)
    expect(r.units.size).toBe(0)
    expect(r.boxes.size).toBe(0)
  })
  it('at the design size: identity, layers by reference, but boxes and units filled', () => {
    const l = [createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.1 })]
    const r = resolveLayout(doc(l), 1000, 500, { withBoxes: true })
    expect(r.identity).toBe(true)
    expect(r.layers).toBe(l)
    expect(r.boxes.get('a')).toEqual({ x: 400, y: 200, w: 200, h: 100 })
    const u = r.units.get('a')!
    expect(u.kind).toBe('layer'); expect(u.unitId).toBe('a'); expect(u.memberIds).toEqual(['a'])
    expect(u.kSize).toBe(1); expect(u.canStretch).toBe(true)
    expect(u.designBox).toEqual({ x: 400, y: 200, w: 200, h: 100 })
    expect(u.viewBox).toEqual({ x: 400, y: 200, w: 200, h: 100 })
    expect(u.refDesign).toEqual({ x: 0, y: 0, w: 1000, h: 500 })
    expect(u.refView).toEqual({ x: 0, y: 0, w: 1000, h: 500 })
    expect(u.h.kind).toBe('center'); expect(u.v.kind).toBe('center')
    expect(u.hExplicit).toBe(false); expect(u.vExplicit).toBe(false)
  })
  it('same shape, twice the size: identity and layers by reference, boxes scaled', () => {
    const l = [createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.1 })]
    const r = resolveLayout(doc(l), 2000, 1000, { withBoxes: true })
    expect(r.identity).toBe(true); expect(r.layers).toBe(l)
    expect(r.boxes.get('a')).toEqual({ x: 800, y: 400, w: 400, h: 200 })
    expect(r.units.get('a')!.kSize).toBe(2)
    expect(r.units.get('a')!.refView).toEqual({ x: 0, y: 0, w: 2000, h: 1000 })
  })
  it('off-shape: units carry the held pin, the view box and the view reference', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // left-hugging
    const r = resolveLayout(doc([a]), 3000, 500, { withBoxes: true })
    expect(r.identity).toBe(false)
    const u = r.units.get('a')!
    expect(u.h.kind).toBe('left')
    expect(u.viewBox).toEqual({ x: 550, y: 200, w: 100, h: 100 })
    expect(u.refView).toEqual({ x: 0, y: 0, w: 3000, h: 500 })
  })
  it('flags stored pins as explicit per axis', () => {
    const a = createRectLayer({ id: 'a', x: 0.9, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right' } })
    const u = resolveLayout(doc([a]), 3000, 500, { withBoxes: true }).units.get('a')!
    expect(u.hExplicit).toBe(true); expect(u.vExplicit).toBe(false)
  })
  it('every member of a group shares the group unit', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.3, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const r = resolveLayout(doc([a, b], { groups: [{ id: 'g' }] }), 3000, 500, { withBoxes: true })
    const ua = r.units.get('a')!, ub = r.units.get('b')!
    expect(ua.kind).toBe('group'); expect(ua.unitId).toBe('g')
    expect(ua.memberIds.slice().sort()).toEqual(['a', 'b'])
    expect(ub.unitId).toBe('g'); expect(ub.viewBox).toEqual(ua.viewBox)
  })
})
