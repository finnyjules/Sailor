# Shared pen — Plan A: the pen itself

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the arc pen out of `/dev/sketch-draw` into a shared `usePen` + `PenOverlay` + `PenToolbar` that any tool can host through one affine view matrix, and bring back the Bézier **Curve** tool — with the test page rehosted on it and its 39 browser tests still green.

**Architecture:** `lib/sketch/` (maths, unchanged) ← `composables/pen/usePen.ts` (all drawing state and actions, in drawing units, tolerances given in screen pixels) ← `components/pen/PenOverlay.vue` (renders + pointer/keys over the host canvas, driven by a drawing→screen matrix) and `components/pen/PenToolbar.vue` (tools + rules, placed by the host). The dev page becomes a host that owns only its view (pan/zoom, y-up) and the `window.__sketchDraw` test API.

**Tech Stack:** Vue 3.5 (`<script setup>`), TypeScript, Vitest (`npm run test:unit` in `frontend/`), Playwright (`npx playwright test tests/sketch-draw.spec.ts` in `frontend/`, against the dev server already running on `:3002`).

**Spec:** `docs/superpowers/specs/2026-09-24-shared-pen-design.md` (sections 1, 2, 2b, 5 stages 1–2). Plan B (Frame) and Plan C (Shape Studio) follow.

## Global Constraints

- Work in the main checkout; no worktree, no branch (`CLAUDE.md`).
- **Every commit uses a private index** — never `cp .git/index`, never a bare `git commit` after `git add`:
  ```
  export GIT_INDEX_FILE=$(mktemp /private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/08811ebc-286d-4206-85f0-f2d098f0c5a5/scratchpad/pen-idx.XXXX)
  git read-tree HEAD
  git add <only your exact paths>
  git diff --cached --stat        # confirm ONLY your files
  git commit -m "..."
  ```
  then, in a **separate** shell call (so `GIT_INDEX_FILE` is unset): `git reset -q -- <your paths>`.
- **Never run `npm run dev`** or restart the dev server (it can take ComfyUI down). Use the server on `:3002`; if it is broken, stop and report.
- **Run Playwright in the foreground**, never backgrounded. A red-first mutation must be reverted before commit — grep the diff for it.
- **Never trust simulated pointer events for gestures.** API hooks prove maths; any gesture claim needs real mouse clicks in the browser pane (`mcp__Claude_Browser__computer` `left_click` / `left_click_drag` by coordinate).
- UI copy: sentence case, no identifiers, no internal names in labels or tooltips.
- Buttons use `components/vue-canvas/studio/StudioButton.vue`; extend it, never fork. Action blue is the only button accent.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Behaviour at the dev page's default zoom must be byte-identical** through Tasks 2–5: the existing 39 tests in `tests/sketch-draw.spec.ts` are the contract and must pass unchanged (same `__sketchDraw` API, same `data-tool` / `data-verb` / `data-act` attributes).

## Facts verified at HEAD (do not re-derive; do not "fix")

- `lib/sketch/solve.ts` **already** breaks on the hard residual and restores on a failed `n === 0` solve. Spec stage 0 is done — no task.
- The dev page draws world→screen with `sx/sy` at `scale` 34 px/unit, y-up, and flips arc `sweep` in `toShadowEntities` (`sketch-draw.vue:1124`) because its view is mirrored. The shadow-doc trick only works for similarity transforms.
- World-unit thresholds in the page / lib: snap `tol` default **0.6** (`infer.ts:28,77`), bow threshold **0.15** (`sketch-draw.vue:915`), min circle radius **0.2** (`sketch-draw.vue:728`). At 34 px/unit these are **20.4 px, 5.1 px, 6.8 px**.
- `lib/sketch/edit.ts` still exports `addSmoothHandles` and `setAnchorSmooth`; `sketchPath` still renders `cubic` as `C`. The retired Bézier tool is in git at `78788db4a^:frontend/app/pages/dev/sketch-draw.vue` (functions `penDown/penMove/penUp`, `visibleHandleIds`, `handleArms`, `previewDragHandles`), and its tests at `78788db4a^:frontend/tests/sketch-draw.spec.ts`.
- Opacity (the reference) puts rule actions in a **right-click menu**; the test page uses a **bar**. Task 1 decides which.

## File map

| File | Responsibility |
|---|---|
| `app/lib/sketch/view.ts` (new) | Affine view matrix type + apply / invert / pixels-per-unit / mirrored. Pure. |
| `app/lib/sketch/tolerance.ts` (new) | Screen-pixel tolerances and their conversion to drawing units. Pure. |
| `app/composables/pen/usePen.ts` (new) | The pen: state, history, selection, tools, path/arc/curve drawing, rules, repeat/mirror, dimensions. No DOM. |
| `app/composables/pen/penRules.ts` (new) | `availableConstraints` and ref ordering — the selection → rules logic, split out so the toolbar and tests read one list. |
| `app/components/pen/PenOverlay.vue` (new) | SVG over the host canvas: outline in drawing space under a matrix, points/badges/chips/previews in screen space; pointer + keyboard. |
| `app/components/pen/PenToolbar.vue` (new) | Tool row + rules (bar or menu, per Task 1) + hint line. |
| `app/pages/dev/sketch-draw.vue` (shrinks) | Host: y-up view, pan/zoom, `__sketchDraw` API, Copy SVG. |
| `tests/unit/sketch-view.unit.spec.ts`, `tests/unit/sketch-tolerance.unit.spec.ts`, `tests/unit/pen-rules.unit.spec.ts`, `tests/unit/pen-curve.unit.spec.ts` (new) | Unit tests. |
| `tests/sketch-draw.spec.ts` | Unchanged through Task 5; Task 6 restores the Curve tests. |

---

### Task 1: Pen toolbar prototype (review gate)

**Files:**
- Create: `/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/08811ebc-286d-4206-85f0-f2d098f0c5a5/scratchpad/pen-toolbar-prototype.html` (published as an Artifact; not committed)

**Interfaces:**
- Produces: the approved toolbar layout (recorded as a short "Toolbar decision" note appended to the spec's section 2, committed), which Task 5 builds.

- [ ] **Step 1:** Build a single-file clickable prototype in the Frame editor's dark chrome (`#1a1a1a` bars, `#2a2a2a` borders, `white/80` icons, white-on-dark active tool, action-blue primary). A mock canvas holds a small drawing: two lines, an arc joined tangent, a circle, a Bézier curve with handles, and a few points. Clicking an item selects it (Shift adds); the rules offered follow the real `availableConstraints()` rules at `sketch-draw.vue:309-360` (1 line → Horizontal/Vertical; 2 circles → Concentric/Tangent/Equal; line + circle → Tangent; point + line → Point on line/Midpoint; 2 points → Coincident/Distance…; 1 circle → Radius…; 2 lines → Perpendicular/Parallel/Equal; path corner → Right angle; a Curve segment hides Tangent/Radius/Concentric), plus Fix / Repeat… / Mirror / Flip horizontal / Flip vertical / Make guide / Delete.
- [ ] **Step 2:** Offer three switchable layouts on the same canvas:
  - **A — two rows at the bottom:** tool row, with a rules row above it when something is selected.
  - **B — tool row at the bottom + a floating rules pill next to the selection** (follows the selection).
  - **C — tool row at the bottom + right-click menu** grouped Rules / Copies / Tidy, like Opacity.
  Every layout shows the hint line and the Guide / Labels toggles, Undo / Redo, Cancel / Done.
- [ ] **Step 3:** Verify it yourself in the browser pane (serve the file locally, click every tool, select each item kind, switch layouts, check no control is clipped at 800 px width). Then publish with the Artifact tool and send the link.
- [ ] **Step 4:** **STOP for the user's pick.** Record the decision as a "Toolbar decision" paragraph at the end of spec section 2 and commit that doc change (private index).

---

### Task 2: View matrix and screen-pixel tolerances

**Files:**
- Create: `app/lib/sketch/view.ts`, `app/lib/sketch/tolerance.ts`
- Test: `tests/unit/sketch-view.unit.spec.ts`, `tests/unit/sketch-tolerance.unit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // view.ts — drawing → screen, SVG/DOMMatrix order: x' = a·x + c·y + e, y' = b·x + d·y + f
  export interface ViewMatrix { a: number; b: number; c: number; d: number; e: number; f: number }
  export function applyView(m: ViewMatrix, p: Vec2): Vec2
  export function invertView(m: ViewMatrix): ViewMatrix | null   // null when singular
  export function pxPerUnit(m: ViewMatrix): number               // sqrt(|det|)
  export function isMirrored(m: ViewMatrix): boolean             // det < 0
  export function viewToSvg(m: ViewMatrix): string               // "matrix(a b c d e f)"
  // tolerance.ts
  export const SNAP_PX = 20.4, BOW_PX = 5.1, MIN_RADIUS_PX = 6.8
  export function pxToUnits(px: number, m: ViewMatrix): number   // px / pxPerUnit(m)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/sketch-view.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { applyView, invertView, pxPerUnit, isMirrored, viewToSvg } from '~/lib/sketch/view'

// the dev page's y-up view at default zoom: sx = 40 + 34x, sy = 400 − 34y
const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

describe('view matrix', () => {
  it('maps like the dev page sx/sy', () => {
    expect(applyView(DEV, { x: 1, y: 2 })).toEqual({ x: 74, y: 332 })
  })
  it('inverts back to the drawing point', () => {
    const inv = invertView(DEV)!
    const p = applyView(inv, applyView(DEV, { x: 3.5, y: -1.25 }))
    expect(p.x).toBeCloseTo(3.5, 12); expect(p.y).toBeCloseTo(-1.25, 12)
  })
  it('reports scale and mirroring', () => {
    expect(pxPerUnit(DEV)).toBeCloseTo(34, 12)
    expect(isMirrored(DEV)).toBe(true)
    const rot = { a: Math.cos(0.5) * 2, b: Math.sin(0.5) * 2, c: -Math.sin(0.5) * 2, d: Math.cos(0.5) * 2, e: 0, f: 0 }
    expect(pxPerUnit(rot)).toBeCloseTo(2, 12)
    expect(isMirrored(rot)).toBe(false)
  })
  it('returns null for a singular matrix', () => {
    expect(invertView({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBeNull()
  })
  it('serialises for an SVG transform', () => {
    expect(viewToSvg(DEV)).toBe('matrix(34 0 0 -34 40 400)')
  })
})
```

```ts
// tests/unit/sketch-tolerance.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { SNAP_PX, BOW_PX, MIN_RADIUS_PX, pxToUnits } from '~/lib/sketch/tolerance'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

describe('screen-pixel tolerances', () => {
  it('equal today\'s world-unit values at the dev page default zoom', () => {
    expect(pxToUnits(SNAP_PX, DEV)).toBeCloseTo(0.6, 12)
    expect(pxToUnits(BOW_PX, DEV)).toBeCloseTo(0.15, 12)
    expect(pxToUnits(MIN_RADIUS_PX, DEV)).toBeCloseTo(0.2, 12)
  })
  it('shrink in drawing units when zoomed in', () => {
    const zoomed = { ...DEV, a: 340, d: -340 }
    expect(pxToUnits(SNAP_PX, zoomed)).toBeCloseTo(0.06, 12)
  })
})
```

- [ ] **Step 2:** Run `npx vitest run tests/unit/sketch-view.unit.spec.ts tests/unit/sketch-tolerance.unit.spec.ts` in `frontend/`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement**

```ts
// app/lib/sketch/view.ts
import type { Vec2 } from './geom'

/** Drawing → screen, in SVG/DOMMatrix order: x' = a·x + c·y + e, y' = b·x + d·y + f.
 *  One matrix is the whole contract between the pen and a host: it may translate,
 *  scale (unevenly), rotate and mirror. */
export interface ViewMatrix { a: number; b: number; c: number; d: number; e: number; f: number }

export function applyView(m: ViewMatrix, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function invertView(m: ViewMatrix): ViewMatrix | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** Screen pixels per drawing unit (geometric mean of the two axis scales). */
export function pxPerUnit(m: ViewMatrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
}

/** A mirrored view reverses arc winding on screen. Only screen-space drawing of
 *  arcs (live previews) needs this; the outline itself is drawn in drawing space
 *  under `viewToSvg`, which needs no correction. */
export function isMirrored(m: ViewMatrix): boolean {
  return m.a * m.d - m.b * m.c < 0
}

export function viewToSvg(m: ViewMatrix): string {
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`
}
```

```ts
// app/lib/sketch/tolerance.ts
import { pxPerUnit, type ViewMatrix } from './view'

/** Pen tolerances in SCREEN pixels, so they feel the same at any zoom and in any
 *  host. Values are the dev page's historical world-unit constants × its default
 *  34 px/unit (0.6, 0.15, 0.2), so the dev page behaves byte-identically at that zoom. */
export const SNAP_PX = 20.4
export const BOW_PX = 5.1
export const MIN_RADIUS_PX = 6.8

export function pxToUnits(px: number, m: ViewMatrix): number {
  const s = pxPerUnit(m)
  return s > 0 ? px / s : px
}
```

- [ ] **Step 4:** Re-run the two test files. Expected: PASS.
- [ ] **Step 5:** Commit (private index): `feat(sketch): view matrix and screen-pixel tolerances for the shared pen`.

---

### Task 3: `usePen` — the pen's state and actions out of the page

**Files:**
- Create: `app/composables/pen/usePen.ts`, `app/composables/pen/penRules.ts`
- Modify: `app/pages/dev/sketch-draw.vue` (script shrinks; template unchanged in this task)
- Test: `tests/unit/pen-rules.unit.spec.ts`; `tests/sketch-draw.spec.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: `ViewMatrix`, `pxToUnits`, `SNAP_PX`, `BOW_PX`, `MIN_RADIUS_PX` (Task 2).
- Produces:
  ```ts
  export type PenTool = 'select' | 'point' | 'line' | 'circle' | 'path'   // 'curve' added in Task 6
  export interface PenOptions { openOnly?: boolean; tools?: PenTool[] }
  export function usePen(opts: {
    doc: Ref<SketchDoc>          // the host owns the ref; the pen mutates doc.value in place and replaces it on undo/redo/reset
    view: Ref<ViewMatrix>        // for tolerances only (Task 3); rendering uses it in Task 4
    options?: PenOptions
    onChange?: () => void        // after every committed history step
  }): Pen
  // Pen exposes, with the SAME names and signatures the page has today:
  //   tool, guideMode, showLabels, status, selection, selectedSegments, pending, pendingPath,
  //   pendingOp, opHint, cursor, dimBuffer, nextSegment, sparkles
  //   selectTool, setGuideMode, toggleGuideMode, setShowLabels, toggleShowLabels,
  //   pick, clearSel, pickSegment, clearSegSel, marqueeSelect,
  //   place, pathDown, pathMove, pathUp, finishPath, cancelPath, removeLastAnchor,
  //   runSolve, apply, applyWithValue, del, nudge, fixSelected, makeConstruction, flip,
  //   repeatPrompt, armRepeat, doMirror, cancelPendingOp, setArcRadius, setConstraintValue,
  //   removeConstraintById, commitDimension, undo, redo, canUndo, canRedo, reset,
  //   onKeydown, onKeyup, onBlur, sparkle, sparkleCount, commitHistory
  // penRules.ts:
  export function availableConstraints(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleOption[]
  export function orderRefs(doc: SketchDoc, kind: ConstraintKind, ids: EntityId[]): EntityId[]
  export interface RuleOption { kind: ConstraintKind; label: string; value?: boolean }
  export interface SegRef { pathId: EntityId; segIndex: number }
  ```

- [ ] **Step 1: Baseline.** Run `npx playwright test tests/sketch-draw.spec.ts` (foreground). Record the pass count (expected 39). If any fail at HEAD, stop and report — do not start the move on a red baseline.
- [ ] **Step 2: Failing test for the rules split.**

```ts
// tests/unit/pen-rules.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle } from '~/lib/sketch/edit'
import { availableConstraints } from '~/composables/pen/penRules'

const empty = (): SketchDoc => ({ entities: [], constraints: [] })
const kinds = (xs: { kind: string }[]) => xs.map(x => x.kind)

describe('availableConstraints', () => {
  it('two circles → concentric, tangent, equal', () => {
    const d = empty()
    const c1 = addCircle(d, addPoint(d, 0, 0), 1)
    const c2 = addCircle(d, addPoint(d, 3, 0), 1)
    expect(kinds(availableConstraints(d, [c1, c2], []))).toEqual(['concentric', 'tangentCircleCircle', 'equalRadius'])
  })
  it('one line → horizontal, vertical', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 2, 1))
    expect(kinds(availableConstraints(d, [l], []))).toEqual(['horizontal', 'vertical'])
  })
  it('nothing selected → nothing offered', () => {
    expect(availableConstraints(empty(), [], [])).toEqual([])
  })
})
```

  Run it: FAIL (module not found).
- [ ] **Step 3: Move the rules logic.** Move `selKinds`, `pathCornerInfo`, `availableConstraints`, `segmentAnchorPair`, `isLineSegment`, `segmentConstraintRefs`, `orderRefs` (`sketch-draw.vue:280-449`) into `penRules.ts` as pure functions taking `(doc, selection, segments)` explicitly instead of reading refs. Keep bodies and label strings identical. Run the unit test: PASS.
- [ ] **Step 4: Move state and actions.** Create `usePen.ts` and move into it, verbatim except for the substitutions below, every piece of script state and every action from `sketch-draw.vue` **except** the viewport (`scale`, `panX`, `panY`, `sx/sy/wx/wy`, `zoomAt`, `panBy`, `fitView`, `getViewport`, `spaceHeld`, `panning`, `startPan`, `panTrigger`, `svgCursor`, `onWheel`), rendering computeds (`toShadowEntities` … `lineDimChip`, `sketch-draw.vue:1121-1297`), pointer handlers (`svgLocalXY` … `onPointerLeaveSvg`, `:1370-1563`), `copySvg`, and the `onMounted` API block. Substitutions:
  - `doc` → the host's `opts.doc` ref (same `.value` access everywhere);
  - `snapPoint(doc.value, x, y, { exclude })` → `snapPoint(doc.value, x, y, { exclude, tol: pxToUnits(SNAP_PX, opts.view.value) })`, and the same `tol` for `inferCircleTangents`;
  - `> 0.15` in `pathMove` → `> pxToUnits(BOW_PX, opts.view.value)`;
  - `Math.max(0.2, …)` in `place` → `Math.max(pxToUnits(MIN_RADIUS_PX, opts.view.value), …)`;
  - `commitHistory` calls `opts.onChange?.()` after pushing a real (non-no-op) step;
  - `onKeydown` keeps every branch **except** the viewport ones (space pan, zoom keys), which stay in the page and run first there.
  Return every name listed in **Produces**.
- [ ] **Step 5: Page uses the pen.** In `sketch-draw.vue`: `const doc = ref<SketchDoc>(…)`, `const view = computed<ViewMatrix>(() => ({ a: scale.value, b: 0, c: 0, d: -scale.value, e: panX.value, f: panY.value }))`, `const pen = usePen({ doc, view })`. Replace every moved identifier in the remaining script and template with `pen.<name>` (the template reads refs through `pen.tool.value` etc. — or destructure the refs at the top of the page script to keep the template untouched; prefer destructuring). The `window.__sketchDraw` object keeps every key, now pointing at `pen.*` (viewport keys still point at the page's own functions).
- [ ] **Step 6:** `npx vitest run tests/unit/sketch-*.unit.spec.ts tests/unit/pen-*.unit.spec.ts` → PASS. `npx playwright test tests/sketch-draw.spec.ts` (foreground) → **same pass count as Step 1**. Hard-reload the page before any live check (HMR-stale docs gave impossible counts before).
- [ ] **Step 7:** Live, with **real clicks** in the browser pane on `http://127.0.0.1:3002/dev/sketch-draw`: draw a line, bow an arc off its end (the T chip appears), close a path, drag a point (the drawing re-solves), undo twice. Screenshot the result.
- [ ] **Step 8:** Commit (private index): `refactor(sketch): the pen's state and actions move into usePen; the dev page hosts it`.

---

### Task 4: `PenOverlay` — rendering and input over any host

**Files:**
- Create: `app/components/pen/PenOverlay.vue`
- Modify: `app/pages/dev/sketch-draw.vue` (the `<svg>` block and its pointer handlers move out)
- Test: `tests/sketch-draw.spec.ts` (unchanged, green)

**Interfaces:**
- Consumes: `Pen` (Task 3), `ViewMatrix` / `applyView` / `invertView` / `viewToSvg` / `isMirrored` (Task 2).
- Produces:
  ```vue
  <PenOverlay :pen="pen" :view="view" :width="w" :height="h" />
  <!-- absolutely positioned SVG sized width×height at the host canvas's top-left.
       Emits: 'commit' (Enter / Done), 'cancel' (Escape with nothing pending). -->
  ```

- [ ] **Step 1: Move the render computeds** (`sketch-draw.vue:1121-1297`) into the component with these changes:
  - **Outline and construction outline:** render `sketchPathData(doc)` and the construction `entityPath`s **in drawing space**, inside `<g :transform="viewToSvg(view)">`, with `vector-effect="non-scaling-stroke"` and the page's current stroke widths / dash. Delete `toShadowEntities` and the sweep flip — the SVG transform handles scale, rotation and mirroring.
  - **Points, badges, chips, sparkles, handle arms:** keep in screen space; every `sx(p.x), sy(p.y)` becomes `applyView(view, p)`; every `r * scale.value` becomes `r * pxPerUnit(view)`.
  - **Live previews that emit arc commands in screen space** (`previewD` arc branch, `pathBowChip`): compute the arc in drawing space and flip `sweep` when `isMirrored(view)` — this is the only place a mirror needs handling.
- [ ] **Step 2: Move the pointer handlers** (`:1370-1563`). `svgXY(ev)` becomes `applyView(invertView(view)!, localXY(ev))`. Hit-testing radii and `MARQUEE_THRESHOLD_PX` stay in pixels. Pan is **not** the overlay's job: the host intercepts pan gestures in the capture phase (Step 3).
- [ ] **Step 3: Page hosts the overlay.** The page wraps `<PenOverlay>` in a `div` of the old SVG's size (680×460) that owns `@wheel` and, in `@pointerdown.capture`, calls `startPan(ev)` + `ev.stopPropagation()` when `panTrigger(ev)`. Keyboard: the overlay registers `pen.onKeydown/onKeyup/onBlur` on `window` while mounted; the page registers its own viewport keydown first and calls `ev.stopImmediatePropagation()` only for keys it consumed.
- [ ] **Step 4:** Unit + Playwright as in Task 3 Step 6 → same pass count. Hard reload first.
- [ ] **Step 5:** Live with real clicks: repeat Task 3 Step 7, then **zoom in** (wheel) and check a snap still grabs at the same on-screen distance as before zooming (it did not before this plan — that is the intended change) and the outline stays crisp (non-scaling stroke).
- [ ] **Step 6: Mirror/rotation proof.** Add a dev-only query flag to the page, `?view=rotated`, that sets `view` to a 30° rotation with **no** y-flip. Live: draw an arc with real clicks; the committed arc bends the same way the preview did, and the outline passes through every anchor dot. Screenshot both the default and rotated views.
- [ ] **Step 7:** Commit: `feat(pen): PenOverlay draws the pen over any host through one view matrix`.

---

### Task 5: `PenToolbar` — the approved layout

**Files:**
- Create: `app/components/pen/PenToolbar.vue`
- Modify: `app/pages/dev/sketch-draw.vue` (its hand-rolled button rows are replaced)
- Test: `tests/sketch-draw.spec.ts` (green); `tests/unit/pen-rules.unit.spec.ts` (extended)

**Interfaces:**
- Consumes: `Pen`, `availableConstraints` (Task 3); the layout decided in Task 1.
- Produces: `<PenToolbar :pen="pen" @done="…" @cancel="…" />` — the host places it (dev page: above the canvas; Frame: in place of its bottom toolbar, Plan B).

- [ ] **Step 1:** Build the layout recorded in the spec's "Toolbar decision" using `StudioButton` and lucide icons (tooltips carry the sentence-case names from spec section 2). **Keep every existing test hook attribute:** `data-tool="<tool>"`, `data-verb="<kind>"` and `data-verb="fix|repeat|mirror|construction|flip-h|flip-v"`, `data-act="guide|labels|reset|close|finish|op-cancel|delete"`, `data-op-hint`, `data-select-hint`, `data-status`.
- [ ] **Step 2:** Rules come only from `availableConstraints(doc, selection, segments)` — the toolbar computes nothing itself. Extend `pen-rules.unit.spec.ts` with: point + line → `['pointOnLine', 'midpoint']`; one circle → `['radius']`.
- [ ] **Step 3:** Hint line text (sentence case): path tool idle → "Click to add a point, drag to bend it into an arc, click the first point to close"; pending Repeat → "Click the centre to repeat around"; pending Mirror → "Click the line to mirror across". Keep `opHint`'s existing strings if the tests assert them (check `tests/sketch-draw.spec.ts:1175-1208` before changing any).
- [ ] **Step 4:** Unit + Playwright → same pass count. Live with real clicks: every tool button switches tools; selecting a line then a circle shows Tangent; Done and Cancel fire (page logs them to `status`). Screenshot.
- [ ] **Step 5:** Commit: `feat(pen): PenToolbar — tools, rules and hints from one list`.

---

### Task 6: The Curve tool (Bézier)

**Files:**
- Modify: `app/composables/pen/usePen.ts`, `app/components/pen/PenOverlay.vue`, `app/components/pen/PenToolbar.vue`, `app/composables/pen/penRules.ts`, `app/pages/dev/sketch-draw.vue` (API hooks)
- Test: `tests/unit/pen-curve.unit.spec.ts` (new); `tests/sketch-draw.spec.ts` (restore the retired pen tests, adapted)

**Interfaces:**
- Consumes: `addSmoothHandles`, `setAnchorSmooth`, `deleteEntity` (`lib/sketch/edit.ts`); `Pen`.
- Produces: `PenTool` gains `'curve'`; `Pen` gains `curveDown(x, y)`, `curveMove(x, y)`, `curveUp(x, y)`; `__sketchDraw` gains `curveDown/curveMove/curveUp`.

Rules for mixing (spec 2b): Path (arcs) and Curve add to the **same** pending path. The kind of each new segment is decided by the tool active **when its end point is placed**: `path` → `line` or `arc` (existing behaviour), `curve` → `cubic { h1: lastHOut, h2: null }` with `h2` filled if the new point is dragged smooth. Switching between `path` and `curve` does **not** end the pending path (today `selectTool` ends it — special-case these two tools). Closing: the closing segment is `cubic` if the tool at close time is `curve` (with `h2: firstHIn`), otherwise the existing `closingSegment()`.

- [ ] **Step 1: Failing unit tests**

```ts
// tests/unit/pen-curve.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen }
}
const path = (d: SketchDoc) => d.entities.find(e => e.kind === 'path') as any

describe('curve tool', () => {
  it('click-drag places smooth points joined by cubic segments', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)
    pen.curveDown(4, 0); pen.curveMove(5, -1); pen.curveUp(5, -1)
    pen.finishPath(false)
    const p = path(doc.value)
    expect(p.segments).toHaveLength(1)
    expect(p.segments[0].kind).toBe('cubic')
    expect(p.segments[0].h1).toBeTruthy()
    expect(p.segments[0].h2).toBeTruthy()
  })
  it('a plain click after a smooth point does not inherit its out-handle', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)   // smooth
    pen.curveDown(4, 0); pen.curveUp(4, 0)                         // sharp
    pen.curveDown(8, 0); pen.curveUp(8, 0)                         // sharp
    pen.finishPath(false)
    const p = path(doc.value)
    expect(p.segments[1].h1).toBeNull()
  })
  it('switching between arcs and curves keeps one path', () => {
    const { doc, pen } = mk()
    pen.selectTool('path')
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)                           // line segment
    pen.selectTool('curve')
    pen.curveDown(8, 0); pen.curveMove(9, 1); pen.curveUp(9, 1)    // cubic segment
    pen.finishPath(false)
    const paths = doc.value.entities.filter(e => e.kind === 'path') as any[]
    expect(paths).toHaveLength(1)
    expect(paths[0].segments.map((s: any) => s.kind)).toEqual(['line', 'cubic'])
  })
  it('deleting a handle turns the point sharp and keeps the path', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveUp(0, 0)
    pen.curveDown(4, 0); pen.curveMove(5, 1); pen.curveUp(5, 1)
    pen.curveDown(8, 0); pen.curveUp(8, 0)
    pen.finishPath(false)
    const p = path(doc.value)
    const h = p.segments[0].h2
    pen.selectTool('select'); pen.pick(h); pen.del()
    const after = path(doc.value)
    expect(after).toBeTruthy()
    expect(after.segments[0].h2).toBeNull()
  })
})
```

  Run: FAIL (`curveDown` is not a function).
- [ ] **Step 2: Restore the gesture.** Port `penDown/penMove/penUp`, `lastHOut`, `firstHIn` from `git show 78788db4a^:frontend/app/pages/dev/sketch-draw.vue` into `usePen.ts` as `curveDown/curveMove/curveUp`, with the smooth threshold `pxToUnits(BOW_PX, view)` instead of `0.15`, and the mixing rules above. Keep `else lastHOut = null` on every sharp point.
- [ ] **Step 3: Handles in the overlay.** Port `visibleHandleIds`, `handleArms`, `previewDragHandles` and the cubic branch of the preview into `PenOverlay.vue`, in screen space via `applyView`. Handle points are construction points: confirm `snapPoint`'s `exclude` gets them (the page's `handleIdsForAnchor`, `:1349`) so handles are never snap targets. Handles ride along when their anchor is dragged (existing `dragHandleIds`).
- [ ] **Step 4: Handle delete = sharp corner — already in the library.** `deleteEntity` (`lib/sketch/edit.ts:90-97`) already demotes a point referenced only as a cubic `h1`/`h2` to a cusp (sets the reference to `null`; its `collinear` rule drops via the dangling-refs filter) and never cascades the path. Do **not** add a special case to `del()`. The fourth unit test proves it through the pen. Run the unit tests → PASS.
- [ ] **Step 5: Rules hide on curves.** In `penRules.ts`, when any selected segment is `cubic`, drop `tangentLineCircle`, `tangentCircleCircle`, `radius`, `concentric`, `equalRadius`. Add a unit test for it.
- [ ] **Step 6: Toolbar.** Add Curve after Pen with tooltip "Bézier curve — drag to pull out handles" and `data-tool="curve"`. Hint while Curve is active: "Click for a sharp point, drag to pull out handles".
- [ ] **Step 7: Browser tests.** Restore the retired pen tests from `git show 78788db4a^:frontend/tests/sketch-draw.spec.ts`, renamed pen → curve (`setTool('curve')`, `curveDown/Move/Up`), and add one: path line segment then curve segment in one path → `['line', 'cubic']`. Add the three hooks to `__sketchDraw`. Run Playwright foreground: previous count + the restored/new tests, all green.
- [ ] **Step 8:** Live with real clicks and drags (`left_click_drag`): draw an S-curve with two smooth points, drag a handle (the opposite one follows), delete a handle (the point goes sharp), add an arc off the end with the Pen tool, undo each step. Screenshot mid-drag and final.
- [ ] **Step 9:** Commit: `feat(pen): Curve tool — Bézier handles beside arcs, in one path`.

---

### Task 7: Tidy and record

**Files:**
- Modify: `docs/STATE.md`, `docs/superpowers/specs/2026-09-24-shared-pen-design.md`, the build dashboard (per `update-dashboard-on-every-commit` memory), memory files
- Test: full `npx vitest run tests/unit/sketch-*.unit.spec.ts tests/unit/pen-*.unit.spec.ts` + Playwright sketch suite

- [ ] **Step 1:** Confirm `sketch-draw.vue` no longer defines any drawing state or actions (grep for `ref<Pending`, `function pathDown`, `function apply(` — expect none). Report its new line count.
- [ ] **Step 2:** STATE.md entry "Shared pen — Plan A"; spec status line → "Plan A built"; dashboard updated; memory `sketch-constraint-solver-phase1-landed.md` gets a short "Shared pen Plan A" note (files, the affine-matrix decision, tolerances in px) and `MEMORY.md` pointer updated.
- [ ] **Step 3:** Commit: `docs(pen): Plan A built — shared pen, overlay, toolbar, Curve tool`.
