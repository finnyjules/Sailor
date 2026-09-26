/**
 * The kernels the picture effects share (step 3, R2.2): sampling, pooling,
 * convolution and torchvision's colour operations, each proven on its own
 * against torch 2.10 / torchvision 0.25 (scripts/runner_effects_fixtures.py
 * --group kernels; tests/unit/runner-effects-kernels.unit.spec.ts).
 *
 * SELF-CONTAINED apart from its arguments (the tensor core and the pixels
 * core), as ../../pixels/core.ts is: the compositor worker composes it from
 * its source text (compositor/worker.ts workerScript). Do not reference
 * anything from outside this body but `k` and `px`.
 *
 * Each kernel is marked (R2 rule 10):
 *   EXACT   — float32 bit for bit with torch, op by op (Math.fround after
 *             every step; a fused multiply-add where torch's compiler fuses);
 *   LIBRARY — torch leaves the order or the rounding to library code (conv2d,
 *             exp / sin / pow…, a matrix product): the 8-bit output equals
 *             Python's except within a measured ε of a quantisation boundary.
 *
 * Torch's own structure is ported where it decides the float result: the
 * cascade sum of SumKernel.cpp (vectors of TORCH_VEC floats, four
 * accumulators, four levels) and how a long sum is split between threads
 * (OpenMP: min(threads, ⌈n / 32768⌉) chunks of equal size). Tensors are
 * planar C × H × W, one picture at a time. Where torch's float result depends
 * on how the picture sat in its tensor, the caller says so with a
 * TorchLayout: channels-last memory (a ComfyUI picture movedim'd) changes a
 * few sums and divisions; the batch changes long sums (one picture: split
 * between threads; two or more: each picture summed on one thread) and where
 * torch's element loops fall into their scalar tails (clamp's −0).
 */
import type { PixelsCore } from '../../pixels/core'
import type { Tensor, TensorCore } from './tensor'

/** How the picture sat in the torch tensor Python worked on (defaults: contiguous, a batch of one, this Mac's threads). */
export interface TorchLayout {
  /** Channels-last memory (a ComfyUI picture movedim'd to B × C × H × W without a copy). */
  cl?: boolean
  /** Pictures in the batch torch worked on at once. */
  batch?: number
  /** This picture's place in that batch. */
  index?: number
  /** torch.get_num_threads() of the Python being matched. */
  threads?: number
}

export function kernelsCore(k: TensorCore, px: PixelsCore) {
  const f = Math.fround
  const ERR = k.EFFECT_ERRORS

  /** Floats in a torch Vectorized<float> on this arm64 build (NEON, 128 bits). */
  const TORCH_VEC = 4
  /** at::internal::GRAIN_SIZE: below it torch reduces (and fills) on one thread. */
  const GRAIN = 32768
  /** The development Mac's torch thread count (the fixtures'); a machine with another count splits sums over 64k values differently. */
  const TORCH_THREADS = 6
  /** The widest blur proven within ε = 2⁻⁸ (every Python caller: σ ≤ 30, so ksize ≤ 181); (301, 50) measured outside it. */
  const GAUSSIAN_MAX_KSIZE = 181

  /** Plain words for settings torch refuses that no current caller makes (a guard, not a node message). */
  const KERNEL_MESSAGES = {
    poolPad: 'This window is padded by more than half its size',
    blurSize: 'A blur needs an odd width of at least 1 and a spread above 0',
    blurTooWide: 'This blur is wider than the runner can match (at most 181 pixels across)',
    convKernel: 'This filter’s weights are outside what the runner can match',
  } as const

  /**
   * The convolution kernels the R2 effects pass (R2.2 fix round 2), each
   * with its ε (255-scale): a real bound, at least twice the worst |Δ|
   * against torch measured over 20 fresh seeds per class on 400 × 400 × 3
   * pictures with values in [0, 1] and [−0.1, 1.1] (fixture `conv_sweep`):
   *   integer3   — 3 × 3, integer weights |w| ≤ 4: Sobel (FindEdges,
   *                HeightmapRelief, Outline), the laplacian (ReactionDiffusion),
   *                Emboss at depth 1. Worst 2.4 × 10⁻⁴; ε 2⁻¹⁰.
   *   scaled3    — 3 × 3, |w| ≤ 8: Emboss's kernel × depth (0…4). Worst
   *                9.7 × 10⁻⁴ (1.1 × 10⁻³ on a second 20-seed draw); ε 2⁻⁸.
   *   normalised — non-negative weights summing to 1 (within 10⁻⁴), odd sides
   *                up to 21: Blur's motion line (≤ 15) and Bokeh's disk (≤ 21).
   *                Worst 2.0 × 10⁻⁴ (2.1 × 10⁻⁴ on a second draw); ε 2⁻¹⁰.
   * Anything else (wide unnormalised kernels drift to 10⁻² against torch's
   * float sums; Sparkle's star is stamped by its family, not convolved here)
   * is refused with KERNEL_MESSAGES.convKernel. The bound holds for values of
   * picture size: the error scales with the values' magnitude.
   */
  const CONV_CLASS_EPS = { integer3: 2 ** -10, scaled3: 2 ** -8, normalised: 2 ** -10 } as const

  // ── Float32 helpers ─────────────────────────────────────────────────────

  const f32buf = new Float32Array(1)
  const i32buf = new Int32Array(f32buf.buffer)
  /** The float32 next to x (finite, nonzero-safe) towards +∞ (dir 1) or −∞ (dir −1). */
  function nextFloat(x: number, dir: 1 | -1): number {
    if (x === 0) return dir * 1.401298464324817e-45
    f32buf[0] = x
    i32buf[0] = i32buf[0]! + ((x > 0) === (dir > 0) ? 1 : -1)
    return f32buf[0]!
  }

  /**
   * fmaf(a, b, c): a·b + c rounded once to float32. a·b is exact in double;
   * the double sum may round, so a sum that lands exactly half-way between
   * two floats is settled by the sign of its rounding error.
   */
  function fmaf(a: number, b: number, c: number): number {
    const p = a * b
    const s = p + c
    const r = f(s)
    if (r === s || !Number.isFinite(s)) return r
    const z = s - p
    const err = (p - (s - z)) + (c - z)
    if (err === 0) return r
    const other = nextFloat(r, s > r ? 1 : -1)
    if (s - r !== other - s) return r
    return (err > 0) === (other > r) ? other : r
  }

  /** torch's vectorised clamp(x, 0, 1) (NEON max/min): −0 comes out +0, NaN stays NaN. */
  const clamp01 = (x: number) => (x > 0 ? (x > 1 ? 1 : x) : x === x ? 0 : x)

  /**
   * Whether element `m` of a contiguous `total`-element tensor falls in the
   * scalar tail of torch's element loop: the loop runs on OpenMP chunks
   * (above 32,768 values) and each chunk in pairs of vectors (2·TORCH_VEC),
   * its last len mod 8 values one by one. There std::max(−0, 0) keeps −0.
   */
  function inScalarTail(m: number, total: number, threads: number): boolean {
    let start = 0
    let len = total
    if (total > GRAIN && threads > 1) {
      const tasks = Math.min(threads, Math.ceil(total / GRAIN))
      const chunk = Math.ceil(total / tasks)
      start = Math.floor(m / chunk) * chunk
      len = Math.min(total, start + chunk) - start
    }
    return m - start >= len - (len % (2 * TORCH_VEC))
  }

  /** A picture's value (channel ch, pixel i) as its index in torch's memory for this layout. */
  function memoryIndex(t: { c: number; h: number; w: number }, ch: number, i: number, layout: TorchLayout): number {
    const per = t.c * t.h * t.w
    return (layout.index ?? 0) * per + (layout.cl ? i * t.c + ch : ch * t.h * t.w + i)
  }

  /** The threads a long sum over one picture is split between: its batch's pictures are each summed on one thread. */
  const sumThreads = (layout: TorchLayout) => ((layout.batch ?? 1) >= 2 ? 1 : layout.threads ?? TORCH_THREADS)

  function stopCheck(stop: (() => boolean) | undefined, y: number): void {
    if (stop && (y & 63) === 0 && stop()) throw new Error('Stopped')
  }

  // ── Sums (SumKernel.cpp cascade_sum) ────────────────────────────────────

  const ceilLog2 = (x: number) => (x <= 2 ? 1 : Math.floor(Math.log2(x - 1)) + 1)

  /**
   * row_sum over `n` elements of `lanes` independent floats (a scalar row:
   * lanes 1; a row of vectors: lanes TORCH_VEC): four accumulators over
   * element i·4 + j (multi_row_sum's four levels), the leftovers into the
   * first, then the four added in order. Returns each lane's sum. Every
   * accumulator is a Float32Array: storing the double sum of two floats
   * rounds it once, which is float32 addition exactly.
   */
  function rowSum(n: number, lanes: number, get: (i: number, lane: number) => number): Float32Array {
    const nrows = 4
    const size = Math.floor(n / nrows)
    const width = nrows * lanes
    const levels = 4
    const power = Math.max(4, Math.floor(ceilLog2(size) / levels))
    const step = 1 << power
    const mask = step - 1
    const acc = Array.from({ length: levels }, () => new Float32Array(width))
    let i = 0
    const addRow = (row: number) => {
      const a0 = acc[0]!
      for (let r = 0; r < nrows; r++) for (let l = 0; l < lanes; l++) { const q = r * lanes + l; a0[q] = a0[q]! + get(row * nrows + r, l) }
    }
    while (i + step <= size) {
      for (let j = 0; j < step; j++, i++) addRow(i)
      for (let j = 1; j < levels; j++) {
        const hi = acc[j]!
        const lo = acc[j - 1]!
        for (let q = 0; q < width; q++) { hi[q] = hi[q]! + lo[q]!; lo[q] = 0 }
        if ((i & (mask << (j * power))) !== 0) break
      }
    }
    for (; i < size; i++) addRow(i)
    const a0 = acc[0]!
    for (let j = 1; j < levels; j++) for (let q = 0; q < width; q++) a0[q] = a0[q]! + acc[j]![q]!
    // row_sum: the leftover elements into accumulator 0, then 1…3 added to it.
    const out = new Float32Array(lanes)
    for (let l = 0; l < lanes; l++) out[l] = a0[l]!
    for (let e = size * nrows; e < n; e++) for (let l = 0; l < lanes; l++) out[l] = out[l]! + get(e, l)
    for (let r = 1; r < nrows; r++) for (let l = 0; l < lanes; l++) out[l] = out[l]! + a0[r * lanes + l]!
    return out
  }

  /** The sum of `n` contiguous floats from `off`, as one row of torch's reduction (vectorized_inner_sum, or scalar_inner_sum when short). */
  function sumContiguous(d: Float32Array, off: number, n: number): number {
    if (n < TORCH_VEC) return f(0 + rowSum(n, 1, i => d[off + i]!)[0]!)
    const vecs = Math.floor(n / TORCH_VEC)
    const partial = rowSum(vecs, TORCH_VEC, (i, l) => d[off + i * TORCH_VEC + l]!)
    let acc = 0
    for (let i = vecs * TORCH_VEC; i < n; i++) acc = f(acc + d[off + i]!)
    for (let l = 0; l < TORCH_VEC; l++) acc = f(acc + partial[l]!)
    return acc
  }

  /** The sum of `n` floats `stride` apart from `off` (a channels-last channel: scalar_outer_sum / vectorized_outer_sum lane). */
  function sumStrided(d: Float32Array, off: number, n: number, stride: number): number {
    return f(0 + rowSum(n, 1, i => d[off + i * stride]!)[0]!)
  }

  /**
   * torch.sum of a whole contiguous plane to ONE value: on one thread under
   * 32,768 values; above, OpenMP's split into min(threads, ⌈n / 32768⌉)
   * chunks, each summed on its own, then the per-thread buffer summed.
   */
  function sumAll(d: Float32Array, threads: number = TORCH_THREADS): number {
    const n = d.length
    if (n <= GRAIN || threads <= 1) return sumContiguous(d, 0, n)
    const tasks = Math.min(threads, Math.ceil(n / GRAIN))
    const chunk = Math.ceil(n / tasks)
    const buffer = new Float32Array(threads)
    for (let t = 0; t < tasks; t++) {
      const b = t * chunk
      if (b < n) buffer[t] = sumContiguous(d, b, Math.min(n, b + chunk) - b)
    }
    return sumContiguous(buffer, 0, threads)
  }

  /**
   * torch.mean of one picture's plane (sum, then ÷ n in float32). A batch of
   * one splits a long sum between threads; in a batch of two or more each
   * picture is summed on one thread (torch splits over the batch instead).
   * EXACT at the matched thread count.
   */
  function meanAll(plane: Float32Array, layout: TorchLayout = {}): number {
    return f(sumAll(plane, sumThreads(layout)) / plane.length)
  }

  // ── Ranges and element-wise ─────────────────────────────────────────────

  /**
   * torch.linspace(a, b, n) in float32 (RangeFactoriesKernel.cpp): step =
   * (end − start) / (n − 1); index i below n / 2 is fma(step, i, start),
   * the rest fma(−step, n − 1 − i, end) (the compiler fuses start + step·i;
   * measured on every fixture size, vector lanes included). EXACT.
   */
  function linspace(a: number, b: number, n: number): Float32Array {
    const out = new Float32Array(n)
    if (n <= 0) return out
    const start = f(a)
    const end = f(b)
    if (n === 1) { out[0] = start; return out }
    const step = f(f(end - start) / (n - 1))
    const half = Math.floor(n / 2)
    for (let i = 0; i < n; i++) out[i] = i < half ? fmaf(step, i, start) : fmaf(-step, n - i - 1, end)
    return out
  }

  /** torch.arange(n) in float32. EXACT. */
  function arange(n: number): Float32Array {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = i
    return out
  }

  /** torch.remainder (Python's % on a tensor): fmod, then + b where the signs differ. `b` a tensor or a Python float. EXACT. */
  function remainder(a: Tensor, b: Tensor | number): Tensor {
    const out = k.tensor(a.c, a.h, a.w)
    const bs = typeof b === 'number' ? f(b) : 0
    const bd = typeof b === 'number' ? null : b.data
    for (let i = 0; i < a.data.length; i++) {
      const d = bd ? bd[i]! : bs
      let m = f(a.data[i]! % d)
      if (m !== 0 && (d < 0) !== (m < 0)) m = f(m + d)
      out.data[i] = m
    }
    return out
  }

  /**
   * tensor.pow(e) with a Python-float exponent: 0 → 1, 1 → copy, 2 → x·x,
   * 3 → x·x·x, 0.5 → sqrt, −0.5 → 1/sqrt, −1 → 1/x, −2 → 1/(x·x): EXACT.
   * Any other exponent: pow in double, rounded once: LIBRARY (torch: Sleef).
   */
  function powScalar(t: Tensor, e: number): Tensor {
    const out = k.tensor(t.c, t.h, t.w)
    const s = t.data
    const d = out.data
    const n = s.length
    if (e === 0) d.fill(1)
    else if (e === 1) d.set(s)
    else if (e === 2) for (let i = 0; i < n; i++) d[i] = f(s[i]! * s[i]!)
    else if (e === 3) for (let i = 0; i < n; i++) d[i] = f(f(s[i]! * s[i]!) * s[i]!)
    else if (e === 0.5) for (let i = 0; i < n; i++) d[i] = f(Math.sqrt(s[i]!))
    else if (e === -0.5) for (let i = 0; i < n; i++) d[i] = f(1 / f(Math.sqrt(s[i]!)))
    else if (e === -1) for (let i = 0; i < n; i++) d[i] = f(1 / s[i]!)
    else if (e === -2) for (let i = 0; i < n; i++) d[i] = f(1 / f(s[i]! * s[i]!))
    else {
      const ef = f(e)
      for (let i = 0; i < n; i++) d[i] = f(Math.pow(s[i]!, ef))
    }
    return out
  }

  /** float32 exp / sin / cos / tan / log (and atan2 with `other`), in double, rounded once. LIBRARY. */
  function unary(t: Tensor, op: 'exp' | 'sin' | 'cos' | 'tan' | 'log' | 'atan2', other?: Tensor): Tensor {
    const out = k.tensor(t.c, t.h, t.w)
    const s = t.data
    const d = out.data
    if (op === 'atan2') {
      if (!other || other.data.length !== s.length) throw new Error('atan2 takes two tensors of one size')
      const o = other.data
      for (let i = 0; i < s.length; i++) d[i] = f(Math.atan2(s[i]!, o[i]!))
      return out
    }
    const fn = Math[op]
    for (let i = 0; i < s.length; i++) d[i] = f(fn(s[i]!))
    return out
  }

  // ── Resizes ─────────────────────────────────────────────────────────────

  /** F.interpolate(scale_factor=s)'s output size: floor(double(in) · s). EXACT. */
  const areaOutSize = (inSize: number, scaleFactor: number) => Math.floor(inSize * scaleFactor)

  /**
   * The mean over H × W of each channel (adaptive_avg_pool2d to 1 × 1 is
   * input.mean((-1, -2))): one channel of a batch of one is one whole
   * reduction (split between threads above 32,768 values); otherwise each
   * channel is summed on one thread, as a row (contiguous) or a strided row
   * (channels-last).
   */
  function meanHW(t: Tensor, cl: boolean, threads: number): Tensor {
    const n = t.h * t.w
    const out = k.tensor(t.c, 1, 1)
    for (let c = 0; c < t.c; c++) {
      const plane = t.data.subarray(c * n, (c + 1) * n)
      let s: number
      if (t.c === 1) s = sumAll(plane, threads)
      else if (!cl) s = sumContiguous(plane, 0, n)
      else s = sumStrided(plane, 0, n, 1)
      out.data[c] = f(s / n)
    }
    return out
  }

  /**
   * F.interpolate(mode='area') = adaptive_avg_pool2d: window
   * [⌊i·in/out⌋, ⌈(i+1)·in/out⌉), a float sum row by row, then ÷ kh ÷ kw
   * (channels-last, a full vector of channels: ÷ (kh·kw)). To 1 × 1 it is
   * torch.mean (see meanHW and the layout's batch). An output of 0 rows or
   * columns is an empty tensor, as torch returns one (it does not raise: an
   * effect that can't use an empty picture refuses it itself). EXACT.
   */
  function resizeArea(t: Tensor, oh: number, ow: number, layout: TorchLayout & { stop?: () => boolean } = {}): Tensor {
    const cl = !!layout.cl
    const stop = layout.stop
    if (oh === 1 && ow === 1) return meanHW(t, cl, sumThreads(layout))
    const out = k.tensor(t.c, oh, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    const start = (a: number, b: number, c: number) => Math.floor((a * c) / b)
    const end = (a: number, b: number, c: number) => Math.ceil(((a + 1) * c) / b)
    const vecChannels = cl ? t.c - (t.c % TORCH_VEC) : 0
    for (let y = 0; y < oh; y++) {
      stopCheck(stop, y)
      const y0 = start(y, oh, t.h)
      const y1 = end(y, oh, t.h)
      const kh = y1 - y0
      for (let x = 0; x < ow; x++) {
        const x0 = start(x, ow, t.w)
        const x1 = end(x, ow, t.w)
        const kw = x1 - x0
        for (let c = 0; c < t.c; c++) {
          const s = t.data.subarray(c * inN, (c + 1) * inN)
          let sum = 0
          for (let iy = y0; iy < y1; iy++) for (let ix = x0; ix < x1; ix++) sum = f(sum + s[iy * t.w + ix]!)
          out.data[c * outN + y * ow + x] = c < vecChannels ? f(sum / (kh * kw)) : f(f(sum / kh) / kw)
        }
      }
    }
    return out
  }

  /** mode='nearest' source index: min(⌊dst · f32(in/out)⌋, in − 1), with torch's equal-size and 2× shortcuts. */
  function nearestIndex(dst: number, inSize: number, outSize: number, scale: number): number {
    if (outSize === inSize) return dst
    if (outSize === 2 * inSize) return dst >> 1
    return Math.min(Math.floor(f(dst * scale)), inSize - 1)
  }

  /** F.interpolate(mode='nearest', size=(oh, ow)). EXACT. */
  function resizeNearest(t: Tensor, oh: number, ow: number): Tensor {
    const out = k.tensor(t.c, oh, ow)
    const sy = f(t.h / oh)
    const sx = f(t.w / ow)
    const xs = new Int32Array(ow)
    for (let x = 0; x < ow; x++) xs[x] = nearestIndex(x, t.w, ow, sx)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let y = 0; y < oh; y++) {
      const iy = nearestIndex(y, t.h, oh, sy)
      for (let c = 0; c < t.c; c++) {
        const s = c * inN + iy * t.w
        const d = c * outN + y * ow
        for (let x = 0; x < ow; x++) out.data[d + x] = t.data[s + xs[x]!]!
      }
    }
    return out
  }

  /** F.interpolate(mode='bilinear', align_corners=False): the pixels core's torch-exact bilinear (R1.4). EXACT. */
  function resizeBilinear(t: Tensor, oh: number, ow: number, cl = false): Tensor {
    return { c: t.c, h: oh, w: ow, data: px.bilinear(t.data, t.c, t.h, t.w, oh, ow, cl) }
  }

  /**
   * Bicubic taps (UpSampleKernel.cpp HelperInterpCubic, align_corners=False):
   * source fma(scale, d + 0.5, −0.5) unclamped, i0 = min(⌊src⌋, in − 1),
   * t = clamp(src − i0, 0, 1), A = −0.75, the four taps clamped to the edge.
   */
  function cubicTaps(inSize: number, outSize: number): { idx: Int32Array; w: Float32Array } {
    const A = -0.75
    const cc1 = (x: number) => fmaf(f(fmaf(A + 2, x, -(A + 3)) * x), x, 1)
    const cc2 = (x: number) => fmaf(fmaf(fmaf(A, x, -5 * A), x, 8 * A), x, -4 * A)
    const idx = new Int32Array(outSize * 4)
    const w = new Float32Array(outSize * 4)
    const scale = f(inSize / outSize)
    for (let d = 0; d < outSize; d++) {
      const real = fmaf(scale, f(d + 0.5), -0.5)
      const i0 = Math.min(Math.floor(real), inSize - 1)
      const t = f(Math.min(Math.max(f(real - i0), 0), 1))
      const t2 = f(1 - t)
      w[d * 4] = cc2(f(t + 1))
      w[d * 4 + 1] = cc1(t)
      w[d * 4 + 2] = cc1(t2)
      w[d * 4 + 3] = cc2(f(t2 + 1))
      for (let j = 0; j < 4; j++) idx[d * 4 + j] = Math.min(Math.max(i0 - 1 + j, 0), inSize - 1)
    }
    return { idx, w }
  }

  /**
   * F.interpolate(mode='bicubic', align_corners=False) (the generic N-d
   * kernel): for each of the four source rows, a fused chain over the four
   * columns; then a fused chain over the rows. EXACT.
   */
  function resizeBicubic(t: Tensor, oh: number, ow: number, stop?: () => boolean): Tensor {
    const out = k.tensor(t.c, oh, ow)
    const ty = cubicTaps(t.h, oh)
    const tx = cubicTaps(t.w, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let c = 0; c < t.c; c++) {
      const s = t.data.subarray(c * inN, (c + 1) * inN)
      for (let y = 0; y < oh; y++) {
        stopCheck(stop, y)
        for (let x = 0; x < ow; x++) {
          let o = 0
          for (let j = 0; j < 4; j++) {
            const row = ty.idx[y * 4 + j]! * t.w
            let r = f(s[row + tx.idx[x * 4]!]! * tx.w[x * 4]!)
            for (let i = 1; i < 4; i++) r = fmaf(s[row + tx.idx[x * 4 + i]!]!, tx.w[x * 4 + i]!, r)
            o = j === 0 ? f(r * ty.w[y * 4]!) : fmaf(r, ty.w[y * 4 + j]!, o)
          }
          out.data[c * outN + y * ow + x] = o
        }
      }
    }
    return out
  }

  // ── grid_sample, affine_grid ────────────────────────────────────────────

  /**
   * F.grid_sample(mode='bilinear') (GridSamplerKernel.cpp, the vectorised
   * path): `gx`, `gy` are the grid's x and y planes (the output's size).
   * Unnormalise ((g + 1)·(size − 1)/2, or (g + 1)·size/2 − 0.5), then clip
   * (border) or reflect then clip (reflection), then the four taps: weights
   * (1 − dy)(1 − dx)…, taps outside the picture read 0, summed
   * ((nw + ne) + sw) + se. EXACT.
   */
  function gridSample(t: Tensor, gx: Float32Array, gy: Float32Array, opts: { padding: 'zeros' | 'border' | 'reflection'; alignCorners: boolean; oh: number; ow: number }, stop?: () => boolean): Tensor {
    const { padding, alignCorners, oh, ow } = opts
    if (gx.length !== oh * ow || gy.length !== oh * ow) throw new Error('The grid is the wrong size')
    const location = (size: number) => {
      const maxVal = f(size - 1)
      const sf = alignCorners ? f(f(size - 1) / 2) : f(size / 2)
      const low = alignCorners ? 0 : -0.5
      const span2 = alignCorners ? f(f(size - 1) * 2) : f(size * 2)
      const clip = (v: number) => Math.min(maxVal, Math.max(v, 0))
      const reflect = (v: number) => {
        if (alignCorners && span2 <= 0) return 0
        const absIn = Math.abs(alignCorners ? v : f(v - low))
        const flips = Math.trunc(f(absIn / span2))
        const extra = f(absIn - f(flips * span2))
        const m = Math.min(extra, f(span2 - extra))
        return alignCorners ? m : f(m + low)
      }
      return (g: number) => {
        let v = alignCorners ? f(f(g + 1) * sf) : f(f(f(g + 1) * sf) - 0.5)
        if (padding === 'border') v = clip(v)
        else if (padding === 'reflection') v = clip(reflect(v))
        return v
      }
    }
    const locX = location(t.w)
    const locY = location(t.h)
    const out = k.tensor(t.c, oh, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let y = 0; y < oh; y++) {
      stopCheck(stop, y)
      for (let x = 0; x < ow; x++) {
        const i = y * ow + x
        const sx = locX(gx[i]!)
        const sy = locY(gy[i]!)
        const xw = Math.floor(sx)
        const yn = Math.floor(sy)
        const w = f(sx - xw)
        const e = f(1 - w)
        const n = f(sy - yn)
        const s = f(1 - n)
        const nw = f(s * e)
        const ne = f(s * w)
        const sw = f(n * e)
        const se = f(n * w)
        const inX0 = xw > -1 && xw < t.w
        const inX1 = xw + 1 > -1 && xw + 1 < t.w
        const inY0 = yn > -1 && yn < t.h
        const inY1 = yn + 1 > -1 && yn + 1 < t.h
        for (let c = 0; c < t.c; c++) {
          const base = c * inN
          const v00 = inX0 && inY0 ? t.data[base + yn * t.w + xw]! : 0
          const v01 = inX1 && inY0 ? t.data[base + yn * t.w + xw + 1]! : 0
          const v10 = inX0 && inY1 ? t.data[base + (yn + 1) * t.w + xw]! : 0
          const v11 = inX1 && inY1 ? t.data[base + (yn + 1) * t.w + xw + 1]! : 0
          out.data[c * outN + i] = f(f(f(f(v00 * nw) + f(v01 * ne)) + f(v10 * sw)) + f(v11 * se))
        }
      }
    }
    return out
  }

  /**
   * F.affine_grid(θ, (1, C, h, w), align_corners=False): the base grid
   * linspace(−1, 1, n)·(n − 1)/n (0 for n = 1), times θᵀ. The product is a
   * BLAS matrix product in torch: here in double, rounded once. LIBRARY.
   * Returns the grid's x and y planes.
   */
  function affineGrid(theta: readonly (readonly number[])[], h: number, w: number): { gx: Float32Array; gy: Float32Array } {
    const base = (n: number) => {
      if (n <= 1) return new Float32Array(1)
      const r = linspace(-1, 1, n)
      for (let i = 0; i < n; i++) r[i] = f(f(r[i]! * (n - 1)) / n)
      return r
    }
    const bx = base(w)
    const by = base(h)
    const th = theta.map(row => row.map(v => f(v)))
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const X = bx[x]!
        const Y = by[y]!
        gx[y * w + x] = f(X * th[0]![0]! + Y * th[0]![1]! + th[0]![2]!)
        gy[y * w + x] = f(X * th[1]![0]! + Y * th[1]![1]! + th[1]![2]!)
      }
    }
    return { gx, gy }
  }

  // ── Pools and padding ───────────────────────────────────────────────────

  function poolSize(t: Tensor, kk: number, pad: number, stride: number): { oh: number; ow: number } {
    // torch: "pad should be at most half of effective kernel size".
    if (pad > Math.floor(kk / 2)) throw new Error(KERNEL_MESSAGES.poolPad)
    const oh = Math.floor((t.h + 2 * pad - kk) / stride) + 1
    const ow = Math.floor((t.w + 2 * pad - kk) / stride) + 1
    if (oh < 1 || ow < 1) throw new Error(ERR.tooSmall)
    return { oh, ow }
  }

  /**
   * avg_pool2d(kernel kk, stride, padding pad, count_include_pad=True,
   * ceil_mode=False): a float sum over the window's pixels inside the
   * picture, row by row, ÷ the window's size clipped to the padded picture.
   */
  function avgPool(t: Tensor, kk: number, pad: number, stride: number, stop?: () => boolean): Tensor {
    const { oh, ow } = poolSize(t, kk, pad, stride)
    const out = k.tensor(t.c, oh, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let y = 0; y < oh; y++) {
      stopCheck(stop, y)
      let y0 = y * stride - pad
      let y1 = Math.min(y0 + kk, t.h + pad)
      const ph = y1 - y0
      y0 = Math.max(y0, 0)
      y1 = Math.min(y1, t.h)
      for (let x = 0; x < ow; x++) {
        let x0 = x * stride - pad
        let x1 = Math.min(x0 + kk, t.w + pad)
        const div = ph * (x1 - x0)
        x0 = Math.max(x0, 0)
        x1 = Math.min(x1, t.w)
        for (let c = 0; c < t.c; c++) {
          const s = c * inN
          let sum = 0
          for (let iy = y0; iy < y1; iy++) for (let ix = x0; ix < x1; ix++) sum = f(sum + t.data[s + iy * t.w + ix]!)
          out.data[c * outN + y * ow + x] = f(sum / div)
        }
      }
    }
    return out
  }

  /** avg_pool2d(k, stride=1, padding=pad, count_include_pad=True). EXACT. */
  const avgPool2d = (t: Tensor, kk: number, pad: number, stop?: () => boolean) => avgPool(t, kk, pad, 1, stop)
  /** avg_pool2d(kernel_size=k): stride k, no padding. EXACT. */
  const avgPool2dStrided = (t: Tensor, kk: number, stop?: () => boolean) => avgPool(t, kk, 0, kk, stop)

  /** max_pool2d(k, stride=1, padding=pad): −∞ outside the picture. EXACT. */
  function maxPool2d(t: Tensor, kk: number, pad: number, stop?: () => boolean): Tensor {
    const { oh, ow } = poolSize(t, kk, pad, 1)
    const out = k.tensor(t.c, oh, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let y = 0; y < oh; y++) {
      stopCheck(stop, y)
      const y0 = Math.max(y - pad, 0)
      const y1 = Math.min(y - pad + kk, t.h)
      for (let x = 0; x < ow; x++) {
        const x0 = Math.max(x - pad, 0)
        const x1 = Math.min(x - pad + kk, t.w)
        for (let c = 0; c < t.c; c++) {
          const s = c * inN
          let m = -Infinity
          for (let iy = y0; iy < y1; iy++) {
            for (let ix = x0; ix < x1; ix++) {
              const v = t.data[s + iy * t.w + ix]!
              if (v > m || Number.isNaN(v)) m = v
            }
          }
          out.data[c * outN + y * ow + x] = m
        }
      }
    }
    return out
  }

  /** A reflected index into [0, n) (F.pad reflect: the edge is not repeated). */
  const reflectIndex = (i: number, n: number) => (i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i)

  /** F.pad(mode='reflect', (l, r, top, bottom)); a pad of the picture's side or more is refused, as torch refuses it. EXACT. */
  function padReflect(t: Tensor, l: number, r: number, top: number, bottom: number): Tensor {
    if (l >= t.w || r >= t.w || top >= t.h || bottom >= t.h) throw new Error(ERR.tooSmall)
    const oh = t.h + top + bottom
    const ow = t.w + l + r
    const out = k.tensor(t.c, oh, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let c = 0; c < t.c; c++) {
      for (let y = 0; y < oh; y++) {
        const sy = reflectIndex(y - top, t.h)
        for (let x = 0; x < ow; x++) out.data[c * outN + y * ow + x] = t.data[c * inN + sy * t.w + reflectIndex(x - l, t.w)]!
      }
    }
    return out
  }

  // ── Convolution ─────────────────────────────────────────────────────────

  /** Which supported class (CONV_CLASS_EPS) a kh × kw kernel is in, or null. */
  function convKernelClass(kernel: ArrayLike<number>, kh: number, kw: number): keyof typeof CONV_CLASS_EPS | null {
    if (kernel.length !== kh * kw || kh < 1 || kw < 1) return null
    const w = Array.from(kernel, v => f(v))
    if (w.some(v => !Number.isFinite(v))) return null
    const sum = w.reduce((a, b) => a + b, 0)
    if (kh % 2 === 1 && kw % 2 === 1 && kh <= 21 && kw <= 21 && w.every(v => v >= 0) && Math.abs(sum - 1) <= 1e-4) return 'normalised'
    if (kh !== 3 || kw !== 3) return null
    if (w.every(v => Number.isInteger(v) && Math.abs(v) <= 4)) return 'integer3'
    if (w.every(v => Math.abs(v) <= 8)) return 'scaled3'
    return null
  }

  /**
   * A valid cross-correlation of each channel with one kh × kw kernel
   * (row-major), zero outside the picture when `pad` > 0; sums in double,
   * rounded once. LIBRARY (torch: im2col and a BLAS product), within its
   * class's ε; a kernel outside the supported classes is refused.
   */
  function correlate(t: Tensor, kernel: ArrayLike<number>, kh: number, kw: number, pad: number, stop?: () => boolean): Tensor {
    if (kernel.length !== kh * kw) throw new Error('The kernel is the wrong size')
    if (!convKernelClass(kernel, kh, kw)) throw new Error(KERNEL_MESSAGES.convKernel)
    const oh = t.h + 2 * pad - kh + 1
    const ow = t.w + 2 * pad - kw + 1
    if (oh < 1 || ow < 1) throw new Error(ERR.tooSmall)
    const kf = Float64Array.from(kernel, v => f(v))
    const out = k.tensor(t.c, oh, ow)
    const inN = t.h * t.w
    const outN = oh * ow
    for (let c = 0; c < t.c; c++) {
      const s = t.data.subarray(c * inN, (c + 1) * inN)
      for (let y = 0; y < oh; y++) {
        stopCheck(stop, y)
        for (let x = 0; x < ow; x++) {
          let sum = 0
          for (let i = 0; i < kh; i++) {
            const iy = y - pad + i
            if (iy < 0 || iy >= t.h) continue
            for (let j = 0; j < kw; j++) {
              const ix = x - pad + j
              if (ix < 0 || ix >= t.w) continue
              sum += kf[i * kw + j]! * s[iy * t.w + ix]!
            }
          }
          out.data[c * outN + y * ow + x] = f(sum)
        }
      }
    }
    return out
  }

  /** F.conv2d(t, kernel expanded to every channel, groups=c) on an already padded tensor (a valid correlation). LIBRARY. */
  const conv2dDepthwise = (t: Tensor, kernel: ArrayLike<number>, kh: number, kw: number, stop?: () => boolean) => correlate(t, kernel, kh, kw, 0, stop)

  /** F.conv2d(t, kernel, padding=pad) on one channel, zero padding (Outline, relief). LIBRARY. */
  function conv2dSame(t: Tensor, kernel: ArrayLike<number>, kh: number, kw: number, pad: number, stop?: () => boolean): Tensor {
    if (t.c !== 1) throw new Error('conv2dSame takes one channel')
    return correlate(t, kernel, kh, kw, pad, stop)
  }

  /**
   * torchvision _get_gaussian_kernel1d: x = linspace(−(k−1)/2, (k−1)/2, k),
   * pdf = exp(−0.5·(x/σ)²), pdf / pdf.sum(). exp in double rounded once:
   * LIBRARY (everything else torch's float steps, the sum its cascade).
   */
  function gaussianKernel1d(ksize: number, sigma: number): Float32Array {
    const half = (ksize - 1) * 0.5
    const x = linspace(-half, half, ksize)
    const s = f(sigma)
    const pdf = new Float32Array(ksize)
    for (let i = 0; i < ksize; i++) {
      const q = f(x[i]! / s)
      pdf[i] = f(Math.exp(f(-0.5 * f(q * q))))
    }
    const sum = sumContiguous(pdf, 0, ksize)
    const out = new Float32Array(ksize)
    for (let i = 0; i < ksize; i++) out[i] = f(pdf[i]! / sum)
    return out
  }

  /**
   * torchvision gaussian_blur(t, [ksize, ksize], [σ, σ]): reflect padding of
   * ksize // 2 (refused when that reaches the picture's side, as torch
   * refuses it), then the kernel k_y·k_xᵀ over each channel. Computed
   * separably with double sums, rounded to float32 once per output: the same
   * kernel mathematically, 2k taps instead of k². LIBRARY.
   * PROVEN RANGE: ksize ≤ 181 (ε = 2⁻⁸; every Python caller has σ ≤ 30).
   * Wider is refused: at (301, 50) torch's own float sums over 90,601 taps
   * drift to 5.8 × 10⁻³ (255-scale), outside the band (R2.2 review). An even
   * or non-positive ksize, or σ ≤ 0, is refused as torchvision refuses it.
   */
  function gaussianBlur(t: Tensor, ksize: number, sigma: number, stop?: () => boolean): Tensor {
    if (!Number.isInteger(ksize) || ksize < 1 || ksize % 2 === 0 || !(sigma > 0)) throw new Error(KERNEL_MESSAGES.blurSize)
    if (ksize > GAUSSIAN_MAX_KSIZE) throw new Error(KERNEL_MESSAGES.blurTooWide)
    const pad = Math.floor(ksize / 2)
    if (pad >= t.w || pad >= t.h) throw new Error(ERR.tooSmall)
    const kern = Float64Array.from(gaussianKernel1d(ksize, sigma))
    const { w, h } = t
    const out = k.tensor(t.c, h, w)
    const n = w * h
    const across = new Float64Array(n)
    const xs = new Int32Array(w + 2 * pad)
    for (let i = 0; i < xs.length; i++) xs[i] = reflectIndex(i - pad, w)
    const ys = new Int32Array(h + 2 * pad)
    for (let i = 0; i < ys.length; i++) ys[i] = reflectIndex(i - pad, h)
    const col = new Float64Array(h + 2 * pad)
    for (let c = 0; c < t.c; c++) {
      const s = t.data.subarray(c * n, (c + 1) * n)
      for (let y = 0; y < h; y++) {
        stopCheck(stop, y)
        const row = y * w
        for (let x = 0; x < w; x++) {
          let sum = 0
          for (let j = 0; j < ksize; j++) sum += kern[j]! * s[row + xs[x + j]!]!
          across[row + x] = sum
        }
      }
      const d = out.data.subarray(c * n, (c + 1) * n)
      for (let x = 0; x < w; x++) {
        stopCheck(stop, x)
        for (let i = 0; i < col.length; i++) col[i] = across[ys[i]! * w + x]!
        for (let y = 0; y < h; y++) {
          let sum = 0
          for (let i = 0; i < ksize; i++) sum += kern[i]! * col[y + i]!
          d[y * w + x] = f(sum)
        }
      }
    }
    return out
  }

  // ── torchvision's colour operations (transforms/_functional_tensor.py) ──

  function needRgbOrGrey(t: Tensor): void {
    if (t.c !== 1 && t.c !== 3) throw new Error(ERR.needsRgb)
  }

  const copy = (t: Tensor): Tensor => ({ c: t.c, h: t.h, w: t.w, data: new Float32Array(t.data) })

  /** rgb_to_grayscale: (0.2989·r + 0.587·g) + 0.114·b op by op; one channel is copied; four refused. EXACT. */
  function rgbToGrayscale(t: Tensor): Tensor {
    needRgbOrGrey(t)
    if (t.c === 1) return copy(t)
    const n = t.w * t.h
    const out = k.tensor(1, t.h, t.w)
    const wr = f(0.2989)
    const wg = f(0.587)
    const wb = f(0.114)
    for (let i = 0; i < n; i++) out.data[i] = f(f(f(wr * t.data[i]!) + f(wg * t.data[n + i]!)) + f(wb * t.data[2 * n + i]!))
    return out
  }

  /**
   * _blend: (ratio·a + (1 − ratio)·b).clamp(0, 1). `b` is a tensor of a's
   * channels, one channel (broadcast) or a float32 scalar (a mean). The
   * clamp is torch's: −0 becomes +0, except in its element loop's scalar
   * tails (inScalarTail, over the whole batch tensor in `layout`'s memory
   * order), where −0 stays. EXACT.
   */
  function blend(a: Tensor, b: Tensor | number, ratio: number, layout: TorchLayout = {}): Tensor {
    const r = f(ratio)
    const q = f(1 - ratio)
    const out = k.tensor(a.c, a.h, a.w)
    const n = a.w * a.h
    const total = (layout.batch ?? 1) * a.c * n
    const threads = layout.threads ?? TORCH_THREADS
    for (let c = 0; c < a.c; c++) {
      for (let i = 0; i < n; i++) {
        const bv = typeof b === 'number' ? b : b.c === 1 ? b.data[i]! : b.data[c * n + i]!
        const v = f(f(r * a.data[c * n + i]!) + f(q * bv))
        out.data[c * n + i] = Object.is(v, -0) && inScalarTail(memoryIndex(a, c, i, layout), total, threads) ? -0 : clamp01(v)
      }
    }
    return out
  }

  /** adjust_brightness: _blend with zeros. EXACT. */
  function adjustBrightness(t: Tensor, factor: number, layout: TorchLayout = {}): Tensor {
    needRgbOrGrey(t)
    return blend(t, 0, factor, layout)
  }

  /** adjust_saturation: _blend with the greyscale (one channel: unchanged). EXACT. */
  function adjustSaturation(t: Tensor, factor: number, layout: TorchLayout = {}): Tensor {
    needRgbOrGrey(t)
    if (t.c === 1) return copy(t)
    return blend(t, rgbToGrayscale(t), factor, layout)
  }

  /**
   * adjust_contrast: _blend with the mean of the greyscale over the whole
   * picture (torch.mean; its batch decides how the sum is split, meanAll).
   * EXACT at the matched thread count.
   */
  function adjustContrast(t: Tensor, factor: number, layout: TorchLayout = {}): Tensor {
    needRgbOrGrey(t)
    const grey = t.c === 3 ? rgbToGrayscale(t) : t
    return blend(t, meanAll(grey.data, layout), factor, layout)
  }

  /** adjust_hue: _rgb2hsv, (h + factor) % 1, _hsv2rgb, op by op (one channel: unchanged). EXACT. */
  function adjustHue(t: Tensor, factor: number): Tensor {
    needRgbOrGrey(t)
    if (t.c === 1) return copy(t)
    const n = t.w * t.h
    const out = k.tensor(3, t.h, t.w)
    const hf = f(factor)
    const d = t.data
    for (let i = 0; i < n; i++) {
      const r = d[i]!
      const g = d[n + i]!
      const b = d[2 * n + i]!
      // _rgb2hsv
      const maxc = Math.max(r, g, b)
      const minc = Math.min(r, g, b)
      const eqc = maxc === minc
      const cr = f(maxc - minc)
      const sat = f(cr / (eqc ? 1 : maxc))
      const div = eqc ? 1 : cr
      const rc = f(f(maxc - r) / div)
      const gc = f(f(maxc - g) / div)
      const bc = f(f(maxc - b) / div)
      const hr = (maxc === r ? 1 : 0) * f(bc - gc)
      const hg = (maxc === g && maxc !== r ? 1 : 0) * f(f(2 + rc) - bc)
      const hb = (maxc !== g && maxc !== r ? 1 : 0) * f(f(4 + gc) - rc)
      let h = f(f(hr + hg) + hb)
      h = f(f(f(h / 6) + 1) % 1)
      // (h + factor) % 1.0 (torch.remainder)
      let m = f(f(h + hf) % 1)
      if (m !== 0 && m < 0) m = f(m + 1)
      h = m
      // _hsv2rgb
      const h6 = f(h * 6)
      const fi = Math.floor(h6)
      const fr = f(h6 - fi)
      const v = maxc
      const p = clamp01(f(v * f(1 - sat)))
      const q = clamp01(f(v * f(1 - f(sat * fr))))
      const tt = clamp01(f(v * f(1 - f(sat * f(1 - fr)))))
      const sector = ((fi % 6) + 6) % 6
      let R: number, G: number, B: number
      switch (sector) {
        case 0: R = v; G = tt; B = p; break
        case 1: R = q; G = v; B = p; break
        case 2: R = p; G = v; B = tt; break
        case 3: R = p; G = q; B = v; break
        case 4: R = tt; G = p; B = v; break
        default: R = v; G = p; B = q
      }
      // The einsum adds the chosen value to zeros: a −0 comes out +0.
      out.data[i] = R + 0
      out.data[n + i] = G + 0
      out.data[2 * n + i] = B + 0
    }
    return out
  }

  // ── topk ────────────────────────────────────────────────────────────────

  /**
   * torch.topk(values, k, largest): the indices of the k largest (smallest),
   * in order of value; NaN ranks above every number, as in torch (first when
   * largest, last when smallest). A k-heap over typed arrays (O(n log k)),
   * with a Stop check every 65,536 values. What matches torch: the values in
   * order, bit for bit, and the set of indices whose value is past the cut.
   * What doesn't: the order of indices among equal values (torch's order is
   * its own, not lower index first, even away from the cut; this heap puts
   * the lower index first), and which of several values tied AT the cut are
   * kept (the band case).
   */
  function topk(values: ArrayLike<number>, kk: number, largest = true, stop?: () => boolean): Int32Array {
    const n = values.length
    const size = Math.max(0, Math.min(kk, n))
    /** Whether index a ranks before index b. */
    const before = (a: number, b: number): boolean => {
      const va = values[a]!
      const vb = values[b]!
      const na = va !== va
      const nb = vb !== vb
      if (na || nb) return na && nb ? a < b : largest ? na : nb
      if (va !== vb) return largest ? va > vb : va < vb
      return a < b
    }
    // A heap whose root is the kept index ranking last.
    const heap = new Int32Array(size)
    let used = 0
    const down = (at: number) => {
      for (;;) {
        const l = 2 * at + 1
        if (l >= used) return
        const r = l + 1
        const worst = r < used && before(heap[l]!, heap[r]!) ? r : l
        if (!before(heap[at]!, heap[worst]!)) return
        const tmp = heap[at]!; heap[at] = heap[worst]!; heap[worst] = tmp
        at = worst
      }
    }
    for (let i = 0; i < n && size > 0; i++) {
      if (stop && (i & 65535) === 0 && stop()) throw new Error('Stopped')
      if (used < size) {
        let at = used++
        heap[at] = i
        while (at > 0) {
          const up = (at - 1) >> 1
          if (!before(heap[up]!, heap[at]!)) break
          const tmp = heap[at]!; heap[at] = heap[up]!; heap[up] = tmp
          at = up
        }
      }
      else if (before(i, heap[0]!)) { heap[0] = i; down(0) }
    }
    return heap.sort((a, b) => (before(a, b) ? -1 : 1))
  }

  return {
    TORCH_VEC, GRAIN, TORCH_THREADS, GAUSSIAN_MAX_KSIZE, KERNEL_MESSAGES, CONV_CLASS_EPS, convKernelClass, fmaf, clamp01, inScalarTail,
    sumContiguous, sumStrided, sumAll, meanAll,
    linspace, arange, remainder, powScalar, unary,
    areaOutSize, resizeArea, resizeNearest, resizeBilinear, resizeBicubic,
    gridSample, affineGrid,
    avgPool2d, avgPool2dStrided, maxPool2d, padReflect,
    conv2dDepthwise, conv2dSame, gaussianKernel1d, gaussianBlur,
    rgbToGrayscale, blend, adjustBrightness, adjustSaturation, adjustContrast, adjustHue,
    topk,
  }
}

export type KernelsCore = ReturnType<typeof kernelsCore>
