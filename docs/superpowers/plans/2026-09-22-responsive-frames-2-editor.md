# Responsive Frames — Slice 2: the editor (look-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Frame responsive and *look at* it at other sizes in the editor — the "Responsive" size choice, draggable artboard edges, a size readout, the pins card, and guide lines — the first slice that actually calls `resolveLayout`.

**Architecture:** A responsive Frame stores `sailor_frame.responsive = true` and keeps its width/height as the *design size*. The editor holds a transient *viewing size* (never saved). When the viewing size differs from the design size, the render pipeline paints `resolveLayout(doc, viewW, viewH).layers` instead of the raw layers, and the artboard's on-screen shape follows the viewing aspect. Editing stays at the design size for now (slice 3 makes the canvas editable at a viewing size); at a viewing size the canvas is view-only, so the current selection's pins card and guide lines still show. Pure logic (pin inference, guide geometry, the edge-drag and readout maths) lives in small tested modules under `frontend/app/lib/frame/responsive/`; the Vue wiring in `CompositorModal.vue` and `ArtifactFrameNode.vue` is thin and browser-verified.

**Tech Stack:** Vue 3 + TypeScript (Nuxt 4), the existing `paintLayerStack` Canvas2D painter, the studio control components (`StudioSelect`/`StudioSwitch`/`StudioSegmented`/`StudioSection`), Vitest for the pure modules, the built-in browser preview for the Vue wiring.

**Spec:** `docs/superpowers/specs/2026-09-21-frame-responsive-constraints-design.md` (sections "Fixed and responsive Frames", "Artboard edges and the size readout", "The inspector card: When the frame resizes", and Build order item 2). Slice 1 (the resolver) is on `main`.

## Global Constraints

- Work directly in the main checkout; no worktree, no feature branch (CLAUDE.md). (This plan file is authored from a worktree; the executor works wherever CLAUDE.md says.)
- **Never run `npm run dev`** — a shared dev server already runs on :3002. To see the app, use the built-in browser preview (`preview_start` / the browser tools), never a new server.
- **One dev server per checkout.** Before any preview, check what is already listening; reuse a healthy one.
- Commit by exact path every time (several sessions share the checkout): stage only your own files by exact path, never `git add -A`, never `git stash`.
- Unit tests: `cd frontend && node_modules/.bin/vitest run tests/unit/<file>` (config `frontend/vitest.config.ts`, include `tests/unit/**/*.unit.spec.ts`, env `node`). Run only your own spec files.
- Typecheck app files only: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep '<your files>'` must print nothing new. The baseline is NOT zero (~442 pre-existing errors in `app/components/**`); `nuxt typecheck` does NOT cover `tests/unit/**`.
- Layer geometry units (unchanged from slice 1): `x`,`y` are the layer CENTRE as fractions of frame width/height; every size (`w`,`h`,`fontSize`,`boxW`,`boxH`) is a fraction of frame WIDTH.
- The responsive flag lives at `sailor_frame.responsive === true`, in the same bag as `sailor_frame.preset` / `sailor_frame.displayEdge` / `sailor_frame.clock`. The design width/height are the node's `width`/`height` output widgets (read with `readNodeIntWidget` in the modal, `widgetVal`/`setWidget` in the node card).
- The viewing size is editor state only — a `ref`/`reactive` in `CompositorModal.vue`, never written to the doc. Reopening the modal starts at the design size.
- UI copy is sentence case, no internal identifiers (memory: `ui-copy-sentence-case-no-identifiers`). A `<select>` whose values are internal must use `optionLabels`.
- No new dependencies. Yoga and arranged groups are slice 4; editing at a viewing size is slice 3 — out of scope here.
- Byte-identical rule: a **fixed** Frame (the default, `responsive !== true`) must render and behave exactly as today. Every new branch is gated on `isResponsiveFrame(...)`, and `resolveLayout` is never called for a fixed Frame.

---

## Plain-language summary

Slice 1 built the maths; nothing in the app used it. Slice 2 turns it on for looking.

- You mark a Frame "Responsive" in its size picker. It keeps its current size as the size it's designed at.
- Open its editor and the artboard's right edge, bottom edge and corner are draggable. Drag one and the layout adapts live — that's `resolveLayout` running. A little readout (two number fields plus a "Shapes" menu) shows the size and a "Back to design size" button once you've wandered off.
- Select a layer and a card, "When the frame resizes", shows how it holds to the frame — chosen automatically, overridable. Thin guide lines show which edges it holds.
- You can't yet *edit* at a viewing size (that's slice 3): the canvas is view-only there, and any edit snaps back to the design size first. The selection you already had stays, so its card and guides show while you resize.
- A fixed Frame — every Frame today — is untouched: no draggable edges, no readout, no card, same pixels.

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/frame/responsive/preview.ts` (new) | Pure: `inferUnitPins`, `effectivePins`, `guideLinesFor` — inference + guide geometry for the selected layer |
| `frontend/app/lib/frame/responsive/viewport.ts` (new) | Pure: viewing-size maths — `shapePresets`, `resizeViewFromEdge`, `readoutLabel`, `clampViewSize` |
| `frontend/app/lib/frame/responsive/index.ts` (modify) | Re-export the two new modules' public functions |
| `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (modify) | "Responsive" in the size picker; "Designed at" labelling; sets/clears `sailor_frame.responsive` |
| `frontend/app/components/vue-canvas/CompositorModal.vue` (modify) | Viewing-size state; resolved-layer render; draggable edges; size readout; pins card; guide overlay; view-only guard |
| `frontend/app/components/vue-canvas/ResponsivePinsCard.vue` (new) | The "When the frame resizes" inspector card (keeps the modal template smaller) |
| `frontend/tests/unit/responsive-preview.unit.spec.ts` (new) | Tests for `preview.ts` |
| `frontend/tests/unit/responsive-viewport.unit.spec.ts` (new) | Tests for `viewport.ts` |

Rulings baked into this plan (record in the ledger at execution):

- **Ruling A — view-only at a viewing size.** Slice 2 does not edit at a viewing size (that is slice 3). At a viewing size the canvas is view-only: pointer interactions that would select, move, draw or edit text are suppressed; the existing selection persists so its pins card and guides show. "Back to design size" restores full interactivity. Selecting a *different* layer is done at the design size. — Cost if wrong: a workflow limitation slice 3 removes.
- **Ruling B — guides only when there is spare room.** At the exact design size `resolveLayout` returns identity with empty `boxes`, so guide lines are shown only at a viewing size (where there is spare room to illustrate). The pins card, which needs no box, shows at any size. — Cost if wrong: no guide at the design size, which has nothing to show anyway.
- **Ruling C — background/post/grid are not resolved.** Only `layers` (and `motion` when playing) come from `resolveLayout`; `background`, `postEffects` paint across the whole box already, and the grid is an editor guide that never reaches the painter. — Cost if wrong: none; matches slice 1's model.

---

### Task 1: Pin inference and guide geometry (`preview.ts`)

**Files:**
- Create: `frontend/app/lib/frame/responsive/preview.ts`
- Modify: `frontend/app/lib/frame/responsive/index.ts`
- Test: `frontend/tests/unit/responsive-preview.unit.spec.ts`

**Interfaces:**
- Consumes (all existing in the module): `buildUnits(layers, groups, ctx, W0, H0): Unit[]` and `type Unit` from `./units`; `inferPins(box, ref, canStretch): { h: PinH; v: PinV }` and `inferAxisPin` from `./infer`; `sectionsAt`, `sectionOf` from `./sections`; `FrameDoc`, `Pins`, `PinH`, `PinV`, `AxisMap`, `ResolvedBox` from `./types`.
- Produces:
  ```ts
  interface EffectivePins {
    h: PinH; v: PinV; keepSize: boolean; holdTo: 'frame' | 'section'
    hAuto: boolean; vAuto: boolean; keepAuto: boolean; holdAuto: boolean
    sectionAvailable: boolean          // a grid section contains the unit's box
    unitId: string                     // the unit the pins belong to (layer id / group id / source id)
  }
  function effectivePins(frame: FrameDoc, layerId: string, ctx: CanvasRenderingContext2D | null): EffectivePins | null
  interface GuideLines {                // segments in BOX-normalized coords (0..1 of the box), for an SVG overlay
    left?: number; right?: number       // x fractions where a vertical guide is drawn to that edge
    top?: number; bottom?: number       // y fractions
    centerX?: boolean; centerY?: boolean // draw the frame centre line
    box: ResolvedBox                     // the unit's resolved box, box px
  }
  function guideLinesFor(box: ResolvedBox, maps: { h: AxisMap; v: AxisMap }, W: number, H: number): GuideLines
  ```

`effectivePins` reads the STORED pins off the layer (or its unit's group / mask source) and, for each absent field, fills the inferred value and flags it automatic. The `holdTo` is `'section'` when the grid is on and the unit's box sits in one section (unless `pins.holdTo === 'frame'`). `guideLinesFor` maps the unit's held edges to guide segments: a `left`/`right` pin draws a guide to that edge; `both` draws to both; `center` draws the centre line; `relative` draws nothing (it slides, there is no edge to show).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-preview.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import { defaultGrid } from '~/lib/frame/grid'
import { effectivePins, guideLinesFor } from '~/lib/frame/responsive/preview'
import { axisMap } from '~/lib/frame/responsive/axis'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})

describe('effectivePins', () => {
  it('returns inferred pins flagged automatic when nothing is stored', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })   // near the left edge
    const e = effectivePins(doc([l]), 'a', null)!
    expect(e.h).toBe('left'); expect(e.v).toBe('middle')
    expect(e.hAuto).toBe(true); expect(e.vAuto).toBe(true); expect(e.keepAuto).toBe(true)
    expect(e.keepSize).toBe(false); expect(e.unitId).toBe('a')
  })
  it('a stored pin overrides the inferred one and is not flagged automatic', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right', keepSize: true } })
    const e = effectivePins(doc([l]), 'a', null)!
    expect(e.h).toBe('right'); expect(e.hAuto).toBe(false)
    expect(e.keepSize).toBe(true); expect(e.keepAuto).toBe(false)
    expect(e.v).toBe('middle'); expect(e.vAuto).toBe(true)   // v still inferred
  })
  it('for a grouped layer the pins belong to the group unit', () => {
    const a = createRectLayer({ id: 'a', x: 0.2, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.6, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const e = effectivePins(doc([a, b], { groups: [{ id: 'g', pins: { h: 'right' } }] }), 'a', null)!
    expect(e.unitId).toBe('g'); expect(e.h).toBe('right'); expect(e.hAuto).toBe(false)
  })
  it('section availability follows the grid', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    const inside = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1 })  // inside section 0 (0..500)
    const straddle = createRectLayer({ id: 'b', x: 0.5, y: 0.5, w: 0.4, h: 0.1 })   // spans the divide
    expect(effectivePins(doc([inside], { grid }), 'a', null)!.sectionAvailable).toBe(true)
    expect(effectivePins(doc([straddle], { grid }), 'b', null)!.sectionAvailable).toBe(false)
    expect(effectivePins(doc([inside], { grid }), 'a', null)!.holdTo).toBe('section')
  })
  it('holdTo frame overrides an available section', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    const l = createRectLayer({ id: 'a', x: 0.25, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'frame' } })
    const e = effectivePins(doc([l], { grid }), 'a', null)!
    expect(e.holdTo).toBe('frame'); expect(e.holdAuto).toBe(false); expect(e.sectionAvailable).toBe(true)
  })
  it('returns null for an unknown layer id', () => {
    expect(effectivePins(doc([createRectLayer({ id: 'a' })]), 'zzz', null)).toBeNull()
  })
})

describe('guideLinesFor', () => {
  const box = { x: 100, y: 50, w: 200, h: 100 }
  it('a left/top unit draws guides to the left and top edges', () => {
    const g = guideLinesFor(box, { h: axisMap('left', 1000, 1, 0, 0), v: axisMap('left', 500, 1, 0, 0) }, 1000, 500)
    expect(g.left).toBeCloseTo(0.1, 9)     // box.x / W
    expect(g.top).toBeCloseTo(0.1, 9)      // box.y / H
    expect(g.right).toBeUndefined(); expect(g.bottom).toBeUndefined()
  })
  it('a both unit draws guides to both edges on that axis', () => {
    const g = guideLinesFor(box, { h: axisMap('both', 1000, 1, 500, 0), v: axisMap('center', 500, 1, 0, 0) }, 1000, 500)
    expect(g.left).toBeCloseTo(0.1, 9); expect(g.right).toBeCloseTo(0.3, 9)  // (box.x+box.w)/W
    expect(g.centerY).toBe(true)
  })
  it('a relative pin draws no guide on that axis; a vertical right (=bottom) draws to the bottom', () => {
    // The resolver builds vertical maps in axis-neutral names, so a bottom-held axis is kind 'right'.
    const g = guideLinesFor(box, { h: axisMap('relative', 1000, 1, 500, 0), v: axisMap('right', 500, 1, 250, 0) }, 1000, 500)
    expect(g.left).toBeUndefined(); expect(g.right).toBeUndefined()
    expect(g.bottom).toBeCloseTo((50 + 100) / 500, 9)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-preview.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/preview`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/preview.ts
import { buildUnits, type Unit } from './units'
import { inferAxisPin } from './infer'
import { sectionsAt, sectionOf } from './sections'
import type { FrameDoc, PinH, PinV, AxisMap, ResolvedBox } from './types'

export interface EffectivePins {
  h: PinH; v: PinV; keepSize: boolean; holdTo: 'frame' | 'section'
  hAuto: boolean; vAuto: boolean; keepAuto: boolean; holdAuto: boolean
  sectionAvailable: boolean
  unitId: string
}

const V_NAME: Record<'left' | 'right' | 'both' | 'center' | 'relative', PinV> =
  { left: 'top', right: 'bottom', both: 'both', center: 'middle', relative: 'relative' }

/** The unit that owns `layerId`'s pins, or null. */
function unitOf(units: Unit[], layerId: string): Unit | null {
  return units.find(u => u.memberIds.includes(layerId)) ?? null
}

/**
 * The pins that apply to `layerId`'s unit: stored where present, inferred (and
 * flagged automatic) where absent. `holdTo` is 'section' when the grid is on and
 * the unit sits in one section, unless a stored `holdTo:'frame'` overrides.
 */
export function effectivePins(frame: FrameDoc, layerId: string, ctx: CanvasRenderingContext2D | null): EffectivePins | null {
  const { designW: W0, designH: H0, grid } = frame
  if (!(W0 > 0) || !(H0 > 0)) return null
  const units = buildUnits(frame.layers, frame.groups, ctx, W0, H0)
  const unit = unitOf(units, layerId)
  if (!unit) return null
  const stored = unit.pins ?? {}
  const ref = { x: 0, y: 0, w: W0, h: H0 }
  const infH = inferAxisPin(unit.box.x, unit.box.w, ref.x, ref.w, unit.canStretch)
  const infV = V_NAME[inferAxisPin(unit.box.y, unit.box.h, ref.y, ref.h, unit.canStretch)]

  // Section availability: at the design size (s = 1), does the unit's box sit in one region?
  let sectionAvailable = false
  if (grid && grid.mode !== 'off') {
    const sec = sectionsAt(grid, W0, H0, 1, W0, H0)   // s = 1 at the design size
    if (sec) sectionAvailable = sectionOf(unit.box, sec.design.regions, 0.01 * W0) >= 0
  }
  const holdStored = stored.holdTo === 'frame'
  const holdTo: 'frame' | 'section' = holdStored ? 'frame' : (sectionAvailable ? 'section' : 'frame')

  return {
    h: stored.h ?? infH, v: stored.v ?? infV, keepSize: stored.keepSize ?? false,
    holdTo,
    hAuto: stored.h == null, vAuto: stored.v == null, keepAuto: stored.keepSize == null,
    holdAuto: stored.holdTo == null,
    sectionAvailable,
    unitId: unit.id,
  }
}

export interface GuideLines {
  left?: number; right?: number; top?: number; bottom?: number
  centerX?: boolean; centerY?: boolean
  box: ResolvedBox
}

/** Guide segments (box-normalized) for the unit's held edges, from its resolved box and maps. */
export function guideLinesFor(box: ResolvedBox, maps: { h: AxisMap; v: AxisMap }, W: number, H: number): GuideLines {
  const g: GuideLines = { box }
  const hk = maps.h.kind, vk = maps.v.kind
  if (hk === 'left' || hk === 'both') g.left = box.x / W
  if (hk === 'right' || hk === 'both') g.right = (box.x + box.w) / W
  if (hk === 'center') g.centerX = true
  if (vk === 'left' || vk === 'both') g.top = box.y / H
  if (vk === 'right' || vk === 'both') g.bottom = (box.y + box.h) / H
  if (vk === 'center') g.centerY = true
  return g
}
```

Note: the vertical `AxisMap.kind` uses the axis-neutral names (`left`/`right`/`center`), because slice 1's resolver builds vertical maps with `axisOfV`. So `vk === 'left'` means "top" and `vk === 'right'` means "bottom" — the test's `'bottom' as never` reflects that a caller never sees `'top'`/`'bottom'` in a map; the map always carries the neutral name. Keep the guide code in neutral names as written.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-preview.unit.spec.ts`
Expected: PASS. If the `'bottom' as never` cast in the relative test reads awkwardly, change that test's vertical map to `axisMap('right', 500, 1, 250, 0)` (same meaning: a bottom-held axis) and keep the expected `g.bottom`.

- [ ] **Step 5: Re-export and commit**

Add to `frontend/app/lib/frame/responsive/index.ts`:
```ts
export { effectivePins, guideLinesFor } from './preview'
export type { EffectivePins, GuideLines } from './preview'
```
Run: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep 'lib/frame/responsive'` — expect nothing.

```bash
git add frontend/app/lib/frame/responsive/preview.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-preview.unit.spec.ts
git commit -m "feat(frame): responsive preview helpers — effectivePins and guide lines"
```

---

### Task 2: Viewing-size maths (`viewport.ts`)

**Files:**
- Create: `frontend/app/lib/frame/responsive/viewport.ts`
- Modify: `frontend/app/lib/frame/responsive/index.ts`
- Test: `frontend/tests/unit/responsive-viewport.unit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Size { w: number; h: number }
  interface ShapePreset { id: string; label: string; w: number; h: number }
  function shapePresets(design: Size): ShapePreset[]      // Your design, Wide, Tall, Square, Banner
  function clampViewSize(v: Size, design: Size): Size     // keep each axis within [0.25x, 5x] the design
  /** New viewing size from dragging an artboard edge. `edge` is 'e' (right), 's' (bottom), 'se' (corner).
   *  `dxPx`/`dyPx` are the pointer delta in SCREEN px; `displayScale` = on-screen px per output px
   *  (canvasDisplay.w / view.w). Corner keeps neither axis; e keeps h; s keeps w. */
  function resizeViewFromEdge(design: Size, view: Size, edge: 'e' | 's' | 'se', dxPx: number, dyPx: number, displayScale: number): Size
  function atDesignSize(view: Size, design: Size): boolean
  function readoutLabel(view: Size, design: Size): 'Design size' | 'Viewing size'
  ```

`shapePresets` derives shapes from the design's *area* so a wide/tall/square/banner variant is a comparable size, not a fixed pixel count. "Your design" is the design size exactly.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-viewport.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { shapePresets, clampViewSize, resizeViewFromEdge, atDesignSize, readoutLabel } from '~/lib/frame/responsive/viewport'

const design = { w: 1000, h: 500 }

describe('shapePresets', () => {
  it('offers Your design first, exactly the design size', () => {
    const p = shapePresets(design)
    expect(p[0]).toEqual({ id: 'design', label: 'Your design', w: 1000, h: 500 })
    expect(p.map(x => x.id)).toEqual(['design', 'wide', 'tall', 'square', 'banner'])
  })
  it('each preset keeps roughly the design area', () => {
    const area = design.w * design.h
    for (const p of shapePresets(design).slice(1)) {
      expect(p.w * p.h).toBeGreaterThan(area * 0.5)
      expect(p.w * p.h).toBeLessThan(area * 2)
      expect(Number.isInteger(p.w)).toBe(true); expect(Number.isInteger(p.h)).toBe(true)
    }
  })
  it('square is square, wide is landscape, tall is portrait', () => {
    const by = Object.fromEntries(shapePresets(design).map(p => [p.id, p]))
    expect(by.square.w).toBe(by.square.h)
    expect(by.wide.w).toBeGreaterThan(by.wide.h)
    expect(by.tall.h).toBeGreaterThan(by.tall.w)
  })
})

describe('clampViewSize', () => {
  it('holds each axis within 0.25x..5x the design', () => {
    expect(clampViewSize({ w: 100, h: 100 }, design)).toEqual({ w: 250, h: 125 })   // both below 0.25x
    expect(clampViewSize({ w: 999999, h: 999999 }, design)).toEqual({ w: 5000, h: 2500 })
    expect(clampViewSize({ w: 1500, h: 400 }, design)).toEqual({ w: 1500, h: 400 }) // in range
  })
})

describe('resizeViewFromEdge', () => {
  // displayScale 0.5 → 100 screen px = 200 output px
  it('the right edge changes width only', () => {
    expect(resizeViewFromEdge(design, { w: 1000, h: 500 }, 'e', 100, 40, 0.5)).toEqual({ w: 1200, h: 500 })
  })
  it('the bottom edge changes height only', () => {
    expect(resizeViewFromEdge(design, { w: 1000, h: 500 }, 's', 100, 40, 0.5)).toEqual({ w: 1000, h: 580 })
  })
  it('the corner changes both', () => {
    expect(resizeViewFromEdge(design, { w: 1000, h: 500 }, 'se', 100, 40, 0.5)).toEqual({ w: 1200, h: 580 })
  })
  it('clamps to the allowed range', () => {
    const r = resizeViewFromEdge(design, { w: 1000, h: 500 }, 'e', -100000, 0, 0.5)
    expect(r.w).toBe(250)
  })
})

describe('atDesignSize / readoutLabel', () => {
  it('true within a pixel of the design size', () => {
    expect(atDesignSize({ w: 1000, h: 500 }, design)).toBe(true)
    expect(atDesignSize({ w: 1001, h: 500 }, design)).toBe(false)
    expect(readoutLabel({ w: 1000, h: 500 }, design)).toBe('Design size')
    expect(readoutLabel({ w: 1200, h: 500 }, design)).toBe('Viewing size')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-viewport.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/viewport`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/viewport.ts
export interface Size { w: number; h: number }
export interface ShapePreset { id: string; label: string; w: number; h: number }

const MIN_FACTOR = 0.25, MAX_FACTOR = 5

/** Shapes at roughly the design's own area. */
export function shapePresets(design: Size): ShapePreset[] {
  const area = Math.max(1, design.w * design.h)
  const at = (ratio: number): { w: number; h: number } => {
    // w*h = area, w/h = ratio  ⇒  h = sqrt(area/ratio), w = ratio*h
    const h = Math.sqrt(area / ratio)
    return { w: Math.round(ratio * h), h: Math.round(h) }
  }
  return [
    { id: 'design', label: 'Your design', w: design.w, h: design.h },
    { id: 'wide', label: 'Wide', ...at(16 / 9) },
    { id: 'tall', label: 'Tall', ...at(9 / 16) },
    { id: 'square', label: 'Square', ...at(1) },
    { id: 'banner', label: 'Banner', ...at(4) },
  ]
}

export function clampViewSize(v: Size, design: Size): Size {
  const clamp = (val: number, base: number) => Math.round(Math.min(MAX_FACTOR * base, Math.max(MIN_FACTOR * base, val)))
  return { w: clamp(v.w, design.w), h: clamp(v.h, design.h) }
}

export function resizeViewFromEdge(design: Size, view: Size, edge: 'e' | 's' | 'se', dxPx: number, dyPx: number, displayScale: number): Size {
  const scale = displayScale > 1e-6 ? displayScale : 1
  const dW = (edge === 'e' || edge === 'se') ? dxPx / scale : 0
  const dH = (edge === 's' || edge === 'se') ? dyPx / scale : 0
  return clampViewSize({ w: view.w + dW, h: view.h + dH }, design)
}

export function atDesignSize(view: Size, design: Size): boolean {
  return Math.abs(view.w - design.w) < 1 && Math.abs(view.h - design.h) < 1
}

export function readoutLabel(view: Size, design: Size): 'Design size' | 'Viewing size' {
  return atDesignSize(view, design) ? 'Design size' : 'Viewing size'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-viewport.unit.spec.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Re-export and commit**

Add to `index.ts`:
```ts
export { shapePresets, clampViewSize, resizeViewFromEdge, atDesignSize, readoutLabel } from './viewport'
export type { Size, ShapePreset } from './viewport'
```
Run the typecheck grep (expect nothing), then:
```bash
git add frontend/app/lib/frame/responsive/viewport.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-viewport.unit.spec.ts
git commit -m "feat(frame): responsive viewport maths — shapes, edge drag, readout"
```

---

### Task 3: "Responsive" in the node's size picker

**Files:**
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (the `PRESETS`/`activePresetId`/`onPresetChange`/`rememberPreset` block ~76-98; the `<select>` ~1101-1108; the W/H inputs ~1115-1123)
- Test: browser verification (this is Vue wiring; the doc write is trivial and covered by the modal's read path in later tasks)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sailor_frame.responsive === true` when the "Responsive" option is chosen; `false`/absent otherwise. `isResponsiveFrame(props)` (slice 1) already reads it.

- [ ] **Step 1: Add an `isResponsive` computed and a `setResponsive` writer**

After `activePresetId` (~line 87), add:
```ts
const isResponsive = computed(() => (props.data.properties as any)?.sailor_frame?.responsive === true)
function setResponsive(on: boolean) {
  if (!props.data.properties) (props.data as any).properties = {}
  ;(props.data.properties as any).sailor_frame = { ...(props.data.properties as any).sailor_frame, responsive: on }
}
```

- [ ] **Step 2: Make the picker offer and reflect "Responsive"**

Change `activePresetId` so a responsive frame shows the responsive row:
```ts
const activePresetId = computed<string>(() => {
  if (isResponsive.value) return 'responsive'
  const match = PRESETS.find(p => p.w === frameW.value && p.h === frameH.value)
  return match ? match.id : (hasExplicitSize.value ? 'custom' : '')
})
```
Change `onPresetChange` to handle the responsive row and to clear the flag for any real preset:
```ts
function onPresetChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v === 'responsive') { setResponsive(true); return }   // keep current w/h as the design size
  if (v && v !== 'custom') { setResponsive(false); applyPreset(v) }
}
```
And make `setDim` clear the flag only when the user is NOT responsive is wrong — a responsive frame edits its *design* size through these same fields, so `setDim` must keep the responsive flag. Leave `setDim` as-is (it calls `rememberPreset('custom')`, which does not touch `responsive`). Add nothing.

- [ ] **Step 3: Add the option to the `<select>` and relabel the inputs**

In the `<select>` (~1101), add before the `custom` option:
```html
<option value="responsive">Responsive</option>
```
Above the W/H inputs (~1115), add a label that switches wording when responsive:
```html
<div class="text-[10px] uppercase tracking-wide text-white/40 mb-0.5">{{ isResponsive ? 'Designed at' : 'Size' }}</div>
```
(Place it so it reads over the W/H row; match the surrounding label style already used in the node card — inspect the nearby markup and reuse its class names rather than inventing new ones.)

- [ ] **Step 4: Browser-verify**

Ensure a preview server is up (`preview_start` with the project's dev config; do NOT start a second server if one is listening — reuse it). Then, in the browser:
1. Add or open a Frame node. Its size picker shows "Responsive" in the list.
2. Choose "Responsive". Read the node's stored props via the page (or a follow-up render): `sailor_frame.responsive === true`; the W/H label now reads "Designed at"; the width/height values are unchanged.
3. Choose a real preset (e.g. "Wide · 16:9"). `sailor_frame.responsive` is `false` and the size changes.
4. Take a screenshot of the picker showing "Responsive" selected and the "Designed at" label, and share it.

Record in the report: the exact prop value observed after each step.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/vue-canvas/ArtifactFrameNode.vue
git commit -m "feat(frame): Responsive in the size picker; Designed-at labelling"
```

---

### Task 4: Render resolved layers at a viewing size

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — imports; new viewing-size state; `previewAspect`; `resolvedLayout` computed; `fitCanvasToStage` (~409); `buildStackItems` (the items builder used by `renderStack` ~4459); the `renderStack` paint call (~4489); a reset watcher on modal open / responsive toggle.
- Test: browser verification (canvas render; unit-tested logic is already in Tasks 1–2 and slice 1).

**Interfaces:**
- Consumes: `resolveLayout`, `frameDocFromProps`, `isResponsiveFrame`, `layoutScaleOf` (from `~/lib/frame/responsive`); `atDesignSize`, `clampViewSize` (Task 2).
- Produces: `viewSize` (reactive `{w,h}`), `designSize` (computed), `atDesign` (computed), `resolved` (computed `LayoutResult | null`), `paintLayers()` and `paintItems()` used by `renderStack`. Later tasks (5–9) consume these.

- [ ] **Step 1: Add imports and viewing-size state**

Near the other `~/lib/frame/responsive` needs (there are none yet in the modal — add a fresh import by the other lib imports at the top):
```ts
import { resolveLayout, frameDocFromProps, isResponsiveFrame, type LayoutResult } from '~/lib/frame/responsive'
import { atDesignSize as isAtDesignSize, clampViewSize } from '~/lib/frame/responsive/viewport'
```
After `canvasDisplay` (~349) add:
```ts
// Responsive Frames: is THIS frame responsive, its design (output) size, and the transient
// viewing size (editor-only, never saved). A fixed frame keeps viewSize == designSize forever.
const frameIsResponsive = computed(() => isResponsiveFrame(compositor.value?.data?.properties as any))
const designSize = computed(() => { const { W, H } = bakeSize(); return { w: W, h: H } })
const viewSize = reactive({ w: 0, h: 0 })     // 0,0 until initialised by the reset watcher below
const atDesign = computed(() => !frameIsResponsive.value || (viewSize.w <= 0) || isAtDesignSize(viewSize, designSize.value))
```

- [ ] **Step 2: Reset the viewing size on open and when responsiveness changes**

`bakeSize()` reads the width/height widgets. Add a watcher (near the other watchers, e.g. after the `watch(baseAspect, …)` at ~432):
```ts
// Start every editor session at the design size; snap back when the frame stops being
// responsive or the design size changes under us.
watch([() => props.open, frameIsResponsive, designSize], () => {
  const d = designSize.value
  viewSize.w = d.w; viewSize.h = d.h
}, { immediate: true })
```
(If the modal's open prop is named differently, use the real one — inspect the `props` declaration.)

- [ ] **Step 3: `previewAspect`, the resolved layout, and the fit target**

Add after `baseAspect` (~348):
```ts
// While looking at a viewing size, the artboard takes the viewing shape; otherwise the design shape.
const previewAspect = computed(() => (frameIsResponsive.value && !atDesign.value && viewSize.h > 0)
  ? viewSize.w / viewSize.h : baseAspect.value)
// The resolved layout for the current viewing size, or null when we should paint the raw layers.
const resolved = computed<LayoutResult | null>(() => {
  if (!frameIsResponsive.value || atDesign.value) return null
  const d = designSize.value
  const doc = frameDocFromProps(compositor.value?.data?.properties as any, d.w, d.h)
  return resolveLayout(doc, viewSize.w, viewSize.h, { measureCtx: measureCtx() })
})
```
Change `fitCanvasToStage` (~409) to fit `previewAspect.value` instead of `baseAspect.value` (one edit: replace `const a = baseAspect.value || 1` with `const a = previewAspect.value || 1`), and add `previewAspect` to its watcher list (the `watch(baseAspect, fitCanvasToStage)` at ~432 becomes `watch([baseAspect, previewAspect], fitCanvasToStage)`).

- [ ] **Step 4: Paint the resolved layers**

Add two helpers near `buildStackItems` (~4459). `buildStackItems` today maps `stackKeys` through `resolveKey` to `editor.localLayers`; add an optional override map:
```ts
// The layers to paint: resolved for a viewing size, else the raw editor layers.
function paintLayers(): LocalLayer[] {
  return (resolved.value?.layers ?? localLayers.value) as LocalLayer[]
}
// Items for the painter, using the resolved layers by id when present.
function paintItems(): StackItem[] {
  const items = buildStackItems()
  const r = resolved.value
  if (!r) return items
  const byId = new Map(r.layers.map(l => [l.id, l]))
  return items.map(it => (it.type === 'local' && byId.has(it.layer.id))
    ? { ...it, layer: byId.get(it.layer.id)! } : it)
}
```
In `renderStack` (~4459 and ~4489), change `const items = buildStackItems()` to `const items = paintItems()`, and in the `paintLayerStack(...)` call change `localLayers.value as LocalLayer[]` to `paintLayers()` and change the motion argument: when `resolved.value` is present and motion is playing, pass the resolved motion. Concretely, after `const motionArg = previewT.value != null ? motionDoc.value : undefined`, add:
```ts
const paintMotion = (resolved.value && motionArg) ? { ...motionArg, ...resolved.value.motion } : motionArg
```
and pass `paintMotion` where `motionArg` was passed to `paintLayerStack`. (If `motionDoc.value`'s shape differs from `FrameMotion`, spread only the `motionx`/`tracks`/`behaviours` fields the resolver remapped: `resolved.value.motion` is a `FrameMotion` — inspect `motionDoc.value`'s type and merge the matching fields.)

- [ ] **Step 5: Browser-verify**

Reuse the preview server. In the browser:
1. Make a Frame responsive (Task 3), put a few layers in it (a left-aligned title, a centred shape, a right-aligned button, a full-bleed background), open its editor.
2. It renders exactly as before at the design size (`atDesign` true, `resolved` null).
3. Temporarily drive `viewSize` from the console (`viewSize.w = design.w * 1.6`) — the artboard becomes wider, the background bleeds to the new edges, the left title holds the left, the right button holds the right, the centred shape stays centred. Take a screenshot.
4. Set `viewSize` back to the design size; the render is identical to step 2.
5. Confirm a FIXED frame is unaffected: open a non-responsive Frame; `resolved` is null at all times, render byte-identical.

Read the console for errors (`read_console_messages`). Record what you observed.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): paint resolveLayout output at a viewing size (fixed frames unchanged)"
```

---

### Task 5: Draggable artboard edges

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — the stage/artboard template (~7219-7258) to add three grips; new pointer handlers; consumes `resizeViewFromEdge` (Task 2).
- Test: browser verification.

**Interfaces:**
- Consumes: `resizeViewFromEdge`, `designSize`, `viewSize`, `view` (the pan/zoom transform, for the display scale), `canvasDisplay`.
- Produces: three grip elements shown only when `frameIsResponsive`; a drag that updates `viewSize`.

- [ ] **Step 1: Add the drag handler**

Near the other pointer handlers (e.g. after `onStagePointerDownPan` ~616), add:
```ts
// Responsive Frames: dragging an artboard edge changes the viewing size (editor-only).
const edgeDrag = ref<{ edge: 'e' | 's' | 'se'; sx: number; sy: number; w0: number; h0: number } | null>(null)
function onEdgeDown(edge: 'e' | 's' | 'se', ev: PointerEvent) {
  ev.preventDefault(); ev.stopPropagation()
  ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
  edgeDrag.value = { edge, sx: ev.clientX, sy: ev.clientY, w0: viewSize.w, h0: viewSize.h }
}
function onEdgeMove(ev: PointerEvent) {
  const d = edgeDrag.value; if (!d) return
  // display scale = on-screen artboard px per output px, including the pan/zoom scale.
  const displayScale = (canvasDisplay.w / Math.max(1, viewSize.w)) * (view.scale || 1)
  const next = resizeViewFromEdge(designSize.value, { w: d.w0, h: d.h0 }, d.edge, ev.clientX - d.sx, ev.clientY - d.sy, displayScale)
  viewSize.w = next.w; viewSize.h = next.h
}
function onEdgeUp(ev: PointerEvent) {
  if (edgeDrag.value) { (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId); edgeDrag.value = null }
}
```

- [ ] **Step 2: Add the grips to the template**

Inside `stageWrapRef` (the element sized by `viewStyle`, ~7238), after the `canvasRef` div, add three grips positioned on the artboard's right edge, bottom edge and corner. They live in the same transformed space so they track the artboard:
```html
<template v-if="frameIsResponsive">
  <div class="absolute top-0 -right-1 w-2 h-full cursor-ew-resize group/redge" style="pointer-events:auto"
    @pointerdown="onEdgeDown('e', $event)" @pointermove="onEdgeMove" @pointerup="onEdgeUp">
    <div class="absolute inset-y-0 right-0 w-px bg-transparent group-hover/redge:bg-[#3b82f6]" />
  </div>
  <div class="absolute -bottom-1 left-0 h-2 w-full cursor-ns-resize group/bedge" style="pointer-events:auto"
    @pointerdown="onEdgeDown('s', $event)" @pointermove="onEdgeMove" @pointerup="onEdgeUp">
    <div class="absolute inset-x-0 bottom-0 h-px bg-transparent group-hover/bedge:bg-[#3b82f6]" />
  </div>
  <div class="absolute -bottom-1.5 -right-1.5 size-3 rounded-sm cursor-nwse-resize bg-[#3b82f6]/0 hover:bg-[#3b82f6] border border-[#3b82f6]/60"
    style="pointer-events:auto" @pointerdown="onEdgeDown('se', $event)" @pointermove="onEdgeMove" @pointerup="onEdgeUp" />
</template>
```
(Match the modal's existing colour tokens; `#3b82f6` is the blue used elsewhere — verify against a nearby handle and reuse whatever the file already uses.)

- [ ] **Step 3: Browser-verify**

Reuse the preview server. Make a Frame responsive, open its editor:
1. Hover the right edge — a blue line appears. Drag it right; the artboard widens and the layout adapts live (left holds left, right holds right, background bleeds). Drag the bottom edge; it taller. Drag the corner; both.
2. Release; the layout stays at the dragged size. `read_console_messages` shows no errors.
3. A fixed frame shows no grips.
4. Screenshot a mid-drag wide state.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): draggable artboard edges change the viewing size"
```

---

### Task 6: The size readout

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — the toolbar region (the floating bottom bar ~7795, next to the zoom cluster); consumes `shapePresets`, `readoutLabel`, `clampViewSize` (Task 2).
- Create: none (kept inline; it is small).
- Test: browser verification.

**Interfaces:**
- Consumes: `shapePresets`, `readoutLabel`, `clampViewSize`, `viewSize`, `designSize`, `atDesign`, `frameIsResponsive`.
- Produces: the readout UI; typing/selecting updates `viewSize`; "Back to design size" resets it.

- [ ] **Step 1: Add readout state and handlers**

Near `zoomMenuItems` (~581), add:
```ts
import { shapePresets, readoutLabel as viewReadoutLabel } from '~/lib/frame/responsive/viewport'  // add to the top import block instead
const viewShapes = computed(() => shapePresets(designSize.value))
const viewReadout = computed(() => viewReadoutLabel(viewSize, designSize.value))
function setViewDim(which: 'w' | 'h', raw: string) {
  const n = Math.round(parseFloat(raw) || 0); if (n <= 0) return
  const next = clampViewSize({ w: which === 'w' ? n : viewSize.w, h: which === 'h' ? n : viewSize.h }, designSize.value)
  viewSize.w = next.w; viewSize.h = next.h
}
function pickViewShape(id: string) {
  const p = viewShapes.value.find(x => x.id === id); if (!p) return
  viewSize.w = p.w; viewSize.h = p.h
}
function backToDesignSize() { const d = designSize.value; viewSize.w = d.w; viewSize.h = d.h }
```
(Consolidate the `viewport` imports into one line at the top with the Task 4/5 imports.)

- [ ] **Step 2: Add the readout to the toolbar**

In the floating toolbar (~7795), next to the zoom cluster, add (shown only when responsive):
```html
<div v-if="frameIsResponsive" class="flex items-center gap-1.5 pl-2 ml-1 border-l border-[#2a2a2a]"
  :class="atDesign ? 'text-white/60' : 'text-[#3b82f6]'">
  <span class="text-[11px]">{{ viewReadout }}</span>
  <input type="number" min="1" class="w-14 bg-transparent text-[11px] text-right tabular-nums outline-none"
    :value="Math.round(viewSize.w)" @change="setViewDim('w', ($event.target as HTMLInputElement).value)" />
  <span class="text-white/30">×</span>
  <input type="number" min="1" class="w-14 bg-transparent text-[11px] tabular-nums outline-none"
    :value="Math.round(viewSize.h)" @change="setViewDim('h', ($event.target as HTMLInputElement).value)" />
  <select class="bg-transparent text-[11px] outline-none" @change="pickViewShape(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).selectedIndex = 0">
    <option value="">Shapes</option>
    <option v-for="s in viewShapes" :key="s.id" :value="s.id">{{ s.label }}</option>
  </select>
  <button v-if="!atDesign" class="text-[11px] underline decoration-dotted hover:text-white" @click="backToDesignSize">Back to design size</button>
</div>
```
(Reuse the toolbar's existing button/pill classes rather than the placeholders above where the file already has them.)

- [ ] **Step 3: Browser-verify**

Reuse the preview server. Responsive Frame, editor open:
1. At the design size the readout reads "Design size" in grey and shows the design W×H; no "Back to design size".
2. Drag an edge (Task 5) or type a new width — the readout turns blue, reads "Viewing size", "Back to design size" appears.
3. Pick "Wide" / "Tall" / "Square" / "Banner" from the Shapes menu; the artboard jumps to that shape and the layout adapts.
4. Click "Back to design size"; it returns to the design shape and the grey "Design size" label.
5. Screenshot the blue "Viewing size" state with the Shapes menu open.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): the viewing-size readout with shapes and back-to-design"
```

---

### Task 7: The pins card — "When the frame resizes"

**Files:**
- Create: `frontend/app/components/vue-canvas/ResponsivePinsCard.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — import and render the card in the per-layer inspector (Design tab), plus a writer for `layer.pins` / `group.pins`.
- Test: browser verification (the inference logic is unit-tested in Task 1).

**Interfaces:**
- Consumes: `effectivePins` (Task 1), the studio controls `StudioSection`, `StudioSelect`, `StudioSwitch`; the selected layer id; a `setPins(unitId, patch)` writer.
- Produces: the card component; editing a control writes to the doc and re-renders the preview.

- [ ] **Step 1: Add the doc writer in the modal**

Near the other layer writers (e.g. by `setLocal`), add:
```ts
import { effectivePins } from '~/lib/frame/responsive'   // consolidate with the other responsive import
// Read the effective pins for the current single selection (or null).
const selectedPins = computed(() => {
  const id = selectedLocalId.value
  if (!frameIsResponsive.value || !id || selectedIds.value.size > 1) return null
  const d = designSize.value
  const doc = frameDocFromProps(compositor.value?.data?.properties as any, d.w, d.h)
  return effectivePins(doc, id, measureCtx())
})
// Write a pins patch onto the unit — a layer id writes the layer's `pins`, a group id the group's.
function setPins(unitId: string, patch: Partial<import('~/lib/frame/responsive').Pins>) {
  const groups = localGroups.value
  if (groups.some(g => g.id === unitId)) {
    writeGroups(groups.map(g => g.id === unitId ? { ...g, pins: cleanPins({ ...g.pins, ...patch }) } : g))
  } else {
    const layer = localLayers.value.find(l => l.id === unitId)
    if (layer) setLocal(unitId, { pins: cleanPins({ ...(layer as any).pins, ...patch }) } as any)
  }
}
// Drop keys set back to their automatic (absent) state so "Back to automatic" truly clears them.
function cleanPins(p: Record<string, unknown>): import('~/lib/frame/responsive').Pins | undefined {
  const out: any = {}
  for (const k of ['h', 'v', 'keepSize', 'holdTo'] as const) if (p[k] != null) out[k] = p[k]
  return Object.keys(out).length ? out : undefined
}
function backToAutomatic(unitId: string) { setPins(unitId, { h: undefined, v: undefined, keepSize: undefined, holdTo: undefined } as any) }
```
(Verify `setLocal`, `writeGroups`, `localGroups` names against the destructured editor surface; the Explore report lists them.)

- [ ] **Step 2: Write the card component**

```vue
<!-- frontend/app/components/vue-canvas/ResponsivePinsCard.vue -->
<script setup lang="ts">
import StudioSection from './StudioSection.vue'
import StudioSelect from './studio/StudioSelect.vue'
import StudioSwitch from './studio/StudioSwitch.vue'
import type { EffectivePins, Pins } from '~/lib/frame/responsive'

const props = defineProps<{ pins: EffectivePins }>()
const emit = defineEmits<{ (e: 'patch', patch: Partial<Pins>): void; (e: 'auto'): void }>()

const H_VALUES = ['left', 'right', 'both', 'center', 'relative']
const H_LABELS = ['Left', 'Right', 'Left and right', 'Center', 'Keep relative position']
const V_VALUES = ['top', 'bottom', 'both', 'middle', 'relative']
const V_LABELS = ['Top', 'Bottom', 'Top and bottom', 'Middle', 'Keep relative position']

const anyAuto = () => props.pins.hAuto && props.pins.vAuto && props.pins.keepAuto && props.pins.holdAuto
</script>

<template>
  <StudioSection title="When the frame resizes">
    <div class="flex items-center gap-2 mb-2">
      <span v-if="anyAuto()" class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60">Automatic</span>
      <a v-else href="#" class="text-[11px] text-[#3b82f6] ml-auto" @click.prevent="emit('auto')">Back to automatic</a>
    </div>
    <StudioSelect label="Horizontal" :options="H_VALUES" :option-labels="H_LABELS"
      :model-value="pins.h" @update:model-value="(v: string) => emit('patch', { h: v as any })" />
    <StudioSelect label="Vertical" :options="V_VALUES" :option-labels="V_LABELS"
      :model-value="pins.v" @update:model-value="(v: string) => emit('patch', { v: v as any })" />
    <StudioSwitch label="Keep size" :model-value="pins.keepSize"
      @update:model-value="(v: boolean) => emit('patch', { keepSize: v })" />
    <StudioSelect v-if="pins.sectionAvailable" label="Holds to"
      :options="['section', 'frame']" :option-labels="['Section', 'Whole frame']"
      :model-value="pins.holdTo" @update:model-value="(v: string) => emit('patch', v === 'frame' ? { holdTo: 'frame' } : { holdTo: undefined } as any)" />
  </StudioSection>
</template>
```
Note: `StudioSelect`'s `modelValue` is `defineModel<string>({ required: true })`; passing `:model-value` + `@update:model-value` is the un-sugared form and works. If the component requires the `v-model` sugar, bind `v-model` to a local computed instead — but the explicit form above is standard.

- [ ] **Step 3: Render the card in the inspector**

In the Design-tab per-layer inspector (where the Transform card renders, ~10547), add after the existing cards, gated so it only shows for a responsive frame with a single selection:
```html
<ResponsivePinsCard v-if="selectedPins" :pins="selectedPins"
  @patch="(p) => setPins(selectedPins!.unitId, p)" @auto="backToAutomatic(selectedPins!.unitId)" />
```
Import it at the top: `import ResponsivePinsCard from './ResponsivePinsCard.vue'`.

- [ ] **Step 4: Browser-verify**

Reuse the preview server. Responsive Frame, a few layers, editor open:
1. Select the left-aligned title. The card shows Horizontal = Left, Vertical = Top (or Middle), an "Automatic" chip.
2. Change Horizontal to "Center". The chip becomes "Back to automatic"; drag a wide viewing size (Task 5) and the title now stays centred instead of holding left.
3. Turn on "Keep size"; at a smaller viewing size the layer keeps its pixel size while others shrink.
4. Click "Back to automatic"; the stored pins clear, the chip returns to "Automatic", and the inferred behaviour resumes.
5. If a grid is on and the layer sits in a section, "Holds to" appears; toggling it to "Whole frame" changes which edges it tracks.
6. Screenshot the card with "Back to automatic" showing.

Verify with `mcp__ccd_view` / `read_page` that the card's selects carry the sentence-case labels (no internal values leak).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/vue-canvas/ResponsivePinsCard.vue frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): the pins card — When the frame resizes"
```

---

### Task 8: Guide lines for the selected unit

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — a computed for the guides and an SVG overlay in the selection layer (~7557, alongside the existing handle SVG).
- Test: browser verification (geometry is unit-tested in Task 1).

**Interfaces:**
- Consumes: `guideLinesFor` (Task 1), `resolved` (Task 4, its `boxes`/`maps`), `selectedPins` (Task 7, for `unitId`), `canvasDisplay`.
- Produces: an SVG overlay drawing the held-edge guides.

- [ ] **Step 1: Compute the guides**

```ts
import { guideLinesFor } from '~/lib/frame/responsive'   // consolidate import
// Guide lines for the selected unit at the current viewing size (only when off the design size).
const selectionGuides = computed(() => {
  const r = resolved.value, sp = selectedPins.value
  if (!r || !sp) return null
  const box = r.boxes.get(sp.unitId) ?? r.boxes.get(selectedLocalId.value ?? '')
  const maps = r.maps.get(sp.unitId) ?? r.maps.get(selectedLocalId.value ?? '')
  if (!box || !maps) return null
  return guideLinesFor(box, maps, viewSize.w, viewSize.h)
})
```

- [ ] **Step 2: Draw the overlay**

Beside the existing selection SVG (~7557), add (in `canvasDisplay` coordinate space, which matches the artboard):
```html
<svg v-if="selectionGuides" class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
  :viewBox="`0 0 ${canvasDisplay.w} ${canvasDisplay.h}`">
  <g stroke="#EF9F27" stroke-width="1" stroke-dasharray="3 3" opacity="0.9">
    <line v-if="selectionGuides.left != null" :x1="selectionGuides.left * canvasDisplay.w" :y1="(selectionGuides.box.y + selectionGuides.box.h / 2) / viewSize.h * canvasDisplay.h" x2="0" :y2="(selectionGuides.box.y + selectionGuides.box.h / 2) / viewSize.h * canvasDisplay.h" />
    <line v-if="selectionGuides.right != null" :x1="selectionGuides.right * canvasDisplay.w" :y1="(selectionGuides.box.y + selectionGuides.box.h / 2) / viewSize.h * canvasDisplay.h" :x2="canvasDisplay.w" :y2="(selectionGuides.box.y + selectionGuides.box.h / 2) / viewSize.h * canvasDisplay.h" />
    <line v-if="selectionGuides.top != null" :x1="(selectionGuides.box.x + selectionGuides.box.w / 2) / viewSize.w * canvasDisplay.w" :y1="selectionGuides.top * canvasDisplay.h" :x2="(selectionGuides.box.x + selectionGuides.box.w / 2) / viewSize.w * canvasDisplay.w" y2="0" />
    <line v-if="selectionGuides.bottom != null" :x1="(selectionGuides.box.x + selectionGuides.box.w / 2) / viewSize.w * canvasDisplay.w" :y1="selectionGuides.bottom * canvasDisplay.h" :x2="(selectionGuides.box.x + selectionGuides.box.w / 2) / viewSize.w * canvasDisplay.w" :y2="canvasDisplay.h" />
    <line v-if="selectionGuides.centerX" :x1="canvasDisplay.w / 2" y1="0" :x2="canvasDisplay.w / 2" :y2="canvasDisplay.h" />
    <line v-if="selectionGuides.centerY" x1="0" :y1="canvasDisplay.h / 2" :x2="canvasDisplay.w" :y2="canvasDisplay.h / 2" />
  </g>
</svg>
```
(`#EF9F27` is the amber the grid overlay already uses — verify against the grid overlay and reuse whatever colour the file has for guides.)

- [ ] **Step 3: Browser-verify**

Reuse the preview server. Responsive Frame, editor open, a layer selected:
1. Drag a wide viewing size. The selected left-held layer shows a dashed amber line to the left edge; a right-held layer to the right; a both-held layer to both; a centred layer shows the centre line.
2. Change the layer's pin in the card (Task 7); the guide updates to the new held edge.
3. Back to the design size — the guides disappear (Ruling B), which is expected.
4. Screenshot a wide state with the guides visible.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): guide lines to the edges a selected layer holds"
```

---

### Task 9: View-only at a viewing size (editing returns to design)

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — the canvas pointer/click handlers (`onCanvasPointerDownCapture` ~3022, `onCanvasClick` ~3266) and tool activations; a small guard.
- Test: browser verification.

**Interfaces:**
- Consumes: `atDesign`, `frameIsResponsive`, `backToDesignSize` (Task 6).
- Produces: at a viewing size, edits are suppressed and any editing gesture first returns to the design size.

Per Ruling A: at a viewing size the canvas is view-only — the existing selection stays (so its pins card and guides show), but clicking to select a different layer, dragging to move, or entering an edit tool first snaps back to the design size.

- [ ] **Step 1: Add the guard**

Add a helper near the pointer handlers:
```ts
// Slice 2 does not edit at a viewing size. Any editing gesture snaps back to the design size
// first; the existing selection (and its pins card + guides) is what stays visible while looking.
function viewOnlyGuard(): boolean {
  if (frameIsResponsive.value && !atDesign.value) { backToDesignSize(); return true }
  return false
}
```
At the top of `onCanvasPointerDownCapture` (~3022) and `onCanvasClick` (~3266), add `if (viewOnlyGuard()) return`. Do the same at the top of the brush/pen/region tool activators (grep for where `brush.active`, `nodeEdit.active`, `genActive` are turned on) so a tool cannot start at a viewing size without first returning to design.

- [ ] **Step 2: Browser-verify**

Reuse the preview server. Responsive Frame, a layer selected, editor open:
1. Drag to a wide viewing size. The selection, its pins card and guides remain.
2. Click a different layer on the canvas — the artboard snaps back to the design size and then the click selects (or, acceptably, snaps back and selects nothing; confirm which and record it).
3. Try to drag-move a layer at a viewing size — it snaps back to design first; no move happens at the viewing size.
4. Pick the brush tool at a viewing size — it returns to design size first.
5. At the design size everything edits exactly as before.
6. Screenshot the "snap back on edit" before/after if practical, else describe it.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): view-only at a viewing size — editing returns to the design size"
```

---

### Task 10: Dashboard, memory, the design-box note

**Files:**
- Modify: `docs/STATE.md` (one entry)
- Modify: `docs/superpowers/specs/2026-09-21-frame-responsive-constraints-design.md` (mark slice 2 shipped in the build order, if the file tracks status inline)

- [ ] **Step 1: STATE entry**

Under the Frame section, in the house style (see the slice-1 entry), add:
```
### Responsive Frames — slice 2, the editor (look-only) — LANDED 2026-09-22 (<range>, subagent-driven, a review per task)
```
**What:** a Frame can be marked "Responsive" in its size picker (`sailor_frame.responsive`, design size kept as the width/height widgets). Its editor gains a transient *viewing size* (never saved): drag the artboard's right/bottom/corner edges, or type into a readout with a Shapes menu (Your design / Wide / Tall / Square / Banner) and a "Back to design size" button, and the layout adapts live through `resolveLayout` — left holds left, right holds right, centred stays centred, a background bleeds, boxed text re-wraps. A selected layer gets a "When the frame resizes" card (Horizontal / Vertical pins, Keep size, Holds to Section/Whole frame; automatic until overridden, with "Back to automatic") and dashed guide lines to the edges it holds. Editing at a viewing size is slice 3, so for now the canvas is view-only there and any edit snaps back to the design size first. Pure logic in `lib/frame/responsive/{preview,viewport}.ts` (unit-tested); the Vue wiring is browser-verified. A fixed Frame — every Frame today — is byte-identical: no grips, no readout, no card, `resolveLayout` never called. **Next:** slice 3 (editing at a viewing size — the backward maps and the drop rule), slice 4 (arranged groups via Yoga), slice 5 (export "Adapt").

- [ ] **Step 2: Commit**

```bash
git add docs/STATE.md docs/superpowers/specs/2026-09-21-frame-responsive-constraints-design.md
git commit -m "docs: STATE — responsive Frames slice 2 (the editor) landed"
```

---

## Self-review against the spec (slice 2 scope)

| Spec requirement | Task |
|---|---|
| "Responsive" in the size picker; design size kept; "Designed at" labelling | 3 |
| `sailor_frame.responsive` flag; fixed frames unchanged | 3, 4 (gates) |
| Artboard right/bottom/corner edges always draggable; grips on hover | 5 |
| Layout adapts live through `resolveLayout` | 4 |
| Size readout: two number fields + Shapes menu; Design/Viewing label; accent off-design; Back to design size; typing changes the viewing size only | 6 |
| Viewing size is editor-only, never saved; reopening starts at design | 4 (reset watcher) |
| Pins card: pin selects, Keep size, Holds to (only with a section), Automatic / Back to automatic | 7 |
| Guide lines to held edges / centre / section edges | 8 |
| Editing tools return to the design size for now | 9 |
| Boxes needed for guides at every size | Ruling B (guides only off-design, where boxes are populated) |

Out of slice 2 by the build order: editing at a viewing size and the drop rule (slice 3); the "Arrange" group card and the member Hug/Fill variant of the pins card (slice 4); the export "Adapt" (slice 5). The pins card intentionally omits the arranged-group variant.

Known follow-ups recorded for later slices: the identity path still returns empty `boxes`/`maps`, so guides at the exact design size are not drawn (Ruling B) — slice 3, which needs boxes at every size for hit-testing, should add a `withBoxes` path to `resolveLayout` or a sibling `designBoxes` helper; `selectedPins` recomputes `frameDocFromProps`+`buildunits` on each access (cheap, not per-frame) — memoize if a profile shows it.
