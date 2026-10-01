import { describe, it, expect, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import {
  aimPos, clampLightPos, heightFromWheel, lightDotPos, nudgeForKey, pointerToLightPos, sunLine,
  LIGHT_PLACEMENT,
} from '~/lib/frame/lighting/handles'
import { newLightLayer } from '~/lib/frame/lighting/settings'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { setClipboard, _resetClipboard } from '~/lib/compositor/layerClipboard'

const D = { w: 400, h: 500 }
const at = (type: 'lamp' | 'spot' | 'sun', x: number, y: number, light: Record<string, unknown> = {}) => {
  const l = newLightLayer(type, { x, y })
  return { ...l, light: { ...l.light, ...light } }
}

describe('light dot geometry', () => {
  it('places the dot from the layer x/y in artboard px, outside the Frame too', () => {
    expect(lightDotPos(at('lamp', 0.25, 0.5), D)).toEqual({ x: 100, y: 250 })
    expect(lightDotPos(at('lamp', -0.5, 1.5), D)).toEqual({ x: -200, y: 750 })
  })
  it('a spot has an aim ring at its aim; a lamp and a sun have none', () => {
    expect(aimPos(at('spot', 0.5, 0.04, { aimX: 0.5, aimY: 0.55 }), D)).toEqual({ x: 200, y: 275 })
    expect(aimPos(at('lamp', 0.5, 0.5), D)).toBeNull()
    expect(aimPos(at('sun', 0.5, 0.5), D)).toBeNull()
  })
  it('a sun draws a line from its dot to the Frame centre; none on the centre, none for others', () => {
    expect(sunLine(at('sun', 0.02, 0.35), D)).toEqual({ x1: 8, y1: 175, x2: 200, y2: 250 })
    expect(sunLine(at('sun', 0.5, 0.5), D)).toBeNull()
    expect(sunLine(at('lamp', 0.1, 0.1), D)).toBeNull()
    expect(sunLine(at('spot', 0.1, 0.1), D)).toBeNull()
  })
  it('clamps positions to −0.5..1.5, junk to the centre', () => {
    expect(clampLightPos(-3)).toBe(-0.5)
    expect(clampLightPos(9)).toBe(1.5)
    expect(clampLightPos(0.3)).toBe(0.3)
    expect(clampLightPos(Number.NaN)).toBe(0.5)
  })
  it('maps a pointer to Frame fractions through the on-screen rect (pan/zoom included)', () => {
    const r = { left: 100, top: 50, width: 800, height: 1000 }
    expect(pointerToLightPos(500, 550, r)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointerToLightPos(-5000, 9000, r)).toEqual({ x: -0.5, y: 1.5 })
  })
  it('nudges 1% a press, 5% with Shift; other keys do nothing', () => {
    expect(nudgeForKey('ArrowLeft', false)).toEqual({ x: -0.01, y: 0 })
    expect(nudgeForKey('ArrowDown', true)).toEqual({ x: 0, y: 0.05 })
    expect(nudgeForKey('a', false)).toBeNull()
  })
  it('scroll changes Height within 0..1 (scrolling up raises it)', () => {
    expect(heightFromWheel(0.5, -100)).toBeCloseTo(0.6)
    expect(heightFromWheel(0.5, 100)).toBeCloseTo(0.4)
    expect(heightFromWheel(0.95, -500)).toBe(1)
    expect(heightFromWheel(0.05, 500)).toBe(0)
  })
  it('new lights land top left (lamp), top centre aiming at the middle (spot), left edge (sun)', () => {
    expect(LIGHT_PLACEMENT.lamp).toEqual({ x: 0.12, y: 0.08 })
    expect(LIGHT_PLACEMENT.spot).toEqual({ x: 0.5, y: 0.04, aimX: 0.5, aimY: 0.55 })
    expect(LIGHT_PLACEMENT.sun).toEqual({ x: 0.02, y: 0.35 })
  })
})

describe('adding a placed spot', () => {
  it('lands with its aim, as ONE undo step', () => {
    const node = reactive({ data: { properties: {} as Record<string, any> } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
    expect(ed.addLight('spot', LIGHT_PLACEMENT.spot)).toBe(true)
    const l = node.data.properties.sailor_localLayers[0]
    expect([l.x, l.y, l.light.aimX, l.light.aimY]).toEqual([0.5, 0.04, 0.5, 0.55])
    expect(ed.selectedId.value).toBe(l.id)
    ed.undo()
    expect(node.data.properties.sailor_localLayers ?? []).toHaveLength(0)
    expect(ed.canUndo.value).toBe(false)
  })
})

describe('the editor says when the cap leaves lights out', () => {
  afterEach(() => _resetClipboard())
  function makeEditor(onLightsDropped: (n: number, via: 'duplicate' | 'paste') => void) {
    const node = reactive({ data: { properties: {} as Record<string, any> } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null, onLightsDropped })
    return { node, ed }
  }
  it('reports a capped duplicate', async () => {
    const spy = vi.fn()
    const { node, ed } = makeEditor(spy)
    for (let i = 0; i < 6; i++) ed.addLight('lamp')
    ed.selectLocal(node.data.properties.sailor_localLayers[0].id)
    await ed.duplicateSelection()
    expect(spy).toHaveBeenCalledWith(1, 'duplicate')
  })
  it('reports a capped paste, and stays quiet when everything fits', () => {
    const spy = vi.fn()
    const { ed } = makeEditor(spy)
    for (let i = 0; i < 5; i++) ed.addLight('sun')
    setClipboard({ layers: [newLightLayer('lamp'), newLightLayer('spot'), newLightLayer('sun')], groups: [] })
    expect(ed.pasteClipboard(false)).toBe(2)
    expect(spy).toHaveBeenCalledWith(2, 'paste')
    spy.mockClear()
    const other = makeEditor(spy)
    expect(other.ed.pasteClipboard(false)).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})
