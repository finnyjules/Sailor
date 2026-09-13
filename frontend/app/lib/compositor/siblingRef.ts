/**
 * Frame effects F3 — the SIBLING-REFERENCE rail (`refLayerId`). PURE. No Vue, no canvas.
 *
 * A geometry effect (boolean, Task 2; morph, Task 3) can point at ANOTHER layer by a
 * `StackKey` (`l:<id>` local, `w:<slot>` wired) — a `refLayerId` that mirrors the compositor's
 * mask reference (`maskedByKey`) in every way that matters: it is DANGLING-TOLERANT (a deleted
 * or absent target makes the effect a no-op, never throws — there is NO delete-time cleanup),
 * and on DUPLICATE the key is carried VERBATIM (the dup points at the ORIGINAL sibling; only
 * `groupId` is idMap-repointed — see `duplicateLayers`).
 *
 * The 3D analog is `booleanCtxFor` in `lib/scene3d/engine.ts`: resolve the referenced object,
 * transform it into the referencing object's frame (`inverse(selfWorld)·siblingWorld`), and
 * build the sibling with the resolver DISABLED so its own boolean can't recurse. This module
 * is the 2D version of exactly that.
 *
 * `applyGeometry` is pure and sees only the self path `d`; the sibling outline reaches it via
 * an OPTIONAL resolver in its options (`GeometryContext.resolveSibling`). This module builds
 * that resolver. It is PRESENT-BUT-UNCONSUMED until the first consumer (boolean, Task 2), so
 * byte-identity holds today: no current geometry kind carries a `refLayerId`, so the resolver
 * is never invoked and the `applyGeometry` cache key is unchanged.
 */
import {
  type Affine,
  IDENTITY_AFFINE,
  multiplyAffine,
  invertAffine,
} from '~/lib/vector/svg'
import { flatten, toPathD, type Pt2 } from '~/lib/vector/pathOps'
// One definition of the resolved-sibling shape lives with `applyGeometry`'s options (it is what
// `GeometryContext.resolveSibling` returns); re-export it here so consumers of this module get
// the same type without a second, drift-prone declaration.
import type { ResolvedSibling } from '~/lib/compositor/geometryEffects'
export type { ResolvedSibling }

const DEG_TO_RAD = Math.PI / 180

/**
 * A layer's placement, enough to compose its world transform. The fields mirror the ctx ops
 * `paintLayer`'s `applyXform` applies (`translate(x·W, y·H)` → `rotate` → shear → the content
 * scale): `x`/`y` are normalized centers, `rotation`/`skewX`/`skewY` are degrees, and `unitPx`
 * is how many canvas PIXELS one unit of the layer's OUTLINE `d` renders as — the isotropic
 * content scale, which is `1` for rect/ellipse/text (their `d` is already in px), `scale·W` for
 * a path, and `W` for a polygon/star (rewritten to a `scale: 1` path when drawn).
 */
export interface SiblingPlacement {
  x: number
  y: number
  rotation?: number
  skewX?: number
  skewY?: number
  unitPx: number
}

/**
 * A layer's world affine: `T(x·W, y·H) · R(rotation) · Shear(skewX,skewY) · S(unitPx)`, mapping
 * a point in the layer's OUTLINE units to canvas pixels. Composed with `multiplyAffine` in the
 * same order `applyXform` sets the ctx (translate, then rotate, then shear, then the content
 * scale), so a local point maps exactly the way the renderer would place it.
 */
export function layerAffine(p: SiblingPlacement, W: number, H: number): Affine {
  const T: Affine = [1, 0, 0, 1, p.x * W, p.y * H]
  const rot = Number.isFinite(p.rotation) ? (p.rotation as number) : 0
  const rad = rot * DEG_TO_RAD
  const cos = rot === 0 ? 1 : Math.cos(rad)
  const sin = rot === 0 ? 0 : Math.sin(rad)
  const R: Affine = [cos, sin, -sin, cos, 0, 0]
  const skx = Number.isFinite(p.skewX) ? (p.skewX as number) : 0
  const sky = Number.isFinite(p.skewY) ? (p.skewY as number) : 0
  // Same shear ctx.transform(1, tan(skewY), tan(skewX), 1, 0, 0) `applyXform` uses.
  const Shear: Affine = (skx || sky)
    ? [1, Math.tan(sky * DEG_TO_RAD), Math.tan(skx * DEG_TO_RAD), 1, 0, 0]
    : IDENTITY_AFFINE
  const u = Number.isFinite(p.unitPx) && p.unitPx !== 0 ? (p.unitPx as number) : 1
  const S: Affine = [u, 0, 0, u, 0, 0]
  // multiplyAffine(m, n) applies n first — so this reads inner→outer as S, Shear, R, T.
  return multiplyAffine(multiplyAffine(multiplyAffine(T, R), Shear), S)
}

/** Map a point through an affine `[a,b,c,d,e,f]`: (a·x + c·y + e, b·x + d·y + f). */
function applyAffine(m: Affine, pt: Pt2): Pt2 {
  return { x: m[0] * pt.x + m[2] * pt.y + m[4], y: m[1] * pt.x + m[3] * pt.y + m[5] }
}

/** Transform every point of an SVG `d` by an affine, flattening curves to polylines first
 *  (the boolean/morph consumers flatten anyway). Empty in, empty out. */
export function transformPathD(d: string, m: Affine): string {
  if (!d) return ''
  const subs = flatten(d).map(sub => ({
    pts: sub.pts.map(p => applyAffine(m, p)),
    closed: sub.closed,
  }))
  return toPathD(subs)
}

// `ResolvedSibling` = { d, W, subKey } — the sibling outline transformed into the referencing
// layer's frame, plus a stable `subKey` for the `applyGeometry` cache (it changes iff the
// delivered outline changes: the sibling's own geometry OR the relative transform moved).
// Imported from `geometryEffects` above so there is a single definition.

/**
 * Injected, PURE dependencies. The composable supplies these from its live layer list and the
 * outline helpers (`computedOutlineD`, `canTakeGeometry`); unit tests supply fakes. Keeping the
 * outline computation OUT of this module is deliberate: it lives in the composable, and the
 * brief calls for a pure resolver rather than importing the composable.
 */
export interface SiblingResolverDeps<L> {
  W: number
  H: number
  layers: readonly L[]
  /** The layer's StackKey (`l:<id>`), the same value a `refLayerId` holds. */
  keyOf: (layer: L) => string
  /** `canTakeGeometry`-style eligibility — a boolean/morph partner must be outline-able. */
  eligible: (layer: L) => boolean
  /**
   * The sibling's outline `d` in ITS OWN outline units, computed with the sibling's own
   * sibling-resolution DISABLED (the S2 "sibling built with no ctx" cycle guard). `null` when
   * the layer has no base outline.
   */
  outlineOf: (layer: L) => { d: string } | null
  placementOf: (layer: L) => SiblingPlacement
}

/** `(refLayerId, self) -> the sibling outline in self's frame`, or `null`. */
export type SiblingResolver<L> = (key: string, self: L) => ResolvedSibling | null

/**
 * Build the resolver. Every guard returns `null` (never throws):
 *  - missing/empty key, or a key that resolves to no live layer (DANGLING);
 *  - self-reference (the key points at the referencing layer);
 *  - a non-vector / ineligible target (fails `eligible`);
 *  - a CYCLE (A refs B, B refs A): a `resolving` set of keys currently being resolved short-
 *    circuits re-entry to `null`, so a consumer whose `outlineOf` walks back into the resolver
 *    terminates instead of recursing forever. The real composable's `outlineOf` also disables
 *    sibling resolution structurally, so both belts hold the cycle.
 *  - a singular self transform (zero scale) — `invertAffine` returns `null`.
 *
 * The delivered `d` is the sibling outline transformed by `inverse(A_self)·A_sibling`; the
 * outline-unit scales fold into `A` and cancel, so `d` lands in self's own outline units — the
 * exact frame `applyGeometry` receives self's `d` in.
 */
export function makeSiblingOutlineResolver<L>(deps: SiblingResolverDeps<L>): SiblingResolver<L> {
  const resolving = new Set<string>()
  return function resolve(key: string, self: L): ResolvedSibling | null {
    if (!key) return null
    if (deps.keyOf(self) === key) return null // self-reference
    const target = deps.layers.find(l => deps.keyOf(l) === key)
    if (!target) return null // dangling — target removed or never present
    if (target === self) return null // self-reference by identity
    if (!deps.eligible(target)) return null // non-vector / ineligible partner
    const tKey = deps.keyOf(target)
    if (resolving.has(tKey)) return null // cycle — this nested resolution is disabled

    const selfA = layerAffine(deps.placementOf(self), deps.W, deps.H)
    const invSelf = invertAffine(selfA)
    if (!invSelf) return null // singular self transform (zero scale) — no-op rather than NaN

    resolving.add(tKey)
    let outline: { d: string } | null
    try {
      outline = deps.outlineOf(target)
    } finally {
      resolving.delete(tKey)
    }
    if (!outline || !outline.d) return null

    const sibA = layerAffine(deps.placementOf(target), deps.W, deps.H)
    const m = multiplyAffine(invSelf, sibA) // inverse(selfWorld) · siblingWorld
    const d = transformPathD(outline.d, m)
    if (!d) return null
    // The transformed `d` already encodes the sibling geometry AND the relative transform,
    // so it is the whole cache signature. Prefix the key to keep it unambiguous across siblings.
    return { d, W: deps.W, subKey: `${tKey}#${d}` }
  }
}
