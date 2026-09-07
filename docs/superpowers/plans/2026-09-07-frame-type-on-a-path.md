# Plan: Frame — type on a path

Spec: `docs/superpowers/specs/2026-09-07-frame-type-on-a-path-design.md`

## Task 1 — Guide engine, parametric sources  (`app/lib/compositor/textPath.ts`)
`TextPathSpec` type, `Guide` interface, `guideFromSpec(spec, W)` for
follow = curve | circle | wave, wrapping `lib/vectortype/curve.ts`.
Must extrapolate past both ends along the terminal tangent (curve.ts clamps).
Guides are built in PIXEL space (local units × W). Unit tests.

## Task 2 — Glyph placement  (same module)
`placeGlyphs(ctx, layer, guide)` — cumulative-prefix advances (kerning-safe),
half-advance centres, fit / start / side / shift / align. Unit tests with a
stub measuring context.

## Task 3 — SVG `d` flattener  (`app/lib/compositor/pathFlatten.ts`)
`flattenPath(d) -> {x,y}[]` for M L H V C S Q T Z, adaptive subdivision.
`guideFromPolyline(pts, closed)` in textPath.ts. Unit tests.

## Task 4 — Layer type + renderer wiring  (`useCompositorLayers.ts`)
`TextLayer.path?: TextPathSpec`; `drawText` early branch; `localLayerBox`
branch; fills resolve against guide bounds.

## Task 5 — Shape + drawn-path sources
`follow: 'shape'` via `lib/shapes/pathLayer.ts shapeGeometry`; `follow: 'custom'`
via a stored `d`. Both through Task 3's flattener.

## Task 6 — Inspector  (`CompositorModal.vue`)
Path section; hide box W/H, V-align, justify, Expressive when a path is active.
Sentence-case labels, `optionLabels` on every select.

## Task 7 — Guide overlay while selected

## Task 8 — Pen into guide mode (draw your own)

## Task 9 — Agent surface + live verification in the browser
