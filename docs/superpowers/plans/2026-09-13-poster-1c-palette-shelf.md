# Poster 1c-ix: seed-palette shelf (turn recolour on) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Controller commits by hunk (subagents do not commit here).

**Goal:** Let the Layout tab pick a seed palette; picking one recolours the sheet preview and the applied layout through the poster role projection, and "frame's own colours" turns it back off.

**Architecture:** A `paletteMode` (a list of hexes, or null) mirrors the existing `shapeMode`/`imageMode` plumbing in `useLayoutSheet`. When set, the sheet derives its `ResolvedPalette` from `rolesFromFamily({ hexes })` and passes `recolour: true` to both the tile plans and the apply; when null it falls back to `paletteFromFrame` with recolour off (today's behaviour, unchanged). The UI reuses the existing `PalettePicker` shelf (the same corpus-backed seed engine as the Design tab's recolour), wired to set `paletteMode` from its `apply-family` event.

**Tech Stack:** TypeScript, Vitest, Vue 3. Reuses `rolesFromFamily` (`~/lib/frame/patterns/palette`), `PalettePicker.vue`, and the `recolour` arg that `planPattern`/`applyPatternToFrame` already accept.

## Global Constraints

- Recolour stays **opt-in**: with no palette picked the sheet and apply change no colour (`recolour` false, `paletteFromFrame`). Byte-identical to today when `paletteMode` is null.
- `rolesFromFamily({ hexes })` is the sole role projection (field/ink/accent); do not re-derive roles elsewhere.
- `paletteMode` persists to `sailor_posterState.palette` exactly as `shapeMode`/`imageMode` persist their keys.
- UI copy sentence case, no identifiers.
- Controller commits by hunk with a private git index.

---

### Task 1: `paletteMode` in `useLayoutSheet` (state, threading, persistence)

**Files:**
- Modify: `frontend/app/composables/useLayoutSheet.ts`
- Test: `frontend/tests/unit/layout-sheet.unit.spec.ts`

**Interfaces:**
- Consumes: `rolesFromFamily` from `~/lib/frame/patterns/palette`.
- Produces: the composable returns `paletteMode: Ref<string[] | null>` and `setPaletteMode(hexes: string[] | null): void`. When `paletteMode` is a hex list, tiles and apply use `rolesFromFamily({ hexes })` with `recolour: true`; when null they use `paletteFromFrame(props)` with recolour off.

- [ ] **Step 1: Write the failing test** — add to `layout-sheet.unit.spec.ts`:

```ts
  it('a set palette recolours the tiles and applies with recolour on', () => {
    const { sheet, editor } = harness()
    const plainTitleColor = () => {
      const t = sheet.tiles.value[0]!
      const titleLayer = t.plan.layers.find(l => (l as any).id?.startsWith('poster-') && l.kind === 'text')
      return (titleLayer as any)?.color
    }
    const before = plainTitleColor()
    sheet.setPaletteMode(['#0b0b0b', '#f4f1ea', '#e4572e'])   // ink-ish / field-ish / accent
    const after = plainTitleColor()
    expect(after).not.toBe(before)                            // the palette recoloured the tile
    // apply now commits recoloured layers (title colour is the palette's, not the frame's)
    sheet.apply(sheet.tiles.value[0]!)
    const committed = editor.commit.mock.calls.at(-1)![0]
    const committedTitle = committed.find((l: any) => l.id?.startsWith('poster-') && l.kind === 'text')
    expect(committedTitle.color).toBe(after)
  })

  it('clearing the palette returns to the frame\'s own colours (recolour off)', () => {
    const { sheet } = harness()
    const title0 = () => (sheet.tiles.value[0]!.plan.layers.find((l: any) => l.id?.startsWith('poster-') && l.kind === 'text') as any)?.color
    const original = title0()
    sheet.setPaletteMode(['#0b0b0b', '#f4f1ea', '#e4572e'])
    expect(title0()).not.toBe(original)
    sheet.setPaletteMode(null)
    expect(title0()).toBe(original)                           // back to the frame's colours
  })

  it('remembers the picked palette in sailor_posterState', () => {
    const { sheet, props } = harness()
    sheet.setPaletteMode(['#0b0b0b', '#f4f1ea', '#e4572e'])
    expect((props.sailor_posterState as any).palette).toEqual(['#0b0b0b', '#f4f1ea', '#e4572e'])
  })
```

- [ ] **Step 2: Run, expect FAIL** (`setPaletteMode` not a function).

Run: `cd frontend && npx vitest run tests/unit/layout-sheet.unit.spec.ts`

- [ ] **Step 3: Implement.** In `useLayoutSheet.ts`:

Add the import (after the `paletteFromFrame` import):

```ts
import { rolesFromFamily } from '~/lib/frame/patterns/palette'
```

Add `palette` to the stored-state read type and the `paletteMode` state, right after the `imageMode` block (line ~53):

```ts
  const paletteMode = ref<string[] | null>((stored as any)?.palette ?? null)
  function setPaletteMode(hexes: string[] | null) {
    paletteMode.value = hexes && hexes.length ? hexes : null
    const p = src.props(); if (p) (p as any).sailor_posterState = { ...(p as any).sailor_posterState, palette: paletteMode.value ?? undefined }
  }
  /** The role palette the sheet paints with: the picked family projected to
   *  roles, or the frame's own colours when nothing is picked. */
  const posterPalette = () => paletteMode.value ? rolesFromFamily({ hexes: paletteMode.value }) : paletteFromFrame(src.props())
```

In the `tiles` computed, replace `const palette = paletteFromFrame(src.props())` (line ~73) with:

```ts
    const palette = posterPalette()
    const recolour = paletteMode.value != null
```

and add `recolour` to the `planPattern({ … })` call (after `palette`):

```ts
      const plan = planPattern({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: t.patternId, seed: t.seed, palette, recolour, connectedSlots: src.connectedSlots(), placement: { ops: t.ops, did: t.did }, shapeMode: shapeMode.value, imageMode: imageMode.value })
```

In `apply`, replace the inline `palette: paletteFromFrame(src.props())` with the picked palette + recolour:

```ts
    const out = applyPatternToFrame({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: tile.patternId, seed: tile.seed, palette: posterPalette(), recolour: paletteMode.value != null, connectedSlots: src.connectedSlots(), shapeMode: shapeMode.value, imageMode: imageMode.value, editor: src.editor() })
```

Add `paletteMode`/`setPaletteMode` to the return type signature and the returned object:

- In the return type (after `imageMode: Ref<boolean>; setImageMode(on: boolean): void`): `paletteMode: Ref<string[] | null>; setPaletteMode(hexes: string[] | null): void`
- In the `return { … }`: add `paletteMode, setPaletteMode`.

- [ ] **Step 4: Run, expect PASS** (all layout-sheet tests green, including the three new ones).

- [ ] **Step 5: Run the full poster suite** — `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts tests/unit/expressive-*.unit.spec.ts` — expect green.

- [ ] **Step 6: Report** (no commit).

---

### Task 2: Palette control in the Layout tab

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: `useLayoutSheet`'s `layoutSheet.paletteMode` / `setPaletteMode`; the existing `PalettePicker` component and its `apply-family` event (payload has `.hexes`).
- Produces: a "Palette" control in the Layout tab that shows the current palette (or "Frame's own colours"), opens the `PalettePicker` to choose one, and clears back to the frame's colours.

- [ ] **Step 1: Handlers** in `<script setup>` (near the other Layout-tab handlers, e.g. `pickLayoutFamily`):

```ts
function onLayoutPalette(fam: { hexes: string[] }) { layoutSheet.setPaletteMode(fam.hexes) }
function clearLayoutPalette() { layoutSheet.setPaletteMode(null) }
const layoutPaletteHexes = computed(() => layoutSheet.paletteMode.value)
```

- [ ] **Step 2: Template** — in the Layout tab, beside the shape and photo controls, add a Palette section:

```html
              <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <div class="panel-label" title="Recolour the layout from a palette; off keeps the frame's own colours">Palette</div>
                  <button v-if="layoutPaletteHexes" class="text-[10px] px-1.5 py-0.5 rounded border border-white/[0.08] text-white/50 hover:text-white/80" @click="clearLayoutPalette">Frame's own colours</button>
                </div>
                <div v-if="layoutPaletteHexes" class="flex items-center gap-1">
                  <span v-for="(h, i) in layoutPaletteHexes" :key="i" class="size-4 rounded-sm border border-white/10" :style="{ background: h }"></span>
                </div>
                <PalettePicker mode="stops" @apply-family="onLayoutPalette" />
              </div>
```

(If `PalettePicker` is not yet imported in this file, add `import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'` with the other component imports. It is already used by the Design tab, so the import likely exists — check first.)

- [ ] **Step 3: Live-verify** in the frame lab (existing :3002 server, never start a second): open a Frame with a title → Layout tab → confirm the sheet tiles show the frame's own colours; open the Palette shelf, pick a seed family → the tiles recolour and the swatches show; click "Frame's own colours" → the tiles revert. Apply a tile and confirm it commits recoloured. Screenshot as proof.

- [ ] **Step 4: Report**; controller commits by hunk after verification.

---

## Self-review notes

- **Opt-in preserved:** `paletteMode` defaults null → `posterPalette()` returns `paletteFromFrame` and `recolour` is false, so the sheet and apply are byte-identical to today until a palette is picked.
- **One projection:** roles come only from `rolesFromFamily`; `paletteFromFrame` remains the no-recolour default.
- **Persistence parity:** `setPaletteMode` writes `sailor_posterState.palette` exactly as `setShapeMode`/`setImageMode` write their keys, and the initial read restores it.
- **Type consistency:** `paletteMode` is `Ref<string[] | null>`; `PalettePicker` emits a `PaletteFamily` whose `.hexes` is the list stored.
