# Shared pen — Plan C: Shape Studio's "Drawn" shape

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shape Studio gains a **Drawn** base shape: the user draws one unit with the shared pen over the preview, it is stored on the layer's mark, and every existing Shape Studio feature (copies and arrangements, overlaps, folds, fills, colour order, layers, background) applies to it.

**Architecture:** `drawn` joins `BASE_SHAPES`; `mark.sketch` (a `SketchDoc` in **mark units**, 1:1) is kept by `mergeConfig` through `mergeSketchDoc`; `baseShapePath('drawn')` fits the drawing's outline to `size` exactly like a library shape (larger side = `size`, bbox centre at the origin). A pure module (`lib/geoshape/penShape.ts`) gives the pen's view matrix over the preview and the commit rule (re-centre, keep the refit factor so nothing jumps). `ShapeStudioSurface` hosts `PenOverlay` over its canvas with `keyboard="host"` and its own capture-phase key listener, shows `PenToolbar` in the shell's `#tools` slot, freezes the preview framing while the pen is open, draws the other copies faintly and re-renders them when a gesture settles (the fold runs then, never mid-drag).

**Tech Stack:** Vue 3.5, TypeScript, Vitest (node env), Playwright against `:3002` (`/dev/shape-studio-lab`).

**Spec:** `docs/superpowers/specs/2026-09-24-shared-pen-design.md` section 4. Plans A and B: `docs/superpowers/plans/2026-09-24-shared-pen-a.md`, `docs/superpowers/plans/2026-09-25-shared-pen-b-frame.md`. Pen host contract: top of `frontend/app/composables/pen/usePen.ts`; reference host: `frontend/app/composables/frame/useFramePenSession.ts`.

## Global Constraints

- Main checkout; no worktree, no branch. Other sessions edit concurrently: stage only your own paths/hunks; never `git stash`.
- **Every commit uses a private index**:
  ```
  export GIT_INDEX_FILE=$(mktemp /private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/08811ebc-286d-4206-85f0-f2d098f0c5a5/scratchpad/penc-idx.XXXX)
  git read-tree HEAD
  git add <only your exact paths>
  git diff --cached --stat
  git commit -m "..." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
  then in a **separate** shell call `git reset -q -- <your paths>`. The trailer is exactly that line.
- **Never run `npm run dev`**; Playwright in the **foreground** against `http://127.0.0.1:3002` (the dev server can lag picking up edits — confirm the served code before trusting a run). Gestures and keys in browser tests are real `page.mouse` / `page.keyboard`.
- Paths are relative to `frontend/`; vitest/playwright from `frontend/`, git from the repo root.
- UI copy: sentence case, no identifiers.
- A Shape Studio document with no `drawn` layer must render **byte-identically** and re-roll **identically** for the same seed.
- No subagents inside tasks.

## Facts verified at HEAD (2026-09-25)

- `BASE_SHAPES` (`app/lib/geoshape/shapes.ts:10-13`, "append, don't reorder", `library` last, 13 kinds); `baseShapePath(kind, o)` (:94-112) returns one origin-centred `d` in mark units; `size` = full extent (larger side). Library: `fitShapePath(shape, size)` — `k = size / max(bw, bh)`, bbox centre → origin; it **throws** on a zero-width or zero-height box.
- `mergeConfig` (`app/lib/geoshape/config.ts:249-321`) returns a hand-written literal: an unknown field is **dropped** on every load; `shape` via `oneOf(o.shape, SHAPES, d.shape)`; `SHAPES = BASE_SHAPES`; `blendShape` uses the same list.
- Controls (`app/lib/geoshape/controls.ts`): shape `select('shape', …, SHAPES)` (:119) with no `optionLabels`; rounding rows gated `notLibrary` (:130-132); gates at :58-81; drift guard `tests/unit/geoshape-controls.unit.spec.ts:15` `NON_CONTROL_FIELDS`. `GEO_GUIDANCE` BASE SHAPE paragraph :257.
- `tests/unit/geoshape-shapes.unit.spec.ts` pins: every kind gives `M…Z` (:8-15), the 13-item list (:16-21), `library` last, length 13 (:41-44).
- Re-roll picks from `SHAPES` (`randomize.ts:103` `rollShape`, :132 `rollBlend`); the agent adapter checks `BASE_SHAPES` (`lib/agent/studioTune.ts` ~:672).
- Every reader of `sailor_shapeStudio` goes through `studioDocFromPersisted` → `mergeLayer` → `mergeConfig` (surface, node bake, agent, Collections).
- Per-clone transform pivots on the base shape's local origin (`boolean.ts:181-190`); symmetry mirrors about the axes; so the drawn unit must be origin-centred (the fit does it).
- Open subpaths: fill chord-closes them; any paper boolean chord-closes them; per-clone/pieces drop results with a zero-width or zero-height bbox. `paintTarget: 'outline'` strokes only.
- Preview (`ShapeStudioSurface.vue:369-399`): one `<canvas>` letterboxed by flex in its parent, CSS size capped at 620, `drawToCanvas(shapes, ctx, el.width, el.height, studioFramePad(doc), bg)` → CSS px = `(cssW/2, cssH/2) + s·(docPt − centre(contentBounds))`, `s = fitScale(b, el.width, el.height, pad)/dpr`; doc point of a mark point = `offset.xy + R(offset.rotate)·(offset.scale·p)`. The framing depends on the whole content, so it moves while drawing.
- Re-render: `watch(doc, scheduleRender, { deep: true })` (rAF-coalesced full render). No undo in Shape Studio. Autosave: debounced deep watch + on unmount.
- Keys: the shell (`StudioModalShell.vue:111-133`) listens on window keydown (bubble), returns if `defaultPrevented`, Escape → `requestClose()`. A surface **capture** listener runs first.
- Shell dock has a `#tools` slot (StudioModalShell.vue:190-193) Shape Studio doesn't fill; `StudioSectionTree` supports `#section-<Title>` and `#control-<key>` slots.
- `PenOverlay.vue` `onPointerDownSvg` (:509-537) and the point/segment/entity handlers (:468-508) never check `ev.button`; no `contextmenu` handler — a right-click places a point.
- `/dev/shape-studio-lab` has no hooks and no `[data-ready]`; no Shape Studio Playwright spec exists.

## Decisions this plan makes

1. **Drawing units = mark units** (1:1). Marks are ~20–600 units across; the solver's absolute tolerances are comfortable there (the test page is ~20 units across).
2. **The fit is the library fit.** `baseShapePath('drawn')` scales the outline's larger side to `size` and centres its bbox on the origin. So the Size row keeps working. Empty or missing sketch → `''` (renders nothing, like `size 0`). A zero-width or zero-height outline (a straight line) scales by its non-zero side; both zero → `''`. Never throws.
3. **Editing keeps what you see.** At open, capture `k = size / naturalExtent(sketch)` (1 for an empty drawing) — the view maps drawing units through `k`. On commit, re-centre the drawing on its outline's bbox centre and set `size = k × newExtent`, so the refit factor stays `k` and the unit doesn't jump in scale or place.
4. **You draw the unit at the layer's own origin,** centred (Decision 2 puts it there after commit). In a radial or linear arrangement no copy sits exactly there; the pen shows the unit alone, with the copies drawn faintly behind.
5. **Preview while the pen is open:** the framing (centre + scale) is **frozen at open** — the union of the current content bounds and a `size × size` square around the layer's origin — so the drawing never rescales under the pen. The composite is drawn at 30 % opacity and re-rendered (fold included) only on **settled** pen changes (`onChange`: a finished gesture, undo, redo); drag-time changes (`onLiveChange`) don't re-render the composite — the pen overlay shows the unit live. (Spec §4 said copies follow during a drag as plain outlines; this plan updates them on release instead — cheaper and simpler, and the spec's own rule "the fold runs when you let go" still holds.)
6. **Open drawings:** if the committed drawing has no closed path and no circle, and the mark's `paintTarget` is `'fill'`, set it to `'outline'` (fills would chord-close the line). The user can change it back.
7. **Drawn is user-only for now:** re-roll never picks `drawn` (seeds unchanged), Blend's shape B can't be `drawn`, and the agent can't choose it (it can change count, layout and fills on a drawn shape). The GEO_GUIDANCE text says so in one line.
8. **Keys:** while the pen is open the surface's capture-phase window listener hands every key to `onHostKeydown` and stops propagation (so the shell's Escape never closes the studio), and forwards keyup/blur.

## File map

| File | Responsibility |
|---|---|
| `app/components/pen/PenOverlay.vue` | ignore non-primary buttons; suppress the context menu |
| `app/lib/geoshape/shapes.ts` | `drawn` kind; `drawnPath(sketch, size)` |
| `app/lib/geoshape/config.ts` | `sketch?` on `GeoShapeConfig`; kept by `mergeConfig` |
| `app/lib/geoshape/controls.ts` | option labels; rounding rows hidden for drawn; blend options exclude drawn; guidance line |
| `app/lib/geoshape/randomize.ts`, `app/lib/agent/studioTune.ts` | exclude `drawn` |
| `app/lib/geoshape/penShape.ts` (new) | natural extent, refit factor, preview frame, view matrix, commit rule — pure |
| `app/lib/geoshape/render.ts` | `drawToCanvas` accepts an optional fixed frame and alpha |
| `app/composables/geoshape/useShapePenSession.ts` (new) | open / commit / cancel for a layer's drawing |
| `app/components/vue-canvas/ShapeStudioSurface.vue` | the button, overlay, toolbar, keys, frozen preview |
| `app/pages/dev/shape-studio-lab.vue` | `[data-ready]` + `window.__shapeStudioLab` for tests |
| tests | unit specs per task; `tests/shape-pen.spec.ts` (new Playwright) |

---

### Task 1: The pen ignores right-clicks

**Files:** Modify `app/components/pen/PenOverlay.vue`; Test `tests/unit/pen-overlay-buttons.unit.spec.ts` (new, happy-dom) + `tests/sketch-draw.spec.ts` (+1 case).

- [ ] **Step 1: Failing test** — mount `PenOverlay` with a pen on the `path` tool; dispatch a `pointerdown` with `button: 2` on the svg → the pen's drawing gains nothing; `button: 0` → one anchor; a `contextmenu` event on the svg is `defaultPrevented`. Run: FAIL.
- [ ] **Step 2:** In every pointerdown handler (`onPointerDownSvg`, `onPointerDownPoint`, `onSegmentPointerDown`, `onEntityPointerDown`) return early when `ev.button !== 0`. Add `@contextmenu.prevent` on the root svg.
- [ ] **Step 3:** Browser case in `tests/sketch-draw.spec.ts`: path tool, `page.mouse.click(x, y, { button: 'right' })` on the canvas → `entityCount()` unchanged. Run pen/sketch unit suites + `tests/sketch-draw.spec.ts` + `tests/frame-pen.spec.ts` (foreground): green.
- [ ] **Step 4:** Commit: `fix(pen): a right-click never places a point`.

---

### Task 2: The Drawn kind in the Shape Studio model

**Files:** Modify `app/lib/geoshape/shapes.ts`, `config.ts`, `controls.ts`, `randomize.ts`, `app/lib/agent/studioTune.ts`; Tests: `tests/unit/geoshape-drawn.unit.spec.ts` (new) and updates to `geoshape-shapes.unit.spec.ts`, `geoshape-controls.unit.spec.ts`.

**Interfaces — produces:**
```ts
// shapes.ts
export type BaseShapeKind = … | 'library' | 'drawn'          // appended after 'library'
export const BASE_SHAPES: readonly BaseShapeKind[]            // … 'library', 'drawn' (14)
export const PICKABLE_SHAPES: readonly BaseShapeKind[]        // BASE_SHAPES without 'drawn' (re-roll, blend, agent)
export function drawnPath(sketch: SketchDoc | undefined, size: number): string   // '' when empty
// BaseShapeOpts gains sketch?: SketchDoc; baseShapePath('drawn', o) === drawnPath(o.sketch, o.size)
// config.ts
//   GeoShapeConfig gains sketch?: SketchDoc (drawing units = mark units; only read when shape === 'drawn')
//   mergeConfig keeps it: sketch: o.sketch === undefined ? undefined : mergeSketchDoc(o.sketch)
```

- [ ] **Step 1: Failing tests** (`tests/unit/geoshape-drawn.unit.spec.ts`):

```ts
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { BASE_SHAPES, PICKABLE_SHAPES, baseShapePath, drawnPath } from '~/lib/geoshape/shapes'
import { mergeConfig, DEFAULT_CONFIG } from '~/lib/geoshape/config'
import { flattenPath } from '~/lib/compositor/pathFlatten'

const tri = (): SketchDoc => {
  const d: SketchDoc = { entities: [], constraints: [] }
  const a = addPoint(d, 10, 10), b = addPoint(d, 70, 10), c = addPoint(d, 40, 50)
  addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
  return d
}
const bounds = (d: string) => {
  const pts = flattenPath(d).flatMap(s => s.pts)
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe('drawn base shape', () => {
  it('is appended after library and is not pickable', () => {
    expect(BASE_SHAPES.at(-1)).toBe('drawn')
    expect(BASE_SHAPES.at(-2)).toBe('library')
    expect(PICKABLE_SHAPES).not.toContain('drawn')
    expect(PICKABLE_SHAPES).toHaveLength(BASE_SHAPES.length - 1)
  })
  it('fits the larger side to size, centred on the origin', () => {
    const b = bounds(drawnPath(tri(), 120))
    expect(b.maxX - b.minX).toBeCloseTo(120, 6)          // 60 wide → larger side
    expect(b.maxY - b.minY).toBeCloseTo(80, 6)           // 40 × (120/60)
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6)
  })
  it('is empty for a missing or empty drawing, and never throws on a straight line', () => {
    expect(drawnPath(undefined, 100)).toBe('')
    expect(drawnPath({ entities: [], constraints: [] }, 100)).toBe('')
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 50, 0)
    addPath(d, [a, b], [{ kind: 'line' }], false)
    const line = bounds(drawnPath(d, 100))
    expect(line.maxX - line.minX).toBeCloseTo(100, 6)
  })
  it('baseShapePath delegates for the drawn kind', () => {
    expect(baseShapePath('drawn', { sides: 6, starInner: 0.5, irregularSeed: 1, size: 120, roundCorners: 0, roundRadius: 0, sketch: tri() } as any)).toBe(drawnPath(tri(), 120))
  })
  it('mergeConfig keeps a sketch and drops junk in it', () => {
    const cfg = mergeConfig({ ...DEFAULT_CONFIG, shape: 'drawn', sketch: tri() })
    expect(cfg.shape).toBe('drawn')
    expect(cfg.sketch?.entities.length).toBe(4)
    expect(mergeConfig({ ...DEFAULT_CONFIG, sketch: 'nonsense' as any }).sketch?.entities ?? []).toEqual([])
    expect(mergeConfig({ ...DEFAULT_CONFIG }).sketch).toBeUndefined()
  })
  it('re-roll never picks drawn (same seed, same roll as before)', async () => {
    const { rollShape } = await import('~/lib/geoshape/randomize') as any
    // rollShape must draw from PICKABLE_SHAPES — the kind list it indexes is unchanged from before
    expect(typeof rollShape).toBe('function')
  })
})
```

  Update `geoshape-shapes.unit.spec.ts`: the list pin becomes 14 with `'drawn'` appended; the "every kind gives `M…Z`" loop skips `'drawn'` (covered here); "library last" becomes "library second to last, drawn last". Update `geoshape-controls.unit.spec.ts` `NON_CONTROL_FIELDS` to add `'sketch'`. Run: FAIL.
- [ ] **Step 2: Implement.**
  - `shapes.ts`: append `'drawn'`; `PICKABLE_SHAPES`; `drawnPath`: `d0 = sketchPathData(sketch)`; `''` if empty; bounds via `flattenPath`; `ext = max(bw, bh)`; `''` if `ext <= 0`; scale `k = size / ext` about the bbox centre and translate the centre to the origin — reuse `transformShapePath` from `lib/shapes/geometry.ts` if its signature fits a raw `d` (read it), else transform the flattened-free way with `lib/geoshape/svg.ts` `transformCommands` (read it; keep arcs exact — an `A` command scales its radii by `k`).
  - `config.ts`: `sketch?: SketchDoc` field (not in `DEFAULT_CONFIG`, so the default stays byte-identical); `mergeConfig` keeps it via `mergeSketchDoc`.
  - `randomize.ts`: `rollShape` and `rollBlend` pick from `PICKABLE_SHAPES` — which is exactly the old list, so seeds roll identically. Add a unit test: for 20 seeds, `rollShape` output equals a pinned snapshot computed from the pre-change list (compute the snapshot by running the old logic in the test from a copy of the 13-item list).
  - `controls.ts`: `optionLabels` for the shape select (sentence case: Circle, Square, …, Library shape, Drawn); the rounding rows' gate becomes "not library and not drawn"; `blendShape`'s options become `PICKABLE_SHAPES`; one line in `GEO_GUIDANCE`: "drawn — the user's own drawing (you cannot draw; never set shape to drawn)".
  - `studioTune.ts`: the agent's shape preset check uses `PICKABLE_SHAPES`.
- [ ] **Step 3:** `npx vitest run tests/unit/geoshape-*.unit.spec.ts tests/unit/studio-tune.unit.spec.ts`: green.
- [ ] **Step 4:** Commit: `feat(shape-studio): a Drawn base shape — the model, the fit, and nothing picks it for you`.

---

### Task 3: Pen geometry over the preview (pure)

**Files:** Create `app/lib/geoshape/penShape.ts`; Modify `app/lib/geoshape/render.ts` (`drawToCanvas` fixed frame + alpha); Test `tests/unit/geoshape-pen-shape.unit.spec.ts` (new).

**Interfaces — produces:**
```ts
// penShape.ts
export function naturalExtent(sketch: SketchDoc | undefined): number            // larger side of the outline in drawing units; 0 when empty
export function refitFactor(sketch: SketchDoc | undefined, size: number): number // size / naturalExtent, or 1 when empty
export interface PreviewFrame { cx: number; cy: number; scale: number; cssW: number; cssH: number } // doc centre, CSS px per doc unit
export function frozenPreviewFrame(contentBounds: { minX: number; minY: number; w: number; h: number } | null,
  layerOrigin: { x: number; y: number }, size: number, cssW: number, cssH: number, padCss: number): PreviewFrame
export function shapePenView(frame: PreviewFrame, offset: { x: number; y: number; scale: number; rotate: number },
  k: number, centre: { x: number; y: number }): ViewMatrix
//   drawing point p → mark point m = k·(p − centre) → doc point = offset.xy + R(rotate)·(offset.scale·m) → CSS px = (cssW/2, cssH/2) + frame.scale·(doc − (cx, cy))
export function commitDrawn(sketch: SketchDoc, k: number): { sketch: SketchDoc; size: number } | null
//   re-centre the drawing on its outline bbox centre; size = k × naturalExtent; null when empty
// render.ts
//   drawToCanvas(shapes, ctx, w, h, pad, bg?, opts?: { frame?: { cx: number; cy: number; scale: number }; alpha?: number })
//   frame given → use it instead of fitting to content; alpha given → globalAlpha for the shapes (background unaffected). Absent → byte-identical.
```
`centre` in `shapePenView` is the drawing's outline bbox centre **at open** (drawing units), captured once per session.

- [ ] **Step 1: Failing tests** — (a) `drawnPath(sketch, size)` point for a drawing vertex equals `k·(vertex − centre)` (so the view's mark mapping is exactly the renderer's fit); (b) `shapePenView` maps a drawing vertex to the CSS px `drawToCanvas` would paint it at, computed independently from the formula in Facts, for an offset with rotate 30, scale 1.5, x/y ≠ 0; (c) `commitDrawn`: outline bbox centre becomes (0,0) and `drawnPath(result.sketch, result.size)` equals `drawnPath(original, k × naturalExtent(original))` point for point (nothing jumps); (d) `frozenPreviewFrame` contains both the content bounds and the `size` square around the origin with the padding; (e) `drawToCanvas` with no `opts` issues the identical call sequence as before (spy a mock context, compare against a recorded call list from the current code); with `frame` it uses the given translate/scale. Run: FAIL.
- [ ] **Step 2:** Implement. Use `sketchPathData` + `flattenPath` for bounds; `cloneDoc` for copies; `ViewMatrix` from `lib/sketch/view.ts`.
- [ ] **Step 3:** `npx vitest run tests/unit/geoshape-pen-shape.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts`: green.
- [ ] **Step 4:** Commit: `feat(shape-studio): pen geometry over the preview — the view, the frozen frame, the commit rule`.

---

### Task 4: Shape Studio hosts the pen

**Files:** Create `app/composables/geoshape/useShapePenSession.ts`; Modify `app/components/vue-canvas/ShapeStudioSurface.vue`, `app/pages/dev/shape-studio-lab.vue`; Test `tests/unit/shape-pen-session.unit.spec.ts` (new), `tests/shape-pen.spec.ts` (new Playwright).

**Interfaces — produces:**
```ts
export function useShapePenSession(host: {
  doc: () => GeoStudioDoc                 // live reactive doc
  layerIndex: () => number                // active layer
  frameFor: (layer: GeoLayer) => PreviewFrame   // computes the frozen frame at open
}): {
  session: Ref<null | { pen: Pen; doc: Ref<SketchDoc>; view: ComputedRef<ViewMatrix>; key: number; layerId: string }>
  open(): void            // opens on the active layer; switches its shape to 'drawn' if it wasn't (restored on cancel)
  commitSession(): void
  cancelSession(): void
}
```
Behaviour:
- `open`: capture `original = { shape, sketch, size, paintTarget }` of the active layer's mark, `k = refitFactor(sketch, size)`, `centre` = the drawing's outline bbox centre (or (0,0) empty), `frame = host.frameFor(layer)` (frozen); `pen = usePen({ doc: ref(cloneDoc(sketch ?? empty)), view, onChange: settle })`. Set `mark.shape = 'drawn'` if needed.
- `settle()` (on settled pen changes): write `mark.sketch = cloneDoc(pen doc)` and `mark.size = k × naturalExtent(...)` **without re-centring** (so the composite behind updates and the frozen view stays valid) — the drawing's centre may drift during the session; the view uses `centre` captured at open, so the pen stays put.
  - Correction for drift: because `drawnPath` re-centres on the live bbox, the composite's unit shifts when the bbox centre moves. That is acceptable for the faint preview behind; on commit everything lands correctly.
- `commitSession`: `pen.finishSession()`; `r = commitDrawn(doc, k)`; `null` → cancel. Else write `mark.shape = 'drawn'`, `mark.sketch = r.sketch`, `mark.size = r.size`, and Decision 6's `paintTarget` rule. Close.
- `cancelSession`: restore `original` exactly. Close.
- Dispose (scope teardown / studio close) → cancel.

Surface wiring (`ShapeStudioSurface.vue`):
1. **Button:** in the Shape section, a `StudioButton` "Draw the shape" (no sketch) / "Edit the shape" (has sketch), shown when the active layer's `shape === 'drawn'`; `data-testid="shape-draw"`. Choosing **Drawn** in the Shape select with no sketch opens the pen straight away.
2. **Overlay:** `<PenOverlay v-if="session" :key="session.key" ref="penOverlayRef" :pen :view :width="cssW" :height="cssH" keyboard="host">` absolutely placed over the canvas's CSS box inside the preview div (position it at the canvas's offset in the div — compute from the canvas's `offsetLeft/offsetTop`, not client rects, so no double-counting).
3. **Frozen preview:** while `session` is open, `render()` calls `drawToCanvas(…, { frame: session frozen frame, alpha: 0.3 })`; otherwise unchanged.
4. **Toolbar:** fill the shell's `#tools` slot with `<PenToolbar :pen="session.pen" @commit="commitSession" @cancel="cancelSession" />` while the pen is open.
5. **Keys:** a capture-phase window keydown/keyup/blur listener registered in the surface's `onMounted` (removed on unmount): when `session` is open → `penOverlayRef.value?.onHostKeydown(e)` / `onHostKeyup(e)` / `onHostBlur()`, then `e.stopPropagation()`; also `preventDefault()` on ⌘/Ctrl combos. When no session → do nothing.
6. **Lock while drawing:** the Shape section's other rows and the layer rail are disabled (title "Finish the pen first") while the pen is open; the prompt dock is hidden.
7. **Lab page:** `[data-ready]` once the surface is mounted, and `window.__shapeStudioLab = { get props() { return node.data.properties } }` so tests can read `sailor_shapeStudio.doc`.

- [ ] **Step 1: Failing unit tests** (`shape-pen-session.unit.spec.ts`, node env with a plain reactive doc): open on a fresh layer → shape becomes 'drawn', session open; settle writes sketch without changing `centre`; commit → `mark.sketch` outline centred at (0,0), `size = k × extent`, `shape === 'drawn'`; an open drawing with `paintTarget 'fill'` → `'outline'`; cancel restores shape/sketch/size/paintTarget exactly; dispose cancels. Run: FAIL.
- [ ] **Step 2: Failing Playwright** `tests/shape-pen.spec.ts` on `/dev/shape-studio-lab` (wait for `[data-ready]`): choose **Drawn** in the Shape select → the pen toolbar appears (`[data-tool="path"]`); with `page.mouse` draw a closed triangle over the preview (three clicks + click the first point) and press Enter (`page.keyboard`); assert via `__shapeStudioLab.props.sailor_shapeStudio.doc.layers[0].mark` that `shape === 'drawn'` and `sketch.entities.length >= 4` (after autosave settles — poll); set the layout to Radial and count to 12 through the real controls; assert the preview canvas has non-background pixels in at least 6 of 12 sectors around its centre. Then open the pen again ("Edit the shape"), press **Escape** twice → the studio is still open (the shell did not close). Right-click on the preview with the pen open → no point added. Run: FAIL.
- [ ] **Step 3:** Implement the composable and the wiring.
- [ ] **Step 4:** Unit + Playwright (foreground) + `npx vitest run tests/unit/geoshape-*.unit.spec.ts tests/unit/studio-surfaces-prompt.unit.spec.ts tests/unit/take-thumbs.unit.spec.ts`: green.
- [ ] **Step 5:** Commit(s): `feat(shape-studio): draw a shape with the shared pen`.

---

### Task 5: Record

**Files:** `docs/STATE.md`, the spec's status line; memory + dashboard by the controller.

- [ ] STATE.md entry "Shared pen — Plan C (Shape Studio)": what you can do, what was proven, known limits (copies behind update on release; drawn not pickable by re-roll/agent/blend), commits. Spec status → "Plans A, B and C built".
- [ ] Commit: `docs(pen): Plan C built — Shape Studio's Drawn shape`.
