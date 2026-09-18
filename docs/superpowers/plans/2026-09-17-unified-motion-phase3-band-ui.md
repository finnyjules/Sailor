# Unified Motion — Phase 3: the band timeline UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Frame's two motion-authoring surfaces (`CompositorMotionTimeline.vue` dial timeline + `MotionLayerEditor.vue` In/Loop/Out panel) with ONE "everything is a band" timeline driven by the landed `motionx` core.

**Architecture:** A pure, unit-tested band model (`app/lib/motionx/bands.ts`) derives display bands from the stored `Track[]` (and, from Slice 3 on, live `Behaviour[]`). A new `MotionBandTimeline.vue` renders bands (behaviour = labeled band; property = band whose interior shows the value: curve/colour/gradient, control points on the band). A contextual inspector (right) edits the selection. The render path is unchanged — `sailor_motion.motionx` (`Track[]`) is already folded by `applyMotionxTracks`; authoring only ever writes that field (plus a new author-only `behaviours` field) via `setMotion`.

**Tech Stack:** Nuxt 4 / Vue 3 `<script setup>` + TypeScript + Tailwind; Vitest (`npm run test:unit`); the pure `~/lib/motionx` core + `~/lib/motionx/adapter/frame` (`compileBehaviourForLayer`, `applyMotionxTracks`, `animatableProperties`); `GradientEditor.vue`.

## Global Constraints

- **App stays working at every step.** Build the band UI alongside the old surfaces; switch on only when complete; delete old models LAST (Slice 6 / Phase 4).
- **Never run `npm run dev`** — it kills the shared `:3002` server. Reuse the running `:3002`; verify in the browser pane. After any frontend restart, re-check `127.0.0.1:8188/system_stats` (ComfyUI) and relaunch if gone.
- **Shared-file commits via PRIVATE GIT INDEX only** (a parallel session keeps them `MM`/staged-deleted): `CompositorModal.vue`, `CompositorMotionTimeline.vue`, `useCompositorLayers.ts`, `motion/types.ts`, `effectTracks.ts`, `effectDials.ts`. Recipe: `GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD; git add -- <file>; git commit -m "…" -- <file>; rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE`. NEW files → ordinary pathspec commit. Never `git add -A` / bare commit.
- **UI copy:** sentence case; no lowercase-start labels/blurbs; selects over internal values carry `optionLabels`. Motion authoring lives in the Motion tab/timeline, never inspector blocks.
- **Render is already wired.** `applyMotionxTracks(layers, motion.motionx, t)` folds in `useCompositorLayers.paintLayerStack`; the animated preview call passes `motionDoc.value`. Do **not** change the render call. Author = `setMotion({ motionx })` / `setMotion({ behaviours })`.
- **Track shape** (`~/lib/motionx`): `Track { path, type:'number'|'color'|'gradient', keyframes:{t,value,ease}[], loop?, mode?:'crossfade'|'travel', space?:'oklab'|'hybrid' }`. Paths on the doc are `layers.<id>.<prop>`. `PropertyValue = number | hexstring | GradientStop[]` where `GradientStop = {pos,color}` (colour-lib) — the compositor fill uses `{offset,color}`; convert only via `~/lib/compositor/gradientPaint`.
- **Attribution:** commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Slice roadmap (each slice ships working software; detail each just-in-time)

- **Slice 1 (this plan, full detail):** pure band model `bands.ts` + read-only `MotionBandTimeline.vue` rendering the layer's existing `motionx` property bands, mounted behind a Motion-tab preview toggle beside the old timeline. No authoring yet.
- **Slice 2:** band interactions — select a band, retime by dragging its ends, add/move/delete control points on the band; contextual inspector (property band → timing + easing; control point → typed value editor incl. `GradientEditor`) + minimal control-point popover. Writes `setMotion({ motionx })`.
- **Slice 3:** behaviours first-class — store live `Behaviour[]` (`sailor_motion.behaviours`), tag compiled tracks with `behaviourId`, recompile on param edit, behaviour bands + behaviour-inspector params, **Open = bake** (strip `behaviourId`, drop the behaviour).
- **Slice 4:** the previewing **gallery** (grouped In / Loop / Out / Gradient, filtered by what the layer supports) replacing the temp chips + `MotionLayerEditor`; each tile plays a live preview; clicks route to `addBehaviour`.
- **Slice 5:** port the ~40 kinetic presets (`app/data/kinetic-presets.ts`) into behaviour compilers in `motionx/behaviour.ts` with parity tests vs `app/lib/motion/evaluate.ts`; these become the gallery entries.
- **Slice 6 (Phase 4):** retire old models — `MotionLayerEditor`, `CompositorMotionTimeline`, the `applyEffectDialTracks`/`applyFillPhaseTracks` folds, duplicate keyframe types — once the band UI fully drives authoring.

Each of Slices 2–6 gets its own detailed plan file written when reached (UX resolves against the running app). This plan fully specifies **Slice 1**.

---

# Slice 1 — pure band model + read-only band timeline

## File structure (Slice 1)

- Create `app/lib/motionx/bands.ts` — pure. Derives display `Band[]` from `Track[]` for one layer; number-band curve sampler; colour/gradient band CSS; span helper. Zero Vue/compositor imports (uses only `~/lib/motionx` + a local gradient-stop type).
- Create `app/lib/motionx/__tests__/bands.spec.ts` — Vitest unit tests.
- Create `app/components/vue-canvas/compositor/MotionBandTimeline.vue` — read-only render of `bandsForLayer(...)` for the selected layer.
- Modify `app/components/vue-canvas/CompositorModal.vue` (SHARED → private index) — mount `MotionBandTimeline` behind a `bandUiPreview` ref toggle in the Motion tab, beside the existing `CompositorMotionTimeline`.

## Interfaces produced by Slice 1 (later slices consume these)

```ts
// app/lib/motionx/bands.ts
import type { Track, Keyframe, PropertyType, PropertyValue } from '~/lib/motionx'

export type BandKind = 'number' | 'color' | 'gradient'   // Slice 3 adds 'behaviour'

export interface Band {
  key: string            // stable: the track path
  kind: BandKind
  type: PropertyType     // same as kind for property bands
  label: string          // human dial/property name (sentence case)
  path: string           // full doc path: layers.<id>.<prop>
  start: number          // seconds (first keyframe t)
  end: number            // seconds (last keyframe t; == start for a single point)
  keyframes: Keyframe[]  // the track's keyframes (control points)
}

export function trackSpan(track: Track): { start: number; end: number }
export function bandsForLayer(layerId: string, tracks: Track[], labelFor?: (path: string) => string): Band[]
export function numberBandCurve(track: Track, samples?: number): Array<{ x: number; y: number }>
export function colorBandCss(track: Track): string
export function gradientBandCss(track: Track): string
```

---

### Task 1: `trackSpan` + `bandsForLayer` (band selection & span)

**Files:**
- Create: `frontend/app/lib/motionx/bands.ts`
- Test: `frontend/app/lib/motionx/__tests__/bands.spec.ts`

**Interfaces:**
- Consumes: `Track`, `Keyframe`, `PropertyType` from `~/lib/motionx`.
- Produces: `Band`, `BandKind`, `trackSpan`, `bandsForLayer` (signatures above).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/lib/motionx/__tests__/bands.spec.ts
import { describe, it, expect } from 'vitest'
import { trackSpan, bandsForLayer } from '~/lib/motionx/bands'
import type { Track } from '~/lib/motionx'

const num = (path: string, ks: Array<[number, number]>): Track => ({
  path, type: 'number', keyframes: ks.map(([t, value]) => ({ t, value, ease: 'linear' })),
})

describe('trackSpan', () => {
  it('returns min/max keyframe t', () => {
    expect(trackSpan(num('layers.a.opacity', [[0.5, 0], [2, 1], [1, 0.5]]))).toEqual({ start: 0.5, end: 2 })
  })
  it('start == end for a single keyframe', () => {
    expect(trackSpan(num('layers.a.opacity', [[1.2, 1]]))).toEqual({ start: 1.2, end: 1.2 })
  })
  it('empty track spans 0..0', () => {
    expect(trackSpan({ path: 'layers.a.x', type: 'number', keyframes: [] })).toEqual({ start: 0, end: 0 })
  })
})

describe('bandsForLayer', () => {
  const tracks: Track[] = [
    num('layers.a.opacity', [[0, 0], [1, 1]]),
    num('layers.b.x', [[0, 0], [2, 100]]),          // other layer — excluded
    { path: 'layers.a.fill', type: 'gradient', keyframes: [
      { t: 0, value: [{ pos: 0, color: '#000' }], ease: 'linear' },
      { t: 3, value: [{ pos: 0, color: '#fff' }], ease: 'linear' },
    ] },
  ]
  it('includes only this layer\'s tracks, as bands with span + type', () => {
    const bands = bandsForLayer('a', tracks)
    expect(bands.map((b) => b.path)).toEqual(['layers.a.opacity', 'layers.a.fill'])
    expect(bands[0]).toMatchObject({ kind: 'number', type: 'number', start: 0, end: 1, key: 'layers.a.opacity' })
    expect(bands[1]).toMatchObject({ kind: 'gradient', start: 0, end: 3 })
  })
  it('uses labelFor for the human label, falling back to the last path segment', () => {
    const bands = bandsForLayer('a', tracks, (p) => (p.endsWith('opacity') ? 'Opacity' : ''))
    expect(bands[0].label).toBe('Opacity')
    expect(bands[1].label).toBe('fill')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm run test:unit -- bands`
Expected: FAIL — cannot find module `~/lib/motionx/bands`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/motionx/bands.ts
// Pure band model for the Frame motion timeline ("everything is a band").
// Derives read-only display bands from stored motionx Track[]. Zero Vue /
// compositor coupling — mirrors the purity of the rest of ~/lib/motionx.
import type { Track, PropertyType, Keyframe } from '~/lib/motionx'

export type BandKind = 'number' | 'color' | 'gradient'

export interface Band {
  key: string
  kind: BandKind
  type: PropertyType
  label: string
  path: string
  start: number
  end: number
  keyframes: Keyframe[]
}

/** First/last keyframe time of a track (seconds). Empty → 0..0; one point → start==end. */
export function trackSpan(track: Track): { start: number; end: number } {
  const ts = track.keyframes.map((k) => k.t)
  if (ts.length === 0) return { start: 0, end: 0 }
  return { start: Math.min(...ts), end: Math.max(...ts) }
}

/** Property bands for one layer, in the track order given. `labelFor(path)` supplies
 *  the human name (from the adapter's animatableProperties); a falsy return falls back
 *  to the last path segment. */
export function bandsForLayer(
  layerId: string,
  tracks: Track[],
  labelFor?: (path: string) => string,
): Band[] {
  const prefix = `layers.${layerId}.`
  const out: Band[] = []
  for (const tk of tracks) {
    if (!tk.path.startsWith(prefix)) continue
    const { start, end } = trackSpan(tk)
    const label = (labelFor?.(tk.path) || '') || tk.path.split('.').pop() || tk.path
    out.push({
      key: tk.path,
      kind: tk.type as BandKind,
      type: tk.type,
      label,
      path: tk.path,
      start,
      end,
      keyframes: tk.keyframes,
    })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm run test:unit -- bands`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit (new files → pathspec)**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add -- frontend/app/lib/motionx/bands.ts frontend/app/lib/motionx/__tests__/bands.spec.ts
git commit -m "feat(motionx): band model — trackSpan + bandsForLayer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/lib/motionx/bands.ts frontend/app/lib/motionx/__tests__/bands.spec.ts
```

---

### Task 2: band interiors — `numberBandCurve`, `colorBandCss`, `gradientBandCss`

**Files:**
- Modify: `frontend/app/lib/motionx/bands.ts` (append the three functions)
- Test: `frontend/app/lib/motionx/__tests__/bands.spec.ts` (append)

**Interfaces:**
- Consumes: `evaluateTrack` from `~/lib/motionx`; `Track`; `GradientStop` shape `{pos,color}`.
- Produces: `numberBandCurve(track, samples?)`, `colorBandCss(track)`, `gradientBandCss(track)`.

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { numberBandCurve, colorBandCss, gradientBandCss } from '~/lib/motionx/bands'

describe('numberBandCurve', () => {
  const t = { path: 'layers.a.opacity', type: 'number' as const, keyframes: [
    { t: 0, value: 0, ease: 'linear' as const }, { t: 2, value: 10, ease: 'linear' as const },
  ] }
  it('samples x across 0..1 and y normalised 0..1 against value min/max', () => {
    const pts = numberBandCurve(t, 3)
    expect(pts).toHaveLength(3)
    expect(pts[0]).toEqual({ x: 0, y: 0 })       // min value → 0
    expect(pts[2]).toEqual({ x: 1, y: 1 })       // max value → 1
    expect(pts[1].x).toBeCloseTo(0.5, 5)
    expect(pts[1].y).toBeCloseTo(0.5, 5)
  })
  it('flat track → y all 0.5 (no divide-by-zero)', () => {
    const flat = { path: 'layers.a.x', type: 'number' as const, keyframes: [
      { t: 0, value: 5, ease: 'linear' as const }, { t: 1, value: 5, ease: 'linear' as const } ] }
    expect(numberBandCurve(flat, 2).every((p) => p.y === 0.5)).toBe(true)
  })
})

describe('colorBandCss', () => {
  it('is a linear-gradient across the keyframe colours by fractional t', () => {
    const css = colorBandCss({ path: 'layers.a.fill', type: 'color', keyframes: [
      { t: 0, value: '#ff0000', ease: 'linear' }, { t: 4, value: '#0000ff', ease: 'linear' } ] })
    expect(css).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)')
  })
})

describe('gradientBandCss', () => {
  it('renders the first gradient keyframe stops as a 90deg gradient', () => {
    const css = gradientBandCss({ path: 'layers.a.fill', type: 'gradient', keyframes: [
      { t: 0, value: [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }], ease: 'linear' } ] })
    expect(css).toBe('linear-gradient(90deg, #000 0%, #fff 100%)')
  })
  it('empty → transparent', () => {
    expect(gradientBandCss({ path: 'layers.a.fill', type: 'gradient', keyframes: [] })).toBe('transparent')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm run test:unit -- bands`
Expected: FAIL — `numberBandCurve` etc. not exported.

- [ ] **Step 3: Write minimal implementation (append to bands.ts)**

```ts
import { evaluateTrack } from '~/lib/motionx'

interface GradStop { pos: number; color: string }

/** Sample a number track's value across its span → points in the unit square.
 *  x = fraction across span; y = value normalised to the track's [min,max]
 *  (flat track → 0.5). SVG y-flip is the component's job, not this. */
export function numberBandCurve(track: Track, samples = 24): Array<{ x: number; y: number }> {
  const n = Math.max(2, samples)
  const { start, end } = trackSpan(track)
  const span = end - start
  const vals: number[] = []
  for (let i = 0; i < n; i++) {
    const t = start + (span * i) / (n - 1)
    const v = evaluateTrack(track, t)
    vals.push(typeof v === 'number' ? v : 0)
  }
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const range = hi - lo
  return vals.map((v, i) => ({
    x: i / (n - 1),
    y: range < 1e-9 ? 0.5 : (v - lo) / range,
  }))
}

/** A colour track's keyframe colours laid out left→right by fractional t. */
export function colorBandCss(track: Track): string {
  const ks = track.keyframes
  if (ks.length === 0) return 'transparent'
  const { start, end } = trackSpan(track)
  const span = end - start
  const stops = ks.map((k) => {
    const f = span < 1e-9 ? 0 : (k.t - start) / span
    return `${String(k.value)} ${(f * 100).toFixed(1)}%`
  })
  if (ks.length === 1) return `linear-gradient(90deg, ${String(ks[0]!.value)} 0%, ${String(ks[0]!.value)} 100%)`
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** Representative fill for a gradient band: the first keyframe's stops as a 90deg gradient. */
export function gradientBandCss(track: Track): string {
  const first = track.keyframes[0]
  if (!first || !Array.isArray(first.value) || first.value.length === 0) return 'transparent'
  const stops = (first.value as GradStop[]).map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm run test:unit -- bands`
Expected: PASS (all bands tests).

- [ ] **Step 5: Commit (pathspec)**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add -- frontend/app/lib/motionx/bands.ts frontend/app/lib/motionx/__tests__/bands.spec.ts
git commit -m "feat(motionx): band interiors — number curve + colour/gradient css

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/lib/motionx/bands.ts frontend/app/lib/motionx/__tests__/bands.spec.ts
```

---

### Task 3: `MotionBandTimeline.vue` — read-only band render

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue`

**Interfaces:**
- Consumes: `bandsForLayer`, `numberBandCurve`, `colorBandCss`, `gradientBandCss` (Tasks 1–2); `animatableProperties(layer)` from `~/lib/motionx/adapter/frame` for labels; `LocalLayer`; the `Track[]` on the doc.
- Produces: a component with props `{ layers: LocalLayer[]; selectedId: string | null; motionx: Track[]; duration: number; t: number | null }` and emits `{ select: [id] }`. Read-only — no motion writes yet.

- [ ] **Step 1: Write the component**

```vue
<script setup lang="ts">
/** Read-only "everything is a band" motion timeline (Slice 1). Renders the selected
 *  layer's motionx property bands: number → value curve, colour → transition, gradient
 *  → representative fill; control points sit on the band. Authoring (retime, points,
 *  behaviours, gallery) lands in later slices. */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Track } from '~/lib/motionx'
import { bandsForLayer, numberBandCurve, colorBandCss, gradientBandCss } from '~/lib/motionx/bands'
import { animatableProperties } from '~/lib/motionx/adapter/frame'

const props = defineProps<{
  layers: LocalLayer[]
  selectedId: string | null
  motionx: Track[]
  duration: number
  t: number | null
}>()
defineEmits<{ select: [id: string] }>()

const pct = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(3)}%`
const rowLabel = (l: LocalLayer) =>
  (l as { name?: string }).name || (l.kind === 'text' ? ((l as { text?: string }).text?.split('\n')[0] || 'Text') : l.kind)

const selectedLayer = computed(() => props.layers.find((l) => l.id === props.selectedId) ?? null)
const labelMap = computed(() => {
  const m = new Map<string, string>()
  const l = selectedLayer.value
  if (l) for (const p of animatableProperties(l)) m.set(p.path, p.label)
  return m
})
const bands = computed(() =>
  selectedLayer.value
    ? bandsForLayer(selectedLayer.value.id, props.motionx, (p) => labelMap.value.get(p) ?? '')
    : [])

// left/width as fractions of the whole duration
const bandLeft = (b: { start: number }) => props.duration > 0 ? b.start / props.duration : 0
const bandWidth = (b: { start: number; end: number }) =>
  props.duration > 0 ? Math.max(0.01, (b.end - b.start) / props.duration) : 0.01
// control-point x within the band (0..1 across the band span)
const pointX = (b: { start: number; end: number }, t: number) => {
  const span = b.end - b.start
  return span < 1e-9 ? 0 : (t - b.start) / span
}
function curvePoints(b: { path: string }): string {
  const tk = props.motionx.find((t) => t.path === b.path)
  if (!tk) return ''
  return numberBandCurve(tk).map((p) => `${(p.x * 100).toFixed(2)},${((1 - p.y) * 100).toFixed(2)}`).join(' ')
}
function bandCss(b: { path: string; kind: string }): string {
  const tk = props.motionx.find((t) => t.path === b.path)
  if (!tk) return 'transparent'
  return b.kind === 'color' ? colorBandCss(tk) : b.kind === 'gradient' ? gradientBandCss(tk) : 'transparent'
}
</script>

<template>
  <div class="rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-2.5 text-xs text-white/70" data-testid="band-timeline">
    <div class="mb-2 flex items-center gap-2 text-[11px]">
      <span class="tabular-nums text-white/60">{{ (t ?? 0).toFixed(2) }} / {{ duration.toFixed(1) }}s</span>
      <span class="text-white/30">Band preview</span>
    </div>
    <div class="grid grid-cols-[110px_1fr] gap-x-2">
      <template v-for="l in layers" :key="l.id">
        <button class="truncate text-left text-[11px] cursor-pointer"
          :class="l.id === selectedId ? 'text-white' : 'text-white/50 hover:text-white/75'"
          @click="$emit('select', l.id)">{{ rowLabel(l) }}</button>
        <div class="relative my-0.5 h-5 rounded border border-white/10 bg-white/[0.03]" />
      </template>
      <template v-for="b in bands" :key="b.key">
        <span class="truncate text-left text-[10px] text-white/40 pl-3 self-center" :title="b.label">{{ b.label }}</span>
        <div class="relative my-0.5 h-7">
          <div class="absolute inset-y-0 rounded-md border border-white/15 overflow-hidden"
            :style="{ left: pct(bandLeft(b)), width: pct(bandWidth(b)), background: b.kind === 'number' ? 'linear-gradient(180deg,#171a20,#12141a)' : bandCss(b) }">
            <svg v-if="b.kind === 'number'" viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full block">
              <polyline :points="curvePoints(b)" fill="none" stroke="#7c9cff" stroke-width="2" vector-effect="non-scaling-stroke" />
            </svg>
            <div v-for="(kf, i) in b.keyframes" :key="i"
              class="absolute top-1/2 w-2 h-2 -ml-1 -mt-1 rounded-full bg-white border border-[#7c9cff]"
              :style="{ left: pct(pointX(b, kf.t)) }" />
          </div>
        </div>
      </template>
      <template v-if="selectedLayer && bands.length === 0">
        <div /><div class="py-2 text-[11px] text-white/30">No motion on this layer yet.</div>
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck the new component**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep MotionBandTimeline || echo "clean"`
Expected: `clean` (no errors mentioning the new file). (A pre-existing baseline of unrelated errors may exist; only the new file must be clean.)

- [ ] **Step 3: Commit (new file → pathspec)**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add -- frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue
git commit -m "feat(compositor): read-only MotionBandTimeline (band render)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue
```

---

### Task 4: mount the band timeline behind a Motion-tab preview toggle (SHARED file)

**Files:**
- Modify (SHARED → PRIVATE INDEX): `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: `MotionBandTimeline` (Task 3); existing `localLayers`, `selectedLocal`, `motionxTracks` (computed at ~3735), `effectiveMotion`, `previewT`.
- Produces: a `bandUiPreview` ref (default `true` for verification) toggling the new timeline beside the old one.

- [ ] **Step 1: Register the import** — after the `CompositorMotionTimeline` import (~line 116):

```ts
import MotionBandTimeline from '~/components/vue-canvas/compositor/MotionBandTimeline.vue'
```

- [ ] **Step 2: Add the toggle ref** — near `behaviourPickerOpen` (~3736):

```ts
// Slice 1: preview the new band timeline alongside the old dial timeline.
const bandUiPreview = ref(true)
```

- [ ] **Step 3: Mount it** — inside the Motion tab block, immediately BEFORE `<CompositorMotionTimeline` (~7912):

```vue
        <div v-if="selectedLocal" class="mb-2 flex items-center gap-2 text-[11px] text-white/50">
          <button type="button" class="cursor-pointer hover:text-white/80"
            @click="bandUiPreview = !bandUiPreview">{{ bandUiPreview ? 'Hide' : 'Show' }} band preview</button>
        </div>
        <MotionBandTimeline v-if="bandUiPreview"
          class="mb-2"
          :layers="localLayers" :selected-id="selectedLocal?.id ?? null"
          :motionx="motionxTracks" :duration="effectiveMotion.duration" :t="previewT"
          @select="(id: string) => selectLocal(id)" />
```

- [ ] **Step 4: Verify the app compiles (reuse :3002 — do NOT start a server)**

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep 3002    # confirm :3002 is up (this checkout)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3002/   # expect 200
```

Then in the browser pane: open the app → a Frame with a gradient-filled rectangle → select it → **Motion** tab → **+ Add behaviour** → **Scroll**. Confirm a **Fill · Scroll** (number) or **Fill · Gradient** band appears in the "Band preview" with control points, and **Fade in** produces an **Opacity** curve band. Check `read_console_messages` shows no errors from `MotionBandTimeline`.

- [ ] **Step 5: Commit (SHARED → PRIVATE INDEX)**

```bash
cd /Users/julien/Documents/GitHub/Sailor
GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE
git read-tree HEAD
git add -- frontend/app/components/vue-canvas/CompositorModal.vue
git commit -m "feat(compositor): mount read-only band timeline behind Motion-tab preview toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- frontend/app/components/vue-canvas/CompositorModal.vue
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

---

## Slice 1 done-when

- `npm run test:unit -- bands` green; whole `motionx` suite still green (`npm run test:unit -- motionx`).
- In the running app, adding a behaviour shows its property band(s) with the correct interior (curve / colour / gradient) and control points, read-only, beside the still-working old timeline. No console errors. App otherwise unchanged.

## Self-review notes

- Spec coverage (Slice 1 subset of §5): "everything is a band" primitive with value-showing interiors (curve/colour/gradient) + control points on the band — Tasks 1–3. Read-only foundation, old UI intact — Task 4 (Global Constraint: app stays working). Retime/edit/inspector/popover/gallery/preset-port are Slices 2–5 (roadmap above), each its own plan.
- Placeholder scan: none — every code step is concrete.
- Type consistency: `Band`/`trackSpan`/`bandsForLayer`/`numberBandCurve`/`colorBandCss`/`gradientBandCss` names identical across Tasks 1–3 and the component; `GradientStop = {pos,color}` used consistently.
</content>
</invoke>
