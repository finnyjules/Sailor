import { describe, it, expect } from 'vitest'
import { FOIL_FRAG, SPOT_UV_FRAG, METALS, METAL_LABELS, foilUniforms, spotUvUniforms, frameUvOf, finishFrameUniforms, finishRegionRect } from '~/lib/compositor/finishPass'

const light = { x: 0.15, y: 0.1, height: 0.6 }

describe('finish shaders', () => {
  it('are GLSL ES 3.00 and read the layer through uColor', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) {
      expect(f.startsWith('#version 300 es')).toBe(true)
      expect(f).toContain('uniform sampler2D uColor')
    }
  })
  it('declare every uniform their builders send', () => {
    for (const k of Object.keys(foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0 }, light, 100, 125, 2))) expect(FOIL_FRAG).toContain(k)
    for (const k of Object.keys(spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: false }, light, 100, 125, 2))) expect(SPOT_UV_FRAG).toContain(k)
  })
  it('never use a descending smoothstep (undefined in GLSL ES 3.00)', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) {
      for (const m of f.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) expect(+m[1]!).toBeLessThan(+m[2]!)
    }
  })
  it('FOIL_FRAG declares uGrain and perturbs both the normal and the ramp input with it', () => {
    expect(FOIL_FRAG).toContain('uniform float uGrain;')
    expect(FOIL_FRAG).toMatch(/uGrain \* 0\.5/)
    expect(FOIL_FRAG).toMatch(/uGrain \* 0\.45/)
  })
})

describe('foilUniforms', () => {
  it('sends the metal ramp as four vec3s, dark to bright', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0 }, light, 100, 125, 2) as any
    expect(u.uM0.vec3).toEqual([0x24 / 255, 0x15 / 255, 0x03 / 255])
    expect(u.uM3.vec3).toEqual([1, 0xf1 / 255, 0xc6 / 255])
  })
  it('sends the light in world space with y up, and the Frame aspect', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0, pressed: 0, grain: 0 }, { x: 0.5, y: 0, height: 0 }, 100, 125, 2) as any
    expect(u.uAspect).toBeCloseTo(1.25)
    expect(u.uLight.vec3[1]).toBeCloseTo(0.625)
    expect(u.uScale).toBe(2)
  })
  it('clamps dials to 0..1', () => {
    const u = foilUniforms({ metal: 'silver', brushed: 5, pressed: -1, grain: 0 }, light, 100, 100, 1) as any
    expect(u.uBrushed).toBe(1); expect(u.uPressed).toBe(0)
  })
  it('sends grain clamped to 0..1', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 2 }, light, 100, 100, 1) as any
    expect(u.uGrain).toBe(1)
    const u2 = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5, grain: -3 }, light, 100, 100, 1) as any
    expect(u2.uGrain).toBe(0)
    const u3 = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 }, light, 100, 100, 1) as any
    expect(u3.uGrain).toBe(0.4)
  })
  it('reads a malformed stored foil with no grain as grain 0', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5 } as any, light, 100, 100, 1) as any
    expect(u.uGrain).toBe(0)
  })
})

describe('spotUvUniforms', () => {
  it('sends varnish-only as a float flag', () => {
    expect((spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: true }, light, 10, 10, 1) as any).uVarnishOnly).toBe(1)
    expect((spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: false }, light, 10, 10, 1) as any).uVarnishOnly).toBe(0)
  })
})

describe('metals', () => {
  it('offers four, labelled in sentence case', () => {
    expect(Object.keys(METALS)).toEqual(['gold', 'silver', 'rose', 'copper'])
    expect(Object.values(METAL_LABELS)).toEqual(['Gold', 'Silver', 'Rose gold', 'Copper'])
  })
})

// A foil region runs its pass over its own device box; the shader maps the box's texture uv back
// to FRAME uv so the light, grain and edge wear land exactly where a whole-frame pass puts them.
describe('frame uv of a region box (frameUvOf mirrors the shader\'s frameUv)', () => {
  // A device pixel (px, py) — canvas convention, y DOWN — sampled at its centre, as the texture
  // uv (y UP, GpuPost flips on upload) of a w×h texture whose top-left sits at (x, y).
  const texUv = (px: number, py: number, x: number, y: number, w: number, h: number): [number, number] =>
    [(px + 0.5 - x) / w, 1 - (py + 0.5 - y) / h]

  it('is the identity when there is no box (the texture is the frame)', () => {
    for (const uv of [[0, 0], [1, 1], [0.25, 0.8], [0.5, 0.5]] as const) {
      expect(frameUvOf(uv, 300, 200)).toEqual([uv[0], uv[1]])
      expect(frameUvOf(uv, 300, 200, { x: 0, y: 0, frameW: 300, frameH: 200 })).toEqual([uv[0], uv[1]])
    }
  })
  it('gives every device pixel of a box the frame uv the whole-frame pass gives it', () => {
    const FW = 400, FH = 300, box = { x: 37, y: 120, w: 90, h: 64 }
    for (const [px, py] of [[37, 120], [126, 183], [80, 150], [100, 121]] as const) {
      const whole = texUv(px, py, 0, 0, FW, FH)
      const local = frameUvOf(texUv(px, py, box.x, box.y, box.w, box.h), box.w, box.h, { x: box.x, y: box.y, frameW: FW, frameH: FH })
      expect(local[0]).toBeCloseTo(whole[0], 10)
      expect(local[1]).toBeCloseTo(whole[1], 10)
    }
  })
  it('measures the origin from the frame\'s BOTTOM (GL y up)', () => {
    expect(finishFrameUniforms(90, 64, { x: 37, y: 120, frameW: 400, frameH: 300 })).toEqual({ origin: [37, 300 - 184], full: [400, 300] })
    expect(finishFrameUniforms(90, 64)).toEqual({ origin: [0, 0], full: [90, 64] })
  })
  it('lights a box with the FRAME\'s aspect and light, not the box\'s', () => {
    const dials = { metal: 'gold' as const, brushed: 0.5, pressed: 0.5, grain: 0 }
    const whole = foilUniforms(dials, light, 400, 300, 2)
    const boxed = foilUniforms(dials, light, 90, 64, 2, { x: 37, y: 120, frameW: 400, frameH: 300 })
    expect(boxed.uAspect).toBe(whole.uAspect)
    expect(boxed.uLight).toEqual(whole.uLight)
    expect(Array.from(boxed.uSize as Float32Array)).toEqual([90, 64])
    expect(Array.from(boxed.uFull as Float32Array)).toEqual([400, 300])
    expect(Array.from(whole.uOrigin as Float32Array)).toEqual([0, 0])
    expect(Array.from(whole.uFull as Float32Array)).toEqual([400, 300])
  })
  it('both shaders place lighting and foil grain through the frame mapping', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) expect(f).toContain('worldPos(frameUv(vUv))')
    expect(FOIL_FRAG).toContain('vec2 px = (vUv * uSize + uOrigin) / uScale;')
  })
})

describe('finishRegionRect', () => {
  const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  it('maps the box through the transform, grows it by the margin and snaps out to whole px', () => {
    expect(finishRegionRect({ x: -10, y: -5, w: 20, h: 10 }, { ...I, e: 100.4, f: 50.6 }, 8, 400, 300))
      .toEqual({ x: 82, y: 37, w: 37, h: 27 })
  })
  it('takes the axis-aligned hull of a turned box', () => {
    const r = Math.SQRT1_2
    const out = finishRegionRect({ x: -10, y: -10, w: 20, h: 20 }, { a: r, b: r, c: -r, d: r, e: 100, f: 100 }, 0, 400, 300)!
    expect(out.x).toBe(Math.floor(100 - 10 * Math.SQRT2))
    expect(out.x + out.w).toBe(Math.ceil(100 + 10 * Math.SQRT2))
  })
  it('clamps to the canvas, and is null wholly off it', () => {
    expect(finishRegionRect({ x: -50, y: -50, w: 100, h: 100 }, I, 8, 400, 300)).toEqual({ x: 0, y: 0, w: 58, h: 58 })
    expect(finishRegionRect({ x: 500, y: 10, w: 20, h: 20 }, I, 8, 400, 300)).toBeNull()
  })
  it('answers the whole canvas when the box or the transform is not finite', () => {
    expect(finishRegionRect({ x: 0, y: 0, w: NaN, h: 10 }, I, 8, 400, 300)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
    expect(finishRegionRect({ x: 0, y: 0, w: 10, h: 10 }, { ...I, a: Infinity }, 8, 400, 300)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })
})
