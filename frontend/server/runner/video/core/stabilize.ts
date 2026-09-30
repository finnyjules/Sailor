/**
 * Stabilize (step 3, R6.5; nodes_video_pro.py:956-1057): translation-only
 * stabilization by phase correlation, in two passes over the clip.
 *
 * SELF-CONTAINED apart from its arguments, as the other video cores are
 * (./time.ts): `tk` the tensors, `kn` R2.2's kernels, `ft` the shared FFT
 * (./fft.ts).
 *
 *   Pass 1 (`track`, one call a frame, in order): the frame's luma, averaged
 *   down by `scale` = max(1, max(H, W) // 256), times a Hann window
 *   (periodic=False) on both axes, and its 2-D transform. Against the frame
 *   before: R = F_cur·conj(F_prev), R / (|R| + 1e-8), the inverse's real
 *   part, its first highest place (argmax) as (dy, dx), wrapped past half,
 *   times `scale`. The transform is carried to the next frame as the op's
 *   state; the state also brings back the shift found (./stabilize.ts
 *   shiftOf).
 *
 *   Between (`corrections`, on the main thread): the camera path is the
 *   running sum of the shifts in doubles; smoothed s[i] = α·s[i − 1] +
 *   (1 − α)·p[i]; the correction is s − p.
 *
 *   Pass 2 (`warp`, one call a frame): each frame moved by −correction
 *   (affine_grid, grid_sample bilinear, border or zeros); `crop` takes the
 *   centred max(8, int(H·(1 − 2·pad))) × max(8, int(W·(1 − 2·pad))) and
 *   scales it back up to H × W (bilinear); clamped.
 *
 * Parity (the matching rule, USER 2026-09-30: a hard port need only look the
 * same): the transform runs in float64 where Python's is complex64, so a
 * shift can differ from Python's only where its two highest correlation
 * values are within rounding of each other (the fixture flags those cases).
 * The warp and the crop are R2.2's kernels, the grid in torch's measured
 * order (as Ken Burns', ./look.ts grid).
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { KernelsCore } from '../../effects/core/kernels'
import type { FftCore } from './fft'
import type { VideoOpResult } from './time'

/** The shift pass 1 found for a frame, from the state its call handed back: [dy, dx] (0, 0 for frame 0). */
export function shiftOf(state: ArrayBuffer | undefined): [number, number] {
  if (!state || state.byteLength < 16) throw new Error('Stabilize lost track of the frame before')
  const s = new Float64Array(state, 0, 2)
  return [s[0]!, s[1]!]
}

export function stabilizeCore(tk: TensorCore, kn: KernelsCore, ft: FftCore) {
  const f = Math.fround
  const L0 = f(0.2126)
  const L1 = f(0.7152)
  const L2 = f(0.0722)

  /** The downscale Python's pass 1 works at: max(1, max(H, W) // 256), and the pooled size. */
  function trackSize(h: number, w: number): { scale: number; th: number; tw: number } {
    const scale = Math.max(1, Math.floor(Math.max(h, w) / 256))
    return { scale, th: Math.floor(h / scale), tw: Math.floor(w / scale) }
  }

  /** torch.hann_window(n, periodic=False) in float32: 0.5 − 0.5·cos(2πk/(n − 1)); [1] for one point. */
  function hann(n: number): Float32Array {
    const out = new Float32Array(n)
    if (n === 1) { out[0] = 1; return out }
    for (let k = 0; k < n; k++) out[k] = f(0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)))
    return out
  }

  /** A frame's windowed, pooled luma (float32 values), as the transform's real part. */
  function tracked(x: Tensor): { re: Float64Array; th: number; tw: number; scale: number } {
    const { scale, th, tw } = trackSize(x.h, x.w)
    if (th < 1 || tw < 1) throw new Error('This clip is too small to stabilize')
    const n = x.h * x.w
    const d = x.data
    const lum = new Float32Array(n)
    for (let i = 0; i < n; i++) lum[i] = f(f(f(L0 * d[i]!) + f(L1 * d[n + i]!)) + f(L2 * d[2 * n + i]!))
    const wy = hann(th)
    const wx = hann(tw)
    const re = new Float64Array(th * tw)
    const area = scale * scale
    for (let y = 0; y < th; y++) {
      for (let xx = 0; xx < tw; xx++) {
        // avg_pool2d(kernel = stride = scale): the block's mean.
        let s = 0
        for (let dy = 0; dy < scale; dy++) {
          const row = (y * scale + dy) * x.w + xx * scale
          for (let dx = 0; dx < scale; dx++) s += lum[row + dx]!
        }
        re[y * tw + xx] = f(f(s / area) * f(wy[y]! * wx[xx]!))
      }
    }
    return { re, th, tw, scale }
  }

  /**
   * Pass 1, frame `index`: the frame's transform, carried as the state
   * (Float64Array [dy, dx, re…, im…]) with the shift found against the frame
   * before. Its picture is a placeholder (one black pixel): pass 1 makes no
   * frames.
   */
  function track(inputs: Tensor[], _p: Record<string, unknown>, state: ArrayBuffer | undefined, index: number): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    const { re, th, tw, scale } = tracked(x)
    const n = th * tw
    const im = new Float64Array(n)
    ft.fft2(re, im, th, tw)
    const next = new Float64Array(2 + 2 * n)
    next.set(re, 2)
    next.set(im, 2 + n)
    if (index > 0) {
      if (!state || state.byteLength !== next.byteLength) throw new Error('Stabilize lost track of the frame before')
      const prev = new Float64Array(state)
      const rr = new Float64Array(n)
      const ri = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const ar = re[i]!
        const ai = im[i]!
        const br = prev[2 + i]!
        const bi = -prev[2 + n + i]!
        const cr = ar * br - ai * bi
        const ci = ar * bi + ai * br
        const mag = Math.hypot(cr, ci) + 1e-8
        rr[i] = cr / mag
        ri[i] = ci / mag
      }
      ft.ifft2(rr, ri, th, tw)
      // torch.argmax: the first of the highest.
      let at = 0
      for (let i = 1; i < n; i++) if (rr[i]! > rr[at]!) at = i
      let dy = Math.floor(at / tw)
      let dx = at % tw
      if (dy > Math.floor(th / 2)) dy -= th
      if (dx > Math.floor(tw / 2)) dx -= tw
      next[0] = dy * scale
      next[1] = dx * scale
    }
    return { out: tk.tensor(3, 1, 1), state: next.buffer }
  }

  /**
   * Between the passes: each frame's correction (ty, tx) from the shifts
   * pass 1 found (frame 0's is (0, 0)), in doubles as numpy computes it.
   */
  function corrections(shifts: readonly (readonly [number, number])[], smoothing: number): [number, number][] {
    const out: [number, number][] = []
    const alpha = smoothing
    let py = 0
    let px = 0
    let sy = 0
    let sx = 0
    for (let i = 0; i < shifts.length; i++) {
      py += shifts[i]![0]
      px += shifts[i]![1]
      if (i === 0) { sy = py; sx = px }
      else {
        sy = alpha * sy + (1.0 - alpha) * py
        sx = alpha * sx + (1.0 - alpha) * px
      }
      out.push([sy - py, sx - px])
    }
    return out
  }

  /** affine_grid of [[1, 0, tx], [0, 1, ty]] (align_corners=False) in torch's measured order (./look.ts grid). */
  function grid(tx: number, ty: number, h: number, w: number): { gx: Float32Array; gy: Float32Array } {
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
    for (let yy = 0; yy < h; yy++) {
      const Y = by[yy]!
      const y0 = f(Y * 0)
      for (let xx = 0; xx < w; xx++) {
        const X = bx[xx]!
        gx[yy * w + xx] = f(f(f(X * 1) + y0) + tx)
        gy[yy * w + xx] = f(f(f(X * 0) + Y) + ty)
      }
    }
    return { gx, gy }
  }

  /** Python's slice [a:b] of n items: negatives count from the end, both clipped to [0, n]. */
  function pySlice(a: number, b: number, n: number): [number, number] {
    const norm = (v: number) => Math.min(n, Math.max(0, v < 0 ? v + n : v))
    const s = norm(a)
    return [s, Math.max(s, norm(b))]
  }

  /** Pass 2, one frame: moved by −(its correction), `_ty` and `_tx` (the plan's own params), cropped back up where asked, clamped. */
  function warp(inputs: Tensor[], p: Record<string, unknown>, _state: ArrayBuffer | undefined, _index: number, _count: number, stop?: () => boolean): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    const H = x.h
    const W = x.w
    const ty = p._ty as number
    const tx = p._tx as number
    if (!Number.isFinite(ty) || !Number.isFinite(tx)) throw new Error('Stabilize lost this frame’s correction')
    const g = grid(f(-tx / (W / 2.0)), f(-ty / (H / 2.0)), H, W)
    const crop = p.edge_mode !== 'border'
    let out = kn.gridSample(x, g.gx, g.gy, { padding: crop ? 'zeros' : 'border', alignCorners: false, oh: H, ow: W }, stop)
    if (crop) {
      const pad = p.crop_pad as number
      const ch = Math.max(8, Math.trunc(H * (1.0 - 2 * pad)))
      const cw = Math.max(8, Math.trunc(W * (1.0 - 2 * pad)))
      const y0 = Math.floor((H - ch) / 2)
      const x0 = Math.floor((W - cw) / 2)
      const [ya, yb] = pySlice(y0, y0 + ch, H)
      const [xa, xb] = pySlice(x0, x0 + cw, W)
      const oh = yb - ya
      const ow = xb - xa
      const cut = tk.tensor(3, oh, ow)
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < oh; y++) {
          const from = c * H * W + (ya + y) * W + xa
          cut.data.set(out.data.subarray(from, from + ow), c * oh * ow + y * ow)
        }
      }
      out = kn.resizeBilinear(cut, H, W)
    }
    const d = out.data
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!
      if (v < 0) d[i] = 0
      else if (v > 1) d[i] = 1
    }
    return { out }
  }

  return { trackSize, track, corrections, warp }
}

export type StabilizeCore = ReturnType<typeof stabilizeCore>
