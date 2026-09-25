# Frame — overlap fill

**Date:** 2026-09-24 · **Status:** design approved (prototype signed off), plan next

## What it is

A text crosses a shape, and the part of the text that sits over the shape takes a new fill.
Both layers keep their own look everywhere else. It is the classic poster move where a word
flips colour as it crosses a block.

The user signed off on the clickable prototype (`scratchpad/overlap-fill-prototype.html`, one
text over a circle and a rectangle).

## How it behaves

- Any layer that has something beneath it can switch on **Fill where it overlaps**.
- **Only over** defaults to **Anything beneath**, so one word can cross several shapes and
  flip on each one. The user can instead pick one layer beneath, and then only that overlap
  changes.
- The fill is any Frame fill (solid, gradient, shader, pattern, image) through the existing
  `FillControl`. It is not limited to a colour.
- The overlap is worked out afresh on every frame from what is actually drawn. Moving,
  animating or editing either layer moves the overlap with it, and nothing is cached against
  positions.
- Edges stay soft. The overlap's strength is this layer's alpha multiplied by the alpha
  beneath, so anti-aliased letter edges stay anti-aliased.
- The fill takes the layer's own opacity and is painted normally, never through the layer's
  blend mode, so the fill looks exactly as picked.
- What counts as "beneath": layers below this one that actually paint. Layers that are
  hidden, or used only as a mask source and not drawn, don't count. The Frame background
  never counts; otherwise everything would overlap.
- When turned on, the fill starts as a bright colour that contrasts with the layer. It never
  starts near-black: in the prototype a black default read as "nothing happened".
- The bottom layer shows a line saying there is nothing beneath it.

## Data

Local layers get one new optional field on `LayerCommon` (`useCompositorLayers.ts` ~342):

```ts
overlapFill?: {
  fill: Paint              // app/lib/compositor/paint.ts
  overKey?: StackKey       // unset = anything beneath; else 'l:<id>' / 'w:<slot>'
}
```

A layer without the field, or whose fill is empty (`!hasPaint(fill)`), is unchanged.

Wired layers carry the same shape as `WiredTreatment.overlapFill` (`useWiredTreatments.ts:7`),
persisted with the other treatments. `wiredMigration.ts` and the treatment → local remap in
`CompositorModal.vue` (~6665) copy it across the same way they copy `maskedByKey`.

If the layer chosen in `overKey` is deleted or no longer beneath, the setting falls back to
anything beneath. The stored value is left as it is, so undoing the delete brings the choice back.

## Rendering

All of it happens in `paintLayerStack` (`useCompositorLayers.ts` ~5904), the single painter
behind the editor, node preview, web export, motion bake, tiles and agent snapshots. Adding
it there once gives every output the effect with no extra wiring.

A new pure module, `app/lib/compositor/overlapFill.ts`, holds the compositing step:

1. `coverage` = this item drawn alone (`drawItemContent`) on a device-size offscreen canvas.
2. Multiply `coverage` by the **beneath** canvas (`destination-in`).
3. Paint the fill into what's left (`source-in` with `resolvePaint`, box = canvas, field =
   `_fieldCtx`).
4. Draw the result onto the main canvas at the layer's opacity.

**The beneath canvas.** This is built only when at least one item in the stack has an overlap fill:

- *Anything beneath:* one running union canvas. As the loop draws each painting item below
  the top-most overlap layer, it also stamps that item's content into the union. This
  doubles the drawing cost only for items below an overlap layer, and only in stacks that
  use the feature.
- *Only over one layer:* that item drawn alone.

**Where it hooks in.** Right after the item has painted, at the three points the survey found:
the local `drawOwn` path, the motion branch after `drawOwn`, and the wired `item.draw` path.
Early `continue`s (mask sources, hidden) skip it, which is correct because nothing painted.

## Inspector

A new **Overlap** `StudioSection` sits in the layer inspector next to **Mask and crop**, built
as its own component `compositor/CompositorOverlapPanel.vue` rather than more inline markup in
the modal:

- a **Fill where it overlaps** switch
- **Only over**: a select with *Anything beneath* plus each layer beneath, labelled by the
  layer's own content (the text itself, "Circle"), never by guessed roles
- `FillControl` for the fill

Copy is sentence case and shows no identifiers.

## Canvas agent

Add the op `setLayerOverlapFill { layer, fill | null, over? }` in
`app/lib/agent/surfaces/compositor.ts`: a one-line hint, an allowed-ops entry, a
layer-description field, a case in the apply switch and a diff-summary line. Keep the hint
short, because that file has a size budget (:798).

## Testing

- Unit: `overlapFill.ts` on small synthetic canvases. Check that overlap pixels get the fill,
  pixels outside keep the layer colour, soft edges multiply, and an empty fill is a no-op.
- Unit: the beneath union counts only painting items below and skips the background and
  mask-only sources, and the `overKey` fallback works.
- Unit: the agent op, following `agent-mask-break.unit.spec.ts`.
- Browser: in the Frame editor, a text over a shape with a real mouse drag. Confirm the overlap
  follows the drag, then check the pixels in the web export match (`frame-embed-parity`).

## Not in this change

- An "outside the overlap" (inverse) mode
- More than one overlap fill per layer
- Animating the overlap fill itself. Motion authoring stays in the motion surfaces.
