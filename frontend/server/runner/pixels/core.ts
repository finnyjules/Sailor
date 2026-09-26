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
 *   The Frame's own resize (compositorCore.resizeBilinear) is not this code
 *   and is left as it is (its larger-size gap is a separate follow-up).
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

  function taps(inSize: number, outSize: number) {
    const i0 = new Int32Array(outSize)
    const i1 = new Int32Array(outSize)
    const l0 = new Float32Array(outSize)
    const l1 = new Float32Array(outSize)
    const scale = f(inSize / outSize)
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
   */
  function bilinear(src: Float32Array, c: number, sh: number, sw: number, dh: number, dw: number, channelsLast: boolean): Float32Array {
    if (!Number.isInteger(c) || c < 1 || c > 4) throw new Error(`A picture of ${c} channels can’t be resized here`)
    if (src.length !== c * sh * sw) throw new Error('The picture to resize is the wrong size')
    const out = new Float32Array(c * dh * dw)
    const ty = taps(sh, dh)
    const tx = taps(sw, dw)
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
    if (p.source === 'card' && p.data) {
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

  /** ImageToMask: channel `index` of the picture's tensor, as a mask's 16-bit scanlines. No float tensor is built. */
  function channelMask16(p: PixelsPicture, index: number): { w: number; h: number; scanlines: Uint8Array } {
    if (index >= tensorChannels(p)) throw new Error('This picture has no alpha channel to make a mask from')
    const d = p.data
    if (!d) return { w: p.w, h: p.h, scanlines: mask16Of(p.w, p.h, () => 0) }
    const table = channelTable(p.source, index)
    return { w: p.w, h: p.h, scanlines: mask16Of(p.w, p.h, i => table[d[i * 4 + index]!]!) }
  }

  /**
   * Text mask's clip, first half: the render's luma L (mw × mh) as the mask
   * 1 − L/255, resized to the source (w × h, a contiguous (1, 1, H, W)
   * tensor) when the sizes differ. Returns 1 − mask for `clip` and the mask's
   * 16-bit scanlines (the node's mask output).
   */
  function clipBegin(l: Uint8Array, mw: number, mh: number, w: number, h: number): { alpha: Float32Array; scanlines: Uint8Array } {
    let m: Float32Array = new Float32Array(mw * mh)
    for (let i = 0; i < m.length; i++) m[i] = f(1 - f(l[i]! / 255))
    if (mw !== w || mh !== h) m = bilinear(m, 1, mh, mw, h, w, false)
    const alpha = new Float32Array(w * h)
    for (let i = 0; i < alpha.length; i++) alpha[i] = f(1 - m[i]!)
    return { alpha, scanlines: mask16Of(w, h, i => m[i]!) }
  }

  /**
   * Text mask's clip, per picture: source × alpha on every tensor channel, as
   * the 8-bit pixels `_image_tensor_to_data_url` sends (round(255·clamp(x))),
   * interleaved RGB or RGBA as the tensor.
   */
  function clip(p: PixelsPicture, alpha: Float32Array): { w: number; h: number; channels: 3 | 4; px: Uint8Array } {
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
        px[i * c + k] = roundHalfEven(f((v < 0 ? 0 : v > 1 ? 1 : v) * 255))
      }
    }
    return { w: p.w, h: p.h, channels: c, px }
  }

  return { roundHalfEven, bilinearKind, bilinear, tensorChannels, channelTable, mask16Of, channelMask16, clipBegin, clip }
}

export type PixelsCore = ReturnType<typeof pixelsCore>

/** The core, in this thread (tests, and resize.ts). */
export const pixels = pixelsCore()
