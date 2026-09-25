# Gold foil becomes a fill — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move Gold foil from a per-layer effect into the Frame's fill picker, next to Holographic. It also works as an outline paint, and it gains fine metal grain.

**Why (user decision, 2026-09-25):** in print, foil is chosen *instead of* ink. Picking it is choosing what the letters are made of, so it belongs where colour is chosen. Spot UV stays an effect, because it coats what is already printed.

**Architecture:**
- **The paint:** a new `Paint` variant `FoilFill = { type: 'foil'; metal; brushed; pressed; grain }`.
- **Where it renders:** at the layer's fill-drawing sites in `drawLayerContent`, and for plain outlines in `paintStrokeStack`. The foil region is drawn into its own device-resolution offscreen, `applyFinish(off, 'gold_foil', …)` runs on it (its own alpha is the mask), and the result is stamped where the fill or outline would have gone. The shader is unchanged apart from the grain.
- **Scope:** Frame only. `FillControl` offers Foil only when the host passes a prop, so Space Type, Shape Studio and Vector Type are untouched.
- **Grain:** a new foil dial, "Grain". The user asked for "more grain", and the probe sheet showed 0/0.4/0.7/1. **Ruling:** a dial from 0 to 1 with a default of 0.4. The user can re-pick; changing it is one constant.
- **The old effect:** `gold_foil` is removed as an effect kind. It landed on 2026-09-24, so no saved Frames hold it and nothing needs migrating.

**Spec:** `docs/superpowers/specs/2026-09-24-print-finishes-design.md` (this plan supersedes its "Gold foil is an effect" line; Task 3 updates the spec).
**Look reference:** the grain probe inserted these exact lines into `FOIL_FRAG` (the reference sheet was sent to the user):
- the normal gets `+ (vec2(hash(floor(px*1.5)), hash(floor(px*1.5) + 7.0)) - 0.5) * uGrain * 0.5`, added inside `vec3 N = normalize(vec3(g * uPressed * 1.2 …`
- `t += (hash(floor(px*1.5) + 3.0) - 0.5) * uGrain * 0.45;`, just before `vec3 c = ramp(t)`

## Global constraints
- **UI copy:** sentence case, never an identifier; selects pass optionLabels. Labels: "Foil" (the fill option), "Metal" (Gold, Silver, Rose gold, Copper), "Brushed", "Pressed in", "Grain".
- **Absent means unchanged:** a Frame without foil must render exactly as before.
- **No WebGL2 / context lost / oversize:** the foil region draws as a flat mid-metal colour, never blank.
- **Commits:** private index for every commit. Run `export GIT_INDEX_FILE=/private/tmp/foil-fill-index; git read-tree HEAD; git add <only your paths>; git diff --cached --stat; git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. Then, in a **separate** Bash call, run `git reset -q -- <paths>`.
  - Many files carry other sessions' uncommitted hunks. Run `git diff <file>` before editing, and stage only your own hunks (`git diff > p.diff`, trim it, `git apply --cached`).
  - Never `git stash`.
- **Servers:** never run `npm run dev`, and never start or kill a server. Playwright runs only against the existing http://127.0.0.1:3002.
- **Typecheck:** grep `npx nuxi typecheck` for your files before and after. New errors naming your files are yours.
- **Unit tests:** `cd frontend && npx vitest run <files>`.

---

### Task 1: The foil paint (type, grain, fallbacks)

**Files:**
- `frontend/app/lib/compositor/paint.ts`: the `Paint` union, plus a new `FoilFill` and `isFoilFill` guard next to `isImageFill`, discriminated on `type: 'foil'`.
- `frontend/app/lib/compositor/finishPass.ts`: `FoilDials` gains `grain`, `FOIL_FRAG` gains the `uGrain` uniform and the two probe lines above, and `foilUniforms` sends `uGrain` clamped to 0..1.
- `frontend/app/lib/paint/resolve.ts`: `resolvePaint` handles `isFoilFill` by returning the metal's mid colour (`METALS[metal][2]`). This is the non-GPU fallback, used for thumbnails, previews and anything not painted by `drawLayerContent`.
- `frontend/app/lib/paint/toVector.ts`: the foil fill falls to raster (like shader fills).
- `frontend/app/lib/agent/surfaces/compositor.ts`: `paintLabel` names a foil paint ("Gold foil", "Silver foil", …, from `METAL_LABELS`). The agent must NOT be able to set a foil paint: reject `{ type: 'foil' }` wherever the agent sets a fill or stroke, with a plain reason.
- `hasPaint(foil)` must be true.

**Interfaces produced:**
- `interface FoilFill { type: 'foil'; metal: FoilMetal; brushed: number; pressed: number; grain: number }`
- `isFoilFill(p: unknown): p is FoilFill`
- `DEFAULT_FOIL_FILL: FoilFill = { type: 'foil', metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 }`, exported from `paint.ts`
- `FoilDials` = `{ metal, brushed, pressed, grain }`

**Tests (TDD):**
- the guard
- `resolvePaint` falls back to the mid metal colour
- `foilUniforms` sends a clamped `uGrain`
- `FOIL_FRAG` declares `uGrain` and still has no descending smoothstep
- `paintLabel` for foil
- the agent refuses a foil paint
- `toVector` rasterises foil
- existing `finish-pass` tests are updated for `grain`

**Commit:** `feat(frame): a foil paint — metal, brushed, pressed in, grain`

### Task 2: Render foil as a fill and as an outline

**Files:**
- `frontend/app/composables/useCompositorLayers.ts`:
  - the fill sites in `drawLayerContent`: rect, ellipse, the text glyph-outline fill, and the path, polygon and star paths via `drawPath`
  - `paintStrokeStack`, for a stroke instance whose `paint` is foil

**How:**
- Add one helper, `paintFoilRegion(ctx, dials, drawShape: (c) => void)`:
  1. Make a scratch canvas the size of `ctx.canvas` (reuse one module-level scratch canvas, resized as needed).
  2. Copy `ctx.getTransform()`.
  3. Call `drawShape(c)`, which fills or strokes the region in opaque white.
  4. Call `applyFinish(scratch, 'gold_foil', dials, _frameLight, scale)`, where `scale` = device px per logical px taken from the Frame base transform (`_fieldCtx.base`, `Math.hypot(a, b)`, falling back to 1).
  5. If it returns false, flood the region with `METALS[metal][2]` instead.
  6. `ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(scratch, 0, 0); ctx.restore()`.
- **Draw order:** each site keeps its current order (text: strokes, then the fill on top; shapes: the fill, then strokes). Foil only replaces the `ctx.fill(path)` or `ctx.stroke(...)` call.
- **Outlines:** plain band outlines only. Marching-shape outlines with a foil paint use the fallback colour.
- **Remove the old dispatch:** delete the `case 'gold_foil'` in the body-pass switch, but keep `case 'spot_uv'`.

**Tests (TDD):**
- with the stub-canvas pattern from `tests/unit/post-effects-paint.unit.spec.ts`, a rect with a foil fill calls the finish path once, and a rect with a foil fill plus a solid stroke still strokes with the solid colour
- the fallback floods with the mid metal colour when `applyFinish` returns false (mock `finishPass`)
- a non-foil layer never calls `applyFinish`

**Commit:** `feat(frame): foil renders as a fill and as an outline, lit by the Frame light`

### Task 3: The picker, the light handle, removing the effect, docs

**Files:**
- `frontend/app/components/vue-canvas/compositor/FillControl.vue`: a new optional prop `allowFoil?: boolean`. When it is true, a synthetic `'foil'` UiType labelled "Foil" sits right after Holographic. Picking it emits `structuredClone(DEFAULT_FOIL_FILL)`, and while it is current, show:
  - Metal (`StudioSegmented` with optionLabels from `METAL_LABELS`)
  - Brushed, Pressed in and Grain sliders, each 0..1
  - a `FinishLightControl` bound to the Frame light. Pass the light and `setFrameLight` in as props or emits, following how FillControl already talks to its host.
  - `fillPickerType` (or FillControl's `currentType`) must read a foil paint back as `'foil'`.
- `frontend/app/components/vue-canvas/CompositorModal.vue`:
  - pass `allowFoil` on the layer fill picker and on the outline paint picker, but NOT on the background fill
  - the light handle shows when a `spot_uv` effect is selected OR the selected layer has a foil fill or foil outline
  - remove the Gold foil effect inspector branch
- `frontend/app/lib/compositor/effectStack.ts` and `effectDials.ts`: remove `gold_foil`. That means the interface, union member, `EFFECT_ORDER` entry, label, `LOCAL_DEFAULTS` entry and dial-schema entry. Update the tests that pinned it (`finish-effects`, `compositor-effect-stack`, `effect-dials`, `agent-compositor-surface`).
- `frontend/tests/print-finishes.spec.ts`: seed the foil as the text layer's fill (`color`) instead of an effect. Keep all five checks green against :3002. The handle check now selects the foil layer.
- `docs/superpowers/specs/2026-09-24-print-finishes-design.md`: add a dated note under "Decisions made while building" saying that Gold foil is a fill (and an outline paint), that it has a Grain dial (0..1, default 0.4), and why.

**Tests:**
- a FillControl unit test (happy-dom): Foil is offered only with `allowFoil`, picking it emits the default foil, the dials render with sentence-case labels, and it reads back as foil
- the updated stack and dial tests
- Playwright 5/5

**Commit:** `feat(frame): Foil in the fill picker; the Gold foil effect retires`
