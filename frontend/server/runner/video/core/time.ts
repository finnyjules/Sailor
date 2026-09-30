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

/**
 * The time effects (nodes_video_effects.py; R6.1's pilots, R6.2 the rest).
 */
export function timeCore(tk: TensorCore) {
  const f = Math.fround

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

  return { select, trail }
}

export type TimeCore = ReturnType<typeof timeCore>
