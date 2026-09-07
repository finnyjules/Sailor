# Frame: per-layer effects as an ordered stack in the layer tree

Date: 2026-09-06
Status: approved design, plan not yet written
Prior art: `docs/superpowers/specs/2026-09-05-scene3d-object-treatments-design.md` — the 3D Studio
landed the same UX (effects as child rows under the thing they belong to, tuned one at a time). This
spec applies that model to the Frame and adds real ordering, which the 3D version does not have.

## Problem

Two problems, one fix.

**The inspector is crowded.** Selecting a layer in the Compositor draws fourteen always-visible cards
in a fixed vertical run: drop shadow, inner shadow, layer blur, background blur, displacement,
adjust, bloom, grain, vignette, duotone, gradient map, depth of field, mask, crop, torn edge,
feather, cloner. None collapse. Each is added or removed by its own inline button. There is no add
menu and no overview of what a layer actually carries.

**Effect order is not editable, and each effect can appear once.** `layer.effects` is stored as an
array but read by looking each type up by name, so array order means nothing. `applyEffectChain`
applies a hardcoded sequence: adjust, duotone, gradient map, bloom, vignette, grain. Inner shadow,
layer blur, torn edge and feather each sit at their own fixed point in `paintLayer`. So a tear
inside a bloom and a tear outside it are not both expressible, and neither is adjust-after-gradient
-map. Two blurs on one layer are impossible.

## What ships

Per-layer effects become an **ordered list of instances with stable ids**, rendered as **child rows
under the layer** in the Compositor's left panel, tuned **one at a time** in the right panel.

### Rows: the orderable ten

These all run as passes over the layer's own device-sized offscreen, so they reorder freely and may
appear more than once on a layer:

inner shadow, layer blur, adjust, duotone, gradient map, bloom, vignette, grain, torn edge, feather.

### Rows: the pinned three

These cannot move and appear at most once. Each renders in the tree at its fixed position with a pin
marker, and refuses a drag:

- **Background blur** — always first. It samples the backdrop *before* the layer paints
  (`paintLayerStack` calls `applyBackdropBlur` ahead of the layer's own draw), so there is no
  position for it inside the layer's pass list.
- **Depth of field** — always with the content, before the layer enters frame space. It needs its
  depth map aligned to the layer's own pixels; once the layer is rotated, scaled or corner-pinned
  into the frame the depth map no longer corresponds. It also runs on the GPU against a box-sized
  source canvas.
- **Drop shadow** — always last. It is derived from the layer's finished silhouette at stamp time.

### Not rows

These stay as properties in the layer inspector, because they are what the layer *is* rather than
something applied to it: fill, stroke, size, rotation, opacity, blend mode, distort (corner-pin),
crop (`LayerMask`), cross-layer mask, cloner.

**Displacement is deliberately not a row.** An image layer carrying a `displaceMap` consumes itself
and warps everything painted below it — it is a lens the layer *is*, not an effect on the layer it
affects. Putting it under a layer as a child would say the opposite of what it does.

## Section 1: Data

`layer.effects` becomes an ordered list. Each entry gains:

- `id`: a stable string (`fx_<uuid>_<n>`), minted on creation. Motion tracks and agent keys address
  an effect by this, never by position, so reordering re-points nothing.

The type field and every dial stay exactly as they are today. `visible` stays the eye toggle.

**Torn edge and feather move into the list.** They live on `layer.tornEdge` and `layer.feather`
today, which is what pins them to one position. They become entries with `type: 'torn_edge'` and
`type: 'feather'` carrying the existing `TornEdgeSpec` / `FeatherSpec` fields. This is the change
that makes them orderable, and it is the largest single piece of the migration.

**Migration, on load, per layer:**

1. Stamp a fresh id on every effect that lacks one.
2. Fold `layer.tornEdge` into the list as a `torn_edge` entry, and `layer.feather` as a `feather`
   entry, at the positions they occupy in today's pipeline (after the chain, torn edge before
   feather). Clear the old fields.
3. Sort the whole list into the canonical order below, which is exactly the order `paintLayer` and
   `applyEffectChain` apply today.

Canonical order (also the order the add menu lists kinds, and the order a pinned row sits at):

```
background_blur · dof · inner_shadow · adjust · duotone · gradientMap
  · bloom · vignette · grain · torn_edge · feather · layer_blur · drop_shadow
```

A migrated document must render **byte-identically** to what it rendered before. That is the
migration's acceptance test, not a hope.

**Backward compatibility.** A frame saved by this build opened in an older build still works: the old
code looks each type up by name and ignores order, so it sees the first instance of each type and
renders the old fixed sequence. A second bloom, or a re-ordered list, is ignored rather than fatal.
Torn edge and feather are the exception — an older build reads them from the layer fields, which are
now empty, so those two effects disappear in an old build. That is a one-way migration and is
accepted; it is stated here so nobody is surprised.

## Section 2: Render

`applyEffectChain` becomes an ordered loop over the list rather than a lookup per type. One case per
pass kind, applied in list order, over the same device-sized offscreen it uses now.

`paintLayer` stops finding `inner`, `blur`, `tornEdge` and `feather` individually and runs them as
part of that loop. Two consequences:

- **Layer blur becomes a real pass** instead of a CSS filter set at stamp time. Today the canvas
  applies `filter` then computes the shadow, so the drop shadow follows the blurred silhouette;
  running blur as a pass before the stamp preserves that exactly.
- **The silhouette raster cache** currently short-circuits when only torn edge and feather are
  active. Its condition becomes "the list contains only torn edge and feather entries", any order
  and any count, and the cache key gains the list's order so two orderings cannot collide.

The three pinned effects keep their existing call sites: background blur in `paintLayerStack` before
the layer draws, depth of field inside `dofContent` on the box-sized source, drop shadow on the stamp.

**Two seams that would otherwise silently keep the old fixed order**, and which are required work,
not follow-ups:

- **The motion paint path** (`lib/motion/paint.ts`, reached through `drawLayerWithMotion`) composes
  its own effective layer for an animated frame. It must consume the ordered list the same way, or
  an animated layer renders its effects in the old sequence while a static one does not.
- **The agent vocabulary** (`lib/agent/surfaces/compositor.ts`) addresses torn edge by its old field
  path. It moves to the id-addressed list, alongside the other effect dials.

## Section 3: Left panel

- Effect rows render as **children under their layer row**, indented one level, reusing the existing
  recursive `flatRows` builder and its `depth` mechanism (the same one groups use). A new `'effect'`
  variant joins `'group' | 'local' | 'child' | 'wired'`.
- Each row shows a kind icon, the kind's human name, an eye toggle, duplicate and delete on hover,
  and a pin marker on the three pinned kinds.
- A **plus button on the layer row** opens the add menu listing all thirteen kinds in canonical
  order. A pinned kind already present is greyed out. The orderable ten can be added repeatedly.
- **Drag reorders** within the layer's own orderable region. A drop onto or across a pinned row is
  refused. Dragging an effect to a different layer is out of scope for this pass.
- A layer with effects gets a disclosure chevron, like a group.
- Layer kinds that cannot carry effects (if any) get no plus button.

## Section 4: Right panel

- Selecting an effect row sets a **selected effect** state, shaped `{ layerId, effectId }`, separate
  from the layer selection. Selecting a layer clears it and vice versa.
- With an effect selected the inspector shows a **breadcrumb** naming the parent layer, then only
  that effect's dials. Clicking the layer name in the breadcrumb selects the layer again.
- With a layer selected the inspector shows the layer's own properties only. The fourteen effect
  cards are gone from that view — this is the decongestion.
- The existing `PostEffectsControls` component already renders a generic effects array; it is the
  natural home for the per-effect dial rendering rather than a second implementation.

## Section 5: Tests

Unit:

- migration: a document with old-shaped effects plus `tornEdge`/`feather` fields loads to an ordered
  list with ids, in canonical order, fields cleared;
- a document with no effects round-trips unchanged;
- ordering: two lists differing only in order produce different pass sequences;
- duplicates: two blooms both apply;
- add, duplicate, delete, reorder helpers, including that reorder refuses to move a pinned kind;
- the silhouette cache condition and its order-sensitive key.

Browser (Playwright, real dev server):

- **A render-parity check on migration** — a frame with the full old effect set renders
  pixel-identically before and after the change. This is the test that protects every saved frame.
- Reordering two effects on one layer changes the rendered pixels (adjust and gradient map swapped).
- The tree flow: add from the plus menu, see the row and breadcrumb, toggle the eye, drag to
  reorder, delete.
- An animated layer renders its effects in list order (the motion-path seam).

## Out of scope, noted as follow-ups

- Dragging an effect between layers.
- Extracting the Compositor's layer list and inspector out of `CompositorModal.vue` (8,000 lines).
  This spec adds effect rows to the existing inline row loop and extracts only the new effect row as
  its own component, to keep the blast radius small.
- Presets: saving a stack of effects as a reusable set.
- `TornEdgeSpec`'s px-based `amount`/`grain`/`lipWidth`, which are inconsistent with every other
  dimension in the Compositor being normalized to canvas width. Pre-existing; not this change.

## Decisions recorded from the conversation

- Julien asked for the 3D Studio's treatment UX in the Frame, because the layer inspector is
  crowded. Effects belong in the tree, tuned one at a time.
- Offered the cheap version (keep the fixed order, one instance per type, tree as a better
  inspector) and the full version (real ordered stack). Julien chose the full version.
- Offered a half-ordered version (only the six chain effects orderable, the rest pinned) and the
  full one (everything except the structurally pinned). Julien chose the full one, so ten kinds are
  freely orderable and three are pinned for reasons that are structural, not convenience.
