# Frame light layers, stage 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lamp, Spot and Sun become real Frame layers that light text, shapes and the background, with soft shadows from floating layers; each layer has a **Lit by lights** and a **Casts shadows** switch (+ Lift); the Frame has a **Darkness** dial. Photos are lit flat in this stage (their shape comes in stage 2).

**Architecture:**
- A new local layer kind `light` that is never drawn itself.
- Per-layer `lit` / `castsShadow` / `lift` fields, and one Frame record `sailor_localLighting = { darkness, backgroundLit }`.
- After the main layer loop, `paintLayerStack` stamps two Frame-sized maps from the layers' silhouettes:
  - **lit**: top layer wins;
  - **lift**: casting layers, added up.
- One WebGL2 pass then lights the composite: ambient from Darkness, plus each light's colour × falloff × cone × facing, with a screen-space shadow walk over the lift map. Post-processing runs after it.
- With zero visible light layers nothing extra runs. The output is byte-identical.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, WebGL2 (via the `GpuPost` helper), Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-01-frame-light-layers-design.md` — sections 1, 3 and stage 1 of section 4. The prototype (artifact `Fw3HS51Ddc5Rti85iojbhV`, scratchpad `lightproto/light-layer.html`) is the reference for the look, the shader maths and the default values.

## Global Constraints

- **No light ⇒ byte-identical.**
  - A Frame with no visible `light` layer must paint exactly as today: no maps, no GPU pass, no extra draws on the main context.
  - Nothing is written to a Frame until the user edits.
  - This is the headline test of every task that touches the painter.
- **Light layer shape (exact):**
  ```ts
  interface LightLayer extends LayerCommon {
    kind: 'light'
    light: {
      type: 'lamp' | 'spot' | 'sun'
      height: number      // 0..1
      color: string       // #rrggbb
      brightness: number  // 0..3
      reach: number       // 0.2..2, Frame widths
      aimX: number        // spot only, fraction of the Frame
      aimY: number
      cone: number        // spot half-angle, radians 0.1..0.8
      edge: number        // spot edge softness 0..1
    }
  }
  ```
  - Position is the layer's own `x`/`y`: fractions of the Frame, allowed −0.5..1.5.
  - A sun's light travels from its dot toward the Frame centre, at elevation `0.12 + height·1.3` rad.
  - Lamp/spot `z = 0.04 + height·0.9` (Frame widths).
  - Defaults by type (from the prototype):
    - **Lamp:** `{height:.55, color:'#ffb36b', brightness:1.6, reach:1.0}`
    - **Spot:** `{height:.8, color:'#fff1d6', brightness:2.2, reach:1.4, aim centre, cone:.35, edge:.5}`
    - **Sun:** `{height:.4, color:'#fff3e2', brightness:1.2}`
- **Per-layer fields** (on `LayerCommon`, all optional, absent = default):
  - `lit?: boolean` — default true.
  - `castsShadow?: boolean` — default true for text, rect, ellipse, polygon, star, path, line, brush, deal, scatter; false for image and wired.
  - `lift?: number` — default 0.045 for text, 0.035 for every other caster, 0.03 for image and wired; range 0.005..0.15 Frame widths.
  - Stacked casting layers add their lifts.
- **Frame record** `sailor_localLighting = { darkness: number (0..1, default 0.45), backgroundLit: boolean (default true) }`.
  - Read through one sanitizer; absent = defaults.
  - It is in the undo snapshot.
- **At most 6 light layers per Frame (`MAX_LIGHTS = 6`).** Add-light and duplicate refuse past 6, with a toast.
- **Lighting maths, verbatim from the prototype shader** (`lightproto/light-layer.html`, the `FS` string):
  - Linear-light albedo (`pow 2.2`).
  - Ambient `1 − darkness·0.92`.
  - Lamp falloff `r²/(r²+d²·3)`.
  - Spot `smoothstep(cos(cone), cos(cone·(1−edge·0.9)), dot(−L, axis))`.
  - Wrapped `ndl = max(dot(n,L)·0.85+0.15, 0)`.
  - Shadow walk: up to 56 steps of 0.0075 Frame widths, per-pixel jitter, softness `smoothstep(0, 0.02 + t·0.25, above)·0.85`.
  - Tone `col/(1+col·0.18)`, then back to sRGB.
  - Flat normals in stage 1. The shine highlight is out of stage 1.
  - Unlit pixels pass through untouched.
  - Composite alpha is preserved: a transparent Frame stays transparent where it was.
- **Without WebGL2** (or on context loss), the Frame paints unlit, exactly as without lights. The editor shows a muted note in the light inspector: "Lights need graphics acceleration".
- **Copy:** sentence case; explanations only in tooltips; Lamp / Spot / Sun; "Lit by lights", "Casts shadows", "Lift", "Darkness", "All lights".
- **Main checkout, private-index commits** (recipe in every brief). `CompositorModal.vue` and `useCompositorLayers.ts` may carry other sessions' uncommitted edits: commit HEAD's blob plus your own hunks only, then `git reset -q -- <paths>`. Never `git stash`/`checkout --`/`restore`/`reset --hard`/`clean`. Never start or stop the dev server on :3002.
- **Type check:** `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -c 'error TS'`. Re-measure the baseline at Task 1 start; no new errors in touched lines.

---

### Task 1: The model, its defaults, storage and the kind's exhaustiveness

**Files:**
- Create: `frontend/app/lib/frame/lighting/settings.ts`. It holds:
  - `MAX_LIGHTS`, `LIGHT_DEFAULTS` by type, `defaultLit`, `defaultCastsShadow(kind)`, `defaultLift(kind)`;
  - `sanitizeLightLayer(raw) → LightLayer`, `newLightLayer(type, at?)`;
  - `FrameLighting`, `DEFAULT_LIGHTING`, `readFrameLighting(props)`, `sanitizeLighting`;
  - `effectiveLit(layer)`, `effectiveCasts(layer)`, `effectiveLift(layer)`;
  - `visibleLights(layers)` (visible light layers, capped at 6, in stack order).
- Modify `frontend/app/composables/useCompositorLayers.ts`:
  - add `'light'` to `LocalLayerKind`;
  - add `LightLayer` and the three optional fields on `LayerCommon`;
  - add `LightLayer` to the `LocalLayer` union.
- Make the painter treat a light as invisible content:
  - `drawLayerContentBody`: early return for `light`;
  - `localLayerBox`: a light's box is a 0×0 at its point;
  - `layerPaints`: `case 'light': return []`;
  - `renderLayerThumbnail`: a light draws a filled glow disc of its colour;
  - make sure `effectStackOf` / silhouette caching never run for lights.
- Modify `frontend/app/composables/useLocalLayerEditor.ts`:
  - `sailor_localLighting`: read, `writeLighting`, `setLighting(patch, record = true)`, exported;
  - include it in `Snapshot` / `snapshot()` / `restore()`;
  - `addLight(type)`: `addLocal(newLightLayer(...))`, refused past `MAX_LIGHTS` with a toast "A Frame holds up to 6 lights";
  - `duplicateSelection` respects the cap.
- Make the non-painter places ignore or label lights:
  - `lib/compositor/frameChipLayer.ts` `KIND_TO_SHAPE` (skip);
  - `lib/compositor/recolour/sites.ts` (a light's colour is not a recolour site in stage 1);
  - `lib/frame/responsive/units.ts` and `lib/frame/patterns/frameContext.ts` / `kit/plan.ts` (light layers are not content and are never moved by layouts);
  - `lib/motionx/adapter/frame.ts` `animatableProperties`: a light gets Position X/Y only, no scale, rotation or opacity;
  - `lib/agent/surfaces/compositor.ts` describe pass skips lights; agent light ops are stage 4.
- Test: `frontend/tests/unit/frame-lighting-settings.unit.spec.ts`, plus extend the existing editor/undo spec that covers `sailor_localLight` (find it by grep) for `sailor_localLighting`.

**Interfaces produced:**
- `LightLayer`, `FrameLighting`, `readFrameLighting(props)`, `visibleLights(layers)`, `effectiveLit` / `effectiveCasts` / `effectiveLift`, `newLightLayer(type, at?)`, `MAX_LIGHTS`.
- The editor's `addLight`, `setLighting`, `lighting` (computed).

- [ ] **Step 1: Failing tests.**
  - Sanitizer clamps each field and falls back per type; an unknown type becomes lamp.
  - Defaults per kind.
  - `visibleLights` order, cap and hidden lights.
  - `readFrameLighting` on absent / garbage input.
  - Undo restores Darkness.
  - `addLight` refuses the 7th light.
  - A Frame without the key writes nothing on load.
- [ ] **Step 2: Run to fail; Step 3: implement; Step 4: run plus the compositor and motionx specs touched, and the type check.**
- [ ] **Step 5: Commit.** Message: `feat(frame): light layer kind, lighting record and per-layer light switches (light layers stage 1)`.

### Task 2: The lighting pass and the maps, inside paintLayerStack

**Files:**
- Create `frontend/app/lib/frame/lighting/lightingPass.ts`:
  - a WebGL2 pass in the `GpuPost` style (lazy program, own offscreen canvas, `gl.finish()` before returning, `available()` / `unavailableReason()`, context-loss `drop()`);
  - three textures: colour, lit, lift;
  - light uniforms packed as `vec4 uA[6]` (x, y·aspect, z, type), `vec4 uB[6]` (linear r, g, b × brightness, reach), `vec4 uC[6]` (aimX, aimY·aspect, cosOuter, cosInner), `float uCount`, `float uDark`, `float uAspect`, `float uLiftScale`;
  - shader maths verbatim from the Global Constraints.
  - Extending `GpuPost` with named extra textures and vec4-array uniforms is acceptable instead, if it stays backward compatible (relight and dof unchanged). The implementer decides and says which.
- Create `frontend/app/lib/frame/lighting/maps.ts`, `stampLightingMaps(items, layers, W, H, devW, devH, opts) → { lit: canvas, lift: canvas } | null`:
  - **lit:** start from `backgroundLit` (white or black); each non-light visible layer stamps its silhouette (`drawLayerSilhouette`, full opacity) in white if lit, black if not, source-over in stack order.
  - **lift:** start black; each casting layer stamps its silhouette with grey `lift/LIFT_SCALE` using `'lighter'`, so stacked lifts add.
  - `LIFT_SCALE = 0.16`, as in the prototype.
  - Maps are device-sized, capped at 2048 px on the long edge, and kept between paints when nothing but lights or darkness changed. Key them by a cheap signature of the non-light layers and the size.
- Modify `paintLayerStack` (`useCompositorLayers.ts` ~6702):
  - new 15th optional param `lighting?: FrameLighting`;
  - after the main loop and **before** the post chain: if `visibleLights(localLayers).length > 0` and the pass is available, stamp the maps from the same folded items the loop drew, then run the pass on the composite canvas and draw the result back (copy semantics, alpha kept).
  - Motion-active and reveal layers stamp their folded transform. Per-letter behaviours are not followed in stage 1; note it.
- Thread `lighting` to every caller, read from `readFrameLighting(props)` or the editor's `lighting`:
  - `ArtifactFrameNode.vue` (live ~679 and export ~1011, plus its repaint key ~940);
  - `CompositorModal.vue`: live ~6250 with its dependency key ~6357, Harmonize ~5497, static render ~5633, `frameDocPaint()` ~5474 → `lib/motion/bake.ts` ~143, `webExportVariant()` ~5756;
  - `LayoutTile.vue` ~74 (plus props at the modal's `<LayoutTile>`s);
  - `useCompositorAgent.ts` ~176;
  - the embed `FrameVariant` (`lib/embed/frame/types.ts`) and `lib/embed/surfaces/frame.ts` ~377 (the art call; the background-only call ~331 stays unlit);
  - `VueNodeCanvas.vue` ~6090 `bakeOverlay`: ruling — the Run-submit overlay bake gets lighting too, so a Frame sent into a workflow matches the editor;
  - the layout / set cache-key lists (`useLayoutVary.ts` ~786/946, `kit/set.ts` ~59, `layoutSetSend.ts` ~52) copy `sailor_localLighting` with the other Frame props.
- Tests:
  - `frontend/tests/unit/frame-lighting-paint.unit.spec.ts`, modelled on `frame-light-paint.unit.spec.ts` (stub ctx, no WebGL):
    - no light layer ⇒ no extra draw on the main context (byte-identical);
    - a light layer with no WebGL2 ⇒ the same draws as without it;
    - the light layer itself draws nothing.
  - `frontend/tests/unit/frame-lighting-maps.unit.spec.ts` (happy-dom or a canvas stub): lit order (an unlit top layer clears the lit map under it); stacked lifts add; hidden layers and light layers stamp nothing.
  - Shader maths in a pure helper `lightAt(params)`, a TS mirror of the per-light term used for tests:
    - a lamp on the left gives more on the left;
    - Darkness 0 never darkens;
    - a spot outside its cone gives 0;
    - a sun has no falloff.

- [ ] Steps: failing tests → fail → implement → run (plus `post-effects-paint`, `frame-light-paint`, `compositor-*` paint specs, the relight specs) → type check → commit.
  Message: `feat(frame): one lighting pass over the Frame — lit and lift maps, lamp/spot/sun, soft shadows, Darkness; no light ⇒ byte-identical (light layers stage 1)`.

### Task 3: On the canvas — add lights, see them, drag them

**Files:** `frontend/app/components/vue-canvas/CompositorModal.vue` (special commit recipe); optionally a small `frontend/app/components/vue-canvas/compositor/LightHandles.vue` for the dots, recommended to keep the modal lean.

- **Toolbar:** a **Light** button with a chevron menu (Lamp / Spot / Sun) beside the shapes cluster (~10392), the same `relative flex` pattern; `closeToolbarMenus` closes it.
  - It calls `viewOnlyGuard()`, then `addLight(type)`. The new light lands at a sensible spot (lamp: top left of the visible Frame; spot: top centre aiming at the centre; sun: the left edge) and is selected.
  - Disabled at 6 lights, with a tooltip.
- **Light dots** (only while the Design tab is showing; never in Render, export or card):
  - each light is a glowing dot in its colour (`data-testid="light-dot"`, `:data-light-id`), with a ring when selected;
  - a spot also shows a dashed aim ring (`data-testid="light-aim"`) joined by a dashed line;
  - a sun shows a dashed line toward the Frame centre;
  - positions come from the layer's `x`/`y` in `canvasDisplay` px; dots may sit up to half a Frame outside the artboard.
  - **Drag:** dragging a dot or the aim ring is ONE undo step (`recordOnce(recordHistory)` from `lib/relight/gestureHistory.ts`, then `setLocal` without history on each move, as `onRelightHandleDown` does). Scroll over a dot changes Height, one undo step per gesture (`wheelGestureRecorder`). Arrow keys nudge a focused dot (Shift ×5). Clicking a dot selects its light.
  - Dots sit above the artboard's hit testing (`data-handle`, `@pointerdown.stop`) and never start a marquee or canvas pan.
- **Selection:** a selected light shows no transform box (no resize or rotate handles); Delete removes it; ⌘D duplicates it (cap).
- Test: extend or create `frontend/tests/unit/` coverage for the placement helpers (`lightDotPos`, `aimPos`) if they are pure; the browser coverage is Task 5.
- Commit message: `feat(frame): add lamps, spots and suns from the toolbar and drag them on the canvas (light layers stage 1)`.

### Task 4: The panels — light rows, the light inspector, the switches, Darkness

**Files:** `CompositorModal.vue` (special commit recipe); optionally `frontend/app/components/vue-canvas/compositor/LightInspector.vue` and `LightShadowControls.vue` (recommended).

- **Layer list:**
  - light rows sort to the **top** of the list (adjust `flatRows` ordering), each with a glowing swatch of its colour instead of a thumbnail, labelled "Lamp" / "Spot" / "Sun" (or the user's name);
  - `kindIcon` and `rowLabel` handle `light`;
  - every other layer row gets two hover-revealed toggles beside Lock: a **shadow** toggle (`data-testid="row-casts-shadow"`) and a **bulb** (`data-testid="row-lit"`), lit or unlit style, `aria-pressed`, each with a tooltip;
  - the toggles are shown **only while the Frame has at least one light**;
  - toggling is one undo step.
- **Light inspector** (selected light; the generic Transform, Fill and outline, Distort and blend and Mask and crop cards are hidden for lights):
  - Lamp / Spot / Sun segmented;
  - Colour: swatches `#ffb36b #fff1d6 #ffffff #9fd0ff #ff3fa4 #2fe0ff #b3ff6b` plus any colour;
  - Brightness 0–3, Height 0–100%, Reach 0.2–2 (lamp and spot);
  - Cone (shown in degrees) and Edge (spot);
  - Delete light;
  - a bottom **All lights** card with **Darkness** (tooltip "Applies to the whole Frame");
  - the "Lights need graphics acceleration" muted note when the pass is unavailable;
  - every slider gesture is one undo step (the existing `StudioSlider` drag convention).
- **Selected non-light layer:** a **Light and shadow** card (only while the Frame has a light) with Lit by lights and Casts shadows switches, and Lift while casting.
- **Nothing selected:** the Frame card gains **Darkness** and the Background section gains **Lit by lights** (`backgroundLit`), both only while the Frame has a light.
- Tests: `frontend/tests/unit/` for any extracted component (segmented switches kind and keeps position; the toggles emit; Darkness shows only with lights).
- Commit message: `feat(frame): light rows, the light inspector, Lit by lights / Casts shadows switches and Darkness (light layers stage 1)`.

### Task 5: Browser checks, speed, web export

**Files:** `frontend/tests/frame-light-layers.spec.ts` (create); `tests/unit/embed-build-output.unit.spec.ts` only if the measured bundle needs a re-derived ceiling (×1.15 rule; say so).

- [ ] **Step 1: Playwright on the running :3002** (never start or stop it). Use the `_helpers` `openCompositor` and `__compositorSetLayers` harness from `relight-effect.spec.ts`, with a text layer, a shape and a coloured background.
  1. With no light, the composite pixels equal the same Frame read before any light code ran (byte-identity in the real editor).
  2. Add a lamp from the toolbar: the dot appears, the light row is at the top, and the row toggles appear on the other rows.
  3. Drag the lamp from left to right: the left half gets darker and the right half brighter (per-half mean); one ⌘Z puts the lamp back.
  4. The text's shadow falls away from the light: sample a pixel just past the text on the side away from the lamp (darker) and the side toward it.
  5. The bulb off on the text leaves its pixels unchanged vs no light.
  6. Darkness 0 never makes any pixel darker than the unlit Frame.
  7. A spot gives a pool (centre brighter than outside the cone); a sun lights the Frame evenly.
  8. The 7th light is refused.
  9. A reload keeps the lights, switches and Darkness.
  10. Render / Download PNG matches the editor (the existing Render path; compare a small region).
- [ ] **Step 2: Speed.** Drag a lamp for 2 s on a 1080×1350 Frame with ~8 layers. Record the median and p95 frame time of the lighting pass (instrument with `performance.now()` around the pass behind a test hook). Target: under ~4 ms median. Report the numbers; if over, note where the time goes.
- [ ] **Step 3: Web export.** Export a lit Frame with the web export and open it in a page. It must look like the editor (reuse `tests/_frameEmbedHelpers.ts`). Run `npm run build:embed` only if the size test needs it, and report both bundle sizes.
- [ ] **Step 4: Commit** the spec. Message: `test(frame): light layers in the real editor — drag, shadows, switches, Darkness, byte-identity, export (stage 1)`.

### Task 6: Record the state
`docs/STATE.md`, the dashboard, memory.

## Rulings made while writing this plan
- **One Frame record `sailor_localLighting { darkness, backgroundLit }`,** not two keys. The background has no layer row, so its Lit switch lives in the Frame record. One sanitizer, one undo field.
- **The lighting pass runs after the layer loop, from re-stamped silhouettes,** not from hooks in each draw branch. The motion, glass and reveal branches all `continue` before `drawOwn`, so hooks would miss layers. A second stamping pass over the same folded items is simpler and complete. The cost is per-letter behaviours not shading their moving letters in stage 1.
- **Row toggles and the Light and shadow card show only while the Frame has a light,** like Darkness, so a Frame without lights shows nothing that does nothing.
- **The Run-submit overlay bake is lit too,** so a Frame fed into a workflow matches the editor.
- **Lights take only Position in Motion until stage 4,** and scale, rotation and opacity are hidden for them, since lights are never drawn.
