# Vector Type Motion — stack of moves (studio-neutral) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vector Type Studio's five-way Motion tab with one stack of "moves" — every preset, track, entrance and exit is one move card with an editable ease curve and a play mode — and build the shared parts (ease vocabulary, play, phase math, the ease picker, the move card and gallery) in studio-neutral homes so Gradient and the other parameter studios can adopt them next.

**Architecture:** Two layers. A **neutral motion layer** in `lib/motion` holds the ease vocabulary (`Ease`: ten named + a custom bezier), the play modes, and the pure phase/window/band math over a minimal `{ phase, duration, ease, play }` timing shape. Neutral components in `components/vue-canvas/motion/` (`EasePicker`, `MoveCard`, `MoveGallery`) render a studio's moves through a small **`StudioMotionAdapter`** interface, so a second studio is a mount, not a rewrite. The **Vector Type layer** in `lib/vectortype` provides its `VtMove` (the neutral timing shape plus `kind`/`presetId`/`tracks`), its adapter, and the glyph-engine composition. The stored motion shape changes from three preset slots plus a flat `tracks` array to one `moves` array; old documents convert on load, verified by a render-parity test. Blink and Scatter keep their own config blocks; their cards are derived, not stored, so there is one source of truth.

**Tech Stack:** Nuxt 4 (Vue 3 + TypeScript), Vitest, the existing `lib/motion/easing.ts` engine, `lib/spacetype/motion.ts`'s `bezierEase`, the existing `CurveEditor.vue`.

## Global Constraints

- **Plain language in all UI copy and any user-facing note** — short sentences, everyday words, no code names (standing rule; `[[plain-language-for-specs-and-questions]]`).
- **Colour: action blue is the only accent; purple is banned; amber only on taste chrome** (`[[sailor-colour-conventions]]`). The band strip's In/Out is amber, loop is emerald, matching `Scene3DMotionTimeline.vue`.
- **A declared control must be read by a renderer** — never ship a setting nothing consumes. Every move field a card edits must reach `vtGlyphMotion` / `applyMotion`.
- **Old saved documents must render identically after conversion** — the parity test in Task 3 is a hard gate.
- **`mergeConfig` is a strict rebuild** — every field type-checked and rewritten from the default; nothing trusted, including the moves array.
- **Neutral before VT-specific:** anything a second parameter studio would reuse verbatim (ease, play, phase math, the three components) lives in `lib/motion` / `components/vue-canvas/motion` and must not import `lib/vectortype`. VT-specific glue (preset ids, dials, axis presets, the font) stays in `lib/vectortype` and is handed in through the adapter.
- **Frequent commits** — one per task, message ending with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Run the Vector Type unit suite green before each engine commit:**
  `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts`
- **Dev server is `127.0.0.1`, not `localhost`** (`[[sailor-dev-server-localhost-426]]`). Reach the studio by adding a `VectorType` node and clicking Edit; there is no standalone studio route.

---

## File structure

**Neutral — created (no import of `lib/vectortype`):**
- `frontend/app/lib/motion/ease.ts` — `Ease` type, `EASE_NAMES`, `EASE_LABELS`, `DEFAULT_EASE`, `easeToEngineName`, `easeSample`, `easeGlyphPath`, `mergeEase`.
- `frontend/app/lib/motion/moveTiming.ts` — `MovePhase`, `PlayMode`, `Play`, `DEFAULT_PLAY`, `mergePlay`, the `MoveTiming` interface, `movePhase`, `moveWindows`, `bandSpans`.
- `frontend/app/lib/motion/studioAdapter.ts` — the `StudioMotionAdapter` interface + the `MoveOffer` / `DialDef` types the components consume.
- `frontend/app/components/vue-canvas/motion/EasePicker.vue` + `easePickerLogic.ts` — named-ease grid + custom curve.
- `frontend/app/components/vue-canvas/motion/MoveCard.vue` — one move's row and settings, driven by the adapter.
- `frontend/app/components/vue-canvas/motion/MoveGallery.vue` — the Add-move gallery, driven by the adapter, thumbs passed via a scoped slot.

**Neutral — modified:**
- `frontend/app/lib/motion/easing.ts` — `resolveEase` learns the `bezier(x1,y1,x2,y2)` name form.

**Vector Type — created:**
- `frontend/app/lib/vectortype/moves.ts` — `VtMove` (extends `MoveTiming`), `mergeMove`, `vtMoveTracks`, `vtMoveLabel`, `newMoveId`.
- `frontend/app/lib/vectortype/motionAdapter.ts` — `vtMotionAdapter(cfg, axes, font)` implementing `StudioMotionAdapter`; the offer list and custom dials.

**Vector Type — modified:**
- `config.ts` — `VtMotionConfig` gains `moves`, drops `tracks`/`in`/`out`/`loop`; `mergeMotion` converts both shapes; `VtMotionTrack` drops `easing`/`loops`.
- `presetMotion.ts` — `presetTransform`/`unitStateFor` iterate moves via `movePhase`.
- `motion.ts` — `applyMotion` and target helpers read tracks via `vtMoveTracks`, each with its move's ease/play.
- `trackPresets.ts` — `build` returns a `VtMove`; `vtApplyTrackPreset`/`vtTrackPresetActive` on moves; a legacy matcher for migration.
- `agentControls.ts` — three move words.
- `migrateKinetic.ts` — writes moves.
- `VectorTypeSurface.vue` — the whole Motion tab + the band strip.
- `controls.ts` — the `Motion` group keeps only stagger.

---

## Task 1: Neutral ease vocabulary + the bezier name form

**Files:**
- Create: `frontend/app/lib/motion/ease.ts`
- Modify: `frontend/app/lib/motion/easing.ts` (add `bezier(...)` to `resolveEase`, ~line 47)
- Test: `frontend/tests/unit/motion-ease.unit.spec.ts`

**Interfaces:**
- Consumes: `resolveEase`, `bezierEase` (from `lib/spacetype/motion.ts`).
- Produces:
  - `type Ease = { kind: 'named'; name: EaseName } | { kind: 'bezier'; cps: [number, number, number, number] }`
  - `type EaseName = 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate' | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'`
  - `const EASE_NAMES: readonly EaseName[]`, `const EASE_LABELS: Record<EaseName, string>`, `const DEFAULT_EASE: Ease`
  - `function easeToEngineName(ease: Ease): string`
  - `function easeSample(ease: Ease, t: number): number`
  - `function easeGlyphPath(ease: Ease, w: number, h: number): string`
  - `function mergeEase(raw: unknown): Ease`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/motion-ease.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveEase } from '~/lib/motion/easing'
import { DEFAULT_EASE, EASE_NAMES, easeGlyphPath, easeSample, easeToEngineName, mergeEase, type Ease } from '~/lib/motion/ease'

describe('motion ease', () => {
  it('every named ease resolves with fixed endpoints', () => {
    for (const name of EASE_NAMES) {
      const fn = resolveEase(easeToEngineName({ kind: 'named', name }))
      expect(fn(0)).toBeCloseTo(0, 6)
      expect(fn(1)).toBeCloseTo(1, 6)
    }
  })
  it('smooth eases out; none is linear', () => {
    expect(easeSample({ kind: 'named', name: 'smooth' }, 0.25)).toBeGreaterThan(0.25)
    expect(easeSample({ kind: 'named', name: 'none' }, 0.4)).toBeCloseTo(0.4, 6)
  })
  it('a bezier ease round-trips through the engine name', () => {
    const ease: Ease = { kind: 'bezier', cps: [0.87, 0, 0.13, 1] }
    const fn = resolveEase(easeToEngineName(ease))
    expect(fn(0.25)).toBeLessThan(0.25)
    expect(fn(0)).toBeCloseTo(0, 4)
    expect(fn(1)).toBeCloseTo(1, 4)
  })
  it('the glyph path is monotone in x', () => {
    const d = easeGlyphPath({ kind: 'named', name: 'smooth' }, 40, 20)
    const xs = [...d.matchAll(/[ML] ([\d.]+)/g)].map(m => Number(m[1]))
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1])
  })
  it('mergeEase rejects junk and clamps bezier points', () => {
    expect(mergeEase(undefined)).toEqual(DEFAULT_EASE)
    expect(mergeEase({ kind: 'named', name: 'nope' })).toEqual(DEFAULT_EASE)
    expect(mergeEase({ kind: 'bezier', cps: [2, 5, -3, -9] })).toEqual({ kind: 'bezier', cps: [1, 1.6, 0, -0.6] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/motion-ease.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/motion/ease`.

- [ ] **Step 3: Add the bezier name form to `resolveEase`**

In `frontend/app/lib/motion/easing.ts`, add at the top:
```ts
import { bezierEase } from '~/lib/spacetype/motion'
```
Inside `resolveEase`, immediately after `if (name === 'none' || name === 'linear') return linear`, add:
```ts
  const bez = /^bezier\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)$/.exec(name)
  if (bez) {
    const cps: [number, number, number, number] = [Number(bez[1]), Number(bez[2]), Number(bez[3]), Number(bez[4])]
    return (t: number) => bezierEase(t, cps)
  }
```

- [ ] **Step 4: Write `ease.ts`**

```ts
// frontend/app/lib/motion/ease.ts
/**
 * A move's ease, and its picture. PURE, studio-neutral.
 *
 * One ease per move. `easeToEngineName` turns it into a string `resolveEase`
 * already reads — the ten named eases map onto functions that exist there, and
 * a bezier becomes `bezier(a,b,c,d)`. `easeGlyphPath` samples the SAME function
 * the motion uses, so a tile can never disagree with the movement.
 *
 * Lives in lib/motion (not lib/vectortype) so Gradient, 3D and the Compositor
 * can share one ease vocabulary — see 3D's `EaseRef`, the same shape.
 */
import { resolveEase } from './easing'

export type EaseName =
  | 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate'
  | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'

export const EASE_NAMES: readonly EaseName[] =
  Object.freeze(['smooth', 'none', 'natural', 'slowDown', 'accelerate', 'overshoot', 'elastic', 'bounce', 'swing', 'steps'])

export type Ease =
  | { kind: 'named'; name: EaseName }
  | { kind: 'bezier'; cps: [number, number, number, number] }

export const DEFAULT_EASE: Ease = { kind: 'named', name: 'smooth' }

export const EASE_LABELS: Record<EaseName, string> = {
  none: 'None', smooth: 'Smooth', natural: 'Natural', slowDown: 'Slow down',
  accelerate: 'Speed up', overshoot: 'Overshoot', elastic: 'Elastic',
  bounce: 'Bounce', swing: 'Swing', steps: 'Steps',
}

const ENGINE_NAME: Record<EaseName, string> = {
  none: 'none', smooth: 'power2.out', natural: 'sine.inOut', slowDown: 'power3.out',
  accelerate: 'power3.in', overshoot: 'back.out', elastic: 'elastic.out',
  bounce: 'bounce.out', swing: 'back.inOut', steps: 'steps(6)',
}

export function easeToEngineName(ease: Ease): string {
  if (ease.kind === 'bezier') { const [a, b, c, d] = ease.cps; return `bezier(${a},${b},${c},${d})` }
  return ENGINE_NAME[ease.name] ?? 'power2.out'
}

export function easeSample(ease: Ease, t: number): number {
  return resolveEase(easeToEngineName(ease))(t)
}

export function easeGlyphPath(ease: Ease, w: number, h: number): string {
  const N = 24
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  let d = ''
  for (let i = 0; i <= N; i++) {
    const x = i / N
    const y = clamp(easeSample(ease, x))
    d += `${i === 0 ? 'M' : 'L'} ${(x * w).toFixed(2)} ${((1 - y) * h).toFixed(2)} `
  }
  return d.trim()
}

const clampX = (v: number) => Math.max(0, Math.min(1, v))
const clampY = (v: number) => Math.max(-0.6, Math.min(1.6, v))
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function mergeEase(raw: unknown): Ease {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EASE }
  const o = raw as Record<string, unknown>
  if (o.kind === 'bezier' && Array.isArray(o.cps) && o.cps.length === 4 && o.cps.every(isNum)) {
    const [x1, y1, x2, y2] = o.cps as number[]
    return { kind: 'bezier', cps: [clampX(x1!), clampY(y1!), clampX(x2!), clampY(y2!)] }
  }
  if (o.kind === 'named' && typeof o.name === 'string' && (EASE_NAMES as readonly string[]).includes(o.name)) {
    return { kind: 'named', name: o.name as EaseName }
  }
  return { ...DEFAULT_EASE }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/motion-ease.unit.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Guard the Compositor did not regress**

Run: `cd frontend && npx vitest run tests/unit/motion-*.unit.spec.ts`
Expected: PASS (the `bezier(...)` branch is additive).

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/motion/ease.ts app/lib/motion/easing.ts tests/unit/motion-ease.unit.spec.ts
git commit -m "feat(motion): neutral ease vocabulary — ten named + bezier, shared across studios

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Neutral play + phase/window/band math

**Files:**
- Create: `frontend/app/lib/motion/moveTiming.ts`
- Test: `frontend/tests/unit/motion-move-timing.unit.spec.ts`

**Interfaces:**
- Consumes: `Ease`, `easeSample`, `mergeEase` (`lib/motion/ease.ts`).
- Produces:
  - `type MovePhase = 'in' | 'loop' | 'out'`, `const MOVE_PHASES`
  - `type PlayMode = 'once' | 'backAndForth' | 'repeat'`, `const PLAY_MODES`
  - `interface Play { mode: PlayMode; times: number }`, `const DEFAULT_PLAY`, `function mergePlay(raw): Play`
  - `interface MoveTiming { phase: MovePhase; duration: number; ease: Ease; play: Play }`
  - `interface MoveWindow<T extends MoveTiming> { move: T; start: number; end: number }`
  - `function moveWindows<T extends MoveTiming>(moves: readonly T[], clip: number): { longestIn: number; windows: MoveWindow<T>[] }`
  - `function movePhase(move: MoveTiming, gt: number, clip: number, longestIn: number): number | null`
  - `function bandSpans(moves: readonly MoveTiming[], clip: number): { inFrac: number; loopFrac: number; outFrac: number }`

**Rules (spec §2):** In runs `[0, duration]`; Out runs `[clip − duration, clip]` clamped to start no earlier than the longest In; Loop runs the whole clip with phase 0 at `longestIn`. `play` shapes each pass; ease is applied to the pass's local progress.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/motion-move-timing.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { bandSpans, DEFAULT_PLAY, mergePlay, movePhase, moveWindows, type MoveTiming } from '~/lib/motion/moveTiming'

const mk = (o: Partial<MoveTiming>): MoveTiming => ({ phase: 'in', duration: 1, ease: { kind: 'named', name: 'none' }, play: DEFAULT_PLAY, ...o })

describe('move timing', () => {
  it('longest in sets loop phase 0', () => {
    expect(moveWindows([mk({ phase: 'in', duration: 0.6 }), mk({ phase: 'in', duration: 1 })], 4).longestIn).toBeCloseTo(1, 6)
  })
  it('an in move is live only inside its window', () => {
    const a = mk({ phase: 'in', duration: 0.5 })
    expect(movePhase(a, 0.25, 4, 0.5)).toBeCloseTo(0.5, 6)
    expect(movePhase(a, 0.6, 4, 0.5)).toBeNull()
  })
  it('an out move runs at the end', () => {
    const o = mk({ phase: 'out', duration: 0.5 })
    expect(movePhase(o, 3.75, 4, 0)).toBeCloseTo(0.5, 6)
    expect(movePhase(o, 3.0, 4, 0)).toBeNull()
  })
  it('a loop phase 0 sits at the longest in end and wraps', () => {
    const l = mk({ phase: 'loop', duration: 1, play: { mode: 'repeat', times: 1 } })
    expect(movePhase(l, 1.0, 4, 1.0)).toBeCloseTo(0, 6)
    expect(movePhase(l, 1.5, 4, 1.0)).toBeCloseTo(0.5, 6)
  })
  it('back and forth returns to 0 at the cycle end', () => {
    const l = mk({ phase: 'loop', duration: 1, play: { mode: 'backAndForth', times: 1 } })
    expect(movePhase(l, 1.5, 4, 1.0)).toBeCloseTo(1, 6)
    expect(movePhase(l, 2.0, 4, 1.0)).toBeCloseTo(0, 6)
  })
  it('band spans reflect the longest in and out', () => {
    const s = bandSpans([mk({ phase: 'in', duration: 1 }), mk({ phase: 'out', duration: 0.5 })], 4)
    expect(s.inFrac).toBeCloseTo(0.25, 6); expect(s.outFrac).toBeCloseTo(0.125, 6); expect(s.loopFrac).toBeCloseTo(0.625, 6)
  })
  it('mergePlay defaults and clamps', () => {
    expect(mergePlay(undefined)).toEqual(DEFAULT_PLAY)
    expect(mergePlay({ mode: 'repeat', times: 99 })).toEqual({ mode: 'repeat', times: 20 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/motion-move-timing.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/motion/moveTiming`.

- [ ] **Step 3: Write `moveTiming.ts`**

```ts
// frontend/app/lib/motion/moveTiming.ts
/** Neutral phase/window/band math over the minimal move-timing shape. PURE. */
import { type Ease, easeSample } from './ease'

export type MovePhase = 'in' | 'loop' | 'out'
export const MOVE_PHASES: readonly MovePhase[] = Object.freeze(['in', 'loop', 'out'])

export type PlayMode = 'once' | 'backAndForth' | 'repeat'
export const PLAY_MODES: readonly PlayMode[] = Object.freeze(['once', 'backAndForth', 'repeat'])

export interface Play { mode: PlayMode; times: number }
export const DEFAULT_PLAY: Play = { mode: 'once', times: 1 }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function mergePlay(raw: unknown): Play {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLAY }
  const o = raw as Record<string, unknown>
  const mode = (PLAY_MODES as readonly string[]).includes(o.mode as string) ? o.mode as PlayMode : 'once'
  const times = isNum(o.times) ? Math.max(1, Math.min(20, Math.round(o.times))) : 1
  return { mode, times }
}

export interface MoveTiming { phase: MovePhase; duration: number; ease: Ease; play: Play }
export interface MoveWindow<T extends MoveTiming> { move: T; start: number; end: number }

export function moveWindows<T extends MoveTiming>(moves: readonly T[], clip: number): { longestIn: number; windows: MoveWindow<T>[] } {
  const W = Math.max(0.001, clip)
  let longestIn = 0
  for (const m of moves) if (m.phase === 'in') longestIn = Math.max(longestIn, Math.min(W, m.duration))
  const windows = moves.map(m => {
    if (m.phase === 'in') return { move: m, start: 0, end: Math.min(W, m.duration) }
    if (m.phase === 'out') return { move: m, start: Math.max(longestIn, W - m.duration), end: W }
    return { move: m, start: longestIn, end: W }
  })
  return { longestIn, windows }
}

export function movePhase(move: MoveTiming, gt: number, clip: number, longestIn: number): number | null {
  const W = Math.max(0.001, clip)
  const t = Math.max(0, gt)
  if (move.phase === 'in') {
    const dur = Math.max(0.05, move.duration)
    if (t >= dur) return null
    return playAndEase(move, t / dur)
  }
  if (move.phase === 'out') {
    const start = Math.max(longestIn, W - move.duration)
    if (t < start || W <= longestIn) return null
    const eff = Math.max(0.05, W - start)
    return playAndEase(move, Math.min(1, (t - start) / eff))
  }
  const cycle = Math.max(0.1, move.duration)
  const local = t - longestIn
  if (local < 0) return null
  const cyclePhase = ((local / cycle) % 1 + 1) % 1
  if (move.play.mode === 'backAndForth') {
    const p = cyclePhase < 0.5 ? cyclePhase * 2 : (1 - cyclePhase) * 2
    return easeSample(move.ease, p)
  }
  return easeSample(move.ease, cyclePhase)
}

function playAndEase(move: MoveTiming, p: number): number {
  const { mode, times } = move.play
  if (mode === 'once') return easeSample(move.ease, p)
  if (mode === 'repeat') { const local = (p * Math.max(1, times)) % 1; return easeSample(move.ease, p >= 1 ? 1 : local) }
  const cyc = (p * Math.max(1, times)) % 1
  const tri = cyc < 0.5 ? cyc * 2 : (1 - cyc) * 2
  return easeSample(move.ease, tri)
}

export function bandSpans(moves: readonly MoveTiming[], clip: number): { inFrac: number; loopFrac: number; outFrac: number } {
  const W = Math.max(0.001, clip)
  let inn = 0, out = 0
  for (const m of moves) { if (m.phase === 'in') inn = Math.max(inn, Math.min(W, m.duration)); if (m.phase === 'out') out = Math.max(out, Math.min(W, m.duration)) }
  const inFrac = inn / W, outFrac = out / W
  return { inFrac, loopFrac: Math.max(0, 1 - inFrac - outFrac), outFrac }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/motion-move-timing.unit.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/motion/moveTiming.ts tests/unit/motion-move-timing.unit.spec.ts
git commit -m "feat(motion): neutral play + phase/window/band math over MoveTiming

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: The VtMove data model and its merge

**Files:**
- Create: `frontend/app/lib/vectortype/moves.ts`
- Modify: `frontend/app/lib/vectortype/config.ts` (`VtMotionConfig`, `VtMotionTrack`, `DEFAULT_MOTION`, `mergeMotion`, `mergeTrack`)
- Test: `frontend/tests/unit/vectortype-moves.unit.spec.ts`

**Interfaces:**
- Consumes: `MoveTiming`, `Play`, `DEFAULT_PLAY`, `mergePlay` (`lib/motion/moveTiming.ts`); `Ease`, `DEFAULT_EASE`, `mergeEase` (`lib/motion/ease.ts`); `VtMotionTrack`, `mergeTrack` (config.ts).
- Produces:
  - `interface VtMove extends MoveTiming { id: string; kind: 'preset' | 'tracks'; presetId?: string; params?: Record<string, number>; tracks?: VtMotionTrack[] }`
  - `function mergeMove(raw, mergeTrackFn?): VtMove | undefined`
  - `function vtMoveTracks(cfg): (VtMotionTrack & { __ease: Ease; __play: Play })[]`
  - `function vtMoveLabel(move, presetLabelOf): string`
  - `function newMoveId(existing): string`
- Change: `VtMotionConfig` gains `moves: VtMove[]`, drops `tracks`/`in`/`out`/`loop`. `VtMotionTrack` drops `easing` and `loops`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-moves.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_EASE } from '~/lib/motion/ease'
import { DEFAULT_PLAY } from '~/lib/motion/moveTiming'
import { mergeMove, newMoveId, vtMoveLabel, vtMoveTracks, type VtMove } from '~/lib/vectortype/moves'
import { DEFAULT_CONFIG, cloneConfig } from '~/lib/vectortype/config'

describe('vt moves', () => {
  it('mergeMove type-checks a preset move', () => {
    const m = mergeMove({ id: 'm1', phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 0.6 })!
    expect(m.kind).toBe('preset'); expect(m.phase).toBe('in'); expect(m.duration).toBe(0.6)
    expect(m.ease).toEqual(DEFAULT_EASE); expect(m.play).toEqual(DEFAULT_PLAY)
  })
  it('mergeMove drops a move with no presetId and no tracks', () => {
    expect(mergeMove({ id: 'm2', phase: 'loop', kind: 'preset' })).toBeUndefined()
    expect(mergeMove({ id: 'm3', phase: 'loop', kind: 'tracks', tracks: [] })).toBeUndefined()
  })
  it('unknown phase defaults to loop; duration clamps', () => {
    const m = mergeMove({ id: 'm4', phase: 'sideways', kind: 'preset', presetId: 'wave', duration: 999 })!
    expect(m.phase).toBe('loop'); expect(m.duration).toBe(60)
  })
  it('vtMoveTracks flattens tracks-moves and tags each', () => {
    const cfg = cloneConfig(DEFAULT_CONFIG)
    cfg.motion.moves = [
      { id: 'a', phase: 'loop', kind: 'preset', presetId: 'wave', duration: 1.5, ease: DEFAULT_EASE, play: DEFAULT_PLAY },
      { id: 'b', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4, ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: 1 },
        tracks: [{ path: 'axes.wght', from: 100, to: 900, hold: 0, cycleOffset: 0, delay: 0 }] },
    ] as VtMove[]
    const tracks = vtMoveTracks(cfg)
    expect(tracks).toHaveLength(1); expect(tracks[0]!.path).toBe('axes.wght'); expect(tracks[0]!.__play.mode).toBe('backAndForth')
  })
  it('label reads a custom move by its dial and a preset by its label', () => {
    const custom: VtMove = { id: 'c', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4, ease: DEFAULT_EASE, play: DEFAULT_PLAY, tracks: [{ path: 'axes.slnt', from: 0, to: 10, hold: 0, cycleOffset: 0, delay: 0 } as any] }
    expect(vtMoveLabel(custom, () => 'X')).toContain('slnt')
    const preset: VtMove = { id: 'p', phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 1, ease: DEFAULT_EASE, play: DEFAULT_PLAY }
    expect(vtMoveLabel(preset, () => 'Fade In')).toBe('Fade In')
  })
  it('newMoveId does not collide', () => { expect(newMoveId([{ id: 'move-1' } as VtMove])).not.toBe('move-1') })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/vectortype/moves`.

- [ ] **Step 3: Write `moves.ts`**

```ts
// frontend/app/lib/vectortype/moves.ts
/**
 * Vector Type — a MOVE. Extends the neutral MoveTiming (phase/duration/ease/play)
 * with the VT-specific kind/presetId/tracks. Blink and Scatter are NOT moves —
 * they keep their config blocks; their cards are derived by the surface.
 */
import { type Ease, DEFAULT_EASE, mergeEase } from '~/lib/motion/ease'
import { type MoveTiming, type Play, DEFAULT_PLAY, MOVE_PHASES, type MovePhase, mergePlay } from '~/lib/motion/moveTiming'
import type { VtMotionTrack } from './config'

export interface VtMove extends MoveTiming {
  id: string
  kind: 'preset' | 'tracks'
  presetId?: string
  params?: Record<string, number>
  tracks?: VtMotionTrack[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clampDur = (v: number) => Math.max(0.05, Math.min(60, v))

function mergeParams(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isNum(v)) out[k] = v
  return Object.keys(out).length ? out : undefined
}

export function mergeMove(raw: unknown, mergeTrackFn?: (t: unknown) => VtMotionTrack | undefined): VtMove | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const kind = o.kind === 'tracks' ? 'tracks' : 'preset'
  const phase: MovePhase = (MOVE_PHASES as readonly string[]).includes(o.phase as string) ? o.phase as MovePhase : 'loop'
  const id = typeof o.id === 'string' && o.id ? o.id : `move-${Math.random().toString(36).slice(2, 9)}`
  const presetId = typeof o.presetId === 'string' && o.presetId.trim() ? o.presetId.trim() : undefined
  const base = { id, phase, kind, duration: clampDur(isNum(o.duration) ? o.duration : 1), ease: mergeEase(o.ease), play: mergePlay(o.play) } as VtMove
  if (kind === 'tracks') {
    const rawTracks = Array.isArray(o.tracks) ? o.tracks : []
    const tracks: VtMotionTrack[] = []
    for (const t of rawTracks) { const tk = mergeTrackFn?.(t); if (tk) tracks.push(tk) }
    if (!tracks.length) return undefined
    return { ...base, presetId: presetId ?? 'custom', tracks }
  }
  if (!presetId) return undefined
  const params = mergeParams(o.params)
  return { ...base, presetId, ...(params ? { params } : {}) }
}

export function vtMoveTracks(cfg: { motion?: { moves?: VtMove[] } } | null | undefined): (VtMotionTrack & { __ease: Ease; __play: Play })[] {
  const moves = cfg?.motion?.moves
  if (!Array.isArray(moves)) return []
  const out: (VtMotionTrack & { __ease: Ease; __play: Play })[] = []
  for (const m of moves) { if (m.kind !== 'tracks' || !m.tracks) continue; for (const tk of m.tracks) out.push({ ...tk, __ease: m.ease, __play: m.play }) }
  return out
}

export function vtMoveLabel(move: VtMove, presetLabelOf: (id: string) => string): string {
  if (move.kind === 'tracks' && move.presetId === 'custom') {
    return `Custom · ${(move.tracks?.[0]?.path ?? '').split('.').pop() ?? 'dial'}`
  }
  return presetLabelOf(move.presetId ?? '')
}

export function newMoveId(existing: readonly VtMove[]): string {
  const used = new Set(existing.map(m => m.id))
  let n = existing.length + 1, id = `move-${n}`
  while (used.has(id)) id = `move-${++n}`
  return id
}
```

- [ ] **Step 4: Change `config.ts` types and merge (new shape only; migration in Task 4)**

In `config.ts`:
1. Add `import { type VtMove, mergeMove } from './moves'` and `import type { Ease } from '~/lib/motion/ease'`, `import type { Play } from '~/lib/motion/moveTiming'`.
2. In `VtMotionTrack`, remove `easing: EasingKind` and `loops: number`. Keep `path`, `from`, `to`, `hold`, `cycleOffset`, `delay`, colour fields.
3. Replace `VtMotionConfig` fields `tracks`/`in?`/`out?`/`loop?` with `moves: VtMove[]`.
4. `DEFAULT_MOTION` and `DEFAULT_CONFIG.motion`: `tracks: []` → `moves: []`.
5. In `mergeTrack`, delete the `o.easing` and `o.loops` reads.
6. Rewrite the slots/tracks part of `mergeMotion` to read only the new shape:
```ts
  const moves: VtMove[] = []
  if (Array.isArray(o.moves)) for (const raw of o.moves) { const m = mergeMove(raw, (t) => mergeTrack(t, remap)); if (m) moves.push(m) }
  return {
    moves,
    duration: clamp(num(o.duration, DEFAULT_MOTION.duration), 0.1, 60),
    fps: clamp(Math.round(num(o.fps, DEFAULT_MOTION.fps)), 1, 60),
    size: oneOfNum(o.size, VT_MOTION_SIZES, DEFAULT_MOTION.size),
    stagger: mergeStagger(o.stagger), blink: mergeBlink(o.blink), scatter: mergeScatter(o.scatter),
  }
```
7. Delete `mergeAnimSpec`. Keep `VT_PRESET_SLOTS` / `VT_PRESET_DURATIONS` (Task 4 uses them).

- [ ] **Step 5: Shim `motion.ts` reads so the suite compiles**

Add `import { vtMoveTracks } from './moves'` and replace every `cfg.motion.tracks` READ in `motion.ts` with `vtMoveTracks(cfg)`. Run:
```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "motion\.(tracks|in|out|loop)|mergeAnimSpec|\.easing|\.loops" | head -40
```
Point lib reads at `vtMoveTracks(cfg)`; leave `.vue` and `presetMotion.ts`/`trackPresets.ts` errors for their tasks.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/vectortype/moves.ts app/lib/vectortype/config.ts app/lib/vectortype/motion.ts tests/unit/vectortype-moves.unit.spec.ts
git commit -m "feat(vectortype): VtMove over neutral MoveTiming; moves replace slots + flat tracks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Convert old documents on load

**Files:**
- Modify: `frontend/app/lib/vectortype/config.ts` (`mergeMotion` accepts the old shape)
- Modify: `frontend/app/lib/vectortype/trackPresets.ts` (add `vtMatchLegacyTrackPreset`)
- Test: `frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts`

**Interfaces:**
- Consumes: `VT_PRESET_SLOTS`, `VT_PRESET_DURATIONS`, `mergeMove`, `mergeTrack`; `Ease`, `EaseName`, `Play` (`lib/motion`).
- Produces: `mergeMotion` converts a `motion` carrying `in`/`out`/`loop`/`tracks` (old) into `moves`; a `motion` carrying `moves` (new) passes straight through. `vtMatchLegacyTrackPreset(tracks): string | null`.

**Conversion (spec §7):** slots → preset moves (loop = play `repeat`, in/out = `once`; ease from the spec's `ease` string if it names one of the ten, else default). Tracks → one matched track-preset move plus a custom move per leftover; track `easing` maps `linear`→none+once, `easeinout`→natural+once, `pingpong`→none+backAndForth; `loops`→`play.times`; phase always loop. Blink/scatter already in their blocks; no move created.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { mergeConfig, DEFAULT_CONFIG, cloneConfig } from '~/lib/vectortype/config'

describe('vt motion migration', () => {
  it('converts in/out/loop slots to preset moves', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = { duration: 4, fps: 30, size: 1080,
      in: { presetId: 'fade-in', duration: 0.6, ease: 'power2.out' }, out: { presetId: 'fade-out', duration: 0.5 }, loop: { presetId: 'wave', duration: 1.2 },
      tracks: [], stagger: { delay: 0, order: 'forward', seed: 0 }, blink: { amount: 0 }, scatter: { spread: 0 } }
    const cfg = mergeConfig(old)
    expect(cfg.motion.moves).toHaveLength(3)
    expect(cfg.motion.moves.find(m => m.phase === 'in')!.presetId).toBe('fade-in')
    expect(cfg.motion.moves.find(m => m.phase === 'in')!.play.mode).toBe('once')
    expect(cfg.motion.moves.find(m => m.phase === 'loop')!.play.mode).toBe('repeat')
  })
  it('a pingpong track becomes a custom back-and-forth move', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = { duration: 4, fps: 30, size: 1080,
      tracks: [{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2, hold: 0, cycleOffset: 0, delay: 0 }],
      stagger: { delay: 0, order: 'forward', seed: 0 }, blink: { amount: 0 }, scatter: { spread: 0 } }
    const m = mergeConfig(old).motion.moves[0]!
    expect(m.kind).toBe('tracks'); expect(m.presetId).toBe('custom')
    expect(m.play).toEqual({ mode: 'backAndForth', times: 2 }); expect(m.ease).toEqual({ kind: 'named', name: 'none' })
  })
  it('a new-shape config round-trips unchanged', () => {
    expect(mergeConfig(cloneConfig(DEFAULT_CONFIG)).motion.moves).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves-migrate.unit.spec.ts`
Expected: FAIL — slots ignored.

- [ ] **Step 3: Add the legacy matcher to `trackPresets.ts`**

```ts
// append to frontend/app/lib/vectortype/trackPresets.ts
const PRESET_SIGNATURE_PATHS: Record<string, string[]> = {
  'stretch-in': ['layout.stretch'], 'stretch-wave': ['layout.stretch'], 'spring-up': ['layout.height'],
}
export function vtMatchLegacyTrackPreset(tracks: readonly { path: string }[]): string | null {
  const paths = new Set(tracks.map(t => t.path))
  for (const preset of VT_TRACK_PRESETS) {
    const sig = PRESET_SIGNATURE_PATHS[preset.id]
    if (sig && sig.length === paths.size && sig.every(p => paths.has(p))) return preset.id
  }
  return null
}
```
(If the run-level presets write keys other than `layout.stretch`/`layout.height`, read the real keys from each preset's `build` and copy them here.)

- [ ] **Step 4: Add conversion to `mergeMotion`**

Before the new-shape `moves` block, branch:
```ts
  const hasNewShape = Array.isArray(o.moves)
  const hasOldShape = ('tracks' in o) || VT_PRESET_SLOTS.some(s => s in o)
  const moves: VtMove[] = []
  if (hasNewShape) {
    for (const raw of o.moves as unknown[]) { const m = mergeMove(raw, (t) => mergeTrack(t, remap)); if (m) moves.push(m) }
  } else if (hasOldShape) {
    for (const slot of VT_PRESET_SLOTS) {
      const raw = o[slot] as Record<string, unknown> | undefined
      const presetId = raw && typeof raw.presetId === 'string' ? raw.presetId.trim() : ''
      if (!presetId) continue
      const easeName = legacyEaseName(typeof raw!.ease === 'string' ? raw!.ease as string : undefined)
      const m = mergeMove({ id: `move-${slot}`, phase: slot, kind: 'preset', presetId,
        duration: num(raw!.duration, VT_PRESET_DURATIONS[slot]),
        ease: easeName ? { kind: 'named', name: easeName } : undefined,
        play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 }, params: raw!.params }, (t) => mergeTrack(t, remap))
      if (m) moves.push(m)
    }
    const rawTracks: any[] = Array.isArray(o.tracks) ? o.tracks : []
    const merged = rawTracks.map(t => mergeTrack(t, remap)).filter(Boolean) as VtMotionTrack[]
    const rawByMerged = new Map<VtMotionTrack, any>(); merged.forEach((mk, i) => rawByMerged.set(mk, rawTracks[i]))
    const presetId = merged.length ? vtMatchLegacyTrackPreset(merged) : null
    if (presetId) {
      moves.push(mergeMove({ id: 'move-track-preset', phase: 'loop', kind: 'tracks', presetId, duration: num(o.duration, 4),
        ease: { kind: 'named', name: 'none' }, play: { mode: 'repeat', times: 1 }, tracks: merged }, (t) => mergeTrack(t, remap))!)
    } else {
      for (const mk of merged) {
        const raw = rawByMerged.get(mk); const { ease, play } = legacyTrackEasePlay(raw?.easing, raw?.loops)
        moves.push(mergeMove({ id: `move-${moves.length + 1}`, phase: 'loop', kind: 'tracks', presetId: 'custom', duration: num(o.duration, 4), ease, play, tracks: [mk] }, (t) => mergeTrack(t, remap))!)
      }
    }
  }
```
Add the helpers (import `EaseName`, `Ease`, `Play`):
```ts
function legacyEaseName(ease: string | undefined): EaseName | null {
  if (ease === 'none' || ease === 'linear') return 'none'
  if (ease?.startsWith('power')) return ease.includes('.in') && !ease.includes('inOut') ? 'accelerate' : 'smooth'
  if (ease === 'sine.inOut') return 'natural'
  if (ease?.startsWith('back')) return 'overshoot'
  if (ease?.startsWith('elastic')) return 'elastic'
  if (ease?.startsWith('bounce')) return 'bounce'
  return null
}
function legacyTrackEasePlay(easing: unknown, loops: unknown): { ease: Ease; play: Play } {
  const times = typeof loops === 'number' && Number.isFinite(loops) ? Math.max(1, Math.round(loops)) : 1
  if (easing === 'pingpong') return { ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times } }
  if (easing === 'easeinout') return { ease: { kind: 'named', name: 'natural' }, play: { mode: 'once', times } }
  return { ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times } }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vectortype-moves-migrate.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/config.ts app/lib/vectortype/trackPresets.ts tests/unit/vectortype-moves-migrate.unit.spec.ts
git commit -m "feat(vectortype): convert old motion (slots + tracks) to moves on load

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Compose N moves in the engine

**Files:**
- Modify: `frontend/app/lib/vectortype/presetMotion.ts` (`vtPresetMoves`, `presetTransform`, `unitStateFor`; `vtSlotPhase` → delegate to `movePhase`)
- Modify: `frontend/app/lib/vectortype/motion.ts` (`applyMotion` reads `vtMoveTracks`, each track's `__ease`/`__play`)
- Test: extend `frontend/tests/unit/vectortype-preset-motion.unit.spec.ts`

**Interfaces:**
- Consumes: `moveWindows`, `movePhase` (`lib/motion/moveTiming`), `vtMoveTracks` (`lib/vectortype/moves`), `easeSample`, `easeToEngineName` (`lib/motion/ease`).
- Produces: unchanged public signatures — `vtGlyphMotion`, `applyMotion`, `presetTransform`. Internally they iterate moves.

**Composition (spec §2):** across live preset moves — `dx/dy/rotate/blur` add, `scale/scaleX/scaleY/opacity` multiply, `axes` add per tag, `clip` = max amount per side. Tracks compose on top, each evaluated with its move's ease/play.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append inside frontend/tests/unit/vectortype-preset-motion.unit.spec.ts
import { DEFAULT_EASE } from '~/lib/motion/ease'
import type { VtMove } from '~/lib/vectortype/moves'

describe('stacked moves', () => {
  const base = () => { const c = cloneConfig(DEFAULT_CONFIG); c.motion.duration = 4; return c }
  const preset = (o: Partial<VtMove>): VtMove => ({ id: Math.random().toString(36).slice(2), phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 1, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 }, ...o })

  it('two ins compose: fade opacity and slide offset both live at once', () => {
    const cfg = base(); cfg.motion.moves = [preset({ presetId: 'fade-in', duration: 1 }), preset({ presetId: 'slide-up', duration: 1 })]
    const m = vtGlyphMotion(cfg, 0.5, 0, 6, 100)
    expect(m.opacity).toBeGreaterThan(0); expect(m.opacity).toBeLessThan(1); expect(Math.abs(m.dy)).toBeGreaterThan(0)
  })
  it('a preset move and a custom track compose without throwing', () => {
    const cfg = base(); cfg.motion.moves = [
      preset({ phase: 'loop', presetId: 'wave', duration: 1.5, play: { mode: 'repeat', times: 1 } }),
      { id: 't', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4, ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: 1 }, tracks: [{ path: 'axes.wght', from: 100, to: 900, hold: 0, cycleOffset: 0, delay: 0 } as any] }]
    expect(() => vtGlyphMotion(cfg, 1.0, 0, 6, 100)).not.toThrow()
  })
  it('no live move composes to identity', () => {
    const cfg = base(); cfg.motion.moves = [preset({ phase: 'in', duration: 0.5 })]
    expect(vtGlyphMotion(cfg, 2.0, 0, 6, 100)).toMatchObject({ dx: 0, dy: 0, scale: 1, opacity: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-preset-motion.unit.spec.ts -t "stacked moves"`
Expected: FAIL.

- [ ] **Step 3: Iterate moves in `presetMotion.ts`**

Add `vtPresetMoves(cfg): VtMove[]` (moves with `kind === 'preset'` and a preset id this studio can draw). Rewrite `presetTransform` to start an identity accumulator, compute `moveWindows(vtPresetMoves(cfg), W)` for `longestIn`, and for each preset move whose `movePhase` is non-null: evaluate the axis-preset delta (if `vtAxisPreset(move.phase, id)`) or drive the kinetic engine at the move's eased phase (build a one-slot spec `{ presetId, duration: move.duration, stagger: 0, ease: easeToEngineName(move.ease) }`, read the `UnitState`), then `foldUnit(acc, u, emPx)`:
```ts
function foldUnit(acc: VtGlyphMotion, u: UnitState, emPx: number): void {
  acc.dx += fin(u.dx, 0) * emPx; acc.dy += fin(u.dy, 0) * emPx; acc.rotate += fin(u.rotation, 0)
  acc.scale *= fin(u.scale, 1); acc.scaleX *= fin(u.scaleX, 1); acc.scaleY *= fin(u.scaleY, 1)
  acc.opacity *= clamp01(fin(u.opacity, 1)); acc.blur = Math.max(acc.blur, Math.max(0, fin(u.blur, 0) * emPx))
  if (u.axes) for (const [tag, v] of Object.entries(u.axes)) if (isNum(v) && v !== 0) acc.axes[tag] = (acc.axes[tag] ?? 0) + v
  if (u.clip && isNum(u.clip.amount) && clamp01(u.clip.amount) > (acc.clip?.amount ?? 0)) acc.clip = { side: u.clip.side, amount: clamp01(u.clip.amount) }
}
```
Start the accumulator at identity; return it. Re-implement `vtSlotPhase` as a thin `movePhase` wrapper for any importer, or delete it and update call sites.

- [ ] **Step 4: `applyMotion` reads `vtMoveTracks` with per-track ease/play**

In `motion.ts`, replace the `cfg.motion.tracks` walk with `vtMoveTracks(cfg)`. Per track, compute the raw cycle progress as today, then `easeSample(track.__ease, rawProgress)` for the value and use `track.__play.mode === 'backAndForth'` for pingpong direction and `track.__play.times` for loops. Feed `trackValue` a `linear` easing so ease is not double-applied. Colour tracks read progress the same way.

- [ ] **Step 5: Run the engine suite**

Run: `cd frontend && npx vitest run tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-motion.unit.spec.ts tests/unit/vectortype-color-tracks.unit.spec.ts`
Expected: the new block PASSES; update any old assertion that built `motion.in`/`motion.tracks` to build `motion.moves`. Re-run until green.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/presetMotion.ts app/lib/vectortype/motion.ts tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-motion.unit.spec.ts tests/unit/vectortype-color-tracks.unit.spec.ts
git commit -m "feat(vectortype): compose N moves in the glyph engine; tracks read their move's ease/play

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Track presets and target helpers speak moves

**Files:**
- Modify: `frontend/app/lib/vectortype/trackPresets.ts` (`build` → `VtMove`; `vtApplyTrackPreset`/`vtTrackPresetActive` on moves; each preset declares `dials`)
- Modify: `frontend/app/lib/vectortype/motion.ts` (`pruneStackTracks` walks moves)
- Test: extend `frontend/tests/unit/vectortype-track-presets.unit.spec.ts`

**Interfaces:**
- Produces: `interface VtTrackPresetDial { key: string; label: string; trackIndex: number; field: 'from' | 'to'; min: number; max: number; step: number }`; `VtTrackPreset` gains `dials: VtTrackPresetDial[]`; `vtApplyTrackPreset(cfg, id): VtMove[]`; `vtTrackPresetActive(cfg, id): boolean`; `pruneStackTracks(cfg): VtMove[]`.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to frontend/tests/unit/vectortype-track-presets.unit.spec.ts
import type { VtMove } from '~/lib/vectortype/moves'
it('applying a run-level preset adds one tracks move', () => {
  const cfg = cloneConfig(DEFAULT_CONFIG); cfg.motion.moves = []
  const moves = vtApplyTrackPreset(cfg, 'stretch-wave')
  const added = moves.find(m => m.kind === 'tracks' && m.presetId === 'stretch-wave') as VtMove | undefined
  expect(added).toBeTruthy(); expect(added!.tracks!.length).toBeGreaterThan(0)
  expect(vtTrackPresetActive({ ...cfg, motion: { ...cfg.motion, moves } } as any, 'stretch-wave')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-track-presets.unit.spec.ts -t "run-level preset"`
Expected: FAIL.

- [ ] **Step 3: Update `trackPresets.ts`**

- `vtApplyTrackPreset(cfg, id)`: build tracks via the preset's `build(ctx)`; if the preset is already active, return moves with that preset's move removed; else append `{ id: newMoveId(cfg.motion.moves), phase: 'loop', kind: 'tracks', presetId: id, duration: cfg.motion.duration, ease: { kind:'named', name: id === 'stretch-wave' ? 'natural' : 'none' }, play: { mode: (id.endsWith('-in') || id === 'spring-up') ? 'once' : 'repeat', times: 1 }, tracks }`.
- `vtTrackPresetActive(cfg, id)`: `cfg.motion.moves.some(m => m.kind === 'tracks' && m.presetId === id)`.
- Add `dials` to each preset (edit the produced tracks' `from`/`to`), e.g. `stretch-wave`: `[{ key:'amount', label:'Amount', trackIndex:0, field:'to', min:0.5, max:2.5, step:0.05 }]`.

- [ ] **Step 4: `pruneStackTracks(cfg): VtMove[]` in `motion.ts`**

Return a filtered moves array: per `tracks` move, drop tracks whose `trackLayerId` is gone; drop the move if it empties.

- [ ] **Step 5: Run the track/stretch suites**

Run: `cd frontend && npx vitest run tests/unit/vectortype-track-presets.unit.spec.ts tests/unit/vectortype-stretch-presets.unit.spec.ts`
Expected: PASS after updating old-shape assertions.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/trackPresets.ts app/lib/vectortype/motion.ts tests/unit/vectortype-track-presets.unit.spec.ts tests/unit/vectortype-stretch-presets.unit.spec.ts
git commit -m "feat(vectortype): track presets build moves; stack-track pruning walks moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full engine suite green

**Files:** remaining specs and helpers still on the old shape — `vectortype-stagger-presets`, `vectortype-config`, `vectortype-controls`, `thumbPreview.ts`, `presetMotion.ts` (`vtStaggerStarvedMoves`, `vtHasPreset`).

**Interfaces:** `vtHasPreset(cfg)` → `cfg.motion.moves.some(m => m.kind === 'preset')`; `vtStaggerStarvedSlots` → `vtStaggerStarvedMoves(cfg): VtMove[]`.

- [ ] **Step 1: Enumerate breakage**

Run: `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts 2>&1 | tail -40`

- [ ] **Step 2: Fix `thumbPreview.ts` and `presetMotion.ts` helpers**

Point `vtHasPreset`, `vtStaggerStarvedMoves`, `thumbPreview.ts`'s motion sample at `cfg.motion.moves` (sample the first preset move for a thumb).

- [ ] **Step 3: Update remaining specs to build moves**

Replace old-shape constructions with `motion.moves = [...]`; keep behavioural assertions.

- [ ] **Step 4: Whole suite + lib typecheck green**

Run: `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts`
Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep "lib/vectortype" | head`
Expected: PASS; no `lib/vectortype` type errors (surface `.vue` errors remain for Tasks 9–11).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype tests/unit/vectortype-*.unit.spec.ts
git commit -m "refactor(vectortype): remaining engine helpers and specs speak moves; suite green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: The neutral ease picker + the studio adapter interface

**Files:**
- Create: `frontend/app/lib/motion/studioAdapter.ts`
- Create: `frontend/app/components/vue-canvas/motion/EasePicker.vue` + `easePickerLogic.ts`
- Reuse: `frontend/app/components/vue-canvas/CurveEditor.vue`
- Test: `frontend/tests/unit/motion-ease-picker.unit.spec.ts`

**Interfaces:**
- `studioAdapter.ts` produces (the contract the neutral components consume; VT implements it in Task 9):
```ts
export interface MoveOffer { presetId: string; label: string; pitch: string; group: string; kind: 'preset' | 'tracks'; available: boolean; reason?: string }
export interface DialDef { key: string; label: string; min: number; max: number; step: number; group?: string }
export interface StudioMotionAdapter {
  moveOffers(phase: MovePhase): MoveOffer[]
  customDials(): DialDef[]
  dialAlreadyDriven(path: string): string | null
  presetLabel(id: string): string
  presetParamDials(id: string): DialDef[]     // a preset move's own knobs
  trackPresetDials(id: string): DialDef[]      // a tracks-preset move's knobs
}
```
- `EasePicker.vue`: props `modelValue: Ease`; emits `update:modelValue(Ease)`.
- `easePickerLogic.ts`: `easeFromCurveString(s): Ease`, `easeToCurveString(ease): string`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/motion-ease-picker.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { easeFromCurveString, easeToCurveString } from '~/components/vue-canvas/motion/easePickerLogic'
describe('ease picker logic', () => {
  it('maps a curve string to a bezier ease and back', () => {
    expect(easeFromCurveString('[0.87,0,0.13,1]')).toEqual({ kind: 'bezier', cps: [0.87, 0, 0.13, 1] })
    expect(easeToCurveString({ kind: 'bezier', cps: [0.87, 0, 0.13, 1] })).toBe('[0.87,0,0.13,1]')
  })
  it('a named ease opens the editor at ease-in-out', () => {
    expect(easeToCurveString({ kind: 'named', name: 'smooth' })).toBe('[0.42,0,0.58,1]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/motion-ease-picker.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write `studioAdapter.ts`**

```ts
// frontend/app/lib/motion/studioAdapter.ts
import type { MovePhase } from './moveTiming'
export interface MoveOffer { presetId: string; label: string; pitch: string; group: string; kind: 'preset' | 'tracks'; available: boolean; reason?: string }
export interface DialDef { key: string; label: string; min: number; max: number; step: number; group?: string }
export interface StudioMotionAdapter {
  moveOffers(phase: MovePhase): MoveOffer[]
  customDials(): DialDef[]
  dialAlreadyDriven(path: string): string | null
  presetLabel(id: string): string
  presetParamDials(id: string): DialDef[]
  trackPresetDials(id: string): DialDef[]
}
```

- [ ] **Step 4: Write `easePickerLogic.ts`**

```ts
// frontend/app/components/vue-canvas/motion/easePickerLogic.ts
import type { Ease } from '~/lib/motion/ease'
export function easeFromCurveString(s: string): Ease {
  try { const a = JSON.parse(s); if (Array.isArray(a) && a.length === 4 && a.every((v: unknown) => typeof v === 'number')) return { kind: 'bezier', cps: [a[0], a[1], a[2], a[3]] } } catch { /* fall through */ }
  return { kind: 'bezier', cps: [0.42, 0, 0.58, 1] }
}
export function easeToCurveString(ease: Ease): string {
  return ease.kind === 'bezier' ? JSON.stringify(ease.cps) : '[0.42,0,0.58,1]'
}
```

- [ ] **Step 5: Write `EasePicker.vue`**

```vue
<!-- frontend/app/components/vue-canvas/motion/EasePicker.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import CurveEditor from '~/components/vue-canvas/CurveEditor.vue'
import { EASE_LABELS, EASE_NAMES, easeGlyphPath, type Ease } from '~/lib/motion/ease'
import { easeFromCurveString, easeToCurveString } from './easePickerLogic'
const props = defineProps<{ modelValue: Ease }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: Ease): void }>()
const custom = ref(props.modelValue.kind === 'bezier')
const curveStr = computed(() => easeToCurveString(props.modelValue))
const glyph = (name: typeof EASE_NAMES[number]) => easeGlyphPath({ kind: 'named', name }, 40, 20)
const isActive = (name: string) => props.modelValue.kind === 'named' && props.modelValue.name === name
</script>
<template>
  <div class="w-56 rounded-lg border border-white/10 bg-[#161618] p-2">
    <div class="grid grid-cols-2 gap-1">
      <button v-for="name in EASE_NAMES" :key="name" type="button"
        class="flex items-center gap-2 rounded border p-1.5 text-left text-[11px]"
        :class="isActive(name) ? 'border-white/50 bg-white/[0.08] text-white' : 'border-white/[0.07] text-white/70 hover:bg-white/[0.05]'"
        @click="custom = false; emit('update:modelValue', { kind: 'named', name })">
        <svg viewBox="0 0 40 20" class="h-5 w-10 shrink-0"><path :d="glyph(name)" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        {{ EASE_LABELS[name] }}
      </button>
    </div>
    <button type="button" class="mt-1 w-full rounded border p-1.5 text-[11px]"
      :class="custom || modelValue.kind === 'bezier' ? 'border-white/50 bg-white/[0.08] text-white' : 'border-white/[0.07] text-white/70 hover:bg-white/[0.05]'"
      @click="custom = !custom">Custom curve</button>
    <div v-if="custom" class="mt-2">
      <CurveEditor :model-value="curveStr" @update:model-value="(s: string) => emit('update:modelValue', easeFromCurveString(s))" />
    </div>
  </div>
</template>
```

- [ ] **Step 6: Run the logic test**

Run: `cd frontend && npx vitest run tests/unit/motion-ease-picker.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/motion/studioAdapter.ts app/components/vue-canvas/motion/EasePicker.vue app/components/vue-canvas/motion/easePickerLogic.ts tests/unit/motion-ease-picker.unit.spec.ts
git commit -m "feat(motion): neutral ease picker + studio motion adapter interface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: The Vector Type adapter + the Add-move gallery

**Files:**
- Create: `frontend/app/lib/vectortype/motionAdapter.ts` (implements `StudioMotionAdapter`)
- Create: `frontend/app/components/vue-canvas/motion/MoveGallery.vue` (neutral; thumbs via scoped slot)
- Test: `frontend/tests/unit/vectortype-motion-adapter.unit.spec.ts`

**Interfaces:**
- `motionAdapter.ts`: `function vtMotionAdapter(cfg, axes, fontLabel): StudioMotionAdapter`. Assembles offers from `vtAxisOffers`, `KINETIC_PRESETS_BY_ID` (filtered to phase + `VT_PRESET_CAPABILITIES`) and `vtTrackPresetOffers`; groups per spec §4 (Letterform first). `customDials()` = the animatable dials grouped as `animatableGroups`. `dialAlreadyDriven(path)` scans `tracks` moves.
- `MoveGallery.vue`: props `{ adapter: StudioMotionAdapter }`; emits `add(move)`, `close()`; four tabs In · Loop · Out · Custom; a `#thumb` scoped slot so VT passes `PresetThumb`/`VectorTypeThumb`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/vectortype-motion-adapter.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { cloneConfig, DEFAULT_CONFIG } from '~/lib/vectortype/config'
import { vtMotionAdapter } from '~/lib/vectortype/motionAdapter'
import type { VtMove } from '~/lib/vectortype/moves'

describe('vt motion adapter', () => {
  it('in-phase offers are grouped, letterform first', () => {
    const offers = vtMotionAdapter(cloneConfig(DEFAULT_CONFIG), [], 'Inter').moveOffers('in')
    expect(offers[0]!.group).toBe('Letterform')
    expect(offers.some(o => o.presetId === 'fade-in')).toBe(true)
  })
  it('flags a dial already driven by another move', () => {
    const cfg = cloneConfig(DEFAULT_CONFIG)
    cfg.motion.moves = [{ id: 'a', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 }, tracks: [{ path: 'axes.wght', from: 100, to: 900, hold: 0, cycleOffset: 0, delay: 0 } as any] }] as VtMove[]
    const a = vtMotionAdapter(cfg, [], 'Inter')
    expect(a.dialAlreadyDriven('axes.wght')).toBeTruthy(); expect(a.dialAlreadyDriven('axes.wdth')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-motion-adapter.unit.spec.ts`
Expected: FAIL — no `motionAdapter`.

- [ ] **Step 3: Write `motionAdapter.ts`**

Implement `vtMotionAdapter(cfg, axes, fontLabel)` returning the `StudioMotionAdapter`. Pull offers from the existing tables and group per spec §4; `dialAlreadyDriven` walks `cfg.motion.moves` `tracks`; `presetParamDials` from `KINETIC_PRESETS_BY_ID[id].params`; `trackPresetDials` from `vtTrackPreset(id).dials`. Pure — no Vue import.

- [ ] **Step 4: Write `MoveGallery.vue`**

Modal anchored like the current picker, four tabs. Tiles from `adapter.moveOffers(phase)`, greyed with `o.reason` when unavailable. A `#thumb` scoped slot renders the preview (VT supplies its thumbs). Clicking an available tile emits `add(move)` built with the tab's phase, `DEFAULT_EASE` (or preset default), `DEFAULT_PLAY` (or `repeat` for a loop preset). The Custom tab lists `adapter.customDials()`; picking one emits a `custom` `tracks` move with one track over the dial range, in the phase chosen by a small In/Loop/Out toggle (default Loop).

- [ ] **Step 5: Run the adapter test**

Run: `cd frontend && npx vitest run tests/unit/vectortype-motion-adapter.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/vectortype/motionAdapter.ts app/components/vue-canvas/motion/MoveGallery.vue tests/unit/vectortype-motion-adapter.unit.spec.ts
git commit -m "feat(vectortype): motion adapter + neutral add-move gallery (thumbs via slot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: The move card and the Motion tab rebuild

**Files:**
- Create: `frontend/app/components/vue-canvas/motion/MoveCard.vue` (neutral; driven by the adapter)
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue` (the whole Motion-tab `v-else` block and the motion script)
- Modify: `frontend/app/lib/vectortype/controls.ts` (`Motion` group keeps stagger only)

**Interfaces:**
- `MoveCard.vue` props `{ move: VtMove; adapter: StudioMotionAdapter; open: boolean }`; emits `patch(Partial<VtMove>)`, `remove()`, `change()`, `toggle()`. It renders `EasePicker`, the Play control, and dials from `adapter.presetParamDials` / `adapter.trackPresetDials` / (custom) `adapter.customDials`.
- Surface holds `openMoveId: ref<string|null>`, `galleryOpen: ref<boolean>`, and `moveCards` computed = stored moves + a derived Blink card (when `blink.amount > 0`) + a derived Scatter card (when `scatter.spread > 0`).

- [ ] **Step 1: Write `MoveCard.vue`**

Collapsed: name (`vtMoveLabel(move, adapter.presetLabel)`), phase tag, ease glyph (`easeGlyphPath(move.ease, 24, 12)`), delete on hover, click toggles. Expanded: Length (number), Ease (glyph + label; click reveals `<EasePicker :model-value="move.ease" @update:model-value="v => emit('patch', { ease: v })" />`), Play (segmented `once`/`backAndForth`/`repeat` + `×N` for repeat; hidden when `move.phase !== 'loop'`), then dials. A "Change" button emits `change()`. For a derived Blink/Scatter card the parent passes a move-shaped stand-in and the card renders that effect's schema sliders (from `controls.ts`) instead of move dials — pass a `variant: 'blink' | 'scatter' | 'move'` prop.

- [ ] **Step 2: Rebuild the Motion tab in `VectorTypeSurface.vue`**

Replace the whole motion `<template v-else>` with:
1. A "Clip" `StudioSection` (Length, Frame rate, Letter-by-letter delay + order, shuffle seed when random) bound to `config.motion.duration`/`.fps`/`.stagger.*`.
2. A "Moves" `StudioSection` with an "Add move" button in the badge; `v-for` over `moveCards` → `<MoveCard>` (pass `adapter`); the empty state "Nothing moves yet." when `moveCards.length === 0`.
3. `<MoveGallery v-if="galleryOpen" :adapter="adapter">` with a `#thumb` slot providing `PresetThumb`/`VectorTypeThumb`, handling `@add` (push to `config.motion.moves`, or set `blink.amount`/`scatter.spread` for a Blink/Scatter offer) and `@close`.

Wire the script: `adapter = computed(() => vtMotionAdapter(config.value, fontAxes.value, fontLabel.value))`, `openMoveId`, `galleryOpen`, `moveCards`, `addMove`, `removeMove` (Blink/Scatter card → set amount/spread to 0), `patchMove`, `swapMoveViaGallery`. Delete `assignPreset`/`clearPreset`/`patchSpec`/`addTrack`/`removeTrack`/`retargetTrack`/`applyTrackPreset` and `pickerFor`/`trackPresetGroups`.

- [ ] **Step 3: Trim the `Motion` control group**

In `controls.ts`, the `Motion` group keeps only the three stagger controls (rendered in the Clip block). Blink/scatter sliders keep their keys/`when` gates and are rendered by `MoveCard` for the derived cards.

- [ ] **Step 4: Typecheck the surface**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "VectorTypeSurface|MoveCard|MoveGallery|EasePicker" | head`
Expected: no errors.

- [ ] **Step 5: Run the full vectortype suite**

Run: `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/components/vue-canvas/motion/MoveCard.vue app/components/vue-canvas/VectorTypeSurface.vue app/lib/vectortype/controls.ts
git commit -m "feat(vectortype): Motion tab rebuilt as a stack of move cards + clip block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: The band strip under the preview

**Files:**
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue` (strip between preview and prompt bar)
- Test: covered by `motion-move-timing` (`bandSpans`, Task 2); this task is render-only.

- [ ] **Step 1: Render the strip**

Use `bandSpans(config.motion.moves, config.motion.duration)` for the fractions. A 10px bar: amber `inFrac`, emerald `loopFrac`, amber `outFrac`, three labels ("In 0.6s", "Loop", "Out 0.5s"). Read-only. Colours match `Scene3DMotionTimeline.vue` (amber-400/70, emerald-400/60).

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep VectorTypeSurface | head`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add app/components/vue-canvas/VectorTypeSurface.vue
git commit -m "feat(vectortype): read-only band strip shows in/loop/out under the preview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Agent words over moves + Kinetic Type import

**Files:**
- Modify: `frontend/app/lib/vectortype/agentControls.ts` (three move words; `moves.<id>.*` addressing)
- Modify: `frontend/app/lib/vectortype/migrateKinetic.ts` (write moves)
- Test: extend `frontend/tests/unit/vectortype-agent-guidance.unit.spec.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to frontend/tests/unit/vectortype-agent-guidance.unit.spec.ts
it('agent guidance mentions moves', () => {
  const text = JSON.stringify(vtAgentControls(cloneConfig(DEFAULT_CONFIG), []))
  expect(text).toMatch(/move/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts -t "moves"`
Expected: FAIL.

- [ ] **Step 3: Add the move words**

Extend `vtAgentControls` with id-addressed move controls (add a move by preset id + phase; remove by id; set `moves.<id>.duration`/`.ease`/`.params.<key>`/`.tracks.<i>.from`), degrading to ignored when the id is gone (appearance-stack pattern). Update `migrateKinetic.ts` so the imported node's motion is a `moves` array (one preset move), and update its spec.

- [ ] **Step 4: Run the agent and migrate specs**

Run: `cd frontend && npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts tests/unit/vectortype-*.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/agentControls.ts app/lib/vectortype/migrateKinetic.ts tests/unit/vectortype-agent-guidance.unit.spec.ts
git commit -m "feat(vectortype): agent can add/remove/edit moves; Kinetic import writes moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: Live verification in the studio

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server and open the studio**

Run (background): `cd frontend && npm run dev`. Navigate to `http://127.0.0.1:3000`, start a blank project, add a `VectorType` node (`window.dispatchEvent(new CustomEvent('sailor:addNode',{detail:{nodeType:'VectorType'}}))`), click its Edit button, switch to Motion.

- [ ] **Step 2: Stack five moves**

Add Weight In (In), Fade In (In), Stretch Wave (Loop), a Custom slant move (Loop), turn Blink on. Confirm: tab badge reads 5; five cards; one card open at a time; band strip shows two amber ends + emerald middle.

- [ ] **Step 3: Edit an ease as a bezier**

Open a card's Ease row → Custom curve → drag a handle. Confirm the preview motion changes (`read_console_messages` for errors; screenshot before/after).

- [ ] **Step 4: Round-trip a document**

Close and reopen; confirm the five moves and their eases return. Import a pre-change fixture config via the node's Import settings; confirm the node-card thumbnail is unchanged and the moves list shows the converted moves.

- [ ] **Step 5: Capture proof and report**

Screenshot the stack + band strip. Report any defect; otherwise the feature is live-verified.

---

## Self-review notes

- **Neutral placement (the added requirement):** ease, play, phase/window/band math, the ease picker and the two move components all live in `lib/motion` / `components/vue-canvas/motion` and never import `lib/vectortype`; VT-specific behaviour enters through `StudioMotionAdapter` (Task 8) implemented by `vtMotionAdapter` (Task 9). A second parameter studio adopts by writing one adapter. ✅
- **Spec §1 (move type):** Tasks 1–3. Blink/scatter derived, not stored (architecture note + Task 10). ✅
- **Spec §2 (composition, windows, same-dial refusal):** Tasks 2, 5 (fold), 9 (`dialAlreadyDriven`). ✅
- **Spec §3 (clip block, list, one open, empty state, badge, strip):** Tasks 10–11. ✅
- **Spec §4 (gallery tabs/groups/letterform-first/custom dials):** Task 9. ✅
- **Spec §5 (ease picker):** Task 8. ✅
- **Spec §6 (engine/shared):** `easing.ts` (Task 1), neutral modules (1–2), `presetMotion`/`motion` (5), `trackPresets` (6), `config` (3–4), `controls` (10), `agentControls` (12). ✅
- **Spec §7 (migration + parity):** Task 4 unit conversion + Task 13 live round-trip. ✅
- **Spec §8 (edge cases):** unknown preset dropped (Task 3 merge), dead-layer prune (6), missing-axis custom greyed (9), ease clamp (1), out-after-in clamp (2). ✅
- **Spec §9 (testing):** unit across Tasks 1–12; browser in 13. ✅
- **Spec §10 (out of scope):** strip read-only (11), no saved-move presets, no per-move stagger; `Ease` now IS the shared type 3D can adopt later — an improvement over the spec's "separate for now", consistent with the neutral decision. ✅
- **Type consistency:** `Ease`/`Play`/`MoveTiming`/`movePhase`/`moveWindows`/`bandSpans` (neutral) and `VtMove`/`vtMoveTracks`/`vtMotionAdapter`/`StudioMotionAdapter`/`MoveOffer`/`DialDef` (typed) used with one signature throughout.
