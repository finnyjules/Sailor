import { describe, it, expect } from 'vitest'
import {
  relightLightsToLayers, hasLegacyRelightLights, setupToLightLayers, relightBoxToFrame, frameToRelightBox,
} from '~/lib/frame/lighting/convertRelight'
import { relightSetup, RELIGHT_SETUP_NAMES } from '~/lib/relight/presets'
import { MAX_LIGHTS, DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import type { LocalLayer, LightLayer } from '~/composables/useCompositorLayers'

const W = 1000, H = 500
const old = (over: Record<string, unknown> = {}) => ({
  id: 'l1', x: 0.85, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 2, reach: 1.4, on: true, ...over,
})
const relight = (lights?: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'fx:relight:0', type: 'relight', visible: true, keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true,
  ...(lights ? { lights } : {}), ...over,
})
const photo = (over: Record<string, unknown> = {}, lights: unknown[] | null = [old()]) => ({
  id: 'p1', kind: 'image', filename: 'a.png', x: 0.5, y: 0.5, w: 0.5, h: 0.25, rotation: 0, opacity: 1,
  effects: [relight(lights ?? undefined)], ...over,
}) as unknown as LocalLayer
const text = (id = 't1') => ({ id, kind: 'text', text: 'Hi', x: 0.2, y: 0.2, rotation: 0, opacity: 1 }) as unknown as LocalLayer
const lightsOf = (ls: readonly LocalLayer[]) => ls.filter(l => l.kind === 'light') as LightLayer[]

describe('box → Frame mapping', () => {
  it('maps a box fraction through the centre and size (w, h in Frame widths)', () => {
    const p = photo()
    // box is 500 × 250 px centred at (500, 250): (1, 0.5) is its right edge middle
    expect(relightBoxToFrame(p, 1, 0.5, W, H)).toEqual({ x: expect.closeTo(0.75, 9), y: expect.closeTo(0.5, 9) })
    // (0.5, 0) is the top middle: 125 px up = 0.25 of the Frame's height
    expect(relightBoxToFrame(p, 0.5, 0, W, H)).toEqual({ x: expect.closeTo(0.5, 9), y: expect.closeTo(0.25, 9) })
  })
  it('turns with the photo (rotation in degrees, clockwise on screen)', () => {
    const p = photo({ rotation: 90 })
    // the box's right edge middle swings to straight below the centre: 250 px down
    expect(relightBoxToFrame(p, 1, 0.5, W, H)).toEqual({ x: expect.closeTo(0.5, 9), y: expect.closeTo(1, 9) })
  })
  it('inverts back to the box fraction', () => {
    const p = photo({ rotation: 33, x: 0.4, y: 0.6 })
    const f = relightBoxToFrame(p, 0.85, 0.3, W, H)
    const b = frameToRelightBox(p, f.x, f.y, W, H)
    expect(b.x).toBeCloseTo(0.85, 9); expect(b.y).toBeCloseTo(0.3, 9)
  })
  it('uses a wired layer\'s live aspect for its height', () => {
    const w = { id: 'w1', kind: 'wired', slot: 0, x: 0.5, y: 0.5, w: 0.5, lastAspect: 0.5, rotation: 0, opacity: 1, effects: [relight([old()])] } as unknown as LocalLayer
    expect(relightBoxToFrame(w, 0.5, 0, W, H).y).toBeCloseTo(0.25, 9)
  })
})

describe('relightLightsToLayers', () => {
  it('turns each old light into a lamp layer at the mapped spot, colour/brightness/reach as they are', () => {
    const r = relightLightsToLayers([photo()], undefined, W, H)
    const ls = lightsOf(r.layers)
    expect(ls).toHaveLength(1)
    // (0.85, 0.3) of a 500×250 box at (500, 250) → (675, 200) px
    expect(ls[0]!.x).toBeCloseTo(0.675, 9); expect(ls[0]!.y).toBeCloseTo(0.4, 9)
    expect(ls[0]!.light).toMatchObject({ type: 'lamp', height: 0.4, color: '#ffcf94', brightness: 2, reach: 1.4 })
    expect(r.dropped).toBe(0)
    expect(r.changed).toBe(true)
  })
  it('maps through a rotated photo', () => {
    const r = relightLightsToLayers([photo({ rotation: 90 }, [old({ x: 1, y: 0.5 })])], undefined, W, H)
    const l = lightsOf(r.layers)[0]!
    expect(l.x).toBeCloseTo(0.5, 9); expect(l.y).toBeCloseTo(1, 9)
  })
  it('puts the light layers at the top of the stack, in stack order', () => {
    const a = photo({ id: 'a' }, [old({ color: '#111111' }), old({ color: '#222222' })])
    const b = photo({ id: 'b' }, [old({ color: '#333333' })])
    const r = relightLightsToLayers([a, text(), b], undefined, W, H)
    expect(r.layers.map(l => l.kind)).toEqual(['image', 'text', 'image', 'light', 'light', 'light'])
    expect(lightsOf(r.layers).map(l => l.light.color)).toEqual(['#111111', '#222222', '#333333'])
  })
  it('caps the Frame at six lights and reports how many were left out', () => {
    const three = [old(), old(), old()]
    const r = relightLightsToLayers([photo({ id: 'a' }, three), photo({ id: 'b' }, three), photo({ id: 'c' }, three)], undefined, W, H)
    expect(lightsOf(r.layers)).toHaveLength(MAX_LIGHTS)
    expect(r.dropped).toBe(3)
  })
  it('makes a "behind" rim light height 0', () => {
    const r = relightLightsToLayers([photo({}, [old({ height: -0.2 })])], undefined, W, H)
    expect(lightsOf(r.layers)[0]!.light.height).toBe(0)
  })
  it('keeps an off light as a hidden light', () => {
    const r = relightLightsToLayers([photo({}, [old({ on: false })])], undefined, W, H)
    expect(lightsOf(r.layers)[0]!.visible).toBe(false)
  })
  it('switches lighting and shadows off on every non-photo layer; photos keep their lit default', () => {
    const plain = { id: 'i2', kind: 'image', filename: 'b.png', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1 } as unknown as LocalLayer
    const r = relightLightsToLayers([text(), plain, photo()], undefined, W, H)
    const byId = Object.fromEntries(r.layers.map(l => [l.id, l]))
    expect(byId.t1).toMatchObject({ lit: false, castsShadow: false })
    expect(byId.i2).toMatchObject({ lit: false, castsShadow: false })
    expect('lit' in byId.p1!).toBe(false)
    expect('castsShadow' in byId.p1!).toBe(false)
  })
  it('drops the old lights from the effect and keeps the photo controls', () => {
    const r = relightLightsToLayers([photo()], undefined, W, H)
    const fx = (r.layers.find(l => l.id === 'p1') as any).effects[0]
    expect('lights' in fx).toBe(false)
    expect(fx).toMatchObject({ type: 'relight', keep: 0.12, depth: 4, texture: 2, shadows: true })
    expect(hasLegacyRelightLights(r.layers)).toBe(false)
  })
  it('sets Darkness 0.45 unless the Frame already has a lighting record', () => {
    expect(relightLightsToLayers([photo()], undefined, W, H).lighting).toEqual({ ...DEFAULT_LIGHTING, darkness: 0.45 })
    const own = { darkness: 0.8, backgroundLit: false }
    expect(relightLightsToLayers([photo()], own, W, H).lighting).toEqual(own)
  })
  it('is idempotent: a Frame that already has light layers comes back unchanged', () => {
    const once = relightLightsToLayers([photo(), text()], undefined, W, H)
    const twice = relightLightsToLayers(once.layers, once.lighting, W, H)
    expect(twice.layers).toBe(once.layers)
    expect(twice.changed).toBe(false)
    expect(twice.dropped).toBe(0)
    // even with old lights still on an effect, an existing light layer wins
    const lit = [photo(), { id: 'x', kind: 'light', x: 0.5, y: 0.5, rotation: 0, opacity: 1, light: {} } as unknown as LocalLayer]
    const r = relightLightsToLayers(lit, undefined, W, H)
    expect(r.layers).toBe(lit)
    expect(r.changed).toBe(false)
  })
  it('leaves a Frame with no old lights alone', () => {
    const ls = [photo({}, null), text()]
    const r = relightLightsToLayers(ls, undefined, W, H)
    expect(r.layers).toBe(ls)
    expect(r.changed).toBe(false)
  })
  it('gives stable ids, so a read-only conversion paints the same lights every time', () => {
    const a = relightLightsToLayers([photo()], undefined, W, H)
    const b = relightLightsToLayers([photo()], undefined, W, H)
    expect(lightsOf(a.layers).map(l => l.id)).toEqual(lightsOf(b.layers).map(l => l.id))
  })
  it('does not touch its input', () => {
    const ls = [photo(), text()]
    const before = JSON.stringify(ls)
    relightLightsToLayers(ls, undefined, W, H)
    expect(JSON.stringify(ls)).toBe(before)
  })
})

describe('hasLegacyRelightLights', () => {
  it('is true only for a Relight effect that still carries lights', () => {
    expect(hasLegacyRelightLights([photo()])).toBe(true)
    expect(hasLegacyRelightLights([photo({}, null)])).toBe(false)
    expect(hasLegacyRelightLights([photo({}, [])])).toBe(false)
    expect(hasLegacyRelightLights([text()])).toBe(false)
    expect(hasLegacyRelightLights([])).toBe(false)
  })
})

describe('setupToLightLayers', () => {
  it('maps every setup from the photo\'s box to the Frame, as lamps', () => {
    const p = photo({ rotation: 0 }, null)
    for (const name of RELIGHT_SETUP_NAMES) {
      const s = relightSetup(name)
      const ls = setupToLightLayers(name, p, W, H)
      expect(ls, name).toHaveLength(s.lights.length)
      ls.forEach((l, i) => {
        const spec = s.lights[i]!
        const at = relightBoxToFrame(p, spec.x, spec.y, W, H)
        expect(l.kind).toBe('light')
        expect(l.x).toBeCloseTo(at.x, 9); expect(l.y).toBeCloseTo(at.y, 9)
        expect(l.light).toMatchObject({ type: 'lamp', height: Math.max(0, spec.height), color: spec.color, reach: spec.reach })
        expect(l.light.brightness).toBeCloseTo(Math.min(3, spec.brightness), 9)
      })
    }
  })
  it('Golden key lands right of centre and a little up on an upright photo', () => {
    const [l] = setupToLightLayers('Golden key', photo({}, null), W, H)
    expect(l!.x).toBeCloseTo(0.675, 9); expect(l!.y).toBeCloseTo(0.4, 9)
  })
  it('Rim\'s behind light becomes height 0', () => {
    expect(setupToLightLayers('Rim', photo({}, null), W, H)[0]!.light.height).toBe(0)
  })
  it('gives fresh ids each time', () => {
    const a = setupToLightLayers('Neon', photo({}, null), W, H), b = setupToLightLayers('Neon', photo({}, null), W, H)
    expect(new Set([...a, ...b].map(l => l.id)).size).toBe(4)
  })
})
