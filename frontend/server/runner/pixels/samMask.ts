/**
 * Mask by text's and Mask extractor's work around SAM 3's answer (step 3,
 * R7.4; comfy_extras/nodes_matte_ml.py:105-132 and :167-217), exact against
 * Python given the same mask (float32 throughout, as torch computes it):
 *
 *   m     = the answer's masks (white = selected), each k / 255, fitted to the
 *           picture with R0's bilinear when its size differs; for text, their
 *           union (the most of each pixel: CLIPSeg marked every match, ruling (k))
 *   text: threshold > 0 → (m > float32(threshold)) as 0 / 1
 *   feather > 0 → torchvision gaussian_blur(m, 2·ceil(3·feather) + 1, feather)
 *           (../effects/core/kernels.ts, LIBRARY); a kernel whose half reaches
 *           the picture's side is narrowed (torch refuses it and Python fails:
 *           the user's fix-bugs rule), as ./cutout.ts narrows its blur
 *   invert → 1 − m;  clamp(0, 1)                      the [1, H, W] mask
 *   preview = image·(1 − m·0.5) + red·m·0.5, clamped  (_mask_preview, the first
 *           picture), saved as save_live_preview's trunc(f32(255·x)), RGB
 *
 * SELF-CONTAINED: the Frame's worker composes it from its source text
 * (compositor/worker.ts `px.samMask`); ../effects/cores.ts builds it in this
 * thread for tests.
 */
import type { Tensor } from '../effects/core/tensor'

/** One mask of the answer: 8-bit grey (PIL's L), `w` × `h`. */
export interface SamAnswerMask { l: Uint8Array; w: number; h: number }

export interface SamMaskJob {
  /** The answer's masks (none: an all-black mask, ruling (k)). */
  masks: SamAnswerMask[]
  /** The first picture's size: the mask's. */
  w: number
  h: number
  /** Mask by text's threshold; null for Mask extractor (it has none). */
  threshold: number | null
  feather: number
  invert: boolean
  /** The first picture's RGB as Python's tensor holds it (k / 255), 3 bytes a pixel: for the preview. */
  rgb: Uint8Array
}

export interface SamMaskResult {
  /** The float32 mask, `w` × `h`. */
  mask: Float32Array
  /** save_live_preview's pixels: RGB, trunc(f32(255·x)). */
  preview: Uint8Array
}

export function samMaskCore(
  kn: { gaussianBlur(t: Tensor, ksize: number, sigma: number, stop?: () => boolean): Tensor },
  px: { bilinear(src: Float32Array, c: number, sh: number, sw: number, dh: number, dw: number, channelsLast: boolean): Float32Array },
) {
  const f = Math.fround
  /** k / 255 in float32, for every byte. */
  const unit = new Float32Array(256)
  for (let k = 0; k < 256; k++) unit[k] = f(k / 255)
  const stopNow = (stop?: () => boolean) => {
    if (stop?.()) throw new Error('Stopped')
  }

  /** The answer's masks as one float32 mask at the picture's size: each k / 255, fitted, their union. */
  function union(masks: readonly SamAnswerMask[], w: number, h: number, stop?: () => boolean): Float32Array {
    const out = new Float32Array(w * h)
    for (const m of masks) {
      stopNow(stop)
      if (m.l.length !== m.w * m.h) throw new Error('The mask is not the size it says')
      let v: Float32Array = new Float32Array(m.w * m.h)
      for (let i = 0; i < v.length; i++) v[i] = unit[m.l[i]!]!
      if (m.w !== w || m.h !== h) v = px.bilinear(v, 1, m.h, m.w, h, w, false)
      for (let i = 0; i < out.length; i++) if (v[i]! > out[i]!) out[i] = v[i]!
    }
    return out
  }

  /** What Python does after the model (threshold, feather, invert, clamp), on a float32 mask `w` × `h`. */
  function finish(mask: Float32Array, w: number, h: number, threshold: number | null, feather: number, invert: boolean, stop?: () => boolean): Float32Array {
    let m: Float32Array = new Float32Array(mask)
    if (threshold !== null && threshold > 0) {
      // torch compares a float32 tensor with a Python float in float32.
      const t = f(threshold)
      for (let i = 0; i < m.length; i++) m[i] = m[i]! > t ? 1 : 0
    }
    if (feather > 0) {
      let ksize = 2 * Math.ceil(3 * feather) + 1
      const widest = 2 * Math.min(w, h) - 1
      if (ksize > widest) ksize = widest
      if (ksize > 1) {
        stopNow(stop)
        m = kn.gaussianBlur({ c: 1, h, w, data: m }, ksize, feather, stop).data
      }
    }
    if (invert) for (let i = 0; i < m.length; i++) m[i] = f(1 - m[i]!)
    for (let i = 0; i < m.length; i++) {
      const v = m[i]!
      m[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    return m
  }

  /** _mask_preview of the first picture, as save_live_preview writes it (trunc(f32(255·x))). */
  function preview(rgb: Uint8Array, mask: Float32Array): Uint8Array {
    const out = new Uint8Array(rgb.length)
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i]!
      const half = f(m * 0.5)
      const keep = f(1 - half)
      for (let c = 0; c < 3; c++) {
        const img = f(unit[rgb[i * 3 + c]!]! * keep)
        // red · m · 0.5: (red · m) · 0.5, red 1 on the first channel and 0 on the others.
        const red = c === 0 ? f(f(m) * 0.5) : f(f(0 * m) * 0.5)
        let x = f(img + red)
        x = x < 0 ? 0 : x > 1 ? 1 : x
        const v = f(255 * x)
        out[i * 3 + c] = v <= 0 ? 0 : v >= 255 ? 255 : Math.trunc(v)
      }
    }
    return out
  }

  /** The node's whole work after the call. */
  function samMask(job: SamMaskJob, stop?: () => boolean): SamMaskResult {
    const { w, h } = job
    if (job.rgb.length !== w * h * 3) throw new Error('The picture is not the size it says')
    const mask = finish(union(job.masks, w, h, stop), w, h, job.threshold, job.feather, job.invert, stop)
    stopNow(stop)
    return { mask, preview: preview(job.rgb, mask) }
  }

  return { union, finish, preview, samMask }
}
