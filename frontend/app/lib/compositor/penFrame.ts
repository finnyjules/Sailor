/**
 * Frame — SHARED PEN geometry (Plan B, Task 5). PURE.
 *
 * The shared pen (`app/lib/sketch/*`) draws in its own DRAWING units, tuned so
 * the solver's absolute tolerances land in the right magnitude (see
 * `constraints.md`, decision 1). A Frame path layer's `d` — and a text layer's
 * path-guide `d` — is stored in LOCAL units, where 1 unit = the canvas width
 * (see `PathLayer` in `useCompositorLayers.ts`). This module is the one place
 * that knows the ratio between them, and the one place that builds a
 * `ViewMatrix` (`app/lib/sketch/view.ts`) mapping drawing units onto the
 * artboard pixels the pen actually draws on top of — for a path layer
 * (`layerView`) or for a text layer's guide (`guideView`).
 *
 * ## Units
 *
 * `SKETCH_UNITS = 100`: a stored `sketch`'s drawing units are `local units ×
 * SKETCH_UNITS`. `sketchToLocalD` is the one conversion; anywhere a `sketch` is
 * stored, `d === sketchToLocalD(sketch)` is the invariant (see `TextPathSpec`
 * in `textPath.ts`).
 *
 * ## The view matrices
 *
 * Both `layerView` and `guideView` reproduce the Frame's own draw transform —
 * `applyXform`/`drawPath` in `useCompositorLayers.ts` — exactly:
 *
 *   artboard px = T(x·W, y·H) · R(rotation°) · Sh(skewX, skewY) · S(scale·W) · p_local
 *
 * with `Sh = matrix(1, tan(skewY), tan(skewX), 1, 0, 0)`. `layerView` takes that
 * straight through, scaled once more by `1/SKETCH_UNITS` so its input is
 * DRAWING units (what the pen itself edits) rather than local units.
 * `guideView` composes the same rotate/shear with `textPath.ts`'s
 * `customGuideMapping` — the exact mapping the text-on-path renderer uses from
 * a local-unit point on the guide's outline to guide pixels — so a drawing
 * point lands on precisely the pixel the text layer would draw its guide
 * through.
 *
 * ## Re-centring
 *
 * A drawing is edited in its own local frame; nothing requires its outline to
 * sit on (0,0). `recentreSketch` shifts every point so the outline's bbox
 * centre becomes the origin (matching how a fresh `segmentsToPathLayer` layer
 * is always built) and reports the shift in LOCAL units so a caller can move
 * the host layer's `x`/`y` by the equivalent screen amount —
 * `placementAfterRecentre` does exactly that — keeping the drawing planted
 * where the artist left it on screen.
 *
 * PURE: no Vue, no DOM.
 */
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { flattenPath } from '~/lib/compositor/pathFlatten'
import { applyView, type ViewMatrix } from '~/lib/sketch/view'
import { customGuideMapping } from '~/lib/compositor/textPath'

const DEG = Math.PI / 180

/** Drawing units per local unit. See the header. */
export const SKETCH_UNITS = 100

// ── Matrix helpers (local to this module) ───────────────────────────────────

const IDENTITY: ViewMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function translate(tx: number, ty: number): ViewMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }
}

function rotate(deg: number): ViewMatrix {
  const r = deg * DEG
  const cos = Math.cos(r), sin = Math.sin(r)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

function shear(skewXDeg: number, skewYDeg: number): ViewMatrix {
  return { a: 1, b: Math.tan(skewYDeg * DEG), c: Math.tan(skewXDeg * DEG), d: 1, e: 0, f: 0 }
}

function scaleM(s: number): ViewMatrix {
  return { a: s, b: 0, c: 0, d: s, e: 0, f: 0 }
}

/** Compose two views: `mul(m1, m2)` applied to a point is `m1(m2(point))`. */
function mul(m1: ViewMatrix, m2: ViewMatrix): ViewMatrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

/** Compose left-to-right (`chain(A, B, C)` applied is `A(B(C(point)))`). */
function chain(...ms: ViewMatrix[]): ViewMatrix {
  return ms.reduceRight((acc, m) => mul(m, acc), IDENTITY)
}

// ── Drawing units ↔ local units ──────────────────────────────────────────────

/** A stored `sketch`'s outline, `d` in LOCAL units (points and circle radii
 *  divided by `SKETCH_UNITS`). This is the one place a `sketch` becomes a `d`. */
export function sketchToLocalD(sketch: SketchDoc): string {
  const scaled = cloneDoc(sketch)
  for (const e of scaled.entities) {
    if (e.kind === 'point') { e.x /= SKETCH_UNITS; e.y /= SKETCH_UNITS }
    else if (e.kind === 'circle') { e.r /= SKETCH_UNITS }
  }
  return sketchPathData(scaled)
}

/** Bounding box of a `d` (already in whatever units it's in) over every
 *  subpath's points. `null` when the path flattens to nothing. */
export function localOutlineBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const subs = flattenPath(d)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const sub of subs) {
    for (const p of sub.pts) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Shift a sketch so its outline's bbox centre lands on the origin.
 *
 * `shiftLocal` is that centre BEFORE the shift, in LOCAL units — the amount the
 * drawing just moved by (it moved by `-shiftLocal`) — so a host can move its
 * placement by the equivalent screen amount and keep the outline where it was
 * (`placementAfterRecentre`). `null` when the sketch has no outline to centre.
 */
export function recentreSketch(sketch: SketchDoc): { sketch: SketchDoc; shiftLocal: { x: number; y: number }; bbox: { w: number; h: number } } | null {
  const b = localOutlineBounds(sketchToLocalD(sketch))
  if (!b) return null
  const shiftLocal = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  const bbox = { w: Math.max(b.maxX - b.minX, 0.001), h: Math.max(b.maxY - b.minY, 0.001) }
  const shifted = cloneDoc(sketch)
  const dx = shiftLocal.x * SKETCH_UNITS
  const dy = shiftLocal.y * SKETCH_UNITS
  for (const e of shifted.entities) {
    if (e.kind === 'point') { e.x -= dx; e.y -= dy }
  }
  return { sketch: shifted, shiftLocal, bbox }
}

// ── View matrices ────────────────────────────────────────────────────────────

/** A path layer's (or text layer's) placement dials — `LayerCommon` plus the
 *  path layer's `scale`, all optional except position. */
export interface LayerPlacement {
  x: number
  y: number
  rotation?: number
  skewX?: number
  skewY?: number
  scale?: number
}

/**
 * Drawing units → artboard px, matching the Frame's own path-layer draw
 * transform exactly (`applyXform`/`drawPath`), scaled once more by
 * `1/SKETCH_UNITS` so the input is DRAWING units rather than local units.
 */
export function layerView(p: LayerPlacement, W: number, H: number): ViewMatrix {
  const rotation = p.rotation ?? 0
  const skewX = p.skewX ?? 0
  const skewY = p.skewY ?? 0
  const scale = p.scale ?? 1
  return chain(
    translate(p.x * W, p.y * H),
    rotate(rotation),
    shear(skewX, skewY),
    scaleM((scale * W) / SKETCH_UNITS),
  )
}

/** The view a brand-new drawing session starts from: centred, unrotated, unscaled. */
export function newDrawingView(W: number, H: number): ViewMatrix {
  return layerView({ x: 0.5, y: 0.5, scale: 1 }, W, H)
}

/**
 * After `recentreSketch` shifts the drawing by `-shiftLocal`, the placement's
 * `x`/`y` that keeps the outline exactly where it was on screen — the screen
 * offset of `shiftLocal` through the placement's rotate/shear/scale (no
 * translation), converted back to the 0..1-of-W/H units `x`/`y` live in.
 */
export function placementAfterRecentre(
  p: LayerPlacement,
  shiftLocal: { x: number; y: number },
  W: number,
  H: number,
): { x: number; y: number } {
  const rotation = p.rotation ?? 0
  const skewX = p.skewX ?? 0
  const skewY = p.skewY ?? 0
  const scale = p.scale ?? 1
  const linear = chain(rotate(rotation), shear(skewX, skewY), scaleM(scale * W))
  const off = applyView(linear, shiftLocal)
  return { x: p.x + off.x / W, y: p.y + off.y / H }
}

/**
 * Drawing units → the pixel the TEXT layer's guide draws that point through —
 * built from `textPath.ts`'s `customGuideMapping`, the exact mapping
 * `guideFromPathD` uses, so a drawing point lands on the guide pixel for
 * pixel. `null` when the guide itself would be `null` (no usable outline).
 */
export function guideView(
  text: LayerPlacement,
  spec: { d: string; size?: number },
  W: number,
  H: number,
): ViewMatrix | null {
  const targetWidthPx = (spec.size ?? 0) > 0 ? (spec.size as number) * W : 0
  const m = customGuideMapping(spec.d, W, targetWidthPx)
  if (!m) return null
  const rotation = text.rotation ?? 0
  const skewX = text.skewX ?? 0
  const skewY = text.skewY ?? 0
  return chain(
    translate(text.x * W, text.y * H),
    rotate(rotation),
    shear(skewX, skewY),
    scaleM((W * m.k) / SKETCH_UNITS),
    translate(-m.mid.x * SKETCH_UNITS, -m.mid.y * SKETCH_UNITS),
  )
}
