# Vector Type Smart Stretch — Phase A (core + stretch lab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure typographic-stretch engine (`stretch.ts`) and the `/dev/stretch-lab` page where Julien judges stretch quality by eye — the hard gate before any studio integration (Phase B, separate plan).

**Architecture:** A pure module computes a per-glyph **flex profile** (per-bin stretchiness from outline tangent alignment, after Pagurek), integrates it into monotone piecewise-linear X/Y remaps (vertical map baseline-anchored), and applies them to outline commands and advances. A cascade helper spends a real `wdth` axis before geometry. The lab page renders naive (k=0) vs smart vs axis-only side by side with flex overlays.

**Tech Stack:** TypeScript (Nuxt 4 / Vue 3), fontkit outlines via existing `font.ts`/`outline.ts`, vitest for unit tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-vector-type-smart-stretch-design.md`

## Global Constraints

- `stretch.ts` is PURE: no canvas, no DOM, no fetch, no imports outside `~/lib` (spec: "commands in, commands out").
- Command count NEVER changes across any stretch value (the studio's animation invariant).
- Both remaps are monotone; the vertical remap has fixed point y = 0 (baseline anchor).
- Flex formula: per bin, `min over ink segments crossing the bin of |tangent · stretch-direction|^k`; empty bins flex = 1. Defaults: 64 bins, k = 2. `k = 0` intentionally reproduces uniform (naive) scaling.
- Stretch factors are `S` (horizontal) and `SY` (vertical), 1 = as drawn; slider range in the lab is 0.5–2.5.
- Sidebearings are flexible: run assembly scales whitespace by `S`; vertical stretch never changes advances.
- Tests run from `frontend/`: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`. Fixture font: `frontend/tests/fixtures/inter-subset-var.ttf` (chars " Sagilor", axes `opsz` + `wght`, unitsPerEm 2048 — read it from the loaded font, don't hardcode).
- Commit after every task. Never `git stash`; stage only the files this plan touches (parallel-session hygiene).
- All code comments follow house style: explain constraints the code can't show, never narrate the change.

## Existing interfaces this plan consumes (do not re-implement)

From `frontend/app/lib/vectortype/outline.ts`:
```ts
export type PathCommand = VectorCommand  // { command: 'moveTo'|'lineTo'|'quadraticCurveTo'|'bezierCurveTo'|'closePath', args: number[] }
export interface VtBBox { minX: number; minY: number; maxX: number; maxY: number }
export interface GlyphOutline { commands: PathCommand[]; advance: number; x: number; y: number; bbox: VtBBox; glyphId: number; codePoints: number[] }
export interface TextOutlines { glyphs: GlyphOutline[]; width: number; unitsPerEm: number; coords: Record<string, number>; bbox: VtBBox }
export function textOutlines(font: VtFont, text: string, axes?: Record<string, number>): TextOutlines
```
Coordinates are FONT UNITS, y-up, baseline at y = 0.

From `frontend/app/lib/vectortype/font.ts`:
```ts
export interface VtAxis { tag: string; name: string; min: number; default: number; max: number }
export interface VtFont { id: string; axes: VtAxis[]; unitsPerEm: number; raw: any }
export function loadVariableFont(id: string): Promise<VtFont>   // browser only (fetch)
export function normaliseAxes(raw: unknown): VtAxis[]           // for building VtFont from fixture bytes in tests
```

Font catalog ids for the lab (from `frontend/app/data/variable-fonts.ts`): `inter` (no wdth), `roboto-flex` (wdth 25–151), `archivo` (wdth 62–125), `fraunces` (high-contrast serif), `source-serif` (serif), `unbounded` (round-heavy display).

---

### Task 1: Flex profile analysis (`analyzeFlex`)

**Files:**
- Create: `frontend/app/lib/vectortype/stretch.ts`
- Create: `frontend/tests/unit/vectortype-stretch.unit.spec.ts`

**Interfaces:**
- Consumes: `PathCommand`, `VtBBox` from `~/lib/vectortype/outline`.
- Produces (later tasks rely on these exact names):
```ts
export interface FlexProfile { start: number; binSize: number; flex: Float64Array }
export interface GlyphFlex { x: FlexProfile; y: FlexProfile }
export interface FlexOptions { bins?: number; k?: number }   // defaults 64, 2
export function analyzeFlex(commands: readonly PathCommand[], bbox: VtBBox, opts?: FlexOptions): GlyphFlex
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/unit/vectortype-stretch.unit.spec.ts`:

```ts
/**
 * Vector Type — smart stretch engine (flex profiles + remaps).
 *
 * Pure geometry: plain arrays of numbers in and out, no canvas, no network.
 * The load-bearing invariants are the same ones the outline tests pin for
 * variable axes — command count never changes as the stretch parameter moves,
 * and the remap is monotone — because the motion system animates through
 * these outlines and relies on point-for-point correspondence.
 */
import { describe, expect, it } from 'vitest'
import type { PathCommand, VtBBox } from '~/lib/vectortype/outline'
import { analyzeFlex } from '~/lib/vectortype/stretch'

/** Closed axis-aligned rectangle as outline commands (font-unit space, y-up). */
function rect(x0: number, y0: number, x1: number, y1: number): PathCommand[] {
  return [
    { command: 'moveTo', args: [x0, y0] },
    { command: 'lineTo', args: [x1, y0] },
    { command: 'lineTo', args: [x1, y1] },
    { command: 'lineTo', args: [x0, y1] },
    { command: 'closePath', args: [] },
  ]
}

function bboxOf(...rects: Array<[number, number, number, number]>): VtBBox {
  return {
    minX: Math.min(...rects.map(r => r[0])),
    minY: Math.min(...rects.map(r => r[1])),
    maxX: Math.max(...rects.map(r => r[2])),
    maxY: Math.max(...rects.map(r => r[3])),
  }
}

describe('analyzeFlex', () => {
  it('marks a vertical stem rigid in X and flexible in Y', () => {
    // A tall thin stem: 100 wide, 700 tall.
    const cmds = rect(0, 0, 100, 700)
    const { x, y } = analyzeFlex(cmds, bboxOf([0, 0, 100, 700]), { bins: 16 })
    // Every X bin the stem covers holds near-vertical ink -> flex ~ 0.
    // (The stem's top/bottom edges are horizontal ink in those same bins, but
    // flex is the MIN over the slice, so the vertical sides win.)
    for (const f of x.flex) expect(f).toBeLessThan(0.05)
    // Y bins in the stem's interior see only vertical ink -> flex ~ 1;
    // only the bins holding the horizontal caps are pinned.
    const interior = Array.from(y.flex).slice(2, -2)
    for (const f of interior) expect(f).toBeGreaterThan(0.95)
    expect(y.flex[0]).toBeLessThan(0.05)
    expect(y.flex[y.flex.length - 1]).toBeLessThan(0.05)
  })

  it('leaves empty slices fully flexible', () => {
    // Two stems with a gap between them (an H without its crossbar).
    const left = rect(0, 0, 100, 700)
    const right = rect(500, 0, 600, 700)
    const { x } = analyzeFlex([...left, ...right], bboxOf([0, 0, 600, 700]), { bins: 24 })
    // Bins over the gap (x in ~[100, 500]) carry no ink -> flex 1 exactly.
    const gapStart = Math.ceil((100 - x.start) / x.binSize) + 1
    const gapEnd = Math.floor((500 - x.start) / x.binSize) - 1
    for (let i = gapStart; i < gapEnd; i++) expect(x.flex[i]).toBe(1)
  })

  it('k = 0 makes every inked slice fully flexible (uniform-scaling mode)', () => {
    const cmds = rect(0, 0, 100, 700)
    const { x, y } = analyzeFlex(cmds, bboxOf([0, 0, 100, 700]), { bins: 16, k: 0 })
    for (const f of x.flex) expect(f).toBe(1)
    for (const f of y.flex) expect(f).toBe(1)
  })

  it('gives diagonals partial flex', () => {
    // A 45-degree bar: |tangent . x-hat| = cos(45) ~ 0.707, squared ~ 0.5.
    const cmds: PathCommand[] = [
      { command: 'moveTo', args: [0, 0] },
      { command: 'lineTo', args: [700, 700] },
      { command: 'lineTo', args: [760, 700] },
      { command: 'lineTo', args: [60, 0] },
      { command: 'closePath', args: [] },
    ]
    const { x } = analyzeFlex(cmds, bboxOf([0, 0, 760, 700]), { bins: 16, k: 2 })
    const mid = x.flex[8]!
    expect(mid).toBeGreaterThan(0.3)
    expect(mid).toBeLessThan(0.7)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: FAIL — `Cannot find module '~/lib/vectortype/stretch'` (or equivalent resolve error).

- [ ] **Step 3: Implement `analyzeFlex`**

Create `frontend/app/lib/vectortype/stretch.ts`:

```ts
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
import type { PathCommand, VtBBox } from './outline'

export interface FlexProfile {
  /** Left/bottom edge of bin 0, in font units. */
  start: number
  binSize: number
  /** Per-bin stretchiness in [0, 1]; 1 = fully flexible. */
  flex: Float64Array
}

export interface GlyphFlex {
  x: FlexProfile
  y: FlexProfile
}

export interface FlexOptions {
  bins?: number
  k?: number
}

const DEFAULT_BINS = 64
const DEFAULT_K = 2
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

  // Per-column / per-row minima over INK cells only, then downsample to bins.
  const colMin = new Float64Array(GRID).fill(1)
  const rowMin = new Float64Array(GRID).fill(1)
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const j = idx(c, r)
      if (!ink[j]) continue
      if (ax[j]! < colMin[c]!) colMin[c] = ax[j]!
      if (ay[j]! < rowMin[r]!) rowMin[r] = ay[j]!
    }
  }
  const cellsPerBin = GRID / bins
  for (let b = 0; b < bins; b++) {
    let mx = 1, my = 1
    const g0 = Math.floor(b * cellsPerBin)
    const g1 = Math.min(GRID - 1, Math.ceil((b + 1) * cellsPerBin) - 1)
    for (let g = g0; g <= g1; g++) {
      if (colMin[g]! < mx) mx = colMin[g]!
      if (rowMin[g]! < my) my = rowMin[g]!
    }
    flexX[b] = Math.pow(mx, k)
    flexY[b] = Math.pow(my, k)
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/vectortype/stretch.ts frontend/tests/unit/vectortype-stretch.unit.spec.ts
git commit -m "feat(vectortype): flex profile analysis for smart stretch"
```

---

### Task 2: Monotone remap + `stretchCommands`

**Files:**
- Modify: `frontend/app/lib/vectortype/stretch.ts` (append)
- Modify: `frontend/tests/unit/vectortype-stretch.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `FlexProfile`, `GlyphFlex`, `analyzeFlex` from Task 1.
- Produces:
```ts
export interface Remap { src: Float64Array; dst: Float64Array }   // matching breakpoints, both non-decreasing
export function buildRemap(profile: FlexProfile, S: number, fixedPoint?: number): Remap
export function remapValue(m: Remap, v: number): number
export function stretchCommands(commands: readonly PathCommand[], flex: GlyphFlex, S: number, SY: number): PathCommand[]
```

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/vectortype-stretch.unit.spec.ts`:

```ts
import { buildRemap, remapValue, stretchCommands } from '~/lib/vectortype/stretch'

describe('buildRemap / remapValue', () => {
  const uniform: import('~/lib/vectortype/stretch').FlexProfile = {
    start: 0, binSize: 10, flex: new Float64Array(10).fill(1),
  }

  it('scales a fully flexible profile uniformly', () => {
    const m = buildRemap(uniform, 2)
    expect(remapValue(m, 0)).toBeCloseTo(0, 6)
    expect(remapValue(m, 50)).toBeCloseTo(100, 6)
    expect(remapValue(m, 100)).toBeCloseTo(200, 6)
  })

  it('holds rigid bins and grows flexible ones', () => {
    const flex = new Float64Array(10).fill(1)
    flex[4] = 0; flex[5] = 0            // rigid core at [40, 60]
    const m = buildRemap({ start: 0, binSize: 10, flex }, 1.5)
    // Total width 100 -> 150; the rigid 20 stays 20.
    expect(remapValue(m, 60) - remapValue(m, 40)).toBeCloseTo(20, 6)
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeCloseTo(150, 6)
  })

  it('is monotone even under heavy condensing', () => {
    const flex = new Float64Array(10).fill(0)
    flex[2] = 1; flex[7] = 1
    const m = buildRemap({ start: 0, binSize: 10, flex }, 0.5)
    let prev = -Infinity
    for (let v = 0; v <= 100; v += 1) {
      const r = remapValue(m, v)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
    // Clamps stop total collapse.
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeGreaterThan(25)
  })

  it('honours a fixed point (baseline anchor)', () => {
    const flex = new Float64Array(10).fill(1)
    // Profile spans [-30, 70] like a glyph with a descender below baseline 0.
    const m = buildRemap({ start: -30, binSize: 10, flex }, 2, 0)
    expect(remapValue(m, 0)).toBeCloseTo(0, 6)
    expect(remapValue(m, 70)).toBeCloseTo(140, 6)   // grows up
    expect(remapValue(m, -30)).toBeCloseTo(-60, 6)  // descender grows down
  })

  it('an all-rigid profile leaves geometry untouched', () => {
    const flex = new Float64Array(10).fill(0)
    const m = buildRemap({ start: 0, binSize: 10, flex }, 2)
    expect(remapValue(m, 0)).toBeCloseTo(0, 6)
    expect(remapValue(m, 100)).toBeCloseTo(100, 6)
  })
})

describe('stretchCommands', () => {
  it('never changes the command count and keeps closePath args empty', () => {
    const cmds: PathCommand[] = [
      { command: 'moveTo', args: [0, 0] },
      { command: 'bezierCurveTo', args: [10, 80, 90, 80, 100, 0] },
      { command: 'quadraticCurveTo', args: [50, -40, 0, 0] },
      { command: 'closePath', args: [] },
    ]
    const flex = analyzeFlex(cmds, { minX: 0, minY: -40, maxX: 100, maxY: 80 })
    for (const [s, sy] of [[0.5, 1], [1, 1], [1.8, 1], [1, 2.2], [2.4, 0.6]] as const) {
      const out = stretchCommands(cmds, flex, s, sy)
      expect(out.map(c => c.command)).toEqual(cmds.map(c => c.command))
      expect(out.map(c => c.args.length)).toEqual(cmds.map(c => c.args.length))
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: FAIL — `buildRemap` is not exported.

- [ ] **Step 3: Implement remap + stretchCommands**

Append to `frontend/app/lib/vectortype/stretch.ts`:

```ts
export interface Remap {
  src: Float64Array
  dst: Float64Array
}

/** Fraction of its natural width a flexible bin may condense to before the
 *  deficit spills over to rigid bins. */
const BIN_FLOOR = 0.02
/** Uniform-compression floor once every bin is pinned — the "glyph never
 *  collapses" clamp. */
const MIN_TOTAL_SCALE = 0.25

function binWidths(flex: Float64Array, w: number, S: number): Float64Array {
  const n = flex.length
  const out = new Float64Array(n).fill(w)
  const total = n * w
  const delta = (S - 1) * total
  if (Math.abs(delta) < 1e-12) return out
  if (delta > 0) {
    let sum = 0
    for (const f of flex) sum += f
    if (sum < 1e-9) return out   // all-rigid: the glyph cannot widen
    for (let i = 0; i < n; i++) out[i] = w + delta * (flex[i]! / sum)
    return out
  }
  // Condense: flexible bins give first (floored), then everything compresses
  // uniformly, clamped so the glyph never collapses.
  let deficit = -delta
  const floor = w * BIN_FLOOR
  for (let pass = 0; pass < 4 && deficit > 1e-9; pass++) {
    let sum = 0
    for (let i = 0; i < n; i++) if (flex[i]! > 0 && out[i]! > floor + 1e-12) sum += flex[i]!
    if (sum < 1e-9) break
    let taken = 0
    for (let i = 0; i < n; i++) {
      if (!(flex[i]! > 0) || out[i]! <= floor + 1e-12) continue
      const can = Math.min(deficit * (flex[i]! / sum), out[i]! - floor)
      out[i]! -= can
      taken += can
    }
    deficit -= taken
    if (taken < 1e-12) break
  }
  if (deficit > 1e-9) {
    let cur = 0
    for (const v of out) cur += v
    const scale = Math.max(MIN_TOTAL_SCALE, (cur - deficit) / cur)
    for (let i = 0; i < n; i++) out[i]! *= scale
  }
  return out
}

export function buildRemap(profile: FlexProfile, S: number, fixedPoint?: number): Remap {
  const { start, binSize: w, flex } = profile
  const n = flex.length
  const widths = binWidths(flex, w, S)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/vectortype/stretch.ts frontend/tests/unit/vectortype-stretch.unit.spec.ts
git commit -m "feat(vectortype): monotone flex remap + stretchCommands with baseline anchor"
```

---

### Task 3: Run-level stretch (`stretchOutlines`) + real-font measured tests

**Files:**
- Modify: `frontend/app/lib/vectortype/stretch.ts` (append)
- Modify: `frontend/tests/unit/vectortype-stretch.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `TextOutlines`, `GlyphOutline` from `~/lib/vectortype/outline`; Task 1–2 exports.
- Produces:
```ts
export function stretchOutlines(outlines: TextOutlines, S: number, SY: number, opts?: FlexOptions): TextOutlines
export function glyphFlexFor(g: GlyphOutline, opts?: FlexOptions): GlyphFlex   // cached per GlyphOutline object
```

- [ ] **Step 1: Write the failing tests**

Append to the spec file. The fixture-font loader mirrors `vectortype-outline.unit.spec.ts` exactly:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { textOutlines } from '~/lib/vectortype/outline'
import type { TextOutlines } from '~/lib/vectortype/outline'
import { glyphFlexFor, stretchOutlines } from '~/lib/vectortype/stretch'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}

const font = loadFixtureFont()

/** Ink intervals where the horizontal line y = yLine crosses the glyph,
 *  measured on the flattened outline via sorted crossings. Assumes the chosen
 *  scanline meets the glyph an even number of times and winding does not
 *  overlap (true for the stems and rings used below) — a measuring stick for
 *  tests, not a general rasteriser. */
function inkRunsAtY(commands: readonly PathCommand[], yLine: number): Array<[number, number]> {
  const xs: number[] = []
  // Flatten exactly like the engine: reuse its resolution by sampling curves
  // at 32 steps — finer than analysis so measurement error stays below
  // assertion tolerance.
  let px = 0, py = 0, sx = 0, sy = 0
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    if ((y0 <= yLine && y1 > yLine) || (y1 <= yLine && y0 > yLine)) {
      xs.push(x0 + ((yLine - y0) / (y1 - y0)) * (x1 - x0))
    }
  }
  const emit = (x1: number, y1: number) => { seg(px, py, x1, y1); px = x1; py = y1 }
  for (const c of commands) {
    const a = c.args
    if (c.command === 'moveTo') { px = a[0]!; py = a[1]!; sx = px; sy = py }
    else if (c.command === 'lineTo') emit(a[0]!, a[1]!)
    else if (c.command === 'quadraticCurveTo') {
      const [cx, cy, x, y] = a as [number, number, number, number]
      const x0 = px, y0 = py
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, u = 1 - t
        emit(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y)
      }
    } else if (c.command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]
      const x0 = px, y0 = py
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, u = 1 - t
        emit(
          u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
        )
      }
    } else if (c.command === 'closePath') emit(sx, sy)
  }
  xs.sort((a, b) => a - b)
  const runs: Array<[number, number]> = []
  for (let i = 0; i + 1 < xs.length; i += 2) runs.push([xs[i]!, xs[i + 1]!])
  return runs
}

/** Same measuring stick rotated: ink intervals along x = xLine. */
function inkRunsAtX(commands: readonly PathCommand[], xLine: number): Array<[number, number]> {
  const swapped = commands.map(c => ({
    command: c.command,
    args: c.args.map((v, i) => (i % 2 === 0 ? c.args[i + 1]! : c.args[i - 1]!)),
  }))
  return inkRunsAtY(swapped, xLine)
}

function glyphOf(o: TextOutlines, ch: string) {
  const g = o.glyphs.find(g => g.codePoints.includes(ch.codePointAt(0)!))
  if (!g) throw new Error(`fixture has no '${ch}'`)
  return g
}

describe('stretchOutlines (fixture font)', () => {
  const base = textOutlines(font, 'Sailor')

  it('keeps command count constant across a stretch sweep', () => {
    const count = (o: TextOutlines) => o.glyphs.reduce((n, g) => n + g.commands.length, 0)
    for (const [s, sy] of [[0.6, 1], [1, 1], [1.7, 1], [1, 1.8], [2.4, 2.4]] as const) {
      expect(count(stretchOutlines(base, s, sy))).toBe(count(base))
    }
  })

  it("preserves the stem width of 'l' at S = 2", () => {
    const g0 = glyphOf(base, 'l')
    const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
    const w0 = inkRunsAtY(g0.commands, midY).map(([a, b]) => b - a)
    const g2 = glyphOf(stretchOutlines(base, 2, 1), 'l')
    const w2 = inkRunsAtY(g2.commands, midY).map(([a, b]) => b - a)
    expect(w2.length).toBe(w0.length)
    // 5%: bin quantisation moves stem edges by at most one 1/64 slice.
    expect(w2[0]!).toBeGreaterThan(w0[0]! * 0.95)
    expect(w2[0]!).toBeLessThan(w0[0]! * 1.05)
  })

  it("preserves the ring thickness of 'o' at S = 2 (sides) and SY = 2 (arches)", () => {
    const g0 = glyphOf(base, 'o')
    const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
    const sides0 = inkRunsAtY(g0.commands, midY).map(([a, b]) => b - a)
    const gS = glyphOf(stretchOutlines(base, 2, 1), 'o')
    const sidesS = inkRunsAtY(gS.commands, midY).map(([a, b]) => b - a)
    expect(sidesS.length).toBe(2)
    // 15%: the ring's flanks are curved, so some tangent leakage is expected —
    // the point is beating naive scaling, which would give 100% growth.
    for (let i = 0; i < 2; i++) {
      expect(sidesS[i]!).toBeLessThan(sides0[i]! * 1.15)
    }
    const midX0 = (g0.bbox.minX + g0.bbox.maxX) / 2
    const arch0 = inkRunsAtX(g0.commands, midX0).map(([a, b]) => b - a)
    const gY = glyphOf(stretchOutlines(base, 1, 2), 'o')
    const midXY = (gY.bbox.minX + gY.bbox.maxX) / 2
    const archY = inkRunsAtX(gY.commands, midXY).map(([a, b]) => b - a)
    expect(archY.length).toBe(2)
    for (let i = 0; i < 2; i++) {
      expect(archY[i]!).toBeLessThan(arch0[i]! * 1.15)
    }
  })

  it('anchors the baseline: l sits on y = 0 at SY = 2, g grows its descender down', () => {
    const tall = stretchOutlines(base, 1, 2)
    const l0 = glyphOf(base, 'l'), l2 = glyphOf(tall, 'l')
    expect(Math.abs(l2.bbox.minY - l0.bbox.minY)).toBeLessThan(font.unitsPerEm * 0.01)
    expect(l2.bbox.maxY).toBeGreaterThan(l0.bbox.maxY * 1.5)
    const gBase = textOutlines(font, 'g')
    const gTall = stretchOutlines(gBase, 1, 2)
    expect(gTall.glyphs[0]!.bbox.minY).toBeLessThan(gBase.glyphs[0]!.bbox.minY * 1.2)
  })

  it('grows the run width at S = 1.5, but less than naive 1.5x', () => {
    const out = stretchOutlines(base, 1.5, 1)
    expect(out.width).toBeGreaterThan(base.width * 1.05)
    expect(out.width).toBeLessThanOrEqual(base.width * 1.5 + 1)
  })

  it('vertical stretch leaves advances alone', () => {
    const out = stretchOutlines(base, 1, 2.2)
    expect(out.width).toBeCloseTo(base.width, 3)
    out.glyphs.forEach((g, i) => expect(g.advance).toBeCloseTo(base.glyphs[i]!.advance, 3))
  })

  it('S = SY = 1 returns the outlines unchanged', () => {
    expect(stretchOutlines(base, 1, 1)).toBe(base)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: FAIL — `stretchOutlines` is not exported.

- [ ] **Step 3: Implement `stretchOutlines` + `glyphFlexFor`**

Append to `frontend/app/lib/vectortype/stretch.ts`:

```ts
import type { GlyphOutline, TextOutlines } from './outline'
```
(merge into the existing import from `'./outline'` at the top of the file)

```ts
/** Flex analysis is the expensive step, so it is memoised on the outline
 *  object itself. GlyphOutline objects are fresh per textOutlines() call, so
 *  this never conflates different fonts, texts, or axis positions. Keying by
 *  (fontId, glyphId, coords) for cross-call reuse is Phase B, in the studio. */
const flexCache = new WeakMap<GlyphOutline, Map<string, GlyphFlex>>()

export function glyphFlexFor(g: GlyphOutline, opts: FlexOptions = {}): GlyphFlex {
  const key = `${opts.bins ?? DEFAULT_BINS}|${opts.k ?? DEFAULT_K}`
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
  const glyphs: GlyphOutline[] = []
  let penOld = 0
  let penNew = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const g of outlines.glyphs) {
    let commands = g.commands
    let bbox = g.bbox
    let inkW = 0
    let newInkW = 0
    if (hasInk(g)) {
      const flex = glyphFlexFor(g, opts)
      const rx = buildRemap(flex.x, S)
      const ry = buildRemap(flex.y, SY, 0)
      commands = g.commands.map(c => {
        if (!c.args.length) return { command: c.command, args: [] }
        const args = c.args.slice()
        for (let i = 0; i + 1 < args.length; i += 2) {
          args[i] = remapValue(rx, args[i]!)
          args[i + 1] = remapValue(ry, args[i + 1]!)
        }
        return { command: c.command, args }
      })
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
    // barely wider.
    const whitespace = g.advance - inkW
    const advance = newInkW + whitespace * S
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
```

Note for the implementer: `stretchCommands` from Task 2 and the inline mapping here share their per-point loop; extract a small local helper `applyRemaps(commands, rx, ry)` and have both call it (DRY), keeping the exported signatures exactly as specified.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: PASS. If the `'o'` ring tolerance fails, do NOT loosen the assertion — check flatten resolution (`CURVE_STEPS`) and bin count first; 64 bins at Inter's 2048 upm gives ~10-unit slices, well inside 15%.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/vectortype/stretch.ts frontend/tests/unit/vectortype-stretch.unit.spec.ts
git commit -m "feat(vectortype): run-level stretchOutlines with flexible sidebearings + measured fixture tests"
```

---

### Task 4: Axis cascade (`solveAxis`, `planStretch`) + weight compensation

**Files:**
- Modify: `frontend/app/lib/vectortype/stretch.ts` (append)
- Modify: `frontend/tests/unit/vectortype-stretch.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `VtFont` from `~/lib/vectortype/font`, `textOutlines` from `~/lib/vectortype/outline`.
- Produces:
```ts
export function solveAxis(measure: (v: number) => number, min: number, max: number, target: number): number
export interface StretchPlan { coords: Record<string, number>; residual: number }
export function planStretch(font: VtFont, text: string, axes: Record<string, number>, S: number): StretchPlan
export function weightCompensation(font: VtFont, axes: Record<string, number>, S: number, SY: number, amount?: number): Record<string, number>
```

- [ ] **Step 1: Write the failing tests**

Append:

```ts
import { planStretch, solveAxis, weightCompensation } from '~/lib/vectortype/stretch'

describe('cascade', () => {
  it('solveAxis finds the value hitting the target on a monotone function', () => {
    const measure = (v: number) => 100 + v * 2   // width grows with the axis
    expect(solveAxis(measure, 0, 100, 200)).toBeCloseTo(50, 1)
    // Target beyond reach clamps to the extreme.
    expect(solveAxis(measure, 0, 100, 1000)).toBe(100)
    expect(solveAxis(measure, 0, 100, 50)).toBe(0)
  })

  it('planStretch passes S through untouched when the font has no wdth axis', () => {
    const plan = planStretch(font, 'Sailor', {}, 1.8)
    expect(plan.residual).toBeCloseTo(1.8, 6)
    expect(plan.coords.wdth).toBeUndefined()
  })

  it('weightCompensation nudges wght up when extending, and is clamped', () => {
    const base = { wght: 400 }
    const wide = weightCompensation(font, base, 2, 1)
    expect(wide.wght!).toBeGreaterThan(400)
    const extreme = weightCompensation(font, base, 2.5, 2.5, 5)
    const wghtAxis = font.axes.find(a => a.tag === 'wght')!
    expect(extreme.wght!).toBeLessThanOrEqual(wghtAxis.max)
    // No wght axis -> untouched.
    const bare: VtFont = { ...font, axes: font.axes.filter(a => a.tag !== 'wght') }
    expect(weightCompensation(bare, base, 2, 1)).toEqual(base)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: FAIL — `solveAxis` is not exported.

- [ ] **Step 3: Implement**

Append to `frontend/app/lib/vectortype/stretch.ts` (add `import type { VtFont } from './font'` and `import { textOutlines } from './outline'` to the top-of-file imports):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: PASS (full file).

- [ ] **Step 5: Run the whole vectortype suite to catch regressions**

Run: `npx vitest run tests/unit/vectortype-outline.unit.spec.ts tests/unit/vectortype-stretch.unit.spec.ts`
Expected: PASS. (Check the collected-test total is what you expect — vitest counts lie under load.)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/vectortype/stretch.ts frontend/tests/unit/vectortype-stretch.unit.spec.ts
git commit -m "feat(vectortype): wdth-axis cascade + optical weight compensation helpers"
```

---

### Task 5: The stretch lab page

**Files:**
- Create: `frontend/app/pages/dev/stretch-lab.vue`

**Interfaces:**
- Consumes: `loadVariableFont` (`~/lib/vectortype/font`), `textOutlines` (`~/lib/vectortype/outline`), `stretchOutlines`, `glyphFlexFor`, `planStretch`, `weightCompensation` (`~/lib/vectortype/stretch`).
- Produces: a dev-only page at `/dev/stretch-lab`. Nothing imports it.

No unit test — the page IS the test rig; verification is the browser workflow in Task 6. Full page code:

- [ ] **Step 1: Write the page**

```vue
<script setup lang="ts">
// Stretch lab — Phase A judgment rig for typographic stretch. Dev-only, not
// linked in the app. Three columns per render: naive (k = 0 through the SAME
// engine — |tangent·s|^0 = 1 everywhere, which IS uniform scaling), the smart
// flex remap, and (fonts with wdth) the real axis alone. If naive and smart
// ever look identical on a stem-heavy string, the flex path silently didn't
// run — that is a bug, not a coincidence.
definePageMeta({ layout: false })
import { computed, onMounted, ref, watch } from 'vue'
import { loadVariableFont } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { textOutlines } from '~/lib/vectortype/outline'
import type { TextOutlines } from '~/lib/vectortype/outline'
import { glyphFlexFor, planStretch, stretchOutlines, weightCompensation } from '~/lib/vectortype/stretch'

const LAB_FONTS = ['inter', 'roboto-flex', 'archivo', 'fraunces', 'source-serif', 'unbounded']
const TORTURE = ['Sailor', 'OQCGS', 'AVWXY', 'MNH', 'aegs', 'gjpqy', 'STRETCH the word']

const fontId = ref(LAB_FONTS[0]!)
const text = ref('Sailor')
const S = ref(1.6)
const SY = ref(1)
const k = ref(2)
const overlay = ref(false)
const weightComp = ref(false)
const ready = ref(false)
const error = ref('')

const fonts = new Map<string, VtFont>()
const font = ref<VtFont | null>(null)

async function pickFont(id: string) {
  try {
    if (!fonts.has(id)) fonts.set(id, await loadVariableFont(id))
    font.value = fonts.get(id)!
    error.value = ''
  } catch (e) {
    error.value = String(e)
  }
}

const hasWdth = computed(() => !!font.value?.axes.some(a => a.tag === 'wdth'))

const naiveCanvas = ref<HTMLCanvasElement | null>(null)
const smartCanvas = ref<HTMLCanvasElement | null>(null)
const axisCanvas = ref<HTMLCanvasElement | null>(null)

function drawCommands(ctx: CanvasRenderingContext2D, o: TextOutlines) {
  const path = new Path2D()
  for (const g of o.glyphs) {
    for (const c of g.commands) {
      const a = c.args
      if (c.command === 'moveTo') path.moveTo(g.x + a[0]!, g.y + a[1]!)
      else if (c.command === 'lineTo') path.lineTo(g.x + a[0]!, g.y + a[1]!)
      else if (c.command === 'quadraticCurveTo') path.quadraticCurveTo(g.x + a[0]!, g.y + a[1]!, g.x + a[2]!, g.y + a[3]!)
      else if (c.command === 'bezierCurveTo') path.bezierCurveTo(g.x + a[0]!, g.y + a[1]!, g.x + a[2]!, g.y + a[3]!, g.x + a[4]!, g.y + a[5]!)
      else if (c.command === 'closePath') path.closePath()
    }
  }
  ctx.fill(path)
}

function render(canvas: HTMLCanvasElement | null, o: TextOutlines | null, withOverlay: boolean) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const W = 900, H = 260
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  if (!o || !o.glyphs.length) return
  const pad = 20
  const bw = Math.max(1, o.bbox.maxX - o.bbox.minX)
  const bh = Math.max(1, o.bbox.maxY - o.bbox.minY)
  const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)
  ctx.save()
  // Font space is y-up; canvas is y-down.
  ctx.translate(pad - o.bbox.minX * scale, H - pad + o.bbox.minY * scale)
  ctx.scale(scale, -scale)
  ctx.fillStyle = '#e8e8ec'
  drawCommands(ctx, o)
  if (withOverlay) {
    // Two-channel flex tint (after Pagurek): red = horizontally rigid,
    // blue = vertically rigid. Strong tint = the remap holds that slice.
    for (const g of o.glyphs) {
      const flex = glyphFlexFor(g, { k: k.value })
      const { start, binSize, flex: fx } = flex.x
      for (let i = 0; i < fx.length; i++) {
        const a = (1 - fx[i]!) * 0.35
        if (a < 0.02) continue
        ctx.fillStyle = `rgba(255,60,60,${a})`
        ctx.fillRect(g.x + start + i * binSize, g.bbox.minY, binSize, g.bbox.maxY - g.bbox.minY)
      }
      const fy = flex.y
      for (let i = 0; i < fy.flex.length; i++) {
        const a = (1 - fy.flex[i]!) * 0.35
        if (a < 0.02) continue
        ctx.fillStyle = `rgba(60,120,255,${a})`
        ctx.fillRect(g.x + g.bbox.minX, fy.start + i * fy.binSize, g.bbox.maxX - g.bbox.minX, fy.binSize)
      }
    }
  }
  ctx.restore()
}

function rerender() {
  const f = font.value
  if (!f) return
  const baseAxes: Record<string, number> = {}
  // Naive column: identical pipeline at k = 0 — uniform scaling by
  // construction, so any visible difference against smart is the flex doing
  // its job (and no difference on stem-heavy text means it is NOT running).
  const naiveBase = textOutlines(f, text.value, baseAxes)
  render(naiveCanvas.value, stretchOutlines(naiveBase, S.value, SY.value, { k: 0 }), false)

  const plan = planStretch(f, text.value, baseAxes, S.value)
  const smartAxes = weightComp.value
    ? weightCompensation(f, plan.coords, S.value, SY.value)
    : plan.coords
  const smartBase = textOutlines(f, text.value, smartAxes)
  render(smartCanvas.value, stretchOutlines(smartBase, plan.residual, SY.value, { k: k.value }), overlay.value)

  if (hasWdth.value) {
    render(axisCanvas.value, textOutlines(f, text.value, plan.coords), false)
  } else {
    render(axisCanvas.value, null, false)
  }
}

watch([font, text, S, SY, k, overlay, weightComp], rerender)
watch(fontId, id => { void pickFont(id!) })

onMounted(async () => {
  await pickFont(fontId.value!)
  rerender()
  ready.value = true
})
</script>

<template>
  <div class="min-h-screen bg-neutral-950 p-6 text-neutral-200" :data-ready="ready ? 'true' : undefined">
    <h1 class="mb-4 font-mono text-sm text-neutral-400">stretch lab — Phase A judgment rig</h1>
    <p v-if="error" class="mb-4 text-sm text-red-400">{{ error }}</p>

    <div class="mb-4 flex flex-wrap items-center gap-4 text-sm">
      <label class="flex items-center gap-2">
        Font
        <select v-model="fontId" class="rounded bg-neutral-800 px-2 py-1" data-test="font">
          <option v-for="id in LAB_FONTS" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <input v-model="text" class="w-64 rounded bg-neutral-800 px-2 py-1" data-test="text" />
      <div class="flex gap-1">
        <button
          v-for="t in TORTURE" :key="t"
          class="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
          @click="text = t"
        >{{ t }}</button>
      </div>
    </div>

    <div class="mb-6 flex flex-wrap items-center gap-6 text-sm">
      <label class="flex items-center gap-2">
        Stretch {{ S.toFixed(2) }}×
        <input v-model.number="S" type="range" min="0.5" max="2.5" step="0.01" class="w-48" data-test="stretch-x" />
      </label>
      <label class="flex items-center gap-2">
        Height {{ SY.toFixed(2) }}×
        <input v-model.number="SY" type="range" min="0.5" max="2.5" step="0.01" class="w-48" data-test="stretch-y" />
      </label>
      <label class="flex items-center gap-2">
        k {{ k.toFixed(1) }}
        <input v-model.number="k" type="range" min="0" max="8" step="0.1" class="w-32" data-test="k" />
      </label>
      <label class="flex items-center gap-2">
        <input v-model="overlay" type="checkbox" data-test="overlay" /> flex overlay
      </label>
      <label class="flex items-center gap-2">
        <input v-model="weightComp" type="checkbox" data-test="weight-comp" /> weight comp
      </label>
    </div>

    <div class="space-y-6">
      <div>
        <div class="mb-1 font-mono text-xs text-neutral-500">naive (k = 0 — the control to beat)</div>
        <canvas ref="naiveCanvas" class="rounded bg-neutral-900" data-test="canvas-naive" />
      </div>
      <div>
        <div class="mb-1 font-mono text-xs text-neutral-500">smart (flex remap<span v-if="hasWdth"> after wdth cascade</span>)</div>
        <canvas ref="smartCanvas" class="rounded bg-neutral-900" data-test="canvas-smart" />
      </div>
      <div v-if="hasWdth">
        <div class="mb-1 font-mono text-xs text-neutral-500">axis only (real wdth, no remap)</div>
        <canvas ref="axisCanvas" class="rounded bg-neutral-900" data-test="canvas-axis" />
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run (from `frontend/`): `npx nuxi typecheck 2>&1 | tail -20`
Expected: no NEW errors naming stretch-lab, stretch.ts, or the test file (compare against the pre-existing baseline — an error naming your types is yours even if the count matches).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/pages/dev/stretch-lab.vue
git commit -m "feat(dev): stretch lab — Phase A judgment rig for typographic stretch"
```

---

### Task 6: Live browser verification of the lab

**Files:** none created — this task verifies in the running app.

**Interfaces:** consumes the dev server (`./dev.sh` conventions apply; use `127.0.0.1`, never `localhost`).

- [ ] **Step 1: Start/attach dev server and open the lab**

Open `http://127.0.0.1:3000/dev/stretch-lab` in the browser pane (check for orphaned dev servers first — `ps` for stray nuxt; `./dev.sh` kills and takes over). Wait for `[data-ready]` before interacting (first-click hydration race).

- [ ] **Step 2: Verify the smart path actually runs (anti-fallback check)**

With text `MNH` and Stretch = 2.0: read pixels of the naive and smart canvases via `javascript_tool` and assert they DIFFER:

```js
const px = id => {
  const c = document.querySelector(`[data-test="canvas-${id}"]`)
  const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let sum = 0; for (let i = 3; i < x.length; i += 40) sum += x[i]
  return sum
}
JSON.stringify({ naive: px('naive'), smart: px('smart'), differ: px('naive') !== px('smart') })
```
Expected: `differ: true`. If false, the flex path silently didn't run — fix before proceeding (graceful-fallback-hides-integration-failure).

- [ ] **Step 3: Verify k = 0 equivalence (the control is honest)**

Set the k slider to 0 (`form_input` on `[data-test="k"]`); re-run the probe. Expected: `differ: false` (both columns now uniform-scale). Restore k = 2 and confirm `differ: true` again — this is the "verify with a broken control" run, using k = 0 as the deliberately-disabled analysis.

- [ ] **Step 4: Console + error sweep**

`read_console_messages` with onlyErrors — expected: none from the lab page.

- [ ] **Step 5: Screenshot every torture string**

For each torture chip (`Sailor`, `OQCGS`, `AVWXY`, `MNH`, `aegs`, `gjpqy`) at Stretch 1.8× and again at Height 1.8×: screenshot the page for the Phase A review. Also one `roboto-flex` shot at Stretch 2.2× (cascade seam: axis maxes out, remap carries on) and one with the flex overlay on.

- [ ] **Step 6: Report**

Present the screenshots to Julien with the artifact watch list (cusps, glyph edges, self-overlapping outlines) called out. **Phase A ends here — Phase B is a separate plan, written only after sign-off.**

---

## Post-plan notes for the orchestrating session (not subagent tasks)

- After Phase A lands, update the Sailor build dashboard (standing rule — read the LIVE artifact first, update artifact + docs together).
- The Phase B plan should carry forward whatever the lab decides: the chosen default `k`, whether weight compensation ships, and any flex-heuristic fixes made during judgment.
- The spec's **seam-continuity test** (width-vs-dial monotone and jump-free across the wdth→remap handoff) needs a `wdth`-bearing fixture font; it lands in Phase B alongside the studio dial, with a small subset of Archivo added to `tests/fixtures/`.
