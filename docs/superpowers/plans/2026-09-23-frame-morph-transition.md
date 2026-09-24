# Frame Morph Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Frame Out transition where element A morphs into another element B over A's out bar — letter by letter or as a whole shape — and B is showing when the bar ends.

**Architecture:** The spike's centreline morph engine moves to `app/lib/vector/` and gains a piece layer (split an outline into letters, pair two words in reading order, `prepareMorph(dA, dB, style) → (t) => d`). A new behaviour kind `morph` drives one motion-only `morph` track (0 → 1). A fold stage parks `motionMorph` on A and `motionHidden` on the target; the painter, once the sibling resolver exists, swaps A for a transient path clone whose `d` is the morph at that amount, drawn with a blended fill.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (`npx vitest run <file>` from `frontend/`), canvas 2D compositor.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-morph-transition-design.md`

## Global Constraints

- Work in the main checkout; no worktree, no branch. Several sessions share it.
- **Subagents do NOT commit.** They implement, run the task's tests, and report the exact file paths changed plus test output. The controller commits each task with a private git index (`git read-tree HEAD` into a fresh `mktemp` index, `git add` only the task's paths, prove HEAD moved, then `git reset -q -- <paths>` in a separate call).
- **Never run `npm run dev`** or start any server; the controller owns the existing :3002 server.
- UI copy: sentence case, plain words, no internal identifiers; select options over internal values need `optionLabels` (positional `string[]`).
- Every fold stage returns the SAME array reference when it has nothing to do (idle identity).
- A dangling or missing target never throws: the bar does nothing.
- Only touch the files a task lists. Leave files you did not write alone even if they look broken.
- Run tests from `frontend/`: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run <path>`. Read the "Test Files" line — a spec with a syntax error runs zero tests and can still print "passed".

---

### Task 1: Move the engine to `lib/vector` and pin it with tests

**Files:**
- Move: `frontend/app/lib/vectortype/medial.ts` → `frontend/app/lib/vector/medial.ts` (use `git mv`-free plain file move: create the new file with the content, delete the old one)
- Modify: `frontend/app/pages/dev/morph-lab.vue` (imports; remove the Thickness section)
- Create: `frontend/tests/unit/vector-medial.unit.spec.ts`

**Interfaces:**
- Produces (unchanged names, new path `~/lib/vector/medial`): `type P = [number, number]`, `flattenCommands`, `resampleRing`, `delaunay`, `pinGlyph(rings: P[][], opts: PinOptions): PinnedGlyph`, `pairGlyphs(A: PinnedGlyph, B: PinnedGlyph, opts?): ContourPair[]`, `evalPair(pair, t, mode, smooth?)`, `evalGlyph(pairs: ContourPair[], t: number, mode: 'linear' | 'medial', smooth?: number): P[][]`, `unionRings(paper, rings)`, `stemHalfWidth(glyphs)`.
- Removed: `weightGlyph`, `WeightOptions` (rejected approach; weight is out of scope).

- [ ] **Step 1: Move the file.** Create `frontend/app/lib/vector/medial.ts` with the exact content of `frontend/app/lib/vectortype/medial.ts`, then delete the old file. In the new file:
  - change the header's first line to `* Vector — MEDIAL PINNING (centreline morph engine). PURE.` and its "only consumer" sentence to `Consumers: /dev/morph-lab and the Frame Morph transition (lib/vector/morphPieces.ts).`
  - delete the whole `// ── Weight: thin / thicken by PARALLEL offset…` section: the `WeightOptions` interface and `weightGlyph` function (keep `smoothstep` — `evalPair`/`collapse` use it — and keep `stemHalfWidth`).
  - `import type { PathCommand } from './outline'` becomes `import type { PathCommand } from '~/lib/vectortype/outline'`.
- [ ] **Step 2: Update the lab.** In `frontend/app/pages/dev/morph-lab.vue`: import from `~/lib/vector/medial`; remove `weightGlyph` from the import; delete the `thickness` ref, its slider row, its `Reset` button, and in `drawCentre` replace the `weightGlyph(...)` fill with filling the original rings (`for (const r of wd.rings) ctx.fill(ringsPath(r), 'evenodd')` inside the existing loop, replacing the `for (const g of wd.glyphs) { const opts = … }` block). Remove `thickness` from the `watch([...], drawCentre)` list. Run `grep -n "weightGlyph\|thickness" app/pages/dev/morph-lab.vue` → no output.
- [ ] **Step 3: Write the tests** in `frontend/tests/unit/vector-medial.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { evalGlyph, pairGlyphs, pinGlyph, type P } from '~/lib/vector/medial'

const square = (x0: number, y0: number, s: number): P[] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]
// A hole must wind the other way.
const hole = (x0: number, y0: number, s: number): P[] => square(x0, y0, s).reverse()

describe('medial pinning', () => {
  it('rebuilds every sample exactly at rest and finds a pole for each', () => {
    const g = pinGlyph([square(0, 0, 100), hole(30, 30, 40)], { h: 2 })
    expect(g.restError).toBeLessThan(1e-9)
    expect(g.orphans).toBe(0)
    expect(g.contours.map(c => c.hole)).toEqual([false, true])
    for (const c of g.contours) for (const p of c.pts) { expect(Number.isFinite(p[0])).toBe(true) }
  })
})

describe('medial morph', () => {
  const A = pinGlyph([square(0, 0, 100)], { h: 2 })
  const B = pinGlyph([square(200, 0, 100), hole(230, 30, 40)], { h: 2 })
  const pairs = pairGlyphs(A, B)

  it('pairs outer with outer and leaves the extra hole unmatched', () => {
    expect(pairs.filter(p => p.a && p.b)).toHaveLength(1)
    expect(pairs.filter(p => !p.a && p.b)).toHaveLength(1)
  })

  it('is exactly A at t = 0 and exactly B at t = 1', () => {
    for (const mode of ['linear', 'medial'] as const) {
      const at0 = evalGlyph(pairs, 0, mode)
      const at1 = evalGlyph(pairs, 1, mode)
      const m = pairs.findIndex(p => p.a && p.b)
      const pr = pairs[m]!
      pr.path.forEach(([i, j], k) => {
        expect(Math.hypot(at0[m]![k]![0] - pr.a!.pts[i]![0], at0[m]![k]![1] - pr.a!.pts[i]![1])).toBeLessThan(1e-6)
        expect(Math.hypot(at1[m]![k]![0] - pr.b!.pts[j]![0], at1[m]![k]![1] - pr.b!.pts[j]![1])).toBeLessThan(1e-6)
      })
    }
  })

  it('keeps a hole only B has shut in the first half and inside its carrier', () => {
    const u = pairs.findIndex(p => !p.a && p.b)
    const early = evalGlyph(pairs, 0.25, 'medial')[u]!
    const xs = early.map(p => p[0]), ys = early.map(p => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-6)   // still a point before halfway
    const outer = evalGlyph(pairs, 0.25, 'medial')[pairs.findIndex(p => p.a && p.b)]!
    const ox = outer.map(p => p[0])
    expect(xs[0]!).toBeGreaterThanOrEqual(Math.min(...ox) - 1e-6)   // rides with the moving outer
    expect(xs[0]!).toBeLessThanOrEqual(Math.max(...ox) + 1e-6)
    const late = evalGlyph(pairs, 0.9, 'medial')[u]!
    const lx = late.map(p => p[0])
    expect(Math.max(...lx) - Math.min(...lx)).toBeGreaterThan(10)   // open again near the end
  })

  it('never produces NaN mid-way', () => {
    for (const t of [0.1, 0.5, 0.77]) for (const ring of evalGlyph(pairs, t, 'medial')) for (const p of ring) {
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    }
  })
})
```

- [ ] **Step 4: Run** `npx vitest run tests/unit/vector-medial.unit.spec.ts` → all pass (the engine already exists; these pin it). If "shut in the first half" fails, report the numbers — do not loosen the test without saying so.
- [ ] **Step 5: Typecheck the two touched files**: `npx vue-tsc --noEmit -p . 2>&1 | grep -E "lib/vector/medial|morph-lab|vector-medial"` → no output.
- [ ] **Step 6: Report** changed paths: `app/lib/vector/medial.ts` (new), `app/lib/vectortype/medial.ts` (deleted), `app/pages/dev/morph-lab.vue`, `tests/unit/vector-medial.unit.spec.ts`.

---

### Task 2: Pieces and `prepareMorph`

**Files:**
- Create: `frontend/app/lib/vector/morphPieces.ts`
- Create: `frontend/tests/unit/vector-morph-pieces.unit.spec.ts`

**Interfaces:**
- Consumes: `pinGlyph`, `pairGlyphs`, `evalGlyph`, `P` from `~/lib/vector/medial`; `parsePathD`, `flattenSubpath` from `~/lib/vector/morph`.
- Produces:
  - `type MorphStyle = 'letters' | 'shape'`
  - `ringsFromD(d: string): P[][]`
  - `interface Piece { rings: P[][]; cx: number; cy: number; h: number }` — `rings[0]` the outer ring (positive signed area), the rest its holes (negative).
  - `splitPieces(rings: P[][]): Piece[]` — in reading order.
  - `interface PieceLink { a: number | null; b: number | null; partner?: number }` — `partner` = index into the links array of the matched link an extra rides on.
  - `alignPieces(nA: number, nB: number): PieceLink[]`
  - `prepareMorph(dA: string, dB: string, style: MorphStyle): (t: number) => string`
  - `clearMorphCache(): void`

- [ ] **Step 1: Write the failing tests** in `frontend/tests/unit/vector-morph-pieces.unit.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { alignPieces, clearMorphCache, prepareMorph, ringsFromD, splitPieces } from '~/lib/vector/morphPieces'

const sq = (x: number, y: number, s: number) => `M${x} ${y} L${x + s} ${y} L${x + s} ${y + s} L${x} ${y + s} Z`
const bbox = (d: string) => {
  const r = ringsFromD(d).flat()
  const xs = r.map(p => p[0]), ys = r.map(p => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

beforeEach(() => clearMorphCache())

describe('pieces', () => {
  it('reads a path into closed rings', () => {
    const r = ringsFromD(sq(0, 0, 10))
    expect(r).toHaveLength(1)
    expect(r[0]!.length).toBeGreaterThanOrEqual(4)
  })
  it('groups holes with the ring around them, in reading order', () => {
    // "o" at x=100 (ring + hole), "l" at x=0, "i" at x=50 (stem + dot above)
    const d = sq(100, 0, 40) + sq(110, 10, 20) + sq(0, 0, 10) + sq(50, 10, 10) + sq(50, -10, 10)
    const p = splitPieces(ringsFromD(d))
    expect(p).toHaveLength(4)
    expect(p.map(x => Math.round(x.cx))).toEqual([5, 55, 55, 120])
    expect(p[3]!.rings).toHaveLength(2)
  })
})

describe('alignPieces', () => {
  it('pairs one to one when counts match', () => {
    expect(alignPieces(3, 3)).toEqual([{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: 2, b: 2 }])
  })
  it('keeps order and gives every extra a partner when counts differ', () => {
    const links = alignPieces(2, 4)
    expect(links.filter(l => l.a != null && l.b != null)).toHaveLength(2)
    const extras = links.filter(l => l.a == null)
    expect(extras).toHaveLength(2)
    for (const e of extras) expect(links[e.partner!]!.a).not.toBeNull()
    const bs = links.map(l => l.b).filter((b): b is number => b != null)
    expect(bs).toEqual([...bs].sort((x, y) => x - y))
  })
})

describe('prepareMorph', () => {
  const A = sq(0, 0, 20) + sq(40, 0, 20)
  const B = sq(0, 100, 30) + sq(60, 100, 30) + sq(120, 100, 30)
  for (const style of ['letters', 'shape'] as const) {
    it(`${style}: starts as A, ends as B, no NaN between`, () => {
      const f = prepareMorph(A, B, style)
      expect(bbox(f(0)).map(Math.round)).toEqual(bbox(A).map(Math.round))
      expect(bbox(f(1)).map(Math.round)).toEqual(bbox(B).map(Math.round))
      expect(f(0.5)).not.toMatch(/NaN/)
    })
  }
  it('caches by outline pair and style', () => {
    expect(prepareMorph(A, B, 'letters')).toBe(prepareMorph(A, B, 'letters'))
    expect(prepareMorph(A, B, 'shape')).not.toBe(prepareMorph(A, B, 'letters'))
  })
  it('returns an empty path for an empty side', () => {
    expect(prepareMorph('', B, 'letters')(0.5)).toBe('')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/vector-morph-pieces.unit.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `frontend/app/lib/vector/morphPieces.ts`:

```ts
/**
 * Morph pieces — the Frame Morph transition's layer over the centreline engine (`medial.ts`).
 * PURE. An outline `d` becomes PIECES (an outer ring plus the holes inside it: one per letter,
 * two for an `i`), two piece lists pair in reading order, and `prepareMorph` returns the
 * cheap per-frame evaluator. Analysing a word costs ~100–300 ms, so it runs once per pair of
 * outlines and style (small LRU), never per frame.
 * Spec: docs/superpowers/specs/2026-09-23-frame-morph-transition-design.md
 */
import { evalGlyph, pairGlyphs, pinGlyph, type P } from './medial'
import { flattenSubpath, parsePathD } from './morph'

export type MorphStyle = 'letters' | 'shape'
export interface Piece { rings: P[][]; cx: number; cy: number; h: number }
export interface PieceLink { a: number | null; b: number | null; partner?: number }

const area = (r: P[]) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i]!, b = r[(i + 1) % r.length]!; s += a[0] * b[1] - b[0] * a[1] } return s / 2 }
const inside = (pt: P, poly: P[]) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}
const oriented = (r: P[], positive: boolean) => ((area(r) > 0) === positive ? r : r.slice().reverse())

export function ringsFromD(d: string): P[][] {
  if (!d || !d.trim()) return []
  let subs
  try { subs = parsePathD(d) } catch { return [] }
  return subs.map(s => flattenSubpath(s)).filter(r => r.length >= 3 && Math.abs(area(r)) > 1e-9)
}

/** Outer rings (inside an even number of others) each take the holes directly inside them.
 *  Rings are ORIENTED (outer positive, hole negative) so a nonzero fill of the morph is right
 *  whatever winding the source used. Reading order: lines by centre height (a line = pieces
 *  whose centres sit within half the median piece height), then left to right. */
export function splitPieces(rings: P[][]): Piece[] {
  const depth = rings.map((r, i) => rings.reduce((n, o, j) => (j !== i && inside(r[0]!, o) ? n + 1 : n), 0))
  const pieces: Piece[] = []
  rings.forEach((r, i) => {
    if (depth[i]! % 2 !== 0) return
    const holes = rings.filter((h, j) => depth[j] === depth[i]! + 1 && inside(h[0]!, r)).map(h => oriented(h, false))
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
    pieces.push({ rings: [oriented(r, true), ...holes], cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: y1 - y0 })
  })
  const hs = pieces.map(p => p.h).sort((a, b) => a - b)
  const band = (hs[Math.floor(hs.length / 2)] ?? 1) / 2 || 1
  const byY = pieces.slice().sort((a, b) => a.cy - b.cy)
  const line = new Map<Piece, number>()
  let li = 0, lineTop = byY[0]?.cy ?? 0
  for (const p of byY) { if (p.cy - lineTop > band) { li++; lineTop = p.cy } line.set(p, li) }
  return pieces.sort((a, b) => (line.get(a)! - line.get(b)!) || (a.cx - b.cx))
}

/** Order-keeping pairing of nA pieces with nB pieces by reading RANK (0..1). Where one side has
 *  more, the extras become links with a null side and a `partner`: the matched link they ride on
 *  (they shrink into / grow out of it). */
export function alignPieces(nA: number, nB: number): PieceLink[] {
  if (nA === 0 || nB === 0) return []
  const s = (i: number, n: number) => (n === 1 ? 0.5 : i / (n - 1))
  const D = Array.from({ length: nA }, () => new Array<number>(nB).fill(Infinity))
  for (let i = 0; i < nA; i++) for (let j = 0; j < nB; j++) {
    const c = Math.abs(s(i, nA) - s(j, nB))
    const prev = i === 0 && j === 0 ? 0 : Math.min(i > 0 && j > 0 ? D[i - 1]![j - 1]! : Infinity, i > 0 ? D[i - 1]![j]! : Infinity, j > 0 ? D[i]![j - 1]! : Infinity)
    D[i]![j] = c + prev
  }
  const path: [number, number][] = []
  let i = nA - 1, j = nB - 1
  path.push([i, j])
  while (i > 0 || j > 0) {
    if (i === 0) j--
    else if (j === 0) i--
    else { const d = D[i - 1]![j - 1]!, l = D[i - 1]![j]!, u = D[i]![j - 1]!; if (d <= l && d <= u) { i--; j-- } else if (l <= u) i--; else j-- }
    path.push([i, j])
  }
  path.reverse()
  const links: PieceLink[] = []
  const usedA = new Map<number, number>(), usedB = new Map<number, number>()
  for (const [a, b] of path) {
    if (!usedA.has(a) && !usedB.has(b)) { usedA.set(a, links.length); usedB.set(b, links.length); links.push({ a, b }) }
  }
  for (const [a, b] of path) {
    if (!usedA.has(a)) { usedA.set(a, links.length); links.push({ a, b: null, partner: usedB.get(b)! }) }
    if (!usedB.has(b)) { usedB.set(b, links.length); links.push({ a: null, b, partner: usedA.get(a)! }) }
  }
  return links
}

const toD = (rings: P[][]) => rings.filter(r => r.length >= 3)
  .map(r => 'M' + r.map(p => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join('L') + 'Z').join('')
const centroid = (rings: P[][]): P => {
  let x = 0, y = 0, n = 0
  for (const p of rings[0] ?? []) { x += p[0]; y += p[1]; n++ }
  return n ? [x / n, y / n] : [0, 0]
}
const smooth01 = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

function build(dA: string, dB: string, style: MorphStyle): (t: number) => string {
  const rA = ringsFromD(dA), rB = ringsFromD(dB)
  if (!rA.length || !rB.length) return () => ''
  const pA = splitPieces(rA), pB = splitPieces(rB)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of [...rA, ...rB].flat()) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  const h = Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0) / 300)
  const pin = (rings: P[][]) => pinGlyph(rings, { h, spur: 1.5 })
  if (style === 'shape' || pA.length === 0 || pB.length === 0) {
    const pairs = pairGlyphs(pin(pA.flatMap(p => p.rings)), pin(pB.flatMap(p => p.rings)))
    return (t) => toD(evalGlyph(pairs, t, 'medial'))
  }
  const links = alignPieces(pA.length, pB.length)
  const matched = links.map(l => (l.a != null && l.b != null ? pairGlyphs(pin(pA[l.a]!.rings), pin(pB[l.b]!.rings)) : null))
  return (t) => {
    const out: P[][] = []
    const now = links.map((l, k) => (matched[k] ? evalGlyph(matched[k]!, t, 'medial') : null))
    links.forEach((l, k) => {
      if (now[k]) { out.push(...now[k]!); return }
      const C = centroid(now[l.partner!] ?? [])
      const rings = l.a != null ? pA[l.a]!.rings : pB[l.b!]!.rings
      // An extra piece shrinks into its partner in the first half (A only) or grows out of it
      // in the second (B only), riding with the partner's centre so it never flies off.
      const shut = smooth01(0, 0.5, l.a != null ? t : 1 - t)
      for (const r of rings) out.push(r.map(p => [p[0] + (C[0] - p[0]) * shut, p[1] + (C[1] - p[1]) * shut] as P))
    })
    return toD(out)
  }
}

const CACHE_MAX = 16
const cache = new Map<string, (t: number) => string>()
export function prepareMorph(dA: string, dB: string, style: MorphStyle): (t: number) => string {
  const key = `${style}\u0000${dA}\u0000${dB}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const f = build(dA, dB, style)
  cache.set(key, f)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return f
}
export function clearMorphCache(): void { cache.clear() }
```

- [ ] **Step 4: Run** the test file → PASS. Also re-run `tests/unit/vector-medial.unit.spec.ts` and `tests/unit/vector-morph.unit.spec.ts` → PASS. If the reading-order test's expected `cx` list differs only because the dot and stem of the `i` tie, keep the stem-before-dot order the test states by sorting ties on `cy` descending — say so in the report.
- [ ] **Step 5: Report** paths: `app/lib/vector/morphPieces.ts`, `tests/unit/vector-morph-pieces.unit.spec.ts`, with the test output.

---

### Task 3: The `morph` behaviour, its timeline row and two gallery tiles

**Files:**
- Modify: `frontend/app/lib/motionx/behaviour.ts` (after the `settle` compiler, ~L77)
- Modify: `frontend/app/lib/motionx/adapter/frame.ts:134` (`MOTION_ONLY_LABELS`)
- Modify: `frontend/app/lib/motionx/gallery.ts` (Out tiles, after `...SETTLE_OUT_TILES`)
- Modify: `frontend/app/lib/motionx/bands.ts` only if its bar-label function needs a `morph` case (check `bandLabel`/the `settle` branch near L118; label must read "Morph")
- Test: `frontend/tests/unit/motionx/behaviour.unit.spec.ts`, `frontend/tests/unit/motionx/gallery.unit.spec.ts` (add cases)

**Interfaces:**
- Produces: behaviour kind `'morph'`, params `{ target?: string /* StackKey 'l:<id>' */; style?: 'letters' | 'shape'; ease? }`, compiling to one track on property `morph` from 0 to 1 over the bar; `MOTION_ONLY_LABELS.morph === 'Morph'`; gallery ids `'morph-letters'`, `'morph-shape'`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/motionx/behaviour.unit.spec.ts` (match the file's existing imports; `compileBehaviour` is from `~/lib/motionx`):

```ts
describe('morph behaviour', () => {
  it('drives one motion-only morph track from 0 to 1 over the bar', () => {
    const target = { get: () => undefined, has: () => false }
    const tracks = compileBehaviour({ id: 'm1', kind: 'morph', timing: { start: 1, duration: 0.8 }, params: { style: 'letters', target: 'l:b' } }, target)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.path).toBe('morph')
    expect(tracks[0]!.keyframes.map(k => [k.t, k.value])).toEqual([[1, 0], [1.8, 1]])
  })
})
```

Append to `tests/unit/motionx/gallery.unit.spec.ts` (use the file's existing imports of the catalog; if it imports `GALLERY` or `movesForLayer`, use that):

```ts
it('offers both morph tiles as Out moves on any layer', () => {
  const caps = { gradient: false, text: false, cloner: null }
  const ids = movesForLayer(caps).filter(m => m.group === 'Out').map(m => m.id)
  expect(ids).toContain('morph-letters')
  expect(ids).toContain('morph-shape')
})
```

And in whatever spec covers `adapter/frame.ts` (`tests/unit/motionx/adapter-frame.unit.spec.ts`):

```ts
import { isMotionOnlyPath, MOTION_ONLY_LABELS } from '~/lib/motionx/adapter/frame'
it('treats morph as a motion-only row named Morph', () => {
  expect(MOTION_ONLY_LABELS.morph).toBe('Morph')
  expect(isMotionOnlyPath('layers.a.morph')).toBe(true)
})
```

- [ ] **Step 2: Run** the three spec files → the new cases FAIL.
- [ ] **Step 3: Implement.**

In `behaviour.ts`, after the `settle` registration:

```ts
// A MORPH transition (Frame, 2026-09-23): the bar drives ONE number, how far A has become its
// target (0 → 1). The target and style stay on the bar's params; the fold
// (adapter/frame.ts `applyMorphBehaviours`) and the painter read them. Always an OUT move —
// A leaves by turning into B — so there is no direction.
registerBehaviour('morph', (b) => [numTrack('morph', 0, 1, window(b.timing))])
```

In `adapter/frame.ts`: `export const MOTION_ONLY_LABELS: Record<string, string> = { reveal: 'Reveal', morph: 'Morph' }`.

In `gallery.ts`, after `...SETTLE_OUT_TILES,`:

```ts
  // Morph (2026-09-23): A turns into another element over its out bar. Two styles, two tiles
  // (Julien: whole-shape morph is its own transition style). No target yet — the inspector asks.
  { id: 'morph-letters', kind: 'morph', label: 'Morph into', group: 'Out', preview: 'morph', params: { style: 'letters' } },
  { id: 'morph-shape', kind: 'morph', label: 'Shape morph into', group: 'Out', preview: 'morph', params: { style: 'shape' } },
```

Check `MotionGallery.vue` renders `preview: 'morph'` without a gradient-specific assumption; if its `morph` preview needs gradient stops, add a plain `'shape-morph'` `PreviewKind` whose CSS preview animates `border-radius` from `0` to `50%` with the same keyframe idiom the `grow`/`shrink` previews use, and use it for both tiles.

- [ ] **Step 4: Run** the three spec files → PASS, then `npx vitest run tests/unit/motionx`. If anything else fails, report the failing test names and whether they touch the files you changed. Never `git stash` (the stash is shared).
- [ ] **Step 5: Report** changed paths and test output.

---

### Task 4: The fold — `applyMorphBehaviours`, hiding the target

**Files:**
- Modify: `frontend/app/lib/motionx/adapter/frame.ts` (new export after `applyRevealBehaviours`)
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`foldMotion` ~L5795; the draw loop's per-item skip near the `motionReveal` read ~L6004)
- Modify: `frontend/app/lib/compositor/silhouetteCache.ts:47` (`SILHOUETTE_KEY_STRIP`)
- Create: `frontend/tests/unit/motionx/morph-fold.unit.spec.ts`

**Interfaces:**
- Consumes: the `morph` track from Task 3 (`layers.<id>.morph`, tagged with `behaviourId`).
- Produces:
  - `export interface MotionMorph { target: string; style: 'letters' | 'shape'; amount: number }`
  - `export function applyMorphBehaviours(layers: LocalLayer[], tracks: Track[] | undefined, behaviours: StoredBehaviour[] | undefined, t: number | undefined): LocalLayer[]`
  - transient clone fields: `motionMorph?: MotionMorph` (on A, 0 < amount < 1), `motionHidden?: true` (A after its bar; any target before its morph ends)

- [ ] **Step 1: Write the failing tests** `tests/unit/motionx/morph-fold.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyMorphBehaviours, compileBehaviourForLayer } from '~/lib/motionx/adapter/frame'
import type { StoredBehaviour, Track } from '~/lib/motionx'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const layer = (id: string) => ({ id, kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1, fill: '#ff0000' }) as unknown as LocalLayer
const A = layer('a'), B = layer('b'), C = layer('c')
const bar = (id: string, layerId: string, start: number, target?: string): StoredBehaviour =>
  ({ id, layerId, kind: 'morph', timing: { start, duration: 1 }, params: { style: 'letters', ...(target ? { target } : {}) } })
// Tracks are tagged with their bar's id by `setBehaviourTracks` in the app; tag them here.
const tracksFor = (bs: StoredBehaviour[], ls: LocalLayer[]): Track[] =>
  bs.flatMap(b => compileBehaviourForLayer(ls.find(l => l.id === b.layerId)!, b).map(t => ({ ...t, behaviourId: b.id })))
const get = (ls: LocalLayer[], id: string) => ls.find(l => l.id === id) as unknown as Record<string, unknown>

describe('applyMorphBehaviours', () => {
  const bs = [bar('m', 'a', 1, 'l:b')]
  const tr = tracksFor(bs, [A, B])

  it('before the bar: A as is, B hidden', () => {
    const out = applyMorphBehaviours([A, B], tr, bs, 0.5)
    expect(get(out, 'a').motionMorph).toBeUndefined()
    expect(get(out, 'a').motionHidden).toBeUndefined()
    expect(get(out, 'b').motionHidden).toBe(true)
  })
  it('during the bar: A carries the morph, B hidden', () => {
    const out = applyMorphBehaviours([A, B], tr, bs, 1.5)
    const mm = get(out, 'a').motionMorph as { target: string; style: string; amount: number }
    expect(mm.target).toBe('l:b')
    expect(mm.style).toBe('letters')
    expect(mm.amount).toBeGreaterThan(0)
    expect(mm.amount).toBeLessThan(1)
    expect(get(out, 'b').motionHidden).toBe(true)
  })
  it('after the bar: A hidden, B showing', () => {
    const out = applyMorphBehaviours([A, B], tr, bs, 3)
    expect(get(out, 'a').motionHidden).toBe(true)
    expect(get(out, 'b').motionHidden).toBeUndefined()
    expect(out.find(l => l.id === 'b')).toBe(B)
  })
  it('a chain A → B → C shows B between the two bars', () => {
    const chain = [bar('m1', 'a', 1, 'l:b'), bar('m2', 'b', 4, 'l:c')]
    const out = applyMorphBehaviours([A, B, C], tracksFor(chain, [A, B, C]), chain, 3)
    expect(get(out, 'b').motionHidden).toBeUndefined()
    expect(get(out, 'c').motionHidden).toBe(true)
  })
  it('no target or a dangling one: nothing happens at any time', () => {
    for (const b of [bar('x', 'a', 1), bar('y', 'a', 1, 'l:gone')]) {
      for (const t of [0.5, 1.5, 3]) {
        const ls = [A, B]
        expect(applyMorphBehaviours(ls, tracksFor([b], ls), [b], t)).toBe(ls)
      }
    }
  })
  it('idle identity with no morph bars', () => {
    const ls = [A, B]
    expect(applyMorphBehaviours(ls, [], [], 1)).toBe(ls)
  })
})
```

- [ ] **Step 2: Run** it → FAIL (not exported).
- [ ] **Step 3: Implement** in `adapter/frame.ts`, after `applyRevealBehaviours`:

```ts
/** A layer mid-morph: which element it is becoming, how, and how far. Transient, one frame. */
export interface MotionMorph { target: string; style: 'letters' | 'shape'; amount: number }

/**
 * Fold morph transitions (spec 2026-09-23). For every layer with a tagged `morph` track whose
 * WINNING bar is a `morph` with a live target (`l:<id>` naming a layer in `layers`):
 *   amount ≤ 0 → A unchanged; the target hidden (it has not arrived yet);
 *   between    → `motionMorph` on A; the target hidden;
 *   amount ≥ 1 → A hidden; the target shown (unless another unfinished morph targets it).
 * A bar with no target, or a target that is not in `layers`, does nothing at all — A leaves as
 * if it had no Out transition. Hidden = a transient `motionHidden` the painter skips; the layer
 * stays in the list so the sibling resolver can still read its outline and placement.
 * Same-reference return when nothing is attached.
 */
export function applyMorphBehaviours(
  layers: LocalLayer[], tracks: Track[] | undefined, behaviours: StoredBehaviour[] | undefined, t: number | undefined,
): LocalLayer[] {
  if (!tracks || tracks.length === 0 || !behaviours || behaviours.length === 0 || t == null) return layers
  const byLayer = new Map<string, Track[]>()
  for (const tr of tracks) {
    if (!tr.behaviourId || tr.muted) continue
    const m = tr.path.match(/^layers\.([^.]+)\.morph$/)
    if (!m) continue
    const list = byLayer.get(m[1]!)
    if (list) list.push(tr); else byLayer.set(m[1]!, [tr])
  }
  if (byLayer.size === 0) return layers
  const ids = new Set(layers.map(l => l.id))
  const self = new Map<string, { hidden?: true; morph?: MotionMorph }>()
  const hideTargets = new Set<string>()
  for (const [id, list] of byLayer) {
    const pick = pickTrack(list, t)
    const bar = pick && behaviours.find(b => b.id === pick.behaviourId && b.kind === 'morph')
    if (!pick || !bar) continue
    const target = typeof bar.params?.target === 'string' ? bar.params.target : ''
    const tid = target.startsWith('l:') ? target.slice(2) : ''
    if (!tid || tid === id || !ids.has(tid)) continue
    const v = evaluateTrack(pick, t)
    const amount = typeof v === 'number' && Number.isFinite(v) ? v : 0
    const style = bar.params?.style === 'shape' ? 'shape' : 'letters'
    if (amount >= 1) self.set(id, { hidden: true })
    else {
      hideTargets.add(tid)
      if (amount > 0) self.set(id, { morph: { target, style, amount } })
    }
  }
  if (self.size === 0 && hideTargets.size === 0) return layers
  return layers.map((layer) => {
    const s = self.get(layer.id)
    const hide = hideTargets.has(layer.id) || s?.hidden
    if (!hide && !s?.morph) return layer
    return { ...layer, ...(hide ? { motionHidden: true } : {}), ...(s?.morph ? { motionMorph: s.morph } : {}) } as unknown as LocalLayer
  })
}
```

In `useCompositorLayers.ts` `foldMotion`, wrap the outermost call:

```ts
  const foldMotion = (ls: LocalLayer[], clock: number | undefined, revealClock: number | undefined = clock): LocalLayer[] =>
    applyMorphBehaviours(applyRevealBehaviours(applyTextBehaviours(applyMotionxTracks(
      applyFillPhaseTracks(
        applyEffectDialTracks(ls, motion?.tracks, clock),
        motion?.tracks,
        clock,
      ),
      motion?.motionx,
      clock,
    ), motion?.behaviours, clock), motion?.motionx, motion?.behaviours, revealClock), motion?.motionx, motion?.behaviours, revealClock)
```

(import `applyMorphBehaviours` alongside `applyRevealBehaviours`). In the draw loop, directly before `const rv = (layer as unknown as { motionReveal?: MotionReveal }).motionReveal`, add:

```ts
      // A morph target that has not arrived yet, or an element that has finished turning into
      // its target: not drawn this frame (it stays in the stack so siblings can still read it).
      if ((layer as unknown as { motionHidden?: boolean }).motionHidden) continue
```

In `silhouetteCache.ts`, add `'motionMorph'` and `'motionHidden'` to `SILHOUETTE_KEY_STRIP`.

- [ ] **Step 4: Run** `tests/unit/motionx/morph-fold.unit.spec.ts`, `tests/unit/motionx/reveal-fold.unit.spec.ts`, `tests/unit/motionx/adapter-frame.unit.spec.ts`, `tests/unit/motionx/pipeline.unit.spec.ts` → PASS. Typecheck grep for the touched files → no new errors.
- [ ] **Step 5: Report** paths and output.

---

### Task 5: Draw the morph — the transient path clone

**Files:**
- Create: `frontend/app/lib/compositor/morphDraw.ts` (pure helpers)
- Modify: `frontend/app/composables/useCompositorLayers.ts` (a `resolveMorphs` function next to `buildSiblingResolver` ~L1488; its call right after `const siblingResolver = buildSiblingResolver(localLayers, W, H)` ~L5933)
- Create: `frontend/tests/unit/compositor-morph-draw.unit.spec.ts`

**Interfaces:**
- Consumes: `MotionMorph` and `motionHidden` (Task 4), `prepareMorph` (Task 2), `computedOutlineD`, `outlineUnitPx`, `SiblingResolver` (existing), `effectStackOf`, `writeStackToLayer`, `regionOf` (`~/lib/compositor/effectStack`), `mixHex` (`~/lib/color/mix`).
- Produces:
  - `morphFillOf(layer: { kind: string; fill?: Paint; color?: Paint }): Paint | undefined` — text → `color`, else `fill`.
  - `blendMorphPaint(a: Paint | undefined, b: Paint | undefined, t: number): Paint` — both hex → `mixHex`; else `t < 0.5 ? a : b` (`''` for undefined).
  - `ringsBBoxOfD(d: string): { w: number; h: number }`
  - `resolveMorphs(items: StackItem[], localLayers: LocalLayer[], W: number, resolver: SiblingResolver<LocalLayer>): { items: StackItem[]; localLayers: LocalLayer[] }` (not exported beyond the module; same references back when no layer carries `motionMorph`).

- [ ] **Step 1: Write the failing tests** `tests/unit/compositor-morph-draw.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { blendMorphPaint, morphFillOf, ringsBBoxOfD } from '~/lib/compositor/morphDraw'

describe('morph draw helpers', () => {
  it('reads a text layer colour and a shape fill', () => {
    expect(morphFillOf({ kind: 'text', color: '#112233' })).toBe('#112233')
    expect(morphFillOf({ kind: 'rect', fill: '#445566' })).toBe('#445566')
  })
  it('blends two solid colours and is exact at the ends', () => {
    expect(blendMorphPaint('#000000', '#ffffff', 0).toLowerCase()).toBe('#000000')
    expect(blendMorphPaint('#000000', '#ffffff', 1).toLowerCase()).toBe('#ffffff')
    expect(blendMorphPaint('#000000', '#ffffff', 0.5)).not.toBe('#000000')
  })
  it('switches a non-solid paint at the midpoint', () => {
    const g = { type: 'linear', angle: 0, stops: [] } as never
    expect(blendMorphPaint(g, '#ffffff', 0.4)).toBe(g)
    expect(blendMorphPaint(g, '#ffffff', 0.6)).toBe('#ffffff')
    expect(blendMorphPaint(undefined, undefined, 0.3)).toBe('')
  })
  it('measures a path', () => {
    expect(ringsBBoxOfD('M-5 -2L5 -2L5 2L-5 2Z')).toEqual({ w: 10, h: 4 })
  })
})
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `frontend/app/lib/compositor/morphDraw.ts`:

```ts
/**
 * Frame Morph transition — the pure pieces of drawing one frame of a morph (spec
 * 2026-09-23). The compositor-coupled part (`resolveMorphs`) lives in useCompositorLayers.ts.
 */
import type { Paint } from '~/lib/compositor/paint'
import { mixHex } from '~/lib/color/mix'
import { ringsFromD } from '~/lib/vector/morphPieces'

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function morphFillOf(layer: { kind: string; fill?: Paint; color?: Paint }): Paint | undefined {
  return layer.kind === 'text' ? layer.color : layer.fill
}

/** Solid ↔ solid blends (exact at the ends); anything else switches at the midpoint. */
export function blendMorphPaint(a: Paint | undefined, b: Paint | undefined, t: number): Paint {
  if (typeof a === 'string' && typeof b === 'string' && HEX.test(a) && HEX.test(b)) return mixHex(a, b, t)
  return (t < 0.5 ? a : b) ?? ''
}

export function ringsBBoxOfD(d: string): { w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of ringsFromD(d)) for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 }
}
```

(Check `mixHex` accepts 3- and 8-digit hex — read `parseHexA` in `app/lib/color/mix.ts`; if it does not, normalise 3-digit to 6 before calling and drop the 8-digit case from `HEX`.)

In `useCompositorLayers.ts`, next to `buildSiblingResolver`:

```ts
/**
 * Frame Morph (spec 2026-09-23): swap every layer carrying `motionMorph` for a transient PATH
 * clone whose outline is the morph, at that amount, between A's computed outline and its target's
 * outline resolved into A's frame (so it lands where B really is). A's placement, effects (minus
 * geometry ones — already inside its computed outline) and blend stay; fill and opacity blend
 * toward B's. Either outline missing (photo, system font, decoration, font still loading) →
 * cross-fade: A fades out, the target fades in. Same references back when nothing morphs.
 */
function resolveMorphs(
  items: StackItem[], localLayers: LocalLayer[], W: number, resolver: SiblingResolver<LocalLayer>,
): { items: StackItem[]; localLayers: LocalLayer[] } {
  const swaps = new Map<string, LocalLayer>()
  for (const layer of localLayers) {
    const mm = (layer as unknown as { motionMorph?: MotionMorph }).motionMorph
    if (!mm) continue
    const target = localLayers.find(l => `l:${l.id}` === mm.target)
    if (!target) continue
    const dA = computedOutlineD(layer, W, (key) => resolver(key, layer))
    const sib = resolver(mm.target, layer)
    const bare = { ...layer, motionMorph: undefined } as unknown as LocalLayer
    if (!dA || !sib) {
      swaps.set(layer.id, { ...bare, opacity: (layer.opacity ?? 1) * (1 - mm.amount) } as LocalLayer)
      swaps.set(target.id, { ...target, motionHidden: undefined, opacity: (target.opacity ?? 1) * mm.amount } as unknown as LocalLayer)
      continue
    }
    const d = prepareMorph(dA, sib.d, mm.style)(mm.amount)
    const unit = outlineUnitPx(layer, W)
    const stack = effectStackOf(layer).filter(e => regionOf(e.type) !== 'geometry')
    swaps.set(layer.id, {
      ...bare,
      ...writeStackToLayer(stack),
      kind: 'path', d, bbox: ringsBBoxOfD(d), scale: unit / W, fillRule: 'nonzero',
      fill: blendMorphPaint(morphFillOf(layer as never), morphFillOf(target as never), mm.amount),
      stroke: '', strokeWidth: 0,
      opacity: (layer.opacity ?? 1) + ((target.opacity ?? 1) - (layer.opacity ?? 1)) * mm.amount,
    } as unknown as LocalLayer)
  }
  if (swaps.size === 0) return { items, localLayers }
  return {
    localLayers: localLayers.map(l => swaps.get(l.id) ?? l),
    items: items.map(it => (it.type === 'local' && swaps.has(it.layer.id) ? { ...it, layer: swaps.get(it.layer.id)! } : it)),
  }
}
```

Call it right after the resolver is built (the resolver keeps the pre-swap list, so B's outline and placement are B's own):

```ts
  const siblingResolver = buildSiblingResolver(localLayers, W, H)
  _siblingResolveFor = (self: LocalLayer) => (key: string) => siblingResolver(key, self)
  ;({ items, localLayers } = resolveMorphs(items, localLayers, W, siblingResolver))
```

Verify before relying on them: `SiblingResolver<L>`'s call signature is `(key, self)` (see `siblingRef.ts` L141–174); `effectStackOf`/`writeStackToLayer`/`regionOf` names and the effect entry's `type` field in `effectStack.ts`; that `items` and `localLayers` are reassignable (`let`/parameters) at that point. If `path` layers need other required fields (`strokes`), set `strokes: undefined`.

- [ ] **Step 4: Run** the new spec, plus `tests/unit/compositor-sibling-ref.unit.spec.ts`, `tests/unit/compositor-morph-geometry.unit.spec.ts`, `tests/unit/motionx/morph-fold.unit.spec.ts` → PASS. Typecheck grep on the touched files → no new errors.
- [ ] **Step 5: Report** paths and output.

---

### Task 6: Inspector and modal wiring

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/MotionInspector.vue` (a `morph` block beside the `settle` block ~L596; a new prop)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (a `morphTargets` computed near `geometrySiblingCandidates` ~L2588; pass it to `<MotionInspector>` ~L9651; warm fonts)

**Interfaces:**
- Consumes: behaviour params `{ target?: string; style?: 'letters' | 'shape' }` (Task 3); `warmCompositorFont` (`~/lib/compositor/textOutline`).
- Produces: `MotionInspector` prop `morphTargets?: { key: string; label: string }[]`.

- [ ] **Step 1: Inspector.** Add to `defineProps`:

```ts
  /** Elements the selected layer can morph into (other local elements with an outline). */
  morphTargets?: { key: string; label: string }[]
```

Add near the other option constants in `<script setup>`:

```ts
const MORPH_STYLES = ['letters', 'shape']
const MORPH_STYLE_LABELS = ['Letter by letter', 'Whole shape']
const morphTargetOptions = computed(() => ['', ...(props.morphTargets ?? []).map(t => t.key)])
const morphTargetLabels = computed(() => ['Choose an element', ...(props.morphTargets ?? []).map(t => t.label)])
```

Add the block before `<template v-else-if="isCopiesDirBeh">`:

```html
      <template v-else-if="behaviour.kind === 'morph'">
        <StudioSelect data-testid="morph-target" label="Morph into"
          hint="The element this one turns into. It appears when the bar ends."
          :model-value="String(behaviour.params?.target ?? '')" :options="morphTargetOptions" :option-labels="morphTargetLabels"
          @update:model-value="(v) => setBehParams({ target: v || undefined })" />
        <p v-if="!behaviour.params?.target" class="text-xs opacity-70" data-testid="morph-no-target">
          Pick an element to morph into. Until then this bar does nothing.
        </p>
        <StudioSegmentedRow data-testid="morph-style" label="Style"
          :model-value="enumParam('style', 'letters')" :options="MORPH_STYLES" :option-labels="MORPH_STYLE_LABELS"
          @update:model-value="(v) => setBehParams({ style: v })" />
      </template>
```

Match the file's existing hint/paragraph styling (look at how other blocks render a one-line note; reuse that class instead of `text-xs opacity-70` if one exists).

- [ ] **Step 2: Modal.** Next to `geometrySiblingCandidates`:

```ts
/** Elements the selected layer can morph into — the geometry-sibling rule (another local element
 *  with an outline, no active corner pin, no cloner), relative to the SELECTED layer. */
const morphTargets = computed<{ key: string; label: string }[]>(() => {
  const self = selectedLocal.value
  if (!self) return []
  return (localLayers.value as LocalLayer[])
    .filter(l => l.id !== self.id && canTakeGeometry(l) && !cornerPinActive((l as any).cornerPin) && !(l as any).cloner)
    .map(l => ({ key: localKey(l.id), label: layerLabelByKey(localKey(l.id)) }))
})
```

Pass `:morph-targets="morphTargets"` on `<MotionInspector …>`. Font warm-up: add a `watch` on `motionBehaviours` (the list the modal already holds; use its real name) that, for every `morph` behaviour, calls `warmCompositorFont(layer)` for its own layer and its target layer when they are text (`warmCompositorFont` signature: read it in `textOutline.ts` ~L156 and call it the way it expects). Fonts that finish loading already trigger a repaint through `onCompositorFontReady`; confirm by reading how the modal subscribes to it.

- [ ] **Step 3: Typecheck.** Run `npx vue-tsc --noEmit -p . 2>&1 | grep -E "MotionInspector|CompositorModal"` BEFORE your edits (save the output) and AFTER; report only the lines that are new. The project has pre-existing type errors elsewhere; do not fix them.
- [ ] **Step 4: Run** `npx vitest run tests/unit/motionx` → no new failures.
- [ ] **Step 5: Report** paths, the typecheck lines, test output.

---

### Task 7 (controller): Live verification, docs, dashboard

Not dispatched — the controller does it on the existing :3002 server with the browser pane.

- [ ] Open a Frame with two text elements in different fonts ("SLANG" Permanent Marker, "SLANG" Archivo Black), add **Morph into** on the first, pick the second; scrub the bar: pixel-check B absent before the bar and present after, A absent after; screenshot mid-bar.
- [ ] Word into a different word ("SLANG" → "WORDS"), letter by letter; then **Shape morph into** a star; then Steps easing with 6 steps.
- [ ] Missing outline: target a text element in a system font → cross-fade.
- [ ] Export a short video from the Frame and check a mid-bar frame.
- [ ] Update `docs/STATE.md` (feature write-up) and the ⛵ dashboard (read live first; replace, don't append).
- [ ] Send Julien a video of the result.
