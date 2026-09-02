/**
 * Vector Type Studio — 2D DEFORMATION FIELD stretch. PURE. SPIKE (2026-09-02).
 *
 * The shipped engine (`stretch.ts`) stretches a glyph as two independent
 * 1D remaps — one per axis — shaped by a pile of slice-model patches (bell,
 * turn taper, C1 remap, symmetric solve …) because two 1D maps cannot see a
 * stroke. This module deforms the ink as a BODY instead: a lattice over the
 * glyph with per-cell ANISOTROPIC, STROKE-AWARE stiffness read off the same
 * tangent analysis (`analyzeGrid`), the advance box and the font's zone
 * lines as hard constraints, solved as two sparse SPD least-squares systems
 * (one per displacement component — see Energy). Outline points (anchors
 * AND control points) ride the deformed lattice, so the command count stays
 * constant — the property the motion system relies on.
 *
 * Model
 *  • Lattice: N×N vertices; columns uniform over the glyph's ADVANCE BOX in
 *    X (so sidebearings are part of the body and absorb an `l`'s growth —
 *    `advanceBox: false` uses the ink bbox instead), rows uniform over the
 *    ink bbox in Y with the row nearest each zone line SNAPPED onto it, so
 *    zone constraints are exact.
 *  • Stiffness per cell from the analysis grid (ink fraction f, mean over
 *    ink of the nearest boundary's alignment ax², ay²):
 *      kx = f·(base + strong·ay²) + (1−f)·soft   — a vertical stroke resists
 *                                                   changing WIDTH
 *      ky = f·(base + strong·ax²) + (1−f)·soft   — a horizontal stroke resists
 *                                                   changing HEIGHT
 *      ks = f·shearBase + (1−f)·softShear         — ink resists SHEAR
 *      small-feature / terminal-patch cells: all three = rigid.
 *  • Energy, two DECOUPLED systems (one per displacement component):
 *      x:  Σ kx·(Δdx)²/Lx over horizontal edges  — axial strain across a
 *                                                   vertical stroke
 *        + Σ ks·(Δdx)²/Ly over vertical edges    — dx must not vary ALONG a
 *                                                   stroke: no shear, no
 *                                                   local rotation
 *      y:  Σ ky·(Δdy)²/Ly over vertical edges + Σ ks·(Δdy)²/Lx over
 *          horizontal edges, likewise,
 *    plus a tiny isotropic first-order smoothness on every edge so the
 *    field stays smooth in whitespace. Both are weighted graph Laplacians:
 *    linear, SPD once constrained. The "shear" term penalises ∂dx/∂y and
 *    ∂dy/∂x SEPARATELY rather than their sum (engineering shear): a first
 *    build coupled the two through the diagonals' strain difference and
 *    under a pure Height dial the solver answered with local ROTATIONS —
 *    shoulders turning, flanks sliding sideways — which is physically
 *    right for an elastic sheet and typographically wrong (L9: parallel
 *    strokes stay parallel; L14: slant is a constant). Forbidding rotation
 *    is what makes the two systems independent.
 *  • Constraints by elimination: left/right lattice columns → x·S; rows on
 *    zone lines inside the bbox → y·SY (baseline fixed); a glyph with no
 *    zone line inside it constrains its top/bottom rows instead. Everything
 *    else is free — including the overshoot slivers beyond the outermost
 *    zone line, which nothing pulls (L8, constant overshoot, is emergent).
 *  • Solve: Jacobi-preconditioned conjugate gradient, then a compressive
 *    BARRIER pass: cells squeezed below `barrierFloor` of their rest size
 *    stiffen on that axis and the system is re-solved (contact physics —
 *    whitespace compresses until it is gone, then it is solid). Under a
 *    hard width target this is what keeps deep condense from folding the
 *    sidebearings through zero; it does not clear every fold (see the
 *    spike report) and it hands the leftover shrink to the ink.
 *  • Lattice size: 25 (24×24 cells) by default. NOT finer: the residual
 *    ripple on a stretched curve is lattice-scale — the stiffness staircase
 *    where a stroke's boundary crosses partially-inked cells — and it grows
 *    with resolution (Inter o at Width 1.8: 0 inflections at n = 25, 8 at
 *    33, 4 at 49, 8 at 65). Neither a blur of the stiffness field nor a
 *    series (harmonic) ink/whitespace mix removes it.
 *  • Apply: bicubic (Catmull-Rom in x, non-uniform cubic Hermite in y)
 *    interpolation of the lattice DISPLACEMENT — C1, so a curve crossing a
 *    cell edge picks up no curvature kink (`interp: 'bilinear'` is the
 *    plain C0 map for comparison).
 *
 * Coordinates are FONT UNITS, y-up, baseline at y = 0, matching outline.ts.
 * Deliberately no rules here — no order of sacrifice, no floors, no terminal
 * angles: only stiffness, zones and constraints. What the laws then get for
 * free is the spike's finding.
 */
import type { GlyphOutline, PathCommand, TextOutlines, VtBBox, FontMetrics } from './outline'
import { analyzeGrid, SMALL_FEATURE_EM, STRAIGHT_MIN_EM } from './stretch'
import type { FlexOptions } from './stretch'

export interface Field2DOptions {
  /** Lattice vertices per axis (N). Default 25 → 24×24 cells (see header). */
  n?: number
  /** Whitespace stiffness (never zero: smoothness). */
  soft?: number
  /** Ink stiffness floor along the stroke. */
  base?: number
  /** Extra ink stiffness across the stroke, × alignment². */
  strong?: number
  /** Shear stiffness of ink. */
  shearBase?: number
  /** Shear stiffness of whitespace. */
  softShear?: number
  /** Stiffness of small-feature / terminal cells on all three springs. */
  rigid?: number
  /** Isotropic first-order smoothness added to every edge (both fields). */
  smooth?: number
  /** Lattice spans the advance box in X (default) or the ink bbox only. */
  advanceBox?: boolean
  /** Passes of a 3×3 binomial blur over the stiffness fields (log domain),
   *  grading the ink/whitespace staircase at stroke boundaries. */
  blur?: number
  /** How a partially-inked cell mixes ink and whitespace stiffness:
   *  `'arithmetic'` (parallel) or `'harmonic'` (series). */
  mix?: 'arithmetic' | 'harmonic'
  /** Displacement interpolation (default bicubic). */
  interp?: 'bicubic' | 'bilinear'
  /** Compressive BARRIER: after a solve, any cell squeezed below
   *  `barrierFloor` × its rest size has that axis's stiffness multiplied by
   *  `barrierGain` and the system is re-solved, up to `barrierIters` times.
   *  Contact physics (a cell cannot pass through itself), not a typographic
   *  rule; 0 iterations disables it. */
  barrierIters?: number
  barrierFloor?: number
  barrierGain?: number
  /** CG cap / relative tolerance. */
  maxIter?: number
  tol?: number
  /** Passed through to `analyzeGrid`. */
  smallFeature?: number
  straightMin?: number
  shapeRules?: boolean
}

export const DEFAULT_FIELD_OPTIONS: Required<Pick<Field2DOptions, 'n' | 'soft' | 'base' | 'strong' | 'shearBase' | 'softShear' | 'rigid' | 'smooth' | 'advanceBox' | 'blur' | 'mix' | 'barrierIters' | 'barrierFloor' | 'barrierGain' | 'interp' | 'maxIter' | 'tol'>> = {
  n: 25,
  soft: 0.05,
  base: 0.2,
  strong: 3.0,
  shearBase: 0.5,
  softShear: 0.05,
  rigid: 10,
  smooth: 0.01,
  advanceBox: true,
  blur: 0,
  mix: 'arithmetic',
  barrierIters: 3,
  barrierFloor: 0.3,
  barrierGain: 20,
  interp: 'bicubic',
  maxIter: 4000,
  tol: 1e-8,
}

export interface Lattice {
  n: number
  /** Rest positions of the columns / rows, font units. */
  xs: Float64Array
  ys: Float64Array
  /** Solved displacement per vertex, index `j * n + i`. */
  dx: Float64Array
  dy: Float64Array
  /** Per-cell stiffness, index `j * (n − 1) + i`. */
  kx: Float64Array
  ky: Float64Array
  ks: Float64Array
  /** Solver diagnostics. `barrierPasses` = re-solves the barrier triggered. */
  iterations: number
  residual: number
  barrierPasses: number
  /** Wall-clock for analysis + assembly + solve, ms. */
  ms: number
  interp: 'bicubic' | 'bilinear'
}

/** Stiffness per lattice cell from the analysis grid. */
function cellStiffness(g: GlyphOutline, xs: Float64Array, ys: Float64Array, o: typeof DEFAULT_FIELD_OPTIONS, gridOpts: FlexOptions): { kx: Float64Array; ky: Float64Array; ks: Float64Array } {
  const n = xs.length
  const cells = (n - 1) * (n - 1)
  const kx = new Float64Array(cells).fill(o.soft)
  const ky = new Float64Array(cells).fill(o.soft)
  const ks = new Float64Array(cells).fill(o.softShear)
  const grid = analyzeGrid(g.commands, g.bbox, gridOpts)
  const { size: G, cw, ch, ink, ax, ay, small, terminal } = grid
  const { minX, minY, maxX, maxY } = g.bbox
  for (let j = 0; j < n - 1; j++) {
    const ya = ys[j]!, yb = ys[j + 1]!
    const oy0 = Math.max(ya, minY), oy1 = Math.min(yb, maxY)
    if (oy1 <= oy0) continue
    const r0 = Math.max(0, Math.floor((oy0 - minY) / ch))
    const r1 = Math.min(G - 1, Math.ceil((oy1 - minY) / ch) - 1)
    for (let i = 0; i < n - 1; i++) {
      const xa = xs[i]!, xb = xs[i + 1]!
      const ox0 = Math.max(xa, minX), ox1 = Math.min(xb, maxX)
      if (ox1 <= ox0) continue
      const c0 = Math.max(0, Math.floor((ox0 - minX) / cw))
      const c1 = Math.min(G - 1, Math.ceil((ox1 - minX) / cw) - 1)
      if (c1 < c0 || r1 < r0) continue
      let count = 0, inkCount = 0, sAx2 = 0, sAy2 = 0, rigidCount = 0
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const q = r * G + c
          count++
          if (!ink[q]) continue
          inkCount++
          sAx2 += ax[q]! * ax[q]!
          sAy2 += ay[q]! * ay[q]!
          if (small[q] || terminal[q]) rigidCount++
        }
      }
      if (!count || !inkCount) continue
      const overlap = ((ox1 - ox0) * (oy1 - oy0)) / ((xb - xa) * (yb - ya))
      const f = Math.min(1, overlap * (inkCount / count))
      const idx = j * (n - 1) + i
      if (rigidCount / inkCount >= 0.5) {
        kx[idx] = o.rigid; ky[idx] = o.rigid; ks[idx] = o.rigid
        continue
      }
      const ax2 = sAx2 / inkCount, ay2 = sAy2 / inkCount
      const mixk = (kInk: number, kSoft: number) => o.mix === 'harmonic' ? 1 / (f / kInk + (1 - f) / kSoft) : f * kInk + (1 - f) * kSoft
      kx[idx] = mixk(o.base + o.strong * ay2, o.soft)
      ky[idx] = mixk(o.base + o.strong * ax2, o.soft)
      ks[idx] = mixk(o.shearBase, o.softShear)
    }
  }
  for (let pass = 0; pass < o.blur; pass++) for (const k of [kx, ky, ks]) blurLog(k, n - 1)
  return { kx, ky, ks }
}

/** One pass of a separable [1 2 1]/4 blur in the log domain over an m×m
 *  field (edges clamped). Geometric averaging keeps a blurred stiff cell
 *  from swamping its soft neighbours the way an arithmetic blur would. */
function blurLog(k: Float64Array, m: number): void {
  const lg = new Float64Array(m * m)
  for (let q = 0; q < m * m; q++) lg[q] = Math.log(k[q]!)
  const tmp = new Float64Array(m * m)
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const a = lg[j * m + Math.max(0, i - 1)]!, b = lg[j * m + i]!, c = lg[j * m + Math.min(m - 1, i + 1)]!
    tmp[j * m + i] = (a + 2 * b + c) / 4
  }
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const a = tmp[Math.max(0, j - 1) * m + i]!, b = tmp[j * m + i]!, c = tmp[Math.min(m - 1, j + 1) * m + i]!
    k[j * m + i] = Math.exp((a + 2 * b + c) / 4)
  }
}

/** Uniform rows over [minY, maxY] with the nearest INTERIOR row snapped onto
 *  each zone line strictly inside the span (a zone within `eps` of an edge
 *  row uses that edge row unsnapped). Returns the rows and the row → target
 *  y map for the constraints. */
function zoneRows(n: number, minY: number, maxY: number, zones: readonly number[], SY: number): { ys: Float64Array; targets: Map<number, number> } {
  const ys = new Float64Array(n)
  const h = maxY - minY
  for (let j = 0; j < n; j++) ys[j] = minY + (h * j) / (n - 1)
  const targets = new Map<number, number>()
  const eps = Math.max(1, h * 1e-4)
  const sorted = Array.from(new Set(zones)).sort((a, b) => a - b)
  for (const z of sorted) {
    if (z < minY - eps || z > maxY + eps) continue
    let row: number
    if (Math.abs(z - minY) <= eps) row = 0
    else if (Math.abs(z - maxY) <= eps) row = n - 1
    else {
      // nearest interior row
      const t = ((z - minY) / h) * (n - 1)
      row = Math.max(1, Math.min(n - 2, Math.round(t)))
      if (targets.has(row)) {
        // two zones on one row (tiny glyph): try the neighbour
        const alt = t > row ? row + 1 : row - 1
        if (alt < 1 || alt > n - 2 || targets.has(alt)) continue
        row = alt
      }
      ys[row] = z
    }
    targets.set(row, z * SY)
  }
  if (!targets.size) {
    targets.set(0, minY * SY)
    targets.set(n - 1, maxY * SY)
  }
  // Snapping must keep rows strictly increasing.
  for (let j = 1; j < n; j++) if (ys[j]! <= ys[j - 1]!) ys[j] = ys[j - 1]! + eps * 0.5
  return { ys, targets }
}

/** Fixed-stencil sparse matrix over the N² lattice vertices (one scalar
 *  unknown per vertex): every vertex couples to at most its 4-neighbours and
 *  itself — 5 of the 9 slots of a 3×3 stencil. */
export class StencilMatrix {
  readonly n: number
  readonly dofs: number
  readonly vals: Float64Array
  readonly cols: Int32Array
  constructor(n: number) {
    this.n = n
    this.dofs = n * n
    this.vals = new Float64Array(this.dofs * 9)
    this.cols = new Int32Array(this.dofs * 9).fill(-1)
    for (let v = 0; v < this.dofs; v++) {
      const i = v % n, j = (v / n) | 0
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj
          if (ii < 0 || ii >= n || jj < 0 || jj >= n) continue
          this.cols[v * 9 + (dj + 1) * 3 + (di + 1)] = jj * n + ii
        }
      }
    }
  }
  add(row: number, col: number, v: number): void {
    const n = this.n
    const di = (col % n) - (row % n), dj = ((col / n) | 0) - ((row / n) | 0)
    if (di < -1 || di > 1 || dj < -1 || dj > 1) throw new Error(`stencil: ${row} → ${col} is not a neighbour`)
    this.vals[row * 9 + (dj + 1) * 3 + (di + 1)]! += v
  }
  /** Add w·(x_a − x_b)² — a spring between two neighbouring vertices. */
  addSpring(w: number, a: number, b: number): void {
    if (!(w > 0)) return
    this.add(a, a, w); this.add(b, b, w); this.add(a, b, -w); this.add(b, a, -w)
  }
  matvec(x: Float64Array, out: Float64Array, mask: Uint8Array): void {
    const { dofs, vals, cols } = this
    for (let r = 0; r < dofs; r++) {
      if (mask[r]) { out[r] = 0; continue }
      let s = 0
      const base = r * 9
      for (let k = 0; k < 9; k++) {
        const c = cols[base + k]!
        if (c < 0 || mask[c]) continue
        s += vals[base + k]! * x[c]!
      }
      out[r] = s
    }
  }
  diag(r: number): number { return this.vals[r * 9 + 4]! }
}

/** Jacobi-preconditioned CG on the free DOFs (masked). `x` holds the fixed
 *  values on masked DOFs going in and the full solution coming out. */
function solvePCG(A: StencilMatrix, x: Float64Array, fixed: Uint8Array, maxIter: number, tol: number): { iterations: number; residual: number } {
  const m = A.dofs
  // b = −A_fc · x_c  (only fixed columns contribute)
  const b = new Float64Array(m)
  {
    const xc = new Float64Array(m)
    for (let r = 0; r < m; r++) if (fixed[r]) xc[r] = x[r]!
    const tmp = new Float64Array(m)
    A.matvec(xc, tmp, new Uint8Array(m))
    for (let r = 0; r < m; r++) b[r] = fixed[r] ? 0 : -tmp[r]!
  }
  const invD = new Float64Array(m)
  for (let r = 0; r < m; r++) {
    const d = A.diag(r)
    invD[r] = fixed[r] || d <= 0 ? 0 : 1 / d
  }
  const xf = new Float64Array(m)
  const r = new Float64Array(m), z = new Float64Array(m), p = new Float64Array(m), Ap = new Float64Array(m)
  let bnorm = 0
  for (let k = 0; k < m; k++) { r[k] = b[k]!; bnorm += b[k]! * b[k]! }
  bnorm = Math.sqrt(bnorm) || 1
  let rz = 0
  for (let k = 0; k < m; k++) { z[k] = invD[k]! * r[k]!; p[k] = z[k]!; rz += r[k]! * z[k]! }
  let it = 0
  let rnorm = Infinity
  for (; it < maxIter; it++) {
    rnorm = 0
    for (let k = 0; k < m; k++) rnorm += r[k]! * r[k]!
    rnorm = Math.sqrt(rnorm)
    if (rnorm <= tol * bnorm) break
    A.matvec(p, Ap, fixed)
    let pAp = 0
    for (let k = 0; k < m; k++) pAp += p[k]! * Ap[k]!
    if (!(pAp > 0)) break
    const alpha = rz / pAp
    for (let k = 0; k < m; k++) { xf[k]! += alpha * p[k]!; r[k]! -= alpha * Ap[k]! }
    let rzNew = 0
    for (let k = 0; k < m; k++) { z[k] = invD[k]! * r[k]!; rzNew += r[k]! * z[k]! }
    const beta = rzNew / rz
    rz = rzNew
    for (let k = 0; k < m; k++) p[k] = z[k]! + beta * p[k]!
  }
  for (let k = 0; k < m; k++) if (!fixed[k]) x[k] = xf[k]!
  return { iterations: it, residual: rnorm / bnorm }
}

/** Build and solve the deformation lattice for one glyph. */
export function deformLattice(g: GlyphOutline, S: number, SY: number, metrics: FontMetrics, unitsPerEm: number, opts: Field2DOptions = {}): Lattice {
  const t0 = performance.now()
  const o = { ...DEFAULT_FIELD_OPTIONS, ...opts }
  const n = Math.max(4, Math.round(o.n))
  const gridOpts: FlexOptions = {
    smallFeature: opts.smallFeature ?? SMALL_FEATURE_EM * unitsPerEm,
    straightMin: opts.straightMin ?? STRAIGHT_MIN_EM * unitsPerEm,
    shapeRules: opts.shapeRules ?? true,
  }
  const { minX, minY, maxX, maxY } = g.bbox
  const x0 = o.advanceBox ? Math.min(0, minX) : minX
  const x1 = o.advanceBox ? Math.max(g.advance, maxX) : maxX
  const xs = new Float64Array(n)
  for (let i = 0; i < n; i++) xs[i] = x0 + ((x1 - x0) * i) / (n - 1)
  const zones = [0, metrics.xHeight, metrics.capHeight, metrics.ascent, metrics.descent]
  const { ys, targets } = zoneRows(n, minY, maxY, zones, SY)
  const { kx, ky, ks } = cellStiffness(g, xs, ys, o, gridOpts)

  // Two decoupled graph-Laplacian systems. Each cell contributes to its
  // four edges; an interior edge is shared by two cells (hence the ½).
  const V = (i: number, j: number) => j * n + i
  const Lavg = ((x1 - x0) + (maxY - minY)) / (2 * (n - 1))
  const sm = o.smooth / Lavg
  const assemble = (): [StencilMatrix, StencilMatrix] => {
    const Ax = new StencilMatrix(n)
    const Ay = new StencilMatrix(n)
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const c = j * (n - 1) + i
        const Lx = xs[i + 1]! - xs[i]!, Ly = ys[j + 1]! - ys[j]!
        // horizontal edges (bottom, top): dx strain kx; dy cross-gradient ks
        for (const jj of [j, j + 1]) {
          Ax.addSpring(0.5 * kx[c]! / Lx + sm, V(i, jj), V(i + 1, jj))
          Ay.addSpring(0.5 * ks[c]! / Lx + sm, V(i, jj), V(i + 1, jj))
        }
        // vertical edges (left, right): dy strain ky; dx cross-gradient ks
        for (const ii of [i, i + 1]) {
          Ay.addSpring(0.5 * ky[c]! / Ly + sm, V(ii, j), V(ii, j + 1))
          Ax.addSpring(0.5 * ks[c]! / Ly + sm, V(ii, j), V(ii, j + 1))
        }
      }
    }
    return [Ax, Ay]
  }

  // Constraints
  const m = n * n
  const fixedX = new Uint8Array(m), fixedY = new Uint8Array(m)
  const dx = new Float64Array(m), dy = new Float64Array(m)
  const setConstraints = () => {
    for (let j = 0; j < n; j++) {
      fixedX[V(0, j)] = 1; dx[V(0, j)] = x0 * S - x0
      fixedX[V(n - 1, j)] = 1; dx[V(n - 1, j)] = x1 * S - x1
    }
    for (const [row, target] of targets) {
      for (let i = 0; i < n; i++) { fixedY[V(i, row)] = 1; dy[V(i, row)] = target - ys[row]! }
    }
  }
  let iterations = 0, residual = 0, barrierPasses = 0
  for (let pass = 0; ; pass++) {
    const [Ax, Ay] = assemble()
    setConstraints()
    const rx = solvePCG(Ax, dx, fixedX, o.maxIter, o.tol)
    const ry = solvePCG(Ay, dy, fixedY, o.maxIter, o.tol)
    iterations = Math.max(rx.iterations, ry.iterations)
    residual = Math.max(rx.residual, ry.residual)
    if (pass >= o.barrierIters) break
    // Barrier: stiffen any cell squeezed below the floor on that axis.
    let hit = 0
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const c = j * (n - 1) + i
        const w0 = xs[i + 1]! - xs[i]!, h0 = ys[j + 1]! - ys[j]!
        const w1 = w0 + dx[V(i + 1, j)]! - dx[V(i, j)]!, w2 = w0 + dx[V(i + 1, j + 1)]! - dx[V(i, j + 1)]!
        const h1 = h0 + dy[V(i, j + 1)]! - dy[V(i, j)]!, h2 = h0 + dy[V(i + 1, j + 1)]! - dy[V(i + 1, j)]!
        if (Math.min(w1, w2) < o.barrierFloor * w0) { kx[c]! *= o.barrierGain; hit++ }
        if (Math.min(h1, h2) < o.barrierFloor * h0) { ky[c]! *= o.barrierGain; hit++ }
      }
    }
    if (!hit) break
    barrierPasses++
    dx.fill(0); dy.fill(0)
  }
  return { n, xs, ys, dx, dy, kx, ky, ks, iterations, residual, barrierPasses, ms: performance.now() - t0, interp: o.interp }
}

/** Number of lattice cells whose deformed quad has a non-positive corner
 *  Jacobian (a fold). 0 = the lattice is an orientation-preserving map. */
export function latticeFolds(l: Lattice): number {
  const { n, xs, ys, dx, dy } = l
  const px = (i: number, j: number) => xs[i]! + dx[j * n + i]!
  const py = (i: number, j: number) => ys[j]! + dy[j * n + i]!
  let folds = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const corners: Array<[number, number, number, number, number, number]> = [
        [i, j, i + 1, j, i, j + 1],
        [i + 1, j, i + 1, j + 1, i, j],
        [i + 1, j + 1, i, j + 1, i + 1, j],
        [i, j + 1, i, j, i + 1, j + 1],
      ]
      let bad = false
      for (const [ai, aj, bi, bj, ci, cj] of corners) {
        const ux = px(bi, bj) - px(ai, aj), uy = py(bi, bj) - py(ai, aj)
        const vx = px(ci, cj) - px(ai, aj), vy = py(ci, cj) - py(ai, aj)
        // orientation of (b − a) × (c − a) must match the rest orientation
        const rest = (xs[bi]! - xs[ai]!) * (ys[cj]! - ys[aj]!) - (ys[bj]! - ys[aj]!) * (xs[ci]! - xs[ai]!)
        const now = ux * vy - uy * vx
        if (now * rest <= 0) { bad = true; break }
      }
      if (bad) folds++
    }
  }
  return folds
}

/** Catmull-Rom on four uniformly spaced values at parameter t ∈ [0, 1]
 *  between v1 and v2. */
function catmullRom(v0: number, v1: number, v2: number, v3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * v1) + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 + (-v0 + 3 * v1 - 3 * v2 + v3) * t3)
}

/** Non-uniform cubic Hermite through (y1, v1)–(y2, v2) with three-point
 *  slope estimates from the outer neighbours (exact for quadratics). */
function hermiteNonUniform(y0: number, v0: number, y1: number, v1: number, y2: number, v2: number, y3: number, v3: number, y: number): number {
  const h1 = y2 - y1
  const slope = (ya: number, va: number, yb: number, vb: number, yc: number, vc: number): number => {
    const ha = yb - ya, hb = yc - yb
    if (ha <= 0) return (vc - vb) / hb
    if (hb <= 0) return (vb - va) / ha
    return ((vb - va) / ha * hb + (vc - vb) / hb * ha) / (ha + hb)
  }
  const m1 = slope(y0, v0, y1, v1, y2, v2)
  const m2 = slope(y1, v1, y2, v2, y3, v3)
  const t = h1 > 0 ? (y - y1) / h1 : 0
  const t2 = t * t, t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2
  return h00 * v1 + h10 * h1 * m1 + h01 * v2 + h11 * h1 * m2
}

/** Map one point through the lattice: rest position + interpolated
 *  displacement. Points beyond the lattice extend with the boundary cell. */
export function mapPoint(l: Lattice, x: number, y: number): [number, number] {
  const { n, xs, ys, dx, dy } = l
  const hx = xs[1]! - xs[0]!
  let i = Math.floor((x - xs[0]!) / hx)
  i = Math.max(0, Math.min(n - 2, i))
  const u = (x - xs[i]!) / hx
  // rows: binary search (non-uniform)
  let lo = 0, hi = n - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ys[mid]! <= y) lo = mid; else hi = mid }
  const j = lo
  const v = (y - ys[j]!) / (ys[j + 1]! - ys[j]!)
  const at = (ii: number, jj: number, arr: Float64Array) => arr[Math.max(0, Math.min(n - 1, jj)) * n + Math.max(0, Math.min(n - 1, ii))]!
  if (l.interp === 'bilinear') {
    const bl = (arr: Float64Array) =>
      (1 - u) * (1 - v) * at(i, j, arr) + u * (1 - v) * at(i + 1, j, arr) + (1 - u) * v * at(i, j + 1, arr) + u * v * at(i + 1, j + 1, arr)
    return [x + bl(dx), y + bl(dy)]
  }
  const bicubic = (arr: Float64Array): number => {
    const rowVals: number[] = []
    for (let jj = j - 1; jj <= j + 2; jj++) {
      rowVals.push(catmullRom(at(i - 1, jj, arr), at(i, jj, arr), at(i + 1, jj, arr), at(i + 2, jj, arr), u))
    }
    const yy = (jj: number) => {
      // clamped rows: extrapolate the knot coordinate so spacing stays positive
      if (jj < 0) return ys[0]! - (ys[1]! - ys[0]!)
      if (jj > n - 1) return ys[n - 1]! + (ys[n - 1]! - ys[n - 2]!)
      return ys[jj]!
    }
    return hermiteNonUniform(yy(j - 1), rowVals[0]!, yy(j), rowVals[1]!, yy(j + 1), rowVals[2]!, yy(j + 2), rowVals[3]!, y)
  }
  return [x + bicubic(dx), y + bicubic(dy)]
}

/** Map every coordinate pair of `commands` through the lattice. Command
 *  count and per-command arity are unchanged by construction. */
export function applyLattice(l: Lattice, commands: readonly PathCommand[]): PathCommand[] {
  return commands.map(c => {
    if (!c.args.length) return { command: c.command, args: [] }
    const args = c.args.slice()
    for (let k = 0; k + 1 < args.length; k += 2) {
      const [nx, ny] = mapPoint(l, args[k]!, args[k + 1]!)
      args[k] = nx; args[k + 1] = ny
    }
    return { command: c.command, args }
  })
}

/** Tight-ish bbox of commands (curves flattened at 16 steps). */
function bboxOfCommands(commands: readonly PathCommand[]): VtBBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const see = (x: number, y: number) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  let px = 0, py = 0
  for (const c of commands) {
    const a = c.args
    if (c.command === 'moveTo' || c.command === 'lineTo') { px = a[0]!; py = a[1]!; see(px, py) }
    else if (c.command === 'quadraticCurveTo') {
      const [cx, cy, x, y] = a as [number, number, number, number]
      const x0 = px, y0 = py
      for (let s = 1; s <= 16; s++) { const t = s / 16, u = 1 - t; see(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y) }
      px = x; py = y
    } else if (c.command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]
      const x0 = px, y0 = py
      for (let s = 1; s <= 16; s++) { const t = s / 16, u = 1 - t; see(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y) }
      px = x; py = y
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}

const hasInk = (g: GlyphOutline): boolean =>
  g.commands.length > 0 && g.bbox.maxX > g.bbox.minX && g.bbox.maxY > g.bbox.minY

/** Per-glyph lattices from the last `stretchOutlines2D` call (diagnostics:
 *  per-glyph solve time, iterations, folds). Keyed by glyph index. */
export interface Field2DResult {
  outlines: TextOutlines
  lattices: Array<Lattice | null>
}

export function stretchOutlines2DWithLattices(outlines: TextOutlines, S: number, SY: number, opts: Field2DOptions = {}): Field2DResult {
  const o = { ...DEFAULT_FIELD_OPTIONS, ...opts }
  const glyphs: GlyphOutline[] = []
  const lattices: Array<Lattice | null> = []
  let penOld = 0, penNew = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const g of outlines.glyphs) {
    let commands = g.commands
    let bbox = g.bbox
    let advance: number
    let lattice: Lattice | null = null
    if (hasInk(g) && (S !== 1 || SY !== 1)) {
      lattice = deformLattice(g, S, SY, outlines.metrics, outlines.unitsPerEm, opts)
      commands = applyLattice(lattice, g.commands)
      bbox = bboxOfCommands(commands)
      if (o.advanceBox) {
        advance = g.advance * S
      } else {
        const whitespace = g.advance - (g.bbox.maxX - g.bbox.minX)
        advance = (bbox.maxX - bbox.minX) + whitespace * S
      }
    } else {
      advance = g.advance * S
    }
    lattices.push(lattice)
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
    outlines: {
      ...outlines,
      glyphs,
      width: penNew,
      bbox: empty ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY },
    },
    lattices,
  }
}

/** The 2D-field counterpart of `stretchOutlines`. */
export function stretchOutlines2D(outlines: TextOutlines, S: number, SY: number, opts: Field2DOptions = {}): TextOutlines {
  if (S === 1 && SY === 1) return outlines
  return stretchOutlines2DWithLattices(outlines, S, SY, opts).outlines
}
