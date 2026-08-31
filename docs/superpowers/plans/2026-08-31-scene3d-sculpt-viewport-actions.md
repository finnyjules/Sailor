# Scene3D Sculpt Viewport Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 3D Studio's sculpt controls and selection-action verbs off the far-right/left panels and into floating viewport toolbars — a top-center selection bar and a bottom-dock sculpt pill that replaces the add/create toolbar while sculpting.

**Architecture:** Two new presentational Vue components mounted as absolute children of the viewport (`viewportEl`). `Scene3DSculptToolbar.vue` occupies the bottom-center dock while `sculpting` (evicting the add-toolbar, exactly as Motion mode's timeline does). `Scene3DViewportActions.vue` floats top-center while a selection has an applicable verb, leaving the create shelf in place. A single pure helper `sculptDecision` gates the unified convert-then-sculpt verb behind a one-time confirm. All existing surface state and side-effecting handlers are reused verbatim; only presentation moves.

**Tech Stack:** Nuxt 4, Vue 3.5 (`<script setup lang="ts">`, `defineModel`), Tailwind, lucide-vue-next, Vitest (unit), three.js. Path alias `~/` → `frontend/app/`.

## Global Constraints

- Overlay bars sit inside `viewportEl`, which OrbitControls binds to. Every interactive bar MUST carry `@pointerdown.stop` and be `pointer-events-auto`, or button clicks get captured by OrbitControls (retargeting click to the viewport and starting a stray orbit-drag). This matches the existing snap-toolbar (`Scene3DStudioSurface.vue:3404`) and add-toolbar (`:3446`) precedents.
- Action blue (`#4f8cff`) is Sailor's only accent; purple is banned. Primary buttons use `StudioButton variant="primary"`.
- New components import their own lucide icons; do not assume icons are globally available.
- Sculpt engine code (`frontend/app/lib/scene3d/sculpt/*`) is NOT modified — the existing sculpt unit tests must stay green.
- Commit hygiene: parallel sessions are active. Stage only the exact files each task names — never `git add -A`, never stash.
- Spec: `docs/superpowers/specs/2026-08-31-scene3d-sculpt-viewport-actions-design.md`.

---

### Task 1: `sculptDecision` pure helper

The unified Sculpt verb must decide, for the current single-primitive selection, whether to enter sculpt directly (already a mesh), ask for confirmation first (non-mesh, not suppressed), or convert-then-enter (non-mesh, confirm suppressed this session). This is the one piece of real logic; it lives in a pure, unit-tested helper.

**Files:**
- Create: `frontend/app/lib/scene3d/sculpt/decision.ts`
- Test: `frontend/tests/unit/scene3d-sculpt-decision.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SculptAction = 'enter' | 'confirm' | 'convert-then-enter'` and `function sculptDecision(isMesh: boolean, confirmSuppressed: boolean): SculptAction`. Consumed by Task 3's surface computeds.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-sculpt-decision.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sculptDecision } from '~/lib/scene3d/sculpt/decision'

describe('sculptDecision', () => {
  it('enters directly when the selection is already a mesh', () => {
    expect(sculptDecision(true, false)).toBe('enter')
    expect(sculptDecision(true, true)).toBe('enter')
  })

  it('asks for confirmation before freezing a non-mesh primitive', () => {
    expect(sculptDecision(false, false)).toBe('confirm')
  })

  it('skips the confirm once suppressed, converting then entering', () => {
    expect(sculptDecision(false, true)).toBe('convert-then-enter')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-sculpt-decision.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/scene3d/sculpt/decision` (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/lib/scene3d/sculpt/decision.ts`:

```ts
// Which entry path the unified Sculpt verb takes for the current
// single-primitive selection. A `mesh` primitive sculpts directly; a non-mesh
// primitive must first be frozen to a mesh (convertToMesh — irreversible), so
// that is gated behind a one-time confirm unless the user suppressed it this
// session.
export type SculptAction = 'enter' | 'confirm' | 'convert-then-enter'

export function sculptDecision(isMesh: boolean, confirmSuppressed: boolean): SculptAction {
  if (isMesh) return 'enter'
  return confirmSuppressed ? 'convert-then-enter' : 'confirm'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-sculpt-decision.unit.spec.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/scene3d/sculpt/decision.ts frontend/tests/unit/scene3d-sculpt-decision.unit.spec.ts
git commit -m "feat(scene3d): sculptDecision helper for unified sculpt verb"
```

---

### Task 2: Sculpt bottom-dock toolbar (build + wire)

Build the new floating sculpt pill and swap it into the bottom-center dock while `sculpting`, replacing both the old right-column `Scene3DSculptPanel` and (visually) the add/create toolbar. The sculpt *entry point* stays the old Objects-panel pill row for this task — Task 3 replaces that. This keeps Task 2 independently testable: convert a cube to mesh, click the old Sculpt pill, and verify the new bottom toolbar drives the session.

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/Scene3DSculptToolbar.vue`
- Delete: `frontend/app/components/vue-canvas/studio/Scene3DSculptPanel.vue`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (import swap `:48-51` area; add-toolbar gate `:3446`; new bottom-dock block near `:3446`; remove sculpt-panel usage `:3835-3852`; dim snap/Light `:3403-3404`)

**Interfaces:**
- Consumes: the surface's existing sculpt state/handlers — `sculptBrush` (`ref<BrushKind>`), `sculptSize`/`sculptStrength`/`sculptSymmetry`/`sculptSymmetryAxis`/`sculptSymmetryCount`/`sculptRemeshResolution`, readouts `sculptVertexCount`/`sculptMeshKB`/`sculptRemeshBusy`/`committing`/`convertError`, handlers `commitAndExitSculpt()`/`remeshSculptSession()`, and `sculpting` (`ref(false)`).
- Produces: `Scene3DSculptToolbar` with v-models `brush/size/strength/symmetry/symmetryAxis/symmetryCount/remeshResolution`, props `committing?/remeshVertexCount/remeshKb/remeshBusy?/remeshError?`, emits `apply/exit/remesh` — the identical contract of the retired `Scene3DSculptPanel`.

- [ ] **Step 1: Create the sculpt toolbar component**

Create `frontend/app/components/vue-canvas/studio/Scene3DSculptToolbar.vue`:

```vue
<script setup lang="ts">
// Sculpt-mode floating toolbar — a single centered pill in the viewport's
// bottom-center dock, shown while `sculpting`. It replaces the add/create
// toolbar there (the same dock Motion mode's timeline uses) and supersedes the
// retired Scene3DSculptPanel. Same v-model surface + apply/exit/remesh emits,
// so the surface's state and handlers bind unchanged.
import { ref, computed } from 'vue'
import { Paintbrush, Feather, Wind, Hammer, Hand, Magnet, Spline, Minus, Plus, Loader2, ChevronUp } from 'lucide-vue-next'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import { REMESH_RESOLUTION_MAX } from '~/lib/scene3d/toMesh'
import type { BrushKind } from '~/lib/scene3d/sculpt/brushes'
import type { SymmetryMode } from '~/lib/scene3d/sculpt/symmetry'

const brush = defineModel<BrushKind>('brush', { required: true })
const size = defineModel<number>('size', { required: true })
const strength = defineModel<number>('strength', { required: true })
const symmetry = defineModel<SymmetryMode>('symmetry', { required: true })
const symmetryAxis = defineModel<0 | 1 | 2>('symmetryAxis', { required: true })
const symmetryCount = defineModel<number>('symmetryCount', { required: true })
const remeshResolution = defineModel<number>('remeshResolution', { required: true })

const props = defineProps<{
  committing?: boolean
  remeshVertexCount: number
  remeshKb: string
  remeshBusy?: boolean
  remeshError?: string
}>()

defineEmits<{ apply: []; exit: []; remesh: [] }>()

const BRUSHES: { kind: BrushKind; icon: unknown; label: string }[] = [
  { kind: 'draw', icon: Paintbrush, label: 'Draw' },
  { kind: 'smooth', icon: Feather, label: 'Smooth' },
  { kind: 'inflate', icon: Wind, label: 'Inflate' },
  { kind: 'flatten', icon: Hammer, label: 'Flatten' },
  { kind: 'grab', icon: Hand, label: 'Grab' },
  { kind: 'pinch', icon: Magnet, label: 'Pinch' },
  { kind: 'crease', icon: Spline, label: 'Crease' },
]

const SYMMETRY_OPTIONS = ['none', 'mirror', 'radial']
const AXIS_LABELS = ['x', 'y', 'z'] as const
const AXIS_OPTIONS = [...AXIS_LABELS]
const axisLabel = computed<string>({
  get: () => AXIS_LABELS[symmetryAxis.value],
  set: (v) => { symmetryAxis.value = AXIS_LABELS.indexOf(v as typeof AXIS_LABELS[number]) as 0 | 1 | 2 },
})

const MIN_RADIAL_COUNT = 2
const MAX_RADIAL_COUNT = 16
function stepCount(delta: number) {
  symmetryCount.value = Math.min(MAX_RADIAL_COUNT, Math.max(MIN_RADIAL_COUNT, symmetryCount.value + delta))
}

const busy = computed(() => !!props.committing || !!props.remeshBusy)
const symOpen = ref(false)
const remeshOpen = ref(false)
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-1.5 rounded-[12px] border border-white/10 bg-[#1a1a1a]/95 p-1.5 shadow-lg backdrop-blur"
       @pointerdown.stop>
    <!-- Brushes: icon strip (StudioSegmented is string-only, so this is hand-rolled) -->
    <div class="flex items-center gap-0.5">
      <button v-for="b in BRUSHES" :key="b.kind" type="button" :title="b.label + ' — hold Alt to carve inward'"
              class="rounded-[6px] p-1.5"
              :class="brush === b.kind ? 'bg-white text-neutral-900' : 'text-white/70 hover:bg-white/10'"
              @click="brush = b.kind">
        <component :is="b.icon" class="size-4" />
      </button>
    </div>

    <div class="mx-0.5 h-6 w-px bg-white/10" />

    <!-- Size / Strength: house sliders in fixed-width wrappers so they sit inline -->
    <div class="w-28"><StudioSlider v-model="size" label="Size" :min="0.02" :max="1" :step="0.01" /></div>
    <div class="w-28"><StudioSlider v-model="strength" label="Str" :min="0.05" :max="1" :step="0.05" /></div>

    <div class="mx-0.5 h-6 w-px bg-white/10" />

    <!-- Symmetry popover (opens upward — dock is at the viewport's bottom edge) -->
    <div class="relative">
      <button type="button" class="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[12px]"
              :class="symmetry !== 'none' ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10'"
              @click="symOpen = !symOpen; remeshOpen = false">
        Symmetry <ChevronUp class="size-3.5" :class="{ 'rotate-180': !symOpen }" />
      </button>
      <div v-if="symOpen" class="absolute bottom-full left-0 mb-2 w-56 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 shadow-xl">
        <StudioSegmented v-model="symmetry" :options="SYMMETRY_OPTIONS" />
        <div v-if="symmetry === 'radial'" class="flex items-center gap-3 pt-1">
          <div class="flex items-center gap-1 text-[11px] text-white/50">
            <span>Count</span>
            <button type="button" class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="symmetryCount <= MIN_RADIAL_COUNT" @click="stepCount(-1)"><Minus :size="11" /></button>
            <span class="w-5 text-center tabular-nums text-white/80">{{ symmetryCount }}</span>
            <button type="button" class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="symmetryCount >= MAX_RADIAL_COUNT" @click="stepCount(1)"><Plus :size="11" /></button>
          </div>
          <div class="flex flex-1 items-center gap-1 text-[11px] text-white/50">
            <span>Axis</span><StudioSegmented v-model="axisLabel" :options="AXIS_OPTIONS" />
          </div>
        </div>
      </div>
    </div>

    <!-- Remesh popover -->
    <div class="relative">
      <button type="button" class="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[12px] text-white/70 hover:bg-white/10"
              @click="remeshOpen = !remeshOpen; symOpen = false">
        Remesh <ChevronUp class="size-3.5" :class="{ 'rotate-180': !remeshOpen }" />
      </button>
      <div v-if="remeshOpen" class="absolute bottom-full left-0 mb-2 w-64 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 shadow-xl">
        <StudioSlider v-model="remeshResolution" label="Resolution" :min="16" :max="REMESH_RESOLUTION_MAX" :step="1" />
        <p class="text-[11px] text-white/45">{{ remeshVertexCount.toLocaleString('en-US') }} vertices · {{ remeshKb }} KB</p>
        <p class="text-[11px] leading-snug text-white/45">Rebuilds the sculpted surface at a new density and clears this sculpt's undo history.</p>
        <StudioButton :disabled="busy" @click="$emit('remesh')">
          <span class="flex items-center gap-1.5"><Loader2 v-if="remeshBusy" class="h-3.5 w-3.5 animate-spin" />{{ remeshBusy ? 'Remeshing…' : 'Remesh' }}</span>
        </StudioButton>
        <p v-if="remeshError" class="text-[11px] leading-snug text-red-400/90">{{ remeshError }}</p>
      </div>
    </div>

    <div class="mx-0.5 h-6 w-px bg-white/10" />

    <StudioButton variant="secondary" :disabled="busy" @click="$emit('exit')">Exit</StudioButton>
    <StudioButton variant="primary" :disabled="busy" @click="$emit('apply')">Apply</StudioButton>
  </div>
</template>
```

- [ ] **Step 2: Swap the import in the surface**

In `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, find the `Scene3DSculptPanel` import (near `:48-51`) and replace it:

```ts
// OLD
import Scene3DSculptPanel from '~/components/vue-canvas/studio/Scene3DSculptPanel.vue'
// NEW
import Scene3DSculptToolbar from '~/components/vue-canvas/studio/Scene3DSculptToolbar.vue'
```

- [ ] **Step 3: Gate the add-toolbar to hide during sculpt**

At `:3446`, extend the add-toolbar's `v-if` so it yields the bottom dock while sculpting:

```html
<!-- OLD -->
<div v-if="webglOk && activeTab !== 'motion'" class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10" data-prim-menu @pointerdown.stop>
<!-- NEW -->
<div v-if="webglOk && activeTab !== 'motion' && !sculpting" class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10" data-prim-menu @pointerdown.stop>
```

- [ ] **Step 4: Mount the sculpt toolbar in the bottom dock**

Immediately after the add-toolbar block's closing `</div>` (the block that starts at `:3446` and ends before the shader-frozen hint / motion timeline siblings), add a new sibling inside `viewportEl`:

```html
<!-- Sculpt bottom-dock toolbar: occupies the same bottom-center spot as the
     add-toolbar while a sculpt session is open (add-toolbar is gated off by
     `!sculpting` above). @pointerdown.stop so brush clicks don't reach
     OrbitControls; the pill itself is pointer-events-auto. -->
<div v-if="webglOk && sculpting" class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10" @pointerdown.stop>
  <Scene3DSculptToolbar
    v-model:brush="sculptBrush"
    v-model:size="sculptSize"
    v-model:strength="sculptStrength"
    v-model:symmetry="sculptSymmetry"
    v-model:symmetryAxis="sculptSymmetryAxis"
    v-model:symmetryCount="sculptSymmetryCount"
    v-model:remeshResolution="sculptRemeshResolution"
    :remesh-vertex-count="sculptVertexCount"
    :remesh-kb="sculptMeshKB"
    :remesh-busy="sculptRemeshBusy"
    :remesh-error="convertError"
    :committing="committing"
    @apply="commitAndExitSculpt"
    @exit="commitAndExitSculpt"
    @remesh="remeshSculptSession"
  />
</div>
```

- [ ] **Step 5: Remove the old right-column sculpt panel usage**

Delete the `<Scene3DSculptPanel ... />` block at `:3835-3852` (the `v-if="sculpting && selectedMesh"` element and all its bindings). Leave the Geometry `StudioControlPanel` that follows it untouched — it now renders normally at all times. Also delete the surrounding explanatory comment block at `:3824-3834` that describes the sibling-swap.

- [ ] **Step 6: Dim the snap/Light toggles during sculpt**

At `:3403-3404`, add a dim/disable when `sculpting` (snap governs gizmo dragging, inert during a stroke). Change the toolbar div's class binding to an array:

```html
<!-- OLD -->
<div v-if="webglOk" class="absolute top-3 flex items-center gap-2 rounded-lg bg-black/60 p-1.5 backdrop-blur"
     :class="panelsVisible ? 'left-[var(--studio-panel-inset)]' : 'left-3'" @pointerdown.stop>
<!-- NEW -->
<div v-if="webglOk" class="absolute top-3 flex items-center gap-2 rounded-lg bg-black/60 p-1.5 backdrop-blur transition-opacity"
     :class="[panelsVisible ? 'left-[var(--studio-panel-inset)]' : 'left-3', sculpting ? 'pointer-events-none opacity-40' : '']" @pointerdown.stop>
```

- [ ] **Step 7: Delete the retired panel file**

```bash
git rm frontend/app/components/vue-canvas/studio/Scene3DSculptPanel.vue
```

- [ ] **Step 8: Verify the sculpt engine tests still pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-sculpt-brushes.unit.spec.ts tests/unit/scene3d-sculpt-session.unit.spec.ts tests/unit/scene3d-sculpt-symmetry.unit.spec.ts`
Expected: PASS — engine untouched.

- [ ] **Step 9: Live browser check (no component-test infra exists)**

Start the dev server if not running: `cd frontend && npm run dev` (note the port from output; use `127.0.0.1`, not `localhost`). In the Browser pane, `preview_start` / `navigate` to `http://127.0.0.1:<port>/dev/scene3d-lab` (this dev page mounts `Scene3DStudioSurface`).

Then verify, using `read_console_messages` after each interaction (expect no errors):
1. Add a primitive from the bottom add-toolbar (e.g. a cube).
2. With it selected, click the Objects-panel **To mesh** pill, then the **Sculpt** pill.
3. Confirm: the bottom add-toolbar disappears and the new sculpt pill appears bottom-center; the right column keeps its normal Transform/Material inspector (no panel swap); the snap/Light toggles are dimmed.
4. Click each brush icon — the active one highlights. Drag Size/Strength. Open the Symmetry and Remesh popovers (they open upward). Run Remesh; the vertex/KB readout updates.
5. Click **Apply** — the session commits, sculpt exits, and the add-toolbar returns to the bottom dock.
6. Screenshot for the record.

- [ ] **Step 10: Commit**

```bash
git add frontend/app/components/vue-canvas/studio/Scene3DSculptToolbar.vue frontend/app/components/vue-canvas/Scene3DStudioSurface.vue
git commit -m "feat(scene3d): sculpt bottom-dock toolbar replaces right-column panel"
```

---

### Task 3: Top-center selection actions bar (build + wire)

Build the contextual selection-verb bar, wire the unified convert-then-sculpt verb (with confirm), mount it top-center, and remove the old Objects-panel pill row and aside merge popover. After this task the far-left pill row is gone and all selection verbs live on the floating bar.

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/Scene3DViewportActions.vue`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (import; new computeds + `sculptSelection` handler + `sculptConfirmSuppressed` ref; mount top-center; remove pill row `:3697-3713` and aside merge popover `:3717-3730`)

**Interfaces:**
- Consumes: `sculptDecision` (Task 1); existing gates `canGroup`/`canUngroup`/`canConvertToMesh`/`canSculpt`/`canMerge`; existing handlers `groupSelection()`/`ungroupSelection()`/`convertSelectionToMesh()` (async)/`mergeSelection()` (async)/`enterSculpt()` (async); existing merge state `mergeOpProxy`/`mergeBlend`/`mergeResolution`/`mergeBusy`; `selected` computed; `convertError` ref.
- Produces: `Scene3DViewportActions` with props `canGroup/canUngroup/canEnterSculpt/canConvertToMesh/canMerge/sculptConfirmNeeded/selectedKindLabel/mergeBusy?`, v-models `mergeOp/mergeBlend/mergeResolution`, emits `group/ungroup/convert/sculpt/merge/suppressConfirm`; and the surface's `canEnterSculpt`, `sculptConfirmNeeded`, `selectedKindLabel` computeds + `sculptSelection()` handler + `sculptConfirmSuppressed` ref.

- [ ] **Step 1: Create the selection actions component**

Create `frontend/app/components/vue-canvas/studio/Scene3DViewportActions.vue`:

```vue
<script setup lang="ts">
// Contextual selection-verb bar, floated top-center of the 3D viewport, shown
// while NOT sculpting whenever the selection has an applicable verb. Selection
// is transient, so this leaves the bottom add/create shelf in place; sculpt is
// the sustained mode that takes over the bottom dock instead. Presentational
// only — every verb is an emit the surface handles; local state is just the
// three popovers.
import { ref } from 'vue'
import { Group, Ungroup, Paintbrush, Combine, Boxes, MoreHorizontal, Loader2 } from 'lucide-vue-next'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { REMESH_RESOLUTION_MAX } from '~/lib/scene3d/toMesh'

const props = defineProps<{
  canGroup: boolean
  canUngroup: boolean
  canEnterSculpt: boolean
  canConvertToMesh: boolean
  canMerge: boolean
  sculptConfirmNeeded: boolean
  selectedKindLabel: string
  mergeBusy?: boolean
}>()

const mergeOp = defineModel<string>('mergeOp', { required: true })
const mergeBlend = defineModel<number>('mergeBlend', { required: true })
const mergeResolution = defineModel<number>('mergeResolution', { required: true })

const emit = defineEmits<{ group: []; ungroup: []; convert: []; sculpt: []; merge: []; suppressConfirm: [] }>()

const mergeOpen = ref(false)
const overflowOpen = ref(false)
const confirmOpen = ref(false)
const dontAskAgain = ref(false)

function onSculptClick() {
  if (props.sculptConfirmNeeded) { confirmOpen.value = true; return }
  emit('sculpt')
}
function confirmSculpt() {
  if (dontAskAgain.value) emit('suppressConfirm')
  confirmOpen.value = false
  emit('sculpt')
}
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-1 rounded-[12px] border border-white/10 bg-[#1a1a1a]/95 p-1.5 shadow-lg backdrop-blur" @pointerdown.stop>
    <StudioButton v-if="canGroup" @click="$emit('group')"><span class="flex items-center gap-1.5"><Group class="h-3.5 w-3.5" /> Group</span></StudioButton>
    <StudioButton v-if="canUngroup" @click="$emit('ungroup')"><span class="flex items-center gap-1.5"><Ungroup class="h-3.5 w-3.5" /> Ungroup</span></StudioButton>

    <!-- Sculpt: unified convert-then-sculpt. Confirm popover only when the
         selection is a non-mesh primitive and the confirm isn't suppressed. -->
    <div v-if="canEnterSculpt" class="relative">
      <StudioButton variant="primary" @click="onSculptClick"><span class="flex items-center gap-1.5"><Paintbrush class="h-3.5 w-3.5" /> Sculpt</span></StudioButton>
      <div v-if="confirmOpen" class="absolute left-0 top-full mt-2 w-64 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 text-[12px] shadow-xl">
        <p class="leading-snug text-white/80">Sculpting freezes this {{ selectedKindLabel }} to an editable mesh — its parameters will be replaced.</p>
        <label class="flex items-center gap-1.5 text-[11px] text-white/55"><input v-model="dontAskAgain" type="checkbox" /> Don't ask again</label>
        <div class="flex justify-end gap-2">
          <StudioButton variant="secondary" @click="confirmOpen = false">Cancel</StudioButton>
          <StudioButton variant="primary" @click="confirmSculpt">Sculpt</StudioButton>
        </div>
      </div>
    </div>

    <!-- Merge popover -->
    <div v-if="canMerge" class="relative">
      <StudioButton @click="mergeOpen = !mergeOpen; overflowOpen = false"><span class="flex items-center gap-1.5"><Combine class="h-3.5 w-3.5" /> Merge</span></StudioButton>
      <div v-if="mergeOpen" class="absolute left-0 top-full mt-2 w-64 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 shadow-xl">
        <StudioSegmented v-model="mergeOp" :options="['union', 'subtract', 'intersect']" />
        <p v-if="mergeOp === 'subtract'" class="text-[11px] leading-snug text-white/45">Subtracts everything else FROM the first selected object.</p>
        <StudioSlider v-model="mergeBlend" label="Blend" :min="0" :max="0.3" :step="0.01" />
        <StudioSlider v-model="mergeResolution" label="Resolution" :min="16" :max="REMESH_RESOLUTION_MAX" :step="1" />
        <StudioButton :disabled="mergeBusy" @click="$emit('merge')"><span class="flex items-center gap-1.5"><Loader2 v-if="mergeBusy" class="h-3.5 w-3.5 animate-spin" />{{ mergeBusy ? 'Merging…' : 'Merge' }}</span></StudioButton>
      </div>
    </div>

    <!-- Overflow: Convert to mesh (freeze without sculpting) -->
    <div v-if="canConvertToMesh" class="relative">
      <StudioButton variant="subtle" @click="overflowOpen = !overflowOpen; mergeOpen = false"><MoreHorizontal class="h-4 w-4" /></StudioButton>
      <div v-if="overflowOpen" class="absolute right-0 top-full mt-2 w-48 rounded-lg border border-white/10 bg-[#1a1a1a] p-1 shadow-xl">
        <button type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 hover:bg-white/10" @click="overflowOpen = false; $emit('convert')"><Boxes class="h-3.5 w-3.5" /> Convert to mesh</button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Add the import**

In `Scene3DStudioSurface.vue`, alongside the Task 2 import add:

```ts
import Scene3DViewportActions from '~/components/vue-canvas/studio/Scene3DViewportActions.vue'
import { sculptDecision } from '~/lib/scene3d/sculpt/decision'
```

- [ ] **Step 3: Add the suppression ref, computeds, and handler**

Near the existing sculpt state (after `:2238` `sculptBrush`, anywhere in the `<script setup>` after the gate computeds at `:157` are defined and `convertSelectionToMesh`/`enterSculpt` exist), add:

```ts
// Unified Sculpt verb: a mesh sculpts directly; a non-mesh primitive is frozen
// to a mesh first (irreversible), gated behind a one-time confirm the user can
// suppress for the session. `canEnterSculpt` merges the two existing gates.
const sculptConfirmSuppressed = ref(false)
const canEnterSculpt = computed(() => canSculpt.value || canConvertToMesh.value)
const sculptConfirmNeeded = computed(() =>
  canEnterSculpt.value && sculptDecision(canSculpt.value, sculptConfirmSuppressed.value) === 'confirm')
const selectedKindLabel = computed(() => {
  const o = selected.value
  return o && o.kind === 'primitive' ? (o as PrimitiveObject).primitive : 'shape'
})

async function sculptSelection() {
  const o = selected.value
  if (!o || o.kind !== 'primitive') return
  if ((o as PrimitiveObject).primitive !== 'mesh') {
    await convertSelectionToMesh()
    if (convertError.value) return
  }
  // convertSelectionToMesh replaces the object in place and reselects it; if
  // the selection somehow isn't a mesh now, bail rather than enter a bad state.
  if (!selectedMesh.value) return
  await enterSculpt()
}
```

Note: `PrimitiveObject` is already imported/used in the surface (see `selectedMesh` at `:1955`). If the type isn't in scope at your insertion point, it is imported at the top of the file already — no new import needed.

- [ ] **Step 4: Mount the actions bar top-center**

Inside `viewportEl` (a sibling of the snap toolbar at `:3403`), add:

```html
<!-- Contextual selection actions, top-center. Only while not sculpting and the
     selection has an applicable verb. Clears the top-left snap toggles and the
     top-right shader-frozen hint. @pointerdown.stop so chip clicks don't reach
     OrbitControls. -->
<div v-if="webglOk && !sculpting && (canGroup || canUngroup || canEnterSculpt || canMerge)"
     class="absolute top-3 left-1/2 -translate-x-1/2 z-10" @pointerdown.stop>
  <Scene3DViewportActions
    :can-group="canGroup"
    :can-ungroup="canUngroup"
    :can-enter-sculpt="canEnterSculpt"
    :can-convert-to-mesh="canConvertToMesh"
    :can-merge="canMerge"
    :sculpt-confirm-needed="sculptConfirmNeeded"
    :selected-kind-label="selectedKindLabel"
    :merge-busy="mergeBusy"
    v-model:mergeOp="mergeOpProxy"
    v-model:mergeBlend="mergeBlend"
    v-model:mergeResolution="mergeResolution"
    @group="groupSelection"
    @ungroup="ungroupSelection"
    @convert="convertSelectionToMesh"
    @sculpt="sculptSelection"
    @merge="mergeSelection"
    @suppress-confirm="sculptConfirmSuppressed = true"
  />
</div>
```

- [ ] **Step 5: Remove the old Objects-panel pill row and aside merge popover**

In the `#aside` template, delete the pill-row block at `:3697-3713` (the `<div v-if="!sculpting && (canGroup || canUngroup || canConvertToMesh || canSculpt || canMerge)" ...>` and its five `StudioButton`s) and the merge popover block at `:3717-3730` (the `<div v-if="canMerge && mergeOpen" ...>`). Leave the `<p v-if="convertError" ...>` line (`:3731`) in place — it still surfaces convert/merge errors.

- [ ] **Step 6: Verify unit + engine tests still pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-sculpt-decision.unit.spec.ts tests/unit/scene3d-sculpt-brushes.unit.spec.ts tests/unit/scene3d-sculpt-session.unit.spec.ts tests/unit/scene3d-sculpt-symmetry.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Live browser check**

Dev server + Browser pane at `http://127.0.0.1:<port>/dev/scene3d-lab`. Verify with `read_console_messages` after each step (no errors):
1. **No selection** → no top-center bar; add-toolbar present.
2. Add a cube and select it → top-center bar shows **Sculpt** (primary) + **Merge** hidden (single object) + overflow **⋯**. The old far-left pill row is gone.
3. Empty-space click deselects → bar hides; add-toolbar still there (you never lost create access).
4. Select the cube, click **Sculpt** → confirm popover appears; **Cancel** leaves the cube parametric (open the right-column Geometry — still a cube with box params).
5. Click **Sculpt** again → confirm → **Sculpt** → converts and enters sculpt (Task 2's bottom pill appears). Tick "Don't ask again", Apply, then Sculpt another fresh cube → no confirm this time.
6. Add a second primitive, select both → **Group** and **Merge** chips show; open Merge popover, pick `union`, Merge → one merged mesh results.
7. Select a single cube → **⋯** → **Convert to mesh** freezes it without entering sculpt (Sculpt chip now enters directly, no confirm).
8. Throughout a sculpt session, edit Material in the right column → still live/editable.
9. Screenshot the top-center bar and the sculpt pill for the record.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/components/vue-canvas/studio/Scene3DViewportActions.vue frontend/app/components/vue-canvas/Scene3DStudioSurface.vue
git commit -m "feat(scene3d): top-center selection actions bar + unified sculpt verb"
```

---

## Self-Review Notes

- **Spec coverage:** top-center selection bar (Task 3), sculpt bottom-dock toolbar (Task 2), add-toolbar eviction while sculpting (Task 2 Step 3), unified convert-then-sculpt with one-time confirm (Task 1 + Task 3), Merge/Convert relocated (Task 3), retire `Scene3DSculptPanel` (Task 2), snap/Light dim during sculpt (Task 2 Step 6), pointer-events discipline (Global Constraints + every bar), Material stays live (Task 3 Step 7.8). All covered.
- **Deferred/at-risk:** `convertSelectionToMesh` reselection behavior is asserted defensively in `sculptSelection` (Step 3) and exercised by Task 3 Step 7.5 — if convert does not leave a mesh selected, that live step catches it and the fix lands in Task 3.
- **Out of scope (unchanged):** per-stroke camera unfreeze, worker-based remesh, bbox-anchored bar.
