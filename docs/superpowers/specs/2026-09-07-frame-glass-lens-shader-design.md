# Frame — Glass lens (shader fill that refracts what's beneath it)

**Date:** 2026-09-07
**Status:** Design approved, ready for plan

## Summary

Today a layer's shader fill runs over the layer's *own* input Paint (a gradient,
solid, etc.) and paints an opaque result. This feature lets a shader fill instead
sample the **pixels beneath the layer** as its input, turning the layer into a pane
of glass that refracts / warps / recolours whatever it sits over, clipped to the
layer's own shape.

The scope of "beneath" is chosen by a selector on the shader fill:

- **Its own fill** — today's behaviour (default; old files unchanged).
- **Layers behind** — the shader samples the accumulated backdrop (everything painted
  below this layer in the stack).
- **A specific layer** — bound to one target layer the way a mask points at a source,
  ignoring everything else.

This is interpretation **B** from brainstorming: the backdrop is *fed into* the
shader as its input texture, not merely blended on top. All the existing
input-sampling distortion / lens / filter effects (Textured Glass `blinds`,
`crystal_prism`, `liquify`, `wave`, `water_ripple`, `swirl`, `pinch_bulge`,
`fisheye`, `lens_distortion`, `chromatic_aberration`, `kaleidoscope`, `droste`,
plus filters like `gaussian_blur`, `halftone`, `duotone`, `pixelate`) become glass
with **zero shader changes** — we only change what feeds `u_image0`.

## Frame UX placement (checked against the house rules)

This is a **property of an existing element** (the selected layer's shader fill),
tuned in the **inspector** for the current selection. It is not a right-panel
generator and not a new toolbar element, so it conforms to the Frame UX model
("elements from the toolbar, inspector tunes selection"). No new element type is
introduced; any shape that can carry a shader fill (rect, ellipse, path, polygon,
star, and text glyphs) can become glass.

## Precedents in the codebase (this is an extension, not a new subsystem)

The compositor is a 2D-canvas painter whose single entry point is
`paintLayerStack()` (`frontend/app/composables/useCompositorLayers.ts`). Two
existing layers already read/rewrite the pixels below them — glass follows their
shape:

- **`applyBackdropBlur()`** (`useCompositorLayers.ts` ~:2806, effect kind
  `background_blur`): renders the layer's silhouette, blurs the current device
  backdrop, clips the blurred backdrop to the silhouette with `destination-in`,
  stamps it back — already tied to the layer and honouring its mask ref. This is the
  structural template for glass.
- **`applyDisplaceFromLayer()`** (`useCompositorLayers.ts` ~:2851, an
  `ImageLayer.displaceMap`): the layer does **not** paint itself — it warps the
  backdrop already painted below it (`getImageData` → offset field → `putImageData`),
  dispatched with an early `continue` in the loop. This is the "don't self-paint,
  transform below" precedent.

Masks tie to a specific layer via `maskedByKey?: string` on `LayerCommon`
(`useCompositorLayers.ts` ~:285), resolved through the `byKey` map
(`layerMaskRef(layer)` ~:322). Glass reuses this exact resolution for its bound
target.

## Data shape

Extend `ShaderSpec` (`frontend/app/lib/spacetype/fillTile.ts` ~:59) with two
backward-compatible optional fields:

```ts
export interface ShaderSpec {
  // ...existing: effectId, params, anchor, speed, seed, input...
  readsBackdrop?: boolean   // undefined/false = runs over its own `input` (today)
  readsLayerKey?: string    // optional StackKey ('l:<id>' | 'w:<slot>');
                            // only meaningful when readsBackdrop is true
}
```

Selector → data:

| Selector value      | `readsBackdrop` | `readsLayerKey` |
|---------------------|-----------------|-----------------|
| Its own fill        | `false`/absent  | absent          |
| Layers behind       | `true`          | absent          |
| A specific layer     | `true`          | `'l:<id>'`      |

Absent fields load unchanged, so existing documents keep today's behaviour. No
migration step.

A layer is a **glass layer** when its primary fill is a shader (`fillIsShader`) whose
`readsBackdrop` is true and whose effect passes the eligibility predicate (below).
Helper: `isGlassLayer(layer): boolean` in the compositor layer module.

## Eligibility predicate

`effectReadsInput(effectId): boolean` — computed once at catalog load from whether
the effect's GLSL source references `u_image0` (the input sampler). The 10 purely
generative effects (`aurora`, `nebula`, `plasma`, `mesh_gradient`, `wisps`,
`light_beams`, `caustics`, `voronoi_cells`, `starfield`, `warp_tunnel`) return
`false`; everything else returns `true`. Lives alongside the catalog store
(`frontend/app/lib/shaderfx/catalogStore.ts`), derived from the already-loaded
`EffectDef.source`.

Used to gate the UI (disable the backdrop options for ineligible effects) and as a
safety guard in paint (a glass flag on an ineligible effect falls back to normal
self-fill).

## Paint integration — `applyGlassFromLayer`

New function in `useCompositorLayers.ts`, modelled on `applyBackdropBlur`, dispatched
from the `paintLayerStack` item loop (~:3066) after the hidden/skip guards and before
the normal draw, when `isGlassLayer(layer)`:

1. **Resolve the source pixels** (device-sized offscreen or a snapshot):
   - *Layers behind* (no `readsLayerKey`): snapshot the current device `ctx`
     (everything painted so far this frame) via `drawImage(dev, …)` /
     `getImageData` into a device-sized canvas.
   - *Bound* (`readsLayerKey` set): render **only that target layer** to a
     device-sized offscreen using its normal paint path, resolved through `byKey`
     exactly like `layerMaskRef`. Mask-source semantics: the bound layer is used as a
     source even if it is hidden, and (like a mask source) a bound layer's own normal
     self-paint is suppressed for the frame **only if** `readsLayerKey` points at it
     and it is not otherwise shown — decision: keep it simple for v1, the bound layer
     **still paints normally in the stack**; glass just also samples a copy of it.
     (Revisit only if double-appearance is unwanted in practice.)
2. **Refract**: run the shader field at device resolution with the source canvas bound
   as `u_image0` (see field hook). Params, anchor, speed, seed come from the spec.
3. **Clip to shape**: `destination-in` against the layer's own silhouette (rendered via
   the ghost-layer trick used at `applyBackdropBlur` ~:2832), and honour the layer's
   own mask ref if present, so the effect shows only inside the pane.
4. **Stamp back** onto `ctx` in device space honouring the layer's `opacity` and blend
   op (`localBlendOp(layer)` / `WIRED_BLEND_OP`).
5. **Stroke still paints**: after stamping, paint the layer's stroke normally so a
   glass pane can keep its border. The layer's own **fill is not painted**.

Ordering: glass renders inline at the layer's position in the stack, so glass-over-glass
composes naturally (the upper pane samples the already-refracted result below it).

## Field renderer hook

`frontend/app/lib/shaderfill/field.ts` (~:530) currently derives the input tile from
`getInputTile(spec.input, w, h)`. Add a code path that accepts an **externally supplied
base canvas** (the backdrop snapshot) and binds it as `u_image0` in place of the
rendered input Paint — everything downstream (`renderer.ts` ~:284–293 → `baseTex` →
`u_image0`) is unchanged because it already takes any `TexImageSource` sized `w×h`.

Concretely, expose a render entry that takes an explicit base:
`renderFieldWithBase(spec, baseCanvas, w, h, frameCtx)` (or an optional
`baseOverride` on the field request). It renders synchronously and returns the 2D
canvas the compositor stamps.

**Cache caveat (important):** the field cache keys on the input Paint's identity
(`descriptor.ts` `inputKey` / `fieldKey`; `field.ts` `tileCache`). A live backdrop
changes every frame, so **glass fields bypass the field cache and render inline during
paint** — they cannot join the pre-registered field batch (`addShaderFieldRequest`
~:2944) because the backdrop does not exist until lower layers have drawn. This means
one WebGL render per glass layer per paint frame. Reuse the existing renderer/GL
context; do not add a second one.

Device-resolution discipline: the snapshot and all offscreens are device-sized (per
the effected-layer device-res rule) to avoid a half-res lens on retina.

## UI — `ShaderFillEditor.vue`

Add a **Reads** control at the top of the shader editor (a segmented `StudioButton`
group or a select), sentence-case labels over internal values via `optionLabels`
(house copy rule — no internal identifiers, no lowercase-start labels):

- `Its own fill` · `Layers behind` · `A specific layer`

Behaviour:

- When the selected effect is ineligible (`effectReadsInput` false), the two backdrop
  options are **disabled with a hint** — e.g. "This shader has nothing to read behind
  it." — and the value is forced back to `Its own fill`.
- When `A specific layer` is chosen, reveal a **layer picker** listing the other layers
  in the stack (same interaction as the mask-source picker), writing
  `readsLayerKey`. Labels come from each layer's display name.
- When either backdrop mode is active, the now-irrelevant **input-fill sub-control**
  (the base Paint the shader used to run over) is **hidden** (no dead control).

Anchor / speed / seed controls stay, so animated lenses (`wave`, `liquify`,
`water_ripple`) still move.

## Testing

**Unit (vitest):**

- Serialization round-trip: `ShaderSpec` with `readsBackdrop` / `readsLayerKey`
  survives save/load unchanged; absent fields default to self-fill.
- `effectReadsInput`: pure-generative ids → `false`; `blinds`, `liquify`,
  `crystal_prism`, `gaussian_blur` → `true`.
- `isGlassLayer`: true only for a shader fill with `readsBackdrop` and an eligible
  effect; false for solid/gradient fills, ineligible effects, and `readsBackdrop`
  absent.
- Key resolution for `readsLayerKey` mirrors mask resolution (`'l:<id>'` → the right
  layer via `byKey`; dangling key → falls back to *Layers behind*).

(The actual refraction needs WebGL, so unit tests cover the data/dispatch/gating
logic with the paint primitives mocked.)

**E2E (browser preview, per the browser-e2e recipe):**

- A glass rect over a solid-colour layer: sampled region inside the rect differs from
  the raw backdrop (refraction happened), while pixels **outside** the rect are
  byte-identical to the no-glass render (clip is tight).
- Bound mode: refracts only the target layer; reordering / hiding other layers leaves
  the glass output unchanged.
- Device-res: correct on a 2× DPR preview (no half-res lens).

## Edge cases & decisions

- **Nothing below** (Layers behind, bottom of stack): samples the doc background /
  transparent — refraction of empty is empty; acceptable.
- **Dangling `readsLayerKey`** (target deleted): fall back to *Layers behind* rather
  than erroring.
- **Glass over glass**: upper pane samples the lower pane's refracted output; natural,
  no special-casing.
- **Generative effect flagged glass** (e.g. via an old edit): eligibility guard forces
  normal self-fill.
- **Own fill in glass mode**: ignored (you see only the refracted backdrop, no tint).
  Tinting is a possible later addition, explicitly out of scope for v1.
- **Performance**: N glass panes = N inline WebGL passes per frame; interactive drag
  can get heavy. Accepted for v1; noted, not solved. (Possible later: a per-frame
  backdrop token to memoise within a frame, or a live budget like
  `LIVE_FIELD_CEILING`.)

## Out of scope (YAGNI)

- Tinting / blending the layer's own fill *with* the refracted backdrop.
- Refracting layers **above** the glass, or an arbitrary non-adjacent set of layers
  (only "everything below" or a single bound layer).
- Caching glass fields across frames.
- A dedicated "Glass" toolbar element (rejected Approach 2).
