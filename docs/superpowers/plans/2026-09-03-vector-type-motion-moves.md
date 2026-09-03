# Motion moves — shared core + Vector Type adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the moves-based Motion tab as a **shared core** (`lib/studio/moves/` + `components/vue-canvas/motion/moves/`) that any parameter studio can mount, and ship **Vector Type** as its first adapter — every preset, track, entrance and exit is one move card with an editable ease and a play mode, moves stack without limit, old documents convert on load.

**Architecture:** Follows `docs/superpowers/specs/2026-09-03-motion-moves-shared-core-design.md` (the authority) which amends `2026-09-03-vector-type-motion-moves-design.md` (behaviour). A **shared core** holds the studio-agnostic parts: the `Move` record (with `tracks` as the universal kind), the ten named eases plus custom bezier, play modes, phase windows, track composition, legacy conversion, and the panel (clip block, cards, gallery, ease picker, band strip). A **per-studio adapter** (`MovesAdapter<Cfg>`) supplies the specifics: Vector Type adds its `preset`/`blink`/`scatter` kinds, gallery groups, the old-document conversion, and the agent words. The shared core lives beside `lib/studio/track.ts` (the easing engine the stateless studios already share), not `lib/motion/` (the Frame/Compositor evaluator). Blink and Scatter keep their config blocks; their cards are derived, one source of truth.

**Tech Stack:** Nuxt 4 (Vue 3 + TypeScript), Vitest, `lib/motion/easing.ts`, `lib/spacetype/motion.ts`'s `bezierEase`, the existing `CurveEditor.vue`.

## Global Constraints

- **Shared core is studio-agnostic** — nothing under `lib/studio/moves/` or `components/vue-canvas/motion/moves/` may import `lib/vectortype`. Studio specifics enter only through `MovesAdapter<Cfg>`. Stagger (letter-by-letter) is Vector-Type-only and enters as an adapter `clipExtras` slot, never a core assumption.
- **Types are unprefixed and shared:** `Move`, `MoveEase`, `MoveEaseName`, `MovePlay`, `MoveTrack`, `MotionClip`, `MovesAdapter`. `VtMove` becomes a type alias narrowing `kind` to its three extra kinds. (Shared-core spec §1.)
- **Plain language in all UI copy** — short sentences, everyday words, no code names (`[[plain-language-for-specs-and-questions]]`).
- **Colour: action blue is the only accent; purple banned; amber only on taste chrome** (`[[sailor-colour-conventions]]`). Band strip In/Out amber, loop emerald.
- **A declared control must be read by a renderer** — every move field a card edits must reach the evaluator.
- **Old saved documents must render identically after conversion** — the parity test (Task 4) is a hard gate; the shared merge parity fixture covers Vector Type tracks.
- **`mergeConfig` is a strict rebuild** — every field type-checked; nothing trusted.
- **Shared-part tests live in `tests/unit/studio-moves-*.spec.ts`; Vector-Type parts keep `tests/unit/vectortype-*.unit.spec.ts`.**
- **Frequent commits** — one per task, message ending with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Isolate this work in a git worktree** (`superpowers:using-git-worktrees`) — main carries ~35 parallel sessions; do not build on the shared checkout.
- **Dev server is `127.0.0.1`** (`[[sailor-dev-server-localhost-426]]`). Reach the studio by adding a `VectorType` node and clicking Edit.

## Coordination note

The shared-core spec sequences this as item 3, after Shape Blend (stills) and a 3D finish, and names Shape Studio as consumer two, Gradient/Shader as later consumers. This plan builds the shared core so those consumers can mount it; it does not build them. If another session begins `lib/studio/moves/`, stop and reconcile — the core must have exactly one author.

---

## Shared-core module map (spec §1–§2)

**`frontend/app/lib/studio/moves/`** (studio-agnostic):
- `types.ts` — `Move`, `MoveTrack`, `MoveEase`, `MoveEaseName`, `MovePlay`, `MotionClip`.
- `ease.ts` — `EASE_NAMES`, `EASE_LABELS`, `DEFAULT_EASE`, `easeToEngineName`, `easeSample`, `easeGlyphPath`, `mergeEase`, `DEFAULT_PLAY`, `mergePlay`.
- `phase.ts` — `movePhase`, `moveWindows`, `bandSpans`.
- `tracks.ts` — `moveTracks(clip)` (flatten tagged), `applyMoveTracks(cfg, clip, t, io)`, `animatableTargetsFromControls(...)`.
- `merge.ts` — `mergeMove`, `mergeClip`, `convertLegacyTracks(tracks, presets)`.
- `adapter.ts` — `MovesAdapter<Cfg>`, `MoveKindDef`, `GalleryGroup`, `MoveOffer`, `AnimatableGroup`, `DialDef`.

**`frontend/app/components/vue-canvas/motion/moves/`** (studio-agnostic; thumbs adapter-supplied):
- `MovesPanel.vue`, `MoveCard.vue`, `MoveGallery.vue`, `EasePicker.vue` (+ `easePickerLogic.ts`), `MoveBandStrip.vue`.

**`frontend/app/lib/vectortype/`** (adapter):
- `movesAdapter.ts` — `vtMovesAdapter(cfg, axes, font)`; kinds `preset`/`blink`/`scatter`; gallery groups; conversion (slots/blink/scatter); agent words.
- `config.ts`, `presetMotion.ts`, `motion.ts`, `trackPresets.ts`, `agentControls.ts`, `migrateKinetic.ts`, `VectorTypeSurface.vue`, `controls.ts` — modified.

**`frontend/app/lib/motion/easing.ts`** — `resolveEase` gains `bezier(x1,y1,x2,y2)` (the one change outside the two new homes).

---

## Task 1: Shared ease + play vocabulary and the bezier name form

**Files:**
- Create: `frontend/app/lib/studio/moves/types.ts`, `frontend/app/lib/studio/moves/ease.ts`
- Modify: `frontend/app/lib/motion/easing.ts` (add `bezier(...)` to `resolveEase`)
- Test: `frontend/tests/unit/studio-moves-ease.unit.spec.ts`

**Interfaces (spec §1):**
- `types.ts`: `MoveEase = { kind:'named'; name:MoveEaseName } | { kind:'bezier'; cps:[number,number,number,number] }`; `MoveEaseName = 'none'|'smooth'|'natural'|'slowDown'|'accelerate'|'overshoot'|'elastic'|'bounce'|'swing'|'steps'`; `MovePlay = { mode:'once'|'backAndForth'|'repeat'; times:number }`; `MoveTrack = { path:string; from:number; to:number; hold?:number; cycleOffset?:number; delay?:number; fromColor?:string; toColor?:string; mix?:string }`; `Move = { id:string; phase:'in'|'loop'|'out'; kind:string; presetId?:string; duration:number; ease:MoveEase; play:MovePlay; params?:Record<string,number>; tracks?:MoveTrack[] }`; `MotionClip = { moves:Move[]; duration:number; fps:number }`.
- `ease.ts`: `EASE_NAMES`, `EASE_LABELS`, `DEFAULT_EASE`, `easeToEngineName(ease)`, `easeSample(ease,t)`, `easeGlyphPath(ease,w,h)`, `mergeEase(raw)`, `DEFAULT_PLAY`, `mergePlay(raw)`.

- [ ] **Step 1: Create the worktree**

Run: (via `superpowers:using-git-worktrees`) create an isolated worktree off `main` named `motion-moves-core`. All subsequent paths are inside it.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/tests/unit/studio-moves-ease.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveEase } from '~/lib/motion/easing'
import { DEFAULT_EASE, DEFAULT_PLAY, EASE_NAMES, easeGlyphPath, easeSample, easeToEngineName, mergeEase, mergePlay } from '~/lib/studio/moves/ease'
import type { MoveEase } from '~/lib/studio/moves/types'

describe('studio moves ease', () => {
  it('every named ease resolves with fixed endpoints', () => {
    for (const name of EASE_NAMES) { const fn = resolveEase(easeToEngineName({ kind: 'named', name })); expect(fn(0)).toBeCloseTo(0, 6); expect(fn(1)).toBeCloseTo(1, 6) }
  })
  it('smooth eases out; none is linear', () => {
    expect(easeSample({ kind: 'named', name: 'smooth' }, 0.25)).toBeGreaterThan(0.25)
    expect(easeSample({ kind: 'named', name: 'none' }, 0.4)).toBeCloseTo(0.4, 6)
  })
  it('a bezier ease round-trips through the engine name', () => {
    const ease: MoveEase = { kind: 'bezier', cps: [0.87, 0, 0.13, 1] }
    const fn = resolveEase(easeToEngineName(ease))
    expect(fn(0.25)).toBeLessThan(0.25); expect(fn(0)).toBeCloseTo(0, 4); expect(fn(1)).toBeCloseTo(1, 4)
  })
  it('the glyph path is monotone in x', () => {
    const xs = [...easeGlyphPath({ kind: 'named', name: 'smooth' }, 40, 20).matchAll(/[ML] ([\d.]+)/g)].map(m => Number(m[1]))
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1])
  })
  it('mergeEase and mergePlay reject junk and clamp', () => {
    expect(mergeEase(undefined)).toEqual(DEFAULT_EASE)
    expect(mergeEase({ kind: 'bezier', cps: [2, 5, -3, -9] })).toEqual({ kind: 'bezier', cps: [1, 1.6, 0, -0.6] })
    expect(mergePlay(undefined)).toEqual(DEFAULT_PLAY)
    expect(mergePlay({ mode: 'repeat', times: 99 })).toEqual({ mode: 'repeat', times: 20 })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-moves-ease.unit.spec.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Add the bezier form to `resolveEase`**

In `frontend/app/lib/motion/easing.ts`, add `import { bezierEase } from '~/lib/spacetype/motion'` and, inside `resolveEase` after the `none`/`linear` line:
```ts
  const bez = /^bezier\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)$/.exec(name)
  if (bez) { const cps: [number, number, number, number] = [Number(bez[1]), Number(bez[2]), Number(bez[3]), Number(bez[4])]; return (t: number) => bezierEase(t, cps) }
```

- [ ] **Step 5: Write `types.ts` and `ease.ts`**

`types.ts` — the interfaces above. `ease.ts` — port the implementation from the shared-core spec §1: `EASE_NAMES` (smooth first), `EASE_LABELS`, `DEFAULT_EASE = { kind:'named', name:'smooth' }`, the `ENGINE_NAME` map (none→none, smooth→power2.out, natural→sine.inOut, slowDown→power3.out, accelerate→power3.in, overshoot→back.out, elastic→elastic.out, bounce→bounce.out, swing→back.inOut, steps→steps(6)), `easeToEngineName` (bezier→`bezier(a,b,c,d)`), `easeSample` (via `resolveEase`), `easeGlyphPath` (24 samples, y clamped 0..1, format `M/L x y`), `mergeEase` (clamp x 0..1, y −0.6..1.6), `DEFAULT_PLAY = { mode:'once', times:1 }`, `mergePlay` (mode in the three, times 1..20 rounded).

*(Reference implementation is the code in the previous revision of this plan's Task 1 and Task 2, with the module renamed and the `Vt`/`Ease` names replaced by `Move`-prefixed / unprefixed shared names.)*

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/studio-moves-ease.unit.spec.ts && npx vitest run tests/unit/motion-*.unit.spec.ts`
Expected: PASS (new spec + Compositor easing unaffected).

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/studio/moves/types.ts app/lib/studio/moves/ease.ts app/lib/motion/easing.ts tests/unit/studio-moves-ease.unit.spec.ts
git commit -m "feat(studio-moves): shared move/ease/play types + bezier ease name form

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Shared phase / window / band math

**Files:**
- Create: `frontend/app/lib/studio/moves/phase.ts`
- Test: `frontend/tests/unit/studio-moves-phase.unit.spec.ts`

**Interfaces:** `movePhase(move, gt, clip, longestIn): number | null`; `moveWindows(moves, clip): { longestIn; windows }`; `bandSpans(moves, clip): { inFrac; loopFrac; outFrac }`. Rules per Vector Type spec §2 (In `[0,dur]`, Out `[clip−dur, clip]` no earlier than longestIn, Loop whole clip phase-0 at longestIn; play shapes each pass, ease applied to pass progress).

- [ ] **Step 1: Write the failing test**

Same assertions as the previous revision's `motion-move-timing` test, importing from `~/lib/studio/moves/phase` and `~/lib/studio/moves/ease` (for `DEFAULT_PLAY`) and typing against `~/lib/studio/moves/types` `Move` narrowed to the timing fields. Cases: longest-in sets loop phase 0; in live only in window; out at the end; loop wraps; back-and-forth returns to 0; band spans `{0.25, 0.625, 0.125}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-moves-phase.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write `phase.ts`**

Port `moveWindows` / `movePhase` / `bandSpans` from the previous revision's `moveTiming.ts`, typed against the shared `Move` (read only `phase`/`duration`/`ease`/`play`), importing `easeSample` from `./ease`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/studio-moves-phase.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/studio/moves/phase.ts tests/unit/studio-moves-phase.unit.spec.ts
git commit -m "feat(studio-moves): phase windows + band spans (stacked ins/outs, loop at longest in)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Shared merge, track flattening, and legacy conversion

**Files:**
- Create: `frontend/app/lib/studio/moves/merge.ts`, `frontend/app/lib/studio/moves/tracks.ts`, `frontend/app/lib/studio/moves/adapter.ts`
- Test: `frontend/tests/unit/studio-moves-merge.unit.spec.ts`

**Interfaces (spec §1):**
- `merge.ts`: `mergeMove(raw, mergeTrackFn?): Move | undefined`; `mergeClip(raw, mergeTrackFn?): MotionClip`; `convertLegacyTracks(tracks, matchPreset): Move[]` (matching preset → one tracks move; rest → Custom moves; `linear`→none/once, `easeinout`→natural/once, `pingpong`→none/backAndForth, `loops`→times, phase loop).
- `tracks.ts`: `moveTracks(clip): (MoveTrack & { __ease; __play })[]`; `applyMoveTracks(cfg, clip, t, io)` where `io = { getByPath, setByPath, setByIdPath }`; `animatableTargetsFromControls(controls, cfg, expandLayerKey)`.
- `adapter.ts`: the `MovesAdapter<Cfg>` interface + `MoveKindDef`, `GalleryGroup`, `MoveOffer`, `AnimatableGroup`, `DialDef` (spec §1 adapter block, §2 gallery/animatable types).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/studio-moves-merge.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { convertLegacyTracks, mergeMove } from '~/lib/studio/moves/merge'

describe('studio moves merge', () => {
  it('mergeMove drops a move with no presetId and no tracks', () => {
    expect(mergeMove({ id: 'a', phase: 'loop', kind: 'preset' })).toBeUndefined()
  })
  it('a pingpong legacy track becomes a custom back-and-forth move', () => {
    const moves = convertLegacyTracks([{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2 }], () => null)
    expect(moves).toHaveLength(1)
    expect(moves[0]!.kind).toBe('tracks'); expect(moves[0]!.presetId).toBe('custom')
    expect(moves[0]!.play).toEqual({ mode: 'backAndForth', times: 2 }); expect(moves[0]!.ease).toEqual({ kind: 'named', name: 'none' })
  })
  it('a matched preset collapses its tracks to one move', () => {
    const moves = convertLegacyTracks([{ path: 'layout.stretch', from: 1, to: 1.5, easing: 'linear', loops: 1 }], (t) => t.some(x => x.path === 'layout.stretch') ? 'stretch-wave' : null)
    expect(moves).toHaveLength(1); expect(moves[0]!.presetId).toBe('stretch-wave')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/studio-moves-merge.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write `adapter.ts`, `merge.ts`, `tracks.ts`**

`adapter.ts` — the interface block from spec §1/§2. `merge.ts` — `mergeMove` (port from previous revision, `Move`-typed, `kind` a string defaulting `'tracks'`/`'preset'`), `mergeClip`, `convertLegacyTracks` (the legacy ease/play map + preset matcher parameterised via `matchPreset(tracks)`). `tracks.ts` — `moveTracks` (flatten tagging `__ease`/`__play`), `applyMoveTracks` (clone cfg, per track compute raw progress, `easeSample(__ease, p)`, `__play` for direction/loops, write via `io.setByPath`/`setByIdPath`; colour tracks read progress), `animatableTargetsFromControls`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/studio-moves-merge.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/studio/moves/merge.ts app/lib/studio/moves/tracks.ts app/lib/studio/moves/adapter.ts tests/unit/studio-moves-merge.unit.spec.ts
git commit -m "feat(studio-moves): merge, track flattening/apply, legacy conversion, adapter interface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Vector Type config on the shared clip + old-document conversion

**Files:**
- Modify: `frontend/app/lib/vectortype/config.ts` (`VtMotionConfig.moves: Move[]`; `VtMotionTrack` drops `easing`/`loops`; `mergeMotion` uses `mergeClip` + `convertLegacyTracks`)
- Modify: `frontend/app/lib/vectortype/trackPresets.ts` (`vtMatchLegacyTrackPreset`)
- Test: `frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts`

**Interfaces:** `VtMove = Move & { kind: 'preset' | 'tracks' | 'blink' | 'scatter' }` (alias narrowing). `mergeMotion` converts old slots+tracks via `convertLegacyTracks(tracks, vtMatchLegacyTrackPreset)` plus the slot→preset-move and blink/scatter handling; new shape via `mergeClip`.

- [ ] **Step 1: Write the failing test** — the previous revision's migration test (slots→moves, pingpong→custom back-and-forth, new-shape round-trips empty), importing `Move` from `~/lib/studio/moves/types`.

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/vectortype-moves-migrate.unit.spec.ts`

- [ ] **Step 3: Implement** — repoint `config.ts` at the shared types/merge; `VtMotionConfig.moves: Move[]`; drop track `easing`/`loops`; `mergeMotion` builds moves via `mergeClip` (new) or slot conversion + `convertLegacyTracks` (old); blink/scatter stay their blocks. Add `vtMatchLegacyTrackPreset` + `PRESET_SIGNATURE_PATHS` to `trackPresets.ts`. Shim `motion.ts` reads to `moveTracks(cfg.motion)` so the suite compiles (full rewrite in Task 5).

- [ ] **Step 4: Run to verify pass.** `cd frontend && npx vitest run tests/unit/vectortype-moves-migrate.unit.spec.ts`

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/config.ts app/lib/vectortype/trackPresets.ts app/lib/vectortype/motion.ts tests/unit/vectortype-moves-migrate.unit.spec.ts
git commit -m "feat(vectortype): motion config on the shared MotionClip; convert old documents on load

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Vector Type adapter + N-move composition in the glyph engine

**Files:**
- Create: `frontend/app/lib/vectortype/movesAdapter.ts`
- Modify: `frontend/app/lib/vectortype/presetMotion.ts` (iterate moves via `movePhase`, fold units), `motion.ts` (`applyMotion` via `applyMoveTracks`), `trackPresets.ts` (`build`→`Move`, `vtApplyTrackPreset`/`vtTrackPresetActive` on moves, `dials`)
- Test: extend `frontend/tests/unit/vectortype-preset-motion.unit.spec.ts`; extend `vectortype-track-presets`

**Interfaces:** `vtMovesAdapter(cfg, axes, fontLabel): MovesAdapter<VectorTypeConfig>` — `kinds` = `{ preset, blink, scatter }` (each a `MoveKindDef` with a card-body hint + evaluator), `gallery(cfg, phase)` groups (Letterform first), `animatable(cfg)`, `availability(cfg, candidate)` (missing axis / needs layer / dial already driven), `clipExtras` = the Letter-by-letter rows. Composition rule per Vector Type spec §2 (add dx/dy/rotate/blur, multiply scale/opacity, axes add per tag, clip max).

- [ ] **Step 1: Write the failing test** — the previous revision's `stacked moves` block (two ins compose; preset+custom track composes; no live move → identity), plus the adapter test (in-phase offers grouped Letterform-first; `availability` flags an already-driven dial). Import `Move` from the shared types.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `presetTransform` folds every live `preset`/`blink`/`scatter` move (via the adapter `kinds` evaluators) using `movePhase`; `applyMotion` = `applyMoveTracks(cfg, cfg.motion, t, vtIo)` where `vtIo` wraps `getByPath`/`setByPath`/`setByIdPath`; `trackPresets.build` returns a `Move`, `vtApplyTrackPreset(cfg,id): Move[]`, `vtTrackPresetActive`, each preset gains `dials`. Write `vtMovesAdapter`.

- [ ] **Step 4: Run to verify pass.** `cd frontend && npx vitest run tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-track-presets.unit.spec.ts tests/unit/vectortype-motion.unit.spec.ts tests/unit/vectortype-color-tracks.unit.spec.ts`

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/movesAdapter.ts app/lib/vectortype/presetMotion.ts app/lib/vectortype/motion.ts app/lib/vectortype/trackPresets.ts tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-track-presets.unit.spec.ts
git commit -m "feat(vectortype): moves adapter (preset/blink/scatter) + N-move glyph composition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full Vector Type engine suite green

**Files:** remaining specs/helpers on the old shape — `vectortype-stagger-presets`, `vectortype-config`, `vectortype-controls`, `thumbPreview.ts`, `presetMotion.ts` (`vtHasPreset`, `vtStaggerStarvedMoves`), `motion.ts` (`pruneStackTracks` → `Move[]`).

- [ ] **Step 1: Enumerate.** `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts 2>&1 | tail -40`
- [ ] **Step 2: Fix helpers** — point `vtHasPreset`/`vtStaggerStarvedMoves`/`thumbPreview` at `cfg.motion.moves`; `pruneStackTracks(cfg): Move[]`.
- [ ] **Step 3: Update remaining specs** to build `motion.moves`; keep behavioural assertions.
- [ ] **Step 4: Green + lib typecheck.** `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts` ; `npx vue-tsc --noEmit 2>&1 | grep -E "lib/vectortype|lib/studio/moves" | head` (surface `.vue` errors remain for Tasks 7–9).
- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype tests/unit/vectortype-*.unit.spec.ts
git commit -m "refactor(vectortype): remaining engine helpers and specs speak moves; suite green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Shared panel — ease picker, band strip, gallery

**Files:**
- Create: `frontend/app/components/vue-canvas/motion/moves/EasePicker.vue` + `easePickerLogic.ts`, `MoveBandStrip.vue`, `MoveGallery.vue`
- Test: `frontend/tests/unit/studio-moves-easepicker.unit.spec.ts`

**Interfaces:** `EasePicker` props `modelValue: MoveEase`, emits `update:modelValue`. `MoveBandStrip` props `{ moves, clip }`, uses `bandSpans`. `MoveGallery` props `{ adapter, cfg }`, emits `add(move)`/`close()`, four tabs, `#thumb` scoped slot; duplicate-dial refusal from `adapter.availability`.

- [ ] **Step 1: Write the failing test** — `easePickerLogic` map/round-trip (as the previous revision).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Write `easePickerLogic.ts`, `EasePicker.vue`** (named grid from `EASE_NAMES`/`easeGlyphPath` + Custom curve via `CurveEditor`), **`MoveBandStrip.vue`** (amber/emerald/amber from `bandSpans`, read-only labels), **`MoveGallery.vue`** (tabs, `adapter.gallery(cfg, phase)` groups, greyed with `availability` reason, Custom tab from `adapter.animatable(cfg)` + In/Loop/Out toggle).
- [ ] **Step 4: Run to verify pass.** `cd frontend && npx vitest run tests/unit/studio-moves-easepicker.unit.spec.ts`
- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/components/vue-canvas/motion/moves/EasePicker.vue app/components/vue-canvas/motion/moves/easePickerLogic.ts app/components/vue-canvas/motion/moves/MoveBandStrip.vue app/components/vue-canvas/motion/moves/MoveGallery.vue tests/unit/studio-moves-easepicker.unit.spec.ts
git commit -m "feat(studio-moves): shared ease picker, band strip, add-move gallery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Shared panel — MovesPanel + MoveCard

**Files:**
- Create: `frontend/app/components/vue-canvas/motion/moves/MovesPanel.vue`, `MoveCard.vue`

**Interfaces:** `MovesPanel` props `{ clip: MotionClip (v-model), adapter, cfg }` — the clip block (Length, Frame rate, `adapter.clipExtras`), the moves list, Add move, empty state, the band strip. `MoveCard` props `{ move, adapter, cfg, open }`, emits `patch`/`remove`/`change`/`toggle` — collapsed row (label, phase tag, ease glyph, delete-on-hover) and expanded settings (Length, Ease via `EasePicker`, Play segmented hidden on in/out, dials from `adapter.kinds[move.kind].card` or the track/custom dials). One card open at a time.

- [ ] **Step 1: Write `MoveCard.vue`** — as the previous revision's card, driven by the adapter; a `blink`/`scatter` kind renders that effect's schema sliders via `adapter.kinds`.
- [ ] **Step 2: Write `MovesPanel.vue`** — clip block + moves list (`moveCards` = clip moves + derived Blink/Scatter cards) + Add move (opens `MoveGallery`) + empty state + `MoveBandStrip`.
- [ ] **Step 3: Typecheck.** `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "motion/moves" | head` → no errors.
- [ ] **Step 4: Commit**

```bash
cd frontend && git add app/components/vue-canvas/motion/moves/MovesPanel.vue app/components/vue-canvas/motion/moves/MoveCard.vue
git commit -m "feat(studio-moves): MovesPanel + MoveCard (adapter-driven, one card open)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Mount the panel in Vector Type

**Files:**
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue` (Motion tab → `<MovesPanel>` with `vtMovesAdapter`, thumbs via `#thumb`), `frontend/app/lib/vectortype/controls.ts` (`Motion` group keeps stagger only)

- [ ] **Step 1: Replace the Motion `<template v-else>`** with `<MovesPanel :clip="config.motion" :adapter="adapter" :cfg="config"><template #thumb="{ offer }">…PresetThumb/VectorTypeThumb…</template></MovesPanel>`, `adapter = computed(() => vtMovesAdapter(config.value, fontAxes.value, fontLabel.value))`. Delete the old slot buttons, Presets/Tracks sections, Duration/FPS block, coexistence prose, and the `assignPreset`/`addTrack`/etc handlers.
- [ ] **Step 2: Trim the `Motion` control group** in `controls.ts` to stagger only (rendered by `clipExtras`); blink/scatter sliders keep their keys/gates for the derived cards.
- [ ] **Step 3: Typecheck.** `cd frontend && npx vue-tsc --noEmit 2>&1 | grep VectorTypeSurface | head` → no errors.
- [ ] **Step 4: Full vectortype suite.** `cd frontend && npx vitest run tests/unit/vectortype-*.unit.spec.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/components/vue-canvas/VectorTypeSurface.vue app/lib/vectortype/controls.ts
git commit -m "feat(vectortype): mount the shared MovesPanel; Motion tab is now a stack of moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Agent words + Kinetic Type import

**Files:**
- Modify: `frontend/app/lib/vectortype/agentControls.ts`, `frontend/app/lib/vectortype/migrateKinetic.ts`
- Test: extend `frontend/tests/unit/vectortype-agent-guidance.unit.spec.ts`

- [ ] **Step 1: Write the failing test** — guidance mentions moves.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — id-addressed move words (add by preset id + phase; remove by id; set `moves.<id>.duration`/`.ease`/`.params.<key>`/`.tracks.<i>.from`), degrading to ignored when the id is gone; `migrateKinetic` writes a `moves` array.
- [ ] **Step 4: Run to verify pass.** `cd frontend && npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts tests/unit/vectortype-*.unit.spec.ts`
- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vectortype/agentControls.ts app/lib/vectortype/migrateKinetic.ts tests/unit/vectortype-agent-guidance.unit.spec.ts
git commit -m "feat(vectortype): agent add/remove/edit moves; Kinetic import writes moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Live verification in the studio

**Files:** none (verification only).

- [ ] **Step 1:** `cd frontend && npm run dev` (background); open `http://127.0.0.1:3000`, blank project, add a `VectorType` node, Edit, Motion tab.
- [ ] **Step 2:** Stack five moves — Weight In (In), Fade In (In), Stretch Wave (Loop), a Custom slant (Loop), turn Blink on. Confirm: badge reads 5; five cards; one open at a time; band strip shows two amber ends + emerald middle.
- [ ] **Step 3:** Edit an ease as a bezier; confirm the preview motion changes (`read_console_messages`; screenshot before/after).
- [ ] **Step 4:** Close/reopen — moves and eases return. Import a pre-change fixture config; confirm the node-card thumbnail is unchanged and the moves list shows converted moves.
- [ ] **Step 5:** Screenshot the stack + strip; report defects or confirm live-verified. Then finish the branch (`superpowers:finishing-a-development-branch`).

---

## Self-review notes

- **Shared-core spec §1 (paths, types):** `lib/studio/moves/` modules (Tasks 1–3), unprefixed `Move`/`MoveEase`/`MovePlay`/`MoveTrack`/`MotionClip`, `VtMove` an alias (Task 4). ✅
- **Spec §2 (shared panel):** `components/vue-canvas/motion/moves/` (Tasks 7–8); stagger via `clipExtras` (Task 5 adapter, Task 8 clip block). ✅
- **Spec §3 (VT adapter):** `vtMovesAdapter` kinds/gallery/conversion/agent (Tasks 5, 4, 10); test files split (`studio-moves-*` vs `vectortype-*`). ✅
- **VT design §2 (composition/windows/refusal):** Tasks 2, 5, 7 (`availability`). ✅ · **§3 (panel):** Tasks 7–9. ✅ · **§4 (gallery):** Tasks 3 (types), 5 (groups), 7 (component). ✅ · **§5 (ease picker):** Task 7. ✅ · **§7 (migration + parity):** Tasks 3–4 + Task 11 round-trip; shared `studio-moves-merge` parity fixture. ✅ · **§8 (edge cases):** unknown preset dropped (Task 3), dead-layer prune (Task 6), missing-axis greyed (Task 5 availability), ease clamp (Task 1), out-after-in (Task 2). ✅
- **Consumers two+ (spec §4–§5):** not built here; the adapter interface and shared panel are shaped for Shape Studio (no extra kinds, Custom-only gallery) and Gradient/Shader (`convertLegacyTracks`, layer-relative paths). ✅
- **Type consistency:** shared `Move`/`MoveEase`/`MovePlay`/`MoveTrack`/`MotionClip`/`MovesAdapter`/`movePhase`/`moveWindows`/`bandSpans`/`applyMoveTracks`/`convertLegacyTracks`; VT `VtMove` alias, `vtMovesAdapter`, `vtMatchLegacyTrackPreset`. One signature each.
