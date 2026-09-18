# DialKit Motion UI — Slice 6d: timeline look + gestures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** re-skin `MotionBandTimeline.vue` to DialKit's timeline geometry + gestures (ruler with ticks, drag-seek playhead, alt-drag pivot zoom, shift-reset, wheel/scrollbar pan, DialKit row/clip dimensions, groups, selection ring) — rendered entirely in **Sailor tokens** (PP Neue Montreal + tabular-nums, compositor `#1a1a1a`/`#0e0e10` palette, `#7c9cff` accent, emerald behaviour bands, value-showing clip interiors).

**Architecture:** a new **pure** `app/lib/motionx/timelineView.ts` owns all px/zoom/tick math (ported verbatim from DialKit's `TimelineSection.svelte`), unit-tested. `MotionBandTimeline.vue` gains component-local `zoom`/`viewStart` state, a measured lane width, a ruler row, and the gesture handlers that call into `timelineView`. Transport CONTROLS (play/dur/fps/Bake) stay on the old `CompositorMotionTimeline` this slice (both mounted); 6d owns the timeline canvas + ruler-scrub only. motionx stays the source of truth; no `dialkit` dependency.

**Tech Stack:** Nuxt 4 / Vue 3 `<script setup>` + TS + Tailwind; Vitest; the shipped `~/lib/motionx` + `bands.ts`/`behaviourStore.ts`.

## Global Constraints

- **App works at every step.** Old timeline stays mounted; only `MotionBandTimeline.vue` (a Slice-1 file I own) + new pure files change. No shared-file edits expected in 6d (if `CompositorModal.vue` needs a prop, private-index it).
- **Never `npm run dev`** — reuse `:3002`; verify in the browser pane; re-check `127.0.0.1:8188/system_stats` after any restart.
- **Sailor skin only** — PP Neue Montreal (`--font-sans`) + `tabular-nums` for numerics (NOT Geist Mono); compositor palette; `#7c9cff` selection ring (NOT DialKit `#E8E8E8`/pure white). Keep bands' value-showing interiors.
- **DialKit dimensions (verbatim):** clip/track row 28px, group row 22px, ruler row 28px, label column 96px, clip inset 3px / radius 6px, lane radius 8px. `DRAG_THRESHOLD_PX=3`, `MAJOR_TICK_TARGET_PX=140`, `ZOOM_DRAG_DISTANCE=180`, `MIN_TIMELINE_MAX_ZOOM=8`, `PLAYHEAD_FLAG_WIDTH=52`.
- UI copy sentence-case. Attribution `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. New files → pathspec commit.
- Reference source saved in scratchpad (`src_svelte_components_Timeline_TimelineSection.svelte`, `theme.css`) — port math verbatim, do not re-derive.

---

## File structure

- Create `frontend/app/lib/motionx/timelineView.ts` — pure px/zoom/tick math.
- Create `frontend/tests/unit/motionx/timeline-view.unit.spec.ts` — Vitest.
- Modify `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue` — ruler, playhead, zoom/pan, DialKit skin (own file → pathspec).

## Interfaces produced (timelineView.ts)

```ts
export interface View { zoom: number; viewStart: number }
export interface Derived { visibleDuration: number; safeViewStart: number; viewEnd: number; pxPerSecond: number; maxZoom: number }
export function deriveView(view: View, duration: number, laneWidth: number): Derived
export function clampViewStart(start: number, duration: number, shownDuration: number): number
export function timeToX(time: number, d: Derived): number           // (time - safeViewStart) * pxPerSecond
export function xToTime(x: number, d: Derived): number               // safeViewStart + (x / pxPerSecond)
export function zoomAboutPivot(view: View, duration: number, laneWidth: number, dx: number, anchorRatio: number, anchorTime: number): View
export interface Ticks { major: number[]; medium: number[]; fine: number[]; majorStep: number }
export function computeTicks(d: Derived, zoom: number, duration: number): Ticks
export function formatClock(seconds: number): string                 // mm:ss
export function formatRulerSeconds(time: number, step: number): string
```

---

### Task 1: pure `timelineView.ts` (px/zoom/tick math) — TDD

**Files:**
- Create: `frontend/app/lib/motionx/timelineView.ts`
- Test: `frontend/tests/unit/motionx/timeline-view.unit.spec.ts`

**Interfaces:** Produces the signatures above. No consumes (pure).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/motionx/timeline-view.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  deriveView, clampViewStart, timeToX, xToTime, zoomAboutPivot, computeTicks, formatClock, formatRulerSeconds,
} from '~/lib/motionx/timelineView'

describe('deriveView', () => {
  it('at zoom 1 shows the whole duration', () => {
    const d = deriveView({ zoom: 1, viewStart: 0 }, 4, 800)
    expect(d.visibleDuration).toBe(4)
    expect(d.pxPerSecond).toBe(200)
    expect(d.safeViewStart).toBe(0)
    expect(d.viewEnd).toBe(4)
  })
  it('at zoom 2 shows half, pxPerSecond doubles, viewStart clamps', () => {
    const d = deriveView({ zoom: 2, viewStart: 3.5 }, 4, 800)
    expect(d.visibleDuration).toBe(2)
    expect(d.pxPerSecond).toBe(400)
    expect(d.safeViewStart).toBe(2)   // clamped to duration - visible = 4 - 2
  })
  it('maxZoom is at least 8 and grows with duration/laneWidth', () => {
    expect(deriveView({ zoom: 1, viewStart: 0 }, 0, 0).maxZoom).toBe(8)
    // (140*40)/(0.001*10*800) = 5600/8 = 700
    expect(deriveView({ zoom: 1, viewStart: 0 }, 40, 800).maxZoom).toBeCloseTo(700, 6)
  })
})

describe('clampViewStart', () => {
  it('clamps into [0, duration - shown]', () => {
    expect(clampViewStart(-1, 4, 2)).toBe(0)
    expect(clampViewStart(5, 4, 2)).toBe(2)
    expect(clampViewStart(1, 4, 2)).toBe(1)
  })
})

describe('timeToX / xToTime round-trip', () => {
  it('maps time to px across the visible range and back', () => {
    const d = deriveView({ zoom: 2, viewStart: 1 }, 4, 800)  // visible 2s, pps 400, safeViewStart 1
    expect(timeToX(1, d)).toBe(0)
    expect(timeToX(3, d)).toBe(800)
    expect(xToTime(400, d)).toBeCloseTo(2, 6)
  })
})

describe('zoomAboutPivot', () => {
  it('exponential zoom keeps the anchor time pinned under the cursor', () => {
    const duration = 4, laneWidth = 800
    const before = deriveView({ zoom: 1, viewStart: 0 }, duration, laneWidth)
    const anchorRatio = 0.5
    const anchorTime = before.safeViewStart + anchorRatio * before.visibleDuration  // 2
    const next = zoomAboutPivot({ zoom: 1, viewStart: 0 }, duration, laneWidth, 180, anchorRatio, anchorTime)
    expect(next.zoom).toBeCloseTo(Math.E, 5)   // exp(180/180) = e
    const after = deriveView(next, duration, laneWidth)
    // the anchor time still sits at the same fraction of the (now smaller) window
    expect(after.safeViewStart + anchorRatio * after.visibleDuration).toBeCloseTo(2, 4)
  })
  it('clamps zoom to [1, maxZoom]', () => {
    const next = zoomAboutPivot({ zoom: 1, viewStart: 0 }, 4, 800, -9999, 0.5, 2)
    expect(next.zoom).toBe(1)
  })
})

describe('computeTicks', () => {
  it('at zoom 1 over 4s (pps 200) majors land on whole seconds', () => {
    const d = deriveView({ zoom: 1, viewStart: 0 }, 4, 800)
    const t = computeTicks(d, 1, 4)
    expect(t.majorStep).toBe(1)          // rawStep 0.7 → adaptive 1 (zoom<1.5 & dur>=1 floors to 1)
    expect(t.major).toEqual([0, 1, 2, 3, 4])
    expect(t.medium).toContain(0.5)      // index 5 (0.5) is medium
    expect(t.fine.length).toBeGreaterThan(0)
  })
})

describe('formatClock / formatRulerSeconds', () => {
  it('formatClock is mm:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65)).toBe('1:05')
  })
  it('formatRulerSeconds uses clock for integer >=1s steps, else fixed seconds', () => {
    expect(formatRulerSeconds(2, 1)).toBe('2:00')
    expect(formatRulerSeconds(0.5, 0.1)).toBe('0.5s')
    expect(formatRulerSeconds(0.25, 0.05)).toBe('0.25s')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm run test:unit -- motionx/timeline-view`
Expected: FAIL — cannot find module `~/lib/motionx/timelineView`.

- [ ] **Step 3: Write the implementation (ported verbatim from DialKit `TimelineSection.svelte`)**

```ts
// frontend/app/lib/motionx/timelineView.ts
// Pure timeline view-math for the DialKit-emulated Frame motion timeline (Slice 6d).
// Ported verbatim from dialkit TimelineSection.svelte (MIT). Zero Vue/compositor coupling.

const MAJOR_TICK_TARGET_PX = 140
const MILLISECOND_STEP = 0.001
const MIN_TIMELINE_MAX_ZOOM = 8
const ZOOM_DRAG_DISTANCE = 180
const SECOND_TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export interface View { zoom: number; viewStart: number }
export interface Derived { visibleDuration: number; safeViewStart: number; viewEnd: number; pxPerSecond: number; maxZoom: number }

export function clampViewStart(start: number, duration: number, shownDuration: number): number {
  return clamp(start, 0, Math.max(0, duration - shownDuration))
}

export function deriveView(view: View, duration: number, laneWidth: number): Derived {
  const visibleDuration = duration > 0 ? duration / view.zoom : duration
  const safeViewStart = clampViewStart(view.viewStart, duration, visibleDuration)
  const viewEnd = safeViewStart + visibleDuration
  const pxPerSecond = visibleDuration > 0 && laneWidth > 0 ? laneWidth / visibleDuration : 0
  const maxZoom = Math.max(
    MIN_TIMELINE_MAX_ZOOM,
    laneWidth > 0 && duration > 0
      ? (MAJOR_TICK_TARGET_PX * duration) / (MILLISECOND_STEP * 10 * laneWidth)
      : MIN_TIMELINE_MAX_ZOOM,
  )
  return { visibleDuration, safeViewStart, viewEnd, pxPerSecond, maxZoom }
}

export function timeToX(time: number, d: Derived): number { return (time - d.safeViewStart) * d.pxPerSecond }
export function xToTime(x: number, d: Derived): number { return d.pxPerSecond > 0 ? d.safeViewStart + x / d.pxPerSecond : d.safeViewStart }

export function zoomAboutPivot(view: View, duration: number, laneWidth: number, dx: number, anchorRatio: number, anchorTime: number): View {
  const { maxZoom } = deriveView(view, duration, laneWidth)
  const nextZoom = clamp(view.zoom * Math.exp(dx / ZOOM_DRAG_DISTANCE), 1, maxZoom)
  const nextDuration = duration / nextZoom
  const viewStart = clampViewStart(anchorTime - anchorRatio * nextDuration, duration, nextDuration)
  return { zoom: nextZoom, viewStart }
}

export interface Ticks { major: number[]; medium: number[]; fine: number[]; majorStep: number }
export function computeTicks(d: Derived, zoom: number, duration: number): Ticks {
  const rawStep = d.pxPerSecond > 0 ? MAJOR_TICK_TARGET_PX / d.pxPerSecond : 1
  const adaptive = SECOND_TICK_STEPS.find((s) => s >= rawStep) ?? SECOND_TICK_STEPS[SECOND_TICK_STEPS.length - 1]!
  const majorStep = zoom < 1.5 && duration >= 1 ? Math.max(1, adaptive) : adaptive
  const fineStep = majorStep / 10
  const major: number[] = []
  const medium: number[] = []
  const fine: number[] = []
  const firstMajor = Math.ceil((d.safeViewStart - 1e-6) / majorStep) * majorStep
  for (let time = firstMajor; time <= d.viewEnd + 1e-6; time += majorStep) major.push(Number(time.toFixed(4)))
  const firstFine = Math.ceil((d.safeViewStart - 1e-6) / fineStep)
  const lastFine = Math.floor((d.viewEnd + 1e-6) / fineStep)
  for (let index = firstFine; index <= lastFine; index++) {
    if (index % 10 === 0) continue
    const tick = Number((index * fineStep).toFixed(6))
    if (index % 5 === 0) medium.push(tick); else fine.push(tick)
  }
  return { major, medium, fine, majorStep }
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export function formatRulerSeconds(time: number, step: number): string {
  if (step >= 1 && Number.isInteger(time)) return formatClock(time)
  const decimals = Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))))
  return `${time.toFixed(decimals)}s`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm run test:unit -- motionx/timeline-view`
Expected: PASS. Then `npm run test:unit -- motionx` → whole suite still green (was 79).

- [ ] **Step 5: Commit (pathspec)**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add -- frontend/app/lib/motionx/timelineView.ts frontend/tests/unit/motionx/timeline-view.unit.spec.ts
git commit -m "feat(motionx): pure timeline view-math (px/zoom/ticks), ported from dialkit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/lib/motionx/timelineView.ts frontend/tests/unit/motionx/timeline-view.unit.spec.ts
```

---

### Task 2: ruler + playhead + drag-seek in `MotionBandTimeline.vue`

**Files:** Modify `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue`

**Interfaces:** Consumes `deriveView`, `timeToX`, `xToTime`, `computeTicks`, `formatRulerSeconds` (Task 1). Adds local `zoom`/`viewStart` refs + a measured `laneWidth`. Emits existing `scrub`? — the component currently doesn't scrub; add emits `scrub: [t]`, `pause: []` (wired in Task 6 mount, or keep internal if `t` prop already drives). Keep read via existing `duration`/`t` props.

- [ ] **Step 1: Add view state + lane measurement + derived.** In `<script setup>`:

```ts
import { deriveView, timeToX, xToTime, zoomAboutPivot, computeTicks, formatRulerSeconds, type View } from '~/lib/motionx/timelineView'

const view = ref<View>({ zoom: 1, viewStart: 0 })
const laneEl = ref<HTMLElement | null>(null)
const laneWidth = ref(0)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (laneEl.value) { ro = new ResizeObserver(() => { laneWidth.value = laneEl.value?.clientWidth ?? 0 }); ro.observe(laneEl.value); laneWidth.value = laneEl.value.clientWidth }
})
onBeforeUnmount(() => ro?.disconnect())
const dv = computed(() => deriveView(view.value, props.duration, laneWidth.value))
const ticks = computed(() => computeTicks(dv.value, view.value.zoom, props.duration))
const xOf = (time: number) => timeToX(time, dv.value)
const playheadX = computed(() => Math.max(0, Math.min(laneWidth.value, xOf(props.t ?? 0))))
```

Emits to add: `scrub: [t: number]`, `pause: []`.

- [ ] **Step 2: Replace the band left/width math to use the view.** Every band/point currently maps against full `props.duration`; change to view-relative: `bandLeft` → `xOf(b.start)` (px), `bandWidth` → `(b.end-b.start)*dv.pxPerSecond` px. Convert the grid lane to a positioned px space (the lane is the measured `laneEl`).

- [ ] **Step 3: Add the ruler row + playhead markup** (Sailor-skinned, DialKit dims). Above the layer rows, a grid row `[110px_1fr]` whose second cell is `ref="laneEl"`, height 28px:

```vue
<div class="grid grid-cols-[110px_1fr] gap-x-2">
  <div /> <!-- ruler label spacer -->
  <div ref="laneEl" class="relative h-7 select-none cursor-ew-resize tabular-nums"
    @pointerdown.stop.prevent="onRulerDown">
    <div v-for="tk in ticks.fine" :key="'f'+tk" class="absolute bottom-0 w-px h-2 bg-white/10" :style="{ left: xOf(tk)+'px' }" />
    <div v-for="tk in ticks.medium" :key="'m'+tk" class="absolute bottom-0 w-px h-4 bg-white/15" :style="{ left: xOf(tk)+'px' }" />
    <template v-for="tk in ticks.major" :key="'M'+tk">
      <div class="absolute bottom-0 w-px h-full bg-white/20" :style="{ left: xOf(tk)+'px' }" />
      <span class="absolute bottom-4 -translate-x-1/2 text-[9.5px] text-white/40" :style="{ left: xOf(tk)+'px' }">{{ formatRulerSeconds(tk, ticks.majorStep) }}</span>
    </template>
    <!-- playhead flag (Sailor accent) -->
    <div v-if="t != null" class="absolute inset-y-0 w-px bg-[#7c9cff] z-20 pointer-events-none" :style="{ left: playheadX+'px' }" />
  </div>
  <!-- …layer rows below share the same px space via xOf()… -->
</div>
```

- [ ] **Step 4: Ruler drag-seek + shift-reset** (no alt = seek). Handlers:

```ts
let cleanup: (() => void) | null = null
onScopeDispose(() => cleanup?.())
function onRulerDown(e: PointerEvent) {
  if (e.altKey) return onZoomDown(e)  // Task 3
  const rect = laneEl.value!.getBoundingClientRect()
  const reset = e.shiftKey
  if (reset) view.value = { zoom: 1, viewStart: 0 }
  const base = reset ? { safeViewStart: 0, visibleDuration: props.duration } : dv.value
  emit('pause')
  const seek = (clientX: number) => {
    const frac = (clientX - rect.left) / rect.width
    emit('scrub', Math.max(0, Math.min(props.duration, base.safeViewStart + frac * base.visibleDuration)))
  }
  seek(e.clientX)
  const move = (ev: PointerEvent) => seek(ev.clientX)
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); cleanup = null }
  cleanup = up; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
```

- [ ] **Step 5: Verify live** (reuse `:3002`, do NOT start a server). In a Frame → gradient rect → Motion → the band timeline shows a **ruler with ticks + labels**; dragging the ruler **scrubs** the playhead; the playhead is Sailor `#7c9cff`. `read_console_messages` clean.

- [ ] **Step 6: Commit (pathspec)** — `MotionBandTimeline.vue`.

```bash
git add -- frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue
git commit -m "feat(compositor): DialKit-style ruler + playhead + drag-seek on band timeline (6d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue
```

*(Task 6 wires `@scrub`/`@pause` from `CompositorModal` to `scrubTo`/`pause` — private-index. If `previewT` is null on the Motion tab, initialize it to 0 so the playhead shows; confirm against the running app.)*

---

### Task 3: alt-drag pivot zoom

**Files:** Modify `MotionBandTimeline.vue`

- [ ] **Step 1: Add the zoom-drag handler** using `zoomAboutPivot`:

```ts
function onZoomDown(e: PointerEvent) {
  const rect = laneEl.value!.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const anchorTime = dv.value.safeViewStart + ratio * dv.value.visibleDuration
  const startX = e.clientX
  const startView = { ...view.value }
  let moved = false
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX
    if (!moved && Math.abs(dx) <= 3) return
    moved = true
    view.value = zoomAboutPivot(startView, props.duration, laneWidth.value, dx, ratio, anchorTime)
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); cleanup = null }
  cleanup = up; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
```

- [ ] **Step 2: Verify live** — **alt-drag** the ruler right → zooms in; the time under the cursor stays pinned; ticks re-scale (finer steps appear); alt-drag left → back to zoom 1. Bands/playhead track the zoom.

- [ ] **Step 3: Commit (pathspec).**

---

### Task 4: wheel pan + sticky scrollbar (zoom > 1)

**Files:** Modify `MotionBandTimeline.vue`

- [ ] **Step 1: Wheel pan** on the timeline body — only when `view.zoom > 1`:

```ts
function onWheel(e: WheelEvent) {
  if (view.value.zoom <= 1) return
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0)
  if (!delta) return
  e.preventDefault()
  const d = dv.value
  const nextStart = clampViewStart(d.safeViewStart + delta / d.pxPerSecond, props.duration, d.visibleDuration)
  view.value = { ...view.value, viewStart: nextStart }
}
```
(import `clampViewStart`.)

- [ ] **Step 2: Sticky scrollbar row** below the rows, shown only when `zoom>1`: a horizontally scrollable div whose inner spacer width is `laneWidth * zoom`; `@scroll` sets `viewStart = clampViewStart(scrollLeft / pxPerSecond, …)`; a `watch(dv)` writes `scrollLeft = safeViewStart * pxPerSecond` guarded by a 0.5px deadband to avoid a loop. (Skin the scrollbar minimally in Sailor greys.)

- [ ] **Step 3: Verify live** — zoom in, then two-finger horizontal scroll pans; the scrollbar appears and drags; panning stays within bounds.

- [ ] **Step 4: Commit (pathspec).**

---

### Task 5: DialKit geometry + Sailor skin for bands, groups, selection

**Files:** Modify `MotionBandTimeline.vue`

- [ ] **Step 1: Apply DialKit row/clip dimensions** in Sailor tokens: layer/property rows 28px, group rows 22px, ruler 28px; label column 96px (the grid is currently 110px — change to `[96px_1fr]`); clip bars inset 3px, radius 6px; lane radius 8px; numerics `tabular-nums` in `--font-sans`. Keep behaviour bands emerald + property bands' value interiors; **selection ring `ring-2 ring-[#7c9cff]`** (replace the current styles consistently).

- [ ] **Step 2: Group rows** — when layers share a `groupId`, render a 22px collapsible group header row (chevron `rotate(-90deg)`→`0`) that toggles a local `collapsedGroups: Set<string>`; grouped layer labels indent (14px). Layers without a group render as today.

- [ ] **Step 3: Playhead across all lanes** — draw the `#7c9cff` playhead line down every lane at `playheadX` (already per-lane; ensure it uses `xOf(t)` not the old full-duration mapping).

- [ ] **Step 4: Verify live** — the timeline reads as DialKit's layout but in Sailor's colors/font: tight rows, ruler ticks, 96px labels, `#7c9cff` selection ring on a selected band, groups collapse/expand. Screenshot for proof. No console errors; old timeline below still works.

- [ ] **Step 5: Commit (pathspec).**

---

### Task 6: wire scrub/pause + confirm transport coexistence (SHARED → private index)

**Files:** Modify `frontend/app/components/vue-canvas/CompositorModal.vue`

- [ ] **Step 1:** On the `MotionBandTimeline` mount add `@scrub="scrubTo" @pause="pause"`. If `previewT` is null while on the Motion tab, set it to 0 when the tab opens so the playhead/ruler render (confirm the existing behavior first; only change if needed).

- [ ] **Step 2: Verify live** — scrubbing the new ruler moves the actual preview time (the canvas updates); play/Bake on the old timeline still work; both timelines coexist.

- [ ] **Step 3: Commit (PRIVATE INDEX).**

```bash
cd /Users/julien/Documents/GitHub/Sailor
GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD
git add -- frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(compositor): wire band-timeline scrub/pause (6d)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/components/vue-canvas/CompositorModal.vue
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

---

## Slice 6d done-when

- `npm run test:unit -- motionx` green (incl. new `timeline-view` tests).
- In the running app: the band timeline has a DialKit-style ruler (ticks + labels), a Sailor `#7c9cff` playhead you can drag to scrub, alt-drag pivot zoom (cursor time pinned), wheel/scrollbar pan when zoomed, DialKit row/clip dimensions and groups — all in Sailor colors + PP Neue Montreal. Bands still select/retime/edit as before; the old timeline still works below. No console errors.

## Self-review notes
- Spec coverage (6d section): ruler+ticks (T2), playhead drag-seek (T2), zoom (T3), pan (T4), DialKit dims + groups + selection ring in Sailor skin (T5), pure `timelineView.ts` TDD (T1), transport stays on old timeline / scrub wired (T6). Curve editor, add-property, retirement are 6c/6a/6b.
- Placeholder scan: none — Task 1 fully coded; component tasks carry concrete handlers + the verbatim math.
- Type consistency: `View`/`Derived`/`deriveView`/`zoomAboutPivot`/`computeTicks`/`clampViewStart` names identical across Task 1 and the component tasks.
</content>
