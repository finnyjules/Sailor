# Stroke fill that follows the line

**Date:** 2026-09-25 · **Status:** approved (prototype signed off by the user)
**Prototype:** https://claude.ai/artifact/XAEVRyUhHJnSef4qw69mGe

## In plain words

Today a stroke's fill (grid, stripes, ombre, a gradient…) is laid over the whole frame, and the
stroke just cuts a window into it. So a grid on a ring stays a straight grid.

This adds one choice to a stroke: **Fill — Stays put / Follows the line.** With "Follows the
line", the fill is bent round the stroke: grid cells run round a ring, stripes become ticks,
a gradient flows round the shape.

What the user agreed to:
- The choice only shows for a band stroke whose fill is a pattern or a gradient, on shapes with
  a real outline (rectangle, ellipse, polygon, star, path). Not on text, not for flat colours,
  metal (foil) or shader fills, not for marching shapes.
- When the fill follows the line, the band's outer corners are rounded (a fill cannot bend
  round a sharp point).
- Patterns close neatly: the pattern is stretched a touch so a whole number of repeats fits
  round a closed shape, so there is no half-cell where the ends meet. A gradient runs out and
  back round a closed shape so there is no hard jump.
- **Ombre is Sailor's grainy dither**, not a smooth blend. When it follows the line it gets its
  own choice, **Ombre fades: Inner to outer edge** (default) **/ Along the line**. "Along the
  line" adds **Repeats** (default 4): how many times the grain thickens and thins round the
  shape. The grain stays crisp: only the fade is bent, the speckles are laid afterwards.
- Existing frames must not change by a single pixel. The new fields are absent on every saved
  stroke, and absent means "stays put".

Risk: the bent fill costs more to draw than a plain band (hundreds of small pieces per stroke).
Fine for still frames; the follow-up motion work should measure it before relying on it.

**Follow-up (not in this spec):** a Motion-tab motion that runs the fill along the edge.

## Detail

### Stored data (`StrokeInstance`, lib/compositor/strokeStack.ts)

Three optional fields. Absent ⇒ today's behaviour.

| field | type | meaning |
|---|---|---|
| `follow` | `boolean` | `true` ⇒ the paint follows the line |
| `fade` | `'across' \| 'along'` | ombre only; absent ⇒ `'across'` (inner edge → outer edge) |
| `fadeRepeats` | `number` | ombre + `'along'` only; integer, clamped 1..50, absent ⇒ 4 |

`strokeStackOf` already spreads unknown fields through, so they survive reads, writes,
duplication and undo. Readers coerce them (`strokeFollowsOf`, `strokeFadeOf`,
`strokeFadeRepeatsOf`) — nothing else reads the raw fields.

### Which paints can follow (`paintCanFollow`)

`Gradient` with stops; `Fill` of any type except `solid` and `shader`. Not strings, not foil,
not image fills. A stroke with `follow: true` but a paint that cannot follow paints exactly as
today.

### How the strip is filled (`followStripPlan`, pure)

The band's centreline has length `L` and the band has width `w` (ctx units). The paint is drawn
into a straight strip `L × w`, then bent.

- `ombre` → **fade**: a greyscale fade map (black = colour A, white = colour B). `across` =
  top-to-bottom of the strip (inner edge → outer edge); `along` = out-and-back `fadeRepeats`
  times along the strip. After bending, every device pixel becomes A or B by the SAME hash the
  app's ombre tile uses (`ombreHash`, extracted from `ombrePicker`). `fill.angle` is ignored.
- `gradient` Fill and `Gradient` → **stretch** over the strip (`gradientUnitAxis`: angle 0 runs
  along the line, 90 across it), **mirrored** (first half, then the same half flipped) when the
  outline is closed.
- every other Fill (grid, checkerboard, stripes, qr, shapes, noise, paper) → **tiles**: the
  layer's own paint tile (`resolvePaint`, `'extend'`) repeated along the strip, scaled by
  `f = L / (tiles × boxW)` where `tiles = max(1, round(L / boxW))`. A whole number of tiles fits,
  so the pattern closes seamlessly, and cells keep (almost) the size they have when the fill
  stays put.

### Bending (`followFrame`, `bandTriangles`, `triangleAffine`, pure)

1. Longest subpath of the layer outline → `offsetPolyline` to the band's centreline (same
   `centre` offset and wobble as `paintWobbledBand`) → `resamplePolyline` at
   `step = max(2 device px, w/24)`.
2. Normals from a window of ±`0.8·(w/2)` of arc length (rounds the bend at corners); pointing
   out of the shape for a closed outline (shoelace sign).
3. Each segment → two triangles from the strip (`x` = arc length, `y` = 0 inner … `w` outer) to
   the band (`p ∓ n·w/2`). Triangles whose orientation flips against the majority (inner side of
   a tight corner folding over) are dropped.
4. Each triangle: clip (grown 0.6 device px against seams), affine transform, `drawImage` of its
   strip slice — onto a scratch.
5. The band is painted in solid ink on a second scratch — the SAME band painter as today
   (`paintStrokeBand` / `paintWobbledBand`) with `join: 'round'` — and applied with
   `destination-in`. So distance, alignment, dash and wobble all shape the result exactly as they
   shape a plain band.
6. Ombre: dither the scratch in device pixels. Then stamp.

Strip raster: `L·sx × w·sx` device px (`sx` = ctx scale), scaled down to ≤ 16384 px wide and
≤ 16 M px.

### Inspector

New rows after Colour, in `STROKE_ROW_ORDER`: `follow`, `fade`, `fadeRepeats`.
- `follow`: band style, shapeable kind, `paintCanFollow(paint)`.
- `fade`: `follow` row shown, `follow: true`, paint is an ombre Fill.
- `fadeRepeats`: `fade` row shown and fade is `along`.

Copy: "Fill" — "Stays put" / "Follows the line"; "Ombre fades" — "Inner to outer edge" /
"Along the line"; "Repeats".

### Also

- The agent's stroke patch accepts `follow`, `fade`, `fadeRepeats`.
- The Frame web embed bundles the painter; rebuild it and keep `frame-lean.js` under its size
  ceiling.
- SVG export already flattens patterned strokes to one colour; unchanged.
