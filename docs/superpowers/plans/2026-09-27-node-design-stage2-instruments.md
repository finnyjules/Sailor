# Node design, stage 2 (instruments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every instrument on the canvas — the generator/action node (`ComfyNode.vue`), Gate, Shader effect and Subgraph in/out — wears the stage 1 dark-glass shell, quieter 32px rows, a prompt well and a footer whose white Run button carries the price, without changing any node's logic.

**Architecture:** The shell is applied as **classes on each node's existing card root** (`node-shell`, plus `data-glass-blur` from `useNodeGlass`), not by wrapping nodes in `NodeShell.vue`. The generator node's collapse/expand animation measures that exact root element, and two browser tests pin its `comfy-node` / `node-head` class names, so the root stays the root. The row size and the Run button are threaded through the components that already draw them (`StudioRow` family, `NodeRunRow`).

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TS, Tailwind, `@vue-flow/core`, Vitest + @vue/test-utils (happy-dom), Playwright on the shared `:3002`.

**Spec:** `docs/superpowers/specs/2026-09-27-node-design-design.md` (sections "Rules every node follows" and "Instrument"). Stage 1 shipped `frontend/app/assets/css/node-surfaces.css`, `useCanvasGlass.ts` (`useNodeGlass`), `StudioRow` `size="comfortable"`, and the port hover.

## Global Constraints

- **Do not change** selection, running or failed states, wires, or the Note node. Keep `data-running` + its conic sweep CSS, `.comfy-node--muted`, `.comfy-node--bypassed`, `.comfy-node-stripes`, the error ring, and each node's own running style (Gate sweep, Shader effect ring).
- **Do not change logic**: no edits to `<script>` behaviour except what a task names (a prop, a computed for the glass, the NodeRunRow props). Widget handling, run dispatch, takes, previews, uploads, menus stay byte-for-byte.
- `ComfyNode.vue`'s Transition child root keeps class `comfy-node`, keeps containing `.node-head`, and stays the element `onUnfoldEnter` / `onFoldLeave` / `beginGrow` measure. Its width rules (260 / 208) and `minHeight` stay. `NodeCapsule.vue` must still match: 16px corners, same header offsets (7px in, 26px tile, 9px gap) — do not change the header's tile or padding geometry.
- Glass: `.node-shell` from `node-surfaces.css`; tint `rgba(26,26,28,.58)`, one even border `calc(1px / var(--canvas-zoom, 1))` at white 10%; no gradient fill or inner highlight inside a shell.
- Text weights: node text 500 (inherited from `.node-shell`), titles 600, buttons 600, price 500.
- The price appears **once**, on the Run button ("Run $0.03" / "Run again $0.03"); no price pill in the header, no price in the status text.
- Header actions (all settings, lock) appear on hover or while selected; state badges that report something (the seed lock while locked, "N fixes", subgraph count) stay visible.
- Rows on nodes: `size="comfortable"` (32px); 5px between rows; the 10px side inset stays owned by `ComfyNodeWidget` (`px-2.5`) — never add a second inset around it.
- UI copy: sentence case, no identifiers, no explanatory small text.
- **Shared checkout:** implementers never commit, never touch the git index, never run `npm run dev`, never restart `:3002`. `ComfyNode.vue` is edited often by other sessions — keep edits to the template/style regions named, and report exact line ranges so the controller can commit by hunk.
- Never add `will-change`, `translateZ` or forced layer promotion.

---

## File map

| File | Change |
|---|---|
| `frontend/app/components/vue-canvas/NodeRunRow.vue` | `variant: 'slim' \| 'instrument'` (default slim), `price`, `buttonText` props; instrument variant = status left + white Run button with price. |
| `frontend/app/components/vue-canvas/studio/StudioSlider.vue`, `StudioSelect.vue`, `StudioSwitch.vue` | Accept `size` and forward it to `StudioRow` (labelled branches only). |
| `frontend/app/components/vue-canvas/ComfyNodeWidget.vue` | Pass `size="comfortable"` to every row; prompt textarea gets the well look. |
| `frontend/app/components/vue-canvas/widgets/WidgetText.vue` | Multiline branch: well fill and padding (only if the implementer confirms it is used solely by node widgets; otherwise a `well` prop). |
| `frontend/app/components/vue-canvas/ComfyNode.vue` | Card root on the shell; header restyle + hover actions + no price pill; widgets gap 5px; footer uses the instrument Run row. |
| `frontend/app/components/vue-canvas/ComfyGateNode.vue`, `ShaderEffectNode.vue`, `SubgraphIONode.vue` | Roots on the shell, headers matched, Gate's buttons as node buttons, Shader effect rows comfortable. |
| `frontend/app/components/vue-canvas/studio/StudioSegmentedRow.vue`, `StudioSegmented.vue` | Quieter fills and labels to match StudioRow (parked from stage 1). |
| Tests | `tests/unit/node-run-row.unit.spec.ts` (new), `tests/unit/studio-row-size.unit.spec.ts` (extend), `tests/unit/instrument-shell.unit.spec.ts` (new, source guards), existing Playwright specs re-run. |

---

### Task 1: The instrument Run row

**Files:** Modify `frontend/app/components/vue-canvas/NodeRunRow.vue`; Test `frontend/tests/unit/node-run-row.unit.spec.ts`

**Interfaces — produces:** props `variant?: 'slim' | 'instrument'` (default `'slim'`, today's look, unchanged for the image/video/audio cards), `price?: string | null`, `buttonText?: string` (default `'Run'`). Emits and the `menu` slot unchanged.

- [ ] **Step 1: Failing tests**

```ts
// @vitest-environment happy-dom
// frontend/tests/unit/node-run-row.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NodeRunRow from '~/components/vue-canvas/NodeRunRow.vue'

const idle = { tone: 'idle' as const, text: 'Not run yet' }

describe('NodeRunRow', () => {
  it('slim variant is unchanged: 28px row, icon button, no price', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, price: '$0.03' } })
    expect(w.find('.node-run-row').classes()).toContain('h-7')
    expect(w.find('.node-btn--primary').exists()).toBe(false)
    expect(w.text()).not.toContain('$0.03')
  })
  it('instrument variant: white Run button carrying the price, status without it', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, price: '$0.03', variant: 'instrument' } })
    const btn = w.find('.node-btn--primary')
    expect(btn.text()).toContain('Run')
    expect(btn.find('.node-btn__price').text()).toBe('$0.03')
    expect(w.find('[data-run-status]').text()).toBe('Not run yet')
  })
  it('instrument variant uses the given button text', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, variant: 'instrument', buttonText: 'Run again' } })
    expect(w.find('.node-btn--primary').text()).toContain('Run again')
  })
  it('instrument variant while running: spinner, no price, disabled', () => {
    const w = mount(NodeRunRow, { props: { status: { tone: 'running', text: 'Running…' }, canRun: true, running: true, price: '$0.03', variant: 'instrument' } })
    const btn = w.find('.node-btn--primary')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.find('.node-btn__price').exists()).toBe(false)
    expect(btn.find('.animate-spin').exists()).toBe(true)
  })
  it('emits run on click when allowed', async () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, variant: 'instrument' } })
    await w.find('.node-btn--primary').trigger('click')
    expect(w.emitted('run')).toHaveLength(1)
  })
})
```

- [ ] **Step 2:** `cd frontend && npx vitest run tests/unit/node-run-row.unit.spec.ts` → FAIL (no variant).

- [ ] **Step 3: Implement.** Add the three props (defaults `variant: 'slim'`, `price: null`, `buttonText: 'Run'`). Keep the existing template as the `v-if="variant === 'slim'"` branch, byte-identical. Add the instrument branch:

```vue
<div
  v-else
  class="node-shell__foot node-run-row node-run-row--instrument"
  :data-tone="status.tone"
>
  <span class="shrink-0 size-1.5 rounded-full" :class="DOT[status.tone]" aria-hidden="true" />
  <span data-run-status class="flex-1 min-w-0 truncate text-[12px] text-white/55" :title="status.text">{{ status.text }}</span>
  <button
    type="button"
    class="nopan nodrag node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
    :aria-label="runLabel"
    :title="runLabel"
    :disabled="running || !canRun"
    @click.stop="onRun"
  >
    <Loader2 v-if="running" class="size-3 animate-spin" />
    <Play v-else class="size-2.5" fill="currentColor" />
    <span>{{ buttonText }}</span>
    <span v-if="price && !running" class="node-btn__price">{{ price }}</span>
  </button>
  <slot name="menu" />
</div>
```

Keep the `slim` branch's `data-slot`/classes exactly as today (image, video and audio cards use it until stage 4).

- [ ] **Step 4:** re-run → PASS (5).
- [ ] **Step 5:** controller commits `NodeRunRow.vue` + the spec — `feat(canvas): the instrument Run row — status left, white Run button carrying the price`.

---

### Task 2: Comfortable rows through the row family, and the prompt well

**Files:** Modify `studio/StudioSlider.vue`, `studio/StudioSelect.vue`, `studio/StudioSwitch.vue`, `ComfyNodeWidget.vue`, `widgets/WidgetText.vue`; Test: extend `frontend/tests/unit/studio-row-size.unit.spec.ts`

**Interfaces — produces:** `size?: 'compact' | 'comfortable'` on `StudioSlider`, `StudioSelect`, `StudioSwitch` (forwarded to `StudioRow` in their labelled branches; the unlabelled plain branches are unchanged). `WidgetText` multiline renders the prompt well.

- [ ] **Step 1: Failing tests** (append to `studio-row-size.unit.spec.ts`):

```ts
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'

describe('size reaches StudioRow through the row family', () => {
  it('StudioSlider', () => {
    const w = mount(StudioSlider, { props: { label: 'Strength', min: 0, max: 100, modelValue: 50, size: 'comfortable' } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-8')
  })
  it('StudioSelect (labelled)', () => {
    const w = mount(StudioSelect, { props: { label: 'Model', options: ['a', 'b'], modelValue: 'a', size: 'comfortable' } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-8')
  })
  it('StudioSwitch (labelled)', () => {
    const w = mount(StudioSwitch, { props: { label: 'Upscale', modelValue: true, size: 'comfortable' } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-8')
  })
  it('defaults stay compact', () => {
    const w = mount(StudioSlider, { props: { label: 'Strength', min: 0, max: 100, modelValue: 50 } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-7')
  })
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  1. Each of the three wrappers: add `size?: 'compact' | 'comfortable'` to its props and pass `:size="size"` on its `<StudioRow>` (labelled branch). Read each file's props block first; `StudioSwitch`'s `model` is `defineModel<boolean>`.
  2. `ComfyNodeWidget.vue`: add `size="comfortable"` to every `StudioSelect`, `StudioSwitch`, `StudioSlider` and `StudioRow` in the row branch (template ~lines 616–717). Leave the custom pickers (model, lora, voice, gimbals, gradient…) untouched in this stage.
  3. Prompt well: first `grep -rn "WidgetText" frontend/app` — if `WidgetText` is used only inside `ComfyNodeWidget.vue`, change its multiline `<textarea>` in place; otherwise add a `well?: boolean` prop and pass `well` from `ComfyNodeWidget`. The well look: keep `pastel-hairline` (the pastel ring marks an AI prompt), set `--pastel-hairline-bg: rgba(0,0,0,0.35)` (was `#404040`), padding `px-3 py-3` (12px), `min-h-[88px]`, `rounded-[6px]`, drop the `shadow-[…]` drop shadow (a well is recessed, not raised). Text stays 13px.
- [ ] **Step 4:** run the spec → PASS; also run `npx vitest run tests/unit -t "StudioSelect|StudioSwitch|StudioSlider|WidgetText|ComfyNodeWidget"` and report anything that pinned the old values.
- [ ] **Step 5:** controller commits the touched files — `feat(nodes): comfortable 32px rows on nodes through the row family; the prompt well`.

---

### Task 3: The generator node on the shell

**Files:** Modify `frontend/app/components/vue-canvas/ComfyNode.vue` (template ~1703–1819 card root and header, ~1874 widgets container, ~2295 footer; `<style scoped>` ~2357–2396); Test `frontend/tests/unit/instrument-shell.unit.spec.ts` (new)

**Interfaces — consumes:** Task 1 (`variant`, `price`, `buttonText`), Task 2 (rows), stage 1 `useNodeGlass` from `~/composables/useCanvasGlass`.

- [ ] **Step 1: Failing source-guard tests** (source-level, because mounting ComfyNode needs the whole canvas; behaviour is covered by the Playwright specs in Step 4):

```ts
// frontend/tests/unit/instrument-shell.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const src = (f: string) => readFileSync(fileURLToPath(new URL(`../../app/components/vue-canvas/${f}`, import.meta.url)), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'), s.lastIndexOf('</template>'))

describe('ComfyNode wears the instrument shell', () => {
  const s = src('ComfyNode.vue'), t = tpl(s)
  it('the card root keeps comfy-node and gains node-shell', () => {
    expect(t).toMatch(/key="card"[\s\S]{0,200}class="comfy-node node-shell /)
  })
  it('asks the canvas for real blur', () => {
    expect(s).toMatch(/useNodeGlass\(/)
    expect(t).toMatch(/:data-glass-blur="glass \|\| undefined"/)
  })
  it('no flat opaque background and no gradient header', () => {
    expect(t).not.toMatch(/'#1a1a1c'/)
    expect(t).not.toMatch(/linear-gradient\(135deg, \$\{accentColor\}15/)
  })
  it('no price pill in the header: the price rides the Run button', () => {
    expect(t).toMatch(/variant="instrument"[\s\S]{0,300}:price="priceLabel"/)
    expect(s).toMatch(/costLabel: null/)
  })
  it('settings live in the hover-only actions', () => {
    expect(t).toMatch(/class="node-shell__actions[^"]*"[\s\S]{0,600}SlidersHorizontal/)
  })
  it('rows sit 5px apart', () => {
    expect(t).toMatch(/flex flex-col gap-\[5px\]/)
  })
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (template/style only, plus the two script lines named):
  1. Script: `import { useNodeGlass } from '~/composables/useCanvasGlass'` and `const glass = useNodeGlass(() => props.id)` (check the prop name for the node id — the file uses `props.id` elsewhere, e.g. `NodeFixesBadge :node-id="id"`). In the `runStatus` computed change `costLabel: priceLabel.value` to `costLabel: null` (the price now rides the button). Do not touch anything else in the script.
  2. Card root (`key="card"`): class string starts `comfy-node node-shell relative z-10 select-none transition-opacity duration-150` — remove the `border` utility and the `'border-white/[0.06]': !data.isSubgraph` entry (the shell draws the border). Keep `'border-white/30': data.isSubgraph` but move it to an inline `borderColor: 'rgba(255,255,255,0.3)'` when `data.isSubgraph` (a Tailwind colour class would fight the shell's border shorthand). Add `:data-glass-blur="glass || undefined"`. Inline `background`: only when `data.bgcolor` → `color-mix(in srgb, ${data.bgcolor} 28%, rgba(26,26,28,0.58))`; otherwise no inline background (the shell tint shows). Keep `--border-color-left/right` and `minHeight`.
  3. Header: delete the accent gradient `<div>` (~line 1765, `linear-gradient(135deg, ${accentColor}15 …)`). Keep `.node-head` padding, gap and the 26px tile exactly (capsule continuity). Title span: weight 600 via the scoped `.node-head__title` rule. Remove the price pill (`v-else-if="priceLabel"`, ~1815–1818). Wrap the settings button (`SlidersHorizontal`) in `<div class="node-shell__actions">…</div>` so it shows on hover only. Seed lock: if locked it stays visible; if unlocked it joins the hover-only actions (render it inside the actions wrapper when `!seedLocked`, outside when locked — reuse the existing locked flag the button already reads). `NodeFixesBadge` and the subgraph count pill stay visible. Keep the seed-lock `title` strings exactly (a unit test matches `/Lock the seed|Seed locked/`).
  4. `.node-shell__actions` shows on `.node-shell:hover`; the node isn't given `data-selected` today (selection is drawn by Vue Flow) — do not add selection styling.
  5. Widgets container (~1878): `class="py-4 flex flex-col gap-2"` → `class="py-3 flex flex-col gap-[5px]"`. Nothing else in the widgets block changes.
  6. Footer: `<NodeRunRow variant="instrument" :price="priceLabel" :button-text="hasRun ? 'Run again' : 'Run'" …>` keeping every existing prop, the `v-if` and the `#menu` slot untouched.
  7. Scoped style: `.comfy-node` keep `border-radius: 16px`; delete its `box-shadow` (the shell's shadow applies) and update its comment to say the shell draws fill, border and shadow. `.node-head__title > span` gets `font-weight: 600`. Do not touch `data-running`, muted, bypassed, stripes, capsule-swap or ticker rules.
- [ ] **Step 4: Verify.**
  - `npx vitest run tests/unit/instrument-shell.unit.spec.ts tests/unit/product-shot-hidden-settings.unit.spec.ts tests/unit/model-lineup-h2.unit.spec.ts tests/unit/lipsync-seconds.unit.spec.ts tests/unit/run-row-status.unit.spec.ts`
  - `npx playwright test tests/capsule-expand-timing.spec.ts tests/node-capsule.spec.ts tests/groups-context-menu.spec.ts` (existing `:3002`; if a spec was already red before your change — check with `git stash`-free means: run it once BEFORE editing and record the result — report it rather than chase it).
  - A screenshot through Playwright of a project with a Generate an image node expanded and selected, saved to the scratchpad path the controller gives you, plus one of the same node collapsed to its capsule.
- [ ] **Step 5:** controller commits `ComfyNode.vue` by hunk + the spec — `feat(nodes): the generator node wears the instrument shell — glass, quiet header, rows 5px apart, price on Run`.

---

### Task 4: Gate, Shader effect and Subgraph in/out on the shell

**Files:** Modify `ComfyGateNode.vue`, `ShaderEffectNode.vue`, `SubgraphIONode.vue`; Test: extend `frontend/tests/unit/instrument-shell.unit.spec.ts`

- [ ] **Step 1: Failing guards** (append):

```ts
describe.each(['ComfyGateNode.vue', 'ShaderEffectNode.vue', 'SubgraphIONode.vue'])('%s wears the shell', (f) => {
  const s = src(f), t = tpl(s)
  it('root carries node-shell and asks for glass', () => {
    expect(t).toMatch(/class="[^"]*\bnode-shell\b/)
    expect(s).toMatch(/useNodeGlass\(/)
  })
  it('no rounded-xl border card of its own', () => {
    expect(t).not.toMatch(/rounded-xl border/)
  })
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - Each root: replace `rounded-xl border border-white/10` (or `/30`) and any own background/`backdrop-blur-sm` with `node-shell`; add `:data-glass-blur` from `useNodeGlass(() => props.id)`; keep widths (Gate 260, Shader effect 288, Subgraph `min-w-[180px]`), `minHeight`, `data-running` and each node's running CSS. SubgraphIO keeps a visible border (inline `borderColor: 'rgba(255,255,255,0.3)'`) — it is a signal. Delete each file's now-redundant root `background`/`box-shadow` in its scoped style.
  - Headers: title weight 600, 13px, no gradient; Shader effect's play/pause preview button stays where it is (it is a control, not a status).
  - Gate buttons: the main action (Continue / Continue again) becomes `node-btn node-btn--primary`; Restart and Redo become `node-btn`. Keep the `data-tooltip` / `.gate-btn::after` tooltips and every handler.
  - Shader effect: its `StudioSlider`s get `size="comfortable"`; the effect picker and selects unchanged; `data-testid`s unchanged.
- [ ] **Step 4:** `npx vitest run tests/unit/instrument-shell.unit.spec.ts tests/unit/shader-effect-node-takes.unit.spec.ts`; screenshots of each node on a canvas (Playwright).
- [ ] **Step 5:** controller commits — `feat(nodes): Gate, Shader effect and Subgraph in/out wear the instrument shell`.

---

### Task 5: Segmented rows match the quieter rows

**Files:** Modify `studio/StudioSegmentedRow.vue`, `studio/StudioSegmented.vue`; Test: extend `studio-row-size.unit.spec.ts`

- [ ] **Step 1:** test that a mounted `StudioSegmentedRow` (read its props first) has a `bg-white/[0.03]` row and a `text-white/55` label, and `StudioSegmented`'s track uses `bg-white/[0.03]`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** replace `bg-white/[0.05]` with `bg-white/[0.03]` (hover `.065` where a hover exists) and `text-white/72` with `text-white/55` in these two files only.
- [ ] **Step 4:** run → PASS; run `npx vitest run tests/unit -t "Segmented"`.
- [ ] **Step 5:** controller commits — `fix(studio): segmented rows take the quieter fills`.

---

## After stage 2

- Live look on the real canvas with Julien (the glass now blurs on real nodes: this is the first real-world check of always-on blur).
- Dashboard + memory update.
- Stage 3 plan (studios: preview well, rising Open bar, footer only when something runs).
