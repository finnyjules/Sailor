# Shape Studio — document background (incl. transparent)

**Date:** 2026-09-04
**Status:** Design approved, spec review pending

## Problem

Shape Studio always renders its shapes onto a **transparent** canvas — there is no way
to set a background. Users want a background behind the whole composite, including an
explicit transparent option, and want it to reach every output (editor preview, PNG
bake, live Frame source, SVG export).

Output **resolution** already exists (the editor's Aspect selector + Width/Height
inputs, persisted as `canvasW`/`canvasH`/`aspectKey`, feeding the export bake and the
Frame source) and is out of scope — the user confirmed it is sufficient.

## Design

### Data model

Add one document-level field to `GeoStudioDoc` (`app/lib/geoshape/studio.ts`):

```ts
export interface GeoStudioDoc {
  layers: GeoLayer[]
  overlap: GeoOverlap
  padding: number
  seed: number
  /** Full-composite background painted behind every layer. `null` = transparent
   *  (the historical behaviour). A `Paint` fills the entire output rect. */
  background: Paint | null
}
```

- Background is **document-level**, one per output — behind all layers and the
  padding frame. Not a per-mark `GeoShapeConfig` field.
- `Paint = string | Gradient | Fill | ImageFill` (solid / gradient / pattern / image /
  shader), the same type shape fills use — so gradient and image backgrounds come for
  free via the existing `resolvePaintCanvas` path.
- **Transparent** is represented as `null`. `drawToCanvas` also treats `'none'`/`''`
  as transparent (defensive — `FillControl`'s none-state can emit `'none'`), but the
  canonical stored value for transparent is `null`.

**Validation / migration** — `mergeStudioDoc` defaults a missing/invalid `background`
to `null`; `defaultDoc()` sets `background: null`; the legacy single-mark migration
branch in `studioDocFromPersisted` sets `background: null`. Every previously saved doc
therefore loads as transparent and renders **byte-identical** to today. A normaliser
collapses `'none'`/`''` to `null` on the way in.

### Render — `drawToCanvas`

`app/lib/geoshape/render.ts`:

```ts
export function drawToCanvas(
  shapes: VectorShape[], ctx: CanvasRenderingContext2D,
  w: number, h: number, pad = 0, background: Paint | null = null,
): void
```

Right after the existing `ctx.clearRect(0, 0, w, h)`, and **before** the fit/centre
transform:

- `background` falsy or `'none'` → do nothing (transparent, as today).
- solid string → `ctx.fillStyle = background; ctx.fillRect(0, 0, w, h)`.
- gradient / pattern / image / shader → resolve with `resolvePaintCanvas(ctx,
  background, { w, h }, STILL_FIELD)` in the **untransformed** device frame and
  `fillRect(0, 0, w, h)`, so the background spans the whole output including padding
  (it does NOT scale/translate with the shapes).

The new param is optional and last, so the signature is backward-compatible; existing
calls that omit it keep painting transparent.

### Async backgrounds (image / shader)

Image and shader paints resolve to `FALLBACK_FILL` until their bitmap/field cache is
warmed (`warmPaints`). The background paint must join the warm list wherever shapes
are warmed:

- **Surface preview** (`ShapeStudioSurface.vue` ~L361) and **surface export /
  rasterizePng** (~L418) already build `shapePaints(shapes)` then
  `hasAsyncPaint`/`warmPaints`. Append `doc.background` to that list.
- **Node bake** (`ShapeStudioNode.vue` `bakeOutput`) and the **Frame-source render
  closure** (`renderFrameSurface`, added 2026-09-03) currently do **not** warm. Add a
  warm pass there when the background (or any shape paint) is async, so an image
  background actually resolves live in the Frame instead of falling back. This is a
  small, contained addition on top of the existing helpers.

A tiny helper keeps the warm list in one place:

```ts
// render.ts — the paints a studio doc needs warmed: every shape's, plus the background.
export function studioWarmPaints(shapes: VectorShape[], background: Paint | null): Paint[]
```

### SVG export — `studioToSvg`

`app/lib/geoshape/render.ts` `studioToSvg(doc, opts)` emits a background `<rect>`
covering the full viewBox as the **first** child (behind all shape paths) when
`doc.background` is a real paint:

- solid → `<rect ... fill="#rrggbb"/>`.
- gradient / image / shader → resolve to a `VectorPaint` via `paintToVectorPaint`
  (rasterising image/shader through the same `rasterizePaint` arm shape fills use, per
  the SVG-export-fidelity recipe: paint-server pinned to the rect's box).
- transparent → no rect emitted.

### UI

`ShapeStudioSurface.vue`: add a **Background** control in the document-settings block
(next to Aspect / Width / Height / padding), rendered as:

```vue
<FillControl :model-value="doc.background ?? 'none'" allow-none allow-image
             @update:modelValue="setBackground" />
```

`setBackground(p)` normalises `'none'`/`''`/null → `null`, else stores the `Paint`,
then persists (same `saveConfig` path as other doc edits). Transparent shows the
existing checkerboard behind the composite.

## Call sites touched

`drawToCanvas` (add param + paint), `studioToSvg` (bg rect), `studioWarmPaints` (new):
- `ShapeStudioSurface.vue` — preview (2 calls), rasterizePng export, + the Background control.
- `ShapeStudioNode.vue` — `bakeOutput`, `renderFrameSurface` (warm + pass bg).
- `app/lib/agent/takeThumbs.ts` — Shape thumbnail (`drawToCanvas` at ~L240).
- `app/lib/geoshape/studio.ts` — type, `mergeStudioDoc`, `defaultDoc`, migration branch.

## Testing

- `mergeStudioDoc`: missing background → `null`; a valid Paint round-trips; `'none'`/`''`
  → `null`; legacy `{ config }` blob → `null`.
- `drawToCanvas`: null/`'none'` background leaves the corner pixel transparent (alpha 0);
  a solid background paints an opaque corner of the right colour; a gradient background
  differs corner-to-corner. (Canvas assertions via the existing geoshape render test
  harness / `getImageData`.)
- `studioWarmPaints`: includes the background when it is an ImageFill/shader; excludes a
  null/solid background from async warming (`hasAsyncPaint` stays false for solid).
- `studioToSvg`: emits a leading `<rect>` for a solid background; emits none when
  transparent; the rect precedes the first shape path.

## Out of scope

- Output resolution controls (already exist and confirmed sufficient).
- Per-layer backgrounds (this is one document-level background).
- Animated/among-time backgrounds (Shape Studio is a still).
