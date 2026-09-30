/**
 * Animated noise (step 3, R6.7; nodes_video_effects.py:429-509): a clip of
 * value noise, one output frame at a time, as Python's float32 torch code
 * computes it.
 *
 * Python makes one noise texture of (H + max_pan) × (W + max_pan) (a seeded
 * torch.rand grid, bilinearly enlarged: `_value_noise_2d`) and moves an
 * H × W window through it. The runner never holds that texture: it keeps
 * only the small grid torch drew (carried as the op's state) and works out
 * the window's pixels of the enlargement directly, each by the same four
 * taps and the same float32 sums torch's separable bilinear uses (every
 * enlargement here has width + height ≥ 129; pixels/core.ts `bilinear`).
 * So the frames are EXACT, bit for bit, while memory stays one grid.
 *
 * SELF-CONTAINED apart from its arguments, as ./time.ts is: the compositor
 * worker composes it from its source text (../cores.ts). `rng` is R2.3's
 * torch generator; `look` gives `_hex_rgb`'s port (Python's own parse_hex
 * here reads the same: stripped, '#' cut, 3 or 6 characters, int(…, 16)).
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { RngCore } from '../../effects/core/rng'
import type { VideoOpResult } from './time'

/** The widgets' own numbers: the frames, the window's travel, the texture and the grid torch draws. */
export interface NoiseLayout { T: number; W: number; H: number; maxPan: number; bigW: number; bigH: number; lowW: number; lowH: number }

export function noiseClipCore(tk: TensorCore, rng: RngCore, look: { hexRgb(s: unknown, fallback: readonly [number, number, number]): [number, number, number] }) {
  const f = Math.fround
  const fma = (a: number, b: number, c: number) => f(a * b + c)

  /** execute's sizes (:458-462) and `_value_noise_2d`'s grid (:47-49), in Python's doubles. */
  function layout(p: Record<string, unknown>): NoiseLayout {
    const T = Math.trunc(p.frame_count as number)
    const H = Math.trunc(p.height as number)
    const W = Math.trunc(p.width as number)
    const maxPan = Math.max(1, Math.trunc(T * (p.speed as number)) + 1)
    const bigH = H + maxPan
    const bigW = W + maxPan
    const scale = Math.max(1.0, p.noise_scale as number)
    return { T, W, H, maxPan, bigW, bigH, lowH: Math.max(2, Math.trunc(bigH / scale)), lowW: Math.max(2, Math.trunc(bigW / scale)) }
  }

  /** Python's % of an int by a positive int. */
  const pyMod = (a: number, n: number) => ((a % n) + n) % n

  /**
   * The window's top-left for frame t (:486-503): int() of Python's doubles,
   * then clamped to the texture. `breathe` and `swirl` go through sin and cos
   * (this runtime's; an int() of one may differ from Python's by one step
   * where the double sits within an ulp of a whole number: BAND).
   */
  function offsets(p: Record<string, unknown>, t: number, L: NoiseLayout): [number, number] {
    const speed = p.speed as number
    const m = L.maxPan
    let ox: number
    let oy: number
    switch (p.motion) {
      case 'pan_x': ox = pyMod(Math.trunc(t * speed), m); oy = 0; break
      case 'pan_y': ox = 0; oy = pyMod(Math.trunc(t * speed), m); break
      case 'diagonal':
        ox = pyMod(Math.trunc(t * speed * 0.7), m)
        oy = ox
        break
      case 'breathe':
        ox = Math.trunc((Math.sin(t * 0.1 * speed) * 0.5 + 0.5) * (m - 1))
        oy = Math.trunc((Math.cos(t * 0.1 * speed) * 0.5 + 0.5) * (m - 1))
        break
      default: {
        const angle = t * speed * 0.05
        const radius = Math.min(t * speed * 0.5, m / 2.0)
        ox = Math.trunc(Math.cos(angle) * radius + m / 2.0)
        oy = Math.trunc(Math.sin(angle) * radius + m / 2.0)
      }
    }
    return [Math.max(0, Math.min(L.bigW - L.W, ox)), Math.max(0, Math.min(L.bigH - L.H, oy))]
  }

  /** torch.rand((1, 1, lowH, lowW), generator seeded seed & 0x7FFFFFFF) (:47-50): the grid the texture is enlarged from. */
  function grid(p: Record<string, unknown>, L: NoiseLayout): Float32Array {
    const g = rng.generator()
    g.seed(Math.trunc(p.seed as number) & 0x7fffffff)
    return g.rand(L.lowH * L.lowW)
  }

  /** The bilinear taps (align_corners=False, size mode) of output indices [from, from + n) of an in → out enlargement. */
  function taps(inSize: number, outSize: number, from: number, n: number) {
    const i0 = new Int32Array(n)
    const i1 = new Int32Array(n)
    const l0 = new Float32Array(n)
    const l1 = new Float32Array(n)
    const scale = f(inSize / outSize)
    for (let j = 0; j < n; j++) {
      let real = fma(scale, f(from + j + 0.5), -0.5)
      if (real < 0) real = 0
      const x0 = Math.min(Math.floor(real), inSize - 1)
      const lambda = f(Math.min(Math.max(f(real - x0), 0), 1))
      i0[j] = x0
      i1[j] = x0 + (x0 < inSize - 1 ? 1 : 0)
      l1[j] = lambda
      l0[j] = f(1 - lambda)
    }
    return { i0, i1, l0, l1 }
  }

  /** The texture's H × W window at (ox, oy): torch's separable bilinear sums (x first, then y), per pixel. */
  function windowOf(low: Float32Array, L: NoiseLayout, ox: number, oy: number): Float32Array {
    const ty = taps(L.lowH, L.bigH, oy, L.H)
    const tx = taps(L.lowW, L.bigW, ox, L.W)
    const out = new Float32Array(L.W * L.H)
    const sw = L.lowW
    for (let y = 0; y < L.H; y++) {
      const r0 = ty.i0[y]! * sw
      const r1 = ty.i1[y]! * sw
      const a0 = ty.l0[y]!
      const a1 = ty.l1[y]!
      for (let x = 0; x < L.W; x++) {
        const c0 = tx.i0[x]!
        const c1 = tx.i1[x]!
        const b0 = tx.l0[x]!
        const b1 = tx.l1[x]!
        const t0 = fma(low[r0 + c0]!, b0, f(low[r0 + c1]! * b1))
        const t1 = fma(low[r1 + c0]!, b0, f(low[r1 + c1]! * b1))
        out[y * L.W + x] = fma(t0, a0, f(t1 * a1))
      }
    }
    return out
  }

  /**
   * One output frame (op `nclip.frame`): the grid drawn on the first frame and
   * carried; the window; `dark·(1 − n) + light·n` per channel in float32
   * (torch.tensor of parse_hex's doubles), clamped to [0, 1].
   */
  function frame(_inputs: Tensor[], p: Record<string, unknown>, state: ArrayBuffer | undefined, index: number, _count: number, stop?: () => boolean): VideoOpResult {
    const L = layout(p)
    const low = state && state.byteLength === 4 * L.lowW * L.lowH ? new Float32Array(state) : grid(p, L)
    if (stop?.()) throw new Error('Stopped')
    const [ox, oy] = offsets(p, index, L)
    const n = windowOf(low, L, ox, oy)
    const dark = look.hexRgb(p.dark_color, [0, 0, 0]).map(v => f(v))
    const light = look.hexRgb(p.light_color, [1, 1, 1]).map(v => f(v))
    const out = tk.tensor(3, L.H, L.W)
    const N = L.W * L.H
    for (let k = 0; k < 3; k++) {
      const d = dark[k]!
      const l = light[k]!
      for (let i = 0; i < N; i++) {
        const v = f(f(d * f(1 - n[i]!)) + f(l * n[i]!))
        out.data[k * N + i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    const whole = low.byteOffset === 0 && low.byteLength === low.buffer.byteLength ? low : low.slice()
    return { out, state: whole.buffer as ArrayBuffer }
  }

  return { layout, offsets, frame }
}

export type NoiseClipCore = ReturnType<typeof noiseClipCore>
