# Compositor — shape library layers — design

Date: 2026-09-02
Status: Approved (brainstorm), implementing
Sub-project 2 of 5 of the shape library. Predecessor: [2026-09-02-shape-library-foundation-expressive-separator-design.md](2026-09-02-shape-library-foundation-expressive-separator-design.md) (landed).

## Plain-language summary

The Frame's layer editor (Compositor) gets the 100 library shapes as a Canva-style "insert a
shape" move. A picked shape becomes an ordinary **path layer**: fill, stroke, resize, rotate,
booleans, masks, motion, the agent and export all work with no new layer kind. The layer
remembers which shape it came from, so the inspector can swap it for another and the agent
can name it.

## Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Instance model | A real `path` layer + optional `shapeId` provenance | Every existing consumer (renderer, booleans, motion, export, `setFill`/`setSize`) already handles `path`. A new kind would need 5+ seams. |
| Geometry conversion | Pure arithmetic on the manifest's absolute `M L C Z` data | No paper.js round trip; deterministic; unit-testable in node. The SVG import pipeline stays for real SVG files. |
| Default size and place | 30% of the canvas width, centred | Same as a fresh rectangle (`createPathLayer` default bbox 0.3). |
| Default fill | `createPathLayer`'s default blue | The shape's `sourceColor` is a hint only (foundation rule). |
| Toolbar | A sixth Shapes-menu row "Shape library…" opens the picker; the picked shape becomes the face | Mirrors the last-used-face behaviour rectangle/star already have, so stamping ten sparkles is ten clicks. The face is a sixth `ToolbarShapeId` `'library'`. |
| Swap in the inspector | Keeps x, y, rotation, fill, stroke and the current width; regenerates `d` and `bbox` | The user changed the shape, not the layout. |
| Hand-edited nodes | Drop `shapeId` on commit from node editing | The geometry is no longer the library's; the Shape row would lie. |
| Agent | New op `addShape`; `describeCompositor` lists library ids under the document and reports `shape` on shape-backed paths | `addLayer` is kind-gated and its hint is already dense; a dedicated op keeps validation tight (unknown id ⇒ `invalid`). |

## Architecture

### `frontend/app/lib/shapes/pathLayer.ts` (new, pure)

```ts
export interface ShapeGeometry { d: string; bbox: { w: number; h: number } }
/** Recentre the manifest path on its ink box and scale so the ink is `targetWidth` wide
 *  (width-fraction units, the PathLayer local frame). */
export function shapeGeometry(shape: LibraryShape, targetWidth: number): ShapeGeometry
export const SHAPE_LAYER_DEFAULT_WIDTH = 0.3
export function createShapeLayer(shape: LibraryShape, opts?: { x?: number; y?: number; targetWidth?: number; fill?: Paint; id?: string }): PathLayer
/** Same layer, new geometry: keeps everything but d/bbox/shapeId; width = current bbox.w. */
export function swapShapeLayer(layer: PathLayer, shape: LibraryShape): PathLayer
```

`shapeGeometry`: `k = targetWidth / box.w`; centre `(cx, cy) = (box.x + box.w/2, box.y + box.h/2)`;
every coordinate pair becomes `((x − cx)·k, (y − cy)·k)`; numbers rounded to 5 decimals;
`bbox = { w: box.w·k, h: box.h·k }`; `fillRule` copied from the shape. Only `M L C Z` tokens
exist in the manifest, so the transform is a regex over number pairs — the module throws on
any other command letter (a manifest regression, caught by the parser tests first).

### `PathLayer.shapeId?: string` (`useCompositorLayers.ts`)

Additive field. Set by `createShapeLayer` / `swapShapeLayer`; cleared by node-edit commit
(`useVectorNodeEdit` → `segmentsToPathLayer` result) and by boolean results (they already
build fresh layers without it). Persists inside the layer object (`sailor_localLayers`), so no
serialisation change; a round-trip test proves it.

### Toolbar (`lib/compositor/toolbarMenus.ts`, `CompositorModal.vue`)

- `ToolbarShapeId` gains `'library'`; `TOOLBAR_SHAPES` gains `{ id: 'library', label: 'Shape library…' }` last.
- New pure state: `libraryShapeId: string | null` beside `shapeFace`. `pickShape('library')` opens the `ShapePicker` (`allowNone: false`, anchored above the menu) instead of stamping; on pick: `libraryShapeId = id`, `shapeFace = 'library'`, insert via `addLocal(createShapeLayer(shape))`, close.
- Face button when `shapeFace === 'library'`: inline `<svg viewBox="0 0 96 96">` of `libraryShapeId` in `currentColor`; title "Add <name>"; stamping inserts `createShapeLayer` again. If `libraryShapeId` is null (fresh modal), the face stays `rect`.
- `resolveShapeFace('library')` is valid only when a library shape is known; the pure helper takes an optional second argument `hasLibraryShape` and falls back to the default otherwise.

### Inspector (`CompositorModal.vue`, path block)

Inside `<template v-if="selectedLocal.kind === 'path'">`, first row when `selectedLocal.shapeId` resolves: a `panel-label` "Shape" and a button with the 16 px glyph + name that opens `ShapePicker` (`allowNone: false`); pick ⇒ `setLocal(swapShapeLayer(layer, shape))` through the normal history path. Unknown id (catalog churn) ⇒ row hidden, layer stays a plain path.

### Agent (`lib/agent/surfaces/compositor.ts`)

- `COMPOSITOR_COMMANDS` gains `addShape`: hint "Add a SHAPE from the shape library (sparkle, sun-rays, leaf, heart, plus, stairs…) as a vector layer. args: { shape (an id from document.shapeLibrary), x?, y? (0..1, centre; default 0.5,0.5), w? (0..1 of canvas width; default 0.3), fill? ("#RRGGBB" or gradient), id? }. This is what "add a sparkle", "put a sun top-right" mean. Recolour later with setFill, resize with setSize scale."
- Handler: validate `shape` via `shapeById` (unknown ⇒ `{ ok:false, reason:'invalid', detail: 'unknown shape id …' }`), clamp x/y to PROP_CLAMP, w to [0.02, 2], build with `createShapeLayer`, reject duplicate ids like `addLayer`.
- `describeCompositor`: path layers with a resolvable `shapeId` get `cur.shape = <id>`; the document object gets `shapeLibrary: SHAPES.map(s => s.id)` (about 1 KB) and `shapeFamilies` is NOT included (YAGNI).
- `summarizeCompositorChange`: `addShape` ⇒ `{ label: 'Add shape', after: <shape id> }`.
- `verifyCompositor`: nothing new (path layers already verified).

## What stays identical

- Documents without `shapeId` render and describe exactly as today.
- The five existing toolbar faces and their tests keep their ids, order and labels; only a sixth row is appended.
- SVG import, pen tool and booleans are untouched.

## Error handling

- Unknown shape id anywhere (persisted layer, agent, face state) degrades to "plain path layer" / `invalid`, never throws.
- `shapeGeometry` with a degenerate box (w or h ≤ 0) throws — impossible from the manifest (parser test guards it), and the message names the id.

## Testing

Unit:
- `shapes-path-layer.unit.spec.ts` — `shapeGeometry`: centred (bbox symmetric about 0), width = target, aspect kept, fillRule copied, rejects a non-MLCZ command; `createShapeLayer` defaults (x .5, y .5, bbox.w .3, shapeId, fill blue); `swapShapeLayer` keeps x/y/rotation/fill/stroke/id and the width, changes d/bbox/shapeId.
- `compositor-toolbar-menus.unit.spec.ts` — sixth row appended; `resolveShapeFace('library', false)` ⇒ rect, `('library', true)` ⇒ library; `shapeFaceLabel`.
- `compositor.unit.spec.ts` (extend) — `addShape` happy path (layer kind path, shapeId, bbox), unknown id ⇒ invalid, duplicate id ⇒ invalid, `describeCompositor` exposes `shape` and `shapeLibrary`, summary string.
- Round trip: JSON.parse(JSON.stringify(layer)) keeps `shapeId`.
- Node-edit commit drops `shapeId` (unit on the pure part of the commit, or a focused test on `segmentsToPathLayer`'s caller if it is pure enough; otherwise a Playwright-free happy-dom test of the composable).

Live (Browser pane, 127.0.0.1:3002): open a Frame, Shapes ▾ → Shape library… → Sparkle lands centred; face shows the sparkle; stamp twice more; recolour via the fill; select one → Shape row → swap to Sun rays keeps its place and size; select a rect + a shape → boolean subtract works; Render the frame and confirm the shape is in the bake.

## Follow-ups (not here)

Shape Studio library base shape; 3D Studio shelf; per-glyph separator; shape-aware Elements.
