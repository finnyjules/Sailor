# Print finishes: gold foil, spot UV, halation

Date: 2026-09-24 · Status: design approved in chat, spec awaiting review

**Reference prototype:** https://claude.ai/artifact/ARWNKLm4DiKuwEjij4bjhq ("Finish proofs").
It is the look target. Its shader constants are the starting values for the real passes, and every
look question is settled against it, one change at a time (see "Tuning" below).

## What we are building

Three finishes for Frame, taken from print and film:

- **Gold foil**: a metal stamped into the card. It catches the light, has fine brushed streaks and a
  slightly ragged, pressed-in edge.
- **Spot UV**: a clear gloss varnish on part of the design. The colour barely changes. It shows up
  only where the light reflects off it, which is what makes it look expensive next to matte card.
- **Halation**: film glow. Bright areas bleed a warm red fringe.

Foil and spot UV only come alive when the light moves, so the Frame gets **a light**. You can place
it, sweep it in Motion ("Shine"), and let viewers move it with the pointer in web exports.

## How it works for the user

### The layer is the mask

Gold foil and Spot UV are entries in a layer's effect list (the + menu), in the pixel band next to
Risograph, Photocopy and Letterpress. The finish goes wherever the layer has pixels. This works for
any layer type: text, shape or image. There is no separate mask to paint.

| Finish | Dials | Notes |
|---|---|---|
| Gold foil | Metal (Gold, Silver, Rose gold, Copper), Brushed, Pressed in | Replaces the layer's colours with the metal. |
| Spot UV | Gloss, Raised, Varnish only (on/off) | Off: the varnish coats the layer's own colours, for example a photo. On: the layer's colours are hidden and only the clear coat shows, sitting on whatever is below. That gives the tone-on-tone ghost pattern. |

Labels follow the house copy rules: sentence case, no identifiers.

### The light

- There is **one light per Frame**, not one per effect, so every finish on the page shines from
  the same place, as real print does.
- **Stored as** a position over the Frame (x, y as 0–1 across the canvas) plus a height above it.
  The default is top left, matching the prototype's opening light.
- **Placing it:** a single handle on the canvas, shown while a foil or spot UV effect is selected.
  It is built on the Distort corner-pin handle pattern (`CompositorModal.vue` `distortHandlePositions`
  / `onDistortPointerDown`). Presets sit in the effect inspector: *Top left*, *Top right*, *Overhead*,
  *Raking* (low and from the side). Dragging the handle records one undo step.
- **Stills** (the editor at rest, PNG, anything baked without time) use the placed light.

### Shine (Motion)

- *Shine* is a move you add in the Motion tab. The light sweeps across the Frame over the
  clip, starting from the placed position.
- Its dials are *Direction* and *Speed*. Video and web exports play it. Following the house rule,
  motion is authored only in Motion surfaces, never in the effect inspector.

### Follow the pointer (web export)

- A web-export option: *Light follows the pointer*. When it is on, viewers move the light with the
  mouse, or by dragging on touch screens.
- When the pointer leaves, the light eases back to where Shine (or the placed light) would have it.
- Phone tilt joins only where the browser allows it without a permission prompt. We do not show a
  permission prompt for a visual flourish.

### Halation

- Halation goes in the Frame's image-wide effects (the Post-processing list), next to Bloom.
- Its dials are *Amount* and *Spread*. It is image-wide only, not a per-layer effect.

## How it is built

### Rendering

**Gold foil and Spot UV are GPU passes.** They reuse the existing WebGL2 stage (`lib/compositor/gpuPost.ts`, the same machinery depth of field uses). A new
module `lib/compositor/finishPass.ts` holds the two fragment shaders and one lazy `GpuPost` instance for each, following `dofPass.ts`.

- **Inputs:** the layer's device-resolution offscreen canvas (colour and alpha), the light, the metal colours, the dials and the device scale.
- **Height:** comes from the layer's alpha, blurred in the shader with a few taps. Foil presses in and spot UV rises. No CPU blur.
- **Lighting:** the prototype's model, simplified for a flat Frame.
  - The card does not tilt, so the look comes from a moving light and a perspective view vector.
  - The paper tooth only applies to finished pixels; the rest of the Frame is untouched.
- **Dispatch:** new `case 'gold_foil'` and `case 'spot_uv'` branches in the layer body-pass loop
  (`useCompositorLayers.ts`, next to the recipe case). They follow `applyShaderPixelEffect`:
  snapshot, run the GPU pass, recombine with the original alpha. A new kind needs its own case,
  because `applyPasses` silently skips unknown types.
- **Varnish only:**
  - The pass outputs just the coat: the specular highlight as light pixels, plus a faint darkening where the varnish deepens what is below. Both are clipped to the layer's alpha.
  - It is drawn with normal blending over whatever is beneath.
  - The pass only sees its own layer, so the coat cannot re-colour the pixels below. It can only add the highlight and a faint darkening. That is enough for the ghost pattern, which is what this mode is for.
- **`GpuPost` change:** it currently sends every `Float32Array` uniform as a vec2. It will pick the type from the length: 2 → vec2, 3 → vec3, 4 → vec4. Existing callers only pass length-2 arrays, so they are unaffected. Metal colours go in as vec3.
- **Registration:**
  - `effectStack.ts`: interfaces, `LayerEffect` union, `EFFECT_ORDER` (pixel band, after `letterpress`), `EFFECT_LABELS`, `LOCAL_DEFAULTS`. The region is 'pixel' by fall-through.
  - The inspector goes in `CompositorModal.vue`, beside the recipe inspectors.
- **Cost:**
  - One GPU round trip per finished layer per repaint. At rest the output is cached, keyed by the layer's pixels, the dials and the light, so only a moving light or Shine repaints.
  - We measure playback with three finished layers at 1080×1350 before calling it done.

**Halation is a 2D-canvas pass**, like Bloom.

- Add `halation` to the `PostEffect` union, `POST_EFFECT_DEFAULTS`, `PASS_TYPES`, the `applyPasses` switch, and `CHAIN_ORDER` right after `bloom`.
- The pass:
  1. Extract the brights (a luminance threshold).
  2. Blur them at two widths.
  3. Colour the wide one red and the narrow one warm white.
  4. Add them back with `lighter`, weaker on the already-bright core.
- The inspector goes in `PostEffectsControls.vue` with *Amount* and *Spread*.

**No WebGL2:** a foil or spot UV layer draws as its plain layer. The effect row shows the reason, the
same way depth of field does (`unavailableReason()`). Nothing fails silently.

### The light in the document

- **Stored as:** a new Frame property `sailor_localLight: { x, y, height }`, read and written through `useLocalLayerEditor` like `sailor_localFx`, and included in the undo snapshot.
- **Painting:** `paintLayerStack` takes the resolved light as a new parameter and passes it to the finish passes.
- **Web export:** `FrameVariant` (`lib/embed/frame/types.ts`) gains `light` and `followPointer`, and `lib/embed/surfaces/frame.ts` hands them to the painter.

### Shine: the first Frame-level motion track

Today every motion track addresses a layer (`layers.<id>.…`), and the motion folds only rewrite layers.

- Shine adds a Frame-level namespace, `frame.light.x` / `frame.light.y`, evaluated before the layer passes run and used as the light for that time.
- The *Shine* move writes those tracks from its Direction and Speed dials.
- This is the first animatable property that isn't on a layer. The plan should keep the new namespace small and not generalise it past the light.

### Pointer in web exports

The export runtime ships the editor's own painter (`lib/embed/surfaces/frame.ts`, bundle
`entry-frame.ts`), so the finish passes come along automatically. Nothing in `lib/embed` listens to
the pointer today. Here is what's added:

- `setLight(x, y) | null` in the handle contract (`lib/embed/contract.ts`). `null` hands control back to Shine or the placed light.
- A pointer (and touch-drag) listener in the bundle runtime (`lib/embed/bundle.ts`). It is only attached when `followPointer` is on, and it eases the light toward the target.
- The live check (`lib/embed/frame/liveCheck.ts`) covers a Frame with a finish, so an export that
  silently drops the pass is caught.

### Agent

Picker and UI only for now, like the F7 print recipes. The compositor agent surface rejects these kinds, and a unit test asserts it, so the hint budget does not change. Adding finishes to the agent vocabulary is the same deferred hint-ceiling decision as the recipes.

## Out of scope

- Die-cut (discussed; separate idea).
- Holographic foil as a fifth metal: the Holographic fill already exists. Revisit after the look is settled.
- Any render path that doesn't run the browser painter. The plan must list which Frame export paths
  paint in the browser and flag any server-side path, where finishes would be missing.
- A tilting card in the editor. The prototype rocks the card; Frame keeps the image flat and moves the light.

## Build order

Each stage lands and is verified on its own:

1. **Halation.** It is independent and small, and proves the post-chain insertion.
2. **The light:** property, handle, presets, undo. Plus **Gold foil**, including the `GpuPost` uniform change and the at-rest cache.
3. **Spot UV**, including *Varnish only*.
4. **Shine** in Motion (the Frame-level track).
5. **Follow the pointer** in web exports.

## Testing

- **Units:**
  - effect registration: order, labels and defaults, and that an absent effect changes nothing
  - `GpuPost` uniform-type selection
  - light read/write and undo
  - Shine track evaluation, meaning the light at a given time
  - halation on a real canvas: a bright dot gains a red fringe, and a dark frame stays byte-identical
  - the agent rejecting the new kinds
- **In the browser (main dev server, after checking which checkout it serves):**
  - Seed a Frame with a text layer (foil), a photo (spot UV) and a varnish-only shape, using `__compositorSetLayers`.
  - Screenshot it at several light positions.
  - Compare it by eye with the prototype.
  - Check that the no-WebGL2 path shows its reason.
- **Export:** run the live check on a Frame with each finish. Test pointer-follow by moving the pointer and checking that pixels change near the finish.

## Tuning

- The looks are tuned against the prototype by eye, following the anchor rule: keep the last render
  you accepted as the base and change one thing at a time on a 2×2 contact sheet.
- Constants that are picked once stay constants. Don't add a dial to chase a look.
