# Progressive Blur Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Progressive option to the 3D Studio's Blur treatment so the blur ramps across a screen-space direction — sharp at one end, fully blurred at the other — measured either across the object's own on-screen extent or across the whole frame.

**Architecture:** The ramp is analytic, evaluated per pixel inside the existing separable Gaussian (`BLUR_FRAG` in `treatmentStage.ts`) by scaling each pixel's tap step by its ramp value. Ramp `1` reproduces today's blur exactly, so toggling Progressive never changes the look of the fully-blurred region. No new render targets. Object-space bounds come from projecting the object's world AABB through the camera on the CPU.

**Tech Stack:** TypeScript, three.js (r1xx, WebGL2), raw GLSL in template literals, Vitest for unit tests, Playwright for the end-to-end WebGL assertions.

**Spec:** `docs/superpowers/specs/2026-09-06-scene3d-progressive-blur-design.md`

## Global Constraints

- **UI copy:** sentence case, never internal identifiers. Any `select` whose stored values are internal (`object`/`frame`) MUST carry `optionLabels`. No lowercase-start labels, blurbs or hints.
- **Ramp 1 must equal today's blur.** Any change that alters the uniform (non-progressive) blur output is a regression — the existing blur/invert/bake tests must keep their current numbers.
- **No dead controls.** Every new control row must be traced to the uniform that consumes it. A row that only stores its value is a failure.
- **Angle convention:** 0° ramps left→right, 90° ramps top→bottom (sharp top, blurred bottom). Texture `v = 1` is the visual TOP, so the ramp direction's Y component is negated.
- **`treatmentControls` is the single source** for the inspector, motion targets and the agent vocabulary. Adding a row affects all three.
- **Parallel sessions share this repo.** Stage only your own hunks (`git add <exact paths>`); never `git stash`.
- **Dev server:** a server for this checkout runs on `127.0.0.1:3007`. Playwright runs need `PW_BASE_URL=http://127.0.0.1:3007` and `CI=1`.
- **Run tests from `frontend/`.** Vitest: `node_modules/.bin/vitest run <path>`. Playwright: `node_modules/.bin/playwright test <path> --project=chromium --reporter=list`. There is no `vue-tsc` binary; typecheck is `node_modules/.bin/nuxt typecheck`.

---

### Task 1: Blur ramp fields on the data model

**Files:**
- Modify: `frontend/app/lib/scene3d/treatments.ts`
- Test: `frontend/tests/unit/scene3d-treatments.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BLUR_RAMP_SPACES: readonly ['object', 'frame']`
  - `type BlurRampSpace = 'object' | 'frame'`
  - `BlurTreatment` gains `progressive: boolean`, `rampSpace: BlurRampSpace`, `rampAngle: number`, `rampStart: number`, `rampEnd: number`
  - `TREATMENT_DEFAULTS.blur` gains the same five keys

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-treatments.unit.spec.ts` (inside the existing top-level `describe`, or as a new one — match the file's existing style):

```ts
describe('blur ramp fields', () => {
  it('backfills every ramp field on a blur with none of them', () => {
    const t = parseTreatment({ id: 'b1', kind: 'blur', amount: 0.4 })
    expect(t).toMatchObject({
      kind: 'blur', amount: 0.4,
      progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
  })

  it('keeps stored ramp values', () => {
    const t = parseTreatment({
      id: 'b2', kind: 'blur', amount: 1,
      progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
    })
    expect(t).toMatchObject({
      progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
    })
  })

  it('wraps the angle into 0-360 and clamps the stops', () => {
    const t = parseTreatment({
      id: 'b3', kind: 'blur', rampAngle: -90, rampStart: -2, rampEnd: 5,
    }) as { rampAngle: number; rampStart: number; rampEnd: number }
    expect(t.rampAngle).toBe(270)
    expect(t.rampStart).toBe(0)
    expect(t.rampEnd).toBe(1)
  })

  it('falls back to object space on an unknown ramp space', () => {
    const t = parseTreatment({ id: 'b4', kind: 'blur', rampSpace: 'sideways' })
    expect(t).toMatchObject({ rampSpace: 'object' })
  })

  it('treats a non-boolean progressive as off', () => {
    const t = parseTreatment({ id: 'b5', kind: 'blur', progressive: 'yes' })
    expect(t).toMatchObject({ progressive: false })
  })

  it('createTreatment seeds a blur with the ramp defaults', () => {
    expect(createTreatment('blur')).toMatchObject({
      kind: 'blur', progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
  })
})
```

Make sure `parseTreatment` and `createTreatment` are imported at the top of the file — check the existing imports and extend them rather than adding a second import statement.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts
```

Expected: FAIL — the received objects have no `progressive` / `rampSpace` / `rampAngle` / `rampStart` / `rampEnd` keys.

- [ ] **Step 3: Add the ramp space constant and widen BlurTreatment**

In `frontend/app/lib/scene3d/treatments.ts`, just above the `TreatmentBase` interface, add:

```ts
/** What a progressive blur's ramp is measured across. `object` = the object's own
 *  on-screen extent (self-contained, moves with it); `frame` = the whole viewport
 *  (lens-like). An inverted group always behaves as `frame` — see treatmentStage.ts. */
export const BLUR_RAMP_SPACES = ['object', 'frame'] as const
export type BlurRampSpace = typeof BLUR_RAMP_SPACES[number]
```

Replace the `BlurTreatment` interface:

```ts
export interface BlurTreatment extends TreatmentBase {
  kind: 'blur'
  amount: number
  /** Off ⇒ the blur covers the object evenly, exactly as it always has. */
  progressive: boolean
  rampSpace: BlurRampSpace
  /** Degrees. 0 ramps left→right, 90 ramps top→bottom (sharp top, blurred bottom). */
  rampAngle: number
  /** Normalised along the ramp direction: sharp up to `rampStart`, full blur from
   *  `rampEnd`. `rampEnd <= rampStart` is a hard edge at `rampStart`. */
  rampStart: number
  rampEnd: number
}
```

- [ ] **Step 4: Add the defaults**

Replace the `blur` line in `TREATMENT_DEFAULTS`:

```ts
  blur: { amount: 0.5, progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1 },
```

- [ ] **Step 5: Add the angle wrapper and parse the new fields**

Next to the existing `clamp01` helper, add:

```ts
/** Any finite degree value folded into [0, 360). */
const wrapDeg = (v: number): number => ((v % 360) + 360) % 360
```

Replace the `case 'blur'` arm of `parseTreatment`:

```ts
    case 'blur': return {
      ...base, kind: 'blur',
      amount: clamp01(num(r.amount, D.blur.amount)),
      progressive: r.progressive === true,
      rampSpace: (BLUR_RAMP_SPACES as readonly string[]).includes(r.rampSpace as string)
        ? r.rampSpace as BlurRampSpace
        : D.blur.rampSpace,
      rampAngle: wrapDeg(num(r.rampAngle, D.blur.rampAngle)),
      rampStart: clamp01(num(r.rampStart, D.blur.rampStart)),
      rampEnd: clamp01(num(r.rampEnd, D.blur.rampEnd)),
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 7: Run the whole treatment unit set for regressions**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatments.unit.spec.ts tests/unit/scene3d-treatment-stage.unit.spec.ts tests/unit/scene3d-treatment-controls.unit.spec.ts tests/unit/scene3d-treatment-shells.unit.spec.ts tests/unit/wired-treatments.unit.spec.ts
```

Expected: PASS (40+ tests). If `scene3d-treatment-controls` fails because it counts blur's rows, that is Task 4's business — note it and leave it; do not edit that expectation here.

- [ ] **Step 8: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatments.ts frontend/tests/unit/scene3d-treatments.unit.spec.ts
git commit -m "feat(scene3d): blur ramp fields on the treatment model"
```

---

### Task 2: Pure ramp maths

**Files:**
- Modify: `frontend/app/lib/scene3d/treatmentStage.ts`
- Test: `frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no three types).
- Produces:
  - `blurRampAt(t: number, start: number, end: number): number`
  - `rampDirection(angleDeg: number): { x: number; y: number }`
  - `rampSupport(w: number, h: number, angleDeg: number): number`

  Task 3 uses all three.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts`:

```ts
describe('blurRampAt', () => {
  it('is 0 before the start and 1 after the end', () => {
    expect(blurRampAt(0, 0.2, 0.8)).toBe(0)
    expect(blurRampAt(0.2, 0.2, 0.8)).toBe(0)
    expect(blurRampAt(0.8, 0.2, 0.8)).toBe(1)
    expect(blurRampAt(1, 0.2, 0.8)).toBe(1)
  })

  it('interpolates linearly between them', () => {
    expect(blurRampAt(0.5, 0, 1)).toBeCloseTo(0.5, 6)
    expect(blurRampAt(0.5, 0.2, 0.8)).toBeCloseTo(0.5, 6)
    expect(blurRampAt(0.35, 0.2, 0.8)).toBeCloseTo(0.25, 6)
  })

  it('is a hard edge when the end is at or below the start', () => {
    expect(blurRampAt(0.49, 0.5, 0.5)).toBe(0)
    expect(blurRampAt(0.5, 0.5, 0.5)).toBe(1)
    expect(blurRampAt(0.3, 0.5, 0.1)).toBe(0)
    expect(blurRampAt(0.7, 0.5, 0.1)).toBe(1)
  })
})

describe('rampDirection', () => {
  it('0 degrees runs left to right', () => {
    const d = rampDirection(0)
    expect(d.x).toBeCloseTo(1, 6)
    expect(d.y).toBeCloseTo(0, 6)
  })

  it('90 degrees runs top to bottom, so its y is negative', () => {
    // Texture v = 1 is the visual TOP, so "downwards" is -y.
    const d = rampDirection(90)
    expect(d.x).toBeCloseTo(0, 6)
    expect(d.y).toBeCloseTo(-1, 6)
  })

  it('270 degrees runs bottom to top', () => {
    const d = rampDirection(270)
    expect(d.y).toBeCloseTo(1, 6)
  })
})

describe('rampSupport', () => {
  it('is the width along 0 degrees and the height along 90', () => {
    expect(rampSupport(4, 2, 0)).toBeCloseTo(4, 6)
    expect(rampSupport(4, 2, 90)).toBeCloseTo(2, 6)
  })

  it('spans corner to corner on the diagonal', () => {
    expect(rampSupport(1, 1, 45)).toBeCloseTo(Math.SQRT2, 6)
  })

  it('is never negative, whatever the angle', () => {
    for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(rampSupport(3, 2, a)).toBeGreaterThan(0)
    }
  })
})
```

Extend the file's existing import from `~/lib/scene3d/treatmentStage` to include `blurRampAt`, `rampDirection` and `rampSupport`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-stage.unit.spec.ts
```

Expected: FAIL — `blurRampAt is not a function` (or an import error naming it).

- [ ] **Step 3: Implement the three pure functions**

In `frontend/app/lib/scene3d/treatmentStage.ts`, immediately after the existing `pixelateCellPx` function, add:

```ts
/** Ramp value at normalised position `t` along the ramp direction: 0 up to `start`,
 *  1 from `end`, linear between. `end <= start` is a hard edge at `start` — defined
 *  rather than left to divide-by-zero. Pure. */
export function blurRampAt(t: number, start: number, end: number): number {
  if (end <= start) return t < start ? 0 : 1
  return Math.min(1, Math.max(0, (t - start) / (end - start)))
}

/** Screen-space ramp direction for `angleDeg`: 0 runs left→right, 90 runs top→bottom.
 *  Y is negated because texture v = 1 is the visual TOP, so "down the screen" is -v. Pure. */
export function rampDirection(angleDeg: number): { x: number; y: number } {
  const a = angleDeg * Math.PI / 180
  return { x: Math.cos(a), y: -Math.sin(a) }
}

/** Support width of a `w` × `h` rectangle along `angleDeg` — how far the rectangle
 *  spans in that direction, so a diagonal ramp reaches corner to corner instead of
 *  running out early. Pure. */
export function rampSupport(w: number, h: number, angleDeg: number): number {
  const a = angleDeg * Math.PI / 180
  return Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-stage.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentStage.ts frontend/tests/unit/scene3d-treatment-stage.unit.spec.ts
git commit -m "feat(scene3d): pure ramp maths for progressive blur"
```

---

### Task 3: Ramp the blur shader

**Files:**
- Modify: `frontend/app/lib/scene3d/treatmentStage.ts`

**Interfaces:**
- Consumes: `blurRampAt` (reference only — the shader mirrors it in GLSL), `rampDirection`, `rampSupport` from Task 2; `BlurRampSpace`, `BLUR_RAMP_SPACES` from Task 1.
- Produces: an internal `BlurRamp` shape `{ dirX: number; dirY: number; min: number; span: number; start: number; end: number }` used by `blur()` and `applyEffect()`. Nothing outside this file consumes it.

**Why no unit test here:** this task is GLSL plus three.js render-target plumbing, which the unit environment cannot execute. Task 5 is its test. Do not fake a test with a mocked WebGL context — it would prove nothing.

- [ ] **Step 1: Add the ramp uniforms to BLUR_FRAG**

Replace the whole `BLUR_FRAG` constant:

```ts
// Separable Gaussian over PREMULTIPLIED colour so transparent pixels never darken the halo;
// un-premultiplied on the way out because the layer buffers are straight-alpha.
//
// PROGRESSIVE: each pixel's tap step is scaled by its ramp value. At r = 1 the step is
// exactly the uniform blur's, so a fully-ramped region is byte-for-byte the old blur; at
// r = 0 every tap lands on the same texel and the pixel comes back untouched. `uProgressive`
// 0 skips the ramp entirely, which is also what glow's internal blur uses.
const BLUR_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uDir;
  uniform float uProgressive; uniform vec2 uRampDir;
  uniform float uRampMin; uniform float uRampSpan; uniform float uRampStart; uniform float uRampEnd;
  varying vec2 vUv;
  // GLSL twin of blurRampAt() — keep the two in step.
  float rampAt(vec2 uv){
    if (uProgressive < 0.5) return 1.0;
    float t = (dot(uv, uRampDir) - uRampMin) / uRampSpan;
    float d = uRampEnd - uRampStart;
    if (d <= 0.0) return t < uRampStart ? 0.0 : 1.0;
    return clamp((t - uRampStart) / d, 0.0, 1.0);
  }
  void main(){
    vec2 dir = uDir * rampAt(vUv);
    vec4 acc = vec4(0.0); float wsum = 0.0;
    for (int i = -${TAPS}; i <= ${TAPS}; i++) {
      float w = exp(-float(i * i) / 72.0);
      vec4 s = texture2D(tDiffuse, vUv + dir * float(i));
      acc += vec4(s.rgb * s.a, s.a) * w; wsum += w;
    }
    acc /= wsum;
    gl_FragColor = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
  }`
```

- [ ] **Step 2: Declare the new uniforms on blurMat**

Replace the `blurMat` field initialiser:

```ts
  private readonly blurMat = shader(BLUR_FRAG, {
    tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() },
    uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
    uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
  })
```

- [ ] **Step 3: Add the BlurRamp type and teach blur() to take one**

Add this type next to `type RT = THREE.WebGLRenderTarget`:

```ts
/** A resolved progressive ramp in UV space: direction, where t = 0 sits along it
 *  (`min`), how far t = 1 is (`span`), and the two stops. */
interface BlurRamp { dirX: number; dirY: number; min: number; span: number; start: number; end: number }
```

Replace the `blur()` method's signature line and add the uniform writes at the top of its body. The whole method becomes:

```ts
  /** Separable blur of `src` by `radius` px, optionally ramped. Returns the target holding
   *  the result (never `src`). `ramp` null ⇒ an even blur, which is what glow's spread uses. */
  private blur(src: RT, amount: number, ramp: BlurRamp | null, ...reserve: RT[]): { rt: RT; radiusPx: number } {
    const { passes, step, radiusPx } = blurPasses(amount, this.height)
    if (passes === 0) return { rt: src, radiusPx: 0 }
    const u = this.blurMat.uniforms
    u.uProgressive!.value = ramp ? 1 : 0
    if (ramp) {
      ;(u.uRampDir!.value as THREE.Vector2).set(ramp.dirX, ramp.dirY)
      u.uRampMin!.value = ramp.min
      // A zero span would divide by zero in the shader; a degenerate ramp is caught
      // upstream in resolveRamp, so this is belt and braces rather than a real case.
      u.uRampSpan!.value = Math.abs(ramp.span) < 1e-6 ? 1 : ramp.span
      u.uRampStart!.value = ramp.start
      u.uRampEnd!.value = ramp.end
    }
    const a = this.free(src, ...reserve)
    // When `src` is itself a scratch (a previous effect's output, or glow's bright pass) it
    // is free to be overwritten once the first horizontal pass has read it — reusing it as
    // the second ping-pong target keeps three scratches enough for every combination.
    const b = this.scratch.includes(src) ? src : this.free(src, a, ...reserve)
    let cur = src
    for (let i = 0; i < passes; i++) {
      this.blurMat.uniforms.tDiffuse!.value = cur.texture
      this.blurMat.uniforms.uDir!.value.set(step / this.width, 0)
      this.pass(this.blurMat, a)
      this.blurMat.uniforms.tDiffuse!.value = a.texture
      this.blurMat.uniforms.uDir!.value.set(0, step / this.height)
      this.pass(this.blurMat, b)
      cur = b
    }
    return { rt: cur, radiusPx }
  }
```

- [ ] **Step 4: Add the ramp resolver**

Add these two methods immediately before `applyEffect`:

```ts
  /** UV-space min and max of `root`'s world AABB projected through `camera` and measured
   *  along `dir`. Null when the box is degenerate — any corner at or behind the camera
   *  plane, or no measurable spread — so the caller can fall back to an even blur. */
  private objectRampSpan(
    root: THREE.Object3D, camera: THREE.Camera, dir: { x: number; y: number },
  ): { min: number; max: number } | null {
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return null
    let min = Infinity, max = -Infinity
    const v = new THREE.Vector3()
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      // View space first: a corner at or behind the camera plane makes project() return
      // a mirrored point rather than failing, which would silently invert the ramp.
      const view = v.clone().applyMatrix4(camera.matrixWorldInverse)
      if (view.z > -1e-3) return null
      v.project(camera)
      const s = (v.x * 0.5 + 0.5) * dir.x + (v.y * 0.5 + 0.5) * dir.y
      if (s < min) min = s
      if (s > max) max = s
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-4) return null
    return { min, max }
  }

  /** The ramp for one blur treatment, or null for an even blur. `root` null (or an
   *  inverted group, whose treated area IS the frame) forces frame space. */
  private resolveRamp(
    t: BlurTreatment, root: THREE.Object3D | null, camera: THREE.Camera,
  ): BlurRamp | null {
    if (!t.progressive) return null
    const dir = rampDirection(t.rampAngle)
    const common = { dirX: dir.x, dirY: dir.y, start: t.rampStart, end: t.rampEnd }
    if (t.rampSpace === 'object' && root) {
      const span = this.objectRampSpan(root, camera, dir)
      if (span) return { ...common, min: span.min, span: span.max - span.min }
      // Degenerate box: fall through to the frame ramp rather than dropping the effect.
    }
    // UV space is the unit square, so its support width along `dir` is |x| + |y|, and the
    // smallest projection of its four corners is where the ramp starts.
    const min = Math.min(0, dir.x) + Math.min(0, dir.y)
    return { ...common, min, span: rampSupport(1, 1, t.rampAngle) }
  }
```

Add `BlurTreatment` to the existing type-only import from `./treatments`:

```ts
import type { BlurTreatment, MaskedGroup, Treatment } from './treatments'
```

- [ ] **Step 5: Thread the ramp through applyEffect and treatAndComposite**

Replace `applyEffect`'s signature and its two `this.blur(...)` call sites:

```ts
  /** Apply one masked treatment to `src`; returns the target with the result and the halo
   *  reach it introduced (px). Fade is handled by the caller as a composite opacity.
   *  `ramp` applies to a progressive blur only — glow's internal spread never ramps. */
  private applyEffect(src: RT, t: Treatment, ramp: BlurRamp | null): { rt: RT; haloPx: number } {
    if (t.kind === 'blur') {
      const { rt, radiusPx } = this.blur(src, t.amount, ramp)
      return { rt, haloPx: radiusPx }
    }
```

and inside the `glow` arm, the blur call becomes:

```ts
      const { rt: glow, radiusPx } = this.blur(bright, spread, null, src)
```

Replace `treatAndComposite` entirely:

```ts
  /** Run `g`'s treatment chain over `layerRt` and blend the result into the accumulator. */
  private treatAndComposite(
    g: MaskedGroup, layerRt: RT, baseDepth2: THREE.Texture | null,
    root: THREE.Object3D | null, camera: THREE.Camera,
  ): void {
    let src: RT = layerRt
    let opacity = 1
    let halo = 0
    for (const t of g.treatments) {
      if (t.kind === 'fade') { opacity *= t.opacity; continue }
      // An inverted group's treated area is the rest of the scene, so "the object's own
      // extent" is meaningless there — pass no root and resolveRamp uses frame space.
      const ramp = t.kind === 'blur' ? this.resolveRamp(t, g.invert ? null : root, camera) : null
      const res = this.applyEffect(src, t, ramp)
      src = res.rt
      halo = Math.max(halo, res.haloPx)
    }
    this.composite(src.texture, layerRt.depthTexture, baseDepth2, opacity, halo)
  }
```

- [ ] **Step 6: Pass the root and camera at both call sites**

In `render()`, the invert call becomes:

```ts
        this.treatAndComposite(invertGroup, inv, null, null, camera)
```

and the normal-group loop body becomes:

```ts
      for (const g of groups) {
        if (g.invert) continue
        const root = ctx.objectRoots.get(g.objectId)!
        this.drawAlone(scene, camera, root, treatedRoots, this.layer, null)
        this.treatAndComposite(g, this.layer, invDepth, root, camera)
      }
```

- [ ] **Step 7: Typecheck**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -i "treatmentStage"
```

Expected: no output. (The repo has a pre-existing baseline of errors in unrelated files; only `treatmentStage` matters here.)

- [ ] **Step 8: Verify the uniform blur has not moved**

```bash
cd frontend && CI=1 PW_BASE_URL=http://127.0.0.1:3007 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium --reporter=list
```

Expected: all 7 tests PASS, and the logged `[blur] left=0.854 right=26.655` is unchanged (small last-digit drift is fine; a changed ratio is not).

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentStage.ts
git commit -m "feat(scene3d): ramp the blur shader per pixel"
```

---

### Task 4: Controls, and make showIf actually work

**Files:**
- Modify: `frontend/app/lib/scene3d/treatmentControls.ts`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`
- Test: `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `BLUR_RAMP_SPACES`, `TREATMENT_DEFAULTS.blur` from Task 1.
- Produces: five new rows on `treatmentControls('blur')` with keys `treatment.progressive`, `treatment.rampSpace`, `treatment.rampAngle`, `treatment.rampStart`, `treatment.rampEnd`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts`:

```ts
describe('progressive blur rows', () => {
  const rows = () => treatmentControls('blur')

  it('offers the ramp controls after Amount', () => {
    const keys = rows().map((r) => r.key)
    expect(keys).toEqual([
      'treatment.amount', 'treatment.progressive', 'treatment.rampSpace',
      'treatment.rampAngle', 'treatment.rampStart', 'treatment.rampEnd', 'treatment.invert',
    ])
  })

  it('hides every ramp row behind the Progressive switch', () => {
    const gated = rows().filter((r) => r.showIf?.key === 'treatment.progressive')
    expect(gated.map((r) => r.key)).toEqual([
      'treatment.rampSpace', 'treatment.rampAngle', 'treatment.rampStart', 'treatment.rampEnd',
    ])
    for (const r of gated) expect(r.showIf).toMatchObject({ equals: true })
  })

  it('labels the ramp space options instead of showing the stored values', () => {
    const row = rows().find((r) => r.key === 'treatment.rampSpace')
    expect(row).toMatchObject({ kind: 'select', options: ['object', 'frame'] })
    expect((row as { optionLabels?: string[] }).optionLabels).toEqual(['The object', 'The whole frame'])
  })

  it('sweeps the angle over a full turn', () => {
    expect(rows().find((r) => r.key === 'treatment.rampAngle')).toMatchObject({
      kind: 'slider', min: 0, max: 360, default: 90,
    })
  })
})
```

Check the file's existing imports and extend them to include `treatmentControls` if it isn't already there.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-controls.unit.spec.ts
```

Expected: FAIL — the key list is `['treatment.amount', 'treatment.invert']`.

- [ ] **Step 3: Add a select helper and the ramp rows**

In `frontend/app/lib/scene3d/treatmentControls.ts`, import the ramp spaces by extending the existing import:

```ts
import { BLUR_RAMP_SPACES, TREATMENT_DEFAULTS, TREATMENT_LABELS, isMaskedKind, type TreatmentKind } from './treatments'
```

Add a `select` helper beside the existing `slider`/`color`/`toggle` helpers:

```ts
// `optionLabels` is mandatory here, not optional: every select in this file stores an
// internal value, and showing those raw would break the studio's copy rule.
const select = (group: string, field: string, label: string, options: string[], optionLabels: string[], def: string, hint?: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'select', options, optionLabels, default: def, group, bindable: false, ...(hint ? { hint } : {}) })

/** Show this row only while Progressive is on. */
const whenProgressive = (row: Row): Row =>
  ({ ...row, showIf: { key: TREATMENT_KEY_PREFIX + 'progressive', equals: true } })
```

Replace the `case 'blur'` arm:

```ts
    case 'blur':
      rows = [
        slider(g, 'amount', 'Amount', 0, 1, 0.01, D.blur.amount, 'How soft the object goes'),
        toggle(g, 'progressive', 'Progressive', D.blur.progressive, 'Ramp the blur across the object instead of covering it evenly'),
        whenProgressive(select(g, 'rampSpace', 'Measured across', [...BLUR_RAMP_SPACES], ['The object', 'The whole frame'], D.blur.rampSpace)),
        whenProgressive(slider(g, 'rampAngle', 'Angle', 0, 360, 1, D.blur.rampAngle, '0° ramps left to right, 90° top to bottom')),
        whenProgressive(slider(g, 'rampStart', 'Start', 0, 1, 0.01, D.blur.rampStart, 'Stays sharp up to here')),
        whenProgressive(slider(g, 'rampEnd', 'End', 0, 1, 0.01, D.blur.rampEnd, 'Fully blurred from here on')),
      ]
      break
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && node_modules/.bin/vitest run tests/unit/scene3d-treatment-controls.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Make showIf real in the treatment inspector**

`showIf` is inert here until the panel is given a `visible` predicate — declaring it without this wiring is a silently always-visible control.

In `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, add to the imports near the other `~/lib/studio` imports:

```ts
import { showIfVisible } from '~/lib/studio/sections'
```

Immediately after the existing `setTreatmentControl` function, add:

```ts
// `showIf` on a treatment row does nothing unless the panel is handed a predicate —
// StudioControlPanel's `visible` prop is that seam. Without this the ramp rows would
// show even with Progressive off, which is the classic silently-inert gate.
function treatmentControlVisible(c: ControlSpec): boolean {
  return showIfVisible(c, (key) => readTreatmentControl(key))
}
```

If `ControlSpec` is not already imported in this file, extend the existing `~/lib/spacetype/effect` type import to include it.

Then add the prop to the `StudioControlPanel` in the treatment branch of the template (around line 4142):

```vue
          <StudioControlPanel
            :controls="treatmentPanelControls"
            :order="treatmentPanelOrder"
            :value="readTreatmentControl"
            :visible="treatmentControlVisible"
            @set="setTreatmentControl"
          />
```

- [ ] **Step 6: Typecheck**

```bash
cd frontend && node_modules/.bin/nuxt typecheck 2>&1 | grep -iE "treatmentControls|Scene3DStudioSurface"
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/treatmentControls.ts frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts
git commit -m "feat(scene3d): progressive blur controls, and honour showIf in the treatment panel"
```

---

### Task 5: Prove the ramp actually fires

**Files:**
- Modify: `frontend/tests/scene3d-treatments.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing.

**The point of this task:** every previous task could pass its own tests while the ramp is a runtime no-op — a stored field, a declared row, a uniform nothing reads. This is the test that would catch that.

- [ ] **Step 1: Write the failing test**

Insert into `frontend/tests/scene3d-treatments.spec.ts`, immediately before the `tree flow:` test:

```ts
  /**
   * A progressive blur must actually RAMP: at angle 90 (sharp top, blurred bottom) the
   * bottom of the sphere has to be measurably softer than its top. Bands are compared
   * WITHIN one frame, the same discipline the rest of this file uses, so the composer
   * path's darker background cancels out. Paired with the stats hook so a stage that
   * silently fell back to an even blur — or to no blur — fails loudly.
   */
  test('a progressive blur softens the bottom of the object, not the top', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([{
      id: 't-pblur', kind: 'blur', enabled: true, invert: false, amount: 1,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    }]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)

    // Gradient energy inside two horizontal bands of the LEFT sphere.
    const bands = await page.evaluate(async (url) => {
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
    }, await snapshot(page))

    console.log(`[progressive] top=${bands.top.toFixed(3)} bottom=${bands.bottom.toFixed(3)} `
      + `ratio=${(bands.bottom / bands.top).toFixed(3)}`)
    expect(bands.top).toBeGreaterThan(SHARP_FLOOR) // the sharp end really is sharp
    expect(bands.bottom).toBeLessThan(bands.top * 0.5)
  })
```

- [ ] **Step 2: Run it to verify it fails on an unramped build**

Temporarily confirm the test discriminates: run it as-is.

```bash
cd frontend && CI=1 PW_BASE_URL=http://127.0.0.1:3007 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium --reporter=list -g "progressive"
```

Expected once Tasks 1–4 are in: PASS, with `ratio` well under 0.5.

If it FAILS with top and bottom both low, the ramp is not being applied and the whole object is blurred — check that `resolveRamp` is reached and `uProgressive` is 1. If it fails with both HIGH, no blur is happening at all — check `blurPasses` still returns passes. Report either as a finding rather than loosening the threshold.

- [ ] **Step 3: Verify the ramp direction is honoured**

Add a second test right after it, which flips the angle and expects the opposite:

```ts
  test('angle 270 flips which end of the object is sharp', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([{
      id: 't-pblur', kind: 'blur', enabled: true, invert: false, amount: 1,
      progressive: true, rampSpace: 'object', rampAngle: 270, rampStart: 0, rampEnd: 1,
    }]))
    expect((await stats(page)).frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    const bands = await page.evaluate(async (url) => {
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
    }, await snapshot(page))
    console.log(`[progressive 270] top=${bands.top.toFixed(3)} bottom=${bands.bottom.toFixed(3)}`)
    expect(bands.bottom).toBeGreaterThan(SHARP_FLOOR)
    expect(bands.top).toBeLessThan(bands.bottom * 0.5)
  })
```

- [ ] **Step 4: Run the whole treatment suite**

```bash
cd frontend && CI=1 PW_BASE_URL=http://127.0.0.1:3007 node_modules/.bin/playwright test tests/scene3d-treatments.spec.ts --project=chromium --reporter=list
```

Expected: 9 passed. The pre-existing `[blur]`, `[invert]`, `[bake]`, `[plain]`, `[shadow]` and `[fade]` numbers must be unchanged.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/tests/scene3d-treatments.spec.ts
git commit -m "test(scene3d): progressive blur ramps, and its direction flips"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Five data-model fields, defaults, parser clamps | 1 |
| Degenerate `rampEnd <= rampStart` = hard edge | 2 (`blurRampAt`), mirrored in GLSL in 3 |
| Per-pixel tap-step scaling, ramp 1 == today's blur | 3 |
| Frame-space ramp (support width) | 2 (`rampSupport`), 3 (`resolveRamp`) |
| Object-space ramp from the projected world AABB | 3 (`objectRampSpan`) |
| Degenerate box falls back to an even blur | 3 (`objectRampSpan` returns null) |
| Invert always uses frame space | 3 (`treatAndComposite` passes a null root) |
| Glow's internal blur never ramps | 3 (`applyEffect` passes null) |
| Five control rows, `showIf`, `optionLabels` | 4 |
| `showIf` wired through the panel's `visible` prop | 4 |
| Unit tests: ramp maths, parser | 1, 2 |
| E2E: bottom softer than top; direction flips | 5 |
| Regression: uniform blur unchanged | 3 step 8, 5 step 4 |

No gaps.

**Placeholder scan:** every code step carries complete code; no TBDs; no "similar to Task N".

**Type consistency:** `BlurRamp` is `{ dirX, dirY, min, span, start, end }` in Task 3's type, its construction in `resolveRamp`, and its consumption in `blur()`. `rampDirection` returns `{ x, y }` and is adapted into `dirX`/`dirY` at the one call site. Control keys are `treatment.<field>` in Task 4 and the field names match Task 1's model exactly (`progressive`, `rampSpace`, `rampAngle`, `rampStart`, `rampEnd`).
