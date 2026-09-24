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

const f = Math.fround
/** A fused multiply-add rounded once to float32 (the double product of two float32 values is exact). */
const fma = (a: number, b: number, c: number) => f(a * b + c)

export interface Plane {
  c: number
  h: number
  w: number
  data: Float32Array
}

export function plane(c: number, h: number, w: number, fill = 0): Plane {
  const data = new Float32Array(c * h * w)
  if (fill !== 0) data.fill(fill)
  return { c, h, w, data }
}

/** One channel of a plane (a view, not a copy). */
export function channel(p: Plane, i: number): Float32Array {
  const n = p.h * p.w
  return p.data.subarray(i * n, (i + 1) * n)
}

/** Channels [from, to) as a new plane sharing the same memory. */
export function channels(p: Plane, from: number, to: number): Plane {
  const n = p.h * p.w
  return { c: to - from, h: p.h, w: p.w, data: p.data.subarray(from * n, to * n) }
}

/** `t.repeat(1, 3, 1, 1)` on a one-channel plane. */
export function repeat3(p: Plane): Plane {
  const n = p.h * p.w
  const out = plane(3, p.h, p.w)
  for (let k = 0; k < 3; k++) out.data.set(p.data.subarray(0, n), k * n)
  return out
}

/** `torch.cat([a, b], dim=1)`. */
export function concat(a: Plane, b: Plane): Plane {
  const out = plane(a.c + b.c, a.h, a.w)
  out.data.set(a.data, 0)
  out.data.set(b.data, a.data.length)
  return out
}

interface Taps { i0: Int32Array; i1: Int32Array; l0: Float32Array; l1: Float32Array }

/** Source taps along one axis for `F.interpolate(mode='bilinear', align_corners=False)`. */
function linearTaps(inSize: number, outSize: number): Taps {
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
export function resizeBilinear(p: Plane, h: number, w: number): Plane {
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
export function resizeTo(p: Plane, h: number, w: number): Plane {
  return p.h === h && p.w === w ? p : resizeBilinear(p, h, w)
}

/** `_fit_to_canvas`: aspect-fit, centred, zero padding (every channel, alpha included). */
export function fitToCanvas(p: Plane, ch: number, cw: number): Plane {
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
export function transform(p: Plane, xOff: number, yOff: number, rotation: number, scale: number): { out: Plane; geo: Plane } {
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

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light',
  'difference', 'lighten', 'darken', 'add',
] as const
export type BlendMode = typeof BLEND_MODES[number]

/** `_blend` for one channel value, float32 op by op: base `a`, top `b`. An unknown mode is normal. */
export function blendValue(a: number, b: number, mode: string): number {
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
