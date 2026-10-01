/**
 * Background remove's work on one picture after the service's answer (step 3,
 * R7.1; comfy_extras/nodes_bg_remove.py:105-145), given the answer as PIL's
 * RGBA (8 bits a channel):
 *
 *   alpha = cut.split()[3]; edge_softness > 0: GaussianBlur(radius)
 *   alpha_np = alpha / 255; rgb_np = cut.convert("RGB") / 255      (float32)
 *   transparent    RGBA: rgb_np, alpha_np
 *   premultiplied  RGB:  rgb_np · alpha_np                          (float32)
 *   matte_only     RGB:  alpha_np three times
 *   mask           alpha_np
 *   preview        trunc(f32(255·x)) of RGBA: the output's RGB (premultiplied
 *                  for premultiplied) with alpha; matte: grey with alpha 1
 *
 * Exact against Python for the same answer, but the blur: Pillow's
 * GaussianBlur (box passes) is not ported; the alpha is blurred by R2's
 * torchvision gaussian_blur (../effects/core/kernels.ts) at σ = radius,
 * kernel 2·⌈3σ⌉ + 1 (narrowed on a picture smaller than it), and rounded back
 * to 8 bits as Pillow's blur is: judged by eye (the user's matching rule).
 *
 * The output's 8-bit form is chosen by the caller: 'round' (round(f32(x·255)),
 * the hand-off between runner nodes, exact for every value k / 255) or
 * 'trunc' (trunc(f32(255·x)), what Save image and an encoder write).
 *
 * SELF-CONTAINED apart from its argument (the kernels core), as the other
 * cores are: the Frame's worker composes it from its source text
 * (compositor/worker.ts `px.cutout`); ../effects/cores.ts builds it in this
 * thread for tests.
 */
import type { Tensor } from '../effects/core/tensor'

export type CutoutMode = 'transparent' | 'premultiplied' | 'matte_only'

export interface CutoutJob {
  /** The answer as PIL's convert("RGBA") has it: 4 bytes a pixel. */
  rgba: Uint8Array
  w: number
  h: number
  mode: CutoutMode
  /** edge_softness: 0 = no blur. */
  sigma: number
  quant: 'round' | 'trunc'
  /** 4: the picture keeps its alpha (transparent, as a file); 3: RGB only (a frame of a batch, or the 3-channel outputs). */
  channels: 3 | 4
  /** Also save_live_preview's RGBA pixels. */
  preview: boolean
}

export interface CutoutResult {
  /** The output picture, 8-bit by `quant`, interleaved, `channels` a pixel. */
  picture: Uint8Array
  /** The alpha (after the blur), 8-bit as Pillow holds it: the mask is alpha / 255. */
  alpha: Uint8Array
  /** save_live_preview's pixels: RGBA, trunc(f32(255·x)). */
  preview?: Uint8Array
}

export function cutoutCore(kn: { gaussianBlur(t: Tensor, ksize: number, sigma: number, stop?: () => boolean): Tensor }) {
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

  /** The alpha blurred (σ > 0) as an 8-bit L picture, as Pillow's blur hands it back. */
  function blurAlpha(alpha: Uint8Array, w: number, h: number, sigma: number, stop?: () => boolean): Uint8Array {
    if (!(sigma > 0)) return alpha
    let ksize = 2 * Math.ceil(3 * sigma) + 1
    // torchvision refuses a kernel whose half reaches the picture's side; Pillow doesn't refuse: narrowed.
    const widest = 2 * Math.min(w, h) - 1
    if (ksize > widest) ksize = widest
    if (ksize <= 1) return alpha
    const data = new Float32Array(w * h)
    for (let i = 0; i < data.length; i++) data[i] = unit[alpha[i]!]!
    const out = kn.gaussianBlur({ c: 1, h, w, data }, ksize, sigma, stop)
    const back = new Uint8Array(w * h)
    for (let i = 0; i < back.length; i++) back[i] = round8(out.data[i]!)
    return back
  }

  function cutout(job: CutoutJob, stop?: () => boolean): CutoutResult {
    const { rgba, w, h, mode, quant, channels } = job
    const n = w * h
    if (rgba.length !== n * 4) throw new Error('The cut-out is not the size it says')
    const own = new Uint8Array(n)
    for (let i = 0; i < n; i++) own[i] = rgba[i * 4 + 3]!
    const alpha = blurAlpha(own, w, h, job.sigma, stop)
    const q = quant === 'trunc' ? trunc8 : round8
    const picture = new Uint8Array(n * channels)
    const preview = job.preview ? new Uint8Array(n * 4) : undefined
    for (let i = 0; i < n; i++) {
      if ((i & 0xFFFF) === 0 && stop && stop()) throw new Error('Stopped')
      const a = unit[alpha[i]!]!
      for (let c = 0; c < 3; c++) {
        let x: number
        if (mode === 'matte_only') x = a
        else if (mode === 'premultiplied') x = f(unit[rgba[i * 4 + c]!]! * a)
        else x = unit[rgba[i * 4 + c]!]!
        picture[i * channels + c] = q(x)
        if (preview) preview[i * 4 + c] = trunc8(x)
      }
      if (channels === 4) picture[i * 4 + 3] = q(a)
      if (preview) preview[i * 4 + 3] = mode === 'matte_only' ? 255 : trunc8(a)
    }
    return { picture, alpha, ...(preview ? { preview } : {}) }
  }

  return { cutout, blurAlpha, trunc8, round8 }
}
