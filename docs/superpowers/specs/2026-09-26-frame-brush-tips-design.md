# Frame brush tips — spray can, round, bristle (Part 1 of "painting with shaders")

Date: 2026-09-26 · Status: approved by Julien ("i trust you to build it properly. go ahead")
Prototype (the reference for look and feel): https://claude.ai/artifact/5BQwrs9jUwU1j2QAiiNdfQ (v14); source copy `docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html` — the constants and shaders to port live there

## In plain words

Today the Frame's brush stamps round dots of one size. It does not feel like painting.

Part 1 replaces it with three brush **tips**:

- **Spray can**: fine speckle over a soft mist. Holding still builds paint up, then it pools and drips.
- **Round**: a clean, even round brush with a little overspray and grain at the edge.
- **Bristle**: a loaded brush. Strokes thin a little when you move fast, taper at the ends, and break up into dry-brush marks.

Each tip's full settings sit in the right-hand panel. The quick choices (tip, size, colour, eraser, paint/mask) sit in a bottom toolbar, like the pen's.

A stroke is saved as **the movement you made** (pointer path, timing, tip settings, a random seed), not as pixels. When the Frame opens, the stroke is replayed and comes out exactly the same every time, on every machine and in every export. Files stay small and undo stays cheap.

The paint the tips make is only the *shape* of the paint. The brush layer's existing fill (colour, gradient, image, shader) is still poured into that shape, as it is today. So every fill keeps working, and Parts 2 and 3 (materials, the shader library, painting effects) build on this.

**What falls out of it:** exports at any size look like what you painted, just sharper. Old brush layers look exactly as before.

**What's risky:** replay must be exactly repeatable, which means no `Math.random` and no frame-rate-dependent steps. A long spray stroke replays thousands of specks, so the replay result must be cached.

## Scope

**In:** the three tips in **Paint** mode; the eraser with any tip; the bottom brush toolbar; per-tip settings in the right panel with the tuned defaults and Reset; per-tip settings remembered across sessions; saving and replay; rendering in every path that draws a Frame.

**Out (later parts):** curated materials and stroke-following materials (Part 2); "More shaders" and painted effects (Part 3). **Mask mode is unchanged.** It keeps today's round dabs and today's Size / Softness / Flow controls, shown only while in Mask mode.

## User-facing behaviour

### Bottom brush toolbar

It shows while the brush is active, in the bottom cluster where the tool row normally sits (the same place and pattern as `PenToolbar`). The prompt dock is hidden, as it is for the pen. From left to right:

- **Tip:** Spray can · Round · Bristle (segmented).
- **Size:** a compact slider showing its value in Frame pixels.
- **Colour:** a swatch that opens the colour picker. Paint mode only.
- **Eraser** (toggle).
- **Paint / Mask** (segmented).
- **Done** (the B key does the same).

A one-line hint under the toolbar describes the current tip:

- Spray can: "Hold still and the paint pools, then drips. Move fast for a light dusting."
- Round: "A clean round brush with a little overspray and grain at the edge."
- Bristle: "Slow down for a loaded stroke, flick fast for a dry, broken one."
- Mask mode: "Paint to hide part of the selected layer. The eraser brings it back."

### Right-hand panel (brush branch)

- **Paint mode:** a header "Brush · <tip name>", then that tip's settings as sliders with % values, then **Reset to defaults**. The sliders are:
  - Spray can: Speckle, Overspray, Drips, Build-up, Relief.
  - Round: Softness, Overspray, Grain, Smoothing, Relief.
  - Bristle: Speed thinning, Taper, Dry brush, Runs out of paint, Bristle texture, Paint thickness, Smoothing.
- **Mask mode:** today's controls, kept as they are: "Select a layer to mask", Clear mask, Size, Flow, Soft.
- The panel replaces today's brush branch at `CompositorModal.vue` ~L9999.

Slider ranges run 0–200%, and Round's run 0–400%. The defaults, as % of the prototype's baseline, were tuned by hand on 2026-09-26:

| Tip | Setting | Default |
|---|---|---|
| Spray can | Speckle | 25 |
| Spray can | Overspray | 20 |
| Spray can | Drips | 175 |
| Spray can | Build-up | 200 |
| Spray can | Relief | 0 |
| Round | Softness | 200 |
| Round | Overspray | 200 |
| Round | Grain | 200 |
| Round | Smoothing | 200 |
| Round | Relief | 5 |
| Bristle | Speed thinning | 15 |
| Bristle | Taper | 20 |
| Bristle | Dry brush | 65 |
| Bristle | Runs out of paint | 0 |
| Bristle | Bristle texture | 50 |
| Bristle | Paint thickness | 35 |
| Bristle | Smoothing | 60 |

Settings, tip and size are remembered per tip in `localStorage` (try/catch, falling back to the defaults). **Moving a slider affects only the next stroke.** Each stroke stores the settings it was painted with.

### Painting

- The paint target is unchanged: a selected brush layer, otherwise a new brush layer filled with the toolbar colour.
- One brush layer can hold strokes from different tips.
- Consecutive strokes **of the same tip** in a layer accumulate together. Two spray passes build up and fill in grain. A change of tip starts a new group that sits on top of the earlier ones.
- **Drips keep running after release.** The stroke commits (one undo step, one save) once its drips have settled, capped at 2 s, or immediately if the tool closes.
- The **eraser** uses the current tip and takes paint away in that tip's shape. A spray eraser leaves a speckled edge.

## What is saved

`BrushLayer.strokes` becomes `(PaintStroke | TipStroke)[]`. Legacy `PaintStroke` has no `tip` field and is unchanged.

```ts
interface TipStroke {
  tip: 'spray' | 'round' | 'bristle'
  v: 1                          // record version
  size: number                  // brush diameter, width-normalized (÷ artboard width)
  settings: Record<string, number>  // snapshot of that tip's settings (fractions: 1 = 100%)
  seed: number                  // uint32
  pts: number[]                 // flat [x, y, t, x, y, t, …]; x,y width-normalized (5 dp), t = ms since stroke start (integer)
  erase?: boolean
}
```

- A 5 s spray at ~120 samples/s is ~1,800 numbers, which is a few KB.
- Specks, drips and bristle marks are **never** saved. They are the replay's output.
- `strokeBounds` gains tip-aware padding. Spray pads by the spread plus overspray, plus drip length downward. Round pads by radius plus overspray. Bristle pads by half its maximum width. This keeps `brushBoxFromStrokes`, selection and hit-testing hugging the paint.
- Readers of layer JSON must tolerate the new shape. These are the agent surface, `mergeCompositorState`, the layer clipboard and the recolour sites; each must pass unknown stroke fields through untouched.

## How it draws

Every render path (modal, harmonize, static render/export, node card, layout tiles, agent render, motion bake, web embed, server-render bake) goes through the `drawLocalLayer` brush branch. That branch splits the strokes:

- **Legacy strokes** run the existing `stampStrokes` path, byte-identical to today.
- **Tip strokes** go to the new brush engine, which returns two canvases the size of the brush's offscreen:
  - **coverage**: white with alpha = where paint is. It is composited into the same offscreen in stroke order (source-over, or destination-out for erase), then the existing `source-in` fill runs unchanged.
  - **shade** (optional): a grey relief image, drawn with `soft-light` inside the coverage after the fill. It only exists when a stroke has relief or paint thickness above 0.

### Units

The replay runs in **Frame units: 1,080 per artboard width** (`REF_W = 1080`). It must be a fixed reference: `drawLocalLayer`'s `W` is the *render* width, which varies between the preview, exports and the node card, and the replay has to produce identical specks at every size. The prototype's px constants were tuned on a ~1,230 px-wide canvas and carry over 1:1 as Frame units.

The renderer maps Frame units to device px by `W·scale·dpr / REF_W`. The grain pattern is also defined in Frame units (2 grain cells per unit, the prototype's device-px grain at dpr 2). So a 4K export shows the same grain as the preview, only rendered sharper.

### Replay (pure, deterministic, unit-testable)

- The replay uses its own seeded RNG (`mulberry32` from `lib/rng.ts` + Box–Muller). `Math.random` is banned.
- The **spray** is simulated at a **fixed step of 1/120 s** across the stroke's timeline. The nozzle position is interpolated from `pts` by `t`. The simulation continues after the last sample until drips settle (≤ 2 s).
- Each step emits:
  - mist dabs, soft and large, along the moved segment;
  - speck particles: gaussian around the nozzle, a fraction as overspray;
  - "wet" dwell accumulation, which spawns drips; each drip runs down, slows, and ends in a blob.

  All constants come from the prototype v14.
- **Round** smooths the path with a lazy string of radius 3 × Smoothing, stamps dabs at spacing 0.08 × size, and adds a few overspray particles per dab just outside the edge.
- **Bristle**: lazy-string smoothing, Catmull-Rom, even 2 px spacing, corners rounded over 20% of the brush width, direction averaged over 18%, then a ribbon. Width follows speed (Speed thinning), plus tapers, dry-brush breakup by speed, and paint running out along the length (length measured in px, not by sample count).
- The **live stroke** replays through the same simulator, resumable. The live result for a stroke therefore **must equal** a from-scratch replay of the saved record. This is the key test.

### Rasterising (GPU, with a Canvas2D fallback)

This is a small dedicated WebGL2 context, modelled on `lib/compositor/gpuPost.ts`, with `gl.finish()` before handing the canvas back. It contains:

- **Density buffers** (R8, one per same-tip group). Mist and specks are added in additively. Erase subtracts.
- A **grain pass**: coverage = a smooth threshold of the density against a per-Frame-pixel hash-and-noise pattern. This is the fine grain of the prototype. Round adds a faint paper tooth. Relief turns the density gradient into shade.
- A **ribbon pass** for Bristle: bristle noise across the stroke, dry breakup, ragged edges, and paint-thickness relief turned into shade. This is ported from the prototype's ribbon shader, minus the materials.

If WebGL2 is unavailable, the fallback is a Canvas2D path. It draws mist and specks as arcs with `lighter` compositing, does the grain threshold through ImageData, and draws Bristle as a tapered polyline with no bristle texture. It is uglier but correct, and never blank.

**Cache.** Results are cached per layer, keyed by the stroke records' identity and count, `W·scale·dpr`, and the bounds. Only the live stroke is re-rendered each frame, incrementally.

## Files

- `app/lib/brushTips/`
  - `tips.ts`: ids, labels, slider ranges, defaults, hint copy.
  - `record.ts`: `TipStroke`, encode/decode, `isTipStroke`, bounds padding.
  - `random.ts`: seeded helpers.
  - `spray.ts`, `round.ts`, `bristle.ts`: pure simulators that emit dabs and ribbon geometry.
  - `engine.ts`: the GL renderer and fallback.
  - `coverage.ts`: the entry point and cache.
- `app/composables/useBrushPaint.ts`: adds `tip`, per-tip settings (persisted), timestamped sample capture, and `beginTipStroke` / `extendTipStroke` / `endTipStroke`. Mask mode keeps its current fields.
- `app/components/vue-canvas/compositor/BrushToolbar.vue` and `BrushTipSettings.vue`.
- `CompositorModal.vue`: mounts the toolbar, replaces the panel branch, records timestamps in the pointer handlers, handles the live preview and drip settling before commit.
- `useCompositorLayers.ts`: the brush-branch split and shade compositing.
- `brushStamp.ts`: `strokeBounds` is made tip-aware.

## Testing

- **Unit:**
  - Determinism: the same record gives identical dabs.
  - Live equals replay: feeding samples incrementally matches a one-shot replay.
  - Frame-rate independence: the live simulation driven at 30 fps and at 144 fps gives the same dabs.
  - Encode/decode round-trip.
  - Tip-aware bounds contain every emitted dab.
  - The legacy `PaintStroke` render path is unchanged (its existing tests stay green).
  - Settings persistence falls back to defaults on bad JSON.
- **Browser (real mouse on the running app):**
  - Paint each tip in the Frame; hold still with the spray can and see drips.
  - Undo; save and reload; the paint is identical (pixel diff ≈ 0).
  - Export at 2× and check the grain matches.
  - An old brush layer renders unchanged.
  - Check the toolbar at laptop widths (1280 and 1024).
