/**
 * Frame geometry effects (F2) — PURE. `applyGeometry(d, effects, {W})` transforms an
 * SVG `d` string BEFORE it rasterises, applying each ENABLED geometry effect in list
 * order and returning a new `d`. No Vue, no canvas, no `document`.
 *
 * Single source of truth: the kinds, labels, per-kind interfaces and dial defaults all
 * come from `effectStack.ts` — this module re-exports/derives them rather than restating
 * any label string or default value, so the vocabulary can never drift between the stack
 * and the transform.
 *
 * Task 3 implements TRIM and ROUGHEN. OFFSET and ROUND_CORNERS are declared (via the
 * re-exported interfaces) and dispatched, but their transforms are deliberate PASS-THROUGH
 * stubs until Task 4 — a stubbed kind returns its input `d` unchanged, so the union
 * compiles and a stack carrying one is a no-op instead of an error.
 */
import {
  EFFECT_LABELS,
  GEOMETRY_KINDS,
  isGeometryKind,
  createEffect,
  type EffectKind,
} from './effectStack'
import {
  flatten,
  toPathD,
  pathLength,
  resampleByLength,
  type Pt2,
  type Polyline,
} from '~/lib/vector/pathOps'

// The per-kind interfaces live in effectStack (it owns the whole effect vocabulary and the
// LayerEffect union). Re-export them here so a consumer can `import type { TrimEffect } from
// './geometryEffects'` without duplicating a single field declaration.
export type {
  TrimEffect,
  OffsetEffect,
  RoundCornersEffect,
  RoughenEffect,
} from './effectStack'
export { GEOMETRY_KINDS, isGeometryKind } from './effectStack'

/** Sentence-case labels for the four geometry kinds, PICKED from the stack's single
 *  `EFFECT_LABELS` map — no label string is re-typed here. */
export const GEOMETRY_EFFECT_LABELS = Object.fromEntries(
  GEOMETRY_KINDS.map(k => [k, EFFECT_LABELS[k]]),
) as Record<(typeof GEOMETRY_KINDS)[number], string>

/** Dial defaults per geometry kind, DERIVED from the stack's `createEffect` (its
 *  `LOCAL_DEFAULTS` is the single source) with the runtime-only `id`/`type` stripped. */
export const GEOMETRY_EFFECT_DEFAULTS = Object.fromEntries(
  GEOMETRY_KINDS.map((k) => {
    const { id: _id, type: _type, ...rest } = createEffect(k)
    return [k, rest as Record<string, unknown>]
  }),
) as Record<(typeof GEOMETRY_KINDS)[number], Record<string, unknown>>

// ── input shape ──────────────────────────────────────────────────────────────
export interface GeometryContext { W: number }
type GeometryEffectInput = { type: string; visible?: boolean; [k: string]: unknown }

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

// ── trim ───────────────────────────────────────────────────────────────────
//
// Arc-length trim of each subpath to the fraction `[start, end]`, rotated by `offset`.
// A trimmed CLOSED loop becomes an OPEN polyline (you cannot close a partial ring).
//
// Closed-chord caveat (see pathOps): `cumulativeLengths` omits the wrap chord, and the
// true perimeter is `pathLength(pts, true)`. So we build our OWN anchor list that appends
// the return-to-start vertex at cumulative position === total, and — for a closed subpath —
// DOUBLE it (each anchor repeated at `c + total`) so a window that wraps past the seam is a
// plain linear walk with no modular arithmetic.
//
// `start >= end` (after nothing survives) → the subpath is dropped (empty). Documented and
// tested; the alternative (a degenerate zero-length point) would serialise to a stray `M`.
interface Anchor { c: number; p: Pt2 }

function lerp(a: Pt2, b: Pt2, t: number): Pt2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Point at cumulative arc length `s` along an ascending anchor list (clamped to its span). */
function pointAt(anchors: readonly Anchor[], s: number): Pt2 {
  const first = anchors[0]!, last = anchors[anchors.length - 1]!
  if (s <= first.c) return { ...first.p }
  if (s >= last.c) return { ...last.p }
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!, b = anchors[i]!
    if (s <= b.c) {
      const span = b.c - a.c
      return span <= 0 ? { ...a.p } : lerp(a.p, b.p, (s - a.c) / span)
    }
  }
  return { ...last.p }
}

function dedupeConsecutive(pts: readonly Pt2[]): Pt2[] {
  const out: Pt2[] = []
  for (const p of pts) {
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-9) out.push({ x: p.x, y: p.y })
  }
  return out
}

function trimSubpath(poly: Polyline, start: number, end: number, offset: number): Polyline | null {
  const { pts, closed } = poly
  if (pts.length < 2) return null
  if (end <= start) return null // start >= end → empty
  const total = pathLength(pts, closed)
  if (total <= 0) return null

  // Anchor list with cumulative positions; append the return-to-start vertex for a closed loop.
  const base: Anchor[] = [{ c: 0, p: pts[0]! }]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
    base.push({ c: acc, p: pts[i]! })
  }
  if (closed) {
    acc += Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y)
    base.push({ c: acc, p: pts[0]! })
  }

  let f0 = start + offset
  let f1 = end + offset
  let walk: Anchor[]
  if (closed) {
    // Rotate the window into [0, total): drop whole turns off the start, keep the same span.
    const shift = Math.floor(f0)
    f0 -= shift
    f1 -= shift // now f0 ∈ [0,1), f1 ∈ (f0, f0+1] ⊂ (0, 2)
    // Double the anchors so a window crossing the seam is a linear walk over [0, 2·total).
    walk = [...base, ...base.map(a => ({ c: a.c + total, p: a.p }))]
  } else {
    // Open path: clamp the window; offset shifts but does not wrap.
    f0 = Math.max(0, Math.min(1, f0))
    f1 = Math.max(0, Math.min(1, f1))
    if (f1 <= f0) return null
    walk = base
  }

  const s0 = f0 * total
  const s1 = f1 * total
  const EPS = 1e-6
  const out: Pt2[] = [pointAt(walk, s0)]
  for (const a of walk) if (a.c > s0 + EPS && a.c < s1 - EPS) out.push({ ...a.p })
  out.push(pointAt(walk, s1))

  const cleaned = dedupeConsecutive(out)
  if (cleaned.length < 2) return null
  return { pts: cleaned, closed: false } // trim always opens the path
}

function applyTrim(d: string, e: GeometryEffectInput): string {
  const start = num(e.start, 0)
  const end = num(e.end, 1)
  const offset = num(e.offset, 0)
  const subs = flatten(d)
  const out: Polyline[] = []
  for (const sub of subs) {
    const t = trimSubpath(sub, start, end, offset)
    if (t) out.push(t)
  }
  return toPathD(out)
}

// ── roughen ──────────────────────────────────────────────────────────────────
//
// Resample each subpath at even arc length (`detail` controls sample density), then
// displace every sample along its OUTWARD normal — the angle-bisector normal, same
// left-normal convention as `strokeShapes.offsetPolyline` but WITHOUT the miter scale, so a
// unit vector keeps the displacement bounded — by `amount·W·noise(i,seed)`, where `noise` is
// a deterministic integer hash in [-1,1]. The subpath re-closes if it started closed.
//
// Because the normal is unit and |noise| ≤ 1, no sample moves more than `amount·W` off the
// resampled outline, which is exactly the near-original guarantee the tests assert.

/** Density knob: samples per subpath ≈ detail · SUBPATH_POINT_BUDGET (step = perimeter / that). */
const SUBPATH_POINT_BUDGET = 4

/** Deterministic hash of (i, seed) → [-1, 1]. Integer mixing (xorshift-ish), no Math.random. */
function seededNoise(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return (h / 0xffffffff) * 2 - 1
}

const shoelace = (pts: readonly Pt2[]): number => {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!
    a += p.x * q.y - q.x * p.y
  }
  return a
}

/** Unit angle-bisector normals, one per point. y-down left normal of (dx,dy) is (dy,-dx);
 *  a closed ring's outward sense follows its winding (shoelace), like `offsetPolyline`. */
function bisectorNormals(pts: readonly Pt2[], closed: boolean): Pt2[] {
  const n = pts.length
  const sign = closed && shoelace(pts) < 0 ? -1 : 1
  const seg = (a: Pt2, b: Pt2): Pt2 => {
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    return { x: dy / len, y: -dx / len }
  }
  const out: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!, cur = pts[i]!, next = pts[(i + 1) % n]!
    let nx = 0, ny = 0
    const hasPrev = closed || i > 0
    const hasNext = closed || i < n - 1
    if (hasPrev) { const m = seg(prev, cur); nx += m.x; ny += m.y }
    if (hasNext) { const m = seg(cur, next); nx += m.x; ny += m.y }
    const len = Math.hypot(nx, ny)
    if (len < 1e-9) { out.push({ x: 0, y: 0 }); continue }
    out.push({ x: (nx / len) * sign, y: (ny / len) * sign })
  }
  return out
}

function applyRoughen(d: string, e: GeometryEffectInput, ctx: GeometryContext): string {
  const amount = num(e.amount, 0)
  if (amount <= 0) return d // amount 0 is an exact no-op (identity), not a reserialised round-trip
  const detail = Math.max(1, Math.round(num(e.detail, 8)))
  const seed = Math.round(num(e.seed, 1))
  const amountPx = amount * ctx.W
  const subs = flatten(d)
  const out: Polyline[] = subs.map((sub) => {
    if (sub.pts.length < 2) return sub
    const perim = pathLength(sub.pts, sub.closed)
    if (perim <= 0) return sub
    const step = perim / (detail * SUBPATH_POINT_BUDGET)
    const sampled = step > 0 && Number.isFinite(step)
      ? resampleByLength(sub.pts, sub.closed, step)
      : sub.pts.map(p => ({ ...p }))
    if (sampled.length < 2) return sub
    const normals = bisectorNormals(sampled, sub.closed)
    const pts = sampled.map((p, i) => {
      const disp = amountPx * seededNoise(i, seed)
      return { x: p.x + normals[i]!.x * disp, y: p.y + normals[i]!.y * disp }
    })
    return { pts, closed: sub.closed }
  })
  return toPathD(out)
}

// ── dispatch ──────────────────────────────────────────────────────────────────
function applyOne(d: string, e: GeometryEffectInput, ctx: GeometryContext): string {
  switch (e.type) {
    case 'trim': return applyTrim(d, e)
    case 'roughen': return applyRoughen(d, e, ctx)
    // Task 4 — deliberate pass-through stubs so the union compiles and the stack is a no-op.
    case 'offset': return d
    case 'round_corners': return d
    default: return d
  }
}

// ── LRU cache ─────────────────────────────────────────────────────────────────
const CACHE_MAX = 64
const cache = new Map<string, string>()

/**
 * Apply every ENABLED geometry effect in list order over `d`, returning a new `d`.
 *
 * IDENTITY GUARANTEE: with no enabled geometry effect, the SAME input string is returned
 * (reference-equal), so the no-effect paint path is a provable no-op — a caller can compare
 * by identity to decide whether the computed-outline path is even needed.
 *
 * Cached by (`d`, JSON of the enabled effects, `W`) with a small LRU.
 */
export function applyGeometry(
  d: string,
  effects: readonly GeometryEffectInput[],
  ctx: GeometryContext,
): string {
  const enabled = effects.filter(e => isGeometryKind(e.type as EffectKind) && e.visible !== false)
  if (enabled.length === 0) return d // identity — same reference

  const key = `${ctx.W}${d}${JSON.stringify(enabled)}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit) // refresh recency
    return hit
  }

  let cur = d
  for (const e of enabled) cur = applyOne(cur, e, ctx)

  cache.set(key, cur)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return cur
}
