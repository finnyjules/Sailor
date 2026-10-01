/**
 * Lens · Depth of field (comfy_extras/nodes_lens.py, _lens.py; step 3, R7.9):
 * the blur, given a depth, as the runner's port. The depth comes wired in
 * (`depth`: a picture, its channels averaged and resized to the picture), or
 * from Depth Anything V2 Small on the main thread (`depthRaw`: the model's
 * raw answer, resized here as _depth.py resizes it and min–max normalised).
 *
 * SELF-CONTAINED apart from its arguments (the tensor and kernels cores), as
 * the other effect cores are: the compositor worker composes it from its
 * source text. Do not reference anything from outside this body but `k` and `kn`.
 *
 * Python's steps, each ported in its float32 order (torch rounds a Python
 * double meeting a float32 tensor to float32 once):
 *   - no picture: 16 × 16 black (nodes_lens.py:64-70);
 *   - wired depth: the first picture, the mean over its channels, bilinear to
 *     the picture (align_corners=False), clamped (:75-85). EXACT;
 *   - the model's depth: bicubic to the picture, min–max normalised
 *     (_depth.py:96, 116-119). EXACT given the same raw answer;
 *   - focus: the tapped point's depth plus the offset, clamped (:88-97; the
 *     text is read on the main thread). EXACT;
 *   - focal_compression (grid_sample, border, align_corners=True), the circle
 *     of confusion, chromatic_aberration and vignette. EXACT;
 *   - render_dof: five levels at max_r·i/4, each a disk / hexagon / anamorphic
 *     kernel over the reflect-padded picture (the highlight boost on the
 *     blurred levels only), blended by tent weights. LIBRARY: torch's conv2d
 *     sums the (2r + 1)² taps in library order; here each kernel row is a
 *     span of one padded row, summed from float64 prefix sums, so one pass
 *     costs (2r + 1) per value, not (2r + 1)², then × the kernel's float32
 *     tap (1 / its tap count). The 8-bit output equals Python's except within
 *     a small ε of a quantisation boundary (tests/unit/runner-effects-lens.unit.spec.ts).
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined

export function lensCore(k: TensorCore, kn: KernelsCore) {
  const f = Math.fround
  const SQRT3_2 = f(Math.sqrt(3) / 2)
  const ANAMORPHIC = f(1.8)
  const CA_SCALE = 0.03
  const FC_SCALE = 0.25
  const MAX_RADIUS = 24
  const LEVELS = 5

  /** Python's round() of a float: halves to the even neighbour. */
  function pyRound(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

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

  const clamped = (x: Tensor, stop: Stop) => map(x, stop, v => kn.clamp01(v))

  /** The mean over a picture's channels (torch's sum over them, then ÷ C), one plane. */
  function channelMean(t: Tensor): Tensor {
    const out = k.tensor(1, t.h, t.w)
    const n = t.w * t.h
    for (let i = 0; i < n; i++) {
      let s = t.data[i]!
      for (let c = 1; c < t.c; c++) s = f(s + t.data[c * n + i]!)
      out.data[i] = f(s / t.c)
    }
    return out
  }

  /** The depth wired in (nodes_lens.py:75-85): the channels' mean, bilinear to h × w, clamped. */
  function wiredDepth(d: Tensor, h: number, w: number): Tensor {
    const plane = d.c === 1 ? d : channelMean(d)
    const r = kn.resizeBilinear(plane, h, w)
    for (let i = 0; i < r.data.length; i++) r.data[i] = kn.clamp01(r.data[i]!)
    return r
  }

  /** The model's raw depth (_depth.py:96, 116-119): bicubic to h × w, then (raw − lo) / (hi − lo), or zeros when flat. */
  function modelDepth(raw: Tensor, h: number, w: number, stop: Stop): Tensor {
    const r = kn.resizeBicubic(raw, h, w, stop)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < r.data.length; i++) {
      const v = r.data[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!(hi > lo)) return k.tensor(1, h, w)
    const lo32 = f(lo)
    const span = f(hi - lo)
    for (let i = 0; i < r.data.length; i++) r.data[i] = f(f(r.data[i]! - lo32) / span)
    return r
  }

  /** The x and y planes of meshgrid(linspace(−1, 1, h), linspace(−1, 1, w)). */
  function unitGrid(h: number, w: number): { gx: Float32Array; gy: Float32Array } {
    const ys = kn.linspace(-1, 1, h)
    const xs = kn.linspace(-1, 1, w)
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { gx[y * w + x] = xs[x]!; gy[y * w + x] = ys[y]! }
    }
    return { gx, gy }
  }

  /** _lens.focal_compression: a depth-scaled resample about the tapped point; 0 is the picture as it is. */
  function focalCompression(img: Tensor, depth: Tensor, fl: number, cx0: number, cy0: number, stop: Stop): Tensor {
    if (Math.abs(fl) < 1e-6) return img
    const { gx, gy } = unitGrid(img.h, img.w)
    const cx = f(cx0 * 2 - 1)
    const cy = f(cy0 * 2 - 1)
    const s = f(fl * FC_SCALE)
    const sx = new Float32Array(gx.length)
    const sy = new Float32Array(gx.length)
    for (let i = 0; i < gx.length; i++) {
      const far = kn.clamp01(f(1 - depth.data[i]!))
      const kk = f(1 - f(far * s))
      sx[i] = f(f(f(gx[i]! - cx) * kk) + cx)
      sy[i] = f(f(f(gy[i]! - cy) * kk) + cy)
    }
    return clamped(kn.gridSample(img, sx, sy, { padding: 'border', alignCorners: true, oh: img.h, ow: img.w }, stop), stop)
  }

  /**
   * bokeh_kernel's mask as row spans: for each of its 2r + 1 rows, the half
   * width a of the taps it keeps (−1: none), and the kernel's float32 tap
   * (1 / its tap count). The masks are torch's float32 tests, tap by tap.
   */
  function kernelRows(shape: string, r: number): { half: Int32Array; tap: number } {
    const half = new Int32Array(2 * r + 1).fill(-1)
    let count = 0
    for (let j = 0; j <= 2 * r; j++) {
      const yy = j - r
      for (let i = 0; i <= 2 * r; i++) {
        const xx = i - r
        let inside: boolean
        if (shape === 'anamorphic') {
          const a = f(xx / ANAMORPHIC)
          const b = f(yy * ANAMORPHIC)
          inside = f(f(a * a) + f(b * b)) <= r * r
        }
        else if (shape === 'hexagonal') {
          inside = Math.abs(yy) <= r && f(f(Math.abs(xx) * SQRT3_2) + Math.abs(yy) * 0.5) <= r
        }
        else inside = xx * xx + yy * yy <= r * r
        if (inside) {
          count++
          // The masks are symmetric and convex along a row: the farthest kept tap is the half width.
          if (Math.abs(xx) > half[j]!) half[j] = Math.abs(xx)
        }
      }
    }
    return { half, tap: count > 0 ? f(1 / count) : 1 }
  }

  /** A reflected index into [0, n) (F.pad reflect: the edge is not repeated). */
  const reflectIndex = (i: number, n: number) => (i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i)

  /**
   * _lens._blur: radius below 0.5 is the picture as it is; else the shape's
   * kernel at max(1, round(radius)) over the reflect-padded picture (torch
   * refuses a pad of the picture's side or more: Python raises there too).
   */
  function blur(src: Tensor, shape: string, radius: number, stop: Stop): Tensor {
    if (radius < 0.5) return src
    const r = Math.max(1, pyRound(radius))
    if (r >= src.h || r >= src.w) throw new Error(k.EFFECT_ERRORS.tooSmall)
    const { half, tap } = kernelRows(shape, r)
    const { w, h } = src
    const n = w * h
    const wp = w + 2 * r
    const rowsN = 2 * r + 1
    const out = k.tensor(src.c, h, w)
    // The reflect-padded columns of a row, once.
    const colOf = new Int32Array(wp)
    for (let x = 0; x < wp; x++) colOf[x] = reflectIndex(x - r, w)
    // A ring of prefix sums: padded row j sits at slot j mod (2r + 1).
    const ring = new Float64Array(rowsN * (wp + 1))
    for (let c = 0; c < src.c; c++) {
      const plane = src.data.subarray(c * n, (c + 1) * n)
      const fill = (j: number) => {
        const sy = reflectIndex(j - r, h)
        const row = plane.subarray(sy * w, (sy + 1) * w)
        const o = (j % rowsN) * (wp + 1)
        let acc = 0
        ring[o] = 0
        for (let x = 0; x < wp; x++) { acc += row[colOf[x]!]!; ring[o + x + 1] = acc }
      }
      for (let j = 0; j < 2 * r; j++) fill(j)
      const dst = out.data.subarray(c * n, (c + 1) * n)
      for (let y = 0; y < h; y++) {
        if (stop && (y & 63) === 0 && stop()) throw new Error('Stopped')
        fill(y + 2 * r)
        for (let x = 0; x < w; x++) {
          let sum = 0
          for (let dy = 0; dy < rowsN; dy++) {
            const a = half[dy]!
            if (a < 0) continue
            const o = ((y + dy) % rowsN) * (wp + 1)
            sum += ring[o + x + r + a + 1]! - ring[o + x + r - a]!
          }
          dst[y * w + x] = f(sum * tap)
        }
      }
    }
    return out
  }

  /** _lens.render_dof: the five-level CoC pyramid, the highlight boost on the blurred levels, tent weights, clamped. */
  function renderDof(img: Tensor, coc: Float32Array, shape: string, highlight: number, stop: Stop): Tensor {
    const n = img.w * img.h
    let src = img
    if (highlight > 0) {
      const lum = channelMean(img)
      for (let i = 0; i < n; i++) lum.data[i] = kn.clamp01(lum.data[i]!)
      const cube = kn.powScalar(lum, 3)
      const hb = f(highlight)
      src = map(img, stop, (v, _c, i) => f(v * f(1 + f(f(cube.data[i]! * hb) * 3))))
    }
    let maxR = -Infinity
    for (let i = 0; i < n; i++) if (coc[i]! > maxR) maxR = coc[i]!
    if (!(maxR >= 0.5)) return clamped(img, stop)
    const out = k.tensor(img.c, img.h, img.w)
    const cf = new Float32Array(n)
    for (let i = 0; i < n; i++) cf[i] = f(f(coc[i]! / maxR) * (LEVELS - 1))
    for (let level = 0; level < LEVELS; level++) {
      const radius = (maxR * level) / (LEVELS - 1)
      const p = blur(level === 0 ? img : src, shape, radius, stop)
      for (let i = 0; i < n; i++) {
        const wgt = kn.clamp01(f(1 - Math.abs(f(cf[i]! - level))))
        for (let c = 0; c < img.c; c++) {
          const at = c * n + i
          out.data[at] = level === 0 ? f(p.data[at]! * wgt) : f(out.data[at]! + f(p.data[at]! * wgt))
        }
      }
    }
    return clamped(out, stop)
  }

  /** _lens.chromatic_aberration: red sampled outward, blue inward, by a radial scale; the rest as it is. */
  function chromatic(img: Tensor, amount: number, stop: Stop): Tensor {
    if (amount <= 0) return img
    const { gx, gy } = unitGrid(img.h, img.w)
    const a = amount * CA_SCALE
    const out: Tensor = { c: img.c, h: img.h, w: img.w, data: new Float32Array(img.data) }
    const n = img.w * img.h
    for (const [ch, scale] of [[0, 1 + a], [2, 1 - a]] as const) {
      if (ch >= img.c) continue
      const s = f(scale)
      const sx = new Float32Array(n)
      const sy = new Float32Array(n)
      for (let i = 0; i < n; i++) { sx[i] = f(gx[i]! * s); sy[i] = f(gy[i]! * s) }
      const one: Tensor = { c: 1, h: img.h, w: img.w, data: img.data.subarray(ch * n, (ch + 1) * n) }
      const sampled = kn.gridSample(one, sx, sy, { padding: 'border', alignCorners: true, oh: img.h, ow: img.w }, stop)
      out.data.set(sampled.data, ch * n)
    }
    return clamped(out, stop)
  }

  /** _lens.vignette: 1 − amount · r² (r the clamped radius from the centre), clamped. */
  function vignette(img: Tensor, amount: number, stop: Stop): Tensor {
    if (amount <= 0) return img
    const { gx, gy } = unitGrid(img.h, img.w)
    const m = f(Math.min(amount, 1))
    const n = img.w * img.h
    const mask = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const r = kn.clamp01(f(Math.sqrt(f(f(gx[i]! * gx[i]!) + f(gy[i]! * gy[i]!)))))
      mask[i] = f(1 - f(f(r * r) * m))
    }
    return map(img, stop, (v, _c, i) => kn.clamp01(f(v * mask[i]!)))
  }

  /**
   * LensBlur (nodes_lens.py:59-117) on the first picture. Params (the main
   * thread's reading, cards/lensBlur.ts): `fx`, `fy` the focus point as
   * Python reads its text (the centre where Python fails on it), and the
   * widgets. Inputs: `image` (absent: no picture), `depth` (a picture wired
   * in) or `depthRaw` (the model's raw answer; absent on a 1 × 1 picture,
   * whose normalised depth is 0 whatever the model says).
   */
  function LensBlur(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const img = inp.image
    if (!img) return { outputs: [k.tensor(3, 16, 16)], preview: null }
    const { w, h } = img
    const depth = inp.depth ? wiredDepth(inp.depth, h, w)
      : inp.depthRaw ? modelDepth(inp.depthRaw, h, w, stop)
        : k.tensor(1, h, w)
    const fx = p.fx as number
    const fy = p.fy as number
    const px = Math.min(w - 1, Math.max(0, Math.trunc(fx * w)))
    const py = Math.min(h - 1, Math.max(0, Math.trunc(fy * h)))
    const focus = Math.max(0, Math.min(1, depth.data[py * w + px]! + (p.focus_offset as number)))
    let result = focalCompression(img, depth, p.focal_length as number, fx, fy, stop)
    const n = w * h
    const coc = new Float32Array(n)
    const f32focus = f(focus)
    const ap = f(p.aperture as number)
    for (let i = 0; i < n; i++) coc[i] = f(f(Math.abs(f(depth.data[i]! - f32focus)) * ap) * MAX_RADIUS)
    result = renderDof(result, coc, p.bokeh_shape as string, p.highlight_bokeh as number, stop)
    result = chromatic(result, p.chromatic_aberration as number, stop)
    result = vignette(result, p.vignette as number, stop)
    return { outputs: [result], preview: null }
  }

  return { LensBlur, kernelRows, blur }
}

export type LensCore = ReturnType<typeof lensCore>
