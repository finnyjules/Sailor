/**
 * Blur and convolution effects (family `effects-blur`, step 3 R2.5): 13
 * classes built on R2.2's gaussian blur, depthwise convolution, reflect
 * padding, area / bilinear resizes, affine_grid + grid_sample, max pooling
 * and topk.
 *
 * SELF-CONTAINED apart from its arguments (the tensor core and the kernels),
 * as ../../pixels/core.ts is: the compositor worker composes it from its
 * source text. Do not reference anything from outside this body but `k` and
 * `kn`.
 *
 * Each op takes the node's tensors by input name, its widgets as ComfyUI's
 * validation converted them (colour text already parsed on the main thread,
 * effects/table.ts `prepare`), a Stop check, the effect's batch state, and
 * the picture's index in the batch Python worked on and that batch's size.
 * It returns its outputs and the tensor its live preview shows (null: output
 * 0). FLOAT32, OP BY OP as torch: every product, sum and difference rounded,
 * a Python double scalar rounded to float32 once where it meets a tensor
 * (a comparison too), and a Python expression of scalars worked out in
 * double first.
 *
 * Every class is LIBRARY (R2 rule 10): each goes through conv2d (the
 * gaussian blur, a depthwise kernel, Sparkle's stamped star) or a
 * transcendental function (exp, sin, cos, pow), whose order or rounding is
 * torch's library's. Their exact steps (Outline's max_pool2d and amax, the
 * resizes, grid_sample, the per-pixel arithmetic) are ported bit for bit.
 * Every picture here sat channels-last in torch (the nodes permute
 * (B, H, W, C) to (B, C, H, W) without a copy, and every step keeps that
 * memory format), which decides the area resize's division and the bilinear
 * resize's rounding (kernels.ts TorchLayout).
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined

export function blurCore(k: TensorCore, kn: KernelsCore) {
  const f = Math.fround

  // ── Shared steps ────────────────────────────────────────────────────────

  /** Python raises on a 4-channel picture here (a 3-colour broadcast): checked before any work. */
  function needRgb(x: Tensor): void {
    if (x.c === 4) throw new Error(k.EFFECT_ERRORS.needsRgb)
  }

  /** Python's round() of a float: halves to the even neighbour. */
  function pyRound(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /** `2 * ceil(3.0 * sigma) + 1`: the nodes' gaussian width. */
  const ksizeOf = (sigma: number) => 2 * Math.ceil(3 * sigma) + 1

  /** How the picture sat in torch: channels-last, in a batch of `count`. */
  const permuted = (index = 0, count = 1) => ({ cl: true, batch: count, index })

  /** A per-value map into a new tensor of the same shape, Stop every 64 rows. */
  function map(x: Tensor, stop: Stop, each: (v: number, c: number, i: number) => number): Tensor {
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    k.rows(x.h, stop, (y) => {
      for (let c = 0; c < x.c; c++) {
        const base = c * n
        for (let i = y * x.w, end = i + x.w; i < end; i++) out.data[base + i] = each(x.data[base + i]!, c, i)
      }
    })
    return out
  }

  /** `.clamp(0, 1)` into a new tensor. */
  const clamped = (x: Tensor, stop: Stop) => map(x, stop, v => kn.clamp01(v))

  /** F.interpolate(scale_factor=1 / scale, mode='area'): output floor(side · (1 / scale)). */
  function areaDown(x: Tensor, scale: number, layout: ReturnType<typeof permuted>, stop: Stop): Tensor {
    const s = 1 / scale
    return kn.resizeArea(x, kn.areaOutSize(x.h, s), kn.areaOutSize(x.w, s), { ...layout, stop })
  }

  /** F.interpolate(size=(h, w), mode='bilinear', align_corners=False) of a channels-last tensor. */
  const bilinearUp = (x: Tensor, h: number, w: number) => kn.resizeBilinear(x, h, w, true)

  /**
   * A blur at `radius` that works on a smaller copy past 4 pixels (nodes_blur
   * `_gaussian`, TiltShift): scale = max(1, int(radius / 4)); scaled, an area
   * resize down, a blur at radius / scale, a bilinear resize back up.
   */
  function gaussianScaled(x: Tensor, radius: number, layout: ReturnType<typeof permuted>, stop: Stop): Tensor {
    const scale = Math.max(1, Math.trunc(radius / 4))
    if (scale > 1) {
      const small = areaDown(x, scale, layout, stop)
      const sigma = radius / scale
      return bilinearUp(kn.gaussianBlur(small, ksizeOf(sigma), sigma, stop), x.h, x.w)
    }
    return kn.gaussianBlur(x, ksizeOf(radius), radius, stop)
  }

  /** F.pad(x, [p] * 4, mode='reflect'). */
  const padAll = (x: Tensor, p: number) => kn.padReflect(x, p, p, p, p)

  /** Sobel's two kernels (FindEdges, HeightmapRelief, Outline). */
  const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
  const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1]

  // ── nodes_sharpen_noise.py ──────────────────────────────────────────────

  /**
   * Sharpen (nodes_sharpen_noise.py:33-42): amount 0 is a clamp; otherwise
   * (x + amount · (x − gaussian_blur(x, 2·ceil(3r) + 1, r))).clamp(0, 1).
   */
  function Sharpen(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const amount = p.amount as number
    if (amount === 0) return { outputs: [clamped(x, stop)], preview: null }
    const r = p.radius as number
    const b = kn.gaussianBlur(x, ksizeOf(r), r, stop)
    const a = k.s32(amount)
    return { outputs: [map(x, stop, (v, c, i) => kn.clamp01(f(v + f(a * f(v - b.data[c * x.w * x.h + i]!)))))], preview: null }
  }

  /** Denoise (nodes_sharpen_noise.py:99-108): strength ≤ 0 a clamp; else gaussian_blur at σ = strength, clamped. */
  function Denoise(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const s = p.strength as number
    if (s <= 0) return { outputs: [clamped(x, stop)], preview: null }
    return { outputs: [clamped(kn.gaussianBlur(x, ksizeOf(s), s, stop), stop)], preview: null }
  }

  // ── nodes_tone_extras.py ────────────────────────────────────────────────

  /**
   * AdjustGlow (nodes_tone_extras.py:83-106): intensity or radius ≤ 0 a
   * clamp. Otherwise the pixels whose luma is above the threshold (every
   * channel of them, alpha too), area-resized by 1 / max(1, int(r / 4))
   * (always, even by 1), blurred at r / scale, resized back (bilinear), and
   * x + intensity · that, clamped. A resize down to 0 pixels, or a blur
   * reaching the small picture's side, raises (EFFECT_PICTURE_TOO_SMALL).
   */
  function AdjustGlow(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const intensity = p.intensity as number
    const radius = p.radius as number
    if (intensity <= 0 || radius <= 0) return { outputs: [clamped(x, stop)], preview: null }
    const luma = k.luma709(x, stop)
    const thr = k.s32(p.threshold as number)
    const highlights = map(x, stop, (v, _c, i) => (luma[i]! > thr ? kn.clamp01(v) : 0))
    const scale = Math.max(1, Math.trunc(radius / 4))
    const small = areaDown(highlights, scale, permuted(index, count), stop)
    const sigma = radius / scale
    const blurred = bilinearUp(kn.gaussianBlur(small, ksizeOf(sigma), sigma, stop), x.h, x.w)
    const a = k.s32(intensity)
    return { outputs: [map(x, stop, (v, c, i) => kn.clamp01(f(v + f(a * blurred.data[c * x.w * x.h + i]!))))], preview: null }
  }

  // ── nodes_stylize.py ────────────────────────────────────────────────────

  /** HighPass (nodes_stylize.py:134-139): (x − gaussian_blur(x, 2·ceil(3r) + 1, r) + 0.5).clamp(0, 1). */
  function HighPass(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const r = p.radius as number
    const b = kn.gaussianBlur(x, ksizeOf(r), r, stop)
    return { outputs: [map(x, stop, (v, c, i) => kn.clamp01(f(f(v - b.data[c * x.w * x.h + i]!) + 0.5)))], preview: null }
  }

  /**
   * Emboss (nodes_stylize.py:104-112): the relief kernel × depth in float32
   * (the conv class scaled3; integer3 at depth 0 or 1), reflect padding of 1,
   * a depthwise conv, + 0.5, clamped.
   */
  function Emboss(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const depth = k.s32(p.depth as number)
    const kernel = [-2, -1, 0, -1, 1, 1, 0, 1, 2].map(v => f(v * depth))
    const t = kn.conv2dDepthwise(padAll(x, 1), kernel, 3, 3, stop)
    return { outputs: [map(t, stop, v => kn.clamp01(f(v + 0.5)))], preview: null }
  }

  /**
   * FindEdges (nodes_stylize.py:64-81): Sobel on every channel (reflect
   * padding), sqrt(gx² + gy²), the mean over the channels (alpha too),
   * × intensity, clamped, inverted if asked; the result on 3 channels.
   */
  function FindEdges(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const padded = padAll(x, 1)
    const gx = kn.conv2dDepthwise(padded, SOBEL_X, 3, 3, stop)
    const gy = kn.conv2dDepthwise(padded, SOBEL_Y, 3, 3, stop)
    const n = x.w * x.h
    const s = k.s32(p.intensity as number)
    const invert = !!p.invert
    const out = k.tensor(3, x.h, x.w)
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        let sum = 0
        for (let c = 0; c < x.c; c++) {
          const a = gx.data[c * n + i]!
          const b = gy.data[c * n + i]!
          sum = f(sum + f(Math.sqrt(f(f(a * a) + f(b * b)))))
        }
        let e = kn.clamp01(f(f(sum / x.c) * s))
        if (invert) e = f(1 - e)
        out.data[i] = e
        out.data[n + i] = e
        out.data[2 * n + i] = e
      }
    })
    return { outputs: [out], preview: null }
  }

  // ── nodes_blur.py ───────────────────────────────────────────────────────

  /**
   * `_motion_kernel` (nodes_blur.py:15-42): a line of `length` pixels at
   * `angle` degrees, sampled 2·length times (at least 4) with bilinear
   * weights worked out in Python's doubles, each added to the float32 kernel
   * (the weight rounded to float32, then a float32 sum), then ÷ its float32
   * sum. Length 1 or less: the 1 × 1 kernel [1]. Returned with its side.
   */
  function motionKernel(length: number, angleDeg: number): { kernel: Float32Array; ks: number } {
    if (length <= 1) return { kernel: Float32Array.of(1), ks: 1 }
    const ks = length % 2 === 1 ? length : length + 1
    const kernel = new Float32Array(ks * ks)
    const center = ks >> 1
    const rad = angleDeg * (Math.PI / 180)
    const cosA = Math.cos(rad)
    const sinA = Math.sin(rad)
    const samples = Math.max(length * 2, 4)
    for (let i = 0; i < samples; i++) {
      const t = (i / (samples - 1)) * length - length / 2
      const px = center + t * cosA
      const py = center + t * sinA
      const x0 = Math.floor(px)
      const y0 = Math.floor(py)
      const dx = px - x0
      const dy = py - y0
      const taps: [number, number, number][] = [
        [x0, y0, (1 - dx) * (1 - dy)],
        [x0 + 1, y0, dx * (1 - dy)],
        [x0, y0 + 1, (1 - dx) * dy],
        [x0 + 1, y0 + 1, dx * dy],
      ]
      for (const [xi, yi, w] of taps) {
        if (xi >= 0 && xi < ks && yi >= 0 && yi < ks) kernel[yi * ks + xi] = f(kernel[yi * ks + xi]! + f(w))
      }
    }
    const s = kn.sumContiguous(kernel, 0, kernel.length)
    if (s > 0) for (let i = 0; i < kernel.length; i++) kernel[i] = f(kernel[i]! / s)
    return { kernel, ks }
  }

  /**
   * `_motion` (nodes_blur.py:59-78): scale = max(1, int(length / 8)); scaled,
   * an area resize down, a line of max(2, round(length / scale)) pixels,
   * reflect padding of its half side, a depthwise conv, bilinear back up.
   */
  function motion(x: Tensor, length: number, angle: number, layout: ReturnType<typeof permuted>, stop: Stop): Tensor {
    const scale = Math.max(1, Math.trunc(length / 8))
    if (scale > 1) {
      const small = areaDown(x, scale, layout, stop)
      const { kernel, ks } = motionKernel(Math.max(2, pyRound(length / scale)), angle)
      const blurred = kn.conv2dDepthwise(padAll(small, ks >> 1), kernel, ks, ks, stop)
      return bilinearUp(blurred, x.h, x.w)
    }
    const { kernel, ks } = motionKernel(length, angle)
    return kn.conv2dDepthwise(padAll(x, ks >> 1), kernel, ks, ks, stop)
  }

  /**
   * `_zoom` (nodes_blur.py:81-96): 12 samples at scales 1 … 1 + 0.4·strength,
   * each affine_grid([[1/s, 0, 0], [0, 1/s, 0]]) and grid_sample (bilinear,
   * border, align_corners=False), summed in float32 from zeros, then ÷ 12.
   */
  function zoom(x: Tensor, strength: number, stop: Stop): Tensor {
    const samples = 12
    const maxZoom = 1 + strength * 0.4
    const out = k.tensor(x.c, x.h, x.w)
    for (let i = 0; i < samples; i++) {
      if (stop?.()) throw new Error('Stopped')
      const t = i / (samples - 1)
      const s = 1 + t * (maxZoom - 1)
      const { gx, gy } = kn.affineGrid([[1 / s, 0, 0], [0, 1 / s, 0]], x.h, x.w)
      const g = kn.gridSample(x, gx, gy, { padding: 'border', alignCorners: false, oh: x.h, ow: x.w }, stop)
      for (let j = 0; j < out.data.length; j++) out.data[j] = f(out.data[j]! + g.data[j]!)
    }
    for (let j = 0; j < out.data.length; j++) out.data[j] = f(out.data[j]! / samples)
    return out
  }

  /**
   * Blur (nodes_blur.py:156-164): gaussian (radius > 0), motion (length > 0,
   * rounded half to even) or zoom (strength > 0); otherwise unchanged; then
   * clamped.
   */
  function Blur(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    let x = inp.image!
    const type = p.type as string
    if (type === 'gaussian' && (p.radius as number) > 0) x = gaussianScaled(x, p.radius as number, permuted(index, count), stop)
    else if (type === 'motion' && (p.length as number) > 0) x = motion(x, pyRound(p.length as number), p.angle as number, permuted(index, count), stop)
    else if (type === 'zoom' && (p.strength as number) > 0) x = zoom(x, p.strength as number, stop)
    return { outputs: [clamped(x, stop)], preview: null }
  }

  // ── nodes_glsl_lens.py ──────────────────────────────────────────────────

  /**
   * Bokeh (nodes_glsl_lens.py:188-218): radius ≤ 0 a clamp. Otherwise, on a
   * copy area-resized by max(1, int(radius / 5)) when that is above 1, a disk
   * of radius r = radius / scale (side 2·ceil(r) + 1; sqrt(x² + y²) ≤ r in
   * float32) normalised by its count; the picture raised to highlight_boost,
   * reflect-padded, convolved, clamped at 0 and raised to 1 / boost; resized
   * back (bilinear) when scaled; clamped.
   */
  function Bokeh(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const radius = p.radius as number
    if (radius <= 0) return { outputs: [clamped(x, stop)], preview: null }
    const boost = p.highlight_boost as number
    const scale = Math.max(1, Math.trunc(radius / 5))
    const small = scale > 1 ? areaDown(x, scale, permuted(index, count), stop) : x
    const r = radius / scale
    const side = Math.trunc(2 * Math.ceil(r) + 1)
    const half = side >> 1
    const rf = k.s32(r)
    const disk = new Float32Array(side * side)
    for (let yy = 0; yy < side; yy++) {
      for (let xx = 0; xx < side; xx++) {
        const dx = xx - half
        const dy = yy - half
        const v = f(Math.sqrt(f(f(dx * dx) + f(dy * dy)))) <= rf ? 1 : 0
        disk[yy * side + xx] = v
      }
    }
    const total = f(kn.sumContiguous(disk, 0, disk.length))
    for (let i = 0; i < disk.length; i++) disk[i] = f(disk[i]! / total)
    const boosted = kn.powScalar(small, boost)
    if (stop?.()) throw new Error('Stopped')
    let blurred = kn.conv2dDepthwise(padAll(boosted, half), disk, side, side, stop)
    blurred = kn.powScalar(map(blurred, stop, v => (v < 0 ? 0 : v)), 1 / boost)
    if (scale > 1) blurred = bilinearUp(blurred, x.h, x.w)
    return { outputs: [clamped(blurred, stop)], preview: null }
  }

  // ── nodes_glsl_lab.py ───────────────────────────────────────────────────

  /**
   * TiltShift (nodes_glsl_lab.py:41-66): a mask over the rows (linspace
   * 0…1 over H; 1 in the band, a smoothstep over width / 2 either side) and
   * one blur at the maximum radius (as Blur's gaussian: area down by
   * max(1, int(blur / 4)), blurred, bilinear up); x · mask + blurred · (1 − mask),
   * clamped.
   */
  function TiltShift(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const position = k.s32(p.position as number)
    const width = p.width as number
    const falloff = Math.max(1e-4, width * 0.5)
    const top = k.s32(width / 2 + falloff)
    const fo = k.s32(falloff)
    const ys = kn.linspace(0, 1, x.h)
    const mask = new Float32Array(x.h)
    for (let y = 0; y < x.h; y++) {
      const d = Math.abs(f(ys[y]! - position))
      const m = kn.clamp01(f(f(top - d) / fo))
      mask[y] = f(f(m * m) * f(3 - f(2 * m)))
    }
    const blurred = gaussianScaled(x, p.blur as number, permuted(index, count), stop)
    return {
      outputs: [map(x, stop, (v, c, i) => {
        const m = mask[Math.floor(i / x.w)]!
        return kn.clamp01(f(f(v * m) + f(blurred.data[c * x.w * x.h + i]! * f(1 - m))))
      })],
      preview: null,
    }
  }

  /**
   * FrequencySeparation (nodes_glsl_lab.py:95-106): low = gaussian_blur at
   * the radius, clamped; high = (x − low + 0.5), clamped. Two outputs; the
   * preview is low, high, or the two side by side (cat along the width).
   */
  function FrequencySeparation(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const r = p.radius as number
    const low = clamped(kn.gaussianBlur(x, ksizeOf(r), r, stop), stop)
    const high = map(x, stop, (v, c, i) => kn.clamp01(f(f(v - low.data[c * x.w * x.h + i]!) + 0.5)))
    const show = p.show as string
    if (show === 'low') return { outputs: [low, high], preview: null }
    if (show === 'high') return { outputs: [low, high], preview: high }
    const both = k.tensor(x.c, x.h, 2 * x.w)
    const n = x.w * x.h
    for (let c = 0; c < x.c; c++) {
      for (let y = 0; y < x.h; y++) {
        const row = c * 2 * n + y * 2 * x.w
        both.data.set(low.data.subarray(c * n + y * x.w, c * n + (y + 1) * x.w), row)
        both.data.set(high.data.subarray(c * n + y * x.w, c * n + (y + 1) * x.w), row + x.w)
      }
    }
    return { outputs: [low, high], preview: both }
  }

  /**
   * HeightmapRelief (nodes_glsl_lab.py:196-224): Sobel on the luma (reflect
   * padding) × depth, the normal (−gx, −gy, 1) normalised (its length at
   * least 10⁻⁶), lit by a light at `angle` and `elevation` (its direction in
   * Python's doubles, each part rounded to float32 where it meets the
   * normal): ambient + (1 − ambient) · max(0, n · l), clamped; times the
   * picture (every channel), or on its own on 3 channels.
   */
  function HeightmapRelief(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const luma = k.luma709(x, stop)
    const padded = padAll({ c: 1, h: x.h, w: x.w, data: luma }, 1)
    const gx = kn.conv2dDepthwise(padded, SOBEL_X, 3, 3, stop)
    const gy = kn.conv2dDepthwise(padded, SOBEL_Y, 3, 3, stop)
    const depth = k.s32(p.depth as number)
    const rad = (p.angle as number) * (Math.PI / 180)
    const elev = (p.elevation as number) * (Math.PI / 2)
    const lx = k.s32(Math.cos(rad) * Math.cos(elev))
    const ly = k.s32(Math.sin(rad) * Math.cos(elev))
    const lz = k.s32(Math.sin(elev))
    const ambient = p.ambient as number
    const amb = k.s32(ambient)
    const rest = k.s32(1 - ambient)
    const tiny = k.s32(1e-6)
    const n = x.w * x.h
    const light = new Float32Array(n)
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        const nx = -f(gx.data[i]! * depth)
        const ny = -f(gy.data[i]! * depth)
        let norm = f(Math.sqrt(f(f(f(nx * nx) + f(ny * ny)) + 1)))
        if (norm < tiny) norm = tiny
        const ux = f(nx / norm)
        const uy = f(ny / norm)
        const uz = f(1 / norm)
        let shade = f(f(f(ux * lx) + f(uy * ly)) + f(uz * lz))
        if (shade < 0) shade = 0
        light[i] = kn.clamp01(f(amb + f(rest * shade)))
      }
    })
    if (p.keep_color) return { outputs: [map(x, stop, (v, _c, i) => kn.clamp01(f(v * light[i]!)))], preview: null }
    const out = k.tensor(3, x.h, x.w)
    for (let c = 0; c < 3; c++) out.data.set(light, c * n)
    return { outputs: [out], preview: null }
  }

  // ── nodes_glsl_unicorn.py ───────────────────────────────────────────────

  /**
   * Outline (nodes_glsl_unicorn.py:185-216): Sobel on the luma (zero
   * padding), the magnitude ÷ its picture's max (at least 10⁻⁶), a soft edge
   * around threshold / 2, dilated by max_pool2d(2k + 1) for
   * k = max(1, round(thickness)) above 1; over a solid fill, the source or
   * black; mixed with the source; clamped. `line` and `fill` are the parsed
   * colours (table.ts prepare). A 4-channel picture raises (the colours
   * broadcast over 3), checked first.
   */
  function Outline(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    needRgb(x)
    const lu: Tensor = { c: 1, h: x.h, w: x.w, data: k.luma709(x, stop) }
    const gx = kn.conv2dSame(lu, SOBEL_X, 3, 3, 1, stop)
    const gy = kn.conv2dSame(lu, SOBEL_Y, 3, 3, 1, stop)
    const n = x.w * x.h
    const mag = new Float32Array(n)
    let amax = -Infinity
    for (let i = 0; i < n; i++) {
      const a = gx.data[i]!
      const b = gy.data[i]!
      const m = f(Math.sqrt(f(f(a * a) + f(b * b))))
      mag[i] = m
      if (m > amax || m !== m) amax = m
    }
    const tiny = k.s32(1e-6)
    if (amax < tiny) amax = tiny
    const threshold = p.threshold as number
    const lo = k.s32(threshold * 0.5)
    const span = k.s32(Math.max(0.01, threshold * 0.5))
    let soft: Tensor = { c: 1, h: x.h, w: x.w, data: new Float32Array(n) }
    for (let i = 0; i < n; i++) soft.data[i] = kn.clamp01(f(f(f(mag[i]! / amax) - lo) / span))
    const kk = Math.max(1, pyRound(p.thickness as number))
    if (kk > 1) soft = kn.maxPool2d(soft, kk * 2 + 1, kk, stop)
    const em = soft.data
    const line = (p.line as number[]).map(v => k.s32(v))
    const fill = (p.fill as number[]).map(v => k.s32(v))
    const mode = p.fill_mode as string
    const mix = p.mix as number
    const keep = k.s32(1 - mix)
    const take = k.s32(mix)
    return {
      outputs: [map(x, stop, (v, c, i) => {
        const e = em[i]!
        const base = mode === 'solid' ? fill[c]! : mode === 'source' ? v : 0
        const o = f(f(base * f(1 - e)) + f(line[c]! * e))
        return kn.clamp01(f(f(v * keep) + f(o * take)))
      })],
      preview: null,
    }
  }

  /**
   * The peaks Sparkle keeps (nodes_glsl_unicorn.py:471-482): pixels whose
   * luma is the brightest within 9 × 9 (less 10⁻⁵) and above the threshold;
   * of those, topk(max(1, int(max_density · h · w))) over peak · luma, kept
   * while above the threshold. Among values tied at the cut the lower index
   * is kept (kernels.ts topk; torch's choice there is its own: the band).
   * Returns the kept pixel indices.
   */
  function sparklePeaks(x: Tensor, p: Params, stop: Stop): Int32Array {
    const n = x.w * x.h
    const lu = k.luma709(x, stop)
    const lmax = kn.maxPool2d({ c: 1, h: x.h, w: x.w, data: lu }, 9, 4, stop).data
    const thr = k.s32(p.threshold as number)
    const near = k.s32(1e-5)
    const flat = new Float32Array(n)
    for (let i = 0; i < n; i++) flat[i] = lu[i]! >= f(lmax[i]! - near) && lu[i]! > thr ? lu[i]! : 0
    const maxN = Math.max(1, Math.trunc((p.max_density as number) * x.h * x.w))
    const top = kn.topk(flat, Math.min(maxN, n), true, stop)
    return top.filter(i => flat[i]! > thr)
  }

  /**
   * The star (nodes_glsl_unicorn.py:486-510), ks = 2·int(size) + 1 on a side:
   * each arm exp(−1.5 · its distance from the arm's line) · q · (1 − q), q
   * = clamp(|along| / (ks / 2), 0, 1), the arms' max, and the centre's
   * 0.6 · exp(−(x² + y²) / (0.06 · ks)) over it. sin, cos, exp: library.
   */
  function sparkleStar(p: Params): { star: Float32Array; ks: number } {
    const ks = Math.trunc(p.size as number) * 2 + 1
    const c0 = ks >> 1
    const star = new Float32Array(ks * ks)
    const points = p.points as number
    const angle = p.angle as number
    const half = k.s32(ks / 2)
    for (let i = 0; i < points; i++) {
      const a = f((angle + i * (360 / points)) * Math.PI / 180)
      const sa = f(Math.sin(a))
      const ca = f(Math.cos(a))
      for (let y = 0; y < ks; y++) {
        const yy = y - c0
        for (let xq = 0; xq < ks; xq++) {
          const xx = xq - c0
          const perp = Math.abs(f(f(-xx * sa) + f(yy * ca)))
          const along = f(f(xx * ca) + f(yy * sa))
          const q = kn.clamp01(f(Math.abs(along) / half))
          let arm = f(f(Math.exp(f(-perp * 1.5))) * q)
          arm = f(arm * f(1 - q))
          const j = y * ks + xq
          if (arm > star[j]!) star[j] = arm
        }
      }
    }
    const spread = k.s32(ks * 0.06)
    const glow = k.s32(0.6)
    for (let y = 0; y < ks; y++) {
      const yy = y - c0
      for (let xq = 0; xq < ks; xq++) {
        const xx = xq - c0
        const center = kn.clamp01(f(Math.exp(f(-f(f(xx * xx) + f(yy * yy)) / spread))))
        const v = f(center * glow)
        const j = y * ks + xq
        if (v > star[j]!) star[j] = v
      }
    }
    return { star, ks }
  }

  /**
   * Sparkle (nodes_glsl_unicorn.py:465-529): the star at every kept peak.
   * Python convolves the peaks with the star (conv2d, zero padding ks // 2);
   * the runner STAMPS the star at each kept peak instead (the same sum, far
   * fewer products), each pixel's sum in double rounded once. Then
   * × intensity clamped to [0, 4], added to every channel, clamped.
   */
  function Sparkle(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const kept = sparklePeaks(x, p, stop)
    const { star, ks } = sparkleStar(p)
    const n = x.w * x.h
    const sum = new Float64Array(n)
    const pad = ks >> 1
    for (let q = 0; q < kept.length; q++) {
      if (stop && (q & 63) === 0 && stop()) throw new Error('Stopped')
      const py = Math.floor(kept[q]! / x.w)
      const px = kept[q]! - py * x.w
      const y0 = Math.max(0, py - pad)
      const y1 = Math.min(x.h - 1, py + pad)
      const x0 = Math.max(0, px - pad)
      const x1 = Math.min(x.w - 1, px + pad)
      for (let y = y0; y <= y1; y++) {
        const srow = (py - y + pad) * ks + pad + px
        const row = y * x.w
        for (let xx = x0; xx <= x1; xx++) sum[row + xx] = sum[row + xx]! + star[srow - xx]!
      }
    }
    const intensity = k.s32(p.intensity as number)
    const flare = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = f(f(sum[i]!) * intensity)
      flare[i] = v < 0 ? 0 : v > 4 ? 4 : v
    }
    return { outputs: [map(x, stop, (v, _c, i) => kn.clamp01(f(v + flare[i]!)))], preview: null }
  }

  return {
    Sharpen, Denoise, AdjustGlow, HighPass, Emboss, FindEdges, Blur, Bokeh, TiltShift, FrequencySeparation, HeightmapRelief, Outline, Sparkle,
    motionKernel, sparklePeaks,
  }
}

export type BlurCore = ReturnType<typeof blurCore>
