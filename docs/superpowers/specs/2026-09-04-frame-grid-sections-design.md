# Frame Grid & Sections — design (sub-project 1)

**Status:** design, approved in brainstorm 2026-09-04. Slice 1 of a four-part programme.

## Why

The Frame (Compositor) has object-alignment snapping (`snapGuides` in `useLocalLayerEditor.ts`) but no modular grid. Swiss-style poster composition, and the whole playgrnd grid-generator family (Oddgrid, Modular, Parcel, Mosh, Static), both rest on the same missing substrate: a grid that content snaps to. This sub-project adds that substrate and nothing more. It turns the Frame into a grid-aware layout tool and becomes the foundation the other three sub-projects consume.

Origin: the playgrnd-tools mapping (see memory `playgrnd-tools-mapping-plan1-written`). Reading all 33 tools' source showed most of the remaining ones are grid/composition or vector work, not shader backgrounds. The grid is the shared engine under them.

## The programme (context; only sub-project 1 is specced here)

1. **Grid substrate + manual sections** (this spec). A Frame-level grid, explicit or generated, that layers snap to. Sections are grid-snapped layers.
2. **The generative deal.** Auto-fill the grid's cells from a weighted fill vocabulary + seed, as one self-painting layer with explode-to-layers. The playgrnd decorative mode.
3. **Templates.** Each playgrnd tool as a preset configuring the grid, the vocabulary, and the palette roles.
4. **Editorial compose + Smart Layout handoff.** The taste layer (hierarchy, whitespace) feeding the existing Smart Layout.

Deferred out of slice 1: typographic baseline grid, nested sub-grids, the dense generative deal, templates, Smart Layout handoff, automatic reflow.

## The model in one paragraph

A frame gains a `grid` config (off / explicit / generated). The grid resolves to guide lines (column and row edges) and, when merging is on, regions. The grid renders only as an editor overlay, never in the bake, export, or embed. A **section is not a new object**: it is any existing layer whose box aligns to the grid. You create one by marqueeing across cells or by drawing freely with edge-snapping; you fill it with the layer's existing fill picker. Sections overlap freely, resolved by z-order, because a section is a layer. Old frames load with the grid off and are unchanged.

## Data model

### The grid config

Stored at `node.data.properties.sailor_localGrid` (parallel to `sailor_localLayers` / `sailor_background`). Read through a defaulting helper so an absent property yields `{ mode: 'off' }` — old frames are safe with no version field, matching how the Frame already handles its properties.

```ts
export interface FrameGrid {
  mode: 'off' | 'explicit' | 'generated'
  /** The alignment unit, in normalized frame width (0..1) — the Swiss base
   *  module. Every line and cell edge snaps to a multiple of it. In explicit
   *  mode you set `columns`/`rows` directly; in generated mode the counts come
   *  from the ranges and the dealt edges snap to this module. */
  baseModule: number            // default 1/12 (a 12-unit page)
  gutter: number                // normalized; default 0.01
  margin: number                // normalized; default 0.04
  /** explicit mode */
  columns: number               // default 6
  rows: number                  // default 4
  /** generated mode */
  gen: {
    colRange: [number, number]  // default [3, 7]
    rowRange: [number, number]  // default [2, 5]
    /** 0 = free bounded weights (Pane-like) … 1 = equal, module-snapped (strict Swiss). */
    regularity: number          // default 0.8
    merge: boolean              // fuse adjacent cells into units; default true
    mergeMaxSpan: number        // max cells a unit spans on an axis; default 3
    symmetry: 'none' | 'mirror' // default 'none'
    seed: number                // default 42; New-variation re-rolls 1..9999
  }
  /** editor overlay only; never rendered into output */
  overlay: boolean              // default true
}
```

### A section is a layer

No new type. Slice 1 adds **nothing** to `LocalLayer`. A "section" is a `LocalLayer` (any kind: `rect`, `ellipse`, `text`, `image`, `path`, `shape`, …) whose box currently aligns to grid lines. Alignment is a property of the box, not stored state. There is no `gridSpan` field in slice 1 — sections keep pixel boxes; the grid assists on edit and offers manual re-snap. (A `gridSpan` source-of-truth is a reflow feature deferred to a later sub-project.)

## Components and files

- **`app/lib/frame/grid.ts`** (new). Pure module. Given a `FrameGrid` and the frame's pixel size, returns `{ xs: number[], ys: number[], regions: Rect[] }` — the column edge x's, row edge y's, and (when `merge`) the merged-unit rectangles. Contains the generated-grid dealer (seeded, regularity dial). No DOM, unit-tested in isolation.
- **`app/composables/useLocalLayerEditor.ts`** (modify). `computeSnapAdjust` already snaps a dragged box to `others` (other layers' edges) within `SNAP_PX`. Add the grid's `xs`/`ys` as snap candidates when `grid.mode !== 'off'`. `snapGuides` already renders the guide line that results — no new snap rendering.
- **`app/components/vue-canvas/CompositorModal.vue`** (modify). Grid inspector panel (a new top-level section, like the source/background rows): mode toggle, explicit fields (columns/rows/gutter/margin) or generated fields (ranges, regularity dial, merge, symmetry, seed + New-variation), overlay toggle. Draw-from-grid interaction (marquee across cells → new rect layer). The "fill grid with sections" action (capped, below). The grid overlay SVG in the editor.
- **`app/components/vue-canvas/ArtifactFrameNode.vue`** (modify). Read `sailor_localGrid`; draw the overlay on the card in edit mode only. `paintLayerStack` is untouched — sections are ordinary layers.
- **`app/lib/agent/…`** (modify). Expose the grid config to the agent: set mode/columns/rows, generate, re-roll. Placing sections is placing layers (existing `addShape`/layer ops).

## Interactions

- **Draw a section:** marquee across grid cells → creates a `rect` layer spanning them, snapped to the enclosing lines. Or draw a rect freely and its edges snap to the nearest lines. Fill via the existing fill picker (solid/gradient/shape/shader/image) or make it a text/image layer.
- **Move / resize:** edges snap to grid lines through the extended `computeSnapAdjust`; hold the existing bypass modifier to ignore. Overlap allowed.
- **Fill grid with sections (capped auto-convert):** one action that stamps an empty grid-snapped `rect` per region for you to fill by hand. **Refuses above 24 regions** with a message pointing at sub-project 2's dense deal. This delivers the "grid becomes sections" feel without the layer-count machinery.
- **Re-snap:** a per-section action that realigns its box to the current grid lines. Used after the grid changes.
- **New-variation:** re-rolls the generated grid's seed. Existing sections keep their pixel boxes (no auto-reflow); re-snap them individually if wanted.

## The generated-grid dealer (regularity dial)

In `grid.ts`, seeded by `gen.seed`:

1. Pick `cols` in `colRange`, `rows` in `rowRange` (seeded).
2. For each axis, produce edge positions between the margins:
   - At `regularity = 1`: equal divisions snapped to `baseModule`.
   - At `regularity = 0`: bounded random weights (variance scaled by `1 - regularity`), Pane-style.
   - The dial interpolates: draw weights with variance `(1 - regularity) * MAXVAR`, then snap each edge toward the nearest `baseModule` multiple by amount `regularity`.
3. If `merge`: seeded-randomly fuse rectangular runs of adjacent cells into units, each spanning at most `mergeMaxSpan` on either axis, no overlaps.
4. If `symmetry === 'mirror'`: mirror the column plan (and merges) about the vertical centre.

Deterministic in `gen.seed`: the same seed gives the same grid, so bake and preview agree and re-roll is reproducible.

## Rendering, export, persistence

- **Render:** unchanged. Sections are layers; `paintLayerStack` → `resolvePaint` already handles every fill kind. The grid overlay is drawn separately and only in the editor.
- **Bake / export / embed:** the grid config is inert at render — only the overlay reads it, and the overlay is editor-only. A baked frame is its layers, exactly as today. **Guard:** the overlay draw path is gated on edit mode and must never run in `bake`/embed renders.
- **Persistence:** `sailor_localGrid` saves on the frame node's properties like the other frame config. Absent → `{ mode: 'off' }` default on read.

## Decisions (resolved in brainstorm)

1. **Capped auto-convert is in slice 1**, refusing above 24 regions. All dense/dealt behaviour is sub-project 2.
2. **Grid changes freeze section pixel boxes**; sections offer a manual re-snap. No automatic reflow in slice 1 (reflow is ill-defined when a generated grid's column count changes).
3. **Base module is settable** and is the alignment unit everything snaps to. Explicit mode sets columns/rows directly; generated mode takes counts from the ranges and snaps dealt edges to the module. The Swiss discipline is that every edge is a module multiple.

## Testing

- **`grid.ts` unit tests:** given a config + size, edges are within margins, monotonic, and (at regularity 1) equal and module-aligned; merges are rectangular, within `mergeMaxSpan`, non-overlapping, and cover only real cells; the dealer is deterministic in `seed` (same seed → identical output, different seed → different); mirror symmetry produces a mirror-equal column plan.
- **Snap unit test:** `computeSnapAdjust` snaps a box edge to a grid line within `SNAP_PX` and leaves it alone beyond it; grid candidates are ignored when `mode === 'off'`.
- **Browser check:** grid overlay shows in edit mode and is absent from a bake; a marquee makes a snapped rect; a section fills with a gradient and with a shader; re-roll changes the grid and existing sections stay put; the auto-convert stamps sections for a coarse grid and refuses a fine one.
- **Backward-compat test:** a frame saved without `sailor_localGrid` loads with the grid off and renders byte-identically to before.

## Scope boundary (slice 1 is NOT)

No baseline grid, no nested sub-grids, no dense generative deal, no templates, no Smart Layout handoff, no automatic reflow, no `gridSpan` on layers. Those are sub-projects 2–4 and later, each consuming this substrate.
