/**
 * Vector Type Studio — STROKE-VECTOR SKELETON SPIKE (Stage 1). PURE.
 *
 * Dev-only, throwaway-quality-allowed research. ONE job: measure whether a
 * stroke skeleton + thickness extracted from a shipped font outline
 * re-inflates to the drawn glyph within ~1 pixel. See the charter:
 *   docs/superpowers/spikes/2026-09-03-stroke-vector-skeleton-spike.md
 *
 * The medial-axis theorem: a shape is the union of its maximal inscribed
 * disks, so the RIDGE of the interior distance-to-boundary field (with radius
 * = the field value there) reconstructs the glyph. A perfect ridge is exact,
 * so the round-trip error we measure is exactly how lossy the DISCRETE
 * extraction is.
 *
 * `stretch.ts`'s `analyzeGrid` already computes that distance field over a
 * fixed 96×96 grid (and now exposes it as `AnalysisGrid.dist`). This spike
 * needs the field at an ARBITRARY resolution (96 vs 192 is the load-bearing
 * comparison), and `GRID` there is a module constant, so we rebuild the same
 * two-pass chamfer field here parametrised by grid size. `dist` is untouched
 * by `analyzeGrid`'s terminal / small-feature patches (those only rewrite
 * `ax`/`ay`/`kind`), so at grid 96 this builder reproduces `analyzeGrid.dist`
 * — the harness cross-checks that.
 *
 * Coordinates are FONT UNITS (y-up), matching `outline.ts`.
 */
import type { GlyphOutline, PathCommand, VtBBox } from './outline'

const CURVE_STEPS = 16 // matches stretch.ts's flattener

// ── Skeleton types ─────────────────────────────────────────────────────────

export interface SkeletonPoint {
  x: number
  y: number
  /** Half stroke thickness at this point, in FONT UNITS (= dist at its cell). */
  halfWidth: number
}

export interface StrokeSkeleton {
  /** Skeleton points in FONT UNITS, grouped into traced polylines. */
  strokes: SkeletonPoint[][]
  unitsPerEm: number
  /** Bookkeeping the measurement harness inspects (not part of the theorem). */
  meta: {
    grid: number
    bbox: VtBBox
    /** Ridge cells with ≥3 ridge neighbours after thinning (junctions). */
    junctionCount: number
    ridgeCells: number
  }
}

interface Seg { x0: number; y0: number; x1: number; y1: number }

interface Field {
  grid: number
  cw: number
  ch: number
  dist: Float64Array
  ink: Uint8Array
  bbox: VtBBox
}

// ── Flattening (curves → line segments), same scheme as stretch.ts ──────────

function flatten(commands: readonly PathCommand[]): Seg[] {
  const segs: Seg[] = []
  let px = 0, py = 0, sx = 0, sy = 0
  const emit = (x1: number, y1: number) => {
    if (x1 !== px || y1 !== py) segs.push({ x0: px, y0: py, x1, y1 })
    px = x1; py = y1
  }
  for (const c of commands) {
    const a = c.args
    switch (c.command) {
      case 'moveTo': px = a[0]!; py = a[1]!; sx = px; sy = py; break
      case 'lineTo': emit(a[0]!, a[1]!); break
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
      case 'closePath': emit(sx, sy); break
    }
  }
  return segs
}

/** Even-odd scanline fill into a `res`-wide row of a mask, at pixel-centre
 *  sampling. Shared by the field's ink and by `inkMask`. */
function scanlineRow(segs: Seg[], yLine: number, minX: number, pw: number, res: number): [number, number][] {
  const xs: number[] = []
  for (const s of segs) {
    if ((s.y0 <= yLine && s.y1 > yLine) || (s.y1 <= yLine && s.y0 > yLine)) {
      xs.push(s.x0 + ((yLine - s.y0) / (s.y1 - s.y0)) * (s.x1 - s.x0))
    }
  }
  xs.sort((a, b) => a - b)
  const spans: [number, number][] = []
  for (let i = 0; i + 1 < xs.length; i += 2) {
    let c0 = Math.ceil((xs[i]! - minX) / pw - 0.5)
    let c1 = Math.floor((xs[i + 1]! - minX) / pw - 0.5)
    c0 = Math.max(0, c0)
    c1 = Math.min(res - 1, c1)
    if (c1 >= c0) spans.push([c0, c1])
  }
  return spans
}

// ── Distance field (two-pass chamfer, font-unit step costs) ─────────────────

function buildField(commands: readonly PathCommand[], bbox: VtBBox, grid: number): Field {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const cw = w > 0 ? w / grid : 1
  const ch = h > 0 ? h / grid : 1
  const N = grid * grid
  const dist = new Float64Array(N).fill(Infinity)
  const ink = new Uint8Array(N)
  const idx = (c: number, r: number) => r * grid + c
  if (w <= 0 || h <= 0) return { grid, cw, ch, dist: new Float64Array(N), ink, bbox }

  const segs = flatten(commands)

  // Stamp boundary cells (dist 0) by walking each segment at sub-cell steps.
  for (const s of segs) {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0
    const len = Math.hypot(dx, dy)
    if (len === 0) continue
    const steps = Math.max(1, Math.ceil(len / (Math.min(cw, ch) * 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const c = Math.max(0, Math.min(grid - 1, Math.floor((s.x0 + dx * t - bbox.minX) / cw)))
      const r = Math.max(0, Math.min(grid - 1, Math.floor((s.y0 + dy * t - bbox.minY) / ch)))
      dist[idx(c, r)] = 0
    }
  }

  const costH = cw, costV = ch, costD = Math.hypot(cw, ch)
  const relax = (j: number, n: number, cost: number) => {
    const d = dist[n]! + cost
    if (d < dist[j]!) dist[j] = d
  }
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const j = idx(c, r)
      if (c > 0) relax(j, idx(c - 1, r), costH)
      if (r > 0) relax(j, idx(c, r - 1), costV)
      if (c > 0 && r > 0) relax(j, idx(c - 1, r - 1), costD)
      if (c < grid - 1 && r > 0) relax(j, idx(c + 1, r - 1), costD)
    }
  }
  for (let r = grid - 1; r >= 0; r--) {
    for (let c = grid - 1; c >= 0; c--) {
      const j = idx(c, r)
      if (c < grid - 1) relax(j, idx(c + 1, r), costH)
      if (r < grid - 1) relax(j, idx(c, r + 1), costV)
      if (c < grid - 1 && r < grid - 1) relax(j, idx(c + 1, r + 1), costD)
      if (c > 0 && r < grid - 1) relax(j, idx(c - 1, r + 1), costD)
    }
  }

  // Ink mask by even-odd scanline (row centres).
  for (let r = 0; r < grid; r++) {
    const yLine = bbox.minY + (r + 0.5) * ch
    for (const [c0, c1] of scanlineRow(segs, yLine, bbox.minX, cw, grid)) {
      for (let c = c0; c <= c1; c++) ink[idx(c, r)] = 1
    }
  }

  return { grid, cw, ch, dist, ink, bbox }
}

// ── Ridge extraction ────────────────────────────────────────────────────────

/** Interior ink cell is a ridge cell when it is a local maximum of `dist`
 *  along whichever axis has the steeper `dist` gradient — an approximate
 *  medial axis. Small tolerance keeps flat ridge plateaus connected. */
function ridgeMask(f: Field): Uint8Array {
  const { grid, dist, ink } = f
  const idx = (c: number, r: number) => r * grid + c
  const ridge = new Uint8Array(grid * grid)
  const eps = 1e-6
  for (let r = 1; r < grid - 1; r++) {
    for (let c = 1; c < grid - 1; c++) {
      const j = idx(c, r)
      if (!ink[j] || dist[j]! <= 0) continue
      const dl = dist[idx(c - 1, r)]!, dr = dist[idx(c + 1, r)]!
      const du = dist[idx(c, r - 1)]!, dd = dist[idx(c, r + 1)]!
      const gx = Math.abs(dr - dl)
      const gy = Math.abs(dd - du)
      const here = dist[j]!
      if (gx >= gy) {
        if (here >= dl - eps && here >= dr - eps) ridge[j] = 1
      } else {
        if (here >= du - eps && here >= dd - eps) ridge[j] = 1
      }
    }
  }
  return ridge
}

// ── Morphological thinning (Zhang-Suen) to 1-cell width ─────────────────────

function thin(mask: Uint8Array, grid: number): Uint8Array {
  const m = mask.slice()
  const idx = (c: number, r: number) => r * grid + c
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= grid || r >= grid ? 0 : m[idx(c, r)]!)
  let changed = true
  const toClear: number[] = []
  while (changed) {
    changed = false
    for (let sub = 0; sub < 2; sub++) {
      toClear.length = 0
      for (let r = 1; r < grid - 1; r++) {
        for (let c = 1; c < grid - 1; c++) {
          if (!m[idx(c, r)]) continue
          // 8-neighbours clockwise from north.
          const p2 = at(c, r - 1), p3 = at(c + 1, r - 1), p4 = at(c + 1, r)
          const p5 = at(c + 1, r + 1), p6 = at(c, r + 1), p7 = at(c - 1, r + 1)
          const p8 = at(c - 1, r), p9 = at(c - 1, r - 1)
          const bp = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (bp < 2 || bp > 6) continue
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let ap = 0
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) ap++
          if (ap !== 1) continue
          if (sub === 0) {
            if (p2 * p4 * p6 !== 0) continue
            if (p4 * p6 * p8 !== 0) continue
          } else {
            if (p2 * p4 * p8 !== 0) continue
            if (p2 * p6 * p8 !== 0) continue
          }
          toClear.push(idx(c, r))
        }
      }
      if (toClear.length) {
        changed = true
        for (const j of toClear) m[j] = 0
      }
    }
  }
  return m
}

// ── Trace connected ridge cells into polylines ──────────────────────────────

const NEI8: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
]

function tracePolylines(
  mask: Uint8Array,
  grid: number,
  toPoint: (c: number, r: number) => SkeletonPoint,
): { strokes: SkeletonPoint[][]; junctions: number } {
  const idx = (c: number, r: number) => r * grid + c
  const neighbours = (j: number): number[] => {
    const c = j % grid, r = (j / grid) | 0
    const out: number[] = []
    for (const [dc, dr] of NEI8) {
      const nc = c + dc, nr = r + dr
      if (nc < 0 || nr < 0 || nc >= grid || nr >= grid) continue
      if (mask[idx(nc, nr)]) out.push(idx(nc, nr))
    }
    return out
  }
  const deg = new Int32Array(grid * grid)
  const cells: number[] = []
  let junctions = 0
  for (let j = 0; j < mask.length; j++) {
    if (!mask[j]) continue
    cells.push(j)
    deg[j] = neighbours(j).length
    if (deg[j]! >= 3) junctions++
  }
  const strokes: SkeletonPoint[][] = []
  // Mark each undirected edge visited once via a Set of "min-max" keys.
  const edgeSeen = new Set<number>()
  const edgeKey = (a: number, b: number) => (a < b ? a * mask.length + b : b * mask.length + a)
  const cellPoint = (j: number) => toPoint(j % grid, (j / grid) | 0)

  const walk = (start: number, first: number) => {
    const line: SkeletonPoint[] = [cellPoint(start)]
    let prev = start, cur = first
    edgeSeen.add(edgeKey(prev, cur))
    line.push(cellPoint(cur))
    // Continue while the current cell is a simple path cell (degree 2).
    while (deg[cur] === 2) {
      const ns = neighbours(cur).filter(n => n !== prev)
      // Prefer the unvisited edge; a degree-2 cell has exactly one forward.
      const next = ns.find(n => !edgeSeen.has(edgeKey(cur, n)))
      if (next === undefined) break
      edgeSeen.add(edgeKey(cur, next))
      line.push(cellPoint(next))
      prev = cur; cur = next
    }
    return line
  }

  // 1) Start from endpoints and junctions (nodes), walking each incident edge.
  for (const j of cells) {
    if (deg[j] === 2) continue
    for (const n of neighbours(j)) {
      if (edgeSeen.has(edgeKey(j, n))) continue
      strokes.push(walk(j, n))
    }
  }
  // 2) Pure loops (every cell degree 2, no node touched) — seed anywhere.
  for (const j of cells) {
    const ns = neighbours(j)
    for (const n of ns) {
      if (edgeSeen.has(edgeKey(j, n))) continue
      strokes.push(walk(j, n))
    }
  }
  return { strokes: strokes.filter(s => s.length >= 1), junctions }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function skeletonize(
  glyph: GlyphOutline,
  opts: { grid?: number; unitsPerEm?: number } = {},
): StrokeSkeleton {
  const grid = opts.grid ?? 96
  const bbox = glyph.bbox
  const f = buildField(glyph.commands, bbox, grid)
  const ridge = ridgeMask(f)
  const thinned = thin(ridge, grid)
  let ridgeCells = 0
  for (let j = 0; j < thinned.length; j++) if (thinned[j]) ridgeCells++
  const toPoint = (c: number, r: number): SkeletonPoint => ({
    x: bbox.minX + (c + 0.5) * f.cw,
    y: bbox.minY + (r + 0.5) * f.ch,
    halfWidth: f.dist[r * grid + c]!,
  })
  const { strokes, junctions } = tracePolylines(thinned, grid, toPoint)
  return {
    strokes,
    unitsPerEm: opts.unitsPerEm ?? 1000,
    meta: { grid, bbox, junctionCount: junctions, ridgeCells },
  }
}

/** Re-inflate the skeleton to a `res`×`res` mask over `bbox`. A pixel is ink
 *  iff it lies within `halfWidth` of some stroke point (union of disks). */
export function inflateMask(skel: StrokeSkeleton, bbox: VtBBox, res: number): Uint8Array {
  const mask = new Uint8Array(res * res)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  if (w <= 0 || h <= 0) return mask
  const pw = w / res, ph = h / res
  for (const line of skel.strokes) {
    for (const p of line) {
      const hw = p.halfWidth
      if (!(hw > 0)) continue
      const c0 = Math.max(0, Math.floor((p.x - hw - bbox.minX) / pw))
      const c1 = Math.min(res - 1, Math.ceil((p.x + hw - bbox.minX) / pw))
      const r0 = Math.max(0, Math.floor((p.y - hw - bbox.minY) / ph))
      const r1 = Math.min(res - 1, Math.ceil((p.y + hw - bbox.minY) / ph))
      const hw2 = hw * hw
      for (let r = r0; r <= r1; r++) {
        const fy = bbox.minY + (r + 0.5) * ph
        const dy = fy - p.y
        for (let c = c0; c <= c1; c++) {
          const fx = bbox.minX + (c + 0.5) * pw
          const dx = fx - p.x
          if (dx * dx + dy * dy <= hw2) mask[r * res + c] = 1
        }
      }
    }
  }
  return mask
}

/** The drawn glyph's own even-odd ink mask at `res`×`res` over `bbox`. */
export function inkMask(glyph: GlyphOutline, bbox: VtBBox, res: number): Uint8Array {
  const mask = new Uint8Array(res * res)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  if (w <= 0 || h <= 0) return mask
  const pw = w / res, ph = h / res
  const segs = flatten(glyph.commands)
  for (let r = 0; r < res; r++) {
    const yLine = bbox.minY + (r + 0.5) * ph
    for (const [c0, c1] of scanlineRow(segs, yLine, bbox.minX, pw, res)) {
      for (let c = c0; c <= c1; c++) mask[r * res + c] = 1
    }
  }
  return mask
}

function boundaryCells(mask: Uint8Array, res: number): number[] {
  const out: number[] = []
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const j = r * res + c
      if (!mask[j]) continue
      const edge =
        c === 0 || r === 0 || c === res - 1 || r === res - 1 ||
        !mask[j - 1] || !mask[j + 1] || !mask[j - res] || !mask[j + res]
      if (edge) out.push(j)
    }
  }
  return out
}

/** 1 − IoU, and the max boundary deviation (a Hausdorff distance between the
 *  two masks' boundaries) as a fraction of the em. `upem` divides the
 *  font-unit deviation; res/bbox give the pixel→font-unit scale. */
export function roundTripError(
  a: Uint8Array,
  b: Uint8Array,
  res: number,
  bbox: VtBBox,
  upem: number,
): { mismatch: number; maxDevEm: number } {
  let inter = 0, union = 0
  for (let j = 0; j < a.length; j++) {
    const ai = a[j]!, bi = b[j]!
    if (ai && bi) inter++
    if (ai || bi) union++
  }
  const mismatch = union === 0 ? 0 : 1 - inter / union

  const pw = (bbox.maxX - bbox.minX) / res
  const ph = (bbox.maxY - bbox.minY) / res
  const ba = boundaryCells(a, res)
  const bb = boundaryCells(b, res)
  const px = (j: number) => bbox.minX + ((j % res) + 0.5) * pw
  const py = (j: number) => bbox.minY + (((j / res) | 0) + 0.5) * ph
  // Directed max: for every boundary pixel of one set, nearest in the other.
  const directed = (from: number[], to: number[]): number => {
    if (!from.length || !to.length) return 0
    let worst = 0
    const tx = to.map(px), ty = to.map(py)
    for (const j of from) {
      const fx = px(j), fy = py(j)
      let best = Infinity
      for (let k = 0; k < to.length; k++) {
        const dx = fx - tx[k]!, dy = fy - ty[k]!
        const d = dx * dx + dy * dy
        if (d < best) best = d
      }
      const d = Math.sqrt(best)
      if (d > worst) worst = d
    }
    return worst
  }
  const hausdorff = Math.max(directed(ba, bb), directed(bb, ba))
  return { mismatch, maxDevEm: upem > 0 ? hausdorff / upem : 0 }
}

/** Exposed for the harness's grid-96 cross-check against `analyzeGrid.dist`. */
export function _debugField(glyph: GlyphOutline, grid: number): Field {
  return buildField(glyph.commands, glyph.bbox, grid)
}
