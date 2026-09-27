/**
 * Geometry and coordinate warps (family `effects-warp`, step 3 R2.7): Crop,
 * Resize, Rotate, Flip (nodes_geometry.py); Pinch, Twirl, Wave, Lens
 * correction (nodes_distortion.py); Kaleidoscope, Polar coordinates, Fisheye
 * (nodes_glsl_distortion.py); Chromatic aberration, CRT (nodes_glsl_lens.py);
 * Mirror (nodes_glsl_unicorn.py); God rays (nodes_glsl_atmosphere.py). Built
 * on R2.2's linspace, grid_sample, affine_grid, the resizes (with torch's
 * scale_factor path, R2.7) and remainder.
 *
 * SELF-CONTAINED apart from its arguments (the tensor core and the kernels),
 * as ../../pixels/core.ts is: the compositor worker composes it from its
 * source text. Do not reference anything from outside this body but `k` and
 * `kn`.
 *
 * Each op takes the node's tensors by input name, its widgets as ComfyUI's
 * validation converted them, a Stop check, the effect's batch state, and the
 * picture's index in the batch Python worked on and that batch's size.
 * FLOAT32, OP BY OP as torch: every product, sum and difference rounded, a
 * Python double scalar rounded to float32 once where it meets a tensor (a
 * comparison too), and a Python expression of scalars worked out in double
 * first.
 *
 * Parity (R2 rule 10): Crop, Resize, Rotate, Flip, Lens correction,
 * Chromatic aberration, Mirror and God rays are EXACT (float32 bit for bit).
 * Pinch (pow), Twirl, Wave, Kaleidoscope, Polar coordinates, Fisheye and CRT
 * (sin, cos, tan, atan2) are LIBRARY.
 *
 * The last `.clamp(0, 1)`: torch's vector loop turns −0 into +0, its scalar
 * tails keep it. Where they fall depends on how the clamped tensor sits in
 * memory (`clampOut`): a contiguous (B, H, W, C) picture, a grid_sample's
 * (B, C, H, W) result, or Crop's slice (rows of the slice, each its own loop).
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined

/**
 * How the tensor the node clamps last sits in torch's memory:
 *   'bhwc' — contiguous (B, H, W, C) (a clone, a flip, a resize's channels-last result);
 *   'nchw' — contiguous (B, C, H, W) (a grid_sample's or a torch.cat's result);
 *   crop   — a slice [:, y0:y1, x0:x1, :] of a contiguous (B, h, w, C) picture.
 */
type ClampLayout = 'bhwc' | 'nchw' | { crop: { fullH: number; fullW: number } }

export function warpCore(k: TensorCore, kn: KernelsCore) {
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

  /** math.radians: x · (π / 180), in double. */
  const radians = (deg: number) => deg * (Math.PI / 180)

  /**
   * Whether value `m` (its index in the clamped tensor's memory order) falls
   * in a scalar tail of torch's element loop: the range is cut into OpenMP
   * chunks above 32,768 values (kernels.ts inScalarTail), and each chunk is
   * walked in runs of `run` values (a contiguous row of the iteration; the
   * whole tensor when it is contiguous), each run's last len mod 8 values one
   * by one. There std::max(−0, 0) keeps −0.
   */
  function inTail(m: number, total: number, run: number): boolean {
    let cs = 0
    let ce = total
    if (total > kn.GRAIN && kn.TORCH_THREADS > 1) {
      const tasks = Math.min(kn.TORCH_THREADS, Math.ceil(total / kn.GRAIN))
      const chunk = Math.ceil(total / tasks)
      cs = Math.floor(m / chunk) * chunk
      ce = Math.min(total, cs + chunk)
    }
    const r0 = Math.floor(m / run) * run
    const start = Math.max(cs, r0)
    const len = Math.min(ce, r0 + run) - start
    return m - start >= len - (len % (2 * kn.TORCH_VEC))
  }

  /**
   * The node's last `.clamp(0, 1)`, in place: −0 kept only in the scalar
   * tails of torch's loop over the clamped tensor (ClampLayout), +0
   * elsewhere; NaN stays NaN.
   */
  function clampOut(t: Tensor, stop: Stop, index: number, count: number, layout: ClampLayout): Tensor {
    const n = t.w * t.h
    const C = t.c
    const total = count * n * C
    const d = t.data
    // The run of contiguous values torch's loop walks, and each value's place in memory.
    let run = total
    let mem: (c: number, i: number) => number
    if (layout === 'nchw') mem = (c, i) => index * n * C + c * n + i
    else {
      mem = (c, i) => index * n * C + i * C + c
      if (typeof layout === 'object') {
        const { fullH, fullW } = layout.crop
        if (t.w !== fullW) run = t.w * C
        else if (t.h !== fullH && count > 1) run = n * C
      }
    }
    k.rows(t.h, stop, (y) => {
      for (let i = y * t.w, end = i + t.w; i < end; i++) {
        for (let c = 0; c < C; c++) {
          const v = d[c * n + i]!
          d[c * n + i] = Object.is(v, -0) && inTail(mem(c, i), total, run) ? -0 : kn.clamp01(v)
        }
      }
    })
    return t
  }

  /** A copy of a picture, clamped as the node clamps it last. */
  const clampedCopy = (x: Tensor, stop: Stop, index: number, count: number, layout: ClampLayout = 'bhwc') =>
    clampOut({ c: x.c, h: x.h, w: x.w, data: new Float32Array(x.data) }, stop, index, count, layout)

  /**
   * `_base_grid` / `_grid`: torch.meshgrid(linspace(−1, 1, h), linspace(−1,
   * 1, w), indexing='ij') as the (x, y) planes, h × w each.
   */
  function baseGrid(h: number, w: number): { xx: Float32Array; yy: Float32Array; xs: Float32Array; ys: Float32Array } {
    const xs = kn.linspace(-1, 1, w)
    const ys = kn.linspace(-1, 1, h)
    const xx = new Float32Array(h * w)
    const yy = new Float32Array(h * w)
    for (let y = 0; y < h; y++) {
      xx.set(xs, y * w)
      yy.fill(ys[y]!, y * w, (y + 1) * w)
    }
    return { xx, yy, xs, ys }
  }

  /** A per-pixel map over the grid, with a Stop check every 64 rows. */
  function perPixel(h: number, w: number, stop: Stop, each: (i: number) => void): void {
    k.rows(h, stop, (y) => { for (let i = y * w, end = i + w; i < end; i++) each(i) })
  }

  /** `_sample`: F.grid_sample(mode='bilinear', align_corners=False) of the picture at the grid (x, y). */
  const sample = (t: Tensor, gx: Float32Array, gy: Float32Array, padding: 'zeros' | 'border', stop: Stop) =>
    kn.gridSample(t, gx, gy, { padding, alignCorners: false, oh: t.h, ow: t.w }, stop)

  /** One channel of a picture as a 1-channel tensor (a view: t[:, i:i+1]). */
  const channel = (t: Tensor, i: number): Tensor => ({ c: 1, h: t.h, w: t.w, data: t.data.subarray(i * t.h * t.w, (i + 1) * t.h * t.w) })

  /** torch.cat along channels. */
  function cat(parts: Tensor[]): Tensor {
    const t0 = parts[0]!
    const out = k.tensor(parts.reduce((s, p) => s + p.c, 0), t0.h, t0.w)
    let o = 0
    for (const p of parts) { out.data.set(p.data, o); o += p.data.length }
    return out
  }

  /** r = sqrt(xx·xx + yy·yy), op by op. */
  function radius(xx: Float32Array, yy: Float32Array, h: number, w: number, stop: Stop): Float32Array {
    const r = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => { r[i] = f(Math.sqrt(f(f(xx[i]! * xx[i]!) + f(yy[i]! * yy[i]!)))) })
    return r
  }

  /** float32 sin / cos / tan / atan2, in double, rounded once (kernels.ts unary: LIBRARY). */
  const sin32 = (x: number) => f(Math.sin(x))
  const cos32 = (x: number) => f(Math.cos(x))

  /** A grid warp's result: sampled, then clamped as a (B, C, H, W) result. */
  const warped = (t: Tensor, gx: Float32Array, gy: Float32Array, padding: 'zeros' | 'border', stop: Stop, index: number, count: number): EffectResult =>
    ({ outputs: [clampOut(sample(t, gx, gy, padding, stop), stop, index, count, 'nchw')], preview: null })

  // ── nodes_geometry.py ───────────────────────────────────────────────────

  /**
   * Crop (nodes_geometry.py:34-41): x0 = int(left·w), x1 = max(x0 + 1,
   * int(w − right·w)), the same down the side (doubles, truncated); the
   * slice, clamped. EXACT.
   */
  function CropImage(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const box = cropBox(x.w, x.h, p)
    const ow = box.x1 - box.x0
    const oh = box.y1 - box.y0
    const out = k.tensor(x.c, oh, ow)
    const n = x.w * x.h
    const on = ow * oh
    k.rows(oh, stop, (y) => {
      for (let c = 0; c < x.c; c++) {
        const s = c * n + (box.y0 + y) * x.w + box.x0
        out.data.set(x.data.subarray(s, s + ow), c * on + y * ow)
      }
    })
    return { outputs: [clampOut(out, stop, index, count, { crop: { fullH: x.h, fullW: x.w } })], preview: null }
  }

  /** Crop's box from the picture's size and its widgets. */
  function cropBox(w: number, h: number, p: Params): { x0: number; x1: number; y0: number; y1: number } {
    const x0 = Math.trunc((p.left as number) * w)
    const x1 = Math.max(x0 + 1, Math.trunc(w - (p.right as number) * w))
    const y0 = Math.trunc((p.top as number) * h)
    const y1 = Math.max(y0 + 1, Math.trunc(h - (p.bottom as number) * h))
    return { x0, x1: Math.min(x1, w), y0, y1: Math.min(y1, h) }
  }

  /**
   * Resize (nodes_geometry.py:62-72): scale 1 is a clamp; otherwise
   * F.interpolate(scale_factor=scale) of the permuted (channels-last)
   * picture: floor(side · scale) each side, and for bilinear, bicubic and
   * nearest the source step f32(1 / scale) (torch's `scales`; kernels.ts
   * stepOf), for area an adaptive average pool to that size. A side of 0
   * pixels: torch raises. The channels-last result permuted back is
   * contiguous. EXACT.
   */
  function ResizeImage(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const scale = p.scale as number
    if (scale === 1) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const oh = kn.areaOutSize(x.h, scale)
    const ow = kn.areaOutSize(x.w, scale)
    if (oh < 1 || ow < 1) throw new Error(ERR.tooSmall)
    const scales: [number, number] = [scale, scale]
    let out: Tensor
    stopNow(stop)
    switch (p.mode) {
      case 'bicubic': out = kn.resizeBicubic(x, oh, ow, stop, scales); break
      case 'nearest': out = kn.resizeNearest(x, oh, ow, scales); break
      case 'area': out = kn.resizeArea(x, oh, ow, { cl: true, batch: count, index, stop }); break
      default: out = kn.resizeBilinear(x, oh, ow, true, scales)
    }
    stopNow(stop)
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  /**
   * Rotate (nodes_geometry.py:93-108): angle 0 is a clamp; otherwise θ =
   * [[cos, −sin, 0], [sin, cos, 0]] (Python doubles, float32 in the tensor),
   * F.affine_grid (align_corners=False) and grid_sample with zeros outside.
   * affine_grid's base grid is linspace(−1, 1, n)·(n − 1) / n, and its
   * matrix product (Accelerate's sgemm) is, per value, fma(y, θ₁, x·θ₀)
   * then + θ₂ — measured bit for bit against torch (R2.7 report), so here
   * EXACT (kernels.ts affineGrid, a double product, stays the library one).
   */
  function RotateImage(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const angle = p.angle as number
    if (angle === 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const rad = radians(angle)
    const ca = k.s32(Math.cos(rad))
    const sa = k.s32(Math.sin(rad))
    const { h, w } = x
    const base = (n: number) => {
      if (n <= 1) return new Float32Array(1)
      const r = kn.linspace(-1, 1, n)
      for (let i = 0; i < n; i++) r[i] = f(f(r[i]! * (n - 1)) / n)
      return r
    }
    const bx = base(w)
    const by = base(h)
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    // Row 0 of θ: (cos, −sin, 0); row 1: (sin, cos, 0). The + 0 turns −0 to +0.
    const nsa = -sa
    perPixel(h, w, stop, (i) => {
      const X = bx[i % w]!
      const Y = by[Math.floor(i / w)]!
      gx[i] = f(kn.fmaf(Y, nsa, f(X * ca)) + 0)
      gy[i] = f(kn.fmaf(Y, ca, f(X * sa)) + 0)
    })
    return warped(x, gx, gy, 'zeros', stop, index, count)
  }

  /** Flip (nodes_geometry.py:128-139): torch.flip over H (vertical) and / or W (horizontal), clamped. EXACT. */
  function FlipImage(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const hz = !!p.horizontal
    const vt = !!p.vertical
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    k.rows(x.h, stop, (y) => {
      const sy = vt ? x.h - 1 - y : y
      for (let c = 0; c < x.c; c++) {
        const s = c * n + sy * x.w
        const o = c * n + y * x.w
        for (let xi = 0; xi < x.w; xi++) out.data[o + xi] = x.data[s + (hz ? x.w - 1 - xi : xi)]!
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  // ── nodes_distortion.py ─────────────────────────────────────────────────

  /**
   * Pinch (nodes_distortion.py:48-60): amount 0 is a clamp; r =
   * sqrt(x² + y²).clamp(1e-6, 1.4142), r.pow(1 + amount) (torch's special
   * exponents exact, any other a library pow), scale (new_r / r).clamp(0, 4),
   * the grid scaled, sampled with border padding. LIBRARY (pow).
   */
  function Pinch(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amount = p.amount as number
    if (amount === 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const lo = k.s32(1e-6)
    const hi = k.s32(1.4142)
    const r = radius(xx, yy, h, w, stop)
    for (let i = 0; i < r.length; i++) r[i] = Math.min(Math.max(r[i]!, lo), hi)
    stopNow(stop)
    const nr = kn.powScalar({ c: 1, h, w, data: r }, 1.0 + amount).data
    stopNow(stop)
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => {
      const s = Math.min(Math.max(f(nr[i]! / r[i]!), 0), 4)
      gx[i] = f(xx[i]! * s)
      gy[i] = f(yy[i]! * s)
    })
    return warped(x, gx, gy, 'border', stop, index, count)
  }

  /**
   * Twirl (nodes_distortion.py:84-97): angle 0 is a clamp; r = sqrt(x² + y²),
   * falloff (1 − r.clamp(0, 1))² (x·x), θ = radians(angle)·falloff, the grid
   * turned by θ, border padding. LIBRARY (cos, sin).
   */
  function Twirl(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const angle = p.angle as number
    if (angle === 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const r = radius(xx, yy, h, w, stop)
    const rad = k.s32(radians(angle))
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => {
      const a = f(1 - Math.min(Math.max(r[i]!, 0), 1))
      const theta = f(rad * f(a * a))
      const c = cos32(theta)
      const s = sin32(theta)
      gx[i] = f(f(xx[i]! * c) - f(yy[i]! * s))
      gy[i] = f(f(xx[i]! * s) + f(yy[i]! * c))
    })
    return warped(x, gx, gy, 'border', stop, index, count)
  }

  /**
   * Wave (nodes_distortion.py:122-135): amplitude ≤ 0 is a clamp; k = 2π /
   * max(0.01, wavelength) (double); dx = amplitude·sin(k·y) (horizontal,
   * both), dy = amplitude·sin(k·x) (vertical, both), border padding.
   * LIBRARY (sin).
   */
  function Wave(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amplitude = p.amplitude as number
    if (amplitude <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const kk = k.s32(2.0 * Math.PI / Math.max(0.01, p.wavelength as number))
    const amp = k.s32(amplitude)
    const axis = p.axis as string
    const across = axis === 'horizontal' || axis === 'both'
    const down = axis === 'vertical' || axis === 'both'
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => {
      gx[i] = across ? f(xx[i]! + f(amp * sin32(f(kk * yy[i]!)))) : f(xx[i]! + 0)
      gy[i] = down ? f(yy[i]! + f(amp * sin32(f(kk * xx[i]!)))) : f(yy[i]! + 0)
    })
    return warped(x, gx, gy, 'border', stop, index, count)
  }

  /**
   * Lens correction (nodes_distortion.py:158-168): distortion 0 is a clamp;
   * factor = 1 + distortion·(x² + y²), the grid scaled, border padding. EXACT.
   */
  function LensCorrection(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const distortion = p.distortion as number
    if (distortion === 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const d = k.s32(distortion)
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => {
      const r2 = f(f(xx[i]! * xx[i]!) + f(yy[i]! * yy[i]!))
      const factor = f(1 + f(d * r2))
      gx[i] = f(xx[i]! * factor)
      gy[i] = f(yy[i]! * factor)
    })
    return warped(x, gx, gy, 'border', stop, index, count)
  }

  // ── nodes_glsl_distortion.py ────────────────────────────────────────────

  /**
   * Kaleidoscope (nodes_glsl_distortion.py:47-62): θ = atan2(y, x), r =
   * sqrt(x² + y²); seg = 2π / segments; θ = (θ + radians(rotation)) % seg
   * (torch.remainder), folded where it passes seg / 2 to seg − θ; the grid
   * (r cos θ, r sin θ), border padding. LIBRARY (atan2, cos, sin).
   */
  function Kaleidoscope(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const r = radius(xx, yy, h, w, stop)
    const seg = 2.0 * Math.PI / (p.segments as number)
    const segF = k.s32(seg)
    const halfF = k.s32(seg / 2)
    const rot = k.s32(radians(p.rotation as number))
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => {
      let th = f(f(Math.atan2(yy[i]!, xx[i]!)) + rot)
      let m = f(th % segF)
      if (m !== 0 && (segF < 0) !== (m < 0)) m = f(m + segF)
      th = m > halfF ? f(segF - m) : m
      gx[i] = f(r[i]! * cos32(th))
      gy[i] = f(r[i]! * sin32(th))
    })
    return warped(x, gx, gy, 'border', stop, index, count)
  }

  /**
   * Polar coordinates (nodes_glsl_distortion.py:83-100): rect_to_polar
   * samples at (atan2(y, x) / π, r.clamp(0, 1)·2 − 1); polar_to_rect at
   * (r cos θ, r sin θ) with θ = x·π and r = (y + 1)·0.5. Border padding.
   * LIBRARY (atan2, cos, sin).
   */
  function PolarCoords(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const pi = k.s32(Math.PI)
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    if (p.direction === 'polar_to_rect') {
      perPixel(h, w, stop, (i) => {
        const theta = f(xx[i]! * pi)
        const r = f(f(yy[i]! + 1) * 0.5)
        gx[i] = f(r * cos32(theta))
        gy[i] = f(r * sin32(theta))
      })
    }
    else {
      perPixel(h, w, stop, (i) => {
        const r = Math.min(Math.max(f(Math.sqrt(f(f(xx[i]! * xx[i]!) + f(yy[i]! * yy[i]!)))), 0), 1)
        const theta = f(Math.atan2(yy[i]!, xx[i]!))
        gx[i] = f(theta / pi)
        gy[i] = f(f(r * 2) - 1)
      })
    }
    return warped(x, gx, gy, 'border', stop, index, count)
  }

  /**
   * Fisheye (nodes_glsl_distortion.py:164-176): amount ≤ 0 is a clamp; r =
   * sqrt(x² + y²).clamp(min=1e-6), new_r = tan(r·amount) / max(1e-6,
   * tan(amount)) (the divisor a Python double), the grid scaled by new_r / r,
   * zeros outside. LIBRARY (tan).
   */
  function Fisheye(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amount = p.amount as number
    if (amount <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { h, w } = x
    const { xx, yy } = baseGrid(h, w)
    const r = radius(xx, yy, h, w, stop)
    const lo = k.s32(1e-6)
    const a = k.s32(amount)
    const div = k.s32(Math.max(1e-6, Math.tan(amount)))
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    perPixel(h, w, stop, (i) => {
      const ri = Math.max(r[i]!, lo)
      const nr = f(f(Math.tan(f(ri * a))) / div)
      const s = f(nr / ri)
      gx[i] = f(xx[i]! * s)
      gy[i] = f(yy[i]! * s)
    })
    return warped(x, gx, gy, 'zeros', stop, index, count)
  }

  // ── nodes_glsl_lens.py ──────────────────────────────────────────────────

  /**
   * Each of the first three channels sampled on its own at the grid scaled
   * by (1 − amount, 1, 1 + amount), border padding, and put back together:
   * three channels (a fourth is dropped). ChromaticAberration's and CRT's
   * chroma step.
   */
  function chroma(t: Tensor, amount: number, xx: Float32Array, yy: Float32Array, stop: Stop): Tensor {
    const scales = [k.s32(1.0 - amount), 1, k.s32(1.0 + amount)]
    const n = t.w * t.h
    const parts: Tensor[] = []
    for (let i = 0; i < 3; i++) {
      const s = scales[i]!
      const gx = new Float32Array(n)
      const gy = new Float32Array(n)
      perPixel(t.h, t.w, stop, (j) => { gx[j] = f(xx[j]! * s); gy[j] = f(yy[j]! * s) })
      parts.push(sample(channel(t, i), gx, gy, 'border', stop))
    }
    return cat(parts)
  }

  /**
   * Chromatic aberration (nodes_glsl_lens.py:48-60): amount ≤ 0 is a clamp;
   * otherwise the chroma step: three channels out. EXACT.
   */
  function ChromaticAberration(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amount = p.amount as number
    if (amount <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { xx, yy } = baseGrid(x.h, x.w)
    return { outputs: [clampOut(chroma(x, amount, xx, yy, stop), stop, index, count, 'nchw')], preview: null }
  }

  /**
   * CRT (nodes_glsl_lens.py:130-165), in order: a barrel (factor 1 +
   * curvature·r², border padding); the chroma step (three channels); the
   * scanlines, 1 − scanlines·|sin(arange(h)·3.14159)| per row; the RGB
   * stripes, t·(1 − rgb_mask) + (t·stripe·3)·rgb_mask, stripe the column's
   * x mod 3 channel — a 4-channel picture meets the 3-channel stripes there
   * and Python raises. LIBRARY (sin).
   */
  function CRT(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    let t = inp.image!
    const scan = p.scanlines as number
    const rgbMask = p.rgb_mask as number
    const chromaAmount = p.chroma as number
    const curvature = p.curvature as number
    // A 4-channel picture meets the 3-channel stripes: refused before the work.
    if (rgbMask > 0 && !(chromaAmount > 0) && t.c !== 3) throw new Error(ERR.needsRgb)
    let layout: ClampLayout = 'bhwc'
    const { xx, yy } = baseGrid(t.h, t.w)
    if (curvature > 0) {
      const cv = k.s32(curvature)
      const n = t.w * t.h
      const gx = new Float32Array(n)
      const gy = new Float32Array(n)
      perPixel(t.h, t.w, stop, (i) => {
        const factor = f(1 + f(cv * f(f(xx[i]! * xx[i]!) + f(yy[i]! * yy[i]!))))
        gx[i] = f(xx[i]! * factor)
        gy[i] = f(yy[i]! * factor)
      })
      t = sample(t, gx, gy, 'border', stop)
      layout = 'nchw'
    }
    else t = { c: t.c, h: t.h, w: t.w, data: new Float32Array(t.data) }
    if (chromaAmount > 0) {
      t = chroma(t, chromaAmount, xx, yy, stop)
      layout = 'nchw'
    }
    const { c: C, h, w } = t
    const n = h * w
    const d = t.data
    if (scan > 0) {
      const sc = k.s32(scan)
      const pi = k.s32(3.14159)
      const line = new Float32Array(h)
      for (let y = 0; y < h; y++) line[y] = f(1 - f(sc * Math.abs(sin32(f(y * pi)))))
      k.rows(h, stop, (y) => {
        for (let c = 0; c < C; c++) for (let i = c * n + y * w, end = i + w; i < end; i++) d[i] = f(d[i]! * line[y]!)
      })
    }
    if (rgbMask > 0) {
      const keep = k.s32(1.0 - rgbMask)
      const m = k.s32(rgbMask)
      k.rows(h, stop, (y) => {
        for (let c = 0; c < C; c++) {
          for (let xi = 0, i = c * n + y * w; xi < w; xi++, i++) {
            const v = d[i]!
            const striped = f(f(f(v * (xi % 3 === c ? 1 : 0)) * 3) * m)
            d[i] = f(f(v * keep) + striped)
          }
        }
      })
    }
    return { outputs: [clampOut(t, stop, index, count, layout)], preview: null }
  }

  // ── nodes_glsl_unicorn.py ───────────────────────────────────────────────

  /**
   * Where each output column (or row) of a half mirror comes from along one
   * axis of `size`: its own place, or the flipped half's source (Python's
   * slices, nodes_glsl_unicorn.py:253-291, kept literally).
   */
  function mirrorAxis(size: number, seam: number, fromStart: boolean): Int32Array {
    const src = new Int32Array(size)
    for (let i = 0; i < size; i++) src[i] = i
    const cut = Math.max(1, Math.min(size - 1, pyRound(seam * size)))
    if (fromStart) {
      // flipped = image[:cut] reversed: flipped[j] = cut − 1 − j (cut values).
      const fl = Math.min(cut, size)
      const rw = size - cut
      if (fl >= rw) for (let j = 0; j < rw; j++) src[cut + j] = cut - 1 - j
      else for (let j = 0; j < fl; j++) src[cut + j] = cut - 1 - j
    }
    else {
      // flipped = image[cut:] reversed: flipped[j] = size − 1 − j (size − cut values).
      const fl = Math.max(0, size - cut)
      const lw = cut
      if (fl >= lw) for (let j = 0; j < lw; j++) src[j] = size - 1 - (fl - lw + j)
      else for (let j = 0; j < fl; j++) src[lw - fl + j] = size - 1 - j
    }
    return src
  }

  /**
   * Mirror (nodes_glsl_unicorn.py:249-312): a half mirrored across the seam
   * (round(seam·side), kept within 1 … side − 1), or the quadrant modes: the
   * top-left (or the flipped top-right) h // 2 × w // 2 quadrant mirrored four
   * ways onto a zero picture, an odd side's last row or column left 0.
   * Clamped. EXACT.
   */
  function Mirror(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const { c: C, h, w } = x
    const n = h * w
    const mode = p.mode as string
    const seam = p.seam as number
    const out = k.tensor(C, h, w)
    let rowSrc: Int32Array
    let colSrc: Int32Array
    if (mode === 'quadrant_tl' || mode === 'quadrant_tr') {
      const hh = Math.floor(h / 2)
      const hw = Math.floor(w / 2)
      rowSrc = new Int32Array(h).fill(-1)
      colSrc = new Int32Array(w).fill(-1)
      // quad[y] = y; quad[x] = x (tl), or w − 1 − x (tr: image[:, w − hw:] flipped).
      const quadCol = (xi: number) => (mode === 'quadrant_tl' ? xi : w - 1 - xi)
      for (let y = 0; y < hh; y++) { rowSrc[y] = y; rowSrc[2 * hh - 1 - y] = y }
      for (let xi = 0; xi < hw; xi++) { colSrc[xi] = quadCol(xi); colSrc[2 * hw - 1 - xi] = quadCol(xi) }
    }
    else if (mode === 'top_to_bottom' || mode === 'bottom_to_top') {
      rowSrc = mirrorAxis(h, seam, mode === 'top_to_bottom')
      colSrc = new Int32Array(w).map((_v, i) => i)
    }
    else {
      rowSrc = new Int32Array(h).map((_v, i) => i)
      colSrc = mirrorAxis(w, seam, mode !== 'right_to_left')
    }
    k.rows(h, stop, (y) => {
      const sy = rowSrc[y]!
      for (let c = 0; c < C; c++) {
        const o = c * n + y * w
        if (sy < 0) continue
        const s = c * n + sy * w
        for (let xi = 0; xi < w; xi++) {
          const sx = colSrc[xi]!
          if (sx >= 0) out.data[o + xi] = x.data[s + sx]!
        }
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  // ── nodes_glsl_atmosphere.py ────────────────────────────────────────────

  /**
   * God rays (nodes_glsl_atmosphere.py:46-74): intensity ≤ 0 is a clamp;
   * otherwise the bright pixels (luma > threshold, the whole picture × the
   * mask), then `samples` grid_samples (zeros outside) toward the centre,
   * step s / samples · 0.5 of the way, each × the decay (a Python double,
   * × 0.92 a sample), summed, ÷ samples, × intensity, added to the picture,
   * clamped. EXACT.
   */
  function GodRays(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const intensity = p.intensity as number
    if (intensity <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { c: C, h, w } = x
    const n = h * w
    const luma = k.luma709(x, stop)
    const thr = k.s32(p.threshold as number)
    const bright = k.tensor(C, h, w)
    k.rows(h, stop, (y) => {
      for (let i = y * w, end = i + w; i < end; i++) {
        const m = luma[i]! > thr ? 1 : 0
        for (let c = 0; c < C; c++) bright.data[c * n + i] = f(x.data[c * n + i]! * m)
      }
    })
    const { xx, yy } = baseGrid(h, w)
    const cx = k.s32((p.center_x as number) * 2.0 - 1.0)
    const cy = k.s32((p.center_y as number) * 2.0 - 1.0)
    const dx = new Float32Array(n)
    const dy = new Float32Array(n)
    for (let i = 0; i < n; i++) { dx[i] = f(cx - xx[i]!); dy[i] = f(cy - yy[i]!) }
    const samples = Math.trunc(p.samples as number)
    const step = 1.0 / samples
    let decay = 1.0
    const accum = new Float32Array(C * n)
    const gx = new Float32Array(n)
    const gy = new Float32Array(n)
    for (let s = 0; s < samples; s++) {
      stopNow(stop)
      const fr = k.s32(s * step)
      perPixel(h, w, stop, (i) => {
        gx[i] = f(xx[i]! + f(f(dx[i]! * fr) * 0.5))
        gy[i] = f(yy[i]! + f(f(dy[i]! * fr) * 0.5))
      })
      const got = sample(bright, gx, gy, 'zeros', stop).data
      const dc = k.s32(decay)
      for (let i = 0; i < accum.length; i++) accum[i] = f(accum[i]! + f(got[i]! * dc))
      decay *= 0.92
    }
    const it = k.s32(intensity)
    const out = k.tensor(C, h, w)
    k.rows(h, stop, (y) => {
      for (let c = 0; c < C; c++) {
        for (let i = c * n + y * w, end = i + w; i < end; i++) out.data[i] = f(x.data[i]! + f(it * f(accum[i]! / samples)))
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  return {
    CropImage, ResizeImage, RotateImage, FlipImage,
    Pinch, Twirl, Wave, LensCorrection,
    Kaleidoscope, PolarCoords, Fisheye,
    ChromaticAberration, CRT, Mirror, GodRays,
  }
}

export type WarpCore = ReturnType<typeof warpCore>
