/**
 * Compositor — SVG `d` → POLYLINE. PURE.
 *
 * A path string in, subpaths of points out. No DOM, no `Path2D`, no paper.js,
 * no Vue: this runs under vitest in node, inside the headless bake, and on the
 * draw loop.
 *
 * ## Why it exists
 *
 * Frame stores vector geometry as an SVG `d` in LOCAL units (1 unit = canvas
 * width), centred on its bounding-box midpoint — see `PathLayer` in
 * `app/composables/useCompositorLayers.ts`. Type-on-a-path needs that outline as
 * a polyline with cumulative arc lengths so a glyph can be placed at distance
 * `s`. `app/lib/vectortype/pathLength.ts` already runs this algorithm, but over
 * fontkit's `{ command, args }` arrays — a different input with no `d` parser in
 * front of it and no relative commands to resolve. This module is the parser and
 * the flattener; building the length table on top is the caller's job.
 *
 * ## What a `d` in this repo actually contains
 *
 * Checked, not assumed, because the answer decides how much parser is needed:
 *
 *  - **The shape library** (`app/data/shape-library.manifest.json`, 100 shapes):
 *    `M L C Z` only, absolute. `transformShapePath` throws on anything else, so
 *    that is enforced rather than incidental.
 *  - **The pen** (`useVectorPen.ts` / `useVectorNodeEdit.ts`): emits `M C L Z`,
 *    absolute.
 *  - **Polygon/star layers** (`polygonGeometry.ts`): `M L Q Z`, absolute. So `Q`
 *    is live today.
 *  - **SVG import and node-edit bake** go through paper.js's `getPathData`,
 *    which emits `M` absolute and then **relative `c`, `l`, `h`, `v`** and `z`
 *    (paper-core.js, `getPathData`). So relative commands and the H/V shorthands
 *    are not hypothetical robustness — they are what half the saved documents in
 *    this app hold, and a flattener without them silently mangles every imported
 *    logo.
 *  - **Arcs**: paper never emits `A` (it converts on import), and the manifest
 *    forbids it — but `app/lib/sketch/sketchPath.ts` and
 *    `app/lib/geoshape/shapes.ts` both write `A` into a `d`. Arcs are therefore
 *    converted properly (endpoint → centre parameterisation, split at 90°,
 *    each piece an exact-to-1e-4 cubic) rather than dropped.
 *
 * The full command set `M m L l H h V v C c S s Q q T t A a Z z` is supported.
 *
 * ## Never throws
 *
 * `d` comes off disk, out of a pasted SVG, or out of an older version of this
 * app. Malformed input returns whatever parsed cleanly up to the problem —
 * an empty array in the worst case. **No non-finite number can reach the
 * output**: every coordinate is finite-checked at the point it is read, and a
 * command with a bad argument is skipped without moving the current point.
 *
 * ## Units and tolerance
 *
 * `tolerance` is a distance in the SAME units as `d`. The default,
 * `DEFAULT_FLATTEN_TOLERANCE = 0.0015`, is chosen for the local frame above:
 * 0.0015 of the canvas width is ~1.5 px on a 1000 px render and ~3 px on a
 * 2000 px one — below a glyph's own positional noise, and the error on the
 * TANGENT (which is what a rotated glyph shows) falls faster than the error on
 * the point. Flattening a path in some other space — the manifest's raw 0..100
 * viewBox, say — wants a tolerance scaled to that space.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/** Default flatness, in the path's own units. See the header. */
export const DEFAULT_FLATTEN_TOLERANCE = 0.0015

/**
 * Recursion cap on one curve's subdivision. 2^16 = 65 536 chords is far past
 * anything a real outline needs (a quarter circle of radius 0.5 is flat to
 * 0.0015 after two splits), so this only ever fires on a pathological control
 * polygon — where degrading the accuracy is much better than stalling a frame.
 */
const MAX_DEPTH = 16

/**
 * Total points one `flattenPath` call may emit. A second, independent brake on
 * the same hazard: a `d` with ten thousand cusped curves cannot make the render
 * loop allocate without bound. Past the budget curves emit their endpoints only,
 * which keeps the polyline connected and finite.
 */
const MAX_POINTS = 60000

const TAU = Math.PI * 2

// ── Types ───────────────────────────────────────────────────────────────────

export interface FlatPoint { x: number; y: number }

export interface FlatSubpath {
  /** At least 2 points; consecutive duplicates removed. */
  pts: FlatPoint[]
  /**
   * The subpath ended in `Z`. The closing segment from `pts[last]` back to
   * `pts[0]` is IMPLIED — it is not repeated in `pts` — so a consumer walking a
   * closed subpath must add that final chord itself.
   */
  closed: boolean
}

export interface FlattenOptions {
  /** Max deviation of a chord from the true curve, in the path's units. */
  tolerance?: number
}

// ── Number scanning ─────────────────────────────────────────────────────────

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isSep = (c: string): boolean => c === ',' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
const isLetter = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')

/**
 * How many numbers each command takes. `A` is listed as 7 but read specially:
 * its two flags may legally be single characters with no separator
 * (`a5 5 0 1150 0` is a valid arc), which a plain number scan gets wrong.
 */
const ARITY: Readonly<Record<string, number>> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
}

/** Cursor over the `d` string. One instance per `flattenPath` call. */
class Cursor {
  private readonly s: string
  private readonly n: number
  i = 0

  constructor(s: string) { this.s = s; this.n = s.length }

  atEnd(): boolean { return this.i >= this.n }
  peek(): string { return this.s.charAt(this.i) }
  bump(): void { this.i++ }

  skipSep(): void {
    while (this.i < this.n && isSep(this.s.charAt(this.i))) this.i++
  }

  /**
   * One SVG number, or `null` when the next token is not one (or is not finite,
   * which `1e999` and a bare `.` both are). The cursor is left where it started
   * when nothing was consumable, so a caller can decide what to do next.
   */
  number(): number | null {
    this.skipSep()
    const start = this.i
    const s = this.s
    let i = this.i
    const n = this.n
    if (i < n && (s.charAt(i) === '+' || s.charAt(i) === '-')) i++
    let digits = false
    while (i < n && isDigit(s.charAt(i))) { i++; digits = true }
    if (i < n && s.charAt(i) === '.') {
      i++
      while (i < n && isDigit(s.charAt(i))) { i++; digits = true }
    }
    if (!digits) { this.i = start; return null }
    if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
      // Only consume the exponent if it actually has digits: in `M0,0h5e` the
      // trailing `e` is junk, not the start of one.
      const save = i
      i++
      if (i < n && (s.charAt(i) === '+' || s.charAt(i) === '-')) i++
      let expDigits = false
      while (i < n && isDigit(s.charAt(i))) { i++; expDigits = true }
      if (!expDigits) i = save
    }
    this.i = i
    const v = Number(s.slice(start, i))
    return Number.isFinite(v) ? v : null
  }

  /**
   * An arc flag: one bare `0` or `1` (the compact form producers emit), else a
   * whole number coerced to a boolean, else `null`.
   */
  flag(): 0 | 1 | null {
    this.skipSep()
    const c = this.peek()
    if (c === '0') { this.bump(); return 0 }
    if (c === '1') { this.bump(); return 1 }
    const v = this.number()
    if (v === null) return null
    return v !== 0 ? 1 : 0
  }
}

// ── The flattener ───────────────────────────────────────────────────────────

/**
 * The mutable state of one flatten: the parser's current point, the subpath
 * being built, and the two brakes. Kept in one object so the curve helpers can
 * be plain functions that take it.
 */
interface Sink {
  out: FlatSubpath[]
  cur: FlatPoint[] | null
  /** Subpath start — where `Z` returns to. */
  sx: number
  sy: number
  budget: number
  tol2: number
}

function push(k: Sink, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const cur = k.cur
  if (!cur) return
  const last = cur[cur.length - 1] as FlatPoint
  // Exact equality: a chord of length zero contributes nothing to arc length
  // and would give `atan2` a zero vector to take the tangent of.
  if (last.x === x && last.y === y) return
  cur.push({ x, y })
  k.budget--
}

function flush(k: Sink, closed: boolean): void {
  const cur = k.cur
  k.cur = null
  if (!cur) return
  if (closed && cur.length >= 3) {
    // A `d` that walks back to its own start before closing (`M0,0 L1,0 L0,0 Z`)
    // would otherwise carry a duplicate of pts[0] at the end, and the implied
    // closing chord would be zero-length. Drop it; `closed` already says the
    // contour returns.
    const first = cur[0] as FlatPoint
    const last = cur[cur.length - 1] as FlatPoint
    if (first.x === last.x && first.y === last.y) cur.pop()
  }
  if (cur.length >= 2) k.out.push({ pts: cur, closed })
}

function moveTo(k: Sink, x: number, y: number): void {
  flush(k, false)
  k.cur = [{ x, y }]
  k.sx = x
  k.sy = y
  k.budget--
}

/** A drawing command with no `M` in front of it opens a subpath where we are —
 *  which is (0, 0) for a `d` that never moved, and the last `Z`'s start point
 *  after a close. Canvas's and SVG's own rule. */
function ensureOpen(k: Sink, cx: number, cy: number): void {
  if (!k.cur) moveTo(k, cx, cy)
}

/**
 * Adaptive cubic subdivision, de Casteljau at t = 0.5.
 *
 * Flatness is the classic cross-product test: `d1` and `d2` are each the
 * distance of a control point from the chord TIMES the chord length, so
 * `(d1 + d2)² ≤ tol²·|chord|²` is "both controls lie within `tol` of the
 * chord", with the sum instead of the max making it conservative by at most a
 * factor of two. It needs no square roots.
 *
 * The degenerate branch matters: when the chord is (near) zero the cross
 * products vanish too and the test would call a full loop flat. There the
 * controls are measured from the start point directly.
 */
function flattenCubic(
  k: Sink,
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  depth: number,
): void {
  if (depth >= MAX_DEPTH || k.budget <= 0) { push(k, x3, y3); return }

  const dx = x3 - x0
  const dy = y3 - y0
  const chord2 = dx * dx + dy * dy
  let flat: boolean
  if (chord2 < 1e-24) {
    const e1 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)
    const e2 = (x2 - x0) * (x2 - x0) + (y2 - y0) * (y2 - y0)
    flat = Math.max(e1, e2) <= k.tol2
  } else {
    const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx)
    const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx)
    const dd = d1 + d2
    flat = dd * dd <= k.tol2 * chord2
  }
  if (flat) { push(k, x3, y3); return }

  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2

  flattenCubic(k, x0, y0, x01, y01, xa, ya, xm, ym, depth + 1)
  flattenCubic(k, xm, ym, xb, yb, x23, y23, x3, y3, depth + 1)
}

/** A quadratic IS a cubic — degree elevation is exact, so there is one curve
 *  flattener rather than two places to get the flatness test wrong. */
function flattenQuad(
  k: Sink,
  x0: number, y0: number,
  qx: number, qy: number,
  x1: number, y1: number,
): void {
  flattenCubic(
    k,
    x0, y0,
    x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0),
    x1 + (2 / 3) * (qx - x1), y1 + (2 / 3) * (qy - y1),
    x1, y1,
    0,
  )
}

/** Signed angle from (ux, uy) to (vx, vy), via `atan2` of the cross and dot —
 *  well conditioned all the way down to zero, unlike `acos` of a dot. */
function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
}

/**
 * `A` → cubics, per the SVG 1.1 implementation notes (F.6.5 endpoint → centre
 * parameterisation, F.6.6 radius correction), then split into pieces of at most
 * 90° because the `4/3·tan(Δ/4)` cubic approximation of an elliptical arc is
 * good to ~2.7e-4 of the radius at a quarter turn and degrades fast past it.
 *
 * Out-of-range input is corrected the way the spec requires rather than
 * rejected: negative radii take their absolute value, a zero radius or a
 * zero-length segment degenerates to a straight line, and radii too small to
 * span the endpoints are scaled up until they just do.
 */
function flattenArc(
  k: Sink,
  x0: number, y0: number,
  rxIn: number, ryIn: number, phiDeg: number,
  largeArc: 0 | 1, sweep: 0 | 1,
  x: number, y: number,
): void {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (!(rx > 0) || !(ry > 0) || (x0 === x && y0 === y)) { push(k, x, y); return }

  const phi = (phiDeg * Math.PI) / 180
  const cosp = Math.cos(phi)
  const sinp = Math.sin(phi)

  const dx2 = (x0 - x) / 2
  const dy2 = (y0 - y) / 2
  const x1p = cosp * dx2 + sinp * dy2
  const y1p = -sinp * dx2 + cosp * dy2

  let rxs = rx * rx
  let rys = ry * ry
  const x1ps = x1p * x1p
  const y1ps = y1p * y1p
  const lambda = x1ps / rxs + y1ps / rys
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s; ry *= s
    rxs = rx * rx; rys = ry * ry
  }

  const den = rxs * y1ps + rys * x1ps
  const num = rxs * rys - rxs * y1ps - rys * x1ps
  let co = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0
  if (largeArc === sweep) co = -co
  const cxp = co * ((rx * y1p) / ry)
  const cyp = co * ((-ry * x1p) / rx)
  const cx = cosp * cxp - sinp * cyp + (x0 + x) / 2
  const cy = sinp * cxp + cosp * cyp + (y0 + y) / 2

  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry
  const theta1 = vectorAngle(1, 0, ux, uy)
  let dtheta = vectorAngle(ux, uy, vx, vy)
  if (sweep === 0 && dtheta > 0) dtheta -= TAU
  else if (sweep === 1 && dtheta < 0) dtheta += TAU

  if (!Number.isFinite(theta1) || !Number.isFinite(dtheta)) { push(k, x, y); return }

  const segs = Math.max(1, Math.min(16, Math.ceil(Math.abs(dtheta) / (Math.PI / 2))))
  const delta = dtheta / segs
  const kappa = (4 / 3) * Math.tan(delta / 4)

  // E(t) = C + R(φ)·(rx·cos t, ry·sin t); E'(t) = R(φ)·(−rx·sin t, ry·cos t).
  const at = (t: number): [number, number] => {
    const ct = Math.cos(t), st = Math.sin(t)
    return [cx + cosp * rx * ct - sinp * ry * st, cy + sinp * rx * ct + cosp * ry * st]
  }
  const deriv = (t: number): [number, number] => {
    const ct = Math.cos(t), st = Math.sin(t)
    return [-cosp * rx * st - sinp * ry * ct, -sinp * rx * st + cosp * ry * ct]
  }

  let px = x0
  let py = y0
  for (let i = 0; i < segs; i++) {
    const ta = theta1 + i * delta
    const tb = ta + delta
    const [ex, ey] = i === segs - 1 ? [x, y] : at(tb)
    const [d1x, d1y] = deriv(ta)
    const [d2x, d2y] = deriv(tb)
    flattenCubic(
      k,
      px, py,
      px + kappa * d1x, py + kappa * d1y,
      ex - kappa * d2x, ey - kappa * d2y,
      ex, ey,
      0,
    )
    px = ex
    py = ey
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Flatten an SVG path into subpaths of polyline points.
 *
 * Subpaths come back in declaration order. One with fewer than 2 distinct
 * points is dropped — it has no direction, so nothing can be placed along it.
 * Never throws: see the header.
 */
export function flattenPath(d: string, opts?: FlattenOptions): FlatSubpath[] {
  if (typeof d !== 'string' || !d) return []

  const rawTol = opts?.tolerance
  const tol = typeof rawTol === 'number' && Number.isFinite(rawTol) && rawTol > 0
    ? rawTol
    : DEFAULT_FLATTEN_TOLERANCE

  const k: Sink = { out: [], cur: null, sx: 0, sy: 0, budget: MAX_POINTS, tol2: tol * tol }
  const c = new Cursor(d)

  let cx = 0
  let cy = 0
  /** Uppercased letter of the command last EXECUTED — what `S`/`T` reflect against. */
  let prev = ''
  /** Second control point of the last cubic, absolute; `null` when there wasn't one. */
  let lastC: FlatPoint | null = null
  /** Control point of the last quadratic, absolute. */
  let lastQ: FlatPoint | null = null

  let cmd: string | null = null
  let rel = false

  const args: number[] = []

  for (;;) {
    c.skipSep()
    if (c.atEnd()) break

    const ch = c.peek()
    if (isLetter(ch)) {
      c.bump()
      const up = ch.toUpperCase()
      if (!(up in ARITY)) {
        // An unknown letter poisons the numbers that follow it — we have no
        // arity for them and guessing would corrupt the rest of the path. Drop
        // the command and skip forward to the next letter.
        cmd = null
        continue
      }
      cmd = up
      rel = ch !== up
      if (up === 'Z') {
        if (k.cur) flush(k, true)
        cx = k.sx; cy = k.sy
        prev = 'Z'
        lastC = null; lastQ = null
        cmd = null   // `z` takes no arguments, so it has no implicit repeat
        continue
      }
    } else {
      if (cmd === null) {
        // A number with no command in force (a leading coordinate, or the tail
        // of an unknown command). Consume it so we make progress and ignore it.
        if (c.number() === null) c.bump()
        continue
      }
    }

    // ── read this command's arguments ──
    const cmdName = cmd
    let ok = true
    args.length = 0
    if (cmdName === 'A') {
      for (let i = 0; i < 3 && ok; i++) {
        const v = c.number()
        if (v === null) ok = false
        else args.push(v)
      }
      for (let i = 0; i < 2 && ok; i++) {
        const f = c.flag()
        if (f === null) ok = false
        else args.push(f)
      }
      for (let i = 0; i < 2 && ok; i++) {
        const v = c.number()
        if (v === null) ok = false
        else args.push(v)
      }
    } else {
      const arity = ARITY[cmdName] as number
      for (let i = 0; i < arity && ok; i++) {
        const v = c.number()
        if (v === null) ok = false
        else args.push(v)
      }
    }
    // A short or unreadable argument list ends the path: everything after it is
    // unanchored, so the honest answer is what parsed cleanly so far.
    if (!ok) break

    // ── execute ──
    const ax = (v: number): number => (rel ? cx + v : v)
    const ay = (v: number): number => (rel ? cy + v : v)

    switch (cmdName) {
      case 'M': {
        const x = ax(args[0] as number)
        const y = ay(args[1] as number)
        moveTo(k, x, y)
        cx = x; cy = y
        prev = 'M'
        lastC = null; lastQ = null
        // **Extra coordinate pairs after a moveto are LINETOs.** `M 1 2 3 4` is a
        // move to (1, 2) then a line to (3, 4) — and after `m` they are RELATIVE
        // linetos, since the implicit command inherits the moveto's case. Handing
        // the repeat over to `L` here is the whole implementation of that rule,
        // and the reason `case 'M'` can never see an implicit repeat itself.
        cmd = 'L'
        break
      }
      case 'L': {
        const x = ax(args[0] as number)
        const y = ay(args[1] as number)
        ensureOpen(k, cx, cy)
        push(k, x, y)
        cx = x; cy = y
        prev = 'L'
        lastC = null; lastQ = null
        break
      }
      case 'H': {
        const x = ax(args[0] as number)
        ensureOpen(k, cx, cy)
        push(k, x, cy)
        cx = x
        prev = 'H'
        lastC = null; lastQ = null
        break
      }
      case 'V': {
        const y = ay(args[0] as number)
        ensureOpen(k, cx, cy)
        push(k, cx, y)
        cy = y
        prev = 'V'
        lastC = null; lastQ = null
        break
      }
      case 'C': {
        const c1x = ax(args[0] as number), c1y = ay(args[1] as number)
        const c2x = ax(args[2] as number), c2y = ay(args[3] as number)
        const ex = ax(args[4] as number), ey = ay(args[5] as number)
        ensureOpen(k, cx, cy)
        flattenCubic(k, cx, cy, c1x, c1y, c2x, c2y, ex, ey, 0)
        cx = ex; cy = ey
        prev = 'C'
        lastC = { x: c2x, y: c2y }; lastQ = null
        break
      }
      case 'S': {
        // THE reflection rule: the first control point mirrors the previous
        // curve's second one ONLY when the previous command was itself a cubic
        // (`C`/`c`/`S`/`s`). After anything else — a lineto, a moveto, a
        // quadratic, or nothing at all — it coincides with the current point.
        const reflect = (prev === 'C' || prev === 'S') && lastC !== null
        const c1x = reflect ? 2 * cx - (lastC as FlatPoint).x : cx
        const c1y = reflect ? 2 * cy - (lastC as FlatPoint).y : cy
        const c2x = ax(args[0] as number), c2y = ay(args[1] as number)
        const ex = ax(args[2] as number), ey = ay(args[3] as number)
        ensureOpen(k, cx, cy)
        flattenCubic(k, cx, cy, c1x, c1y, c2x, c2y, ex, ey, 0)
        cx = ex; cy = ey
        prev = 'S'
        lastC = { x: c2x, y: c2y }; lastQ = null
        break
      }
      case 'Q': {
        const qx = ax(args[0] as number), qy = ay(args[1] as number)
        const ex = ax(args[2] as number), ey = ay(args[3] as number)
        ensureOpen(k, cx, cy)
        flattenQuad(k, cx, cy, qx, qy, ex, ey)
        cx = ex; cy = ey
        prev = 'Q'
        lastQ = { x: qx, y: qy }; lastC = null
        break
      }
      case 'T': {
        // Same rule, quadratic family: reflect only after `Q`/`q`/`T`/`t`.
        //
        // The three annotations are load-bearing, not decoration: `lastQ` is
        // written back from `qx`/`qy` two lines below, so leaving these to
        // inference asks TypeScript to resolve `qx → lastQ → qx` and it gives up
        // with TS7022 rather than picking a type.
        const reflect: boolean = (prev === 'Q' || prev === 'T') && lastQ !== null
        const qx: number = reflect ? 2 * cx - (lastQ as FlatPoint).x : cx
        const qy: number = reflect ? 2 * cy - (lastQ as FlatPoint).y : cy
        const ex = ax(args[0] as number), ey = ay(args[1] as number)
        ensureOpen(k, cx, cy)
        flattenQuad(k, cx, cy, qx, qy, ex, ey)
        cx = ex; cy = ey
        prev = 'T'
        lastQ = { x: qx, y: qy }; lastC = null
        break
      }
      case 'A': {
        const ex = ax(args[5] as number), ey = ay(args[6] as number)
        ensureOpen(k, cx, cy)
        flattenArc(
          k, cx, cy,
          args[0] as number, args[1] as number, args[2] as number,
          (args[3] as 0 | 1), (args[4] as 0 | 1),
          ex, ey,
        )
        cx = ex; cy = ey
        prev = 'A'
        lastC = null; lastQ = null
        break
      }
      default:
        break
    }
  }

  flush(k, false)
  return k.out
}

/** Polyline arc length, including the implied closing chord of a closed
 *  subpath — that segment is part of the outline and type runs along it. */
function subpathLength(sub: FlatSubpath): number {
  const pts = sub.pts
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as FlatPoint
    const b = pts[i] as FlatPoint
    acc += Math.hypot(b.x - a.x, b.y - a.y)
  }
  if (sub.closed && pts.length > 1) {
    const a = pts[pts.length - 1] as FlatPoint
    const b = pts[0] as FlatPoint
    acc += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return acc
}

/**
 * The longest subpath, or `null` when the path yields none.
 *
 * Longest by ARC LENGTH, not by point count: adaptive subdivision spends points
 * where a contour bends, so a small, busy interior detail can easily out-count
 * the big smooth outline it sits inside. Length is what "the outline" means, and
 * it is what a run of type is measured against.
 *
 * Ties keep the first, so the answer is stable for a symmetric path.
 */
export function longestSubpath(d: string, opts?: FlattenOptions): FlatSubpath | null {
  const subs = flattenPath(d, opts)
  let best: FlatSubpath | null = null
  let bestLen = -1
  for (const s of subs) {
    const len = subpathLength(s)
    if (len > bestLen) { bestLen = len; best = s }
  }
  return best
}
