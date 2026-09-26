# Frame Brush Tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Frame's round-dab brush (Paint mode) with three tips (spray can, round, bristle). Strokes are saved as replayable movement records and rendered deterministically in every Frame render path.

**Architecture:** Pure deterministic simulators (`lib/brushTips/*`) turn a saved `TipStroke` (pointer path + timing + settings + seed) into dabs (spray, round) or a ribbon (bristle), in fixed Frame units (1080 per artboard width). A small WebGL2 engine rasterises those into a white **coverage** canvas, plus an optional grey **shade** canvas. The existing `drawLocalLayer` brush branch composites coverage where it stamps legacy strokes today, then its unchanged `source-in` fill runs, then shade is drawn with `soft-light`. The UI is a bottom `BrushToolbar` (like `PenToolbar`) plus a `BrushTipSettings` right-panel section.

**Tech Stack:** Vue 3 + TypeScript (Nuxt 4), Canvas2D + WebGL2, Vitest (`npm run test:unit`, files `frontend/tests/unit/**/*.unit.spec.ts`), Playwright for browser checks.

**Spec:** `docs/superpowers/specs/2026-09-26-frame-brush-tips-design.md`

**Prototype:** `docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html`. This is the look-and-feel reference and the source of every constant and shader. Where a task says "port", copy the prototype code named by the line numbers and apply only the listed changes.

## Global Constraints

- **Deterministic replay:** replay code never calls `Math.random`, `Date.now` or `performance.now`. All randomness comes from `makeRng(seed)`.
- **Fixed step:** spray is simulated at a fixed step of **1/120 s**. The result must not depend on how often it is advanced.
- **Units:**
  - Replay works in **Frame units, `REF_W = 1080` per artboard width**.
  - Strokes store width-normalised coordinates (÷ artboard width); `t` is ms since stroke start.
  - The renderer maps units to device px by `W·scale·dpr / REF_W`.
- **Legacy strokes** (`PaintStroke`, no `tip` field) must render **byte-identically** to today through the existing `stampStrokes` path.
- **Mask mode is unchanged:** it keeps today's legacy strokes and today's Size / Flow / Soft controls.
- **Paint moves only on the next stroke.** Tip settings affect only the next stroke; each stroke stores the settings it was painted with.
- **Copy:** sentence case, no identifiers in UI text. Tip labels are "Spray can", "Round" and "Bristle". Every slider shows `NN%`.
- **Commits:** follow the private-index recipe in the "Committing" section below. Never run `npm run dev` (it kills the shared :3002 server and possibly ComfyUI).
- **Default settings** (fractions, 1 = 100%):
  - `spray {speckle:.25, overspray:.2, drips:1.75, build:2, relief:0}`
  - `round {softness:2, overspray:2, grain:2, smoothing:2, relief:.05}`
  - `bristle {thin:.15, taper:.2, dry:.65, load:0, bristle:.5, relief:.35, smoothing:.6}`
- **Slider maximums:** round 4 (400%), all others 2 (200%).
- **Default sizes (Frame units, diameter):** spray 110, round 36, bristle 44. Size range: 4–320.

## Committing (paste into every implementer brief)

Run the whole recipe in **one** Bash call, from the repo root:

```bash
BEFORE=$(git rev-parse HEAD)
export GIT_INDEX_FILE=$(mktemp -u /tmp/brushtips-idx-XXXX)
git read-tree HEAD
git add -- <ONLY your exact paths>
git diff --cached --stat HEAD      # must list ONLY your files
git commit -q -m "<message>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"
rm -f "$GIT_INDEX_FILE"
```

Then, in a **separate** Bash call:

```bash
git reset -q -- <the same paths>
git show --stat HEAD
```

`git show --stat HEAD` must list only your files.

## File map

| File | Responsibility |
|---|---|
| `frontend/app/lib/brushTips/tips.ts` | Tip ids, labels, hints, settings catalogue, defaults, ranges, `REF_W` |
| `frontend/app/lib/brushTips/random.ts` | `makeRng(seed)` with `next()` / `gauss()` |
| `frontend/app/lib/brushTips/record.ts` | `TipStroke` type, `isTipStroke`, `encodePts` / `decodePts`, `tipStrokePad` |
| `frontend/app/lib/brushTips/dabs.ts` | `DabBuffer` (flat growable Float32 list of x, y, r, s, h) |
| `frontend/app/lib/brushTips/spray.ts` | `SpraySim`: fixed-step spray + drips |
| `frontend/app/lib/brushTips/round.ts` | `RoundSim`: lazy-string stamping + overspray |
| `frontend/app/lib/brushTips/bristle.ts` | `bristleRibbon(stroke, done)`: ribbon vertex data |
| `frontend/app/lib/brushTips/replay.ts` | `replayStroke(stroke)` → `{dabs}` or `{ribbon}`, plus a per-stroke memo |
| `frontend/app/lib/brushTips/engine.ts` | WebGL2 rasteriser + Canvas2D fallback → `{coverage, shade}` |
| `frontend/app/lib/brushTips/coverage.ts` | `renderTipCoverage(layerId, strokes, view)` with cache |
| `frontend/app/lib/compositor/brushStamp.ts` | `strokeBounds` becomes tip-aware |
| `frontend/app/composables/useCompositorLayers.ts` | Brush-branch split (legacy vs tip), shade composite |
| `frontend/app/composables/useBrushPaint.ts` | `tip`, persisted per-tip settings and sizes, timestamped sample capture |
| `frontend/app/components/vue-canvas/compositor/BrushToolbar.vue` | Bottom toolbar |
| `frontend/app/components/vue-canvas/compositor/BrushTipSettings.vue` | Right-panel tip sliders + Reset |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Wiring: pointer, hold samples, drip settle, toolbar/panel mount |

---

### Task 1: Tips catalogue, seeded RNG, stroke record

**Files:**
- Create: `frontend/app/lib/brushTips/tips.ts`, `frontend/app/lib/brushTips/random.ts`, `frontend/app/lib/brushTips/record.ts`, `frontend/app/lib/brushTips/dabs.ts`
- Test: `frontend/tests/unit/brush-tips-record.unit.spec.ts`

**Interfaces:**
- Produces: `TipId`, `TIP_IDS`, `TIPS`, `defaultSettings(tip)`, `REF_W`, `SIZE_MIN`, `SIZE_MAX`, `TipStroke`, `isTipStroke`, `encodePts`, `decodePts`, `Sample`, `tipStrokePad`, `makeRng`, `Rng2`, `DabBuffer`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-tips-record.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { TIPS, TIP_IDS, defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { makeRng } from '~/lib/brushTips/random'
import { encodePts, decodePts, isTipStroke, tipStrokePad, type TipStroke } from '~/lib/brushTips/record'
import { DabBuffer } from '~/lib/brushTips/dabs'

describe('brush tips catalogue', () => {
  it('has the three tips with the tuned defaults', () => {
    expect(TIP_IDS).toEqual(['spray', 'round', 'bristle'])
    expect(defaultSettings('spray')).toEqual({ speckle: 0.25, overspray: 0.2, drips: 1.75, build: 2, relief: 0 })
    expect(defaultSettings('round')).toEqual({ softness: 2, overspray: 2, grain: 2, smoothing: 2, relief: 0.05 })
    expect(defaultSettings('bristle')).toEqual({ thin: 0.15, taper: 0.2, dry: 0.65, load: 0, bristle: 0.5, relief: 0.35, smoothing: 0.6 })
    expect(TIPS.round.settings.every(s => s.max === 4)).toBe(true)
    expect(TIPS.spray.settings.every(s => s.max === 2)).toBe(true)
    expect(REF_W).toBe(1080)
  })
  it('defaultSettings returns a fresh copy', () => {
    const a = defaultSettings('spray'); a.speckle = 9
    expect(defaultSettings('spray').speckle).toBe(0.25)
  })
})

describe('seeded rng', () => {
  it('is repeatable per seed and differs across seeds', () => {
    const a = makeRng(42), b = makeRng(42), c = makeRng(43)
    const sa = [a.next(), a.next(), a.gauss()[0]], sb = [b.next(), b.next(), b.gauss()[0]]
    expect(sa).toEqual(sb)
    expect(c.next()).not.toBe(sa[0])
  })
  it('gauss has roughly unit spread', () => {
    const r = makeRng(7); let s = 0, s2 = 0; const n = 4000
    for (let i = 0; i < n; i++) { const g = r.gauss()[0]; s += g; s2 += g * g }
    expect(Math.abs(s / n)).toBeLessThan(0.08)
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.1)
  })
})

describe('stroke record', () => {
  it('round-trips samples with rounding', () => {
    const samples = [{ x: 0.123456789, y: 0.5, t: 0 }, { x: 0.2, y: 0.51234567, t: 16.6 }]
    const pts = encodePts(samples)
    expect(pts).toEqual([0.12346, 0.5, 0, 0.2, 0.51235, 17])
    expect(decodePts(pts)).toEqual([{ x: 0.12346, y: 0.5, t: 0 }, { x: 0.2, y: 0.51235, t: 17 }])
  })
  it('tells tip strokes from legacy strokes', () => {
    const tip: TipStroke = { tip: 'spray', v: 1, size: 0.1, settings: defaultSettings('spray'), seed: 1, pts: [0, 0, 0] }
    expect(isTipStroke(tip)).toBe(true)
    expect(isTipStroke({ points: [], radius: 0.01, hardness: 1, opacity: 1, erase: false })).toBe(false)
  })
  it('pads spray more downward (drips) than upward', () => {
    const tip: TipStroke = { tip: 'spray', v: 1, size: 0.1, settings: defaultSettings('spray'), seed: 1, pts: [0.5, 0.5, 0] }
    const p = tipStrokePad(tip)
    expect(p.down).toBeGreaterThan(p.up)
    expect(p.up).toBeGreaterThan(0.05)
  })
})

describe('DabBuffer', () => {
  it('stores 5 floats per dab and grows', () => {
    const d = new DabBuffer(2)
    for (let i = 0; i < 10; i++) d.push(i, i, 1, 0.5, 1)
    expect(d.count).toBe(10)
    expect(Array.from(d.view().slice(45, 50))).toEqual([9, 9, 1, 0.5, 1])
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-record.unit.spec.ts`
Expected: FAIL (cannot resolve `~/lib/brushTips/tips`).

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/brushTips/tips.ts
// The three Frame brush tips: labels, hints, the settings each one exposes, and the
// defaults Julien tuned by hand in the prototype (2026-09-26). Values are fractions
// of the prototype baseline (1 = 100%). See docs/superpowers/specs/2026-09-26-frame-brush-tips-design.md.

export type TipId = 'spray' | 'round' | 'bristle'
export const TIP_IDS: readonly TipId[] = ['spray', 'round', 'bristle']

/** Replay units per artboard width. Fixed, so a stroke replays identically at every render size. */
export const REF_W = 1080
export const SIZE_MIN = 4
export const SIZE_MAX = 320

export interface TipSetting { key: string; label: string; default: number; max: number }
export interface TipDef { id: TipId; label: string; hint: string; defaultSize: number; settings: TipSetting[] }

const s = (key: string, label: string, def: number, max = 2): TipSetting => ({ key, label, default: def, max })

export const TIPS: Record<TipId, TipDef> = {
  spray: {
    id: 'spray', label: 'Spray can', defaultSize: 110,
    hint: 'Hold still and the paint pools, then drips. Move fast for a light dusting.',
    settings: [s('speckle', 'Speckle', 0.25), s('overspray', 'Overspray', 0.2), s('drips', 'Drips', 1.75), s('build', 'Build-up', 2), s('relief', 'Relief', 0)],
  },
  round: {
    id: 'round', label: 'Round', defaultSize: 36,
    hint: 'A clean round brush with a little overspray and grain at the edge.',
    settings: [s('softness', 'Softness', 2, 4), s('overspray', 'Overspray', 2, 4), s('grain', 'Grain', 2, 4), s('smoothing', 'Smoothing', 2, 4), s('relief', 'Relief', 0.05, 4)],
  },
  bristle: {
    id: 'bristle', label: 'Bristle', defaultSize: 44,
    hint: 'Slow down for a loaded stroke, flick fast for a dry, broken one.',
    settings: [s('thin', 'Speed thinning', 0.15), s('taper', 'Taper', 0.2), s('dry', 'Dry brush', 0.65), s('load', 'Runs out of paint', 0), s('bristle', 'Bristle texture', 0.5), s('relief', 'Paint thickness', 0.35), s('smoothing', 'Smoothing', 0.6)],
  },
}

export const MASK_HINT = 'Paint to hide part of the selected layer. The eraser brings it back.'

export function defaultSettings(tip: TipId): Record<string, number> {
  const out: Record<string, number> = {}
  for (const st of TIPS[tip].settings) out[st.key] = st.default
  return out
}
```

```ts
// frontend/app/lib/brushTips/random.ts
// Seeded randomness for brush replay. Replay must never touch Math.random: a saved
// stroke has to produce the same specks on every machine and in every export.
import { mulberry32 } from '~/lib/rng'

export interface Rng2 { next(): number; gauss(): [number, number] }

export function makeRng(seed: number): Rng2 {
  const r = mulberry32(seed >>> 0)
  return {
    next: r,
    gauss() {
      let u = r(); while (u <= 1e-12) u = r()
      const m = Math.sqrt(-2 * Math.log(u)), a = 2 * Math.PI * r()
      return [m * Math.cos(a), m * Math.sin(a)]
    },
  }
}
```

```ts
// frontend/app/lib/brushTips/record.ts
// What a tip stroke saves: the movement, not the pixels. Replay rebuilds the paint.
import { REF_W, type TipId } from './tips'
import type { PaintStroke } from '~/lib/compositor/brushStamp'

export interface TipStroke {
  tip: TipId
  v: 1
  size: number                       // brush diameter, width-normalised (÷ artboard width)
  settings: Record<string, number>   // snapshot of the tip's settings when painted
  seed: number                       // uint32
  pts: number[]                      // flat x, y, t — x,y width-normalised (5 dp), t ms since start (integer)
  erase?: boolean
}
export interface Sample { x: number; y: number; t: number }

export function isTipStroke(s: PaintStroke | TipStroke | null | undefined): s is TipStroke {
  return !!s && typeof (s as TipStroke).tip === 'string'
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5
export function encodePts(samples: Sample[]): number[] {
  const out: number[] = []
  for (const p of samples) out.push(r5(p.x), r5(p.y), Math.round(p.t))
  return out
}
export function decodePts(pts: number[]): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i + 2 < pts.length; i += 3) out.push({ x: pts[i]!, y: pts[i + 1]!, t: pts[i + 2]! })
  return out
}

/** How far (width-normalised) a stroke's paint can reach past its path, per side. */
export function tipStrokePad(s: TipStroke): { side: number; up: number; down: number } {
  const size = s.size * REF_W, st = s.settings
  let side: number, down: number
  if (s.tip === 'spray') {
    const sig = size * 0.26, O = st.overspray ?? 0.2
    side = Math.max(sig * 1.9, sig * (1 + 1.1 * O) * 3.2)   // mist radius vs 3.2σ of overspray
    const D = st.drips ?? 0
    down = side + size * 0.2 + (25 + size * 1.5) * D + size * 0.1 // drip start + longest run + end blob
  } else if (s.tip === 'round') {
    side = size / 2 * (1 + 0.3 * Math.max(0.3, st.overspray ?? 0) * 3) + 1
    down = side
  } else {
    side = size * 1.25 / 2 + 2  // widest bristle width (1.2× size) plus ragged edge
    down = side
  }
  return { side: side / REF_W, up: side / REF_W, down: down / REF_W }
}
```

```ts
// frontend/app/lib/brushTips/dabs.ts
// A growable flat list of dabs: x, y, radius, strength, hardness (Frame units).
export class DabBuffer {
  private buf: Float32Array
  count = 0
  constructor(initial = 1024) { this.buf = new Float32Array(Math.max(1, initial) * 5) }
  push(x: number, y: number, r: number, s: number, h: number): void {
    if ((this.count + 1) * 5 > this.buf.length) { const nb = new Float32Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb }
    const o = this.count * 5
    this.buf[o] = x; this.buf[o + 1] = y; this.buf[o + 2] = r; this.buf[o + 3] = s; this.buf[o + 4] = h
    this.count++
  }
  /** The filled part (a view, not a copy). */
  view(): Float32Array { return this.buf.subarray(0, this.count * 5) }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-record.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/brushTips/tips.ts frontend/app/lib/brushTips/random.ts frontend/app/lib/brushTips/record.ts frontend/app/lib/brushTips/dabs.ts frontend/tests/unit/brush-tips-record.unit.spec.ts`
Message: `feat(brush): tip catalogue, seeded rng and replayable stroke record`

---

### Task 2: Spray simulator (fixed step, drips)

**Files:**
- Create: `frontend/app/lib/brushTips/spray.ts`
- Test: `frontend/tests/unit/brush-tips-spray.unit.spec.ts`

**Interfaces:**
- Consumes: `makeRng`, `DabBuffer`, `Sample`, `REF_W`.
- Produces:

```ts
class SpraySim {
  constructor(opts: { size: number /*Frame units, diameter*/; settings: Record<string, number>; seed: number })
  readonly dabs: DabBuffer                   // Frame units, absolute artboard space (x·REF_W, y·REF_W)
  addSample(s: Sample): void                 // Sample in width-normalised coords, t in ms; t must be non-decreasing
  advanceTo(tMs: number): void               // steps 1/120 s up to min(tMs, last sample t) while painting
  release(): void                            // no more samples; later advance runs drips only
  settle(maxMs?: number): void               // after release: advance until no drips, capped (default 2000 ms)
  readonly settled: boolean                  // released and no live drips
}
function simulateSpray(stroke: TipStroke, tailMs?: number): { dabs: DabBuffer; settled: boolean }   // feed all samples, release, then run drips for tailMs (default: until settled, ≤ 2000 ms)
```

**Port source:** prototype `sprayTick` (L906-929), `spawnDrip` (L930-934) and `updateDrips` (L935-945). Changes:
- Every `Math.random()` becomes `rng.next()` and every `gauss()` becomes `rng.gauss()`, **in the same call order**.
- Delete the effect-mask branch (`st.layer ? 1 : …`): `k = settings.build`.
- Drop the stroke-coordinate (`u`/`v`/`tx`/`ty`) fields: dabs are just x, y, r, s, h.
- `dt` is always `1/120`. The nozzle position at step time `T` is linearly interpolated between the bracketing samples, in Frame units (sample × `REF_W`).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-tips-spray.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { SpraySim, simulateSpray } from '~/lib/brushTips/spray'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, tipStrokePad, type TipStroke, type Sample } from '~/lib/brushTips/record'

function path(): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i <= 60; i++) out.push({ x: 0.2 + i * 0.004, y: 0.4 + Math.sin(i / 8) * 0.02, t: i * 16 })
  for (let j = 1; j <= 90; j++) out.push({ x: 0.44, y: 0.4 + Math.sin(60 / 8) * 0.02, t: 960 + j * 16 }) // hold still ~1.4 s
  return out
}
const stroke = (): TipStroke => ({ tip: 'spray', v: 1, size: 110 / REF_W, settings: defaultSettings('spray'), seed: 1234, pts: encodePts(path()) })

describe('SpraySim', () => {
  it('replays identically', () => {
    const a = simulateSpray(stroke()).dabs.view(), b = simulateSpray(stroke()).dabs.view()
    expect(a.length).toBeGreaterThan(1000)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
  it('live feeding at any frame rate equals a one-shot replay', () => {
    const ref = Array.from(simulateSpray(stroke()).dabs.view())
    for (const frameMs of [33, 7]) {
      const st = stroke(), sim = new SpraySim({ size: st.size * REF_W, settings: st.settings, seed: st.seed })
      const samples = path()
      let i = 0
      for (let now = 0; now <= samples[samples.length - 1]!.t + frameMs; now += frameMs) {
        while (i < samples.length && samples[i]!.t <= now) sim.addSample(samples[i++]!)
        sim.advanceTo(now)
      }
      sim.release(); sim.settle()
      expect(Array.from(sim.dabs.view())).toEqual(ref)
    }
  })
  it('a partial drip tail is a prefix of the settled replay', () => {
    const full = Array.from(simulateSpray(stroke()).dabs.view())
    const part = simulateSpray(stroke(), 300)
    expect(part.settled).toBe(false)
    expect(Array.from(part.dabs.view())).toEqual(full.slice(0, part.dabs.view().length))
    expect(part.dabs.view().length).toBeLessThan(full.length)
  })
  it('holding still makes drips that run below the nozzle', () => {
    const d = simulateSpray(stroke()).dabs.view()
    let maxY = -Infinity
    for (let i = 1; i < d.length; i += 5) maxY = Math.max(maxY, d[i]!)
    const nozzleY = (0.4 + Math.sin(60 / 8) * 0.02) * REF_W
    expect(maxY).toBeGreaterThan(nozzleY + 110 * 0.4)
  })
  it('drips 0 makes no drips', () => {
    const st = stroke(); st.settings = { ...st.settings, drips: 0 }
    const d = simulateSpray(st).dabs.view()
    let maxY = -Infinity
    for (let i = 0; i < d.length; i += 5) maxY = Math.max(maxY, d[i + 1]!)   // dab centre y
    expect(maxY).toBeLessThan((0.4 + 0.03) * REF_W + 110 * 0.26 * (1 + 1.1 * 0.2) * 4.5) // path + ~4.5σ of overspray, no drip runs
  })
  it('every dab sits inside the padded bounds', () => {
    const st = stroke(), pad = tipStrokePad(st), d = simulateSpray(st).dabs.view()
    const xs = path().map(p => p.x), ys = path().map(p => p.y)
    const minX = (Math.min(...xs) - pad.side) * REF_W, maxX = (Math.max(...xs) + pad.side) * REF_W
    const minY = (Math.min(...ys) - pad.up) * REF_W, maxY = (Math.max(...ys) + pad.down) * REF_W
    for (let i = 0; i < d.length; i += 5) {
      expect(d[i]! - d[i + 2]!).toBeGreaterThanOrEqual(minX); expect(d[i]! + d[i + 2]!).toBeLessThanOrEqual(maxX)
      expect(d[i + 1]! - d[i + 2]!).toBeGreaterThanOrEqual(minY); expect(d[i + 1]! + d[i + 2]!).toBeLessThanOrEqual(maxY)
    }
  })
})
```

If the bounds test fails only by a small margin, widen `tipStrokePad`'s constants in `record.ts` (Task 1 file; include it in this commit) until every dab fits. Do not narrow the simulation.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-spray.unit.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/brushTips/spray.ts
// Spray can replay: a fixed-step (1/120 s) simulation of mist, specks, pooling and drips.
// Ported from the prototype (sprayTick / spawnDrip / updateDrips). Deterministic: the same
// record gives the same dabs however often advanceTo() is called. Frame units throughout.
import { makeRng, type Rng2 } from './random'
import { DabBuffer } from './dabs'
import { REF_W } from './tips'
import { decodePts, type Sample, type TipStroke } from './record'

const DT = 1 / 120
const DT_MS = 1000 / 120
interface Drip { x: number; y: number; vy: number; r: number; left: number; acc: number }

export class SpraySim {
  readonly dabs = new DabBuffer(4096)
  private rng: Rng2
  private samples: Sample[] = []
  private simT = 0            // ms of simulated time
  private prev: { x: number; y: number } | null = null
  private wet = 0; private dripT = 0; private carry = 0
  private drips: Drip[] = []
  private released = false
  private size: number; private S: Record<string, number>

  constructor(opts: { size: number; settings: Record<string, number>; seed: number }) {
    this.size = opts.size; this.S = opts.settings; this.rng = makeRng(opts.seed)
  }
  get settled() { return this.released && this.drips.length === 0 }

  addSample(s: Sample) { this.samples.push(s) }
  release() { this.released = true }

  private nozzleAt(tMs: number): { x: number; y: number } {
    const P = this.samples
    let i = 0
    while (i + 1 < P.length && P[i + 1]!.t <= tMs) i++
    const a = P[i]!, b = P[Math.min(i + 1, P.length - 1)]!
    const f = b.t > a.t ? Math.min(1, Math.max(0, (tMs - a.t) / (b.t - a.t))) : 0
    return { x: (a.x + (b.x - a.x) * f) * REF_W, y: (a.y + (b.y - a.y) * f) * REF_W }
  }

  advanceTo(tMs: number) {
    if (!this.samples.length) return
    const limit = this.released ? tMs : Math.min(tMs, this.samples[this.samples.length - 1]!.t)
    while (this.simT + DT_MS <= limit + 1e-9) {
      this.simT += DT_MS
      if (!this.released) {
        const b = this.nozzleAt(this.simT)
        const a = this.prev ?? b
        this.tick(a, b)
        this.prev = b
      }
      this.updateDrips()
    }
  }
  settle(maxMs = 2000) {
    const end = this.simT + maxMs
    while (this.drips.length && this.simT < end) this.advanceTo(this.simT + DT_MS)
  }

  private tick(a: { x: number; y: number }, b: { x: number; y: number }) {
    const S = this.S, rng = this.rng, size = this.size, dt = DT
    const sig = size * 0.26, k = S.build ?? 1, rs = Math.max(1, size / 140)
    const moved = Math.hypot(b.x - a.x, b.y - a.y)
    // soft mist underneath, so the cloud fades out smoothly
    const steps = Math.max(1, Math.ceil(moved / (sig * 0.5)))
    for (let i = 1; i <= steps; i++) this.dabs.push(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, sig * 1.9, 2.1 * dt / steps * k, 0)
    // fine specks on top: the grain of a real can
    const want = dt * 5000 * (S.speckle ?? 1) * (size / 100) ** 2 + this.carry
    let n = Math.floor(want); this.carry = want - n; n = Math.min(n, 2500)
    const O = S.overspray ?? 1
    for (let i = 0; i < n; i++) {
      const t = rng.next(), cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t
      const over = rng.next() < Math.min(0.6, 0.22 * O), g = rng.gauss(), sg = over ? sig * (1 + 1.1 * O) : sig
      const r = (over ? 0.22 + rng.next() * 0.2 : 0.28 + rng.next() * rng.next() * 0.55) * rs
      this.dabs.push(cx + g[0] * sg, cy + g[1] * sg, r, (over ? 0.35 : 0.5 + rng.next() * 0.4) * k, 1)
    }
    // held still, the paint pools; pooled paint runs
    const D = S.drips ?? 0
    this.wet = moved < dt * 25 ? this.wet + dt : Math.max(0, this.wet - dt * 2)
    if (D > 0.01 && this.wet > 0.6 / D) {
      this.dripT -= dt
      if (this.dripT <= 0) { this.dripT = (0.25 + rng.next() * 0.4) / D; this.spawnDrip(b) }
    }
  }
  private spawnDrip(at: { x: number; y: number }) {
    const rng = this.rng, size = this.size, D = this.S.drips ?? 0
    const g = rng.gauss()
    const x = at.x + g[0] * size * 0.14
    const y = at.y + size * 0.12 + rng.next() * size * 0.08
    const vy = (45 + rng.next() * 60) * (0.6 + 0.4 * Math.min(2, D))
    const r = Math.max(1.3, size * 0.02) * (0.8 + rng.next() * 0.5)
    const left = (25 + rng.next() * size * 1.5) * D
    this.drips.push({ x, y, vy, r, left, acc: 0 })
  }
  private updateDrips() {
    const dt = DT
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i]!
      d.acc += d.vy * dt; d.vy *= Math.exp(-0.9 * dt)
      while (d.acc >= 1) { d.acc -= 1; d.y += 1; d.left -= 1; d.r *= 0.997; this.dabs.push(d.x + (this.rng.next() - 0.5) * 0.3, d.y, d.r, 0.85, 1) }
      if (d.left <= 0 || d.vy < 7) { this.dabs.push(d.x, d.y + d.r * 0.6, d.r * 1.55, 1, 1); this.drips.splice(i, 1) }
    }
  }
}

/** Replay a saved spray. `tailMs` limits how long drips run after the last sample:
 *  0 while the pointer is still down (live), the time since release while drips settle,
 *  and Infinity (default) for a finished stroke — capped by settle()'s 2 s. */
export function simulateSpray(stroke: TipStroke, tailMs = Infinity): { dabs: DabBuffer; settled: boolean } {
  const sim = new SpraySim({ size: stroke.size * REF_W, settings: stroke.settings, seed: stroke.seed })
  const samples = decodePts(stroke.pts)
  for (const s of samples) sim.addSample(s)
  const end = samples.length ? samples[samples.length - 1]!.t : 0
  sim.advanceTo(end)
  sim.release()
  if (tailMs === Infinity) sim.settle()
  else sim.advanceTo(end + Math.min(2000, Math.max(0, tailMs)))
  return { dabs: sim.dabs, settled: sim.settled }
}
```

Note: the spray does **not** paint at t = 0 by itself; the first step paints at 1/120 s. This matches the prototype's frame loop.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-spray.unit.spec.ts`
Expected: PASS. If "live equals replay" fails, the cause is almost always floating-point drift in the `simT` accumulation. Fix it by stepping an integer step counter: `stepIdx`, with `simT = stepIdx * DT_MS`. Never compare with a tolerance.

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/brushTips/spray.ts frontend/tests/unit/brush-tips-spray.unit.spec.ts` (plus `record.ts` if the padding was widened)
Message: `feat(brush): deterministic spray can replay with pooling and drips`

---

### Task 3: Round simulator

**Files:**
- Create: `frontend/app/lib/brushTips/round.ts`
- Test: `frontend/tests/unit/brush-tips-round.unit.spec.ts`

**Interfaces:**
- Produces:

```ts
class RoundSim {
  constructor(opts: { size: number; settings: Record<string, number>; seed: number })
  readonly dabs: DabBuffer
  addSample(s: Sample): void   // stamps as the lazy string moves
}
function simulateRound(stroke: TipStroke): DabBuffer
```

**Port source:** prototype `stampRound` (L946-962) and the round branch of `onRaw` (L993-1012). Changes:
- The lazy string (`R = 3 * smoothing`) starts at the first sample. The first sample stamps a dab immediately.
- `k = 1`, and `rng` replaces `Math.random` / `gauss`.
- The stroke-coordinate fields are dropped.
- The main dab is `(x, y, size/2, 0.35, clamp(1 − 0.3·softness, 0, 1))`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-tips-round.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { RoundSim, simulateRound } from '~/lib/brushTips/round'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, tipStrokePad, type TipStroke, type Sample } from '~/lib/brushTips/record'

const samples = (): Sample[] => Array.from({ length: 50 }, (_, i) => ({ x: 0.1 + i * 0.008, y: 0.5 + Math.sin(i / 6) * 0.03, t: i * 12 }))
const stroke = (): TipStroke => ({ tip: 'round', v: 1, size: 36 / REF_W, settings: defaultSettings('round'), seed: 99, pts: encodePts(samples()) })

describe('RoundSim', () => {
  it('replays identically and matches live feeding', () => {
    const a = Array.from(simulateRound(stroke()).view())
    const sim = new RoundSim({ size: 36, settings: defaultSettings('round'), seed: 99 })
    for (const s of samples()) sim.addSample(s)
    expect(Array.from(sim.dabs.view())).toEqual(a)
    expect(a.length / 5).toBeGreaterThan(50)
  })
  it('main dabs are evenly spaced at 8% of the size', () => {
    const d = simulateRound(stroke()).view(), mains: number[][] = []
    for (let i = 0; i < d.length; i += 5) if (d[i + 2] === 18) mains.push([d[i]!, d[i + 1]!])
    for (let i = 2; i < mains.length; i++) {
      const gap = Math.hypot(mains[i]![0]! - mains[i - 1]![0]!, mains[i]![1]! - mains[i - 1]![1]!)
      expect(gap).toBeCloseTo(36 * 0.08, 3)
    }
  })
  it('stays inside the padded bounds', () => {
    const st = stroke(), pad = tipStrokePad(st), d = simulateRound(st).view()
    const xs = samples().map(p => p.x), ys = samples().map(p => p.y)
    for (let i = 0; i < d.length; i += 5) {
      expect(d[i]! + d[i + 2]!).toBeLessThanOrEqual((Math.max(...xs) + pad.side) * REF_W)
      expect(d[i + 1]! - d[i + 2]!).toBeGreaterThanOrEqual((Math.min(...ys) - pad.up) * REF_W)
    }
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-round.unit.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/brushTips/round.ts
// Round tip replay: a lazy string smooths the pointer, dabs are stamped at 8% of the size,
// each with a few overspray specks just outside the edge. Ported from the prototype.
import { makeRng, type Rng2 } from './random'
import { DabBuffer } from './dabs'
import { REF_W } from './tips'
import { decodePts, type Sample, type TipStroke } from './record'

export class RoundSim {
  readonly dabs = new DabBuffer(1024)
  private rng: Rng2
  private lazy: { x: number; y: number } | null = null
  private last: { x: number; y: number } | null = null
  private size: number; private S: Record<string, number>
  constructor(opts: { size: number; settings: Record<string, number>; seed: number }) {
    this.size = opts.size; this.S = opts.settings; this.rng = makeRng(opts.seed)
  }
  addSample(s: Sample) {
    const p = { x: s.x * REF_W, y: s.y * REF_W }
    if (!this.lazy) { this.lazy = { ...p }; this.last = { ...p }; this.stamp(p.x, p.y); return }
    const R = 3 * (this.S.smoothing ?? 1)
    const dx = p.x - this.lazy.x, dy = p.y - this.lazy.y, L = Math.hypot(dx, dy)
    if (L <= R) return
    this.lazy.x += dx * (L - R) / L; this.lazy.y += dy * (L - R) / L
    const step = Math.max(1, this.size * 0.08)
    let d = Math.hypot(this.lazy.x - this.last!.x, this.lazy.y - this.last!.y)
    while (d >= step) {
      this.last = { x: this.last!.x + (this.lazy.x - this.last!.x) * step / d, y: this.last!.y + (this.lazy.y - this.last!.y) * step / d }
      this.stamp(this.last.x, this.last.y)
      d -= step
    }
  }
  private stamp(x: number, y: number) {
    const S = this.S, rng = this.rng, r = this.size / 2
    this.dabs.push(x, y, r, 0.35, Math.max(0, Math.min(1, 1 - 0.3 * (S.softness ?? 1))))
    const O = S.overspray ?? 1
    const e = 0.5 * O * Math.max(1, this.size / 30)
    const n = Math.floor(e) + (rng.next() < e % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2, rr = r * (0.85 + Math.abs(rng.gauss()[0]) * 0.3 * Math.max(0.3, O))
      this.dabs.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 0.3 + rng.next() * 0.45, 0.5, 1)
    }
  }
}

export function simulateRound(stroke: TipStroke): DabBuffer {
  const sim = new RoundSim({ size: stroke.size * REF_W, settings: stroke.settings, seed: stroke.seed })
  for (const s of decodePts(stroke.pts)) sim.addSample(s)
  return sim.dabs
}
```

If the bounds test fails, widen round's padding in `record.ts` (`|gauss|` is unbounded, so use a 4σ reach: `side = r·(0.85 + 0.3·max(0.3, O)·4) + 1`) and include `record.ts` in the commit.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-round.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/brushTips/round.ts frontend/tests/unit/brush-tips-round.unit.spec.ts` (+ `record.ts` if changed)
Message: `feat(brush): round tip replay with light overspray`

---

### Task 4: Bristle ribbon geometry

**Files:**
- Create: `frontend/app/lib/brushTips/bristle.ts`
- Test: `frontend/tests/unit/brush-tips-bristle.unit.spec.ts`

**Interfaces:**
- Produces:

```ts
const RIBBON_STRIDE = 7  // x, y, u (arc px), v (-1|1), w (width), loadT, speed
function bristleRibbon(stroke: TipStroke, done: boolean): Float32Array | null  // TRIANGLE_STRIP, Frame units
function bristlePoints(samples: Sample[], size: number, settings: Record<string, number>): { x: number; y: number; w: number; sp: number }[]
```

**Port source:**
- The bristle branch of the prototype's `onRaw` (L993-1004): speed EMA 0.25 on px/ms, lazy string `R = 3·smoothing`, a point pushed when it has moved ≥ 1.5 units, and `sp = speed` per point.
- `widthFor` (L722), `resample` (L724), `evenSpacing` (L741), `roundCorners` (L761), `buildRibbon` (L779-819).

Changes:
- Inputs are samples × `REF_W`, with `t` from the sample.
- `state.phys.brush` becomes `stroke.settings`: `thin`, `taper`, `smoothing`.
- `geo = 1`.
- `st.done` becomes the `done` argument.
- Nothing is mutated on the input.
- The first sample seeds `lazy` and the first point, with `sp = 0`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-tips-bristle.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { bristleRibbon, RIBBON_STRIDE } from '~/lib/brushTips/bristle'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, tipStrokePad, type TipStroke } from '~/lib/brushTips/record'

const zig = (): TipStroke => {
  const pts: { x: number; y: number; t: number }[] = []
  const corners = [[0.1, 0.4], [0.25, 0.2], [0.4, 0.4], [0.55, 0.2]]
  let t = 0
  for (let c = 1; c < corners.length; c++) for (let i = 1; i <= 20; i++) {
    const [x0, y0] = corners[c - 1]!, [x1, y1] = corners[c]!
    pts.push({ x: x0! + (x1! - x0!) * i / 20, y: y0! + (y1! - y0!) * i / 20, t: (t += 16) })
  }
  pts.unshift({ x: 0.1, y: 0.4, t: 0 })
  return { tip: 'bristle', v: 1, size: 44 / REF_W, settings: defaultSettings('bristle'), seed: 5, pts: encodePts(pts) }
}

describe('bristleRibbon', () => {
  it('is deterministic and a valid strip', () => {
    const a = bristleRibbon(zig(), true)!, b = bristleRibbon(zig(), true)!
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a.length % (RIBBON_STRIDE * 2)).toBe(0)
  })
  it('tapers both ends to near zero width when done', () => {
    const d = bristleRibbon(zig(), true)!, n = d.length / RIBBON_STRIDE
    const halfW = (i: number) => Math.hypot(d[i * 7]! - d[(i + 1) * 7]!, d[i * 7 + 1]! - d[(i + 1) * 7 + 1]!) / 2
    expect(halfW(0)).toBeLessThan(44 * 0.1)
    expect(halfW(n - 2)).toBeLessThan(44 * 0.1)
    expect(halfW(Math.floor(n / 2) & ~1)).toBeGreaterThan(44 * 0.3)
  })
  it('stays inside the padded bounds', () => {
    const st = zig(), pad = tipStrokePad(st), d = bristleRibbon(st, true)!
    for (let i = 0; i < d.length; i += 7) {
      expect(d[i]!).toBeGreaterThanOrEqual((0.1 - pad.side) * REF_W)
      expect(d[i + 1]!).toBeLessThanOrEqual((0.4 + pad.down) * REF_W)
    }
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-bristle.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Port as listed above. The module must export `RIBBON_STRIDE = 7`, `bristlePoints` and `bristleRibbon`. `bristleRibbon` returns `null` when there are fewer than 2 points. The vertex order per point is left then right (`side` −1 then +1), 7 floats each. The code to port, adapted:

```ts
// frontend/app/lib/brushTips/bristle.ts
// Bristle tip replay: pointer samples → smoothed points with speed → a tapered ribbon
// (TRIANGLE_STRIP). Ported from the prototype's buildRibbon; Frame units throughout.
import { REF_W } from './tips'
import { decodePts, type Sample, type TipStroke } from './record'

export const RIBBON_STRIDE = 7
interface P { x: number; y: number; w: number; sp: number }
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9))); return t * t * (3 - 2 * t) }
const widthFor = (size: number, speed: number, thin: number) => size * (1 + (0.2 - 0.87 * smooth(0.15, 2.2, speed)) * thin)

export function bristlePoints(samples: Sample[], size: number, S: Record<string, number>): P[] {
  if (!samples.length) return []
  const first = samples[0]!
  const lazy = { x: first.x * REF_W, y: first.y * REF_W }
  let lastRaw = { x: lazy.x, y: lazy.y, t: first.t }, speed = 0
  const out: P[] = [{ x: lazy.x, y: lazy.y, w: 0, sp: 0 }]
  const R = 3 * (S.smoothing ?? 1)
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!, p = { x: s.x * REF_W, y: s.y * REF_W }
    const dt = Math.max(1, s.t - lastRaw.t)
    speed += (Math.hypot(p.x - lastRaw.x, p.y - lastRaw.y) / dt - speed) * 0.25
    lastRaw = { ...p, t: s.t }
    const dx = p.x - lazy.x, dy = p.y - lazy.y, L = Math.hypot(dx, dy)
    if (L <= R) continue
    lazy.x += dx * (L - R) / L; lazy.y += dy * (L - R) / L
    const last = out[out.length - 1]!
    if (Math.hypot(lazy.x - last.x, lazy.y - last.y) >= 1.5) out.push({ x: lazy.x, y: lazy.y, w: 0, sp: speed })
  }
  return out
}

function resample(P: P[]): P[] {
  if (P.length < 3) return P
  const out: P[] = []
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)]!, p1 = P[i]!, p2 = P[i + 1]!, p3 = P[Math.min(P.length - 1, i + 2)]!
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 4))
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y), w: p1.w + (p2.w - p1.w) * t, sp: p1.sp + (p2.sp - p1.sp) * t })
    }
  }
  out.push(P[P.length - 1]!)
  return out
}
function evenSpacing(P: P[], step: number): P[] {
  if (P.length < 2) return P
  const out: P[] = [P[0]!]
  let carry = 0
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1]!, b = P[i]!, L = Math.hypot(b.x - a.x, b.y - a.y)
    let d = step - carry
    while (d <= L) {
      const t = d / L
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, sp: a.sp + (b.sp - a.sp) * t })
      d += step
    }
    carry = L - (d - step)
  }
  const last = P[P.length - 1]!, tail = out[out.length - 1]!
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.5) out.push(last)
  return out
}
function roundCorners(P: P[], k: number): P[] {
  const n = P.length
  if (k < 1 || n < 3) return P
  let cur = P
  for (let pass = 0; pass < 2; pass++) {
    const next: P[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const r = Math.min(k, i, n - 1 - i)
      let sx = 0, sy = 0
      for (let j = i - r; j <= i + r; j++) { sx += cur[j]!.x; sy += cur[j]!.y }
      const c = 2 * r + 1
      next[i] = { ...cur[i]!, x: sx / c, y: sy / c }
    }
    cur = next
  }
  return cur
}

export function bristleRibbon(stroke: TipStroke, done: boolean): Float32Array | null {
  const S = stroke.settings, size = stroke.size * REF_W, thin = S.thin ?? 1
  const raw = bristlePoints(decodePts(stroke.pts), size, S)
  let wv = widthFor(size, 0, thin)
  const pts = raw.map(q => { wv += (widthFor(size, q.sp, thin) - wv) * 0.14; return { ...q, w: wv } })
  const STEP = 2, sm = S.smoothing ?? 1
  const P = roundCorners(evenSpacing(resample(pts), STEP), Math.round(Math.min(25, size * 0.2 * sm) / STEP)), n = P.length
  if (n < 2) return null
  const tw = Math.max(1, Math.round(Math.max(2, size * 0.18 * sm) / STEP))
  const s = new Float32Array(n)
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y)
  const total = s[n - 1]!
  const ws = P.map(p => p.w)
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n - 1; i++) ws[i] = (ws[i - 1]! + ws[i]! * 2 + ws[i + 1]!) / 4
  const TP = Math.max(0.001, S.taper ?? 1)
  const tIn = Math.min(size * 1.6 * TP, total * 0.35 * Math.min(1, TP))
  const tOut = (done ? Math.min(size * 3 * TP, total * 0.45 * Math.min(1, TP)) : Math.min(size * 0.5 * TP, total * 0.15)) || 0.001
  const data = new Float32Array(n * 2 * RIBBON_STRIDE)
  let o = 0
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - tw)]!, b = P[Math.min(n - 1, i + tw)]!
    let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l
    const ti = smooth(0, tIn, s[i]!), to = smooth(0, tOut, total - s[i]!)
    const half = ws[i]! * (0.05 + 0.95 * Math.min(ti, to)) / 2
    const loadT = s[i]! / (size * 26)
    for (const side of [-1, 1]) {
      data[o++] = P[i]!.x - ty * half * side; data[o++] = P[i]!.y + tx * half * side
      data[o++] = s[i]!; data[o++] = side; data[o++] = ws[i]!; data[o++] = loadT; data[o++] = P[i]!.sp
    }
  }
  return data
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-bristle.unit.spec.ts`
Expected: PASS. If the taper test's midpoint index lands on a right-hand vertex, the `& ~1` keeps it even (a left vertex). Adjust the test index only.

- [ ] **Step 5: Commit**

Paths: `frontend/app/lib/brushTips/bristle.ts frontend/tests/unit/brush-tips-bristle.unit.spec.ts`
Message: `feat(brush): bristle ribbon replay with speed thinning, tapers and rounded corners`

---

### Task 5: Replay memo + raster engine (WebGL2 with Canvas2D fallback)

**Files:**
- Create: `frontend/app/lib/brushTips/replay.ts`, `frontend/app/lib/brushTips/engine.ts`, `frontend/app/lib/brushTips/coverage.ts`
- Test: `frontend/tests/unit/brush-tips-coverage.unit.spec.ts` (pure parts: grouping and cache key)

**Interfaces:**
- Consumes: `simulateSpray`, `simulateRound`, `bristleRibbon`, `isTipStroke`, `TipStroke`.
- Produces:

```ts
// replay.ts
type Replayed = { kind: 'dabs'; dabs: Float32Array } | { kind: 'ribbon'; data: Float32Array | null }
function replayStroke(s: TipStroke, done?: boolean, tailMs?: number): Replayed & { settled: boolean }   // memoised in a WeakMap keyed by the stroke object (done=true only)

// coverage.ts
interface TipGroup { tip: TipId; erase: boolean; strokes: TipStroke[] }
function groupTipStrokes(strokes: (PaintStroke | TipStroke)[]): TipGroup[]  // consecutive same-tip non-erase strokes join; each erase stroke is its own group; legacy strokes are skipped
interface CoverageView { originX: number; originY: number; unitPx: number; w: number; h: number } // originX/Y in Frame units (top-left of the offscreen), unitPx = device px per Frame unit
function renderTipCoverage(key: string, strokes: (PaintStroke | TipStroke)[], view: CoverageView, live?: TipStroke | null, liveTailMs?: number): { coverage: HTMLCanvasElement; shade: HTMLCanvasElement | null } | null

// engine.ts
function rasterGroup(group: TipGroup, view: CoverageView, live: TipStroke | null, liveTailMs: number): { coverage: HTMLCanvasElement | OffscreenCanvas; shade: HTMLCanvasElement | null }   // a stroke === live replays with replayStroke(s, false, liveTailMs); all others replayStroke(s)
```

- [ ] **Step 1: Write the failing test (pure grouping + memo)**

```ts
// frontend/tests/unit/brush-tips-coverage.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { groupTipStrokes } from '~/lib/brushTips/coverage'
import { replayStroke } from '~/lib/brushTips/replay'
import { defaultSettings } from '~/lib/brushTips/tips'
import type { TipStroke } from '~/lib/brushTips/record'

const mk = (tip: 'spray' | 'round' | 'bristle', erase = false): TipStroke => ({ tip, v: 1, size: 0.05, settings: defaultSettings(tip), seed: 1, pts: [0.1, 0.1, 0, 0.2, 0.2, 100], erase })
const legacy = { points: [{ x: 0, y: 0 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }

describe('groupTipStrokes', () => {
  it('joins consecutive same-tip paint, splits on tip change and on erase, skips legacy', () => {
    const g = groupTipStrokes([mk('spray'), mk('spray'), legacy, mk('round'), mk('round', true), mk('round')])
    expect(g.map(x => [x.tip, x.erase, x.strokes.length])).toEqual([['spray', false, 2], ['round', false, 1], ['round', true, 1], ['round', false, 1]])
  })
})
describe('replayStroke', () => {
  it('memoises finished strokes by object identity', () => {
    const s = mk('spray')
    const a = replayStroke(s), b = replayStroke(s)
    expect(a).toBe(b)
    expect(a.kind).toBe('dabs')
  })
})
```

Note: the skipped legacy stroke does not break the spray run in the example; it is rendered separately by the legacy path. That is intentional.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-coverage.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `replay.ts`**

```ts
// frontend/app/lib/brushTips/replay.ts
// One place that turns a saved tip stroke into drawable geometry, memoised per stroke object
// (strokes are immutable once committed; undo snapshots create new objects, which is fine).
import type { TipStroke } from './record'
import { simulateSpray } from './spray'
import { simulateRound } from './round'
import { bristleRibbon } from './bristle'

export type Replayed = ({ kind: 'dabs'; dabs: Float32Array } | { kind: 'ribbon'; data: Float32Array | null }) & { settled: boolean }
const memo = new WeakMap<TipStroke, Replayed>()

/** done=true: a committed stroke — full replay, drips settled, memoised.
 *  done=false: the live stroke — `tailMs` of drip time after the last sample (0 while painting). */
export function replayStroke(s: TipStroke, done = true, tailMs = 0): Replayed {
  if (done) { const hit = memo.get(s); if (hit) return hit }
  let out: Replayed
  if (s.tip === 'bristle') out = { kind: 'ribbon', data: bristleRibbon(s, done), settled: true }
  else if (s.tip === 'round') out = { kind: 'dabs', dabs: simulateRound(s).view().slice(), settled: true }
  else { const r = simulateSpray(s, done ? Infinity : tailMs); out = { kind: 'dabs', dabs: r.dabs.view().slice(), settled: r.settled } }
  if (done) memo.set(s, out)
  return out
}
```

- [ ] **Step 4: Implement `engine.ts`**

It uses one shared WebGL2 context on a detached `<canvas>`, created lazily; on `webglcontextlost` it falls back until restored. It is modelled on `lib/compositor/gpuPost.ts`, and `gl.finish()` before handing the canvas out is load-bearing (see that file's TRAP note). It has three programs, ported from the prototype:

1. **dab** (prototype `dabProg`, L484-495):
   - Attributes `aPos` (device px within the view), `aLoc`, `aStr`, `aHard`.
   - Output `vec4(a)` into an **R8** density texture, with blend `ONE, ONE`.
   - For erase groups, the dab program also accumulates into the density; the group composite uses `destination-out` (see `rasterGroup`).
   - Clip mapping: `pos → clip` with `uView` = view w/h in device px, y flipped as in the prototype.
2. **grain** (a full-screen triangle; prototype `layProg` L517-600, material branch removed). It samples density `d` and computes:

   ```glsl
   // grain coordinates are Frame units × 2, so grain is fixed to the picture, not the screen
   vec2 gc = (gl_FragCoord.xy / uUnitPx + uOrigin * vec2(1., -1.)) * 2.;
   float gn = mix(hash(floor(gc)), noise(gc * .5 + uSeed * 50.), .35);
   float a = mix(smoothstep(0., .45, d), smoothstep(gn - .06, gn + .06, d * 1.15), uGrain);
   a *= 1. - uTooth * .16 * smoothstep(.55, .85, noise(gc * .4 + uSeed * 9.));
   ```

   - Coverage output is `vec4(a)` (premultiplied white).
   - Shade output (a second pass writing the same shader with `uMode=1`): the density-gradient normal `N = normalize(vec3(-gx*.35*uRelief, -gy*.35*uRelief, 1.))`, where the gradient is taken at ±1.5 Frame units. `diff = clamp(dot(N,L),0.,1.)*.35+.78`, `spec = pow(clamp(dot(N,H),0.,1.),30.)`, and `lum = (diff - 1.) * min(1., uRelief) + spec * .25 * min(1., uRelief)`. The output is `vec4(vec3(.5 + lum * .5) * a, a)`.
   - Per group: spray has `uGrain=1, uTooth=0`; round has `uGrain=min(1,grain), uTooth=grain`. `uRelief` is the **maximum** `relief` across the group's strokes. The seed is the group's first stroke's `seed % 1000 / 100`.
3. **ribbon** (prototype `ribProg` L403-470; paint branch only, materials and neon removed):
   - `uTime` is fixed at 0, so no flow.
   - Uniforms `uSeed` = stroke `seed % 1000 / 100`, `uLoad = 1 * settings.load`, `uDry = settings.dry`, `uBristle = settings.bristle`, `uRelief = settings.relief`.
   - Coverage pass outputs `vec4(a)`. Shade pass (`uMode=1`) outputs `lum = (diff-1.)*min(1.,uRelief) + spec*.32*min(1.,uRelief) + .25*(bristle-.5)*uBristle`, as `vec4(vec3(.5+lum*.5)*a, a)`.
   - Positions: Frame units → device px via `(p - origin) * unitPx`. `vW` and `vU` stay in Frame units (the shader's noise frequencies were tuned in those units).

`rasterGroup(group, view, liveDone)`:
1. Resize the GL canvas to `view.w × view.h` (cap each side at 8192; if larger, scale `unitPx` down and let the caller's `drawImage` stretch).
2. For dab tips: clear the R8 density FBO. For each stroke, draw `s === live ? replayStroke(s, false, liveTailMs) : replayStroke(s)` dabs mapped `x' = (x - originX) * unitPx` and `r' = max(0.5, r * unitPx)`. Then draw the grain pass to the default framebuffer (coverage), `gl.finish()`, and copy it to a fresh 2D canvas (`drawImage`). If `uRelief > 0`, draw again with `uMode=1` and copy into a shade canvas.
3. For bristle: draw each stroke's ribbon (`TRIANGLE_STRIP`, blend `ONE, ONE_MINUS_SRC_ALPHA`) for coverage, then again with `uMode=1` for shade when `relief > 0`.

**Canvas2D fallback** (no WebGL2 or context lost):
- For dab tips, draw each dab as a filled arc on a 2D canvas: `globalCompositeOperation='lighter'`, `fillStyle` white at alpha `s`, soft dabs (`h < 0.5`) as a radial gradient.
- Then run the grain threshold through `getImageData`, using the same hash formula in JS (`fract(sin(dot(c, vec2(12.9898,78.233)))*43758.5453)` is fine for the fallback; it doesn't need to match the GPU exactly).
- For bristle, draw a tapered polyline: for each ribbon quad, fill the quad.
- There is no shade in the fallback.

- [ ] **Step 5: Implement `coverage.ts`**

```ts
// frontend/app/lib/brushTips/coverage.ts
// Entry point for the Frame's brush branch: tip strokes → one coverage canvas (white, alpha =
// paint) plus an optional shade canvas, both view-sized. Groups composite in order: paint
// groups source-over, erase groups destination-out. Cached per layer key + stroke identity + view.
import type { PaintStroke } from '~/lib/compositor/brushStamp'
import { isTipStroke, type TipStroke } from './record'
import type { TipId } from './tips'
import { rasterGroup } from './engine'

export interface TipGroup { tip: TipId; erase: boolean; strokes: TipStroke[] }
export interface CoverageView { originX: number; originY: number; unitPx: number; w: number; h: number }

export function groupTipStrokes(strokes: (PaintStroke | TipStroke)[]): TipGroup[] {
  const out: TipGroup[] = []
  for (const s of strokes) {
    if (!isTipStroke(s)) continue
    const erase = !!s.erase, last = out[out.length - 1]
    if (!erase && last && !last.erase && last.tip === s.tip) last.strokes.push(s)
    else out.push({ tip: s.tip, erase, strokes: [s] })
  }
  return out
}

interface Entry { sig: string; strokes: readonly unknown[]; coverage: HTMLCanvasElement; shade: HTMLCanvasElement | null }
const cache = new Map<string, Entry>()
const CACHE_MAX = 48

export function renderTipCoverage(key: string, strokes: (PaintStroke | TipStroke)[], view: CoverageView, live?: TipStroke | null, liveTailMs = 0) {
  const all = live ? [...strokes, live] : strokes
  const groups = groupTipStrokes(all)
  if (!groups.length) return null
  const sig = `${view.originX.toFixed(3)}|${view.originY.toFixed(3)}|${view.unitPx.toFixed(5)}|${view.w}x${view.h}|${all.length}`
  const hit = cache.get(key)
  if (!live && hit && hit.sig === sig && hit.strokes.length === all.length && hit.strokes.every((s, i) => s === all[i])) return hit
  const coverage = document.createElement('canvas'); coverage.width = view.w; coverage.height = view.h
  let shade: HTMLCanvasElement | null = null
  const cctx = coverage.getContext('2d')!
  for (const g of groups) {
    const r = rasterGroup(g, view, live ?? null, liveTailMs)
    cctx.globalCompositeOperation = g.erase ? 'destination-out' : 'source-over'
    cctx.drawImage(r.coverage as CanvasImageSource, 0, 0)
    if (r.shade && !g.erase) {
      if (!shade) { shade = document.createElement('canvas'); shade.width = view.w; shade.height = view.h }
      shade.getContext('2d')!.drawImage(r.shade, 0, 0)
    }
  }
  if (shade) { const s = shade.getContext('2d')!; s.globalCompositeOperation = 'destination-in'; s.drawImage(coverage, 0, 0) }
  const entry: Entry = { sig, strokes: all.slice(), coverage, shade }
  if (!live) { cache.delete(key); cache.set(key, entry); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!) }
  return entry
}
```

For the **live stroke**, `replayStroke(live, false, tailMs)` is **not** memoised and is replayed every frame. That is acceptable for Part 1. A 5 s spray is about 20k dabs, around 2 ms to simulate. If profiling in Task 9 shows more than 8 ms per frame, add a live `SpraySim` handle (Task 7's `useBrushPaint` already owns one).

- [ ] **Step 6: Run the unit tests to confirm they pass**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-coverage.unit.spec.ts`
Expected: PASS. Node does not load the engine: `coverage.ts` imports `engine.ts`, which must not touch `document` at module top level.

- [ ] **Step 7: Commit**

Paths: `frontend/app/lib/brushTips/replay.ts frontend/app/lib/brushTips/engine.ts frontend/app/lib/brushTips/coverage.ts frontend/tests/unit/brush-tips-coverage.unit.spec.ts`
Message: `feat(brush): brush tip raster engine (WebGL2 grain and ribbons, Canvas2D fallback) with cache`

---

### Task 6: Draw tip strokes in the Frame's brush branch; tip-aware bounds

**Files:**
- Modify: `frontend/app/lib/compositor/brushStamp.ts` (`strokeBounds`, `PaintStroke` union helpers)
- Modify: `frontend/app/composables/useCompositorLayers.ts:737-745` (`BrushLayer.strokes` type) and `:4808-4859` (brush branch)
- Test: `frontend/tests/unit/brush-tips-bounds.unit.spec.ts`

**Interfaces:**
- Consumes: `TipStroke`, `isTipStroke`, `tipStrokePad`, `decodePts`, `renderTipCoverage`, `REF_W`.
- Produces:
  - `type BrushStroke = PaintStroke | TipStroke`, exported from `brushStamp.ts`.
  - `BrushLayer.strokes: BrushStroke[]`.
  - `strokeBounds(strokes: BrushStroke[])`.
  - `setLiveTipStroke(layerId: string, s: TipStroke | null, tailMs?: number)`, exported from `useCompositorLayers.ts`. The modal calls it so the brush branch folds the in-progress tip stroke in; `tailMs` is drip time after release (0 while painting).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-tips-bounds.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { strokeBounds, brushBoxFromStrokes } from '~/lib/compositor/brushStamp'
import { defaultSettings } from '~/lib/brushTips/tips'
import type { TipStroke } from '~/lib/brushTips/record'

describe('tip-aware strokeBounds', () => {
  it('pads a spray stroke by spread and drips', () => {
    const s: TipStroke = { tip: 'spray', v: 1, size: 0.1, settings: defaultSettings('spray'), seed: 1, pts: [0.5, 0.5, 0, 0.6, 0.5, 100] }
    const b = strokeBounds([s])
    expect(b.minX).toBeLessThan(0.5 - 0.02)
    expect(b.maxX).toBeGreaterThan(0.6 + 0.02)
    expect(b.maxY - 0.5).toBeGreaterThan(0.5 - b.minY)
  })
  it('legacy strokes are unchanged', () => {
    const legacy = { points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }
    expect(strokeBounds([legacy])).toEqual({ minX: 0.19, minY: 0.29, maxX: 0.41, maxY: 0.31 })
    expect(brushBoxFromStrokes([legacy], 1).w).toBeCloseTo(0.22)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-bounds.unit.spec.ts`
Expected: FAIL. The spray bounds come back as `{0,0,0,0}`, because a tip stroke has no `points`.

- [ ] **Step 3: Implement**

In `brushStamp.ts`:
- Import `type TipStroke, isTipStroke, tipStrokePad, decodePts` from `~/lib/brushTips/record`.
- Add `export type BrushStroke = PaintStroke | TipStroke`.
- Change `strokeBounds` and `brushBoxFromStrokes` to take `BrushStroke[]`.
- In the `strokeBounds` loop, before the legacy code:

```ts
    if (isTipStroke(s)) {
      const pad = tipStrokePad(s)
      for (const p of decodePts(s.pts)) {
        if (p.x - pad.side < minX) minX = p.x - pad.side
        if (p.y - pad.up < minY) minY = p.y - pad.up
        if (p.x + pad.side > maxX) maxX = p.x + pad.side
        if (p.y + pad.down > maxY) maxY = p.y + pad.down
      }
      continue
    }
```

- `stampStrokes` keeps its `PaintStroke[]` signature. Callers must pass only legacy strokes.

In `useCompositorLayers.ts`:
- `BrushLayer.strokes: BrushStroke[]`.
- Add at module level, near `_fieldCtx`:

```ts
const _liveTip = new Map<string, { s: TipStroke; tailMs: number }>()
/** The Frame editor's in-progress tip stroke for a brush layer, folded into its render (live preview).
 *  `tailMs` = drip time since release (0 while the pointer is down). */
export function setLiveTipStroke(layerId: string, s: TipStroke | null, tailMs = 0) { if (s) _liveTip.set(layerId, { s, tailMs }); else _liveTip.delete(layerId) }
```

- In the brush branch, replace `if (!layer.strokes.length) return` with `const liveE = _liveTip.get(layer.id) ?? null, live = liveE?.s ?? null; if (!layer.strokes.length && !live) return`. Compute `b = strokeBounds(live ? [...layer.strokes, live] : layer.strokes)`.
- Replace the single `stampStrokes(...)` call with:

```ts
    const legacy = layer.strokes.filter(s => !isTipStroke(s)) as PaintStroke[]
    if (legacy.length) stampStrokes(octx, legacy, W * dpr * scale)
    octx.restore()
    const unitPx = (W * dpr * scale) / REF_W
    const cov = renderTipCoverage(layer.id, layer.strokes, { originX: b.minX * REF_W, originY: b.minY * REF_W, unitPx, w: dw, h: dh }, live, liveE?.tailMs ?? 0)
    if (cov) octx.drawImage(cov.coverage, 0, 0)
```

  Move the existing `octx.restore()` so it closes the `translate` before the coverage `drawImage`: the coverage is already in offscreen space. After the existing `source-in` fill block, before `ctx.drawImage(off, …)`, add:

```ts
    if (cov?.shade) { octx.save(); octx.globalCompositeOperation = 'soft-light'; octx.drawImage(cov.shade, 0, 0); octx.restore() }
```

- A brush with only legacy strokes takes exactly the old code path: `renderTipCoverage` returns `null` with no side effects.

- [ ] **Step 4: Check that every reader of layer JSON tolerates the new stroke shape**

Run: `cd frontend && grep -rn "strokes" app/lib/agent/mergeCompositorState.ts app/lib/agent/surfaces/compositor.ts app/lib/compositor/layerClipboard.ts app/lib/compositor/recolour/sites.ts app/lib/compositor/brushStamp.ts | grep -v "^.*//"`

For each hit that reads `.points` or `.radius` from a brush stroke, guard it with `isTipStroke(s) ? <skip/pass through> : <existing>`. Also run `npx vue-tsc --noEmit -p . 2>&1 | grep -i "brushStamp\|BrushStroke\|strokes" | head -40` (the typecheck baseline has pre-existing errors; see memory `typecheck-baseline-anchoring`). Fix only errors your type change caused.

- [ ] **Step 5: Run the tests to confirm they pass (new + existing brush suites)**

Run: `cd frontend && npx vitest run tests/unit/brush-tips-bounds.unit.spec.ts tests/unit/brush-mask-follow.unit.spec.ts $(ls tests/unit | grep -i brush | sed 's#^#tests/unit/#' | tr '\n' ' ')`
Expected: PASS, with no change in the existing brush suites.

- [ ] **Step 6: Commit**

Paths: `frontend/app/lib/compositor/brushStamp.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/brush-tips-bounds.unit.spec.ts` plus any reader files you guarded.
Message: `feat(brush): draw tip strokes in the Frame brush branch with tip-aware bounds`

---

### Task 7: Brush state: tip, persisted per-tip settings, timestamped samples

**Files:**
- Modify: `frontend/app/composables/useBrushPaint.ts`
- Test: `frontend/tests/unit/brush-paint-tips.unit.spec.ts`

**Interfaces:**
- Consumes: `TIPS`, `TipId`, `defaultSettings`, `REF_W`, `SIZE_MIN`, `SIZE_MAX`, `TipStroke`, `encodePts`, `Sample`, `SpraySim`.
- Produces (added to the `useBrushPaint()` return; existing fields unchanged):

```ts
tip: Ref<TipId>
tipSettings: Record<TipId, Record<string, number>>   // reactive
tipSize: Record<TipId, number>                        // reactive, Frame units (diameter)
resetTipSettings(tip: TipId): void
beginTipStroke(x: number, y: number, tMs: number): void          // x,y width-normalised; captures erase + current tip settings + seed
extendTipStroke(x: number, y: number, tMs: number): void         // appends a sample (skips exact duplicates of x,y AND t)
holdTipStroke(tMs: number): void                                  // appends a sample at the last x,y (dwell while still)
liveTipStroke(): TipStroke | null                                  // the in-progress record (a NEW object each call is NOT required — return the same object, mutated)
endTipStroke(): TipStroke | null
```

Persistence uses `localStorage` key `sailor.brushTips.v1`, holding `{ tip, settings: {spray,round,bristle}, size: {spray,round,bristle} }`. It is read once on creation with try/catch. Unknown keys are dropped and missing keys are filled from the defaults. Writes are debounced (150 ms), watching `tip`, `tipSettings` and `tipSize` deeply.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-paint-tips.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { useBrushPaint } from '~/composables/useBrushPaint'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { decodePts } from '~/lib/brushTips/record'

beforeEach(() => localStorage.clear())

describe('useBrushPaint tips', () => {
  it('starts on the spray can with the tuned defaults', () => {
    const b = useBrushPaint()
    expect(b.tip.value).toBe('spray')
    expect(b.tipSettings.round).toEqual(defaultSettings('round'))
    expect(b.tipSize.spray).toBe(110)
  })
  it('falls back to defaults on bad saved JSON', () => {
    localStorage.setItem('sailor.brushTips.v1', '{nope')
    expect(useBrushPaint().tipSettings.bristle).toEqual(defaultSettings('bristle'))
  })
  it('restores saved settings, dropping unknown keys', () => {
    localStorage.setItem('sailor.brushTips.v1', JSON.stringify({ tip: 'round', settings: { round: { grain: 3, bogus: 1 } }, size: { round: 50 } }))
    const b = useBrushPaint()
    expect(b.tip.value).toBe('round')
    expect(b.tipSettings.round).toEqual({ ...defaultSettings('round'), grain: 3 })
    expect(b.tipSize.round).toBe(50)
  })
  it('records a stroke with a settings snapshot', () => {
    const b = useBrushPaint()
    b.tip.value = 'round'
    b.beginTipStroke(0.1, 0.2, 1000)
    b.extendTipStroke(0.15, 0.2, 1016)
    b.holdTipStroke(1050)
    b.tipSettings.round.grain = 1   // after begin: must NOT leak into this stroke
    const s = b.endTipStroke()!
    expect(s.tip).toBe('round')
    expect(s.settings.grain).toBe(2)
    expect(s.size).toBeCloseTo(36 / REF_W)
    expect(decodePts(s.pts)).toEqual([{ x: 0.1, y: 0.2, t: 0 }, { x: 0.15, y: 0.2, t: 16 }, { x: 0.15, y: 0.2, t: 50 }])
    expect(Number.isInteger(s.seed)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-paint-tips.unit.spec.ts`
Expected: FAIL (`tip` is undefined).

- [ ] **Step 3: Implement.** Add to `useBrushPaint.ts`, keeping every existing export as it is:

```ts
import { reactive, watch } from 'vue'
import { TIPS, TIP_IDS, defaultSettings, REF_W, type TipId } from '~/lib/brushTips/tips'
import { encodePts, type Sample, type TipStroke } from '~/lib/brushTips/record'

const STORE_KEY = 'sailor.brushTips.v1'
function loadTips() {
  const settings = Object.fromEntries(TIP_IDS.map(t => [t, defaultSettings(t)])) as Record<TipId, Record<string, number>>
  const size = Object.fromEntries(TIP_IDS.map(t => [t, TIPS[t].defaultSize])) as Record<TipId, number>
  let tip: TipId = 'spray'
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      if (TIP_IDS.includes(raw.tip)) tip = raw.tip
      for (const t of TIP_IDS) {
        for (const k of Object.keys(settings[t])) { const v = raw.settings?.[t]?.[k]; if (typeof v === 'number' && Number.isFinite(v)) settings[t][k] = v }
        const sz = raw.size?.[t]; if (typeof sz === 'number' && Number.isFinite(sz)) size[t] = sz
      }
    }
  } catch { /* bad or blocked storage: defaults */ }
  return { tip, settings, size }
}
```

Inside `useBrushPaint()`:

```ts
  const saved = loadTips()
  const tip = ref<TipId>(saved.tip)
  const tipSettings = reactive(saved.settings)
  const tipSize = reactive(saved.size)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  watch([tip, tipSettings, tipSize], () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ tip: tip.value, settings: tipSettings, size: tipSize })) } catch { /* ignore */ } }, 150)
  }, { deep: true })
  function resetTipSettings(t: TipId) { Object.assign(tipSettings[t], defaultSettings(t)) }

  let liveTip: TipStroke | null = null
  let samples: Sample[] = []
  let t0 = 0
  function beginTipStroke(x: number, y: number, tMs: number) {
    t0 = tMs
    samples = [{ x, y, t: 0 }]
    liveTip = { tip: tip.value, v: 1, size: tipSize[tip.value] / REF_W, settings: { ...tipSettings[tip.value] }, seed: (Math.random() * 0xffffffff) >>> 0, pts: encodePts(samples), erase: eraser.value || undefined }
  }
  function pushSample(x: number, y: number, tMs: number) {
    if (!liveTip) return
    const t = Math.max(samples[samples.length - 1]!.t, tMs - t0)
    const last = samples[samples.length - 1]!
    if (last.x === x && last.y === y && last.t === t) return
    samples.push({ x, y, t })
    liveTip.pts = encodePts(samples)
  }
  const extendTipStroke = (x: number, y: number, tMs: number) => pushSample(x, y, tMs)
  function holdTipStroke(tMs: number) { const l = samples[samples.length - 1]; if (l) pushSample(l.x, l.y, tMs) }
  const liveTipStroke = () => liveTip
  function endTipStroke() { const s = liveTip; liveTip = null; samples = []; if (s) s.pts = s.pts.slice(); return s }
```

Rounding caveat: `encodePts` rounds to 5 decimal places, so the live record and the saved record are identical by construction. The seed is the one place `Math.random` is allowed, because it is picked at stroke *start* and saved.

Keep `erase: undefined` out of the JSON: build the object, then `if (!eraser.value) delete liveTip.erase`.

Add the new members to the returned object.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && npx vitest run tests/unit/brush-paint-tips.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Paths: `frontend/app/composables/useBrushPaint.ts frontend/tests/unit/brush-paint-tips.unit.spec.ts`
Message: `feat(brush): brush state for tips — remembered settings and sizes, timestamped samples`

---

### Task 8: Brush toolbar and tip settings panel components

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/BrushToolbar.vue`, `frontend/app/components/vue-canvas/compositor/BrushTipSettings.vue`
- Test: `frontend/tests/unit/brush-toolbar.unit.spec.ts`

**Interfaces:**
- Consumes: the `useBrushPaint()` return (Task 7), passed as prop `brush`. `TIPS`, `TIP_IDS`, `SIZE_MIN`, `SIZE_MAX`, `MASK_HINT`. Existing `StudioColor` (`~/components/studio/StudioColor.vue` or whatever `CompositorModal.vue` imports; match its import path). Existing `StudioSlider` (same).
- Produces:
  - `<BrushToolbar :brush="brush" @done="…" />`, with `data-testid="brush-toolbar"`.
  - `<BrushTipSettings :brush="brush" />`, with `data-testid="brush-tip-settings"`.

**Look:** match `PenToolbar.vue` (read it first). It is the same rounded dark bar (`bg-[#1a1a1a]/95 rounded-[12px] p-1.5 border border-[#2a2a2a] shadow-lg`), with the hint line under it in `text-[11px] text-white/50`. The rows must wrap at laptop widths (`flex-wrap min-w-0`; see memory `shared-pen-plan-a-landed`).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/brush-toolbar.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BrushToolbar from '~/components/vue-canvas/compositor/BrushToolbar.vue'
import BrushTipSettings from '~/components/vue-canvas/compositor/BrushTipSettings.vue'
import { useBrushPaint } from '~/composables/useBrushPaint'

beforeEach(() => localStorage.clear())

describe('BrushToolbar', () => {
  it('switches tips and shows the tip hint', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush } })
    expect(w.text()).toContain('Spray can')
    expect(w.text()).toContain('Hold still and the paint pools')
    await w.get('[data-testid="brush-tip-round"]').trigger('click')
    expect(brush.tip.value).toBe('round')
    expect(w.text()).toContain('A clean round brush')
  })
  it('shows the mask hint and hides tips in Mask mode', async () => {
    const brush = useBrushPaint()
    brush.mode.value = 'mask'
    const w = mount(BrushToolbar, { props: { brush } })
    expect(w.find('[data-testid="brush-tip-round"]').exists()).toBe(false)
    expect(w.text()).toContain('Paint to hide part of the selected layer')
  })
})

describe('BrushTipSettings', () => {
  it('lists the current tip settings as percentages and resets', async () => {
    const brush = useBrushPaint()
    brush.tip.value = 'bristle'
    const w = mount(BrushTipSettings, { props: { brush } })
    expect(w.text()).toContain('Speed thinning')
    expect(w.text()).toContain('15%')
    brush.tipSettings.bristle.thin = 1
    await w.vm.$nextTick()
    expect(w.text()).toContain('100%')
    await w.get('[data-testid="brush-tip-reset"]').trigger('click')
    expect(brush.tipSettings.bristle.thin).toBe(0.15)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd frontend && npx vitest run tests/unit/brush-toolbar.unit.spec.ts`
Expected: FAIL (component not found).

- [ ] **Step 3: Implement the components.**

`BrushToolbar.vue`:
- Props: `{ brush: ReturnType<typeof useBrushPaint> }`. Emits `done`.
- In **Paint** mode:
  - A segmented tip picker, 3 buttons with `data-testid="brush-tip-<id>"` and `aria-pressed`.
  - A Size range input bound to `brush.tipSize[brush.tip]` (min `SIZE_MIN`, max `SIZE_MAX`, step 1), with the value shown as a number and `data-testid="brush-size"`.
  - A colour swatch (`StudioColor` bound to `brush.color`).
- In both modes:
  - An Eraser toggle (`data-testid="brush-eraser"`).
  - Paint / Mask segmented (`data-testid="brush-mode-paint"` / `-mask`).
  - A **Done** button (`data-testid="brush-done"`) that emits `done`.
- In **Mask** mode, instead of the tip picker and colour: Size bound to the legacy `brush.sizePx` (2–240).
- The hint line is `TIPS[brush.tip].hint`, or `MASK_HINT` in Mask mode.

`BrushTipSettings.vue`:
- Props: `{ brush }`.
- Header row: `Brush · {{ TIPS[tip].label }}`.
- For each `TIPS[tip].settings` entry, a labelled range 0..max×100 (step 5), showing `Math.round(v*100)%`, bound to `brush.tipSettings[tip][key]` (stored as a fraction).
- Under the sliders, one line: "Changes apply to your next stroke."
- A "Reset to defaults" button (`data-testid="brush-tip-reset"`) calls `brush.resetTipSettings(tip)`.
- Use `StudioSlider` if its API supports a percent display; otherwise a plain `<input type="range">` styled like the legacy brush branch's "Soft" row (`CompositorModal.vue` ~L10027).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && npx vitest run tests/unit/brush-toolbar.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Paths: the two `.vue` files + the test.
Message: `feat(brush): bottom brush toolbar and per-tip settings panel`

---

### Task 9: Wire it into the Frame editor

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`:
  - imports (~L92)
  - brush pointer handlers `onBrushPointerDown/Move/Up` (~L6918-6988)
  - live preview (~L5785-5800)
  - bottom cluster (~L9306-9330)
  - right-panel brush branch (~L9999-10036)

**Interfaces:**
- Consumes: `useBrushPaint` additions (Task 7), `BrushToolbar`, `BrushTipSettings` (Task 8), `setLiveTipStroke` (Task 6), `SpraySim` (Task 2, only to detect settling), `brushBoxFromStrokes`, `createBrushLayer`.

- [ ] **Step 1: Read the current handlers first.** Run `sed -n 6900,6990p` and `sed -n 5780,5805p` on the modal, and trace `activeBrushLayer()`, `commit`/history calls, `toWidthNorm` and `clientToNorm` usage. Everything below must reuse those helpers.

- [ ] **Step 2: Pointer handlers (Paint mode only; Mask mode keeps the existing code path untouched).**
  - **Down:** convert to width-normalised coordinates exactly as today. Call `brush.beginTipStroke(x, y, e.timeStamp)`. Pick the target layer as today: `activeBrushLayer()`, or create one on first paint with `createBrushLayer({ fill: brush.color.value })`, **without** committing history yet. Call `setLiveTipStroke(targetId, brush.liveTipStroke())`. Start a rAF loop `holdLoop` while the pointer is down that calls `brush.holdTipStroke(performance.now() - offset)`, where `offset` maps `performance.now()` onto the `e.timeStamp` clock (they share a timebase in modern browsers; use `e.timeStamp` directly for events and `performance.now()` in rAF), then requests a render.
  - **Move:** for each `e.getCoalescedEvents?.() ?? [e]`, call `brush.extendTipStroke(x, y, ev.timeStamp)`, then request a render.
  - **Up / cancel:** stop `holdLoop`. Take `const s = brush.endTipStroke()`.
    - **Spray only:** let drips run before committing. Record `releaseT = performance.now()`. On each rAF, set `tailMs = performance.now() - releaseT`, call `setLiveTipStroke(id, s, tailMs)` and request a render. Stop when `replayStroke(s, false, tailMs).settled` or `tailMs >= 2000` (check with `simulateSpray(s, tailMs).settled` once per frame; it is cheap). The committed stroke then replays with drips fully settled, identical to the last live frame.
    - **All tips:** then `setLiveTipStroke(id, null)`, append `s` to the layer's strokes, re-fit the box with `brushBoxFromStrokes(strokes, aspect)` as today (CM ~L6972-6987), and commit **one** history step.
    - If the tool closes (B, Done, Escape) mid-stroke, end and commit immediately.
  - An **eraser** stroke with no brush layer selected does nothing (no layer is created).
- [ ] **Step 3: Live preview.** The block at ~L5785 folds legacy live strokes into a temporary layer. For tip strokes, keep that block **only** for Mask mode; Paint mode now goes through `setLiveTipStroke`. For a brand-new layer that doesn't exist yet, create it with `strokes: []` in the render list (the existing temp-layer mechanism) and register the live stroke on its id.
- [ ] **Step 4: Toolbar.** In the bottom cluster, next to `<PenToolbar v-if="penSession" …>`, add `<BrushToolbar v-if="brush.active.value && !penSession" :brush="brush" class="pointer-events-auto" @done="toggleBrush" />`. Hide the tool row (`v-show="!penSession && !brush.active.value"`) and the prompt dock (`v-show="editMode === 'none' && !penSession && !brush.active.value"`) while the brush is active.
- [ ] **Step 5: Right panel.** In the `v-else-if="brush.active.value"` branch:
  - **Paint mode:** render `<BrushTipSettings :brush="brush" />` below the header and remove the Paint/Mask pills, colour, Size, Flow, Soft and Eraser (they now live in the toolbar).
  - **Mask mode:** keep the existing "Select a layer to mask" note, Clear mask, Size, Flow and Soft rows exactly as they are.
- [ ] **Step 6: Typecheck the touched files.** Run `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "CompositorModal|useBrushPaint|brushTips|BrushToolbar|BrushTipSettings" | head -40`. Fix only new errors.
- [ ] **Step 7: Run the unit suite.** Run `cd frontend && npx vitest run tests/unit/ 2>&1 | tail -15`. The failures must match the baseline taken before Task 1 (see memory `unit-suite-green-2026-09-20` and `vitest-counts-lie-under-load`). If counts differ, re-run the named files alone.
- [ ] **Step 8: Commit**

Paths: `frontend/app/components/vue-canvas/CompositorModal.vue` only.
Message: `feat(brush): Frame brush uses spray can, round and bristle tips with toolbar and settings panel`

---

### Task 10: Real-browser verification (controller runs this, not a subagent)

This task does not use `npm run dev`. It uses the existing dev server for the main checkout on `:3002`; check it with `lsof -nP -iTCP:3002 -sTCP:LISTEN`. If that server is broken, stop and ask Julien.

- [ ] Open a Frame and pick the Brush (B). Using a **real mouse** (Playwright `page.mouse` on the running app, or the browser pane by ref):
  - spray-can stroke with a 1.5 s hold → drips visible;
  - Round stroke;
  - Bristle zig-zag;
  - eraser pass with the spray can.

  Screenshot each.
- [ ] Undo once: the last stroke disappears as one step.
- [ ] Save, reload the page and reopen the Frame. Read the brush canvas pixels before and after (`toDataURL` of the modal canvas region, compare hashes). They must be identical.
- [ ] Static export at 2×: grain is visible at the same scale relative to the picture.
- [ ] An existing Frame with an old brush layer renders unchanged (compare against a screenshot taken before Task 6 landed; take it at the start of Task 6).
- [ ] Check toolbar layout at 1280 and 1024 wide: no overflow, and the rows wrap.
- [ ] Update `docs/STATE.md` and the State of the Build dashboard (memory `update-dashboard-on-every-commit`).
