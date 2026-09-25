/**
 * Diffused edge — the pure pixel math behind the `diffused_edge` layer style.
 *
 * The layer keeps its own colour at the silhouette and fades to a fill colour toward the middle.
 * The pass (postEffects.ts) builds the OUTSIDE of the silhouette, blurs it by the effect width so
 * it bleeds back across the edge, and hands that map here: its alpha is ≈128 right on the edge and
 * falls to 0 deep inside, which is read as "how close to an edge".
 *
 * Grain turns the fade into all-or-nothing specks — each pixel is either the fill or its own
 * colour, with the smooth fade deciding how many specks land at each point (stipple, not haze).
 * Pure + deterministic: no canvas, no Math.random.
 */

export interface DiffusedEdgeParams {
  strength: number                   // 0..1 — how fully the middle turns to the fill
  fill: readonly [number, number, number]
  grain: number                      // 0 = smooth fade … 1 = pure speckle
  grainField: Float32Array | null    // diffusedEdgeGrainField(w, h, sizePx), or null with no grain
}

/** Mix `px` (RGBA, unpremultiplied — getImageData order) toward the fill in place. `outside` is
 *  the blurred outside-of-silhouette map, same size; only its alpha is read. Alpha is preserved
 *  and fully transparent pixels are skipped. */
export function diffusedEdgeInPlace(px: Uint8ClampedArray, outside: Uint8ClampedArray, p: DiffusedEdgeParams): void {
  const strength = Math.min(1, Math.max(0, p.strength))
  if (!(strength > 0)) return
  const [fr, fg, fb] = p.fill
  const grain = Math.min(1, Math.max(0, p.grain))
  const field = grain > 0 ? p.grainField : null
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue
    const near = Math.min(1, (outside[i + 3]! / 255) * 2)   // 1 at the edge, 0 far inside
    const t = 1 - near
    let f = strength * t * t * (3 - 2 * t)
    if (field) f += ((field[i >> 2]! < f ? 1 : 0) - f) * grain
    if (f <= 0) continue
    px[i] = px[i]! + (fr - px[i]!) * f
    px[i + 1] = px[i + 1]! + (fg - px[i + 1]!) * f
    px[i + 2] = px[i + 2]! + (fb - px[i + 2]!) * f
  }
}

// ── grain field ──────────────────────────────────────────────────────────────────────────────

/** One separable box-blur pass (clamped edges) along rows or columns, src → dst. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean): void {
  const n = horiz ? w : h, lines = horiz ? h : w, inv = 1 / (2 * r + 1)
  const idx = (l: number, k: number) => {
    const c = k < 0 ? 0 : k >= n ? n - 1 : k
    return horiz ? l * w + c : c * w + l
  }
  for (let l = 0; l < lines; l++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += src[idx(l, k)]!
    for (let k = 0; k < n; k++) {
      dst[idx(l, k)] = acc * inv
      acc += src[idx(l, k + r + 1)]! - src[idx(l, k - r)]!
    }
  }
}

/** Standard normal CDF (Abramowitz–Stegun erf, |error| < 1.5e-7). */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + (z < 0 ? -y : y))
}

/** mulberry32 — the same deterministic PRNG family the other grain passes use. */
function rng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fieldCache = new Map<string, Float32Array>()
const FIELD_CACHE_MAX = 3

/**
 * A w×h field of even 0..1 values — a fair coin per pixel — with specks about `sizePx` across.
 * 1 px white noise softened by three box-blur passes (≈ Gaussian, round specks, no grid), kept in
 * floats so a big blur doesn't band, then pushed through the normal CDF so it is evenly spread
 * again — thresholding it against the fade then puts exactly the right share of specks at every
 * point. Fixed seed: the grain never crawls between renders. Cached (a few sizes).
 */
export function diffusedEdgeGrainField(w: number, h: number, sizePx: number): Float32Array {
  const rad = Math.max(0, Math.round((sizePx - 1) * 0.6))
  const key = `${w}x${h}:${rad}`
  const hit = fieldCache.get(key)
  if (hit) { fieldCache.delete(key); fieldCache.set(key, hit); return hit }
  const next = rng(42)
  const a = new Float32Array(w * h)
  for (let i = 0; i < a.length; i++) a[i] = next()
  if (rad > 0) {
    for (let i = 0; i < a.length; i++) a[i] = a[i]! - 0.5
    const b = new Float32Array(w * h)
    for (let pass = 0; pass < 3; pass++) { boxPass(a, b, w, h, rad, true); boxPass(b, a, w, h, rad, false) }
    let sq = 0
    for (let i = 0; i < a.length; i++) sq += a[i]! * a[i]!
    const inv = 1 / Math.sqrt(sq / a.length || 1)
    for (let i = 0; i < a.length; i++) a[i] = phi(a[i]! * inv)
  }
  fieldCache.set(key, a)
  if (fieldCache.size > FIELD_CACHE_MAX) fieldCache.delete(fieldCache.keys().next().value!)
  return a
}

// ── layer depth ──────────────────────────────────────────────────────────────────────────────

/** Most cells the depth grid may hold; beyond this the layer is sampled coarser (a big shape
 *  keeps its depth to within a percent or two, a thin one stays at full resolution). */
const DEPTH_MAX_CELLS = 262144

/** Squared Euclidean distance transform along one line (Felzenszwalb–Huttenlocher), in place. */
function edt1d(f: Float64Array, n: number, v: Int32Array, z: Float64Array, out: Float64Array): void {
  let k = 0
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
    while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!) }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++
    out[q] = (q - v[k]!) ** 2 + f[v[k]!]!
  }
}

/**
 * How deep the layer's shape is: the distance from its outline to its deepest point (half the
 * thickness of its thickest part), in the same pixels as `px`. 0 for an empty layer. The
 * diffused edge scales its fade by this, so a thin shape and a fat one at the same Width get the
 * same share of rim. Read from the alpha (≥ 128 = inside), within the shape's bounding box, on
 * a grid capped at DEPTH_MAX_CELLS; an exact distance transform on that grid.
 */
export function layerDepthPx(px: Uint8ClampedArray, w: number, h: number): number {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (px[(row + x) * 4 + 3]! >= 128) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
  }
  if (x1 < 0) return 0
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const cell = Math.max(1, Math.sqrt((bw * bh) / DEPTH_MAX_CELLS))
  // One cell of outside all round, so the bounding box's own edge counts as outline.
  const gw = Math.ceil(bw / cell) + 2, gh = Math.ceil(bh / cell) + 2
  const grid = new Float64Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.floor(x0 + (gx - 1 + 0.5) * cell), sy = Math.floor(y0 + (gy - 1 + 0.5) * cell)
      const inside = gx > 0 && gy > 0 && gx < gw - 1 && gy < gh - 1 && sx <= x1 && sy <= y1
        && px[(sy * w + sx) * 4 + 3]! >= 128
      grid[gy * gw + gx] = inside ? 1e20 : 0
    }
  }
  const n = Math.max(gw, gh)
  const f = new Float64Array(n), out = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n)
  for (let gx = 0; gx < gw; gx++) {                       // columns
    for (let gy = 0; gy < gh; gy++) f[gy] = grid[gy * gw + gx]!
    edt1d(f, gh, v, z, out)
    for (let gy = 0; gy < gh; gy++) grid[gy * gw + gx] = out[gy]!
  }
  let best = 0
  for (let gy = 0; gy < gh; gy++) {                       // rows
    for (let gx = 0; gx < gw; gx++) f[gx] = grid[gy * gw + gx]!
    edt1d(f, gw, v, z, out)
    for (let gx = 0; gx < gw; gx++) if (out[gx]! > best) best = out[gx]!
  }
  return Math.sqrt(best) * cell
}
