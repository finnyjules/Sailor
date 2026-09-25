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

## Findings (Plan A, 2026-09-24)

Task 8 (browser verification, cost measurement) run against the existing main-checkout dev server
(`127.0.0.1:3002`, confirmed serving `/Users/julien/Documents/GitHub/Sailor/frontend`) and ComfyUI
(`127.0.0.1:8188`, `/system_stats` 200 — not required for this task but healthy). No server was
started, restarted or killed.

- **WebGL2 in Playwright Chromium:** yes — `document.createElement('canvas').getContext('webgl2')`
  returns a context, so the finish passes run for real in headless Chromium, not the fallback path.
- **Look check** (seeded dark-green Frame, a large serif "GOLD" text with `gold_foil`, a filled
  ellipse with `spot_uv`, a stroked ring ellipse with `spot_uv` + `varnishOnly`, Halation 0.7):
  screenshots at all four light presets confirm the foil reads as brushed metal (not flat yellow
  paint) and its highlight band visibly moves and re-angles between presets; "Top left"/"Top
  right"/"Overhead" each show a small point-light glint near the corresponding corner, "Raking"
  removes the glint dot and darkens/browns the letterforms on one side instead. The varnish-only
  ring is invisible as fill and shows only a thin gloss arc that moves with the light — the filled
  spot-UV ellipse shows the same gloss sweep, filled. Halation-on vs halation-off: the "on" shot
  shows a warm red/orange glow fringing the bright foil letters that is absent in "off".
- **Pixel-diff checks (in the spec, not just by eye):** pixel color under the foil glyph differs
  between "Top left" and "Raking" (both a whole-canvas data-URL compare and a direct pixel probe at
  the glyph). `frame-light-handle` is hidden with no selection, visible once a `gold_foil` or
  `spot_uv` effect row is selected, and hidden again once a layer row (not an effect row) is
  selected instead — selection-driven, not effect-type-driven beyond that gate. A real
  `page.mouse` drag of the handle (mouse down/move-with-steps/up, not a synthetic event) moves the
  handle more than 20px, changes the composite's pixels, and one `Control+z` restores both the
  handle position and the pre-drag pixels exactly — the whole drag is one undo step, recorded at
  pointer-down. Halation on/off changes the composite (`stackPixels` before/after differ).
- **Absent means unchanged:** verified by reasoning, not an A/B pixel diff. Method: read
  `git diff e860c652e..HEAD -- frontend/app` restricted to this plan's landed commits (ae2e31ca7,
  34d1c60f8, d51409715, daaba3861, 563ffd311, 469d2b45c, 9ff62f93f, 429e15014). `gold_foil` and
  `spot_uv` are new members of the effect-type union (`effectStack.ts`), so every new code path is
  reached only via a layer whose `effects` array contains one of these — an absent-by-construction
  branch, not a default-on one. `sailor_localLight` is read through
  `sanitizeLight((props as Record<string, unknown> | undefined)?.sailor_localLight)` — an optional,
  trailing, `undefined`-safe read with no independent default that would otherwise change a Frame.
  No new required field or reordering was found in the diff.
- **Cost** (re-measured at the final review; the first measurement was invalid — rAF-to-rAF wall
  clock is vsync-quantised, and its canvas was 542×542). Method (`tests/print-finishes.spec.ts`,
  `cost`): `paintLayerStack` imported in-page from the running dev server, called synchronously and
  timed with `performance.now()` on an offscreen canvas for a 1080×1350 Frame carrying three
  `gold_foil` text layers, ctx scaled by the device pixel ratio as the editor does; 2 warm-up paints,
  then 30 timed, each ending with a 1×1 `getImageData` so the 2D canvas has really finished. The
  test also proves the foil pass ran (gold pixels present). Headless Chromium on this Mac, dev server
  shared with other sessions; three runs:
  - **1× (1080×1350 device px):** median 10.2–12.4 ms, p95 11.7–19.4 ms. Within budget.
  - **2× (2160×2700 device px, the retina editor):** median 34.4–37.0 ms, **p95 50.5–51.6 ms — over
    the 33 ms budget.** A retina editor repainting a Frame with three foil layers will drop below
    30 fps on every repaint. Not fixed here: the at-rest cache is the controller's call.
- **Export inventory** (which Frame export paths paint in the browser, and so carry finishes and
  the placed light, vs. which don't):
  - **Browser-painted (finishes + the placed light apply):** the editor's live render
    (`CompositorModal.vue`'s stack canvas), Render/PNG export, Harmonize render, motion bake and
    browser video export (both through `prepareMotionFramePainter`, which now receives the light in
    `FrameDocPaint.light` — final-review fix), web export (`app/lib/embed/surfaces/frame.ts` and its
    `frame/plan.ts` / `frame/gather.ts` / `frame/needs.ts`), and canvas Frame cards
    (`ArtifactFrameNode.vue`, which now also repaints when the light moves).
  - **Queued graph runs:** the local layers are baked in the browser before queueing
    (`VueNodeCanvas.vue` `injectCompositorOverlays` → `bakeOverlay` → `drawLocalLayers` →
    `paintLayerStack`), so they DO carry finishes — and, since the final-review fix, with the Frame's
    own light (`readFrameLight(comp.properties)`), not the default.
  - **Not browser-painted:** only the server-side Compositor itself — the ComfyUI Python node
    `comfy_extras/nodes_compositor.py` and its Nitro port `frontend/server/runner/compositor/*`.
    Neither runs the shared painter, so anything they draw themselves (wired layers, their own
    effects) has no finishes; the local layers they receive are already-baked pixels.
  - **Preview-only sites on the default light** (not re-verified beyond the plan's own research —
    no grep run against these for this task): agent preview, `LayoutTile`, layer thumbnails, dev
    harness.
- **Nothing surprising** turned up in the product code itself. The surprises were in the test file
  left by the previous agent: `getByText('Post-processing', { exact: true })` never matched — the
  section header is a `<summary>` whose DOM text is `"› Post-processing"` (a chevron `<span>` ahead
  of the title text node), so `exact: true` can never equal just `"Post-processing"`; and seeding
  a scene through `__compositorSetLayers` leaves the last-seeded layer selected (same as `addRect`
  in `compositor-post-effects.spec.ts`), so the Halation test needed an explicit deselect click on
  an empty artboard corner before the frame-level Post-processing panel would show. Both were test
  bugs, fixed in `frontend/tests/print-finishes.spec.ts` — no product code was touched. Separately,
  two runs of the full suite hit transient `networkidle`/`page.goto` timeouts on the very first
  navigation of a run; retrying the same test alone always passed immediately after, and
  `curl -w "%{time_total}"` against `127.0.0.1:3002/` showed an 8s response once versus sub-250ms
  moments later — consistent with load from other sessions sharing this dev server, not a bug.

## Decisions made while building

Divergences from the design above, ratified at the final review (2026-09-24):

- **GpuPost vec3 uniforms use a `{ vec3 }` wrapper**, not "a 3-long array is a vec3". DOF's tap
  offsets are a `Float32Array` of 96 floats read as vec2s; guessing by length would misread them.
- **`applyFinish` replaces the layer's alpha** rather than recombining it with the original: foil
  erodes its own edge on purpose (stamped foil never has a perfect edge); Spot UV writes the layer's
  alpha back unchanged.
- **The no-WebGL2 message shows in the inspector**, not on the effect row. It is a plain sentence
  ("Finishes need WebGL 2, which this browser can't provide right now."); the raw cause goes to the
  console. Availability is per finish (`finishAvailable(kind)`), so one shader failing does not
  disable the other.
- **A lost WebGL context, or a layer larger than the GPU's texture limit, draws the layer plain**
  for that paint; the pass rebuilds its context on the next paint instead of drawing blank.
- **Halation is also a per-layer effect** (like Bloom), and its dials are animatable.
- **Halation's "weaker on the bright core" is not implemented:** both glows add with `lighter`.
  Tune by eye if it reads too hot.
- **Motion bake and browser video export carry the placed light**, as do queued graph runs (see the
  export inventory in Findings).

