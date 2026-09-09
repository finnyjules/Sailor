/**
 * Frame — TYPE ON A PATH: the guide engine and the glyph walk. PURE.
 *
 * Two exports do the whole job:
 *
 *  - `guideFromSpec(spec, W, naturalRunPx)` turns a stored `TextPathSpec` into a
 *    `Guide` — a thing that answers exactly one question, *where are you at
 *    distance `s` along your length, and which way are you pointing?*
 *  - `placeGlyphs(ctx, layer, guide, W)` walks a text run along any `Guide` and
 *    returns one `{ ch, x, y, angle, advance }` per drawn glyph.
 *
 * Placement never learns which KIND of curve it is walking, so a sixth follow
 * mode is a new guide source and nothing else.
 *
 * ## What this module is careful about
 *
 * **Arc length, not curve parameter.** The whole reason `lib/vectortype/curve.ts`
 * exists is that `distance ÷ length → t` is only correct on a constant-speed
 * curve. `utils/textOnPath.ts` (the old ComfyUI widget) does exactly that and is
 * visibly wrong on a wave. We go through `buildCurveTable` / `pointAtLength`,
 * which invert the cumulative-chord table properly. The spec test beside this
 * module runs the naive mapping side by side as a control.
 *
 * **Extrapolation.** `pointAtLength` CLAMPS past either end. Left alone, every
 * glyph that overflows an open guide piles up on the last point in a smeared
 * heap. A `Guide` extrapolates along the terminal tangent instead. A CLOSED
 * guide (a circle, or a `curve` bent all the way round) wraps modulo its length
 * rather than extrapolating.
 *
 * **Kerning.** Advances come from cumulative PREFIX widths —
 * `width(s.slice(0, i+1)) − width(s.slice(0, i))` — never from measuring each
 * character on its own. Isolated measurement throws away every kerning pair,
 * which is why cheap text-on-path looks loose. Prefixes also pick up
 * `ctx.letterSpacing` and the live variable-font axes for free.
 *
 * ## Units
 *
 * Frame stores geometry in LOCAL units where 1 unit = canvas width; drawing
 * happens in PIXELS via the `W` multiplier (`layer.fontSize * W`), exactly as
 * `drawText` does it. **Guides are built in pixel space**: `guideFromSpec`
 * multiplies every local-unit dial by `W` while constructing the curve, and
 * everything downstream — `Guide.length`, `Guide.at`, `Guide.bounds`, every
 * `PlacedGlyph` — is already in pixels.
 *
 * ## Origin
 *
 * `drawText` centres its block on the layer origin, so a guide does too: the
 * sampled geometry is translated so its bounding box is centred on (0, 0). That
 * makes `bounds()` an honest origin-centred box for `localLayerBox`, and it means
 * `follow: 'curve'` with `bend: 0` places the run exactly where flat centred text
 * would sit instead of a half-run to the right. Callers must NOT re-centre.
 *
 * PURE: no Vue, no DOM. The one browser object in sight is the
 * `CanvasRenderingContext2D` passed in for `measureText`, and it is only ever
 * measured through — never drawn to, never mutated.
 */
import {
  buildCurveTable,
  evalCurve,
  pointAtLength,
  type VtCurve,
  type VtCurveTable,
} from '~/lib/vectortype/curve'
import type { TextLayer } from '~/composables/useCompositorLayers'
import { longestSubpath, type FlatPoint } from '~/lib/compositor/pathFlatten'
import { shapeById } from '~/lib/shapes/catalog'
import { shapeGeometry } from '~/lib/shapes/pathLayer'
import { runToCommands, type VtFont } from '~/lib/compositor/textOutline'
import { transformCommands, type VectorCommand } from '~/lib/vector/svg'

const DEG = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

// ── The stored spec ─────────────────────────────────────────────────────────

export type TextPathFollow = 'curve' | 'circle' | 'wave' | 'shape' | 'custom'

export interface TextPathSpec {
  follow: TextPathFollow
  /** curve: -1..1 bend. 0 = flat, ±1 = closes into a full ring. Length-preserving. */
  bend?: number
  /** circle: ring radius, local units. */
  radius?: number
  /** circle: where the run starts, degrees clockwise from 12 o'clock. */
  startAngle?: number
  /** wave: amplitude in local units. */
  amplitude?: number
  /** wave: cycles across the run. */
  frequency?: number
  /** wave/curve: run length in local units. Absent ⇒ measured text width is used. */
  runLength?: number
  /** shape: library shape id. */
  shapeId?: string
  /** custom: SVG path `d`, local units, centered on its bbox midpoint. */
  d?: string
  /** shape/custom: target width in local units. */
  size?: number
  /** Slide the run along the path, 0..1 of path length. Default 0. */
  start?: number
  /** 'inside' reverses direction and flips each glyph a half turn. Default 'outside'. */
  side?: 'outside' | 'inside'
  /** Baseline shift perpendicular to the tangent, local units. Positive = outward
   *  (the direction the tangent's left normal points). Default 0. */
  shift?: number
  /** Squeeze/stretch tracking so the run fills the guide exactly. Default false. */
  fit?: boolean
}

/**
 * A text layer that may carry a path spec.
 *
 * `TextLayer` itself gains `path?: TextPathSpec` in the integration task; until
 * then this intersection lets the engine and its tests compile against the real
 * layer type without touching `useCompositorLayers.ts`. A plain `TextLayer` is
 * assignable to it, so the field arriving later changes nothing here.
 */
export type PathTextLayer = TextLayer & { path?: TextPathSpec }

// ── The guide ───────────────────────────────────────────────────────────────

export interface Guide {
  /** Total arc length, PIXELS. Always > 0 for a guide that was returned at all. */
  readonly length: number
  /** True when the path returns to its start — `s` wraps instead of extrapolating. */
  readonly closed: boolean
  /**
   * Point + tangent (radians, direction of travel) at arc length `s` pixels.
   *
   * OPEN guides extrapolate linearly along the terminal tangent for `s < 0` and
   * `s > length`, so an overflowing run keeps marching in a straight line rather
   * than piling up on the endpoint. CLOSED guides wrap `s` modulo `length`.
   */
  at(s: number): { x: number; y: number; angle: number }
  /** Pixel extent of the guide's own geometry, as a box centred on the origin.
   *  Never smaller than 1px on either axis (a straight guide has zero height). */
  bounds(): { w: number; h: number }
}

// ── Sanitising ──────────────────────────────────────────────────────────────

const fin = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** A dial that is PRESENT but not a finite number is a broken config, and a
 *  broken config must fall back to flat text rather than draw a NaN transform. */
const broken = (v: number | undefined): boolean => v !== undefined && !Number.isFinite(v)

// ── Building a guide ────────────────────────────────────────────────────────

/**
 * A `Guide` in pixel space, or `null` when the spec cannot make one — an unknown
 * or not-yet-implemented `follow`, a missing/zero required dial, a dial that is
 * present but NaN, or a curve that comes out with no length. Callers treat
 * `null` as "render flat", never as "draw nothing".
 *
 * `naturalRunPx` is the measured pixel width of the text run (see
 * `measureRunPx`), used for `curve`/`wave` when the spec carries no explicit
 * `runLength` — so a bend dial bows the text you actually have.
 */
export function guideFromSpec(
  spec: TextPathSpec | null | undefined,
  W: number,
  naturalRunPx: number,
): Guide | null {
  if (!spec) return null
  if (!Number.isFinite(W) || W <= 0) return null
  if (
    broken(spec.bend) || broken(spec.radius) || broken(spec.startAngle) ||
    broken(spec.amplitude) || broken(spec.frequency) || broken(spec.runLength) ||
    broken(spec.size) || broken(spec.start) || broken(spec.shift)
  ) return null

  // Explicit run length wins; otherwise the run bows the text that is there.
  const runPx = (): number => {
    const r = spec.runLength
    const px = r !== undefined && r > 0 ? r * W : naturalRunPx
    return Number.isFinite(px) && px > 0 ? px : 0
  }

  let curve: VtCurve
  let rotation = 0
  let closed = false

  switch (spec.follow) {
    case 'curve': {
      const L = runPx()
      if (!(L > 0)) return null
      const bend = fin(spec.bend, 0)
      // `line` is LENGTH-PRESERVING in curve.ts: the arc length stays `L` for
      // every curvature, so the bend dial bends the run without resizing it,
      // and `±1` closes it into a full ring.
      curve = { type: 'line', length: L, curvature: bend }
      closed = Math.abs(bend) >= 1
      break
    }
    case 'circle': {
      // A negative radius traverses the mirrored circle in curve.ts; a ring dial
      // means a size, so magnitude is the honest reading.
      const r = Math.abs(fin(spec.radius, 0)) * W
      if (!(r > 0)) return null
      curve = { type: 'circle', radius: r }
      closed = true
      // curve.ts's circle starts at 12 o'clock and runs clockwise, which is the
      // frame `startAngle` is quoted in — so it is a plain added rotation about
      // the origin rather than a fork of the sampler.
      rotation = fin(spec.startAngle, 0) * DEG
      break
    }
    case 'wave': {
      const L = runPx()
      if (!(L > 0)) return null
      curve = {
        type: 'wave',
        length: L,
        amplitude: fin(spec.amplitude, 0) * W,
        frequency: fin(spec.frequency, 0),
        phase: 0,
      }
      break
    }
    // Outline-backed guides: the shape library and a drawn path both arrive as
    // an SVG `d`, so they share one route — flatten, then wrap the polyline in
    // the same Guide contract the parametric curves satisfy.
    case 'shape': {
      const shape = spec.shapeId ? shapeById(spec.shapeId) : undefined
      if (!shape) return null
      const size = Math.abs(fin(spec.size, 0))
      if (!(size > 0)) return null
      // shapeGeometry works in the same local units the rest of the spec uses,
      // and returns a `d` already centred on its own bbox midpoint.
      return guideFromPathD(shapeGeometry(shape, size).d, W)
    }
    case 'custom': {
      if (!spec.d) return null
      const size = Math.abs(fin(spec.size, 0))
      // A drawn path carries its own scale; `size`, when set, refits it.
      return guideFromPathD(spec.d, W, size > 0 ? size * W : 0)
    }
    default:
      return null
  }

  const table = buildCurveTable(curve)
  if (!Number.isFinite(table.length) || !(table.length > 0)) return null
  return guideFromTable(table, rotation, closed)
}

/**
 * Wrap a prebuilt curve table as a `Guide`: rotate, centre on the origin, and
 * extend the ends.
 *
 * Exported so the outline guide (shape/custom) can reuse the identical
 * extrapolation and centring once it can produce a table of its own.
 */
export function guideFromTable(table: VtCurveTable, rotation = 0, closed = false): Guide {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  // One pass over the table's own sample count: it is already tuned to how much
  // the curve turns, so it is the right resolution for the extent too.
  const n = table.samples
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i <= n; i++) {
    const p = evalCurve(table.curve, i / n)
    const x = p.x * cos - p.y * sin
    const y = p.x * sin + p.y * cos
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) { minX = maxX = minY = maxY = 0 }
  const ox = -(minX + maxX) / 2
  const oy = -(minY + maxY) / 2
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)

  const L = table.length

  /** Rotated + centred sample, `s` clamped exactly the way curve.ts clamps it. */
  const raw = (s: number) => {
    const p = pointAtLength(table, s)
    return {
      x: p.x * cos - p.y * sin + ox,
      y: p.x * sin + p.y * cos + oy,
      angle: p.angle + rotation,
    }
  }

  return {
    length: L,
    closed,
    at(s: number) {
      const sc = fin(s, 0)
      if (closed) {
        // `((s % L) + L) % L` and not `s % L`: the latter is negative for
        // negative `s` in JS, which would put a leading glyph off the ring.
        return raw(((sc % L) + L) % L)
      }
      if (sc < 0) {
        const p = raw(0)
        // `sc` is negative, so adding it along the tangent steps BACKWARDS.
        return { x: p.x + Math.cos(p.angle) * sc, y: p.y + Math.sin(p.angle) * sc, angle: p.angle }
      }
      if (sc > L) {
        const p = raw(L)
        const d = sc - L
        return { x: p.x + Math.cos(p.angle) * d, y: p.y + Math.sin(p.angle) * d, angle: p.angle }
      }
      return raw(sc)
    },
    bounds: () => ({ w, h }),
  }
}

/**
 * A guide from an SVG path `d` in LOCAL units — the shape library and the pen
 * both speak this.
 *
 * Only the LONGEST subpath is used. A library shape may carry interior detail
 * (a face inside a circle, spokes inside a sun); type follows its outline, which
 * is the subpath a reader would trace with a finger, and running the glyphs onto
 * an interior fragment would look like a bug.
 *
 * `targetWidthPx > 0` refits the outline to that width, preserving aspect.
 */
export function guideFromPathD(d: string, W: number, targetWidthPx = 0): Guide | null {
  const sub = longestSubpath(d)
  if (!sub || sub.pts.length < 2) return null
  const k = Number.isFinite(W) && W > 0 ? W : 1
  let pts = sub.pts.map(p => ({ x: p.x * k, y: p.y * k }))
  if (targetWidthPx > 0) {
    let lo = Infinity, hi = -Infinity
    for (const p of pts) { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x }
    const w = hi - lo
    if (w > 0) {
      const f = targetWidthPx / w
      pts = pts.map(p => ({ x: p.x * f, y: p.y * f }))
    }
  }
  return guideFromPolyline(pts, sub.closed)
}

/**
 * Put a closed outline into the orientation type expects: running clockwise on
 * screen, starting at its topmost point.
 *
 * Where a closed path "starts", and which way it winds, are artefacts of how the
 * shape was authored — one library shape begins at its left edge, the next at a
 * petal tip, and an imported outline may be wound either way. Left alone, the
 * same dial settings put type up the side of one shape and upside down around
 * another, which reads as a bug rather than as a property of the artwork.
 *
 * Normalising here means a closed outline behaves exactly like the parametric
 * circle: `start: 0.5` with centred alignment sits the run over the top, upright,
 * for every shape in the library.
 *
 * Open paths are left alone — a drawn curve's direction and start are the
 * author's intent, not an artefact.
 */
function normaliseClosedOutline(pts: FlatPoint[]): FlatPoint[] {
  const n = pts.length
  if (n < 3) return pts
  const topIndex = (list: FlatPoint[]): number => {
    let ti = 0
    for (let i = 1; i < list.length; i++) {
      // A flat top has several topmost vertices; take the LEFTMOST. Travel is
      // clockwise, so that is where the top edge begins — starting at its right
      // end would send `s` straight down the side instead of along the top.
      const a = list[i]!, b = list[ti]!
      if (a.y < b.y || (a.y === b.y && a.x < b.x)) ti = i
    }
    return ti
  }
  let ti = topIndex(pts)
  // Test the property directly rather than reasoning about shoelace signs in a
  // y-down space: at the top of the outline, travel must head RIGHT.
  const prev = pts[(ti - 1 + n) % n]!
  const next = pts[(ti + 1) % n]!
  if (next.x - prev.x < 0) {
    pts = [...pts].reverse()
    ti = topIndex(pts)
  }
  return ti === 0 ? pts : [...pts.slice(ti), ...pts.slice(0, ti)]
}

/**
 * Wrap a polyline as a `Guide`, matching `guideFromTable` exactly: centred on
 * the origin, extrapolating off the ends when open and wrapping when closed.
 *
 * A closed subpath's final chord back to the first point is IMPLIED by
 * `pathFlatten` rather than repeated, so it is added here — without it a ring
 * would be short by one segment and every glyph past the gap would sit wrong.
 */
export function guideFromPolyline(input: readonly FlatPoint[], closed: boolean): Guide | null {
  const src = input.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (src.length < 2) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of src) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const ox = -(minX + maxX) / 2
  const oy = -(minY + maxY) / 2
  let pts: FlatPoint[] = src.map(p => ({ x: p.x + ox, y: p.y + oy }))
  if (closed) {
    pts = normaliseClosedOutline(pts)
    pts.push({ x: pts[0]!.x, y: pts[0]!.y })   // the implied closing chord
  }

  const n = pts.length
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  }
  const L = cum[n - 1]!
  if (!Number.isFinite(L) || !(L > 0)) return null

  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)

  /** Point + tangent at arc length `s`, `s` clamped to the polyline's own ends. */
  const raw = (s: number) => {
    const sc = s <= 0 ? 0 : s >= L ? L : s
    // Binary search the cumulative table — monotone by construction, exactly as
    // curve.ts's own inversion relies on.
    let lo = 0, hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! <= sc) lo = mid
      else hi = mid
    }
    const a = pts[lo]!, b = pts[hi]!
    const span = cum[hi]! - cum[lo]!
    const f = span > 0 ? (sc - cum[lo]!) / span : 0
    const dx = b.x - a.x, dy = b.y - a.y
    return {
      x: a.x + dx * f,
      y: a.y + dy * f,
      // A zero-length segment cannot give a direction; the previous segment's is
      // the only defined answer, and 0 is the fallback at the very start.
      angle: dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx),
    }
  }

  return {
    length: L,
    closed,
    at(s: number) {
      const sc = fin(s, 0)
      if (closed) return raw(((sc % L) + L) % L)
      if (sc < 0) {
        const p = raw(0)
        return { x: p.x + Math.cos(p.angle) * sc, y: p.y + Math.sin(p.angle) * sc, angle: p.angle }
      }
      if (sc > L) {
        const p = raw(L)
        const dd = sc - L
        return { x: p.x + Math.cos(p.angle) * dd, y: p.y + Math.sin(p.angle) * dd, angle: p.angle }
      }
      return raw(sc)
    },
    bounds: () => ({ w, h }),
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

/** `transformCase` from `useCompositorLayers.ts`, which is module-private there.
 *  Kept identical on purpose: path text and flat text must display the same
 *  glyphs, or turning path mode on silently re-cases the layer. */
function transformCase(s: string, t: TextLayer['textTransform']): string {
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  if (t === 'capitalize') return s.replace(/\b\p{L}/gu, c => c.toUpperCase())
  return s
}

/**
 * The single line a path lays out: the layer's case transform applied, then
 * every newline and every run of whitespace collapsed to one space.
 *
 * Path mode has no multi-line concept (the spec hides wrapping, box W/H and
 * V-align while it is on), so newlines become spaces rather than being dropped —
 * dropping them would weld the words either side together.
 */
export function displayRun(layer: Pick<TextLayer, 'text' | 'textTransform'>): string {
  return transformCase(layer.text ?? '', layer.textTransform).replace(/\s+/gu, ' ')
}

/**
 * Natural pixel width of the run — what to hand `guideFromSpec` as
 * `naturalRunPx`.
 *
 * PRECONDITION, as for `placeGlyphs`: the caller has already run
 * `applyFont(ctx, layer, W)`.
 */
export function measureRunPx(
  ctx: CanvasRenderingContext2D,
  layer: Pick<TextLayer, 'text' | 'textTransform'>,
): number {
  const run = displayRun(layer)
  if (!run) return 0
  return Math.max(0, fin(ctx.measureText(run).width, 0))
}

// ── Placement ───────────────────────────────────────────────────────────────

export interface PlacedGlyph {
  ch: string
  /** Glyph CENTRE, pixels, in the layer's local (origin-centred) frame. */
  x: number
  y: number
  /** Rotation to draw at, radians. */
  angle: number
  /** How far the cursor moved for this glyph, pixels (post-fit). */
  advance: number
}

/**
 * Walk `layer`'s text along `guide` and return one placement per drawn glyph, in
 * draw order.
 *
 * **PRECONDITION: the caller has already run `applyFont(ctx, layer, W)`.** This
 * function never touches `ctx.font`, `ctx.letterSpacing` or
 * `ctx.fontVariationSettings` — it only measures. That is deliberate: measuring
 * under the same state the glyphs will be drawn under is what makes the advances
 * true, and it keeps this module out of the business of font loading.
 *
 * `W` is the pixel-per-local-unit multiplier; it is needed here only to convert
 * `spec.shift`. `spec` defaults to `layer.path`, so once `TextLayer` carries the
 * field the four-argument call in the design spec is the one to use.
 *
 * Spaces still ADVANCE the cursor but are not returned — there is nothing to
 * `fillText` for them, and skipping them saves a transform per space.
 */
export function placeGlyphs(
  ctx: CanvasRenderingContext2D,
  layer: PathTextLayer,
  guide: Guide | null | undefined,
  W: number,
  spec: TextPathSpec | null | undefined = layer?.path,
): PlacedGlyph[] {
  if (!ctx || !guide) return []
  const L = guide.length
  if (!Number.isFinite(L) || !(L > 0)) return []

  const chars = Array.from(displayRun(layer))   // Array.from keeps surrogate pairs whole
  const n = chars.length
  if (!n) return []

  // Cumulative prefixes. `measureText` is called on growing prefixes and never
  // on a lone character, so kerning pairs and `ctx.letterSpacing` both survive.
  const advances = new Array<number>(n)
  let prefix = ''
  let prevW = 0
  let run = 0
  for (let i = 0; i < n; i++) {
    prefix += chars[i]
    const w = fin(ctx.measureText(prefix).width, prevW)
    // A negative kern past the previous glyph's origin would run the cursor
    // backwards and break the monotone walk; clamp rather than reorder.
    const a = Math.max(0, w - prevW)
    advances[i] = a
    run += a
    prevW = w
  }

  // Fit: ADD one uniform delta to every gap (matching how `letterSpacing`
  // already works — tracking, not a scale), so the run ends exactly on the
  // guide. The last glyph's advance is untouched: it is the trailing edge.
  if (spec?.fit && n >= 2) {
    const delta = (L - run) / (n - 1)
    if (Number.isFinite(delta)) {
      for (let i = 0; i < n - 1; i++) advances[i]! += delta
      run = L
    }
  }

  // Align maps onto the path: left/justify → start, centre → middle, right → end.
  // ('justify' has no meaning without a box, and path mode hides the box.)
  const base =
    layer.align === 'center' ? (L - run) / 2 :
    layer.align === 'right' ? L - run : 0
  const startPos = base + fin(spec?.start, 0) * L

  const inside = spec?.side === 'inside'
  const shiftPx = fin(spec?.shift, 0) * fin(W, 0)

  const out: PlacedGlyph[] = []
  let cursor = startPos
  for (let i = 0; i < n; i++) {
    const adv = advances[i]!
    const mid = cursor + adv / 2       // centre the glyph on its own half-advance
    cursor += adv
    const ch = chars[i]!
    if (ch === ' ') continue           // advances, draws nothing

    // 'inside' walks the guide backwards and turns each glyph a half turn, which
    // is what makes type read the right way up along the bottom of a ring.
    const p = guide.at(inside ? L - mid : mid)
    const angle = p.angle + (inside ? Math.PI : 0)
    let x = p.x
    let y = p.y
    if (shiftPx !== 0) {
      // LEFT normal of the PLACED angle (i.e. after the inside flip), so a
      // positive shift always lifts type off its baseline the same way it reads.
      // On an outside run clockwise round a circle, that is outward.
      const nrm = angle - Math.PI / 2
      x += Math.cos(nrm) * shiftPx
      y += Math.sin(nrm) * shiftPx
    }
    // Last line of defence: a NaN in a transform matrix silently blanks the whole
    // canvas, so a glyph that cannot be placed is dropped instead of drawn.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle) || !Number.isFinite(adv)) continue
    out.push({ ch, x, y, angle, advance: adv })
  }
  return out
}

// ── On-path glyph OUTLINES (Frame slice F1, Task 4) ──────────────────────────

/**
 * One placed glyph's OUTLINE commands, in the layer's local px, landing on the
 * very pixels `drawTextOnPath` inks for that glyph.
 *
 * `drawTextOnPath` draws each glyph in its own turned frame: `textAlign 'center'`,
 * `textBaseline 'middle'`, `translate(g.x, g.y)`, `rotate(g.angle)`, then
 * `fillText(g.ch, 0, 0)`. So the outline is built the same way, in two steps that
 * mirror that exactly:
 *
 *  1. shape THIS character alone, centred on the origin with a middle baseline —
 *     `runToCommands` with `align:'center', baseline:'middle'` is the identical
 *     placement math the flat sink uses, so a glyph and its flat twin share one
 *     outline choke point (this is also why a STRAIGHT guide, `angle 0`, yields
 *     commands equal to the flat centred placement of the same glyph);
 *  2. turn it to the tangent (`g.angle`) and slide it to `(g.x, g.y)` — the same
 *     `rotate` then `translate` the canvas applies. `runToCommands` has already
 *     flipped font space into px, so this pass is `scale 1`, `flipY false`.
 *
 * Per-CHARACTER shaping (not the run's ligature shaping) is deliberate: the path
 * renderer draws each `g.ch` independently, so matching its pixels means shaping
 * each character independently too — the kerned ADVANCES that space the glyphs are
 * already carried in `g.x` by `placeGlyphs`.
 */
export function glyphOutlineCommands(
  font: VtFont,
  glyph: PlacedGlyph,
  fontPx: number,
  axes?: Record<string, number>,
): VectorCommand[] {
  const centred = runToCommands(font, { text: glyph.ch, x: 0, y: 0 }, {
    fontPx, letterSpacingPx: 0, align: 'center', baseline: 'middle',
  }, axes)
  if (!centred.length) return []
  return transformCommands(centred, {
    scale: 1,
    flipY: false,                 // runToCommands already produced flipped px
    rotate: glyph.angle * RAD_TO_DEG,
    x: glyph.x,
    y: glyph.y,
  })
}

/**
 * Every placed glyph's outline commands, in draw order, concatenated into one
 * list ready for `commandsToPathData`. Pure and deterministic. Returns `[]` for
 * an empty placement.
 */
export function placedGlyphsToCommands(
  font: VtFont,
  placed: readonly PlacedGlyph[],
  fontPx: number,
  axes?: Record<string, number>,
): VectorCommand[] {
  const out: VectorCommand[] = []
  for (const g of placed) {
    const cmds = glyphOutlineCommands(font, g, fontPx, axes)
    for (const c of cmds) out.push(c)
  }
  return out
}
