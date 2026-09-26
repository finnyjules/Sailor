# The Frame's layout grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Frame editor's grid with one standard, Swiss-style layout grid. The grid is shown quietly, snaps, can be undone, and the Layout tab builds on it.

**Architecture:**
- A new pure module, `lib/frame/layoutGrid.ts`, owns the grid: what's stored, the suggested grid per format, resolving it to pixel tracks and snap lines, migration, and patching.
- The editor composable (`useLocalLayerEditor`) keeps the grid in its undo history and snaps to it.
- `CompositorModal.vue` shows the panel and a three-layer SVG overlay.
- The old grid type (seeded, generated) moves to `lib/compositor/mosaicGrid.ts`, and only Mosaic uses it.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Vitest (`npm run test:unit` in `frontend/`), Playwright (`npx playwright test` against the running dev server on `:3002`).

**Spec:** `docs/superpowers/specs/2026-09-26-frame-layout-grid-design.md`. Visual reference: `docs/superpowers/specs/assets/2026-09-26-frame-grid/grid-prototype.html`.

**Scope of this plan:**
- **Stage 1** (the grid, the panel, overlays, undo, box snapping, the shortcut, the agent, the Mosaic split) is written in full.
- **Stages 2–4** are outlined. Expand each one into full tasks, with the same level of detail, once the stage before it has landed, because their code depends on what stage 1 settles.

**Interim state after stage 1 (intended):**
- The Layout tab (`kit/plan.ts`) and Responsive Frames (`responsive/fromNode.ts`) keep reading the old `sailor_localGrid` through `gridConfig.ts` until stages 3 and 4. For almost every Frame that property is absent or "off", so nothing changes for them.
- The agent is moved in stage 1, not stage 4, because its `grid` state feeds the editor's `setLayoutGrid` directly.

## Global Constraints

- **Copy:** sentence case everywhere and no internal identifiers on screen. Panels show labels and values only; every explanation is a `title`/tooltip, never visible small text (user rule, 2026-09-26).
- **No red or pink in the grid overlay.**
  - The grid is neutral white hairlines under `mix-blend-mode: difference`: resting column lines at `rgba(255,255,255,.09)`, modules at `.22`, baselines at `.12`.
  - The only colour is the accent: `rgba(124,156,255,.22)` for the covered-module fill, and `#5b7cff` for snap lines, the badge, and the capital and baseline marks.
- **At rest, only the column edges show.** They stay visible whenever the grid is on, whatever is selected.
- **Modules and baselines fade in** (opacity transition 0.22 s) only while a layer is moving. A press counts as a move only after **4 screen px**.
- **⌃G on Mac shows or hides the grid; ⌘G groups, ⇧⌘G ungroups.** On Windows and Linux the shortcut is Ctrl+Shift+4.
- **Old Frames** (they have layers and no `sailor_layoutGrid`) open with the grid hidden. New Frames show it.
- **Changing the Line never resizes text already on the Frame.**
- **The grid is never painted** into renders, exports or embeds.
- **Commits:**
  - Use a private git index for every commit: `export GIT_INDEX_FILE=/tmp/claude-grid-index; git read-tree HEAD; git add <your paths>; git diff --cached --stat; git commit …; unset GIT_INDEX_FILE; git reset -q -- <your paths>`.
  - Stage only your own paths. Never `git stash`.
  - Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - After each commit, update the "State of the Build" dashboard and `docs/STATE.md` (replace, don't append).
- **Never run `npm run dev` from a subagent.** Use the existing `:3002` server; check `lsof -nP -iTCP -sTCP:LISTEN | grep node` first.

---

## File structure (stage 1)

| File | Responsibility |
|---|---|
| `frontend/app/lib/frame/layoutGrid.ts` (new) | `LayoutGrid` type; `suggestedLayoutGrid`, `readLayoutGrid` (with migration), `resolveLayoutGrid`, `patchLayoutGrid`, `layoutGridProperty`, `describeLayoutGrid` |
| `frontend/app/lib/frame/patterns/kit/sheet.ts` | Export `kitBasics()`, the kit's own B, margin, columns and info type size, reused by the suggested grid. `makeSheet` calls it; no behaviour change |
| `frontend/app/lib/frame/patterns/kit/plan.ts` | Export `formatSheetOpts` (today it's private) |
| `frontend/app/lib/compositor/mosaicGrid.ts` (moved from `lib/frame/grid.ts`) | Mosaic's seeded grid: `MosaicGrid`, `resolveGrid`, `defaultGrid`; a deprecated `FrameGrid` alias for the stage 3–4 readers |
| `frontend/app/composables/useLocalLayerEditor.ts` | Grid state and history, snap lines from the new grid, resize snapping, a 4 px move threshold; Fill grid and Draw section removed |
| `frontend/app/lib/agent/surfaces/compositor.ts` | `setGrid` vocabulary on `LayoutGrid`; `describe`; mosaic create gets a fresh grid |
| `frontend/app/components/vue-canvas/LayoutGridOverlay.vue` (new) | The three-layer SVG overlay, shared by the editor and the canvas card |
| `frontend/app/components/vue-canvas/LayoutGridSection.vue` (new) | The "Layout grid" panel section |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Uses the two components; shortcut; the "col" text box unit; agent bridge; old grid UI, Fill grid and Draw section removed |
| `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` | The card overlay uses `LayoutGridOverlay` |

---

### Task 1: `kitBasics` — the kit's sizes, reusable

**Files:**
- Modify: `frontend/app/lib/frame/patterns/kit/sheet.ts` (inside `makeSheet`, around lines 128–160)
- Modify: `frontend/app/lib/frame/patterns/kit/plan.ts:474` (export `formatSheetOpts`)
- Test: `frontend/tests/unit/frame-layout-kit-basics.unit.spec.ts` (new)

**Interfaces:**
- Produces: `export function kitBasics(frameW: number, frameH: number, format?: SheetOpts['format'], style?: StyleId): { B: number; margin: number; nc: number; infoSize: number; infoLh: number }`. Values are in kit units (percent of frame width): `margin` is the grid-off margin, and `infoSize` is the info type size.
- Produces: `export function formatSheetOpts(fmt: FrameFormat | null): SheetOpts['format']` (same body, now exported).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-layout-kit-basics.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { kitBasics, makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'

describe('kitBasics', () => {
  it('is 1 B, 12 columns and a 4-unit margin on the reference 895×1280 poster', () => {
    const k = kitBasics(895, 1280)
    expect(k.B).toBeCloseTo(1, 6)
    expect(k.nc).toBe(12)
    expect(k.margin).toBeCloseTo(4, 6)
    expect(k.infoSize).toBeCloseTo(1.95, 6)
    expect(k.infoLh).toBe(1.3)
  })
  it('uses 16 columns on a landscape, 20 on a banner, and the format override', () => {
    expect(kitBasics(1600, 900).nc).toBe(16)
    expect(kitBasics(1500, 500).nc).toBe(20)
    expect(kitBasics(728, 90, { nc: 24 }).nc).toBe(24)
  })
  it('widens the margin for a format that keeps the sides clear', () => {
    expect(kitBasics(1080, 1920, { keepSide: 0.06 }).margin).toBeCloseTo(6, 6)
  })
  it('matches what makeSheet uses with the grid off', () => {
    const k = kitBasics(1080, 1350)
    const S = makeSheet({ frameW: 1080, frameH: 1350, measure: makeStubMeasure() })
    expect(S.M).toBeCloseTo(k.margin, 6)
    expect(S.NC).toBe(k.nc)
    expect(S.INFO.size).toBeCloseTo(k.infoSize, 6)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/frame-layout-kit-basics.unit.spec.ts`
Expected: FAIL, `kitBasics is not a function`. If `S.M`, `S.NC` or `S.INFO` aren't on the returned `Sheet`, check the `Sheet` interface in the same file and use the names it exposes.

- [ ] **Step 3: Add `kitBasics` and use it in `makeSheet`**

Add above `makeSheet` in `sheet.ts`:

```ts
/** The kit's own sizes for a Frame shape, in kit units (percent of width), with the Frame grid OFF:
 *  the size unit B, the margin, the real column count, and the info (body) type size and leading.
 *  The Frame's suggested layout grid is built from these (lib/frame/layoutGrid.ts). */
export function kitBasics(frameW: number, frameH: number, format?: SheetOpts['format'], style: StyleId = 'swiss') {
  const W = 100
  const H_full = 100 * frameH / frameW
  const B = Math.sqrt(W * H_full) / Math.sqrt(100 * 100 * 1280 / 895)
  let margin = Math.min(4, H_full * 0.06)
  if (format?.keepSide != null) margin = Math.max(margin, format.keepSide * 100)
  const nc = format?.nc ?? (H_full / W >= 0.7 ? 12 : W / H_full >= 2.5 ? 20 : 16)
  const infoFloor = format?.view ? 900 / format.view : 0
  const infoSize = Math.max(1.95 * B, infoFloor)
  return { B, margin, nc, infoSize, infoLh: STYLES[style].info.lh }
}
```

Inside `makeSheet`, replace the local `B`, `infoFloor` and `infoSize` computations with the values from `kitBasics`. Keep `H` (the compose height) and every grid-on branch exactly as they are:

```ts
  const kb = kitBasics(o.frameW, o.frameH, o.format, o.style ?? 'swiss')
  const B = kb.B
  const kitM = Math.min(4, H * 0.06)
```

and further down:

```ts
  const infoSize = kb.infoSize
```

Delete the now-unused `const infoFloor = …` line. Leave `kitM` as it is, because it uses the compose height `H`, not `H_full`.

In `plan.ts`, change `function formatSheetOpts` to `export function formatSheetOpts`.

- [ ] **Step 4: Run the kit tests**

Run: `cd frontend && npx vitest run tests/unit/frame-layout-kit-basics.unit.spec.ts tests/unit/frame-layout-kit-sheet.unit.spec.ts tests/unit/frame-layout-plan.unit.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/kit/sheet.ts frontend/app/lib/frame/patterns/kit/plan.ts frontend/tests/unit/frame-layout-kit-basics.unit.spec.ts
git commit -m "refactor(frame/layout): kitBasics — the kit's margin, columns and body size, reusable by the layout grid"
```

---

### Task 2: `layoutGrid.ts` — the grid as data

**Files:**
- Create: `frontend/app/lib/frame/layoutGrid.ts`
- Test: `frontend/tests/unit/frame-layout-grid.unit.spec.ts` (new)

**Interfaces:**
- Consumes: `kitBasics` and `formatSheetOpts` (Task 1); `FrameFormat` from `~/lib/frame/formats`.
- Produces (every later task uses these exact names):

```ts
export type ColumnFit = 'stretch' | 'center' | 'left'
export type RowMode = 'off' | 'square' | 'count'
export interface LayoutGrid {
  v: 2; auto: boolean; show: boolean; line: number
  cols: { count: number; fit: ColumnFit; margin: number; gutter: number; width: number }
  rows: { mode: RowMode; count: number }
}
export interface Track { a: number; w: number }
export interface ResolvedLayoutGrid { W: number; H: number; unit: number; cols: Track[]; rows: Track[]; margin: number; top: number; bottom: number; xs: number[]; ys: number[] }
export interface LayoutGridPatch { columns?: number; gutter?: number; margin?: number; fit?: ColumnFit; width?: number; rows?: RowMode; rowCount?: number; line?: number; show?: boolean }
export function suggestedLayoutGrid(W: number, H: number, fmt: FrameFormat | null, keep?: { show?: boolean; rows?: LayoutGrid['rows'] }): LayoutGrid
export function readLayoutGrid(props: Record<string, unknown> | undefined, W: number, H: number, fmt: FrameFormat | null): LayoutGrid
export function resolveLayoutGrid(g: LayoutGrid, W: number, H: number, fmt?: FrameFormat | null, scale?: number): ResolvedLayoutGrid
export function patchLayoutGrid(g: LayoutGrid, p: LayoutGridPatch): LayoutGrid
export function layoutGridProperty(g: LayoutGrid): { sailor_layoutGrid: LayoutGrid }
export function describeLayoutGrid(g: LayoutGrid): string
```

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/frame-layout-grid.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  suggestedLayoutGrid, readLayoutGrid, resolveLayoutGrid, patchLayoutGrid, layoutGridProperty, describeLayoutGrid,
  type LayoutGrid,
} from '~/lib/frame/layoutGrid'
import { FRAME_FORMATS } from '~/lib/frame/formats'

const own = (over: Partial<LayoutGrid> = {}): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 12, fit: 'stretch', margin: 60, gutter: 20, width: 0 },
  rows: { mode: 'square', count: 8 },
  ...over,
})

describe('resolveLayoutGrid — columns', () => {
  it('stretch: exact columns margin to margin, real edges (not gutter centre lines)', () => {
    const r = resolveLayoutGrid(own(), 1080, 1350)
    expect(r.cols).toHaveLength(12)
    expect(r.cols[0]).toEqual({ a: 60, w: (1080 - 120 - 11 * 20) / 12 })
    const last = r.cols[11]!
    expect(last.a + last.w).toBeCloseTo(1020, 6)
    expect(r.margin).toBe(60)
    expect(r.xs).toContain(60)
    expect(r.xs).toContain(r.cols[0]!.a + r.cols[0]!.w)
    expect(r.xs).toContain(r.cols[1]!.a)
  })
  it('center: fixed-width columns centred', () => {
    const r = resolveLayoutGrid(own({ cols: { count: 4, fit: 'center', margin: 0, gutter: 20, width: 100 } }), 1000, 1000)
    const all = 4 * 100 + 3 * 20
    expect(r.cols[0]!.a).toBe((1000 - all) / 2)
    expect(r.cols[0]!.w).toBe(100)
  })
  it('left: fixed-width columns from the offset', () => {
    const r = resolveLayoutGrid(own({ cols: { count: 3, fit: 'left', margin: 40, gutter: 10, width: 50 } }), 1000, 1000)
    expect(r.cols.map(c => c.a)).toEqual([40, 100, 160])
  })
  it('scales every px value by the scale', () => {
    const a = resolveLayoutGrid(own(), 1080, 1350)
    const b = resolveLayoutGrid(own(), 540, 675, null, 0.5)
    expect(b.cols[0]!.a).toBeCloseTo(a.cols[0]!.a / 2, 6)
    expect(b.unit).toBe(a.unit / 2)
  })
})

describe('resolveLayoutGrid — rows on the baseline grid', () => {
  it('square: module height is the column width rounded to half a line; tops, heights, gaps are whole units', () => {
    const r = resolveLayoutGrid(own(), 1080, 1350)
    expect(r.unit).toBe(20)
    const cw = r.cols[0]!.w                                  // 61.67
    expect(r.rows[0]!.w).toBe(Math.round(cw / 20) * 20)      // 60
    expect(r.rows[0]!.a).toBe(60)
    for (const row of r.rows) { expect(row.a % 20).toBe(0); expect(row.w % 20).toBe(0) }
    expect(r.rows[1]!.a - (r.rows[0]!.a + r.rows[0]!.w)).toBe(20)
    const last = r.rows[r.rows.length - 1]!
    expect(last.a + last.w).toBeLessThanOrEqual(r.bottom)
  })
  it('count: the given number of rows, on the unit', () => {
    const r = resolveLayoutGrid(own({ rows: { mode: 'count', count: 5 } }), 1080, 1350)
    expect(r.rows).toHaveLength(5)
    for (const row of r.rows) expect(row.a % 20).toBe(0)
  })
  it('off: no rows, but the margins are still horizontal snap lines', () => {
    const r = resolveLayoutGrid(own({ rows: { mode: 'off', count: 8 } }), 1080, 1350)
    expect(r.rows).toEqual([])
    expect(r.ys).toContain(r.top)
    expect(r.ys).toContain(r.bottom)
  })
  it('a format that covers the top and bottom keeps the rows in the uncovered band', () => {
    const story = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const r = resolveLayoutGrid(own(), 1080, 1920, story)
    expect(r.rows[0]!.a).toBeGreaterThanOrEqual(0.14 * 1920)
    const last = r.rows[r.rows.length - 1]!
    expect(last.a + last.w).toBeLessThanOrEqual(1920 - 0.35 * 1920 + 1e-9)
  })
})

describe('suggestedLayoutGrid', () => {
  it('12 columns, gutter = half a line, line a multiple of 4, margin on the unit, square rows', () => {
    const g = suggestedLayoutGrid(1080, 1350, null)
    expect(g.auto).toBe(true)
    expect(g.cols.count).toBe(12)
    expect(g.line % 4).toBe(0)
    expect(g.line).toBeGreaterThanOrEqual(16)
    expect(g.cols.gutter).toBe(g.line / 2)
    expect(g.cols.margin % (g.line / 2)).toBe(0)
    expect(g.rows.mode).toBe('square')
  })
  it('takes the format column override', () => {
    const lb = FRAME_FORMATS.find(f => f.id === 'ad-728x90')!
    expect(suggestedLayoutGrid(728, 90, lb).cols.count).toBe(24)
  })
})

describe('readLayoutGrid', () => {
  it('a stored own grid reads back as stored', () => {
    const g = own()
    expect(readLayoutGrid(layoutGridProperty(g), 1080, 1350, null)).toEqual(g)
  })
  it('a stored auto grid follows the Frame (re-derived), keeping show and rows', () => {
    const stored = { ...suggestedLayoutGrid(1080, 1080, null), show: false, rows: { mode: 'off' as const, count: 3 } }
    const g = readLayoutGrid(layoutGridProperty(stored), 1920, 1080, null)
    expect(g.auto).toBe(true)
    expect(g.cols.count).toBe(16)                            // the landscape suggestion
    expect(g.show).toBe(false)
    expect(g.rows).toEqual({ mode: 'off', count: 3 })
  })
  it('no grid on a Frame with layers → auto, hidden (old Frames look the same)', () => {
    const g = readLayoutGrid({ sailor_localLayers: [{ id: 'a' }] }, 1080, 1350, null)
    expect(g.auto).toBe(true)
    expect(g.show).toBe(false)
  })
  it('no grid on an empty Frame → auto, shown', () => {
    expect(readLayoutGrid({}, 1080, 1350, null).show).toBe(true)
  })
  it('an old explicit grid becomes the user\'s own, in px', () => {
    const old = { mode: 'explicit', columns: 6, rows: 4, gutter: 0.01, margin: 0.04, overlay: true }
    const g = readLayoutGrid({ sailor_localGrid: old, sailor_localLayers: [{ id: 'a' }] }, 1000, 1250, null)
    expect(g.auto).toBe(false)
    expect(g.cols).toMatchObject({ count: 6, fit: 'stretch', margin: 40, gutter: 10 })
    expect(g.rows).toEqual({ mode: 'count', count: 4 })
    expect(g.show).toBe(true)
  })
  it('an old generated grid becomes the auto grid', () => {
    const g = readLayoutGrid({ sailor_localGrid: { mode: 'generated' } }, 1080, 1350, null)
    expect(g.auto).toBe(true)
  })
})

describe('patchLayoutGrid', () => {
  it('a column or line edit makes the grid the user\'s own; show and rows do not', () => {
    const g = suggestedLayoutGrid(1080, 1350, null)
    expect(patchLayoutGrid(g, { columns: 6 }).auto).toBe(false)
    expect(patchLayoutGrid(g, { show: false }).auto).toBe(true)
    expect(patchLayoutGrid(g, { rows: 'off' }).auto).toBe(true)
  })
  it('clamps counts and rounds the line to 4 px (min 16)', () => {
    const g = own()
    expect(patchLayoutGrid(g, { columns: 99 }).cols.count).toBe(24)
    expect(patchLayoutGrid(g, { rowCount: 0 }).rows.count).toBe(1)
    expect(patchLayoutGrid(g, { line: 43 }).line).toBe(44)
    expect(patchLayoutGrid(g, { line: 3 }).line).toBe(16)
  })
})

describe('describeLayoutGrid', () => {
  it('reads out in plain words', () => {
    expect(describeLayoutGrid(own())).toBe('12 columns, square rows, line 40 px')
    expect(describeLayoutGrid(own({ show: false, rows: { mode: 'count', count: 5 } }))).toBe('12 columns, 5 rows, line 40 px, hidden')
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/frame-layout-grid.unit.spec.ts`
Expected: FAIL, cannot resolve `~/lib/frame/layoutGrid`.

- [ ] **Step 3: Write `layoutGrid.ts`**

```ts
// frontend/app/lib/frame/layoutGrid.ts
// The Frame's layout grid — one standard grid per Frame (spec 2026-09-26-frame-layout-grid-design).
// Columns (count, gutter, margin in px at the design size; Stretch / Center / Left), rows (Off /
// Square / Count) that live on a baseline grid of half the body text's line spacing (`line`).
// Pure: no Vue, no DOM. Editor-only — nothing here is ever painted.
import type { FrameFormat } from '~/lib/frame/formats'
import { kitBasics } from '~/lib/frame/patterns/kit/sheet'
import { formatSheetOpts } from '~/lib/frame/patterns/kit/plan'

export type ColumnFit = 'stretch' | 'center' | 'left'
export type RowMode = 'off' | 'square' | 'count'
export interface LayoutGrid {
  v: 2
  /** true = every value below is derived from the Frame's shape and format on read; false = the user's own. */
  auto: boolean
  show: boolean
  /** Body text line spacing, px at the design size. The baseline grid is every line / 2. */
  line: number
  cols: { count: number; fit: ColumnFit; margin: number; gutter: number; width: number }
  rows: { mode: RowMode; count: number }
}
export interface Track { a: number; w: number }
export interface ResolvedLayoutGrid {
  W: number; H: number
  /** The baseline grid step (line / 2, scaled). */
  unit: number
  cols: Track[]; rows: Track[]
  /** The real left margin — the first column's left edge. */
  margin: number
  /** Where rows may start / must end (margins and covered areas). */
  top: number; bottom: number
  /** Snap lines, px. */
  xs: number[]; ys: number[]
}
export interface LayoutGridPatch {
  columns?: number; gutter?: number; margin?: number; fit?: ColumnFit; width?: number
  rows?: RowMode; rowCount?: number; line?: number; show?: boolean
}

const DEFAULT_ROWS: LayoutGrid['rows'] = { mode: 'square', count: 8 }
const roundLine = (v: number) => Math.max(16, Math.round(v / 4) * 4)
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))
const uniq = (vs: number[]) => [...new Set(vs.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b)

export function suggestedLayoutGrid(W: number, H: number, fmt: FrameFormat | null, keep?: { show?: boolean; rows?: LayoutGrid['rows'] }): LayoutGrid {
  const k = kitBasics(W, H, formatSheetOpts(fmt))
  const px = W / 100
  const line = roundLine(k.infoSize * k.infoLh * px)
  const unit = line / 2
  const margin = Math.max(unit, Math.round((k.margin * px) / unit) * unit)
  return {
    v: 2, auto: true, show: keep?.show ?? true, line,
    cols: { count: k.nc, fit: 'stretch', margin, gutter: unit, width: 0 },
    rows: keep?.rows ?? { ...DEFAULT_ROWS },
  }
}

function hasLayers(props: Record<string, unknown> | undefined): boolean {
  const ls = props?.sailor_localLayers
  return Array.isArray(ls) && ls.length > 0
}

export function readLayoutGrid(props: Record<string, unknown> | undefined, W: number, H: number, fmt: FrameFormat | null): LayoutGrid {
  const raw = props?.sailor_layoutGrid as Partial<LayoutGrid> | undefined
  if (raw && raw.v === 2) {
    if (raw.auto !== false) return suggestedLayoutGrid(W, H, fmt, { show: raw.show ?? true, rows: raw.rows ?? { ...DEFAULT_ROWS } })
    const s = suggestedLayoutGrid(W, H, fmt)
    return {
      v: 2, auto: false, show: raw.show ?? true, line: raw.line ?? s.line,
      cols: { ...s.cols, ...(raw.cols ?? {}) },
      rows: { ...DEFAULT_ROWS, ...(raw.rows ?? {}) },
    }
  }
  // Migration from the old sailor_localGrid (fractions of width).
  const old = props?.sailor_localGrid as { mode?: string; columns?: number; rows?: number; gutter?: number; margin?: number; overlay?: boolean } | undefined
  if (old?.mode === 'explicit') {
    const s = suggestedLayoutGrid(W, H, fmt)
    return {
      v: 2, auto: false, show: old.overlay !== false, line: s.line,
      cols: { count: clampInt(old.columns ?? 6, 1, 24), fit: 'stretch', margin: Math.min(0.45, Math.max(0, old.margin ?? 0.04)) * W, gutter: Math.max(0, old.gutter ?? 0.01) * W, width: 0 },
      rows: { mode: 'count', count: clampInt(old.rows ?? 4, 1, 24) },
    }
  }
  return suggestedLayoutGrid(W, H, fmt, { show: !hasLayers(props) })
}

export function resolveLayoutGrid(g: LayoutGrid, W: number, H: number, fmt: FrameFormat | null = null, scale = 1): ResolvedLayoutGrid {
  const unit = (g.line / 2) * scale
  const toUnit = (v: number) => Math.round(v / unit) * unit
  const n = Math.max(1, Math.round(g.cols.count))
  const gut = g.cols.gutter * scale, mar = g.cols.margin * scale
  let cw: number, x0: number
  if (g.cols.fit === 'stretch') { cw = Math.max(0, (W - 2 * mar - (n - 1) * gut) / n); x0 = mar }
  else { cw = Math.max(0, g.cols.width * scale); const all = n * cw + (n - 1) * gut; x0 = g.cols.fit === 'center' ? (W - all) / 2 : mar }
  const cols = Array.from({ length: n }, (_, i) => ({ a: x0 + i * (cw + gut), w: cw }))

  const keepTop = fmt?.keep ? fmt.keep.top * H : 0
  const keepBottom = fmt?.keep ? fmt.keep.bottom * H : 0
  const top = Math.max(unit, toUnit(mar), Math.ceil(keepTop / unit) * unit)
  const bottom = H - Math.max(mar, keepBottom)
  const gap = Math.max(unit, toUnit(gut))
  const avail = bottom - top
  let rows: Track[] = []
  if (g.rows.mode === 'square') {
    const mh = Math.max(unit, Math.round(cw / unit) * unit)
    const k = Math.max(1, Math.floor((avail + gap) / (mh + gap)))
    rows = Array.from({ length: k }, (_, i) => ({ a: top + i * (mh + gap), w: mh }))
  } else if (g.rows.mode === 'count') {
    const k = Math.max(1, Math.round(g.rows.count))
    const pitch = Math.max(2 * unit, Math.floor((avail + gap) / k / unit) * unit)
    const mh = Math.max(unit, pitch - gap)
    rows = Array.from({ length: k }, (_, i) => ({ a: top + i * pitch, w: mh }))
  }
  const xs = uniq([0, W / 2, W, ...cols.flatMap(c => [c.a, c.a + c.w])])
  const ys = uniq([0, H / 2, H, top, bottom, ...rows.flatMap(r => [r.a, r.a + r.w])])
  return { W, H, unit, cols, rows, margin: x0, top, bottom, xs, ys }
}

export function patchLayoutGrid(g: LayoutGrid, p: LayoutGridPatch): LayoutGrid {
  const ownsCols = p.columns != null || p.gutter != null || p.margin != null || p.fit != null || p.width != null || p.line != null
  return {
    ...g,
    auto: ownsCols ? false : g.auto,
    show: p.show ?? g.show,
    line: p.line != null ? roundLine(p.line) : g.line,
    cols: {
      count: p.columns != null ? clampInt(p.columns, 1, 24) : g.cols.count,
      fit: p.fit ?? g.cols.fit,
      margin: p.margin != null ? Math.max(0, p.margin) : g.cols.margin,
      gutter: p.gutter != null ? Math.max(0, p.gutter) : g.cols.gutter,
      width: p.width != null ? Math.max(1, p.width) : g.cols.width,
    },
    rows: { mode: p.rows ?? g.rows.mode, count: p.rowCount != null ? clampInt(p.rowCount, 1, 24) : g.rows.count },
  }
}

export function layoutGridProperty(g: LayoutGrid): { sailor_layoutGrid: LayoutGrid } {
  return { sailor_layoutGrid: g }
}

export function describeLayoutGrid(g: LayoutGrid): string {
  const rows = g.rows.mode === 'off' ? 'no rows' : g.rows.mode === 'square' ? 'square rows' : `${g.rows.count} rows`
  return `${g.cols.count} columns, ${rows}, line ${g.line} px${g.show ? '' : ', hidden'}`
}
```

Note: `plan.ts` imports a lot. If importing `formatSheetOpts` from it creates an import cycle or pulls in the renderer (`vitest` fails with a TDZ or `window` error), move `formatSheetOpts` into `sheet.ts` instead. Have `plan.ts` import it from there, and import it here from `sheet.ts`. See [[eager-module-const-init-order]].

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-layout-grid.unit.spec.ts`
Expected: all PASS. The "old explicit grid" test expects margin 40 (0.04 × 1000) and gutter 10 (0.01 × 1000).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/layoutGrid.ts frontend/tests/unit/frame-layout-grid.unit.spec.ts
git commit -m "feat(frame/grid): the layout grid as data — suggested per format, baseline rows, migration, patching"
```

---

### Task 3: Mosaic keeps the old grid under its own name

**Files:**
- Move: `frontend/app/lib/frame/grid.ts` → `frontend/app/lib/compositor/mosaicGrid.ts`
- Modify: every importer of `~/lib/frame/grid`. Today these are `useCompositorLayers.ts`, `useLocalLayerEditor.ts`, `ArtifactFrameNode.vue`, `CompositorModal.vue`, `responsive/types.ts`, `responsive/sections.ts`, `patterns/frameContext.ts`, `patterns/types.ts`, `gridConfig.ts`, `agent/surfaces/compositor.ts`, and the tests listed by `grep`.

**Interfaces:**
- Produces: `MosaicGrid` (today's `FrameGrid` shape), `resolveGrid`, `defaultGrid`, `Rect` from `~/lib/compositor/mosaicGrid`, plus `/** @deprecated */ export type FrameGrid = MosaicGrid`, kept only for the stage 3–4 readers (`gridConfig.ts`, `responsive/*`, `kit/plan.ts`).

- [ ] **Step 1: Move the file and rename the type**

```bash
cd frontend
git mv app/lib/frame/grid.ts app/lib/compositor/mosaicGrid.ts
sed -i '' -e 's#^// frontend/app/lib/frame/grid.ts#// frontend/app/lib/compositor/mosaicGrid.ts — Mosaic'"'"'s seeded grid (moved from lib/frame/grid.ts; the Frame uses lib/frame/layoutGrid.ts)#' \
  -e 's/export interface FrameGrid {/export interface MosaicGrid {/' \
  -e 's/\bFrameGrid\b/MosaicGrid/g' app/lib/compositor/mosaicGrid.ts
printf '\n/** @deprecated The old Frame grid shape. Read only by gridConfig.ts, responsive/* and kit/plan.ts until stages 3–4 of the layout-grid plan; new code uses LayoutGrid. */\nexport type FrameGrid = MosaicGrid\n' >> app/lib/compositor/mosaicGrid.ts
grep -rl "~/lib/frame/grid'" app tests | xargs sed -i '' "s#~/lib/frame/grid'#~/lib/compositor/mosaicGrid'#g"
```

- [ ] **Step 2: Name the Mosaic uses by their new name**

In `app/composables/useCompositorLayers.ts`, change the import on line ~122 to `import { resolveGrid, defaultGrid, type MosaicGrid } from '~/lib/compositor/mosaicGrid'`. Then replace `FrameGrid` with `MosaicGrid` in that file (the `DealLayer.grid` field and any casts). Do the same in `tests/unit/deal-layer.unit.spec.ts`.

- [ ] **Step 3: Typecheck and run the whole unit suite**

Run: `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "mosaicGrid|lib/frame/grid" | head` (expected: no lines), then `npx vitest run`.
Expected: the same pass and fail counts as `main` before this task. The suite has a known baseline; compare against it, not zero. See [[typecheck-baseline-anchoring]] and [[vitest-counts-lie-under-load]].

- [ ] **Step 4: Commit**

```bash
git add -A frontend/app/lib/compositor/mosaicGrid.ts frontend/app/lib/frame/grid.ts $(git diff --name-only -- frontend/app frontend/tests | grep -v '^$')
git diff --cached --stat   # only the move + import edits
git commit -m "refactor(mosaic): the seeded grid moves to lib/compositor/mosaicGrid as MosaicGrid; the Frame gets its own"
```

---

### Task 4: The editor — grid in history, snap lines, resize snapping, a 4 px move threshold

**Files:**
- Modify: `frontend/app/composables/useLocalLayerEditor.ts` (lines ~34–35 imports, ~253–263 grid state, ~330–347 `Snapshot`/`snapshot`/`restore`, ~808–826 `gridSnapLines`, ~855–866 `startMove`, ~964–1000 `onMove`, ~1044–1136 section ops, ~1281–1282 exports)
- Test: `frontend/tests/unit/frame-layout-grid-editor.unit.spec.ts` (new)

**Interfaces:**
- Consumes: `readLayoutGrid`, `resolveLayoutGrid`, `layoutGridProperty`, `LayoutGrid`, `ResolvedLayoutGrid` (Task 2); `formatFor` from `~/lib/frame/formats`.
- Produces on the editor's return object:
  - `layoutGrid: ComputedRef<LayoutGrid>`
  - `layoutGridResolved: ComputedRef<ResolvedLayoutGrid>`
  - `setLayoutGrid(g: LayoutGrid, record?: boolean): void`
  - `ensureLayoutGrid(): void` (writes the read grid when the property is absent)
  - `dragMoving: ComputedRef<boolean>` (a move that has passed the 4 px threshold)
  - `resnapSelected` (unchanged name)
- Removes: `grid`, `setGrid`, `fillGridWithSections`, `drawSectionActive`, `setDrawSectionActive`, `finishDrawSection`, `nearestGridLine`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/frame-layout-grid-editor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { patchLayoutGrid } from '~/lib/frame/layoutGrid'

function editor(properties: Record<string, any> = {}) {
  const node = reactive({ id: 'f', data: { properties } }) as any
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 1080, h: 1350 }), getRect: () => null })
  return { node, ed }
}

describe('layout grid in the editor', () => {
  it('ensureLayoutGrid writes the grid once, shown for an empty Frame', () => {
    const { node, ed } = editor()
    ed.ensureLayoutGrid()
    expect(node.data.properties.sailor_layoutGrid.show).toBe(true)
  })
  it('an old Frame with layers gets a hidden grid', () => {
    const { node, ed } = editor({ sailor_localLayers: [createRectLayer({})] })
    ed.ensureLayoutGrid()
    expect(node.data.properties.sailor_layoutGrid.show).toBe(false)
  })
  it('a grid change is one undo step', () => {
    const { node, ed } = editor()
    ed.ensureLayoutGrid()
    ed.setLayoutGrid(patchLayoutGrid(ed.layoutGrid.value, { columns: 6 }))
    expect(node.data.properties.sailor_layoutGrid.cols.count).toBe(6)
    ed.undo()
    expect(node.data.properties.sailor_layoutGrid.cols.count).toBe(12)
    ed.redo()
    expect(node.data.properties.sailor_layoutGrid.cols.count).toBe(6)
  })
  it('snap lines come from the resolved grid and vanish when the grid is hidden', () => {
    const { ed } = editor()
    ed.ensureLayoutGrid()
    const r = ed.layoutGridResolved.value
    expect(ed.gridSnapLines.value.xs).toContain(r.cols[0]!.a / 1080)
    ed.setLayoutGrid(patchLayoutGrid(ed.layoutGrid.value, { show: false }))
    expect(ed.gridSnapLines.value.xs).toEqual([])
  })
})
```

If `gridSnapLines` isn't on the return object today, add it to the returned object in Step 3; the tests read it.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/frame-layout-grid-editor.unit.spec.ts`
Expected: FAIL, `ensureLayoutGrid is not a function`.

- [ ] **Step 3: Replace the grid state (lines ~253–263)**

Replace the `// Doc-level grid config …` comment, `const grid = computed…` and `function setGrid…` with:

```ts
  // The Frame's layout grid (spec 2026-09-26-frame-layout-grid-design): stored on
  // `sailor_layoutGrid`, read through readLayoutGrid (auto grids follow the format;
  // old Frames migrate). Part of the undo Snapshot — a grid change is a real edit.
  const frameFormat = computed(() => { const { w, h } = dims(); return formatFor(node()?.data?.properties as any, w, h) })
  const layoutGrid = computed<LayoutGrid>(() => { const { w, h } = dims(); return readLayoutGrid(node()?.data?.properties as any, w, h, frameFormat.value) })
  const layoutGridResolved = computed<ResolvedLayoutGrid>(() => { const { w, h } = dims(); return resolveLayoutGrid(layoutGrid.value, w, h, frameFormat.value) })
  function writeLayoutGrid(g: LayoutGrid) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    Object.assign(n.data.properties, layoutGridProperty(JSON.parse(JSON.stringify(g))))
  }
  function setLayoutGrid(g: LayoutGrid, record = true) { if (record) recordHistory(); writeLayoutGrid(g) }
  /** Fix the grid on first open: an old Frame (layers, no grid) keeps it hidden forever after,
   *  a new one keeps it shown — without this, a new Frame would read as "old" once it had layers. */
  function ensureLayoutGrid() {
    const p = node()?.data?.properties as any
    if (!p?.sailor_layoutGrid) writeLayoutGrid(layoutGrid.value)
  }
```

`recordHistory` is declared further down as a function declaration, so it's hoisted; this matches `setFrameLight`, which already calls it above its declaration.

Fix the imports on lines ~34–35:

```ts
import { readLayoutGrid, resolveLayoutGrid, layoutGridProperty, type LayoutGrid, type ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'
import { formatFor } from '~/lib/frame/formats'
```

(If `formatFor` is already imported, don't add it twice. `Rect` was only used by `fillGridWithSections`, so drop it.)

- [ ] **Step 4: Put the grid in the snapshot**

In the `Snapshot` type add `grid?: LayoutGrid`. In `snapshot()` add `grid: (node()?.data?.properties as any)?.sailor_layoutGrid ? JSON.parse(JSON.stringify((node()!.data.properties as any).sailor_layoutGrid)) : undefined`. At the end of `restore(s)` add `if (s.grid) writeLayoutGrid(s.grid)`.

- [ ] **Step 5: Snap lines from the new grid (lines ~815–826)**

```ts
  // Grid snap lines, normalized to [0,1]. Only while the grid is shown — a hidden guide never
  // pulls a layer. Recomputed when the grid or the canvas dims change, not per pointer event.
  const gridSnapLines = computed(() => {
    if (!layoutGrid.value.show) return { xs: [] as number[], ys: [] as number[] }
    const { w: W, h: H } = dims()
    const r = layoutGridResolved.value
    return { xs: r.xs.map(x => x / W), ys: r.ys.map(y => y / H) }
  })
```

- [ ] **Step 6: The move threshold (`startMove` and the `move` branch of `onMove`)**

Add `moved?: boolean` to the `'move'` member of the `Drag` union. In `startMove`, delete the `recordHistory()` line and set `moved: false` in the new drag object. At the top of the `if (d.type === 'move') {` branch in `onMove`:

```ts
      if (!d.moved) {
        // A press is a click until it travels 4 screen px: selecting changes nothing, records nothing.
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < MOVE_SLOP_PX) return
        d.moved = true
        recordHistory() // coalesce the whole drag into one undo step
      }
```

Next to `SNAP_PX` add `const MOVE_SLOP_PX = 4`, and expose `const dragMoving = computed(() => drag.value?.type === 'move' && !!(drag.value as any).moved)`.

**Check:** `useLayoutVary` folds late re-applies using `historyRev()`, and its comment says a click records at pointer-down. After this change a click doesn't bump the revision, which is correct because a click changes nothing. Run `npx vitest run tests/unit/use-layout-vary*.unit.spec.ts tests/unit/layout-*.unit.spec.ts`; they must still pass. Update that comment in `useLayoutVary.ts` (~line 350) to say "a drag records once it moves".

- [ ] **Step 7: Resize snapping (the `resize` branch of `onMove`)**

Just before the `resizeBox(...)` call, snap the pointer when the layer isn't rotated and ⌥ isn't held:

```ts
      let px = nx * W, py = ny * H
      if (!e.altKey && !d.rot) {
        const gl = gridSnapLines.value, th = SNAP_PX * W / r.width   // screen px → design px
        let gx: number | null = null, gy: number | null = null
        for (const x of gl.xs) { const v = x * W; if (Math.abs(v - px) < th && (gx == null || Math.abs(v - px) < Math.abs(gx - px))) gx = v }
        for (const y of gl.ys) { const v = y * H; if (Math.abs(v - py) < th && (gy == null || Math.abs(v - py) < Math.abs(gy - py))) gy = v }
        if (gx != null) px = gx
        if (gy != null) py = gy
        snapGuides.value = { vx: gx != null ? gx / W : null, hy: gy != null ? gy / H : null }
      }
```

and pass `{ x: px, y: py }` where the call passed `{ x: nx * W, y: ny * H }`.

- [ ] **Step 8: Remove the section tools**

Delete `fillGridWithSections`, `drawSectionActive`, `setDrawSectionActive`, `nearestGridLine` and `finishDrawSection` (lines ~1044–1136). Keep `resnapSelected`. In the returned object, remove those names and `grid, setGrid`, and add `layoutGrid, layoutGridResolved, setLayoutGrid, ensureLayoutGrid, dragMoving, gridSnapLines`. Leave `resnapSelected` as it is; it already reads `gridSnapLines`.

- [ ] **Step 9: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-layout-grid-editor.unit.spec.ts tests/unit/frame-undo-motion.unit.spec.ts tests/unit/frame-size.unit.spec.ts tests/unit/compositor-snap.unit.spec.ts`
Expected: all PASS. `CompositorModal.vue` won't typecheck until Task 6. That's expected; don't commit a broken modal on its own, so commit Tasks 4–6 together.

---

### Task 5: The agent speaks the new grid

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts` (imports ~34–35; `CompositorState.grid` ~76–79; the `setGrid` hint ~868; `describe` ~963–967; `setGrid` ~1210–1218; mosaic create ~1273–1278)
- Replace: `frontend/tests/unit/agent-grid.unit.spec.ts`

**Interfaces:**
- Consumes: `LayoutGrid`, `patchLayoutGrid`, `describeLayoutGrid`, `suggestedLayoutGrid` (Task 2); `defaultGrid`, `MosaicGrid` (Task 3).
- Produces: `CompositorState.grid?: LayoutGrid`. `setGrid` args are `{ columns?, gutter?, margin?, fit?, width?, rows?, rowCount?, line?, show?, suggested? }`.

- [ ] **Step 1: Replace the agent grid test**

```ts
// frontend/tests/unit/agent-grid.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'
import { suggestedLayoutGrid } from '~/lib/frame/layoutGrid'

const baseState = (): CompositorState => ({
  layers: [{ id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any],
  grid: suggestedLayoutGrid(1080, 1350, null),
})

describe('setGrid', () => {
  it('sets columns and square rows, making the grid the user\'s own', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { columns: 6, rows: 'square' } })
    expect(r.ok).toBe(true)
    const g = (r as any).template.grid
    expect(g.cols.count).toBe(6)
    expect(g.rows.mode).toBe('square')
    expect(g.auto).toBe(false)
  })
  it('shows or hides the grid without owning it', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { show: false } })
    expect((r as any).template.grid.show).toBe(false)
    expect((r as any).template.grid.auto).toBe(true)
  })
  it('suggested:true returns to the auto grid', () => {
    const s = baseState(); s.grid = { ...s.grid!, auto: false }
    const r = applyCompositorCommand(s, { op: 'setGrid', args: { suggested: true } })
    expect((r as any).template.grid.auto).toBe(true)
  })
  it('a generated-grid request points to mosaic', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { generate: true } })
    expect(r.ok).toBe(false)
    expect((r as any).detail).toMatch(/mosaic/)
  })
  it('describe reads the grid out in plain words', () => {
    const d = describeCompositor(baseState()) as any
    expect(JSON.stringify(d)).toMatch(/12 columns, square rows, line \d+ px/)
  })
})

describe('mosaic create', () => {
  it('makes its own generated grid, never the Frame\'s', () => {
    const r = applyCompositorCommand(baseState(), { op: 'mosaic', args: {} })
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers.at(-1)
    expect(layer.grid.mode).toBe('generated')
  })
})
```

If `describeCompositor` has a different export name, use the name the old test imported. It imported `describeCompositor`, so it exists.

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/agent-grid.unit.spec.ts`
Expected: FAIL on the new argument shape.

- [ ] **Step 3: Change the surface**

Imports:

```ts
import { patchLayoutGrid, describeLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'
import { defaultGrid, type MosaicGrid } from '~/lib/compositor/mosaicGrid'
```

Remove `readGrid`. `CompositorState.grid`:

```ts
  /** The Frame's layout grid (`sailor_layoutGrid`, read through readLayoutGrid by the host). */
  grid?: LayoutGrid
```

`setGrid` case:

```ts
    case 'setGrid': {
      const a = (cmd.args ?? {}) as Record<string, any>
      if (a.generate === true || a.reroll === true || a.patch?.mode === 'generated')
        return { ok: false, reason: 'invalid', detail: "The Frame's grid is a layout guide; for a generated grid pattern use mosaic." }
      const cur = state.grid
      if (!cur) return { ok: false, reason: 'invalid', detail: 'this frame has no grid yet' }
      if (a.suggested === true) return { ok: true, template: { ...state, grid: { ...cur, auto: true } }, inverse: snapshot() }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const next = patchLayoutGrid(cur, {
        columns: num(a.columns), gutter: num(a.gutter), margin: num(a.margin), width: num(a.width),
        fit: ['stretch', 'center', 'left'].includes(a.fit) ? a.fit : undefined,
        rows: ['off', 'square', 'count'].includes(a.rows) ? a.rows : undefined,
        rowCount: num(a.rowCount), line: num(a.line),
        show: typeof a.show === 'boolean' ? a.show : undefined,
      })
      return { ok: true, template: { ...state, grid: next }, inverse: snapshot() }
    }
```

`describe`: replace the `grid:` ternary with `grid: state.grid ? describeLayoutGrid(state.grid) : 'none',`.

Mosaic create: replace the three lines from `const base = readGrid(…)` to `if (grid.mode === 'off') grid.mode = 'generated'` with:

```ts
      const grid: MosaicGrid = { ...defaultGrid(), mode: 'generated' }
```

Keep the following `grid.gen = …`, seed and reroll lines. Fix any other `FrameGrid` type in this file to `MosaicGrid`; the restyle path patches a deal's own `grid.gen`.

The hint at ~868, replaced whole:

```ts
  { op: 'setGrid', hint: 'Set the Frame\'s layout grid — a standard guide layers snap to (editor-only, never exported). args (all optional): columns (1..24), gutter and margin (px at the design size), fit ("stretch" | "center" | "left"), width (px per column when fit is center/left), rows ("off" | "square" | "count"), rowCount (1..24, with rows "count"), line (the body text line spacing in px; the baseline grid is half of it), show (bool), suggested (true = back to the grid suggested for the format). This is what "a 12-column grid", "square modules", "a baseline grid", "show the grid" and "hide the grid" mean. For a generated grid PATTERN use mosaic.' },
```

- [ ] **Step 4: Run it**

Run: `cd frontend && npx vitest run tests/unit/agent-grid.unit.spec.ts tests/unit/deal-layer.unit.spec.ts tests/unit/mosaic-element.unit.spec.ts`
Expected: all PASS.

---

### Task 6: The editor UI — the overlay component, the panel section, the modal wiring, the card

**Files:**
- Create: `frontend/app/components/vue-canvas/LayoutGridOverlay.vue`
- Create: `frontend/app/components/vue-canvas/LayoutGridSection.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (imports ~175–176; grid computeds ~494–502; destructure ~932–933; section-ops ~1205–1225; pointer handlers ~4001–4010, ~4215, ~4226; `designOnlyToolActive` ~7669; `boxToUnit`/`setBoxDim` ~6231/6239; overlay ~8962–8986; Re-snap button ~11468; Grid section ~12807–12868; keydown ~2524–2526; agent bridge ~1596/1607)
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (~34–35, ~143–154 and its overlay template)

**Interfaces:**
- Consumes: `ResolvedLayoutGrid`, `LayoutGrid`, `patchLayoutGrid`, `suggestedLayoutGrid`, `resolveLayoutGrid`, `readLayoutGrid` (Task 2); the editor's `layoutGrid`, `layoutGridResolved`, `setLayoutGrid`, `ensureLayoutGrid`, `dragMoving` (Task 4).
- Produces:
  - `<LayoutGridOverlay :grid="ResolvedLayoutGrid" :show="boolean" :moving="boolean" :covered="{ x: number; y: number; w: number; h: number } | null" :w="number" :h="number" />`. `covered` is the moving layer's box in grid px; `w`/`h` are the displayed size.
  - `<LayoutGridSection :grid="LayoutGrid" :resolved="ResolvedLayoutGrid" :format-label="string" @update="(g: LayoutGrid) => void" />`.

- [ ] **Step 1: `LayoutGridOverlay.vue`**

```vue
<!-- The layout grid's editor overlay (spec 2026-09-26-frame-layout-grid-design). Three SVGs that
     stay mounted so the modules can FADE: column edges (always, very faint), modules + baselines
     (only while a layer is moving), and the accent fill on what the moving layer covers. Neutral
     lines blend with `difference`, so they read on a light or a dark Frame. Never painted into a
     render — it is DOM over the artboard, outside every paintLayerStack path. -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'

const props = defineProps<{
  grid: ResolvedLayoutGrid
  show: boolean
  moving: boolean
  /** The moving layer's box in grid px, or null. */
  covered: { x: number; y: number; w: number; h: number } | null
  /** Displayed size in CSS px (the SVGs scale the grid's px into it). */
  w: number; h: number
}>()

const vb = computed(() => `0 0 ${props.grid.W} ${props.grid.H}`)
// one CSS px in grid units, so hairlines stay 1px at any zoom
const px = computed(() => props.grid.W / Math.max(1, props.w))
const colEdges = computed(() => [...new Set(props.grid.cols.flatMap(c => [c.a, c.a + c.w]))])
const cells = computed(() => props.grid.rows.length
  ? props.grid.cols.flatMap(c => props.grid.rows.map(r => ({ x: c.a, y: r.a, w: c.w, h: r.w })))
  : props.grid.cols.map(c => ({ x: c.a, y: 0, w: c.w, h: props.grid.H })))
const baselines = computed(() => {
  const out: number[] = []
  for (let y = props.grid.unit; y < props.grid.H; y += props.grid.unit) out.push(y)
  return out
})
const coveredCells = computed(() => {
  const b = props.covered
  if (!b || !props.moving) return []
  const over = (a0: number, a1: number, t0: number, t1: number) => Math.min(a1, t1) - Math.max(a0, t0) > (t1 - t0) / 2
  return cells.value.filter(c => over(b.x, b.x + b.w, c.x, c.x + c.w) && (props.grid.rows.length ? over(b.y, b.y + b.h, c.y, c.y + c.h) : true))
})
</script>

<template>
  <div v-if="show" class="lg-overlay" data-testid="compositor-grid-overlay">
    <svg class="lg-neutral" :viewBox="vb" preserveAspectRatio="none">
      <line v-for="x in colEdges" :key="'c' + x" :x1="x" :x2="x" y1="0" :y2="grid.H" stroke="rgba(255,255,255,.09)" :stroke-width="px" />
    </svg>
    <svg class="lg-neutral lg-mods" :class="{ on: moving }" :viewBox="vb" preserveAspectRatio="none" data-testid="compositor-grid-modules">
      <rect v-for="(c, i) in cells" :key="'m' + i" :x="c.x" :y="c.y" :width="c.w" :height="c.h" fill="none" stroke="rgba(255,255,255,.22)" :stroke-width="px" />
      <line v-for="y in baselines" :key="'b' + y" x1="0" :x2="grid.W" :y1="y" :y2="y" stroke="rgba(255,255,255,.12)" :stroke-width="px" />
    </svg>
    <svg class="lg-marks" :viewBox="vb" preserveAspectRatio="none">
      <rect v-for="(c, i) in coveredCells" :key="'k' + i" :x="c.x" :y="c.y" :width="c.w" :height="c.h" fill="rgba(124,156,255,.22)" />
    </svg>
  </div>
</template>

<style scoped>
.lg-overlay { position: absolute; inset: 0; pointer-events: none; }
.lg-overlay svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.lg-neutral { mix-blend-mode: difference; }
.lg-mods { opacity: 0; transition: opacity .22s ease; }
.lg-mods.on { opacity: 1; }
</style>
```

- [ ] **Step 2: `LayoutGridSection.vue`**

Look at the old Grid section (~12807–12868) for the exact `StudioSection`, `StudioSegmented`, `StudioSwitch` and `StudioButton` props, and at `StudioField` or the number inputs used in the Frame section (~12749–12788) for a px number field. Use the same components. Every explanation goes in a `hint`/`title`, as per Global Constraints.

```vue
<!-- The Frame editor's "Layout grid" section. Labels and values only; explanations live in tooltips. -->
<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import { patchLayoutGrid, type LayoutGrid, type LayoutGridPatch, type ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'

const props = defineProps<{ grid: LayoutGrid; resolved: ResolvedLayoutGrid; formatLabel: string }>()
const emit = defineEmits<{ update: [g: LayoutGrid] }>()
const patch = (p: LayoutGridPatch) => emit('update', patchLayoutGrid(props.grid, p))
const colWidth = computed(() => Math.round(props.resolved.cols[0]?.w ?? 0))
const realMargin = computed(() => Math.round(props.resolved.margin))
function setFit(fit: 'stretch' | 'center' | 'left') {
  // leaving Stretch starts the fixed width from the width the columns have now
  emit('update', patchLayoutGrid(props.grid, props.grid.cols.fit === 'stretch' && fit !== 'stretch' ? { fit, width: colWidth.value } : { fit }))
}
const num = (e: Event) => Number((e.target as HTMLInputElement).value)
</script>

<template>
  <StudioSection title="Layout grid" hint="A guide for placing layers. Layers snap to it; it never appears in exports.">
    <template #actions>
      <button v-if="!grid.auto" class="text-white/40 hover:text-white/80 p-1" :title="`Use the suggested grid for ${formatLabel}`"
        data-testid="grid-suggested" @click="emit('update', { ...grid, auto: true })"><RotateCcw class="size-3.5" /></button>
      <StudioSwitch :model-value="grid.show" title="Show grid ⌃G" data-testid="grid-show" @update:model-value="(v: boolean) => patch({ show: v })" />
    </template>

    <div class="panel-label mb-1">Columns</div>
    <div class="grid grid-cols-2 gap-1.5 mb-1.5">
      <StudioNumberField label="Count" :min="1" :max="24" :model-value="grid.cols.count" data-testid="grid-columns" @change="(v: number) => patch({ columns: v })" />
      <StudioNumberField label="Gutter" unit="px" :min="0" :model-value="grid.cols.gutter" @change="(v: number) => patch({ gutter: v })" />
    </div>
    <StudioSegmented :options="['stretch', 'center', 'left']" :option-labels="['Stretch', 'Center', 'Left']" :model-value="grid.cols.fit" @update:model-value="setFit" />
    <div class="grid grid-cols-2 gap-1.5 mt-1.5">
      <StudioNumberField :label="grid.cols.fit === 'left' ? 'Offset' : 'Margin'" unit="px" :min="0" :disabled="grid.cols.fit === 'center'"
        :model-value="grid.cols.fit === 'stretch' ? realMargin : grid.cols.margin" @change="(v: number) => patch({ margin: v })" />
      <StudioNumberField label="Width" unit="px" :min="1" :disabled="grid.cols.fit === 'stretch'"
        :model-value="grid.cols.fit === 'stretch' ? colWidth : grid.cols.width" @change="(v: number) => patch({ width: v })" />
    </div>

    <div class="panel-label mt-3 mb-1" title="Square makes rows as tall as the columns are wide, rounded to the baseline grid.">Rows</div>
    <StudioSegmented :options="['off', 'square', 'count']" :option-labels="['Off', 'Square', 'Count']" :model-value="grid.rows.mode"
      data-testid="grid-rows" @update:model-value="(v: any) => patch({ rows: v })" />
    <StudioNumberField v-if="grid.rows.mode === 'count'" class="mt-1.5" label="Count" :min="1" :max="24" :model-value="grid.rows.count" @change="(v: number) => patch({ rowCount: v })" />

    <StudioNumberField class="mt-3" label="Line" unit="px" :min="16" :step="4" :model-value="grid.line"
      title="The body text's line spacing. Rows and the baseline grid (every half line) come from it." @change="(v: number) => patch({ line: v })" />
  </StudioSection>
</template>
```

**Adapting to the real components:**
- If `StudioSection` has no `#actions` slot, or `StudioNumberField` doesn't exist, use what the Frame section uses for its W/H fields: an `<input type="number">` with `@change="patch({ … : num($event) })"` and the same classes.
- Use `@change`, not `@input`, so a half-typed value never resizes the grid and one edit is one undo step.
- If `StudioSegmented` doesn't take `option-labels`, pass the lowercase options; it capitalises single words.

- [ ] **Step 3: Wire the modal**

Imports: remove `readGrid`, `resolveGrid` and `FrameGrid`; add `import LayoutGridOverlay from './LayoutGridOverlay.vue'`, `import LayoutGridSection from './LayoutGridSection.vue'` and `import { suggestedLayoutGrid } from '~/lib/frame/layoutGrid'`, plus `formatFor` if it isn't imported.

Replace the grid computeds (~494–502) with:

```ts
// The layout grid: state and history live in the editor (useLocalLayerEditor); this only displays it.
const layoutGridScale = computed(() => canvasDisplay.w / Math.max(1, editorDims().w))
const movingBox = computed(() => {
  if (!dragMoving.value) return null
  const l = selected.value; if (!l) return null
  const W = editorDims().w, H = editorDims().h
  const b = localLayerBox(l, W, H)             // the same box the handles use
  return { x: b.x, y: b.y, w: b.w, h: b.h }
})
const frameFormatLabel = computed(() => formatFor(compositor.value?.data?.properties as any, editorDims().w, editorDims().h)?.label ?? 'this size')
watch(() => compositor.value?.id, id => { if (id) ensureLayoutGrid() }, { immediate: true })
```

**Check `localLayerBox`'s signature** in `useCompositorLayers.ts` (~1918). It returns the layer's box; convert its centre-based box to a top-left `{x, y, w, h}` in design px if it's centre-based, and include `textVAlignCenterOffset` the way the hit test does. Destructure `layoutGrid, layoutGridResolved, setLayoutGrid, ensureLayoutGrid, dragMoving` from `editor` (~932), and remove `fillGridWithSections, drawSectionActive, setDrawSectionActive, finishDrawSection`.

Delete:
- `GRID_SECTIONS_CAP`, `onDrawSectionSwitch` and `onFillGridWithSections` (~1205–1225);
- the `if (drawSectionActive.value) { … return }` block in the canvas pointerdown (~4001–4010);
- the `else if (drawSectionActive.value) { … }` branches at ~4215 and ~4226;
- `|| drawSectionActive.value` in `designOnlyToolActive` (~7669).

Re-snap button (~11468): change `v-if="gridConfig.mode !== 'off'"` to `v-if="layoutGrid.show"`.

The "col" text box unit (~6231, ~6239): one column plus one gutter of the grid, as a fraction of width:

```ts
const colPitchFrac = computed(() => { const r = layoutGridResolved.value; const c = r.cols; return c.length > 1 ? (c[1]!.a - c[0]!.a) / r.W : (c[0]?.w ?? r.W) / r.W })
```

In `boxToUnit` replace `Math.round(frac * (gridConfig.value.columns || 16) * 10) / 10` with `Math.round(frac / colPitchFrac.value * 10) / 10`. In `setBoxDim` replace `v / (gridConfig.value.columns || 16)` with `v * colPitchFrac.value`.

Overlay (~8962–8986): replace the old `<svg v-if="showGridOverlay" …>…</svg>` with:

```vue
        <LayoutGridOverlay :grid="layoutGridResolved" :show="layoutGrid.show" :moving="dragMoving" :covered="movingBox"
          :w="canvasDisplay.w" :h="canvasDisplay.h" />
```

It must sit in the same positioned box the old SVG did; that box pans and zooms with the Frame. The component's SVG viewBox is the design size, so no rescaling is needed. At a responsive viewing size, stage 4 passes a scaled grid.

The Grid section (~12807–12868): delete the whole `<StudioSection title="Grid">…</StudioSection>`. Insert directly **after** the Frame section's closing tag (~12782), before Background:

```vue
          <LayoutGridSection :grid="layoutGrid" :resolved="layoutGridResolved" :format-label="frameFormatLabel" @update="(g) => setLayoutGrid(g)" />
```

The shortcut (~2524–2526): replace the group branch with:

```ts
  } else if ((e.key === 'g' || e.key === 'G') && e.ctrlKey && !e.metaKey && isMac && !editingId.value) {
    // ⌃G shows or hides the layout grid (Figma); ⌘G stays Group on Mac.
    e.preventDefault(); e.stopPropagation()
    setLayoutGrid({ ...layoutGrid.value, show: !layoutGrid.value.show })
  } else if (!isMac && e.ctrlKey && e.shiftKey && e.code === 'Digit4' && !editingId.value) {
    e.preventDefault(); e.stopPropagation()
    setLayoutGrid({ ...layoutGrid.value, show: !layoutGrid.value.show })
  } else if (meta && (e.key === 'g' || e.key === 'G') && !editingId.value) {
    e.preventDefault(); e.stopPropagation()
    if (e.shiftKey) ungroupSelected(); else groupSelected()
  }
```

with `const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)` near the other module constants. If a helper like `isMacPlatform` already exists (grep `navigator.platform`), use it.

The agent bridge: in `getState` use `grid: layoutGrid.value`. In `setState` use `if (s.grid && JSON.stringify(s.grid) !== JSON.stringify(layoutGrid.value)) setLayoutGrid(s.grid)`.

- [ ] **Step 4: The card overlay (`ArtifactFrameNode.vue`)**

Replace the imports on ~34–35 and the grid block on ~143–154 with:

```ts
import { readLayoutGrid, resolveLayoutGrid } from '~/lib/frame/layoutGrid'
import { formatFor } from '~/lib/frame/formats'
import LayoutGridOverlay from './LayoutGridOverlay.vue'
// ── Layout grid overlay (editor-only guide, read-only here; the modal owns edits) ──
const cardFormat = computed(() => formatFor(props.data.properties, box.value.w, box.value.h))
const cardGrid = computed(() => readLayoutGrid(props.data.properties, box.value.w, box.value.h, cardFormat.value))
const cardGridResolved = computed(() => resolveLayoutGrid(cardGrid.value, box.value.w, box.value.h, cardFormat.value))
const showGridOverlay = computed(() => editMode.value && cardGrid.value.show)
```

In the template, replace the old overlay SVG with `<LayoutGridOverlay v-if="showGridOverlay" :grid="cardGridResolved" :show="true" :moving="false" :covered="null" :w="box.w" :h="box.h" />`.

`box` here is the card's logical box, not the Frame's design size. The overlay scales by viewBox, so it looks the same, but a px-valued user grid resolved at the card size would be too big. Fix it by resolving at the design size: use `readFrameSize` from `~/lib/frame/frameSize`, as the modal does for `editorDims`, and fall back to `box` when there's no size. Do this rather than resolving at `box`.

- [ ] **Step 5: Typecheck, unit suite, then look at it**

Run: `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "CompositorModal|ArtifactFrameNode|LayoutGrid" | head -30`. Fix every error in these files. Then `npx vitest run`, comparing against the baseline.

Then check it in the browser pane on the existing `:3002` server (don't start one). Open `/dev/frame-lab`:
- The Layout grid section sits under Frame.
- Faint column lines show.
- Clicking a layer changes nothing on the grid.
- Dragging it fades modules in, fills the covered ones in blue, and snaps edges to column edges.
- ⌃G hides and shows the grid.
- ⌘Z undoes a column-count change.
- No red anywhere.

Take a screenshot as proof.

- [ ] **Step 6: Commit Tasks 4–6 together**

```bash
git add frontend/app/composables/useLocalLayerEditor.ts frontend/app/composables/useLayoutVary.ts \
  frontend/app/lib/agent/surfaces/compositor.ts frontend/tests/unit/agent-grid.unit.spec.ts \
  frontend/tests/unit/frame-layout-grid-editor.unit.spec.ts \
  frontend/app/components/vue-canvas/LayoutGridOverlay.vue frontend/app/components/vue-canvas/LayoutGridSection.vue \
  frontend/app/components/vue-canvas/CompositorModal.vue frontend/app/components/vue-canvas/ArtifactFrameNode.vue
git diff --cached --stat
git commit -m "feat(frame/grid): one standard layout grid in the editor — panel under Frame, quiet overlay, undo, ⌃G, resize snapping; section tools retired"
```

`CompositorModal.vue` is shared with other sessions. Before staging, run `git diff frontend/app/components/vue-canvas/CompositorModal.vue` and check that every hunk is yours. If another session has uncommitted hunks there, stage yours with a private index built from a patch of your hunks only; never `git add -p`, since interactive mode isn't available.

---

### Task 7: Browser proof (Playwright, real mouse)

**Files:**
- Create: `frontend/tests/frame-layout-grid.spec.ts`

- [ ] **Step 1: Write the e2e test**

```ts
// frontend/tests/frame-layout-grid.spec.ts — the Frame's layout grid, driven with the real mouse.
import { test, expect, type Page } from '@playwright/test'

const props = (page: Page) => page.evaluate(() => (window as any).__frameLab.node.data.properties)

test.describe('Frame layout grid', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
  })

  test('the section sits under Frame; the overlay shows column lines and no red', async ({ page }) => {
    await expect(page.getByText('Layout grid', { exact: true })).toBeVisible()
    const overlay = page.locator('[data-testid="compositor-grid-overlay"]')
    await expect(overlay).toBeVisible()
    const html = await overlay.innerHTML()
    expect(html).not.toMatch(/255,\s*72,\s*96|#ff3ea5|#22d3ee/i)
  })

  test('clicking a layer selects it without showing modules or recording a step', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__frameLab.editor?.historyRev?.() ?? null)
    const layer = page.locator('[data-testid="compositor-stack-canvas"]')
    const box = (await layer.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.locator('[data-testid="compositor-grid-modules"]')).not.toHaveClass(/\bon\b/)
    if (before != null) expect(await page.evaluate(() => (window as any).__frameLab.editor.historyRev())).toBe(before)
  })

  test('dragging fades the modules in and snaps an edge to a column edge', async ({ page }) => {
    const cv = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
    const sx = cv.x + cv.width / 2, sy = cv.y + cv.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx + 3, sy + 3, { steps: 2 })
    await page.mouse.move(sx + 37, sy + 21, { steps: 8 })
    await expect(page.locator('[data-testid="compositor-grid-modules"]')).toHaveClass(/\bon\b/)
    await page.mouse.up()
    const p = await props(page)
    const g = p.sailor_layoutGrid
    expect(g.v).toBe(2)
  })

  test('⌃G hides the grid and ⌘Z brings it back', async ({ page }) => {
    await page.keyboard.press('Control+g')
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toHaveCount(0)
    await page.keyboard.press('Meta+z')
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toBeVisible()
  })

  test('changing the column count is undoable', async ({ page }) => {
    const field = page.locator('[data-testid="grid-columns"] input, input[data-testid="grid-columns"]').first()
    await field.fill('6'); await field.press('Enter'); await field.blur()
    expect((await props(page)).sailor_layoutGrid.cols.count).toBe(6)
    await page.keyboard.press('Meta+z')
    expect((await props(page)).sailor_layoutGrid.cols.count).not.toBe(6)
  })
})
```

**Adapt it to the frame lab:**
- If `/dev/frame-lab` doesn't expose `__frameLab.editor`, the click test only checks the class; that's fine.
- If the lab's Frame has no layer under the canvas centre, pick a layer's position from `sailor_localLayers` (`x`/`y` are normalised centres) and click there instead.
- Assert the snap concretely: after the drag, read the moved layer's left edge, `(x − w/2) × designW` for a rect, and expect it within 0.5 px of one of `resolveLayoutGrid(...).xs`. Compute those in the page with `import('/_nuxt/app/lib/frame/layoutGrid.ts')` only if the lab already does dynamic imports; otherwise add `layoutGridResolved` to `__frameLab`.

- [ ] **Step 2: Run it against `:3002`**

Run: `cd frontend && npx playwright test tests/frame-layout-grid.spec.ts --reporter=line`
Expected: all PASS. If the server is broken (a 500, or an esbuild "service is no longer running"), stop and tell the owner. Don't start another server.

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/frame-layout-grid.spec.ts
git commit -m "test(frame/grid): real-mouse proof — quiet overlay, fade on move, ⌃G, undo"
```

Then update `docs/STATE.md` and the dashboard: stage 1 of the layout grid has landed, and stages 2–4 are owed.

---

## Stage 2 — Text snaps by its capitals and baselines (outline; expand before starting)

- **Task 8, `lib/frame/textMetrics.ts`.**
  - `textMetrics(layer: TextLayer, W: number): { capTop: number; baselines: number[]; lines: number }` gives offsets in design px from the text box's top.
  - It measures with the renderer's own `applyFont` and `wrappedTextLinesMeta` (`useCompositorLayers.ts` `drawText` ~5505–5570, where lines are drawn at the middle of each line slot), and the cap height from `measureText('H').actualBoundingBoxAscent`, as `kit/measure.ts` 106–125 does.
  - Cache by `fontFamily|fontWeight|fontSize|lineHeight|letterSpacing|boxW|text`.
  - Unit test against a known font from the lab fixtures: the first baseline minus the capital top equals the cap height, and consecutive baselines are exactly `fontSize·W·lineHeight` apart.
- **Task 9, text snapping in `applySnap`.**
  - For a text layer, the candidates are:
    1. capitals to the nearest row top (or `top`);
    2. the last baseline to the nearest row bottom (or `bottom`);
    3. otherwise, the first baseline to the nearest multiple of `unit`.
  - Boxes keep edge snapping.
  - **Fix:** use the displayed box (`y·H + textVAlignCenterOffset`), as the hit test does, in both `applySnap` and `resnapSelected`.
  - `resnapSelected` uses the same text rule.
  - Unit tests: move a `valign: 'top'` text layer near a row top and assert its capitals land exactly on it. Assert an off-row drop puts the first baseline on the unit.
- **Task 10, the overlay and Layer section.**
  - The selected text shows a dashed accent line at its capitals and a solid one at each baseline (`LayoutGridOverlay` gets an optional `text` prop).
  - The Layer section shows Column/Span and Row/Span (rows counted from the capitals for text). Typing moves or resizes the layer in one step.
  - The badge reads "4 × 3 modules" or "4 columns" while moving.
  - Playwright: drag text and see its capitals land on a row top.

## Stage 3 — The Layout tab on the visible grid (outline; expand before starting)

- **Task 11, `makeSheet` takes a `ResolvedLayoutGrid`.**
  - `NC`, `M`, `G` and `CW`, and `Xr(c)`, become the grid's own edges, converted to kit units (× 100 / frameW).
  - `plan.ts` reads the grid with `readLayoutGrid` instead of `readGrid` (line ~269) and resolves it.
  - Test: every `S.Xr(c)` equals `resolved.cols[c-1].a × 100 / W`.
- **Task 12, rows.**
  - With rows on, `L(r)` returns the nearest row top at or after `M + r·RH`, and bottom rules use row bottoms.
  - With rows off, positions round to the unit.
  - Covered-area formats compose on the rows; delete the shift-by-inset step in `runChoice` (~548–592).
- **Task 13, type from the Line.**
  - `INFO`: line spacing = Line, and the size is set so its capitals are one unit (`unit / capAbove(role)` in kit units).
  - `DISPLAY`: the fitted size is rounded to the nearest size whose capitals are a whole number of units, with line spacing a whole number of units.
  - `toOps.ts` places text so its capitals land on the chosen line.
  - Font, weight and colour are untouched (decided 2026-09-22).
- **Task 14, checker and sweep.**
  - Add "text on the baseline grid" and "capitals on a row top when rows are on" to the shared checker.
  - Run the full sweep (every layout × every format × 3 lengths × with/without a photo), outside `requestAnimationFrame`.
  - Fix any layout that fails.
- **Retire** `lib/frame/gridConfig.ts` once nothing reads it, and the deprecated `FrameGrid` alias once stage 4 lands.

## Stage 4 — Responsive Frames and the rest (outline; expand before starting)

- **Task 15, hold to spans.**
  - `responsive/fromNode.ts` reads `readLayoutGrid`.
  - `sectionsAt` and `sectionOf` are replaced by `spanOf(box, resolved)`, returning the first and last column and row, and `placeOnSpan(span, resolved)`.
  - `resolveLayout` places each unit on its span of the grid resolved at the viewing size with `scale = s`.
  - `holdTo: 'section'` reads as `'grid'`.
  - Update `responsive-*.unit.spec.ts`.
- **Task 16, the scaled overlay.** At a viewing size, the modal passes `resolveLayoutGrid(layoutGrid, viewW, viewH, fmt, s)` to the overlay, so it matches the resolver.
- **Task 17, clean-up.**
  - Delete `lib/frame/patterns/frameContext.ts` if only its own test uses it; otherwise move it to the new grid.
  - Delete `gridConfig.ts` and the `FrameGrid` alias.
  - Delete `frame-grid.unit.spec.ts`, `frame-grid-config.unit.spec.ts` and `frame-grid-backcompat.unit.spec.ts`, moving any still-true cases into the Mosaic or layout-grid specs.

## Self-review notes

- **Spec coverage, stage 1:**

  | Spec item | Task |
  |---|---|
  | Stored shape, `auto` | 2 |
  | Suggested grid | 1–2 |
  | Resolver | 2 |
  | Migration | 2 |
  | Old Frames hidden | 2 and 4 (`ensureLayoutGrid`) |
  | Panel | 6 |
  | Overlay colours, rest/fade, 4 px threshold | 4, 6 |
  | Shortcut | 6 |
  | Undo | 4 |
  | Box snapping on move and resize | 4 |
  | Re-snap | 4 and 6 |
  | "col" unit | 6 |
  | Agent | 5 |
  | Mosaic split | 3 |
  | Removals | 4 and 6 |
  | Card overlay | 6 |

  Stages 2–4 are covered by the outlines.
- **Deviations from the spec, both deliberate:**
  - The agent moved from stage 4 to stage 1, because its state feeds the editor directly.
  - Responsive and the kit keep the old reader until stages 3–4.
- **Names used across tasks:** `LayoutGrid`, `ResolvedLayoutGrid`, `readLayoutGrid`, `resolveLayoutGrid`, `patchLayoutGrid`, `suggestedLayoutGrid`, `layoutGridProperty`, `describeLayoutGrid`, `kitBasics`, `formatSheetOpts`, `MosaicGrid`, and on the editor `layoutGrid`, `layoutGridResolved`, `setLayoutGrid`, `ensureLayoutGrid`, `dragMoving`, `gridSnapLines`. These match everywhere they are used.
