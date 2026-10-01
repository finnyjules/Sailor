# Frame light layers, stage 3 (print finishes) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gold foil and Spot UV are lit by the Frame's light layers — every light, with its colour, brightness, reach and cone — instead of the one hidden Frame light. A Frame with no light layer keeps today's hidden light, presets and handle, pixel for pixel.

**Architecture:**
- `finishPass.ts` keeps today's two shaders untouched (the no-light path). A new module `lib/compositor/finishLights.ts` holds **lit variants** (`FOIL_LIT_FRAG`, `SPOT_UV_LIT_FRAG`) that read the same light-uniform layout as the lighting pass (`uA/uB/uC[6]`, `uCount`, `uDark`) instead of `uLight`, and `applyFinishLit(off, kind, dials, lights, lighting, scale, frame?)`.
- `paintLayerStack` already knows when the Frame has a visible light. While it does (and WebGL2 is on) it sets a module global `_finishLights = { lights, lighting }`; `paintFoilRegion` and the `spot_uv` effect call `applyFinishLit` instead of `applyFinish`.
- **No double lighting.** Finish output is already lit, so the general lighting pass must leave it alone:
  - a Spot UV layer stamps **unlit** in the lit map (the shader does the layer's whole lighting: diffuse + shine);
  - a foil region stamps **unlit** where the foil landed: `paintFoilRegion` records the region's alpha into a per-layer **self-lit mask**, and the layer's stamp punches that mask out of the lit map (black) after stamping the silhouette. A text whose fill is plain and whose outline is foil stays lit by the pass everywhere except the outline.
  - Shadows (lift) are unaffected.
- The hidden light retires quietly in the UI while a light layer exists: the Light row reads "Lit by the Frame's lights" and selects the first light on click; the amber handle hides. Its stored value stays untouched (removing every light brings it back).
- Web export: `finishLights.ts` is stubbed in `frame-lean`; a Frame with a light layer **and** foil or Spot UV routes to `frame.js`.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, WebGL2 (`GpuPost`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-frame-light-layers-design.md` — section 2 "Foil and Spot UV", section 3 "Foil and Spot UV finish shaders read the light list", stage 3 of section 4. Stages 1–2 are landed (`docs/STATE.md`).

## Global Constraints

- **No light layer ⇒ byte-identical**: `FOIL_FRAG`, `SPOT_UV_FRAG`, `applyFinish`, `_frameLight`, `FinishLightControl`, the amber handle all behave exactly as today. `finishPass.ts`'s existing shader strings are not edited.
- With a light layer: finishes read **all visible lights** (`visibleLights` order, max `MAX_LIGHTS` = 6) with colour, brightness, falloff (lamp/spot), cone (spot) and direction (sun) — the same per-light maths as `LIGHTING_FRAG` (`lightingPass.ts:42-123`): pack with `packLightUniforms` (`shade.ts`), positions via the same Frame→world convention the lighting pass uses. Ambient for the finish = `1 − darkness·0.92` (the lighting pass's), so Darkness darkens foil and Spot UV too.
- Look targets (tune by eye against the no-light look with one light at the old default position, top-left height 0.6, white, brightness 1): a single white lamp at the hidden light's default position should look **close to** today's foil and Spot UV (same highlight placement and size). Coloured lights tint the highlight and diffuse. A finish far from every lamp in a dark Frame is dark.
- A finish is lit **once**: by its own shader. The lighting pass never re-lights its pixels (Spot UV layer unlit; foil regions punched out of the lit map).
- `_finishLights` is set and cleared inside `paintLayerStack` (`try/finally`, like `_frameLight`); draws outside it (hit-test `withFlatFoil`, `withFrameLight` sites) see `null` and use the hidden light.
- `frame-lean.js` ceiling 430,000 B is **never raised**; `frame.js` ceiling 1,470,000 B.
- Copy: sentence case; explanations only as tooltips. "Lit by the Frame's lights" is the Light row's value text.
- Main checkout, private-index commits (`GIT_INDEX_FILE` in the scratchpad, `git read-tree HEAD`, add own paths, `commit-tree`, `update-ref`, then `git reset -q -- <paths>` separately). `CompositorModal.vue`, `useCompositorLayers.ts` may carry other sessions' edits: commit HEAD's blob plus own hunks only. Never `git stash`, never `git checkout --`/`restore` on shared files, never `npm run dev`, never restart :3002.

---

### Task 1: Lit finish shaders

**Files:**
- Create `frontend/app/lib/compositor/finishLights.ts`:
  - `FOIL_LIT_FRAG`, `SPOT_UV_LIT_FRAG`: built from `finishPass.ts`'s `COMMON` with `uniform vec3 uLight;` replaced by the light arrays (export `COMMON` from finishPass.ts as `FINISH_COMMON` — exporting is the only allowed edit to finishPass.ts besides the `shared()` helper export below). Per pixel: `P = worldPos(frameUv(vUv))`, for each light `i < uCount`: direction `L_i` (lamp/spot: toward the light's world position; sun: the light's fixed direction), radiance `E_i = colour·brightness·att·cone` (att and cone exactly as `LIGHTING_FRAG`).
    - Foil: `t = 0.10·amb + Σ w_i·(0.25·df_i² + 0.55·smoothstep(0.80,0.99,rl_i) + 0.9·pow(max(rl_i,0),140)) + 0.14·(R.y·0.5+0.5)·amb + brushed/grain terms as today`, where `w_i = luminance(E_i)`; colour = `ramp(t)` multiplied by the radiance-weighted light colour tint `mix(vec3(1), normalize-ish(ΣE_i)/max lum, 0.6)`; alpha/erosion as today.
    - Spot UV: `lit = amb + Σ max(dot(N,L_i),0)·E_i` (vec3); `shine = Σ lum(E_i)·(box_i·mix(0.3,0.85,gloss) + sharp_i·1.3)·colour_i + fres·0.2·amb`. Non-varnish: `wet = pow(src.rgb,1.15)·1.04·lit + shine`. Varnish-only: as today with `lift = clamp(lum(shine))` and the dark term from `1 − lum(lit)`.
  - `applyFinishLit(off, kind: 'gold_foil'|'spot_uv', dials, lights: LightLayer[], lighting: FrameLighting, scale, frame?) : boolean` — same contract as `applyFinish` (in place, false ⇒ caller falls back), its own lazily built `GpuPost` passes.
- Modify `frontend/app/lib/compositor/finishPass.ts`: export `COMMON` as `FINISH_COMMON` and export `shared()` (rename `finishSharedUniforms`) so the lit module reuses them. No shader text changes.
- Tests `frontend/tests/unit/finish-lights.unit.spec.ts`:
  - both lit shaders declare `uA/uB/uC/uCount/uDark` and not `uLight`; `smoothstep` edges ascending (mirror finish-pass.unit's checks);
  - the uniform packer: 0..6 lights, a 7th dropped; colour linearised as in the lighting pass;
  - `FOIL_FRAG`/`SPOT_UV_FRAG` strings are unchanged (snapshot hash of today's text taken before editing).
- [ ] Write tests, see them fail, implement, see them pass, run `finish-pass`, `finish-effects` unit suites.
- Commit: `feat(frame): foil and Spot UV shaders lit by the Frame's lights (light layers stage 3)`.

### Task 2: The painter uses them, lit once

**Files:**
- Modify `frontend/app/composables/useCompositorLayers.ts`:
  - module global `_finishLights: { lights: LightLayer[]; lighting: FrameLighting } | null = null`; in `paintLayerStack`, when `lightingOn`, set it from `visibleLights(localLayers, groups)` **after** the motion fold (so moved lights light the foil) and `lighting ?? DEFAULT_LIGHTING`; restore in the existing `finally`.
  - `paintFoilRegion`: when `_finishLights` and not `_foilFlat`, call `applyFinishLit(...)`; on false fall back to `applyFinish` with `_frameLight`. When a self-lit recorder is active (`_selfLitRecorder`, a device-sized canvas set per layer by the loop while `lightingOn`), draw the region result's alpha into it at `(r.x, r.y)`.
  - `spot_uv` case: when `_finishLights`, `applyFinishLit` (fallback `applyFinish`).
  - `pushStamp`: a layer whose effect stack has a visible `spot_uv` stamps as `lit:false`. A layer whose draw recorded self-lit alpha passes `selfLit: (target) => target.drawImage(rec, 0, 0, W, H)` on its stamp and adds `|sl` to the stamp sig.
- Modify `frontend/app/lib/frame/lighting/maps.ts`: `LightingStamp.selfLit?: ((target) => void) | null`; when stamping the lit map, after a stamp's silhouette, draw `selfLit` with `destination-out` then `source-over` black at the same alpha (net: those pixels read unlit). Lift map untouched.
- Tests (unit, fake canvas / existing frame-lighting-paint harness):
  - a Frame with a light and a foil-filled text: `applyFinishLit` is called, `applyFinish` is not; with no light the reverse, and output bytes equal today's (existing frame-light-paint tests keep passing);
  - the lit map reads 0 inside a foil region and 255 in the same layer's plain fill (text with plain fill + foil outline);
  - a Spot UV layer stamps unlit;
  - `_finishLights` is null after `paintLayerStack` returns and during `withFlatFoil` hit-tests.
- Commit: `feat(frame): the painter lights foil and Spot UV with the Frame's lights, once (light layers stage 3)`.

### Task 3: The editor — the hidden light retires quietly

**Files:**
- `frontend/app/components/vue-canvas/compositor/FinishLightControl.vue`: new prop `framelit?: boolean`; when true render the row label "Light" and a button whose text is "Lit by the Frame's lights" (`data-testid="finish-light-framelit"`), emitting `select-light`. Presets hidden. Tooltip on the label: "Every light on this Frame lights the finish."
- `FillControl.vue` and `CompositorModal.vue` (Spot UV block ~:11813, every FinishLightControl host ~:12204/:12642–:12829): pass `:framelit="frameLightLayers.length > 0"` and on `select-light` select the first light layer (the same select the layer row does).
- `CompositorModal.vue`: `finishEffectSelected` handle (`data-testid="frame-light-handle"`) hidden while the Frame has a light layer.
- Tests: extend `finish-light-control.unit.spec.ts` (framelit renders the text, emits select-light, hides presets); `fill-control-foil.unit.spec.ts` passes framelit through.
- Commit: `feat(frame): foil and Spot UV panels say they're lit by the Frame's lights (light layers stage 3)`.

### Task 4: Web export

**Files:**
- `frontend/vite.embed.config.ts`: add `[/\/app\/lib\/compositor\/finishLights\.ts$/, './app/lib/embed/frame/finishLightsLean.embed.ts']` to `FRAME_LEAN_STUBS`.
- Create `frontend/app/lib/embed/frame/finishLightsLean.embed.ts`: exports the same names; `applyFinishLit` calls `leanFeatureUsed('Print finishes under lights')` and returns false (caller falls back to the hidden light).
- `frontend/app/lib/embed/frame/needs.ts`: `frameNeedsFullBundle` returns `'Print finishes under lights'` when a visible light layer exists and any layer carries a foil paint (`layerHasFoil` logic — reuse, or a pure check over fill/stroke/outline paints) or a `spot_uv` effect.
- Tests: `frame-embed-gather.unit.spec.ts` routing case; build the embeds (`npm run build:embed` or the repo's embed build script — check package.json) and `embed-build-output.unit.spec.ts` passes; record both sizes in the report.
- Commit: `feat(embed): Frames with lights and print finishes take the full bundle (light layers stage 3)`.

### Task 5: Browser checks

**Files:** `frontend/tests/print-finishes.spec.ts` (extend; set its shots dir to this session's scratchpad via env, don't edit another session's path if it's env-driven), `frontend/tests/frame-light-layers.spec.ts`.
- [ ] On the running :3002, grid hidden (⇧G) before screenshots:
  1. A Frame with foil text and no light: pixels equal a capture taken at HEAD before this stage (store the capture in the test run, compare with tolerance 0).
  2. Add a lamp: the foil highlight follows the lamp (brightest foil column moves with the lamp left→right).
  3. A red lamp tints the foil highlight red (R > G,B in the highlight).
  4. Darkness 100%, lamp far away: foil mean luminance drops below the no-light capture.
  5. Spot UV ellipse under a lamp: shine follows the lamp; the layer is not double-lit (its mean equals the shader-only expectation within tolerance — compare against the same Frame with the lamp's layer moved but lit map forced: simplest proxy, a Spot UV layer's pixels stay the same when the light-pass is toggled off via `lit:false` on that layer).
  6. The Light row reads "Lit by the Frame's lights"; clicking it selects the lamp; the amber handle is gone; deleting the lamp brings presets and handle back.
  7. Web export of the lamp + foil Frame matches the editor in a region away from fine detail.
- Commit: `test(frame): foil and Spot UV under Frame lights (light layers stage 3)`.

### Task 6: Record the state
`docs/STATE.md`, the dashboard, memory.

## Rulings made while writing this plan
- **Separate lit shaders, not edited ones.** Keeps the no-light path byte-identical by construction and lets the lean bundle drop them.
- **Lit once, by the finish.** Foil and varnish are surface reflections the general pass can't model; the pass skips their pixels (Spot UV: whole layer; foil: the foil region only). Cost if wrong: a finish could look slightly flatter than its neighbours under strong Darkness — tune in the shader's ambient term, not by re-enabling the pass.
- **A Relight photo with Spot UV** is lit by the Spot UV shader only (its shape-lighting is skipped). Rare; parked.
- **The hidden light value is kept**, so deleting every light returns the Frame to exactly how it looked.
