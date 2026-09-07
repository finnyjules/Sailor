# Frame Glass Lens Shader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a layer's shader fill sample the pixels beneath it instead of its own fill, turning any shape into a glass pane that refracts what's behind it — scoped to "layers behind" or one bound layer.

**Architecture:** Add two optional fields to `ShaderSpec` (`readsBackdrop`, `readsLayerKey`). During `paintLayerStack`, a glass layer takes a `applyGlassFromLayer` branch (modelled on `applyBackdropBlur`): snapshot the backdrop (or render the bound layer), run the shader field with that snapshot bound as its input texture (`u_image0`), clip to the layer's silhouette, stamp back honouring opacity/blend, then paint the stroke. The layer's own fill is not painted. The field renderer gains a "render with an external base canvas" entry that bypasses the input-Paint cache.

**Tech Stack:** Nuxt 4 (Vue 3 + TypeScript), Vitest (unit), Playwright + Browser pane (E2E), WebGL2 shader-fill renderer.

## Global Constraints

- Work directly in the main checkout. No worktree, no branch. Stage only your own hunks by **exact path** (`git add -- <path>`); never `git add -A`, never `git stash` (shared checkout, multiple sessions).
- Unit tests run from `frontend/`: `npx vitest run <path>`.
- Typecheck (no `vue-tsc`): `cd frontend && npx nuxt typecheck` — expect a pre-existing baseline of errors; only assert **no new** errors in touched files.
- Backward compatibility: absent `readsBackdrop`/`readsLayerKey` MUST load as today's self-fill behaviour. No migration step.
- UI copy: sentence case, no internal identifiers; every selector over internal values needs `optionLabels`.
- Device-resolution discipline: all snapshots/offscreens are device-sized (multiply CSS px by the active scale), never CSS-sized.
- Reuse the existing WebGL renderer/GL context in `frontend/app/lib/shaderfx/renderer.ts`; do NOT create a second GL context.
- After any dev-server restart, check `127.0.0.1:8188/system_stats` and relaunch ComfyUI if it died (killing Nuxt can reap it).
- `:3002` is the conventional port for this checkout; confirm the actual port by grepping the dev log for `Local:`.

---

### Task 1: `effectReadsInput` eligibility predicate

**Files:**
- Modify: `frontend/app/lib/shaderfx/catalogStore.ts` (add exported helper; it already holds the sync catalog cache and `getEffectSync`)
- Test: `frontend/tests/unit/shader-effect-reads-input.unit.spec.ts`

**Interfaces:**
- Consumes: `getEffectSync(id)` and the loaded `EffectDef` (has `source: string`, `generative?: boolean`) from this module.
- Produces: `export function effectReadsInput(effectId: string): boolean` — true when the effect samples its input texture (its GLSL `source` references `u_image0`), false for purely generative effects and unknown ids.

- [ ] **Step 1: Read the file first.** Read `frontend/app/lib/shaderfx/catalogStore.ts` and `frontend/app/lib/shaderfx/types.ts` to confirm `getEffectSync` and the `EffectDef.source` field names.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/tests/unit/shader-effect-reads-input.unit.spec.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import { effectReadsInput } from '~/lib/shaderfx/catalogStore'

const CATALOG = {
  effects: [
    { id: 'plasma', name: 'Plasma', source: 'void main(){ gl_FragColor = vec4(1.0); }', generative: true },
    { id: 'liquify', name: 'Liquify', source: 'void main(){ gl_FragColor = texture(u_image0, v_texCoord + off); }' },
    { id: 'blinds', name: 'Textured Glass', source: 'vec4 c = texture(u_image0, uv);' },
  ],
} as any

describe('effectReadsInput', () => {
  beforeAll(() => setShaderFxCatalog(CATALOG))
  it('is false for purely generative effects', () => {
    expect(effectReadsInput('plasma')).toBe(false)
  })
  it('is true for input-sampling distortion effects', () => {
    expect(effectReadsInput('liquify')).toBe(true)
    expect(effectReadsInput('blinds')).toBe(true)
  })
  it('is false for unknown ids', () => {
    expect(effectReadsInput('nope')).toBe(false)
  })
})
```

Note: confirm the real name of the catalog setter (the function the fetch path calls to populate the sync cache — grep for where the catalog is stored, e.g. `setShaderFxCatalog` / a module-level `let cached`). If the setter is not exported, export it, or seed the module cache the way existing catalog tests do (grep `frontend/tests` for an existing shaderfx catalog test to copy the seeding pattern).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/shader-effect-reads-input.unit.spec.ts`
Expected: FAIL (`effectReadsInput` is not exported).

- [ ] **Step 4: Implement**

```ts
// in catalogStore.ts
const READS_INPUT_RE = /\bu_image0\b/
export function effectReadsInput(effectId: string): boolean {
  const def = getEffectSync(effectId)
  if (!def || typeof def.source !== 'string') return false
  return READS_INPUT_RE.test(def.source)
}
```

(Handle the `filament → thread_contours` alias the same way `getEffectSync` already does — if `getEffectSync` resolves aliases, this is automatic.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/shader-effect-reads-input.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -- frontend/app/lib/shaderfx/catalogStore.ts frontend/tests/unit/shader-effect-reads-input.unit.spec.ts
git commit -m "feat(frame): effectReadsInput — which shader effects sample their input"
```

---

### Task 2: `ShaderSpec` fields + `isGlassLayer`

**Files:**
- Modify: `frontend/app/lib/spacetype/fillTile.ts` (add fields to `ShaderSpec` ~:59)
- Modify: `frontend/app/composables/useCompositorLayers.ts` (add `isGlassLayer` helper near `fillIsShader`/`layerPaints`)
- Test: `frontend/tests/unit/frame-glass-layer.unit.spec.ts`

**Interfaces:**
- Consumes: `Fill`/`ShaderSpec`/`fillIsShader` from `fillTile.ts`; `effectReadsInput` from Task 1.
- Produces:
  - `ShaderSpec.readsBackdrop?: boolean` and `ShaderSpec.readsLayerKey?: string`.
  - `export function isGlassLayer(layer: LocalLayer): boolean` in `useCompositorLayers.ts` — true iff the layer's **primary fill** is a shader with `readsBackdrop === true` AND `effectReadsInput(spec.effectId)`. Uses `layerPaints(layer)[0]` / the layer's main fill slot to find the fill.

- [ ] **Step 1: Read** `fillTile.ts` around `ShaderSpec` (~:59) and `fillIsShader` (~:108); read `useCompositorLayers.ts` `layerPaints` (~:2899) and `fillIsShader` usage to learn how the primary fill is reached per layer kind.

- [ ] **Step 2: Add the ShaderSpec fields** (no test needed for the interface addition alone; it's covered by Step 3's test):

```ts
export interface ShaderSpec {
  // ...existing fields...
  readsBackdrop?: boolean
  readsLayerKey?: string
}
```

- [ ] **Step 3: Write the failing test** for `isGlassLayer`

```ts
// frontend/tests/unit/frame-glass-layer.unit.spec.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import { isGlassLayer } from '~/composables/useCompositorLayers'

const CATALOG = { effects: [
  { id: 'liquify', name: 'Liquify', source: 'texture(u_image0, uv);' },
  { id: 'plasma', name: 'Plasma', source: 'gl_FragColor = vec4(1.0);', generative: true },
]} as any

function shaderFill(effectId: string, extra: any = {}) {
  return { type: 'shader', shader: { effectId, params: {}, anchor: 'object', speed: 1, seed: 0, input: '#000', ...extra } }
}
function rect(fill: any) {
  return { id: 'r1', kind: 'rect', x: 0, y: 0, w: 10, h: 10, opacity: 1, fill } as any
}

describe('isGlassLayer', () => {
  beforeAll(() => setShaderFxCatalog(CATALOG))
  it('true for a shader fill reading backdrop with an eligible effect', () => {
    expect(isGlassLayer(rect(shaderFill('liquify', { readsBackdrop: true })))).toBe(true)
  })
  it('false when readsBackdrop is absent', () => {
    expect(isGlassLayer(rect(shaderFill('liquify')))).toBe(false)
  })
  it('false when the effect is purely generative', () => {
    expect(isGlassLayer(rect(shaderFill('plasma', { readsBackdrop: true })))).toBe(false)
  })
  it('false for a non-shader fill', () => {
    expect(isGlassLayer(rect('#ff0000'))).toBe(false)
  })
})
```

Adjust the `rect`/`shaderFill` fixtures to match the real `RectLayer` fill slot discovered in Step 1 (e.g. the fill may live at `layer.fill`).

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-glass-layer.unit.spec.ts`
Expected: FAIL (`isGlassLayer` not exported).

- [ ] **Step 5: Implement `isGlassLayer`** in `useCompositorLayers.ts`:

```ts
import { effectReadsInput } from '~/lib/shaderfx/catalogStore'
// ...
export function isGlassLayer(layer: LocalLayer): boolean {
  const fill = primaryFillOf(layer)          // reuse layerPaints/fillIsShader path
  if (!fill || !fillIsShader(fill)) return false
  const spec = (fill as Fill).shader
  return !!spec?.readsBackdrop && effectReadsInput(spec.effectId)
}
```

Use the existing helper that returns a layer's main fill (or `layerPaints(layer)[0]`); if none exists, add a tiny local `primaryFillOf` next to `isGlassLayer`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-glass-layer.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add -- frontend/app/lib/spacetype/fillTile.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/frame-glass-layer.unit.spec.ts
git commit -m "feat(frame): ShaderSpec.readsBackdrop/readsLayerKey + isGlassLayer"
```

---

### Task 3: Field renderer — render with an external base canvas

**Files:**
- Modify: `frontend/app/lib/shaderfill/field.ts` (input tile derivation ~:530; render call ~:546)
- Test: `frontend/tests/unit/shaderfill-render-with-base.unit.spec.ts` (light — asserts the base override is used, with the GL renderer mocked)

**Interfaces:**
- Consumes: existing `field.ts` internals (`getInputTile`, the renderer's `render(passes, base, w, h)`).
- Produces: `export function renderFieldWithBase(spec: ShaderSpec, base: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): HTMLCanvasElement` — renders the shader field synchronously using `base` as the `u_image0` source (NOT `spec.input`), bypassing the input-tile cache. Returns the 2D canvas the compositor stamps.

- [ ] **Step 1: Read** `field.ts` fully around the input-tile build (~:125–144, ~:530) and the render call (~:546), plus `renderer.ts:284–293` to confirm `render(passes, base, …)` uploads `base` → `u_image0`.

- [ ] **Step 2: Write the failing test** (mock the renderer so no real WebGL is needed):

```ts
// frontend/tests/unit/shaderfill-render-with-base.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'

const renderSpy = vi.fn(() => document.createElement('canvas'))
vi.mock('~/lib/shaderfx/renderer', () => ({
  getShaderFx: () => ({ render: renderSpy }),
}))

import { renderFieldWithBase } from '~/lib/shaderfill/field'

it('binds the provided base as the render input, not spec.input', () => {
  const base = document.createElement('canvas'); base.width = 8; base.height = 8
  const spec = { effectId: 'liquify', params: {}, anchor: 'object', speed: 1, seed: 0, input: '#123456' } as any
  renderFieldWithBase(spec, base, 8, 8)
  expect(renderSpy).toHaveBeenCalled()
  // second positional arg to render(passes, base, w, h) is our base canvas
  expect(renderSpy.mock.calls[0][1]).toBe(base)
})
```

Match the mock to the renderer's real export name discovered in Step 1 (e.g. `getShaderFx`, `shaderFx`, or a singleton). If `field.ts` calls the renderer through a differently named accessor, mock that path instead.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/shaderfill-render-with-base.unit.spec.ts`
Expected: FAIL (`renderFieldWithBase` not exported).

- [ ] **Step 4: Implement** by factoring the existing render body so it accepts an optional base override. Keep the existing cached path for normal fills; add the new entry:

```ts
export function renderFieldWithBase(spec, base, w, h) {
  const passes = expandPasses(/* built from spec, same as the normal path */)
  return getShaderFx().render(passes, base, w, h)   // base → baseTex → u_image0
}
```

Reuse whatever the normal path does to build `passes`/uniforms from `spec` (extract a small `buildPasses(spec, w, h)` helper if the code is inline, so both paths share it — DRY). Do NOT read/write `tileCache` here.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/shaderfill-render-with-base.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -- frontend/app/lib/shaderfill/field.ts frontend/tests/unit/shaderfill-render-with-base.unit.spec.ts
git commit -m "feat(frame): renderFieldWithBase — bind an external backdrop as the shader input"
```

---

### Task 4: Paint integration — `applyGlassFromLayer` (Layers behind)

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (new `applyGlassFromLayer` near `applyBackdropBlur` ~:2806; dispatch in `paintLayerStack` item loop ~:3066)

**Interfaces:**
- Consumes: `isGlassLayer` (Task 2), `renderFieldWithBase` (Task 3), existing `localBlendOp`, the silhouette/ghost trick from `applyBackdropBlur` (~:2832), device `scale`.
- Produces: `function applyGlassFromLayer(ctx, layer, ctxHelpers)` — renders the glass effect for the "layers behind" case (no `readsLayerKey`). Called from the loop; when it handles a layer, the layer's normal fill paint is skipped (stroke still paints).

- [ ] **Step 1: Read** `applyBackdropBlur` (~:2806–2848) and the `displaceMap` dispatch (~:3086) and the loop body (~:3066–3133) to copy the exact snapshot / silhouette / `destination-in` / device-space stamp idioms and the `continue` structure.

- [ ] **Step 2: Implement `applyGlassFromLayer`** (Layers-behind path):

```ts
function applyGlassFromLayer(ctx, layer, H) {
  const { W, Hpx, scale } = H            // device dims + scale, as applyBackdropBlur receives them
  // 1. snapshot current backdrop (device-sized)
  const snap = makeDeviceCanvas(W, Hpx)
  snap.getContext('2d').drawImage(ctx.canvas, 0, 0)
  // 2. refract
  const spec = primaryFillOf(layer).shader
  const lens = renderFieldWithBase(spec, snap, W, Hpx)
  // 3. clip to this layer's silhouette (+ its own mask ref, mirroring applyBackdropBlur)
  const sil = makeDeviceCanvas(W, Hpx); const sctx = sil.getContext('2d')
  drawLocalLayerSilhouette(sctx, layer, scale)         // ghost-fill like applyBackdropBlur ~:2832
  const lctx = lens.getContext ? lens : /* wrap */ lens
  const clipped = makeDeviceCanvas(W, Hpx); const cctx = clipped.getContext('2d')
  cctx.drawImage(lens, 0, 0)
  cctx.globalCompositeOperation = 'destination-in'
  cctx.drawImage(sil, 0, 0)
  // 4. stamp back honouring opacity + blend
  ctx.save()
  ctx.globalAlpha = layer.opacity ?? 1
  ctx.globalCompositeOperation = localBlendOp(layer)
  ctx.drawImage(clipped, 0, 0)
  ctx.restore()
  // 5. stroke still paints — handled by the loop after this returns (see Step 3)
}
```

Match helper names to what already exists (`makeDeviceCanvas`, the silhouette routine used by `applyBackdropBlur`). If `renderFieldWithBase` returns an `HTMLCanvasElement`, drawImage it directly.

- [ ] **Step 3: Dispatch in the loop.** After the hidden/skip guards and before the normal draw for the item, add:

```ts
if (isGlassLayer(layer)) {
  applyGlassFromLayer(ctx, layer, deviceHelpers)
  paintLayerStroke(ctx, layer, /* … */)   // reuse the existing stroke-only path if one exists
  continue                                 // skip normal fill paint
}
```

If no stroke-only helper exists, guard the normal draw so glass layers skip the fill but still stroke; the simplest correct v1 is `continue` (stroke deferred to a follow-up) — but prefer stroking. Read how strokes are drawn (`layer.stroke`) to wire this.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx nuxt typecheck 2>&1 | grep -i "useCompositorLayers\|field\|fillTile" || echo "no new errors in touched files"`
Expected: no new errors attributable to the new code.

- [ ] **Step 5: E2E verify in the browser preview** (see Task 7 for the full recipe). Quick check now: build a rect with a `liquify` shader fill, set `readsBackdrop:true` via the console on the layer, confirm the rect shows a warped copy of the layer beneath and pixels outside the rect are unchanged.

- [ ] **Step 6: Commit**

```bash
git add -- frontend/app/composables/useCompositorLayers.ts
git commit -m "feat(frame): applyGlassFromLayer — refract the layers behind, clipped to the pane"
```

---

### Task 5: Bound-layer mode (`readsLayerKey`)

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (extend `applyGlassFromLayer` + the loop's `byKey` context)

**Interfaces:**
- Consumes: the `byKey` map built in `paintLayerStack` (~:3047), `layerMaskRef`-style resolution (~:3093), the per-layer paint path to render a single layer to an offscreen.
- Produces: `applyGlassFromLayer` handles `spec.readsLayerKey`: renders **only** that layer to a device offscreen and uses it as the base; a dangling key falls back to the Layers-behind snapshot.

- [ ] **Step 1: Read** `layerMaskRef` (~:322) and the `byKey.get(ref)` usage (~:3093) and the routine that renders one layer to its own offscreen (the effected-layer offscreen build ~:1955).

- [ ] **Step 2: Extend the source resolution** in `applyGlassFromLayer`:

```ts
let source = snap  // default: backdrop
const key = spec.readsLayerKey
if (key) {
  const target = H.byKey.get(key)
  if (target) source = renderLayerToDeviceCanvas(target, H)   // just that layer's pixels
  // dangling key → keep the backdrop snapshot (fallback)
}
const lens = renderFieldWithBase(spec, source, W, Hpx)
```

`renderLayerToDeviceCanvas` should paint a single layer onto a fresh device canvas using the existing single-layer paint path (the same one that produces the effected-layer offscreen). Pass `H.byKey` into the helper from the loop.

- [ ] **Step 3: Unit test** the resolution/fallback with the paint calls mocked:

```ts
// frontend/tests/unit/frame-glass-bound-source.unit.spec.ts
// Assert: given readsLayerKey='l:t1' and a byKey map containing it, the target layer
// is the render source; given a dangling key, the backdrop snapshot is used.
```

Write this against a small extracted pure helper `resolveGlassSource(spec, byKey, snap, renderLayer)` so it is testable without canvases. Extract that helper from Step 2 and unit-test it.

Run: `cd frontend && npx vitest run tests/unit/frame-glass-bound-source.unit.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -- frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/frame-glass-bound-source.unit.spec.ts
git commit -m "feat(frame): glass bound-layer mode via readsLayerKey (mask-style resolution)"
```

---

### Task 6: UI — Reads selector in `ShaderFillEditor.vue`

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/ShaderFillEditor.vue`
- (Reference) `frontend/app/components/vue-canvas/compositor/FillControl.vue` for how the shader spec is passed/emitted, and the mask-source picker component for the layer-picker pattern.

**Interfaces:**
- Consumes: the current `ShaderSpec` value + an emit to update it; `effectReadsInput` (Task 1); the list of other layers in the stack (from the compositor store/props already available to the editor); the mask-source picker pattern.
- Produces: UI that writes `readsBackdrop` / `readsLayerKey` onto the spec, gated by eligibility, hiding the input-fill sub-control in backdrop modes.

- [ ] **Step 1: Read** `ShaderFillEditor.vue` (how it reads/emits the spec, where the input-fill sub-control renders, what layer-list props are available) and the mask-source picker component (grep for `maskedByKey` usage in the compositor components).

- [ ] **Step 2: Add the Reads selector** — a `StudioButton` segmented group (never hand-roll a button), sentence-case `optionLabels`:

```
Reads:  [ Its own fill ] [ Layers behind ] [ A specific layer ]
```

Value derivation:
- `Its own fill` when `!spec.readsBackdrop`
- `Layers behind` when `spec.readsBackdrop && !spec.readsLayerKey`
- `A specific layer` when `spec.readsBackdrop && spec.readsLayerKey`

On change, emit a spec patch: self → `{ readsBackdrop: false, readsLayerKey: undefined }`; behind → `{ readsBackdrop: true, readsLayerKey: undefined }`; specific → `{ readsBackdrop: true }` and reveal the picker.

- [ ] **Step 3: Gate on eligibility.** If `!effectReadsInput(spec.effectId)`, disable the two backdrop options and show the hint text "This shader has nothing to read behind it." Also, when the effect changes to an ineligible one while a backdrop mode is active, force the value back to `Its own fill` (emit `{ readsBackdrop: false, readsLayerKey: undefined }`).

- [ ] **Step 4: Layer picker.** When `A specific layer` is active, render a select of the **other** layers in the stack (exclude this layer), labelled by display name, writing `readsLayerKey` as `'l:<id>'` (match how mask sources build their key). Reuse the mask-source picker component if one exists.

- [ ] **Step 5: Hide the input-fill sub-control** whenever `spec.readsBackdrop` is true (no dead control) — wrap it in `v-if="!spec.readsBackdrop"`.

- [ ] **Step 6: Verify in the browser preview** — the selector appears for a shader fill, switches modes, disables for a generative effect, and the layer picker lists the other layers. (Full E2E in Task 7.)

- [ ] **Step 7: Commit**

```bash
git add -- frontend/app/components/vue-canvas/compositor/ShaderFillEditor.vue
git commit -m "feat(frame): Reads selector — turn a shader fill into a glass lens"
```

---

### Task 7: End-to-end verification pass

**Files:** none (verification only; may add one Playwright spec if a stable hook exists).

- [ ] **Step 1: Ensure a dev server for THIS checkout is healthy.** `lsof -nP -iTCP -sTCP:LISTEN | grep node`; confirm cwd with `lsof -a -p <pid> -d cwd`. If healthy, use it; if broken, restart on `:3002` and grep the log for `Local:`. Then check `127.0.0.1:8188/system_stats` and relaunch ComfyUI if it died.

- [ ] **Step 2: Open the Compositor** in the Browser pane. Create two layers: a filled shape (the backdrop) and a rect on top with a shader fill (`liquify` or `blinds`).

- [ ] **Step 3: Layers behind.** Set the rect's Reads to `Layers behind`. Assert with a canvas readback (`__sweep()`-style forced sync per the browser-pane recipe): (a) pixels inside the rect differ from the raw backdrop (refraction happened); (b) pixels outside the rect are byte-identical to a control render with glass off (tight clip). Screenshot for the report.

- [ ] **Step 4: Bound layer.** Add a third layer below; set Reads to `A specific layer` → the backdrop shape. Assert the glass output does NOT change when the third (unbound) layer is toggled hidden/reordered. Screenshot.

- [ ] **Step 5: Generative gate.** Switch the effect to `plasma`; assert the backdrop options are disabled and the mode reverts to `Its own fill`.

- [ ] **Step 6: Retina.** `resize_window` to a 2× context (or verify the device-scale path) and confirm the lens is full-resolution, not half-res.

- [ ] **Step 7: Full unit run + typecheck**

```bash
cd frontend && npx vitest run tests/unit/shader-effect-reads-input.unit.spec.ts tests/unit/frame-glass-layer.unit.spec.ts tests/unit/shaderfill-render-with-base.unit.spec.ts tests/unit/frame-glass-bound-source.unit.spec.ts
```
Expected: all PASS. Then `npx nuxt typecheck` — no new errors in touched files.

- [ ] **Step 8: Update the build dashboard** per the house rule (read the live one first, replace in place), and write/refresh the landing memory.

---

## Self-Review

**Spec coverage:**
- Data shape (`readsBackdrop`/`readsLayerKey`) → Task 2. ✓
- Eligibility predicate → Task 1. ✓
- `applyGlassFromLayer` (Layers behind) → Task 4. ✓
- Bound layer via `readsLayerKey` → Task 5. ✓
- Field renderer hook (external base, cache bypass) → Task 3. ✓
- UI selector + gating + hide input-fill → Task 6. ✓
- Stroke still paints; own fill ignored → Task 4 Step 3. ✓
- Device-res discipline → Global Constraints + Task 4/5. ✓
- Testing (unit + E2E) → Tasks 1–3, 5 (unit), Task 7 (E2E). ✓
- Edge cases: dangling key fallback → Task 5; generative guard → Task 2 (`isGlassLayer`) + Task 6; glass-over-glass → inherent (inline stamp). ✓

**Placeholder scan:** Code sketches reference real hook locations; where exact helper names depend on unread internals, each task's Step 1 reads the file first and the sketch says which existing idiom to match. No "TBD"/"implement later".

**Type consistency:** `readsBackdrop`/`readsLayerKey` used identically across Tasks 2, 4, 5, 6. `effectReadsInput` signature consistent (Tasks 1, 2, 6). `renderFieldWithBase(spec, base, w, h)` consistent (Tasks 3, 4, 5). `isGlassLayer(layer)` consistent (Tasks 2, 4).

**Note for the executor:** several tasks integrate against large, partially-unread files (`useCompositorLayers.ts` ~3375 lines, `field.ts`, `ShaderFillEditor.vue`). Each task's Step 1 is "read the exact ranges" — do that before writing, and match existing helper names rather than inventing them.
