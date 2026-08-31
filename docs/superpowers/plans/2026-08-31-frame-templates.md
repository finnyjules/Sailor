# Frame Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save a Frame (Compositor layer stack) as a reusable **Template** with tapped text/color/image **slots**, keep it in a cross-project library, drop copies into any project, fill each copy's slots, restyle the template and update old copies per-project (with a reshape guard), and freeze a copy to lock it.

**Architecture:** A pure logic module `app/lib/frametemplate/` (types + author + apply) computes template snapshots and instance materialization with **no Vue/DOM**. The library persists through Sailor's existing owner-scoped JSON store (same stack as brand kits: `ownedJsonStore.ts` + `resourceOwners.ts` + `dataDir.ts`), so it works local AND hosted, and Sailor's own curated templates ride the same store as *unowned* rows. Placed copies live in a new node property `node.data.properties.sailor_frametemplates` (round-trips free — `properties` is passed through wholesale by `convertToLiteGraph`). The Compositor UI wires the pure functions to the real editor's undo/commit (`useLocalLayerEditor`'s `recordHistory` + `commitBoth`).

**Tech Stack:** Nuxt 4 (Vue 3 + TS), Vitest (unit), Playwright (E2E via `/dev/frame-lab`), the existing Compositor layer model (`useCompositorLayers.ts` / `useLocalLayerEditor.ts`), the Stage-6 owned-JSON store.

## Global Constraints

- **Slot rule (verbatim from spec):** the copy owns its slot values; the template owns everything else. There is never a state where they disagree.
- **Restyle vs. reshape:** restyling a template (colors/timing/look, add/remove *locked* layers) flows to old copies; reshaping it (adding/removing/retyping a *slot*) does NOT — a reshape becomes a new version, and incompatible copies are silently skipped by the update prompt.
- **Stable slot keys:** layer `id`s are `ll-<base36>-<seq>` and regenerate on copy/paste — never reference a slot layer by raw `id` or `l:<id>` across a recompose. Each template layer carries a stable `key`; each instance stores `placedKeys: key → placed layer id`.
- **Node property placement:** instance data lives at `node.data.properties.sailor_frametemplates` (an array). It round-trips automatically (no `convertToLiteGraph` whitelist edit). Never store it directly on `node.data.*`.
- **Naming (avoid collisions):** existing `templates-layouts` store / resource kind `'template'` are the grid-layout feature — do NOT reuse them. This feature uses store `frame-templates`, resource kind `'frame-template'`, module `app/lib/frametemplate/`, node property `sailor_frametemplates`, composable `useTemplateLibrary`. User-facing name: **Templates** (shown under a **Yours** section).
- **No brand-kit coupling:** color slots and locked colors store plain hex (`Paint` string). No brand-kit resolution anywhere in v1.
- **Purity:** everything in `app/lib/frametemplate/` is pure (no Vue refs, no DOM, no `Date.now()`/`Math.random()` inside pure compute — id/version minting is injected or done by the caller). This is what makes it unit-testable and deterministic.
- **Commits:** commit after each task. Branch first if on `main`.

---

## File Structure

- `app/lib/frametemplate/types.ts` — all contracts (Template, SlotMark, TemplateLayer, TemplateInstance, PlaceCtx).
- `app/lib/frametemplate/author.ts` — pure: snapshot a Frame's layers+groups into a Template; add/remove slot marks.
- `app/lib/frametemplate/apply.ts` — pure: place, fill a slot, freeze, slot-compatibility, stale detection, update/restyle.
- `server/utils/dataDir.ts` — MODIFY: add `'frame-templates'` StoreName.
- `server/utils/resourceOwners.ts` — MODIFY: add `'frame-template'` resource kind.
- `server/api/frame-templates/index.get.ts` · `[id].put.ts` · `[id].delete.ts` — the library store routes (copied pattern).
- `app/composables/useTemplateLibrary.ts` — client library composable (mirrors `useBrandLibrary.ts`).
- `app/components/vue-canvas/CompositorModal.vue` — MODIFY: "Save as template" gesture, slot-marking, the copy's slot-fill panel + Freeze, a "Templates" picker entry, the per-project update prompt trigger.
- `app/components/vue-canvas/TemplateLibraryPanel.vue` — the gallery (Yours / Sailor sections) + place.
- `app/layouts/default.vue` — MODIFY: un-stub the sidebar "Templates" door (line ~152) → open the panel.
- `app/lib/agent/capabilities.ts` · `app/data/action-catalog.ts` — MODIFY: register template intents/ops.
- `app/lib/agent/surfaces/compositor.ts` — MODIFY: agent ops `placeTemplate` / `setTemplateSlot` / `freezeTemplate`.
- Tests: `tests/unit/frametemplate-author.unit.spec.ts`, `frametemplate-apply.unit.spec.ts`, `frametemplate-update.unit.spec.ts`; `tests/frame-templates.spec.ts` (E2E).

---

### Task 1: Library store (server routes + resource kind + client composable)

**Files:**
- Modify: `server/utils/dataDir.ts` (StoreName union) · `server/utils/resourceOwners.ts` (RESOURCE_KINDS)
- Create: `server/api/frame-templates/index.get.ts` · `server/api/frame-templates/[id].put.ts` · `server/api/frame-templates/[id].delete.ts`
- Create: `app/composables/useTemplateLibrary.ts`
- Test: `tests/unit/frametemplate-store.unit.spec.ts`

**Interfaces:**
- Consumes: `listOwned`, `guardMutation`, `claimNew`, `releaseRecord` from `server/utils/ownedJsonStore.ts`; `storeDir` from `server/utils/dataDir.ts`.
- Produces: HTTP `GET /api/frame-templates` → `{ templates: StoredTemplate[] }`; `PUT /api/frame-templates/:id` (body = `StoredTemplate`); `DELETE /api/frame-templates/:id`. Client `useTemplateLibrary()` → `{ templates: Ref<StoredTemplate[]>, save(t), remove(id), get(id), refresh() }`. `StoredTemplate` is the on-disk shape = the `Template` type from Task 2 (imported once Task 2 lands; for Task 1 it is `Record<string, unknown> & { id: string; name: string; version: number }`).

- [ ] **Step 1: Read the two existing patterns to copy verbatim.** Read `server/api/brand-kits/index.get.ts`, `[id].put.ts`, `[id].delete.ts`, `server/utils/ownedJsonStore.ts`, and `app/composables/useBrandLibrary.ts`. The three routes and the composable below mirror them exactly, only changing the store name to `'frame-templates'` and the resource kind to `'frame-template'`.

- [ ] **Step 2: Add the StoreName.** In `server/utils/dataDir.ts`, add `'frame-templates'` to the `StoreName` union and to `LOCAL_PATHS` (mirror the `'brand-kits'` entry so local dev writes to `frontend/server/frame-templates/`).

```ts
// dataDir.ts — StoreName union, add:
export type StoreName = 'brand-kits' | 'moodboards' | 'templates-layouts' | 'templates-fonts-user' | 'frame-templates' | 'data'
// LOCAL_PATHS, add (mirror the brand-kits entry's shape):
'frame-templates': ['server', 'frame-templates'],
```

- [ ] **Step 3: Add the resource kind.** In `server/utils/resourceOwners.ts`, add `'frame-template'` to `RESOURCE_KINDS`.

```ts
export const RESOURCE_KINDS = [
  'project', 'brand-kit', 'moodboard', 'template', 'template-font',
  'frame-template',
  'character', 'lora', 'voice', 'timeline-asset', 'cloud-training',
] as const
```

- [ ] **Step 4: Write the failing store unit test.** `tests/unit/frametemplate-store.unit.spec.ts` — assert the client composable's optimistic upsert and removal against a mocked `$fetch`/`fetch`. Mirror any existing `useBrandLibrary` unit test if present; otherwise:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTemplateLibrary } from '~/composables/useTemplateLibrary'

describe('useTemplateLibrary', () => {
  beforeEach(() => { vi.restoreAllMocks(); useTemplateLibrary()._clearForTests() })
  it('optimistically upserts on save and calls PUT /api/frame-templates/:id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const lib = useTemplateLibrary()
    await lib.save({ id: 't1', name: 'Lower third', version: 1 } as any)
    expect(lib.templates.value.find(t => t.id === 't1')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/frame-templates/t1', expect.objectContaining({ method: 'PUT' }))
  })
  it('removes optimistically and calls DELETE', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const lib = useTemplateLibrary()
    await lib.save({ id: 't1', name: 'x', version: 1 } as any)
    await lib.remove('t1')
    expect(lib.templates.value.find(t => t.id === 't1')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/frame-templates/t1', expect.objectContaining({ method: 'DELETE' }))
  })
})
```

- [ ] **Step 5: Run it — expect FAIL** (`useTemplateLibrary` not found). `cd frontend && npx vitest run tests/unit/frametemplate-store.unit.spec.ts`

- [ ] **Step 6: Write the three routes.** Each copies the brand-kits route body, swapping the store name and kind. `index.get.ts`:

```ts
// server/api/frame-templates/index.get.ts
import { listOwned } from '~~/server/utils/ownedJsonStore'
export default defineEventHandler(async (event) => {
  const templates = await listOwned({ store: 'frame-templates', kind: 'frame-template' }, event)
  return { templates }
})
```

`[id].put.ts` and `[id].delete.ts` mirror `brand-kits/[id].put.ts` / `[id].delete.ts` exactly (read `id` from `getRouterParam`, `guardMutation`, write/remove the `<id>.json` via the same helpers, `claimNew`/`releaseRecord`). Copy them line-for-line, substituting `store: 'frame-templates', kind: 'frame-template'`.

- [ ] **Step 7: Write the client composable.** `app/composables/useTemplateLibrary.ts`, mirroring `useBrandLibrary.ts` (singleton ref, optimistic upsert with refresh-on-failure rollback, `_clearForTests`):

```ts
import { ref } from 'vue'
export interface StoredTemplate { id: string; name: string; version: number; [k: string]: unknown }
const templates = ref<StoredTemplate[]>([])
let loaded = false
async function refresh() {
  const res = await fetch('/api/frame-templates')
  if (res.ok) templates.value = (await res.json()).templates ?? []
  loaded = true
}
async function save(entry: StoredTemplate) {
  const i = templates.value.findIndex(t => t.id === entry.id)
  if (i >= 0) templates.value.splice(i, 1, entry); else templates.value.unshift(entry)
  const res = await fetch(`/api/frame-templates/${entry.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
  })
  if (!res.ok) await refresh() // rollback to server truth
}
async function remove(id: string) {
  templates.value = templates.value.filter(t => t.id !== id)
  const res = await fetch(`/api/frame-templates/${id}`, { method: 'DELETE' })
  if (!res.ok) await refresh()
}
function get(id: string) { return templates.value.find(t => t.id === id) }
export function useTemplateLibrary() {
  if (!loaded) refresh().catch(() => {})
  return { templates, save, remove, get, refresh, _clearForTests: () => { templates.value = []; loaded = false } }
}
```

- [ ] **Step 8: Run tests — expect PASS.** `cd frontend && npx vitest run tests/unit/frametemplate-store.unit.spec.ts`

- [ ] **Step 9: Commit.**
```bash
git add server/utils/dataDir.ts server/utils/resourceOwners.ts server/api/frame-templates app/composables/useTemplateLibrary.ts tests/unit/frametemplate-store.unit.spec.ts
git commit -m "feat(templates): owner-scoped frame-templates library store + client"
```

---

### Task 2: Template contracts + authoring (snapshot a Frame, mark slots)

**Files:**
- Create: `app/lib/frametemplate/types.ts` · `app/lib/frametemplate/author.ts`
- Test: `tests/unit/frametemplate-author.unit.spec.ts`

**Interfaces:**
- Consumes: `LocalLayer` from `~/composables/useCompositorLayers`; `LayerGroup` from `~/lib/compositor/layerGroups`.
- Produces:
  - `type SlotKind = 'text' | 'color' | 'image'`
  - `interface SlotMark { id: string; layerKey: string; kind: SlotKind; label: string }`
  - `interface TemplateLayer { key: string; layer: LocalLayer }`
  - `interface Template { id: string; name: string; version: number; layers: TemplateLayer[]; groups: LayerGroup[]; slots: SlotMark[]; frameSize: { w: number; h: number } }`
  - `interface TemplateInstance { instanceId: string; templateId: string; templateVersion: number; slotValues: Record<string, string>; placedKeys: Record<string, string> }`
  - `snapshotFrameAsTemplate(input): Template`
  - `addSlot(t: Template, layerKey: string, kind: SlotKind, label: string, mkId: () => string): Template`
  - `removeSlot(t: Template, slotId: string): Template`

- [ ] **Step 1: Write `types.ts`.** Exactly the contracts above. Import types only (`import type { LocalLayer } from '~/composables/useCompositorLayers'`, `import type { LayerGroup } from '~/lib/compositor/layerGroups'`).

- [ ] **Step 2: Write the failing author test.** `tests/unit/frametemplate-author.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { snapshotFrameAsTemplate, addSlot, removeSlot } from '~/lib/frametemplate/author'

const textLayer = (id: string, text: string) => ({ id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text, color: '#fff' } as any)

describe('snapshotFrameAsTemplate', () => {
  it('assigns a stable key to every layer and copies deeply (no aliasing)', () => {
    const layers = [textLayer('ll-a', 'Hi'), textLayer('ll-b', 'Yo')]
    const t = snapshotFrameAsTemplate({ id: 'tpl1', name: 'Two lines', layers, groups: [], frameSize: { w: 1920, h: 1080 }, mkKey: (i) => `k${i}` })
    expect(t.layers.map(l => l.key)).toEqual(['k0', 'k1'])
    expect(t.version).toBe(1)
    layers[0].text = 'MUTATED'
    expect(t.layers[0].layer.text).toBe('Hi') // deep copy, not a reference
  })
})

describe('addSlot / removeSlot', () => {
  it('adds a slot referencing a layer key, then removes it', () => {
    const layers = [textLayer('ll-a', 'Hi')]
    let t = snapshotFrameAsTemplate({ id: 'tpl1', name: 'x', layers, groups: [], frameSize: { w: 100, h: 100 }, mkKey: (i) => `k${i}` })
    t = addSlot(t, 'k0', 'text', 'Headline', () => 'slot0')
    expect(t.slots).toEqual([{ id: 'slot0', layerKey: 'k0', kind: 'text', label: 'Headline' }])
    t = removeSlot(t, 'slot0')
    expect(t.slots).toEqual([])
  })
})
```

- [ ] **Step 3: Run — expect FAIL.** `cd frontend && npx vitest run tests/unit/frametemplate-author.unit.spec.ts`

- [ ] **Step 4: Write `author.ts`.**

```ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Template, SlotKind } from './types'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export function snapshotFrameAsTemplate(input: {
  id: string; name: string; layers: LocalLayer[]; groups: LayerGroup[]
  frameSize: { w: number; h: number }; mkKey: (index: number) => string
}): Template {
  return {
    id: input.id, name: input.name, version: 1,
    layers: input.layers.map((layer, i) => ({ key: input.mkKey(i), layer: clone(layer) })),
    groups: clone(input.groups),
    slots: [],
    frameSize: { ...input.frameSize },
  }
}

export function addSlot(t: Template, layerKey: string, kind: SlotKind, label: string, mkId: () => string): Template {
  if (!t.layers.some(l => l.key === layerKey)) throw new Error(`no template layer with key ${layerKey}`)
  return { ...t, slots: [...t.slots, { id: mkId(), layerKey, kind, label }] }
}

export function removeSlot(t: Template, slotId: string): Template {
  return { ...t, slots: t.slots.filter(s => s.id !== slotId) }
}
```

- [ ] **Step 5: Run — expect PASS.** `cd frontend && npx vitest run tests/unit/frametemplate-author.unit.spec.ts`

- [ ] **Step 6: Commit.**
```bash
git add app/lib/frametemplate/types.ts app/lib/frametemplate/author.ts tests/unit/frametemplate-author.unit.spec.ts
git commit -m "feat(templates): Template contracts + pure authoring (snapshot + slot marks)"
```

---

### Task 3: Place a template (materialize a copy into a Frame)

**Files:**
- Create: `app/lib/frametemplate/apply.ts`
- Test: `tests/unit/frametemplate-apply.unit.spec.ts`

**Interfaces:**
- Consumes: `Template`, `TemplateInstance`, `SlotMark` (Task 2); `LocalLayer` / `LayerGroup`.
- Produces: `placeTemplate(current: { layers: LocalLayer[]; groups: LayerGroup[] }, t: Template, slotValues: Record<string,string>, ctx: PlaceCtx): { layers: LocalLayer[]; groups: LayerGroup[]; instance: TemplateInstance }` where `interface PlaceCtx { mkLayerId: () => string; mkGroupId: () => string; mkInstanceId: () => string }`. Also `applySlotToLayer(layer: LocalLayer, kind: SlotKind, value: string): void` (mutates a cloned layer in place — sets `.text` for text, `.filename` for image, and the fill field for color: `color` on text, `tint` on image, `fill` on rect/ellipse/path, `stroke` on line).

- [ ] **Step 1: Write the failing place test.** `tests/unit/frametemplate-apply.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { placeTemplate } from '~/lib/frametemplate/apply'
import type { Template } from '~/lib/frametemplate/types'

const tpl: Template = {
  id: 'tpl1', name: 'Lower third', version: 3,
  layers: [
    { key: 'bg', layer: { id: 'x', kind: 'rect', x: 0.5, y: 0.8, rotation: 0, opacity: 1, fill: '#111' } as any },
    { key: 'head', layer: { id: 'y', kind: 'text', x: 0.5, y: 0.8, rotation: 0, opacity: 1, text: 'NAME', color: '#fff' } as any },
  ],
  groups: [], slots: [{ id: 's-head', layerKey: 'head', kind: 'text', label: 'Headline' }],
  frameSize: { w: 1920, h: 1080 },
}
const ctx = (() => { let n = 0; return { mkLayerId: () => `new-${++n}`, mkGroupId: () => 'g-new', mkInstanceId: () => 'inst-1' } })()

describe('placeTemplate', () => {
  it('materializes fresh layers, fills the slot, and records key→id + version', () => {
    const r = placeTemplate({ layers: [], groups: [] }, tpl, { 's-head': 'Julien' }, ctx)
    expect(r.layers).toHaveLength(2)
    // fresh ids, not the template's
    expect(r.layers.every(l => l.id.startsWith('new-'))).toBe(true)
    // slot applied to the head layer
    const head = r.layers.find(l => l.kind === 'text') as any
    expect(head.text).toBe('Julien')
    // locked layer unchanged
    const bg = r.layers.find(l => l.kind === 'rect') as any
    expect(bg.fill).toBe('#111')
    // instance records the map + the template's current version
    expect(r.instance.templateVersion).toBe(3)
    expect(r.instance.slotValues).toEqual({ 's-head': 'Julien' })
    expect(Object.keys(r.instance.placedKeys)).toEqual(['bg', 'head'])
    expect(r.instance.placedKeys.head).toBe(head.id)
  })
  it('preserves existing layers (append, not replace)', () => {
    const existing = { id: 'keep', kind: 'text', x: 0.1, y: 0.1, rotation: 0, opacity: 1, text: 'keep' } as any
    const r = placeTemplate({ layers: [existing], groups: [] }, tpl, { 's-head': 'A' }, ctx)
    expect(r.layers[0]).toBe(existing)
    expect(r.layers).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run — expect FAIL.** `cd frontend && npx vitest run tests/unit/frametemplate-apply.unit.spec.ts`

- [ ] **Step 3: Write `apply.ts` (place + helpers).**

```ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Template, TemplateInstance, SlotKind } from './types'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/** Set a slot's value onto a (cloned) layer, mutating it in place. */
export function applySlotToLayer(layer: any, kind: SlotKind, value: string): void {
  if (kind === 'text') { layer.text = value; return }
  if (kind === 'image') { layer.filename = value; return }
  // color slot → the layer's fill field, by kind
  if (layer.kind === 'text') layer.color = value
  else if (layer.kind === 'image') layer.tint = value
  else if (layer.kind === 'line') layer.stroke = value
  else layer.fill = value // rect / ellipse / path / polygon / star
}

export interface PlaceCtx { mkLayerId: () => string; mkGroupId: () => string; mkInstanceId: () => string }

export function placeTemplate(
  current: { layers: LocalLayer[]; groups: LayerGroup[] },
  t: Template,
  slotValues: Record<string, string>,
  ctx: PlaceCtx,
): { layers: LocalLayer[]; groups: LayerGroup[]; instance: TemplateInstance } {
  const slotByLayerKey = new Map(t.slots.map(s => [s.layerKey, s]))
  const groupIdMap = new Map<string, string>() // template groupId → fresh groupId
  for (const g of t.groups) groupIdMap.set(g.id, ctx.mkGroupId())
  const placedKeys: Record<string, string> = {}

  const newLayers = t.layers.map(({ key, layer }) => {
    const copy: any = clone(layer)
    copy.id = ctx.mkLayerId()
    if (copy.groupId && groupIdMap.has(copy.groupId)) copy.groupId = groupIdMap.get(copy.groupId)
    const slot = slotByLayerKey.get(key)
    if (slot && slotValues[slot.id] !== undefined) applySlotToLayer(copy, slot.kind, slotValues[slot.id])
    placedKeys[key] = copy.id
    return copy as LocalLayer
  })

  const newGroups = t.groups.map(g => {
    const ng: any = clone(g)
    ng.id = groupIdMap.get(g.id)!
    if (ng.parentId && groupIdMap.has(ng.parentId)) ng.parentId = groupIdMap.get(ng.parentId)
    return ng as LayerGroup
  })

  const instance: TemplateInstance = {
    instanceId: ctx.mkInstanceId(),
    templateId: t.id,
    templateVersion: t.version,
    slotValues: { ...slotValues },
    placedKeys,
  }
  return { layers: [...current.layers, ...newLayers], groups: [...current.groups, ...newGroups], instance }
}
```

- [ ] **Step 4: Run — expect PASS.** `cd frontend && npx vitest run tests/unit/frametemplate-apply.unit.spec.ts`

- [ ] **Step 5: Commit.**
```bash
git add app/lib/frametemplate/apply.ts tests/unit/frametemplate-apply.unit.spec.ts
git commit -m "feat(templates): pure placeTemplate — materialize a copy, fill slots, map keys"
```

---

### Task 4: Fill a slot on a placed copy + freeze

**Files:**
- Modify: `app/lib/frametemplate/apply.ts`
- Test: `tests/unit/frametemplate-apply.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 3 exports; `Template`.
- Produces:
  - `setInstanceSlot(layers: LocalLayer[], t: Template, instance: TemplateInstance, slotId: string, value: string): { layers: LocalLayer[]; instance: TemplateInstance }` — updates the placed slot layer's content and the instance's `slotValues`.
  - `freezeInstance(instances: TemplateInstance[], instanceId: string): TemplateInstance[]` — drops the instance card (layers untouched); a frozen copy is simply one with no card, so it is never offered an update.

- [ ] **Step 1: Extend the test.**

```ts
import { setInstanceSlot, freezeInstance } from '~/lib/frametemplate/apply'

it('setInstanceSlot updates the placed slot layer and the instance value', () => {
  const placed = placeTemplate({ layers: [], groups: [] }, tpl, { 's-head': 'A' }, ctx)
  const r = setInstanceSlot(placed.layers, tpl, placed.instance, 's-head', 'B')
  const head = r.layers.find(l => l.id === placed.instance.placedKeys.head) as any
  expect(head.text).toBe('B')
  expect(r.instance.slotValues['s-head']).toBe('B')
})
it('freezeInstance drops the card and leaves layers alone', () => {
  const placed = placeTemplate({ layers: [], groups: [] }, tpl, { 's-head': 'A' }, ctx)
  const after = freezeInstance([placed.instance], placed.instance.instanceId)
  expect(after).toEqual([])
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement in `apply.ts`.**

```ts
export function setInstanceSlot(
  layers: LocalLayer[], t: Template, instance: TemplateInstance, slotId: string, value: string,
): { layers: LocalLayer[]; instance: TemplateInstance } {
  const slot = t.slots.find(s => s.id === slotId)
  if (!slot) throw new Error(`no slot ${slotId}`)
  const layerId = instance.placedKeys[slot.layerKey]
  const next = layers.map(l => {
    if (l.id !== layerId) return l
    const copy: any = clone(l); applySlotToLayer(copy, slot.kind, value); return copy as LocalLayer
  })
  return { layers: next, instance: { ...instance, slotValues: { ...instance.slotValues, [slotId]: value } } }
}

export function freezeInstance(instances: TemplateInstance[], instanceId: string): TemplateInstance[] {
  return instances.filter(i => i.instanceId !== instanceId)
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.**
```bash
git add app/lib/frametemplate/apply.ts tests/unit/frametemplate-apply.unit.spec.ts
git commit -m "feat(templates): fill a placed slot + freeze (drop the card, keep layers)"
```

---

### Task 5: Slot-compatibility + stale detection + update (restyle)

**Files:**
- Modify: `app/lib/frametemplate/apply.ts`
- Test: `tests/unit/frametemplate-update.unit.spec.ts`

**Interfaces:**
- Produces:
  - `slotCompatible(t: Template, instance: TemplateInstance): boolean` — true iff the template's slot ids+kinds exactly match the instance's placed slots (same ids, same kinds). Reshape ⇒ false.
  - `staleInstances(instances: TemplateInstance[], byId: (id: string) => Template | undefined): { instance: TemplateInstance; template: Template }[]` — those whose `templateVersion < template.version` AND `slotCompatible`.
  - `updateInstance(current: { layers: LocalLayer[]; groups: LayerGroup[] }, t: Template, instance: TemplateInstance, ctx: { mkLayerId: () => string; mkGroupId: () => string }): { layers: LocalLayer[]; groups: LayerGroup[]; instance: TemplateInstance }` — re-materializes the copy's group from the new template + the instance's preserved slot values, reusing placed ids where the template key still exists, and bumps `templateVersion`.

- [ ] **Step 1: Write the failing update test.** `tests/unit/frametemplate-update.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { placeTemplate, updateInstance, slotCompatible, staleInstances } from '~/lib/frametemplate/apply'
import type { Template } from '~/lib/frametemplate/types'

const v1: Template = {
  id: 'tpl', name: 'x', version: 1,
  layers: [
    { key: 'bg', layer: { id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, fill: '#111' } as any },
    { key: 'head', layer: { id: 'b', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NAME', color: '#fff' } as any },
  ],
  groups: [], slots: [{ id: 's-head', layerKey: 'head', kind: 'text', label: 'Headline' }], frameSize: { w: 100, h: 100 },
}
const mk = () => { let n = 0; return { mkLayerId: () => `n${++n}`, mkGroupId: () => 'g', mkInstanceId: () => 'inst' } }

it('restyle flows to a copy while its slot value survives', () => {
  const placed = placeTemplate({ layers: [], groups: [] }, v1, { 's-head': 'Julien' }, mk())
  // v2 restyles the LOCKED bg color; slots unchanged
  const v2: Template = { ...v1, version: 2, layers: [
    { key: 'bg', layer: { ...v1.layers[0].layer, fill: '#c00' } as any },
    v1.layers[1],
  ] }
  expect(slotCompatible(v2, placed.instance)).toBe(true)
  const upd = updateInstance({ layers: placed.layers, groups: [] }, v2, placed.instance, { mkLayerId: () => `u${Math.random()}`, mkGroupId: () => 'g' })
  const bg = upd.layers.find(l => l.kind === 'rect') as any
  const head = upd.layers.find(l => l.kind === 'text') as any
  expect(bg.fill).toBe('#c00')       // restyle reached the copy
  expect(head.text).toBe('Julien')   // slot value preserved
  expect(upd.instance.templateVersion).toBe(2)
})

it('a reshape (added slot) is NOT compatible and is skipped by staleInstances', () => {
  const placed = placeTemplate({ layers: [], groups: [] }, v1, { 's-head': 'Julien' }, mk())
  const v2: Template = { ...v1, version: 2, slots: [...v1.slots, { id: 's-new', layerKey: 'bg', kind: 'color', label: 'Accent' }] }
  expect(slotCompatible(v2, placed.instance)).toBe(false)
  expect(staleInstances([placed.instance], () => v2)).toEqual([])
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement in `apply.ts`.**

```ts
export function slotCompatible(t: Template, instance: TemplateInstance): boolean {
  const tplSlotIds = t.slots.map(s => s.id).sort()
  const instSlotIds = Object.keys(instance.slotValues).sort()
  if (tplSlotIds.length !== instSlotIds.length) return false
  return tplSlotIds.every((id, i) => id === instSlotIds[i])
}

export function staleInstances(
  instances: TemplateInstance[], byId: (id: string) => Template | undefined,
): { instance: TemplateInstance; template: Template }[] {
  const out: { instance: TemplateInstance; template: Template }[] = []
  for (const instance of instances) {
    const template = byId(instance.templateId)
    if (!template) continue
    if (instance.templateVersion < template.version && slotCompatible(template, instance)) out.push({ instance, template })
  }
  return out
}

export function updateInstance(
  current: { layers: LocalLayer[]; groups: LayerGroup[] },
  t: Template,
  instance: TemplateInstance,
  ctx: { mkLayerId: () => string; mkGroupId: () => string },
): { layers: LocalLayer[]; groups: LayerGroup[]; instance: TemplateInstance } {
  // Remove this copy's placed layers, then re-materialize from the new template,
  // preserving slot values and reusing placed ids where the key still exists.
  const placedIds = new Set(Object.values(instance.placedKeys))
  const kept = current.layers.filter(l => !placedIds.has(l.id))
  const re = placeTemplate({ layers: kept, groups: current.groups }, t, instance.slotValues, {
    mkLayerId: ctx.mkLayerId, mkGroupId: ctx.mkGroupId, mkInstanceId: () => instance.instanceId,
  })
  // Reuse prior placed ids for keys that survived, so animation/mask refs stay put.
  for (const [key, oldId] of Object.entries(instance.placedKeys)) {
    const newId = re.instance.placedKeys[key]
    if (!newId) continue
    const layer = re.layers.find(l => l.id === newId); if (layer) (layer as any).id = oldId
    re.instance.placedKeys[key] = oldId
  }
  return { layers: re.layers, groups: re.groups, instance: re.instance }
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Verify the teeth (standing lesson).** Temporarily break `updateInstance` so it drops the slot preservation (pass `{}` instead of `instance.slotValues`), re-run — the "slot value survives" test MUST fail. Restore.

- [ ] **Step 6: Commit.**
```bash
git add app/lib/frametemplate/apply.ts tests/unit/frametemplate-update.unit.spec.ts
git commit -m "feat(templates): slot-compatibility, stale detection, restyle update"
```

---

### Task 6: Compositor wiring — Save as template, slot-marking, fill panel, freeze

**Files:**
- Modify: `app/components/vue-canvas/CompositorModal.vue`
- (No new unit test — this is UI wiring; verified by the E2E in Task 9. Runtime-verify manually per the steps.)

**Interfaces:**
- Consumes: `useTemplateLibrary` (Task 1); `snapshotFrameAsTemplate`, `addSlot` (Task 2); `placeTemplate`, `setInstanceSlot`, `freezeInstance` (Tasks 3–4); the editor's `localLayers`, `localGroups`, `recordHistory`, `commitBoth`, `commit` (from the `useLocalLayerEditor` instance the modal already holds).
- Produces: reads/writes `node.data.properties.sailor_frametemplates` (array of `TemplateInstance`); dispatches nothing new externally.

- [ ] **Step 1: Add a "Save as template" action.** In `CompositorModal.vue`'s toolbar (near the existing add-layer buttons, ~line 5060–5210), add a button that opens a small name prompt, then:

```ts
import { snapshotFrameAsTemplate, addSlot } from '~/lib/frametemplate/author'
import { useTemplateLibrary } from '~/composables/useTemplateLibrary'
const templateLib = useTemplateLibrary()

async function saveAsTemplate(name: string, slotPicks: { layerId: string; kind: SlotKind; label: string }[]) {
  const id = `tpl-${Date.now().toString(36)}`
  let t = snapshotFrameAsTemplate({
    id, name, layers: localLayers.value, groups: localGroups.value,
    frameSize: dims(), // the modal's current W/H helper
    mkKey: (i) => `k${i}`,
  })
  // map the user's tapped layer ids → template layer keys (same order as snapshot)
  const keyByLayerId = new Map(localLayers.value.map((l, i) => [l.id, `k${i}`]))
  let slotSeq = 0
  for (const pick of slotPicks) {
    const key = keyByLayerId.get(pick.layerId); if (!key) continue
    t = addSlot(t, key, pick.kind, pick.label, () => `slot-${slotSeq++}`)
  }
  await templateLib.save(t as any)
}
```

The slot-picking UI: while the Save-as-template sheet is open, clicking a layer in the layer panel toggles it as a slot and prompts for a kind (text/color/image, defaulting from the layer kind: text→text, image→image, shape→color) and a label. Collect these into `slotPicks`. (Reuse the modal's existing layer-selection affordance; add a small "slot" toggle + kind/label inputs per selected layer.)

- [ ] **Step 2: Read/write the instance array helper.**

```ts
import type { TemplateInstance } from '~/lib/frametemplate/types'
function instances(): TemplateInstance[] {
  return (node()?.data?.properties?.sailor_frametemplates as TemplateInstance[]) ?? []
}
function commitInstances(next: TemplateInstance[]) {
  const n = node(); if (!n) return
  if (!n.data.properties) n.data.properties = {}
  n.data.properties.sailor_frametemplates = next
}
```

- [ ] **Step 3: Place a template into the open Frame.**

```ts
import { placeTemplate } from '~/lib/frametemplate/apply'
let _seq = 0
const mkId = (p: string) => () => `${p}-${Date.now().toString(36)}-${++_seq}`
function placeTemplateIntoFrame(t: Template) {
  const r = placeTemplate({ layers: localLayers.value, groups: localGroups.value }, t, defaultSlotValues(t), {
    mkLayerId: mkId('ll'), mkGroupId: mkId('g'), mkInstanceId: mkId('inst'),
  })
  recordHistory()
  commitBoth(r.layers, r.groups)
  commitInstances([...instances(), r.instance])
}
function defaultSlotValues(t: Template): Record<string, string> {
  // seed each slot from the template layer's current content
  const out: Record<string, string> = {}
  for (const s of t.slots) {
    const tl = t.layers.find(l => l.key === s.layerKey)?.layer as any
    out[s.id] = s.kind === 'text' ? (tl?.text ?? '') : s.kind === 'image' ? (tl?.filename ?? '') : (tl?.color ?? tl?.fill ?? '#000000')
  }
  return out
}
```

- [ ] **Step 4: The copy's slot-fill panel + Freeze.** When a placed copy's group is selected, show its slots (a text box / color chip / pick-image per slot) and a Freeze button:

```ts
import { setInstanceSlot, freezeInstance } from '~/lib/frametemplate/apply'
function fillSlot(inst: TemplateInstance, t: Template, slotId: string, value: string) {
  const r = setInstanceSlot(localLayers.value, t, inst, slotId, value)
  recordHistory(); commit(r.layers)
  commitInstances(instances().map(i => i.instanceId === inst.instanceId ? r.instance : i))
}
function freeze(inst: TemplateInstance) {
  commitInstances(freezeInstance(instances(), inst.instanceId)) // layers stay; card dropped
}
```

(Which group is a template copy: match a selected group's member layer ids against an instance's `placedKeys` values.)

- [ ] **Step 5: Runtime-verify manually.** `cd frontend && npm run dev` (own port if another server is up). In a Frame: build 2–3 layers, Save as template (mark the text as a slot), then place it, retype the slot, confirm the copy updates and undo works. Confirm reload keeps the copy (persistence via `sailor_frametemplates`).

- [ ] **Step 6: Commit.**
```bash
git add app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(templates): Compositor wiring — save as template, place, fill slots, freeze"
```

---

### Task 7: Templates gallery (Yours / Sailor) + sidebar door

**Files:**
- Create: `app/components/vue-canvas/TemplateLibraryPanel.vue`
- Modify: `app/layouts/default.vue` (un-stub the sidebar "Templates" entry ~line 152; mount the panel like the blocks panel ~line 4356–4368)

**Interfaces:**
- Consumes: `useTemplateLibrary`; emits a `place` event with the chosen `Template`, which the layout forwards to the open Compositor (via the existing `sailor:openCompositor` / a new `sailor:placeTemplate` CustomEvent that `CompositorModal.vue` listens for and routes to `placeTemplateIntoFrame`).

- [ ] **Step 1: Build `TemplateLibraryPanel.vue`.** Two sections — **Yours** (entries the store returned as owned) and **Sailor** (unowned/curated). v1: since ownership isn't distinguished client-side, show all under **Yours**, and render an empty **Sailor** section with a "coming soon" note (curated seeding is a later content task). Each card shows the template name + a thumbnail (render via `renderLayerThumbnail` from `useCompositorLayers`, or a stored preview later) and a Place button. Job-named, not tech-named.

- [ ] **Step 2: Un-stub the sidebar door.** In `app/layouts/default.vue` line ~152 replace the commented `// { label: 'Templates', icon: LayoutTemplate },` with a real entry `{ label: 'Templates', icon: LayoutTemplate, panel: 'templates' }`, and mount `<TemplateLibraryPanel>` in a `<Transition>` block mirroring the `blocks` panel (~4356–4368), toggled by a `templatesPanelOpen` ref.

- [ ] **Step 3: Wire Place → Compositor.** On a card's Place, dispatch `window.dispatchEvent(new CustomEvent('sailor:placeTemplate', { detail: { template } }))`. In `CompositorModal.vue`, add a listener that calls `placeTemplateIntoFrame(detail.template)` when a Frame is open (Task 6). If no Compositor is open, Place creates a new Frame node prefilled (v1: require an open Frame; show a hint otherwise).

- [ ] **Step 4: Runtime-verify.** Open the Templates door, see your saved template under Yours, Place it into an open Frame.

- [ ] **Step 5: Commit.**
```bash
git add app/components/vue-canvas/TemplateLibraryPanel.vue app/layouts/default.vue app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(templates): Templates gallery (Yours/Sailor) + sidebar door + place"
```

---

### Task 8: Per-project update prompt (restyle propagation)

**Files:**
- Modify: `app/components/vue-canvas/CompositorModal.vue` (detect + apply on open)

**Interfaces:**
- Consumes: `staleInstances`, `updateInstance` (Task 5); `useTemplateLibrary`.

- [ ] **Step 1: Detect on Frame open.** When the modal binds a Frame node, compute stale copies:

```ts
import { staleInstances, updateInstance } from '~/lib/frametemplate/apply'
const pendingUpdates = ref<{ instance: TemplateInstance; template: Template }[]>([])
function checkForTemplateUpdates() {
  pendingUpdates.value = staleInstances(instances(), (id) => templateLib.get(id) as any)
}
// call checkForTemplateUpdates() after the node binds + after templateLib.refresh() resolves
```

- [ ] **Step 2: Non-blocking prompt.** If `pendingUpdates.value.length`, show a small banner: "N copies use templates that changed — review updates?" with **Update all** / **Dismiss**. Incompatible (reshaped) copies are already excluded by `staleInstances`, so they are never offered.

- [ ] **Step 3: Apply.**

```ts
function applyTemplateUpdate(u: { instance: TemplateInstance; template: Template }) {
  const r = updateInstance({ layers: localLayers.value, groups: localGroups.value }, u.template, u.instance,
    { mkLayerId: mkId('ll'), mkGroupId: mkId('g') })
  recordHistory(); commitBoth(r.layers, r.groups)
  commitInstances(instances().map(i => i.instanceId === u.instance.instanceId ? r.instance : i))
}
function applyAllTemplateUpdates() { pendingUpdates.value.forEach(applyTemplateUpdate); pendingUpdates.value = [] }
```

- [ ] **Step 4: Runtime-verify.** Place a copy, edit + re-save the template (bump version via a fresh `snapshotFrameAsTemplate` that carries `version: prev.version + 1` — see note), reopen the project, accept the update, confirm locked parts changed and slot values survived; then reshape (add a slot), reopen, confirm that copy is NOT offered.

  > **Version bump note:** `snapshotFrameAsTemplate` always returns `version: 1`. Re-saving an existing template must bump: in `saveAsTemplate` (Task 6), when `templateLib.get(id)` exists, set `t.version = existing.version + 1` before `save`. Add this line in Task 6's Step 1 (or here) so updates are detectable.

- [ ] **Step 5: Commit.**
```bash
git add app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(templates): per-project restyle-update prompt (reshape-guarded)"
```

---

### Task 9: E2E — place, fill, restyle-update, reshape-skip, freeze (pixel-verified)

**Files:**
- Create: `tests/frame-templates.spec.ts`

**Interfaces:**
- Consumes: the whole feature through `/dev/frame-lab` (`window.__frameLab = { node, nodes, edges, save, reset }`) and the Compositor canvas `[data-testid="compositor-stack-canvas"]`.

- [ ] **Step 1: Study the two harness patterns.** Read `app/pages/dev/frame-lab.vue` (the `window.__frameLab` handle, the `[data-ready]` gate) and `tests/compositor-post-effects.spec.ts` (opening the modal via `sailor:openCompositor`, reading `compositor-stack-canvas` `toDataURL()`). Mirror the `PNG.sync` mean-diff + noise-floor/signal-floor structure from `tests/timeline-clip-edit.spec.ts`.

- [ ] **Step 2: Write the spec.** Drive the real feature (save a template from a fixture Frame, place it, fill a slot, restyle+update, reshape+skip, freeze). Assertions:
  - filling a text/color slot changes the composite pixels (mean diff over a signal floor);
  - a restyle update changes the locked pixels while the slot value survives (assert the slot layer's `text`/`fill` via `window.__frameLab.node.data.properties.sailor_localLayers`, and pixels differ);
  - a reshaped template leaves an existing copy untouched (no update offered — assert `sailor_frametemplates` version unchanged);
  - freeze drops the card (`sailor_frametemplates` shrinks) but leaves the layers (count unchanged).
  Use the same tolerant-diff helpers as `tests/timeline-clip-edit.spec.ts` (copy `pngOf` / `meanDiff`, `NOISE_CEIL`/`SIGNAL_FLOOR`).

- [ ] **Step 3: Run against a dev server.** `PW_BASE_URL=http://127.0.0.1:<port> npx playwright test tests/frame-templates.spec.ts --project=chromium`. Calibrate the floors from the printed diffs (log them like the timeline spec) and confirm real separation.

- [ ] **Step 4: Commit.**
```bash
git add tests/frame-templates.spec.ts
git commit -m "test(templates): E2E — place/fill/restyle-update/reshape-skip/freeze, pixel-verified"
```

---

### Task 10: Agent ops (place / set slot / freeze)

**Files:**
- Modify: `app/lib/agent/surfaces/compositor.ts` · `app/lib/agent/capabilities.ts` · `app/data/action-catalog.ts`
- Test: extend the compositor surface unit spec (`tests/unit/agent-capability-routing.unit.spec.ts` and/or a surface spec).

**Interfaces:**
- Produces agent ops `placeTemplate` / `setTemplateSlot` / `freezeTemplate`, routed so they target the recipe (the pure `apply.ts` functions), never raw layers, with inverse-command undo (a `restore` snapshot, matching the existing compositor command pattern).

- [ ] **Step 1: Register intents** in `capabilities.ts` / `action-catalog.ts` ("use my <name> template", "set the headline to …", "swap the photo", "freeze this") mirroring existing compositor intent registration.

- [ ] **Step 2: Add ops** to `COMPOSITOR_COMMANDS` + the `applyCompositorCommand` switch in `compositor.ts`, delegating to `placeTemplate` / `setInstanceSlot` / `freezeInstance`, and returning a `restore` inverse (snapshot the prior layers/instances). Write a unit test that the routing resolves the intent to the op and that undo restores.

- [ ] **Step 3: Run** the agent-routing unit spec — expect PASS.

- [ ] **Step 4: Commit.**
```bash
git add app/lib/agent/surfaces/compositor.ts app/lib/agent/capabilities.ts app/data/action-catalog.ts tests/unit/agent-capability-routing.unit.spec.ts
git commit -m "feat(templates): agent ops — place / set slot / freeze"
```

---

## Self-Review

**Spec coverage:** save-as-template (T6) · library across projects (T1) · one shelf/two sources — Yours + Sailor sections, Sailor curated = unowned rows, seeded later (T1 store supports it, T7 gallery) · point-at-the-parts slots (T2 addSlot + T6 UI) · place + fill text/color/image (T3, T4, T6) · restyle flows / reshape becomes new version (T5 slotCompatible + updateInstance, T8 prompt) · per-project ask (T8) · freeze = detach (T4, T6) · group-as-unit (T3 materializes a group) · plain-hex colors, no brand kit (T3 applySlotToLayer) · agent path (T10) · pixel-verified E2E (T9). All spec sections map to a task.

**Placeholder scan:** no "TBD"/"handle edge cases"; each code step carries real code. The only deferred content is Sailor-curated seeding (explicitly a later content task, spec-sanctioned) and the exact slot-marking micro-UI in T6 (described concretely: per-selected-layer slot toggle + kind/label), verified by T9.

**Type consistency:** `Template`, `SlotMark`, `TemplateLayer`, `TemplateInstance`, `PlaceCtx`, `snapshotFrameAsTemplate`, `addSlot`/`removeSlot`, `placeTemplate`, `applySlotToLayer`, `setInstanceSlot`, `freezeInstance`, `slotCompatible`, `staleInstances`, `updateInstance` are used with identical names/signatures across T2–T10. Node property `sailor_frametemplates`, store `frame-templates`, kind `'frame-template'`, composable `useTemplateLibrary` are consistent throughout. The one cross-task contract to watch: `snapshotFrameAsTemplate` returns `version: 1`, so re-save MUST bump the version (called out in T8 Step 4's note and to be applied in T6's `saveAsTemplate`).

## Open items resolved during planning

- **Persistence:** Sailor's owner-scoped JSON store (Option 1), works local + hosted; curated Sailor templates ride the same store as unowned rows. **Decided.**
- **Template unit = a group** (bundle of layers): `placeTemplate` materializes a group, droppable into an empty Frame (standalone) or a populated one (overlay). **Decided.**
- **Brand kit:** no coupling; colors are plain hex. **Decided.**
