# Slice F5 · Shader catalog as a layer pass  (task-level plan)

> Part of the **Frame Effects Programme**
> (`docs/superpowers/plans/2026-09-09-frame-effects-programme.md`). Task-level plan for slice F5,
> written when reached, executed with superpowers:subagent-driven-development as F1–F4 were.

**Goal:** a new **`shader` effect kind** in a layer's per-layer effect stack — a GPU pass that runs
any input-sampling Shader Studio catalog effect over the layer's OWN already-rendered pixels,
reorderable alongside the other pixel effects, alpha preserved, animated by the frame clock. This is
DISTINCT from the existing shader-as-a-FILL (a layer whose `.fill` is a shader, which replaces the
fill) and from the glass lens (a `.fill` shader that refracts the layers BEHIND): F5 processes the
layer's own content as a stackable post-effect, so it works on photos, text and shapes alike.

## Scope decisions (2026-09-13)

- **Agent = picker-only this slice.** The compositor agent-hint budget has ~8 chars of headroom
  (26,242 / `COMPOSITOR_HINT_CEILING` 26,250) and the dashboard already records "the next compositor
  hint addition needs the ceiling raised." A shader effect needs an `effectId` + per-effect-param
  vocabulary the agent can't drive without a lot of hint text, and a half-taught agent would add an
  empty shader effect that no-ops. So the `shader` kind is **not agent-settable** in F5 (like
  `boolean`/`morph`'s `refLayerId`, which is picker-only) — the sanitizer rejects it and no hint
  grows. "Agent vocabulary for shader effects" is a follow-up gated on the hint-ceiling decision
  (raise it, or recover chars from the 11,072-char `mosaic` hint). NOT a dead control: it works in
  the UI, it's only the agent that can't reach it yet.
- **Picker filters to input-sampling effects.** A `shader` PASS only makes sense for an effect that
  actually samples its input (`effectReadsInput(effectId)` — a real `texture(u_image0, …)` in the
  GLSL, catalogStore.ts). A pure-generative effect would overwrite the layer, which is what a shader
  FILL already does — so generatives are excluded from the F5 picker, exactly as the glass lens
  excludes them.
- **Lives outside postEffects.ts.** `postEffects.ts` is deliberately canvas-2D-only with a one-way
  independence from effectStack.ts; a WebGL pass that pulls in the shaderfx catalog belongs in
  `useCompositorLayers.ts`, alongside the glass-lens/DOF GPU code and the `_fieldCtx` frame clock. So
  the `shader` kind is a `LayerEffect` arm in effectStack.ts (NOT a `PostEffect`), and it stays out
  of `CHAIN_TYPES`/`PASS_TYPES`/`GPU_TYPES` (those drive the fixed-order doc-level path).

## Global constraints (from the programme; bind every task)

- **Byte-identical when absent.** A layer with no `shader` effect renders byte-for-byte as before
  (the `case 'shader'` never fires; the read-through writes nothing until you edit). Proven by a
  real-canvas A/B at dpr 2 (data-URL equal), run RED first against a stub that applies unconditionally.
- The stack's id / read-through / region / reorder rules are unchanged (a `shader` kind lands in the
  `'pixel'` region by `regionOf`'s fallthrough — no edit to `regionOf`/`canReorder`/`addEffect`).
- UI copy sentence case, human names, no dead controls; `optionLabels` on any select over internal
  values; the picker reuses the app's canonical `CatalogModal` + `derivedShaderFillControls`.
- `CompositorModal.vue` and other shared files staged **by hunk** (`git diff` → `git apply --cached`,
  private `GIT_INDEX_FILE`) — concurrent sessions edit these; own hunks only, never `git add -A`,
  never `git stash`. NEVER let a subagent run `npm run dev` (kills the shared :3002).
- Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Lessons that bind the shader work (from S4/S5 + the glass lens)

- **Alpha is not preserved by most catalog frags** — the majority hard-code output alpha to 1.0. The
  shader pass MUST recombine alpha: after `renderFieldWithBase`, clip the result back to the layer's
  own pre-shader alpha (`destination-in` against a snapshot of `off`'s alpha, the glass-lens recipe)
  — otherwise a shader over a text/cutout layer fills the whole box opaque.
- **A shader over the layer must be gated on it actually sampling the input** (`effectReadsInput`),
  or it silently overwrites the layer's pixels with a generative field. The unit test uses a real
  input-sampling effect; assert a generative one is absent from the picker list.
- **CPU twins pass over broken GPU shaders** (S4/S5): the byte-identity + parity work needs the
  **live Playwright GPU gate** (controller-run, fresh harness or the healthy :3002, NEVER a subagent
  dev server) before closeout, not after. A hidden pane pauses rAF, so headless Playwright is the
  oracle.
- **`renderFieldWithBase` is the reuse target, NOT `chain.ts` `applyPost`** — `applyPost` runs the
  whole fixed Post-stack (13 curated effects); `renderFieldWithBase(spec, base, w, h, shape?, t)`
  runs ONE named catalog effect over `base` (bound as `u_image0`) and is what the glass lens uses.

---

## Interfaces produced

### `lib/compositor/effectStack.ts`
- `ShaderPixelEffect` interface added to the `LayerEffect` union:
  `{ type: 'shader'; id?: string; visible?: boolean; effectId: string; params: Record<string, ParamValue>; speed: number; seed: number }`
  — a subset of `ShaderSpec` (fillTile.ts) MINUS the fill-only fields (`anchor`, `input`,
  `readsBackdrop`, `readsLayerKey` — none apply to a pass over the layer's own content).
- `'shader'` added to `EFFECT_ORDER` at a pixel-region position (after the geometry region, among the
  pixel kinds — implementer picks the exact slot; it reorders freely regardless). `EffectKind` picks
  it up automatically (derived from `LayerEffect`).
- `EFFECT_LABELS.shader = 'Shader'` (total-Record; breadcrumb reads it).
- `LOCAL_DEFAULTS.shader` = `{ visible: true, effectId: <a sensible default input-sampling effect>,
  params: {}, speed: 1, seed: 42 }` (`defaultsFor` checks LOCAL_DEFAULTS first).
- No change to `regionOf` / `canReorder` / `addEffect` / `effectStackOf` (all key off `EFFECT_ORDER`
  membership + the `'pixel'` fallthrough) — assert this with tests rather than editing them.

### `lib/compositor/useCompositorLayers.ts`
- `applyShaderPixelEffect(off: HTMLCanvasElement, e: ShaderPixelEffect, opts: { W: number; scale: number; t: number }): void`
  — reads `off`'s current pixels as the base, runs `renderFieldWithBase({ effectId, params, speed,
  seed }, off, w, h, undefined, opts.t)`, then draws the result back onto `off` AND recombines alpha
  (`destination-in` against a snapshot of `off`'s pre-shader alpha) so the pass never fills
  transparent regions. Device-res: `off` is already device-sized; spatial params follow the existing
  `W * scale` convention. Wrapped so a throw (unloaded catalog, bad effect id) falls through to
  leaving `off` untouched, never aborts the frame (glass-lens precedent).
- `paintLayer`'s pixel-pass `switch` (~2743) gains `case 'shader': applyShaderPixelEffect(off, e as
  ShaderPixelEffect, { W, scale: s, t: _fieldCtx.t }); break` — the ONE dispatch site. `t` comes from
  the module-global `_fieldCtx.t` (the established frame-clock pattern), not a new param.
- Performance guard (Task 4): when animating, cap the shader pass's working resolution / throttle to
  the modal's existing content-fps + resolution-cap policy so an animated catalog effect over a big
  layer doesn't tank the preview (mirror the DOF / live-preview cap already in this file).

### `components/vue-canvas/CompositorModal.vue`
- A new `v-else-if="activeEffect!.type === 'shader'"` block in the effect-inspector breadcrumb chain
  (~7938, beside the `drop_shadow` / geometry blocks) that mounts:
  - the reused `CatalogModal` effect picker (from `ShaderFillEditor.vue`'s pattern — factor its
    `pickerItems`/`pickerFilters` into a small shared composable if clean, else reuse inline),
    **filtered to `effectReadsInput` effects**, writing `effectId`;
  - `derivedShaderFillControls(effectDef, prefix)`-driven dials for the picked effect's params;
  - a Speed slider (the one non-param control, like the fill editor).
- The add-menu (layer effect "+") offers `Shader` among the pixel effects.

### Agent surface — `lib/agent/surfaces/compositor.ts`
- **No change** (picker-only): `shader` is deliberately absent from the agent sanitizer and hints, so
  no hint-budget growth. A test asserts a `{ type: 'shader' }` patch from the agent is rejected/ignored
  (documents the deliberate gap), and the hint-budget test stays green (unchanged total).

---

## Tasks

### Task 1 · The `shader` effect-kind model
- effectStack.ts: `ShaderPixelEffect` interface + `LayerEffect` union arm; `'shader'` in
  `EFFECT_ORDER` (pixel region); `EFFECT_LABELS.shader`; `LOCAL_DEFAULTS.shader`.
- **Tests:** `regionOf('shader') === 'pixel'`; `canReorder` allows shader↔bloom, refuses shader↔a
  geometry kind and shader↔a pinned kind; `addEffect` places a shader at the end of the pixel region;
  `effectStackOf` round-trips a stored shader effect (new-shape untouched; a legacy layer with no
  shader is byte-identical); `defaultsFor('shader')` returns the LOCAL_DEFAULTS. No render yet.
- **Acceptance:** the model tests green; `EffectKind` includes `'shader'`; typecheck clean.

### Task 2 · The GPU pass (the core)
- `applyShaderPixelEffect` in useCompositorLayers.ts (renderFieldWithBase over `off` + alpha
  recombine + `_fieldCtx.t` + device scale + try/catch fall-through) and the `case 'shader'` in
  `paintLayer`.
- **Tests:** a real-canvas **byte-identity A/B** at dpr 2 — a layer with NO shader effect is data-URL
  equal before/after this task (RED first against a stub that applies unconditionally); an **applied**
  test — adding an input-sampling shader effect changes the layer's pixels (changed-pixel count vs
  plain, NOT gradient-energy — S4 lesson); an **alpha** test — the pass over a partially-transparent
  layer leaves the transparent region transparent (the recombine works). These are written as
  Playwright cases against the frame lab / compositor; the controller runs them live.
- **Acceptance:** byte-identity holds; an input-sampling effect visibly processes the layer; alpha
  preserved. (Live-run by the controller.)

### Task 3 · The effect inspector UI + picker
- The `v-else-if activeEffect.type==='shader'` block: reused `CatalogModal` picker filtered to
  `effectReadsInput`, `derivedShaderFillControls` dials, a Speed slider; the add-menu entry.
- **Tests (Playwright, controller-run):** add a Shader effect to a layer via the tree; the picker
  lists input-sampling effects and NOT a named generative; pick one → it renders over the layer;
  a param dial changes the render (a live uniform); the breadcrumb shows "Shader".
- **Acceptance:** the full add→pick→tune flow works on the real UI; no generative in the picker; no
  dead controls; copy sentence case.

### Task 4 · Duplicates, performance guard, parity + copy
- Duplicates are automatic (addEffect) — add a test that two shader effects on one layer both apply
  in stack order and reorder past each other changes the result. Performance guard: cap/throttle the
  shader pass when animating (mirror the modal's live-preview cap). Parity: assert the layer-pass
  output for an effect matches `renderFieldWithBase` on the same pixels (the pass is the studio
  effect, not a re-implementation). Copy sweep; the agent-rejects-shader test.
- **Acceptance:** duplicates + reorder proven; the guard holds an animated shader at interactive fps;
  parity test green; the full F5 Playwright describe green live; whole-slice unit sweep green.

---

## Acceptance (whole slice)
- A `shader` effect adds to a layer as a reorderable pixel effect, runs an input-sampling catalog
  effect over the layer's own pixels (photos/text/shapes), alpha preserved, animated by the frame
  clock, byte-identical when absent.
- The picker excludes generatives; params via `derivedShaderFillControls`; duplicates + reorder work.
- Live Playwright describe green (controller, fresh harness or healthy :3002); unit sweep green;
  typecheck at baseline.
- Agent is picker-only (deliberate; documented); the hint budget is unchanged.

## Follow-ups (owed, non-blocking)
- **Agent vocabulary for shader effects** — needs the `COMPOSITOR_HINT_CEILING` decision (raise it,
  or recover chars from the `mosaic` hint) before the agent can add/choose a shader effect.
- By-eye pass: which catalog effects read well as a layer pass (some are tuned for full-frame fills);
  whether the default effect id is a good first pick.
- A `shader` effect that samples the layer could later offer a "reads behind / bound layer" scope
  like the glass lens — out of scope here (F5 is the layer's own pixels only).
