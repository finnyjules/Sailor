# Node design, stage 3 (studios) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every studio card on the canvas — Gradient, Shader, Pattern (texture), Shape, Kinetic (Space Type), Vector Type, 3D Studio, Pose Mannequin, Shot Director, Lip-sync and Smart Layout — wears the stage 1 dark-glass shell with its preview in a well, an Open bar that rises over the preview on hover (and stays up while selected), double-click to open, and a footer only when there is something to run.

**Architecture:** As in stage 2, the shell is applied as **classes on each card's existing element** (`node-shell` + `data-glass-blur` from `useNodeGlass` + `data-selected`), not by wrapping in `NodeShell.vue`. Every studio keeps the "`.studio-node` wrapper + port siblings + card" structure (three nodes that draw raw Vue Flow `<Handle>`s inside the card are moved to it and to the shared `NodePort`). Cards go from 220px to **240px wide** so that the 10px glass inset leaves a **220px preview well — exactly the width every preview is computed for today**, so no preview, loop or bake code changes. The existing header subtitle (layout name, effect name, font, headline) moves into the Open bar's description.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TS, Tailwind v4 (utilities live in `@layer utilities`; `node-surfaces.css` is unlayered and beats them), `@vue-flow/core`, Vitest + @vue/test-utils (happy-dom), Playwright on the shared `:3002`.

**Spec:** `docs/superpowers/specs/2026-09-27-node-design-design.md` — sections "Rules every node follows", "Instrument" (the shell) and **"Studio"**. Stages 1–2 shipped `frontend/app/assets/css/node-surfaces.css` (`.node-shell`, `.node-well`, `.node-openbar`, `.node-btn`), `surfaces/NodeOpenBar.vue`, `composables/useCanvasGlass.ts` (`useNodeGlass`), `NodePort.vue`, and the gradient edge ring `.node-shell::after`.

## Global Constraints

- **Do not change** selection, running or failed looks, wires, or the Note node. Keep: the `.studio-node` selection outline (only its corner radius follows the card, Task 1); Pose Mannequin's `[data-running]` ring and its red failed edge (re-expressed as scoped CSS, Task 6); Scene3D's mute/bypass classes; Pose's mute/bypass overlay and badge; Shot Director's `shotError` and Lip-sync's `lipSyncError` lines; Smart Layout's running sweep (owned by `ComfyNode.vue`, untouched).
- **Do not change logic.** No edits to `<script>` behaviour except what a task names (a `selected` prop, a `glass` computed, imports). Preview rendering, loops (`useCanvasCardPreviewLoop`, Space Type's own gate), bakers, frame sources, events (`sailor:open*`, `sailor:studioRender`, `sailor:poseGenerate`, `sailor:shotDirectorGenerate`, `sailor:lipSyncGenerate`) stay byte-for-byte. Shader Studio's script is pinned by three source-guard specs — do not touch its script.
- **The shell:** card element carries `node-shell`, `:data-glass-blur="glass || undefined"` (`const glass = useNodeGlass(() => props.id)`) and `:data-selected="selected || undefined"` (prop `selected?: boolean`, Vue Flow passes it). Width `w-[240px]` (Pose stays `w-[260px]`). Drop the old card chrome classes: `rounded-xl`, `border`, `border-white/10`, `bg-neutral-900*`, `shadow-lg`, `overflow-hidden`, `text-white`. Keep `relative z-10` (ports sit behind the shell).
- **Tailwind `ring-*`, `border-*`, `bg-*`, `shadow-*`, `rounded-*` and `text-<colour>` utilities are dead on a `.node-shell` element** (unlayered CSS wins). A state that must colour the edge does it in scoped CSS, and hides the resting ring with `::after { display: none; }`.
- **Header:** `<div class="node-shell__head">` with the icon (`class="node-shell__icon"`) and `<span class="node-shell__title">` holding the **existing title text unchanged**. No subtitle in the header.
- **Preview well:** `<div class="node-well node-openbar-host">` holding the existing preview element, then `<NodeOpenBar :meta="…">` with one `<button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>`. `NodeOpenBar` is imported explicitly: `import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'`. The old "Edit" / "Open" footer buttons are removed (the Open bar replaces them).
- **Double-click anywhere on the card opens the studio** (`@dblclick.stop="openEditor"` on the card element).
- **Footer only when something runs:** `<div class="node-shell__foot justify-end">` holding the run control. Bakeable studios: `StudioRenderButton`. Pose: re-render + Generate. Shot Director / Lip-sync: status on the left, Generate on the right.
- UI copy: sentence case, no identifiers, no new explanatory small text. Button labels: "Open", "Render", "Generate".
- **Shared checkout:** implementers never commit, never touch the git index, never run `npm run dev`, never restart `:3002`. `VueNodeCanvas.vue` and `ComfyNode.vue` are edited by other sessions — touch only the lines a task names and report exact line ranges.
- Never add `will-change`, `translateZ` or forced layer promotion. No new `backdrop-filter` anywhere except the one Task 1 narrows.

---

## File map

| File | Change | Task |
|---|---|---|
| `frontend/app/components/vue-canvas/StudioRenderButton.vue` | White `node-btn--primary` Render + quiet caret, like the generator's Run. | 1 |
| `frontend/app/assets/css/node-surfaces.css` | Open bar blurs only while risen. | 1 |
| `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (one rule, ~line 9175) | `.studio-node` selection outline radius 12px → 16px (follows the 16px card). | 1 |
| `GradientStudioNode.vue`, `ShaderStudioNode.vue`, `TextureStudioNode.vue` | Card on the shell, preview well + Open bar, Render footer. | 2 |
| `ShapeStudioNode.vue`, `VectorTypeNode.vue`, `SpaceTypeNode.vue` | Same. | 3 |
| `Scene3DStudioNode.vue` | Same, keeping mute/bypass, port min-height and the empty-scene button. | 4 |
| `ShotDirectorNode.vue`, `LipSyncStudioNode.vue` | Wrapper + `NodePort`s; summary in a well + Open bar; status + Generate footer. | 5 |
| `PoseMannequinNode.vue` | Wrapper (`.studio-node`) + `NodePort`s; shell; mode switch; preview well + Open bar; Generate footer; scoped running/failed. | 6 |
| `SmartLayoutNodeBody.vue` | Preview well + Open bar inside the (already-shelled) generator card; node buttons. | 7 |
| Tests | `tests/unit/studio-render-button.unit.spec.ts` (new), `tests/unit/studio-shell.unit.spec.ts` (new, grown per task), `tests/unit/studio-card-selection-ring.unit.spec.ts` (extend), `tests/unit/node-surfaces.unit.spec.ts` (extend), `tests/studio-shell.spec.ts` (new Playwright, Task 8). | 1–8 |

## Shared test helper (used by Tasks 2–7)

`tests/unit/studio-shell.unit.spec.ts` is created in Task 2 and each later task appends its files to it. Its helpers:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (f: string) => readFileSync(resolve(__dirname, '../../app/components/vue-canvas', f), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'))
/** The class attribute of the element that carries `node-shell`. */
const shellClass = (t: string) => (t.match(/class="([^"]*\bnode-shell\b[^"]*)"/) ?? [])[1] ?? ''
/** The opening tag of the element that carries `node-shell`. */
const shellTag = (t: string) => {
  const i = t.search(/class="[^"]*\bnode-shell\b/)
  const start = t.lastIndexOf('<', i)
  return t.slice(start, t.indexOf('>', i) + 1)
}
```

---

### Task 1: Shared studio pieces — Render button, Open bar blur, selection radius

**Files:**
- Modify: `frontend/app/components/vue-canvas/StudioRenderButton.vue` (template only)
- Modify: `frontend/app/assets/css/node-surfaces.css` (the `.canvas-glass--blur .node-openbar` rule)
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (the `.vue-node-canvas .vue-flow__node.selected .studio-node` rule only)
- Test: `frontend/tests/unit/studio-render-button.unit.spec.ts` (new), `frontend/tests/unit/node-surfaces.unit.spec.ts`, `frontend/tests/unit/studio-card-selection-ring.unit.spec.ts`

**Interfaces:**
- Produces: `StudioRenderButton` keeps its props `{ nodeId: string; busy?: boolean }`, its `data-studio-render` root and every `sailor:studioRender` dispatch. Callers in Tasks 2–4 render it as `<StudioRenderButton :node-id="id" :busy="!!data?.studioBusy" />` (no `class="flex-1"` any more).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/unit/studio-render-button.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'

enableAutoUnmount(afterEach)

describe('StudioRenderButton', () => {
  it('is the white node button, like the generator Run', () => {
    const w = mount(StudioRenderButton, { props: { nodeId: '7' } })
    const main = w.find('[data-studio-render] button')
    expect(main.classes()).toEqual(expect.arrayContaining(['node-btn', 'node-btn--primary']))
    expect(main.text()).toContain('Render')
  })
  it('clicking Render fires a downstream render for this node', async () => {
    const spy = vi.fn()
    window.addEventListener('sailor:studioRender', spy as any)
    const w = mount(StudioRenderButton, { props: { nodeId: '7' } })
    await w.find('.node-btn--primary').trigger('click')
    expect((spy.mock.calls[0]![0] as CustomEvent).detail).toEqual({ sourceNodeId: '7', scope: 'downstream' })
    window.removeEventListener('sailor:studioRender', spy as any)
  })
  it('the caret opens the three scopes', async () => {
    const w = mount(StudioRenderButton, { props: { nodeId: '7' } })
    await w.find('[aria-label="Render scope"]').trigger('click')
    expect(w.text()).toContain('Render this')
    expect(w.text()).toContain('Rebuild from start → here')
    expect(w.text()).toContain('Run from here → end')
  })
  it('busy shows Rendering… and disables both buttons', () => {
    const w = mount(StudioRenderButton, { props: { nodeId: '7', busy: true } })
    expect(w.text()).toContain('Rendering…')
    for (const b of w.findAll('button')) expect(b.attributes('disabled')).toBeDefined()
  })
})
```

Append to `frontend/tests/unit/node-surfaces.unit.spec.ts` (inside its existing `describe`, which already defines `CSS` and `rule`):

```ts
  it('the Open bar blurs only while it is up (a hidden blur still costs every frame)', () => {
    expect(CSS).not.toMatch(/\.canvas-glass--blur \.node-openbar \{/)
    expect(CSS).toMatch(/\.canvas-glass--blur \.node-openbar-host:hover \.node-openbar,[\s\S]{0,300}backdrop-filter: blur\(14px\) saturate\(1\.3\)/)
  })
```

Append to `frontend/tests/unit/studio-card-selection-ring.unit.spec.ts` (inside its top-level describe; it already reads VueNodeCanvas.vue — reuse its variable, or read the file the same way):

```ts
  it('the studio outline follows the 16px glass card', () => {
    const canvas = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/VueNodeCanvas.vue'), 'utf8')
    const i = canvas.indexOf('.vue-node-canvas .vue-flow__node.selected .studio-node {')
    expect(canvas.slice(i, canvas.indexOf('}', i))).toMatch(/outline: 2px solid var\(--action\);\s*outline-offset: 3px;\s*border-radius: 16px;/)
  })
```

(Add `import { readFileSync } from 'node:fs'` / `import { resolve } from 'node:path'` if the spec does not import them yet.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/studio-render-button.unit.spec.ts tests/unit/node-surfaces.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts`
Expected: FAIL — no `node-btn--primary`, no `aria-label="Render scope"`, the unconditional Open bar blur rule, radius 12px.

- [ ] **Step 3: Implement**

`StudioRenderButton.vue` — replace the template (script unchanged except the icon import: `ChevronUp` → `ChevronDown`):

```vue
<template>
  <div class="relative flex items-center gap-0.5 nopan nodrag" data-studio-render>
    <button
      type="button"
      class="node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="busy"
      @click.stop="fire('downstream')"
    >
      <Loader2 v-if="busy" class="size-3 animate-spin" />
      <Play v-else class="size-2.5" fill="currentColor" />
      <span>{{ busy ? 'Rendering…' : 'Render' }}</span>
    </button>
    <button
      type="button"
      class="shrink-0 size-5 -mr-1 rounded-[5px] flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
      :disabled="busy"
      aria-label="Render scope"
      title="Render scope"
      @click.stop="open = !open"
    >
      <ChevronDown class="size-3 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>

    <div
      v-if="open"
      class="absolute bottom-full right-0 z-50 mb-1 w-52 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl"
    >
      <button
        v-for="o in OPTS" :key="o.scope"
        type="button"
        class="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
        @click.stop="fire(o.scope)"
      >{{ o.label }}</button>
    </div>
  </div>
</template>
```

`node-surfaces.css` — replace the single rule
`.canvas-glass--blur .node-openbar { backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3); }`
with (keep the comment above it, add the second sentence):

```css
/* Frosted only when the canvas allows blur; the bar is 82% opaque either way.
   Only while it is up: a hidden element with a backdrop blur is still re-blurred
   every frame the canvas moves. */
.canvas-glass--blur .node-openbar-host:hover .node-openbar,
.canvas-glass--blur .node-openbar-host:focus-within .node-openbar,
.canvas-glass--blur .node-openbar-host[data-selected] .node-openbar,
.canvas-glass--blur .node-shell[data-selected] .node-openbar {
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
}
```

`VueNodeCanvas.vue` — in the `.vue-node-canvas .vue-flow__node.selected .studio-node` rule change `border-radius: 12px;` to `border-radius: 16px;` and extend its comment's first line with "(16px, the glass card's corner)". Nothing else in that file.

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** (controller, private index, exact paths; `VueNodeCanvas.vue` by hunk)

```bash
git commit -m "feat(studios): Render is the white node button; the Open bar blurs only while up; the studio outline follows the 16px card"
```

---

### Task 2: Gradient, Shader and Pattern studios on the shell

**Files:**
- Modify: `frontend/app/components/vue-canvas/GradientStudioNode.vue` (props, one import + one computed in script; template)
- Modify: `frontend/app/components/vue-canvas/ShaderStudioNode.vue` (**template only** + the `selected` prop, the `useNodeGlass` import and the `glass` computed — nothing else in its script; three specs pin its script text)
- Modify: `frontend/app/components/vue-canvas/TextureStudioNode.vue`
- Test: `frontend/tests/unit/studio-shell.unit.spec.ts` (new)

**Interfaces:**
- Consumes: Task 1's `StudioRenderButton`; `useNodeGlass(nodeId: MaybeRefOrGetter<string|undefined>): ComputedRef<boolean>` from `~/composables/useCanvasGlass`; `NodeOpenBar` (`props: { meta?: string }`, default slot for the button).
- Produces: the card pattern Tasks 3–4 repeat.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/studio-shell.unit.spec.ts` with the helpers from "Shared test helper" above, then:

```ts
const FAMILY_A = ['GradientStudioNode.vue', 'ShaderStudioNode.vue', 'TextureStudioNode.vue']

describe.each(FAMILY_A)('%s wears the studio shell', (file) => {
  const s = src(file)
  const t = tpl(s)
  it('the card is a 240px glass shell over its ports', () => {
    const c = shellClass(t)
    expect(c).toMatch(/\brelative\b/)
    expect(c).toMatch(/\bz-10\b/)
    expect(c).toMatch(/\bw-\[240px\]/)
    expect(c).not.toMatch(/rounded-xl|\bborder\b|bg-neutral-900|shadow-lg|overflow-hidden|text-white/)
  })
  it('carries glass and selection, and opens on double-click', () => {
    const tag = shellTag(t)
    expect(tag).toMatch(/:data-glass-blur="glass \|\| undefined"/)
    expect(tag).toMatch(/:data-selected="selected \|\| undefined"/)
    expect(tag).toMatch(/@dblclick\.stop="openEditor"/)
    expect(s).toMatch(/selected\?: boolean/)
    expect(s).toMatch(/const glass = useNodeGlass\(\(\) => props\.id\)/)
  })
  it('header is icon + title only', () => {
    expect(t).toMatch(/class="node-shell__head"/)
    expect(t).toMatch(/class="node-shell__title"/)
  })
  it('the preview sits in a well with an Open bar', () => {
    expect(t).toMatch(/class="node-well node-openbar-host"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(s).toMatch(/import NodeOpenBar from '~\/components\/vue-canvas\/surfaces\/NodeOpenBar\.vue'/)
  })
  it('the footer is only the Render control', () => {
    expect(t).toMatch(/class="node-shell__foot justify-end"[\s\S]{0,200}<StudioRenderButton :node-id="id" :busy="!!data\?\.studioBusy" \/>/)
    expect(t).not.toMatch(/Pencil/)
    expect(t).not.toMatch(/>\s*Edit\s*</)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts`
Expected: studio-shell FAILS on all three files; studio-card-selection-ring still PASSES (do not break it — the wrapper stays the first `<div>` after `<template>` with a static `studio-node` class).

- [ ] **Step 3: Implement** (repeat for each of the three files)

Script, in each file:
- add `selected?: boolean` to `defineProps`;
- `import { useNodeGlass } from '~/composables/useCanvasGlass'` and `import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'`;
- `const glass = useNodeGlass(() => props.id)` next to the other computeds;
- remove `Pencil` from the lucide import if it becomes unused.

Template — the outer `div.studio-node relative w-fit` (with its `ref`/handlers) and every `<VueCanvasNodePort>` stay exactly as they are. Replace the inner card. **GradientStudioNode.vue** target:

```vue
    <div
      class="gradient-studio-card node-shell relative z-10 w-[240px]"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="openEditor"
    >
      <div class="node-shell__head">
        <Sparkles class="node-shell__icon" />
        <span class="node-shell__title">Gradient Studio</span>
      </div>
      <div class="node-shell__body">
        <div class="node-well node-openbar-host">
          <canvas ref="canvasEl" class="block w-full" :style="{ height: previewH + 'px' }" />
          <NodeOpenBar :meta="LAYOUT_LABELS[config.canvas.layout]">
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>
        <!-- the existing glError line, unchanged -->
      </div>
      <div class="node-shell__foot justify-end">
        <StudioRenderButton :node-id="id" :busy="!!data?.studioBusy" />
      </div>
    </div>
```

Keep every attribute of the existing `<canvas>` and error line exactly (copy them from the file; the snippet above shows the canvas as it is today). The `meta` expression is exactly what the old header's right-hand label showed — copy it from the file rather than retyping.

**ShaderStudioNode.vue:** same card with class `shader-studio-card …`, icon `Sparkles`, title `Shader studio`. The well holds the existing preview box with `bg-neutral-950` removed from its classes (the well supplies the fill): `<div class="relative flex items-center justify-center aspect-video">` + the existing `<canvas>` + the existing "Connect or add an image" span (keep it `absolute`). Open bar `:meta="headerEffectName"` (whatever expression the old header showed).

**TextureStudioNode.vue:** class `texture-studio-card …`, icon `Layers`, title `Pattern Studio`, the existing `<canvas … :style="{ height: PREVIEW_H + 'px' }">` in the well, `<NodeOpenBar>` with **no** `meta` (the old header had no subtitle).

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command, plus the Shader script guards:
`cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts tests/unit/shaderfx-context-watch.unit.spec.ts tests/unit/my-effects-live-consumers.unit.spec.ts tests/unit/shader-live-effect-clock.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Browser check** (against the running :3002, never start a server)

Run: `cd frontend && npx playwright test tests/node-toolbar.spec.ts tests/prompt-results.spec.ts --project=chromium`
Expected: PASS (both pin `.vue-flow__node-gradient-studio`).

- [ ] **Step 6: Commit** (controller)

```bash
git commit -m "feat(studios): Gradient, Shader and Pattern studios wear the glass shell — preview in a well, Open bar on hover, Render footer"
```

---

### Task 3: Shape, Vector Type and Kinetic studios on the shell

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShapeStudioNode.vue`
- Modify: `frontend/app/components/vue-canvas/VectorTypeNode.vue`
- Modify: `frontend/app/components/vue-canvas/SpaceTypeNode.vue`
- Test: `frontend/tests/unit/studio-shell.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: the Task 2 card pattern and helpers.

- [ ] **Step 1: Extend the failing test**

In `studio-shell.unit.spec.ts` change the list to:

```ts
const FAMILY_A = [
  'GradientStudioNode.vue', 'ShaderStudioNode.vue', 'TextureStudioNode.vue',
  'ShapeStudioNode.vue', 'VectorTypeNode.vue', 'SpaceTypeNode.vue',
]
```

and add:

```ts
describe('Kinetic keeps its hover-to-play and render-error badge', () => {
  const t = tpl(src('SpaceTypeNode.vue'))
  it('the wrapper still owns the hover handlers', () => {
    expect(t).toMatch(/class="studio-node relative w-fit" @pointerenter="onNodeHoverEnter" @pointerleave="onNodeHoverLeave"/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts`
Expected: the three new files FAIL; Task 2's still PASS.

- [ ] **Step 3: Implement** — the Task 2 card, per file:

**ShapeStudioNode.vue:** class `shape-studio-card node-shell relative z-10 w-[240px]`, icon `Gem`, title `Shape Studio`. The well holds the existing preview box with `bg-neutral-950` removed: `<div class="flex aspect-video items-center justify-center">` + the existing `<img v-if="thumbUrl" …>` / "No export yet" span. `<NodeOpenBar>` without `meta`.

**VectorTypeNode.vue:** class `vector-type-card …`, icon `Type`, title `Vector Type`. The existing `<canvas … :style="{ height: previewH + 'px' }">` in the well. `:meta="fontLabel"` (the old header's label). The existing `renderError` (red) and `fontNote` (amber) lines stay, unchanged, inside `node-shell__body` after the well.

**SpaceTypeNode.vue:** class `space-type-card …` — this card had **no** `z-10`; it gets `relative z-10` like the rest. Icon `Sparkles`, title `Kinetic Studio`. The well holds the existing `<canvas v-if="webglOk" …>`, the existing "3D preview unavailable" fallback and the existing "Render error" badge (keep its `absolute inset-x-2 bottom-2`). `:meta` = the headline the old header showed (`state.params.text`, same expression and truncation source — the Open bar truncates by itself, so drop the old `max-w-[110px]`/`uppercase` classes with the header). The outer wrapper keeps `@pointerenter="onNodeHoverEnter" @pointerleave="onNodeHoverLeave"` verbatim.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts tests/unit/collection-studio-controls.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Browser check**

Run: `cd frontend && npx playwright test tests/frame-embed-network.spec.ts --project=chromium -g "Space|space|gradient|Gradient"`
Expected: PASS (it adds SpaceType and GradientStudio nodes to a real canvas).

- [ ] **Step 6: Commit** (controller)

```bash
git commit -m "feat(studios): Shape, Vector Type and Kinetic studios wear the glass shell"
```

---

### Task 4: 3D Studio on the shell

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioNode.vue`
- Test: `frontend/tests/unit/studio-shell.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: the Task 2 card pattern.

- [ ] **Step 1: Extend the failing test**

Add `'Scene3DStudioNode.vue'` to `FAMILY_A`, and add:

```ts
describe('3D Studio keeps its own states', () => {
  const t = tpl(src('Scene3DStudioNode.vue'))
  const tag = shellTag(t)
  it('mute and bypass still dim the card', () => {
    expect(tag).toMatch(/:class="\{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed \}"/)
  })
  it('the ports still set the card height', () => {
    expect(tag).toMatch(/minHeight: `\$\{portsMinHeight\}px`/)
  })
  it('an empty scene still offers its Edit scene button inside the well', () => {
    expect(t).toMatch(/class="node-well node-openbar-host aspect-square"[\s\S]*Edit scene/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts`
Expected: Scene3D cases FAIL.

- [ ] **Step 3: Implement**

The card (it stays **240px**, it already was):

```vue
    <div
      class="scene3d-studio-card node-shell relative z-10 w-[240px]"
      :class="{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed }"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      :style="{ minHeight: `${portsMinHeight}px` }"
      @dblclick.stop="openEditor"
    >
      <div class="node-shell__head">
        <Box class="node-shell__icon" />
        <span class="node-shell__title">{{ data.title || '3D Studio' }}</span>
      </div>
      <div class="node-shell__body">
        <div class="node-well node-openbar-host aspect-square">
          <!-- the existing <img …> (livePreviewUrl || thumbUrl) and the existing
               empty-state "Edit scene" button, unchanged except: the button's classes
               become "node-btn nopan nodrag" -->
          <NodeOpenBar>
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>
      </div>
      <div class="node-shell__foot justify-end">
        <StudioRenderButton :node-id="id" :busy="!!data?.studioBusy" />
      </div>
    </div>
```

The icon loses its `text-sky-400` (every studio icon is the shell's quiet white). The old preview wrapper's `mx-2 my-2 rounded-lg bg-black/40 overflow-hidden` go (the body inset and the well replace them). Script: `selected` prop, `useNodeGlass`, `NodeOpenBar` import; drop `Pencil` if unused.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Browser check**

Run: `cd frontend && npx playwright test tests/scene3d-grouping.spec.ts --project=chromium`
Expected: PASS.

- [ ] **Step 6: Commit** (controller)

```bash
git commit -m "feat(studios): 3D Studio wears the glass shell"
```

---

### Task 5: Shot Director and Lip-sync — shared ports, a summary well, a Generate footer

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShotDirectorNode.vue`
- Modify: `frontend/app/components/vue-canvas/LipSyncStudioNode.vue`
- Test: `frontend/tests/unit/studio-shell.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `NodePort` (used in templates as `<VueCanvasNodePort>`; props `id`, `type: 'source'|'target'`, `side: 'left'|'right'`, `dataType`, `label`, `index` — index 0 sits at the card's vertical centre; it must be a **sibling** of the card inside the relative wrapper).
- Port types come from the node's own data: `createNodeData` gives Shot Director inputs `cast_1..3` of type `CHARACTER` and both studios one output `{ name: 'output', type: '*' }`. Use `data.inputs?.[i]?.type ?? 'CHARACTER'` and `data.outputs?.[0]?.type ?? '*'`. Port **ids stay exactly as today** (`output-0`, `input-0`, `input-1`, `input-2`) — saved wires reference them.

- [ ] **Step 1: Extend the failing test**

```ts
describe.each(['ShotDirectorNode.vue', 'LipSyncStudioNode.vue'])('%s wears the studio shell', (file) => {
  const s = src(file)
  const t = tpl(s)
  it('keeps the studio-node wrapper first, and a 240px shell card inside it', () => {
    expect(t).toMatch(/^<template>\s*<div[^>]*class="studio-node relative w-fit"/)
    expect(shellClass(t)).toMatch(/\bw-\[240px\]/)
    expect(shellClass(t)).not.toMatch(/rounded-xl|\bborder\b|bg-neutral-900|shadow-lg|overflow-hidden/)
  })
  it('uses the shared ports, not raw handles', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/<VueCanvasNodePort[\s\S]*?id="output-0"/)
    expect(s).not.toMatch(/import \{ Handle/)
  })
  it('opens on double-click, has glass and selection', () => {
    const tag = shellTag(t)
    expect(tag).toMatch(/@dblclick\.stop="openEditor"/)
    expect(tag).toMatch(/:data-glass-blur="glass \|\| undefined"/)
    expect(tag).toMatch(/:data-selected="selected \|\| undefined"/)
  })
  it('the summary sits in a well with an Open bar; Generate is the white footer button', () => {
    expect(t).toMatch(/class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(t).toMatch(/class="node-shell__foot"[\s\S]*node-btn node-btn--primary[\s\S]*Generate/)
    expect(t).not.toMatch(/Pencil/)
  })
})
it('Shot Director keeps three cast ports', () => {
  expect(tpl(src('ShotDirectorNode.vue'))).toMatch(/v-for="i in 3"[\s\S]{0,200}:id="`input-\$\{i - 1\}`"/)
})
it('Lip-sync keeps Generate disabled while it has issues', () => {
  expect(tpl(src('LipSyncStudioNode.vue'))).toMatch(/node-btn--primary[^>]*:disabled="hasError"|:disabled="hasError"[^>]*node-btn--primary/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts`
Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

**ShotDirectorNode.vue** target template (script: drop `Handle, Position` import, add `selected?: boolean` to props — also add `inputs?: { type: string }[]; outputs?: { type: string }[]` to the `data` prop type —, `useNodeGlass`, `NodeOpenBar` import, `const glass = useNodeGlass(() => props.id)`):

```vue
<template>
  <div class="studio-node relative w-fit">
    <VueCanvasNodePort
      v-for="i in 3" :key="i"
      :id="`input-${i - 1}`" type="target" side="left"
      :data-type="data.inputs?.[i - 1]?.type ?? 'CHARACTER'"
      :label="`Cast ${i}`" :index="i - 1"
    />
    <VueCanvasNodePort
      id="output-0" type="source" side="right"
      :data-type="data.outputs?.[0]?.type ?? '*'" label="Shot" :index="0"
    />
    <div
      class="shot-director-card node-shell relative z-10 w-[240px]"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="openEditor"
    >
      <div class="node-shell__head">
        <Clapperboard class="node-shell__icon" />
        <span class="node-shell__title">Shot Director</span>
      </div>
      <div class="node-shell__body">
        <div class="node-well node-openbar-host min-h-[92px] px-3 py-2.5 flex flex-col gap-2">
          <p class="text-[13px] leading-snug text-white/85 line-clamp-2">{{ subject }}</p>
          <!-- the existing img / vid / aud reference-count chips, unchanged -->
          <NodeOpenBar :meta="profile.label">
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>
      </div>
      <p v-if="data?.shotError" class="px-3.5 pb-2 text-[11px] leading-tight text-red-400/90">{{ data.shotError }}</p>
      <div class="node-shell__foot">
        <span class="shrink-0 size-1.5 rounded-full" :class="wordDotClass" aria-hidden="true" />
        <span class="flex-1 min-w-0 truncate text-[12px] text-white/55">{{ compiled.wordCount }} words</span>
        <button
          type="button"
          class="nopan nodrag node-btn node-btn--primary"
          :title="`Compile the shot and run ${profile.label}`"
          @click.stop="generate"
        >
          <Play class="size-2.5" fill="currentColor" />
          <span>Generate</span>
        </button>
      </div>
    </div>
  </div>
</template>
```

Index layout: the house rule (`portOffset` in `~/lib/canvas/portLayout`) puts index 0 at the card's centre and stacks later ports 20px below, never re-centring — so the cast ports are `0, 1, 2`. A three-port stack is 40px tall below centre; the card is taller than 2 × 40 + 16, so no min-height is needed. The model chip that used to sit in the summary is now the Open bar's description; the word-count dot moves to the footer. `compiled.wordCount` already exists. Import `Play` from lucide.

**LipSyncStudioNode.vue**, same structure:

- one output `<VueCanvasNodePort id="output-0" type="source" side="right" :data-type="data.outputs?.[0]?.type ?? '*'" label="Lip-sync" :index="0" />`, no inputs;
- card `lip-sync-card node-shell relative z-10 w-[240px]` with glass / selected / dblclick; icon `AudioLines`, title `Lip-Sync Studio`;
- well (`node-well node-openbar-host min-h-[92px] px-3 py-2.5 flex flex-col gap-1.5`) holding the existing face and voice labels (unchanged text, `text-[12px] text-white/75`); `<NodeOpenBar :meta="…">` whose meta is the existing engine chip and resolution chip joined as `` `${engine} · ${resolution}` `` (use the same expressions the chips render);
- the existing `lipSyncError` block, restyled as `<p v-if="data?.lipSyncError" class="px-3.5 pb-2 text-[11px] leading-tight text-red-400/90">`;
- footer `node-shell__foot`: the existing status dot + its "Ready" / "N issues" text on the left (`flex-1 min-w-0 truncate text-[12px] text-white/55`), then `<button type="button" class="nopan nodrag node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed" :disabled="hasError" @click.stop="generate"><Play class="size-2.5" fill="currentColor" /><span>Generate</span></button>`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Browser check** — double-click to open is pinned here:

Run: `cd frontend && npx playwright test tests/shot-director-models.spec.ts tests/character-sheet.spec.ts --project=chromium`
Expected: PASS. If a spec wires a Character into Shot Director by handle id, it must still connect (ids unchanged).

- [ ] **Step 6: Commit** (controller)

```bash
git commit -m "feat(studios): Shot Director and Lip-sync wear the glass shell — shared ports, summary in a well, Generate footer"
```

---

### Task 6: Pose Mannequin on the shell

**Files:**
- Modify: `frontend/app/components/vue-canvas/PoseMannequinNode.vue` (template, scoped style; script: `selected` prop, `useNodeGlass`, `NodeOpenBar` + `StudioSegmented` imports, one dblclick guard function, drop unused imports)
- Test: `frontend/tests/unit/studio-shell.unit.spec.ts`, `frontend/tests/unit/studio-card-selection-ring.unit.spec.ts` (add Pose to its list)

**Interfaces:**
- Consumes: `NodePort`; `StudioSegmented` (`frontend/app/components/vue-canvas/studio/StudioSegmented.vue`: `v-model` string, props `options: string[]`, `optionLabels?: string[]`).
- Rulings baked in (ledgered by the controller): Pose joins `.studio-node`, so it now gets the canvas selection outline every other studio has (it had none — the same gap the 09-20 fix closed for seven studios). The mode switch and the prompt box stay on the card: they are inputs to Generate, not studio settings. The pose-image port no longer fades to 25% outside Image mode (NodePort has no dim-only state; `disabled` would make it unwireable) — ports name themselves on hover.

- [ ] **Step 1: Extend the failing tests**

In `studio-card-selection-ring.unit.spec.ts` add `'PoseMannequinNode.vue'` to its list of studio files (its rule: first `<div …>` after `<template>` has a static `studio-node` class).

In `studio-shell.unit.spec.ts`:

```ts
describe('Pose Mannequin wears the studio shell', () => {
  const s = src('PoseMannequinNode.vue')
  const t = tpl(s)
  const tag = shellTag(t)
  it('a 260px shell card inside the studio-node wrapper, no gradient fill', () => {
    expect(t).toMatch(/^<template>\s*<div[^>]*class="studio-node relative w-fit"/)
    expect(shellClass(t)).toMatch(/\bpose-node\b[\s\S]*\bw-\[260px\]|\bw-\[260px\][\s\S]*\bpose-node\b/)
    expect(tag).not.toMatch(/linear-gradient/)
    expect(tag).not.toMatch(/ring-2|border-red-500/)
  })
  it('running and failed stay as they were, in scoped CSS', () => {
    expect(tag).toMatch(/:data-running="data\.running \|\| undefined"/)
    expect(tag).toMatch(/:data-error="data\.error \|\| undefined"/)
    expect(s).toMatch(/\.pose-node\[data-running\] \{ box-shadow: 0 0 0 2px var\(--port-color, #fff\), 0 4px 16px rgba\(0, 0, 0, 0\.4\); \}/)
    expect(s).toMatch(/\.pose-node\[data-error\] \{ border-color: #ef4444; box-shadow: 0 0 0 2px #ef4444, var\(--node-shadow\); \}/)
    expect(s).toMatch(/\.pose-node\[data-error\]::after \{ display: none; \}/)
  })
  it('shared ports with unchanged ids', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/:id="`input-\$\{characterInIdx\}`"/)
    expect(t).toMatch(/:id="`input-\$\{poseImageInIdx\}`"/)
    expect(t).toMatch(/:id="`output-\$\{imageOutIdx\}`"/)
  })
  it('double-click anywhere opens, except inside a form control', () => {
    expect(tag).toMatch(/@dblclick\.stop="onCardDblclick"/)
    expect(s).toMatch(/function onCardDblclick\(e: MouseEvent\)/)
    expect(s).toMatch(/closest\('input, textarea, select, button'\)/)
  })
  it('mode switch is the shared segmented control; the mannequin preview has an Open bar; Generate is the footer', () => {
    expect(t).toMatch(/<StudioSegmented/)
    expect(t).toMatch(/class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(t).toMatch(/class="node-shell__foot justify-end"[\s\S]*RefreshCw[\s\S]*node-btn--primary[\s\S]*Generate/)
    expect(t).not.toMatch(/Pose & Generate|Edit pose/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts`
Expected: Pose cases FAIL.

- [ ] **Step 3: Implement**

Script additions:

```ts
const glass = useNodeGlass(() => props.id)
/** Double-click anywhere opens the pose editor — but not while editing the prompt. */
function onCardDblclick(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest('input, textarea, select, button')) return
  openEditor()
}
```

Template target:

```vue
<template>
  <div class="studio-node relative w-fit">
    <VueCanvasNodePort :id="`input-${characterInIdx}`" type="target" side="left"
      :data-type="data.inputs?.[characterInIdx]?.type ?? 'CHARACTER'" label="Character" :index="0" />
    <VueCanvasNodePort :id="`input-${poseImageInIdx}`" type="target" side="left"
      :data-type="data.inputs?.[poseImageInIdx]?.type ?? 'IMAGE'" label="Pose image" :index="1" />
    <VueCanvasNodePort :id="`output-${imageOutIdx}`" type="source" side="right"
      :data-type="data.outputs?.[imageOutIdx]?.type ?? 'IMAGE'" label="Image" :index="0" />

    <div
      class="pose-node node-shell relative z-10 w-[260px] select-none"
      :style="{ '--port-color': imageColor } as any"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="onCardDblclick"
    >
      <!-- the existing mute/bypass overlay div (keep; change `rounded-xl` to `rounded-[inherit]`)
           and the existing Mute / Bypass badge, unchanged -->
      <div class="node-shell__head">
        <PersonStanding class="node-shell__icon" />
        <span class="node-shell__title">Pose Mannequin</span>
      </div>
      <div class="node-shell__body">
        <StudioSegmented
          class="nopan nodrag"
          :model-value="poseSource"
          :options="MODES.map(m => m.id)"
          :option-labels="MODES.map(m => m.label)"
          @update:model-value="setMode"
        />
        <!-- Mannequin -->
        <div v-if="poseSource === 'mannequin'" class="node-well node-openbar-host bg-checker aspect-[3/4] flex items-center justify-center">
          <!-- the existing <img v-if="mannequinUrl" …> and "No pose yet" block, unchanged -->
          <NodeOpenBar>
            <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
          </NodeOpenBar>
        </div>
        <!-- Image: the existing status block, with its container classes replaced by
             "node-well bg-checker aspect-[3/4] flex flex-col items-center justify-center gap-1.5 text-center px-3" -->
        <!-- Prompt: container "node-well bg-checker aspect-[3/4] p-2 flex flex-col"; the existing
             textarea unchanged except its classes: drop `rounded-md bg-black/40 border border-white/10
             focus:border-white/25`, add `bg-transparent` — the well is the box. Keep @pointerdown.stop @dblclick.stop. -->
      </div>
      <div v-if="!isMuted && !isBypassed" class="node-shell__foot justify-end">
        <!-- the existing re-render button: same :disabled, title, @click; classes →
             "nopan nodrag node-btn px-2 disabled:opacity-35 disabled:cursor-not-allowed" -->
        <button
          type="button"
          class="nopan nodrag node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="data.running || !canGenerate"
          :title="data.running ? 'Running…' : !canGenerate ? 'Wire a pose image first' : 'Generate — re-pose the character'"
          @click.stop="runThisNode"
        >
          <Loader2 v-if="data.running" class="size-3 animate-spin" />
          <Play v-else class="size-2.5" fill="currentColor" />
          <span>Generate</span>
        </button>
      </div>
    </div>
  </div>
</template>
```

Remove: the three `<Handle>`s (and `Handle, Position` imports), the gradient title bar (and `accentColor` if nothing else uses it), the "Edit pose / Pose & Generate" footer and the `Wand2` import if unused, the old mode-toggle buttons (replaced by `StudioSegmented`), the old body wrapper `overflow-hidden rounded-b-xl`.

Scoped style: replace the `.pose-node { box-shadow: … }` base rule (the shell's `--node-shadow` now applies) and keep/define exactly:

```css
.pose-node[data-running] { box-shadow: 0 0 0 2px var(--port-color, #fff), 0 4px 16px rgba(0, 0, 0, 0.4); }
/* Failed: the red edge it always had (Tailwind ring/border utilities don't reach a .node-shell). */
.pose-node[data-error] { border-color: #ef4444; box-shadow: 0 0 0 2px #ef4444, var(--node-shadow); }
.pose-node[data-error]::after { display: none; }
```

Keep `.pose-node-stripes` and `.bg-checker` unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts tests/unit/studio-card-selection-ring.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (controller)

```bash
git commit -m "feat(studios): Pose Mannequin wears the glass shell — shared ports, mode switch, Open bar, Generate footer; it now shows the selection outline"
```

---

### Task 7: Smart Layout body — preview well and Open bar

Smart Layout is drawn by `ComfyNode.vue` (already on the instrument shell since stage 2); only its body component changes. **Do not edit `ComfyNode.vue`.**

**Files:**
- Modify: `frontend/app/components/vue-canvas/SmartLayoutNodeBody.vue` (template only; add the `NodeOpenBar` import)
- Test: `frontend/tests/unit/studio-shell.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: its existing props `{ data }`, emits `edit` / `batch`, computeds `varCount`, `previewUrl`, `hasRunResults`, `elementCount`, `outputCount`.

- [ ] **Step 1: Extend the failing test**

```ts
describe('Smart Layout body', () => {
  const s = src('SmartLayoutNodeBody.vue')
  const t = tpl(s)
  it('sits on the generator card inset (10px), not its own', () => {
    expect(t).toMatch(/^<template>\s*<div class="px-2\.5 pb-2\.5 pt-1 nopan nodrag flex flex-col gap-\[5px\]">/)
  })
  it('a designed layout shows a well with an Open bar that edits', () => {
    expect(t).toMatch(/v-if="elementCount"[\s\S]*class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar :meta="summary">[\s\S]*@click\.stop="emit\('edit'\)"[\s\S]*>Open<\/button>/)
  })
  it('Batch export is the white node button; an empty layout keeps Design layout', () => {
    expect(t).toMatch(/node-btn node-btn--primary[^"]*"[\s\S]{0,200}Batch export/)
    expect(t).toMatch(/node-btn node-btn--primary[^"]*"[\s\S]{0,200}Design layout/)
    expect(t).not.toMatch(/Edit layout/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts`
Expected: Smart Layout cases FAIL.

- [ ] **Step 3: Implement**

Script: `import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'` and

```ts
const summary = computed(() =>
  `${elementCount.value} element${elementCount.value === 1 ? '' : 's'} · ${outputCount.value} output${outputCount.value === 1 ? '' : 's'}`
  + (varCount.value ? ` · ${varCount.value} vars` : ''),
)
```

(this is the existing summary line's text plus the existing vars pill, moved into one computed — no new data).

Template:

```vue
<template>
  <div class="px-2.5 pb-2.5 pt-1 nopan nodrag flex flex-col gap-[5px]">
    <template v-if="elementCount">
      <div class="node-well node-openbar-host min-h-[56px]">
        <img v-if="previewUrl && !hasRunResults" :src="previewUrl" class="block w-full" />
        <NodeOpenBar :meta="summary">
          <button type="button" class="node-btn nopan nodrag" @click.stop="emit('edit')">Open</button>
        </NodeOpenBar>
      </div>
      <button type="button" class="node-btn node-btn--primary w-full justify-center" @click="emit('batch')">
        <Grid3X3 class="size-3.5" />
        Batch export
      </button>
    </template>
    <button v-else type="button" class="node-btn node-btn--primary w-full justify-center" title="Wire layers, then design the layout" @click="emit('edit')">
      <LayoutTemplate class="size-3.5" />
      Design layout
    </button>
  </div>
</template>
```

The empty-state hint line ("Empty — wire layers, then design the layout") becomes the Design layout button's tooltip (house rule: hints are tooltips). With a designed layout and no preview image (after a run), the well shows only its Open bar area at 56px — the Open bar sits in it; that is intended.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/studio-shell.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Browser check**

Run: `cd frontend && npx playwright test tests/smart-layout.spec.ts --project=chromium`
Expected: PASS (it pins `getByRole('button', { name: /Design layout/i })`).

- [ ] **Step 6: Commit** (controller)

```bash
git commit -m "feat(studios): Smart Layout's body — preview in a well with an Open bar, Batch export and Design layout as node buttons"
```

---

### Task 8: Real-browser check of every studio card

**Files:**
- Create: `frontend/tests/studio-shell.spec.ts`

**Interfaces:**
- Consumes: `openBlankWorkflow`, `waitForBackend` from `tests/_helpers.ts`; `window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType } }))` adds a node at the last pointer position.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

// Frontend-only studios (no /object_info dependency) plus the two summary studios.
const STUDIOS: { type: string; vf: string }[] = [
  { type: 'GradientStudio', vf: 'gradient-studio' },
  { type: 'ShaderStudio', vf: 'shader-studio' },
  { type: 'TextureStudio', vf: 'texture-studio' },
  { type: 'ShapeStudio', vf: 'shape-studio' },
  { type: 'VectorType', vf: 'vector-type' },
  { type: 'SpaceType', vf: 'space-type' },
  { type: 'ShotDirector', vf: 'shot-director' },
  { type: 'LipSyncStudio', vf: 'lip-sync' },
]

test.describe('studio cards wear the glass shell', () => {
  for (const s of STUDIOS) {
    test(`${s.type}: shell, Open bar rises on hover and stays while selected`, async ({ page }) => {
      await waitForBackend(page)
      await openBlankWorkflow(page)
      await page.mouse.move(700, 400)
      await page.evaluate((t) => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: t } })), s.type)
      const node = page.locator(`.vue-flow__node-${s.vf}`).first()
      await expect(node).toBeVisible()
      const card = node.locator('.node-shell').first()
      await expect(card).toBeVisible()

      const bar = node.locator('.node-openbar')
      const opacity = () => bar.evaluate(el => Number(getComputedStyle(el).opacity))
      expect(await opacity()).toBe(0)
      await node.locator('.node-well').hover()
      await expect.poll(opacity).toBe(1)

      await page.mouse.move(40, 800)
      await node.locator('.node-shell__head').click()
      await expect(card).toHaveAttribute('data-selected', 'true')
      await page.mouse.move(40, 800)
      await expect.poll(opacity).toBe(1)
    })
  }

  test('double-click on a studio card opens its studio', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await page.mouse.move(700, 400)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'GradientStudio' } })))
    const opened = page.evaluate(() => new Promise<string>(r => window.addEventListener('sailor:openGradientStudio', (e: any) => r(String(e.detail?.nodeId)), { once: true })))
    await page.locator('.vue-flow__node-gradient-studio .node-shell__head').dblclick()
    expect(await opened).not.toBe('undefined')
  })
})
```

The assertions that matter: `.node-shell` present, Open bar opacity 0 → 1 on hover, still 1 while selected with the pointer away, and double-click fires the open event.

- [ ] **Step 2: Run it**

Run: `cd frontend && npx playwright test tests/studio-shell.spec.ts --project=chromium`
Expected: PASS for every studio. If a studio's hover does not raise the bar, the host or the `data-selected` binding is wrong — fix the node, not the test.

- [ ] **Step 3: Screenshots for Julien**

In the same run (a throwaway addition, deleted afterwards) save one screenshot of each card at rest and one with the Open bar up to the session scratchpad, and list their paths in the report.

- [ ] **Step 4: Commit** (controller)

```bash
git commit -m "test(studios): every studio card wears the shell, its Open bar rises on hover and holds while selected, double-click opens"
```

---

## Self-review (done while writing)

- Spec "Studio": instrument dark glass shell and header ✓ (Tasks 2–7); preview only, in a well with 6px corners ✓ (`.node-well` radius is `--node-control-radius` 6px); Open bar rises on hover, stays while selected, left description / right Open ✓ (NodeOpenBar + Task 8); double-click anywhere opens ✓ (card `@dblclick.stop`, Pose guarded for its prompt box); footer only when there is something to run ✓ (Render, Generate; Shot Director / Lip-sync); Shot Director and Lip-sync: a short summary in the well ✓ (Task 5).
- "What stays exactly as it is": selection outline kept (radius only follows the card, Task 1 — ledger it); running/failed kept (Pose scoped CSS; others had none); wires untouched.
- Spec says "no settings rows on the node" — Pose keeps its mode switch and prompt box (inputs to Generate); ruling recorded in Task 6.
- Smart Layout: its generator-card chrome is stage 2's; only the body changes (Task 7).
- Names consistent: `useNodeGlass`, `NodeOpenBar`, `StudioRenderButton`, `onCardDblclick`, `summary`, `shellClass`/`shellTag`.
