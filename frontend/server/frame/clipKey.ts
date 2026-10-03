/**
 * Frame Animate's background keyer, in Sailor's own server code (step 3, LC10).
 *
 * A faithful port of scripts/clip_key.py (numpy + PIL), so Animate runs with no
 * Python, locally and in hosted. Same maths, step for step:
 *
 *   - the key colour: green, or blue when over 3 % of the still's opaque pixels
 *     are green themselves (PIL's HSV);
 *   - the still flattened onto that colour (straight alpha), for the model;
 *   - per frame: the background the model ACTUALLY painted, sampled as the
 *     per-channel median of the pixels well outside the still's silhouette
 *     (`far`), and its spread (90th percentile Lab distance), which sets an
 *     adaptive tolerance; alpha from the CIE Lab (D65) distance to it, a
 *     smoothstep between `lo` and `lo + 14`;
 *   - guarded by the still's own alpha grown by 2.5 % of the width, and inside
 *     that ring gated by how much the pixel resembles the nearest opaque still
 *     pixel's colour (so halo, shadow and leftover ground drop out);
 *   - the 8-bit matte eroded (3×3 minimum) and softened (PIL's Gaussian blur of
 *     0.8: three box-blur passes), re-clipped to the guard; the key colour's
 *     dominant channel clamped on partly transparent pixels (spill); hidden
 *     colour zeroed.
 *
 * PIL's own resampling (bilinear, Lanczos: two passes, 8-bit fixed point,
 * premultiplied alpha for RGBA), rank filter (edge-replicated) and box blur
 * are ported with them, so the mattes match the Python's to within rounding
 * (LC10 parity: mean alpha difference well under one level).
 *
 * Everything here is pure, on typed arrays: RGB frames are w·h·3 bytes, RGBA
 * stills w·h·4. The decode/encode around it is ./clipKeyRun.ts.
 */

export const GREEN: RGB = [0, 255, 0]
export const BLUE: RGB = [0, 0, 255]
export const GREEN_SHARE_LIMIT = 0.03
export const KEY_LO = 20.0
export const KEY_HI = 60.0
export const GUARD_FRAC = 0.025
export const BG_SAMPLE_FRAC = 0.10
export const BG_MIN_COVERAGE = 0.01
export const TOL_LO_MIN = 6.0
export const TOL_LO_MAX = 28.0
export const TOL_HI_MARGIN = 14.0
export const EDGE_ERODE_PX = 1
export const RING_LO = 10.0
export const RING_HI = 26.0

export type RGB = [number, number, number]

const f32 = Math.fround

export function hexOf(rgb: readonly number[]): string {
  return '#' + rgb.slice(0, 3).map(v => Math.trunc(v).toString(16).padStart(2, '0')).join('')
}

export function fromHex(s: string): RGB {
  const h = s.replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('bad key colour')
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)]
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Python's round(): half to even. */
export function pyRound(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

// ── colour ──────────────────────────────────────────────────────────────────

/** PIL's RGB → HSV (Convert.c rgb2hsv_row), one pixel: [h, s] as 0..255. */
function pilHueSat(r: number, g: number, b: number): [number, number] {
  const maxc = Math.max(r, g, b)
  const minc = Math.min(r, g, b)
  if (maxc === minc) return [0, 0]
  const cr = f32(maxc - minc)
  const s = f32(cr / maxc)
  const rc = f32((maxc - r) / cr)
  const gc = f32((maxc - g) / cr)
  const bc = f32((maxc - b) / cr)
  let h: number
  if (r === maxc) h = f32(bc - gc)
  else if (g === maxc) h = f32(f32(2.0 + rc) - bc)
  else h = f32(f32(4.0 + gc) - rc)
  h = f32((h / 6.0 + 1.0) % 1.0)
  const clip8 = (v: number) => Math.max(0, Math.min(255, v))
  return [clip8(Math.trunc(h * 255.0)), clip8(Math.trunc(s * 255.0))]
}

/** Green unless the still's opaque pixels are noticeably green themselves. */
export function pickKeyColour(rgba: Uint8Array): string {
  let opaque = 0
  let greenish = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! <= 128) continue
    opaque++
    const [h8, s8] = pilHueSat(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)
    const hue = f32(h8 * f32(360.0 / 255.0))
    const sat = f32(s8 / 255.0)
    if (Math.abs(hue - 120.0) <= 30.0 && sat > 0.4) greenish++
  }
  if (!opaque) return hexOf(GREEN)
  return greenish / Math.max(1, opaque) > GREEN_SHARE_LIMIT ? hexOf(BLUE) : hexOf(GREEN)
}

/** RGBA → RGB with the key colour behind every transparent pixel (straight alpha). */
export function flattenOnto(rgba: Uint8Array, key: RGB): Uint8Array {
  const n = rgba.length / 4
  const out = new Uint8Array(n * 3)
  for (let p = 0; p < n; p++) {
    const a = f32(rgba[p * 4 + 3]! / 255.0)
    const ia = f32(1.0 - a)
    for (let c = 0; c < 3; c++) {
      const v = f32(f32(rgba[p * 4 + c]! * a) + f32(key[c]! * ia))
      out[p * 3 + c] = Math.trunc(Math.max(0, Math.min(255, v)))
    }
  }
  return out
}

/** sRGB byte → linear, the standard curve. */
const LINEAR = (() => {
  const t = new Float64Array(256)
  for (let i = 0; i < 256; i++) {
    const s = f32(i / 255.0)
    t[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return t
})()

const DELTA = 6.0 / 29.0
const DELTA3 = DELTA ** 3
const labF = (t: number) => (t > DELTA3 ? Math.cbrt(t) : t / (3.0 * DELTA * DELTA) + 4.0 / 29.0)

/** CIE Lab (D65) of one sRGB colour. */
export function labOf(r: number, g: number, b: number, out: Float32Array | number[] = [0, 0, 0], at = 0): Float32Array | number[] {
  const lr = LINEAR[r]!; const lg = LINEAR[g]!; const lb = LINEAR[b]!
  const x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750
  const z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041
  const fx = labF(x / 0.95047); const fy = labF(y / 1.0); const fz = labF(z / 1.08883)
  out[at] = 116.0 * fy - 16.0
  out[at + 1] = 500.0 * (fx - fy)
  out[at + 2] = 200.0 * (fy - fz)
  return out
}

/** Lab of every pixel of an RGB (·3) array, into `out` (Float32Array of the same length). */
export function srgbToLab(rgb: Uint8Array, out: Float32Array = new Float32Array(rgb.length)): Float32Array {
  for (let i = 0; i < rgb.length; i += 3) labOf(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!, out, i)
  return out
}

const smooth = (t: number) => t * t * (3.0 - 2.0 * t)

/** Lab distance of each pixel (Lab array) to one reference colour. */
export function labDistance(lab: Float32Array, ref: RGB): Float32Array {
  const r = labOf(ref[0], ref[1], ref[2])
  const n = lab.length / 3
  const d = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const a = lab[p * 3]! - r[0]!; const b = lab[p * 3 + 1]! - r[1]!; const c = lab[p * 3 + 2]! - r[2]!
    d[p] = Math.sqrt(a * a + b * b + c * c)
  }
  return d
}

/** Alpha in [0,1] from the Lab distance to the background: 0 at/below `lo`, 1 at/above `hi`, smoothstep between. */
export function keyAlpha(lab: Float32Array, bg: RGB, lo = KEY_LO, hi = KEY_HI): Float32Array {
  const d = labDistance(lab, bg)
  const span = Math.max(1e-6, hi - lo)
  for (let p = 0; p < d.length; p++) d[p] = smooth(clamp((d[p]! - lo) / span, 0, 1))
  return d
}

/** On partly transparent pixels, the background's dominant channel clamped to the mean of the other two. */
export function suppressSpill(rgb: Uint8Array, bg: RGB, alpha: Float32Array): Uint8Array {
  const out = new Uint8Array(rgb)
  let k = 0
  if (bg[1] > bg[k]!) k = 1
  if (bg[2] > bg[k]!) k = 2
  const o1 = k === 0 ? 1 : 0
  const o2 = k === 2 ? 1 : 2
  for (let p = 0; p < alpha.length; p++) {
    if (!(alpha[p]! < 0.999)) continue
    const mean = (rgb[p * 3 + o1]! + rgb[p * 3 + o2]!) * 0.5
    const v = Math.min(rgb[p * 3 + k]!, mean)
    out[p * 3 + k] = Math.trunc(v)
  }
  return out
}

// ── PIL resampling (Resample.c) ─────────────────────────────────────────────

type Filter = { support: number; fn: (x: number) => number }
const BILINEAR: Filter = { support: 1.0, fn: (x) => { x = Math.abs(x); return x < 1.0 ? 1.0 - x : 0.0 } }
const sinc = (x: number) => { if (x === 0.0) return 1.0; x *= Math.PI; return Math.sin(x) / x }
const LANCZOS: Filter = { support: 3.0, fn: x => (x >= -3.0 && x < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0) }
const PRECISION_BITS = 32 - 8 - 2

/** precompute_coeffs + normalize_coeffs_8bpc: per output pixel, its first input, its count and fixed-point weights. */
function coeffs(inSize: number, outSize: number, f: Filter): { ksize: number; bounds: Int32Array; kk: Int32Array } {
  const scale = inSize / outSize
  const filterscale = Math.max(1.0, scale)
  const support = f.support * filterscale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outSize * 2)
  const kk = new Int32Array(outSize * ksize)
  const pre = new Float64Array(ksize)
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale
    const ss = 1.0 / filterscale
    let xmin = Math.trunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = Math.trunc(center + support + 0.5)
    if (xmax > inSize) xmax = inSize
    xmax -= xmin
    let ww = 0.0
    for (let x = 0; x < xmax; x++) { const w = f.fn((x + xmin - center + 0.5) * ss); pre[x] = w; ww += w }
    for (let x = 0; x < ksize; x++) {
      let v = x < xmax ? pre[x]! : 0
      if (x < xmax && ww !== 0.0) v /= ww
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS))
    }
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }
  return { ksize, bounds, kk }
}

const clip8 = (v: number) => (v >= (1 << PRECISION_BITS) * 256 ? 255 : v <= 0 ? 0 : Math.floor(v / (1 << PRECISION_BITS)))

/**
 * PIL's Image.resize for 8-bit data with `ch` interleaved channels: horizontal
 * pass (rows the vertical pass reads only), rounded to 8 bits, then vertical.
 */
export function pilResize(src: Uint8Array, w: number, h: number, ch: number, ow: number, oh: number, filter: 'bilinear' | 'lanczos'): Uint8Array {
  if (ow === w && oh === h) return new Uint8Array(src)
  const f = filter === 'bilinear' ? BILINEAR : LANCZOS
  const half = 1 << (PRECISION_BITS - 1)
  let cur = src; let cw = w; let chh = h
  const needH = ow !== w
  const needV = oh !== h
  const vert = coeffs(h, oh, f)
  if (needH) {
    const hz = coeffs(w, ow, f)
    // Only the source rows the vertical pass uses.
    const first = needV ? vert.bounds[0]! : 0
    const last = needV ? vert.bounds[oh * 2 - 2]! + vert.bounds[oh * 2 - 1]! : h
    const rows = last - first
    const tmp = new Uint8Array(ow * rows * ch)
    for (let y = 0; y < rows; y++) {
      const srow = (y + first) * w * ch
      for (let xx = 0; xx < ow; xx++) {
        const xmin = hz.bounds[xx * 2]!; const xmax = hz.bounds[xx * 2 + 1]!
        const k = xx * hz.ksize
        for (let c = 0; c < ch; c++) {
          let ss = half
          for (let x = 0; x < xmax; x++) ss += cur[srow + (x + xmin) * ch + c]! * hz.kk[k + x]!
          tmp[(y * ow + xx) * ch + c] = clip8(ss)
        }
      }
    }
    if (needV) for (let i = 0; i < oh; i++) vert.bounds[i * 2]! -= first
    cur = tmp; cw = ow; chh = rows
  }
  if (!needV) return cur
  const out = new Uint8Array(cw * oh * ch)
  for (let yy = 0; yy < oh; yy++) {
    const ymin = vert.bounds[yy * 2]!; const ymax = vert.bounds[yy * 2 + 1]!
    const k = yy * vert.ksize
    for (let x = 0; x < cw; x++) {
      for (let c = 0; c < ch; c++) {
        let ss = half
        for (let y = 0; y < ymax; y++) ss += cur[((y + ymin) * cw + x) * ch + c]! * vert.kk[k + y]!
        out[(yy * cw + x) * ch + c] = clip8(ss)
      }
    }
  }
  void chh
  return out
}

/** PIL's RGBA → RGBa (premultiply, MULDIV255). */
function premultiply(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    for (let c = 0; c < 3; c++) {
      const t = rgba[i + c]! * a + 128
      out[i + c] = (t + (t >> 8)) >> 8
    }
    out[i + 3] = a
  }
  return out
}

/** PIL's RGBa → RGBA (unpremultiply). */
function unpremultiply(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    for (let c = 0; c < 3; c++) out[i + c] = a === 255 || a === 0 ? rgba[i + c]! : Math.min(255, Math.trunc((255 * rgba[i + c]!) / a))
    out[i + 3] = a
  }
  return out
}

/** An RGBA still resized as PIL resizes RGBA (premultiplied), bilinear. */
export function resizeStill(rgba: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  if (ow === w && oh === h) return new Uint8Array(rgba)
  return unpremultiply(pilResize(premultiply(rgba), w, h, 4, ow, oh, 'bilinear'))
}

/** The alpha channel of an RGBA array. */
export function alphaOf(rgba: Uint8Array): Uint8Array {
  const a = new Uint8Array(rgba.length / 4)
  for (let p = 0; p < a.length; p++) a[p] = rgba[p * 4 + 3]!
  return a
}

// ── masks ───────────────────────────────────────────────────────────────────

/** Guard/propagation reach in pixels for a frame of this width. */
export function reachPx(width: number, frac = GUARD_FRAC): number {
  return Math.trunc(pyRound(frac * width))
}

/**
 * A boolean mask grown by `reach` pixels: `reach` rounds of 8-neighbour growth
 * are a square (Chebyshev) neighbourhood of radius `reach`, clipped at the
 * borders, done here as a separable running max.
 */
export function dilateMask(mask: Uint8Array, w: number, h: number, reach: number): Uint8Array {
  if (reach <= 0) return new Uint8Array(mask)
  const rowPass = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    // Distance to the nearest set pixel to the left/right, as a sweep.
    const o = y * w
    let last = -Infinity
    for (let x = 0; x < w; x++) { if (mask[o + x]) last = x; if (x - last <= reach) rowPass[o + x] = 1 }
    last = Infinity
    for (let x = w - 1; x >= 0; x--) { if (mask[o + x]) last = x; if (last - x <= reach) rowPass[o + x] = 1 }
  }
  const out = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    let last = -Infinity
    for (let y = 0; y < h; y++) { if (rowPass[y * w + x]) last = y; if (y - last <= reach) out[y * w + x] = 1 }
    last = Infinity
    for (let y = h - 1; y >= 0; y--) { if (rowPass[y * w + x]) last = y; if (last - y <= reach) out[y * w + x] = 1 }
  }
  return out
}

/** The still's alpha resized to the frame (bilinear) and grown by `frac` of the frame width: 1 inside, 0 outside. */
export function guardMask(stillAlpha: Uint8Array, sw: number, sh: number, w: number, h: number, frac = GUARD_FRAC): Uint8Array {
  const a = pilResize(stillAlpha, sw, sh, 1, w, h, 'bilinear')
  const m = new Uint8Array(w * h)
  for (let p = 0; p < m.length; p++) m[p] = a[p]! > 127 ? 1 : 0
  return dilateMask(m, w, h, reachPx(w, frac))
}

const SHIFTS8: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/**
 * The RGB of the nearest opaque (alpha > 128) still pixel, for every pixel, by
 * `reach` rounds of propagation: each round, an unfilled pixel takes the
 * colour of the first neighbour (in SHIFTS8 order) filled before the round.
 * Pixels never reached have no reference (`has` 0).
 */
export function nearestSubjectColour(still: Uint8Array, w: number, h: number, reach: number): { ref: Uint8Array; has: Uint8Array } {
  const n = w * h
  let has = new Uint8Array(n)
  let ref = new Uint8Array(n * 3)
  let left = n
  for (let p = 0; p < n; p++) {
    if (still[p * 4 + 3]! > 128) { has[p] = 1; ref[p * 3] = still[p * 4]!; ref[p * 3 + 1] = still[p * 4 + 1]!; ref[p * 3 + 2] = still[p * 4 + 2]!; left-- }
  }
  for (let round = 0; round < reach && left > 0; round++) {
    const prevHas = has; const prevRef = ref
    has = new Uint8Array(prevHas); ref = new Uint8Array(prevRef)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (prevHas[p]) continue
        for (const [dy, dx] of SHIFTS8) {
          const yy = y + dy; const xx = x + dx
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (!prevHas[q]) continue
          has[p] = 1; ref[p * 3] = prevRef[q * 3]!; ref[p * 3 + 1] = prevRef[q * 3 + 1]!; ref[p * 3 + 2] = prevRef[q * 3 + 2]!
          left--
          break
        }
      }
    }
  }
  return { ref, has }
}

/** The clip-wide pieces the ring gate needs: the ring itself and its reference colours in Lab. */
export interface Ring { mask: Uint8Array; has: Uint8Array; refLab: Float32Array; any: boolean }

/**
 * 1 outside the ring; inside it, 1 where the frame pixel resembles its nearest
 * subject colour (Lab distance ≤ `lo`) falling smoothly to 0 at `hi`; 0 for a
 * ring pixel with no reference.
 */
export function ringGate(lab: Float32Array, ring: Ring, lo = RING_LO, hi = RING_HI): Float32Array {
  const n = lab.length / 3
  const g = new Float32Array(n).fill(1)
  if (!ring.any) return g
  const span = Math.max(1e-6, hi - lo)
  for (let p = 0; p < n; p++) {
    if (!ring.mask[p]) continue
    if (!ring.has[p]) { g[p] = 0; continue }
    const a = lab[p * 3]! - ring.refLab[p * 3]!; const b = lab[p * 3 + 1]! - ring.refLab[p * 3 + 1]!; const c = lab[p * 3 + 2]! - ring.refLab[p * 3 + 2]!
    const d = Math.sqrt(a * a + b * b + c * c)
    g[p] = 1.0 - smooth(clamp((d - lo) / span, 0, 1))
  }
  return g
}

/** k-th smallest (0-based) of a Float32Array, in place (quickselect). */
function select(a: Float32Array, k: number): number {
  let lo = 0; let hi = a.length - 1
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1]!
    let i = lo; let j = hi
    while (i <= j) {
      while (a[i]! < pivot) i++
      while (a[j]! > pivot) j--
      if (i <= j) { const t = a[i]!; a[i] = a[j]!; a[j] = t; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return a[k]!
  }
  return a[k]!
}

/**
 * Per-channel median of the frame's definitely-background pixels and the 90th
 * percentile (linear) Lab distance of those pixels from it. The key colour with
 * zero spread when `far` covers under 1 % of the frame.
 */
export function estimateBackground(rgb: Uint8Array, lab: Float32Array, far: Uint8Array, key: RGB): { bg: RGB; spread: number } {
  const n = far.length
  let count = 0
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  for (let p = 0; p < n; p++) {
    if (!far[p]) continue
    count++
    hist[0]![rgb[p * 3]!]!++; hist[1]![rgb[p * 3 + 1]!]!++; hist[2]![rgb[p * 3 + 2]!]!++
  }
  if (count < BG_MIN_COVERAGE * n) return { bg: [key[0], key[1], key[2]], spread: 0 }
  const kth = (hst: Uint32Array, k: number) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hst[v]!; if (acc > k) return v } return 255 }
  const med = (hst: Uint32Array) => (count % 2 ? kth(hst, (count - 1) / 2) : (kth(hst, count / 2 - 1) + kth(hst, count / 2)) / 2)
  const bg: RGB = [pyRound(med(hist[0]!)), pyRound(med(hist[1]!)), pyRound(med(hist[2]!))]
  const r = labOf(bg[0], bg[1], bg[2])
  const d = new Float32Array(count)
  let i = 0
  for (let p = 0; p < n; p++) {
    if (!far[p]) continue
    const a = lab[p * 3]! - r[0]!; const b = lab[p * 3 + 1]! - r[1]!; const c = lab[p * 3 + 2]! - r[2]!
    d[i++] = Math.sqrt(a * a + b * b + c * c)
  }
  const at = 0.9 * (count - 1)
  const k = Math.floor(at)
  const lo = select(d, k)
  let spread = lo
  if (k + 1 < count && at > k) {
    // The next value up: the smallest of the part above k after the select.
    let next = Infinity
    for (let j = k + 1; j < count; j++) if (d[j]! < next) next = d[j]!
    spread = lo + (at - k) * (next - lo)
  }
  return { bg, spread }
}

/** PIL's MinFilter(3): 3×3 minimum with the edges replicated. */
export function minFilter3(a: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1); const y1 = Math.min(h - 1, y + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1); const x1 = Math.min(w - 1, x + 1)
      let m = 255
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { const v = a[yy * w + xx]!; if (v < m) m = v }
      out[y * w + x] = m
    }
  }
  return out
}

/** PIL's box radius for a Gaussian of `radius` in `passes` passes (BoxBlur.c _gaussian_blur_radius). */
function gaussianBoxRadius(radius: number, passes: number): number {
  const sigma2 = f32(f32(radius * radius) / passes)
  const L = f32(Math.sqrt(f32(f32(12.0 * sigma2) + 1.0)))
  const l = f32(Math.floor(f32(L - 1.0) / 2.0))
  let a = f32(f32(2 * l + 1) * f32(f32(l * f32(l + 1)) - f32(3 * sigma2)))
  a = f32(a / f32(6 * f32(sigma2 - f32((l + 1) * (l + 1)))))
  return f32(l + a)
}

/** One line of PIL's 8-bit box blur (ImagingLineBoxBlur8), edges replicated: `n` values from `inp` (every `stride`th from `iOff`) into `out[0..n)`. */
function lineBoxBlur(out: Uint8Array, inp: Uint8Array, iOff: number, stride: number, n: number, radius: number, ww: number, fw: number): void {
  const lastx = n - 1
  const edgeA = Math.min(radius + 1, n)
  const edgeB = Math.max(n - radius - 1, 0)
  const at = (x: number) => inp[iOff + x * stride]!
  let acc = at(0) * (radius + 1)
  for (let x = 0; x < edgeA - 1; x++) acc += at(x)
  acc += at(lastx) * (radius - edgeA + 1)
  const save = (x: number, bulk: number) => { out[x] = Math.floor((bulk + (1 << 23)) / (1 << 24)) & 255 }
  if (edgeA <= edgeB) {
    for (let x = 0; x < edgeA; x++) { acc += at(x + radius) - at(0); save(x, acc * ww + (at(0) + at(x + radius + 1)) * fw) }
    for (let x = edgeA; x < edgeB; x++) { acc += at(x + radius) - at(x - radius - 1); save(x, acc * ww + (at(x - radius - 1) + at(x + radius + 1)) * fw) }
    for (let x = edgeB; x <= lastx; x++) { acc += at(lastx) - at(x - radius - 1); save(x, acc * ww + (at(x - radius - 1) + at(lastx)) * fw) }
  }
  else {
    for (let x = 0; x < edgeB; x++) { acc += at(x + radius) - at(0); save(x, acc * ww + (at(0) + at(x + radius + 1)) * fw) }
    for (let x = edgeB; x < edgeA; x++) { acc += at(lastx) - at(0); save(x, acc * ww + (at(0) + at(lastx)) * fw) }
    for (let x = edgeA; x <= lastx; x++) { acc += at(lastx) - at(x - radius - 1); save(x, acc * ww + (at(x - radius - 1) + at(lastx)) * fw) }
  }
}

/** PIL's GaussianBlur(radius) on an 8-bit image: three box-blur passes across, then three down. */
export function gaussianBlur(a: Uint8Array, w: number, h: number, radius: number, passes = 3): Uint8Array {
  const fr = gaussianBoxRadius(radius, passes)
  const r = Math.trunc(fr)
  const ww = Math.trunc(f32((1 << 24) / f32(f32(fr * 2) + 1)))
  const fw = Math.trunc(((1 << 24) - (r * 2 + 1) * ww) / 2)
  let cur = new Uint8Array(a)
  const line = new Uint8Array(Math.max(w, h))
  for (let i = 0; i < passes; i++) {
    for (let y = 0; y < h; y++) {
      lineBoxBlur(line, cur, y * w, 1, w, r, ww, fw)
      cur.set(line.subarray(0, w), y * w)
    }
  }
  for (let i = 0; i < passes; i++) {
    for (let x = 0; x < w; x++) {
      lineBoxBlur(line, cur, x, w, h, r, ww, fw)
      for (let y = 0; y < h; y++) cur[y * w + x] = line[y]!
    }
  }
  return cur
}

/** u8/255 · 255 as float32 then truncated: what numpy makes of a soft matte level. */
const LEVEL = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = Math.trunc(f32(f32(i / 255.0) * 255.0)); return t })()

export function fit(w: number, h: number, maxEdge: number): [number, number] {
  const m = Math.max(w, h)
  if (m <= maxEdge) return [w, h]
  const s = maxEdge / m
  return [Math.max(1, Math.trunc(pyRound(w * s))), Math.max(1, Math.trunc(pyRound(h * s)))]
}

/**
 * The keyer for one clip: everything that depends only on the still and the
 * frame size is made once here; `keyFrame` keys one frame.
 */
export class ClipKeyer {
  readonly ow: number
  readonly oh: number
  private readonly guard: Uint8Array
  private readonly far: Uint8Array
  private readonly ring: Ring
  private readonly lab: Float32Array

  constructor(readonly still: Uint8Array, readonly sw: number, readonly sh: number, readonly key: RGB, readonly fw: number, readonly fh: number, maxEdge = Math.max(sw, sh)) {
    ;[this.ow, this.oh] = fit(fw, fh, maxEdge)
    const { ow, oh } = this
    const a = alphaOf(still)
    this.guard = guardMask(a, sw, sh, ow, oh)
    const farGuard = guardMask(a, sw, sh, ow, oh, BG_SAMPLE_FRAC)
    this.far = farGuard.map(v => (v ? 0 : 1))
    const resized = resizeStill(still, sw, sh, ow, oh)
    const { ref, has } = nearestSubjectColour(resized, ow, oh, reachPx(ow))
    const mask = new Uint8Array(ow * oh)
    let any = false
    for (let p = 0; p < mask.length; p++) if (this.guard[p] && resized[p * 4 + 3]! <= 128) { mask[p] = 1; any = true }
    // has == 0 pixels read as black (Python's NaN → 0 then uint8) but are gated to 0 anyway.
    this.ring = { mask, has, refLab: srgbToLab(ref), any }
    this.lab = new Float32Array(ow * oh * 3)
  }

  /** One decoded frame (fw·fh·3 RGB) → its keyed RGBA at ow·oh. */
  keyFrame(frame: Uint8Array): Uint8Array {
    const { ow, oh } = this
    const f = this.fw !== ow || this.fh !== oh ? pilResize(frame, this.fw, this.fh, 3, ow, oh, 'lanczos') : frame
    const lab = srgbToLab(f, this.lab)
    const { bg, spread } = estimateBackground(f, lab, this.far, this.key)
    const lo = clamp(spread * 1.2, TOL_LO_MIN, TOL_LO_MAX)
    const hi = lo + TOL_HI_MARGIN
    const a = keyAlpha(lab, bg, lo, hi)
    const gate = ringGate(lab, this.ring)
    const n = ow * oh
    let u8: Uint8Array = new Uint8Array(n)
    for (let p = 0; p < n; p++) {
      const v = f32(f32(f32(a[p]! * this.guard[p]!) * gate[p]!) * 255.0)
      u8[p] = Math.trunc(Math.max(0, Math.min(255, v)))
    }
    if (EDGE_ERODE_PX > 0) u8 = minFilter3(u8, ow, oh)
    u8 = gaussianBlur(u8, ow, oh, 0.8)
    const soft = new Float32Array(n)
    for (let p = 0; p < n; p++) soft[p] = this.guard[p] ? u8[p]! / 255.0 : 0
    const rgb = suppressSpill(f, bg, soft)
    const out = new Uint8Array(n * 4)
    for (let p = 0; p < n; p++) {
      const level = this.guard[p] ? LEVEL[u8[p]!]! : 0
      out[p * 4 + 3] = level
      if (soft[p]! <= 0) continue
      out[p * 4] = rgb[p * 3]!; out[p * 4 + 1] = rgb[p * 3 + 1]!; out[p * 4 + 2] = rgb[p * 3 + 2]!
    }
    return out
  }
}
