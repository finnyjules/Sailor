/**
 * The effects' tensors (step 3, R2.1): pictures and masks as the float32
 * tensors Python's effect nodes hold, and back to the bytes the runner keeps.
 *
 * SELF-CONTAINED apart from its argument, as ../../pixels/core.ts is: the
 * compositor worker composes it from its source text (compositor/worker.ts
 * workerScript) after `pixelsCore`, and tests call the same code in-thread.
 * Do not reference anything from outside this body but `px`.
 *
 * A tensor is planar, C × H × W (Python's is H × W × C; per-pixel arithmetic
 * is the same, element by element). Values are float32 (Math.fround after
 * every operation, as torch's CPU kernels round each op).
 */
import type { PixelsCore, PixelsPicture } from '../../pixels/core'

/** A picture or mask as the tensor Python holds: planar, `c` channels of h × w float32. */
export interface Tensor { c: number; h: number; w: number; data: Float32Array }

/** What one effect op makes from one picture (or one batch index): its outputs, and the tensor its live preview shows (output 0 when null). */
export interface EffectResult { outputs: Tensor[]; preview: Tensor | null }

export function tensorCore(px: PixelsCore) {
  const f = Math.fround

  /**
   * Python raises: the runner fails the node with plain words (R2 rule 6).
   * The cores throw `new Error(key)`; the main thread maps the key to its
   * message (shared/runner/effects.ts EFFECT_ERROR_MESSAGES).
   */
  const EFFECT_ERRORS = {
    needsRgb: 'EFFECT_NEEDS_RGB',
    tooSmall: 'EFFECT_PICTURE_TOO_SMALL',
    batchesDiffer: 'EFFECT_BATCHES_DIFFER',
  } as const

  /** A Python double meeting a float32 tensor: torch rounds the scalar to float32 once. */
  const s32 = (x: number) => f(x)

  function tensor(c: number, h: number, w: number): Tensor {
    return { c, h, w, data: new Float32Array(c * h * w) }
  }

  /**
   * The tensor Python holds for a picture of this source (rule 2): the
   * channels tensorChannels gives (3 or 4), each byte b as channelTable's
   * float (b / 255; an Image card's alpha through its 1 − mask round trip).
   * Python's 1×1 blank (no data) is 1 × 1 black RGB.
   */
  function fromPicture(p: PixelsPicture, stop?: () => boolean): Tensor {
    const c = px.tensorChannels(p)
    const t = tensor(c, p.h, p.w)
    const d = p.data
    if (!d) return t
    const n = p.w * p.h
    const tables = Array.from({ length: c }, (_, k) => px.channelTable(p.source, k))
    rows(p.h, stop, (y) => {
      for (let k = 0; k < c; k++) {
        const table = tables[k]!
        const out = t.data.subarray(k * n, (k + 1) * n)
        for (let i = y * p.w, end = i + p.w; i < end; i++) out[i] = table[d[i * 4 + k]!]!
      }
    })
    return t
  }

  /**
   * The float32 tensor an effect hands on to the effects and Frames reading it
   * (fix round 1: Python passes the float itself): a kept file of a 16-byte
   * header ('SFT1', then c, h, w as little-endian uint32) and the planar
   * float32 data, little-endian.
   */
  function tensorFileOf(t: Tensor): Uint8Array {
    const out = new Uint8Array(16 + t.data.length * 4)
    const v = new DataView(out.buffer)
    v.setUint32(0, 0x31544653, true)
    v.setUint32(4, t.c, true)
    v.setUint32(8, t.h, true)
    v.setUint32(12, t.w, true)
    const body = new Float32Array(out.buffer, 16, t.data.length)
    body.set(t.data)
    // The data is written in this machine's order: refuse a big-endian one rather than write a wrong file.
    if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('This machine stores numbers big-endian')
    return out
  }

  /** A kept tensor file back as its tensor (a copy, so the bytes' buffer may be anything). */
  function fromTensorFile(bytes: Uint8Array): Tensor {
    const bad = () => new Error('A picture this effect reads could not be read')
    if (bytes.length < 16) throw bad()
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (v.getUint32(0, true) !== 0x31544653) throw bad()
    const c = v.getUint32(4, true)
    const h = v.getUint32(8, true)
    const w = v.getUint32(12, true)
    if (c < 1 || c > 4 || bytes.length !== 16 + c * h * w * 4) throw bad()
    const t = tensor(c, h, w)
    new Uint8Array(t.data.buffer).set(bytes.subarray(16))
    return t
  }

  /** A kept 16-bit greyscale mask's inflated PNG scanlines (any filter) as a 1-channel tensor, u / 65535 in float32. */
  function fromMask16(bytes: Uint8Array, w: number, h: number): Tensor {
    const bpp = 2
    const len = 2 * w
    const stride = 1 + len
    if (bytes.length < stride * h) throw new Error('A mask could not be read')
    const prev = new Uint8Array(len)
    const cur = new Uint8Array(len)
    const t = tensor(1, h, w)
    for (let y = 0; y < h; y++) {
      const row = y * stride
      const ft = bytes[row]!
      for (let i = 0; i < len; i++) {
        const x = bytes[row + 1 + i]!
        const a = i >= bpp ? cur[i - bpp]! : 0
        const b = prev[i]!
        const c = i >= bpp ? prev[i - bpp]! : 0
        let v: number
        if (ft === 0) v = x
        else if (ft === 1) v = x + a
        else if (ft === 2) v = x + b
        else if (ft === 3) v = x + ((a + b) >> 1)
        else if (ft === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
        }
        else throw new Error('A mask could not be read')
        cur[i] = v & 255
      }
      for (let x = 0; x < w; x++) t.data[y * w + x] = f(((cur[2 * x]! << 8) | cur[2 * x + 1]!) / 65535)
      prev.set(cur)
    }
    return t
  }

  /**
   * 8-bit bytes of a tensor, interleaved with its own channels:
   *   'trunc' — np.clip(255.·x, 0, 255).astype(uint8): trunc(f32(255·x))
   *             (save_live_preview, save_images; R1.5);
   *   'round' — the hand-off's round(255·clamp(x, 0, 1)), halves to even
   *             (_image_tensor_to_data_url; R1.4 clip).
   */
  function quantize(t: Tensor, mode: 'trunc' | 'round', stop?: () => boolean): Uint8Array {
    const n = t.w * t.h
    const c = t.c
    const out = new Uint8Array(n * c)
    const data = t.data
    rows(t.h, stop, (y) => {
      for (let k = 0; k < c; k++) {
        const base = k * n
        for (let i = y * t.w, end = i + t.w; i < end; i++) {
          if (mode === 'trunc') {
            const v = f(255 * data[base + i]!)
            out[i * c + k] = v > 0 ? (v > 255 ? 255 : Math.trunc(v)) : 0
          }
          else {
            const x = data[base + i]!
            out[i * c + k] = px.roundHalfEven(f((x > 0 ? (x > 1 ? 1 : x) : 0) * 255))
          }
        }
      }
    })
    return out
  }

  /** A 1-channel tensor as the runner keeps a mask: 16-bit PNG scanlines (px.mask16Of). */
  function mask16(t: Tensor): Uint8Array {
    if (t.c !== 1) throw new Error('A mask has one channel')
    const d = t.data
    return px.mask16Of(t.w, t.h, i => d[i]!)
  }

  /**
   * `_luma` (nodes_color_filters.py:12-13) of channels 0–2: each product with
   * the float32 weight rounded, then (p0 + p1) + p2.
   */
  function luma709(t: Tensor, stop?: () => boolean): Float32Array {
    if (t.c < 3) throw new Error(EFFECT_ERRORS.needsRgb)
    const n = t.w * t.h
    const r = t.data.subarray(0, n)
    const g = t.data.subarray(n, 2 * n)
    const b = t.data.subarray(2 * n, 3 * n)
    const wr = f(0.2126)
    const wg = f(0.7152)
    const wb = f(0.0722)
    const out = new Float32Array(n)
    rows(t.h, stop, (y) => {
      for (let i = y * t.w, end = i + t.w; i < end; i++) out[i] = f(f(f(wr * r[i]!) + f(wg * g[i]!)) + f(wb * b[i]!))
    })
    return out
  }

  /** torch's clamp(x, 0, 1) on one float32. */
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

  /** A Stop check every 64 rows of a loop over `h` rows (R2.1). */
  function rows(h: number, stop: (() => boolean) | undefined, each: (y: number) => void): void {
    for (let y = 0; y < h; y++) {
      if (stop && (y & 63) === 0 && stop()) throw new Error('Stopped')
      each(y)
    }
  }

  return { EFFECT_ERRORS, s32, tensor, fromPicture, tensorFileOf, fromTensorFile, fromMask16, quantize, mask16, luma709, clamp01, rows }
}

export type TensorCore = ReturnType<typeof tensorCore>
