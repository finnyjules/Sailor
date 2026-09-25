# Shared pen — Plan B: the Frame hosts the pen

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Frame editor draws with the shared pen — a new drawing becomes a path layer that remembers its drawing, double-clicking it reopens the pen with its rules, and a text layer's "Drawn path" guide is drawn and edited the same way — and the old handles pen is deleted.

**Architecture:** Pure geometry first (`lib/compositor/penFrame.ts`: drawing units ↔ a path layer's local units, the view matrix for a layer or a text guide, re-centring on commit). `PathLayer` and the text guide gain an optional `sketch` whose invariant is `d === sketchToLocalD(sketch)`; `d` stays what every renderer reads. The Frame opens one **pen session** at a time (`new` · `layer` · `guide`), mounts `PenOverlay` inside the artboard and `PenToolbar` in place of its bottom toolbar, and routes every key through its own capture handler into the pen while the session is open.

**Tech Stack:** Vue 3.5 `<script setup>`, TypeScript, Vitest (node env; `// @vitest-environment happy-dom` for component mounts), Playwright against the running dev server on `:3002` (`/dev/frame-lab` mounts the real `CompositorModal`).

**Spec:** `docs/superpowers/specs/2026-09-24-shared-pen-design.md` — section 3 (the Frame), section 1 (host contract), and "Carried into Plan B". Plan A: `docs/superpowers/plans/2026-09-24-shared-pen-a.md`. The host contract is the comment at the top of `frontend/app/composables/pen/usePen.ts` — read it.

## Global Constraints

- Work in the main checkout; no worktree, no branch (`CLAUDE.md`). Other sessions edit this checkout concurrently: stage only your own paths; never `git stash`; leave files you did not write alone.
- **Every commit uses a private index** — never `cp .git/index`, never a bare commit:
  ```
  export GIT_INDEX_FILE=$(mktemp /private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/08811ebc-286d-4206-85f0-f2d098f0c5a5/scratchpad/penb-idx.XXXX)
  git read-tree HEAD
  git add <only your exact paths>
  git diff --cached --stat
  git commit -m "..." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
  then in a **separate** shell call: `git reset -q -- <your paths>`. `CompositorModal.vue` is shared with other sessions: if `git diff --stat` shows foreign hunks in it, stage **only your hunks** (`git diff <file> > p.diff`, edit to your hunks, `git apply --cached p.diff` with the private index set).
- **Never run `npm run dev`** or restart the dev server. Playwright runs in the **foreground** against `http://127.0.0.1:3002`. If the server is broken, stop and report.
- **Gestures are proven with real input.** API hooks prove maths; a claim about clicking, dragging or keys needs real `page.mouse` / `page.keyboard` in Playwright or real clicks in the browser pane. Simulated `dispatchEvent` pointer events do not count.
- Paths below are relative to `frontend/`. Vitest/Playwright run from `frontend/`; git from the repo root.
- UI copy: sentence case, no identifiers or internal names in labels or tooltips.
- A Frame with no `sketch` anywhere must render **byte-identically** to today — nothing about rendering changes.
- Commit messages end with the Co-Authored-By line above.

## Facts verified at HEAD (from the code, 2026-09-25)

- **PathLayer** (`app/composables/useCompositorLayers.ts:618`): `d` in local units centred on (0,0), `bbox {w,h}` unscaled local extent, uniform `scale`, plus `LayerCommon` (`x`,`y` = 0..1 of W/H at the centre, `rotation` degrees, optional `skewX`/`skewY` degrees). No scaleX/scaleY, no flip.
- **Draw transform** (`applyXform` :2938 then `drawPath` :5235): artboard px = `translate(x·W, y·H) · rotate(rotation°) · [shear: matrix(1, tan(skewY), tan(skewX), 1, 0, 0)] · scale(scale·W) · p_local`. In the Frame, `W,H = canvasDisplay.w, canvasDisplay.h`.
- **Writers of a path layer's `d`** that MERGE into an existing layer: only `swapShapeLayer` (`app/lib/shapes/pathLayer.ts:44`, applied via `setLocal` at CM:7802). Node edit REPLACES the layer with a fresh `segmentsToPathLayer` object (CM `commitNodeEdit` :2001); booleans, SVG import, library shapes and the old pen create fresh layers; duplicate/paste copy the whole layer (a copied `sketch` is correct).
- **Text guide** (`app/lib/compositor/textPath.ts:334` `guideFromPathD`): longest subpath only, points × W, optional refit so the x-extent equals `size·W`, then `guideFromPolyline` re-centres on the polyline's bbox midpoint. Text layers use the same `applyXform` (no `scale` field).
- **Keys**: CM `onKeydown` is a **capture** listener on window (registered CM:2381) that calls `stopPropagation` for ⌘Z/⇧⌘Z, Space and others, which also silences window **bubble** listeners — including `PenOverlay`'s. CM `handleKeydown` (bubble, CM:8153) closes the modal on an Escape that is not `defaultPrevented` and deletes the selected layer on Delete/Backspace without checking any tool. `VueNodeCanvas`'s ⌘Z listener is a window bubble listener too; today the Frame's capture `stopPropagation` is what keeps it quiet.
- **Stage**: the artboard div `canvasRef` (CM:8447) is `absolute inset-0 overflow-hidden` inside `stageWrapRef`, which carries the CSS pan/zoom `translate(tx,ty) scale(view.scale)`. A child of `canvasRef` sized `canvasDisplay.w × canvasDisplay.h` has local pixels equal to the painter's W×H. Plan A's `PenOverlay` maps pointers through `getScreenCTM()`, so the CSS zoom is handled. Pointer order into a child: stage `onStagePointerDownPan` (capture) → `onCanvasPointerDownCapture` (capture, CM:3758) → the child.
- **Bottom toolbar**: CM:9105 `<div v-if="inspectorTab !== 'motion'" class="absolute bottom-8 flex flex-col items-stretch gap-2 pointer-events-none">` — anchored to the bottom, so taller content grows upward. The agent prompt dock (:9112) and the tool row (:9141) live in it.
- **History**: `setLocal(id, patch)` records one undo step (unless a drag is live); `commit(next)` writes without recording; the multi-write pattern is `recordHistory()` once then `commit(...)`. `addPathLayers` records once.
- **`window.prompt`** in the pen: `usePen.ts` `applyWithValue` (:402), `onArcDimClick` (:484), `onConstraintMarkClick` (:514), `repeatPrompt` (:1061).
- **`PenOptions`** (`usePen.ts:62`, `{ openOnly?, tools? }`) is accepted and read by nothing.
- **Dev hooks**: CM exposes `window.__compositorLayers()` and `__compositorSetLayers(next)` in dev (CM:2385-2404); `/dev/frame-lab` exposes `window.__frameLab` and sets `[data-ready]`.

## Decisions this plan makes (from the spec, made concrete)

1. **Drawing units.** A stored `sketch` uses **100 drawing units per local unit** (`SKETCH_UNITS = 100`). A local unit is `scale·W` px, so at scale 1 the frame width is 100 units and a typical drawing spans 5–60 units — the magnitude the solver's absolute tolerances were tuned at on the test page (~20 units across). This settles the spec's "scale check" without touching the solver.
2. **Invariant.** Wherever a `sketch` is stored (path layer or text guide), `d === sketchToLocalD(sketch)`. Anything that writes `d` without the pen drops `sketch`.
3. **Re-centring happens on commit only.** During a session the host writes live previews with `commit` (no history); on commit it re-centres (shift the drawing so its outline's bbox centre is (0,0), move `x`/`y` by the same on-screen amount) and records exactly one undo step.
4. **Pen style for a new layer.** Closed drawing → fill `#3b82f6`, no stroke (today's `PEN_STYLE`). Open drawing → no fill, stroke `#3b82f6`, `strokeWidth 0.004` (≈ 2.7 px on a 680 px frame) — a filled open path draws a chord-closed blob, which reads as a bug.
5. **No `writePathD` helper.** The spec asked for one helper every `d` writer goes through. At HEAD only `swapShapeLayer` merges a new `d` into an existing layer; every other writer builds a fresh layer (no `sketch` to go stale) or copies the whole layer (the `sketch` is correct). So the rule lives where it bites — `swapShapeLayer` drops `sketch` — plus a test that `segmentsToPathLayer` never carries one. A helper with one caller is ceremony.
6. **Keyboard ownership.** While a session is open, the Frame's capture handler keeps only viewport keys (Space pan, ⌘= ⌘− ⌘0 ⌘2 zoom) and hands **every other key** to the pen, then stops propagation so no bubble listener (modal Escape, layer Delete, canvas ⌘Z) sees it. `PenOverlay` gets `keyboard="host"`: it registers no window listeners and exposes `onHostKeydown(e)` / `onHostKeyup(e)`.

## File map

| File | Responsibility |
|---|---|
| `app/composables/pen/usePen.ts` | Shrinks: gestures + wiring (Task 1) |
| `app/composables/pen/penHistory.ts` (new) | History, opening snapshot, revert, onChange/onLiveChange, finishSession bookkeeping |
| `app/composables/pen/penKeys.ts` (new) | The key map (`handleKey`) |
| `app/composables/pen/penCopies.ts` (new) | Repeat / Mirror / Flip |
| `app/components/pen/PenValueRow.vue` (new) | Inline value entry replacing `window.prompt` |
| `app/components/pen/PenOverlay.vue` / `PenToolbar.vue` | Host keyboard mode; options; value row |
| `app/lib/compositor/penFrame.ts` (new) | Drawing units, view matrices, re-centring — pure |
| `app/lib/compositor/textPath.ts` | `customGuideMapping` extracted; `guideFromPathD` uses it |
| `app/composables/useCompositorLayers.ts` | `PathLayer.sketch?`; `TextPathSpec.sketch?` lives in textPath.ts |
| `app/lib/shapes/pathLayer.ts` | `swapShapeLayer` drops `sketch` |
| `app/composables/frame/useFramePenSession.ts` (new) | The Frame's session: open/commit/cancel, live preview writes |
| `app/components/vue-canvas/CompositorModal.vue` | Hosts the session; old pen removed |
| `app/composables/useVectorPen.ts` | **Deleted** |

---

### Task 1: Split `usePen.ts` (behaviour-preserving)

**Files:**
- Create: `app/composables/pen/penHistory.ts`, `app/composables/pen/penKeys.ts`, `app/composables/pen/penCopies.ts`
- Modify: `app/composables/pen/usePen.ts`
- Test: existing `tests/unit/pen-*.unit.spec.ts`, `tests/unit/sketch-*.unit.spec.ts`, `tests/sketch-draw.spec.ts` — unchanged, green.

**Interfaces:**
- Produces (internal; `usePen`'s returned API is **unchanged** — same names, same behaviour):
  ```ts
  // penHistory.ts
  export function createPenHistory(opts: { doc: Ref<SketchDoc>; onChange?: () => void; onLiveChange?: () => void }): {
    initHistory(): void; commitHistory(): void; undo(): boolean; redo(): boolean;
    canUndo(): boolean; canRedo(): boolean; revert(): void; live(): void
  }
  // penKeys.ts
  export function handlePenKey(ev: KeyboardEvent, ctx: PenKeyContext, local?: { cancelGesture?: () => boolean }): boolean
  // penCopies.ts
  export function createPenCopies(ctx: PenCopiesContext): { applyRepeat; applyMirror; armRepeat; doMirror; flip }
  ```
  `PenKeyContext` / `PenCopiesContext` are plain objects of the refs and functions each needs, built inside `usePen`.

- [ ] **Step 1:** Run the baseline: `npx vitest run tests/unit/pen-*.unit.spec.ts tests/unit/sketch-*.unit.spec.ts` and `npx playwright test tests/sketch-draw.spec.ts` (foreground). Record counts (Plan A ended at 231 unit / 45 Playwright). A red baseline → stop and report.
- [ ] **Step 2:** Move history/snapshot/revert/onChange/onLiveChange code into `penHistory.ts`, the body of the key handler (`handleKey`) into `penKeys.ts`, and Repeat/Mirror/Flip into `penCopies.ts`. Bodies move verbatim; only the free variables become fields of the context object. Keep the HOST CONTRACT comment at the top of `usePen.ts`.
- [ ] **Step 3:** Re-run Step 1's commands: identical counts. Report `usePen.ts`'s new line count (target < 900).
- [ ] **Step 4:** Commit: `refactor(pen): history, keys and copies leave usePen.ts`.

---

### Task 2: Inline values instead of `window.prompt`

**Files:**
- Create: `app/components/pen/PenValueRow.vue`
- Modify: `app/composables/pen/usePen.ts` (and `penCopies.ts` for Repeat), `app/components/pen/PenToolbar.vue`, `app/pages/dev/sketch-draw.vue` (a test hook)
- Test: `tests/unit/pen-value-request.unit.spec.ts` (new); `tests/sketch-draw.spec.ts` (+1 test)

**Interfaces:**
- Produces:
  ```ts
  // on the Pen:
  valueRequest: Ref<{ label: string; initial: number; min?: number } | null>
  submitValue(v: number): void      // resolves the pending request
  cancelValue(): void               // resolves with null
  // internal
  function requestValue(label: string, initial: number, min?: number): Promise<number | null>
  ```
  `applyWithValue`, `onArcDimClick`, `onConstraintMarkClick`, `repeatPrompt` become `async` and `await requestValue(...)` where they called `window.prompt`. A second request while one is pending cancels the first (resolves it with `null`).

- [ ] **Step 1: Failing test**

```ts
// tests/unit/pen-value-request.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}

describe('inline value requests', () => {
  it('Repeat… asks for a count and repeats on submit', async () => {
    const { doc, pen } = mk()
    pen.selectTool('circle'); pen.place(0, 0); pen.place(1, 0)
    pen.selectTool('select')
    const circle = doc.value.entities.find(e => e.kind === 'circle')!
    pen.pick(circle.id)
    const done = pen.repeatPrompt()
    expect(pen.valueRequest.value?.label).toMatch(/copies/i)
    pen.submitValue(4)
    await done
    expect(pen.pendingOp.value?.kind).toBe('repeat')
  })
  it('cancel resolves with nothing applied', async () => {
    const { doc, pen } = mk()
    pen.selectTool('line'); pen.place(0, 0); pen.place(3, 0)
    pen.selectTool('select')
    const ids = doc.value.entities.filter(e => e.kind === 'point').map(e => e.id)
    pen.pick(ids[0]!); pen.pick(ids[1]!, true)
    const before = doc.value.constraints.length
    const done = pen.applyWithValue({ kind: 'distance', label: 'Distance…', value: true })
    pen.cancelValue()
    await done
    expect(doc.value.constraints.length).toBe(before)
    expect(pen.valueRequest.value).toBeNull()
  })
  it('never calls window.prompt', () => {
    const src = readFileSync(new URL('../../app/composables/pen/usePen.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('../../app/composables/pen/penCopies.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/window\.prompt|\bprompt\(/)
  })
})
```

  Run: FAIL (`valueRequest` undefined).
- [ ] **Step 2:** Implement `requestValue` / `valueRequest` / `submitValue` / `cancelValue` in `usePen.ts` and replace the four `window.prompt` calls (Repeat lives in `penCopies.ts` after Task 1 — thread `requestValue` through its context). Keep each prompt's current default value and wording, sentence case: "Distance", "Radius", "Copies around the ring".
- [ ] **Step 3:** `PenValueRow.vue`: renders when `pen.valueRequest` is set — the label, a number `<input>` (autofocused, `data-testid="pen-value-input"`), Enter submits (ignored if not a finite number ≥ `min`), Escape cancels, a small ✓ button submits. `PenToolbar.vue` shows it as the top row (above the rules row). Because the input is a text field, the pen's typing guard already ignores keys while it has focus.
- [ ] **Step 4:** Browser test in `tests/sketch-draw.spec.ts`: draw a circle via hooks, select it, click the real "Repeat…" button, type `5` into `[data-testid="pen-value-input"]` with `page.keyboard`, press Enter, assert `pendingOp` is repeat. Run unit + Playwright (foreground): all green.
- [ ] **Step 5:** Commit: `feat(pen): values are typed inline, not in a browser prompt`.

---

### Task 3: Pen options and three small fixes

**Files:**
- Modify: `app/composables/pen/usePen.ts`, `app/components/pen/PenToolbar.vue`, `app/components/pen/PenOverlay.vue`
- Test: `tests/unit/pen-options.unit.spec.ts` (new)

**Interfaces:**
- Consumes: `PenOptions { openOnly?: boolean; tools?: PenTool[] }` (already declared).
- Produces: `pen.options` (readonly, resolved: `tools` defaults to all tools); `usePen` honours them.

Behaviour:
- `tools`: `selectTool(t)` is a no-op for a tool not listed; the toolbar shows only listed tools (Select is always shown).
- `openOnly: true`: clicking the first anchor does not close the path (it adds nothing — treat as a click on an existing anchor); `finishPath(true)` behaves as `finishPath(false)`; the toolbar hides Close; the Circle tool is excluded even if listed.
- **Fix (a):** a pending path's anchor that *snapped onto* a point that existed before the gesture is not deleted when the path is abandoned (Escape, tool switch, Enter/Done with < 2 anchors). Track ownership per anchor exactly as Line/Circle starts do (entity count before/after `placePoint`).
- **Fix (b):** when `PenOverlay`'s `active` turns false, the pen-level gesture (`pathDrag`/`curveDrag`) is ended too — expose `pen.endGesture()` and call it from the overlay's `active` watcher.
- **Fix (c):** switching tools mid Line/Circle deletes the owned start point (same rule as `finishSession`).

- [ ] **Step 1: Failing tests**

```ts
// tests/unit/pen-options.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const mk = (options?: any) => {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  return { doc, pen: usePen({ doc, view: ref(DEV), options }) }
}
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]

describe('pen options', () => {
  it('tools limits which tools can be selected', () => {
    const { pen } = mk({ tools: ['select', 'path', 'curve'] })
    pen.selectTool('circle')
    expect(pen.tool.value).not.toBe('circle')
    pen.selectTool('curve')
    expect(pen.tool.value).toBe('curve')
  })
  it('openOnly: clicking the first point does not close the path', () => {
    const { doc, pen } = mk({ openOnly: true })
    pen.selectTool('path')
    for (const [x, y] of [[0, 0], [4, 0], [4, 4]]) { pen.pathDown(x, y); pen.pathUp(x, y) }
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.finishPath(true)
    expect(paths(doc.value)[0]?.closed).toBe(false)
  })
  it('openOnly excludes the circle tool', () => {
    const { pen } = mk({ openOnly: true })
    pen.selectTool('circle')
    expect(pen.tool.value).not.toBe('circle')
  })
})

describe('small fixes', () => {
  it('(a) abandoning a path keeps a pre-existing point it started on', () => {
    const { doc, pen } = mk()
    pen.selectTool('point'); pen.place(2, 2)
    const n = doc.value.entities.length
    pen.selectTool('path'); pen.pathDown(2, 2); pen.pathUp(2, 2)
    pen.cancelPath()
    expect(doc.value.entities.length).toBe(n)
  })
  it('(c) switching tools mid-line removes its own start point', () => {
    const { doc, pen } = mk()
    pen.selectTool('line'); pen.place(1, 1)
    pen.selectTool('circle')
    expect(doc.value.entities.filter(e => e.kind === 'point')).toHaveLength(0)
  })
  it('(b) endGesture clears a live curve drag', () => {
    const { pen } = mk()
    pen.selectTool('curve'); pen.curveDown(0, 0); pen.curveMove(1, 1)
    pen.endGesture()
    expect(pen.getCurveDrag()).toBeNull()
  })
})
```

  Run: FAIL.
- [ ] **Step 2:** Implement. Apply `openOnly`/`tools` inside `usePen` (the single source) and have `PenToolbar` read `pen.options` for which buttons to show.
- [ ] **Step 3:** Run pen/sketch unit suites + `tests/sketch-draw.spec.ts` (foreground): green, Playwright count unchanged.
- [ ] **Step 4:** Commit: `feat(pen): tool and open-path options; abandoned paths keep your points`.

---

### Task 4: `PenOverlay` host keyboard mode

**Files:**
- Modify: `app/components/pen/PenOverlay.vue`
- Test: `tests/unit/pen-overlay-host-keys.unit.spec.ts` (new, `// @vitest-environment happy-dom`)

**Interfaces:**
- Produces: prop `keyboard?: 'window' | 'host'` (default `'window'` — today's behaviour). With `'host'` the overlay registers **no** window key listeners and exposes via `defineExpose`:
  ```ts
  onHostKeydown(e: KeyboardEvent): boolean   // true = the pen (or the overlay's commit/cancel) consumed it
  onHostKeyup(e: KeyboardEvent): void
  ```
  `onHostKeydown` runs exactly the logic of today's window keydown listener (typing guard, focused-control Enter rule, `pen.onKeydown`, then Enter → `finishSession` + emit `commit`, Escape → emit `cancel`) and returns whether it consumed the key. The same `preventDefault` rules apply.

- [ ] **Step 1: Failing test** — mount `PenOverlay` with a pen and `keyboard: 'host'`; dispatch a keydown `Escape` on `window` → the overlay emits nothing; call `wrapper.vm.onHostKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))` → returns `true` and emits `cancel`; same for Enter → emits `commit`; with `keyboard` omitted, a window Escape emits `cancel` (unchanged). Run: FAIL.
- [ ] **Step 2:** Implement by extracting the listener body into `handleKeydownEvent(e): boolean` used by both modes.
- [ ] **Step 3:** Unit + `tests/sketch-draw.spec.ts` (foreground): green.
- [ ] **Step 4:** Commit: `feat(pen): the overlay can let its host own the keyboard`.

---

### Task 5: Frame pen geometry (pure)

**Files:**
- Create: `app/lib/compositor/penFrame.ts`
- Modify: `app/lib/compositor/textPath.ts` (extract `customGuideMapping`; add `sketch?: SketchDoc` to `TextPathSpec`)
- Test: `tests/unit/pen-frame.unit.spec.ts` (new); `tests/unit/compositor-text-path.unit.spec.ts` (must stay green unchanged)

**Interfaces:**
- Produces:
  ```ts
  // penFrame.ts
  export const SKETCH_UNITS = 100                         // drawing units per local unit
  export function sketchToLocalD(sketch: SketchDoc): string          // d in local units
  export function localOutlineBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } | null
  export function recentreSketch(sketch: SketchDoc): { sketch: SketchDoc; shiftLocal: { x: number; y: number }; bbox: { w: number; h: number } } | null
  //   shiftLocal = the outline's bbox centre in LOCAL units before the shift (the drawing moves by -shiftLocal)
  export interface LayerPlacement { x: number; y: number; rotation?: number; skewX?: number; skewY?: number; scale?: number }
  export function layerView(p: LayerPlacement, W: number, H: number): ViewMatrix          // drawing units → artboard px
  export function newDrawingView(W: number, H: number): ViewMatrix                     // = layerView({x:.5,y:.5,scale:1}, W, H)
  export function placementAfterRecentre(p: LayerPlacement, shiftLocal: { x: number; y: number }, W: number, H: number): { x: number; y: number }
  export function guideView(text: LayerPlacement, spec: { d: string; size?: number }, W: number, H: number): ViewMatrix | null
  // textPath.ts
  export function customGuideMapping(d: string, W: number, targetWidthPx?: number): { k: number; mid: { x: number; y: number } } | null
  //   guide px = W·k·(p_local − mid); guideFromPathD must use it (single source of truth)
  ```
  `ViewMatrix` / `applyView` come from `app/lib/sketch/view.ts`; `flattenPath`/`longestSubpath` from `app/lib/compositor/pathFlatten.ts`; `sketchPathData` from `app/lib/sketch/sketchPath.ts`; `cloneDoc` from `app/lib/sketch/clone.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/unit/pen-frame.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { applyView } from '~/lib/sketch/view'
import { solve } from '~/lib/sketch/solve'
import { SKETCH_UNITS, sketchToLocalD, localOutlineBounds, recentreSketch, layerView, placementAfterRecentre, guideView } from '~/lib/compositor/penFrame'
import { customGuideMapping, guideFromPathD } from '~/lib/compositor/textPath'

const square = (x0: number, y0: number, s: number): SketchDoc => {
  const d: SketchDoc = { entities: [], constraints: [] }
  const a = addPoint(d, x0, y0), b = addPoint(d, x0 + s, y0), c = addPoint(d, x0 + s, y0 + s), e = addPoint(d, x0, y0 + s)
  addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
  return d
}
const W = 680, H = 400

describe('penFrame', () => {
  it('drawing units are 1/100 of a local unit', () => {
    const b = localOutlineBounds(sketchToLocalD(square(10, 20, 30)))!
    expect(b.minX).toBeCloseTo(0.1, 9); expect(b.maxX).toBeCloseTo(0.4, 9)
    expect(b.minY).toBeCloseTo(0.2, 9); expect(b.maxY).toBeCloseTo(0.5, 9)
    expect(SKETCH_UNITS).toBe(100)
  })
  it('recentre moves the outline to the origin and reports the local shift and bbox', () => {
    const r = recentreSketch(square(10, 20, 30))!
    const b = localOutlineBounds(sketchToLocalD(r.sketch))!
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 9); expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 9)
    expect(r.shiftLocal.x).toBeCloseTo(0.25, 9); expect(r.shiftLocal.y).toBeCloseTo(0.35, 9)
    expect(r.bbox.w).toBeCloseTo(0.3, 9); expect(r.bbox.h).toBeCloseTo(0.3, 9)
  })
  it('layerView matches the painter transform (translate · rotate · shear · scale·W)', () => {
    const p = { x: 0.3, y: 0.6, rotation: 30, skewX: 10, skewY: 0, scale: 1.5 }
    const v = layerView(p, W, H)
    const local = { x: 0.1, y: -0.05 }                       // local units
    const got = applyView(v, { x: local.x * 100, y: local.y * 100 })
    // expected, computed the painter's way
    const s = 1.5 * W
    let x = local.x * s, y = local.y * s
    const tx = Math.tan(10 * Math.PI / 180), ty = 0
    ;[x, y] = [x + tx * y, ty * x + y]                       // shear matrix(1, tanY, tanX, 1)
    const r = 30 * Math.PI / 180
    ;[x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]
    expect(got.x).toBeCloseTo(0.3 * W + x, 6); expect(got.y).toBeCloseTo(0.6 * H + y, 6)
  })
  it('placementAfterRecentre keeps the outline where it was on screen', () => {
    const p = { x: 0.5, y: 0.5, rotation: 45, scale: 2 }
    const sk = square(10, 20, 30)
    const before = applyView(layerView(p, W, H), { x: 10, y: 20 })
    const r = recentreSketch(sk)!
    const q = { ...p, ...placementAfterRecentre(p, r.shiftLocal, W, H) }
    const movedCorner = { x: 10 - r.shiftLocal.x * 100, y: 20 - r.shiftLocal.y * 100 }
    const after = applyView(layerView(q, W, H), movedCorner)
    expect(after.x).toBeCloseTo(before.x, 6); expect(after.y).toBeCloseTo(before.y, 6)
  })
  it('customGuideMapping is exactly what guideFromPathD does', () => {
    const d = 'M -0.15 0 C -0.15 -0.18, 0.15 0.18, 0.15 0'
    const m = customGuideMapping(d, W, 0.3 * W)!
    const g = guideFromPathD(d, W, 0.3 * W)!
    const start = g.at(0)
    expect(start.x).toBeCloseTo(W * m.k * (-0.15 - m.mid.x), 3)
    expect(start.y).toBeCloseTo(W * m.k * (0 - m.mid.y), 3)
  })
  it('guideView maps a drawing point to where the text layer draws the guide', () => {
    const sk = square(0, 0, 20)
    const d = sketchToLocalD(sk)
    const text = { x: 0.4, y: 0.5, rotation: 0 }
    const v = guideView(text, { d, size: 0.2 }, W, H)!
    const m = customGuideMapping(d, W, 0.2 * W)!
    const p = applyView(v, { x: 0, y: 0 })
    expect(p.x).toBeCloseTo(0.4 * W + W * m.k * (0 - m.mid.x), 6)
    expect(p.y).toBeCloseTo(0.5 * H + W * m.k * (0 - m.mid.y), 6)
  })
  it('a Frame-sized drawing solves at these units', () => {
    const sk = square(10, 10, 40)
    const pt = sk.entities.find(e => e.kind === 'point')!
    const res = solve(sk, { drag: { point: pt.id, x: 12, y: 9 } })
    expect(res.converged).toBe(true)
  })
})
```

  Run: FAIL (module missing).
- [ ] **Step 2: Implement `customGuideMapping`** in `textPath.ts` from the body of `guideFromPathD` (longest subpath → points × W → refit factor `f` → bbox midpoint of the refit points), returning `k = f` and `mid` in LOCAL units (`mid = midpoint_px / (W·f)`). Rewrite `guideFromPathD` to build its polyline as `W·k·(p − mid)` and call `guideFromPolyline` — `guideFromPolyline` re-centres again, which is now a no-op. Add `sketch?: SketchDoc` to `TextPathSpec` with a comment stating the invariant. `compositor-text-path.unit.spec.ts` must pass unchanged.
- [ ] **Step 3: Implement `penFrame.ts`.**
  - `sketchToLocalD`: `cloneDoc`, scale every point's x/y and every circle's r by `1/SKETCH_UNITS`, return `sketchPathData(scaled)`.
  - `localOutlineBounds`: `flattenPath(d)` → min/max over all points; `null` when empty.
  - `recentreSketch`: bounds of `sketchToLocalD(sketch)`; centre `c` (local); clone and shift every point by `−c·SKETCH_UNITS` (circles move with their centre points); `bbox = {w: max(maxX−minX, 0.001), h: max(maxY−minY, 0.001)}`.
  - `layerView`: `M = T(x·W, y·H) · R(rotation) · Sh(skewX, skewY) · S(scale·W / SKETCH_UNITS)`, with `Sh = [1, tan(skewY); tan(skewX), 1]` in SVG order (`a=1, b=tan(skewY), c=tan(skewX), d=1`). Compose with a tiny local `mul(m1, m2)`.
  - `placementAfterRecentre`: the screen offset of `shiftLocal` through `R·Sh·S(scale·W)` (no translation), divided by W and H, added to x and y.
  - `guideView`: `m = customGuideMapping(spec.d, W, (spec.size ?? 0) > 0 ? spec.size·W : 0)`; `M = T(x·W, y·H) · R · Sh · S(W·m.k / SKETCH_UNITS) · T(−m.mid·SKETCH_UNITS)`; `null` when `m` is null.
- [ ] **Step 4:** Run `npx vitest run tests/unit/pen-frame.unit.spec.ts tests/unit/compositor-text-path.unit.spec.ts`: PASS.
- [ ] **Step 5:** Commit: `feat(frame): pen geometry — drawing units, layer and guide views, re-centring`.

---

### Task 6: Path layers and guides remember their drawing

**Files:**
- Modify: `app/composables/useCompositorLayers.ts` (`PathLayer`), `app/lib/shapes/pathLayer.ts` (`swapShapeLayer`)
- Test: `tests/unit/pen-frame-sketch-field.unit.spec.ts` (new)

**Interfaces:**
- Produces: `PathLayer.sketch?: SketchDoc` (comment: "the pen's drawing; invariant `d === sketchToLocalD(sketch)`; anything that writes `d` without the pen must drop it"). `swapShapeLayer(l, s)` returns a patch containing `sketch: undefined`.

- [ ] **Step 1: Failing tests**: (1) `swapShapeLayer` on a layer with a `sketch` returns a patch whose `sketch` is `undefined` and whose `d` is the shape's; (2) `segmentsToPathLayer(...)` (node-edit rebuild, `app/composables/useVectorSvg.ts`) returns an object with no `sketch` key; (3) a layer with a `sketch` survives `JSON.parse(JSON.stringify(layer))` with the invariant intact (`sketchToLocalD(copy.sketch) === copy.d`).
- [ ] **Step 2:** Implement: add the field; `swapShapeLayer` adds `sketch: undefined`. Grep `app/` once more for `setLocal(` / `commit(` patches that include `d:` on a path layer and confirm none merges into a layer that could carry a `sketch` (list what you checked in the report).
- [ ] **Step 3:** Run the new test + `npx vitest run tests/unit/compositor-*.unit.spec.ts tests/unit/shape*.unit.spec.ts`: green.
- [ ] **Step 4:** Commit: `feat(frame): path layers keep the pen's drawing; swapping the shape drops it`.

---

### Task 7: The Frame draws with the shared pen (new drawings)

**Files:**
- Create: `app/composables/frame/useFramePenSession.ts`
- Modify: `app/components/vue-canvas/CompositorModal.vue`
- Delete: `app/composables/useVectorPen.ts`
- Test: `tests/frame-pen.spec.ts` (new Playwright)

**Interfaces:**
- Consumes: `usePen`, `PenOverlay` (`keyboard="host"`, `onHostKeydown`, `onHostKeyup`), `PenToolbar`, `newDrawingView`, `layerView`, `recentreSketch`, `sketchToLocalD`, `placementAfterRecentre`, `createPathLayer`.
- Produces:
  ```ts
  export type FramePenTarget = { kind: 'new' } | { kind: 'layer'; id: string } | { kind: 'guide'; textId: string }
  export function useFramePenSession(host: {
    layers: () => any[]                                   // current local layers
    size: () => { W: number; H: number }                  // canvasDisplay
    recordHistory: () => void; commit: (next: any[]) => void
    addPathLayers: (layers: any[]) => void; selectLocal: (id: string | null) => void
  }): {
    session: Ref<null | { target: FramePenTarget; pen: Pen; doc: Ref<SketchDoc>; view: ComputedRef<ViewMatrix>; key: number }>
    open(target: FramePenTarget): void
    commitSession(): void
    cancelSession(): void
  }
  ```
  One session at a time; `key` increments per open so the host re-keys the overlay.

Behaviour for `{ kind: 'new' }` (this task; `layer` and `guide` arrive in Tasks 8–9):
- `open`: `doc = ref(empty drawing)`, `pen = usePen({ doc, view, options: { tools: ['select','path','curve','line','circle','point'] } })`, `view = computed(() => newDrawingView(W, H))`, starting tool `path`.
- `commitSession`: `pen.finishSession()`; if the drawing has no outline (`localOutlineBounds(sketchToLocalD(doc)) === null`) → just close. Otherwise `r = recentreSketch(doc)`, placement `{x,y} = placementAfterRecentre({x:.5,y:.5,scale:1}, r.shiftLocal, W, H)`, closed = any non-construction path is `closed` or any circle exists; style per Decision 4; `addPathLayers([createPathLayer({ d: sketchToLocalD(r.sketch), sketch: r.sketch, bbox: r.bbox, scale: 1, x, y, ...style })])`; select it; close.
- `cancelSession`: close; nothing written.

Frame wiring (CompositorModal.vue — anchor by function names; line numbers drift):
1. Replace `useVectorPen` with the session: remove the import, `const pen = useVectorPen()`, `onPen*`, `finishPen`, the old overlay `<svg v-if="pen.active.value">`, and `PEN_STYLE` moves into the session. Keep `penJustFinished` semantics: after `commitSession` the next `onCanvasClick` is swallowed.
2. `togglePen` → `session.value ? cancelSession() : open({ kind: 'new' })` (keep its guards: `viewOnlyGuard`, smart-mode exit, `selectLocal(null)`, `exitNodeEdit()`, `brush.setActive(false)`). Every place that did `pen.setActive(false)` (`selectTool`, `toggleDistort`, `toggleBrush`, `exitOtherToolsFor`) calls `cancelSession()`. `isSelectTool`, `designOnlyToolActive`, the cursor class and the dblclick skip read `!!session.value` where they read `pen.active.value`.
3. **Overlay:** inside `canvasRef`, `<PenOverlay v-if="session" :key="session.key" ref="penOverlayRef" :pen="session.pen" :view="session.view" :width="canvasDisplay.w" :height="canvasDisplay.h" keyboard="host" class="absolute inset-0" @commit="commitSession" @cancel="cancelSession" />`.
4. **Pointers:** in `onCanvasPointerDownCapture`, `if (session.value) return` (no preventDefault) before any other branch that would claim the event, so it reaches the overlay; same early return in the artboard's pointermove/pointerup handlers and in `onCanvasDblClickCapture`. Stage pan (middle button / Space) still runs first — the host owns pan.
5. **Toolbar:** inside the bottom container (CM:9105), when `session.value`: render `<PenToolbar :pen="session.pen" class="pointer-events-auto" @commit="commitSession" @cancel="cancelSession" />` **instead of** the agent prompt dock and the tool row (`v-if/v-else`). The container is bottom-anchored, so the rules and value rows grow upward.
6. **Keys** (Decision 5): at the top of the capture `onKeydown`, after the live-viewDrag handling: `if (session.value) { if (<Space or ⌘=/⌘−/⌘0/⌘2>) { fall through to the existing viewport handling for that key only } else { penOverlayRef.value?.onHostKeydown(e); e.stopPropagation(); return } }`. Same for `onKeyup` → `onHostKeyup`. In the bubble `handleKeydown`, first line: `if (session.value) return`.
7. **Delete** `app/composables/useVectorPen.ts`; grep the repo for `useVectorPen` / `buildPathLayerFromAnchors` — only comments may remain (update `useBrushMask.ts:7` and `pathFlatten.ts:26` comments to name the shared pen).

- [ ] **Step 1: Failing Playwright test** `tests/frame-pen.spec.ts` (foreground), on `/dev/frame-lab` (wait for `[data-ready]`):
  - Click the toolbar's pen button (`title` starts with "Pen"); assert the pen toolbar is visible (`[data-tool="path"]`) and the Frame tool row is gone.
  - With `page.mouse`: click three points on the artboard, then click the first point to close; press Enter (real keyboard).
  - Assert via `window.__compositorLayers()`: one new `kind:'path'` layer with a `sketch`, `closed` fill `#3b82f6`, and `d === ` the session's `sketchToLocalD(sketch)` (compute in-page by importing nothing — assert `d` is non-empty and `sketch.entities.length >= 4`), and its on-screen bbox centre is within 3 px of the centre of the three clicked points' bbox.
  - Open the pen again, place one point, press **Escape** twice: the pen closes and **the modal is still open**; the layer count is unchanged.
  - Open the pen, select nothing, press **Delete**: the previously added layer still exists.
  - Press ⌘Z with the pen open after drawing two points: the pen's drawing loses a point, and the Frame's layer list is unchanged.
  Run: FAIL.
- [ ] **Step 2:** Implement the session composable and the wiring above.
- [ ] **Step 3:** Run `tests/frame-pen.spec.ts` + `tests/sketch-draw.spec.ts` + the frame-lab specs that touch the toolbar (`tests/frame-layout-tab.spec.ts`, `tests/frame-recolour.spec.ts`) in the foreground; unit suites for pen/sketch/compositor. All green.
- [ ] **Step 4:** Commit: `feat(frame): the pen tool draws with the shared pen; the old pen is gone`.

---

### Task 8: Reopen a drawn path (double-click), live preview, any transform

**Files:**
- Modify: `app/composables/frame/useFramePenSession.ts`, `app/components/vue-canvas/CompositorModal.vue`
- Test: `tests/frame-pen.spec.ts` (+ cases)

Behaviour for `{ kind: 'layer', id }`:
- `open`: `original = layers().find(id)`; `host.recordHistory()` **once**; `doc = ref(cloneDoc(original.sketch))`; `view = computed(() => layerView(<live placement of the layer>, W, H))`; `pen = usePen({ doc, view, onChange: preview, onLiveChange: preview })`.
- `preview()` (no history): `commit(layers().map(l => l.id === id ? { ...l, d: sketchToLocalD(doc.value), sketch: cloneDoc(doc.value) } : l))` — the layer itself renders the live drawing with its own fill, stroke and effects; `x`/`y`/`bbox` untouched during the session.
- `commitSession`: `finishSession()`; if no outline → treat as cancel. Else `r = recentreSketch(doc)`, `{x,y} = placementAfterRecentre(original, r.shiftLocal, W, H)`, `commit(... { ...l, d: sketchToLocalD(r.sketch), sketch: r.sketch, bbox: r.bbox, x, y })` — the one undo step was recorded at open.
- `cancelSession`: `commit` the layer back to `original` exactly (the history entry recorded at open stays harmless: undoing it restores the same state).

Frame wiring:
- In `onCanvasDblClickCapture` (design size): if the hit layer is a local `kind:'path'` **with** a `sketch` → `open({ kind: 'layer', id })` instead of `enterNodeEdit`. Without a `sketch` → `enterNodeEdit` exactly as today. At a viewing size (`onViewDblClick`) keep today's order: `backToDesignSize()`, `nextTick`, then the same branch.

- [ ] **Step 1: Failing Playwright cases** (real `page.mouse.dblclick`):
  - Draw a closed triangle (Task 7 flow), commit; double-click its outline → pen toolbar visible, overlay shows three anchor dots at the triangle's corners (within 3 px of the layer's on-screen corners).
  - Drag one corner with `page.mouse` → the Frame layer's `d` changes live (read `__compositorLayers()` mid-session); press Enter → `x`,`y`,`bbox` updated, the outline's on-screen corners are where the dragged corner ended (±3 px), one ⌘Z (after closing the pen) restores the triangle exactly.
  - **Rotated + scaled layer:** `__compositorSetLayers` the triangle to `rotation: 35, scale: 1.4`; double-click; click-drag a corner to a known screen point → after Enter that corner is at that screen point (±3 px).
  - Escape during an edit → the layer is back to its pre-edit `d`/`sketch` byte-for-byte.
  - A library shape (no `sketch`) double-clicked → the old point editor opens (its top bar "Done (Esc)" appears), not the pen.
  Run: FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `tests/frame-pen.spec.ts` (foreground) + unit suites: green.
- [ ] **Step 4:** Commit: `feat(frame): double-click a drawn path to reopen the pen, live, at any rotation`.

---

### Task 9: Text "Drawn path" with the shared pen

**Files:**
- Modify: `app/composables/frame/useFramePenSession.ts`, `app/components/vue-canvas/CompositorModal.vue` (the custom-path panel block, `drawGuideForSelectedText`, `useFramePathAsGuide`)
- Test: `tests/frame-pen.spec.ts` (+ cases)

Behaviour for `{ kind: 'guide', textId }`:
- `open`: `text = layers().find(textId)`; `host.recordHistory()` once; `doc = ref(text.path?.sketch ? cloneDoc(text.path.sketch) : empty)`; `pen = usePen({ doc, view, options: { openOnly: true, tools: ['select', 'path', 'curve'] }, onChange: preview, onLiveChange: preview })`.
- `view`: when the guide has a `sketch` → `guideView(text, text.path, W, H)`; for a fresh guide (no sketch) → `layerView({ x: text.x, y: text.y, rotation: text.rotation, skewX: text.skewX, skewY: text.skewY, scale: 1 }, W, H)` (you draw at true size around the text's origin). The view is **fixed for the session** (captured at open) so the drawing does not jump when the guide re-centres itself.
- `preview()`: when the drawing has an outline, `commit` the text layer with `path: { ...text.path, follow: 'custom', d: sketchToLocalD(doc), sketch: cloneDoc(doc), size: <session size> }`, where session size = the opening `text.path.size` for an existing guide, or, for a fresh guide, the flattened x-extent of the current `d` (so the refit factor is 1 and the type sits where it is drawn). The type re-lays live.
- `commitSession`: `finishSession()`; no outline → cancel; else the same write as `preview()` (no re-centring — `guideFromPathD` re-centres by itself). Select the text layer.
- `cancelSession`: restore the text layer exactly.

Frame wiring:
- `drawGuideForSelectedText` → `open({ kind: 'guide', textId: selected.id })`.
- Panel button copy: `textPath.sketch ? 'Edit the path' : 'Draw a path'` (title attributes: "Edit the path this type follows" / "Draw the path this type will follow").
- `useFramePathAsGuide(l, id)`: also copy `sketch: src.sketch ? cloneDoc(src.sketch) : undefined`.
- A guide with `d` but no `sketch` shows "Draw a path"; a new drawing replaces it.

- [ ] **Step 1: Failing Playwright cases:**
  - Select the frame-lab's text layer, Follow a path → Drawn path, click "Draw a path"; draw an open arc with `page.mouse` (click, then click-drag to bow); mid-drag the text layer's `path.d` is already non-empty (live); Enter → `path.follow === 'custom'`, `path.sketch` present, `d === sketchToLocalD(sketch)` shape (non-empty), the panel button now reads "Edit the path".
  - The Close button is absent in the pen toolbar and the Circle tool is not offered.
  - Click "Edit the path"; the overlay's first anchor dot is within 3 px of where the first click landed; drag the end point; Enter; change **Path size** in the panel; click "Edit the path" again → the anchor dots sit on the resized guide (first dot within 3 px of the guide's start as drawn — read `__compositorTextOutline` or compute from the layer).
  - Escape while editing → `path` restored exactly.
  Run: FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `tests/frame-pen.spec.ts` + `tests/unit/compositor-text-path.unit.spec.ts` + `tests/compositor-text-outline.spec.ts` (foreground): green.
- [ ] **Step 4:** Commit: `feat(frame): draw and edit a text guide with the shared pen`.

---

### Task 10: Record

**Files:** `docs/STATE.md`, the spec's status line, memory (`shared-pen-plan-a-landed.md` → add Plan B; `MEMORY.md` pointer), the build dashboard (controller).

- [ ] **Step 1:** STATE.md entry "Shared pen — Plan B (the Frame)", plain language: what you can do, what was proven, commits, next (Plan C, Shape Studio).
- [ ] **Step 2:** Spec status → "Plan B built"; tick the "Carried into Plan B" items that landed and name any that did not.
- [ ] **Step 3:** Commit: `docs(pen): Plan B built — the Frame draws with the shared pen`.
