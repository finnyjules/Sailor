/**
 * Generators, seeded looks and Add noise (family `effects-noise`, step 3
 * R2.9): Film grain (nodes_glsl_atmosphere.py), Glitch
 * (nodes_glsl_distortion.py), Perlin noise, Voronoi, Gradient
 * (nodes_glsl_generative.py), Palette quantize (nodes_glsl_lab.py),
 * Reaction-diffusion, Fractal (nodes_glsl_fractal.py), Stipple, Flow field
 * (nodes_glsl_unicorn.py) and Add noise (nodes_sharpen_noise.py). Built on
 * R2.3's torch generator and R2.2's kernels (the resizes, grid_sample, topk,
 * avg pooling, reflect padding, randperm, and the Winograd 3 × 3 conv torch
 * takes for the laplacian on this Mac).
 *
 * SELF-CONTAINED apart from its arguments (the tensor core, the kernels and
 * the random numbers), as ../../pixels/core.ts is: the compositor worker
 * composes it from its source text. Do not reference anything from outside
 * this body but `k`, `kn` and `rng`.
 *
 * Each op takes the node's tensors by input name (a generator: none), its
 * widgets as ComfyUI's validation converted them, a Stop check, the effect's
 * batch state, and the picture's index in the batch Python worked on and that
 * batch's size. FLOAT32, OP BY OP as torch: every product, sum and difference
 * rounded, a Python double scalar rounded to float32 once where it meets a
 * tensor (a comparison too), and a Python expression of scalars worked out in
 * double first. Random numbers are drawn in chunks with a Stop check between
 * them (R2.3 ruling), from seeds passed exactly (a bigint for Add noise's).
 *
 * Parity (R2 rule 10): Glitch, Perlin noise, Voronoi (but at an exact tie
 * of its two nearest sites: see Voronoi), Gradient, Reaction-diffusion (the
 * Winograd laplacian) and Stipple are EXACT. Film grain and Add noise's gaussian (randn's sin / cos / log), Fractal
 * (sin) and Palette quantize (its means) are LIBRARY. Flow field is the "warp"
 * class (R2.7 amendment): torch's SLEEF cos / sin move grid_sample's taps.
 *
 * The last `.clamp(0, 1)`: torch's vector loop turns −0 into +0, its scalar
 * tails keep it (kernels.ts inScalarTail), over the clamped tensor's memory
 * ('bhwc' a contiguous (B, H, W, C) picture, 'nchw' a grid_sample's result,
 * 'plane' one H × W plane).
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'
import type { RngCore, TorchGenerator } from './rng'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined
type State = Record<string, unknown>

export function noiseCore(k: TensorCore, kn: KernelsCore, rng: RngCore) {
  const f = Math.fround
  /** Floats drawn between two Stop checks (a multiple of 16: whole normal_fill blocks). */
  const DRAW_CHUNK = 1 << 20
  const ERR = k.EFFECT_ERRORS
  /** Film grain finer than 1 on a picture whose side it doesn't divide: Python's broadcast fails (plain words: shared/runner/effects.ts). */
  const GRAIN_TOO_FINE = 'EFFECT_GRAIN_TOO_FINE'

  // ── Shared steps ────────────────────────────────────────────────────────

  function stopNow(stop: Stop): void {
    if (stop?.()) throw new Error('Stopped')
  }

  /** Python's round() of a double: halves to the even neighbour. */
  function pyRound(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  const num = (p: Params, key: string) => p[key] as number
  const sin32 = (x: number) => f(Math.sin(x))
  const cos32 = (x: number) => f(Math.cos(x))

  /** A generator seeded as torch.Generator().manual_seed(seed). */
  function seeded(seed: bigint | number): TorchGenerator {
    const g = rng.generator()
    g.seed(seed)
    return g
  }

  /** torch.rand(n) from `g`, in chunks with a Stop check between them (serial: the same floats). */
  function randChunked(g: TorchGenerator, n: number, stop: Stop): Float32Array {
    const out = new Float32Array(n)
    for (let at = 0; at < n; at += DRAW_CHUNK) {
      stopNow(stop)
      out.set(g.rand(Math.min(DRAW_CHUNK, n - at)), at)
    }
    return out
  }

  /**
   * torch.randn(total) from `g` as one draw, handed out in order `n` at a
   * time: below 16 values the whole draw at once (the scalar path); from 16,
   * normal_fill's whole blocks of 16 drawn DRAW_CHUNK at a time (each block
   * reads only its own 16 uniforms, so blocks drawn in chunks are the same
   * floats), and when total % 16 ≠ 0 the last 16 values drawn again after
   * the rest (its leftover uniforms, then 16 new ones), as normal_fill does.
   */
  function normalStream(g: TorchGenerator, total: number, stop: Stop) {
    const r = total % 16
    const full = total - r
    const limit = r ? total - 16 : total
    let small: Float32Array | null = total < 16 ? g.randn(total) : null
    let chunk: Float32Array = new Float32Array(0)
    let chunkStart = 0
    let drawn = 0
    let tail: Float32Array | null = null
    let pos = 0
    const drawBlocks = () => {
      stopNow(stop)
      const len = Math.min(DRAW_CHUNK, full - drawn)
      chunk = g.randn(len)
      chunkStart = drawn
      drawn += len
    }
    return {
      next(n: number): Float32Array {
        const out = new Float32Array(n)
        for (let i = 0; i < n; i++, pos++) {
          if (small) { out[i] = small[pos]!; continue }
          if (pos < limit) {
            while (pos >= chunkStart + chunk.length) drawBlocks()
            out[i] = chunk[pos - chunkStart]!
            continue
          }
          if (!tail) {
            while (drawn < full) drawBlocks()
            g.rand(r)
            tail = g.randn(16)
          }
          out[i] = tail[pos - (total - 16)]!
        }
        if (small && pos >= total) small = null
        return out
      },
    }
  }

  /**
   * Whether value `m` of a `total`-value tensor, walked in runs of `run`
   * contiguous values, falls in a scalar tail of torch's clamp loop (the run
   * cut into OpenMP chunks above 32,768 values; each run's last len mod 8
   * values one by one). There std::max(−0, 0) keeps −0.
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

  /** The node's last `.clamp(0, 1)` in place: −0 kept only in the scalar tails of torch's loop over the clamped tensor's memory. */
  function clampOut(t: Tensor, stop: Stop, index: number, count: number, layout: 'bhwc' | 'nchw'): Tensor {
    const n = t.w * t.h
    const C = t.c
    const total = count * n * C
    const d = t.data
    const mem = layout === 'nchw' ? (c: number, i: number) => index * n * C + c * n + i : (c: number, i: number) => index * n * C + i * C + c
    k.rows(t.h, stop, (y) => {
      for (let i = y * t.w, end = i + t.w; i < end; i++) {
        for (let c = 0; c < C; c++) {
          const v = d[c * n + i]!
          d[c * n + i] = Object.is(v, -0) && inTail(mem(c, i), total, total) ? -0 : kn.clamp01(v)
        }
      }
    })
    return t
  }

  /** `.clamp(0, 1)` of one contiguous plane in place (a generator's (H, W) tensor). */
  function clampPlane(d: Float32Array, stop: Stop, h: number, w: number): void {
    const total = h * w
    k.rows(h, stop, (y) => {
      for (let i = y * w, end = i + w; i < end; i++) {
        const v = d[i]!
        d[i] = Object.is(v, -0) && inTail(i, total, total) ? -0 : kn.clamp01(v)
      }
    })
  }

  const clampedCopy = (x: Tensor, stop: Stop, index: number, count: number) =>
    clampOut({ c: x.c, h: x.h, w: x.w, data: new Float32Array(x.data) }, stop, index, count, 'bhwc')

  /** A plane as a 3-channel picture (unsqueeze(-1).expand(…, 3).contiguous()). */
  function grey3(d: Float32Array, h: number, w: number): Tensor {
    const t = k.tensor(3, h, w)
    for (let c = 0; c < 3; c++) t.data.set(d, c * h * w)
    return t
  }

  /** torch.meshgrid(linspace(a, b, h), linspace(a, b, w), indexing='ij') as the x and y planes. */
  function meshgrid(ys: Float32Array, xs: Float32Array): { xx: Float32Array; yy: Float32Array } {
    const h = ys.length
    const w = xs.length
    const xx = new Float32Array(h * w)
    const yy = new Float32Array(h * w)
    for (let y = 0; y < h; y++) {
      xx.set(xs, y * w)
      yy.fill(ys[y]!, y * w, (y + 1) * w)
    }
    return { xx, yy }
  }

  // ── Film grain ──────────────────────────────────────────────────────────

  /**
   * FilmGrain (nodes_glsl_atmosphere.py:124-165): amount ≤ 0 is a clamp.
   * randn(1, 1, gh, gw) from its own generator, gh = max(2, int(h / size)),
   * one field for the whole batch (kept in the batch state), bilinear up to
   * (h, w) when size > 1; grain = noise · clamp(4·luma·(1 − luma)) · amount
   * · 0.5 on every channel. Below size 1 the field broadcasts against the
   * picture as torch does: a side of 1 grows to the field's, any other
   * difference is Python's raise. LIBRARY (randn).
   */
  function FilmGrain(inp: Inputs, p: Params, stop?: Stop, state: State = {}, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const amount = num(p, 'amount')
    if (amount <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const size = num(p, 'size')
    const { h, w } = x
    const gh = Math.max(2, Math.trunc(h / size))
    const gw = Math.max(2, Math.trunc(w / size))
    // The field's size against the picture's, before drawing it (Python raises either way).
    const side = (a: number, b: number) => (a === b ? a : a === 1 ? b : b === 1 ? a : -1)
    const oh = side(h, size > 1 ? h : gh)
    const ow = side(w, size > 1 ? w : gw)
    if (oh < 0 || ow < 0) throw new Error(GRAIN_TOO_FINE)
    const key = `${h}x${w}`
    let noise = state.grain as Tensor | undefined
    if (!noise || state.grainKey !== key) {
      const g = seeded(Math.trunc(num(p, 'seed')))
      noise = { c: 1, h: gh, w: gw, data: normalStream(g, gh * gw, stop).next(gh * gw) }
      if (size > 1) {
        stopNow(stop)
        noise = kn.resizeBilinear(noise, h, w)
        stopNow(stop)
      }
      state.grain = noise
      state.grainKey = key
    }
    const luma = k.luma709(x, stop)
    const weight = new Float32Array(h * w)
    for (let i = 0; i < weight.length; i++) {
      const l = luma[i]!
      weight[i] = kn.clamp01(f(f(4 * l) * f(1 - l)))
    }
    const a32 = f(amount)
    const out = k.tensor(x.c, oh, ow)
    const n = oh * ow
    const inN = h * w
    k.rows(oh, stop, (y) => {
      const ny = noise!.h === 1 ? 0 : y
      const iy = h === 1 ? 0 : y
      for (let xo = 0; xo < ow; xo++) {
        const nx = noise!.w === 1 ? 0 : xo
        const ix = w === 1 ? 0 : xo
        const grain = f(f(f(noise!.data[ny * noise!.w + nx]! * weight[iy * w + ix]!) * a32) * 0.5)
        for (let c = 0; c < x.c; c++) out.data[c * n + y * ow + xo] = f(x.data[c * inN + iy * w + ix]! + grain)
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  // ── Glitch ──────────────────────────────────────────────────────────────

  /**
   * Glitch (nodes_glsl_distortion.py:104-145): intensity ≤ 0 is a clamp.
   * Rows in slices of max(1, h // slices), each rolled along the width by
   * int((rand(1) − 0.5)·2·max_shift) (the float drawn, in double), the same
   * shifts for every picture of the batch; then channel 0 rolled by chroma,
   * channel 2 by −chroma. EXACT.
   */
  function Glitch(inp: Inputs, p: Params, stop?: Stop, _s?: State, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const intensity = num(p, 'intensity')
    if (intensity <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const { h, w, c: C } = x
    const g = seeded(Math.trunc(num(p, 'seed')))
    const sliceH = Math.max(1, Math.floor(h / Math.trunc(num(p, 'slices'))))
    const maxShift = Math.trunc(intensity * w * 0.15)
    const n = h * w
    const out = k.tensor(C, h, w)
    const roll = (src: Float32Array, dst: Float32Array, row: number, shift: number) => {
      for (let xo = 0; xo < w; xo++) dst[row * w + xo] = src[row * w + ((((xo - shift) % w) + w) % w)]!
    }
    for (let i = 0; i < h; i += sliceH) {
      stopNow(stop)
      const end = Math.min(h, i + sliceH)
      const shift = Math.trunc((g.rand(1)[0]! - 0.5) * 2 * maxShift)
      for (let c = 0; c < C; c++) {
        const s = x.data.subarray(c * n, (c + 1) * n)
        const d = out.data.subarray(c * n, (c + 1) * n)
        for (let y = i; y < end; y++) roll(s, d, y, shift)
      }
    }
    const chroma = Math.max(1, Math.trunc(intensity * w * 0.005))
    for (const [c, shift] of [[0, chroma], [2, -chroma]] as const) {
      const d = out.data.subarray(c * n, (c + 1) * n)
      const s = new Float32Array(d)
      k.rows(h, stop, y => roll(s, d, y, shift))
    }
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  // ── Generators ──────────────────────────────────────────────────────────

  /**
   * PerlinNoise (nodes_glsl_generative.py:17-67): per octave o, rand(1, 1,
   * gh, gw) seeded (seed + 17·o) & 0x7fffffff, gh = max(2, int(h / sc) + 1),
   * bicubic up to (h, w); total + amp·layer; amp_sum, amp and sc in double;
   * total / max(1e-6, amp_sum), clamped, grey on three channels. EXACT.
   */
  function PerlinNoise(_inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const w = Math.trunc(num(p, 'width'))
    const h = Math.trunc(num(p, 'height'))
    let total: Float32Array = new Float32Array(h * w)
    let ampSum = 0
    let amp = 1
    let sc = num(p, 'scale')
    const seed = Math.trunc(num(p, 'seed'))
    for (let o = 0; o < Math.trunc(num(p, 'octaves')); o++) {
      const g = seeded((seed + o * 17) & 0x7fffffff)
      const gw = Math.max(2, Math.trunc(w / sc) + 1)
      const gh = Math.max(2, Math.trunc(h / sc) + 1)
      const grid: Tensor = { c: 1, h: gh, w: gw, data: randChunked(g, gh * gw, stop) }
      const layer = kn.resizeBicubic(grid, h, w, stop).data
      const a = f(amp)
      const next = new Float32Array(h * w)
      k.rows(h, stop, (y) => {
        for (let i = y * w, end = i + w; i < end; i++) next[i] = f(total[i]! + f(a * layer[i]!))
      })
      total = next
      ampSum += amp
      amp *= num(p, 'persistence')
      sc /= 2.0
    }
    const div = f(Math.max(1e-6, ampSum))
    for (let i = 0; i < total.length; i++) total[i] = f(total[i]! / div)
    clampPlane(total, stop, h, w)
    return { outputs: [grey3(total, h, w)], preview: null }
  }

  /**
   * Voronoi (nodes_glsl_generative.py:68-118): sites rand(points, 2) (x, y);
   * per pixel the squared distance to every site on linspace(0, 1) grids,
   * topk(2, smallest); an edge where sqrt(d1) − sqrt(d0) < edge_width;
   * colored: colours rand(points, 3) (drawn after the sites) of the nearest
   * site × (1 − edge), else 1 − edge on three channels. EXACT but at a tie:
   * where the two nearest sites are exactly equally far (float32), kernels.ts
   * topk puts the lower index first and torch's order is its own (it agreed
   * about half the time on synthetic ties). At edge_width > 0 a tie is an
   * edge (black) either way; at edge_width 0 the whole pixel can take the
   * other site's colour — not one level off. Exact ties never occurred in
   * 800 trials (400 seeds × 2 grids × 400 points; R2.9 review).
   */
  function Voronoi(_inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const w = Math.trunc(num(p, 'width'))
    const h = Math.trunc(num(p, 'height'))
    const points = Math.trunc(num(p, 'points'))
    const g = seeded(Math.trunc(num(p, 'seed')))
    const sites = g.rand(points * 2)
    const colored = !!p.colored
    const colours = colored ? g.rand(points * 3) : null
    const ys = kn.linspace(0, 1, h)
    const xs = kn.linspace(0, 1, w)
    const ew = f(num(p, 'edge_width'))
    const out = k.tensor(3, h, w)
    const n = h * w
    const dist = new Float32Array(points)
    k.rows(h, stop, (y) => {
      const yv = ys[y]!
      for (let xo = 0; xo < w; xo++) {
        const xv = xs[xo]!
        for (let s = 0; s < points; s++) {
          const dx = f(xv - sites[s * 2]!)
          const dy = f(yv - sites[s * 2 + 1]!)
          dist[s] = f(f(dx * dx) + f(dy * dy))
        }
        const idx = kn.topk(dist, 2, false)
        const i0 = idx[0]!
        const i1 = idx[1]!
        const edge = f(f(Math.sqrt(dist[i1]!)) - f(Math.sqrt(dist[i0]!))) < ew ? 1 : 0
        const keep = f(1 - edge)
        const at = y * w + xo
        for (let c = 0; c < 3; c++) out.data[c * n + at] = colours ? kn.clamp01(f(colours[i0 * 3 + c]! * keep)) : keep
      }
    })
    return { outputs: [out], preview: null }
  }

  /**
   * GradientGenerator (nodes_glsl_generative.py:119-166): linspace(−1, 1)
   * grids; radial t = clamp(sqrt(x² + y²)); linear t = clamp((x·cos + y·sin)
   * · 0.5 + 0.5) (cos and sin of math.radians(angle) in double); c0 + (c1 −
   * c0)·t per channel, clamped. EXACT.
   */
  function GradientGenerator(_inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const w = Math.trunc(num(p, 'width'))
    const h = Math.trunc(num(p, 'height'))
    const { xx, yy } = meshgrid(kn.linspace(-1, 1, h), kn.linspace(-1, 1, w))
    const n = h * w
    const t = new Float32Array(n)
    if (p.type === 'radial') {
      for (let i = 0; i < n; i++) t[i] = kn.clamp01(f(Math.sqrt(f(f(xx[i]! * xx[i]!) + f(yy[i]! * yy[i]!)))))
    }
    else {
      const rad = num(p, 'angle') * (Math.PI / 180)
      const c = f(Math.cos(rad))
      const s = f(Math.sin(rad))
      for (let i = 0; i < n; i++) t[i] = kn.clamp01(f(f(f(f(xx[i]! * c) + f(yy[i]! * s)) * 0.5) + 0.5))
    }
    const c0 = [f(num(p, 'start_r')), f(num(p, 'start_g')), f(num(p, 'start_b'))]
    const c1 = [f(num(p, 'end_r')), f(num(p, 'end_g')), f(num(p, 'end_b'))]
    const out = k.tensor(3, h, w)
    for (let c = 0; c < 3; c++) {
      const span = f(c1[c]! - c0[c]!)
      const d = out.data.subarray(c * n, (c + 1) * n)
      k.rows(h, stop, (y) => {
        for (let i = y * w, end = i + w; i < end; i++) d[i] = f(c0[c]! + f(span * t[i]!))
      })
    }
    return { outputs: [clampOut(out, stop, 0, 1, 'bhwc')], preview: null }
  }

  /** The 5-point laplacian (nodes_glsl_fractal.py _LAPLACIAN). */
  const LAPLACIAN = [0, 1, 0, 1, -4, 1, 0, 1, 0]

  /**
   * ReactionDiffusion (nodes_glsl_fractal.py:17-74): u = 1, v = 0, a
   * rand(1, 1, 2pw, 2pw) patch in the middle (pw = max(8, min(h, w) // 8)),
   * u = 1 − v there; each iteration the laplacians (reflect pad 1, then
   * F.conv2d: torch's Winograd depthwise path on this Mac, kernels.ts
   * conv2dWinograd3x3), u·v·v, u += lap_u − uvv + feed·(1 − u), v += 0.5·lap_v
   * + uvv − (feed + kill)·v (du = dt = 1: their products leave a float as it
   * is), each clamped; v grey on three channels. A Stop check every
   * iteration. EXACT.
   */
  function ReactionDiffusion(_inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const w = Math.trunc(num(p, 'width'))
    const h = Math.trunc(num(p, 'height'))
    const n = h * w
    let u: Tensor = { c: 1, h, w, data: new Float32Array(n).fill(1) }
    let v: Tensor = { c: 1, h, w, data: new Float32Array(n) }
    const g = seeded(Math.trunc(num(p, 'seed')))
    const pw = Math.max(8, Math.floor(Math.min(h, w) / 8))
    const cy = Math.floor(h / 2)
    const cx = Math.floor(w / 2)
    const patch = g.rand(4 * pw * pw)
    for (let y = cy - pw; y < cy + pw; y++) {
      for (let x = cx - pw; x < cx + pw; x++) {
        const val = patch[(y - cy + pw) * 2 * pw + (x - cx + pw)]!
        v.data[y * w + x] = val
        u.data[y * w + x] = f(1 - val)
      }
    }
    const feed = f(num(p, 'feed'))
    const fk = f(num(p, 'feed') + num(p, 'kill'))
    const iterations = Math.trunc(num(p, 'iterations'))
    for (let it = 0; it < iterations; it++) {
      stopNow(stop)
      const lu = kn.conv2dWinograd3x3(kn.padReflect(u, 1, 1, 1, 1), LAPLACIAN, 0, stop).data
      const lv = kn.conv2dWinograd3x3(kn.padReflect(v, 1, 1, 1, 1), LAPLACIAN, 0, stop).data
      const ud = u.data
      const vd = v.data
      const un = new Float32Array(n)
      const vn = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const uu = ud[i]!
        const vv = vd[i]!
        const r = f(f(uu * vv) * vv)
        un[i] = f(uu + f(f(lu[i]! - r) + f(feed * f(1 - uu))))
        vn[i] = f(vv + f(f(f(0.5 * lv[i]!) + r) - f(fk * vv)))
      }
      clampPlane(un, undefined, h, w)
      clampPlane(vn, undefined, h, w)
      u = { c: 1, h, w, data: un }
      v = { c: 1, h, w, data: vn }
    }
    return { outputs: [grey3(v.data, h, w)], preview: null }
  }

  /**
   * Fractal (nodes_glsl_fractal.py:75-153): the viewport's linspace (its ends
   * in double), z and c by type; each iteration z² + c where alive (a
   * pixel's z frozen once |z|² > 4: the node's products with alive keep it,
   * so a pixel that escaped is left alone here), its escape step recorded,
   * the loop ending when none is alive. Then norm = clamp(escape / max_iter),
   * t = norm·6.28318, each channel sin(t·palette + phase)·0.5 + 0.5, black
   * where escape = 0, clamped. LIBRARY (sin).
   */
  function Fractal(_inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const w = Math.trunc(num(p, 'width'))
    const h = Math.trunc(num(p, 'height'))
    const maxIter = Math.trunc(num(p, 'max_iter'))
    const scale = 4.0 / Math.max(num(p, 'zoom'), 1e-3)
    const aspect = w / Math.max(1, h)
    const cxw = num(p, 'center_x')
    const cyw = num(p, 'center_y')
    const xs = kn.linspace(cxw - scale * aspect / 2, cxw + scale * aspect / 2, w)
    const ys = kn.linspace(cyw - scale / 2, cyw + scale / 2, h)
    const { xx, yy } = meshgrid(ys, xs)
    const n = h * w
    const julia = p.type === 'julia'
    const zr = julia ? new Float32Array(xx) : new Float32Array(n)
    const zi = julia ? new Float32Array(yy) : new Float32Array(n)
    const jr = f(num(p, 'julia_cx'))
    const ji = f(num(p, 'julia_cy'))
    const escape = new Float32Array(n)
    let alive = new Int32Array(n)
    for (let i = 0; i < n; i++) alive[i] = i
    let count = n
    for (let it = 0; it < maxIter && count > 0; it++) {
      stopNow(stop)
      let kept = 0
      for (let a = 0; a < count; a++) {
        const i = alive[a]!
        const r = zr[i]!
        const m = zi[i]!
        const cr = julia ? jr : xx[i]!
        const ci = julia ? ji : yy[i]!
        const zr2 = f(f(r * r) - f(m * m))
        const imNew = f(f(f(2 * r) * m) + ci)
        const re = f(f(zr2 + cr) + r * 0)
        const im = f(imNew + m * 0)
        zr[i] = re
        zi[i] = im
        const mag2 = f(f(re * re) + f(im * im))
        if (mag2 > 4) escape[i] = it
        else if (mag2 <= 4) alive[kept++] = i
      }
      count = kept
    }
    const two = f(6.28318)
    const pal = [[f(num(p, 'palette_r')), 0], [f(num(p, 'palette_g')), f(2.094)], [f(num(p, 'palette_b')), f(4.188)]]
    const mi = f(maxIter)
    const out = k.tensor(3, h, w)
    k.rows(h, stop, (y) => {
      for (let i = y * w, end = i + w; i < end; i++) {
        const e = escape[i]!
        const t = f(kn.clamp01(f(e / mi)) * two)
        const keep = e === 0 ? 0 : 1
        for (let c = 0; c < 3; c++) {
          const s = sin32(f(f(t * pal[c]![0]!) + pal[c]![1]!))
          out.data[c * n + i] = f(f(f(s * 0.5) + 0.5) * keep)
        }
      }
    })
    return { outputs: [clampOut(out, stop, 0, 1, 'bhwc')], preview: null }
  }

  // ── Palette quantize ────────────────────────────────────────────────────

  /**
   * Σ over the channels of (a − b)²: torch's sum over a last dim of 3 or 4
   * values (kernels.ts sumContiguous: 3 values one scalar row from 0, 4 one
   * vector lane each, then added in order) is, for these non-negative
   * squares, ((s0 + s1) + s2) + s3 — written out, as sumContiguous's
   * closures cost ~50× the arithmetic here (the spec holds them equal).
   */
  function dist2(a: Float32Array, ao: number, b: Float32Array, bo: number, C: number): number {
    let sum = 0
    for (let c = 0; c < C; c++) {
      const d = f(a[ao + c]! - b[bo + c]!)
      sum = f(sum + f(d * d))
    }
    return sum
  }

  /** The first centre nearest a row (argmin: the first of equal distances). */
  function nearest(rows: Float32Array, at: number, centres: Float32Array, m: number, C: number): number {
    let best = 0
    let bestD = Infinity
    for (let ci = 0; ci < m; ci++) {
      const d = dist2(rows, at, centres, ci * C, C)
      if (d < bestD || ci === 0) { bestD = d; best = ci }
    }
    return best
  }

  /**
   * PaletteQuantize (nodes_glsl_lab.py:107-167), in two passes over the batch
   * (the plan's `gather`): first each picture's area resize to s × s (s =
   * min(96, h, w), of the channels-last batch), kept in the batch state; then,
   * once every picture is sampled, k = max(2, colors) centres from
   * randperm(N)[:k] of the batch's samples together, `iterations` rounds of
   * nearest-centre labels and per-centre means (torch's sum of the rows, ÷
   * their count), and each picture snapped to its nearest centre. LIBRARY (the
   * means).
   */
  function PaletteQuantize(inp: Inputs, p: Params, stop?: Stop, state: State = {}, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const C = x.c
    if (!state.samples) state.samples = []
    const samples = state.samples as Float32Array[]
    if (samples.length < count) {
      const s = Math.min(96, x.h, x.w)
      const small = kn.resizeArea(x, s, s, { cl: true, batch: count, index, stop })
      const m = s * s
      const rows = new Float32Array(m * C)
      for (let i = 0; i < m; i++) for (let c = 0; c < C; c++) rows[i * C + c] = small.data[c * m + i]!
      samples.push(rows)
      return { outputs: [], preview: null }
    }
    if (!state.centres) {
      const all = new Float32Array(samples.reduce((a, r) => a + r.length, 0))
      let o = 0
      for (const r of samples) { all.set(r, o); o += r.length }
      const N = all.length / C
      const g = seeded(Math.trunc(num(p, 'seed')))
      const perm = g.randperm(N)
      const kk = Math.max(2, Math.trunc(num(p, 'colors')))
      const m = Math.min(kk, N)
      let centres = new Float32Array(m * C)
      for (let ci = 0; ci < m; ci++) for (let c = 0; c < C; c++) centres[ci * C + c] = all[perm[ci]! * C + c]!
      const labels = new Int32Array(N)
      for (let it = 0; it < Math.trunc(num(p, 'iterations')); it++) {
        stopNow(stop)
        for (let j = 0; j < N; j++) {
          if ((j & 4095) === 0) stopNow(stop)
          labels[j] = nearest(all, j * C, centres, m, C)
        }
        const next = new Float32Array(centres)
        for (let ci = 0; ci < m; ci++) {
          let members = 0
          for (let j = 0; j < N; j++) if (labels[j] === ci) members++
          if (!members) continue
          const rows = new Float32Array(members * C)
          let r = 0
          for (let j = 0; j < N; j++) if (labels[j] === ci) { rows.set(all.subarray(j * C, j * C + C), r * C); r++ }
          for (let c = 0; c < C; c++) next[ci * C + c] = f(kn.sumStrided(rows, c, members, C) / members)
        }
        centres = next
      }
      state.centres = centres
      state.m = m
    }
    const centres = state.centres as Float32Array
    const m = state.m as number
    const n = x.w * x.h
    const out = k.tensor(C, x.h, x.w)
    const px = new Float32Array(C)
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        for (let c = 0; c < C; c++) px[c] = x.data[c * n + i]!
        const ci = nearest(px, 0, centres, m, C)
        for (let c = 0; c < C; c++) out.data[c * n + i] = centres[ci * C + c]!
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  // ── Stipple ─────────────────────────────────────────────────────────────

  /**
   * Stipple (nodes_glsl_unicorn.py:373-441): cell = max(2, round(min(h, w) /
   * density)); the luma of the picture cropped to whole cells, clamped, to
   * the power gamma, averaged per cell; a dot where rand < 1 − avg (invert:
   * avg), rand((b, sh, sw)) b-major over the batch (its generator kept in the
   * batch state); a soft round dot of radius max(1, round(dot_size·cell /
   * 3)) stamped per cell; dot and background colours (prepare: Python's
   * _hex_to_rgb) mixed by it, the uncropped edge the background. A picture
   * with no whole cell is too small; 4 channels meet the 3-colour background
   * (Python's raise). EXACT.
   */
  function Stipple(inp: Inputs, p: Params, stop?: Stop, state: State = {}, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const { h, w } = x
    const cell = Math.max(2, Math.trunc(pyRound(Math.min(h, w) / num(p, 'density'))))
    const h2 = Math.floor(h / cell) * cell
    const w2 = Math.floor(w / cell) * cell
    if (x.c < 3) throw new Error(ERR.needsRgb)
    const lum = k.luma709(x, stop)
    const lu = k.tensor(1, h2, w2)
    for (let y = 0; y < h2; y++) for (let xo = 0; xo < w2; xo++) lu.data[y * w2 + xo] = kn.clamp01(lum[y * w + xo]!)
    const avg = kn.avgPool2dStrided(kn.powScalar(lu, num(p, 'gamma')), cell, stop)
    if (x.c !== 3) throw new Error(ERR.needsRgb)
    const sh = avg.h
    const sw = avg.w
    if (!state.gen) state.gen = seeded(Math.trunc(num(p, 'seed')) & 0x7fffffff)
    const r = randChunked(state.gen as TorchGenerator, sh * sw, stop)
    const invert = !!p.invert
    const present = k.tensor(1, sh, sw)
    for (let i = 0; i < sh * sw; i++) {
      const a = avg.data[i]!
      present.data[i] = r[i]! < (invert ? a : f(1 - a)) ? 1 : 0
    }
    const rs = Math.max(1, Math.trunc(pyRound(num(p, 'dot_size') * cell / 3.0)))
    const half = f(cell / 2.0)
    const dot = new Float32Array(cell * cell)
    for (let yi = 0; yi < cell; yi++) {
      const yv = f(yi - half)
      for (let xi = 0; xi < cell; xi++) {
        const xv = f(xi - half)
        const d = f(Math.sqrt(f(f(xv * xv) + f(yv * yv))))
        dot[yi * cell + xi] = kn.clamp01(f(1 - Math.max(f(f(d - rs) + 1), 0)))
      }
    }
    const up = kn.resizeNearest(present, h2, w2).data
    const dc = (p.dot as number[]).map(v => f(v))
    const bc = (p.bg as number[]).map(v => f(v))
    const out = k.tensor(3, h, w)
    const n = h * w
    k.rows(h, stop, (y) => {
      for (let xo = 0; xo < w; xo++) {
        const at = y * w + xo
        if (y < h2 && xo < w2) {
          const m = f(up[y * w2 + xo]! * dot[(y % cell) * cell + (xo % cell)]!)
          const inv = f(1 - m)
          for (let c = 0; c < 3; c++) out.data[c * n + at] = f(f(bc[c]! * inv) + f(dc[c]! * m))
        }
        else for (let c = 0; c < 3; c++) out.data[c * n + at] = f(0 + bc[c]!)
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  // ── Flow field ──────────────────────────────────────────────────────────

  /** `_value_noise` (nodes_glsl_unicorn.py:51-57): rand(1, 1, low_h, low_w) seeded seed & 0x7FFFFFFF, bilinear up to (h, w). */
  function valueNoise(h: number, w: number, scale: number, seed: number, stop: Stop): Float32Array {
    const g = seeded(seed & 0x7fffffff)
    const lh = Math.max(2, Math.trunc(h / Math.max(1.0, scale)))
    const lw = Math.max(2, Math.trunc(w / Math.max(1.0, scale)))
    const low: Tensor = { c: 1, h: lh, w: lw, data: randChunked(g, lh * lw, stop) }
    stopNow(stop)
    const up = kn.resizeBilinear(low, h, w).data
    stopNow(stop)
    return up
  }

  /**
   * FlowField (nodes_glsl_unicorn.py:593-652): angle 2π·n1 + rotation·π/180
   * and magnitude n2 from two value noises (seeds seed and seed + 17); the
   * grid linspace(−1, 1) + 2·(cos, sin)(angle)·n2·strength, clamped to
   * [−1, 1]; grid_sample, reflection, align_corners=True. The same field for
   * every picture. The "warp" class (cos, sin: torch's SLEEF).
   */
  function FlowField(inp: Inputs, p: Params, stop?: Stop, _s?: State, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const { h, w } = x
    const seed = Math.trunc(num(p, 'seed'))
    const scale = num(p, 'scale')
    const n1 = valueNoise(h, w, scale, seed, stop)
    const n2 = valueNoise(h, w, scale, seed + 17, stop)
    const twoPi = f(2 * Math.PI)
    const rot = f(num(p, 'rotation') * Math.PI / 180.0)
    const strength = f(num(p, 'strength'))
    const { xx, yy } = meshgrid(kn.linspace(-1, 1, h), kn.linspace(-1, 1, w))
    const n = h * w
    const gx = new Float32Array(n)
    const gy = new Float32Array(n)
    const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v)
    k.rows(h, stop, (y) => {
      for (let i = y * w, end = i + w; i < end; i++) {
        const ang = f(f(twoPi * n1[i]!) + rot)
        const dx = f(f(cos32(ang) * n2[i]!) * strength)
        const dy = f(f(sin32(ang) * n2[i]!) * strength)
        gx[i] = clamp1(f(xx[i]! + f(dx * 2)))
        gy[i] = clamp1(f(yy[i]! + f(dy * 2)))
      }
    })
    stopNow(stop)
    const sampled = kn.gridSample(x, gx, gy, { padding: 'reflection', alignCorners: true, oh: h, ow: w }, stop)
    stopNow(stop)
    return { outputs: [clampOut(sampled, stop, index, count, 'nchw')], preview: null }
  }

  // ── Add noise ───────────────────────────────────────────────────────────

  /**
   * Add noise's seed from its two halves (plan.ts addNoiseSeedBase: the
   * settings and node id; the worker: each batch index's sha256 of the floats
   * the op receives): FNV-1a 64 over `base|h0|h1|…`, as plan.ts
   * addNoiseSeedOf computes it.
   */
  function seedOf(base: string, hashes: string[] | undefined, count: number): bigint {
    if (typeof base !== 'string' || !hashes || hashes.length < count) throw new Error('Add noise’s pictures were not hashed')
    const text = [base, ...hashes.slice(0, count)].join('|')
    const mask = (BigInt(1) << BigInt(64)) - BigInt(1)
    const prime = BigInt('1099511628211')
    let h = BigInt('14695981039346656037')
    for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * prime) & mask
    return h
  }

  /**
   * AddNoise (nodes_sharpen_noise.py:45-81): amount ≤ 0 is a clamp; else
   * image + amount·0.5·noise, clamped, the noise one draw over the whole
   * (B, H, W, C) batch ((B, H, W, 1) monochromatic, the same on every
   * channel): randn, or (rand − 0.5)·2 for uniform. Python draws from the
   * process's global generator; the runner from its own, seeded by seedOf
   * (the node's settings and id, and the floats it receives), or by `seed`
   * when given (the fixtures pass the seed they gave torch). The stream is kept
   * in the batch state and read picture by picture. LIBRARY (randn); uniform
   * is exact.
   */
  function AddNoise(inp: Inputs, p: Params, stop?: Stop, state: State = {}, index = 0, count = 1): EffectResult {
    // The first pass over a batch of more than one: the worker has hashed this picture (its seed needs them all).
    if (state.gathering) return { outputs: [], preview: null }
    const x = inp.image!
    const amount = num(p, 'amount')
    if (amount <= 0) return { outputs: [clampedCopy(x, stop, index, count)], preview: null }
    const mono = !!p.monochromatic
    const n = x.w * x.h
    const per = mono ? n : n * x.c
    const uniform = p.type === 'uniform'
    if (!state.stream) {
      const g = seeded(p.seed !== undefined ? (typeof p.seed === 'string' ? BigInt(p.seed) : p.seed as bigint | number) : seedOf(p.seedBase as string, state.inputHashes as string[] | undefined, count))
      state.stream = uniform
        ? { next: (m: number) => { const r = randChunked(g, m, stop); for (let i = 0; i < m; i++) r[i] = f(f(r[i]! - 0.5) * 2.0); return r } }
        : normalStream(g, per * count, stop)
    }
    const noise = (state.stream as { next(m: number): Float32Array }).next(per)
    const a = f(amount * 0.5)
    const out = k.tensor(x.c, x.h, x.w)
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        for (let c = 0; c < x.c; c++) out.data[c * n + i] = f(x.data[c * n + i]! + f(a * noise[mono ? i : i * x.c + c]!))
      }
    })
    return { outputs: [clampOut(out, stop, index, count, 'bhwc')], preview: null }
  }

  return {
    FilmGrain, Glitch, PerlinNoise, Voronoi, GradientGenerator, ReactionDiffusion, Fractal, PaletteQuantize, Stipple, FlowField, AddNoise,
  }
}

export type NoiseCore = ReturnType<typeof noiseCore>
