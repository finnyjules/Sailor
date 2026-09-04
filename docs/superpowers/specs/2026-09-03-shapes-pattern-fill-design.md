# Shapes as a pattern fill — design

Date: 2026-09-03
Status: Approved (design agreed in-session), implementing
Follow-up to the shape library. Adds a sixth consumer: the 100 shapes tiled as a repeating fill.

## Plain-language summary

Fill anything — a shape, text, a box, a background — with a **repeating library shape**: a field of
sparkles, a grid of leaves, tiled suns. A new fill type `shapes` sits beside solid / gradient /
grid / stripes in the one shared fill editor, so it works in every studio that edits a fill
(Compositor, Vector Type, Shape Studio, Space Type) for a single addition. v1 is the plain
single-shape grid; per-cell scatter, rotation jitter and multiple shapes per tile are follow-ups.

## Why one addition reaches everywhere

Every surface edits a fill through `FillControl.vue` and paints it through `fillTileCanvas` /
`fillTileBox` (`lib/spacetype/fillTile.ts`) via `resolvePaint`. A `Fill` is one arm of the
Compositor's `Paint`. So a new `FillType` plus a branch in the two tile builders lights up shape
pattern fills across the app at once, and the shared editor gets one new control (a shape picker).

## Data

`FillType` gains `'shapes'`. `Fill` gains an optional field:

```ts
shapeId?: string   // a shape-library id; only read when type === 'shapes'
```

`normalizeFill` carries `shapeId` through (string, else the default `'sparkle'`), so it survives
persistence. `a` = the shape colour, `b` = the background (`'none'`/`''` ⇒ transparent tile — the
common "sparkles on nothing" case), `angle` = per-shape rotation (degrees), `density` = shapes
across the tile (1 = one big shape, 32 = dense).

## Rendering (the two tile builders)

Both `fillTileCanvas(fill, size)` (the square swatch / repeat cell) and `fillTileBox(fill, w, h)`
(the box-fitted tile) gain a `'shapes'` branch, mirroring the `grid` branch:

- `d = clamp(round(density), 1, 32)`; `cell = size/d` (or `W/d`, square).
- Background: if `b` is a colour, `fillRect` the tile with `b`; if `b` is `'none'`/`''`, leave it
  transparent (`createPattern` preserves alpha).
- For each of the `d×d` cells, draw the shape with `drawShape(ctx, shape, { x, y, w, h, fill: a })`
  (`lib/shapes/path2d`), fitted into the cell inset by a small padding (~12%), optionally rotated by
  `angle` about the cell centre.
- Shape resolved by `shapeById(fill.shapeId)`; unknown ⇒ fall back to `'sparkle'`, never throw.

`drawShape` is browser-only (`Path2D`) — both builders already run in the browser (they
`createElement('canvas')`), so this is safe. The pattern tiles seamlessly because each shape sits
fully inside its padded cell.

## Export

The canvas paths (preview, bake, PNG) are correct everywhere once the two builders branch. For SVG,
`paintToVectorPaint` (`lib/paint/toVector`) must return a **raster tier** for `type === 'shapes'`
(an explicit `null`/raster branch), so the SVG export bakes the tile to a raster `<pattern>` (tiled,
correct) rather than mis-emitting. A true vector `<pattern>` holding the shape's `<path>` is a
follow-up.

## Editor (`FillControl.vue`)

- `'shapes'` added to `FILL_TYPES` (and thus the type dropdown; still excluded when `nested`).
- When `fill.type === 'shapes'`: a **shape** picker (reuse `ShapePicker` / the `shape` control) sets
  `shapeId`; the existing A (shape colour) and B (background, with none) StudioColors show; `angle`
  (rotation) and `density` (count) sliders show. `needsAngle` and `needsDensity` include `'shapes'`.
- The swatch preview already calls `fillTileCanvas`, so it renders the pattern for free.

## Agent

`describeCompositor`'s `paintLabel` names a shapes fill readably ("sparkle pattern"). `setFill`
already accepts a `Paint` object, so the agent sets `{ type:'shapes', shapeId, a, b, angle, density }`.
A one-line hint addition on `setFill` notes shape patterns exist. Full agent authoring of the shape
id can ride the existing describe/validate path; no new op.

## What stays identical

Every existing fill type renders unchanged (`shapeId` is ignored unless `type==='shapes'`).
`DEFAULT_FILL` is untouched (shapeId optional). A fill with no `shapeId` and type `shapes` falls back
to `'sparkle'`.

## Testing

- `fill-shapes-tile.unit.spec.ts` (happy-dom + FakePath2D/recording ctx) — `fillTileCanvas`/
  `fillTileBox` with a `shapes` fill draw `d×d` shape fills in colour `a`; background painted for a
  colour `b`, skipped for `'none'`; unknown `shapeId` falls back to sparkle; every other fill type is
  byte-identical (no `fill(path)` for non-shapes).
- `fillTile` normalize — `normalizeFill({ type:'shapes', shapeId:'sun-rays' }).shapeId === 'sun-rays'`;
  a non-string id defaults to `'sparkle'`; a `shapeId` on a non-shapes fill is dropped.
- `toVector` — `exportTier({ type:'shapes', … })` is `'raster'`.
- Live: Compositor — a box with a `shapes` fill shows tiled sparkles; change density/colour/shape;
  bake shows it. Space Type — type filled with a shape pattern.

## Follow-ups (not v1)

Per-cell scatter + rotation jitter (seeded); multiple shapes per tile; half-drop / brick offset; a
true vector `<pattern>` export with the shape `<path>`; wiring the shape id into the agent's fill
vocabulary explicitly.
