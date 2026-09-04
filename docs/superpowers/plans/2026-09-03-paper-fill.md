# Paper Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `paper` fill type to the shared spacetype `Fill` model — a base paper color with fine seeded grain tinted toward a second color, plus faint directional fibers.

**Architecture:** `paper` becomes a member of the shared `FillType` union / `FILL_TYPES` array, so it appears automatically in every studio's fill dropdown. Rendering reuses the one CPU tile builder (`fillTileCanvas` / `fillTileBox`), which the THREE path (`fillTexture`) and compositor path (`resolvePaint`) both call. A pure `paperImageData` helper computes the grain deterministically (fixed hash) so tiling and SVG-raster export are stable. SVG export needs no change — `paper` falls through `toVector.ts`'s existing `rasterTile` fallback automatically, since `exportTier` is derived, not tabulated.

**Tech Stack:** TypeScript, Vue 3 (Nuxt 4), THREE.js, Vitest (node env; DOM opt-in via docblock).

## Global Constraints

- The single source of truth for fill types is `frontend/app/lib/spacetype/fillTile.ts` (`FillType` union + `FILL_TYPES` array). `fills.ts` re-exports it.
- `fillTile.ts` sits in a documented circular import with `~/lib/compositor/paint`. Every cross-boundary value is an `export function` declaration (hoisted). Do NOT introduce `export const fn = () => …` for anything crossing that boundary.
- Canvas is sRGB. Convert hex → bytes with the existing `hexBytes()`, never through `THREE.Color`.
- Grain rendering MUST be deterministic (fixed seed / pure hash) — required for stable tiling and raster export. No `Math.random`, no time input.
- Vitest default environment is `node` (no DOM). A test needing `ImageData` / `document` must stub them with `vi.stubGlobal`, mirroring `frontend/tests/unit/fill-shapes-tile.unit.spec.ts`.
- New field name is `grain` (grain amount, `0..1`, default `0.4`). Reused fields: `a` = base color, `b` = grain/fiber tint, `density` = grain fineness, `angle` = fiber direction.
- All commands run from `frontend/`.

---

### Task 1: Data model + CPU grain renderer

**Files:**
- Modify: `frontend/app/lib/spacetype/fillTile.ts`
- Test: `frontend/tests/unit/paper-fill.unit.spec.ts` (create)

**Interfaces:**
- Consumes: existing `hexBytes(hex): [number,number,number]`, `Fill`, `FILL_TYPES`, `DEFAULT_FILL`, `normalizeFill`.
- Produces:
  - `FillType` union gains `'paper'`; `FILL_TYPES` array gains `'paper'`.
  - `Fill` interface gains `grain?: number`.
  - `export function paperImageData(w: number, h: number, fill: Fill): ImageData` — pure, deterministic grain.
  - `export function paintPaperTile(ctx: CanvasRenderingContext2D, fill: Fill, W: number, H: number): void` — puts the grain image then strokes faint fibers.
  - `normalizeFill` seeds/clamps `grain` for `type === 'paper'` and drops it otherwise.
  - `fillTileCanvas` and `fillTileBox` gain a `paper` arm.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/paper-fill.unit.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// node env has no ImageData — stub a minimal one (matches fill-shapes-tile's FakeCanvas approach).
class FakeImageData {
  data: Uint8ClampedArray; width: number; height: number
  constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4) }
}
beforeAll(() => { vi.stubGlobal('ImageData', FakeImageData) })
afterAll(() => vi.unstubAllGlobals())

import { paperImageData, normalizeFill, FILL_TYPES, DEFAULT_FILL, hexBytes, type Fill } from '../../app/lib/spacetype/fillTile'

const paper = (over: Partial<Fill> = {}): Fill =>
  ({ ...DEFAULT_FILL, type: 'paper', a: '#f3efe6', b: '#8b7d68', grain: 0.4, density: 12, angle: 0, ...over })

describe('paper fill — registration & model', () => {
  it('is registered in FILL_TYPES', () => { expect(FILL_TYPES).toContain('paper') })

  it('normalizeFill defaults grain to 0.4 and clamps to [0,1]', () => {
    expect(normalizeFill({ type: 'paper' }).grain).toBe(0.4)
    expect(normalizeFill({ type: 'paper', grain: 5 }).grain).toBe(1)
    expect(normalizeFill({ type: 'paper', grain: -2 }).grain).toBe(0)
    expect(normalizeFill({ type: 'paper', grain: 0.25 }).grain).toBeCloseTo(0.25, 6)
  })

  it('drops grain on a non-paper fill', () => {
    expect((normalizeFill({ type: 'solid', grain: 0.4 }) as any).grain).toBeUndefined()
  })
})

describe('paperImageData — deterministic grain', () => {
  it('is byte-for-byte deterministic for the same fill', () => {
    const a = paperImageData(16, 16, paper())
    const b = paperImageData(16, 16, paper())
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })

  it('with grain 0 is a flat base color (no grain drawn)', () => {
    const base = hexBytes('#f3efe6')
    const img = paperImageData(8, 8, paper({ grain: 0 }))
    for (let i = 0; i < img.data.length; i += 4) {
      expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual(base)
      expect(img.data[i + 3]).toBe(255)
    }
  })

  it('with grain > 0 varies pixels away from the flat base (grain drew)', () => {
    const base = hexBytes('#f3efe6')
    const img = paperImageData(16, 16, paper({ grain: 0.6 }))
    let varied = 0
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] !== base[0] || img.data[i + 1] !== base[1] || img.data[i + 2] !== base[2]) varied++
    }
    expect(varied).toBeGreaterThan(0)
  })

  it('blends to INTERMEDIATE values (paper ≠ hard two-color noise)', () => {
    // noise emits only exact-a or exact-b bytes; paper interpolates, so some channel
    // value must fall strictly between base and tint for the red channel.
    const baseR = hexBytes('#f3efe6')[0], tintR = hexBytes('#8b7d68')[0]
    const lo = Math.min(baseR, tintR), hi = Math.max(baseR, tintR)
    const img = paperImageData(16, 16, paper({ grain: 0.7 }))
    let intermediate = false
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i]
      if (r > lo && r < hi) { intermediate = true; break }
    }
    expect(intermediate).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/paper-fill.unit.spec.ts`
Expected: FAIL — `paperImageData` is not exported / `FILL_TYPES` has no `'paper'`.

- [ ] **Step 3: Add `paper` to the type union, array, and `Fill` interface**

In `fillTile.ts`, change the `FillType` union (line ~36) to add `'paper'`:

```ts
export type FillType = 'solid' | 'gradient' | 'ombre' | 'grid' | 'noise' | 'checkerboard' | 'stripes' | 'qr' | 'shader' | 'shapes' | 'paper'
```

Change the `FILL_TYPES` array (line ~60) to add `'paper'` at the end:

```ts
export const FILL_TYPES: FillType[] = ['solid', 'gradient', 'ombre', 'grid', 'noise', 'checkerboard', 'stripes', 'qr', 'shader', 'shapes', 'paper']
```

Add `grain` to the `Fill` interface (line ~43). Extend the field list and its doc:

```ts
/** `a`/`b` drive the slot's fill (stripe); `textColor` is the solid colour for type on that row.
 *  `angle` (degrees) applies to `stripes`/`gradient`/`ombre`/`shapes` (per-shape rotation) and to
 *  `paper` (fibre direction); `density` controls cell/stripe count, and grain fineness for `paper`.
 *  `shapeId`, `shapeSize`, `shapeGap` are only meaningful for `type === 'shapes'`. `grain` (0..1)
 *  is only meaningful for `type === 'paper'`: the grain strength, set only by `normalizeFill`. */
export interface Fill { type: FillType; a: string; b: string; textColor: string; angle: number; density: number; shader?: ShaderSpec; shapeId?: string; shapeSize?: number; shapeGap?: number; grain?: number }
```

- [ ] **Step 4: Seed/clamp `grain` in `normalizeFill`**

In `normalizeFill`, after the `if (type === 'shapes') { … }` block (ends line ~157) and before `if (type !== 'shader') return base`, add:

```ts
  // `grain` (0..1) is only meaningful for a `paper` fill — the grain strength. Default 0.4,
  // clamped, so every downstream consumer can assume a real number whenever `type === 'paper'`.
  if (type === 'paper') {
    base.grain = typeof o.grain === 'number' ? Math.max(0, Math.min(1, o.grain)) : 0.4
  }
```

- [ ] **Step 5: Add the pure `paperImageData` helper and `paintPaperTile`**

In `fillTile.ts`, just before `fillTileCanvas` (line ~406), add:

```ts
/** Deterministic per-cell hash in [0,1) — the seed for paper's grain and fibre placement.
 *  Fixed constants (no time, no Math.random) so a paper tile is byte-stable across renders,
 *  which is what lets it tile and raster-export without shimmer. */
function paperHash(cx: number, cy: number): number {
  const v = Math.sin(cx * 127.1 + cy * 311.7) * 43758.5453
  return v - Math.floor(v)
}

/**
 * Paper grain as a pure ImageData: base colour `a` speckled toward the grain tint `b` on the
 * dark side and toward white on the light side, giving paper "tooth". `grain` (0..1) scales the
 * speckle strength; `density` sets grain fineness (bigger density ⇒ smaller grain cells, matching
 * the other patterned fills' "more density = finer detail"). Exported so it can be unit-tested
 * without a DOM canvas.
 */
export function paperImageData(w: number, h: number, fill: Fill): ImageData {
  const base = hexBytes(fill.a), tint = hexBytes(fill.b)
  const grain = Math.max(0, Math.min(1, fill.grain ?? 0.4))
  const cell = Math.max(1, Math.round(24 / Math.max(1, fill.density || 1)))
  const img = new ImageData(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    const px = (i / 4) % w, py = Math.floor((i / 4) / w)
    const n = paperHash(Math.floor(px / cell), Math.floor(py / cell))   // 0..1 per grain cell
    const k = (n - 0.5) * 2 * grain                                     // -grain..+grain
    for (let ch = 0; ch < 3; ch++) {
      const target = k >= 0 ? tint[ch] : 255                            // dark fleck → tint, light fleck → white
      img.data[i + ch] = Math.round(base[ch] + (target - base[ch]) * Math.abs(k))
    }
    img.data[i + 3] = 255
  }
  return img
}

/** Paint a paper fill onto a size-agnostic tile: the grain image, then a few faint directional
 *  fibre streaks along `angle` tinted toward `b`. Fibre count/opacity grow with `grain`.
 *  Deterministic (seeded via paperHash). */
export function paintPaperTile(ctx: CanvasRenderingContext2D, fill: Fill, W: number, H: number): void {
  ctx.putImageData(paperImageData(W, H, fill), 0, 0)
  const grain = Math.max(0, Math.min(1, fill.grain ?? 0.4))
  const count = Math.round(6 + grain * 18)
  const rad = (fill.angle * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad)
  const maxLen = Math.max(W, H)
  ctx.save()
  ctx.strokeStyle = fill.b
  ctx.globalAlpha = 0.05 + grain * 0.08
  ctx.lineWidth = 1
  for (let i = 0; i < count; i++) {
    const cx = paperHash(i, 7) * W, cy = paperHash(i, 13) * H
    const len = (0.1 + paperHash(i, 19) * 0.25) * maxLen
    ctx.beginPath()
    ctx.moveTo(cx - dx * len / 2, cy - dy * len / 2)
    ctx.lineTo(cx + dx * len / 2, cy + dy * len / 2)
    ctx.stroke()
  }
  ctx.restore()
}
```

- [ ] **Step 6: Add the `paper` arm to `fillTileCanvas` and `fillTileBox`**

In `fillTileCanvas`, after the `shapes` arm (line ~429 `if (fill.type === 'shapes') { paintShapesTile(ctx, fill, size, size); return c }`), add:

```ts
  if (fill.type === 'paper') { paintPaperTile(ctx, fill, size, size); return c }
```

In `fillTileBox`, after its `shapes` arm (line ~474 `if (fill.type === 'shapes') { paintShapesTile(ctx, fill, W, H); return c }`), add:

```ts
  if (fill.type === 'paper') { paintPaperTile(ctx, fill, W, H); return c }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/unit/paper-fill.unit.spec.ts`
Expected: PASS (all 7 assertions).

- [ ] **Step 8: Commit**

```bash
git add app/lib/spacetype/fillTile.ts tests/unit/paper-fill.unit.spec.ts
git commit -m "feat(fills): add paper fill type — base + seeded grain + fibers (model + CPU render)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: THREE / GPU path — `paperTex`, `fillTexture` arm + cache key, `fillAtlasTexture` arm

**Files:**
- Modify: `frontend/app/lib/spacetype/fills.ts`
- Test: `frontend/tests/unit/paper-fill.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `fillTileCanvas` (now paper-aware), `tunePattern`, the `Fill` type; from Task 1 the `paper` FillType.
- Produces: `fillTexture` routes `paper` through a real paper tile (NOT the `qrTex` fallthrough) and keys its cache on `grain`; `fillAtlasTexture` stamps a paper tile per band and keys on `grain`.

**Context — why this task exists:** `fillTexture`'s type dispatch is a ternary chain ending in `: qrTex(...)`. A new shared `FILL_TYPES` member with no explicit arm silently renders as a QR lattice on every GPU surface (Space Type, Shape Studio, Scene3D). `fillAtlasTexture` is a second, independent GPU tiler whose `else` renders a flat `a` band. Both need a `paper` arm. (This is the exact bug the `shapes` type hit — see `fill-shapes-tile.unit.spec.ts` comments.)

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/unit/paper-fill.unit.spec.ts`:

```ts
// ── GPU path ────────────────────────────────────────────────────────────────
// fillTexture's dispatch ends in `: qrTex(...)`. A new shared FILL_TYPES member with no arm
// renders as QR on every GPU surface. paintPaperTile strokes fibres (qr does not), so a paper
// tile records `stroke` ops while a qr tile does not — that distinguishes the two.
class FakeCtx {
  ops: any[] = []
  fillStyle: any = ''; strokeStyle = ''; lineWidth = 0; globalAlpha = 1
  save() {} restore() {}
  fillRect() {} beginPath() {} moveTo() {} lineTo() {}
  stroke() { this.ops.push(['stroke']) }
  putImageData() { this.ops.push(['putImageData']) }
  createLinearGradient() { return { addColorStop() {} } }
  getImageData() { return { data: new Uint8ClampedArray(4) } }
  drawImage() {}
  translate() {} rotate() {} scale() {} clip() {} clearRect() {} setTransform() {}
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }

let gpuCreated: FakeCanvas[] = []
function installGpuDom() {
  vi.stubGlobal('document', { createElement: () => { const c = new FakeCanvas(); gpuCreated.push(c); return c } })
}

import * as THREE from 'three'
import { fillTexture, fillAtlasTexture } from '../../app/lib/spacetype/fills'

describe('paper fill — GPU path (fillTexture)', () => {
  beforeAll(() => installGpuDom())
  it('routes paper through the paper tiler (fibre strokes), NOT qrTex', () => {
    gpuCreated = []
    const tex = fillTexture(THREE, paper({ grain: 0.5 }))
    expect(tex).toBeInstanceOf(THREE.CanvasTexture)
    // At least one produced canvas recorded a putImageData (grain) AND a stroke (fibre) — qr has no stroke.
    const paperTile = gpuCreated.find(c => c.ctx.ops.some((o: any) => o[0] === 'stroke'))
    expect(paperTile).toBeTruthy()
    expect(paperTile!.ctx.ops.some((o: any) => o[0] === 'putImageData')).toBe(true)
  })
  it('caches per grain (changing only grain re-tiles)', () => {
    const a = fillTexture(THREE, paper({ a: '#eeeeee', grain: 0.3 }))
    const b = fillTexture(THREE, paper({ a: '#eeeeee', grain: 0.8 }))
    const aAgain = fillTexture(THREE, paper({ a: '#eeeeee', grain: 0.3 }))
    expect(b).not.toBe(a)
    expect(aAgain).toBe(a)
  })
})

describe('paper fill — GPU atlas (fillAtlasTexture)', () => {
  beforeAll(() => installGpuDom())
  it('stamps a paper tile into the band, not a flat colour', () => {
    gpuCreated = []
    fillAtlasTexture(THREE, [paper({ grain: 0.5 })])
    const tile = gpuCreated.find(c => c.ctx.ops.some((o: any) => o[0] === 'stroke'))
    expect(tile).toBeTruthy()   // a real paper tile (fibres) was stamped, not a flat fillRect band
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/paper-fill.unit.spec.ts`
Expected: FAIL — `fillTexture` falls through to `qrTex` (no `stroke` op) and its cache key ignores `grain` (both grains alias to one texture); `fillAtlasTexture` renders a flat band.

- [ ] **Step 3: Add the `paperTex` builder**

In `fills.ts`, next to `shapesTex` (line ~513), add:

```ts
/** Paper: the same CPU tile builder the swatch/box render use, so the GPU surface matches the
 *  CPU render exactly. 512px keeps the grain crisp; tunePattern sets SRGB + RepeatWrapping. */
function paperTex(three: typeof THREE, fill: Fill): THREE.Texture {
  const t = new three.CanvasTexture(fillTileCanvas(fill, 512))
  tunePattern(three, t)
  return t
}
```

- [ ] **Step 4: Add the `paper` arm and grain cache key to `fillTexture`**

In `fillTexture`, extend the cache `key` (line ~342) so paper keys on `grain` (like shapes keys on shape):

```ts
  const key = `${fill.type}|${fill.a}|${fill.b}|${fill.angle}|${fill.density}|${fill.type === 'shapes' ? (fill.shapeId ?? 'sparkle') + ':' + fill.shapeSize + ':' + fill.shapeGap : fill.type === 'paper' ? String(fill.grain ?? 0.4) : ''}`
```

Add the `paper` arm to the dispatch chain (line ~351), before the final `: qrTex(...)`:

```ts
    : fill.type === 'shapes' ? shapesTex(three, fill)
    : fill.type === 'paper' ? paperTex(three, fill)
    : qrTex(three, fill.a, fill.b, fill.density)
```

- [ ] **Step 5: Add the `paper` arm to `fillAtlasTexture`**

In `fillAtlasTexture`, extend the cache `key` (line ~400) to fold in `grain` for paper:

```ts
  const key = fills.map(f => `${f.type}:${f.a}:${f.b}:${f.angle}:${f.density}${f.type === 'shapes' ? ':' + (f.shapeId ?? 'sparkle') + ':' + f.shapeSize + ':' + f.shapeGap : f.type === 'paper' ? ':' + String(f.grain ?? 0.4) : ''}`).join('|')
```

Add a `paper` branch in the per-band `forEach`, mirroring the `shapes` branch (line ~439). Insert before the final `else`:

```ts
    } else if (fill.type === 'paper') {
      // Stamp the shared paper tile into this band (one BAND×BAND cell), so per-segment
      // palettes get real grain instead of a flat colour.
      ctx.drawImage(fillTileCanvas(fill, BAND), 0, y0)
    } else {
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/paper-fill.unit.spec.ts`
Expected: PASS (Task 1 + Task 2 assertions).

- [ ] **Step 7: Run the sibling fill regression suite (no collateral breakage)**

Run: `npx vitest run tests/unit/fill-shapes-tile.unit.spec.ts tests/unit/compositor-fills.unit.spec.ts tests/unit/paint-tile.unit.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/lib/spacetype/fills.ts tests/unit/paper-fill.unit.spec.ts
git commit -m "feat(fills): render paper on the THREE/atlas GPU paths (arm + grain cache key)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: FillControl UI — grain slider, control gating, defaults

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/FillControl.vue`

**Interfaces:**
- Consumes: the `paper` FillType, `Fill.grain`, `fillTileCanvas` (paper-aware preview).
- Produces: picking `paper` shows Base(A)/Tint(B) colors, a Grain amount slider (`grain`, 0..1), a Grain scale slider (`density`), and a Fibre direction slider (`angle`); switching into `paper` seeds tasteful defaults.

**Note:** `paper` already appears in the dropdown with no list edit — the dropdown reads `FILL_TYPES` dynamically (`availableTypes`). This task only wires its controls. Other studios (Shape FX, Vector Type, Space Type) render `paper` with default `grain` via their own control schemas; exposing the grain slider there is out of scope for v1, matching how `shapes` shipped.

- [ ] **Step 1: Add `grain` to `setNum`'s key union**

In `FillControl.vue`, `setNum` (line ~164) currently accepts `'angle' | 'density' | 'shapeSize' | 'shapeGap'`. Add `'grain'`:

```ts
function setNum(key: 'angle' | 'density' | 'shapeSize' | 'shapeGap' | 'grain', v: number) { fill[key] = v; push() }
```

- [ ] **Step 2: Extend the control-gating computeds**

`needsB` is already true for `paper` (it is neither `solid` nor `gradient`), so Base(A)/Tint(B) show with no change.

Extend `needsAngle` (line ~186) — paper uses angle as fibre direction:

```ts
const needsAngle = computed(() => fill.type === 'ombre' || fill.type === 'stripes' || fill.type === 'shapes' || fill.type === 'paper')
```

Extend `needsDensity` (line ~187) — paper uses density as grain fineness:

```ts
const needsDensity = computed(() => fill.type === 'grid' || fill.type === 'checkerboard' || fill.type === 'stripes' || fill.type === 'noise' || fill.type === 'qr' || fill.type === 'paper')
```

Add a new `needsGrain` computed immediately after `needsShapeGrid` (line ~189):

```ts
// Paper exposes a grain-amount slider (0..1) on top of the shared A/B + density + angle rows.
const needsGrain = computed(() => fill.type === 'paper')
```

- [ ] **Step 3: Seed paper defaults in `setType`**

In `setType` (line ~125), after the `if (t === 'shapes') { … }` block (ends line ~141) and before `fill.type = t; push()`, add:

```ts
  // Switching INTO paper seeds a grain amount plus tasteful paper colours + a fine grain scale,
  // but only overwrites colours/density still at their solid defaults (never a user's own values).
  if (t === 'paper') {
    if (typeof fill.grain !== 'number') fill.grain = 0.4
    if (fill.a === '#ffffff') fill.a = '#f3efe6'
    if (fill.b === '#000000') fill.b = '#8b7d68'
    if (fill.density === 8) fill.density = 12
  }
```

- [ ] **Step 4: Add the Grain amount slider to the template**

In the `<template>`, after the `needsDensity` block (closes line ~365) and before the first `needsShapeGrid` block (line ~367), add:

```vue
      <div v-if="needsGrain">
        <div class="flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-white/35 mb-1">
          <span>Grain</span><span class="tabular-nums normal-case">{{ Math.round((fill.grain ?? 0.4) * 100) }}%</span>
        </div>
        <input type="range" min="0" max="1" step="0.02" :value="fill.grain ?? 0.4" class="w-full accent-white cursor-pointer"
          @input="setNum('grain', Number(($event.target as HTMLInputElement).value))" />
      </div>
```

- [ ] **Step 5: Verify in the browser (preview workflow)**

There is no unit test for the `.vue`; verify live.

1. Start the dev server via the preview tool (`.claude/launch.json` dev server; localhost host is `127.0.0.1`, not `localhost`).
2. Open a surface that mounts `FillControl` — the Frame/Compositor modal or Shape Studio.
3. In a fill picker, open the type dropdown and select **paper**. Confirm:
   - The swatch preview shows a grainy paper texture (not a flat colour, not a QR lattice).
   - Controls shown: A + B colors, **Grain** slider, **Density** (grain scale), **Angle** (fibre direction).
   - Dragging **Grain** to 0 flattens to the base colour; dragging up increases speckle. Dragging **Angle** rotates the fibre streaks. Dragging **Density** changes grain fineness.
4. `read_console_messages` — no errors.
5. Screenshot the paper swatch + controls to share as proof.

- [ ] **Step 6: Typecheck the touched modules**

Run: `npx nuxi typecheck`
Expected: No NEW errors that name `paper`, `grain`, `Fill`, `FillControl`, `fillTexture`, or `fillTileCanvas`. (Pre-existing baseline errors unrelated to these files are acceptable — see the typecheck-baseline note in project memory: an error naming your own type is NOT pre-existing.)

- [ ] **Step 7: Commit**

```bash
git add app/components/vue-canvas/compositor/FillControl.vue
git commit -m "feat(fills): paper fill controls in FillControl (grain slider + gating + defaults)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model (`FillType`, `FILL_TYPES`, `grain` field, `normalizeFill`) → Task 1 Steps 3–4. ✓
- CPU render (`paintPaperTile`, `fillTileCanvas`, `fillTileBox`) + deterministic seeded grain → Task 1 Steps 5–6. ✓
- Faint directional fibers along `angle` → Task 1 Step 5 (`paintPaperTile`). ✓
- THREE path (`paperTex`, `fillTexture` case, `fillAtlasTexture` arm) → Task 2. ✓
- Cache keys fold in `grain` → Task 2 Steps 4–5. ✓
- SVG export via `rasterTile` fallback → automatic (spec §Rendering; `exportTier` derived, no code) — noted in Task 2 context and plan header; **no task needed** (verified against `toVector.ts`: `patternFor` returns `rasterTile` for any non-stripes/grid/checker/qr fill, and `exportTier` reads it structurally). ✓
- UI controls (base, grain tint, grain amount, grain scale, fiber direction) + defaults → Task 3. ✓
- Testing (registration, normalize defaults/clamp, determinism, grain drew, paper ≠ noise, GPU not-qr) → Task 1 + Task 2 tests. ✓
- `resolve.ts` needs no branch (pattern `Fill`s flow through `fillTileBox`) → confirmed against `resolve.ts`; no task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the code. ✓

**Type consistency:** `paperImageData(w,h,fill)`, `paintPaperTile(ctx,fill,W,H)`, `paperTex(three,fill)`, `Fill.grain?: number`, `setNum` union with `'grain'` — names/signatures consistent across Tasks 1–3. Cache-key expressions use `fill.grain ?? 0.4` in both `fillTexture` and `fillAtlasTexture`. ✓
