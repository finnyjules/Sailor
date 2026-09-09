# Storyboards on the Frame — design

**Date:** 2026-09-09
**Status:** Design, approved in brainstorm 2026-09-09. One spec, two build slices.
**Area:** `frontend/` — the Frame (Compositor), the motion engine under it, the shared moves core.
**Mockups:** `.superpowers/brainstorm/78992-1788970762/content/story-tab-v3.html` (the approved layout; v1 and v2 under `48036-1788942968/content/` show the two rejected shapes). Hosted copy: https://claude.ai/code/artifact/966c6ae7-c8db-406c-9bef-69f25b4ef885

---

## Plain-language summary

You build a Frame the way you already do: a word, a subtitle, a shape, a photo. Then you press "Add board". The Frame now has two boards, and the second is a copy of the first. You move the title up, shrink it, add a subtitle. Press play. The title travels from where it was to where it is now, and the subtitle fades in. You never set a keyframe.

That is the whole idea: **a storyboard of poses, and Sailor works out the animation between them.** It is how Keynote's Magic Move and Figma's Smart Animate work, on top of the Frame you already have.

Three rules make it simple:

1. **One cast, many poses.** A Frame keeps one list of elements. The word, the font, the colours, the effects are the same on every board. A board only remembers where each element sits, how big it is, how it is turned, how see-through it is, its solid colour, and whether it is there at all. Change the word on board three and it changes everywhere, because it is the same element. Nudge it on board three and it moves only there.
2. **Same element on two boards, it travels. Only on one, it enters or leaves.** Travel is a smooth move between the two poses. Entering and leaving use the moves gallery Sailor already has, with a good default so you never have to pick.
3. **The story list is the summary, the timeline is the precise version.** A Story tab in the left panel lists the boards and what happens between them. A timeline docked under the canvas shows the same thing per element, with exact times you can drag. Both edit one record, so they always agree.

What falls out for free: the Frame node on the canvas plays the piece, "Generate as video" exports it, and the Frame lands on the big Timeline with the right length, because the storyboard compiles into the motion record the Frame already uses.

What is risky: the engine needs three small additions (non-uniform scale, colour and a proper ease list on keyframes; loops that can start and stop; per-element timing inside a transition). Undo has to cover boards or poses and layers drift apart. And "delete" has to mean "remove from this board" once a second board exists, which is a change in meaning that must be visible.

---

## Why this shape (decisions from the brainstorm, do not relitigate)

- **Boards live inside one Frame**, not as separate Frame nodes on the canvas and not as poster-sheet tiles. One document, one undo stack, one layer list, so element identity across boards is free. Separate nodes would need identity reconciliation and each is a heavy studio.
- **Model C, not pure Magic Move and not scene cuts.** Matched elements travel; unmatched ones enter or leave. Pure "same cast, rearranged" is too strict for real pieces; scene cuts throw away the travel, which is the magic.
- **Story tab in the left panel, vertical.** The canvas stays whole (posing is the main act and a bottom strip steals height), a list that flows down reads as steps, rows carry their own controls. The bottom strip was rejected.
- **Entries and exits belong to the transition, loops belong to the board.** Time-wise an entrance happens during the transition, not "at" the next board. A board card holds only what is true while it holds: the pose and any loops. This replaced an earlier draft that listed entries under the next board.
- **The per-element timeline is docked under the canvas, not on a separate tab.** The list is the summary, the timeline is the precise version. Two views over one record, one shared playhead. It collapses to a ruler-only strip.
- **Build on the shipped motion record.** The storyboard compiles into each layer's existing `animation` (whole-layer keyframes, In/Loop/Out moves, offset and window), which the engine already evaluates and paints. Today nothing in the app authors keyframes; this is their first author. No parallel render path.

---

## The model

### Elements and poses

A Frame keeps its one layer list, exactly as today. When a storyboard exists, the Frame also holds a **storyboard record**:

```
Storyboard {
  current: boardId
  boards: Board[]            // ordered; index = time order
  loopBack: boolean          // last board travels back to the first
}
Board {
  id
  hold: seconds              // how long the pose rests
  poses: { [layerId]: Pose } // absent layerId = element not on this board
  loops: Loop[]              // slice 2; moves that run while this board holds
  transition?: Transition    // into the NEXT board; absent on the last board unless loopBack
}
Pose {
  x, y, rotation, skewX?, skewY?, opacity,
  size                       // text: fontSize; shapes/images: w and h; paths: scale
  color?                     // solid paint only; gradients/patterns are shared fields
}
Transition {
  duration: seconds
  ease: MoveEase             // the shared ten-name vocabulary + custom bezier
  entries: { [layerId]: EntryExit }   // overrides for elements that appear here
  exits:   { [layerId]: EntryExit }   // overrides for elements that leave here
}
EntryExit {
  move: moveId               // from the shared moves gallery (In or Out kinds)
  duration?: seconds         // slice 2; absent = the transition's duration
  at?: seconds               // slice 2; offset inside the transition; absent = 0
  auto: boolean              // true = Sailor chose it; recompile may replace it
}
```

**Pose fields** are the only per-board fields. Everything else on a layer (text, font, tracking, strokes, effects, masks, gradient or pattern fills, cloner settings, group membership) is **shared**: one value for every board.

**Frame background** is a pose-like field on the Storyboard itself: `Board.bg?: Paint` for solid backgrounds, shared otherwise.

### Materialise the current board

The layer list always holds the current board's poses. Switching boards writes the current poses into the outgoing board, then applies the incoming board's poses onto the layers. Every existing tool — drag, inspector, agent ops, the poster sheet, templates — keeps writing plain layer fields and never learns that boards exist. This is the load-bearing implementation decision: it keeps the change small and keeps every consumer board-unaware.

Invariant on save: `boards[current].poses` equals the pose fields of the layers. A single function `capturePoses(layers) → poses` and its inverse `applyPoses(layers, poses)` own the pose field list.

### Presence

An element is **on** a board when `poses[layerId]` exists. Delete on a board with more than one board removes the pose (the element is no longer on this board). The layer panel shows off-board elements dimmed, with "Add to this board" and "Delete everywhere". A Frame with a single board keeps today's delete.

### Compile

Every change to the storyboard, or to a layer while a storyboard exists, recompiles each layer's `animation` record:

- **Timing.** Board start times are cumulative: `start[i] = Σ(hold[j] + transition[j].duration)` for `j < i`. Frame duration = the sum over all boards (+ the loop-back transition if enabled), written to the Frame's motion record. The Frame's master-clock override is set to this duration, so wired loops reconcile under it.
- **Travel.** For an element on boards `a` and `b` with nothing in between, one keyframe at the end of `a`'s hold and one at the start of `b`'s hold, values from the two poses, ease from the transition. Keyframes are relative to the layer's stored fields, which are the current board's pose, so `dx = pose.x − layer.x` and so on. Rotation takes the short arc.
- **Entries and exits.** An element absent from the first `n` boards gets `offset = start[n]` less the transition duration and an In move; absent from the last `m` boards gets a window end and an Out move. Default move per element kind (text: rise-and-fade; shapes and images: fade-and-scale; the brand kit may later supply a house default). Defaults carry `auto: true`; a hand-picked move is never replaced.
- **Gaps in the middle.** A layer has one on-screen window, so an element on boards 1 and 3 but not 2 cannot truly leave and re-enter. It compiles to opacity 0 across board 2 with the transition's ease in and out. The user sees a fade either way.
- **Loops (slice 2).** Each board loop compiles to a loop move with a time window = that board's hold, plus adjacent holds when the same loop is on consecutive boards.
- **What the user owns on the Motion side.** Boards own keyframes, offset and window. The user owns hand-picked In, Loop and Out moves. Automatic moves update on recompile.

Compile output is persisted, so the Frame node tile, the video bake and the Timeline clip play it without knowing about boards.

### Engine additions (all additive)

Slice 1:
- `LayerKeyframe` gains `scaleX`, `scaleY` (the unit state already has both), `color` (solid, interpolated in OKLCH) and `ease` widened from `linear | easeInOut` to the shared move-ease vocabulary. The evaluator's keyframe interpolation reads them; absent fields keep today's identity.
- Frame background colour interpolation between boards (solid only).

Slice 2:
- Loop moves gain an optional time window (`at`, `duration`) so a loop can start and stop at boards.
- In and Out moves gain an optional `at` offset and their own `duration` inside the transition.

Gradients, patterns and shader fills switch at the midpoint of the transition. Crossfading them is out of scope.

---

## The UI

### Entry

A Frame with no storyboard looks exactly as today. "Add board" sits at the bottom of the Layers tab and in the Frame toolbar. Pressing it creates board 2 as a copy of board 1, selects it, switches the left panel to the Story tab and reveals the docked timeline. Zero cost when unused.

### Story tab (left panel)

Rows alternate **board, transition, board, transition, board**, flowing down. A playhead rail runs down the left edge; drag it to scrub, the canvas follows.

**Board row:** thumbnail (cached still, rendered on change), name, hold time, a menu (duplicate, delete, rename). Under it, one line per loop running on this board (slice 2): "Title · loops · Wave · 1.5s", with the move pill opening the gallery. Selected board = the board the canvas shows.

**Transition row:** a slim connector between two boards with its length and an ease chip. Under it, one line per element involved:
- "Title · travels · 0.6s" — a matched element. Shown, not editable here; travel always takes the transition's length and ease.
- "Subtitle · enters · Rise · 0.6s" — an unmatched element with its move pill (opens the gallery) and its length (inherits the transition's; slice 2 lets it differ).
- "Logo · leaves · Fade · 0.8s".

Lines collapse to a count ("3 travel · 1 enters") past five entries until the row is opened.

Toolbar at the top: play/pause, time readout, "Loop back" toggle. Add board at the bottom.

### Docked timeline (under the canvas)

The existing DialKit-style timeline, docked as a bottom row of the stage while a storyboard exists, collapsible to a ruler-only strip. Whole piece at one scale by default; selecting a board highlights its span (hold plus neighbouring transitions) and moves the playhead to its hold start; "Fit" zooms to that span, "1×" returns.

Per element, one lane: the on-screen band, keyframe diamonds where poses change, In and Out pills inside the shaded transition spans, loop bars along the holds. Clicking a pill, bar or span selects that record and flips the inspector to Motion with its controls; the pill carries a small gallery menu so a type swap is one click. Offset and window handles are read-only while boards exist (boards own them). Slice 2 makes In and Out pills draggable inside their transition.

Lanes past the dock's height scroll inside it; lanes are ordered by first change, so the elements involved in the current transition sit on top.

### Inspector (right panel)

Design | Motion toggle stays. On the Design side the selected element's controls split into two groups: **"On this board"** (pose fields) and **"Every board"** (shared fields), so the model is visible. On the Motion side the selected move or transition shows its controls, the same ones the list lines expose.

### Canvas

Unchanged. Posing is dragging, resizing, rotating on the board you have selected, exactly like editing a Frame today. The stage bar shows which board is current.

---

## Rules that keep it coherent

- **One record, two views.** The list line and the timeline pill are the same entry. Editing either updates the other in the same tick. Selection is shared.
- **Undo.** The storyboard record and `current` fold into the Compositor's history snapshot and restore. Board switch, add, delete, reorder, and every pose edit are one undo step each. Restore re-materialises the current board.
- **Persistence.** `node.data.properties.sailor_storyboard` beside the existing `sailor_localLayers` and `sailor_motion`. Round-trips free through the node properties path; no schema change on the Python side.
- **Delete is board-scoped** once a second board exists (see Presence). The layer panel makes off-board elements visible so nothing is "lost".
- **Wired layers are static across boards** in slice 1 (they have no keyframe path). Selecting one on the Story tab says so.
- **Poster sheet and templates** keep working by construction: they write layer fields, the materialised board captures them.
- **The Frame node tile** plays the compiled piece on hover and loops as today; its still shows the board last selected.
- **Copy for people:** "Board", "Hold", "Transition", "enters", "leaves", "travels", "loops". "Move" keeps its existing meaning (a preset from the gallery). Sentence case, no identifiers.

---

## Slices

**Slice 1 — boards and travel (the magic moment).**
Storyboard record, materialise/capture, compile to keyframes and default entries/exits, keyframe engine additions (scaleX/Y, colour, ease vocabulary, background colour), Story tab with board and transition rows, docked timeline in read-and-select mode with board markers, inspector split, board-scoped delete, undo, persistence, node tile and video bake through the existing paths.

**Slice 2 — loops and precise timing.**
Per-board loops (loop time windows in the engine, loop lines on board rows, loop bars in the timeline), per-element `at` and `duration` for entries and exits (draggable pills), line collapsing past five entries, brand-kit default moves if the kit has them by then.

Out of scope for both: crossfading gradient or pattern fills, wired-layer poses, symbols across Frames, a "spin" travel mode for rotation beyond 180°, entries and exits with a stagger between elements.

---

## Testing

- **Compile is pure.** `compileStoryboard(layers, storyboard) → { animations, motion }` with no Vue or DOM. Unit tests: two-board travel produces two keyframes with the right relative values; three boards with a middle gap produce the opacity dip; absent-at-start yields offset + auto In; absent-at-end yields window end + auto Out; hand-picked moves survive recompile; short-arc rotation; loop-back appends the return transition; duration sum matches the motion record.
- **Materialise/capture round-trip.** `applyPoses(capturePoses(L)) === L` on pose fields, and shared fields untouched. A test enumerates the pose field list against the layer type so a new layer field cannot silently become per-board.
- **Engine parity.** Keyframes with no `scaleX/scaleY/color` render byte-identically to today (golden). New fields interpolate as specified; a pixel test on a colour tween at the midpoint.
- **Undo.** Add board → pose edit → undo → undo restores the single-board layer list and `current`, via the existing history harness.
- **E2E on the real Compositor** through `/dev/frame-lab`: add board, drag the title, play to the midpoint, pixel-diff against the two poses (title between them, subtitle partially faded). One control run with no storyboard pins the noise floor. Follows the frame-templates spec's pattern.
- **Owed, hands-on:** drag feel of the playhead rail and the docked timeline, which synthetic pointer events cannot prove.

---

## Open questions (none block slice 1)

- Whether the docked timeline should default collapsed on Frames with a single board or not appear at all. Current answer: not appear.
- How a storyboarded Frame is edited in place from the big Timeline. Reuses the state-source seam from the Space Type clip work; no change to this design.
- Whether a brand kit should carry default entry and exit moves. Deferred to the kit's own spec.
