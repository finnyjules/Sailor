# Pile refinements + Space Type preview playback — design

Date: 2026-09-18
Status: Design (approved in brainstorming)

Three changes, two independent workstreams. #1 and #2 are Pile-effect changes; #3 is a Space Type *surface* feature that benefits every effect.

## 1. Remove Pile's `Settle time` control

`Settle time` exposed the fraction of the loop spent falling vs holding — a confusing second axis on top of the shared loop-duration (the real "animation length"). Remove it.

- Delete the `settleTime` control from `effects/pile.ts`.
- In `pile/physics.ts`, replace the `settleTime` param read with a hard-coded constant `SETTLE_FRACTION = 0.8`: the resampled fall occupies the first 80% of the loop; the settled pose holds for the last 20%. No other behaviour changes.
- `bakePile` stops reading `params.settleTime` entirely.

## 2. Pile — hand-pick a set of shapes

Today one shape is repeated. Let the user pick several; the pile mixes them.

**New control kind `shapeList`** (`effect.ts` ControlSpec union): stores a JSON array of shape ids as one scalar string (mirrors `fillList`). `defaultsFromControls` already just copies `.default`, so no other schema plumbing is needed.

**Shared `ShapePicker.vue` gains a multi-select mode:**
- New props: `multiple?: boolean` (default false), `selectedIds?: string[]`.
- Single-select behaviour is unchanged when `multiple` is false (existing callers: the separator picker's `RowShape`).
- In multi mode: a tile click emits `toggle` with its id (instead of `update:modelValue` + `close`); the picker stays open; a tile whose id is in `selectedIds` shows a check/selected state. The "None" tile is hidden in multi mode.

**New row `RowShapeList.vue`** (registered in `rows/registry.ts` as `shapeList`): renders the selected shapes as small `viewBox="0 0 96 96"` glyph chips with a `+N` overflow, and a button that opens `ShapePicker` in `multiple` mode. Parses/serialises the JSON array; on `toggle` it adds/removes the id and emits `update:value` with the new JSON.

**Pile wiring:**
- `effects/pile.ts`: replace the `shape` control with `shapes` (kind `shapeList`, group `Layout`, default `'[]'`), shown when `shapeCount ≠ 0` (same `showIf` as today). Keep `shapeSize`/`sizeVariation`.
- `pile/tokens.ts`: read the `shapes` list (parse JSON; tolerate a legacy single `shape` string as a fallback when `shapes` is empty). For each shape token, pick a shape id from the set with the existing seeded RNG (`mulberry32`), so the mix is varied and deterministic. Empty set → first catalog shape (today's behaviour). Each token's `shapeId` flows unchanged into the polygon collider (`shapeCollider.ts`) and fill render, so no physics/render changes.

**Distribution:** seeded-random pick per token (assorted), not strict cycling.

## 3. Space Type preview — play/pause + scrubber (all effects)

On `SpaceTypeSurface.vue` (shared by every effect), add preview transport so an animated effect can be paused and scrubbed — essential for choosing a still (e.g. the settled pile).

- **State:** `playing` ref (default true) and a `scrubFrame` (or normalised `scrubT`) ref.
- **Pause:** call `stopPreview()` and keep the last frame on screen (`renderFrameAt(previewT01, …)` already painted it). **Play:** call `startPreview()`, resuming from the scrubbed position — set `previewStart` so `tick()`'s wall-clock frame continues from the current frame rather than jumping to 0.
- **Scrubber:** a slider spanning the effective loop (0…`base·k` frames, using the existing `base`/`k` and `previewFrameAt` math). While **paused**, dragging sets `previewT01 = frame / base` and calls `engine.renderFrameAt(previewT01, effectiveRenderParams())`. While **playing**, the slider reflects the current `frame` each tick (throttled to the content-fps repaint that already gates `tick`).
- **UI:** a small transport row (play/pause button + slider), placed near the existing loop/output controls in the surface. Reuses `startPreview`/`stopPreview`/`renderFrameAt` and the `base`/`k`/`previewFrameAt` helpers — no engine changes.
- **Edits while paused:** structural edits already re-render via `rebuild()`/immediate-render watchers at the held `previewT01`, so a paused preview still reflects control changes (it just doesn't advance time).

Independent of #1–2; can land separately. Touches `SpaceTypeSurface.vue`, which other sessions edit — stage only these hunks (private git index).

## Testing

- **#1:** `pile/physics` unit test updated — the hold-after-fall assertion uses the hard-coded `SETTLE_FRACTION` instead of a `settleTime` param; `settleTime` no longer read.
- **#2:** `pile/tokens` unit tests — shape tokens' ids all come from the chosen set; same seed → same assignment; multiple ids → a mix (more than one distinct id appears across enough tokens); empty set → fallback to the first catalog shape; legacy single `shape` still works.
- **#3:** verified live in the harness/Studio (surface UI + rAF, not unit-testable) — pause freezes the frame, the scrubber lands on an exact frame, play resumes from there. A hidden pane pauses rAF, so foreground before capturing.

## Out of scope / future

- Group/family shape presets (the user chose hand-pick).
- Concave (`poly-decomp`) shape colliders — shapes still use their convex hull.
- Per-effect animation-length override on the Motion side (length stays the shared loop-duration).
