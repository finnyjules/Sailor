/**
 * Joining two clips (step 3, R6.3): Crossfade (nodes_video_effects.py:356-421)
 * and Transition (nodes_video_pro.py:810-948), one output frame at a time, as
 * Python's float32 torch code computes it.
 *
 * SELF-CONTAINED apart from its arguments, as ./time.ts is: the compositor
 * worker composes it from its source text (../cores.ts). `kn` is R2.2's
 * kernels (linspace, the bilinear resize, affine_grid, grid_sample, the
 * depthwise correlation), `rng` R2.3's torch generator.
 *
 * The output is A's head (A alone), the transition (A's last d frames with
 * B's first d), then B's tail (B alone), each frame clamped to [0, 1]; B is
 * resized to A's size (bilinear, align_corners=False) wherever the sizes
 * differ. The plan reads the two clips side by side through the transition
 * (./plan.ts 'join') and calls `frame` once per output frame with its part:
 *   `_part` 'a'   — [A's frame]: handed on;
 *           'mix' — [A's frame, B's frame], transition frame `_i` of `_d`;
 *           'b'   — [B's frame]: resized to `_w` × `_h`.
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { KernelsCore } from '../../effects/core/kernels'
import type { RngCore } from '../../effects/core/rng'
import type { VideoOpResult } from './time'

/**
 * A join's frames: the range of each clip it reads ([from, to) of the input
 * batch; Crossfade's trims), the overlap `d`, and the output's head (A's
 * frames alone), `trans` (the transition's frames) and tail (B's alone).
 */
export interface JoinLayout { a: [number, number]; b: [number, number]; d: number; head: number; trans: number; tail: number }

export function joinCore(tk: TensorCore, kn: KernelsCore, rng: RngCore) {
  const f = Math.fround

  /** Python's `%` of an int by a positive int (torch.roll's wrap). */
  const pyMod = (a: number, n: number) => ((a % n) + n) % n

  /**
   * The join's layout from its widgets and the two clips' lengths (both at
   * least one frame: a kept batch never has none). Crossfade trims first
   * (:377-382): ia = max(0, min(trim_in_a, Ta − 1)); oa = Ta when trim_out_a
   * < 0, else max(ia + 1, min(trim_out_a, Ta)); the same for B. Transition
   * reads both whole. d = max(1, min(duration, Ta, Tb)).
   */
  function layout(p: Record<string, unknown>, Ta: number, Tb: number): JoinLayout {
    if (!(Ta >= 1 && Tb >= 1)) throw new Error('A clip to join has no frames')
    // Crossfade has trims; Transition has none.
    const crossfade = p.trim_in_a !== undefined
    const range = (T: number, tin: unknown, tout: unknown): [number, number] => {
      if (!crossfade) return [0, T]
      const i = Math.max(0, Math.min(tin as number, T - 1))
      const o = (tout as number) < 0 ? T : Math.max(i + 1, Math.min(tout as number, T))
      return [i, o]
    }
    const a = range(Ta, p.trim_in_a, p.trim_out_a)
    const b = range(Tb, p.trim_in_b, p.trim_out_b)
    const la = a[1] - a[0]
    const lb = b[1] - b[0]
    const d = Math.max(1, Math.min(p.duration as number, la, lb))
    return { a, b, d, head: la - d, trans: d, tail: lb - d }
  }

  /** `_ease` (nodes_video_pro.py:38-44; Crossfade's own lines are the same) of one float32, each op rounded to float32 (cos: this runtime's, LIBRARY). */
  function ease(t: number, mode: unknown): number {
    if (mode === 'ease_in') return f(t * t)
    if (mode === 'ease_out') {
      const a = f(1 - t)
      return f(1 - f(a * a))
    }
    if (mode === 'ease_in_out') return f(0.5 - f(0.5 * f(Math.cos(f(t * f(Math.PI))))))
    return t
  }

  /** alpha = the curve of linspace(0, 1, d) (float32). EXACT but ease_in_out (LIBRARY: cos). */
  function alphaOf(d: number, curve: unknown): Float32Array {
    const t = kn.linspace(0, 1, d)
    for (let i = 0; i < d; i++) t[i] = ease(t[i]!, curve)
    return t
  }

  /** B at A's size: F.interpolate(bilinear, align_corners=False) where the sizes differ (EXACT). */
  const sized = (x: Tensor, h: number, w: number): Tensor => (x.h === h && x.w === w ? x : kn.resizeBilinear(x, h, w))

  function clampInPlace(t: Tensor): Tensor {
    const d = t.data
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!
      if (v < 0) d[i] = 0
      else if (v > 1) d[i] = 1
    }
    return t
  }

  /** a·(1 − α) + b·α, each op rounded to float32 (both Crossfade and Transition's dissolve). */
  function dissolve(a: Tensor, b: Tensor, alpha: number): Tensor {
    const out = tk.tensor(a.c, a.h, a.w)
    const g = f(1 - alpha)
    const x = a.data
    const y = b.data
    const o = out.data
    for (let i = 0; i < o.length; i++) o[i] = f(f(x[i]! * g) + f(y[i]! * alpha))
    return out
  }

  /**
   * Whip pan (:872-897): A shifted by direction·α·2 and B by
   * direction·(α − 1)·2 (affine_grid + grid_sample, zeros), added and
   * clamped; then a 1 × kw box blur, kw = max(1, int(15·float(α·(1 − α))·4
   * + 1)) made odd (conv2d, zero padding kw // 2 across only). LIBRARY
   * (affine_grid's product, the convolution's sum).
   */
  function whip(a: Tensor, b: Tensor, alpha: number, left: boolean, stop?: () => boolean): Tensor {
    const dir = left ? -1 : 1
    const txa = f(f(dir * alpha) * 2)
    const txb = f(f(dir * f(alpha - 1)) * 2)
    const { h: H, w: W } = a
    const warp = (x: Tensor, tx: number) => {
      const g = kn.affineGrid([[1, 0, tx], [0, 1, 0]], H, W)
      return kn.gridSample(x, g.gx, g.gy, { padding: 'zeros', alignCorners: false, oh: H, ow: W }, stop)
    }
    const aw = warp(a, txa)
    const bw = warp(b, txb)
    const c = aw.data
    const bd = bw.data
    for (let i = 0; i < c.length; i++) {
      const v = f(c[i]! + bd[i]!)
      c[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    let kw = Math.max(1, Math.trunc(15 * f(alpha * f(1 - alpha)) * 4 + 1))
    if (kw % 2 === 0) kw += 1
    if (kw <= 1) return aw
    // Zero padding kw // 2 on each side of every row, then a valid 1 × kw correlation per channel.
    const p = kw >> 1
    const Wp = W + 2 * p
    const padded = tk.tensor(3, H, Wp)
    for (let ch = 0; ch < 3; ch++) {
      for (let y = 0; y < H; y++) padded.data.set(c.subarray(ch * H * W + y * W, ch * H * W + (y + 1) * W), ch * H * Wp + y * Wp + p)
    }
    const kernel = new Float32Array(kw).fill(f(1 / kw))
    return kn.conv2dDepthwise(padded, kernel, 1, kw, stop)
  }

  /**
   * Zoom in / out (:899-911): t = float(α); A at za = 1 + (1.5 | −0.5)·t and
   * B at zb = (2 | 0.5) − (1 | −0.5)·t (each at least 0.05, in doubles), θ =
   * [[1/z, 0, 0], [0, 1/z, 0]] (border); a·(1 − t) + b·t, the scalars
   * rounded to float32. LIBRARY (affine_grid's product).
   */
  function zoom(a: Tensor, b: Tensor, alpha: number, inward: boolean, stop?: () => boolean): Tensor {
    const t = alpha
    const za = Math.max(0.05, 1.0 + (inward ? 1.5 : -0.5) * t)
    const zb = Math.max(0.05, (inward ? 2.0 : 0.5) - (inward ? 1.0 : -0.5) * t)
    const { h: H, w: W } = a
    const warp = (x: Tensor, z: number) => {
      const g = kn.affineGrid([[1.0 / z, 0, 0], [0, 1.0 / z, 0]], H, W)
      return kn.gridSample(x, g.gx, g.gy, { padding: 'border', alignCorners: false, oh: H, ow: W }, stop)
    }
    const aw = warp(a, za)
    const bw = warp(b, zb)
    const ga = f(1.0 - t)
    const gb = f(t)
    const o = aw.data
    const y = bw.data
    for (let i = 0; i < o.length; i++) o[i] = f(f(o[i]! * ga) + f(y[i]! * gb))
    return aw
  }

  /** The glitch's band count for a transition frame of this alpha: max(1, int(intensity·12)). */
  const intensityOf = (alpha: number) => 1.0 - Math.abs(2.0 * alpha - 1.0)
  const slicesOf = (alpha: number) => Math.max(1, Math.trunc(intensityOf(alpha) * 12))

  /**
   * The glitch's shifts for transition frame `i` (:926-929): Python draws
   * torch.rand(1) once per band, per frame, in order, from the global
   * generator; the runner from its own, seeded `seed` (ruling (e):
   * glitchSeed, the node's settings and its two clips), so frame i draws
   * after every earlier frame's bands. dx = int((r − 0.5)·intensity·80).
   */
  function glitchShifts(alphas: Float32Array, i: number, seed: bigint): Int32Array {
    const g = rng.generator()
    g.seed(seed)
    for (let k = 0; k < i; k++) g.rand(slicesOf(alphas[k]!))
    const intensity = intensityOf(alphas[i]!)
    const r = g.rand(slicesOf(alphas[i]!))
    const out = new Int32Array(r.length)
    for (let k = 0; k < r.length; k++) out[k] = Math.trunc((r[k]! - 0.5) * intensity * 80)
    return out
  }

  /**
   * Glitch (:913-930): from A while t < 0.5, else B; red rolled right by
   * int(intensity·30) and blue left by as much; then n bands of H // n rows
   * (from the top; the rows below the last band stay), each rolled by its
   * own shift. Selection only: EXACT under the seed.
   */
  function glitch(a: Tensor, b: Tensor, alphas: Float32Array, i: number, seed: bigint): Tensor {
    const t = alphas[i]!
    const src = t < 0.5 ? a : b
    const { h: H, w: W } = src
    const offset = Math.trunc(intensityOf(t) * 30)
    const dx = glitchShifts(alphas, i, seed)
    const n = dx.length
    const sliceH = Math.max(1, Math.floor(H / n))
    const shiftOf = new Int32Array(H)
    for (let k = 0; k < n; k++) {
      const y0 = k * sliceH
      const y1 = Math.min(H, y0 + sliceH)
      for (let y = y0; y < y1; y++) shiftOf[y] = dx[k]!
    }
    const out = tk.tensor(3, H, W)
    const px = H * W
    const s = src.data
    const o = out.data
    const chanShift = [offset, 0, -offset]
    for (let ch = 0; ch < 3; ch++) {
      for (let y = 0; y < H; y++) {
        const row = ch * px + y * W
        const by = shiftOf[y]! + chanShift[ch]!
        for (let x = 0; x < W; x++) o[row + x] = s[row + pyMod(x - by, W)]!
      }
    }
    return out
  }

  /**
   * Light leak (:932-946): the dissolve plus a warm glow at the middle,
   * falloff = exp(−(yy² + xx²)·2) over linspace(−1, 1) on each axis, times
   * (1, 0.65, 0.25), times peak = 4α(1 − α), times 0.6; clamped. LIBRARY
   * (exp).
   */
  function lightLeak(a: Tensor, b: Tensor, alpha: number): Tensor {
    const out = dissolve(a, b, alpha)
    const { h: H, w: W } = a
    const yy = kn.linspace(-1, 1, H)
    const xx = kn.linspace(-1, 1, W)
    const peak = f(f(4 * alpha) * f(1 - alpha))
    const tint = [1, f(0.65), f(0.25)]
    const k06 = f(0.6)
    const o = out.data
    const px = H * W
    for (let y = 0; y < H; y++) {
      const y2 = f(yy[y]! * yy[y]!)
      for (let x = 0; x < W; x++) {
        const fall = f(Math.exp(f(-f(y2 + f(xx[x]! * xx[x]!)) * 2)))
        for (let ch = 0; ch < 3; ch++) {
          const warm = ch === 0 ? fall : f(fall * tint[ch]!)
          const i = ch * px + y * W + x
          o[i] = f(o[i]! + f(f(warm * peak) * k06))
        }
      }
    }
    return clampInPlace(out)
  }

  /** The glitch's seed as the plan hands it (a decimal string of an unsigned 64-bit value). */
  function seedOf(p: Record<string, unknown>): bigint {
    if (typeof p._seed !== 'string' || !/^\d+$/.test(p._seed)) throw new Error('The glitch’s seed is missing')
    return BigInt(p._seed)
  }

  /**
   * One output frame of Crossfade or Transition (`style` absent: Crossfade,
   * a dissolve), by its part (the plan's `_part`, `_i`, `_d`, `_w`, `_h`).
   * Clamped to [0, 1], as the node's final clamp.
   */
  function frame(inputs: Tensor[], p: Record<string, unknown>, _state?: ArrayBuffer, _index?: number, _count?: number, stop?: () => boolean): VideoOpResult {
    const part = p._part
    if (part === 'a') {
      const x = inputs[0]
      if (!x) throw new Error('A video frame is missing')
      return { out: x }
    }
    if (part === 'b') {
      const x = inputs[0]
      if (!x) throw new Error('A video frame is missing')
      const r = sized(x, p._h as number, p._w as number)
      return { out: r === x ? x : clampInPlace(r) }
    }
    if (part !== 'mix') throw new Error('A joined frame has no part')
    const a = inputs[0]
    const bIn = inputs[1]
    if (!a || !bIn) throw new Error('A video frame is missing')
    const b = sized(bIn, a.h, a.w)
    const d = p._d as number
    const i = p._i as number
    if (!(Number.isInteger(d) && d >= 1 && Number.isInteger(i) && i >= 0 && i < d)) throw new Error('A joined frame is out of its transition')
    const alphas = alphaOf(d, p.curve)
    const alpha = alphas[i]!
    const style = p.style ?? 'dissolve'
    if (stop?.()) throw new Error('Stopped')
    let out: Tensor
    if (style === 'whip_pan_left' || style === 'whip_pan_right') out = whip(a, b, alpha, style === 'whip_pan_left', stop)
    else if (style === 'zoom_in' || style === 'zoom_out') out = zoom(a, b, alpha, style === 'zoom_in', stop)
    else if (style === 'glitch') out = glitch(a, b, alphas, i, seedOf(p))
    else if (style === 'light_leak') out = lightLeak(a, b, alpha)
    else out = dissolve(a, b, alpha)
    return { out: clampInPlace(out) }
  }

  return { layout, alphaOf, glitchShifts, frame }
}

export type JoinCore = ReturnType<typeof joinCore>
