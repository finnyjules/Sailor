// frontend/app/lib/frame/grid.ts
export interface Rect { x: number; y: number; w: number; h: number }

export interface FrameGrid {
  mode: 'off' | 'explicit' | 'generated'
  baseModule: number    // normalized to frame width; alignment unit
  gutter: number        // normalized to frame width
  margin: number        // normalized to frame width
  columns: number       // explicit mode
  rows: number          // explicit mode
  gen: {
    colRange: [number, number]
    rowRange: [number, number]
    regularity: number  // 0 free … 1 strict/equal
    merge: boolean
    mergeMaxSpan: number
    symmetry: 'none' | 'mirror'
    seed: number
  }
  overlay: boolean
}

export function defaultGrid(): FrameGrid {
  return {
    mode: 'off', baseModule: 1 / 12, gutter: 0.01, margin: 0.04,
    columns: 6, rows: 4,
    gen: { colRange: [3, 7], rowRange: [2, 5], regularity: 0.8, merge: true, mergeMaxSpan: 3, symmetry: 'none', seed: 42 },
    overlay: true,
  }
}

/** Even edges across [start,end] for `n` divisions, gutter-shrunk cells handled by the caller. */
function evenEdges(startPx: number, endPx: number, n: number): number[] {
  const step = (endPx - startPx) / n
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(Math.round(startPx + i * step))
  return out
}

/** From column/row edges, the per-cell region rects (no merge). */
function cellRegions(xs: number[], ys: number[]): Rect[] {
  const out: Rect[] = []
  for (let j = 0; j < ys.length - 1; j++)
    for (let i = 0; i < xs.length - 1; i++)
      out.push({ x: xs[i]!, y: ys[j]!, w: xs[i + 1]! - xs[i]!, h: ys[j + 1]! - ys[j]! })
  return out
}

/** Seeded PRNG (mulberry32) — deterministic stream of floats in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer drawn uniformly from [lo, hi] (inclusive) off the seeded stream. */
function pickInt(rng: () => number, lo: number, hi: number): number {
  if (hi <= lo) return lo
  return lo + Math.floor(rng() * (hi - lo + 1))
}

/**
 * Edge positions for `n` divisions across [startPx, endPx].
 * regularity 0 → free (weighted-random) spacing, pulled toward module lines; regularity 1 →
 * exactly equal spacing (NOT module-snapped — snapping equal widths would un-equalize odd counts).
 * mirror=true makes the resulting widths palindromic (left half drives the right half).
 */
function makeAxisEdges(
  rng: () => number,
  startPx: number,
  endPx: number,
  n: number,
  regularity: number,
  modulePx: number,
  mirror: boolean,
): number[] {
  if (n <= 1) return [Math.round(startPx), Math.round(endPx)]
  const span = endPx - startPx
  const variance = (1 - regularity) * 0.85

  let weights: number[]
  if (mirror) {
    const half = Math.ceil(n / 2)
    const halfWeights: number[] = []
    for (let i = 0; i < half; i++) halfWeights.push(1 + (rng() * 2 - 1) * variance)
    weights = new Array(n)
    for (let i = 0; i < half; i++) {
      weights[i] = halfWeights[i]!
      weights[n - 1 - i] = halfWeights[i]!
    }
  } else {
    weights = []
    for (let i = 0; i < n; i++) weights.push(1 + (rng() * 2 - 1) * variance)
  }
  const sum = weights.reduce((a, b) => a + b, 0)
  const norm = weights.map((wgt) => wgt / sum)
  // Per-segment widths, working in width-space (not absolute position) rather than
  // cumulative edge positions: the module snap below acts on a WIDTH, so a segment's
  // treatment depends only on its own free weight and never on where along the axis it
  // happens to sit. That is what keeps `mirror` exactly palindromic even though the axis
  // now module-snaps at every regularity — snapping absolute positions instead would
  // snap each mirrored edge to whichever module line is nearest ITS coordinate, which
  // differs left vs right and silently breaks the palindrome.
  const freeWidths = norm.map((f) => f * span)

  // "Perfectly regular" target: every column/row gets exactly this width at regularity=1
  // — equal by construction, never itself module-snapped (snapping it would reintroduce
  // the non-equal-at-regularity=1 bug).
  const equalStep = span / n

  const blended = freeWidths.map((freeWidth) => {
    // Lerp the free width toward the equal width FIRST. This single linear blend is what
    // makes convergence monotonic in regularity and exact at regularity=1 (the weight on
    // freeWidth is then zero, so the module snap below — which only ever nudges, and
    // vanishes at regularity=1 — cannot perturb it).
    const target = freeWidth * (1 - regularity) + equalStep * regularity
    if (modulePx <= 0) return target
    // Snap that target to the base module and pull toward it, strongest at low
    // regularity — a Swiss-discipline pull toward module lines when free. NOTE: the
    // sum-to-span rescale below is not module-preserving, so for counts that don't divide
    // the module evenly (e.g. 5, 7 on a 12-module page) the r=0 edges land near, not on,
    // module lines — a known limitation, tracked for a fast-follow. Snapping the pre-blended
    // target rather than the raw free width keeps a continuous, seed-dependent quantity in
    // play at every regularity < 1, so
    // two different seeds whose column count happens to divide the module count evenly
    // don't collapse onto bit-identical edges — only the discrete correction term does.
    const snapped = Math.round(target / modulePx) * modulePx
    // Guard: a target width smaller than half a module can snap to 0, which would
    // collapse a segment to zero width (two coincident edges). Keep it positive.
    return Math.max(target * regularity + snapped * (1 - regularity), 1)
  })

  // Snapping widths independently can drift their sum away from `span`; rescale
  // uniformly to land exactly on it. A uniform scale factor preserves both the
  // regularity=1 equal-width result and the mirror palindrome (same factor applied to
  // every entry of an already-equal or already-palindromic sequence keeps it so).
  const blendedSum = blended.reduce((a, b) => a + b, 0)
  const scale = blendedSum > 0 ? span / blendedSum : 1
  const widths = blended.map((w) => w * scale)

  const out: number[] = [startPx]
  let acc = startPx
  for (let i = 0; i < n; i++) { acc += widths[i]!; out.push(acc) }
  out[out.length - 1] = endPx // clamp accumulated rounding drift
  return out.map((v) => Math.round(v))
}

/**
 * Walk the cell grid in raster order; for each still-unclaimed cell, grow a rectangular
 * unit (bounded by mergeMaxSpan on each axis and by already-claimed neighbours) over
 * unclaimed cells, mark it claimed, and emit its bounding rect. Every cell ends up in
 * exactly one unit, so the result tiles the grid with no gaps or overlaps.
 */
function mergeRegions(xs: number[], ys: number[], mergeMaxSpan: number, rng: () => number): Rect[] {
  const cols = xs.length - 1, rows = ys.length - 1
  const maxSpan = Math.max(1, Math.round(mergeMaxSpan))
  const claimed: boolean[][] = Array.from({ length: cols }, () => new Array(rows).fill(false))
  const out: Rect[] = []

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (claimed[i]![j]) continue

      // widest run of unclaimed cells to the right in this row, capped by maxSpan/grid edge
      let maxW = 1
      while (maxW < Math.min(maxSpan, cols - i) && !claimed[i + maxW]![j]) maxW++
      const spanW = 1 + Math.floor(rng() * maxW)

      // tallest run of rows below where the full [i, i+spanW) slice is still unclaimed
      let maxH = 1
      rowScan: while (maxH < Math.min(maxSpan, rows - j)) {
        const rowY = j + maxH
        for (let x = i; x < i + spanW; x++) if (claimed[x]![rowY]) break rowScan
        maxH++
      }
      const spanH = 1 + Math.floor(rng() * maxH)

      for (let y = j; y < j + spanH; y++)
        for (let x = i; x < i + spanW; x++)
          claimed[x]![y] = true

      out.push({ x: xs[i]!, y: ys[j]!, w: xs[i + spanW]! - xs[i]!, h: ys[j + spanH]! - ys[j]! })
    }
  }
  return out
}

/**
 * Inset every region by the gutter, leaving a gutter-wide gap between cells.
 * Applied once, centrally, after regions are computed (explicit or generated) —
 * `xs`/`ys` (the snap lines) stay at the cell boundaries; only the drawn
 * regions shrink. gutterPx<=0 is a no-op.
 */
function applyGutter(regions: Rect[], gutterPx: number): Rect[] {
  if (gutterPx <= 0) return regions
  return regions.map(r => ({
    x: r.x + gutterPx / 2,
    y: r.y + gutterPx / 2,
    w: Math.max(1, r.w - gutterPx),
    h: Math.max(1, r.h - gutterPx),
  }))
}

/**
 * `unitW` (default `w`): the width every normalized grid dimension (margin, gutter,
 * base module) is a fraction OF. Today's callers omit it, so it is `w` and the
 * result is byte-identical. The responsive resolver passes the FITTED design width
 * so margins and gutters follow the fit scale while the columns share the box.
 */
export function resolveGrid(grid: FrameGrid, w: number, h: number, unitW: number = w): { xs: number[]; ys: number[]; regions: Rect[] } {
  if (grid.mode === 'off') return { xs: [], ys: [], regions: [] }
  // Clamp so an extreme margin (agent-set or hand-typed) can't push the two
  // insets past each other and invert the grid (negative-width regions).
  const m = Math.min(Math.max(grid.margin, 0), 0.45)
  const mx = m * unitW, my = m * unitW   // margin normalized to the UNIT width on both axes (uniform inset)
  let xs: number[]
  let ys: number[]
  let regions: Rect[]
  if (grid.mode === 'explicit') {
    xs = evenEdges(mx, w - mx, Math.max(1, Math.round(grid.columns)))
    ys = evenEdges(my, h - my, Math.max(1, Math.round(grid.rows)))
    regions = cellRegions(xs, ys)
  } else {
    // generated
    const rng = mulberry32(grid.gen.seed)
    const cols = pickInt(rng, grid.gen.colRange[0], grid.gen.colRange[1])
    const rows = pickInt(rng, grid.gen.rowRange[0], grid.gen.rowRange[1])
    const modulePx = grid.baseModule * unitW
    const mirror = grid.gen.symmetry === 'mirror'
    xs = makeAxisEdges(rng, mx, w - mx, cols, grid.gen.regularity, modulePx, mirror)
    ys = makeAxisEdges(rng, my, h - my, rows, grid.gen.regularity, modulePx, mirror)
    regions = grid.gen.merge
      ? mergeRegions(xs, ys, grid.gen.mergeMaxSpan, rng)
      : cellRegions(xs, ys)
  }
  const gutterPx = grid.gutter * unitW
  return { xs, ys, regions: applyGutter(regions, gutterPx) }
}
