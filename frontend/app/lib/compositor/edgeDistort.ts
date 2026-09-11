/**
 * Alpha-EDGE distortion kernels for the Compositor (F4 Task 6): two deterministic pixel
 * passes that reshape a rasterised layer's ALPHA boundary rather than its colours.
 *
 *  - `applyRoughEdgeToData` — jitters the silhouette edge in and out by a seeded noise field
 *    (`amount` = jitter amplitude, `detail` = noise frequency, `seed`). Grows OUTWARD by the
 *    amplitude, so its reach is folded into the offscreen pad.
 *  - `applyInkBleedToData` — an organic, blotchy OUTWARD spread of the alpha (ink soaking into
 *    paper): `amount` = spread reach, `seed`, optional `softness` (feathered outer boundary).
 *
 * Both reuse `tornEdge.ts`'s alpha-edge technique — a chamfer distance transform of the
 * silhouette (`distanceInside`, imported) plus a seeded value/fbm noise field — but unlike the
 * torn edge (which only carves inward and paints a lip) these can push the alpha OUTSIDE the
 * original silhouette, so a small nearest-inside feature transform carries the layer's own edge
 * colour into the grown pixels. DETERMINISTIC: the seeded PRNG/noise below, never `Math.random`.
 */
import { distanceInside } from './tornEdge'

/** Jitter amplitude at `amount` 1, as a fraction of canvas width (× the device buffer width in
 *  the kernel, × the logical frame width in the pad helper — normalised-to-width × deviceWidth is
 *  already device px, so the scale cancels). Kept modest: a few px of raggedness, not a shred. */
export const ROUGH_EDGE_MAX_W = 0.03
/** Outward bleed reach at `amount` 1, as a fraction of canvas width. Larger than the rough-edge
 *  amplitude — ink bleed is meant to visibly soak past the edge. */
export const INK_BLEED_MAX_W = 0.06

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number): number => clamp(v, 0, 1)

// ── Seeded noise (mirrors tornEdge's makeNoise — value/fbm hashing, no Math.random) ──────────
function makeNoise(seed: number) {
  const h2 = (ix: number, iy: number): number => {
    const x = Math.sin(ix * 127.1 + iy * 311.7 + seed * 13.7) * 43758.5453
    return x - Math.floor(x)
  }
  const value2 = (x: number, y: number): number => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1)
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
  const fbm2 = (x: number, y: number, oct: number, pers: number): number => {
    let amp = 1, sum = 0, norm = 0, f = 1
    for (let o = 0; o < oct; o++) { sum += value2(x * f + o * 17.3, y * f + o * 17.3) * amp; norm += amp; f *= 2; amp *= pers }
    return sum / norm
  }
  return { value2, fbm2 }
}

/** Binary alpha mask + opaque bounding box of an RGBA buffer. Mirrors tornEdge's own pass. */
function insideMask(data: Uint8ClampedArray, W: number, H: number): {
  inside: Uint8Array; minx: number; miny: number; maxx: number; maxy: number
} {
  const inside = new Uint8Array(W * H)
  let minx = W, miny = H, maxx = -1, maxy = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3]! > 8) {
      inside[y * W + x] = 1
      if (x < minx) minx = x; if (x > maxx) maxx = x
      if (y < miny) miny = y; if (y > maxy) maxy = y
    }
  }
  return { inside, minx, miny, maxx, maxy }
}

/** Chamfer (1 / √2) distance from each OUTSIDE pixel to the nearest INSIDE pixel, WITHIN the band,
 *  carrying the index of that nearest inside pixel so the caller can copy its colour into a grown
 *  pixel. `d` is 0 on inside pixels; `src` is the pixel's own index on inside pixels and -1 where
 *  no inside pixel is reachable inside the band. Pure + deterministic (a fixed two-pass sweep). */
function nearestInsideField(
  inside: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number,
): { d: Float32Array; src: Int32Array } {
  const INF = 1e9, a = 1, b = Math.SQRT2
  const n = W * (y1 + 1)
  const d = new Float32Array(n)
  const src = new Int32Array(n).fill(-1)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x
    if (inside[i]) { d[i] = 0; src[i] = i } else d[i] = INF
  }
  const relax = (i: number, j: number, w: number): void => {
    if (d[j]! + w < d[i]!) { d[i] = d[j]! + w; src[i] = src[j]! }
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x; if (d[i] === 0) continue
    if (x > x0) relax(i, i - 1, a)
    if (y > y0) relax(i, i - W, a)
    if (x > x0 && y > y0) relax(i, i - W - 1, b)
    if (x < x1 && y > y0) relax(i, i - W + 1, b)
  }
  for (let y = y1; y >= y0; y--) for (let x = x1; x >= x0; x--) {
    const i = y * W + x; if (d[i] === 0) continue
    if (x < x1) relax(i, i + 1, a)
    if (y < y1) relax(i, i + W, a)
    if (x < x1 && y < y1) relax(i, i + W + 1, b)
    if (x > x0 && y < y1) relax(i, i + W - 1, b)
  }
  return { d, src }
}

export interface RoughEdgeSpecLike { amount: number; detail: number; seed: number }
export interface InkBleedSpecLike { amount: number; seed: number; softness?: number }

/**
 * Rough edge: displace the silhouette boundary by a seeded noise field, in BOTH directions.
 *
 * Build a signed distance from the edge (`+distIn` inside, `−distOut` outside), read a seeded
 * value-noise `n∈[−1,1]` per pixel, and place the new edge at `sd = amplitude·n`: a pixel is kept
 * when `sd > amplitude·n`. Inside pixels that fall outside the jittered edge lose their alpha
 * (erosion); outside pixels that fall inside gain the nearest edge colour (dilation). A 1px
 * anti-alias band softens the flip. `amount ≤ 0` is a no-op. Mutates `data`.
 *
 * `W` is the device buffer width, `scale` device px per logical px (only the noise frequency uses
 * it, so the raggedness stays physically stable on retina — the amplitude is normalised-to-width
 * × deviceWidth, already device px). Deterministic: the seeded noise above, no `Math.random`.
 */
export function applyRoughEdgeToData(
  data: Uint8ClampedArray, W: number, H: number, spec: RoughEdgeSpecLike, scale: number,
): void {
  const s = scale > 0 ? scale : 1
  const amount = clamp01(spec.amount)
  if (!(amount > 0)) return
  const detail = clamp(Number.isFinite(spec.detail) ? spec.detail : 8, 1, 32)
  const A = amount * ROUGH_EDGE_MAX_W * W       // amplitude, device px
  if (!(A > 0)) return

  const { inside, minx, miny, maxx, maxy } = insideMask(data, W, H)
  if (maxx < 0) return                          // fully transparent — nothing to distort

  const band = Math.ceil(A) + 2
  const x0 = Math.max(0, Math.floor(minx - band)), y0 = Math.max(0, Math.floor(miny - band))
  const x1 = Math.min(W - 1, Math.ceil(maxx + band)), y1 = Math.min(H - 1, Math.ceil(maxy + band))

  const distIn = distanceInside(inside, W, x0, y0, x1, y1)
  const { d: distOut, src } = nearestInsideField(inside, W, x0, y0, x1, y1)
  const { value2 } = makeNoise(spec.seed)
  const f = (detail * 0.006) / s                // noise frequency: detail 8 ≈ tornEdge's ~0.05
  const orig = data.slice()                     // read source colours before we overwrite

  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x, o = i * 4
    const inSide = inside[i] === 1
    const sd = inSide ? distIn[i]! : -distOut[i]!
    // deep interior stays fully inside; far exterior stays fully outside — skip the untouched band.
    if (sd > A + 0.5 || sd < -A - 0.5) continue
    const n = value2(x * f, y * f) * 2 - 1       // [-1, 1]
    const factor = clamp01(sd - A * n + 0.5)     // 1 kept, 0 cut, with a 1px anti-alias ramp
    if (inSide) {
      data[o + 3] = orig[o + 3]! * factor        // erode: reduce alpha (colour untouched)
    } else if (factor > 0 && src[i]! >= 0) {
      const so = src[i]! * 4                      // dilate: take the nearest edge colour
      data[o] = orig[so]!; data[o + 1] = orig[so + 1]!; data[o + 2] = orig[so + 2]!
      data[o + 3] = orig[so + 3]! * factor
    }
  }
}

/**
 * Ink bleed: an organic, blotchy OUTWARD spread of the alpha, as ink soaks into paper.
 *
 * For every OUTSIDE pixel within reach, a seeded fbm gives a local blotch factor `b∈[0,1]`; the
 * bleed reaches `spread·b` px there, so the boundary wanders instead of dilating uniformly. A
 * pixel inside that local reach gains the nearest edge colour, its alpha feathered from full to
 * zero over the last `softness·spread` px (a hard 0.5px edge when `softness` is 0). ADDITIVE and
 * OUTWARD only — interior pixels are never touched, so it only ever grows the silhouette. `amount
 * ≤ 0` is a no-op. Mutates `data`. Deterministic: the seeded fbm above, no `Math.random`.
 */
export function applyInkBleedToData(
  data: Uint8ClampedArray, W: number, H: number, spec: InkBleedSpecLike, scale: number,
): void {
  const s = scale > 0 ? scale : 1
  const amount = clamp01(spec.amount)
  if (!(amount > 0)) return
  const soft = clamp01(spec.softness ?? 0)
  const spread = amount * INK_BLEED_MAX_W * W   // max outward reach, device px
  if (!(spread > 0)) return

  const { inside, minx, miny, maxx, maxy } = insideMask(data, W, H)
  if (maxx < 0) return

  const band = Math.ceil(spread) + 2
  const x0 = Math.max(0, Math.floor(minx - band)), y0 = Math.max(0, Math.floor(miny - band))
  const x1 = Math.min(W - 1, Math.ceil(maxx + band)), y1 = Math.min(H - 1, Math.ceil(maxy + band))

  const { d: distOut, src } = nearestInsideField(inside, W, x0, y0, x1, y1)
  const { fbm2 } = makeNoise(spec.seed)
  const f = 0.02 / s                            // blotch frequency (physically stable on retina)
  const feather = Math.max(0.5, soft * spread)
  const orig = data.slice()

  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x
    if (inside[i]) continue                     // OUTWARD only — never touch the interior
    const dd = distOut[i]!
    if (dd <= 0 || src[i]! < 0) continue
    const reach = spread * fbm2(x * f, y * f, 4, 0.5)
    if (dd >= reach) continue                   // beyond this blotch's local reach
    const cover = clamp01((reach - dd) / feather)
    const o = i * 4, so = src[i]! * 4
    const newA = orig[so + 3]! * cover
    if (newA > data[o + 3]!) {                   // additive — keep the strongest coverage
      data[o] = orig[so]!; data[o + 1] = orig[so + 1]!; data[o + 2] = orig[so + 2]!
      data[o + 3] = newA
    }
  }
}
