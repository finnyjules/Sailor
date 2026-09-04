# Frame Grid & Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Frame a modular grid — explicit or generated within constraints — that layers snap to, so sections (grid-snapped layers) can be drawn and filled, turning the Frame into a Swiss layout substrate.

**Architecture:** A pure grid engine (`lib/frame/grid.ts`) resolves a `FrameGrid` config to guide lines and regions. The existing pure snap function (`computeSnapAdjust`) gains grid lines as snap targets. The grid config lives on the frame node's properties (`sailor_localGrid`), an editor-only overlay draws the lines, and a new inspector panel drives it. Sections are ordinary `LocalLayer`s — nothing new renders; the existing `paintLayerStack`/`resolvePaint` handle them.

**Tech Stack:** TypeScript, Vue 3 (Nuxt), vitest for the pure modules, the Compositor/Frame Vue components.

## Global Constraints

- **Sections are not a new type.** Slice 1 adds NO field to `LocalLayer`. A section is a `LocalLayer` whose box happens to align to the grid. No `gridSpan`.
- **The grid is editor-only.** The overlay draws lines/regions only in edit mode. It MUST NOT appear in a bake, export, or embed render. `paintLayerStack` is not touched.
- **Backward compatible.** A frame with no `sailor_localGrid` loads as `{ mode: 'off' }` and renders byte-identically to before.
- **No auto-reflow.** When the grid changes, sections keep their pixel boxes. A per-section "re-snap to grid" action realigns on demand.
- **Capped auto-convert.** "Fill grid with sections" stamps one empty rect per region and refuses above 24 regions.
- **The dealer is deterministic in `gen.seed`.** Same seed → identical grid.
- **Normalized coordinates.** Grid config and layer boxes are in 0..1 of the frame (the Frame's existing convention). `baseModule`, `gutter`, `margin` are normalized to frame width.
- **Commit hygiene:** stage only the files each task names, never `git add -A`, never stash. Commit on `main`. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **The spec is the source of truth:** `docs/superpowers/specs/2026-09-04-frame-grid-sections-design.md`.

## File Structure

- `frontend/app/lib/frame/grid.ts` (new) — `FrameGrid` type, `defaultGrid()`, `resolveGrid(grid, w, h)`, the seeded dealer. Pure.
- `frontend/tests/unit/frame-grid.unit.spec.ts` (new) — engine tests.
- `frontend/app/lib/compositor/layerEdits.ts` (modify) — `computeSnapAdjust` gains grid-line targets.
- `frontend/tests/unit/compositor-snap.unit.spec.ts` (new or existing) — snap tests.
- `frontend/app/lib/frame/gridConfig.ts` (new) — `readGrid(node)` / `writeGrid(node, grid)` + defaulting.
- `frontend/app/composables/useLocalLayerEditor.ts` (modify) — pass grid lines into the snap call; grid-draw + re-snap helpers.
- `frontend/app/components/vue-canvas/CompositorModal.vue` (modify) — grid inspector panel; overlay; auto-convert.
- `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (modify) — overlay on the card in edit mode only.
- `frontend/app/lib/agent/...` (modify) — grid config agent ops.

---

### Task 1: Grid engine — explicit mode (pure)

**Files:**
- Create: `frontend/app/lib/frame/grid.ts`
- Test: `frontend/tests/unit/frame-grid.unit.spec.ts`

**Interfaces:**
- Produces: `FrameGrid` (the spec's shape), `defaultGrid(): FrameGrid`, `resolveGrid(grid: FrameGrid, w: number, h: number): { xs: number[]; ys: number[]; regions: Rect[] }` where `xs`/`ys` are pixel edge positions and `regions` are `{x,y,w,h}` pixel rects. This task implements `mode: 'off'` (empty) and `mode: 'explicit'` only; generated is Task 2.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { defaultGrid, resolveGrid } from '~/lib/frame/grid'

describe('resolveGrid explicit', () => {
  it('off mode yields no lines or regions', () => {
    const g = { ...defaultGrid(), mode: 'off' as const }
    expect(resolveGrid(g, 1200, 800)).toEqual({ xs: [], ys: [], regions: [] })
  })
  it('explicit: equal columns/rows inside the margins, edges monotonic', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 4, rows: 2, margin: 0, gutter: 0 }
    const { xs, ys, regions } = resolveGrid(g, 1200, 800)
    expect(xs).toEqual([0, 300, 600, 900, 1200])       // 4 equal columns of 300
    expect(ys).toEqual([0, 400, 800])                  // 2 equal rows of 400
    expect(regions).toHaveLength(8)                     // no merge → one region per cell
    expect(regions[0]).toEqual({ x: 0, y: 0, w: 300, h: 400 })
  })
  it('margins inset the grid from the frame edges', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0.1, gutter: 0 }
    const { xs } = resolveGrid(g, 1000, 1000)
    expect(xs[0]).toBe(100)                             // left margin 0.1 * 1000
    expect(xs[xs.length - 1]).toBe(900)                // right margin
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-grid.unit.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement grid.ts (off + explicit)**

```ts
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

export function resolveGrid(grid: FrameGrid, w: number, h: number): { xs: number[]; ys: number[]; regions: Rect[] } {
  if (grid.mode === 'off') return { xs: [], ys: [], regions: [] }
  const mx = grid.margin * w, my = grid.margin * w   // margin normalized to width on both axes (uniform inset)
  if (grid.mode === 'explicit') {
    const xs = evenEdges(mx, w - mx, Math.max(1, Math.round(grid.columns)))
    const ys = evenEdges(my, h - my, Math.max(1, Math.round(grid.rows)))
    return { xs, ys, regions: cellRegions(xs, ys) }
  }
  return { xs: [], ys: [], regions: [] }   // generated: Task 2
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-grid.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/lib/frame/grid.ts frontend/tests/unit/frame-grid.unit.spec.ts && git commit -m "feat(frame): grid engine — off + explicit modes (pure)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Grid engine — generated dealer, regularity dial, merge, symmetry

**Files:**
- Modify: `frontend/app/lib/frame/grid.ts`
- Test: `frontend/tests/unit/frame-grid.unit.spec.ts`

**Interfaces:**
- Consumes: Task 1's `resolveGrid` shell and `cellRegions`.
- Produces: `resolveGrid` for `mode: 'generated'` — seeded counts, edges by the regularity dial, merged units, optional mirror.

- [ ] **Step 1: Write the failing tests**

```ts
import { resolveGrid, defaultGrid, type FrameGrid } from '~/lib/frame/grid'

function gen(over: Partial<FrameGrid['gen']> = {}): FrameGrid {
  return { ...defaultGrid(), mode: 'generated', margin: 0, gutter: 0, gen: { ...defaultGrid().gen, ...over } }
}

describe('resolveGrid generated', () => {
  it('is deterministic in the seed', () => {
    const a = resolveGrid(gen({ seed: 7 }), 1200, 800)
    const b = resolveGrid(gen({ seed: 7 }), 1200, 800)
    const c = resolveGrid(gen({ seed: 8 }), 1200, 800)
    expect(a).toEqual(b)
    expect(a.xs).not.toEqual(c.xs)
  })
  it('column/row counts land in range', () => {
    for (let s = 1; s < 30; s++) {
      const { xs, ys } = resolveGrid(gen({ seed: s, colRange: [3, 5], rowRange: [2, 4], merge: false }), 1000, 1000)
      expect(xs.length - 1).toBeGreaterThanOrEqual(3)
      expect(xs.length - 1).toBeLessThanOrEqual(5)
      expect(ys.length - 1).toBeGreaterThanOrEqual(2)
      expect(ys.length - 1).toBeLessThanOrEqual(4)
    }
  })
  it('regularity 1 gives equal, module-aligned columns', () => {
    const { xs } = resolveGrid(gen({ seed: 3, regularity: 1, colRange: [4, 4], merge: false }), 1200, 800)
    const widths = xs.slice(1).map((x, i) => x - xs[i]!)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1) // equal within rounding
  })
  it('regularity 0 varies column widths', () => {
    const { xs } = resolveGrid(gen({ seed: 3, regularity: 0, colRange: [5, 5], merge: false }), 1200, 800)
    const widths = xs.slice(1).map((x, i) => x - xs[i]!)
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(20) // genuinely uneven
  })
  it('merged units are rectangular, within mergeMaxSpan, non-overlapping, and cover only real cells', () => {
    const { regions, xs, ys } = resolveGrid(gen({ seed: 5, merge: true, mergeMaxSpan: 3 }), 1200, 800)
    const cols = xs.length - 1, rows = ys.length - 1
    let area = 0
    for (const r of regions) {
      const cw = (xs[1]! - xs[0]!)
      expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0)
      area += r.w * r.h
    }
    // regions tile the grid area exactly (no overlap, full cover)
    const gridArea = (xs[cols]! - xs[0]!) * (ys[rows]! - ys[0]!)
    expect(Math.abs(area - gridArea)).toBeLessThan(2)
  })
  it('mirror symmetry makes the column plan palindromic in widths', () => {
    const { xs } = resolveGrid(gen({ seed: 9, regularity: 0, symmetry: 'mirror', colRange: [6, 6], merge: false }), 1200, 800)
    const w = xs.slice(1).map((x, i) => x - xs[i]!)
    expect(w).toEqual([...w].reverse().map((v, i) => v)) // symmetric widths (allow ±1 in impl if needed)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/frame-grid.unit.spec.ts`
Expected: FAIL on the generated cases (regions empty).

- [ ] **Step 3: Implement the dealer**

Add to `grid.ts`: a small seeded RNG (mulberry32 on `gen.seed`), then in `resolveGrid`'s generated branch:
1. Pick `cols`/`rows` from the ranges (seeded).
2. Per axis, produce edges: draw `n` weights each `1 + (rng()*2 - 1) * (1 - regularity) * 0.85` (Pane's variance form), normalize to sum 1, cumulative-sum to positions in `[start, end]`, then blend each interior position toward its equal-division position by `regularity` and snap toward the nearest `baseModule` multiple by `regularity`. Round to whole pixels.
3. If `symmetry === 'mirror'`: build the left half's weights and mirror them (handle odd counts by a centre column), so widths are palindromic.
4. Regions: if `!merge`, `cellRegions`. If `merge`, walk the cell grid in seeded order, and for each unclaimed cell grow a rectangular unit up to `mergeMaxSpan × mergeMaxSpan` over still-unclaimed cells (seeded span), mark claimed, emit its bounding rect. Every cell ends in exactly one unit → non-overlapping, full cover.

Keep it pure and deterministic. (Exact code left to the implementer; the tests above pin every property — determinism, ranges, the regularity extremes, merge tiling, mirror.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-grid.unit.spec.ts`
Expected: PASS. If the mirror test is off by a pixel from rounding, adjust the test's tolerance to `±1`, not the symmetry logic.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/lib/frame/grid.ts frontend/tests/unit/frame-grid.unit.spec.ts && git commit -m "feat(frame): grid engine — seeded generated dealer, regularity dial, merge, mirror

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Grid lines as snap targets

**Files:**
- Modify: `frontend/app/lib/compositor/layerEdits.ts` (`computeSnapAdjust`)
- Test: `frontend/tests/unit/compositor-snap.unit.spec.ts` (create if absent)

**Interfaces:**
- Consumes: existing `computeSnapAdjust(prim, others, thresholdX, thresholdY, canvasTargets)`.
- Produces: two optional trailing params `gridX: number[] = []`, `gridY: number[] = []` (normalized), added to the x/y target pools. Backward compatible — existing callers pass nothing and behave identically.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { computeSnapAdjust } from '~/lib/compositor/layerEdits'

const box = { cx: 0.31, cy: 0.5, hx: 0.1, hy: 0.1 }  // left edge at 0.21

describe('computeSnapAdjust grid targets', () => {
  it('snaps a box edge to a nearby grid line', () => {
    const r = computeSnapAdjust(box, [], 0.02, 0.02, [], [0.2, 0.4, 0.6], [])
    expect(r.guideX).toBe(0.2)              // left edge 0.21 snaps to 0.2
    expect(r.dx).toBeCloseTo(-0.01, 5)
  })
  it('ignores grid lines beyond the threshold', () => {
    const r = computeSnapAdjust(box, [], 0.005, 0.005, [], [0.2], [])
    expect(r.guideX).toBeNull()
  })
  it('no grid args → unchanged behaviour', () => {
    const r = computeSnapAdjust(box, [], 0.02, 0.02)
    expect(r.guideX).toBeNull()             // canvasTargets default [0,0.5,1], none within 0.02 of edges
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/compositor-snap.unit.spec.ts`
Expected: FAIL (`computeSnapAdjust` takes 5 args).

- [ ] **Step 3: Add gridX/gridY**

In `computeSnapAdjust`, add params `gridX: number[] = [], gridY: number[] = []` and after the `others` loop, `xt.push(...gridX); yt.push(...gridY)`. Nothing else changes.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/compositor-snap.unit.spec.ts` — PASS.
Also run any existing layerEdits test to confirm no regression: `npx vitest run tests/unit -t "snap"` (or the file that imports `computeSnapAdjust`).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/lib/compositor/layerEdits.ts frontend/tests/unit/compositor-snap.unit.spec.ts && git commit -m "feat(frame): computeSnapAdjust accepts grid-line snap targets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Grid config on the frame node + defaulting

**Files:**
- Create: `frontend/app/lib/frame/gridConfig.ts`
- Test: `frontend/tests/unit/frame-grid-config.unit.spec.ts`

**Interfaces:**
- Produces: `readGrid(props: Record<string, unknown> | undefined): FrameGrid` — reads `props.sailor_localGrid`, deep-defaults any missing key from `defaultGrid()` (mirroring the shaderstudio `deepMerge` pattern), returns `{mode:'off'}`-based default when absent. `gridProperty(grid): { sailor_localGrid: FrameGrid }` for writes.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readGrid } from '~/lib/frame/gridConfig'
import { defaultGrid } from '~/lib/frame/grid'

describe('readGrid', () => {
  it('absent → default (off)', () => {
    expect(readGrid(undefined).mode).toBe('off')
    expect(readGrid({}).mode).toBe('off')
  })
  it('fills missing keys from the default', () => {
    const g = readGrid({ sailor_localGrid: { mode: 'explicit', columns: 8 } })
    expect(g.mode).toBe('explicit')
    expect(g.columns).toBe(8)
    expect(g.gen.regularity).toBe(defaultGrid().gen.regularity)  // filled
    expect(g.baseModule).toBe(defaultGrid().baseModule)
  })
})
```

- [ ] **Step 2: Run to fail.** `cd frontend && npx vitest run tests/unit/frame-grid-config.unit.spec.ts`

- [ ] **Step 3: Implement `gridConfig.ts`** with a small recursive `deepMerge(defaultGrid(), raw)` (copy the pattern from `app/lib/shaderstudio/types.ts`'s `deepMerge`), guarding non-objects.

- [ ] **Step 4: Run to pass.**

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/lib/frame/gridConfig.ts frontend/tests/unit/frame-grid-config.unit.spec.ts && git commit -m "feat(frame): read/default the sailor_localGrid frame property

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Grid overlay in the editor (never in bake)

**Files:**
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue`, `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: `readGrid(node.data.properties)`, `resolveGrid(grid, W, H)`, `grid.overlay`.
- Produces: an SVG overlay (column/row lines + region outlines) drawn ONLY when the frame is in edit mode and `grid.mode !== 'off'` and `grid.overlay`. Absent from the stack-canvas bake and any embed/export path.

- [ ] **Step 1: Add the overlay.** In the Frame card's edit-mode template layer (the same place the edit chrome lives, above the `stackCanvas`), add an absolutely-positioned SVG sized to the box. Compute `resolveGrid(readGrid(props), box.w, box.h)` in a computed; draw `<line>` per `xs`/`ys` at 1px hairline (use `var(--hair)`-equivalent, low opacity) and a faint `<rect>` per region. Gate the whole SVG on `editMode && grid.mode !== 'off' && grid.overlay`.

- [ ] **Step 2: Verify it is edit-only.** In the browser (dev server + ComfyUI running, `127.0.0.1`): add a Compositor, set the grid to explicit 6×4 (temporarily via the node property or a quick console `dispatch`), open Edit — overlay shows. Trigger a Render/bake (or screenshot the card when not in edit mode) — overlay absent. Confirm `paintLayerStack` was not modified (`git diff` shows no change to it).

- [ ] **Step 3: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/components/vue-canvas/ArtifactFrameNode.vue frontend/app/components/vue-canvas/CompositorModal.vue && git commit -m "feat(frame): editor-only grid overlay (lines + regions), never baked

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Grid inspector panel + snap wiring

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`, `frontend/app/composables/useLocalLayerEditor.ts`

**Interfaces:**
- Consumes: `readGrid`/`gridProperty`, `resolveGrid`, the extended `computeSnapAdjust`.
- Produces: a Grid inspector section and live snapping of drag/resize to the grid.

- [ ] **Step 1: Build the inspector panel** (use the project's own `StudioButton`, `StudioSegmented`, `StudioRow`/slider, number field — never hand-rolled controls). A top-level "Grid" section in the Compositor's panel with: mode segmented (Off / Explicit / Generated); Explicit → Columns, Rows, Gutter, Margin; Generated → Columns range, Rows range, Regularity slider (0..1), Merge switch, Max span, Symmetry segmented, Seed number + a "New variation" `StudioButton` (`gen.seed = Math.floor(Math.random()*9999)+1`); Overlay switch. Writes go to `node.data.properties.sailor_localGrid` via `gridProperty`. Bump nothing — absent-key defaulting (Task 4) covers old frames.

- [ ] **Step 2: Wire snapping.** In `useLocalLayerEditor.ts`'s move/resize path where it calls `computeSnapAdjust(...)`, when `grid.mode !== 'off'` pass the grid's normalized line positions as `gridX = xs.map(x => x / W)`, `gridY = ys.map(y => y / H)`. The grid comes from `readGrid(node().data.properties)` + `resolveGrid`, memoized per grid-config change. The existing `snapGuides` render shows the guide line unchanged.

- [ ] **Step 3: Browser verify.** Dev server up. Set Generated grid, drag a rect layer — edges snap to grid lines, the guide shows, the New-variation button re-rolls the overlay, the regularity slider visibly moves from equal to uneven. Typecheck: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -c "CompositorModal.vue\|useLocalLayerEditor.ts"` → 0 new.

- [ ] **Step 4: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/components/vue-canvas/CompositorModal.vue frontend/app/composables/useLocalLayerEditor.ts && git commit -m "feat(frame): grid inspector (explicit/generated + regularity + seed) and drag/resize snapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Draw-from-grid, capped auto-convert, and re-snap

**Files:**
- Modify: `frontend/app/composables/useLocalLayerEditor.ts`, `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: `resolveGrid` regions, the layer-add path the toolbar already uses to create a `rect`.
- Produces: (a) a grid-draw interaction, (b) a capped "Fill grid with sections" action, (c) a per-section "Re-snap to grid" action.

- [ ] **Step 1: Fill grid with sections (capped).** A `StudioButton` in the Grid panel: `const { regions } = resolveGrid(grid, W, H); if (regions.length > 24) { toast('Too many regions for sections — use a coarser grid (the dense deal is a later feature)'); return }` else for each region create an empty `rect` layer at that normalized box (reuse the existing rect-add helper), selected as a group.

- [ ] **Step 2: Re-snap action.** A per-layer action (context menu or inspector row) that snaps the selected layer's box edges to the nearest grid lines via one `computeSnapAdjust` call with a large threshold, applied once.

- [ ] **Step 3: Grid-draw mode.** A Grid-panel toggle "Draw section": while on, a pointer drag on the artboard creates a `rect` layer whose box is the drag rectangle snapped to the enclosing grid lines (snap both corners to nearest lines). Reuse `startMarquee`/`moveMarquee` geometry but, on up, CREATE a rect instead of selecting. Keep it a separate handler from the selection marquee so selection is unaffected when the mode is off.

- [ ] **Step 4: Browser verify.** Coarse grid (say 4×3) → Fill grid stamps 12 sections; fine grid (12×8=96) → refuses with the toast. Draw-section makes a snapped rect. Move a rect off the lines, Re-snap realigns it. Fill one section with a gradient and one with a shader (both via the existing fill picker) — they render.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/composables/useLocalLayerEditor.ts frontend/app/components/vue-canvas/CompositorModal.vue && git commit -m "feat(frame): draw-from-grid, capped fill-grid-with-sections, per-section re-snap

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Agent can set and generate the grid

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts` (the Compositor agent op surface), and the capability/verify wiring if needed.
- Test: an agent-op unit test alongside the existing compositor-op tests if one exists.

**Interfaces:**
- Produces: a `setGrid` op on the Compositor surface: `args: { patch: Partial<FrameGrid>, generate?: boolean }` — merges the patch into `sailor_localGrid`; `generate: true` (or a `reroll: true`) sets a fresh `gen.seed`. Hint text: "Set the layout grid… mode explicit|generated, columns, rows, regularity 0..1, or generate a new variation."

- [ ] **Step 1: Add the op + hint** following the exact shape of a neighbouring op in `compositor.ts` (e.g. `setLayerTornEdge`'s `{ op, hint }` entry and its handler). Merge via `gridProperty`/`readGrid`.

- [ ] **Step 2: Verify.** Unit test (if the surface has an op-dispatch test): dispatching `setGrid { patch: { mode: 'generated', gen: { colRange: [4,4] } }, generate: true }` writes `sailor_localGrid` with mode generated and a seed in 1..9999. Typecheck clean for the touched file.

- [ ] **Step 3: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/lib/agent/surfaces/compositor.ts && git commit -m "feat(frame-agent): setGrid op — the agent sets and re-rolls the layout grid

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Backward-compat proof + whole-slice browser pass

**Files:**
- Create: `frontend/tests/frame-grid.spec.ts` (Playwright) OR a unit assertion, plus a manual browser pass.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Backward-compat unit assertion.** A test that a frame-node props object WITHOUT `sailor_localGrid` yields `readGrid(props).mode === 'off'`, and that `resolveGrid` for an off grid is empty (already covered in Task 1 — here assert the integration: an off grid contributes no snap targets, so `gridX`/`gridY` are empty). Keep it small.

- [ ] **Step 2: Manual browser pass** (dev server + ComfyUI on `127.0.0.1`), confirming end to end: overlay shows in edit only and is absent from a bake; explicit and generated modes both draw; regularity slider spans equal→uneven; New-variation re-rolls; drag/resize snap; draw-section; fill-grid caps at 24; re-snap realigns; a gradient section and a shader section both render; an existing pre-grid frame opens unchanged. Screenshot the composed result and send it to the user.

- [ ] **Step 3: Commit any test file added.**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/tests/frame-grid.spec.ts && git commit -m "test(frame): grid off by default leaves the frame unchanged; whole-slice browser pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** grid config (Task 4) ✓; explicit + generated engine with regularity/merge/mirror (Tasks 1–2) ✓; snap targets (Task 3) ✓; overlay editor-only (Task 5) ✓; inspector + snapping (Task 6) ✓; draw/auto-convert-capped/re-snap (Task 7) ✓; agent (Task 8) ✓; backward-compat + bake-exclusion (Tasks 5, 9) ✓. Deferred items (baseline, nesting, dense deal, templates, Smart Layout, reflow, `gridSpan`) are explicitly out.
- **Names consistent:** `FrameGrid`, `defaultGrid`, `resolveGrid`, `readGrid`, `gridProperty`, `computeSnapAdjust(..., gridX, gridY)`, `sailor_localGrid` are used identically across tasks.
- **No placeholders:** the two pure modules carry real code + pinning tests; the Vue tasks name exact files, insertion points, existing components to reuse (StudioButton etc.), and browser verifications, since Vue UI is followed from the codebase's patterns rather than transcribed.
