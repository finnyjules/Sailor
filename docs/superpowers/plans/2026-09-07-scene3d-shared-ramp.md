# Shared Ramp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the Progressive ramp out of Blur into shared infrastructure, then give Glow, Pixelate and Fade the same mode.

**Architecture:** One `RampFields` interface extended by the four masked treatment kinds; one shared parser, one shared control-row builder, one shared GLSL chunk, one generalised `resolveRamp`. Each effect consumes the per-pixel 0–1 in the way exact for it, never by cross-fading.

**Tech Stack:** TypeScript, three.js (WebGL2), raw GLSL in template literals, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-07-scene3d-shared-ramp-design.md`

## Global Constraints

- **The four established numbers must not move.** `[blur] left=0.854 right=26.655` · `[fade] fraction=0.497 peakFraction=0.500` · `[progressive 90] attenuation top=0.294 bottom=0.040` · `[progressive 270] attenuation top=0.046 bottom=0.106`. Any change to these is a regression, not a new baseline.
- **Ramp 1 equals today's effect.** For every effect, a fully-ramped region must match what the un-ramped effect produces. Progressive off must be bit-identical to today.
- **No cross-fading.** Each effect scales its own parameter. A `mix(original, effected, r)` is explicitly rejected — it reads as a ghosted double image.
- **UI copy:** sentence case, never internal identifiers. The `rampSpace` select MUST carry `optionLabels`.
- **No dead controls.** Every new row must reach a uniform; the browser cases are what prove it.
- **Angle convention:** 0° ramps left→right, 90° top→bottom. Texture `v = 1` is the visual TOP, so the direction's Y is negated.
- **Edge treatments (rimLight, outline, xray, wireframe) get nothing.** They are geometry shells.
- **Parallel sessions share this checkout.** Stage only your own hunks by exact path; never `git stash`. **`git apply --3way` stages its result and an unmerged path blocks every commit repo-wide** — commit promptly, never leave things staged.
- **Dev server:** check what is listening first (`lsof -nP -iTCP -sTCP:LISTEN | grep node`); `:3002` serves the main checkout. Playwright needs `CI=1 PW_BASE_URL=http://127.0.0.1:3002`.
- **Run tests from `frontend/`.** Vitest: `node_modules/.bin/vitest run <path>`. Typecheck: `node_modules/.bin/nuxt typecheck` (large pre-existing baseline; only errors naming your files matter).

---

### Task 1: The shared ramp data model

**Files:**
- Modify: `frontend/app/lib/scene3d/treatments.ts`
- Test: `frontend/tests/unit/scene3d-treatments.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RampFields` interface; `RampSpace` type (with `BlurRampSpace` kept as an alias); `RAMP_SPACES` (renamed from `BLUR_RAMP_SPACES`, old name aliased); `RAMP_DEFAULTS` object; `parseRamp(r: Record<string, unknown>): RampFields`. `BlurTreatment`, `GlowTreatment`, `PixelateTreatment`, `FadeTreatment` all extend `RampFields`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-treatments.unit.spec.ts`:

```ts
describe('the shared ramp', () => {
  const KINDS = ['blur', 'glow', 'pixelate', 'fade'] as const

  it('every masked kind backfills all five ramp fields', () => {
    for (const kind of KINDS) {
      expect(parseTreatment({ id: `t-${kind}`, kind }), kind).toMatchObject({
        progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
      })
    }
  })

  it('every masked kind keeps stored ramp values', () => {
    for (const kind of KINDS) {
      expect(parseTreatment({
        id: `t-${kind}`, kind,
        progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
      }), kind).toMatchObject({
        progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
      })
    }
  })

  it('validates the ramp the same way for every kind', () => {
    for (const kind of KINDS) {
      const t = parseTreatment({
        id: `t-${kind}`, kind, rampAngle: -90, rampStart: -2, rampEnd: 5,
        rampSpace: 'sideways', progressive: 'yes',
      }) as unknown as Record<string, unknown>
      expect(t.rampAngle, kind).toBe(270)
      expect(t.rampStart, kind).toBe(0)
      expect(t.rampEnd, kind).toBe(1)
      expect(t.rampSpace, kind).toBe('object')
      expect(t.progressive, kind).toBe(false)
    }
  })

  it('createTreatment seeds every masked kind with the ramp defaults', () => {
    for (const kind of KINDS) {
      expect(createTreatment(kind), kind).toMatchObject({
        progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
      })
    }
  })

  it('leaves the edge kinds alone', () => {
    for (const kind of ['rimLight', 'outline', 'xray', 'wireframe'] as const) {
      expect(parseTreatment({ id: `t-${kind}`, kind }), kind).not.toHaveProperty('progressive')
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts
```

Expected: FAIL — glow, pixelate and fade have no `progressive` key.

- [ ] **Step 3: Add the shared type and defaults**

Replace the `BLUR_RAMP_SPACES` block with:

```ts
/** What a Progressive ramp is measured across. `object` = the object's own on-screen extent
 *  (self-contained, moves with it); `frame` = the whole viewport (lens-like). An inverted
 *  group always behaves as `frame` — see treatmentStage.ts. */
export const RAMP_SPACES = ['object', 'frame'] as const
export type RampSpace = typeof RAMP_SPACES[number]
/** @deprecated the ramp is no longer blur-specific — use RAMP_SPACES / RampSpace. */
export const BLUR_RAMP_SPACES = RAMP_SPACES
export type BlurRampSpace = RampSpace

/** The Progressive ramp, shared by every masked treatment. Flat fields rather than a nested
 *  object: Blur shipped these five keys, and the treatment panel reads a control with a
 *  single-level lookup, so nesting would cost both a migration and path support in the panel. */
export interface RampFields {
  /** Off ⇒ the effect covers the object evenly, exactly as it always has. */
  progressive: boolean
  rampSpace: RampSpace
  /** Degrees. 0 ramps left→right, 90 ramps top→bottom. */
  rampAngle: number
  /** Normalised along the ramp direction. `rampEnd <= rampStart` is a hard edge at start. */
  rampStart: number
  rampEnd: number
}

export const RAMP_DEFAULTS = {
  progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
} as const
```

- [ ] **Step 4: Extend the four masked interfaces**

Replace the four masked interfaces (leave the four edge ones untouched):

```ts
export interface BlurTreatment extends TreatmentBase, RampFields { kind: 'blur'; amount: number }
export interface GlowTreatment extends TreatmentBase, RampFields { kind: 'glow'; strength: number; threshold: number; tint: string }
export interface PixelateTreatment extends TreatmentBase, RampFields { kind: 'pixelate'; cellSize: number }
export interface FadeTreatment extends TreatmentBase, RampFields { kind: 'fade'; opacity: number }
```

- [ ] **Step 5: Spread the ramp defaults into the four kinds' defaults**

In `TREATMENT_DEFAULTS`, the four masked entries become:

```ts
  blur: { amount: 0.5, ...RAMP_DEFAULTS },
  glow: { strength: 1, threshold: 0.6, tint: '#ffffff', ...RAMP_DEFAULTS },
  pixelate: { cellSize: 12, ...RAMP_DEFAULTS },
  fade: { opacity: 0.5, ...RAMP_DEFAULTS },
```

- [ ] **Step 6: Add the shared parser and use it in all four arms**

Next to the existing `wrapDeg` helper add:

```ts
/** The five ramp fields, validated. Shared by every masked kind so they cannot drift apart. */
function parseRamp(r: Record<string, unknown>): RampFields {
  const D = RAMP_DEFAULTS
  return {
    progressive: r.progressive === true,
    rampSpace: (RAMP_SPACES as readonly string[]).includes(r.rampSpace as string)
      ? r.rampSpace as RampSpace
      : D.rampSpace,
    rampAngle: wrapDeg(num(r.rampAngle, D.rampAngle)),
    rampStart: clamp01(num(r.rampStart, D.rampStart)),
    rampEnd: clamp01(num(r.rampEnd, D.rampEnd)),
  }
}
```

Then the four masked arms of `parseTreatment` become:

```ts
    case 'blur': return { ...base, kind: 'blur', amount: clamp01(num(r.amount, D.blur.amount)), ...parseRamp(r) }
    case 'glow': return {
      ...base, kind: 'glow', strength: Math.max(0, num(r.strength, D.glow.strength)),
      threshold: clamp01(num(r.threshold, D.glow.threshold)), tint: str(r.tint, D.glow.tint),
      ...parseRamp(r),
    }
    case 'pixelate': return { ...base, kind: 'pixelate', cellSize: Math.max(1, Math.round(num(r.cellSize, D.pixelate.cellSize))), ...parseRamp(r) }
    case 'fade': return { ...base, kind: 'fade', opacity: clamp01(num(r.opacity, D.fade.opacity)), ...parseRamp(r) }
```

- [ ] **Step 7: Run the tests**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts tests/unit/scene3d-treatment-stage.unit.spec.ts tests/unit/scene3d-treatment-controls.unit.spec.ts tests/unit/wired-treatments.unit.spec.ts tests/unit/scene3d-motion-targets.unit.spec.ts
```

Expected: PASS. If `scene3d-treatment-controls` fails on blur's row count, that is Task 2's business — note it and leave it.

- [ ] **Step 8: Typecheck**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -iE "treatments\.ts|treatmentStage|treatmentControls"
```

Expected: no output.

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatments.ts frontend/tests/unit/scene3d-treatments.unit.spec.ts
git commit -m "refactor(scene3d): the ramp becomes shared treatment fields"
```

---

### Task 2: The shared control rows

**Files:**
- Modify: `frontend/app/lib/scene3d/treatmentControls.ts`
- Test: `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `RAMP_SPACES`, `RAMP_DEFAULTS` from Task 1.
- Produces: `treatmentControls('glow' | 'pixelate' | 'fade')` each gain five ramp rows in the same order Blur has.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts`:

```ts
describe('the shared ramp rows', () => {
  const RAMP_KEYS = [
    'treatment.progressive', 'treatment.rampSpace',
    'treatment.rampAngle', 'treatment.rampStart', 'treatment.rampEnd',
  ]

  it('every masked kind offers the ramp rows, in the same order', () => {
    for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
      const keys = treatmentControls(kind).map((r) => r.key)
      const ramp = keys.filter((k) => RAMP_KEYS.includes(k))
      expect(ramp, kind).toEqual(RAMP_KEYS)
      // the ramp sits after the effect's own dials and before "Everything else"
      expect(keys.indexOf('treatment.invert'), kind).toBeGreaterThan(keys.indexOf('treatment.rampEnd'))
    }
  })

  it('gates the four ramp rows behind Progressive on every kind', () => {
    for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
      const gated = treatmentControls(kind).filter((r) => r.showIf?.key === 'treatment.progressive')
      expect(gated.map((r) => r.key), kind).toEqual(RAMP_KEYS.slice(1))
      for (const r of gated) expect(r.showIf, kind).toMatchObject({ equals: true })
    }
  })

  it('labels the ramp space options on every kind', () => {
    for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
      const row = treatmentControls(kind).find((r) => r.key === 'treatment.rampSpace')
      expect(row, kind).toMatchObject({ kind: 'select', options: ['object', 'frame'] })
      expect((row as { optionLabels?: string[] }).optionLabels, kind).toEqual(['The object', 'The whole frame'])
    }
  })

  it('the edge kinds have no ramp rows', () => {
    for (const kind of ['rimLight', 'outline', 'xray', 'wireframe'] as const) {
      const keys = treatmentControls(kind).map((r) => r.key)
      expect(keys.filter((k) => RAMP_KEYS.includes(k)), kind).toEqual([])
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-controls.unit.spec.ts
```

Expected: FAIL — glow/pixelate/fade have no ramp rows.

- [ ] **Step 3: Extract the shared row builder**

Change the import to pull the renamed constant:

```ts
import { RAMP_SPACES, RAMP_DEFAULTS, TREATMENT_DEFAULTS, TREATMENT_LABELS, isMaskedKind, type TreatmentKind } from './treatments'
```

Replace `whenProgressive` with a builder that returns all five rows:

```ts
/** Show this row only while Progressive is on. */
const whenProgressive = (row: Row): Row =>
  ({ ...row, showIf: { key: TREATMENT_KEY_PREFIX + 'progressive', equals: true } })

/** The Progressive ramp rows, identical on every masked kind. The hint is effect-neutral
 *  because the same five rows now sit under blur, glow, pixelate and fade. */
const rampRows = (g: string): Row[] => [
  toggle(g, 'progressive', 'Progressive', RAMP_DEFAULTS.progressive,
    'Ramp the effect across the object instead of covering it evenly'),
  whenProgressive(select(g, 'rampSpace', 'Measured across', [...RAMP_SPACES],
    ['The object', 'The whole frame'], RAMP_DEFAULTS.rampSpace)),
  whenProgressive(slider(g, 'rampAngle', 'Angle', 0, 360, 1, RAMP_DEFAULTS.rampAngle,
    '0° ramps left to right, 90° top to bottom')),
  whenProgressive(slider(g, 'rampStart', 'Start', 0, 1, 0.01, RAMP_DEFAULTS.rampStart,
    'The effect begins here')),
  whenProgressive(slider(g, 'rampEnd', 'End', 0, 1, 0.01, RAMP_DEFAULTS.rampEnd,
    'The effect is at full strength from here on')),
]
```

- [ ] **Step 4: Use it in all four masked arms**

The four arms become:

```ts
    case 'blur':
      rows = [
        slider(g, 'amount', 'Amount', 0, 1, 0.01, D.blur.amount, 'How soft the object goes'),
        ...rampRows(g),
      ]
      break
    case 'glow':
      rows = [
        slider(g, 'strength', 'Strength', 0, 3, 0.01, D.glow.strength),
        slider(g, 'threshold', 'Threshold', 0, 1, 0.01, D.glow.threshold, 'Only parts brighter than this glow'),
        color(g, 'tint', 'Tint', D.glow.tint),
        ...rampRows(g),
      ]
      break
    case 'pixelate':
      rows = [
        slider(g, 'cellSize', 'Cell size', 2, 64, 1, D.pixelate.cellSize, 'Block size, relative to the image height'),
        ...rampRows(g),
      ]
      break
    case 'fade':
      rows = [
        slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.fade.opacity),
        ...rampRows(g),
      ]
      break
```

Note Blur's Start/End hints change from "Stays sharp up to here" / "Fully blurred from here on" to the effect-neutral wording above — that is intended, since the same rows now serve four effects.

- [ ] **Step 5: Run the tests**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-controls.unit.spec.ts tests/unit/scene3d-agent-controls.unit.spec.ts tests/unit/scene3d-motion-targets.unit.spec.ts
```

Expected: PASS. The motion-target spec should still show ramp targets appearing only when that treatment's `progressive` is true.

- [ ] **Step 6: Typecheck and commit**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -i treatmentControls
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentControls.ts frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts
git commit -m "feat(scene3d): Progressive rows on glow, pixelate and fade"
```

---

### Task 3: Lift the ramp into shared GLSL and plumbing

**Files:**
- Modify: `frontend/app/lib/scene3d/treatmentStage.ts`
- Test: `frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts`

**Interfaces:**
- Consumes: `RampFields` from Task 1.
- Produces: `RAMP_GLSL` (module constant); `rampValueAt(t, start, end)` (renamed from `blurRampAt`, same behaviour); `pixelateBand(r, bands)`; a `Ramp` interface (renamed from `BlurRamp`); `resolveRamp(t: RampFields, root, camera)`; `setRampUniforms(mat, ramp)`.

**Why no GLSL unit test:** shaders cannot run in the unit environment. Task 5 is the test for the GLSL; this task's own tests cover the pure helpers only.

- [ ] **Step 1: Write the failing tests for the new pure helper**

Append to `frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts`:

```ts
describe('pixelateBand', () => {
  it('band 0 at the sharp end, so the region is untouched', () => {
    expect(pixelateBand(0, 5)).toBe(0)
    expect(pixelateBand(0.19, 5)).toBe(0)
  })

  it('reaches the top band at the far end', () => {
    expect(pixelateBand(1, 5)).toBe(1)
    expect(pixelateBand(0.999, 5)).toBe(1)
  })

  it('produces exactly `bands` distinct values across the range', () => {
    const seen = new Set<number>()
    for (let i = 0; i <= 100; i++) seen.add(pixelateBand(i / 100, 5))
    expect(seen.size).toBe(5)
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('never decreases as the ramp rises', () => {
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const v = pixelateBand(i / 200, 5)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})
```

Extend the file's existing import from `~/lib/scene3d/treatmentStage` to include `pixelateBand`, and rename `blurRampAt` to `rampValueAt` in the existing import and its describe block (behaviour unchanged — same cases, same expectations).

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-stage.unit.spec.ts
```

Expected: FAIL — `pixelateBand is not a function`.

- [ ] **Step 3: Rename the pure helper and add the band quantiser**

Rename `blurRampAt` to `rampValueAt` (it was never blur-specific), keeping its body and doc comment, and add beside it:

```ts
/** Which band a ramp value falls in, as a 0–1 multiplier. Pixelate cannot scale its cell size
 *  per pixel — neighbouring pixels would snap to DIFFERENT grids, which is noise rather than a
 *  gradient — so the ramp is quantised and every pixel in a band shares one grid. Band 0 is 0,
 *  so the sharp end is left untouched. Pure; the GLSL in RAMP_GLSL mirrors it. */
export function pixelateBand(r: number, bands: number): number {
  const b = Math.min(Math.floor(r * bands), bands - 1)
  return b / (bands - 1)
}
```

- [ ] **Step 4: Extract RAMP_GLSL**

Add above `BLUR_FRAG`, lifting the ramp block that currently sits inside `BLUR_FRAG`:

```ts
/** The Progressive ramp, shared by every fragment shader that can vary across the object.
 *  `uProgressive` 0 short-circuits to 1.0, so a material with no ramp behaves exactly as it
 *  did before this existed. GLSL twin of rampValueAt() — keep the two in step. */
const RAMP_GLSL = `
  uniform float uProgressive; uniform vec2 uRampDir;
  uniform float uRampMin; uniform float uRampSpan; uniform float uRampStart; uniform float uRampEnd;
  float rampAt(vec2 uv){
    if (uProgressive < 0.5) return 1.0;
    float t = (dot(uv, uRampDir) - uRampMin) / uRampSpan;
    float d = uRampEnd - uRampStart;
    if (d <= 0.0) return t < uRampStart ? 0.0 : 1.0;
    return clamp((t - uRampStart) / d, 0.0, 1.0);
  }`
```

Then `BLUR_FRAG` becomes `\`uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;\` + RAMP_GLSL + \`…main…\`` — i.e. its inline ramp block is deleted and `RAMP_GLSL` concatenated in its place. Its `main()` is unchanged.

Do the same for `COMPOSITE_FRAG`: delete its inline copy and concatenate `RAMP_GLSL`.

- [ ] **Step 5: Rename the ramp type and generalise the resolver**

`interface BlurRamp` becomes `interface Ramp` (same fields). Update `blur()`'s parameter type and `resolveRamp`'s return type.

`resolveRamp`'s signature widens from `BlurTreatment` to the shared shape:

```ts
  /** The ramp for one treatment, or null for an even effect. `root` null (or an inverted
   *  group, whose treated area IS the frame) forces frame space. */
  private resolveRamp(
    t: RampFields, root: THREE.Object3D | null, camera: THREE.Camera,
  ): Ramp | null {
```

Its body is unchanged. Change the type-only import from `./treatments` to bring in `RampFields` instead of `BlurTreatment`.

- [ ] **Step 6: Add the shared uniform writer**

Add beside `resolveRamp`:

```ts
  /** Write a ramp onto any material carrying RAMP_GLSL's uniforms. `null` sets uProgressive 0,
   *  so a material cannot inherit the previous object's ramp within a frame. */
  private setRampUniforms(mat: THREE.ShaderMaterial, ramp: Ramp | null): void {
    const u = mat.uniforms
    u.uProgressive!.value = ramp ? 1 : 0
    if (!ramp) return
    ;(u.uRampDir!.value as THREE.Vector2).set(ramp.dirX, ramp.dirY)
    u.uRampMin!.value = ramp.min
    // A zero span would divide by zero; resolveRamp rules it out, so this is belt and braces.
    u.uRampSpan!.value = Math.abs(ramp.span) < 1e-6 ? 1 : ramp.span
    u.uRampStart!.value = ramp.start
    u.uRampEnd!.value = ramp.end
  }
```

In `blur()`, replace the inline uniform-writing block with `this.setRampUniforms(this.blurMat, ramp)`.

- [ ] **Step 7: Typecheck, then run the full existing guard**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -i treatmentStage
node_modules/.bin/vitest run tests/unit/scene3d-treatment-stage.unit.spec.ts
CI=1 PW_BASE_URL=http://127.0.0.1:3002 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium --reporter=list
```

Expected: typecheck silent; unit green; **10 Playwright cases pass with all four established numbers unchanged**. This task is a pure lift — if any number moves, the lift changed behaviour and must be corrected, not re-baselined.

- [ ] **Step 8: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentStage.ts frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts
git commit -m "refactor(scene3d): one shared ramp chunk, resolver and uniform writer"
```

---

### Task 4: Ramp glow, pixelate and fade

**Files:**
- Modify: `frontend/app/lib/scene3d/treatmentStage.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: no new exports; `applyEffect` and `treatAndComposite` resolve a ramp for every masked kind, not only blur.

**No unit test:** GLSL again. Task 5 proves it.

- [ ] **Step 1: Give the glow and pixelate materials the ramp uniforms**

`pixelateMat` and `glowMergeMat` each gain the six ramp uniforms, matching `blurMat`:

```ts
  private readonly pixelateMat = shader(PIXELATE_FRAG, {
    tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uCell: { value: 8 },
    uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
    uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
  })
  private readonly glowMergeMat = shader(GLOW_MERGE_FRAG, {
    tBase: { value: null }, tGlow: { value: null }, uTint: { value: new THREE.Color(1, 1, 1) }, uStrength: { value: 1 },
    uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
    uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
  })
```

- [ ] **Step 2: Ramp the pixelate shader**

`PIXELATE_FRAG` becomes:

```ts
const PIXELATE_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uResolution; uniform float uCell;
  varying vec2 vUv;` + RAMP_GLSL + `
  // Pixelate cannot scale its cell per pixel: neighbours would snap to different grids, which
  // reads as noise, not a gradient. The ramp is quantised into bands instead, so every pixel in
  // a band shares one grid and the change steps at the boundary — a deliberate graphic edge.
  // Band 0 gives a 1px cell, i.e. the sharp end is untouched. GLSL twin of pixelateBand().
  const float PIXELATE_BANDS = 5.0;
  void main(){
    float band = min(floor(rampAt(vUv) * PIXELATE_BANDS), PIXELATE_BANDS - 1.0) / (PIXELATE_BANDS - 1.0);
    vec2 cell = vec2(mix(1.0, uCell, band)) / uResolution;
    vec2 uv = (floor(vUv / cell) + 0.5) * cell;
    gl_FragColor = texture2D(tDiffuse, uv);
  }`
```

- [ ] **Step 3: Ramp the glow merge shader**

In `GLOW_MERGE_FRAG`, append `RAMP_GLSL` after the varying declaration and scale both terms:

```ts
const GLOW_MERGE_FRAG = `
  uniform sampler2D tBase; uniform sampler2D tGlow; uniform vec3 uTint; uniform float uStrength;
  varying vec2 vUv;` + RAMP_GLSL + `
  void main(){
    vec4 b = texture2D(tBase, vUv);
    vec4 g = texture2D(tGlow, vUv);
    // Glow is additive, so the ramp scales the ADDED light exactly — no cross-fade needed.
    float r = rampAt(vUv);
    vec3 add = g.rgb * g.a * uTint * uStrength * r;
    float a = max(b.a, g.a * clamp(uStrength * r, 0.0, 1.0));
    vec3 rgb = (b.rgb * b.a + add) / max(a, 1e-5);
    gl_FragColor = vec4(rgb, a);
  }`
```

- [ ] **Step 4: Ramp the fade in the composite**

In `COMPOSITE_FRAG`'s `main()`, replace the line `float a = s.a * uOpacity;` with:

```glsl
    // Fade's opacity is per-pixel once ramped: r = 0 leaves the object solid, r = 1 applies the
    // dialled opacity, so the object sweeps from solid to faded rather than dimming evenly.
    float a = s.a * mix(1.0, uOpacity, rampAt(vUv));
```

- [ ] **Step 5: Fix the display-blend gate**

In `composite()`, the gate currently reads `opacity < 1`. A ramped fade at opacity 1 still varies per pixel, and an object at opacity 1 with a ramp must take the display path. Change the signature to take the ramp and widen the test:

```ts
  private composite(
    layerTex: THREE.Texture, layerDepth: THREE.Texture | null, baseDepth2: THREE.Texture | null,
    opacity: number, haloPx: number, fadeRamp: Ramp | null,
  ): void {
```

and inside it:

```ts
    this.setRampUniforms(this.compositeMat, fadeRamp)
    // Only a fade needs the tone-mapped blend, and only ACES is invertible here. A RAMPED fade
    // qualifies even at opacity 1, because its opacity varies per pixel — testing `opacity < 1`
    // alone would send a ramped fade down the linear path and lose the perceptual curve.
    u.uDisplayBlend!.value =
      (fadeRamp !== null || opacity < 1) && this.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 1 : 0
```

- [ ] **Step 6: Resolve a ramp for every masked kind**

`applyEffect` already takes `ramp`. Pass it to the pixelate and glow materials:

```ts
    if (t.kind === 'pixelate') {
      const dst = this.free(src)
      const cellPx = pixelateCellPx(t.cellSize, this.height)
      this.pixelateMat.uniforms.tDiffuse!.value = src.texture
      this.pixelateMat.uniforms.uCell!.value = cellPx
      this.setRampUniforms(this.pixelateMat, ramp)
      this.pass(this.pixelateMat, dst)
      return { rt: dst, haloPx: cellPx }
    }
```

and in the glow arm, after `uStrength` is set:

```ts
      this.setRampUniforms(this.glowMergeMat, ramp)
```

(glow's internal `this.blur(bright, spread, null, src)` keeps its `null` — its spread must not ramp.)

Then `treatAndComposite` resolves a ramp for every masked treatment rather than blur alone, and carries the fade's ramp to the composite:

```ts
  private treatAndComposite(
    g: MaskedGroup, layerRt: RT, baseDepth2: THREE.Texture | null,
    root: THREE.Object3D | null, camera: THREE.Camera,
  ): void {
    let src: RT = layerRt
    let opacity = 1
    let halo = 0
    let fadeRamp: Ramp | null = null
    for (const t of g.treatments) {
      // An inverted group's treated area is the rest of the scene, so "the object's own extent"
      // is meaningless there — pass no root and resolveRamp uses frame space.
      const ramp = this.resolveRamp(t as unknown as RampFields, g.invert ? null : root, camera)
      if (t.kind === 'fade') { opacity *= t.opacity; fadeRamp = ramp; continue }
      const res = this.applyEffect(src, t, ramp)
      src = res.rt
      halo = Math.max(halo, res.haloPx)
    }
    this.composite(src.texture, layerRt.depthTexture, baseDepth2, opacity, halo, fadeRamp)
  }
```

Note `resolveRamp` returns null for any treatment whose `progressive` is false, and the edge kinds never reach here, so the cast is safe — but guard it: `resolveRamp` should return null when the treatment has no `progressive` key at all.

- [ ] **Step 7: Guard resolveRamp against a treatment with no ramp**

First line of `resolveRamp` becomes:

```ts
    if (!t || t.progressive !== true) return null
```

- [ ] **Step 8: Typecheck and run the regression guard**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -i treatmentStage
CI=1 PW_BASE_URL=http://127.0.0.1:3002 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium --reporter=list
```

Expected: 10 pass, all four established numbers unchanged. Progressive is off by default everywhere, so nothing existing may move.

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentStage.ts
git commit -m "feat(scene3d): glow, pixelate and fade honour the ramp"
```

---

### Task 5: Prove each newly-ramped effect actually ramps

**Files:**
- Modify: `frontend/tests/scene3d-treatments.spec.ts`

**Interfaces:**
- Consumes: everything above. Produces nothing.

**The point:** every task above can pass while the three new ramps are runtime no-ops — a stored field, a declared row, a uniform nothing reads. This is the only thing that catches that.

- [ ] **Step 1: Add the shared attenuation helper**

Insert near the file's other helpers. This is the metric that survived the blur work: the two probe bands differ ~13× in natural detail, so a single absolute threshold cannot serve both ends — everything is measured against a control frame that runs the SAME composer path with the ramp ramping to nothing.

```ts
/** Gradient energy in a top band and a bottom band of the left sphere. */
async function bandEnergy(page: Page, dataUrl: string): Promise<{ top: number; bottom: number }> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const score = (fy0: number, fy1: number) => {
      let s = 0, n = 0
      for (let y = Math.floor(height * fy0); y < height * fy1; y++)
        for (let x = Math.floor(width * 0.25); x < width * 0.45 - 1; x++) {
          const i = (y * width + x) * 4; const d = lum(i) - lum(i + 4); s += d * d; n++
        }
      return s / n
    }
    return { top: score(0.34, 0.44), bottom: score(0.56, 0.66) }
  }, dataUrl)
}

/** Run one treatment twice — ramped, and with the ramp ramping to nothing (start = end = 1,
 *  a hard edge at the far end, so every pixel sits in the untouched region) — and return each
 *  band's energy as a fraction of the control. Same composer path both times, so the path's own
 *  background shift cancels. */
async function rampAttenuation(page: Page, treatment: Record<string, unknown>) {
  await openLab(page, twoSpheres([{ ...treatment, rampStart: 1, rampEnd: 1 }]))
  const control = await bandEnergy(page, await snapshot(page))
  await openLab(page, twoSpheres([treatment]))
  const s = await stats(page)
  expect(s.frames).toBeGreaterThan(0)
  expect(s.groups).toBe(1)
  const test = await bandEnergy(page, await snapshot(page))
  return {
    control, test,
    top: test.top / control.top,
    bottom: test.bottom / control.bottom,
  }
}
```

- [ ] **Step 2: Write the three failing tests**

Insert before the `tree flow:` test:

```ts
  test('a progressive glow builds toward the ramp end, not evenly', async ({ page }) => {
    const a = await rampAttenuation(page, {
      id: 't-glow', kind: 'glow', enabled: true, invert: false,
      strength: 3, threshold: 0.2, tint: '#ffffff',
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
    console.log(`[ramp glow] control=${JSON.stringify(a.control)} test=${JSON.stringify(a.test)} `
      + `atten top=${a.top.toFixed(3)} bottom=${a.bottom.toFixed(3)}`)
    // angle 90 ramps top (sharp, r=0 → no glow) to bottom (r=1 → full glow); glow ADDS light,
    // so the bottom band departs from its control far more than the top does.
    expect(Math.abs(a.bottom - 1)).toBeGreaterThan(Math.abs(a.top - 1) * 2)
  })

  test('a progressive pixelate blocks the ramp end and leaves the other sharp', async ({ page }) => {
    const a = await rampAttenuation(page, {
      id: 't-pix', kind: 'pixelate', enabled: true, invert: false, cellSize: 48,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
    console.log(`[ramp pixelate] control=${JSON.stringify(a.control)} test=${JSON.stringify(a.test)} `
      + `atten top=${a.top.toFixed(3)} bottom=${a.bottom.toFixed(3)}`)
    expect(a.bottom).toBeLessThan(a.top * 0.65)
  })

  test('a progressive fade sweeps from solid to faded', async ({ page }) => {
    const a = await rampAttenuation(page, {
      id: 't-fade-ramp', kind: 'fade', enabled: true, invert: false, opacity: 0.05,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
    console.log(`[ramp fade] control=${JSON.stringify(a.control)} test=${JSON.stringify(a.test)} `
      + `atten top=${a.top.toFixed(3)} bottom=${a.bottom.toFixed(3)}`)
    expect(a.bottom).toBeLessThan(a.top * 0.65)
  })

  /** The display-blend gate used to read `opacity < 1`. A ramped fade at opacity 1 still varies
   *  per pixel and must take the tone-mapped path; this is the case that would catch it
   *  silently falling back to the linear blend. */
  test('a ramped fade at opacity 1 still ramps', async ({ page }) => {
    const a = await rampAttenuation(page, {
      id: 't-fade-one', kind: 'fade', enabled: true, invert: false, opacity: 1,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
    console.log(`[ramp fade@1] atten top=${a.top.toFixed(3)} bottom=${a.bottom.toFixed(3)}`)
    // opacity 1 means "fully solid" at every ramp value, so nothing should change — the point is
    // that it does not CRASH or blank, and that both bands stay near their control.
    expect(a.top).toBeGreaterThan(0.8)
    expect(a.bottom).toBeGreaterThan(0.8)
  })
```

- [ ] **Step 3: Run them**

```bash
cd frontend && CI=1 PW_BASE_URL=http://127.0.0.1:3002 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium --reporter=list
```

Expected: 14 pass. If a ramp test fails with both bands near 1.0, that ramp is a no-op — the uniform is not reaching the shader. **Diagnose it; do not loosen the threshold.** If the fade@1 case fails low, the display-blend gate is wrong.

- [ ] **Step 4: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/tests/scene3d-treatments.spec.ts
git commit -m "test(scene3d): each newly-ramped effect actually ramps"
```

---

### Task 6: See it

**Files:** none committed — this task produces evidence, not code.

- [ ] **Step 1: Confirm the rows render in the real inspector**

The unit tests prove the rows are declared; only the browser proves they appear. Add a Blur/Glow/Pixelate/Fade loop to the existing "the Progressive switch is in the inspector and gates the ramp rows" case, or write a temporary spec that, for each of the four kinds, adds the treatment from the row menu and asserts Progressive is visible and the four ramp rows appear only after toggling it. Delete a temporary spec afterwards; keep it if it fits the existing case cleanly.

- [ ] **Step 2: Capture a contact sheet**

Write a temporary Playwright spec that renders the studio-default scene (softbox look, floor on, one sphere) for: no treatment; each of glow / pixelate / fade un-ramped; and each ramped at angle 90 with start 0 end 1. Crop square, encode JPEG ~0.82, write to the scratchpad. Delete the spec afterwards.

- [ ] **Step 3: Judge the pixelate bands by eye**

Five bands was a design choice, not a measurement. Look at the pixelate contact sheet and say whether the steps read as deliberate or as an artefact. Report the judgement — do not change the constant without saying why.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| `RampFields`, `RampSpace`/`RAMP_SPACES` rename with aliases, `RAMP_DEFAULTS` | 1 |
| Shared `parseRamp` across four kinds; edge kinds untouched | 1 |
| Shared `rampRows`, effect-neutral hint, `optionLabels`, showIf gating | 2 |
| `RAMP_GLSL` extraction; `blurRampAt` → `rampValueAt`; `BlurRamp` → `Ramp` | 3 |
| `resolveRamp` generalised to `RampFields`; `setRampUniforms` | 3 |
| Blur unchanged (ramp 1 = today's blur) | 3 step 7, 4 step 8 |
| Glow scales added light by r | 4 |
| Fade `mix(1, opacity, r)` per pixel | 4 |
| Pixelate 5 bands, band 0 untouched | 3 (`pixelateBand`) + 4 (GLSL twin) |
| Display-blend gate widened to `progressive \|\| opacity < 1` | 4 step 5, tested in 5 step 2 |
| Unit: band quantiser, parser ×4, control rows ×4 | 1, 2, 3 |
| Browser: one case per newly-ramped effect + the gate case | 5 |
| Regression: four established numbers | 3, 4, 5 |
| Pixelate band seams seen by eye | 6 |

No gaps.

**Placeholder scan:** every code step carries complete code. Task 6 is deliberately evidence-only and says so.

**Type consistency:** `RampFields` (treatments.ts) is the data shape; `Ramp` (treatmentStage.ts) is the resolved GPU shape `{ dirX, dirY, min, span, start, end }` — two different things, deliberately named differently. `rampValueAt` and `pixelateBand` are the pure pair; `rampAt` is their GLSL twin. Control keys are `treatment.<field>` and match Task 1's field names exactly.
