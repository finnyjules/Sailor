/**
 * Tone, colour and light effects (family `effects-tone`, step 3 R2): per-pixel
 * work with no neighbourhood. R2.1 brought the three pilots; R2.4 the other
 * 26 (29 classes).
 *
 * SELF-CONTAINED apart from its arguments (the tensor core and the kernels),
 * as ../../pixels/core.ts is: the compositor worker composes it from its
 * source text. Do not reference anything from outside this body but `k` and
 * `kn`. `kn` is only read inside the ops (the pilots run without it).
 *
 * Each op takes the node's tensors by input name, its widgets as ComfyUI's
 * validation converted them (float(), int(), bool(), str(); colour text
 * already parsed on the main thread, effects/table.ts `prepare`), a Stop
 * check, the effect's batch state, and the picture's index in the batch
 * Python worked on and that batch's size (they decide how torch split a
 * long sum, and where its clamp keeps a −0). It returns its outputs and the
 * tensor its live preview shows. FLOAT32, OP BY OP as torch: every product,
 * sum and difference rounded, a Python double scalar rounded to float32
 * once where it meets a tensor, and a Python expression of scalars (such as
 * `0.15 * temperature`) worked out in double first.
 *
 * Each op is marked (R2 rule 10) EXACT (bit for bit) or LIBRARY (a pow with
 * an exponent torch has no special case for, exp, sin, cos: within the ε
 * the tests measure for its class).
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined

export function toneCore(k: TensorCore, kn?: KernelsCore) {
  const f = Math.fround

  /**
   * AdjustExposure (comfy_extras/nodes_adjust_exposure.py:39-43): clamp when
   * exposure is 0, else (image · f32(2.0 ** exposure)).clamp(0, 1). Exact.
   */
  function AdjustExposure(inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean): EffectResult {
    const x = inp.image!
    const e = p.exposure as number
    const out = k.tensor(x.c, x.h, x.w)
    const m = k.s32(2 ** e)
    const n = x.w * x.h
    for (let c = 0; c < x.c; c++) {
      const s = x.data.subarray(c * n, (c + 1) * n)
      const d = out.data.subarray(c * n, (c + 1) * n)
      k.rows(x.h, stop, (y) => {
        for (let i = y * x.w, end = i + x.w; i < end; i++) d[i] = k.clamp01(e === 0 ? s[i]! : f(s[i]! * m))
      })
    }
    return { outputs: [out], preview: null }
  }

  /**
   * AdjustInvert (nodes_color_filters.py:277-281):
   * (image · (1 − a) + (1 − image) · a).clamp(0, 1), op by op; 1 − a in
   * Python's double, then rounded to float32 as a scalar. Exact.
   */
  function AdjustInvert(inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean): EffectResult {
    const x = inp.image!
    const a = p.amount as number
    const keep = k.s32(1 - a)
    const flip = k.s32(a)
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    for (let c = 0; c < x.c; c++) {
      const s = x.data.subarray(c * n, (c + 1) * n)
      const d = out.data.subarray(c * n, (c + 1) * n)
      k.rows(x.h, stop, (y) => {
        for (let i = y * x.w, end = i + x.w; i < end; i++) {
          const v = s[i]!
          d[i] = k.clamp01(f(f(v * keep) + f(f(1 - v) * flip)))
        }
      })
    }
    return { outputs: [out], preview: null }
  }

  /**
   * AdjustThreshold (nodes_color_filters.py:326-330): luma > threshold (the
   * threshold rounded to float32, as torch compares a tensor with a Python
   * scalar), as 0 or 1 on EVERY channel of the tensor (alpha too). Exact.
   */
  function AdjustThreshold(inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean): EffectResult {
    const x = inp.image!
    const t = k.s32(p.threshold as number)
    const luma = k.luma709(x, stop)
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        const v = luma[i]! > t ? 1 : 0
        for (let c = 0; c < x.c; c++) out.data[c * n + i] = v
      }
    })
    return { outputs: [out], preview: null }
  }


  // ── R2.4: shared steps ──────────────────────────────────────────────────

  /** The kernels (R2.2); the pilots never ask for them. */
  function kern(): KernelsCore {
    if (!kn) throw new Error('The effect kernels are not loaded')
    return kn
  }

  /** Python raises on a 4-channel picture here (torchvision's channel check, or a 3-colour broadcast). */
  function needRgb(x: Tensor): void {
    if (x.c === 4) throw new Error(k.EFFECT_ERRORS.needsRgb)
  }

  /** torch.round (nearbyint): halves to the even neighbour, −0 kept. */
  function rne(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /** torch.remainder of two float32 (Python's % on a tensor): fmod, then + b where the signs differ. */
  function rem(a: number, b: number): number {
    let m = f(a % b)
    if (m !== 0 && (b < 0) !== (m < 0)) m = f(m + b)
    return m
  }

  /** Python's max(a, b) / min(a, b) of two floats: the first unless the second is greater (smaller). */
  const pyMax = (a: number, b: number) => (b > a ? b : a)

  /** A copy of a tensor. */
  function copy(t: Tensor): Tensor {
    return { c: t.c, h: t.h, w: t.w, data: new Float32Array(t.data) }
  }

  /**
   * The node's last `.clamp(0, 1)` over its (B, H, W, C) contiguous result,
   * in place: torch's vector loop turns −0 into +0; its scalar tails
   * (kernels.ts inScalarTail, over the whole batch in memory order) keep it.
   */
  function finish(t: Tensor, stop: Stop, index = 0, count = 1): Tensor {
    const K = kern()
    const n = t.w * t.h
    const C = t.c
    const total = count * n * C
    const base = index * n * C
    const d = t.data
    k.rows(t.h, stop, (y) => {
      for (let i = y * t.w, end = i + t.w; i < end; i++) {
        for (let c = 0; c < C; c++) {
          const v = d[c * n + i]!
          d[c * n + i] = Object.is(v, -0) && K.inScalarTail(base + i * C + c, total, K.TORCH_THREADS) ? -0 : K.clamp01(v)
        }
      }
    })
    return t
  }

  /** A per-pixel map over rows (Stop every 64): `each(i)` for every pixel index. */
  function pixels(t: { h: number; w: number }, stop: Stop, each: (i: number, x: number, y: number) => void): void {
    k.rows(t.h, stop, (y) => {
      for (let x = 0, i = y * t.w; x < t.w; x++, i++) each(i, x, y)
    })
  }

  /** One plane of a tensor (a view). */
  const plane = (t: Tensor, c: number) => t.data.subarray(c * t.w * t.h, (c + 1) * t.w * t.h)

  /** A 1-channel tensor from a plane. */
  const one = (h: number, w: number, data: Float32Array): Tensor => ({ c: 1, h, w, data })

  /** clamp(0, 1) of a luma (an intermediate: its values never hold −0). */
  function clampedLuma(x: Tensor, stop: Stop): Float32Array {
    const l = k.luma709(x, stop)
    for (let i = 0; i < l.length; i++) l[i] = kern().clamp01(l[i]!)
    return l
  }

  /** `torch.meshgrid(linspace(a, b, h), linspace(a, b, w), indexing="ij")`, as two 1-D rows. */
  function grid(h: number, w: number, a: number, b: number): { ys: Float32Array; xs: Float32Array } {
    return { ys: kern().linspace(a, b, h), xs: kern().linspace(a, b, w) }
  }

  /** How the picture sat in the tensor torchvision worked on: the node permuted (B, H, W, C) to (B, C, H, W). */
  const permuted = (index = 0, count = 1) => ({ cl: true, batch: count, index })

  // ── R2.4: nodes_adjust_*.py ─────────────────────────────────────────────

  /**
   * AdjustBrightnessContrast (nodes_adjust_brightness_contrast.py:45-51):
   * torchvision adjust_brightness, then adjust_contrast (the greyscale's
   * mean over the picture: its batch decides how torch split the sum), each
   * only when its factor isn't 1; a 4-channel picture raises there. The
   * mean is ported exact at this Mac's thread count; marked library (R2.4).
   */
  function AdjustBrightnessContrast(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    let x = inp.image!
    const b = p.brightness as number
    const c = p.contrast as number
    if (b !== 1) x = K.adjustBrightness(x, b, permuted(index, count))
    if (stop?.()) throw new Error('Stopped')
    if (c !== 1) x = K.adjustContrast(x, c, permuted(index, count))
    return { outputs: [finish(x === inp.image ? copy(x) : x, stop, index, count)], preview: null }
  }

  /**
   * AdjustColor (nodes_adjust_color.py:52-62): adjust_hue (hue / 360),
   * adjust_saturation, then adjust_brightness (lightness), each only when
   * it changes something; a 4-channel picture raises there. Exact.
   */
  function AdjustColor(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    let x = inp.image!
    const hue = p.hue as number
    const sat = p.saturation as number
    const light = p.lightness as number
    if (hue !== 0) x = K.adjustHue(x, hue / 360)
    if (stop?.()) throw new Error('Stopped')
    if (sat !== 1) x = K.adjustSaturation(x, sat, permuted(index, count))
    if (stop?.()) throw new Error('Stopped')
    if (light !== 1) x = K.adjustBrightness(x, light, permuted(index, count))
    return { outputs: [finish(x === inp.image ? copy(x) : x, stop, index, count)], preview: null }
  }

  /**
   * AdjustCurves (nodes_adjust_curves.py:52-61): + blacks, clamp,
   * pow(1 / midtones), · whites, clamp; each step only when it changes
   * something. Library (the pow; exact at midtones 0.5 and 2).
   */
  function AdjustCurves(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const blacks = p.blacks as number
    const mid = p.midtones as number
    const whites = p.whites as number
    let t = copy(x)
    const d = t.data
    const bk = k.s32(blacks)
    for (let i = 0; i < d.length; i++) d[i] = K.clamp01(blacks !== 0 ? f(d[i]! + bk) : d[i]!)
    if (stop?.()) throw new Error('Stopped')
    if (mid !== 1) t = K.powScalar(t, 1 / mid)
    if (whites !== 1) {
      const wf = k.s32(whites)
      const e = t.data
      for (let i = 0; i < e.length; i++) e[i] = f(e[i]! * wf)
    }
    return { outputs: [finish(t, stop, index, count)], preview: null }
  }

  /**
   * AdjustLevels (nodes_adjust_levels.py:53-58): in_white = max(white,
   * black + 1e-6) in double; ((x − black) / (in_white − black)).clamp;
   * pow(1 / gamma) when gamma isn't 1; clamp. Library (the pow).
   */
  function AdjustLevels(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const black = p.black as number
    const gamma = p.gamma as number
    const inWhite = pyMax(p.white as number, black + 1e-6)
    const bk = k.s32(black)
    const span = k.s32(inWhite - black)
    let t = copy(inp.image!)
    const d = t.data
    for (let i = 0; i < d.length; i++) d[i] = K.clamp01(f(f(d[i]! - bk) / span))
    if (stop?.()) throw new Error('Stopped')
    if (gamma !== 1) t = K.powScalar(t, 1 / gamma)
    return { outputs: [finish(t, stop, index, count)], preview: null }
  }

  // ── R2.4: nodes_color_filters.py ────────────────────────────────────────

  /**
   * AdjustTemperature (:37-42): channel 0 + 0.15·t; channel 1 − 0.075·t
   * + 0.1·tint; channel 2 − 0.15·t − 0.1·tint (each product in double);
   * the rest (alpha) kept; clamp. Exact.
   */
  function AdjustTemperature(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const t = p.temperature as number
    const tint = p.tint as number
    const out = copy(x)
    const r = plane(out, 0)
    const g = plane(out, 1)
    const b = plane(out, 2)
    const a0 = k.s32(0.15 * t)
    const a1 = k.s32(0.075 * t)
    const a2 = k.s32(0.1 * tint)
    pixels(x, stop, (i) => {
      r[i] = f(r[i]! + a0)
      g[i] = f(f(g[i]! - a1) + a2)
      b[i] = f(f(b[i]! - a0) - a2)
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * AdjustVibrance (:64-75): amount 0 is a clamp. Otherwise the saturation
   * is max − min over EVERY channel (alpha too), the weight (1 − sat)² when
   * boosting (pow(2.0) is x·x) or 1, factor 1 + amount·weight, and each
   * channel luma + (x − luma)·factor (alpha too), clamp. Exact.
   */
  function AdjustVibrance(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amount = p.amount as number
    if (amount === 0) return { outputs: [finish(copy(x), stop, index, count)], preview: null }
    const n = x.w * x.h
    const C = x.c
    const d = x.data
    const out = k.tensor(C, x.h, x.w)
    const o = out.data
    const luma = k.luma709(x, stop)
    const am = k.s32(amount)
    pixels(x, stop, (i) => {
      let hi = d[i]!
      let lo = d[i]!
      for (let c = 1; c < C; c++) {
        const v = d[c * n + i]!
        if (v > hi) hi = v
        if (v < lo) lo = v
      }
      const sat = f(hi - lo)
      const w1 = f(1 - sat)
      const weight = amount > 0 ? f(w1 * w1) : 1
      const factor = f(1 + f(weight * am))
      const gray = luma[i]!
      for (let c = 0; c < C; c++) o[c * n + i] = f(gray + f(f(d[c * n + i]! - gray) * factor))
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * AdjustColorBalance (:106-121): weights from the clamped luma (shadow
   * (1 − l)², highlight l², midtones 1 − both, clamped); each of channels
   * 0–2 + 0.3·(shadow·s + mid·m + high·h) of its own three settings; the
   * rest kept; clamp. Exact.
   */
  function AdjustColorBalance(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const out = copy(x)
    const l = clampedLuma(x, stop)
    const amount = k.s32(0.3)
    const set = (name: string) => k.s32(p[name] as number)
    const tones = [
      [set('shadows_cr'), set('midtones_cr'), set('highlights_cr')],
      [set('shadows_mg'), set('midtones_mg'), set('highlights_mg')],
      [set('shadows_yb'), set('midtones_yb'), set('highlights_yb')],
    ] as const
    const planes = [plane(out, 0), plane(out, 1), plane(out, 2)]
    pixels(x, stop, (i) => {
      const li = l[i]!
      const w1 = f(1 - li)
      const ws = f(w1 * w1)
      const wh = f(li * li)
      const wm = K.clamp01(f(f(1 - ws) - wh))
      for (let c = 0; c < 3; c++) {
        const [s, m, h] = tones[c]!
        const delta = f(f(f(f(ws * s) + f(wm * m)) + f(wh * h)) * amount)
        planes[c]![i] = f(planes[c]![i]! + delta)
      }
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * AdjustBlackWhite (:147-151): weights w / max(1e-6, r + g + b) in
   * double, each rounded to float32; grey = wr·x0 + wg·x1 + wb·x2 on every
   * channel (alpha too), clamp. Exact.
   */
  function AdjustBlackWhite(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const red = p.red as number
    const green = p.green as number
    const blue = p.blue as number
    const total = pyMax(1e-6, red + green + blue)
    const wr = k.s32(red / total)
    const wg = k.s32(green / total)
    const wb = k.s32(blue / total)
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    const [r, g, b] = [plane(x, 0), plane(x, 1), plane(x, 2)]
    pixels(x, stop, (i) => {
      const gray = f(f(f(wr * r[i]!) + f(wg * g[i]!)) + f(wb * b[i]!))
      for (let c = 0; c < x.c; c++) out.data[c * n + i] = gray
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /** AdjustPhotoFilter's PRESETS (:170-177). */
  const PHOTO_FILTERS: Readonly<Record<string, readonly [number, number, number]>> = {
    warm: [1.00, 0.78, 0.40],
    cool: [0.40, 0.65, 1.00],
    sepia: [1.00, 0.85, 0.65],
    magenta: [1.00, 0.45, 0.85],
    green: [0.55, 1.00, 0.55],
    blue: [0.30, 0.45, 1.00],
  }

  /**
   * AdjustPhotoFilter (:179-187): x·(1 − density) + (x·tint)·density, the
   * tint a float32 (1, 1, 1, 3) tensor (a 4-channel picture raises: it
   * doesn't broadcast); clamp. Exact.
   */
  function AdjustPhotoFilter(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    needRgb(x)
    const density = p.density as number
    const tint = (PHOTO_FILTERS[p.color as string] ?? [1, 1, 1]).map(f)
    const keep = k.s32(1 - density)
    const dens = k.s32(density)
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      const t = tint[c]!
      pixels(x, stop, (i) => { o[i] = f(f(s[i]! * keep) + f(f(s[i]! * t) * dens)) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * gradient_lut (_gradient_map.py:84-101): 256 float32 colours along
   * linspace(0, 1), each linear between its stops (torch.bucketize right,
   * clamped to 1…k − 1; the span clamped to at least 1e-6), held flat
   * outside the first and last stops. A single stop is a flat ramp.
   */
  function gradientLut(stops: readonly (readonly [number, readonly number[]])[]): Float32Array[] {
    const list = stops.length === 1 ? [[0, stops[0]![1]], [1, stops[0]![1]]] as const : stops
    const K = kern()
    const xs = K.linspace(0, 1, 256)
    const pos = list.map(s => f(s[0]))
    const cols = list.map(s => s[1].map(f))
    const last = pos.length - 1
    const minSpan = k.s32(1e-6)
    const lut = [new Float32Array(256), new Float32Array(256), new Float32Array(256)]
    for (let i = 0; i < 256; i++) {
      const x = xs[i]!
      let upper = 0
      for (const q of pos) if (q <= x) upper++
      upper = Math.min(Math.max(upper, 1), last)
      const lo = upper - 1
      const p0 = pos[lo]!
      const span = f(pos[upper]! - p0)
      const t = K.clamp01(f(f(x - p0) / (span < minSpan ? minSpan : span)))
      const u = f(1 - t)
      for (let c = 0; c < 3; c++) {
        let v = f(f(cols[lo]![c]! * u) + f(cols[upper]![c]! * t))
        if (x <= pos[0]!) v = cols[0]![c]!
        if (x >= pos[last]!) v = cols[last]![c]!
        lut[c]![i] = v
      }
    }
    return lut
  }

  /**
   * AdjustGradientMap (:213-216, _gradient_map.py:104-110
   * apply_gradient_map): the stops' LUT (`p.stops`, parsed on the main
   * thread by shared/runner/gradientStops.ts parseStops), indexed by
   * round(255·clamped luma); x·(1 − mix) + colour·mix (a 4-channel picture
   * raises: it doesn't broadcast); clamp. Exact.
   */
  function AdjustGradientMap(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const lut = gradientLut(p.stops as [number, number[]][])
    const l = clampedLuma(x, stop)
    needRgb(x)
    const mix = p.mix as number
    const keep = k.s32(1 - mix)
    const m = k.s32(mix)
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      const col = lut[c]!
      pixels(x, stop, (i) => {
        const at = Math.min(Math.max(rne(f(l[i]! * 255)), 0), 255)
        o[i] = f(f(s[i]! * keep) + f(col[at]! * m))
      })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * AdjustChannelMixer (:250-255): each of three channels out as
   * a·r + b·g + c·b of channels 0–2 (alpha dropped), clamp. Exact.
   */
  function AdjustChannelMixer(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const w = (name: string) => k.s32(p[name] as number)
    const rows = [
      [w('r_from_r'), w('r_from_g'), w('r_from_b')],
      [w('g_from_r'), w('g_from_g'), w('g_from_b')],
      [w('b_from_r'), w('b_from_g'), w('b_from_b')],
    ] as const
    const [r, g, b] = [plane(x, 0), plane(x, 1), plane(x, 2)]
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const [a0, a1, a2] = rows[c]!
      const o = plane(out, c)
      pixels(x, stop, (i) => { o[i] = f(f(f(r[i]! * a0) + f(g[i]! * a1)) + f(b[i]! * a2)) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /** AdjustPosterize (:302-304): floor(x·(n − 1) + 0.5) / (n − 1) on every channel, n = max(2, levels); clamp. Exact. */
  function AdjustPosterize(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const n1 = Math.max(2, Math.trunc(p.levels as number)) - 1
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i) => { o[i] = f(Math.floor(f(f(s[i]! * n1) + 0.5)) / n1) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  // ── R2.4: nodes_tone_extras.py ──────────────────────────────────────────

  /**
   * _radial_falloff (:14-25): r = sqrt(x² + y²) over linspace(−1, 1) grids,
   * clamped to 1.4142; t = ((r − edge) / max(1e-6, 1.4142 − edge)).clamp
   * with edge = 1 − feather; smoothstep t·t·(3 − 2t).
   */
  function radialFalloff(h: number, w: number, feather: number, stop: Stop): Float32Array {
    const { ys, xs } = grid(h, w, -1, 1)
    const edge = 1 - feather
    const e = k.s32(edge)
    const span = k.s32(pyMax(1e-6, 1.4142 - edge))
    const top = k.s32(1.4142)
    const K = kern()
    const out = new Float32Array(h * w)
    pixels({ h, w }, stop, (i, x, y) => {
      const xx = xs[x]!
      const yy = ys[y]!
      let r = f(Math.sqrt(f(f(xx * xx) + f(yy * yy))))
      r = r < 0 ? 0 : r > top ? top : r
      const t = K.clamp01(f(f(r - e) / span))
      out[i] = f(f(t * t) * f(3 - f(t * 2)))
    })
    return out
  }

  /**
   * AdjustVignette (:47-58): amount 0 is a clamp. Darkening (amount < 0):
   * x·(1 + amount·mask); lightening: x + (1 − x)·(amount·mask); on every
   * channel; clamp. Exact.
   */
  function AdjustVignette(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amount = p.amount as number
    if (amount === 0) return { outputs: [finish(copy(x), stop, index, count)], preview: null }
    const mask = radialFalloff(x.h, x.w, p.feather as number, stop)
    const a = k.s32(amount)
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      if (amount < 0) pixels(x, stop, (i) => { o[i] = f(s[i]! * f(1 + f(mask[i]! * a))) })
      else pixels(x, stop, (i) => { o[i] = f(s[i]! + f(f(1 - s[i]!) * f(mask[i]! * a))) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * AdjustShadowsHighlights (:130-142): both 0 is a clamp. Otherwise
   * x + (shadows·0.5)·(1 − l)² − (highlights·0.5)·l² with the clamped luma,
   * on every channel; clamp. Exact.
   */
  function AdjustShadowsHighlights(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const sh = p.shadows as number
    const hi = p.highlights as number
    if (sh === 0 && hi === 0) return { outputs: [finish(copy(x), stop, index, count)], preview: null }
    const l = clampedLuma(x, stop)
    const a = k.s32(sh * 0.5)
    const b = k.s32(hi * 0.5)
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i) => {
        const li = l[i]!
        const w1 = f(1 - li)
        o[i] = f(f(s[i]! + f(f(w1 * w1) * a)) - f(f(li * li) * b))
      })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  // ── R2.4: nodes_glsl_grading.py ─────────────────────────────────────────

  /**
   * Duotone (:39-41, _gradient_map.py:113-117 apply_duotone): shadow ·
   * (1 − l) + highlight · l with the clamped luma (the two colours parsed on
   * the main thread, gradientStops.ts parseDuotone / hexToRgb); three
   * channels out (alpha dropped); clamp. Exact.
   */
  function Duotone(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const [c0, c1] = (p.colours as [number[], number[]]).map(c => c.map(f))
    const l = clampedLuma(x, stop)
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const o = plane(out, c)
      const a = c0![c]!
      const b = c1![c]!
      pixels(x, stop, (i) => { o[i] = f(f(a * f(1 - l[i]!)) + f(b * l[i]!)) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * SplitToning (:73-80): m = l^e with the clamped luma, e = max(0.1,
   * 1 ∓ 0.8·balance); tinted = x·(1 − m)·shadow·2 + x·m·highlight·2 (the
   * tints (1, 1, 1, 3) tensors: a 4-channel picture raises); x·(1 −
   * intensity) + tinted·intensity; clamp. Library (the pow; exact at
   * balance 0).
   */
  function SplitToning(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const l = clampedLuma(x, stop)
    const balance = p.balance as number
    const e = balance >= 0 ? pyMax(0.1, 1 - balance * 0.8) : pyMax(0.1, 1 + balance * 0.8)
    const m = kern().powScalar(one(x.h, x.w, l), e).data
    needRgb(x)
    const sh = [p.shadow_r, p.shadow_g, p.shadow_b].map(v => k.s32(v as number))
    const hi = [p.highlight_r, p.highlight_g, p.highlight_b].map(v => k.s32(v as number))
    const intensity = p.intensity as number
    const keep = k.s32(1 - intensity)
    const it = k.s32(intensity)
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      const st = sh[c]!
      const ht = hi[c]!
      pixels(x, stop, (i) => {
        const v = s[i]!
        const mi = m[i]!
        const tinted = f(f(f(f(v * f(1 - mi)) * st) * 2) + f(f(f(v * mi) * ht) * 2))
        o[i] = f(f(v * keep) + f(tinted * it))
      })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  // ── R2.4: nodes_glsl_unicorn.py ─────────────────────────────────────────

  /**
   * GradientMap (:94-108): t = ((luma − midpoint)·contrast + 0.5).clamp;
   * dark·(1 − t) + light·t (the colours parsed on the main thread,
   * gradientStops.ts hexToRgb; a 4-channel picture raises: it doesn't
   * broadcast); x·(1 − mix) + mapped·mix; clamp. Exact.
   */
  function GradientMap(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const dark = (p.dark as number[]).map(f)
    const light = (p.light as number[]).map(f)
    const l = k.luma709(x, stop)
    needRgb(x)
    const mid = k.s32(p.midpoint as number)
    const con = k.s32(p.contrast as number)
    const mix = p.mix as number
    const keep = k.s32(1 - mix)
    const mx = k.s32(mix)
    const t = new Float32Array(l.length)
    for (let i = 0; i < l.length; i++) t[i] = K.clamp01(f(f(f(l[i]! - mid) * con) + 0.5))
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i) => {
        const mapped = f(f(dark[c]! * f(1 - t[i]!)) + f(light[c]! * t[i]!))
        o[i] = f(f(s[i]! * keep) + f(mapped * mx))
      })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * Posterize (:142-155), n = max(2, levels). Per channel: clamp,
   * pow(gamma), round(x·(n − 1)) / (n − 1), pow(1 / gamma). On the luma:
   * the clamped luma to the gamma, quantised, back, and every channel
   * scaled by q / max(l, 1e-6), clamp. Clamp. Library (the pows; exact at
   * gamma 1 and 2).
   */
  function Posterize(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const n1 = Math.max(2, Math.trunc(p.levels as number)) - 1
    const gamma = p.gamma as number
    const quantise = (t: Tensor) => {
      const d = t.data
      for (let i = 0; i < d.length; i++) d[i] = f(rne(f(d[i]! * n1)) / n1)
      return t
    }
    if (p.per_channel) {
      const c = copy(x)
      for (let i = 0; i < c.data.length; i++) c.data[i] = K.clamp01(c.data[i]!)
      const q = quantise(K.powScalar(c, gamma))
      if (stop?.()) throw new Error('Stopped')
      return { outputs: [finish(K.powScalar(q, 1 / gamma), stop, index, count)], preview: null }
    }
    const lu = K.powScalar(one(x.h, x.w, clampedLuma(x, stop)), gamma).data
    const q = K.powScalar(quantise(one(x.h, x.w, new Float32Array(lu))), 1 / gamma).data
    const floor = k.s32(1e-6)
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i) => {
        const scale = f(q[i]! / (lu[i]! < floor ? floor : lu[i]!))
        o[i] = K.clamp01(f(s[i]! * scale))
      })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * Hologram (:341-368): the angle as a float32 tensor (angle·π / 180),
   * its cos and sin; phase = (x·cos + y·sin)·frequency + luma·weight·4 over
   * linspace(−1, 1) grids; a rainbow of 0.5 + 0.5·cos(2π·phase + k·2π/3),
   * pulled to its mean by `saturation`, times luma and brightness (a
   * 4-channel picture raises: it doesn't broadcast); x·(1 − mix) +
   * rainbow·mix; clamp. Library (cos, sin).
   */
  function Hologram(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const { ys, xs } = grid(x.h, x.w, -1, 1)
    const a = k.s32((p.angle as number) * Math.PI / 180)
    const ca = f(Math.cos(a))
    const sa = f(Math.sin(a))
    const l = k.luma709(x, stop)
    const freq = k.s32(p.frequency as number)
    const lw = k.s32(p.luma_weight as number)
    const tau = k.s32(2 * Math.PI)
    const third = k.s32(2 * Math.PI / 3)
    const twoThirds = k.s32(4 * Math.PI / 3)
    const sat = k.s32(p.saturation as number)
    const bright = k.s32(p.brightness as number)
    const mix = p.mix as number
    const keep = k.s32(1 - mix)
    const mx = k.s32(mix)
    const rainbow = [new Float32Array(l.length), new Float32Array(l.length), new Float32Array(l.length)]
    pixels(x, stop, (i, px, py) => {
      const proj = f(f(xs[px]! * ca) + f(ys[py]! * sa))
      const phase = f(f(proj * freq) + f(f(l[i]! * lw) * 4))
      const arg = f(tau * phase)
      const r = f(0.5 + f(0.5 * f(Math.cos(arg))))
      const g = f(0.5 + f(0.5 * f(Math.cos(f(arg + third)))))
      const b = f(0.5 + f(0.5 * f(Math.cos(f(arg + twoThirds)))))
      const gray = f(f(f(r + g) + b) / 3)
      const rb = [r, g, b]
      for (let c = 0; c < 3; c++) rainbow[c]![i] = f(f(f(gray + f(f(rb[c]! - gray) * sat)) * l[i]!) * bright)
    })
    needRgb(x)
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      const rb = rainbow[c]!
      pixels(x, stop, (i) => { o[i] = f(f(s[i]! * keep) + f(rb[i]! * mx)) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * TwoDLight (:563-588): the light's distance d over arange / (side − 1)
   * grids, (1 − (d / radius).clamp)^falloff · intensity clamped to 4, times
   * the colour (parsed on the main thread, gradientStops.ts hexToRgb); then
   * screen, add, multiply or overlay (a 4-channel picture raises: it
   * doesn't broadcast); clamp. Library (the pow; exact at falloff 1, 2, 3
   * and 0.5).
   */
  function TwoDLight(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const { h, w } = x
    const hs = Math.max(1, h - 1)
    const wsp = Math.max(1, w - 1)
    const ly = k.s32(p.y as number)
    const lx = k.s32(p.x as number)
    const yy = new Float32Array(h)
    const xx = new Float32Array(w)
    for (let i = 0; i < h; i++) yy[i] = f(f(i / hs) - ly)
    for (let i = 0; i < w; i++) xx[i] = f(f(i / wsp) - lx)
    const radius = k.s32(p.radius as number)
    const base = new Float32Array(h * w)
    pixels(x, stop, (i, px, py) => {
      const d = f(Math.sqrt(f(f(yy[py]! * yy[py]!) + f(xx[px]! * xx[px]!))))
      base[i] = f(1 - K.clamp01(f(d / radius)))
    })
    const fm = K.powScalar(one(h, w, base), p.falloff as number).data
    const intensity = k.s32(p.intensity as number)
    for (let i = 0; i < fm.length; i++) {
      const v = f(fm[i]! * intensity)
      fm[i] = v < 0 ? 0 : v > 4 ? 4 : v
    }
    needRgb(x)
    const colour = (p.colour as number[]).map(v => k.s32(v))
    const blend = p.blend as string
    const out = k.tensor(3, h, w)
    for (let c = 0; c < 3; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      const col = colour[c]!
      pixels(x, stop, (i) => {
        const v = s[i]!
        const L = f(fm[i]! * col)
        if (blend === 'screen') o[i] = f(1 - f(f(1 - v) * f(1 - L)))
        else if (blend === 'add') o[i] = f(v + L)
        else if (blend === 'multiply') o[i] = f(v * f(1 + L))
        else o[i] = v < 0.5 ? f(f(2 * v) * L) : f(1 - f(f(2 * f(1 - v)) * f(1 - L)))
      })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  // ── R2.4: nodes_glsl_atmosphere.py ──────────────────────────────────────

  /** Python's math.radians: x · (π / 180). */
  const radians = (deg: number) => deg * (Math.PI / 180)

  /**
   * The screen blend of a light over the picture: 1 − (1 − x)·(1 − light),
   * light a float32 (1, H, W, 3) tensor (a 4-channel picture raises: it
   * doesn't broadcast); clamp.
   */
  function screen(x: Tensor, light: (c: number, i: number) => number, stop: Stop, index: number, count: number): EffectResult {
    needRgb(x)
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i) => { o[i] = f(1 - f(f(1 - s[i]!) * f(1 - light(c, i)))) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * LightLeak (:103-119): a band exp(−(t01 − position)² / (2·softness²))
   * across the angle over linspace(−1, 1) grids (cos and sin of
   * radians(angle) in double), times intensity; screened in the colour.
   * Library (exp).
   */
  function LightLeak(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    needRgb(x)
    const { ys, xs } = grid(x.h, x.w, -1, 1)
    const rad = radians(p.angle as number)
    const ca = k.s32(Math.cos(rad))
    const sa = k.s32(Math.sin(rad))
    const pos = k.s32(p.position as number)
    const soft = p.softness as number
    const den = k.s32(2 * soft * soft)
    const it = k.s32(p.intensity as number)
    const leak = new Float32Array(x.w * x.h)
    pixels(x, stop, (i, px, py) => {
      const t = f(f(xs[px]! * ca) + f(ys[py]! * sa))
      const d = f(f(f(t + 1) * 0.5) - pos)
      leak[i] = f(f(Math.exp(f(-f(d * d) / den))) * it)
    })
    const colour = [p.color_r, p.color_g, p.color_b].map(v => k.s32(v as number))
    return screen(x, (c, i) => f(colour[c]! * leak[i]!), stop, index, count)
  }

  /**
   * LensFlare (:199-239): intensity ≤ 0 is a clamp. Otherwise over
   * linspace(0, 1) grids, aspect-corrected: a halo exp(−(d / size)²), the
   * anamorphic streak (when streak > 0) and each ghost along the axis
   * through the centre (its place, size and strength in Python doubles),
   * summed in order; times colour and intensity, clamped; screened. Library
   * (exp).
   */
  function LensFlare(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const intensity = p.intensity as number
    if (intensity <= 0) return { outputs: [finish(copy(x), stop, index, count)], preview: null }
    const K = kern()
    const { h, w } = x
    const { ys, xs } = grid(h, w, 0, 1)
    const aspect = k.s32(w / Math.max(1, h))
    const lx = p.light_x as number
    const ly = p.light_y as number
    const halo = p.halo_size as number
    const streak = p.streak as number
    const ghosts = p.ghosts as number
    const lxf = k.s32(lx)
    const lyf = k.s32(ly)
    const haloDiv = k.s32(pyMax(1e-4, halo))
    const streakDiv = k.s32(0.001 / pyMax(streak, 1e-4))
    const streakF = k.s32(streak)
    const ghost = Array.from({ length: Math.max(0, ghosts) }, (_, g) => {
      const t = (g + 1) / (ghosts + 1) * 2.0
      const radius = halo * (0.6 + 0.5 * ((g * 7) % 5) / 4.0)
      return { gx: k.s32(lx + (0.5 - lx) * t), gy: k.s32(ly + (0.5 - ly) * t), div: k.s32(pyMax(1e-4, radius)), strength: k.s32(0.5 / (g + 1.5)) }
    })
    const accum = new Float32Array(h * w)
    pixels(x, stop, (i, px, py) => {
      const xv = xs[px]!
      const yv = ys[py]!
      const dx = f(xv - lxf)
      const dy = f(yv - lyf)
      const adx = f(dx * aspect)
      const d = f(Math.sqrt(f(f(adx * adx) + f(dy * dy))))
      const q = f(d / haloDiv)
      let a = f(Math.exp(-f(q * q)))
      const anam = streak > 0 ? f(f(Math.exp(f(-f(dy * dy) / streakDiv))) * f(Math.exp(f(-f(dx * dx) * 4)))) : 0
      a = f(a + f(anam * streakF))
      for (const gh of ghost) {
        const gdx = f(f(xv - gh.gx) * aspect)
        const gdy = f(yv - gh.gy)
        const gq = f(f(Math.sqrt(f(f(gdx * gdx) + f(gdy * gdy)))) / gh.div)
        a = f(a + f(f(Math.exp(-f(gq * gq))) * gh.strength))
      }
      accum[i] = a
    })
    const colour = [p.color_r, p.color_g, p.color_b].map(v => k.s32(v as number))
    const it = k.s32(intensity)
    return screen(x, (c, i) => K.clamp01(f(f(accum[i]! * colour[c]!) * it)), stop, index, count)
  }

  // ── R2.4: nodes_glsl_lab.py ─────────────────────────────────────────────

  /**
   * Caustics (:249-272): five sine layers sin(kx·x + ky·y + φ·(i + 1)) over
   * linspace(0, 1) grids (φ, kx, ky in Python doubles), summed in order;
   * |0.2·c|^2.5 clamped, times colour and intensity, clamped; screened.
   * Library (sin, pow).
   */
  function Caustics(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const { ys, xs } = grid(x.h, x.w, 0, 1)
    const scale = p.scale as number
    const phi = ((p.seed as number) % 1000) * 0.073
    const layers = Array.from({ length: 5 }, (_, i) => {
      const freq = scale * (1.0 + i * 0.6)
      const ang = phi + i * 0.81
      return { kx: k.s32(Math.cos(ang) * freq), ky: k.s32(Math.sin(ang) * freq), ph: k.s32(phi * (i + 1)) }
    })
    const c = new Float32Array(x.w * x.h)
    pixels(x, stop, (i, px, py) => {
      let v = 0
      for (const L of layers) v = f(v + f(Math.sin(f(f(f(xs[px]! * L.kx) + f(ys[py]! * L.ky)) + L.ph))))
      c[i] = Math.abs(f(v * 0.2))
    })
    const caustic = K.powScalar(one(x.h, x.w, c), 2.5).data
    for (let i = 0; i < caustic.length; i++) caustic[i] = K.clamp01(caustic[i]!)
    const colour = [p.color_r, p.color_g, p.color_b].map(v => k.s32(v as number))
    const it = k.s32(p.intensity as number)
    return screen(x, (ch, i) => K.clamp01(f(f(caustic[i]! * colour[ch]!) * it)), stop, index, count)
  }

  /**
   * Blinds (:307-324): perp = y·cos + x·sin over linspace(0, 1) grids
   * (radians(angle) in double); fp = (perp·count) % 1; the open part
   * ((openness + s − fp) / s).clamp · (fp ≥ 0), smoothstepped, s =
   * max(softness, 1e-3); x·(m + (1 − m)·(1 − shadow)) on every channel;
   * clamp. Exact.
   */
  function Blinds(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const { ys, xs } = grid(x.h, x.w, 0, 1)
    const rad = radians(p.angle as number)
    const cr = k.s32(Math.cos(rad))
    const sr = k.s32(Math.sin(rad))
    const n = k.s32(p.count as number)
    const s = pyMax(p.softness as number, 1e-3)
    const open = k.s32((p.openness as number) + s)
    const sf = k.s32(s)
    const dark = k.s32(1 - (p.shadow as number))
    const light = new Float32Array(x.w * x.h)
    pixels(x, stop, (i, px, py) => {
      const fp = rem(f(f(f(ys[py]! * cr) + f(xs[px]! * sr)) * n), 1)
      let m = f(K.clamp01(f(f(open - fp) / sf)) * (fp >= 0 ? 1 : 0))
      m = f(f(m * m) * f(3 - f(m * 2)))
      light[i] = f(m + f(f(1 - m) * dark))
    })
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const src = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i) => { o[i] = f(src[i]! * light[i]!) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  // ── R2.4: nodes_glsl_stylize.py ─────────────────────────────────────────

  /**
   * CrossHatch (:175-197): four hatch families over arange grids ((x ± y)
   * and (x ± y·0.5), each % density < 1) inked in as the luma falls under
   * threshold·0.75, ·0.5, ·0.3, ·0.15; 1 − ink.clamp on every channel of
   * the input (alpha too); clamp. Exact.
   */
  function CrossHatch(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const K = kern()
    const x = inp.image!
    const l = k.luma709(x, stop)
    const d = k.s32(p.density as number)
    const th = p.threshold as number
    const [t1, t2, t3, t4] = [th * 0.75, th * 0.5, th * 0.3, th * 0.15].map(k.s32)
    const n = x.w * x.h
    const out = k.tensor(x.c, x.h, x.w)
    pixels(x, stop, (i, px, py) => {
      const half = f(py * 0.5)
      const li = l[i]!
      let ink = 0
      if (li < t1!) ink = f(ink + (rem(f(px + py), d) < 1 ? 1 : 0))
      if (li < t2!) ink = f(ink + (rem(f(px - py), d) < 1 ? 1 : 0))
      if (li < t3!) ink = f(ink + (rem(f(px + half), d) < 1 ? 1 : 0))
      if (li < t4!) ink = f(ink + (rem(f(px - half), d) < 1 ? 1 : 0))
      const v = f(1 - K.clamp01(ink))
      for (let c = 0; c < x.c; c++) out.data[c * n + i] = v
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /** _BAYER_4 / 16 (:204-209), row by row. */
  const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => f(v / 16))

  /**
   * Dither (:224-230): the 4 × 4 Bayer tile, threshold (tile − 0.5) / (n −
   * 1), round((x + threshold)·(n − 1)) / (n − 1) (halves to even) on every
   * channel, n = max(2, levels); clamp (a −0 from rounding kept where
   * torch's clamp keeps it). Exact.
   */
  function Dither(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const n1 = Math.max(2, Math.trunc(p.levels as number)) - 1
    const thr = BAYER_4.map(b => f(f(b - 0.5) / n1))
    const out = k.tensor(x.c, x.h, x.w)
    for (let c = 0; c < x.c; c++) {
      const s = plane(x, c)
      const o = plane(out, c)
      pixels(x, stop, (i, px, py) => { o[i] = f(rne(f(f(s[i]! + thr[(py & 3) * 4 + (px & 3)]!) * n1)) / n1) })
    }
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  return {
    AdjustExposure, AdjustInvert, AdjustThreshold,
    AdjustBrightnessContrast, AdjustColor, AdjustCurves, AdjustLevels,
    AdjustTemperature, AdjustVibrance, AdjustColorBalance, AdjustBlackWhite, AdjustPhotoFilter, AdjustGradientMap, AdjustChannelMixer, AdjustPosterize,
    AdjustVignette, AdjustShadowsHighlights,
    Duotone, SplitToning,
    GradientMap, Posterize, Hologram, TwoDLight,
    LightLeak, LensFlare,
    Caustics, Blinds,
    CrossHatch, Dither,
  }
}

export type ToneCore = ReturnType<typeof toneCore>
