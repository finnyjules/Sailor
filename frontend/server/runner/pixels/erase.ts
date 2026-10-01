/**
 * Object removal's work around the service's call (step 3, R7.3;
 * comfy_extras/_inpaint.py lama_inpaint:105-132), exact against Python given
 * the same fill:
 *
 *   m8   = (mask · 255.0).clip(0, 255).astype(uint8)     (float32 product, truncated)
 *   m8   = cv2.dilate(m8, ones(3, 3), iterations=grow)   (../pixels/maxFilter.ts at 2·grow + 1:
 *                                                         a 3 × 3 square grown `grow` times is one
 *                                                         square, clipped at the edges)
 *   m8.max() == 0: the frame unchanged (no call)
 *   b    = m8 / 255.0;  fill = answer / 255.0             (float32)
 *   out  = fill·b + frame·(1 − b)                         (float32, the frame's own k / 255)
 *
 * Python runs LaMa at 512 × 512 and resizes its fill back (INTER_CUBIC); the
 * service answers at full size (USER ruling (c)), so the fill is its answer.
 *
 * The output's 8-bit form is chosen by the caller, as ./cutout.ts does: 'round'
 * (the hand-off between runner nodes) or 'trunc' (Save image, an encoder). The
 * preview is save_live_preview's trunc(f32(255·x)).
 *
 * SELF-CONTAINED: the Frame's worker composes it from its source text
 * (compositor/worker.ts `px.erase`); ../effects/cores.ts builds it in this
 * thread for tests.
 */

export interface EraseJob {
  /** The picture's RGB as Python's tensor holds it (k / 255): 3 bytes a pixel. */
  rgb: Uint8Array
  /** The service's fill at the picture's size, RGB: 3 bytes a pixel. */
  fill: Uint8Array
  /** The grown 8-bit mask: 1 byte a pixel. */
  mask: Uint8Array
  w: number
  h: number
  quant: 'round' | 'trunc'
  /** Also save_live_preview's RGB pixels. */
  preview: boolean
}

export interface EraseResult {
  /** The output picture, 8-bit by `quant`, RGB interleaved. */
  picture: Uint8Array
  /** save_live_preview's pixels: RGB, trunc(f32(255·x)). */
  preview?: Uint8Array
}

export function eraseCore() {
  const f = Math.fround
  /** k / 255 in float32, for every byte. */
  const unit = new Float32Array(256)
  for (let k = 0; k < 256; k++) unit[k] = f(k / 255)

  /** trunc(f32(255·x)) clipped to 0..255: np.clip(255.0 * x, 0, 255).astype(uint8). */
  const trunc8 = (x: number): number => {
    const v = f(255 * x)
    return v <= 0 ? 0 : v >= 255 ? 255 : Math.trunc(v)
  }
  /** round(f32(clamp(x)·255)), halves to even: the hand-off between runner nodes. */
  const round8 = (x: number): number => {
    const v = f((x < 0 ? 0 : x > 1 ? 1 : x) * 255)
    const r = Math.round(v)
    return r - v === 0.5 && r % 2 === 1 ? r - 1 : r
  }

  /** Python's 8 bits of a float mask: (mask · 255.0).clip(0, 255).astype(uint8). NaN reads as 0. */
  function mask8(mask: Float32Array): Uint8Array {
    const out = new Uint8Array(mask.length)
    for (let i = 0; i < mask.length; i++) {
      const v = f(mask[i]! * 255)
      out[i] = v >= 255 ? 255 : v > 0 ? Math.trunc(v) : 0
    }
    return out
  }

  /** Whether an 8-bit mask has nothing to fill (its max is 0: dilating it keeps it so). */
  function empty(m8: Uint8Array): boolean {
    for (let i = 0; i < m8.length; i++) if (m8[i] !== 0) return false
    return true
  }

  /** The composite in float32, interleaved RGB: fill·b + frame·(1 − b). */
  function composite(rgb: Uint8Array, fill: Uint8Array, mask: Uint8Array, w: number, h: number, stop?: () => boolean): Float32Array {
    const n = w * h
    if (rgb.length !== n * 3 || fill.length !== n * 3 || mask.length !== n) throw new Error('The picture, its fill and its mask are not one size')
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      if ((i & 0xFFFF) === 0 && stop && stop()) throw new Error('Stopped')
      const b = unit[mask[i]!]!
      const keep = f(1 - b)
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c
        out[j] = f(f(unit[fill[j]!]! * b) + f(unit[rgb[j]!]! * keep))
      }
    }
    return out
  }

  function erase(job: EraseJob, stop?: () => boolean): EraseResult {
    const x = composite(job.rgb, job.fill, job.mask, job.w, job.h, stop)
    const q = job.quant === 'trunc' ? trunc8 : round8
    const picture = new Uint8Array(x.length)
    const preview = job.preview ? new Uint8Array(x.length) : undefined
    for (let i = 0; i < x.length; i++) {
      picture[i] = q(x[i]!)
      if (preview) preview[i] = trunc8(x[i]!)
    }
    return { picture, ...(preview ? { preview } : {}) }
  }

  return { erase, composite, mask8, empty, trunc8, round8 }
}
