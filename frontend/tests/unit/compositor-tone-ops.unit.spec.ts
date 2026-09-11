import { describe, it, expect, vi } from 'vitest'
import {
  levelsInPlace, posteriseInPlace, thresholdInPlace, invertInPlace,
  applyPasses, POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
  type LevelsEffect, type PosteriseEffect, type ThresholdEffect, type InvertEffect,
} from '~/lib/compositor/postEffects'

// A grey RGBA pixel with a distinctive alpha, so every op can prove it never writes byte 4.
const px = (r: number, g: number, b: number, a = 137) => [r, g, b, a]

describe('levelsInPlace', () => {
  it('is the identity at black 0 / white 1 / gamma 1 (byte-for-byte, alpha kept)', () => {
    const d = new Uint8ClampedArray([...px(0, 0, 0), ...px(128, 64, 200), ...px(255, 255, 255)])
    const before = [...d]
    levelsInPlace(d, { black: 0, white: 1, gamma: 1 })
    expect([...d]).toEqual(before)
  })
  it('white point stretches the low window up; black point clips the low end to black', () => {
    // white 0.5 → an input of 128 (0.5) maps to full white, and everything below it lifts.
    const up = new Uint8ClampedArray([...px(128, 128, 128), ...px(64, 64, 64), ...px(191, 191, 191)])
    levelsInPlace(up, { black: 0, white: 0.5, gamma: 1 })
    expect(up[0]).toBe(255)              // 0.5 in → white out
    expect(up[4]!).toBeGreaterThan(64)  // inside the window, lifted brighter
    expect(up[8]).toBe(255)             // above the window clips to white
    expect(up[3]).toBe(137)             // alpha untouched
    // black 0.5 → an input of 128 (0.5) maps to black, and everything below it clips.
    const down = new Uint8ClampedArray([...px(128, 128, 128), ...px(64, 64, 64)])
    levelsInPlace(down, { black: 0.5, white: 1, gamma: 1 })
    expect(down[0]!).toBeLessThanOrEqual(2)  // ~0.5 in → ~black out
    expect(down[4]).toBe(0)            // below the black point clips to black
    expect(down[3]).toBe(137)          // alpha untouched
  })
  it('gamma > 1 lightens the midtones, gamma < 1 darkens them', () => {
    const mid = () => new Uint8ClampedArray([...px(128, 128, 128)])
    const up = mid(); levelsInPlace(up, { black: 0, white: 1, gamma: 2 })
    const down = mid(); levelsInPlace(down, { black: 0, white: 1, gamma: 0.5 })
    expect(up[0]!).toBeGreaterThan(128)
    expect(down[0]!).toBeLessThan(128)
    expect(up[3]).toBe(137)              // alpha untouched
  })
})

describe('posteriseInPlace', () => {
  it('yields at most N distinct values per channel', () => {
    const d = new Uint8ClampedArray(256 * 4)
    for (let i = 0; i < 256; i++) { d[i * 4] = i; d[i * 4 + 1] = i; d[i * 4 + 2] = i; d[i * 4 + 3] = 200 }
    posteriseInPlace(d, 4)
    const distinct = new Set<number>()
    for (let i = 0; i < 256; i++) distinct.add(d[i * 4]!)
    expect(distinct.size).toBeLessThanOrEqual(4)
    expect(distinct.size).toBeGreaterThan(1)
    // endpoints preserved
    expect(d[0]).toBe(0)
    expect(d[255 * 4]).toBe(255)
    // alpha untouched
    expect(d[3]).toBe(200)
  })
  it('at 2 levels every channel is 0 or 255', () => {
    const d = new Uint8ClampedArray([...px(10, 130, 250), ...px(120, 128, 200)])
    posteriseInPlace(d, 2)
    for (let i = 0; i < d.length; i++) {
      if (i % 4 === 3) continue
      expect(d[i] === 0 || d[i] === 255).toBe(true)
    }
    expect(d[3]).toBe(137)
  })
})

describe('thresholdInPlace', () => {
  it('drives every RGB byte to 0 or 255 by luminance, alpha kept', () => {
    const d = new Uint8ClampedArray([...px(20, 20, 20), ...px(240, 240, 240)])
    thresholdInPlace(d, 0.5)
    expect([d[0], d[1], d[2]]).toEqual([0, 0, 0])
    expect([d[4], d[5], d[6]]).toEqual([255, 255, 255])
    expect(d[3]).toBe(137)
    expect(d[7]).toBe(137)
  })
  it('cutoff shifts the split point', () => {
    const d = new Uint8ClampedArray([...px(120, 120, 120)])   // lum ~120 → 0.47
    const low = new Uint8ClampedArray(d); thresholdInPlace(low, 0.2)
    const high = new Uint8ClampedArray(d); thresholdInPlace(high, 0.8)
    expect(low[0]).toBe(255)   // above a low cutoff → white
    expect(high[0]).toBe(0)    // below a high cutoff → black
  })
})

describe('invertInPlace', () => {
  it('amount 0 is unchanged, amount 1 is 255 − v, alpha kept', () => {
    const src = [...px(10, 200, 30, 90)]
    const off = new Uint8ClampedArray(src); invertInPlace(off, 0)
    expect([...off]).toEqual(src)
    const full = new Uint8ClampedArray(src); invertInPlace(full, 1)
    expect([full[0], full[1], full[2]]).toEqual([245, 55, 225])
    expect(full[3]).toBe(90)   // alpha untouched
  })
  it('amount 0.5 lands on the 127.5 midpoint for any input', () => {
    const d = new Uint8ClampedArray([...px(0, 0, 0), ...px(100, 100, 100), ...px(254, 254, 254)])
    invertInPlace(d, 0.5)
    // 127.5 rounds to 128 under Uint8ClampedArray rounding, for every starting value.
    for (let i = 0; i < d.length; i++) { if (i % 4 !== 3) expect(d[i]).toBe(128) }
    expect(d[3]).toBe(137)
  })
})

describe('tone-op registration + agent drivability', () => {
  it('each kind has an identity/visible default and a fully numeric clamp table (no whitelist)', () => {
    for (const type of ['levels', 'posterise', 'threshold', 'invert'] as const) {
      const def = POST_EFFECT_DEFAULTS[type] as any
      expect(def.type).toBe(type)
      expect(def.visible).toBe(true)
      const clamps = POST_FX_PARAM_CLAMP[type]!
      // Every non-type/visible param is present in the clamp table → the generic sanitizer
      // drives it. That is the whole "no Task-8 whitelist" claim for this family.
      for (const k of Object.keys(def)) {
        if (k === 'type' || k === 'visible') continue
        expect(clamps[k], `${type}.${k} must be clamp-driven`).toBeDefined()
      }
    }
  })
})

// ── byte-identity: a stack with NONE of the tone kinds, and a tone kind at identity params,
// leave the offscreen untouched (no putImageData). Mirrors compositor-effect-passes' stub. ──
function stubCanvas(w = 8, h = 8) {
  const log: string[] = []
  const data = new Uint8ClampedArray(w * h * 4).fill(128)
  const ctx = {
    canvas: null as unknown as HTMLCanvasElement,
    filter: 'none', globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '' as unknown,
    save: () => {}, restore: () => {}, setTransform: () => {}, clearRect: () => {},
    fillRect: () => {}, drawImage: () => {},
    getImageData: () => ({ data, width: w, height: h }),
    putImageData: () => log.push('putImageData'),
    createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
  }
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement
  ;(ctx as any).canvas = canvas
  return { canvas, log }
}

describe('tone-op byte-identity', () => {
  it('an unrelated stack never runs a tone pass', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [{ type: 'drop_shadow', visible: true } as any], { W: 100, scale: 1 })
    expect(log).toEqual([])
    vi.unstubAllGlobals()
  })
  it('levels at identity and invert at amount 0 write nothing back', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    const levels: LevelsEffect = { type: 'levels', black: 0, white: 1, gamma: 1, visible: true }
    const invert: InvertEffect = { type: 'invert', amount: 0, visible: true }
    applyPasses(canvas, [levels, invert], { W: 100, scale: 1 })
    expect(log.filter(l => l === 'putImageData')).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('posterise, threshold and a non-identity levels each write pixels back once', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    const posterise: PosteriseEffect = { type: 'posterise', levels: 6, visible: true }
    const threshold: ThresholdEffect = { type: 'threshold', cutoff: 0.5, visible: true }
    const levels: LevelsEffect = { type: 'levels', black: 0.1, white: 0.9, gamma: 1, visible: true }
    applyPasses(canvas, [posterise, threshold, levels], { W: 100, scale: 1 })
    expect(log.filter(l => l === 'putImageData')).toHaveLength(3)
    vi.unstubAllGlobals()
  })
})
