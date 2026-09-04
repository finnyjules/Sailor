# Seed → Palette Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sailor one or two seed colors and get back a shelf of genuinely good palettes — every one containing the seed(s) verbatim — from two sources (a curated corpus re-anchored to the seed, and mathematical recipes built through the seed), then apply them as either gradients or discrete fills across the studios.

**Architecture:** A pure engine in `frontend/app/lib/color/` produces a *family* (ordered hexes + seed anchor + facets). Three pure projections turn a family into gradient stops (`gradientize`), discrete swatches (`paletteize`), or a distribution across a studio's fill list (`distribute`). The shared `PalettePicker` gains a seed pane that emits families **literally** (bypassing the lightness-overwriting `toStops`). Studios consume via existing handlers; the Gradient agent recipe flow gets its palette menu built by the engine.

**Tech Stack:** Nuxt 4 (Vue 3 + TypeScript), Vitest, existing `lib/color/convert.ts` OKLCH math. No new runtime dependencies.

## Global Constraints

- **No new runtime dependencies.** All color math reuses `~/lib/color/convert.ts`. Palette generation is hand-rolled on top of it.
- **Determinism (house rule):** every random choice goes through a seeded PRNG (xmur3 hash → mulberry32), never `Math.random` in a render/compute path. Key = (seed hexes, recipe, variant, page).
- **Hard-anchor invariant:** every emitted family contains each seed hex **verbatim**, including after variation is applied.
- **The corpus must never be a static import.** It is fetched lazily from `frontend/public/data/palette-corpus.json` and cached in module state. A static import blows the Gradient embed's ~140 KB ceiling.
- **The `toStops` tax:** seed-engine families are emitted literally (own hexes, own lightness, evenly spaced `pos`). They must NOT pass through `toStops`/`toDuotone`, which overwrite lightness. The gallery/harmony panes keep the cooked path.
- **Respect existing agent refusals:** Shader gradient-map ramp and Scene3D gradient-material palette are `agent: false` / picker-only. The engine does not route around these.
- **Dedupe thresholds (validated in prototype):** 0.045 mean OKLab for corpus candidates, 0.02 for composed.
- **Chroma-ratio clamp (validated):** [0.35, 2.8] when re-anchoring.
- **Datasets are MIT-licensed;** vendor the license files alongside the data.

---

## File Structure

**Created:**
- `frontend/app/lib/rng.ts` — neutral seeded PRNG (xmur3 + mulberry32 + `makeRng`), studio-agnostic home for the house-rule RNG.
- `frontend/app/lib/color/corpus/nice-color-palettes.json` — vendored source (992 palettes).
- `frontend/app/lib/color/corpus/sanzo-combinations.json` — vendored source (Sanzo Wada colors + combination ids).
- `frontend/app/lib/color/corpus/LICENSE-nice-color-palettes`, `.../LICENSE-sanzo` — MIT license texts.
- `frontend/app/lib/color/corpus/build.mjs` — dev-only script; regenerates the combined file from the two sources.
- `frontend/public/data/palette-corpus.json` — the built combined 1,340-palette file (fetched at runtime).
- `frontend/app/lib/color/seedFamily.ts` — types: `PaletteFamily`, facets.
- `frontend/app/lib/color/anchor.ts` — curated source: retrieval + re-anchoring.
- `frontend/app/lib/color/composed.ts` — composed source: recipes.
- `frontend/app/lib/color/seedEngine.ts` — corpus loader + shelf assembly (weave, page, dedupe).
- `frontend/app/lib/color/project.ts` — `gradientize` / `paletteize` / `distribute`.
- Tests: `frontend/tests/unit/seed-family.unit.spec.ts`, `seed-anchor.unit.spec.ts`, `seed-composed.unit.spec.ts`, `seed-engine.unit.spec.ts`, `seed-project.unit.spec.ts`, `palette-picker-literal.unit.spec.ts`.

**Modified:**
- `frontend/app/components/vue-canvas/studio/PalettePicker.vue` — new seed pane + literal emit.
- `frontend/app/components/vue-canvas/GradientStudioSurface.vue` — literal apply + mesh recolor.
- `frontend/app/components/vue-canvas/ShaderStudioSurface.vue` — literal apply on 3 mounts.
- `frontend/app/components/vue-canvas/widgets/WidgetGradientEditor.vue`, `widgets/ShaderFillEditor.vue` — literal apply.
- `frontend/app/components/vue-canvas/compositor/PostEffectsControls.vue` — mount picker on the gradient-map ramp.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — literal apply + `paletteMode='manual'` flip.
- `frontend/app/components/vue-canvas/ShapeStudioSurface.vue` — `distribute` onto `fills` + `fillStrategy` flip.
- `frontend/app/lib/compositor/…` surface — `distribute` across selected layers.
- `frontend/app/lib/gradientfx/recipes.ts` — seed-menu field; palette menu from engine.
- `frontend/server/api/vibe-recipes.post.ts` — build the palette menu via the engine.

---

## Phase 1 — The pure engine (Tasks 1–6)

### Task 1: Neutral seeded RNG

**Files:**
- Create: `frontend/app/lib/rng.ts`
- Test: `frontend/tests/unit/rng.unit.spec.ts`

**Interfaces:**
- Produces: `xmur3(str: string): number`, `mulberry32(a: number): () => number`, `makeRng(seed: string, salt?: string): Rng` where `Rng = { next(): number; range(lo,hi): number; int(lo,hi): number; pick<T>(arr): T; chance(p): boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/rng.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { makeRng } from '~/lib/rng'

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng('seed-x'); const b = makeRng('seed-x')
    const seqA = [a.next(), a.next(), a.next()]
    const seqB = [b.next(), b.next(), b.next()]
    expect(seqA).toEqual(seqB)
  })
  it('differs across seeds', () => {
    expect(makeRng('a').next()).not.toEqual(makeRng('b').next())
  })
  it('range and int stay in bounds', () => {
    const r = makeRng('k')
    for (let i = 0; i < 100; i++) {
      const f = r.range(2, 5); expect(f).toBeGreaterThanOrEqual(2); expect(f).toBeLessThan(5)
      const n = r.int(1, 3); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(3)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/rng.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/rng`.

- [ ] **Step 3: Write the implementation** (ported verbatim from `app/lib/shapefx/rng.ts`)

```ts
// frontend/app/lib/rng.ts
// Deterministic seeded RNG (house rule): a seed string fully determines a roll.
// Studio-agnostic — the canonical home; per-studio rng modules may re-export this.

export function xmur3(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  next(): number
  range(lo: number, hi: number): number
  int(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
}

export function makeRng(seed: string, salt = ''): Rng {
  const fn = mulberry32(xmur3(seed + '|' + salt))
  return {
    next: fn,
    range: (lo, hi) => lo + (hi - lo) * fn(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * fn()),
    pick: arr => arr[Math.floor(fn() * arr.length) % arr.length]!,
    chance: p => fn() < p,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/rng.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/rng.ts frontend/tests/unit/rng.unit.spec.ts
git commit -m "feat(color): neutral seeded RNG for the palette engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Vendor the corpus + build script

**Files:**
- Create: `frontend/app/lib/color/corpus/{nice-color-palettes.json,sanzo-combinations.json,LICENSE-nice-color-palettes,LICENSE-sanzo,build.mjs}`
- Create (build output): `frontend/public/data/palette-corpus.json`
- Test: `frontend/tests/unit/palette-corpus.unit.spec.ts`

**Interfaces:**
- Produces: `frontend/public/data/palette-corpus.json` — a JSON array of `{ s: 0 | 1; c: string[] }` where `s` is the source tag (0 = ColourLovers, 1 = Sanzo Wada) and `c` is 2–5 lowercase `#rrggbb` hexes.

- [ ] **Step 1: Fetch the two source datasets into the corpus dir**

```bash
mkdir -p frontend/app/lib/color/corpus frontend/public/data
curl -sL -o frontend/app/lib/color/corpus/nice-color-palettes.json \
  https://raw.githubusercontent.com/Experience-Monks/nice-color-palettes/master/1000.json
curl -sL -o frontend/app/lib/color/corpus/sanzo-combinations.json \
  https://raw.githubusercontent.com/mattdesl/dictionary-of-colour-combinations/master/colors.json
```

Then save the two MIT license texts:
- `LICENSE-nice-color-palettes` — copy from https://github.com/Experience-Monks/nice-color-palettes/blob/master/LICENSE.md
- `LICENSE-sanzo` — copy from https://github.com/mattdesl/dictionary-of-colour-combinations (MIT).

- [ ] **Step 2: Write the build script**

```js
// frontend/app/lib/color/corpus/build.mjs
// Dev-only. Regenerates ../../../../public/data/palette-corpus.json from the two
// vendored sources. Run: node frontend/app/lib/color/corpus/build.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nice = JSON.parse(fs.readFileSync(path.join(here, 'nice-color-palettes.json'), 'utf8'))
const sanzo = JSON.parse(fs.readFileSync(path.join(here, 'sanzo-combinations.json'), 'utf8'))

const combos = new Map()
for (const c of sanzo) for (const id of c.combinations) {
  if (!combos.has(id)) combos.set(id, [])
  combos.get(id).push(c.hex.toLowerCase())
}
const sw = [...combos.values()].filter(cols => cols.length >= 2).map(c => ({ s: 1, c }))
const cl = nice.map(p => ({ s: 0, c: p.map(h => h.toLowerCase()) }))
const all = [...cl, ...sw]

const out = path.join(here, '..', '..', '..', '..', 'public', 'data', 'palette-corpus.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(all))
console.log(`wrote ${all.length} palettes (${cl.length} ColourLovers + ${sw.length} Sanzo) to ${out}`)
```

- [ ] **Step 3: Run the build**

Run: `node frontend/app/lib/color/corpus/build.mjs`
Expected: `wrote 1340 palettes (992 ColourLovers + 348 Sanzo) to …/public/data/palette-corpus.json`

- [ ] **Step 4: Write the shape test**

```ts
// frontend/tests/unit/palette-corpus.unit.spec.ts
import { describe, it, expect } from 'vitest'
import corpus from '../../public/data/palette-corpus.json'

describe('palette corpus', () => {
  it('has ~1340 entries tagged by source', () => {
    expect(corpus.length).toBeGreaterThan(1200)
    expect(corpus.every(p => p.s === 0 || p.s === 1)).toBe(true)
  })
  it('every palette is 2–5 valid hexes', () => {
    for (const p of corpus) {
      expect(p.c.length).toBeGreaterThanOrEqual(2)
      expect(p.c.length).toBeLessThanOrEqual(5)
      expect(p.c.every(h => /^#[0-9a-f]{6}$/.test(h))).toBe(true)
    }
  })
})
```

- [ ] **Step 5: Run the test, then commit**

Run: `cd frontend && npx vitest run tests/unit/palette-corpus.unit.spec.ts`
Expected: PASS.

```bash
git add frontend/app/lib/color/corpus frontend/public/data/palette-corpus.json frontend/tests/unit/palette-corpus.unit.spec.ts
git commit -m "feat(color): vendor palette corpus (nice-color-palettes + Sanzo Wada) + build script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Family type + facets

**Files:**
- Create: `frontend/app/lib/color/seedFamily.ts`
- Test: `frontend/tests/unit/seed-family.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface PaletteFamily { hexes: string[]; anchorIdxs: number[]; source: 'curated' | 'composed'; sourceTag?: 0 | 1; recipe?: string; warp: number }`
  - `interface Facets { avgL: number; avgC: number; maxC: number; hue: number; hueWeight: number }`
  - `facetsOf(hexes: string[]): Facets`
  - `type Character = 'any' | 'muted' | 'vivid' | 'dark' | 'light' | 'warm' | 'cool'`
  - `matchesCharacter(f: Facets, ch: Character): boolean`
  - `meanPairwiseLab(a: string[], b: string[]): number` (for dedupe)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/seed-family.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { facetsOf, matchesCharacter } from '~/lib/color/seedFamily'

describe('facets', () => {
  it('classifies a dark palette as dark, not light', () => {
    const f = facetsOf(['#101014', '#20242e', '#2e3440'])
    expect(matchesCharacter(f, 'dark')).toBe(true)
    expect(matchesCharacter(f, 'light')).toBe(false)
  })
  it('classifies a saturated palette as vivid', () => {
    const f = facetsOf(['#ff0033', '#00ccff', '#ffcc00'])
    expect(matchesCharacter(f, 'vivid')).toBe(true)
  })
  it('any matches everything', () => {
    expect(matchesCharacter(facetsOf(['#808080', '#404040']), 'any')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd frontend && npx vitest run tests/unit/seed-family.unit.spec.ts` — FAIL (module missing).

- [ ] **Step 3: Write the implementation** (ported from the validated prototype `facets` + `CHAR_TESTS`)

```ts
// frontend/app/lib/color/seedFamily.ts
import { hexToOklch, rgbToOklab, hexToRgb } from './convert'

export interface PaletteFamily {
  hexes: string[]
  anchorIdxs: number[]
  source: 'curated' | 'composed'
  sourceTag?: 0 | 1
  recipe?: string
  warp: number
}

export interface Facets { avgL: number; avgC: number; maxC: number; hue: number; hueWeight: number }
export type Character = 'any' | 'muted' | 'vivid' | 'dark' | 'light' | 'warm' | 'cool'

const hexLab = (hex: string): [number, number, number] => rgbToOklab(...hexToRgb(hex))
export function labDist(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
}

export function facetsOf(hexes: string[]): Facets {
  const lch = hexes.map(hexToOklch)
  const avgL = lch.reduce((a, x) => a + x[0], 0) / lch.length
  const avgC = lch.reduce((a, x) => a + x[1], 0) / lch.length
  const maxC = Math.max(...lch.map(x => x[1]))
  let X = 0, Y = 0
  for (const [, C, H] of lch) { X += C * Math.cos(H * Math.PI / 180); Y += C * Math.sin(H * Math.PI / 180) }
  let hue = Math.atan2(Y, X) * 180 / Math.PI; if (hue < 0) hue += 360
  return { avgL, avgC, maxC, hue, hueWeight: Math.hypot(X, Y) }
}

const TESTS: Record<Character, (f: Facets) => boolean> = {
  any: () => true,
  muted: f => f.avgC < 0.09,
  vivid: f => f.maxC > 0.16,
  dark: f => f.avgL < 0.48,
  light: f => f.avgL > 0.68,
  warm: f => f.hueWeight > 0.03 && (f.hue < 130 || f.hue > 340),
  cool: f => f.hueWeight > 0.03 && f.hue > 160 && f.hue < 330,
}
export function matchesCharacter(f: Facets, ch: Character): boolean { return TESTS[ch](f) }

/** Mean pairwise OKLab distance between two palettes, for dedupe. */
export function meanPairwiseLab(a: string[], b: string[]): number {
  const la = a.map(hexLab), lb = b.map(hexLab)
  let t = 0, n = 0
  for (let i = 0; i < Math.min(la.length, lb.length); i++) { t += labDist(la[i]!, lb[i]!); n++ }
  return n ? t / n : Infinity
}
```

- [ ] **Step 4: Run to verify it passes.** Run the same command — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/color/seedFamily.ts frontend/tests/unit/seed-family.unit.spec.ts
git commit -m "feat(color): PaletteFamily type + facet classification

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Curated source — retrieval + re-anchoring

**Files:**
- Create: `frontend/app/lib/color/anchor.ts`
- Test: `frontend/tests/unit/seed-anchor.unit.spec.ts`

**Interfaces:**
- Consumes: `PaletteFamily`, `labDist` (Task 3); `hexToOklch`, `oklchToHexInGamut` (`convert.ts`); `makeRng` (Task 1).
- Produces:
  - `type CorpusEntry = { s: 0 | 1; c: string[] }`
  - `anchorOne(entry: CorpusEntry, seedHex: string): { hexes: string[]; anchorIdx: number; warp: number }`
  - `anchorTwo(entry: CorpusEntry, seedA: string, seedB: string): { hexes: string[]; anchorIdxs: number[]; warp: number }`
  - `applyVariation(hexes: string[], anchorIdxs: number[], amount: number, key: string): string[]`

- [ ] **Step 1: Write the failing test** (the hard-anchor invariant is the point)

```ts
// frontend/tests/unit/seed-anchor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { anchorOne, anchorTwo, applyVariation } from '~/lib/color/anchor'

const entry = { s: 0 as const, c: ['#69d2e7', '#a7dbd8', '#e0e4cc', '#f38630', '#fa6900'] }

describe('re-anchoring', () => {
  it('puts the seed hex verbatim into the result', () => {
    const r = anchorOne(entry, '#b64a1f')
    expect(r.hexes[r.anchorIdx]).toBe('#b64a1f')
  })
  it('keeps the palette length', () => {
    expect(anchorOne(entry, '#b64a1f').hexes).toHaveLength(5)
  })
  it('every output is a valid hex', () => {
    for (const h of anchorOne(entry, '#123456').hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('two-seed anchoring lands both seeds verbatim', () => {
    const r = anchorTwo(entry, '#b64a1f', '#2545d3')
    expect(r.hexes[r.anchorIdxs[0]!]).toBe('#b64a1f')
    expect(r.hexes[r.anchorIdxs[1]!]).toBe('#2545d3')
  })
  it('variation leaves anchors untouched (hard-anchor invariant)', () => {
    const r = anchorOne(entry, '#b64a1f')
    const v = applyVariation(r.hexes, [r.anchorIdx], 0.8, 'key')
    expect(v[r.anchorIdx]).toBe('#b64a1f')
  })
  it('variation is deterministic for a key', () => {
    const r = anchorOne(entry, '#b64a1f')
    const a = applyVariation(r.hexes, [r.anchorIdx], 0.5, 'k')
    const b = applyVariation(r.hexes, [r.anchorIdx], 0.5, 'k')
    expect(a).toEqual(b)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/seed-anchor.unit.spec.ts` — FAIL.

- [ ] **Step 3: Write the implementation** (ported from the validated prototype `anchorPalette` / two-seed block / `applyVariation`)

```ts
// frontend/app/lib/color/anchor.ts
import { hexToOklch, oklchToHexInGamut, rgbToOklab, hexToRgb } from './convert'
import { makeRng } from '~/lib/rng'
import { labDist } from './seedFamily'

export type CorpusEntry = { s: 0 | 1; c: string[] }
const hexLab = (h: string): [number, number, number] => rgbToOklab(...hexToRgb(h))

function shortestHueDelta(to: number, from: number): number {
  let d = (to - from) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d
}

export function anchorOne(entry: CorpusEntry, seedHex: string) {
  const seedLch = hexToOklch(seedHex), seedLab = hexLab(seedHex)
  const lch = entry.c.map(hexToOklch)
  const labs = entry.c.map(hexLab)
  let ni = 0, nd = Infinity
  for (let i = 0; i < labs.length; i++) { const d = labDist(labs[i]!, seedLab); if (d < nd) { nd = d; ni = i } }
  const m = lch[ni]!
  const neutral = m[1] < 0.02 || seedLch[1] < 0.02
  const dH = neutral ? 0 : shortestHueDelta(seedLch[2], m[2])
  const dL = seedLch[0] - m[0]
  const r = Math.max(0.35, Math.min(2.8, seedLch[1] / Math.max(m[1], 1e-4)))
  const hexes = lch.map(([L, C, H], i) => {
    if (i === ni) return seedHex
    let h = (H + dH) % 360; if (h < 0) h += 360
    return oklchToHexInGamut(Math.max(0.03, Math.min(0.97, L + dL)), C * r, h)
  })
  return { hexes, anchorIdx: ni, warp: nd }
}

export function anchorTwo(entry: CorpusEntry, seedA: string, seedB: string) {
  const a = anchorOne(entry, seedA)
  const bLab = hexLab(seedB)
  let ni = -1, nd = Infinity
  a.hexes.forEach((h, i) => {
    if (i === a.anchorIdx) return
    const d = labDist(hexLab(h), bLab); if (d < nd) { nd = d; ni = i }
  })
  const hexes = a.hexes.map((h, i) => (i === ni ? seedB : h))
  return { hexes, anchorIdxs: [a.anchorIdx, ni], warp: a.warp + nd }
}

export function applyVariation(hexes: string[], anchorIdxs: number[], amount: number, key: string): string[] {
  if (amount <= 0) return hexes
  const rng = makeRng(key)
  return hexes.map((hex, i) => {
    if (anchorIdxs.includes(i)) return hex
    const [L, C, H] = hexToOklch(hex)
    const h = (H + (rng.next() - 0.5) * amount * 50 + 360) % 360
    const l = Math.max(0.03, Math.min(0.97, L + (rng.next() - 0.5) * amount * 0.14))
    const c = Math.max(0, C * (1 + (rng.next() - 0.5) * amount * 0.6))
    return oklchToHexInGamut(l, c, h)
  })
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/color/anchor.ts frontend/tests/unit/seed-anchor.unit.spec.ts
git commit -m "feat(color): corpus re-anchoring (hard-anchored to seed, gamut-safe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Composed source — mathematical recipes

**Files:**
- Create: `frontend/app/lib/color/composed.ts`
- Test: `frontend/tests/unit/seed-composed.unit.spec.ts`

**Interfaces:**
- Consumes: `hexToOklch`, `oklchToHexInGamut` (`convert.ts`); `makeRng` (Task 1); `applyVariation` (Task 4); `facetsOf`, `matchesCharacter`, `PaletteFamily`, `Character` (Tasks 3).
- Produces: `composedFamilies(seedA: string, seedB: string | null, char: Character, page: number, want: number): PaletteFamily[]`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/seed-composed.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { composedFamilies } from '~/lib/color/composed'

describe('composed recipes', () => {
  it('every family contains the seed verbatim', () => {
    for (const f of composedFamilies('#e63946', null, 'any', 0, 12))
      expect(f.hexes.some(h => h === '#e63946')).toBe(true)
  })
  it('two-seed families contain both seeds', () => {
    for (const f of composedFamilies('#f2c4b3', '#5b6e8c', 'any', 0, 8)) {
      expect(f.hexes).toContain('#f2c4b3')
      expect(f.hexes).toContain('#5b6e8c')
    }
  })
  it('is deterministic for the same inputs', () => {
    const a = composedFamilies('#e63946', null, 'any', 0, 12)
    const b = composedFamilies('#e63946', null, 'any', 0, 12)
    expect(a.map(f => f.hexes)).toEqual(b.map(f => f.hexes))
  })
  it('all outputs are valid hexes', () => {
    for (const f of composedFamilies('#123456', null, 'any', 0, 12))
      for (const h of f.hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/seed-composed.unit.spec.ts` — FAIL.

- [ ] **Step 3: Write the implementation** (ported from the validated prototype `ONE_SEED_RECIPES`, `composedTwoSeed`, `composedCandidates`)

```ts
// frontend/app/lib/color/composed.ts
import { hexToOklch, oklchToHexInGamut } from './convert'
import { makeRng, type Rng } from '~/lib/rng'
import { facetsOf, matchesCharacter, type PaletteFamily, type Character } from './seedFamily'

const NGEN = 5
const clampL = (L: number) => Math.max(0.05, Math.min(0.96, L))
function shortestHueDelta(to: number, from: number): number {
  let d = (to - from) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d
}

function lSkeleton(Ls: number, rng: Rng) {
  const Lmin = 0.14 + rng.next() * 0.14, Lmax = 0.84 + rng.next() * 0.12
  const L: number[] = []
  for (let i = 0; i < NGEN; i++) { const t = i / (NGEN - 1); L.push(Lmin + (Lmax - Lmin) * (t * t * (3 - 2 * t) * 0.6 + t * 0.4)) }
  let i0 = 0, best = Infinity
  L.forEach((v, i) => { const d = Math.abs(v - Ls); if (d < best) { best = d; i0 = i } })
  const shift = Ls - L[i0]!
  return { L: L.map((v, i) => clampL(v + shift * (1 - Math.abs(i - i0) / NGEN))), i0 }
}

type Stops = [number, number, number][]
function rampFrom(seedLch: [number, number, number], rng: Rng, spread: number, cEnds: number): { stops: Stops; i0: number } {
  let [Ls, Cs, Hs] = seedLch
  if (Cs < 0.02) { Hs = rng.next() * 360; Cs = 0.03 + rng.next() * 0.05 }
  const { L, i0 } = lSkeleton(Ls, rng)
  const dir = rng.next() < 0.5 ? -1 : 1
  const stops: Stops = L.map((l, i) => {
    const u = (i - i0) / (NGEN - 1)
    const h = (Hs + dir * spread * u + 720) % 360
    const fall = 1 - (1 - cEnds) * Math.abs(u) * 1.6
    return [l, Math.max(0.01, Cs * Math.max(0.2, fall)), h]
  })
  return { stops, i0 }
}

interface Recipe { name: string; build(a: [number, number, number], rng: Rng): { stops: Stops; i0: number } }
const ONE_SEED_RECIPES: Recipe[] = [
  { name: 'tonal', build: (a, r) => rampFrom(a, r, 8 + r.next() * 14, 0.55) },
  { name: 'analogous', build: (a, r) => rampFrom(a, r, 40 + r.next() * 35, 0.7) },
  { name: 'hue-cycle', build: (a, r) => rampFrom(a, r, 120 + r.next() * 170, 0.85) },
  { name: 'complement', build: (a, r) => {
      const out = rampFrom(a, r, 24 + r.next() * 20, 0.6)
      const far = out.i0 < NGEN / 2 ? NGEN - 1 : 0
      const [l, c, h] = out.stops[far]!
      out.stops[far] = [l, Math.max(c, Math.min(0.22, a[1] * 1.15)), (h + 180) % 360]
      return out } },
  { name: 'split-tone', build: (a, r) => {
      const out = rampFrom(a, r, 14 + r.next() * 10, 0.7)
      const flip = 150 + r.next() * 60
      out.stops = out.stops.map(([l, c, h], i) => (i === out.i0 || l >= 0.5 ? [l, c, h] : [l, c * 0.65, (h + flip) % 360]))
      return out } },
  { name: 'neutral+pop', build: (a, r) => {
      const out = rampFrom(a, r, 10 + r.next() * 12, 0.5)
      const pop = out.i0 === 0 ? NGEN - 1 : out.i0 - 1
      out.stops = out.stops.map(([l, c, h], i) => (i === out.i0 ? [l, c, h]
        : i === pop ? [l, Math.min(0.2, a[1] * 1.1 + 0.04), (h + (r.next() < 0.5 ? 120 : -120)) % 360]
        : [l, c * 0.28, h]))
      return out } },
]
const TWO_SEED_RECIPES = [{ name: 'bridge', longWay: false }, { name: 'arc', longWay: true }]

function composedTwoSeed(aHex: string, bHex: string, longWay: boolean, rng: Rng): { stops: Stops; anchors: [number, string][] } {
  let A = hexToOklch(aHex), B = hexToOklch(bHex), hexA = aHex, hexB = bHex
  if (A[0] > B[0]) { [A, B] = [B, A];[hexA, hexB] = [hexB, hexA] }
  const i0 = 1, i1 = 3
  let dH = shortestHueDelta(B[2], A[2])
  if (longWay) dH = dH > 0 ? dH - 360 : dH + 360
  const stops: Stops = []
  for (let i = 0; i < NGEN; i++) {
    const t = (i - i0) / (i1 - i0)
    const l = clampL(A[0] + (B[0] - A[0]) * t)
    const c = Math.max(0.01, (A[1] + (B[1] - A[1]) * t) * (1 - 0.25 * Math.abs(t - 0.5)) * (0.85 + rng.next() * 0.3))
    const h = (A[2] + dH * t + 1080) % 360
    stops.push([l, c, h])
  }
  return { stops, anchors: [[i0, hexA], [i1, hexB]] }
}

export function composedFamilies(seedA: string, seedB: string | null, char: Character, page: number, want: number): PaletteFamily[] {
  const a = hexToOklch(seedA)
  const recipes = seedB ? TWO_SEED_RECIPES : ONE_SEED_RECIPES
  const variants = Math.ceil(want / recipes.length)
  const out: PaletteFamily[] = []
  for (let v = 0; v < variants; v++) {
    for (const rec of recipes) {
      const rng = makeRng('gen:' + seedA + (seedB || '') + rec.name + ':' + v + ':' + page)
      let stops: Stops, anchors: [number, string][]
      if (seedB) { const r = composedTwoSeed(seedA, seedB, (rec as { longWay: boolean }).longWay, rng); stops = r.stops; anchors = r.anchors }
      else { const r = (rec as Recipe).build(a, rng); stops = r.stops; anchors = [[r.i0, seedA]] }
      const hexes = stops.map(([L, C, H]) => oklchToHexInGamut(L, C, H))
      for (const [i, hx] of anchors) hexes[i] = hx
      const anchorIdxs = anchors.map(x => x[0])
      // NOTE: variation is applied once, at the engine layer (Task 6 assembleShelf),
      // so composed families are emitted un-varied here. Do not import applyVariation.
      const f = facetsOf(hexes)
      if (!matchesCharacter(f, char)) continue
      out.push({ hexes, anchorIdxs, source: 'composed', recipe: rec.name, warp: 0.01 * v })
    }
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/color/composed.ts frontend/tests/unit/seed-composed.unit.spec.ts
git commit -m "feat(color): composed palette recipes (ramps through the seed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Shelf assembly + lazy corpus loader

**Files:**
- Create: `frontend/app/lib/color/seedEngine.ts`
- Test: `frontend/tests/unit/seed-engine.unit.spec.ts`

**Interfaces:**
- Consumes: `anchorOne`, `anchorTwo`, `applyVariation`, `CorpusEntry` (Task 4); `composedFamilies` (Task 5); `PaletteFamily`, `Character`, `meanPairwiseLab`, `matchesCharacter`, `facetsOf` (Task 3).
- Produces:
  - `interface SeedRequest { seedA: string; seedB?: string | null; char?: Character; page?: number; variation?: number; source?: 'both' | 'curated' | 'composed' }`
  - `loadCorpus(): Promise<CorpusEntry[]>` — fetches `/data/palette-corpus.json`, caches in module state.
  - `curatedFamilies(corpus, req): PaletteFamily[]` — pure, testable without fetch.
  - `assembleShelf(corpus, req, size?): PaletteFamily[]` — pure; weaves curated + composed with per-source dedupe.
  - `seedShelf(req, size?): Promise<PaletteFamily[]>` — loads corpus then calls `assembleShelf`.

- [ ] **Step 1: Write the failing test** (drive with an injected tiny corpus so no fetch is needed)

```ts
// frontend/tests/unit/seed-engine.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { assembleShelf, curatedFamilies } from '~/lib/color/seedEngine'
import type { CorpusEntry } from '~/lib/color/anchor'

const CORPUS: CorpusEntry[] = [
  { s: 0, c: ['#69d2e7', '#a7dbd8', '#e0e4cc', '#f38630', '#fa6900'] },
  { s: 1, c: ['#06283d', '#256d85', '#47b5ff', '#dff6ff'] },
  { s: 0, c: ['#556270', '#4ecdc4', '#c7f464', '#ff6b6b', '#c44d58'] },
]

describe('shelf assembly', () => {
  it('every curated family contains the seed', () => {
    for (const f of curatedFamilies(CORPUS, { seedA: '#b64a1f' }))
      expect(f.hexes[f.anchorIdxs[0]!]).toBe('#b64a1f')
  })
  it('assembles a shelf of the requested size mixing both sources', () => {
    const shelf = assembleShelf(CORPUS, { seedA: '#b64a1f' }, 12)
    expect(shelf.length).toBe(12)
    expect(shelf.some(f => f.source === 'curated')).toBe(true)
    expect(shelf.some(f => f.source === 'composed')).toBe(true)
  })
  it('is deterministic', () => {
    const a = assembleShelf(CORPUS, { seedA: '#b64a1f' }, 12)
    const b = assembleShelf(CORPUS, { seedA: '#b64a1f' }, 12)
    expect(a.map(f => f.hexes)).toEqual(b.map(f => f.hexes))
  })
  it('reroll (page 1) differs from page 0', () => {
    const p0 = assembleShelf(CORPUS, { seedA: '#b64a1f', page: 0 }, 6)
    const p1 = assembleShelf(CORPUS, { seedA: '#b64a1f', page: 1 }, 6)
    expect(p0.map(f => f.hexes)).not.toEqual(p1.map(f => f.hexes))
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/seed-engine.unit.spec.ts` — FAIL.

- [ ] **Step 3: Write the implementation** (ported from the validated prototype `compute` + weave + the two dedupe thresholds)

```ts
// frontend/app/lib/color/seedEngine.ts
import { anchorOne, anchorTwo, applyVariation, type CorpusEntry } from './anchor'
import { composedFamilies } from './composed'
import { facetsOf, matchesCharacter, meanPairwiseLab, type PaletteFamily, type Character } from './seedFamily'

export interface SeedRequest {
  seedA: string
  seedB?: string | null
  char?: Character
  page?: number
  variation?: number
  source?: 'both' | 'curated' | 'composed'
}

const CURATED_DEDUPE = 0.045
const COMPOSED_DEDUPE = 0.02

export function curatedFamilies(corpus: CorpusEntry[], req: SeedRequest): PaletteFamily[] {
  const { seedA, seedB = null, char = 'any', variation = 0, page = 0 } = req
  const out: PaletteFamily[] = []
  for (const entry of corpus) {
    if (seedB && entry.c.length < 2) continue
    const a = seedB ? anchorTwo(entry, seedA, seedB) : anchorOne(entry, seedA)
    const anchorIdxs = 'anchorIdxs' in a ? a.anchorIdxs : [a.anchorIdx]
    let hexes = applyVariation(a.hexes, anchorIdxs, variation, seedA + (seedB || '') + ':' + entry.c.join('') + ':' + page)
    const f = facetsOf(hexes)
    if (!matchesCharacter(f, char)) continue
    out.push({ hexes, anchorIdxs, source: 'curated', sourceTag: entry.s, warp: a.warp })
  }
  out.sort((x, y) => x.warp - y.warp)
  return out
}

export function assembleShelf(corpus: CorpusEntry[], req: SeedRequest, size = 12): PaletteFamily[] {
  const source = req.source ?? 'both'
  const page = req.page ?? 0
  const curQuota = source === 'composed' ? 0 : source === 'curated' ? size : Math.ceil(size / 2) + 1
  const genQuota = size - curQuota

  const pickedSigs: string[][] = []
  const isDupe = (sig: string[], thresh: number) => pickedSigs.some(p => meanPairwiseLab(sig, p) < thresh)

  // curated, warp-ranked, page-skipped, deduped
  const curated: PaletteFamily[] = []
  const ranked = curQuota > 0 ? curatedFamilies(corpus, req) : []
  const skip = page * curQuota
  let skipped = 0
  for (const fam of ranked) {
    if (isDupe(fam.hexes, CURATED_DEDUPE)) continue
    if (skipped < skip) { skipped++; pickedSigs.push(fam.hexes); continue }
    pickedSigs.push(fam.hexes); curated.push(fam)
    if (curated.length >= curQuota) break
  }

  // composed, tighter dedupe
  const composed: PaletteFamily[] = []
  if (genQuota > 0) {
    for (const fam of composedFamilies(req.seedA, req.seedB ?? null, req.char ?? 'any', page, genQuota * 3)) {
      const v = applyVariation(fam.hexes, fam.anchorIdxs, req.variation ?? 0, 'genv:' + fam.recipe + page)
      const fam2 = { ...fam, hexes: v }
      if (composed.some(c => meanPairwiseLab(fam2.hexes, c.hexes) < COMPOSED_DEDUPE)) continue
      composed.push(fam2)
      if (composed.length >= genQuota) break
    }
  }

  // weave alternately
  const shelf: PaletteFamily[] = []
  const cur = [...curated], gen = [...composed]
  for (let i = 0; i < size; i++) {
    const next = i % 2 === 0 ? (cur.shift() ?? gen.shift()) : (gen.shift() ?? cur.shift())
    if (next) shelf.push(next)
  }
  return shelf
}

let corpusCache: CorpusEntry[] | null = null
export async function loadCorpus(): Promise<CorpusEntry[]> {
  if (corpusCache) return corpusCache
  const res = await fetch('/data/palette-corpus.json')
  corpusCache = (await res.json()) as CorpusEntry[]
  return corpusCache
}

export async function seedShelf(req: SeedRequest, size = 12): Promise<PaletteFamily[]> {
  return assembleShelf(await loadCorpus(), req, size)
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/color/seedEngine.ts frontend/tests/unit/seed-engine.unit.spec.ts
git commit -m "feat(color): seed shelf assembly (weave + per-source dedupe) + lazy corpus loader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: The three projections

**Files:**
- Create: `frontend/app/lib/color/project.ts`
- Test: `frontend/tests/unit/seed-project.unit.spec.ts`

**Interfaces:**
- Consumes: `hexToOklch` (`convert.ts`); `GradientStop` (`harmony.ts`).
- Produces:
  - `gradientize(hexes: string[]): GradientStop[]` — sort by lightness ascending, evenly spaced `pos`, **preserve each color's own lightness** (unlike `toStops`).
  - `paletteize(hexes: string[]): string[]` — identity (the discrete swatches).
  - `type DistributePolicy = 'cycle' | 'ramp'`
  - `distribute(hexes: string[], slotCount: number, policy?: DistributePolicy): string[]` — map N colors onto M slots.

- [ ] **Step 1: Write the failing test** (the literal-lightness assertion is the anti-`toStops` guard)

```ts
// frontend/tests/unit/seed-project.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { gradientize, paletteize, distribute } from '~/lib/color/project'
import { hexToOklch } from '~/lib/color/convert'

describe('gradientize', () => {
  it('preserves the input colors verbatim (does NOT relight like toStops)', () => {
    const hexes = ['#b64a1f', '#e8985e', '#3d2c24', '#f4e3d0']
    const stops = gradientize(hexes)
    // every input color survives exactly, only reordered by lightness
    expect(new Set(stops.map(s => s.color))).toEqual(new Set(hexes))
  })
  it('orders stops by ascending lightness with even positions', () => {
    const stops = gradientize(['#f4e3d0', '#3d2c24', '#b64a1f'])
    const Ls = stops.map(s => hexToOklch(s.color)[0])
    for (let i = 1; i < Ls.length; i++) expect(Ls[i]!).toBeGreaterThanOrEqual(Ls[i - 1]!)
    expect(stops.map(s => s.pos)).toEqual([0, 0.5, 1])
  })
})
describe('paletteize', () => {
  it('is identity', () => {
    expect(paletteize(['#a', '#b'] as string[])).toEqual(['#a', '#b'])
  })
})
describe('distribute', () => {
  it('cycles when slots exceed colors', () => {
    expect(distribute(['#1', '#2'], 5, 'cycle')).toEqual(['#1', '#2', '#1', '#2', '#1'])
  })
  it('truncates evenly when colors exceed slots', () => {
    expect(distribute(['#1', '#2', '#3', '#4', '#5'], 3)).toEqual(['#1', '#3', '#5'])
  })
  it('1:1 when equal', () => {
    expect(distribute(['#1', '#2', '#3'], 3)).toEqual(['#1', '#2', '#3'])
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/seed-project.unit.spec.ts` — FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/app/lib/color/project.ts
// The three projections of a palette family. gradientize PRESERVES each color's
// own lightness — it is NOT toStops, which overwrites lightness with a fixed ramp.
import { hexToOklch, oklchToHexInGamut } from './convert'
import type { GradientStop } from './harmony'

export function gradientize(hexes: string[]): GradientStop[] {
  const sorted = [...hexes].sort((a, b) => hexToOklch(a)[0] - hexToOklch(b)[0])
  const n = sorted.length
  return sorted.map((color, i) => ({ pos: n === 1 ? 0.5 : i / (n - 1), color }))
}

export function paletteize(hexes: string[]): string[] { return [...hexes] }

export type DistributePolicy = 'cycle' | 'ramp'

export function distribute(hexes: string[], slotCount: number, policy: DistributePolicy = 'cycle'): string[] {
  if (slotCount <= 0 || hexes.length === 0) return []
  if (slotCount === hexes.length) return [...hexes]
  if (slotCount < hexes.length) {
    // resample down, evenly spaced (endpoints included)
    return Array.from({ length: slotCount }, (_, i) => hexes[Math.round(i * (hexes.length - 1) / (slotCount - 1))]!)
  }
  // slotCount > hexes.length
  if (policy === 'cycle') return Array.from({ length: slotCount }, (_, i) => hexes[i % hexes.length]!)
  // ramp: interpolate across the sorted family in OKLCH
  const sorted = [...hexes].map(hexToOklch)
  return Array.from({ length: slotCount }, (_, i) => {
    const f = (i / (slotCount - 1)) * (sorted.length - 1)
    const lo = Math.floor(f), hi = Math.min(sorted.length - 1, lo + 1), fr = f - lo
    const a = sorted[lo]!, b = sorted[hi]!
    const lerp = (x: number, y: number) => x + (y - x) * fr
    let dh = (b[2] - a[2]) % 360; if (dh > 180) dh -= 360; if (dh < -180) dh += 360
    return oklchToHexInGamut(lerp(a[0], b[0]), lerp(a[1], b[1]), (a[2] + dh * fr + 360) % 360)
  })
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/color/project.ts frontend/tests/unit/seed-project.unit.spec.ts
git commit -m "feat(color): gradientize/paletteize/distribute projections (lightness-preserving)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — PalettePicker seed pane + Tier A gradient consumers (Tasks 8–10)

### Task 8: PalettePicker literal-emit + seed pane

**Files:**
- Modify: `frontend/app/components/vue-canvas/studio/PalettePicker.vue`
- Test: `frontend/tests/unit/palette-picker-literal.unit.spec.ts`

**Interfaces:**
- Consumes: `seedShelf` (Task 6), `gradientize` / `paletteize` (Task 7), `PaletteFamily` (Task 3).
- Produces (new emit): `(e: 'apply-literal-stops', v: GradientStop[]): void` and `(e: 'apply-family', v: PaletteFamily): void`. The gallery/harmony panes keep `apply-duotone` / `apply-stops` unchanged.

The critical behavior: when a seed-engine family is applied in `stops` mode, emit `gradientize(family.hexes)` — never `toStops`.

- [ ] **Step 1: Write the failing unit test on the emit helper.** Extract the emit decision into a pure exported helper so it is testable without mounting Vue:

```ts
// frontend/tests/unit/palette-picker-literal.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { familyToStops } from '~/components/vue-canvas/studio/paletteEmit'
import { hexToOklch } from '~/lib/color/convert'

describe('familyToStops (literal emit)', () => {
  it('keeps the exact hexes even when lightness is non-monotonic in input order', () => {
    // deliberately NON-MONOTONIC lightness order — a laundered path would rewrite these
    const hexes = ['#e8985e', '#3d2c24', '#f4e3d0', '#b64a1f']
    const stops = familyToStops(hexes)
    expect(new Set(stops.map(s => s.color))).toEqual(new Set(hexes))
  })
  it('does not force a 0.22..0.92 ramp (a laundered path would)', () => {
    const stops = familyToStops(['#111111', '#151515', '#191919']) // all very dark
    const Ls = stops.map(s => hexToOklch(s.color)[0])
    expect(Math.max(...Ls)).toBeLessThan(0.4) // stays dark; toStops would push toward 0.92
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/palette-picker-literal.unit.spec.ts` — FAIL.

- [ ] **Step 3: Create the pure emit helper**

```ts
// frontend/app/components/vue-canvas/studio/paletteEmit.ts
import { gradientize } from '~/lib/color/project'
import type { GradientStop } from '~/lib/color/harmony'
/** Literal projection for the seed-engine path — NEVER toStops. */
export function familyToStops(hexes: string[]): GradientStop[] { return gradientize(hexes) }
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Wire the seed pane into `PalettePicker.vue`.** Add a third pane button and a shelf. Add to the `<script setup>`:

```ts
import { seedShelf } from '~/lib/color/seedEngine'
import { familyToStops } from './paletteEmit'
import type { PaletteFamily } from '~/lib/color/seedFamily'
import type { Character } from '~/lib/color/seedFamily'

// extend the emits block:
//   (e: 'apply-literal-stops', v: GradientStop[]): void
//   (e: 'apply-family', v: PaletteFamily): void

const seedA = ref(props.seed)
const seedB = ref<string | null>(null)
const char = ref<Character>('any')
const page = ref(0)
const shelf = ref<PaletteFamily[]>([])
async function refreshShelf() {
  shelf.value = await seedShelf({ seedA: seedA.value, seedB: seedB.value, char: char.value, page: page.value }, 12)
}
watch([seedA, seedB, char, page], refreshShelf, { immediate: false })
function applyFamily(fam: PaletteFamily) {
  if (props.mode === 'duotone') {
    // duotone consumers want a 2-color pair — take the family's darkest + lightest, verbatim
    const byL = [...fam.hexes].sort((a, b) => hexToOklch(a)[0] - hexToOklch(b)[0])
    emit('apply-duotone', { shadow: byL[0]!, highlight: byL[byL.length - 1]! })
  } else {
    emit('apply-literal-stops', familyToStops(fam.hexes))
  }
  emit('apply-family', fam)
}
```
Add `import { hexToOklch } from '~/lib/color/harmony'`-adjacent (`~/lib/color/convert`). Add a `pane === 'seed'` block in the template with a `StudioColor v-model="seedA"`, an optional second, character chips over `['any','muted','vivid','dark','light','warm','cool']`, a reroll button (`@click="page++"`), and a grid of shelf tiles each calling `@click="applyFamily(fam)"` with the preview background `swatchGrad(fam.hexes)`. Call `refreshShelf()` on mount when `pane` first becomes `'seed'`.

- [ ] **Step 6: Compile-check + commit**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i palettepicker` (expect no new errors naming PalettePicker/paletteEmit; see the typecheck-baseline note).

```bash
git add frontend/app/components/vue-canvas/studio/PalettePicker.vue frontend/app/components/vue-canvas/studio/paletteEmit.ts frontend/tests/unit/palette-picker-literal.unit.spec.ts
git commit -m "feat(picker): seed-engine pane with literal (non-toStops) emit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Gradient studio — literal apply + mesh recolor

**Files:**
- Modify: `frontend/app/components/vue-canvas/GradientStudioSurface.vue` (picker mount `~:1073`; handler `applyPaletteStops` `~:569`)

**Interfaces:**
- Consumes: `apply-literal-stops` (Task 8). Reuses the existing `recolorMeshPoints` (`lib/gradientfx/recipes.ts`).

- [ ] **Step 1: Add the literal handler next to `applyPaletteStops`**

```ts
// The seed-engine path: stops arrive already in their final colors+lightness.
// Reuse the existing apply, then recolor the mesh points (the mesh layout renders
// from points, not stops — the "Molten Rust came out blue" bug).
function applyLiteralStops(stops: GradientStop[]) {
  applyPaletteStops(stops)               // writes color.stops
  const layer = activeLayer.value
  if (layer?.mesh?.points?.length) {
    layer.mesh.points = recolorMeshPoints(layer.mesh.points, stops, 'seed#meshcol')
  }
}
```
(Import `recolorMeshPoints` from `~/lib/gradientfx/recipes` if not already imported; confirm the exact `activeLayer` accessor name in this file and match it.)

- [ ] **Step 2: Wire the picker mount.** On the `<PalettePicker … mode="stops" @apply-stops="applyPaletteStops" />` at ~:1073, add `@apply-literal-stops="applyLiteralStops"`.

- [ ] **Step 3: Live-verify (house rule).** Start the dev server and confirm applying a seed palette shows those exact colors in both a linear gradient and a mesh gradient. Use `preview_start` with the Sailor dev server, open the Gradient studio, apply a seed palette, screenshot.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/vue-canvas/GradientStudioSurface.vue
git commit -m "feat(gradient): apply seed palettes literally + recolor mesh points

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Shader studio (3 mounts) + widgets + Compositor post-FX gradient map

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShaderStudioSurface.vue` (mounts ~:1074 duotone, ~:1083 gradient map, ~:975 per-effect gradient)
- Modify: `frontend/app/components/vue-canvas/widgets/WidgetGradientEditor.vue` (~:110), `widgets/ShaderFillEditor.vue` (~:286)
- Modify: `frontend/app/components/vue-canvas/compositor/PostEffectsControls.vue` (~:151 gradient-map ramp — add a picker mount if none)

**Interfaces:**
- Consumes: `apply-literal-stops` (Task 8). Existing handlers `applyDuotonePalette`, `applyGradientStops`, and the per-effect inline arrow.

- [ ] **Step 1: Shader gradient map + per-effect.** On the gradient-map mount, add `@apply-literal-stops="applyGradientStops"` (the existing handler already flips `gradientMap.enabled`). On the per-effect mount (~:975), the handler is an inline arrow; add a named function and bind both `@apply-stops` and `@apply-literal-stops` to it:

```ts
function applyEffectGradient(uniform: string, v: GradientStop[], maxStops = 8) {
  setParam(uniform, v.slice(0, maxStops).map(s => ({ pos: s.pos, color: s.color })))
}
```
For the duotone mount (~:1074), the seed path already emits `apply-duotone` from Task 8's `applyFamily`, so no change is needed there.

- [ ] **Step 2: Widgets.** In `WidgetGradientEditor.vue`, add `@apply-literal-stops="applyStops"` alongside `@apply-stops="applyStops"`. In `ShaderFillEditor.vue`, replace the inline arrow with a named `applyRowStops(row, v)` bound to both `@apply-stops` and `@apply-literal-stops`.

- [ ] **Step 3: Compositor post-FX.** On the gradient-map ramp editor (`PostEffectsControls.vue:151`), mount `<PalettePicker mode="stops" @apply-stops="v => patch('gradientMap','stops', v)" @apply-literal-stops="v => patch('gradientMap','stops', v)" />` if not already present, matching the existing `patch(type, key, v)` signature in that file.

- [ ] **Step 4: Live-verify** each surface applies the exact seed colors (Shader gradient map, one per-effect gradient param, the node gradient widget, and the Compositor gradient map). Screenshot each.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/vue-canvas/ShaderStudioSurface.vue frontend/app/components/vue-canvas/widgets/WidgetGradientEditor.vue frontend/app/components/vue-canvas/widgets/ShaderFillEditor.vue frontend/app/components/vue-canvas/compositor/PostEffectsControls.vue
git commit -m "feat(shader,compositor,widgets): apply seed palettes literally on all ramp surfaces

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 3 — Scene3D (Tier B) (Task 11)

### Task 11: Scene3D — literal apply with paletteMode flip

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (ramp editor ~:4249; writable computed `matGradientStops` ~:652)
- Test: extend `frontend/tests/unit/scene3d-harmony-palette.unit.spec.ts`

**Interfaces:**
- Consumes: `apply-literal-stops`. Must set `mat.paletteMode = 'manual'` and clamp to 2..8 stops (`GRADIENT_STOPS_MAX`).

- [ ] **Step 1: Write the failing test** — applying literal stops while in harmony mode must switch to manual and keep the exact colors:

```ts
// add to frontend/tests/unit/scene3d-harmony-palette.unit.spec.ts
import { applySeedStopsToMaterial } from '~/lib/scene3d/config'
it('applying seed stops flips paletteMode to manual and keeps exact colors', () => {
  const mat: any = { paletteMode: 'harmony', gradientStops: [] }
  applySeedStopsToMaterial(mat, [{ pos: 0, color: '#b64a1f' }, { pos: 1, color: '#f4e3d0' }])
  expect(mat.paletteMode).toBe('manual')
  expect(mat.gradientStops.map((s: any) => s.color)).toEqual(['#b64a1f', '#f4e3d0'])
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/scene3d-harmony-palette.unit.spec.ts` — FAIL (function missing).

- [ ] **Step 3: Add the helper to `lib/scene3d/config.ts`**

```ts
import { GRADIENT_STOPS_MAX } from './config' // if defined elsewhere in-file, reference directly
/** Apply seed-engine stops to a material as manual gradient stops. Flips paletteMode
 *  so the authored stops are not shadowed by the harmony generator (config.ts rampStopsOf). */
export function applySeedStopsToMaterial(mat: SceneMaterial, stops: GradientStop[]): void {
  mat.paletteMode = 'manual'
  mat.gradientStops = stops.slice(0, GRADIENT_STOPS_MAX).map(s => ({ pos: s.pos, color: s.color }))
}
```
(Match `SceneMaterial` / `GradientStop` names already exported by this file; `GRADIENT_STOPS_MAX` is defined at ~:54.)

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Mount the picker.** Near the ramp editor (~:4249), add `<PalettePicker mode="stops" @apply-literal-stops="v => applySeedStopsToMaterial(activeMaterial, v)" @apply-stops="v => applySeedStopsToMaterial(activeMaterial, v)" />`, matching the active-material accessor name in this file.

- [ ] **Step 6: Live-verify** a seed palette on a gradient-material object renders those exact colors, and that a material previously in harmony mode switches correctly. Screenshot.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/lib/scene3d/config.ts frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/tests/unit/scene3d-harmony-palette.unit.spec.ts
git commit -m "feat(scene3d): apply seed palettes as manual stops (paletteMode flip)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 4 — Discrete distribute (Tier C: GeoShape, then Compositor) (Tasks 12–13)

### Task 12: GeoShape — distribute onto `fills` + fillStrategy flip

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShapeStudioSurface.vue` (fills-list editor ~:279–301; `setGeoControl`)
- Test: `frontend/tests/unit/geoshape-distribute.unit.spec.ts`

**Interfaces:**
- Consumes: `distribute` (Task 7), `PaletteFamily`.
- Produces: `distributeToGeoFills(mark: { fills: string[]; fillStrategy: string }, hexes: string[]): { fills: string[]; fillStrategy: string }` — pure helper: sets `fills` to `distribute(hexes, max(hexes.length, mark.fills.length))` and flips `fillStrategy` off `'single'`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/geoshape-distribute.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { distributeToGeoFills } from '~/lib/geoshape/distribute'

describe('distributeToGeoFills', () => {
  it('lands the palette as discrete fills', () => {
    const out = distributeToGeoFills({ fills: ['#000'], fillStrategy: 'single' }, ['#b64a1f', '#e8985e', '#f4e3d0'])
    expect(out.fills).toEqual(['#b64a1f', '#e8985e', '#f4e3d0'])
  })
  it('flips fillStrategy off single so the write is visible', () => {
    const out = distributeToGeoFills({ fills: ['#000'], fillStrategy: 'single' }, ['#a', '#b'])
    expect(out.fillStrategy).toBe('perClone')
  })
  it('leaves a non-single strategy untouched', () => {
    const out = distributeToGeoFills({ fills: ['#000'], fillStrategy: 'pieces' }, ['#a', '#b'])
    expect(out.fillStrategy).toBe('pieces')
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/geoshape-distribute.unit.spec.ts` — FAIL.

- [ ] **Step 3: Write the helper**

```ts
// frontend/app/lib/geoshape/distribute.ts
import { distribute } from '~/lib/color/project'
/** Apply a palette as discrete GeoShape fills. Flips fillStrategy off 'single'
 *  (its default) or the write is invisible — GeoShape only reads `fills` in
 *  perClone/pieces mode. */
export function distributeToGeoFills(
  mark: { fills: string[]; fillStrategy: string },
  hexes: string[],
): { fills: string[]; fillStrategy: string } {
  const fills = distribute(hexes, Math.max(hexes.length, mark.fills.length), 'cycle')
  const fillStrategy = mark.fillStrategy === 'single' ? 'perClone' : mark.fillStrategy
  return { fills, fillStrategy }
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Wire into the surface.** Mount `<PalettePicker mode="stops" @apply-family="applyPaletteToFills" />` in the fills-list section, and add:

```ts
function applyPaletteToFills(fam: PaletteFamily) {
  const next = distributeToGeoFills(activeMark.value, fam.hexes)
  setGeoControl('fills', next.fills)
  setGeoControl('fillStrategy', next.fillStrategy)
}
```
(Match `activeMark` / `setGeoControl` exactly as used at ~:279.)

- [ ] **Step 6: Live-verify** — apply a seed palette in Shape studio and confirm the clones show the discrete palette colors (not a single fill). Screenshot.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/lib/geoshape/distribute.ts frontend/app/components/vue-canvas/ShapeStudioSurface.vue frontend/tests/unit/geoshape-distribute.unit.spec.ts
git commit -m "feat(geoshape): distribute a seed palette across discrete fills

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Compositor — distribute one hex per selected layer

**Files:**
- Modify: the Compositor surface that owns layer selection + `setFill` (per `lib/compositor/` scan: `FillControl.vue` / the compositor surface with `setLayerFill`).
- Test: `frontend/tests/unit/compositor-distribute.unit.spec.ts`

**Interfaces:**
- Consumes: `distribute` (Task 7).
- Produces: `layerPaletteAssignments(layerIds: string[], hexes: string[]): Record<string, string>` — one hex per layer via `distribute(hexes, layerIds.length)`, wrapped later as `{type:'solid', color}` by the caller.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/compositor-distribute.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { layerPaletteAssignments } from '~/lib/compositor/distribute'

describe('layerPaletteAssignments', () => {
  it('assigns one color per layer, cycling when short', () => {
    expect(layerPaletteAssignments(['a', 'b', 'c'], ['#1', '#2'])).toEqual({ a: '#1', b: '#2', c: '#1' })
  })
  it('resamples down when colors exceed layers', () => {
    expect(layerPaletteAssignments(['a', 'b'], ['#1', '#2', '#3', '#4'])).toEqual({ a: '#1', b: '#4' })
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/compositor-distribute.unit.spec.ts` — FAIL.

- [ ] **Step 3: Write the helper**

```ts
// frontend/app/lib/compositor/distribute.ts
import { distribute } from '~/lib/color/project'
export function layerPaletteAssignments(layerIds: string[], hexes: string[]): Record<string, string> {
  const colors = distribute(hexes, layerIds.length, 'cycle')
  const out: Record<string, string> = {}
  layerIds.forEach((id, i) => { out[id] = colors[i]! })
  return out
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Wire into the compositor surface.** Add an "Apply palette to selected layers" affordance that opens `PalettePicker` and, on `apply-family`, calls `layerPaletteAssignments(selectedLayerIds.value, fam.hexes)` then writes each as a solid `Paint` via the existing `setLayerFill(id, { type: 'solid', color })` (match the exact fill-set method name in this file).

- [ ] **Step 6: Live-verify** — select 3+ layers, apply a palette, confirm each layer takes a distinct palette color. Screenshot.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/lib/compositor/distribute.ts frontend/tests/unit/compositor-distribute.unit.spec.ts frontend/app/components/vue-canvas/compositor/
git commit -m "feat(compositor): distribute a seed palette across selected layers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 5 — Agent recipe integration (Task 14)

### Task 14: Gradient recipes — palette menu built by the engine

**Files:**
- Modify: `frontend/app/lib/gradientfx/recipes.ts` (`RECIPES_SCHEMA` ~:92, `buildRecipesPrompt` ~:126, `salvageRecipes` ~:156)
- Modify: `frontend/server/api/vibe-recipes.post.ts`
- Test: `frontend/tests/unit/gradient-recipes.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `assembleShelf` (Task 6), `loadCorpus` (Task 6 — server-side reads the JSON file directly).
- Produces: a seed-menu field on the recipe request, and a palette candidate menu derived from the engine. The model still returns picks; `salvageRecipes` still enforces hex + length (unchanged). Keep `RECIPES_SCHEMA` free of `minItems`/`maxItems`.

- [ ] **Step 1: Write the failing test** — the engine-built menu yields only in-corpus/in-gamut hexes and never fewer than 2 per palette after salvage:

```ts
// extend frontend/tests/unit/gradient-recipes.unit.spec.ts
import { buildSeedMenu } from '~/lib/gradientfx/recipes'
it('buildSeedMenu returns ~24 named hexes across the hue wheel', () => {
  const menu = buildSeedMenu()
  expect(menu.length).toBeGreaterThanOrEqual(20)
  expect(menu.every(m => /^#[0-9a-f]{6}$/.test(m.hex) && m.name.length > 0)).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/gradient-recipes.unit.spec.ts` — FAIL (function missing).

- [ ] **Step 3: Add `buildSeedMenu` to `recipes.ts`** — a fixed hue-wheel menu the model picks from when no brand/taste seed is active:

```ts
import { oklchToHexInGamut } from '~/lib/color/convert'
export interface SeedMenuEntry { name: string; hex: string }
/** A fixed 24-entry seed menu: 12 hues × 2 lightness levels. The model picks one
 *  by name (never invents a hex), matching the recipes menu-pick contract. */
export function buildSeedMenu(): SeedMenuEntry[] {
  const HUES: [string, number][] = [
    ['red', 25], ['orange', 60], ['amber', 90], ['lime', 130], ['green', 150],
    ['teal', 185], ['cyan', 210], ['blue', 260], ['indigo', 290], ['violet', 320], ['magenta', 350], ['rose', 5],
  ]
  const out: SeedMenuEntry[] = []
  for (const [name, h] of HUES) {
    out.push({ name: `deep ${name}`, hex: oklchToHexInGamut(0.45, 0.16, h) })
    out.push({ name: `bright ${name}`, hex: oklchToHexInGamut(0.72, 0.15, h) })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes.** Same command — PASS.

- [ ] **Step 5: Server route — build the palette menu.** In `vibe-recipes.post.ts`, before calling the model: derive the seed (brand/taste key color if present in the request, else let the model pick from `buildSeedMenu()` via a new schema field `seed` — one string, enum-free, salvaged against the menu). Read the corpus file directly server-side:

```ts
import { assembleShelf } from '~/lib/color/seedEngine'
import type { CorpusEntry } from '~/lib/color/anchor'
// Nitro serves public/ via its assets storage — do NOT use process.cwd()/public
// (it is not the public root in the built server). Read through useStorage:
let corpus: CorpusEntry[] | null = null
async function getCorpus(): Promise<CorpusEntry[]> {
  if (!corpus) corpus = await useStorage('assets:public').getItem('data/palette-corpus.json') as CorpusEntry[]
  return corpus
}
// after seed is known:
const shelf = assembleShelf(await getCorpus(), { seedA: seedHex }, 16)
const paletteMenu = shelf.map((f, i) => ({ index: i, hexes: f.hexes, note: f.recipe ?? (f.sourceTag === 1 ? 'sanzo' : 'curated') }))
```
Add `paletteMenu` to the prompt text so the model picks a palette by index (the eye-pick contract), and in `materializeRecipe` continue to consume `recipe.palette` unchanged — populate it from `paletteMenu[chosenIndex].hexes` during salvage.

- [ ] **Step 6: Live-verify (paid path is OWED, per house note).** Run the vibe-recipes flow in the Gradient studio with a phrase; confirm candidates render from engine palettes and each contains the seed. Screenshot. Record the paid model run as owed if not executed here.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/lib/gradientfx/recipes.ts frontend/server/api/vibe-recipes.post.ts frontend/tests/unit/gradient-recipes.unit.spec.ts
git commit -m "feat(gradient-agent): build recipe palette menu from the seed engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full unit suite.** Run: `cd frontend && npx vitest run tests/unit/seed-*.unit.spec.ts tests/unit/rng.unit.spec.ts tests/unit/palette-corpus.unit.spec.ts tests/unit/palette-picker-literal.unit.spec.ts tests/unit/geoshape-distribute.unit.spec.ts tests/unit/compositor-distribute.unit.spec.ts` — expect all PASS. (Check `uptime`/collected total per the vitest-counts-lie note.)
- [ ] **Typecheck delta.** Run `npx vue-tsc --noEmit` and confirm no NEW errors naming the created modules (baseline may already have unrelated errors — see typecheck-baseline note).
- [ ] **Embed size guard.** Confirm `palette-corpus.json` is fetched, never imported — grep the built embed for `palette-corpus` should show no inlined array. If an embed prune-check exists, add the corpus path to it.
- [ ] **Dashboard.** Update the Sailor build dashboard artifact + docs per the standing rule.
