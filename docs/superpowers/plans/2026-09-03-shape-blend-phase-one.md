# Shape Blend — phase one (Shape Studio Blend layout, stills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shape Studio gains a fourth layout, **Blend**, that draws the steps between shape A and a new shape B, plus two colour options for every layout (colour ramp, colour applies to fill / outline / both), so a stack of thin, colour-fading outlines can be made as a still.

**Architecture:** A new pure morph module (`lib/vector/morph.ts`) turns two SVG `d` strings into one in-between `d`; a tiny colour ramp helper (`lib/color/ramp.ts`) fades a fills list. Shape Studio's existing pipeline is extended at three seams: `arrange()` gains blend placements carrying a 0..1 `blend` fraction, `composite()` accepts one `d` per clone, and the three shape-emit sites in `boolean.ts` route their paint through one `styled()` helper that applies `fillCycle` and `paintTarget`. Controls, re-roll, and agent guidance derive from the same flat config keys as today.

**Tech Stack:** TypeScript, Vue 3 / Nuxt 4 (no component changes needed — the panel is schema-drawn), paper.js (already used by `boolean.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-shape-blend-design.md` (sections 1–10; section 11 is phase two and is NOT in this plan).

## Global Constraints

- Every new config field has a default so any saved document loads and renders byte-identically (spec §1).
- Control keys equal config keys 1:1; the drift-guard test derives expected keys from `DEFAULT_CONFIG` (spec §5).
- `lib/vector/morph.ts` and `lib/color/ramp.ts` must not import from `geoshape/`, `three`, `paper`, or the DOM (spec §3, §11).
- `BLEND_SAMPLES = 128` resampled points per subpath (spec §3).
- Re-roll never touches the Paint group (`fill`, `stroke`, `overlapFill`, `fills`, `fillCycle`, `paintTarget`) (spec §6).
- Plain-language hints on every new control (project rule).
- Commit after every task; stage only the files named in the task (other sessions share this tree — never `git add -A`, never stash).
- All commands run from `frontend/`. Unit tests: `npx vitest run <file>`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/vector/morph.ts` (new) | Parse `d` → subpaths, flatten, resample, align, blend two paths, rotate a path. Pure. |
| `frontend/app/lib/color/ramp.ts` (new) | `rampColour(stops, t)`: evenly spaced stops, perceptual mix between the two nearest. |
| `frontend/app/lib/geoshape/config.ts` | New fields, defaults, enum lists, `mergeConfig` lines. |
| `frontend/app/lib/geoshape/arrange.ts` | `ClonePlacement.blend`, `blendEaseT`, the blend branch. |
| `frontend/app/lib/geoshape/boolean.ts` | `composite(baseD: string \| string[])`; `styled()` + `cloneColour()` at the three emit sites. |
| `frontend/app/lib/geoshape/render.ts` | `renderShapes` builds shape B and the per-clone `d` list in Blend layout. |
| `frontend/app/lib/geoshape/controls.ts` | Blend section, Paint selects, `strokeWidth` step/gate, guidance text. |
| `frontend/app/lib/geoshape/randomize.ts` | `blend` roll group + lock. |
| `frontend/tests/unit/vector-morph.unit.spec.ts` (new) | Morph module tests. |
| `frontend/tests/unit/color-ramp.unit.spec.ts` (new) | Ramp tests. |
| `frontend/tests/unit/geoshape-{config,arrange,boolean,render,controls}.unit.spec.ts` | Extended. |

---

### Task 1: Morph module — parse and flatten SVG path data

**Files:**
- Create: `frontend/app/lib/vector/morph.ts`
- Test: `frontend/tests/unit/vector-morph.unit.spec.ts`

**Interfaces:**
- Produces:
  - `type Pt = [number, number]`
  - `type Seg = { kind: 'line'; to: Pt } | { kind: 'cubic'; c1: Pt; c2: Pt; to: Pt }`
  - `interface Subpath { start: Pt; segs: Seg[]; closed: boolean }`
  - `parsePathD(d: string): Subpath[]` — accepts `M L H V C S Q T A Z` absolute and relative; quadratics become cubics; arcs become cubics.
  - `flattenSubpath(sub: Subpath): Pt[]` — closed polyline; each cubic split into `CURVE_STEPS = 12` line segments; a trailing point equal to the start is dropped.
  - `subpathsToD(subs: Subpath[], precision = 2): string`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/vector-morph.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { parsePathD, flattenSubpath, subpathsToD } from '~/lib/vector/morph'

const SQUARE = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z'

describe('morph: parsePathD', () => {
  it('parses absolute M L Z into one closed subpath of lines', () => {
    const subs = parsePathD(SQUARE)
    expect(subs).toHaveLength(1)
    expect(subs[0]!.start).toEqual([-50, -50])
    expect(subs[0]!.closed).toBe(true)
    expect(subs[0]!.segs.map(s => s.kind)).toEqual(['line', 'line', 'line'])
  })

  it('parses relative commands and H/V into the same geometry', () => {
    const rel = parsePathD('m -50 -50 h 100 v 100 h -100 z')
    const abs = parsePathD(SQUARE)
    expect(flattenSubpath(rel[0]!)).toEqual(flattenSubpath(abs[0]!))
  })

  it('turns a quadratic into a cubic with the standard 2/3 control points', () => {
    const subs = parsePathD('M 0 0 Q 30 60 60 0')
    const seg = subs[0]!.segs[0]!
    expect(seg.kind).toBe('cubic')
    if (seg.kind === 'cubic') {
      expect(seg.c1[0]).toBeCloseTo(20, 6); expect(seg.c1[1]).toBeCloseTo(40, 6)
      expect(seg.c2[0]).toBeCloseTo(40, 6); expect(seg.c2[1]).toBeCloseTo(40, 6)
      expect(seg.to).toEqual([60, 0])
    }
  })

  it('turns an arc into cubics that pass near the arc midpoint', () => {
    // half circle of radius 50 from (-50,0) to (50,0), sweeping through (0,-50)
    const subs = parsePathD('M -50 0 A 50 50 0 0 1 50 0')
    const pts = flattenSubpath({ ...subs[0]!, closed: false })
    const nearTop = pts.some(([x, y]) => Math.abs(x) < 8 && Math.abs(y + 50) < 1.5)
    expect(nearTop).toBe(true)
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(50, 0)
  })

  it('splits multiple subpaths', () => {
    const subs = parsePathD('M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20 L 30 30 Z')
    expect(subs).toHaveLength(2)
    expect(subs[1]!.start).toEqual([20, 20])
  })
})

describe('morph: flattenSubpath / subpathsToD', () => {
  it('flattens a square to exactly its 4 corners', () => {
    const pts = flattenSubpath(parsePathD(SQUARE)[0]!)
    expect(pts).toEqual([[-50, -50], [50, -50], [50, 50], [-50, 50]])
  })

  it('flattens a cubic into CURVE_STEPS segments', () => {
    const pts = flattenSubpath({ start: [0, 0], segs: [{ kind: 'cubic', c1: [0, 50], c2: [50, 50], to: [50, 0] }], closed: false })
    expect(pts).toHaveLength(13) // start + 12 steps
  })

  it('round-trips through subpathsToD', () => {
    const d = subpathsToD(parsePathD(SQUARE))
    expect(d).toBe('M -50 -50 L 50 -50 L 50 50 L -50 50 Z')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/vector-morph.unit.spec.ts`
Expected: FAIL — `Cannot find module '~/lib/vector/morph'`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/vector/morph.ts
/**
 * Path morphing — the steps between two outlines (the Illustrator Blend tool).
 *
 * Pure: no paper.js, no DOM, no three, no studio imports. Two consumers: Shape
 * Studio's Blend layout (phase one) and the Frame's Blend layer (phase two), so
 * this lives beside `svg.ts` rather than under `geoshape/`.
 *
 * Pipeline: `parsePathD` → `Subpath[]` (lines + cubics; quadratics and arcs are
 * converted) → `flattenSubpath` → closed polyline → `resample` to K evenly spaced
 * points → `alignCorrespondence` (winding + best start + twist) → lerp. When both
 * inputs share the same command skeleton, `blendPath` skips all of that and
 * interpolates control points directly, so curves stay curves.
 */
import { formatNumber } from './svg'

export type Pt = [number, number]
export type Seg = { kind: 'line'; to: Pt } | { kind: 'cubic'; c1: Pt; c2: Pt; to: Pt }
export interface Subpath { start: Pt; segs: Seg[]; closed: boolean }

/** Line segments per cubic when flattening. Fixed (not tolerance-based) so the
 *  same input always gives the same point count — the alignment search below
 *  depends on that determinism. */
export const CURVE_STEPS = 12

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g

export function parsePathD(d: string): Subpath[] {
  const tokens: (string | number)[] = []
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(d))) tokens.push(m[1] ? m[1] : Number(m[2]))
  TOKEN.lastIndex = 0

  const subs: Subpath[] = []
  let cur: Subpath | null = null
  let cx = 0, cy = 0          // current point
  let sx = 0, sy = 0          // subpath start
  let lastC: Pt | null = null // last cubic control point (for S)
  let lastQ: Pt | null = null // last quadratic control point (for T)
  let cmd = ''
  let i = 0
  const num = (): number => {
    const v = tokens[i++]
    if (typeof v !== 'number') throw new Error(`morph.parsePathD: expected a number in "${d}"`)
    return v
  }
  const peekNumber = () => typeof tokens[i] === 'number'
  const begin = (x: number, y: number) => {
    cur = { start: [x, y], segs: [], closed: false }
    subs.push(cur)
    sx = x; sy = y; cx = x; cy = y
  }
  const line = (x: number, y: number) => {
    if (!cur) begin(cx, cy)
    cur!.segs.push({ kind: 'line', to: [x, y] })
    cx = x; cy = y
  }
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    if (!cur) begin(cx, cy)
    cur!.segs.push({ kind: 'cubic', c1: [x1, y1], c2: [x2, y2], to: [x, y] })
    lastC = [x2, y2]
    cx = x; cy = y
  }
  const quad = (qx: number, qy: number, x: number, y: number) => {
    // Degree elevation: a quadratic (P0, Q, P1) is the cubic with
    // c1 = P0 + 2/3 (Q − P0), c2 = P1 + 2/3 (Q − P1).
    cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y)
    lastQ = [qx, qy]
  }

  while (i < tokens.length) {
    const t = tokens[i]
    if (typeof t === 'string') { cmd = t; i++ }
    else if (!cmd) throw new Error(`morph.parsePathD: path data must start with a command in "${d}"`)
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z' && cmd !== 'Z'
    const rx = rel ? cx : 0, ry = rel ? cy : 0
    const resetControls = () => { lastC = null; lastQ = null }
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num() + rx, y = num() + ry
        begin(x, y)
        // Implicit repeats after M are lineTo.
        cmd = rel ? 'l' : 'L'
        resetControls()
        break
      }
      case 'L': { line(num() + rx, num() + ry); resetControls(); break }
      case 'H': { line(num() + rx, cy); resetControls(); break }
      case 'V': { line(cx, num() + ry); resetControls(); break }
      case 'C': {
        const x1 = num() + rx, y1 = num() + ry, x2 = num() + rx, y2 = num() + ry, x = num() + rx, y = num() + ry
        cubic(x1, y1, x2, y2, x, y); lastQ = null
        break
      }
      case 'S': {
        const x2 = num() + rx, y2 = num() + ry, x = num() + rx, y = num() + ry
        const x1 = lastC ? 2 * cx - lastC[0] : cx
        const y1 = lastC ? 2 * cy - lastC[1] : cy
        cubic(x1, y1, x2, y2, x, y); lastQ = null
        break
      }
      case 'Q': { const qx = num() + rx, qy = num() + ry, x = num() + rx, y = num() + ry; quad(qx, qy, x, y); break }
      case 'T': {
        const x = num() + rx, y = num() + ry
        const qx = lastQ ? 2 * cx - lastQ[0] : cx
        const qy = lastQ ? 2 * cy - lastQ[1] : cy
        quad(qx, qy, x, y)
        break
      }
      case 'A': {
        const rxA = Math.abs(num()), ryA = Math.abs(num()), rot = num(), large = num() !== 0, sweep = num() !== 0
        const x = num() + rx, y = num() + ry
        for (const c of arcToCubics(cx, cy, rxA, ryA, rot, large, sweep, x, y)) cubic(c[0], c[1], c[2], c[3], c[4], c[5])
        resetControls()
        break
      }
      case 'Z': {
        if (cur) { cur.closed = true; cx = sx; cy = sy }
        resetControls()
        // A Z followed by coordinates without a command is invalid SVG; stop.
        if (peekNumber()) throw new Error(`morph.parsePathD: coordinates after Z in "${d}"`)
        break
      }
      default: throw new Error(`morph.parsePathD: unsupported command "${cmd}" in "${d}"`)
    }
  }
  return subs
}

/** SVG endpoint arc → up to four cubic segments (each ≤ 90°), per the SVG
 *  implementation notes' centre-parameterisation (F.6.5). Returns
 *  [x1,y1,x2,y2,x,y] tuples. */
function arcToCubics(x0: number, y0: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x: number, y: number): number[][] {
  if (rx === 0 || ry === 0) return [[x0, y0, x, y, x, y]]
  if (x0 === x && y0 === y) return []
  const phi = (rotDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  // Step 1: (x1', y1')
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  // Correct out-of-range radii
  let rxs = rx * rx, rys = ry * ry
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; rxs = rx * rx; rys = ry * ry }
  // Step 2: (cx', cy')
  const sign = large === sweep ? -1 : 1
  const numer = Math.max(0, rxs * rys - rxs * y1p * y1p - rys * x1p * x1p)
  const coef = sign * Math.sqrt(numer / (rxs * y1p * y1p + rys * x1p * x1p))
  const cxp = coef * ((rx * y1p) / ry)
  const cyp = coef * (-(ry * x1p) / rx)
  // Step 3: (cx, cy)
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2
  // Step 4: angles
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI
  // Split into ≤ 90° pieces
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)))
  const delta = dtheta / n
  const k = (4 / 3) * Math.tan(delta / 4)
  const out: number[][] = []
  let th = theta1
  const point = (t: number): Pt => {
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t)
    return [cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy]
  }
  const deriv = (t: number): Pt => {
    const ex = -rx * Math.sin(t), ey = ry * Math.cos(t)
    return [cosP * ex - sinP * ey, sinP * ex + cosP * ey]
  }
  for (let s = 0; s < n; s++) {
    const t2 = th + delta
    const p1 = point(th), p2 = point(t2)
    const d1 = deriv(th), d2 = deriv(t2)
    out.push([p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]])
    th = t2
  }
  return out
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, dd = t * t * t
  return [a * p0[0] + b * c1[0] + c * c2[0] + dd * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + dd * p3[1]]
}

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

/** Closed polyline for a subpath. A final point equal to the start is dropped
 *  so the loop closes implicitly (the resampler treats the last→first edge as
 *  part of the perimeter). */
export function flattenSubpath(sub: Subpath): Pt[] {
  const pts: Pt[] = [sub.start]
  let cur: Pt = sub.start
  for (const s of sub.segs) {
    if (s.kind === 'line') pts.push(s.to)
    else for (let k = 1; k <= CURVE_STEPS; k++) pts.push(cubicAt(cur, s.c1, s.c2, s.to, k / CURVE_STEPS))
    cur = s.to
  }
  if (pts.length > 1 && same(pts[pts.length - 1]!, pts[0]!)) pts.pop()
  return pts
}

export function subpathsToD(subs: Subpath[], precision = 2): string {
  const f = (v: number) => formatNumber(v, precision)
  const parts: string[] = []
  for (const s of subs) {
    parts.push(`M ${f(s.start[0])} ${f(s.start[1])}`)
    for (const g of s.segs) {
      if (g.kind === 'line') parts.push(`L ${f(g.to[0])} ${f(g.to[1])}`)
      else parts.push(`C ${f(g.c1[0])} ${f(g.c1[1])} ${f(g.c2[0])} ${f(g.c2[1])} ${f(g.to[0])} ${f(g.to[1])}`)
    }
    if (s.closed) parts.push('Z')
  }
  return parts.join(' ')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vector-morph.unit.spec.ts`
Expected: PASS (8 tests). If `formatNumber` prints `-0` for a zero, compare with `toBe('M -50 -50 L 50 -50 L 50 50 L -50 50 Z')` still holds because no zero appears; leave as is.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vector/morph.ts tests/unit/vector-morph.unit.spec.ts && git commit -m "feat(vector): morph module — parse + flatten SVG path data (M L H V C S Q T A Z, arcs → cubics)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Morph module — resample, align, and blend two paths

**Files:**
- Modify: `frontend/app/lib/vector/morph.ts`
- Test: `frontend/tests/unit/vector-morph.unit.spec.ts`

**Interfaces:**
- Consumes: Task 1's `parsePathD`, `flattenSubpath`, `subpathsToD`, `Pt`, `Subpath`.
- Produces:
  - `BLEND_SAMPLES = 128`
  - `resample(poly: Pt[], k: number): Pt[]`
  - `signedArea(poly: Pt[]): number`
  - `alignCorrespondence(a: Pt[], b: Pt[], twist: number): Pt[]` — returns a re-ordered copy of `b` (same length as `a`).
  - `blendPath(dA: string, dB: string, t: number, opts?: { twist?: number; samples?: number }): string`
  - `rotatePathD(d: string, degrees: number): string`

- [ ] **Step 1: Write the failing tests** (append to the same spec file)

```ts
import { resample, signedArea, alignCorrespondence, blendPath, rotatePathD, BLEND_SAMPLES } from '~/lib/vector/morph'

const HEX = (() => {
  let d = ''
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    d += (i === 0 ? 'M' : 'L') + ` ${(90 * Math.cos(a)).toFixed(3)} ${(90 * Math.sin(a)).toFixed(3)}`
  }
  return d + ' Z'
})()
const TRI = 'M 0 -90 L 78 45 L -78 45 Z'
const flatOf = (d: string) => flattenSubpath(parsePathD(d)[0]!)

describe('morph: resample', () => {
  it('returns k points spaced evenly along the closed perimeter', () => {
    const pts = resample(flatOf(SQUARE), 40)
    expect(pts).toHaveLength(40)
    const seg = (i: number) => Math.hypot(pts[(i + 1) % 40]![0] - pts[i]![0], pts[(i + 1) % 40]![1] - pts[i]![1])
    const expected = 400 / 40
    for (let i = 0; i < 40; i++) expect(seg(i)).toBeCloseTo(expected, 6)
  })
})

describe('morph: alignCorrespondence', () => {
  it('recovers a known index rotation of the same polygon', () => {
    const a = resample(flatOf(SQUARE), 32)
    const shifted = [...a.slice(9), ...a.slice(0, 9)]
    const aligned = alignCorrespondence(a, shifted, 0)
    for (let i = 0; i < 32; i++) {
      expect(aligned[i]![0]).toBeCloseTo(a[i]![0], 6)
      expect(aligned[i]![1]).toBeCloseTo(a[i]![1], 6)
    }
  })

  it('reverses a polygon whose winding is opposite', () => {
    const a = resample(flatOf(SQUARE), 32)
    const rev = [...a].reverse()
    expect(Math.sign(signedArea(rev))).toBe(-Math.sign(signedArea(a)))
    const aligned = alignCorrespondence(a, rev, 0)
    expect(Math.sign(signedArea(aligned))).toBe(Math.sign(signedArea(a)))
    for (let i = 0; i < 32; i++) expect(aligned[i]![0]).toBeCloseTo(a[i]![0], 6)
  })

  it('twist shifts the start by round(twist · k)', () => {
    const a = resample(flatOf(SQUARE), 32)
    const aligned = alignCorrespondence(a, a, 0.25) // 8 of 32
    for (let i = 0; i < 32; i++) {
      expect(aligned[i]![0]).toBeCloseTo(a[(i + 8) % 32]![0], 6)
      expect(aligned[i]![1]).toBeCloseTo(a[(i + 8) % 32]![1], 6)
    }
  })
})

describe('morph: blendPath', () => {
  it('same skeleton: t = 0.5 is the argument-wise midpoint, curves stay curves', () => {
    const a = 'M 0 0 C 10 10 20 10 30 0 Z'
    const b = 'M 0 20 C 10 30 20 30 30 20 Z'
    expect(blendPath(a, b, 0.5)).toBe('M 0 10 C 10 20 20 20 30 10 Z')
  })

  it('t = 0 reproduces A and t = 1 reproduces B (resampled path)', () => {
    const d0 = blendPath(HEX, TRI, 0)
    const d1 = blendPath(HEX, TRI, 1)
    const onOutline = (pts: ReturnType<typeof flatOf>, d: string) => {
      const target = resample(flatOf(d), 720)
      return pts.every(([x, y]) => target.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 1.2))
    }
    expect(onOutline(flatOf(d0), HEX)).toBe(true)
    expect(onOutline(flatOf(d1), TRI)).toBe(true)
    expect(flatOf(d0)).toHaveLength(BLEND_SAMPLES)
  })

  it('an unpaired subpath collapses to the partner shape centroid', () => {
    const ring = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z M -20 -20 L 20 -20 L 20 20 L -20 20 Z'
    const solid = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z'
    const d = blendPath(ring, solid, 1)
    const subs = parsePathD(d)
    expect(subs).toHaveLength(2)
    const inner = flattenSubpath(subs[1]!)
    for (const [x, y] of inner) { expect(Math.abs(x)).toBeLessThan(0.02); expect(Math.abs(y)).toBeLessThan(0.02) }
  })

  it('rotatePathD rotates about the origin', () => {
    const d = rotatePathD('M 10 0 L 20 0 Z', 90)
    const subs = parsePathD(d)
    expect(subs[0]!.start[0]).toBeCloseTo(0, 6); expect(subs[0]!.start[1]).toBeCloseTo(10, 6)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/vector-morph.unit.spec.ts`
Expected: FAIL — `resample is not a function` (and friends).

- [ ] **Step 3: Append the implementation** to `frontend/app/lib/vector/morph.ts`

```ts
// ── Resample / align / blend ─────────────────────────────────────────────────

/** Evenly spaced points per subpath for the resampled blend. 128 keeps a 200-step
 *  outline stack under ~350 KB of SVG while hiding the polyline at print size. */
export const BLEND_SAMPLES = 128

/** `k` points spaced evenly by arc length around a CLOSED polyline. */
export function resample(poly: Pt[], k: number): Pt[] {
  const n = poly.length
  if (n === 0) return []
  if (n === 1) return Array.from({ length: k }, () => [poly[0]![0], poly[0]![1]] as Pt)
  const lens: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    lens.push(l); total += l
  }
  if (total === 0) return Array.from({ length: k }, () => [poly[0]![0], poly[0]![1]] as Pt)
  const out: Pt[] = []
  let edge = 0, acc = 0
  for (let i = 0; i < k; i++) {
    const s = (i * total) / k
    while (edge < n - 1 && acc + lens[edge]! < s) { acc += lens[edge]!; edge++ }
    const a = poly[edge]!, b = poly[(edge + 1) % n]!
    const f = lens[edge]! > 0 ? (s - acc) / lens[edge]! : 0
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return out
}

/** Shoelace area: positive for one winding, negative for the other. */
export function signedArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

function centroid(poly: Pt[]): Pt {
  if (!poly.length) return [0, 0]
  let x = 0, y = 0
  for (const p of poly) { x += p[0]; y += p[1] }
  return [x / poly.length, y / poly.length]
}

/**
 * Re-order `b` so `b[i]` is the natural partner of `a[i]`:
 *  1. reverse `b` when its winding differs from `a`'s (so the blend never folds
 *     through itself),
 *  2. pick the start offset minimising the summed squared distance (O(k²);
 *     k = 128 → 16k steps, run once per render),
 *  3. add `round(twist · k)` to that offset — the user's spiral knob.
 */
export function alignCorrespondence(a: Pt[], b: Pt[], twist: number): Pt[] {
  const k = a.length
  if (k === 0 || b.length !== k) throw new Error('morph.alignCorrespondence: polylines must have equal length')
  let bb = b
  const areaA = signedArea(a), areaB = signedArea(b)
  if (areaA !== 0 && areaB !== 0 && Math.sign(areaA) !== Math.sign(areaB)) bb = [...b].reverse()
  let best = 0, bestCost = Infinity
  for (let s = 0; s < k; s++) {
    let cost = 0
    for (let i = 0; i < k; i++) {
      const p = a[i]!, q = bb[(i + s) % k]!
      const dx = p[0] - q[0], dy = p[1] - q[1]
      cost += dx * dx + dy * dy
      if (cost >= bestCost) break
    }
    if (cost < bestCost) { bestCost = cost; best = s }
  }
  const shift = (best + Math.round((twist || 0) * k)) % k
  const out: Pt[] = new Array(k)
  for (let i = 0; i < k; i++) out[i] = bb[(i + shift + k) % k]!
  return out
}

function skeleton(subs: Subpath[]): string {
  return subs.map(s => (s.closed ? 'z' : 'o') + s.segs.map(g => (g.kind === 'line' ? 'L' : 'C')).join('')).join('|')
}

const lerpPt = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]

/**
 * The outline `t` of the way from `dA` (t = 0) to `dB` (t = 1).
 *
 * Exact path: identical command skeletons → interpolate every point, so a
 * hexagon→hexagon or leaf→leaf blend keeps its curves and stays small.
 * Resampled path: subpaths paired by index after sorting each side by |area|
 * (largest first); each pair is flattened, resampled to `samples`, aligned, and
 * lerped into an `M … L … Z` polyline. A subpath with no partner pairs with the
 * partner shape's centroid repeated, so it shrinks to a point.
 */
export function blendPath(dA: string, dB: string, t: number, opts: { twist?: number; samples?: number } = {}): string {
  const A = parsePathD(dA), B = parsePathD(dB)
  const tt = Math.max(0, Math.min(1, t))
  if (A.length && skeleton(A) === skeleton(B)) {
    const out: Subpath[] = A.map((sa, si) => {
      const sb = B[si]!
      return {
        start: lerpPt(sa.start, sb.start, tt),
        closed: sa.closed,
        segs: sa.segs.map((ga, gi) => {
          const gb = sb.segs[gi]!
          if (ga.kind === 'line' && gb.kind === 'line') return { kind: 'line' as const, to: lerpPt(ga.to, gb.to, tt) }
          const ca = ga as Extract<Seg, { kind: 'cubic' }>, cb = gb as Extract<Seg, { kind: 'cubic' }>
          return { kind: 'cubic' as const, c1: lerpPt(ca.c1, cb.c1, tt), c2: lerpPt(ca.c2, cb.c2, tt), to: lerpPt(ca.to, cb.to, tt) }
        }),
      }
    })
    return subpathsToD(out)
  }
  const k = opts.samples ?? BLEND_SAMPLES
  const byArea = (subs: Subpath[]) => subs
    .map(s => ({ poly: flattenSubpath(s), area: Math.abs(signedArea(flattenSubpath(s))) }))
    .sort((p, q) => q.area - p.area)
    .map(x => x.poly)
  const pa = byArea(A), pb = byArea(B)
  const n = Math.max(pa.length, pb.length)
  const out: Subpath[] = []
  for (let i = 0; i < n; i++) {
    const a = pa[i], b = pb[i]
    const polyA = a ? resample(a, k) : resample([centroid(b!)], k)
    const polyBraw = b ? resample(b, k) : resample([centroid(a!)], k)
    const polyB = alignCorrespondence(polyA, polyBraw, opts.twist ?? 0)
    const pts = polyA.map((p, j) => lerpPt(p, polyB[j]!, tt))
    out.push({ start: pts[0]!, segs: pts.slice(1).map(p => ({ kind: 'line' as const, to: p })), closed: true })
  }
  return subpathsToD(out)
}

/** Rotate every point of `d` about the origin by `degrees` (clockwise in SVG's
 *  y-down space, matching `arrange`'s `rotate`). */
export function rotatePathD(d: string, degrees: number): string {
  if (!degrees) return d
  const r = (degrees * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  const rot = (p: Pt): Pt => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
  const subs = parsePathD(d).map(sp => ({
    start: rot(sp.start),
    closed: sp.closed,
    segs: sp.segs.map(g => g.kind === 'line' ? { kind: 'line' as const, to: rot(g.to) } : { kind: 'cubic' as const, c1: rot(g.c1), c2: rot(g.c2), to: rot(g.to) }),
  }))
  return subpathsToD(subs, 3)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/vector-morph.unit.spec.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/vector/morph.ts tests/unit/vector-morph.unit.spec.ts && git commit -m "feat(vector): morph module — resample, winding + best-offset alignment, twist, blendPath (exact and resampled), rotatePathD

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Colour ramp helper

**Files:**
- Create: `frontend/app/lib/color/ramp.ts`
- Test: `frontend/tests/unit/color-ramp.unit.spec.ts`

**Interfaces:**
- Consumes: `mixHex(from, to, t, space?)` from `~/lib/color/mix` (default space OKLab), `Paint` type from `~/lib/compositor/paint`.
- Produces: `rampColour(stops: Paint[], t: number): Paint`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/color-ramp.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { rampColour } from '~/lib/color/ramp'
import { mixHex } from '~/lib/color/mix'
import type { Paint } from '~/lib/compositor/paint'

describe('rampColour', () => {
  it('returns the stops exactly at t = 0 and t = 1', () => {
    expect(rampColour(['#ff00aa', '#00ffaa'], 0)).toBe('#ff00aa')
    expect(rampColour(['#ff00aa', '#00ffaa'], 1)).toBe('#00ffaa')
  })
  it('two stops: t = 0.5 is the perceptual midpoint the shared mixer gives', () => {
    expect(rampColour(['#ff00aa', '#00ffaa'], 0.5)).toBe(mixHex('#ff00aa', '#00ffaa', 0.5))
  })
  it('three stops: t = 0.5 is exactly the middle stop, t = 0.25 mixes the first pair', () => {
    expect(rampColour(['#000000', '#ff0000', '#ffffff'], 0.5)).toBe('#ff0000')
    expect(rampColour(['#000000', '#ff0000', '#ffffff'], 0.25)).toBe(mixHex('#000000', '#ff0000', 0.5))
  })
  it('a non-solid stop is used as-is at its nearest position, never interpolated', () => {
    const grad = { type: 'linear', angle: 0, stops: [] } as unknown as Paint
    expect(rampColour(['#000000', grad], 0.2)).toBe('#000000')
    expect(rampColour(['#000000', grad], 0.8)).toBe(grad)
  })
  it('clamps t and tolerates a single stop', () => {
    expect(rampColour(['#123456'], 0.7)).toBe('#123456')
    expect(rampColour(['#000000', '#ffffff'], 2)).toBe('#ffffff')
    expect(rampColour(['#000000', '#ffffff'], -1)).toBe('#000000')
  })
  it('returns a neutral grey for an empty list', () => {
    expect(rampColour([], 0.5)).toBe('#808080')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/color-ramp.unit.spec.ts`
Expected: FAIL — `Cannot find module '~/lib/color/ramp'`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/color/ramp.ts
/**
 * A fills list read as a smooth ramp: `stops` are evenly spaced over 0..1 and
 * the colour at `t` is the perceptual mix of the two nearest (`mixHex`'s default
 * space — see mix.ts for why OKLab). Used by Shape Studio's "Colour ramp" and,
 * in phase two, the Frame's Blend layer.
 *
 * Only solid colours interpolate. A gradient/pattern/image stop has no single
 * colour to mix, so it is used as-is on its own side of the midpoint — the ramp
 * degrades to a hard step there rather than inventing a colour.
 */
import { mixHex } from './mix'
import type { Paint } from '~/lib/compositor/paint'

const FALLBACK = '#808080'

export function rampColour(stops: Paint[], t: number): Paint {
  if (stops.length === 0) return FALLBACK
  if (stops.length === 1) return stops[0]!
  const tt = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  const u = tt * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(u))
  const f = u - i
  const a = stops[i]!, b = stops[i + 1]!
  if (f <= 0) return a
  if (f >= 1) return b
  if (typeof a !== 'string' || typeof b !== 'string') return f < 0.5 ? a : b
  return mixHex(a, b, f)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/color-ramp.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/color/ramp.ts tests/unit/color-ramp.unit.spec.ts && git commit -m "feat(color): rampColour — a fills list read as an evenly spaced perceptual ramp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Config — new fields, defaults, validation

**Files:**
- Modify: `frontend/app/lib/geoshape/config.ts`
- Test: `frontend/tests/unit/geoshape-config.unit.spec.ts`

**Interfaces:**
- Produces (all exported from `config.ts`):
  - `GeoLayout` gains `'blend'`
  - `type GeoBlendEase = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'`
  - `type GeoFillCycle = 'cycle' | 'ramp'`
  - `type GeoPaintTarget = 'fill' | 'outline' | 'both'`
  - `GeoShapeConfig` fields: `blendShape: BaseShapeKind`, `blendLibraryShape: string`, `blendSides: number`, `blendStarInner: number`, `blendIrregularSeed: number`, `blendSize: number`, `blendRotate: number`, `blendX: number`, `blendY: number`, `blendEase: GeoBlendEase`, `blendTwist: number`, `fillCycle: GeoFillCycle`, `paintTarget: GeoPaintTarget`
  - `export const BLEND_EASES`, `FILL_CYCLES`, `PAINT_TARGETS` (readonly tuples)

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('geoshape config')`)

```ts
  it('blend + paint fields default so an old document renders identically', () => {
    const cfg = mergeConfig({ shape: 'hexagon', count: 6 })
    expect(cfg.layout).toBe('radial')
    expect(cfg.blendShape).toBe('triangle')
    expect(cfg.blendLibraryShape).toBe(DEFAULT_CONFIG.blendLibraryShape)
    expect(cfg.blendSides).toBe(3)
    expect(cfg.blendStarInner).toBe(0.45)
    expect(cfg.blendIrregularSeed).toBe(1)
    expect(cfg.blendSize).toBe(180)
    expect(cfg.blendRotate).toBe(0)
    expect(cfg.blendX).toBe(0)
    expect(cfg.blendY).toBe(0)
    expect(cfg.blendEase).toBe('linear')
    expect(cfg.blendTwist).toBe(0)
    expect(cfg.fillCycle).toBe('cycle')
    expect(cfg.paintTarget).toBe('fill')
  })

  it('accepts layout blend and validates the blend enums', () => {
    const cfg = mergeConfig({ layout: 'blend', blendEase: 'easeInOut', fillCycle: 'ramp', paintTarget: 'outline', blendShape: 'star', blendLibraryShape: 'heart' })
    expect(cfg.layout).toBe('blend')
    expect(cfg.blendEase).toBe('easeInOut')
    expect(cfg.fillCycle).toBe('ramp')
    expect(cfg.paintTarget).toBe('outline')
    expect(cfg.blendShape).toBe('star')
    expect(cfg.blendLibraryShape).toBe('heart')
  })

  it('junk blend values fall back and numeric ranges clamp', () => {
    const cfg = mergeConfig({ blendEase: 'bouncy', fillCycle: 3, paintTarget: 'edges', blendShape: 'blob', blendLibraryShape: 'no-such-shape', blendSides: 99, blendTwist: 'x' })
    expect(cfg.blendEase).toBe('linear')
    expect(cfg.fillCycle).toBe('cycle')
    expect(cfg.paintTarget).toBe('fill')
    expect(cfg.blendShape).toBe('triangle')
    expect(cfg.blendLibraryShape).toBe(DEFAULT_CONFIG.blendLibraryShape)
    expect(cfg.blendSides).toBe(24)
    expect(cfg.blendTwist).toBe(0)
  })

  it('round-trips a blend config', () => {
    const cfg = { ...DEFAULT_CONFIG, layout: 'blend' as const, blendShape: 'circle' as const, blendSize: 240, blendX: 120, blendY: -40, blendTwist: 0.15, fillCycle: 'ramp' as const, paintTarget: 'outline' as const }
    expect(mergeConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/geoshape-config.unit.spec.ts`
Expected: FAIL — `expected undefined to be 'triangle'` (and TypeScript complaints about unknown fields are fine under vitest; they fail at runtime).

- [ ] **Step 3: Edit `config.ts`**

Add after `export type GeoLayout = 'radial' | 'grid' | 'linear'` (change that line too):

```ts
export type GeoLayout = 'radial' | 'grid' | 'linear' | 'blend'
/** Blend layout only: how the steps bunch up between shape A and shape B. */
export type GeoBlendEase = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
/** Every layout: cycle the fills list (today) or read it as a smooth ramp across the clones. */
export type GeoFillCycle = 'cycle' | 'ramp'
/** Every layout: where a clone's colour lands — its fill (today), its outline only, or both. */
export type GeoPaintTarget = 'fill' | 'outline' | 'both'
export const BLEND_EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const
export const FILL_CYCLES = ['cycle', 'ramp'] as const
export const PAINT_TARGETS = ['fill', 'outline', 'both'] as const
```

Add to `GeoShapeConfig` right after `gridRows: number`:

```ts
  /** Blend layout — shape B, the shape the steps run toward. Same vocabulary as A. */
  blendShape: BaseShapeKind
  blendLibraryShape: string
  blendSides: number
  blendStarInner: number
  blendIrregularSeed: number
  blendSize: number
  /** Degrees, about B's own centre. */
  blendRotate: number
  /** B's centre relative to A's, document units. 0,0 = concentric. */
  blendX: number
  blendY: number
  blendEase: GeoBlendEase
  /** 0..1 of a full turn of the point correspondence — spirals the outlines. */
  blendTwist: number
  fillCycle: GeoFillCycle
  paintTarget: GeoPaintTarget
```

Add to `DEFAULT_CONFIG` right after `gridRows: 2,`:

```ts
  blendShape: 'triangle',
  blendLibraryShape: DEFAULT_LIBRARY_SHAPE,
  blendSides: 3,
  blendStarInner: 0.45,
  blendIrregularSeed: 1,
  blendSize: 180,
  blendRotate: 0,
  blendX: 0,
  blendY: 0,
  blendEase: 'linear',
  blendTwist: 0,
  fillCycle: 'cycle',
  paintTarget: 'fill',
```

Change the private `LAYOUTS` const to `const LAYOUTS = ['radial', 'grid', 'linear', 'blend'] as const`.

Add to `mergeConfig`'s returned object right after `gridRows: clampNum(o.gridRows, d.gridRows, 1, 24),`:

```ts
    blendShape: oneOf(o.blendShape, SHAPES, d.blendShape),
    blendLibraryShape: isShapeId(o.blendLibraryShape) ? o.blendLibraryShape : d.blendLibraryShape,
    blendSides: clampNum(o.blendSides, d.blendSides, 3, 24),
    blendStarInner: Math.min(0.99, Math.max(0.01, num(o.blendStarInner, d.blendStarInner))),
    blendIrregularSeed: clampNum(o.blendIrregularSeed, d.blendIrregularSeed, 1, 9999),
    blendSize: Math.min(600, Math.max(20, num(o.blendSize, d.blendSize))),
    blendRotate: num(o.blendRotate, d.blendRotate),
    blendX: num(o.blendX, d.blendX),
    blendY: num(o.blendY, d.blendY),
    blendEase: oneOf(o.blendEase, BLEND_EASES, d.blendEase),
    blendTwist: Math.min(1, Math.max(0, num(o.blendTwist, d.blendTwist))),
    fillCycle: oneOf(o.fillCycle, FILL_CYCLES, d.fillCycle),
    paintTarget: oneOf(o.paintTarget, PAINT_TARGETS, d.paintTarget),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/geoshape-config.unit.spec.ts tests/unit/geoshape-studio-doc.unit.spec.ts`
Expected: PASS. (`geoshape-studio-doc` covers `mergeStudioDoc`, which wraps `mergeConfig` — it must stay green.)

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/geoshape/config.ts tests/unit/geoshape-config.unit.spec.ts && git commit -m "feat(geoshape): blend + colour fields on GeoShapeConfig (blend layout, shape B, twist, fillCycle, paintTarget) with defaults and validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Blend placements in `arrange()`

**Files:**
- Modify: `frontend/app/lib/geoshape/arrange.ts`
- Test: `frontend/tests/unit/geoshape-arrange.unit.spec.ts`

**Interfaces:**
- Consumes: `GeoShapeConfig` with `layout: 'blend'`, `blendX`, `blendY`, `blendEase` (Task 4).
- Produces: `ClonePlacement.blend?: number`; `export function blendEaseT(u: number, ease: GeoBlendEase): number`.

- [ ] **Step 1: Write the failing tests** (append inside `describe('geoshape arrange')`)

```ts
  it('blend: x/y run from A (0,0) to B (blendX, blendY) and carry a 0..1 blend fraction', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 5, blendX: 100, blendY: -40, blendEase: 'linear' })
    expect(p).toHaveLength(5)
    expect(p.map(c => c.x)).toEqual([0, 25, 50, 75, 100])
    expect(p.map(c => c.y)).toEqual([0, -10, -20, -30, -40])
    expect(p.map(c => c.blend)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('blend: easeIn is monotone and front-loaded; count 1 is a single placement at blend 0', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 6, blendX: 100, blendEase: 'easeIn' })
    const xs = p.map(c => c.x)
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
    expect(xs[1]!).toBeLessThan(20) // linear would be 20
    const one = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 1, blendX: 100 })
    expect(one).toEqual([{ x: 0, y: 0, scale: 1, rotate: 0, skew: 0, blend: 0 }])
  })

  it('blend: the existing scale/rotate ramps still apply and radius/spacing are ignored', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 3, scaleStart: 1, scaleEnd: 2, rotateStep: 10, radius: 500, spacing: 500 })
    expect(p.map(c => c.scale)).toEqual([1, 1.5, 2])
    expect(p.map(c => c.rotate)).toEqual([0, 10, 20])
    expect(p.map(c => c.x)).toEqual([0, 0, 0])
  })

  it('non-blend layouts carry no blend fraction', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'linear', count: 3 })
    for (const c of p) expect(c.blend).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/geoshape-arrange.unit.spec.ts`
Expected: FAIL — blend layout falls through to the radial branch (x values are radius-based, `blend` undefined).

- [ ] **Step 3: Edit `arrange.ts`**

Change the interface and add the ease helper:

```ts
import type { GeoShapeConfig, GeoBlendEase } from './config'

export interface ClonePlacement {
  x: number
  y: number
  scale: number
  rotate: number
  skew: number
  /** Blend layout only: 0 = shape A, 1 = shape B, eased by `blendEase`. */
  blend?: number
}

/** How the blend steps bunch up. `u` is the raw 0..1 step position. */
export function blendEaseT(u: number, ease: GeoBlendEase): number {
  switch (ease) {
    case 'easeIn': return u * u
    case 'easeOut': return 1 - (1 - u) * (1 - u)
    case 'easeInOut': return u * u * (3 - 2 * u)
    default: return u
  }
}
```

Insert this branch in `arrange()` after the `linear` branch and before the radial default:

```ts
  if (cfg.layout === 'blend') {
    // The steps between shape A (at the origin) and shape B (at blendX/blendY).
    // Position and blend fraction share the eased t so a bunched spacing also
    // bunches the shape change; the scale ramp keeps the raw t like every layout.
    const placements: ClonePlacement[] = []
    for (let i = 0; i < count; i++) {
      const u = rampT(i, count)
      const t = blendEaseT(u, cfg.blendEase)
      placements.push({
        x: lerp(0, cfg.blendX, t),
        y: lerp(0, cfg.blendY, t),
        scale: lerp(cfg.scaleStart, cfg.scaleEnd, u),
        rotate: cfg.rotateBase + i * cfg.rotateStep,
        skew: cfg.skew,
        blend: t,
      })
    }
    return placements
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/geoshape-arrange.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/geoshape/arrange.ts tests/unit/geoshape-arrange.unit.spec.ts && git commit -m "feat(geoshape): blend layout placements — eased 0..1 fraction from A to B on every clone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Per-clone shapes — `composite()` takes a `d` per clone, `renderShapes` builds shape B

**Files:**
- Modify: `frontend/app/lib/geoshape/boolean.ts` (composite signature + clone build)
- Modify: `frontend/app/lib/geoshape/render.ts` (`renderShapes`)
- Test: `frontend/tests/unit/geoshape-boolean.unit.spec.ts`, `frontend/tests/unit/geoshape-render.unit.spec.ts`

**Interfaces:**
- Consumes: `blendPath`, `rotatePathD` (Task 2); `ClonePlacement.blend` (Task 5); `blend*` fields (Task 4).
- Produces: `composite(baseD: string | string[], placements, cfg)` — a string is used for every clone; an array is indexed by clone (the last entry repeats if the array is short).

- [ ] **Step 1: Write the failing tests**

Append to `geoshape-boolean.unit.spec.ts`:

```ts
describe('composite with a per-clone d list', () => {
  it('uses ds[i] for clone i in perClone mode', async () => {
    const TRI = 'M 0 -50 L 43 25 L -43 25 Z'
    const placements = [
      { x: -100, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 100, y: 0, scale: 1, rotate: 0, skew: 0 },
    ]
    const cfg = { ...DEFAULT_CONFIG, fillStrategy: 'perClone' as const, fills: ['#ff0000', '#0000ff'], clipMask: 'none' as const, symmetry: false }
    const shapes = await composite([SQUARE, TRI], placements, cfg)
    expect(shapes).toHaveLength(2)
    // A square has 4 corners; a triangle 3 — count lineTo/bezier commands per shape.
    const edgeCount = (i: number) => shapes[i]!.commands.filter(c => c.command !== 'moveTo').length
    expect(edgeCount(0)).toBe(4)
    expect(edgeCount(1)).toBe(3)
  })
})
```

Append to `geoshape-render.unit.spec.ts`:

```ts
describe('blend layout', () => {
  it('count 1 renders the same geometry as linear count 1 (shape A only)', async () => {
    const base = { ...DEFAULT_CONFIG, shape: 'hexagon' as const, fillStrategy: 'perClone' as const, count: 1 }
    const a = await renderShapes({ ...base, layout: 'linear' })
    const b = await renderShapes({ ...base, layout: 'blend', blendShape: 'circle', blendSize: 300 })
    expect(b).toHaveLength(1)
    expect(commandsToPathData(b[0]!.commands)).toBe(commandsToPathData(a[0]!.commands))
  })

  it('the last step lands on shape B, offset by blendX/blendY and sized by blendSize', async () => {
    const cfg = { ...DEFAULT_CONFIG, shape: 'square' as const, size: 100, layout: 'blend' as const, count: 3, blendShape: 'square' as const, blendSize: 200, blendX: 300, blendY: 0, fillStrategy: 'perClone' as const }
    const shapes = await renderShapes(cfg)
    expect(shapes).toHaveLength(3)
    const b = contentBounds([shapes[2]!])
    expect(b.w).toBeCloseTo(200, 0)
    expect(b.minX + b.w / 2).toBeCloseTo(300, 0)
    const mid = contentBounds([shapes[1]!])
    expect(mid.w).toBeCloseTo(150, 0)
    expect(mid.minX + mid.w / 2).toBeCloseTo(150, 0)
  })

  it('a rotated shape B rotates the steps', async () => {
    const cfg = { ...DEFAULT_CONFIG, shape: 'square' as const, size: 100, layout: 'blend' as const, count: 2, blendShape: 'square' as const, blendSize: 100, blendRotate: 45, fillStrategy: 'perClone' as const }
    const shapes = await renderShapes(cfg)
    const b = contentBounds([shapes[1]!])
    expect(b.w).toBeCloseTo(100 * Math.SQRT2, 0) // a 45° square spans its diagonal
  })
})
```

Add `import { commandsToPathData } from '~/lib/vector/svg'` to the render spec's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/geoshape-boolean.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts`
Expected: FAIL — `composite` receives an array and `new sc.CompoundPath(array)` throws or draws nothing; blend renders as a radial ring.

- [ ] **Step 3: Edit `boolean.ts`**

Change the signature and the clone build (the first lines of `composite`):

```ts
/**
 * `baseD` is ONE path for every clone (every layout but Blend) or ONE PATH PER
 * CLONE (Blend: `render.ts` hands in the morphed steps). The three fill
 * strategies below never look at `baseD` again — they work on `clones`.
 */
export async function composite(baseD: string | string[], placements: ClonePlacement[], cfg: GeoShapeConfig): Promise<GeoVectorShape[]> {
  const sc = await paperScope()
  const dFor = (i: number): string => typeof baseD === 'string' ? baseD : (baseD[i] ?? baseD[baseD.length - 1] ?? '')
  try {
    // 1. build a transformed paper path per placement
    const clones = placements.map((pl, i) => {
      const p = new sc.CompoundPath(dFor(i))
```

(The rest of the clone build — the matrix translate/rotate/shear/scale — is unchanged.)

- [ ] **Step 4: Edit `render.ts` `renderShapes`**

```ts
import { blendPath, rotatePathD } from '~/lib/vector/morph'
```

Replace the body of `renderShapes`:

```ts
export async function renderShapes(cfg: GeoShapeConfig): Promise<VectorShape[]> {
  const baseD = baseShapePath(cfg.shape, {
    sides: cfg.sides,
    starInner: cfg.starInner,
    irregularSeed: cfg.irregularSeed,
    size: cfg.size,
    roundCorners: cfg.roundCorners,
    roundRadius: cfg.roundRadius,
    libraryShape: cfg.libraryShape,
  })
  const placements = arrange(cfg)
  const rp = resolvePaint(cfg)
  // The post-invert config `composite` actually paints with — it reads fill/
  // stroke/overlapFill straight off whatever `cfg` it is handed, so this is
  // the one place `invert` takes effect.
  const cfg2: GeoShapeConfig = { ...cfg, fill: rp.fill, stroke: rp.stroke, overlapFill: rp.overlapFill }
  if (cfg.layout !== 'blend') return composite(baseD, placements, cfg2)

  // Blend: every clone is its own in-between outline. Shape B reuses the base
  // shape vocabulary (its own kind/size/rounding) and is rotated before the
  // morph so the point correspondence sees the rotated target.
  const targetD = rotatePathD(baseShapePath(cfg.blendShape, {
    sides: cfg.blendSides,
    starInner: cfg.blendStarInner,
    irregularSeed: cfg.blendIrregularSeed,
    size: cfg.blendSize,
    roundCorners: cfg.roundCorners,
    roundRadius: cfg.roundRadius,
    libraryShape: cfg.blendLibraryShape,
  }), cfg.blendRotate)
  const ds = placements.map((pl) => blendPath(baseD, targetD, pl.blend ?? 0, { twist: cfg.blendTwist }))
  return composite(ds, placements, cfg2)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/geoshape-boolean.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts tests/unit/geoshape-studio-render.unit.spec.ts`
Expected: PASS. If the "count 1" parity test fails on formatting only (e.g. `-0` vs `0`), the exact-skeleton path produced a different number format: compare `contentBounds` and command counts instead and note it in the commit.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/geoshape/boolean.ts app/lib/geoshape/render.ts tests/unit/geoshape-boolean.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts && git commit -m "feat(geoshape): Blend layout renders — composite takes a d per clone; renderShapes morphs A→B with shape B's own kind, size, rotation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Colour ramp and colour target at the three emit sites

**Files:**
- Modify: `frontend/app/lib/geoshape/boolean.ts`
- Test: `frontend/tests/unit/geoshape-boolean.unit.spec.ts`, `frontend/tests/unit/geoshape-render.unit.spec.ts`

**Interfaces:**
- Consumes: `rampColour` (Task 3); `fillCycle`, `paintTarget` (Task 4).
- Produces (module-private in `boolean.ts`): `cloneColour(fills, rank, total, cfg): Paint`; `styled(paint, cfg, strokeColour): Pick<GeoVectorShape, 'paint' | 'fill' | 'stroke' | 'strokeWidth'>`.

- [ ] **Step 1: Write the failing tests**

Append to `geoshape-boolean.unit.spec.ts`:

```ts
describe('colour ramp + paint target', () => {
  const five = [
    { x: -200, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: -100, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: 0, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: 100, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: 200, y: 0, scale: 1, rotate: 0, skew: 0 },
  ]
  const base = { ...DEFAULT_CONFIG, fillStrategy: 'perClone' as const, fillOrder: 'created' as const, fills: ['#000000', '#ffffff'], clipMask: 'none' as const, symmetry: false }

  it('ramp: five clones over two fills give five distinct colours whose ends are the stops', async () => {
    const shapes = await composite(SQUARE, five, { ...base, fillCycle: 'ramp' })
    const cols = shapes.map(s => s.paint)
    expect(cols[0]).toBe('#000000')
    expect(cols[4]).toBe('#ffffff')
    expect(new Set(cols).size).toBe(5)
  })

  it('cycle (default) still alternates the two fills', async () => {
    const shapes = await composite(SQUARE, five, base)
    expect(shapes.map(s => s.paint)).toEqual(['#000000', '#ffffff', '#000000', '#ffffff', '#000000'])
  })

  it('outline: no fill, stroke takes the clone colour and the stroke width', async () => {
    const shapes = await composite(SQUARE, five, { ...base, paintTarget: 'outline', strokeWidth: 0.5 })
    for (const s of shapes) {
      expect(s.fill).toBeNull()
      expect(s.paint).toBeUndefined()
      expect(s.strokeWidth).toBe(0.5)
    }
    expect(shapes[0]!.stroke).toBe('#000000')
    expect(shapes[1]!.stroke).toBe('#ffffff')
  })

  it('both: fill and stroke both take the clone colour', async () => {
    const shapes = await composite(SQUARE, five, { ...base, paintTarget: 'both', strokeWidth: 2 })
    expect(shapes[1]!.fill).toBe('#ffffff')
    expect(shapes[1]!.stroke).toBe('#ffffff')
    expect(shapes[1]!.paint).toBe('#ffffff')
  })

  it('single mode outline: the fold is outlined in stroke ?? fill with no fill', async () => {
    const shapes = await composite(SQUARE, five.slice(0, 2), { ...DEFAULT_CONFIG, fillStrategy: 'single', fill: '#123456', stroke: null, paintTarget: 'outline', strokeWidth: 1, clipMask: 'none', symmetry: false })
    expect(shapes[0]!.fill).toBeNull()
    expect(shapes[0]!.stroke).toBe('#123456')
  })

  it('pieces mode ramps solo pieces by rank', async () => {
    const shapes = await composite(SQUARE, five.slice(0, 3), { ...base, fillStrategy: 'pieces', fillCycle: 'ramp', fills: ['#000000', '#ffffff'] })
    const solids = shapes.filter(s => typeof s.paint === 'string').map(s => s.paint as string)
    expect(solids).toContain('#000000')
    expect(solids).toContain('#ffffff')
  })
})
```

Append to `geoshape-render.unit.spec.ts`:

```ts
describe('outline mode reaches the SVG and the canvas paths', () => {
  it('toSvg writes fill="none" and a stroke per outline shape', async () => {
    const svg = await toSvg({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', paintTarget: 'outline', fills: ['#ff0000', '#00ff00'], strokeWidth: 1, count: 2, layout: 'linear', spacing: 300 })
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke="#ff0000"')
    expect(svg).toContain('stroke="#00ff00"')
  })
  it('shapePaints skips outline shapes (nothing to warm)', async () => {
    const shapes = await renderShapes({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', paintTarget: 'outline', count: 3, layout: 'linear' })
    expect(shapePaints(shapes)).toEqual([])
  })
})
```

Add `shapePaints` to the render spec's import from `~/lib/geoshape/render`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/geoshape-boolean.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts`
Expected: FAIL — ramp gives only two colours; outline shapes still carry a fill.

- [ ] **Step 3: Add the helpers to `boolean.ts`** (after `solidOf`)

```ts
import { rampColour } from '~/lib/color/ramp'

/** The colour clone/piece `rank` of `total` gets from `fills`: cycled (today) or
 *  read as a smooth ramp when `fillCycle` is 'ramp'. */
function cloneColour(fills: Paint[], rank: number, total: number, cfg: GeoShapeConfig): Paint {
  if (cfg.fillCycle === 'ramp') return rampColour(fills, total > 1 ? rank / (total - 1) : 0)
  return fills[rank % fills.length]!
}

/** Where a shape's colour lands, per `paintTarget`. `strokeColour` is the colour
 *  an outline takes — the clone's own colour in per-clone/pieces mode, the
 *  single stroke (or fill) in single mode. `fill: null` is an explicit
 *  fill="none": drawToCanvas reads `paint ?? fill` and skips a falsy value,
 *  toSvg writes none — so outline mode needs no renderer change. */
function styled(paint: Paint, cfg: GeoShapeConfig, strokeColour: string): Pick<GeoVectorShape, 'paint' | 'fill' | 'stroke' | 'strokeWidth'> {
  switch (cfg.paintTarget) {
    case 'outline':
      return { paint: undefined, fill: null, stroke: strokeColour, strokeWidth: cfg.strokeWidth || 1 }
    case 'both':
      return { paint, fill: solidOf(paint), stroke: strokeColour, strokeWidth: cfg.strokeWidth || 1 }
    default:
      return { paint, fill: solidOf(paint), stroke: cfg.stroke, strokeWidth: cfg.strokeWidth || undefined }
  }
}
```

- [ ] **Step 4: Route the three emit sites through the helpers**

perClone branch — replace the `pi` computation and the final `.map`:

```ts
      const fills = cfg.fills.length ? cfg.fills : [cfg.fill]
      const band = Math.max(1, cfg.size)
      const ranks = rankOrder(placements.map((pl, i) => ({ cx: pl.x, cy: pl.y, i })), cfg.fillOrder, band)
      const total = placements.length
      let items: { path: paper.PathItem; paint: Paint }[] = clones.map((c, i) => ({ path: c as paper.PathItem, paint: cloneColour(fills, ranks[i]!, total, cfg) }))
```

(update the symmetry and clip blocks in that branch to carry `paint` instead of `pi` — they only copy the field along), and the return:

```ts
      return items
        .filter(({ path }) => path && path.bounds && path.bounds.width > 1e-6 && path.bounds.height > 1e-6)
        .map(({ path, paint }) => ({
          commands: paperToCommands(path),
          ...styled(paint, cfg, solidOf(paint)),
          fillRule: 'nonzero' as const,
        }))
```

pieces branch — where solo pieces and `all` pieces are coloured (`fills[ranks[i]! % fills.length]!` and `fills[soloRanks[i]! % fills.length]!`), use `cloneColour(fills, ranks[i]!, all.length, cfg)` and `cloneColour(fills, soloRanks[i]!, solo.length, cfg)`. Overlap depth colouring (`fills[(p.depth - 1) % fills.length]` / `ov`) stays as it is. The final `.map` becomes:

```ts
        .map(({ path, paint }) => ({
          commands: paperToCommands(path),
          ...styled(paint, cfg, solidOf(paint)),
          fillRule: 'nonzero' as const,
        }))
```

single branch — replace the two emitted objects:

```ts
    const singleStroke = cfg.paintTarget === 'outline' ? (cfg.stroke ?? solidOf(cfg.fill)) : (cfg.stroke ?? '#000000')
    const out: GeoVectorShape[] = [{
      commands: paperToCommands(acc),
      ...styled(cfg.fill, cfg, singleStroke),
      fillRule,
    }]
    if (overlap) {
      out.push({
        commands: paperToCommands(overlap),
        ...styled(cfg.overlapFill, cfg, cfg.stroke ?? solidOf(cfg.overlapFill)),
        fillRule: 'nonzero',
      })
    }
```

Note: in the default (`fill`) case `styled` returns exactly today's fields (`paint`, `fill: solidOf`, `stroke: cfg.stroke`, `strokeWidth: cfg.strokeWidth || undefined`), so no existing render changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/geoshape-boolean.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts tests/unit/geoshape-studio-overlap.unit.spec.ts tests/unit/geoshape-studio-render.unit.spec.ts`
Expected: PASS, including every pre-existing test (the default paint target must be byte-identical to before).

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/geoshape/boolean.ts tests/unit/geoshape-boolean.unit.spec.ts tests/unit/geoshape-render.unit.spec.ts && git commit -m "feat(geoshape): colour ramp across clones + colour applies to fill/outline/both, at all three emit sites

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Controls — Blend section, Paint selects, stroke hairlines, agent guidance

**Files:**
- Modify: `frontend/app/lib/geoshape/controls.ts`
- Test: `frontend/tests/unit/geoshape-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `BLEND_EASES`, `FILL_CYCLES`, `PAINT_TARGETS` (Task 4).
- Produces: `GEO_SECTIONS` gains `'Blend'` after `'Layout'`; `LAYOUTS` (controls copy) gains `'blend'`; new controls keyed exactly `blendShape blendLibraryShape blendSides blendStarInner blendIrregularSeed blendSize blendRotate blendX blendY blendEase blendTwist fillCycle paintTarget`.

- [ ] **Step 1: Write the failing tests** (append a new `describe` to the controls spec)

```ts
describe('blend layout controls', () => {
  const keys = (c: GeoShapeConfig) => visibleGeoControls(c).map(x => x.key)

  it('the Blend group shows only in blend layout, and radius/spacing/stagger hide there', () => {
    const blend = keys({ ...DEFAULT_CONFIG, layout: 'blend' })
    for (const k of ['blendShape', 'blendSize', 'blendRotate', 'blendX', 'blendY', 'blendEase', 'blendTwist']) expect(blend).toContain(k)
    expect(blend).toContain('count')
    for (const k of ['radius', 'spacing', 'evenAngle', 'angleStep', 'stagger', 'spin']) expect(blend).not.toContain(k)
    const radial = keys({ ...DEFAULT_CONFIG, layout: 'radial' })
    expect(radial).not.toContain('blendShape')
  })

  it('shape B sub-controls follow B\'s kind like A\'s do', () => {
    const star = keys({ ...DEFAULT_CONFIG, layout: 'blend', blendShape: 'star' })
    expect(star).toContain('blendSides'); expect(star).toContain('blendStarInner'); expect(star).not.toContain('blendLibraryShape')
    const lib = keys({ ...DEFAULT_CONFIG, layout: 'blend', blendShape: 'library' })
    expect(lib).toContain('blendLibraryShape'); expect(lib).not.toContain('blendSides')
    const irr = keys({ ...DEFAULT_CONFIG, layout: 'blend', blendShape: 'irregular' })
    expect(irr).toContain('blendIrregularSeed'); expect(irr).toContain('blendSides')
  })

  it('Blend sits right after Layout in the section order', () => {
    expect(GEO_SECTIONS.indexOf('Blend')).toBe(GEO_SECTIONS.indexOf('Layout') + 1)
  })

  it('paintTarget always shows; fillCycle only with a multi-colour strategy', () => {
    const single = keys({ ...DEFAULT_CONFIG, fillStrategy: 'single' })
    expect(single).toContain('paintTarget'); expect(single).not.toContain('fillCycle')
    const per = keys({ ...DEFAULT_CONFIG, fillStrategy: 'perClone' })
    expect(per).toContain('fillCycle')
  })

  it('strokeWidth shows for an outline with no stroke colour set, and reaches hairlines', () => {
    const outline = visibleGeoControls({ ...DEFAULT_CONFIG, stroke: null, paintTarget: 'outline' })
    const sw = outline.find(c => c.key === 'strokeWidth')
    expect(sw).toBeDefined()
    expect((sw as any).step).toBe(0.25)
    expect(keys({ ...DEFAULT_CONFIG, stroke: null, paintTarget: 'fill' })).not.toContain('strokeWidth')
  })

  it('the layout select offers blend', () => {
    const layout = GEO_CONTROLS.find(c => c.key === 'layout') as any
    expect(layout.options).toContain('blend')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/geoshape-controls.unit.spec.ts`
Expected: FAIL — the drift guard already fails ("missing controls for blendShape, …"), plus the new describe.

- [ ] **Step 3: Edit `controls.ts`**

Imports: add `BLEND_EASES, FILL_CYCLES, PAINT_TARGETS` to the import from `./config`.

Sections and lists:

```ts
export const GEO_SECTIONS = ['Shape', 'Layout', 'Blend', 'Transform', 'Composite', 'Symmetry', 'Clip', 'Style', 'Paint'] as const
export const LAYOUTS: GeoLayout[] = ['radial', 'grid', 'linear', 'blend']
```

Gates (next to the existing ones):

```ts
const isBlend = (c: GeoShapeConfig) => c.layout === 'blend'
const blendUsesSides = (c: GeoShapeConfig) => isBlend(c) && (c.blendShape === 'star' || c.blendShape === 'irregular')
const blendIsStar = (c: GeoShapeConfig) => isBlend(c) && c.blendShape === 'star'
const blendIsIrregular = (c: GeoShapeConfig) => isBlend(c) && c.blendShape === 'irregular'
const blendIsLibrary = (c: GeoShapeConfig) => isBlend(c) && c.blendShape === 'library'
const hasOutline = (c: GeoShapeConfig) => c.stroke !== null || c.paintTarget !== 'fill'
```

Insert the Blend group after the Layout controls:

```ts
  // --- Blend (layout 'blend': the steps between shape A and shape B) --------
  select('blendShape', 'Blend to', SHAPES, DEFAULT_CONFIG.blendShape, 'Blend',
    'The shape the steps run toward. Same choices as Shape; Count is the number of steps.', { when: isBlend }),
  shapeC('blendLibraryShape', 'Blend to library shape', DEFAULT_CONFIG.blendLibraryShape, 'Blend',
    'library only: which of the 100 drawn shapes the steps run toward', { when: blendIsLibrary }),
  slider('blendSides', 'Blend to sides', 3, 24, 1, 'Blend', DEFAULT_CONFIG.blendSides, undefined, { when: blendUsesSides }),
  slider('blendStarInner', 'Blend to star inner', 0.01, 0.99, 0.01, 'Blend', DEFAULT_CONFIG.blendStarInner, undefined, { when: blendIsStar }),
  slider('blendIrregularSeed', 'Blend to irregular seed', 1, 9999, 1, 'Blend', DEFAULT_CONFIG.blendIrregularSeed, undefined, { when: blendIsIrregular }),
  slider('blendSize', 'Blend to size', 20, 600, 1, 'Blend', DEFAULT_CONFIG.blendSize, 'Size of the shape the steps run toward', { when: isBlend }),
  slider('blendRotate', 'Blend to rotation', -180, 180, 1, 'Blend', DEFAULT_CONFIG.blendRotate, 'Turns the target shape; the steps twist to meet it', { when: isBlend }),
  slider('blendX', 'Blend to X', -800, 800, 1, 'Blend', DEFAULT_CONFIG.blendX, 'Where the target shape sits, left to right. 0 = on top of the base shape', { when: isBlend }),
  slider('blendY', 'Blend to Y', -800, 800, 1, 'Blend', DEFAULT_CONFIG.blendY, 'Where the target shape sits, up and down', { when: isBlend }),
  select('blendEase', 'Spacing', [...BLEND_EASES], DEFAULT_CONFIG.blendEase, 'Blend',
    'How the steps bunch up: even, toward the start, toward the end, or toward both ends',
    { when: isBlend, optionLabels: ['Even', 'Ease in', 'Ease out', 'Ease in-out'] }),
  slider('blendTwist', 'Twist', 0, 1, 0.01, 'Blend', DEFAULT_CONFIG.blendTwist,
    'Rotates which point of the base shape meets which point of the target — small values spiral the outlines', { when: isBlend }),
```

Style: change the strokeWidth row to

```ts
  slider('strokeWidth', 'Stroke width', 0, 60, 0.25, 'Style', DEFAULT_CONFIG.strokeWidth, 'Outline thickness. Below 1 gives hairlines for stacked outlines', { when: hasOutline }),
```

Paint: add before `color('fill', …)`:

```ts
  select('fillCycle', 'Colour ramp', [...FILL_CYCLES], DEFAULT_CONFIG.fillCycle, 'Paint',
    'cycle = repeat the colour list; ramp = fade smoothly through it across all the copies',
    { when: isMultiFill, optionLabels: ['Cycle', 'Ramp'] }),
  select('paintTarget', 'Colour applies to', [...PAINT_TARGETS], DEFAULT_CONFIG.paintTarget, 'Paint',
    'fill = solid shapes (the default); outline = thin outlines only, no fill; both = fill and outline in the same colour',
    { optionLabels: ['Fill', 'Outline', 'Both'] }),
```

Guidance — extend `GEO_GUIDANCE`. Append these two paragraphs at the end of the template string (before the closing backtick), and add `"blend" draws the steps between the base shape and a second shape (see BLEND)` to the LAYOUT paragraph's list of layouts. Every camelCase token below must be a real control key (a test checks this), so write values like per-clone and ease in with hyphens/spaces:

```
BLEND: layout "blend" draws count steps between the base shape and a second shape. blendShape picks the target's family (same choices as shape; blendSides / blendStarInner / blendIrregularSeed / blendLibraryShape apply the same way), blendSize its size, blendRotate turns it, blendX / blendY put its centre relative to the base shape (0,0 = concentric — the classic ring-of-outlines look), blendEase bunches the steps (linear / ease in / ease out / ease in-out), and blendTwist rotates which point of the base meets which point of the target so the stacked outlines spiral and moiré. The rotation and scale ramps still apply on top.

STACKED OUTLINES RECIPE: "blend", "stacked outlines", "moiré lines", "die doing", "gradient made of lines", "line art blend" all mean ONE look — layout "blend", fillStrategy "perClone", paintTarget "outline", fillCycle "ramp", count 80–200, strokeWidth 0.5–1, two or three vivid fills, stroke unset, blendTwist 0.05–0.2. Worked example: {"layout":"blend","fillStrategy":"perClone","paintTarget":"outline","fillCycle":"ramp","count":140,"strokeWidth":0.75,"blendShape":"circle","blendSize":260,"blendX":90,"blendTwist":0.1}. paintTarget also works in every other layout: "outline only" / "just the outlines" = paintTarget "outline"; fillCycle "ramp" turns a two-colour fills list into a smooth fade across the copies in any layout.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/geoshape-controls.unit.spec.ts tests/unit/geoshape-agent-macro.unit.spec.ts`
Expected: PASS — including the drift guard, the "guidance names only keys that exist" check, and the select-default checks.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/geoshape/controls.ts tests/unit/geoshape-controls.unit.spec.ts && git commit -m "feat(geoshape): Blend controls (Blend to shape, size, rotation, offset, Spacing, Twist), Colour ramp + Colour applies to, hairline stroke step, agent recipe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Re-roll rolls the Blend group

**Files:**
- Modify: `frontend/app/lib/geoshape/randomize.ts`
- Test: `frontend/tests/unit/geoshape-controls.unit.spec.ts` (the existing `describe('reroll')`)

**Interfaces:**
- Consumes: `LAYOUTS` (now with `blend`) and `SHAPES` from `./controls`; `LIBRARY_IDS` already in the file.
- Produces: a `blend` lock key; `reroll` output always passes `mergeConfig` unchanged.

- [ ] **Step 1: Write the failing tests** (append inside `describe('reroll')`)

```ts
  it('rolls the blend group with the other sections and never touches the paint group', () => {
    const start: GeoShapeConfig = { ...DEFAULT_CONFIG, fillCycle: 'ramp', paintTarget: 'outline', fills: ['#111111', '#eeeeee'] }
    // Walk seeds until re-roll lands on a blend layout, so the roll actually exercises the group.
    let cfg = start, out = reroll(cfg, noLocks), tries = 0
    while (out.layout !== 'blend' && tries < 200) { cfg = out; out = reroll(cfg, noLocks); tries++ }
    expect(out.layout).toBe('blend')
    expect(out.blendSize).toBeGreaterThanOrEqual(80); expect(out.blendSize).toBeLessThanOrEqual(320)
    expect(Math.abs(out.blendRotate)).toBeLessThanOrEqual(45)
    expect(Math.abs(out.blendX)).toBeLessThanOrEqual(160)
    expect(out.blendTwist).toBeGreaterThanOrEqual(0); expect(out.blendTwist).toBeLessThanOrEqual(0.25)
    expect(out.blendEase).toBe('linear')
    expect(out.fillCycle).toBe('ramp'); expect(out.paintTarget).toBe('outline'); expect(out.fills).toEqual(start.fills)
  })

  it('a locked blend section is unchanged', () => {
    const start: GeoShapeConfig = { ...DEFAULT_CONFIG, blendShape: 'star', blendSize: 222, blendTwist: 0.4 }
    const out = reroll(start, { blend: true })
    expect(out.blendShape).toBe('star'); expect(out.blendSize).toBe(222); expect(out.blendTwist).toBe(0.4)
  })

  it('a re-rolled config is a fixed point of mergeConfig', () => {
    let out = reroll(DEFAULT_CONFIG, noLocks)
    for (let i = 0; i < 20; i++) { expect(mergeConfig(JSON.parse(JSON.stringify(out)))).toEqual(out); out = reroll(out, noLocks) }
  })
```

Add `mergeConfig` to the spec's import from `../../app/lib/geoshape/config`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/geoshape-controls.unit.spec.ts`
Expected: FAIL — `blendSize` never rolls (stays 180 unless it happened to be in range — the lock test passes trivially; the fixed-point test may pass). At least the first test fails because `blendEase`/`blendSize` never move; if all three happen to pass, confirm with `console.log(out.blendSize)` that the value is the default, then continue.

- [ ] **Step 3: Edit `randomize.ts`**

Add a group type and roll:

```ts
type BlendGroup = Pick<GeoShapeConfig, 'blendShape' | 'blendLibraryShape' | 'blendSides' | 'blendStarInner' | 'blendIrregularSeed' | 'blendSize' | 'blendRotate' | 'blendX' | 'blendY' | 'blendEase' | 'blendTwist'>

function rollBlend(seed: string): BlendGroup {
  const r = makeRng(seed, 'blend')
  return {
    blendShape: r.pick(SHAPES),
    blendLibraryShape: r.pick(LIBRARY_IDS),
    blendSides: r.int(3, 24),
    blendStarInner: +r.range(0.01, 0.99).toFixed(2),
    blendIrregularSeed: r.int(1, 9999),
    blendSize: r.int(80, 320),
    blendRotate: r.int(-45, 45),
    blendX: r.int(-160, 160),
    blendY: r.int(-160, 160),
    blendEase: 'linear',
    blendTwist: +r.range(0, 0.25).toFixed(2),
  }
}
```

In `reroll`, add after `layoutGroup`:

```ts
  const blendGroup: BlendGroup = locks.blend
    ? { blendShape: cfg.blendShape, blendLibraryShape: cfg.blendLibraryShape, blendSides: cfg.blendSides, blendStarInner: cfg.blendStarInner, blendIrregularSeed: cfg.blendIrregularSeed, blendSize: cfg.blendSize, blendRotate: cfg.blendRotate, blendX: cfg.blendX, blendY: cfg.blendY, blendEase: cfg.blendEase, blendTwist: cfg.blendTwist }
    : rollBlend(s)
```

and spread `...blendGroup,` after `...layoutGroup,` in the returned object. Extend the `reroll` doc comment's lock-key list with `'blend'`. Paint stays untouched (the spread of `cfg` already carries `fillCycle`/`paintTarget`/`fills` through; do not add them to any roll).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/geoshape-controls.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/geoshape/randomize.ts tests/unit/geoshape-controls.unit.spec.ts && git commit -m "feat(geoshape): re-roll rolls the Blend group (lock key blend); paint group stays curated

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Whole-suite check, typecheck, live verification, docs

**Files:**
- Modify: `docs/STATE.md`, the build dashboard artifact (see the memory rule "update dashboard on every commit").
- No source changes expected; fix anything the checks turn up in the task that owns the file.

- [ ] **Step 1: Run the geoshape + vector + colour suites together**

Run: `cd frontend && npx vitest run tests/unit/geoshape-*.unit.spec.ts tests/unit/vector-morph.unit.spec.ts tests/unit/color-ramp.unit.spec.ts tests/unit/shapes-geometry.unit.spec.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck the touched files against the baseline**

Run: `cd frontend && npx nuxi typecheck 2>&1 | grep -E "geoshape|vector/morph|color/ramp" || echo "no new type errors in touched files"`
Expected: `no new type errors in touched files`. (The repo carries a pre-existing typecheck baseline; only lines naming the touched files count.)

- [ ] **Step 3: Live check in the Browser pane**

1. Start the dev server with the project's launch config (`preview_start` with the existing `.claude/launch.json` entry for the frontend; open `http://127.0.0.1:<port>/`, never `localhost`).
2. Add a Shape Studio node, open it.
3. Set: Layout → Blend; Shape → circle, Size 220; Blend to → library, pick `leaf` (or any drawn shape); Blend to size 260; Blend to X 90; Count 150; Twist 0.1; Fill → per-clone; Colour applies to → Outline; Colour ramp → Ramp; fills `#ff2d95`, `#00e5ff`; Stroke width 0.75.
4. Take a screenshot. Expected: a fan of 150 hairline outlines fading magenta→cyan, moiré where they cross, no filled shapes, nothing clipped at the frame edge.
5. Set Twist to 0 and back to 0.3 — the outlines visibly re-thread. Set Spacing to Ease in — steps bunch near the circle.
6. Export SVG (footer) and confirm the file contains `fill="none"` and 150 `<path>` elements: `grep -c "<path" ~/Downloads/shape_*.svg`.
7. Switch Layout back to Radial: the Blend group disappears and the mark renders as before.

Record the screenshot path and the grep count in the commit message of step 5.

- [ ] **Step 4: Update the documents**

- `docs/STATE.md`: change the Die Doing entry's Shape Blend paragraph status from designed to **phase one LANDED** with the commit range, one sentence on what was verified live, and a line that phase two (Frame layer) and motion remain.
- Dashboard artifact (read the live page first, edit in place, republish with the URL): move the Blend line from the Now block's "Then" into **Landed · 09-03**, update the Now block to the Screen finish as the live thread, and update the masthead HEAD.

- [ ] **Step 5: Commit**

```bash
git add docs/STATE.md && git commit -m "docs(state): Shape Blend phase one — landed write-up + live-check notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §1 (fields, defaults, validation) → Task 4. §2 (placements) → Task 5. §3 (morph) → Tasks 1–2; `lib/vector/morph.ts` per the amended spec. §4 (colour) → Task 7; the renderer-side skip is already true and is pinned by tests rather than changed. §5 (controls, guidance) → Task 8. §6 (re-roll) → Task 9. §7 (agent) → Task 8 (guidance + recipe; new keys reach the vocabulary through `GEO_CONTROLS`). §8 (performance) → no task; per-clone mode is boolean-free by construction (Task 6 does not change the strategy branches). §9 (tests) → each task; live check in Task 10. §10 out of scope honoured. §11 (phase two) excluded on purpose.
- Names are consistent: `blendPath`, `rotatePathD`, `BLEND_SAMPLES` (Task 2 → Task 6); `rampColour` (Task 3 → Task 7); `ClonePlacement.blend` (Task 5 → Task 6); `BLEND_EASES`/`FILL_CYCLES`/`PAINT_TARGETS` (Task 4 → Task 8); `styled`/`cloneColour` private to `boolean.ts`.
- `optionLabels` on `select` rows is supported by the shared `ControlSpec` type and stripped for the agent by `stripMeta` (verified in `agentControls.ts`).
