/**
 * Audio waveform (step 3, R6.7; nodes_video_pro.py:632-802): a sound drawn
 * as a clip, one output frame at a time.
 *
 * The user's matching rule, applied to R6.7 by the controller: the waveform
 * must LOOK the same side by side (the layout of bars, lines and circles,
 * the colours, the sizes and the motion), not match Pillow bit for bit. So:
 *   - each frame's bands follow Python's steps (the window's real FFT on a
 *     power of two of at least 256, its magnitudes, K logarithmic bands, each
 *     band's mean, the frame's peak, the sensitivity, the smoothing) in
 *     float32 where Python keeps float32, with R6.5's shared float64 FFT
 *     (`ft`) rounded once, and this runtime's log10 and pow for the band
 *     edges: the bands land within float32's step of Python's, and a height
 *     can differ by one pixel where Python's own sat on a whole number;
 *   - the drawing is ./draw.ts (Pillow's rectangle and wide line exactly,
 *     its ellipse fitted);
 *   - Python's squeezed stereo is FIXED: the plan hands each frame the
 *     sound's channels mixed to one (their mean, as Python mixes a planar
 *     sound), never a stereo file's samples interleaved as one track.
 *
 * The window of samples each frame reads comes in its params (`_window`,
 * float32, handed on by the plan as the sound decodes); a frame with none
 * (no sound, or past its end) decays the bands before, as Python's frames
 * with fewer than 8 samples do. The bands are carried as the op's state.
 *
 * SELF-CONTAINED apart from its arguments, as ./time.ts is: the compositor
 * worker composes it from its source text (../cores.ts). `ft` is R6.5's FFT,
 * `dr` ./draw.ts, `look` gives `_hex_rgb`'s port.
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { VideoOpResult } from './time'
import type { FftCore } from './fft'
import type { DrawCore } from './draw'

export function waveformCore(
  tk: TensorCore, ft: FftCore, dr: DrawCore,
  look: { hexRgb(s: unknown, fallback: readonly [number, number, number]): [number, number, number] },
) {
  const f = Math.fround
  const table = new Float32Array(256)
  for (let k = 0; k < 256; k++) table[k] = f(k / 255)

  /** The bands' count: bar_count, or at least 64 for `wave` (:717). */
  const bandsOf = (p: Record<string, unknown>) => {
    const k = Math.trunc(p.bar_count as number)
    return p.style === 'wave' ? Math.max(64, k) : k
  }

  /** `np.geomspace(1, bins, K + 1).astype(int)`: 10 ** (k · log10(bins) / K), its ends set to 1 and bins. */
  function edges(bins: number, K: number): Int32Array {
    const out = new Int32Array(K + 1)
    const step = Math.log10(bins) / K
    for (let k = 0; k <= K; k++) out[k] = k === 0 ? 1 : k === K ? bins : Math.trunc(10 ** (k * step))
    return out
  }

  /**
   * One frame's bands (:722-747) from its window (at least 8 samples) and the
   * frame before's: float32 like Python's, the smoothing applied.
   */
  function bands(window: Float32Array, prev: Float32Array, K: number, sens: number, sm: number): Float32Array {
    const bits = 32 - Math.clz32(window.length - 1)
    const n = 1 << Math.max(8, bits)
    const x = new Float64Array(n)
    x.set(window)
    const { re, im } = ft.rfft(x)
    const bins = re.length
    const mag = new Float32Array(bins)
    for (let i = 0; i < bins; i++) mag[i] = f(Math.hypot(f(re[i]!), f(im[i]!)))
    const e = edges(bins, K)
    const en = new Float32Array(K)
    for (let k = 0; k < K; k++) {
      const lo = e[k]!
      const hi = Math.min(bins, Math.max(lo + 1, e[k + 1]!))
      let s = 0
      for (let i = lo; i < hi; i++) s += mag[i]!
      en[k] = hi > lo ? f(s / (hi - lo)) : Number.NaN
    }
    let peak = -Infinity
    for (let k = 0; k < K; k++) if (en[k]! > peak) peak = en[k]!
    if (peak > 0) for (let k = 0; k < K; k++) en[k] = f(en[k]! / peak)
    const fs = f(sens)
    const keep = f(1.0 - sm)
    const fsm = f(sm)
    const cur = new Float32Array(K)
    for (let k = 0; k < K; k++) cur[k] = f(f(f(en[k]! * fs) * keep) + f(prev[k]! * fsm))
    return cur
  }

  /** `int(c · 255)` of each of `_hex_rgb`'s doubles (:699-700). */
  const colour = (s: unknown, fallback: readonly [number, number, number]) => look.hexRgb(s, fallback).map(v => Math.trunc(v * 255))

  /** One frame drawn (:751-798) from its bands, clipped to [0, 1.5]. */
  function draw(p: Record<string, unknown>, cur: Float32Array): Uint8Array {
    const W = Math.trunc(p.width as number)
    const H = Math.trunc(p.height as number)
    const K = cur.length
    const fg = colour(p.color, [1, 1, 1])
    const c = dr.canvas(W, H, colour(p.bg_color, [0, 0, 0]))
    const e = (k: number) => { const v = cur[k]!; return v < 0 ? 0 : v > 1.5 ? 1.5 : v }
    const style = p.style
    const barW = Math.max(1, Math.floor(W / K) - 2)
    const gap = Math.max(1, Math.floor((W - barW * K) / (K + 1)))
    const mid = Math.floor(H / 2)
    if (style === 'bars') {
      const s = f(H * 0.85)
      for (let k = 0; k < K; k++) {
        const h = Math.trunc(f(e(k) * s))
        const x0 = gap + k * (barW + gap)
        dr.rectangle(c, x0, H - h, x0 + barW, H, fg)
      }
    }
    else if (style === 'mirrored_bars' || style === 'dots') {
      const s = f(H * 0.4)
      const r = Math.max(2, Math.floor(barW / 2))
      for (let k = 0; k < K; k++) {
        const h = Math.trunc(f(e(k) * s))
        const x0 = gap + k * (barW + gap)
        if (style === 'mirrored_bars') dr.rectangle(c, x0, mid - h, x0 + barW, mid + h, fg)
        else {
          dr.ellipse(c, x0, mid - h, x0 + 2 * r, mid - h + 2 * r, fg)
          dr.ellipse(c, x0, mid + h - 2 * r, x0 + 2 * r, mid + h, fg)
        }
      }
    }
    else if (style === 'wave') {
      const pts: [number, number][] = []
      const s6 = f(0.6)
      for (let x = 0; x < W; x += 2) {
        const k = Math.min(Math.trunc((x / W) * K), K - 1)
        pts.push([x, mid - Math.trunc(f(f(f(e(k) - 0.5) * H) * s6))])
      }
      if (pts.length >= 2) dr.line(c, pts, 3, fg)
    }
    else if (style === 'radial') {
      const cx = Math.floor(W / 2)
      const cy = Math.floor(H / 2)
      const r0 = Math.min(W, H) * 0.18
      const rMax = Math.min(W, H) * 0.45
      const span = f(rMax - r0)
      const fr0 = f(r0)
      for (let k = 0; k < K; k++) {
        const ang = 2.0 * Math.PI * (k / K) - Math.PI / 2.0
        const r1 = f(fr0 + f(e(k) * span))
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        // Pillow truncates the float ends to whole pixels.
        const a: [number, number] = [Math.trunc(cx + ca * r0), Math.trunc(cy + sa * r0)]
        const b: [number, number] = [Math.trunc(f(cx + f(f(ca) * r1))), Math.trunc(f(cy + f(f(sa) * r1)))]
        dr.line(c, [a, b], 3, fg)
      }
    }
    return c.rgb
  }

  /**
   * One output frame (op `wave.frame`): the bands from this frame's window
   * (`_window`) and the ones carried, drawn, as k / 255 floats. The bands
   * are handed on as the state.
   */
  function frame(_inputs: Tensor[], p: Record<string, unknown>, state: ArrayBuffer | undefined, _index: number, _count: number, stop?: () => boolean): VideoOpResult {
    const K = bandsOf(p)
    const prev = state && state.byteLength === 4 * K ? new Float32Array(state) : new Float32Array(K)
    const win = p._window instanceof Float32Array ? p._window : null
    const sm = p.smoothing as number
    let cur: Float32Array
    if (win && win.length >= 8) cur = bands(win, prev, K, p.sensitivity as number, sm)
    else {
      cur = new Float32Array(K)
      const fsm = f(sm)
      for (let k = 0; k < K; k++) cur[k] = f(prev[k]! * fsm)
    }
    if (stop?.()) throw new Error('Stopped')
    const rgb = draw(p, cur)
    const W = Math.trunc(p.width as number)
    const H = Math.trunc(p.height as number)
    const out = tk.tensor(3, H, W)
    const N = W * H
    for (let i = 0; i < N; i++) {
      out.data[i] = table[rgb[3 * i]!]!
      out.data[N + i] = table[rgb[3 * i + 1]!]!
      out.data[2 * N + i] = table[rgb[3 * i + 2]!]!
    }
    return { out, state: cur.buffer as ArrayBuffer }
  }

  return { bandsOf, edges, bands, draw, frame }
}

export type WaveformCore = ReturnType<typeof waveformCore>
