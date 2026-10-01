# Frame light layers, stage 2 (photos) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A photo with **Relight** takes the Frame's lights by its real shape (cheeks, ears and folds catch the light), while the Relight effect keeps only how the photo takes light. Its own lights go away and become Frame Light layers. Adding Relight to a Frame with no light adds a Lamp. Setups replace the Frame's lights. Frames made with the old Relight convert without changing the layout. Finish sends the photo as lit by the Frame's lights.

**Architecture:**
- The stage 1 lighting step gains a third Frame-sized map, **facing** (RGBA: xyz normal + a contact-shadow term), and a **shine** channel.
- A Relight photo fills the facing map with its depth- and surface-derived normals through its crop. This uses a small per-photo GPU pass that ports the normal and relief maths from today's `RELIGHT_FRAG`.
- The photo's own paint applies only **Original light** (flattening its baked-in light toward its albedo).
- The old per-layer lighting in `relightLitFrom` / `gpuContent` is retired.
- Old Relight lights become Light layers through one pure conversion function. The painter uses it read-only, so cards and exports look right before a Frame is opened. The editor uses it once to persist the conversion.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, WebGL2, Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-01-frame-light-layers-design.md`, sections 2 and 3 and stage 2 of section 4. Stage 1 is landed (`docs/STATE.md` → "Frame light layers, stage 1"). The Relight stage 1–3 code is in `frontend/app/lib/relight/` and `frontend/app/components/vue-canvas/compositor/RelightControls.vue`.

## Global Constraints

- **No light and no Relight ⇒ byte-identical** to today: no facing map, no normal pass, no extra work.
- A Frame with lights but no Relight photo paints exactly as stage 1 does now: the facing map is flat and is not created.
- **Relight effect after stage 2:** `{ type, visible, keep, depth, texture, shine, shadows }`.
  - The sanitizer drops `lights`. Old saved effects still parse, and their lights are read only by the conversion.
  - Dials keep their meaning:
    - **Original light** (`keep`): how much of the photo's baked light stays. The photo is flattened toward its albedo by `1 − keep`, in its own paint, before the lighting step.
    - **Depth** (`depth`): normal strength.
    - **Texture** (`texture`): relief from photo luminance.
    - **Shine** (`shine`): highlight strength in the Frame pass.
    - **Shadows** (`shadows`): the contact/self-shadow term from the depth field, stored in the facing map's alpha.
  - Port the normal and relief and contact-shadow maths from `RELIGHT_FRAG` (`lib/relight/relightPass.ts`): `normalAt`, the relief slope, `shadowTo`, surfaces decode with `m.y = −m.y` and `m.xy*(relief/4)`. Do not re-derive them.
- **Lighting pass additions:**
  - Facing map sampled at the pixel (absent or flat ⇒ `n = (0,0,1)`, contact = 1).
  - `ndl` uses that normal.
  - Shine is Blinn `pow(max(dot(n,H),0), 48)·shine·2` per light, from the prototype. Shine lives in a map channel, set by the Relight `shine` dial for photos; other layers get 0 in stage 2.
  - The contact term multiplies the light.
  - Everything else stays verbatim from stage 1.
- **Conversion of old Relight lights** (`lib/frame/lighting/convertRelight.ts`, pure):
  - Each old light becomes a `light` layer of type lamp. Position is mapped from the photo's box fractions to Frame fractions through the photo layer's centre, size and rotation.
  - `height` is clamped to 0..1: a "behind" rim light becomes height 0. Colour, brightness and reach carry over as they are.
  - At most 6 lights in total, in stack order; extras are dropped, and the result reports the count.
  - Every non-photo layer in the Frame gets `lit:false` and `castsShadow:false`, so the layout looks as before. Relight photos keep their lit default.
  - Darkness is set so the photo's look is close to before: darkness = 0.45 unless the Frame already has a lighting record.
  - Light layers sit at the top of the stack.
- **The conversion runs in two places:**
  1. **The painter (read-only, never persisted).** When a Frame has Relight effects with old lights and **no** light layers, every painter lights it through the converted view. Cards, Render, video and web export of an unopened old Frame then look converted.
  2. **The editor on open.** It persists the conversion once as one history step, and a one-time toast says "Relight's lights are now Frame lights" (plus "N left out" when some were dropped).
- **Adding Relight to a Frame with no light** also adds a Lamp at Golden key's position, mapped to the Frame, in the same undo step.
- **Relight Setups** (Window, Golden key, Rim, Neon, Under) **replace all the Frame's light layers** with that arrangement, mapped from the photo's box to the Frame, as one undo step. The Setup's `keep` sets the photo's Original light.
- **The Relight panel** keeps:
  - Setups, Original light, Depth, Texture, Shine and Shadows;
  - Read shape (with its price), Finish (with its price) and Compare;
  - light chips that **select the Frame's light layers**.

  It loses the per-light colour, Brightness, Height, Reach and on controls; those live in the light inspector. The old relight canvas handles (`relight-light-handle`) are removed; the stage 1 light dots replace them.
- **Finish:**
  - The guide is the photo's box lit by the Frame's lights only. It uses no shadows from other layers (ruling: photo only), and the same lighting maths with the photo's facing tile.
  - The lights are mapped from Frame to box fractions.
  - Original light is applied.
  - The pair stays pixel-aligned, at the source's resolution, ≤1536, untinted, as today.
  - Nothing else about Finish changes: route, price, bar, undo, guards.
- **Web export:** Relight Frames already route to the full bundle. The facing pass runs there with the depth field built synchronously by the embed stand-in. MoGe surfaces are used when their PNG is in the export's assets; otherwise depth-only normals are used, and the sheet notes it.
- Copy: sentence case, explanations only in tooltips. Main checkout and private-index commits; `CompositorModal.vue`, `useCompositorLayers.ts` and `VueNodeCanvas.vue` may carry other sessions' edits (HEAD blob + own hunks, then `git reset -q -- <paths>`). No dev-server restarts. The type-check baseline is re-measured at Task 1.

---

### Task 1: The Relight model change, the conversion, adding Relight, Setups

**Files:**
- Create `frontend/app/lib/frame/lighting/convertRelight.ts`:
  - `relightLightsToLayers(layers, lighting?) → { layers, lighting, dropped }`: pure. It maps through the photo's transform and is idempotent: a Frame that already has light layers is returned unchanged.
  - `hasLegacyRelightLights(layers)`.
  - `setupToLightLayers(setup, photoLayer, W, H) → LightLayer[]`.
- Modify `frontend/app/lib/relight/settings.ts`:
  - `sanitizeRelight` drops `lights` from the returned effect;
  - keep `readLegacyRelightLights(raw)` for the conversion;
  - `RelightEffect` loses `lights`.
- Modify `frontend/app/lib/relight/presets.ts`: Setups describe light specs in box fractions plus `keep`, and are consumed by `setupToLightLayers`.
- Modify `useLocalLayerEditor.ts`:
  - `convertLegacyRelight()`: one history step, returns `dropped`;
  - `addRelight(layerId)`: adds the effect, plus a Golden key lamp when the Frame has no light, in one step;
  - `applyRelightSetup(layerId, name)`: replaces the light layers and sets keep, in one step.
- Every place that read `fx.lights` compiles and behaves:
  - the painter's virtual conversion lands in Task 2, so it is wired there;
  - `relightSurfaceRefs`, the agent and the web-export plan (grep `\.lights` under `lib/relight`, `useCompositorLayers.ts`, `lib/embed`, `lib/agent`).
- Tests: `frontend/tests/unit/frame-lighting-convert.unit.spec.ts`:
  - box→Frame mapping, including a rotated photo;
  - the cap and the dropped count;
  - idempotence;
  - non-photo layers get `lit:false` / `castsShadow:false`;
  - "behind" height becomes 0;
  - the Setups mapping.

  Also extend the relight settings and presets specs and the editor specs (one undo step each).
- Commit message: `feat(frame): Relight's lights become Frame lights — conversion, adding Relight brings a lamp, Setups set the Frame's lights (light layers stage 2)`.

### Task 2: The facing map and the lighting pass take the photo's shape

**Files:**
- Create `frontend/app/lib/frame/lighting/facingPass.ts`, a WebGL2 per-photo pass:
  - **Inputs:** colour, depth field (R16F, as `GpuPost` uploads it), optional MoGe normals, the depth rect, and the `depth` / `texture` / `shadows` dials.
  - **Output:** an RGBA tile (normal xyz encoded 0..1, alpha = contact term) at the photo's box size.
  - **Maths:** ported verbatim from `RELIGHT_FRAG`.
  - Reuse `GpuPost` (it already has colour, depth and normals slots) with a new fragment if that fits cleanly; otherwise write a sibling class in the `LightingGl` style.
- Modify `maps.ts`:
  - a **facing** map, flat `(128,128,255,255)`, created only when a Relight photo is visible;
  - each Relight photo stamps its tile through its own transform and silhouette;
  - a **shine** value per pixel: use the lit map's G channel, or a fourth small map — implementer's choice, stated in the report;
  - cached like the other maps, keyed additionally by the photo's dials and its depth and surfaces readiness.
- Modify `lightingPass.ts`, `shade.ts` and their constants test: sample facing and shine, then compute `ndl`, contact and shine as in the Global Constraints. Flat facing gives stage 1's exact result; add a test that proves it.
- Modify `useCompositorLayers.ts`:
  - `gpuContent` / `relightLitFrom` no longer light. A Relight photo's own paint applies only Original light: flatten toward albedo by `1 − keep`, using the luminance-flatten part of today's shader.
  - The facing tile is produced and recorded for the maps.
  - DOF still chains after.
  - The painter applies `relightLightsToLayers` read-only when `hasLegacyRelightLights` and the Frame has no light layers.
  - Remove the dead per-layer relight lighting code path, and keep `__relightRuns` meaningful (count facing passes).
- Tests: extend `frame-lighting-*` specs:
  - a Relight photo with no light layer and no legacy lights draws as plain plus Original light;
  - legacy lights light it through the virtual conversion;
  - flat facing equals stage 1;
  - the facing changes `lightAt` as expected (a normal facing the light is brighter);
  - the contact term darkens.

  Real-GPU check on a scratch page (as in stage 1): the puppy with a lamp on the left gets a brighter left cheek than right, and its facing tile is not flat.
- Commit message: `feat(frame): photos with Relight take the Frame's lights by their shape — a facing map from depth and surfaces, shine and contact shadows (light layers stage 2)`.

### Task 3: The Relight panel and the editor

**Files:**
- `frontend/app/components/vue-canvas/compositor/RelightControls.vue`:
  - remove the per-light controls;
  - Setups call `applyRelightSetup`;
  - light chips list the Frame's light layers and select them (emit `select-light`);
  - keep Original light, Depth, Texture, Shine, Shadows, Read shape, Finish and Compare;
  - update its unit spec.
- `CompositorModal.vue` (special commit recipe):
  - remove the relight handles (`relight-light-handle`) and their drag code;
  - "Relight…" in the right-click menu and the + menu go through `addRelight`;
  - on open, `convertLegacyRelight()` runs once when needed, with the toast;
  - Compare bypasses lighting for that photo, as Compare did before;
  - selecting a light chip selects the light layer.
- Tests: RelightControls spec; editor conversion on open (one history step, toast text) where testable.
- Commit message: `feat(frame): the Relight panel keeps how the photo takes light; its lights are the Frame's (light layers stage 2)`.

### Task 4: Finish uses the Frame's lights

**Files:**
- `useCompositorLayers.ts` `renderRelightPair`: the guide is the photo's box lit by the Frame's visible lights, mapped Frame→box, through the same lighting maths and the photo's facing tile, with Original light applied, no other layers and no shadows from others. The original stays as today.
- Tests: the mapping Frame→box→Frame is the identity; the pair stays aligned.
- The Finish browser tests in `tests/relight-effect.spec.ts` must still pass after Task 5's updates.
- Commit message: `feat(relight): Finish's guide is the photo lit by the Frame's lights (light layers stage 2)`.

### Task 5: Browser checks

**Files:** `frontend/tests/frame-light-layers.spec.ts` (extend), `frontend/tests/relight-effect.spec.ts` (update for the new panel).

- [ ] On the running :3002, with the grid off before screenshots. The paid surfaces route stays mocked as today.
  1. Add Relight to the puppy in a Frame with no light: a lamp appears, and the photo's left/right gain follows the lamp.
  2. Move the lamp: the brighter side follows, including a check that uses surfaces (the cached MoGe normals) — the floor faces up.
  3. Setups replace the Frame's lights (count and positions), one undo.
  4. An old-format Relight Frame (seed a layer whose relight effect has `lights`) opens converted, with lights at the top and the toast. The other layers are unchanged (pixels equal to before in a region away from the photo's light). One ⌘Z restores the old data.
  5. A card or Render of an unopened old Frame looks converted.
  6. Finish with a mocked route: the request's guide differs from the original, and the guide's brighter half follows the Frame lamp.
  7. A web export of a Relight Frame equals the editor in a region away from fine detail.
  8. Stage 1's checks all still pass; a Frame with no light and no Relight is byte-identical.
- [ ] Commit message: `test(frame): photos lit by Frame lights — conversion, setups, Finish, export (light layers stage 2)`.

### Task 6: Record the state
`docs/STATE.md`, the dashboard, memory.

## Rulings made while writing this plan
- **The conversion is one pure function used read-only by the painter and once by the editor.** Unopened old Frames never look different in cards or exports, and the persistent write happens with an undo step the user can see.
- **"Behind" rim lights become height 0.** Frame lights have no "behind" yet, so a converted Rim setup loses a little of its rim glow.
- **Finish's guide is the photo alone under the Frame's lights.** Shadows cast by other layers aren't included: the model relights one photo, and other layers sit on top anyway.
- **Shine for non-photo layers stays 0 in stage 2.** A material shine for text and shapes belongs with Foil and Spot UV in stage 3.
