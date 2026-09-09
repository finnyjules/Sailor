# Poster Order, Insert & Sheet Model (sub-project 1b-ii-core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps the 1b-core final review found so the apply bridge is correct end-to-end before any UI turns it on: (R1) honour the engine's `z` hints by writing the Frame's **draw order** in the same undo step; (R3) **insert** a library shape layer when a pattern wants one and none is placed; (R2) make the **measure agree with the renderer** (face, weight, case, font stack from the title layer); and give the sheet UI a tested **data model** (tiles from patterns × seeds). No UI in this plan.

**Architecture:** Pure logic stays in `frontend/app/lib/frame/patterns/` and is unit-tested: `order.ts` (z → stack order), `insert.ts` (sentinel op → a real `PathLayer` via the existing `createShapeLayer`), `sheet.ts` (tiles). Two tiny, surgical changes to existing composables expose what the bridge needs: `useLocalLayerEditor` exports its private `writeOrder`, and `useCompositorLayers` exports its private `cssFontStack`. `applyToFrame.ts` becomes the one place that sequences `recordHistory()` → `commit(layers)` → `writeOrder(order)`.

**Tech Stack:** TypeScript, Vitest. Consumes 1a + 1b-core (`~/lib/frame/patterns`), `~/lib/shapes/pathLayer` (`createShapeLayer`), `~/lib/shapes/catalog` (`shapeById`), `~/lib/compositor/frameStack` (`localStackKey`, `framePresentKeys`).

## Global Constraints

- **One undo step, extended:** the sequence is `editor.recordHistory()` ONCE → `editor.commit(nextLayers)` ONCE → `editor.writeOrder(nextOrder)` ONCE. `writeOrder` is called AFTER `commit`, and both AFTER the single `recordHistory()` (the snapshot type already includes `order`, so undo restores both). NEVER call `addLocal` (it records its own history → a second undo step).
- **Draw order lives in `sailor_stackOrder`** (StackKeys, `'l:<id>'` for local layers via `localStackKey`, bottom→top), NOT in the layer array. A key absent from the array is appended on top by the renderer at paint time; a persisted order must therefore be **reconciled** (present keys kept in saved order, newcomers appended) before it is edited — mirror `ArtifactFrameNode.vue`'s `stackKeys` logic exactly.
- **z semantics:** among the layers a placement TOUCHED, lower `z` draws first (behind). Untouched layers keep their relative positions. Default `z` is 0.
- **Insert via the real factory:** a new shape layer is built with `createShapeLayer(shapeById(op.shapeId), { x, y, targetWidth: w, fill })` from `~/lib/shapes/pathLayer` — it sets `shapeId`, `d`, `bbox`, `fillRule`. Never hand-roll a path layer. The engine's `shapeCounter` keeps emitting `target: 'shape'` when no shape layer exists; the bridge resolves that sentinel by inserting.
- **Measure parity:** the width oracle and the renderer must agree: face + weight from the **title layer** (`fontFamily`/`fontWeight`, `axes.wght` overriding weight if present), the measured string passed through the layer's `textTransform`, and the font stack from the renderer's own `cssFontStack`. `document.fonts.ready` is the UI's concern (1b-ii-ui), not this plan's.
- **Contract preserved:** nothing here writes a face, weight, or literal colour onto a layer except an inserted shape's `fill`, which is a role-resolved palette hex.
- **Tests:** `frontend/tests/unit/<name>.unit.spec.ts`, run `cd frontend && npx vitest run tests/unit/<file>`; import `{ describe, it, expect, vi }` explicitly.
- **Commit hygiene (shared checkout):** the ENTIRE private-index recipe in ONE shell call, `unset` before the resync, then a separate-call `git status --porcelain -- <files>` check: `export GIT_INDEX_FILE=$(mktemp) && git read-tree HEAD && git add <exact paths> && git diff --cached --name-only && git commit -m "…" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- <same paths>`. The `--name-only` output MUST list only your files. Never `git add -A`/`.`/`git stash`/`cp .git/index`. Commit on `main`.

---

## File Structure

- `frontend/app/composables/useLocalLayerEditor.ts` (modify, 1 line) — add the existing private `writeOrder` to the composable's returned object.
- `frontend/app/composables/useCompositorLayers.ts` (modify, 2 words) — `export` the existing private `cssFontStack` and `transformCase`.
- `frontend/app/lib/frame/patterns/order.ts` (new) — `reconcileOrder(saved, present)`, `orderWithZ(order, zByKey)`, `nextOrderFor(saved, present, ops, elements, insertedIds)`.
- `frontend/app/lib/frame/patterns/insert.ts` (new) — `insertFromOps(layers, ops, palette)` → `{ layers, inserted: {opIndex, id}[] }` creating shape layers for sentinel shape ops.
- `frontend/app/lib/frame/patterns/frameMeasure.ts` (modify) — `fontStack` delegates to the exported `cssFontStack`; add `titleMeasureFrom(layer)` → `{ family, weight, transform }`.
- `frontend/app/lib/frame/patterns/applyToFrame.ts` (modify) — derive face/weight/case from the title layer; run `insertFromOps` then `applyPlacement`; compute `nextOrderFor`; call `writeOrder`; `editor` type gains `writeOrder`; `props` gains `sailor_stackOrder` read.
- `frontend/app/lib/frame/patterns/sheet.ts` (new) — `Tile`, `tileFor(ctx, pattern, seed)`, `sheetFor(ctx, seeds)`.
- Tests: `frontend/tests/unit/frame-patterns-order.unit.spec.ts`, `…-insert.unit.spec.ts`, `…-measure-parity.unit.spec.ts`, `…-sheet.unit.spec.ts`; `…-applytoframe.unit.spec.ts` extended.

**Scope:** 1b-ii-core. Deferred to **1b-ii-ui** (a browser-verified integration slice): the Options sheet panel in `CompositorModal.vue` (a `v-else-if="optionsOpen"` inspector branch modeled on the Frame Templates panel, toolbar toggle, a tile grid modeled on `ShapePicker.vue` that renders each `Tile`'s ops on a mini canvas, Apply / Another / More-like-this), the palette picker (`assembleShelf` → `rolesFromFamily`, pick → `setBackground(palette.field)` as its own undo step), hover-preview via `ArtifactFrameNode.vue`'s `gate.hovered`, and `await document.fonts.ready` before the first sheet.

---

### Task 1: Export the private helpers the bridge needs

**Files:**
- Modify: `frontend/app/composables/useLocalLayerEditor.ts` (the `return { … }` object near the end, ~lines 1040–1063)
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`function cssFontStack` line 1218; `function transformCase` line 1155)
- Test: `frontend/tests/unit/frame-patterns-exports.unit.spec.ts`

**Interfaces:**
- Produces: `useLocalLayerEditor()` returns `writeOrder(order: string[]): void` (already implemented privately at ~:160–164; only the export is new). `cssFontStack(family: string): string` (returns `Fam, sans-serif`, quoting a family that contains a space) and `transformCase(s: string, t: TextLayer['textTransform']): string` are exported from `useCompositorLayers`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-exports.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { cssFontStack, transformCase } from '~/composables/useCompositorLayers'

describe('exported helpers the poster bridge relies on', () => {
  it('cssFontStack is exported and yields the renderer stack shape', () => {
    expect(cssFontStack('Inter')).toBe('Inter, sans-serif')
    expect(cssFontStack('Inter Tight')).toBe('"Inter Tight", sans-serif')   // spaces get quoted
  })
  it('transformCase is exported and applies the display case', () => {
    expect(transformCase('noise', 'uppercase')).toBe('NOISE')
    expect(transformCase('Noise', undefined)).toBe('Noise')
  })
})
```
(`writeOrder` is a composable method that needs a Vue setup context; it is pinned by Task 6's mock-editor test instead of a unit import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-exports.unit.spec.ts`
Expected: FAIL — `cssFontStack` / `transformCase` are not exported (undefined / import error).

- [ ] **Step 3: Make the two surgical edits**

In `frontend/app/composables/useCompositorLayers.ts`, change the two private declarations to exports (keep both bodies byte-identical; the file is `~4.5k` lines, edit only these two words):
```ts
export function transformCase(s: string, t: TextLayer['textTransform']): string {
```
```ts
export function cssFontStack(family: string): string {
```
(Find them with `grep -n "function cssFontStack\|function transformCase" frontend/app/composables/useCompositorLayers.ts`. Do NOT change their behaviour.)

In `frontend/app/composables/useLocalLayerEditor.ts`, add `writeOrder` to the returned object. Find the `return {` block (grep `commitBoth,` or `recordHistory,` inside it) and add one entry:
```ts
    writeOrder,
```
(The function already exists privately as `function writeOrder(order: string[]) { … }` at ~:160. Only the return-object line is new.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-exports.unit.spec.ts`
Expected: PASS (2 tests).
Also: `cd frontend && npx nuxt typecheck 2>&1 | grep -E "useLocalLayerEditor|useCompositorLayers" || echo "no new errors in the two composables"` → expect the echo (these two files must not gain errors).

- [ ] **Step 5: Commit** (single-shell recipe; the two composables are shared files — stage ONLY them + the test, and confirm `--name-only` shows exactly three)

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/composables/useLocalLayerEditor.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/frame-patterns-exports.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): export writeOrder, cssFontStack and transformCase for the poster bridge" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/composables/useLocalLayerEditor.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/frame-patterns-exports.unit.spec.ts
```
⚠️ These two composables are edited by other sessions. Before `git add`, run `git diff -- frontend/app/composables/useLocalLayerEditor.ts frontend/app/composables/useCompositorLayers.ts` and confirm the ONLY hunks are your one-word export changes; if another session's uncommitted hunks are present in the working tree, stage by hunk (`git diff <file> > /tmp/p.diff`, edit to your hunk, `git apply --cached /tmp/p.diff`) instead of `git add <file>`.

---

### Task 2: Draw order from z hints (pure)

**Files:**
- Create: `frontend/app/lib/frame/patterns/order.ts`
- Test: `frontend/tests/unit/frame-patterns-order.unit.spec.ts`

**Interfaces:**
- Consumes: `LayerOp`, `FrameElements`, `Role` from `./types`; `localStackKey` from `~/lib/compositor/frameStack`.
- Produces:
  - `reconcileOrder(saved: string[], present: string[]): string[]` — saved keys still present, in saved order, then present newcomers appended (mirrors the renderer).
  - `orderWithZ(order: string[], zByKey: Map<string, number>): string[]` — among keys in `zByKey`, sort by z ascending (ties keep current relative order) while re-using exactly the positions those keys already occupy; untouched keys don't move.
  - `nextOrderFor(saved: string[], present: string[], ops: LayerOp[], elements: FrameElements, insertedIdByOpIndex: Map<number, string>): string[]` — resolves each op to a layer key (role → `elements[role].id`, literal id, or the inserted id for that op index), builds `zByKey`, and returns `orderWithZ(reconcileOrder(saved, present), zByKey)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-order.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { reconcileOrder, orderWithZ, nextOrderFor } from '~/lib/frame/patterns/order'
import type { LayerOp, FrameElements } from '~/lib/frame/patterns/types'

describe('reconcileOrder', () => {
  it('keeps saved order for present keys and appends newcomers on top', () => {
    expect(reconcileOrder(['l:a', 'l:gone', 'l:b'], ['l:b', 'l:a', 'l:new'])).toEqual(['l:a', 'l:b', 'l:new'])
  })
  it('an empty saved order is just the present keys', () => {
    expect(reconcileOrder([], ['l:x', 'l:y'])).toEqual(['l:x', 'l:y'])
  })
})

describe('orderWithZ', () => {
  it('sorts touched keys by z within their own slots; untouched keys stay put', () => {
    // photo (l:p) is above title (l:t); untouched l:u sits between them
    const order = ['l:t', 'l:u', 'l:p']
    const z = new Map([['l:t', 1], ['l:p', 0]])      // title z1 over photo z0
    expect(orderWithZ(order, z)).toEqual(['l:p', 'l:u', 'l:t'])   // photo now first, title last, l:u unmoved
  })
  it('ties keep current relative order', () => {
    const order = ['l:a', 'l:b', 'l:c']
    const z = new Map([['l:a', 0], ['l:b', 0], ['l:c', 0]])
    expect(orderWithZ(order, z)).toEqual(['l:a', 'l:b', 'l:c'])
  })
})

describe('nextOrderFor', () => {
  const elements = { title: { role: 'title', id: 't', text: 'X', words: ['X'] }, images: [{ id: 'img' }], shapes: [], shapeMode: null } as unknown as FrameElements
  it('puts a z:0 image behind a z:1 title even when the photo was saved on top', () => {
    const ops: LayerOp[] = [
      { target: 'title', kind: 'text', x: .5, y: .3, fontSize: .2, z: 1 },
      { target: 'img', kind: 'image', x: .5, y: .7, w: 1, h: .5, z: 0 },
    ]
    const next = nextOrderFor(['l:t', 'l:img'], ['l:t', 'l:img'], ops, elements, new Map())
    expect(next).toEqual(['l:img', 'l:t'])
  })
  it('an inserted layer for a sentinel shape op takes its z via the op index', () => {
    const ops: LayerOp[] = [
      { target: 'shape', kind: 'shape', x: .5, y: .5, w: .6, shapeId: 'circle', z: 0 },
      { target: 'title', kind: 'text', x: .5, y: .5, fontSize: .2, z: 1 },
    ]
    const next = nextOrderFor(['l:t'], ['l:t', 'l:new'], ops, elements, new Map([[0, 'new']]))
    expect(next).toEqual(['l:new', 'l:t'])                       // shape behind the title
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-order.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/order`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/order.ts
import type { LayerOp, FrameElements, Role } from './types'
import { localStackKey } from '~/lib/compositor/frameStack'

const ROLES: Role[] = ['title', 'details', 'caption', 'date']

/** Saved order for keys still present, then present newcomers appended on top —
 *  exactly what the Frame renderer does before painting. */
export function reconcileOrder(saved: string[], present: string[]): string[] {
  const p = new Set(present)
  const kept = saved.filter(k => p.has(k))
  const keptSet = new Set(kept)
  return [...kept, ...present.filter(k => !keptSet.has(k))]
}

/** Re-sort only the keys in `zByKey` by z (ascending = further behind), keeping
 *  ties in their current relative order, and re-using exactly the slots those
 *  keys occupy. Keys not in the map never move. */
export function orderWithZ(order: string[], zByKey: Map<string, number>): string[] {
  const slots: number[] = []
  const touched: string[] = []
  order.forEach((k, i) => { if (zByKey.has(k)) { slots.push(i); touched.push(k) } })
  const rank = new Map(order.map((k, i) => [k, i]))
  const sorted = [...touched].sort((a, b) => (zByKey.get(a)! - zByKey.get(b)!) || (rank.get(a)! - rank.get(b)!))
  const next = [...order]
  slots.forEach((slot, i) => { next[slot] = sorted[i]! })
  return next
}

/** Resolve an op's target to a stack key: a role via the inferred element, an
 *  inserted layer via the op's index, else a literal layer id. */
function keyForOp(op: LayerOp, idx: number, elements: FrameElements, inserted: Map<number, string>): string | undefined {
  const ins = inserted.get(idx)
  if (ins) return localStackKey(ins)
  if ((ROLES as string[]).includes(op.target)) {
    const el = elements[op.target as Role]
    return el ? localStackKey(el.id) : undefined
  }
  if (op.target === 'shape') return undefined       // sentinel with no inserted layer: nothing to order
  return localStackKey(op.target)
}

/** The next persisted draw order for a placement: reconcile, then honour z hints. */
export function nextOrderFor(
  saved: string[], present: string[], ops: LayerOp[], elements: FrameElements,
  insertedIdByOpIndex: Map<number, string>,
): string[] {
  const zByKey = new Map<string, number>()
  ops.forEach((op, i) => { const k = keyForOp(op, i, elements, insertedIdByOpIndex); if (k) zByKey.set(k, op.z ?? 0) })
  return orderWithZ(reconcileOrder(saved, present), zByKey)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-order.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/order.ts frontend/tests/unit/frame-patterns-order.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): poster draw order from z hints (pure)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/order.ts frontend/tests/unit/frame-patterns-order.unit.spec.ts
```

---

### Task 3: Insert a shape layer for a sentinel shape op (pure)

**Files:**
- Create: `frontend/app/lib/frame/patterns/insert.ts`
- Test: `frontend/tests/unit/frame-patterns-insert.unit.spec.ts`

**Interfaces:**
- Consumes: `LayerOp` from `./types`; `ResolvedPalette`, `roleToPaint` from `./palette`; `createShapeLayer` from `~/lib/shapes/pathLayer` (signature `createShapeLayer(shape: LibraryShape, o?: { x?, y?, targetWidth?, fill?, id? }): PathLayer`); `shapeById` from `~/lib/shapes/catalog`; `LocalLayer` (type) from `~/composables/useCompositorLayers`.
- Produces: `insertFromOps(layers: LocalLayer[], ops: LayerOp[], palette: ResolvedPalette): { layers: LocalLayer[]; inserted: Map<number, string>; ops: LayerOp[] }` — for each op with `kind:'shape'`, `target:'shape'` (the sentinel) and a valid `shapeId`, creates a `PathLayer` via `createShapeLayer` at the op's `x/y`, width `w`, fill = the op's colour role (default `'accent'`), appends it, and rewrites that op's `target` to the new id so `applyPlacement` can patch it. Returns the new layers array (input untouched), the op-index→id map, and the rewritten ops. Ops that are not sentinel shapes pass through unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-insert.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { insertFromOps } from '~/lib/frame/patterns/insert'
import type { LayerOp } from '~/lib/frame/patterns/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
const title: any = { id: 't', kind: 'text', x: .5, y: .5, rotation: 0, opacity: 1, text: 'NOISE', fontFamily: 'Inter', fontWeight: 700, fontSize: .2, color: '#000', align: 'left', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }

describe('insertFromOps', () => {
  it('creates a real path layer for a sentinel shape op and retargets the op', () => {
    const ops: LayerOp[] = [
      { target: 'shape', kind: 'shape', x: .4, y: .6, w: .7, shapeId: 'circle', colorRole: 'accent', fill: 'solid', z: 0 },
      { target: 'title', kind: 'text', x: .5, y: .5, fontSize: .2, colorRole: 'ink', z: 1 },
    ]
    const layers: LocalLayer[] = [title]
    const out = insertFromOps(layers, ops, palette)
    expect(layers).toHaveLength(1)                                   // input untouched
    expect(out.layers).toHaveLength(2)
    const added: any = out.layers[1]
    expect(added.kind).toBe('path')
    expect(added.shapeId).toBe('circle')
    expect(added.d.length).toBeGreaterThan(0)                        // real geometry from the factory
    expect([added.x, added.y]).toEqual([.4, .6])
    expect(added.fill).toBe('#dd2200')                               // accent role → hex
    expect(out.inserted.get(0)).toBe(added.id)
    expect(out.ops[0]!.target).toBe(added.id)                        // op retargeted to the new layer
    expect(out.ops[1]).toEqual(ops[1])                               // other ops untouched
  })
  it('passes a non-sentinel shape op and an unknown shapeId through untouched', () => {
    const ops: LayerOp[] = [
      { target: 's1', kind: 'shape', x: .5, y: .5, w: .3, shapeId: 'circle' },          // real layer target
      { target: 'shape', kind: 'shape', x: .5, y: .5, w: .3, shapeId: 'no-such-shape' }, // unknown id
    ]
    const out = insertFromOps([title], ops, palette)
    expect(out.layers).toHaveLength(1)
    expect(out.inserted.size).toBe(0)
    expect(out.ops).toEqual(ops)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-insert.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/insert`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/insert.ts
import type { LayerOp } from './types'
import type { ResolvedPalette } from './palette'
import { roleToPaint } from './palette'
import { createShapeLayer } from '~/lib/shapes/pathLayer'
import { shapeById } from '~/lib/shapes/catalog'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const SENTINEL = 'shape'

/** For every sentinel shape op (a pattern wanted a library shape but no shape
 *  layer was placed), build a real path layer with the shape factory, append it,
 *  and retarget the op to the new id. Pure: returns new arrays. */
export function insertFromOps(
  layers: LocalLayer[], ops: LayerOp[], palette: ResolvedPalette,
): { layers: LocalLayer[]; inserted: Map<number, string>; ops: LayerOp[] } {
  const next = [...layers]
  const inserted = new Map<number, string>()
  const outOps = ops.map((op, i) => {
    if (op.kind !== 'shape' || op.target !== SENTINEL || !op.shapeId) return op
    const shape = shapeById(op.shapeId)
    if (!shape) return op
    const layer = createShapeLayer(shape, {
      x: op.x, y: op.y,
      targetWidth: op.w,
      fill: roleToPaint(op.colorRole ?? 'accent', palette),
    })
    next.push(layer as LocalLayer)
    inserted.set(i, layer.id)
    return { ...op, target: layer.id }
  })
  return { layers: next, inserted, ops: outOps }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-insert.unit.spec.ts`
Expected: PASS (2 tests). (If `createShapeLayer` requires `targetWidth` to be defined, `op.w` is always set on shape ops the engine emits; the test passes `w`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/insert.ts frontend/tests/unit/frame-patterns-insert.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): insert a library shape layer for a sentinel poster op" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/insert.ts frontend/tests/unit/frame-patterns-insert.unit.spec.ts
```

---

### Task 4: Measure parity with the renderer

**Files:**
- Modify: `frontend/app/lib/frame/patterns/frameMeasure.ts`
- Test: `frontend/tests/unit/frame-patterns-measure-parity.unit.spec.ts`

**Interfaces:**
- Consumes: `cssFontStack` and `transformCase` (exported in Task 1) from `~/composables/useCompositorLayers`; `TextLayer` (type).
- Produces (in `frameMeasure.ts`): `fontStack(family)` now returns `cssFontStack(family)` (renderer parity); `titleMeasureFrom(layer: { fontFamily: string; fontWeight: number; axes?: Record<string, number>; textTransform?: string }): { family: string; weight: number; transform: (t: string) => string }` — weight = `Math.round(axes.wght)` when finite else `fontWeight`; `transform` is the renderer's own `transformCase` bound to the layer's `textTransform` (so measure and paint run the same function); `makeFrameMeasure` gains an optional `transform` so the width is measured on the transformed string.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-measure-parity.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { fontStack, titleMeasureFrom, makeFrameMeasure } from '~/lib/frame/patterns/frameMeasure'
import { cssFontStack } from '~/composables/useCompositorLayers'

function fakeCtx() {
  return { font: '', measureText(t: string) { const m = /(\d+(?:\.\d+)?)px/.exec(this.font); const px = m ? parseFloat(m[1]!) : 10; return { width: t.length * 0.5 * px } as any } } as unknown as CanvasRenderingContext2D
}

describe('measure parity', () => {
  it('fontStack is the renderer stack, not a private variant', () => {
    expect(fontStack('Inter Tight')).toBe(cssFontStack('Inter Tight'))
  })
  it('titleMeasureFrom prefers axes.wght over fontWeight and applies textTransform', () => {
    const m = titleMeasureFrom({ fontFamily: 'Inter', fontWeight: 400, axes: { wght: 812.4 }, textTransform: 'uppercase' })
    expect(m.family).toBe('Inter')
    expect(m.weight).toBe(812)
    expect(m.transform('noise')).toBe('NOISE')
  })
  it('falls back to fontWeight and identity transform', () => {
    const m = titleMeasureFrom({ fontFamily: 'Inter', fontWeight: 700 })
    expect(m.weight).toBe(700)
    expect(m.transform('Noise')).toBe('Noise')
  })
  it('makeFrameMeasure measures the transformed string', () => {
    const upper = (t: string) => t.toUpperCase()
    const m = makeFrameMeasure('Inter', 700, fakeCtx(), upper)
    // width depends on length only in the fake, so prove the transform is applied via a capturing ctx
    const seen: string[] = []
    const ctx = { font: '', measureText(t: string) { seen.push(t); return { width: 1 } as any } } as unknown as CanvasRenderingContext2D
    makeFrameMeasure('Inter', 700, ctx, upper)('ab')
    expect(seen).toEqual(['AB'])
    expect(m('ab')).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-measure-parity.unit.spec.ts`
Expected: FAIL — `titleMeasureFrom` not exported; `fontStack` differs from `cssFontStack`; `makeFrameMeasure` ignores a 4th argument.

- [ ] **Step 3: Update `frameMeasure.ts`**

Replace the `fontStack` function and extend `makeFrameMeasure`; add `titleMeasureFrom`. The rest of the file (`capMetrics`, `defaultCtx`) is unchanged.

```ts
// frontend/app/lib/frame/patterns/frameMeasure.ts  (replace fontStack + makeFrameMeasure; add titleMeasureFrom)
import type { Measure } from './types'
import { cssFontStack, transformCase } from '~/composables/useCompositorLayers'
import type { TextLayer } from '~/composables/useCompositorLayers'

/** The renderer's own font stack — measured and painted with the same string. */
export function fontStack(family: string): string { return cssFontStack(family) }

let _fallbackCtx: CanvasRenderingContext2D | null | undefined
function defaultCtx(): CanvasRenderingContext2D | null {
  if (_fallbackCtx !== undefined) return _fallbackCtx
  try { _fallbackCtx = (typeof document !== 'undefined') ? document.createElement('canvas').getContext('2d') : null }
  catch { _fallbackCtx = null }
  return _fallbackCtx
}

/** What a text layer really renders with: weight from a live wght axis when
 *  present, and the display case transform. */
export function titleMeasureFrom(layer: { fontFamily: string; fontWeight: number; axes?: Record<string, number>; textTransform?: TextLayer['textTransform'] }): { family: string; weight: number; transform: (t: string) => string } {
  const w = layer.axes?.wght
  const weight = (w != null && Number.isFinite(w)) ? Math.round(w) : layer.fontWeight
  const transform = (t: string) => transformCase(t, layer.textTransform)
  return { family: layer.fontFamily, weight, transform }
}

/** width(text) in px at font-size 100, measured on the TRANSFORMED string with
 *  the renderer's font stack. No DOM ⇒ length*60. */
export function makeFrameMeasure(family: string, weight: number, ctx?: CanvasRenderingContext2D | null, transform: (t: string) => string = t => t): Measure {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return (t: string) => transform(t).length * 60
  return (t: string) => { c.font = `${weight} 100px ${fontStack(family)}`; return c.measureText(transform(t)).width }
}

export function capMetrics(family: string, weight: number, sizePx: number, ctx?: CanvasRenderingContext2D | null): { cap: number; ascent: number; descent: number } {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return { cap: sizePx * 0.72, ascent: sizePx * 0.8, descent: sizePx * 0.2 }
  c.font = `${weight} ${sizePx}px ${fontStack(family)}`
  const m = c.measureText('H')
  return { cap: m.actualBoundingBoxAscent || sizePx * 0.72, ascent: m.fontBoundingBoxAscent || sizePx * 0.8, descent: m.fontBoundingBoxDescent || sizePx * 0.2 }
}
```
The existing `frame-patterns-measure.unit.spec.ts` asserts `fontStack('Inter Tight')` matches `/"Inter Tight".*sans-serif/`; `cssFontStack` quotes a family containing a space and appends `sans-serif`, so it still passes unchanged. If it does not, the renderer changed — report it, do not edit the assertion.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-measure-parity.unit.spec.ts tests/unit/frame-patterns-measure.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/frameMeasure.ts frontend/tests/unit/frame-patterns-measure-parity.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): poster measure agrees with the renderer (face, weight, case, stack)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/frameMeasure.ts frontend/tests/unit/frame-patterns-measure-parity.unit.spec.ts
```

---

### Task 5: The sheet data model (pure)

**Files:**
- Create: `frontend/app/lib/frame/patterns/sheet.ts`
- Test: `frontend/tests/unit/frame-patterns-sheet.unit.spec.ts`

**Interfaces:**
- Consumes: `PatternContext`, `Pattern`, `PatternPlacement` from `./types`; `fittingPatterns` from `./catalog`.
- Produces: `Tile = { patternId: string; name: string; seed: number; did: string; ops: PatternPlacement['ops'] }`; `tileFor(ctx, pattern, seed): Tile`; `sheetFor(ctx, seed): Tile[]` (one tile per fitting pattern at that seed); `variantsFor(ctx, pattern, seed, n): Tile[]` (n tiles of one pattern at seeds `seed + k*101`, the prototype's "more like this").

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-sheet.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { sheetFor, variantsFor, tileFor } from '~/lib/frame/patterns/sheet'
import { PATTERNS, fittingPatterns } from '~/lib/frame/patterns/catalog'
import { ctxFor } from './_poster-fixtures'

describe('sheet model', () => {
  it('sheetFor yields one tile per fitting pattern, each with ops and a label', () => {
    const ctx = ctxFor()
    const tiles = sheetFor(ctx, 7)
    expect(tiles.map(t => t.patternId)).toEqual(fittingPatterns(ctx).map(p => p.id))
    for (const t of tiles) { expect(t.ops.length).toBeGreaterThan(0); expect(t.did.length).toBeGreaterThan(0); expect(t.seed).toBe(7) }
  })
  it('tiles are deterministic for (pattern, seed) and differ across seeds', () => {
    const ctx = ctxFor()
    const p = PATTERNS.find(x => x.id === 'runoff')!
    expect(tileFor(ctx, p, 3)).toEqual(tileFor(ctx, p, 3))
    const base = tileFor(ctx, p, 3).ops
    const differs = [4, 5, 6, 7, 8, 9].some(seed => JSON.stringify(tileFor(ctx, p, seed).ops) !== JSON.stringify(base))
    expect(differs).toBe(true)                                          // the seed actually steers the pattern
  })
  it('variantsFor returns n tiles of one pattern at distinct seeds', () => {
    const ctx = ctxFor()
    const p = PATTERNS.find(x => x.id === 'runoff')!
    const v = variantsFor(ctx, p, 7, 4)
    expect(v).toHaveLength(4)
    expect(new Set(v.map(t => t.seed)).size).toBe(4)
    expect(v.every(t => t.patternId === 'runoff')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-sheet.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/sheet`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/sheet.ts
import type { PatternContext, Pattern, PatternPlacement } from './types'
import { fittingPatterns } from './catalog'

export interface Tile { patternId: string; name: string; seed: number; did: string; ops: PatternPlacement['ops'] }

/** One tile: a pattern run at a seed. The context's seed is overridden per tile. */
export function tileFor(ctx: PatternContext, pattern: Pattern, seed: number): Tile {
  const out = pattern.place({ ...ctx, seed })
  return { patternId: pattern.id, name: pattern.name, seed, did: out.did, ops: out.ops }
}

/** The contact sheet: one tile per pattern that fits what the frame holds. */
export function sheetFor(ctx: PatternContext, seed: number): Tile[] {
  return fittingPatterns(ctx).map(p => tileFor(ctx, p, seed))
}

/** "More like this": n tiles of one pattern at spread-out seeds. */
export function variantsFor(ctx: PatternContext, pattern: Pattern, seed: number, n: number): Tile[] {
  return Array.from({ length: n }, (_, k) => tileFor(ctx, pattern, seed + (k + 1) * 101))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-sheet.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/sheet.ts frontend/tests/unit/frame-patterns-sheet.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): poster sheet data model (tiles, variants)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/sheet.ts frontend/tests/unit/frame-patterns-sheet.unit.spec.ts
```

---

### Task 6: Wire order, insertion and parity into the apply wrapper

**Files:**
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts`
- Modify: `frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts`

**Interfaces:**
- Consumes: `nextOrderFor` (`./order`), `insertFromOps` (`./insert`), `titleMeasureFrom`, `makeFrameMeasure` (`./frameMeasure`), `framePresentKeys` from `~/lib/compositor/frameStack` (signature `framePresentKeys(connectedSlots: number[], layers: LocalLayer[]): StackKey[]`), plus existing `buildFrameContext`, `PATTERNS`, `applyPlacement`.
- Produces: `ApplyArgs` gains `editor.writeOrder(order: string[]): void` and optional `connectedSlots?: number[]` (wired image slots present on the node; default `[]`); `titleFace`/`titleWeight` args are **removed** (derived from the title layer). `applyPatternToFrame` now: builds the measure from the title layer's face/weight/transform; runs the pattern; `insertFromOps`; `applyPlacement` with the retargeted ops; computes `nextOrderFor(saved, present, ops, elements, inserted)`; then `recordHistory()` → `commit(next)` → `writeOrder(order)` — exactly once each.

- [ ] **Step 1: Update the failing tests**

Replace the applytoframe spec with:
```ts
// frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'

function frameProps(extra: Record<string, unknown> = {}) {
  return { sailor_localLayers: [
    { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 },
    { id: 'img', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 },
  ], ...extra }
}
const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
const mk = () => ({ recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn() })

describe('applyPatternToFrame', () => {
  it('records history once, commits once, writes order once — in that sequence', () => {
    const editor = mk(); const calls: string[] = []
    editor.recordHistory.mockImplementation(() => calls.push('history'))
    editor.commit.mockImplementation(() => calls.push('commit'))
    editor.writeOrder.mockImplementation(() => calls.push('order'))
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette, editor })
    expect(out.ok).toBe(true)
    expect(calls).toEqual(['history', 'commit', 'order'])
    const committed = editor.commit.mock.calls[0][0]
    expect(committed[0].fontFamily).toBe('Inter')                 // face untouched
    expect(committed[0].x !== 0.5 || committed[0].y !== 0.5).toBe(true)
    expect(committed[0].fontSize).not.toBe(0.2)
  })
  it('photoBehind writes an order with the image behind the title, even if saved on top', () => {
    const editor = mk()
    applyPatternToFrame({ props: frameProps({ sailor_stackOrder: ['l:t', 'l:img'] }), frameW: 800, frameH: 1000, patternId: 'photoBehind', seed: 3, palette, editor })
    const order = editor.writeOrder.mock.calls[0][0] as string[]
    expect(order.indexOf('l:img')).toBeLessThan(order.indexOf('l:t'))
  })
  it('shapeCounter with no shape layer inserts one and orders it behind the title', () => {
    const editor = mk()
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'shapeCounter', seed: 5, palette, editor, shapeMode: { id: 'circle' } })
    expect(out.ok).toBe(true)
    const committed = editor.commit.mock.calls[0][0] as any[]
    const added = committed.find(l => l.kind === 'path')
    expect(added?.shapeId).toBe('circle')
    const order = editor.writeOrder.mock.calls[0][0] as string[]
    expect(order.indexOf(`l:${added.id}`)).toBeLessThan(order.indexOf('l:t'))
  })
  it('is a no-op for an unknown pattern id', () => {
    const editor = mk()
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'nope', seed: 1, palette, editor })
    expect(out.ok).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled(); expect(editor.commit).not.toHaveBeenCalled(); expect(editor.writeOrder).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-applytoframe.unit.spec.ts`
Expected: FAIL — `writeOrder` never called; `shapeMode` arg unknown; `titleFace` now missing from the old signature.

- [ ] **Step 3: Rewrite `applyToFrame.ts`**

```ts
// frontend/app/lib/frame/patterns/applyToFrame.ts
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import type { FrameElements } from './types'
import { buildFrameContext } from './frameContext'
import { makeFrameMeasure, titleMeasureFrom } from './frameMeasure'
import { PATTERNS } from './catalog'
import { applyPlacement } from './apply'
import { insertFromOps } from './insert'
import { nextOrderFor } from './order'
import { framePresentKeys } from '~/lib/compositor/frameStack'

export interface PosterState { patternId: string; seed: number; shapeMode?: FrameElements['shapeMode'] }

export interface ApplyArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  patternId: string
  seed: number
  palette: ResolvedPalette
  /** A library shape to use when the frame has no shape layer (the picker's family/id choice). */
  shapeMode?: FrameElements['shapeMode']
  /** Wired image slots connected on the node (for the present-keys reconcile). Default none. */
  connectedSlots?: number[]
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void; writeOrder(order: string[]): void }
}

/** Run a pattern on a frame and apply it as ONE undo step: history → layers → order. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return { ok: false }
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  // measure with what the title layer really renders with
  const titleLayer = layers.find(l => l.kind === 'text') as TextLayer | undefined
  const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
  const measure = makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure)
  ctx.seed = args.seed
  if (args.shapeMode !== undefined) ctx.elements.shapeMode = args.shapeMode
  const placement = pattern.place(ctx)
  // insert any library shape the pattern wanted but the frame lacks, then patch
  const ins = insertFromOps(layers, placement.ops, args.palette)
  const next = applyPlacement(ins.layers, { ...placement, ops: ins.ops }, ctx.elements, args.palette)
  // draw order: reconcile the saved order against what is present, then honour z
  const saved = (args.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(args.connectedSlots ?? [], next)
  const order = nextOrderFor(saved, present, ins.ops, ctx.elements, ins.inserted)
  args.editor.recordHistory()
  args.editor.commit(next)
  args.editor.writeOrder(order)
  return { ok: true, posterState: { patternId: args.patternId, seed: args.seed, shapeMode: args.shapeMode } }
}
```
Note: `buildFrameContext` currently hard-codes `shapeMode: null` via `inferElements(views)`; the `if (args.shapeMode !== undefined)` line overrides it after the fact so `pickShape` can use the picker's choice. (Cleaner: extend `buildFrameContext` with a `shapeMode` parameter — do that if it stays a one-line change; either is acceptable, record which.)

- [ ] **Step 4: Run to verify it passes, then the whole engine suite + typecheck**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-applytoframe.unit.spec.ts`
Expected: PASS (4 tests).
Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts`
Expected: PASS (all — was 62; this plan adds ~13).
Run: `cd frontend && npx nuxt typecheck 2>&1 | grep -E "app/lib/frame/patterns|useLocalLayerEditor|useCompositorLayers" || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/applyToFrame.ts frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): apply writes draw order and inserts missing shapes in one undo step" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/applyToFrame.ts frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts
```

---

## Notes for the executor

- **Verified facts this plan rests on** (from a read of the code on 2026-09-09): `writeOrder(order: string[])` exists privately in `useLocalLayerEditor.ts` (~:160) and is NOT exported; `commit()` never touches `sailor_stackOrder`; `addLocal` calls `recordHistory()` itself; the renderer's `stackKeys` appends missing present keys on top; `createShapeLayer(shape, {x,y,targetWidth,fill,id})` in `~/lib/shapes/pathLayer` sets `shapeId` + geometry; `framePresentKeys(connectedSlots: readonly number[], layers: readonly StackLayerLike[]): string[]` (:76) and `localStackKey(id)` (:29) live in `~/lib/compositor/frameStack`; `cssFontStack` (:1218, returns `Fam, sans-serif`, quoting spaced families) and `transformCase` (:1155) are private in `useCompositorLayers.ts`; `TextLayer.textTransform?: 'uppercase'|'lowercase'|'capitalize'` (:362) and `axes?: Record<string, number>` (:376) exist; `writeOrder` (:160) writes `sailor_stackOrder` directly on the node's properties. If any of these is not where stated, grep for it — do not invent a substitute.
- **Two shared composables are touched by one line each** (Task 1). Stage by hunk if another session has uncommitted edits in them.
- **Pre-existing gap, not yours to fix:** the toolbar's `moveStackZ` in `ArtifactFrameNode.vue`/`CompositorModal.vue` writes `sailor_stackOrder` with NO `recordHistory()` — reordering by hand is not undoable today. This plan makes the poster apply the first order write that IS on the undo stack. Leave `moveStackZ` alone; note it in the report as debt.
- **Baseline:** run only `frame-patterns-*` to judge this work.

## What 1b-ii-ui adds next (browser-verified, separate plan)
The Options sheet in `CompositorModal.vue`: a toolbar toggle + `v-else-if="optionsOpen"` inspector branch (Frame Templates panel is the model); a tile grid (ShapePicker is the model) rendering each `Tile`'s ops on a small offscreen canvas; click → `applyPatternToFrame({...})` then write `props.sailor_posterState`; **Another** = `seed+1`, **More like this** = `variantsFor`; the palette picker (`assembleShelf` → `rolesFromFamily`) whose pick calls `setBackground(palette.field)`; `await document.fonts.ready` before the first sheet; hover-preview via the frame card's `gate.hovered`.
