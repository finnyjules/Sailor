import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'
import { buildUnits, layerDesignBox } from '~/lib/frame/responsive/units'

const W0 = 1000, H0 = 500

describe('layerDesignBox', () => {
  it('a rect: centre and width-normalized size → top-left px box', () => {
    const r = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    expect(layerDesignBox(r, null, W0, H0)).toEqual({ x: 400, y: 200, w: 200, h: 100 })
  })
  it('a rotated rect uses its axis-aligned outer box', () => {
    const r = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 90 })
    const b = layerDesignBox(r, null, W0, H0)
    expect(b.w).toBeCloseTo(100, 6); expect(b.h).toBeCloseTo(200, 6)
    expect(b.x).toBeCloseTo(450, 6); expect(b.y).toBeCloseTo(150, 6)
  })
  it('a cloner uses the full stamped extent', () => {
    const r = createRectLayer({ x: 0.2, y: 0.5, w: 0.1, h: 0.1, cloner: { ...DEFAULT_CLONER, enabled: true, mode: 'linear', countX: 3, countY: 1, spacingX: 0.2, spacingY: 0 } })
    const b = layerDesignBox(r, null, W0, H0)
    expect(b.x).toBeCloseTo(150, 6)         // first stamp at x=0.2 → 200 − 50
    expect(b.w).toBeCloseTo(500, 6)         // stamps at 0.2, 0.4, 0.6 → 150..650
  })
})

describe('buildUnits', () => {
  it('a plain layer is its own unit; shapes can stretch, images too, text only with a box', () => {
    const rect = createRectLayer({ id: 'r' })
    const img = createImageLayer('a.png', 1, { id: 'i' })
    const boxed = createTextLayer({ id: 't1', boxW: 0.3 })
    const free = createTextLayer({ id: 't2' })
    const units = buildUnits([rect, img, boxed, free], [], null, W0, H0)
    const by = Object.fromEntries(units.map(u => [u.id, u]))
    expect(by.r.canStretch).toBe(true)
    expect(by.i.canStretch).toBe(true)
    expect(by.t1.canStretch).toBe(true)
    expect(by.t2.canStretch).toBe(false)
  })
  it('rotated, skewed or corner-pinned layers cannot stretch', () => {
    const rot = createRectLayer({ id: 'a', rotation: 10 })
    const skew = createRectLayer({ id: 'b', skewX: 5 })
    const units = buildUnits([rot, skew], [], null, W0, H0)
    expect(units.every(u => !u.canStretch)).toBe(true)
  })
  it('members of a group form one group unit with the union box and the group pins', () => {
    const a = createRectLayer({ id: 'a', x: 0.2, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.6, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const units = buildUnits([a, b], [{ id: 'g', pins: { h: 'right' } }], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.kind).toBe('group')
    expect(units[0]!.memberIds.sort()).toEqual(['a', 'b'])
    // h is width-normalized (see LayerCommon.h), so h:0.1 → 100px, not 0.1·H0.
    // a spans x 150..250, b spans 550..650; both span y 250±50.
    expect(units[0]!.box).toEqual({ x: 150, y: 200, w: 500, h: 100 })
    expect(units[0]!.pins).toEqual({ h: 'right' })
    expect(units[0]!.canStretch).toBe(false)
  })
  it('a nested group belongs to its outermost group', () => {
    const a = createRectLayer({ id: 'a', groupId: 'inner' })
    const b = createRectLayer({ id: 'b', groupId: 'outer' })
    const units = buildUnits([a, b], [{ id: 'outer' }, { id: 'inner', parentId: 'outer' }], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.id).toBe('outer')
  })
  it('a mask source and the layers it clips form one maskPair unit boxed by the source', () => {
    const src = createRectLayer({ id: 's', x: 0.5, y: 0.5, w: 0.4, h: 0.4 })
    const clipped = createImageLayer('p.png', 1, { id: 'c', x: 0.5, y: 0.5, w: 0.9, maskedByKey: 'l:s' })
    const units = buildUnits([src, clipped], [], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.kind).toBe('maskPair')
    // Source is 0.4×0.4 width-normalized → 400×400px, centred at (500, 250).
    expect(units[0]!.box).toEqual({ x: 300, y: 50, w: 400, h: 400 })
    expect(units[0]!.pins).toBeUndefined()
  })
  it('a maskPair takes the SOURCE layer\'s pins', () => {
    const src = createRectLayer({ id: 's', pins: { h: 'left' } })
    const clipped = createImageLayer('p.png', 1, { id: 'c', maskedByKey: 'l:s', pins: { h: 'right' } })
    const units = buildUnits([src, clipped], [], null, W0, H0)
    expect(units[0]!.pins).toEqual({ h: 'left' })
  })
  it('a clipped layer joins the GROUP its mask source is in', () => {
    const src = createRectLayer({ id: 's', x: 0.5, y: 0.5, w: 0.4, h: 0.4, groupId: 'g' })
    const clipped = createImageLayer('p.png', 1, { id: 'c', x: 0.5, y: 0.5, w: 0.9, maskedByKey: 'l:s' })
    const units = buildUnits([src, clipped], [{ id: 'g' }], null, W0, H0)
    expect(units).toHaveLength(1)
    expect(units[0]!.kind).toBe('group')
    expect(units[0]!.memberIds.slice().sort()).toEqual(['c', 's'])
    expect(units[0]!.canStretch).toBe(false)
  })
  it('a cloner layer is a cloner unit that cannot stretch', () => {
    const r = createRectLayer({ id: 'r', cloner: { ...DEFAULT_CLONER, enabled: true, countX: 2, countY: 1, spacingX: 0.2 } })
    const units = buildUnits([r], [], null, W0, H0)
    expect(units[0]!.kind).toBe('cloner')
    expect(units[0]!.canStretch).toBe(false)
  })
})
