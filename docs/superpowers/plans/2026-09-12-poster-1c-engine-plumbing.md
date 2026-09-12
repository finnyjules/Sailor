# Poster 1c-ii — Engine plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three correctness/perf gaps in the poster engine so the later shape/image slice is right by construction: a tile preview must equal what applies (seeded insert ids), the engine must run each pattern once per tile not twice (dedupe), and a connected photo (wired layer) must be visible to the engine as an image element.

**Architecture:** All three are surgical changes to the pure engine layer (`frontend/app/lib/frame/patterns/`) plus one composable (`useLayoutSheet.ts`) and one renderer branch (`apply.ts`). No UI, no new patterns, no visible design change. Every change is covered by unit tests and must leave the existing 132-test poster suite green.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- **No behaviour change a user sees.** These are plumbing fixes. The set of tiles a frame produces, their geometry, and the apply result must be unchanged EXCEPT: an inserted shape now gets a deterministic id (Task 1), and a connected wired photo now participates as an image element (Task 3, which legitimately adds image patterns to the sheet when a wired photo is present).
- **Determinism.** An inserted shape's id must be a pure function of `(patternId, seed, opIndex)` — never `newId()`/random/time — so the same tile produces the same id whether it is planned for the preview or applied on click.
- **Purity.** `planPattern`, `insertFromOps`, `posterLayerViews`, `applyPlacement` stay pure: new arrays/objects, no mutation of inputs.
- **Poster contract still holds.** None of these changes may cause a pattern to touch a layer's face, weight, colour value, or content.
- **Git hygiene (main-direct, shared checkout).** Commit with a PRIVATE index, staging ONLY the exact paths you changed; never `git add -A`/`.`, never `git stash`. Recipe:
  ```
  export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX)
  git read-tree HEAD
  git add -- <path> <path> ...
  git diff --cached --name-only
  git commit -m "<msg>" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  unset GIT_INDEX_FILE
  git add -- <path> <path> ...
  ```
  Run `git read-tree HEAD` IMMEDIATELY before the `git add`+`commit` (a gap lets a concurrent commit's tree be reverted). Do NOT modify any file outside your task's paths, even if something elsewhere looks broken — report it as a concern. In zsh, an unquoted `$VAR` does NOT word-split; pass paths literally.
- **Test command.** `cd frontend && npx vitest run <files> --reporter=dot`. Rerun a timed-out spec alone before calling it failed.

---

### Task 1: Seeded insert ids (tile preview == apply)

**Problem:** `insertFromOps` builds an inserted shape with `createShapeLayer(...)`, which mints `newId()`. The tile preview (`planPattern` in the sheet) and the apply-on-click (`planPattern` again) each call `insertFromOps` separately, so a pattern that inserts a shape gets a DIFFERENT layer id in the preview than in the applied frame. `createShapeLayer` already accepts an `id` option — thread a deterministic key in.

**Files:**
- Modify: `frontend/app/lib/frame/patterns/insert.ts`
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts` (the one `insertFromOps` call)
- Test: `frontend/tests/unit/frame-patterns-insert.unit.spec.ts`

**Interfaces:**
- `insertFromOps(layers, ops, palette, idBase: string)` — new 4th param. Each inserted layer's id becomes `` `${idBase}-${opIndex}` ``.
- `planPattern` passes `idBase = `poster-${args.patternId}-${args.seed}``.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/unit/frame-patterns-insert.unit.spec.ts` (the file already builds `layers`, `ops` with a sentinel `{ target: 'shape', kind: 'shape', shapeId: 'circle', ... }`, and `palette`):

```ts
describe('insertFromOps — deterministic ids', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const shapeOp = { target: 'shape', kind: 'shape', shapeId: 'circle', x: 0.5, y: 0.5, w: 0.3, colorRole: 'accent' } as any

  it('gives an inserted shape a deterministic id from the idBase and op index', () => {
    const a = insertFromOps([], [shapeOp], palette, 'poster-shapeCounter-7')
    const b = insertFromOps([], [shapeOp], palette, 'poster-shapeCounter-7')
    const idA = a.layers[a.layers.length - 1]!.id
    const idB = b.layers[b.layers.length - 1]!.id
    expect(idA).toBe('poster-shapeCounter-7-0')     // idBase + op index
    expect(idB).toBe(idA)                            // same inputs → same id (preview == apply)
    expect(a.inserted.get(0)).toBe(idA)
    expect(a.ops[0]!.target).toBe(idA)               // op retargeted to the new id
  })

  it('a different seed yields a different id', () => {
    const a = insertFromOps([], [shapeOp], palette, 'poster-shapeCounter-7')
    const b = insertFromOps([], [shapeOp], palette, 'poster-shapeCounter-8')
    expect(a.layers.at(-1)!.id).not.toBe(b.layers.at(-1)!.id)
  })
})
```

Also update the file's two EXISTING `insertFromOps(...)` calls (around lines 16 and 34) to pass a 4th arg `'poster-test-1'` so they still type-check and run.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-insert.unit.spec.ts --reporter=dot`
Expected: FAIL — `insertFromOps` takes 3 args; ids are random `newId()`s, not `poster-…-0`.

- [ ] **Step 3: Implement**

In `frontend/app/lib/frame/patterns/insert.ts`, change the signature and the `createShapeLayer` call:

```ts
export function insertFromOps(
  layers: LocalLayer[], ops: LayerOp[], palette: ResolvedPalette, idBase: string,
): { layers: LocalLayer[]; inserted: Map<number, string>; ops: LayerOp[] } {
  const next = [...layers]
  const inserted = new Map<number, string>()
  const outOps = ops.map((op, i) => {
    if (op.kind !== 'shape' || op.target !== SENTINEL || !op.shapeId) return op
    const shape = shapeById(op.shapeId)
    if (!shape) return op
    const layer = createShapeLayer(shape, {
      id: `${idBase}-${i}`,                 // deterministic: same (idBase, i) → same id, so preview == apply
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

In `frontend/app/lib/frame/patterns/applyToFrame.ts`, change the call (currently `const ins = insertFromOps(layers, placement.ops, args.palette)`):

```ts
  const ins = insertFromOps(layers, placement.ops, args.palette, `poster-${args.patternId}-${args.seed}`)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-insert.unit.spec.ts tests/unit/frame-patterns-plan.unit.spec.ts tests/unit/frame-patterns-applytoframe.unit.spec.ts --reporter=dot`
Expected: PASS (plan/applytoframe use `shapeCounter`/`photoBehind`; confirm no regression).

- [ ] **Step 5: Commit**

```
git add -- frontend/app/lib/frame/patterns/insert.ts frontend/app/lib/frame/patterns/applyToFrame.ts frontend/tests/unit/frame-patterns-insert.unit.spec.ts
```
Message: `fix(poster): inserted shapes get a deterministic id so a tile preview equals what applies`

---

### Task 2: Run each pattern once per tile, not twice

**Problem:** In `useLayoutSheet.ts`, the `tiles` computed calls `sheetFor(ctx, seed)` / `variantsFor(...)` (which runs `pattern.place()` per tile to get `ops`+`did`), then calls `planPattern(...)` per tile — and `planPattern` runs `pattern.place()` AGAIN. Every tile runs the pattern twice per render. Let `planPattern` accept the already-computed placement and skip its own `place()`.

**Files:**
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts`
- Modify: `frontend/app/composables/useLayoutSheet.ts` (the `planPattern` call in `tiles`)
- Test: `frontend/tests/unit/frame-patterns-plan.unit.spec.ts`, `frontend/tests/unit/layout-sheet.unit.spec.ts`

**Interfaces:**
- `PlanArgs` gains `placement?: PatternPlacement`. When present, `planPattern` uses it verbatim instead of running `pattern.place(ctx)` (and skips building the measure/context, which only `place()` needs).
- `useLayoutSheet` passes `placement: { ops: t.ops, did: t.did }` from the tile it already computed.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/unit/frame-patterns-plan.unit.spec.ts` (it already has a `base` fixture with `props`, `frameW`, `frameH`, `palette`, `connectedSlots`, `seed`):

```ts
  it('uses a provided placement verbatim and does not re-run the pattern', () => {
    // A placement whose `did` no real pattern would produce: if planPattern echoes
    // it back, place() was skipped (deduped). The title op targets the fixture title.
    const placement = {
      ops: [{ target: 'title', kind: 'text', x: 0.5, y: 0.5, w: 0.8, fontSize: 0.2, align: 'left', colorRole: 'ink' }],
      did: 'SENTINEL-PROVIDED-PLACEMENT',
    } as any
    const plan = planPattern({ ...base, patternId: 'runoff', placement })!
    expect(plan.did).toBe('SENTINEL-PROVIDED-PLACEMENT')   // proves place() was not called
    expect(plan.layers.length).toBeGreaterThan(0)          // it still applied the ops
    expect(plan.posterState).toEqual({ patternId: 'runoff', seed: base.seed, shapeMode: undefined })
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-plan.unit.spec.ts --reporter=dot`
Expected: FAIL — `placement` is not an accepted field and `plan.did` comes from the pattern, not the sentinel.

- [ ] **Step 3: Implement**

In `frontend/app/lib/frame/patterns/applyToFrame.ts`:

Add `placement?: PatternPlacement` to `PlanArgs` (import the type: it lives in `./types` — add `PatternPlacement` to the existing type import). Then refactor `planPattern` so `place()` is a separate helper that runs only when no placement is supplied:

```ts
export function planPattern(args: PlanArgs): PatternPlan | null {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return null
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  const elements = inferElements(posterLayerViews(args.props))
  if (args.shapeMode !== undefined) elements.shapeMode = args.shapeMode
  // Reuse the placement the sheet already computed; only fall back to running the
  // pattern (and building the measure/context it needs) when none was supplied.
  const placement = args.placement ?? runPattern(pattern, args, layers, elements)
  const ins = insertFromOps(layers, placement.ops, args.palette, `poster-${args.patternId}-${args.seed}`)
  const next = applyPlacement(ins.layers, { ...placement, ops: ins.ops }, elements, args.palette, { recolour: args.recolour ?? false })
  const saved = (args.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(args.connectedSlots, next)
  const order = nextOrderFor(saved, present, ins.ops, elements, ins.inserted)
  return { layers: next, order, did: placement.did, posterState: { patternId: args.patternId, seed: args.seed, shapeMode: args.shapeMode } }
}

/** Build the measure + context and run the pattern. Only the placement path needs
 *  a measure, so this stays out of planPattern's provided-placement fast path. */
function runPattern(pattern: Pattern, args: PlanArgs, layers: LocalLayer[], elements: FrameElements): PatternPlacement {
  const titleLayer = layers.find(l => l.id === elements.title?.id && l.kind === 'text') as TextLayer | undefined
  const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
  const measure = makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure, elements)
  ctx.seed = args.seed
  if (args.shapeMode !== undefined) ctx.elements.shapeMode = args.shapeMode
  return pattern.place(ctx)
}
```

Add the needed type imports at the top: `Pattern`, `PatternPlacement`, `FrameElements` from `./types` (extend the existing `import type { ... } from './types'`).

In `frontend/app/composables/useLayoutSheet.ts`, pass the tile's placement into `planPattern` (the loop already has `t` with `ops` and `did`):

```ts
      const plan = planPattern({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: t.patternId, seed: t.seed, palette, connectedSlots: src.connectedSlots(), placement: { ops: t.ops, did: t.did } })
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-plan.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts tests/unit/layout-tile.unit.spec.ts --reporter=dot`
Expected: PASS. `layout-sheet` still shows one tile per fitting pattern with a plan (the plan is now built from the tile's own placement — same result, one `place()` instead of two).

- [ ] **Step 5: Commit**

```
git add -- frontend/app/lib/frame/patterns/applyToFrame.ts frontend/app/composables/useLayoutSheet.ts frontend/tests/unit/frame-patterns-plan.unit.spec.ts
```
Message: `perf(poster): the sheet runs each pattern once per tile, not twice`

---

### Task 3: A connected photo (wired layer) is an image element

**Problem:** `posterLayerViews` drops `kind:'wired'` layers, so a photo wired into the frame is painted in tiles but invisible to the engine as an image — image patterns never see it, and can't arrange it. A wired layer is a rectangular raster block (no "wired text" exists; text is a `text` layer), so it is an image element for the engine. `applyPlacement` must also size a wired layer by its `w` only (its height comes from `lastAspect`, so writing `h` would add a dead field).

**Files:**
- Modify: `frontend/app/lib/frame/patterns/frameContext.ts` (`posterLayerViews`)
- Modify: `frontend/app/lib/frame/patterns/apply.ts` (`applyPlacement`, add a `wired` branch)
- Test: `frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts`, `frontend/tests/unit/frame-patterns-apply.unit.spec.ts`

**Interfaces:** no signature changes. `posterLayerViews` now emits `{ id, kind: 'image' }` for a wired layer; `applyPlacement` writes only `w` (not `h`) onto a wired layer.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts` (inside `describe('posterLayerViews', ...)`):

```ts
  it('treats a wired layer as an image element (a connected photo the engine can arrange)', () => {
    const props = { sailor_localLayers: [
      { id: 't', kind: 'text', text: 'HELLO', fontSize: 0.2 },
      { id: 'w', kind: 'wired', slot: 0, w: 0.5, lastAspect: 1 },
    ] }
    const v = posterLayerViews(props)
    expect(v).toContainEqual({ id: 'w', kind: 'image' })
  })
```

Add to `frontend/tests/unit/frame-patterns-apply.unit.spec.ts`:

```ts
describe('applyPlacement — wired layer sizing', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const elements = { images: [{ id: 'w' }], shapes: [], shapeMode: null } as any
  const wired = { id: 'w', kind: 'wired', slot: 0, w: 0.5, lastAspect: 1, x: 0.5, y: 0.5 } as any

  it('writes w onto a wired layer and never a dead h', () => {
    const ops = [{ target: 'w', kind: 'image', x: 0.4, y: 0.3, w: 0.8, h: 1.2 }] as any
    const [out] = applyPlacement([wired], { ops, did: 'x' }, elements, palette, { recolour: false })
    expect((out as any).w).toBe(0.8)
    expect((out as any).x).toBe(0.4)
    expect('h' in (out as any)).toBe(false)   // wired height comes from lastAspect
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-framecontext.unit.spec.ts tests/unit/frame-patterns-apply.unit.spec.ts --reporter=dot`
Expected: FAIL — `posterLayerViews` omits the wired layer; `applyPlacement`'s final else writes a dead `h` onto the wired layer.

- [ ] **Step 3: Implement**

In `frontend/app/lib/frame/patterns/frameContext.ts`, in `posterLayerViews`, add a wired branch (a wired layer is a raster content block → an image element):

```ts
    if (l.kind === 'text') out.push({ id: l.id, kind: 'text', text: (l as any).text, fontSize: (l as any).fontSize })
    else if (l.kind === 'image') out.push({ id: l.id, kind: 'image' })
    else if (l.kind === 'wired') out.push({ id: l.id, kind: 'image' })   // a wired photo is an image element the engine can arrange
    else if (SHAPE_KINDS.has(l.kind)) out.push({ id: l.id, kind: 'shape', shapeId: (l as any).shapeId ?? 'circle' })
```

In `frontend/app/lib/frame/patterns/apply.ts`, add a `wired` branch before the final `else` (a wired layer sizes by `w`; `h` is derived from `lastAspect`):

```ts
    } else if (layer.kind === 'wired') {
      if (op.w != null) next.w = op.w
      // no h: a wired layer's height comes from its lastAspect, not the op
    } else {
      if (op.w != null) next.w = op.w
      if (op.h != null) next.h = op.h
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-framecontext.unit.spec.ts tests/unit/frame-patterns-apply.unit.spec.ts tests/unit/frame-patterns-hierarchy.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add -- frontend/app/lib/frame/patterns/frameContext.ts frontend/app/lib/frame/patterns/apply.ts frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts frontend/tests/unit/frame-patterns-apply.unit.spec.ts
```
Message: `feat(poster): a wired photo is an image element the engine can arrange`

---

### Task 4: Whole-slice regression gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full poster suite**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts tests/unit/layout-tile.unit.spec.ts --reporter=dot`
Expected: all green (was 132 passing before this slice; the new tests add to that). If a spec times out under concurrent load, rerun it alone before treating it as failed.

- [ ] **Step 2: Confirm no unrelated files changed**

Run: `git status --porcelain -- frontend/app/lib/frame/patterns/ frontend/app/composables/useLayoutSheet.ts frontend/tests/unit/`
Expected: only the files this plan named, and all committed (empty output after the task commits).

## Out of scope

- The shape/image pattern families and the shape/face pickers (the next 1c slice — this plumbing makes them correct by construction).
- Hover-preview on the tile.
- Gating a wired layer's image-ness on whether its slot is currently connected — an unconnected wired layer is still a placed element and gets a stand-in; refine later only if image patterns firing on an empty wired block proves wrong in practice.

## Self-review notes

- **Determinism:** the inserted id is `` `poster-${patternId}-${seed}-${opIndex}` `` — pure in its inputs, so preview and apply match; `createShapeLayer` already honours an `id` option.
- **Dedupe safety:** the tile's placement and the plan's `place()` were already identical (both build the context the same way from the same seed — that is why today's tiles match apply); passing the tile's placement in just removes the redundant second `place()`. `planPattern` with no `placement` (the apply path and the plan tests) is unchanged.
- **Wired-as-image safety:** a wired layer has a `w` field like an image but no `h` (height from `lastAspect`); `applyPlacement` now writes `w` only. `posterLayerViews`'s three callers take no signature change.
- **Type consistency:** `PlanArgs.placement?: PatternPlacement`, `insertFromOps(..., idBase: string)`, and the `runPattern` helper all use types already exported from `./types`.
