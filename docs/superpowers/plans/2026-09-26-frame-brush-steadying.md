# Frame brush — steadying and hold to snap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Frame brush steadies a trackpad hand (Streamline, Stabilisation, Motion filtering) for every tip, and Round/Bristle strokes held still at the end snap to a line, arc, ellipse/circle or shape. Controls live in the brush inspector.

**Cache note:** replacing the live stroke's samples needs no cache work. `coverage.ts`'s live prefix excludes the live stroke, and live round/bristle strokes are re-simulated from their samples every frame (`replay.ts`). Only spray keeps an incremental live sim, and the spray can never snaps.

**Architecture:**
- Two pure modules sit between the pointer and the existing tip-sample API:
  - `lib/brushTips/steady.ts` turns client-pixel pointer samples into steadied samples;
  - `lib/brushTips/quickShape.ts` fits a held stroke to a shape and emits its points, with even timing.
- `useBrushPaint` owns the settings (persisted) and gains `replaceTipSamples`.
- CompositorModal routes pointer samples through a `Steadier`, drives catch-up and the hold timer from its existing hold loop, and replaces the live stroke's samples when it snaps.
- The saved `TipStroke` format is unchanged.

**Tech Stack:** Vue 3 + TypeScript, Vitest, Playwright (against the running :3002 app).

**Spec:** `docs/superpowers/specs/2026-09-26-frame-brush-steadying-design.md`
**Prototype (the behaviour to port):** `docs/superpowers/specs/assets/2026-09-26-brush-steady-prototype.html`. Search for `steadyIn`, `stepStreamline`, `fitShape`, `shapePts`, `editSnap`, `regen`.

## Global Constraints

- **Defaults.** Streamline 30%, Stabilisation 15%, Motion filtering 40%, Hold to snap on, Hold time 0.63 s.
  - Stored as `{ streamline: 0.3, stabilise: 0.15, filter: 0.4, snap: true, hold: 0.5 }`.
  - Hold time in ms = `250 + hold * 750`.
- **Steadying applies to** every tip (spray, round, bristle), in Paint and Effect mode, including the eraser. Mask mode (legacy dabs) is unchanged.
- **Hold to snap** applies to Round and Bristle only, never the spray can. It needs the stroke's path to be longer than 30 px on screen.
- **A stroke saves the steadied path.** A snapped stroke saves the shape's path at the stroke's median speed.
  - `TipStroke` stays v 1, unchanged.
  - Changing the settings affects the next stroke only.
- **Release catch-up** (Streamline > 0) lasts at most 350 ms, with the time constant × 0.3, then the stroke commits. A snapped stroke commits immediately on release.
- **Persistence:** `sailor.brushTips.v1`, key `steady`. Bad values fall back to the defaults.
- **Inspector copy** (sentence case; explanations only as `title` tooltips; no visible explanatory sentences):
  - Section header: "Steadying".
  - Rows: "Streamline", "Stabilisation", "Motion filtering", "Hold to snap" (a switch), "Hold time" (shown as seconds with 2 decimals, e.g. "0.63 s"; hidden when Hold to snap is off).
  - Button: "Reset".
- **Tooltips (exact):**
  - Streamline: "The brush trails your finger a little and catches up, so curves come out smooth."
  - Stabilisation: "Averages the path, so slow careful strokes lose their wobble."
  - Motion filtering: "Removes small jitter without adding lag to fast strokes."
  - Hold to snap: "Round and bristle: stop at the end of a stroke and keep holding to snap it to a line, arc, ellipse or shape. Keep holding and move to adjust. Shift makes a circle or a 15° line."
  - Hold time: "How long to hold still before it snaps."
- **Canvas feedback:**
  - A hold ring (radius 12 px, 2.5 px stroke) appears after 150 ms still and fills over the rest of the hold time.
  - Once snapped, a tag near the cursor reads exactly "Line", "Arc", "Ellipse", "Circle" or "Shape".
  - No hand trail, no tether.
- **Repo rules:**
  - Work in the main checkout. Never `git stash`. Never `npm run dev`.
  - Commit with a private index (`git read-tree HEAD`, `git add` exact paths, commit), then `git reset -q -- <paths>` in a separate call.
  - `CompositorModal.vue` goes through the snapshot → patch recipe, because other sessions keep uncommitted edits in it.
  - Unit tests: `cd frontend && npx vitest run <file>`. The alias `~` is `frontend/app`.

---

### Task 1: `steady.ts` — the steadying pipeline

**Files:**
- Create: `frontend/app/lib/brushTips/steady.ts`
- Test: `frontend/tests/unit/brush-steady.unit.spec.ts`

**Interfaces:**
- Produces:
  - `SteadySettings`, `STEADY_DEFAULTS`, `holdMsOf(hold: number): number`, `isSteadySettings`-style sanitiser `sanitizeSteady(raw: unknown): SteadySettings`;
  - `class Steadier { constructor(s: SteadySettings, x: number, y: number, t: number); input(x: number, y: number, t: number): Pt[]; advance(now: number, releasing?: boolean): { samples: TPt[]; caughtUp: boolean }; readonly pen: Pt; readonly target: Pt }`;
  - `class HoldWatch { constructor(x: number, y: number, t: number); move(x: number, y: number, t: number): void; stillFor(now: number): number }`.
- Types: `Pt = { x: number; y: number }`, `TPt = Pt & { t: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/brush-steady.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { Steadier, HoldWatch, STEADY_DEFAULTS, holdMsOf, sanitizeSteady } from '~/lib/brushTips/steady'

const OFF = { ...STEADY_DEFAULTS, streamline: 0, stabilise: 0, filter: 0 }
const jittery = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 3, y: 100 + (i % 2 ? 2.5 : -2.5), t: i * 8 }))
const wobble = (pts: { y: number }[]) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.abs(pts[i]!.y - pts[i - 1]!.y); return s / (pts.length - 1) }

describe('steady', () => {
  it('defaults and hold time', () => {
    expect(STEADY_DEFAULTS).toEqual({ streamline: 0.3, stabilise: 0.15, filter: 0.4, snap: true, hold: 0.5 })
    expect(holdMsOf(0)).toBe(250); expect(holdMsOf(1)).toBe(1000); expect(holdMsOf(0.5)).toBe(625)
  })
  it('all at zero passes samples through untouched', () => {
    const s = new Steadier(OFF, 0, 100, 0)
    for (const p of jittery(20)) expect(s.input(p.x, p.y, p.t)).toEqual([{ x: p.x, y: p.y }])
  })
  it('filtering and stabilisation reduce jitter', () => {
    const s = new Steadier({ ...OFF, filter: 0.4, stabilise: 0.15 }, 0, 100, 0)
    const out = jittery(60).flatMap(p => s.input(p.x, p.y, p.t))
    expect(wobble(out)).toBeLessThan(wobble(jittery(60)) * 0.5)
  })
  it('streamline emits nothing on input, then catches up on advance', () => {
    const s = new Steadier({ ...OFF, streamline: 0.3 }, 0, 0, 0)
    expect(s.input(100, 0, 10)).toEqual([])
    const a = s.advance(26)
    expect(a.samples.length).toBeGreaterThan(0)
    expect(a.samples.at(-1)!.x).toBeGreaterThan(0); expect(a.samples.at(-1)!.x).toBeLessThan(100)
    const b = s.advance(2000)
    expect(b.samples.at(-1)!.x).toBeGreaterThan(99)
    for (const smp of [...a.samples, ...b.samples]) expect(smp.t).toBeGreaterThan(0)
  })
  it('releasing catches up faster', () => {
    const slow = new Steadier({ ...OFF, streamline: 0.5 }, 0, 0, 0), fast = new Steadier({ ...OFF, streamline: 0.5 }, 0, 0, 0)
    slow.input(100, 0, 1); fast.input(100, 0, 1)
    expect(fast.advance(60, true).samples.at(-1)!.x).toBeGreaterThan(slow.advance(60).samples.at(-1)!.x)
  })
  it('caughtUp once within 0.6 px', () => {
    const s = new Steadier({ ...OFF, streamline: 0.2 }, 0, 0, 0); s.input(10, 0, 1)
    expect(s.advance(5000).caughtUp).toBe(true)
  })
  it('hold watch: still time resets on a move over 3 px', () => {
    const h = new HoldWatch(0, 0, 0)
    h.move(2, 0, 100); expect(h.stillFor(500)).toBe(500)
    h.move(6, 0, 600); expect(h.stillFor(700)).toBe(100)
  })
  it('sanitises stored settings', () => {
    expect(sanitizeSteady(null)).toEqual(STEADY_DEFAULTS)
    expect(sanitizeSteady({ streamline: 2, stabilise: -1, filter: 'x', snap: 0, hold: 0.8 }))
      .toEqual({ streamline: 1, stabilise: 0, filter: 0.4, snap: true, hold: 0.8 })
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && npx vitest run tests/unit/brush-steady.unit.spec.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** This is a port of the prototype's `oneEuro`, `euro`, `steadyIn` and `stepStreamline`, with the same constants.

```ts
// frontend/app/lib/brushTips/steady.ts
// Steadying a trackpad hand before it paints, in client pixels: motion filtering (a One Euro
// filter: removes jitter when slow, no lag when fast) → stabilisation (a recency-weighted average
// over a short time window) → Streamline (the brush chases the result and catches up).
// Ported from docs/superpowers/specs/assets/2026-09-26-brush-steady-prototype.html.

export interface SteadySettings { streamline: number; stabilise: number; filter: number; snap: boolean; hold: number }
export const STEADY_DEFAULTS: SteadySettings = { streamline: 0.3, stabilise: 0.15, filter: 0.4, snap: true, hold: 0.5 }
export type Pt = { x: number; y: number }
export type TPt = Pt & { t: number }

export const holdMsOf = (hold: number) => Math.round(250 + hold * 750)
const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d)
export function sanitizeSteady(raw: unknown): SteadySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const D = STEADY_DEFAULTS
  return {
    streamline: unit(r.streamline, D.streamline), stabilise: unit(r.stabilise, D.stabilise), filter: unit(r.filter, D.filter),
    snap: typeof r.snap === 'boolean' ? r.snap : D.snap, hold: unit(r.hold, D.hold),
  }
}

type Euro = { x: number | null; dx: number; t: number }
function euro(f: Euro, v: number, t: number, minCut: number, beta: number): number {
  if (f.x === null) { f.x = v; f.t = t; return v }
  const dt = Math.max(1e-3, (t - f.t) / 1000); f.t = t
  const al = (c: number) => { const r = 2 * Math.PI * c * dt; return r / (r + 1) }
  f.dx += al(1) * ((v - f.x) / dt - f.dx)
  f.x += al(minCut + beta * Math.abs(f.dx)) * (v - f.x)
  return f.x
}

export const STREAMLINE_TAU_MS = 220
export const STABILISE_WINDOW_MS = 220
export const RELEASE_TAU_SCALE = 0.3

export class Steadier {
  private fx: Euro = { x: null, dx: 0, t: 0 }
  private fy: Euro = { x: null, dx: 0, t: 0 }
  private buf: TPt[] = []
  private penT: number
  pen: Pt
  target: Pt
  private s: SteadySettings
  constructor(s: SteadySettings, x: number, y: number, t: number) {
    this.s = s
    this.pen = { x, y }; this.target = { x, y }; this.penT = t
    this.fx.x = null; this.fy.x = null
    euro(this.fx, x, t, 1, 0); euro(this.fy, y, t, 1, 0)
  }
  private get streaming() { return this.s.streamline > 0.001 }
  /** A raw pointer sample. Without Streamline, returns the steadied sample to paint now;
   *  with it, only moves the target (advance() paints the catch-up). */
  input(x: number, y: number, t: number): Pt[] {
    let q: Pt = { x, y }
    if (this.s.filter > 0.001) {
      const minCut = 0.25 + (1 - this.s.filter) * 7
      q = { x: euro(this.fx, x, t, minCut, 0.012), y: euro(this.fy, y, t, minCut, 0.012) }
    }
    if (this.s.stabilise > 0.001) {
      const win = this.s.stabilise * STABILISE_WINDOW_MS
      this.buf.push({ ...q, t })
      while (this.buf.length > 1 && t - this.buf[0]!.t > win) this.buf.shift()
      let sx = 0, sy = 0, sw = 0
      for (const b of this.buf) { const w = 1 + (b.t - (t - win)) / Math.max(1, win); sx += b.x * w; sy += b.y * w; sw += w }
      q = { x: sx / sw, y: sy / sw }
    }
    this.target = q
    if (this.streaming) return []
    this.pen = { ...q }; this.penT = t
    return [{ ...q }]
  }
  /** Streamline catch-up up to `now` (performance.now() / event timebase). */
  advance(now: number, releasing = false): { samples: TPt[]; caughtUp: boolean } {
    const out: TPt[] = []
    if (this.streaming) {
      const tau = this.s.streamline * STREAMLINE_TAU_MS * (releasing ? RELEASE_TAU_SCALE : 1)
      const dt = Math.max(0, now - this.penT), n = Math.max(1, Math.min(8, Math.ceil(dt / 4)))
      for (let i = 1; i <= n; i++) {
        const t = this.penT + dt * i / n, k = 1 - Math.exp(-(dt / n) / Math.max(1, tau))
        const nx = this.pen.x + (this.target.x - this.pen.x) * k, ny = this.pen.y + (this.target.y - this.pen.y) * k
        if (Math.hypot(nx - this.pen.x, ny - this.pen.y) < 0.05) break
        this.pen = { x: nx, y: ny }; out.push({ x: nx, y: ny, t })
      }
      this.penT = Math.max(this.penT, now)
    }
    return { samples: out, caughtUp: Math.hypot(this.target.x - this.pen.x, this.target.y - this.pen.y) < 0.6 }
  }
}

/** Is the finger holding still? A move over 3 px restarts the clock. */
export class HoldWatch {
  private ax: number; private ay: number; private at: number
  constructor(x: number, y: number, t: number) { this.ax = x; this.ay = y; this.at = t }
  move(x: number, y: number, t: number) { if (Math.hypot(x - this.ax, y - this.ay) > 3) { this.ax = x; this.ay = y; this.at = t } }
  stillFor(now: number) { return Math.max(0, now - this.at) }
}
```

- [ ] **Step 4: Run the tests.** Expected: PASS. If "caughtUp" or "releasing catches up faster" fails because of the 8-substep cap, that behaviour matches the prototype: adjust only the test's timestamps, never the constants.
- [ ] **Step 5: Commit** `feat(brush): steadying pipeline (streamline, stabilisation, motion filtering)`.

---

### Task 2: `quickShape.ts` — fit, adjust and draw a snapped shape

**Files:**
- Create: `frontend/app/lib/brushTips/quickShape.ts`
- Test: `frontend/tests/unit/brush-quickshape.unit.spec.ts`

**Interfaces:**
- Consumes: `Pt`, `TPt` from `./steady`.
- Produces:
  - `type Shape`: a union of `line` / `arc` / `ellipse` / `circle` / `shape`;
  - `fitShape(path: Pt[]): Shape | null`;
  - `adjustShape(base: Shape, cursor0: Pt, cursor: Pt, shift: boolean): Shape`;
  - `shapePoints(s: Shape, shift: boolean): Pt[]`;
  - `shapeLabel(s: Shape, shift: boolean): 'Line' | 'Arc' | 'Ellipse' | 'Circle' | 'Shape'`;
  - `medianSpeed(samples: TPt[]): number` (px/ms);
  - `timedSamples(pts: Pt[], speed: number): TPt[]` (t starts at 0 and increases by distance ÷ speed).

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/brush-quickshape.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { fitShape, adjustShape, shapePoints, shapeLabel, medianSpeed, timedSamples } from '~/lib/brushTips/quickShape'

let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
const line = Array.from({ length: 50 }, (_, i) => ({ x: 100 + i * 6, y: 200 + rnd() * 4 }))
const arc = Array.from({ length: 50 }, (_, i) => { const a = Math.PI * (0.1 + 0.8 * i / 49); return { x: 300 + Math.cos(a) * 150 + rnd() * 2, y: 400 - Math.sin(a) * 150 + rnd() * 2 } })
const ellipse = Array.from({ length: 80 }, (_, i) => { const a = i / 79 * Math.PI * 2 * 1.02; return { x: 300 + Math.cos(a) * 160 + rnd() * 3, y: 300 + Math.sin(a) * 90 + rnd() * 3 } })
const circle = Array.from({ length: 80 }, (_, i) => { const a = i / 79 * Math.PI * 2 * 1.02; return { x: 300 + Math.cos(a) * 100 + rnd() * 2, y: 300 + Math.sin(a) * 100 + rnd() * 2 } })
const tri = (() => { const V = [{ x: 100, y: 400 }, { x: 250, y: 120 }, { x: 400, y: 400 }, { x: 104, y: 398 }]; const out = []; for (let k = 0; k < 3; k++) for (let i = 0; i < 30; i++) { const a = V[k]!, b = V[k + 1]!; out.push({ x: a.x + (b.x - a.x) * i / 30, y: a.y + (b.y - a.y) * i / 30 }) } out.push(V[3]!); return out })()
const scribble = Array.from({ length: 60 }, (_, i) => ({ x: 100 + i * 4, y: 200 + Math.sin(i * 0.9) * 40 }))

describe('quickShape', () => {
  it('recognises a wobbly line', () => { const s = fitShape(line)!; expect(s.kind).toBe('line'); expect(shapeLabel(s, false)).toBe('Line') })
  it('recognises an arc', () => { expect(fitShape(arc)!.kind).toBe('arc') })
  it('recognises an ellipse and a circle', () => {
    expect(fitShape(ellipse)!.kind).toBe('ellipse')
    expect(fitShape(circle)!.kind).toBe('circle')
    expect(shapeLabel(fitShape(ellipse)!, true)).toBe('Circle')
  })
  it('recognises a closed triangle as a shape with corners', () => {
    const s = fitShape(tri)!; expect(s.kind).toBe('shape'); expect(shapeLabel(s, false)).toBe('Shape')
  })
  it('a scribble is a shape or nothing, never a line/arc/ellipse', () => {
    const s = fitShape(scribble); expect(s === null || s.kind === 'shape').toBe(true)
  })
  it('too short to snap', () => { expect(fitShape([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 1 }, { x: 12, y: 0 }])).toBeNull() })
  it('a line end follows the cursor; shift snaps to 15°', () => {
    const s = fitShape(line)!, end = line.at(-1)!
    const moved = adjustShape(s, end, { x: end.x + 10, y: end.y + 40 }, false)
    const pts = shapePoints(moved, false); expect(pts.at(-1)!.y).toBeGreaterThan(end.y + 30)
    const snapped = shapePoints(adjustShape(s, end, { x: end.x + 10, y: end.y + 7 }, true), true)
    const a = Math.atan2(snapped.at(-1)!.y - snapped[0]!.y, snapped.at(-1)!.x - snapped[0]!.x) / (Math.PI / 12)
    expect(Math.abs(a - Math.round(a))).toBeLessThan(1e-6)
  })
  it('an ellipse resizes around its centre', () => {
    const s = fitShape(ellipse)!, c0 = ellipse.at(-1)!
    const big = shapePoints(adjustShape(s, c0, { x: 300 + (c0.x - 300) * 1.5, y: 300 + (c0.y - 300) * 1.5 }, false), false)
    const r = (P: { x: number; y: number }[]) => Math.max(...P.map(p => Math.hypot(p.x - 300, p.y - 300)))
    expect(r(big) / r(shapePoints(s, false))).toBeGreaterThan(1.4)
  })
  it('shift draws an ellipse as a circle', () => {
    const P = shapePoints(fitShape(ellipse)!, true), d = P.map(p => Math.hypot(p.x - 300, p.y - 300))
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(6)
  })
  it('shape points are dense and a closed ellipse overlaps its start', () => {
    const P = shapePoints(fitShape(circle)!, false)
    for (let i = 1; i < P.length; i++) expect(Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y)).toBeLessThan(4)
    expect(Math.hypot(P.at(-1)!.x - P[0]!.x, P.at(-1)!.y - P[0]!.y)).toBeLessThan(25)
  })
  it('timing: median speed and even samples', () => {
    const samples = [0, 1, 2, 3, 4].map(i => ({ x: i * 10, y: 0, t: i * 20 }))
    expect(medianSpeed(samples)).toBeCloseTo(0.5)
    const T = timedSamples([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 }], 0.5)
    expect(T.map(s => s.t)).toEqual([0, 20, 60])
    expect(medianSpeed([{ x: 0, y: 0, t: 0 }])).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** This is a port of the prototype's `evenPts`, `plen`, `circ`, `rdp`, `fitShape`, `shapePts` and `editSnap`, with the same thresholds:
  - closed if `Lp > 80 && chord < max(24, 0.2·Lp)`;
  - ellipse if the residual is < 0.11; circle if a/b < 1.12;
  - line if deviation ÷ chord < 0.06 (and chord ≥ 20);
  - arc if the residual is < 0.07 and r < 8·chord;
  - RDP ε = `max(6, 0.06·diag)`;
  - ellipse sweep 1.03 turns;
  - point spacing 2 px.

```ts
// frontend/app/lib/brushTips/quickShape.ts
// Hold to snap: fit a held stroke (client px) to a line, arc, ellipse/circle or a shape with
// corners; adjust it while held; draw it as dense points. Ported from the prototype
// (docs/superpowers/specs/assets/2026-09-26-brush-steady-prototype.html: fitShape, shapePts, editSnap).
import type { Pt, TPt } from './steady'

export type Shape =
  | { kind: 'line'; A: Pt; B: Pt }
  | { kind: 'arc'; A: Pt; M: Pt; B: Pt }
  | { kind: 'ellipse' | 'circle'; cx: number; cy: number; a: number; b: number; th: number; phase: number; dir: 1 | -1 }
  | { kind: 'shape'; V: Pt[]; closed: boolean; cx: number; cy: number }

export function evenPts(P: Pt[], step: number): Pt[] {
  const out: Pt[] = [{ x: P[0]!.x, y: P[0]!.y }]; let carry = 0
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1]!, b = P[i]!, L = Math.hypot(b.x - a.x, b.y - a.y); let d = step - carry
    while (d <= L) { const t = d / L; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); d += step }
    carry = L - (d - step)
  }
  const last = P[P.length - 1]!, o = out[out.length - 1]!
  if (Math.hypot(last.x - o.x, last.y - o.y) > 0.5) out.push({ x: last.x, y: last.y })
  return out
}
const plen = (P: Pt[]) => { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y); return L }
function circ(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-6) return null
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x, y, r: Math.hypot(a.x - x, a.y - y) }
}
function rdp(P: Pt[], eps: number): Pt[] {
  if (P.length < 3) return P.slice()
  const a = P[0]!, b = P[P.length - 1]!, L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  let mi = 0, md = 0
  for (let i = 1; i < P.length - 1; i++) { const d = Math.abs((b.x - a.x) * (a.y - P[i]!.y) - (a.x - P[i]!.x) * (b.y - a.y)) / L; if (d > md) { md = d; mi = i } }
  if (md <= eps) return [a, b]
  return rdp(P.slice(0, mi + 1), eps).slice(0, -1).concat(rdp(P.slice(mi), eps))
}

export function fitShape(raw: Pt[]): Shape | null {
  if (raw.length < 2) return null
  const Q = evenPts(raw, 3), n = Q.length
  if (n < 4) return null
  const Lp = plen(Q), A = Q[0]!, B = Q[n - 1]!, chord = Math.hypot(B.x - A.x, B.y - A.y)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const q of Q) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y) }
  const diag = Math.hypot(x1 - x0, y1 - y0)
  if (Lp > 80 && chord < Math.max(24, 0.2 * Lp)) {
    let cx = 0, cy = 0; for (const q of Q) { cx += q.x; cy += q.y } cx /= n; cy /= n
    let sxx = 0, syy = 0, sxy = 0; for (const q of Q) { const dx = q.x - cx, dy = q.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy }
    const th = 0.5 * Math.atan2(2 * sxy / n, (sxx - syy) / n), c = Math.cos(th), s = Math.sin(th)
    let va = 0, vb = 0; for (const q of Q) { const dx = q.x - cx, dy = q.y - cy, u = dx * c + dy * s, v = -dx * s + dy * c; va += u * u; vb += v * v }
    const a = Math.sqrt(2 * va / n), b = Math.sqrt(2 * vb / n)
    let res = 0, area = 0
    for (let i = 0; i < n; i++) {
      const q = Q[i]!, dx = q.x - cx, dy = q.y - cy, u = dx * c + dy * s, v = -dx * s + dy * c
      res += Math.abs(1 - Math.hypot(u / a, v / b)); const q2 = Q[(i + 1) % n]!; area += q.x * q2.y - q2.x * q.y
    }
    res /= n
    if (res < 0.11) {
      const du = (A.x - cx) * c + (A.y - cy) * s, dv = -(A.x - cx) * s + (A.y - cy) * c
      return { kind: a / b < 1.12 ? 'circle' : 'ellipse', cx, cy, a, b, th, phase: Math.atan2(dv / b, du / a), dir: area >= 0 ? 1 : -1 }
    }
    const V = rdp(Q, Math.max(6, 0.06 * diag)); V[V.length - 1] = { ...V[0]! }
    return V.length >= 4 ? { kind: 'shape', V, closed: true, cx, cy } : null
  }
  if (chord < 20) return null
  let md = 0; for (const q of Q) md = Math.max(md, Math.abs((B.x - A.x) * (A.y - q.y) - (A.x - q.x) * (B.y - A.y)) / chord)
  if (md / chord < 0.06) return { kind: 'line', A: { ...A }, B: { ...B } }
  let acc = 0, M = Q[Math.floor(n / 2)]!
  for (let i = 1; i < n; i++) { acc += Math.hypot(Q[i]!.x - Q[i - 1]!.x, Q[i]!.y - Q[i - 1]!.y); if (acc >= Lp / 2) { M = Q[i]!; break } }
  const C = circ(A, M, B)
  if (C && C.r < 8 * chord) {
    let res = 0; for (const q of Q) res += Math.abs(Math.hypot(q.x - C.x, q.y - C.y) - C.r); res /= n * C.r
    if (res < 0.07) return { kind: 'arc', A: { ...A }, M: { ...M }, B: { ...B } }
  }
  const V = rdp(Q, Math.max(6, 0.06 * diag))
  return V.length > 2 ? { kind: 'shape', V, closed: false, cx: 0, cy: 0 } : { kind: 'line', A: { ...A }, B: { ...B } }
}

export function adjustShape(base: Shape, c0: Pt, cur: Pt, shift: boolean): Shape {
  const sh = structuredClone(base) as Shape, d = { x: cur.x - c0.x, y: cur.y - c0.y }
  if (sh.kind === 'line') {
    sh.B = { x: sh.B.x + d.x, y: sh.B.y + d.y }
    if (shift) {
      const L = Math.hypot(sh.B.x - sh.A.x, sh.B.y - sh.A.y), a = Math.round(Math.atan2(sh.B.y - sh.A.y, sh.B.x - sh.A.x) / (Math.PI / 12)) * Math.PI / 12
      sh.B = { x: sh.A.x + Math.cos(a) * L, y: sh.A.y + Math.sin(a) * L }
    }
  } else if (sh.kind === 'arc') {
    sh.B = { x: sh.B.x + d.x, y: sh.B.y + d.y }; sh.M = { x: sh.M.x + d.x / 2, y: sh.M.y + d.y / 2 }
  } else if (sh.kind === 'ellipse' || sh.kind === 'circle' || sh.closed) {
    const v0 = { x: c0.x - sh.cx, y: c0.y - sh.cy }, v1 = { x: cur.x - sh.cx, y: cur.y - sh.cy }
    const k = Math.hypot(v1.x, v1.y) / Math.max(10, Math.hypot(v0.x, v0.y)), rot = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x)
    if (sh.kind === 'shape') {
      const c = Math.cos(rot), s = Math.sin(rot)
      sh.V = sh.V.map(p => { const x = (p.x - sh.cx) * k, y = (p.y - sh.cy) * k; return { x: sh.cx + x * c - y * s, y: sh.cy + x * s + y * c } })
    } else { sh.a *= k; sh.b *= k; sh.th += rot }
  } else {
    const L = sh.V[sh.V.length - 1]!; sh.V[sh.V.length - 1] = { x: L.x + d.x, y: L.y + d.y }
  }
  return sh
}

export function shapePoints(sh: Shape, shift: boolean): Pt[] {
  if (sh.kind === 'line') return evenPts([sh.A, sh.B], 2)
  if (sh.kind === 'arc') {
    const C = circ(sh.A, sh.M, sh.B); if (!C) return evenPts([sh.A, sh.B], 2)
    const ang = (p: Pt) => Math.atan2(p.y - C.y, p.x - C.x)
    const norm = (x: number) => { const T = 2 * Math.PI; return ((x % T) + T) % T }
    const a0 = ang(sh.A); let sweep = norm(ang(sh.B) - a0); if (norm(ang(sh.M) - a0) > sweep) sweep -= 2 * Math.PI
    const N = Math.max(8, Math.ceil(Math.abs(sweep) * C.r / 2)), out: Pt[] = []
    for (let i = 0; i <= N; i++) { const a = a0 + sweep * i / N; out.push({ x: C.x + Math.cos(a) * C.r, y: C.y + Math.sin(a) * C.r }) }
    return out
  }
  if (sh.kind === 'ellipse' || sh.kind === 'circle') {
    let a = sh.a, b = sh.b; if (sh.kind === 'circle' || shift) a = b = (sh.a + sh.b) / 2
    const c = Math.cos(sh.th), s = Math.sin(sh.th), N = Math.max(24, Math.ceil(2 * Math.PI * Math.max(a, b) / 2)), out: Pt[] = []
    for (let i = 0; i <= N; i++) { const t = sh.phase + sh.dir * 2 * Math.PI * 1.03 * i / N, u = Math.cos(t) * a, v = Math.sin(t) * b; out.push({ x: sh.cx + u * c - v * s, y: sh.cy + u * s + v * c }) }
    return out
  }
  return evenPts(sh.V, 2)
}

export function shapeLabel(sh: Shape, shift: boolean): 'Line' | 'Arc' | 'Ellipse' | 'Circle' | 'Shape' {
  if (sh.kind === 'ellipse') return shift ? 'Circle' : 'Ellipse'
  return ({ line: 'Line', arc: 'Arc', circle: 'Circle', shape: 'Shape' } as const)[sh.kind]
}

/** Median sample-to-sample speed in px/ms (0.4 when there is nothing to measure). */
export function medianSpeed(S: TPt[]): number {
  const v: number[] = []
  for (let i = 1; i < S.length; i++) { const dt = S[i]!.t - S[i - 1]!.t, d = Math.hypot(S[i]!.x - S[i - 1]!.x, S[i]!.y - S[i - 1]!.y); if (dt > 0 && d > 0) v.push(d / dt) }
  if (!v.length) return 0.4
  v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]!
}
/** The shape's points, timed as if drawn at an even `speed` (px/ms), t from 0. */
export function timedSamples(P: Pt[], speed: number): TPt[] {
  const out: TPt[] = []; let t = 0
  for (let i = 0; i < P.length; i++) { if (i) t += Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y) / Math.max(1e-3, speed); out.push({ x: P[i]!.x, y: P[i]!.y, t }) }
  return out
}
```

- [ ] **Step 4: Run the tests.** Expected: PASS. If a synthetic-shape test fails, inspect the shape against the prototype's behaviour. Fix the test input, never the thresholds. If a threshold really is wrong, report it as a concern.
- [ ] **Step 5: Commit** `feat(brush): hold-to-snap shape fitting`.

---

### Task 3: Brush state — steady settings, persistence, `replaceTipSamples`

**Files:**
- Modify: `frontend/app/composables/useBrushPaint.ts`
- Test: `frontend/tests/unit/brush-steady-state.unit.spec.ts`

**Interfaces:**
- Consumes: `STEADY_DEFAULTS`, `sanitizeSteady`, `SteadySettings` from `~/lib/brushTips/steady`.
- Produces, on `useBrushPaint()`'s return:
  - `steady: SteadySettings`, a reactive object persisted in `sailor.brushTips.v1` under `steady`;
  - `resetSteady(): void`;
  - `replaceTipSamples(samples: { x: number; y: number; t: number }[]): void`. The samples are width-normalised with t in ms since stroke start. It replaces the live stroke's samples and `liveTip.pts` IN PLACE, so the same `TipStroke` object the host holds sees them. It is a no-op without a live stroke.

- [ ] **Step 1: Failing tests.** Follow how `brush-effect-state.unit.spec.ts` mocks `localStorage` and constructs `useBrushPaint`; read it first. Cases:
  - `steady` defaults equal `STEADY_DEFAULTS`;
  - after changing `steady.streamline` and flushing the debounced save (use fake timers, as that spec does), the stored JSON has `steady.streamline`;
  - a stored `steady: { streamline: 'x', hold: 0.8 }` loads as defaults except `hold` 0.8;
  - `resetSteady()` restores the defaults;
  - `replaceTipSamples`: after `beginTipStroke(0.1, 0.1, 1000)` and two `extendTipStroke` calls, keep `const s = liveTipStroke()`, call `replaceTipSamples([{x:0.2,y:0.2,t:0},{x:0.3,y:0.2,t:50}])`, and check `s.pts` equals `encodePts(those)`;
  - after that, `extendTipStroke(0.35, 0.2, 1100)` appends with t ≥ 50 (the stroke's timeline is relative to the same t0);
  - `endTipStroke()` returns those points.
- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Implement:**
  - in `loadTips()`, add `steady: sanitizeSteady(raw?.steady)`, with `STEADY_DEFAULTS` on error;
  - in `useBrushPaint`, `const steady = reactive({ ...loaded.steady })`, and add `steady` to the persistence `watch` sources and the saved JSON;
  - `resetSteady = () => Object.assign(steady, STEADY_DEFAULTS)`;
  - write `replaceTipSamples` exactly like this:

```ts
function replaceTipSamples(samples: Sample[]) {
  if (!liveTip || !samples.length) return
  tipSamples = samples.map(p => ({ ...p }))
  liveTip.pts.length = 0
  liveTip.pts.push(...encodePts(tipSamples))
}
```

- [ ] **Step 4:** Run this test plus every `ls frontend/tests/unit | grep -iE "brush|tip"` file. `vue-tsc` grep must be clean for the file.
- [ ] **Step 5: Commit** `feat(brush): steadying settings and replaceable live samples`.

---

### Task 4: Inspector section + canvas feedback components

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/BrushSteadySettings.vue`
- Create: `frontend/app/components/vue-canvas/compositor/BrushSnapFeedback.vue`
- Modify: `frontend/app/components/vue-canvas/compositor/BrushTipSettings.vue`. Render `<BrushSteadySettings :brush="brush" />` after its Reset button, separated by a 1px `rgba(255,255,255,0.06)` top border with 12px padding-top. This keeps CompositorModal untouched for the panel.
- Test: `frontend/tests/unit/brush-steady-settings.unit.spec.ts`

**Interfaces:**
- Consumes: `brush.steady`, `brush.resetSteady` (Task 3); `holdMsOf` (Task 1).
- Produces:
  - `BrushSteadySettings` (prop `brush`), with testids:
    - `brush-steady-settings`;
    - `brush-steady-streamline`, `brush-steady-stabilise`, `brush-steady-filter` (range inputs, 0–100, step 5);
    - `brush-steady-snap` (a switch button with `aria-pressed`);
    - `brush-steady-hold` (range 0–100 → `hold`; label value `(holdMsOf(hold)/1000).toFixed(2) + ' s'`);
    - `brush-steady-reset`.
  - `BrushSnapFeedback`, props `{ x: number; y: number; progress: number | null; label: string | null }`. x and y are px relative to its positioned parent.
    - With `progress` in 0–1, it draws an SVG ring: radius 12, stroke 2.5, `rgba(216,199,255,.95)`, starting at 12 o'clock and filling clockwise (`stroke-dasharray`).
    - With `label` set, it draws a pill at `translate(14px,-34px)` from the point: background `#d8c7ff`, text `#1a1424`, 12px/600, padding 6px 10px, fully rounded.
    - Root `pointer-events: none`. testids `brush-hold-ring` and `brush-snap-tag`.

- [ ] **Step 1: Failing tests** (mount with @vue/test-utils as `brush-toolbar.unit.spec.ts` does):
  - the header text is "Steadying";
  - the labels read exactly "Streamline", "Stabilisation", "Motion filtering", "Hold to snap", "Hold time";
  - each row's `title` is the exact tooltip from Global Constraints;
  - moving `brush-steady-streamline` to 60 sets `brush.steady.streamline` to 0.6;
  - the Hold time value reads "0.63 s" at the defaults, and its row is gone when `brush-steady-snap` is toggled off;
  - Reset restores the defaults;
  - no `<p>` element or other visible sentence exists in the section;
  - `BrushSnapFeedback` with `progress: 0.5` renders `brush-hold-ring` and with `label: 'Line'` renders `brush-snap-tag` text "Line";
  - with both null it renders neither.
- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Implement.** Match `BrushTipSettings.vue`'s row styles exactly (96px label, flex slider, 40px value). The switch is a small pill button showing "On" or "Off" with `aria-pressed`.
- [ ] **Step 4:** Run this spec, `brush-toolbar.unit.spec.ts` and the tip-settings spec, if one exists. `vue-tsc` must be clean for the three files.
- [ ] **Step 5: Commit** `feat(brush): steadying section in the brush inspector`.

---

### Task 5: Frame wiring — steadied samples, catch-up, hold to snap

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (snapshot → patch recipe).

**Interfaces:**
- Consumes: `Steadier`, `HoldWatch`, `holdMsOf` (Task 1); `fitShape`, `adjustShape`, `shapePoints`, `shapeLabel`, `medianSpeed`, `timedSamples`, `type Shape` (Task 2); `brush.steady`, `brush.replaceTipSamples` (Task 3); `BrushSnapFeedback` (Task 4).

Today's flow, for orientation:
- `onTipPointerDown` calls `brush.beginTipStroke(wn.x, wn.y, e.timeStamp)`.
- `onTipPointerMove` loops the coalesced events: `clientToNorm(ev)` → `toWidthNorm(...)` → `brush.extendTipStroke(x, y, ev.timeStamp)`.
- `tipHoldLoop` (rAF) calls `brush.holdTipStroke(now)` after `TIP_HOLD_AFTER_MS` still.
- `onTipPointerUp` ends the stroke, commits, and for spray runs the drip tail.

Changes:
1. **Client → width-norm helper.** Add `clientXYToWidthNorm(cx, cy)` using `canvasRect()`, the same maths as `clientToNorm` followed by `toWidthNorm(nx, ny, canvasDisplay.w, canvasDisplay.h)`. It returns null when there is no rect.
2. **State on `tipLive`.** Extend it with:
   - `st: Steadier`, `hold: HoldWatch`;
   - `path: {x,y,t}[]`: steadied client points as painted (t is the event or performance time);
   - `finger: {x,y}`: the latest raw client point;
   - `snap: { base: Shape; c0: {x,y}; speed: number; label: string } | null`;
   - `releasing: number | 0`: the performance.now() at release, when catching up.

   Create them in `onTipPointerDown` from `e.clientX/Y` and `e.timeStamp`, with `new Steadier({ ...brush.steady }, …)`. Snapshot the settings, so changes affect the next stroke.
3. **Emitting a steadied client point.** A helper `emitClient(p, t)` converts with `clientXYToWidthNorm`, then calls `brush.extendTipStroke`, pushes to `L.path` and sets `L.lastMoveT = t`.
4. **`onTipPointerMove`:**
   - for each coalesced event: set `L.finger`, call `L.hold.move(cx, cy, t)`;
   - if `L.snap`, skip the rest;
   - otherwise, for each point returned by `L.st.input(cx, cy, t)`, call `emitClient(p, t)`;
   - after the loop: if `L.snap`, call `applySnap(L)`; then `renderStack()`.
5. **`tipHoldLoop` (every frame while down):**
   - If `L.releasing`: take `const r = L.st.advance(now, true)` and emit its samples. If `r.caughtUp || now - L.releasing > 350`, first emit `L.st.target` at `now` if it's more than 0.6 px away, then call `finishTipRelease(L)` (the old `onTipPointerUp` body after `L.down = false`). Return.
   - If not snapped:
     - emit `L.st.advance(now).samples`;
     - hold samples as today (`brush.holdTipStroke(now)` after `TIP_HOLD_AFTER_MS` still) for every tip EXCEPT when snapped;
     - **hold to snap:** if `brush.steady.snap && L.s.tip !== 'spray' && pathLength(L.path) > 30 && L.hold.stillFor(now) > holdMsOf(brush.steady.hold)`, run `trySnap(L)`.
   - Update the feedback props:
     - `snapUi.progress`: while not snapped, eligible, and still for more than 150 ms, it is `(still − 150)/(holdMs − 150)` clamped to 0–1; otherwise null;
     - `snapUi.label`: `L.snap?.label ?? null`;
     - `snapUi.x/y`: `L.finger`, relative to the element `BrushSnapFeedback` is mounted in.
6. **`trySnap(L)`:**
   - `const base = fitShape([...L.path, L.finger])`.
   - If null, mark `L.hold` as used so it won't retry this stroke: keep a flag `L.snapTried = true`, and check it in the eligibility test.
   - Otherwise set `L.snap = { base, c0: { ...L.finger }, speed: medianSpeed(L.path), label: '' }` and call `applySnap(L)`.
7. **`applySnap(L)`:**
   - `const sh = adjustShape(L.snap.base, L.snap.c0, L.finger, shiftDown)`;
   - `const P = timedSamples(shapePoints(sh, shiftDown), L.snap.speed)`;
   - convert each point with `clientXYToWidthNorm`, keeping `t`, and call `brush.replaceTipSamples(converted)`;
   - set `L.snap.label = shapeLabel(sh, shiftDown)`;
   - `setLiveTipStroke(L.layerId, L.s)`, then `renderStack()`. The host refits the live box every frame through the existing path.
8. **Shift.** Track `shiftDown` from keydown/keyup on window, registered and removed with the modal's existing key listeners. On a change while `tipLive?.snap`, call `applySnap(tipLive)`.
9. **`onTipPointerUp`:**
   - if `L.snap`, finish immediately;
   - else if `brush.steady.streamline > 0.001` and `L.st` is more than 0.6 px from its target, set `L.releasing = performance.now()`, keep `L.down = true` and let `tipHoldLoop` finish it;
   - else finish as today.

   `finishTipRelease` holds today's code: `endTipStroke`, commit, and the spray drip tail.
   - `commitTipStroke` and the paths that close the tool mid-stroke (B, Done, Escape, Mask) must still work while `releasing`. Commit what is there.
   - Hide the feedback on commit and when the tool closes.
10. **Mount the feedback.** Mount `<BrushSnapFeedback>` inside the stage container that already positions the brush cursor ring. Search for the brush cursor ring element to find it. Show it only while `tipLive` exists.

Checks:
- [ ] `vue-tsc` grep for CompositorModal: no new errors against a baseline you capture first.
- [ ] Every `ls frontend/tests/unit | grep -iE "brush|tip|steady|quickshape"` file passes, plus compositor-prompt-wiring.
- [ ] Commit via the CM recipe: `feat(brush): steady the brush and hold to snap in the Frame`. `git show HEAD -- <CM>` must contain only your hunks.

---

### Task 6: Browser verification (controller)

Add `frontend/tests/compositor-brush-steady.spec.ts` and run it on :3002. Paint with the real mouse, reading pixels only through `stackPixels` / `stackImageData`.

- **Round, steadying on:** paint a jittery horizontal zig-zag (±4 px). Compare the saved stroke's sample y-wobble (mean |Δy|, from `__compositorLayers()`) against the same path painted with all three sliders at 0 (set them in the inspector). It must be under 50% of the raw one.
- **Held line:** paint a wobbly line with Round, hold 900 ms, and check that `brush-snap-tag` reads "Line". Release. The saved stroke's points are collinear (max deviation < 0.5% of length).
- **Held loop:** a loop becomes "Ellipse". Hold Shift and it reads "Circle". Dragging 40 px outward while held makes the saved stroke's radius larger.
- **Spray, held 900 ms:** no tag, and it still drips.
- **Undo:** one undo removes a snapped stroke.
- **Reload:** redraws identical pixels.
- **Inspector:** in brush mode, `brush-steady-settings` is visible with the defaults; changing Streamline persists across reopening the Frame.

Then update STATE.md, the dashboard and memory.
