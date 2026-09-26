# Frame Brush — More Shaders and Painted Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint with any library shader (fixed to the surface), and paint effects onto everything beneath a brush layer (a new **Effect** brush mode), both reusing existing Frame machinery.

**Architecture:**
- A painted effect is a brush layer with `showPaint: false` and one `backdrop_shader` in its effect stack. The backdrop pass already weights the effect by the layer's alpha. We skip the layer's own paint draw, but the backdrop "ghost" keeps the paint.
- A library shader as paint is the brush layer's ordinary shader fill (`anchor: 'frame'`).
- The UI adds an Effect mode, curated effect chips, and "More…" buttons that open the existing `ShaderEffectGallery` with a filter.

**Tech Stack:** Vue 3 + TS (Nuxt 4), Canvas2D/WebGL2, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-frame-brush-shaders-effects-design.md` (binding).

## Global Constraints

- **Curated effects** (label → catalogue id), in this order:
  1. Ripple → `water_ripple`
  2. Reeded glass → `blinds`
  3. Glow → `bloom`
  4. Dither → `bayer_dither`
  5. Colour split → `chromatic_aberration`
  6. Pixels → `pixelate`
  7. Frost → `gaussian_blur`
- **`BrushLayer.showPaint?: boolean`** — absent or true = today's behaviour, byte-identical. `false` = the layer's own paint is never drawn, but the backdrop pass's silhouette ghost is built as if `showPaint` were true.
- **The effect layer's effect stack** holds one `backdrop_shader` with `effectId` = the chosen id, `speed: 0`, and the other fields from `LOCAL_DEFAULTS`. Use `addEffect` from `lib/compositor/effectStack.ts`, then set `effectId`.
- **A library shader as paint** is a shader fill: the default shader spec with `effectId` and `anchor: 'frame'`. Find the default the Fill picker uses (`DEFAULT_SHADER_SPEC` in the ShaderFillEditor / FillControl area) and reuse it. No `material`.
- **Gallery filters:**
  - The paint gallery includes a def when it is generative (`def.generative === true`) or `def.category === 'material'`.
  - The effect gallery includes a def when `effectReadsInput(def.id)` is true.
- **Copy** is sentence case with exact strings:
  - Mode labels: "Paint", "Effect", "Mask".
  - "More…".
  - Effect hint: "Paint where the effect should happen. Go over it again to make it stronger."
  - Panel header: "Painted effect · <label>".
  - Button: "Change effect…".
  - Panel note: "The paint is hidden; it sets where the effect applies and how strongly."
  - For an effect not in the curated list, the label is the catalogue def's `name`.
- **Persistence:** the existing `sailor.brushTips.v1` store gains `mode`, `effect` (a catalogue id, default `water_ripple`) and `shaderPaint` (a catalogue id or null). Invalid values fall back to the defaults.
- **Commits:**
  - Use the private-index recipe (paste from `global.md` in the workspace).
  - `CompositorModal.vue` goes through the snapshot → patch recipe: other sessions keep uncommitted edits in it.
  - Never `npm run dev`. Never `git stash`.

## File map

| File | Responsibility |
|---|---|
| `frontend/app/lib/brushTips/effects.ts` | Curated effects, gallery filter predicates, effect label lookup |
| `frontend/app/composables/useCompositorLayers.ts` | `BrushLayer.showPaint`; skip own paint; the ghost keeps the paint |
| `frontend/app/composables/useBrushPaint.ts` | Mode `'effect'`, `effect`, `shaderPaint`, persistence, target-rule helpers |
| `frontend/app/components/vue-canvas/compositor/BrushToolbar.vue` | Paint · Effect · Mask, the effect row, More… buttons (emit events) |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Galleries, new-layer creation, target rule, effect-layer panel |

---

### Task 1: Curated effects and gallery filters

**Files:**
- Create: `frontend/app/lib/brushTips/effects.ts`
- Test: `frontend/tests/unit/brush-effects.unit.spec.ts`

**Produces:**
```ts
export interface BrushEffect { id: string; label: string; swatch: string /* CSS background */ }
export const BRUSH_EFFECTS: readonly BrushEffect[]           // the 7, in order, ids/labels exact
export const DEFAULT_BRUSH_EFFECT = 'water_ripple'
export function paintGalleryInclude(def: { id: string; generative?: boolean; category?: string }): boolean   // generative || category === 'material'
export function effectGalleryInclude(def: { id: string }): boolean                                         // effectReadsInput(def.id)
export function brushEffectLabel(id: string): string            // curated label, else getEffectSync(id)?.name, else 'Effect'
```

Swatches:
- Take them from the prototype's `EFFECTS` table (`docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html`, ~L132-140).
- Map by label: Ripple, Reeded glass, Glow, Dither, Colour split, Pixels, Frost.

Where things live:
- `effectReadsInput` and `getEffectSync` are in `~/lib/shaderfx/catalogStore.ts`.
- In the test, mock that module with `vi.mock` so `effectReadsInput('pixelate')` returns true and `effectReadsInput('aurora')` returns false.

Steps (TDD):
1. Write tests for: ids and labels in order; `paintGalleryInclude` for `{generative: true}`, `{category: 'material'}` and `{category: 'blur'}` → true, true, false; `effectGalleryInclude` with the mock; `brushEffectLabel` for `'blinds'` → "Reeded glass", and for an unknown id with a mocked `getEffectSync` returning `{ name: 'Swirl' }` → "Swirl".
2. Run and see them fail.
3. Implement.
4. Run and see them pass.
5. Commit `feat(brush): curated painted effects and shader gallery filters`.

---

### Task 2: Brush layers can hide their paint (paint drives effects only)

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`
- Test: `frontend/tests/unit/brush-show-paint.unit.spec.ts`

**Produces:**
- `BrushLayer.showPaint?: boolean`.
- `export function brushPaintVisible(layer: LocalLayer): boolean` — true unless `layer.kind === 'brush' && layer.showPaint === false`.

**Behaviour:**
- **Where `paintLayerStack` draws a local layer's own content (`drawOwn`, ~L6895-6975, both the motion and the static paths):** when `!brushPaintVisible(layer)`, skip the own-content draw. Backdrop effects still run.
- **In `withBackdrop` (~L5945-5986), where the silhouette ghost is built** (`{...layer, opacity: 1, effects: undefined, blend: undefined}`): add `showPaint: true` when the layer is a brush, so the silhouette carries the real paint alpha.
- **Other places that draw a brush layer's content should follow `brushPaintVisible`, so hidden paint never appears.** Grep for them: thumbnails, layer-list swatches, the silhouette cache, corner-pin or DOF sources, and export helpers that call `drawLocalLayer` directly. The layer-list swatch may keep showing a representative swatch. Check each call site, fix any that would reveal the paint, and list them in your report.
- Absent `showPaint` stays byte-identical everywhere.

Steps (TDD):
1. Tests: `brushPaintVisible` for a brush layer with `showPaint: false`, `true` or absent, and for a non-brush layer.
   - If a pure, testable seam exists, also test that a layer stack containing a `showPaint: false` brush layer with no effects paints nothing. Otherwise document the gap for the browser pass.
2. See them fail.
3. Implement.
4. Run the tests; also run every `ls frontend/tests/unit | grep -iE "brush|tip|compositor"` file.
5. Commit `feat(brush): a brush layer can hide its paint and only drive its effects`.

---

### Task 3: Brush state — Effect mode, chosen effect, library shader paint

**Files:**
- Modify: `frontend/app/composables/useBrushPaint.ts`
- Test: `frontend/tests/unit/brush-effect-state.unit.spec.ts`

**Produces:**
- `BrushMode = 'paint' | 'effect' | 'mask'`.
- `brush.effect: Ref<string>`, default `water_ripple`.
- `brush.shaderPaint: Ref<string | null>`.
- Setters and persistence:
  - Choosing a material, or Colour, clears `shaderPaint`.
  - Choosing a `shaderPaint` clears `material`.
  - `mode` (only `paint`/`effect`/`mask` is valid), `effect` and `shaderPaint` are persisted in `sailor.brushTips.v1`, alongside the existing keys.

**Pure target helpers:**
```ts
export function effectLayerMatches(layer: { showPaint?: boolean; effects?: any[] } | undefined, effectId: string): boolean
// true when layer.showPaint === false and its effect stack has a visible backdrop_shader whose effectId === effectId
export function shaderPaintMatches(fill: unknown, shaderId: string | null): boolean
// shaderId null → false; true when fill is a shader fill whose shader.effectId === shaderId
```

- `paintMatchesLayer` from Part 2 stays as it is, for materials and Colour.
- The Frame target rule for Paint mode becomes: when `shaderPaint` is set, use `shaderPaintMatches(layer.fill, shaderPaint)` and require no material; otherwise use `paintMatchesLayer`. Implement that as a pure helper:

```ts
export function paintTargetMatches(layer, toolbar: { material; shaderPaint }): boolean
```

- An effect layer (`showPaint === false`) never matches Paint mode.

Steps (TDD):
1. Tests: defaults; persistence round trip; bad values fall back; the mutual clearing; `effectLayerMatches`; `shaderPaintMatches`; `paintTargetMatches` (a Colour layer vs Colour toolbar, a shader layer vs the same or a different shader, an effect layer never matching Paint mode).
2. See them fail. 3. Implement. 4. See them pass, plus the existing brush-paint unit files.
5. Commit `feat(brush): brush state for painted effects and library shader paint`.

---

### Task 4: Toolbar — Paint · Effect · Mask, effect chips, More…

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/BrushToolbar.vue`
- Test: extend `frontend/tests/unit/brush-toolbar.unit.spec.ts`

**Behaviour:**
- **Mode control:**
  - Three buttons: `brush-mode-paint`, `brush-mode-effect` (new), `brush-mode-mask`.
  - Labels are exactly "Paint", "Effect", "Mask".
- **Paint mode, Paint row:**
  - As today, plus a **More…** button (`brush-paint-more`) that emits `more-paint`.
  - When `brush.shaderPaint` is set, a seventh swatch (`brush-shader-paint`) is pressed, with `title` and `aria-label` = `brushEffectLabel(id)` and a neutral swatch background (for example a conic gradient).
- **Effect mode:**
  - Tips row and Size/Eraser/Done as in Paint mode; no colour swatch.
  - An Effect row: seven chips (`brush-effect-<id>`, `aria-pressed`, `title` and `aria-label` = label, background = swatch) plus **More…** (`brush-effect-more`, emits `more-effect`).
  - When `brush.effect` isn't curated, an extra pressed chip shows its label.
  - The hint is the effect hint (exact copy).
- **Width:** keep the bar ≤ 380 px (rows wrap), and keep every existing testid.

Steps:
1. Extend the test:
   - switching to Effect shows the chips and hides the colour;
   - clicking `brush-effect-pixelate` sets `brush.effect`;
   - the More… buttons emit their events;
   - the hint copy.
2. See it fail. 3. Implement. 4. Pass, and `vue-tsc` is clean for the file.
5. Commit `feat(brush): Effect mode and More… in the brush toolbar`.

---

### Task 5: Frame wiring — galleries, new layers, target rule, effect panel

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (snapshot → patch recipe).

**Behaviour:**
1. **Galleries.**
   - Mount `ShaderEffectGallery` (already imported in the modal ~L150; reuse the existing instance pattern or add one) for:
     - `more-paint`: `include = paintGalleryInclude`. Confirm sets `brush.shaderPaint`.
     - `more-effect`: `include = effectGalleryInclude`. Confirm sets `brush.effect`.
     - The panel's **Change effect…** (same filter): confirm swaps the selected effect layer's `backdrop_shader.effectId`. That is one history step.
   - Titles are plain: "Paint with a shader" and "Paint an effect".
   - Make sure the catalogue is loaded before opening (follow how the existing effect picker does it).
2. **Pointer-down (the tip path) in Effect mode.** Effect mode uses tip strokes exactly like Paint mode. Mask stays legacy.
   - Target: the selected brush layer if `effectLayerMatches(layer, brush.effect)` or the eraser is on. Otherwise start a pending new layer with:
     - `showPaint: false`;
     - `effects: addEffect([], 'backdrop_shader')` with `effectId` set to `brush.effect` (speed 0);
     - fill = the toolbar colour (irrelevant but valid).
   - An eraser with no matching layer does nothing, as today.
   - New layers are appended on top, which is how brush layers are already added. Confirm that.
3. **Pointer-down in Paint mode.**
   - Replace `paintMatchesLayer(...)` with `paintTargetMatches(layer, { material, shaderPaint })` (eraser still exempt).
   - A new layer with `shaderPaint` gets `fill = { type: 'shader', shader: { ...DEFAULT_SHADER_SPEC, effectId: shaderPaint, anchor: 'frame' } }`, using whatever exact Fill shape FillControl produces for a shader fill (match it), and no material.
4. **Right panel** for a selected brush layer with `showPaint === false`:
   - The header "Painted effect · <brushEffectLabel(effectId)>".
   - **Change effect…** (`brush-layer-change-effect`).
   - The note (exact copy).
   - Hide Material, Fill and Fill with image. Keep the rest of the layer panel (opacity, blend and so on) as for any layer.
5. **Live preview.** While painting an effect layer, the live stroke must drive the effect. Confirm the pending layer carries `showPaint: false` and its `backdrop_shader`, in the same way as Part 2's material check on the pending layer. The silhouette ghost includes `_liveTip` strokes because the brush branch folds them in.
6. `vue-tsc` grep for the modal: no new errors. Run all brush/tip unit files plus compositor-prompt-wiring.
7. Commit through the CM recipe: `feat(brush): paint effects onto the Frame and paint with any library shader`.

---

### Task 6: Real-browser verification (controller)

The controller adds `frontend/tests/compositor-brush-effects.spec.ts` and runs it on the existing `:3002` server:
- Seed a text layer. In Effect mode with Pixels, paint across half of it. That half's pixels change and the other half's don't.
- The effect layer's own paint colour is not visible: sample a painted spot where the backdrop is flat.
- A second pass over the same area increases the change.
- The eraser reduces it.
- Paint mode → More… → pick a generative shader (e.g. `aurora`) → paint → the layer has a shader fill with that id.
- Reload redraws identical pixels.
- Screenshot the toolbar at 1024 wide.

Then update STATE.md, the dashboard and memory.
