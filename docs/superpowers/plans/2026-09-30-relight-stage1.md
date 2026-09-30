# Relight stage 1: live lights as a layer effect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free, live **Relight** effect to image layers in the Frame editor: glowing light dots on the layer that you drag, and the photo relights as you move them. It uses the free local depth map only.

**Architecture:** A shared engine in `frontend/app/lib/relight/` (settings, presets, a float depth field, a GPU pass) and a new pinned GPU effect kind `relight` that runs in the same offscreen step as depth of field (`dof`), before it. The Frame editor gets a settings panel (`RelightControls.vue`), on-canvas light handles, and a right-click **Relight…** entry.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, WebGL2 through the existing `GpuPost` class, Vitest (`tests/unit/*.unit.spec.ts`), Playwright (`tests/*.spec.ts`), pnpm.

**Spec:** `docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md` (commit `ff8d72c25`). Read its "How it works for the user" and "Shader" sections before starting.
**Look targets:** mockup https://claude.ai/artifact/7rAD2Mu5a2S5d34kHU42iy (layout, controls, presets) and the uncommitted prototype `frontend/app/pages/dev/relight.vue` (shader; open `http://127.0.0.1:3002/dev/relight?img=flux_lora_00165_.png`).

## Global Constraints

- **Stage 1 makes no paid calls.** No MoGe-2, no Nano Banana, no fal. Local depth (`POST /api/depth/estimate`) only.
- **Out of stage 1:** Finish, MoGe surfaces, the *Reading shape* swap, *Use Frame light*, Motion dials for the lights, the node. The old `RelightNode` is **parked**: do not touch it or `server/runner/generators/relight.ts`.
- UI copy: sentence case, no identifiers, explanations only as tooltips (`title` / `StudioHint`), never as small text in the panel.
- Labels, exactly: effect **Relight**; right-click **Relight…**; setups **Window**, **Golden key**, **Rim**, **Neon**, **Under**; photo controls **Original light**, **Depth**, **Texture**, **Shine**, **Shadows**; per light **Brightness**, **Height**, **Reach**, plus the colour swatches **Warm**, **Tungsten**, **Daylight**, **Blue hour**, **Magenta**, **Cyan** and **Any colour**.
- Limits: at most **3** lights; light x and y are fractions of the **layer** in −0.4…1.4; height is −0.3…1 (below 0 means behind the subject).
- Defaults: a new Relight effect starts from **Golden key**. Photo defaults: Depth 4, Texture 2, Shine 0, Shadows on.
- Image and wired layers only (wired parity rule). At most one Relight per layer (pinned kind).
- Unit tests: `cd frontend && pnpm vitest run tests/unit/<file>`. **This project is pnpm, not npm.**
- Playwright needs the dev server on `:3002` and ComfyUI on `:8188`, both already running. **Never start, stop or restart a dev server from a task.** If `:3002` is broken, stop and report.
- **Committing in this checkout.** Several sessions share it, and the git index is shared. Commit every task with a private index and a compare-and-swap, and never `git add` into the shared index:

  ```bash
  cd /Users/julien/Documents/GitHub/Sailor
  IDX=$(mktemp /private/tmp/claude-501/relight-idx.XXXXXX); rm -f "$IDX"
  OLD=$(git rev-parse HEAD)
  GIT_INDEX_FILE=$IDX git read-tree "$OLD"
  GIT_INDEX_FILE=$IDX git add -- <exact paths of this task>
  GIT_INDEX_FILE=$IDX git diff --cached --stat "$OLD"   # must list ONLY this task's files
  TREE=$(GIT_INDEX_FILE=$IDX git write-tree)
  NEW=$(git commit-tree "$TREE" -p "$OLD" -m "<message>

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")
  git update-ref HEAD "$NEW" "$OLD"     # fails if HEAD moved: re-run from OLD=… , never force
  ```

  Then, in a **separate** Bash call (so `GIT_INDEX_FILE` is unset): `git reset -q -- <the same paths>`. Prove it with `[ "$(git rev-parse HEAD:<path>)" = "$(git hash-object <path>)" ]` for each file. Never `cp .git/index`, never `git stash`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `frontend/app/lib/relight/settings.ts` | create | `RelightEffect` shape, defaults, sanitizer, light ids |
| `frontend/app/lib/relight/presets.ts` | create | The five setups, apply, and "which setup is this?" |
| `frontend/app/lib/relight/depthField.ts` | create | 8-bit depth → smoothed, photo-guided float field (pure) + a small cache |
| `frontend/app/lib/relight/relightPass.ts` | create | `RELIGHT_FRAG`, light packing, `applyRelight`, availability, run counter |
| `frontend/app/lib/compositor/gpuPost.ts` | modify | Accept a float depth field as well as an image |
| `frontend/app/lib/compositor/effectStack.ts` | modify | Register the `relight` kind |
| `frontend/app/lib/compositor/postEffects.ts` | modify | `GPU_TYPES` includes `relight` |
| `frontend/app/lib/compositor/effectDials.ts` | modify | Empty dial list for `relight` (stage 4 fills it) |
| `frontend/app/lib/agent/surfaces/compositor.ts` | modify | The agent refuses `relight` by name |
| `frontend/app/lib/embed/frame/plan.ts` | modify | Web export: *left out* notice for Relight |
| `frontend/app/composables/useCompositorLayers.ts` | modify | Run relight in the paint step, the Compare bypass, wired draw |
| `frontend/app/composables/useWiredTreatments.ts` | modify | `relight` treatment for wired slots |
| `frontend/app/components/vue-canvas/compositor/RelightControls.vue` | create | The settings panel |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | modify | Panel wiring, handles, double-click, wheel, dim overlay, right-click entry |
| `frontend/tests/unit/relight-settings.unit.spec.ts` | create | |
| `frontend/tests/unit/relight-depth-field.unit.spec.ts` | create | |
| `frontend/tests/unit/relight-pass.unit.spec.ts` | create | |
| `frontend/tests/unit/relight-controls.unit.spec.ts` | create | |
| `frontend/tests/relight-effect.spec.ts` | create | Browser check |

---

### Task 1: Settings and presets

**Files:**
- Create: `frontend/app/lib/relight/settings.ts`, `frontend/app/lib/relight/presets.ts`
- Test: `frontend/tests/unit/relight-settings.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RelightLight { id: string; x: number; y: number; height: number; color: string; brightness: number; reach: number; on: boolean }`
  - `interface RelightEffect { type: 'relight'; visible: boolean; lights: RelightLight[]; keep: number; depth: number; texture: number; shine: number; shadows: boolean }`
  - `RELIGHT_MAX_LIGHTS = 3`
  - `newLightId(): string`
  - `defaultRelightSettings(): Omit<RelightEffect, 'type' | 'visible'>` (a fresh object every call, starting from Golden key)
  - `sanitizeRelight(raw: unknown): RelightEffect`
  - `RELIGHT_SETUP_NAMES: readonly RelightSetupName[]`, `type RelightSetupName = 'Window' | 'Golden key' | 'Rim' | 'Neon' | 'Under'`
  - `applySetup(fx: RelightEffect, name: RelightSetupName): RelightEffect`
  - `setupOf(fx: RelightEffect): RelightSetupName | null`
  - `RELIGHT_SWATCHES: readonly { label: string; color: string }[]`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/relight-settings.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { defaultRelightSettings, sanitizeRelight, RELIGHT_MAX_LIGHTS, newLightId, RELIGHT_SWATCHES } from '~/lib/relight/settings'
import { applySetup, setupOf, RELIGHT_SETUP_NAMES } from '~/lib/relight/presets'

const fx = () => sanitizeRelight({ type: 'relight', visible: true, ...defaultRelightSettings() })

describe('relight settings', () => {
  it('starts from Golden key with the photo defaults', () => {
    const f = fx()
    expect(setupOf(f)).toBe('Golden key')
    expect(f).toMatchObject({ depth: 4, texture: 2, shine: 0, shadows: true, keep: 0.12 })
    expect(f.lights).toHaveLength(1)
  })
  it('gives a fresh object every call (no shared lights array)', () => {
    const a = defaultRelightSettings(), b = defaultRelightSettings()
    expect(a.lights).not.toBe(b.lights)
    expect(a.lights[0]).not.toBe(b.lights[0])
  })
  it('clamps, caps at three lights, and fills gaps', () => {
    const l = { x: 9, y: -9, height: 5, color: 'nope', brightness: -1, reach: 0, on: 'yes' }
    const f = sanitizeRelight({ lights: [l, l, l, l, l], keep: 7, depth: -3, texture: 99, shine: 2, shadows: 'x' })
    expect(f.lights).toHaveLength(RELIGHT_MAX_LIGHTS)
    expect(f.lights[0]).toMatchObject({ x: 1.4, y: -0.4, height: 1, color: '#ffffff', brightness: 0, reach: 0.1, on: true })
    expect(f.lights[0]!.id).toMatch(/\S/)
    expect(f).toMatchObject({ type: 'relight', visible: true, keep: 1, depth: 0, texture: 8, shine: 1, shadows: true })
  })
  it('reads junk as the default effect', () => {
    expect(setupOf(sanitizeRelight(null))).toBe('Golden key')
  })
  it('makes unique light ids', () => {
    expect(new Set(Array.from({ length: 50 }, newLightId)).size).toBe(50)
  })
  it('has the six swatches by name', () => {
    expect(RELIGHT_SWATCHES.map(s => s.label)).toEqual(['Warm', 'Tungsten', 'Daylight', 'Blue hour', 'Magenta', 'Cyan'])
  })
})

describe('relight setups', () => {
  it('lists the five setups in order', () => {
    expect(RELIGHT_SETUP_NAMES).toEqual(['Window', 'Golden key', 'Rim', 'Neon', 'Under'])
  })
  it('applies a setup and recognises it, ignoring light ids', () => {
    for (const name of RELIGHT_SETUP_NAMES) expect(setupOf(applySetup(fx(), name))).toBe(name)
  })
  it('keeps the photo controls when a setup is applied', () => {
    const f = { ...fx(), depth: 9, texture: 1, shine: 0.5, shadows: false }
    expect(applySetup(f, 'Neon')).toMatchObject({ depth: 9, texture: 1, shine: 0.5, shadows: false })
  })
  it('stops recognising a setup once a light moves', () => {
    const f = applySetup(fx(), 'Rim')
    f.lights[0]!.x += 0.05
    expect(setupOf(f)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/relight-settings.unit.spec.ts`
Expected: FAIL, `Failed to resolve import "~/lib/relight/settings"`.

- [ ] **Step 3: Write `settings.ts`**

```ts
// frontend/app/lib/relight/settings.ts
/**
 * Relight: the stored shape of the effect. Positions are fractions of the LAYER (0,0 = its
 * top left), not of the Frame, and may sit past its edges because a light can be outside the
 * picture. Height below 0 puts the light behind the subject (rim light).
 * Spec: docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md
 */
export interface RelightLight {
  id: string
  x: number
  y: number
  height: number
  color: string
  brightness: number
  reach: number
  on: boolean
}

export interface RelightEffect {
  type: 'relight'
  visible: boolean
  lights: RelightLight[]
  /** Original light: how much of the photo's own lighting stays as the base level. */
  keep: number
  /** Depth: how strongly the photo's shape bends the light. */
  depth: number
  /** Texture: fine relief taken from the photo itself. */
  texture: number
  /** Shine: glossy highlights. */
  shine: number
  /** Shadows: short contact shadows. */
  shadows: boolean
}

export const RELIGHT_MAX_LIGHTS = 3

export const RELIGHT_SWATCHES: readonly { label: string; color: string }[] = [
  { label: 'Warm', color: '#ffcf94' },
  { label: 'Tungsten', color: '#ffb36b' },
  { label: 'Daylight', color: '#f4f7ff' },
  { label: 'Blue hour', color: '#9cc4ff' },
  { label: 'Magenta', color: '#ff3fb4' },
  { label: 'Cyan', color: '#29d8ff' },
]

let lightCounter = 0
export function newLightId(): string {
  return `lt_${Math.random().toString(36).slice(2, 8)}_${++lightCounter}`
}

const num = (v: unknown, lo: number, hi: number, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb
const hex = (v: unknown, fb: string): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fb

export function sanitizeLight(raw: unknown): RelightLight {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newLightId(),
    x: num(r.x, -0.4, 1.4, 0.5),
    y: num(r.y, -0.4, 1.4, 0.3),
    height: num(r.height, -0.3, 1, 0.35),
    color: hex(r.color, '#ffffff'),
    brightness: num(r.brightness, 0, 4, 1.4),
    reach: num(r.reach, 0.1, 2, 1),
    on: r.on !== false,
  }
}

// Golden key, inlined rather than imported from presets.ts to keep the two modules acyclic.
// presets.ts owns the table; a unit test pins that this default equals applySetup(…, 'Golden key').
export function defaultRelightSettings(): Omit<RelightEffect, 'type' | 'visible'> {
  return {
    lights: [{ id: newLightId(), x: 0.85, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 3.2, reach: 1.4, on: true }],
    keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true,
  }
}

export function sanitizeRelight(raw: unknown): RelightEffect {
  if (!raw || typeof raw !== 'object') return { type: 'relight', visible: true, ...defaultRelightSettings() }
  const r = raw as Record<string, unknown>
  const d = defaultRelightSettings()
  const lights = Array.isArray(r.lights) ? r.lights.slice(0, RELIGHT_MAX_LIGHTS).map(sanitizeLight) : d.lights
  return {
    type: 'relight',
    visible: r.visible !== false,
    lights,
    keep: num(r.keep, 0, 1, d.keep),
    depth: num(r.depth, 0, 20, d.depth),
    texture: num(r.texture, 0, 8, d.texture),
    shine: num(r.shine, 0, 1, d.shine),
    shadows: typeof r.shadows === 'boolean' ? r.shadows : d.shadows,
  }
}
```

- [ ] **Step 4: Write `presets.ts`**

```ts
// frontend/app/lib/relight/presets.ts
/** The five one-click setups. Values are the mockup's (artifact 7rAD2Mu5a2S5d34kHU42iy). */
import { newLightId, type RelightEffect, type RelightLight } from './settings'

export type RelightSetupName = 'Window' | 'Golden key' | 'Rim' | 'Neon' | 'Under'
type LightSpec = Omit<RelightLight, 'id' | 'on'>

const SETUPS: Record<RelightSetupName, { keep: number; lights: LightSpec[] }> = {
  'Window': { keep: 0.3, lights: [{ x: -0.05, y: 0.25, height: 0.3, color: '#fff1dc', brightness: 1.8, reach: 1.2 }] },
  'Golden key': { keep: 0.12, lights: [{ x: 0.85, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 3.2, reach: 1.4 }] },
  'Rim': { keep: 0.2, lights: [
    { x: 0.95, y: 0.2, height: -0.05, color: '#bcd8ff', brightness: 2.6, reach: 0.8 },
    { x: 0.15, y: 0.4, height: 0.4, color: '#ffe2c0', brightness: 0.6, reach: 1.2 },
  ] },
  'Neon': { keep: 0.15, lights: [
    { x: 0.05, y: 0.5, height: 0.35, color: '#ff3fb4', brightness: 2.2, reach: 0.8 },
    { x: 0.95, y: 0.45, height: 0.35, color: '#29d8ff', brightness: 2.2, reach: 0.8 },
  ] },
  'Under': { keep: 0.2, lights: [{ x: 0.5, y: 1.05, height: 0.25, color: '#ffb36b', brightness: 2.2, reach: 0.9 }] },
}

export const RELIGHT_SETUP_NAMES: readonly RelightSetupName[] = ['Window', 'Golden key', 'Rim', 'Neon', 'Under']

/** Replaces the lights and Original light; the photo controls (Depth, Texture, Shine, Shadows) stay. */
export function applySetup(fx: RelightEffect, name: RelightSetupName): RelightEffect {
  const s = SETUPS[name]
  return { ...fx, keep: s.keep, lights: s.lights.map(l => ({ ...l, id: newLightId(), on: true })) }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-3

/** The setup these settings still match exactly (ids ignored), or null once anything moved. */
export function setupOf(fx: RelightEffect): RelightSetupName | null {
  for (const name of RELIGHT_SETUP_NAMES) {
    const s = SETUPS[name]
    if (!close(fx.keep, s.keep) || fx.lights.length !== s.lights.length) continue
    const same = s.lights.every((l, i) => {
      const f = fx.lights[i]!
      return f.on && close(f.x, l.x) && close(f.y, l.y) && close(f.height, l.height)
        && f.color === l.color && close(f.brightness, l.brightness) && close(f.reach, l.reach)
    })
    if (same) return name
  }
  return null
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run tests/unit/relight-settings.unit.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit** with the recipe in Global Constraints. Paths: `frontend/app/lib/relight/settings.ts frontend/app/lib/relight/presets.ts frontend/tests/unit/relight-settings.unit.spec.ts`. Message: `feat(relight): settings and the five setups for the Relight effect (stage 1)`.

---

### Task 2: The depth field

The depth PNG is 8-bit and coarser than the photo. Lit as it is, it gives contour stripes, a halo round the subject and stair-stepped edges (spec, *Shader*). This task turns it into a smooth float field once per image, on the CPU, and caches it.

**Files:**
- Create: `frontend/app/lib/relight/depthField.ts`
- Test: `frontend/tests/unit/relight-depth-field.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface FloatDepth { kind: 'float'; width: number; height: number; data: Float32Array }`, where `data` rows are in **GL order (bottom row first)**, ready for upload with `UNPACK_FLIP_Y_WEBGL` off.
  - `depthToFloat(rgba: Uint8ClampedArray, w: number, h: number): Float32Array` (top-down rows, red channel / 255)
  - `bilateralSmooth(src: Float32Array, w: number, h: number, radius: number, sigma: number): Float32Array`
  - `jointUpsample(depth: Float32Array, dw: number, dh: number, guide: Uint8ClampedArray, gw: number, gh: number): Float32Array` (returns gw×gh, top-down)
  - `toGlRows(src: Float32Array, w: number, h: number): Float32Array`
  - `buildDepthField(depthRgba: Uint8ClampedArray, dw: number, dh: number, guideRgba: Uint8ClampedArray, gw: number, gh: number): FloatDepth`
  - `relightDepthFieldFor(key: string, depth: CanvasImageSource & { width?: number; height?: number }, guide: HTMLCanvasElement): FloatDepth | null` (browser-only, cached by key, at most 8 entries)
  - `__resetRelightDepthFields(): void`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/relight-depth-field.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { depthToFloat, bilateralSmooth, jointUpsample, toGlRows, buildDepthField } from '~/lib/relight/depthField'

const rgba = (w: number, h: number, f: (x: number, y: number) => number) => {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); const i = (y * w + x) * 4; a[i] = v; a[i + 1] = v; a[i + 2] = v; a[i + 3] = 255 }
  return a
}

describe('relight depth field', () => {
  it('reads the red channel as 0..1, top row first', () => {
    const d = depthToFloat(rgba(2, 2, (x, y) => (y === 0 ? 255 : 0)), 2, 2)
    expect([...d]).toEqual([1, 1, 0, 0])
  })

  it('melts 8-bit steps on a gentle ramp into a smooth slope', () => {
    // A ramp that rises one 8-bit level every 8 px: raw neighbours differ by 0 or 1/255 (stripes).
    const w = 64, h = 8
    const raw = depthToFloat(rgba(w, h, x => 100 + Math.floor(x / 8)), w, h)
    const s = bilateralSmooth(raw, w, h, 4, 0.035)
    const steps = new Set<number>()
    for (let x = 8; x < w - 9; x++) steps.add(Math.round((s[4 * w + x + 1]! - s[4 * w + x]!) * 1e5))
    expect(steps.size).toBeGreaterThan(3)      // many different small slopes, not just 0 and one jump
    expect(Math.max(...steps)).toBeLessThan(Math.round(1e5 / 255))
  })

  it('keeps a real depth edge sharp (no halo)', () => {
    const w = 32, h = 4
    const raw = depthToFloat(rgba(w, h, x => (x < 16 ? 40 : 220)), w, h)
    const s = bilateralSmooth(raw, w, h, 4, 0.035)
    expect(s[2 * w + 13]!).toBeCloseTo(40 / 255, 2)
    expect(s[2 * w + 18]!).toBeCloseTo(220 / 255, 2)
  })

  it('pulls the upsampled edge toward the photo edge, off the coarse grid', () => {
    // Coarse depth 8 wide: edge between texels 3 and 4 (u=0.5). Photo 32 wide: edge at x=18 (u=0.5625).
    // Pixel 16 lies between the two edges: the photo is still dark (far) there.
    const depth = depthToFloat(rgba(8, 2, x => (x < 4 ? 30 : 220)), 8, 2)
    const photo = rgba(32, 8, x => (x < 18 ? 20 : 240))
    const flat = rgba(32, 8, () => 128)            // a uniform guide = plain smoothing, no photo edge
    const joint = jointUpsample(depth, 8, 2, photo, 32, 8)
    const plain = jointUpsample(depth, 8, 2, flat, 32, 8)
    const row = 4 * 32
    // Worked by hand: plain ≈ 0.51 at pixel 16, joint ≈ 0.28 (bright-side taps drop out).
    expect(joint[row + 16]!).toBeLessThan(plain[row + 16]! - 0.15)
    expect(joint[row + 20]!).toBeGreaterThan(0.7)   // past the photo edge: near
  })

  it('flips rows into GL order', () => {
    expect([...toGlRows(new Float32Array([1, 2, 3, 4, 5, 6]), 2, 3)]).toEqual([5, 6, 3, 4, 1, 2])
  })

  it('builds a field at the guide size, in GL order', () => {
    const f = buildDepthField(rgba(4, 4, (_, y) => (y < 2 ? 255 : 0)), 4, 4, rgba(8, 8, (_, y) => (y < 4 ? 255 : 0)), 8, 8)
    expect(f).toMatchObject({ kind: 'float', width: 8, height: 8 })
    expect(f.data[0]!).toBeLessThan(0.2)            // GL row 0 = the image's bottom = far
    expect(f.data[7 * 8]!).toBeGreaterThan(0.8)     // GL last row = the image's top = near
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/relight-depth-field.unit.spec.ts`
Expected: FAIL, cannot resolve `~/lib/relight/depthField`.

- [ ] **Step 3: Write `depthField.ts`**

```ts
// frontend/app/lib/relight/depthField.ts
/**
 * The depth field Relight lights. Made once per image from the 8-bit depth PNG:
 * 1. to floats, 2. edge-preserving smoothing (melts the 8-bit steps that light up as contour
 * stripes, but keeps the subject/background jump a jump — blurring across it drew a grey halo),
 * 3. joint-bilateral upsampling guided by the photo, so depth edges follow the photo's real edges
 * instead of the depth map's coarse grid (stair-steps), 4. rows flipped into GL order.
 * The pure steps are unit-tested; `relightDepthFieldFor` is the cached browser entry.
 */
export interface FloatDepth { kind: 'float'; width: number; height: number; data: Float32Array }

/** Guide/field resolution cap: the field is built at the guide's size, at most this on its long edge. */
export const FIELD_MAX_EDGE = 1536

export function depthToFloat(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = rgba[i * 4]! / 255
  return out
}

export function bilateralSmooth(src: Float32Array, w: number, h: number, radius: number, sigma: number): Float32Array {
  const k2 = 1 / (2 * sigma * sigma)
  let a = src, b = new Float32Array(w * h)
  const pass = (from: Float32Array, to: Float32Array, horiz: boolean) => {
    const n = horiz ? w : h, lines = horiz ? h : w
    for (let l = 0; l < lines; l++) {
      for (let k = 0; k < n; k++) {
        const c = from[horiz ? l * w + k : k * w + l]!
        let sum = 0, ws = 0
        for (let j = -radius; j <= radius; j++) {
          const m = Math.min(n - 1, Math.max(0, k + j))
          const v = from[horiz ? l * w + m : m * w + l]!
          const wt = Math.exp(-(v - c) * (v - c) * k2)
          sum += v * wt; ws += wt
        }
        to[horiz ? l * w + k : k * w + l] = sum / ws
      }
    }
  }
  for (let i = 0; i < 2; i++) {
    pass(a, b, true)
    const c = new Float32Array(w * h); pass(b, c, false); a = c
  }
  return a
}

/** Coarse depth → guide resolution, averaging 7×7 coarse neighbours weighted by how close the
 *  photo's colour at each neighbour is to this pixel's colour. Sampling is bilinear. */
export function jointUpsample(depth: Float32Array, dw: number, dh: number, guide: Uint8ClampedArray, gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh)
  const sc = 1 / (2 * 0.07 * 0.07)
  const dAt = (u: number, v: number) => {           // bilinear in the coarse depth, u,v in 0..1
    const x = Math.min(dw - 1, Math.max(0, u * dw - 0.5)), y = Math.min(dh - 1, Math.max(0, v * dh - 0.5))
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(dw - 1, x0 + 1), y1 = Math.min(dh - 1, y0 + 1)
    const fx = x - x0, fy = y - y0
    const t = depth[y0 * dw + x0]! * (1 - fx) + depth[y0 * dw + x1]! * fx
    const bm = depth[y1 * dw + x0]! * (1 - fx) + depth[y1 * dw + x1]! * fx
    return t * (1 - fy) + bm * fy
  }
  const gAt = (x: number, y: number, c: number) => guide[(Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))) * 4 + c]! / 255
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const r0 = gAt(x, y, 0), g0 = gAt(x, y, 1), b0 = gAt(x, y, 2)
      const u = (x + 0.5) / gw, v = (y + 0.5) / gh
      let sum = 0, ws = 0
      for (let j = -3; j <= 3; j++) {
        for (let i = -3; i <= 3; i++) {
          const su = u + (i * 0.75) / dw, sv = v + (j * 0.75) / dh
          const gx = Math.round(su * gw - 0.5), gy = Math.round(sv * gh - 0.5)
          const dr = gAt(gx, gy, 0) - r0, dg = gAt(gx, gy, 1) - g0, db = gAt(gx, gy, 2) - b0
          const w = Math.exp(-(i * i + j * j) / 8) * Math.exp(-(dr * dr + dg * dg + db * db) * sc)
          sum += dAt(su, sv) * w; ws += w
        }
      }
      out[y * gw + x] = sum / ws
    }
  }
  return out
}

export function toGlRows(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) out.set(src.subarray(y * w, (y + 1) * w), (h - 1 - y) * w)
  return out
}

export function buildDepthField(depthRgba: Uint8ClampedArray, dw: number, dh: number, guideRgba: Uint8ClampedArray, gw: number, gh: number): FloatDepth {
  const smooth = bilateralSmooth(depthToFloat(depthRgba, dw, dh), dw, dh, Math.max(3, Math.round(Math.max(dw, dh) / 120)), 0.035)
  return { kind: 'float', width: gw, height: gh, data: toGlRows(jointUpsample(smooth, dw, dh, guideRgba, gw, gh), gw, gh) }
}

// ── Browser entry, cached ──────────────────────────────────────────────────
const cache = new Map<string, FloatDepth>()
export function __resetRelightDepthFields(): void { cache.clear() }

function pixelsOf(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray | null {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const x = c.getContext('2d', { willReadFrequently: true })
  if (!x) return null
  x.drawImage(src, 0, 0, w, h)
  return x.getImageData(0, 0, w, h).data
}

/**
 * The field for one image. `key` is the depth registry key (`depthKey(ref)`), so the same
 * picture on two layers or at two sizes shares one field. `guide` is the layer's own content at
 * any size; it is resampled to at most FIELD_MAX_EDGE. Returns null if a 2D context is refused.
 */
export function relightDepthFieldFor(key: string, depth: CanvasImageSource, guide: HTMLCanvasElement): FloatDepth | null {
  const hit = cache.get(key)
  if (hit) return hit
  const dw = (depth as HTMLImageElement).naturalWidth || (depth as HTMLCanvasElement).width
  const dh = (depth as HTMLImageElement).naturalHeight || (depth as HTMLCanvasElement).height
  if (!dw || !dh) return null
  const s = Math.min(1, FIELD_MAX_EDGE / Math.max(guide.width, guide.height))
  const gw = Math.max(1, Math.round(guide.width * s)), gh = Math.max(1, Math.round(guide.height * s))
  const dpx = pixelsOf(depth, dw, dh), gpx = pixelsOf(guide, gw, gh)
  if (!dpx || !gpx) return null
  const field = buildDepthField(dpx, dw, dh, gpx, gw, gh)
  if (cache.size >= 8) cache.delete(cache.keys().next().value!)
  cache.set(key, field)
  return field
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run tests/unit/relight-depth-field.unit.spec.ts`
Expected: PASS (6 tests). If *melts 8-bit steps* fails, do not loosen the test. Raise the smoothing radius in `buildDepthField` and the test call together, since the look depends on it.

- [ ] **Step 5: Commit.** Paths: `frontend/app/lib/relight/depthField.ts frontend/tests/unit/relight-depth-field.unit.spec.ts`. Message: `feat(relight): smooth, photo-guided float depth field (stage 1)`.

---

### Task 3: A float depth field in `GpuPost`

`GpuPost.render` uploads depth as an 8-bit image. Relight needs the float field from Task 2, uploaded as R16F (filterable in WebGL2 without an extension).

**Files:**
- Modify: `frontend/app/lib/compositor/gpuPost.ts` (the `render` method, ~139-194, and exports)
- Test: `frontend/tests/unit/gpu-post-uniforms.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `FloatDepth` from Task 2 (`~/lib/relight/depthField`).
- Produces: `GpuPost.render(color, depth: CanvasImageSource | FloatDepth, w, h, uniforms)`. `isFloatDepth(d: unknown): d is FloatDepth`. Existing callers (`applyDof`, `applyFinish`) are unchanged.

- [ ] **Step 1: Write the failing test** (append to `tests/unit/gpu-post-uniforms.unit.spec.ts`)

```ts
import { isFloatDepth } from '~/lib/compositor/gpuPost'

describe('isFloatDepth', () => {
  it('tells a float field from an image', () => {
    expect(isFloatDepth({ kind: 'float', width: 1, height: 1, data: new Float32Array(1) })).toBe(true)
    expect(isFloatDepth({ width: 1, height: 1 })).toBe(false)
    expect(isFloatDepth(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/gpu-post-uniforms.unit.spec.ts`
Expected: FAIL, `isFloatDepth` is not exported.

- [ ] **Step 3: Implement**

In `gpuPost.ts`, add near the top:

```ts
import type { FloatDepth } from '~/lib/relight/depthField'

export function isFloatDepth(d: unknown): d is FloatDepth {
  return !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'float'
    && (d as { data?: unknown }).data instanceof Float32Array
}
```

Change the `render` signature's `depth` parameter to `depth: CanvasImageSource | FloatDepth`, and replace the depth upload block (the three lines after `gl.bindTexture(gl.TEXTURE_2D, this.texDepth)`) with:

```ts
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.texDepth)
    if (isFloatDepth(depth)) {
      // A float field arrives already in GL row order (bottom row first); FLIP_Y must be off
      // for the typed-array upload, then back on for the next image upload.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, depth.width, depth.height, 0, gl.RED, gl.FLOAT, depth.data)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depth as TexImageSource)
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uDepth'), 1)
```

(`.r` of an R16F texture is the depth; `.r` of the RGBA image is too, so shaders read both the same way.)

- [ ] **Step 4: Run the GPU tests**

Run: `cd frontend && pnpm vitest run tests/unit/gpu-post-uniforms.unit.spec.ts tests/unit/gpu-post-robustness.unit.spec.ts tests/unit/dof-pass.unit.spec.ts tests/unit/finish-pass.unit.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Commit.** Paths: `frontend/app/lib/compositor/gpuPost.ts frontend/tests/unit/gpu-post-uniforms.unit.spec.ts`. Message: `feat(gpu-post): accept a float depth field as R16F (relight stage 1)`.

---

### Task 4: The relight pass

**Files:**
- Create: `frontend/app/lib/relight/relightPass.ts`
- Test: `frontend/tests/unit/relight-pass.unit.spec.ts`

**Interfaces:**
- Consumes: `RelightEffect` (Task 1), `FloatDepth` (Task 2), `GpuPost.render` accepting `FloatDepth` (Task 3).
- Produces:
  - `RELIGHT_FRAG: string`
  - `packLights(fx: RelightEffect): { uLightPos: Float32Array; uLightHR: Float32Array; uLightRG: Float32Array; uLightBP: Float32Array; uLightCount: number }` (each array is 3 vec2 = 6 floats; only lights with `on` are packed, in order)
  - `relightShouldRun(fx: RelightEffect): boolean`
  - `relightAvailable(): boolean`, `relightUnavailableReason(): string`, `__relightRuns(): number`
  - `applyRelight(color: CanvasImageSource, depth: FloatDepth | CanvasImageSource, fx: RelightEffect, w: number, h: number): HTMLCanvasElement | null` (returns the pass's shared canvas: callers copy it out, as with DOF)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/relight-pass.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { packLights, relightShouldRun, RELIGHT_FRAG } from '~/lib/relight/relightPass'
import { sanitizeRelight } from '~/lib/relight/settings'
import { applySetup } from '~/lib/relight/presets'

describe('relight pass', () => {
  it('packs only lights that are on, in order, as vec2 pairs', () => {
    const fx = applySetup(sanitizeRelight(null), 'Neon')
    fx.lights[0]!.on = false
    const p = packLights(fx)
    expect(p.uLightCount).toBe(1)
    expect([...p.uLightPos.slice(0, 2)]).toEqual([expect.closeTo(0.95, 5), expect.closeTo(0.45, 5)])
    expect([...p.uLightHR.slice(0, 2)]).toEqual([expect.closeTo(0.35, 5), expect.closeTo(0.8, 5)])
    // #29d8ff → 0x29/255, 0xd8/255 | 0xff/255, brightness 2.2
    expect(p.uLightRG[0]).toBeCloseTo(0x29 / 255, 5)
    expect(p.uLightRG[1]).toBeCloseTo(0xd8 / 255, 5)
    expect(p.uLightBP[0]).toBeCloseTo(1, 5)
    expect(p.uLightBP[1]).toBeCloseTo(2.2, 5)
    expect(p.uLightPos).toHaveLength(6)
  })
  it('runs when visible, skips when hidden', () => {
    const fx = sanitizeRelight(null)
    expect(relightShouldRun(fx)).toBe(true)
    expect(relightShouldRun({ ...fx, visible: false })).toBe(false)
  })
  it('declares every uniform the packer sends', () => {
    for (const u of ['uLightPos', 'uLightHR', 'uLightRG', 'uLightBP', 'uLightCount', 'uKeep', 'uRelief', 'uDetail', 'uGloss', 'uShadows', 'uAspect', 'uDepthTexel', 'uImgTexel'])
      expect(RELIGHT_FRAG).toContain(u)
  })
  it('keeps the source alpha (straight alpha, like DOF)', () => {
    expect(RELIGHT_FRAG).toMatch(/fragColor = vec4\(toSrgb\(col\), src\.a\)/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/relight-pass.unit.spec.ts`
Expected: FAIL, cannot resolve `~/lib/relight/relightPass`.

- [ ] **Step 3: Write `relightPass.ts`**

The shader is the prototype's, adapted to `GpuPost`: the textures are named `uColor`/`uDepth`, and `vUv.y = 1` is the **top** of the image (FLIP_Y). All lighting maths runs in top-down layer fractions `p`, and every texture read converts with `G(p)`. The lights arrive as four `vec2[3]` arrays because `GpuPost` only sends vec2 arrays, and the light count arrives as a float.

```ts
// frontend/app/lib/relight/relightPass.ts
/**
 * Relight — lights a layer's own pixels from its depth field. Ported from the prototype
 * (frontend/app/pages/dev/relight.vue, 2026-09-29); every constant here was tuned there by eye.
 * Spec: docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md ("Shader").
 */
import { GpuPost } from '~/lib/compositor/gpuPost'
import type { FloatDepth } from './depthField'
import type { RelightEffect } from './settings'

export const RELIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor, uDepth;
uniform vec2 uDepthTexel, uImgTexel;
uniform float uAspect, uRelief, uKeep, uGloss, uDetail, uShadows, uLightCount;
uniform vec2 uLightPos[3];   // x, y (layer fractions, top-down)
uniform vec2 uLightHR[3];    // height, reach
uniform vec2 uLightRG[3];    // colour r, g (sRGB 0..1)
uniform vec2 uLightBP[3];    // colour b, brightness

// Lighting runs in top-down layer fractions p; textures are FLIP_Y-uploaded, so vUv.y = 1 is the top.
vec2 G(vec2 p) { return vec2(p.x, 1.0 - p.y); }
float H(vec2 p) { return texture(uDepth, G(p)).r; }

vec2 slopeAt(vec2 p) {
  vec2 e = uDepthTexel * 2.0;
  float dx = (H(p + vec2(e.x, 0.)) - H(p - vec2(e.x, 0.))) / (2.0 * e.x * uAspect);
  float dy = (H(p + vec2(0., e.y)) - H(p - vec2(0., e.y))) / (2.0 * e.y);
  return vec2(dx, dy) * uRelief * 0.05;
}

vec3 normalAt(vec2 p) {
  vec2 g = slopeAt(p);
  // A depth edge is a cliff, not a surface; where the photo can't separate the two sides it is
  // smeared into a ramp that lights up as a ridge line. On a cliff, borrow the slope from a few
  // texels away on the side whose depth matches this pixel.
  float cliff = smoothstep(0.6, 1.2, length(g));
  if (cliff > 0.0) {
    vec2 o = normalize(g) * uDepthTexel * 6.0;
    float hc = H(p);
    vec2 side = abs(H(p - o) - hc) < abs(H(p + o) - hc) ? p - o : p + o;
    vec2 gs = slopeAt(side);
    gs *= 1.0 - smoothstep(0.6, 1.2, length(gs));
    g = mix(g, gs, cliff);
  }
  // Fine relief from the photo itself: brighter reads raised.
  vec2 t = uImgTexel * 1.5;
  vec3 W = vec3(0.299, 0.587, 0.114);
  float lx = dot(texture(uColor, G(p + vec2(t.x, 0.))).rgb - texture(uColor, G(p - vec2(t.x, 0.))).rgb, W);
  float ly = dot(texture(uColor, G(p + vec2(0., t.y))).rgb - texture(uColor, G(p - vec2(0., t.y))).rgb, W);
  g += vec2(lx, ly) * uDetail;
  return normalize(vec3(-g, 1.0));
}

// Contact shadows only (a depth map can't place a long cast shadow), and occluders far in
// front of this pixel are skipped (subject vs wall would draw a wrong shifted silhouette).
float shadowTo(vec3 P, vec3 Lp) {
  vec3 d = normalize(Lp - P) * 0.06; float s = 1.0;
  float hP = P.z / max(uRelief * 0.05, 1e-4);
  for (int i = 1; i <= 24; i++) {
    float f = float(i) / 24.0;
    float t = f * f;                         // dense near the pixel: no bright sliver at edges
    vec3 q = P + d * t;
    vec2 p = vec2(q.x / uAspect, q.y);
    if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1.) break;
    float hr = H(p);
    float near = 1.0 - smoothstep(0.06, 0.14, hr - hP);
    if (near <= 0.0) continue;
    float h = hr * uRelief * 0.05;
    s = min(s, mix(1.0, clamp(1.0 - (h - q.z - 0.003) * 40.0 * (1.0 - t), 0.0, 1.0), near));
  }
  return mix(0.45, 1.0, s);                  // never black: bounce light fills a shadow
}

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  vec4 src = texture(uColor, vUv);
  vec3 albedo = toLin(src.rgb);
  float h = H(p);
  vec3 N = normalAt(p);
  vec3 P = vec3(p.x * uAspect, p.y, h * uRelief * 0.05);
  vec3 light = vec3(uKeep);
  vec3 spec = vec3(0.);
  int count = int(uLightCount + 0.5);
  for (int i = 0; i < 3; i++) {
    if (i >= count) break;
    vec3 Lp = vec3(uLightPos[i].x * uAspect, uLightPos[i].y, uLightHR[i].x);
    vec3 d = Lp - P; float dist = length(d); vec3 L = d / dist;
    float lam = clamp((dot(N, L) + 0.25) / 1.25, 0.0, 1.0);
    float fall = 1.0 / (1.0 + pow(dist / max(uLightHR[i].y, 0.01), 2.0) * 2.0);
    float sh = (uShadows > 0.5 && uLightHR[i].x > 0.0) ? shadowTo(P, Lp) : 1.0;
    vec3 c = toLin(vec3(uLightRG[i], uLightBP[i].x)) * uLightBP[i].y * fall * sh;
    light += c * lam;
    spec += c * pow(max(dot(N, normalize(L + vec3(0., 0., 1.))), 0.0), 40.0) * uGloss;
  }
  vec3 col = albedo * light + spec;
  col = col / (1.0 + col * 0.15);            // soft shoulder instead of hard clipping
  fragColor = vec4(toSrgb(col), src.a);
}`

let pass: GpuPost | null = null
const getPass = () => (pass ??= new GpuPost(RELIGHT_FRAG))

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}

export function packLights(fx: RelightEffect) {
  const on = fx.lights.filter(l => l.on).slice(0, 3)
  const uLightPos = new Float32Array(6), uLightHR = new Float32Array(6), uLightRG = new Float32Array(6), uLightBP = new Float32Array(6)
  on.forEach((l, i) => {
    const [r, g, b] = rgb(l.color)
    uLightPos.set([l.x, l.y], i * 2)
    uLightHR.set([l.height, l.reach], i * 2)
    uLightRG.set([r, g], i * 2)
    uLightBP.set([b, l.brightness], i * 2)
  })
  return { uLightPos, uLightHR, uLightRG, uLightBP, uLightCount: on.length }
}

export function relightShouldRun(fx: RelightEffect): boolean {
  return fx.visible !== false
}
export function relightAvailable(): boolean { return getPass().available() }
export function relightUnavailableReason(): string { return getPass().unavailableReason() }
/** Assertion marker: "Relight applied" vs "silently drawn plain". */
export function __relightRuns(): number { return getPass().runs }

export function applyRelight(
  color: CanvasImageSource,
  depth: FloatDepth | CanvasImageSource,
  fx: RelightEffect,
  w: number,
  h: number,
): HTMLCanvasElement | null {
  if (!relightShouldRun(fx)) return null
  const dw = 'kind' in (depth as object) ? (depth as FloatDepth).width : ((depth as HTMLImageElement).naturalWidth || (depth as HTMLCanvasElement).width)
  const dh = 'kind' in (depth as object) ? (depth as FloatDepth).height : ((depth as HTMLImageElement).naturalHeight || (depth as HTMLCanvasElement).height)
  return getPass().render(color, depth, w, h, {
    ...packLights(fx),
    uDepthTexel: new Float32Array([1 / Math.max(1, dw), 1 / Math.max(1, dh)]),
    uImgTexel: new Float32Array([1 / Math.max(1, w), 1 / Math.max(1, h)]),
    uAspect: w / Math.max(1, h),
    uRelief: fx.depth,
    uKeep: fx.keep,
    uGloss: fx.shine,
    uDetail: fx.texture,
    uShadows: fx.shadows ? 1 : 0,
  })
}
```

Note on uniforms: `uDepthTexel` and `uImgTexel` are single `vec2`s sent as a two-float `Float32Array`, which `uniformSetter` sends with `uniform2fv`. That is valid for a non-array `vec2`. `uLightCount` and `uShadows` are floats because `uniformSetter` sends only `uTapCount` as an int.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run tests/unit/relight-pass.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.** Paths: `frontend/app/lib/relight/relightPass.ts frontend/tests/unit/relight-pass.unit.spec.ts`. Message: `feat(relight): the GPU pass, ported from the prototype (stage 1)`.

---

### Task 5: Register the `relight` effect kind

**Files:**
- Modify: `frontend/app/lib/compositor/effectStack.ts` (the `LayerEffect` union ~177; `EFFECT_ORDER` 198; `PINNED_KINDS` 215; `regionOf` 234; `EFFECT_LABELS` 242; `EFFECT_MENU_GROUPS` 292; `defaultsFor`, used by `createEffect` at 383)
- Modify: `frontend/app/lib/compositor/postEffects.ts:376-377` (`GPU_TYPES`, `isGpuEffect`)
- Modify: `frontend/app/lib/compositor/effectDials.ts` (`EFFECT_DIAL_SCHEMA`)
- Modify: `frontend/app/composables/useCompositorLayers.ts:308-322` (type import and re-export lists)
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts:1371-1372` (refuse by name)
- Modify: `frontend/app/lib/embed/frame/plan.ts:235` (web-export notice)
- Test: `frontend/tests/unit/compositor-effect-stack.unit.spec.ts`, `frontend/tests/unit/effect-menu-groups.unit.spec.ts`, `frontend/tests/unit/dof-paint.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `RelightEffect`, `defaultRelightSettings` (Task 1).
- Produces: `'relight'` as an `EffectKind`; `EFFECT_LABELS.relight === 'Relight'`; `createEffect('relight')` returns a fresh `RelightEffect & { id }`; `GPU_TYPES.has('relight')`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
// in tests/unit/compositor-effect-stack.unit.spec.ts
import { createEffect, addEffect, EFFECT_LABELS, isPinnedKind, regionOf, EFFECT_ORDER } from '~/lib/compositor/effectStack'
describe('relight kind', () => {
  it('is a pinned kind named Relight, placed right after depth of field', () => {
    expect(EFFECT_LABELS.relight).toBe('Relight')
    expect(isPinnedKind('relight')).toBe(true)
    expect(regionOf('relight')).toBe('backdrop')
    expect(EFFECT_ORDER.indexOf('relight')).toBe(EFFECT_ORDER.indexOf('dof') + 1)
  })
  it('creates a fresh Golden key effect each time (lights never shared)', () => {
    const a = createEffect('relight') as any, b = createEffect('relight') as any
    expect(a.lights).toHaveLength(1)
    expect(a.lights).not.toBe(b.lights)
    expect(a).toMatchObject({ type: 'relight', visible: true, keep: 0.12, depth: 4 })
  })
  it('refuses a second Relight on the same layer', () => {
    const one = addEffect([], 'relight')
    expect(addEffect(one, 'relight')).toHaveLength(one.length)
  })
})

// in tests/unit/effect-menu-groups.unit.spec.ts
import { EFFECT_MENU_GROUPS } from '~/lib/compositor/effectStack'
it('lists Relight under Light & shadow', () => {
  expect(EFFECT_MENU_GROUPS.find(g => g.label === 'Light & shadow')!.kinds).toContain('relight')
})

// in tests/unit/dof-paint.unit.spec.ts
import { GPU_TYPES, isChainEffect } from '~/lib/compositor/postEffects'
it('routes relight to the GPU stage, never the 2D chain', () => {
  expect(GPU_TYPES.has('relight')).toBe(true)
  expect(isChainEffect({ type: 'relight' } as any)).toBe(false)
})
```

(`addEffect(stack: EffectInstance[], kind: EffectKind): EffectInstance[]` returns the same stack for a pinned kind already present, at `effectStack.ts:495`. `CHAIN_TYPES` is module-private, so the test goes through the exported `isChainEffect`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && pnpm vitest run tests/unit/compositor-effect-stack.unit.spec.ts tests/unit/effect-menu-groups.unit.spec.ts tests/unit/dof-paint.unit.spec.ts`
Expected: FAIL (`EFFECT_LABELS.relight` undefined, and type errors).

- [ ] **Step 3: Implement**

`effectStack.ts`:
- `import type { RelightEffect } from '~/lib/relight/settings'` and `import { defaultRelightSettings } from '~/lib/relight/settings'`.
- `LayerEffect` union: add `| RelightEffect` next to `| SpotUvEffect`.
- `EFFECT_ORDER`: insert `'relight'` directly after `'dof'`.
- `PINNED_KINDS`: `['background_blur', 'backdrop_shader', 'backdrop_luminance_mask', 'dof', 'relight', 'drop_shadow']`. Extend the comment above it with: `- relight, like dof, needs its depth field aligned to the layer's own pixels before the layer is placed, and runs on the GPU against a box-sized source (before dof, so the blur sees the relit picture).`
- `regionOf`: add `|| kind === 'relight'` to the `'backdrop'` line.
- `EFFECT_LABELS`: `relight: 'Relight',`
- `EFFECT_MENU_GROUPS`: `'Light & shadow'` kinds become `['drop_shadow', 'outer_glow', 'inner_shadow', 'inner_glow', 'bloom', 'halation', 'vignette', 'relight']`.
- In `defaultsFor(kind)`, first line: `if (kind === 'relight') return defaultRelightSettings()`. It must return a fresh object: `createEffect` only spreads the defaults, so a shared table entry would share its `lights` array between every Relight in the document.

`postEffects.ts`:
```ts
export const GPU_TYPES = new Set<string>(['dof', 'relight'])
export const isGpuEffect = (e: { type: string }): boolean => GPU_TYPES.has(e.type)
```
Then fix any caller that relied on the old `e is DofEffect` narrowing by adding `e.type === 'dof'` where it reads DOF fields. `pnpm exec vue-tsc --noEmit` lists them; compare against the baseline first (see Step 4).

`effectDials.ts`: add `relight: [],` to `EFFECT_DIAL_SCHEMA`. Light dials are animated in stage 4. If `effect-dials.unit.spec.ts` requires a non-empty list per kind, add instead `num('keep', 'Original light', 0, 1), num('depth', 'Depth', 0, 20), num('texture', 'Texture', 0, 8), num('shine', 'Shine', 0, 1)`.

`useCompositorLayers.ts:308-322`: add `RelightEffect` to the type import and to the `export type { … }` list, as `SpotUvEffect` is.

`agent/surfaces/compositor.ts:1371-1372`:
```ts
      if (type === 'spot_uv' || type === 'relight') return { ok: false, reason: 'invalid', detail: `${type} is set up by the person themselves (Add effect); the agent cannot set it` }
      if (!type || !isEffectKind(type)) return { ok: false, reason: 'invalid', detail: `effect.type must be one of ${EFFECT_ORDER.filter(k => k !== 'spot_uv' && k !== 'relight').join('|')}` }
```
Also remove `relight` from the effect-type hint text at ~872 if it is generated from `EFFECT_ORDER`, and update `tests/unit/agent-compositor-surface.unit.spec.ts` if it pins that list.

`embed/frame/plan.ts`, after the `hasDof` block (~245):
```ts
    const hasRelight = effectStackOf(l as any).some(e => e.type === 'relight' && (e as { visible?: boolean }).visible !== false)
    if (hasRelight) notices.push({ group: 'leftOut', text: `Relight on ${layerLabel(l)} · shown without it in this version`, layerId: l.id })
```
Web export of Relight is a later stage. The notice keeps the omission visible instead of silent.

- [ ] **Step 4: Run tests and the type check**

First record the type-check baseline on a clean `HEAD` copy of the checkout, as `typecheck-baseline-anchoring` describes: other sessions' edits make the absolute count move. Then:
Run: `cd frontend && pnpm vitest run tests/unit/compositor-effect-stack.unit.spec.ts tests/unit/effect-menu-groups.unit.spec.ts tests/unit/dof-paint.unit.spec.ts tests/unit/effect-dials.unit.spec.ts tests/unit/agent-compositor-surface.unit.spec.ts tests/unit/post-effects.unit.spec.ts && pnpm exec vue-tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: tests PASS; the error count is no higher than the baseline, and no error mentions `relight`, `isGpuEffect` or `GPU_TYPES`.

- [ ] **Step 5: Commit.** Paths: the six modified source files and three test files above (plus `tests/unit/agent-compositor-surface.unit.spec.ts` if changed). Message: `feat(relight): register Relight as a pinned GPU layer effect (stage 1)`.

---

### Task 6: Run Relight in the paint step

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`: `paintLayer` (~2942-2945 refs; ~2976 silhouette gate; ~3108-3168 `dofContent` / `drawContent`), module state near `_frameLight` (~1576), and `drawWiredImageLayer` (7171)
- Modify: `frontend/app/composables/useWiredTreatments.ts` (mirror `dof`)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` `drawWiredLayer` (~4595-4610), which passes the wired treatment's relight into `drawWiredImageLayer`
- Test: `frontend/tests/unit/relight-paint.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `relightDepthFieldFor` (Task 2), `applyRelight`, `relightAvailable` (Task 4), `sanitizeRelight` (Task 1), `depthKey` from `~/lib/compositor/depthRegistry`.
- Produces:
  - `setRelightBypass(layerId: string | null): void` and `relightBypassed(layerId: string): boolean`, exported from `useCompositorLayers.ts`. While a layer id is bypassed, its Relight is skipped (Compare).
  - `WiredTreatment.relight?: RelightEffect`, `setWiredRelight(node, slot, relight | null)`.
  - `drawWiredImageLayer(ctx, img, layer, W, H, maskImg?, dof?, depthImg?, relight?, relightKey?)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/relight-paint.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { setRelightBypass, relightBypassed } from '~/composables/useCompositorLayers'

describe('relight compare bypass', () => {
  it('bypasses one layer at a time and clears', () => {
    setRelightBypass('a')
    expect(relightBypassed('a')).toBe(true)
    expect(relightBypassed('b')).toBe(false)
    setRelightBypass(null)
    expect(relightBypassed('a')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/relight-paint.unit.spec.ts`
Expected: FAIL, `setRelightBypass` is not exported.

- [ ] **Step 3: Implement the local-layer path**

Near `_frameLight` (~1576):
```ts
// Compare: while the Relight panel's Compare is held, that one layer paints without Relight.
let _relightBypass: string | null = null
export function setRelightBypass(layerId: string | null): void { _relightBypass = layerId }
export function relightBypassed(layerId: string): boolean { return _relightBypass === layerId }
```

In `paintLayer`, next to the `dof` line (~2945):
```ts
  const relightRaw = dofRef ? pinnedEffect(stack, 'relight') : undefined
  const relight = relightRaw && !relightBypassed(layer.id) ? sanitizeRelight(relightRaw) : undefined
```
Silhouette gate (~2976): `&& !cp && !dof && !relight`.

Rename `dofMemo` to `gpuMemo`, `dofContent` to `gpuContent` and `dofCanvas` to `gpuCanvas` throughout `paintLayer`, then rewrite the body of `gpuContent`:
```ts
  let gpuMemo: HTMLCanvasElement | null | undefined
  const gpuContent = (): HTMLCanvasElement | null => {
    if (gpuMemo !== undefined && !isClipLayer) return gpuMemo
    gpuMemo = null
    const wantRelight = !!relight && relightAvailable()
    const wantDof = !!dof && dofAvailable() && dofShouldRun(dof, true)
    if (!wantRelight && !wantDof) return gpuMemo

    const depth = depthImageFor(dofRef!)
    if (!depth) { requestDepth(dofRef!); return gpuMemo }

    const box = localLayerBox(measureCtx(), layer, W, H, wiredLive)
    const matPad = brushMaterialPadPx(layer, W)
    const bw = Math.max(1, Math.round(box.w + matPad * 2)), bh = Math.max(1, Math.round(box.h + matPad * 2))
    const src = document.createElement('canvas'); src.width = bw; src.height = bh
    const sctx = src.getContext('2d')
    if (!sctx) return gpuMemo
    sctx.translate(bw / 2, bh / 2)
    drawLayerContent(sctx, layer, W, wiredLive)

    const own = (c: HTMLCanvasElement) => {   // the passes reuse their canvas: always copy out
      const o = document.createElement('canvas'); o.width = bw; o.height = bh
      o.getContext('2d')?.drawImage(c, 0, 0); return o
    }
    let cur: HTMLCanvasElement | null = null
    // Relight first, so a depth-of-field blur on the same layer blurs the relit picture.
    if (wantRelight) {
      const field = relightDepthFieldFor(depthKey(dofRef!), depth, src)
      const lit = field ? applyRelight(src, field, relight!, bw, bh) : null
      if (lit) cur = own(lit)
    }
    if (wantDof) {
      const out = applyDof(cur ?? src, depth, dof!, W, bw, bh)
      if (out) cur = own(out)
    }
    gpuMemo = cur
    return gpuMemo
  }
```
Leave the rest of `drawContent` as it is apart from the renames.

Imports at the top of the file: `import { sanitizeRelight, type RelightEffect } from '~/lib/relight/settings'`, `import { applyRelight, relightAvailable } from '~/lib/relight/relightPass'`, `import { relightDepthFieldFor } from '~/lib/relight/depthField'`, and add `depthKey` to the existing `depthRegistry` import.

- [ ] **Step 4: Implement the wired-slot path**

`useWiredTreatments.ts`: add `relight?: import('~/lib/relight/settings').RelightEffect` to `WiredTreatment`, and after `setWiredDof`:
```ts
export function setWiredRelight(node: any, slot: number, relight: WiredTreatment['relight'] | null) {
  // Mirrors setWiredDof exactly (same key, same delete-when-null rule).
}
```
Write its body by copying `setWiredDof` (line 88) and replacing `dof` with `relight`.

`drawWiredImageLayer`: add the trailing params `relight?: RelightEffect | null, relightKey?: string`, and **before** the DOF block:
```ts
  if (relight && depthImg && relightKey && relightAvailable() && relight.visible !== false) {
    const guide = src instanceof HTMLCanvasElement ? src : (() => {
      const c = document.createElement('canvas'); c.width = iw; c.height = ih
      c.getContext('2d')?.drawImage(src, 0, 0); return c
    })()
    const field = relightDepthFieldFor(relightKey, depthImg, guide)
    const lit = field ? applyRelight(src, field, sanitizeRelight(relight), iw, ih) : null
    if (lit) {
      const owned = document.createElement('canvas'); owned.width = iw; owned.height = ih
      owned.getContext('2d')?.drawImage(lit, 0, 0)
      src = owned
    }
  }
```
(Relight works in the image's own fractions, so native size needs no on-canvas normalisation, unlike DOF's `onCanvasW`.)

`CompositorModal.vue` `drawWiredLayer` (~4595-4610): where it passes `wiredTreatments[...].dof` and the depth image, also pass `wiredTreatments[...].relight` and `depthKey(<the same depth source it uses for dof>)`. Also request depth when only relight is set: follow the same `requestDepth` call the dof branch makes.

- [ ] **Step 5: Run the unit tests and the type check**

Run: `cd frontend && pnpm vitest run tests/unit/relight-paint.unit.spec.ts tests/unit/dof-paint.unit.spec.ts tests/unit/post-effects-paint.unit.spec.ts tests/unit/frame-light-paint.unit.spec.ts && pnpm exec vue-tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: PASS; the error count is not above the baseline.

- [ ] **Step 6: Commit.** Paths: `frontend/app/composables/useCompositorLayers.ts frontend/app/composables/useWiredTreatments.ts frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/unit/relight-paint.unit.spec.ts`. **CompositorModal.vue is shared and huge:** stage only your hunks. If other sessions have uncommitted edits in it, build the committed version from `git show HEAD:<path>` plus your hunks, as `parallel-sessions-commit-hygiene` describes, and never commit their edits. Message: `feat(relight): paint Relight before depth of field, on image and wired layers (stage 1)`.

---

### Task 7: The settings panel

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/RelightControls.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (the effect inspector, next to the `spot_uv` block ~11233; `EFFECT_HINTS` ~2814)
- Test: `frontend/tests/unit/relight-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `RelightEffect`, `RELIGHT_SWATCHES`, `RELIGHT_MAX_LIGHTS`, `newLightId` (Task 1); `applySetup`, `setupOf`, `RELIGHT_SETUP_NAMES` (Task 1); `StudioSlider`, `StudioSwitch`.
- Produces: `<RelightControls :fx="RelightEffect" :selected-light="string | null" :depth-status="'idle'|'loading'|'ready'|'error'">`, emitting `update(patch: Partial<RelightEffect>)`, `select-light(id: string)`, `compare(on: boolean)`. CompositorModal owns `relightLightId = ref<string | null>(null)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/relight-controls.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RelightControls from '~/components/vue-canvas/compositor/RelightControls.vue'
import { sanitizeRelight } from '~/lib/relight/settings'
import { applySetup, setupOf } from '~/lib/relight/presets'

const mk = (fx = sanitizeRelight(null)) => mount(RelightControls, { props: { fx, selectedLight: fx.lights[0]!.id, depthStatus: 'ready' } })

describe('RelightControls', () => {
  it('shows the setups, the photo controls and the light controls by name', () => {
    const t = mk().text()
    for (const s of ['Window', 'Golden key', 'Rim', 'Neon', 'Under', 'Original light', 'Depth', 'Texture', 'Shine', 'Shadows', 'Brightness', 'Height', 'Reach', 'Light 1'])
      expect(t).toContain(s)
  })
  it('marks the active setup', () => {
    const w = mk()
    expect(w.get('[data-testid="relight-setup-Golden key"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-testid="relight-setup-Neon"]').attributes('aria-pressed')).toBe('false')
  })
  it('emits the setup as a patch', async () => {
    const w = mk()
    await w.get('[data-testid="relight-setup-Neon"]').trigger('click')
    const patch = w.emitted('update')![0]![0] as any
    expect(setupOf({ ...sanitizeRelight(null), ...patch })).toBe('Neon')
  })
  it('adds a light up to three, then disables adding', async () => {
    const three = applySetup(sanitizeRelight(null), 'Rim')
    three.lights.push({ ...three.lights[0]!, id: 'x3' })
    expect(mk(three).get('[data-testid="relight-add-light"]').attributes('disabled')).toBeDefined()
    const w = mk()
    await w.get('[data-testid="relight-add-light"]').trigger('click')
    expect((w.emitted('update')![0]![0] as any).lights).toHaveLength(2)
  })
  it('recolours the selected light from a swatch', async () => {
    const w = mk()
    await w.get('[data-testid="relight-swatch-Cyan"]').trigger('click')
    expect((w.emitted('update')![0]![0] as any).lights[0].color).toBe('#29d8ff')
  })
  it('keeps explanations in tooltips, not panel text', () => {
    expect(mk().text()).not.toMatch(/how much|how strongly|glossy|contact shadows/i)
  })
  it('emits compare on press and release', async () => {
    const w = mk()
    const b = w.get('[data-testid="relight-compare"]')
    await b.trigger('pointerdown'); await b.trigger('pointerup')
    expect(w.emitted('compare')).toEqual([[true], [false]])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/relight-controls.unit.spec.ts`
Expected: FAIL, the component does not exist.

- [ ] **Step 3: Write `RelightControls.vue`**

Match the styling of the `spot_uv` inspector block and `FinishLightControl.vue` (Tailwind classes `text-white/60`, `bg-white/10`, `rounded-[8px]`, 12px text).

```vue
<script setup lang="ts">
/** The Relight effect's settings. Layout and presets follow the mockup (artifact 7rAD2Mu5a2S5d34kHU42iy). */
import { computed } from 'vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import { RELIGHT_MAX_LIGHTS, RELIGHT_SWATCHES, newLightId, type RelightEffect, type RelightLight } from '~/lib/relight/settings'
import { RELIGHT_SETUP_NAMES, applySetup, setupOf, type RelightSetupName } from '~/lib/relight/presets'

const props = defineProps<{ fx: RelightEffect; selectedLight: string | null; depthStatus: 'idle' | 'loading' | 'ready' | 'error' }>()
const emit = defineEmits<{ update: [patch: Partial<RelightEffect>]; 'select-light': [id: string]; compare: [on: boolean] }>()

const active = computed(() => setupOf(props.fx))
const light = computed(() => props.fx.lights.find(l => l.id === props.selectedLight) ?? props.fx.lights[0] ?? null)
const lightIndex = computed(() => (light.value ? props.fx.lights.indexOf(light.value) + 1 : 0))

function pickSetup(name: RelightSetupName) {
  const next = applySetup(props.fx, name)
  emit('update', { keep: next.keep, lights: next.lights })
  if (next.lights[0]) emit('select-light', next.lights[0].id)
}
function addLight() {
  if (props.fx.lights.length >= RELIGHT_MAX_LIGHTS) return
  const l: RelightLight = { id: newLightId(), x: 0.5, y: 0.25, height: 0.35, color: '#f4f7ff', brightness: 1.4, reach: 1, on: true }
  emit('update', { lights: [...props.fx.lights, l] })
  emit('select-light', l.id)
}
function patchLight(p: Partial<RelightLight>) {
  const l = light.value; if (!l) return
  emit('update', { lights: props.fx.lights.map(x => (x.id === l.id ? { ...x, ...p } : x)) })
}
function removeLight() {
  const l = light.value; if (!l) return
  const rest = props.fx.lights.filter(x => x.id !== l.id)
  emit('update', { lights: rest })
  if (rest[0]) emit('select-light', rest[0].id)
}
const heightWord = (h: number) => (h < 0 ? 'Behind' : h < 0.2 ? 'Low' : h < 0.55 ? 'Mid' : 'High')
</script>

<template>
  <div class="space-y-4 text-[12px]">
    <p v-if="depthStatus === 'loading'" class="text-white/50" data-testid="relight-status-loading">Reading shape…</p>
    <p v-else-if="depthStatus === 'error'" class="text-red-300/80" data-testid="relight-status-error">Couldn't read this photo's shape</p>

    <section class="space-y-2">
      <div class="text-white/40 uppercase tracking-[.04em] text-[11px]">Setups</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="n in RELIGHT_SETUP_NAMES" :key="n" :data-testid="`relight-setup-${n}`" :aria-pressed="active === n"
          class="h-7 px-2.5 rounded-[8px] cursor-pointer" :class="active === n ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60 hover:text-white'"
          @click="pickSetup(n)">{{ n }}</button>
      </div>
    </section>

    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-white/40 uppercase tracking-[.04em] text-[11px]">Lights</span>
        <button data-testid="relight-compare" title="Hold to see the photo without Relight" class="h-7 px-2.5 rounded-[8px] bg-white/5 text-white/70 hover:text-white cursor-pointer"
          @pointerdown="emit('compare', true)" @pointerup="emit('compare', false)" @pointerleave="emit('compare', false)">Compare</button>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="(l, i) in fx.lights" :key="l.id" :data-testid="`relight-light-${i + 1}`"
          class="h-7 px-2.5 rounded-[8px] flex items-center gap-1.5 cursor-pointer" :class="l.id === light?.id ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60'"
          @click="emit('select-light', l.id)">
          <span class="size-2.5 rounded-full" :style="{ background: l.color, opacity: l.on ? 1 : 0.35 }" />Light {{ i + 1 }}
        </button>
        <button data-testid="relight-add-light" title="Add a light (or double-click the photo)" :disabled="fx.lights.length >= RELIGHT_MAX_LIGHTS"
          class="size-7 rounded-[8px] bg-white/5 text-white/70 disabled:opacity-40 cursor-pointer disabled:cursor-default" @click="addLight">+</button>
      </div>
    </section>

    <section v-if="light" class="space-y-2" data-testid="relight-light-panel">
      <div class="flex items-center justify-between">
        <span class="text-white/40 uppercase tracking-[.04em] text-[11px]">Light {{ lightIndex }}</span>
        <div class="flex items-center gap-1">
          <StudioSwitch data-testid="relight-light-on" label="On" :model-value="light.on" @update:model-value="(v: boolean) => patchLight({ on: v })" />
          <button data-testid="relight-remove-light" title="Remove light" class="size-7 rounded-[8px] hover:bg-white/10 text-white/60 cursor-pointer" @click="removeLight">✕</button>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5 items-center">
        <button v-for="s in RELIGHT_SWATCHES" :key="s.label" :data-testid="`relight-swatch-${s.label}`" :title="s.label" :aria-label="s.label"
          class="size-5 rounded-full cursor-pointer" :class="light.color === s.color ? 'ring-2 ring-white ring-offset-2 ring-offset-[#151517]' : ''"
          :style="{ background: s.color }" @click="patchLight({ color: s.color })" />
        <label class="size-5 rounded-full overflow-hidden relative cursor-pointer" title="Any colour"
          style="background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red)">
          <input type="color" aria-label="Any colour" class="absolute inset-0 opacity-0 cursor-pointer" :value="light.color"
            @input="patchLight({ color: ($event.target as HTMLInputElement).value })">
        </label>
      </div>
      <StudioSlider data-testid="relight-brightness" label="Brightness" :min="0" :max="4" :step="0.01" :default="1.4" :model-value="light.brightness" @update:model-value="(v: number) => patchLight({ brightness: v })" />
      <StudioSlider data-testid="relight-height" :label="`Height · ${heightWord(light.height)}`" :min="-0.3" :max="1" :step="0.01" :default="0.35" :model-value="light.height" @update:model-value="(v: number) => patchLight({ height: v })" />
      <StudioSlider data-testid="relight-reach" label="Reach" :min="0.1" :max="2" :step="0.01" :default="1" :model-value="light.reach" @update:model-value="(v: number) => patchLight({ reach: v })" />
    </section>

    <section class="space-y-2">
      <div class="text-white/40 uppercase tracking-[.04em] text-[11px]">Photo</div>
      <StudioSlider data-testid="relight-keep" label="Original light" title="How much of the photo's own lighting stays" :min="0" :max="1" :step="0.01" :default="0.35" :model-value="fx.keep" @update:model-value="(v: number) => emit('update', { keep: v })" />
      <StudioSlider data-testid="relight-depth" label="Depth" title="How strongly the photo's shape bends the light" :min="0" :max="20" :step="0.1" :default="4" :model-value="fx.depth" @update:model-value="(v: number) => emit('update', { depth: v })" />
      <StudioSlider data-testid="relight-texture" label="Texture" title="Fine relief from the photo itself: fur, pores, knit" :min="0" :max="8" :step="0.1" :default="2" :model-value="fx.texture" @update:model-value="(v: number) => emit('update', { texture: v })" />
      <StudioSlider data-testid="relight-shine" label="Shine" title="Glossy highlights" :min="0" :max="1" :step="0.01" :default="0" :model-value="fx.shine" @update:model-value="(v: number) => emit('update', { shine: v })" />
      <StudioSwitch data-testid="relight-shadows" label="Shadows" hint="Short contact shadows: hair on skin, chin on neck, folds" :model-value="fx.shadows" @update:model-value="(v: boolean) => emit('update', { shadows: v })" />
    </section>
  </div>
</template>
```

If `StudioSlider` does not forward `title`, wrap the label in `StudioHint` (the `FinishLightControl` pattern) instead. In either case the tooltip text must not appear in the panel text (the test checks this). If `StudioSwitch`'s `hint` prop renders visible text, change it to a tooltip in the same way.

- [ ] **Step 4: Wire it into CompositorModal's inspector**

Next to the `spot_uv` block (~11233), add:
```vue
<div v-else-if="activeEffect!.type === 'relight'" class="space-y-1.5">
  <p v-if="!relightAvailable()" class="text-[11px] text-white/50">{{ relightUnavailableReason() }}</p>
  <RelightControls
    :fx="sanitizeRelight(activeEffect)"
    :selected-light="relightLightId"
    :depth-status="activeEffectDepth ? depthStatusFor(activeEffectDepth) : 'error'"
    @update="(p) => updateActiveEffect(p)"
    @select-light="(id) => (relightLightId = id)"
    @compare="(on) => { setRelightBypass(on ? activeEffectLayer?.id ?? null : null); renderStack() }" />
</div>
```
Script additions: import `RelightControls`, `sanitizeRelight`, `relightAvailable`, `relightUnavailableReason`, `setRelightBypass`; `const relightLightId = ref<string | null>(null)`; `watch(activeEffect, v => { if (v?.type === 'relight') { const f = sanitizeRelight(v); if (!f.lights.some(l => l.id === relightLightId.value)) relightLightId.value = f.lights[0]?.id ?? null } })`. In `EFFECT_HINTS` (~2814) add `relight: 'Drag the lights on the photo to relight it'`. If `depthStatusFor` changes don't re-render the panel, bump a tick from the existing `onDepthChange` subscription as `PostEffectsControls.vue:102` does.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && pnpm vitest run tests/unit/relight-controls.unit.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit.** Paths: `frontend/app/components/vue-canvas/compositor/RelightControls.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/unit/relight-controls.unit.spec.ts` (your CompositorModal hunks only, see Task 6 Step 6). Message: `feat(relight): the Relight settings panel with setups, lights and photo controls (stage 1)`.

---

### Task 8: Light handles on the canvas, and the right-click entry

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`: handle computeds and pointer code next to `lightHandlePos` / `onLightPointerDown` (~2330-2352); the handle template next to `frame-light-handle` (~9676); the image context menu (~4111-4122); the canvas double-click handler.
- Modify: `frontend/app/composables/useLocalLayerEditor.ts` only if `setLocal` has no way to write without recording history (see Step 2).
- Test: covered by Task 9 (browser). This task has no unit test: its behaviour is pointer geometry on the real canvas, which unit tests cannot prove.

**Interfaces:**
- Consumes: `activeEffect`, `activeEffectLayer`, `updateActiveEffect`, `relightLightId` (Task 7), `recordHistory`, `boxPx`, `canvasDisplay`, `canvasRect`, `addLayerEffect`, `selectEffect`, `pinnedEffect`, `layerStack`.
- Produces: handles with `data-testid="relight-light-handle"` and `data-light-id`; a dim overlay with `data-testid="relight-dim"`; a context-menu item with `id: 'relight'`.

- [ ] **Step 1: Layer-fraction ↔ canvas-pixel conversion**

Next to `distortHandlePositions` (~2290), add:
```ts
const relightSelected = computed(() => activeEffect.value?.type === 'relight' && !!activeEffectLayer.value)
const relightFx = computed(() => (relightSelected.value ? sanitizeRelight(activeEffect.value) : null))
// Same geometry as distortHandlePositions / onDistortPointerDown (proven under rotation):
// boxPx is in canvas-display px, the layer centre is (l.x·W, l.y·H), rotation about it.
/** Layer fraction (0,0 = the layer box's top left, before rotation) → canvas display px. */
function relightToCanvas(fx: number, fy: number): { x: number; y: number } {
  const l = activeEffectLayer.value
  const W = canvasDisplay.w, H = canvasDisplay.h
  const box = boxPx(l)
  const cx = l.x * W, cy = l.y * H
  const rad = ((l.rotation || 0) * Math.PI) / 180, cosA = Math.cos(rad), sinA = Math.sin(rad)
  const dx = (fx - 0.5) * box.w, dy = (fy - 0.5) * box.h
  return { x: cx + dx * cosA - dy * sinA, y: cy + dx * sinA + dy * cosA }
}
/** A pointer event → layer fraction (the inverse), mapped through the canvas rect as distort does. */
function pointerToRelight(ev: { clientX: number; clientY: number }, r: DOMRect): { x: number; y: number } {
  const l = activeEffectLayer.value
  const W = canvasDisplay.w, H = canvasDisplay.h
  const box = boxPx(l)
  const mx = ((ev.clientX - r.left) / r.width) * W - l.x * W
  const my = ((ev.clientY - r.top) / r.height) * H - l.y * H
  const rad = ((l.rotation || 0) * Math.PI) / 180, cosA = Math.cos(rad), sinA = Math.sin(rad)
  const lx = mx * cosA + my * sinA, ly = -mx * sinA + my * cosA   // un-rotate into the layer box
  return { x: box.w ? lx / box.w + 0.5 : 0.5, y: box.h ? ly / box.h + 0.5 : 0.5 }
}
const relightHandles = computed(() => (relightFx.value?.lights ?? []).map(l => ({ l, ...relightToCanvas(l.x, l.y) })))
```

- [ ] **Step 2: Drag, wheel, double-click (one undo step per drag)**

```ts
function writeRelight(patch: Partial<RelightEffect>, record: boolean) {
  if (record) { updateActiveEffect(patch); return }
  // During a drag: write without a history entry (recordHistory() ran once at pointer-down).
  const sel = selectedEffect.value; const l = sel ? layerById(sel.layerId) : null
  if (!sel || !l) return
  const stack = layerStack(l).map(e => (e.id === sel.effectId ? { ...e, ...patch } : e))
  commit(localLayers.value.map((x: any) => (x.id === l.id ? { ...x, ...writeStackToLayer(stack) } : x)))
}
function onRelightHandleDown(e: PointerEvent, id: string) {
  if (viewOnlyGuard()) return
  e.preventDefault(); e.stopPropagation()
  relightLightId.value = id
  const r = canvasRect(); if (!r) return
  recordHistory()                                            // one undo step for the whole drag
  const move = (ev: PointerEvent) => {
    const f = relightFx.value; if (!f) return
    const p = pointerToRelight(ev, r)
    const x = Math.min(1.4, Math.max(-0.4, p.x)), y = Math.min(1.4, Math.max(-0.4, p.y))
    writeRelight({ lights: f.lights.map(l => (l.id === id ? { ...l, x, y } : l)) }, false)
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
function onRelightHandleWheel(e: WheelEvent, id: string) {
  e.preventDefault()
  const f = relightFx.value; if (!f) return
  writeRelight({ lights: f.lights.map(l => (l.id === id ? { ...l, height: Math.min(1, Math.max(-0.3, l.height - e.deltaY * 0.001)) } : l)) }, true)
}
function onRelightDoubleClick(e: MouseEvent) {
  const f = relightFx.value; if (!f || f.lights.length >= RELIGHT_MAX_LIGHTS) return
  const r = canvasRect(); if (!r) return
  const p = pointerToRelight(e, r)
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return      // only on the layer itself
  const l = { id: newLightId(), x: p.x, y: p.y, height: 0.35, color: '#f4f7ff', brightness: 1.4, reach: 1, on: true }
  updateActiveEffect({ lights: [...f.lights, l] })
  relightLightId.value = l.id
}
```
`commit`, `layerById`, `layerStack`, `writeStackToLayer` and `localLayers` already exist in CompositorModal (see the exploration notes: `commit` is exported from useLocalLayerEditor at line 917). If `commit` isn't destructured in CompositorModal, destructure it. Hook `onRelightDoubleClick` into the canvas `@dblclick` handler so that it runs first while `relightSelected` is true and returns early. Wheel on a handle records one history step per wheel event. That matches the other slider-like writes, so no coalescing is needed.

- [ ] **Step 3: Template: handles and the dim overlay**

Next to the `frame-light-handle` div (~9676):
```vue
<template v-if="relightSelected && !editingId && !genActive">
  <svg data-testid="relight-dim" class="absolute inset-0 pointer-events-none z-10" :width="canvasDisplay.w" :height="canvasDisplay.h">
    <defs><mask id="relight-hole">
      <rect :width="canvasDisplay.w" :height="canvasDisplay.h" fill="white" />
      <polygon :points="[relightToCanvas(0,0), relightToCanvas(1,0), relightToCanvas(1,1), relightToCanvas(0,1)].map(p => `${p.x},${p.y}`).join(' ')" fill="black" />
    </mask></defs>
    <rect :width="canvasDisplay.w" :height="canvasDisplay.h" fill="rgba(0,0,0,0.35)" mask="url(#relight-hole)" />
  </svg>
  <div v-for="h in relightHandles" :key="h.l.id" data-handle data-testid="relight-light-handle" :data-light-id="h.l.id"
    :aria-label="`Light ${relightFx!.lights.indexOf(h.l) + 1}`" title="Drag to move · scroll to raise or lower"
    class="absolute z-20 rounded-full cursor-grab"
    :style="{ left: h.x + 'px', top: h.y + 'px', transform: 'translate(-50%, -50%)',
      width: 14 + Math.max(0, h.l.height) * 26 + 'px', height: 14 + Math.max(0, h.l.height) * 26 + 'px',
      background: h.l.color, opacity: h.l.on ? 1 : 0.35,
      outline: h.l.height < 0 ? '1.5px dashed rgba(255,255,255,.8)' : 'none', outlineOffset: '4px',
      boxShadow: (h.l.id === relightLightId ? '0 0 0 2px #fff, 0 0 0 6px rgba(255,255,255,.22), ' : '0 0 0 2px rgba(255,255,255,.95), ') + `0 0 22px 6px ${h.l.color}99` }"
    @pointerdown="onRelightHandleDown($event, h.l.id)" @wheel="onRelightHandleWheel($event, h.l.id)" />
</template>
```

- [ ] **Step 4: Right-click Relight…**

In the image context menu items (~4111), after `edit-region`:
```ts
    { id: 'relight', label: 'Relight…', icon: Sun, action: () => { imageCtxMenu.value = null; relightStart(id) } },
```
with
```ts
function relightStart(layerId: string) {
  const l = layerById(layerId); if (!l) return
  const existing = layerStack(l).find(e => e.type === 'relight')
  if (existing) { selectEffect(layerId, existing.id); return }
  addLayerEffect(layerId, 'relight')                         // adds, expands the layer, selects it
}
```
`Sun` comes from `lucide-vue-next`, as the other menu icons do. Also mirror this for wired slots only if their context menu offers `Edit image…`; otherwise leave wired slots to the effects + menu.

- [ ] **Step 5: Type check and a manual smoke test**

Run: `cd frontend && pnpm exec vue-tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: not above the baseline.
Smoke check (no server restart): open `http://127.0.0.1:3002`, open a Frame with an image layer, right-click the photo → Relight…, then drag a light. If the Browser pane is hidden, rAF pauses and handles may not repaint. Use the Playwright spec in Task 9 as the proof instead.

- [ ] **Step 6: Commit.** Paths: `frontend/app/components/vue-canvas/CompositorModal.vue` (your hunks only) and `frontend/app/composables/useLocalLayerEditor.ts` if touched. Message: `feat(relight): drag, raise and add lights on the canvas; right-click Relight… (stage 1)`.

---

### Task 9: Browser check

**Files:**
- Create: `frontend/tests/relight-effect.spec.ts`

**Interfaces:**
- Consumes: everything above; helpers `openCompositor`, `stackPixels`, `setStudioRow` from `tests/_helpers`; test ids from Tasks 7–8; `__relightRuns` exposed for the test (see Step 1).

- [ ] **Step 1: Expose the run counter for the test**

In CompositorModal (or wherever `__dofRuns` is exposed for Playwright; search `__dofRuns` in `app/`), add `__relightRuns` the same way. If `__dofRuns` is not exposed on `window`, add in CompositorModal's `onMounted`: `if (import.meta.dev) (window as any).__relightRuns = __relightRuns`.

- [ ] **Step 2: Write the spec**

Model it on `tests/print-finishes.spec.ts`: seed a Frame through `page.evaluate`, as `seedFinishScene` does, with one **image** layer whose `filename` is `flux_lora_00165_.png` (present in `input/`; its depth map is cached). Keep a canvas corner empty.

```ts
// frontend/tests/relight-effect.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Relight (stage 1) — browser verification. Proves what a screenshot can't: the effect really
 * ran on the GPU (run counter, not the plain fallback), lights change the pixels, a drag is ONE
 * undo step, and the right-click entry adds and selects the effect.
 */

/** One image layer (the puppy, whose depth map is cached in input/sailor_depth), inset so a canvas corner stays empty. */
async function seedPhoto(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__compositorSetLayers([
      { id: 'pup', kind: 'image', filename: 'flux_lora_00165_.png', x: 0.5, y: 0.5, w: 0.8, h: 0.8, rotation: 0, opacity: 1, effects: [] },
    ])
  })
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length), { timeout: 10_000 }).toBe(1)
}
const runs = (page: Page) => page.evaluate(() => (window as any).__relightRuns?.() ?? -1)

/** Right-click the photo → Relight…, then wait until the GPU pass has actually run. */
async function addRelight(page: Page) {
  const runs0 = await runs(page)
  const box = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.getByText('Relight…', { exact: true }).click()
  await expect.poll(() => runs(page), { timeout: 15_000 }).toBeGreaterThan(runs0)
}

test.describe('Relight effect', () => {
  test('right-click Relight… adds the effect, selects it and relights the photo', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const before = await stackPixels(page)
    await addRelight(page)                                    // includes: the GPU pass really ran
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(1)
    await expect(page.getByTestId('relight-setup-Golden key')).toHaveAttribute('aria-pressed', 'true')
    expect(await stackPixels(page)).not.toBe(before)
  })

  test('dragging a light moves it and changes the picture; one undo restores it', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const handle = page.getByTestId('relight-light-handle').first()
    const b0 = (await handle.boundingBox())!
    const px0 = await stackPixels(page)
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
    await page.mouse.down()
    await page.mouse.move(b0.x - 260, b0.y + 140, { steps: 12 })
    await page.mouse.up()
    const b1 = (await handle.boundingBox())!
    expect(Math.hypot(b1.x - b0.x, b1.y - b0.y)).toBeGreaterThan(100)
    const px1 = await stackPixels(page)
    expect(px1).not.toBe(px0)
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await handle.boundingBox())!.x, { timeout: 5_000 }).toBeCloseTo(b0.x, 0)
    expect(await stackPixels(page)).toBe(px0)
  })

  test('setups switch the lights; Neon gives two handles and un-highlights after a change', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await page.getByTestId('relight-setup-Neon').click()
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(2)
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'true')
    const h = page.getByTestId('relight-light-handle').first()
    const b = (await h.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down()
    await page.mouse.move(b.x + 60, b.y + 40, { steps: 6 }); await page.mouse.up()
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'false')
  })

  test('Compare shows the photo without Relight while held', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const plain = await stackPixels(page)
    await addRelight(page)
    const lit = await stackPixels(page)
    const cmp = page.getByTestId('relight-compare')
    const cb = (await cmp.boundingBox())!
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down()
    await expect.poll(() => stackPixels(page)).toBe(plain)
    await page.mouse.up()
    await expect.poll(() => stackPixels(page)).toBe(lit)
  })
})
```
**Do not weaken the `__relightRuns` check.** A test that only compares pixels could pass on the plain fallback (memory: *graceful fallback hides failure*).

- [ ] **Step 3: Run it**

Run: `cd frontend && pnpm exec playwright test tests/relight-effect.spec.ts`
Expected: 4 passed. If the dev server on `:3002` is down or returns 500, **stop and report**; do not start one.

- [ ] **Step 4: Look at it**

Take one screenshot of the Frame editor after *Neon* (`page.screenshot` into the session scratchpad), and compare it by eye with the prototype at `/dev/relight?img=flux_lora_00165_.png` using the same setup. The look should match: no contour stripes, no bright outline round the puppy, no stair-steps on edges. List any difference in the handoff. Don't tune constants here: look questions go to the user.

- [ ] **Step 5: Commit.** Paths: `frontend/tests/relight-effect.spec.ts` and the one-line `__relightRuns` exposure file. Message: `test(relight): browser checks for Relight stage 1`.

---

### Task 10: Record the state

- [ ] Add a short *Relight, stage 1* entry to `docs/STATE.md` in its existing format: what landed, the commits, what's owed (stages 2–4, a web-export pre-render, and a hands-on trackpad pass by the user).
- [ ] Update the ⛵ State of the Build dashboard as `update-dashboard-on-every-commit` says. Read the live artifact first (`Artifact` `action: read`, `https://claude.ai/code/artifact/beb788b5-493b-4597-aa66-ce8a5609df89`), replace rather than append, and pass `url` on republish.
- [ ] Commit `docs/STATE.md` alone. Message: `docs(state): Relight stage 1 landed`.

---

## Self-review notes

- **Spec coverage (stage 1):** effect in the + menu (Task 5); right-click shortcut (Task 8); image and wired layers (Tasks 6, 8); handles with drag, the wheel for height, the dashed ring for behind, double-click to add, at most 3, one undo per drag (Task 8); the dimmed rest of the Frame (Task 8); Compare (Tasks 6, 7); settings panel with setups, lights, per-light controls and the photo controls (Task 7); local depth with a loading status (Tasks 6, 7); shader lessons: stripes and halo (Task 2), stair-steps (Task 2), ridge lines, contact-only shadows, Shine 0 (Task 4); pinned GPU kind after `dof` (Task 5). Web export shows a *left out* notice rather than silently dropping Relight (Task 5). The spec's pre-rendered export is owed and recorded in Task 10.
- **Deliberately not here:** MoGe surfaces and the *Reading shape* swap (stage 2), Finish (stage 3), *Use Frame light* and Motion dials (stage 4), the node (parked).
- **Known risk:** `relightDepthFieldFor` runs on the main thread, once per image (a 7×7 guided upsample at up to 1536 px, estimated at a few hundred ms). If Task 9 shows a visible hitch when Relight is first added, the follow-up is to move `buildDepthField` into a Web Worker. It is recorded, not built.
