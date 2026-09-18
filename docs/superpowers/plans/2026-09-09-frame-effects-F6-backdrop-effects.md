# Slice F6 · Backdrop effects  (task-level plan)

> Part of the **Frame Effects Programme** (`docs/superpowers/plans/2026-09-09-frame-effects-programme.md`).
> Task-level plan for F6, written when reached, executed with superpowers:subagent-driven-development
> as F1–F5 were.

**Goal:** effects that read the layers BEHIND a layer and treat them, while the layer keeps its own
fill/content on top (CSS `backdrop-filter` semantics). Two capabilities, plus a shared helper:
1. a **`backdrop_shader`** effect — runs any input-sampling Shader Studio catalog effect over the
   backdrop snapshot, ADDITIVELY (the layer's own content still paints on top), clipped to the layer's
   silhouette, on ANY layer including text;
2. a **`backdrop_luminance_mask`** effect — masks/reveals the layer's own content by the LUMINANCE of
   what's behind it (genuinely new — nothing reads backdrop luminance today);
3. a shared **`withBackdrop(ctx, layer, …, treat)`** helper extracted from `applyBackdropBlur`.

## Scope decision (2026-09-14) — why NOT the programme's literal four kinds

The seam map showed F6-as-specced (refraction / frosted glass / backdrop distortion / luminance mask)
heavily overlaps existing capability:
- **`background_blur`** (effectStack.ts, pinned backdrop kind) is ALREADY an additive backdrop
  treatment that keeps the layer's content on top — "frosted glass = blur + own fill on top" is
  ~zero new capability. So F6 does NOT add a "frosted glass" kind; frost is a catalog effect (a blur)
  picked into `backdrop_shader`, or the user keeps using `background_blur`.
- The **glass lens** (`applyGlassFromLayer` + `renderFieldWithBase`) ALREADY refracts/distorts the
  backdrop with the full shader catalog. Its only limits are architectural: it lives on the `.fill`
  slot so it REPLACES the fill, it is gated OFF text, and it isn't an effect-stack citizen. So F6 does
  NOT add "refraction"/"distortion" kinds; those are catalog effects picked into `backdrop_shader`.
- The genuinely-new capability is: an ADDITIVE backdrop treatment (own content on top) that runs a
  non-blur GPU catalog effect, reachable from ANY layer incl text, as an effect-stack member — i.e.
  `backdrop_shader`. Plus luminance-mask (nothing does it). Chosen by the user over the literal four.

The refraction/distortion PRIMITIVE is not new (proven in `applyGlassFromLayer`); F6's real work is the
additive dispatch + effect-stack citizenship + text support + the `withBackdrop` extraction + the
agent-hint-budget reality (picker-only again).

## Global constraints (bind every task)

- **Byte-identical when absent** and after the `withBackdrop` refactor: `background_blur` renders
  byte-for-byte as before (real-canvas A/B at dpr 2, RED-first); a layer with no F6 effect is
  untouched.
- Reuse, don't rebuild: `backdrop_shader` reuses F5's picker (CatalogModal filtered to
  `effectReadsInput`, `derivedShaderFillControls`), the `_fieldCtx.t` clock, and the corrected
  animation predicate (`getEffectSync(id)?.animated === true && speed !== 0` — F5's fix). Do NOT
  reintroduce the `|| speed !== 0` bug.
- Backdrop kinds are **pinned, backdrop region** (like `background_blur`): `regionOf` → 'backdrop',
  in `PINNED_KINDS`, at most one of each per layer; they coexist with `background_blur`.
- UI copy sentence case, human names, no dead controls; `CompositorModal.vue` / `useCompositorLayers.ts`
  staged BY HUNK (private `GIT_INDEX_FILE`, own hunks only, never `git add -A`/`git stash`); the
  private-index recipe MUST be ONE bash call (F5 lesson: a split call staged 44 foreign files).
- NEVER a subagent dev server; controller runs the live GPU gate (fresh harness or healthy :3002).
- Commits end `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Lessons carried from F5 / the glass lens

- The backdrop snapshot IS the live paint canvas: `octx.drawImage(ctx.canvas, 0, 0)` mid-paint
  captures "everything painted so far" (bottom-to-top single-ctx compositing). No separate buffer.
- Device-res: offscreens are sized `dev.width × dev.height`; blur/spatial params use `* W * t.a`
  (device px). The treated result is stamped in identity transform (`setTransform(1,0,0,1,0,0)`).
- Silhouette clip = a ghost layer (opaque, no effects, mask honored) + `destination-in`.
- Additive vs replacing: `background_blur` stamps the treated backdrop clipped to the silhouette and
  then the normal paint runs (NO `continue`) — the layer's content lands on top. `backdrop_shader`
  MUST follow this additive pattern, NOT glass's fill-replacing `continue`.
- Live Playwright is the oracle (a hidden pane pauses rAF); units pass over broken GPU shaders.
- Agent hint budget is at its ceiling (~8 chars) — F6 kinds are PICKER/UI-ONLY for the agent
  (deferred, like F5's shader), no hint growth; a test asserts rejection + the budget test unchanged.

---

## Interfaces produced

### `useCompositorLayers.ts`
- `withBackdrop(ctx, layer, localLayers, W, H, treat: (snapshot: HTMLCanvasElement, W, H, scale) => HTMLCanvasElement | void): void`
  — the shared scaffolding factored from `applyBackdropBlur` (~4737): snapshot `ctx.canvas` → build the
  silhouette ghost (honor mask) → `treat(snapshot)` (the treated canvas, or mutate in place) →
  `destination-in` clip to the silhouette → identity-transform stamp. `applyBackdropBlur` becomes a
  one-line caller whose `treat` sets `octx.filter = blur(...)`. (Glass lens is left as-is — it works;
  a shared-helper refactor of its extra lensShape/ownFill/bound-layer/opacity-blend machinery is a
  separate cleanup not worth the regression risk here. Note it as a follow-up.)
- `applyBackdropShader(ctx, layer, e: BackdropShaderEffect, localLayers, W, H, t)` — calls
  `withBackdrop` with `treat = (snap,w,h) => renderFieldWithBase(shaderSpecFromEffect(e), snap, w, h, undefined, t)`
  (reuse F5's `shaderSpecFromEffect`). Additive: dispatched in `paintLayerStack` BEFORE the normal
  paint, like `background_blur`, NO `continue`.
- `applyBackdropLuminanceMask(ctx, layer, e, localLayers, W, H)` — snapshot the backdrop, compute a
  per-pixel luminance→alpha mask (with `threshold`/`softness`/`invert` dials), and multiply it into
  the layer's own painted alpha. (Implementer chooses the exact composite: mask the layer's content by
  backdrop luminance — a reveal-through-bright/dark-behind effect.)
- Extend `hasAnimatedShaderFill` to also treat a `backdrop_shader` effect as live when its catalog def
  is animated AND `speed !== 0` (the F5-corrected predicate), so an animated backdrop shader advances
  the preview and inherits the modal cap/throttle.

### `lib/compositor/effectStack.ts`
- `BackdropShaderEffect { type:'backdrop_shader'; visible:boolean; effectId:string; params:Record<string,ParamValue>; speed:number; seed:number }`
- `BackdropLuminanceMaskEffect { type:'backdrop_luminance_mask'; visible:boolean; threshold:number; softness:number; invert:boolean }`
- Both added to the `LayerEffect` union, `EFFECT_ORDER` (in the backdrop region, near `background_blur`),
  `PINNED_KINDS`, `EFFECT_LABELS` (`'Backdrop shader'`, `'Backdrop luminance mask'`), `LOCAL_DEFAULTS`.
- `regionOf` gains both as `'backdrop'` (extend the `background_blur || dof` check).

### `CompositorModal.vue`
- Two new `v-else-if="activeEffect!.type === '…'"` inspector blocks: `backdrop_shader` reuses the F5
  shader block (CatalogModal filtered to `effectReadsInput` + `derivedShaderFillControls` + Speed);
  `backdrop_luminance_mask` gets threshold/softness/invert dials. Add-menu lists both (auto via
  EFFECT_ORDER) — check the menu still fits at ~640px (F5 added one, this adds two).

### Agent — `lib/agent/surfaces/compositor.ts`
- No change (picker/UI-only): both kinds absent from the sanitizer; a test asserts a `{type:'backdrop_shader'}`
  patch is rejected and `COMPOSITOR_HINT_CEILING` is unchanged.

---

## Tasks

### Task 1 · Extract `withBackdrop`, refactor `background_blur` onto it
- Factor the snapshot/silhouette/clip/stamp scaffolding out of `applyBackdropBlur` into `withBackdrop`;
  `applyBackdropBlur` becomes a thin caller (treat = CSS blur).
- **Tests:** real-canvas A/B — a `background_blur` layer renders data-URL-identical before/after the
  refactor (RED-first against a deliberately-broken helper); a unit on `withBackdrop`'s treat contract
  if extractable. Controller runs the live A/B.
- **Acceptance:** background_blur byte-identical; `withBackdrop` ready for the new kinds.

### Task 2 · The `backdrop_shader` kind (model + render, additive, any layer incl text)
- effectStack.ts: `BackdropShaderEffect` model (EFFECT_ORDER backdrop region, PINNED, label, default,
  regionOf, read-through). useCompositorLayers.ts: `applyBackdropShader` via `withBackdrop` +
  `renderFieldWithBase`; dispatch in `paintLayerStack` additively (before normal paint, no continue),
  next to the `background_blur` dispatch (both the motion and static paths, ~5383/5396). `_fieldCtx.t`.
- **Tests (Playwright, controller-run):** byte-identity when absent (RED-first); applied — an
  input-sampling effect changes the pixels BEHIND a semi-transparent layer while the layer's OWN
  content still paints on top (assert both: the backdrop within the silhouette changed AND a known
  layer-content pixel is unchanged); works on a TEXT layer (the gap glass can't fill); determinism.
- **Acceptance:** additive backdrop treatment renders under the layer's content on any layer incl text;
  absent ⇒ byte-identical.

### Task 3 · The `backdrop_luminance_mask` kind
- Model + `applyBackdropLuminanceMask` (backdrop luminance → alpha mask on the layer's content;
  threshold/softness/invert). Dispatched in `paintLayerStack` (backdrop region).
- **Tests:** a CPU-twin unit for the luminance→alpha curve; Playwright applied (a bright vs dark
  backdrop changes the layer's revealed alpha) + invert flips it + absent byte-identity.
- **Acceptance:** the layer's content is masked by what's behind it; absent ⇒ byte-identical.

### Task 4 · Inspector UI + animation + duplicates + copy + agent-reject + whole-slice proofs
- CompositorModal.vue: the two inspector blocks (backdrop_shader reuses F5's picker; lum-mask dials);
  add-menu fit check at ~640px.
- Extend `hasAnimatedShaderFill` for animated `backdrop_shader` (F5-corrected predicate); a test that an
  animated backdrop shader advances the preview.
- Duplicates/coexistence: `background_blur` + `backdrop_shader` on one layer both apply; copy sweep;
  agent-reject unit + budget-unchanged.
- **Acceptance:** full F6 Playwright describe green live; whole-slice unit sweep green; typecheck baseline.

---

## Acceptance (whole slice)
- `withBackdrop` extracted; `background_blur` byte-identical.
- `backdrop_shader`: additive backdrop treatment via any input-sampling catalog effect, on any layer
  incl text, byte-identical when absent, animated ones advance the preview.
- `backdrop_luminance_mask`: masks the layer by backdrop brightness.
- Live Playwright green; agent picker-only (deliberate, documented); hint budget unchanged.

## Follow-ups (owed)
- Agent vocabulary for backdrop effects — the hint-ceiling decision (raise it / trim the mosaic hint).
- Refactor the glass lens onto `withBackdrop` (dedup; deferred for regression safety).
- A shape-following variant of `backdrop_shader` (reuse the glass `LensShape`) if wanted.
- By-eye: which catalog effects read well as an additive backdrop treatment; the lum-mask defaults.
