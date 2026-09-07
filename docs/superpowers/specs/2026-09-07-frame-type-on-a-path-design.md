# Frame: type on a path

**Date:** 2026-09-07
**Status:** approved, ready to plan

## What we're building

A Frame text layer can be told to follow a curve instead of sitting on flat
baselines. Five curve kinds, one engine:

| Follow | What it is | Covers |
|---|---|---|
| Curve | One bend dial: flat → arch → full ring, keeping the run's length | the "simple curve dial" ask |
| Circle | An explicit ring — radius, start angle, inside/outside | badges, seals, stamps |
| Wave | Amplitude + frequency | free, since the sampler already has it |
| Shape | The outline of any shape in the library | type around a star, blob, polygon |
| Draw | A path drawn with Frame's existing pen | anything else |

The curve is an **invisible guide owned by the text layer**. It adds no entry to
the layer list, appears as a thin line only while the text is selected, and dies
with the layer. Someone who also wants the ring drawn adds a shape layer.

## The idea that holds it together

A **guide** is anything that can answer one question: *where are you at distance
`s` along your length, and which way are you pointing?* Placement never learns
which of the five kinds it is drawing along, so a sixth kind is a new guide
source and nothing else.

```ts
interface Guide {
  readonly length: number
  readonly closed: boolean
  at(s: number): { x: number; y: number; angle: number }
  bounds(): { w: number; h: number }
}
```

Two sources build one:

1. **Parametric** — wraps `app/lib/vectortype/curve.ts` (`buildCurveTable` /
   `pointAtLength`), which is pure, tested, and already does correct arc-length
   inversion. Covers Curve, Circle, Wave.
2. **Outline** — flattens an SVG `d` into a polyline and builds the same
   cumulative-length table. Covers Shape and Draw. This is the only new
   geometry; `app/lib/vectortype/pathLength.ts` already runs this algorithm over
   a different input.

`curve.ts` clamps `s` past either end. A guide must **extrapolate** along the
terminal tangent instead, or every overflowing glyph piles up on the last point.

## Placement

`placeGlyphs(ctx, layer, guide, W)` returns `{ ch, x, y, angle, advance }[]`.

- **Advances come from cumulative prefixes** — `width(text.slice(0, i+1)) −
  width(text.slice(0, i))` — not from measuring each character alone. Isolated
  measurement drops every kerning pair, which is why cheap text-on-path looks
  loose. Prefix measurement also picks up `ctx.letterSpacing` and the live
  variable-font axes for free, because `applyFont` has already run.
- Walk the run, place each glyph centre at its accumulated **half-advance**,
  rotated to the tangent there.
- **Fit** (a switch): off, the run starts where you put it and carries straight
  on past the end of the path. On, one uniform delta is added to every gap so
  the run fills the guide exactly, end to end.
- **Start** slides the run along the path, 0–1 of its length.
- **Align** maps onto the path — left/centre/right become start/middle/end. No
  new control.
- **Side**: `inside` reverses the walk and flips each glyph a half turn, so type
  reads correctly along the bottom of a ring.
- **Shift** offsets the baseline perpendicular to the tangent.

## What path mode switches off

Hidden in the inspector, not greyed, per the control-relevance rule: multi-line
wrapping, text box W/H, V-align, justify, Expressive layout. Newlines become
spaces. Underline and strikethrough are **out of scope for v1** — on a curve
they stop being rectangles and become stroked path segments, a separate job.

## Integration points

- `TextLayer` gains one optional field, `path?: TextPathSpec`. Absent means the
  layer renders byte-identically to today.
- `drawText` (`useCompositorLayers.ts`) takes an early branch when `path` is set.
- `localLayerBox` needs a matching branch returning the guide's bounds inflated
  by the font size. Without it, selection, dragging, rotation, masks and effects
  all misbehave on curved text — invisible work that would otherwise ship broken.
- Fills resolve against the guide's bounds, so gradients and pattern fills still
  fit sensibly.
- Inspector: a new "Path" section in the text block of `CompositorModal.vue`.

## Phasing

1. **Engine + parametric guides** — Curve, Circle, Wave. Two of the four asks,
   no new geometry.
2. **Outline guide** — SVG `d` flattener + the shape library as a source.
3. **Draw** — the existing pen, in a mode that stores its `d` on the text layer
   rather than creating a path layer.

## Non-goals

- The old `app/utils/textOnPath.ts` ComfyUI widget stays where it is. It becomes
  safely retirable once phase 2 lands.
- No on-canvas drag handles. Dials only, plus the guide drawn while selected.
- No per-glyph manual nudging.
