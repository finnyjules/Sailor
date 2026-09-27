/**
 * The picture utilities' pixel work (step 3, R1.4; R2 builds on it), inside
 * ONE self-contained function, as compositor/plane.ts `compositorCore` is: it
 * refers to nothing outside itself but JavaScript built-ins, so the compositor
 * worker runs it from its source text (compositor/worker.ts) and tests call
 * the same code in-thread. Do not reference anything from outside this body.
 *
 * FLOAT32, OP BY OP, as torch's CPU kernels (torch 2.10, measured with
 * scripts/runner_values_fixtures.py `bilinear` and probes over 1–4 channels,
 * contiguous and channels-last tensors):
 *   interpolate (bilinear, align_corners=False): source index
 *   fma(scale, d + 0.5, −0.5) clamped at 0, λ = src − i0 clamped to [0, 1].
 *   Then one of three sums, chosen as torch chooses its kernel:
 *   - 4 channels, channels-last memory (ComfyUI's movedim), any size; or
 *     4 channels at output width + height ≤ 128: the four corner weights a·b
 *     rounded, then unfused adds in the order y1x1, y1x0, y0x1, y0x0;
 *   - 1–3 channels at output width + height ≤ 128: the same weights, then a
 *     fused chain y0x1, y0x0, y1x0, y1x1;
 *   - otherwise (width + height ≥ 129): separable, x first,
 *     t0 = fma(A, lx0, B·lx1), t1 = fma(C, lx0, D·lx1), out = fma(t0, ly0, t1·ly1).
 *   That is torch on two or more threads, as ComfyUI runs it (torch's default
 *   count; measured the same on 2–8). On ONE thread, 1–3 channels in
 *   channels-last memory keep the ≤ 128 fused chain at every size.
 *   The Frame's resize (compositor/plane.ts compositorCore.resizeBilinear)
 *   carries the same arithmetic in its own self-contained core; the parity
 *   spec (runner-bilinear) holds the two to the same torch fixtures.
 */

/** A picture as sharp decodes it (compositor/plane.ts RawPicture): RGBA8, `data` null for Python's 1×1 blank. */
export interface PixelsPicture {
  source: string
  w: number
  h: number
  data: Uint8Array | null
}

export function pixelsCore() {
  const f = Math.fround
  const fma = (a: number, b: number, c: number) => f(a * b + c)

  /** Torch's round(): halves to the even neighbour. */
  function roundHalfEven(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /**
   * The bilinear taps along one side. `scaleFactor` is torch's `scales`
   * argument (F.interpolate(scale_factor=s) with recompute_scale_factor
   * unset, R2.7): the source step is then compute_scales_value's f32(1 / s),
   * not f32(in / out). Without it, the size-mode step, as before.
   */
  function taps(inSize: number, outSize: number, scaleFactor?: number) {
    const i0 = new Int32Array(outSize)
    const i1 = new Int32Array(outSize)
    const l0 = new Float32Array(outSize)
    const l1 = new Float32Array(outSize)
    const scale = scaleFactor !== undefined && scaleFactor > 0 ? f(1 / scaleFactor) : f(inSize / outSize)
    for (let d = 0; d < outSize; d++) {
      let real = fma(scale, f(d + 0.5), -0.5)
      if (real < 0) real = 0
      const x0 = Math.min(Math.floor(real), inSize - 1)
      const lambda = f(Math.min(Math.max(f(real - x0), 0), 1))
      i0[d] = x0
      i1[d] = x0 + (x0 < inSize - 1 ? 1 : 0)
      l1[d] = lambda
      l0[d] = f(1 - lambda)
    }
    return { i0, i1, l0, l1 }
  }

  /** Which of torch's sums a resize takes (see the header). */
  function bilinearKind(c: number, dw: number, dh: number, channelsLast: boolean): 'weights-cl' | 'weights' | 'separable' {
    if (c === 4 && (channelsLast || dw + dh <= 128)) return 'weights-cl'
    return dw + dh <= 128 ? 'weights' : 'separable'
  }

  /**
   * `F.interpolate(t, size=(dh, dw), mode='bilinear', align_corners=False)` on
   * a (C, H, W) channel-first plane; `channelsLast` says the tensor's memory
   * format (a movedim'd ComfyUI picture), which changes torch's sum for 4 channels.
   * `scales` ([height, width]): F.interpolate's scale_factor path (see `taps`).
   */
  function bilinear(src: Float32Array, c: number, sh: number, sw: number, dh: number, dw: number, channelsLast: boolean, scales?: readonly [number, number]): Float32Array {
    if (!Number.isInteger(c) || c < 1 || c > 4) throw new Error(`A picture of ${c} channels can’t be resized here`)
    if (src.length !== c * sh * sw) throw new Error('The picture to resize is the wrong size')
    const out = new Float32Array(c * dh * dw)
    const ty = taps(sh, dh, scales?.[0])
    const tx = taps(sw, dw, scales?.[1])
    const kind = bilinearKind(c, dw, dh, channelsLast)
    const inN = sh * sw
    const outN = dh * dw
    for (let k = 0; k < c; k++) {
      const s = src.subarray(k * inN, (k + 1) * inN)
      const d = out.subarray(k * outN, (k + 1) * outN)
      for (let y = 0; y < dh; y++) {
        const r0 = ty.i0[y]! * sw
        const r1 = ty.i1[y]! * sw
        const a0 = ty.l0[y]!
        const a1 = ty.l1[y]!
        const row = y * dw
        for (let x = 0; x < dw; x++) {
          const c0 = tx.i0[x]!
          const c1 = tx.i1[x]!
          const b0 = tx.l0[x]!
          const b1 = tx.l1[x]!
          let o: number
          if (kind === 'separable') {
            const t0 = fma(s[r0 + c0]!, b0, f(s[r0 + c1]! * b1))
            const t1 = fma(s[r1 + c0]!, b0, f(s[r1 + c1]! * b1))
            o = fma(t0, a0, f(t1 * a1))
          }
          else {
            const w00 = f(a0 * b0)
            const w01 = f(a0 * b1)
            const w10 = f(a1 * b0)
            const w11 = f(a1 * b1)
            if (kind === 'weights-cl') {
              o = f(s[r1 + c1]! * w11)
              o = f(f(s[r1 + c0]! * w10) + o)
              o = f(f(s[r0 + c1]! * w01) + o)
              o = f(f(s[r0 + c0]! * w00) + o)
            }
            else {
              o = f(s[r0 + c1]! * w01)
              o = fma(s[r0 + c0]!, w00, o)
              o = fma(s[r1 + c0]!, w10, o)
              o = fma(s[r1 + c1]!, w11, o)
            }
          }
          d[row + x] = o
        }
      }
    }
    return out
  }

  /** Python's tensor channels for a picture of this source (compositor/plane.ts toTensor). */
  function tensorChannels(p: PixelsPicture): 3 | 4 {
    if (p.source === 'provider') return 4
    // 'made' (R1.5 follow-up): a picture the runner kept from a card's tensor
    // (Text mask clipping an Image card): the card's channel count, its alpha
    // already the tensor's, so read as it is.
    if ((p.source === 'card' || p.source === 'made') && p.data) {
      for (let i = 3; i < p.data.length; i += 4) if (p.data[i]! < 255) return 4
    }
    return 3
  }

  /**
   * Each byte's tensor value on channel k, as toTensor builds it: b / 255 in
   * float32; an Image card's alpha goes through its 1 − mask round trip.
   */
  function channelTable(source: string, k: number): Float32Array {
    const t = new Float32Array(256)
    for (let b = 0; b < 256; b++) {
      const v = f(b / 255)
      t[b] = k === 3 && source === 'card' ? f(1 - f(1 - v)) : v
    }
    return t
  }

  /** A mask's 16-bit PNG scanlines (filter 0), round(v·65535) clamped, as compositorCore.mask16Scanlines. */
  function mask16Of(w: number, h: number, value: (i: number) => number): Uint8Array {
    const stride = 1 + 2 * w
    const out = new Uint8Array(stride * h)
    for (let y = 0; y < h; y++) {
      const row = y * stride
      for (let x = 0; x < w; x++) {
        const v = value(y * w + x)
        const u = Math.floor((v < 0 ? 0 : v > 1 ? 1 : v) * 65535 + 0.5)
        out[row + 1 + 2 * x] = u >> 8
        out[row + 2 + 2 * x] = u & 255
      }
    }
    return out
  }

  /**
   * ImageToMask: channel `index` of the picture's tensor, as a mask's 16-bit
   * scanlines; with `float` (R2.8 fix round 1: read by an effect), the float32
   * mask Python holds too (`data`), which the runner hands on.
   */
  function channelMask16(p: PixelsPicture, index: number, float = false): { w: number; h: number; scanlines: Uint8Array; data?: Float32Array } {
    if (index >= tensorChannels(p)) throw new Error('This picture has no alpha channel to make a mask from')
    const d = p.data
    if (!d) return { w: p.w, h: p.h, scanlines: mask16Of(p.w, p.h, () => 0), ...(float ? { data: new Float32Array(p.w * p.h) } : {}) }
    const table = channelTable(p.source, index)
    const scanlines = mask16Of(p.w, p.h, i => table[d[i * 4 + index]!]!)
    if (!float) return { w: p.w, h: p.h, scanlines }
    const data = new Float32Array(p.w * p.h)
    for (let i = 0; i < data.length; i++) data[i] = table[d[i * 4 + index]!]!
    return { w: p.w, h: p.h, scanlines, data }
  }

  /**
   * Text mask's clip, first half: the render's luma L (mw × mh) as the mask
   * 1 − L/255, resized to the source (w × h, a contiguous (1, 1, H, W)
   * tensor) when the sizes differ. Returns 1 − mask for `clip`, the mask's
   * 16-bit scanlines (the node's mask output) and the float32 mask itself
   * (`mask`: handed on to an effect, R2.8 fix round 1).
   */
  function clipBegin(l: Uint8Array, mw: number, mh: number, w: number, h: number): { alpha: Float32Array; scanlines: Uint8Array; mask: Float32Array } {
    let m: Float32Array = new Float32Array(mw * mh)
    for (let i = 0; i < m.length; i++) m[i] = f(1 - f(l[i]! / 255))
    if (mw !== w || mh !== h) m = bilinear(m, 1, mh, mw, h, w, false)
    const alpha = new Float32Array(w * h)
    for (let i = 0; i < alpha.length; i++) alpha[i] = f(1 - m[i]!)
    return { alpha, scanlines: mask16Of(w, h, i => m[i]!), mask: m }
  }

  /**
   * Text mask's clip, per picture: source × alpha on every tensor channel, as
   * the 8-bit pixels `_image_tensor_to_data_url` sends (round(255·clamp(x))),
   * interleaved RGB or RGBA as the tensor. With `trunc` (R1.5 follow-up: only
   * Save image / Preview image read it), as save_images writes them instead:
   * np.clip(255.·x, 0, 255).astype(uint8), trunc(f32(255·x)).
   */
  function clip(p: PixelsPicture, alpha: Float32Array, trunc = false): { w: number; h: number; channels: 3 | 4; px: Uint8Array } {
    const c = tensorChannels(p)
    const n = p.w * p.h
    if (alpha.length !== n) throw new Error('The pictures this card reads are of different sizes')
    const px = new Uint8Array(n * c)
    const d = p.data
    if (!d) return { w: p.w, h: p.h, channels: c, px }
    for (let k = 0; k < c; k++) {
      const table = channelTable(p.source, k)
      for (let i = 0; i < n; i++) {
        const v = f(table[d[i * 4 + k]!]! * alpha[i]!)
        if (trunc) {
          const t = f(255 * v)
          px[i * c + k] = t < 0 ? 0 : t > 255 ? 255 : Math.trunc(t)
        }
        else px[i * c + k] = roundHalfEven(f((v < 0 ? 0 : v > 1 ? 1 : v) * 255))
      }
    }
    return { w: p.w, h: p.h, channels: c, px }
  }

  /**
   * Save image's pixels (nodes.py SaveImage.save_images, R1.5): each tensor
   * value v as np.clip(255.·v, 0, 255).astype(uint8), trunc(f32(255·v)),
   * interleaved RGB or RGBA as the tensor. The identity on b / 255, but not
   * on an Image card's alpha, whose 1 − mask round trip loses a level on 95
   * of the 256 values (as Python does). Python's 1×1 blank is black RGB.
   */
  function saveBytes(p: PixelsPicture): { w: number; h: number; channels: 3 | 4; px: Uint8Array } {
    const c = tensorChannels(p)
    const n = p.w * p.h
    const px = new Uint8Array(n * c)
    const d = p.data
    if (!d) return { w: p.w, h: p.h, channels: c, px }
    const lut = new Uint8Array(256)
    for (let k = 0; k < c; k++) {
      const table = channelTable(p.source, k)
      for (let b = 0; b < 256; b++) {
        const v = f(255 * table[b]!)
        lut[b] = v < 0 ? 0 : v > 255 ? 255 : Math.trunc(v)
      }
      for (let i = 0; i < n; i++) px[i * c + k] = lut[d[i * 4 + k]!]!
    }
    return { w: p.w, h: p.h, channels: c, px }
  }

  // ── Pillow's Image.resize(size, LANCZOS) on 8-bit pictures (Resample.c) ──
  // Coefficients in double, fixed point with 22 fraction bits, rounded sums
  // shifted and clamped; horizontal pass, then vertical. RGBA is resized
  // premultiplied (RGBa, MULDIV255) and divided back (255·c / a, truncated;
  // alpha 0 and 255 kept as they are). Measured equal to Pillow 12 on random
  // pictures (scripts/runner_cards_fixtures.py `save_image.lanczos`).
  const PRECISION_BITS = 22

  function lanczos(x: number): number {
    const sinc = (v: number) => {
      if (v === 0) return 1
      const t = v * Math.PI
      return Math.sin(t) / t
    }
    return x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0
  }

  function pilCoeffs(inSize: number, outSize: number): { ksize: number; bounds: Int32Array; kk: Int32Array } {
    const scale = inSize / outSize
    const filterscale = scale < 1 ? 1 : scale
    const support = 3 * filterscale
    const ksize = Math.ceil(support) * 2 + 1
    const bounds = new Int32Array(outSize * 2)
    const kk = new Int32Array(outSize * ksize)
    const k = new Float64Array(ksize)
    const ss = 1 / filterscale
    for (let xx = 0; xx < outSize; xx++) {
      const center = (xx + 0.5) * scale
      let xmin = Math.trunc(center - support + 0.5)
      if (xmin < 0) xmin = 0
      let xmax = Math.trunc(center + support + 0.5)
      if (xmax > inSize) xmax = inSize
      xmax -= xmin
      let ww = 0
      for (let x = 0; x < xmax; x++) {
        const w = lanczos((x + xmin - center + 0.5) * ss)
        k[x] = w
        ww += w
      }
      for (let x = 0; x < xmax; x++) {
        const w = ww !== 0 ? k[x]! / ww : k[x]!
        kk[xx * ksize + x] = w < 0 ? Math.trunc(-0.5 + w * (1 << PRECISION_BITS)) : Math.trunc(0.5 + w * (1 << PRECISION_BITS))
      }
      bounds[xx * 2] = xmin
      bounds[xx * 2 + 1] = xmax
    }
    return { ksize, bounds, kk }
  }

  const clip8 = (ss: number) => {
    const v = ss >> PRECISION_BITS
    return v < 0 ? 0 : v > 255 ? 255 : v
  }

  /** Pillow's LANCZOS resize of interleaved 8-bit pixels (c bands, each on its own). */
  function pilResize(px: Uint8Array, w: number, h: number, c: number, ow: number, oh: number, stop?: () => boolean): Uint8Array {
    let src = px
    let sw = w
    if (ow !== w) {
      const { ksize, bounds, kk } = pilCoeffs(w, ow)
      const out = new Uint8Array(ow * h * c)
      for (let y = 0; y < h; y++) {
        if (stop && (y & 63) === 0 && stop()) throw new Error('Stopped')
        const row = y * w
        for (let xx = 0; xx < ow; xx++) {
          const xmin = bounds[xx * 2]!
          const xmax = bounds[xx * 2 + 1]!
          const kb = xx * ksize
          for (let b = 0; b < c; b++) {
            let ss = 1 << (PRECISION_BITS - 1)
            for (let x = 0; x < xmax; x++) ss += src[(row + x + xmin) * c + b]! * kk[kb + x]!
            out[(y * ow + xx) * c + b] = clip8(ss)
          }
        }
      }
      src = out
      sw = ow
    }
    if (oh !== h) {
      const { ksize, bounds, kk } = pilCoeffs(h, oh)
      const out = new Uint8Array(sw * oh * c)
      for (let yy = 0; yy < oh; yy++) {
        if (stop && (yy & 63) === 0 && stop()) throw new Error('Stopped')
        const ymin = bounds[yy * 2]!
        const ymax = bounds[yy * 2 + 1]!
        const kb = yy * ksize
        for (let xx = 0; xx < sw; xx++) {
          for (let b = 0; b < c; b++) {
            let ss = 1 << (PRECISION_BITS - 1)
            for (let y = 0; y < ymax; y++) ss += src[((y + ymin) * sw + xx) * c + b]! * kk[kb + y]!
            out[(yy * sw + xx) * c + b] = clip8(ss)
          }
        }
      }
      src = out
    }
    return src
  }

  /** PIL's MULDIV255(a, b): round(a·b / 255) in integers. */
  const mulDiv255 = (a: number, b: number) => {
    const t = a * b + 128
    return ((t >> 8) + t) >> 8
  }

  /**
   * Pillow's Image.resize(size, LANCZOS) of an RGBA picture (interleaved 8-bit):
   * resized premultiplied (RGBa, MULDIV255), then divided back (255·c / a,
   * truncated; alpha 0 and 255 kept as they are). Save image's resize (R1.5)
   * and Painter's file (R2.8).
   */
  function pilResizeRgba(px: Uint8Array, w: number, h: number, ow: number, oh: number, stop?: () => boolean): Uint8Array {
    const pre = new Uint8Array(px.length)
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]!
      pre[i] = mulDiv255(px[i]!, a)
      pre[i + 1] = mulDiv255(px[i + 1]!, a)
      pre[i + 2] = mulDiv255(px[i + 2]!, a)
      pre[i + 3] = a
    }
    const out = pilResize(pre, w, h, 4, ow, oh, stop)
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3]!
      if (a === 0 || a === 255) continue
      for (let b = 0; b < 3; b++) {
        const v = Math.trunc((255 * out[i + b]!) / a)
        out[i + b] = v > 255 ? 255 : v
      }
    }
    return out
  }

  /**
   * Everything save_images does to a picture before encoding it: the tensor's
   * bytes (saveBytes); Image.resize(LANCZOS) to ow × oh when that differs;
   * for JPEG (`flatten`), an RGBA picture pasted onto white with its alpha as
   * the mask (Paste.c BLEND: DIV255(255·(255 − a) + c·a)), leaving RGB.
   */
  function savePixels(p: PixelsPicture, ow: number, oh: number, flatten: boolean, stop?: () => boolean): { w: number; h: number; channels: 3 | 4; px: Uint8Array } {
    const t = saveBytes(p)
    let px = t.px
    const c = t.channels
    if (ow !== t.w || oh !== t.h) px = c === 4 ? pilResizeRgba(px, t.w, t.h, ow, oh, stop) : pilResize(px, t.w, t.h, 3, ow, oh, stop)
    if (!flatten || c === 3) return { w: ow, h: oh, channels: c, px }
    const n = ow * oh
    const rgb = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3]!
      for (let b = 0; b < 3; b++) {
        const x = 255 * (255 - a) + px[i * 4 + b]! * a + 128
        rgb[i * 3 + b] = ((x >> 8) + x) >> 8
      }
    }
    return { w: ow, h: oh, channels: 3, px: rgb }
  }

  return { roundHalfEven, bilinearKind, bilinear, tensorChannels, channelTable, mask16Of, channelMask16, clipBegin, clip, saveBytes, pilResize, pilResizeRgba, savePixels }
}

export type PixelsCore = ReturnType<typeof pixelsCore>

/** The core, in this thread (tests, and resize.ts). */
export const pixels = pixelsCore()
