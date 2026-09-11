import { describe, it, expect, vi } from 'vitest'
import {
  applyPasses, isChainEffect, defaultPostEffect,
  POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
  MOTION_BLUR_SAMPLES, RADIAL_BLUR_MAX_ANGLE, ZOOM_BLUR_MAX_SCALE,
  motionTapMultipliers, motionSampleSpan,
  directionalBlurTaps, radialBlurTaps, zoomBlurTaps,
  type DirectionalBlurEffect, type RadialBlurEffect, type ZoomBlurEffect,
} from '~/lib/compositor/postEffects'

/** A canvas stub that records the composite op + alpha of every drawImage on THIS context. The
 *  motion-blur passes clone the offscreen (via document.createElement → the SHARED `scratch` log)
 *  then accumulate N taps onto the offscreen we pass in (its own log), at source-over @ 1/N. */
function makeStub(log: string[], w = 8, h = 8) {
  const ctx: any = {
    canvas: null as unknown as HTMLCanvasElement,
    filter: 'none', globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '' as unknown,
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: () => {},
    clearRect: () => log.push('clearRect'),
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillRect: () => log.push(`fillRect:${ctx.globalCompositeOperation}`),
    drawImage: () => log.push(`draw:${ctx.globalCompositeOperation}@${Math.round(ctx.globalAlpha * 100)}`),
    getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => log.push('putImageData'),
    createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
  }
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement
  ctx.canvas = canvas
  return { canvas, ctx }
}

/** Install a document whose createElement hands back fresh scratch canvases that all log into
 *  `scratch`. Returns the offscreen (own log) to pass to applyPasses. */
function harness() {
  const scratch: string[] = []
  vi.stubGlobal('document', { createElement: () => makeStub(scratch).canvas })
  const offLog: string[] = []
  const off = makeStub(offLog)
  return { off, offLog, scratch }
}

const directional = (over: Partial<DirectionalBlurEffect> = {}): DirectionalBlurEffect =>
  ({ type: 'directional_blur', angle: 0, distance: 0.03, visible: true, ...over })
const radial = (over: Partial<RadialBlurEffect> = {}): RadialBlurEffect =>
  ({ type: 'radial_blur', centerX: 0.5, centerY: 0.5, amount: 0.3, visible: true, ...over })
const zoom = (over: Partial<ZoomBlurEffect> = {}): ZoomBlurEffect =>
  ({ type: 'zoom_blur', centerX: 0.5, centerY: 0.5, amount: 0.3, visible: true, ...over })

describe('motion-blur registration (every param numeric → no Task-8 whitelist)', () => {
  it('all three are chain effects with defaults inside their clamps and NO non-numeric param', () => {
    for (const kind of ['directional_blur', 'radial_blur', 'zoom_blur'] as const) {
      expect(isChainEffect({ type: kind })).toBe(true)
      const d = defaultPostEffect(kind) as unknown as Record<string, number>
      const clamps = POST_FX_PARAM_CLAMP[kind]!
      expect(POST_EFFECT_DEFAULTS[kind].type).toBe(kind)
      for (const [k, [lo, hi]] of Object.entries(clamps)) {
        expect(d[k]!).toBeGreaterThanOrEqual(lo)
        expect(d[k]!).toBeLessThanOrEqual(hi)
      }
      // Every dial the effect carries (besides type/visible) is numeric AND in the clamp table,
      // so the generic sanitizer drives the whole family — no colour/enum whitelist owed.
      const dials = Object.keys(POST_EFFECT_DEFAULTS[kind]).filter(k => k !== 'type' && k !== 'visible')
      for (const k of dials) expect(k in clamps, `${kind}.${k} clamped`).toBe(true)
    }
  })
})

describe('motion-blur tap geometry (pure, deterministic)', () => {
  it('motionTapMultipliers are symmetric about 0 (no drift) with the right span', () => {
    const m = motionTapMultipliers(MOTION_BLUR_SAMPLES)
    expect(m).toHaveLength(MOTION_BLUR_SAMPLES)
    // Σ ≈ 0 ⇒ the accumulation blurs in place.
    expect(m.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10)
    // Mirror-symmetric: first = −last.
    expect(m[0]).toBeCloseTo(-m[m.length - 1]!, 10)
    expect(Math.max(...m.map(Math.abs))).toBeCloseTo(motionSampleSpan(MOTION_BLUR_SAMPLES), 10)
    expect(motionSampleSpan(MOTION_BLUR_SAMPLES)).toBeCloseTo((MOTION_BLUR_SAMPLES - 1) / (2 * MOTION_BLUR_SAMPLES), 12)
  })

  it('directionalBlurTaps: 0 distance is the identity, angle picks the axis, taps are centred', () => {
    const zeroed = directionalBlurTaps(45, 0, MOTION_BLUR_SAMPLES)
    expect(zeroed.every(t => t.dx === 0 && t.dy === 0)).toBe(true)
    const along0 = directionalBlurTaps(0, 20, MOTION_BLUR_SAMPLES)
    expect(along0.every(t => Math.abs(t.dy) < 1e-9)).toBe(true)          // 0° ⇒ purely horizontal
    expect(along0.some(t => t.dx > 0) && along0.some(t => t.dx < 0)).toBe(true)
    expect(along0.reduce((a, t) => a + t.dx, 0)).toBeCloseTo(0, 9)       // centred: Σ ≈ 0
    const along90 = directionalBlurTaps(90, 20, MOTION_BLUR_SAMPLES)
    expect(along90.every(t => Math.abs(t.dx) < 1e-9)).toBe(true)         // 90° ⇒ purely vertical
    // The outermost tap reaches distance·span along the axis.
    const reach = Math.max(...along0.map(t => Math.abs(t.dx)))
    expect(reach).toBeCloseTo(20 * motionSampleSpan(MOTION_BLUR_SAMPLES), 9)
  })

  it('radialBlurTaps: 0 amount is the identity, extremes are ±amount·MAX·span, centred', () => {
    expect(radialBlurTaps(0, MOTION_BLUR_SAMPLES).every(a => a === 0)).toBe(true)
    const angs = radialBlurTaps(0.5, MOTION_BLUR_SAMPLES)
    expect(angs.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9)
    const extreme = 0.5 * RADIAL_BLUR_MAX_ANGLE * motionSampleSpan(MOTION_BLUR_SAMPLES)
    expect(Math.max(...angs)).toBeCloseTo(extreme, 9)
    expect(Math.min(...angs)).toBeCloseTo(-extreme, 9)
  })

  it('zoomBlurTaps: 0 amount is the identity (all 1), factors centred about 1', () => {
    expect(zoomBlurTaps(0, MOTION_BLUR_SAMPLES).every(f => f === 1)).toBe(true)
    const fs = zoomBlurTaps(0.4, MOTION_BLUR_SAMPLES)
    expect(fs.reduce((a, b) => a + b, 0) / fs.length).toBeCloseTo(1, 9)  // mean ≈ 1
    const swing = 0.4 * ZOOM_BLUR_MAX_SCALE * motionSampleSpan(MOTION_BLUR_SAMPLES)
    expect(Math.max(...fs)).toBeCloseTo(1 + swing, 9)
    expect(Math.min(...fs)).toBeCloseTo(1 - swing, 9)
  })

  it('is deterministic across two calls', () => {
    expect(directionalBlurTaps(37, 12, MOTION_BLUR_SAMPLES)).toEqual(directionalBlurTaps(37, 12, MOTION_BLUR_SAMPLES))
    expect(radialBlurTaps(0.6, MOTION_BLUR_SAMPLES)).toEqual(radialBlurTaps(0.6, MOTION_BLUR_SAMPLES))
    expect(zoomBlurTaps(0.6, MOTION_BLUR_SAMPLES)).toEqual(zoomBlurTaps(0.6, MOTION_BLUR_SAMPLES))
  })
})

describe('motion-blur passes (accumulation onto the offscreen)', () => {
  const alpha = Math.round((1 / MOTION_BLUR_SAMPLES) * 100)

  it('directional accumulates exactly N taps at 1/N alpha onto the offscreen', () => {
    const { off, offLog } = harness()
    applyPasses(off.canvas, [directional({ distance: 0.03, angle: 20 })], { W: 100, scale: 1 })
    const draws = offLog.filter(l => l.startsWith('draw:'))
    expect(draws).toHaveLength(MOTION_BLUR_SAMPLES)
    expect(draws.every(l => l === `draw:source-over@${alpha}`)).toBe(true)
    expect(offLog).toContain('clearRect') // the offscreen is replaced by the accumulation
    vi.unstubAllGlobals()
  })

  it('radial and zoom each accumulate N taps at 1/N alpha', () => {
    for (const fx of [radial({ amount: 0.3 }), zoom({ amount: 0.3 })]) {
      const { off, offLog } = harness()
      applyPasses(off.canvas, [fx], { W: 100, scale: 1 })
      const draws = offLog.filter(l => l.startsWith('draw:'))
      expect(draws, fx.type).toHaveLength(MOTION_BLUR_SAMPLES)
      expect(draws.every(l => l === `draw:source-over@${alpha}`), fx.type).toBe(true)
      vi.unstubAllGlobals()
    }
  })

  it('is a no-op at distance 0 / amount 0 (nothing composites, offscreen untouched)', () => {
    for (const fx of [directional({ distance: 0 }), radial({ amount: 0 }), zoom({ amount: 0 })]) {
      const { off, offLog } = harness()
      applyPasses(off.canvas, [fx], { W: 100, scale: 1 })
      expect(offLog.filter(l => l.startsWith('draw:')), fx.type).toHaveLength(0)
      expect(offLog.includes('clearRect'), fx.type).toBe(false) // early return: no replace
      vi.unstubAllGlobals()
    }
  })

  it('is deterministic across two runs', () => {
    const run = () => {
      const { off, offLog } = harness()
      applyPasses(off.canvas, [directional(), radial(), zoom()], { W: 100, scale: 1 })
      vi.unstubAllGlobals()
      return offLog
    }
    expect(run()).toEqual(run())
  })
})

describe('byte-identity: no motion blur leaves the offscreen untouched', () => {
  it('an empty list and invisible blurs composite nothing', () => {
    const empty: string[] = []
    vi.stubGlobal('document', { createElement: () => makeStub([]).canvas })
    applyPasses(makeStub(empty).canvas, [], { W: 100, scale: 1 })
    expect(empty.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    const hidden: string[] = []
    applyPasses(makeStub(hidden).canvas, [
      directional({ visible: false }), radial({ visible: false }), zoom({ visible: false }),
    ], { W: 100, scale: 1 })
    expect(hidden.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
