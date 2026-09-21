# Dither Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a whole-layer **Dither in / Dither out** transition to the Frame Compositor's Motion tab — one behaviour with three styles (Dissolve, Wipe, Dots) — drawn through a reusable "reveal mask" step the next transitions will plug into.

**Architecture:** Spec: `docs/superpowers/specs/2026-09-20-dither-transition-design.md`. A `dither` behaviour compiles to ONE number track on a motion-only property `reveal` (0 → 1 in, 1 → 0 out), so the timeline, easing, undo and export need nothing new. At draw time a fold finds the dither bar that owns the WINNING `reveal` track and parks a transient `motionReveal` note on the layer clone (amount + dials + seconds into the bar). `paintLayerStack` handles a layer carrying the note as: snapshot the backdrop → draw the layer exactly as today → erase where the mask says hidden → add the snapshot back in those places. The mask maths is pure (`lib/motionx/reveal/`); the canvas side lives in `lib/motionx/reveal/paint.ts`.

**Tech Stack:** TypeScript, Vitest, Vue 3 `<script setup>`, Tailwind, Canvas 2D.

## Global Constraints

The full binding list is `.superpowers/sdd/dither-constraints.md` — every implementer reads it first. The ones that shape code:

- Work in the main checkout. No worktree, no branch, never `git stash`, never `git add -A`. **Never start, stop or restart a dev server. Do not run Playwright.**
- Commit with a private git index in ONE shell invocation, then `git reset -q -- <the same exact paths>`; `git show --stat HEAD` must list only your files. Trailer, last line of the body: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Byte-identity: a layer with no dither bar mid-transition draws exactly as today — same canvas calls, same order. ONLY Task 3 touches `frontend/app/composables/useCompositorLayers.ts`.
- No `Math.random()` / `Date.now()` / `performance.now()` reachable from rendering.
- Every stored param is read through `revealParams()`; unknown enum / non-finite / out-of-range → the default.
- Stored param names and units (exact): `dir: 'in' | 'out'` (default `'in'`), `style: 'dissolve' | 'wipe' | 'dots'` (default `'dissolve'`), `cell` 1–40 thousandths of the frame's width (default 8), `drift` 0–30 cells per second (default 6), `angle` 0–360 degrees (default 0; 0 = towards the right, 90 = downwards), `softness` 0–1 (default 0.35).
- Inspector UI uses only the Studio control family; a segmented control's label goes in the row (`StudioSegmentedRow`). UI copy: sentence case, no identifiers.
- TDD: failing test first, show it fail, implement. Never weaken an existing test.
- Unit tests from `frontend/`: `npm run test:unit -- <filter>`. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "<your files>"` → no output.

## File structure

| File | Responsibility |
|---|---|
| Create `frontend/app/lib/motionx/reveal/params.ts` | Types (`RevealStyle`, `RevealParams`, `MotionReveal`), defaults, `revealParams()` normaliser |
| Create `frontend/app/lib/motionx/reveal/dither.ts` | Pure maths: Bayer table, drift, per-style "is this cell shown", `cellRange`, `buildHiddenMask` |
| Create `frontend/app/lib/motionx/reveal/index.ts` | Barrel |
| Create `frontend/app/lib/motionx/reveal/paint.ts` | Canvas side: canvas pool, `beginReveal` / `finishReveal`, the hidden-side sources |
| Modify `frontend/app/lib/motionx/evaluate.ts` | Export `pickTrack` (the precedence rule, extracted unchanged) |
| Modify `frontend/app/lib/motionx/behaviour.ts` | Register the `dither` compiler |
| Modify `frontend/app/lib/motionx/adapter/frame.ts` | `applyRevealBehaviours` fold, `MOTION_ONLY_LABELS` |
| Modify `frontend/app/lib/motionx/bands.ts` | Bar labels "Dither in" / "Dither out" |
| Modify `frontend/app/lib/compositor/silhouetteCache.ts` | Strip `motionReveal` from the outline cache key |
| Modify `frontend/app/composables/useCompositorLayers.ts` | Task 3 only: fold call + begin/finish around the layer draw |
| Modify `frontend/app/lib/motionx/gallery.ts` | Two gallery moves + `'dither'` preview kind |
| Create `frontend/app/components/vue-canvas/compositor/MotionDitherPreview.vue` | The gallery tile's tiny live canvas |
| Modify `frontend/app/components/vue-canvas/compositor/MotionGallery.vue` | Render that tile |
| Modify `frontend/app/components/vue-canvas/compositor/MotionInspector.vue` | The Dither block; hide Open into keyframes |
| Modify `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue` | Row label "Reveal" |
| Tests | `frontend/tests/unit/motionx/reveal-dither.unit.spec.ts`, `reveal-fold.unit.spec.ts`, `reveal-paint.unit.spec.ts`; additions to `gallery.unit.spec.ts`, `bands.unit.spec.ts` |

---

### Task 1: The pure mask maths

**Files:**
- Create: `frontend/app/lib/motionx/reveal/params.ts`, `frontend/app/lib/motionx/reveal/dither.ts`, `frontend/app/lib/motionx/reveal/index.ts`
- Test: `frontend/tests/unit/motionx/reveal-dither.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks rely on these exact names):
  - `type RevealStyle = 'dissolve' | 'wipe' | 'dots'`, `REVEAL_STYLES`
  - `interface RevealParams { style: RevealStyle; out: boolean; cell: number; drift: number; angle: number; softness: number }` — `cell` is a FRACTION of the frame's width (stored thousandths ÷ 1000), `angle` is RADIANS.
  - `interface MotionReveal extends RevealParams { amount: number; elapsed: number }`
  - `REVEAL_DEFAULTS` (stored units), `revealParams(params: Record<string, unknown> | undefined): RevealParams`
  - `bayer8(cx: number, cy: number): number`, `driftCells(r: MotionReveal): { dx: number; dy: number }`
  - `cellShown(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): boolean` (dissolve + wipe)
  - `DOT_PITCH_CELLS = 3`, `dotRadius(amount: number): number` (in pitches), `dotShown(r: MotionReveal, u: number, v: number): boolean` (u, v in frame-width units)
  - `cellRange(inv: { a: number; b: number; c: number; d: number; e: number; f: number }, canvasW: number, canvasH: number, W: number, H: number, cell: number): { c0: number; r0: number; cols: number; rows: number }`
  - `buildHiddenMask(r: MotionReveal, range: { c0: number; r0: number; cols: number; rows: number }, grid: { cols: number; rows: number }): Uint8ClampedArray` — RGBA, alpha 255 where HIDDEN.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/motionx/reveal-dither.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  revealParams, bayer8, driftCells, cellShown, dotRadius, dotShown, cellRange, buildHiddenMask,
  DOT_PITCH_CELLS, type MotionReveal,
} from '~/lib/motionx/reveal'

const GRID = { cols: 125, rows: 70 }   // a 16:9 frame at cell = 8‰
const R = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ ...revealParams({}), amount: 0.5, elapsed: 0, ...over })
const shownCount = (r: MotionReveal) => {
  let n = 0
  for (let y = 0; y < GRID.rows; y++) for (let x = 0; x < GRID.cols; x++) if (cellShown(r, x, y, GRID)) n++
  return n
}

describe('revealParams', () => {
  it('defaults', () => {
    expect(revealParams(undefined)).toEqual({ style: 'dissolve', out: false, cell: 0.008, drift: 6, angle: 0, softness: 0.35 })
  })
  it('converts stored units: thousandths → fraction, degrees → radians, dir → out', () => {
    const p = revealParams({ dir: 'out', style: 'wipe', cell: 20, drift: 0, angle: 90, softness: 0 })
    expect(p.out).toBe(true); expect(p.style).toBe('wipe'); expect(p.cell).toBeCloseTo(0.02, 9)
    expect(p.drift).toBe(0); expect(p.angle).toBeCloseTo(Math.PI / 2, 9); expect(p.softness).toBe(0)
  })
  it('bad values fall back to the default, out-of-range values clamp', () => {
    const p = revealParams({ style: 'plaid', cell: NaN, drift: 'fast', angle: Infinity, softness: null, dir: 7 })
    expect(p).toEqual(revealParams({}))
    expect(revealParams({ cell: 0 }).cell).toBeCloseTo(0.001, 9)
    expect(revealParams({ cell: 999 }).cell).toBeCloseTo(0.04, 9)
    expect(revealParams({ drift: -3 }).drift).toBe(0)
    expect(revealParams({ softness: 4 }).softness).toBe(1)
  })
})

describe('bayer8', () => {
  it('64 distinct thresholds strictly inside (0, 1), tiling every 8 cells, negative indices included', () => {
    const seen = new Set<number>()
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(bayer8(x, y))
    expect(seen.size).toBe(64)
    expect(Math.min(...seen)).toBeGreaterThan(0); expect(Math.max(...seen)).toBeLessThan(1)
    expect(bayer8(-1, -3)).toBe(bayer8(7, 5)); expect(bayer8(19, 8)).toBe(bayer8(3, 0))
  })
})

describe('dissolve', () => {
  it('amount 0 shows nothing, amount 1 everything, 0.5 exactly half', () => {
    expect(shownCount(R({ amount: 0 }))).toBe(0)
    expect(shownCount(R({ amount: 1 }))).toBe(GRID.cols * GRID.rows)
    const tile = { cols: 8, rows: 8 }
    let n = 0
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (cellShown(R({ amount: 0.5 }), x, y, tile)) n++
    expect(n).toBe(32)
  })
  it('with no drift a shown cell never turns off as the amount rises', () => {
    const still = (a: number) => R({ amount: a, drift: 0, elapsed: 3 })
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let on = false
      for (let a = 0; a <= 1.0001; a += 0.02) {
        const s = cellShown(still(a), x, y, GRID)
        if (on) expect(s, `${x},${y} @ ${a}`).toBe(true)
        on = s
      }
    }
  })
  it('drift moves the pattern in whole cells along the angle, and is still at drift 0', () => {
    expect(driftCells(R({ elapsed: 1, drift: 6, angle: 0 }))).toEqual({ dx: 6, dy: 0 })
    expect(driftCells(R({ elapsed: 0.5, drift: 6, angle: Math.PI / 2 }))).toEqual({ dx: 0, dy: 3 })
    expect(driftCells(R({ elapsed: 9, drift: 0 }))).toEqual({ dx: 0, dy: 0 })
    const a = R({ elapsed: 0 }), b = R({ elapsed: 0.5 })
    let differs = false
    for (let x = 0; x < 16 && !differs; x++) if (cellShown(a, x, 0, GRID) !== cellShown(b, x, 0, GRID)) differs = true
    expect(differs).toBe(true)
    expect(cellShown(a, 5, 5, GRID)).toBe(cellShown(R({ elapsed: 0.5 }), 5 + 3, 5, GRID))
  })
  it('amounts past the ends are clamped (a spring overshoots)', () => {
    expect(shownCount(R({ amount: 1.2 }))).toBe(GRID.cols * GRID.rows)
    expect(shownCount(R({ amount: -0.3 }))).toBe(0)
  })
})

describe('wipe', () => {
  const W = (over: Partial<MotionReveal> = {}) => R({ style: 'wipe', drift: 0, ...over })
  it('amount 0 shows nothing and amount 1 everything, at four angles, in and out', () => {
    for (const deg of [0, 90, 180, 270]) for (const out of [false, true]) {
      const angle = (deg * Math.PI) / 180
      expect(shownCount(W({ amount: 0, angle, out }))).toBe(0)
      expect(shownCount(W({ amount: 1, angle, out }))).toBe(GRID.cols * GRID.rows)
    }
  })
  it('IN at angle 0: everything behind the band shows, everything ahead of it is hidden', () => {
    const r = W({ amount: 0.5, softness: 0.2 })
    // band spans s ∈ (front − soft, front) = (0.4, 0.6) with front = amount × (1 + soft)
    for (let y = 0; y < GRID.rows; y += 7) {
      for (let x = 0; x < GRID.cols; x++) {
        const s = (x + 0.5) / GRID.cols
        if (s < 0.39) expect(cellShown(r, x, y, GRID), `behind ${x}`).toBe(true)
        if (s > 0.61) expect(cellShown(r, x, y, GRID), `ahead ${x}`).toBe(false)
      }
    }
  })
  it('OUT keeps sweeping the same way: the empty side grows from the START side', () => {
    const r = W({ amount: 0.5, softness: 0, out: true })
    expect(cellShown(r, 2, 10, GRID)).toBe(false)               // start side already gone
    expect(cellShown(r, GRID.cols - 3, 10, GRID)).toBe(true)     // far side still there
  })
  it('softness 0 is a hard edge and never divides by zero', () => {
    const r = W({ amount: 0.5, softness: 0 })
    for (let x = 0; x < GRID.cols; x++) {
      const v = cellShown(r, x, 3, GRID)
      expect(v).toBe((x + 0.5) / GRID.cols < 0.5)
    }
  })
  it('never turns a shown cell off as the amount rises (no drift)', () => {
    for (let x = 0; x < GRID.cols; x += 3) {
      let on = false
      for (let a = 0; a <= 1.0001; a += 0.02) {
        const s = cellShown(W({ amount: a }), x, 11, GRID)
        if (on) expect(s).toBe(true)
        on = s
      }
    }
  })
})

describe('dots', () => {
  it('radius grows from 0 and closes every gap before amount 1', () => {
    expect(dotRadius(0)).toBe(0)
    expect(dotRadius(0.95)).toBeGreaterThanOrEqual(Math.SQRT1_2)   // ≥ half a diagonal, in pitches
    expect(dotRadius(0.5)).toBeGreaterThan(dotRadius(0.25))
  })
  it('a point at a dot centre shows first, the corner between four dots shows last', () => {
    const pitch = revealParams({}).cell * DOT_PITCH_CELLS
    const d = (a: number) => R({ style: 'dots', amount: a, drift: 0 })
    expect(dotShown(d(0.05), pitch / 2, pitch / 2)).toBe(true)
    expect(dotShown(d(0.05), 0, 0)).toBe(false)
    expect(dotShown(d(0.96), 0, 0)).toBe(true)
  })
  it('the grid drifts smoothly with elapsed time', () => {
    const pitch = revealParams({}).cell * DOT_PITCH_CELLS
    const moving = R({ style: 'dots', amount: 0.05, drift: 6, elapsed: 0.01 })
    expect(dotShown(moving, pitch / 2 + 0.01 * 6 * revealParams({}).cell, pitch / 2)).toBe(true)
  })
})

describe('cellRange + buildHiddenMask', () => {
  const ID = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  it('an untransformed canvas the size of the frame covers exactly the frame grid', () => {
    expect(cellRange(ID, 1000, 560, 1000, 560, 0.008)).toEqual({ c0: 0, r0: 0, cols: 125, rows: 70 })
  })
  it('a canvas showing pasteboard around the frame extends the range to negative cells', () => {
    // frame drawn at 0.5× and offset (100, 50): inverse = scale 2, translate (−200, −100)
    const inv = { a: 2, b: 0, c: 0, d: 2, e: -200, f: -100 }
    const r = cellRange(inv, 700, 400, 1000, 560, 0.008)
    expect(r.c0).toBeLessThan(0); expect(r.r0).toBeLessThan(0)
    expect((r.c0 + r.cols) * 8).toBeGreaterThanOrEqual(1200)   // covers x = 1200 frame px
  })
  it('an absurd range is cut back to the frame rather than allocating millions of cells', () => {
    const huge = { a: 400, b: 0, c: 0, d: 400, e: 0, f: 0 }
    const r = cellRange(huge, 4000, 4000, 1000, 560, 0.001)
    expect(r.cols * r.rows).toBeLessThanOrEqual(1_000_000)
  })
  it('the mask is RGBA with alpha 255 exactly where the cell is hidden, addressed from the range origin', () => {
    const r = R({ amount: 0.5 })
    const range = { c0: -2, r0: -1, cols: 6, rows: 4 }
    const px = buildHiddenMask(r, range, GRID)
    expect(px.length).toBe(6 * 4 * 4)
    for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) {
      const hidden = !cellShown(r, i - 2, j - 1, GRID)
      expect(px[(j * 6 + i) * 4 + 3]).toBe(hidden ? 255 : 0)
    }
  })
  it('identical inputs give identical bytes', () => {
    const range = { c0: 0, r0: 0, cols: 40, rows: 20 }
    expect(buildHiddenMask(R({ elapsed: 1.23 }), range, GRID)).toEqual(buildHiddenMask(R({ elapsed: 1.23 }), range, GRID))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npm run test:unit -- reveal-dither`
Expected: FAIL — cannot resolve `~/lib/motionx/reveal`.

- [ ] **Step 3: Implement `params.ts`**

```ts
// frontend/app/lib/motionx/reveal/params.ts
// A REVEAL is a whole-layer transition drawn through a mask: every pixel of the layer is
// either shown or hidden, decided per frame from ONE animated number (the amount, 0 → 1)
// plus the look's dials. This file is the vocabulary; `dither.ts` is the maths; `paint.ts`
// is the only canvas-aware part. Pure: no Vue, no DOM.
export type RevealStyle = 'dissolve' | 'wipe' | 'dots'
export const REVEAL_STYLES: readonly RevealStyle[] = ['dissolve', 'wipe', 'dots']

/** The dials as the MATHS wants them: `cell` a fraction of the frame's width, `angle` radians. */
export interface RevealParams { style: RevealStyle; out: boolean; cell: number; drift: number; angle: number; softness: number }
/** What the fold parks on a layer clone for one frame. Transient — never persisted. */
export interface MotionReveal extends RevealParams { amount: number; elapsed: number }

/** Defaults in STORED units (what `behaviour.params` holds and the inspector shows). */
export const REVEAL_DEFAULTS = { style: 'dissolve' as RevealStyle, cell: 8, drift: 6, angle: 0, softness: 0.35 }
export const REVEAL_RANGES = { cell: [1, 40], drift: [0, 30], angle: [0, 360], softness: [0, 1] } as const

const num = (v: unknown, d: number, [lo, hi]: readonly [number, number]) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** The ONE reader of a dither bar's stored params. Unknown enum / non-finite number → default;
 *  out-of-range number → clamped. */
export function revealParams(params: Record<string, unknown> | undefined): RevealParams {
  const p = params ?? {}
  const style = (REVEAL_STYLES as readonly unknown[]).includes(p.style) ? (p.style as RevealStyle) : REVEAL_DEFAULTS.style
  return {
    style,
    out: p.dir === 'out',
    cell: num(p.cell, REVEAL_DEFAULTS.cell, REVEAL_RANGES.cell) / 1000,
    drift: num(p.drift, REVEAL_DEFAULTS.drift, REVEAL_RANGES.drift),
    angle: (num(p.angle, REVEAL_DEFAULTS.angle, REVEAL_RANGES.angle) * Math.PI) / 180,
    softness: num(p.softness, REVEAL_DEFAULTS.softness, REVEAL_RANGES.softness),
  }
}
```

- [ ] **Step 4: Implement `dither.ts` and the barrel**

```ts
// frontend/app/lib/motionx/reveal/dither.ts
// The dither maths. A CELL is one square of the pattern, `cell × frameWidth` pixels on a side,
// addressed by integer (cx, cy) from the frame's top-left; cells outside the frame (negative,
// or past the last column) are legal — the editor shows pasteboard around the frame and the
// layer can hang over it. Pure functions of (amount, elapsed, dials): preview, bake and export
// agree frame for frame.
import type { MotionReveal } from './params'

// The classic 8×8 ordered-dither matrix, values 0..63.
const B8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]
const wrap8 = (n: number) => ((Math.floor(n) % 8) + 8) % 8
/** The threshold of cell (cx, cy), strictly inside (0, 1). Tiles every 8 cells. */
export function bayer8(cx: number, cy: number): number {
  return (B8[wrap8(cy) * 8 + wrap8(cx)]! + 0.5) / 64
}

/** How far the pattern has slid, in WHOLE cells — the stepping shimmer of an ordered dither. */
export function driftCells(r: MotionReveal): { dx: number; dy: number } {
  const d = Math.max(0, r.elapsed) * r.drift
  // `+ 0` turns a −0 into 0 so callers can compare with toEqual.
  return { dx: Math.floor(d * Math.cos(r.angle) + 1e-9) + 0, dy: Math.floor(d * Math.sin(r.angle) + 1e-9) + 0 }
}

/** Where cell (cx, cy) sits along the wipe's direction of travel: 0 at the side the edge starts
 *  from, 1 at the far side, measured across the FRAME's grid (so it can leave [0, 1] on the
 *  pasteboard). */
function along(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): number {
  const ux = Math.cos(r.angle), uy = Math.sin(r.angle)
  const proj = (x: number, y: number) => x * ux + y * uy
  const corners = [proj(0, 0), proj(grid.cols, 0), proj(0, grid.rows), proj(grid.cols, grid.rows)]
  const lo = Math.min(...corners), hi = Math.max(...corners)
  const s = hi - lo < 1e-9 ? 0 : (proj(cx + 0.5, cy + 0.5) - lo) / (hi - lo)
  // OUT keeps sweeping the same way: the EMPTY side grows from the start side.
  return r.out ? 1 - s : s
}

/** Dissolve and Wipe: is this cell shown? */
export function cellShown(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): boolean {
  if (!(r.amount > 0)) return false
  if (r.amount >= 1) return true
  const { dx, dy } = driftCells(r)
  const th = bayer8(cx - dx, cy - dy)
  if (r.style !== 'wipe') return r.amount > th
  const s = along(r, cx, cy, grid)
  if (r.softness <= 1e-6) return s < r.amount
  // The band of width `softness` sits just behind a front that runs 0 → 1 + softness, so the
  // frame is empty at amount 0 and full at amount 1 whatever the softness.
  const local = (r.amount * (1 + r.softness) - s) / r.softness
  return local >= 1 || (local > 0 && local > th)
}

/** Dots sit on a square grid this many cells apart. */
export const DOT_PITCH_CELLS = 3
/** Dot radius in PITCHES. Neighbouring dots close the last gap (the corner between four of
 *  them) at √½ ≈ 0.707, reached at amount ≈ 0.94 — before the transition ends. */
export function dotRadius(amount: number): number {
  return Math.max(0, Math.min(1, amount)) * 0.75
}
/** Dots: is the point (u, v) — in frame-WIDTH units from the frame's top-left — inside a dot?
 *  The grid slides smoothly (not in whole cells): a dot is a vector shape, it has no steps. */
export function dotShown(r: MotionReveal, u: number, v: number): boolean {
  if (!(r.amount > 0)) return false
  if (r.amount >= 1) return true
  const pitch = r.cell * DOT_PITCH_CELLS
  const slide = Math.max(0, r.elapsed) * r.drift * r.cell
  const fx = ((((u - slide * Math.cos(r.angle)) / pitch) % 1) + 1) % 1 - 0.5
  const fy = ((((v - slide * Math.sin(r.angle)) / pitch) % 1) + 1) % 1 - 0.5
  return Math.hypot(fx, fy) < dotRadius(r.amount)
}

const MAX_CELLS = 1_000_000
/** The block of cells that covers the whole visible canvas. `inv` maps DEVICE pixels back to
 *  frame pixels (the inverse of the painter's transform). Cut back to the frame itself when
 *  the honest answer would be absurd (a huge zoom-out at the finest cell size). */
export function cellRange(
  inv: { a: number; b: number; c: number; d: number; e: number; f: number },
  canvasW: number, canvasH: number, W: number, H: number, cell: number,
): { c0: number; r0: number; cols: number; rows: number } {
  const cellPx = Math.max(1e-6, cell * W)
  const frame = { c0: 0, r0: 0, cols: Math.max(1, Math.ceil(W / cellPx - 1e-9)), rows: Math.max(1, Math.ceil(H / cellPx - 1e-9)) }
  const xs: number[] = [], ys: number[] = []
  for (const [x, y] of [[0, 0], [canvasW, 0], [0, canvasH], [canvasW, canvasH]] as const) {
    xs.push(inv.a * x + inv.c * y + inv.e); ys.push(inv.b * x + inv.d * y + inv.f)
  }
  if (![...xs, ...ys].every(Number.isFinite)) return frame
  const c0 = Math.min(0, Math.floor(Math.min(...xs) / cellPx))
  const r0 = Math.min(0, Math.floor(Math.min(...ys) / cellPx))
  const c1 = Math.max(frame.cols, Math.ceil(Math.max(...xs) / cellPx))
  const r1 = Math.max(frame.rows, Math.ceil(Math.max(...ys) / cellPx))
  const cols = c1 - c0, rows = r1 - r0
  return cols * rows > MAX_CELLS ? frame : { c0, r0, cols, rows }
}

/** One RGBA pixel per cell of `range`; alpha 255 where the cell is HIDDEN. The painter scales
 *  it up with smoothing off, so a pixel is exactly a cell. */
export function buildHiddenMask(
  r: MotionReveal, range: { c0: number; r0: number; cols: number; rows: number }, grid: { cols: number; rows: number },
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(range.cols * range.rows * 4)
  for (let j = 0; j < range.rows; j++) for (let i = 0; i < range.cols; i++) {
    if (!cellShown(r, range.c0 + i, range.r0 + j, grid)) px[(j * range.cols + i) * 4 + 3] = 255
  }
  return px
}
```

```ts
// frontend/app/lib/motionx/reveal/index.ts
export * from './params'
export * from './dither'
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm run test:unit -- reveal-dither`
Expected: PASS. If the `driftCells` case `{ dx: 0, dy: 3 }` fails on a floating `cos(π/2)`, the `+ 1e-9` nudge in `driftCells` is what makes `3 × 6.1e-17` floor to 0 and `3.0000000001` floor to 3 — keep it.

- [ ] **Step 6: Typecheck and commit**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "motionx/reveal"` → no output.
Commit (private-index recipe, one shell call): the three new lib files + the new spec file `frontend/tests/unit/motionx/reveal-dither.unit.spec.ts`.
Subject: `feat(motionx): the reveal mask maths — dissolve, wipe and dots as pure functions`

---

### Task 2: The `dither` behaviour and the fold

**Files:**
- Modify: `frontend/app/lib/motionx/evaluate.ts`, `frontend/app/lib/motionx/behaviour.ts`, `frontend/app/lib/motionx/adapter/frame.ts`, `frontend/app/lib/motionx/bands.ts`, `frontend/app/lib/compositor/silhouetteCache.ts`
- Test: create `frontend/tests/unit/motionx/reveal-fold.unit.spec.ts`; add cases to `frontend/tests/unit/motionx/bands.unit.spec.ts`

**Interfaces:**
- Consumes: `revealParams`, `MotionReveal` from Task 1.
- Produces:
  - `pickTrack(list: Track[], t: number): Track | undefined` exported from `~/lib/motionx` (via `evaluate.ts`)
  - behaviour kind `'dither'` → ONE track, path `reveal`, type `number`
  - `applyRevealBehaviours(layers: LocalLayer[], tracks: Track[] | undefined, behaviours: StoredBehaviour[] | undefined, t: number | undefined): LocalLayer[]` from `~/lib/motionx/adapter/frame`
  - `MOTION_ONLY_LABELS: Record<string, string>` (`{ reveal: 'Reveal' }`) from the same file
  - the transient layer field is named exactly `motionReveal`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/motionx/reveal-fold.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { compileBehaviour, evaluateTracks, pickTrack, type Behaviour, type StoredBehaviour, type Track } from '~/lib/motionx'
import { applyRevealBehaviours, applyMotionxTracks, compileBehaviourForLayer, animatableProperties, MOTION_ONLY_LABELS } from '~/lib/motionx/adapter/frame'
import { SILHOUETTE_KEY_STRIP } from '~/lib/compositor/silhouetteCache'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { MotionReveal } from '~/lib/motionx/reveal'

const layer = (id = 'L') => ({ id, kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, rotation: 0, opacity: 1, fill: '#fff' }) as unknown as LocalLayer
const beh = (params: Record<string, unknown> = {}, start = 1, duration = 2, id = 'b1', layerId = 'L'): StoredBehaviour =>
  ({ id, layerId, kind: 'dither', params, timing: { start, duration } }) as StoredBehaviour
const tracksOf = (b: StoredBehaviour, l = layer(b.layerId)): Track[] =>
  compileBehaviourForLayer(l, b as unknown as Behaviour).map((t) => ({ ...t, behaviourId: b.id }))
const noteOf = (l: LocalLayer) => (l as unknown as { motionReveal?: MotionReveal }).motionReveal
const TARGET = { get: () => undefined, has: () => false }

describe('the dither compiler', () => {
  it('in: ONE number track on `reveal`, 0 → 1 across the bar', () => {
    const tr = compileBehaviour(beh() as unknown as Behaviour, TARGET)
    expect(tr).toHaveLength(1)
    expect(tr[0]!.path).toBe('reveal'); expect(tr[0]!.type).toBe('number')
    expect(tr[0]!.keyframes.map((k) => [k.t, k.value])).toEqual([[1, 0], [3, 1]])
  })
  it('out: 1 → 0', () => {
    const tr = compileBehaviour(beh({ dir: 'out' }) as unknown as Behaviour, TARGET)
    expect(tr[0]!.keyframes.map((k) => k.value)).toEqual([1, 0])
  })
  it('honours params.ease like every other bar', () => {
    const tr = compileBehaviour(beh({ ease: 'linear' }) as unknown as Behaviour, TARGET)
    expect(tr[0]!.keyframes[0]!.ease).toBe('linear')
  })
})

describe('pickTrack', () => {
  const tk = (start: number, id: string): Track => ({ path: 'p', type: 'number', behaviourId: id, keyframes: [{ t: start, value: 0, ease: 'linear' }, { t: start + 1, value: 1, ease: 'linear' }] })
  it('is the rule evaluateTracks already uses: latest STARTED wins, else the earliest lead-in', () => {
    const list = [tk(0, 'a'), tk(2, 'b')]
    expect(pickTrack(list, 1)?.behaviourId).toBe('a')
    expect(pickTrack(list, 2.5)?.behaviourId).toBe('b')
    expect(pickTrack([tk(3, 'late'), tk(2, 'early')], 0)?.behaviourId).toBe('early')
    expect(pickTrack([], 1)).toBeUndefined()
    expect(evaluateTracks(list, 2.5).get('p')).toBeCloseTo(0.5, 9)
  })
})

describe('applyRevealBehaviours', () => {
  it('mid-bar: parks the amount, the dials and the seconds into the bar on a CLONE', () => {
    const b = beh({ style: 'wipe', cell: 20, angle: 90, ease: 'linear' })
    const ls = [layer()]
    const out = applyRevealBehaviours(ls, tracksOf(b), [b], 2)
    expect(out).not.toBe(ls); expect(out[0]).not.toBe(ls[0])
    const n = noteOf(out[0]!)!
    expect(n.amount).toBeCloseTo(0.5, 9); expect(n.elapsed).toBeCloseTo(1, 9)
    expect(n.style).toBe('wipe'); expect(n.cell).toBeCloseTo(0.02, 9); expect(n.angle).toBeCloseTo(Math.PI / 2, 9)
    expect(noteOf(ls[0]!)).toBeUndefined()      // the stored layer is never written
  })
  it('fully shown → the layer is returned BY IDENTITY with no note (a finished entrance costs nothing)', () => {
    const b = beh()
    const ls = [layer()]
    expect(applyRevealBehaviours(ls, tracksOf(b), [b], 3.5)).toBe(ls)
    const spring = beh({ ease: { type: 'spring', bounce: 0.6 } })
    const st = tracksOf(spring)
    for (let t = 3; t < 6; t += 0.05) {
      const n = noteOf(applyRevealBehaviours(ls, st, [spring], t)[0]!)
      if (n) { expect(n.amount).toBeLessThan(1); expect(n.amount).toBeGreaterThanOrEqual(0) }
    }
  })
  it('fully hidden → a note with amount 0 (the painter skips the layer): before an In, after an Out', () => {
    const b = beh()
    expect(noteOf(applyRevealBehaviours([layer()], tracksOf(b), [b], 0.2)[0]!)!.amount).toBe(0)
    const o = beh({ dir: 'out' })
    expect(noteOf(applyRevealBehaviours([layer()], tracksOf(o), [o], 9)[0]!)!.amount).toBe(0)
    expect(applyRevealBehaviours([layer()], tracksOf(o), [o], 0.2)[0]).toBeDefined()
    expect(noteOf(applyRevealBehaviours([layer()], tracksOf(o), [o], 0.2)[0]!)).toBeUndefined()   // Out, before: fully shown
  })
  it('two bars on one layer: the note carries the dials of the bar whose track WINS', () => {
    const first = beh({ style: 'dots' }, 0, 1, 'first'), second = beh({ style: 'wipe', dir: 'out' }, 2, 1, 'second')
    const tracks = [...tracksOf(first), ...tracksOf(second)]
    expect(noteOf(applyRevealBehaviours([layer()], tracks, [first, second], 0.5)[0]!)!.style).toBe('dots')
    const late = noteOf(applyRevealBehaviours([layer()], tracks, [first, second], 2.5)[0]!)!
    expect(late.style).toBe('wipe'); expect(late.out).toBe(true); expect(late.elapsed).toBeCloseTo(0.5, 9)
  })
  it('idle inputs return the same array: no clock, no tracks, no behaviours, other layers, an untagged reveal band', () => {
    const b = beh(); const ls = [layer()]
    expect(applyRevealBehaviours(ls, tracksOf(b), [b], undefined)).toBe(ls)
    expect(applyRevealBehaviours(ls, [], [b], 2)).toBe(ls)
    expect(applyRevealBehaviours(ls, tracksOf(b), [], 2)).toBe(ls)
    expect(applyRevealBehaviours([layer('other')], tracksOf(b), [b], 2)[0]).toBeDefined()
    expect(noteOf(applyRevealBehaviours([layer('other')], tracksOf(b), [b], 2)[0]!)).toBeUndefined()
    const bare = tracksOf(b).map(({ behaviourId: _drop, ...t }) => t as Track)
    expect(applyRevealBehaviours(ls, bare, [b], 2)).toBe(ls)
  })
  it('the ordinary track fold ignores `reveal` (it is not a layer property)', () => {
    const b = beh(); const ls = [layer()]
    expect(applyMotionxTracks(ls, tracksOf(b), 2)).toBe(ls)
  })
  it('`reveal` is NOT offered in Add property, has a sentence-case row label, and is kept out of the outline cache key', () => {
    expect(animatableProperties(layer()).some((p) => p.path.endsWith('.reveal'))).toBe(false)
    expect(MOTION_ONLY_LABELS.reveal).toBe('Reveal')
    expect((SILHOUETTE_KEY_STRIP as readonly string[]).includes('motionReveal')).toBe(true)
  })
})
```

Add to `frontend/tests/unit/motionx/bands.unit.spec.ts` (inside the existing `behaviourLabel` describe, or a new one next to it):

```ts
it('labels a dither bar by its direction', () => {
  expect(behaviourLabel({ kind: 'dither', params: {} })).toBe('Dither in')
  expect(behaviourLabel({ kind: 'dither', params: { dir: 'out' } })).toBe('Dither out')
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && npm run test:unit -- reveal-fold bands`
Expected: FAIL — `pickTrack`, `applyRevealBehaviours`, `MOTION_ONLY_LABELS` are not exported; the label is `dither`.

- [ ] **Step 3: `evaluate.ts` — extract the precedence rule, unchanged**

Replace the body of `evaluateTracks`'s inner loop with a call to a new exported function that contains the SAME two loops verbatim:

```ts
/** The track that speaks for a shared path at `t` — the precedence rule of `evaluateTracks`
 *  (most recently STARTED wins; none started → the earliest lead-in), exposed so a caller that
 *  needs to know WHICH bar is driving a property can ask the same question. */
export function pickTrack(list: Track[], t: number): Track | undefined {
  let pick: Track | undefined
  let pickStart = -Infinity
  for (const tr of list) {                       // started: latest start wins, ties → later
    const s = startOf(tr)
    if (s <= t && s >= pickStart) { pick = tr; pickStart = s }
  }
  if (!pick) {                                   // none started: earliest lead-in, ties → later
    let best = Infinity
    for (const tr of list) { const s = startOf(tr); if (s <= best) { pick = tr; best = s } }
  }
  return pick
}
```

and in `evaluateTracks`: `const pick = pickTrack(list, t)` followed by the existing `const v = pick ? evaluateTrack(pick, t) : undefined` lines. The whole existing `evaluate.unit.spec.ts` must stay green untouched.

- [ ] **Step 4: `behaviour.ts` — the compiler**

After the `fade` registration:

```ts
// A REVEAL transition (dither today; more mask looks later): the bar drives ONE number, how
// revealed the layer is. The LOOK is not a track — it stays on the bar's params and the
// painter reads it through the fold (adapter/frame.ts `applyRevealBehaviours`).
registerBehaviour('dither', (b) => {
  const w = window(b.timing)
  return [b.params?.dir === 'out' ? numTrack('reveal', 1, 0, w) : numTrack('reveal', 0, 1, w)]
})
```

- [ ] **Step 5: `adapter/frame.ts` — labels and the fold**

Add the imports `pickTrack, evaluateTrack` to the existing `~/lib/motionx` import, and `import { revealParams, type MotionReveal } from '~/lib/motionx/reveal'`. Then, after `applyTextBehaviours`:

```ts
/** Properties a behaviour can drive that are NOT layer properties — never offered in Add
 *  property, but they still get a timeline row, which needs a name. */
export const MOTION_ONLY_LABELS: Record<string, string> = { reveal: 'Reveal' }

const startOfBar = (tr: Track) => (tr.keyframes.length ? Math.min(...tr.keyframes.map((k) => k.t)) : 0)

/**
 * Fold reveal transitions (dither) onto the layers for this frame.
 *
 * The bar's TRACK carries only the amount; the look lives on the bar. So for every layer with
 * a tagged `reveal` track, find the track that WINS at `t` (the same rule `evaluateTracks`
 * uses), read its bar's dials, and park `motionReveal` on a clone:
 *   amount ≥ 1 → nothing at all (layer by identity — a finished entrance costs nothing);
 *   amount ≤ 0 → a note with amount 0 (the painter skips the layer);
 *   between    → the note the painter draws through.
 * Same-reference return whenever nothing is attached. An UNTAGGED `reveal` band has no bar
 * and therefore no look: ignored.
 */
export function applyRevealBehaviours(
  layers: LocalLayer[], tracks: Track[] | undefined, behaviours: StoredBehaviour[] | undefined, t: number | undefined,
): LocalLayer[] {
  if (!tracks || tracks.length === 0 || !behaviours || behaviours.length === 0 || t == null) return layers
  const byLayer = new Map<string, Track[]>()
  for (const tr of tracks) {
    if (!tr.behaviourId) continue
    const m = tr.path.match(/^layers\.([^.]+)\.reveal$/)
    if (!m) continue
    const list = byLayer.get(m[1]!)
    if (list) list.push(tr); else byLayer.set(m[1]!, [tr])
  }
  if (byLayer.size === 0) return layers
  let changed = false
  const next = layers.map((layer) => {
    const list = byLayer.get(layer.id)
    if (!list) return layer
    const pick = pickTrack(list, t)
    const bar = pick && behaviours.find((b) => b.id === pick.behaviourId && b.kind === 'dither')
    if (!pick || !bar) return layer
    const v = evaluateTrack(pick, t)
    const amount = typeof v === 'number' && Number.isFinite(v) ? v : 1
    if (amount >= 1) return layer
    changed = true
    const note: MotionReveal = { ...revealParams(bar.params), amount: Math.max(0, amount), elapsed: Math.max(0, t - startOfBar(pick)) }
    return { ...layer, motionReveal: note } as unknown as LocalLayer
  })
  return changed ? next : layers
}
```

(`applyResolvedValue` already returns the layer unchanged for an unknown prop such as `reveal` — leave it alone; the test pins that.)

- [ ] **Step 6: `bands.ts` and `silhouetteCache.ts`**

`bands.ts`: add `dither: 'Dither',` to `BEHAVIOUR_LABELS` and, in `behaviourLabel`'s chain, `else if (b.kind === 'dither') withDir = dir === 'out' ? 'Dither out' : 'Dither in'`.

`silhouetteCache.ts`: append `'motionReveal'` to `SILHOUETTE_KEY_STRIP` (after `'textMotion'`) — a reveal never changes the layer's own outline.

- [ ] **Step 7: Run everything motionx**

Run: `cd frontend && npm run test:unit -- motionx` and `npm run test:unit -- silhouette`
Expected: all green, including the untouched `evaluate.unit.spec.ts`.

- [ ] **Step 8: Typecheck and commit**

`npx vue-tsc --noEmit 2>&1 | grep -E "motionx/(evaluate|behaviour|bands|adapter/frame)|silhouetteCache"` → no output.
Subject: `feat(motionx): a dither bar drives one reveal number; the fold hands the painter its look`

---

### Task 3: Drawing through the mask

**Files:**
- Create: `frontend/app/lib/motionx/reveal/paint.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (three hunks, all inside `paintLayerStack`)
- Test: create `frontend/tests/unit/motionx/reveal-paint.unit.spec.ts`

**Interfaces:**
- Consumes: `MotionReveal`, `cellRange`, `buildHiddenMask`, `dotRadius`, `DOT_PITCH_CELLS` (Task 1); `applyRevealBehaviours` (Task 2).
- Produces: `beginReveal(ctx, reveal, W, H): RevealPass | null`, `finishReveal(ctx, pass): void`, `setRevealCanvasFactory(fn)` (tests only), all from `~/lib/motionx/reveal/paint`. NOT re-exported from the barrel (the barrel stays DOM-free).

**The recipe (spec §4), exactly:**

`beginReveal` — before the layer is drawn:
1. `snap` = a pooled canvas sized to `ctx.canvas`. Copy the canvas into it: identity transform, `globalCompositeOperation = 'copy'`, `drawImage(ctx.canvas, 0, 0)`.
2. Remember `base = ctx.getTransform()` (the frame → device transform, taken BEFORE any per-layer scale).
3. Return `{ snap, base, reveal, W, H }`. Return `null` (draw the layer unmasked) if a 2D context cannot be had.

`finishReveal` — after the layer is drawn:
1. Build the hidden-side source ONCE (see below).
2. On `snap`: transform `base`, `globalCompositeOperation = 'destination-in'`, paint the hidden side → `snap` is now "the old picture, only where hidden".
3. On `ctx`, inside `save()` / `restore()`, with `filter = 'none'`, `shadowColor = 'transparent'`, `globalAlpha = 1`: transform `base`, `'destination-out'`, paint the hidden side (erases the layer AND the backdrop there); then identity transform, `'lighter'`, `drawImage(snap, 0, 0)` (adds the old picture back — `lighter` makes `old × a + new × (1 − a)` exact on a soft rim, where `source-over` would darken it).
4. Release `snap` to the pool.

**The hidden side, painted under `base`:**
- **Dissolve / Wipe:** `range = cellRange(inverse(base), canvas.width, canvas.height, W, H, reveal.cell)`; `grid` = the frame's own `{cols, rows}` (`cellRange(IDENTITY, W, H, W, H, cell)`); put `buildHiddenMask(reveal, range, grid)` into a pooled `range.cols × range.rows` canvas with `putImageData`; then `imageSmoothingEnabled = false; drawImage(mask, range.c0 × cellPx, range.r0 × cellPx, range.cols × cellPx, range.rows × cellPx)` with `cellPx = reveal.cell × W`.
- **Dots:** one pooled 64×64 tile: fill it opaque, then `destination-out` a circle at its centre of radius `dotRadius(amount) × 64`. `createPattern(tile, 'repeat')`, `pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(pitchPx / 64))` with `pitchPx = reveal.cell × DOT_PITCH_CELLS × W` and `(ox, oy) = elapsed × drift × cellPx × (cos angle, sin angle)`; `fillStyle = pattern; fillRect` over the frame-space rectangle that covers the visible canvas (the same bounds `cellRange` computes, in pixels). `imageSmoothingEnabled = true` so the rim is smooth. When `dotRadius ≥ √½` the tile is empty and nothing is hidden — still correct, no special case.

**The pool is a STACK** (`acquire()` pops or creates, `release()` pushes): the layer's own draw can re-enter `paintLayerStack` (glass and backdrop effects repaint what is below), and a lower layer may be mid-dither too, so two passes can be open at once.

- [ ] **Step 1: Write the failing tests**

Look at how `frontend/tests/unit/motionx/text-draw.unit.spec.ts` fakes a 2D context (a recorder object that logs method calls and property sets) and do the same. The tests must pin:

```ts
// frontend/tests/unit/motionx/reveal-paint.unit.spec.ts — the behaviours to pin
// 1. begin: copies ctx.canvas into a scratch canvas with composite 'copy' at the IDENTITY
//    transform; returns a pass holding the ctx's transform at that moment.
// 2. finish, dissolve: the recorded op order is
//      snap: setTransform(base) → gco 'destination-in' → drawImage(mask, c0·cellPx, r0·cellPx, cols·cellPx, rows·cellPx)
//      ctx : save → setTransform(base) → gco 'destination-out' → drawImage(mask, same rect)
//            → setTransform(identity) → gco 'lighter' → drawImage(snap, 0, 0) → restore
//    with imageSmoothingEnabled === false for BOTH mask draws, and the SAME mask canvas
//    object passed to both.
// 3. the mask canvas got putImageData with exactly buildHiddenMask(reveal, range, grid) bytes,
//    sized range.cols × range.rows.
// 4. finish, dots: a pattern is created from a 64×64 tile, its setTransform scale is
//    pitchPx / 64, and BOTH hidden-side paints are fillRect with that pattern as fillStyle.
// 5. ctx state is restored: save/restore are balanced and gco/filter/globalAlpha set inside.
// 6. pool: begin → begin → finish → finish uses TWO different scratch canvases; a following
//    begin reuses one of them (the factory is called no more than needed).
// 7. begin returns null when the factory's canvas has no 2D context; finishReveal(ctx, null
//    as never) is never called by the painter, so it need not tolerate null.
```

Write these as real `it(...)` cases with a recorder fake and `setRevealCanvasFactory(() => fakeCanvas())`. Every assertion above must exist as an `expect`.

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && npm run test:unit -- reveal-paint`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `paint.ts`**

```ts
// frontend/app/lib/motionx/reveal/paint.ts
// The canvas half of a reveal: "draw the layer normally, then put the old picture back
// wherever the mask says hidden". Doing it this way round — instead of cutting the layer out
// on a side canvas — keeps blend modes, shadows and every effect that reads what is BEHIND the
// layer (background blur, glass, backdrop shaders) exactly as they are without a reveal.
import { buildHiddenMask, cellRange, dotRadius, DOT_PITCH_CELLS } from './dither'
import type { MotionReveal } from './params'

type Canvas = HTMLCanvasElement
let makeCanvas: () => Canvas = () => document.createElement('canvas')
/** Tests swap the canvas source; nothing else should. */
export function setRevealCanvasFactory(fn: () => Canvas): void { makeCanvas = fn; pool.length = 0; smallPool.length = 0 }

// STACKS, not singletons: a layer's own draw can re-enter paintLayerStack (glass / backdrop
// effects repaint what is below), and a lower layer may be mid-reveal too.
const pool: Canvas[] = []
const smallPool: Canvas[] = []
const acquire = (from: Canvas[]) => from.pop() ?? makeCanvas()

export interface RevealPass { snap: Canvas; base: DOMMatrix; reveal: MotionReveal; W: number; H: number }

export function beginReveal(ctx: CanvasRenderingContext2D, reveal: MotionReveal, W: number, H: number): RevealPass | null {
  const snap = acquire(pool)
  const dev = ctx.canvas
  if (snap.width !== dev.width) snap.width = dev.width
  if (snap.height !== dev.height) snap.height = dev.height
  const sctx = snap.getContext('2d')
  if (!sctx) { pool.push(snap); return null }
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalCompositeOperation = 'copy'
  sctx.drawImage(dev, 0, 0)
  return { snap, base: ctx.getTransform(), reveal, W, H }
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** Build the hidden side once; the returned painter draws it (under the caller's transform
 *  and composite mode) as many times as asked. `release` hands the scratch canvas back. */
function hiddenSide(pass: RevealPass, canvasW: number, canvasH: number): { paint: (c: CanvasRenderingContext2D) => void; release: () => void } {
  const { reveal, W, H, base } = pass
  const cellPx = reveal.cell * W
  const inv = base.inverse()
  const range = cellRange(inv, canvasW, canvasH, W, H, reveal.cell)
  const x = range.c0 * cellPx, y = range.r0 * cellPx, w = range.cols * cellPx, h = range.rows * cellPx
  const small = acquire(smallPool)
  if (reveal.style === 'dots') {
    const T = 64
    if (small.width !== T) small.width = T
    if (small.height !== T) small.height = T
    const t = small.getContext('2d')!
    t.setTransform(1, 0, 0, 1, 0, 0)
    t.globalCompositeOperation = 'copy'
    t.fillStyle = '#000'
    t.fillRect(0, 0, T, T)
    t.globalCompositeOperation = 'destination-out'
    t.beginPath(); t.arc(T / 2, T / 2, dotRadius(reveal.amount) * T, 0, Math.PI * 2); t.fill()
    const pitchPx = cellPx * DOT_PITCH_CELLS
    const slide = Math.max(0, reveal.elapsed) * reveal.drift * cellPx
    // The dot sits at the tile's CENTRE, so the tile origin is half a pitch before a dot centre.
    const ox = slide * Math.cos(reveal.angle), oy = slide * Math.sin(reveal.angle)
    return {
      paint(c) {
        const pattern = c.createPattern(small, 'repeat')
        if (!pattern) return
        pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(pitchPx / T))
        c.imageSmoothingEnabled = true
        c.fillStyle = pattern
        c.fillRect(x, y, w, h)
      },
      release: () => { smallPool.push(small) },
    }
  }
  if (small.width !== range.cols) small.width = range.cols
  if (small.height !== range.rows) small.height = range.rows
  const grid = cellRange(IDENTITY, W, H, W, H, reveal.cell)
  const m = small.getContext('2d')!
  m.putImageData(new ImageData(buildHiddenMask(reveal, range, grid), range.cols, range.rows), 0, 0)
  return {
    paint(c) { c.imageSmoothingEnabled = false; c.drawImage(small, x, y, w, h) },
    release: () => { smallPool.push(small) },
  }
}

export function finishReveal(ctx: CanvasRenderingContext2D, pass: RevealPass): void {
  const { snap, base } = pass
  const sctx = snap.getContext('2d')
  if (!sctx) { pool.push(snap); return }
  const hidden = hiddenSide(pass, ctx.canvas.width, ctx.canvas.height)
  // the old picture, only where hidden
  sctx.setTransform(base)
  sctx.globalCompositeOperation = 'destination-in'
  hidden.paint(sctx)
  ctx.save()
  ctx.filter = 'none'; ctx.shadowColor = 'transparent'; ctx.globalAlpha = 1
  ctx.setTransform(base)
  ctx.globalCompositeOperation = 'destination-out'
  hidden.paint(ctx)                                   // erase layer + backdrop there…
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'lighter'
  ctx.drawImage(snap, 0, 0)                           // …and add the backdrop back
  ctx.restore()
  hidden.release()
  pool.push(snap)
}
```

If the unit environment has no `ImageData` / `DOMMatrix`, the test file supplies minimal stand-ins on `globalThis` in a `beforeAll` and removes them in `afterAll` — do not add environment guards to `paint.ts` for it.

- [ ] **Step 4: Run the painter tests**

Run: `cd frontend && npm run test:unit -- reveal-paint`
Expected: PASS.

- [ ] **Step 5: Wire `paintLayerStack` — three hunks in `useCompositorLayers.ts`**

Hunk A — imports (next to the existing `~/lib/motionx/...` imports):

```ts
import { beginReveal, finishReveal, type RevealPass } from '~/lib/motionx/reveal/paint'
import type { MotionReveal } from '~/lib/motionx/reveal'
```
and add `applyRevealBehaviours` to the existing import from `~/lib/motionx/adapter/frame`.

Hunk B — the fold, in `paintLayerStack`. The existing expression is
`const animatedLocals = applyTextBehaviours(applyMotionxTracks(…), motion?.behaviours, t)`.
Wrap it, leaving the inner expression byte-for-byte as it is:

```ts
  // Reveal transitions fold last of all: like letter behaviours they hand the painter author
  // state (the bar's look), and they need nothing from the layer but its id.
  const animatedLocals = applyRevealBehaviours(applyTextBehaviours(applyMotionxTracks(
    /* …unchanged… */
  ), motion?.behaviours, t), motion?.motionx, motion?.behaviours, t)
```
and extend the comment above it by one sentence; do not rewrite it.

Hunk C — the per-item loop. It already has this idiom for the draw-time scale:

```ts
    let motionScaleOpen = false
    for (const item of items) {
      if (motionScaleOpen) { ctx.restore(); motionScaleOpen = false }
```
Mirror it:

```ts
    let motionScaleOpen = false
    // A reveal wraps ONE layer's whole draw (every `continue` below included), so — like the
    // draw-time scale — it is closed at the top of the next turn and once more after the loop.
    let revealOpen: RevealPass | null = null
    for (const item of items) {
      if (motionScaleOpen) { ctx.restore(); motionScaleOpen = false }
      if (revealOpen) { finishReveal(ctx, revealOpen); revealOpen = null }
```
Then, immediately AFTER the line `const opacityMul = gc ? gc.opacity : 1` and BEFORE the `motionScale` block (the pass must capture the transform before that scale is applied):

```ts
      // A dither (reveal) bar mid-transition: nothing at all when fully hidden; otherwise keep
      // the backdrop so the hidden cells can be put back once the layer has drawn normally.
      const rv = (layer as unknown as { motionReveal?: MotionReveal }).motionReveal
      if (rv) {
        if (!(rv.amount > 0)) continue
        revealOpen = beginReveal(ctx, rv, W, H)
      }
```
And after the loop, the existing `if (motionScaleOpen) ctx.restore()` gains a second line, BEFORE the `post` chain runs:

```ts
    if (motionScaleOpen) ctx.restore()
    if (revealOpen) finishReveal(ctx, revealOpen)
```

A layer with no `motionReveal` takes none of these branches: no new canvas calls, byte-identical.

- [ ] **Step 6: Prove byte-identity and the wiring**

Add to `reveal-paint.unit.spec.ts` a source-level guard (the pattern `letters-ui.unit.spec.ts` uses — read the file as text): `useCompositorLayers.ts` contains `applyRevealBehaviours(applyTextBehaviours(`, contains `finishReveal(ctx, revealOpen)` exactly twice, and the `beginReveal(` call appears BEFORE the first `motionScale` read inside `paintLayerStack`.

Run: `cd frontend && npm run test:unit -- motionx` and `npm run test:unit -- compositor` (the existing compositor suites must not change count or go red; if a suite times out under load, run that spec alone before calling it broken).

- [ ] **Step 7: Typecheck, check the shared file's diff, commit**

`npx vue-tsc --noEmit 2>&1 | grep -E "reveal/paint|useCompositorLayers"` → nothing for `reveal/paint`; for `useCompositorLayers.ts` any line reported must be OUTSIDE your three hunks (the file may carry other sessions' pre-existing errors — list them in your report, do not fix them).
`git diff -- frontend/app/composables/useCompositorLayers.ts` → exactly hunks A, B, C. If anything else shows, STOP and report.
Subject: `feat(compositor): a layer mid-dither is drawn normally, then the backdrop is put back where the mask hides it`

---

### Task 4: Gallery, inspector, timeline row

**Files:**
- Modify: `frontend/app/lib/motionx/gallery.ts`, `frontend/app/components/vue-canvas/compositor/MotionGallery.vue`, `frontend/app/components/vue-canvas/compositor/MotionInspector.vue`, `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue`
- Create: `frontend/app/components/vue-canvas/compositor/MotionDitherPreview.vue`
- Test: add to `frontend/tests/unit/motionx/gallery.unit.spec.ts`; add to `frontend/tests/unit/motionx/letters-ui.unit.spec.ts` (the SFC-source-level spec)

**Interfaces:**
- Consumes: `REVEAL_DEFAULTS`, `REVEAL_RANGES`, `revealParams`, `cellShown` (Task 1); `MOTION_ONLY_LABELS` (Task 2).
- Produces: gallery move ids `dither-in`, `dither-out`; preview kind `'dither'`; inspector test ids `dither-style`, `dither-dir`, `dither-cell`, `dither-drift`, `dither-angle`, `dither-softness`.

- [ ] **Step 1: Failing tests**

`gallery.unit.spec.ts`:

```ts
describe('dither moves', () => {
  it('Dither in sits in the In group and Dither out in Out, for every layer', () => {
    const moves = movesForLayer({ gradient: false, text: false })
    const din = moves.find((m) => m.id === 'dither-in')!, dout = moves.find((m) => m.id === 'dither-out')!
    expect([din.kind, din.group, din.label, din.params]).toEqual(['dither', 'In', 'Dither in', { dir: 'in' }])
    expect([dout.kind, dout.group, dout.label, dout.params]).toEqual(['dither', 'Out', 'Dither out', { dir: 'out' }])
    expect(din.preview).toBe('dither'); expect(din.recipe).toBeUndefined()
  })
})
```
Also extend the existing "every move has … a registered-kind" allow-list in that file with `'dither'`.

`letters-ui.unit.spec.ts` (source-level, same style as the cases already there): `MotionInspector.vue` contains each of the six `data-testid` values above; `dither-softness` sits on an element guarded by a `v-if` that mentions `wipe`; the `beh-open` button's `v-if` excludes `dither`; the file contains no `<input` or `<select` inside the dither block (assert the substring between `kind === 'dither'` and the next `</template>` has neither). `MotionBandTimeline.vue` contains `MOTION_ONLY_LABELS`.

Run: `cd frontend && npm run test:unit -- gallery letters-ui` → FAIL.

- [ ] **Step 2: `gallery.ts`**

Add `'dither'` to `PreviewKind`. In `GALLERY_MOVES`, after `slide-right` (In) and after `scale-out` (Out):

```ts
  { id: 'dither-in', kind: 'dither', label: 'Dither in', group: 'In', preview: 'dither', params: { dir: 'in' } },
```
```ts
  { id: 'dither-out', kind: 'dither', label: 'Dither out', group: 'Out', preview: 'dither', params: { dir: 'out' } },
```
(`defaultDurationFor('In' | 'Out')` is already 0.8s — the spec's default.)

- [ ] **Step 3: `MotionDitherPreview.vue` — the tile's tiny live canvas**

The other tiles are CSS animations; a dither cannot be one, so this tile runs the REAL maths on a 48×30 canvas (`image-rendering: pixelated`, stretched to the tile). Requirements:
- props: `out: boolean`.
- one `requestAnimationFrame` loop started in `onMounted`, cancelled in `onBeforeUnmount`; the gallery popover only exists while open, so the loop's lifetime is the popover's.
- each frame: `cycle = (now / 1000 % 2.4) / 2.4`; amount ramps 0 → 1 over the first 60%, holds to 85%, then snaps back (for `out`: `1 − amount`); `elapsed = cycle × 2.4`; for every pixel `(x, y)` inside an inset rounded card region, ink `#7c9cff` if `cellShown({ ...revealParams({ cell: 40 }), out, amount, elapsed }, x, y, { cols: 48, rows: 30 })`, else leave transparent. One `ImageData` reused across frames.
- `prefers-reduced-motion: reduce` → draw ONE frame at amount 0.5, elapsed 0, and start no loop.
- `time` comes from the rAF timestamp argument — this is a UI preview, not the render path, so the no-`performance.now()` rule (which protects export determinism) is not in play; still, do not call `Date.now()`.

- [ ] **Step 4: `MotionGallery.vue`**

Where the tile picks its preview markup by `m.preview`, add a branch for `'dither'` rendering `<MotionDitherPreview :out="m.params?.dir === 'out'" class="absolute inset-0 h-full w-full" />`. Follow the file's existing branch style and import the component.

- [ ] **Step 5: `MotionInspector.vue` — the Dither block**

In the behaviour branch, next to the other whole-layer kinds (`fade`, `scale`, `slide`…), add `v-else-if="behaviour.kind === 'dither'"`. Script additions:

```ts
import { REVEAL_DEFAULTS, REVEAL_RANGES } from '~/lib/motionx/reveal'
const DITHER_STYLES = ['dissolve', 'wipe', 'dots']
const DITHER_STYLE_LABELS = ['Dissolve', 'Wipe', 'Dots']
```
Template (Studio rows only; `gesture()` / `setBehNum` / `numParam` / `enumParam` / `setBehParams` already exist in this file):

```vue
<template v-else-if="behaviour.kind === 'dither'">
  <StudioSegmentedRow data-testid="dither-style" label="Style"
    :model-value="enumParam('style', REVEAL_DEFAULTS.style)" :options="DITHER_STYLES" :option-labels="DITHER_STYLE_LABELS"
    @update:model-value="(v) => setBehParams({ style: v })" />
  <StudioSegmentedRow data-testid="dither-dir" label="Direction"
    :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
    @update:model-value="(v) => setBehParams({ dir: v })" />
  <StudioSlider data-testid="dither-cell" v-bind="gesture('dither-cell')"
    :label="enumParam('style', 'dissolve') === 'dots' ? 'Dot spacing' : 'Cell size'"
    hint="How chunky the pattern is, in thousandths of the frame's width"
    :model-value="numParam('cell', REVEAL_DEFAULTS.cell)" :min="REVEAL_RANGES.cell[0]" :max="REVEAL_RANGES.cell[1]" :step="1" :default="REVEAL_DEFAULTS.cell"
    @update:model-value="(v) => setBehNum('dither-cell', { cell: v })" />
  <StudioSlider data-testid="dither-drift" v-bind="gesture('dither-drift')"
    label="Drift speed" hint="How fast the pattern slides while the layer resolves, in cells per second. 0 is a still dither."
    :model-value="numParam('drift', REVEAL_DEFAULTS.drift)" :min="REVEAL_RANGES.drift[0]" :max="REVEAL_RANGES.drift[1]" :step="0.5" :default="REVEAL_DEFAULTS.drift"
    @update:model-value="(v) => setBehNum('dither-drift', { drift: v })" />
  <StudioSlider data-testid="dither-angle" v-bind="gesture('dither-angle')"
    label="Angle" hint="The way the pattern drifts and, for Wipe, the way the edge travels. 0 is towards the right, 90 is downwards."
    :model-value="numParam('angle', REVEAL_DEFAULTS.angle)" :min="REVEAL_RANGES.angle[0]" :max="REVEAL_RANGES.angle[1]" :step="1" :default="REVEAL_DEFAULTS.angle"
    @update:model-value="(v) => setBehNum('dither-angle', { angle: v })" />
  <StudioSlider v-if="enumParam('style', 'dissolve') === 'wipe'" data-testid="dither-softness" v-bind="gesture('dither-softness')"
    label="Edge softness" hint="How wide the dithered band on the travelling edge is. 0 is a hard line."
    :model-value="numParam('softness', REVEAL_DEFAULTS.softness)" :min="0" :max="1" :step="0.01" :default="REVEAL_DEFAULTS.softness"
    @update:model-value="(v) => setBehNum('dither-softness', { softness: v })" />
</template>
```
If `IN_OUT` / `IN_OUT_LABELS` are declared under different names in this file, use the existing ones — do not add duplicates. Change the Open-into-keyframes button's guard from `v-if="!isTextBeh"` to `v-if="!isTextBeh && behaviour.kind !== 'dither'"` (the look lives on the bar; a bare reveal band would have none).

- [ ] **Step 6: `MotionBandTimeline.vue` — the row's name**

In `rowsFor`, the label falls back to the path's last segment (`reveal`, lower case). Import `MOTION_ONLY_LABELS` next to the existing `animatableProperties` import and change the fallback to
`labels.get(path) ?? MOTION_ONLY_LABELS[path.split('.').pop() ?? ''] ?? path.split('.').pop() ?? path`.

- [ ] **Step 7: Run, typecheck, commit**

`cd frontend && npm run test:unit -- motionx` → green. `npx vue-tsc --noEmit 2>&1 | grep -E "MotionInspector|MotionGallery|MotionDitherPreview|MotionBandTimeline|motionx/gallery"` → no output.
Subject: `feat(compositor): Dither in / Dither out in the gallery, with Style, Cell size, Drift, Angle and Edge softness`

---

### Task 5: Live verification and final review (controller, not a subagent)

- [ ] On `http://127.0.0.1:3000/dev/frame-lab` (never start a server): add Dither in to the text layer; for each Style, seek mid-bar and read the stack canvas pixels over a flat backdrop — every pixel inside the layer's box is either the layer's colour or the backdrop's (Dots: bar a 1–2px rim).
- [ ] Pixels outside the layer's box equal the same frame with the bar removed.
- [ ] Drift > 0: two seeks at different times chosen to give the SAME amount differ; Drift = 0: they are identical.
- [ ] Rotate the layer 30°: cells stay axis-aligned squares.
- [ ] A layer with a blend mode: amount 0.999 looks like no bar.
- [ ] Before an In bar the layer is absent; after an Out bar it is absent; after an In bar the canvas call log has no reveal ops.
- [ ] Inspector: six rows, Edge softness only for Wipe, one undo step per drag, Open into keyframes absent; timeline row reads "Reveal"; gallery tile animates.
- [ ] Final whole-branch review on the most capable model over `review-package <base> HEAD`; ONE fix subagent for its findings; update the ledger, the spec status line, and memory.

---


# Part 2 — the Pixels style: the dither TRANSFORMS the element, using the Shader Studio ASCII effect

Spec: the **Addendum** in `docs/superpowers/specs/2026-09-20-dither-transition-design.md` (read it first — it is the requirements). Part 1 (Tasks 1–5) is built and committed. Same Global Constraints (`.superpowers/sdd/dither-constraints.md`), plus:

- Stored `style` is `'pixels' | 'dissolve' | 'wipe' | 'dots'`, default `'pixels'`. Stored `cell` default depends on the style: 24 for `pixels`, 8 for the others (range 1–40). New stored param `chars`: the ASCII effect's `u_shape` value, default `1` (Blocks); allowed = every option value in `shader_effects/manifest.json` for `ascii_dither.u_shape` EXCEPT `14` (Custom).
- Pixels constants (exact): finest block `PIXEL_END = 0.002` of the frame's width; brightness runs `−1 → +1` linearly over the whole bar; the sharp layer fades in with `smoothstep(0.8, 1, amount)`; jitter `0.25`; shader speed = `drift / 6`.
- The ASCII shader's RGB output with matte mode OFF must be byte-identical to today (the golden-parity suite diffs RGB at defaults). Do NOT regenerate goldens. Do NOT add a manifest param.
- ONLY Task 8 touches `frontend/app/composables/useCompositorLayers.ts`, with exactly the hunks it names. ONLY Task 6 touches `shader_effects/`, `frontend/app/lib/shaderfill/field.ts` and `frontend/app/lib/shaderfx/renderer.ts`.
- The three mask styles must draw exactly as they do now.

### Task 6: The shader runtime — glyph sheets on the field path, and matte mode

**Files:**
- Modify: `frontend/app/lib/shaderfill/field.ts`, `frontend/app/lib/shaderfx/renderer.ts`, `shader_effects/ascii_dither.frag`, `frontend/tests/unit/shader-manifest-uniforms.unit.spec.ts` (allowlist only)
- Test: create `frontend/tests/unit/shaderfill-field-textures.unit.spec.ts`; add a matte-mode source-level spec `frontend/tests/unit/ascii-dither-matte.unit.spec.ts`

**Interfaces — Produces:**
- `fieldEffectReady(effectId: string): boolean` from `~/lib/shaderfill/field` — `true` when the effect is in the loaded catalogue AND every texture it declares has finished loading (an effect with no textures is ready as soon as the catalogue is). When `false` it KICKS whatever is missing (the existing catalogue retry; an image load per missing texture, once) and, when a texture lands, notifies the SAME subscribers `onFieldCatalogReady` serves — hosts with no frame loop repaint on that signal today.
- `renderFieldWithBase(spec, base, w, h, shape?, t?, extraUniforms?: Record<string, number>)` — the new last argument is merged into every pass's uniforms AFTER the effect's own (like `shape.uniforms`).
- Matte mode: a `uniform float u_matte` in `ascii_dither.frag`.

**Requirements:**

1. **Textures on the field path.** `buildPasses` passes `undefined` for textures today (`field.ts` ~line 523), and a texture's `extraUniforms` (`u_glyphCount`, `u_glyphRows` for `glyph_atlas.png`) are never emitted, so ASCII shapes 7–14 sample garbage and draw nothing on every `field.ts` path. Fix: a module-level cache of `HTMLImageElement` per `file + v` (STABLE objects — the renderer's texture cache is keyed by identity, see `renderer.ts` ~156–160; `crossOrigin = 'anonymous'`; URL via `assetUrl(t.file, t.v)` from `~/lib/shaderfx/catalog`, exactly as `frontend/app/lib/texturefx/stylize.ts` `loadEffectTextures` does). `buildPasses` binds every texture that is loaded (`img.complete && img.naturalWidth > 0`) under its `uniform`, and merges that texture's `extraUniforms` — ONLY for loaded textures. An effect whose textures are not loaded renders as it does today. No `Image` in a non-DOM environment: guard with `typeof Image === 'undefined'` → treat as "no textures available", never throw.
2. **`fieldEffectReady`** as specified above. It must be cheap to call every frame (no allocation when ready).
3. **`extraUniforms`** on `renderFieldWithBase`, as specified.
4. **The renderer resets mode switches.** The renderer is a shared singleton whose per-program uniforms PERSIST across draws (read the `u_hasShape` comment in `buildPasses`). A switch set by one caller must never leak into another path (Shader Studio composes its own passes and never goes through `buildPasses`). In `renderer.ts`, where each pass's uniforms are uploaded, first write every entry of a new module constant `BUILTIN_PASS_DEFAULTS: Record<string, number> = { u_matte: 0 }` (skip silently when the program has no such uniform), THEN the pass's own dict. Document why on the constant.
5. **Matte mode in `ascii_dither.frag`.** Declare `uniform float u_matte;` with a comment: set by the Frame compositor's dither transition, never a Studio dial, reset to 0 by the renderer before every draw. In `main()`:
   - sample the cell ONCE as `vec4 src = texture(u_image0, clamp(cuv, 0.0, 1.0)); vec3 col = src.rgb;` (the RGB read must be the same expression as today).
   - `bool matte = u_matte > 0.5;`
   - density: today `float g = clamp(lum + jitter + u_brightness, 0.0, 1.0);` — in matte mode `g *= src.a;` immediately after that line and BEFORE the `u_invert` flip (so nothing appears where the element is transparent).
   - ink: in matte mode the ink is the element's TRUE colour `col` (not `col / lum`), regardless of `u_colored`.
   - output: when `matte`, write STRAIGHT alpha and return before the underlay block: shapes `< 15`: `fragColor0 = vec4(clamp(col, 0.0, 1.0), clamp(glyph, 0.0, 1.0));` — shapes `>= 15` (finished RGB tiles): `fragColor0 = vec4(clamp(fx, 0.0, 1.0), src.a * step(0.001, g));`. This needs `glyph` in scope at the output: hoist `float glyph = 0.0;` above the `if (shp >= 15)` branch.
   - With `u_matte == 0` every RGB value written must be exactly what it is today. Re-read your diff for any expression whose evaluation order changed.
6. **Allowlist.** `shader-manifest-uniforms.unit.spec.ts` fails any frag uniform not reachable from the manifest; add `'u_matte'` to its `BUILTIN` set with a one-line comment in the style of the `u_customGlyphs` entry. Change nothing else in that spec.

**Tests** (look at the existing `frontend/tests/unit/shaderfill-*.unit.spec.ts` for how `field.ts` is exercised without GL — follow that; a fake `Image` on `globalThis` installed in `beforeAll` and removed in `afterAll` is the expected shape):
- `buildPasses` behaviour through `renderFieldWithBase` with a stubbed `shaderFx.render` that captures the passes: before the image loads → pass has no `u_glyphs` texture and no `u_glyphCount`; after the fake image "loads" → `textures.u_glyphs` is THE SAME object on two consecutive calls, and `u_glyphCount` / `u_glyphRows` carry the manifest's numbers.
- `fieldEffectReady`: false before the catalogue; false with catalogue but unloaded texture AND exactly one image load started across many calls; true after load; the ready-subscribers fire once when the texture lands; true immediately for an effect with no textures; no throw when `Image` is undefined.
- `extraUniforms` reach every pass and override a same-named effect uniform; omitted → passes identical to today.
- `renderer.ts`: `BUILTIN_PASS_DEFAULTS` is exported and contains `u_matte: 0`; if the file has a unit-testable seam for the upload order use it, otherwise pin it source-level (the defaults loop appears before the pass-dict loop inside `render`).
- `ascii-dither-matte.unit.spec.ts` (read the frag as text): declares `uniform float u_matte`; `g *= src.a` sits between the `clamp(lum + jitter + u_brightness` line and the `u_invert` line; both matte outputs are present; the last statement of `main` is still `fragColor0 = vec4(clamp(outc, 0.0, 1.0), 1.0);`; the string `col / max(lum, 1e-3)` still occurs (classic ink unchanged).
- Run `npm run test:unit -- shader` and `npm run test:unit -- shaderfill` — all green. (The browser golden-parity suite is Playwright: do NOT run it; the controller checks RGB identity live.)

Commit subject: `fix(shaderfx): effects' textures load on the Frame's shader path (ASCII glyph shapes drew nothing); the ASCII shader gains a default-off matte mode`

---

### Task 7: Pixels params and maths; Pixels is the default

**Files:**
- Modify: `frontend/app/lib/motionx/reveal/params.ts`, `frontend/app/lib/motionx/reveal/index.ts`
- Create: `frontend/app/lib/motionx/reveal/pixels.ts`
- Test: create `frontend/tests/unit/motionx/reveal-pixels.unit.spec.ts`; update the DEFAULT assertions in `frontend/tests/unit/motionx/reveal-dither.unit.spec.ts`

**Interfaces — Produces:** `RevealStyle` includes `'pixels'`; `REVEAL_STYLES = ['pixels', 'dissolve', 'wipe', 'dots']`; `REVEAL_DEFAULTS.style === 'pixels'`; `revealCellDefault(style): number` (24 | 8, stored units); `RevealParams.chars: number`; `PIXEL_CHARS: readonly { value: number; label: string }[]`; `PIXEL_END`, `pixelStages(cell)`, `pixelBlock(amount, cell)`, `pixelBrightness(amount)`, `pixelSharp(amount)`, `PIXEL_JITTER = 0.25`, `pixelShaderParams(r: MotionReveal, frameW: number, frameH: number): Record<string, number>`.

**Requirements:**
- `params.ts`: as in the interfaces. `revealParams` reads `cell` as `num(p.cell, revealCellDefault(style), REVEAL_RANGES.cell) / 1000` and `chars` as: a finite number whose rounded value is one of `PIXEL_CHARS`' values, else `1`. Doc comment on `REVEAL_STYLES`: `pixels` TRANSFORMS the element; the other three MASK it.
- `PIXEL_CHARS` (exact, in this order — it is the ASCII effect's `u_shape` option list minus Custom): `0 Mixed, 1 Blocks, 2 Circles, 3 Lines, 4 Diagonal, 5 Cross, 6 Diamond, 7 Hash, 8 Matrix, 9 Binary, 10 Braille, 11 Morse, 12 Dots, 13 Slashes, 15 Lego, 16 Cross-stitch, 17 Voxel, 18 Beads, 19 Gems`. A test imports `shader_effects/manifest.json` (other unit specs do — copy their import) and asserts `PIXEL_CHARS` equals the manifest's `ascii_dither` → `u_shape` options with value 14 removed (labels and values), so the two can never drift.
- `pixels.ts`:
  ```ts
  export const PIXEL_END = 0.002
  export const PIXEL_JITTER = 0.25
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
  /** How many times the dial's block halves before it reaches the finest block. */
  export function pixelStages(cell: number): number {
    return cell > PIXEL_END ? Math.max(0, Math.ceil(Math.log2(cell / PIXEL_END) - 1e-9)) : 0
  }
  /** The block at `amount` (fraction of the frame's width): the dial's size halved once per
   *  stage, the stages spread evenly over the bar, so each refinement subdivides the last. */
  export function pixelBlock(amount: number, cell: number): number {
    const stages = pixelStages(cell)
    return cell / 2 ** Math.min(stages, Math.floor(clamp01(amount) * (stages + 1)))
  }
  /** The shader's Brightness across the bar: −1 (nothing drawn) → +1 (every covered cell full).
   *  Bright tones cross zero first, so they arrive first. */
  export function pixelBrightness(amount: number): number { return clamp01(amount) * 2 - 1 }
  /** How much of the real, sharp layer is laid over the characters: most sets never become a
   *  solid picture, so the last fifth of the bar cross-fades to the layer itself. */
  export function pixelSharp(amount: number): number {
    const x = clamp01((clamp01(amount) - 0.8) / 0.2)
    return x * x * (3 - 2 * x)
  }
  ```
  and `pixelShaderParams(r, frameW, frameH)` → the ASCII effect's params keyed WITHOUT the `u_` prefix (the `ShaderSpec.params` convention): `{ shape: r.chars, cell: pixelBlock(r.amount, r.cell) * frameW / frameH, brightness: pixelBrightness(r.amount), jitter: PIXEL_JITTER, speed: r.drift / 6, colored: 1, underlay: 0, spacing: 0, invert: 0, blur: 0 }`. (`cell` is a fraction of the frame's HEIGHT in the shader — hence `× frameW / frameH`; guard `frameH <= 0` → use 1.) Clamp `cell` into the manifest's range `[0.004, 0.1]`.
- Tests: the defaults (Pixels first/default; per-style cell default; explicit cell wins; unknown style → pixels; `chars` default 1, `chars: 14` and `chars: 99` and `chars: NaN` → 1, `chars: '8'` → 1 (numbers only), `chars: 8.2` → 8); stages for 0.024 are `[24, 12, 6, 3, 1.5]` ‰ with boundaries at multiples of 0.2; one stage when the dial is already ≤ `PIXEL_END`; bad amounts clamp; brightness −1/0/+1 at 0/0.5/1; `pixelSharp` is 0 up to 0.8, 0.5 at 0.9, 1 at 1, monotonic; `pixelShaderParams` values for a 16:9 frame incl. the `× W/H` and the `[0.004, 0.1]` clamp and `speed 0` at drift 0; the manifest parity test.
- In `reveal-dither.unit.spec.ts`: the `revealParams` "defaults" assertion becomes `{ style: 'pixels', out: false, cell: 0.024, drift: 6, angle: 0, softness: 0.35, chars: 1 }`; the "converts stored units" / "bad values" cases gain whatever `chars` key the new shape requires (`toEqual` on whole objects); and that file's `R()` helper pins the mask style it was written for: `revealParams({ style: 'dissolve' })`. Nothing else changes there. If a case in `reveal-fold.unit.spec.ts` or `reveal-paint.unit.spec.ts` fails ONLY because it relied on the old default style, give it an explicit `style` and say so in the report.

Commit subject: `feat(motionx): the Pixels style's dials and maths — character sets, blocks that halve, brightness that condenses; Pixels is the default`

---

### Task 8: Drawing the Pixels style

**Files:**
- Create: `frontend/app/lib/motionx/reveal/paintPixels.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (two hunks in `paintLayerStack`'s per-item loop + one import line)
- Test: create `frontend/tests/unit/motionx/reveal-paint-pixels.unit.spec.ts`

**Interfaces:**
- Consumes: `fieldEffectReady`, `renderFieldWithBase` (Task 6); `pixelShaderParams`, `pixelSharp`, `MotionReveal` (Task 7).
- Produces, from `~/lib/motionx/reveal/paintPixels` (NOT via the barrel): `revealPixelsReady(): boolean` (= `fieldEffectReady('ascii_dither')`), `drawRevealPixels(ctx, reveal, W, H, base: DOMMatrix, drawLayer: (target: CanvasRenderingContext2D) => void, stamp: { alpha: number; blend: GlobalCompositeOperation }): boolean`, `setRevealPixelsDeps(deps)` (tests only: canvas factory + `render` function).

**The recipe, exactly:**
1. The frame transform must be scale + translate: if `|base.b| > 1e-6` or `|base.c| > 1e-6` → return `false`. `fw = Math.round(W × base.a)`, `fh = Math.round(H × base.d)`; if either `< 2` or `fw × fh > 16_000_000` → return `false`.
2. `solo` = a pooled `fw × fh` canvas: identity transform, `clearRect`, then `setTransform(new DOMMatrix().translate(-base.e, -base.f).multiply(ctx.getTransform()))` — the CURRENT transform (which includes any draw-time scale) moved so the frame's top-left is the canvas origin — and `drawLayer(soloCtx)` inside `try/finally` (a throw still releases the canvas, then propagates).
3. `result = renderFieldWithBase({ effectId: 'ascii_dither', params: pixelShaderParams(reveal, W, H), speed: 1, seed: 42 }, solo, fw, fh, undefined, elapsedSeconds, { u_matte: 1 })` with `elapsedSeconds` finite and ≥ 0. It THROWS when the catalogue is cold → catch → release → return `false`. Its canvas is only valid until the next render: copy it at once into a second pooled `fw × fh` canvas `out` (`globalCompositeOperation = 'copy'`, identity, `drawImage(result, 0, 0)`).
4. Sharp hand-off: `s = pixelSharp(reveal.amount)`; when `s > 0`, draw `solo` over `out` with `globalAlpha = s`, `source-over`.
5. Stamp: `ctx.save()`; `filter = 'none'`, `shadowColor = 'transparent'`; identity transform; `globalAlpha = clamp01(stamp.alpha)`; `globalCompositeOperation = stamp.blend`; `drawImage(out, base.e, base.f)`; `ctx.restore()`.
6. Release both canvases (stack pools, as in `paint.ts`). Return `true`. Returning `false` must leave `ctx` UNTOUCHED.

**Tests** (recorder fake as in `reveal-paint.unit.spec.ts`; inject the canvas factory and a fake `render` that records its arguments and returns a marker canvas): every numbered step above as real `expect`s — the moved transform (base scale 2, translate (10, 20), current transform = base × a draw-time scale); the spec passed to `render` (`effectId`, `params` deep-equal to `pixelShaderParams(reveal, W, H)`, `speed: 1`), `fw`/`fh`, `t`, and `{ u_matte: 1 }`; the immediate copy with `'copy'`; no sharp draw at amount 0.5 and a sharp draw with `globalAlpha === pixelSharp(0.9)` at amount 0.9; the stamp's alpha, blend and position `(base.e, base.f)` inside save/restore; `false` + untouched `ctx` for a rotated base, a tiny frame, a throwing `render`; a throwing `drawLayer` propagates and the canvas is reused next call; NaN elapsed → `t === 0`.

**The two hunks in `paintLayerStack`:**

Hunk A — the existing reveal block becomes:
```ts
      const rv = (layer as unknown as { motionReveal?: MotionReveal }).motionReveal
      // Pixels TRANSFORMS the layer (drawn further down, once its mask is known); the other
      // styles MASK it: keep the backdrop so the hidden cells can be put back afterwards.
      // While the shader is still loading, a Pixels bar draws as the Dissolve mask rather
      // than flashing the whole layer.
      let pixelsBase: DOMMatrix | null = null
      if (rv) {
        if (!(rv.amount > 0)) continue
        if (rv.style === 'pixels' && revealPixelsReady()) pixelsBase = ctx.getTransform()
        else revealOpen = beginReveal(ctx, rv.style === 'pixels' ? { ...rv, style: 'dissolve' } : rv, W, H)
      }
```
(`pixelsBase` is captured HERE, before the draw-time scale below it is applied — the grid belongs to the frame.)

Hunk B — immediately after the existing line `const maskItem = ref ? byKey.get(ref) ?? null : null` that follows the draw-time-scale block, and BEFORE `const motionActive`:
```ts
      // Pixels: the layer is drawn ALONE at full opacity, run through the ASCII shader, and
      // stamped with its own opacity and blend. Effects that read the backdrop and the
      // pre-timeline animation engine sit out the transition (spec addendum). If it cannot
      // run after all, fall back to the Dissolve mask for this frame.
      if (rv && pixelsBase) {
        const solo = { ...layer, opacity: 1, blend: 'normal' } as LocalLayer
        const drawSolo = (target: CanvasRenderingContext2D) => {
          if (maskItem && maskItem.type !== 'local') drawItemMasked(target, { ...item, layer: solo }, maskItem, W, H, 'source-over', 1)
          else drawLocalLayer(target, solo, W, H, maskItem?.type === 'local' ? maskItem.layer : null, 1)
        }
        if (drawRevealPixels(ctx, rv, W, H, pixelsBase, drawSolo, { alpha: (layer.opacity ?? 1) * opacityMul, blend: localBlendOp(layer) })) continue
        revealOpen = beginReveal(ctx, { ...rv, style: 'dissolve' }, W, H)
      }
```
Note on that last line: at this point the draw-time scale may already be on `ctx`, so `beginReveal`'s own `getTransform()` would capture it. Give `beginReveal` an optional 5th argument `base?: DOMMatrix` (used instead of `ctx.getTransform()` when given) in `paint.ts`, pass `pixelsBase` here, and add one test for it in `reveal-paint.unit.spec.ts`. Check how `item` is typed so `{ ...item, layer: solo }` typechecks; adjust the cast, not the logic. Nothing else in the file changes.

Extend the source-level wiring guard (in the new spec): `drawRevealPixels(` appears exactly once and BEFORE `const motionActive`; `pixelsBase = ctx.getTransform()` appears before the first `motionScale` read in `paintLayerStack`; `revealPixelsReady()` appears in Hunk A. Run `npm run test:unit -- motionx` and `npm run test:unit -- compositor` (counts unchanged; a suite that times out under load is re-run alone before it is called broken). `git diff -- frontend/app/composables/useCompositorLayers.ts` shows exactly hunks A, B and the import.

Commit subject: `feat(compositor): the Pixels dither runs the layer through the ASCII shader, cells halving until it is sharp`

---

### Task 9: Pixels in the inspector and the gallery tile

**Files:** Modify `frontend/app/components/vue-canvas/compositor/MotionInspector.vue`, `frontend/app/components/vue-canvas/compositor/MotionDitherPreview.vue`; add cases to `frontend/tests/unit/motionx/letters-ui.unit.spec.ts`.

- Inspector, dither block: `const ditherStyle = computed(() => revealParams(behaviour.value?.params).style)` replaces every `enumParam('style', …)` read in the block (one reader of the default: the library's). Style is a labelled `StudioSelect` (`data-testid="dither-style"`, options `REVEAL_STYLES`, labels `Pixels, Dissolve, Wipe, Dots`) — four segments do not fit a 228px row beside the label. When `ditherStyle === 'pixels'`: a labelled `StudioSelect` `data-testid="dither-chars"`, label `Characters`, hint `The same character sets as the ASCII effect in Shader Studio`, options = `PIXEL_CHARS` values as STRINGS with `PIXEL_CHARS` labels, `:model-value="String(revealParams(behaviour.params).chars)"`, writing `setBehParams({ chars: Number(v) })`. Cell slider: label `Block size` (Pixels) / `Dot spacing` (Dots) / `Cell size`; Pixels hint `How big the cells are when the transition starts, in thousandths of the frame's width. They halve until the layer is sharp.`; value and `:default` from `revealCellDefault(ditherStyle)`. Drift slider: for Pixels label `Shimmer speed`, hint `How fast the characters re-roll while the layer sharpens. 0 is still.` Angle: hidden for Pixels (`v-if`). Edge softness: Wipe only (unchanged). Test ids otherwise unchanged.
- Preview tile: show the default look. Build ONCE a 48×30 RGBA source (a rounded card, diagonal gradient `#7c9cff → #ff7ac3`, a white bar; transparent outside). Each frame: `n = [8, 4, 2, 1][min(3, floor(amount × 4))]` source pixels per block; for each block sample the source at its centre; the block is ON when `alpha/255 × clamp01(luma + (amount × 2 − 1)) > bayer8(bx − drift, by)` (import `bayer8`; `drift = floor(elapsed × 5)`), painted as an `n × n` square of the sampled colour; from `amount ≥ 0.8` blend towards the source pixel by `pixelSharp(amount)`. Same loop lifetime, reduced-motion still frame (amount 0.45), `aria-hidden`, one reused `ImageData`. It is a PREVIEW of the idea, not the shader — say so in the component's header comment.
- Source-level tests: the Style select's four options in order; `dither-chars` exists under a `v-if` that mentions `pixels` and binds `PIXEL_CHARS`; `Block size` and `Shimmer speed` present; the Angle row's `v-if` excludes pixels; `revealCellDefault(` used for the cell slider's default; no raw `<input` / `<select` in the dither block.

Commit subject: `feat(compositor): Pixels is the Dither bar's first Style, with the ASCII effect's character sets`

---

### Task 10: Live verification and Part-2 review (controller)

- [ ] PROVE the shader path ran (a fallback would hide a failure): a Matrix/Binary bar mid-transition shows glyph-shaped ink (many distinct partial shapes per cell), not Dissolve's on/off squares; and a counter or console probe shows `renderFieldWithBase` called with `u_matte: 1`.
- [ ] White text AND black text both appear during the bar (black later than white); nothing at amount 0; the exact normal draw after the bar; no pop at the hand-off (frame at amount 0.999 ≈ frame after the bar).
- [ ] Cell size halves as the bar advances (measure on a scan line at three times); cells are frame-anchored squares with the layer rotated 30°; blend `multiply` and 50% opacity behave (even, not a 50% dither).
- [ ] Shimmer: drift > 0 changes the characters over time; drift 0 is still.
- [ ] Shader Studio's ASCII effect looks unchanged with matte off (open it, compare a default render before/after by pixel census — RGB identical), and its glyph shapes now ALSO render as a Frame layer effect.
- [ ] The three mask styles still pass the Part-1 checks (spot-check Dissolve coverage).
- [ ] Inspector: Style select, Characters select, Block size default 24 on a new bar, Dissolve shows Cell size 8, Angle hidden for Pixels.
- [ ] Review of Part 2 on the most capable model; one fix wave; ledger, spec status, memory.

---

# Part 3 — the Assemble style: constant blocks, wiped in and out by two scattered fronts

Spec: **Addendum 2** in `docs/superpowers/specs/2026-09-20-dither-transition-design.md` (read it first — it is the requirements, including the exact front maths). Parts 1–2 are built and committed. Same Global Constraints (`.superpowers/sdd/dither-constraints.md`), plus:

- Stored `style` gains `'assemble'`; `REVEAL_STYLES = ['pixels', 'assemble', 'dissolve', 'wipe', 'dots']`; default stays `'pixels'`. New stored params (all read ONLY through `revealParams`): `look: 'dither' | 'chars'` (default `'dither'`), `pattern` = the Dither effect's `u_pattern` value (default `2`, Fine 8×8; allowed = every option value of `bayer_dither.u_pattern` in `shader_effects/manifest.json`), `levels` 2–8 integer (default 3), `band` 0–100 (default 30), `scatter` 0–100 (default 35). `cell` default for `assemble` is 16. `chars` as in Part 2.
- Only Task 12 touches `frontend/app/composables/useCompositorLayers.ts`, and only to GENERALISE the two existing Pixels hunks (no third hunk). Nobody touches `shader_effects/`, `field.ts` or `renderer.ts`.
- Pixels and the three mask styles must draw exactly as they do now.

### Task 11: Assemble params and maths

**Files:** modify `frontend/app/lib/motionx/reveal/params.ts`, `index.ts`; create `frontend/app/lib/motionx/reveal/assemble.ts`; tests: create `frontend/tests/unit/motionx/reveal-assemble.unit.spec.ts`, update default/shape assertions in the existing reveal specs only where the new `RevealParams` keys require it.

**Produces:** `RevealParams` gains `look`, `pattern`, `levels`, `band` (0–1 maths units = stored ÷ 100), `scatter` (0–1); `revealCellDefault('assemble') === 16`; `DITHER_PATTERNS: readonly { value: number; label: string }[]` (pinned by a test to the manifest's `bayer_dither.u_pattern` options, labels and values); `motionUsesShaderStyle(behaviours)` — true when any dither bar resolves to `pixels` OR `assemble` (keep `motionUsesPixels` exported as an alias so existing callers compile); and in `assemble.ts`:
- `assembleSoft(r): number` = `Math.max(0.001, r.scatter * 0.6)`
- `assembleCell(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): 0 | 1 | 2` — 0 nothing, 1 look, 2 sharp — exactly the spec's maths: `s` = the wipe's position along the travel (reuse the SAME projection Part 1's wipe uses — export a small `alongTravel(angle, out, cx, cy, grid)` from `dither.ts` and make `cellTest` use it, behaviour unchanged, its tests untouched), `lead = amount × (1 + band + 2·soft)`, first front `lp = (lead − s)/soft`, second front `tp = (lead − soft − band − s)/soft`, reached when `≥ 1` or (`> 0` and `> threshold`); first-front threshold `bayer8(cx − dx, cy − dy)` with `driftCells(r)`, second-front threshold `bayer8(cx + 3 − dx, cy + 5 − dy)`. Sharp wins over look. `amount ≤ 0` → 0 everywhere; `amount ≥ 1` → 2 everywhere; non-finite amount → 0.
- `assembleTest(r, grid): (cx, cy) => 0 | 1 | 2` — the per-frame form with everything cell-independent hoisted (as `cellTest` does); `assembleCell` is its one-off form.
- `buildAssembleMasks(r, grid, covered?: Uint8Array): { look: Uint8ClampedArray<ArrayBuffer>; sharp: Uint8ClampedArray<ArrayBuffer> }` — two RGBA bitmaps of `grid.cols × grid.rows`, alpha 255 where that cell shows the look / the sharp layer, row 0 = TOP row. `covered[j * cols + i] === 0` (optional) removes a cell from the LOOK mask only (the Dither look paints opaque colour everywhere; a cell the layer does not cover must stay empty).
- `assembleShaderParams(r, frameW, frameH): { effectId: 'bayer_dither' | 'ascii_dither'; params: Record<string, number>; matte: boolean }` — Dither look: `{ pattern, scale: clamp(r.cell × frameW / frameH, 0.003, 0.05), levels, colored: 1 }`, `matte: false`; Characters look: the ASCII params of Part 2's `pixelShaderParams` but with `cell` = the CONSTANT block (`clamp(r.cell × W / H, 0.004, 0.1)`), `brightness: 1`, `matte: true`.
- `assembleGrid(r, frameW, frameH, fw, fh): { cols, rows, cellW, cellH }` in DEVICE pixels of the side canvas, mirroring each shader's own arithmetic so masks land on its cells: Dither look `cellH = cellW = Math.max(scale × fh, 1)`; Characters look `cellH = Math.max(cell × fh, 2)`, `cellW = cellH × (2/3 when 7 ≤ chars ≤ 14, else 1)`; `cols = ceil(fw / cellW)`, `rows = ceil(fh / cellH)`.

**Tests (real `expect`s):** defaults and clamps of the five new params (strings, NaN, out of range, `pattern: 99` → 2, `levels: 3.6` → 4); `REVEAL_STYLES` order; `DITHER_PATTERNS` manifest parity; `alongTravel` extraction leaves every existing wipe test green; `assembleCell`: nothing at 0, all sharp at 1, never look AND sharp, monotonic per cell with drift 0 (0 → 1 → 2, never backwards) for In and for Out, at angles 0/90/180/270; with `scatter: 0` both fronts are hard lines `band` apart (a column is entirely one state at angle 0); with `band: 0` no cell is ever in state 1 when `scatter` is 0; Out flips the travel (start side empties first); drift changes WHICH cells are scattered but not the fully-behind / fully-ahead regions; `assembleTest` ≡ `assembleCell` over a grid incl. negative indices; masks: sizes, alpha only 0/255, look ∩ sharp = ∅, `covered` removes look cells only; `assembleShaderParams` both looks incl. clamps on a portrait frame; `assembleGrid` both looks incl. the 2:3 case and the 1px / 2px floors.

Commit subject: `feat(motionx): the Assemble style's dials and maths — two scattered fronts over constant cells, looks from the Dither and ASCII effects`

---

### Task 12 — amendment (2026-09-20, after Julien: "I LOVE the colour shimmer")
The Dither look's colours must SHIMMER. `shader_effects/bayer_dither.frag` now has a SHIMMER build (commit 381ea1392): with `variant = 'SHIMMER'` it reads two extra uniforms, `u_shimmerX` / `u_shimmerY` — a whole-cell offset of the THRESHOLD pattern (the sampled picture does not move). For the Dither look, step 3 of the recipe below therefore calls `renderFieldWithBase(..., elapsed, { u_shimmerX: -dx, u_shimmerY: dy }, 'SHIMMER')` where `{ dx, dy } = driftCells(reveal)` (the SAME drift that moves the scatter order; the shader's rows count from the BOTTOM, hence `+dy`; `-dx` so the pattern travels the way the maths' `bayer8(cx − dx, …)` does). Add `assembleShaderExtras(r): { variant: 'SHIMMER' | 'MATTE'; uniforms: Record<string, number> }` to `assemble.ts` (Task 11's file — a small, tested addition: Dither look → the shimmer pair, `-0` normalised to `0`; Characters look → `{ u_matte: 1 }`, `'MATTE'`) and use it in step 3 instead of the `sp.matte ? … : undefined` pair. With Shimmer speed 0 both offsets are 0 and the picture is still. Test: drift 6 at elapsed 0.5s and angle 0 → `{ u_shimmerX: -3, u_shimmerY: 0 }`.

### Task 12: Drawing Assemble

**Files:** create `frontend/app/lib/motionx/reveal/paintAssemble.ts`; modify `frontend/app/lib/motionx/reveal/paintPixels.ts` (export its shared pieces, add the dispatcher), `frontend/app/composables/useCompositorLayers.ts` (generalise the two Pixels hunks), `frontend/app/lib/motion/bake.ts` + the pre-warm watch in `CompositorModal.vue` only if they name Pixels-specific helpers that must now cover Assemble; tests: `frontend/tests/unit/motionx/reveal-paint-assemble.unit.spec.ts`, additions to `reveal-paint-pixels.unit.spec.ts`.

**Recipe** (`drawRevealAssemble(ctx, reveal, W, H, base, drawLayer, stamp): boolean`, same contract as `drawRevealPixels`: `false` leaves `ctx` untouched; pools are stacks; `try/finally` releases everything):
1. Gate and side canvas EXACTLY as `drawRevealPixels` steps 1–2 (share the code: extract `soloPass(ctx, W, H, base, drawLayer)` → `{ solo, fw, fh } | null` inside `paintPixels.ts`; Pixels keeps passing its existing tests unchanged).
2. `sp = assembleShaderParams(reveal, W, H)`; `grid = assembleGrid(reveal, W, H, fw, fh)`.
3. Look picture: `renderFieldWithBase({ effectId: sp.effectId, params: sp.params, speed: 1, seed: 42 }, solo, fw, fh, undefined, elapsed, sp.matte ? { u_matte: 1 } : undefined, sp.matte ? 'MATTE' : undefined)`; copy at once into a pooled `fw × fh` canvas `look` (`'copy'`). Throw → release → `false`.
4. Coverage (Dither look only): draw `solo` into a pooled `cols × rows` canvas created with `{ willReadFrequently: true }`, mapping the shader's grid (anchored BOTTOM-left): source rect `(0, fh − rows × cellH, cols × cellW, rows × cellH)` → dest `(0, 0, cols, rows)`, smoothing on; `getImageData`; `covered[k] = alpha > 127 ? 1 : 0`.
5. `masks = buildAssembleMasks(reveal, grid, covered)`; put each into a pooled `cols × rows` canvas; with `imageSmoothingEnabled = false` and `'destination-in'`, draw the look mask over `look` and the sharp mask over a pooled copy of `solo`, both to dest rect `(0, fh − rows × cellH, cols × cellW, rows × cellH)`.
6. Compose `look` then the masked sharp copy (`source-over`) into `out`, stamp as Pixels step 5 (`drawImage(out, base.e, base.f)`, layer opacity × group, blend).

**Dispatcher + wiring:** in `paintPixels.ts` export `revealShaderReady(reveal): boolean` (`pixels` → ASCII ready; `assemble` → `fieldEffectReady` of `assembleShaderParams(...).effectId`) and `drawRevealShaderStyle(ctx, reveal, …)` (→ `drawRevealPixels` | `drawRevealAssemble`), plus `ensureRevealShadersReady(behaviours, timeoutMs?)` awaiting every effect the bars need. In `useCompositorLayers.ts` the two existing hunks change ONLY: `rv.style === 'pixels'` → `isShaderRevealStyle(rv.style)` (`'pixels' | 'assemble'`, exported from the barrel), `revealPixelsReady()` → `revealShaderReady(rv)`, `drawRevealPixels(` → `drawRevealShaderStyle(`; the Dissolve fallbacks stay. Update the existing source-level wiring guards to the new names without loosening what they pin. `bake.ts` and the modal's pre-warm call the generalised `motionUsesShaderStyle` / `ensureRevealShadersReady` (the pre-warm must kick the RIGHT effect for each bar).

**Tests:** recorder-fake specs for every numbered step (incl. the bottom-left anchored rects for a `fh` that is not a multiple of `cellH`, the `covered` array fed to `buildAssembleMasks`, matte/variant args for the Characters look and their absence for the Dither look, the immediate copy, `false` + untouched `ctx` on a throwing render, release on a throwing `drawLayer`); dispatcher routing; readiness per look. `npm run test:unit -- motionx`, `-- compositor`, `-- bake` green with compositor's count unchanged.

Commit subject: `feat(compositor): Assemble draws the layer as constant blocks wiped in and out by two scattered fronts`

---

### Task 13: Assemble in the inspector and gallery

**Files:** `MotionInspector.vue`, `MotionDitherPreview.vue`, `frontend/app/lib/motionx/gallery.ts` (+ its spec), `letters-ui.unit.spec.ts`.

- Style select: five options, labels `Pixels, Assemble, Dissolve, Wipe, Dots`. For `assemble`: `StudioSegmentedRow` `dither-look` (label `Look`, `Dither` / `Characters`); Dither look → labelled `StudioSelect` `dither-pattern` (label `Pattern`, `DITHER_PATTERNS`, hint `The same patterns as the Dither effect in Shader Studio`) + `StudioSlider` `dither-levels` (label `Colour levels`, 2–8 step 1 default 3, hint `How few colours each block can take. 2 is harsh, 8 is nearly smooth.`); Characters look → the existing `dither-chars` select. `Block size` (default 16, min 2, hint `How big the cells are. They stay this size for the whole transition.`), `dither-band` (label `Band width`, 0–100 step 1 default 30, hint `How much of the layer is in block form at once. At 100 the whole layer is blocks before it turns sharp.`), `dither-scatter` (label `Scatter`, 0–100 step 1 default 35, hint `How far ahead of the edge cells start appearing. 0 is a hard line.`), Angle shown, Drift row labelled `Shimmer speed` (hint `How fast the scattered order re-rolls. 0 is still.`), Edge softness hidden. Every slider keeps the `gesture(key)` / `setBehNum(key, …)` pairing; all values read through one `revealParams` computed.
- Gallery: add `assemble-in` (group In) and `assemble-out` (group Out), labels `Assemble in` / `Assemble out`, kind `dither`, params `{ dir, style: 'assemble' }`, preview `'assemble'`; `MotionDitherPreview` gains a `mode: 'pixels' | 'assemble'` prop and, for assemble, draws the approved preview's look with the LIBRARY's `assembleTest` (blocks 4px on the 48×30 tile, colours quantised to 3 levels against `bayer8`). `behaviourLabel` for a dither bar with `style: 'assemble'` reads `Assemble in` / `Assemble out` (add to `bands.ts` + its spec — name it in your report before editing).
- Source-level + gallery tests for all of the above.

Commit subject: `feat(compositor): Assemble in / Assemble out, with Looks from the Dither and ASCII effects`

---

### Task 14: Live verification and Part-3 review (controller)

- [ ] Shader path proven (not the fallback): Dither look shows ≥ 3 distinct block colours inside a gradient layer mid-bar; Characters look shows glyph ink.
- [ ] Cells are ONE size at three times in the bar; nothing at amount 0; exact normal draw after; Out continues the same way.
- [ ] Scatter 0 → two straight fronts `Band width` apart; Scatter > 0 → cells ahead of the front, none behind the second front in block form.
- [ ] A contact sheet from the real canvas for Julien.
- [ ] Pixels and Dissolve spot-checks unchanged; whole-slice review on the most capable model; one fix wave; ledger, memory.
