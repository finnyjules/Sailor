/**
 * Vector Type Studio — smart stretch. PURE.
 *
 * Typographic stretch: white space stretches, ink doesn't. Each glyph gets a
 * per-axis FLEX PROFILE — how stretchable each thin slice of the glyph is —
 * and stretching is a monotone piecewise-linear remap of outline coordinates
 * whose slice widths scale in proportion to flex. Points only ever MOVE, so
 * the command count is constant across any stretch value: the same `gvar`
 * property the motion system already relies on for variable-axis animation.
 *
 * Flex follows Pagurek's tangent-aligned formulation
 * (davepagurek.com/programming/stretch-text/): a slice's flex is the MINIMUM
 * over its ink of |tangent · stretch-direction|^k. A vertical stem pins its
 * X slices (tangent ⊥ stretch), a counter or crossbar stretches freely, a
 * diagonal sits in between. k = 0 degenerates to uniform scaling — the lab's
 * "naive" comparison column is this same code path, not a second renderer.
 *
 * On top of that, three SHAPE-INTEGRITY rules (`shapeRules`, default on),
 * because ink comes in three kinds and one exponent treats them alike:
 *   1. stroke edges — straight lines ≥ `straightMin`, and every curve — pin
 *      by min; short lines (caps, notch facets, terminal cuts) only pin in
 *      proportion to the ink they own in the slice, so an S's cut terminals
 *      and an X's crossing facets no longer freeze whole slices;
 *   2. a straight diagonal stroke stretches UNIFORMLY along its span (stems
 *      crossing it exempt), so it stays straight instead of kinking where
 *      the stretch changes — `uniformSpans`;
 *   3. a mirror-symmetric outline gets a mirror-symmetric profile —
 *      `symmetrize`.
 *
 * The min runs over the ink's INTERIOR, computed by propagating each cell's
 * nearest-boundary tangent across a small per-glyph grid with a chamfer
 * distance transform — NOT by sampled-boundary nearest-neighbour lookup,
 * which is where the original write-up's cusp/edge artifacts came from.
 *
 * Coordinates are FONT UNITS, y-up, baseline at y = 0, matching outline.ts.
 */
import type { VtFont } from './font'
import type { GlyphOutline, PathCommand, TextOutlines, VtBBox } from './outline'
import { textOutlines } from './outline'

export interface FlexProfile {
  /** Left/bottom edge of bin 0, in font units. */
  start: number
  binSize: number
  /** Per-bin stretchiness in [0, 1]; 1 = fully flexible. */
  flex: Float64Array
  /** Fraction of the bin's grid cells that are ink, in [0, 1]. Empty space
   *  (counters, gaps) is 0; used to pick condense floors. Optional so
   *  hand-built profiles in tests stay terse — absent means "infer from
   *  flex": fully flexible ⇒ empty, anything resisting ⇒ ink. */
  ink?: Float64Array
  /** 1 for a TURN bin — its pinning ink is curved and only partially
   *  aligned to this axis (no straight stem pins it, but it isn't free
   *  either): a round's shoulder, not its apex. Rounds-stay-round (rule 10)
   *  presets these bins to a width tied to the OTHER axis's stretch factor
   *  instead of letting the ordinary flex distribution hold or grow them.
   *  Optional for the same reason `ink` is. */
  turn?: Uint8Array
  /** 1 for a bin that `uniformSpans` flattened — it lies on a straight
   *  diagonal stroke and must stretch by the same amount as the rest of
   *  that stroke's span, so the stroke stays straight. The bell
   *  distribution reads this to give such a span one constant weight
   *  instead of the bell's varying one. Optional like `ink` and `turn`. */
  uniform?: Uint8Array
  /** 1 for a bin the diagonal-terminal patch pinned to `SOFT_TERMINAL_PIN`
   *  rather than full rigidity (a terminal too short to earn rule 11's
   *  outright rigid protection). Its reported `flex` reads well above
   *  `HARD_RIGID` by design (it must not hard-pin to exactly 0), but it must
   *  still be excluded from ordinary bell/run growth-sharing — `bellWeights`
   *  reads this alongside `isBellRigid`'s ink-aware check. Optional like
   *  `ink`, `turn` and `uniform`. */
  softTerm?: Uint8Array
}

/** How a free bin's share of the stretch is decided (see `binWidths`):
 *  `'flex'` — in proportion to its tangent alignment (the original
 *  formulation; k shapes it); `'bell'` — as a raised cosine across each
 *  maximal run of non-rigid bins, so the change is near zero beside the
 *  rigid plateaus and largest mid-run. `stretchOutlines` uses `'bell'`
 *  whenever shape rules are on. */
export type DistributionMode = 'flex' | 'bell'

export interface GlyphFlex {
  x: FlexProfile
  y: FlexProfile
}

export interface FlexOptions {
  bins?: number
  k?: number
  /** Ink components smaller than this (font units, larger dimension) are
   *  fully rigid — a tittle, period, or diacritic keeps its exact shape and
   *  rides the remap as a unit. 0/undefined disables. */
  smallFeature?: number
  /** A `lineTo` at least this long (font units) is a STRAIGHT STROKE — its ink
   *  is hard-rigid (min) and, when diagonal, must stretch uniformly along its
   *  whole span so it stays straight. Shorter lines (a notch facet, a cut
   *  terminal) and every flattened curve sample are soft ink (mean). Default:
   *  `STRAIGHT_MIN_EM` × the glyph's larger bbox dimension, so hand-built
   *  rects without a unitsPerEm still classify sensibly; `stretchOutlines`
   *  passes `STRAIGHT_MIN_EM` × unitsPerEm explicitly. */
  straightMin?: number
  /** Shape-integrity rules (default on): hard/soft ink channels, straight-
   *  span uniformity, mirror symmetry. Off = the original pure-min
   *  aggregation with neither pass — the lab's A/B control. */
  shapeRules?: boolean
  /** Rounds-stay-round coupling (rule 10): a round's turn-region height
   *  follows its WIDTH. Remap-time only — does not affect `analyzeFlex`, so
   *  it is deliberately left out of `glyphFlexFor`'s cache key. See
   *  `ROUND_COUPLING`. */
  roundCoupling?: number
}

const DEFAULT_BINS = 64
/** k = 1 by default: with the hard/soft split, stems are rigid regardless of
 *  k (hard min), so k only shapes how curves flow — and at k ≈ 1 an S under
 *  Height 2.29 keeps flowing instead of freezing its spine into a "5". */
const DEFAULT_K = 1
/** Straight-stroke threshold as a fraction of the em (or, for bare
 *  `analyzeFlex` calls, of the glyph's larger dimension). Inter's X has
 *  140-unit vertical notch facets at its crossing on a 1490-tall glyph — 9%,
 *  NOT a stroke; a 700-tall stem edge is; a 21-unit curve sample never is. */
export const STRAIGHT_MIN_EM = 0.12
/** Bins at or below this raw hard alignment are a stem crossing a straight
 *  span: they stay rigid and the span's uniformity is enforced around them
 *  (a Y's arm bends exactly once, at the junction). Same cut `binWidths` and
 *  `stemWidthOf` use for "rigid". */
const HARD_RIGID = 0.05
/** Fix 1 (continued): a diagonal terminal too SHORT to earn rule 11's
 *  outright rigid patch (`termHard` false) is still pinned to a small,
 *  SOFT value on both axes rather than left to its natural (often much
 *  higher — measured ~0.86) alignment: soft-pinned (below `HARD_RIGID`'s
 *  neighbourhood, same 0.05–0.15 band `isBellRigid` treats as a candidate
 *  for ink-aware rigidity) is enough to clear the "not hard-rigid" bar a
 *  plain terminal-owned row needs, while staying low enough that a
 *  sufficiently ink-heavy row around it still reads as a held stroke rather
 *  than a free bin that would amplify the way a genuinely free bin does.
 *  Tuned empirically (0.055–0.09 sweep): values ≥ 0.07 reopen the
 *  terminal-angle regression this patch exists to prevent. */
const SOFT_TERMINAL_PIN = 0.065
/** Straight segments whose |tangent·axis| lies strictly inside this band are
 *  DIAGONAL for that axis: a stem (≈ 0) is already pinned by the hard min and
 *  a crossbar (≈ 1) is fully flexible, so only the in-between needs the
 *  straightness rule. */
const DIAG_LO = 0.3
const DIAG_HI = 0.95
/** Default small-feature limit as a fraction of the em. An i's dot or a
 *  period is ~0.1–0.15 em; the smallest real letterform parts (a lowercase
 *  counter) are well above 0.3 em. */
export const SMALL_FEATURE_EM = 0.22
/** Curve flattening steps for ANALYSIS only — the remap itself moves the real
 *  control points, so this resolution never appears in output geometry. */
const CURVE_STEPS = 16
/** Fix: straightness is STROKE-relative, not glyph-relative (see
 *  `resolveStraightMin`). A line counts as a straight stroke edge only when
 *  it is at least this many stroke widths long — Inter's 'a' has a ~150-unit
 *  flat cut at the end of its arch (~180-unit stroke): longer than 12% of
 *  the glyph (the old rule), so it hard-pinned a band, but well under 1.5×
 *  its own stroke's thickness, so it is a terminal, not a stroke edge. */
const STROKE_REL_MIN = 1.5
/** Below this many ink cells a stroke-width percentile is noise (a tiny
 *  synthetic shape in a test) — fall back to the old glyph-relative value. */
const STROKE_EST_MIN_INK = 20
/** Rounds stay round: a round's turn-region height follows its WIDTH (a
 *  semicircle is half as tall as it is wide). Shoulder rows scale by
 *  S^ROUND_COUPLING regardless of the height dial; 1 = fully round corners on
 *  an extended o, 0 = the old flat-sided racetrack. A taste constant — the
 *  lab exposes it. */
export const ROUND_COUPLING = 0.7
/** A terminal cut's two neighbours must be at least this parallel to each
 *  other … */
const TERMINAL_PARALLEL = 0.8
/** … and the cut itself must be at least this perpendicular to them. Below
 *  this it's a notch facet (X's crossing) or a diverging corner, not a
 *  drawn terminal (an a's top-stroke end, an S's cut terminals). */
const TERMINAL_PERP = 0.5
/** … and the cut itself must be MEANINGFULLY diagonal — neither axis
 *  component of its own tangent may be this close to 0. Rule 11 exists to
 *  keep a terminal's DRAWN ANGLE from rotating; a perfectly axis-aligned
 *  cut (dx = 0 or dy = 0 exactly) has no such angle to protect — it's a
 *  construction shelf (Inter's S has two, at its waist, cutting straight
 *  across from one edge of the ribbon to the other where the bowl turns),
 *  not an expressive terminal, and it satisfies the parallel/perpendicular
 *  test just as convincingly as a real one does. */
const TERMINAL_DIAGONAL_MIN = 0.05

/** What kind of ink a boundary segment is — the three kinds stretch
 *  differently (see `analyzeFlex`). */
const KIND_SHORT = 0     // a `lineTo` shorter than `straightMin`: cap, facet, terminal cut
const KIND_STRAIGHT = 1  // a `lineTo` at least `straightMin` long: a straight stroke edge
const KIND_CURVE = 2     // a flattened curve sample: a curved stroke edge

interface Seg {
  x0: number; y0: number; x1: number; y1: number
  kind: number
  /** Which subpath (moveTo-delimited contour) this segment belongs to —
   *  terminal-cut detection looks at a segment's neighbours WITHIN its own
   *  subpath, wrapping around at the contour's close. */
  subpath: number
  /** Set by `markTerminalCuts`: a lineTo/closePath segment — SHORT or
   *  STRAIGHT, any length — whose two flattened neighbours are near-parallel
   *  to each other and near-perpendicular to it — a drawn terminal cut (an
   *  a's top-stroke end, an S's cut terminals, a heavy face's flat spine
   *  cut), not a notch facet or a curve sample. A terminal cut is NEVER a
   *  stroke edge regardless of its own length: it stamps into the SOFT
   *  channel like a short line (see the stamping loop in `analyzeFlex`). */
  terminal: boolean
  /** Set alongside `terminal`: the cut's own tangent is MEANINGFULLY
   *  diagonal (neither axis component near 0 — `TERMINAL_DIAGONAL_MIN`).
   *  Gates rule 11's rigid-patch (protecting a terminal's drawn ANGLE) only —
   *  an axis-aligned cut has no angle to protect and must not create a rigid
   *  patch, but it is still `terminal` for the soft-channel stamping above. */
  terminalDiagonal: boolean
}

/** Flatten commands to line segments for tangent analysis. closePath emits the
 *  implicit closing segment — without it every subpath would leak a fake gap
 *  of "no ink" where the closing edge runs. Each segment is tagged
 *  with its ink kind (see `Seg`) so the ink it pins is classified at stamping. */
function flattenToSegments(commands: readonly PathCommand[], straightMin: number): Seg[] {
  const segs: Seg[] = []
  let px = 0, py = 0
  let sx = 0, sy = 0
  let subpath = -1
  const emit = (x1: number, y1: number, fromLine: boolean) => {
    if (x1 !== px || y1 !== py) {
      const kind = !fromLine ? KIND_CURVE : Math.hypot(x1 - px, y1 - py) >= straightMin ? KIND_STRAIGHT : KIND_SHORT
      segs.push({ x0: px, y0: py, x1, y1, kind, subpath, terminal: false, terminalDiagonal: false })
    }
    px = x1; py = y1
  }
  for (const c of commands) {
    const a = c.args
    switch (c.command) {
      case 'moveTo':
        subpath++
        px = a[0]!; py = a[1]!; sx = px; sy = py
        break
      case 'lineTo':
        emit(a[0]!, a[1]!, true)
        break
      case 'quadraticCurveTo': {
        const [cx, cy, x, y] = a as [number, number, number, number]
        const x0 = px, y0 = py
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t
          emit(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y, false)
        }
        break
      }
      case 'bezierCurveTo': {
        const [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]
        const x0 = px, y0 = py
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t
          emit(
            u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
            u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
            false,
          )
        }
        break
      }
      case 'closePath':
        emit(sx, sy, true)
        break
    }
  }
  return segs
}

/** Terminal-cut detection (rule 11): a lineTo/closePath segment — of EITHER
 *  `KIND_SHORT` or `KIND_STRAIGHT`, whatever its length — is a drawn
 *  TERMINAL CUT — not a notch facet (an X's crossing, whose neighbours
 *  diverge) and not a curve sample (excluded by kind) — when its two
 *  flattened neighbours, within its own subpath and wrapping around, are
 *  near-parallel to each other and the cut itself is near-perpendicular to
 *  them. A terminal cut is NEVER a stroke edge: length alone cannot tell a
 *  heavy face's flat spine cut (as long as the stroke is thick) from a
 *  hairline's short one, so classification drops the old `< straightMin`
 *  precondition and runs this same geometric test on every line segment.
 *
 *  A converging wedge tip (two long straight arms meeting at a shallow
 *  point, flattened flat) satisfies that same parallel/perpendicular test —
 *  the geometry of a hairpin turn can't be told apart from a genuine
 *  terminal by tangent alignment alone. What DOES tell them apart is scale,
 *  compared two different ways depending on the case:
 *    • a SHORT candidate (`KIND_SHORT`), OR any candidate whose neighbour is
 *      a flattened CURVE sample, keeps the original comparison — it counts
 *      only when at least as long as BOTH neighbours. This covers a short
 *      candidate with long straight arms either side (the classic wedge
 *      tip, correctly rejected: a Y-like arm's short flat end between its
 *      two long, near-parallel straight edges reads geometrically just like
 *      a genuine terminal, so it is protected by SCALE alone, the same way
 *      it always was — nothing about the candidate's OWN length changed).
 *      It also covers the common real-glyph case where the candidate is
 *      long but its neighbours are tiny curve samples as the outline curves
 *      away (Unbounded's 'S' has a 134-unit flat cut at its waist between
 *      two ~10-unit curve samples, easily longer than both — this is what
 *      dropping the `< straightMin` precondition exists to catch).
 *    • a STRAIGHT candidate (`KIND_STRAIGHT`) whose BOTH neighbours are
 *      ALSO straight lines (no curve, no short segment either) is checked
 *      the other way — it counts only when SHORTER than both neighbours.
 *      Here the neighbours are the stroke's own two long parallel sides
 *      continuing the run on either side of the cut (a heavy, hard-
 *      cornered face's flat spine cut, 200 units thick, between two
 *      860-unit diagonal sides); the candidate is the CROSS-cut, not the
 *      run. Without this flip, a plain stem's SIDE — long, with two short
 *      straight caps as neighbours — satisfies parallel/perpendicular
 *      against its own caps exactly as convincingly as a genuine cut does,
 *      and would wrongly stamp the stem's rigid edge into the soft channel;
 *      the flip rejects it (a side is never shorter than its own caps)
 *      while accepting the heavy cut (always the shortest of the three in a
 *      real stroke, since a stroke's run is invariably longer than it is
 *      thick). This branch only applies among segments that are ALL
 *      straight lines with no curve in sight — a hard-cornered synthetic
 *      shape or a genuinely blocky glyph — which is exactly the case the
 *      first branch's scale protection does not otherwise cover.
 *
 *  `terminalDiagonal` is set alongside `terminal` (not as a precondition of
 *  it): a perfectly axis-aligned cut (dx = 0 or dy = 0 exactly) still gets
 *  the soft-channel stamping below, but rule 11's rigid-patch — which
 *  protects a terminal's drawn ANGLE — has no angle to protect on an
 *  axis-aligned cut and stays gated on this flag alone. */
function markTerminalCuts(segs: Seg[]): void {
  const bySubpath = new Map<number, number[]>()
  segs.forEach((s, i) => {
    let idxs = bySubpath.get(s.subpath)
    if (!idxs) { idxs = []; bySubpath.set(s.subpath, idxs) }
    idxs.push(i)
  })
  const dir = (s: Seg): [number, number] | null => {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.hypot(dx, dy)
    return len > 0 ? [dx / len, dy / len] : null
  }
  const len = (s: Seg) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
  for (const idxs of bySubpath.values()) {
    const m = idxs.length
    if (m < 3) continue
    for (let k = 0; k < m; k++) {
      const i = idxs[k]!
      const s = segs[i]!
      if (s.kind === KIND_CURVE) continue
      const prev = segs[idxs[(k - 1 + m) % m]!]!
      const next = segs[idxs[(k + 1) % m]!]!
      const dPrev = dir(prev), dNext = dir(next), dCut = dir(s)
      if (!dPrev || !dNext || !dCut) continue
      const cutLen = len(s)
      const prevLen = len(prev), nextLen = len(next)
      if (s.kind === KIND_SHORT || prev.kind === KIND_CURVE || next.kind === KIND_CURVE) {
        if (cutLen < prevLen || cutLen < nextLen) continue
      } else if (cutLen >= prevLen || cutLen >= nextLen) continue
      const parallel = Math.abs(dPrev[0] * dNext[0] + dPrev[1] * dNext[1])
      const perp = Math.abs(dCut[0] * dPrev[0] + dCut[1] * dPrev[1])
      if (parallel > TERMINAL_PARALLEL && perp < TERMINAL_PERP) {
        s.terminal = true
        s.terminalDiagonal = Math.abs(dCut[0]) >= TERMINAL_DIAGONAL_MIN && Math.abs(dCut[1]) >= TERMINAL_DIAGONAL_MIN
      }
    }
  }
}

/**
 * Grid resolution for nearest-boundary tangent propagation. The min in the
 * flex formula runs over the ink's INTERIOR: a slice through the middle of a
 * stem crosses only the stem's horizontal caps, so boundary crossings alone
 * would call the stem flexible — what pins it is interior ink inheriting the
 * tangent of its NEAREST boundary (the stem's vertical side walls). Nearest-
 * boundary is computed with a two-pass chamfer distance transform over a
 * small per-glyph grid: deterministic, one cached pass, no sampled k-d tree
 * (which is where the original write-up's cusp/edge artifacts came from).
 */
const GRID = 96

/**
 * Straight-span uniformity — the straightness rule. A straight stroke can
 * only stay straight if the local stretch is CONSTANT across its span, so
 * every bin a diagonal straight segment covers is set to the span's mean
 * flex. Bins whose raw hard alignment is rigid (a true stem crossing the
 * span — a Y's stem under its arm) are exempt: they stay pinned and the arm
 * bends exactly once, at the junction.
 *
 * Spans that overlap are merged first and flattened together: two straight
 * strokes sharing bins (an X's arms chain across its whole width) can only
 * BOTH stay straight if they share one constant, and processing them one
 * after another would let the later span un-flatten the earlier one.
 * Spans are inclusive bin ranges; mutates `flex`.
 */
export function uniformSpans(flex: Float64Array, hard: Float64Array, spans: Array<[number, number]>, mask?: Uint8Array): void {
  const n = flex.length
  if (!spans.length) return
  const sorted = spans
    .map(([s0, s1]): [number, number] => [Math.max(0, Math.min(s0, s1)), Math.min(n - 1, Math.max(s0, s1))])
    .filter(([a, b]) => a <= b)
    .sort((p, q) => p[0] - q[0])
  const groups: Array<[number, number]> = []
  for (const [a, b] of sorted) {
    const last = groups[groups.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else groups.push([a, b])
  }
  for (const [a, b] of groups) {
    let sum = 0, cnt = 0
    for (let i = a; i <= b; i++) {
      if (hard[i]! < HARD_RIGID) continue
      sum += flex[i]!
      cnt++
    }
    if (!cnt) continue
    const m = sum / cnt
    for (let i = a; i <= b; i++) {
      if (hard[i]! < HARD_RIGID) continue
      flex[i] = m
      if (mask) mask[i] = 1
    }
  }
}

/** Mirror a profile about its centre: bin i and bin n−1−i both take their
 *  mean. Applied when the outline itself is mirror-symmetric, so the two
 *  halves' float noise (the o's flanks at 9.6e-5 vs 9.8e-5) and any one-sided
 *  span rounding cannot make a symmetric letter stretch asymmetrically. */
export function symmetrize(flex: Float64Array): void {
  const n = flex.length
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const m = (flex[i]! + flex[j]!) / 2
    flex[i] = m
    flex[j] = m
  }
}

/** Mirror a 0/1 mask the same way (`symmetrize`): a bin is flagged when
 *  either it or its mirror twin is — a symmetric outline's straight spans
 *  are symmetric, so this only tidies one-sided bin rounding. */
function symmetrizeMask(mask: Uint8Array): void {
  const n = mask.length
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const v = mask[i]! | mask[j]!
    mask[i] = v
    mask[j] = v
  }
}

/** Curves stay smooth: flex may not climb away from a rigid plateau faster
 *  than one stroke width allows, so an arch eases into a flank instead of
 *  cornering (a 9-slice keeps the drawn radius verbatim on a taller shape —
 *  a designer's tall o has a LARGER radius). Only lowers values, only on
 *  ink bins; empty space stays fully free. `rampBins` = stroke width in bins. */
export function smoothProfile(flex: Float64Array, ink: Float64Array | undefined, rampBins: number): void {
  if (rampBins < 1) return
  const step = 1 / rampBins
  const n = flex.length
  for (let i = 1; i < n; i++) {
    if (ink && !(ink[i]! > 0)) continue
    flex[i] = Math.min(flex[i]!, flex[i - 1]! + step)
  }
  for (let i = n - 2; i >= 0; i--) {
    if (ink && !(ink[i]! > 0)) continue
    flex[i] = Math.min(flex[i]!, flex[i + 1]! + step)
  }
}

/** Fraction of flattened points that must have a mirrored twin … */
const SYMMETRY_MIN_FRACTION = 0.95
/** … within this fraction of the bbox's mirrored dimension. */
const SYMMETRY_TOLERANCE = 0.02

/** Is the flattened outline mirror-symmetric about the bbox's centre line
 *  perpendicular to `axis`? (`'x'` = the vertical centre line, for the X
 *  profile.) Hash-grid nearest search on the mirrored point set. */
function isMirrorSymmetric(pts: Float64Array, axis: 'x' | 'y', bbox: VtBBox): boolean {
  const count = pts.length >> 1
  if (count < 3) return false
  const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY
  const tol = SYMMETRY_TOLERANCE * (axis === 'x' ? w : h)
  if (!(tol > 0)) return false
  const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2
  const cell = tol
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const grid = new Map<string, number[]>()
  for (let i = 0; i < count; i++) {
    const x = pts[2 * i]!, y = pts[2 * i + 1]!
    const k = key(x, y)
    let bucket = grid.get(k)
    if (!bucket) { bucket = []; grid.set(k, bucket) }
    bucket.push(i)
  }
  const tol2 = tol * tol
  let matched = 0
  for (let i = 0; i < count; i++) {
    const x = pts[2 * i]!, y = pts[2 * i + 1]!
    const mx = axis === 'x' ? 2 * cx - x : x
    const my = axis === 'y' ? 2 * cy - y : y
    const gx = Math.floor(mx / cell), gy = Math.floor(my / cell)
    let hit = false
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`)
        if (!bucket) continue
        for (const j of bucket) {
          const ex = pts[2 * j]! - mx, ey = pts[2 * j + 1]! - my
          if (ex * ex + ey * ey <= tol2) { hit = true; break }
        }
      }
    }
    if (hit) matched++
  }
  return matched / count >= SYMMETRY_MIN_FRACTION
}

/** The per-cell analysis grid, as `analyzeFlex` builds it before its
 *  per-column / per-row aggregation. Internal shape — `analyzeGrid` is the
 *  public projection. */
interface AnalysisGridInternal {
  cw: number
  ch: number
  dist: Float64Array
  ax: Float64Array
  ay: Float64Array
  kind: Uint8Array
  ink: Uint8Array
  termFlag: Uint8Array
  termReach: Float64Array
  termDiag: Uint8Array
  termRigid: Uint8Array
  /** Cells the diagonal-terminal patch pinned to `SOFT_TERMINAL_PIN` rather
   *  than full rigidity (`termHard` false) — see the patch below. Aggregated
   *  per-bin in `analyzeFlex` as `FlexProfile.softTerm` so `bellWeights` can
   *  exclude these bins from bell/run growth-sharing even though their
   *  reported `flex` reads well above `HARD_RIGID` (by design — a terminal's
   *  row must not hard-pin to exactly 0, but must also not be treated as an
   *  ordinary free bin that would amplify under a big free run's bell,
   *  which is what caused the terminal-angle regression this flag fixes). */
  termSoft: Uint8Array
  small: Uint8Array
}

/** Build the GRID×GRID analysis grid over `bbox` from flattened, terminal-
 *  marked segments: nearest-boundary tangent alignment per cell (chamfer
 *  propagated), the ink mask, the rule-11 terminal patch and the small-
 *  feature pass. Extracted verbatim from `analyzeFlex` so the 2D-field
 *  spike (`stretch2d.ts`) can read the raw cells via `analyzeGrid`; the
 *  aggregation that turns this into flex profiles stays in `analyzeFlex`. */
function buildGrid(segs: Seg[], bbox: VtBBox, w: number, h: number, smallFeature: number, shapeRules: boolean): AnalysisGridInternal {
  const cw = w / GRID
  const ch = h / GRID
  const N = GRID * GRID
  const dist = new Float64Array(N).fill(Infinity)
  // |tangent·x̂| and |tangent·ŷ| of the nearest boundary, propagated together
  // with the distance (the nearest boundary is one point; both alignments
  // come from its one tangent) — and which KIND of boundary it is: a straight
  // stroke edge, a curved stroke edge, or a short line (cap / facet / cut).
  const ax = new Float64Array(N).fill(1)
  const ay = new Float64Array(N).fill(1)
  const kind = new Uint8Array(N)
  // Terminal-cut carry: whether the nearest boundary is a terminal cut, that
  // cut's own length (its "reach"), and whether the cut is meaningfully
  // diagonal — propagated alongside (dist, ax, ay, kind) through the chamfer
  // exactly like they are, since the nearest boundary is one point and all
  // of them come from it.
  const termFlag = new Uint8Array(N)
  const termReach = new Float64Array(N)
  const termDiag = new Uint8Array(N)
  // Fix 1 (continued): whether the terminal's OWN pre-override classification
  // was a genuine stroke-length straight line (`KIND_STRAIGHT`, under the
  // stroke-relative threshold `resolveStraightMin` resolved) rather than a
  // short cap/facet. Gates the diagonal-terminal rigid patch below: a
  // terminal long enough to be a stroke edge in its own right (a heavy
  // face's flat spine cut) still gets its drawn angle protected outright, but
  // a terminal that is SHORT relative to its own stroke (Inter's 'a' arch
  // terminal, ~150 units against a ~180-unit-thick arch) must not hard-pin
  // the ink around it to 0 — it is governed by the ordinary soft channel
  // instead, same as any other short line.
  const termHard = new Uint8Array(N)
  // Spike bookkeeping (`analyzeGrid`): which ink cells rule 11 made rigid
  // as a terminal patch, and which the small-feature pass made rigid. Written
  // alongside the existing arrays; nothing below reads them.
  const termRigid = new Uint8Array(N)
  const termSoft = new Uint8Array(N)
  const small = new Uint8Array(N)
  const idx = (c: number, r: number) => r * GRID + c

  // Stamp boundary cells with exact segment tangents. Where two segments of
  // the same kind meet in one cell (corners), keep the more rigid alignment
  // per axis — the min in the flex formula makes conservative-rigid the
  // faithful tie-break. Across kinds a stroke edge (straight, then curved)
  // always wins over a short line: a notch facet sharing a corner cell with
  // an arm must not turn that stroke cell rigid. A TERMINAL cut stamps as if
  // it were `KIND_SHORT` regardless of its own length — it is never a stroke
  // edge (see `markTerminalCuts`) — so the corner tie-break and the soft/
  // stroke/hard channel split downstream both see it as a cap/facet/cut, not
  // a stem or crossbar edge.
  for (const s of segs) {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0
    const len = Math.hypot(dx, dy)
    if (len === 0) continue
    const tx = Math.abs(dx) / len
    const ty = Math.abs(dy) / len
    // Terminal softening is rule 11 — a shape-integrity rule like the other
    // three, so gated the same way: off when `shapeRules` is off (the lab's,
    // and the tests', A/B control), leaving the old single-channel model's
    // classification untouched.
    const effKind = shapeRules && s.terminal ? KIND_SHORT : s.kind
    const steps = Math.max(1, Math.ceil(len / (Math.min(cw, ch) * 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const c = Math.max(0, Math.min(GRID - 1, Math.floor((s.x0 + dx * t - bbox.minX) / cw)))
      const r = Math.max(0, Math.min(GRID - 1, Math.floor((s.y0 + dy * t - bbox.minY) / ch)))
      const j = idx(c, r)
      const rank = effKind === KIND_STRAIGHT ? 2 : effKind === KIND_CURVE ? 1 : 0
      const have = kind[j] === KIND_STRAIGHT ? 2 : kind[j] === KIND_CURVE ? 1 : 0
      if (dist[j]! > 0) {
        dist[j] = 0; ax[j] = tx; ay[j] = ty; kind[j] = effKind
        termFlag[j] = s.terminal ? 1 : 0; termReach[j] = s.terminal ? len : 0; termDiag[j] = s.terminalDiagonal ? 1 : 0
        termHard[j] = s.terminal && s.kind === KIND_STRAIGHT ? 1 : 0
      } else if (rank > have) {
        ax[j] = tx; ay[j] = ty; kind[j] = effKind
        termFlag[j] = s.terminal ? 1 : 0; termReach[j] = s.terminal ? len : 0; termDiag[j] = s.terminalDiagonal ? 1 : 0
        termHard[j] = s.terminal && s.kind === KIND_STRAIGHT ? 1 : 0
      } else if (rank === have) {
        ax[j] = Math.min(ax[j]!, tx); ay[j] = Math.min(ay[j]!, ty)
      }
    }
  }

  // Two-pass chamfer: propagate (distance, tangent, kind, terminal reach)
  // from each cell's already-visited neighbours. Step costs are in FONT
  // UNITS, not grid steps — the grid is GRID×GRID over a bbox that is
  // usually far from square (a stem is ~100×700), and unit-step costs would
  // let a stem's caps out-compete its side walls for half the interior,
  // mislabelling it flexible in Y.
  const costH = cw
  const costV = ch
  const costD = Math.hypot(cw, ch)
  const relax = (j: number, n: number, cost: number) => {
    const d = dist[n]! + cost
    if (d < dist[j]!) {
      dist[j] = d; ax[j] = ax[n]!; ay[j] = ay[n]!; kind[j] = kind[n]!
      termFlag[j] = termFlag[n]!; termReach[j] = termReach[n]!; termDiag[j] = termDiag[n]!
      termHard[j] = termHard[n]!
    }
  }
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const j = idx(c, r)
      if (c > 0) relax(j, idx(c - 1, r), costH)
      if (r > 0) relax(j, idx(c, r - 1), costV)
      if (c > 0 && r > 0) relax(j, idx(c - 1, r - 1), costD)
      if (c < GRID - 1 && r > 0) relax(j, idx(c + 1, r - 1), costD)
    }
  }
  for (let r = GRID - 1; r >= 0; r--) {
    for (let c = GRID - 1; c >= 0; c--) {
      const j = idx(c, r)
      if (c < GRID - 1) relax(j, idx(c + 1, r), costH)
      if (r < GRID - 1) relax(j, idx(c, r + 1), costV)
      if (c < GRID - 1 && r < GRID - 1) relax(j, idx(c + 1, r + 1), costD)
      if (c > 0 && r < GRID - 1) relax(j, idx(c - 1, r + 1), costD)
    }
  }

  // Ink mask by even-odd scanline per row. Even-odd matches nonzero for
  // ordinary glyphs (outer contour + counters); self-overlapping outlines are
  // the known artifact class the lab watches for.
  const ink = new Uint8Array(N)
  for (let r = 0; r < GRID; r++) {
    const yLine = bbox.minY + (r + 0.5) * ch
    const xs: number[] = []
    for (const s of segs) {
      if ((s.y0 <= yLine && s.y1 > yLine) || (s.y1 <= yLine && s.y0 > yLine)) {
        xs.push(s.x0 + ((yLine - s.y0) / (s.y1 - s.y0)) * (s.x1 - s.x0))
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let c0 = Math.ceil((xs[i]! - bbox.minX) / cw - 0.5)
      let c1 = Math.floor((xs[i + 1]! - bbox.minX) / cw - 0.5)
      c0 = Math.max(0, c0)
      c1 = Math.min(GRID - 1, c1)
      for (let c = c0; c <= c1; c++) ink[idx(c, r)] = 1
    }
  }

  // Terminal cuts keep their angle (rule 11): every ink cell whose nearest
  // boundary is a DIAGONAL terminal cut, within that cut's own length, is
  // rigid on BOTH axes and counts as hard ink (straight) so it enters the
  // hard channel — before the column aggregation below sees it. Gated on
  // `termDiag`, not just `termFlag`: an axis-aligned cut (a construction
  // shelf, or a heavy face's flat spine cut) has no drawn angle to protect,
  // so it stays in the soft channel the stamping loop above already put it
  // in — governed by the stroke's other ink, never hard-pinned. A shape-
  // integrity rule like the other three, so gated the same way: off when
  // `shapeRules` is off (the lab's, and the tests', A/B control).
  //
  // Fix 1 (continued): the patch's STRENGTH is also gated on `termHard` — the
  // cut's OWN length relative to the stroke-relative threshold. A terminal
  // long enough to be a stroke edge in its own right (a heavy face's flat
  // spine cut) gets the outright rigid protection (ax = ay = 0) as before.
  // A terminal that is SHORT relative to its own stroke (Inter's 'a' arch
  // terminal, ~150 units against a ~180-unit-thick arch) is promoted to the
  // hard/stroke MIN channel too (`kind = KIND_STRAIGHT`, so it isn't
  // entirely diluted into the mean by unrelated ink sharing its row/column —
  // measured: 30°+ drift with no promotion at all) but at its OWN,
  // unmodified alignment (`ax`/`ay` already hold the cut's real tangent from
  // the stamping pass, untouched here) rather than artificial full rigidity
  // — without this gate, the patch's radius (`termReach`, the cut's own
  // length) froze several rows to EXACTLY 0 regardless of how thin the
  // stroke actually is, which is the bug this fix corrects.
  if (shapeRules) {
    for (let j = 0; j < N; j++) {
      if (!ink[j]) continue
      if (termFlag[j] && termDiag[j] && dist[j]! <= termReach[j]! + 1e-9) {
        if (termHard[j]) { ax[j] = 0; ay[j] = 0; termRigid[j] = 1 } else { ax[j] = SOFT_TERMINAL_PIN; ay[j] = SOFT_TERMINAL_PIN; termSoft[j] = 1 }
        kind[j] = KIND_STRAIGHT
      }
    }
  }

  if (smallFeature > 0) {
    const comp = new Int32Array(N).fill(-1)
    const stack: number[] = []
    for (let seed = 0; seed < N; seed++) {
      if (!ink[seed] || comp[seed] !== -1) continue
      let c0 = GRID, c1 = -1, r0 = GRID, r1 = -1
      const cells: number[] = []
      comp[seed] = seed
      stack.push(seed)
      while (stack.length) {
        const j = stack.pop()!
        cells.push(j)
        const c = j % GRID, r = (j / GRID) | 0
        if (c < c0) c0 = c
        if (c > c1) c1 = c
        if (r < r0) r0 = r
        if (r > r1) r1 = r
        if (c > 0 && ink[j - 1] && comp[j - 1] === -1) { comp[j - 1] = seed; stack.push(j - 1) }
        if (c < GRID - 1 && ink[j + 1] && comp[j + 1] === -1) { comp[j + 1] = seed; stack.push(j + 1) }
        if (r > 0 && ink[j - GRID] && comp[j - GRID] === -1) { comp[j - GRID] = seed; stack.push(j - GRID) }
        if (r < GRID - 1 && ink[j + GRID] && comp[j + GRID] === -1) { comp[j + GRID] = seed; stack.push(j + GRID) }
      }
      // A feature is small when BOTH the grid says so and it is genuinely a
      // fraction of the glyph — measured in font units, not cells, because
      // the grid is anisotropic over non-square bboxes. A rigid dot counts
      // as HARD ink: it pins its slices like a stem would.
      if (Math.max((c1 - c0 + 1) * cw, (r1 - r0 + 1) * ch) < smallFeature) {
        for (const cell of cells) { ax[cell] = 0; ay[cell] = 0; kind[cell] = KIND_STRAIGHT; small[cell] = 1 }
      }
    }
  }

  return { cw, ch, dist, ax, ay, kind, ink, termFlag, termReach, termDiag, termRigid, termSoft, small }
}

/** Raw per-cell analysis data for one glyph — the 2D-field spike's input.
 *  `size`×`size` cells over `bbox` (column-major within a row: index
 *  `r * size + c`, row 0 at `bbox.minY`), cell size `cw`×`ch` in font units.
 *  `ax`/`ay` = |tangent·x̂| / |tangent·ŷ| of the cell's nearest boundary;
 *  `ink` = inside the outline (even-odd); `straight` = the nearest boundary
 *  is a straight stroke edge (or the cell was made hard ink by the terminal
 *  patch / small-feature pass); `terminal` = an ink cell rule 11 made rigid
 *  as a diagonal terminal patch (axis-aligned cuts are NOT flagged — they
 *  have no angle to protect, exactly as in `analyzeFlex`); `small` = an ink
 *  cell of a small-feature component. Same options as `analyzeFlex`
 *  (`smallFeature`, `straightMin`, `shapeRules`); `bins`/`k` are ignored. */
export interface AnalysisGrid {
  size: number
  cw: number
  ch: number
  ink: Uint8Array
  ax: Float64Array
  ay: Float64Array
  straight: Uint8Array
  terminal: Uint8Array
  small: Uint8Array
}

/** Stroke width estimate from an unbiased first chamfer pass (Fix 1): 2× the
 *  90th percentile of nearest-boundary distance over ink cells, in font
 *  units. Most of a stem's or an arch's interior sits close to its own
 *  half-thickness away from a side wall, so the upper percentile of that
 *  distribution reads out close to the true half-thickness regardless of
 *  terminals/caps/corners pulling the low end down — doubled back into a
 *  full stroke width. Falls back to `fallback` (the old 12%-of-glyph value)
 *  when there are too few ink cells for a stable percentile. */
function estimateStrokeWidth(dist: Float64Array, ink: Uint8Array, fallback: number): number {
  let n = 0
  for (let j = 0; j < ink.length; j++) if (ink[j]) n++
  if (n < STROKE_EST_MIN_INK) return fallback
  const vals = new Float64Array(n)
  let k = 0
  for (let j = 0; j < ink.length; j++) if (ink[j]) vals[k++] = dist[j]!
  vals.sort((a, b) => a - b)
  const idx = 0.9 * (n - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  const p90 = vals[lo]! + (vals[hi]! - vals[lo]!) * (idx - lo)
  return 2 * p90
}

/** Resolve the STROKE-RELATIVE straightMin (Fix 1). `straight` classification
 *  happens at flatten time, before the chamfer distance field that the
 *  stroke-width estimate reads exists — so this runs the stamp + chamfer
 *  TWICE: once with every lineTo classified soft (`straightMin: Infinity`,
 *  so the distance field isn't biased by a straightMin guess), to estimate
 *  stroke width from; then the real threshold is `1.5×` that estimate,
 *  floored by an explicit caller value (`straightMinOpt` is an
 *  override/floor, never lowered by the estimate). One extra 96×96 pass —
 *  fine; the real (second) pass, with the resolved threshold, is what
 *  `analyzeFlex`/`analyzeGrid` actually build their output from. */
function resolveStraightMin(
  commands: readonly PathCommand[],
  bbox: VtBBox,
  w: number,
  h: number,
  smallFeature: number,
  shapeRules: boolean,
  straightMinOpt: number | undefined,
): number {
  const floor = straightMinOpt ?? 0
  const fallback = STRAIGHT_MIN_EM * Math.max(w, h)
  const softSegs = flattenToSegments(commands, Infinity)
  if (!softSegs.length) return Math.max(fallback, floor)
  markTerminalCuts(softSegs)
  const grid = buildGrid(softSegs, bbox, w, h, smallFeature, shapeRules)
  const strokeW = estimateStrokeWidth(grid.dist, grid.ink, fallback)
  return Math.max(STROKE_REL_MIN * strokeW, floor)
}

export function analyzeGrid(commands: readonly PathCommand[], bbox: VtBBox, opts: FlexOptions = {}): AnalysisGrid {
  const N = GRID * GRID
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const empty = (): AnalysisGrid => ({
    size: GRID, cw: w > 0 ? w / GRID : 1, ch: h > 0 ? h / GRID : 1,
    ink: new Uint8Array(N), ax: new Float64Array(N).fill(1), ay: new Float64Array(N).fill(1),
    straight: new Uint8Array(N), terminal: new Uint8Array(N), small: new Uint8Array(N),
  })
  if (w <= 0 || h <= 0 || !commands.length) return empty()
  const smallFeature = opts.smallFeature ?? 0
  const shapeRules = opts.shapeRules ?? true
  const straightMin = resolveStraightMin(commands, bbox, w, h, smallFeature, shapeRules, opts.straightMin)
  const segs = flattenToSegments(commands, straightMin)
  if (!segs.length) return empty()
  markTerminalCuts(segs)
  const g = buildGrid(segs, bbox, w, h, smallFeature, shapeRules)
  const straight = new Uint8Array(N)
  for (let j = 0; j < N; j++) if (g.kind[j] === KIND_STRAIGHT) straight[j] = 1
  return { size: GRID, cw: g.cw, ch: g.ch, ink: g.ink, ax: g.ax, ay: g.ay, straight, terminal: g.termRigid, small: g.small }
}

export function analyzeFlex(
  commands: readonly PathCommand[],
  bbox: VtBBox,
  opts: FlexOptions = {},
): GlyphFlex {
  const bins = Math.max(4, Math.round(opts.bins ?? DEFAULT_BINS))
  const k = Math.max(0, opts.k ?? DEFAULT_K)
  const smallFeature = opts.smallFeature ?? 0
  const shapeRules = opts.shapeRules ?? true
  // Fix: k is INERT under the shape rules. With the hard/soft split, a
  // straight stroke is already pinned by min regardless of exponent — k's
  // only remaining job is to shape how a CURVE flows between rigid
  // plateaus. But an all-curve glyph (an 'S', an 'a') has almost no straight
  // ink to anchor it, so raising k pushes nearly every one of its rows below
  // the rigid threshold, leaving the x-height band with no non-rigid bin
  // left to reach its zone target (see `bandedBinWidths`). k keeps its old
  // meaning only for the pre-shape-rules model (`shapeRules: false`, the
  // lab's A/B control); under shape rules the exponent is fixed at 1 and
  // tangent alignment alone (via the bell) decides how a curve stretches.
  const kEff = shapeRules ? 1 : k
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const flexX = new Float64Array(bins).fill(1)
  const flexY = new Float64Array(bins).fill(1)
  const out: GlyphFlex = {
    x: { start: bbox.minX, binSize: w > 0 ? w / bins : 1, flex: flexX },
    y: { start: bbox.minY, binSize: h > 0 ? h / bins : 1, flex: flexY },
  }
  if (w <= 0 || h <= 0 || !commands.length) return out

  const straightMin = resolveStraightMin(commands, bbox, w, h, smallFeature, shapeRules, opts.straightMin)
  const segs = flattenToSegments(commands, straightMin)
  if (!segs.length) return out
  markTerminalCuts(segs)
  const grid = buildGrid(segs, bbox, w, h, smallFeature, shapeRules)
  const { ax, ay, kind, ink, termSoft } = grid
  const N = GRID * GRID
  const idx = (c: number, r: number) => r * GRID + c

  // Per-column / per-row aggregation over INK cells only. Three kinds of ink
  // pin a slice differently:
  //   • `hard`   = min over cells pinned by STRAIGHT stroke edges. A stem pins
  //                its slice outright, and only hard-rigid bins are exempt
  //                from the straightness rule below.
  //   • `stroke` = min over cells pinned by straight OR curved stroke edges.
  //                A curve is a stroke too: the o's flank is near-vertical ink
  //                made of curve samples, and any slice through it thickens
  //                under X stretch exactly like a stem's would — so it takes
  //                the min, not a mean (a column mean through the flank also
  //                crosses the shoulders and arches and reads 0.3, and the
  //                flank grows 37% at S = 2).
  //   • `soft`   = mean over ALL of the slice's ink. Short lines — caps,
  //                notch facets, terminal cuts — are not strokes: they mark a
  //                stroke's END, and an end can lengthen along the stroke.
  //                A short line therefore pins a slice only in proportion to
  //                the ink it owns there: an S terminal's cut owns a third of
  //                its rows (→ 0.5, flows) while an l's cap owns all of its
  //                (→ 0, pinned); an X's notch facets can no longer freeze
  //                the crossing.
  // Slice value = min(stroke, soft). `colMin` is the original single-channel
  // min, kept for the shape-rules-off control. colInk/rowInk count ink cells
  // per column/row in the same pass, so bins can report how much of their
  // span is actually ink (vs. counters/gaps).
  const colMin = new Float64Array(GRID).fill(1)
  const rowMin = new Float64Array(GRID).fill(1)
  const colHard = new Float64Array(GRID).fill(1)
  const rowHard = new Float64Array(GRID).fill(1)
  const colStroke = new Float64Array(GRID).fill(1)
  const rowStroke = new Float64Array(GRID).fill(1)
  const colSum = new Float64Array(GRID)
  const rowSum = new Float64Array(GRID)
  const colInk = new Float64Array(GRID)
  const rowInk = new Float64Array(GRID)
  // Fix 1 (continued): which columns/rows contain at least one cell the
  // diagonal-terminal patch soft-pinned (`termSoft`, see `buildGrid`) —
  // aggregated into per-bin `softTermX`/`softTermY` below so `bellWeights`
  // can exclude these bins from growth-sharing (see that flag's own doc
  // comment on `AnalysisGridInternal.termSoft` for why).
  const colSoft = new Uint8Array(GRID)
  const rowSoft = new Uint8Array(GRID)
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const j = idx(c, r)
      if (!ink[j]) continue
      colInk[c]!++
      rowInk[r]!++
      const vx = ax[j]!, vy = ay[j]!
      colSum[c]! += vx
      rowSum[r]! += vy
      if (termSoft[j]) { colSoft[c] = 1; rowSoft[r] = 1 }
      if (vx < colMin[c]!) colMin[c] = vx
      if (vy < rowMin[r]!) rowMin[r] = vy
      if (kind[j] === KIND_SHORT) continue
      if (vx < colStroke[c]!) colStroke[c] = vx
      if (vy < rowStroke[r]!) rowStroke[r] = vy
      if (kind[j] !== KIND_STRAIGHT) continue
      if (vx < colHard[c]!) colHard[c] = vx
      if (vy < rowHard[r]!) rowHard[r] = vy
    }
  }
  const inkX = new Float64Array(bins)
  const inkY = new Float64Array(bins)
  const hardX = new Float64Array(bins).fill(1)
  const hardY = new Float64Array(bins).fill(1)
  // Turn bins (rule 10): pinning ink is curved and only PARTIALLY aligned —
  // no straight stem pins the bin (hard ≥ HARD_RIGID) but it isn't free
  // either (soft strictly between HARD_RIGID and FULL_FLEX). A round's
  // shoulder, not its apex (fully aligned, soft ≈ 0) or its flank (fully
  // free, soft ≈ 1).
  const turnX = new Uint8Array(bins)
  const turnY = new Uint8Array(bins)
  const softTermX = new Uint8Array(bins)
  const softTermY = new Uint8Array(bins)
  const cellsPerBin = GRID / bins
  for (let b = 0; b < bins; b++) {
    let mx = 1, my = 1          // single-channel min (control)
    let hx = 1, hy = 1          // hard: min over the bin's columns
    let kx = 1, ky = 1          // stroke: min over the bin's columns
    let sx = 1, sy = 1          // soft: min over the bin's column MEANS
    let ix = 0, iy = 0
    let softX = 0, softY = 0
    const g0 = Math.floor(b * cellsPerBin)
    const g1 = Math.min(GRID - 1, Math.ceil((b + 1) * cellsPerBin) - 1)
    for (let g = g0; g <= g1; g++) {
      if (colMin[g]! < mx) mx = colMin[g]!
      if (rowMin[g]! < my) my = rowMin[g]!
      if (colHard[g]! < hx) hx = colHard[g]!
      if (rowHard[g]! < hy) hy = rowHard[g]!
      if (colStroke[g]! < kx) kx = colStroke[g]!
      if (rowStroke[g]! < ky) ky = rowStroke[g]!
      const cs = colInk[g]! ? colSum[g]! / colInk[g]! : 1
      const rs = rowInk[g]! ? rowSum[g]! / rowInk[g]! : 1
      if (cs < sx) sx = cs
      if (rs < sy) sy = rs
      if (colInk[g]! / GRID > ix) ix = colInk[g]! / GRID
      if (rowInk[g]! / GRID > iy) iy = rowInk[g]! / GRID
      if (colSoft[g]) softX = 1
      if (rowSoft[g]) softY = 1
    }
    softTermX[b] = softX
    softTermY[b] = softY
    hardX[b] = hx
    hardY[b] = hy
    // The "no straight stem pins it" half reads the HARD channel (straight
    // ink only — a pure-curve glyph like an o never lowers it, so this
    // correctly never excludes curve ink). The "partially aligned" half
    // must read the STROKE channel (curve ink's own min, kx/ky) rather than
    // the mean-based `soft` channel: soft averages a row's cells, so an
    // apex row (one cell dead-on, its neighbours a little off) can average
    // above HARD_RIGID even though the row's real pinning — the min any
    // single cell forces — is near zero. Using stroke keeps the apex
    // (near-0) and the flank (near-1) both OUT, leaving only the shoulder.
    turnX[b] = hx >= HARD_RIGID && kx > HARD_RIGID && kx < FULL_FLEX ? 1 : 0
    turnY[b] = hy >= HARD_RIGID && ky > HARD_RIGID && ky < FULL_FLEX ? 1 : 0
    const vx = shapeRules ? Math.min(kx, sx) : mx
    const vy = shapeRules ? Math.min(ky, sy) : my
    flexX[b] = Math.pow(vx, kEff)
    flexY[b] = Math.pow(vy, kEff)
    inkX[b] = ix
    inkY[b] = iy
  }
  // Attached here (not at the end) so `stemWidthOf` below — which reads
  // `profile.ink` — sees real ink occupancy rather than undefined.
  out.x.ink = inkX
  out.y.ink = inkY
  out.x.turn = turnX
  out.y.turn = turnY
  out.x.softTerm = softTermX
  out.y.softTerm = softTermY

  if (shapeRules) {
    // Curves stay smooth: ease the freshly-powed profile away from its rigid
    // plateaus (the stem/flank ink) by at most one stroke width per bin,
    // BEFORE the straight-span pass — so e.g. a Y's arm is re-flattened over
    // its whole span and only bends once, at the junction it already bends
    // at, instead of at the smoothing ramp too.
    const rampX = stemWidthOf(out.x) / out.x.binSize
    if (rampX > 0) smoothProfile(flexX, inkX, rampX)
    const rampY = stemWidthOf(out.y) / out.y.binSize
    if (rampY > 0) smoothProfile(flexY, inkY, rampY)

    // Straight-span uniformity: every diagonal straight stroke stretches
    // uniformly along its whole span, stems inside it exempt.
    const spansX: Array<[number, number]> = []
    const spansY: Array<[number, number]> = []
    const bwX = out.x.binSize, bwY = out.y.binSize
    const binRange = (lo: number, hi: number, start: number, size: number): [number, number] => [
      Math.max(0, Math.min(bins - 1, Math.floor((lo - start) / size))),
      Math.max(0, Math.min(bins - 1, Math.ceil((hi - start) / size) - 1)),
    ]
    for (const s of segs) {
      // Fix 1 (continued, kept — NOT part of the freeness revert): a diagonal
      // TERMINAL too short to earn rule 11's outright rigid patch
      // (`termHard` false in `buildGrid`) is pinned only to `SOFT_TERMINAL_PIN`
      // there, on both axes independently — nothing else keeps the ROWS it
      // touches growing at the SAME rate as each other. Without this, Inter's
      // 'a' arch terminal (whose own ink occupancy is too low to qualify as
      // ink-rigid — a diagonal cut, not a horizontal stroke) still rotates
      // under stretch (measured ~29° at Height 2.41, budget 8°). Folding it
      // into a `uniformSpans` candidate — the same LOCAL UNIFORMITY a genuine
      // diagonal stroke gets — keeps every row/column it touches growing by
      // one shared factor, so the segment's own two endpoints don't drift
      // apart. `uniformSpans` itself still exempts any bin the diagonal patch
      // (or a stem) holds genuinely rigid.
      if (s.kind !== KIND_STRAIGHT && !(s.terminal && s.terminalDiagonal)) continue
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0
      const len = Math.hypot(dx, dy)
      if (len === 0) continue
      const tx = Math.abs(dx) / len, ty = Math.abs(dy) / len
      if (tx > DIAG_LO && tx < DIAG_HI) spansX.push(binRange(Math.min(s.x0, s.x1), Math.max(s.x0, s.x1), bbox.minX, bwX))
      if (ty > DIAG_LO && ty < DIAG_HI) spansY.push(binRange(Math.min(s.y0, s.y1), Math.max(s.y0, s.y1), bbox.minY, bwY))
    }
    const longestFirst = (a: [number, number], b: [number, number]) => (b[1] - b[0]) - (a[1] - a[0])
    spansX.sort(longestFirst)
    spansY.sort(longestFirst)
    const uniformX = new Uint8Array(bins)
    const uniformY = new Uint8Array(bins)
    uniformSpans(flexX, hardX, spansX, uniformX)
    uniformSpans(flexY, hardY, spansY, uniformY)
    out.x.uniform = uniformX
    out.y.uniform = uniformY

    // Symmetry: a mirror-symmetric outline gets a mirror-symmetric profile.
    const pts = new Float64Array(segs.length * 2)
    for (let i = 0; i < segs.length; i++) { pts[2 * i] = segs[i]!.x0; pts[2 * i + 1] = segs[i]!.y0 }
    if (isMirrorSymmetric(pts, 'x', bbox)) { symmetrize(flexX); symmetrize(hardX); symmetrizeMask(uniformX) }
    if (isMirrorSymmetric(pts, 'y', bbox)) { symmetrize(flexY); symmetrize(hardY); symmetrizeMask(uniformY) }
  }

  return out
}

/** Stem width estimate from a profile: the longest contiguous run of rigid,
 *  ink-bearing bins, in font units. 0 when the glyph has no rigid run (a
 *  hairline script, an S whose only verticals are short terminals). */
export function stemWidthOf(profile: FlexProfile): number {
  const { flex, ink, binSize } = profile
  let best = 0, run = 0
  for (let i = 0; i < flex.length; i++) {
    const isInk = ink ? ink[i]! > 0 : true
    const rigid = flex[i]! < 0.05 && isInk
    run = rigid ? run + 1 : 0
    if (run > best) best = run
  }
  return best * binSize
}

export interface Remap {
  src: Float64Array
  dst: Float64Array
  /** Derivative (d dst / d src) at each breakpoint, one per entry in `src`/
   *  `dst`. Makes the map C1: a monotone-cubic (Fritsch–Carlson / PCHIP)
   *  Hermite spline through the breakpoints instead of a piecewise-linear
   *  one. Piecewise-linear interpolation of the cumulative widths has a
   *  slope that jumps at every bin edge, and each jump is a kink in
   *  curvature wherever a curve crosses that edge — visible as extra
   *  inflections (a convex 'o' picks up sign changes it never had). The
   *  harmonic-mean slope choice (Fritsch–Butland, uniform spacing) is what
   *  keeps this monotone: unlike a plain centred-difference (Catmull-Rom)
   *  slope, it cannot overshoot past a neighbouring breakpoint, so the
   *  remap never folds back on itself. */
  slope: Float64Array
}

/** Hermite evaluator shared by `buildRemap` (fixed-point shift) and
 *  `remapValue`. `v` must already be known to fall in [src[lo], src[lo+1]]
 *  (or exactly at `src[lo]`, `h = 0` uniform bins). */
function hermiteAt(src: Float64Array, dst: Float64Array, slope: Float64Array, lo: number, h: number, v: number): number {
  const t = h > 0 ? (v - src[lo]!) / h : 0
  const t2 = t * t, t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return h00 * dst[lo]! + h10 * h * slope[lo]! + h01 * dst[lo + 1]! + h11 * h * slope[lo + 1]!
}

/** Condense floors, as fractions of a bin's natural width — the ORDER OF
 *  SACRIFICE a Condensed→Compressed cut follows. Empty space (counters,
 *  gaps) closes first but a counter thinner than this reads as a crack, not
 *  a counter … */
const EMPTY_BIN_FLOOR = 0.3
/** … ink running parallel to the stretch (arches, crossbars, spines)
 *  shortens but a curve needs room to turn … */
const INK_BIN_FLOOR = 0.5
/** … and the stems thin on their OWN schedule (see `stemFactor` below),
 *  never per-glyph negotiation — a typeface has ONE stem width, so how much a
 *  stem thins depends on S alone. This is that schedule's END value: the
 *  floor a stem reaches at Ultra-Compressed and goes no further than. Below
 *  it the glyph simply under-condenses (leftover deficit is dropped; the
 *  run-level advance still tightens). */
const RIGID_BIN_FLOOR = 0.6
/** Stems start thinning only once a cut is properly Condensed … */
const STEM_THIN_START = 0.85
/** … and reach their floor (`RIGID_BIN_FLOOR`) at Ultra-Compressed. */
const STEM_THIN_END = 0.4
/** The one stem-weight schedule every glyph follows under condense — a
 *  typeface has ONE stem width, so how much a stem thins must depend on S
 *  alone, never on whether THIS glyph had counters to give. A counter-less I
 *  under-condenses instead of thinning past its neighbours. */
export function stemFactor(S: number): number {
  if (S >= STEM_THIN_START) return 1
  const t = (STEM_THIN_START - Math.max(S, STEM_THIN_END)) / (STEM_THIN_START - STEM_THIN_END)
  return 1 - t * (1 - RIGID_BIN_FLOOR)
}
/** A bin whose flex is at or above this is fully flexible — empty space, or
 *  ink running parallel to the stretch (a crossbar's interior) — and may
 *  absorb unlimited growth: stretching space IS the point. Below it, the bin
 *  holds ink that resists, and its growth is capped so a few partial slivers
 *  cannot absorb a whole glyph's stretch. */
const FULL_FLEX = 0.95
/** Max width of a resisting bin under expansion, as a multiple of the
 *  uniform-stretch bin width S·w. Without this, a glyph whose only flexible
 *  slices are tiny partial slivers (the shoulders of an i's dot) dumps its
 *  ENTIRE width delta into them and the dot grows horns. Capped ink
 *  under-achieves S; the advance rule already covers a glyph that cannot
 *  widen (an extended I is barely wider). */
const PARTIAL_GROWTH_CAP = 2
/** Combined sidebearings may condense to this many stem widths but no
 *  further — the rule that keeps condensed letters from touching. */
const WHITESPACE_FLOOR_STEMS = 0.6

/** Free runs split into one bell PER BULGE at a partial waist: an interior
 *  local minimum of the flex profile below this (the S's spine at 0.26, the
 *  a's bowl/arch junction) … */
const SPLIT_FLEX_MAX = 0.5
/** … that is a real dip, not float noise on a ramp: the profile must rise at
 *  least this much on both sides of it before the next minimum or the run's
 *  end, else the lower of two neighbouring minima wins. */
const SPLIT_PROMINENCE = 0.1

/** The bell's shape over a free run, BY DIRECTION (`'auto'`):
 *   • GROWING (delta > 0) — `'sine'`, `sin(π·(j + 0.5)/L)`: a LINEAR rise
 *     from the run's edges to a smooth peak mid-run, so the rows right after
 *     an apex band already stretch and the shoulder opens as soon as the
 *     plateau ends. The raised cosine's zero edge slope left the shoulder at
 *     its drawn (tight) curvature while the sides elongated — an S or an a
 *     under Height 2.5 read as having a CORNER where the arch meets the side
 *     (measured: the first free row after the o's apex band grows 1.11× with
 *     the sine vs 1.01× with the cosine at Height 2.5).
 *   • SHRINKING (delta < 0) — `'cosine'`, `0.5 − 0.5·cos(2π·(j + 0.5)/L)`.
 *     Under a floor-clipped condense the transition S allows is a short
 *     cliff at the plateau's edge; a linear rise only smears that cliff into
 *     a long ramp with two corners spanning the whole shoulder (the o at
 *     [0.7, 2.41] went 8 → 12 inflections with the sine under condense).
 *  `'sine'` / `'cosine'` force one shape in both directions — kept reachable
 *  for the lab's comparison. */
const BELL_SHAPE: 'auto' | 'sine' | 'cosine' = 'auto'

/** The bell over a free run, at parameter t ∈ (0, 1): tapered towards both
 *  ends, or only the left / only the right (a half bump); the shape per
 *  `BELL_SHAPE` and the run's direction. */
function bellAt(t: number, taperL: boolean, taperR: boolean, grow: boolean): number {
  if (!taperL && !taperR) return 1
  const shape = BELL_SHAPE === 'auto' ? (grow ? 'sine' : 'cosine') : BELL_SHAPE
  if (shape === 'sine') {
    return taperL && taperR ? Math.sin(Math.PI * t)
      : taperL ? Math.sin(Math.PI * t / 2)
      : Math.cos(Math.PI * t / 2)
  }
  return taperL && taperR ? 0.5 - 0.5 * Math.cos(2 * Math.PI * t)
    : taperL ? 0.5 - 0.5 * Math.cos(Math.PI * t)
    : 0.5 + 0.5 * Math.cos(Math.PI * t)
}

/** What a free run's end abuts — decides whether the bell tapers there and,
 *  under condense, whether it anchors at the plateau's own scale. */
const END_NONE = 0      // the profile's edge, or a zone line with free ink beyond: flat
const END_PLATEAU = 1   // a rigid plateau: taper to ~0, anchor at stemScale under condense
const END_SPLIT = 2     // a waist between two bulges: taper to ~0, no anchor
/** Rows of a turn span with flex below this are still clearly TURNING (the
 *  ink's tangent within ~30° of perpendicular to the axis); the turn pass
 *  confines its whole rise/peak/descent to them and holds the span's
 *  straighter rows flat at the flank's level — see `binWidths`. */
const TURN_CURVED = 0.5

/** Raised cosine over a span of `L` bins: 0 at the span's edges, 1 at its
 *  middle; a span of 1 gets 1. The turn pass's taper (see `binWidths`). */
function raisedCosine(j: number, L: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * (j + 0.5) / L)
}

/** Waist bins that split the free run [i, j) into one sub-run per bulge —
 *  each returned index starts a new sub-run. Interior local minima below
 *  `SPLIT_FLEX_MAX`; a flat minimum counts once (its first bin); neighbouring
 *  minima without `SPLIT_PROMINENCE` of rise between them collapse to the
 *  lower one; a minimum without that much rise on its outer side is just the
 *  ramp's own noise and is dropped. The boundary bin joins the sub-run whose
 *  neighbour is lower. Deterministic. */
function waistSplits(flex: Float64Array, i: number, j: number): number[] {
  const acc: number[] = []
  const peakBetween = (a: number, b: number) => { let m = -Infinity; for (let q = a; q < b; q++) if (flex[q]! > m) m = flex[q]!; return m }
  for (let b = i + 1; b < j - 1; b++) {
    const v = flex[b]!
    if (v >= SPLIT_FLEX_MAX || v > flex[b - 1]! || v > flex[b + 1]!) continue
    if (acc.length) {
      const last = acc[acc.length - 1]!
      if (peakBetween(last + 1, b) - Math.max(flex[last]!, v) < SPLIT_PROMINENCE) {
        if (v < flex[last]!) acc[acc.length - 1] = b
        continue
      }
    }
    acc.push(b)
  }
  if (!acc.length) return acc
  if (peakBetween(i, acc[0]!) - flex[acc[0]!]! < SPLIT_PROMINENCE) acc.shift()
  if (acc.length && peakBetween(acc[acc.length - 1]! + 1, j) - flex[acc[acc.length - 1]!]! < SPLIT_PROMINENCE) acc.pop()
  return acc.map(b => (flex[b + 1]! < flex[b - 1]! ? b : b + 1))
}

/** Fix 2 (revised): a bin is RIGID for BELL/RUN purposes — excluded from any
 *  free run entirely, so it neither grows nor gets a share of a neighbour's
 *  growth — not just when `flex < HARD_RIGID` (a plain hard pin), but ALSO
 *  when `flex < INK_RIGID_FLEX` AND its ink occupancy is at least
 *  `INK_RIGID_MIN`. Rationale: a LONG, low-flex band that is MOSTLY ink is a
 *  horizontal stroke seen through the soft (mean) channel — the a's bowl top
 *  reads flex ≈ 0.12 with ink ≈ 0.74–0.86 — and it must hold its thickness
 *  like any other stroke, not stretch as if it were a curve easing toward a
 *  plateau. A SHORT low-flex ramp with little ink (a genuine curve's
 *  shoulder, mostly counter with only a sliver of curve ink) has ink well
 *  under `INK_RIGID_MIN` and stays free, so it still opens as designed —
 *  this is what keeps the plateau-edge shoulder-opening invariant intact.
 *
 *  An earlier version of this fix multiplied each bin's bell weight by a
 *  continuous "freeness" factor instead of excluding ink-heavy bins outright;
 *  that suppressed the FIRST FREE ROW after an apex band too (a shipped,
 *  eye-judged invariant), so it was reverted in favour of this binary,
 *  ink-aware classification. */
const INK_RIGID_FLEX = 0.15
const INK_RIGID_MIN = 0.7
function isBellRigid(flex: number, ink: number): boolean {
  return flex < HARD_RIGID || (flex < INK_RIGID_FLEX && ink >= INK_RIGID_MIN)
}

interface BellShape {
  /** Sharing weights: each sub-run's bell normalised to sum to its bin
   *  count, so a sub-run's share of the delta is ∝ its length. 0 on rigid
   *  (including ink-rigid, see `isBellRigid`). */
  share: Float64Array
  /** The raw bell in [0, 1] per bin (uniform spans flattened to their mean). */
  bell: Float64Array
  /** How much of a bin's condense shrink is the PLATEAU'S OWN thinning: 1 −
   *  bell on the half of a sub-run whose end is a rigid plateau, 0 elsewhere.
   *  Under condense a run beside a plateau starts from `stemScale` at that
   *  end and dips from there, so there is no bump at the plateau's edge. */
  anchor: Float64Array
}

/**
 * Sharing weights for the BELL distribution. The tangent analysis decides
 * what is rigid — `isBellRigid`: a plain hard pin (flex < HARD_RIGID), OR a
 * long, ink-heavy low-flex band (a horizontal stroke seen through the soft
 * channel, not a curve's shoulder) — between rigid features the change is
 * spread as smoothly as possible: over each free run a bell (`BELL_SHAPE`) — near
 * zero beside the plateaus (a round's shoulders), peaking mid-run (the flank
 * / the counter). Whitespace in the middle of a counter stretches most, which
 * is typographically right; a crossbar spanning a counter elongates
 * non-uniformly, which is invisible on a straight horizontal line.
 *
 * ONE BELL PER BULGE: a free run is split at its partial waists (see
 * `waistSplits`) so an S gets a bell per bowl, each peaking at that bowl's
 * own extreme — the only place a rising-then-falling scale agrees with the
 * drawn curvature on both sides.
 *
 * A run tapers only towards a plateau or a waist. Where it ends at the
 * profile's own edge, or at a zone line with FREE ink on the far side
 * (`rigidBeyond`), there is nothing to ease into, so that side stays flat (a
 * half bell, or no bell at all — an all-free profile, k = 0, scales
 * uniformly exactly as it always did). Bins `uniformSpans` flattened share
 * with one CONSTANT weight — the mean bell weight over their span — so a
 * straight diagonal stays straight.
 */
function bellWeights(flex: Float64Array, ink: Float64Array | undefined, softTerm: Uint8Array | undefined, uniform: Uint8Array | undefined, rigidBeyond: readonly [boolean, boolean], grow: boolean): BellShape {
  const n = flex.length
  const share = new Float64Array(n)
  const bell = new Float64Array(n)
  const anchor = new Float64Array(n)
  const inkAt = (q: number) => ink ? ink[q]! : 0
  // `softTerm` bins (a short diagonal terminal's own soft pin — see
  // `FlexProfile.softTerm`) are excluded from bell/run growth-sharing
  // outright, same as `isBellRigid`'s ink-heavy horizontal strokes: their
  // reported `flex` is intentionally well above `HARD_RIGID` (a terminal's
  // row must not hard-pin to exactly 0), so `isBellRigid` alone would treat
  // them as an ordinary free bin and hand them a full bell share — which is
  // what caused the terminal-angle regression this exclusion fixes.
  const rigid = (q: number) => isBellRigid(flex[q]!, inkAt(q)) || !!softTerm?.[q]
  let i = 0
  while (i < n) {
    if (rigid(i)) { i++; continue }
    let j = i
    while (j < n && !rigid(j)) j++
    const endL = i > 0 || rigidBeyond[0] ? END_PLATEAU : END_NONE
    const endR = j < n || rigidBeyond[1] ? END_PLATEAU : END_NONE
    const bounds = [i, ...waistSplits(flex, i, j), j]
    for (let r = 0; r + 1 < bounds.length; r++) {
      const a = bounds[r]!, b = bounds[r + 1]!
      const kL = r === 0 ? endL : END_SPLIT
      const kR = r + 2 === bounds.length ? endR : END_SPLIT
      const L = b - a
      for (let q = a; q < b; q++) bell[q] = bellAt((q - a + 0.5) / L, kL !== END_NONE, kR !== END_NONE, grow)
      if (uniform) {
        let u = a
        while (u < b) {
          if (!uniform[u]) { u++; continue }
          let v = u, sum = 0
          while (v < b && uniform[v]) { sum += bell[v]!; v++ }
          const mean = sum / (v - u)
          for (let q = u; q < v; q++) bell[q] = mean
          u = v
        }
      }
      for (let q = a; q < b; q++) {
        const nearL = q - a < b - 1 - q || (q - a === b - 1 - q && kL === END_PLATEAU)
        const k = nearL ? kL : kR
        anchor[q] = k === END_PLATEAU ? 1 - bell[q]! : 0
      }
      let sum = 0
      for (let q = a; q < b; q++) sum += bell[q]!
      const scale = sum > 0 ? L / sum : 0
      for (let q = a; q < b; q++) share[q] = bell[q]! * scale
    }
    i = j
  }
  return { share, bell, anchor }
}

function binWidths(
  flex: Float64Array,
  w: number,
  S: number,
  ink?: Float64Array,
  stemScale: number = stemFactor(S),
  turn?: Uint8Array,
  turnScale?: number,
  mode: DistributionMode = 'flex',
  uniform?: Uint8Array,
  rigidBeyond: readonly [boolean, boolean] = [false, false],
  softTerm?: Uint8Array,
): Float64Array {
  const n = flex.length
  const out = new Float64Array(n).fill(w)
  const total = n * w
  const delta = (S - 1) * total
  // What decides each bin's SHARE of the change. Everything else — which
  // bins are rigid, the floors and caps, the turn pass below — reads `flex`
  // exactly as before; only the proportional split reads `share`.
  const shape = mode === 'bell' ? bellWeights(flex, ink, softTerm, uniform, rigidBeyond, delta > 0) : undefined
  const share = shape ? shape.share : flex
  if (Math.abs(delta) >= 1e-12) {
    if (delta > 0) {
      let sum0 = 0
      for (const f of share) sum0 += f
      if (sum0 >= 1e-9) {   // else all-rigid: the glyph cannot widen at all
        const cap = PARTIAL_GROWTH_CAP * S * w
        let remaining = delta
        for (let pass = 0; pass < 4 && remaining > 1e-9; pass++) {
          let sum = 0
          for (let i = 0; i < n; i++) {
            if (!(share[i]! > 0)) continue
            if (flex[i]! >= FULL_FLEX || out[i]! < cap - 1e-12) sum += share[i]!
          }
          if (sum < 1e-9) break
          let absorbed = 0
          for (let i = 0; i < n; i++) {
            if (!(share[i]! > 0)) continue
            const full = flex[i]! >= FULL_FLEX
            if (!full && out[i]! >= cap - 1e-12) continue
            const want = remaining * (share[i]! / sum)
            const take = full ? want : Math.min(want, cap - out[i]!)
            out[i]! += take
            absorbed += take
          }
          remaining -= absorbed
          if (absorbed < 1e-12) break
        }
        // Leftover means every resisting bin hit its cap and nothing fully
        // flexible exists: the ink genuinely cannot widen to S. Dropped by
        // design — whitespace still scales, so the word's rhythm holds.
      }
    } else {
      // Condense. Rigid bins (flex < 0.05) are a STEM: a typeface has ONE
      // stem width, so how much a stem thins follows the deterministic
      // `stemFactor(S)` schedule alone — identical for every glyph, never
      // negotiated per-glyph against what else the glyph happens to hold. A
      // counter-less 'I' simply under-condenses instead of stealing weight
      // consistency from its neighbours.
      // The stems' own reduction already counts against the deficit —
      // without subtracting it here, the counter waterfall below runs
      // against the FULL original deficit on top of what the stems just
      // gave, and the two reductions stack: the glyph condenses past S
      // instead of landing on it.
      let deficit = -delta
      for (let i = 0; i < n; i++) {
        if (flex[i]! < 0.05) {
          const thinned = w * stemScale
          deficit -= w - thinned
          out[i] = thinned
        }
      }
      // The rest of the ORDER OF SACRIFICE: empty space (counters, gaps)
      // gives first but floors at EMPTY_BIN_FLOOR — thinner reads as a
      // crack, not a counter. Ink running parallel to the stretch (arches,
      // crossbars, spines) shortens next, floored higher: a curve needs
      // room to turn. Each bin gets its own floor from what it actually
      // holds.
      const floor = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const isInk = ink ? ink[i]! > 0 : flex[i]! < FULL_FLEX
        floor[i] = w * (flex[i]! < 0.05 ? RIGID_BIN_FLOOR : isInk ? INK_BIN_FLOOR : EMPTY_BIN_FLOOR)
      }
      // Bell mode: a free run beside a plateau starts from the plateau's own
      // scale. The part of each bin's shrink that is the plateau's thinning
      // — w·(1 − stemScale), fading out with 1 − bell towards the run's
      // middle — is preset here, deterministically, like the stems' own
      // schedule above; only the remaining deficit is negotiated by the
      // bell below. Scaled down (never up) so the preset can't out-shrink a
      // deficit that is smaller than the stems' schedule would imply.
      if (shape && stemScale < 1) {
        let want = 0
        for (let i = 0; i < n; i++) if (flex[i]! >= 0.05) want += w * (1 - stemScale) * shape.anchor[i]!
        if (want > 1e-12 && deficit > 1e-12) {
          const k = Math.min(1, deficit / want)
          for (let i = 0; i < n; i++) {
            if (!(flex[i]! >= 0.05)) continue
            const next = Math.max(floor[i]!, out[i]! - w * (1 - stemScale) * shape.anchor[i]! * k)
            deficit -= out[i]! - next
            out[i] = next
          }
        }
      }
      // Phase 1 (and only phase): bins that resist the stretch least
      // (non-rigid — empty space and ink-bearing-but-flexible slices)
      // shrink toward their OWN floor, proportional to flex, over up to 4
      // waterfall passes (a bin hitting its floor stops absorbing and the
      // rest re-split what's left). Gated on `flex >= 0.05`, the same rigid
      // cut used for the preset above and the floor table below — NOT
      // `flex > 0` — because a real glyph's "rigid" column is never exactly
      // 0 (chamfer-propagated tangents leave float noise like 0.00013);
      // gating on literal positivity would let the stem's own bins sneak
      // back into this waterfall and thin a second time on top of their
      // schedule width. There is no second, headroom-proportional phase
      // over all bins: the stems already had their say above, and letting
      // counters renegotiate against the stems' fixed contribution is
      // exactly the per-glyph negotiation that made an 'I' thin its one
      // stem to reach S while an 'L' left its stem untouched. Whatever
      // deficit is left when every eligible bin has floored is dropped —
      // consistency of stem weight beats reaching S exactly; the run-level
      // advance still tightens.
      for (let pass = 0; pass < 4 && deficit > 1e-9; pass++) {
        let sum = 0
        for (let i = 0; i < n; i++) if (flex[i]! >= 0.05 && out[i]! > floor[i]! + 1e-12) sum += share[i]!
        if (sum < 1e-9) break
        let taken = 0
        for (let i = 0; i < n; i++) {
          if (!(flex[i]! >= 0.05) || out[i]! <= floor[i]! + 1e-12) continue
          const can = Math.min(deficit * (share[i]! / sum), out[i]! - floor[i]!)
          out[i]! -= can
          taken += can
        }
        deficit -= taken
        if (taken < 1e-12) break
      }
    }
  }
  // Rounds stay round (rule 10) — MULTIPLICATIVE coupling, applied AFTER the
  // ordinary distribution above (turn bins take part in it exactly like any
  // other bin; nothing above even reads `turn`). This makes the rule an
  // IDENTITY at turnScale = 1 by construction, and no bins are ever excluded
  // from the ordinary pool (the failure mode of the earlier preset-based
  // mechanic, which concentrated a band's growth onto whatever was left).
  //
  // Each contiguous turn span gets a TAPERED factor, and the taper's two ends
  // are CONTINUOUS with what they abut: 1 on a plateau side (rigid neighbour
  // or band edge — the plateau never moves) and, on a flank side, the free
  // neighbour's own level after compensation, so the width sequence runs
  // smoothly from shoulder into flank. On a near-straight flank any change
  // in local scale reads as a curvature flip, so the whole shoulder-to-flank
  // transition has to happen INSIDE the curved shoulder — never as a step at
  // its edge, never spread across the flank (a flat multiply stepped 3:1 at
  // the turn/flank edge; a taper that returned to 1 at both ends still
  // stepped against the flat flank). Between the ends the factor is a raised
  // cosine from that linear base up to a peak P at the span's centre.
  //
  // The taper runs over CURVATURE, not bins: the span's parameter advances
  // only through rows whose flex is below TURN_CURVED — rows whose ink is
  // still clearly turning — so the rise, the peak and the descent all happen
  // in the corner, and the span's straighter tail sits exactly flat at the
  // flank's level (a span with no such row falls back to the plain bell).
  // Measured on Inter's o at S = 1.8: a mean-preserving peak (2–6× over the
  // few corner rows) or any variation on the straighter rows both READ as
  // curvature flips; the moderate peak with the flat tail is what survives.
  //
  // The peak is turnScale itself. The flank level is one scalar c (every
  // free bin scales by c, the same own-width-proportional push as before),
  // linear in the conservation equation, so it is solved in closed form.
  // Where the flank's floor would be breached, CONTINUITY WINS: c is pinned
  // at the floor level and the common peak is solved instead. Turn bins keep
  // their own condense floor, which the closed form doesn't see, so c is
  // then iterated to a fixed point with the clamps applied. The change is
  // finally pushed onto the free bins exactly as before — grow uncapped,
  // shrink floor-clamped over the same waterfall — and any shortfall is
  // dropped, same "leftover" philosophy as everywhere else in this function.
  // Deliberately NOT mean-preserving: a raised cosine's mean is half its
  // peak, so the coupling's total effect is smaller than the old flat
  // multiply's — the price of a shoulder that stays a shoulder.
  if (turn && turnScale !== undefined) {
    const isFree = (i: number) => !turn[i] && flex[i]! >= HARD_RIGID
    const floorOf = (i: number) => {
      const isInk = ink ? ink[i]! > 0 : flex[i]! < FULL_FLEX
      return w * (isInk ? INK_BIN_FLOOR : EMPTY_BIN_FLOOR)
    }
    let freeTotal = 0, cMin = 0
    for (let i = 0; i < n; i++) {
      if (!isFree(i)) continue
      freeTotal += out[i]!
      if (out[i]! > 0) cMin = Math.max(cMin, floorOf(i) / out[i]!)
    }
    // Spans, with per-bin base = b0 + b1·c and the bell; with the peak fixed
    // at turnScale the conservation equation is A + B·c + (c − 1)·freeTotal
    // = 0. SB = Σ width·bell, for solving the peak when c is pinned.
    interface Span { i0: number; i1: number; b0: Float64Array; b1: Float64Array; bell: Float64Array }
    const spans: Span[] = []
    let A = 0, B = 0, SB = 0, turnTotal = 0
    for (let i0 = 0; i0 < n;) {
      if (!turn[i0]) { i0++; continue }
      let i1 = i0
      while (i1 < n && turn[i1]) i1++
      const L = i1 - i0
      const flankL = i0 > 0 && isFree(i0 - 1) && out[i0]! > 0
      const flankR = i1 < n && isFree(i1) && out[i1 - 1]! > 0
      const rL = flankL ? out[i0 - 1]! / out[i0]! : 0
      const rR = flankR ? out[i1]! / out[i1 - 1]! : 0
      const b0 = new Float64Array(L), b1 = new Float64Array(L), bell = new Float64Array(L)
      let W = 0
      for (let j = 0; j < L; j++) W += Math.max(0, TURN_CURVED - flex[i0 + j]!)
      const wOf = W > 1e-9 ? (j: number) => Math.max(0, TURN_CURVED - flex[i0 + j]!) / W : () => 1 / L
      let cum = 0
      for (let j = 0; j < L; j++) {
        const wj = wOf(j)
        const t = cum + 0.5 * wj
        cum += wj
        bell[j] = 0.5 - 0.5 * Math.cos(2 * Math.PI * t)
        b0[j] = (flankL ? 0 : 1 - t) + (flankR ? 0 : t)
        b1[j] = (flankL ? rL * (1 - t) : 0) + (flankR ? rR * t : 0)
        const o = out[i0 + j]!, u = 1 - bell[j]!
        A += o * (b0[j]! * u + turnScale * bell[j]! - 1)
        B += o * b1[j]! * u
        SB += o * bell[j]!
        turnTotal += o
      }
      spans.push({ i0, i1, b0, b1, bell })
      i0 = i1
    }
    if (spans.length) {
      let c = 1, P = turnScale
      let pinned = false
      if (freeTotal > 1e-9) {
        const denom = B + freeTotal
        c = Math.abs(denom) > 1e-12 ? (freeTotal - A) / denom : 1
        if (c < cMin) {
          // Continuity wins: pin the flank at its floor and solve the common
          // peak from conservation instead.
          c = cMin
          pinned = true
          let base = 0
          for (const sp of spans) for (let j = 0; j < sp.i1 - sp.i0; j++) base += out[sp.i0 + j]! * (sp.b0[j]! + sp.b1[j]! * c) * (1 - sp.bell[j]!)
          P = SB > 1e-12 ? (turnTotal - (c - 1) * freeTotal - base) / SB : turnScale
        }
      }
      const apply = (write: boolean): number => {
        let d = 0
        for (const sp of spans) {
          for (let j = 0; j < sp.i1 - sp.i0; j++) {
            const i = sp.i0 + j
            const base = sp.b0[j]! + sp.b1[j]! * c
            const f = base + (P - base) * sp.bell[j]!
            const next = Math.max(floorOf(i), out[i]! * f)
            d += next - out[i]!
            if (write) out[i] = next
          }
        }
        return d
      }
      if (freeTotal > 1e-9 && !pinned) {
        // Floor clamps on turn bins change the total; re-derive the flank
        // level from the clamped total until it settles (a few steps — the
        // clamped bins are insensitive to c).
        for (let it = 0; it < 8; it++) {
          const cNext = Math.max(cMin, 1 - apply(false) / freeTotal)
          if (Math.abs(cNext - c) < 1e-9) break
          c = cNext
        }
      }
      const diff = apply(true)
      if (Math.abs(diff) > 1e-12 && freeTotal > 1e-9) {
        const push = -diff
        if (push >= 0) {
          for (let i = 0; i < n; i++) {
            if (!isFree(i)) continue
            out[i]! += push * (out[i]! / freeTotal)
          }
        } else {
          let need = -push
          for (let pass = 0; pass < 4 && need > 1e-9; pass++) {
            let sum = 0
            for (let i = 0; i < n; i++) if (isFree(i) && out[i]! > floorOf(i) + 1e-12) sum += out[i]!
            if (sum < 1e-9) break
            let taken = 0
            for (let i = 0; i < n; i++) {
              if (!isFree(i) || out[i]! <= floorOf(i) + 1e-12) continue
              const can = Math.min(need * (out[i]! / sum), out[i]! - floorOf(i))
              out[i]! -= can
              taken += can
            }
            need -= taken
            if (taken < 1e-12) break
          }
        }
      }
    }
  }
  return out
}

/**
 * Split a profile's bins into consecutive BANDS by the shared alignment
 * lines in `zones`, and solve each band's widths independently (each calls
 * `binWidths` on its own flex/ink slice with the same `S`).
 *
 * Every glyph shares the same typeface-level lines (baseline, x-height, cap
 * height, ascender, descender): without this, each glyph's Y remap is solved
 * over its OWN bbox extent, so a glyph whose bbox happens to include extra
 * rigid ink (an i's dot above its stem) must push its whole shape further to
 * reach the same total height — and its x-height line lands somewhere else
 * than its neighbours'. Solving band-by-band instead means the boundary
 * between bands (a zone line) always lands at exactly S × its natural
 * position, because that boundary is precisely where one band's cumulative
 * width ends and the next begins — independent of how each band's own ink
 * happens to resist.
 *
 * A band that is entirely rigid (no bin in it has any flex) cannot widen at
 * all and keeps its absolute size — this is not a bug to route around: an
 * overshoot sliver sitting above the x-height (or below the baseline) SHOULD
 * keep its drawn size rather than stretch, which is exactly classic optical
 * overshoot compensation.
 */
function bandedBinWidths(profile: FlexProfile, S: number, zones: readonly number[], stemScale?: number, turnScale?: number, mode: DistributionMode = 'flex'): Float64Array {
  const { start, binSize: w, flex, ink, turn, uniform, softTerm } = profile
  const n = flex.length
  const total = n * w
  // Keep only lines strictly inside the profile's own span, sorted and
  // deduped — a line at or beyond either end contributes no boundary.
  const lines = Array.from(new Set(zones.filter(z => z > start && z < start + total))).sort((a, b) => a - b)
  if (!lines.length) return binWidths(flex, w, S, ink, stemScale, turn, turnScale, mode, uniform, undefined, softTerm)

  // A bin belongs to the band containing its CENTRE, not its edges — so a
  // zone line that lands mid-bin (the common case; zones rarely fall on a
  // bin boundary) still assigns that whole bin to one side consistently.
  const bandOf = new Int32Array(n)
  let li = 0
  for (let i = 0; i < n; i++) {
    const centre = start + (i + 0.5) * w
    while (li < lines.length && lines[li]! <= centre) li++
    bandOf[i] = li
  }

  const out = new Float64Array(n)
  let lo = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || bandOf[i] !== bandOf[lo]) {
      // Float64Array.subarray is a VIEW — binWidths only reads flex/ink, so
      // this never copies, and the result is written back into `out` at the
      // band's own offset.
      const bandFlex = flex.subarray(lo, i)
      const bandInk = ink ? ink.subarray(lo, i) : undefined
      const bandTurn = turn ? turn.subarray(lo, i) : undefined
      const bandUniform = uniform ? uniform.subarray(lo, i) : undefined
      const bandSoftTerm = softTerm ? softTerm.subarray(lo, i) : undefined
      // The bell tapers a run only towards a plateau: tell the band whether
      // the bin just beyond each of its edges is rigid, since it cannot see
      // past its own slice. Ink-aware (`isBellRigid`) and softTerm-aware,
      // same as the bell's own run detection, so a stroke (or a soft-pinned
      // terminal) that happens to sit right at a band boundary is still seen
      // as a plateau from the neighbouring band's side.
      const rigidBeyond: [boolean, boolean] = [
        lo > 0 && (isBellRigid(flex[lo - 1]!, ink ? ink[lo - 1]! : 0) || !!softTerm?.[lo - 1]),
        i < n && (isBellRigid(flex[i]!, ink ? ink[i]! : 0) || !!softTerm?.[i]),
      ]
      const bandWidths = binWidths(bandFlex, w, S, bandInk, stemScale, bandTurn, turnScale, mode, bandUniform, rigidBeyond, bandSoftTerm)
      enforceZoneBandTarget(bandWidths, bandFlex, bandInk, w, S, mode, bandSoftTerm)
      out.set(bandWidths, lo)
      lo = i
    }
  }
  return out
}

/**
 * Zone bands are HARD CONSTRAINTS (Fix: zones always reach their target).
 * `binWidths` alone under-achieves a band whenever its non-rigid bins hit
 * the partial-growth cap on expansion, or their floors on condense, and
 * over-achieves is impossible by construction but a mixed band can still
 * land short — either way the band's own line (the boundary the NEXT band
 * starts from) drifts off S × its natural position. That is invisible for
 * an ordinary, non-zoned remap (`binWidths`'s own leftover-is-dropped
 * philosophy), but a zone line is an ALIGNMENT LINE SHARED ACROSS EVERY
 * GLYPH — an x-height, a cap-height — so one glyph quietly under-achieving
 * its band breaks that line for the whole word, not just for itself.
 *
 * So here, after the ordinary solve, the leftover (or overshoot) is forced
 * onto the band's own non-rigid bins (flex ≥ `HARD_RIGID`), proportional to
 * their current width, ignoring the partial-growth cap — the cap exists to
 * protect a lone sliver from absorbing a whole glyph's stretch, but a zone
 * line matters more than that protection. Under condense the bins' floors
 * still apply: if the floors alone make the target unreachable, this stops
 * there (the documented deep-condense limit) rather than breaching them.
 *
 * A band with NO non-rigid bin (every bin flex < `HARD_RIGID`) is left
 * untouched — the overshoot-sliver exemption already documented on
 * `bandedBinWidths`: an all-rigid band keeps its natural, un-stretched
 * size rather than being forced to grow.
 */
function enforceZoneBandTarget(bandWidths: Float64Array, flex: Float64Array, ink: Float64Array | undefined, w: number, S: number, mode: DistributionMode = 'flex', softTerm?: Uint8Array): void {
  const n = bandWidths.length
  const target = S * n * w
  let total = 0
  for (let q = 0; q < n; q++) total += bandWidths[q]!
  const diff = target - total
  if (Math.abs(diff) <= 1e-6) return
  // Fix 2 (continued): in bell mode, "non-rigid" here is the same
  // classification `bellWeights` uses — ink-aware (`isBellRigid`) AND
  // softTerm-aware — not just the plain `flex >= HARD_RIGID` cut. Otherwise a
  // bin the ordinary bell pass correctly excluded (a horizontal stroke, or a
  // short diagonal terminal's own soft pin) would still be handed a share of
  // THIS hard constraint's leftover growth, proportional to plain width,
  // once the band's genuinely rigid ink leaves too little headroom elsewhere
  // — undoing the exclusion right back. 'flex' mode (the lab's A/B control)
  // keeps the original plain cut.
  const nonRigid: number[] = []
  for (let q = 0; q < n; q++) {
    const isRigid = mode === 'bell'
      ? isBellRigid(flex[q]!, ink ? ink[q]! : 0) || !!softTerm?.[q]
      : flex[q]! < HARD_RIGID
    if (!isRigid) nonRigid.push(q)
  }
  if (!nonRigid.length) return   // all-rigid band: keep its natural size
  if (diff > 0) {
    let sumW = 0
    for (const q of nonRigid) sumW += bandWidths[q]!
    if (sumW > 1e-9) {
      for (const q of nonRigid) bandWidths[q]! += diff * (bandWidths[q]! / sumW)
    } else {
      for (const q of nonRigid) bandWidths[q]! += diff / nonRigid.length
    }
    return
  }
  // Condense: shrink the band's non-rigid bins toward their own floors,
  // proportional to current width, over a waterfall like `binWidths`'s own
  // condense passes — a bin at its floor stops absorbing and the rest
  // re-split what's left. Whatever remains when every eligible bin has
  // floored is dropped (the deep-condense limit).
  let need = -diff
  for (let pass = 0; pass < 4 && need > 1e-9; pass++) {
    let sumW = 0
    for (const q of nonRigid) {
      const isInk = ink ? ink[q]! > 0 : flex[q]! < FULL_FLEX
      const floor = w * (isInk ? INK_BIN_FLOOR : EMPTY_BIN_FLOOR)
      if (bandWidths[q]! > floor + 1e-12) sumW += bandWidths[q]!
    }
    if (sumW < 1e-9) break
    let taken = 0
    for (const q of nonRigid) {
      const isInk = ink ? ink[q]! > 0 : flex[q]! < FULL_FLEX
      const floor = w * (isInk ? INK_BIN_FLOOR : EMPTY_BIN_FLOOR)
      if (bandWidths[q]! <= floor + 1e-12) continue
      const can = Math.min(need * (bandWidths[q]! / sumW), bandWidths[q]! - floor)
      bandWidths[q]! -= can
      taken += can
    }
    need -= taken
    if (taken < 1e-12) break
  }
}

export function buildRemap(profile: FlexProfile, S: number, fixedPoint?: number, zones?: readonly number[], stemScale?: number, turnScale?: number, mode: DistributionMode = 'flex'): Remap {
  const { start, binSize: w, flex, ink, turn, uniform, softTerm } = profile
  const n = flex.length
  const widths = zones && zones.length
    ? bandedBinWidths(profile, S, zones, stemScale, turnScale, mode)
    : binWidths(flex, w, S, ink, stemScale, turn, turnScale, mode, uniform, undefined, softTerm)
  const src = new Float64Array(n + 1)
  const dst = new Float64Array(n + 1)
  let acc = start
  for (let i = 0; i <= n; i++) {
    src[i] = start + i * w
    dst[i] = acc
    if (i < n) acc += widths[i]!
  }
  // Monotone cubic (Fritsch–Carlson / PCHIP) slopes at each breakpoint, from
  // the per-bin secant slopes δ_i = (dst[i+1] − dst[i]) / w (uniform bins, so
  // ≥ 0 always). Interior breakpoints take the harmonic mean of their two
  // neighbouring secants — the Fritsch–Butland form for uniform spacing —
  // which is monotone-preserving: it cannot overshoot past either neighbour
  // the way a plain average (Catmull-Rom) slope can. A secant sign change (a
  // local extremum, only possible here at floor/cap clamps) sets the slope
  // to 0 so the spline doesn't overshoot through it either.
  const slope = new Float64Array(n + 1)
  if (n >= 1) {
    const delta = new Float64Array(n)
    for (let i = 0; i < n; i++) delta[i] = w > 0 ? widths[i]! / w : 0
    slope[0] = delta[0]!
    slope[n] = delta[n - 1]!
    for (let i = 1; i < n; i++) {
      const d0 = delta[i - 1]!, d1 = delta[i]!
      slope[i] = d0 * d1 <= 0 ? 0 : 2 / (1 / d0 + 1 / d1)
    }
  }
  const m = { src, dst, slope }
  if (fixedPoint !== undefined) {
    const shift = remapValue(m, fixedPoint) - fixedPoint
    for (let i = 0; i <= n; i++) dst[i]! -= shift
  }
  return m
}

/** Monotone-cubic (Hermite) lookup — C1, so no curvature kink at a bin edge;
 *  slope 1 outside the profile's span so points a hair beyond the bbox
 *  (rounding, overshoot) translate instead of scaling. */
export function remapValue(m: Remap, v: number): number {
  const { src, dst, slope } = m
  const n = src.length - 1
  if (n < 1) return v
  if (v <= src[0]!) return dst[0]! + (v - src[0]!)
  if (v >= src[n]!) return dst[n]! + (v - src[n]!)
  let lo = 0, hi = n
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (src[mid]! <= v) lo = mid
    else hi = mid
  }
  const span = src[lo + 1]! - src[lo]!
  return hermiteAt(src, dst, slope, lo, span, v)
}

/** Map every (x, y) coordinate pair in `commands` through its axis remap.
 *  Shared by `stretchCommands` (per-glyph, caller-supplied flex) and
 *  `stretchOutlines` (run-level, flex computed and cached per glyph) so the
 *  point-mapping logic exists exactly once. */
function applyRemaps(commands: readonly PathCommand[], rx: Remap, ry: Remap): PathCommand[] {
  return commands.map(c => {
    if (!c.args.length) return { command: c.command, args: [] }
    const args = c.args.slice()
    for (let i = 0; i + 1 < args.length; i += 2) {
      args[i] = remapValue(rx, args[i]!)
      args[i + 1] = remapValue(ry, args[i + 1]!)
    }
    return { command: c.command, args }
  })
}

export function stretchCommands(
  commands: readonly PathCommand[],
  flex: GlyphFlex,
  S: number,
  SY: number,
): PathCommand[] {
  const rx = buildRemap(flex.x, S)
  // Baseline anchor: y = 0 is a fixed point, so letters grow up off the
  // baseline and descenders grow down, instead of smearing around a centre.
  const ry = buildRemap(flex.y, SY, 0)
  return applyRemaps(commands, rx, ry)
}

/** Flex analysis is the expensive step, so it is memoised on the outline
 *  object itself. GlyphOutline objects are fresh per textOutlines() call, so
 *  this never conflates different fonts, texts, or axis positions. Keying by
 *  (fontId, glyphId, coords) for cross-call reuse is Phase B, in the studio. */
const flexCache = new WeakMap<GlyphOutline, Map<string, GlyphFlex>>()

export function glyphFlexFor(g: GlyphOutline, opts: FlexOptions = {}): GlyphFlex {
  const key = `${opts.bins ?? DEFAULT_BINS}|${opts.k ?? DEFAULT_K}|${opts.smallFeature ?? 0}|${opts.straightMin ?? 'auto'}|${opts.shapeRules ?? true}`
  let byOpts = flexCache.get(g)
  if (!byOpts) {
    byOpts = new Map()
    flexCache.set(g, byOpts)
  }
  const hit = byOpts.get(key)
  if (hit) return hit
  const flex = analyzeFlex(g.commands, g.bbox, opts)
  byOpts.set(key, flex)
  return flex
}

const hasInk = (g: GlyphOutline): boolean =>
  g.commands.length > 0 && g.bbox.maxX > g.bbox.minX && g.bbox.maxY > g.bbox.minY

export function stretchOutlines(
  outlines: TextOutlines,
  S: number,
  SY: number,
  opts: FlexOptions = {},
): TextOutlines {
  if (S === 1 && SY === 1) return outlines
  const flexOpts: FlexOptions = {
    smallFeature: SMALL_FEATURE_EM * outlines.unitsPerEm,
    straightMin: STRAIGHT_MIN_EM * outlines.unitsPerEm,
    ...opts,
  }
  // Shared vertical zones: every glyph's Y remap is solved band-by-band
  // against the FONT's alignment lines, not each glyph's own bbox, so the
  // baseline/x-height/cap-height/ascender/descender land at the same place
  // in every glyph (see `bandedBinWidths`'s doc comment for why this fixes
  // the "i's stem sits above its neighbours" bug).
  const m = outlines.metrics
  const zones = [0, m.xHeight, m.capHeight, m.ascent, m.descent]
  // Stems follow AREA, not width: a tall compressed display face (S small,
  // SY large) keeps heavy stems — the letter isn't getting smaller, it's
  // getting taller. The one stem-weight schedule takes S × SY, shared by
  // both axes, so a rigid Y bin (an arch/crossbar thickness) thins by the
  // same rule a rigid X bin (a stem) does.
  const stemScale = stemFactor(S * SY)
  // Rounds stay round (rule 10): a round's turn-region height follows its
  // WIDTH, so the Y remap (and only the Y remap — X gets no turn preset)
  // presets its turn bins to S^roundCoupling.
  const roundCoupling = opts.roundCoupling ?? ROUND_COUPLING
  const turnScaleY = Math.pow(S, roundCoupling)
  // Bell distribution between rigid features is a shape-integrity rule like
  // the others, so it rides the same switch; off = the original tangent-
  // proportional split (the lab's A/B control).
  const mode: DistributionMode = flexOpts.shapeRules === false ? 'flex' : 'bell'
  const glyphs: GlyphOutline[] = []
  let penOld = 0
  let penNew = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const g of outlines.glyphs) {
    let commands = g.commands
    let bbox = g.bbox
    let inkW = 0
    let newInkW = 0
    let flex: GlyphFlex | undefined
    if (hasInk(g)) {
      flex = glyphFlexFor(g, flexOpts)
      const rx = buildRemap(flex.x, S, undefined, undefined, stemScale, undefined, mode)
      const ry = buildRemap(flex.y, SY, 0, zones, stemScale, turnScaleY, mode)
      commands = applyRemaps(g.commands, rx, ry)
      bbox = {
        minX: remapValue(rx, g.bbox.minX),
        maxX: remapValue(rx, g.bbox.maxX),
        minY: remapValue(ry, g.bbox.minY),
        maxY: remapValue(ry, g.bbox.maxY),
      }
      inkW = g.bbox.maxX - g.bbox.minX
      newInkW = bbox.maxX - bbox.minX
    }
    // Sidebearings are flexible space: the ink contributes its own (possibly
    // rigid) new width, and the whitespace around it scales with S. An 'l'
    // whose ink cannot widen still gains a little air — an extended I *is*
    // barely wider. But combined sidebearings may condense only so far:
    // below WHITESPACE_FLOOR_STEMS stem widths, neighbouring letters touch.
    const whitespace = g.advance - inkW
    let advance: number
    if (flex && S < 1 && whitespace > 0) {
      const stemRef = stemWidthOf(flex.x) || 0.09 * outlines.unitsPerEm
      advance = newInkW + Math.max(whitespace * S, Math.min(whitespace, WHITESPACE_FLOOR_STEMS * stemRef))
    } else {
      advance = newInkW + whitespace * S
    }
    // xOffset positioning (g.x drifting from the accumulated pen) is preserved
    // proportionally rather than dropped.
    const offset = (g.x - penOld) * S
    const x = penNew + offset
    glyphs.push({ ...g, commands, bbox, advance, x, y: g.y })
    if (hasInk(g)) {
      minX = Math.min(minX, x + bbox.minX)
      minY = Math.min(minY, g.y + bbox.minY)
      maxX = Math.max(maxX, x + bbox.maxX)
      maxY = Math.max(maxY, g.y + bbox.maxY)
    }
    penOld += g.advance
    penNew += advance
  }
  const empty = !Number.isFinite(minX)
  return {
    ...outlines,
    glyphs,
    width: penNew,
    bbox: empty ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY },
  }
}

/** Binary search a monotone-increasing measurement for the axis value whose
 *  measure hits `target`, clamped to [min, max]. 24 iterations ≈ float
 *  precision on any real axis range. */
export function solveAxis(
  measure: (v: number) => number,
  min: number,
  max: number,
  target: number,
): number {
  if (measure(max) <= target) return max
  if (measure(min) >= target) return min
  let lo = min, hi = max
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (measure(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export interface StretchPlan {
  coords: Record<string, number>
  /** Stretch factor left for the geometric remap after the axis is spent. */
  residual: number
}

/**
 * Spend a real `wdth` axis before geometry: real interpolated outlines beat
 * any remap, so the remap only carries what the axis can't reach. Calibration
 * is by MEASURING shaped run width at candidate coords — axis units are not
 * percent, and every family maps them differently.
 *
 * Horizontal only by design: there is no common height axis, so `stretchY` is
 * always pure remap (see the spec's cascade section).
 */
export function planStretch(
  font: VtFont,
  text: string,
  axes: Record<string, number>,
  S: number,
): StretchPlan {
  const wdth = font.axes.find(a => a.tag === 'wdth')
  if (!wdth || S === 1 || !text) return { coords: { ...axes }, residual: S }
  const current = axes.wdth ?? wdth.default
  const measure = (v: number) => textOutlines(font, text, { ...axes, wdth: v }).width
  const baseWidth = measure(current)
  if (baseWidth <= 0) return { coords: { ...axes }, residual: S }
  const target = baseWidth * S
  // Only spend headroom in the direction of travel from the user's own value.
  const [lo, hi] = S > 1 ? [current, wdth.max] : [wdth.min, current]
  const solved = solveAxis(measure, lo, hi, target)
  const achieved = measure(solved)
  return {
    coords: { ...axes, wdth: solved },
    residual: achieved > 0 ? target / achieved : S,
  }
}

/**
 * Optical colour compensation (Ahrens): a stem of constant measured width
 * reads LIGHTER beside grown counters, so a genuinely drawn Extended cut is a
 * touch heavier. On fonts with a `wght` axis, couple a small weight nudge to
 * the stretch. `amount` is the lab's tuning dial; 1 ≈ 6% of the axis range at
 * S = 2. Ships in Phase B only if the lab says it earns its keep.
 */
export function weightCompensation(
  font: VtFont,
  axes: Record<string, number>,
  S: number,
  SY: number,
  amount = 1,
): Record<string, number> {
  const wght = font.axes.find(a => a.tag === 'wght')
  if (!wght) return { ...axes }
  const growth = Math.max(S, 1 / S) * Math.max(SY, 1 / SY) - 1
  if (growth <= 0) return { ...axes }
  const sign = S * SY >= 1 ? 1 : -1
  const range = wght.max - wght.min
  const base = axes.wght ?? wght.default
  const nudged = base + sign * growth * range * 0.06 * amount
  return { ...axes, wght: Math.min(wght.max, Math.max(wght.min, nudged)) }
}

// TEMP DEBUG — remove before commit
export const __debugResolveStraightMin = resolveStraightMin
export const __debugFlatten = flattenToSegments
export const __debugMarkTerminal = markTerminalCuts
export const __debugBuildGrid = buildGrid
