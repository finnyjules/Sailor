# Gradient Crossfade + Travel (Compositor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Crossfade** and **Travel** gradient transitions to the Frame layer fill and the gradient-map effect: a gradient dial animates between two (or more) gradient **keyframes** on the compositor Motion timeline, interpolated per the track's mode.

**Architecture:** Extend the existing effect-dial keyframe system (`effectTracks.ts`) to carry **gradient-valued keyframes** (`v` may be a `{pos,color}[]` stop array) and a track-level `mode` (crossfade | travel) + `blendSpace` (oklab | hybrid). `evaluateDialTrack` interpolates two gradient keyframes via `gradientTween` (Plan 1). The gradient-map path rides the existing generic effect fold (which already assigns a resolved dial value onto the effect field); the fill path extends the Plan-2 fill fold to also handle a `layers.<id>.fill` gradient target. The timeline gains gradient-swatch keyframes and a per-keyframe gradient editor (reusing `GradientEditor.vue`), since keyframe values are not editable in the timeline today.

**Tech Stack:** TypeScript (strict), Vitest, Vue 3 (compositor).

**Depends on:** Plan 1 (`gradientTween.ts`) and Plan 2 (`gradientPaint.ts`, `fillTracks.ts`, the fill-fold painter wiring, the Motion picker injection) — both landed on `main`.

## Global Constraints

- **Three `GradientStop` shapes** — colour lib `{pos,color}` (harmony.ts / gradientTween), compositor fill `{offset,color}` (paint.ts), gradient-map `GradientMapStop {pos,color}` (postEffects.ts). Gradient **keyframe values are stored as the colour-lib `{pos,color}[]` shape** (the common denominator); convert at the fill boundary via Plan 2's `gradientPaint.ts` helpers.
- **Colour interpolation:** OKLab default, Hybrid optional — via `gradientTween`'s `crossfadeStops` / `travelStops` (`blendHex` under the hood). OKLCH is not offered.
- **Byte-identity contract:** an idle frame (no clock, no gradient track) must return the same layer array reference. A single-keyframe gradient hold may re-clone per frame (array identity differs) — acceptable; a *no-track* frame must not.
- **Pure modules stay pure:** `effectTracks.ts`, `fillTracks.ts`, `gradientTween.ts`, `gradientPaint.ts` — no Vue/DOM/canvas.
- **Shared-file commits:** `effectTracks.ts`, `effectDials.ts`, `postEffects.ts`, `CompositorModal.vue`, `CompositorMotionTimeline.vue`, `useCompositorLayers.ts` are edited by parallel sessions. Before committing any of them, check `git status --porcelain <file>`; if it is `M`/`MM`/`D`/`??` from another session, commit **only your hunks via a private git index** (`GIT_INDEX_FILE=$(mktemp); git read-tree HEAD; git add -- <file>; git commit -m "…"`), never `git add -A`/bare commit. New files (`*.unit.spec.ts` you create) commit via pathspec. End messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Tests:** `tests/unit/**/*.unit.spec.ts`, `npm run test:unit` (from `frontend/`), `~` alias. UI tasks are verified in the running app on the existing `:3002` dev server (never `npm run dev` — it kills `:3002`; reuse the running server).
- **Spec:** `docs/superpowers/specs/2026-09-16-gradient-transitions-design.md`. Paths relative to `frontend/`.

## File Structure

- **Modify** `app/lib/color/gradientTween.ts` — add `crossfadeStops` (crossfade sampled to `{pos,color}[]`).
- **Modify** `app/lib/motion/effectTracks.ts` — widen `DialKeyframe.v` to include `ColorStop[]`; add `mode`/`blendSpace` to `EffectDialTrack`; gradient branch in `evaluateDialTrack`; a `resolveGradientKeyframe` helper + an `isGradientValue` guard.
- **Modify** `app/lib/motion/fillTracks.ts` — extend `fillDialTargets` with the `layers.<id>.fill` gradient target; extend `applyFillPhaseTracks` (rename to `applyFillTracks`) to also fold gradient keyframes onto `layer.fill`.
- **Modify** `app/lib/compositor/effectDials.ts` — add `'gradient'` to `DialKind`; add `gradientMap` `stops` gradient dial.
- **Modify** `app/composables/useCompositorLayers.ts` — call the renamed `applyFillTracks`.
- **Modify** `app/components/vue-canvas/CompositorModal.vue` — seed gradient tracks (current gradient + default mode/space) in `toggleDialTrack`; a Mode/Colour control for a selected gradient lane.
- **Modify** `app/components/vue-canvas/compositor/CompositorMotionTimeline.vue` — gradient-swatch keyframes; keyframe selection; mount `GradientEditor` for the selected keyframe.

---

### Task 1: `crossfadeStops` — crossfade sampled to a stop array

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `sampleRamp`, `blendHex`, `GradientStop`.
- Produces: `crossfadeStops(from, to, t, space?, n?): GradientStop[]` — `n` (default 48) evenly-positioned stops (`pos=i/(n-1)`), each `blendHex(sampleRamp(from,u), sampleRamp(to,u), t)`. At `t=0` equals `resampleStops(from,n)` colours; the point is a stop-array form of `crossfadeLUT` for surfaces that consume stops.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { crossfadeStops } from '~/lib/color/gradientTween'

describe('crossfadeStops', () => {
  const A: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
  const B: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 0.5, color: '#00ff00' }, { pos: 1, color: '#ffffff' }]
  it('returns n evenly-positioned stops', () => {
    const out = crossfadeStops(A, B, 0.5, 'oklab', 8)
    expect(out.length).toBe(8)
    expect(out.map(s => s.pos)).toEqual([0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1])
  })
  it('at t=0 matches sampling FROM, at t=1 matches sampling TO', () => {
    const at0 = crossfadeStops(A, B, 0, 'oklab', 5)
    const at1 = crossfadeStops(A, B, 1, 'oklab', 5)
    expect(at0.map(s => s.color)).toEqual([0, 0.25, 0.5, 0.75, 1].map(u => sampleRamp(A, u, 'oklab')))
    expect(at1.map(s => s.color)).toEqual([0, 0.25, 0.5, 0.75, 1].map(u => sampleRamp(B, u, 'oklab')))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `crossfadeStops is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
export function crossfadeStops(
  from: GradientStop[],
  to: GradientStop[],
  t: number,
  space: BlendSpace = 'oklab',
  n = 48,
): GradientStop[] {
  const out: GradientStop[] = []
  for (let i = 0; i < n; i++) {
    const pos = n === 1 ? 0 : i / (n - 1)
    out.push({ pos, color: blendHex(sampleRamp(from, pos, space), sampleRamp(to, pos, space), t, space) })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(color): crossfadeStops — crossfade sampled to a stop array

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts
```

---

### Task 2: Gradient-valued keyframes in `evaluateDialTrack`

**Files:**
- Modify: `app/lib/motion/effectTracks.ts`
- Test: `tests/unit/motion/effectTracksGradient.unit.spec.ts` (new)

**Interfaces:**
- Consumes: `crossfadeStops`, `travelStops` from `~/lib/color/gradientTween`; `GradientStop as ColorStop` from `~/lib/color/harmony`.
- Produces:
  - `DialKeyframe.v` widened to `number | string | ColorStop[]`.
  - `EffectDialTrack` gains `mode?: 'crossfade' | 'travel'` and `blendSpace?: 'oklab' | 'hybrid'`.
  - `isGradientValue(v): v is ColorStop[]` — array of `{pos:number,color:string}`.
  - `evaluateDialTrack` returns `ColorStop[]` for a gradient track: both bracket values gradients → `travelStops`/`crossfadeStops` (per `track.mode ?? 'crossfade'`, `track.blendSpace ?? 'oklab'`) at eased `p`; clamps to the endpoint gradient outside the bracket. Numbers/strings behave exactly as before.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motion/effectTracksGradient.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { EffectDialTrack } from '~/lib/motion/effectTracks'
import { evaluateDialTrack, isGradientValue } from '~/lib/motion/effectTracks'

const A = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const B = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]

describe('isGradientValue', () => {
  it('recognises a stop array', () => {
    expect(isGradientValue(A)).toBe(true)
    expect(isGradientValue(3)).toBe(false)
    expect(isGradientValue('#fff')).toBe(false)
    expect(isGradientValue([{ pos: 0 }])).toBe(false)
  })
})

describe('evaluateDialTrack gradient values', () => {
  const track = (mode: 'crossfade' | 'travel'): EffectDialTrack => ({
    target: 'layers.L1.effects.fx.stops', mode, blendSpace: 'oklab',
    keyframes: [{ t: 0, v: A }, { t: 1, v: B }],
  })
  it('clamps to endpoints', () => {
    expect(evaluateDialTrack(track('crossfade'), 0)).toEqual(A)
    expect(evaluateDialTrack(track('crossfade'), 1)).toEqual(B)
  })
  it('crossfade returns a resolved stop array between the two at mid', () => {
    const mid = evaluateDialTrack(track('crossfade'), 0.5) as any[]
    expect(Array.isArray(mid)).toBe(true)
    expect(mid.length).toBeGreaterThan(2) // sampled crossfade (n stops)
    expect(isGradientValue(mid)).toBe(true)
  })
  it('travel returns paired stops at mid', () => {
    const mid = evaluateDialTrack(track('travel'), 0.5) as any[]
    expect(isGradientValue(mid)).toBe(true)
  })
  it('still lerps numbers', () => {
    const n: EffectDialTrack = { target: 't', keyframes: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }
    expect(evaluateDialTrack(n, 0.5)).toBeCloseTo(5, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- effectTracksGradient`
Expected: FAIL — `isGradientValue is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `app/lib/motion/effectTracks.ts`:

1. Add imports at the top (with the existing `mixHex` import):
```ts
import { crossfadeStops, travelStops } from '~/lib/color/gradientTween'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
```
2. Widen `DialKeyframe.v`:
```ts
export interface DialKeyframe {
  t: number
  v: number | string | ColorStop[]
  ease?: 'linear' | 'easeInOut'
}
```
3. Add to `EffectDialTrack` (after `space?`):
```ts
  /** For a GRADIENT dial: how two gradient keyframes interpolate. */
  mode?: 'crossfade' | 'travel'
  /** For a GRADIENT dial: colour-blend space (default oklab). */
  blendSpace?: 'oklab' | 'hybrid'
```
4. Add the guard and use it in `evaluateDialTrack`:
```ts
export function isGradientValue(v: unknown): v is ColorStop[] {
  return Array.isArray(v) && v.length > 0 &&
    v.every((s) => s && typeof (s as any).pos === 'number' && typeof (s as any).color === 'string')
}
```
5. In `evaluateDialTrack`, keep the existing clamps (they already return `first.v`/`last.v`, which correctly return a gradient endpoint too). In the bracket-interpolation section, BEFORE the `typeof lo.v === 'number'` branch, add:
```ts
  if (isGradientValue(lo.v) && isGradientValue(hi.v)) {
    const space = track.blendSpace ?? 'oklab'
    return (track.mode ?? 'crossfade') === 'travel'
      ? travelStops(lo.v, hi.v, p, space)
      : crossfadeStops(lo.v, hi.v, p, space)
  }
```
6. Update `evaluateDialTrack`'s return type to `number | string | ColorStop[] | undefined`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- effectTracksGradient` then `npm run test:unit -- effectTracks` (existing effect-track tests must still pass).
Expected: PASS both.

- [ ] **Step 5: Commit**

Check `git status --porcelain app/lib/motion/effectTracks.ts`; commit via private index if it shows a foreign state, else pathspec:
```bash
git commit -m "feat(motion): gradient-valued keyframes — evaluateDialTrack interpolates stop arrays

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motion/effectTracks.ts tests/unit/motion/effectTracksGradient.unit.spec.ts
```

---

### Task 3: Fill gradient target + fold (`applyFillTracks`)

**Files:**
- Modify: `app/lib/motion/fillTracks.ts`
- Modify: `app/composables/useCompositorLayers.ts` (rename the call)
- Test: `tests/unit/motion/fillTracks.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `evaluateDialTrack`, `isGradientValue` from `~/lib/motion/effectTracks`; `isGradient` from `~/lib/compositor/paint`; `withScrolledStops` + `paintStopsToColor` from `~/lib/compositor/gradientPaint`; `GradientStop as ColorStop` from `~/lib/color/harmony`.
- Produces:
  - `fillDialTargets(layer)` now returns TWO targets for a gradient fill: the existing `fill.phase` (Scroll) AND `fill` (kind `'gradient'`, label `'Fill · Gradient'`, path `layers.<id>.fill`, `dialKey: 'fill'`).
  - New helper in `gradientPaint.ts` used here: `withGradientStops(g, stops: ColorStop[]): Gradient` — same type/angle, `stops` = `stops` mapped to `{offset,color}`. (Add it in Task 3, tested here.)
  - `applyFillTracks(layers, tracks, t)` — supersedes `applyFillPhaseTracks`: folds BOTH `fill.phase` (scalar → `withScrolledStops`) and `fill` (gradient → `withGradientStops(base, evaluated stops)`). Same byte-identity contract. Keep `applyFillPhaseTracks` as a thin alias re-export for one release (or update the single caller — see below).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/motion/fillTracks.unit.spec.ts
import { applyFillTracks } from '~/lib/motion/fillTracks'

describe('applyFillTracks — gradient keyframes', () => {
  const gradFill = () => ({ type: 'linear' as const, angle: 30, stops: [
    { offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' },
  ] })
  const layer = () => ({ id: 'L1', fill: gradFill() } as any)
  const A = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
  const B = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]

  it('folds a gradient fill track onto layer.fill, keeping type + angle', () => {
    const track = { target: 'layers.L1.fill', mode: 'crossfade' as const, keyframes: [{ t: 0, v: A }, { t: 1, v: B }] }
    const out = applyFillTracks([layer()], [track], 0.5)
    const fill = (out[0] as any).fill
    expect(fill.type).toBe('linear')
    expect(fill.angle).toBe(30)
    expect(fill.stops[0]).toHaveProperty('offset')
    expect(fill.stops.length).toBeGreaterThan(2) // resolved crossfade stops
  })
  it('returns same reference when idle', () => {
    const arr = [layer()]
    expect(applyFillTracks(arr, undefined, 0)).toBe(arr)
  })
})

describe('fillDialTargets includes the gradient target', () => {
  it('emits fill.phase AND fill for a gradient fill', () => {
    const paths = fillDialTargets({ id: 'L1', fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } } as any).map(s => s.path)
    expect(paths).toContain('layers.L1.fill.phase')
    expect(paths).toContain('layers.L1.fill')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- fillTracks`
Expected: FAIL — `applyFillTracks is not a function`.

- [ ] **Step 3: Write minimal implementation**

1. In `app/lib/compositor/gradientPaint.ts`, add:
```ts
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
/** A new gradient of the same type/angle, stops replaced by `stops` ({pos,color} → {offset,color}). */
export function withGradientStops(g: Gradient, stops: ColorStop[]): Gradient {
  const mapped = stops.map(s => ({ offset: s.pos, color: s.color }))
  return g.type === 'radial' ? { type: 'radial', stops: mapped } : { type: 'linear', angle: g.angle, stops: mapped }
}
```
(Add a unit test for it in `tests/unit/compositor/gradientPaint.unit.spec.ts` mirroring `withScrolledStops`'s tests: keeps type/angle, radial omits angle, fresh objects.)

2. In `app/lib/motion/fillTracks.ts`:
   - Extend `fillDialTargets` to push the gradient target when `isGradient(layer.fill)`:
```ts
  out.push({ path: `layers.${layer.id}.fill`, label: 'Fill · Gradient', kind: 'gradient', effectId: '', dialKey: 'fill' })
```
   (Add `'gradient'` to the `DialKind` union in Task 4; until then `kind: 'gradient' as any` — but Task 4 lands the union, so order Task 4 BEFORE this if the typecheck blocks. See Task ordering note below.)
   - Rename `applyFillPhaseTracks` → `applyFillTracks`; inside, handle BOTH shapes. Parse each track's target:
     - 4-seg `layers.<id>.fill.phase` → scalar phase → `withScrolledStops(fill, evaluate)`.
     - 3-seg `layers.<id>.fill` → `const v = evaluateDialTrack(track, t); if (isGradientValue(v)) fill = withGradientStops(fill, v)`.
   - Keep the same-reference byte-identity behaviour.
   - Re-export a compatibility alias: `export const applyFillPhaseTracks = applyFillTracks`.

3. In `app/composables/useCompositorLayers.ts`, change the import and call from `applyFillPhaseTracks` to `applyFillTracks` (the alias makes this optional, but prefer the real name).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- fillTracks gradientPaint`
Expected: PASS.

- [ ] **Step 5: Commit** (private index for `useCompositorLayers.ts` if it shows a foreign state; pathspec for the pure files/tests)

```bash
git commit -m "feat(motion): fill gradient target + applyFillTracks folds gradient keyframes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motion/fillTracks.ts app/lib/compositor/gradientPaint.ts tests/unit/motion/fillTracks.unit.spec.ts tests/unit/compositor/gradientPaint.unit.spec.ts
```
Then commit `useCompositorLayers.ts` separately (private index) if changed.

---

### Task 4: `gradient` DialKind + gradientMap `stops` target

**Files:**
- Modify: `app/lib/compositor/effectDials.ts`
- Test: `tests/unit/compositor/gradientMapGradientDial.unit.spec.ts` (new)

**Interfaces:**
- Produces: `DialKind` gains `'gradient'`; `EFFECT_DIAL_SCHEMA.gradientMap` gains a `stops` gradient dial (`{ key: 'stops', label: 'Ramp', kind: 'gradient' }`).

**Task ordering note:** Land Task 4 BEFORE Task 3's `fillDialTargets` edit and Task 5, since both reference `kind: 'gradient'`. (Task 2 does not depend on it.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/compositor/gradientMapGradientDial.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { dialSpecsFor } from '~/lib/compositor/effectDials'

describe('gradientMap gradient dial', () => {
  it('lists a gradient-kind stops dial', () => {
    const dials = dialSpecsFor('gradientMap')
    const stops = dials.find(d => d.key === 'stops')
    expect(stops).toBeTruthy()
    expect(stops!.kind).toBe('gradient')
  })
  it('keeps the scalar dials too', () => {
    const keys = dialSpecsFor('gradientMap').map(d => d.key)
    expect(keys).toEqual(expect.arrayContaining(['contrast', 'mix', 'scrollPhase', 'stops']))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientMapGradientDial`
Expected: FAIL — no `stops` dial.

- [ ] **Step 3: Write minimal implementation**

In `app/lib/compositor/effectDials.ts`:
1. Add `'gradient'` to `DialKind`:
```ts
export type DialKind = 'number' | 'color' | 'enum' | 'bool' | 'gradient'
```
2. Add a `grad` builder beside `num`/`col`:
```ts
const grad = (key: string, label: string): DialSpec => ({ key, label, kind: 'gradient' })
```
3. Add `stops` to the `gradientMap` array:
```ts
  gradientMap: [num('contrast', 'Contrast', -1, 1), num('mix', 'Mix', 0, 1), num('scrollPhase', 'Scroll', 0, 1), grad('stops', 'Ramp')],
```
(`stops` is a real field on `GradientMapEffect`, so the F8 schema-guard test that asserts every dial key exists on the created effect still passes.)

- [ ] **Step 4: Run test to verify it passes; confirm the F8 guard**

Run: `npm run test:unit -- gradientMapGradientDial` then `npm run test:unit -- effect-dials` (the schema guard).
Expected: PASS both.

- [ ] **Step 5: Commit** (private index — `effectDials.ts` has shown a foreign staged-delete state)

```bash
git commit -m "feat(compositor): gradient DialKind + gradientMap stops gradient dial

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(Stage `effectDials.ts` + the new test into a private index, then commit — see Global Constraints.)

---

### Task 5: Seed gradient tracks + Mode/Colour control (CompositorModal)

**Files:**
- Modify: `app/components/vue-canvas/CompositorModal.vue`
- Modify: `app/lib/motion/effectTracks.ts` (extend `addDialTrack` to carry `mode`/`blendSpace`)

**Interfaces:**
- `addDialTrack(tracks, target, t, v, space?, opts?: { mode?; blendSpace? })` — stores `mode`/`blendSpace` on the new track when given.
- `toggleDialTrack` seeds a gradient dial: `v` = the current gradient's stops as `{pos,color}[]` (from `getByIdPath` for `gradientMap.stops`; from the layer fill for `layers.<id>.fill`), with `mode: 'crossfade'`, `blendSpace: 'oklab'`.
- A small "Mode: Crossfade | Travel · Colour: OKLab | Hybrid" control shown when the open dial lane is a gradient track (writes `mode`/`blendSpace` onto that track via `setTrack`).

- [ ] **Step 1 (addDialTrack — TDD in effectTracks):** extend the pure reducer and test it.

```ts
// append to tests/unit/motion/effectTracksGradient.unit.spec.ts
import { addDialTrack } from '~/lib/motion/effectTracks'
it('addDialTrack stores mode/blendSpace for a gradient track', () => {
  const [tr] = addDialTrack(undefined, 'layers.L1.fill', 0, A, undefined, { mode: 'travel', blendSpace: 'hybrid' })
  expect(tr.mode).toBe('travel'); expect(tr.blendSpace).toBe('hybrid')
  expect(tr.keyframes[0].v).toEqual(A)
})
```
Implement by widening `addDialTrack`'s signature (add the optional `opts`) and spreading `opts` onto the track literal. Run `npm run test:unit -- effectTracksGradient`.

- [ ] **Step 2 (CompositorModal seeding):** In `toggleDialTrack` (the `seed` computation), handle a gradient dial:
  - When `spec.kind === 'gradient'`: derive `seed` = the current gradient stops as `{pos,color}[]`. For `gradientMap.stops`, `getByIdPath(...spec.path)` returns the `GradientMapStop[]` (already `{pos,color}`) — use it. For `layers.<id>.fill`, read the layer fill and map via `paintStopsToColor` (import from `gradientPaint`). Call `addDialTrack(..., seed, undefined, { mode: 'crossfade', blendSpace: 'oklab' })`.
  - Import `paintStopsToColor` from `~/lib/compositor/gradientPaint`.

- [ ] **Step 3 (Mode/Colour lane control):** add a computed for the currently-open gradient lane and a tiny two-segment control (Crossfade/Travel + OKLab/Hybrid) on the Motion tab that calls `setMotion({ tracks: setTrack(motionTracks.value, target, { ...track, mode, blendSpace }) })`. Keep the markup minimal and sentence-case; give the selects `optionLabels`.

- [ ] **Step 4: Verify in the running app** (no unit test for the Vue wiring; the pure seed/reducer is covered in Step 1). On `:3002`: add a rectangle with a gradient fill; Motion tab shows "Fill · Gradient" and "Gradient map · Ramp" in the picker; adding one creates a lane; the Mode/Colour control appears.

- [ ] **Step 5: Commit** `effectTracks.ts` + its test via pathspec/private-index; `CompositorModal.vue` via private index.

---

### Task 6: Gradient-swatch keyframes + per-keyframe gradient editor (timeline)

**Files:**
- Modify: `app/components/vue-canvas/compositor/CompositorMotionTimeline.vue`

**Interfaces:**
- Consumes: `setTrack`, `addKeyframe` from `~/lib/motion/effectTracks`; `isGradientValue`; `GradientEditor.vue`; the track's `mode`/`blendSpace`.
- Produces: for a gradient track's lane, each keyframe renders a small **gradient swatch** (built from `buildLUT(kf.v)` or a CSS `linear-gradient` from `kf.v`) instead of the amber diamond. A keyframe can be **selected** (new local `selectedKf: { target, index }` + an emit or local state); when selected, a `GradientEditor` (bound to a `Gradient` built from `kf.v`) is shown; editing it writes the new stops back via `setTrack(tracks, target, addKeyframe(track, kf.t, newStops))`. Adding a keyframe on a gradient lane seeds `kf.v` from `evaluateDialTrack` (already the interpolated gradient) — no change to `onLaneAdd` needed beyond passing the gradient value through.

- [ ] **Step 1: Gradient swatch keyframes.** In the diamond `v-for` (currently `bg-amber-300 rotate-45`), branch on `isGradientValue(kf.v)`: render a ~14×8px rounded rectangle whose background is a CSS `linear-gradient(90deg, <stops>)` derived from `kf.v` (`kf.v.map(s => `${s.color} ${s.pos*100}%`).join(',')`), positioned at `pct(kf.t/dur)`. Keep the drag/delete handlers.

- [ ] **Step 2: Keyframe selection + editor.** Add local `const selectedKf = ref<{ target: string; index: number } | null>(null)`. On a gradient keyframe `@click.stop`, set `selectedKf`. Below the lanes (or in a docked panel), when `selectedKf` and the track/keyframe resolve to a gradient value, mount:
```vue
<GradientEditor :model-value="gradientOf(selectedKf)" @update:model-value="g => setKeyframeGradient(selectedKf, g)" />
```
where `gradientOf` builds a `Gradient` from `kf.v` (`{ type:'linear', angle:0, stops: kf.v.map(s => ({offset:s.pos, color:s.color})) }`), and `setKeyframeGradient` maps the emitted `Gradient.stops` back to `{pos,color}[]` and emits `update:motion` with `setTrack(tracks, target, addKeyframe(track, kf.t, stops))` (replace-at-same-t). Follow the file's `beforeChange`→`update:motion`→`commit` emit contract.

- [ ] **Step 3: Verify in the running app.** On `:3002`: add a "Fill · Gradient" lane, add a second keyframe, select it, edit its gradient in the editor, scrub — the rectangle's fill morphs A→B (crossfade); switch the lane Mode to Travel and confirm the stops slide; do the same on a gradient-map effect. Screenshot the morph mid-transition.

- [ ] **Step 4: Commit** `CompositorMotionTimeline.vue` via private index.

---

## Self-Review

**Spec coverage (Crossfade + Travel):**
- Crossfade & Travel interpolation of gradient keyframes — Tasks 1, 2. ✓
- Fill surface (layer.fill gradient) — Task 3. ✓
- Gradient-map surface (gradientMap.stops) — Task 4 + the generic effect fold (assigns the resolved stop array onto `stops`; no fold change needed). ✓
- Authoring on the Motion tab (targets, seeding, mode/colour, gradient-swatch keyframes, per-keyframe editor) — Tasks 4, 5, 6. ✓
- OKLab default / Hybrid option — Tasks 1, 2 (`blendSpace`). ✓
- Byte-identity when idle — Task 3 test; the effect fold's existing same-reference contract. ✓

**Placeholder scan:** pure tasks (1–4) carry full code; the UI tasks (5–6) give exact seams, emit contracts, and the data transforms, with app verification as their gate (the timeline has no unit-test harness for interaction). The one deliberately-loose spot is the exact JSX/markup of the swatch and editor panel — bounded by the named seam (`CompositorMotionTimeline.vue` diamond `v-for`) and the `GradientEditor` v-model contract.

**Type consistency:** `ColorStop {pos,color}` is the keyframe gradient shape throughout; `withGradientStops`/`paintStopsToColor` bridge to the fill `{offset,color}`; `evaluateDialTrack`'s widened return (`… | ColorStop[]`) is consumed by the generic effect fold (assigns to `stops`) and the fill fold (rebuilds `Gradient`).

## Notes / risks
- **Gradient-map generic fold:** `applyEffectDialTracks` already assigns `nextEff[dialKey] = resolvedValue`; with `dialKey='stops'` and a resolved `{pos,color}[]`, the gradient-map pass consumes it unchanged. A single-keyframe gradient hold re-clones per frame (array identity) — acceptable perf, documented.
- **The compositor keyframe timeline is shared with the F1 session** — every Vue commit here uses a private index.
- **`GradientEditor` may emit extra `interp`/`interpBase` fields** on its `Gradient` (Plan 2 explore note); Task 6's `setKeyframeGradient` reads only `.stops`, so those are ignored — fine.
