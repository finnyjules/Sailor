import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import {
  MAX_LIGHTS, LIGHT_DEFAULTS, DEFAULT_LIGHTING, defaultLit, defaultCastsShadow, defaultLift,
  sanitizeLightLayer, newLightLayer, readFrameLighting, sanitizeLighting,
  effectiveLit, effectiveCasts, effectiveLift, visibleLights,
} from '~/lib/frame/lighting/settings'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { setClipboard, _resetClipboard } from '~/lib/compositor/layerClipboard'
import { buildUnits } from '~/lib/frame/responsive/units'
import { animatableProperties } from '~/lib/motionx/adapter/frame'
import { layerPaints, localLayerBox } from '~/composables/useCompositorLayers'

describe('light layer sanitizer', () => {
  it('clamps every field', () => {
    const l = sanitizeLightLayer({ id: 'a', kind: 'light', x: 9, y: -9, rotation: 0, opacity: 1,
      light: { type: 'spot', height: 5, color: '#ABCDEF', brightness: 99, reach: 0, aimX: 9, aimY: -9, cone: 5, edge: 3 } })
    expect(l.x).toBe(1.5); expect(l.y).toBe(-0.5)
    expect(l.light).toMatchObject({ type: 'spot', height: 1, color: '#abcdef', brightness: 3, reach: 0.2, cone: 0.8, edge: 1 })
    const lo = sanitizeLightLayer({ id: 'a', light: { type: 'spot', height: -1, brightness: -1, reach: 9, cone: 0 } } as any)
    expect(lo.light).toMatchObject({ height: 0, brightness: 0, reach: 2, cone: 0.1 })
  })
  it('falls back per type and an unknown type becomes lamp', () => {
    expect(sanitizeLightLayer({ id: 'a', light: { type: 'nope' } } as any).light).toMatchObject(LIGHT_DEFAULTS.lamp)
    expect(sanitizeLightLayer({ id: 'a', light: { type: 'sun', color: 'red', brightness: 'x' } } as any).light)
      .toMatchObject({ type: 'sun', color: LIGHT_DEFAULTS.sun.color, brightness: 1.2 })
    expect(sanitizeLightLayer({ id: 'a' } as any).light.type).toBe('lamp')
  })
  it('keeps the exact defaults per type', () => {
    expect(LIGHT_DEFAULTS.lamp).toMatchObject({ height: 0.55, color: '#ffb36b', brightness: 1.6, reach: 1.0 })
    expect(LIGHT_DEFAULTS.spot).toMatchObject({ height: 0.8, color: '#fff1d6', brightness: 2.2, reach: 1.4, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 })
    expect(LIGHT_DEFAULTS.sun).toMatchObject({ height: 0.4, color: '#fff3e2', brightness: 1.2 })
  })
  it('newLightLayer places at a point and defaults to centre', () => {
    const l = newLightLayer('spot', { x: 0.2, y: 0.3 })
    expect(l.kind).toBe('light'); expect(l.x).toBe(0.2); expect(l.y).toBe(0.3); expect(l.light.type).toBe('spot')
    expect(newLightLayer('lamp').x).toBe(0.5)
  })
})

describe('per-layer light switches', () => {
  it('defaults per kind', () => {
    expect(defaultLit()).toBe(true)
    for (const k of ['text', 'rect', 'ellipse', 'polygon', 'star', 'path', 'line', 'brush', 'deal', 'scatter']) expect(defaultCastsShadow(k as any)).toBe(true)
    expect(defaultCastsShadow('image')).toBe(false); expect(defaultCastsShadow('wired')).toBe(false)
    expect(defaultLift('text')).toBe(0.045); expect(defaultLift('rect')).toBe(0.035)
    expect(defaultLift('image')).toBe(0.03); expect(defaultLift('wired')).toBe(0.03)
  })
  it('effective values honour overrides and clamp lift', () => {
    expect(effectiveLit({ kind: 'rect' } as any)).toBe(true)
    expect(effectiveLit({ kind: 'rect', lit: false } as any)).toBe(false)
    expect(effectiveCasts({ kind: 'image' } as any)).toBe(false)
    expect(effectiveCasts({ kind: 'image', castsShadow: true } as any)).toBe(true)
    expect(effectiveLift({ kind: 'text' } as any)).toBe(0.045)
    expect(effectiveLift({ kind: 'text', lift: 9 } as any)).toBe(0.15)
    expect(effectiveLift({ kind: 'text', lift: 0 } as any)).toBe(0.005)
  })
})

describe('visibleLights', () => {
  const L = (id: string, extra: any = {}) => ({ ...newLightLayer('lamp'), id, ...extra })
  it('keeps stack order, drops hidden and non-lights, caps at 6', () => {
    const layers: any[] = [L('a'), { id: 'r', kind: 'rect' }, L('b', { visible: false }), L('c')]
    expect(visibleLights(layers).map(l => l.id)).toEqual(['a', 'c'])
    const many = Array.from({ length: 9 }, (_, i) => L('l' + i))
    expect(visibleLights(many as any).map(l => l.id)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5'])
    expect(MAX_LIGHTS).toBe(6)
  })
})

describe('frame lighting record', () => {
  it('absent or garbage reads defaults', () => {
    expect(readFrameLighting(undefined)).toEqual(DEFAULT_LIGHTING)
    expect(readFrameLighting({ sailor_localLighting: 'x' })).toEqual({ darkness: 0.45, backgroundLit: true })
    expect(sanitizeLighting({ darkness: 9, backgroundLit: 'no' })).toEqual({ darkness: 1, backgroundLit: true })
    expect(sanitizeLighting({ darkness: -1, backgroundLit: false })).toEqual({ darkness: 0, backgroundLit: false })
  })
})

function makeEditor(props: Record<string, any> = {}) {
  const node = reactive({ data: { properties: props } })
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
  return { node, ed }
}

describe('editor lighting', () => {
  it('a Frame without the key writes nothing on load', () => {
    const { node, ed } = makeEditor({ sailor_localLayers: [] })
    void ed.lighting.value
    expect('sailor_localLighting' in node.data.properties).toBe(false)
  })
  it('undo restores Darkness', () => {
    const { node, ed } = makeEditor()
    ed.setLighting({ darkness: 0.8 })
    expect((node.data.properties as any).sailor_localLighting.darkness).toBe(0.8)
    expect(ed.lighting.value.darkness).toBe(0.8)
    ed.undo()
    expect('sailor_localLighting' in node.data.properties).toBe(false)
    expect(ed.lighting.value).toEqual(DEFAULT_LIGHTING)
    ed.redo()
    expect(ed.lighting.value.darkness).toBe(0.8)
  })
  it('addLight refuses the 7th light', () => {
    const { node, ed } = makeEditor()
    for (let i = 0; i < 6; i++) expect(ed.addLight('lamp')).toBe(true)
    expect(ed.addLight('sun')).toBe(false)
    expect((node.data.properties as any).sailor_localLayers).toHaveLength(6)
  })
  it('duplicate respects the cap', async () => {
    const { node, ed } = makeEditor()
    for (let i = 0; i < 6; i++) ed.addLight('lamp')
    ed.selectLocal((node.data.properties as any).sailor_localLayers[0].id)
    await ed.duplicateSelection()
    expect((node.data.properties as any).sailor_localLayers).toHaveLength(6)
  })
})

describe('paste respects the cap', () => {
  it('trims pasted lights to the room left, across Frames, and reports the drop', () => {
    const src = makeEditor()
    for (let i = 0; i < 3; i++) src.ed.addLight('lamp')
    src.ed.selectedIds.value = new Set(((src.node.data.properties as any).sailor_localLayers as any[]).map(l => l.id))
    void src.ed.copySelection()
    const dst = makeEditor()
    for (let i = 0; i < 4; i++) dst.ed.addLight('sun')
    expect(dst.ed.pasteClipboard(false)).toBe(1)
    expect(((dst.node.data.properties as any).sailor_localLayers as any[]).filter(l => l.kind === 'light')).toHaveLength(6)
    expect(dst.ed.pasteClipboard(false)).toBe(3)
    expect(((dst.node.data.properties as any).sailor_localLayers as any[])).toHaveLength(6)
    _resetClipboard()
  })
  it('pastes everything when there is room', () => {
    const { ed } = makeEditor()
    setClipboard({ layers: [newLightLayer('lamp'), { id: 'r', kind: 'rect', x: 0.2, y: 0.2, rotation: 0, opacity: 1, w: 0.1, h: 0.1 } as any], groups: [] })
    expect(ed.pasteClipboard(false)).toBe(0)
    _resetClipboard()
  })
})

describe('lights elsewhere', () => {
  const rect: any = { id: 'r', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.1, fill: '#fff', stroke: '', strokeWidth: 0 }
  it('buildUnits skips lights', () => {
    const units = buildUnits([rect, newLightLayer('lamp')], [], null, 1000, 1000)
    expect(units.map(u => u.id)).toEqual(['r'])
  })
  it('a light animates Position X/Y only', () => {
    const props = animatableProperties(newLightLayer('spot') as any)
    expect(props.map(p => p.label)).toEqual(['Position X', 'Position Y'])
  })
  it('layerPaints and localLayerBox', () => {
    const l = newLightLayer('lamp') as any
    expect(layerPaints(l)).toEqual([])
    expect(localLayerBox(null, l, 1000, 1000)).toEqual({ w: 0, h: 0 })
    expect(localLayerBox(null, rect, 1000, 1000)).toEqual({ w: 200, h: 100 })
    expect(layerPaints(rect)).toEqual(['#fff', ''])
  })
})
