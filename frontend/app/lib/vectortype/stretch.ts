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
}

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
}

const DEFAULT_BINS = 64
const DEFAULT_K = 2
/** Default small-feature limit as a fraction of the em. An i's dot or a
 *  period is ~0.1–0.15 em; the smallest real letterform parts (a lowercase
 *  counter) are well above 0.3 em. */
export const SMALL_FEATURE_EM = 0.22
/** Curve flattening steps for ANALYSIS only — the remap itself moves the real
 *  control points, so this resolution never appears in output geometry. */
const CURVE_STEPS = 16

interface Seg { x0: number; y0: number; x1: number; y1: number }

/** Flatten commands to line segments for tangent analysis. closePath emits the
 *  implicit closing segment — without it every subpath would leak a fake gap
 *  of "no ink" where the closing edge runs. */
function flattenToSegments(commands: readonly PathCommand[]): Seg[] {
  const segs: Seg[] = []
  let px = 0, py = 0
  let sx = 0, sy = 0
  const emit = (x1: number, y1: number) => {
    if (x1 !== px || y1 !== py) segs.push({ x0: px, y0: py, x1, y1 })
    px = x1; py = y1
  }
  for (const c of commands) {
    const a = c.args
    switch (c.command) {
      case 'moveTo':
        px = a[0]!; py = a[1]!; sx = px; sy = py
        break
      case 'lineTo':
        emit(a[0]!, a[1]!)
        break
      case 'quadraticCurveTo': {
        const [cx, cy, x, y] = a as [number, number, number, number]
        const x0 = px, y0 = py
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t
          emit(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y)
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
          )
        }
        break
      }
      case 'closePath':
        emit(sx, sy)
        break
    }
  }
  return segs
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

export function analyzeFlex(
  commands: readonly PathCommand[],
  bbox: VtBBox,
  opts: FlexOptions = {},
): GlyphFlex {
  const bins = Math.max(4, Math.round(opts.bins ?? DEFAULT_BINS))
  const k = Math.max(0, opts.k ?? DEFAULT_K)
  const smallFeature = opts.smallFeature ?? 0
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const flexX = new Float64Array(bins).fill(1)
  const flexY = new Float64Array(bins).fill(1)
  const out: GlyphFlex = {
    x: { start: bbox.minX, binSize: w > 0 ? w / bins : 1, flex: flexX },
    y: { start: bbox.minY, binSize: h > 0 ? h / bins : 1, flex: flexY },
  }
  if (w <= 0 || h <= 0 || !commands.length) return out

  const segs = flattenToSegments(commands)
  if (!segs.length) return out
  const cw = w / GRID
  const ch = h / GRID
  const N = GRID * GRID
  const dist = new Float64Array(N).fill(Infinity)
  // |tangent·x̂| and |tangent·ŷ| of the nearest boundary, propagated together
  // with the distance (the nearest boundary is one point; both alignments
  // come from its one tangent).
  const ax = new Float64Array(N).fill(1)
  const ay = new Float64Array(N).fill(1)
  const idx = (c: number, r: number) => r * GRID + c

  // Stamp boundary cells with exact segment tangents. Where two segments meet
  // in one cell (corners), keep the more rigid alignment per axis — the min
  // in the flex formula makes conservative-rigid the faithful tie-break.
  for (const s of segs) {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0
    const len = Math.hypot(dx, dy)
    if (len === 0) continue
    const tx = Math.abs(dx) / len
    const ty = Math.abs(dy) / len
    const steps = Math.max(1, Math.ceil(len / (Math.min(cw, ch) * 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const c = Math.max(0, Math.min(GRID - 1, Math.floor((s.x0 + dx * t - bbox.minX) / cw)))
      const r = Math.max(0, Math.min(GRID - 1, Math.floor((s.y0 + dy * t - bbox.minY) / ch)))
      const j = idx(c, r)
      if (dist[j]! > 0) { dist[j] = 0; ax[j] = tx; ay[j] = ty }
      else { ax[j] = Math.min(ax[j]!, tx); ay[j] = Math.min(ay[j]!, ty) }
    }
  }

  // Two-pass chamfer: propagate (distance, tangent) from each cell's already-
  // visited neighbours. Step costs are in FONT UNITS, not grid steps — the
  // grid is GRID×GRID over a bbox that is usually far from square (a stem is
  // ~100×700), and unit-step costs would let a stem's caps out-compete its
  // side walls for half the interior, mislabelling it flexible in Y.
  const costH = cw
  const costV = ch
  const costD = Math.hypot(cw, ch)
  const relax = (j: number, n: number, cost: number) => {
    const d = dist[n]! + cost
    if (d < dist[j]!) { dist[j] = d; ax[j] = ax[n]!; ay[j] = ay[n]! }
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
      // the grid is anisotropic over non-square bboxes.
      if (Math.max((c1 - c0 + 1) * cw, (r1 - r0 + 1) * ch) < smallFeature) {
        for (const cell of cells) { ax[cell] = 0; ay[cell] = 0 }
      }
    }
  }

  // Per-column / per-row minima over INK cells only, then downsample to bins.
  // colInk/rowInk count ink cells per column/row in the same pass, so bins
  // can report how much of their span is actually ink (vs. counters/gaps).
  const colMin = new Float64Array(GRID).fill(1)
  const rowMin = new Float64Array(GRID).fill(1)
  const colInk = new Float64Array(GRID)
  const rowInk = new Float64Array(GRID)
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const j = idx(c, r)
      if (!ink[j]) continue
      colInk[c]!++
      rowInk[r]!++
      if (ax[j]! < colMin[c]!) colMin[c] = ax[j]!
      if (ay[j]! < rowMin[r]!) rowMin[r] = ay[j]!
    }
  }
  const inkX = new Float64Array(bins)
  const inkY = new Float64Array(bins)
  const cellsPerBin = GRID / bins
  for (let b = 0; b < bins; b++) {
    let mx = 1, my = 1
    let ix = 0, iy = 0
    const g0 = Math.floor(b * cellsPerBin)
    const g1 = Math.min(GRID - 1, Math.ceil((b + 1) * cellsPerBin) - 1)
    for (let g = g0; g <= g1; g++) {
      if (colMin[g]! < mx) mx = colMin[g]!
      if (rowMin[g]! < my) my = rowMin[g]!
      if (colInk[g]! / GRID > ix) ix = colInk[g]! / GRID
      if (rowInk[g]! / GRID > iy) iy = rowInk[g]! / GRID
    }
    flexX[b] = Math.pow(mx, k)
    flexY[b] = Math.pow(my, k)
    inkX[b] = ix
    inkY[b] = iy
  }
  out.x.ink = inkX
  out.y.ink = inkY
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

function binWidths(flex: Float64Array, w: number, S: number, ink?: Float64Array): Float64Array {
  const n = flex.length
  const out = new Float64Array(n).fill(w)
  const total = n * w
  const delta = (S - 1) * total
  if (Math.abs(delta) < 1e-12) return out
  if (delta > 0) {
    let sum0 = 0
    for (const f of flex) sum0 += f
    if (sum0 < 1e-9) return out   // all-rigid: the glyph cannot widen
    const cap = PARTIAL_GROWTH_CAP * S * w
    let remaining = delta
    for (let pass = 0; pass < 4 && remaining > 1e-9; pass++) {
      let sum = 0
      for (let i = 0; i < n; i++) {
        if (!(flex[i]! > 0)) continue
        if (flex[i]! >= FULL_FLEX || out[i]! < cap - 1e-12) sum += flex[i]!
      }
      if (sum < 1e-9) break
      let absorbed = 0
      for (let i = 0; i < n; i++) {
        if (!(flex[i]! > 0)) continue
        const full = flex[i]! >= FULL_FLEX
        if (!full && out[i]! >= cap - 1e-12) continue
        const want = remaining * (flex[i]! / sum)
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
    return out
  }
  // Condense. Rigid bins (flex < 0.05) are a STEM: a typeface has ONE stem
  // width, so how much a stem thins follows the deterministic `stemFactor(S)`
  // schedule alone — identical for every glyph, never negotiated per-glyph
  // against what else the glyph happens to hold. A counter-less 'I' simply
  // under-condenses instead of stealing weight consistency from its
  // neighbours.
  // The stems' own reduction already counts against the deficit — without
  // subtracting it here, the counter waterfall below runs against the FULL
  // original deficit on top of what the stems just gave, and the two
  // reductions stack: the glyph condenses past S instead of landing on it.
  let deficit = -delta
  for (let i = 0; i < n; i++) {
    if (flex[i]! < 0.05) {
      const thinned = w * stemFactor(S)
      deficit -= w - thinned
      out[i] = thinned
    }
  }
  // The rest of the ORDER OF SACRIFICE: empty space (counters, gaps) gives
  // first but floors at EMPTY_BIN_FLOOR — thinner reads as a crack, not a
  // counter. Ink running parallel to the stretch (arches, crossbars, spines)
  // shortens next, floored higher: a curve needs room to turn. Each bin gets
  // its own floor from what it actually holds.
  const floor = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const isInk = ink ? ink[i]! > 0 : flex[i]! < FULL_FLEX
    floor[i] = w * (flex[i]! < 0.05 ? RIGID_BIN_FLOOR : isInk ? INK_BIN_FLOOR : EMPTY_BIN_FLOOR)
  }
  // Phase 1 (and only phase): bins that resist the stretch least (non-rigid —
  // empty space and ink-bearing-but-flexible slices) shrink toward their OWN
  // floor, proportional to flex, over up to 4 waterfall passes (a bin hitting
  // its floor stops absorbing and the rest re-split what's left). Gated on
  // `flex >= 0.05`, the same rigid cut used for the preset above and the floor
  // table below — NOT `flex > 0` — because a real glyph's "rigid" column is
  // never exactly 0 (chamfer-propagated tangents leave float noise like
  // 0.00013); gating on literal positivity would let the stem's own bins
  // sneak back into this waterfall and thin a second time on top of their
  // schedule width. There is no second, headroom-proportional phase over all
  // bins: the stems already had their say above, and letting counters
  // renegotiate against the stems' fixed contribution is exactly the
  // per-glyph negotiation that made an 'I' thin its one stem to reach S while
  // an 'L' left its stem untouched. Whatever deficit is left when every
  // eligible bin has floored is dropped — consistency of stem weight beats
  // reaching S exactly; the run-level advance still tightens.
  for (let pass = 0; pass < 4 && deficit > 1e-9; pass++) {
    let sum = 0
    for (let i = 0; i < n; i++) if (flex[i]! >= 0.05 && out[i]! > floor[i]! + 1e-12) sum += flex[i]!
    if (sum < 1e-9) break
    let taken = 0
    for (let i = 0; i < n; i++) {
      if (!(flex[i]! >= 0.05) || out[i]! <= floor[i]! + 1e-12) continue
      const can = Math.min(deficit * (flex[i]! / sum), out[i]! - floor[i]!)
      out[i]! -= can
      taken += can
    }
    deficit -= taken
    if (taken < 1e-12) break
  }
  return out
}

export function buildRemap(profile: FlexProfile, S: number, fixedPoint?: number): Remap {
  const { start, binSize: w, flex, ink } = profile
  const n = flex.length
  const widths = binWidths(flex, w, S, ink)
  const src = new Float64Array(n + 1)
  const dst = new Float64Array(n + 1)
  let acc = start
  for (let i = 0; i <= n; i++) {
    src[i] = start + i * w
    dst[i] = acc
    if (i < n) acc += widths[i]!
  }
  const m = { src, dst }
  if (fixedPoint !== undefined) {
    const shift = remapValue(m, fixedPoint) - fixedPoint
    for (let i = 0; i <= n; i++) dst[i]! -= shift
  }
  return m
}

/** Piecewise-linear lookup; slope 1 outside the profile's span so points a
 *  hair beyond the bbox (rounding, overshoot) translate instead of scaling. */
export function remapValue(m: Remap, v: number): number {
  const { src, dst } = m
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
  const t = span > 0 ? (v - src[lo]!) / span : 0
  return dst[lo]! + t * (dst[lo + 1]! - dst[lo]!)
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
  const key = `${opts.bins ?? DEFAULT_BINS}|${opts.k ?? DEFAULT_K}|${opts.smallFeature ?? 0}`
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
  const flexOpts: FlexOptions = { smallFeature: SMALL_FEATURE_EM * outlines.unitsPerEm, ...opts }
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
      const rx = buildRemap(flex.x, S)
      const ry = buildRemap(flex.y, SY, 0)
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
