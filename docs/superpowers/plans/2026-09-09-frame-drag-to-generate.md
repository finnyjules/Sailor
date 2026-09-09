# Frame drag-to-generate element — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class "drag an area → pick a style → get a transparent cut-out element" gesture to the Frame/compositor, re-surfacing the existing (buried) Generate-in-region engine as a direct canvas gesture with a minimal on-box bar.

**Architecture:** Reuse the existing `genActive`/`genTool:'box'` engine (`generateObjectInto → removeBackground → cleanCutoutAlpha → addImageFromName`) unchanged. Add a thin "gesture" layer on top: a `genGesture` mode armed two ways (a top-level toolbar **Generate** button, or **hold Option/Alt + drag**), a minimal on-box floating bar (prompt + style picker + Generate) that replaces the fat right-hand panel, and defaults that pin mode=style/model=flux/tool=box. Select is untouched; the gesture only owns the canvas while armed.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TypeScript, Tailwind, Vitest (unit), Playwright (E2E against the live dev server on `127.0.0.1:3002`).

## Global Constraints

- Vue frontend has priority over LiteGraph/bridge. All work is in `frontend/`.
- Sliders use `StudioSlider`; colour rows `StudioColorField`; selects `StudioSelect`. (No raw `<input type=range>`.) Not directly needed here but applies if any control is added.
- UI copy: **sentence case**, no internal identifiers, no lowercase-start labels. Any select over internal values needs `optionLabels`.
- **Work in the main checkout**, no worktree/branch. Several sessions share this checkout: stage only your own hunks by exact path; **never `git stash`**; leave files you did not write alone.
- **Every commit uses a private git index** (`GIT_INDEX_FILE=<scratch>/x.index git read-tree HEAD && … git add -- <exact path> && … git commit`), then resync the shared index with `git reset -q -- <path>` in a separate shell. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Dev server: one per checkout on `:3002`. Check `lsof -nP -iTCP -sTCP:LISTEN | grep node` first; reuse if healthy. Killing Nuxt can take ComfyUI (`:8188`) with it — re-check `127.0.0.1:8188/system_stats` after any restart.
- `timeout` is not available on this Mac.
- The compositor calls (`/api/inpaint/*`) are metered by rate-limit + provider billing; a real Generate click is a **paid** call. Automated tests must NOT click Generate — only the final manual task does one paid run.

## File Structure

- **Create** `frontend/app/lib/compositor/genGesture.ts` — pure, framework-free helpers: fixed gesture defaults, the click-vs-drag min-size guard, and the on-box bar placement math. The only cleanly unit-testable logic.
- **Create** `frontend/tests/unit/gen-gesture.unit.spec.ts` — Vitest for the three helpers.
- **Modify** `frontend/app/components/vue-canvas/CompositorModal.vue` — gesture state + arm/disarm, Option-hold key handling, the on-box bar template, the region-panel hide guard, the top-level toolbar button, the min-size guard on pointer-up, and Escape/confirm/cancel disarm + style persistence.
- **Create** `frontend/tests/frame-drag-to-generate.spec.ts` — Playwright interaction test (arm → drag → bar → prompt-gate → Escape), **no generation call**.

All state/handlers in CompositorModal reuse existing symbols verbatim: `genActive`, `genTool`, `genMode`, `genModel`, `genTargetId`, `genStyle`, `stylePickerOpen`, `styleList`, `genPrompt`, `genHasMask`, `genMaskCanvas`, `genMaskBounds()`, `genDraw`, `clearGenMask()`, `exitGenMode()`, `exitOtherToolsFor()`, `runRegionFill()`, `genResult`, `confirmObject()`, `cancelObject()`, `isSelectTool`, `smartActive`, `canvasDisplay`, `inpaint`.

---

### Task 1: Pure gesture helpers + unit tests

**Files:**
- Create: `frontend/app/lib/compositor/genGesture.ts`
- Test: `frontend/tests/unit/gen-gesture.unit.spec.ts`

**Interfaces:**
- Produces:
  - `genGestureDefaults(): { tool: 'box'; mode: 'style'; model: 'flux' }`
  - `interface GenGestureBounds { minX: number; minY: number; maxX: number; maxY: number }`
  - `genBoxIsValid(bnd: GenGestureBounds, dispW: number, dispH: number): boolean`
  - `genBarPlacement(bnd: GenGestureBounds, dispW: number, dispH: number, barH?: number, margin?: number): { left: number; top: number; flip: boolean }`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/gen-gesture.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { genGestureDefaults, genBoxIsValid, genBarPlacement } from '~/lib/compositor/genGesture'

describe('genGestureDefaults', () => {
  it('pins box / style / flux', () => {
    expect(genGestureDefaults()).toEqual({ tool: 'box', mode: 'style', model: 'flux' })
  })
})

describe('genBoxIsValid', () => {
  const disp = { w: 1000, h: 600 }
  it('rejects a click-sized box', () => {
    expect(genBoxIsValid({ minX: 100, minY: 100, maxX: 103, maxY: 101 }, disp.w, disp.h)).toBe(false)
  })
  it('accepts a real drag', () => {
    expect(genBoxIsValid({ minX: 100, minY: 100, maxX: 300, maxY: 260 }, disp.w, disp.h)).toBe(true)
  })
  it('normalizes height to WIDTH, matching the layer model', () => {
    // hN uses dispW as the divisor: 100px tall / 1000px wide = 0.1 ≥ 0.002 → valid
    expect(genBoxIsValid({ minX: 0, minY: 0, maxX: 60, maxY: 100 }, disp.w, disp.h)).toBe(true)
  })
  it('is safe when dispW is zero', () => {
    expect(genBoxIsValid({ minX: 0, minY: 0, maxX: 60, maxY: 100 }, 0, 0)).toBe(false)
  })
})

describe('genBarPlacement', () => {
  it('sits below the box when there is room', () => {
    const p = genBarPlacement({ minX: 400, minY: 100, maxX: 600, maxY: 300 }, 1000, 600)
    expect(p.flip).toBe(false)
    expect(p.top).toBe(312)          // maxY + margin(12)
    expect(p.left).toBe(500)         // box centre, within clamp
  })
  it('flips above when the box is near the bottom', () => {
    const p = genBarPlacement({ minX: 400, minY: 380, maxX: 600, maxY: 580 }, 1000, 600, 44, 12)
    expect(p.flip).toBe(true)
    expect(p.top).toBe(324)          // minY - margin - barH = 380 - 12 - 44
  })
  it('clamps the horizontal centre away from the edges', () => {
    expect(genBarPlacement({ minX: 0, minY: 0, maxX: 20, maxY: 40 }, 1000, 600).left).toBe(90)
    expect(genBarPlacement({ minX: 980, minY: 0, maxX: 1000, maxY: 40 }, 1000, 600).left).toBe(910)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/gen-gesture.unit.spec.ts`
Expected: FAIL — `Failed to resolve import '~/lib/compositor/genGesture'`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/lib/compositor/genGesture.ts`:

```ts
// Pure helpers for the Frame drag-to-generate gesture. Framework-free so the
// box-validity guard and the on-box bar placement are unit-testable without a DOM.

export interface GenGestureBounds { minX: number; minY: number; maxX: number; maxY: number }

/** Fixed defaults that replace the Generate-in-region panel's Style/Scene · Flux/Nano
 *  · box/brush/shape toggles for the streamlined gesture. */
export function genGestureDefaults(): { tool: 'box'; mode: 'style'; model: 'flux' } {
  return { tool: 'box', mode: 'style', model: 'flux' }
}

/** Reject click-sized boxes so a stray click never pops the bar. Mirrors the
 *  Draw-section min-size guard (normalized 0.005 × 0.002 of canvas WIDTH), applied to
 *  the box's pixel bounds. Height is normalized to WIDTH, matching the layer model. */
export function genBoxIsValid(bnd: GenGestureBounds, dispW: number, dispH: number): boolean {
  if (dispW <= 0) return false
  const wN = (bnd.maxX - bnd.minX) / dispW
  const hN = (bnd.maxY - bnd.minY) / dispW
  return wN >= 0.005 && hN >= 0.002
}

/** Place the on-box bar centred under the box, flipped above when it would fall off
 *  the bottom. Coordinates are artboard px (the overlay's own coordinate space). */
export function genBarPlacement(
  bnd: GenGestureBounds, dispW: number, dispH: number, barH = 44, margin = 12,
): { left: number; top: number; flip: boolean } {
  const cx = (bnd.minX + bnd.maxX) / 2
  const left = Math.min(Math.max(cx, 90), Math.max(90, dispW - 90))
  const below = bnd.maxY + margin
  const flip = below + barH > dispH
  const top = flip ? Math.max(margin, bnd.minY - margin - barH) : Math.min(below, dispH - barH)
  return { left, top, flip }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/gen-gesture.unit.spec.ts`
Expected: PASS (4 describe blocks, all green).

- [ ] **Step 5: Commit** (private index — see Global Constraints)

```bash
cd /Users/julien/Documents/GitHub/Sailor
SC=<scratchpad>; IDX=$SC/t1.index
GIT_INDEX_FILE=$IDX git read-tree HEAD
GIT_INDEX_FILE=$IDX git add -- frontend/app/lib/compositor/genGesture.ts frontend/tests/unit/gen-gesture.unit.spec.ts
GIT_INDEX_FILE=$IDX git commit -m "feat(compositor): pure helpers for drag-to-generate gesture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git reset -q -- frontend/app/lib/compositor/genGesture.ts frontend/tests/unit/gen-gesture.unit.spec.ts
```

---

### Task 2: Gesture state, arm/disarm, top-level toolbar button, hide the region panel

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (script: add state + `armGenGesture`/`disarmGenGesture`/`toggleGenGesture`; template: top-level toolbar button; region panel `v-if` guard)

**Interfaces:**
- Consumes (Task 1): `genGestureDefaults`.
- Produces: refs `genGesture`, `genSpring`, `optDown`, `lastGenStyle`; functions `armGenGesture(spring?)`, `disarmGenGesture()`, `toggleGenGesture()`.

- [ ] **Step 1: Add gesture state + functions (script)**

In `CompositorModal.vue`, immediately after the `genResult` declaration (`const genResult = ref<…>(null)` near line 4182), add:

```ts
// ── Streamlined drag-to-generate gesture ─────────────────────────────────────
// The Generate-in-region engine (genActive + box tool) re-surfaced as a direct
// canvas gesture: a top-level Generate tool + hold-Option drag, a minimal on-box
// bar, and fixed defaults hiding the Style/Scene · Flux/Nano · brush/shape panel.
const genGesture = ref(false)   // armed via the streamlined tool (button or Option)
const genSpring = ref(false)    // this arm came from a held Option (spring-loaded)
const optDown = ref(false)      // Option/Alt currently held
const lastGenStyle = ref<import('~/composables/useStyleList').StyleItem | null>(null)
const genBarBnd = ref<GenBounds | null>(null)   // box bounds (artboard px) the on-box bar anchors to

function armGenGesture(spring = false) {
  if (!exitOtherToolsFor('region')) return
  const d = genGestureDefaults()
  genActive.value = true
  genGesture.value = true
  genSpring.value = spring
  genTool.value = d.tool          // 'box'
  genMode.value = d.mode          // 'style'
  genModel.value = d.model        // 'flux'
  genTargetId.value = null        // always a NEW layer
  genStyle.value = lastGenStyle.value   // persistence: keep the last style
  genPrompt.value = ''            // fresh prompt each arm
  stylePickerOpen.value = false
  genBarBnd.value = null
  styleList.refresh()
  clearGenMask()
}
function disarmGenGesture() {
  genGesture.value = false
  genSpring.value = false
  genBarBnd.value = null
  exitGenMode()                   // genActive=false, cursor off, clearGenMask, genResult=null
}
function toggleGenGesture() {
  if (genActive.value && genGesture.value) disarmGenGesture()
  else armGenGesture(false)
}
```

Then add the import at the top of `<script setup>` alongside the other `~/lib/compositor` imports:

```ts
import { genGestureDefaults, genBoxIsValid, genBarPlacement } from '~/lib/compositor/genGesture'
```

(`genBoxIsValid`/`genBarPlacement` are used in Tasks 3; import them now so the block is complete.)

- [ ] **Step 2: Clear the bar bounds when the mask clears (script)**

Find `function clearGenMask()` (near line 4202). Add `genBarBnd.value = null` as its last line, inside the function body:

```ts
function clearGenMask() {
  const ctx = genMaskCtx()
  if (ctx && genMaskCanvas) ctx.clearRect(0, 0, genMaskCanvas.width, genMaskCanvas.height)
  genHasMask.value = false; genVersion.value++
  genBarBnd.value = null
}
```

- [ ] **Step 3: Hide the fat region panel while the gesture is armed (template)**

Find the region inspector panel (near line 6902):

```html
      <!-- Generate-in-region controls (mode owns the inspector) -->
      <template v-else-if="genActive">
```

Change the condition to exclude the gesture:

```html
      <!-- Generate-in-region controls (mode owns the inspector) -->
      <template v-else-if="genActive && !genGesture">
```

- [ ] **Step 4: Add the top-level Generate toolbar button (template)**

Find the Shapes toolbar toggle button, `data-testid="shapes-menu-toggle"` (near line 6570). Immediately **after** the closing `</div>` of the Shapes cluster (before the Insert cluster near line 6619), add a standalone button. Locate the sibling toolbar buttons for their exact wrapper classes; insert this button at the same level:

```html
        <!-- Generate: a top-level tool (a mode, not a stamp) — arms the drag-to-
             generate gesture; hold Option/Alt + drag does the same without the click. -->
        <button
          type="button"
          data-testid="generate-tool-toggle"
          class="flex items-center justify-center size-9 rounded-lg border border-transparent hover:bg-white/10 text-white/80 cursor-pointer"
          :class="genActive && genGesture ? 'bg-white/15 text-white border-white/20' : ''"
          title="Generate an element (drag a box, or hold Option and drag)"
          @click="toggleGenGesture"
        ><Wand2 class="size-4" /></button>
```

`Wand2` is already imported (used by the AI menu). If the toolbar buttons in this cluster use different wrapper markup (e.g. wrapped in a `<div>`), match that wrapper — read the two neighbouring buttons first and mirror their structure exactly.

- [ ] **Step 5: Verify (typecheck + live browser-pane)**

Typecheck (baseline has pre-existing strict-null errors; assert no NEW error mentions the new symbols):

```bash
cd frontend && npx nuxt typecheck 2>&1 | grep -iE "genGesture|genBarBnd|armGenGesture|genGestureDefaults" || echo "no new errors referencing the gesture symbols"
```
Expected: prints the "no new errors" line.

Live check (dev server already on `:3002`): open the compositor over a Frame node and confirm the button arms/disarms.
- Ensure a preview is open (`preview_start` name of the dev server, or navigate to the running `:3002`).
- In the browser pane, open a compositor: dispatch `sailor:openCompositor` for a Frame node (as the E2E helper does), or use an existing frame.
- Click `[data-testid="generate-tool-toggle"]`. Confirm: the button shows the active style; the right-hand "Generate in region" panel does **not** appear (the gesture suppresses it). Click again → disarms.
- Screenshot for proof.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
# CompositorModal.vue may carry another session's edits — stage ONLY your hunks.
# Build "HEAD + your edits only" if the working tree is contended (see the FillControl
# recipe in memory: git show HEAD:<path> > tmp, re-apply your edits, hash-object,
# update-index --cacheinfo into a private index, commit). Otherwise:
SC=<scratchpad>; IDX=$SC/t2.index; REL=frontend/app/components/vue-canvas/CompositorModal.vue
GIT_INDEX_FILE=$IDX git read-tree HEAD
GIT_INDEX_FILE=$IDX git add -- "$REL"
GIT_INDEX_FILE=$IDX git commit -m "feat(compositor): arm/disarm drag-to-generate gesture + toolbar button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git reset -q -- "$REL"
```

---

### Task 3: The on-box bar (drag → prompt + style + Generate), min-size guard, placement

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (script: `onGenPointerUp` gesture branch, `genBarStyle` computed, `genPromptRef`; template: the on-box bar + its style popover; canvas cursor)

**Interfaces:**
- Consumes (Task 1): `genBoxIsValid`, `genBarPlacement`. (Task 2): `genGesture`, `genBarBnd`, `genPrompt`, `genStyle`, `stylePickerOpen`, `styleList`.
- Produces: `genBarStyle` computed, `genPromptRef` ref.

- [ ] **Step 1: Reject click-sized boxes and record the bar anchor (script)**

Find `function onGenPointerUp(e: PointerEvent)` (near line 4503). Replace it with:

```ts
function onGenPointerUp(e: PointerEvent) {
  if (!genDraw.value) return
  e.preventDefault(); e.stopPropagation()
  genDraw.value = null
  // Streamlined gesture: reject click-sized boxes so a stray click never pops the
  // bar, and snapshot the box bounds the on-box bar anchors to.
  if (genGesture.value) {
    const bnd = genMaskBounds()
    if (bnd && genBoxIsValid(bnd, canvasDisplay.w, canvasDisplay.h)) genBarBnd.value = bnd
    else { clearGenMask() }
  }
}
```

- [ ] **Step 2: Bar placement computed + prompt ref (script)**

Near the other gesture state (after `genBarBnd`), add:

```ts
const genPromptRef = ref<HTMLInputElement | null>(null)
const genBarStyle = computed(() => {
  if (!genBarBnd.value) return {}
  const p = genBarPlacement(genBarBnd.value, canvasDisplay.w, canvasDisplay.h)
  return { left: p.left + 'px', top: p.top + 'px' }
})
// Autofocus the prompt when the bar appears.
watch(genBarBnd, (b) => { if (b) nextTick(() => genPromptRef.value?.focus()) })
```

Confirm `nextTick` and `watch` are already imported from `vue` at the top of the file; if `nextTick` is missing, add it to the existing `import { … } from 'vue'`.

- [ ] **Step 3: The on-box bar template**

In the overlay, immediately **before** the `<!-- Generated-object mini toolbar -->` block (near line 6123), add the pending-generate bar:

```html
        <!-- Drag-to-generate on-box bar: prompt + style + Generate. Shown after a
             valid box is dragged, before generation; the mini toolbar below replaces
             it once a result exists. -->
        <div
          v-if="genGesture && genBarBnd && !genResult && !inpaint.busy.value"
          data-gen-bar
          data-testid="gen-onbox-bar"
          class="absolute z-40 -translate-x-1/2 flex items-center gap-1 bg-[#1a1a1a]/95 backdrop-blur-sm rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg"
          :style="genBarStyle"
          @pointerdown.stop @click.stop
        >
          <input
            ref="genPromptRef"
            v-model="genPrompt"
            type="text"
            data-testid="gen-onbox-prompt"
            placeholder="Describe the element…"
            class="h-8 w-44 rounded-[8px] bg-white/5 px-2 text-[12px] text-white/90 placeholder-white/35 outline-none focus:bg-white/10"
            @keydown.enter="genPrompt.trim() && runRegionFill()"
          />
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-2 rounded-[8px] hover:bg-white/10 text-white/80 text-[11px] cursor-pointer whitespace-nowrap"
              title="Style"
              @click="stylePickerOpen = !stylePickerOpen"
            >
              <img v-if="genStyle?.coverUrl" :src="genStyle.coverUrl" class="size-4 rounded object-cover ring-1 ring-white/10" />
              <span class="max-w-24 truncate">{{ genStyle ? genStyle.name : 'No style' }}</span>
              <ChevronDown class="size-3 text-white/40" :class="stylePickerOpen ? 'rotate-180' : ''" />
            </button>
            <div v-if="stylePickerOpen" class="absolute bottom-full left-0 mb-1.5 z-50 w-52 max-h-56 overflow-y-auto rounded-md bg-neutral-900 border border-white/10 shadow-xl flex flex-col">
              <button class="px-3 py-2 text-left text-[12px] hover:bg-white/10 cursor-pointer"
                @click="genStyle = null; stylePickerOpen = false">No style</button>
              <button v-for="s in styleList.styles.value" :key="s.filename"
                class="px-3 py-2 text-left text-[12px] hover:bg-white/10 cursor-pointer flex items-center gap-2.5"
                @click="genStyle = s; stylePickerOpen = false">
                <img v-if="s.coverUrl" :src="s.coverUrl" class="size-6 rounded object-cover ring-1 ring-white/10" />
                <span class="truncate">{{ s.name }}</span>
              </button>
              <p v-if="!styleList.styles.value.length" class="px-3 py-2 text-[11px] text-white/30">
                {{ styleList.loading.value ? 'Loading…' : 'No trained styles yet.' }}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="gen-onbox-generate"
            class="flex items-center justify-center h-8 px-3 rounded-[8px] bg-white text-neutral-900 hover:bg-white/90 text-[12px] font-medium cursor-pointer disabled:opacity-40 disabled:cursor-default"
            :disabled="!genPrompt.trim() || inpaint.busy.value"
            @click="runRegionFill"
          >Generate</button>
        </div>
```

`ChevronDown` is already imported (used by the region panel). The `data-gen-bar` attribute reuses the existing pointer-capture guard (`onCanvasPointerDownCapture` early-returns on `[data-gen-bar]`), so clicks in the bar don't start a new box.

- [ ] **Step 4: Crosshair cursor while armed and idle (template)**

Find the artboard element that owns the canvas pointer handlers (the div binding `@pointerdown.capture="onCanvasPointerDownCapture"`). Add a cursor class binding to it (merge with any existing `:class`):

```html
          :class="{ 'cursor-crosshair': genGesture && !genBarBnd && !genResult }"
```

If it already has a `:class`, fold this key into the existing object; if it has none, add this attribute.

- [ ] **Step 5: Verify (live browser-pane, no generation)**

Dev server on `:3002`. In the browser pane, over a compositor:
- Click `[data-testid="generate-tool-toggle"]` to arm; confirm cursor is crosshair.
- Drag a box on empty canvas (pointer down → move → up over a >5%×~0.3% area). Confirm `[data-testid="gen-onbox-bar"]` appears anchored under the box, prompt autofocused, and `[data-testid="gen-onbox-generate"]` is **disabled**.
- Type into `[data-testid="gen-onbox-prompt"]`; confirm Generate **enables**.
- Open the style popover; confirm it lists "No style" + any trained styles.
- A tiny click (no drag) does **not** show the bar (min-size guard).
- Do NOT click Generate (paid). Screenshot the bar for proof.

- [ ] **Step 6: Commit** (private index; same contended-file caution as Task 2)

```bash
SC=<scratchpad>; IDX=$SC/t3.index; REL=frontend/app/components/vue-canvas/CompositorModal.vue
GIT_INDEX_FILE=$IDX git read-tree HEAD
GIT_INDEX_FILE=$IDX git add -- "$REL"
GIT_INDEX_FILE=$IDX git commit -m "feat(compositor): on-box bar for drag-to-generate (prompt + style + generate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git reset -q -- "$REL"
```

---

### Task 4: Option-hold spring arming, keep-alive, Escape/confirm/cancel disarm, style persistence

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (script: `onKeydown` Alt + Escape branches, `onKeyup` Alt branch, `confirmObject`/`cancelObject` gesture branches)

**Interfaces:**
- Consumes: `optDown`, `genSpring`, `genGesture`, `armGenGesture`, `disarmGenGesture`, `lastGenStyle`, `genStyle`, `genResult`, `genDraw`, `genHasMask`, `isSelectTool`, `smartActive`.

- [ ] **Step 1: Spring-arm on Option down (script)**

Find `function onKeydown(e: KeyboardEvent)` (near line 1649). Its body begins by computing whether focus is in a field; locate the `inField` (or equivalent) guard used by the `Space` branch (`if (e.code === 'Space' && !inField)` near line 1682). Add, just before that Space branch:

```ts
  // Option/Alt spring-loads the drag-to-generate gesture (like holding Space to pan).
  // Only from a clean Select state, and never while typing (the on-box prompt is a field).
  if (e.key === 'Alt' && !inField && !optDown.value && !genActive.value
      && !smartActive.value && isSelectTool.value && !editingId.value) {
    optDown.value = true
    armGenGesture(true)
    return
  }
```

If the local variable is not named `inField`, use whatever that function computes for "focus is in an INPUT/TEXTAREA/SELECT" (read the Space branch to copy the exact expression).

- [ ] **Step 2: Escape disarms the gesture (script)**

Near the top of `onKeydown`, alongside the existing `Escape` handlers (e.g. the pen one near line 1660), add — before them so it wins while armed:

```ts
  if (e.key === 'Escape' && genGesture.value) {
    e.stopPropagation()
    if (genResult.value) cancelObject()
    else disarmGenGesture()
    return
  }
```

- [ ] **Step 3: Spring release on Option up (script)**

Find `function onKeyup(e: KeyboardEvent)` (near line 1705). Add an Alt branch:

```ts
function onKeyup(e: KeyboardEvent) {
  if (e.code === 'Space') spaceDown.value = false
  if (e.key === 'Alt') {
    optDown.value = false
    // Keep-alive: releasing Option MID-GESTURE (a box is being/has been drawn, or a
    // result awaits) does NOT disarm — matches Space-pan. Otherwise, drop the arm.
    if (genSpring.value && !genDraw.value && !genHasMask.value && !genResult.value) disarmGenGesture()
    else genSpring.value = false   // committed to a box → becomes a sticky arm
  }
}
```

(Preserve the existing `spaceDown` line exactly; only add the `Alt` block.)

- [ ] **Step 4: Persist last style + disarm on confirm/cancel (script)**

Find `function confirmObject()` (near line 4672) and `function cancelObject()` (near line 4666). Replace both with:

```ts
function cancelObject() {
  const r = genResult.value; if (!r) return
  deleteLocal(r.layerId)
  genResult.value = null
  clearGenMask()                 // discarded → drop the drawn area too
  if (genGesture.value) disarmGenGesture()   // gesture: back to Select
}
function confirmObject() {
  if (genGesture.value) lastGenStyle.value = genStyle.value   // remember the style
  genResult.value = null
  clearGenMask()                 // validated → the drawn area has served its purpose
  if (genGesture.value) disarmGenGesture()   // gesture: back to Select
}
```

- [ ] **Step 5: Verify (live browser-pane, no generation)**

Dev server on `:3002`, over a compositor, in Select mode (nothing else armed):
- Press and HOLD Option; confirm the cursor arms (crosshair) without touching the toolbar.
- With Option held, drag a box → the on-box bar appears.
- Release Option **after** the box is drawn → the bar stays (keep-alive).
- Press Escape → bar/box gone, back to Select (marquee-select works again on empty drag).
- Tap-and-release Option with NO drag → nothing armed (or disarms immediately).
- Confirm marquee-select is unchanged when neither armed nor Option-held.
- Screenshot the Option-armed box+bar for proof.

- [ ] **Step 6: Commit** (private index; contended-file caution)

```bash
SC=<scratchpad>; IDX=$SC/t4.index; REL=frontend/app/components/vue-canvas/CompositorModal.vue
GIT_INDEX_FILE=$IDX git read-tree HEAD
GIT_INDEX_FILE=$IDX git add -- "$REL"
GIT_INDEX_FILE=$IDX git commit -m "feat(compositor): hold-Option spring arm + disarm + style persistence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git reset -q -- "$REL"
```

---

### Task 5: Playwright interaction E2E (no generation call)

**Files:**
- Create: `frontend/tests/frame-drag-to-generate.spec.ts`

**Interfaces:**
- Consumes: `openCompositor` from `tests/_helpers.ts`; the `data-testid`s added in Tasks 2–3 (`generate-tool-toggle`, `gen-onbox-bar`, `gen-onbox-prompt`, `gen-onbox-generate`).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/frame-drag-to-generate.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { openCompositor, waitForBackend } from './_helpers'

// Interaction-only: proves the drag-to-generate GESTURE (arm → drag box → on-box bar
// → prompt gate → Escape). It never clicks Generate — that call is paid and metered.
test('drag-to-generate: arm, drag a box, prompt gates Generate, Escape disarms', async ({ page }) => {
  test.setTimeout(120_000)
  await waitForBackend(page)
  await openCompositor(page)

  // Arm from the toolbar.
  const arm = page.locator('[data-testid="generate-tool-toggle"]')
  await expect(arm).toBeVisible({ timeout: 20_000 })
  await arm.click()

  // The buried region panel must NOT appear (the gesture suppresses it).
  await expect(page.getByText('Generate in region', { exact: false })).toHaveCount(0)

  // Drag a box on the artboard. The artboard is the element that owns the canvas
  // pointer handlers; grab its box and drag across the middle third.
  const artboard = page.locator('[data-testid="frame-card-stack-canvas"]').first()
  const box = await artboard.boundingBox()
  if (!box) throw new Error('no artboard bounding box')
  const x0 = box.x + box.width * 0.35, y0 = box.y + box.height * 0.35
  const x1 = box.x + box.width * 0.65, y1 = box.y + box.height * 0.6
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 })
  await page.mouse.move(x1, y1, { steps: 6 })
  await page.mouse.up()

  // The on-box bar appears; Generate is disabled until a prompt is typed.
  const bar = page.locator('[data-testid="gen-onbox-bar"]')
  await expect(bar).toBeVisible({ timeout: 5_000 })
  const generate = page.locator('[data-testid="gen-onbox-generate"]')
  await expect(generate).toBeDisabled()

  await page.locator('[data-testid="gen-onbox-prompt"]').fill('a red bicycle')
  await expect(generate).toBeEnabled()

  // Escape disarms: the bar disappears (never generated).
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
})
```

If `openCompositor`/`waitForBackend` are not both exported from `tests/_helpers.ts`, read that file and import the actual helper names it exposes (e.g. only `openCompositor`), and gate on `[data-ready]` per the harness convention. If the artboard's canvas testid differs in the compositor DOM (vs the Frame card), read the compositor template and use the artboard element that binds `onCanvasPointerDownCapture` — target its bounding box.

- [ ] **Step 2: Run it to verify it fails (before Tasks 2–3 land) or passes (after)**

Run: `cd frontend && npx playwright test tests/frame-drag-to-generate.spec.ts --reporter=line`
Expected once Tasks 2–4 are in: PASS. (If run in isolation first, it fails on the missing `generate-tool-toggle` locator — confirming the assertion bites.)

- [ ] **Step 3: If red, fix selectors/timing, not the feature**

Adjust locators/waits to the real DOM (per the notes in Step 1). Re-run until green. Do not add a Generate click.

- [ ] **Step 4: Commit**

```bash
SC=<scratchpad>; IDX=$SC/t5.index; REL=frontend/tests/frame-drag-to-generate.spec.ts
GIT_INDEX_FILE=$IDX git read-tree HEAD
GIT_INDEX_FILE=$IDX git add -- "$REL"
GIT_INDEX_FILE=$IDX git commit -m "test(compositor): E2E for drag-to-generate gesture (no paid call)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git reset -q -- "$REL"
```

---

### Task 6: One live paid generation + proof (manual)

**Files:** none (verification only).

- [ ] **Step 1: Do one real generation end to end**

With the dev server on `:3002` and ComfyUI/Replicate reachable, in the browser pane:
- Arm (toolbar or hold Option), drag a box, type a prompt (e.g. "a potted monstera plant"), optionally pick a trained style, click **Generate**.
- Wait for the region FX sweep to finish and the object to land.

- [ ] **Step 2: Assert the result is a transparent cut-out layer**

- The generated subject appears inside the box with **no background** (the frame/other layers show through around it).
- The re-roll ↺ / confirm ✓ / cancel ✕ mini-bar is anchored to it.
- Click ✓ → the tool disarms to Select; the layer is a normal image layer (move/scale/select like any other).
- Re-arm and generate a second time → the previously chosen style is still selected (persistence); the prompt field is empty (cleared).

- [ ] **Step 3: Capture proof**

Screenshot the transparent element over the frame (something clearly showing through behind it), and send it to the user with `SendUserFile`.

- [ ] **Step 4: Update the build dashboard + write a memory**

- Update the live build dashboard per the `update-dashboard-on-every-commit` rule (read the live one first; replace in place).
- Write a `project`/`feedback` memory recording: the gesture re-surfaces the existing `genActive` engine; the arm/disarm + Option-spring model; that Generate is a paid call (E2E must not click it); and that the old AI→Region panel is intentionally still present (consolidation is a follow-up). Link `[[frame-ux-model-elements-not-panel-generators]]`.

---

## Self-Review

**Spec coverage:**
- Drag a box to generate → Tasks 2 (arm), 3 (drag → bar), pointer dispatch reused (no change needed, `genActive && genTool==='box'` already routes).
- Pick a style → Task 3 (style popover from `useStyleList`, "No style" default).
- Transparent/no-background → reused engine (`removeBackground → cleanCutoutAlpha`), asserted in Task 6.
- Coexist with Select → Tasks 2/4 (armed-only ownership; Option scoped to a clean Select state; marquee-select unchanged).
- Two entry points (toolbar + hold Option) → Task 2 (button), Task 4 (Option spring + keep-alive).
- Disarm on confirm/Escape; keep last style, clear prompt → Task 4.
- Top-level toolbar button; useStyleList only; persistence → Tasks 2/3/4 (matches the resolved decisions).
- Old AI→Region panel left intact → Task 2 only adds `&& !genGesture` to its `v-if`; the panel still shows when reached the old way.

**Placeholder scan:** No TBD/TODO; every code step shows real code. The two "read the neighbouring markup / helper names and mirror" notes (Task 2 Step 4, Task 5 Step 1) are precise fallbacks for DOM/exports that can't be quoted verbatim from here, not placeholders for feature logic.

**Type consistency:** `genGesture`, `genSpring`, `optDown`, `lastGenStyle`, `genBarBnd`, `genPromptRef`, `genBarStyle`, `armGenGesture(spring?)`, `disarmGenGesture()`, `toggleGenGesture()` are named identically across all tasks. Helper names `genGestureDefaults`/`genBoxIsValid`/`genBarPlacement` and `GenGestureBounds` match Task 1's exports. Reused symbols (`genActive`, `genTool`, `genMode`, `genModel`, `genTargetId`, `genStyle`, `stylePickerOpen`, `styleList`, `genPrompt`, `genHasMask`, `genMaskBounds`, `genDraw`, `clearGenMask`, `exitGenMode`, `exitOtherToolsFor`, `runRegionFill`, `genResult`, `deleteLocal`, `canvasDisplay`, `inpaint`) are quoted from the current CompositorModal.vue.
