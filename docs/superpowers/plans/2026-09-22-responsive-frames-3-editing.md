# Responsive Frames — Slice 3: editing at a viewing size — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the designer select, move, nudge, resize, scale, rotate and edit text while the Frame editor shows a viewing size other than the design size — every edit stored at the design size by running the layer's pins backwards, following the spec's "drop rule" so nothing jumps.

**Architecture:** The design size stays the truth. The resolver learns to report, per layer, everything an edit needs (`units`: its unit, held pins, maps, reference rectangles, design and view boxes) behind a `withBoxes` option. A new pure module `lib/frame/responsive/viewEdit.ts` turns a view-space edit (a move by Δ, a new box, a scale ratio, a rotation) into design-space layer patches plus a pins decision. The Frame editor keeps its existing design-size editing untouched (byte-identical); off the design size it routes pointer, handle and arrow-key gestures to a small parallel path that hit-tests resolved boxes, draws handles from them, and commits through `viewEdit`. Design-only tools (brush, pen, node edit, region, smart select, generation, draw section, distort) stay design-only: they already snap back to the design size, and the size controls hide while one is active.

**Tech Stack:** TypeScript (Nuxt 4, Vue 3), Vitest for the pure modules (`tests/unit/**/*.unit.spec.ts`), the existing `resizeBox`/`boxHandles` helpers, the controller's browser pass for the Vue wiring.

**Spec:** `docs/superpowers/specs/2026-09-21-frame-responsive-constraints-design.md` — section "Editing at a viewing size" and Build order item 3. Slices 1 (resolver) and 2 (look-only editor) are on `main`.

## Global Constraints

- Work in the checkout the session is given; commit by exact path (`git add -- <paths>`), never `git add -A`, never `git stash`. End commit messages with the `Co-Authored-By:` line naming the model that wrote the commit.
- **No subagent runs a dev server** (`npm run dev` / `nuxt dev`): the shared :3002 is live and can take ComfyUI down. Vue tasks are verified by `nuxt typecheck` (grep your files) plus a read-through of the diff against the seams below; the controller does the browser pass.
- Unit tests: `cd frontend && node_modules/.bin/vitest run tests/unit/<file>`; run only your own files plus `tests/unit/responsive-` when you touch the resolver.
- Typecheck: `cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep '<file>'` — report the count before and after; add none. Baselines at the start of this slice: `CompositorModal.vue` 6, `ArtifactFrameNode.vue` 2, `lib/frame/responsive` 0. `nuxt typecheck` does not cover `tests/unit/**`.
- Units: `x`,`y` are the layer centre as fractions of frame width / height; every size (`w`, `h`, `fontSize`, `boxW`, `boxH`, `strokeWidth`) is a fraction of frame WIDTH. Resolved boxes, maps and `UnitInfo` are in PX: design px for design boxes (`W0 × H0`), view px for view boxes (`viewSize`, i.e. `W × H`).
- **Byte-identical at the design size.** A fixed Frame, and a responsive Frame at its design size, must edit exactly as today: every new branch is gated on `viewEditing` (responsive AND off the design size). The resolver's default (`withBoxes` absent) is unchanged.
- UI copy is sentence case with no internal identifiers.
- No new dependencies.

---

## Plain-language summary

Slice 2 let you *look* at a responsive Frame at other sizes; touching anything snapped it back to the design size. Slice 3 lets you *work* at any size.

- **Select and move** a layer while looking at, say, a wide banner. When you let go, Sailor stores the change at the design size, working backwards through the layer's pins, and applies the spec's **drop rule**: if you drag a left-hugging layer over to the right, it quietly becomes right-hugging (still automatic) — but only when that keeps it exactly where you dropped it. If no automatic choice keeps it there, it keeps the pin you were looking at, stored explicitly. It never jumps.
- **Resize, scale, rotate, nudge with the arrow keys, and edit text in place** — all at the viewing size, all stored at the design size.
- **A full-bleed background can't be dragged off its edges** at a viewing size (its edges are welded to the frame); everything else can.
- **Brush, pen, masks, region generation, smart select, draw section and distort still work at the design size only** — picking one returns you there, and the size controls hide while one is active.
- Also fixed on the way: the arrow keys, ⌘D and the group-resize handles were already editing (wrongly) at a viewing size; group pin edits now go into undo; applying a Layout-tab pattern clears the explicit pins on the layers it moves (the spec asks for it).
- Not in this slice: marquee (rubber-band) selection and snapping at a viewing size, and dropping a file at a specific point (a dropped file lands in the middle). Each is noted as later work.

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/frame/responsive/types.ts` (modify) | `UnitInfo`; `ResolveOptions.withBoxes`; `LayoutResult.units` |
| `frontend/app/lib/frame/responsive/resolve.ts` (modify) | fill `units` (and keep `boxes`/`maps`) when `withBoxes` is set, even when the layout is otherwise identity |
| `frontend/app/lib/frame/responsive/viewEdit.ts` (new) | the drop rule and every view→design edit: `settleAxis`, `moveUnitAtView`, `resizeLayerAtView`, `scaleLayerAtView`, `rotateLayerAtView`, `hitTestView`, `viewSelectionGeometry` |
| `frontend/app/lib/frame/responsive/index.ts` (modify) | re-export `viewEdit` and `UnitInfo` |
| `frontend/app/lib/frame/patterns/applyToFrame.ts` (modify) | strip explicit pins from layers a pattern moves |
| `frontend/app/components/vue-canvas/CompositorModal.vue` (modify) | view-editing plumbing, selection overlay, pointer/handle/keyboard/text-edit routing, pins history |
| `frontend/tests/unit/responsive-resolve-units.unit.spec.ts` (new) | `withBoxes` / `units` |
| `frontend/tests/unit/responsive-view-edit.unit.spec.ts` (new) | the drop rule and moves |
| `frontend/tests/unit/responsive-view-edit-shapes.unit.spec.ts` (new) | resize / scale / rotate / hit-test / selection geometry |
| `frontend/tests/unit/pattern-apply-clears-pins.unit.spec.ts` (new) | pattern apply clears explicit pins |

Rulings baked into this plan (record them in the ledger at execution):

- **Ruling A — a separate view-edit path.** Off the design size, gestures go through `viewEdit` + resolved boxes; `useLocalLayerEditor` is not retrofitted. At the design size nothing changes. — Cost if wrong: two gesture paths to maintain; accepted because it keeps the design-size editor byte-identical.
- **Ruling B — pins are held during a drag by writing them.** While dragging, every automatic axis of the dragged unit is written as an explicit pin (the pin it had at drag start) so the live re-resolve cannot flip it; on release the drop rule either clears it back to automatic or keeps it. The drag is one undo step, recorded on the first real movement. — Cost if wrong: none visible; the intermediate pins never survive a completed gesture.
- **Ruling C — bleeding stretched edges are welded.** A stretched axis whose design box touches the reference edge is drawn to the real box edge, which no design position maps to by the straight line. A move leaves such an axis alone; a resize keeps a bleeding side where it is. — Cost if wrong: you cannot drag a full-bleed background sideways at a viewing size (you can at the design size).
- **Ruling D — the reference rectangle is held for the gesture.** The drop rule uses the section or frame the unit sat in at drag start; if the drop moves it into a different grid section, the next resolve may re-attach it. — Cost if wrong: a layer dragged across a section boundary on a gridded responsive Frame may shift on release. Rare; later work.
- **Ruling E — later work:** marquee selection, snapping, dropping a file at a point, and group (multi-layer bounding box) resize at a viewing size. At a viewing size: click and shift-click select; a dropped file lands at the design centre (which appears in the middle of the view); the group-resize handles hide.

---

### Task 1: The resolver reports units (`withBoxes`)

**Files:**
- Modify: `frontend/app/lib/frame/responsive/types.ts`
- Modify: `frontend/app/lib/frame/responsive/resolve.ts`
- Test: `frontend/tests/unit/responsive-resolve-units.unit.spec.ts`

**Interfaces:**
- Consumes: the existing `resolveLayout` internals (`buildUnits`, `resolveAxis`, `sectionsAt`, `sectionOf`).
- Produces:
  ```ts
  export interface UnitInfo {
    unitId: string                                   // layer id, group id, or mask-source id
    kind: 'layer' | 'group' | 'maskPair' | 'cloner'
    memberIds: string[]
    canStretch: boolean                              // after Keep size
    kSize: number                                    // view px per design px for the unit's size
    designBox: ResolvedBox                           // design px, top-left
    viewBox: ResolvedBox                             // view px, top-left (as drawn)
    refDesign: ResolvedBox                           // the section or frame, design px
    refView: ResolvedBox                             // the same, view px
    h: AxisMap; v: AxisMap                           // resolved maps; .kind is the held (effective) pin
    hExplicit: boolean; vExplicit: boolean           // the pin on that axis is stored
  }
  // ResolveOptions gains:  withBoxes?: boolean
  // LayoutResult gains:    units: Map<string, UnitInfo>   // keyed by MEMBER layer id; empty unless withBoxes
  ```

With `withBoxes`, a responsive Frame always gets `boxes`, `maps` and `units` — including at the design size and at the same shape — while `layers` still come back by reference when nothing moved (`identity: true`). Without it, behaviour is exactly today's.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-resolve-units.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})

describe('resolveLayout withBoxes', () => {
  it('without withBoxes, units stay empty (unchanged behaviour)', () => {
    const r = resolveLayout(doc([createRectLayer({ id: 'a' })]), 1000, 500)
    expect(r.identity).toBe(true)
    expect(r.units.size).toBe(0)
    expect(r.boxes.size).toBe(0)
  })
  it('at the design size: identity, layers by reference, but boxes and units filled', () => {
    const l = [createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.1 })]
    const r = resolveLayout(doc(l), 1000, 500, { withBoxes: true })
    expect(r.identity).toBe(true)
    expect(r.layers).toBe(l)
    expect(r.boxes.get('a')).toEqual({ x: 400, y: 200, w: 200, h: 100 })
    const u = r.units.get('a')!
    expect(u.kind).toBe('layer'); expect(u.unitId).toBe('a'); expect(u.memberIds).toEqual(['a'])
    expect(u.kSize).toBe(1); expect(u.canStretch).toBe(true)
    expect(u.designBox).toEqual({ x: 400, y: 200, w: 200, h: 100 })
    expect(u.viewBox).toEqual({ x: 400, y: 200, w: 200, h: 100 })
    expect(u.refDesign).toEqual({ x: 0, y: 0, w: 1000, h: 500 })
    expect(u.refView).toEqual({ x: 0, y: 0, w: 1000, h: 500 })
    expect(u.h.kind).toBe('center'); expect(u.v.kind).toBe('center')
    expect(u.hExplicit).toBe(false); expect(u.vExplicit).toBe(false)
  })
  it('same shape, twice the size: identity and layers by reference, boxes scaled', () => {
    const l = [createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.1 })]
    const r = resolveLayout(doc(l), 2000, 1000, { withBoxes: true })
    expect(r.identity).toBe(true); expect(r.layers).toBe(l)
    expect(r.boxes.get('a')).toEqual({ x: 800, y: 400, w: 400, h: 200 })
    expect(r.units.get('a')!.kSize).toBe(2)
    expect(r.units.get('a')!.refView).toEqual({ x: 0, y: 0, w: 2000, h: 1000 })
  })
  it('off-shape: units carry the held pin, the view box and the view reference', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // left-hugging
    const r = resolveLayout(doc([a]), 3000, 500, { withBoxes: true })
    expect(r.identity).toBe(false)
    const u = r.units.get('a')!
    expect(u.h.kind).toBe('left')
    expect(u.viewBox).toEqual({ x: 550, y: 200, w: 100, h: 100 })
    expect(u.refView).toEqual({ x: 0, y: 0, w: 3000, h: 500 })
  })
  it('flags stored pins as explicit per axis', () => {
    const a = createRectLayer({ id: 'a', x: 0.9, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right' } })
    const u = resolveLayout(doc([a]), 3000, 500, { withBoxes: true }).units.get('a')!
    expect(u.hExplicit).toBe(true); expect(u.vExplicit).toBe(false)
  })
  it('every member of a group shares the group unit', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.3, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const r = resolveLayout(doc([a, b], { groups: [{ id: 'g' }] }), 3000, 500, { withBoxes: true })
    const ua = r.units.get('a')!, ub = r.units.get('b')!
    expect(ua.kind).toBe('group'); expect(ua.unitId).toBe('g')
    expect(ua.memberIds.slice().sort()).toEqual(['a', 'b'])
    expect(ub.unitId).toBe('g'); expect(ub.viewBox).toEqual(ua.viewBox)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-resolve-units.unit.spec.ts`
Expected: FAIL — `r.units` is undefined.

- [ ] **Step 3: Add the types**

In `types.ts`, add `UnitInfo` exactly as in Interfaces above (import `ResolvedBox`/`AxisMap` are already in this file). Add `withBoxes?: boolean` to `ResolveOptions` (doc: "Fill `boxes`, `maps` and `units` even when the layout is otherwise identity — for the editor, which needs them at every size. Layers still come back by reference when nothing moved."). Add `units: Map<string, UnitInfo>` to `LayoutResult` (doc: "Per member layer id: what an edit at this size needs. Empty unless `withBoxes`.").

- [ ] **Step 4: Fill `units` in `resolve.ts`**

1. `identityResult` returns `units: new Map()` as well.
2. Create `const units = new Map<string, UnitInfo>()` next to `boxes`/`maps`.
3. The early identity return (the `spare.x === 0 && spare.y === 0 && Math.abs(k - 1) < 1e-12 && !hasKeep` line) becomes `if (!opts.withBoxes && spare.x === 0 && spare.y === 0 && Math.abs(k - 1) < 1e-12 && !hasKeep) return identityResult(frame, gridOut)`.
4. Inside the unit loop, after `hx`, `vy`, `unitBox` are computed, build the unit's info ONCE (before the member loop):
   ```ts
   const info: Omit<UnitInfo, 'viewBox'> = {
     unitId: unit.id, kind: unit.kind, memberIds: unit.memberIds, canStretch, kSize,
     designBox: unit.box, refDesign: ref.design, refView: ref.box,
     h: hx.map, v: vy.map, hExplicit: unit.pins?.h != null, vExplicit: unit.pins?.v != null,
   }
   ```
   and in the member loop, right after `boxes.set(id, …)` in BOTH branches, add `units.set(id, { ...info, viewBox: boxes.get(id)! })`. (For a single layer the view box is its own drawn box — text anchoring included; for a rigid unit it is the unit box.)
5. The final `if (!changed && motion === frame.motion) return identityResult(frame, gridOut)` becomes:
   ```ts
   if (!changed && motion === frame.motion) {
     return opts.withBoxes
       ? { layers: frame.layers, motion: frame.motion, grid: gridOut, boxes, maps, units, identity: true }
       : identityResult(frame, gridOut)
   }
   ```
6. The normal return adds `units`.

- [ ] **Step 5: Run the new test and the whole responsive suite**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-resolve-units.unit.spec.ts` → PASS (6).
Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-` → all pass (104 + 6).

- [ ] **Step 6: Re-export, typecheck, commit**

`index.ts`: add `UnitInfo` to the exported types list.
Typecheck grep `lib/frame/responsive` → nothing.
```bash
git add -- frontend/app/lib/frame/responsive/types.ts frontend/app/lib/frame/responsive/resolve.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-resolve-units.unit.spec.ts
git commit -m "feat(frame): resolveLayout withBoxes — per-layer unit info for editing at any size"
```

---

### Task 2: The drop rule and moves (`viewEdit.ts`, part 1)

**Files:**
- Create: `frontend/app/lib/frame/responsive/viewEdit.ts`
- Modify: `frontend/app/lib/frame/responsive/index.ts`
- Test: `frontend/tests/unit/responsive-view-edit.unit.spec.ts`

**Interfaces:**
- Consumes: `invertMap` (`./axis`), `inferAxisPin` (`./infer`), `UnitInfo`, `AxisMap`, `AxisPin`, `PinV`, `ResolvedBox` (`./types`), `LocalLayer` (type, composable).
- Produces:
  ```ts
  export interface AxisSpan { start: number; extent: number }
  export interface AxisInfo { map: AxisMap; canStretch: boolean; explicit: boolean; design: AxisSpan; view: AxisSpan; refDesign: AxisSpan; refView: AxisSpan }
  export type PinWrite = { set: AxisPin } | { clear: true } | null           // null = leave the stored pin alone
  export interface Settled { near: number; far: number; pin: PinWrite }      // near/far in design px
  export interface ViewEdit {
    patches: Array<{ id: string; patch: Record<string, unknown> }>           // design-space layer patches
    pins: { unitId: string; onGroup: boolean; patch: Record<string, unknown> } | null  // h/v to merge; undefined value = back to automatic
  }
  export function axisInfo(u: UnitInfo, axis: 'h' | 'v'): AxisInfo
  export function bleeds(ax: AxisInfo): { near: boolean; far: boolean }
  export function designExtentFor(ax: AxisInfo, pin: AxisPin, a: number, b: number, designSize: number): [number, number]
  export function holdAxis(ax: AxisInfo, a: number, b: number, designSize: number): Settled
  export function settleAxis(ax: AxisInfo, a: number, b: number, designSize: number): Settled
  export function pinsPatch(u: UnitInfo, h: PinWrite, v: PinWrite): ViewEdit['pins']
  export function moveUnitAtView(u: UnitInfo, layers: LocalLayer[], W0: number, H0: number, dx: number, dy: number, phase: 'drag' | 'drop'): ViewEdit
  ```

The numbers in the tests all come from one setup: design 1000 × 500 shown at 3000 × 500. The fit scale is 1; the frame's spare room is 2000, of which the guard lets 1000 be used (`u = 1000`) and centres the rest (`o = 500`). So a left-held point `p` draws at `500 + p`, a right-held one at `1500 + p`, a centred one at `1000 + p`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-view-edit.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import { settleAxis, axisInfo, moveUnitAtView } from '~/lib/frame/responsive/viewEdit'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: LocalLayer[], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})
const unitAt = (layers: LocalLayer[], id: string, extra: Partial<FrameDoc> = {}) =>
  resolveLayout(doc(layers, extra), 3000, 500, { withBoxes: true }).units.get(id)!

// A left-hugging 100×100 rect: design 50..150, drawn at 550..650.
const leftRect = () => createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })

describe('settleAxis (the drop rule on one axis)', () => {
  it('stays automatic when the pin it had still fits', () => {
    const ax = axisInfo(unitAt([leftRect()], 'a'), 'h')
    const s = settleAxis(ax, 650, 750, 100)                 // moved +100: still in the left half
    expect(s.near).toBeCloseTo(150, 9); expect(s.far).toBeCloseTo(250, 9)
    expect(s.pin).toEqual({ clear: true })
  })
  it('takes the pin read from where it now sits in the view when that fits (left → right)', () => {
    const ax = axisInfo(unitAt([leftRect()], 'a'), 'h')
    const s = settleAxis(ax, 2050, 2150, 100)               // centre 2100: right half of the view
    expect(s.near).toBeCloseTo(550, 9); expect(s.far).toBeCloseTo(650, 9)   // 2100 − 1500 = 600
    expect(s.pin).toEqual({ clear: true })
  })
  it('keeps the pin you were looking at, stored, when no automatic pin fits', () => {
    const ax = axisInfo(unitAt([leftRect()], 'a'), 'h')
    const s = settleAxis(ax, 1750, 1850, 100)               // centre 1800
    // right would put it at 300 (reads as left); left puts it at 1300 (reads as right): neither agrees.
    expect(s.near).toBeCloseTo(1250, 9); expect(s.far).toBeCloseTo(1350, 9)
    expect(s.pin).toEqual({ set: 'left' })
  })
  it('an explicit pin maps straight back and is left alone', () => {
    const a = createRectLayer({ id: 'a', x: 0.9, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right' } })  // drawn at 2350..2450
    const ax = axisInfo(unitAt([a], 'a'), 'h')
    const s = settleAxis(ax, 2250, 2350, 100)               // centre 2300 → 2300 − 1500 = 800
    expect(s.near).toBeCloseTo(750, 9); expect(s.far).toBeCloseTo(850, 9)
    expect(s.pin).toBeNull()
  })
})

describe('moveUnitAtView', () => {
  it('drop: moves and stays automatic', () => {
    const l = [leftRect()]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, 100, 0, 'drop')
    expect(e.patches).toHaveLength(1)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.2, 9)
    expect(e.patches[0]!.patch.y).toBeCloseTo(0.5, 9)
    expect(e.pins).toEqual({ unitId: 'a', onGroup: false, patch: { h: undefined, v: undefined } })
  })
  it('drag holds the pin it had; drop then flips it to the automatic one — same place on screen', () => {
    const l = [leftRect()]
    const u = unitAt(l, 'a')
    const drag = moveUnitAtView(u, l, 1000, 500, 1500, 0, 'drag')
    expect(drag.patches[0]!.patch.x).toBeCloseTo(1.6, 9)          // held left: 2100 − 500 = 1600
    expect(drag.pins!.patch).toEqual({ h: 'left', v: 'middle' })
    const drop = moveUnitAtView(u, l, 1000, 500, 1500, 0, 'drop')
    expect(drop.patches[0]!.patch.x).toBeCloseTo(0.6, 9)          // right: 2100 − 1500 = 600
    expect(drop.pins!.patch).toEqual({ h: undefined, v: undefined })
  })
  it('drop: keeps the held pin, stored, when nothing automatic fits', () => {
    const l = [leftRect()]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, 1200, 0, 'drop')
    expect(e.patches[0]!.patch.x).toBeCloseTo(1.3, 9)
    expect(e.pins!.patch.h).toBe('left')
  })
  it('an explicit axis is not written', () => {
    const l = [createRectLayer({ id: 'a', x: 0.9, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'right' } })]
    const e = moveUnitAtView(unitAt(l, 'a'), l, 1000, 500, -100, 0, 'drop')
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.8, 9)
    expect('h' in e.pins!.patch).toBe(false)
    expect(e.pins!.patch).toEqual({ v: undefined })
  })
  it('a group moves every member by the same design delta; pins go on the group', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.3, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const l = [a, b]
    const e = moveUnitAtView(unitAt(l, 'a', { groups: [{ id: 'g' }] }), l, 1000, 500, 100, 0, 'drop')
    const by = Object.fromEntries(e.patches.map(p => [p.id, p.patch]))
    expect(by.a!.x).toBeCloseTo(0.2, 9); expect(by.b!.x).toBeCloseTo(0.4, 9)
    expect(e.pins).toMatchObject({ unitId: 'g', onGroup: true })
  })
  it('a full-bleed background does not move (its edges are welded to the frame)', () => {
    const l = [createRectLayer({ id: 'bg', x: 0.5, y: 0.5, w: 1, h: 0.5 })]
    const e = moveUnitAtView(unitAt(l, 'bg'), l, 1000, 500, 40, 30, 'drop')
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.5, 9)
    expect(e.patches[0]!.patch.y).toBeCloseTo(0.5, 9)
    expect(e.pins).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-view-edit.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/responsive/viewEdit`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/frame/responsive/viewEdit.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { invertMap } from './axis'
import { inferAxisPin } from './infer'
import type { AxisMap, AxisPin, PinV, UnitInfo } from './types'

const EPS = 1e-6
const V_NAME: Record<AxisPin, PinV> = { left: 'top', right: 'bottom', both: 'both', center: 'middle', relative: 'relative' }

export interface AxisSpan { start: number; extent: number }
/** One axis of a unit as the resolver placed it at the viewing size. Design px / view px. */
export interface AxisInfo {
  map: AxisMap              // map.kind is the HELD (effective) pin
  canStretch: boolean
  explicit: boolean         // the pin on this axis is stored
  design: AxisSpan          // the unit's design extent
  view: AxisSpan            // the unit's drawn extent
  refDesign: AxisSpan       // the section or frame, design px
  refView: AxisSpan         // the same, view px
}
/** What to do with the stored pin on one axis. null = leave it alone. */
export type PinWrite = { set: AxisPin } | { clear: true } | null
export interface Settled { near: number; far: number; pin: PinWrite }
export interface ViewEdit {
  patches: Array<{ id: string; patch: Record<string, unknown> }>
  pins: { unitId: string; onGroup: boolean; patch: Record<string, unknown> } | null
}

export function axisInfo(u: UnitInfo, axis: 'h' | 'v'): AxisInfo {
  const H = axis === 'h'
  const span = (b: { x: number; y: number; w: number; h: number }): AxisSpan =>
    H ? { start: b.x, extent: b.w } : { start: b.y, extent: b.h }
  return {
    map: H ? u.h : u.v, canStretch: u.canStretch, explicit: H ? u.hExplicit : u.vExplicit,
    design: span(u.designBox), view: span(u.viewBox), refDesign: span(u.refDesign), refView: span(u.refView),
  }
}

/** A stretched axis touching the reference edge is drawn to the REAL box edge (bleed). No design
 *  position maps there by the straight line, so a bleeding edge cannot follow the pointer. */
export function bleeds(ax: AxisInfo): { near: boolean; far: boolean } {
  if (ax.map.kind !== 'both') return { near: false, far: false }
  return {
    near: ax.design.start <= ax.refDesign.start + EPS,
    far: ax.design.start + ax.design.extent >= ax.refDesign.start + ax.refDesign.extent - EPS,
  }
}

/** The design extent [near, far] that draws at view extent [a, b] under `pin`.
 *  A stretching pin maps each edge back; any other pin maps the centre back and keeps `designSize`. */
export function designExtentFor(ax: AxisInfo, pin: AxisPin, a: number, b: number, designSize: number): [number, number] {
  const kind: AxisPin = pin === 'both' && !ax.canStretch ? 'center' : pin
  const m: AxisMap = { ...ax.map, kind }
  if (kind === 'both') {
    const viewEnd = ax.refView.start + ax.refView.extent
    const near = Math.abs(a - ax.refView.start) < EPS ? ax.refDesign.start : invertMap(m, a, 'near')
    const far = Math.abs(b - viewEnd) < EPS ? ax.refDesign.start + ax.refDesign.extent : invertMap(m, b, 'far')
    return [near, far]
  }
  const c = invertMap(m, (a + b) / 2)
  return [c - designSize / 2, c + designSize / 2]
}

/** During a drag: map back with the held pin and hold it (write it on an automatic axis). */
export function holdAxis(ax: AxisInfo, a: number, b: number, designSize: number): Settled {
  const [near, far] = designExtentFor(ax, ax.map.kind, a, b, designSize)
  return { near, far, pin: ax.explicit ? null : { set: ax.map.kind } }
}

/**
 * The drop rule on one axis (spec: "Editing at a viewing size"). [a, b] is where the unit is drawn
 * after the edit (view px). An explicit pin maps straight back. An automatic axis tries the pin read
 * from where it now sits in the VIEW, then the pin it had; the first whose mapped-back design
 * position reads as that same pin keeps it automatic. If neither does, the held pin is stored.
 * Either way the unit ends up drawn exactly at [a, b].
 */
export function settleAxis(ax: AxisInfo, a: number, b: number, designSize: number): Settled {
  const held = ax.map.kind
  if (ax.explicit) { const [near, far] = designExtentFor(ax, held, a, b, designSize); return { near, far, pin: null } }
  const viewPin = inferAxisPin(a, b - a, ax.refView.start, ax.refView.extent, ax.canStretch)
  for (const pin of viewPin === held ? [held] : [viewPin, held]) {
    const [near, far] = designExtentFor(ax, pin, a, b, designSize)
    if (inferAxisPin(near, far - near, ax.refDesign.start, ax.refDesign.extent, ax.canStretch) === pin) {
      return { near, far, pin: { clear: true } }
    }
  }
  const [near, far] = designExtentFor(ax, held, a, b, designSize)
  return { near, far, pin: { set: held } }
}

/** Pins to merge onto the unit: `set` writes the pin (vertical spelled top/bottom/middle), `clear`
 *  writes `undefined` (back to automatic). null when there is nothing to write. */
export function pinsPatch(u: UnitInfo, h: PinWrite, v: PinWrite): ViewEdit['pins'] {
  const patch: Record<string, unknown> = {}
  if (h) patch.h = 'set' in h ? h.set : undefined
  if (v) patch.v = 'set' in v ? V_NAME[v.set] : undefined
  return Object.keys(patch).length ? { unitId: u.unitId, onGroup: u.kind === 'group', patch } : null
}

/**
 * Move a unit by (dx, dy) VIEW px from where it was drawn at drag start. `u` and `layers` are the
 * unit info and stored layers captured at drag start (x/y are the origins, so the delta is total,
 * never cumulative). 'drag' holds the pins; 'drop' runs the drop rule. A bleeding stretched axis
 * stays put (Ruling C).
 */
export function moveUnitAtView(u: UnitInfo, layers: LocalLayer[], W0: number, H0: number, dx: number, dy: number, phase: 'drag' | 'drop'): ViewEdit {
  const one = (axis: 'h' | 'v', d: number): Settled => {
    const ax = axisInfo(u, axis)
    const bl = bleeds(ax)
    if (bl.near || bl.far) return { near: ax.design.start, far: ax.design.start + ax.design.extent, pin: null }
    const a = ax.view.start + d, b = ax.view.start + ax.view.extent + d
    return phase === 'drag' ? holdAxis(ax, a, b, ax.design.extent) : settleAxis(ax, a, b, ax.design.extent)
  }
  const sh = one('h', dx), sv = one('v', dy)
  const dcx = (sh.near + sh.far) / 2 - (u.designBox.x + u.designBox.w / 2)
  const dcy = (sv.near + sv.far) / 2 - (u.designBox.y + u.designBox.h / 2)
  const byId = new Map(layers.map(l => [l.id, l]))
  const patches = u.memberIds.flatMap((id) => {
    const l = byId.get(id)
    return l ? [{ id, patch: { x: l.x + dcx / W0, y: l.y + dcy / H0 } as Record<string, unknown> }] : []
  })
  return { patches, pins: pinsPatch(u, sh.pin, sv.pin) }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-view-edit.unit.spec.ts`
Expected: PASS (10). Every number in the test is derived in the comment above it from `500 + p` (left), `1500 + p` (right), `1000 + p` (centre); if one disagrees, re-derive before changing either side.

- [ ] **Step 5: Re-export, typecheck, commit**

`index.ts`: `export * from './viewEdit'` is NOT used elsewhere in the barrel — add the explicit list: `export { axisInfo, bleeds, designExtentFor, holdAxis, settleAxis, pinsPatch, moveUnitAtView } from './viewEdit'` and `export type { AxisInfo, AxisSpan, PinWrite, Settled, ViewEdit } from './viewEdit'`.
Typecheck grep `lib/frame/responsive` → nothing.
```bash
git add -- frontend/app/lib/frame/responsive/viewEdit.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-view-edit.unit.spec.ts
git commit -m "feat(frame): the drop rule — moves at a viewing size map back through the pins"
```

---

### Task 3: Resize, scale, rotate, hit-test and handles geometry (`viewEdit.ts`, part 2)

**Files:**
- Modify: `frontend/app/lib/frame/responsive/viewEdit.ts`
- Modify: `frontend/app/lib/frame/responsive/index.ts`
- Test: `frontend/tests/unit/responsive-view-edit-shapes.unit.spec.ts`

**Interfaces:**
- Consumes: Task 2's `axisInfo`, `bleeds`, `holdAxis`, `settleAxis`, `pinsPatch`, `ViewEdit`, `PinWrite`.
- Produces:
  ```ts
  /** New drawn box (view px, top-left, unrotated) for a single-layer unit. `fields` names where the
   *  width/height go: { w: 'w' | 'boxW', h: 'h' | 'boxH' | null } (null = height is derived). */
  export function resizeLayerAtView(u: UnitInfo, layer: LocalLayer, box: ResolvedBox, W0: number, H0: number, phase: 'drag' | 'drop', fields: { w: string; h: string | null }): ViewEdit
  /** Uniform scale about the centre: every `start` field × ratio (clamped 0.002..4). */
  export function scaleLayerAtView(u: UnitInfo, layer: LocalLayer, start: Record<string, number>, ratio: number, phase: 'drag' | 'drop'): ViewEdit
  /** New rotation (degrees); `designLocal` = the layer's unrotated size in design px. */
  export function rotateLayerAtView(u: UnitInfo, layer: LocalLayer, rotation: number, designLocal: { w: number; h: number }, phase: 'drag' | 'drop'): ViewEdit
  export function hitTestView(boxes: Map<string, ResolvedBox>, idsTopFirst: string[], x: number, y: number, pad: number): string | null
  /** Selection box for a unit in CANVAS px (× viewScale = canvas px per view px). */
  export function viewSelectionGeometry(u: UnitInfo, rotation: number, designLocal: { w: number; h: number }, viewScale: number): { cx: number; cy: number; hw: number; hh: number; rot: number }
  ```

Resize maps both edges back (so the stored size changes); scale and rotate keep the centre where it is and only decide the pins: on drop, an automatic axis stays automatic if the new design box still reads as the held pin, otherwise the held pin is stored (so the layer does not jump).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/responsive-view-edit-shapes.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import { resizeLayerAtView, scaleLayerAtView, rotateLayerAtView, hitTestView, viewSelectionGeometry } from '~/lib/frame/responsive/viewEdit'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: LocalLayer[]): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null,
})
const unitAt = (layers: LocalLayer[], id: string) =>
  resolveLayout(doc(layers), 3000, 500, { withBoxes: true }).units.get(id)!
const WH = { w: 'w', h: 'h' }

describe('resizeLayerAtView', () => {
  it('a left-held rect widened to the right stays left-held and stores the new width', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // drawn 550..650 × 200..300
    const e = resizeLayerAtView(unitAt([l], 'a'), l, { x: 550, y: 200, w: 200, h: 100 }, 1000, 500, 'drop', WH)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.15, 9)     // centre 650 → 650 − 500 = 150
    expect(e.patches[0]!.patch.w).toBeCloseTo(0.2, 9)
    expect(e.patches[0]!.patch.h).toBeCloseTo(0.1, 9)      // heights are fractions of WIDTH
    expect(e.pins!.patch).toEqual({ h: undefined, v: undefined })
  })
  it('a stretched rect widened stays stretched (the drop rule falls through to the pin it had)', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })     // design 50..950, drawn 550..2450
    const u = unitAt([l], 'a')
    expect(u.h.kind).toBe('both')
    const e = resizeLayerAtView(u, l, { x: 550, y: 200, w: 2000, h: 100 }, 1000, 500, 'drop', WH)
    // centred reading (1550 is within 4% of 1500) maps to −450..1550, which reads as stretched → rejected;
    // stretched maps the edges back to 50..1050 → reads as stretched → accepted.
    expect(e.patches[0]!.patch.w).toBeCloseTo(1.0, 9)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.55, 9)
    expect(e.pins!.patch.h).toBeUndefined()
  })
  it('a bleeding side stays welded to the frame edge', () => {
    const l = createRectLayer({ id: 'bg', x: 0.5, y: 0.5, w: 1, h: 0.5 })
    const e = resizeLayerAtView(unitAt([l], 'bg'), l, { x: 0, y: 0, w: 2600, h: 500 }, 1000, 500, 'drop', WH)
    expect(e.patches[0]!.patch.w).toBeCloseTo(1, 9)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.5, 9)
  })
  it('writes the box fields named by the caller, and no height when it is derived', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const e = resizeLayerAtView(unitAt([l], 'a'), l, { x: 550, y: 200, w: 200, h: 100 }, 1000, 500, 'drop', { w: 'boxW', h: null })
    expect(e.patches[0]!.patch.boxW).toBeCloseTo(0.2, 9)
    expect('h' in e.patches[0]!.patch).toBe(false)
    expect('w' in e.patches[0]!.patch).toBe(false)
  })
  it('drag holds the pins', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const e = resizeLayerAtView(unitAt([l], 'a'), l, { x: 550, y: 200, w: 200, h: 100 }, 1000, 500, 'drag', WH)
    expect(e.pins!.patch).toEqual({ h: 'left', v: 'middle' })
  })
})

describe('scaleLayerAtView', () => {
  it('scales the size fields and keeps a still-fitting pin automatic', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // 50..150 → ×2 → 0..200: still left
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.1, h: 0.1 }, 2, 'drop')
    expect(e.patches[0]!.patch).toEqual({ w: 0.2, h: 0.2 })
    expect(e.pins!.patch.h).toBeUndefined()
  })
  it('stores the held pin when the new size would read differently', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.5, h: 0.1 })     // 250..750 centred → ×2 → 0..1000 reads stretched
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.5, h: 0.1 }, 2, 'drop')
    expect(e.patches[0]!.patch.w).toBeCloseTo(1, 9)
    expect(e.pins!.patch.h).toBe('center')
  })
  it('clamps like the design-size scale does', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.1, h: 0.1 }, 100, 'drag')
    expect(e.patches[0]!.patch).toEqual({ w: 4, h: 4 })
  })
})

describe('rotateLayerAtView', () => {
  it('writes the rotation; a rotated layer cannot stretch, so a tall result still reads centred', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.4, h: 0.1 })     // 400×100, centred
    const e = rotateLayerAtView(unitAt([l], 'a'), l, 90, { w: 400, h: 100 }, 'drop')
    expect(e.patches[0]!.patch).toEqual({ rotation: 90 })
    expect(e.pins!.patch).toEqual({ h: undefined, v: undefined })
  })
})

describe('hitTestView', () => {
  const boxes = new Map([['a', { x: 0, y: 0, w: 100, h: 100 }], ['b', { x: 50, y: 50, w: 100, h: 100 }]])
  it('returns the topmost box under the point, with padding', () => {
    expect(hitTestView(boxes, ['b', 'a'], 60, 60, 0)).toBe('b')
    expect(hitTestView(boxes, ['b', 'a'], 10, 10, 0)).toBe('a')
    expect(hitTestView(boxes, ['b', 'a'], 158, 60, 8)).toBe('b')
    expect(hitTestView(boxes, ['b', 'a'], 159, 60, 8)).toBeNull()
    expect(hitTestView(boxes, ['b', 'a'], 500, 500, 8)).toBeNull()
  })
})

describe('viewSelectionGeometry', () => {
  it('an unrotated layer uses its drawn box, scaled to canvas px', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // drawn 550..650 × 200..300
    const g = viewSelectionGeometry(unitAt([l], 'a'), 0, { w: 100, h: 100 }, 0.2)
    expect(g.cx).toBeCloseTo(120, 9); expect(g.cy).toBeCloseTo(50, 9)
    expect(g.hw).toBeCloseTo(10, 9); expect(g.hh).toBeCloseTo(10, 9); expect(g.rot).toBe(0)
  })
  it('a rotated layer uses its own size × the fit scale, rotated', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 30 })
    const g = viewSelectionGeometry(unitAt([l], 'a'), 30, { w: 200, h: 100 }, 0.2)
    expect(g.hw).toBeCloseTo(20, 9); expect(g.hh).toBeCloseTo(10, 9); expect(g.rot).toBe(30)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-view-edit-shapes.unit.spec.ts`
Expected: FAIL — the new exports are missing.

- [ ] **Step 3: Add the functions to `viewEdit.ts`**

Add `ResolvedBox` to the `./types` import, then append:

```ts
/** The pins after an edit that keeps the centre where it is (scale, rotate): hold them while
 *  dragging; on drop an automatic axis stays automatic if the new design box still reads as the
 *  held pin, otherwise the held pin is stored so nothing moves. */
function holdPins(u: UnitInfo, nb: ResolvedBox, canStretch: boolean, phase: 'drag' | 'drop'): ViewEdit['pins'] {
  const one = (axis: 'h' | 'v'): PinWrite => {
    const ax = axisInfo(u, axis)
    if (ax.explicit) return null
    if (phase === 'drag') return { set: ax.map.kind }
    const start = axis === 'h' ? nb.x : nb.y, extent = axis === 'h' ? nb.w : nb.h
    return inferAxisPin(start, extent, ax.refDesign.start, ax.refDesign.extent, canStretch) === ax.map.kind
      ? { clear: true } : { set: ax.map.kind }
  }
  return pinsPatch(u, one('h'), one('v'))
}

export function resizeLayerAtView(u: UnitInfo, layer: LocalLayer, box: ResolvedBox, W0: number, H0: number, phase: 'drag' | 'drop', fields: { w: string; h: string | null }): ViewEdit {
  const one = (axis: 'h' | 'v', a0: number, b0: number): Settled => {
    const ax = axisInfo(u, axis)
    const bl = bleeds(ax)
    const a = bl.near ? ax.view.start : a0
    const b = bl.far ? ax.view.start + ax.view.extent : b0
    const size = (b - a) / u.kSize
    return phase === 'drag' ? holdAxis(ax, a, b, size) : settleAxis(ax, a, b, size)
  }
  const sh = one('h', box.x, box.x + box.w)
  const sv = one('v', box.y, box.y + box.h)
  const patch: Record<string, unknown> = { x: (sh.near + sh.far) / 2 / W0, y: (sv.near + sv.far) / 2 / H0 }
  patch[fields.w] = (sh.far - sh.near) / W0
  if (fields.h) patch[fields.h] = (sv.far - sv.near) / W0
  return { patches: [{ id: layer.id, patch }], pins: pinsPatch(u, sh.pin, sv.pin) }
}

export function scaleLayerAtView(u: UnitInfo, layer: LocalLayer, start: Record<string, number>, ratio: number, phase: 'drag' | 'drop'): ViewEdit {
  const patch: Record<string, unknown> = {}
  for (const k of Object.keys(start)) patch[k] = Math.min(4, Math.max(0.002, start[k]! * ratio))
  const b = u.designBox
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const nb = { x: cx - (b.w * ratio) / 2, y: cy - (b.h * ratio) / 2, w: b.w * ratio, h: b.h * ratio }
  return { patches: [{ id: layer.id, patch }], pins: holdPins(u, nb, u.canStretch, phase) }
}

export function rotateLayerAtView(u: UnitInfo, layer: LocalLayer, rotation: number, designLocal: { w: number; h: number }, phase: 'drag' | 'drop'): ViewEdit {
  const b = u.designBox
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const r = (rotation * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r))
  const w = designLocal.w * c + designLocal.h * s, h = designLocal.w * s + designLocal.h * c
  const nb = { x: cx - w / 2, y: cy - h / 2, w, h }
  const canStretch = u.canStretch && Math.abs(rotation) < EPS
  return { patches: [{ id: layer.id, patch: { rotation } }], pins: holdPins(u, nb, canStretch, phase) }
}

export function hitTestView(boxes: Map<string, ResolvedBox>, idsTopFirst: string[], x: number, y: number, pad: number): string | null {
  for (const id of idsTopFirst) {
    const b = boxes.get(id)
    if (b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return id
  }
  return null
}

export function viewSelectionGeometry(u: UnitInfo, rotation: number, designLocal: { w: number; h: number }, viewScale: number): { cx: number; cy: number; hw: number; hh: number; rot: number } {
  const vb = u.viewBox
  const single = u.kind === 'layer'
  // An unrotated layer's drawn box IS its box (stretch and text re-wrap included); a rotated one
  // cannot stretch, so its own size × the fit scale is exact.
  const useDrawn = !single || Math.abs(rotation) < EPS
  const w = useDrawn ? vb.w : designLocal.w * u.kSize
  const h = useDrawn ? vb.h : designLocal.h * u.kSize
  return { cx: (vb.x + vb.w / 2) * viewScale, cy: (vb.y + vb.h / 2) * viewScale, hw: (w / 2) * viewScale, hh: (h / 2) * viewScale, rot: single ? rotation : 0 }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-view-edit-shapes.unit.spec.ts` → PASS (12).
Run: `cd frontend && node_modules/.bin/vitest run tests/unit/responsive-` → all pass.

- [ ] **Step 5: Re-export, typecheck, commit**

Add the five new functions to the `viewEdit` export line in `index.ts`. Typecheck grep → nothing.
```bash
git add -- frontend/app/lib/frame/responsive/viewEdit.ts frontend/app/lib/frame/responsive/index.ts frontend/tests/unit/responsive-view-edit-shapes.unit.spec.ts
git commit -m "feat(frame): resize, scale, rotate, hit-test and handles at a viewing size"
```

---

### Task 4: Frame editor plumbing for editing at a viewing size

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: slice-2 state (`frameIsResponsive` ~370, `designSize` ~371, `viewSize` ~372, `atDesign` ~373, `resolved` ~378, `backToDesignSize` ~647, `viewOnlyGuard` ~652, `selectedPins` ~828, `cleanPins`, `setPins`), the editor surface from `useLocalLayerEditor(...)` (~738: `recordHistory`, `commit` — if `commit` is not destructured, use the editor object's `commit`), `localLayers`, `localGroups`, `writeGroups`.
- Produces (used by Tasks 5–8): `viewEditing` (computed boolean), `designOnlyToolActive` (computed boolean), `viewScale()` (canvas px per view px), `clientToView(e)` (view px), `applyViewEdits(edits: ViewEdit[])`.

- [ ] **Step 1: Ask the resolver for units**

In `resolved` (~378), pass `withBoxes: true`: `resolveLayout(doc, viewSize.w, viewSize.h, { measureCtx: measureCtx(), withBoxes: true })`. (`resolved` stays null at the design size, so the design-size path is untouched.)

- [ ] **Step 2: Give the design-space editor design-shaped dimensions**

The editor (`useLocalLayerEditor`) works in design space, but its `dims` is `canvasDisplay`, which takes the VIEW shape off the design size — so every `commit` re-syncs wired widgets (`syncAllWiredWidgets(n, next, dims(), …)`) and every arrow nudge converts px with the wrong shape. Change the `dims` option (~738) to:
```ts
dims: () => atDesign.value
  ? { w: canvasDisplay.w, h: canvasDisplay.h }
  : { w: canvasDisplay.w, h: canvasDisplay.w * designSize.value.h / Math.max(1, designSize.value.w) },
```
At the design size this is exactly today's value. (`atDesign`/`designSize` are declared ~370, before the editor, so there is no ordering problem.)

- [ ] **Step 3: The view-editing switch and the design-only tools**

Near the slice-2 block (~370–380):
```ts
// Editing at a viewing size (slice 3): responsive, off the design size, and resolved.
const viewEditing = computed(() => frameIsResponsive.value && !atDesign.value && !!resolved.value)
```
Near the tool state (after the tool refs exist — place it after the last of them; grep `brush.active`, `pen.active`, `nodeEdit.active`, `genActive`, `smartActive`, `regionSelectActive`, `drawSectionActive`, and the distort mode flag, e.g. `distortActive`/`distort.active`):
```ts
// Tools that paint or edit straight onto the artboard work at the design size only. They snap back
// when picked (viewOnlyGuard); while one is on, the size controls hide so the view cannot change under it.
const designOnlyToolActive = computed(() => !!(brush.active.value || pen.active.value || nodeEdit.active.value
  || genActive.value || smartActive.value || regionSelectActive.value || drawSectionActive.value || /* distort flag */ false))
```
Replace `/* distort flag */ false` with the real distort-mode flag (grep `toggleDistort` to find what it toggles). If a flag has a different name, use the real one and say so in the report.

Gate the slice-2 size controls on it: the edge grips' `<template v-if="frameIsResponsive">` becomes `v-if="frameIsResponsive && !designOnlyToolActive"`, and the toolbar readout's `v-if="frameIsResponsive"` likewise.

- [ ] **Step 4: Coordinates and the commit helper**

Next to `clientToNorm` (~1782):
```ts
/** Canvas px per view px (the artboard is drawn at canvasDisplay, laid out at viewSize). */
function viewScale(): number { return canvasDisplay.w / Math.max(1, viewSize.w) }
/** A pointer position in VIEW px (the space resolveLayout's boxes live in). */
function clientToView(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
  const r = canvasRef.value?.getBoundingClientRect(); if (!r || !r.width || !r.height) return null
  return { x: (e.clientX - r.left) / r.width * viewSize.w, y: (e.clientY - r.top) / r.height * viewSize.h }
}
```
Next to `setPins` (Task 7 of slice 2):
```ts
import type { ViewEdit } from '~/lib/frame/responsive'   // consolidate with the existing responsive import
/** Write view edits as ONE doc change (no history — the gesture records it once). Layer patches and
 *  a layer's pins merge into the same layer; a group's pins go to the group registry. */
function applyViewEdits(edits: ViewEdit[]) {
  const byId = new Map<string, Record<string, unknown>>()
  const groupPins = new Map<string, Record<string, unknown>>()
  for (const e of edits) {
    for (const p of e.patches) byId.set(p.id, { ...(byId.get(p.id) ?? {}), ...p.patch })
    if (e.pins) {
      if (e.pins.onGroup) groupPins.set(e.pins.unitId, { ...(groupPins.get(e.pins.unitId) ?? {}), ...e.pins.patch })
      else byId.set(e.pins.unitId, { ...(byId.get(e.pins.unitId) ?? {}), __pins: e.pins.patch })
    }
  }
  const next = localLayers.value.map((l) => {
    const p = byId.get(l.id); if (!p) return l
    const { __pins, ...rest } = p as { __pins?: Record<string, unknown> }
    const merged: Record<string, unknown> = { ...l, ...rest }
    if (__pins) merged.pins = cleanPins({ ...((l as any).pins ?? {}), ...__pins })
    return merged as unknown as LocalLayer
  })
  commit(next)
  if (groupPins.size) writeGroups(localGroups.value.map(g => groupPins.has(g.id)
    ? { ...g, pins: cleanPins({ ...(g.pins ?? {}), ...groupPins.get(g.id)! }) } : g))
}
```
(`cleanPins` drops keys whose value is `undefined`/`null` — the slice-2 helper — so a `{ h: undefined }` patch returns that axis to automatic.)

- [ ] **Step 5: Close the holes that were already editing at a viewing size**

1. Group-resize handles (the `@pointerdown="startGroupResize(corner, $event)"` block, ~7857) — add `&& atDesign` to their `v-if` (Ruling E).
2. `onCanvasDrop` (~1966): at a viewing size, drop at the design centre — right after `cx`/`cy` are computed: `const [dropX, dropY] = viewEditing.value ? [0.5, 0.5] : [cx, cy]`, and use `dropX`/`dropY` where `cx`/`cy` were passed on.

- [ ] **Step 6: Typecheck and commit**

`nuxt typecheck | grep CompositorModal` → 6 before, 6 after. Read through: every change is inert when `atDesign` is true (the `dims` branch, `viewEditing` false, the drop coordinates unchanged, the extra `v-if` term true).
```bash
git add -- frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): plumbing for editing at a viewing size (units, design-shaped editor dims, design-only tools)"
```

---

### Task 5: Select, move and nudge at a viewing size

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: Task 4 (`viewEditing`, `viewScale`, `clientToView`, `applyViewEdits`), Task 2/3 (`moveUnitAtView`, `hitTestView`, `viewSelectionGeometry`), `boxHandles` (from `~/composables/useLocalLayerEditor`), `localLayerBox` (from `~/composables/useCompositorLayers`), `mapKeyToEdit` (from `~/lib/compositor/layerEdits`), `resolveGroupCascade`, `selectLocal`, `toggleSelect`, `selectedIds`, `selectedLocalId`, `stackKeys`, `recordHistory`, `lastDownHitLayer`.
- Produces: `viewSel` (computed selection geometry, canvas px) consumed by Task 6's handles; the view drag state `viewDrag` (a `ref`) shared with Task 6.

- [ ] **Step 1: Selection geometry**

```ts
import { moveUnitAtView, hitTestView, viewSelectionGeometry, type UnitInfo } from '~/lib/frame/responsive'
import { boxHandles } from '~/composables/useLocalLayerEditor'   // if not already imported
// The selection drawn at a viewing size: one unit → a rotated box with handles; several → their union.
const viewSel = computed(() => {
  const r = resolved.value
  if (!viewEditing.value || !r || !selectedIds.value.size) return null
  const ids = [...selectedIds.value]
  const units = [...new Map(ids.map(id => r.units.get(id)).filter((u): u is UnitInfo => !!u).map(u => [u.unitId, u])).values()]
  if (!units.length) return null
  const sc = viewScale()
  if (units.length === 1) {
    const u = units[0]!
    const lead = localLayers.value.find(l => l.id === (u.kind === 'layer' ? u.memberIds[0] : selectedLocalId.value)) ?? null
    const rot = u.kind === 'layer' ? (lead?.rotation ?? 0) : 0
    const local = u.kind === 'layer' && lead
      ? localLayerBox(measureCtx(), lead, designSize.value.w, designSize.value.h) : { w: u.designBox.w, h: u.designBox.h }
    const g = viewSelectionGeometry(u, rot, local, sc)
    return { single: true as const, unit: u, layer: lead, local, g, handles: boxHandles(g.cx, g.cy, g.hw, g.hh, g.rot) }
  }
  const xs = units.flatMap(u => [u.viewBox.x, u.viewBox.x + u.viewBox.w]), ys = units.flatMap(u => [u.viewBox.y, u.viewBox.y + u.viewBox.h])
  const x0 = Math.min(...xs) * sc, x1 = Math.max(...xs) * sc, y0 = Math.min(...ys) * sc, y1 = Math.max(...ys) * sc
  return { single: false as const, units, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
})
```
Draw it next to the existing single-selection SVG (~7774), in the same `0 0 canvasDisplay.w canvasDisplay.h` space, reusing that SVG's stroke classes/colour:
```html
<svg v-if="viewSel" class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
  :viewBox="`0 0 ${canvasDisplay.w} ${canvasDisplay.h}`">
  <polygon v-if="viewSel.single"
    :points="`${viewSel.handles.tl.x},${viewSel.handles.tl.y} ${viewSel.handles.tr.x},${viewSel.handles.tr.y} ${viewSel.handles.br.x},${viewSel.handles.br.y} ${viewSel.handles.bl.x},${viewSel.handles.bl.y}`"
    fill="none" stroke="#3b82f6" stroke-width="1" vector-effect="non-scaling-stroke" />
  <rect v-else :x="viewSel.rect.x" :y="viewSel.rect.y" :width="viewSel.rect.w" :height="viewSel.rect.h"
    fill="none" stroke="#3b82f6" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
</svg>
```
(Match the design-size selection SVG's actual colour/classes — grep it and reuse.)

- [ ] **Step 2: Hit-test and the move drag**

```ts
// Layers top-first for hit-testing at a viewing size (unmigrated wired slots are not local layers).
function viewHitIds(): string[] {
  const byId = new Map(localLayers.value.map(l => [l.id, l]))
  return [...stackKeys.value].reverse().filter(k => k.startsWith('l:')).map(k => k.slice(2)).filter((id) => {
    const l = byId.get(id); if (!l || l.visible === false || l.locked) return false
    const gc = resolveGroupCascade(l.groupId, localGroups.value)
    return !gc.hidden && !gc.locked
  })
}
const viewDrag = ref<null | {
  kind: 'move'; sx: number; sy: number; units: UnitInfo[]; layers: LocalLayer[]; recorded: boolean; pointerId: number; el: HTMLElement
}>(null)
function onViewPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement)?.closest?.('[data-view-handle]')) return
  const r = resolved.value; const p = clientToView(e); if (!r || !p) return
  const pad = 8 * viewSize.w / Math.max(1, canvasRef.value!.getBoundingClientRect().width)
  const id = hitTestView(r.boxes, viewHitIds(), p.x, p.y, pad)
  if (!id) { lastDownHitLayer = false; if (!e.shiftKey) selectLocal(null); return }
  e.preventDefault(); e.stopPropagation()
  lastDownHitLayer = true
  if (e.shiftKey) { toggleSelect(id); return }
  if (!selectedIds.value.has(id)) selectLocal(id)
  const units = [...new Map([...selectedIds.value].map(sid => r.units.get(sid)).filter((u): u is UnitInfo => !!u).map(u => [u.unitId, u])).values()]
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture?.(e.pointerId)
  viewDrag.value = { kind: 'move', sx: e.clientX, sy: e.clientY, units, layers: localLayers.value.slice(), recorded: false, pointerId: e.pointerId, el }
}
function viewDelta(e: PointerEvent, d: { sx: number; sy: number }) {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { dx: (e.clientX - d.sx) * viewSize.w / rect.width, dy: (e.clientY - d.sy) * viewSize.h / rect.height }
}
function onViewPointerMove(e: PointerEvent) {
  const d = viewDrag.value; if (!d || d.kind !== 'move') return
  if (!d.recorded) { if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return; recordHistory(); d.recorded = true }
  const { dx, dy } = viewDelta(e, d)
  applyViewEdits(d.units.map(u => moveUnitAtView(u, d.layers, designSize.value.w, designSize.value.h, dx, dy, 'drag')))
}
function onViewPointerUp(e: PointerEvent) {
  const d = viewDrag.value; if (!d || d.kind !== 'move') return
  d.el.releasePointerCapture?.(d.pointerId)
  if (d.recorded) {
    const { dx, dy } = viewDelta(e, d)
    applyViewEdits(d.units.map(u => moveUnitAtView(u, d.layers, designSize.value.w, designSize.value.h, dx, dy, 'drop')))
  }
  viewDrag.value = null
}
```
Wire it:
- `onCanvasPointerDownCapture` (~3164): replace the first line `if (viewOnlyGuard()) return` with `if (viewEditing.value) { onViewPointerDown(e); return }`.
- `onCanvasPointerMoveCapture` and `onCanvasPointerUpCapture` (grep them; ~3224/3238): add at the top `if (viewDrag.value?.kind === 'move') { onViewPointerMove(e) ; return }` and `… { onViewPointerUp(e); return }` respectively. Add `@pointercancel="onCanvasPointerUpCapture"` on the `canvasRef` element if it has none, so a cancelled drag ends cleanly.
- `onCanvasClick` (~3410): replace `if (viewOnlyGuard()) return` with `if (viewEditing.value) { lastDownHitLayer = false; return }` — the view pointer-down already handled selection.
- `onCanvasDblClickCapture` (~3392): add at the top `if (viewEditing.value) { e.preventDefault(); return }` (Task 7 replaces this with in-place text editing).

- [ ] **Step 3: Arrow-key nudge at a viewing size**

`handleEditorKey` nudges in design space; at a viewing size one press must move the layer one canvas pixel ON SCREEN. In the capture-phase `onKeydown` (~1998), immediately BEFORE the `handleEditorKey(e)` line, add:
```ts
if (!typing && !editingId.value && !ownsKeys && viewEditing.value && viewNudge(e)) return
```
and define:
```ts
import { mapKeyToEdit } from '~/lib/compositor/layerEdits'   // if not already imported
function viewNudge(e: KeyboardEvent): boolean {
  const a = mapKeyToEdit(e, 1, 10)
  if (!a || a.type !== 'nudge' || !selectedIds.value.size) return false
  const r = resolved.value; if (!r) return false
  e.preventDefault()
  const k = viewSize.w / Math.max(1, canvasDisplay.w)          // canvas px → view px
  const units = [...new Map([...selectedIds.value].map(id => r.units.get(id)).filter((u): u is UnitInfo => !!u).map(u => [u.unitId, u])).values()]
  recordHistory()
  const layers = localLayers.value.slice()
  applyViewEdits(units.map(u => moveUnitAtView(u, layers, designSize.value.w, designSize.value.h, a.dxPx * k, a.dyPx * k, 'drop')))
  return true
}
```
(Check `mapKeyToEdit`'s real return shape — the survey shows `{ type: 'nudge', dxPx, dyPx }`; adapt field names if they differ.) ⌘D, ⌘C/⌘V, Delete and ⌘Z keep going through their existing handlers — they work in design space, which the design-shaped `dims` (Task 4) keeps correct.

- [ ] **Step 4: Typecheck and commit**

`nuxt typecheck | grep CompositorModal` → no new errors. Read through: at the design size `viewEditing` is false, so `onCanvasPointerDownCapture`, the move/up handlers, click, dblclick and `onKeydown` behave exactly as before; the new SVG renders nothing (`viewSel` null).
```bash
git add -- frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): select, move and nudge at a viewing size (the drop rule on release)"
```

---

### Task 6: Resize, scale and rotate handles at a viewing size

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: Task 5 (`viewSel`, `viewDrag`, `viewDelta`), Task 4 (`applyViewEdits`, `clientToView`, `viewScale`), Task 3 (`resizeLayerAtView`, `scaleLayerAtView`, `rotateLayerAtView`), `resizeBox` + `Handle` (from `~/lib/compositor/resizeBox`), `resizableKind`, `cornerResizableKind`, `aspectLockedResizeKind`, `textBoxResizable` (from `~/composables/useLocalLayerEditor`).
- Produces: view handles; nothing consumed later.

A single selected layer gets handles at a viewing size. Resize (edges and corners) applies to kinds that resize at the design size (`cornerResizableKind` or `textBoxResizable`), unrotated; a corner on anything else (text without a box, lines, paths, rotated layers) scales uniformly — exactly the split the design-size handles use.

- [ ] **Step 1: Extend the drag state and add the three gestures**

Widen `viewDrag`'s type with:
```ts
| { kind: 'resize'; handle: Handle; unit: UnitInfo; layer: LocalLayer; start: { cx: number; cy: number; w: number; h: number }; p0: { x: number; y: number }; fields: { w: string; h: string | null }; locked: boolean; recorded: boolean; pointerId: number; el: HTMLElement }
| { kind: 'scale'; unit: UnitInfo; layer: LocalLayer; cx: number; cy: number; startDist: number; start: Record<string, number>; recorded: boolean; pointerId: number; el: HTMLElement }
| { kind: 'rotate'; unit: UnitInfo; layer: LocalLayer; cx: number; cy: number; startAngle: number; startRot: number; local: { w: number; h: number }; recorded: boolean; pointerId: number; el: HTMLElement }
```
Then:
```ts
function viewCentreClient(): { x: number; y: number } | null {
  const s = viewSel.value; const rect = canvasRef.value?.getBoundingClientRect()
  if (!s || !s.single || !rect) return null
  return { x: rect.left + s.g.cx / canvasDisplay.w * rect.width, y: rect.top + s.g.cy / canvasDisplay.h * rect.height }
}
function beginViewHandle(e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  const el = e.currentTarget as HTMLElement; el.setPointerCapture?.(e.pointerId); return el
}
function onViewResizeDown(handle: Handle, e: PointerEvent) {
  const s = viewSel.value; const p = clientToView(e)
  if (!s || !s.single || !s.layer || !p || s.unit.kind !== 'layer') return
  const el = beginViewHandle(e)
  const l = s.layer, vb = s.unit.viewBox
  const tb = textBoxResizable(l), locked = aspectLockedResizeKind(l.kind)
  viewDrag.value = { kind: 'resize', handle, unit: s.unit, layer: l, start: { cx: vb.x + vb.w / 2, cy: vb.y + vb.h / 2, w: vb.w, h: vb.h },
    p0: p, fields: { w: tb ? 'boxW' : 'w', h: locked ? null : (tb ? 'boxH' : 'h') }, locked, recorded: false, pointerId: e.pointerId, el }
}
function onViewScaleDown(e: PointerEvent) {
  const s = viewSel.value; const c = viewCentreClient()
  if (!s || !s.single || !s.layer || !c) return
  const el = beginViewHandle(e)
  const l = s.layer as any
  const start: Record<string, number> = l.kind === 'text' ? { fontSize: l.fontSize }
    : l.kind === 'line' || l.kind === 'wired' ? { w: l.w } : l.kind === 'path' ? { scale: l.scale } : { w: l.w, h: l.h }
  viewDrag.value = { kind: 'scale', unit: s.unit, layer: s.layer, cx: c.x, cy: c.y, startDist: Math.max(1, Math.hypot(e.clientX - c.x, e.clientY - c.y)), start, recorded: false, pointerId: e.pointerId, el }
}
function onViewRotateDown(e: PointerEvent) {
  const s = viewSel.value; const c = viewCentreClient()
  if (!s || !s.single || !s.layer || !c) return
  const el = beginViewHandle(e)
  viewDrag.value = { kind: 'rotate', unit: s.unit, layer: s.layer, cx: c.x, cy: c.y, startAngle: Math.atan2(e.clientY - c.y, e.clientX - c.x),
    startRot: s.layer.rotation, local: s.local, recorded: false, pointerId: e.pointerId, el }
}
function viewHandleEdit(e: PointerEvent, phase: 'drag' | 'drop') {
  const d = viewDrag.value; if (!d || d.kind === 'move') return
  const W0 = designSize.value.w, H0 = designSize.value.h
  if (d.kind === 'resize') {
    const p = clientToView(e); if (!p) return
    const b = resizeBox(d.start, 0, d.handle, d.p0, p, { aspect: e.shiftKey || d.locked, fromCenter: e.altKey })
    applyViewEdits([resizeLayerAtView(d.unit, d.layer, { x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h }, W0, H0, phase, d.fields)])
  } else if (d.kind === 'scale') {
    const ratio = Math.max(0.05, Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d.startDist)
    applyViewEdits([scaleLayerAtView(d.unit, d.layer, d.start, ratio, phase)])
  } else {
    let rot = d.startRot + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.startAngle) * 180) / Math.PI
    rot = ((rot + 180) % 360 + 360) % 360 - 180
    if (e.shiftKey) rot = Math.round(rot / 15) * 15
    applyViewEdits([rotateLayerAtView(d.unit, d.layer, Math.round(rot), d.local, phase)])
  }
}
function onViewHandleMove(e: PointerEvent) {
  const d = viewDrag.value; if (!d || d.kind === 'move') return
  if (!d.recorded) { recordHistory(); d.recorded = true }
  viewHandleEdit(e, 'drag')
}
function onViewHandleUp(e: PointerEvent) {
  const d = viewDrag.value; if (!d || d.kind === 'move') return
  d.el.releasePointerCapture?.(d.pointerId)
  if (d.recorded) viewHandleEdit(e, 'drop')
  viewDrag.value = null
}
```
(Import `resizeBox` and `type Handle` from `~/lib/compositor/resizeBox`; `resizeBox(start, rotationDeg, handle, p0, p1, opts)` returns a centre box — confirm by reading its first 40 lines.)

- [ ] **Step 2: Draw the handles**

Next to the Task 5 SVG, mirroring the design-size handle markup (~7818–7830; reuse its classes so they look identical), shown only for a single selection:
```html
<template v-if="viewSel && viewSel.single && viewSel.layer && viewSel.unit.kind === 'layer'">
  <div v-for="corner in (['tl','tr','br','bl'] as const)" :key="'vc'+corner" data-view-handle
    class="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white border border-[#3b82f6] pointer-events-auto"
    :style="{ left: viewSel.handles[corner].x + 'px', top: viewSel.handles[corner].y + 'px', cursor: 'nwse-resize' }"
    @pointerdown="(Math.abs(viewSel.layer.rotation) < 1e-9 && (cornerResizableKind(viewSel.layer.kind) || textBoxResizable(viewSel.layer)))
      ? onViewResizeDown(corner, $event) : onViewScaleDown($event)"
    @pointermove="onViewHandleMove" @pointerup="onViewHandleUp" @pointercancel="onViewHandleUp" />
  <template v-if="Math.abs(viewSel.layer.rotation) < 1e-9 && (resizableKind(viewSel.layer.kind) || textBoxResizable(viewSel.layer))">
    <div v-for="edge in (['t','r','b','l'] as const)" :key="'ve'+edge" data-view-handle
      class="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white border border-[#3b82f6] pointer-events-auto"
      :style="{ left: viewSel.handles[edge].x + 'px', top: viewSel.handles[edge].y + 'px', cursor: edge === 't' || edge === 'b' ? 'ns-resize' : 'ew-resize' }"
      @pointerdown="onViewResizeDown(edge, $event)" @pointermove="onViewHandleMove" @pointerup="onViewHandleUp" @pointercancel="onViewHandleUp" />
  </template>
  <div data-view-handle
    class="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border border-[#3b82f6] pointer-events-auto cursor-grab"
    :style="{ left: viewSel.handles.rot.x + 'px', top: viewSel.handles.rot.y + 'px' }"
    @pointerdown="onViewRotateDown" @pointermove="onViewHandleMove" @pointerup="onViewHandleUp" @pointercancel="onViewHandleUp" />
</template>
```
Place this in the same container as the design-size handles (so the same positioning context applies — their `left/top` are canvas px in that container). If the design-size handles use a different element/size convention, copy theirs. Handles appear only for a single-LAYER unit: a selected group, mask pair or cloner gets the outline only (move it by dragging; Ruling E) — its lead member must never be scaled on its own.

- [ ] **Step 3: Typecheck and commit**

`nuxt typecheck | grep CompositorModal` → no new errors. Read through: the handles render only when `viewSel` is non-null (a viewing size with a selection); each handle's pointer capture keeps its release-click off the backdrop.
```bash
git add -- frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): resize, scale and rotate handles at a viewing size"
```

---

### Task 7: Edit text in place at a viewing size

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: Task 5 (`hitTestView`, `viewHitIds`, `clientToView`), `resolved`, `layoutScaleOf` (from `~/lib/frame/responsive`), the editor's text-edit entry (`beginEdit` — grep `onCanvasDblClick` in `useLocalLayerEditor.ts` to find how it starts editing a text layer; call the same function), `enterNodeEdit`, `backToDesignSize`, `editingStyle` (~3440).
- Produces: nothing consumed later.

- [ ] **Step 1: Double-click at a viewing size**

Replace Task 5's placeholder at the top of `onCanvasDblClickCapture` with:
```ts
if (viewEditing.value) {
  e.preventDefault(); e.stopPropagation()
  const r = resolved.value; const p = clientToView(e); if (!r || !p) return
  const pad = 8 * viewSize.w / Math.max(1, canvasRef.value!.getBoundingClientRect().width)
  const id = hitTestView(r.boxes, viewHitIds(), p.x, p.y, pad)
  const l = id ? localLayers.value.find(x => x.id === id) : null
  if (l?.kind === 'text') beginEdit(l.id)                               // edit in place at this size
  else if (l?.kind === 'path') { backToDesignSize(); void enterNodeEdit(l.id) }  // node editing is design-only
  return
}
```
(If the editor's text-edit entry is not named `beginEdit` or is not destructured in the modal, destructure it from the editor or call the editor's `onCanvasDblClick(e, id)` — whichever starts editing a known id; report which.)

- [ ] **Step 2: Position the editor over the drawn text**

At the top of `editingStyle` (~3440), add a viewing-size branch that positions the textarea over the RESOLVED layer (the layer as drawn) and returns the same style object shape the design-size branch returns:
```ts
if (viewEditing.value && resolved.value) {
  const r = resolved.value
  const rl = r.layers.find(x => x.id === editingLayer.value?.id) as TextLayer | undefined
  const box = rl ? r.boxes.get(rl.id) : undefined
  if (rl && box) {
    const sc = viewScale(), k = layoutScaleOf(rl)
    // …the design-size branch's style object, with these four positions/sizes swapped in:
    //   left:     rl.x * canvasDisplay.w + 'px'
    //   top:      rl.y * canvasDisplay.h + 'px'
    //   width:    Math.max(box.w * sc + 8, 40) + 'px'
    //   height:   Math.max(box.h * sc + 6, 24) + 'px'
    //   fontSize: rl.fontSize * canvasDisplay.w * k + 'px'
    // and every other property (font family/weight, lineHeight, letterSpacing, textAlign, colour,
    // transform with rl.rotation) copied from the design-size branch, reading from `rl`.
  }
}
```
Write it out in full by copying the design-size branch's returned object and swapping exactly those five entries (plus `rl` for `l`) — do not change the design-size branch. The painter already skips the layer being edited by id, and the textarea's `@input` writes `text`, which is the same at every size.

- [ ] **Step 3: Typecheck and commit**

`nuxt typecheck | grep CompositorModal` → no new errors. Read through: both new branches are gated on `viewEditing`.
```bash
git add -- frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(frame): edit text in place at a viewing size"
```

---

### Task 8: Pins in undo, and patterns clear the pins they override

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (`setPins`)
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts`
- Test: `frontend/tests/unit/pattern-apply-clears-pins.unit.spec.ts`

**Interfaces:**
- Produces: `export function clearPinsOfMoved(before: LocalLayer[], after: LocalLayer[]): LocalLayer[]` in `applyToFrame.ts`.

- [ ] **Step 1: Group pin edits record history**

In `setPins` (slice 2), the group branch calls `writeGroups(…)` without recording history (the layer branch goes through `setLocal`, which does). Add `recordHistory()` immediately before that `writeGroups(…)` call.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/tests/unit/pattern-apply-clears-pins.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { clearPinsOfMoved } from '~/lib/frame/patterns/applyToFrame'

describe('clearPinsOfMoved', () => {
  it('drops explicit pins from layers whose placement changed, keeps them on the rest', () => {
    const moved = createRectLayer({ id: 'a', x: 0.2, pins: { h: 'right' } })
    const still = createRectLayer({ id: 'b', x: 0.7, pins: { v: 'bottom' } })
    const out = clearPinsOfMoved([moved, still], [{ ...moved, x: 0.4 }, still])
    expect(out[0]!.pins).toBeUndefined()
    expect(out[1]).toBe(still)
  })
  it('counts size, font size and rotation changes as moves; ignores colour', () => {
    const a = createRectLayer({ id: 'a', pins: { h: 'left' } })
    expect(clearPinsOfMoved([a], [{ ...a, w: a.w * 2 }])[0]!.pins).toBeUndefined()
    expect(clearPinsOfMoved([a], [{ ...a, rotation: 15 }])[0]!.pins).toBeUndefined()
    expect(clearPinsOfMoved([a], [{ ...a, fill: '#ff0000' }])[0]!.pins).toEqual({ h: 'left' })
  })
  it('a layer with no pins, or a new layer, passes through untouched', () => {
    const a = createRectLayer({ id: 'a' })
    const n = createRectLayer({ id: 'n', pins: { h: 'left' } })
    const out = clearPinsOfMoved([a], [{ ...a, x: 0.9 }, n])
    expect(out[0]!.pins).toBeUndefined()
    expect(out[1]).toBe(n)
  })
})
```
Run: `cd frontend && node_modules/.bin/vitest run tests/unit/pattern-apply-clears-pins.unit.spec.ts` → FAIL (missing export).

- [ ] **Step 3: Implement and use it**

In `applyToFrame.ts`:
```ts
const PLACEMENT_KEYS = ['x', 'y', 'w', 'h', 'boxW', 'boxH', 'fontSize', 'rotation', 'scale'] as const
/** A pattern is a new arrangement: any layer it moved loses its explicit pins (spec, "Editing at a
 *  viewing size"). Unmoved and new layers come back by reference. */
export function clearPinsOfMoved(before: LocalLayer[], after: LocalLayer[]): LocalLayer[] {
  const prev = new Map(before.map(l => [l.id, l as unknown as Record<string, unknown>]))
  return after.map((l) => {
    const p = prev.get(l.id)
    if (!p || !(l as { pins?: unknown }).pins) return l
    const cur = l as unknown as Record<string, unknown>
    if (!PLACEMENT_KEYS.some(k => p[k] !== cur[k])) return l
    const { pins: _drop, ...rest } = l as LocalLayer & { pins?: unknown }
    return rest as LocalLayer
  })
}
```
In `applyPatternToFrame`, replace `args.editor.commit(plan.layers)` with `args.editor.commit(clearPinsOfMoved(<the current layers>, plan.layers))`, where `<the current layers>` is the layer list the plan was computed from — read `PlanArgs`/`ApplyArgs` (top of the file) to find it (it is either on the args or on `args.editor`); report which you used.

- [ ] **Step 4: Verify and commit**

Run the new spec → PASS (3). Run `cd frontend && node_modules/.bin/vitest run tests/unit/` filtered to pattern specs (`ls tests/unit | grep -i pattern`) → still pass. Typecheck grep `applyToFrame\|CompositorModal` → no new errors.
```bash
git add -- frontend/app/lib/frame/patterns/applyToFrame.ts frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/unit/pattern-apply-clears-pins.unit.spec.ts
git commit -m "feat(frame): group pin edits undo; applying a pattern clears the pins it overrides"
```

---

### Task 9: Dashboard

**Files:**
- Modify: `docs/STATE.md`

- [ ] **Step 1: Add the entry**

Newest-first in the Frame section, in the file's house style (heading `### Responsive Frames — slice 3, editing at a viewing size — LANDED <date> (<range>, subagent-driven, a review per task)` and a bold **What:** paragraph). Say, in plain language: select / move / nudge / resize / scale / rotate / edit text now work at any viewing size and are stored at the design size through the pins; the drop rule keeps a dragged layer automatic when it can and stores the pin you were looking at when it can't, so nothing jumps; bleeding stretched edges are welded; design-only tools stay design-only (size controls hide while one is on); fixed the arrow keys / ⌘D / group-resize handles / wired-widget sync that were already running at a viewing size; group pin edits undo; patterns clear the pins they override. **Later:** marquee and snapping at a viewing size, dropping a file at a point, group bounding-box resize at a viewing size, a layer dragged across a grid-section boundary may re-attach. **Owed:** the controller's browser pass (as for slice 2).

- [ ] **Step 2: Commit**

```bash
git add -- docs/STATE.md
git commit -m "docs: STATE — responsive Frames slice 3 (editing at a viewing size) landed"
```

---

## Self-review against the spec (slice 3 scope)

| Spec: "Editing at a viewing size" | Task |
|---|---|
| The design size stays the truth; an edit is stored by running the map backwards | 2, 3 |
| Select | 5 |
| Move | 2, 5 |
| Resize | 3, 6 |
| Rotate | 3, 6 |
| Nudge | 5 |
| Edit text | 7 |
| Every inspector change | already design-space; unaffected (Task 4's design-shaped `dims` keeps derived widgets right) |
| Delete, duplicate, reorder | already design-space; unaffected (Task 4) |
| Add text / shape / image | already added at the design centre (appears in the middle of the view); a dropped file lands there too (Task 4, Ruling E) |
| Record a position keyframe | the Motion tab seeds tracks from the stored (design) value — unaffected |
| The drop rule (pins held during a drag; view pin, then held pin; else store held) | 2 (`settleAxis`), 5/6 (hold while dragging, settle on release) |
| Tools that draw straight onto the artboard return to the design size | slice 2 guards + Task 4 (size controls hide while one is active) |
| Applying a Layout-tab pattern clears explicit pins on the layers it moves | 8 |

Known limits recorded for later: Rulings C, D, E.
