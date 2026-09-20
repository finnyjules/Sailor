# Simple Lighting — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace 3D Studio's six raw lighting sliders with a **Look** picker plus three plain dials (Softness, Warmth, Brightness) that resolve — through a pure function over a data-driven Look library — into the fields the engine already consumes, keeping every old control available behind an Advanced toggle.

**Architecture:** A pure `resolveLighting(look, dials)` reads a `LOOK_LIBRARY` recipe and writes the existing `SceneLighting` raw fields (`sunAzimuth/Elevation/Intensity`, `ambient`, `environment`, `preset`) plus two new ones (`sunColor`, `shadowSoftness`). The engine gains exactly two lines to read those two. New controls in `controls.ts` show the Look + dials by default and gate the raw controls behind `lighting.advanced`. Surface watchers run the resolver: changing the Look applies the whole recipe; changing a dial recomputes only the dial-driven fields, so a hand-set direction survives.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, Three.js, Vitest.

**Design source:** `docs/superpowers/specs/2026-09-04-scene3d-lighting-simplified-design.md` (the Look library table is the data for Task 1).

## Global Constraints

- Additive only: keep every existing `SceneLighting` field and every existing control. The raw controls move behind an Advanced toggle; nothing is deleted. Old saved scenes must round-trip unchanged.
- `resolveLighting` and the Look library live under `app/lib/scene3d/` and stay **pure** — no WebGL, no Vue, no `three` import in the resolver module — so they unit-test headless.
- Angles are azimuth (0–360) and elevation (5–90), matching the existing `sunAzimuth`/`sunElevation` ranges. Softness, Warmth, Brightness are the dials; Softness and Warmth are 0–1, Brightness is a 0.25–3 multiplier defaulting to 1.
- Do NOT build the categorized/featured gallery picker, the drag direction pad, or true metering auto-exposure in this phase — a plain select for the Look and a Brightness slider stand in. Those are flagged follow-ons.
- Frontend work in `frontend/`. Run the dev server on `127.0.0.1`, never `localhost`.

---

### Task 1: `resolveLighting` + the Look library (pure, data-driven)

**Files:**
- Create: `frontend/app/lib/scene3d/lighting.ts`
- Test: `frontend/tests/unit/scene3d-lighting.unit.spec.ts`

**Interfaces:**
- Consumes: `EnvironmentKind`, `LightingPreset` types from `~/lib/scene3d/config`.
- Produces:
  - `interface LookRecipe { id: string; group: 'portrait'|'product'|'cinematic'|'natural'; label: string; featured?: boolean; additive?: boolean; azimuth: number; elevation: number; softness: number; warmth: number; environment: EnvironmentKind; preset: LightingPreset; sunIntensity: number; ambient: number }`
  - `const LOOK_LIBRARY: LookRecipe[]`
  - `function getLook(id: string): LookRecipe` (falls back to the first recipe)
  - `interface LightingDials { softness: number; warmth: number; brightness: number }`
  - `interface ResolvedLighting { sunAzimuth: number; sunElevation: number; sunIntensity: number; ambient: number; environment: EnvironmentKind; preset: LightingPreset; sunColor: string; shadowSoftness: number }`
  - `function warmthToColor(w: number): string` (hex)
  - `function softnessToRadius(s: number): number`
  - `function resolveLook(recipe: LookRecipe): { sunAzimuth,sunElevation,environment,preset,softness,warmth } shaped patch` — the FULL recipe application (used on Look change)
  - `function resolveDials(recipe: LookRecipe, dials: LightingDials): { sunIntensity: number; ambient: number; sunColor: string; shadowSoftness: number }` — the dial-only recompute (used on dial change)

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/unit/scene3d-lighting.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LOOK_LIBRARY, getLook, warmthToColor, softnessToRadius, resolveDials, resolveLook } from '~/lib/scene3d/lighting'

describe('lighting look library', () => {
  it('has the eight featured looks and >=25 total, all with unique ids', () => {
    const ids = LOOK_LIBRARY.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(LOOK_LIBRARY.length).toBeGreaterThanOrEqual(25)
    expect(LOOK_LIBRARY.filter(l => l.featured).length).toBe(8)
  })
  it('every recipe has valid ranges', () => {
    for (const r of LOOK_LIBRARY) {
      expect(r.azimuth).toBeGreaterThanOrEqual(0); expect(r.azimuth).toBeLessThanOrEqual(360)
      expect(r.elevation).toBeGreaterThanOrEqual(5); expect(r.elevation).toBeLessThanOrEqual(90)
      expect(r.softness).toBeGreaterThanOrEqual(0); expect(r.softness).toBeLessThanOrEqual(1)
      expect(r.warmth).toBeGreaterThanOrEqual(0); expect(r.warmth).toBeLessThanOrEqual(1)
    }
  })
  it('getLook falls back to the first recipe for an unknown id', () => {
    expect(getLook('nope')).toBe(LOOK_LIBRARY[0])
    expect(getLook('softbox-beauty').id).toBe('softbox-beauty')
  })
})

describe('warmthToColor', () => {
  it('is neutral white at 0.5, cool below, warm above', () => {
    expect(warmthToColor(0.5).toLowerCase()).toBe('#ffffff')
    const cool = warmthToColor(0), warm = warmthToColor(1)
    // cool has more blue than red; warm has more red than blue
    const rgb = (h: string) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]
    const [cr,,cb] = rgb(cool); const [wr,,wb] = rgb(warm)
    expect(cb).toBeGreaterThan(cr)
    expect(wr).toBeGreaterThan(wb)
  })
})

describe('softnessToRadius', () => {
  it('maps 0..1 to a hard..soft shadow radius', () => {
    expect(softnessToRadius(0)).toBeLessThan(softnessToRadius(1))
    expect(softnessToRadius(0)).toBeGreaterThan(0)
  })
})

describe('resolveDials', () => {
  it('scales sun intensity by brightness and derives color+radius from the dials', () => {
    const r = getLook('softbox-beauty')
    const a = resolveDials(r, { softness: r.softness, warmth: r.warmth, brightness: 1 })
    const b = resolveDials(r, { softness: r.softness, warmth: r.warmth, brightness: 2 })
    expect(b.sunIntensity).toBeCloseTo(a.sunIntensity * 2)
    expect(a.sunColor).toBe(warmthToColor(r.warmth))
    expect(a.shadowSoftness).toBe(softnessToRadius(r.softness))
  })
})

describe('resolveLook', () => {
  it('returns the recipe direction, environment and default dials', () => {
    const r = getLook('golden-hour')
    const p = resolveLook(r)
    expect(p.sunAzimuth).toBe(r.azimuth)
    expect(p.sunElevation).toBe(r.elevation)
    expect(p.environment).toBe(r.environment)
    expect(p.softness).toBe(r.softness)
    expect(p.warmth).toBe(r.warmth)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-lighting.unit.spec.ts`
Expected: FAIL — module `~/lib/scene3d/lighting` not found.

- [ ] **Step 3: Implement `lighting.ts`**

Create `frontend/app/lib/scene3d/lighting.ts`:

```ts
// frontend/app/lib/scene3d/lighting.ts
// Simple lighting: a data-driven Look library + a PURE resolver that turns a Look
// and three dials (softness/warmth/brightness) into the SceneLighting fields the
// engine already consumes, plus sunColor + shadowSoftness. No WebGL, no three, no Vue.
import type { EnvironmentKind, LightingPreset } from '~/lib/scene3d/config'

export interface LookRecipe {
  id: string
  group: 'portrait' | 'product' | 'cinematic' | 'natural'
  label: string
  featured?: boolean
  additive?: boolean
  azimuth: number      // key direction, 0..360
  elevation: number    // 5..90
  softness: number     // default dial 0..1
  warmth: number       // default dial 0..1
  environment: EnvironmentKind
  preset: LightingPreset   // reuse existing env-intensity + shadow bucket
  sunIntensity: number     // baseline exposure
  ambient: number
}

// The Look library — data, drawn from the design spec's Look tables. ★ = featured.
export const LOOK_LIBRARY: LookRecipe[] = [
  // Product & commercial (featured heavy)
  { id: 'softbox-beauty',  group: 'product',   label: 'Softbox beauty',     featured: true, azimuth: 35,  elevation: 40, softness: 0.85, warmth: 0.5,  environment: 'softbox',    preset: 'soft',     sunIntensity: 1.2, ambient: 0.7 },
  { id: 'ecommerce-flat',  group: 'product',   label: 'E-commerce flat',    featured: true, azimuth: 45,  elevation: 45, softness: 0.9,  warmth: 0.5,  environment: 'softbox',    preset: 'flat',     sunIntensity: 1.0, ambient: 0.9 },
  { id: 'rim-on-dark',     group: 'product',   label: 'Rim on dark',        featured: true, azimuth: 160, elevation: 35, softness: 0.3,  warmth: 0.5,  environment: 'darkStrips', preset: 'dramatic', sunIntensity: 1.6, ambient: 0.15 },
  { id: 'hard-single-key', group: 'product',   label: 'Hard single key',    featured: true, azimuth: 40,  elevation: 35, softness: 0.15, warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.8, ambient: 0.25 },
  { id: 'two-tone-gels',   group: 'product',   label: 'Two-tone gels',      featured: true, azimuth: 60,  elevation: 30, softness: 0.5,  warmth: 0.5,  environment: 'colorGels',  preset: 'studio',   sunIntensity: 0.8, ambient: 0.3 },
  { id: 'three-point',     group: 'product',   label: 'Three-point',                        azimuth: 45,  elevation: 40, softness: 0.6,  warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.4, ambient: 0.5 },
  { id: 'light-tent',      group: 'product',   label: 'Light tent / high-key',              azimuth: 40,  elevation: 50, softness: 0.95, warmth: 0.5,  environment: 'softbox',    preset: 'flat',     sunIntensity: 1.0, ambient: 1.0 },
  { id: 'backlit',         group: 'product',   label: 'Backlit / contre-jour',              azimuth: 175, elevation: 30, softness: 0.5,  warmth: 0.5,  environment: 'room',       preset: 'soft',     sunIntensity: 1.7, ambient: 0.4 },
  // Portrait & beauty
  { id: 'rembrandt',       group: 'portrait',  label: 'Rembrandt',          featured: true, azimuth: 45,  elevation: 45, softness: 0.35, warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.6, ambient: 0.3 },
  { id: 'loop',            group: 'portrait',  label: 'Loop',                               azimuth: 35,  elevation: 40, softness: 0.6,  warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.4, ambient: 0.5 },
  { id: 'butterfly',       group: 'portrait',  label: 'Butterfly (Paramount)',              azimuth: 0,   elevation: 60, softness: 0.8,  warmth: 0.5,  environment: 'softbox',    preset: 'soft',     sunIntensity: 1.3, ambient: 0.6 },
  { id: 'clamshell',       group: 'portrait',  label: 'Clamshell',                          azimuth: 0,   elevation: 55, softness: 0.9,  warmth: 0.5,  environment: 'softbox',    preset: 'soft',     sunIntensity: 1.2, ambient: 0.8 },
  { id: 'split',           group: 'portrait',  label: 'Split',                              azimuth: 90,  elevation: 30, softness: 0.3,  warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.6, ambient: 0.2 },
  { id: 'broad-short',     group: 'portrait',  label: 'Broad / Short',                      azimuth: 55,  elevation: 40, softness: 0.55, warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.4, ambient: 0.5 },
  { id: 'rim-hair',        group: 'portrait',  label: 'Rim / hair',       additive: true,   azimuth: 180, elevation: 55, softness: 0.4,  warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.6, ambient: 0.5 },
  // Cinematic & mood
  { id: 'motivated',       group: 'cinematic', label: 'Motivated single source',            azimuth: 60,  elevation: 40, softness: 0.5,  warmth: 0.55, environment: 'room',       preset: 'dramatic', sunIntensity: 1.5, ambient: 0.35 },
  { id: 'low-key-noir',    group: 'cinematic', label: 'Low-key / noir',                     azimuth: 70,  elevation: 35, softness: 0.15, warmth: 0.45, environment: 'room',       preset: 'dramatic', sunIntensity: 1.8, ambient: 0.1 },
  { id: 'high-key',        group: 'cinematic', label: 'High-key',                           azimuth: 40,  elevation: 50, softness: 0.95, warmth: 0.5,  environment: 'softbox',    preset: 'flat',     sunIntensity: 1.0, ambient: 1.0 },
  { id: 'chiaroscuro',     group: 'cinematic', label: 'Chiaroscuro',                        azimuth: 65,  elevation: 40, softness: 0.25, warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.7, ambient: 0.15 },
  { id: 'silhouette',      group: 'cinematic', label: 'Silhouette',                         azimuth: 180, elevation: 30, softness: 0.5,  warmth: 0.5,  environment: 'room',       preset: 'soft',     sunIntensity: 2.0, ambient: 0.2 },
  { id: 'top-light',       group: 'cinematic', label: 'Top light',                          azimuth: 0,   elevation: 88, softness: 0.2,  warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.6, ambient: 0.2 },
  { id: 'underlight',      group: 'cinematic', label: 'Underlight',                         azimuth: 0,   elevation: 5,  softness: 0.3,  warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.5, ambient: 0.2 },
  { id: 'edge-on-black',   group: 'cinematic', label: 'Edge-only on black',                 azimuth: 165, elevation: 40, softness: 0.3,  warmth: 0.5,  environment: 'darkStrips', preset: 'dramatic', sunIntensity: 1.7, ambient: 0.05 },
  // Natural & time-of-day
  { id: 'golden-hour',     group: 'natural',   label: 'Golden hour',        featured: true, azimuth: 110, elevation: 15, softness: 0.6,  warmth: 0.85, environment: 'room',       preset: 'soft',     sunIntensity: 1.5, ambient: 0.45 },
  { id: 'overcast',        group: 'natural',   label: 'Overcast / open shade', featured: true, azimuth: 40, elevation: 70, softness: 1.0, warmth: 0.4, environment: 'room',        preset: 'flat',     sunIntensity: 0.9, ambient: 1.0 },
  { id: 'blue-hour',       group: 'natural',   label: 'Blue hour / twilight',               azimuth: 130, elevation: 20, softness: 0.8,  warmth: 0.2,  environment: 'room',       preset: 'soft',     sunIntensity: 0.8, ambient: 0.6 },
  { id: 'hard-noon',       group: 'natural',   label: 'Hard noon',                          azimuth: 30,  elevation: 80, softness: 0.1,  warmth: 0.45, environment: 'room',       preset: 'studio',   sunIntensity: 1.8, ambient: 0.4 },
  { id: 'window-light',    group: 'natural',   label: 'Window light',                       azimuth: 80,  elevation: 35, softness: 0.7,  warmth: 0.5,  environment: 'room',       preset: 'soft',     sunIntensity: 1.4, ambient: 0.5 },
  { id: 'sunset-backlight',group: 'natural',   label: 'Sunset backlight',                   azimuth: 170, elevation: 18, softness: 0.6,  warmth: 0.8,  environment: 'room',       preset: 'soft',     sunIntensity: 1.7, ambient: 0.45 },
  { id: 'moonlight',       group: 'natural',   label: 'Moonlight',                          azimuth: 120, elevation: 40, softness: 0.5,  warmth: 0.15, environment: 'room',       preset: 'dramatic', sunIntensity: 1.2, ambient: 0.25 },
  { id: 'firelight',       group: 'natural',   label: 'Firelight / candlelight',            azimuth: 55,  elevation: 25, softness: 0.6,  warmth: 0.95, environment: 'room',       preset: 'dramatic', sunIntensity: 1.3, ambient: 0.3 },
]

export function getLook(id: string): LookRecipe {
  return LOOK_LIBRARY.find(l => l.id === id) ?? LOOK_LIBRARY[0]!
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v * 255))).toString(16).padStart(2, '0')).join('')

/** 0 = cool (bluish), 0.5 = neutral white, 1 = warm (amber). Lerp cool→white→warm. */
export function warmthToColor(w: number): string {
  const t = clamp01(w)
  const cool = [0.80, 0.88, 1.0]
  const neutral = [1, 1, 1]
  const warm = [1.0, 0.80, 0.58]
  const lerp = (a: number[], b: number[], k: number) => a.map((av, i) => av + (b[i]! - av) * k)
  const c = t <= 0.5 ? lerp(cool, neutral, t / 0.5) : lerp(neutral, warm, (t - 0.5) / 0.5)
  return toHex(c[0]!, c[1]!, c[2]!)
}

/** 0 = hard (small penumbra), 1 = soft (large). Maps to THREE sun.shadow.radius. */
export function softnessToRadius(s: number): number {
  return 1 + clamp01(s) * 11   // 1..12
}

export interface LightingDials { softness: number; warmth: number; brightness: number }

/** Full recipe application — used when the Look itself changes. */
export function resolveLook(recipe: LookRecipe) {
  return {
    sunAzimuth: recipe.azimuth,
    sunElevation: recipe.elevation,
    environment: recipe.environment,
    preset: recipe.preset,
    softness: recipe.softness,
    warmth: recipe.warmth,
  }
}

/** Dial-only recompute — used when a dial moves; leaves direction/env/preset alone. */
export function resolveDials(recipe: LookRecipe, dials: LightingDials) {
  return {
    sunIntensity: recipe.sunIntensity * Math.max(0.25, dials.brightness),
    ambient: recipe.ambient,
    sunColor: warmthToColor(dials.warmth),
    shadowSoftness: softnessToRadius(dials.softness),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-lighting.unit.spec.ts`
Expected: PASS. Confirm the collected total matches the specs written (memory `vitest-counts-lie-under-load`).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/scene3d/lighting.ts tests/unit/scene3d-lighting.unit.spec.ts
git commit -m "feat(scene3d): simple-lighting resolver + Look library

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `SceneLighting` fields for Look + dials

**Files:**
- Modify: `frontend/app/lib/scene3d/config.ts` (the `SceneLighting` interface ~389, `defaultDoc` lighting ~690, `parseDoc` lighting ~1254)
- Test: `frontend/tests/unit/scene3d-motion.unit.spec.ts` (append; it already imports `defaultDoc`, `parseDoc`, `serializeDoc`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SceneLighting` gains `look: string`, `softness: number`, `warmth: number`, `brightness: number`, `sunColor: string`, `shadowSoftness: number`. Defaults: `look: 'softbox-beauty'`, `softness: 0.85`, `warmth: 0.5`, `brightness: 1`, `sunColor: '#ffffff'`, `shadowSoftness: 3`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/unit/scene3d-motion.unit.spec.ts`:

```ts
describe('scene3d lighting fields', () => {
  it('defaults the new simple-lighting fields', () => {
    const d = defaultDoc()
    expect(d.lighting.look).toBe('softbox-beauty')
    expect(d.lighting.softness).toBe(0.85)
    expect(d.lighting.warmth).toBe(0.5)
    expect(d.lighting.brightness).toBe(1)
    expect(d.lighting.sunColor).toBe('#ffffff')
    expect(d.lighting.shadowSoftness).toBe(3)
  })
  it('round-trips the new fields and defaults them on an old doc', () => {
    const d = defaultDoc()
    d.lighting.look = 'rembrandt'; d.lighting.warmth = 0.8; d.lighting.sunColor = '#ffcc99'
    const round = parseDoc(serializeDoc(d))
    expect(round.lighting.look).toBe('rembrandt')
    expect(round.lighting.warmth).toBe(0.8)
    expect(round.lighting.sunColor).toBe('#ffcc99')
    const raw = JSON.parse(serializeDoc(defaultDoc()))
    delete raw.lighting.look; delete raw.lighting.sunColor
    const old = parseDoc(JSON.stringify(raw))
    expect(old.lighting.look).toBe('softbox-beauty')
    expect(old.lighting.sunColor).toBe('#ffffff')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-motion.unit.spec.ts -t "lighting fields"`
Expected: FAIL — `look` undefined.

- [ ] **Step 3: Add the fields**

In `config.ts` `SceneLighting` interface (after `ambient: number` at ~395), add:

```ts
  // Simple-lighting layer (see lib/scene3d/lighting.ts). `look`+dials are the USER
  // intent the panel shows; the resolver writes them into the raw fields above plus
  // sunColor/shadowSoftness, which the engine reads. Both persist so the round-trip
  // and the picker/dials stay coherent.
  look: string
  softness: number
  warmth: number
  brightness: number
  sunColor: string
  shadowSoftness: number
```

In `defaultDoc()` lighting object (~690), add to the existing `lighting: { … }`:

```ts
      look: 'softbox-beauty', softness: 0.85, warmth: 0.5, brightness: 1, sunColor: '#ffffff', shadowSoftness: 3,
```

In `parseDoc` lighting object (~1254, alongside the existing `sunAzimuth`/etc. guards), add:

```ts
      look: typeof raw.lighting?.look === 'string' ? raw.lighting.look : d.lighting.look,
      softness: typeof raw.lighting?.softness === 'number' ? raw.lighting.softness : d.lighting.softness,
      warmth: typeof raw.lighting?.warmth === 'number' ? raw.lighting.warmth : d.lighting.warmth,
      brightness: typeof raw.lighting?.brightness === 'number' ? raw.lighting.brightness : d.lighting.brightness,
      sunColor: typeof raw.lighting?.sunColor === 'string' ? raw.lighting.sunColor : d.lighting.sunColor,
      shadowSoftness: typeof raw.lighting?.shadowSoftness === 'number' ? raw.lighting.shadowSoftness : d.lighting.shadowSoftness,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-motion.unit.spec.ts`
Expected: PASS (existing motion tests plus the two new lighting tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/scene3d/config.ts tests/unit/scene3d-motion.unit.spec.ts
git commit -m "feat(scene3d): SceneLighting look + dial + sunColor/shadowSoftness fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Engine reads `sunColor` + `shadowSoftness`

**Files:**
- Modify: `frontend/app/lib/scene3d/engine.ts` (the lighting block in `syncFromDoc`, ~715–720)

**Interfaces:**
- Consumes: `doc.lighting.sunColor`, `doc.lighting.shadowSoftness` (Task 2).
- Produces: no new exports. The sun tints to `sunColor` and its shadow penumbra follows `shadowSoftness`.

- [ ] **Step 1: Apply the two reads**

In `syncFromDoc`, immediately after the existing lines that set `this.sun.position`, `this.sun.intensity`, `this.sun.castShadow`, and `this.ambient.intensity` (~717–720), add:

```ts
    this.sun.color.set(stripAlpha(doc.lighting.sunColor || '#ffffff'))
    this.sun.shadow.radius = doc.lighting.shadowSoftness ?? 3
```

If `stripAlpha` is not already imported in `engine.ts`, import it from where the other scene3d modules do (`grep -n "stripAlpha" app/lib/scene3d/*.ts` — it is used in `environments.ts`); otherwise inline a guard: use `doc.lighting.sunColor` directly if it is always a 6-digit hex (the resolver only ever emits 6-digit hex, so `.set()` is safe — prefer the plain form and skip `stripAlpha` if importing it is awkward).

- [ ] **Step 2: Typecheck the touched file**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "engine.ts" || echo "no new errors in engine.ts"`
Expected: `no new errors in engine.ts`.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add app/lib/scene3d/engine.ts
git commit -m "feat(scene3d): sun tint + shadow softness from lighting fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Controls — show Look + dials, gate the raw sliders behind Advanced

**Files:**
- Modify: `frontend/app/lib/scene3d/controls.ts` (the Lighting group, ~532–541)

**Interfaces:**
- Consumes: `LOOK_LIBRARY` from `~/lib/scene3d/lighting`.
- Produces: new controls `lighting.look` (select), `lighting.softness`, `lighting.warmth`, `lighting.brightness` (sliders), `lighting.advanced` (toggle). Existing `lighting.preset`, `lighting.environment`, `lighting.sunIntensity`, `lighting.ambient` gain a `when: (doc) => doc.lighting.advanced` gate. `lighting.sunAzimuth`/`sunElevation` stay ungated (direction is a core dial). Gel controls are unchanged.

- [ ] **Step 1: Add the new controls and the advanced gate**

At the top of `controls.ts`, add the import:

```ts
import { LOOK_LIBRARY } from '~/lib/scene3d/lighting'
```

Replace the Lighting block (the `select('lighting.preset', …)` through `slider('lighting.ambient', …)` declarations, ~533–541) with:

```ts
  // --- Lighting (doc-level; no active object needed) -------------------------------
  // Simple layer: pick a Look, then nudge three dials. Direction stays visible.
  select('lighting.look', 'Look', LOOK_LIBRARY.map(l => l.id), D.lighting.look, 'Lighting'),
  slider('lighting.softness', 'Softness', 0, 1, 0.01, 'Lighting', D.lighting.softness),
  slider('lighting.warmth', 'Warmth', 0, 1, 0.01, 'Lighting', D.lighting.warmth),
  slider('lighting.brightness', 'Brightness', 0.25, 3, 0.05, 'Lighting', D.lighting.brightness),
  slider('lighting.sunAzimuth', 'Light direction', 0, 360, 1, 'Lighting', D.lighting.sunAzimuth,
    { animatable: false }),
  slider('lighting.sunElevation', 'Light height', 5, 90, 1, 'Lighting', D.lighting.sunElevation,
    { animatable: false }),
  toggle('lighting.advanced', 'Advanced lighting', D.lighting.advanced ?? false, 'Lighting'),
  // Raw controls kept behind Advanced — nothing is removed.
  select('lighting.preset', 'Shadow preset', [...LIGHTING_PRESETS], D.lighting.preset, 'Lighting',
    { when: (doc) => !!doc.lighting.advanced }),
  select('lighting.environment', 'Environment', [...ENVIRONMENT_KINDS], D.lighting.environment, 'Lighting',
    { when: (doc) => !!doc.lighting.advanced }),
  slider('lighting.sunIntensity', 'Sun intensity', 0, 3, 0.05, 'Lighting', D.lighting.sunIntensity,
    { when: (doc) => !!doc.lighting.advanced }),
  slider('lighting.ambient', 'Ambient', 0, 2, 0.05, 'Lighting', D.lighting.ambient,
    { when: (doc) => !!doc.lighting.advanced }),
```

Notes for the implementer:
- Match the EXACT signatures of `select`, `slider`, `toggle`, and the options bag (`when`, `animatable`) as they are defined elsewhere in this file — read a nearby `slider(... { when })` and `toggle(...)` usage first and mirror it. If `toggle` does not exist, use whatever boolean-control helper the file already uses (grep for `'toggle'` / boolean controls in the Background or Material groups).
- `lighting.advanced` needs to exist on the doc for the `when` to read it. Add `advanced: false` to `defaultDoc().lighting` and a parse guard `advanced: raw.lighting?.advanced === true` in `config.ts` (same place as Task 2's fields) — fold this into Task 2 if implementing in order, otherwise add it here.
- The `sunAzimuth`/`sunElevation` `animatable: false` flags preserve their current motion-target behavior; copy whatever flags they carried before this edit rather than dropping them.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "controls.ts\|lighting.ts" || echo "no new errors in touched files"`
Expected: `no new errors in touched files`.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add app/lib/scene3d/controls.ts app/lib/scene3d/config.ts
git commit -m "feat(scene3d): lighting panel — Look + dials, raw sliders behind Advanced

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the resolver — Look apply + dial recompute

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`

**Interfaces:**
- Consumes: `getLook`, `resolveLook`, `resolveDials` from `~/lib/scene3d/lighting`; the reactive `doc` in the surface.
- Produces: no new exports. Changing `doc.lighting.look` applies the recipe; changing `doc.lighting.softness/warmth/brightness` recomputes `sunIntensity/ambient/sunColor/shadowSoftness`; both leave a hand-set direction alone.

- [ ] **Step 1: Add two watchers**

Near the other `watch(...)` calls in `Scene3DStudioSurface.vue` (e.g. by the existing `sceneDoc`/doc watchers), add:

```ts
import { getLook, resolveLook, resolveDials } from '~/lib/scene3d/lighting'

// Look change → apply the whole recipe (direction, env, preset, default dials),
// then recompute the dial-driven fields from those defaults.
watch(() => doc.lighting.look, (id) => {
  const recipe = getLook(id)
  const p = resolveLook(recipe)
  doc.lighting.sunAzimuth = p.sunAzimuth
  doc.lighting.sunElevation = p.sunElevation
  doc.lighting.environment = p.environment
  doc.lighting.preset = p.preset
  doc.lighting.softness = p.softness
  doc.lighting.warmth = p.warmth
  const d = resolveDials(recipe, { softness: p.softness, warmth: p.warmth, brightness: doc.lighting.brightness })
  doc.lighting.sunIntensity = d.sunIntensity
  doc.lighting.ambient = d.ambient
  doc.lighting.sunColor = d.sunColor
  doc.lighting.shadowSoftness = d.shadowSoftness
})

// Dial change → recompute ONLY the dial-driven fields; direction/env/preset untouched.
watch(() => [doc.lighting.softness, doc.lighting.warmth, doc.lighting.brightness], () => {
  const recipe = getLook(doc.lighting.look)
  const d = resolveDials(recipe, {
    softness: doc.lighting.softness, warmth: doc.lighting.warmth, brightness: doc.lighting.brightness,
  })
  doc.lighting.sunIntensity = d.sunIntensity
  doc.lighting.ambient = d.ambient
  doc.lighting.sunColor = d.sunColor
  doc.lighting.shadowSoftness = d.shadowSoftness
})
```

Notes for the implementer:
- Match how the surface actually mutates the doc: if edits go through a `setWidget('scene_state', …)` / `mergeConfig` path rather than direct mutation, route these writes the same way the existing control-apply does, so they persist and trigger a re-render. Read the existing control-change handler first and mirror it. The intent is fixed; the write mechanism must match the file.
- If `doc` here is a `computed(parseDoc(...))` (read-only), the watchers must write back through the same serialize path the panel's sliders use. Do not introduce a second, divergent write path.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "Scene3DStudioSurface" || echo "no new errors in touched file"`
Expected: `no new errors in touched file`.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add app/components/vue-canvas/Scene3DStudioSurface.vue
git commit -m "feat(scene3d): wire simple-lighting resolver (look apply + dial recompute)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Live verification (controller)

Not a code task — the controller verifies in the Browser pane after Tasks 1–5.

- [ ] Open a scratch canvas on the running dev server (`127.0.0.1:3000`), add a 3D node, add a box, open the editor.
- [ ] In the Lighting panel: confirm the default panel shows Look + Softness + Warmth + Brightness + Light direction/height, and NOT the raw intensity/ambient/preset/environment (until Advanced is on).
- [ ] Change the Look to "Rembrandt" and to "Golden hour"; confirm the viewport lighting visibly changes (direction, and warmth on Golden hour) via a screenshot before/after.
- [ ] Drag Warmth up; confirm the render warms. Drag Softness down; confirm shadows sharpen.
- [ ] Toggle Advanced; confirm the raw sliders appear and still work.
- [ ] `read_console_messages` — no errors.

## Self-Review

**Spec coverage:** Look picker (Task 4 select over `LOOK_LIBRARY`), three dials (Task 4 sliders), resolver over existing fields (Tasks 1, 5), warmth as sun color + softness as shadow radius (Tasks 1, 3), Advanced preserving all raw controls (Task 4). The categorized/featured gallery, drag direction pad, and true metering auto-exposure are explicitly deferred per Global Constraints.

**Placeholder scan:** No TBD. Tasks 4 and 5 carry "match the file's existing helper signature / write path" notes rather than invented signatures, because the exact `select`/`slider`/`toggle` shape and the surface's doc-write path must be read from the files; the intent, values, and resolver calls are fully specified.

**Type consistency:** `LookRecipe`, `resolveLook`, `resolveDials`, `getLook`, `LOOK_LIBRARY` defined in Task 1 are consumed verbatim in Tasks 4–5. The six new `SceneLighting` fields (Task 2) plus `advanced` are read by Tasks 3–5. `sunColor` is always a 6-digit hex from `warmthToColor`, matching the engine `.set()` in Task 3.

## Flagged follow-ons (need your hands / a later phase)

- **The picker UI.** Phase 1 ships a plain select. The categorized, Featured-first, searchable gallery is the real picker and wants a design pass.
- **The direction pad.** Direction stays as azimuth/height sliders for now; the drag-the-orb (and later drag-the-highlight-on-preview) interaction is the taste-sensitive delight, deferred.
- **True auto-exposure.** Brightness is a manual multiplier here, not a metering pass. A metering-based auto-exposure is a Phase 1.5 refinement.
- **Rigs as light objects.** Looks currently resolve to one sun + IBL. Multi-light rigs (real rim/fill objects) are Phase 2.
