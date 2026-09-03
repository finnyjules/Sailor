# Compositor — mask break-out (partial shape mask) — design

Date: 2026-09-03
Status: Approved (design agreed in-session), implementing
Follow-up to the shape library (five sub-projects landed 2026-09-02). The shapes are now usable
as masks; this adds the "break the frame" partial mask.

## Plain-language summary

Mask a subject inside a shape — a person inside a circle — but let one edge **open** so part of
him escapes: his head pops out over the top of the circle while the bottom still clips him. This
is the editorial "out of bounds" look. It is not a soft or variable-strength mask. It is a mask
whose boundary is **the shape plus an opening on one side**.

The opening is a **break line**: everything on the open side of the line is released (the subject
shows freely there); everything on the closed side stays clipped to the shape. "Pops out the top"
is a horizontal line at the shape's top with the release side up.

## How it works (the one mechanism)

Every silhouette mask in the Compositor renders the same way (`drawLocalLayer` for a local layer
masked by a local shape; `drawItemMasked` for the cross-source case): render the subject to an
offscreen, render the mask shape's alpha to a second offscreen, then `destination-in` keeps the
subject only where the mask has alpha. The break-out adds one step: **before the destination-in,
fill the mask offscreen with full alpha on the release side of the line.** The effective mask
becomes `shapeAlpha ∪ releaseHalfPlane`, so the subject survives inside the shape and everywhere on
the open side. One subject, one mask, no duplicated layer, no seam. Static geometry only (matches
the existing mask-motion limitation — an animated masked layer already renders unmasked per frame).

## Data

New optional field on the masked layer (`LayerCommon`), present only alongside `maskedByKey`:

```ts
maskBreak?: {
  x: number      // a point the break line passes through — normalized canvas (0..1 of W / H)
  y: number
  angle: number  // line rotation in degrees; 0 = horizontal. Release side is the +normal side.
}
```

The release half-plane: normal `n = (sin(angle), -cos(angle))` (points "up" at angle 0); a canvas
point `p` is released when `dot(p − (x,y), n) > 0`. Absent ⇒ today's full mask, byte-identical.

## Rendering

A shared pure helper `frontend/app/lib/compositor/maskBreak.ts`:

```ts
export interface MaskBreak { x: number; y: number; angle: number }
/** Fill the release half-plane with opaque white on the mask offscreen, in the SAME
 *  transform the mask silhouette was drawn under (logical W×H). No-op if break is null. */
export function paintMaskRelease(mctx: CanvasRenderingContext2D, break_: MaskBreak | null | undefined, W: number, H: number): void
```

It clips `mctx` to the half-plane (a large polygon past the canvas bounds, from the line and its
normal) and fills white. Called in both mask paths right after the mask silhouette is drawn and
before the `destination-in`. The masked layer passes `layer.maskBreak` to both painters.

## Inspector (Mask section, `CompositorModal.vue`)

When the selected layer has a shape mask (`maskedByKey` set), a **Break out** toggle appears. On:
- **Edge** segmented control (Top / Bottom / Left / Right) sets `angle` and the default `x,y` to
  the shape's corresponding extreme (Top ⇒ angle 0, line at the mask's top; Left ⇒ angle 90; …).
- **Offset** slider moves the line along its normal (0 = shape edge, positive = into the shape).
- **Rotate** slider adjusts `angle` for a diagonal break.
- An on-preview draggable line is the intended polish (loft-spine precedent) but is a **fast-follow**;
  v1 ships the three controls.

## Agent

New op `setLayerMaskBreak` in `lib/agent/surfaces/compositor.ts`: `target = layer id; args:
{ edge: 'top'|'bottom'|'left'|'right', offset? (0..1), remove? }`, resolved to `maskBreak` from the
mask's bounds. Hint: "Let a masked subject BREAK OUT of one edge of its shape — the head pops over
the top while the rest stays clipped. Needs a layer already masked to a shape." So "let his head pop
out the top" works. `describeCompositor` reports `maskBreak` on masked layers; `summarize` labels it.

## What stays identical

`maskBreak` absent ⇒ every mask renders exactly as today (the paint helper is a no-op). Layers with
no shape mask never show the control. Export and the bake use the same render path, so the effect is
in the exported frame for free.

## Testing

- `mask-break.unit.spec.ts` (happy-dom, recording ctx) — `paintMaskRelease(null)` is a no-op;
  angle 0 releases the top half (a fill clipped to y < line); angle 90 releases the left; the offset
  moves the line; the clip polygon covers past the canvas so no gap at the edges.
- `compositor` agent spec — `setLayerMaskBreak` sets `maskBreak` from edge+offset, `remove: true`
  clears it, rejects a layer with no `maskedByKey`; describe/summarize.
- Round trip: `maskBreak` survives JSON persistence.
- Live: drop a photo, drop a Circle shape from the library, use it as the photo's mask, turn on
  Break out → Top, drag Offset so the head clears the circle: the head shows above the ring, the body
  stays clipped. Bake shows it.

## Fast-follows (not v1)

On-preview draggable break line; the additive brush release (paint an arbitrary opening, boolean-
unioned into the mask) for non-straight break-outs; break-out under motion.
