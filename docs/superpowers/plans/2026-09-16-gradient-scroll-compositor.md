# Gradient Scroll (Compositor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Frame layer's gradient fill — and the gradient-map effect — animate in **Scroll** mode: the gradient's colours cycle along it and loop seamlessly, authored on the compositor Motion tab as an ordinary scalar **phase** dial.

**Architecture:** Scroll rides the *existing* effect-dial keyframe machinery. For the **gradient-map effect** it is a new scalar `scrollPhase` field animated exactly like `contrast`/`mix`, with the pass transforming its stops by the phase before mapping. For the **layer fill** (a layer property, not an effect) it is a new layer-level target `layers.<id>.fill.phase` resolved by a small parallel fold that rewrites the fill's stops per frame. All colour maths comes from `gradientTween` (Plan 1). No new timeline-UI interaction is introduced — the phase dial is a normal diamond track.

**Tech Stack:** TypeScript (strict), Vitest unit tests, Vue 3 (compositor).

**Depends on:** Plan 1 (`app/lib/color/gradientTween.ts`) must be landed first — this plan imports `scrollLUT`/`blendHex` and adds `scrollStops` beside them.

## Global Constraints

- **Two `GradientStop` shapes exist — keep them straight.** The colour lib (`app/lib/color/harmony.ts`, used by `gradientTween`) uses `{ pos: number; color: string }`. The compositor fill (`app/lib/compositor/paint.ts`) uses `{ offset: number; color: string }`. The gradient-map effect (`app/lib/compositor/postEffects.ts`) uses `GradientMapStop { pos: number; color: string }`. Convert explicitly at the boundary; never assume field names.
- **Pure modules stay pure.** `gradientTween.ts` and `effectTracks.ts` import no Vue/DOM/canvas.
- **Colour space:** default `'oklab'` everywhere (see spec). Scroll wrap blends use `blendHex(..., 'oklab')`.
- **Byte-identity contract (compositor fold rule).** A fold returns the **same array reference** when nothing animates, so an un-animated frame is byte-identical (see `applyEffectDialTracks` doc, `effectTracks.ts:270-287`). The fill fold added here MUST preserve that: same reference when no `fill.phase` track resolves.
- **Tests:** `tests/unit/**/*.unit.spec.ts`, run `npm run test:unit` (from `frontend/`). Import via the `~` alias.
- **Committing (repo rule — shared git index is hostile):** never `git add -A`/bare `git commit`. Use `git add -- <newfiles>` then `git commit -m "<msg>" -- <path…>` (pathspec form; commits only those files). End messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **UI copy:** sentence case; selects over internal values carry `optionLabels`. (Only label strings here: "Fill · Scroll", "Gradient map · Scroll".)
- **Spec:** `docs/superpowers/specs/2026-09-16-gradient-transitions-design.md`. All paths relative to `frontend/`.

## File Structure

- **Modify** `app/lib/color/gradientTween.ts` — add `scrollStops` (stop-array form of `scrollLUT`).
- **Create** `app/lib/compositor/gradientPaint.ts` — the fill⇄colour-lib stop adapters and the pure fill-scroll resolver (keeps the `Paint`/`Gradient` knowledge out of `gradientTween`).
- **Create** `app/lib/motion/fillTracks.ts` — the pure parallel fold `applyFillPhaseTracks` for `layers.<id>.fill.phase` targets, plus `fillDialTargets`.
- **Modify** `app/lib/compositor/postEffects.ts` — add `GradientMapEffect.scrollPhase`, its default in `createEffect`, and the pass-time stop transform.
- **Modify** `app/lib/compositor/effectDials.ts` — add `scrollPhase` to `gradientMap`'s dials.
- **Modify** `app/composables/useCompositorLayers.ts` — run the fill fold in the painter pipeline beside `applyEffectDialTracks`.
- **Modify** `app/components/vue-canvas/CompositorModal.vue` — inject fill targets into the picker; add the fill "animated" signal.

---

### Task 1: `scrollStops` — stop-array form of the seamless cycle

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: existing `sortStops` (internal), `blendHex`, `GradientStop`.
- Produces: `scrollStops(stops: GradientStop[], phase: number, space?: BlendSpace, n?: number): GradientStop[]` — `n` (default 48) evenly-positioned stops (`pos = i/(n-1)`) whose colours are the wheel (stops spaced evenly by order, last→first wrap) sampled at `(pos + phase)`. `scrollStops(s, 0)` deep-equals `scrollStops(s, 1)` (seamless).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { scrollStops } from '~/lib/color/gradientTween'

describe('scrollStops', () => {
  const WHEEL3: GradientStop[] = [
    { pos: 0, color: '#1436ff' }, { pos: 0.5, color: '#ff2d2d' }, { pos: 1, color: '#ffd21f' },
  ]
  it('returns n evenly-positioned stops', () => {
    const out = scrollStops(WHEEL3, 0, 'oklab', 8)
    expect(out.length).toBe(8)
    expect(out.map(s => s.pos)).toEqual([0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1])
  })
  it('loops seamlessly (phase 0 == phase 1)', () => {
    expect(scrollStops(WHEEL3, 0)).toEqual(scrollStops(WHEEL3, 1))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `scrollStops is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
export function scrollStops(
  stops: GradientStop[],
  phase: number,
  space: BlendSpace = 'oklab',
  n = 48,
): GradientStop[] {
  const cols = sortStops(stops).map(s => s.color)
  const m = cols.length || 1
  const out: GradientStop[] = []
  for (let i = 0; i < n; i++) {
    const pos = n === 1 ? 0 : i / (n - 1)
    const w = (((pos + phase) % 1) + 1) % 1
    const seg = w * m
    const k = Math.floor(seg)
    const lt = seg - k
    out.push({ pos, color: blendHex(cols[k % m], cols[(k + 1) % m], lt, space) })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(color): scrollStops — stop-array seamless cycle for compositor scroll

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts
```

---

### Task 2: Fill ⇄ colour-lib stop adapters + pure fill-scroll resolver

**Files:**
- Create: `app/lib/compositor/gradientPaint.ts`
- Test: `tests/unit/compositor/gradientPaint.unit.spec.ts`

**Interfaces:**
- Consumes: `Gradient`, `isGradient` from `~/lib/compositor/paint`; `GradientStop as ColorStop` (`{pos,color}`) from `~/lib/color/harmony`; `scrollStops` from `~/lib/color/gradientTween`.
- Produces:
  - `paintStopsToColor(g: Gradient): ColorStop[]` — `{offset,color}` → `{pos,color}`.
  - `withScrolledStops(g: Gradient, phase: number): Gradient` — a NEW gradient of the same `type`/`angle` whose stops are `scrollStops(paintStopsToColor(g), phase)` mapped back to `{offset,color}`. (Note: at `phase = 0` the stops become the wheel-even re-spacing of the source — scroll re-spaces by design; the byte-identity guard in Task 3 keys off "no phase track", not "phase===0".)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compositor/gradientPaint.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { Gradient } from '~/lib/compositor/paint'
import { paintStopsToColor, withScrolledStops } from '~/lib/compositor/gradientPaint'

const G: Gradient = { type: 'linear', angle: 45, stops: [
  { offset: 0, color: '#1436ff' }, { offset: 0.5, color: '#ff2d2d' }, { offset: 1, color: '#ffd21f' },
] }

describe('paintStopsToColor', () => {
  it('maps offset→pos', () => {
    expect(paintStopsToColor(G)).toEqual([
      { pos: 0, color: '#1436ff' }, { pos: 0.5, color: '#ff2d2d' }, { pos: 1, color: '#ffd21f' },
    ])
  })
})

describe('withScrolledStops', () => {
  it('keeps type + angle and returns offset-shaped stops', () => {
    const out = withScrolledStops(G, 0.25)
    expect(out.type).toBe('linear')
    expect((out as any).angle).toBe(45)
    expect(out.stops[0]).toHaveProperty('offset')
    expect(out.stops[0]).not.toBe(G.stops[0]) // fresh objects, no mutation
  })
  it('is seamless in phase (0 == 1)', () => {
    expect(withScrolledStops(G, 0)).toEqual(withScrolledStops(G, 1))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientPaint`
Expected: FAIL — `Cannot find module '~/lib/compositor/gradientPaint'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/compositor/gradientPaint.ts
//
// Adapters between the compositor fill gradient ({offset,color}) and the colour-lib
// stop shape ({pos,color}) that gradientTween speaks, plus the pure fill-scroll
// resolver. Keeps Paint/Gradient knowledge OUT of gradientTween.
import type { Gradient } from './paint'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import { scrollStops } from '~/lib/color/gradientTween'

export function paintStopsToColor(g: Gradient): ColorStop[] {
  return g.stops.map(s => ({ pos: s.offset, color: s.color }))
}

/** A new gradient of the same type/angle, stops replaced by the scrolled wheel. */
export function withScrolledStops(g: Gradient, phase: number): Gradient {
  const scrolled = scrollStops(paintStopsToColor(g), phase).map(s => ({ offset: s.pos, color: s.color }))
  return g.type === 'radial'
    ? { type: 'radial', stops: scrolled }
    : { type: 'linear', angle: g.angle, stops: scrolled }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientPaint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/compositor/gradientPaint.ts tests/unit/compositor/gradientPaint.unit.spec.ts
git commit -m "feat(compositor): fill-gradient scroll adapters + resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/compositor/gradientPaint.ts tests/unit/compositor/gradientPaint.unit.spec.ts
```

---

### Task 3: `fillDialTargets` + `applyFillPhaseTracks` (the parallel fold)

**Files:**
- Create: `app/lib/motion/fillTracks.ts`
- Test: `tests/unit/motion/fillTracks.unit.spec.ts`

**Interfaces:**
- Consumes: `EffectDialTrack`, `evaluateDialTrack` from `~/lib/motion/effectTracks`; `DialTargetSpec` (same module); `isGradient` from `~/lib/compositor/paint`; `withScrolledStops` from `~/lib/compositor/gradientPaint`; `LocalLayer` (type-only) from `~/composables/useCompositorLayers`.
- Produces:
  - `fillDialTargets(layer: LocalLayer): DialTargetSpec[]` — one `{ path: 'layers.<id>.fill.phase', label: 'Fill · Scroll', kind: 'number', min: 0, max: 1, effectId: '', dialKey: 'phase' }` when `isGradient(layer.fill)`, else `[]`.
  - `applyFillPhaseTracks(layers: LocalLayer[], tracks: EffectDialTrack[] | undefined, t: number | undefined): LocalLayer[]` — for each `layers.<id>.fill.phase` track, evaluate the phase and rewrite the layer's gradient fill via `withScrolledStops`. **Same-reference** when nothing resolves (byte-identity).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motion/fillTracks.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { EffectDialTrack } from '~/lib/motion/effectTracks'
import { fillDialTargets, applyFillPhaseTracks } from '~/lib/motion/fillTracks'

const grad = () => ({ type: 'linear' as const, angle: 0, stops: [
  { offset: 0, color: '#1436ff' }, { offset: 0.5, color: '#ff2d2d' }, { offset: 1, color: '#ffd21f' },
] })
const layer = (over: Partial<LocalLayer> = {}) => ({ id: 'L1', fill: grad(), ...over } as unknown as LocalLayer)

describe('fillDialTargets', () => {
  it('emits a phase target only for a gradient fill', () => {
    expect(fillDialTargets(layer())).toEqual([
      { path: 'layers.L1.fill.phase', label: 'Fill · Scroll', kind: 'number', min: 0, max: 1, effectId: '', dialKey: 'phase' },
    ])
    expect(fillDialTargets(layer({ fill: '#ff0000' } as any))).toEqual([])
  })
})

describe('applyFillPhaseTracks', () => {
  const track = (kfs: { t: number; v: number }[]): EffectDialTrack => ({ target: 'layers.L1.fill.phase', keyframes: kfs })

  it('returns the SAME reference when there are no tracks', () => {
    const arr = [layer()]
    expect(applyFillPhaseTracks(arr, undefined, 0)).toBe(arr)
    expect(applyFillPhaseTracks(arr, [], 0)).toBe(arr)
  })
  it('rewrites the gradient fill at the evaluated phase', () => {
    const arr = [layer()]
    const out = applyFillPhaseTracks(arr, [track([{ t: 0, v: 0 }, { t: 1, v: 1 }])], 0.5)
    expect(out).not.toBe(arr)
    const fill = (out[0] as any).fill
    expect(fill.type).toBe('linear')
    expect(fill.stops.length).toBeGreaterThan(3) // resampled wheel
    expect(out[0]).not.toBe(arr[0]) // cloned
  })
  it('leaves non-targeted layers by identity', () => {
    const other = layer({ id: 'L2' })
    const arr = [layer(), other]
    const out = applyFillPhaseTracks(arr, [track([{ t: 0, v: 0.3 }])], 0)
    expect(out[1]).toBe(other)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- fillTracks`
Expected: FAIL — `Cannot find module '~/lib/motion/fillTracks'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motion/fillTracks.ts
//
// Layer-level FILL motion — the parallel fold for `layers.<id>.fill.phase` targets that
// `applyEffectDialTracks` deliberately rejects (it only accepts 5-segment `effects` paths).
// Pure: no Vue/DOM. Preserves the byte-identity seam (same array reference when idle).
import type { EffectDialTrack, DialTargetSpec } from '~/lib/motion/effectTracks'
import { evaluateDialTrack } from '~/lib/motion/effectTracks'
import { isGradient } from '~/lib/compositor/paint'
import { withScrolledStops } from '~/lib/compositor/gradientPaint'
import type { LocalLayer } from '~/composables/useCompositorLayers'

export function fillDialTargets(layer: LocalLayer): DialTargetSpec[] {
  const fill = (layer as unknown as { fill?: unknown }).fill
  if (!isGradient(fill)) return []
  return [{
    path: `layers.${layer.id}.fill.phase`,
    label: 'Fill · Scroll',
    kind: 'number',
    min: 0,
    max: 1,
    effectId: '',
    dialKey: 'phase',
  }]
}

export function applyFillPhaseTracks(
  layers: LocalLayer[],
  tracks: EffectDialTrack[] | undefined,
  t: number | undefined,
): LocalLayer[] {
  if (!tracks || tracks.length === 0 || t == null) return layers
  // layerId -> phase track. Only `layers.<id>.fill.phase` (4 segments) is ours.
  const byLayer = new Map<string, EffectDialTrack>()
  for (const track of tracks) {
    const segs = track?.target?.split('.') ?? []
    if (segs.length === 4 && segs[0] === 'layers' && segs[2] === 'fill' && segs[3] === 'phase') {
      byLayer.set(segs[1]!, track)
    }
  }
  if (byLayer.size === 0) return layers

  let cloned = false
  const next = layers.map((layer) => {
    const track = byLayer.get(layer.id)
    if (!track) return layer
    const fill = (layer as unknown as { fill?: unknown }).fill
    if (!isGradient(fill)) return layer
    const phase = evaluateDialTrack(track, t)
    if (typeof phase !== 'number') return layer
    cloned = true
    return { ...layer, fill: withScrolledStops(fill, phase) } as LocalLayer
  })
  return cloned ? next : layers
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- fillTracks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motion/fillTracks.ts tests/unit/motion/fillTracks.unit.spec.ts
git commit -m "feat(motion): fill phase targets + parallel scroll fold (layers.<id>.fill.phase)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motion/fillTracks.ts tests/unit/motion/fillTracks.unit.spec.ts
```

---

### Task 4: Run the fill fold in the painter pipeline

**Files:**
- Modify: `app/composables/useCompositorLayers.ts` (import near line 27; the fold call at line 5469)

**Interfaces:**
- Consumes: `applyFillPhaseTracks` from `~/lib/motion/fillTracks`.
- Produces: no new export — the render pipeline now applies fill-phase scroll after effect-dial tracks, using the same `motion.tracks` and `t`.

- [ ] **Step 1: Add the import**

At `app/composables/useCompositorLayers.ts:27` (beside the existing effectTracks import), add:

```ts
import { applyFillPhaseTracks } from '~/lib/motion/fillTracks'
```

- [ ] **Step 2: Compose the fold at the existing seam**

At `app/composables/useCompositorLayers.ts:5469`, change:

```ts
  const animatedLocals = applyEffectDialTracks(localLayers, motion?.tracks, t)
```

to:

```ts
  const animatedLocals = applyFillPhaseTracks(
    applyEffectDialTracks(localLayers, motion?.tracks, t),
    motion?.tracks,
    t,
  )
```

Both folds share the `motion.tracks` array; each ignores targets that aren't its shape, so ordering is safe and an idle frame stays byte-identical (both return their input by reference).

- [ ] **Step 3: Verify the unit suite still passes and typecheck is clean**

Run: `npm run test:unit`
Expected: PASS (no regressions).
Run: `npx vue-tsc --noEmit -p tsconfig.json 2>&1 | head -20` (or the repo's typecheck script if one exists)
Expected: no new errors referencing `useCompositorLayers.ts` / `fillTracks.ts`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(compositor): apply fill-phase scroll fold in the painter pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/composables/useCompositorLayers.ts
```

---

### Task 5: gradient-map `scrollPhase` field + pass transform

**Files:**
- Modify: `app/lib/compositor/postEffects.ts` (interface ~55; `createEffect` default ~258; `passGradientMap` ~587)
- Modify: `app/lib/compositor/effectDials.ts:85`
- Test: `tests/unit/compositor/gradientMapScroll.unit.spec.ts`

**Interfaces:**
- Consumes: `scrollStops` (`~/lib/color/gradientTween`), `gradientMapInPlace` (same file), `GradientMapStop`.
- Produces:
  - `GradientMapEffect.scrollPhase: number` (0..1, default 0 = no scroll).
  - `scrolledGradientMapStops(stops: GradientMapStop[], phase: number): GradientMapStop[]` — exported pure helper: `phase === 0` returns `stops` unchanged (identity — keeps a still bake byte-identical); else the scrolled wheel as `{pos,color}` stops.
  - `passGradientMap` applies it before `gradientMapInPlace`.
  - `effectDials` lists `scrollPhase` so it auto-appears in the picker and animates through the existing effect fold.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compositor/gradientMapScroll.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { scrolledGradientMapStops } from '~/lib/compositor/postEffects'

const STOPS = [
  { pos: 0, color: '#1436ff' }, { pos: 0.5, color: '#ff2d2d' }, { pos: 1, color: '#ffd21f' },
]

describe('scrolledGradientMapStops', () => {
  it('is identity at phase 0 (same reference)', () => {
    expect(scrolledGradientMapStops(STOPS, 0)).toBe(STOPS)
  })
  it('returns a scrolled wheel at phase > 0', () => {
    const out = scrolledGradientMapStops(STOPS, 0.25)
    expect(out).not.toBe(STOPS)
    expect(out[0]).toHaveProperty('pos')
    expect(out[0]).toHaveProperty('color')
    expect(out.length).toBeGreaterThan(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientMapScroll`
Expected: FAIL — `scrolledGradientMapStops is not a function`.

- [ ] **Step 3: Add the field, default, helper, and pass transform**

In `app/lib/compositor/postEffects.ts`, add to the interface (after `mix`, before `visible`, ~line 59):

```ts
  scrollPhase: number       // 0..1 — cycles the ramp along itself (0 = off); loops seamlessly
```

Add the import near the top of the file (with the other `~/lib/color` imports):

```ts
import { scrollStops } from '~/lib/color/gradientTween'
```

Add the exported helper (near `gradientMapInPlace`, ~line 455):

```ts
/** Scroll a gradient-map ramp along itself by `phase` (0..1). Identity at 0 (same
 *  reference — a still bake stays byte-identical). Reuses the colour-lib wheel cycle. */
export function scrolledGradientMapStops(stops: GradientMapStop[], phase: number): GradientMapStop[] {
  if (!phase) return stops
  return scrollStops(stops, phase).map(s => ({ pos: s.pos, color: s.color }))
}
```

Update the `createEffect` default for `gradientMap` (~line 258) to include `scrollPhase: 0` alongside `stops`/`contrast`/`mix`/`visible`. (Read the existing object at that line and add the one field.)

Update `passGradientMap` (~line 587) to transform the stops first:

```ts
function passGradientMap(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: GradientMapEffect, _opts: PassOpts): void {
  const img = ctx.getImageData(0, 0, off.width, off.height)
  gradientMapInPlace(img.data, scrolledGradientMapStops(e.stops, e.scrollPhase ?? 0), e.contrast, e.mix)
  // ...rest of the original body unchanged (the putImageData call etc.)
}
```

(Read `passGradientMap`'s current body first; keep every line except the `gradientMapInPlace(...)` call, which gains the `scrolledGradientMapStops(...)` wrapper and reads `e.scrollPhase`.)

In `app/lib/compositor/effectDials.ts:85`, change:

```ts
  gradientMap: [num('contrast', 'Contrast', -1, 1), num('mix', 'Mix', 0, 1)], // stops excluded (nested).
```

to:

```ts
  gradientMap: [num('contrast', 'Contrast', -1, 1), num('mix', 'Mix', 0, 1), num('scrollPhase', 'Scroll', 0, 1)], // stops (nested) still excluded; scroll rides a scalar phase.
```

- [ ] **Step 4: Run test to verify it passes; confirm the schema guard still holds**

Run: `npm run test:unit -- gradientMapScroll`
Expected: PASS.
Run: `npm run test:unit` (the F8 acceptance test asserts every `effectDials` key is a real field on the effect — `scrollPhase` now exists on `GradientMapEffect` and in `createEffect`, so it passes).
Expected: PASS. If the schema-guard test fails naming `scrollPhase`, the `createEffect` default was missed — add it.

- [ ] **Step 5: Commit**

```bash
git add -- tests/unit/compositor/gradientMapScroll.unit.spec.ts
git commit -m "feat(compositor): gradient-map scrollPhase — cycle the ramp via a scalar dial

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/compositor/postEffects.ts app/lib/compositor/effectDials.ts tests/unit/compositor/gradientMapScroll.unit.spec.ts
```

---

### Task 6: Inject fill targets into the Motion-tab picker + fill "animated" signal

**Files:**
- Modify: `app/components/vue-canvas/CompositorModal.vue` (import ~93; `animatableDials` ~3662; `toggleDialTrack` ~3673; a new `fillIsAnimated` computed near `animatedDialKeys` ~3707; template gate on the fill control in the inspector)

**Interfaces:**
- Consumes: `fillDialTargets` from `~/lib/motion/fillTracks`; existing `effectDialTargets`, `addDialTrack`, `removeDialTrack`, `getByIdPath`, `motionTracks`, `dialIsAnimated`, `setMotion`.
- Produces: the fill-scroll dial in the "Animate a dial" list; a `fillIsAnimated` boolean the inspector uses to lock the fill control and show the ◆ badge (mirrors how effect dials lock).

- [ ] **Step 1: Import the fill targets**

At `CompositorModal.vue:93` (the `effectTracks` import line), add a second import:

```ts
import { fillDialTargets } from '~/lib/motion/fillTracks'
```

- [ ] **Step 2: Concat fill targets into the picker list**

At `CompositorModal.vue:3662`, change `animatableDials` from:

```ts
const animatableDials = computed<DialTargetSpec[]>(() =>
  selectedLocal.value ? effectDialTargets(selectedLocal.value as any) : [],
)
```

to:

```ts
const animatableDials = computed<DialTargetSpec[]>(() => {
  const l = selectedLocal.value
  if (!l) return []
  return [...fillDialTargets(l as any), ...effectDialTargets(l as any)]
})
```

`toggleDialTrack` (`:3673`) already handles a `number`-kind target: `getByIdPath` returns `undefined` for `layers.<id>.fill.phase` (no such field), so the seed falls to `spec.min ?? 0` = `0`. No change needed there.

- [ ] **Step 3: Add the fill "animated" signal**

Near `animatedDialKeys` (`CompositorModal.vue:3707`), add:

```ts
const fillIsAnimated = computed<boolean>(() => {
  const l = selectedLocal.value
  if (!l) return false
  return dialIsAnimated(`layers.${(l as any).id}.fill.phase`)
})
```

(`dialIsAnimated(target)` already exists at `:3665` — `motionTracks.value.some(tr => tr.target === target)`.)

- [ ] **Step 4: Gate the fill control on it (inspector)**

In the fill inspector row that mounts `FillControl` (find `<FillControl` in `CompositorModal.vue`), mirror the effect-dial lock pattern used at `:8266-8272`: when `fillIsAnimated`, wrap/disable the control (`:class="{ 'opacity-50 pointer-events-none': fillIsAnimated }"`) and show the same "◆ Animated — edit on the Motion tab" hint used at `:8248-8252`. (Copy the existing badge markup; do not invent a new style.)

- [ ] **Step 5: Verify in the running app (no pure unit test for this wiring)**

This step is UI wiring; verify with the app, not a unit test. Use the project's run/preview workflow:
1. Start the compositor preview (`preview_start` with the frontend dev server per `.claude/launch.json`; do NOT run `npm run dev` directly — it kills `:3002`).
2. Add a rectangle to a Frame, give it a linear gradient fill (blue/red/yellow), open the layer's **Motion** tab.
3. Confirm **"Fill · Scroll"** and **"Gradient map · Scroll"** (if a gradient-map effect is present) appear in "Animate a dial".
4. Add the Fill · Scroll dial, put a keyframe at 0 (value 0) and at the end (value 1), loop it, and scrub — the gradient's colours cycle and the loop is seamless.
5. Confirm the fill control in the inspector shows the ◆ "Animated" lock while the phase dial exists.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(compositor): Fill · Scroll dial in the Motion picker + animated lock

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/components/vue-canvas/CompositorModal.vue
```

---

## Self-Review

**Spec coverage (Scroll slice):**
- Scroll mode for the layer fill — Tasks 1–4, 6. ✓
- Scroll mode for the gradient-map effect — Task 5. ✓
- Authored on the Motion tab as a scalar phase dial (no inspector-block motion) — Tasks 5 (effectDials), 6 (picker). ✓
- Seamless loop — Tasks 1, 2 tests. ✓
- Byte-identity when idle — Task 3 test (same reference); Task 5 identity at phase 0. ✓
- OKLab colour — inherited from `blendHex` default. ✓
- **Deferred to Plan 3:** Crossfade + Travel (gradient-valued keyframes; `DialKind 'gradient'`; per-keyframe gradient editor reusing `GradientEditor`; gradient interpolation branch in `evaluateDialTrack`).

**Placeholder scan:** none — pure tasks carry full code; the two wiring tasks (4, 6) give exact file:line edits and before/after snippets. Task 5's `createEffect` and `passGradientMap` edits say "read the current body first" because those exact bodies weren't quoted in the plan — the change to each is one line, specified.

**Type consistency:** `ColorStop {pos,color}` (colour lib) vs fill `{offset,color}` vs `GradientMapStop {pos,color}` are converted explicitly in Tasks 2 and 5; `DialTargetSpec`/`EffectDialTrack`/`evaluateDialTrack` signatures match `effectTracks.ts` exactly; `fillDialTargets` returns the same `DialTargetSpec` shape the picker consumes.

## Notes for Plan 3 (Crossfade + Travel — the bigger UI lift)

- `DialKind` gains `'gradient'`; `DialKeyframe.v` gains a gradient variant; `EffectDialTrack` gains `mode: 'crossfade'|'travel'`.
- `evaluateDialTrack` gains a branch: both bracket values gradients → `travelStops` / crossfade-sampled stops (add `crossfadeStops` to `gradientTween`).
- New per-keyframe **value editing**: the timeline has none today (`CompositorMotionTimeline.vue:260-267` diamonds carry only time; value comes from interpolation). Add keyframe selection + reuse `GradientEditor.vue` (v-model over `Gradient`) as the selected-keyframe editor.
- Gradient-swatch diamonds for gradient tracks (`CompositorMotionTimeline.vue:260-267` render seam).
- Gradient-map `stops` and fill `gradient` become gradient-valued targets (fill via the layer-target category this plan already built).
