/**
 * The vector export spine — Sailor's one SVG writer.
 *
 * Deliberately knows NOTHING about type, fonts or any studio. Its input is a
 * list of shapes whose commands are already in document space; its output is an
 * SVG string. Vector Type is the first consumer (glyph outlines); Shape Studio
 * is the intended second (flat-shaded facets project to coloured polygons,
 * which is exactly a list of filled paths). Anything that can produce
 * `VectorCommand[]` can export vector without writing another serialiser.
 *
 * Everything here is pure: no DOM, no canvas, no fetch — including the one place
 * that emits a raster (`VectorPattern.image`), which takes a data URL the CALLER
 * encoded rather than reaching for a canvas to encode one itself.
 *
 * `commandsToPathData` is shared with the canvas renderer so the two outputs
 * cannot drift — the SVG `d` and the Path2D replay are built from the same
 * transformed command list.
 */

/** The five path commands fontkit emits, and the only ones we serialise. */
export type VectorCommandName =
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'bezierCurveTo'
  | 'closePath'

/**
 * One path command. `args` is flat and its length is fixed by the command:
 * moveTo/lineTo 2, quadraticCurveTo 4, bezierCurveTo 6, closePath 0.
 */
export interface VectorCommand {
  command: VectorCommandName
  args: number[]
}

/** How many numbers each command carries. Also the set of legal commands. */
export const COMMAND_ARITY: Record<VectorCommandName, number> = {
  moveTo: 2,
  lineTo: 2,
  quadraticCurveTo: 4,
  bezierCurveTo: 6,
  closePath: 0,
}

export function isVectorCommandName(v: unknown): v is VectorCommandName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_ARITY, v)
}

/**
 * A scale-rotate-translate placement, with an optional y flip.
 *
 * The flip is the whole reason this exists: font space (and any right-handed
 * projection) is y-up with the baseline at 0, while canvas and SVG are y-down.
 * Baking the flip into the coordinates — rather than leaving it to a
 * `ctx.scale(1, -1)` at the call site — means stroke widths, dash patterns and
 * per-glyph transforms all stay in output units, and the SVG needs no wrapper
 * transform to match what the canvas drew.
 *
 * `rotate` is baked the same way and for the same reason. It exists because a
 * glyph placed on a CURVE has to turn to the tangent, and turning it here — in
 * the coordinates, at the one placement choke point — is what keeps the canvas
 * path and the exported `d` the same geometry by construction rather than by two
 * writers agreeing. It is a similarity transform, so it stays exactly-correct
 * vector: no approximation enters the export.
 */
export interface Transform2D {
  /** Uniform scale from source units to output units. Default 1. */
  scale?: number
  /**
   * DEGREES, applied AFTER the scale and the flip and BEFORE the translate, so
   * it turns about the SOURCE origin.
   *
   * Positive turns clockwise ON SCREEN, because the space it acts in is already
   * y-down (the flip has been applied by then) — the same direction and the same
   * sign as `ctx.rotate` and SVG's `rotate(deg)`. Default 0, and 0 is exactly
   * inert: the multiply-free branch below is byte-identical to what this
   * function returned before rotation existed.
   */
  rotate?: number
  /** Translation in OUTPUT units, applied after the scale and the rotation. Default 0. */
  x?: number
  y?: number
  /** Negate y, turning y-up source space into y-down output space. Default true. */
  flipY?: boolean
}

const DEG_TO_RAD = Math.PI / 180

/**
 * Apply a `Transform2D` to a command list, returning new plain objects.
 *
 * Always copies. fontkit caches glyph paths internally, so handing a caller a
 * reference into `glyph.path.commands` would let one mutation corrupt every
 * later read of that glyph.
 */
export function transformCommands(commands: readonly VectorCommand[], t: Transform2D = {}): VectorCommand[] {
  const s = Number.isFinite(t.scale as number) ? (t.scale as number) : 1
  const dx = Number.isFinite(t.x as number) ? (t.x as number) : 0
  const dy = Number.isFinite(t.y as number) ? (t.y as number) : 0
  const sy = t.flipY === false ? s : -s
  const rot = Number.isFinite(t.rotate as number) ? (t.rotate as number) : 0
  // Branch rather than fold `cos 0 = 1` / `sin 0 = 0` into the general form. The
  // arithmetic would agree exactly, but every flat run in the product takes this
  // path every frame and there is no reason to pay four multiplies per point for
  // a rotation nobody asked for.
  const rad = rot * DEG_TO_RAD
  const cos = rot === 0 ? 1 : Math.cos(rad)
  const sin = rot === 0 ? 0 : Math.sin(rad)

  const out: VectorCommand[] = []
  for (const c of commands) {
    if (!c || !isVectorCommandName(c.command)) continue
    const args = c.args ?? []
    const mapped: number[] = new Array(args.length)
    if (rot === 0) {
      for (let i = 0; i < args.length; i++) {
        // args alternate x, y, x, y … for every command shape we accept.
        mapped[i] = i % 2 === 0 ? dx + (args[i] as number) * s : dy + (args[i] as number) * sy
      }
    } else {
      // The pair has to be read together, so this steps by two rather than
      // mapping each coordinate independently.
      for (let i = 0; i + 1 < args.length; i += 2) {
        const px = (args[i] as number) * s
        const py = (args[i + 1] as number) * sy
        mapped[i] = dx + px * cos - py * sin
        mapped[i + 1] = dy + px * sin + py * cos
      }
    }
    out.push({ command: c.command, args: mapped })
  }
  return out
}

/** Format a number for SVG: fixed precision, trailing zeros stripped, no `-0`. */
export function formatNumber(v: number, precision = 3): string {
  if (!Number.isFinite(v)) return '0'
  let s = v.toFixed(Math.max(0, Math.min(10, precision)))
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' || s === '' ? '0' : s
}

/** Commands → an SVG path `d`. Coordinates are used as given (document space). */
export function commandsToPathData(commands: readonly VectorCommand[], precision = 3): string {
  const parts: string[] = []
  for (const c of commands) {
    if (!c || !isVectorCommandName(c.command)) continue
    const a = c.args ?? []
    const n = (i: number) => formatNumber(a[i] as number, precision)
    switch (c.command) {
      case 'moveTo': parts.push(`M${n(0)} ${n(1)}`); break
      case 'lineTo': parts.push(`L${n(0)} ${n(1)}`); break
      case 'quadraticCurveTo': parts.push(`Q${n(0)} ${n(1)} ${n(2)} ${n(3)}`); break
      case 'bezierCurveTo': parts.push(`C${n(0)} ${n(1)} ${n(2)} ${n(3)} ${n(4)} ${n(5)}`); break
      case 'closePath': parts.push('Z'); break
    }
  }
  return parts.join('')
}

/**
 * Bounds of a command list's CONTROL POINTS.
 *
 * Exact for polygons (Shape Studio's projected facets) and a slight
 * over-estimate wherever a curve's control points sit outside its hull — good
 * enough to size a viewBox, not a substitute for a true outline bbox. Vector
 * Type does not use this: fontkit hands it exact per-glyph bounds already.
 */
export function controlPointBounds(
  commands: readonly VectorCommand[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of commands) {
    const a = c?.args ?? []
    for (let i = 0; i + 1 < a.length; i += 2) {
      const x = a[i] as number
      const y = a[i + 1] as number
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}

/** An axis-aligned window in DOCUMENT space, the same units as the commands. */
export interface VectorRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A reveal window: a rect, optionally TURNED about a point.
 *
 * The rotation exists because a shape can be PLACED at an angle while its
 * window still belongs to the shape's own frame. An axis-aligned window over a
 * turned shape cuts it along an axis that means nothing to it — the wipe stops
 * being a wipe and becomes a diagonal slice — and no amount of padding fixes
 * it, because the error grows with the angle rather than with the size.
 *
 * `rotate: 0` (or absent) is the plain axis-aligned window, and it writes
 * BYTE-IDENTICAL markup to what a bare `VectorRect` wrote before this field
 * existed: the rotation is emitted as a `transform` on the `<rect>` and an
 * untouched window emits no transform at all.
 *
 * Note the rect's own `x`/`y`/`width`/`height` stay in DOCUMENT units and are
 * the window's extent BEFORE the turn — i.e. the numbers a caller already had.
 * That keeps the two surfaces on one derivation: a canvas turns its context and
 * takes the identical rect, an SVG turns the identical rect inside the
 * `<clipPath>`.
 */
export interface VectorWindow extends VectorRect {
  /**
   * DEGREES, clockwise on screen — the same sign and the same y-down space as
   * `Transform2D.rotate`, `ctx.rotate` and SVG's `rotate(deg)`. Default 0.
   */
  rotate?: number
  /**
   * The point the rotation turns about, in the same document units. Both must
   * be finite for either to be used; otherwise the rect's own CENTRE is the
   * pivot, which is the only pivot a bare rectangle can imply.
   */
  pivotX?: number
  pivotY?: number
}

/** The window's pivot, resolved — the caller's point, or the rect's centre. */
function windowPivot(r: VectorWindow): { x: number; y: number } {
  const px = r.pivotX as number
  const py = r.pivotY as number
  return Number.isFinite(px) && Number.isFinite(py)
    ? { x: px, y: py }
    : { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/** The window's rotation in degrees, with a non-finite value read as none. */
function windowRotate(r: VectorWindow): number {
  const v = r.rotate as number
  return Number.isFinite(v) ? v : 0
}

// ── Affine helpers ──────────────────────────────────────────────────────────
//
// `[a, b, c, d, e, f]`, exactly SVG's `matrix(…)` and the same order as
// `DOMMatrix`'s 2D components — so a caller can hand one straight to either
// without a re-ordering step nobody would notice was wrong.

export type Affine = readonly [number, number, number, number, number, number]

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0]

/** `m · n` — apply `n` first, then `m`, matching SVG's left-to-right transform
 *  list and successive `ctx` operations. */
export function multiplyAffine(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** The inverse, or `null` where there is none (a singular or non-finite matrix —
 *  a zero scale, which a motion preset can legitimately produce mid-flip). */
export function invertAffine(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!Number.isFinite(det) || det === 0) return null
  // `+ 0` collapses the negative zero the negations produce. It formats as "0"
  // either way, but a `-0` surviving into a comparison is a trap nobody enjoys.
  const z = (v: number) => v + 0
  const out: Affine = [
    z(m[3] / det),
    z(-m[1] / det),
    z(-m[2] / det),
    z(m[0] / det),
    z((m[2] * m[5] - m[3] * m[4]) / det),
    z((m[1] * m[4] - m[0] * m[5]) / det),
  ]
  return out.every(Number.isFinite) ? out : null
}

/**
 * A linear gradient's axis for `angle` degrees, in UNIT-BOX coordinates
 * (`0,0` = the box's top-left corner, `1,1` its bottom-right).
 *
 * THE one definition of what an angle means for a gradient in this product, and
 * it lives in the spine because the spine is what must not drift from the
 * screen. `fillTileBox` (the `Fill` gradient tile) and `resolvePaint` (the
 * `Gradient` arm of the canvas resolver) both call it, so a canvas gradient and
 * the `<linearGradient>` exported for it are the same geometry by construction
 * rather than by two people doing the same trig twice.
 *
 * `0°` runs left→right and `+90°` runs top→bottom, because y is DOWN in every
 * space this reaches (canvas, SVG, and command lists that have already been
 * flipped by `transformCommands`).
 *
 * The x and y half-extents are scaled INDEPENDENTLY by the box — so on a
 * non-square box the axis is not at `angle` to the horizon, it is at `angle` in
 * the box's own unit square. That is exactly what `gradientUnits =
 * "objectBoundingBox"` does with the same numbers, and exactly what the canvas
 * does with `cos(a)·W/2` / `sin(a)·H/2`. Matching the screen matters more than
 * matching a protractor, and the two conventions cannot both be had.
 */
export function gradientUnitAxis(angleDeg: number): { x1: number; y1: number; x2: number; y2: number } {
  const rad = ((Number.isFinite(angleDeg) ? angleDeg : 0) * Math.PI) / 180
  const hx = Math.cos(rad) / 2
  const hy = Math.sin(rad) / 2
  return { x1: 0.5 - hx, y1: 0.5 - hy, x2: 0.5 + hx, y2: 0.5 + hy }
}

/** One stop in a gradient paint server. `offset` is 0..1. */
export interface VectorGradientStop {
  offset: number
  color: string
  /** 0..1. Omitted means fully opaque; emitted as `stop-opacity`. */
  opacity?: number
}

/**
 * Stops in ascending order with every offset clamped to 0..1 (a non-finite one
 * sinks to 0), as new objects.
 *
 * SVG requires each offset to be >= the previous and silently pins the ones
 * that are not, so an unsorted list renders as a completely different ramp on
 * the two surfaces. Canvas `addColorStop` has no such rule, which is exactly
 * why this cannot be left to the caller.
 *
 * Generic and exported because it IS the rule `~/lib/compositor/paint`'s
 * `sortedClampedStops` states — that function now delegates here rather than
 * keeping a second copy of it, which also keeps `shaderfill/descriptor`'s
 * `inputKey` encoding stops in the order they are actually painted in.
 */
export function orderGradientStops<T extends { offset: number }>(stops: readonly T[] | undefined): T[] {
  return [...(stops ?? [])]
    .map(s => ({ ...s, offset: Number.isFinite(s.offset) ? Math.max(0, Math.min(1, s.offset)) : 0 }))
    .sort((a, b) => a.offset - b.offset)
}

/**
 * A gradient paint server — a `<linearGradient>` or `<radialGradient>` in
 * `<defs>`, referenced by every shape that shares its value.
 *
 * Studio-agnostic on purpose: it says WHERE a gradient is anchored and WHAT it
 * ramps through, and nothing about what is being painted. Translating a
 * studio's own fill model into this is the adapter's job (`lib/paint/toVector`
 * does it for `Paint`).
 */
export interface VectorGradient {
  type: 'linear' | 'radial'
  stops: VectorGradientStop[]
  /** Degrees, `linear` only — see `gradientUnitAxis`. Default 0. */
  angle?: number
  /**
   * `objectBoundingBox` (the default) anchors the gradient to each referencing
   * shape's OWN bounds, so every shape carries its own copy of the ramp and it
   * rides whatever `transform` that shape has.
   *
   * `userSpaceOnUse` anchors it to `box`, in document units, so one ramp spans
   * many shapes. Note that the coordinates are then resolved in the user space
   * of the PAINTED element — a `<path>` with a `transform` drags the paint
   * server along with it, and `fill` being an inherited property means putting
   * the reference on an untransformed wrapper `<g>` does NOT change that (the
   * trick that works for `clip-path` and `filter`, which are applied to the
   * wrapper itself, does not transfer). `transform` below is what pins it.
   */
  units?: 'objectBoundingBox' | 'userSpaceOnUse'
  /** Required by `userSpaceOnUse`: the box the ramp spans, in document units. */
  box?: VectorRect
  /**
   * The referencing shape's box aspect (`width / height`), for
   * `objectBoundingBox` only. Default 1.
   *
   * NOT cosmetic. SVG maps the unit square onto the bounding box with a
   * NON-UNIFORM scale, and that changes what the gradient means on any shape
   * that is not square:
   *
   *  - a `linear`'s bands stay perpendicular to its axis in the UNIT square, so
   *    after the stretch they are no longer perpendicular in user space, while
   *    a canvas gradient's always are. Measured on a 6-letter word at 35°:
   *    46.3 % of core ink pixels differed from the canvas by more than 32/255
   *    (worst 255) without this, and 0.0000 % with it. At 0° and 90° the axis
   *    is an eigenvector of the stretch and the two agree either way — which is
   *    exactly why an axis-aligned test would have "passed" and shipped it.
   *  - a `radial` becomes an ELLIPSE, where the canvas draws a circle of radius
   *    `max(w, h) / 2`.
   *
   * Both corrections are derived here rather than by the caller, because both
   * are facts about SVG's coordinate system, not about anyone's fill model.
   */
  aspect?: number
  /**
   * Emitted as `gradientTransform` — the INVERSE of the referencing element's
   * own transform, which cancels it and leaves a `userSpaceOnUse` ramp pinned
   * in document space (verified in Chrome: byte-identical pixels to the same
   * shape drawn untransformed at the same place).
   *
   * `objectBoundingBox` ignores it: there the `gradientTransform` slot is spent
   * on the `aspect` correction above, and a bounding-box-anchored ramp is
   * MEANT to ride its shape's transform.
   */
  transform?: Affine
}

/** One filled rectangle inside a pattern tile, in the TILE's own coordinates
 *  (origin at the tile's corner). Rectangles are the whole vocabulary on
 *  purpose: every procedural fill this spine has to express — a grid's rules, a
 *  checker's squares, a stripe band, a QR cell — is one, and a tile of rects is
 *  geometry any editor can select, recolour and delete. */
export interface VectorPatternRect {
  x: number
  y: number
  width: number
  height: number
  fill: string
}

/**
 * A tiling paint server — a `<pattern>` in `<defs>`, referenced by every shape
 * that shares its value.
 *
 * Always `patternUnits="userSpaceOnUse"`, and the tile always sits at the
 * pattern space's origin: WHERE the lattice starts is expressed entirely by
 * `transform`. A pattern's phase is part of what it looks like — two otherwise
 * identical checkerboards half a cell apart are different pictures — so the
 * placement cannot be left implicit the way a bounding-box gradient's can, and
 * `objectBoundingBox` (which would size the tile as a FRACTION of each
 * referencing shape) cannot say "square cells of edge `c`" at all.
 *
 * The coordinates are resolved in the user space of the element actually
 * PAINTED, exactly as a `userSpaceOnUse` gradient's are — so a `<path>` with a
 * `transform` drags the pattern along with it, and putting the reference on an
 * untransformed wrapper `<g>` does NOT change that (`fill` is inherited). A
 * caller that wants the tiling pinned in document space while the shape moves
 * over it composes the INVERSE of that shape's own transform into `transform`;
 * a caller that wants the pattern to RIDE the shape leaves it out. See
 * `VectorGradient.transform`, which is the same fact measured.
 */
export interface VectorPattern {
  type: 'pattern'
  /** Tile size in pattern space, before `transform`. */
  width: number
  height: number
  /** Painted full-bleed behind `rects`. Omitted/null → a transparent tile. */
  background?: string | null
  rects: VectorPatternRect[]
  /**
   * A PRE-ENCODED raster, stretched over the whole tile as an `<image>` — the
   * honest bottom tier, for a fill that has no geometric description to recover
   * at all (a per-pixel dither, a fragment program). It is a real, working
   * export; it is simply not editable vector, which is a fact the product has to
   * declare rather than hide.
   *
   * A SELF-CONTAINED `data:` URL, or the file stops working the moment it leaves
   * the machine that made it. **This spine never builds one.** It has no DOM, no
   * canvas and no encoder by design (see the module header) — that purity is
   * what lets a worker, a test or SSR call it, and what makes it reusable by a
   * second studio. A caller that has pixels encodes them itself and hands the
   * finished string in; `lib/vectortype/canvas` is the first to do so.
   *
   * Emitted with `preserveAspectRatio="none"` and the tile's own width/height, so
   * it lands exactly on the tile however its pixel dimensions were rounded.
   * Drawn OVER `background` and UNDER `rects`, though in practice a raster tile
   * carries neither.
   */
  image?: string | null
  /** Emitted as `patternTransform`: pattern space → the referencing element's
   *  user space. Omitted when it would be the identity. */
  transform?: Affine
}

export type VectorPaint = string | VectorGradient | VectorPattern

export function isVectorGradient(p: VectorPaint | null | undefined): p is VectorGradient {
  return !!p && typeof p === 'object' && (p.type === 'linear' || p.type === 'radial')
}

export function isVectorPattern(p: VectorPaint | null | undefined): p is VectorPattern {
  return !!p && typeof p === 'object' && p.type === 'pattern'
}

/**
 * Canvas/CSS `blur(Npx)` → `feGaussianBlur`'s `stdDeviation`.
 *
 * They are the SAME quantity and the conversion is the identity — the Filter
 * Effects spec defines `blur(<length>)` as "the standard deviation to the
 * Gaussian function", i.e. exactly `<feGaussianBlur stdDeviation="length">`.
 * (The factor-of-two people reach for belongs to `box-shadow`, whose blur
 * radius is 2σ. Applying it here would halve every blur in the export.)
 *
 * Measured rather than assumed, in Chrome: a 100×100 rect under
 * `ctx.filter = 'blur(12px)'` and the same rect under `stdDeviation="12"`
 * rasterised through an `<img>` give a bit-identical alpha profile — RMS 0.000
 * across the row, identical ink count, identical 10–90% edge width. `σ = 6`
 * gives RMS 15.5 and `σ = 24` gives 24.6, so the check is not blind to the
 * error it rules out.
 *
 * This exists as a named function rather than nothing at all so the claim has
 * one place to live and one place to be corrected — a bare pass-through in a
 * caller reads as "nobody thought about it".
 *
 * The UNITS still need care: a canvas blur radius is in DEVICE pixels and
 * ignores the CTM, while `stdDeviation` is in user units (with
 * `primitiveUnits` at its default). A caller whose viewBox is not 1:1 with its
 * rendered size must convert.
 */
export function blurRadiusToStdDeviation(radius: number): number {
  return Number.isFinite(radius) && radius > 0 ? radius : 0
}

/**
 * One paintable path in document space. Paint is optional throughout so a
 * caller can emit geometry only and style it downstream (CSS, or a consumer
 * that re-paints per facet).
 */
export interface VectorShape {
  commands: VectorCommand[]
  /**
   * A CSS colour, or a paint server — a gradient or a tiling pattern — which is
   * emitted ONCE in `<defs>` per distinct value and referenced by `url(#…)`, so
   * forty glyphs sharing a ramp share one `<linearGradient>`. `null` is an
   * explicit `fill="none"`; omitted leaves the attribute off entirely.
   */
  fill?: VectorPaint | null
  /**
   * Same vocabulary as `fill`: a CSS colour or a paint server (a gradient
   * stroke is a real `<linearGradient>` referenced by `url(#…)`, sharing the
   * def with an equal fill). `null` writes no stroke attribute at all.
   */
  stroke?: VectorPaint | null
  strokeWidth?: number
  /**
   * `stroke-dasharray`, in DOCUMENT units — the same units `strokeWidth` and the
   * path data are in.
   *
   * Written as a real attribute, never outlined into geometry or faked with a
   * clip: a consumer opening the file gets a dashed stroke it can restyle,
   * re-time or delete, and the path still describes the shape rather than the
   * shape's partly-visible remainder.
   *
   * Emitted only when the list is non-empty and every entry is a finite
   * non-negative number, which is what the SVG grammar allows; anything else is
   * dropped rather than written as an invalid attribute a renderer would answer
   * by drawing the stroke solid. An all-zero list is dropped for the same
   * reason — SVG defines it as "render solid", so writing it would be a
   * no-op attribute in the file.
   */
  dash?: readonly number[] | null
  /**
   * `stroke-dashoffset`, in DOCUMENT units: how far INTO the dash pattern the
   * stroke starts. Ignored without a `dash`. Omitted when it is 0, which is the
   * attribute's own default.
   */
  dashOffset?: number
  fillRule?: 'nonzero' | 'evenodd'
  opacity?: number
  /**
   * Gaussian blur as `feGaussianBlur`'s `stdDeviation`, in DOCUMENT units.
   * Emits a `<filter>` in `<defs>`, ONE per distinct value across the whole
   * document, and references it. Use `blurRadiusToStdDeviation` if what you
   * have is a canvas/CSS blur radius.
   */
  blur?: number
  /**
   * A reveal window in DOCUMENT space — a rect, optionally turned about a point
   * (`VectorWindow`). Emits a `<clipPath>` in `<defs>`, one per distinct
   * window, and references it.
   *
   * It is applied on a WRAPPER `<g>`, never on the path itself, so a shape's
   * own `transform` (in `attrs`) moves the shape THROUGH the window instead of
   * dragging the window along with it. That distinction is the whole difference
   * between a reveal and a translated, permanently-masked shape.
   *
   * The window's own `rotate` is NOT a hole in that rule: it is the window's
   * PLACEMENT, fixed for as long as the shape is placed where it is, and the
   * shape's `transform` still slides the shape through it. A shape standing at
   * an angle gets a window standing at the same angle, and it still does not
   * move.
   */
  clip?: VectorWindow | null
  /** Extra attributes, e.g. a Shape Studio facet id or a class for animation. */
  attrs?: Record<string, string | number>
}

export interface SvgDocOptions {
  /** Rendered size. Omitted → the viewBox size. */
  width?: number
  height?: number
  /** `[minX, minY, width, height]`. Omitted → `0 0 width height`. */
  viewBox?: [number, number, number, number]
  /** Painted as a full-bleed rect behind everything. Omitted → transparent. */
  background?: string | null
  /** Decimal places in path data. Default 3. */
  precision?: number
  /** Attributes on the wrapper `<g>`, e.g. a shared fill. */
  groupAttrs?: Record<string, string | number>
  /**
   * Prefix for every generated `<defs>` id. Omitted → derived from the
   * document's own content (see `defsIdPrefix`), which is what makes two
   * different exports safe to paste into one file.
   */
  idPrefix?: string
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}

function esc(v: string | number): string {
  return String(v).replace(/[&<>"']/g, ch => XML_ESCAPES[ch] as string)
}

function attrs(pairs: Array<[string, string | number | null | undefined]>): string {
  const out: string[] = []
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue
    out.push(`${k}="${esc(v)}"`)
  }
  return out.length ? ' ' + out.join(' ') : ''
}

/**
 * A dash list as the `stroke-dasharray` attribute, or `undefined` for "do not
 * write one".
 *
 * The grammar is strict and the failure mode is silent, which is why this is a
 * function rather than a `join(' ')`: SVG says an invalid list is an error (and
 * every shipping renderer answers by drawing the stroke SOLID), and it says a
 * list whose values sum to zero renders solid too. So a caller that hands over
 * a negative, a `NaN` or an all-zero list gets NO attribute rather than one
 * that turns a half-drawn stroke into a whole one — the difference between a
 * missing effect and a wrong picture.
 *
 * A single zero entry beside a positive one is legal and meaningful: it is a
 * zero-length dash, which under the default `butt` cap paints nothing. That is
 * the "not started yet" end of a reveal and must survive.
 */
function dashArrayAttr(dash: readonly number[] | null | undefined, precision: number): string | undefined {
  if (!dash || !dash.length) return undefined
  let sum = 0
  for (const v of dash) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
    sum += v
  }
  if (!(sum > 0)) return undefined
  return dash.map(v => formatNumber(v, precision)).join(' ')
}

/**
 * Below this there is nothing to see, and a `<filter>` costs the renderer a
 * separate offscreen pass. In document units, so it is a sub-hundredth of an
 * output pixel on a 1:1 export.
 */
const MIN_STD_DEVIATION = 0.01

/**
 * How far a Gaussian reaches, in σ. Past 3σ a Gaussian holds 0.3% of its
 * energy; the filter REGION below is padded by this much so a blurred shape
 * fades out instead of being cut off at the edge of its own filter.
 */
const BLUR_REACH = 3

/**
 * FNV-1a, 32-bit, as 7 base-36 characters.
 *
 * Not for security — for a short id prefix that is a pure function of the
 * document's content. Deterministic (a re-export of the same frame gets the
 * same ids, so exports diff cleanly) and content-derived (two different
 * exports get different ids, so they can be pasted into one file without one
 * shape picking up the other's filter).
 */
function hash36(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(7, '0').slice(-7)
}

/**
 * The id prefix for a document, derived from what the document CONTAINS.
 *
 * Exported so a caller can predict the ids (a test, or a consumer stitching
 * several documents together) without re-deriving the hash.
 */
export function defsIdPrefix(content: string): string {
  return `s${hash36(content)}`
}

/**
 * Fractional coordinates — `objectBoundingBox` units and stop offsets — are
 * written at their own precision, not the path data's. At the document's
 * default 3 places a bounding-box coordinate quantises to a thousandth of the
 * shape, which on a 900px run is nearly a pixel of drift against the canvas for
 * free.
 */
const UNIT_PRECISION = 5

/** A `<defs>` registry: distinct values in first-use order, each with an id. */
class Defs {
  private readonly blurs = new Map<string, number>()
  private readonly clips = new Map<string, VectorWindow>()
  private readonly gradients = new Map<string, VectorGradient>()
  private readonly patterns = new Map<string, VectorPattern>()
  /**
   * The raster embeds, keyed by URL + the tile they are stretched onto, emitted
   * ONCE as an `<image>` in `<defs>` and `<use>`d by every pattern that carries
   * them.
   *
   * Not a micro-optimisation. A run-anchored paint under per-glyph motion emits
   * one pattern PER GLYPH — each carrying that glyph's own inverse transform,
   * which is what pins the paint (see `VectorGradient.transform`) — while the
   * picture inside every one of them is the SAME. Measured on a six-letter word
   * with a staggered translate: 161 KB still, 794 KB moving, of which five
   * sixths were byte-identical copies of one PNG. Sharing them puts it back to
   * 166 KB.
   *
   * The tile size is part of the key because `<use>` cannot resize an `<image>`
   * target: the shared element carries its own `width`/`height`, so two patterns
   * share it only when they stretch it exactly the same way.
   */
  private readonly images = new Map<string, { href: string; width: number; height: number }>()

  constructor(private readonly precision: number) {}

  /** The key IS the serialised value, so two shapes that would emit identical
   *  markup share one definition however they were computed. */
  blurKey(sd: number): string {
    const key = formatNumber(sd, this.precision)
    if (!this.blurs.has(key)) this.blurs.set(key, sd)
    return key
  }

  /**
   * The key IS the serialised value, and the ROTATION is part of it — two
   * windows over the same rect turned different ways are different windows, and
   * sharing one `<clipPath>` between them would mask both with whichever
   * arrived first. An unturned window appends nothing, so a document with no
   * rotated window keys, hashes and emits exactly as it did before rotation
   * existed.
   */
  clipKey(r: VectorWindow): string {
    const n = (v: number) => formatNumber(v, this.precision)
    const rot = windowRotate(r)
    const p = rot === 0 ? '' : (() => { const q = windowPivot(r); return ` @${n(rot)} ${n(q.x)} ${n(q.y)}` })()
    const key = `${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}${p}`
    if (!this.clips.has(key)) this.clips.set(key, r)
    return key
  }

  /**
   * The key IS the serialised value here too, so two shapes computed by
   * completely different routes — a run-anchored ramp under a stagger, say —
   * share one paint server whenever the markup would have been identical, and
   * a 40-glyph word emits ONE `<linearGradient>` rather than forty.
   */
  gradientKey(g: VectorGradient): string {
    // The key is the element's OWN MARKUP with the id left out, which makes
    // "identical markup" the dedup rule by construction rather than by a
    // hand-written serialiser that has to be kept in step with the writer. It
    // also means two values that differ in a field the markup does not USE —
    // an aspect on an axis-aligned ramp, where the correction is the identity —
    // correctly share one paint server instead of fragmenting the `<defs>`.
    const key = this.gradientMarkup(g, '')
    if (!this.gradients.has(key)) this.gradients.set(key, g)
    return key
  }

  /** Same rule again: the key IS the element's own markup with the id left out,
   *  so a `<pattern>` is shared by every shape whose tile, placement and
   *  contents would have been written identically — and by nothing else, because
   *  a pattern's PHASE is part of the picture. */
  patternKey(p: VectorPattern): string {
    // KEY mode writes the data URL inline (see `patternMarkup`), so two patterns
    // collide only when they carry the same picture as well as the same tile,
    // placement and geometry — the sharing below cannot make two different
    // rasters look alike to the dedup.
    const key = this.patternMarkup(p, '')
    if (!this.patterns.has(key)) this.patterns.set(key, p)
    if (p.image) this.imageKey(p)
    return key
  }

  /** The shared-image key for a pattern that carries one — registering it on
   *  first use, exactly as every other registry here does. */
  private imageKey(p: VectorPattern): string {
    const n = (v: number) => formatNumber(v, this.precision)
    const key = `${n(Math.max(0, p.width))}x${n(Math.max(0, p.height))}|${p.image}`
    if (!this.images.has(key)) {
      this.images.set(key, { href: p.image as string, width: Math.max(0, p.width), height: Math.max(0, p.height) })
    }
    return key
  }

  /** Every distinct value, in first-use order — the string the id prefix hashes. */
  signature(): string {
    const base = `${[...this.blurs.keys()].join(',')}|${[...this.clips.keys()].join(',')}`
    // Appended only when there is something to append, so a document with no
    // paint servers hashes EXACTLY as it did before they existed. An id prefix
    // that churns because an unrelated feature was added makes every previously
    // exported file diff for nothing. The `p:` tag keeps a pattern-only document
    // from hashing as if its patterns were gradients.
    const g = this.gradients.size ? `|${[...this.gradients.keys()].join(',')}` : ''
    const p = this.patterns.size ? `|p:${[...this.patterns.keys()].join(',')}` : ''
    return `${base}${g}${p}`
  }

  get empty(): boolean {
    return this.blurs.size === 0 && this.clips.size === 0
      && this.gradients.size === 0 && this.patterns.size === 0 && this.images.size === 0
  }

  idFor(prefix: string, kind: 'b' | 'c' | 'g' | 'p' | 'i', key: string): string {
    const keys = kind === 'b' ? this.blurs
      : kind === 'c' ? this.clips
      : kind === 'g' ? this.gradients
      : kind === 'i' ? this.images
      : this.patterns
    return `${prefix}-${kind}${[...keys.keys()].indexOf(key)}`
  }

  render(prefix: string, viewBox: readonly number[]): string {
    const p = this.precision
    const n = (v: number) => formatNumber(v, p)
    const out: string[] = []
    let i = 0
    for (const sd of this.blurs.values()) {
      // A userSpaceOnUse region spanning the WHOLE document, padded by the
      // blur's reach. The default region is objectBoundingBox −10%…120%, which
      // for a tall narrow shape (a lowercase 'l', a thin facet) is far smaller
      // than the blur: measured in Chrome, a 12×100 rect at σ 12 kept 1920 ink
      // pixels under the default region against the canvas's 11246, and 11228
      // under this one. Document-wide also means the region does not depend on
      // the shape, which is what lets one filter serve every shape that shares
      // a radius.
      const pad = sd * BLUR_REACH
      out.push(`<filter${attrs([
        ['id', `${prefix}-b${i}`],
        ['filterUnits', 'userSpaceOnUse'],
        ['x', n((viewBox[0] as number) - pad)],
        ['y', n((viewBox[1] as number) - pad)],
        ['width', n((viewBox[2] as number) + pad * 2)],
        ['height', n((viewBox[3] as number) + pad * 2)],
        // SVG's default is linearRGB; canvas and CSS filters work in sRGB.
        // Leaving it out shifts a blurred colour edge by up to 2/255 against
        // the canvas — small, but it is drift, and it is free to remove.
        ['color-interpolation-filters', 'sRGB'],
      ])}><feGaussianBlur${attrs([['stdDeviation', n(sd)]])}/></filter>`)
      i++
    }
    i = 0
    for (const r of this.clips.values()) {
      // The turn rides the `<rect>`, not the `<clipPath>` and not the wrapper
      // `<g>`: `clipPathUnits="userSpaceOnUse"` puts the rect in document space,
      // which is the space the canvas turns its context in before taking the
      // identical rect. An unturned window emits no attribute at all.
      const rot = windowRotate(r)
      const q = rot === 0 ? null : windowPivot(r)
      out.push(`<clipPath${attrs([['id', `${prefix}-c${i}`], ['clipPathUnits', 'userSpaceOnUse']])}><rect${attrs([
        ['x', n(r.x)],
        ['y', n(r.y)],
        ['width', n(Math.max(0, r.width))],
        ['height', n(Math.max(0, r.height))],
        ['transform', q ? `rotate(${n(rot)} ${n(q.x)} ${n(q.y)})` : undefined],
      ])}/></clipPath>`)
      i++
    }
    i = 0
    for (const g of this.gradients.values()) {
      out.push(this.gradientMarkup(g, `${prefix}-g${i}`))
      i++
    }
    // The raster embeds first, so a reader meets the picture before the five
    // patterns that place it. `<image>` inside `<defs>` is not rendered — it is
    // there to be `<use>`d, exactly like every other definition here.
    i = 0
    for (const im of this.images.values()) {
      out.push(`<image${attrs([
        ['id', `${prefix}-i${i}`],
        ['width', n(im.width)],
        ['height', n(im.height)],
        ['preserveAspectRatio', 'none'],
        ['href', im.href],
      ])}/>`)
      i++
    }
    i = 0
    for (const p of this.patterns.values()) {
      out.push(this.patternMarkup(p, `${prefix}-p${i}`, p.image ? this.idFor(prefix, 'i', this.imageKey(p)) : undefined))
      i++
    }
    return out.length ? `<defs>${out.join('')}</defs>` : ''
  }

  /**
   * One tiling paint server. `id` is omitted when empty, which is what lets
   * `patternKey` reuse this as the dedup key — same construction as
   * `gradientMarkup`.
   *
   * `x`/`y` are left at their default 0 and the whole placement rides in
   * `patternTransform`; see `VectorPattern` for why the tile's phase cannot be
   * implicit. The background is a full-bleed rect rather than a `fill` on the
   * `<pattern>` element (which SVG ignores) — and it is real geometry, so a
   * designer can recolour the ground without touching the figure.
   */
  private patternMarkup(p: VectorPattern, id: string, imageRef?: string): string {
    const prec = this.precision
    const n = (v: number) => formatNumber(v, prec)
    const w = Math.max(0, p.width)
    const h = Math.max(0, p.height)
    const bg = p.background
      ? `<rect${attrs([['width', n(w)], ['height', n(h)], ['fill', p.background]])}/>`
      : ''
    // The raster tier. `href` is a string this writer was HANDED — it is never
    // generated here (see `VectorPattern.image`).
    //
    // TWO FORMS, deliberately. With an `imageRef` (RENDER mode) the tile holds a
    // `<use>` of the one `<image>` in `<defs>`, so five patterns that differ only
    // in placement carry one copy of the picture between them. Without one (KEY
    // mode, `patternKey`) the data URL is written INLINE, because the key has to
    // tell two different rasters apart and a shared id would make them look
    // identical.
    //
    // The shared `<image>` carries `preserveAspectRatio="none"` and the tile's own
    // extent: the encoded bitmap's pixel dimensions are a rounding of the tile
    // size, and the default `xMidYMid meet` would letterbox that rounding into a
    // visible seam.
    const img = p.image
      ? imageRef
        ? `<use${attrs([['href', `#${imageRef}`]])}/>`
        : `<image${attrs([
            ['href', p.image],
            ['width', n(w)],
            ['height', n(h)],
            ['preserveAspectRatio', 'none'],
          ])}/>`
      : ''
    const body = (p.rects ?? [])
      .map(r => `<rect${attrs([
        ['x', n(r.x)],
        ['y', n(r.y)],
        ['width', n(Math.max(0, r.width))],
        ['height', n(Math.max(0, r.height))],
        ['fill', r.fill],
      ])}/>`)
      .join('')
    return `<pattern${attrs([
      ['id', id],
      ['patternUnits', 'userSpaceOnUse'],
      ['width', n(w)],
      ['height', n(h)],
      // A pattern's placement is sub-pixel-sensitive in a way path data is not:
      // half a cell of phase error is a visibly different picture, and the
      // translation component here is a document-space coordinate that can be in
      // the hundreds. Written at UNIT_PRECISION for the same reason bounding-box
      // coordinates are.
      ['patternTransform', p.transform ? `matrix(${p.transform.map(v => formatNumber(v, UNIT_PRECISION)).join(' ')})` : undefined],
    ])}>${bg}${img}${body}</pattern>`
  }

  /**
   * One paint server. `id` is omitted when it is empty, which is what lets
   * `gradientKey` reuse this as the dedup key.
   *
   * `userSpaceOnUse` is the straightforward half: the axis scaled onto `box` in
   * document units, a radial at the box centre with radius `max(w, h) / 2` —
   * the canvas resolver's own rule — and the caller's `transform` passed
   * through.
   *
   * `objectBoundingBox` is where SVG's non-uniform bbox mapping has to be
   * undone; see `VectorGradient.aspect`. When the correction is the identity
   * (a square box, or an axis-aligned ramp whose axis is an eigenvector of the
   * stretch) the plain unit-square form is written instead — same picture,
   * simpler file, and one paint server shared by shapes of every shape.
   */
  private gradientMarkup(g: VectorGradient, id: string): string {
    const p = this.precision
    const n = (v: number) => formatNumber(v, p)
    const u = (v: number) => formatNumber(v, UNIT_PRECISION)
    const userSpace = g.units === 'userSpaceOnUse'
    const box = g.box ?? { x: 0, y: 0, width: 1, height: 1 }
    const aspect = Number.isFinite(g.aspect as number) && (g.aspect as number) > 0 ? (g.aspect as number) : 1
    const stops = orderGradientStops(g.stops)
      .map(s => `<stop${attrs([
        ['offset', u(s.offset)],
        ['stop-color', s.color],
        ['stop-opacity', s.opacity === undefined || s.opacity >= 1 ? undefined : u(Math.max(0, s.opacity))],
      ])}/>`)
      .join('')
    const matrix = (m: Affine, prec: number) => `matrix(${m.map(v => formatNumber(v, prec)).join(' ')})`
    const head = (extra: Array<[string, string | number | null | undefined]>, xf: string | undefined) =>
      attrs([
        ['id', id],
        ['gradientUnits', userSpace ? 'userSpaceOnUse' : 'objectBoundingBox'],
        ['gradientTransform', xf],
        ...extra,
      ])

    if (g.type === 'radial') {
      if (userSpace) {
        return `<radialGradient${head([
          ['cx', n(box.x + box.width / 2)],
          ['cy', n(box.y + box.height / 2)],
          ['r', n(Math.max(box.width, box.height) / 2)],
        ], g.transform ? matrix(g.transform, p) : undefined)}>${stops}</radialGradient>`
      }
      // A circle of radius max(w,h)/2, said in bounding-box units: scale the
      // r = 0.5 ellipse about its centre until both radii are that.
      const sx = aspect >= 1 ? 1 : 1 / aspect
      const sy = aspect >= 1 ? aspect : 1
      const fix: Affine | undefined = sx === 1 && sy === 1
        ? undefined
        : [sx, 0, 0, sy, 0.5 * (1 - sx), 0.5 * (1 - sy)]
      return `<radialGradient${head(
        [['cx', '0.5'], ['cy', '0.5'], ['r', '0.5']],
        fix ? matrix(fix, UNIT_PRECISION) : undefined,
      )}>${stops}</radialGradient>`
    }

    const angle = g.angle ?? 0
    const ax = gradientUnitAxis(angle)
    if (userSpace) {
      return `<linearGradient${head([
        ['x1', n(box.x + ax.x1 * box.width)],
        ['y1', n(box.y + ax.y1 * box.height)],
        ['x2', n(box.x + ax.x2 * box.width)],
        ['y2', n(box.y + ax.y2 * box.height)],
      ], g.transform ? matrix(g.transform, p) : undefined)}>${stops}</linearGradient>`
    }

    const rad = ((Number.isFinite(angle) ? angle : 0) * Math.PI) / 180
    const c = Math.cos(rad), s = Math.sin(rad)
    // Axis-aligned, or square: the unit-square stretch leaves the bands
    // perpendicular, so the plain form already IS the canvas geometry.
    if (aspect === 1 || Math.abs(c * s) < 1e-12) {
      return `<linearGradient${head([
        ['x1', u(ax.x1)], ['y1', u(ax.y1)], ['x2', u(ax.x2)], ['y2', u(ax.y2)],
      ], undefined)}>${stops}</linearGradient>`
    }
    // Otherwise: declare the ramp along gradient-space x (0,0)→(1,0) and hand
    // SVG the map from that space into the unit square that, once the bbox
    // stretch is applied, is a SIMILARITY in user space — axis `(cos·w, sin·h)`
    // as the canvas draws it, with the bands genuinely perpendicular to it.
    //   G = S⁻¹ · [A  A⊥  P1],  A = (cos·w, sin·h),  S = diag(w, h)
    const fix: Affine = [c, s, -s / aspect, c * aspect, 0.5 - c / 2, 0.5 - s / 2]
    return `<linearGradient${head(
      [['x1', '0'], ['y1', '0'], ['x2', '1'], ['y2', '0']],
      matrix(fix, UNIT_PRECISION),
    )}>${stops}</linearGradient>`
  }
}

/**
 * Shapes → a complete standalone SVG document.
 *
 * Commands must already be in document space; this writer applies no transform
 * of its own, which is what keeps it free of any studio's coordinate
 * conventions. Use `transformCommands` first.
 *
 * A shape carrying `blur` or `clip` is wrapped in a `<g>` that references a
 * `<defs>` entry. The wrapper is not decoration:
 *
 *  - it has NO transform, so a filter's `stdDeviation` and a clip's rect stay
 *    in document units however the shape itself is transformed — matching a
 *    canvas, whose blur radius is in device pixels and ignores the CTM, and
 *    whose `ctx.clip()` is taken before the per-shape transform;
 *  - filter and clip sit on the SAME wrapper, and SVG's rendering model applies
 *    the filter first and clips the result — the order `ctx.filter` then
 *    `ctx.clip()` then `fill()` produces.
 *
 * A shape carrying a gradient or pattern `fill` registers a paint server in the
 * same `<defs>` and references it FROM THE PATH ITSELF. That is not an inconsistency
 * with the wrapper above: `clip-path` and `filter` are applied to the element
 * that carries them, so an untransformed wrapper is what holds them still,
 * whereas `fill` is INHERITED and a paint server is resolved in the user space
 * of the element actually painted — so the wrapper buys nothing, and a
 * `userSpaceOnUse` server is pinned by `VectorGradient.transform` instead.
 * Measured in Chrome, not reasoned about: see that field's doc.
 */
export function shapesToSVG(shapes: readonly VectorShape[], doc: SvgDocOptions = {}): string {
  const precision = doc.precision ?? 3
  const vb = doc.viewBox
  const width = doc.width ?? (vb ? vb[2] : 0)
  const height = doc.height ?? (vb ? vb[3] : 0)
  const viewBox = vb ?? [0, 0, width, height]

  const background = doc.background
    ? `<rect${attrs([
        ['x', formatNumber(viewBox[0], precision)],
        ['y', formatNumber(viewBox[1], precision)],
        ['width', formatNumber(viewBox[2], precision)],
        ['height', formatNumber(viewBox[3], precision)],
        ['fill', doc.background],
      ])}/>`
    : ''

  // PASS 1 — serialise the paths and register the defs. Ids cannot be written
  // yet: the prefix is a function of everything the document holds, which is
  // not known until the last shape has been read.
  const defs = new Defs(precision)
  const drawn: Array<{
    pairs: Array<[string, string | number | null | undefined]>
    paint: { kind: 'g' | 'p'; key: string } | null
    strokePaint: { kind: 'g' | 'p'; key: string } | null
    blur: string | null
    clip: string | null
  }> = []
  for (const s of shapes) {
    const d = commandsToPathData(s.commands ?? [], precision)
    if (!d) continue
    const extra: Array<[string, string | number | null | undefined]> = []
    for (const [k, v] of Object.entries(s.attrs ?? {})) extra.push([k, v])
    // A paint-server fill — a gradient or a pattern — registers its value now
    // and carries its KEY in the attribute; the key becomes a real `url(#…)` in
    // pass 2, once the prefix is known. Hashing the key rather than the finished
    // url is what stops two documents with the same geometry but different paint
    // servers — or the same servers assigned the other way round — from hashing
    // alike and then colliding when they are pasted into one file.
    const paint: { kind: 'g' | 'p'; key: string } | null =
      isVectorGradient(s.fill) ? { kind: 'g', key: defs.gradientKey(s.fill) }
      : isVectorPattern(s.fill) ? { kind: 'p', key: defs.patternKey(s.fill) }
      : null
    // A paint-server STROKE registers the same way; an equal fill and stroke
    // share one def because the key is a function of the value alone.
    const strokePaint: { kind: 'g' | 'p'; key: string } | null =
      isVectorGradient(s.stroke) ? { kind: 'g', key: defs.gradientKey(s.stroke) }
      : isVectorPattern(s.stroke) ? { kind: 'p', key: defs.patternKey(s.stroke) }
      : null
    const dash = dashArrayAttr(s.dash, precision)
    const pairs: Array<[string, string | number | null | undefined]> = [
      ['d', d],
      ['fill', s.fill === null ? 'none' : paint?.key ?? (s.fill as string | undefined)],
      ['fill-rule', s.fillRule],
      ['stroke', s.stroke === null ? undefined : strokePaint?.key ?? (s.stroke as string | undefined)],
      ['stroke-width', s.strokeWidth === undefined ? undefined : formatNumber(s.strokeWidth, precision)],
      ['stroke-dasharray', dash],
      // Rides on the dash, never written alone: an offset with no pattern to
      // offset is inert, and a file carrying it would carry a value nothing
      // reads. `0` is the attribute's own default, so it is omitted too.
      ['stroke-dashoffset', dash && s.dashOffset ? formatNumber(s.dashOffset, precision) : undefined],
      ['opacity', s.opacity === undefined ? undefined : formatNumber(s.opacity, 4)],
      ...extra,
    ]
    const sd = Number.isFinite(s.blur as number) ? (s.blur as number) : 0
    const clip = s.clip
    drawn.push({
      pairs,
      paint,
      strokePaint,
      blur: sd >= MIN_STD_DEVIATION ? defs.blurKey(sd) : null,
      clip: clip ? defs.clipKey(clip) : null,
    })
  }

  // The prefix hashes the geometry AND the defs, so two exports collide only
  // when they are the same picture — in which case the definitions they would
  // share are identical anyway.
  const prefix = doc.idPrefix
    ?? defsIdPrefix(`${viewBox.join(' ')}|${defs.signature()}|${drawn.map(x => `<path${attrs(x.pairs)}/>`).join('')}`)

  // PASS 2 — resolve the paint-server references and wrap.
  const body: string[] = []
  if (background) body.push(background)
  for (const item of drawn) {
    if (item.paint !== null) {
      const fill = item.pairs.find(pr => pr[0] === 'fill')
      if (fill) fill[1] = `url(#${defs.idFor(prefix, item.paint.kind, item.paint.key)})`
    }
    if (item.strokePaint !== null) {
      const stroke = item.pairs.find(pr => pr[0] === 'stroke')
      if (stroke) stroke[1] = `url(#${defs.idFor(prefix, item.strokePaint.kind, item.strokePaint.key)})`
    }
    let el = `<path${attrs(item.pairs)}/>`
    if (item.blur !== null || item.clip !== null) {
      el = `<g${attrs([
        ['filter', item.blur === null ? undefined : `url(#${defs.idFor(prefix, 'b', item.blur)})`],
        ['clip-path', item.clip === null ? undefined : `url(#${defs.idFor(prefix, 'c', item.clip)})`],
      ])}>${el}</g>`
    }
    body.push(el)
  }

  const group = body.length
    ? `<g${attrs(Object.entries(doc.groupAttrs ?? {}))}>${body.join('')}</g>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg"${attrs([
    ['width', formatNumber(width, precision)],
    ['height', formatNumber(height, precision)],
    ['viewBox', viewBox.map(v => formatNumber(v, precision)).join(' ')],
  ])}>${defs.empty ? '' : defs.render(prefix, viewBox)}${group}</svg>`
}
