import { describe, it, expect } from 'vitest'
import {
  relightLightsToLayers, hasLegacyRelightLights, setupToLightLayers, relightBoxToFrame, frameToRelightBox,
  activeRelightSetup, relightConvertedMessage, relightConversionToast,
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
    expect(ls[0]!.light).toMatchObject({ type: 'lamp', height: 0.4, color: '#ffcf94', brightness: 2 })
    // reach was in box heights: 1.4 × the box height 0.25 (Frame widths)
    expect(ls[0]!.light.reach).toBeCloseTo(0.35, 9)
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
  it('sets Darkness 0.45 and an unlit background (the layout looks as before) unless the Frame already has a lighting record', () => {
    expect(relightLightsToLayers([photo()], undefined, W, H).lighting).toEqual({ ...DEFAULT_LIGHTING, darkness: 0.45, backgroundLit: false })
    expect(relightLightsToLayers([photo()], { darkness: 0.3, backgroundLit: true }, W, H).lighting).toEqual({ darkness: 0.3, backgroundLit: true })
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
        expect(l.light).toMatchObject({ type: 'lamp', height: Math.max(0, spec.height), color: spec.color })
        expect(l.light.reach).toBeCloseTo(Math.min(2, Math.max(0.2, spec.reach * 0.25)), 9)
        expect(l.light.brightness).toBeCloseTo(Math.min(3, spec.brightness), 9)
      })
    }
  })
  it('Golden key lands right of centre and a little up on an upright photo', () => {
    const [l] = setupToLightLayers('Golden key', photo({}, null), W, H)
    expect(l!.x).toBeCloseTo(0.675, 9); expect(l!.y).toBeCloseTo(0.4, 9)
  })
  it('Golden key on a 0.5 × 0.25 photo: reach 1.4 box heights → 0.35 Frame widths, brightness 3.2 → 3', () => {
    const [l] = setupToLightLayers('Golden key', photo({}, null), W, H)
    expect(l!.light.reach).toBeCloseTo(0.35, 9)
    expect(l!.light.brightness).toBe(3)
  })
  it('a small photo\'s reach stops at the 0.2 floor', () => {
    const small = photo({ w: 0.1, h: 0.1 }, null)
    expect(setupToLightLayers('Golden key', small, W, H)[0]!.light.reach).toBe(0.2)
    const r = relightLightsToLayers([photo({ w: 0.1, h: 0.1 }, [old({ reach: 1 })])], undefined, W, H)
    expect(lightsOf(r.layers)[0]!.light.reach).toBe(0.2)
  })
  it('a light outside the photo maps outside it; outside the Frame it is clamped to the light range', () => {
    // Window x = −0.05 of a 500 × 250 box at (500, 250) → 225 px → 0.225 of the Frame
    const [win] = setupToLightLayers('Window', photo({}, null), W, H)
    expect(win!.x).toBeCloseTo(0.225, 9); expect(win!.y).toBeCloseTo(0.375, 9)
    // a full-Frame photo puts it just outside the Frame's left edge (still in range)
    const full = photo({ w: 1, h: 0.5 }, null)
    expect(setupToLightLayers('Window', full, W, H)[0]!.x).toBeCloseTo(-0.05, 9)
    // far outside (a 2000 px wide photo, x −0.4 of it → −1.7) → clamped to the light layer's −0.5
    const big = relightLightsToLayers([photo({ x: 0.1, w: 2, h: 1 }, [old({ x: -0.4, y: 0.5 })])], undefined, W, H)
    expect(lightsOf(big.layers)[0]!.x).toBe(-0.5)
  })
  it('converted brightness above 3 is clamped to 3', () => {
    const r = relightLightsToLayers([photo({}, [old({ brightness: 3.2 })])], undefined, W, H)
    expect(lightsOf(r.layers)[0]!.light.brightness).toBe(3)
  })
  it('Rim\'s behind light becomes height 0', () => {
    expect(setupToLightLayers('Rim', photo({}, null), W, H)[0]!.light.height).toBe(0)
  })
  it('gives fresh ids each time', () => {
    const a = setupToLightLayers('Neon', photo({}, null), W, H), b = setupToLightLayers('Neon', photo({}, null), W, H)
    expect(new Set([...a, ...b].map(l => l.id)).size).toBe(4)
  })
})

describe('activeRelightSetup', () => {
  const withKeep = (keep: number) => photo({ effects: [relight(undefined, { keep })] }, null)
  it('recognises every setup the editor applies (lamps + Original light), ids ignored', () => {
    for (const name of RELIGHT_SETUP_NAMES) {
      const p = withKeep(relightSetup(name).keep)
      expect(activeRelightSetup([p, text(), ...setupToLightLayers(name, p, W, H)], p, W, H)).toBe(name)
    }
  })
  it('is null once a light moves, changes, hides, or another light joins', () => {
    const p = withKeep(relightSetup('Rim').keep)
    const ls = setupToLightLayers('Rim', p, W, H)
    expect(activeRelightSetup([p, { ...ls[0]!, x: ls[0]!.x + 0.05 }, ls[1]!], p, W, H)).toBeNull()
    expect(activeRelightSetup([p, { ...ls[0]!, light: { ...ls[0]!.light, color: '#ffffff' } }, ls[1]!], p, W, H)).toBeNull()
    expect(activeRelightSetup([p, { ...ls[0]!, visible: false }, ls[1]!], p, W, H)).toBeNull()
    expect(activeRelightSetup([p, ...ls, ...setupToLightLayers('Under', p, W, H)], p, W, H)).toBeNull()
  })
  it('is null when Original light moved, or the Frame has no light, or the layer has no Relight', () => {
    const p = withKeep(0.5)
    expect(activeRelightSetup([p, ...setupToLightLayers('Neon', p, W, H)], p, W, H)).toBeNull()
    expect(activeRelightSetup([withKeep(0.12)], withKeep(0.12), W, H)).toBeNull()
    const plain = text()
    expect(activeRelightSetup([plain], plain, W, H)).toBeNull()
  })
  it('follows the photo: the same lamps after the photo moved no longer match', () => {
    const p = withKeep(relightSetup('Window').keep)
    const ls = setupToLightLayers('Window', p, W, H)
    const moved = { ...p, x: p.x + 0.1 } as LocalLayer
    expect(activeRelightSetup([moved, ...ls], moved, W, H)).toBeNull()
  })
})

describe('relightConvertedMessage', () => {
  it('says the lights are Frame lights, and how many were left out', () => {
    expect(relightConvertedMessage(0)).toBe('Relight\'s lights are now Frame lights')
    expect(relightConvertedMessage(2)).toBe('Relight\'s lights are now Frame lights — 2 left out')
  })
})

describe('relightConversionToast', () => {
  it('toasts once per Frame per session (an undone conversion re-converts silently)', () => {
    expect(relightConversionToast('frame-a', 1)).toBe('Relight\'s lights are now Frame lights — 1 left out')
    expect(relightConversionToast('frame-a', 0)).toBeNull()
    expect(relightConversionToast('frame-b', 0)).toBe('Relight\'s lights are now Frame lights')
  })
})
