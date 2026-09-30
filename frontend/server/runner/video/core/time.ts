/**
 * The video effects' cores (step 3, R6): what one output frame of a video
 * effect is, computed as Python's float32 torch code computes it.
 *
 * SELF-CONTAINED apart from their arguments, as the effect cores are
 * (../../effects/core/tensor.ts): the compositor worker composes each from
 * its source text (compositor/worker.ts workerScript, ../cores.ts), and tests
 * call the same code in-thread. Do not reference anything from outside a
 * function's body but its arguments.
 *
 * A frame is a planar tensor, 3 × H × W (Python's is T × H × W × 3; the
 * arithmetic is per element), of float32 values (Math.fround after every
 * operation, as torch's CPU kernels round each op). Frames arrive 8-bit
 * (R6 ruling (a)) and are made k / 255, as Get video components hands them
 * (`torch.from_numpy(u8) / 255.0`, video_types.py:264).
 *
 * A video op is called once per output frame (VideoEffectSpec.op,
 * '<core>.<fn>'): `(inputs, params, state, index, count, stop)`, where
 * `inputs` are the frames that output frame reads, `index` its place in the
 * output batch and `count` the batch's length, and `state` what the op
 * carried from the frame before (an ArrayBuffer, handed back and forth).
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { KernelsCore } from '../../effects/core/kernels'
import type { RngCore } from '../../effects/core/rng'

/** One output frame: its tensor, and the state carried to the next frame (if any). */
export interface VideoOpResult { out: Tensor; state?: ArrayBuffer }
export type VideoOp = (inputs: Tensor[], p: Record<string, unknown>, state: ArrayBuffer | undefined, index: number, count: number, stop?: () => boolean) => VideoOpResult

/**
 * Frames in and out of the ops (`vx`): an rgb24 frame as its float32 tensor,
 * k / 255 per byte; and the 8-bit forms of rule 4 and 9 (tk.quantize:
 * 'trunc' is trunc(f32(255·x)) clipped, Python's savers and
 * save_live_preview; 'round' is round(f32(clamp(x)·255)), halves to even).
 */
export function framesCore(tk: TensorCore) {
  const f = Math.fround
  const table = new Float32Array(256)
  for (let k = 0; k < 256; k++) table[k] = f(k / 255)

  function fromRgb(rgb: Uint8Array, w: number, h: number): Tensor {
    const n = w * h
    if (rgb.length !== n * 3) throw new Error('A video frame is not the size its batch says')
    const t = tk.tensor(3, h, w)
    const d = t.data
    for (let i = 0; i < n; i++) {
      d[i] = table[rgb[3 * i]!]!
      d[n + i] = table[rgb[3 * i + 1]!]!
      d[2 * n + i] = table[rgb[3 * i + 2]!]!
    }
    return t
  }

  function toRgb(t: Tensor, mode: 'trunc' | 'round', stop?: () => boolean): Uint8Array {
    if (t.c !== 3) throw new Error('A video frame has three channels')
    return tk.quantize(t, mode, stop)
  }

  return { fromRgb, toRgb }
}

export type FramesCore = ReturnType<typeof framesCore>

/** Speed ramp's output count and where each output frame comes from (./time.ts rampSources). */
export interface RampSources {
  /** The output count. */
  N: number
  /** src_idx: each output frame's source position (float32). */
  src: Float32Array
  /** idx_lo, idx_hi and frac (float32): the two frames a blend reads and the weight of the second. */
  lo: Int32Array
  hi: Int32Array
  frac: Float32Array
  /** src_idx.round() (halves to even), clamped: the frame `nearest` reads. */
  nearest: Int32Array
  /** A ramp's rate.mean().item() (a double holding the float32 mean); absent for `constant`. */
  meanRate?: number
  /** A ramp's torch.cumsum(rate) (float32), before it is scaled; absent for `constant`. */
  cum?: Float32Array
}

/**
 * The time effects (nodes_video_effects.py, nodes_video_pro.py; R6.1's
 * pilots, R6.2 the rest). `kn` is R2.2's kernels (linspace, the bilinear
 * resize, torch's sums), `rng` R2.3's torch generator.
 */
export function timeCore(tk: TensorCore, kn: KernelsCore, rng: RngCore) {
  const f = Math.fround

  /** torch.round of a float (and Python's round() of a double): halves to the even neighbour. */
  function roundEven(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /** torch's `%` of an integer tensor by a positive int: the sign of the divisor, as Python's. */
  const pyMod = (a: number, n: number) => ((a % n) + n) % n
  const clampIndex = (a: number, n: number) => (a < 0 ? 0 : a > n - 1 ? n - 1 : a)

  /**
   * Trim, Reverse and Ping-pong (nodes_video_effects.py:287-348): selection
   * only. The plan picks which input frame each output frame is; the frame
   * is handed on as it came. EXACT.
   */
  function select(inputs: Tensor[]): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    return { out: x }
  }

  /**
   * FrameTrail (nodes_video_effects.py:61-117). T ≤ 1 is handed on whole by
   * the plan. Frame 0 as it is; its copy starts the trail (`acc`). Then per
   * frame: acc = acc · f32(decay); with threshold > 0 (a Python double),
   * lum = luma709 (each product rounded, then (p0 + p1) + p2) and acc =
   * max(acc, frame · (lum > f32(threshold))); else acc = max(acc, frame);
   * trail = acc · f32(intensity); screen 1 − (1 − cur)(1 − trail), add
   * cur + trail, or max(cur, trail); clamp(0, 1). `acc` is the state carried
   * to the next frame. EXACT.
   */
  function trail(inputs: Tensor[], p: Record<string, unknown>, state: ArrayBuffer | undefined, index: number, count: number, stop?: () => boolean): VideoOpResult {
    const cur = inputs[0]
    if (!cur) throw new Error('A video frame is missing')
    const n = cur.data.length
    if (index === 0 || count <= 1) return { out: cur, state: new Float32Array(cur.data).buffer }
    if (!state || state.byteLength !== n * 4) throw new Error('The trail from the frame before is missing')
    const acc = new Float32Array(state)
    const d = f(p.decay as number)
    const threshold = p.threshold as number
    const intensity = f(p.intensity as number)
    const mode = p.blend_mode
    const x = cur.data
    const px = cur.w * cur.h
    for (let i = 0; i < n; i++) acc[i] = f(acc[i]! * d)
    if (threshold > 0) {
      const lum = tk.luma709(cur, stop)
      const at = f(threshold)
      for (let k = 0; k < cur.c; k++) {
        const base = k * px
        for (let i = 0; i < px; i++) {
          // frame · mask: the frame where lum > threshold, else 0 (the frame is never negative, so never −0).
          const v = lum[i]! > at ? x[base + i]! : 0
          if (v > acc[base + i]!) acc[base + i] = v
        }
      }
    }
    else {
      for (let i = 0; i < n; i++) if (x[i]! > acc[i]!) acc[i] = x[i]!
    }
    if (stop?.()) throw new Error('Stopped')
    const out = tk.tensor(cur.c, cur.h, cur.w)
    const o = out.data
    for (let i = 0; i < n; i++) {
      const c = x[i]!
      const t = f(acc[i]! * intensity)
      let b: number
      if (mode === 'screen') b = f(1 - f(f(1 - c) * f(1 - t)))
      else if (mode === 'add') b = f(c + t)
      else b = c > t ? c : t
      o[i] = b < 0 ? 0 : b > 1 ? 1 : b
    }
    return { out, state: acc.buffer }
  }

  /**
   * SlitScan's source frames (nodes_video_effects.py:207-218), per output
   * frame t and step s (a column for `horizontal`, a row for `vertical`),
   * at t · S + s: delay_per_step = delay · T / S in doubles, met by the
   * float32 steps as float32 (torch rounds the scalar once); src = t +
   * s · delay_per_step, each op rounded to float32; `long()` truncates (src
   * is never negative); then `% T` (wrap) or clamped. EXACT.
   */
  function slitSources(p: Record<string, unknown>, T: number, W: number, H: number): Int32Array {
    const S = p.axis === 'horizontal' ? W : H
    const dps = f((p.delay as number) * T / S)
    const out = new Int32Array(T * S)
    for (let t = 0; t < T; t++) {
      for (let s = 0; s < S; s++) {
        const v = Math.trunc(f(t + f(s * dps)))
        out[t * S + s] = p.wrap ? pyMod(v, T) : clampIndex(v, T)
      }
    }
    return out
  }

  /**
   * `_value_noise_2d` (nodes_video_effects.py:38-54): torch.Generator()
   * seeded seed & 0x7FFFFFFF, rand(1, 1, max(2, int(h / max(1, scale))),
   * max(2, int(w / …))), bilinear up to (h, w) (align_corners=False). EXACT.
   */
  function valueNoise2d(h: number, w: number, scale: number, seed: number): Float32Array {
    const g = rng.generator()
    g.seed(seed & 0x7fffffff)
    const lh = Math.max(2, Math.trunc(h / Math.max(1.0, scale)))
    const lw = Math.max(2, Math.trunc(w / Math.max(1.0, scale)))
    const low: Tensor = { c: 1, h: lh, w: lw, data: g.rand(lh * lw) }
    return kn.resizeBilinear(low, h, w).data
  }

  /**
   * TimeDisplacement's offset per pixel (nodes_video_effects.py:262-263):
   * (n · 2 − 1) · f32(strength), each op rounded to float32. EXACT.
   */
  function displaceOffsets(p: Record<string, unknown>, W: number, H: number): Float32Array {
    const n = valueNoise2d(H, W, p.noise_scale as number, p.seed as number)
    const s = f(p.strength as number)
    const out = new Float32Array(n.length)
    for (let i = 0; i < n.length; i++) out[i] = f(f(f(n[i]! * 2) - 1) * s)
    return out
  }

  /**
   * TimeDisplacement's source frame per pixel for output frame t (:264-269):
   * src = t + offset (float32), round() (halves to even), then `% T` (wrap,
   * Python's sign) or clamped. Written into `out` when given. EXACT.
   */
  function displaceSources(offsets: Float32Array, t: number, T: number, wrap: boolean, out: Int32Array = new Int32Array(offsets.length)): Int32Array {
    for (let i = 0; i < offsets.length; i++) {
      const v = roundEven(f(t + offsets[i]!))
      out[i] = wrap ? pyMod(v, T) : clampIndex(v, T)
    }
    return out
  }

  /** `_ease` (nodes_video_pro.py:38-44) of one float32, each op rounded to float32 (cos: this runtime's, LIBRARY). */
  function ease(t: number, mode: string): number {
    if (mode === 'ease_in') return f(t * t)
    if (mode === 'ease_out') {
      const a = f(1 - t)
      // (1 − t) ** 2: torch's pow by 2 is a·a.
      return f(1 - f(a * a))
    }
    if (mode === 'ease_in_out') return f(0.5 - f(0.5 * f(Math.cos(f(t * f(Math.PI))))))
    return t
  }

  /**
   * SpeedRamp's mapping (nodes_video_pro.py:95-122) from its widgets and
   * the input's T (> 1):
   *   constant — r = max(0.05, speed), N = max(1, int(round(T / r))) in
   *              doubles, src = linspace(0, T − 1, N) (float32). EXACT.
   *   ramps    — K = 4096, u = linspace(0, 1, K), the ease, rate = f32(r0) +
   *              f32(r1 − r0) · ease; N from rate.mean() (torch's cascade sum,
   *              ÷ K, read as a double); cum = cumsum(rate), added in
   *              double and each partial sum stored as float32; ÷ cum[−1], · (T − 1); probed at
   *              linspace(0, K − 1, N) by lerp (cum[lo]·(1 − f) + cum[hi]·f),
   *              clamped to [0, T − 1]. LIBRARY only through ease_in_out's
   *              cos.
   * Then idx_lo = floor, idx_hi = idx_lo + 1, both clamped; frac = src −
   * idx_lo; the nearest frame src.round() (halves to even), clamped.
   */
  function rampSources(p: Record<string, unknown>, T: number): RampSources {
    const mode = p.mode as string
    let N: number
    let src: Float32Array
    let meanRate: number | undefined
    let cumOut: Float32Array | undefined
    if (mode === 'constant') {
      const r = Math.max(0.05, p.speed as number)
      N = Math.max(1, roundEven(T / r))
      src = kn.linspace(0, T - 1, N)
    }
    else {
      const r0 = Math.max(0.05, p.start_speed as number)
      const r1 = Math.max(0.05, p.speed as number)
      const K = 4096
      const u = kn.linspace(0, 1, K)
      const em = mode === 'ramp_in' ? 'ease_in' : mode === 'ramp_out' ? 'ease_out' : 'ease_in_out'
      const d = f(r1 - r0)
      const a = f(r0)
      const rate = new Float32Array(K)
      for (let i = 0; i < K; i++) rate[i] = f(a + f(d * ease(u[i]!, em)))
      meanRate = kn.meanAll(rate)
      N = Math.max(1, roundEven((T - 1) / Math.max(1e-6, meanRate)))
      const cum = new Float32Array(K)
      let acc = 0
      // torch's CPU cumsum accumulates in double (acc_type<float>) and stores each partial sum as float32.
      for (let i = 0; i < K; i++) { acc += rate[i]!; cum[i] = f(acc) }
      cumOut = cum.slice()
      const last = cum[K - 1]!
      const span = f(T - 1)
      for (let i = 0; i < K; i++) cum[i] = f(f(cum[i]! / last) * span)
      const probe = kn.linspace(0, K - 1, N)
      src = new Float32Array(N)
      for (let j = 0; j < N; j++) {
        const lo = clampIndex(Math.floor(probe[j]!), K)
        const hi = clampIndex(lo + 1, K)
        const fr = f(probe[j]! - lo)
        const v = f(f(cum[lo]! * f(1 - fr)) + f(cum[hi]! * fr))
        src[j] = v < 0 ? 0 : v > span ? span : v
      }
    }
    const lo = new Int32Array(N)
    const hi = new Int32Array(N)
    const frac = new Float32Array(N)
    const nearest = new Int32Array(N)
    for (let j = 0; j < N; j++) {
      const s = src[j]!
      lo[j] = clampIndex(Math.floor(s), T)
      hi[j] = clampIndex(lo[j]! + 1, T)
      frac[j] = f(s - lo[j]!)
      nearest[j] = clampIndex(roundEven(s), T)
    }
    return { N, src, lo, hi, frac, nearest, ...(meanRate !== undefined ? { meanRate } : {}), ...(cumOut ? { cum: cumOut } : {}) }
  }

  /**
   * SpeedRamp's frame (nodes_video_pro.py:124-129): `nearest` hands its one
   * frame on; `blend` is frames[lo]·(1 − frac) + frames[hi]·frac, each op
   * rounded to float32, clamped to [0, 1]. `_frac` is this frame's frac
   * (the plan's per-frame params). EXACT.
   */
  function ramp(inputs: Tensor[], p: Record<string, unknown>): VideoOpResult {
    const a = inputs[0]
    if (!a) throw new Error('A video frame is missing')
    if (p.interpolation === 'nearest') return { out: a }
    const b = inputs[1]
    if (!b || b.data.length !== a.data.length) throw new Error('A video frame is missing')
    const fr = f(p._frac as number)
    const g = f(1 - fr)
    const out = tk.tensor(a.c, a.h, a.w)
    const x = a.data
    const y = b.data
    const o = out.data
    for (let i = 0; i < o.length; i++) {
      const v = f(f(x[i]! * g) + f(y[i]! * fr))
      o[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    return { out }
  }

  return { select, trail, ramp, slitSources, displaceOffsets, displaceSources, rampSources }
}

export type TimeCore = ReturnType<typeof timeCore>
