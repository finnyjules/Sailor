# Paper fill — design

Date: 2026-09-03

## Goal

Add a new fill type, **paper**, to the shared spacetype `Fill` model: a base
paper color with a subtle fine grain and faint directional fibers, so it reads
as paper/cardstock stock rather than the existing harsh two-color `noise`.

Because the fill catalog is shared, adding `paper` to `FILL_TYPES` and the
render branches makes it appear automatically in every consumer's fill picker:
Compositor / Frame, Shape Studio, Space Type, Vector Type, Shape FX, Scene3D.

## Non-goals

- No animation (paper is static; a fixed seed keeps it deterministic).
- No new nested config object — paper reuses the flat `Fill` fields plus one
  new scalar.
- Not a post-effect/overlay and not a per-studio one-off — it is a real,
  pickable `FillType`.

## Data model

File: `frontend/app/lib/spacetype/fillTile.ts` (single source of truth,
re-exported by `fills.ts`).

- Add `'paper'` to the `FillType` union and to the `FILL_TYPES` array.
- Field mapping onto the existing flat `Fill`:
  - `a` → base paper color. Default warm off-white `#f3efe6`.
  - `b` → grain / fiber tint. Default muted warm brown `#8b7d68`.
  - `density` → grain scale (fine ↔ coarse).
  - `angle` → fiber direction (degrees).
  - **new field** `grain?: number` in `[0,1]` → grain amount / intensity.
    Default `0.4`.
- `normalizeFill` coerces/seeds these when `type === 'paper'`, mirroring how the
  `shapes` type handles `shapeSize` / `shapeGap`. `grain` is clamped to
  `[0,1]`; missing → default. The new `grain` field is threaded through
  `serializeFills` / `parseFills` so it round-trips.

## Rendering

Paper is a **raster** fill (no clean geometric SVG description), so it follows
the same path as `noise` / `ombre` / `shapes`.

- New deterministic helper `paintPaperTile(fill, w, h)` in `fillTile.ts`:
  1. Fill the base color `a`.
  2. Overlay fine **seeded** per-pixel grain — a soft lightness modulation
     blended toward `b`, with strength scaled by `grain` and cell size derived
     from `density`. Uses a small seeded PRNG (fixed seed) so output is
     byte-for-byte deterministic (required for stable tiling and SVG export).
  3. Draw a few faint, low-alpha fiber streaks along `angle`, tinted toward
     `b`, at seeded positions.
- Wire the helper into the CPU/canvas tile builders `fillTileCanvas` and
  `fillTileBox` (new `paper` arm in each).
- THREE path (`fills.ts`): add a `paperTex` builder (wraps `paintPaperTile` via
  a CanvasTexture, like `shapesTex` wraps `fillTileCanvas`), add the `paper`
  case to the `fillTexture` branch, and add a `paper` arm to
  `fillAtlasTexture`'s parallel branch.
- SVG export (`paint/toVector.ts`): no geometric `<pattern>`; paper falls
  through to the existing `rasterTile` fallback. Set its `exportTier` to
  `'raster'` so `resolvePaint` / export classify it correctly.

## UI

File: `frontend/app/components/vue-canvas/compositor/FillControl.vue`.

- The type dropdown already reads `FILL_TYPES` dynamically, so `paper` appears
  on its own with no list edit.
- When `type === 'paper'`, show controls: base color (`a`), grain tint (`b`),
  grain amount (`grain` slider, 0–1), grain scale (`density`), fiber direction
  (`angle`). Reuse the existing `needsAngle` / `needsDensity`-style gating and
  the shared color/slider rows.
- Seed paper defaults in `setType` when switching into `paper` (base off-white,
  warm grain tint, `grain` 0.4, a fine default `density`).

## Testing

Unit test (Vitest, colocated with the other fill/`fillTile` tests):

- `paper` is present in `FILL_TYPES`.
- `normalizeFill({ type: 'paper' })` produces the documented defaults and clamps
  `grain` into `[0,1]`.
- `paintPaperTile` is deterministic: same `Fill` → identical pixel bytes across
  two renders.
- The rendered tile differs from a flat base-color fill (proves grain drew) and
  differs from the `noise` tile for equivalent colors (proves paper ≠ noise).

## Branch-site checklist (from the fill-system map)

1. `fillTile.ts`: `FillType` + `FILL_TYPES`; `normalizeFill`; `fillTileCanvas`;
   `fillTileBox`; new `paintPaperTile`; thread `grain` through serialize/parse.
2. `fills.ts`: `fillTexture` case; `paperTex` builder; `fillAtlasTexture` arm.
3. `paint/toVector.ts`: `exportTier` → `'raster'` (uses `rasterTile` fallback).
4. `FillControl.vue`: control UI gating + `setType` seeding.
5. `paint/resolve.ts`: pattern-type `Fill`s flow through `fillTileBox`
   automatically — verify no explicit branch needed.
