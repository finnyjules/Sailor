# Shape library foundation + Expressive Studio separator — design

Date: 2026-09-02
Status: Approved (brainstorm), implementing
Sub-project 1 of 5. Follow-ups, each its own spec: Compositor shape layers, Shape Studio
library base shape, 3D Studio shape shelf, per-glyph separator.

## Plain-language summary

`Assets/Shapes/` holds 100 flat vector glyphs the user drew: circles, suns, leaves, sparkles,
stairs, diagram marks. Every file is a 96×96 box with one fill colour and only move, line,
cubic and close path commands. This spec turns them into a **shape library** every studio
can read, and lands the first consumer: a **separator** painted between repeats of a word
in Expressive Studio (the Space Type surface), so "SAILOR ✦ SAILOR ✦ SAILOR" rides every
ribbon, tunnel and ticker.

Four consumers were agreed with the user, in this order: Expressive separator (this spec),
Compositor shape layer, Shape Studio base shape, 3D Studio extruded shelf. The foundation
is built once so each later consumer is a thin adapter over the same catalog and picker.

## Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Where the shape data lives | Checked-in generated manifest, bundled | 70 KB of path data. No runtime file serving, works in the headless bake and the embed. Same pattern as `library-fonts.manifest.json`, minus the serving half. |
| Source SVGs | Committed under `Assets/Shapes/` | User's own drawings; unlike `Assets/Fonts/` there is no licence reason to keep them out of git. The build script must be re-runnable from a clean clone. |
| Colour | Source fill kept as `sourceColor` hint only | Every surface colours shapes with its own fill system (type colour, layer paint, material). Same rule as seeds/palettes: raw asset colour never drives a render. |
| Variants | Separate entries, no variant toggle | `sparkle` / `sparkle-invert` stay two ids. Merging would need per-pair judgement calls for 100 files; the picker's search covers discovery. |
| Path space | Stored in the original 96-unit box, plus ink bbox | No lossy renormalisation at build time; consumers fit by bbox. |
| Control kind | New `ControlSpec` kind `'shape'` | Declaring "pick a shape" must be one line for any studio, and the agent describer must know it is an enum of ids. |
| Separator injection | Once, at effect registration | 22 tile-based effects would otherwise each carry three copy-pasted control lines. |
| Separator scope v1 | Tile-based effects only | Per-glyph effects (`blend`, `cascade`, `cylinder`, `onionburst`, `ring`, `slot`) lay out letters individually and never see the tile texture. Raw-word effects (`coil`, `elastic`, `echo`) render the bare word. Both stay untouched. |

## Part A — the foundation

### A1. Build script: `frontend/scripts/build-shape-library.mjs`

Run from `frontend/`: `node scripts/build-shape-library.mjs`. Idempotent. Mirrors
`build-font-library.mjs`.

- Reads every `*.svg` under `<repo>/Assets/Shapes/`.
- Parses with a small hand-written parser (no new dependency): the files contain only
  `<path d>`, `<polygon points>`, `<rect>`, `<circle>` inside one 96×96 `<svg>`. `polygon`,
  `rect` and `circle` are converted to path data (circle as four cubic arcs). Multi-element
  files concatenate into one `d`. Any other element or any path command outside
  `M L H V C S Z` (absolute or relative) fails the build with the filename, so a future
  drawing that uses arcs or quadratics is caught at build time, not at draw time.
- `fill-rule` is read if present, default `nonzero`.
- Computes the ink bounding box by flattening: lines exactly, cubics sampled at 16 steps.
- `id` = slugified basename (lower-case, spaces and repeated dashes collapsed).
  Duplicate ids fail the build. **Pre-step done by hand before the first run:**
  `triangle-double .svg` (a different drawing from `triangle-double.svg`, an hourglass) is
  renamed `triangle-hourglass.svg`.
- `name` = basename with dashes turned into spaces and the first letter capitalised.
- Writes `frontend/app/data/shape-library.manifest.json`:

```ts
interface ShapeManifest {
  generatedAt: string
  shapesRoot: 'Assets/Shapes'
  shapes: LibraryShape[]
}
interface LibraryShape {
  id: string            // 'sun-rays'
  name: string          // 'Sun rays'
  d: string             // path data in the 96×96 source box
  fillRule: 'nonzero' | 'evenodd'
  box: [number, number, number, number]   // ink bbox x, y, w, h in source units
  sourceColor: string   // '#98ddca', hint only
}
```

The parser and bbox helpers live in `frontend/scripts/shapeLibrary.mjs` so the unit test
imports them directly (the `fontLibrary.mjs` pattern).

### A2. Catalog: `frontend/app/lib/shapes/catalog.ts`

Pure, no DOM. Imports the manifest JSON.

```ts
export type ShapeFamily = 'geometric' | 'suns' | 'botanical' | 'patterns' | 'symbols' | 'diagram'
export const SHAPE_FAMILIES: { id: ShapeFamily; label: string }[]
export const SHAPES: readonly LibraryShape[]           // manifest order
export function shapeById(id: string): LibraryShape | undefined
export function familyOf(id: string): ShapeFamily       // curated map, fallback 'symbols'
export function searchShapes(query: string): LibraryShape[]   // case-insensitive substring on id + name; '' → all
export const SHAPE_NONE = 'none'
export function isShapeId(v: unknown): v is string      // shapeById(v) !== undefined
```

The family map is a hand-written `Record<ShapeFamily, string[]>` of id prefixes and
explicit ids (for example `suns: ['sun-']`, `botanical: ['leaf', 'flower', 'floral']`,
`diagram: ['diagram-', 'pie-chart', 'circle-network', 'stairs']`). A unit test asserts every
manifest id resolves to a family without hitting the fallback, so a newly added shape that
fits no rule is noticed.

### A3. Canvas helpers: `frontend/app/lib/shapes/path2d.ts`

```ts
export function shapePath2D(shape: LibraryShape): Path2D            // cached per id
export interface DrawShapeOpts {
  x: number; y: number          // target box top-left in ctx units
  w: number; h: number          // target box; the ink bbox is fitted inside, aspect kept, centred
  fill?: string
  stroke?: { color: string; width: number }
}
export function drawShape(ctx: CanvasRenderingContext2D, shape: LibraryShape, o: DrawShapeOpts): void
export function shapeAspect(shape: LibraryShape): number           // box w / box h
```

`drawShape` saves the context, translates and scales so the ink box maps into the target
box, fills with `fillRule`, strokes if asked (line width divided by the scale so the outline
stays in ctx pixels), restores. Nothing else in the app touches `d` directly for 2D drawing.

### A4. Picker: `frontend/app/components/vue-canvas/studio/ShapePicker.vue`

Props: `modelValue: string` (a shape id or `'none'`), `allowNone: boolean` (default true),
`label?: string`. Emits `update:modelValue`. Layout: family rail down the left (All plus the
six families), a search field on top, a grid of 40 px inline `<svg viewBox="0 0 96 96">`
thumbnails using `currentColor` (so the picker is theme-neutral and the shape's source colour
never shows). A "None" tile leads the grid when allowed. The selected tile carries the
action-blue accent; nothing purple. Keyboard: arrows move, Enter picks, Escape closes.
Rendered as a teleported, viewport-clamped floating panel anchored to the row, following the `SweepPopover` / `CanvasContextMenu` conventions (Escape and backdrop close).

Row renderer `rows/RowShape.vue` shows the current shape as a 16 px thumbnail plus its
name (or "None") on the value side and opens the picker on click. Registered in
`rows/registry.ts` under `shape`.

### A5. Control kind and agent contract

`effect.ts` `ControlSpec` gains:

```ts
| { key: string; label: string; kind: 'shape'; default: string; allowNone?: boolean; group: string }
```

`controlDescriptor.ts`:
- `DescribedControl.kind` gains `'shape'`; `AI_EDITABLE_KINDS` includes it.
- `describeControls` emits `options: [SHAPE_NONE, ...SHAPES.map(s => s.id)]` (omitting
  `none` when `allowNone === false`) and a hint: "A shape id from the library, or none."
- `validatePatch` treats `shape` like `select`: unknown ids are dropped.

`SpaceTypeSurface.vue`'s hand-written control loop gains one branch for `kind === 'shape'`
rendering `RowShape`, next to the existing `font` branch. `controlKindToVariableType`
returns `null` for `shape` (not bindable to collections in v1).

## Part B — the Expressive Studio separator

### B1. Controls (injected once)

`effects/index.ts` exports `SEPARATOR_EFFECT_IDS` (every registered effect except the
per-glyph and raw-word sets, which move from `state.ts` into `effect.ts` as exported
constants `PER_GLYPH_EFFECTS` and `RAW_WORD_EFFECTS`). At registration, effects in the set
get three controls appended to their `Type` group:

```ts
{ key: 'separator', label: 'Separator', kind: 'shape', default: 'none', group: 'Type' }
{ key: 'separatorSize', label: 'Separator size', kind: 'slider', min: 0.3, max: 1.5, step: 0.05, default: 0.7,
  group: 'Type', showIf: { key: 'separator', notEquals: 'none' } }
{ key: 'separatorGap', label: 'Separator spacing', kind: 'slider', min: 0, max: 3, step: 0.05, default: 1,
  group: 'Type', showIf: { key: 'separator', notEquals: 'none' } }
```

`separatorSize` is a fraction of cap height. `separatorGap` is in units of a quarter em on
each side of the shape. Appending at registration keeps `defaultsFromControls` and the
sections test working unchanged; the existing spacetype-sections unit test still passes
because `Type` is a listed group.

### B2. The tile painter

`textTexture.ts` `TextTextureOptions` gains:

```ts
separator?: { shape: LibraryShape; size: number; gap: number }
```

`makeTextTexture`, per row label:
- Without `separator`: unchanged, byte for byte.
- With `separator`: the label is measured **trimmed** (the three-space gap from
  `buildRibbonLabel` is discarded). Tile layout along x is
  `textW + gapPx + shapeW + gapPx`, where `gapPx = gap × fontPx × 0.25`,
  `shapeH = capHeight × size` (cap height from `actualBoundingBoxAscent` of the trimmed
  label, falling back to `fontPx × 0.72`), `shapeW = shapeH × shapeAspect`. The shape is
  drawn with `drawShape` at `x = textW + gapPx`, vertically centred on the text's ink
  midline, filled with `typeColor`, stroked with the same `strokeColor`/`strokeWidth` as the
  letters. `scaleX` applies to the whole tile as it does today (the transform is set before
  drawing).
- Canvas width = max over rows of the full tile width. `wordFracs` and `wordInkFracs` are
  computed from the full tile (text + gaps + shape) so effects that centre a repeat still
  centre the whole unit. `inkHeightFrac`/`inkVMid` stay text-derived.
- Gradient: unchanged. The gradient texture is sampled by UV in the shader, so the shape
  picks up the gradient by position for free.

### B3. The one builder

`texOptsFromState` in `state.ts` reads `p.separator`; when it is a valid id and the effect is
in `SEPARATOR_EFFECT_IDS`, it sets `separator: { shape, size: Number(p.separatorSize ?? 0.7),
gap: Number(p.separatorGap ?? 1) }`. Because the modal, the canvas card, the clip renderer
and the headless frame source all call this builder, the separator shows up in export with
no further wiring. An unknown id (catalog churn) resolves to no separator.

### B4. Agent

No new capability entry: the injected controls surface through `describeControls` like every
other Type control, so "add a sparkle between the words" resolves to
`{ separator: 'sparkle' }` via the existing studio-tune path.

## What stays identical

- `separator` unset or `'none'` ⇒ label string, canvas size, every `userData` fraction, and
  the texture are byte-identical to today. Guarded by a unit test that runs the painter both
  ways under happy-dom and compares canvas width, `wordFracs`, `wordInkFracs`.
- Saved documents have no separator key; `defaultsFromControls` fills `'none'`.
- Per-glyph and raw-word effects gain no controls and no behaviour.

## Error handling

- Build script: unknown element, unknown path command, duplicate id, unparsable file ⇒
  non-zero exit with the offending filename. Never writes a partial manifest.
- Runtime: `shapeById` returns `undefined`; `texOptsFromState` degrades to no separator;
  `RowShape` shows "None" for an unknown id but keeps the stored value until the user picks.
- `drawShape` with a zero-area target box is a no-op.

## Testing

Unit (vitest, node unless noted):
- `shape-library-parser.unit.spec.ts` — polygon/rect/circle → path, relative→absolute bbox,
  rejects an arc, rejects a duplicate id.
- `shape-library-manifest.unit.spec.ts` — 100 shapes, unique ids, every `box` inside 0..96
  with positive size, every id has a non-fallback family, `sun-rays` and `sparkle` present.
- `shapes-catalog.unit.spec.ts` — `searchShapes('sun')` returns all `sun-*`, `isShapeId`.
- `shapes-path2d.unit.spec.ts` (happy-dom) — `drawShape` fits aspect and centres; zero box
  no-op.
- `spacetype-separator-tile.unit.spec.ts` (happy-dom) — width grows by `2·gap + shapeW`;
  `wordInkFracs` covers the shape; `none` is byte-identical; `scaleX` scales the whole tile.
- `spacetype-separator-controls.unit.spec.ts` — every tile effect has the three controls in
  `Type`, per-glyph and raw-word effects have none, `showIf` hides size/gap at `none`,
  `describeControls` lists ids, `validatePatch` drops an unknown id.
- `control-descriptor` update for the `shape` kind.

Live (browser pane, dev server on 127.0.0.1):
- Ribbon with `separator: 'sparkle'`: screenshot shows word, shape, word. Change the type
  colour: the shape follows. Turn on gradient: the shape is banded. Set `none`: the old
  three-space gap returns.
- One headless bake of the same document; the exported frame shows the separator.

## Follow-ups (not in this spec)

1. Compositor: Shapes entry beside rect/ellipse/line inserting a `path` layer via the catalog.
2. Shape Studio: `'library'` base-shape kind with a `shape` control.
3. 3D Studio: shape shelf through `svgToLeafPaths` → `buildSvgObjects`.
4. Separator on per-glyph effects as a glyph-sized tile in `charLayout`.
5. Collections binding for the `shape` kind.
