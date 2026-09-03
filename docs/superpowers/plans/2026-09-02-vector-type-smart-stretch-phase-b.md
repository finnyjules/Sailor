# Vector Type Smart Stretch — Phase B (studio surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Phase A stretch engine into the Vector Type Studio — two dials (Stretch, Height), a fit-to-width solver, per-glyph motion with three presets, and agent vocabulary — under the per-axis range policy, without the user ever seeing k, round coupling, or the shape rules.

**Architecture:** The engine (`lib/vectortype/stretch.ts`) stays pure and untouched except for two small exports (a per-glyph entry point and the damping helper). Stretch enters the studio at ONE seam — `vectorTypeFrame` in `canvas.ts`, after each glyph's outline is chosen and before the pen is re-accumulated — so every consumer (canvas draw, SVG export, extrude solid, thumbnails, frame sources) gets it for free. Config fields + control declarations make the dials, motion targets and agent controls appear through the existing schema machinery (Act 1's "one declaration" factory). Fit-to-width is a solver on the same dial, fed the box width by the two callers that know it.

**Tech Stack:** TypeScript (Nuxt 4 / Vue 3), fontkit outlines, vitest. fontTools (repo `.venv`) only to build the fixture once.

**Spec:** `docs/superpowers/specs/2026-08-31-vector-type-smart-stretch-design.md` — sections "Phase B range policy", "Phase B — studio surface", "The laws".

## Global Constraints

- `stretch.ts` stays PURE (no canvas/DOM/fetch). Its existing 87+ tests must stay green through every task: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts` from `frontend/`.
- Dials: `stretch` and `stretchY`, range **0.5–2.5**, step 0.01, default 1. `fit`: `'off' | 'width'`, default `'off'`. Nothing else is exposed: no k, no round coupling, no shape-rules toggle (they are lab-only constants).
- **Range policy (spec, 2026-09-02):** each dial alone ranges 0.5–2.5; when BOTH deviate from 1 the second axis's deviation is damped by `1 − 0.5·min(1, |log S|/log 2)` (symmetrically). Damping applies to the values the ENGINE receives, never to what the user typed. The wdth cascade runs before damping (a real axis is never damped).
- Command count never changes (animation invariant). Baseline stays a fixed point. Vertical stretch never changes advances.
- Every glyph maps the font's alignment zones to the same place — per-glyph stretch (stagger, waves) must go through the same zone-banded Y solve.
- Stage only the files each task names; never `git add -A`; never `git stash`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tests run from `/Users/julien/Documents/GitHub/Sailor/frontend`. Typecheck: `npx nuxi typecheck 2>&1 | grep -E "<file you touched>" || echo "no errors"` — an error naming your types is yours even if the total count matches the baseline.

## Existing interfaces this plan consumes (do not re-implement)

```ts
// lib/vectortype/stretch.ts
export function stretchOutlines(outlines: TextOutlines, S: number, SY: number, opts?: FlexOptions): TextOutlines
export function planStretch(font: VtFont, text: string, axes: Record<string, number>, S: number): { coords: Record<string, number>; residual: number }
export function solveAxis(measure: (v: number) => number, min: number, max: number, target: number): number
export function glyphFlexFor(g: GlyphOutline, opts?: FlexOptions): GlyphFlex
export function buildRemap(profile, S, fixedPoint?, zones?, stemScale?, turnScale?, mode?): Remap
export function remapValue(m: Remap, v: number): number
export function stemFactor(S: number): number
export function stemWidthOf(profile: FlexProfile): number
export const ROUND_COUPLING: number; export const SMALL_FEATURE_EM: number; export const STRAIGHT_MIN_EM: number
// lib/vectortype/outline.ts
export function textOutlines(font: VtFont, text: string, axes?: Record<string, number>): TextOutlines   // has .metrics {xHeight, capHeight, ascent, descent}
// lib/vectortype/canvas.ts
export function vectorTypeFrame(font: VtFont, cfg: VectorTypeConfig, t: number): VtFrame   // line ~268; callers: canvas.ts:1314 (draw), :2242 (SVG), extrudeSolid.ts:339, thumbPreview.ts:230
// lib/vectortype/motion.ts
export function applyMotion(cfg: VectorTypeConfig, t: number): VectorTypeConfig
export function glyphConfig(cfg: VectorTypeConfig, t: number, index: number, count: number): VectorTypeConfig   // per-glyph staggered clock
export function animatableTargets(cfg, axes?): VtAnimatableTarget[]   // every 'slider' control with animatable !== false becomes a target automatically
// lib/vectortype/controls.ts
const slider = (key, label, min, max, step, group, def, hint?, extra?) => VtControl
const select = (key, label, options, def, group, hint?, extra?) => VtControl
export const VT_CONTROLS: VtControl[]   // Layout group: size, tracking, align, skewX, skewY, arc
// lib/vectortype/config.ts
export interface VectorTypeConfig { … skewX: number; skewY: number; arc: number; … }   // DEFAULT_CONFIG at ~755, parse at ~1568 (`skewX: num(o.skewX, d.skewX)`)
// lib/vectortype/trackPresets.ts
function track(path: string, from: number, to: number, over?: Partial<VtMotionTrack>): VtMotionTrack
export interface VtTrackPreset { id; label; pitch; kind: VtLayerKind; minLayers: number; usable: (l) => boolean; requirement: string; build: (ctx: VtTrackPresetContext) => VtMotionTrack[] }
export const VT_TRACK_PRESETS: readonly VtTrackPreset[]
```

Fixture tooling: `../.venv/bin/python -m fontTools.subset` works (the `pyftsubset` script's shebang is stale — do not use it). Real Archivo TTF is served at `http://127.0.0.1:3000/api/fonts/variable?id=archivo` when the dev server runs (658 KB; the subset is 7,956 bytes).

---

### Task 1: The `wdth` fixture + the seam-continuity test

**Files:**
- Create: `frontend/tests/fixtures/archivo-subset-var.ttf` (binary, built by command below)
- Create: `frontend/tests/fixtures/archivo-subset-var.LICENSE.txt`
- Modify: `frontend/tests/unit/vectortype-stretch.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `planStretch`, `stretchOutlines`, `textOutlines`, `normaliseAxes`.
- Produces: fixture font `archivo-subset-var.ttf` (chars " Sailor", axes `wght` 100–900 default 600, `wdth` 62–125 default 100, upm 1000) and a `loadArchivo()` helper other tests may copy.

- [ ] **Step 1: Build the fixture**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend
curl -sL --max-time 30 -o /tmp/archivo.ttf "http://127.0.0.1:3000/api/fonts/variable?id=archivo"
../.venv/bin/python -m fontTools.subset /tmp/archivo.ttf --text=" Sailor" --output-file=tests/fixtures/archivo-subset-var.ttf --notdef-outline --no-hinting
node -e "const fk=require('fontkit');const f=fk.create(require('fs').readFileSync('tests/fixtures/archivo-subset-var.ttf'));console.log(JSON.stringify(f.variationAxes), f.unitsPerEm)"
```
Expected: axes JSON containing `wdth` with min 62 / max 125 and `wght`; upm 1000; file ≈ 8 KB. If the dev server is not running, copy `/tmp/archivo.ttf` from a session that has it or start `./dev.sh` (see repo notes).

- [ ] **Step 2: Write the licence file**

`frontend/tests/fixtures/archivo-subset-var.LICENSE.txt` — copy `inter-subset-var.LICENSE.txt` verbatim (it is the SIL Open Font License 1.1 text) and replace its first copyright line with:
```
Copyright 2019 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)
Subset to the characters " Sailor" with fontTools for Sailor's unit tests; fvar/gvar/HVAR retained.
```

- [ ] **Step 3: Write the failing test**

Append to `frontend/tests/unit/vectortype-stretch.unit.spec.ts`:

```ts
const ARCHIVO = fileURLToPath(new URL('../fixtures/archivo-subset-var.ttf', import.meta.url))
function loadArchivo(): VtFont {
  const bytes = new Uint8Array(readFileSync(ARCHIVO))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'archivo-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}

describe('the wdth cascade seam (Archivo fixture)', () => {
  const archivo = loadArchivo()
  const widthAt = (S: number): number => {
    const plan = planStretch(archivo, 'Sailor', {}, S)
    const run = textOutlines(archivo, 'Sailor', plan.coords)
    return stretchOutlines(run, plan.residual, 1).width
  }

  it('the fixture really carries a wdth axis', () => {
    expect(archivo.axes.some(a => a.tag === 'wdth' && a.min < a.default && a.max > a.default)).toBe(true)
  })

  it('run width is monotone and jump-free across the whole dial, through the axis→remap handoff', () => {
    const natural = widthAt(1)
    let prev = widthAt(0.5)
    let maxStep = 0
    for (let S = 0.51; S <= 2.5 + 1e-9; S += 0.01) {
      const w = widthAt(Number(S.toFixed(2)))
      expect(w).toBeGreaterThanOrEqual(prev - 1e-6)          // monotone
      maxStep = Math.max(maxStep, (w - prev) / natural)
      prev = w
    }
    // one 0.01 dial step never moves the run by more than 1.5% of its natural width
    expect(maxStep).toBeLessThan(0.015)
  })

  it('spends the real axis first: at the axis extremes the residual is 1 and beyond them it grows', () => {
    const wdth = archivo.axes.find(a => a.tag === 'wdth')!
    const atMax = planStretch(archivo, 'Sailor', {}, 1.15)
    expect(atMax.coords.wdth).toBeGreaterThan(wdth.default)
    expect(atMax.residual).toBeCloseTo(1, 2)
    const past = planStretch(archivo, 'Sailor', {}, 2.2)
    expect(past.coords.wdth).toBeCloseTo(wdth.max, 6)
    expect(past.residual).toBeGreaterThan(1.3)
  })
})
```

- [ ] **Step 4: Run to verify the new tests run red-first where expected**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts -t "wdth cascade"`
Expected: the fixture test passes (the file exists); the two behaviour tests may already pass (the cascade shipped in Phase A). If all three pass on first run, that is acceptable for this task — the test's job is to PIN the seam. Confirm by temporarily editing `planStretch` to return `residual: S` unconditionally: the "spends the real axis first" test must go red; revert.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/archivo-subset-var.ttf tests/fixtures/archivo-subset-var.LICENSE.txt tests/unit/vectortype-stretch.unit.spec.ts
git commit -m "test(vectortype): Archivo wdth fixture + seam-continuity test across the axis→remap handoff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Config fields + control declarations (dials, fit)

**Files:**
- Modify: `frontend/app/lib/vectortype/config.ts` (interface ~line 460, DEFAULT_CONFIG ~755, parse ~1568)
- Modify: `frontend/app/lib/vectortype/controls.ts` (Layout group, after `arc`)
- Test: `frontend/tests/unit/vectortype-config.unit.spec.ts` (create if absent — check `ls tests/unit | grep vectortype` first; if a config spec exists, append to it)

**Interfaces:**
- Produces on `VectorTypeConfig`: `stretch: number` (default 1), `stretchY: number` (default 1), `fit: VtFit` where `export type VtFit = 'off' | 'width'` and `export const VT_FITS = ['off', 'width'] as const` (default `'off'`). Constants `export const VT_STRETCH_MIN = 0.5`, `export const VT_STRETCH_MAX = 2.5`.
- Controls: `stretch` slider "Stretch", `stretchY` slider "Height", `fit` select "Fit" — all group `'Layout'`; sliders animatable by default (so `animatableTargets` and `vtAgentControls` pick them up with no further code).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig, VT_STRETCH_MAX, VT_STRETCH_MIN } from '~/lib/vectortype/config'
import { VT_CONTROLS } from '~/lib/vectortype/controls'
import { animatableTargets } from '~/lib/vectortype/motion'

describe('smart stretch config + controls', () => {
  it('defaults to no stretch and fit off', () => {
    expect(DEFAULT_CONFIG.stretch).toBe(1)
    expect(DEFAULT_CONFIG.stretchY).toBe(1)
    expect(DEFAULT_CONFIG.fit).toBe('off')
  })

  it('parses and clamps persisted values; unknown fit falls back to off', () => {
    const c = mergeConfig({ stretch: 9, stretchY: 0.1, fit: 'height' } as any)
    expect(c.stretch).toBe(VT_STRETCH_MAX)
    expect(c.stretchY).toBe(VT_STRETCH_MIN)
    expect(c.fit).toBe('off')
    const d = mergeConfig({ stretch: 1.6, fit: 'width' } as any)
    expect(d.stretch).toBeCloseTo(1.6, 9)
    expect(d.fit).toBe('width')
  })

  it('declares the two dials and the fit select in the Layout group, nothing lab-only', () => {
    const keys = VT_CONTROLS.map(c => c.key)
    expect(keys).toContain('stretch'); expect(keys).toContain('stretchY'); expect(keys).toContain('fit')
    for (const k of ['k', 'roundCoupling', 'shapeRules']) expect(keys).not.toContain(k)
    const s = VT_CONTROLS.find(c => c.key === 'stretch') as any
    expect(s.group).toBe('Layout'); expect(s.min).toBe(VT_STRETCH_MIN); expect(s.max).toBe(VT_STRETCH_MAX); expect(s.step).toBe(0.01)
    const f = VT_CONTROLS.find(c => c.key === 'fit') as any
    expect(f.kind).toBe('select'); expect(f.options).toEqual(['off', 'width'])
  })

  it('the dials are motion targets; fit is not', () => {
    const paths = animatableTargets(DEFAULT_CONFIG, []).map(t => t.path)
    expect(paths).toContain('stretch'); expect(paths).toContain('stretchY')
    expect(paths).not.toContain('fit')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/vectortype-config.unit.spec.ts`
Expected: FAIL — `DEFAULT_CONFIG.stretch` undefined / `VT_STRETCH_MAX` not exported.

- [ ] **Step 3: Implement config**

In `config.ts`, next to `VT_SKEW_MAX`:
```ts
/** The dials' range. Each axis alone is proven to 0.5–2.5 in the lab; the
 *  studio damps the SECOND axis when both deviate (see `dampedStretch`). */
export const VT_STRETCH_MIN = 0.5
export const VT_STRETCH_MAX = 2.5
export const VT_FITS = ['off', 'width'] as const
export type VtFit = (typeof VT_FITS)[number]
```
In the `VectorTypeConfig` interface, after `arc: number`:
```ts
  /**
   * Typographic stretch of the run — width (`stretch`) and height (`stretchY`),
   * 1 = as drawn. NOT a scale: white space stretches, ink doesn't (stems and
   * crossbars keep their weight, counters take the change, rounds flatten
   * like a real Extended cut). Spends a real `wdth` axis first when the font
   * has one. Per glyph under a staggered track — a wave of width or height —
   * on the same alignment zones, so the x-height never scatters.
   */
  stretch: number
  stretchY: number
  /** `'width'` solves `stretch` so the run fills the output box (minus a small
   *  margin); the dial shows the solved value and goes read-only. */
  fit: VtFit
```
In `DEFAULT_CONFIG` after `arc: 0,`:
```ts
  // As drawn. `stretchOutlines` returns the outlines untouched at (1, 1), so a
  // config that never touched the dials renders byte-identically.
  stretch: 1,
  stretchY: 1,
  fit: 'off',
```
In the parse block next to `skewX: num(o.skewX, d.skewX)`:
```ts
    stretch: clamp(num(o.stretch, d.stretch), VT_STRETCH_MIN, VT_STRETCH_MAX),
    stretchY: clamp(num(o.stretchY, d.stretchY), VT_STRETCH_MIN, VT_STRETCH_MAX),
    fit: oneOf(o.fit, VT_FITS, d.fit),
```
(`num`, `oneOf` and `clamp` already exist at config.ts ~840–846 — reuse them, add nothing.)

- [ ] **Step 4: Implement controls**

In `controls.ts`, in the Layout section after the `arc` slider:
```ts
  // ── STRETCH — typographic, not geometric ────────────────────────────────────
  // The whole point of Phase A: white space stretches, ink doesn't. The hint says
  // what the dial is NOT (a scale) because `scaleX`/`scaleY` motion exists and
  // does the cartoon thing; a user reaching for "wider letters" must land here.
  slider('stretch', 'Stretch', VT_STRETCH_MIN, VT_STRETCH_MAX, 0.01, 'Layout', DEFAULT_CONFIG.stretch,
    'Widens or condenses the LETTERS the way a type designer would draw a wider or narrower cut: counters and spacing take the change, stems keep their weight, rounds flatten their sides. Uses the font’s own Width axis first when it has one. Not a scale — for cartoon squash use the scale motion instead.'),
  slider('stretchY', 'Height', VT_STRETCH_MIN, VT_STRETCH_MAX, 0.01, 'Layout', DEFAULT_CONFIG.stretchY,
    'Makes the letters taller or squatter typographically: stems lengthen, arches and crossbars keep their thickness, every letter keeps the same x-height and cap height. Animate it per glyph for letters that spring up off the baseline.'),
  select('fit', 'Fit', [...VT_FITS], DEFAULT_CONFIG.fit, 'Layout',
    'width: solves Stretch so the run fills the output width (minus a small margin) — the Stretch dial shows the solved value and follows the text. off: Stretch is yours.',
    { animatable: false }),
```
Import `VT_FITS`, `VT_STRETCH_MIN`, `VT_STRETCH_MAX` from `./config`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/unit/vectortype-config.unit.spec.ts tests/unit/vectortype-stretch.unit.spec.ts`
Expected: PASS. Then `npx nuxi typecheck 2>&1 | grep -E "vectortype/(config|controls)" || echo "no errors"` → `no errors`.

- [ ] **Step 6: Commit**

```bash
git add app/lib/vectortype/config.ts app/lib/vectortype/controls.ts tests/unit/vectortype-config.unit.spec.ts
git commit -m "feat(vectortype): stretch/height dials + fit select in the schema (motion targets and agent controls derive)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Engine entry points for the studio — `stretchGlyph`, `dampedStretch`, `fitStretch`

**Files:**
- Modify: `frontend/app/lib/vectortype/stretch.ts` (refactor `stretchOutlines`'s loop body into `stretchGlyph`; add `dampedStretch`, `fitStretch`)
- Modify: `frontend/tests/unit/vectortype-stretch.unit.spec.ts` (append)

**Interfaces (produces):**
```ts
export interface StretchContext { metrics: TextOutlines['metrics']; unitsPerEm: number; opts?: FlexOptions }
export interface StretchedGlyph { commands: PathCommand[]; bbox: VtBBox; advance: number }
/** One glyph at its own (S, SY). Zones come from ctx.metrics so per-glyph values still align. */
export function stretchGlyph(g: GlyphOutline, S: number, SY: number, ctx: StretchContext): StretchedGlyph
/** The range policy: damp the SECOND axis when both deviate from 1. Symmetric; identity when either is 1. */
export function dampedStretch(S: number, SY: number): { S: number; SY: number; damped: boolean }
/** Solve the width dial so the run's width (font units) hits `targetUnits` within [min,max]. */
export function fitStretch(font: VtFont, text: string, axes: Record<string, number>, targetUnits: number, min?: number, max?: number): number
```

- [ ] **Step 1: Write the failing tests**

```ts
import { dampedStretch, fitStretch, stretchGlyph } from '~/lib/vectortype/stretch'

describe('studio entry points', () => {
  it('stretchGlyph reproduces stretchOutlines glyph-for-glyph (same S/SY everywhere)', () => {
    const run = textOutlines(font, 'Sailor')
    const whole = stretchOutlines(run, 1.6, 1.3)
    const ctx = { metrics: run.metrics, unitsPerEm: run.unitsPerEm }
    run.glyphs.forEach((g, i) => {
      const one = stretchGlyph(g, 1.6, 1.3, ctx)
      expect(one.commands).toEqual(whole.glyphs[i]!.commands)
      expect(one.advance).toBeCloseTo(whole.glyphs[i]!.advance, 6)
      expect(one.bbox).toEqual(whole.glyphs[i]!.bbox)
    })
  })

  it('stretchGlyph keeps the x-height shared across glyphs at different SY (zones from metrics)', () => {
    const run = textOutlines(font, 'ai')
    const ctx = { metrics: run.metrics, unitsPerEm: run.unitsPerEm }
    const a = stretchGlyph(run.glyphs[0]!, 1, 2.0, ctx)
    const i = stretchGlyph(run.glyphs[1]!, 1, 2.0, ctx)
    // both land their x-height band at 2.0 × xHeight: the a's top ≈ 2 × its drawn top (overshoot excluded)
    expect(Math.abs(a.bbox.maxY - 2 * run.glyphs[0]!.bbox.maxY)).toBeLessThan(0.03 * 2 * run.metrics.xHeight)
    expect(i.advance).toBeCloseTo(run.glyphs[1]!.advance, 6)   // vertical never changes advances
  })

  it('dampedStretch: identity when one axis is 1; damps the second when both deviate; symmetric', () => {
    expect(dampedStretch(1.8, 1)).toEqual({ S: 1.8, SY: 1, damped: false })
    expect(dampedStretch(1, 0.6)).toEqual({ S: 1, SY: 0.6, damped: false })
    const d = dampedStretch(2, 2)                       // |log 2|/log 2 = 1 → factor 0.5 on the deviation
    expect(d.damped).toBe(true)
    expect(d.S).toBeCloseTo(1.5, 9)                     // 1 + (2 − 1) · 0.5
    expect(d.SY).toBeCloseTo(1.5, 9)
    const e = dampedStretch(0.5, 2.5)
    expect(e.S).toBeGreaterThan(0.5); expect(e.SY).toBeLessThan(2.5)
    const f = dampedStretch(1.3, 1.1)                   // small moves damp a little
    expect(f.S).toBeLessThan(1.3); expect(f.S).toBeGreaterThan(1.25)
  })

  it('fitStretch lands the run on a target width (through the axis on Archivo, remap on Inter)', () => {
    const run = textOutlines(font, 'Sailor')
    const target = run.width * 1.35
    const S = fitStretch(font, 'Sailor', {}, target)
    const plan = planStretch(font, 'Sailor', {}, S)
    const got = stretchOutlines(textOutlines(font, 'Sailor', plan.coords), plan.residual, 1).width
    expect(Math.abs(got - target) / target).toBeLessThan(0.01)
    const archivo = loadArchivo()
    const arun = textOutlines(archivo, 'Sailor')
    const atarget = arun.width * 0.8
    const aS = fitStretch(archivo, 'Sailor', {}, atarget)
    const aplan = planStretch(archivo, 'Sailor', {}, aS)
    const agot = stretchOutlines(textOutlines(archivo, 'Sailor', aplan.coords), aplan.residual, 1).width
    expect(Math.abs(agot - atarget) / atarget).toBeLessThan(0.01)
    // clamps to the dial range rather than chasing an unreachable target
    expect(fitStretch(font, 'Sailor', {}, run.width * 10)).toBe(2.5)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts -t "studio entry points"`
Expected: FAIL — `stretchGlyph` is not exported.

- [ ] **Step 3: Implement**

In `stretch.ts`:

```ts
export interface StretchContext {
  metrics: TextOutlines['metrics']
  unitsPerEm: number
  opts?: FlexOptions
}
export interface StretchedGlyph {
  commands: PathCommand[]
  bbox: VtBBox
  advance: number
}

/**
 * One glyph at its own (S, SY) — the studio's per-glyph entry point, so a
 * staggered `stretch`/`stretchY` track becomes a travelling wave of width or
 * height. The zones come from the FONT (ctx.metrics), not the glyph, so glyphs
 * at different SY still land their x-height on the same line for the same SY.
 * `stretchOutlines` is this, glyph by glyph, plus the pen.
 */
export function stretchGlyph(g: GlyphOutline, S: number, SY: number, ctx: StretchContext): StretchedGlyph {
  const flexOpts: FlexOptions = {
    smallFeature: SMALL_FEATURE_EM * ctx.unitsPerEm,
    straightMin: STRAIGHT_MIN_EM * ctx.unitsPerEm,
    ...(ctx.opts ?? {}),
  }
  // A blank glyph (space) is pure whitespace: its advance scales with S and
  // nothing else happens — exactly what the run loop did before this refactor.
  if (!hasInk(g)) return { commands: g.commands, bbox: g.bbox, advance: g.advance * S }
  if (S === 1 && SY === 1) return { commands: g.commands, bbox: g.bbox, advance: g.advance }
  const m = ctx.metrics
  const zones = [0, m.xHeight, m.capHeight, m.ascent, m.descent]
  const stemScale = stemFactor(S * SY)
  const roundCoupling = flexOpts.roundCoupling ?? ROUND_COUPLING
  const turnScaleY = Math.pow(S, roundCoupling)
  const mode: DistributionMode = flexOpts.shapeRules === false ? 'flex' : 'bell'
  const flex = glyphFlexFor(g, flexOpts)
  const rx = buildRemap(flex.x, S, undefined, undefined, stemScale, undefined, mode)
  const ry = buildRemap(flex.y, SY, 0, zones, stemScale, turnScaleY, mode)
  const commands = applyRemaps(g.commands, rx, ry)
  const bbox = {
    minX: remapValue(rx, g.bbox.minX), maxX: remapValue(rx, g.bbox.maxX),
    minY: remapValue(ry, g.bbox.minY), maxY: remapValue(ry, g.bbox.maxY),
  }
  const inkW = g.bbox.maxX - g.bbox.minX
  const newInkW = bbox.maxX - bbox.minX
  const whitespace = g.advance - inkW
  let advance: number
  if (S < 1 && whitespace > 0) {
    const stemRef = stemWidthOf(flex.x) || 0.09 * ctx.unitsPerEm
    advance = newInkW + Math.max(whitespace * S, Math.min(whitespace, WHITESPACE_FLOOR_STEMS * stemRef))
  } else {
    advance = newInkW + whitespace * S
  }
  return { commands, bbox, advance }
}
```
Then make `stretchOutlines` call it: its loop body (stretch.ts ~1985–2015: the `hasInk` branch computing flex/rx/ry/commands/bbox/inkW/newInkW, and the whitespace/advance block) collapses to
```ts
    const sg = stretchGlyph(g, S, SY, { metrics: outlines.metrics, unitsPerEm: outlines.unitsPerEm, opts })
    const { commands, bbox, advance } = sg
```
Keep the pen/offset (`(g.x - penOld) * S`), the bbox union and the `penOld/penNew` accumulation exactly as they are; the `zones`/`stemScale`/`turnScaleY`/`mode`/`flexOpts` locals move into `stretchGlyph` (delete them from `stretchOutlines`, keep its `if (S === 1 && SY === 1) return outlines` fast path). Check: a blank glyph's old advance was `0 + (g.advance − 0) × S` = `g.advance × S` — the early return above matches.

```ts
/**
 * The Phase B range policy: each dial alone is proven to its full range; the
 * engine is weak on DIAGONAL moves through the (S, SY) plane. When both
 * deviate from 1, the second axis's deviation is damped by
 * 1 − 0.5·min(1, |log S|/log 2), symmetrically — a strongly condensed letter
 * can still grow taller, but not to the frontier the slices cannot hold.
 * Applied to what the ENGINE receives; the dials keep what the user typed.
 */
export function dampedStretch(S: number, SY: number): { S: number; SY: number; damped: boolean } {
  const dev = (v: number) => Math.min(1, Math.abs(Math.log(v)) / Math.LN2)
  if (S === 1 || SY === 1) return { S, SY, damped: false }
  const fS = 1 - 0.5 * dev(SY)   // how much S keeps, given SY's deviation
  const fSY = 1 - 0.5 * dev(S)
  return { S: 1 + (S - 1) * fS, SY: 1 + (SY - 1) * fSY, damped: true }
}

/** Solve the width dial so the shaped run (axis cascade + remap) is `targetUnits` wide. */
export function fitStretch(
  font: VtFont, text: string, axes: Record<string, number>, targetUnits: number,
  min = 0.5, max = 2.5,
): number {
  if (!text || !(targetUnits > 0)) return 1
  const measure = (S: number): number => {
    const plan = planStretch(font, text, axes, S)
    return stretchOutlines(textOutlines(font, text, plan.coords), plan.residual, 1).width
  }
  return solveAxis(measure, min, max, targetUnits)
}
```
Check the `dampedStretch(2, 2)` expectation by hand: dev(2) = 1 → f = 0.5 → S = 1 + 1·0.5 = 1.5 ✓. `dampedStretch(1.3, 1.1)`: dev(1.1) = 0.1375 → fS = 0.931 → S = 1.279 ✓ (between 1.25 and 1.3).

- [ ] **Step 4: Run the WHOLE stretch spec**

Run: `npx vitest run tests/unit/vectortype-stretch.unit.spec.ts`
Expected: all green — the refactor must not change a single existing assertion (they all go through `stretchOutlines`).

- [ ] **Step 5: Commit**

```bash
git add app/lib/vectortype/stretch.ts tests/unit/vectortype-stretch.unit.spec.ts
git commit -m "feat(vectortype): stretchGlyph (per-glyph, shared zones), dampedStretch (range policy), fitStretch (solver)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Stretch enters the frame (`vectorTypeFrame`) — per glyph, cascade, damping, fit

**Files:**
- Modify: `frontend/app/lib/vectortype/canvas.ts` (`vectorTypeFrame` ~268–370; its two internal callers ~1314 and ~2242)
- Test: `frontend/tests/unit/vectortype-frame-stretch.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `stretchGlyph`, `dampedStretch`, `fitStretch`, `planStretch` (Task 3), `glyphConfig`, `applyMotion`.
- Produces: `export interface VtFrameOptions { fitBoxWidth?: number }` (the box's available width in OUTPUT px, padding already removed), `export const VT_FIT_INSET = 0.02` (the "small margin": 2% of the box each side), and `vectorTypeFrame(font, cfg, t, frameOpts?: VtFrameOptions)`. `VtFrame` gains `stretch: { S: number; SY: number; damped: boolean; fitted: number | null; perGlyph: boolean }` (what the frame actually applied — for the surface's read-only dial and for tests to ASSERT the path ran).

- [ ] **Step 1: Write the failing tests**

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { vectorTypeFrame, VT_FIT_INSET } from '~/lib/vectortype/canvas'
import { DEFAULT_CONFIG, mergeConfig } from '~/lib/vectortype/config'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const raw: any = (fontkit as any).create(new Uint8Array(readFileSync(FIXTURE)))
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()
const cfg = (over: Partial<typeof DEFAULT_CONFIG>) => mergeConfig({ ...DEFAULT_CONFIG, text: 'Sailor', ...over } as any)
const width = (f: ReturnType<typeof vectorTypeFrame>) => f.outlines.width
const commandCount = (f: ReturnType<typeof vectorTypeFrame>) => f.outlines.glyphs.reduce((n, g) => n + g.commands.length, 0)

describe('vectorTypeFrame — smart stretch', () => {
  it('stretch = 1 leaves the frame byte-identical to before', () => {
    const a = vectorTypeFrame(font, cfg({}), 0)
    expect(a.stretch).toEqual({ S: 1, SY: 1, damped: false, fitted: null, perGlyph: false })
    const b = vectorTypeFrame(font, cfg({ stretch: 1, stretchY: 1 }), 0)
    expect(b.outlines.glyphs.map(g => g.commands)).toEqual(a.outlines.glyphs.map(g => g.commands))
  })

  it('stretch widens the run, holds the l stem, keeps the command count', () => {
    const base = vectorTypeFrame(font, cfg({}), 0)
    const wide = vectorTypeFrame(font, cfg({ stretch: 1.8 }), 0)
    expect(width(wide)).toBeGreaterThan(width(base) * 1.3)
    expect(commandCount(wide)).toBe(commandCount(base))
    const l0 = base.outlines.glyphs[3]!, l1 = wide.outlines.glyphs[3]!   // 'S','a','i','l'
    expect(Math.abs((l1.bbox.maxX - l1.bbox.minX) - (l0.bbox.maxX - l0.bbox.minX))).toBeLessThan(0.05 * (l0.bbox.maxX - l0.bbox.minX))
    expect(wide.stretch.S).toBeCloseTo(1.8, 9)
  })

  it('height grows glyphs on a fixed baseline and never changes advances', () => {
    const base = vectorTypeFrame(font, cfg({}), 0)
    const tall = vectorTypeFrame(font, cfg({ stretchY: 2 }), 0)
    expect(width(tall)).toBeCloseTo(width(base), 3)
    expect(tall.outlines.bbox.maxY).toBeGreaterThan(base.outlines.bbox.maxY * 1.8)
    expect(tall.outlines.glyphs[3]!.bbox.minY).toBeCloseTo(base.outlines.glyphs[3]!.bbox.minY, 3)
  })

  it('a diagonal move is damped for the engine, and the frame says so', () => {
    const f = vectorTypeFrame(font, cfg({ stretch: 2, stretchY: 2 }), 0)
    expect(f.stretch.damped).toBe(true)
    expect(f.stretch.S).toBeCloseTo(1.5, 9)
    expect(f.stretch.SY).toBeCloseTo(1.5, 9)
  })

  it('a staggered stretch track gives each glyph its own width (perGlyph path)', () => {
    const c = cfg({
      motion: {
        ...DEFAULT_CONFIG.motion,
        tracks: [{ path: 'stretch', from: 1, to: 1.8, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }],
        stagger: { ...DEFAULT_CONFIG.motion.stagger, delay: 0.8 },
      },
    } as any)
    const f = vectorTypeFrame(font, c, 0.5)
    expect(f.stretch.perGlyph).toBe(true)
    const widths = f.outlines.glyphs.filter(g => g.commands.length).map(g => g.bbox.maxX - g.bbox.minX)
    const base = vectorTypeFrame(font, cfg({}), 0).outlines.glyphs.filter(g => g.commands.length).map(g => g.bbox.maxX - g.bbox.minX)
    const ratios = widths.map((w, i) => w / base[i]!)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.1)   // the wave
  })

  it('fit: width solves stretch so the run fills the box (minus the inset), reported as fitted', () => {
    const c = cfg({ fit: 'width' })
    const base = vectorTypeFrame(font, cfg({}), 0)
    const pxPerUnit = c.size / base.outlines.unitsPerEm
    const targetUnits = base.outlines.width * 1.3
    const fitBoxWidth = (targetUnits * pxPerUnit) / (1 - 2 * VT_FIT_INSET)   // the box that leaves exactly targetUnits after the inset
    const f = vectorTypeFrame(font, c, 0, { fitBoxWidth })
    expect(f.stretch.fitted).not.toBeNull()
    expect(Math.abs(f.outlines.width - targetUnits) / targetUnits).toBeLessThan(0.02)
    // without a box width, fit is inert and the dial value rules
    const g = vectorTypeFrame(font, cfg({ fit: 'width', stretch: 1.2 }), 0)
    expect(g.stretch.fitted).toBeNull(); expect(g.stretch.S).toBeCloseTo(1.2, 9)
  })
})
```
(`motion.tracks: VtMotionTrack[]` and `motion.stagger: VtStaggerConfig {delay, order, seed}` are the real shapes — config.ts ~336–351; `resolveStagger(cfg)` in the frame reads `delay`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/vectortype-frame-stretch.unit.spec.ts`
Expected: FAIL — `frame.stretch` undefined; widths equal.

- [ ] **Step 3: Implement in `vectorTypeFrame`**

Add near the top of canvas.ts imports: `import { dampedStretch, fitStretch, planStretch, stretchGlyph } from './stretch'`.

Add the option type and the frame field:
```ts
/** The "small margin" fit leaves on each side of the box: 2% of its width. */
export const VT_FIT_INSET = 0.02

export interface VtFrameOptions {
  /** The box's available width in OUTPUT px (padding already removed) — the
   *  fit target. Only the two callers that own a box pass it; a frame asked
   *  for without it treats `fit` as inert and renders the dial value. */
  fitBoxWidth?: number
}
```
and on `VtFrame`: `stretch: { S: number; SY: number; damped: boolean; fitted: number | null; perGlyph: boolean }`.

Change the signature: `export function vectorTypeFrame(font: VtFont, cfg: VectorTypeConfig, t: number, frameOpts: VtFrameOptions = {}): VtFrame`.

Inside, right after `const base = applyMotion(cfg, t)`:
```ts
  // ── SMART STRETCH: resolve the run-level dials ONCE ────────────────────────
  // Fit solves the width dial against the box the caller owns; a config whose
  // fit is on but whose caller passed no box (thumbnails, solids) falls back
  // to the dial value — inert, never wrong.
  let dialS = base.stretch
  let fitted: number | null = null
  const fitBox = frameOpts.fitBoxWidth
  if (base.fit === 'width' && typeof fitBox === 'number' && fitBox > 0 && base.size > 0) {
    // Same px↔unit line `vtPlacement` uses (`config.size / upem`, on the
    // post-motion config), so a fitted run lands where placement expects it.
    const targetUnits = (fitBox * (1 - 2 * VT_FIT_INSET)) / (base.size / upem)
    fitted = fitStretch(font, base.text, base.axes, targetUnits)
    dialS = fitted
  }
  // The wdth cascade spends the real axis before geometry and before damping:
  // a designer-drawn width is never damped.
  const plan = planStretch(font, base.text, base.axes, dialS)
  const runDamped = dampedStretch(plan.residual, base.stretchY)
```
Then the shaping must use `plan.coords` instead of `base.axes` for the shared shaping: replace `const shaped = textOutlines(font, base.text, base.axes)` with `const shaped = textOutlines(font, base.text, plan.coords)`, and in the per-glyph loop resting axes `base.axes` → `plan.coords` (the resting position now includes the spent wdth; an axis track on `wdth` still composes through `vtAxisCoords` as before).

After the `source` array is built and BEFORE the pen re-accumulation loop, apply stretch per glyph:
```ts
  // ── SMART STRETCH: per glyph, on the font's shared zones ───────────────────
  // A staggered `stretch`/`stretchY` track gives each glyph its own clock, so
  // each reads its own dial values; otherwise every glyph takes the run's.
  // Per-glyph residuals reuse the RUN's wdth plan (the axis is spent once);
  // the glyph's own dial is scaled by the same residual/dial ratio so a wave
  // on a wdth font still travels through the remap consistently.
  const stretchCtx = { metrics: shaped.metrics, unitsPerEm: upem }
  const ratio = dialS !== 0 ? plan.residual / dialS : 1
  let perGlyphStretch = false
  const stretched: GlyphOutline[] = source.map((g, i) => {
    let S = runDamped.S, SY = runDamped.SY
    if (staggered) {
      const gc = glyphConfig(cfg, t, i, n)
      const own = dampedStretch(gc.stretch * ratio, gc.stretchY)
      if (own.S !== S || own.SY !== SY) perGlyphStretch = true
      S = own.S; SY = own.SY
    }
    if (S === 1 && SY === 1) return g
    const sg = stretchGlyph(g, S, SY, stretchCtx)
    return { ...g, commands: sg.commands, bbox: sg.bbox, advance: sg.advance }
  })
```
and use `stretched` (not `source`) in the pen loop. Add to the returned frame:
```ts
    stretch: { S: runDamped.S, SY: runDamped.SY, damped: runDamped.damped, fitted, perGlyph: perGlyphStretch },
```
For `fitted`: if `fit` is on, the surface shows the dial read-only at `fitted` (Task 6); the value stored in `cfg.stretch` is not overwritten by the frame (pure function).

Check `shaped.metrics` exists on `TextOutlines` (it does since Phase A's zones task) — if `vectorTypeFrame` constructs its own `outlines` object literal at the end, ADD `metrics: shaped.metrics` to it so downstream consumers (extrude solid, SVG) carry it.

Callers: `drawVectorType` (canvas.ts ~1314) and `vectorTypeSVG` (~2242) both own a `VtBoxOptions` (`width`, `height`, `padding?`) — the same box `vtPlacement` reads (`availW = opts.width − 2·pad`). Each passes it:
```ts
  const frame = vectorTypeFrame(font, cfg, t, { fitBoxWidth: Math.max(0, opts.width - 2 * (opts.padding ?? 0)) })
```
extrudeSolid.ts and thumbPreview.ts keep calling `vectorTypeFrame(font, cfg, t)` — fit is inert there by design (a solid or a thumbnail has no box the user is fitting to).

- [ ] **Step 4: Run the new spec + every vectortype spec**

Run: `npx vitest run tests/unit/vectortype-frame-stretch.unit.spec.ts` then `npx vitest run tests/unit/ -t vectortype` (or the vectortype file glob) — everything must stay green: the "stretch = 1 byte-identical" guarantee is what protects every existing golden. Typecheck: `npx nuxi typecheck 2>&1 | grep -E "vectortype/canvas" || echo "no errors"`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/vectortype/canvas.ts tests/unit/vectortype-frame-stretch.unit.spec.ts
git commit -m "feat(vectortype): smart stretch enters the frame — per-glyph on shared zones, wdth cascade first, range damping, fit-to-width

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Motion presets — Stretch In, Stretch Wave, Spring Up

**Files:**
- Modify: `frontend/app/lib/vectortype/trackPresets.ts` (type at ~line 93, `PRESETS` array ~175–255)
- Test: `frontend/tests/unit/vectortype-stretch-presets.unit.spec.ts` (create — the existing `vectortype-track-presets.unit.spec.ts` rasterises with resvg and is slow; keep this one pure)

**Interfaces:**
- `VtTrackPreset.kind` widens to `VtLayerKind | 'run'`; a `'run'` preset has `minLayers: 0`, `usable: () => true`, `requirement: ''`. The offer builder `vtTrackPresetOffer` (trackPresets.ts ~296) needs NO change: `addressable` never matches a `'run'` kind, so `layers = []`, and `0 >= minLayers (0)` makes it available — `vtApplyTrackPreset` then calls `build({ layers: [], duration })`. Pin this with a test rather than trusting it.
- Three presets, ids `stretch-in`, `stretch-wave`, `spring-up`, paths `stretch` / `stretch` / `stretchY`. Easing vocabulary is `VtEasing = 'linear' | 'pingpong' | 'easeinout'` (config.ts:258) — nothing else exists.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '~/lib/vectortype/config'
import { VT_TRACK_PRESETS, vtApplyTrackPreset, vtTrackPresetOffers } from '~/lib/vectortype/trackPresets'

describe('stretch motion presets', () => {
  const byId = (id: string) => VT_TRACK_PRESETS.find(p => p.id === id)!
  it('declares the three run-level presets', () => {
    for (const id of ['stretch-in', 'stretch-wave', 'spring-up']) {
      const p = byId(id)
      expect(p).toBeDefined(); expect(p.kind).toBe('run'); expect(p.minLayers).toBe(0)
    }
  })
  it('Stretch In lands on the dial value (an entrance ends still)', () => {
    const tr = byId('stretch-in').build({ layers: [], duration: 2 })
    expect(tr).toHaveLength(1)
    expect(tr[0]!.path).toBe('stretch'); expect(tr[0]!.to).toBe(1); expect(tr[0]!.from).toBeGreaterThan(1)
    expect(tr[0]!.easing).toBe('easeinout')
  })
  it('Stretch Wave ping-pongs around 1, bounded to the proven single-axis range', () => {
    const tr = byId('stretch-wave').build({ layers: [], duration: 2 })
    expect(tr[0]!.path).toBe('stretch'); expect(tr[0]!.easing).toBe('pingpong'); expect(tr[0]!.loops).toBeGreaterThanOrEqual(2)
    expect(Math.min(tr[0]!.from, tr[0]!.to)).toBeGreaterThanOrEqual(0.8)
    expect(Math.max(tr[0]!.from, tr[0]!.to)).toBeLessThanOrEqual(1.3)
  })
  it('Spring Up is a height entrance that settles to 1', () => {
    const tr = byId('spring-up').build({ layers: [], duration: 2 })
    expect(tr[0]!.path).toBe('stretchY'); expect(tr[0]!.from).toBeGreaterThan(1.4); expect(tr[0]!.to).toBe(1)
  })
  it('each preset moves ONE dial and leaves the other at 1 (range policy)', () => {
    for (const id of ['stretch-in', 'stretch-wave', 'spring-up']) {
      const paths = new Set(byId(id).build({ layers: [], duration: 2 }).map(t => t.path))
      expect(paths.has('stretch') && paths.has('stretchY')).toBe(false)
    }
  })
  it('run-level presets are offered and applicable with an EMPTY appearance stack', () => {
    const cfg = { ...DEFAULT_CONFIG, appearance: [] } as any
    const offers = vtTrackPresetOffers(cfg)
    for (const id of ['stretch-in', 'stretch-wave', 'spring-up']) {
      const o = offers.find(x => x.preset.id === id)!
      expect(o.available).toBe(true); expect(o.reason).toBeUndefined()
      const tracks = vtApplyTrackPreset(cfg, id)
      expect(tracks.some(t => t.path === 'stretch' || t.path === 'stretchY')).toBe(true)
    }
  })
})
```
- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/vectortype-stretch-presets.unit.spec.ts`
Expected: FAIL — `byId('stretch-in')` is undefined.

- [ ] **Step 3: Implement**

In `trackPresets.ts`, widen the type and add the presets to `PRESETS` (before the `Object.freeze`):
```ts
export interface VtTrackPreset {
  …
  /** THE DECLARATION — the layer kind this preset cannot run without, or
   *  'run' for a preset on a RUN-LEVEL dial (stretch, height) that needs no
   *  layer at all and is always offered. */
  kind: VtLayerKind | 'run'
  …
}

const RUN = { kind: 'run' as const, minLayers: 0, usable: () => true, requirement: '' }

  // ── Smart stretch — run-level, no layer needed ─────────────────────────────
  // All three stay inside the proven SINGLE-AXIS regime (Phase B range
  // policy): each moves one dial and leaves the other at 1.
  {
    id: 'stretch-in', label: 'Stretch In', pitch: 'Lands wide and settles to its drawn width', ...RUN,
    // An ENTRANCE ends still: `to` is exactly 1, the dial value, so the word
    // is left as the user set it. Starts at 1.6 — an extended cut, not a smear.
    build: () => [track('stretch', 1.6, 1, { easing: 'easeinout' })],
  },
  {
    id: 'stretch-wave', label: 'Stretch Wave', pitch: 'A crest of width travels through the word', ...RUN,
    // A LOOP about 1 within ±15%: wide enough to read, inside the range the
    // engine holds. The travel comes from the stagger — with delay 0 the whole
    // word breathes together, which is the honest fallback, not a bug.
    build: () => [track('stretch', 0.88, 1.15, { easing: 'pingpong', loops: 2 })],
  },
  {
    id: 'spring-up', label: 'Spring Up', pitch: 'Letters land tall off the baseline and settle', ...RUN,
    // Height only — the baseline is the fixed point of the vertical remap, so
    // this reads as letters springing UP, not smearing about their centres.
    build: () => [track('stretchY', 1.8, 1, { easing: 'easeinout' })],
  },
```
`vtTrackPresetOffer` compiles unchanged after the type widening? Check the one place it reads `preset.kind` for the reason sentence (`enabled.filter(l => l?.kind === preset.kind)`) — a `VtLayerKind | 'run'` compares fine against `VtLayerKind`. If TypeScript objects, narrow with `preset.kind !== 'run' && l?.kind === preset.kind`. The `addressable` helper compares the same way.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/unit/vectortype-stretch-presets.unit.spec.ts tests/unit/vectortype-offered-presets.unit.spec.ts tests/unit/vectortype-track-presets.unit.spec.ts` (the last is slow — resvg — but it is the one that would catch a broken offer). Typecheck grep `trackPresets`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/vectortype/trackPresets.ts tests/unit/vectortype-stretch-presets.unit.spec.ts
git commit -m "feat(vectortype): Stretch In / Stretch Wave / Spring Up — run-level motion presets on the stretch dials

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Studio surface — fit read-only dial, the "eased" hint, agent guidance

**Files:**
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue` (where the panel renders Layout controls; where `drawVectorTypeToCanvas` returns the frame ~line 1081)
- Modify: `frontend/app/lib/vectortype/controls.ts` (`VT_GUIDANCE`)
- Test: `frontend/tests/unit/vectortype-agent-guidance.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `frame.stretch` (Task 4) — `drawVectorTypeToCanvas` already returns the frame to the surface ("it is what the renderer ACTUALLY decided").
- Produces: when `config.fit === 'width'`, the Stretch row shows the solved value and is read-only; when `frame.stretch.damped`, a small hint "eased" appears under the Layout group; `VT_GUIDANCE` gains the stretch paragraph.

- [ ] **Step 1: Write the failing test (guidance is testable; the surface is verified in Task 7)**

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '~/lib/vectortype/config'
import { vtAgentControls } from '~/lib/vectortype/agentControls'
import { VT_GUIDANCE } from '~/lib/vectortype/controls'

describe('smart stretch — agent surface', () => {
  it('the agent sees stretch, height and fit with their hints', () => {
    const keys = vtAgentControls(DEFAULT_CONFIG, []).map(c => c.key)
    expect(keys).toContain('stretch'); expect(keys).toContain('stretchY'); expect(keys).toContain('fit')
  })
  it('guidance teaches the stretch-vs-scale distinction and the single-axis habit', () => {
    expect(VT_GUIDANCE).toMatch(/stretch/i)
    expect(VT_GUIDANCE).toMatch(/scaleX|scale motion|squash/i)
    expect(VT_GUIDANCE).toMatch(/one (dial|axis) at a time|single-axis|one axis/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts` — the first test may already pass (Task 2 made them visible controls); the guidance test fails.

- [ ] **Step 3: Implement guidance**

In `controls.ts`, append to `VT_GUIDANCE` (find the existing template string; add a paragraph):
```ts
STRETCH IS TYPOGRAPHIC, NOT A SCALE. \`stretch\` (width) and \`stretchY\` (height) redraw the word the way a designer draws a wider, narrower, taller or squatter cut: counters and spacing take the change, stems and crossbars keep their weight, rounds flatten their sides, every letter keeps the same x-height. For "make the letters wider" reach for \`stretch\`; for cartoon squash-and-stretch use the \`scaleX\`/\`scaleY\` motion instead. Move ONE dial at a time — the engine is proven at single-axis extremes (0.5–2.5 on either dial) and the studio eases the second dial when both are pushed. \`fit: width\` makes the run fill the box; then \`stretch\` follows the text and is not yours to set.
```

- [ ] **Step 4: Implement the surface bits**

In `VectorTypeSurface.vue`:
- Keep the last frame the draw returned (there is already a pattern: "`drawVectorType` returns … what the renderer ACTUALLY decided" ~line 888 — extend that state with `lastStretch = frame.stretch`).
- Where the Layout controls are rendered from the schema (the derived panel), pass a per-control override so the `stretch` row is `readonly` with value `lastStretch.fitted` when `config.fit === 'width' && lastStretch.fitted != null`. Find how other rows go read-only/disabled in the shared panel (`grep -rn "readonly\|disabled" app/components/vue-canvas/studio/StudioRow.vue` and how `VectorTypeSurface` passes row overrides); follow that mechanism exactly — do not hand-roll a row (StudioButton/StudioRow are the components; see repo notes).
- Under the Layout group, when `lastStretch.damped`, render a one-line hint: `<p class="text-[11px] text-white/45">eased — both dials are pushed, so the second is softened for the letters</p>` (Tailwind, matches the hint style used nearby; check an existing hint line and copy its classes).
- The dev-harness page for this studio, if one exists (`ls app/pages/dev | grep -i vector`), needs nothing.

- [ ] **Step 5: Typecheck + run**

`npx nuxi typecheck 2>&1 | grep -E "VectorTypeSurface|vectortype/controls" || echo "no errors"`; `npx vitest run tests/unit/vectortype-agent-guidance.unit.spec.ts tests/unit/vectortype-config.unit.spec.ts`.

- [ ] **Step 6: Commit**

```bash
git add app/components/vue-canvas/VectorTypeSurface.vue app/lib/vectortype/controls.ts tests/unit/vectortype-agent-guidance.unit.spec.ts
git commit -m "feat(vectortype): fit shows the solved stretch read-only, 'eased' hint on damped moves, agent guidance for stretch vs scale

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Live verification in the real studio (controller-driven, browser pane)

**Files:** none — verifies the running app. Use the dev server on `127.0.0.1:3000` (never `localhost`); check `ps` for a running nuxt before starting one; wait for `[data-ready]` where the harness exposes it.

- [ ] **Step 1: Open a Vector Type Studio.** In the app, create a Vector Type node (or open an existing project that has one) and open its studio modal. Confirm the Layout group shows **Stretch**, **Height**, **Fit** — and does NOT show k, round coupling or shape rules.

- [ ] **Step 2: The dial moves real pixels, typographically.** Type `Sailor`, set Stretch 1.8 via the row (click the number, type 1.8, Enter — the row is the slider). Read the preview canvas: run width grows; measure the `l` stem's ink width in pixels by scanning a row of the canvas (`getImageData` on the preview canvas at mid x-height) before and after — it must stay within ~5%. If the stem widened by ~1.8×, the smart path did not run (the graceful-fallback trap) — stop and fix.

- [ ] **Step 3: Height, baseline, zones.** Reset Stretch to 1, set Height 2.2: the run keeps its width; the `a`, `o`, `r` tops sit level; the `i` dot rises; nothing changes horizontally.

- [ ] **Step 4: Fit.** Set Fit = width: the Stretch row goes read-only and shows a solved value; the run fills the box minus the margin. Change the text to `Sail` — the solved value changes and the run still fills. Set Fit = off: the dial is editable again at the value it was solved to.

- [ ] **Step 5: Damping.** Set Stretch 2 and Height 2: the "eased" hint appears; the engine received ~1.5/1.5 (compare the run width with Stretch 1.5 / Height 1 alone). Set Height back to 1: hint disappears.

- [ ] **Step 6: Motion.** Motion tab → gallery → **Spring Up**: scrub the timeline: letters are tall at t=0 and settle to drawn height, baseline fixed; with stagger delay > 0 they land one after another (perGlyph path). **Stretch Wave** with stagger: a crest of width travels. Export a short mp4/webm of Spring Up via the studio's own export (existing WebCodecs path) and open it — the invariant "command count constant" means no frame pops.

- [ ] **Step 7: Agent.** In the studio's AI bar, ask "make the letters a bit wider" — the patch should hit `stretch`, not `scaleX`. Ask "make them squash like a cartoon" — it should reach for the scale motion. (One cheap model call each; skip if no key is configured and note it.)

- [ ] **Step 8: SVG export parity.** Export SVG at Stretch 1.6 and check the file's path count equals the un-stretched export's path count (command count invariant carried through `vectorTypeSVG`).

- [ ] **Step 9: Report** the eight checks with screenshots; log any failure in the ledger before fixing.

---

## Post-plan notes (controller)

- After Phase B lands: update the build dashboard (re-read the LIVE artifact first — a parallel session redesigned it on 2026-09-01), STATE.md, and the memory file; move the Phase A lab column "field (2D spike)" behind a toggle if Julien asks.
- The laws L10–L17 (serifs, apertures, hairlines, joins, slant, monoline, spacing, ink traps) are NOT in Phase B — they are the constraint set for the stroke-vector destination. Serifs (L10) and apertures (L11) are the two most likely to be seen first in the studio; note them in the studio's known-limits if a user reaches them.
- Per-glyph stretch caches: `glyphFlexFor` memoises per GlyphOutline object; the frame's `cache` map keeps shaped runs per coords key, so a wave re-shapes once per distinct coords and re-analyses flex once per glyph object per frame. If a 60 fps wave on long text is slow, key a flex cache on `(fontId, glyphId, coordsKey)` across frames — deferred until measured.
