# Frame brush — steadying and hold to snap

Date: 2026-09-26 · Status: prototype approved by Julien ("that's great, just have these controls in the inspector when i'm in brush mode")
Builds on: `2026-09-26-frame-brush-tips-design.md` (Part 1: tips, saved movement) and Parts 2–3
Prototype: `docs/superpowers/specs/assets/2026-09-26-brush-steady-prototype.html` (https://claude.ai/artifact/DDtooPF759h2x2cy1S55Jp)
Idea source: Procreate's StreamLine, Stabilisation, Motion filtering and QuickShape.

## In plain words

Two additions to the Frame brush, for a trackpad hand.

1. **Steadying.** The brush is steadied before it paints. This applies to every tip (spray can, round, bristle), in Paint and Effect mode, including the eraser.
   - **StreamLine:** the brush trails your finger a little and catches up, so curves come out smooth. When you lift, it quickly finishes the line to where you stopped.
   - **Stabilisation:** averages the path, so slow, careful strokes lose their wobble.
   - **Motion filtering:** removes small jitter without adding lag to fast strokes.
2. **Hold to snap** (Round and Bristle only). Stop at the end of a stroke and keep holding.
   - A small ring fills around the cursor while you hold. Then the stroke becomes a clean **line**, **arc**, **ellipse**/**circle** or **shape** (a straight-sided polygon or open polyline that keeps your corners), and a small tag names it.
   - While you keep holding, moving adjusts it: a line's or arc's end follows you, and an ellipse or closed shape turns and resizes around its centre. **Shift** makes a perfect circle, or snaps a line to 15° steps.
   - Letting go commits it. One undo removes the whole stroke.
   - A stroke that isn't close to any clean shape stays as drawn.
   - The spray can never snaps, because holding still there already means "pool, then drip".

The controls sit in the right-panel inspector in brush mode, under the tip's settings, as their own **Steadying** section.

## Decisions

1. **What a stroke saves.** A stroke saves the **steadied** path: what you saw is what's kept. A snapped stroke saves the shape's path, drawn at an even speed (the stroke's median speed, so bristle keeps an even width).
   - The saved record is unchanged (`TipStroke`, v 1). Replay stays deterministic, and live equals replay by construction.
   - Changing the steadying settings affects the next stroke only, like the tip settings.
2. **Where it runs.** Steadying works on screen pixels, since it's about your hand, before conversion to Frame units. Snapping fits shapes in screen pixels too, then converts the shape's points. Both live in pure modules: `lib/brushTips/steady.ts` and `lib/brushTips/quickShape.ts`, ported from the prototype.
   - The Frame's existing hold loop drives StreamLine's catch-up and the hold timer.
   - On release, the catch-up runs for at most 350 ms, then the stroke commits. A spray stroke's drips then run as today.
3. **One set of settings for all tips**, persisted in `sailor.brushTips.v1` under `steady`. Defaults are the prototype's:

   | Setting | Default |
   |---|---|
   | StreamLine | 30% |
   | Stabilisation | 15% |
   | Motion filtering | 40% |
   | Hold to snap | on |
   | Hold time | 0.63 s |

   Reset restores them.
4. **Inspector.** A **Steadying** section in the brush inspector with:
   - StreamLine, Stabilisation and Motion filtering (0–100%);
   - a Hold to snap switch;
   - Hold time (0.25–1.00 s, shown in seconds; hidden when Hold to snap is off);
   - Reset.

   Explanations are tooltips, per the rule that panels show labels and values only. The prototype's "Steadying On/Off" and "Show my hand" were for comparing, and are not carried over.
5. **Snapping replaces the live stroke's samples.**
   - `useBrushPaint` gains `replaceTipSamples(samples)`.
   - The live-prefix cache in `coverage.ts` must not reuse a prefix built from the samples that were replaced. Its `usable()` check must see the change.
6. **On-canvas feedback:**
   - the hold ring, shown after 150 ms still and filling up to the hold time;
   - the shape tag near the cursor ("Line", "Arc", "Ellipse", "Circle", "Shape"), shown while the snap is held and hidden on release.

   There is no hand trail and no tether line.
7. **Mask mode** (legacy dabs) is unchanged.

## Out of scope

- Editing a snapped shape after release (Procreate's "Edit shape" handles).
- Per-tip steadying settings.
- Pressure simulation from speed. Bristle already thins with speed.

## Testing

- **Unit:**
  - steady.ts: settings at 0 pass samples through untouched; jitter drops; catch-up converges.
  - quickShape.ts: synthetic wobbly line, arc, ellipse, circle, triangle and scribble → the right kind or none; adjusting while held; Shift.
  - `replaceTipSamples`, and the live-prefix cache invalidating on replacement.
  - Persistence and reset.
- **Browser (real mouse, running app):**
  - a wobbly round stroke with StreamLine on is smoother than with it off;
  - a held line snaps and saves as a straight stroke;
  - a held loop becomes an ellipse; Shift gives a circle;
  - dragging while held resizes it;
  - the spray can doesn't snap;
  - one undo removes a snapped stroke;
  - reload redraws identical pixels;
  - the inspector section appears in brush mode.
