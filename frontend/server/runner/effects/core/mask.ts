/**
 * Masks, blends and Painter (family `effects-mask`, step 3 R2.8): Blend,
 * Apply mask, Threshold mask, Color range mask (nodes_composite.py); Matte
 * grow / shrink, Merge alpha (nodes_matte.py); Painter's composite
 * (nodes_painter.py). Built on R2.2's bilinear resize and gaussian blur, and
 * on Pillow's Lanczos from the pixels core (R1.5).
 *
 * SELF-CONTAINED apart from its arguments (the tensor core, the kernels and
 * the pixels core), as ../../pixels/core.ts is: the compositor worker
 * composes it from its source text. Do not reference anything from outside
 * this body but `k`, `kn` and `px`.
 *
 * Each op takes the node's tensors by input name (a mask is a 1-channel
 * tensor, u / 65535 of the kept 16-bit mask), its widgets as ComfyUI's
 * validation converted them, a Stop check, the effect's batch state, and the
 * picture's index in the batch Python worked on and that batch's size.
 * FLOAT32, OP BY OP as torch: every product, sum and difference rounded, a
 * Python double scalar rounded to float32 once where it meets a tensor (a
 * comparison too), and a Python expression of scalars worked out in double
 * first. Painter's composite is numpy's float32, op by op alike.
 *
 * Parity (R2 rule 10): every op is EXACT except Matte grow / shrink's
 * feather (torchvision's gaussian_blur: LIBRARY). Its grow and shrink are
 * max_pool2d, exact: a max is the same whatever order it is taken in, so it
 * is taken one side at a time (the same values as kernels.ts maxPool2d, in
 * 2k steps a value instead of k²).
 *
 * The last `.clamp(0, 1)` of a picture handed on as a float (Blend, Apply
 * mask, Merge alpha): torch's vector loop turns −0 into +0, its scalar tails
 * keep it (kernels.ts inScalarTail, over the contiguous (B, H, W, C) result).
 * A mask is kept as 16 bits, where its zeros' sign doesn't reach.
 */
import type { PixelsCore } from '../../pixels/core'
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined

/** A painter file as sharp decoded it (RGBA8, no EXIF turn), handed to the worker as it is. */
export interface PainterFile { w: number; h: number; rgba8: Uint8Array }

export function maskCore(k: TensorCore, kn: KernelsCore, px: PixelsCore) {
  const f = Math.fround
  const ERR = k.EFFECT_ERRORS

  // ── Shared steps ────────────────────────────────────────────────────────

  /** A Stop check between passes that run inside a kernel with no Stop of its own. */
  function stopNow(stop: Stop): void {
    if (stop?.()) throw new Error('Stopped')
  }

  /** Python's round() of a double: halves to the even neighbour. */
  function pyRound(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /** Python's max(a, b) of two floats: the first unless the second is greater. */
  const pyMax = (a: number, b: number) => (b > a ? b : a)

  /**
   * A `.clamp(0, 1)` over a contiguous (B, H, W, C) tensor, a picture or a
   * (B, H, W) mask (C = 1), in place: −0 kept only in the scalar tails of
   * torch's loop (kernels.ts inScalarTail, over the whole batch in memory
   * order), as torch's clamp keeps it; NaN stays NaN. Every clamp whose result
   * is handed on (a picture, and a mask, since masks hand on their float:
   * R2.8 fix rounds 1 and 2) goes through here.
   */
  function finish(t: Tensor, stop: Stop, index: number, count: number): Tensor {
    const n = t.w * t.h
    const C = t.c
    const total = count * n * C
    const base = index * n * C
    const d = t.data
    k.rows(t.h, stop, (y) => {
      for (let i = y * t.w, end = i + t.w; i < end; i++) {
        for (let c = 0; c < C; c++) {
          const v = d[c * n + i]!
          d[c * n + i] = Object.is(v, -0) && kn.inScalarTail(base + i * C + c, total, kn.TORCH_THREADS) ? -0 : kn.clamp01(v)
        }
      }
    })
    return t
  }

  /** `finish` on a copy (the input is left as it is). */
  const clampedCopy = (t: Tensor, stop: Stop, index: number, count: number) =>
    finish({ c: t.c, h: t.h, w: t.w, data: new Float32Array(t.data) }, stop, index, count)

  /** clamp(0, 1) of a live preview only: quantised to 8 bits, where a zero's sign doesn't reach. */
  function previewClamp(t: Tensor, stop: Stop): Tensor {
    const out = k.tensor(t.c, t.h, t.w)
    const d = t.data
    k.rows(t.h, stop, (y) => {
      for (let c = 0; c < t.c; c++) {
        const o = c * t.w * t.h
        for (let i = o + y * t.w, end = i + t.w; i < end; i++) out.data[i] = kn.clamp01(d[i]!)
      }
    })
    return out
  }

  /** image · mask on every channel of the picture (the mask 1 channel, the picture's size). */
  function times(x: Tensor, m: Tensor, channels: number, stop: Stop): Tensor {
    const out = k.tensor(channels, x.h, x.w)
    const n = x.w * x.h
    const md = m.data
    k.rows(x.h, stop, (y) => {
      for (let c = 0; c < channels; c++) {
        const s = x.data.subarray(c * n, (c + 1) * n)
        const d = out.data.subarray(c * n, (c + 1) * n)
        for (let i = y * x.w, end = i + x.w; i < end; i++) d[i] = f(s[i]! * md[i]!)
      }
    })
    return out
  }

  /** 1 − m, elementwise. */
  function oneMinus(m: Tensor, stop: Stop): Tensor {
    const out = k.tensor(m.c, m.h, m.w)
    k.rows(m.h, stop, (y) => {
      for (let c = 0; c < m.c; c++) {
        const o = c * m.w * m.h
        for (let i = o + y * m.w, end = i + m.w; i < end; i++) out.data[i] = f(1 - m.data[i]!)
      }
    })
    return out
  }

  /**
   * A mask resized to the picture when their sizes differ: F.interpolate of the
   * contiguous (B, 1, H, W) mask, bilinear, align_corners False (kernels.ts
   * resizeBilinear), a Stop check just before and after.
   */
  function maskTo(m: Tensor, h: number, w: number, stop: Stop): Tensor {
    if (m.h === h && m.w === w) return m
    stopNow(stop)
    const r = kn.resizeBilinear(m, h, w, false)
    stopNow(stop)
    return r
  }

  // ── nodes_composite.py ──────────────────────────────────────────────────

  /** Blend's modes (`_blend`, nodes_composite.py:20-48), per float32 pair. */
  const BLEND: Readonly<Record<string, (a: number, b: number) => number>> = {
    normal: (_a, b) => b,
    multiply: (a, b) => f(a * b),
    screen: (a, b) => f(1 - f(f(1 - a) * f(1 - b))),
    overlay: (a, b) => (a < 0.5 ? f(f(2 * a) * b) : f(1 - f(f(2 * f(1 - a)) * f(1 - b)))),
    soft_light: (a, b) => f(f(f(f(1 - f(2 * b)) * a) * a) + f(f(2 * b) * a)),
    hard_light: (a, b) => (b < 0.5 ? f(f(2 * a) * b) : f(1 - f(f(2 * f(1 - a)) * f(1 - b)))),
    difference: (a, b) => Math.abs(f(a - b)),
    // torch.maximum / minimum (NEON max / min: +0 above −0; NaN from either).
    lighten: (a, b) => (a !== a || b !== b ? NaN : a > b ? a : b > a ? b : Object.is(a, -0) ? b : a),
    darken: (a, b) => (a !== a || b !== b ? NaN : a < b ? a : b < a ? b : Object.is(a, -0) ? a : b),
    add: (a, b) => f(a + b),
    subtract: (a, b) => f(a - b),
  }

  /**
   * Blend (nodes_composite.py:51-82): `_match_size` (the top resized to the
   * base, bilinear, of the channels-last (B, C, H, W) the permute makes), the
   * mode, then (base · f32(1 − opacity) + blended · f32(opacity)).clamp(0, 1).
   * Base and top of 3 against 4 channels don't broadcast: Python raises. Exact.
   */
  function Blend(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const a = inp.base!
    let b = inp.top!
    if (a.c !== b.c) throw new Error(ERR.needsRgb)
    if (b.h !== a.h || b.w !== a.w) {
      stopNow(stop)
      b = kn.resizeBilinear(b, a.h, a.w, true)
      stopNow(stop)
    }
    const mode = Object.prototype.hasOwnProperty.call(BLEND, p.mode as string) ? BLEND[p.mode as string]! : BLEND.normal!
    const op = p.opacity as number
    const keep = k.s32(1 - op)
    const mix = k.s32(op)
    const out = k.tensor(a.c, a.h, a.w)
    const n = a.w * a.h
    k.rows(a.h, stop, (y) => {
      for (let c = 0; c < a.c; c++) {
        const o = c * n
        for (let i = o + y * a.w, end = i + a.w; i < end; i++) {
          const x = a.data[i]!
          out.data[i] = f(f(x * keep) + f(mode(x, b.data[i]!) * mix))
        }
      }
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  /**
   * ApplyMask (nodes_composite.py:83-118): the mask resized to the picture
   * when the sizes differ (contiguous, bilinear), 1 − mask with `invert`, then
   * (image · mask).clamp(0, 1) on every channel. Exact.
   */
  function ApplyMask(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    let m = maskTo(inp.mask!, x.h, x.w, stop)
    if (p.invert) m = oneMinus(m, stop)
    return { outputs: [finish(times(x, m, x.c, stop), stop, index, count)], preview: null }
  }

  /**
   * ThresholdMask (nodes_composite.py:119-155): the Rec. 709 luma (tensor.ts
   * luma709); softness ≤ 0: luma > f32(threshold) as 0 or 1; else
   * ((luma − f32(low)) / f32(max(1e-6, high − low))).clamp(0, 1), low and
   * high in double; 1 − mask with `invert`. A MASK out; the preview is
   * (image · mask).clamp(0, 1). Exact.
   */
  function ThresholdMask(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const t = p.threshold as number
    const soft = p.softness as number
    const luma = k.luma709(x, stop)
    const m = k.tensor(1, x.h, x.w)
    if (soft <= 0) {
      const at = k.s32(t)
      for (let i = 0; i < luma.length; i++) m.data[i] = luma[i]! > at ? 1 : 0
    }
    else {
      const low = t - soft
      const high = t + soft
      const lo = k.s32(low)
      const den = k.s32(pyMax(1e-6, high - low))
      k.rows(x.h, stop, (y) => {
        for (let i = y * x.w, end = i + x.w; i < end; i++) m.data[i] = f(f(luma[i]! - lo) / den)
      })
      finish(m, stop, index, count)
    }
    const mask = p.invert ? oneMinus(m, stop) : m
    return { outputs: [mask], preview: previewClamp(times(x, mask, x.c, stop), stop) }
  }

  /**
   * ColorRangeMask (nodes_composite.py:156-188): the distance to the target,
   * ((image − target)²).sum(−1).sqrt() over 3 channels (a 4-channel picture
   * doesn't broadcast against the 3-colour target: Python raises), divided
   * by f32(max(1e-6, tolerance · 1.732)) and clamped; mask = 1 − that (and 1 −
   * mask with `invert`). A MASK out; the preview is (image · mask).clamp(0, 1).
   * Exact: pow(2) is x·x, the sum ((d0 + d1) + d2), sqrt correctly rounded.
   */
  function ColorRangeMask(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    if (x.c !== 3) throw new Error(ERR.needsRgb)
    const target = [k.s32(p.target_r as number), k.s32(p.target_g as number), k.s32(p.target_b as number)]
    const den = k.s32(pyMax(1e-6, (p.tolerance as number) * 1.732))
    const n = x.w * x.h
    const m = k.tensor(1, x.h, x.w)
    const d = x.data
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        const d0 = f(d[i]! - target[0]!)
        const d1 = f(d[n + i]! - target[1]!)
        const d2 = f(d[2 * n + i]! - target[2]!)
        const dist = f(Math.sqrt(f(f(f(d0 * d0) + f(d1 * d1)) + f(d2 * d2))))
        m.data[i] = f(1 - kn.clamp01(f(dist / den)))
      }
    })
    const mask = p.invert ? oneMinus(m, stop) : m
    return { outputs: [mask], preview: previewClamp(times(x, mask, x.c, stop), stop) }
  }

  // ── nodes_matte.py ──────────────────────────────────────────────────────

  /**
   * max_pool2d(k, stride 1, padding k // 2) of a 1-channel mask (−∞ outside),
   * one side at a time: across each row, then down each column. A max is the
   * same whatever order it is taken in, so this is kernels.ts maxPool2d's
   * value everywhere (the spec holds them equal), in 2k steps a value.
   * `negate`: the erosion, −max_pool(−m).
   */
  function maxPoolSeparable(m: Tensor, kk: number, negate: boolean, stop: Stop): Tensor {
    const pad = kk >> 1
    const { w, h } = m
    const s = negate ? -1 : 1
    const across = new Float32Array(w * h)
    k.rows(h, stop, (y) => {
      const row = y * w
      for (let x = 0; x < w; x++) {
        let best = -Infinity
        const x0 = Math.max(0, x - pad)
        const x1 = Math.min(w, x - pad + kk)
        for (let j = x0; j < x1; j++) {
          const v = s * m.data[row + j]!
          if (v > best || v !== v) best = v
        }
        across[row + x] = best
      }
    })
    const out = k.tensor(1, h, w)
    k.rows(h, stop, (y) => {
      const y0 = Math.max(0, y - pad)
      const y1 = Math.min(h, y - pad + kk)
      for (let x = 0; x < w; x++) {
        let best = -Infinity
        for (let j = y0; j < y1; j++) {
          const v = across[j * w + x]!
          if (v > best || v !== v) best = v
        }
        out.data[y * w + x] = s * best
      }
    })
    return out
  }

  /**
   * MatteGrowShrink (nodes_matte.py:23-80): the mask clamped; amount ≠ 0:
   * k = |int(round(amount))|·2 + 1, max_pool2d to grow (amount > 0), or
   * −max_pool2d(−m) to shrink; feather > 0: torchvision gaussian_blur with
   * ksize 2·ceil(3·feather) + 1 and σ = feather (reflect padding of ksize // 2:
   * a mask that small raises in Python); clamped again. The preview is the
   * mask as grey RGB. Exact, but LIBRARY when feathered.
   */
  function MatteGrowShrink(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const amount = p.amount as number
    const feather = p.feather as number
    let m = clampedCopy(inp.mask!, stop, index, count)
    if (amount !== 0) {
      const kk = Math.abs(Math.trunc(pyRound(amount))) * 2 + 1
      if (kk > 1) m = maxPoolSeparable(m, kk, amount < 0, stop)
    }
    if (feather > 0) {
      const ksize = 2 * Math.ceil(3 * feather) + 1
      stopNow(stop)
      m = kn.gaussianBlur(m, ksize, feather, stop)
    }
    m = clampedCopy(m, stop, index, count)
    const preview = k.tensor(3, m.h, m.w)
    for (let c = 0; c < 3; c++) preview.data.set(m.data, c * m.w * m.h)
    return { outputs: [m], preview }
  }

  /**
   * MergeAlpha (nodes_matte.py:81-123): the mask resized to the picture when
   * the sizes differ (contiguous, bilinear), clamped, 1 − mask with
   * `invert_mask`; the picture's first 3 channels and the mask as alpha,
   * clamped (always RGBA). The preview is (rgb · mask).clamp(0, 1), 3
   * channels. Picture and mask batches must be equal (torch.cat doesn't
   * broadcast; effects/table.ts `equalBatches`). Exact.
   */
  function MergeAlpha(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    let m = clampedCopy(maskTo(inp.mask!, x.h, x.w, stop), stop, index, count)
    if (p.invert_mask) m = oneMinus(m, stop)
    const n = x.w * x.h
    const rgba = k.tensor(4, x.h, x.w)
    rgba.data.set(x.data.subarray(0, 3 * n))
    rgba.data.set(m.data, 3 * n)
    return { outputs: [finish(rgba, stop, index, count)], preview: previewClamp(times(x, m, 3, stop), stop) }
  }

  // ── nodes_painter.py ────────────────────────────────────────────────────

  /**
   * Painter's composite (nodes_painter.py:73-104). The base is the picture
   * wired in (its first; the plan hands only that), else a width × height
   * canvas of f32(bg), bg read by the painter's own hex_to_rgb on the main
   * thread (`p.bg`). With a painter file (RGBA8 as `Image.open().convert
   * ("RGBA")` holds it, no EXIF turn): resized with Pillow's LANCZOS
   * (premultiplied, pixels core pilResizeRgba) when its size differs; then in
   * numpy's float32, v = f32(b / 255) and composited = rgb·a + base·(1 − a);
   * the mask is a. A 4-channel base doesn't broadcast against the file's 3
   * colours: Python raises. With no file, the base as it is and a zero mask.
   * Exact.
   */
  function Painter(inp: Record<string, Tensor | PainterFile>, p: Params, stop?: Stop): EffectResult {
    const image = inp.image as Tensor | undefined
    const file = inp.painter as PainterFile | undefined
    let base: Tensor
    if (image) base = image
    else {
      const w = p.width as number
      const h = p.height as number
      const bg = p.bg as readonly number[]
      base = k.tensor(3, h, w)
      for (let c = 0; c < 3; c++) base.data.fill(f(bg[c]!), c * w * h, (c + 1) * w * h)
    }
    const { w, h } = base
    const n = w * h
    if (!file) return { outputs: [image ? { c: base.c, h, w, data: new Float32Array(base.data) } : base, k.tensor(1, h, w)], preview: null }
    if (base.c !== 3) throw new Error(ERR.needsRgb)
    let px8 = file.rgba8
    if (file.w !== w || file.h !== h) {
      stopNow(stop)
      px8 = px.pilResizeRgba(file.rgba8, file.w, file.h, w, h, stop)
      stopNow(stop)
    }
    const table = new Float32Array(256)
    for (let b = 0; b < 256; b++) table[b] = f(b / 255)
    const out = k.tensor(3, h, w)
    const mask = k.tensor(1, h, w)
    k.rows(h, stop, (y) => {
      for (let i = y * w, end = i + w; i < end; i++) {
        const a = table[px8[i * 4 + 3]!]!
        const keep = f(1 - a)
        mask.data[i] = a
        for (let c = 0; c < 3; c++) out.data[c * n + i] = f(f(table[px8[i * 4 + c]!]! * a) + f(base.data[c * n + i]! * keep))
      }
    })
    return { outputs: [out, mask], preview: null }
  }

  // The ops: every function returned is addressable as 'mask.<name>' (effects/table.ts), so helpers stay out.
  return { Blend, ApplyMask, ThresholdMask, ColorRangeMask, MatteGrowShrink, MergeAlpha, Painter }
}

export type MaskCore = ReturnType<typeof maskCore>
