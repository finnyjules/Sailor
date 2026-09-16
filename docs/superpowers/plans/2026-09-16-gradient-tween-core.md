# Gradient Tween Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, framework-free colour module that resolves a gradient transition (crossfade / travel / scroll) to a colour LUT or stop array at a given time, in OKLab (default) or Hybrid space.

**Architecture:** One new module `app/lib/color/gradientTween.ts` beside the existing colour utilities. It reuses `convert.ts` (OKLab/hex conversion) and `mix.ts` (`mixHex`) rather than reimplementing colour maths, and uses the existing `GradientStop { pos; color }` shape from `harmony.ts`. No Vue, no DOM, no canvas — it takes stop arrays / a phase in and returns a `Uint8ClampedArray` LUT or a `GradientStop[]` out. This is the shared oracle both compositor render paths (a later plan) will call.

**Tech Stack:** TypeScript (strict), Vitest unit tests.

## Global Constraints

- **Pure module.** No imports of Vue, Nuxt, DOM, or canvas in `gradientTween.ts`. Colours are `#rrggbb` hex strings; geometry is plain numbers.
- **Reuse, do not reimplement.** OKLab/hex conversion comes from `app/lib/color/convert.ts` (`hexToRgb`, `rgbToHex`, `hexToOklab`, `oklabToRgb` — all use **0–255** RGB). OKLab colour interpolation comes from `app/lib/color/mix.ts` (`mixHex(from, to, t, 'oklab')`, which already returns byte-exact endpoints at `t≤0`/`t≥1`).
- **Stop shape:** `GradientStop { pos: number; color: string }` imported from `app/lib/color/harmony.ts`. `pos` is 0..1; `color` is `#rrggbb`.
- **Colour spaces:** `BlendSpace = 'oklab' | 'hybrid'`. `'oklab'` is the default everywhere. OKLCH is intentionally NOT a `BlendSpace` (it seams — see the spec); it appears only inside a regression test.
- **Tests:** live under `tests/unit/**/*.unit.spec.ts`, run with `npm run test:unit` (Vitest, `environment: 'node'`). Import app modules via the `~` alias (e.g. `import { crossfadeLUT } from '~/lib/color/gradientTween'`).
- **Committing (repo rule — shared git index is hostile).** This checkout has unrelated changes staged by other sessions. NEVER `git add -A` or bare `git commit`. Commit only your exact paths: `git add -- <newfiles>` then `git commit -- <path1> <path2> -m "<msg>"` (the pathspec form commits only those files' working-tree content, ignoring anything else staged). End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Reference:** spec at `docs/superpowers/specs/2026-09-16-gradient-transitions-design.md`.

## File Structure

- **Create** `frontend/app/lib/color/gradientTween.ts` — the whole core (blend, sample, resample/pair, crossfade, travel, scroll).
- **Create** `frontend/tests/unit/color/gradientTween.unit.spec.ts` — the unit suite.

All paths below are relative to `frontend/` (the Nuxt app root; run `npm` commands there).

---

### Task 1: `blendHex` — two-colour blend in OKLab and Hybrid

**Files:**
- Create: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `hexToOklab`, `oklabToRgb`, `rgbToHex` from `~/lib/color/convert`; `mixHex` from `~/lib/color/mix`.
- Produces: `type BlendSpace = 'oklab' | 'hybrid'`; `blendHex(from: string, to: string, t: number, space?: BlendSpace): string`. Byte-exact at `t≤0` (returns `from`) and `t≥1` (returns `to`). OKLab delegates to `mixHex`; Hybrid uses the OKLab straight-line direction with chroma re-inflated to the linear chroma value.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/color/gradientTween.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { hexToOklab } from '~/lib/color/convert'
import { blendHex } from '~/lib/color/gradientTween'

function chroma(hex: string): number { const [, a, b] = hexToOklab(hex); return Math.hypot(a, b) }

describe('blendHex', () => {
  it('returns exact endpoints', () => {
    expect(blendHex('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 1)).toBe('#0000ff')
    expect(blendHex('#ff0000', '#0000ff', -0.5, 'hybrid')).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 2, 'hybrid')).toBe('#0000ff')
  })

  it('oklab delegates to mixHex (matches its midpoint)', () => {
    // a mid blend is between the two colours, not equal to either
    const mid = blendHex('#ff0000', '#0000ff', 0.5, 'oklab')
    expect(mid).not.toBe('#ff0000')
    expect(mid).not.toBe('#0000ff')
  })

  it('hybrid keeps more chroma at the midpoint than oklab for a complementary pair', () => {
    const cOklab = chroma(blendHex('#ff7a00', '#0060ff', 0.5, 'oklab'))
    const cHybrid = chroma(blendHex('#ff7a00', '#0060ff', 0.5, 'hybrid'))
    expect(cHybrid).toBeGreaterThan(cOklab)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `Cannot find module '~/lib/color/gradientTween'` / `blendHex is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/color/gradientTween.ts
//
// Pure gradient-transition core: resolve a crossfade / travel / scroll to a colour
// LUT or stop array at a given time. No Vue/DOM/canvas. Reuses convert.ts + mix.ts;
// uses harmony.ts's GradientStop shape. See
// docs/superpowers/specs/2026-09-16-gradient-transitions-design.md.
import { hexToOklab, hexToRgb, oklabToRgb, rgbToHex } from './convert'
import { mixHex } from './mix'
import type { GradientStop } from './harmony'

export type BlendSpace = 'oklab' | 'hybrid'
export const BLEND_SPACES = ['oklab', 'hybrid'] as const

/**
 * Blend two hex colours at `t` in the given space. Byte-exact at the ends.
 * OKLab: the shared `mixHex`. Hybrid: OKLab straight-line DIRECTION (never flips)
 * with chroma re-inflated to the linear value so complementary midpoints stay vivid.
 */
export function blendHex(from: string, to: string, t: number, space: BlendSpace = 'oklab'): string {
  if (t <= 0) return from
  if (t >= 1) return to
  if (space === 'oklab') return mixHex(from, to, t, 'oklab')
  const [L1, a1, b1] = hexToOklab(from)
  const [L2, a2, b2] = hexToOklab(to)
  const L = L1 + (L2 - L1) * t
  let a = a1 + (a2 - a1) * t
  let b = b1 + (b2 - b1) * t
  const cStraight = Math.hypot(a, b)
  const cWant = Math.hypot(a1, b1) + (Math.hypot(a2, b2) - Math.hypot(a1, b1)) * t
  if (cStraight > 1e-6 && cWant > cStraight) { const s = cWant / cStraight; a *= s; b *= s }
  return rgbToHex(...oklabToRgb(L, a, b))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts
git commit -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts -m "feat(color): blendHex — OKLab + Hybrid two-colour blend (gradient tween core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `sampleRamp` + `buildLUT`

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `blendHex`, `hexToRgb`, `GradientStop`.
- Produces:
  - `sampleRamp(stops: GradientStop[], u: number, space?: BlendSpace): string` — piecewise blend of a static ramp, clamped at the ends, stops sorted by `pos`.
  - `buildLUT(stops: GradientStop[], space?: BlendSpace, size?: number): Uint8ClampedArray` — `size*3` bytes (default `size = 256`), row `i` sampled at `u = i/(size-1)`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { sampleRamp, buildLUT } from '~/lib/color/gradientTween'
import type { GradientStop } from '~/lib/color/harmony'

const RAMP: GradientStop[] = [
  { pos: 0, color: '#000000' },
  { pos: 0.5, color: '#ff0000' },
  { pos: 1, color: '#ffffff' },
]

describe('sampleRamp', () => {
  it('clamps to the end stops outside [first,last]', () => {
    expect(sampleRamp(RAMP, -1)).toBe('#000000')
    expect(sampleRamp(RAMP, 2)).toBe('#ffffff')
  })
  it('returns a stop colour exactly at its position', () => {
    expect(sampleRamp(RAMP, 0.5)).toBe('#ff0000')
  })
  it('is order-independent (unsorted input)', () => {
    const shuffled = [RAMP[2], RAMP[0], RAMP[1]]
    expect(sampleRamp(shuffled, 0.5)).toBe('#ff0000')
  })
})

describe('buildLUT', () => {
  it('has size*3 bytes and exact endpoints', () => {
    const lut = buildLUT(RAMP, 'oklab', 256)
    expect(lut.length).toBe(768)
    expect([lut[0], lut[1], lut[2]]).toEqual([0, 0, 0])
    expect([lut[765], lut[766], lut[767]]).toEqual([255, 255, 255])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `sampleRamp is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
function sortStops(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((x, y) => x.pos - y.pos)
}

export function sampleRamp(stops: GradientStop[], u: number, space: BlendSpace = 'oklab'): string {
  const s = sortStops(stops)
  if (s.length === 0) return '#000000'
  if (u <= s[0].pos) return s[0].color
  const last = s[s.length - 1]
  if (u >= last.pos) return last.color
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1]
    if (u >= a.pos && u <= b.pos) {
      const lt = (u - a.pos) / ((b.pos - a.pos) || 1)
      return blendHex(a.color, b.color, lt, space)
    }
  }
  return last.color
}

export function buildLUT(stops: GradientStop[], space: BlendSpace = 'oklab', size = 256): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 3)
  for (let i = 0; i < size; i++) {
    const u = size === 1 ? 0 : i / (size - 1)
    const [r, g, b] = hexToRgb(sampleRamp(stops, u, space))
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git commit -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts -m "feat(color): sampleRamp + buildLUT (gradient tween core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `resampleStops` + `pairStops`

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `sampleRamp`, `sortStops` (internal), `GradientStop`.
- Produces:
  - `resampleStops(stops, n, space?): GradientStop[]` — a ramp re-expressed as `n` evenly-positioned stops (appearance-preserving); returns a copy of the input when `stops.length === n`.
  - `pairStops(from, to, space?): [GradientStop[], GradientStop[]]` — both ramps resampled to `N = max(len)`, so index `i` pairs across.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { resampleStops, pairStops } from '~/lib/color/gradientTween'

describe('resampleStops / pairStops', () => {
  it('resamples up to n evenly-positioned stops', () => {
    const out = resampleStops([{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], 5)
    expect(out.length).toBe(5)
    expect(out.map(s => s.pos)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(out[0].color).toBe('#000000')
    expect(out[4].color).toBe('#ffffff')
  })
  it('returns equal-length arrays paired to the larger count', () => {
    const a = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]          // 2
    const b = [{ pos: 0, color: '#001122' }, { pos: 0.5, color: '#334455' }, { pos: 1, color: '#66778f' }] // 3
    const [A, B] = pairStops(a, b)
    expect(A.length).toBe(3)
    expect(B.length).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `resampleStops is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
export function resampleStops(stops: GradientStop[], n: number, space: BlendSpace = 'oklab'): GradientStop[] {
  const s = sortStops(stops)
  if (s.length === n) return s.map(x => ({ pos: x.pos, color: x.color }))
  const out: GradientStop[] = []
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0.5 : i / (n - 1)
    out.push({ pos: u, color: sampleRamp(s, u, space) })
  }
  return out
}

export function pairStops(
  from: GradientStop[],
  to: GradientStop[],
  space: BlendSpace = 'oklab',
): [GradientStop[], GradientStop[]] {
  const N = Math.max(from.length, to.length)
  return [resampleStops(from, N, space), resampleStops(to, N, space)]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts -m "feat(color): resampleStops + pairStops for travel pairing (gradient tween core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `crossfadeLUT` (A→B per-position morph)

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `sampleRamp`, `blendHex`, `hexToRgb`, `buildLUT`.
- Produces: `crossfadeLUT(from, to, t, space?, size?): Uint8ClampedArray` — for each position `u`, `blendHex(sampleRamp(from,u), sampleRamp(to,u), t)`. At `t=0` equals `buildLUT(from)`, at `t=1` equals `buildLUT(to)`. Needs no pairing.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { crossfadeLUT } from '~/lib/color/gradientTween'

const FROM: GradientStop[] = [{ pos: 0, color: '#120000' }, { pos: 0.6, color: '#c9370e' }, { pos: 1, color: '#ffcf7a' }]
const TO: GradientStop[] = [{ pos: 0, color: '#01121f' }, { pos: 0.28, color: '#043a5b' }, { pos: 0.55, color: '#1f8fa8' }, { pos: 0.8, color: '#7fe0c9' }, { pos: 1, color: '#f6ffe8' }]

describe('crossfadeLUT', () => {
  it('equals the source LUTs at the endpoints', () => {
    expect(Array.from(crossfadeLUT(FROM, TO, 0))).toEqual(Array.from(buildLUT(FROM)))
    expect(Array.from(crossfadeLUT(FROM, TO, 1))).toEqual(Array.from(buildLUT(TO)))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `crossfadeLUT is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
export function crossfadeLUT(
  from: GradientStop[],
  to: GradientStop[],
  t: number,
  space: BlendSpace = 'oklab',
  size = 256,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 3)
  for (let i = 0; i < size; i++) {
    const u = size === 1 ? 0 : i / (size - 1)
    const c = blendHex(sampleRamp(from, u, space), sampleRamp(to, u, space), t, space)
    const [r, g, b] = hexToRgb(c)
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts -m "feat(color): crossfadeLUT — per-position A→B morph (gradient tween core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `travelStops` (A→B with stops sliding)

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `pairStops`, `blendHex`.
- Produces: `travelStops(from, to, t, space?): GradientStop[]` — pair to `N=max`, then per index ease colour (`blendHex`) and lerp position. At `t=0` equals `pairStops(...)[0]`; at `t=1` equals `pairStops(...)[1]` (i.e. `to` resampled/paired). Build a LUT from it with `buildLUT`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { travelStops } from '~/lib/color/gradientTween'

describe('travelStops', () => {
  it('lands on the paired endpoints', () => {
    const [A, B] = pairStops(FROM, TO)
    expect(travelStops(FROM, TO, 0)).toEqual(A)
    expect(travelStops(FROM, TO, 1)).toEqual(B)
  })
  it('lerps a stop position across the transition', () => {
    // paired FROM (3→5) sits at even positions; TO keeps its real positions.
    const [A, B] = pairStops(FROM, TO)
    const mid = travelStops(FROM, TO, 0.5)
    expect(mid[1].pos).toBeCloseTo((A[1].pos + B[1].pos) / 2, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `travelStops is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
export function travelStops(
  from: GradientStop[],
  to: GradientStop[],
  t: number,
  space: BlendSpace = 'oklab',
): GradientStop[] {
  const [A, B] = pairStops(from, to, space)
  return A.map((a, i) => ({
    color: blendHex(a.color, B[i].color, t, space),
    pos: a.pos + (B[i].pos - a.pos) * t,
  }))
}
```

Note: `travelStops(...,0)` must equal `A` byte-for-byte. `blendHex(...,0)` returns the raw `a.color` string and `pos + (…)*0 === pos`, so the objects deep-equal `A`. (If a future change makes `blendHex` round-trip at 0, add an explicit `t<=0`/`t>=1` short-circuit here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts -m "feat(color): travelStops — A→B with sliding stops (gradient tween core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `scrollLUT` (single gradient cycles, seamless)

**Files:**
- Modify: `app/lib/color/gradientTween.ts`
- Test: `tests/unit/color/gradientTween.unit.spec.ts`

**Interfaces:**
- Consumes: `sortStops` (internal), `blendHex`, `hexToRgb`.
- Produces: `scrollLUT(stops, phase, space?, size?): Uint8ClampedArray` — stops spaced EVENLY on a wheel by order, wrap last→first; sampled at `(u + phase)` wrapped into [0,1). Seamless: `scrollLUT(s, 0)` deep-equals `scrollLUT(s, 1)`. At `phase = k/n` the wheel has advanced `k` stops.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { scrollLUT } from '~/lib/color/gradientTween'

const WHEEL: GradientStop[] = [
  { pos: 0, color: '#1436ff' },   // blue
  { pos: 0.5, color: '#ff2d2d' },  // red
  { pos: 1, color: '#ffd21f' },    // yellow
]

describe('scrollLUT', () => {
  it('loops seamlessly (phase 0 == phase 1)', () => {
    expect(Array.from(scrollLUT(WHEEL, 0))).toEqual(Array.from(scrollLUT(WHEEL, 1)))
  })
  it('advances the wheel by one stop at phase = 1/n', () => {
    // at phase 0 the LUT starts on blue; at phase 1/3 (n=3) it starts on red.
    const base = scrollLUT(WHEEL, 0)
    const oneStep = scrollLUT(WHEEL, 1 / 3)
    const startBase = [base[0], base[1], base[2]]
    const startStep = [oneStep[0], oneStep[1], oneStep[2]]
    // blue ≈ (20,54,255); red ≈ (255,45,45)
    expect(startStep[0]).toBeGreaterThan(startBase[0]) // more red channel
    expect(startStep[2]).toBeLessThan(startBase[2])    // less blue channel
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- gradientTween`
Expected: FAIL — `scrollLUT is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to app/lib/color/gradientTween.ts
export function scrollLUT(
  stops: GradientStop[],
  phase: number,
  space: BlendSpace = 'oklab',
  size = 256,
): Uint8ClampedArray {
  const cols = sortStops(stops).map(s => s.color)
  const n = cols.length || 1
  const lut = new Uint8ClampedArray(size * 3)
  for (let i = 0; i < size; i++) {
    const u = size === 1 ? 0 : i / (size - 1)
    const w = (((u + phase) % 1) + 1) % 1
    const seg = w * n
    const k = Math.floor(seg)
    const lt = seg - k
    const [r, g, b] = hexToRgb(blendHex(cols[k % n], cols[(k + 1) % n], lt, space))
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- gradientTween`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -- app/lib/color/gradientTween.ts tests/unit/color/gradientTween.unit.spec.ts -m "feat(color): scrollLUT — seamless single-gradient cycle (gradient tween core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Smoothness regression guard (why OKLab, not OKLCH)

**Files:**
- Test: `tests/unit/color/gradientTween.unit.spec.ts` (test-only task — no production change)

**Interfaces:**
- Consumes: `crossfadeLUT`, `hexToOklab`, `rgbToHex`, and `mixHex(..,'oklch')` (to synthesize an OKLCH crossfade for contrast only — OKLCH is never a shipped `BlendSpace`).
- Produces: a regression test asserting the OKLab crossfade is spatially and temporally smooth on an adversarial complementary pair, and documenting that an OKLCH crossfade is not (guards against anyone switching the default to OKLCH).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/unit/color/gradientTween.unit.spec.ts
import { rgbToHex } from '~/lib/color/convert'
import { mixHex } from '~/lib/color/mix'

function dE(h1: string, h2: string): number {
  const A = hexToOklab(h1), B = hexToOklab(h2)
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])
}
function lutHex(lut: Uint8ClampedArray, i: number): string {
  return rgbToHex(lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2])
}
// worst jump between ADJACENT positions within a frame (a hue seam), swept over t.
function worstSpatial(from: GradientStop[], to: GradientStop[], make: (t: number) => Uint8ClampedArray): number {
  let worst = 0
  for (let f = 0; f <= 40; f++) {
    const lut = make(f / 40)
    for (let i = 1; i < 256; i++) worst = Math.max(worst, dE(lutHex(lut, i - 1), lutHex(lut, i)))
  }
  return worst
}
// an OKLCH crossfade built directly, for contrast only (not a shipped path).
function oklchCrossfade(from: GradientStop[], to: GradientStop[], t: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const u = i / 255
    const c = mixHex(sampleRamp(from, u), sampleRamp(to, u), t, 'oklch')
    const [r, g, b] = hexToRgb(c)
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}

describe('crossfade smoothness (OKLab beats OKLCH)', () => {
  const EMBER: GradientStop[] = [{ pos: 0, color: '#120000' }, { pos: 0.6, color: '#c9370e' }, { pos: 1, color: '#ffcf7a' }]
  const OCEAN: GradientStop[] = [{ pos: 0, color: '#01121f' }, { pos: 0.28, color: '#043a5b' }, { pos: 0.55, color: '#1f8fa8' }, { pos: 0.8, color: '#7fe0c9' }, { pos: 1, color: '#f6ffe8' }]

  it('oklab has no spatial seam', () => {
    expect(worstSpatial(EMBER, OCEAN, t => crossfadeLUT(EMBER, OCEAN, t, 'oklab'))).toBeLessThan(0.05)
  })
  it('oklch would seam (documents why it is not the default)', () => {
    expect(worstSpatial(EMBER, OCEAN, t => oklchCrossfade(EMBER, OCEAN, t))).toBeGreaterThan(0.1)
  })
})
```

Note: `hexToRgb` and `sampleRamp` are already imported earlier in the file; do not re-import.

- [ ] **Step 2: Run test to verify it fails, then passes as-is**

Run: `npm run test:unit -- gradientTween`
Expected: PASS immediately (this exercises code from Tasks 1–6). This task is a *guard*, not new production code — if either assertion fails, a real regression exists in `blendHex`/`crossfadeLUT`; fix that, don't loosen the threshold.

- [ ] **Step 3: Commit**

```bash
git commit -- tests/unit/color/gradientTween.unit.spec.ts -m "test(color): smoothness regression guard — OKLab crossfade beats OKLCH

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (of the CORE only — compositor wiring is a separate plan):**
- `gradientTween.ts` module with no compositor knowledge — Tasks 1–6. ✓
- `blend` over `oklab`/`hybrid` — Task 1. ✓
- `sampleRamp` / `buildLUT` — Task 2. ✓
- `resampleStops` / `pairStops` (travel pairing) — Task 3. ✓
- `crossfadeLUT` — Task 4. ✓
- `travelStops` — Task 5. ✓
- `scrollLUT` (seamless) — Task 6. ✓
- Endpoint fidelity, scroll seamless+stepped, pairing — Tasks 1–6 tests. ✓
- Smoothness regression (OKLab vs OKLCH, spatial) — Task 7. ✓
- **Deferred to Plan 2 (compositor wiring):** gradient-valued keyframes in `effectTracks.ts`/`effectDials.ts`; the layer-fill target category; fill + gradient-map render paths; scroll phase-dials; timeline UI; temporal-Δ integration test through the render path.

**Placeholder scan:** none — every step has real code and a concrete run command.

**Type consistency:** `BlendSpace`, `GradientStop`, and all function signatures are used identically across tasks. `sampleRamp`/`buildLUT`/`hexToRgb` imports are introduced once and reused; Task 7's note prevents a duplicate import.

## Notes for Plan 2 (compositor wiring — to be written next)

Seams identified while writing this plan, for the follow-up:
- `app/lib/compositor/effectDials.ts` — `DialKind` gains `'gradient'`; add `gradientMap.stops` (+ a `gradientMap.phase` number for scroll). The fill gradient is a LAYER property, not an effect, so it needs a target source outside `EFFECT_DIAL_SCHEMA`.
- `app/lib/motion/effectTracks.ts` (339 lines) — keyframe value extends to a gradient variant; track carries `mode` (crossfade|travel) + `space`.
- Render: fill path in `compositor/FillControl.vue`/`GradientEditor.vue`; effect path in `postEffects.ts` (`gradientMapInPlace`) + `gradient_map.frag` — both accept a resolved LUT from `gradientTween`.
- UI: `compositor/CompositorMotionTimeline.vue` gradient-swatch keyframes; reuse `GradientEditor` as the selected-keyframe value editor (stays on the Motion tab).
- Add the temporal-Δ smoothness test through the compositor render path (the spec's "timeline integration" test).
