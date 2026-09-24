/**
 * The torch operations the Compositor node uses, on one picture at a time.
 *
 * A `Plane` is ComfyUI's (1, C, H, W) tensor without the batch: float32
 * values, channel-major (all of channel 0, then channel 1, …). The runner
 * only ever composites one picture per layer, so the batch is always 1.
 *
 * FLOAT32, OP BY OP. Each function reproduces what torch's CPU kernels
 * compute, rounding to float32 (`Math.fround`) after every operation torch
 * rounds after, including where the kernels fuse a multiply-add (one
 * rounding). The operation orders were measured against torch 2.10 on this
 * machine (scripts/compositor_fixtures.py and the parity spec):
 *   - linspace: start + step·i fused (first half), end − step·(n−1−i) fused;
 *   - affine_grid: base·(n−1) then ÷n; grid = fma(y, m01, x·m00) + m02;
 *   - grid_sample (bilinear, zeros): (g + 1)·(size/2) − 0.5, then four
 *     corner products summed left to right, every step rounded;
 *   - interpolate (bilinear, align_corners=False): source index
 *     fma(scale, d + 0.5, −0.5); the four corner weights a·b rounded; then
 *     for ≤ 3 channels a fused chain (y0x1, y0x0, y1x0, y1x1), and for 4+
 *     channels (torch's channels-last kernel) unfused adds (y1x1, y1x0, y0x1, y0x0).
 * Bit-for-bit agreement is what makes the 8-bit PNG match: most composite
 * values sit exactly on a level (k/255), where one float32 ulp decides
 * which side truncation lands.
 */

export interface Plane {
  c: number
  h: number
  w: number
  data: Float32Array
}

/** One copy of a layer, placed: the layer's transform with its cloner step, and its Vary tint (0..1 RGB, float32). */
export interface CopyPose {
  x: number
  y: number
  rot: number
  scl: number
  op: number
  tint: [number, number, number] | null
  tintStrength: number
}

/**
 * A picture as sharp decodes it (RGBA, 8 bits, EXIF already turned where the
 * source turns it), not yet a tensor: the worker turns it into one, so the
 * main thread never loops over pixels. `source` says how the Python loader
 * for it builds its tensor (see decode.ts); `data` is null for Python's
 * stand-ins: an empty Image card's 1×1 black, LoadImage's 64×64 zero mask.
 */
export interface RawPicture {
  raw: true
  source: 'provider' | 'card' | 'load' | 'rgb' | 'blank' | 'mask' | 'nomask'
  w: number
  h: number
  data: Uint8Array | null
}

/** A layer, mask or overlay: a tensor already (the parity spec), or a raw picture. */
export type Picture = Plane | RawPicture

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light',
  'difference', 'lighten', 'darken', 'add',
] as const

/**
 * Every pixel operation, inside ONE self-contained function: it refers to
 * nothing outside itself but JavaScript built-ins. That is what lets the
 * runner ship it to a worker thread as source text (worker.ts,
 * `compositorCore.toString()`), so the pixel work never runs on the server's
 * main thread, while tests and the parity spec call the same code in-thread.
 * Do not reference anything from outside this function body.
 */
export function compositorCore() {
  const f = Math.fround
  /** A fused multiply-add rounded once to float32 (the double product of two float32 values is exact). */
  const fma = (a: number, b: number, c: number) => f(a * b + c)

  function plane(c: number, h: number, w: number, fill = 0): Plane {
    const data = new Float32Array(c * h * w)
    if (fill !== 0) data.fill(fill)
    return { c, h, w, data }
  }

  /** One channel of a plane (a view, not a copy). */
  function channel(p: Plane, i: number): Float32Array {
    const n = p.h * p.w
    return p.data.subarray(i * n, (i + 1) * n)
  }

  /** Channels [from, to) as a new plane sharing the same memory. */
  function channels(p: Plane, from: number, to: number): Plane {
    const n = p.h * p.w
    return { c: to - from, h: p.h, w: p.w, data: p.data.subarray(from * n, to * n) }
  }

  /** `t.repeat(1, 3, 1, 1)` on a one-channel plane. */
  function repeat3(p: Plane): Plane {
    const n = p.h * p.w
    const out = plane(3, p.h, p.w)
    for (let k = 0; k < 3; k++) out.data.set(p.data.subarray(0, n), k * n)
    return out
  }

  /** `torch.cat([a, b], dim=1)`. */
  function concat(a: Plane, b: Plane): Plane {
    const out = plane(a.c + b.c, a.h, a.w)
    out.data.set(a.data, 0)
    out.data.set(b.data, a.data.length)
    return out
  }

  /** Source taps along one axis for `F.interpolate(mode='bilinear', align_corners=False)`. */
  function linearTaps(inSize: number, outSize: number): { i0: Int32Array; i1: Int32Array; l0: Float32Array; l1: Float32Array } {
    const i0 = new Int32Array(outSize)
    const i1 = new Int32Array(outSize)
    const l0 = new Float32Array(outSize)
    const l1 = new Float32Array(outSize)
    // area_pixel_compute_scale: in/out as float32.
    const scale = f(inSize / outSize)
    for (let d = 0; d < outSize; d++) {
      // area_pixel_compute_source_index, fused: scale·(d + 0.5) − 0.5, clamped at 0.
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

  /** `F.interpolate(t, size=(h, w), mode='bilinear', align_corners=False)` (no antialias). */
  function resizeBilinear(p: Plane, h: number, w: number): Plane {
    const out = plane(p.c, h, w)
    const ty = linearTaps(p.h, h)
    const tx = linearTaps(p.w, w)
    const inN = p.h * p.w
    const outN = h * w
    const channelsLast = p.c > 3
    for (let c = 0; c < p.c; c++) {
      const src = p.data.subarray(c * inN, (c + 1) * inN)
      const dst = out.data.subarray(c * outN, (c + 1) * outN)
      for (let y = 0; y < h; y++) {
        const r0 = ty.i0[y]! * p.w
        const r1 = ty.i1[y]! * p.w
        const a0 = ty.l0[y]!
        const a1 = ty.l1[y]!
        const row = y * w
        for (let x = 0; x < w; x++) {
          const c0 = tx.i0[x]!
          const c1 = tx.i1[x]!
          const b0 = tx.l0[x]!
          const b1 = tx.l1[x]!
          const w00 = f(a0 * b0)
          const w01 = f(a0 * b1)
          const w10 = f(a1 * b0)
          const w11 = f(a1 * b1)
          let o: number
          if (channelsLast) {
            o = f(src[r1 + c1]! * w11)
            o = f(f(src[r1 + c0]! * w10) + o)
            o = f(f(src[r0 + c1]! * w01) + o)
            o = f(f(src[r0 + c0]! * w00) + o)
          }
          else {
            o = f(src[r0 + c1]! * w01)
            o = fma(src[r0 + c0]!, w00, o)
            o = fma(src[r1 + c0]!, w10, o)
            o = fma(src[r1 + c1]!, w11, o)
          }
          dst[row + x] = o
        }
      }
    }
    return out
  }

  /** `_resize_to`: stretch to exactly (h, w); unchanged when already that size. */
  function resizeTo(p: Plane, h: number, w: number): Plane {
    return p.h === h && p.w === w ? p : resizeBilinear(p, h, w)
  }

  /** `_fit_to_canvas`: aspect-fit, centred, zero padding (every channel, alpha included). */
  function fitToCanvas(p: Plane, ch: number, cw: number): Plane {
    if (p.h === ch && p.w === cw) return p
    const canvasAspect = cw / ch
    const layerAspect = p.w / p.h
    let nw: number, nh: number
    if (layerAspect > canvasAspect) {
      nw = cw
      nh = Math.max(1, Math.trunc(cw / layerAspect))
    }
    else {
      nh = ch
      nw = Math.max(1, Math.trunc(ch * layerAspect))
    }
    const resized = resizeBilinear(p, nh, nw)
    const top = Math.floor((ch - nh) / 2)
    const left = Math.floor((cw - nw) / 2)
    const out = plane(p.c, ch, cw)
    const inN = nh * nw
    const outN = ch * cw
    for (let c = 0; c < p.c; c++) {
      for (let y = 0; y < nh; y++) {
        const oy = y + top
        if (oy < 0 || oy >= ch) continue
        for (let x = 0; x < nw; x++) {
          const ox = x + left
          if (ox < 0 || ox >= cw) continue
          out.data[c * outN + oy * cw + ox] = resized.data[c * inN + y * nw + x]!
        }
      }
    }
    return out
  }

  /** torch.linspace(-1, 1, n) in float32, then affine_grid's ·(n−1)/n (align_corners=False). */
  function baseGrid(n: number): Float32Array {
    const b = new Float32Array(n)
    if (n <= 1) return b
    const step = f(2 / (n - 1))
    const half = Math.floor(n / 2)
    for (let i = 0; i < n; i++) {
      const v = i < half ? fma(step, i, -1) : fma(-step, n - 1 - i, 1)
      b[i] = f(f(v * (n - 1)) / n)
    }
    return b
  }

  /**
   * `_transform`: the affine map the node builds for (x, y, rotation, scale),
   * sampled with `F.affine_grid` + `F.grid_sample(mode='bilinear',
   * padding_mode='zeros', align_corners=False)`. Returns the warped plane and
   * the coverage (the same sampling of an all-ones plane).
   */
  function transform(p: Plane, xOff: number, yOff: number, rotation: number, scale: number): { out: Plane; geo: Plane } {
    const { h, w } = p
    // math.radians(x) is x·(π/180); theta is built in double, then held as float32.
    const rad = rotation * (Math.PI / 180)
    const cosA = Math.cos(rad)
    const sinA = Math.sin(rad)
    const s = Math.max(0.01, scale)
    const asp = h / w
    const tx = 2 * xOff
    const ty = 2 * yOff
    const m00 = f(cosA / s)
    const m01 = f(sinA * asp / s)
    const m02 = f((-tx * cosA - ty * sinA * asp) / s)
    const m10 = f(-sinA / asp / s)
    const m11 = f(cosA / s)
    const m12 = f((tx * sinA / asp - ty * cosA) / s)

    const bx = baseGrid(w)
    const by = baseGrid(h)
    const sx = f(w / 2)
    const sy = f(h / 2)

    const out = plane(p.c, h, w)
    const geo = plane(1, h, w)
    const n = h * w
    const src = p.data
    const dst = out.data
    const g = geo.data
    for (let i = 0; i < h; i++) {
      const yb = by[i]!
      for (let j = 0; j < w; j++) {
        const xb = bx[j]!
        const gx = f(fma(yb, m01, f(xb * m00)) + m02)
        const gy = f(fma(yb, m11, f(xb * m10)) + m12)
        // unnormalize (align_corners=False): (g + 1)·(size/2) − 0.5
        const ix = f(f(f(gx + 1) * sx) - 0.5)
        const iy = f(f(f(gy + 1) * sy) - 0.5)
        const x0 = Math.floor(ix)
        const y0 = Math.floor(iy)
        const we = f(ix - x0)
        const e = f(1 - we)
        const ns = f(iy - y0)
        const so = f(1 - ns)
        const wnw = f(so * e)
        const wne = f(so * we)
        const wsw = f(ns * e)
        const wse = f(ns * we)
        const inX0 = x0 >= 0 && x0 < w
        const inX1 = x0 + 1 >= 0 && x0 + 1 < w
        const inY0 = y0 >= 0 && y0 < h
        const inY1 = y0 + 1 >= 0 && y0 + 1 < h
        const hasNw = inX0 && inY0
        const hasNe = inX1 && inY0
        const hasSw = inX0 && inY1
        const hasSe = inX1 && inY1
        const o = i * w + j
        // The ones plane: an out-of-range corner reads 0.
        g[o] = f(f(f((hasNw ? wnw : 0) + (hasNe ? wne : 0)) + (hasSw ? wsw : 0)) + (hasSe ? wse : 0))
        if (!hasNw && !hasNe && !hasSw && !hasSe) continue
        const pnw = y0 * w + x0
        for (let c = 0; c < p.c; c++) {
          const off = c * n + pnw
          const vnw = hasNw ? f(src[off]! * wnw) : 0
          const vne = hasNe ? f(src[off + 1]! * wne) : 0
          const vsw = hasSw ? f(src[off + w]! * wsw) : 0
          const vse = hasSe ? f(src[off + w + 1]! * wse) : 0
          dst[c * n + o] = f(f(f(vnw + vne) + vsw) + vse)
        }
      }
    }
    return { out, geo }
  }

  /** `_blend` for one channel value, float32 op by op: base `a`, top `b`. An unknown mode is normal. */
  function blendValue(a: number, b: number, mode: string): number {
    switch (mode) {
      case 'multiply': return f(a * b)
      case 'screen': return f(1 - f(f(1 - a) * f(1 - b)))
      case 'overlay': return a < 0.5 ? f(f(2 * a) * b) : f(1 - f(f(2 * f(1 - a)) * f(1 - b)))
      case 'soft_light': {
        // W3C soft-light, as the node has it.
        const d = a <= 0.25 ? f(f(f(f(f(16 * a) - 12) * a) + 4) * a) : f(Math.sqrt(a))
        return b < 0.5
          ? f(a - f(f(f(1 - f(2 * b)) * a) * f(1 - a)))
          : f(a + f(f(f(2 * b) - 1) * f(d - a)))
      }
      case 'hard_light': return b < 0.5 ? f(f(2 * a) * b) : f(1 - f(f(2 * f(1 - a)) * f(1 - b)))
      case 'difference': return Math.abs(f(a - b))
      case 'lighten': return Math.max(a, b)
      case 'darken': return Math.min(a, b)
      case 'add': return Math.min(1, Math.max(0, f(a + b)))
      default: return b
    }
  }

  /** `_drawable`: every number of the copy's transform is finite. */
  function drawable(c: CopyPose): boolean {
    return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.rot) && Number.isFinite(c.scl) && Number.isFinite(c.op)
  }

  /**
   * `_prep_layer` for one copy: the layer at canvas size, as its RGB and its
   * alpha (coverage × opacity × embedded alpha × (1 − mask)). The mask is
   * already at canvas size (`_resize_to`, done once per layer by `paint`).
   */
  function prepLayer(image: Plane, mask: Float32Array | null, copy: CopyPose, ch: number, cw: number): { rgb: Plane; a: Float32Array } {
    let t = image
    if (t.c === 1) t = repeat3(t)
    else if (t.c === 2) t = concat(repeat3(channels(t, 0, 1)), channels(t, 1, 2))
    t = fitToCanvas(t, ch, cw)
    const tr = transform(t, copy.x, copy.y, copy.rot, copy.scl)
    const out = tr.out
    const n = ch * cw
    let rgb = channels(out, 0, 3)
    if (copy.tint) {
      // _tint_rgb: rgb·(1 − s) + tint·s, for s = clamp01(strength) > 0 (Python scalars: 1 − s in double, then float32).
      const s0 = typeof copy.tintStrength === 'number' ? copy.tintStrength : 1
      const s = s0 < 0 ? 0 : s0 > 1 ? 1 : s0
      if (s > 0) {
        const keep = f(1 - s)
        const sf = f(s)
        const tinted = plane(3, ch, cw)
        for (let k = 0; k < 3; k++) {
          const src = channel(rgb, k)
          const dst = channel(tinted, k)
          const tintPart = f(copy.tint[k]! * sf)
          for (let i = 0; i < n; i++) dst[i] = f(f(src[i]! * keep) + tintPart)
        }
        rgb = tinted
      }
    }
    const a = new Float32Array(n)
    const g = tr.geo.data
    const op = f(copy.op)
    for (let i = 0; i < n; i++) {
      const v = f(g[i]! * op)
      a[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    if (out.c >= 4) {
      const emb = channel(out, 3)
      for (let i = 0; i < n; i++) {
        const e = emb[i]! < 0 ? 0 : emb[i]! > 1 ? 1 : emb[i]!
        const v = f(a[i]! * e)
        a[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    if (mask) {
      for (let i = 0; i < n; i++) {
        const v = f(a[i]! * f(1 - mask[i]!))
        a[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    return { rgb, a }
  }

  /** A composite in progress (`_composite_layers` + the protect union). */
  interface Canvas { ch: number; cw: number; result: Plane | null; protect: Float32Array | null }

  function createCanvas(ch: number, cw: number): Canvas {
    return { ch, cw, result: null, protect: null }
  }

  /**
   * Lays one layer's copies (back to front) over the canvas; `protect` also
   * unions their coverage into the protect mask. `stopped` is checked before
   * each copy. The first drawn copy lands on implicit black (`rgb · a`).
   */
  function paint(cv: Canvas, picture: Plane | RawPicture, maskPicture: Plane | RawPicture | null, blend: string, copies: CopyPose[], protect: boolean, stopped?: () => boolean): void {
    const { ch, cw } = cv
    const n = ch * cw
    const image = toTensor(picture)
    const m = maskPicture ? resizeTo(toTensor(maskPicture), ch, cw).data : null
    for (const copy of copies) {
      if (stopped && stopped()) throw new Error('Stopped')
      if (!drawable(copy)) continue
      const { rgb, a } = prepLayer(image, m, copy, ch, cw)
      if (!cv.result) {
        const r = plane(3, ch, cw)
        for (let k = 0; k < 3; k++) {
          const s = channel(rgb, k)
          const d = channel(r, k)
          for (let i = 0; i < n; i++) d[i] = f(s[i]! * a[i]!)
        }
        cv.result = r
      }
      else {
        for (let k = 0; k < 3; k++) {
          const s = channel(rgb, k)
          const d = channel(cv.result, k)
          for (let i = 0; i < n; i++) {
            const base = d[i]!
            const blended = blendValue(base, s[i]!, blend)
            d[i] = f(f(base * f(1 - a[i]!)) + f(blended * a[i]!))
          }
        }
      }
      if (protect) {
        if (!cv.protect) cv.protect = new Float32Array(n)
        const p = cv.protect
        for (let i = 0; i < n; i++) if (a[i]! > p[i]!) p[i] = a[i]!
      }
    }
  }

  /** The overlay: always on top, straight per-pixel alpha (its mask is 1 − alpha, an RGBA overlay folds its own alpha too). */
  function overlay(cv: Canvas, srcPicture: Plane | RawPicture, maskPicture: Plane | RawPicture | null): void {
    const src = toTensor(srcPicture)
    const mask = maskPicture ? toTensor(maskPicture) : null
    const { ch, cw } = cv
    const n = ch * cw
    if (!cv.result) cv.result = plane(3, ch, cw)
    let o = resizeTo(src, ch, cw)
    let embedded: Float32Array | null = null
    if (o.c === 1) o = repeat3(o)
    else if (o.c >= 4) {
      embedded = Float32Array.from(channel(o, 3), v => (v < 0 ? 0 : v > 1 ? 1 : v))
      o = channels(o, 0, 3)
    }
    const a = new Float32Array(n)
    if (mask) {
      const m = resizeTo(mask, ch, cw).data
      for (let i = 0; i < n; i++) {
        const v = f(1 - m[i]!)
        a[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    else a.fill(1)
    if (embedded) {
      for (let i = 0; i < n; i++) {
        const v = f(a[i]! * embedded[i]!)
        a[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    for (let k = 0; k < 3; k++) {
      const s = channel(o, k)
      const d = channel(cv.result, k)
      for (let i = 0; i < n; i++) d[i] = f(f(d[i]! * f(1 - a[i]!)) + f(s[i]! * a[i]!))
    }
  }

  /**
   * The clamped composite (black when nothing was drawn), and — only when
   * asked — the protect mask (zeros when nothing is protected).
   */
  function finish(cv: Canvas, withProtect: boolean): { image: Plane; protect: Plane | null } {
    const image = cv.result !== null ? cv.result : plane(3, cv.ch, cv.cw)
    const out = image.data
    for (let i = 0; i < out.length; i++) {
      const v = out[i]!
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    let protect: Plane | null = null
    if (withProtect) {
      protect = plane(1, cv.ch, cv.cw)
      if (cv.protect) protect.data.set(cv.protect)
    }
    return { image, protect }
  }

  /** uint8 → float32 as numpy does it: float32(v) / 255. */
  function unit(v: number): number {
    return f(v / 255)
  }

  /**
   * A raw picture → the tensor its Python loader makes:
   *   provider — bytesio_to_image_tensor: RGBA, alpha a/255;
   *   card     — Image.process: RGB, or RGBA (alpha rebuilt as 1 − (1 − a/255))
   *              when any pixel is not fully opaque (mask.max() > 1e-3 ⇔ some a ≤ 254);
   *   load, rgb — RGB;  blank — 1×1 black;
   *   mask     — LoadImage MASK: 1 − a/255;  nomask — its 64×64 zeros.
   * A tensor passes through.
   */
  function toTensor(p: Plane | RawPicture): Plane {
    if (!('raw' in p)) return p
    if (p.source === 'blank') return plane(3, 1, 1)
    if (p.source === 'nomask') return plane(1, 64, 64)
    const d = p.data
    if (!d) throw new Error('A picture for the Frame is missing')
    const n = p.w * p.h
    if (p.source === 'mask') {
      const out = plane(1, p.h, p.w)
      for (let i = 0; i < n; i++) out.data[i] = f(1 - unit(d[i * 4 + 3]!))
      return out
    }
    let alpha = p.source === 'provider'
    if (p.source === 'card') {
      for (let i = 3; i < d.length; i += 4) {
        if (d[i]! < 255) { alpha = true; break }
      }
    }
    const out = plane(alpha ? 4 : 3, p.h, p.w)
    const o = out.data
    for (let i = 0; i < n; i++) {
      o[i] = unit(d[i * 4]!)
      o[n + i] = unit(d[i * 4 + 1]!)
      o[2 * n + i] = unit(d[i * 4 + 2]!)
    }
    if (alpha) {
      for (let i = 0; i < n; i++) {
        const a = unit(d[i * 4 + 3]!)
        o[3 * n + i] = p.source === 'provider' ? a : f(1 - f(1 - a))
      }
    }
    return out
  }

  /** save_live_preview's pixels: clip(255·x) truncated to uint8 (255.0·x a float32 product), RGB interleaved. */
  function toPreview8(img: Plane): Uint8Array {
    const n = img.h * img.w
    const px = new Uint8Array(n * 3)
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < n; i++) {
        const v = f(255 * img.data[k * n + i]!)
        px[i * 3 + k] = v <= 0 ? 0 : v >= 255 ? 255 : Math.trunc(v)
      }
    }
    return px
  }

  return {
    plane, channel, channels, repeat3, concat, resizeBilinear, resizeTo, fitToCanvas, transform, blendValue,
    drawable, prepLayer, createCanvas, paint, overlay, finish, toTensor, toPreview8,
  }
}

export type CompositorCore = ReturnType<typeof compositorCore>
export type FrameCanvas = ReturnType<CompositorCore['createCanvas']>

/** The core, in this thread (the parity spec, decode helpers, the small paths). */
export const core = compositorCore()
export const { plane, channel, channels, repeat3, concat, resizeBilinear, resizeTo, fitToCanvas, transform, blendValue } = core
