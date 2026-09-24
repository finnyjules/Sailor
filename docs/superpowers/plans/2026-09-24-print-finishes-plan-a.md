# Print finishes, Plan A: halation, the Frame light, gold foil, spot UV

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Halation (film glow), a Frame-wide light, and Gold foil and Spot UV layer effects lit by that light, to Frame.

**Architecture:**
- **Halation** is a new 2D-canvas pass in `postEffects.ts`, next to Bloom.
- **Gold foil and Spot UV** are GPU passes built on the existing `GpuPost` WebGL2 stage. They run on the layer's device-resolution offscreen, and the layer's alpha is the mask.
- **The light** is a Frame property (`sailor_localLight`). It is threaded into `paintLayerStack` as a new trailing parameter and read by the finish passes.

**Tech Stack:**
- Nuxt 4 / Vue 3 / TypeScript
- Canvas 2D and WebGL2 (GLSL ES 3.00)
- Vitest for unit tests: `tests/unit/**/*.unit.spec.ts`, node environment, stubbed canvases
- The browser pane for pixel checks

**Spec:** `docs/superpowers/specs/2026-09-24-print-finishes-design.md` (commit `3da176e27`).
**Look reference:** https://claude.ai/artifact/ARWNKLm4DiKuwEjij4bjhq. Its shader constants are this plan's constants.

**Scope:** spec build stages 1–3. **Plan B** (written after this lands) covers stage 4, *Shine* in Motion, and stage 5, *Follow the pointer* in web exports. Both depend on the light shape this plan fixes.

## Global Constraints

- **UI copy:**
  - sentence case, never an identifier
  - selects and segmented controls pass `optionLabels`
- **Labels** (verbatim from the spec):
  - Gold foil: "Gold foil", "Metal" (Gold, Silver, Rose gold, Copper), "Brushed", "Pressed in"
  - Spot UV: "Spot UV", "Gloss", "Raised", "Varnish only"
  - Halation: "Halation", "Amount", "Spread"
  - Light presets: "Top left", "Top right", "Overhead", "Raking"
- **Absent means unchanged:** a Frame with no new effect and no `sailor_localLight` must render exactly as before. Every new parameter is optional and trailing.
- **No WebGL2:** a finished layer draws as its plain layer, and the inspector shows `finishUnavailableReason()`. Never fail silently.
- **Dials:** do not add any the spec doesn't list. Look constants stay constants.
- **Commit with a private index, for every commit** (the git index is shared across sessions):
  ```
  export GIT_INDEX_FILE=/private/tmp/print-finishes-index
  git read-tree HEAD
  git add <only this task's exact paths>
  git diff --cached --stat        # confirm ONLY your files
  git commit -m "..."             # message ends with the Co-Authored-By line below
  ```
  Then, in a **separate** Bash call so the variable is unset, resync the shared index:
  `git reset -q -- <the same paths>`.
  Never `git stash`. Never stage files you did not write.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Never run `npm run dev`** and never start a dev server. Browser checks use the existing main-checkout server. Find it with `lsof -nP -iTCP -sTCP:LISTEN | grep node`, then confirm its checkout with `lsof -a -p <pid> -d cwd`.
- **Typecheck against the baseline:** it has ~400 standing errors. Run `cd frontend && npx nuxi typecheck 2>&1 | grep -E "<files you touched>"` before and after your change. Any new error naming your files is yours. Do not label an error pre-existing without checking it at the base commit.
- **Unit tests:** `cd frontend && npx vitest run <spec file>`.

## File map

| File | Responsibility |
|---|---|
| `frontend/app/lib/compositor/postEffects.ts` (modify) | `HalationEffect`, `halationTintInPlace`, `passHalation`, chain registration |
| `frontend/app/components/vue-canvas/PostEffectsControls.vue` (modify) | Halation section |
| `frontend/app/lib/compositor/gpuPost.ts` (modify) | `GpuUniform` type with vec3 support, `uniformSetter` |
| `frontend/app/lib/compositor/frameLight.ts` (create) | `FrameLight`, defaults, presets, sanitize/read, `lightWorld` |
| `frontend/app/composables/useLocalLayerEditor.ts` (modify) | `frameLight`, `setFrameLight`, undo snapshot |
| `frontend/app/composables/useCompositorLayers.ts` (modify) | `light` param on `paintLayerStack`, `_frameLight`, dispatch cases |
| `frontend/app/lib/compositor/finishPass.ts` (create) | GLSL for foil and spot UV, uniforms builders, `applyFinish`, availability |
| `frontend/app/lib/compositor/effectStack.ts` (modify) | `GoldFoilEffect`, `SpotUvEffect`, order, labels, defaults |
| `frontend/app/components/vue-canvas/compositor/FinishLightControl.vue` (create) | Light presets row, shared by both finish inspectors |
| `frontend/app/components/vue-canvas/CompositorModal.vue` (modify) | Inspectors, light handle, `light` at paint call sites, web-export variant |
| `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (modify) | Pass the light at its two paint call sites |
| `frontend/app/lib/embed/frame/types.ts`, `frontend/app/lib/embed/surfaces/frame.ts` (modify) | `FrameVariant.light`, handed to the painter |

---

### Task 1: Halation

**Files:**
- Modify: `frontend/app/lib/compositor/postEffects.ts`:
  - interfaces (~:29)
  - `PostEffect` union (:265)
  - `POST_EFFECT_DEFAULTS` (:267)
  - `POST_FX_PARAM_CLAMP` (:319)
  - `CHAIN_TYPES` (:358)
  - `PASS_TYPES` (:1112)
  - `applyPasses` switch (:1133)
  - `CHAIN_ORDER` (~:1205)
- Modify: `frontend/app/lib/compositor/effectStack.ts`: `EFFECT_ORDER` (:196), `EFFECT_LABELS` (~:236)
- Modify: `frontend/app/components/vue-canvas/PostEffectsControls.vue`: `SECTIONS` (after `bloom`)
- Modify: `frontend/tests/unit/compositor-effect-inspector.unit.spec.ts:22-26`
- Test: `frontend/tests/unit/post-halation.unit.spec.ts` (create)

**Interfaces:**
- Produces:
  - `interface HalationEffect { type: 'halation'; amount: number; spread: number; visible: boolean }`
  - `halationTintInPlace(data: Uint8ClampedArray, threshold: number, tint: readonly [number, number, number]): void`
  - Chain kind `'halation'`

**Spec deviation, to tell the user:** `PANEL_EFFECT_KINDS` must only name kinds in `EFFECT_ORDER` (a unit test pins this). So halation also joins the per-layer add menu, right after Bloom, just as Bloom itself is both image-wide and per-layer. It adds no hint cost for the agent: halation becomes reachable through the existing post-effect path, because the agent accepts any `POST_EFFECT_DEFAULTS` type.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/unit/post-halation.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  halationTintInPlace, defaultPostEffect, chainActive, isChainEffect,
  POST_FX_PARAM_CLAMP, type HalationEffect,
} from '~/lib/compositor/postEffects'
import { EFFECT_ORDER, EFFECT_LABELS, regionOf } from '~/lib/compositor/effectStack'

const px = (r: number, g: number, b: number, a = 255) => new Uint8ClampedArray([r, g, b, a])

describe('halationTintInPlace', () => {
  it('drops pixels under the threshold to transparent', () => {
    const d = px(40, 40, 40)
    halationTintInPlace(d, 0.7, [1, 0.2, 0.05])
    expect(d[3]).toBe(0)
  })
  it('recolours a bright pixel by its luminance times the tint — red regardless of source hue', () => {
    const d = px(200, 255, 255)            // a bright cyan
    halationTintInPlace(d, 0.5, [1, 0.2, 0.05])
    const lum = 0.2126 * 200 + 0.7152 * 255 + 0.0722 * 255
    expect(d[0]).toBe(Math.round(lum))
    expect(d[1]).toBe(Math.round(lum * 0.2))
    expect(d[2]).toBe(Math.round(lum * 0.05))
    expect(d[3]).toBe(255)
  })
})

describe('halation registration', () => {
  it('has readable defaults', () => {
    expect(defaultPostEffect('halation')).toEqual({ type: 'halation', amount: 0.6, spread: 1, visible: true })
  })
  it('clamps its dials for the panel and the agent', () => {
    expect(POST_FX_PARAM_CLAMP.halation).toEqual({ amount: [0, 1.5], spread: [0.3, 2] })
  })
  it('is a chain kind, so a document with only halation runs the post chain', () => {
    const h: HalationEffect = { type: 'halation', amount: 0.6, spread: 1, visible: true }
    expect(isChainEffect(h)).toBe(true)
    expect(chainActive([h])).toBe(true)
  })
  it('sits right after bloom in the layer stack, in the pixel region, labelled in sentence case', () => {
    const i = (EFFECT_ORDER as readonly string[]).indexOf('halation')
    expect((EFFECT_ORDER as readonly string[])[i - 1]).toBe('bloom')
    expect(regionOf('halation')).toBe('pixel')
    expect(EFFECT_LABELS.halation).toBe('Halation')
  })
})
```

In `frontend/tests/unit/compositor-effect-inspector.unit.spec.ts`, change the "seven kinds" test to eight:

```ts
  it('is exactly the eight kinds the panel draws', () => {
    expect([...PANEL_EFFECT_KINDS].sort()).toEqual(
      ['adjust', 'bloom', 'dof', 'duotone', 'gradientMap', 'grain', 'halation', 'vignette'],
    )
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/post-halation.unit.spec.ts tests/unit/compositor-effect-inspector.unit.spec.ts`
Expected: FAIL. `halationTintInPlace` is not exported, and the inspector list has seven kinds.

- [ ] **Step 3: Implement**

In `postEffects.ts`, after `BloomEffect`:

```ts
/** Film halation: bright areas bleed a warm red fringe (the film's red layer scatters widest). */
export interface HalationEffect {
  type: 'halation'
  amount: number      // 0..1.5 — strength of the added glow
  spread: number      // 0.3..2 — scales both glow widths
  visible: boolean
}
```

Add `| HalationEffect` to the `PostEffect` union. Add these entries:
- `POST_EFFECT_DEFAULTS`:
  ```ts
  // A visible warm fringe on anything bright the moment it is added (the prototype's look).
  halation: { type: 'halation', amount: 0.6, spread: 1, visible: true },
  ```
- `POST_FX_PARAM_CLAMP`: `halation: { amount: [0, 1.5], spread: [0.3, 2] },`
- `'halation'` in `CHAIN_TYPES` and in `PASS_TYPES`
- `case 'halation': passHalation(ctx, off, e as unknown as HalationEffect, opts); break` in the `applyPasses` switch
- `'halation'` in `CHAIN_ORDER`, right after `'bloom'`

Then add the pure helper next to `brightPassInPlace` and the pass next to `passBloom`:

```ts
/** Halation bright pass: keep pixels at or above `threshold` luminance and recolour each to
 *  luminance × tint (film halation is red whatever the source colour); the rest go clear. */
export function halationTintInPlace(data: Uint8ClampedArray, threshold: number, tint: readonly [number, number, number]): void {
  const t = clamp01(threshold) * 255
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    if (lum < t) { data[i + 3] = 0; continue }
    data[i] = Math.round(lum * tint[0])
    data[i + 1] = Math.round(lum * tint[1])
    data[i + 2] = Math.round(lum * tint[2])
  }
}

// Look constants from the Finish proofs prototype: a wide red glow plus a tighter warm one.
const HALATION_THRESHOLD = 0.7
const HALATION_WIDE: readonly [number, number, number] = [1, 0.2, 0.05]
const HALATION_NARROW: readonly [number, number, number] = [1, 0.6, 0.35]
const HALATION_WIDE_RADIUS = 0.03    // × canvas width × spread
const HALATION_NARROW_RADIUS = 0.008

function passHalation(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: HalationEffect, opts: PassOpts): void {
  const amount = Math.min(1.5, Math.max(0, e.amount))
  if (!(amount > 0)) return
  const scale = opts.scale ?? 1
  const spread = Math.min(2, Math.max(0.3, e.spread))
  const glow = (tint: readonly [number, number, number], radius: number, alpha: number) => {
    const bp = cloneCanvas(off)
    const bctx = bp.getContext('2d')
    if (!bctx) return
    const img = bctx.getImageData(0, 0, bp.width, bp.height)
    halationTintInPlace(img.data, HALATION_THRESHOLD, tint)
    bctx.putImageData(img, 0, 0)
    const blurred = mkCanvas(off.width, off.height)
    const blctx = blurred.getContext('2d')
    if (!blctx) return
    blctx.filter = `blur(${Math.max(0, radius * spread * opts.W * scale)}px)`
    blctx.drawImage(bp, 0, 0)
    blctx.filter = 'none'
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.drawImage(blurred, 0, 0)
    if (alpha > 1) { ctx.globalAlpha = alpha - 1; ctx.drawImage(blurred, 0, 0) }
    ctx.restore()
  }
  glow(HALATION_WIDE, HALATION_WIDE_RADIUS, amount * 1.3)
  glow(HALATION_NARROW, HALATION_NARROW_RADIUS, amount * 0.45)
}
```

In `effectStack.ts`:
- Add `'halation'` to `EFFECT_ORDER` right after `'bloom'`.
- Add `halation: 'Halation',` to `EFFECT_LABELS`, next to the bloom label.

`halation` has no `LOCAL_DEFAULTS` entry, because `defaultsFor` falls back to `POST_EFFECT_DEFAULTS`.

In `PostEffectsControls.vue` `SECTIONS`, right after the `bloom` entry:

```ts
  { type: 'halation', label: 'Halation', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 1.5, step: 0.01 },
    { key: 'spread', label: 'Spread', min: 0.3, max: 2, step: 0.01 },
  ] },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/post-halation.unit.spec.ts tests/unit/compositor-effect-inspector.unit.spec.ts tests/unit/post-effects-paint.unit.spec.ts tests/unit/compositor-effect-stack.unit.spec.ts tests/unit/agent-compositor-surface.unit.spec.ts`
Expected: PASS. If an existing test pins a full list of kinds (EFFECT_ORDER, CHAIN_ORDER, the agent's error text), add `halation` to that list after bloom. Do not change anything else in it.

- [ ] **Step 5: Typecheck against the baseline**

Run: `cd frontend && npx nuxi typecheck 2>&1 | grep -E "postEffects|effectStack|PostEffectsControls|post-halation"`
Expected: no new errors naming these files. `EFFECT_LABELS` is `Record<EffectKind, string>`, so a missing label shows up here.

- [ ] **Step 6: Commit** (private-index recipe; paths are the five files above, plus the new spec)

`feat(frame): Halation — film glow, bright areas bleed a warm red fringe`

---

### Task 2: `GpuPost` takes vec3 uniforms

**Files:**
- Modify: `frontend/app/lib/compositor/gpuPost.ts:115-146`
- Test: `frontend/tests/unit/gpu-post-uniforms.unit.spec.ts` (create)

**Interfaces:**
- Produces:
  - `export type GpuUniform = number | Float32Array | { vec3: readonly [number, number, number] }`
  - `export function uniformSetter(name: string, value: GpuUniform): '1i' | '1f' | '2fv' | '3f'`
  - `render(color, depth, w, h, uniforms: Record<string, GpuUniform>)`

Why a wrapper and not "pick by array length": DOF uploads `uOffsets` as a 96-float array of vec2s, and an array of vec2s whose total length happened to be 3 or 4 would be misread.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { uniformSetter } from '~/lib/compositor/gpuPost'

describe('uniformSetter', () => {
  it('keeps every existing DOF convention', () => {
    expect(uniformSetter('uOffsets', new Float32Array(96))).toBe('2fv')
    expect(uniformSetter('uTapCount', 48)).toBe('1i')
    expect(uniformSetter('uFocus', 0.5)).toBe('1f')
    expect(uniformSetter('uOther', 3)).toBe('1f')   // integers are floats unless named uTapCount
  })
  it('sends a { vec3 } wrapper as a vec3', () => {
    expect(uniformSetter('uM0', { vec3: [1, 0.5, 0] })).toBe('3f')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/gpu-post-uniforms.unit.spec.ts`
Expected: FAIL, because `uniformSetter` is not exported.

- [ ] **Step 3: Implement**

In `gpuPost.ts`, above the class:

```ts
/** A uniform value. Plain numbers are floats (ints only for `uTapCount`, DOF's loop bound),
 *  a Float32Array is an array of vec2s (DOF's tap offsets), and `{ vec3 }` is one vec3 —
 *  a wrapper rather than "guess by length", so a vec2 array is never misread. */
export type GpuUniform = number | Float32Array | { vec3: readonly [number, number, number] }

export function uniformSetter(name: string, value: GpuUniform): '1i' | '1f' | '2fv' | '3f' {
  if (value instanceof Float32Array) return '2fv'
  if (typeof value === 'object') return '3f'
  if (Number.isInteger(value) && name === 'uTapCount') return '1i'
  return '1f'
}
```

Change the `render` signature's last parameter to `uniforms: Record<string, GpuUniform>`. Replace the uniform loop body with:

```ts
    for (const [name, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, name)
      if (!loc) continue
      switch (uniformSetter(name, value)) {
        case '2fv': gl.uniform2fv(loc, value as Float32Array); break
        case '3f': { const v = (value as { vec3: readonly [number, number, number] }).vec3; gl.uniform3f(loc, v[0], v[1], v[2]); break }
        case '1i': gl.uniform1i(loc, value as number); break
        default: gl.uniform1f(loc, value as number)
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass, DOF included**

Run: `cd frontend && npx vitest run tests/unit/gpu-post-uniforms.unit.spec.ts tests/unit/dof-pass.unit.spec.ts tests/unit/dof-paint.unit.spec.ts tests/unit/dof-parity.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(compositor): GpuPost takes vec3 uniforms`

---

### Task 3: The Frame light (model, storage, undo)

**Files:**
- Create: `frontend/app/lib/compositor/frameLight.ts`
- Modify: `frontend/app/composables/useLocalLayerEditor.ts`:
  - after the `postEffects` block (~:239)
  - the `Snapshot` type, `snapshot()` and `restore()` (~:318-330)
  - the returned object (~:1244)
- Test: `frontend/tests/unit/frame-light.unit.spec.ts` (create)

**Interfaces:**
- Produces:
  - `interface FrameLight { x: number; y: number; height: number }`. `x` and `y` are fractions of the Frame, with 0,0 at the top left. They are clamped to −0.5..1.5, so the light can sit off the edge. `height` is 0..1.
  - `DEFAULT_FRAME_LIGHT: FrameLight`
  - `LIGHT_PRESETS: Record<LightPreset, FrameLight>`, `LIGHT_PRESET_LABELS: Record<LightPreset, string>`
  - `type LightPreset = 'top_left' | 'top_right' | 'overhead' | 'raking'`
  - `sanitizeLight(raw: unknown): FrameLight`, `readFrameLight(props: unknown): FrameLight`, `presetOf(l: FrameLight): LightPreset | null`
  - `lightWorld(l: FrameLight, aspect: number): [number, number, number]`. This is the light in the shader's world space, where the Frame's width is 1, it spans y ∈ ±aspect/2 with y pointing up, and the camera sits at z = 2.6.
  - From `useLocalLayerEditor`: `frameLight: ComputedRef<FrameLight>` and `setFrameLight(l: FrameLight, record?: boolean): void`. `record` defaults to true. Pass false while dragging, after one `recordHistory()` at pointer-down.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FRAME_LIGHT, LIGHT_PRESETS, LIGHT_PRESET_LABELS, sanitizeLight, readFrameLight, presetOf, lightWorld,
} from '~/lib/compositor/frameLight'

describe('frame light', () => {
  it('defaults to the top-left preset when the Frame has none', () => {
    expect(readFrameLight(undefined)).toEqual(DEFAULT_FRAME_LIGHT)
    expect(readFrameLight({})).toEqual(DEFAULT_FRAME_LIGHT)
    expect(presetOf(DEFAULT_FRAME_LIGHT)).toBe('top_left')
  })
  it('reads a stored light', () => {
    expect(readFrameLight({ sailor_localLight: { x: 0.4, y: 0.6, height: 0.3 } })).toEqual({ x: 0.4, y: 0.6, height: 0.3 })
  })
  it('clamps position to a half-Frame beyond each edge and height to 0..1; junk falls back per field', () => {
    expect(sanitizeLight({ x: 9, y: -9, height: 2 })).toEqual({ x: 1.5, y: -0.5, height: 1 })
    expect(sanitizeLight({ x: 'a', y: null })).toEqual(DEFAULT_FRAME_LIGHT)
  })
  it('labels presets in sentence case', () => {
    expect(Object.values(LIGHT_PRESET_LABELS)).toEqual(['Top left', 'Top right', 'Overhead', 'Raking'])
  })
  it('recognises a preset exactly, and a dragged light as none', () => {
    expect(presetOf(LIGHT_PRESETS.raking)).toBe('raking')
    expect(presetOf({ x: 0.33, y: 0.33, height: 0.5 })).toBeNull()
  })
  it('maps to shader world space: centre is the origin, y points up, height lifts z', () => {
    expect(lightWorld({ x: 0.5, y: 0.5, height: 0 }, 1.25)).toEqual([0, 0, 0.3])
    const [x, y, z] = lightWorld({ x: 0, y: 0, height: 1 }, 1.25)
    expect(x).toBeCloseTo(-0.5); expect(y).toBeCloseTo(0.625); expect(z).toBeCloseTo(2.0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-light.unit.spec.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `frameLight.ts`**

```ts
/**
 * The Frame's one light. Every Gold foil and Spot UV finish on a Frame is lit from here, as
 * real print is — one room, one lamp. Stored on the Frame node as `sailor_localLight`; absent
 * means DEFAULT_FRAME_LIGHT, so a Frame that never touched a finish stores nothing.
 */
export interface FrameLight {
  /** Fractions of the Frame, 0,0 = top left. May sit up to half a Frame past an edge. */
  x: number
  y: number
  /** 0 = grazing the card, 1 = high overhead. */
  height: number
}

export type LightPreset = 'top_left' | 'top_right' | 'overhead' | 'raking'

export const LIGHT_PRESETS: Record<LightPreset, FrameLight> = {
  top_left: { x: 0.15, y: 0.1, height: 0.6 },
  top_right: { x: 0.85, y: 0.1, height: 0.6 },
  overhead: { x: 0.5, y: 0.4, height: 1 },
  raking: { x: -0.3, y: 0.35, height: 0.12 },
}
export const LIGHT_PRESET_LABELS: Record<LightPreset, string> = {
  top_left: 'Top left', top_right: 'Top right', overhead: 'Overhead', raking: 'Raking',
}
export const DEFAULT_FRAME_LIGHT: FrameLight = { ...LIGHT_PRESETS.top_left }

const clamp = (v: unknown, lo: number, hi: number, fb: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb

export function sanitizeLight(raw: unknown): FrameLight {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    x: clamp(r.x, -0.5, 1.5, DEFAULT_FRAME_LIGHT.x),
    y: clamp(r.y, -0.5, 1.5, DEFAULT_FRAME_LIGHT.y),
    height: clamp(r.height, 0, 1, DEFAULT_FRAME_LIGHT.height),
  }
}

export function readFrameLight(props: unknown): FrameLight {
  return sanitizeLight((props as Record<string, unknown> | undefined)?.sailor_localLight)
}

export function presetOf(l: FrameLight): LightPreset | null {
  for (const [k, p] of Object.entries(LIGHT_PRESETS) as [LightPreset, FrameLight][]) {
    if (Math.abs(p.x - l.x) < 1e-6 && Math.abs(p.y - l.y) < 1e-6 && Math.abs(p.height - l.height) < 1e-6) return k
  }
  return null
}

/** The light in the finish shaders' world space: Frame width 1, centred on the origin,
 *  y up, spanning ±aspect/2 vertically (aspect = h / w); camera at z = 2.6. Height 0..1
 *  lifts the lamp from z 0.3 (raking) to z 2.0 (overhead). */
export function lightWorld(l: FrameLight, aspect: number): [number, number, number] {
  return [l.x - 0.5, (0.5 - l.y) * aspect, 0.3 + l.height * 1.7]
}
```

- [ ] **Step 4: Wire it into `useLocalLayerEditor.ts`**

Import `{ readFrameLight, sanitizeLight, type FrameLight } from '~/lib/compositor/frameLight'`. After `setPostEffects`, add:

```ts
  // Doc-level light for Gold foil / Spot UV. Absent key = the default light (readFrameLight).
  const frameLight = computed<FrameLight>(() => readFrameLight(node()?.data?.properties))
  function writeLight(l: FrameLight | undefined) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    if (!l) delete (n.data.properties as any).sailor_localLight
    else (n.data.properties as any).sailor_localLight = sanitizeLight(l)
  }
  /** `record: false` while a drag is under way — the caller records once at pointer-down. */
  function setFrameLight(l: FrameLight, record = true) { if (record) recordHistory(); writeLight(l) }
```

Add `light?: FrameLight` to the `Snapshot` type. In `snapshot()`, add `light: (node()?.data?.properties as any)?.sailor_localLight`, which is the raw value, so an absent light stays absent. In `restore()`, after `writeFx(...)`, add `writeLight(s.light)`. Add `frameLight, setFrameLight,` to the returned object, next to `postEffects, setPostEffects,`.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-light.unit.spec.ts`, then the whole unit suite: `npx vitest run`.
Expected: frame-light passes, and the suite reports no new failures against the base commit. Under load the counts can wobble, so re-run any failing file on its own before blaming this change.

- [ ] **Step 6: Commit**

`feat(frame): a Frame-wide light for print finishes (model, storage, undo)`

---

### Task 4: Thread the light into painting

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`:
  - the `paintLayerStack` signature (:5889-5915)
  - the start of its body (~:5916)
  - a module-level `_frameLight` next to `_fieldCtx` (:1461)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`:
  - editor destructure (:887)
  - paint call sites :4923, :5054, :5637
  - `webExportVariant` (~:5170)
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue`: paint call sites :564 and :866
- Modify: `frontend/app/lib/embed/frame/types.ts:22-32`, `frontend/app/lib/embed/surfaces/frame.ts:377`
- Test: `frontend/tests/unit/frame-light-paint.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `FrameLight`, `DEFAULT_FRAME_LIGHT` (Task 3), `frameLight` (Task 3)
- Produces:
  - `paintLayerStack(..., bake = false, light?: FrameLight)`: a new trailing parameter
  - `export function currentFrameLight(): FrameLight`: the light for the paint in progress, which the finish dispatch reads
  - `FrameVariant.light?: FrameLight`

- [ ] **Step 1: Write the failing test**

Copy the `stubCtx`, `mkStubCanvas`, `beforeEach` and `rect` helpers from `tests/unit/post-effects-paint.unit.spec.ts` (lines 5-58) into the new file, then:

```ts
import { paintLayerStack, currentFrameLight } from '~/composables/useCompositorLayers'
import { DEFAULT_FRAME_LIGHT } from '~/lib/compositor/frameLight'

describe('paintLayerStack light', () => {
  it('uses the light it is given for the paint in progress', () => {
    const ctx = stubCtx()
    const l = { x: 0.7, y: 0.2, height: 0.4 }
    paintLayerStack(ctx, 20, 20, [], [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, l)
    expect(currentFrameLight()).toEqual(l)
  })
  it('falls back to the default light when a caller passes none (every existing call site)', () => {
    const ctx = stubCtx()
    paintLayerStack(ctx, 20, 20, [], [])
    expect(currentFrameLight()).toEqual(DEFAULT_FRAME_LIGHT)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-light-paint.unit.spec.ts`
Expected: FAIL, because `currentFrameLight` is not exported.

- [ ] **Step 3: Implement in `useCompositorLayers.ts`**

Next to `_fieldCtx`:

```ts
// The Frame's light for the paint in progress (Gold foil / Spot UV read it). Module-global for
// the same reason as `_fieldCtx`: set once per paintLayerStack, read deep inside paintLayer.
let _frameLight: FrameLight = DEFAULT_FRAME_LIGHT
export function currentFrameLight(): FrameLight { return _frameLight }
```

Import `{ DEFAULT_FRAME_LIGHT, type FrameLight } from '~/lib/compositor/frameLight'`. Add the trailing parameter after `bake = false,`:

```ts
  /** The Frame's light (Gold foil / Spot UV). Absent ⇒ DEFAULT_FRAME_LIGHT; no finish ⇒ unread. */
  light?: FrameLight,
```

As the first statement of the body, before the `_fieldCtx` assignment, add `_frameLight = light ?? DEFAULT_FRAME_LIGHT`.

- [ ] **Step 4: Pass the Frame's light at every Frame-rendering call site**

- `CompositorModal.vue`:
  - Add `frameLight, setFrameLight,` to the editor destructure next to `postEffects, setPostEffects,` (:887).
  - The call at :4923 ends `postEffects.value, true))`. Change it to `postEffects.value, true, frameLight.value))`.
  - At :5054, the same change.
  - At :5637 the call ends `postEffects.value))`. Change it to `postEffects.value, false, frameLight.value))`.
- `ArtifactFrameNode.vue` :564 and :866: read the call's current trailing arguments, then append the missing positional arguments up to `bake` using the value the call already implies (`false` if absent), then `editor.frameLight.value`. Keep all existing arguments unchanged.
- `lib/embed/frame/types.ts`: add to `FrameVariant`:
  ```ts
  /** The Frame's light for Gold foil / Spot UV. Absent in older snapshots ⇒ the default light. */
  light?: FrameLight
  ```
  Import the type from `~/lib/compositor/frameLight`.
- `CompositorModal.vue` `webExportVariant()`: add `light: frameLight.value,` to the object.
- `lib/embed/surfaces/frame.ts:377`: the call ends `undefined, v.groups, undefined, true))`. Change it to `undefined, v.groups, undefined, true, v.light))`.
- `useCompositorAgent.ts:170`, `LayoutTile.vue:71`, the thumbnail painter at `useCompositorLayers.ts:6367` and the `pages/dev/frame-embed-harness.vue` calls stay unchanged. They get the default light, which is correct for previews that carry no Frame properties.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd frontend && npx vitest run tests/unit/frame-light-paint.unit.spec.ts tests/unit/post-effects-paint.unit.spec.ts tests/unit/embed-export-poster.unit.spec.ts`
Expected: PASS.

Run: `npx nuxi typecheck 2>&1 | grep -E "useCompositorLayers|CompositorModal|ArtifactFrameNode|embed/frame/types|embed/surfaces/frame"`
Expected: no new errors naming these files, compared with the baseline you took before starting.

- [ ] **Step 6: Commit**

`feat(frame): thread the Frame light into painting and web exports`

---

### Task 5: The finish shaders and pass (GPU)

**Files:**
- Create: `frontend/app/lib/compositor/finishPass.ts`
- Test: `frontend/tests/unit/finish-pass.unit.spec.ts` (create)

**Interfaces:**
- Consumes:
  - `GpuPost`, `GpuUniform` (Task 2)
  - `FrameLight`, `lightWorld` (Task 3)
- Produces:
  - `type FoilMetal = 'gold' | 'silver' | 'rose' | 'copper'`
  - `METALS: Record<FoilMetal, readonly [string, string, string, string]>` (dark to bright), `METAL_LABELS: Record<FoilMetal, string>`
  - `interface FoilDials { metal: FoilMetal; brushed: number; pressed: number }`
  - `interface SpotUvDials { gloss: number; raised: number; varnishOnly: boolean }`
  - `foilUniforms(d: FoilDials, light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform>`
  - `spotUvUniforms(d: SpotUvDials, light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform>`
  - `applyFinish(off: HTMLCanvasElement, kind: 'gold_foil' | 'spot_uv', dials: FoilDials | SpotUvDials, light: FrameLight, scale: number): boolean`. It returns false when it did not run, leaving `off` untouched.
  - `finishAvailable(): boolean`, `finishUnavailableReason(): string`
  - `FOIL_FRAG`, `SPOT_UV_FRAG` (exported for the tests)

**Orientation, measured before:** `GpuPost` uploads with `UNPACK_FLIP_Y`, so in the shader `vUv.y = 1` is the **top** of the image. That is why `lightWorld` flips y (`0.5 - l.y`), and why the world position is `(vUv.x − 0.5, (vUv.y − 0.5)·aspect)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { FOIL_FRAG, SPOT_UV_FRAG, METALS, METAL_LABELS, foilUniforms, spotUvUniforms } from '~/lib/compositor/finishPass'

const light = { x: 0.15, y: 0.1, height: 0.6 }

describe('finish shaders', () => {
  it('are GLSL ES 3.00 and read the layer through uColor', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) {
      expect(f.startsWith('#version 300 es')).toBe(true)
      expect(f).toContain('uniform sampler2D uColor')
    }
  })
  it('declare every uniform their builders send', () => {
    for (const k of Object.keys(foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5 }, light, 100, 125, 2))) expect(FOIL_FRAG).toContain(k)
    for (const k of Object.keys(spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: false }, light, 100, 125, 2))) expect(SPOT_UV_FRAG).toContain(k)
  })
  it('never use a descending smoothstep (undefined in GLSL ES 3.00)', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) {
      for (const m of f.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) expect(+m[1]!).toBeLessThan(+m[2]!)
    }
  })
})

describe('foilUniforms', () => {
  it('sends the metal ramp as four vec3s, dark to bright', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5 }, light, 100, 125, 2) as any
    expect(u.uM0.vec3).toEqual([0x24 / 255, 0x15 / 255, 0x03 / 255])
    expect(u.uM3.vec3).toEqual([1, 0xf1 / 255, 0xc6 / 255])
  })
  it('sends the light in world space with y up, and the Frame aspect', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0, pressed: 0 }, { x: 0.5, y: 0, height: 0 }, 100, 125, 2) as any
    expect(u.uAspect).toBeCloseTo(1.25)
    expect(u.uLight.vec3[1]).toBeCloseTo(0.625)
    expect(u.uScale).toBe(2)
  })
  it('clamps dials to 0..1', () => {
    const u = foilUniforms({ metal: 'silver', brushed: 5, pressed: -1 }, light, 100, 100, 1) as any
    expect(u.uBrushed).toBe(1); expect(u.uPressed).toBe(0)
  })
})

describe('spotUvUniforms', () => {
  it('sends varnish-only as a float flag', () => {
    expect((spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: true }, light, 10, 10, 1) as any).uVarnishOnly).toBe(1)
    expect((spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: false }, light, 10, 10, 1) as any).uVarnishOnly).toBe(0)
  })
})

describe('metals', () => {
  it('offers four, labelled in sentence case', () => {
    expect(Object.keys(METALS)).toEqual(['gold', 'silver', 'rose', 'copper'])
    expect(Object.values(METAL_LABELS)).toEqual(['Gold', 'Silver', 'Rose gold', 'Copper'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/finish-pass.unit.spec.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `finishPass.ts`**

```ts
/**
 * Gold foil and Spot UV — print finishes lit by the Frame's one light (frameLight.ts).
 * Both are GpuPost passes over a layer's device-resolution offscreen: the layer's own alpha is
 * the mask, and a ring of alpha samples gives the pressed-in (foil) or raised (varnish) edge.
 * Look constants come from the Finish proofs prototype
 * (https://claude.ai/artifact/ARWNKLm4DiKuwEjij4bjhq) — tune by eye, one change at a time.
 *
 * Orientation: GpuPost uploads with UNPACK_FLIP_Y, so vUv.y = 1 is the TOP of the image;
 * lightWorld() already flips y to match.
 */
import { GpuPost, type GpuUniform } from './gpuPost'
import { lightWorld, type FrameLight } from './frameLight'

export type FoilMetal = 'gold' | 'silver' | 'rose' | 'copper'
export const METALS: Record<FoilMetal, readonly [string, string, string, string]> = {
  gold:   ['#241503', '#86561a', '#d8a443', '#fff1c6'],
  silver: ['#1a1d22', '#6c737d', '#c8cdd5', '#ffffff'],
  rose:   ['#28120e', '#8f5147', '#dea08d', '#fff0ea'],
  copper: ['#200e05', '#7a3a17', '#d07a3e', '#ffdcbc'],
}
export const METAL_LABELS: Record<FoilMetal, string> = { gold: 'Gold', silver: 'Silver', rose: 'Rose gold', copper: 'Copper' }

export interface FoilDials { metal: FoilMetal; brushed: number; pressed: number }
export interface SpotUvDials { gloss: number; raised: number; varnishOnly: boolean }

const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform vec2 uSize;     // device px
uniform float uScale;   // device px per logical px
uniform float uAspect;  // h / w
uniform vec3 uLight;    // world space, see lightWorld()
const vec3 CAMERA = vec3(0.0, 0.0, 2.6);
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Gradient of the blurred alpha (points INTO the shape), from two rings of 12 samples.
vec2 alphaGrad(vec2 uv, float rPx) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 d = vec2(cos(a), sin(a));
    g += d * (texture(uColor, uv + d * rPx / uSize).a + texture(uColor, uv + d * 0.5 * rPx / uSize).a);
  }
  return g / 12.0;
}
vec3 worldPos(vec2 uv) { return vec3(uv.x - 0.5, (uv.y - 0.5) * uAspect, 0.0); }
`

export const FOIL_FRAG = `${COMMON}
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform vec3 uM3;
uniform float uBrushed;
uniform float uPressed;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.33) return mix(uM0, uM1, t / 0.33);
  if (t < 0.66) return mix(uM1, uM2, (t - 0.33) / 0.33);
  return mix(uM2, uM3, (t - 0.66) / 0.34);
}
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 px = vUv * uSize / uScale;                       // logical px: grain size is resolution-free
  vec2 g = alphaGrad(vUv, 3.0 * uScale);
  float st = vnoise(vec2(px.x * 0.004, px.y * 0.9)) - 0.5;
  float st2 = vnoise(vec2(px.x * 0.02, px.y * 2.3) + 3.0) - 0.5;
  // Pressed in: the surface slopes DOWN into the shape, so the normal leans along +g.
  vec3 N = normalize(vec3(g * uPressed * 1.2 + vec2(0.0, (st * 0.10 + st2 * 0.05) * uBrushed), 1.0));
  vec3 P = worldPos(vUv);
  vec3 V = normalize(CAMERA - P);
  vec3 L = normalize(uLight - P);
  vec3 R = reflect(-V, N);
  float rl = dot(R, L);
  float df = max(dot(N, L), 0.0);
  float t = 0.10 + 0.25 * df * df + 0.55 * smoothstep(0.80, 0.99, rl) + 0.9 * pow(max(rl, 0.0), 140.0)
          + 0.14 * (R.y * 0.5 + 0.5) + (st + st2 * 0.5) * uBrushed * 0.2;
  vec3 c = ramp(t) * (1.0 + max(t - 1.0, 0.0) * 1.5);
  float ero = vnoise(px * 0.45) - 0.5;                  // stamped foil never has a perfect edge
  fragColor = vec4(min(c, vec3(1.0)), smoothstep(0.3, 0.7, src.a + ero * 0.3));
}`

export const SPOT_UV_FRAG = `${COMMON}
uniform float uGloss;
uniform float uRaised;
uniform float uVarnishOnly;
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 g = alphaGrad(vUv, 2.0 * uScale);
  // Raised: the surface slopes UP into the shape, so the normal leans along -g.
  vec3 N = normalize(vec3(-g * uRaised, 1.0));
  vec3 P = worldPos(vUv);
  vec3 V = normalize(CAMERA - P);
  vec3 L = normalize(uLight - P);
  vec3 R = reflect(-V, N);
  float rl = dot(R, L);
  float k = mix(0.10, 0.03, uGloss);
  float box = smoothstep(1.0 - k, 1.0 - k * 0.45, rl);   // the lamp's reflection
  float sharp = pow(max(rl, 0.0), mix(90.0, 1200.0, uGloss));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float shine = box * mix(0.3, 0.85, uGloss) + sharp * 1.3 + fres * 0.2;
  // Edge shading relative to a flat surface, so the coat never dims the layer overall.
  float lit = 1.0 + 0.4 * (max(dot(N, L), 0.0) - max(L.z, 0.0));
  if (uVarnishOnly > 0.5) {
    // Coat only: white where it shines, a faint dark where it deepens; drawn over what is below.
    float lift = clamp(shine, 0.0, 1.0);
    float dk = clamp(0.06 + max(1.0 - lit, 0.0) * 0.5, 0.0, 1.0);
    fragColor = vec4(vec3(lift / max(lift + dk, 1e-4)), max(lift, dk) * src.a);
  } else {
    vec3 wet = pow(src.rgb, vec3(1.15)) * 1.04 * lit;   // varnish deepens the print
    fragColor = vec4(min(wet + vec3(shine), vec3(1.0)), src.a);
  }
}`

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
function hexVec3(hex: string): { vec3: [number, number, number] } {
  const n = parseInt(hex.slice(1), 16)
  return { vec3: [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255] }
}
function shared(light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform> {
  const aspect = h / Math.max(1, w)
  return { uSize: new Float32Array([w, h]), uScale: scale, uAspect: aspect, uLight: { vec3: lightWorld(light, aspect) } }
}

export function foilUniforms(d: FoilDials, light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform> {
  const m = METALS[d.metal] ?? METALS.gold
  return {
    ...shared(light, w, h, scale),
    uM0: hexVec3(m[0]), uM1: hexVec3(m[1]), uM2: hexVec3(m[2]), uM3: hexVec3(m[3]),
    uBrushed: clamp01(d.brushed), uPressed: clamp01(d.pressed),
  }
}

export function spotUvUniforms(d: SpotUvDials, light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform> {
  return { ...shared(light, w, h, scale), uGloss: clamp01(d.gloss), uRaised: clamp01(d.raised), uVarnishOnly: d.varnishOnly ? 1 : 0 }
}

let foilPass: GpuPost | null = null
let uvPass: GpuPost | null = null
const getFoil = () => (foilPass ??= new GpuPost(FOIL_FRAG))
const getUv = () => (uvPass ??= new GpuPost(SPOT_UV_FRAG))

export function finishAvailable(): boolean { return getFoil().available() && getUv().available() }
/** Why finishes cannot draw here — shown in the inspector, never silently substituted. */
export function finishUnavailableReason(): string { return getFoil().unavailableReason() || getUv().unavailableReason() }

/** Run a finish over `off` in place. False = did not run (no WebGL2 / empty) and `off` is untouched,
 *  so the layer draws plain. The result canvas is GpuPost's and is reused, so it is copied now. */
export function applyFinish(
  off: HTMLCanvasElement, kind: 'gold_foil' | 'spot_uv', dials: FoilDials | SpotUvDials, light: FrameLight, scale: number,
): boolean {
  const w = off.width, h = off.height
  if (w < 1 || h < 1) return false
  const out = kind === 'gold_foil'
    ? getFoil().render(off, off, w, h, foilUniforms(dials as FoilDials, light, w, h, scale))
    : getUv().render(off, off, w, h, spotUvUniforms(dials as SpotUvDials, light, w, h, scale))
  if (!out) return false
  const ctx = off.getContext('2d')
  if (!ctx) return false
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(out, 0, 0)
  ctx.restore()
  return true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/finish-pass.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(frame): Gold foil and Spot UV shaders on the GPU stage`

---

### Task 6: Gold foil and Spot UV in the layer effect stack

**Files:**
- Modify: `frontend/app/lib/compositor/effectStack.ts`:
  - interfaces after the recipes (:169-171)
  - `LayerEffect` union (:173-181)
  - `EFFECT_ORDER` (:196)
  - `EFFECT_LABELS`
  - `LOCAL_DEFAULTS` (after `letterpress`, :338)
- Modify: `frontend/app/composables/useCompositorLayers.ts`: the body-pass switch (:3199-3227)
- Test: `frontend/tests/unit/finish-effects.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `applyFinish`, `FoilMetal` (Task 5), `currentFrameLight` / `_frameLight` (Task 4)
- Produces:
  - `interface GoldFoilEffect { type: 'gold_foil'; visible: boolean; metal: FoilMetal; brushed: number; pressed: number }`
  - `interface SpotUvEffect { type: 'spot_uv'; visible: boolean; gloss: number; raised: number; varnishOnly: boolean }`
  - Kinds `'gold_foil'` and `'spot_uv'`, in that order, right after `'letterpress'`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createEffect, EFFECT_ORDER, EFFECT_LABELS, regionOf } from '~/lib/compositor/effectStack'
import { applyCompositorCommand } from '~/lib/agent/surfaces/compositor'

describe('finish effects in the stack', () => {
  it('sit right after letterpress, foil then spot UV, in the pixel region', () => {
    const o = EFFECT_ORDER as readonly string[]
    expect(o.indexOf('gold_foil')).toBe(o.indexOf('letterpress') + 1)
    expect(o.indexOf('spot_uv')).toBe(o.indexOf('gold_foil') + 1)
    expect(regionOf('gold_foil')).toBe('pixel')
    expect(regionOf('spot_uv')).toBe('pixel')
  })
  it('are labelled in sentence case', () => {
    expect(EFFECT_LABELS.gold_foil).toBe('Gold foil')
    expect(EFFECT_LABELS.spot_uv).toBe('Spot UV')
  })
  it('start from the prototype look', () => {
    expect(createEffect('gold_foil')).toMatchObject({ type: 'gold_foil', metal: 'gold', brushed: 0.5, pressed: 0.5, visible: true })
    expect(createEffect('spot_uv')).toMatchObject({ type: 'spot_uv', gloss: 0.75, raised: 0.5, varnishOnly: false, visible: true })
  })
})
```

Add the agent check to `frontend/tests/unit/agent-compositor-surface.unit.spec.ts`, next to the F7 recipe tests. Use the file's existing `rectState()` helper:

```ts
  it('does not offer the print finishes to the agent (picker only, hint budget unchanged)', () => {
    for (const type of ['gold_foil', 'spot_uv']) {
      const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type } } })
      expect(r.ok).toBe(false)
    }
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/finish-effects.unit.spec.ts tests/unit/agent-compositor-surface.unit.spec.ts`
Expected: FAIL on the new stack tests. The agent test may already pass, since neither type is in `POST_EFFECT_DEFAULTS`. That's fine, because it pins the behaviour.

- [ ] **Step 3: Implement in `effectStack.ts`**

After `LetterpressEffect`:

```ts
// ── Print finishes: lit by the Frame's one light (frameLight.ts); the layer is the mask ──
export interface GoldFoilEffect { type: 'gold_foil'; visible: boolean; metal: FoilMetal; brushed: number; pressed: number }
export interface SpotUvEffect   { type: 'spot_uv';   visible: boolean; gloss: number; raised: number; varnishOnly: boolean }
```

- Import `type { FoilMetal } from './finishPass'`.
- Add `| GoldFoilEffect | SpotUvEffect` to `LayerEffect`, on the recipes line.
- In `EFFECT_ORDER`, insert `'gold_foil', 'spot_uv',` right after `'letterpress',`.
- In `EFFECT_LABELS`, add `gold_foil: 'Gold foil', spot_uv: 'Spot UV',`.
- In `LOCAL_DEFAULTS`, after `letterpress`:
  ```ts
  // Print finishes: the Finish proofs prototype's opening look.
  gold_foil: { metal: 'gold', brushed: 0.5, pressed: 0.5, visible: true },
  spot_uv:   { gloss: 0.75, raised: 0.5, varnishOnly: false, visible: true },
  ```

- [ ] **Step 4: Dispatch in `useCompositorLayers.ts`**

Import `{ applyFinish }` from `~/lib/compositor/finishPass` and the two effect types. In the body-pass switch, before `default:`:

```ts
              // Print finishes: GPU passes lit by the Frame's light; the layer's alpha is the mask.
              // No WebGL2 ⇒ applyFinish returns false and off stays the plain layer (the inspector
              // says why). Needs its own case: applyPasses silently skips unknown kinds.
              case 'gold_foil':
              case 'spot_uv':
                applyFinish(off, e.type, e as unknown as GoldFoilEffect | SpotUvEffect, _frameLight, s); break
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd frontend && npx vitest run tests/unit/finish-effects.unit.spec.ts tests/unit/agent-compositor-surface.unit.spec.ts tests/unit/compositor-effect-stack.unit.spec.ts tests/unit/compositor-recipes.unit.spec.ts`
Expected: PASS. If a test pins the full `EFFECT_ORDER`, add the two kinds after `letterpress` there.

Run: `npx nuxi typecheck 2>&1 | grep -E "effectStack|useCompositorLayers|finishPass"`
Expected: no new errors. Watch for exhaustive switches over `EffectKind` elsewhere; the compiler names them.

- [ ] **Step 6: Commit**

`feat(frame): Gold foil and Spot UV join the layer effect stack`

---

### Task 7: Inspectors, light presets and the light handle

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/FinishLightControl.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`:
  - inspector branches after `letterpress` (~:10529)
  - the handle next to the Distort handles (~:8956)
  - the handler next to `onDistortPointerDown` (~:2152)
- Test: `frontend/tests/unit/finish-light-control.unit.spec.ts` (create)

**Interfaces:**
- Consumes:
  - `frameLight`, `setFrameLight` (Task 3, destructured in Task 4)
  - `LIGHT_PRESETS`, `LIGHT_PRESET_LABELS`, `presetOf` (Task 3)
  - `METALS`, `METAL_LABELS`, `finishAvailable`, `finishUnavailableReason` (Task 5)
- Produces:
  - `<FinishLightControl :light="FrameLight" @update="(l: FrameLight) => …" />`
  - data-testids: `finish-light-preset`, `frame-light-handle`, `foil-metal`, `foil-brushed`, `foil-pressed`, `uv-gloss`, `uv-raised`, `uv-varnish-only`

- [ ] **Step 1: Write the failing component test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FinishLightControl from '~/components/vue-canvas/compositor/FinishLightControl.vue'
import { LIGHT_PRESETS, DEFAULT_FRAME_LIGHT } from '~/lib/compositor/frameLight'

describe('FinishLightControl', () => {
  it('shows the four presets by name', () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    for (const label of ['Top left', 'Top right', 'Overhead', 'Raking']) expect(w.text()).toContain(label)
  })
  it('emits the preset light when one is picked', async () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    const raking = w.findAll('button').find(b => b.text() === 'Raking')!
    await raking.trigger('click')
    expect(w.emitted('update')![0]).toEqual([LIGHT_PRESETS.raking])
  })
  it('explains the handle', () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    expect(w.text()).toContain('Drag the light on the canvas')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/finish-light-control.unit.spec.ts`
Expected: FAIL, because the component is not found.

- [ ] **Step 3: Implement `FinishLightControl.vue`**

Before writing it, read `StudioSegmented.vue` (it uses `v-model` via `defineModel`, plus `options` and `optionLabels`) and match how `CompositorModal.vue` imports studio components.

```vue
<script setup lang="ts">
// The Frame's one light, as seen from a finish's inspector: four presets plus a pointer to the
// on-canvas handle. Shared by Gold foil and Spot UV so the two never drift.
import { computed } from 'vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import { LIGHT_PRESETS, LIGHT_PRESET_LABELS, presetOf, type FrameLight, type LightPreset } from '~/lib/compositor/frameLight'

const props = defineProps<{ light: FrameLight }>()
const emit = defineEmits<{ update: [light: FrameLight] }>()
const keys = Object.keys(LIGHT_PRESETS) as LightPreset[]
const current = computed<string>({
  get: () => presetOf(props.light) ?? '',
  set: (k: string) => { const p = LIGHT_PRESETS[k as LightPreset]; if (p) emit('update', { ...p }) },
})
</script>

<template>
  <div class="space-y-1" data-testid="finish-light-preset">
    <p class="text-xs text-white/50">Light</p>
    <StudioSegmented v-model="current" :options="keys" :option-labels="keys.map(k => LIGHT_PRESET_LABELS[k])" />
    <p class="text-[11px] text-white/40">Drag the light on the canvas to move it. Every finish on this Frame shares it.</p>
  </div>
</template>
```

- [ ] **Step 4: Run the component test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/finish-light-control.unit.spec.ts`
Expected: PASS. If `StudioSegmented` renders something other than `<button>`, adjust the test's finder to that element. The behaviour is the contract, not the tag.

- [ ] **Step 5: Add the inspectors in `CompositorModal.vue`**

After the letterpress `v-else-if` block, following its markup exactly (`StudioSlider`, `updateActiveEffect`):

```html
          <!-- Print finish · Gold foil: metal stamped into the card, lit by the Frame's light. -->
          <div v-else-if="activeEffect!.type === 'gold_foil'" class="space-y-1.5">
            <p class="text-xs text-white/50">Metal foil stamped into the card. It catches the Frame's light.</p>
            <p v-if="!finishAvailable()" class="text-xs text-amber-300/80">{{ finishUnavailableReason() }}</p>
            <StudioSegmented
              data-testid="foil-metal"
              :model-value="(activeEffect as any).metal ?? 'gold'"
              :options="Object.keys(METALS)"
              :option-labels="Object.keys(METALS).map(k => METAL_LABELS[k as FoilMetal])"
              @update:model-value="(v: string) => updateActiveEffect({ metal: v })"
            />
            <StudioSlider data-testid="foil-brushed" label="Brushed" :min="0" :max="1" :step="0.01" :default="0.5"
              :model-value="(activeEffect as any).brushed ?? 0.5"
              @update:model-value="(v: number) => updateActiveEffect({ brushed: v })" />
            <StudioSlider data-testid="foil-pressed" label="Pressed in" :min="0" :max="1" :step="0.01" :default="0.5"
              :model-value="(activeEffect as any).pressed ?? 0.5"
              @update:model-value="(v: number) => updateActiveEffect({ pressed: v })" />
            <FinishLightControl :light="frameLight" @update="(l: FrameLight) => setFrameLight(l)" />
          </div>

          <!-- Print finish · Spot UV: a clear gloss coat; shows only where the light reflects. -->
          <div v-else-if="activeEffect!.type === 'spot_uv'" class="space-y-1.5">
            <p class="text-xs text-white/50">A clear gloss varnish. It shows where the light reflects off it.</p>
            <p v-if="!finishAvailable()" class="text-xs text-amber-300/80">{{ finishUnavailableReason() }}</p>
            <StudioSlider data-testid="uv-gloss" label="Gloss" :min="0" :max="1" :step="0.01" :default="0.75"
              :model-value="(activeEffect as any).gloss ?? 0.75"
              @update:model-value="(v: number) => updateActiveEffect({ gloss: v })" />
            <StudioSlider data-testid="uv-raised" label="Raised" :min="0" :max="1" :step="0.01" :default="0.5"
              :model-value="(activeEffect as any).raised ?? 0.5"
              @update:model-value="(v: number) => updateActiveEffect({ raised: v })" />
            <StudioSwitch data-testid="uv-varnish-only" label="Varnish only"
              :model-value="(activeEffect as any).varnishOnly ?? false"
              @update:model-value="(v: boolean) => updateActiveEffect({ varnishOnly: v })" />
            <p class="text-[11px] text-white/40">Varnish only hides the layer's colours and leaves just the clear coat.</p>
            <FinishLightControl :light="frameLight" @update="(l: FrameLight) => setFrameLight(l)" />
          </div>
```

Import:
- `FinishLightControl`
- `StudioSegmented` and `StudioSwitch`, if not already imported
- `{ METALS, METAL_LABELS, finishAvailable, finishUnavailableReason, type FoilMetal }` from `~/lib/compositor/finishPass`
- `type FrameLight`

Read `StudioSwitch.vue` first and use its real prop for the label. If it has no `label` prop, wrap it in a row that has the text "Varnish only".

- [ ] **Step 6: Add the light handle**

Next to `onDistortPointerDown`:

```ts
/** The Frame light's on-canvas handle — shown while a Gold foil or Spot UV effect is selected. */
const finishEffectSelected = computed(() => activeEffect.value?.type === 'gold_foil' || activeEffect.value?.type === 'spot_uv')
const lightHandlePos = computed(() => ({ x: frameLight.value.x * canvasDisplay.w, y: frameLight.value.y * canvasDisplay.h }))
function onLightPointerDown(e: PointerEvent) {
  if (viewOnlyGuard()) return
  e.preventDefault(); e.stopPropagation()
  const r = canvasRect(); if (!r) return
  recordHistory()                                   // one undo step for the whole drag
  const height = frameLight.value.height
  const move = (ev: PointerEvent) => setFrameLight({
    x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height, height,
  }, false)
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
```

In the template, right after the Distort handles `<template>` (~:8965):

```html
        <div
          v-if="finishEffectSelected && !editingId && !genActive"
          data-handle
          data-testid="frame-light-handle"
          aria-label="Light"
          title="Drag to move the light"
          class="absolute z-20 size-5 rounded-full bg-amber-100 border-2 border-[#0a0a0a] cursor-grab shadow-[0_0_14px_4px_rgba(255,214,140,0.55)]"
          :style="{ left: lightHandlePos.x + 'px', top: lightHandlePos.y + 'px', transform: 'translate(-50%, -50%)' }"
          @pointerdown="onLightPointerDown"
        />
```

Check that the canvas repaints when `frameLight` changes. `renderStack` must be triggered by the light, as it is by `postEffects`. Find the watcher that repaints on `postEffects` (grep for `postEffects` near `renderStack`) and add `frameLight` to the same watch source.

- [ ] **Step 7: Typecheck and run the unit tests**

Run: `cd frontend && npx nuxi typecheck 2>&1 | grep -E "CompositorModal|FinishLightControl"` and `npx vitest run tests/unit/finish-light-control.unit.spec.ts tests/unit/compositor-effect-inspector.unit.spec.ts`
Expected: no new errors naming these files, and the tests pass.

- [ ] **Step 8: Commit**

`feat(frame): Gold foil and Spot UV inspectors, light presets and the on-canvas light handle`

---

### Task 8: Browser verification, look check and cost measurement

This task runs in the browser pane, against the **existing** main-checkout dev server. Do not start one. If it is broken, stop and report back.

**Files:**
- Create: `frontend/tests/print-finishes.spec.ts` (Playwright, modelled on `tests/compositor-layer-effects.spec.ts`)
- Modify: `docs/superpowers/specs/2026-09-24-print-finishes-design.md`: append a "Findings" section

- [ ] **Step 1: Find the server and prove which checkout it serves**

Run: `lsof -nP -iTCP -sTCP:LISTEN | grep node`, then `lsof -a -p <pid> -d cwd` for each.
Expected: one server whose cwd is `/Users/julien/Documents/GitHub/Sailor/frontend`. Use `127.0.0.1`, not `localhost`. Also check `curl -s 127.0.0.1:8188/system_stats`. ComfyUI being down does not block this task.

- [ ] **Step 2: Seed a Frame and look at it**

- Open a Frame in the editor.
- Using the dev hook `window.__compositorSetLayers(layers)` (see `tests/compositor-layer-effects.spec.ts` for its use), seed:
  - a dark green rect background
  - a large serif text layer with a `gold_foil` effect
  - an image layer with `spot_uv`
  - a ring-pattern shape with `spot_uv` and `varnishOnly: true`
- Add Halation at 0.7 in Post-processing.
- Screenshot at each of the four light presets.
- Compare against the prototype by eye. Foil must read as metal, not as yellow paint, and the highlight must move with the preset. Varnish-only must be invisible except where the light reflects. Halation must fringe red around the brights.
- Send the four screenshots with SendUserFile.

- [ ] **Step 3: Check the handle and undo**

Select the foil effect. Using real pointer input with coordinates from `read_page` refs (not synthetic events), drag `frame-light-handle` across the canvas. The highlight should follow. One undo should restore the previous light.

- [ ] **Step 4: Check that absent means unchanged**

Open an existing Frame with no finishes. Export a PNG before and after this plan's commits and compare. For "before", use `git show <base>:<file>` copies under `app/lib/compositor/`, following the in-place A/B recipe in memory `frame-layer-effect-stack-landed`. Otherwise, confirm by reasoning that every new branch is keyed on a present effect, and say which method you used.

- [ ] **Step 5: Measure the cost**

- Set up a 1080×1350 Frame with three `gold_foil` text layers.
- Drag an unrelated layer and record `performance.now()` around `renderStack` for 60 frames (a temporary console timer, removed after).
- Report the median and p95.
- If p95 is over 33 ms, stop and report. The spec's at-rest cache becomes the next task. Do not add it speculatively.

- [ ] **Step 6: Exports**

- Render a PNG with the finishes and confirm they're present.
- Build a web export and run its live check. Confirm the finishes appear and use the placed light.
- List every Frame export path. For each, say whether it paints in the browser (with finishes) or elsewhere (without). Append this list, with the measurements, under "Findings" in the spec.

- [ ] **Step 7: Write the Playwright spec**

Put the seeding from Step 2 into `frontend/tests/print-finishes.spec.ts`. Assert that the pixel colour under the foil text changes between the `Top left` and `Raking` presets, and that the `frame-light-handle` appears only while a finish effect is selected. Run it only against the existing server (`npx playwright test tests/print-finishes.spec.ts`, pointed at that server's port as the other specs are).

- [ ] **Step 8: Commit** (the Playwright spec and the spec's Findings)

`test(frame): print finishes — browser checks, exports, cost measured`

---

## After this plan

- Tune the looks with the user against the prototype (anchor rule: last accepted render as base, one change at a time).
- Then write **Plan B**: *Shine* as a Frame-level motion track (`frame.light.x/y`), and *Follow the pointer* in web exports (`setLight` on the handle contract, a pointer and touch listener in `lib/embed/bundle.ts`, liveCheck coverage).
