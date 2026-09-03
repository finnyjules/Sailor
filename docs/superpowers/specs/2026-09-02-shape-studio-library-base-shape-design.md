# Shape Studio — library base shape — design

Date: 2026-09-02
Status: Approved (decided in-session, Julien asleep; the four-consumer order was agreed earlier), implementing
Sub-project 3 of 5 of the shape library. Predecessors: foundation + Expressive separator, Compositor layers (both landed 2026-09-02).

## Plain-language summary

Shape Studio (the geologo clone-and-arrange generator) clones one base shape — polygon, star,
hexagon, leaf… — and folds the clones into a mark. It gains a thirteenth base shape,
**Library**, which is any of the 100 drawn shapes. Pick "Library" in the Shape select, then pick
the shape in a Library shape row (the same picker every other studio uses). A swirl or a sun
cloned twelve times around a circle and even-odd folded is a genuinely new kind of mark.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the choice lives | `shape: 'library'` + `libraryShape: <id>` on `GeoShapeConfig` | Mirrors `star` + `sides`: the family select stays one control, the detail lives in a gated row. Old configs are untouched (default `'sparkle'` is filled in by the normaliser). |
| Sizing | The ink box's larger side = `size` | Every built-in base shape spans `size` in its larger dimension (`polygonVertices(n, size, size)`, circle diameter `size`), so a library shape clones and spreads at the same scale. |
| Geometry | Shared pure helper `lib/shapes/geometry.ts` (`fitShapePath`) reused by the Compositor's `shapeGeometry` | One recentre-and-scale, two consumers. |
| Rounding, sides | `sides`, `starInner`, `irregularSeed`, `roundCorners`, `roundRadius` hide under Library | The library path is already curved/faceted; corner rounding cannot apply to arbitrary cubics. |
| Randomize | Re-roll may pick Library and then picks a random library id | Reroll is the studio's discovery engine; excluding 100 shapes from it would be odd. |
| Agent | `libraryShape` is a `shape` control (`allowNone: false`) → described as an enum of ids; `GEO_GUIDANCE` gains one sentence | Same path the other two consumers use. |
| Unknown id | Normaliser falls back to `'sparkle'` | Catalog churn degrades to a known shape, never to a crash. |

## Architecture

- `frontend/app/lib/shapes/geometry.ts` (new, pure): `transformShapePath(shape, k, cx, cy)` — every coordinate becomes `((x − cx)·k, (y − cy)·k)`, rounded to 5 decimals, only `M L C Z` accepted (throws otherwise, naming the id); `fitShapePath(shape, size)` — `k = size / max(bw, bh)`, centre = ink centre, returns `{ d, w, h }`. `lib/shapes/pathLayer.ts`'s `shapeGeometry` becomes a thin call (`k = targetWidth / bw`).
- `lib/geoshape/shapes.ts`: `BaseShapeKind` + `BASE_SHAPES` gain `'library'` (appended — "append, don't reorder"); `BaseShapeOpts.libraryShape?: string`; `baseShapePath('library', o)` → `fitShapePath(shapeById(o.libraryShape) ?? shapeById(DEFAULT_LIBRARY_SHAPE)!, o.size).d`.
- `lib/geoshape/config.ts`: `libraryShape: string` (default `'sparkle'`), normalised with `isShapeId(v) ? v : default`.
- `lib/geoshape/render.ts`: pass `libraryShape: cfg.libraryShape`.
- `lib/geoshape/controls.ts`: `{ key: 'libraryShape', label: 'Library shape', kind: 'shape', allowNone: false, default: 'sparkle', group: 'Shape', when: isLibrary, hint }` right after the `shape` select; `sides`/`starInner`/`irregularSeed` already gate; `roundCorners` and `roundRadius` gain `when: notLibrary`. `GEO_GUIDANCE` BASE SHAPE sentence gains: `library (one of the 100 drawn library shapes, chosen by libraryShape — sparkle, sun-rays, leaf, heart, swirl…)`.
- `lib/geoshape/randomize.ts`: `rollShape` adds `libraryShape: r.pick(LIBRARY_IDS)`; `ShapeGroup` gains the key.
- Surface: `ShapeStudioSurface` already draws every `GEO_CONTROLS` row through `StudioControlPanel` → `StudioRow` → `rows/registry` → `RowShape`; `when` gating goes through `visibleGeoControls`. No surface change expected. Live check must confirm Escape inside the picker does not close the studio (the Compositor needed a gate; this surface has no keydown chain of its own, so it should not).

## What stays identical

Twelve built-in shapes, their order and paths; every existing config renders the same (the new key defaults in). SVG export and booleans consume `M L C Z` today already.

## Testing

- `shapes-geometry.unit.spec.ts` — `fitShapePath` larger side = size, centred, aspect kept; rejects non-MLCZ; `shapeGeometry` still passes its own suite (delegation).
- `geoshape-shapes.unit.spec.ts` — 13 kinds; `library` path starts with `M`, ends with `Z`, contains `C` for a curved shape; extent = size; unknown id falls back.
- `geoshape-config.unit.spec.ts` — `libraryShape` default + unknown → default + valid kept.
- `geoshape-controls.unit.spec.ts` — drift guard passes; `libraryShape` visible only when `shape === 'library'`; rounding rows hidden under library; guidance mentions library.
- `geoshape-render.unit.spec.ts` — a library config renders shapes and an SVG.
- Randomize: a re-roll with the shape group unlocked yields a valid `libraryShape` id.
- Live: Shape Studio → Shape = Library → Library shape row → pick Swirl → mark re-renders; clone count 8 radial; Escape in the picker leaves the studio open; Render footer bakes.
