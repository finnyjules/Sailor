# Frame drag-to-generate element — design

**Date:** 2026-09-09
**Surface:** Frame / compositor (`CompositorModal.vue`)
**Status:** design, pending user review

## What we're building

A first-class **Generate** gesture on the Frame: drag out a box, type a short
prompt, pick a visual **style**, and an AI-generated subject arrives **cut out on a
transparent background** as a normal image layer you can move and scale.

## Key context: this is a re-surfacing, not a new engine

The generation + transparent-cutout pipeline already exists as the buried
"Generate in region" flow (toolbar **AI ✦ → Region**, `genActive` in
`CompositorModal.vue:4150–4720`). It already: drags a box (`genTool:'box'`),
picks a trained style (`genStyle`), generates, then
`removeBackground → cleanCutoutAlpha → uploadDataUrl → addImageFromName`, yielding
a transparent `ImageLayer`. It is wrapped in a right-hand panel with **Style/Scene**
mode, **Flux/Nano** model, and **box/brush/shape** sub-tool toggles, and is reached
only after opening an AI menu.

This design keeps that engine and re-surfaces it as a direct canvas gesture with a
minimal on-box bar, hiding the mode/model/sub-tool machinery behind defaults. It
does **not** rebuild generation, background removal, or alpha cleanup.

## UX placement (per the Frame UX rule)

The Frame rule: *elements are added from the toolbar; the inspector tunes the
selection; the no-selection panel tunes the frame; creation never lives as a fat
right-panel generator.* This design honors it:

- **Creation is a toolbar tool** ("Generate"), armed like Brush.
- **The pending element is tuned by a minimal on-box bar** (prompt + style + Generate),
  not a right-panel generator.
- Once generated, the result is an ordinary image layer tuned by the normal inspector.

## Interaction model

### Two entry points, one gesture

1. **Toolbar** — a **Generate** button as its own top-level item in the toolbar (a
   mode, not a stamp, so it stands alone rather than living in Shapes/Insert). Click
   to **arm** (sticky mode, like the Brush tool). Cursor indicates generate mode.
2. **Hold Option/Alt + drag** — spring-loaded, like holding `Space` to pan. While
   Option is held, an empty-space drag is a generate-box instead of a marquee-select.

Both converge on the identical flow below.

### Coexistence with Select (the load-bearing decision)

- **Select is the default and is not changed.** Empty-space drag = marquee-select;
  drag-on-layer = move. Untouched.
- The Generate gesture only owns the canvas **while its tool is armed** — either the
  sticky toolbar arm, or for the duration of an Option-held drag. This mirrors the
  existing tool pattern (`brush.active`, `drawSectionActive`, `spaceDown`), where a
  tool "owns the canvas" only while active and `isSelectTool` = none active.
- **Option scope:** Option+drag arms generate only for **empty-space** drags (same
  hit-test as marquee-select). Option+drag *on a layer* is left free for a future
  duplicate gesture.
- **Spring-loaded release:** if Option is released **mid-drag**, the gesture stays
  alive until the mouse is released (matches Space-pan), so a quick tap-and-drag
  isn't cut off.

### The gesture, step by step

1. Arm (toolbar click) **or** press-and-hold Option.
2. **Drag a box** on empty canvas. A live rubber-band preview draws (the existing
   `marquee` / `startMarquee` / `moveMarquee` primitive that Draw-section reuses),
   so it reads as "defining a region," not "selecting."
3. On mouse release, reject click-sized drags (reuse Draw-section's
   `wN < 0.005 || hN < 0.002` guard). A valid box shows a **floating bar anchored to
   the box** (same anchoring idiom as the inpaint on-selection prompt bar): 
   - a **prompt** text field (autofocused),
   - a **style preset picker** (thumbnail + name, from `useStyleList`),
   - a **Generate** button.
4. **Generate** runs the existing `generateObjectInto`-style path with fixed defaults
   (below), producing a transparent cut-out.
5. The result is added as a transparent `ImageLayer` fitted to the box, with the
   existing **re-roll ↺ / confirm ✓ / cancel ✕** mini-bar.
6. On **confirm** (or **Escape**), the tool **disarms back to Select**. Sticky toolbar
   arm persists across generations until Escape/confirm; Option-hold disarms when the
   gesture ends.

## Defaults that replace the hidden machinery

The on-box bar exposes only prompt + style + Generate. Everything else is a default:

- **Model:** Flux (the model that supports trained styles). Nano/Scene not shown.
- **Path:** the object/style transparent-cutout path — `loraGen` when a style is
  selected, else `text2img` — then `removeBackground → cleanCutoutAlpha`. (Same
  branches as `generateObjectInto`, minus the Scene/Nano branches.)
- **Sub-tool:** box only (brush/shape sub-tools are not part of this gesture).
- **Prompt:** **required** — Generate is disabled until the prompt is non-empty.
  (A style is a look, not a subject; a subject needs words.)
- **Style:** **optional** — no style selected = plain `text2img` look. The picker
  defaults to "No style."
- **Generation hint:** keep the existing "isolated on a plain solid background"
  prompt suffix that makes the cutout clean.

## What we reuse (no changes)

- `startMarquee` / `moveMarquee` / marquee overlay — the drag box + preview.
- Draw-section's grid-snap-optional + min-size guard for finishing the box.
- `generateObjectInto`'s generator selection and the
  `removeBackground → cleanCutoutAlpha → uploadDataUrl → addImageFromName` tail.
- `useStyleList` for the style presets.
- `addImageFromName` → transparent `ImageLayer`.
- The re-roll/confirm/cancel mini-bar (`genResult`, `rerollObject`, `confirmObject`,
  `cancelObject`).

## What we add

- A **Generate tool** state (arm/disarm), wired into the toolbar cluster and the
  canvas pointer dispatch (a new branch in `onCanvasPointerDownCapture`, ordered
  with the other tool branches).
- The **Option-hold** modifier: an `optDown` ref (mirroring `spaceDown`) set in
  `onKeydown`/`onKeyup`, gating the empty-space drag into generate mode; keep-alive
  on mid-drag release.
- A **floating on-box bar** component (prompt + style picker + Generate), anchored to
  the pending box, reusing the inpaint prompt-bar anchoring idiom (flip above when
  near the bottom edge).
- A cursor/affordance change while armed.

## Scope / non-goals

- The existing AI ✦ → Region panel is **left intact** this pass (it still offers
  Scene mode, Nano, and brush/shape for power users). Consolidating or retiring it is
  a **follow-up**, not part of this change — avoids a large refactor and keeps the
  streamlined gesture additive.
- No new server routes or models: this rides the existing `/api/inpaint/*` calls.
- No pricing/cost-gate change: these routes are metered by rate-limit + provider
  billing, as today.

## Resolved decisions

1. **Toolbar home:** its **own top-level toolbar button** — it's a mode, not a stamp,
   so it stands alone rather than nesting in Shapes/Insert.
2. **Style picker contents:** trained styles from `useStyleList` only (plus the
   "No style" default), matching today. No separate built-in non-LoRA look set.
3. **Persistence while armed:** keep the **last-selected style** between generations;
   **clear the prompt** each time so the next box starts fresh.
