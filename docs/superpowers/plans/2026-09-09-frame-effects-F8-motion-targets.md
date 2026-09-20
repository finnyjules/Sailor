# Slice F8 · Effect dials as motion targets  (task-level plan)

> Part of the **Frame Effects Programme** (`docs/superpowers/plans/2026-09-09-frame-effects-programme.md`).
> Written when reached; executed with superpowers:subagent-driven-development as F1–F7 were.
> Design decisions RESOLVED with Julien 2026-09-15 (see "Resolved design" below).

**Goal:** let any per-layer EFFECT dial be animated over the Frame's timeline. A dial — `grain`,
`radius`, `amount`, `threshold`, `depth`, `angle`… and colour dials like a risograph `ink` — becomes a
motion target addressed by the id-path `layers.<id>.effects.<effectId>.<dial>`, driven by a frame-level
track list, evaluated at one painter choke point, authored in the Motion tab. Today the effect stack
(F1–F7, `app/lib/compositor/effectStack.ts`) is static per paint; whole-layer transform/opacity already
animate through `app/lib/motion/`. F8 makes the dials keyframable the same way, no second render engine.

## Resolved design (Julien, 2026-09-15)
1. **Track model = bespoke multi-keyframe** (`EffectDialTrack` with `{t, v, ease}` keyframes in seconds,
   ease-into-next) — native to the Frame's own `LayerKeyframe` idiom + `motion/easing.ts`. NOT the studios'
   two-endpoint moves core.
2. **Scope = numbers AND colours in v1.** Numbers lerp via `easing.ts`; colours mix via `mixHex`
   (`app/lib/color/mix.ts`, oklch, exact endpoints). Enum/bool dials step (nearest earlier keyframe).
3. **Authoring UI = Motion tab.** The effect INSPECTOR stays static. A picker in the Motion tab lists a
   layer's animatable dials (`effectDialTargets(layer)`) and adds a track; the timeline holds the
   keyframes as per-dial rows nested under the layer band. The inspector shows only a light "animated"
   marker on a driven dial (the variable signal), and editing that dial writes the keyframe at the
   playhead — no per-row keyframe toggle in the inspector.

## The mechanism (why this is cheap and safe)
- **Id-path resolution already works, nested, id-stamped.** `resolveIdPath`/`setByIdPath`/`getByIdPath`
  (`app/lib/studio/idPath.ts:85/156/142`) resolve `<list>.<id>.<rest>` and already walk nested id-lists
  (`objects.<id>.treatments.<tid>.amount`). `layers.<id>.effects.<effectId>.<dial>` resolves against a root
  `{ layers }` with **zero change to idPath.ts**, because effects carry ids: `EffectInstance = LayerEffect &
  { id }` (`effectStack.ts:184`), and `effectStackOf` (`effectStack.ts:380`) mints DETERMINISTIC ids
  (`fx:<type>:<ordinal>`) for legacy layers "so a random id per read would break selection and motion
  targets across re-reads". The resolver refuses on unknown (returns `undefined`, never a fabricated index),
  so a dangling track no-ops rather than corrupting a neighbour.
- **The evaluator is a pure fold over the layers** (`app/lib/motion/effectTracks.ts`,
  `applyEffectDialTracks(layers, tracks, t) → LocalLayer[]`): clone only touched layers + their effects
  arrays, overwrite the one dial with its value at `t`, return a NEW array; return the SAME reference when
  `tracks`/`t` absent or nothing resolves — the byte-identity seam. Mirrors Vector Type's proven
  `applyMotion(cfg,t)` id-path choke point (`app/lib/vectortype/motion.ts:582`).
- **One seam in the painter.** `paintLayerStack` (`useCompositorLayers.ts:5407`) already receives `t`+`motion`
  and is the single path every surface crosses (modal `renderStack` `CompositorModal.vue:4119`, bake `:3853`,
  `ArtifactFrameNode.vue:546/838`, agent `useCompositorAgent.ts:161`). Fold the dial values in at the TOP of
  `paintLayerStack` (before the shader-request loop `:5449` and the item loop `:5524`) → every surface
  animates for free, the existing whole-layer motion path (`:5553`) sees the dial-animated clone, and there
  is exactly one place to prove byte-identity.
- **Byte-identical when absent, by construction.** The painter reads dials through `effectStackOf(layer)`
  everywhere; the fold writes a clone whose `.effects` is the id-stamped stack with one leaf changed, so
  `effectStackOf` on the clone returns the same sorted/visible list — identical output for an unchanged
  value, same reference when no track fires.
- **Interpolation reused, not rebuilt:** `motion/easing.ts` for numbers (same seconds-based ease-into-NEXT
  idiom as `evaluate.ts:473` `evaluateKeyframes`), `mixHex` for colours, step for enum/bool.

## Global constraints (bind every task)
- **Byte-identical when absent** (real-canvas A/B at dpr 2, RED-first vs a deliberately-broken fold). The
  whole-layer motion path (transform/opacity keyframes, kinetic in/loop/out) is unchanged.
- No change to `idPath.ts`, the effect id model, `effectStackOf`, or `writeStackToLayer`. Reuse
  `resolveIdPath`/`setByIdPath`, `mixHex`, `motion/easing.ts` — NO second interpolation core.
- `CompositorModal.vue` / `useCompositorLayers.ts` / the timeline component staged BY HUNK via a private
  `GIT_INDEX_FILE` (own hunks only, never `git add -A`/`git stash`; the shared index here is ACTIVELY
  HOSTILE — files get staged-deleted and foreign hunks appear; the private-index recipe MUST be ONE bash
  call). After each commit, VERIFY the owned symbols are present in HEAD (a filtered commit can fail to
  restore stripped owned code).
- NEVER a subagent dev server; controller runs the live gate (a hidden pane pauses rAF → live Playwright is
  the oracle for animated render; a unit can be green over a frozen preview).
- UI copy sentence case, human names, no dead controls; `optionLabels` on selects over internal values.
- **Agent UI-ONLY this slice.** `COMPOSITOR_HINT_CEILING = 26250`, surface at 26248/26250 (full). No agent
  vocabulary; a unit asserts a motion-track patch is rejected and the ceiling is unchanged. (Owed follow-up:
  "animate the grain 0→50" needs the hint-ceiling decision Julien owns.)
- Commits end `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Interfaces produced
### `app/lib/motion/types.ts` (extend)
- `FrameMotion` gains `tracks?: EffectDialTrack[]` — persisted at `node.data.properties.sailor_motion` via
  `CompositorModal.vue:setMotion` (`:3616`, which spreads the whole doc). `DEFAULT_FRAME_MOTION` unchanged
  (absent `tracks` ⇒ no-op).
### `app/lib/compositor/effectDials.ts` (new, pure)
- `EFFECT_DIAL_SCHEMA: Record<EffectKind, DialSpec[]>`, `DialSpec = { key; label; min; max; kind:'number'|'color'|'enum'|'bool' }`.
  The single declarative table of which dials animate (genuinely new — today's inspector rows are
  hand-written). Includes numeric AND colour dials in v1. A unit pins every key to a real dial on the
  matching effect interface (the dead-control guard).
### `app/lib/motion/effectTracks.ts` (new, pure)
- `DialKeyframe { t:number; v:number|string; ease?:'linear'|'easeInOut' }`; `EffectDialTrack { target:string; keyframes:DialKeyframe[]; space?:'oklch'|'srgb' }`.
- `evaluateDialTrack(track, t): number|string|undefined` — numeric lerp via `easing.ts`; colour mix via
  `mixHex` when both bracketing values are hex; step for enum/bool; `undefined` for empty/invalid (never NaN).
- `applyEffectDialTracks(layers, tracks, t): LocalLayer[]` — the fold (clone touched, `setByIdPath`, same
  reference when nothing fires).
- `effectDialTargets(layer): DialTargetSpec[]` — every animatable dial on this layer's effects
  (`layers.<id>.effects.<effectId>.<dial>` paths via `effectStackOf`), `{ path, label, min, max, kind }`.
  Feeds the Motion-tab picker and the timeline.
### `app/composables/useCompositorLayers.ts`
- Import `applyEffectDialTracks`; at the top of `paintLayerStack` derive
  `applyEffectDialTracks(localLayers, motion?.tracks, t)` and rebuild local items' `.layer` by id (wired
  items untouched); widen the `motion?` param type to carry `tracks`. Same-reference return ⇒ untouched.
### Motion tab — `CompositorMotionTimeline.vue` + `CompositorModal.vue` (+ a small inspector marker)
- A **dial picker** in the Motion tab (lists `effectDialTargets` for the selected/each layer) that adds/
  removes an `EffectDialTrack`; per-dial **track rows nested under the layer band** in the timeline with
  draggable keyframe diamonds (seconds), add-at-playhead, delete; persistence through `setMotion` +
  `commitMotionTimeline` (`:3634`). A light "animated" marker on a driven dial in the effect inspector
  (the variable signal); editing a driven dial writes the keyframe at `previewT`.
### Agent — `app/lib/agent/surfaces/compositor.ts`
- No change. A unit asserts a motion-track patch is rejected and `COMPOSITOR_HINT_CEILING` unchanged.

## Tasks
### Task 1 · Dial schema + target enumeration (pure, no render)
`effectDials.ts` `EFFECT_DIAL_SCHEMA` for every EffectKind with animatable dials (numbers AND colours:
drop_shadow x/y/blur/color, layer_blur/background_blur radius, geometry dials, F4 style dials incl overlay
colours, F7 recipe dials incl risograph ink/inkTwo + letterpress ink, shader/backdrop_shader speed).
`effectDialTargets(layer)` builds `layers.<id>.effects.<effectId>.<dial>` against `effectStackOf(layer)`.
**Tests (unit):** every schema key resolves to a real dial on its interface (dead-control guard);
`effectDialTargets` emits correct id-paths for new- and legacy (deterministic-id) layers; duplicated effect
id resolves to lowest index. **Acceptance:** targets enumerate for both shapes; no target names an unread dial.

### Task 2 · The evaluator (`evaluateDialTrack`) — numbers + colours + step
Numeric lerp via `easing.ts` (linear / easeInOut) matching `evaluateKeyframes`; colour mix via `mixHex`
(oklch default, exact endpoints); enum/bool step to nearest earlier keyframe; clamp before-first/after-last;
empty/malformed → `undefined`. **Tests (unit CPU-twin):** number at t=0/mid(both eases)/past-end; single
keyframe holds; colour mixes at mid-t + exact at endpoints; step for enum/bool; empty → undefined;
determinism. **Acceptance:** every supported dial kind returns the right value at any t; no NaN escapes.

### Task 3 · The fold + byte-identity seam
`applyEffectDialTracks` clones only touched layers/effects, `setByIdPath` against `{layers}`, same reference
when nothing resolves; wire into `paintLayerStack` top; rebuild local items by id. **Tests:** unit —
same-reference when tracks empty / t undefined / target dangling; a resolving track mutates only the target
dial on a CLONE, input untouched. **Live Playwright (controller):** real-canvas A/B — no-track Frame
data-URL-identical before/after (RED-first vs broken fold); a numeric dial track renders different pixels at
two playhead positions. **Acceptance:** absent ⇒ byte-identical; present ⇒ the dial animates live.

### Task 4 · Motion-tab dial picker (add/remove tracks) + persistence
CompositorModal/Motion tab: a picker listing the selected layer's `effectDialTargets` (sentence-case labels,
grouped by effect); choosing one appends an `EffectDialTrack` (via `setMotion`) with a keyframe at
`previewT`; removing it deletes the track. No dead entries for layers with no animatable dial. **Tests:**
unit on the add/remove reducer (idempotent, right id-path, keyframe at playhead); **live Playwright** — add a
dial track from the Motion tab, scrub, assert the render changes and it round-trips through save/reload
(`sailor_motion.tracks`). **Acceptance:** a designer adds/removes a dial track from the Motion tab; it persists.

### Task 5 · Timeline — per-dial track rows + keyframe editing
CompositorMotionTimeline.vue: under each layer band, one row per effect-dial track (nested, collapsible),
draggable keyframe diamonds (seconds), add-at-playhead, delete; drag mutates `motion.tracks` then
`commitMotionTimeline` on pointerup (the existing band idiom). **Tests:** unit on keyframe drag/insert/delete
math (snap, ordering); **live Playwright** — drag a keyframe, assert the interpolated mid-time render
reflects the move. **Acceptance:** per-dial tracks are visible/editable on the timeline; edits persist + re-render.

### Task 6 · Inspector variable-signal + edit-at-playhead
The effect inspector shows a light "animated" marker (◆ accent glyph + the motion accent colour) on a dial
that has a track, drawing the live value at `previewT`; editing that dial writes/updates the keyframe under
the playhead (not the static value). No per-row keyframe toggle (authoring is the Motion tab). **Tests:**
unit on the edit-at-playhead reducer (writes the keyframe under the head, leaves others); **live Playwright**
— a driven dial reads its animated value while scrubbing and editing it moves the keyframe. **Acceptance:**
a driven dial reads as a variable in the inspector and edits the keyframe, never the static value.

### Task 7 · Bake, agent-reject, coexistence, copy + whole-slice proofs
Confirm the fold runs in the motion bake path (`bakeMotion`, `CompositorModal.vue:3776`) and in
`ArtifactFrameNode` motion paints — an exported/baked video shows the animated dials. Coexistence: a dial
track + whole-layer transform keyframes on one layer both apply; two dial tracks on two effects both apply.
Agent-reject unit for a `{ motion:{ tracks:[...] } }` patch + `COMPOSITOR_HINT_CEILING` unchanged (no
compositor.ts change). Copy sweep; typecheck baseline. **Tests:** unit (agent reject, ceiling, coexistence);
**live Playwright** — full F8 describe green (byte-identity absent, animate numeric dial, animate colour dial,
Motion-tab add, timeline edit, bake-carries-dials); whole-slice unit sweep green. **Acceptance:** dials
animate in preview AND bake; agent UI-only; hint budget unchanged; whole-slice green.

## Acceptance (whole slice)
- Any numeric OR colour effect dial is a motion target (`layers.<id>.effects.<effectId>.<dial>`), driven by a
  frame-level bespoke-keyframe track list, evaluated at one painter choke point, authored in the Motion tab,
  byte-identical when absent, live-verified moving and baked.
- Reuses `resolveIdPath`/`setByIdPath`, `mixHex`, `motion/easing.ts`; no second interpolation core; no change
  to the effect id model or `idPath.ts`.
- Agent UI-only (deliberate, documented); hint budget unchanged.

## Follow-ups (owed)
- Agent vocabulary for animating dials — the hint-ceiling decision.
- Enum/bool dial animation UX (stepped) if any enum dials prove worth animating.
- By-eye: default ease, keyframe-diamond affordance feel, the inspector variable-marker styling.
