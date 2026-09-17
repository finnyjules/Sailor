# Unified Motion — Phase 1: The Core (headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, surface-agnostic motion core — one keyframe/track type, one timing engine, typed interpolators, one evaluator, and a behaviour→track compiler — with zero Frame/compositor coupling, fully unit-tested.

**Architecture:** A new pure package `app/lib/motionx/`. Properties are addressed by string paths and carry a type (`number | color | gradient`). A `Track` holds `Keyframe`s; a typed interpolator interpolates by property type (reusing the landed `gradientTween` core for colour/gradient). One timing engine owns loop/hold/delay. `Behaviour`s compile to `Track`s through a small registry, so the ~40 kinetic presets and the gradient modes can all become behaviours later. No Vue/DOM/canvas, no import of `CompositorModal`/`useCompositorLayers`.

**Tech Stack:** TypeScript (strict), Vitest.

**Depends on:** `app/lib/color/gradientTween.ts` (landed) — `blendHex`, `crossfadeStops`, `travelStops`, `scrollStops`; `GradientStop` from `app/lib/color/harmony.ts`.

## Global Constraints

- **Surface-agnostic & pure.** Everything in `app/lib/motionx/` imports ONLY from `~/lib/color/*` and within `motionx/`. No Vue/Nuxt/DOM/canvas; no import of `CompositorModal.vue`, `useCompositorLayers`, `effectTracks.ts`, `fillTracks.ts`, or any compositor/studio module. This is the constraint that lets the studios and NLE adopt it later.
- **One stop shape at the boundary:** gradient values are the colour-lib `GradientStop { pos: number; color: string }` (from `~/lib/color/harmony`). Conversions to the compositor `{offset,color}` shape are NOT this package's job (they live in the Frame adapter, a later phase).
- **Types:** `Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'`; `PropertyType = 'number' | 'color' | 'gradient'`; `PropertyValue = number | string | GradientStop[]`. Colour blend space is `'oklab' | 'hybrid'` (via `blendHex`), default `'oklab'`.
- **Tests:** `tests/unit/motionx/**/*.unit.spec.ts`, run `npm run test:unit` (from `frontend/`), `~` alias.
- **Committing:** these are NEW files only you touch — commit via pathspec: `git add -- <newfiles>` then `git commit -m "<msg>" -- <paths>`. NEVER `git add -A`/bare commit (shared index is hostile). End messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Spec:** `docs/superpowers/specs/2026-09-17-unified-motion-model-design.md`. Paths relative to `frontend/`.

## File Structure

- `app/lib/motionx/types.ts` — `Ease`, `PropertyType`, `PropertyValue`, `Keyframe`, `Track`, `Timing`, `Behaviour`, `BehaviourTarget`.
- `app/lib/motionx/ease.ts` — `applyEase`.
- `app/lib/motionx/timing.ts` — `progress` (loop/hold/delay).
- `app/lib/motionx/interpolate.ts` — `interpolateValue` (typed: number/color/gradient), reusing `gradientTween`.
- `app/lib/motionx/track.ts` — `evaluateTrack`.
- `app/lib/motionx/evaluate.ts` — `evaluateTracks` (path→value map).
- `app/lib/motionx/behaviour.ts` — `compileBehaviour` + a small kind registry (fade, slide, gradientScroll, gradientMorph).
- `app/lib/motionx/index.ts` — barrel re-export.
- tests: `tests/unit/motionx/{ease,timing,interpolate,track,evaluate,behaviour}.unit.spec.ts`.

---

### Task 1: Types + easing

**Files:**
- Create: `app/lib/motionx/types.ts`, `app/lib/motionx/ease.ts`
- Test: `tests/unit/motionx/ease.unit.spec.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `Ease`, `PropertyType`, `PropertyValue`, `Keyframe { t; value; ease }`, `Track { path; type; keyframes; mode?: 'crossfade'|'travel'; space?: 'oklab'|'hybrid' }`, `Timing { start; duration; loop?; hold?; delay? }`, `Behaviour { id; kind; timing; params? }`, `BehaviourTarget { get(path): PropertyValue | undefined; has(path): boolean }`.
  - `ease.ts`: `applyEase(p: number, e: Ease): number` — clamps to [0,1]; `easeIn`=t², `easeOut`=1-(1-t)², `easeInOut`=smoothstep-ish, `linear`=t.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/ease.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { applyEase } from '~/lib/motionx/ease'

describe('applyEase', () => {
  it('clamps and hits endpoints', () => {
    for (const e of ['linear','easeIn','easeOut','easeInOut'] as const) {
      expect(applyEase(-1, e)).toBe(0)
      expect(applyEase(2, e)).toBe(1)
      expect(applyEase(0, e)).toBe(0)
      expect(applyEase(1, e)).toBe(1)
    }
  })
  it('is monotonic and matches known midpoints', () => {
    expect(applyEase(0.5, 'linear')).toBeCloseTo(0.5, 6)
    expect(applyEase(0.5, 'easeIn')).toBeCloseTo(0.25, 6)
    expect(applyEase(0.5, 'easeOut')).toBeCloseTo(0.75, 6)
    expect(applyEase(0.5, 'easeInOut')).toBeCloseTo(0.5, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/ease`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/types.ts
import type { GradientStop } from '~/lib/color/harmony'

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
export type PropertyType = 'number' | 'color' | 'gradient'
export type PropertyValue = number | string | GradientStop[]

export interface Keyframe { t: number; value: PropertyValue; ease: Ease }
export interface Track {
  path: string
  type: PropertyType
  keyframes: Keyframe[]
  mode?: 'crossfade' | 'travel'    // gradient tracks only
  space?: 'oklab' | 'hybrid'       // colour/gradient tracks only
}
export interface Timing { start: number; duration: number; loop?: boolean; hold?: number; delay?: number }
export interface Behaviour { id: string; kind: string; timing: Timing; params?: Record<string, unknown> }
/** A behaviour compiles against a target that can read current property values. */
export interface BehaviourTarget {
  get(path: string): PropertyValue | undefined
  has(path: string): boolean
}
```

```ts
// app/lib/motionx/ease.ts
import type { Ease } from './types'
export function applyEase(p: number, e: Ease): number {
  const t = p < 0 ? 0 : p > 1 ? 1 : p
  switch (e) {
    case 'easeIn': return t * t
    case 'easeOut': return 1 - (1 - t) * (1 - t)
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    default: return t
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/ease`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/types.ts app/lib/motionx/ease.ts tests/unit/motionx/ease.unit.spec.ts
git commit -m "feat(motionx): core types + easing (unified motion core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/types.ts app/lib/motionx/ease.ts tests/unit/motionx/ease.unit.spec.ts
```

---

### Task 2: Timing engine (loop / hold / delay)

**Files:**
- Create: `app/lib/motionx/timing.ts`
- Test: `tests/unit/motionx/timing.unit.spec.ts`

**Interfaces:**
- Consumes: `Timing`.
- Produces: `progress(timing: Timing, t: number): number` — raw 0..1 progress through the behaviour window. `delay` (default 0) and `start` shift the window; before `start+delay` → 0. Non-loop past the end → 1. `loop` wraps `local % 1`. `hold` (0..0.49) flattens both extremes. Easing is NOT applied here (callers apply `applyEase`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/timing.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { progress } from '~/lib/motionx/timing'

describe('progress', () => {
  const T = { start: 0, duration: 2 }
  it('0 before start, 1 after end (non-loop)', () => {
    expect(progress(T, -1)).toBe(0)
    expect(progress(T, 0)).toBe(0)
    expect(progress(T, 1)).toBeCloseTo(0.5, 6)
    expect(progress(T, 2)).toBe(1)
    expect(progress(T, 5)).toBe(1)
  })
  it('start + delay shift the window', () => {
    expect(progress({ start: 1, duration: 2, delay: 0.5 }, 1.4)).toBe(0)
    expect(progress({ start: 1, duration: 2, delay: 0.5 }, 2.5)).toBeCloseTo(0.5, 6)
  })
  it('loop wraps', () => {
    expect(progress({ start: 0, duration: 2, loop: true }, 3)).toBeCloseTo(0.5, 6)
    expect(progress({ start: 0, duration: 2, loop: true }, 4)).toBeCloseTo(0, 6)
  })
  it('hold flattens extremes', () => {
    const H = { start: 0, duration: 1, hold: 0.25 }
    expect(progress(H, 0.2)).toBe(0)     // inside the leading hold
    expect(progress(H, 0.5)).toBeCloseTo(0.5, 6)
    expect(progress(H, 0.8)).toBe(1)     // inside the trailing hold
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/timing`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/timing.ts
import type { Timing } from './types'
export function progress(timing: Timing, t: number): number {
  const start = timing.start + (timing.delay ?? 0)
  const d = Math.max(1e-4, timing.duration)
  let local = (t - start) / d
  if (local <= 0) return 0
  if (timing.loop) local = ((local % 1) + 1) % 1
  else if (local >= 1) return 1
  const h = Math.min(0.49, Math.max(0, timing.hold ?? 0))
  if (h > 0) {
    if (local <= h) return 0
    if (local >= 1 - h) return 1
    local = (local - h) / (1 - 2 * h)
  }
  return local
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/timing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/timing.ts tests/unit/motionx/timing.unit.spec.ts
git commit -m "feat(motionx): one timing engine — loop/hold/delay

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/timing.ts tests/unit/motionx/timing.unit.spec.ts
```

---

### Task 3: Typed interpolators

**Files:**
- Create: `app/lib/motionx/interpolate.ts`
- Test: `tests/unit/motionx/interpolate.unit.spec.ts`

**Interfaces:**
- Consumes: `blendHex`, `crossfadeStops`, `travelStops` from `~/lib/color/gradientTween`; `PropertyType`, `PropertyValue`, `Track`.
- Produces: `interpolateValue(type: PropertyType, a: PropertyValue, b: PropertyValue, p: number, opts?: { mode?: 'crossfade'|'travel'; space?: 'oklab'|'hybrid' }): PropertyValue`. number → lerp; color → `blendHex(a,b,p,space)`; gradient → `travelStops`/`crossfadeStops` per `opts.mode` (default crossfade), `opts.space` (default oklab). Exact endpoints at `p<=0`/`p>=1`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/interpolate.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { interpolateValue } from '~/lib/motionx/interpolate'
import type { GradientStop } from '~/lib/color/harmony'

describe('interpolateValue', () => {
  it('number lerps', () => {
    expect(interpolateValue('number', 0, 10, 0.5)).toBeCloseTo(5, 6)
  })
  it('color mixes with exact endpoints', () => {
    expect(interpolateValue('color', '#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(interpolateValue('color', '#ff0000', '#0000ff', 1)).toBe('#0000ff')
    expect(interpolateValue('color', '#ff0000', '#0000ff', 0.5)).not.toBe('#ff0000')
  })
  it('gradient crossfade/travel returns a stop array', () => {
    const A: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
    const B: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const c = interpolateValue('gradient', A, B, 0.5, { mode: 'crossfade' }) as GradientStop[]
    expect(Array.isArray(c)).toBe(true)
    const tr = interpolateValue('gradient', A, B, 0.5, { mode: 'travel' }) as GradientStop[]
    expect(Array.isArray(tr)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/interpolate`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/interpolate.ts
import { blendHex, crossfadeStops, travelStops } from '~/lib/color/gradientTween'
import type { GradientStop } from '~/lib/color/harmony'
import type { PropertyType, PropertyValue } from './types'

export interface InterpOpts { mode?: 'crossfade' | 'travel'; space?: 'oklab' | 'hybrid' }

export function interpolateValue(
  type: PropertyType, a: PropertyValue, b: PropertyValue, p: number, opts: InterpOpts = {},
): PropertyValue {
  const space = opts.space ?? 'oklab'
  if (type === 'number') return (a as number) + ((b as number) - (a as number)) * p
  if (type === 'color') return blendHex(a as string, b as string, p, space)
  const from = a as GradientStop[], to = b as GradientStop[]
  return (opts.mode ?? 'crossfade') === 'travel'
    ? travelStops(from, to, p, space)
    : crossfadeStops(from, to, p, space)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/interpolate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/interpolate.ts tests/unit/motionx/interpolate.unit.spec.ts
git commit -m "feat(motionx): typed interpolators (number/color/gradient) over gradientTween

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/interpolate.ts tests/unit/motionx/interpolate.unit.spec.ts
```

---

### Task 4: `evaluateTrack`

**Files:**
- Create: `app/lib/motionx/track.ts`
- Test: `tests/unit/motionx/track.unit.spec.ts`

**Interfaces:**
- Consumes: `applyEase`, `interpolateValue`, `Track`, `PropertyValue`.
- Produces: `evaluateTrack(track: Track, t: number): PropertyValue | undefined` — empty keyframes → `undefined`; clamps to first/last value outside the bracket; finds the bracket whose upper keyframe is the first with `kf.t >= t`; eases the local fraction with the FROM keyframe's `ease`; interpolates by `track.type` (passing `track.mode`/`track.space`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/track.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { evaluateTrack } from '~/lib/motionx/track'
import type { Track } from '~/lib/motionx/types'

describe('evaluateTrack', () => {
  const num: Track = { path: 'opacity', type: 'number', keyframes: [
    { t: 0, value: 0, ease: 'linear' }, { t: 2, value: 10, ease: 'linear' },
  ] }
  it('undefined for empty', () => {
    expect(evaluateTrack({ path: 'x', type: 'number', keyframes: [] }, 0)).toBeUndefined()
  })
  it('clamps and interpolates', () => {
    expect(evaluateTrack(num, -1)).toBe(0)
    expect(evaluateTrack(num, 3)).toBe(10)
    expect(evaluateTrack(num, 1)).toBeCloseTo(5, 6)
  })
  it('applies the FROM keyframe ease', () => {
    const eased: Track = { path: 'o', type: 'number', keyframes: [
      { t: 0, value: 0, ease: 'easeIn' }, { t: 1, value: 1, ease: 'linear' },
    ] }
    expect(evaluateTrack(eased, 0.5)).toBeCloseTo(0.25, 6) // easeIn(0.5)=0.25
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/track`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/track.ts
import { applyEase } from './ease'
import { interpolateValue } from './interpolate'
import type { Track, PropertyValue } from './types'

export function evaluateTrack(track: Track, t: number): PropertyValue | undefined {
  const kfs = track.keyframes
  if (!kfs.length) return undefined
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const first = sorted[0]!
  if (t <= first.t) return first.value
  const last = sorted[sorted.length - 1]!
  if (t >= last.t) return last.value
  let lo = first, hi = sorted[1]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t >= t) { lo = sorted[i - 1]!; hi = sorted[i]!; break }
  }
  const span = Math.max(1e-6, hi.t - lo.t)
  const p = applyEase((t - lo.t) / span, lo.ease)
  return interpolateValue(track.type, lo.value, hi.value, p, { mode: track.mode, space: track.space })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/track`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/track.ts tests/unit/motionx/track.unit.spec.ts
git commit -m "feat(motionx): evaluateTrack — one generic typed keyframe evaluator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/track.ts tests/unit/motionx/track.unit.spec.ts
```

---

### Task 5: `evaluateTracks` (the evaluator)

**Files:**
- Create: `app/lib/motionx/evaluate.ts`
- Test: `tests/unit/motionx/evaluate.unit.spec.ts`

**Interfaces:**
- Consumes: `evaluateTrack`, `Track`, `PropertyValue`.
- Produces: `evaluateTracks(tracks: Track[], t: number): Map<string, PropertyValue>` — evaluates each track at `t`, keyed by `path`; skips `undefined`. An empty `tracks` array returns an empty map (callers use emptiness for byte-identity). When two tracks share a path, the LAST wins (documented).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/evaluate.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { evaluateTracks } from '~/lib/motionx/evaluate'
import type { Track } from '~/lib/motionx/types'

describe('evaluateTracks', () => {
  const tracks: Track[] = [
    { path: 'opacity', type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' }] },
    { path: 'x', type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 100, ease: 'linear' }] },
  ]
  it('maps path -> value at t', () => {
    const m = evaluateTracks(tracks, 0.5)
    expect(m.get('opacity')).toBeCloseTo(0.5, 6)
    expect(m.get('x')).toBeCloseTo(50, 6)
  })
  it('empty tracks -> empty map', () => {
    expect(evaluateTracks([], 0).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/evaluate`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/evaluate.ts
import { evaluateTrack } from './track'
import type { Track, PropertyValue } from './types'

/** Evaluate every track at time `t`, keyed by property path (last track wins on a shared path). */
export function evaluateTracks(tracks: Track[], t: number): Map<string, PropertyValue> {
  const out = new Map<string, PropertyValue>()
  for (const track of tracks) {
    const v = evaluateTrack(track, t)
    if (v !== undefined) out.set(track.path, v)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/evaluate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/evaluate.ts tests/unit/motionx/evaluate.unit.spec.ts
git commit -m "feat(motionx): evaluateTracks — one evaluator (path -> value map)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/evaluate.ts tests/unit/motionx/evaluate.unit.spec.ts
```

---

### Task 6: Behaviour compiler + fade/slide

**Files:**
- Create: `app/lib/motionx/behaviour.ts`
- Test: `tests/unit/motionx/behaviour.unit.spec.ts`

**Interfaces:**
- Consumes: `Behaviour`, `BehaviourTarget`, `Track`, `Timing`.
- Produces:
  - `compileBehaviour(b: Behaviour, target: BehaviourTarget): Track[]` — dispatches on `b.kind` via a registry; unknown kind → `[]`.
  - Registered kinds this task: `'fade'` (params `{ dir: 'in'|'out' }`) → one `opacity` number track over the behaviour window (`in`: 0→1, `out`: 1→0), keyframes at `timing.start` and `timing.start + timing.duration`, ease `easeInOut`. `'slide'` (params `{ dir: 'up'|'down'|'left'|'right'; distance?: number }`, default distance 40) → a `y` (up/down) or `x` (left/right) number track from an offset to 0 (in) over the window, PLUS a fade-in opacity track. (Keep it a transform+opacity entrance; exit variants come with the full catalog in Phase 3.)
  - `registerBehaviour(kind: string, fn: (b, target) => Track[]): void` — extension point.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/behaviour.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { compileBehaviour } from '~/lib/motionx/behaviour'
import type { Behaviour, BehaviourTarget } from '~/lib/motionx/types'
import { evaluateTrack } from '~/lib/motionx/track'

const target: BehaviourTarget = { get: () => undefined, has: () => true }

describe('compileBehaviour', () => {
  it('unknown kind compiles to nothing', () => {
    expect(compileBehaviour({ id: 'x', kind: 'nope', timing: { start: 0, duration: 1 } }, target)).toEqual([])
  })
  it('fade in -> an opacity 0->1 track over the window', () => {
    const b: Behaviour = { id: 'f', kind: 'fade', timing: { start: 0, duration: 2 }, params: { dir: 'in' } }
    const tracks = compileBehaviour(b, target)
    const op = tracks.find(t => t.path === 'opacity')!
    expect(op.type).toBe('number')
    expect(evaluateTrack(op, 0)).toBe(0)
    expect(evaluateTrack(op, 2)).toBe(1)
  })
  it('slide up -> a y track ending at 0 plus a fade', () => {
    const b: Behaviour = { id: 's', kind: 'slide', timing: { start: 0, duration: 1 }, params: { dir: 'up', distance: 40 } }
    const tracks = compileBehaviour(b, target)
    const y = tracks.find(t => t.path === 'y')!
    expect(evaluateTrack(y, 1)).toBe(0)
    expect(tracks.some(t => t.path === 'opacity')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/behaviour`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/motionx/behaviour.ts
import type { Behaviour, BehaviourTarget, Track, Timing, Ease } from './types'

type Compiler = (b: Behaviour, target: BehaviourTarget) => Track[]
const REGISTRY = new Map<string, Compiler>()
export function registerBehaviour(kind: string, fn: Compiler): void { REGISTRY.set(kind, fn) }
export function compileBehaviour(b: Behaviour, target: BehaviourTarget): Track[] {
  return REGISTRY.get(b.kind)?.(b, target) ?? []
}

function window(timing: Timing): [number, number] {
  const start = timing.start + (timing.delay ?? 0)
  return [start, start + Math.max(1e-4, timing.duration)]
}
function numTrack(path: string, a: number, b: number, [t0, t1]: [number, number], ease: Ease = 'easeInOut'): Track {
  return { path, type: 'number', keyframes: [{ t: t0, value: a, ease }, { t: t1, value: b, ease: 'linear' }] }
}

registerBehaviour('fade', (b) => {
  const dir = (b.params?.dir as string) ?? 'in'
  const w = window(b.timing)
  return [numTrack('opacity', dir === 'out' ? 1 : 0, dir === 'out' ? 0 : 1, w)]
})

registerBehaviour('slide', (b) => {
  const dir = (b.params?.dir as string) ?? 'up'
  const dist = (b.params?.distance as number) ?? 40
  const w = window(b.timing)
  const axis = dir === 'left' || dir === 'right' ? 'x' : 'y'
  const from = dir === 'up' || dir === 'left' ? dist : -dist
  return [numTrack(axis, from, 0, w), numTrack('opacity', 0, 1, w)]
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/behaviour`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/behaviour.ts tests/unit/motionx/behaviour.unit.spec.ts
git commit -m "feat(motionx): behaviour compiler + fade/slide (compile to tracks)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/behaviour.ts tests/unit/motionx/behaviour.unit.spec.ts
```

---

### Task 7: Gradient behaviours (scroll / morph) + barrel

**Files:**
- Modify: `app/lib/motionx/behaviour.ts`
- Create: `app/lib/motionx/index.ts`
- Test: `tests/unit/motionx/behaviour.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `BehaviourTarget.get('fill')` returns the layer's current gradient stops (`GradientStop[]`) when the fill is a gradient.
- Produces:
  - `'gradientScroll'` → a `fill.phase` number track `0→1` over the window with `loop` semantics folded in by the caller's timing (here: keyframes 0→1 across the window; looping is a timing concern), `ease: 'linear'`.
  - `'gradientMorph'` (params `{ to: GradientStop[]; mode?: 'crossfade'|'travel'; space?: 'oklab'|'hybrid' }`) → a `fill` gradient track from `target.get('fill')` (or the param `from`) to `params.to`, carrying `mode`/`space`.
  - `index.ts` re-exports `types`, `ease`, `timing`, `interpolate`, `track`, `evaluate`, `behaviour`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/motionx/behaviour.unit.spec.ts
import type { GradientStop } from '~/lib/color/harmony'
const G: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const gradTarget = { get: (p: string) => (p === 'fill' ? G : undefined), has: () => true }

describe('gradient behaviours', () => {
  it('scroll -> a fill.phase 0->1 number track', () => {
    const t = compileBehaviour({ id: 'sc', kind: 'gradientScroll', timing: { start: 0, duration: 2, loop: true } }, gradTarget)
    const ph = t.find(x => x.path === 'fill.phase')!
    expect(ph.type).toBe('number')
    expect(evaluateTrack(ph, 0)).toBe(0)
    expect(evaluateTrack(ph, 2)).toBe(1)
  })
  it('morph -> a fill gradient track from current to target', () => {
    const To: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const t = compileBehaviour({ id: 'mo', kind: 'gradientMorph', timing: { start: 0, duration: 1 }, params: { to: To, mode: 'travel' } }, gradTarget)
    const fill = t.find(x => x.path === 'fill')!
    expect(fill.type).toBe('gradient')
    expect(fill.mode).toBe('travel')
    expect(fill.keyframes[0]!.value).toEqual(G)
    expect(fill.keyframes[1]!.value).toEqual(To)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- motionx/behaviour`
Expected: FAIL — the new describe fails (kinds not registered).

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/motionx/behaviour.ts
import type { GradientStop } from '~/lib/color/harmony'

registerBehaviour('gradientScroll', (b) => {
  const w = window(b.timing)
  return [numTrack('fill.phase', 0, 1, w, 'linear')]
})

registerBehaviour('gradientMorph', (b, target) => {
  const from = (b.params?.from as GradientStop[]) ?? (target.get('fill') as GradientStop[] | undefined)
  const to = b.params?.to as GradientStop[] | undefined
  if (!from || !to) return []
  const [t0, t1] = window(b.timing)
  return [{
    path: 'fill', type: 'gradient',
    mode: (b.params?.mode as 'crossfade' | 'travel') ?? 'crossfade',
    space: (b.params?.space as 'oklab' | 'hybrid') ?? 'oklab',
    keyframes: [{ t: t0, value: from, ease: 'easeInOut' }, { t: t1, value: to, ease: 'linear' }],
  }]
})
```

```ts
// app/lib/motionx/index.ts
export * from './types'
export * from './ease'
export * from './timing'
export * from './interpolate'
export * from './track'
export * from './evaluate'
export * from './behaviour'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- motionx/behaviour`
Expected: PASS (fade/slide + gradient behaviours).

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/motionx/behaviour.ts app/lib/motionx/index.ts tests/unit/motionx/behaviour.unit.spec.ts
git commit -m "feat(motionx): gradient behaviours (scroll/morph) + barrel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- app/lib/motionx/behaviour.ts app/lib/motionx/index.ts tests/unit/motionx/behaviour.unit.spec.ts
```

---

### Task 8: End-to-end core smoke (behaviour → compile → evaluate)

**Files:**
- Test: `tests/unit/motionx/pipeline.unit.spec.ts` (test-only)

**Interfaces:**
- Consumes: `compileBehaviour`, `evaluateTracks`.
- Produces: a guard proving the whole pipeline composes — a fade-in behaviour compiled and evaluated through `evaluateTracks` yields `opacity` 0 at the start, ~0.5 (eased) mid, 1 at the end; a gradientMorph yields a `fill` gradient stop-array mid-transition.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/motionx/pipeline.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { compileBehaviour, evaluateTracks } from '~/lib/motionx'
import type { BehaviourTarget } from '~/lib/motionx'
import type { GradientStop } from '~/lib/color/harmony'

const G: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const target: BehaviourTarget = { get: (p) => (p === 'fill' ? G : undefined), has: () => true }

describe('motionx pipeline', () => {
  it('fade in compiles and evaluates end to end', () => {
    const tracks = compileBehaviour({ id: 'f', kind: 'fade', timing: { start: 0, duration: 2 }, params: { dir: 'in' } }, target)
    expect(evaluateTracks(tracks, 0).get('opacity')).toBe(0)
    expect(evaluateTracks(tracks, 2).get('opacity')).toBe(1)
    const mid = evaluateTracks(tracks, 1).get('opacity') as number
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1)
  })
  it('gradient morph evaluates to a stop array mid-transition', () => {
    const To: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const tracks = compileBehaviour({ id: 'm', kind: 'gradientMorph', timing: { start: 0, duration: 1 }, params: { to: To } }, target)
    const v = evaluateTracks(tracks, 0.5).get('fill')
    expect(Array.isArray(v)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it (should pass immediately — it exercises Tasks 1–7)**

Run: `npm run test:unit -- motionx`
Expected: PASS across the whole `motionx` suite.

- [ ] **Step 3: Commit**

```bash
git add -- tests/unit/motionx/pipeline.unit.spec.ts
git commit -m "test(motionx): end-to-end pipeline guard (behaviour -> compile -> evaluate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- tests/unit/motionx/pipeline.unit.spec.ts
```

---

## Self-Review

**Spec coverage (Phase 1 only):**
- One property space (types + paths) — Task 1. ✓
- One keyframe/track — Task 1. ✓
- Typed interpolators reusing gradientTween — Task 3. ✓
- One evaluator — Tasks 4, 5. ✓
- One timing engine (loop/hold/delay) — Task 2. ✓
- Behaviours compile to tracks (fade/slide + gradient scroll/morph) — Tasks 6, 7. ✓
- Standalone / surface-agnostic (no Frame coupling) — Global Constraints; all imports are `~/lib/color/*` or intra-`motionx`. ✓
- End-to-end pipeline proof — Task 8. ✓
- **Deferred to later phases:** the Frame property-registry adapter + render wiring behind a flag (Phase 2); the full ~40 kinetic-preset behaviour port + previewing gallery (Phase 3); retiring old models (Phase 4). Parity-against-old-`evaluateAnimation` is deferred with the preset port (Phase 3), since it needs the full catalog.

**Placeholder scan:** none — every step has real code and a run command.

**Type consistency:** `Ease`, `PropertyType`, `PropertyValue`, `Track` (with `mode`/`space`), `Timing`, `Behaviour`, `BehaviourTarget` are defined in Task 1 and used unchanged in Tasks 2–8. `window`/`numTrack` helpers are defined in Task 6 and reused in Task 7. `interpolateValue`'s `opts` matches `Track.mode`/`space`.

## Notes for later phases
- **Phase 2** adds `app/lib/motionx/adapter/frame.ts` (the ONLY Frame-coupled file): `animatableProperties(layer)` + a `BehaviourTarget` over a `LocalLayer`, and wires `evaluateTracks` into `useCompositorLayers.paintLayerStack` behind a flag, applying resolved values to transform/effects/fill (converting gradient `{pos,color}`↔`{offset,color}` at that boundary).
- **Phase 3** ports the ~40 `kinetic-presets.ts` entries into behaviour compilers (parity-tested against `evaluate.ts`'s `evaluateAnimation`), and builds the previewing gallery + the unified timeline UI's value editor.
- **Phase 4** deletes `effectTracks.ts`/`fillTracks.ts` folds, `LayerKeyframe`, and the `MotionLayerEditor` preset panel once the adapter fully drives render.
