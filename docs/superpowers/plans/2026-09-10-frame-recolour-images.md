# Frame Recolour — Images Too Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An **Images too** option in the Colours section: when on, recolouring a frame from a family also recolours every image and wired-image layer by giving it a **gradient map** effect whose stops are the family's colours in lightness order. Same click, same undo step. Turning it off and re-applying removes the maps the recolour added, and never touches a gradient map the user added by hand.

**Architecture:** One pure module `frontend/app/lib/compositor/recolour/imageMap.ts`: `gradientMapStopsFor(familyHexes)` (stops from the family, dark→light, even positions), `applyImageMaps(layers, familyHexes, owned)` (add or update a recolour-owned gradient-map effect on every image/wired layer, returning the new layers and the owned map `{ layerId → effectId }`), `removeImageMaps(layers, owned)`. The modal's `recolourWith` composes it after `recolourFrame` inside the same undo step and remembers `owned` in `sailor_recolour.imageEffects`. A checkbox in the Colours section drives it; its state lives in `sailor_recolour.images`.

**Tech Stack:** TypeScript, Vue 3, Vitest, Playwright. Consumes `createEffect('gradientMap')`, `effectStackOf`, `EffectInstance` (`~/lib/compositor/effectStack`), `GradientMapEffect`/`GradientMapStop` (`~/lib/compositor/postEffects`), `lightnessOf` (`~/lib/compositor/recolour/map`), `recolourFrame` (`./apply`).

## Global Constraints

- **Ownership:** the recolour only ever adds, updates or removes gradient-map effects whose ids it recorded in `sailor_recolour.imageEffects` (`Record<layerId, effectId>`). A gradient map the user added by hand (any id not in that record) is never touched, and if a layer already has a user gradient map the recolour still adds its own (the stack allows several).
- **Stops:** the family's distinct colours sorted by OKLCH lightness, at even positions `i/(n-1)` (`n = 1` → one stop at 0.5); `contrast` and `mix` from `createEffect('gradientMap')` defaults, then `mix: 1`, `visible: true`. Written through `effectStackOf(layer)` (read) → new array (write to `layer.effects`), so a legacy-shape layer's effects get ids stamped exactly as the reader stamps them.
- **Targets:** layers with `kind === 'image'` or `kind === 'wired'` only.
- **One undo step:** unchanged — `recordHistory()` → `commit(layers)` → `writeBackground(bg)`; the image maps ride inside `layers`. When the option is OFF and `owned` is non-empty, apply removes the owned maps in the same commit (so switching off + re-applying cleans up), and `imageEffects` becomes `{}`.
- **`reassignSlot` never touches image maps.**
- **UI:** a checkbox row in the Colours section under the slot swatches, label **Images too** (sentence case), `data-testid="recolour-images"`, default off, remembered in `sailor_recolour.images` (UI memory, written outside undo alongside `hexes/applied`). Hint under it: "Photos take the palette as a gradient map."
- **Tests:** unit `frontend/tests/unit/recolour-image-map.unit.spec.ts`; the E2E `frontend/tests/frame-recolour.spec.ts` gains one case. Run against the running dev server for this checkout (`http://127.0.0.1:3002`, `PW_BASE_URL`; never start a second server).
- **Commit hygiene (shared checkout):** whole private-index recipe in ONE shell call; `CompositorModal.vue` BY HUNK; separate-call status check; never `git add -A`/`.`/`git stash`/`cp .git/index`.

---

### Task 1: The image-map module (pure)

**Files:**
- Create: `frontend/app/lib/compositor/recolour/imageMap.ts`
- Test: `frontend/tests/unit/recolour-image-map.unit.spec.ts`

**Interfaces:**
- Consumes: `createEffect`, `effectStackOf`, `EffectInstance` from `~/lib/compositor/effectStack` (`createEffect(kind)` returns `{ ...defaults, type, visible: true, id }`; `effectStackOf(layer)` returns the ordered id-stamped stack); `GradientMapStop { pos, color }` from `~/lib/compositor/postEffects`; `lightnessOf` from `./map`; `LocalLayer` type.
- Produces:
  ```ts
  export type OwnedMaps = Record<string, string>   // layerId → effectId
  export function gradientMapStopsFor(familyHexes: string[]): GradientMapStop[]
  export function applyImageMaps(layers: LocalLayer[], familyHexes: string[], owned: OwnedMaps): { layers: LocalLayer[]; owned: OwnedMaps }
  export function removeImageMaps(layers: LocalLayer[], owned: OwnedMaps): { layers: LocalLayer[]; owned: OwnedMaps }
  ```
  Both apply/remove deep-clone and return new layers; inputs untouched. `applyImageMaps`: for each image/wired layer, if `owned[layer.id]` names an effect present in its stack → update that effect's `stops` (keep its position, contrast, mix, visible); else append a fresh `createEffect('gradientMap')` with the stops and `mix: 1` and record its id. Layers that are no longer image/wired, or whose owned effect vanished (user deleted it), drop out of `owned`. `removeImageMaps`: filter out owned effects from each named layer's stack; return `owned: {}`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/recolour-image-map.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { gradientMapStopsFor, applyImageMaps, removeImageMaps } from '~/lib/compositor/recolour/imageMap'
import { effectStackOf, createEffect } from '~/lib/compositor/effectStack'
import { lightnessOf } from '~/lib/compositor/recolour/map'

const img = (id: string, extra: any = {}) => ({ id, kind: 'image', filename: 'x.png', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1, ...extra })
const wired = (id: string) => ({ id, kind: 'wired', slot: 1, x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1 })
const rect = (id: string) => ({ id, kind: 'rect', x: .5, y: .5, w: .2, h: .2, rotation: 0, opacity: 1, fill: '#ff0000', stroke: '', strokeWidth: 0 })
const fam = ['#f5f5f5', '#0b132b', '#5bc0be', '#3a506b']

describe('gradientMapStopsFor', () => {
  it('sorts the family dark → light at even positions, deduped', () => {
    const stops = gradientMapStopsFor([...fam, '#0B132B'])
    expect(stops.map(s => s.pos)).toEqual([0, 1 / 3, 2 / 3, 1])
    for (let i = 1; i < stops.length; i++) expect(lightnessOf(stops[i]!.color)).toBeGreaterThanOrEqual(lightnessOf(stops[i - 1]!.color))
    expect(stops[0]!.color).toBe('#0b132b'); expect(stops[3]!.color).toBe('#f5f5f5')
  })
  it('a single colour is one stop at 0.5', () => { expect(gradientMapStopsFor(['#123456'])).toEqual([{ pos: 0.5, color: '#123456' }]) })
})

describe('applyImageMaps', () => {
  it('adds an owned gradient map to every image and wired layer, not to shapes, and returns new layers', () => {
    const layers: any[] = [img('i'), wired('w'), rect('r')]
    const out = applyImageMaps(layers as any, fam, {})
    expect(Object.keys(out.owned).sort()).toEqual(['i', 'w'])
    for (const id of ['i', 'w']) {
      const l = out.layers.find(x => x.id === id) as any
      const fx = effectStackOf(l).find(e => e.id === out.owned[id]) as any
      expect(fx?.type).toBe('gradientMap'); expect(fx.mix).toBe(1); expect(fx.visible).toBe(true)
      expect(fx.stops.map((s: any) => s.color)).toEqual(gradientMapStopsFor(fam).map(s => s.color))
    }
    expect((out.layers[2] as any).effects ?? []).toEqual([])
    expect((layers[0] as any).effects).toBeUndefined()                        // input untouched
  })
  it('updates the owned map in place on re-apply (same id, same position) and leaves a user map alone', () => {
    const userMap = { ...createEffect('gradientMap'), stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }
    const drop = createEffect('drop_shadow')
    const layers: any[] = [img('i', { effects: [userMap, drop] })]
    const first = applyImageMaps(layers as any, fam, {})
    const stackA = effectStackOf(first.layers[0] as any)
    expect(stackA.map(e => e.id)).toEqual([userMap.id, drop.id, first.owned.i])   // appended after
    const second = applyImageMaps(first.layers, ['#101010', '#eeeeee'], first.owned)
    const stackB = effectStackOf(second.layers[0] as any)
    expect(second.owned.i).toBe(first.owned.i)
    expect(stackB.map(e => e.id)).toEqual(stackA.map(e => e.id))                    // position kept
    expect((stackB[2] as any).stops.map((s: any) => s.color)).toEqual(['#101010', '#eeeeee'])
    expect((stackB[0] as any).stops[0].color).toBe('#000000')                       // user map untouched
  })
  it('forgets an owned map the user deleted', () => {
    const layers: any[] = [img('i')]
    const out = applyImageMaps(layers as any, fam, { i: 'fx_gone' })
    expect(out.owned.i).not.toBe('fx_gone')
    expect(effectStackOf(out.layers[0] as any)).toHaveLength(1)
  })
})

describe('removeImageMaps', () => {
  it('removes only the owned maps and returns an empty record', () => {
    const userMap = createEffect('gradientMap')
    const layers: any[] = [img('i', { effects: [userMap] }), wired('w')]
    const applied = applyImageMaps(layers as any, fam, {})
    const out = removeImageMaps(applied.layers, applied.owned)
    expect(out.owned).toEqual({})
    expect(effectStackOf(out.layers[0] as any).map(e => e.id)).toEqual([userMap.id])
    expect(effectStackOf(out.layers[1] as any)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/recolour-image-map.unit.spec.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/compositor/recolour/imageMap.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { GradientMapStop } from '~/lib/compositor/postEffects'
import { createEffect, effectStackOf } from '~/lib/compositor/effectStack'
import type { EffectInstance } from '~/lib/compositor/effectStack'
import { lightnessOf } from './map'

/** layerId → the id of the gradient-map effect the recolour owns on that layer. */
export type OwnedMaps = Record<string, string>

const isTarget = (l: any) => l?.kind === 'image' || l?.kind === 'wired'

/** The family as a tonal map: distinct colours dark → light at even positions. */
export function gradientMapStopsFor(familyHexes: string[]): GradientMapStop[] {
  const fam = [...new Set(familyHexes.map(h => h.toLowerCase()))].sort((a, b) => lightnessOf(a) - lightnessOf(b))
  if (fam.length === 1) return [{ pos: 0.5, color: fam[0]! }]
  return fam.map((color, i) => ({ pos: i / (fam.length - 1), color }))
}

/** Add or refresh a recolour-owned gradient map on every image / wired layer. Pure. */
export function applyImageMaps(layers: LocalLayer[], familyHexes: string[], owned: OwnedMaps): { layers: LocalLayer[]; owned: OwnedMaps } {
  const stops = gradientMapStopsFor(familyHexes)
  const nextOwned: OwnedMaps = {}
  const next: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  for (const l of next as any[]) {
    if (!isTarget(l)) continue
    const stack = effectStackOf(l)
    const ownedId = owned[l.id]
    const idx = ownedId ? stack.findIndex(e => e.id === ownedId && e.type === 'gradientMap') : -1
    if (idx >= 0) {
      stack[idx] = { ...(stack[idx] as any), stops: stops.map(s => ({ ...s })) } as EffectInstance
      nextOwned[l.id] = ownedId!
    } else {
      const fx = { ...(createEffect('gradientMap') as any), stops: stops.map(s => ({ ...s })), mix: 1, visible: true } as EffectInstance
      stack.push(fx)
      nextOwned[l.id] = fx.id
    }
    l.effects = stack
  }
  return { layers: next, owned: nextOwned }
}

/** Strip the recolour-owned maps; user-added effects stay. Pure. */
export function removeImageMaps(layers: LocalLayer[], owned: OwnedMaps): { layers: LocalLayer[]; owned: OwnedMaps } {
  const next: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  for (const l of next as any[]) {
    const ownedId = owned[l.id]
    if (!ownedId) continue
    const stack = effectStackOf(l).filter(e => e.id !== ownedId)
    l.effects = stack
  }
  return { layers: next, owned: {} }
}
```
Check `createEffect('gradientMap')` really yields `{ type:'gradientMap', stops, contrast, mix, visible, id }` (defaults come from `POST_EFFECT_DEFAULTS.gradientMap`, `postEffects.ts:76`); if the stack type names `mix` differently, match the real field.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/recolour-image-map.unit.spec.ts tests/unit/recolour-*.unit.spec.ts` → PASS (23 + 6).
Typecheck: `cd frontend && npx nuxt typecheck 2>&1 | grep -E "lib/compositor/recolour" || echo "no recolour errors"`.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/compositor/recolour/imageMap.ts frontend/tests/unit/recolour-image-map.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): recolour — a family as a gradient map on image and wired layers (pure)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/compositor/recolour/imageMap.ts frontend/tests/unit/recolour-image-map.unit.spec.ts
```

---

### Task 2: The option in the Colours section, wired into apply, proven in the browser

**Files:**
- Modify (by hunk): `frontend/app/components/vue-canvas/CompositorModal.vue` — the recolour block (`recolourWith`, `recolourMemory`, `writeRecolourMemory`) and the Colours section.
- Modify: `frontend/tests/frame-recolour.spec.ts` — one new case.

**Interfaces:**
- `sailor_recolour` gains `images?: boolean` and `imageEffects?: OwnedMaps`.
- `recolourWith(hexes)`: after `recolourFrame(...)`, if `recolourImages.value` → `applyImageMaps(next.layers, hexes, memory.imageEffects ?? {})`, else if `memory.imageEffects` non-empty → `removeImageMaps(...)`; then the same single undo step (`recordHistory(); commit(layers); editor.writeBackground(bg)`); memory written with `images`, `imageEffects`.
- The identity short-circuit from the last fix wave must consider image maps too: skip `recordHistory()` only when the colour mapping is identity AND no image map would be added/updated/removed.

- [ ] **Step 1: Modal script** (inside the recolour block; grep `recolourWith`):

```ts
import { applyImageMaps, removeImageMaps } from '~/lib/compositor/recolour/imageMap'
import type { OwnedMaps } from '~/lib/compositor/recolour/imageMap'
```
```ts
type RecolourMemory = { hexes: string[]; applied: Record<string, string>; images?: boolean; imageEffects?: OwnedMaps }
const recolourMemory = computed<RecolourMemory | null>(() => ((compositor.value?.data?.properties as any)?.sailor_recolour ?? null))
const recolourImages = ref<boolean>(!!recolourMemory.value?.images)
watch(recolourMemory, m => { recolourImages.value = !!m?.images })
```
In `recolourWith(hexes)`, after computing `mapping` and `next = recolourFrame(...)`:
```ts
  const prior = recolourMemory.value?.imageEffects ?? {}
  const identity = Object.entries(mapping).every(([from, to]) => from === to)
  let layers = next.layers, imageEffects: OwnedMaps = prior
  if (recolourImages.value) { const r = applyImageMaps(layers, hexes, prior); layers = r.layers; imageEffects = r.owned }
  else if (Object.keys(prior).length) { const r = removeImageMaps(layers, prior); layers = r.layers; imageEffects = r.owned }
  const mapsChanged = recolourImages.value || Object.keys(prior).length > 0
  if (identity && !mapsChanged) return
  recordHistory(); commit(layers); editor.writeBackground(next.background)
  writeRecolourMemory({ hexes: hexes.map(h => h.toLowerCase()), applied: mapping, images: recolourImages.value, imageEffects })
```
(`writeRecolourMemory`'s parameter type widens to `RecolourMemory`. `reassignSlot` keeps `images`/`imageEffects` from the existing memory when it rewrites `applied`.)

- [ ] **Step 2: Modal template** — under `<ColourSlots …/>` inside the Colours section:

```html
              <label class="mt-2 flex items-center gap-2 text-[11.5px] text-white/70 cursor-pointer select-none">
                <input type="checkbox" data-testid="recolour-images" v-model="recolourImages" class="accent-white/80" />
                Images too
              </label>
              <p class="mb-1.5 text-[11px] text-white/45">Photos take the palette as a gradient map.</p>
```
(If the modal has a house checkbox row component — grep `StudioToggle`/`StudioCheckbox`/`RowToggle` in `app/components/vue-canvas/studio/` — use it with the same `data-testid` on its input; otherwise the plain input is acceptable here.)

- [ ] **Step 3: E2E case** — append to `frontend/tests/frame-recolour.spec.ts` inside the describe:

```ts
  test('Images too puts a family gradient map on the photos, in the same undo step, and clears it when turned off', async ({ page }) => {
    const before = await frame(page)
    await page.check('[data-testid="recolour-images"]')
    await page.getByRole('button', { name: /library/i }).first().click()
    const tile = page.locator('[data-testid="frame-colours"] [data-testid="palette-family"]').first()
    await tile.waitFor({ timeout: 10000 }); await tile.click()
    const after = await frame(page)
    const photos = after.layers.filter((l: any) => l.kind === 'image' || l.kind === 'wired')
    expect(photos.length).toBeGreaterThan(0)
    for (const p of photos) {
      const maps = (p.effects ?? []).filter((e: any) => e.type === 'gradientMap')
      expect(maps).toHaveLength(1); expect(maps[0].stops.length).toBeGreaterThanOrEqual(2); expect(maps[0].mix).toBe(1)
      expect(after.memory.imageEffects[p.id]).toBe(maps[0].id)
    }
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    const undone = await frame(page)
    expect(undone.layers).toEqual(before.layers)                       // ONE undo took the maps with the colours
    // turn it off and re-apply: the owned maps go away
    await page.uncheck('[data-testid="recolour-images"]')
    await tile.click()
    const cleared = await frame(page)
    for (const p of cleared.layers.filter((l: any) => l.kind === 'image' || l.kind === 'wired')) expect((p.effects ?? []).filter((e: any) => e.type === 'gradientMap')).toHaveLength(0)
    expect(cleared.memory.imageEffects).toEqual({})
  })
```
Note `frame()` in that spec returns `memory` — confirm the helper exposes `sailor_recolour` as `memory` (it does in the landed spec). After undo the memory still says `images: true` (UI memory) — the checkbox stays checked; the test unchecks it explicitly.

- [ ] **Step 4: Runs**

Typecheck grep (`CompositorModal.vue.*(recolourImages|imageMap)` → no new errors). E2E: `cd frontend && npx playwright test tests/frame-recolour.spec.ts --reporter=line` → 4 passed. Browser smoke via the pane: tick Images too, pick a family, see the photo take the palette; untick + re-pick clears it; no console errors.

- [ ] **Step 5: Commit** — spec whole, modal BY HUNK, ONE call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git diff -- frontend/app/components/vue-canvas/CompositorModal.vue > /tmp/cm.diff
```
trim to your hunks → `/tmp/cm-mine.diff`, then
```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/tests/frame-recolour.spec.ts && git apply --cached /tmp/cm-mine.diff && git diff --cached --name-only && git diff --cached --stat && git commit -m "feat(frame): Images too — recolour puts the family on photos as a gradient map, same undo step" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/tests/frame-recolour.spec.ts && git reset -q -- frontend/app/components/vue-canvas/CompositorModal.vue
```

---

## Notes for the executor

- Verified 2026-09-10: `EFFECT_ORDER` includes `'gradientMap'` (`effectStack.ts:83`, label "Gradient map" :129); `createEffect(kind)` (:176) stamps `id` + `visible` over `POST_EFFECT_DEFAULTS` (`postEffects.ts:70`, `gradientMap` at :76: `stops`, `contrast`, `mix`, `visible`); `effectStackOf` (:197) returns the stored id-stamped array or stamps deterministic ids for a legacy shape; wired layers run the same stack (`useCompositorLayers.ts:1977–1981`). `LayerCommon.effects?: LayerEffect[]` (:307) exists on every kind.
- The walker (`sites.ts`) deliberately ignores effect colours; image maps are derived from the family, not from slots — do not add them as sites.
