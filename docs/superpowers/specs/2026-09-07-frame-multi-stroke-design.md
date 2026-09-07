# Frame — multiple strokes, distance from the edge, shapes along the edge

Date: 2026-09-07
Status: approved (design), ready for planning

## What we're building

A Frame layer has exactly one outline today: `stroke` (a Paint), `strokeWidth`, and the optional
`strokeAlign` / `strokeDash` added later. Every kind paints it through one function,
`strokeAligned` in `composables/useCompositorLayers.ts`.

Three things change:

1. **A layer carries an ordered list of strokes**, not one. Each is independently coloured,
   sized and styled, and they paint in list order.
2. **Each stroke has a distance from the edge** — a true geometric offset, so a stroke can float
   8 px outside the shape with clean air between.
3. **A stroke can be drawn as shapes marching along the edge** instead of a continuous band:
   library shapes placed nose-to-tail around the outline, turning to follow it.

## Not building

- **Shapes marching along TEXT.** See "The text limit" below. Multiple strokes and distance
  DO work on text; only the marching-shapes style is shapes-only.
- Strokes on images, wired content or brush layers. Those have no known path — an outline there
  means tracing pixel alpha, which is its own job.
- **A stack on a line layer.** A line has no interior to offset from, so distance and alignment
  are meaningless on it. It reads through `strokeStackOf` as a one-entry list — so the painter
  stays uniform and has no special case — but the tree offers no plus-menu on a line, and its
  stroke stays in the inspector exactly as today.
- Per-stroke blend modes, opacity or effects. A stroke is paint on the layer, not a layer.
- Animating stroke dials. Layer motion only produces transform/opacity deltas today, so `radius`
  and `strokeDash` are already un-animatable; strokes join them. Not a new gap.
- Dragging a stroke row from one layer to another — the same limit the effect stack shipped with.

## How it reads

Each stroke is a **child row under the layer in the tree**, the pattern the effect stack landed on
2026-09-07 and the 3D treatments on 09-06: a hover plus-menu adds one, rows drag to reorder, and
the inspector shows only the selected stroke's dials under a breadcrumb. Row labels name what they
are — `Stroke · 2 px, 8 px out`, `Stroke · stars, 20 px out` — so a stack of four is legible
without opening each.

The first row in the list paints **on top**, matching the layer list's own convention.

A layer with no stroke has no stroke rows, and the inspector's Stroke section keeps its single
"Add" affordance, so a frame that never used more than one outline looks exactly as it does now.

## Data model

```ts
/** One outline on a layer. */
export interface StrokeInstance {
  id: string                    // stable, stamped on creation
  visible?: boolean             // absent ⇒ true, same convention as EffectInstance
  paint: Paint                  // colour | Gradient | Fill | ImageFill — the existing Paint union
  width: number                 // normalized to canvas width (path layers: local units, as today)
  /** How far the band's REFERENCE EDGE sits from the shape's own edge, in the same units as
   *  `width` — `align` then straddles that reference, see "Distance and alignment compose".
   *  0 = the shape's edge, i.e. today. Positive = outside, negative = inside. */
  distance?: number
  align?: StrokeAlign           // 'center' | 'inside' | 'outside', as today
  dash?: StrokeDash
  join?: StrokeJoin             // how the OFFSET treats corners — see below
  style?: StrokeStyle           // 'band' (default) | 'shapes'
  shapes?: ShapeStrokeSpec      // required when style is 'shapes'
}

export type StrokeJoin = 'sharp' | 'round'
export type StrokeStyle = 'band' | 'shapes'

export interface ShapeStrokeSpec {
  shapeId: string               // from lib/shapes/catalog (the 100-shape library)
  size: number                  // same units as `width` — normalized to canvas width, or a
                                //   path layer's local units, whichever that layer uses
  spacing: number               // centre-to-centre, same units as `size`
  /** true (default): each mark rotates to follow the edge. false: all upright. */
  follow?: boolean
}
```

The list lives on the layer as `strokes?: StrokeInstance[]`.

### Read-through, not migrate-on-load

**This is the call that made the effect stack safe and it applies unchanged here.** Stored layers
are read with a raw cast in several places and there is no sanitize step, so a migration would
rewrite every frame the moment it opened.

One pure function, `strokeStackOf(layer)`, returns any layer's ordered stroke list:

- New shape present and every entry id-stamped ⇒ return it.
- Otherwise fold the legacy fields into a **one-entry list**: `stroke` + `strokeWidth` +
  `strokeAlign` + `strokeDash` for rect / ellipse / polygon / star / path / line, and
  `strokeColor` + `strokeWidth` for text. A legacy stroke reads as `distance 0`, `style 'band'`.
- No stroke at all ⇒ an empty list.

`strokes` is written only when you edit a stroke, and the legacy fields are then dropped from
that layer. Nothing is written on open. This mirrors `effectStackOf` in
`lib/compositor/effectStack.ts`, including its "new shape AND a live legacy field ⇒ trust the
legacy branch" guard.

## The geometry

### Distance is an offset, not a scale

Scaling a shape to fake a distant outline gives a wider gap on the long side of any non-square
shape. That is wrong on every rect, and visibly wrong on text. The correct region for a stroke at
distance `d` with width `w` is:

```
dilate(shape, outer)  minus  dilate(shape, inner)
```

where `outer` and `inner` come from the distance and the alignment together — for `align: 'center'`
they are `d + w/2` and `d − w/2`; for `'outside'`, `d + w` and `d`; for `'inside'`, `d` and `d − w`.
A negative radius is an erosion rather than a dilation, which the next paragraph covers.

Canvas gives a dilation directly: `fill(path)` together with `stroke(path, lineWidth = 2r)` is
exactly the shape dilated by `r`, with `lineJoin` deciding the corner behaviour. So the band is
three raster steps on a scratch canvas — draw the outer dilation, `destination-out` the inner
dilation, stamp — which is the same scratch-and-knockout dance `strokeAligned` already performs
for `align: 'outside'`.

A **negative** distance (inside) is the same operation reflected: fill the shape, then
`destination-out` a centred stroke at `2|d|`, which leaves the erosion; the band is the difference
of two erosions.

`paintStrokeBand(ctx, { path | build, distance, width, align, dash, join, style })` replaces
`strokeAligned` as the single place any outline is painted. **At `distance 0` it must reduce to
the exact statements `strokeAligned` runs today** — that is the byte-identity claim below.

### Distance and alignment compose

They answer different questions, so both survive and neither is redundant:

- **`distance`** moves the *reference edge* — the curve the band is measured against — outward
  (positive) or inward (negative) from the shape's own edge.
- **`align`** then says how the band of `width` straddles that reference edge, exactly as it does
  today: `center` half either side, `inside` entirely within it, `outside` entirely beyond it.

`distance 0` with any `align` is therefore precisely today's behaviour, which is what makes the
byte-identity claim below reachable. A new stroke added from the tree starts at `distance 0`,
`align: 'center'`.

### Corners: Sharp by default

`join: 'sharp'` (canvas `lineJoin: 'miter'`) keeps a star's spikes as spikes and a rect's corners
square — the offset outline keeps the shape's character, which is what stacking outlines is for,
and it is what Illustrator's Offset Path defaults to. `join: 'round'` is the literal reading of
"distance from the edge": every point exactly `d` away.

Canvas's default `miterLimit` of 10 already bevels a spike that would shoot out absurdly far, so
Sharp needs no extra guard — but the plan should pin that behaviour with a case on a thin star at
a large distance, because a changed `miterLimit` elsewhere would silently alter it.

### Text comes along free

The dilation is raster, so `fillText` + `strokeText(2r)` produces a text band exactly as
`fill` + `stroke` produces a shape band. Text needs no separate path; it needs only for `drawText`
to route through `paintStrokeBand` with its own `build` callback.

## Shapes marching along the edge

The offset outline is **flattened to a polyline**, that polyline becomes a `Guide` — the
arc-length-and-tangent object `lib/compositor/textPath.ts` already exposes via
`guideFromPolyline(points, closed)` — and shapes are placed along it at `spacing`, each rotated to
the tangent when `follow` is true.

Offsetting a **polyline** is the easy half of the offset problem: each vertex moves along its
angle bisector. (Offsetting a bezier path is the hard one, which is why
`lib/vectortype/extrude.ts` says out loud that a true outline offset "needs a library paper 0.12
does not have".) Concave corners at large distances can self-cross; at the distances a stroke
actually uses this is not visible, and the plan should measure where it starts to be rather than
pre-emptively building a cleanup pass.

Marks are painted with the stroke's own `paint`, so a shape stroke can be a gradient or a fill
like any other.

**Spacing is walked in arc length and closed**, so the last mark does not overlap the first: the
count is `round(perimeter / spacing)` and the actual step is `perimeter / count`. Asking for a
spacing the perimeter does not divide evenly gives evenly-spread marks at close to the requested
spacing, never a visible seam.

### The text limit

A shape has an exact path to flatten. The Frame's text layer stores only a CSS `fontFamily`
string — it has no glyph outlines, unlike Vector Type, which loads real font files through
fontkit. Marching shapes around lettering would mean either pulling that font resolution into the
Frame or tracing the rasterised text with a contour walk. Both are their own job.

**So: multiple strokes and distance work on text; `style: 'shapes'` is offered only on closed
shapes.** The style select does not appear in a text layer's stroke inspector, and
`strokeStackOf` never produces a shapes stroke for text.

## Every consumer that has to move

The stroke is read in more places than the painter, and missing one is how this ships broken:

| Where | What changes |
| --- | --- |
| `drawLayerContent` (rect, ellipse, polygon, star) | loop the stack instead of one `strokeAligned` |
| `drawPath`, `drawText` | same |
| `outsideStrokePadPx` | the pad is now `max(0, distance + width)` over the whole stack, not a single `align === 'outside'` test — it is the padding a corner-pin or DOF offscreen needs, so a distant stroke clipped at the offscreen edge is the first bug this prevents |
| `localLayerBox` | **unchanged, deliberately.** It excludes stroke today (see its own "no stroke padding" note); widening it would move the selection handles on every already-stroked layer in every saved frame — a visible change nobody asked for. A distant stroke therefore paints outside its selection box, exactly as an outside-aligned stroke already does. |
| `lib/compositor/silhouetteCache.ts` | the torn-edge / feather silhouette reads `strokeAlign` today |
| `layerToVector` (the SVG export descriptors) | one `<path>` per band stroke; a shapes stroke writes its marks as paths |
| `lib/agent/surfaces/compositor.ts` | `strokeField` returns a single field name today; the describe pass reports one stroke |
| `CompositorModal.vue` | tree rows, the plus-menu, the breadcrumb inspector, `hasStroke`, `setStroke` |
| `StrokeStyleRow.vue` | gains distance, join and style |

The SVG export of a **band at a distance** is the one place that cannot be exact: the offset
geometry exists as raster, not as a path. The export writes the stroke at its stored width on the
un-offset path and the writer's existing degrade-notice path reports it, rather than silently
lying. (`Compositor's SVG writer degrades silently` is already carried debt; this does not make it
worse, and the notice is the smallest honest answer.)

## Testing

1. **Byte-identity, first and loudest.** A real-canvas A/B at device pixel ratio 2 over a frame
   holding every stroked kind — rect, ellipse, polygon, star, path, text, line — with today's
   single-stroke fields, rendered through the old painter and the new one: **0 px different on
   every case**. Run it RED first against a deliberately broken `paintStrokeBand` so it is known
   to be able to fail. This is the test that caught a one-pixel edge move on the effect stack.
2. **Read-through, pure.** `strokeStackOf` on: a legacy stroked rect, a legacy stroked text, a
   layer with no stroke, a new-shape layer, and a new-shape layer that also carries a live legacy
   field. Plus the promise that reading a legacy layer and never editing it writes nothing.
3. **Distance, measured.** A rect with a 2 px stroke at distance 20: the painted ring's inner
   radius is 20 px from the shape edge, on all four sides, measured off the pixels — not
   eyeballed. Both signs, and Sharp versus Round on a star.
4. **Order.** Three strokes of different colours; the first row's colour is the one on top where
   they overlap.
5. **Shape stroke.** N marks around a circle for a given spacing, the count matching
   `round(perimeter / spacing)`; `follow: false` leaves every mark at the same angle; the marks
   take the stroke's paint.
6. **Reach.** A layer with a distant stroke inside a corner-pin: the stroke is not clipped at the
   offscreen edge. This is the assertion that pins `outsideStrokePadPx`.
7. **Live, in a real browser.** Add three strokes from the tree, drag to reorder, set a distance,
   switch one to shapes — asserting the canvas pixel hash CHANGES on each edit and RESTORES
   exactly on undo. Dials that only store their value are the recurring failure here; every dial
   is chased to the leaf it writes.

## Risks

- **A missed consumer.** Nine of them, above. The reach and silhouette entries are the two that
  fail silently — they produce a slightly wrong box, not an error.
- **Byte-identity.** The refactor of `strokeAligned` touches the one function every outline in
  the product goes through. Test 1 is the whole defence and it must run red first.
- **Shared-file staging.** `CompositorModal.vue` and `useCompositorLayers.ts` are the two files
  parallel sessions collide on; whole-file staging swept hunks both ways on 09-07. Every commit
  in this work stages its own hunks under a private `GIT_INDEX_FILE`.
- **Polyline offset self-crossing** on concave corners at large distances. Measure where it
  starts; do not pre-build a cleanup pass.
- **Row crowding.** A layer can now have effect rows and stroke rows. Worth looking at with three
  of each before calling it done.
