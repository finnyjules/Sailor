# Cloner Vary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let both cloners vary colour (and the existing step transforms) across their copies, driven by a sequence ramp, a seeded random, or a positional falloff.

**Architecture:** One pure `lib/vary/` module turns a per-copy step index into a weight in `[0,1]` and maps that weight onto a palette colour. The 3D Studio cloner splits into `planClones` (a list of copy recipes) + `mergeClones` (today's merge, now writing a per-vertex colour attribute), so one object stays one mesh. The Frame cloner carries a resolved tint per copy and applies it with a `source-atop` fill at each of three existing draw sites, mirrored in the Python compositor.

**Tech Stack:** TypeScript, Vue 3 / Nuxt 4, three.js, Canvas 2D, Vitest (`tests/unit/**/*.unit.spec.ts`), Python + PIL (`comfy_extras/nodes_compositor.py`), pytest.

**Spec:** `docs/superpowers/specs/2026-09-06-cloner-vary-design.md`

## Global Constraints

- **Zero-change guarantee.** A document with no vary settings must produce byte-identical clone transforms, no `color` geometry attribute, and no scratch-canvas detour. Every task that touches a render path proves this with a test.
- **Sequence mode uses today's exact maths**, not the general weight lerp. Random and falloff use the lerp. This is the regression guard for every saved scene.
- **Seeded hash is specified, not language-native.** `hash32(i, seed)` below is the single definition; TypeScript and Python must both implement exactly it. No `Math.random`, no `random.Random`, no float accumulation.
- **`MODIFIER_SPECS` option lists are append-only.** Stored values are option INDEXES; inserting or reordering silently remaps every saved scene.
- **UI copy rule (standing project rule):** sentence case everywhere; never surface an internal identifier in a label, blurb or hint; every picker whose stored values are internal (`sequence`, `falloff`, `cycle`, `blend`) needs readable option labels.
- **Test commands:** `cd frontend && npx vitest run tests/unit/<file>` for one unit file; `cd frontend && npm run test:unit` for all; `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/<file> -v` for Python.
- **Do not run `npx vue-tsc`** — it is not installed in this repo. Use `cd frontend && npx nuxt typecheck` if a type check is needed.

## Storage decision (refines the spec)

The spec described "a new optional `vary` object". Implementation splits it, because the two hosts have different schemas:

- **3D Studio** keeps its flat `Record<string, number>` modifier bag. The seven numeric vary dials become new `MODIFIER_SPECS` entries (`varyMode`, `varySeed`, `varyFalloffCenter`, `varyFalloffRadius`, `varyColor`, `varyColorSpread`, `varyColorStrength`). This buys sanitization, the geo cache key, inspector rows, agent addressability and Collection var-binding for free. Only the palette — a `string[]` — cannot live in a number bag, so it becomes `varyPalette?: string[]` on `PrimitiveObject`, exactly as Shape Studio's `fills` is a bespoke list beside its numeric schema.
- **Frame** has no such schema; `Cloner` is a flat interface. The same fields go on it directly as siblings of `stepRotation`.

Both adapt into one normalized `VarySettings` for the shared module, so the maths has a single home.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/vary/index.ts` (create) | The whole shared model: types, `hash32`, `varyWeights`, `varyColorAt`, `varyStepFactor`. Pure — no three, no canvas, no DOM. |
| `frontend/tests/unit/vary.unit.spec.ts` (create) | Unit tests for the above. |
| `frontend/app/components/vue-canvas/VaryPalette.vue` (create) | The shared swatch-list editor used by both surfaces. |
| `frontend/app/lib/scene3d/primParams.ts` (modify) | The seven numeric vary keys appended to `MODIFIER_SPECS`. |
| `frontend/app/lib/scene3d/config.ts` (modify) | `varyPalette?: string[]` on `PrimitiveObject` + sanitization. |
| `frontend/app/lib/scene3d/modifiers.ts` (modify) | `planClones` / `mergeClones` split; vertex colour attribute. |
| `frontend/app/lib/scene3d/engine.ts` (modify) | Thread the palette through `buildGeometry` / `geoKeyFor`; pass geometry to `updateMaterial`. |
| `frontend/app/lib/scene3d/materials.ts` (modify) | `vertexColors` detection in `materialFor`; rebuild-on-flip in `updateMaterial`. |
| `frontend/app/lib/scene3d/panelPresentation.ts` (modify) | Route `vary*` keys to the Cloner card; the vary rows and palette anchor. |
| `frontend/app/lib/scene3d/controls.ts` (modify) | Relevance gating: hide colour rows for `image` / `shaderFill`. |
| `frontend/app/composables/useCloner.ts` (modify) | Vary fields on `Cloner`; `weight` / `tint` / `tintStrength` on `CloneTransform`. |
| `frontend/app/composables/useCompositorLayers.ts` (modify) | Tint at the three draw sites. |
| `frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue` (modify) | The Vary block. |
| `comfy_extras/nodes_compositor.py` (modify) | Mirror of `expandClones` + PIL tint. |
| `tests-unit/comfy_extras_test/cloner_vary_test.py` (create) | Python-side + cross-language parity assertions. |

---

### Task 1: The shared Vary module

**Files:**
- Create: `frontend/app/lib/vary/index.ts`
- Test: `frontend/tests/unit/vary.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type VaryMode = 'sequence' | 'random' | 'falloff'`
  - `type VarySpread = 'cycle' | 'blend'`
  - `interface VarySettings { mode: VaryMode; seed: number; falloffCenter: number; falloffRadius: number; colorEnabled: boolean; palette: string[]; spread: VarySpread; strength: number }`
  - `const DEFAULT_VARY: VarySettings`
  - `function hash32(i: number, seed: number): number` — returns `[0,1)`
  - `function varyWeights(steps: number[], v: VarySettings): number[]`
  - `function varyColorAt(w: number, index: number, v: VarySettings): string | undefined`
  - `function varyStepFactor(w: number, v: VarySettings): number`
  - `function mixHex(a: string, b: string, t: number): string`

**Why `steps: number[]` and not a count.** The Frame grid cloner's step index is `k = |iy|*nx + |ix|`, which is sparse and repeats across mirrored twins — mirrored copies deliberately share a falloff step. Passing the actual step array lets both cloners keep their own notion of "how far along" a copy is, and normalises by `max(steps)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/vary.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VARY, hash32, varyWeights, varyColorAt, varyStepFactor, mixHex,
  type VarySettings,
} from '~/lib/vary'

const V = (over: Partial<VarySettings> = {}): VarySettings => ({ ...DEFAULT_VARY, ...over })

describe('hash32', () => {
  it('is in [0,1) and stable for a given (i, seed)', () => {
    for (let i = 0; i < 50; i++) {
      const h = hash32(i, 7)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
    expect(hash32(3, 7)).toBe(hash32(3, 7))
  })

  it('decorrelates neighbouring indexes and neighbouring seeds', () => {
    expect(hash32(3, 7)).not.toBe(hash32(4, 7))
    expect(hash32(3, 7)).not.toBe(hash32(3, 8))
  })

  // Pins the exact routine so the Python mirror can assert the same numbers.
  it('matches the pinned reference values', () => {
    const got = [0, 1, 2, 3].map((i) => Number(hash32(i, 7).toFixed(9)))
    expect(got).toEqual(REFERENCE_HASHES)
  })
})

// Filled in at Step 3 from the implementation's own output, then frozen. The
// Python parity test (Task 9) asserts against this same list.
const REFERENCE_HASHES: number[] = []

describe('varyWeights', () => {
  it('gives a single copy weight 0 in every mode', () => {
    for (const mode of ['sequence', 'random', 'falloff'] as const) {
      expect(varyWeights([0], V({ mode }))).toEqual([0])
    }
  })

  it('sequence ramps 0 to 1 across the step range', () => {
    expect(varyWeights([0, 1, 2, 3], V())).toEqual([0, 1 / 3, 2 / 3, 1])
  })

  it('sequence gives mirrored twins the same weight (repeated steps)', () => {
    const w = varyWeights([0, 1, 1, 2], V())
    expect(w[1]).toBe(w[2])
    expect(w[3]).toBe(1)
  })

  it('random is inside [0,1) and reshuffles with the seed', () => {
    const a = varyWeights([0, 1, 2, 3], V({ mode: 'random', seed: 1 }))
    const b = varyWeights([0, 1, 2, 3], V({ mode: 'random', seed: 2 }))
    for (const x of a) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1) }
    expect(a).not.toEqual(b)
  })

  it('falloff peaks at the centre and reaches 0 past the radius', () => {
    const v = V({ mode: 'falloff', falloffCenter: 0, falloffRadius: 0.5 })
    const w = varyWeights([0, 1, 2, 3], v)
    expect(w[0]).toBe(1)
    expect(w[3]).toBe(0)
    expect(w[1]).toBeGreaterThan(w[2]!)
  })

  it('falloff centred mid-array peaks in the middle', () => {
    const v = V({ mode: 'falloff', falloffCenter: 0.5, falloffRadius: 1 })
    const w = varyWeights([0, 1, 2, 3, 4], v)
    expect(w[2]).toBe(1)
    expect(w[0]).toBeCloseTo(w[4]!, 10)
    expect(w[0]).toBeLessThan(w[2]!)
  })
})

describe('varyColorAt', () => {
  const pal = ['#ff0000', '#00ff00', '#0000ff']

  it('returns undefined when colour is off', () => {
    expect(varyColorAt(0.5, 1, V({ palette: pal }))).toBeUndefined()
  })

  it('returns undefined for an empty palette even when enabled', () => {
    expect(varyColorAt(0.5, 1, V({ colorEnabled: true, palette: [] }))).toBeUndefined()
  })

  it('cycle in sequence mode walks the palette by index', () => {
    const v = V({ colorEnabled: true, palette: pal, spread: 'cycle' })
    expect(varyColorAt(0, 0, v)).toBe('#ff0000')
    expect(varyColorAt(0, 1, v)).toBe('#00ff00')
    expect(varyColorAt(0, 3, v)).toBe('#ff0000')
  })

  it('cycle in random mode picks the swatch by weight, never out of range', () => {
    const v = V({ mode: 'random', colorEnabled: true, palette: pal, spread: 'cycle' })
    expect(varyColorAt(0, 0, v)).toBe('#ff0000')
    expect(varyColorAt(0.999999, 0, v)).toBe('#0000ff')
    expect(varyColorAt(1, 0, v)).toBe('#0000ff')
  })

  it('blend hits the palette ends exactly and interpolates between', () => {
    const v = V({ colorEnabled: true, palette: pal, spread: 'blend' })
    expect(varyColorAt(0, 0, v)).toBe('#ff0000')
    expect(varyColorAt(1, 2, v)).toBe('#0000ff')
    expect(varyColorAt(0.5, 1, v)).toBe('#00ff00')
  })
})

describe('varyStepFactor', () => {
  it('is 1 in sequence mode regardless of weight, so existing maths is untouched', () => {
    expect(varyStepFactor(0, V())).toBe(1)
    expect(varyStepFactor(0.4, V())).toBe(1)
  })

  it('is the weight in random and falloff modes', () => {
    expect(varyStepFactor(0.4, V({ mode: 'random' }))).toBe(0.4)
    expect(varyStepFactor(0.4, V({ mode: 'falloff' }))).toBe(0.4)
  })
})

describe('mixHex', () => {
  it('returns the endpoints exactly', () => {
    expect(mixHex('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(mixHex('#ff0000', '#0000ff', 1)).toBe('#0000ff')
  })

  it('mixes toward the target', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vary.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/vary"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/lib/vary/index.ts`:

```ts
/**
 * Cloner Vary — the shared per-copy variation model behind BOTH cloners
 * (3D Studio's `lib/scene3d/modifiers.ts` and Frame's `composables/useCloner.ts`).
 *
 * Pure by contract: no three.js, no canvas, no DOM. That is what lets the two
 * renderers, the Python compositor mirror and the unit tests all agree.
 *
 * Two jobs:
 *   1. `varyWeights` turns each copy's STEP INDEX into a weight in [0,1] under
 *      one of three drivers.
 *   2. `varyColorAt` / `varyStepFactor` turn a weight into a value.
 *
 * Why steps rather than a count: Frame's grid cloner indexes copies by
 * `k = |iy|*nx + |ix|`, which is sparse and deliberately repeats across mirrored
 * twins (a mirrored clone gets the same falloff as its positive twin). Passing
 * the real step array preserves that, and normalising by `max(steps)` keeps
 * 3D's dense `0..n-1` working unchanged.
 */

export type VaryMode = 'sequence' | 'random' | 'falloff'
export type VarySpread = 'cycle' | 'blend'

export interface VarySettings {
  mode: VaryMode
  /** Random mode only. Integer. */
  seed: number
  /** Falloff mode only. Position of the peak, as a fraction of the step range. */
  falloffCenter: number
  /** Falloff mode only. How far the effect reaches, as a fraction of the step range. */
  falloffRadius: number
  colorEnabled: boolean
  /** 2..8 hex swatches. An empty palette disables colour regardless of the flag. */
  palette: string[]
  spread: VarySpread
  /** 0 = no colour change, 1 = the full palette colour. */
  strength: number
}

export const DEFAULT_VARY: VarySettings = {
  mode: 'sequence',
  seed: 0,
  falloffCenter: 0,
  falloffRadius: 0.5,
  colorEnabled: false,
  palette: ['#4c6ef5', '#f59f00'],
  spread: 'cycle',
  strength: 1,
}

export const VARY_MODES: VaryMode[] = ['sequence', 'random', 'falloff']
export const VARY_SPREADS: VarySpread[] = ['cycle', 'blend']
/** A palette longer than this is refused by the editors; the maths does not care. */
export const VARY_PALETTE_MAX = 8

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * The seeded hash. SPECIFIED, not borrowed: `_hash32` in
 * comfy_extras/nodes_compositor.py must reproduce these exact values, so this is
 * written in explicit 32-bit integer operations with no language-native RNG and
 * no float accumulation. Do not "improve" it without changing the mirror and
 * re-pinning the reference values in tests/unit/vary.unit.spec.ts.
 */
export function hash32(i: number, seed: number): number {
  let h = (Math.trunc(i) | 0) ^ Math.imul(Math.trunc(seed) | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** Smoothstep on an already-normalised t. */
const smooth = (t: number) => t * t * (3 - 2 * t)

/**
 * One weight in [0,1] per copy.
 *
 * A single copy is weight 0 in every mode: there is no "across" to ramp along,
 * and 0 is the value that leaves the existing step maths at identity.
 */
export function varyWeights(steps: number[], v: VarySettings): number[] {
  const n = steps.length
  if (n === 0) return []
  let maxStep = 0
  for (const s of steps) if (s > maxStep) maxStep = s
  if (maxStep <= 0) return steps.map(() => 0)

  if (v.mode === 'random') {
    return steps.map((_, i) => hash32(i, v.seed))
  }

  if (v.mode === 'falloff') {
    const r = Math.max(1e-6, v.falloffRadius)
    return steps.map((s) => {
      const d = Math.abs(s / maxStep - clamp01(v.falloffCenter))
      return smooth(clamp01(1 - clamp01(d / r)))
    })
  }

  // sequence
  return steps.map((s) => clamp01(s / maxStep))
}

/**
 * The copy's colour, or undefined when colour variation is off. `index` is the
 * copy's ordinal (used by cycle in sequence mode); `w` is its weight.
 *
 * `strength` is NOT applied here — the caller blends toward whatever base colour
 * it has (a material colour in 3D, the drawn pixels in Frame), which this module
 * cannot see.
 */
export function varyColorAt(w: number, index: number, v: VarySettings): string | undefined {
  if (!v.colorEnabled) return undefined
  const pal = v.palette
  if (!pal || pal.length === 0) return undefined
  if (pal.length === 1) return pal[0]

  if (v.spread === 'cycle') {
    // Sequence walks the palette in order — the Shape Studio per-clone look.
    // The other two drivers have no meaningful order, so the weight chooses.
    if (v.mode === 'sequence') return pal[((index % pal.length) + pal.length) % pal.length]
    return pal[Math.min(pal.length - 1, Math.floor(clamp01(w) * pal.length))]
  }

  // blend: walk the palette as an even ramp, ends hit exactly.
  const t = clamp01(w) * (pal.length - 1)
  const i0 = Math.min(pal.length - 1, Math.floor(t))
  const i1 = Math.min(pal.length - 1, i0 + 1)
  return mixHex(pal[i0]!, pal[i1]!, t - i0)
}

/**
 * How much of the accumulated step transform this copy gets.
 *
 * Sequence returns 1 — the existing accumulate-by-index maths is used verbatim,
 * which is what guarantees every saved scene renders exactly as before. Random
 * and falloff scale it by the weight.
 */
export function varyStepFactor(w: number, v: VarySettings): number {
  return v.mode === 'sequence' ? 1 : clamp01(w)
}

// ── hex helpers ───────────────────────────────────────────────────────────────

/** `#rgb` / `#rrggbb` / `#rrggbbaa` → [r,g,b] 0..255. Alpha is dropped. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  if (h.length === 8) h = h.slice(0, 6)
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/**
 * Linear sRGB-space mix. Deliberately NOT OKLCH: this same interpolation has to
 * run identically in Python (PIL) for the wired compositor, and a perceptual
 * space would need the whole conversion chain mirrored there for a difference
 * only visible between distant hues. The palette editor gives the user direct
 * control over the intermediate swatches, which is the better lever anyway.
 */
export function mixHex(a: string, b: string, t: number): string {
  const k = clamp01(t)
  if (k === 0) return a
  if (k === 1) return b
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return rgbToHex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k)
}
```

- [ ] **Step 4: Pin the reference hashes**

Run this to print the real values, then paste them into `REFERENCE_HASHES` in the spec file:

```bash
cd frontend && npx vitest run tests/unit/vary.unit.spec.ts 2>&1 | head -40
```

The pinned-values test will fail first with the actual array in its diff. Copy those four numbers into `const REFERENCE_HASHES: number[] = [...]`. They are the contract the Python mirror is held to in Task 9 — once pinned, never edit them.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vary.unit.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/vary/index.ts frontend/tests/unit/vary.unit.spec.ts
git commit -m "feat(vary): shared per-copy variation model for both cloners"
```

---

### Task 2: 3D storage — schema keys, palette field, allowlist audit

**Files:**
- Modify: `frontend/app/lib/scene3d/primParams.ts` (append to `MODIFIER_SPECS`, ends ~L258)
- Modify: `frontend/app/lib/scene3d/config.ts` (`PrimitiveObject`, ~L353; sanitization ~L1395)
- Test: `frontend/tests/unit/scene3d-vary-storage.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `VARY_PALETTE_MAX`, `DEFAULT_VARY` from `~/lib/vary` (Task 1).
- Produces:
  - Seven `MODIFIER_SPECS` keys: `varyMode`, `varySeed`, `varyFalloffCenter`, `varyFalloffRadius`, `varyColor`, `varyColorSpread`, `varyColorStrength`.
  - `PrimitiveObject.varyPalette?: string[]`.
  - `function sanitizeVaryPalette(raw: unknown): string[] | undefined` exported from `config.ts`.
  - `function varySettingsFor(obj: PrimitiveObject): VarySettings` exported from `primParams.ts` — the adapter from bag + palette to the shared type.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-vary-storage.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MODIFIER_SPECS, modifierValue, varySettingsFor } from '~/lib/scene3d/primParams'
import { sanitizeVaryPalette } from '~/lib/scene3d/config'
import { DEFAULT_VARY } from '~/lib/vary'

const KEYS = ['varyMode', 'varySeed', 'varyFalloffCenter', 'varyFalloffRadius',
  'varyColor', 'varyColorSpread', 'varyColorStrength']

describe('vary modifier schema', () => {
  it('declares every vary key', () => {
    for (const k of KEYS) expect(MODIFIER_SPECS.find((s) => s.key === k), k).toBeTruthy()
  })

  it('defaults to the identity — a fresh object has no variation', () => {
    expect(modifierValue(undefined, 'varyMode')).toBe(0)
    expect(modifierValue(undefined, 'varyColor')).toBe(0)
    expect(modifierValue(undefined, 'varyColorStrength')).toBe(1)
  })

  it('keeps the option lists append-only in their pinned order', () => {
    const mode = MODIFIER_SPECS.find((s) => s.key === 'varyMode')!
    expect(mode.options).toEqual(['sequence', 'random', 'falloff'])
    const spread = MODIFIER_SPECS.find((s) => s.key === 'varyColorSpread')!
    expect(spread.options).toEqual(['cycle', 'blend'])
  })
})

describe('sanitizeVaryPalette', () => {
  it('drops anything that is not a list of hex strings', () => {
    expect(sanitizeVaryPalette(undefined)).toBeUndefined()
    expect(sanitizeVaryPalette('#ff0000')).toBeUndefined()
    expect(sanitizeVaryPalette([])).toBeUndefined()
    expect(sanitizeVaryPalette(['nope', 42])).toBeUndefined()
  })

  it('keeps valid swatches and caps the length', () => {
    expect(sanitizeVaryPalette(['#ff0000', '#0f0'])).toEqual(['#ff0000', '#0f0'])
    const long = Array.from({ length: 12 }, () => '#123456')
    expect(sanitizeVaryPalette(long)!.length).toBe(8)
  })
})

describe('varySettingsFor', () => {
  const obj = (modifiers?: Record<string, number>, varyPalette?: string[]) =>
    ({ id: 'o', kind: 'primitive', primitive: 'box', modifiers, varyPalette }) as never

  it('reads the identity for an untouched object', () => {
    const v = varySettingsFor(obj())
    expect(v.mode).toBe('sequence')
    expect(v.colorEnabled).toBe(false)
    expect(v.palette).toEqual(DEFAULT_VARY.palette)
  })

  it('maps the stored indexes back to names', () => {
    const v = varySettingsFor(obj({ varyMode: 2, varyColor: 1, varyColorSpread: 1 }), ['#abcdef'])
    expect(v.mode).toBe('falloff')
    expect(v.spread).toBe('blend')
    expect(v.colorEnabled).toBe(true)
    expect(v.palette).toEqual(['#abcdef'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-storage.unit.spec.ts`
Expected: FAIL — `varySettingsFor` and `sanitizeVaryPalette` are not exported.

- [ ] **Step 3: Append the schema keys**

In `frontend/app/lib/scene3d/primParams.ts`, append to `MODIFIER_SPECS` immediately after the `cloneStepScale` entry (the last element, ~L258):

```ts
  // Vary keys — per-copy variation across the cloner's copies. Numeric dials only;
  // the PALETTE is a string[] and lives on the object as `varyPalette` (see config.ts),
  // exactly as Shape Studio keeps its `fills` list beside its numeric schema.
  // Every default is the identity, so an existing scene renders unchanged.
  // Option lists are APPEND-ONLY — the stored value is the option INDEX.
  { key: 'varyMode', label: 'Vary', hint: 'How a property changes from one copy to the next — evenly along the sequence, randomly, or strongest near a point', min: 0, max: 2, step: 1, default: 0, control: 'options', options: ['sequence', 'random', 'falloff'] },
  { key: 'varySeed', label: 'Vary seed', hint: 'Shuffles the random variation into a different arrangement', min: 0, max: 99, step: 1, default: 0 },
  { key: 'varyFalloffCenter', label: 'Centre', hint: 'Where along the copies the variation is strongest', min: 0, max: 1, step: 0.01, default: 0 },
  { key: 'varyFalloffRadius', label: 'Reach', hint: 'How far from the centre the variation still applies', min: 0.01, max: 1, step: 0.01, default: 0.5 },
  { key: 'varyColor', label: 'Vary colour', hint: 'Give each copy its own colour from a palette', min: 0, max: 1, step: 1, default: 0, control: 'options', options: ['off', 'on'] },
  { key: 'varyColorSpread', label: 'Spread', hint: 'Cycle gives each copy one whole palette colour; Blend fades between them', min: 0, max: 1, step: 1, default: 0, control: 'options', options: ['cycle', 'blend'] },
  { key: 'varyColorStrength', label: 'Colour strength', hint: 'How far each copy moves from the material colour toward its palette colour', min: 0, max: 1, step: 0.01, default: 1 },
```

Then add the adapter at the end of the same file:

```ts
import { DEFAULT_VARY, VARY_MODES, VARY_SPREADS, type VarySettings } from '~/lib/vary'

/** The object's vary settings in the shared module's vocabulary: the numeric bag
 *  supplies the dials, `varyPalette` the swatches. Falls back to the shared
 *  defaults so an untouched object reads as "no variation". */
export function varySettingsFor(obj: { modifiers?: Record<string, number>; varyPalette?: string[] }): VarySettings {
  const m = (k: string) => modifierValue(obj.modifiers, k)
  const pal = obj.varyPalette && obj.varyPalette.length > 0 ? obj.varyPalette : DEFAULT_VARY.palette
  return {
    mode: VARY_MODES[Math.round(m('varyMode'))] ?? 'sequence',
    seed: Math.round(m('varySeed')),
    falloffCenter: m('varyFalloffCenter'),
    falloffRadius: m('varyFalloffRadius'),
    colorEnabled: Math.round(m('varyColor')) === 1,
    palette: pal,
    spread: VARY_SPREADS[Math.round(m('varyColorSpread'))] ?? 'cycle',
    strength: m('varyColorStrength'),
  }
}
```

- [ ] **Step 4: Add the palette field and its sanitizer**

In `frontend/app/lib/scene3d/config.ts`, add to the `PrimitiveObject` interface beside `modifiers` (~L353):

```ts
  /** Cloner Vary palette — 1..8 hex swatches the copies are coloured from. A
   *  string[] rather than a `MODIFIER_SPECS` key because that bag is numbers
   *  only; the numeric vary dials DO live there. Absent means the shared default
   *  palette (which only matters once `varyColor` is switched on). */
  varyPalette?: string[]
```

Add the sanitizer next to `sanitizeModifiers`'s usage:

```ts
import { VARY_PALETTE_MAX } from '~/lib/vary'

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Keep only genuine hex swatches, capped at the editor's ceiling. Returns
 *  undefined for anything unusable so the field stays absent rather than empty. */
export function sanitizeVaryPalette(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((s): s is string => typeof s === 'string' && HEX_RE.test(s.trim()))
    .map((s) => s.trim())
    .slice(0, VARY_PALETTE_MAX)
  return out.length > 0 ? out : undefined
}
```

Then in the object sanitization block (~L1395, where `sanitizeModifiers(o.modifiers)` is called), thread it through the same way `modifiers` is:

```ts
          const modifiers = sanitizeModifiers(o.modifiers)
          const varyPalette = sanitizeVaryPalette(o.varyPalette)
          // ... existing object spread, adding:
            ...(modifiers ? { modifiers } : {}),
            ...(varyPalette ? { varyPalette } : {}),
```

- [ ] **Step 5: Audit every place a scene object is reconstructed**

This codebase has twice lost new `SceneObject` fields to allowlists that copy known keys. Find them and extend each:

```bash
cd frontend && grep -rn "modifiers" app/lib/scene3d/toMesh.ts app/lib/scene3d/glb.ts app/lib/scene3d/rebake.ts app/lib/scene3d/hierarchy.ts app/lib/scene3d/primGroups.ts
```

For every hit that builds a new object by listing fields, add `varyPalette` alongside `modifiers`. Record in the commit message which files you changed. If a file spreads the source object (`...obj`) rather than listing fields, it needs no change — say so explicitly rather than silently skipping it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-storage.unit.spec.ts`
Expected: PASS.

Then confirm nothing else broke:

Run: `cd frontend && npm run test:unit`
Expected: no NEW failures versus the pre-task baseline. Capture the baseline first with `git stash && npm run test:unit; git stash pop` if you are unsure — this repo has pre-existing failures and counts drift under load.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/primParams.ts frontend/app/lib/scene3d/config.ts frontend/tests/unit/scene3d-vary-storage.unit.spec.ts
git commit -m "feat(scene3d): vary schema keys and palette storage"
```

---

### Task 3: 3D render — the recipe seam and vertex colours

**Files:**
- Modify: `frontend/app/lib/scene3d/modifiers.ts` (`applyCloner` ~L241-287; `applyModifiers` ~L289-349)
- Test: `frontend/tests/unit/scene3d-cloner-recipes.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `varyWeights`, `varyColorAt`, `varyStepFactor`, `type VarySettings` from `~/lib/vary` (Task 1).
- Produces:
  - `interface CloneRecipe { index: number; matrix: THREE.Matrix4; weight: number; color?: string }`
  - `function planClones(total: number, s: ClonerSettings, vary?: VarySettings): CloneRecipe[]`
  - `function mergeClones(geo: THREE.BufferGeometry, recipes: CloneRecipe[]): THREE.BufferGeometry`
  - `applyModifiers(geo, modifiers, vary?)` — third parameter added, optional.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-cloner-recipes.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { planClones, mergeClones, applyModifiers } from '~/lib/scene3d/modifiers'
import { DEFAULT_VARY, type VarySettings } from '~/lib/vary'

const SETTINGS = {
  mode: 0, offset: [1, 0, 0] as [number, number, number], radius: 1, axis: 1,
  gridCount: [2, 2, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number],
  stepRot: [0, 0, 0] as [number, number, number], stepScale: 1,
}
const V = (over: Partial<VarySettings> = {}): VarySettings => ({ ...DEFAULT_VARY, ...over })

describe('planClones', () => {
  it('produces one recipe per copy with ascending indexes', () => {
    const r = planClones(4, SETTINGS)
    expect(r.length).toBe(4)
    expect(r.map((x) => x.index)).toEqual([0, 1, 2, 3])
  })

  it('places linear copies along the offset, unchanged from before', () => {
    const r = planClones(3, SETTINGS)
    const p = r.map((x) => new THREE.Vector3().setFromMatrixPosition(x.matrix).x)
    expect(p).toEqual([0, 1, 2])
  })

  it('assigns no colour when vary is absent or colour is off', () => {
    expect(planClones(3, SETTINGS).every((x) => x.color === undefined)).toBe(true)
    expect(planClones(3, SETTINGS, V()).every((x) => x.color === undefined)).toBe(true)
  })

  it('cycles the palette across copies when colour is on', () => {
    const r = planClones(4, SETTINGS, V({ colorEnabled: true, palette: ['#ff0000', '#00ff00'] }))
    expect(r.map((x) => x.color)).toEqual(['#ff0000', '#00ff00', '#ff0000', '#00ff00'])
  })

  it('leaves sequence-mode step transforms bit-identical to the un-varied plan', () => {
    const s = { ...SETTINGS, stepScale: 0.9, stepRot: [0, 30, 0] as [number, number, number] }
    const plain = planClones(5, s)
    const varied = planClones(5, s, V())
    for (let i = 0; i < 5; i++) {
      expect(varied[i]!.matrix.elements).toEqual(plain[i]!.matrix.elements)
    }
  })

  it('scales the step transform by the weight in falloff mode', () => {
    const s = { ...SETTINGS, stepScale: 0.5 }
    const v = V({ mode: 'falloff', falloffCenter: 0, falloffRadius: 0.01 })
    const r = planClones(4, s, v)
    // Beyond the reach, weight is 0 → the step is fully damped → uniform scale 1.
    const last = new THREE.Vector3().setFromMatrixScale(r[3]!.matrix)
    expect(last.x).toBeCloseTo(1, 6)
  })
})

describe('mergeClones', () => {
  const box = () => new THREE.BoxGeometry(1, 1, 1)

  it('writes no colour attribute when no recipe carries one', () => {
    const g = mergeClones(box(), planClones(3, SETTINGS))
    expect(g.getAttribute('color')).toBeUndefined()
  })

  it('writes one colour per copy when recipes carry colours', () => {
    const base = box()
    const per = base.getAttribute('position').count
    const recipes = planClones(2, SETTINGS, V({ colorEnabled: true, palette: ['#ff0000', '#0000ff'] }))
    const g = mergeClones(base, recipes)
    const col = g.getAttribute('color')!
    expect(col.count).toBe(per * 2)
    // Copy 0 is pure red, copy 1 pure blue (linear-space, so 1 and 0 stay exact).
    expect(col.getX(0)).toBeCloseTo(1, 5)
    expect(col.getZ(0)).toBeCloseTo(0, 5)
    expect(col.getX(per)).toBeCloseTo(0, 5)
    expect(col.getZ(per)).toBeCloseTo(1, 5)
  })
})

describe('applyModifiers regression guard', () => {
  it('returns the input untouched when nothing is set', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifiers(g, undefined)).toBe(g)
    expect(applyModifiers(g, undefined, DEFAULT_VARY)).toBe(g)
  })

  it('adds no colour attribute for a cloned object with vary untouched', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    const out = applyModifiers(g, { cloneCount: 4 }, DEFAULT_VARY)
    expect(out.getAttribute('color')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-cloner-recipes.unit.spec.ts`
Expected: FAIL — `planClones` and `mergeClones` are not exported.

- [ ] **Step 3: Split `applyCloner` into the recipe seam**

In `frontend/app/lib/scene3d/modifiers.ts`, replace the whole `applyCloner` function (~L241-287) with the two below, keeping the existing `ClonerSettings` interface above them exactly as it is:

```ts
/** One copy's placement, plus whatever the Vary drivers resolved for it.
 *
 *  THIS IS THE REUSABLE UNIT. Today one consumer (`mergeClones`) folds recipes
 *  into a single merged geometry, which is what keeps a cloned object ONE mesh
 *  and leaves treatments, outlines, sculpt, decals, picking and GLB export
 *  untouched. A future InstancedMesh renderer (for thousands of copies, or
 *  per-copy motion) consumes the SAME list without touching the drivers, the
 *  palette logic or the UI. */
export interface CloneRecipe {
  index: number
  matrix: THREE.Matrix4
  weight: number
  color?: string
}

/** Copy `i` gets `place(i) . rotationStep(i) . scaleStep(i)`, so each copy spins
 *  and shrinks about its own origin and is only then placed. With the default
 *  step values both step matrices are exactly the identity, which makes the
 *  product bit-identical to the pre-step placement matrix.
 *
 *  Vary scales the STEP transforms by each copy's weight. In sequence mode
 *  `varyStepFactor` returns 1, so the accumulate-by-index maths below runs
 *  verbatim and every scene saved before Vary existed renders bit-identically —
 *  that identity is asserted by the unit tests and must not regress. */
export function planClones(total: number, s: ClonerSettings, vary?: VarySettings): CloneRecipe[] {
  const steps: number[] = []
  for (let i = 0; i < total; i++) steps.push(i)
  const weights = vary ? varyWeights(steps, vary) : steps.map(() => 0)

  const out: CloneRecipe[] = []
  const axisVec = new THREE.Vector3(s.axis === 0 ? 1 : 0, s.axis === 1 ? 1 : 0, s.axis === 2 ? 1 : 0)
  const radialDir = (s.axis + 1) % 3
  const [nx, ny] = s.gridCount
  const rad = (deg: number) => (deg * Math.PI) / 180

  for (let i = 0; i < total; i++) {
    const m = new THREE.Matrix4()
    if (s.mode === 1) {
      const ang = (i / total) * Math.PI * 2
      const outv = new THREE.Vector3()
      outv.setComponent(radialDir, s.radius)
      m.makeTranslation(outv.x, outv.y, outv.z)
      const spin = new THREE.Matrix4().makeRotationAxis(axisVec, ang)
      m.copy(spin.multiply(m))
    } else if (s.mode === 2) {
      // The grid is centred on the origin rather than growing away from it, so
      // adding a column keeps the object where the user put it.
      const ix = i % nx
      const iy = Math.floor(i / nx) % ny
      const iz = Math.floor(i / (nx * ny))
      m.makeTranslation(
        (ix - (s.gridCount[0] - 1) / 2) * s.spacing[0],
        (iy - (s.gridCount[1] - 1) / 2) * s.spacing[1],
        (iz - (s.gridCount[2] - 1) / 2) * s.spacing[2],
      )
    } else {
      m.makeTranslation(s.offset[0] * i, s.offset[1] * i, s.offset[2] * i)
    }

    const w = weights[i] ?? 0
    // 1 in sequence mode — the existing maths, untouched.
    const f = vary ? varyStepFactor(w, vary) : 1
    const euler = new THREE.Euler(
      rad(s.stepRot[0]) * i * f, rad(s.stepRot[1]) * i * f, rad(s.stepRot[2]) * i * f,
    )
    const rot = new THREE.Matrix4().makeRotationFromEuler(euler)
    // Damping a geometric accumulation means damping the EXPONENT, so f=0 lands
    // on exactly 1 (no scaling) rather than on stepScale^i.
    const k = s.stepScale ** (i * f)
    const scl = new THREE.Matrix4().makeScale(k, k, k)

    out.push({
      index: i,
      matrix: m.multiply(rot).multiply(scl),
      weight: w,
      color: vary ? varyColorAt(w, i, vary) : undefined,
    })
  }
  return out
}

/** Fold the recipes into ONE geometry. When any recipe carries a colour, a
 *  per-vertex `color` attribute is written first, filled with that copy's colour
 *  across the whole copy — which is how a merged mesh can show N colours through
 *  a single material (`vertexColors: true`, see materials.ts). */
export function mergeClones(geo: THREE.BufferGeometry, recipes: CloneRecipe[]): THREE.BufferGeometry {
  const tinted = recipes.some((r) => r.color !== undefined)
  const copies: THREE.BufferGeometry[] = []
  const c = new THREE.Color()
  for (const r of recipes) {
    const copy = geo.clone()
    if (tinted) {
      // three reads vertex colours as LINEAR; the palette is sRGB hex.
      c.set(r.color ?? '#ffffff').convertSRGBToLinear()
      const n = copy.getAttribute('position').count
      const arr = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b }
      copy.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    }
    copy.applyMatrix4(r.matrix)
    copies.push(copy)
  }
  const merged = mergeGeometries(copies)
  for (const cp of copies) cp.dispose()
  // mergeGeometries returns null if the inputs disagree on attributes; the
  // copies are clones of one geometry, so that cannot happen here.
  return merged ?? geo.clone()
}
```

Add the import at the top of the file:

```ts
import { varyWeights, varyColorAt, varyStepFactor, type VarySettings } from '~/lib/vary'
```

- [ ] **Step 4: Thread vary through `applyModifiers`**

Change the signature and the cloner block at the end of `applyModifiers`:

```ts
export function applyModifiers(
  geo: THREE.BufferGeometry,
  modifiers: Record<string, number> | undefined,
  vary?: VarySettings,
): THREE.BufferGeometry {
```

and replace the `applyCloner(...)` call with:

```ts
    const recipes = planClones(count, {
      mode: Math.round(m('cloneMode')),
      offset: [m('cloneOffsetX'), m('cloneOffsetY'), m('cloneOffsetZ')],
      radius: m('cloneRadius'),
      axis: Math.round(m('cloneAxis')),
      gridCount: [Math.round(m('cloneCountX')), Math.round(m('cloneCountY')), Math.round(m('cloneCountZ'))],
      spacing: [m('cloneSpacingX'), m('cloneSpacingY'), m('cloneSpacingZ')],
      stepRot: [m('cloneStepRotX'), m('cloneStepRotY'), m('cloneStepRotZ')],
      stepScale: m('cloneStepScale'),
    }, vary)
    const cloned = mergeClones(out, recipes)
```

The rest of that block (`out.dispose()`, `out = cloned`, the bounding recomputes) is unchanged. The `hasModifiers(modifiers)` early return at the top is also unchanged: with no cloner there is nothing to vary, so an object that only sets vary keys still short-circuits.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-cloner-recipes.unit.spec.ts`
Expected: PASS.

Also re-run the existing scene3d suites, which exercise `applyModifiers` heavily:

Run: `cd frontend && npx vitest run tests/unit --reporter=dot 2>&1 | tail -20`
Expected: no NEW failures against the baseline.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/modifiers.ts frontend/tests/unit/scene3d-cloner-recipes.unit.spec.ts
git commit -m "feat(scene3d): clone recipe seam and per-copy vertex colours"
```

---

### Task 4: 3D materials — turn on vertex colours

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` (`materialFor` ~L1200; `updateMaterial` ~L1592)
- Modify: `frontend/app/lib/scene3d/engine.ts` (two `updateMaterial` call sites, L385 and L999)
- Test: `frontend/tests/unit/scene3d-vary-materials.unit.spec.ts` (create)

**Interfaces:**
- Consumes: geometry carrying a `color` attribute (Task 3).
- Produces: `updateMaterial(m, mat, geometry?)` — third parameter added, optional.

**Why this is needed.** `updateMaterial` decides in-place-update versus rebuild from the material spec alone. Vertex colours depend on the GEOMETRY, so toggling the colour switch would otherwise keep a stale material with `vertexColors: false` and the copies would all stay one colour.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-vary-materials.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial } from '~/lib/scene3d/materials'
import type { SceneMaterial } from '~/lib/scene3d/config'

const MAT = { type: 'standard', color: '#3366cc' } as SceneMaterial
const plain = () => new THREE.BoxGeometry(1, 1, 1)
const tinted = () => {
  const g = plain()
  const n = g.getAttribute('position').count
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  return g
}

describe('materialFor with vertex colours', () => {
  it('leaves an untinted geometry exactly as before', () => {
    const m = materialFor(MAT, plain()) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(false)
    expect(`#${m.color.getHexString()}`).toBe('#3366cc')
  })

  it('switches vertex colours on and neutralises the base colour', () => {
    const m = materialFor(MAT, tinted()) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(true)
    expect(`#${m.color.getHexString()}`).toBe('#ffffff')
  })

  it('ignores vertex colours for image and shaderFill, which have no base colour', () => {
    for (const type of ['image', 'shaderFill'] as const) {
      const m = materialFor({ ...MAT, type } as SceneMaterial, tinted())
      expect((m as THREE.MeshStandardMaterial).vertexColors ?? false).toBe(false)
    }
  })
})

describe('updateMaterial vertex-colour boundary', () => {
  it('updates in place when the tint state is unchanged', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT, plain())).toBe(true)
  })

  it('forces a rebuild when the geometry gains a colour attribute', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT, tinted())).toBe(false)
  })

  it('forces a rebuild when the geometry loses its colour attribute', () => {
    const m = materialFor(MAT, tinted())
    expect(updateMaterial(m, MAT, plain())).toBe(false)
  })

  it('behaves exactly as before when no geometry is passed', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-materials.unit.spec.ts`
Expected: FAIL — `vertexColors` is false for the tinted geometry; `updateMaterial` returns true across the boundary.

- [ ] **Step 3: Apply vertex colours in `materialFor`**

In `frontend/app/lib/scene3d/materials.ts`, add this helper above `materialFor`:

```ts
/** Material types with no base colour to tint: `image` samples a texture and
 *  `shaderFill` renders a field, so vertex colours would either do nothing or
 *  multiply the wrong thing. The Cloner's colour control is hidden for both (see
 *  panelPresentation), and this is the render-side half of that same rule. */
const NO_BASE_COLOR: ReadonlySet<string> = new Set(['image', 'shaderFill'])

/** True when this geometry carries the Cloner Vary per-copy colour attribute. */
export function hasVertexTint(mat: SceneMaterial, geometry?: THREE.BufferGeometry): boolean {
  if (!geometry || NO_BASE_COLOR.has(mat.type)) return false
  return geometry.getAttribute('color') !== undefined
}
```

At the very end of `materialFor`, just before it returns `m`, add:

```ts
  // Cloner Vary: the merged clone geometry carries one colour per copy. Turning
  // on vertexColors is what lets a SINGLE material show all of them; the base
  // colour goes white so the palette reads as the user picked it, rather than
  // being multiplied by the material's own colour. `gradient` is deliberately
  // included — its ramp IS the colour, so the copy colour multiplies it as a
  // tint, and the control carries a hint saying so.
  if (hasVertexTint(mat, geometry)) {
    const c = m as THREE.Material & { vertexColors?: boolean; color?: THREE.Color }
    c.vertexColors = true
    if (c.color) c.color.set('#ffffff')
    m.userData.vertexTint = true
  }
```

- [ ] **Step 4: Add the rebuild boundary to `updateMaterial`**

Change the signature and the first guard:

```ts
export function updateMaterial(m: THREE.Material, mat: SceneMaterial, geometry?: THREE.BufferGeometry): boolean {
  if (m.userData.matType !== mat.type || m.userData.identity !== identityKey(mat)) return false
  // Vertex-colour state is a property of the GEOMETRY, not of `mat`, so it
  // cannot ride in identityKey. Crossing this boundary needs a rebuild: three
  // bakes vertexColors into the compiled program. Callers that pass no geometry
  // (unit tests, and any path with no mesh in hand) keep the old behaviour.
  if (geometry && (m.userData.vertexTint === true) !== hasVertexTint(mat, geometry)) return false
```

- [ ] **Step 5: Pass the geometry at both call sites**

In `frontend/app/lib/scene3d/engine.ts`:

- L385: `if (!ov || !updateMaterial(ov, mat)) {` becomes `if (!ov || !updateMaterial(ov, mat, m.geometry)) {`
- L999: `if (!updateMaterial(current, obj.material)) {` becomes `if (!updateMaterial(current, obj.material, mesh.geometry)) {`

At L999 the geometry rebuild above it already ran, so `mesh.geometry` reflects the current vary state. Do not reorder those blocks.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-materials.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/materials.ts frontend/app/lib/scene3d/engine.ts frontend/tests/unit/scene3d-vary-materials.unit.spec.ts
git commit -m "feat(scene3d): materials render per-copy clone colours"
```

---

### Task 5: 3D wiring — palette into the geometry cache and build

**Files:**
- Modify: `frontend/app/lib/scene3d/engine.ts` (`geoKeyFor` ~L290; `buildGeometry` ~L342; `geometryForObject`)
- Test: `frontend/tests/unit/scene3d-vary-geokey.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `varySettingsFor` (Task 2), `applyModifiers(geo, modifiers, vary)` (Task 3).
- Produces: `buildGeometry(kind, params, modifiers, variant, content?, font?, vary?)` — seventh parameter added, optional.

**Why.** `geoKeyFor` already folds every `MODIFIER_SPECS` value in, so the seven numeric vary dials invalidate the cache for free. The PALETTE does not, so editing a swatch would leave the old geometry on screen.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-vary-geokey.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { geoKeyFor } from '~/lib/scene3d/engine'
import type { PrimitiveObject } from '~/lib/scene3d/config'

const obj = (over: Partial<PrimitiveObject> = {}): PrimitiveObject => ({
  id: 'o', kind: 'primitive', primitive: 'box',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#ffffff' },
  ...over,
} as PrimitiveObject)

describe('geoKeyFor and vary', () => {
  it('is unchanged for an object with no vary settings', () => {
    expect(geoKeyFor(obj(), 'smooth')).toBe(geoKeyFor(obj({ varyPalette: undefined }), 'smooth'))
  })

  it('changes when a palette swatch is edited', () => {
    const a = geoKeyFor(obj({ varyPalette: ['#ff0000'] }), 'smooth')
    const b = geoKeyFor(obj({ varyPalette: ['#00ff00'] }), 'smooth')
    expect(a).not.toBe(b)
  })

  it('changes when a swatch is added', () => {
    const a = geoKeyFor(obj({ varyPalette: ['#ff0000'] }), 'smooth')
    const b = geoKeyFor(obj({ varyPalette: ['#ff0000', '#00ff00'] }), 'smooth')
    expect(a).not.toBe(b)
  })

  it('changes when a numeric vary dial moves', () => {
    const a = geoKeyFor(obj({ modifiers: { cloneCount: 4 } }), 'smooth')
    const b = geoKeyFor(obj({ modifiers: { cloneCount: 4, varyMode: 1 } }), 'smooth')
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-geokey.unit.spec.ts`
Expected: FAIL on the palette cases — the key ignores `varyPalette`.

- [ ] **Step 3: Fold the palette into the key**

In `frontend/app/lib/scene3d/engine.ts`, change the return of `geoKeyFor` (L301):

```ts
  // The palette is a string[] and so is NOT in the MODIFIER_SPECS sweep above,
  // which is where every numeric vary dial already lands. It is short (≤8 hex
  // strings), so joining it costs nothing on the per-sync drag path — unlike an
  // svgPath `d` or a mesh buffer, which is why those use digests instead.
  const vary = obj.varyPalette?.join(',') ?? ''
  return `${obj.primitive}|${vals.join(',')}|${mods.join(',')}|${variant}|${content}|${vary}`
```

- [ ] **Step 4: Thread vary through the build**

Change `buildGeometry`'s signature and its `applyModifiers` call:

```ts
export function buildGeometry(
  kind: PrimitiveKind,
  params: Record<string, number> | undefined,
  modifiers: Record<string, number> | undefined,
  variant: 'smooth' | 'facet',
  content?: PrimitiveContent,
  font?: Font | null,
  vary?: VarySettings,
): THREE.BufferGeometry {
  const base = geometryFor(kind, params, content, font)
  const shaped = applyModifiers(base, modifiers, vary)
```

Import the adapter and type at the top of `engine.ts`:

```ts
import { varySettingsFor } from '~/lib/scene3d/primParams'
import type { VarySettings } from '~/lib/vary'
```

Then find every `buildGeometry(` call inside `geometryForObject` and pass `varySettingsFor(obj)` as the seventh argument:

```bash
cd frontend && grep -n "buildGeometry(" app/lib/scene3d/*.ts app/components/vue-canvas/*.vue
```

Every call site that has the `PrimitiveObject` in scope passes `varySettingsFor(obj)`. Call sites that do not (standalone geometry helpers, tests) leave it off — the parameter is optional and omitting it is exactly today's behaviour.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-geokey.unit.spec.ts`
Expected: PASS.

Run: `cd frontend && npx nuxt typecheck 2>&1 | tail -30`
Expected: no NEW type errors versus the baseline (this repo carries pre-existing ones — capture the baseline before the task if unsure).

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/engine.ts frontend/tests/unit/scene3d-vary-geokey.unit.spec.ts
git commit -m "feat(scene3d): vary palette invalidates the geometry cache"
```

---

### Task 6: The shared palette editor component

**Files:**
- Create: `frontend/app/components/vue-canvas/VaryPalette.vue`
- Test: `frontend/tests/unit/vary-palette.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `VARY_PALETTE_MAX`, `DEFAULT_VARY` from `~/lib/vary`.
- Produces: a component with `props: { modelValue: string[] | undefined }` and `emits: { 'update:modelValue': [string[]] }`. Used by BOTH surfaces (Tasks 7 and 10).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/vary-palette.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import { VARY_PALETTE_MAX } from '~/lib/vary'

describe('VaryPalette', () => {
  it('falls back to the default palette when given nothing', () => {
    const w = mount(VaryPalette, { props: { modelValue: undefined } })
    expect(w.findAll('input[type="color"]').length).toBeGreaterThanOrEqual(2)
  })

  it('renders one swatch per colour', () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000', '#00ff00', '#0000ff'] } })
    expect(w.findAll('input[type="color"]').length).toBe(3)
  })

  it('emits a longer list when a swatch is added', async () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000'] } })
    await w.get('[data-test="vary-palette-add"]').trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted.length).toBe(2)
  })

  it('hides the add button at the ceiling', () => {
    const full = Array.from({ length: VARY_PALETTE_MAX }, () => '#123456')
    const w = mount(VaryPalette, { props: { modelValue: full } })
    expect(w.find('[data-test="vary-palette-add"]').exists()).toBe(false)
  })

  it('emits a shorter list when a swatch is removed', async () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000', '#00ff00'] } })
    await w.findAll('[data-test="vary-palette-remove"]')[0]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted).toEqual(['#00ff00'])
  })

  it('refuses to remove the last swatch', () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000'] } })
    expect(w.findAll('[data-test="vary-palette-remove"]').length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vary-palette.unit.spec.ts`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Write the component**

Create `frontend/app/components/vue-canvas/VaryPalette.vue`:

```vue
<script setup lang="ts">
/**
 * The Cloner Vary swatch list — the ONE palette editor, used by both the 3D
 * Studio inspector and the Frame cloner panel so the two surfaces stay
 * vocabulary-identical.
 *
 * Modelled on Shape Studio's inline fills editor, which is bespoke and stays
 * that way for now; this component is written so Shape Studio could adopt it
 * later without changing its data shape.
 */
import { computed } from 'vue'
import { DEFAULT_VARY, VARY_PALETTE_MAX } from '~/lib/vary'

const props = defineProps<{ modelValue: string[] | undefined }>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const palette = computed<string[]>(() =>
  props.modelValue && props.modelValue.length > 0 ? props.modelValue : DEFAULT_VARY.palette)

const canAdd = computed(() => palette.value.length < VARY_PALETTE_MAX)
const canRemove = computed(() => palette.value.length > 1)

function setAt(i: number, hex: string) {
  emit('update:modelValue', palette.value.map((c, j) => (j === i ? hex : c)))
}
function add() {
  if (!canAdd.value) return
  emit('update:modelValue', [...palette.value, palette.value[palette.value.length - 1] ?? '#ffffff'])
}
function removeAt(i: number) {
  if (!canRemove.value) return
  emit('update:modelValue', palette.value.filter((_, j) => j !== i))
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <div v-for="(c, i) in palette" :key="i" class="relative group">
      <input
        type="color" :value="c"
        class="size-6 rounded cursor-pointer bg-transparent border border-white/15 p-0"
        :aria-label="`Palette colour ${i + 1}`"
        @input="setAt(i, ($event.target as HTMLInputElement).value)"
      >
      <button
        v-if="canRemove"
        data-test="vary-palette-remove"
        class="absolute -top-1 -right-1 size-3.5 rounded-full bg-neutral-900 text-white/70 text-[9px] leading-none opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        :title="`Remove colour ${i + 1}`"
        @click="removeAt(i)"
      >×</button>
    </div>
    <button
      v-if="canAdd"
      data-test="vary-palette-add"
      class="size-6 rounded border border-dashed border-white/25 text-white/50 text-[13px] leading-none cursor-pointer hover:border-white/50 hover:text-white/80 transition-colors"
      title="Add a colour"
      @click="add"
    >+</button>
  </div>
</template>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vary-palette.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/VaryPalette.vue frontend/tests/unit/vary-palette.unit.spec.ts
git commit -m "feat(vary): shared palette editor used by both cloner panels"
```

---

### Task 7: 3D inspector — the Vary rows

**Files:**
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (card routing ~L684; row list ~L630; anchors ~L421)
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (render the palette anchor)
- Test: `frontend/tests/unit/scene3d-vary-panel.unit.spec.ts` (create)

**Interfaces:**
- Consumes: the seven schema keys (Task 2), `VaryPalette.vue` (Task 6).
- Produces: a `ui.cloner.varyPalette` panel anchor; `vary*` rows on the Cloner card.

**The trap this task exists to avoid.** `panelPresentation.ts` L686 routes a modifier key to the Cloner card only when it `startsWith('clone')`. Without a change, every `vary*` row silently lands on the Modifiers card instead.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-vary-panel.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { panelSectionFor, panelRowKeys } from '~/lib/scene3d/panelPresentation'
import type { PrimitiveObject } from '~/lib/scene3d/config'

const obj = (modifiers: Record<string, number> = {}, material = 'standard'): PrimitiveObject => ({
  id: 'o', kind: 'primitive', primitive: 'box',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: material, color: '#ffffff' }, modifiers,
} as PrimitiveObject)

describe('vary rows live on the Cloner card', () => {
  it('routes every vary key to Cloner, not Modifiers', () => {
    for (const k of ['varyMode', 'varySeed', 'varyColor', 'varyColorStrength']) {
      expect(panelSectionFor(`object.modifiers.${k}`), k).toBe('Geometry/Cloner')
    }
  })

  it('keeps the deformation keys on Modifiers', () => {
    expect(panelSectionFor('object.modifiers.twist')).toBe('Geometry/Modifiers')
  })
})

describe('vary row gating', () => {
  const keys = (o: PrimitiveObject) => panelRowKeys(o)

  it('shows the seed only in random mode', () => {
    expect(keys(obj({ cloneCount: 4 }))).not.toContain('object.modifiers.varySeed')
    expect(keys(obj({ cloneCount: 4, varyMode: 1 }))).toContain('object.modifiers.varySeed')
  })

  it('shows centre and reach only in falloff mode', () => {
    const k = keys(obj({ cloneCount: 4, varyMode: 2 }))
    expect(k).toContain('object.modifiers.varyFalloffCenter')
    expect(k).toContain('object.modifiers.varyFalloffRadius')
    expect(keys(obj({ cloneCount: 4, varyMode: 1 }))).not.toContain('object.modifiers.varyFalloffCenter')
  })

  it('reveals the palette, spread and strength only when colour is on', () => {
    expect(keys(obj({ cloneCount: 4 }))).not.toContain('ui.cloner.varyPalette')
    const on = keys(obj({ cloneCount: 4, varyColor: 1 }))
    expect(on).toContain('ui.cloner.varyPalette')
    expect(on).toContain('object.modifiers.varyColorSpread')
    expect(on).toContain('object.modifiers.varyColorStrength')
  })

  it('hides the colour switch for image and shaderFill materials', () => {
    for (const type of ['image', 'shaderFill']) {
      const k = keys(obj({ cloneCount: 4, varyColor: 1 }, type))
      expect(k, type).not.toContain('object.modifiers.varyColor')
      expect(k, type).not.toContain('ui.cloner.varyPalette')
    }
  })

  it('hides the whole vary block when the cloner makes a single copy', () => {
    expect(keys(obj({ cloneCount: 1 }))).not.toContain('object.modifiers.varyMode')
  })
})
```

If `panelSectionFor` / `panelRowKeys` are not the exported names in this file, read the file and use the real ones — do not invent them. Adapt the test to the actual exports before implementing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-panel.unit.spec.ts`
Expected: FAIL — vary keys route to `Geometry/Modifiers`.

- [ ] **Step 3: Route vary keys to the Cloner card**

In `frontend/app/lib/scene3d/panelPresentation.ts`, at the card-routing branch (~L684-686), change:

```ts
  if (key.startsWith('ui.cloner.')) return 'Geometry/Cloner'
  if (key.startsWith(MODIFIER_PREFIX)) {
    // `vary*` joins `clone*` on the Cloner card: it varies the CLONER's copies and
    // is meaningless without them. Without this it would land on Modifiers, which
    // is where every non-clone modifier key goes.
    const sub = key.slice(MODIFIER_PREFIX.length)
    return sub.startsWith('clone') || sub.startsWith('vary') ? 'Geometry/Cloner' : 'Geometry/Modifiers'
  }
```

- [ ] **Step 4: Add the vary rows and their gating**

Add beside `CLONER_STEP_KEYS` (~L408):

```ts
/** The Vary block's rows, gated by mode and by the colour switch. Returns an
 *  EMPTY list when the cloner makes a single copy — there is nothing to vary
 *  across, and an always-present block would clutter the card for the common case.
 *  `image` and `shaderFill` have no base colour for a per-copy tint to reach, so
 *  the colour half disappears for them (the render side agrees — see
 *  materials.ts's NO_BASE_COLOR). */
function varyKeys(obj: PrimitiveObject | undefined, total: number): string[] {
  if (total <= 1) return []
  const m = (k: string) => modifierValue(obj?.modifiers, k)
  const mode = Math.round(m('varyMode'))
  const out = ['ui.cloner.vary', `${MODIFIER_PREFIX}varyMode`]
  if (mode === 1) out.push(`${MODIFIER_PREFIX}varySeed`)
  if (mode === 2) out.push(`${MODIFIER_PREFIX}varyFalloffCenter`, `${MODIFIER_PREFIX}varyFalloffRadius`)
  const colourable = !!obj && obj.kind === 'primitive'
    && obj.material.type !== 'image' && obj.material.type !== 'shaderFill'
  if (colourable) {
    out.push(`${MODIFIER_PREFIX}varyColor`)
    if (Math.round(m('varyColor')) === 1) {
      out.push('ui.cloner.varyPalette', `${MODIFIER_PREFIX}varyColorSpread`, `${MODIFIER_PREFIX}varyColorStrength`)
    }
  }
  return out
}
```

Then extend the Cloner card's row list (~L630-631) so the vary rows follow the step block, before the cost readout:

```ts
    ...clonerKeys(cloneModeOf(obj)).map(modRowKey),
    'ui.cloner.step', ...CLONER_STEP_KEYS.map((k) => `${MODIFIER_PREFIX}${k}`),
    ...varyKeys(obj, totalClones(obj?.modifiers)),
    'ui.cloner.cost',
```

Register the two new anchors in `SCENE_PANEL_ANCHORS`:

```ts
  { key: 'ui.cloner.vary', label: 'Vary', visible: () => true },
  { key: 'ui.cloner.varyPalette', label: 'Palette', visible: () => true },
```

Also add the gradient hint. In the same anchor list or wherever row hints are resolved, the `varyColor` row on a `gradient` material appends: `On a gradient material the copy colour tints the ramp rather than replacing it.` Read how neighbouring rows attach a conditional hint and follow that pattern rather than inventing a new one.

- [ ] **Step 5: Render the palette anchor in the surface**

In `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, find where the other `ui.cloner.*` anchors are rendered (search for `ui.cloner.step`) and add a branch for `ui.cloner.varyPalette` that mounts the shared editor:

```vue
        <VaryPalette
          v-else-if="row.key === 'ui.cloner.varyPalette'"
          :model-value="selectedPrimitive?.varyPalette"
          @update:model-value="setVaryPalette"
        />
```

with, in the script block:

```ts
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'

/** The palette is a string[] on the object, so it does NOT go through
 *  setModifier (a number-bag writer). It writes the field directly, the same way
 *  any other non-numeric object field is edited on this surface. */
function setVaryPalette(palette: string[]) {
  const obj = selectedPrimitive.value
  if (!obj) return
  updateObject(obj.id, { varyPalette: palette })
}
```

Use the surface's real object-update helper and its real selected-object ref — read the file and match them. `updateObject` / `selectedPrimitive` are placeholders for whatever this file already calls them.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-vary-panel.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/panelPresentation.ts frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/tests/unit/scene3d-vary-panel.unit.spec.ts
git commit -m "feat(scene3d): Vary controls on the Cloner card"
```

---

### Task 8: Frame storage and `expandClones`

**Files:**
- Modify: `frontend/app/composables/useCloner.ts` (`Cloner` L13-38; `CloneTransform` L40-46; `DEFAULT_CLONER` L50-70; `expandClones` L84-146)
- Test: `frontend/tests/unit/frame-cloner-vary.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `varyWeights`, `varyColorAt`, `varyStepFactor`, `DEFAULT_VARY` from `~/lib/vary`.
- Produces:
  - `Cloner` gains `varyMode`, `varySeed`, `varyFalloffCenter`, `varyFalloffRadius`, `varyColor`, `varyPalette`, `varyColorSpread`, `varyColorStrength`.
  - `CloneTransform` gains `weight: number`, `tint?: string`, `tintStrength: number`.
  - `function varyOf(cloner: Cloner): VarySettings`.

**The subtlety.** Frame's step index `k` is `|iy|*nx + |ix|`, which repeats across mirrored twins and is not dense. `varyWeights` takes the step array precisely so this keeps working: mirrored twins share a step, so they share a weight, matching the existing falloff comment at L117-119.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-cloner-vary.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_CLONER, expandClones, varyOf, type Cloner } from '~/composables/useCloner'

const C = (over: Partial<Cloner> = {}): Cloner => ({ ...DEFAULT_CLONER, enabled: true, ...over })

describe('expandClones without vary', () => {
  it('still returns a single identity transform when disabled', () => {
    const [t] = expandClones(undefined, 1)
    expect(t).toMatchObject({ dx: 0, dy: 0, drot: 0, dscale: 1, dopacity: 1 })
    expect(t!.tint).toBeUndefined()
  })

  it('leaves every existing field untouched for a plain linear cloner', () => {
    const out = expandClones(C({ countX: 3, spacingX: 0.2, stepScale: 0.5 }), 1)
    // Back-to-front: the original (k=0) is LAST.
    expect(out.map((t) => t.dscale)).toEqual([0.25, 0.5, 1])
    expect(out.every((t) => t.tint === undefined)).toBe(true)
  })
})

describe('expandClones with vary colour', () => {
  it('cycles the palette across copies in sequence mode', () => {
    const out = expandClones(C({
      countX: 4, varyColor: true, varyPalette: ['#ff0000', '#00ff00'],
    }), 1)
    // Reversed, so read back-to-front: k=3,2,1,0.
    expect(out.map((t) => t.tint)).toEqual(['#00ff00', '#ff0000', '#00ff00', '#ff0000'])
  })

  it('gives mirrored twins the same weight and colour', () => {
    const out = expandClones(C({
      countX: 3, mirrorX: true, varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff'],
    }), 1)
    const byStep = new Map<number, string>()
    for (const t of out) {
      const prev = byStep.get(t.weight)
      if (prev !== undefined) expect(t.tint).toBe(prev)
      byStep.set(t.weight, t.tint!)
    }
    expect(byStep.size).toBeGreaterThan(1)
  })

  it('carries the strength through', () => {
    const out = expandClones(C({ countX: 2, varyColor: true, varyColorStrength: 0.4 }), 1)
    expect(out.every((t) => t.tintStrength === 0.4)).toBe(true)
  })

  it('damps the step transforms in falloff mode', () => {
    const out = expandClones(C({
      countX: 4, stepScale: 0.5, varyMode: 'falloff', varyFalloffCenter: 0, varyFalloffRadius: 0.01,
    }), 1)
    // The far copy is fully damped back to no scaling.
    expect(out[0]!.dscale).toBeCloseTo(1, 6)
    // The original is unaffected either way.
    expect(out[out.length - 1]!.dscale).toBe(1)
  })

  it('leaves sequence-mode steps identical to the un-varied result', () => {
    const plain = expandClones(C({ countX: 5, stepScale: 0.8, stepRotation: 10 }), 1)
    const varied = expandClones(C({ countX: 5, stepScale: 0.8, stepRotation: 10, varyMode: 'sequence' }), 1)
    expect(varied.map((t) => [t.dscale, t.drot])).toEqual(plain.map((t) => [t.dscale, t.drot]))
  })
})

describe('varyOf', () => {
  it('reads the cloner into the shared settings shape', () => {
    const v = varyOf(C({ varyMode: 'random', varySeed: 5, varyColor: true, varyPalette: ['#abc'] }))
    expect(v).toMatchObject({ mode: 'random', seed: 5, colorEnabled: true, palette: ['#abc'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-cloner-vary.unit.spec.ts`
Expected: FAIL — `varyOf` is not exported and `tint` is not a field.

- [ ] **Step 3: Extend the types and defaults**

In `frontend/app/composables/useCloner.ts`, add to the `Cloner` interface after `stepOpacity`:

```ts
  // vary — per-copy variation, shared with the 3D Studio cloner via lib/vary.
  // Every default is the identity, so an existing layer stamps exactly as before.
  varyMode: VaryMode
  varySeed: number
  varyFalloffCenter: number
  varyFalloffRadius: number
  varyColor: boolean
  varyPalette: string[]
  varyColorSpread: VarySpread
  varyColorStrength: number
```

to `CloneTransform`:

```ts
  /** This copy's Vary weight in [0,1]. Exposed so a renderer can drive its own
   *  per-copy effects without re-deriving the driver. */
  weight: number
  /** Resolved per-copy colour, or undefined when colour variation is off. */
  tint?: string
  /** How far toward `tint` the copy's pixels move. Meaningless without `tint`. */
  tintStrength: number
```

to `IDENTITY`: `weight: 0, tintStrength: 1`, and to `DEFAULT_CLONER`:

```ts
  varyMode: DEFAULT_VARY.mode,
  varySeed: DEFAULT_VARY.seed,
  varyFalloffCenter: DEFAULT_VARY.falloffCenter,
  varyFalloffRadius: DEFAULT_VARY.falloffRadius,
  varyColor: false,
  varyPalette: DEFAULT_VARY.palette,
  varyColorSpread: DEFAULT_VARY.spread,
  varyColorStrength: DEFAULT_VARY.strength,
```

with the import:

```ts
import {
  DEFAULT_VARY, varyWeights, varyColorAt, varyStepFactor,
  type VaryMode, type VarySpread, type VarySettings,
} from '~/lib/vary'
```

- [ ] **Step 4: Add the adapter and rewrite `expandClones` in two passes**

Add above `expandClones`:

```ts
/** The cloner's vary settings in the shared module's vocabulary. */
export function varyOf(cloner: Cloner): VarySettings {
  return {
    mode: cloner.varyMode ?? DEFAULT_VARY.mode,
    seed: cloner.varySeed ?? DEFAULT_VARY.seed,
    falloffCenter: cloner.varyFalloffCenter ?? DEFAULT_VARY.falloffCenter,
    falloffRadius: cloner.varyFalloffRadius ?? DEFAULT_VARY.falloffRadius,
    colorEnabled: !!cloner.varyColor,
    palette: cloner.varyPalette && cloner.varyPalette.length > 0 ? cloner.varyPalette : DEFAULT_VARY.palette,
    spread: cloner.varyColorSpread ?? DEFAULT_VARY.spread,
    strength: cloner.varyColorStrength ?? DEFAULT_VARY.strength,
  }
}
```

`expandClones` becomes two passes, because a weight needs the whole step array before any copy can be finished. Collect first, resolve second — the placement maths inside is UNCHANGED, only `push` and the tail differ:

```ts
export function expandClones(cloner: Cloner | undefined | null, aspect: number): CloneTransform[] {
  if (!cloner || !cloner.enabled) return [{ ...IDENTITY }]

  const stepRot = cloner.stepRotation || 0
  const stepScl = cloner.stepScale ?? 1
  const stepOp = cloner.stepOpacity ?? 1

  // Pass 1 — placement only. The vary weight needs the FULL step array (its
  // normaliser is max(k)), so nothing can be finished until every copy is known.
  const raw: { k: number; dx: number; dy: number; extraRot: number }[] = []
  const push = (k: number, dx: number, dy: number, extraRot: number) => raw.push({ k, dx, dy, extraRot })

  // ... the existing radial / linear-grid blocks, verbatim and unchanged ...

  // Pass 2 — drivers. Sequence mode has varyStepFactor === 1, so the three step
  // expressions below reduce to exactly the pre-vary ones.
  const vary = varyOf(cloner)
  const weights = varyWeights(raw.map((r) => r.k), vary)
  const out: CloneTransform[] = raw.map((r, i) => {
    const w = weights[i] ?? 0
    const f = varyStepFactor(w, vary)
    return {
      dx: r.dx, dy: r.dy,
      drot: r.k * stepRot * f + r.extraRot,
      dscale: Math.pow(stepScl, r.k * f),
      dopacity: Math.pow(stepOp, r.k * f),
      weight: w,
      tint: varyColorAt(w, r.k, vary),
      tintStrength: vary.strength,
    }
  })

  // Built k-ascending; reverse → original (k=0) ends last = drawn on top.
  out.reverse()
  return out
}
```

Note `varyColorAt(w, r.k, vary)` passes the STEP `k`, not the array position — cycle must walk the palette by how far along the array a copy sits, so mirrored twins get the same swatch.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-cloner-vary.unit.spec.ts`
Expected: PASS.

Run the existing cloner suites too:

Run: `cd frontend && npx vitest run tests/unit --reporter=dot 2>&1 | tail -20`
Expected: no NEW failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/composables/useCloner.ts frontend/tests/unit/frame-cloner-vary.unit.spec.ts
git commit -m "feat(frame): per-copy vary weights and tints in expandClones"
```

---

### Task 9: Frame rendering — tint each copy

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (effected path ~L1860-1937; fast path ~L1940-1948; wired image path ~L3042-3053)
- Test: `frontend/tests/unit/frame-cloner-tint.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `CloneTransform.tint` / `.tintStrength` (Task 8), the existing `scratchLike` / `stampScratch` helpers (~L1952-1990).
- Produces: `function tintScratch(octx: CanvasRenderingContext2D, tint: string, strength: number): void` — exported so the test can drive it directly.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-cloner-tint.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { tintScratch } from '~/composables/useCompositorLayers'

function ctx(): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = c.height = 4
  return c.getContext('2d')!
}

describe('tintScratch', () => {
  it('paints the tint only where the copy has ink', () => {
    const o = ctx()
    o.fillStyle = '#ffffff'
    o.fillRect(0, 0, 2, 4) // left half opaque, right half transparent
    tintScratch(o, '#ff0000', 1)
    const left = o.getImageData(0, 0, 1, 1).data
    const right = o.getImageData(3, 0, 1, 1).data
    expect([left[0], left[1], left[2]]).toEqual([255, 0, 0])
    expect(right[3]).toBe(0)
  })

  it('does nothing at strength 0', () => {
    const o = ctx()
    o.fillStyle = '#ffffff'
    o.fillRect(0, 0, 4, 4)
    tintScratch(o, '#ff0000', 0)
    const px = o.getImageData(0, 0, 1, 1).data
    expect([px[0], px[1], px[2]]).toEqual([255, 255, 255])
  })

  it('partially tints at an intermediate strength', () => {
    const o = ctx()
    o.fillStyle = '#ffffff'
    o.fillRect(0, 0, 4, 4)
    tintScratch(o, '#000000', 0.5)
    const px = o.getImageData(0, 0, 1, 1).data
    expect(px[0]).toBeGreaterThan(100)
    expect(px[0]).toBeLessThan(155)
  })

  it('restores the transform and composite mode it found', () => {
    const o = ctx()
    o.translate(2, 2)
    const before = o.getTransform()
    tintScratch(o, '#ff0000', 1)
    const after = o.getTransform()
    expect([after.a, after.d, after.e, after.f]).toEqual([before.a, before.d, before.e, before.f])
    expect(o.globalCompositeOperation).toBe('source-over')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-cloner-tint.unit.spec.ts`
Expected: FAIL — `tintScratch` is not exported.

- [ ] **Step 3: Write the tint helper**

In `frontend/app/composables/useCompositorLayers.ts`, add next to `scratchLike` / `stampScratch`:

```ts
/**
 * Cloner Vary: wash one clone's already-drawn pixels toward its palette colour.
 *
 * `source-atop` confines the fill to existing ink, so the copy's silhouette,
 * anti-aliased edges and any transparency survive; `globalAlpha` is the strength.
 * Runs in DEVICE space so the fill covers the whole scratch regardless of the
 * caller's transform, and restores everything it touched.
 */
export function tintScratch(octx: CanvasRenderingContext2D, tint: string, strength: number): void {
  const a = Math.max(0, Math.min(1, strength))
  if (a <= 0) return
  octx.save()
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalCompositeOperation = 'source-atop'
  octx.globalAlpha = a
  octx.fillStyle = tint
  octx.fillRect(0, 0, octx.canvas.width, octx.canvas.height)
  octx.restore()
}
```

- [ ] **Step 4: Apply it at the effected path**

In the clone loop, the effected branch already renders the copy into `off` via `octx`. Immediately after the layer content is drawn into `octx` and before the effect chain consumes it, add:

```ts
        // Cloner Vary tint — applied to the copy's own offscreen, so the effect
        // chain below (shadow, blur, gradient map…) sees the varied colour.
        if (c.tint) tintScratch(octx, c.tint, c.tintStrength)
```

- [ ] **Step 5: Apply it at the fast path**

Replace the fast-path block (~L1940-1948) with:

```ts
    // Fast path (no effects): draw inline. No skew/cornerPin ⇒ identical to before.
    // A tinted copy takes a scratch detour instead, because `source-atop` on the
    // shared ctx would wash every layer already composited beneath this one.
    const scratch = c.tint ? scratchLike(ctx) : null
    if (scratch) {
      _fieldCtx = { ..._fieldCtx, base: scratch.getTransform() }
      applyXform(scratch, lx, ly, lrot, ls)
      drawContent(scratch)
      tintScratch(scratch, c.tint!, c.tintStrength)
      ctx.save()
      ctx.globalAlpha = lop
      ctx.globalCompositeOperation = blendOp
      stampScratch(ctx, scratch)
      ctx.restore()
      continue
    }
    ctx.save()
    ctx.globalAlpha = lop
    ctx.globalCompositeOperation = blendOp
    _fieldCtx = { ..._fieldCtx, base: ctx.getTransform() } // frame base, before this shape's own transform
    applyXform(ctx, lx, ly, lrot, ls)
    drawContent(ctx)
    ctx.restore()
```

`scratchLike` returns null with no DOM (SSR, node-environment unit tests), which falls through to the untinted path — the same safe fallback its own doc describes.

- [ ] **Step 6: Apply it at the wired image path**

In the loop at ~L3042, replace the single `ctx.drawImage(src, ...)` with:

```ts
    if (c.tint) {
      const sc = document.createElement('canvas')
      sc.width = Math.max(1, (src as HTMLCanvasElement | HTMLImageElement).width || 1)
      sc.height = Math.max(1, (src as HTMLCanvasElement | HTMLImageElement).height || 1)
      const sctx = sc.getContext('2d')
      if (sctx) {
        sctx.drawImage(src, 0, 0)
        tintScratch(sctx, c.tint, c.tintStrength)
        ctx.drawImage(sc, -fitW / 2, -fitH / 2, fitW, fitH)
      } else {
        ctx.drawImage(src, -fitW / 2, -fitH / 2, fitW, fitH)
      }
    } else {
      ctx.drawImage(src, -fitW / 2, -fitH / 2, fitW, fitH)
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-cloner-tint.unit.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/frame-cloner-tint.unit.spec.ts
git commit -m "feat(frame): tint each cloned copy from the vary palette"
```

---

### Task 10: Frame cloner panel — the Vary block

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue`
- Test: `frontend/tests/unit/frame-cloner-panel.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `Cloner`'s vary fields (Task 8), `VaryPalette.vue` (Task 6).
- Produces: no new exports; the panel emits an updated `Cloner` through its existing `update` event.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-cloner-panel.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorClonerPanel.vue'
import { DEFAULT_CLONER, type Cloner } from '~/composables/useCloner'

const mountWith = (over: Partial<Cloner> = {}) =>
  mount(Panel, { props: { cloner: { ...DEFAULT_CLONER, enabled: true, ...over } } })

describe('Vary block', () => {
  it('is absent while the cloner is disabled', () => {
    const w = mount(Panel, { props: { cloner: { ...DEFAULT_CLONER, enabled: false } } })
    expect(w.find('[data-test="vary-mode"]').exists()).toBe(false)
  })

  it('offers all three drivers', () => {
    const w = mountWith()
    const labels = w.findAll('[data-test="vary-mode"] button').map((b) => b.text())
    expect(labels).toEqual(['Sequence', 'Random', 'Falloff'])
  })

  it('shows the seed only in random mode', () => {
    expect(mountWith().find('[data-test="vary-seed"]').exists()).toBe(false)
    expect(mountWith({ varyMode: 'random' }).find('[data-test="vary-seed"]').exists()).toBe(true)
  })

  it('shows centre and reach only in falloff mode', () => {
    const w = mountWith({ varyMode: 'falloff' })
    expect(w.find('[data-test="vary-center"]').exists()).toBe(true)
    expect(w.find('[data-test="vary-reach"]').exists()).toBe(true)
    expect(mountWith({ varyMode: 'random' }).find('[data-test="vary-center"]').exists()).toBe(false)
  })

  it('reveals the palette only when colour is switched on', () => {
    expect(mountWith().find('[data-test="vary-palette-add"]').exists()).toBe(false)
    expect(mountWith({ varyColor: true }).find('[data-test="vary-palette-add"]').exists()).toBe(true)
  })

  it('emits the whole cloner when the driver changes', async () => {
    const w = mountWith()
    await w.findAll('[data-test="vary-mode"] button')[1]!.trigger('click')
    const next = w.emitted('update')!.at(-1)![0] as Cloner
    expect(next.varyMode).toBe('random')
    expect(next.enabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-cloner-panel.unit.spec.ts`
Expected: FAIL — no vary markup exists.

- [ ] **Step 3: Add the Vary block**

In `frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue`, add to the script block:

```ts
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import type { VaryMode, VarySpread } from '~/lib/vary'

// Readable labels for the stored internal values — a picker must never surface
// `sequence` / `cycle` to the user.
const VARY_MODE_OPTIONS: { value: VaryMode; label: string }[] = [
  { value: 'sequence', label: 'Sequence' },
  { value: 'random', label: 'Random' },
  { value: 'falloff', label: 'Falloff' },
]
const VARY_SPREAD_OPTIONS: { value: VarySpread; label: string }[] = [
  { value: 'cycle', label: 'Cycle' },
  { value: 'blend', label: 'Blend' },
]
```

and inside the `v-if="c.enabled"` template, after the existing falloff/step controls:

```vue
      <!-- Vary — how a property changes from one copy to the next. -->
      <div class="mt-4 pt-3 border-t border-white/10">
        <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-2">Vary</div>

        <div data-test="vary-mode" class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05] mb-3">
          <button
            v-for="o in VARY_MODE_OPTIONS" :key="o.value"
            class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors"
            :class="c.varyMode === o.value ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
            @click="up({ varyMode: o.value })"
          >{{ o.label }}</button>
        </div>

        <label v-if="c.varyMode === 'random'" data-test="vary-seed" class="block mb-3">
          <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Seed</span>
          <input v-scrubnum type="number" min="0" max="99" step="1" :value="c.varySeed"
            class="w-full h-7 px-2 rounded bg-white/[0.06] text-[11px] text-white/85 tabular-nums"
            @input="up({ varySeed: num($event) })">
        </label>

        <div v-if="c.varyMode === 'falloff'" class="grid grid-cols-2 gap-3 mb-3">
          <label data-test="vary-center" class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Centre</span>
            <input v-scrubnum type="number" min="0" max="1" step="0.01" :value="c.varyFalloffCenter"
              class="w-full h-7 px-2 rounded bg-white/[0.06] text-[11px] text-white/85 tabular-nums"
              @input="up({ varyFalloffCenter: num($event) })">
          </label>
          <label data-test="vary-reach" class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Reach</span>
            <input v-scrubnum type="number" min="0.01" max="1" step="0.01" :value="c.varyFalloffRadius"
              class="w-full h-7 px-2 rounded bg-white/[0.06] text-[11px] text-white/85 tabular-nums"
              @input="up({ varyFalloffRadius: num($event) })">
          </label>
        </div>

        <div class="flex items-center justify-between mb-2">
          <span class="text-[11px] text-white/70">Colour</span>
          <button
            class="relative w-8 h-[18px] rounded-full transition-colors cursor-pointer"
            :class="c.varyColor ? 'bg-white/80' : 'bg-white/15'"
            :title="c.varyColor ? 'Turn off colour variation' : 'Give each copy its own colour'"
            @click="up({ varyColor: !c.varyColor })"
          >
            <span class="absolute top-[2px] size-[14px] rounded-full bg-neutral-900 transition-all"
              :class="c.varyColor ? 'left-[16px]' : 'left-[2px]'" />
          </button>
        </div>

        <template v-if="c.varyColor">
          <VaryPalette class="mb-3" :model-value="c.varyPalette" @update:model-value="up({ varyPalette: $event })" />
          <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05] mb-3">
            <button
              v-for="o in VARY_SPREAD_OPTIONS" :key="o.value"
              class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors"
              :class="c.varyColorSpread === o.value ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
              @click="up({ varyColorSpread: o.value })"
            >{{ o.label }}</button>
          </div>
          <label class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Strength</span>
            <input v-scrubnum type="number" min="0" max="1" step="0.01" :value="c.varyColorStrength"
              class="w-full h-7 px-2 rounded bg-white/[0.06] text-[11px] text-white/85 tabular-nums"
              @input="up({ varyColorStrength: num($event) })">
          </label>
        </template>
      </div>
```

If `v-scrubnum` is not registered in the unit-test environment the mount will warn; add it to the mount's global directives stub in the test rather than removing it from the component.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-cloner-panel.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue frontend/tests/unit/frame-cloner-panel.unit.spec.ts
git commit -m "feat(frame): Vary controls on the cloner panel"
```

---

### Task 11: Python mirror and cross-language parity

**Files:**
- Modify: `comfy_extras/nodes_compositor.py` (`_expand_clones` L206+; the clone paste in the composite ~L535)
- Test: `tests-unit/comfy_extras_test/cloner_vary_test.py` (create)

**Interfaces:**
- Consumes: the pinned reference hashes from `frontend/tests/unit/vary.unit.spec.ts` (Task 1).
- Produces: `_hash32(i, seed) -> float`, `_vary_weights(steps, vary) -> list[float]`, `_vary_color_at(w, index, vary) -> str | None`, `_tint_image(img, hex_color, strength) -> Image`.

**This is the parity risk in the whole feature.** `_expand_clones` is a line-comparable mirror of `expandClones` and must stay one.

- [ ] **Step 1: Write the failing test**

Create `tests-unit/comfy_extras_test/cloner_vary_test.py`:

```python
import json
import pathlib
import re

import pytest

from comfy_extras.nodes_compositor import (
    _expand_clones, _hash32, _vary_weights, _vary_color_at, _mix_hex,
)

REPO = pathlib.Path(__file__).resolve().parents[2]
SPEC = REPO / "frontend" / "tests" / "unit" / "vary.unit.spec.ts"


def _reference_hashes():
    """The values the TypeScript side pinned. Read from the spec file itself so
    the two can never drift apart silently."""
    src = SPEC.read_text()
    m = re.search(r"const REFERENCE_HASHES: number\[\] = \[([^\]]*)\]", src)
    assert m, "REFERENCE_HASHES not found in vary.unit.spec.ts"
    return [float(x) for x in m.group(1).replace("\n", "").split(",") if x.strip()]


def test_hash32_matches_the_typescript_reference():
    ref = _reference_hashes()
    assert len(ref) == 4, "expected four pinned values"
    got = [round(_hash32(i, 7), 9) for i in range(4)]
    assert got == ref


def test_hash32_is_in_range():
    for i in range(50):
        h = _hash32(i, 3)
        assert 0.0 <= h < 1.0


def _vary(**over):
    v = {
        "varyMode": "sequence", "varySeed": 0,
        "varyFalloffCenter": 0.0, "varyFalloffRadius": 0.5,
        "varyColor": False, "varyPalette": ["#4c6ef5", "#f59f00"],
        "varyColorSpread": "cycle", "varyColorStrength": 1.0,
    }
    v.update(over)
    return v


def test_sequence_weights_ramp_to_one():
    assert _vary_weights([0, 1, 2, 3], _vary()) == pytest.approx([0, 1 / 3, 2 / 3, 1])


def test_single_copy_is_weight_zero():
    assert _vary_weights([0], _vary()) == [0]


def test_falloff_peaks_at_the_centre():
    w = _vary_weights([0, 1, 2, 3], _vary(varyMode="falloff", varyFalloffCenter=0.0, varyFalloffRadius=0.5))
    assert w[0] == 1.0
    assert w[3] == 0.0
    assert w[1] > w[2]


def test_cycle_walks_the_palette_in_sequence_mode():
    v = _vary(varyColor=True, varyPalette=["#ff0000", "#00ff00"])
    assert [_vary_color_at(0.0, k, v) for k in range(4)] == ["#ff0000", "#00ff00", "#ff0000", "#00ff00"]


def test_blend_hits_the_palette_ends():
    v = _vary(varyColor=True, varyPalette=["#ff0000", "#00ff00", "#0000ff"], varyColorSpread="blend")
    assert _vary_color_at(0.0, 0, v) == "#ff0000"
    assert _vary_color_at(1.0, 2, v) == "#0000ff"


def test_mix_hex_endpoints_and_midpoint():
    assert _mix_hex("#ff0000", "#0000ff", 0.0) == "#ff0000"
    assert _mix_hex("#ff0000", "#0000ff", 1.0) == "#0000ff"
    assert _mix_hex("#000000", "#ffffff", 0.5) == "#808080"


BASE_LAYER = {"x": 0.0, "y": 0.0, "rotation": 0.0, "scale": 1.0, "opacity": 1.0}


def test_disabled_cloner_returns_the_layer_untouched():
    out = _expand_clones(BASE_LAYER, None, 1.0)
    assert out == [BASE_LAYER]


def test_no_vary_leaves_every_existing_field_as_before():
    cloner = {"enabled": True, "mode": "linear", "countX": 3, "countY": 1,
              "spacingX": 0.2, "spacingY": 0.0, "stepScale": 0.5}
    out = _expand_clones(BASE_LAYER, cloner, 1.0)
    # Back-to-front: the original (k=0) is LAST.
    assert [round(l["scale"], 6) for l in out] == [0.25, 0.5, 1.0]
    assert all(l.get("_tint") is None for l in out)


def test_vary_colour_tints_each_clone():
    cloner = {"enabled": True, "mode": "linear", "countX": 4, "countY": 1,
              "spacingX": 0.2, "spacingY": 0.0,
              "varyColor": True, "varyPalette": ["#ff0000", "#00ff00"]}
    out = _expand_clones(BASE_LAYER, cloner, 1.0)
    assert [l["_tint"] for l in out] == ["#00ff00", "#ff0000", "#00ff00", "#ff0000"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/cloner_vary_test.py -v`
Expected: FAIL — `ImportError: cannot import name '_hash32'`.

- [ ] **Step 3: Write the Python mirror**

In `comfy_extras/nodes_compositor.py`, add above `_expand_clones`:

```python
def _hash32(i: int, seed: int) -> float:
    """Mirror of hash32() in frontend/app/lib/vary/index.ts — keep the two in
    sync. Written in explicit 32-bit integer ops with no language-native RNG so
    the client preview and the server composite pick the SAME random values. The
    reference outputs are pinned in frontend/tests/unit/vary.unit.spec.ts and
    asserted from there by tests-unit/comfy_extras_test/cloner_vary_test.py."""
    M = 0xFFFFFFFF
    h = (int(i) ^ ((int(seed) * 0x9E3779B9) & M)) & M
    h = ((h ^ (h >> 16)) * 0x85EBCA6B) & M
    h = ((h ^ (h >> 13)) * 0xC2B2AE35) & M
    h = (h ^ (h >> 16)) & M
    return h / 4294967296.0


def _clamp01(n: float) -> float:
    return 0.0 if n < 0 else (1.0 if n > 1 else n)


def _vary_weights(steps: list[int], vary: dict) -> list[float]:
    """Mirror of varyWeights(). `steps` are the per-clone step indexes (k), NOT
    positions in the list — a mirrored twin shares its positive twin's k, and so
    shares its weight."""
    if not steps:
        return []
    max_step = max(steps)
    if max_step <= 0:
        return [0.0 for _ in steps]

    mode = vary.get("varyMode", "sequence")
    if mode == "random":
        seed = int(vary.get("varySeed", 0) or 0)
        return [_hash32(i, seed) for i in range(len(steps))]

    if mode == "falloff":
        r = max(1e-6, float(vary.get("varyFalloffRadius", 0.5) or 0.5))
        c = _clamp01(float(vary.get("varyFalloffCenter", 0.0) or 0.0))
        out = []
        for s in steps:
            d = abs(s / max_step - c)
            t = _clamp01(1.0 - _clamp01(d / r))
            out.append(t * t * (3.0 - 2.0 * t))
        return out

    return [_clamp01(s / max_step) for s in steps]


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = (hex_color or "").strip().lstrip("#")
    if len(h) == 3:
        h = h[0] * 2 + h[1] * 2 + h[2] * 2
    if len(h) == 8:
        h = h[:6]
    if len(h) != 6:
        return (0, 0, 0)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return (0, 0, 0)


def _mix_hex(a: str, b: str, t: float) -> str:
    """Mirror of mixHex(). Linear sRGB-space, deliberately not perceptual — see
    that function's own comment for why."""
    k = _clamp01(t)
    if k == 0:
        return a
    if k == 1:
        return b
    r1, g1, b1 = _hex_to_rgb(a)
    r2, g2, b2 = _hex_to_rgb(b)
    mix = lambda x, y: max(0, min(255, round(x + (y - x) * k)))
    return "#%02x%02x%02x" % (mix(r1, r2), mix(g1, g2), mix(b1, b2))


def _vary_color_at(w: float, index: int, vary: dict) -> str | None:
    """Mirror of varyColorAt()."""
    if not vary.get("varyColor"):
        return None
    pal = vary.get("varyPalette") or []
    if not pal:
        return None
    if len(pal) == 1:
        return pal[0]
    if vary.get("varyColorSpread", "cycle") == "cycle":
        if vary.get("varyMode", "sequence") == "sequence":
            return pal[index % len(pal)]
        return pal[min(len(pal) - 1, int(_clamp01(w) * len(pal)))]
    t = _clamp01(w) * (len(pal) - 1)
    i0 = min(len(pal) - 1, int(t))
    i1 = min(len(pal) - 1, i0 + 1)
    return _mix_hex(pal[i0], pal[i1], t - i0)
```

Then convert `_expand_clones` to the same two-pass shape as the TypeScript: collect `(k, dx, dy, extra_rot)` into `specs` (which it already does — see the existing comment at L226), then resolve. Replace the block that turns `specs` into layer dicts with:

```python
    weights = _vary_weights([k for k, _, _, _ in specs], cloner)
    seq = cloner.get("varyMode", "sequence") == "sequence"
    strength = float(cloner.get("varyColorStrength", 1.0) or 1.0)

    out = []
    for idx, (k, dx, dy, extra_rot) in enumerate(specs):
        w = weights[idx] if idx < len(weights) else 0.0
        # Sequence keeps the exact pre-vary maths (factor 1), which is what makes
        # an existing workflow composite byte-identically.
        f = 1.0 if seq else _clamp01(w)
        c = dict(layer)
        c["x"] = float(layer.get("x", 0.0)) + dx
        c["y"] = float(layer.get("y", 0.0)) + dy
        c["rotation"] = float(layer.get("rotation", 0.0)) + k * step_rot * f + extra_rot
        c["scale"] = float(layer.get("scale", 1.0)) * (step_scl ** (k * f))
        c["opacity"] = float(layer.get("opacity", 1.0)) * (step_op ** (k * f))
        c["_tint"] = _vary_color_at(w, k, cloner)
        c["_tint_strength"] = strength
        out.append(c)

    # Built k-ascending; reverse → the original (k=0) ends last = drawn on top.
    out.reverse()
    return out
```

Match the existing field names and the existing accumulation exactly — read the current body before replacing it, and keep whatever it already does for `x`/`y`/`rotation`/`scale`/`opacity` rather than assuming the lines above are verbatim.

- [ ] **Step 4: Apply the tint when compositing**

Add the PIL tint helper:

```python
def _tint_image(img, hex_color: str, strength: float):
    """Wash an RGBA layer toward `hex_color`, preserving its alpha — the PIL
    equivalent of the client's `source-atop` fill (tintScratch in
    useCompositorLayers.ts)."""
    from PIL import Image

    a = _clamp01(strength)
    if a <= 0 or not hex_color:
        return img
    rgba = img if img.mode == "RGBA" else img.convert("RGBA")
    solid = Image.new("RGB", rgba.size, _hex_to_rgb(hex_color))
    rgb = Image.blend(rgba.convert("RGB"), solid, a)
    rgb.putalpha(rgba.getchannel("A"))
    return rgb
```

At the paste site (~L535, where `expanded` clones are composited), apply it to each clone's image before pasting:

```python
            tint = lay.get("_tint")
            if tint:
                img = _tint_image(img, tint, float(lay.get("_tint_strength", 1.0) or 1.0))
```

Use the real local variable names from that function — read it first.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/cloner_vary_test.py -v`
Expected: PASS, all tests green — including the reference-hash assertion read from the TypeScript spec file.

Run the existing compositor suite too:

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/ -q`
Expected: no NEW failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add comfy_extras/nodes_compositor.py tests-unit/comfy_extras_test/cloner_vary_test.py
git commit -m "feat(compositor): mirror cloner vary in the server composite"
```

---

### Task 12: Live verification on both surfaces

**Files:** none — this task changes no code unless it finds a defect.

**Why it is its own task.** This codebase has a documented history of render features passing their unit tests and being wrong on screen. Unit tests here prove the maths and the plumbing; only a browser proves the pixels.

- [ ] **Step 1: Start the dev server**

Use the Browser pane's `preview_start`, never a Bash-launched server. If `.claude/launch.json` has no Nuxt entry, add one running `npm run dev` in `frontend/` on its port. Use `127.0.0.1`, not `localhost` — `localhost` returns HTTP 426 in this project.

Before debugging anything odd, check for stray dev servers from other sessions:

```bash
ps aux | grep -i "nuxt\|node.*dev" | grep -v grep
```

- [ ] **Step 2: Verify 3D Studio**

Open a 3D Studio node. On a box primitive:

1. Set the Cloner to 6 copies, linear. Confirm the Vary block appears (it is hidden at 1 copy).
2. Switch Colour on. Confirm the palette editor appears and the copies take different colours.
3. Add a third swatch. Confirm the copies re-colour without a reload — this proves the palette reached the geometry cache key.
4. Switch Spread to Blend. Confirm the copies fade between swatches rather than stepping.
5. Drag Colour strength to 0. Confirm every copy returns to the material colour.
6. Switch Vary to Random, change the seed. Confirm the arrangement reshuffles and is stable across a reload.
7. Switch to Falloff, drag Centre. Confirm the strongest copies move along the array.
8. Switch Colour off. Confirm the object returns to a single material colour — this is the rebuild boundary from Task 4.
9. Change the material to Image. Confirm the Colour switch disappears.

Take a screenshot of the coloured clone set.

- [ ] **Step 3: Verify Frame**

Open the Frame modal with a shape layer:

1. Enable the cloner, linear, 5 copies. Confirm the Vary block appears.
2. Switch Colour on, confirm the copies tint and the ORIGINAL (drawn last, on top) is tinted consistently with its own step.
3. Add a drop shadow to the layer. Confirm the tint is inside the shape and the shadow is not tinted — this proves the effected path tints before the effect chain.
4. Remove the shadow. Confirm the fast path still tints, and that layers beneath are NOT washed — this is the `source-atop` trap the scratch detour exists to avoid.
5. Switch to radial with a sweep, confirm colours follow the ring.
6. Switch Colour off, confirm the layer renders exactly as it did before the feature.

Take a screenshot of the tinted clone set.

- [ ] **Step 4: Check the console and the server log**

Run the Browser pane's console reader and confirm no new errors or warnings, in particular no three.js material or program warnings from the vertex-colour toggle.

- [ ] **Step 5: Report honestly**

Write up what you actually saw. If a step did not behave as described, that is a finding — fix it and re-verify rather than reporting the feature as landed. State plainly which of the fifteen checks above passed and which did not.

- [ ] **Step 6: Commit any fixes**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add -A
git commit -m "fix(vary): live verification findings"
```

Skip this step if verification found nothing.
