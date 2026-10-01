# Frame light layers, stage 4 (Motion and the assistant) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every light dial (position, height, colour, brightness, reach, aim, cone), the Frame's Darkness and every layer's Lift animate in the Motion tab like any other property; the Frame assistant can add, change and animate lights ("add a warm lamp top left", "make it night").

**Architecture:**
- **Light and Lift bands** are ordinary motionx property bands: `layers.<lightId>.light.<key>` and `layers.<id>.lift`. `animatableProperties` declares them (new group `Light`), `applyResolvedValue` applies them through one helper `applyLightValue(layer, prop, value)` in a new module `lib/frame/lighting/motion.ts`.
- **Darkness** is Frame-level: path `frame.darkness`. `applyLightingTracks(lighting, tracks, t)` (same module) evaluates it; `paintLayerStack` folds it into `lighting` just before the lighting pass (and before `_finishLights` from stage 3, if landed). The Motion tab shows an **All lights** row (only while the Frame has a light) whose property picker offers Darkness.
- Maps cache already keys on stamped layers only: animating lights or Darkness re-runs just the GL pass; animating Lift re-stamps (accepted, same as animated position today).
- **Assistant:** lights become visible in `describeCompositor` and writable through five ops: `addLight`, `setLight`, `setLighting`, `setLayerLight`, `animateLight`. The host's `setState`, `mergeDocFields`, `restore` snapshot and `isAgentBand` learn lighting and light bands, so nothing the assistant does is silently dropped. Routing intents learn light phrases.
- **Web export:** `lib/frame/lighting/motion.ts` is stubbed in `frame-lean` (identity); a Frame whose motion has any `light.`/`lift`/`frame.darkness` band routes to `frame.js`. The embed's background bleed reads the evaluated Darkness per paint.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, motionx, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-frame-light-layers-design.md` — section 3 "Motion", stage 4 of section 4. Stages 1–3 landed first.

## Global Constraints

- **No light band, no lift band, no darkness band ⇒ byte-identical**: `applyMotionxTracks` keeps returning the SAME array ref when idle; `applyLightingTracks` returns the SAME `lighting` object when no `frame.darkness` band resolves.
- Ranges (from `settings.ts` sanitizers — read them, don't invent): height 0..1, brightness 0..3, reach 0.2..2, aimX/aimY −0.5..1.5, cone 0.1..0.8, x/y −0.5..1.5 for lights, lift 0.005..0.15, darkness 0..1. Applied values are clamped through the same sanitizers. Colour bands interpolate in oklab (motionx default) and must land as `#rrggbb` (`HEX` in settings.ts).
- Light kind, lit and casts are not animatable (enums/booleans). Edge is not animated (spec list).
- Labels (sentence case): Position X, Position Y, Height, Colour, Brightness, Reach, Aim X, Aim Y, Cone, Lift, Darkness. Group names: `Light` (light dials and Lift), row title `All lights` (Darkness).
- `frame-lean.js` ceiling 430,000 B never raised; `COMPOSITOR_HINT_CEILING` (27,700) not raised — stay under it.
- Assistant ops validate and clamp everything, respect `MAX_LIGHTS` (refuse a 7th with a plain reason), and are one undo step per proposal as today. The assistant never makes paid calls for lights.
- Copy rules, private-index commits, shared-file hunks, no `git stash`, no `npm run dev`, no :3002 restart — as stage 3.

---

### Task 1: Light, Lift and Darkness bands evaluate and paint

**Files:**
- Create `frontend/app/lib/frame/lighting/motion.ts`:
  - `LIGHT_MOTION_KEYS = ['height','color','brightness','reach','aimX','aimY','cone'] as const`.
  - `applyLightValue(layer, prop, value): LocalLayer` — `light.<key>` on a light layer (number keys clamped as the sanitizer does; `color` accepted only as HEX, else unchanged), `lift` on a non-light layer (number, clamped 0.005..0.15). Anything else ⇒ same ref.
  - `applyLightingTracks(lighting: FrameLighting | undefined, tracks: Track[] | undefined, t: number | undefined): FrameLighting | undefined` — evaluates only `frame.darkness` (unmuted), clamps 0..1, returns a new object or the same ref.
  - `isLightBandPath(path)` — `/^layers\.[^.]+\.(light\.[a-zA-Z]+|lift)$|^frame\.darkness$/`.
- Modify `frontend/app/lib/motionx/adapter/frame.ts`:
  - `applyResolvedValue`: before the final `return layer`, `return applyLightValue(layer, prop, value)`.
  - `animatableProperties`: light layers return x/y (as now) plus Height, Colour, Brightness, Reach, and for spots Aim X, Aim Y, Cone — group `Light`. Non-light layers gain `Lift` (group `Light`, min 0.005, max 0.15) when `effectiveCasts(layer)`.
  - `PropertyGroup` union gains `'Light'`.
- Modify `frontend/app/composables/useCompositorLayers.ts` `paintLayerStack`: `const litNow = applyLightingTracks(lighting ?? undefined, motion?.motionx, t)` and use it for the lighting pass, `_finishLights` and `legacyRelightView` call sites in place of `lighting`.
- Tests `frontend/tests/unit/frame-lighting-motion.unit.spec.ts` and extend `motionx/adapter-frame.unit.spec.ts`:
  - each key applies and clamps; colour HEX only; lift ignored on a light, light keys ignored on a text;
  - idle ⇒ same refs;
  - `animatableProperties` for lamp vs spot vs text (casting and not);
  - `applyLightingTracks` mid-band value, muted band ignored, no band ⇒ same ref;
  - a `frame-lighting-paint` case: a darkness band 0→1 makes t=1 darker than t=0 at a pixel far from the lamp; a brightness band brightens at the lamp.
- Commit: `feat(motion): light dials, Lift and Darkness animate (light layers stage 4)`.

### Task 2: The Motion tab

**Files:**
- `frontend/app/components/vue-canvas/compositor/MotionPropertyPicker.vue`: `ORDER` gains `'Light'`.
- `frontend/app/components/vue-canvas/compositor/MotionInspector.vue`: `PROPERTY_RANGE` learns the light keys, `lift`, `darkness`, and light x/y (−0.5..1.5) — key the range by layer kind where x/y differ (pass the property's own min/max from `animatableProperties` if the component already receives it; prefer that over a second table).
- `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue` and `frontend/app/lib/motionx/bands.ts`: an **All lights** row at the top while the Frame has a light layer; its bands are tracks whose path is `frame.darkness`; its add-property offers Darkness (`{ path: 'frame.darkness', type: 'number', label: 'Darkness', group: 'Light', min: 0, max: 1 }`). Selecting/editing/deleting its band works like a layer band.
- `frontend/app/components/vue-canvas/CompositorModal.vue` `currentPropertyValue` (~:5176): `light.<key>` → `layer.light[key]` (with `LIGHT_DEFAULTS` fallback), `lift` → `effectiveLift(layer)`, `frame.darkness` → `frameLighting.darkness ?? DEFAULT_LIGHTING.darkness`.
- `frontend/app/lib/motion/bake.ts` `motionSourceKey`: include the lighting record so a Darkness edit marks a bake stale.
- Tests: `motionx/bands.unit.spec.ts` (frame row bands), `timeline-view`/picker unit for the Light group, `motion-bake-key.unit.spec.ts` (lighting in key).
- Commit: `feat(motion): lights, Lift and Darkness in the Motion tab (light layers stage 4)`.

### Task 3: Web export

**Files:**
- `frontend/vite.embed.config.ts` `FRAME_LEAN_STUBS`: `[/\/app\/lib\/frame\/lighting\/motion\.ts$/, './app/lib/embed/frame/lightMotionLean.embed.ts']`.
- Create `frontend/app/lib/embed/frame/lightMotionLean.embed.ts`: same exports; `applyLightValue` returns the layer unchanged (calling `leanFeatureUsed('Animated lights')` only when `isLightBandPath`-style prop is seen), `applyLightingTracks` returns `lighting` (calls `leanFeatureUsed` if a `frame.darkness` track exists), `isLightBandPath` real (tiny).
- `frontend/app/lib/embed/frame/needs.ts`: `frameNeedsFullBundle` gains the motion argument it needs (check its callers in `gather.ts:328` and `surfaces/frame.ts:37/:220`) and returns `'Animated lights'` when any motionx track path matches `isLightBandPath`.
- `frontend/app/lib/embed/surfaces/frame.ts` (~:300): the bleed darkness is computed per paint from `applyLightingTracks(v.lighting, v.motion?.motionx, tSec)`.
- Tests: gather routing case; build embeds; `embed-build-output.unit.spec.ts`; record sizes.
- Commit: `feat(embed): animated lights take the full bundle, the bleed follows animated Darkness (light layers stage 4)`.

### Task 4: The assistant learns lights

**Files:**
- `frontend/app/lib/agent/surfaces/compositor.ts`:
  - `describeCompositor`: stop hiding lights; a light layer describes as `{ id, kind:'light', name, x, y, type, height, color, brightness, reach, aimX?, aimY?, cone? }`; the document always carries `lighting: { darkness, backgroundLit }` (defaults when unset) and each non-light layer carries `lit`/`castsShadow`/`lift` only when they differ from defaults (keep the description short).
  - New ops in `COMPOSITOR_COMMANDS` (terse hints, stay under the ceiling):
    - `addLight {type:'lamp'|'spot'|'sun', x, y, color?, brightness?, height?, reach?}` → `newLightLayer` + sanitize, placed at the top of the stack; refuses past `MAX_LIGHTS`.
    - `setLight {id, ...same keys, aimX?, aimY?, cone?}` → `sanitizeLightLayer`.
    - `setLighting {darkness?, backgroundLit?}` → `state.lighting`.
    - `setLayerLight {id, lit?, castsShadow?, lift?}`.
    - `animateLight {id | 'frame', key, from, to, start?, end?, ease?}` → a motionx band on `layers.<id>.light.<key>`, `layers.<id>.lift`, `layers.<id>.x|y` (light) or `frame.darkness`; model on `animateDial` (validate key per target, clamp, `setBandTrack`).
    - One guidance line in the light hints: "Night: darkness 0.85 and a warm lamp (#ffb066). Day: darkness 0.2."
  - `applyCommand` cases, `summarizeCompositorChange` cases ("Added a lamp", "Changed the light", "Darkness 85%", "Animated the light"), `snapshot()`/`restore` include `lighting`.
  - `removeLayer` already works on any layer id — confirm a light can be removed.
- `frontend/app/components/vue-canvas/CompositorModal.vue` agent `setState` (~:1668): write `s.lighting` back through `editor.setLighting` when it differs.
- `frontend/app/lib/agent/mergeCompositorState.ts` `mergeDocFields`: merge `lighting`.
- `frontend/app/lib/motionx/adapter/agentBands.ts` `isAgentBand`: also pass `isLightBandPath` paths.
- `frontend/app/lib/agent/capabilities.ts` (~:338) Compositor intents: "add a light", "add a warm lamp", "make it night", "light the scene", "darker", "spotlight".
- Tests: extend `agent-compositor-surface.unit.spec.ts` (lights visible; each op applies/clamps/refuses a 7th; summaries; hint total ≤ ceiling — replace the "lights read-only" test), `agent-compositor-animate-dial.unit.spec.ts` style file for `animateLight`, `agent-compositor-merge-state.unit.spec.ts` (lighting merges), `motionx/agent-bands.unit.spec.ts` (light bands pass), `agent-capability-routing.unit.spec.ts` (phrases route to the Frame).
- Commit: `feat(agent): the Frame assistant adds, sets and animates lights (light layers stage 4)`.

### Task 5: Browser checks

**Files:** `frontend/tests/frame-light-layers.spec.ts` (extend), `frontend/tests/agent-compositor-vocab.spec.ts` (extend with a mocked plan response — no paid/LLM calls).
- [ ] On :3002, grid hidden:
  1. Add a Brightness band on a lamp (Motion tab → Add property → Light → Brightness), set 0→3: scrubbing to the end brightens the lit side; t=0 equals the static paint.
  2. A Colour band white→red: the end frame's lit side is red-tinted.
  3. All lights row appears with a lamp; a Darkness band 0→1 darkens far pixels over time; the row disappears when the last light is deleted.
  4. A Lift band on a headline lengthens its shadow over time.
  5. A light x band moves the bright side (already possible in stage 1 — keep as regression).
  6. Assistant with a mocked plan of `addLight` + `setLighting{darkness:0.85}` + `animateLight`: the lamp appears, the Frame darkens, the band shows in the Motion tab; one undo removes all of it.
  7. Web export of an animated-light Frame plays: frame at t=end differs from t=0 near the lamp and matches the editor at the same t.
- Commit: `test(frame): animated lights, Darkness, Lift and the assistant (light layers stage 4)`.

### Task 6: Record the state
`docs/STATE.md`, the dashboard, memory.

## Rulings made while writing this plan
- **Darkness gets a Frame-level path (`frame.darkness`) and its own "All lights" row**, not a property hung on one light — duplicating or deleting a light must never duplicate or lose the Frame's Darkness animation. Cost: a new row type in the timeline.
- **Animated Lift re-stamps the maps every frame.** Same cost as animating any position today; no special cache.
- **The light-motion code lives in its own module, stubbed in the lean export.** The lean bundle has under 1 KB left; Frames with animated lights take the full bundle.
- **Assistant ops are dedicated (`addLight` …) rather than widening `addLayer`/`setLayerProps`**, so validation and the 6-light cap live in one place.
