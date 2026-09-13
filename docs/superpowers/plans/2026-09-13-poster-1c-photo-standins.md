# Poster 1c-v — Photo stand-ins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the image moves (Photo behind, Split, Full bleed) discoverable **before** you drop a photo. A toggle in the Layout tab turns on **photo moves**; their tiles then show a grayscale **stand-in** where the photo would go, and applying one drops a placeholder image layer you replace with a real or generated photo. Opt-in, so a text-only poster's sheet stays clean.

**Architecture:** Parallels the shape work. A new `imageMode: boolean` on `FrameElements` (threaded through `useLayoutSheet` exactly like `shapeMode`) relaxes the image-pattern gate: `hasImage = images.length > 0 || imageMode`. When a pattern wants a photo and none exists, its image op targets an `'image'` sentinel; `insertFromOps` builds a **stand-in** `ImageLayer` (`standIn: true`, deterministic id) that the renderer paints as a clear grey box instead of the faint unloaded-image placeholder. On apply, that stand-in is a real layer the user replaces via the existing add/generate-image flows.

**Tech Stack:** TypeScript, Vue 3, Vitest.

## Global Constraints

- **Opt-in, no clutter.** Image moves appear when the frame has a real photo OR when `imageMode` is on. A stand-in is used only when `imageMode` is on and there is no real image.
- **The contract holds:** a stand-in is a placed element the user fills; the sheet still never changes face/weight/colour/content, and the palette/faces are yours.
- **Determinism:** the inserted stand-in's id is `poster-<patternId>-<seed>-<opIndex>` — the same deterministic id scheme `insertFromOps` already uses for shapes, so a tile preview equals what applies.
- **Byte-identity:** the renderer's stand-in branch only fires when `layer.standIn` is set; a normal image (loaded or not) renders exactly as before.
- **Units:** an image op carries `w` and `h` (normalized to frame WIDTH); the stand-in's aspect is `op.h / op.w`.
- **Git hygiene (main-direct, shared checkout):** private index, `git read-tree HEAD` immediately before add+commit, own paths only, `CompositorModal.vue` and `useCompositorLayers.ts` staged BY HUNK. **Subagents implement + test but DO NOT commit — the controller commits by hunk.** zsh does not word-split unquoted `$VAR`. Attribution `Co-Authored-By: Claude Opus 4.8`.
- **Test command:** `cd frontend && npx vitest run <files> --reporter=dot`. No dev server from subagents.

---

### Task 1: A stand-in image layer from an image sentinel

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (add `standIn?: boolean` to `ImageLayer`)
- Modify: `frontend/app/lib/frame/patterns/insert.ts`
- Test: `frontend/tests/unit/frame-patterns-insert.unit.spec.ts`

**Interfaces:** `insertFromOps` gains an image branch — an op with `kind: 'image'` and `target: 'image'` (the `IMAGE_SENTINEL`) and no matching real layer builds a stand-in `ImageLayer` via `createImageLayer`, retargets the op to its id, using the same `idBase-index` deterministic id.

- [ ] **Step 1: Write the failing test** (add to `frame-patterns-insert.unit.spec.ts`):

```ts
describe('insertFromOps — image stand-in', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const imgOp = { target: 'image', kind: 'image', x: 0.5, y: 0.5, w: 1, h: 1.25, fill: 'photo' } as any

  it('inserts a stand-in image layer for the image sentinel and retargets the op', () => {
    const out = insertFromOps([], [imgOp], palette, 'poster-fullBleed-3')
    const layer = out.layers.at(-1)! as any
    expect(layer.kind).toBe('image')
    expect(layer.standIn).toBe(true)
    expect(layer.id).toBe('poster-fullBleed-3-0')     // deterministic, matches the shape scheme
    expect(out.ops[0]!.target).toBe(layer.id)
  })
  it('is deterministic (same inputs → same id)', () => {
    const a = insertFromOps([], [imgOp], palette, 'poster-fullBleed-3').layers.at(-1)!.id
    const b = insertFromOps([], [imgOp], palette, 'poster-fullBleed-3').layers.at(-1)!.id
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

In `useCompositorLayers.ts`, add to the `ImageLayer` interface (near `filename`):
```ts
  /** A poster STAND-IN: no real file yet — the renderer paints a clear grey box
   *  so image moves are visible before a photo is dropped. Absent ⇒ a normal image. */
  standIn?: boolean
```

In `insert.ts`, add an image-sentinel branch. Add a constant `const IMAGE_SENTINEL = 'image'` next to the existing `const SENTINEL = 'shape'`, and in the `ops.map` (before the shape branch's `return op` fallthrough), handle it — the file already imports `createShapeLayer`; add `import { createImageLayer } from '~/composables/useCompositorLayers'`:
```ts
    if (op.kind === 'image' && op.target === IMAGE_SENTINEL) {
      const aspect = (op.h ?? op.w ?? 1) / (op.w || 1)   // h/w in width-normalized units
      const layer = createImageLayer('', aspect, { id: `${idBase}-${i}`, x: op.x, y: op.y, w: op.w, h: op.h, standIn: true } as any)
      next.push(layer as LocalLayer)
      inserted.set(i, layer.id)
      return { ...op, target: layer.id }
    }
```
(Keep the existing shape branch unchanged. `createImageLayer(filename, aspect, partial)` already accepts an `id` in `partial`.)

- [ ] **Step 4: Run** insert + plan + applytoframe tests → PASS.
- [ ] **Step 5: Report (do NOT commit).** Files + test counts.

---

### Task 2: The renderer paints a stand-in as a clear grey box

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (the image branch of the content painter, ~line 3761)

**This task is controller-built (hot paint path, byte-identity-critical).** In the `else if (layer.kind === 'image')` branch, when the image is not loaded AND `layer.standIn` is set, draw a clear grey placeholder (a mid-grey fill + a faint inset border) instead of the `rgba(255,255,255,0.06)` faint box. When `standIn` is absent, the existing faint path is byte-identical.

```ts
    } else {
      if ((layer as any).standIn) {
        // Poster stand-in: a clear grey "photo goes here" box (replaced by a real photo on apply).
        ctx.fillStyle = 'rgba(140,140,140,0.55)'
        ctx.fillRect(-w / 2, -h / 2, w, h)
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'
        ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.01)
        ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4)
      } else {
        // Not loaded yet — faint placeholder; a preload + re-render fills it in.
        ctx.fillStyle = 'rgba(255,255,255,0.06)'
        ctx.fillRect(-w / 2, -h / 2, w, h)
      }
    }
```

Verify: read the diff to confirm the non-standIn path is unchanged; drive a frame with a stand-in (from Task 6) and confirm a clear grey box paints in the tile. Commit BY HUNK.

---

### Task 3: Image patterns emit the sentinel when there is no photo

**Files:**
- Modify: `frontend/app/lib/frame/patterns/patterns/photoBehind.ts`, `split.ts`, `fullBleed.ts`
- Test: extend each pattern's spec

**Interface:** each image pattern targets `elements.images[0]?.id ?? 'image'` and ALWAYS emits its image op (drop the `if (img)` gate — the op is emitted with the sentinel when no real image).

- [ ] For each of the three: replace `const img = elements.images[0]` + `if (img) { ...push image op... }` with an unconditional image op whose `target` is `elements.images[0]?.id ?? 'image'`. Keep every other geometry line identical. (For photoBehind, the image op sits inside its own `if (img)` today — make it unconditional with the sentinel target.)
- [ ] Each spec: add a case asserting that with NO image element, the pattern still emits an image op whose `target === 'image'` (the sentinel).
- [ ] Run the three specs + catalog → PASS. Report (no commit).

---

### Task 4: `imageMode` on FrameElements + the fitting gate

**Files:**
- Modify: `frontend/app/lib/frame/patterns/types.ts` (add `imageMode: boolean` to `FrameElements`)
- Modify: `frontend/app/lib/frame/patterns/hierarchy.ts` (`inferElements` accepts + sets `imageMode`, default false)
- Modify: `frontend/app/lib/frame/patterns/catalog.ts` (`hasImage = ... || ctx.elements.imageMode`)
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts` (`PlanArgs.imageMode`, apply to `elements.imageMode`, carry in `PosterState`)
- Test: `frame-patterns-catalog.unit.spec.ts`, `frame-patterns-hierarchy.unit.spec.ts`

**Interface:** mirror `shapeMode`. `inferElements(views, shapeMode = null, imageMode = false)`. `PlanArgs`/`PosterState` gain `imageMode?: boolean`; `planPattern` sets `elements.imageMode = args.imageMode` when defined.

- [ ] Add `imageMode: boolean` to `FrameElements`; set it in `inferElements`'s `base` object; add the param.
- [ ] `fittingPatterns`: `const hasImage = ctx.elements.images.length > 0 || ctx.elements.imageMode`.
- [ ] `applyToFrame`: add `imageMode?: boolean` to `PlanArgs`; `if (args.imageMode !== undefined) elements.imageMode = args.imageMode`; add `imageMode: args.imageMode` to the returned `posterState`; `PosterState` type gains `imageMode?: boolean`.
- [ ] Tests: `fittingPatterns` with `imageMode` on (and no image) includes `split`/`fullBleed`; off excludes them. `inferElements` sets `imageMode`.
- [ ] Run → PASS. Report (no commit).

---

### Task 5: `useLayoutSheet` threads `imageMode`

**Files:**
- Modify: `frontend/app/composables/useLayoutSheet.ts`
- Test: `frontend/tests/unit/layout-sheet.unit.spec.ts`

**Interface:** exactly parallel to `shapeMode` — an `imageMode: Ref<boolean>` + `setImageMode(on)`, read from `sailor_posterState.imageMode`, threaded to `context()` (`inferElements(..., shapeMode.value, imageMode.value)`), the tiles' `planPattern`, and `apply`; persisted to `sailor_posterState`.

- [ ] Add the ref + setter (init from `sailor_posterState.imageMode ?? false`), thread it to inference/planPattern/apply, expose on the return + return type.
- [ ] Test: `setImageMode(true)` makes `split` appear in the sheet with no image layer.
- [ ] Run `layout-sheet` + `frame-patterns-plan` → PASS. Report (no commit).

---

### Task 6: An "Include a photo" toggle in the Layout tab

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Controller-built.** Add a row in the Layout tab (near the Shape row): a `StudioSwitch` (or a small toggle) "Photo moves" bound to `layoutSheet.imageMode` via `setImageMode`. When on, the sheet shows image moves with stand-ins. Verify live (the toggle appears, turning it on adds Split/Full-bleed/Photo-behind tiles with a grey stand-in; applying one drops a grey placeholder layer). Commit BY HUNK.

---

### Task 7: Catalog + sheet coverage

**Files:**
- Modify: `frontend/tests/unit/frame-patterns-sheet.unit.spec.ts`

- [ ] Add an assertion: a bare word with `imageMode` on shows image moves; off does not; with a real image they show regardless.
- [ ] Run the whole poster suite → green. Report (no commit).

## Out of scope (later)

- **Generate-on-apply:** applying an image-move stand-in could trigger the drag-to-generate flow to fill it; v1 just drops a grey placeholder the user fills.
- **Multiple stand-ins / stand-in for a wired slot.**

## Self-review notes

- Parallels the shape work: `imageMode` mirrors `shapeMode`, the image sentinel mirrors the shape sentinel (same deterministic id), the toggle mirrors the shape picker.
- Byte-identity: the renderer stand-in branch is gated on `layer.standIn`; a normal image is unchanged.
- The three image patterns keep their geometry; only the image op's target and the `if(img)` gate change.
