/**
 * `Paint` → the vector spine's paint vocabulary.
 *
 * The export-side twin of `resolve.ts`: that module turns a `Paint` into
 * something a canvas can fill with, this one turns the same `Paint` into
 * something `lib/vector/svg` can write into `<defs>`. Both live here rather
 * than in either the spine or a studio, because the spine must stay free of the
 * product's fill model (Shape Studio is its second consumer) and the mapping is
 * the same for every studio that stores a `Paint`.
 *
 * TIERS 1 AND 2. Two families map onto SVG paint servers, so they come out as
 * real, editable vector:
 *
 *  - **gradients** — `Gradient`'s multi-stop linear/radial form AND `Fill`'s
 *    two-colour `a`/`b` + `angle` form, which are the same idea written twice.
 *  - **procedural patterns** — `grid`, `checkerboard`, `stripes` and `qr`, as
 *    `<pattern>` tiles of real rectangles. Their geometry is not re-derived
 *    here: every number comes from the cell maths in `~/lib/spacetype/fillTile`
 *    that the canvas tile builders themselves call.
 *
 * TIER 3. `ombre`, `noise` and `shader` cannot be vector at ALL — the first two
 * are per-pixel hashes with no cell structure to draw, the third is a fragment
 * program — so they come out as a `<pattern>` holding one `<image>`, provided
 * the caller hands over a raster to embed (`VectorPaintOptions.raster`). That is
 * a real, working export; it is simply pixels, and the product's job is to say
 * so rather than to pretend otherwise. Note the raster is passed IN: this module
 * has no canvas and does not acquire one.
 *
 * `ImageFill` (Task 4) is the same TIER 3 story told a third time: it is
 * ALREADY pixels — there is no geometry to derive, vector or otherwise — so it
 * takes the identical `<pattern>`-with-`<image>` arm the moment a caller hands
 * over a raster, sharing `rasterTile` with the two fill kinds above rather than
 * growing its own copy.
 *
 * With no raster to embed, those three return `null` and the caller degrades to
 * a flat colour — the pre-task-6 bridge, still what SSR, a worker and a unit
 * test get. A `null` here is therefore "not without pixels", never "no paint".
 *
 * Pure: no DOM, no canvas. Callable from a test, a worker, or SSR.
 */
import {
  type Affine,
  type VectorGradient,
  type VectorGradientStop,
  type VectorPaint,
  type VectorPattern,
  type VectorPatternRect,
  type VectorRect,
  IDENTITY_AFFINE,
  invertAffine,
  isVectorPattern,
  multiplyAffine,
} from '~/lib/vector/svg'
import { type Paint, isFill, isGradient, isImageFill, sortedClampedStops } from '~/lib/compositor/paint'
import {
  type Fill,
  checkerCellIsB,
  fillPatternCell,
  gridLineWidth,
  qrCellIsB,
  stripeBandIsB,
} from '~/lib/spacetype/fillTile'

export interface VectorPaintOptions {
  /**
   * `objectBoundingBox` — the paint is anchored to each referencing shape's own
   * bounds, i.e. Vector Type's `glyph` anchor. `userSpaceOnUse` — anchored to
   * `box`, i.e. the `word` and `frame` anchors.
   */
  units: 'objectBoundingBox' | 'userSpaceOnUse'
  /**
   * The box the paint spans, in document units.
   *
   * Required by `userSpaceOnUse`. Also required by EVERY pattern, `units`
   * notwithstanding: a `<pattern>` is always `userSpaceOnUse` (see
   * `VectorPattern`), so even the per-shape anchor needs the shape's own box
   * spelled out in document units rather than implied by SVG's bounding box.
   * A pattern with no box comes back `null` and stays on the caller's flat
   * fallback rather than guessing a lattice.
   */
  box?: VectorRect
  /**
   * The referencing shape's own transform. Under `userSpaceOnUse` the emitted
   * `gradientTransform` is its INVERSE, which is what pins the paint in
   * document space while the shape moves over it — see `VectorGradient.units`
   * for why the untransformed-wrapper trick does not do this job.
   */
  elementTransform?: Affine | null
  /**
   * TIER 3 — a PRE-ENCODED raster of this paint over `box`, as a `data:` URL.
   *
   * Only `ombre`, `noise` and `shader` consult it, and only when they have a
   * `box`: those three have no vector form at ANY tier (two per-pixel hashes and
   * a fragment program), so the alternative is not a better export, it is a flat
   * colour that throws the fill away. With one, they come back as a `<pattern>`
   * whose tile is a single `<image>` — a real, working export that is simply
   * raster, which the product declares rather than hides.
   *
   * Passed IN, never produced here, for the same reason the spine does not
   * produce one: this module is pure (no DOM, no canvas), and rasterising a
   * paint means owning a canvas. `lib/vectortype/canvas` is where that happens.
   * Omit it and these three stay on the caller's flat fallback, unchanged — which
   * is exactly what a worker, SSR or a unit test gets.
   */
  raster?: string | null
  /**
   * The referencing shape's box aspect (`w / h`), passed straight through to
   * `VectorGradient.aspect` — which is where the reason lives. Short version:
   * SVG's bounding-box mapping is non-uniform, so on a non-square shape both a
   * linear's band direction and a radial's radius come out wrong without it.
   * Default 1 (square).
   */
  aspect?: number
}

function stopsOf(stops: Array<{ offset: number; color: string }>): VectorGradientStop[] {
  // Sorted and clamped through the SAME helper the canvas gradients use, so the
  // two cannot disagree about what an out-of-order or out-of-range stop means.
  // An `rgba(r, g, b, a)` stop (a layout's fading band) is split into an opaque colour plus
  // `stop-opacity`, which every SVG reader understands.
  return sortedClampedStops(stops).map(s => {
    const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(s.color.trim())
    if (!m) return { offset: s.offset, color: s.color }
    const hex = [m[1], m[2], m[3]].map(v => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0')).join('')
    const a = Math.max(0, Math.min(1, Number(m[4])))
    return a >= 1 ? { offset: s.offset, color: `#${hex}` } : { offset: s.offset, color: `#${hex}`, opacity: a }
  })
}

/** A `Fill`'s gradient arm is the two-colour shorthand for the same thing: `a`
 *  at 0, `b` at 1, ramped at `angle`. Written out as real stops so the export
 *  is a paint server a designer can add a third stop to. */
function fillGradientStops(fill: Fill): VectorGradientStop[] {
  return [{ offset: 0, color: fill.a }, { offset: 1, color: fill.b }]
}

function gradientFor(
  type: 'linear' | 'radial',
  angle: number,
  stops: VectorGradientStop[],
  opts: VectorPaintOptions,
): VectorGradient | null {
  if (!stops.length) return null
  const userSpace = opts.units === 'userSpaceOnUse'
  const transform = userSpace && opts.elementTransform ? invertAffine(opts.elementTransform) : null
  return {
    type,
    stops,
    ...(type === 'linear' ? { angle } : {}),
    units: opts.units,
    ...(userSpace ? {} : { aspect: opts.aspect ?? 1 }),
    ...(userSpace && opts.box ? { box: opts.box } : {}),
    ...(transform ? { transform } : {}),
  }
}

// ── The procedural patterns ─────────────────────────────────────────────────
//
// All four are the same shape of answer: a tile of rectangles, plus the matrix
// that puts that tile's lattice where the canvas puts its own.
//
// THE PLACEMENT. The canvas builds a tile the size of the paint box and draws it
// ONCE, corner-aligned to the box (`resolveFill`'s `translate(-w/2, -h/2)`
// against a context centred on the box). So the lattice origin is the box's
// top-left corner in the space the shape is painted in, and every emitter's
// transform starts `translate(box.x, box.y)`.
//
// Under the `word`/`frame` anchors the caller also hands us the shape's own
// transform, and the INVERSE of it is composed on the left — the same
// correction, for the same reason, as a `userSpaceOnUse` gradient's
// `gradientTransform` (`VectorGradient.transform`; measured, not reasoned
// about). Under the per-shape anchor there is no transform to cancel: the
// pattern is MEANT to ride the shape, and the box is already expressed in the
// shape's own pre-motion coordinates.

/** `translate(x, y)`. */
function translation(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y]
}

/** `rotate(deg)`, y-down like every space this reaches — so `+angle` turns the
 *  same way `Math.cos/sin` do in the canvas pickers, which is what makes a
 *  stripe band's normal `(cos, sin)` on both surfaces. */
function rotation(deg: number): Affine {
  const rad = ((Number.isFinite(deg) ? deg : 0) * Math.PI) / 180
  const c = Math.cos(rad), s = Math.sin(rad)
  return [c, s, -s, c, 0, 0]
}

/** The full pattern-space → element-space matrix, or `undefined` for identity. */
function patternPlacement(box: VectorRect, inverse: Affine | null, extra?: Affine): Affine | undefined {
  let m: Affine = inverse ?? IDENTITY_AFFINE
  m = multiplyAffine(m, translation(box.x, box.y))
  if (extra) m = multiplyAffine(m, extra)
  return m.every((v, i) => v === IDENTITY_AFFINE[i]) ? undefined : m
}

/**
 * `grid` — the cell colour `a` ruled with `b` lines on every cell boundary.
 *
 * The canvas strokes lines CENTRED on `x = 0, cell, 2·cell, …`, so a tile whose
 * origin is a cell boundary has to carry each line in two halves, one at each
 * edge. **Do not do that.** Measured in Chrome: two abutting half-width rects on
 * opposite edges of a fractional-sized tile do not rasterise back into one line
 * — a 9.906-unit tile with 0.5 at each edge came out at 0.73 units of ink
 * instead of 1, which reads as the whole word being ~10/255 too light. It is a
 * tiling artefact, invisible as anything but a tint, and it passed every
 * geometry check.
 *
 * So each line is ONE whole rect at the tile's near edge, and the LATTICE is
 * shifted back by half a line width instead (`gridOffset`) — which puts the same
 * ink in the same place with nothing straddling a tile seam.
 */
function gridTile(fill: Fill, cell: number): { background: string; rects: VectorPatternRect[]; width: number; height: number } {
  const lw = Math.min(gridLineWidth(cell), cell)
  return {
    width: cell,
    height: cell,
    background: fill.a,
    rects: [
      { x: 0, y: 0, width: lw, height: cell, fill: fill.b },
      { x: 0, y: 0, width: cell, height: lw, fill: fill.b },
    ],
  }
}

/** The half-line-width the grid lattice is shifted by — see `gridTile`. */
function gridOffset(cell: number): Affine {
  const lw = Math.min(gridLineWidth(cell), cell)
  return translation(-lw / 2, -lw / 2)
}

/** `checkerboard` — a `2·cell` tile, with `checkerCellIsB` (the canvas picker's
 *  own rule) deciding which two of the four squares are `b`. */
function checkerTile(fill: Fill, cell: number): { background: string; rects: VectorPatternRect[]; width: number; height: number } {
  const rects: VectorPatternRect[] = []
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      if (checkerCellIsB(cx, cy)) rects.push({ x: cx * cell, y: cy * cell, width: cell, height: cell, fill: fill.b })
    }
  }
  return { width: cell * 2, height: cell * 2, background: fill.a, rects }
}

/**
 * `stripes` — bands of width `cell` perpendicular to `(cos θ, sin θ)`.
 *
 * The canvas does this with a PER-PIXEL dot product, `floor((x·cos + y·sin) /
 * cell)`, not with a rotated tile — which is exactly the thing the plan flagged
 * as maybe-unmatchable. It matches, and the reason it does is that the dot
 * product is an orthonormal change of basis: in the frame rotated by θ the
 * predicate depends only on `u`, so a `2·cell` tile carrying one `a` band and
 * one `b` band, placed by `rotate(θ)`, IS that function. Including where SVG
 * tiles into NEGATIVE band indices and the canvas never does — `stripeBandIsB`
 * is written for a signed index so `k = -1` agrees with `k = 1`.
 *
 * The tile is square rather than `2·cell × 1`, purely so that a renderer
 * rasterising it before applying the rotation has a sane aspect to work with.
 */
function stripeTile(fill: Fill, cell: number): { background: string; rects: VectorPatternRect[]; width: number; height: number } {
  const rects: VectorPatternRect[] = []
  for (let k = 0; k < 2; k++) {
    if (stripeBandIsB(k)) rects.push({ x: k * cell, y: 0, width: cell, height: cell * 2, fill: fill.b })
  }
  return { width: cell * 2, height: cell * 2, background: fill.a, rects }
}

/**
 * `qr` — a deterministic per-cell hash, which is NOT periodic, so there is no
 * small tile to repeat. The tile is the whole box and it is emitted cell by
 * cell, `qrCellIsB` (again the canvas picker's own rule) deciding each one.
 *
 * Horizontally adjacent `b` cells are merged into one rect. That is not a
 * micro-optimisation: at the top of the density range a per-glyph box is a few
 * thousand cells, and the run merge roughly halves what a designer has to scroll
 * past. It cannot change the picture — abutting rects of one colour are the
 * rect that spans them.
 */
function qrTile(fill: Fill, cell: number, box: VectorRect): { background: string; rects: VectorPatternRect[]; width: number; height: number } {
  const cols = Math.max(1, Math.ceil(box.width / cell))
  const rows = Math.max(1, Math.ceil(box.height / cell))
  const rects: VectorPatternRect[] = []
  for (let cy = 0; cy < rows; cy++) {
    const y = cy * cell
    const height = Math.min(cell, box.height - y)
    let run = -1
    for (let cx = 0; cx <= cols; cx++) {
      const on = cx < cols && qrCellIsB(cx, cy)
      if (on && run < 0) run = cx
      if (!on && run >= 0) {
        const x = run * cell
        rects.push({ x, y, width: Math.min(cx * cell, box.width) - x, height, fill: fill.b })
        run = -1
      }
    }
  }
  return { width: box.width, height: box.height, background: fill.a, rects }
}

/**
 * TIER 3 — the whole box as one embedded `<image>`, placed exactly the way `qr`
 * places its own box-sized tile.
 *
 * This is the FALLTHROUGH, not a list of three kind names: whatever a patterned
 * fill is, if none of the emitters above could describe its geometry then the
 * only honest thing left is the pixels the canvas painted. A tenth fill type
 * lands here automatically, and moves up the moment it gets an emitter.
 *
 * `null` with no raster in hand — the caller's flat fallback. Never a guess.
 */
function rasterTile(box: VectorRect, inverse: Affine | null, raster: string | null | undefined): VectorPattern | null {
  if (!raster) return null
  return {
    type: 'pattern',
    width: box.width,
    height: box.height,
    // No background and no rects: the image IS the tile. A background would show
    // through wherever the raster carries alpha, which for a shader field is a
    // silent, plausible-looking colour shift rather than a visible failure.
    rects: [],
    image: raster,
    ...withTransform(patternPlacement(box, inverse)),
  }
}

/** A patterned `Fill` as a `<pattern>`, or `null` where there is nothing to
 *  anchor it to (see `VectorPaintOptions.box`) or the kind has no cell
 *  structure AND no raster was handed in. */
function patternFor(fill: Fill, opts: VectorPaintOptions): VectorPattern | null {
  const box = opts.box
  if (!box || !(box.width > 0) || !(box.height > 0)) return null
  // THE cell edge — `fillTileBox`'s own call, with the box in document units
  // instead of tile pixels. One definition, two renderers.
  const cell = fillPatternCell(box.width, fill.density)
  const inverse = opts.units === 'userSpaceOnUse' && opts.elementTransform
    ? invertAffine(opts.elementTransform)
    : null
  if (fill.type === 'stripes') {
    return {
      type: 'pattern',
      ...stripeTile(fill, cell),
      ...withTransform(patternPlacement(box, inverse, rotation(fill.angle))),
    }
  }
  if (fill.type === 'grid') {
    return {
      type: 'pattern',
      ...gridTile(fill, cell),
      ...withTransform(patternPlacement(box, inverse, gridOffset(cell))),
    }
  }
  const tile = fill.type === 'checkerboard' ? checkerTile(fill, cell)
    : fill.type === 'qr' ? qrTile(fill, cell, box)
    : null
  if (!tile) return rasterTile(box, inverse, opts.raster)
  return { type: 'pattern', ...tile, ...withTransform(patternPlacement(box, inverse)) }
}

function withTransform(m: Affine | undefined): { transform?: Affine } {
  return m ? { transform: m } : {}
}

/**
 * A `Paint` as something the SVG writer can paint with, or `null` where this
 * paint has no vector form (see the header).
 *
 * A flat colour comes back as the string itself, so a caller can use one code
 * path for `solid` and for a gradient.
 */
export function paintToVectorPaint(paint: Paint | undefined, opts: VectorPaintOptions): VectorPaint | null {
  // ImageFill has no vector form AT ALL (see the header's TIER 3 note) — it
  // only ever comes out as a `<pattern>` holding the raster the caller
  // rasterized over `box`, sharing `rasterTile` with the shader/ombre/noise
  // arm below. With no box to anchor to, or no raster in hand (SSR, a worker,
  // a unit test, `exportTier`'s own no-raster probe), the shape exports
  // unfilled and the caller degrades to its solid fallback — unchanged from
  // before this task.
  if (isImageFill(paint)) {
    if (!opts.box || !(opts.box.width > 0) || !(opts.box.height > 0) || !opts.raster) return null
    const inverse = opts.units === 'userSpaceOnUse' && opts.elementTransform
      ? invertAffine(opts.elementTransform)
      : null
    return rasterTile(opts.box, inverse, opts.raster)
  }
  if (typeof paint === 'string') return paint
  if (isGradient(paint)) {
    return gradientFor(
      paint.type === 'radial' ? 'radial' : 'linear',
      paint.type === 'radial' ? 0 : paint.angle ?? 0,
      stopsOf(paint.stops ?? []),
      opts,
    )
  }
  if (isFill(paint)) {
    if (paint.type === 'solid') return paint.a
    if (paint.type === 'gradient') return gradientFor('linear', paint.angle, fillGradientStops(paint), opts)
    return patternFor(paint, opts)
  }
  return null
}

/**
 * What an SVG export of this paint actually IS.
 *
 *  - `vector` — a flat `fill="#rrggbb"` or a `<linearGradient>`/`<radialGradient>`.
 *  - `pattern` — a `<pattern>` of real rectangles. Still genuine, editable
 *    geometry; named apart from `vector` only because it is a different thing to
 *    open in an editor (a tile you can recolour, not a ramp you can add a stop
 *    to). Both tiers are "real vector" for the purpose of the studio's claim.
 *  - `raster` — no geometric description exists, so the export embeds a picture
 *    (`<pattern><image href="data:image/png…">`). `ombre` and `noise` are
 *    per-pixel hashes and a `shader` is a fragment program.
 *
 * DERIVED, NOT TABULATED. The answer is whatever `paintToVectorPaint` — the one
 * function the exporter itself calls — hands back for this paint, classified by
 * the spine's own `isVectorPattern` guard. There is no list of kind names here
 * to fall out of step with the emitters; adding a tenth fill type, or teaching
 * an existing one a vector form, moves its tier the same day without anyone
 * remembering to. The codebase has been bitten twice recently by a
 * hand-maintained list that disagreed with its catalog; this is the shape that
 * cannot.
 *
 * TWO THINGS ABOUT THE ARGUMENTS, both load-bearing:
 *
 *  - **The unit box** is not a placeholder to be tidied away. It is what makes
 *    this a question about the paint's KIND rather than about a particular
 *    shape, given that a pattern refuses to emit without a box to anchor to.
 *    Without it the four pattern kinds would read `raster` and the studio would
 *    put the note on seven fills instead of three.
 *  - **No `raster`** is handed in, deliberately. The tier 3 arm turns ANY
 *    patterned fill into a `<pattern><image>` once a caller supplies pixels, so
 *    asking with one would answer "can this be embedded?" — true of everything.
 *    Asking without one answers the question the user is actually owed: does
 *    this paint have a form of its OWN, or does it exist only as a picture?
 *    (The `image` guard below covers a caller who asks with one anyway.)
 *
 * A paint with no vector form at all — `undefined`, a malformed gradient — reads
 * `raster` too, which is the honest answer to "will this come out as editable
 * geometry?". Callers wanting to NAME the fill in a sentence should ask
 * `isFill` first; there is no kind to name otherwise.
 */
export type ExportTier = 'vector' | 'pattern' | 'raster'

export function exportTier(paint: Paint | undefined): ExportTier {
  const vp = paintToVectorPaint(paint, {
    units: 'objectBoundingBox',
    box: { x: 0, y: 0, width: 1, height: 1 },
  })
  if (vp === null) return 'raster'
  // A tile whose content is an embedded picture is a raster export wearing a
  // `<pattern>` — the wrapper is plumbing, not geometry. Read structurally
  // rather than by kind so this stays true of whatever lands in that arm next.
  if (isVectorPattern(vp)) return (vp as { image?: string | null }).image ? 'raster' : 'pattern'
  return 'vector'
}

/** True when the export carries this paint as real geometry — both vector tiers.
 *  Kept as the yes/no form of `exportTier` for callers that only need the claim. */
export function paintIsVector(paint: Paint | undefined): boolean {
  return exportTier(paint) !== 'raster'
}
