# AI in Sailor, stage 2: the one prompt on the canvas, and the node toolbar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the one shared prompt component and put it on the canvas in place of today's prompt, with selection chips, suggestions, and progress with Stop. Remove Explain. Then give nodes a floating Edit ▾ / Develop ▾ toolbar, a multi-select bar, a slim Run row, and a "fixes" badge.

**Architecture:**
- **`SailorPrompt.vue`** is presentational and knows nothing about the canvas. Hosts pass in the selection label, a mode, suggestions and the working state, and put result cards in its `above` slot. Its look is Sailor's existing AI look: the dark field, the rotating pastel ring and the glimm sweep. The small pure rules (placeholder text, Esc steps, which keys focus it) live in `lib/prompt/sailorPrompt.ts`.
- **`CanvasPromptBar.vue`** keeps all its agent logic (`useCanvasAgent`, sketch fast path, image search, auto-review) and swaps only its markup for `SailorPrompt`. `useCanvasAgent` gains `stop()`.
- **Node toolbar.**
  - `lib/canvas/nodeActions.ts` is one registry of per-node actions, grouped Edit/Develop, each firing exactly the window event the node menus fire today.
  - `NodeActionToolbar.vue` renders it in screen space above the selection. It is mounted once inside `VueNodeCanvas.vue`, positioned from Vue Flow's viewport.
  - The per-node Edit…/Develop… footers and `SelectionActionChips` are removed.
- **Part A (Tasks 1–5) ships on its own.** Part B (Tasks 6–10) builds on it. Task 11 is verification.

**Tech stack:** Nuxt 4 (Vue 3 + TypeScript + Tailwind), Vue Flow (`@vue-flow/core`), `lucide-vue-next` icons, the `glimm` sweep through `components/agent/AgentSweep.vue`, Vitest (`tests/unit/**/*.unit.spec.ts`, happy-dom opt-in by docblock), Playwright (`tests/*.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md`. This plan is build stage 2 of §9. It covers §1.2, §1.4, §2.1, §2.1a, §2.3, §3.4, and the Explain, Critique and `NextStepsStrip` rows of §5.

**Mockup:** `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/one-prompt-everywhere.html` (open it over http). The prompt must match it.

Not in this plan:
- **Stage 3:**
  - takes strips above the prompt with the target node carrying the pastel ring;
  - proposed nodes on the canvas;
  - the answer card with follow-up chips;
  - the router (§4);
  - mode chips set by menu items (the prop exists here, but nothing sets it yet).
- **Stage 4:** studios, and the guard test "only `SailorPrompt` renders an instruction prompt" (it can only pass once `AgentBar` and `VibeControlBar` are gone).

## Global constraints

- **Work in the main checkout** (`/Users/julien/Documents/GitHub/Sailor`), on `main`. No worktree, no branch, never `git stash`. Other sessions share this checkout: leave files you didn't change alone, even if they look broken.
- **Commit only your own paths, through a private index, in two shell calls:**
  1. `cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- <your paths> && git commit -q -m "<msg>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; echo "rc=$? $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"`
  2. Then, in a separate call: `cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <the same paths>`

  A deleted file is committed with `git rm --cached -q -- <path>` in place of `git add` (inside the same private-index call). Prove the commit by HEAD moving, not by printing HEAD.
- **Never run `npm run dev`, `nuxt dev`, or start or kill any server.** The shared dev server on `:3002` belongs to the controller. Playwright specs are written by the implementer and run by the controller.
- **Unit tests:** `cd frontend && npx vitest run <spec paths>` for your specs, then `npx vitest run` for the whole unit suite before you report.
- **Typecheck:** `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "<your file names>"`. The repo has a large standing baseline, so judge only lines naming your files. Compare against the base commit before calling any error pre-existing (`git stash` is forbidden; use `git show <BASE>:<path>` into a scratch copy if you need to).
- **Every new Nitro route** must be listed in `frontend/server/lib/nitroApiPaths.ts`. None are added here; one is removed (Task 5).
- **UI copy:**
  - sentence case, no internal identifiers;
  - labels quote the user's own content (a node's own title), never a guessed role;
  - "Remove BG" becomes "Remove background".
- **Pastel means AI.** The pastel ring and the glimm are for AI surfaces only. Selection chips and suggestion pills are neutral.
- **The prompt's look is fixed by spec §2.1a.** Hosts never restyle it.

---

# Part A: the one prompt on the canvas

### Task 1: `SailorPrompt` — the shared prompt component

**Files:**
- Create: `frontend/app/lib/prompt/sailorPrompt.ts`
- Create: `frontend/app/components/prompt/SailorPrompt.vue`
- Test: `frontend/tests/unit/sailor-prompt-rules.unit.spec.ts`
- Test: `frontend/tests/unit/sailor-prompt.unit.spec.ts`

**Interfaces:**
- Produces:
  - `promptPlaceholder(selectionLabel?: string | null): string`
  - `escapeStep(s: { text: string; mode: string | null }): 'clearMode' | 'blur'`
  - `isEditableTarget(t: unknown): boolean`
  - `shouldFocusPrompt(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): boolean`
  - `SailorPrompt.vue`:
    - props: `selectionLabel?: string | null`, `mode?: string | null`, `suggestions?: string[]`, `working?: boolean`, `workingLabel?: string`, `stoppable?: boolean`, `disabled?: boolean`
    - emits: `submit(text: string)`, `stop()`, `clearSelection()`, `clearMode()`, `focus()`, `blur()`
    - slot `above`
    - exposes `focus(): void`
  - Auto-import name `PromptSailorPrompt`. Import it explicitly anyway: `import SailorPrompt from '~/components/prompt/SailorPrompt.vue'`.

- [ ] **Step 1: Write the failing rules test**

```ts
// frontend/tests/unit/sailor-prompt-rules.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { promptPlaceholder, escapeStep, isEditableTarget, shouldFocusPrompt } from '~/lib/prompt/sailorPrompt'

const key = (k: string, o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...o })

describe('promptPlaceholder', () => {
  it('asks Sailor with nothing selected', () => expect(promptPlaceholder(null)).toBe('Ask Sailor'))
  it('quotes the selection', () => expect(promptPlaceholder('Rainy shop')).toBe('Change or ask about Rainy shop'))
  it('treats a blank label as nothing selected', () => expect(promptPlaceholder('  ')).toBe('Ask Sailor'))
})

describe('escapeStep', () => {
  it('clears the mode first on an empty field', () => expect(escapeStep({ text: '', mode: 'Remix' })).toBe('clearMode'))
  it('leaves the field when there is text', () => expect(escapeStep({ text: 'rain', mode: 'Remix' })).toBe('blur'))
  it('leaves the field when there is no mode', () => expect(escapeStep({ text: '', mode: null })).toBe('blur'))
})

describe('isEditableTarget', () => {
  it('knows inputs, textareas, selects and contenteditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('shouldFocusPrompt', () => {
  it('focuses on / outside a field', () => expect(shouldFocusPrompt(key('/'))).toBe(true))
  it('ignores / while typing in a field', () => expect(shouldFocusPrompt(key('/', { target: { tagName: 'INPUT' } }))).toBe(false))
  it('ignores / with a modifier', () => expect(shouldFocusPrompt(key('/', { metaKey: true }))).toBe(false))
  it('focuses on ⌘K and Ctrl+K, even from a field', () => {
    expect(shouldFocusPrompt(key('k', { metaKey: true }))).toBe(true)
    expect(shouldFocusPrompt(key('K', { ctrlKey: true, target: { tagName: 'INPUT' } }))).toBe(true)
  })
  it('ignores ⌥⌘K and plain k', () => {
    expect(shouldFocusPrompt(key('k', { metaKey: true, altKey: true }))).toBe(false)
    expect(shouldFocusPrompt(key('k'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/sailor-prompt-rules.unit.spec.ts`
Expected: FAIL, because the module `~/lib/prompt/sailorPrompt` doesn't exist.

- [ ] **Step 3: Write the rules**

```ts
// frontend/app/lib/prompt/sailorPrompt.ts
// The small rules behind the one prompt (spec §2.1, §2.1a). Pure, so the
// component and every host agree on them and they can be tested without a DOM.

export function promptPlaceholder(selectionLabel?: string | null): string {
  const label = selectionLabel?.trim()
  return label ? `Change or ask about ${label}` : 'Ask Sailor'
}

/** Esc clears a mode chip first (only on an empty field), then leaves the field. */
export function escapeStep(s: { text: string; mode: string | null }): 'clearMode' | 'blur' {
  return !s.text.trim() && s.mode ? 'clearMode' : 'blur'
}

export function isEditableTarget(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false
  const el = t as { tagName?: unknown; isContentEditable?: unknown }
  const tag = String(el.tagName ?? '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

/** `/` outside a field, or ⌘K / Ctrl+K anywhere, focuses the prompt. */
export function shouldFocusPrompt(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): boolean {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return true
  return e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd frontend && npx vitest run tests/unit/sailor-prompt-rules.unit.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Write the failing component test**

```ts
// frontend/tests/unit/sailor-prompt.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'

const stubs = { AgentSweep: true }
const input = (w: any) => w.get('input[aria-label="Ask Sailor"]')

describe('SailorPrompt', () => {
  it('shows the selection as a chip and in the placeholder', () => {
    const w = mount(SailorPrompt, { props: { selectionLabel: 'Rainy shop' }, global: { stubs } })
    expect(w.get('[data-testid="prompt-selection-chip"]').text()).toContain('Rainy shop')
    expect(input(w).attributes('placeholder')).toBe('Change or ask about Rainy shop')
  })

  it('submits trimmed text on Enter and clears the field', async () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    await input(w).setValue('  make it rain  ')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('submit')).toEqual([['make it rain']])
    expect((input(w).element as HTMLInputElement).value).toBe('')
  })

  it('does not submit an empty field', async () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('shows suggestions only while focused, and a click submits one', async () => {
    const w = mount(SailorPrompt, { props: { suggestions: ['What does this do?'] }, global: { stubs } })
    expect(w.find('[data-testid="prompt-suggestions"]').exists()).toBe(false)
    await input(w).trigger('focus')
    const pill = w.get('[data-testid="prompt-suggestions"] button')
    expect(pill.text()).toBe('What does this do?')
    await pill.trigger('mousedown')
    expect(w.emitted('submit')).toEqual([['What does this do?']])
  })

  it('Esc clears the mode on an empty field, then blurs', async () => {
    const w = mount(SailorPrompt, { props: { mode: 'Remix' }, global: { stubs } })
    await input(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('clearMode')).toHaveLength(1)
    await w.setProps({ mode: null })
    await input(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('blur')?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('while working shows the label and Stop instead of the field', async () => {
    const w = mount(SailorPrompt, { props: { working: true, workingLabel: 'Planning the change…' }, global: { stubs } })
    expect(w.find('input[aria-label="Ask Sailor"]').exists()).toBe(false)
    expect(w.text()).toContain('Planning the change…')
    await w.get('button[data-testid="prompt-stop"]').trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })

  it('hides Stop when the work cannot be stopped', () => {
    const w = mount(SailorPrompt, { props: { working: true, stoppable: false }, global: { stubs } })
    expect(w.find('button[data-testid="prompt-stop"]').exists()).toBe(false)
  })

  it('clearing the chip emits clearSelection', async () => {
    const w = mount(SailorPrompt, { props: { selectionLabel: 'Poster' }, global: { stubs } })
    await w.get('[data-testid="prompt-selection-chip"] button').trigger('click')
    expect(w.emitted('clearSelection')).toHaveLength(1)
  })

  it('renders the above slot in the shared card', () => {
    const w = mount(SailorPrompt, { slots: { above: '<p class="probe">Hello</p>' }, global: { stubs } })
    expect(w.get('[data-testid="prompt-card"] .probe').text()).toBe('Hello')
  })
})
```

- [ ] **Step 6: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/sailor-prompt.unit.spec.ts`
Expected: FAIL, because `SailorPrompt.vue` doesn't exist.

- [ ] **Step 7: Write the component**

The look comes from `CanvasPromptBar.vue`'s `.prompt-field` (dark `#1a1a1a`, 12px corners, the masked conic pastel ring on the global `--pastel-angle`, faint at rest). The glimm is `AgentSweep` with `palette="lagoon" :period="3"`, as `CanvasPromptBar` uses it today. Match the mockup.

```vue
<!-- frontend/app/components/prompt/SailorPrompt.vue -->
<script setup lang="ts">
// The one prompt (spec §2.1a). Identical everywhere; hosts supply only context
// (selection label, mode, suggestions, working state) and put result cards in
// the `above` slot. Never restyle this from a host — change it here.
import { computed, ref } from 'vue'
import { ArrowUp, Sparkles, X } from 'lucide-vue-next'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import { escapeStep, promptPlaceholder } from '~/lib/prompt/sailorPrompt'

const props = withDefaults(defineProps<{
  selectionLabel?: string | null
  mode?: string | null
  suggestions?: string[]
  working?: boolean
  workingLabel?: string
  stoppable?: boolean
  disabled?: boolean
}>(), { selectionLabel: null, mode: null, suggestions: () => [], working: false, workingLabel: 'Working…', stoppable: true, disabled: false })

const emit = defineEmits<{ submit: [text: string]; stop: []; clearSelection: []; clearMode: []; focus: []; blur: [] }>()

const text = ref('')
const focused = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const placeholder = computed(() => promptPlaceholder(props.selectionLabel))
const showSuggestions = computed(() => focused.value && !props.working && props.suggestions.length > 0)

function submit(value = text.value) {
  const t = value.trim()
  if (!t || props.working || props.disabled) return
  emit('submit', t)
  text.value = ''
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); submit(); return }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (escapeStep({ text: text.value, mode: props.mode }) === 'clearMode') emit('clearMode')
    else { focused.value = false; emit('blur'); inputEl.value?.blur() }
  }
}
function onFocus() { focused.value = true; emit('focus') }
function onBlur() { if (!focused.value) return; focused.value = false; emit('blur') } // Esc already emitted when it set focused=false
function focus() { inputEl.value?.focus() }
defineExpose({ focus })
</script>

<template>
  <div class="sailor-prompt pointer-events-none flex w-full min-w-0 flex-col gap-2">
    <div v-if="showSuggestions" data-testid="prompt-suggestions" class="pointer-events-auto flex flex-wrap justify-center gap-1.5">
      <button
        v-for="s in suggestions" :key="s" type="button"
        class="rounded-full border border-[#2a2a2a] bg-[#1e1f23] px-3 py-1 text-[12px] text-white/75 shadow-md transition hover:border-white/30 hover:text-white"
        @mousedown.prevent="submit(s)"
      >{{ s }}</button>
    </div>

    <div v-if="$slots.above" data-testid="prompt-card" class="pointer-events-auto relative max-h-[52vh] overflow-y-auto rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-3 shadow-xl backdrop-blur-md">
      <slot name="above" />
    </div>

    <div
      class="sp-row pointer-events-auto relative flex h-12 items-center gap-2.5 overflow-hidden rounded-[12px] pl-3.5 pr-2.5 shadow-lg"
      :class="{ 'is-active': focused || working }"
      @click="focus"
    >
      <div v-if="working" class="pointer-events-none absolute inset-0"><AgentSweep :active="working" :period="3" palette="lagoon" /></div>
      <Sparkles class="relative size-4 shrink-0 text-white/45" />
      <template v-if="working">
        <span class="relative min-w-0 flex-1 truncate text-[13px] text-white/75">{{ workingLabel }}</span>
        <button
          v-if="stoppable" data-testid="prompt-stop" type="button"
          class="relative rounded-md border border-[#2a2a2a] bg-[#1e1f23] px-2.5 py-0.5 text-[12px] text-white/80 hover:text-white"
          @click.stop="emit('stop')"
        >Stop</button>
      </template>
      <template v-else>
        <span v-if="mode" data-testid="prompt-mode-chip" class="relative inline-flex max-w-[40%] shrink-0 items-center truncate rounded-full bg-white/[0.08] py-0.5 pl-2.5 pr-1 text-[12px] text-white/80">
          {{ mode }}<button type="button" class="px-1 text-white/50 hover:text-white" aria-label="Clear mode" @click.stop="emit('clearMode')"><X class="size-3" /></button>
        </span>
        <span v-if="selectionLabel" data-testid="prompt-selection-chip" class="relative inline-flex max-w-[40%] shrink-0 items-center truncate rounded-full bg-white/[0.08] py-0.5 pl-2.5 pr-1 text-[12px] text-white/80">
          {{ selectionLabel }}<button type="button" class="px-1 text-white/50 hover:text-white" aria-label="Clear selection" @click.stop="emit('clearSelection')"><X class="size-3" /></button>
        </span>
        <input
          ref="inputEl" v-model="text" type="text" aria-label="Ask Sailor"
          :placeholder="placeholder" :disabled="disabled"
          class="relative min-w-0 flex-1 bg-transparent text-[13px] text-white/90 outline-none placeholder:text-white/30"
          @keydown="onKeydown" @focus="onFocus" @blur="onBlur"
        >
        <kbd v-if="!focused" class="relative rounded border border-white/10 px-1.5 font-mono text-[11px] text-white/35">/</kbd>
        <button
          type="button" aria-label="Send"
          class="relative grid size-7 place-items-center rounded-[8px] bg-white text-neutral-900 transition hover:bg-white/90 disabled:opacity-40"
          :disabled="disabled || !text.trim()" @click.stop="submit()"
        ><ArrowUp class="size-4" /></button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sp-row { background: #1a1a1a; }
/* The pastel ring (same primitive as the canvas prompt and proposed nodes):
   a masked conic on the global --pastel-angle, faint at rest, full when active. */
.sp-row::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from var(--pastel-angle), #ffd6e7, #cfe8ff, #d6ffe0, #fff4cc, #e7d6ff, #ffd6e7);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  opacity: 0.4;
  transition: opacity 0.4s ease;
  animation: pastel-spin 8s linear infinite;
  pointer-events: none;
  z-index: 1;
}
.sp-row.is-active::before { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .sp-row::before { animation: none; } }
</style>
```

`pastel-spin` and `--pastel-angle` are global in `frontend/app/assets/css/main.css`. Don't redeclare them.

- [ ] **Step 8: Run both tests and see them pass**

Run: `cd frontend && npx vitest run tests/unit/sailor-prompt-rules.unit.spec.ts tests/unit/sailor-prompt.unit.spec.ts`
Expected: PASS. If happy-dom's `setValue` doesn't update `v-model`, trigger `input` after setting `element.value`. Don't weaken any assertion.

- [ ] **Step 9: Typecheck and commit**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "SailorPrompt|sailorPrompt"`. Expected: no lines.
Commit with the private-index recipe:
- paths: `frontend/app/lib/prompt/sailorPrompt.ts`, `frontend/app/components/prompt/SailorPrompt.vue` and the two specs
- message: `feat(prompt): SailorPrompt — the one prompt component (pastel ring, glimm, chips, suggestions, Stop)`

---

### Task 2: Stop for the canvas agent

**Files:**
- Modify: `frontend/app/composables/useCanvasAgent.ts` (the `callModel` function, ~84-94; `ask`, ~117-209; the return, ~382)
- Test: `frontend/tests/unit/canvas-agent-stop.unit.spec.ts`

**Interfaces:**
- Produces: `useCanvasAgent(...)` also returns `stop(): void`. After `stop()`:
  - `busy` is false;
  - the in-flight `/api/agent-plan` request is aborted;
  - any ghost preview is discarded;
  - a late reply changes nothing.

- [ ] **Step 1: Write the failing test**

Look at `tests/unit/agent-canvas-surface.unit.spec.ts` first, for how agent code is imported and for a minimal `CanvasSnapshot`. If `describeCanvas` needs more than empty arrays, use that file's smallest fixture as `EMPTY`.

```ts
// frontend/tests/unit/canvas-agent-stop.unit.spec.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useCanvasAgent } from '~/composables/useCanvasAgent'

const EMPTY = { nodes: [], edges: [] } as any

afterEach(() => { delete (globalThis as any).$fetch })

describe('useCanvasAgent.stop', () => {
  it('aborts the call, clears busy, and ignores the late reply', async () => {
    let seenSignal: AbortSignal | undefined
    let reply!: (v: unknown) => void
    ;(globalThis as any).$fetch = vi.fn((_url: string, o: any) => {
      seenSignal = o.signal
      return new Promise(r => { reply = r })
    })
    const discard = vi.fn()
    const agent = useCanvasAgent({
      getSnapshot: () => EMPTY, preview: vi.fn(), commit: () => [], discard, apiKey: () => 'k',
    } as any)

    const pending = agent.ask('add an upscale')
    await Promise.resolve()
    expect(agent.busy.value).toBe(true)

    agent.stop()
    expect(agent.busy.value).toBe(false)
    expect(seenSignal?.aborted).toBe(true)
    expect(discard).toHaveBeenCalled()

    reply({ text: JSON.stringify({ reasoning: '', commands: [], message: 'too late' }) })
    await pending
    expect(agent.answer.value).toBe('')
    expect(agent.error.value).toBe('')
    expect(agent.busy.value).toBe(false)
  })

  it('does nothing when idle', () => {
    const discard = vi.fn()
    const agent = useCanvasAgent({ getSnapshot: () => EMPTY, preview: vi.fn(), commit: () => [], discard, apiKey: () => '' } as any)
    agent.stop()
    expect(discard).not.toHaveBeenCalled()
    expect(agent.busy.value).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/canvas-agent-stop.unit.spec.ts`
Expected: FAIL, because `agent.stop is not a function`.

- [ ] **Step 3: Implement**

In `useCanvasAgent.ts`:

```ts
// near the other module-local state inside useCanvasAgent
let controller: AbortController | null = null
let runSeq = 0 // bumps on every ask and every stop; a reply for an older seq is ignored
```

`callModel` takes an optional signal and passes it to `$fetch`:

```ts
async function callModel(prompt: string, commands: { op: string }[], signal?: AbortSignal) {
  const res = await $fetch<{ text: string }>('/api/agent-plan', {
    method: 'POST',
    body: { apiKey: opts.apiKey(), tier: opts.tier ?? 'plan', prompt, schema: buildCommandSchema(commands) },
    timeout: 60_000,
    signal,
  })
  // …unchanged below
}
```

Changes in `ask`:
- At the start, after the `busy` guard: `const seq = ++runSeq; controller = new AbortController()`.
- Call `callModel(buildAgentPrompt(desc, p), desc.commands, controller.signal)`.
- Immediately after **every** `await` inside the `try` (the `callModel` await, the 1800 ms blueprint wait, and `opts.tune`), add `if (seq !== runSeq) return`.
- In `catch`, the first line is `if (seq !== runSeq) return` (an aborted fetch throws; that isn't an error to show).
- In `finally`: `if (seq === runSeq) { busy.value = false; controller = null }`.

Add:

```ts
function stop() {
  if (!busy.value) return
  runSeq++
  controller?.abort()
  controller = null
  opts.discard(); opts.tuneRevert?.()
  changes.value = []; answer.value = ''; error.value = ''; issues.value = []; reasoning.value = ''
  busy.value = false
}
```

Add `stop` to the returned object. `reroll` keeps calling `callModel` without a signal.

- [ ] **Step 4: Run the test, then the agent suites**

Run: `cd frontend && npx vitest run tests/unit/canvas-agent-stop.unit.spec.ts && npx vitest run tests/unit/agent-`
Expected: PASS, with no regressions in the `agent-*` specs.

- [ ] **Step 5: Commit**

Commit:
- paths: `frontend/app/composables/useCanvasAgent.ts` and the spec
- message: `feat(agent): Stop for canvas requests — abort the plan call, ignore late replies`

---

### Task 3: What the canvas tells the prompt (selection and suggestions)

**Files:**
- Create: `frontend/app/lib/prompt/canvasPromptContext.ts`
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (`defineExpose({` at ~7994; the selection helpers at ~1163-1175)
- Test: `frontend/tests/unit/canvas-prompt-context.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface PromptNode { id: string; title: string; type: string; hasImages: boolean }`
  - `selectionLabel(sel: PromptNode[]): string | null`
  - `canvasSuggestions(sel: PromptNode[], graphEmpty: boolean): string[]`
  - Exposed on the `VueNodeCanvas` instance:
    - `agentSelection: PromptNode[]` (a reactive computed; parents read it unwrapped)
    - `agentClearSelection(): void`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/canvas-prompt-context.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { selectionLabel, canvasSuggestions, type PromptNode } from '~/lib/prompt/canvasPromptContext'

const n = (title: string, type = 'ComfyNode', hasImages = false): PromptNode => ({ id: title || type, title, type, hasImages })

describe('selectionLabel', () => {
  it('is null with nothing selected', () => expect(selectionLabel([])).toBeNull())
  it('uses the node’s own title', () => expect(selectionLabel([n('Rainy shop')])).toBe('Rainy shop'))
  it('falls back to the type when the title is blank', () => expect(selectionLabel([n('  ', 'GradientStudio')])).toBe('GradientStudio'))
  it('counts several nodes', () => expect(selectionLabel([n('A'), n('B'), n('C')])).toBe('3 nodes'))
})

describe('canvasSuggestions', () => {
  it('offers ideas on an empty canvas', () => {
    expect(canvasSuggestions([], true)).toEqual(['A red fox in the snow', 'What can Sailor make?'])
  })
  it('asks about the graph when nothing is selected', () => {
    expect(canvasSuggestions([], false)).toEqual(['What does this graph do?', 'What should I try next?'])
  })
  it('offers image moves for a node with images', () => {
    expect(canvasSuggestions([n('Rainy shop', 'artifact-image', true)], false)).toEqual(['What does this do?', 'Make it warmer', 'Upscale it'])
  })
  it('asks about a single node without images', () => {
    expect(canvasSuggestions([n('Poster')], false)).toEqual(['What does this do?', 'What can I connect to this?'])
  })
  it('asks about several nodes', () => {
    expect(canvasSuggestions([n('A'), n('B')], false)).toEqual(['What do these do?', 'Connect these'])
  })
  it('never offers more than three', () => {
    for (const sel of [[], [n('A', 'artifact-image', true)], [n('A'), n('B')]]) expect(canvasSuggestions(sel, false).length).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/canvas-prompt-context.unit.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the helpers**

```ts
// frontend/app/lib/prompt/canvasPromptContext.ts
// What the canvas tells the one prompt: a chip label for the selection and 2–3
// suggestions. Labels quote the node's own title (UI-copy rule), never a role.
// "What does this do?" is how Explain is reached now (spec §5).

export interface PromptNode { id: string; title: string; type: string; hasImages: boolean }

export function selectionLabel(sel: PromptNode[]): string | null {
  if (!sel.length) return null
  if (sel.length > 1) return `${sel.length} nodes`
  const only = sel[0]!
  return only.title.trim() || only.type
}

export function canvasSuggestions(sel: PromptNode[], graphEmpty: boolean): string[] {
  if (!sel.length) return graphEmpty ? ['A red fox in the snow', 'What can Sailor make?'] : ['What does this graph do?', 'What should I try next?']
  if (sel.length > 1) return ['What do these do?', 'Connect these']
  return sel[0]!.hasImages ? ['What does this do?', 'Make it warmer', 'Upscale it'] : ['What does this do?', 'What can I connect to this?']
}
```

- [ ] **Step 4: Expose selection from `VueNodeCanvas.vue`**

Next to the existing selection helpers (~1163-1175), add:

```ts
import type { PromptNode } from '~/lib/prompt/canvasPromptContext'
// The one prompt's selection chip + suggestions (spec §1.2). Title is the node's
// own title (custom → catalog display_name → type), exactly as the card shows it.
const agentSelection = computed<PromptNode[]>(() => (nodes.value as any[])
  .filter(n => n.selected)
  .map(n => ({
    id: String(n.id),
    title: String(n.data?.subgraphName || n.data?.title || ''),
    type: String(n.type === 'default' || !n.type ? (n.data?.type ?? '') : n.type),
    hasImages: Array.isArray(n.data?.images) && n.data.images.length > 0,
  })))
function agentClearSelection() { for (const n of nodes.value as any[]) n.selected = false }
```

Add `agentSelection` and `agentClearSelection` to `defineExpose({ … })`. For generic Comfy nodes, check which field holds the backend type (`n.type` or `n.data.type`), and make `type` the backend type for them and the Vue Flow type (`artifact-image`, …) for artifact nodes. Write down in your report what you found.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/canvas-prompt-context.unit.spec.ts`
Expected: PASS.
Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "canvasPromptContext|VueNodeCanvas.vue"`. Compare against BASE: there must be no new VueNodeCanvas lines.

- [ ] **Step 6: Commit**

Commit:
- paths: `canvasPromptContext.ts`, `VueNodeCanvas.vue` and the spec
- message: `feat(prompt): canvas selection label + suggestions for the one prompt`

Stage only your own hunks of `VueNodeCanvas.vue`. It had uncommitted changes from another session at plan time (`git status` showed `M`). In your private index, apply only your hunks: `git diff -- <file> > /tmp/x.patch`, edit it down to your hunks, then `git apply --cached /tmp/x.patch` with `GIT_INDEX_FILE` set. Don't commit someone else's hunks.

---

### Task 4: The canvas prompt runs on `SailorPrompt`, with `/` and ⌘K

**Files:**
- Modify: `frontend/app/components/agent/CanvasPromptBar.vue` (template ~201-275, style ~277-314, `go()` ~164-179)
- Modify: `frontend/app/layouts/default.vue` (`handleGlobalKeydown` ~3010-3026; the `AgentCanvasPromptBar` mount in `canvas-bottom-bar-stack` ~4187-4193)
- Modify: `frontend/tests/agent-fastlane.spec.ts` (`readyBar()` selector)
- Create: `frontend/tests/sailor-prompt.spec.ts` (Playwright; the controller runs it)

**Interfaces:**
- Consumes: `SailorPrompt` (Task 1), `useCanvasAgent().stop` (Task 2), `vueCanvas.agentSelection` / `vueCanvas.agentClearSelection` (Task 3), `selectionLabel` / `canvasSuggestions` (Task 3), `shouldFocusPrompt` (Task 1).
- Produces: `CanvasPromptBar` exposes `focus(): void`.

- [ ] **Step 1: Rebuild `CanvasPromptBar`'s template on `SailorPrompt`**

Keep all its script logic: `useCanvasAgent` wiring, `looksLikeImageIdea` fast path, image search, the auto-review listeners, warm on focus, `sketchInstead`. Change it as follows:
- `go` takes the text: `function go(text: string) { const p = text.trim(); if (!p || busy.value) return; …same body…; ask(p) }`. Delete the `phrase` ref.
- Pull `stop` from `useCanvasAgent()`.
- Computeds:

```ts
const selection = computed(() => (props.vueCanvas?.agentSelection ?? []) as PromptNode[])
const chipLabel = computed(() => selectionLabel(selection.value))
const suggestions = computed(() => canvasSuggestions(selection.value, (props.vueCanvas?.getNodes?.() ?? []).length === 0))
const workingLabel = computed(() => busy.value ? 'Planning the change…' : 'Looking at the result…')
const showCard = computed(() => !busy.value && (reviewing.value || hasProposal.value || !!answer.value || !!error.value))
const promptRef = ref<InstanceType<typeof SailorPrompt> | null>(null)
defineExpose({ focus: () => promptRef.value?.focus() })
```

- Template (the root keeps `v-if="ready"` and `pointer-events-none`):

```vue
<div v-if="ready" class="pointer-events-none flex flex-col gap-2">
  <ImageSearchPickerModal :open="searchOpen" :query="searchQuery" @close="searchOpen = false" @done="onSearchDone" />
  <SailorPrompt
    ref="promptRef"
    :selection-label="chipLabel"
    :suggestions="suggestions"
    :working="busy || reviewing"
    :working-label="workingLabel"
    :stoppable="busy"
    :disabled="!aiAvailable"
    @submit="go"
    @stop="stop"
    @clear-selection="props.vueCanvas?.agentClearSelection?.()"
    @focus="onPromptFocus"
  >
    <template v-if="showCard" #above>
      <!-- the existing card body, unchanged, minus AgentSweep and AgentProgress
           (SailorPrompt shows progress and the glimm now) -->
    </template>
  </SailorPrompt>
  <div v-if="hasProposal && lastSubmitted" class="pointer-events-auto flex flex-wrap gap-1.5 px-1"><!-- "…or sketch it?" chip, unchanged --></div>
  <p v-if="!aiAvailable" class="px-1 text-[11px] leading-snug text-white/40"><!-- unchanged notice --></p>
</div>
```

Move the existing card body into the `#above` slot as it is: the dismiss ×, error, answer plus reasoning, the "Analyzing the result…" line, and `AgentProposal` with all its events. Delete the `glimmActive` ref and its watch, the `AgentSweep` inside the card, the `.prompt-field` input bar, and the whole `<style scoped>` block (`SailorPrompt` owns the look).

- [ ] **Step 2: `/` and ⌘K focus the prompt**

In `default.vue`, give the mount a ref, `<AgentCanvasPromptBar ref="canvasPromptRef" … />`, and keep `class="w-0 min-w-full"` (it sizes the prompt to the toolbar).

In `handleGlobalKeydown`, before the Space branch:

```ts
if (activeTab.value.type === 'project' && shouldFocusPrompt(e) && !isStudioOrModalOpen()) {
  e.preventDefault()
  canvasPromptRef.value?.focus()
  return
}
```

Before writing `isStudioOrModalOpen()`, find how the canvas already knows a studio modal, Frame, or another full-screen modal is open. Look at how the Space → `openNodeSearch()` branch and the Escape branch avoid firing under modals, and grep `default.vue` for `Open`/`modal` flags. Reuse that state. If no single flag exists, return true when any element matching `[role="dialog"]` is present in the DOM. Say in your report which you used. The goal: `/` typed inside Frame, a studio, or Settings must never jump focus to the canvas prompt behind it.

- [ ] **Step 3: Update the fast-lane spec's selector**

In `tests/agent-fastlane.spec.ts`, `readyBar()`: replace `page.getByPlaceholder(/Ask about the graph/i)` with `page.getByRole('textbox', { name: 'Ask Sailor' })`. Update the header comment line that documents the old placeholder.

- [ ] **Step 4: Write the Playwright spec (the controller runs it)**

```ts
// frontend/tests/sailor-prompt.spec.ts
import { expect, test, type Page } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

// The one prompt on the canvas (spec §2.1). /api/agent-plan is mocked, so this costs nothing.
async function seedKey(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-prompt') } catch {} })
}
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Ask Sailor' })

test.describe('Sailor prompt on the canvas', () => {
  test.beforeEach(async ({ page }) => { await seedKey(page); await waitForBackend(page); await openBlankWorkflow(page) })

  test('/ focuses it, Esc leaves it, suggestions show while focused', async ({ page }) => {
    await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('.vue-flow__pane').click({ position: { x: 200, y: 200 } })
    await page.keyboard.press('/')
    await expect(prompt(page)).toBeFocused()
    await expect(page.getByTestId('prompt-suggestions')).toBeVisible()
    await expect(prompt(page)).toHaveAttribute('placeholder', 'Ask Sailor')
    await page.keyboard.press('Escape')
    await expect(prompt(page)).not.toBeFocused()
  })

  test('working shows progress with Stop, and Stop ends it', async ({ page }) => {
    await page.route('**/api/agent-plan', async (route) => { await new Promise(r => setTimeout(r, 15_000)); await route.fulfill({ json: { text: '{"reasoning":"","commands":[],"message":"late"}' } }) })
    await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(5_000) // /object_info catalog race, as in agent-fastlane.spec.ts
    await prompt(page).fill('what does this graph do?')
    await prompt(page).press('Enter')
    await expect(page.getByText('Planning the change…')).toBeVisible()
    await page.getByTestId('prompt-stop').click()
    await expect(prompt(page)).toBeVisible()
    await expect(page.getByText('late')).toHaveCount(0)
  })

  test('selecting a node puts its title in the chip and placeholder', async ({ page }) => {
    await page.route('**/api/agent-plan', r => r.fulfill({ json: { text: JSON.stringify({ reasoning: '', message: '', commands: [{ op: 'addNode', args: { nodeType: 'GradientStudio', id: '$new1' } }] }) } }))
    await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(5_000)
    await prompt(page).fill('a soft gradient')
    await prompt(page).press('Enter')
    const node = page.locator('.vue-flow__node').first()
    await node.waitFor({ state: 'visible', timeout: 15_000 })
    await node.click()
    const chip = page.getByTestId('prompt-selection-chip')
    await expect(chip).toBeVisible()
    const title = (await chip.innerText()).trim()
    await expect(prompt(page)).toHaveAttribute('placeholder', `Change or ask about ${title}`)
    await chip.getByRole('button', { name: 'Clear selection' }).click()
    await expect(chip).toHaveCount(0)
  })
})
```

- [ ] **Step 5: Unit suite and typecheck**

Run: `cd frontend && npx vitest run`. Expected: green apart from anything already red at BASE (check at BASE before you say so).
Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "CanvasPromptBar|layouts/default.vue"`. Expected: no new lines against BASE.

- [ ] **Step 6: Commit**

Commit:
- paths: `CanvasPromptBar.vue`, `default.vue` (your hunks only; see Task 3 step 6), `agent-fastlane.spec.ts` and `sailor-prompt.spec.ts`
- message: `feat(canvas): the canvas prompt runs on SailorPrompt — selection chip, suggestions, Stop, / and ⌘K`

State in the report that the Playwright spec wasn't run (the controller runs it).

---

### Task 5: Remove Explain

**Files:**
- Delete: `frontend/app/composables/useExplain.ts`, `frontend/app/components/ExplainOverlay.vue`, `frontend/app/components/ExplainPanel.vue`, `frontend/server/api/explain.post.ts`
- Modify: `frontend/app/layouts/default.vue` (the `useExplain()` line ~130; the `Explain` entry in `sidebarItems` ~157; the explain branches of the tool switch ~426/430; `<ExplainOverlay>` ~3931; `<ExplainPanel />` ~4586)
- Modify: `frontend/server/lib/nitroApiPaths.ts` (remove `/api/explain`)

- [ ] **Step 1: Prove nothing else uses it**

Run: `cd frontend && grep -rn "useExplain\|ExplainOverlay\|ExplainPanel\|api/explain\|'explain'" app server tests --include=*.ts --include=*.vue | grep -v "^app/composables/useExplain.ts\|^app/components/Explain"`
Expected: only the `default.vue` lines listed above, the `nitroApiPaths.ts` entry, and comment-only mentions (`usePortIntent.ts`, `useDirectExecution.ts`). Leave the comment-only mentions alone. If anything else calls it, stop and report.

- [ ] **Step 2: Delete and unwire**

Delete the four files. In `default.vue`:
- remove the `useExplain()` destructure;
- remove the `Explain` item. The item after it has no `dividerBefore` to fix, because Explain is last;
- remove the `explain` branches of the tool switch;
- remove both component mounts.

Remove `/api/explain` from `NITRO_API_PATHS`.

- [ ] **Step 3: Test**

Run: `cd frontend && npx vitest run`. The `api-route-reachability` guard must stay green. Expected: green, as at BASE.
Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -iE "explain|layouts/default.vue"`. Expected: no new lines.

- [ ] **Step 4: Commit**

Commit:
- paths:
  - `git rm --cached -q --` the four deleted files
  - `git add --` `default.vue` (your hunks only) and `nitroApiPaths.ts`
- message: `feat(canvas): remove Explain — "What does this do?" in the prompt replaces it`

---

# Part B: the node toolbar

### Task 6: Fixes per node, and `NextStepsStrip.vue` deleted

**Files:**
- Modify: `frontend/app/composables/useNextStepsStrip.ts`
- Modify: `frontend/app/components/vue-canvas/ArtifactImageNode.vue` (`fixChipsForMe` ~772; `applyFix` ~773)
- Modify: every other caller of `useNextStepsStrip().fixes` (at least `useCanvasAgent.ts`, which calls `announceFixes`; run `grep -rn "useNextStepsStrip\|\.fixes\.value" frontend/app`)
- Delete: `frontend/app/components/vue-canvas/NextStepsStrip.vue` (rendered nowhere; confirm with `grep -rn "NextStepsStrip" frontend/app --include=*.vue`, which should show only the file itself)
- Test: `frontend/tests/unit/node-fixes.unit.spec.ts`

**Interfaces:**
- Produces: `useNextStepsStrip()` returns `{ active, fixesByNode, fixesFor, announceFreshTake, announceFixes, clearFixes, dismiss }`, where:
  - `fixesByNode: Ref<Record<string, FixChip[]>>`
  - `fixesFor(nodeId: string): FixChip[]`
  - `announceFixes(nodeId, chips)` sets that node's list; `clearFixes(nodeId?)` clears one node, or all when called with no id.

  The `fixes` single slot is removed.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/node-fixes.unit.spec.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useNextStepsStrip, type FixChip } from '~/composables/useNextStepsStrip'

const chip = (id: number): FixChip => ({ id, label: `Fix ${id}`, hint: null, apply: () => {} })

describe('fixes per node', () => {
  beforeEach(() => useNextStepsStrip().clearFixes())

  it('keeps fixes for several nodes at once', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1), chip(2)])
    s.announceFixes('b', [chip(3)])
    expect(s.fixesFor('a')).toHaveLength(2)
    expect(s.fixesFor('b')).toHaveLength(1)
  })
  it('clears one node without touching the others', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1)]); s.announceFixes('b', [chip(2)])
    s.clearFixes('a')
    expect(s.fixesFor('a')).toEqual([])
    expect(s.fixesFor('b')).toHaveLength(1)
  })
  it('a fresh take clears that node’s fixes', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1)])
    s.announceFreshTake('a')
    expect(s.fixesFor('a')).toEqual([])
  })
  it('clearFixes() with no id clears everything', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1)]); s.announceFixes('b', [chip(2)])
    s.clearFixes()
    expect(Object.keys(s.fixesByNode.value)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/node-fixes.unit.spec.ts`
Expected: FAIL (`fixesFor` is not a function).

- [ ] **Step 3: Implement**

```ts
// frontend/app/composables/useNextStepsStrip.ts
// Post-render coordination. `active` = the generic suggestion channel (one node
// at a time). Fixes are PER NODE now (spec §2.3's "N fixes" badge): reviewer-found
// fixes stay on their node until applied, dismissed, or a fresh take replaces them.
import { ref } from 'vue'

export interface FixChip {
  id: number
  label: string
  hint: string | null
  apply: () => void
}

const active = ref<{ nodeId: string; shownAt: number } | null>(null)
const fixesByNode = ref<Record<string, FixChip[]>>({})

export function useNextStepsStrip() {
  function clearFixes(nodeId?: string) {
    if (!nodeId) { fixesByNode.value = {}; return }
    if (!(nodeId in fixesByNode.value)) return
    const { [nodeId]: _gone, ...rest } = fixesByNode.value
    fixesByNode.value = rest
  }
  function announceFreshTake(nodeId: string) {
    active.value = { nodeId, shownAt: Date.now() }
    clearFixes(nodeId) // a new render invalidates fixes found on the previous one
  }
  function announceFixes(nodeId: string, chips: FixChip[]) {
    fixesByNode.value = { ...fixesByNode.value, [nodeId]: chips }
  }
  function fixesFor(nodeId: string): FixChip[] { return fixesByNode.value[nodeId] ?? [] }
  function dismiss() { active.value = null }
  return { active, fixesByNode, fixesFor, announceFreshTake, announceFixes, clearFixes, dismiss }
}
```

In `ArtifactImageNode.vue`: `const fixChipsForMe = computed(() => nextSteps.fixesFor(props.id))`. `applyFix` is unchanged. Update any other `.fixes.value` reader the grep finds. Delete `NextStepsStrip.vue`. It imports the `FixChip` type; nothing imports the component.

- [ ] **Step 4: Test and commit**

Run: `cd frontend && npx vitest run tests/unit/node-fixes.unit.spec.ts && npx vitest run`. Expected: green.
Typecheck: grep `useNextStepsStrip|ArtifactImageNode|useCanvasAgent`. Expected: no new lines.
Commit:
- paths: `git rm --cached` `NextStepsStrip.vue`, plus the modified files and the spec
- message: `refactor(fixes): suggested fixes are kept per node; delete the unused NextStepsStrip`

---

### Task 7: One registry of node actions (Edit / Develop)

**Files:**
- Create: `frontend/app/lib/canvas/nodeActions.ts`
- Test: `frontend/tests/unit/node-actions.unit.spec.ts`

**Interfaces:**
- Produces:

```ts
export type ActionGroup = 'edit' | 'develop'
export type ActionLands = 'takes' | 'step' | null
export interface NodeActionCtx { nodeId: string; type: string; hasImages: boolean; hasUpstream: boolean }
export interface NodeAction { id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands; enabled?: (c: NodeActionCtx) => boolean; run: (c: NodeActionCtx) => void }
export function landsHint(l: ActionLands): string | null
export function actionsFor(c: NodeActionCtx): { edit: NodeAction[]; develop: NodeAction[] }
```

Every `run` fires **exactly** the window event and `detail` that today's handler fires (`ArtifactImageNode.vue` ~372-476 and ~584; `ArtifactVideoNode.vue` `fireAction`/`openAllActions`; `SelectionActionChips.vue` `fire`; `ComfyNode.vue` `critiqueResult`). The only deliberate changes are these, from the spec:
- **Variations** fires `count: 3` (always three takes, §3.1).
- **Edit text…** fires `sailor:openTextEdit`, which the image node handles in Task 8.
- **Labels** become sentence case ("Remove background", "Variations", "Reframe", "Edit with Nano Banana", "Enhance detail").

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/node-actions.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { actionsFor, landsHint, type NodeActionCtx } from '~/lib/canvas/nodeActions'

const ctx = (type: string, o: Partial<NodeActionCtx> = {}): NodeActionCtx => ({ nodeId: 'n1', type, hasImages: false, hasUpstream: true, ...o })
function capture(run: () => void) {
  const seen: { name: string; detail: any }[] = []
  const names = ['sailor:applyEffect', 'sailor:openInpaint', 'sailor:critiqueNode', 'sailor:runVariations', 'sailor:animateArtifact', 'sailor:openActions', 'sailor:openTextEdit']
  const fns = names.map(name => { const f = (e: Event) => seen.push({ name, detail: (e as CustomEvent).detail }); window.addEventListener(name, f); return [name, f] as const })
  run()
  fns.forEach(([n, f]) => window.removeEventListener(n, f))
  return seen
}
const find = (c: NodeActionCtx, label: string) => [...actionsFor(c).edit, ...actionsFor(c).develop].find(a => a.label === label)!

describe('landsHint', () => {
  it('names where results land', () => {
    expect(landsHint('takes')).toBe('3 takes'); expect(landsHint('step')).toBe('adds a step'); expect(landsHint(null)).toBeNull()
  })
})

describe('image node actions', () => {
  const c = ctx('artifact-image', { hasImages: true })
  it('groups by intent', () => {
    const { edit, develop } = actionsFor(c)
    expect(edit.map(a => a.label)).toEqual(['Fix', 'Remove background', 'Inpaint', 'Remove object', 'Recolor…', 'Edit text…', 'Edit with Nano Banana', 'Enhance detail', 'Upscale', 'Relight'])
    expect(develop.map(a => a.label)).toEqual(['Variations', 'Restyle…', 'Reframe', 'Animate'])
  })
  it('Upscale branches and runs, exactly as before', () => {
    expect(capture(() => find(c, 'Upscale').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'UpscaleImageNode', output: 'IMAGE', widgetOverrides: undefined, run: true, branch: true } }])
  })
  it('Remove background splices in place', () => {
    expect(capture(() => find(c, 'Remove background').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'BackgroundRemove', output: 'IMAGE', widgetOverrides: { output: 'transparent' } } }])
  })
  it('Remove object opens inpaint with the remove intent', () => {
    expect(capture(() => find(c, 'Remove object').run(c))).toEqual([{ name: 'sailor:openInpaint', detail: { nodeId: 'n1', intent: 'remove' } }])
  })
  it('Variations asks for three takes and needs something upstream', () => {
    expect(capture(() => find(c, 'Variations').run(c))).toEqual([{ name: 'sailor:runVariations', detail: { nodeId: 'n1', count: 3 } }])
    expect(find(c, 'Variations').lands).toBe('takes')
    expect(find(ctx('artifact-image', { hasUpstream: false }), 'Variations').enabled!(ctx('artifact-image', { hasUpstream: false }))).toBe(false)
  })
  it('Fix needs a rendered image and fires a critique', () => {
    expect(find(c, 'Fix').enabled!(ctx('artifact-image', { hasImages: false }))).toBe(false)
    expect(capture(() => find(c, 'Fix').run(c))).toEqual([{ name: 'sailor:critiqueNode', detail: { nodeId: 'n1' } }])
  })
  it('every branching or splicing action says it adds a step', () => {
    const { edit, develop } = actionsFor(c)
    for (const a of [...edit, ...develop]) {
      const fired = capture(() => a.run(c))
      if (fired[0]?.name === 'sailor:applyEffect') expect(a.lands).toBe('step')
    }
  })
})

describe('video and audio', () => {
  it('video keeps its three actions and All actions…', () => {
    const c = ctx('artifact-video')
    expect(actionsFor(c).edit.map(a => a.label)).toEqual(['Sync lips', 'Enhance'])
    expect(actionsFor(c).develop.map(a => a.label)).toEqual(['Describe', 'All actions…'])
    expect(capture(() => find(c, 'Sync lips').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'LipsyncNode', output: 'VIDEO', branch: true, focus: true } }])
    expect(capture(() => find(c, 'All actions…').run(c))).toEqual([{ name: 'sailor:openActions', detail: { domain: 'video' } }])
  })
  it('audio gets its chips as Develop actions', () => {
    const c = ctx('artifact-audio')
    expect(actionsFor(c).develop.map(a => a.label)).toEqual(['Transcribe', 'Speakers', 'All actions…'])
    expect(capture(() => find(c, 'Transcribe').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'TranscribeAudioNode', output: 'AUDIO', branch: true, focus: true } }])
  })
})

describe('any other node', () => {
  it('offers Fix only once it has images', () => {
    expect(actionsFor(ctx('KSampler')).edit).toEqual([])
    expect(actionsFor(ctx('KSampler', { hasImages: true })).edit.map(a => a.label)).toEqual(['Fix'])
    expect(actionsFor(ctx('KSampler', { hasImages: true })).develop).toEqual([])
  })
})
```

Before writing `run` for the audio chips, check `SelectionActionChips.vue`'s `fire` and copy its `detail` exactly. Do the same for `openInpaint`, `openRecolor` and the others. If a real handler's `detail` differs from this test (for example key order, or an extra field), change the test to match the real handler and say so in your report. Behaviour must not change.

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/node-actions.unit.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/canvas/nodeActions.ts
// The node toolbar's actions (spec §1.4, §2.3): one registry, grouped by intent.
// Edit = the same thing, better. Develop = take it somewhere new. Each run()
// fires exactly the window event the old per-node menus fired, so the canvas
// handlers are unchanged. `lands` is the grey hint: '3 takes' on this node, or
// 'adds a step' (a new node after it); null for actions that open an editor.

export type ActionGroup = 'edit' | 'develop'
export type ActionLands = 'takes' | 'step' | null
export interface NodeActionCtx { nodeId: string; type: string; hasImages: boolean; hasUpstream: boolean }
export interface NodeAction { id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands; enabled?: (c: NodeActionCtx) => boolean; run: (c: NodeActionCtx) => void }

export function landsHint(l: ActionLands): string | null {
  return l === 'takes' ? '3 takes' : l === 'step' ? 'adds a step' : null
}

const fire = (name: string, detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent(name, { detail }))
const splice = (c: NodeActionCtx, nodeType: string, opts: Record<string, unknown> = {}, widgetOverrides?: Record<string, unknown>) =>
  fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType, output: 'IMAGE', widgetOverrides, ...opts })
const branchAction = (c: NodeActionCtx, nodeType: string, output: string) =>
  fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType, output, branch: true, focus: true })

const FIX: NodeAction = { id: 'fix', label: 'Fix', group: 'edit', ai: true, lands: null, enabled: c => c.hasImages, run: c => fire('sailor:critiqueNode', { nodeId: c.nodeId }) }

const IMAGE: NodeAction[] = [
  FIX,
  { id: 'remove-bg', label: 'Remove background', group: 'edit', ai: false, lands: 'step', run: c => fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType: 'BackgroundRemove', output: 'IMAGE', widgetOverrides: { output: 'transparent' } }) },
  { id: 'inpaint', label: 'Inpaint', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openInpaint', { nodeId: c.nodeId }) },
  { id: 'remove-object', label: 'Remove object', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openInpaint', { nodeId: c.nodeId, intent: 'remove' }) },
  { id: 'recolor', label: 'Recolor…', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openInpaint', { nodeId: c.nodeId, intent: 'recolor' }) },
  { id: 'edit-text', label: 'Edit text…', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openTextEdit', { nodeId: c.nodeId }) },
  { id: 'nano-banana', label: 'Edit with Nano Banana', group: 'edit', ai: true, lands: 'step', run: c => fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType: 'EditImageNode', output: 'IMAGE', widgetOverrides: { model: 'Nano Banana 2' } }) },
  { id: 'enhance-detail', label: 'Enhance detail', group: 'edit', ai: true, lands: 'step', run: c => splice(c, 'EnhanceDetailNode', { focus: true, branch: true }) },
  { id: 'upscale', label: 'Upscale', group: 'edit', ai: true, lands: 'step', run: c => splice(c, 'UpscaleImageNode', { run: true, branch: true }) },
  { id: 'relight', label: 'Relight', group: 'edit', ai: true, lands: 'step', run: c => splice(c, 'RelightNode', { focus: true, branch: true }) },
  { id: 'variations', label: 'Variations', group: 'develop', ai: true, lands: 'takes', enabled: c => c.hasUpstream, run: c => fire('sailor:runVariations', { nodeId: c.nodeId, count: 3 }) },
  { id: 'restyle', label: 'Restyle…', group: 'develop', ai: true, lands: 'step', run: c => splice(c, 'RestyleWithLoRANode', { focus: true, branch: true }) },
  { id: 'reframe', label: 'Reframe', group: 'develop', ai: true, lands: 'step', run: c => splice(c, 'LensReframe', { focus: true, branch: true }) },
  { id: 'animate', label: 'Animate', group: 'develop', ai: true, lands: 'step', run: c => fire('sailor:animateArtifact', { nodeId: c.nodeId }) },
]

const VIDEO: NodeAction[] = [
  { id: 'lipsync', label: 'Sync lips', group: 'edit', ai: true, lands: 'step', run: c => branchAction(c, 'LipsyncNode', 'VIDEO') },
  { id: 'enhance-video', label: 'Enhance', group: 'edit', ai: true, lands: 'step', run: c => branchAction(c, 'EnhanceVideoNode', 'VIDEO') },
  { id: 'describe-video', label: 'Describe', group: 'develop', ai: true, lands: 'step', run: c => branchAction(c, 'DescribeVideoNode', 'VIDEO') },
  { id: 'all-video', label: 'All actions…', group: 'develop', ai: false, lands: null, run: () => fire('sailor:openActions', { domain: 'video' }) },
]

const AUDIO: NodeAction[] = [
  { id: 'transcribe', label: 'Transcribe', group: 'develop', ai: true, lands: 'step', run: c => branchAction(c, 'TranscribeAudioNode', 'AUDIO') },
  { id: 'speakers', label: 'Speakers', group: 'develop', ai: true, lands: 'step', run: c => branchAction(c, 'IdentifySpeakersNode', 'AUDIO') },
  { id: 'all-audio', label: 'All actions…', group: 'develop', ai: false, lands: null, run: () => fire('sailor:openActions', { domain: 'audio' }) },
]

function listFor(type: string): NodeAction[] {
  if (type === 'artifact-image') return IMAGE
  if (type === 'artifact-video') return VIDEO
  if (type === 'artifact-audio') return AUDIO
  return [FIX]
}

/** Actions for one node, split by group. Items whose `enabled` is false stay listed (shown disabled) except Fix on a node with no images, which is hidden. */
export function actionsFor(c: NodeActionCtx): { edit: NodeAction[]; develop: NodeAction[] } {
  const list = listFor(c.type).filter(a => a !== FIX || c.hasImages || c.type === 'artifact-image')
  return { edit: list.filter(a => a.group === 'edit'), develop: list.filter(a => a.group === 'develop') }
}
```

About the "image node actions" `edit` order in the test: Fix is listed for `artifact-image` even without images (shown disabled), and hidden for any other node without images. The test's "any other node" block covers this.

- [ ] **Step 4: Run it and see it pass; commit**

Run: `cd frontend && npx vitest run tests/unit/node-actions.unit.spec.ts`. Expected: PASS.
Commit:
- paths: `nodeActions.ts` and the spec
- message: `feat(canvas): one registry of node actions, grouped Edit / Develop, same events as today`

---

### Task 8: The floating node toolbar (single node)

**Files:**
- Create: `frontend/app/lib/canvas/toolbarAnchor.ts`
- Create: `frontend/app/components/vue-canvas/NodeActionToolbar.vue`
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (mount the toolbar in the canvas overlay; listen for `sailor:openNodeEdit`)
- Modify: `frontend/app/components/vue-canvas/ArtifactImageNode.vue` (remove the Edit…/Develop… footer and its dropdowns; the text-edit panel opens on `sailor:openTextEdit`)
- Modify: `frontend/app/components/vue-canvas/ArtifactVideoNode.vue` (remove the Edit…/Develop… footer and dropdowns; keep the `priceHints` logic only if something else still uses it, otherwise delete it)
- Modify: `frontend/app/components/vue-canvas/ArtifactAudioNode.vue` (remove `<SelectionActionChips>`)
- Delete: `frontend/app/components/vue-canvas/SelectionActionChips.vue`, if nothing else imports it after this
- Modify: `frontend/app/components/vue-canvas/ComfyNode.vue` (remove the header Critique button ~1774-1781 and `critiqueResult` ~235-238; Fix lives in Edit ▾ now)
- Modify or replace: `frontend/tests/selection-chips.spec.ts` (it asserts `.sel-chips`, which is going away; rewrite it as `tests/node-toolbar.spec.ts`, below)
- Test: `frontend/tests/unit/toolbar-anchor.unit.spec.ts`

**Interfaces:**
- Consumes: `actionsFor`, `landsHint`, `NodeActionCtx` (Task 7); `useNextStepsStrip().fixesFor` (Task 6).
- Produces:
  - `interface Box { x: number; y: number; width: number; height: number }`
  - `unionBox(boxes: Box[]): Box | null`
  - `toolbarAnchor(box: Box, vp: { x: number; y: number; zoom: number }, gap?: number): { left: number; top: number; placement: 'above' | 'below' }`
  - `NodeActionToolbar.vue`:
    - props: `ctx: NodeActionCtx | null`, `multiIds: string[]`, `canCombine: boolean`, `left: number`, `top: number`, `placement: 'above' | 'below'`
    - emits: `runSelection()`, `group()`, `combine()`
    - exposes `openMenu(which: 'edit' | 'develop'): void`

  The multi props are used in Task 9. Until then, pass `multiIds=[]`.

- [ ] **Step 1: Failing anchor test**

```ts
// frontend/tests/unit/toolbar-anchor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { toolbarAnchor, unionBox } from '~/lib/canvas/toolbarAnchor'

describe('toolbarAnchor', () => {
  it('centres above the node in screen space', () => {
    expect(toolbarAnchor({ x: 100, y: 200, width: 240, height: 300 }, { x: 10, y: 20, zoom: 0.5 })).toEqual({ left: 10 + (100 + 120) * 0.5, top: 20 + 200 * 0.5 - 10, placement: 'above' })
  })
  it('flips below when there is no room above', () => {
    const r = toolbarAnchor({ x: 0, y: 0, width: 200, height: 100 }, { x: 0, y: 30, zoom: 1 })
    expect(r.placement).toBe('below')
    expect(r.top).toBe(30 + 100 + 10)
  })
  it('stays the same size at any zoom (only the position scales)', () => {
    const a = toolbarAnchor({ x: 0, y: 400, width: 200, height: 100 }, { x: 0, y: 0, zoom: 2 })
    expect(a.left).toBe(200)
  })
})

describe('unionBox', () => {
  it('bounds several boxes', () => expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 20 }])).toEqual({ x: 0, y: 0, width: 30, height: 25 }))
  it('is null for none', () => expect(unionBox([])).toBeNull())
})
```

- [ ] **Step 2: Implement the anchor**

```ts
// frontend/app/lib/canvas/toolbarAnchor.ts
// Where the node toolbar sits, in pane pixels. The toolbar itself is never scaled
// (spec §2.3: same size on screen at any zoom); only its anchor follows the node.
export interface Box { x: number; y: number; width: number; height: number }
const MIN_TOP = 56 // room for the toolbar above; below this, flip under the node

export function toolbarAnchor(box: Box, vp: { x: number; y: number; zoom: number }, gap = 10): { left: number; top: number; placement: 'above' | 'below' } {
  const left = vp.x + (box.x + box.width / 2) * vp.zoom
  const above = vp.y + box.y * vp.zoom - gap
  if (above >= MIN_TOP) return { left, top: above, placement: 'above' }
  return { left, top: vp.y + (box.y + box.height) * vp.zoom + gap, placement: 'below' }
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y))
  const r = Math.max(...boxes.map(b => b.x + b.width)), btm = Math.max(...boxes.map(b => b.y + b.height))
  return { x, y, width: r - x, height: btm - y }
}
```

Run: `cd frontend && npx vitest run tests/unit/toolbar-anchor.unit.spec.ts`. Expected: PASS.

- [ ] **Step 3: Write `NodeActionToolbar.vue`**

What it must do:
- A compact dark bar, `#1a1a1a` with border `#2a2a2a` and 10px corners, positioned `absolute` at `left`/`top`, translated `-50%` horizontally and `-100%` vertically when `placement === 'above'`. It uses the `nopan nodrag` classes and `pointer-events-auto`.
- **Single mode** (`ctx` set, `multiIds` empty): an **Edit ▾** button and a **Develop ▾** button. Hide a button whose group is empty. Render nothing when both are empty.
- **The dropdown** opens under the bar (or above it, when `placement === 'below'`), 220px wide, clamped to the viewport. Each row shows:
  - the label;
  - a small ✦ (white/45) when `ai`;
  - the `landsHint` in grey on the right.

  A row with `enabled?.(ctx) === false` is disabled, with a `title` saying why: "Needs something upstream to re-run" for Variations, and "Render it first" for Fix. Clicking a row runs it and closes the menu.
- **Suggested fixes.** When `fixesFor(ctx.nodeId)` isn't empty, Edit ▾ starts with a section headed "Suggested fixes" on a faint pastel-tinted background. Each fix row calls `chip.apply()` then `clearFixes(nodeId)`, the same as `applyFix` does today.
- **Closing.** Esc and a click outside close the menu (`onClickOutside` from `@vueuse/core`). So do a pan or zoom: watch `left`/`top`.
- **Match the existing menus' row styles.** Copy the Tailwind classes from the dropdown rows in `ArtifactImageNode.vue` (~1022-1157) before deleting them.
- `openMenu(which)` opens that menu. Task 10's badge uses it.

- [ ] **Step 4: Mount it in `VueNodeCanvas.vue`**

Inside the element that wraps `<VueFlow>` (the pane overlay layer, next to other absolutely positioned canvas overlays), add:

```ts
import NodeActionToolbar from './NodeActionToolbar.vue'
import { toolbarAnchor, unionBox, type Box } from '~/lib/canvas/toolbarAnchor'
import type { NodeActionCtx } from '~/lib/canvas/nodeActions'

const draggingNode = ref(false)
onNodeDragStart(() => { draggingNode.value = true })
onNodeDragStop(() => { draggingNode.value = false })
const toolbarRef = ref<InstanceType<typeof NodeActionToolbar> | null>(null)

function graphBox(id: string): Box | null {
  const gn: any = findNode(id)
  if (!gn?.dimensions?.width) return null
  const p = gn.computedPosition ?? gn.position
  return { x: p.x, y: p.y, width: gn.dimensions.width, height: gn.dimensions.height }
}
const selectedIds = computed(() => agentSelection.value.map(s => s.id))
const toolbarCtx = computed<NodeActionCtx | null>(() => {
  if (selectedIds.value.length !== 1) return null
  const s = agentSelection.value[0]!
  const n: any = (nodes.value as any[]).find(x => String(x.id) === s.id)
  return { nodeId: s.id, type: String(n?.type ?? s.type), hasImages: s.hasImages, hasUpstream: (edges.value as any[]).some(e => String(e.target) === s.id) }
})
const toolbarPos = computed(() => {
  if (draggingNode.value || !selectedIds.value.length) return null
  const box = unionBox(selectedIds.value.map(graphBox).filter(Boolean) as Box[])
  return box ? toolbarAnchor(box, vfViewport.value) : null
})
```

Use `findNode` from the existing `useVueFlow()` destructure (~1046; add it there if it's missing). `vfViewport` is already destructured.

```vue
<NodeActionToolbar
  v-if="toolbarPos && (toolbarCtx || selectedIds.length > 1)"
  ref="toolbarRef"
  :ctx="toolbarCtx" :multi-ids="[]" :can-combine="false"
  :left="toolbarPos.left" :top="toolbarPos.top" :placement="toolbarPos.placement"
/>
```

Also listen for `sailor:openNodeEdit` (`{ nodeId }`): call `selectNode(nodeId)`, `await nextTick()`, then `toolbarRef.value?.openMenu('edit')`. Register it where the other `sailor:*` window listeners are added, and remove it on unmount the same way.

Hide the toolbar while a node is being dragged. It follows pans and zooms because it's computed from the viewport.

- [ ] **Step 5: Remove the old per-node menus**

- **`ArtifactImageNode.vue`:**
  - Delete the Edit…/Develop… footer buttons and both teleported dropdowns.
  - Delete the handlers now only used by them (`removeBackground`, `openInpaint`, `openRemoveObject`, `openRecolor`, `editWithNanoBanana`, `spawn*`, `runVariations`, `animateArtifact`, `critiqueResult`, `applyFix`, `fixChipsForMe`, the `editMenuOpen`/`developMenuOpen` state). Keep any that something else still calls; grep before you delete.
  - **Keep the text-edit find/replace panel.** Open it on `window` event `sailor:openTextEdit` when `detail.nodeId === props.id`, positioned with `menuStyleFor(rootEl)` against the node root (give the root a ref).
  - Keep the auto-review `watch` on `takes.length`. It still dispatches `sailor:autoReview`, and it still calls `clearFixes`.
  - Keep the hover strip and the waiting-state Render button.
- **`ArtifactVideoNode.vue`:** delete the footer, the dropdowns, `REFINE_ACTIONS`/`NEXT_ACTIONS` and `fireAction`/`openAllActions`, plus the `priceHints` fetch if nothing else uses it.
- **`ArtifactAudioNode.vue`:** delete `<SelectionActionChips … />` and its import. Delete `SelectionActionChips.vue` if `grep -rn SelectionActionChips frontend/app` then shows only comments.
- **`ComfyNode.vue`:** delete the Critique header button and `critiqueResult`.

- [ ] **Step 6: Replace `tests/selection-chips.spec.ts` with `tests/node-toolbar.spec.ts` (the controller runs it)**

Read `selection-chips.spec.ts` for how it builds its audio and video nodes, and reuse that setup. The new spec asserts:
- selecting an audio node shows a toolbar button named "Develop", with menu rows "Transcribe" and "Speakers";
- choosing "Transcribe" adds one node to the canvas, as the old chip did;
- selecting a video node shows "Edit" with "Sync lips" and "Enhance";
- deselecting (click the empty pane) hides the toolbar.

Delete `selection-chips.spec.ts` in the same commit.

- [ ] **Step 7: Unit suite, typecheck, commit**

Run: `cd frontend && npx vitest run`. Expected: green, as at BASE.
Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "NodeActionToolbar|toolbarAnchor|VueNodeCanvas|ArtifactImageNode|ArtifactVideoNode|ArtifactAudioNode|ComfyNode"`. Expected: no new lines against BASE.
Commit:
- paths:
  - your paths, with `VueNodeCanvas.vue` hunks only;
  - `git rm --cached` for `SelectionActionChips.vue` (if deleted) and `selection-chips.spec.ts`
- message: `feat(canvas): floating Edit ▾ / Develop ▾ toolbar above the selected node; per-node menus and SelectionActionChips retired`

---

### Task 9: The multi-select bar (Run N · Group · Combine into Frame)

**Files:**
- Modify: `frontend/app/components/vue-canvas/NodeActionToolbar.vue` (multi mode)
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (pass `multiIds`/`canCombine`; wire the emits to the same functions `selectionMenuItems()` uses at ~7072-7096)
- Test: extend `frontend/tests/node-toolbar.spec.ts`

**Interfaces:**
- Consumes: the `selectionMenuItems()` handlers `emitRunFiltered(ids)`, `actionGroupSelection()`, `combineIntoFrame(ids)`, and the `planFrameFromSelection(sel).canCombine` gate.

- [ ] **Step 1: Multi mode in the toolbar**

When `multiIds.length > 1` the bar shows three plain buttons, with no dropdowns:
- **▶ Run ‹N›**, labelled `Run ${multiIds.length}`, with accessible name `Run ${n} nodes`;
- **Group**;
- **Combine into Frame**, only when `canCombine`.

They emit `runSelection`, `group` and `combine`. None of them is AI, so there's no ✦.

- [ ] **Step 2: Wire it in `VueNodeCanvas.vue`**

```vue
:multi-ids="selectedIds.length > 1 ? selectedIds : []"
:can-combine="selectedIds.length > 1 && planFrameFromSelection(selectedNodesForPlan).canCombine"
@run-selection="emitRunFiltered(selectedIds)"
@group="actionGroupSelection()"
@combine="combineIntoFrame(selectedIds)"
```

Build `selectedNodesForPlan` the same way `selectionMenuItems()` builds the `sel` it passes to `planFrameFromSelection`. Reuse the same expression; don't reimplement it. The right-click selection menu stays exactly as it is.

- [ ] **Step 3: Extend the Playwright spec**

Add a test that places two GradientStudio nodes through a mocked two-command plan, then clicks "Keep all" (see `agent-fastlane.spec.ts` for the plan shape). It then selects both nodes, with a shift-click or a drag box over the pane, and asserts:
- a "Run 2" button is visible;
- clicking "Group" creates a group, using the same check `groups-context-menu.spec.ts` uses after "Group Selection".

- [ ] **Step 4: Test and commit**

Run: `cd frontend && npx vitest run`. Typecheck your files.
Commit:
- message: `feat(canvas): multi-select bar — Run N, Group, Combine into Frame`

---

### Task 10: The Run row, and the fixes badge

**Files:**
- Create: `frontend/app/lib/canvas/runRowStatus.ts`
- Create: `frontend/app/components/vue-canvas/NodeRunRow.vue`
- Create: `frontend/app/components/vue-canvas/NodeFixesBadge.vue`
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (~3171, where a run completes: also set `lastRunAt: Date.now()`)
- Modify: `frontend/app/components/vue-canvas/ComfyNode.vue` (the split-button footer ~2282-2351 becomes a `NodeRunRow` with the same caret scope menu; the badge goes in the header trailing slot ~1792-1800)
- Modify: `frontend/app/components/vue-canvas/ArtifactImageNode.vue`, `ArtifactVideoNode.vue`, `ArtifactAudioNode.vue` (the footer area freed in Task 8 becomes a `NodeRunRow`; the image node shows `NodeFixesBadge` top-left over the image)
- Test: `frontend/tests/unit/run-row-status.unit.spec.ts`

**Interfaces:**
- Produces:
  - `runRowStatus(s: { running: boolean; error?: boolean; live?: boolean; hasRun: boolean; costLabel?: string | null; lastRunAt?: number | null; now: number }): { tone: 'idle' | 'running' | 'done' | 'error' | 'live'; text: string }`
  - `NodeRunRow.vue`:
    - props: `status: { tone; text }`, `canRun: boolean`, `running: boolean`, `runLabel?: string` (default `'Run'`)
    - emits `run()`
    - slot `menu` for a caret menu
  - `NodeFixesBadge.vue`: prop `nodeId: string`. It renders nothing when there are no fixes; otherwise "1 fix" or "N fixes". A click dispatches `sailor:openNodeEdit` `{ nodeId }` (Task 8 opens Edit ▾).

- [ ] **Step 1: Failing status test**

```ts
// frontend/tests/unit/run-row-status.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { runRowStatus } from '~/lib/canvas/runRowStatus'

const now = 1_000_000_000
const base = { running: false, hasRun: false, now }

describe('runRowStatus', () => {
  it('running wins', () => expect(runRowStatus({ ...base, running: true, hasRun: true })).toEqual({ tone: 'running', text: 'Running…' }))
  it('an error asks to run again', () => expect(runRowStatus({ ...base, error: true })).toEqual({ tone: 'error', text: 'Failed · run again' }))
  it('live preview nodes say so', () => expect(runRowStatus({ ...base, live: true })).toEqual({ tone: 'live', text: 'Live preview' }))
  it('not run yet shows the cost when known', () => {
    expect(runRowStatus({ ...base, costLabel: '$0.04' })).toEqual({ tone: 'idle', text: 'Not run yet · $0.04' })
    expect(runRowStatus(base)).toEqual({ tone: 'idle', text: 'Not run yet' })
  })
  it('rendered says how long ago', () => {
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 20_000 }).text).toBe('Rendered just now')
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 2 * 60_000 }).text).toBe('Rendered 2 min ago')
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 3 * 3_600_000 }).text).toBe('Rendered 3 h ago')
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 2 * 86_400_000 }).text).toBe('Rendered 2 d ago')
    expect(runRowStatus({ ...base, hasRun: true })).toEqual({ tone: 'done', text: 'Rendered' })
  })
})
```

- [ ] **Step 2: Implement it**

```ts
// frontend/app/lib/canvas/runRowStatus.ts
// The slim Run row's status line (spec §2.3): state you need to see without selecting.
export type RunTone = 'idle' | 'running' | 'done' | 'error' | 'live'

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export function runRowStatus(s: { running: boolean; error?: boolean; live?: boolean; hasRun: boolean; costLabel?: string | null; lastRunAt?: number | null; now: number }): { tone: RunTone; text: string } {
  if (s.running) return { tone: 'running', text: 'Running…' }
  if (s.error) return { tone: 'error', text: 'Failed · run again' }
  if (s.live) return { tone: 'live', text: 'Live preview' }
  if (s.hasRun) return { tone: 'done', text: s.lastRunAt ? `Rendered ${ago(s.now - s.lastRunAt)}` : 'Rendered' }
  return { tone: 'idle', text: s.costLabel ? `Not run yet · ${s.costLabel}` : 'Not run yet' }
}
```

Run the test. Expected: PASS.

- [ ] **Step 3: `NodeRunRow.vue` and `NodeFixesBadge.vue`**

**`NodeRunRow`** is one slim row, 28px high, with a hairline top border, in the node's own DOM. It zooms with the node, like today's footer. It holds:
- a status dot: grey (idle), pulsing white (running), green `#7fbf8a` (done), red (error), or blue (live);
- the status text in 11px white/60, truncated;
- on the right, a ▶ button (accessible name from `runLabel`), disabled while `running` or when `!canRun`, followed by the `menu` slot.

Refresh "N min ago" with a single shared 30-second `now` ref (a module-level `setInterval`, started on first use), not one timer per node.

**`NodeFixesBadge`** reads `useNextStepsStrip().fixesFor(nodeId)`. It's a small pill with the pastel hairline (reuse the global `.pastel-hairline` class from `main.css`; fixes are AI) and white/80 text: "1 fix" or "N fixes". A click dispatches `sailor:openNodeEdit` `{ nodeId }` and stops propagation.

- [ ] **Step 4: Use them on the nodes**

- **`ComfyNode.vue`:** replace the split-button footer with
  `<NodeRunRow :status="runStatus" :can-run="showRunButton && !isMuted && !isBypassed" :running="!!data.running" :run-label="hasRun ? 'Re-render' : 'Run'" @run="playThisNode">`.
  - Put the existing caret and its scope menu (Run this node, Re-render ×4, Rebuild from start → here, Run here → end) unchanged into `#menu`.
  - Compute `runStatus` with `runRowStatus({ running: !!data.running, error: !!data.error, live: LIVE_PREVIEW_NODES.has(nodeType), hasRun: hasRun.value, costLabel: priceLabel.value, lastRunAt: data.lastRunAt, now: now.value })`.
  - Show the row when `showRunButton || LIVE_PREVIEW_NODES.has(nodeType)`. Use the existing `LIVE_PREVIEW_NODES` constant.
  - In the header, add `<NodeFixesBadge :node-id="id" />` before the price/count badge.
- **`VueNodeCanvas.vue` ~3171:** add `lastRunAt: Date.now()` to the `target.data = { … hasRun: true }` spread.
- **Artifact image, video and audio nodes:** where the populated-state footer was, render a `NodeRunRow` with `@run="runThisNode"` (the existing function). The image node also gets `<NodeFixesBadge>` top-left over the image, always visible, not only on hover. Keep each node's waiting-state Render button as it is.

- [ ] **Step 5: Test and commit**

Run: `cd frontend && npx vitest run`. Expected: green, as at BASE.
Typecheck the touched files against BASE.
Commit:
- message: `feat(canvas): slim Run row on nodes with status, and the "N fixes" badge that opens Edit ▾`

---

# Verification

### Task 11: Browser pass and the controller's checks (controller-run, not a subagent)

- [ ] **Step 1: Health first.**
  - `lsof -nP -iTCP -sTCP:LISTEN | grep node`, then `lsof -a -p <pid> -d cwd` to find the main checkout's server on `:3002`.
  - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/`.
  - `curl -s http://127.0.0.1:8188/system_stats`.
  - If the server is broken, say so and offer to restart it on its own port. Don't start another.
- [ ] **Step 2: Playwright**, one spec at a time:

  ```bash
  cd frontend && npx playwright test tests/sailor-prompt.spec.ts tests/agent-fastlane.spec.ts tests/node-toolbar.spec.ts tests/groups-context-menu.spec.ts
  ```

  A spec that times out gets rerun alone before anyone calls it broken.
- [ ] **Step 3: Real mouse in the browser pane** (synthetic events prove nothing). Click by ref, and check each of these:
  - `/` and ⌘K focus the prompt; Esc leaves it.
  - Selecting a node puts its title in the chip; × clears it.
  - A suggestion click sends it.
  - Working shows the glimm on the prompt, plus Stop; Stop ends it.
  - The pastel ring is faint at rest and full when focused.
  - The Edit ▾ / Develop ▾ toolbar sits above the selected image node, stays the same size at 50% and 200% zoom, follows a pan, and hides while dragging.
  - Upscale adds a node; Variations shows "3 takes" and runs three.
  - Multi-select shows Run 2 / Group.
  - The Run row reads "Not run yet · $…", then "Rendered just now".
  - A critique's fixes show the badge, and the badge opens Edit ▾ with Suggested fixes.
  - Explain is gone from the toolbar.
  - Take screenshots.
- [ ] **Step 4: Update the spec's §9 stage 2 as landed.** Also update the memory file `ai-surface-rethink-and-shader-gen.md` and the build dashboard (standing rule: update the dashboard on every commit).
