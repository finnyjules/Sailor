# Motion timeline (DialKit feel, native) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the moves card-stack with a bottom-docked **timeline** (DialKit's interaction model, Sailor's skin): each move is a draggable band with its ease drawn inside, a scrubable ruler/playhead, and the selected move's controls in the right panel. In/Out/Loop move off the band into toggles.

**Architecture:** A move swaps its `phase` enum for a start time `at` plus a `loop` flag (and optional `bounce`), and `play` is retired. The window math in `lib/studio/moves/phase.ts` becomes `at`-anchored. Migration converts 2026-09-03 documents identically. A new studio-agnostic `MoveTimeline.vue` (built on drag math lifted from 3D Studio into `lib/studio/moves/timelineDrag.ts`) replaces the read-only band strip; `MovesPanel.vue` shows the selected move's controls or the clip settings; `MoveCard.vue` is retired. Vector Type is the consumer; Shape/Gradient/Shader inherit the component later.

**Tech Stack:** Nuxt 4 (Vue 3 + TS), Vitest, the existing `lib/studio/moves` core and `lib/motion/easing`.

## Global Constraints

- **Studio-agnostic core:** nothing under `lib/studio/moves/` or `components/vue-canvas/motion/moves/` imports `lib/vectortype`. Studio specifics enter through the `MovesAdapter` and slots. This holds for the new timeline too.
- **Render-parity is the hard gate:** a 2026-09-03 document must render identically after the model change. Two parity tests (a 09-03-shape fixture and a pre-moves fixture), three frames each through `vtGlyphMotion`, equal within 1e-9.
- **Do NOT touch 3D Studio's motion.** `Scene3DMotionTimeline.vue` and `lib/scene3d/motion/timeline.ts` stay; the shared `timelineDrag.ts` is a NEW generalization for the `Move` shape, not a repoint of 3D.
- **Plain language in UI copy** (`[[plain-language-for-specs-and-questions]]`). **Action blue only accent; amber/emerald on the timeline bands matching `Scene3DMotionTimeline`** (`[[sailor-colour-conventions]]`).
- **A declared control must be read by a renderer.** Every toggle/dial the panel shows must reach the engine.
- **Isolate in a git worktree** off current `main` (heavy parallel activity). Symlink `node_modules`, run `nuxi prepare` for the worktree's own `.nuxt` (do NOT symlink `.nuxt` if a dev server will run; symlink is fine for vitest only — a live dev server needs its own).
- **Dev server is `127.0.0.1`** (`[[sailor-dev-server-localhost-426]]`); the worktree shares `node_modules/.vite` with main, so a first browser load may 504 (Outdated Optimize Dep) and clears on one reload (`[[nitro-dev-bundle-stale-pnpm-path]]` neighbourhood).
- **`vectortype-stretch` flakes under parallel test load** — 78/78 standalone (`[[vitest-counts-lie-under-load]]`); not a regression.
- **Frequent commits**, one per task, ending:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File map

**`lib/studio/moves/` (shared, modified/created):**
- `types.ts` — `Move`: add `at`, `loop`, optional `bounce`; remove `phase`, `play`. Keep `MovePlay` type EXPORTED (migration reads it). `MoveTrack`, `MoveEase`, `MotionClip` unchanged.
- `phase.ts` — `moveWindows`/`movePhase` rewritten `at`-anchored (drop `longestIn` param); delete `bandSpans`.
- `tracks.ts` — `TaggedMoveTrack`/`trackRawProgress` read the move's `loop`/`bounce`/`at`/`duration` instead of `play`.
- `merge.ts` — `mergeMove`/`mergeClip`/`convertLegacyTracks` emit + convert `at`/`loop`/`bounce`; accept the 09-03 `phase`/`play` shape.
- `direction.ts` (new) — `moveDirection(presetId, pairs)`, `flipDirection(presetId, pairs)`, the `PresetPairs` type.
- `timelineDrag.ts` (new) — pure band drag math over `{ at, duration }`: `moveBand`, `resizeBand`, `snapSeconds`, `bandRect`.
- `adapter.ts` — `MovesAdapter` gains `presetPairs?: PresetPairs`; `derivedMoves` markers get `at: 0, loop: true`.

**`components/vue-canvas/motion/moves/` (shared):**
- `MoveTimeline.vue` (new) — ruler, playhead, bands, drag, scrub, zoom.
- `MovesPanel.vue` — reworked to selected-move / clip-settings; hosts the retired `MoveCard` body inline.
- `MoveGallery.vue` — drop In/Loop/Out tabs; one grouped list by move type.
- `MoveCard.vue` — retired (deleted; its expanded body layout moves into `MovesPanel`).
- `MoveBandStrip.vue` — deleted (replaced by `MoveTimeline`).

**`lib/vectortype/` + surface:**
- `config.ts` (`VtMove` alias drops `phase`, gains `at`/`loop`/`bounce`), `presetMotion.ts`, `motion.ts`, `movesAdapter.ts` (pairs, derivedMoves, gallery grouping), `migrateKinetic.ts`, `VectorTypeSurface.vue`.

---

## Task 1: The `at`/`loop`/`bounce` model + window math

**Files:** Modify `lib/studio/moves/types.ts`, `phase.ts`, `tracks.ts`. Create `lib/studio/moves/direction.ts`. Test: `tests/unit/studio-moves-phase.unit.spec.ts` (rewrite), `tests/unit/studio-moves-direction.unit.spec.ts` (new).

**Interfaces produced:**
- `Move` (types.ts): `{ id; kind: string; presetId?; at: number; duration: number; loop: boolean; bounce?: boolean; ease: MoveEase; params?; tracks? }`. `MovePlay` stays exported for migration.
- `phase.ts`: `moveWindows(moves, clip): { move; start; end }[]` (no `longestIn`); `movePhase(move, gt, clip): number | null`.
- `direction.ts`: `type PresetPairs = Record<string, string>` (id → its opposite-direction id, symmetric); `moveDirection(presetId, pairs): 'in'|'out'|null`; `flipDirection(presetId, pairs): string`.

- [ ] **Step 1: Create the worktree** (via `superpowers:using-git-worktrees`) off `main`, named `motion-timeline`. Symlink `node_modules`; run `npx nuxi prepare` for its own `.nuxt`. Verify one existing spec runs.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/unit/studio-moves-phase.unit.spec.ts (REPLACE the old phase spec)
import { describe, expect, it } from 'vitest'
import { movePhase, moveWindows } from '~/lib/studio/moves/phase'
import type { Move } from '~/lib/studio/moves/types'
const mk = (o: Partial<Move>): Move => ({ id: 'x', kind: 'preset', presetId: 'p', at: 0, duration: 1, loop: false, ease: { kind: 'named', name: 'none' }, ...o })
describe('at-anchored windows', () => {
  it('a transition is live only inside [at, at+duration]', () => {
    const m = mk({ at: 1, duration: 0.5 })
    expect(movePhase(m, 1.25, 4)).toBeCloseTo(0.5, 6)
    expect(movePhase(m, 0.9, 4)).toBeNull()
    expect(movePhase(m, 1.6, 4)).toBeNull()
  })
  it('a loop runs [at, clip] and wraps continuously', () => {
    const m = mk({ at: 1, duration: 1, loop: true })
    expect(movePhase(m, 1.0, 4)).toBeCloseTo(0, 6)
    expect(movePhase(m, 1.5, 4)).toBeCloseTo(0.5, 6)
    expect(movePhase(m, 2.0, 4)).toBeCloseTo(0, 6)
    expect(movePhase(m, 0.9, 4)).toBeNull()
  })
  it('bounce ping-pongs within the window', () => {
    const m = mk({ at: 0, duration: 1, bounce: true })
    expect(movePhase(m, 0.5, 4)).toBeCloseTo(1, 6)
    expect(movePhase(m, 1.0 - 1e-9, 4)).toBeCloseTo(0, 4)
  })
  it('moveWindows returns at→end, end=clip for a loop', () => {
    const ws = moveWindows([mk({ at: 0.5, duration: 1 }), mk({ at: 0, duration: 2, loop: true })], 4)
    expect(ws[0]).toMatchObject({ start: 0.5, end: 1.5 })
    expect(ws[1]).toMatchObject({ start: 0, end: 4 })
  })
})
```

```ts
// tests/unit/studio-moves-direction.unit.spec.ts (new)
import { describe, expect, it } from 'vitest'
import { flipDirection, moveDirection } from '~/lib/studio/moves/direction'
const PAIRS = { 'fade-in': 'fade-out', 'fade-out': 'fade-in' }
describe('direction', () => {
  it('reads and flips a paired preset', () => {
    expect(moveDirection('fade-in', PAIRS)).toBe('in')
    expect(moveDirection('fade-out', PAIRS)).toBe('out')
    expect(flipDirection('fade-in', PAIRS)).toBe('fade-out')
  })
  it('returns null for an unpaired preset', () => {
    expect(moveDirection('wave', PAIRS)).toBeNull()
    expect(flipDirection('wave', PAIRS)).toBe('wave')
  })
})
```

- [ ] **Step 3: Run — expect fail.** `cd frontend && npx vitest run tests/unit/studio-moves-phase.unit.spec.ts tests/unit/studio-moves-direction.unit.spec.ts`

- [ ] **Step 4: Implement.**
  - `types.ts`: change `Move` per the interface; keep `MovePlay` exported (add a doc line: "retired from `Move`; kept for migration of 2026-09-03 documents").
  - `direction.ts`: `moveDirection` returns `'in'` if `presetId` ends in a known in-suffix / is a key whose pair id reads as an out (convention: a pair is `{in: out}`; `moveDirection` = `pairs[id]` exists AND id is the "in" side). Keep it simple: `PresetPairs` maps an IN id → its OUT id AND the OUT id → its IN id (symmetric); `moveDirection(id)` = `id in INSET ? 'in' : id in OUTSET ? 'out' : null` where the two sets are derived once. Provide a builder `buildPairs(inToOut: Record<string,string>): { pairs: PresetPairs; direction(id): 'in'|'out'|null }` so the VT adapter declares only `{ 'fade-in':'fade-out', ... }`.
  - `phase.ts`: rewrite `moveWindows` (map each move to `{ move, start: move.at, end: move.loop ? clip : move.at + move.duration }`) and `movePhase` (compute raw progress from `at`, honor `loop` wrap and `bounce` ping-pong, apply `easeSample`); delete `bandSpans`. Port the ping-pong/ease helpers from the current `playAndEase`.
  - `tracks.ts`: `TaggedMoveTrack = MoveTrack & { __ease; __at; __duration; __loop; __bounce }`; `trackRawProgress` uses `__at`/`__duration`/`__loop`/`__bounce` (drop `__play`). Progress model unchanged in spirit (0..1 across the window).

- [ ] **Step 5: Run — expect pass.** Same command; both specs green.
- [ ] **Step 6: Commit** (`feat(studio-moves): at/loop/bounce model + at-anchored window math; direction helpers`).

---

## Task 2: Migration (09-03 shape + pre-moves) with parity gates

**Files:** Modify `lib/studio/moves/merge.ts`. Test: `tests/unit/studio-moves-migrate.unit.spec.ts` (extend).

**Interfaces:** `mergeMove(raw, mergeTrackFn?)` accepts both a new-shape move (`at`/`loop`) and a 09-03 move (`phase`/`play`), converting the latter: `phase 'in'→at 0`, `'out'→at max(0, clipDur−duration)`, `'loop'→at longestIn, loop true`; `play.mode 'repeat'→loop true`, `'backAndForth'→bounce true`. `mergeClip` computes `longestIn` (max duration of `phase:'in'` moves) once and passes it in. `convertLegacyTracks(tracks, matchPreset, clipDuration)` emits `at`/`loop` (a matched loop preset → `at: 0, loop: true`; a custom track → `at: 0, loop: true` unless the legacy easing implied once).

- [ ] **Step 1: Write failing tests** — a 09-03 doc with an in (`at→0`), an out (`at→dur−d`), a loop (`loop:true`), and a `backAndForth` track (`bounce:true`); a new-shape doc round-trips; assert exact `at`/`loop`/`bounce`.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** the dual-shape merge in `merge.ts`.
- [ ] **Step 4: Run — expect pass.** `npx vitest run tests/unit/studio-moves-migrate.unit.spec.ts tests/unit/studio-moves-phase.unit.spec.ts` green.
- [ ] **Step 5: Commit** (`feat(studio-moves): migrate 2026-09-03 phase/play moves to at/loop/bounce`).

---

## Task 3: Vector Type engine + adapter on the new model

**Files:** Modify `lib/vectortype/config.ts` (`VtMove` alias, `mergeMotion`), `presetMotion.ts` (fold reads `movePhase(move, gt, clip)` — drop `longestIn`), `motion.ts` (`applyMoveTracks` tagging), `movesAdapter.ts` (`presetPairs`, `derivedMoves` `at:0/loop:true`, gallery groups by type not phase), `migrateKinetic.ts`. Test: extend `vectortype-preset-motion`, add the VT parity gate to `vectortype-moves-migrate`.

**Interfaces:** `VtMove = Move & { kind: 'preset'|'tracks'|'blink'|'scatter' }`. `vtMovesAdapter` gains `presetPairs` (VT's in/out id map) and drops phase-based gallery grouping.

- [ ] **Step 1: Write the failing test** — the VT parity gate: build a 2026-09-03-shape config (moves with `phase`/`play`) and a pre-moves config (old `motion.in`/`tracks`), run each through `mergeConfig` then `vtGlyphMotion` at 3 times, and assert equality within 1e-9 against the values the 09-03 engine produced (capture expected numbers by evaluating the same presets via the retained oracle path). Plus a `stacked at-moves` case: two transitions at different `at` compose.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement.** Update the fold in `presetMotion.ts` to iterate moves with `movePhase(move, gt, clip)`; `applyMoveTracks` tags with `at/loop/bounce`; `vtMovesAdapter` declares `presetPairs` from the kinetic catalog's in/out ids and groups the gallery by move type; `derivedMoves` blink/scatter get `at:0, loop:true`; `config.ts` `VtMove` and `mergeMotion` on the new shape; `migrateKinetic` writes `at`/`loop`.
- [ ] **Step 4: Run — expect pass.** `npx vitest run tests/unit/vectortype-preset-motion.unit.spec.ts tests/unit/vectortype-moves-migrate.unit.spec.ts tests/unit/vectortype-motion.unit.spec.ts tests/unit/vectortype-color-tracks.unit.spec.ts tests/unit/vectortype-track-presets.unit.spec.ts tests/unit/vectortype-moves-adapter.unit.spec.ts` — update old-shape constructions to `at`/`loop`, keep assertions.
- [ ] **Step 5: Commit** (`feat(vectortype): engine + adapter on at/loop model; parity gates green`).

---

## Task 4: Full Vector Type + studio-moves suites green

**Files:** remaining specs/helpers referencing `phase`/`play` (`vectortype-stack-addressing`, `-blink`, `-scatter`, `-glyph-fx`, `-stagger-presets`, `-stretch-presets`, `-svg-stack`, `-thumb-preview`, `-controls`; `thumbPreview.ts`, `presetMotion.ts` helpers, `studio-moves-merge`, `motion-move-card`, `studio-moves-easepicker`).

- [ ] **Step 1: Enumerate.** `npx vitest run tests/unit/vectortype-*.unit.spec.ts tests/unit/studio-moves-*.unit.spec.ts tests/unit/motion-move-card.unit.spec.ts 2>&1 | tail -40`
- [ ] **Step 2: Triage & fix** — where a helper reads `phase`/`play`, fix the source; where a test builds old-shape moves, reshape to `at`/`loop`, preserving assertions. Do NOT weaken any assertion; note any expected-value change with justification.
- [ ] **Step 3: Green + lib typecheck.** Both suites green (stretch alone if flaky); `npx vue-tsc --noEmit 2>&1 | grep -E "lib/vectortype|lib/studio/moves" | head` clean (surface `.vue` may still error — Tasks 6–7).
- [ ] **Step 4: Commit** (`refactor: remaining helpers/specs speak at/loop; suites green`).

---

## Task 5: Shared timeline drag math + `MoveTimeline.vue`

**Files:** Create `lib/studio/moves/timelineDrag.ts`, `components/vue-canvas/motion/moves/MoveTimeline.vue`. Delete `MoveBandStrip.vue`. Test: `tests/unit/studio-moves-timelinedrag.unit.spec.ts` (new, pure).

**Interfaces:**
- `timelineDrag.ts`: `snapSeconds(sec, targets, eps=0.08)`; `moveBand(at, deltaSec, clip): number` (clamp 0..clip); `resizeBand(band: {at,duration}, edge: 'left'|'right', deltaSec, clip): {at,duration}` (min duration 0.05; left edge shifts `at`); `bandRect(move, view: {start,end}): {leftPct, widthPct}`.
- `MoveTimeline.vue`: props `{ clip: MotionClip; selectedId: string | null; playhead: number }`; emits `select(id)`, `patch-move(move, partial)`, `seek(t)`.

- [ ] **Step 1: Write the failing test** — `snapSeconds` snaps within eps; `moveBand` clamps; `resizeBand` right grows duration, left shifts at and shrinks duration, both floored; `bandRect` maps at/duration into a zoom view.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement `timelineDrag.ts`** (port/generalize from `lib/scene3d/motion/timeline.ts`, typed to `{at,duration}`; do not touch the scene3d file).
- [ ] **Step 4: Write `MoveTimeline.vue`** (no unit test — verified live in Task 8): a seconds ruler (ticks/labels from the `[viewStart,viewEnd]` zoom window), a playhead line, one row per move with a band via `bandRect`, the ease drawn inside via `easeGlyphPath`, a loop band tiled with cycle dividers. Pointer handlers: drag ruler (no modifier) → `seek`; Option/Alt-drag ruler → zoom around start; Shift-drag ruler → reset zoom; drag band body → `patch-move({at})` via `moveBand`+`snapSeconds` (snap targets: 0, clip.duration, playhead, other bands' edges); drag band edge → `patch-move` via `resizeBand`; click band → `select`. Amber/emerald band fills per `Scene3DMotionTimeline`. Pause playback while scrubbing (emit seek; the surface pauses its clock), resume on pointerup.
- [ ] **Step 5: Run the drag test — expect pass;** `studio-moves-*` stays green.
- [ ] **Step 6: Commit** (`feat(studio-moves): shared band drag math + MoveTimeline component`).

---

## Task 6: `MovesPanel` rework + retire `MoveCard` + regroup `MoveGallery`

**Files:** Modify `MovesPanel.vue`, `MoveGallery.vue`; delete `MoveCard.vue`.

**Interfaces:** `MovesPanel.vue` props `{ clip; adapter; cfg; selectedId }`; emits `patch-clip`, `patch-cfg`, `add-move`, `remove-move`, `patch-move`, `open-gallery`. It renders, when `selectedId` names a move: the move's name + Change; an **In/Out** toggle (via `adapter.presetPairs`, hidden when unpaired) emitting `patch-move({presetId: flipped})`; a **Loop** toggle (`patch-move({loop})`); a **Bounce** toggle (`patch-move({bounce})`); **Length** (`patch-move({duration})`); the ease picker (`patch-move({ease})`); the move's `cardBody` (reused from the adapter kinds). When nothing selected: clip settings (Length/fps + `adapter.clipExtras`) + a Remove button per derived card is not shown here (removal is a small ✕ on the selected move). `MoveGallery.vue` drops the In/Loop/Out tabs and renders one grouped list from `adapter.gallery(cfg)` (adapter change: `gallery(cfg)` returns groups by move type, not per phase — update the adapter interface + VT impl accordingly, keeping the Custom group).

- [ ] **Step 1: Move the `MoveCard` expanded-body layout into `MovesPanel`'s selected-move view** (the rows above), reusing `EasePicker` and the kind `cardBody`. Delete `MoveCard.vue` and its `motion-move-card` spec (or repoint the spec at the panel's pure label helper if one is extracted).
- [ ] **Step 2: Regroup `MoveGallery`** — one grouped list; the phase tabs and the In/Loop/Out toggle inside it are removed. Picking a tile emits `add-move` with a move built at the playhead (transition) or spanning (loop) — the surface supplies the playhead via a prop or the adapter default `at: 0`.
- [ ] **Step 3: Adapter interface** — change `gallery(cfg, phase)` → `gallery(cfg)`; `MovesAdapter` gains `presetPairs`. Update `vtMovesAdapter` and the `studio-moves`/`vectortype-moves-adapter` tests.
- [ ] **Step 4: Typecheck + tests.** `npx vue-tsc --noEmit 2>&1 | grep -E "motion/moves|movesAdapter" | head` clean; `npx vitest run tests/unit/studio-moves-*.unit.spec.ts tests/unit/vectortype-moves-adapter.unit.spec.ts` green.
- [ ] **Step 5: Commit** (`feat(studio-moves): panel shows the selected move; gallery grouped by type; MoveCard retired`).

---

## Task 7: Vector Type surface wiring

**Files:** Modify `VectorTypeSurface.vue`, `controls.ts` if needed.

- [ ] **Step 1: Mount** `<MoveTimeline>` full-width under the preview (replacing the read-only strip) and `<MovesPanel :selected-id="selectedMoveId">` in the right inspector. Add `selectedMoveId = ref<string|null>(null)`; wire `@select`, `@patch-move` (write `config.motion.moves`), `@seek` (set the preview clock time + pause the loop; resume on release), `@patch-clip`/`@patch-cfg`/`@add-move`/`@remove-move`/`@open-gallery` as before. Supply the gallery's `#thumb` slot. `@add-move` builds a move at the current playhead.
- [ ] **Step 2: Preview clock** — the studio's rAF preview loop must accept a scrub: when `@seek(t)` fires, freeze the loop at `t`; on scrub end, resume from `t`. Reuse the existing `previewTime`/`playing` refs.
- [ ] **Step 3: Typecheck.** `npx vue-tsc --noEmit 2>&1 | grep VectorTypeSurface | head` clean; migrateKinetic may still show — fix if it names `phase`.
- [ ] **Step 4: Full vectortype suite green.**
- [ ] **Step 5: Commit** (`feat(vectortype): mount the motion timeline + selected-move panel; scrub drives the preview`).

---

## Task 8: Live verification

- [ ] **Step 1:** Start the worktree dev server (its own `.nuxt`) on a free port; open the studio, add a `VectorType` node, Edit, Motion tab. (Reload once if the first load 504s on Vite optimize.)
- [ ] **Step 2:** Add three moves (Fade, Weight Wave loop, a Custom slant). Confirm: three bands on the ruler; the loop band tiles; each band shows its ease curve.
- [ ] **Step 3:** Drag a band to a new start and confirm the band and the motion shift; resize a band edge; toggle the Fade between In and Out in the right panel and confirm the preview flips; toggle Bounce; scrub the ruler and confirm the playhead + preview follow and pause; Option-drag to zoom.
- [ ] **Step 4:** Reopen a 2026-09-03 document (paste an old-shape config via Import settings) and confirm it renders unchanged with bands laid out (in at start, out at end, loop spanning). Screenshot the timeline. `read_console_messages` clean.
- [ ] **Step 5:** Report + finish the branch (`superpowers:finishing-a-development-branch`) — leave it merge-ready; do not merge without the user's nod.

---

## Self-review notes

- **Spec §1 (model):** Tasks 1–2 (`at`/`loop`/`bounce`, `phase`/`play` gone, direction derived). ✅
- **Spec §2 (window math):** Task 1 (`at`-anchored, `bandSpans` deleted). ✅
- **Spec §3 (migration + parity):** Tasks 2–3 (dual-shape merge, two 1e-9 gates). ✅
- **Spec §4 (timeline component, DialKit interactions):** Task 5 (ruler/playhead/scrub/zoom/drag/ease-in-band/loop-tile). ✅
- **Spec §5 (panel = selected move / clip):** Task 6 (In/Out/Loop/Bounce toggles, ease, dials; gallery regroup; MoveCard retired). ✅
- **Spec §6 (VT surface):** Task 7 (mount, seek→clock). ✅
- **Spec §7 (testing):** unit across 1–6; browser Task 8. ✅
- **Spec §8 (out of scope):** spring/props-expand, multi-select, zoom persistence, other studios, carried owed items — none built. ✅
- **Do-not-touch-3D:** `timelineDrag.ts` is new; `Scene3DMotionTimeline`/`lib/scene3d/motion/timeline.ts` untouched (Global Constraints + Task 5 Step 3). ✅
- **Type consistency:** `Move`(at/loop/bounce), `moveWindows`/`movePhase`(clip, no longestIn), `PresetPairs`/`moveDirection`/`flipDirection`, `moveBand`/`resizeBand`/`snapSeconds`/`bandRect`, `MoveTimeline`/`MovesPanel` events — one signature each.
