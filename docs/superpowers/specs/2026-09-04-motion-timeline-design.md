# Motion panel — a timeline, DialKit's feel — design

**Date:** 2026-09-04
**Status:** designed, not built
**Amends:** `2026-09-03-motion-moves-shared-core-design.md` and `2026-09-03-vector-type-motion-moves-design.md`. The moves data, engine, migration, ease, tracks and adapter stand; this changes the PANEL from a stack of cards to a **timeline**, and moves In/Out/Loop off the band and into the selected move's controls.
**Scope:** the shared moves panel (`frontend/app/components/vue-canvas/motion/moves/`), a small model change in `frontend/app/lib/studio/moves/` (a move gains a start time and a loop flag; the `phase` enum is retired), the window math in `phase.ts`, and the Vector Type surface + adapter wiring. Shape/Gradient/Shader inherit the timeline for free.

## In plain words

**What is wrong.** The card-stack that landed 2026-09-03 is dense and hard to read. A vertical list of cards with each move's dials tucked inside makes *when things happen* invisible. Julien: "it feels messy and hard to read. a timeline feels clearer." He likes Jitter's timeline and Josh Puckett's DialKit timeline specifically.

**What changes.** The Motion tab becomes a **timeline docked at the bottom** (where 3D Studio already puts its motion timeline), with the selected move's controls in the **right inspector**. Each move is a **band**: a start time and a length you drag, with its ease curve drawn inside. Click a band to select it and edit it on the right. A seconds ruler with a scrubable playhead runs across the top. Loops tile to the clip end. This is DialKit's interaction model, built native over our own moves (not the DialKit library — see below), skinned in Sailor's dark-studio language.

**What moves off the band.** In / Out / Loop was a phase tag on every move. On a timeline the band's *position* already says when a move happens, so the tag is redundant there. In/Out becomes a **direction toggle** and Loop a **toggle**, both in the selected move's right-panel controls — the "what it does," separate from the "when." This is how Jitter does it.

**What is kept.** The composition engine, the ten-named-plus-bezier ease, the tracks, the legacy-document migration, and the `MovesAdapter` that Shape/Gradient/Shader mount. The band-drag, ruler and offset math already exist in 3D Studio's motion timeline and are the base to build on.

**Why not embed the DialKit library.** DialKit is MIT and has a Vue 3 build, so we technically could. We should not: it is a developer parameter-tuning tool hidden in production by default, its timeline edits DialKit's own animation store in DialKit's own dock chrome, and our moves are already a first-class, persisted, multi-studio model. Embedding it means either replacing our model with DialKit's or maintaining a brittle two-way sync, and shipping a dev overlay as product UI. Precedent: the 28px slider rows were DialKit-inspired but built native (`StudioRow`), not embedded. Same play here — copy the feel, own the surface.

## 1. The model change

A move today (2026-09-03): `{ id, phase: 'in'|'loop'|'out', kind, presetId?, duration, ease, play, params?, tracks? }`.

A move now:

```ts
interface Move {
  id: string
  kind: string                 // 'tracks' | studio kinds (preset/blink/scatter for VT)
  presetId?: string
  at: number                   // START time in seconds (band position). Replaces phase.
  duration: number             // band length in seconds
  loop: boolean                // repeats from `at` to the clip end (tiled, continuous phase)
  ease: MoveEase
  params?: Record<string, number>
  tracks?: MoveTrack[]
}
```

- **`phase` is gone.** Its three meanings split cleanly: *when* → `at`; *repeats* → `loop`; *direction (in/out)* → derived from the preset id and flipped by the toggle (below), not stored.
- **`play` is gone as a field.** `play.mode` was `once|backAndForth|repeat` and `play.times`. On a timeline: `once` = a band of length `duration`; `repeat` = `loop: true`; `backAndForth` = a per-move **Bounce** toggle (ping-pong within the band/cycle), stored as an optional `bounce?: boolean` (default false). `times` is subsumed by `loop` (a loop fills the clip; the visible count = clip / duration). So `play` collapses to `loop` + `bounce`.

Final field set added/changed vs 09-03: **add** `at`, `loop`, optional `bounce`; **remove** `phase`, `play`. `MotionClip` unchanged (`{ moves, duration, fps }`).

**Direction (In / Out).** Not a stored field. A preset id belongs to an in-family or an out-family table (the engine already has `fade-in`/`fade-out`, `slide-up`/`slide-out-up`, etc.). The right-panel **In / Out toggle** swaps the move's `presetId` between its paired ids and is disabled for a preset with no pair (loop presets, blink, scatter, custom tracks). `moveDirection(presetId): 'in' | 'out' | null` reads it; `flipDirection(presetId): string` swaps it. A new `PRESET_PAIRS` table (or a derivation from the existing catalog naming) supplies the pairing; where a pair genuinely doesn't exist the toggle is hidden.

## 2. The window math (`phase.ts`)

`movePhase`/`moveWindows`/`bandSpans` are rewritten to read `at`/`loop` instead of the phase anchoring:

- **A move's window is `[at, at + duration]`.** No more `longestIn` coupling between moves — each band stands where it is placed.
- **`movePhase(move, gt, clip)`**: returns eased-and-bounced local progress in `[0,1]`, or null when `gt` is outside the window. For `loop`, the window is `[at, clip]` and the phase is `((gt − at) / duration) mod 1` (continuous, no wrap snap), optionally ping-ponged by `bounce`.
- **`moveWindows(moves, clip)`** returns each move's `{ move, start: at, end: loop ? clip : at+duration }` — used by the timeline to lay out bands and by the composition fold.
- `bandSpans` (the old read-only strip) is deleted; the timeline replaces it.

**Composition** (`vtGlyphMotion` fold, `applyMoveTracks`) is unchanged in rule — it already asks each move for its live local progress and folds (positions add, scale/opacity multiply, axes add). Only the source of "is this move live and at what local progress" changes from phase-anchored to `at`-anchored.

## 3. Migrating 2026-09-03 documents

`mergeMove` / `mergeClip` accept both shapes. A move carrying `phase`/`play` (the 09-03 shape) converts:

- `phase: 'in'` → `at: 0`, `loop: false`.
- `phase: 'out'` → `at: max(0, clip.duration − duration)`, `loop: false`.
- `phase: 'loop'` → `at: longestIn`, `loop: true` — where `longestIn` is the max duration of the doc's in-phase moves, reproducing the old loop-starts-after-the-entrance behaviour.
- `play.mode: 'repeat'` → `loop: true`; `play.mode: 'backAndForth'` → `bounce: true`; `play.mode: 'once'` → neither.
- `ease`, `params`, `tracks`, `presetId`, `kind` carried through.

Because these `at`/`loop`/`bounce` values reproduce the exact windows the 09-03 engine used, a converted document renders identically. **The legacy pre-moves conversion** (the original preset-slots + flat-tracks path from `convertLegacyTracks`) is updated to emit `at`/`loop` directly. Two parity gates (Task list): a 09-03-shape fixture and a pre-moves fixture, each rendered three frames before and after through `vtGlyphMotion`, equal within 1e-9.

## 4. The timeline component

`MoveBandStrip.vue` (read-only) is replaced by `MoveTimeline.vue` in `components/vue-canvas/motion/moves/`, studio-agnostic (props: `clip`, `selectedId`; emits `select`, `patch-move`, `seek`). Built on the same math as `Scene3DMotionTimeline.vue` / `lib/scene3d/motion/timeline.ts` (`resizeTransition`, `setClipOffset`, `snapSeconds`), lifted into a shared `lib/studio/moves/timelineDrag.ts` so both studios share one copy.

DialKit's exact interactions, Sailor's skin:

- **Seconds ruler** across the top: ticks and second labels, spacing derived from the zoom. Height ~18px.
- **Playhead**: a vertical line at the current preview time. **Dragging on the ruler with no modifier seeks** — the playhead follows and the preview scrubs (emit `seek(t)`); playback pauses while dragging, resumes on release. This drives the existing preview clock.
- **Zoom**: **Option/Alt-drag** on the ruler zooms the timescale around the gesture's start point; **Shift-drag** resets to the full clip. Zoom is component-local (a `[viewStart, viewEnd]` window), not persisted.
- **Bands**: one row per move (stored order), each a rounded bar spanning `[at, at+duration]` in the current view, labeled with `moveLabel`. A `loop` band tiles/repeats to the clip end with a subtle cycle divider, continuous across the wrap.
- **Ease in the band**: the move's ease drawn as a bezier trace across the band via `easeGlyphPath`, faint; back/elastic show their overshoot. A `loop` band draws one cycle's curve, repeated.
- **Drag the body** → change `at` (emit `patch-move`), snapping to 0, clip end, other bands' edges, and the playhead. **Drag an edge** → change `duration` (the ease retimes with it); left edge also shifts `at`.
- **Click a band** → `select(id)`. The selected band is outlined; the right panel shows its controls.
- Bands never overlap-block each other — they compose, so two bands may occupy the same time; rows keep them separately draggable (like DialKit's rows).

Spring/`~` derived-duration and the props-composite-expand-into-tracks are DialKit features we do **not** need in v1 (our moves are single-purpose; a `tracks` move with several tracks stays one band, its dials in the panel). Noted as out of scope, not forgotten.

## 5. The right panel (`MovesPanel.vue` reworked)

`MovesPanel` stops rendering a card list. It renders:

- **When a move is selected**: that move's controls — the name + a **Change** button (reopens the gallery to swap, keeping `id`/`at`/`duration`/`ease`); the **In / Out** direction toggle (hidden when the preset has no pair); a **Loop** toggle; a **Bounce** toggle; **Length** (number, mirrors the band); the **ease picker** (named grid + the curve editor popover, already built); and the move's **dials** (the existing `cardBody` per kind — preset params / track from-to / blink / scatter). The card-body components are reused verbatim; only their host changes from a list card to the panel.
- **When nothing is selected**: the **clip settings** — Length, Frame rate, and the adapter's `clipExtras` (Vector Type's letter-by-letter).
- **Add move** button (top of the panel or on the timeline's toolbar) → the gallery.

`MoveCard.vue` is retired (its collapsed-row/expand behaviour is gone); its expanded-body layout moves into the panel's selected-move view. The gallery (`MoveGallery.vue`) loses the In/Out/Loop tabs — it now lists moves by type in one grouped list (Letterform, Appear, Slide, Scale, Blur, Rotate, Physics, Text, Loop-style, Effects), with the In/Out direction chosen after via the toggle. A picked move drops a band: a transition at the playhead (or 0), a loop spanning from the playhead to the end.

## 6. Vector Type surface wiring

`VectorTypeSurface.vue`: the Motion tab renders `MoveTimeline` docked under the preview (full width, replacing the read-only strip) and `MovesPanel` (selected-move / clip settings) in the right inspector. `selectedId` is surface state. `@seek` drives the preview time (the studio already has a preview clock; the playhead reads and sets it). `@patch-move` writes `config.motion.moves`. The In/Out/Loop/Bounce toggles and Length flow through the same `patch-move`. Adapter unchanged except: `derivedMoves` (blink/scatter markers) get an `at: 0, loop: true` so they render as full-width loop bands; `moveDirection`/`flipDirection` live in the shared layer, VT supplies its `PRESET_PAIRS`.

## 7. Testing

- **`studio-moves-phase`** rewritten: `at`-anchored windows, loop wrap continuity, bounce ping-pong, out-of-window null.
- **`studio-moves-migrate`** + **`vectortype-moves-migrate`**: the two parity gates (§3) — a 09-03-shape doc and a pre-moves doc each render three frames identically (1e-9).
- **`studio-moves-timelinedrag`** (new, pure): `setClipOffset`/`resizeTransition`/`snapSeconds` over `at`/`duration`; snapping targets; left-edge resize shifts `at`.
- **`studio-moves-directions`** (new, pure): `moveDirection`/`flipDirection` over the VT pairs; hidden when unpaired.
- Existing `vectortype-preset-motion`, `-motion`, `-color-tracks`, `-track-presets`, `-stack-addressing`, `-moves-adapter` updated to the `at`/`loop` shape; behavioural assertions preserved.
- **Browser**: add three moves, drag one to a new start and see the band and motion move, resize a band, toggle a Fade between In and Out, scrub the ruler and watch the preview follow, confirm a loop band tiles, reopen a 2026-09-03 document and confirm it renders unchanged with bands laid out.

## 8. Out of scope

- Spring/derived-duration bands and the props-composite-expand-into-tracks (DialKit features our single-purpose moves don't need in v1).
- Multi-select / group drag on the timeline.
- Persisting zoom.
- Consumer studios beyond Vector Type (Shape/Gradient/Shader inherit the component but their adapters are their own later work).
- The Collection-binding chip and agent add/remove-move carried from the 09-03 owed list — unchanged, still owed.

## Plain-language summary

The Motion tab becomes a timeline at the bottom with the selected move's settings on the right, exactly the way 3D Studio already works and the way DialKit and Jitter feel. Each move is a bar you place in time and stretch, with its ease curve drawn on it; drag the ruler to scrub. In/Out and Loop stop being a label on the bar and become toggles in the move's settings. Under the hood a move swaps a `phase` tag for a start time and a loop flag; everything saved yesterday converts and looks identical. We build the feel ourselves rather than pulling in DialKit, the same way the sliders were DialKit-inspired but native.
