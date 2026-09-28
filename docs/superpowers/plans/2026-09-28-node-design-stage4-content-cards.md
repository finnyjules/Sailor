# Node design, stage 4 (content cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every content card on the canvas — Image, Video, Audio, Text (including the result cards generators make), 3D model, Character, Reference, Collection, and the Batch, Sketch and Moodboard piles — becomes "the content is the card": the name quiet above it, the content in one rounded box with a faint inner edge and a soft shadow, and its actions floating top-right on hover (Download plus a More menu), instead of today's bordered frames, header rows and hover strips.

**Architecture:** One shared card, `surfaces/ContentCard.vue` (built in stage 1, unused until now), is extended with the slots real cards need and wraps each card's existing media. Ports move to the shared `NodePort` as siblings of the card inside a `relative w-fit` wrapper (the pattern every studio and Moodboard already use). Running, failed and selected are drawn on the media box by shared CSS; muted/bypassed/locked stay in each card's scoped CSS, re-pointed at the media box. The piles keep their tilted `PileStack` (a clipping media box would cut the tilt) and only gain the shared name row.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TS, Tailwind v4 (`node-surfaces.css` is unlayered and beats utilities), `@vue-flow/core`, Vitest + @vue/test-utils (happy-dom), Playwright on the shared `:3002`.

**Spec:** `docs/superpowers/specs/2026-09-27-node-design-design.md` — "Rules every node follows" (ports, type, header) and **"Content card"**: *the content is the card: 12px corners, no border (a faint inner edge only), a soft shadow; name above the card (the file name, or the card's own text), quiet at rest, brighter on hover; hover actions (download, more) float in the top-right corner on small dark-glass buttons; Collection shows a grid of its items; Moodboard and the piles show a loose stack with a count; Character shows the portrait; 3D model stays orbitable.*

## Global Constraints

- **Do not change** selection, running or failed looks, wires, or the Note node. The selection outline keeps its look (2px `var(--action)`, 3px offset) and moves onto the media box (Task 1). Running keeps its 2px `--port-color` ring; failed keeps its red 2px ring — both drawn on the media box by shared CSS. Muted (45% + grayscale), bypassed (85% + dashed amber edge) and Image's locked (amber edge) keep their looks.
- **Do not change logic.** Every handler keeps its name and body: uploads, drops, downloads, `runThisNode`, locking, takes, the light table, text editing, the 3D viewer and orbit, the character picker, reference picking, collection scrubbing, pile clicks, `syncMoodboardWidgets`. A button that moves from a hover strip or header into the floating actions or the More menu calls the **same function** it called before. Script edits are limited to: the `selected` prop where missing, imports, and the small display computeds a task names.
- **Pinned by tests — keep:** Audio's `(props.data as any).audioSeconds = { file: widgetFilename.value, seconds }` line; an empty Audio/Video card is still a click target that selects the node on a centre click (node-toolbar and start-modal specs); TakesStrip's active tile keeps `ring-action` on the parent of the take `img` (prompt-results spec); Moodboard's pile renders `img`s and its port `output-0` keeps a box; Reference keeps a button named **"Pick a reference…"** and buttons named **"@<name>"**, and its thumbnail `img`; Smart Layout / studios untouched.
- **Port ids never change** (`input-N`, `output-N`, Image's `output-${maskOutIdx}`) — saved wires reference them.
- **The card:** `ContentCard` root `.content-card`; media `.content-card__media` (12px corners, `#1a1a1c`, `var(--node-shadow)`, inner edge `rgba(255,255,255,.06)` via `::after`). No Tailwind `border-*`, `ring-*`, `rounded-*`, `shadow-*` or `bg-*` on the media box (unlayered CSS wins). Name row 12px, `rgba(255,255,255,.4)` at rest, `.6` on hover/selected.
- **Floating actions:** Download (where the card had one) as its own button, then `NodeMoreMenu` holding the rest, in this order where they exist: Replace, Lock/Unlock, Re-render, then card-specific items. Buttons 26×26, 6px corners, `rgba(20,20,20,.72)` — **no backdrop blur** (they ride on media during pans; a blur per card per frame is the cost stage 2's pan work removed). They take no clicks while hidden.
- UI copy: sentence case, no identifiers, no new explanatory small text (a hint becomes a `title` tooltip).
- **Shared checkout:** implementers never commit, never touch the git index, never run `npm run dev`, never restart `:3002`. `VueNodeCanvas.vue` is edited by other sessions — touch only the selection rule a task names, and report exact lines.
- Never add `will-change`, `translateZ`, forced layer promotion, or any new `backdrop-filter`.

---

## File map

| File | Change | Task |
|---|---|---|
| `frontend/app/components/vue-canvas/surfaces/ContentCard.vue` | `name` slot override + `meta` slot (right side of the name row), `below` slot (after the media), actions moved outside the clipping media box; fallthrough attrs land on the root. | 1 |
| `frontend/app/components/vue-canvas/surfaces/NodeMoreMenu.vue` | New: the "More" button + its menu. | 1 |
| `frontend/app/assets/css/node-surfaces.css` | Actions position/clicks/z-order; running/failed rings on the media box. | 1 |
| `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (the artifact selection rule, ~9158) | Add `.vue-flow__node.selected .content-card__media`; Tasks 2–4 remove their card's root selector from the old list. | 1–4 |
| `ArtifactImageNode.vue` | Content card; hover strip → Download + More; ports → NodePort. | 2 |
| `ArtifactVideoNode.vue`, `ArtifactAudioNode.vue` | Same. | 3 |
| `ArtifactTextNode.vue` | Content card; name = its own text; footer kept quiet inside the box. | 4 |
| `Artifact3DNode.vue` | Content card; header row → actions; viewer stays orbitable. | 5 |
| `CharacterNode.vue`, `ReferenceNode.vue` | Content card; Character is its portrait; Reference is its picture. | 6 |
| `CollectionNode.vue` | Content card; a grid of its first rows. | 7 |
| `BatchGridNode.vue`, `SketchPileNode.vue`, `MoodboardNode.vue` | The shared name row above the pile. | 8 |
| Tests | `tests/unit/content-card.unit.spec.ts` (new; grows per task), `tests/unit/node-more-menu.unit.spec.ts` (new), `tests/unit/node-surfaces.unit.spec.ts` (extend), `tests/content-cards.spec.ts` (new Playwright, Task 9). | 1–9 |

## Shared test helper (used by Tasks 2–8)

`tests/unit/content-card.unit.spec.ts` is created in Task 1; later tasks append to it and reuse:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const src = (f: string) => readFileSync(resolve(__dirname, '../../app/components/vue-canvas', f), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'))
```

---

### Task 1: Shared pieces — ContentCard slots, NodeMoreMenu, card CSS, the selection rule

**Files:**
- Modify: `frontend/app/components/vue-canvas/surfaces/ContentCard.vue`
- Create: `frontend/app/components/vue-canvas/surfaces/NodeMoreMenu.vue`
- Modify: `frontend/app/assets/css/node-surfaces.css` (the content-card block)
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (the `.artifact-*` selection rule only)
- Test: `frontend/tests/unit/content-card.unit.spec.ts` (new), `frontend/tests/unit/node-more-menu.unit.spec.ts` (new), `frontend/tests/unit/node-surfaces.unit.spec.ts` (keep its ContentCard cases green)

**Interfaces:**
- Produces `ContentCard` props `{ name: string; selected?: boolean }` (unchanged), slots: `icon`, `meta` (right end of the name row), default (inside `.content-card__media`), `actions` (floating, top-right of the media box), `below` (after the media box). Non-prop attributes (`class`, `style`, `data-running`, `data-error`, handlers) fall through to the `.content-card` root.
- Produces `NodeMoreMenu` props `{ items: MoreItem[] }` where `export interface MoreItem { label: string; onSelect: () => void; disabled?: boolean }` (exported from the component file via a `<script lang="ts">` block).

- [ ] **Step 1: Write the failing tests**

`frontend/tests/unit/content-card.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { h } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'

enableAutoUnmount(afterEach)
const src = (f: string) => readFileSync(resolve(__dirname, '../../app/components/vue-canvas', f), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'))
const CSS = readFileSync(resolve(__dirname, '../../app/assets/css/node-surfaces.css'), 'utf8')

describe('ContentCard', () => {
  it('name above, media box, meta at the name row end, below after the box', () => {
    const w = mount(ContentCard, {
      props: { name: 'beach-dog.jpg' },
      slots: { default: () => h('img'), meta: () => h('span', { class: 'm' }, '1024 × 768'), below: () => h('div', { class: 'b' }) },
    })
    expect(w.find('.content-card__name').text()).toContain('beach-dog.jpg')
    expect(w.find('.content-card__name .m').exists()).toBe(true)
    expect(w.find('.content-card__media img').exists()).toBe(true)
    const kids = [...w.element.children].map(c => c.className)
    expect(kids.findIndex(c => String(c).includes('content-card__media'))).toBeLessThan(kids.findIndex(c => String(c).includes('b')))
  })
  it('floating actions sit outside the clipping media box', () => {
    const w = mount(ContentCard, { props: { name: 'x' }, slots: { default: () => h('img'), actions: () => h('button') } })
    expect(w.find('.content-card__media .node-float-actions').exists()).toBe(false)
    expect(w.find('.content-card > .node-float-actions').exists()).toBe(true)
  })
  it('state attributes land on the root', () => {
    const w = mount(ContentCard, { props: { name: 'x', selected: true }, attrs: { 'data-running': 'true', 'data-error': 'true', class: 'artifact-image' } })
    expect(w.attributes('data-running')).toBe('true')
    expect(w.attributes('data-error')).toBe('true')
    expect(w.attributes('data-selected')).toBe('true')
    expect(w.classes()).toContain('artifact-image')
  })
})

describe('content card CSS', () => {
  const rule = (sel: string) => { const i = CSS.indexOf(`${sel} {`); return i < 0 ? '' : CSS.slice(i, CSS.indexOf('}', i)) }
  it('hidden actions take no clicks and sit above the media overlays', () => {
    expect(rule('.node-float-actions')).toMatch(/pointer-events: none/)
    expect(rule('.node-float-actions')).toMatch(/z-index: 45/)
    expect(rule('.node-float-actions')).toMatch(/top: 30px/)
  })
  it('running and failed are rings on the media box', () => {
    expect(CSS).toMatch(/\.content-card\[data-running\] \.content-card__media \{ box-shadow: 0 0 0 2px var\(--port-color, #fff\), var\(--node-shadow\); \}/)
    expect(CSS).toMatch(/\.content-card\[data-error\] \.content-card__media \{ box-shadow: 0 0 0 2px #ef4444, var\(--node-shadow\); \}/)
  })
  it('floating buttons have no backdrop blur', () => {
    const i = CSS.indexOf('/* ---------- content card')
    const block = CSS.slice(i, CSS.indexOf('/* ---------- print surface'))
    expect(block).not.toMatch(/backdrop-filter/)
  })
})

describe('the canvas selection outline sits on the media box', () => {
  const canvas = src('VueNodeCanvas.vue')
  it('has a rule for .content-card__media', () => {
    expect(canvas).toMatch(/\.vue-node-canvas \.vue-flow__node\.selected \.content-card__media \{\s*outline: 2px solid var\(--action\);\s*outline-offset: 3px;\s*\}/)
  })
})
```

`frontend/tests/unit/node-more-menu.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import NodeMoreMenu from '~/components/vue-canvas/surfaces/NodeMoreMenu.vue'

enableAutoUnmount(afterEach)

describe('NodeMoreMenu', () => {
  it('opens a menu of its items and runs the picked one', async () => {
    const a = vi.fn(); const b = vi.fn()
    const w = mount(NodeMoreMenu, { props: { items: [{ label: 'Replace', onSelect: a }, { label: 'Lock', onSelect: b, disabled: true }] } })
    expect(w.find('[role="menu"]').exists()).toBe(false)
    await w.find('button[aria-label="More"]').trigger('click')
    const items = w.findAll('[role="menuitem"]')
    expect(items.map(i => i.text())).toEqual(['Replace', 'Lock'])
    await items[1]!.trigger('click')
    expect(b).not.toHaveBeenCalled()
    await items[0]!.trigger('click')
    expect(a).toHaveBeenCalledOnce()
    expect(w.find('[role="menu"]').exists()).toBe(false)
  })
  it('closes on a pointerdown outside', async () => {
    const w = mount(NodeMoreMenu, { props: { items: [{ label: 'Replace', onSelect: () => {} }] }, attachTo: document.body })
    await w.find('button[aria-label="More"]').trigger('click')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.find('[role="menu"]').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/content-card.unit.spec.ts tests/unit/node-more-menu.unit.spec.ts tests/unit/node-surfaces.unit.spec.ts`
Expected: the new specs FAIL; node-surfaces stays green.

- [ ] **Step 3: Implement**

`ContentCard.vue`:

```vue
<script setup lang="ts">
defineProps<{ name: string; selected?: boolean }>()
</script>

<template>
  <div class="content-card" :data-selected="selected || undefined">
    <div class="content-card__name">
      <slot name="icon" />
      <span class="truncate flex-1 min-w-0">{{ name }}</span>
      <slot name="meta" />
    </div>
    <div class="content-card__media">
      <slot />
    </div>
    <!-- Outside the media box: it clips, and the More menu must open past it. -->
    <div v-if="$slots.actions" class="node-float-actions nopan nodrag"><slot name="actions" /></div>
    <slot name="below" />
  </div>
</template>
```

`NodeMoreMenu.vue`:

```vue
<script lang="ts">
export interface MoreItem { label: string; onSelect: () => void; disabled?: boolean }
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { MoreHorizontal } from 'lucide-vue-next'

defineProps<{ items: MoreItem[] }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
function onOutside(e: Event) {
  if (open.value && !root.value?.contains(e.target as Node)) open.value = false
}
function pick(item: MoreItem) {
  if (item.disabled) return
  open.value = false
  item.onSelect()
}
onMounted(() => window.addEventListener('pointerdown', onOutside, true))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="root" class="relative">
    <button type="button" class="node-float-btn" aria-label="More" title="More" @click.stop="open = !open">
      <MoreHorizontal class="size-3.5" />
    </button>
    <div
      v-if="open"
      role="menu"
      class="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl"
    >
      <button
        v-for="item in items" :key="item.label"
        type="button" role="menuitem"
        :disabled="item.disabled"
        class="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        @click.stop="pick(item)"
      >{{ item.label }}</button>
    </div>
  </div>
</template>
```

`node-surfaces.css` — in the content-card block:
- `.content-card__name`: add `justify-content: flex-start;` is not needed; keep as is (the name span is `flex-1`, the meta slot sits at the end).
- Replace the `.node-float-actions` rule and its reveal rule with:

```css
/* The name row is 22px, so the actions sit 8px inside the media box's top-right corner.
   They live outside the (clipping) media box so the More menu can open past it; above
   every media overlay (Image's badges are z-40), below the ready badge (z-50). */
.node-float-actions {
  position: absolute;
  top: 30px;
  right: 8px;
  z-index: 45;
  display: flex;
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}
.content-card:hover .node-float-actions,
.content-card:focus-within .node-float-actions,
.content-card[data-selected] .node-float-actions { opacity: 1; pointer-events: auto; }
```

- Replace `.node-float-actions > button { … }` with the same declarations under `.node-float-actions > button, .node-float-btn { … }`.
- Add, after `.content-card__media::after`:

```css
/* Running and failed: the rings the old frames had, drawn on the media box. */
.content-card[data-running] .content-card__media { box-shadow: 0 0 0 2px var(--port-color, #fff), var(--node-shadow); }
.content-card[data-error] .content-card__media { box-shadow: 0 0 0 2px #ef4444, var(--node-shadow); }
```

`VueNodeCanvas.vue` — directly after the existing `.artifact-image, … .artifact-timeline` selection rule add:

```css
/* Content cards (stage 4): the outline sits on the content itself, not on the name above it. */
.vue-node-canvas .vue-flow__node.selected .content-card__media {
  outline: 2px solid var(--action);
  outline-offset: 3px;
}
```

(Leave the old rule's selectors alone in this task — each later task removes its own card's selector as it converts.)

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** (controller; `VueNodeCanvas.vue` by hunk)

```bash
git commit -m "feat(cards): the content card gets its name meta, a below slot and floating actions outside its box; a More menu; running, failed and selected drawn on the content"
```

---

### Task 2: Image card

**Files:**
- Modify: `frontend/app/components/vue-canvas/ArtifactImageNode.vue` (template, scoped style; script: `NodePort`/`ContentCard`/`NodeMoreMenu` imports, a `moreItems` computed, drop the `Handle, Position` import if unused)
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (remove `.vue-node-canvas .vue-flow__node.selected .artifact-image,` from the old selection rule — one line)
- Test: `frontend/tests/unit/content-card.unit.spec.ts` (extend)

**Interfaces:**
- Consumes Task 1: `ContentCard` (slots `icon`, `meta`, default, `actions`, `below`), `NodeMoreMenu` + `MoreItem`, the `.content-card[data-running|data-error]` rings, the media-box selection rule.

Target structure (every inner block keeps its existing markup, attributes, `v-if`s and handlers unless listed):

```vue
<template>
  <div class="relative w-fit">
    <VueCanvasNodePort v-if="imagesInIdx >= 0" :id="`input-${imagesInIdx}`" type="target" side="left"
      :data-type="data.inputs?.[imagesInIdx]?.type ?? 'IMAGE'" label="Image" :index="0" />
    <VueCanvasNodePort :id="`output-${imageOutIdx}`" type="source" side="right"
      :data-type="data.outputs?.[imageOutIdx]?.type ?? 'IMAGE'" label="Image" :index="0" />
    <VueCanvasNodePort v-if="maskOutIdx >= 0" :id="`output-${maskOutIdx}`" type="source" side="right"
      :data-type="data.outputs?.[maskOutIdx]?.type ?? 'MASK'" label="Mask" :index="1" />

    <ContentCard
      ref="rootEl"
      class="artifact-image relative z-10 w-[240px] select-none"
      :class="{ 'artifact-image--muted': isMuted, 'artifact-image--bypassed': isBypassed, 'artifact-image--locked': isLocked }"
      :name="filenameLabel || 'Image'"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :style="{ '--port-color': imageColor } as any"
      @mouseenter="hovered = true" @mouseleave="hovered = false"
      @dragover="onDragOver" @drop="onDrop"
    >
      <template #meta><span v-if="dims" class="shrink-0 tabular-nums text-white/30">{{ dims }}</span></template>
      <!-- media: the existing stage (img-fx, sweep, scan overlay, file input, Inpaint corner button,
           Locked + fixes badges, the <img>, loading / upload / render states), unchanged,
           with the ready badge first -->
      <template #actions>
        <button v-if="displayedUrl" type="button" title="Download" @click.stop="downloadImage"><Download class="size-3.5" /></button>
        <NodeMoreMenu :items="moreItems" />
      </template>
      <template #below>
        <!-- existing NodeRunRow (slim) with its v-if, then the existing TakesStrip with its v-if,
             its class becoming "mt-1.5" -->
      </template>
    </ContentCard>
    <!-- existing LightTableModal, teleported text-edit panel, RefNameDialog: unchanged, outside the card -->
  </div>
</template>
```

`moreItems` (script) — the removed hover strip's buttons, same functions, same conditions:

```ts
const moreItems = computed<MoreItem[]>(() => [
  ...(canReplace.value ? [{ label: 'Replace image', onSelect: triggerUpload }] : []),
  { label: isLocked.value ? 'Unlock' : 'Lock', onSelect: () => (isLocked.value ? unlockArtifact() : lockArtifact()) },
  { label: data.value?.running ? 'Running…' : 'Re-render', onSelect: runThisNode, disabled: !!props.data.running || !canRun.value },
  { label: 'Save as character', onSelect: saveAsCharacter },
  { label: 'Name as reference', onSelect: openRefDialog },
])
```

(Use the file's real names for `canReplace`, `isLocked`, `canRun`/the re-render guard and `props.data` — copy the conditions the old strip's buttons used, including each button's `:disabled`. If the file has no `canRun`, use exactly the old Re-render button's `:disabled` expression.)

Removed: the `.artifact-frame` wrapper (its classes, its `ring-2 ring-red-500`), the hover strip and its dims label (dims move to `#meta`), the raw `<Handle>`s and the small mask label row (the mask output becomes the third NodePort). The `hovered` ref stays (the badges still move with it). `menuStyleFor()`'s `closest('.artifact-image')` still finds the card root.

Scoped CSS: re-point `.artifact-frame` rules at `.content-card__media` under the root class — keep muted/bypassed/locked looks exactly:

```css
.artifact-image--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-image--bypassed { opacity: 0.85; }
.artifact-image--bypassed :deep(.content-card__media) { outline: 1px dashed rgba(251, 191, 36, 0.35); outline-offset: -1px; }
.artifact-image--locked :deep(.content-card__media) { box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.45), var(--node-shadow); }
```

(copy the real amber values from the old rules; delete the old `.artifact-frame` shadow and running rules — Task 1's shared CSS draws running and failed.)

- [ ] **Step 1: Extend the failing test** (append to `content-card.unit.spec.ts`):

```ts
describe('Image card is a content card', () => {
  const s = src('ArtifactImageNode.vue')
  const t = tpl(s)
  it('wraps its media in ContentCard inside a port wrapper', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">/)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="artifact-image relative z-10 w-\[240px\] select-none"/)
    expect(t).toMatch(/:name="filenameLabel \|\| 'Image'"/)
    expect(t).toMatch(/:data-error="data\.error \|\| undefined"/)
  })
  it('uses the shared ports with unchanged ids, including the mask', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/:id="`output-\$\{imageOutIdx\}`"/)
    expect(t).toMatch(/:id="`output-\$\{maskOutIdx\}`"/)
  })
  it('the hover strip became Download + More; no frame border', () => {
    expect(t).toMatch(/#actions[\s\S]*title="Download"[\s\S]*<NodeMoreMenu :items="moreItems" \/>/)
    expect(s).toMatch(/label: 'Save as character', onSelect: saveAsCharacter/)
    expect(t).not.toMatch(/artifact-frame/)
    expect(t).not.toMatch(/ring-2 ring-red-500/)
  })
  it('takes strip still below the card', () => {
    expect(t).toMatch(/#below[\s\S]*<TakesStrip/)
  })
})
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run tests/unit/content-card.unit.spec.ts` — Image cases FAIL.
- [ ] **Step 3: Implement** as above; remove `.vue-node-canvas .vue-flow__node.selected .artifact-image,` from the old rule in `VueNodeCanvas.vue`.
- [ ] **Step 4: Run** the unit command (PASS), then `cd frontend && npx playwright test tests/prompt-results.spec.ts tests/node-toolbar.spec.ts --project=chromium` (PASS — takes ring, takes-target class, toolbar).
- [ ] **Step 5: Commit** (controller) `feat(cards): the Image card is a content card — name above, Download and More on hover, shared ports`

---

### Task 3: Video and Audio cards

**Files:** `ArtifactVideoNode.vue`, `ArtifactAudioNode.vue` (template, scoped style, imports, one `moreItems` computed each); `VueNodeCanvas.vue` (remove the `.artifact-video,` and `.artifact-audio,` selectors from the old rule); test `content-card.unit.spec.ts`.

**Interfaces:** as Task 2.

Per card (same shape as Task 2's target):
- Wrapper `relative w-fit` with NodePort input (`input-${sourceInputIdx}`, `v-if` as today — Video/Audio input exists only when the index is ≥ 0; if today's Handle had no `v-if`, add `v-if="sourceInputIdx >= 0"` only if the index can be -1 — check) and output (`output-${videoOutputIdx}` / `output-${audioOutputIdx}`), data types from `data.inputs/outputs` with fallbacks `VIDEO` / `AUDIO`.
- `<ContentCard class="artifact-video relative z-10 w-[280px] select-none" …>` (Audio: `artifact-audio … w-[280px]`), `:name` = the file name the card already computes for downloads (`widgetFilename` or the download name — whichever the file has) `|| 'Video'` / `'Audio'`, `:selected="selected"`, `:data-running`, `:data-error`, `--port-color`, the existing drag/drop handlers on the card.
- `#meta`: the existing `meta` string (`W × H · M:SS` / `M:SS`) when set.
- Media: Video — the existing `<video … controls …>` and the upload/render states; Audio — the existing waveform icon + `<audio … controls …>` row (keep `nopan nodrag`) and the upload/render states. The upload state stays a button filling the media box (centre-click select is pinned).
- `#actions`: Download (when there is a file) → `downloadVideo` / `downloadAudio`; `NodeMoreMenu` with Replace (`canReplace` → `triggerUpload`), Re-render (Video: `runThisNode`, same disabled rule; Audio: only if the file had one).
- `#below`: the existing slim NodeRunRow with its `v-if`.
- Removed: `.artifact-frame` wrapper, Video's hover strip, Audio's persistent footer row (its meta → `#meta`, its buttons → actions), raw Handles.
- Scoped CSS: muted/bypassed re-pointed as in Task 2; Audio keeps its `audio::-webkit-media-controls-panel` rule.
- Audio's `audioSeconds` line stays byte-for-byte.

- [ ] **Step 1: Extend the failing test:**

```ts
describe.each([
  ['ArtifactVideoNode.vue', 'artifact-video', 'w-\\[280px\\]', 'downloadVideo'],
  ['ArtifactAudioNode.vue', 'artifact-audio', 'w-\\[280px\\]', 'downloadAudio'],
])('%s is a content card', (file, cls, width, dl) => {
  const t = tpl(src(file))
  it('ContentCard in a port wrapper, shared ports, no frame', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">/)
    expect(t).toMatch(new RegExp(`<ContentCard[\\s\\S]{0,200}class="${cls} relative z-10 ${width} select-none"`))
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).not.toMatch(/artifact-frame/)
  })
  it('Download + More on hover', () => {
    expect(t).toMatch(new RegExp(`#actions[\\s\\S]*${dl}[\\s\\S]*<NodeMoreMenu`))
  })
})
it('Audio keeps its seconds line', () => {
  expect(src('ArtifactAudioNode.vue')).toContain('(props.data as any).audioSeconds = { file: widgetFilename.value, seconds }')
})
```

- [ ] **Step 2–4:** run (FAIL), implement, run unit (PASS) and `cd frontend && npx playwright test tests/node-toolbar.spec.ts tests/start-modal.spec.ts --project=chromium` (PASS — centre-click selects an empty Audio/Video card).
- [ ] **Step 5: Commit** `feat(cards): Video and Audio are content cards`

---

### Task 4: Text card

**Files:** `ArtifactTextNode.vue` (template, scoped style, imports, one `cardName` computed); `VueNodeCanvas.vue` (remove `.artifact-text,` from the old rule); test.

- Wrapper + NodePorts (`input-${sourceInputIdx}` / `output-${textOutputIdx}`, fallback type `STRING`).
- `<ContentCard class="artifact-text relative z-10 w-[300px] select-none" … :data-node-id="id">`, `:name="cardName"` where

```ts
/** The card's own words: the first line of what it shows, or "Text" when empty. */
const cardName = computed(() => (activeText.value || '').split('\n').find(l => l.trim())?.trim().slice(0, 60) || 'Text')
```

(use the file's real computed for the displayed text — `activeText` per the survey).
- `#meta`: `{{ n }} chars` (and `· {{ entries }} entries` when ≥ 2) — the old footer's counts.
- Media: the existing entry list and "Add entry" button, unchanged; then the old footer's **run controls only** (`×N` → `runAllEntries`, Run → `runThisNode`) as a quiet row at the bottom of the media box (`flex items-center justify-end gap-1 px-2 pb-2`), same titles/disabled rules. Text keeps its own weight (the entries are the user's words): add `font-normal` to the textarea class list.
- `#actions`: Download (`downloadText`, title "Download active entry as .txt"); no More menu (nothing else to hold).
- Fix the dead focus selector while here? **No** — logic unchanged (ledger it as a known bug).
- Removed: `.artifact-frame`, the footer row (counts → `#meta`, Download → actions, run buttons → media bottom row), raw Handles.

Tests (append):

```ts
describe('Text card is a content card', () => {
  const s = src('ArtifactTextNode.vue'); const t = tpl(s)
  it('named by its own words, content card, shared ports', () => {
    expect(s).toMatch(/const cardName = computed\(/)
    expect(t).toMatch(/:name="cardName"/)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="artifact-text relative z-10 w-\[300px\] select-none"/)
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).not.toMatch(/artifact-frame/)
  })
  it('keeps run controls and the user text weight', () => {
    expect(t).toMatch(/runAllEntries/)
    expect(t).toMatch(/runThisNode/)
    expect(t).toMatch(/textarea[\s\S]{0,300}font-normal/)
  })
})
```

Run unit; browser check: `cd frontend && npx playwright test tests/prompt-results.spec.ts --project=chromium` (it adds Text nodes). Commit `feat(cards): the Text card is a content card named by its own words`.

---

### Task 5: 3D model card

**Files:** `Artifact3DNode.vue` (template, scoped style, imports); test.

- Wrapper + NodePorts (`input-${glbInIdx}` / `output-${glbOutIdx}` — today always rendered; keep that), fallback type `STRING`.
- `<ContentCard class="artifact-3d relative z-10 w-[300px] select-none" :class="{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed }" :name="data.title || '3D model'" :selected="selected" :data-running :data-error --port-color @pointerenter="on3DHoverEnter" @pointerleave="on3DHoverLeave">`.
- Media: the existing viewer block (`relative bg-[#141414]` with its inline 300×300, the `nopan nodrag` stage, empty overlay, spinner, error strip) unchanged — drop only its `bg-[#141414]` (the media box fills).
- `#actions`: "Reset view" (`resetView`, keep its icon) and "Download .glb" (`downloadGlb`).
- Removed: the bordered card div and its error ring, the header row, raw Handles; the scoped `[data-running] > div` rule (shared CSS draws it).
- Add `selected?: boolean` to props if missing.

Tests: ContentCard class/width, `:name="data.title || '3D model'"`, no `<Handle`, `#actions` contains `resetView` and `downloadGlb`, the stage keeps `nopan nodrag`. Commit `feat(cards): the 3D model card is a content card, still orbitable`.

---

### Task 6: Character and Reference cards

**Files:** `CharacterNode.vue`, `ReferenceNode.vue` (templates, imports, `selected` prop); test.

**Character** — the portrait is the card:
- Wrapper + `<VueCanvasNodePort id="output-0" type="source" side="right" :data-type="data.outputs?.[0]?.type ?? 'CHARACTER'" label="Character" :index="0" />`.
- `<ContentCard class="character-card relative z-10 w-[220px]" :name="character?.name || 'Character'" :selected="selected">` (use the file's real character name expression).
- Media: `aspect-[3/4]` box with the portrait `img` (`portraitUrl ?? coverUrl`, `object-cover w-full h-full`) or, with no character, a centred `node-btn` "Pick character" (`@click.stop="pickerOpen = true"`); deleted/none messages centred inside the media box as today's text.
- `#meta`: "N identity sources" (today's count text, shortened to the number + "sources").
- `#actions`: a "Change character" button (`title`, icon `Replace`/`UserRound`) → `pickerOpen = true` when a character is set.
- `#below`: the look `<select>` (only when more than one look; keep `@change="onLookChange"`, restyle as `nopan nodrag mt-1.5 w-full h-8 rounded-md bg-white/[0.03] px-2 text-[12px] text-white/80`) and the amber "No reference photos…" warning (text unchanged).
- The `CharacterPickerModal` stays.

**Reference** — its picture is the card:
- Wrapper + `<VueCanvasNodePort id="output-0" … :data-type="data.outputs?.[0]?.type ?? 'IMAGE'" label="Reference" :index="0" />`.
- `<ContentCard class="reference-card relative z-10 w-[200px]" :name="refName ? '@' + refName : 'Reference'" :selected="selected">` (real name expression from the file).
- Media: the thumbnail `img` (`/view?filename=…&type=input`, keep the exact `src` expression, class `block w-full aspect-square object-cover`) or, with nothing picked, a centred `node-btn` whose text is exactly **"Pick a reference…"** toggling `picking`.
- `#actions`: when a reference is picked, a button titled "Change reference" toggling `picking`.
- `#below`: the existing inline list of `@name` buttons (`v-if="picking"`, button text exactly `@{{ n }}`) or "No references yet".

Tests: both use ContentCard + NodePort, no `<Handle`, Character media `aspect-[3/4]`, Reference keeps the literal `Pick a reference…` and `@{{`. Browser check: `cd frontend && npx playwright test tests/moodboard-wires.spec.ts --project=chromium` (pins Reference). Commit `feat(cards): Character is its portrait and Reference its picture`.

---

### Task 7: Collection — a grid of its items

**Files:** `CollectionNode.vue` (template, imports, `selected` prop exists, one `tiles` computed); test.

- Wrapper + NodePorts: `input-0` (fallback `COLLECTION`) and `output-0` (fallback `COLLECTION`) — types from `data.inputs/outputs` when present. (Fixes today's invisible output dot.)
- `<ContentCard class="collection-card relative z-10 w-[240px]" :name="collection.name" :selected="selected">`, `#meta`: "{{ rows }} rows".
- Media: a 3×2 grid (`grid grid-cols-3 gap-px bg-white/[0.04]`) of the first six rows, each tile `aspect-square` showing, by the row's first column of each kind: an `image` column's picture, else a `color` column's swatch, else the row's label (`rowLabel`) in 11px text. The previewed row (`collection.previewRow`) tile gets `outline outline-2 outline-white/60 -outline-offset-2`. Empty: centred "No rows".

```ts
/** First six rows as tiles: a picture if the row has one, else a colour, else its label. */
const tiles = computed(() => {
  const c = collection.value
  const img = c.columns.find(col => col.type === 'image')
  const color = c.columns.find(col => col.type === 'color')
  return c.rows.slice(0, 6).map((row, i) => ({
    key: row.id,
    index: i,
    image: img && row.values[img.key] ? imageUrl(String(row.values[img.key])) : null,
    color: color && row.values[color.key] ? String(row.values[color.key]) : null,
    label: rowLabel(c, i),
  }))
})
```

`imageUrl` must be the app's existing way to turn an image cell into a URL — find how the Collection table view or Smart Layout renders an `image` cell (`grep -rn "type === 'image'" app/components app/lib/collection`) and reuse that function; do not invent a URL format. If no helper exists, use `/view?filename=${encodeURIComponent(v)}&type=input` and say so in the report.
- `#below`: the existing scrub row (‹ `step(-1)` / preview label / › `step(1)`), restyled `nopan nodrag mt-1.5 flex items-center gap-1 text-[12px] text-white/55`.
- `#actions`: "Open table" (`openTable`, icon `Table2`, title "Open table").
- Double-click on the media opens the table (`@dblclick.stop="openTable"` on the grid).

Tests: ContentCard + NodePort ids `input-0`/`output-0`, `tiles` computed, grid classes, scrub row keeps `step(-1)`/`step(1)`, `openTable` in actions. Commit `feat(cards): Collection shows a grid of its rows`.

---

### Task 8: The piles — Batch, Sketch, Moodboard — get the name row

**Files:** `BatchGridNode.vue`, `SketchPileNode.vue`, `MoodboardNode.vue` (templates only); test.

The pile (`PileStack`) keeps its tilt, count, rail and selected ring; a clipping media box would cut the tilt, so the piles use only the **name row** markup (no `ContentCard`):

```vue
<div class="content-card" :data-selected="selected || undefined">
  <div class="content-card__name"><span class="truncate flex-1 min-w-0">{{ … }}</span></div>
  <!-- existing PileStack (+ rail slot) unchanged -->
</div>
```

- Batch: name `Batch` + `#meta`-equivalent `<span class="shrink-0 tabular-nums text-white/30">{{ items.length }}</span>` inside the name row; the root keeps `w-[220px] select-none`.
- Sketch: name `Sketches`; the root keeps its `@pointerdown`/`@click` handlers (click-to-open is pinned by behaviour).
- Moodboard: move the name (`entry?.name || 'Moodboard'`) from below the pile into the name row above it; the `reading.summary` line below the pile becomes the pile's `title` tooltip (house rule: hints are tooltips). Its wrapper + NodePort stay exactly as they are; the empty "drop inspiration" state stays.

Tests: each root has class `content-card` and a `content-card__name` before `<PileStack`; Moodboard's `entry?.name || 'Moodboard'` sits in the name row; `PileStack` props unchanged. Browser check: `cd frontend && npx playwright test tests/moodboard-core.spec.ts tests/moodboard-wires.spec.ts --project=chromium`. Commit `feat(cards): the piles carry their name above the stack`.

---

### Task 9: Real-browser check of the content cards

**Files:** Create `frontend/tests/content-cards.spec.ts`.

For Image (with an image via `dataOverrides: { images: [...] }` as `prompt-results.spec.ts` does), Video and Audio (empty is fine), Text, and a Collection: add the node, then assert:
1. `.content-card__name` visible above `.content-card__media` (name's bottom ≤ media's top);
2. `.node-float-actions` opacity 0 and `pointer-events: none` at rest, opacity 1 after hovering the media (poll);
3. selecting the node (click the name row) draws the outline on `.content-card__media` (computed `outline-style` is `solid`) and not on the card root;
4. Image: the More menu opens and lists "Replace image" / "Lock" / "Re-render" / "Save as character" / "Name as reference" (whichever apply to a card with an uploaded picture).

Then a throwaway screenshot pass (deleted afterwards): all the content cards on one canvas at rest, and the Image card hovered with the More menu open, saved to the session scratchpad.

Run `cd frontend && npx playwright test tests/content-cards.spec.ts --project=chromium`. Commit `test(cards): content cards — name above, actions on hover only, outline on the content, More menu`.

---

## Self-review (done while writing)

- Spec "Content card": 12px corners / no border / faint inner edge / soft shadow — `.content-card__media` (Task 1, used by 2–7); name above, quiet → brighter — `.content-card__name` (all); hover actions top-right on small dark buttons (no blur: perf ruling) — `#actions` (2–7); Collection grid (7); piles loose stack with count (8, PileStack already); Character portrait (6); 3D orbitable (5).
- Keep-lists honoured: selection look moved onto the content (Task 1 — ledger as a ruling), running/failed/muted/bypassed/locked kept; pinned test hooks listed in Global Constraints.
- Names consistent: `ContentCard`, `NodeMoreMenu`, `MoreItem`, `moreItems`, `cardName`, `tiles`, `src`/`tpl`.
