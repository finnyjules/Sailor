# Frame Brush Materials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six live paint materials (foil, chrome, lava, marbled ink, neon, oil slick) for the Frame brush tips. They follow the stroke for Round and Bristle, and are fixed to the surface for the spray can.

**Architecture:**
- A brush layer gets an optional `material = { id, moving }`.
- The Part 1 GPU engine gains a per-group **param pass** (stroke coordinates into an RGBA16F texture) and a **material pass**: coverage × material colour, from GLSL ported from the prototype.
- It returns a coloured canvas that the brush branch draws instead of pouring in the fill.
- Time comes from the Frame clock. A moving material registers as animated.

**Tech Stack:** Vue 3 + TypeScript (Nuxt 4), WebGL2 (+ `EXT_color_buffer_float`), Vitest (`cd frontend && npx vitest run <file>`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-frame-brush-materials-design.md` (read it; it is binding). Part 1 spec: `docs/superpowers/specs/2026-09-26-frame-brush-tips-design.md`.

**Prototype (GLSL and constants to port):** `docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html`
- the material shader `layProg` is at L517-605 (`has ?` = follows the stroke, else surface);
- the stroke-coordinate `paramProg` is at L497-516;
- round stroke steering `steer` is at L902 and `stampRound` at L946-962;
- the neon glow is at L539-560.

## Global Constraints

- Material ids and labels are exact:
  - `foil` "Holographic foil"
  - `chrome` "Liquid chrome"
  - `lava` "Lava"
  - `ink` "Marbled ink"
  - `neon` "Neon"
  - `oil` "Oil slick"
- `BrushLayer.material?: { id: MaterialId; moving: boolean }`. Absent means today's fill behaviour, byte-identical.
- **Not a FillType.** Do not touch `FILL_TYPES`, `resolvePaint`, `lib/shaderfill/*` or other studios.
- **Tip rule.** Round and Bristle groups use stroke coordinates (they follow the stroke). Spray groups use surface coordinates. Every coordinate is in Frame units (`REF_W = 1080`), never device px, so the look is identical at every render size. The prototype's px constants are Frame units 1:1.
- **Time.** t = Frame clock seconds (`_fieldCtx.t`) when `moving`, and exactly 0 when not. Flow along a stroke is `sU − t·55`.
- **Legacy strokes on a material layer** keep the layer's fill and draw underneath.
- **Fallbacks.**
  - Canvas2D fallback (no WebGL2): the material's flat `swatchColor`.
  - No `EXT_color_buffer_float`: every group uses surface coordinates.
- **Copy:** sentence case, no identifiers in UI text. Swatch buttons carry `aria-label` and `title` with the material label.
- **Commits.**
  - Private-index recipe (below), or for `CompositorModal.vue` the snapshot → patch recipe (below). Other sessions have uncommitted edits in that file.
  - Never `npm run dev`. Never `git stash`.

## Committing (paste into every brief)

Whole recipe in ONE Bash call from the repo root:
```bash
BEFORE=$(git rev-parse HEAD); export GIT_INDEX_FILE=$(mktemp -u /tmp/brushmat-idx-XXXX); git read-tree HEAD
git add -- <ONLY your exact paths>; git diff --cached --stat HEAD
git commit -q -m "<message>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$GIT_INDEX_FILE"
```
Then, in a SEPARATE call: `git reset -q -- <same paths>; git show --stat HEAD`

**CompositorModal.vue only.** Another session has uncommitted edits in it.
1. Before your first edit: `cp frontend/app/components/vue-canvas/CompositorModal.vue /tmp/brushmat-cm-before.vue`.
2. To commit, in one call: `diff -u /tmp/brushmat-cm-before.vue <F> > /tmp/brushmat-cm.patch; git show HEAD:<F> > /tmp/brushmat-cm-head.vue && patch -s /tmp/brushmat-cm-head.vue < /tmp/brushmat-cm.patch`. If that fails, stop and report NEEDS_CONTEXT.
3. Commit through a private index: `git read-tree HEAD`, then `git update-index --cacheinfo 100644,$(git hash-object -w /tmp/brushmat-cm-head.vue),<F>`, then `git commit`.
4. Never `git reset` that path afterwards.
5. After committing, refresh the snapshot.

## File map

| File | Responsibility |
|---|---|
| `frontend/app/lib/brushTips/materials.ts` | Catalogue: ids, labels, swatch CSS and colour, and the GLSL `MATERIAL_GLSL` |
| `frontend/app/lib/brushTips/round.ts` | Round dabs also emit stroke coordinates |
| `frontend/app/lib/brushTips/replay.ts` | Replayed round strokes carry `coords` |
| `frontend/app/lib/brushTips/engine.ts` | Param pass, material pass, neon halo, fallback colour |
| `frontend/app/lib/brushTips/coverage.ts` | `paint` option; cache key carries material and time bucket |
| `frontend/app/composables/useCompositorLayers.ts` | `BrushLayer.material`, the coloured draw, neon bounds pad, `hasAnimatedShaderFill` |
| `frontend/app/composables/useBrushPaint.ts` | Toolbar paint state (persisted); `paintMatchesLayer` |
| `frontend/app/components/vue-canvas/compositor/BrushToolbar.vue` | "Paint" swatch row |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Target-layer rule, new layer gets the material, Material select and Moving switch in the brush layer panel |

---

### Task 1: Materials catalogue and GLSL

**Files:**
- Create: `frontend/app/lib/brushTips/materials.ts`
- Test: `frontend/tests/unit/brush-materials.unit.spec.ts`

**Interfaces — produces:**
```ts
export type MaterialId = 'foil' | 'chrome' | 'lava' | 'ink' | 'neon' | 'oil'
export const MATERIAL_IDS: readonly MaterialId[]          // in that order
export interface MaterialDef { id: MaterialId; label: string; swatch: string /*CSS background*/; swatchColor: string /*#rrggbb flat fallback*/; index: number /*1..6, the GLSL uMat*/ }
export const MATERIALS: Record<MaterialId, MaterialDef>
export function isMaterialId(x: unknown): x is MaterialId
export const MATERIAL_GLSL: string   // GLSL ES 3.00 source defining:
// vec4 shadeMaterial(int mat, float a, float d, vec2 surf, bool has, float sU, float sV, float sSeed, float uTime, vec3 N)
// returns premultiplied colour for coverage `a`. surf = Frame-unit surface position; has = stroke coords valid.
// Neon (mat 5) is NOT handled here (the engine does its halo); calling it with 5 returns vec4(0).
// It requires the caller to have declared hash/noise/fbm/hsv — the same NOISE block engine.ts already has.
```
Swatches and labels are the prototype's `MATERIALS` table (L123-131). Use these `swatchColor` values:
- foil `#d9c8f0`
- chrome `#c4c9d4`
- lava `#ff6a1a`
- ink `#1d4e6e`
- neon `#ff4fd8`
- oil `#3a2a6e`

**Port:** the body of the prototype's `layProg` material branches (L566-603), from `vec3 col; float sp = .15, emit = 0.;` through `o = vec4(lit*a, a);`. Keep both the `has ?` and surface variants verbatim, with these changes:
- `px` becomes `surf`.
- `uSeed` becomes `sSeed` in the surface variant.
- `flowU` is computed inside as `sU - uTime*55.`.
- `diff`, `spec` and `wet` are computed inside from `N` and `d` exactly as L556-561, using `uRelief = 0` (spray and round paint are flat). The engine's separate shade pass handles relief.
- The paint branch (`uMat == 0`) is dropped.
- **Chrome in surface mode:** the prototype used `(.5 - px.y/uCss.y)*3.`, which depends on canvas height. Replace it with `(.5 - surf.y/1080.)*3.`, so the gradient spans one artboard width of height and is size-independent.

- [ ] **Step 1: Write the failing test**
```ts
// frontend/tests/unit/brush-materials.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { MATERIAL_IDS, MATERIALS, isMaterialId, MATERIAL_GLSL } from '~/lib/brushTips/materials'

describe('brush materials catalogue', () => {
  it('has the six materials in order with exact labels', () => {
    expect(MATERIAL_IDS).toEqual(['foil', 'chrome', 'lava', 'ink', 'neon', 'oil'])
    expect(MATERIAL_IDS.map(id => MATERIALS[id].label)).toEqual(['Holographic foil', 'Liquid chrome', 'Lava', 'Marbled ink', 'Neon', 'Oil slick'])
    expect(MATERIAL_IDS.map(id => MATERIALS[id].index)).toEqual([1, 2, 3, 4, 5, 6])
    for (const id of MATERIAL_IDS) expect(MATERIALS[id].swatchColor).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('recognises ids', () => {
    expect(isMaterialId('lava')).toBe(true)
    expect(isMaterialId('paint')).toBe(false)
    expect(isMaterialId(undefined)).toBe(false)
  })
  it('GLSL defines shadeMaterial with a stroke and a surface variant per material, size-independent chrome', () => {
    expect(MATERIAL_GLSL).toContain('vec4 shadeMaterial(int mat, float a, float d, vec2 surf, bool has, float sU, float sV, float sSeed, float uTime, vec3 N)')
    expect(MATERIAL_GLSL).not.toMatch(/uCss|gl_FragCoord/)   // no screen-space terms: looks must not depend on render size
    expect((MATERIAL_GLSL.match(/has \?/g) || []).length).toBeGreaterThanOrEqual(6)
  })
})
```
The surface variants of foil and oil in the prototype use `hash(floor(px/1.5)...)` sparkle and `fbm(px/…)`, which become `surf`. `gl_FragCoord` must not appear.

- [ ] **Step 2:** Run it: `cd frontend && npx vitest run tests/unit/brush-materials.unit.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `materials.ts` as specified.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit `materials.ts` and the test: `feat(brush): paint materials catalogue and shader`.

---

### Task 2: Round strokes carry stroke coordinates

**Files:**
- Modify: `frontend/app/lib/brushTips/round.ts`, `frontend/app/lib/brushTips/replay.ts`
- Test: `frontend/tests/unit/brush-round-coords.unit.spec.ts`

**Interfaces — produces:**
- `RoundSim.coords: DabBuffer`. It is parallel to `dabs`: one entry per dab, holding `(u0, v0, tx, ty, rn)`.
  - `u0` is the arc length at the dab centre in Frame units. For an overspray speck, it is the arc plus the speck's offset along the direction.
  - `v0` is the offset across the stroke ÷ `rn`.
  - `(tx, ty)` is the smoothed unit direction, with `rn = size/2`.
- `simulateRound(stroke)` returns `{ dabs: DabBuffer; coords: DabBuffer }`. Update every caller (replay.ts, and grep for others). `Replayed` for round becomes `{ kind: 'dabs', dabs, coords, settled }`; spray has `coords: null`.

**Port:** the prototype's `steer(st, dx, dy, 0.25)` (L902), plus the arc accumulation in the round branch of `onRaw` (L1005-1012) and `stampRound` (L946-962):
- The direction starts at `(1, 0)`.
- The first dab has `u0 = 0`.
- Each stepped dab: steer toward the step, `arc += step`, then stamp.
- The main dab's coords are `(arc, 0, tx, ty, r)`.
- A speck at offset `(ox, oy)`: `(arc + ox·tx + oy·ty, (−ox·ty + oy·tx)/r, tx, ty, r)`.

The dabs array must stay **exactly** as today (same RNG call order; steering uses no randomness). The existing round tests prove this.

- [ ] **Step 1: Failing test**
```ts
// frontend/tests/unit/brush-round-coords.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { simulateRound } from '~/lib/brushTips/round'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, type TipStroke } from '~/lib/brushTips/record'

const stroke = (): TipStroke => ({ tip: 'round', v: 1, size: 36 / REF_W, settings: defaultSettings('round'), seed: 7,
  pts: encodePts(Array.from({ length: 40 }, (_, i) => ({ x: 0.1 + i * 0.01, y: 0.5, t: i * 12 }))) })

describe('round stroke coordinates', () => {
  it('one coordinate record per dab', () => {
    const r = simulateRound(stroke())
    expect(r.coords.count).toBe(r.dabs.count)
  })
  it('u grows along the stroke, main dabs sit on the centre line, direction follows the stroke', () => {
    const { dabs, coords } = simulateRound(stroke())
    const d = dabs.view(), c = coords.view()
    let lastU = -1
    for (let i = 0; i < dabs.count; i++) {
      if (d[i * 5 + 2] !== 18) continue            // main dabs only (r = size/2)
      expect(c[i * 5]!).toBeGreaterThan(lastU); lastU = c[i * 5]!
      expect(Math.abs(c[i * 5 + 1]!)).toBeLessThan(1e-9)
      expect(c[i * 5 + 2]!).toBeGreaterThan(0.99)   // moving in +x
    }
    expect(lastU).toBeGreaterThan(300)             // ~0.39 of 1080 units travelled
  })
  it('dabs are unchanged by coordinate tracking (same as before)', () => {
    const a = Array.from(simulateRound(stroke()).dabs.view()), b = Array.from(simulateRound(stroke()).dabs.view())
    expect(a).toEqual(b)
  })
})
```
- [ ] **Step 2:** Run it and see it FAIL.
- [ ] **Step 3:** Implement. Run `tests/unit/brush-tips-round.unit.spec.ts`, `brush-tips-coverage.unit.spec.ts` and every `ls frontend/tests/unit | grep -iE "brush|tip"` file; they must still pass.
- [ ] **Step 4:** Run it and see it PASS.
- [ ] **Step 5:** Commit: `feat(brush): round strokes carry stroke coordinates for materials`.

---

### Task 3: Engine — param pass, material pass, neon halo

**Files:**
- Modify: `frontend/app/lib/brushTips/engine.ts`, `frontend/app/lib/brushTips/coverage.ts`
- Test: `frontend/tests/unit/brush-material-paint.unit.spec.ts` (pure helpers only; GPU output is verified in Task 7)

**Interfaces — produces:**
```ts
// engine.ts
export interface GroupPaint { material: MaterialId; t: number }   // t = seconds (0 when not moving)
export function rasterGroup(group, view, live, liveTailMs, paint?: GroupPaint): GroupRaster
//   with paint: `coverage` is the COLOURED premultiplied group (material × coverage), not white
export const NEON_HALO_UNITS = 16                                   // Frame units the neon glow reaches past the paint
// coverage.ts
export function paintKey(paint: GroupPaint | undefined): string    // '' | 'foil@0' | 'lava@t12.367' — t bucketed to 1/30 s
export function renderTipCoverage(key, strokes, view, live?, liveTailMs?, base?, paint?: GroupPaint)
//   the cache signature includes paintKey(paint)
```

**Behaviour:**
1. **Param pass** (only when `paint` is set and `EXT_color_buffer_float` is available; otherwise the group uses surface mode). Create a lazily-allocated RGBA16F texture and FBO at the view size, cleared to 0.
   - **Round groups:** draw each dab as a quad with the prototype `paramProg` fragment logic (L497-516):
     - discard when coverage < 0.04;
     - `off = local·r` (Frame units);
     - `u = u0 + dot(off, t)`, `v = clamp(v0 + dot(off, n)/rn, −1, 1)`;
     - output `(u, v, seed, 1)`, where `seed` = the stroke's `seed % 1000 / 100`;
     - blending off, so the newest dab wins.

     Coordinates come from `replayStroke(s).coords`. Vertex positions map Frame units → device px exactly like the dab pass.
   - **Bristle groups:** render the ribbon into the param texture, writing `(vU, vV, seed, 1)` with blending off.
   - **Spray groups:** no param pass. `has` is false everywhere.
2. **Material pass**, which replaces the grain pass's coverage output when `paint` is set. It is the same full-screen shader: compute `a` (grain/tooth exactly as today) and the density `d`, then:
   - `surf` = the Frame-unit position of the pixel. Use the same formula the grain pass uses: `uOrigin + fragCoord/uUnitPx`, with the y-flip as there.
   - `has` = param texture `.a > 0.5` (when a param texture exists). Then `sU = P.r`, `sV = P.g`, `sSeed = P.b`.
   - `N`: flat `vec3(0, 0, 1)`.
   - `colour = shadeMaterial(index, a, d, surf, has, sU, sV, sSeed, t, N)`.
   - **Neon** (index 5):
     - sample the density in 12 golden-angle taps within `NEON_HALO_UNITS` Frame units (`r·uUnitPx` device px), as in the prototype L539-560;
     - hue = `hsv(fract(has ? sU*.0012 - t*.12 + sSeed : surf.x*.0009 + surf.y*.0006 - t*.08 + seed), .75, 1.)`;
     - output `vec4(c*g*2.8*(1.+pulse) + mix(c,1,.6)*core, clamp(g*.8 + core*.8, 0, 1))`, where `pulse` applies only when `has`.
     - Neon may write outside `a` (the halo). Include `GRAIN_SEED` as `seed` for surface mode.
   - Include `MATERIAL_GLSL` after `NOISE` in this shader's source.
3. **Erase groups** ignore `paint` (they only cut).
4. **The shade pass is unchanged.** Bristle relief still comes back as `shade`; the caller soft-lights it over the coloured result.
5. **Canvas2D fallback with `paint`:** draw the coverage as today, then `source-in` fill with `MATERIALS[id].swatchColor`.
6. **coverage.ts:**
   - Thread `paint` to `rasterGroup` for non-erase groups.
   - `base` stays as is.
   - The cache signature appends `|${paintKey(paint)}`.
   - `paintKey` returns `''` without paint, `${id}@0` when `t === 0`, else `${id}@t${(Math.round(t*30)/30).toFixed(3)}`.

- [ ] **Step 1: Failing test** (pure)
```ts
// frontend/tests/unit/brush-material-paint.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { paintKey } from '~/lib/brushTips/coverage'
describe('paintKey', () => {
  it('is empty without paint and stable when still', () => {
    expect(paintKey(undefined)).toBe('')
    expect(paintKey({ material: 'lava', t: 0 })).toBe('lava@0')
  })
  it('buckets moving time to 1/30 s', () => {
    expect(paintKey({ material: 'foil', t: 1.001 })).toBe(paintKey({ material: 'foil', t: 1.01 }))
    expect(paintKey({ material: 'foil', t: 1.0 })).not.toBe(paintKey({ material: 'foil', t: 1.05 }))
  })
})
```
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Keep `rasterGroup` without `paint` **byte-identical** to today: every existing brush test must stay green.
- [ ] **Step 4:** PASS, plus all `brush|tip` unit files, plus `npx vue-tsc --noEmit -p . 2>&1 | grep brushTips` empty.
- [ ] **Step 5:** Headless GPU smoke, not committed. Mirror what Task 5 of Part 1 did: a scratch Playwright page that imports the module via the running dev server is NOT allowed. Instead, verify in Task 7. Note in your report which shader paths you could not execute.
- [ ] **Step 6:** Commit `engine.ts`, `coverage.ts` and the test: `feat(brush): materials drawn per stroke group — along the stroke for round and bristle, on the surface for spray`.

---

### Task 4: Brush layers paint with a material

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`: the `BrushLayer` type (~L737), the brush branch (~L4820-4900), the brush case of `localLayerBox` (~L1907), and `hasAnimatedShaderFill` (~L6434).
- Test: `frontend/tests/unit/brush-material-layer.unit.spec.ts`

**Interfaces — produces:**
- `BrushLayer.material?: { id: MaterialId; moving: boolean }`.
- `brushMaterialPad(layer): number`, exported. It is `NEON_HALO_UNITS / REF_W` when `material.id === 'neon'`, else 0 (width-normalised).

**Behaviour:**
- **Bounds.** In the brush branch and in `localLayerBox`, the tip bounds grow by `brushMaterialPad(layer)` on every side. Selection and the offscreen then hold the halo.
- **Brush branch with `layer.material` set:**
  1. Stamp legacy strokes and run the existing `source-in` fill on them only, exactly as today. With no legacy strokes, `off` stays empty.
  2. Call `renderTipCoverage(..., base: legacy.length ? off : null, paint: { material: id, t: material.moving ? _fieldCtx.t : 0 })`.
  3. `clearRect` `off` and draw the returned (coloured) canvas stretched to `(dw, dh)`.
  4. Do **not** run the source-in fill again.
  5. Then draw the shade with soft-light, as today.
- **Without `layer.material`:** the code path is exactly today's, byte-identical.
- **`hasAnimatedShaderFill`:** returns true when any local brush layer has `material?.moving === true`.

- [ ] **Step 1: Failing test**
```ts
// frontend/tests/unit/brush-material-layer.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { hasAnimatedShaderFill, brushMaterialPad, createBrushLayer } from '~/composables/useCompositorLayers'
const item = (layer: any) => ({ type: 'local', layer }) as any
describe('brush material layer', () => {
  it('a moving material needs the clock, a still one does not', () => {
    expect(hasAnimatedShaderFill([item(createBrushLayer({ material: { id: 'lava', moving: true } } as any))])).toBe(true)
    expect(hasAnimatedShaderFill([item(createBrushLayer({ material: { id: 'lava', moving: false } } as any))])).toBe(false)
    expect(hasAnimatedShaderFill([item(createBrushLayer())])).toBe(false)
  })
  it('neon grows the bounds for its glow', () => {
    expect(brushMaterialPad(createBrushLayer({ material: { id: 'neon', moving: true } } as any))).toBeGreaterThan(0)
    expect(brushMaterialPad(createBrushLayer({ material: { id: 'foil', moving: true } } as any))).toBe(0)
  })
})
```
If importing `useCompositorLayers` in node pulls in browser-only modules, add `// @vitest-environment happy-dom` (other compositor unit specs do this; check one).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus all `brush|tip|compositor-layer` unit files.
- [ ] **Step 5:** Commit: `feat(brush): a brush layer can paint with a material instead of its fill`.

---

### Task 5: Toolbar paint choice and target rule helper

**Files:**
- Modify: `frontend/app/composables/useBrushPaint.ts`, `frontend/app/components/vue-canvas/compositor/BrushToolbar.vue`
- Test: `frontend/tests/unit/brush-paint-material.unit.spec.ts`

**Interfaces — produces:**
- `brush.material: Ref<MaterialId | null>` (null = Colour). It is persisted in the existing `sailor.brushTips.v1` store as `material`, and invalid values load as null.
- The pure helper `paintMatchesLayer(layerMaterial: { id: MaterialId } | undefined, toolbar: MaterialId | null): boolean`, exported from `useBrushPaint.ts`. It is true when both are Colour, or both are the same material id.
- **Toolbar**, Paint mode only: a third row labelled "Paint":
  - a Colour swatch (the existing StudioColor; selecting it sets `material = null`);
  - six round material swatches (`data-testid="brush-material-<id>"`, `aria-pressed`, `aria-label` and `title` = label, background = `MATERIALS[id].swatch`);
  - clicking a swatch sets `material`.
- The colour picker stays usable: picking a colour also sets `material = null`.

- [ ] **Step 1: Failing test**
```ts
// frontend/tests/unit/brush-paint-material.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { useBrushPaint, paintMatchesLayer } from '~/composables/useBrushPaint'
import BrushToolbar from '~/components/vue-canvas/compositor/BrushToolbar.vue'
beforeEach(() => localStorage.clear())
describe('brush paint choice', () => {
  it('matches layers by paint', () => {
    expect(paintMatchesLayer(undefined, null)).toBe(true)
    expect(paintMatchesLayer({ id: 'lava' }, 'lava')).toBe(true)
    expect(paintMatchesLayer({ id: 'lava' }, null)).toBe(false)
    expect(paintMatchesLayer(undefined, 'foil')).toBe(false)
  })
  it('starts on Colour, remembers a material, ignores junk', () => {
    expect(useBrushPaint().material.value).toBeNull()
    localStorage.setItem('sailor.brushTips.v1', JSON.stringify({ material: 'chrome' }))
    expect(useBrushPaint().material.value).toBe('chrome')
    localStorage.setItem('sailor.brushTips.v1', JSON.stringify({ material: 'gold' }))
    expect(useBrushPaint().material.value).toBeNull()
  })
  it('toolbar swatches pick a material', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs: { StudioColor: true } } })
    await w.get('[data-testid="brush-material-neon"]').trigger('click')
    expect(brush.material.value).toBe('neon')
    expect(w.get('[data-testid="brush-material-neon"]').attributes('aria-label')).toBe('Neon')
  })
})
```
- [ ] **Step 2:** FAIL. **Step 3:** Implement, keeping the toolbar at ≤ 380 px wide (the Paint row wraps inside the bar). **Step 4:** PASS, plus `brush-toolbar.unit.spec.ts` and `brush-paint-tips.unit.spec.ts`.
- [ ] **Step 5:** Commit: `feat(brush): choose Colour or a material in the brush toolbar`.

---

### Task 6: Frame editor wiring — target rule, new layers, layer panel

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`. Use the snapshot → patch commit recipe.

**Behaviour:**
1. **Target rule** (the tip pointer-down path, `onTipPointerDown` ~L7070 and its target selection). For the current target (`activeBrushLayer()` or the pending layer): if `!paintMatchesLayer(target.material, brush.material.value)`, do not paint into it. Start a pending new brush layer, exactly as the no-selection path does.
2. **New brush layers** made by the tip path get `material: brush.material.value ? { id: brush.material.value, moving: true } : undefined`. The fill stays the toolbar colour, so switching the material off later reveals a sensible colour.
3. **Eraser:** the rule does not apply. An eraser paints into the selected brush layer whatever its material.
4. **Brush layer panel** (the `selectedLocal.kind === 'brush'` section ~L11724-11740):
   - Above the Fill control, a **Material** row: a `<select>` with "None (use fill)" plus the six labels (`data-testid="brush-layer-material"`).
   - When a material is set, a **Moving** switch (`data-testid="brush-layer-moving"`, default on) and the note "The material replaces the fill for brush strokes."
   - Hide the FillControl and "Fill with image…" while a material is set.
   - Each change is one history step, through the modal's normal `setLocal` / commit path.
5. **The animation loop.** Confirm the modal's live loop keys off `hasAnimatedShaderFill`: grep its call sites in the modal and in `ArtifactFrameNode.vue`. If either caches that result in a way that won't re-evaluate when `material` changes, fix it minimally and report.

- [ ] **Step 1:** Implement. Use `vue-tsc` grep for your file; there should be no new errors.
- [ ] **Step 2:** Run all `brush|tip` unit files plus `compositor-prompt-wiring`.
- [ ] **Step 3:** Commit via the CM recipe: `feat(brush): paint with materials in the Frame — new layer per paint, material and Moving in the layer panel`.

---

### Task 7: Real-browser verification (controller)

The controller runs this on the existing `:3002` server. It adds `frontend/tests/compositor-brush-materials.spec.ts`:
- For each material: Round and spray-can strokes on a fresh Frame. The brush layers have `material.id` set, and a screenshot of each.
- A material layer's pixels differ from the same strokes on a Colour layer.
- Moving off: two reads 1 s apart are identical. Moving on: they differ.
- Two perpendicular Round chrome strokes; the screenshot is judged by eye.
- Reload with Moving off redraws identical pixels.
- The same coverage share at two render sizes.
- The toolbar at 1280 and 1024.

Then update `docs/STATE.md` and the dashboard.
