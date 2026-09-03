# Shapes pattern fill — Size + Spacing dials — design

Date: 2026-09-03
Status: Approved (design agreed in-session), implementing
Follow-up to [shapes as a pattern fill](2026-09-03-shapes-pattern-fill-design.md). Replaces the
single **Count** dial (for the `shapes` fill only) with two: **Size** and **Spacing**.

## Plain-language summary

For a shapes fill you now set how **big** each shape is and how much **gap** sits between them,
instead of a raw count. How many shapes fit is worked out automatically so the pattern always
tiles seamlessly. Bigger size at the same gap → larger shapes, fewer of them; more gap at the same
size → the same shapes with more air around each. Every other fill type keeps its **Density** dial
unchanged.

## Why count is derived (the seamless-tiling constraint)

A repeating grid only has two free parameters of {count, size, spacing}; the third always falls out.
The user chose to steer with **size + spacing**, so count is derived. Working in **tile fractions**
(not pixels) keeps the look identical across the swatch, the compositor box and the 3D GPU surface —
the same derived count everywhere — which absolute pixels would break.

## Data

`Fill` gains two optional fields, read only when `type === 'shapes'` (like `shapeId`):

```ts
shapeSize?: number   // shape span as a fraction of the tile (~0.02..0.6)
shapeGap?:  number   // gap as a fraction of the tile (0..0.6)
```

`normalizeFill` (for `type === 'shapes'`):
- `shapeSize` = explicit value clamped to [0.01, 0.6], else **derived from `density`**: `0.76 / d`
- `shapeGap`  = explicit value clamped to [0, 0.6], else derived: `0.24 / d`
  (where `d = clamp(density, 1, 64)`)

The 0.76 / 0.24 split reproduces today's look: current cells fill `1 − 2·0.12 = 0.76` of the cell.
So an existing saved shapes fill (only `density`) migrates to the exact same appearance, and a fresh
one (DEFAULT_FILL `density: 8`) starts at size ≈ 0.095, gap ≈ 0.03 (≈ 8 across) — unchanged from now.
`density` stays on the type for every other fill; shapes simply ignore it once size/gap are set.

## Rendering (`paintShapesTile`)

```
size = clamp(fill.shapeSize ?? 0.1, 0.01, 0.6)
gap  = clamp(fill.shapeGap  ?? 0.03, 0, 0.6)
cellFrac = max(0.02, size + gap)
d = clamp(round(1 / cellFrac), 1, 64)          // whole cells across → seamless
fillFrac = clamp(size / cellFrac, 0.02, 1)      // portion of the cell the shape spans
cw = W/d, ch = H/d
bw = cw * fillFrac, bh = ch * fillFrac          // was cw*(1−2·0.12); now gap-driven
```
Everything else is unchanged: shape resolved by `shapeById` (unknown ⇒ sparkle), rotated by `angle`
about the cell centre, background `b` (`'none'`/`''` ⇒ transparent). The `d×d` loop stays.

## Caches (must key on size + gap)

Four tile caches front the 2D builder and currently append `shapeId` for shapes. Each must also
append `shapeSize` and `shapeGap`, or the new dials won't re-tile (the stale-tile bug, again):
- `app/lib/paint/resolve.ts` `_fillTileCache`
- `app/lib/spacetype/fills.ts` `_cache` (`fillTexture`)
- `app/lib/spacetype/fills.ts` `_atlasCache` (`fillAtlasTexture`)
- `app/lib/spacetype/effects/sliceGlitch.ts` `_tileCache`

The shapes suffix becomes, e.g., `${shapeId}:${shapeSize}:${shapeGap}` (gated to `type === 'shapes'`
so no other type's key changes).

## Editor (`FillControl.vue`)

For `type === 'shapes'`, hide the Count/Density row and show **two** rows instead:
- **Size** — range over `shapeSize` (min 0.02, max 0.5, step 0.005), shown as a percent.
- **Spacing** — range over `shapeGap` (min 0, max 0.4, step 0.005), shown as a percent.

`setNum` accepts `'shapeSize' | 'shapeGap'`. `setType('shapes')` seeds `shapeId:'sparkle'`,
`shapeSize:0.1`, `shapeGap:0.03` so the sliders have live values immediately. Every non-shapes type
keeps the existing single Density row (`needsDensity` unchanged for them).

## Agent

`setFill` hint: for shapes, document `{ type:'shapes', shapeId, a, b, angle, shapeSize, shapeGap }`
(size/gap as 0..1 fractions) instead of `density`. `paintLabel` is unchanged.

## What stays identical

Non-shapes fills are byte-identical (size/gap ignored). A shapes fill with no size/gap renders
exactly as its `density` did (migration derivation). Export is unaffected — shapes still fall to the
SVG raster tier.

## Testing

- `paintShapesTile`: count derives from size+gap (size 0.2 + gap 0.05 → cell 0.25 → 4 across → 16
  shapes; size 0.4 + gap 0.1 → 2 across → 4); larger gap at fixed size shrinks the drawn shape
  (`fillFrac` falls); size/gap clamp; unknown shape ⇒ sparkle; transparent bg unchanged.
- `normalizeFill`: absent size/gap derive from density (density 4 ⇒ size 0.19, gap 0.06); explicit
  values survive and clamp; a size/gap on a non-shapes fill is dropped.
- Each of the 4 caches: changing only `shapeSize` (or `shapeGap`) yields a different tile; identical
  fills still hit.
- Live (Compositor): a box shapes fill, drag Size → shapes grow/shrink and re-fit; drag Spacing →
  gaps open with the shape size held; swatch tracks.

## Follow-ups (unchanged from v1)

Per-cell scatter + rotation jitter; multiple shapes per tile; half-drop / brick offset; true vector
`<pattern>` export.
