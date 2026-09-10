/**
 * Frame mesh-warp ENGINE (F3 Task 4a) — PURE, no DOM.
 *
 * Four displacement FIELDS map a point to a displaced point, each parameterised by the
 * shape's own bounding box so the warp reads consistently across shapes rather than against
 * the canvas. A field normalises `(x,y)` to bbox-relative `(u,v)` about the bbox centre —
 * `u = (x−cx)/(w/2)`, `v = (y−cy)/(h/2)`, so the bbox edges sit at `±1` — displaces in that
 * normalised space, then maps back. That makes `amount` mean the same thing on a tall shape
 * and a wide one, and makes the bbox centre the natural fixed point.
 *
 * The four fields (`WarpField`):
 *  - `bulge` / `pinch`: ONE signed radial field (`radialWarpPoint`) — bulge pushes each
 *    outline point OUTWARD from the centre, pinch (the negated sign) pulls it IN. The two are
 *    surfaced as separate menu entries but share the maths; the magnitude grows with radius
 *    (`smoothstep01` of the normalised radius), so the centre is a fixed point and the rim
 *    moves most. NOTE: this is an OUTLINE warp — the visible geometry IS the rim, so the field
 *    must move the rim (unlike an interior/raster spherize, which tapers to 0 at the edge to
 *    keep pixels inside; Task 4b, the raster path, may want a different profile — see report).
 *  - `wave`: a sinusoidal shear — offsets a point along X by `amount·sin(2π·freq·v + phase)`,
 *    a flag/ripple as a function of vertical position. `frequency` is cycles over the bbox
 *    height; `phase` defaults to 0 (not exposed — an unread dial would be a dead control).
 *  - `twist`: rotates each point about the bbox centre by `amount·π / (1 + k·r²)`, so the twist
 *    is STRONGEST at the centre and DECAYS with radius (a swirl) — but never reaches 0, so the
 *    rim still rotates (a plain rectangle, whose outline is nothing but rim corners, still
 *    twists; a falloff that hit 0 at the edge would leave it untouched). Rotation preserves each
 *    point's radius, so the overall extent is preserved regardless. The centre is the pivot.
 *
 * `warpPathD(d, field, params)` flattens `d` (reusing `flatten`/`toPathD` from `pathOps`,
 * exactly as the sibling/boolean/morph geometry paths do), computes the bbox from the
 * flattened points, displaces every point through the field, and re-emits. Curves flatten
 * first (every geometry consumer already flattens). Empty/degenerate in → input returned
 * unchanged. Deterministic — no `Math.random`, no time.
 *
 * The per-field maths are exported as small pure functions so Task 4b (the raster pixel-warp
 * path) can sample `warpPoint` over an N×N mesh grid without re-deriving the fields.
 */
import { flatten, toPathD, type Pt2, type Polyline } from '~/lib/vector/pathOps'

export type WarpField = 'bulge' | 'pinch' | 'wave' | 'twist'

/** A shape's bounding box in the same units as the outline `d`. */
export interface WarpBBox { minX: number; minY: number; w: number; h: number }

/** Field parameters. `amount` is the shared strength dial (its unit depends on the field —
 *  a fraction of the half-extent for bulge/pinch/wave, a fraction of π radians for twist);
 *  `frequency` is read only by `wave`, `phase` defaults to 0 and is not surfaced. */
export interface WarpParams { amount: number; frequency?: number; phase?: number }

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
/** Hermite smoothstep on [0,1]: 0 at 0, 1 at 1, zero slope at both ends. */
export const smoothstep01 = (v: number): number => {
  const t = clamp01(v)
  return t * t * (3 - 2 * t)
}

/** Bounding box of a flattened outline; `null` when there are no points. */
export function bboxOfPolylines(subs: readonly Polyline[]): WarpBBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of subs) for (const p of s.pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { minX, minY, w: maxX - minX, h: maxY - minY }
}

// ── the fields (pure, per-point) ───────────────────────────────────────────────
// Each returns a NEW point; a degenerate bbox (zero width or height) or the identity case
// (zero displacement) returns the point's own coordinates unchanged.

interface Norm { cx: number; cy: number; hw: number; hh: number; u: number; v: number }
/** Normalise a point to bbox-relative `(u,v)` about the centre, `±1` at the edges.
 *  Returns `null` when the bbox has no area (nothing sensible to normalise against). */
function normalise(p: Pt2, b: WarpBBox): Norm | null {
  const hw = b.w / 2, hh = b.h / 2
  if (!(hw > 0) || !(hh > 0)) return null
  const cx = b.minX + hw, cy = b.minY + hh
  return { cx, cy, hw, hh, u: (p.x - cx) / hw, v: (p.y - cy) / hh }
}

/** Radial bulge (`signedAmount > 0`, out) / pinch (`< 0`, in) about the bbox centre.
 *  Magnitude grows with normalised radius via `smoothstep01`, so the centre is fixed and
 *  the rim moves most. */
export function radialWarpPoint(p: Pt2, b: WarpBBox, signedAmount: number): Pt2 {
  const n = normalise(p, b)
  if (!n) return { x: p.x, y: p.y }
  const rn = Math.hypot(n.u, n.v)
  if (rn < 1e-9 || signedAmount === 0) return { x: p.x, y: p.y } // centre / no-op → fixed
  const dispN = signedAmount * smoothstep01(rn)
  const u2 = n.u + (n.u / rn) * dispN
  const v2 = n.v + (n.v / rn) * dispN
  return { x: n.cx + u2 * n.hw, y: n.cy + v2 * n.hh }
}

/** Sinusoidal X-shear as a function of vertical position: `u += amount·sin(2π·freq·v + phase)`. */
export function waveWarpPoint(p: Pt2, b: WarpBBox, amount: number, frequency: number, phase = 0): Pt2 {
  const n = normalise(p, b)
  if (!n) return { x: p.x, y: p.y }
  if (amount === 0) return { x: p.x, y: p.y }
  const u2 = n.u + amount * Math.sin(2 * Math.PI * frequency * n.v + phase)
  return { x: n.cx + u2 * n.hw, y: n.cy + n.v * n.hh }
}

/** How fast the twist decays with normalised radius (`amount·π / (1 + TWIST_DECAY·r²)`).
 *  Chosen so the rim (r=1) still turns ~40% of the centre's angle — a visible swirl on any
 *  shape, including a bare rectangle — while the centre clearly leads. */
const TWIST_DECAY = 1.5
/** Rotate about the bbox centre by `amount·π / (1 + TWIST_DECAY·r²)` — strongest at the centre,
 *  decaying but never 0 at the rim. The centre is fixed (it is the pivot). */
export function twistWarpPoint(p: Pt2, b: WarpBBox, amount: number): Pt2 {
  const n = normalise(p, b)
  if (!n) return { x: p.x, y: p.y }
  if (amount === 0) return { x: p.x, y: p.y }
  const rn = Math.hypot(n.u, n.v)
  const angle = (amount * Math.PI) / (1 + TWIST_DECAY * rn * rn)
  if (angle === 0) return { x: p.x, y: p.y }
  const ca = Math.cos(angle), sa = Math.sin(angle)
  const u2 = n.u * ca - n.v * sa
  const v2 = n.u * sa + n.v * ca
  return { x: n.cx + u2 * n.hw, y: n.cy + v2 * n.hh }
}

/** Dispatch one point through the chosen field. Pure; reused per-vertex by `warpPathD`
 *  (vector outline) and, later, by the Task 4b raster mesh sampler. */
export function warpPoint(p: Pt2, b: WarpBBox, field: WarpField, params: WarpParams): Pt2 {
  const amount = params.amount
  switch (field) {
    case 'bulge': return radialWarpPoint(p, b, amount)
    case 'pinch': return radialWarpPoint(p, b, -amount)
    case 'wave': return waveWarpPoint(p, b, amount, params.frequency ?? 3, params.phase ?? 0)
    case 'twist': return twistWarpPoint(p, b, amount)
    default: return { x: p.x, y: p.y }
  }
}

/**
 * Displace a vector outline `d` through a warp field. Flattens `d`, computes the bbox from
 * the flattened points, warps every point, and re-emits. An empty or degenerate outline
 * (no points, or zero bbox area) returns `d` unchanged; a zero `amount` yields identical
 * COORDINATES (the caller — `geometryEffects.applyWarp` — short-circuits amount≈0 to return
 * the input string by reference, so no reserialisation happens on a no-op).
 */
export function warpPathD(d: string, field: WarpField, params: WarpParams): string {
  const subs = flatten(d)
  if (subs.length === 0) return d
  const b = bboxOfPolylines(subs)
  if (!b || !(b.w > 0) || !(b.h > 0)) return d // degenerate — nothing to warp against
  const out: Polyline[] = subs.map(sub => ({
    pts: sub.pts.map(p => warpPoint(p, b, field, params)),
    closed: sub.closed,
  }))
  return toPathD(out)
}
