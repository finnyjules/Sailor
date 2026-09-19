# Letter Behaviours — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frame text layers can be animated by letters, words or lines — Cascade in/out, Typewriter, Mask slide, Scramble — authored as behaviour bars on the band timeline, on straight, wrapped and on-a-path text, with effects and masks still applied.

**Architecture:** A letter behaviour is a `StoredBehaviour` whose `kind` starts with `text.`; it compiles to NO tracks. A pure module `frontend/app/lib/motionx/text/` turns (behaviours, time, glyph cells) into an absolute placement per glyph. The per-frame fold in `paintLayerStack` attaches a transient `textMotion` to the text layer clone; `drawText` / `drawTextOnPath` — the innermost glyph emitters, already wrapped by the effects/mask/blend pipeline — build cells from THEIR OWN layout and draw glyph by glyph when `textMotion` is present and not at rest. Spec: `docs/superpowers/specs/2026-09-19-letter-behaviours-design.md`.

**Tech Stack:** Nuxt 4 / Vue 3 `<script setup>` / TypeScript / Tailwind; Vitest (`frontend/tests/unit/**/*.unit.spec.ts`); Canvas 2D.

## Global Constraints

- Work in the main checkout `/Users/julien/Documents/GitHub/Sailor`. No worktree, no branch, never `git stash`, never `git add -A` / `git add .`, never `git checkout -- <file>` / `git restore` / `git reset`.
- **Never start, stop or restart a dev server** (`npm run dev`, `pnpm dev`, `nuxt dev`). One is already running. Do not run Playwright.
- You share this checkout with other live sessions: touch ONLY the files your task names; leave every other modified/untracked file alone.
- **Every commit uses a private git index:**
  ```bash
  GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD
  git add -- <exact paths>; git diff --cached --stat   # must list ONLY your files
  git commit -q -m "<subject>

  <body>

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- <exact paths>
  rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
  ```
  The trailer is the LAST line of the body, after a blank line — never in the subject. To see your change to a file use `git show HEAD:<path> | diff - <path>` (do not trust `git status`).
- Unit tests from `frontend/`: `npm run test:unit -- <filter>`. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "<your files>"`. Pre-existing baseline errors on lines you did not touch (6 in `CompositorModal.vue`, 3 in `useCompositorLayers.ts`, ~18 in `useLocalLayerEditor.ts`) are not yours.
- Byte-identity: a text layer with no active letter behaviour must draw exactly as it does today (no new code path may run).
- No `Math.random()` and no `Date.now()` in anything reachable from rendering — all randomness goes through `hash01` (Task 1).
- UI copy: sentence case, plain words, no internal identifiers. Palette: surfaces `#1a1a1a` / `#0e0e10`, `border-white/10`, accent `#7c9cff`, behaviour bars emerald `rgba(120,220,170,.16)`.
- If a step says "live check", SKIP it and say so in your report — the controller does live checks.

---

### Task 1: Pure core — cells, pieces, order, timing, seeded hash

**Files:**
- Create: `frontend/app/lib/motionx/text/units.ts`, `frontend/app/lib/motionx/text/rng.ts`, `frontend/app/lib/motionx/text/order.ts`
- Test: `frontend/tests/unit/motionx/text-units.unit.spec.ts`

**Interfaces (produced):**
```ts
// units.ts
export interface TextCell { char: string; x: number; y: number; w: number; h: number; angle: number; word: number; line: number }
export type PieceBy = 'letters' | 'words' | 'lines'
export interface Piece { index: number; cells: number[]; cx: number; cy: number; w: number; h: number; angle: number }
export function groupCells(cells: TextCell[], by: PieceBy): Piece[]
// rng.ts
export function hash01(...ns: number[]): number            // deterministic, in [0, 1)
// order.ts
export type Order = 'ltr' | 'rtl' | 'center' | 'edges' | 'random'
export function pieceRanks(count: number, order: Order, seed: number): number[]
export function pieceTiming(ranks: number[], stagger: number, duration: number): { delays: number[]; pieceDur: number; staggerUsed: number }
```
Cells are in reading order; `x, y` are the glyph CENTRE in pixels in the layer's local frame (origin = layer centre, before layer rotation); `angle` is radians (0 for straight text); `word` / `line` are 0-based running indices.

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/motionx/text-units.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupCells, type TextCell } from '~/lib/motionx/text/units'
import { hash01 } from '~/lib/motionx/text/rng'
import { pieceRanks, pieceTiming } from '~/lib/motionx/text/order'

const cell = (char: string, x: number, y: number, word: number, line: number, angle = 0): TextCell => ({ char, x, y, w: 10, h: 20, angle, word, line })
// "AB CD" on line 0, "EF" on line 1
const CELLS = [cell('A', 0, 0, 0, 0), cell('B', 10, 0, 0, 0), cell('C', 30, 0, 1, 0), cell('D', 40, 0, 1, 0), cell('E', 0, 30, 2, 1), cell('F', 10, 30, 2, 1)]

describe('groupCells', () => {
  it('letters: one piece per cell, centred on it', () => {
    const p = groupCells(CELLS, 'letters')
    expect(p).toHaveLength(6)
    expect(p[2]).toMatchObject({ index: 2, cells: [2], cx: 30, cy: 0, w: 10, h: 20, angle: 0 })
  })
  it('words: cells grouped by word, centre = bounding-box centre', () => {
    const p = groupCells(CELLS, 'words')
    expect(p.map((x) => x.cells)).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(p[0]).toMatchObject({ cx: 5, cy: 0, w: 20, h: 20 })
  })
  it('lines: cells grouped by line', () => {
    const p = groupCells(CELLS, 'lines')
    expect(p.map((x) => x.cells)).toEqual([[0, 1, 2, 3], [4, 5]])
    expect(p[0]).toMatchObject({ cx: 20, w: 50 })
  })
  it('a piece angle is the circular mean of its cells (path text)', () => {
    const p = groupCells([cell('A', 0, 0, 0, 0, 0.2), cell('B', 10, 0, 0, 0, 0.4)], 'words')
    expect(p[0]!.angle).toBeCloseTo(0.3, 6)
    const wrap = groupCells([cell('A', 0, 0, 0, 0, Math.PI - 0.1), cell('B', 10, 0, 0, 0, -Math.PI + 0.1)], 'words')
    expect(Math.abs(wrap[0]!.angle)).toBeCloseTo(Math.PI, 6)      // not 0: angles wrap
  })
  it('empty text → no pieces', () => { expect(groupCells([], 'words')).toEqual([]) })
})

describe('hash01', () => {
  it('is deterministic, in [0,1), and sensitive to every argument', () => {
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3))
    for (let i = 0; i < 200; i++) { const v = hash01(7, i, 3); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
    expect(hash01(1, 2, 3)).not.toBe(hash01(1, 2, 4))
    expect(hash01(1, 2, 3)).not.toBe(hash01(2, 2, 3))
  })
  it('is roughly uniform', () => {
    let sum = 0; for (let i = 0; i < 2000; i++) sum += hash01(42, i)
    expect(sum / 2000).toBeGreaterThan(0.45); expect(sum / 2000).toBeLessThan(0.55)
  })
})

describe('pieceRanks', () => {
  it('ltr / rtl follow reading order', () => {
    expect(pieceRanks(4, 'ltr', 0)).toEqual([0, 1, 2, 3])
    expect(pieceRanks(4, 'rtl', 0)).toEqual([3, 2, 1, 0])
  })
  it('center starts in the middle and mirrors outwards; edges is the reverse', () => {
    expect(pieceRanks(5, 'center', 0)).toEqual([2, 1, 0, 1, 2])
    expect(pieceRanks(4, 'center', 0)).toEqual([1, 0, 0, 1])
    expect(pieceRanks(5, 'edges', 0)).toEqual([0, 1, 2, 1, 0])
  })
  it('random is a seeded permutation: same seed same order, other seed another order', () => {
    const a = pieceRanks(8, 'random', 5)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(pieceRanks(8, 'random', 5)).toEqual(a)
    expect(pieceRanks(8, 'random', 6)).not.toEqual(a)
  })
  it('zero or one piece', () => { expect(pieceRanks(0, 'ltr', 0)).toEqual([]); expect(pieceRanks(1, 'center', 0)).toEqual([0]) })
})

describe('pieceTiming — the bar is the whole move', () => {
  it('delay = rank × stagger; every piece gets what is left of the bar', () => {
    expect(pieceTiming([0, 1, 2], 0.1, 1)).toEqual({ delays: [0, 0.1, 0.2], pieceDur: 0.8, staggerUsed: 0.1 })
  })
  it('a stagger that does not fit is scaled down so each piece still has 0.05s', () => {
    const t = pieceTiming([0, 1, 2], 1, 1)
    expect(t.pieceDur).toBeCloseTo(0.05, 9)
    expect(t.staggerUsed).toBeCloseTo(0.475, 9)
    expect(t.delays[2]).toBeCloseTo(0.95, 9)
  })
  it('single piece / zero stagger → the whole bar', () => {
    expect(pieceTiming([0], 0.3, 2)).toEqual({ delays: [0], pieceDur: 2, staggerUsed: 0.3 })
    expect(pieceTiming([0, 1], 0, 2).pieceDur).toBe(2)
  })
})
```

- [ ] **Step 2: Run, expect failure** — `cd frontend && npm run test:unit -- motionx/text-units` → FAIL (modules not found).

- [ ] **Step 3: Implement.**

`frontend/app/lib/motionx/text/units.ts`:
```ts
// Letter behaviours — pure text geometry. A CELL is one drawn glyph; a PIECE is what a behaviour
// moves as one unit (a letter, a word or a line). Pixels, layer-local frame (origin = layer
// centre, before the layer's own rotation). No canvas, no Vue.
export interface TextCell { char: string; x: number; y: number; w: number; h: number; angle: number; word: number; line: number }
export type PieceBy = 'letters' | 'words' | 'lines'
export interface Piece { index: number; cells: number[]; cx: number; cy: number; w: number; h: number; angle: number }

export function groupCells(cells: TextCell[], by: PieceBy): Piece[] {
  const groups = new Map<number, number[]>()
  cells.forEach((c, i) => {
    const key = by === 'letters' ? i : by === 'words' ? c.word : c.line
    const g = groups.get(key); if (g) g.push(i); else groups.set(key, [i])
  })
  return [...groups.values()].map((idx, index) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, s = 0, co = 0
    for (const i of idx) {
      const c = cells[i]!
      x0 = Math.min(x0, c.x - c.w / 2); x1 = Math.max(x1, c.x + c.w / 2)
      y0 = Math.min(y0, c.y - c.h / 2); y1 = Math.max(y1, c.y + c.h / 2)
      s += Math.sin(c.angle); co += Math.cos(c.angle)
    }
    return { index, cells: idx, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, angle: Math.atan2(s, co) }
  })
}
```

`frontend/app/lib/motionx/text/rng.ts`:
```ts
/** Stateless seeded hash → [0, 1). Random ACCESS (any piece, any jump, any frame) with no
 *  sequence to keep in step — the render path must never call Math.random(). */
export function hash01(...ns: number[]): number {
  let h = 0x9e3779b9
  for (const n of ns) {
    h = Math.imul(h ^ (Math.round(n) | 0), 0x85ebca6b); h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  }
  return (h >>> 0) / 4294967296
}
```

`frontend/app/lib/motionx/text/order.ts`:
```ts
import { hash01 } from './rng'
export type Order = 'ltr' | 'rtl' | 'center' | 'edges' | 'random'
const MIN_PIECE = 0.05

/** Start RANK per piece (0 = first). Equal ranks start together (mirrored pairs). */
export function pieceRanks(count: number, order: Order, seed: number): number[] {
  const idx = Array.from({ length: count }, (_, i) => i)
  if (order === 'rtl') return idx.map((i) => count - 1 - i)
  if (order === 'center' || order === 'edges') {
    const mid = (count - 1) / 2
    const dist = idx.map((i) => Math.floor(Math.abs(i - mid)))
    const max = Math.max(0, ...dist)
    return order === 'center' ? dist : dist.map((d) => max - d)
  }
  if (order === 'random') {
    const sorted = [...idx].sort((a, b) => hash01(seed, a) - hash01(seed, b) || a - b)
    const rank = new Array<number>(count); sorted.forEach((i, r) => { rank[i] = r }); return rank
  }
  return idx
}

/** The bar is the WHOLE move: the last piece ends when the bar ends. */
export function pieceTiming(ranks: number[], stagger: number, duration: number): { delays: number[]; pieceDur: number; staggerUsed: number } {
  const maxRank = Math.max(0, ...ranks)
  const room = Math.max(0, duration - MIN_PIECE)
  const staggerUsed = maxRank > 0 ? Math.min(Math.max(0, stagger), room / maxRank) : Math.max(0, stagger)
  return { delays: ranks.map((r) => r * staggerUsed), pieceDur: Math.max(MIN_PIECE, duration - maxRank * staggerUsed), staggerUsed }
}
```

- [ ] **Step 4: Run** — `npm run test:unit -- motionx/text-units` → all pass. The tests are the judge; if one of MY expectations is arithmetically wrong (show the arithmetic), fix the expectation and say so — never loosen one to make broken code pass. Note `center` for an even count: `floor(|i − 1.5|)` = `[1,0,0,1]`.
- [ ] **Step 5: Commit** — `feat(motionx): letter behaviours core — cells, pieces, start order, bar timing, seeded hash`.

---

### Task 2: Pure evaluator + the four behaviours

**Files:**
- Create: `frontend/app/lib/motionx/text/evaluate.ts`, `frontend/app/lib/motionx/text/behaviours.ts`, `frontend/app/lib/motionx/text/index.ts`
- Test: `frontend/tests/unit/motionx/text-evaluate.unit.spec.ts`

**Interfaces:**
- Consumes (Task 1): `TextCell`, `Piece`, `PieceBy`, `groupCells`, `hash01`, `Order`, `pieceRanks`, `pieceTiming`; and from `~/lib/motionx`: `applyEase`, `type Ease`, `type StoredBehaviour`.
- Produces:
```ts
export interface CellDraw { x: number; y: number; rotation: number; scale: number; opacity: number; clip?: { x: number; y: number; w: number; h: number; angle: number } }
export interface CursorDraw { x: number; y: number; h: number; angle: number; style: 'bar' | 'underscore' }
export interface TextFrame { atRest: boolean; cells: CellDraw[]; cursor?: CursorDraw }
export interface FrameBox { w: number; h: number }                       // the frame, px
export const isTextBehaviour: (b: { kind: string }) => boolean          // kind starts with 'text.'
export function evaluateTextBehaviours(behaviours: StoredBehaviour[], t: number, cells: TextCell[], frame: FrameBox): TextFrame
```
`CellDraw.x/y` = ABSOLUTE glyph centre (layer-local px); `rotation` = radians to draw the glyph at (rest = `cell.angle`); `clip` = a rectangle in the layer-local frame (centre x/y, size, angle) that glyph must be clipped to. `atRest` ⇒ the caller draws the normal static text.

Shared `params` on every `text.*` behaviour: `by: PieceBy` (default `'letters'`), `stagger: number` seconds (default `0.04`), `order: Order` (default `'ltr'`), `seed: number` (default `1`), `ease` (already handled by the inspector as `params.ease`; default `'easeOut'`).

Behaviour kinds + params:
- `text.cascade` — `dir: 'in' | 'out'` (default in), `style: 'fade' | 'rise' | 'drop' | 'grow' | 'spin'` (default `'rise'`), `amount: number` (rise/drop: piece-heights, default `0.6`; grow: start scale, default `0`; spin: degrees, default `90`).
- `text.typewriter` — `dir: 'type' | 'delete'` (default type), `cursor: 'none' | 'bar' | 'underscore'` (default `'bar'`), `blink: number` Hz (default `2`).
- `text.maskSlide` — `dir: 'reveal' | 'hide'` (default reveal), `from: 'up' | 'down' | 'left' | 'right'` (default `'up'`: the piece rises into place from below its own box).
- `text.scramble` — `mode: 'settle' | 'scatter' | 'loop'` (default settle), `areaW`, `areaH`: share of the frame 0..1 (default `0.6`, `0.6`), `interval`: seconds per jump (default `0.18`), `move: 'snap' | 'glide'` (default snap), `spin`: degrees 0..180 (default `0`).

Timing rules (per behaviour, `start = timing.start + (timing.delay ?? 0)`, `D = max(0.05, timing.duration)`): ranks from `pieceRanks(pieces.length, order, seed)`, `{ delays, pieceDur } = pieceTiming(ranks, stagger, D)`; piece `i` progress `p = (t − start − delays[i]) / pieceDur`.
- ENTRANCE kinds (`cascade in`, `typewriter type`, `maskSlide reveal`, `scramble settle`): `p ≤ 0` ⇒ hidden (opacity 0); `p ≥ 1` ⇒ rest.
- EXIT kinds (`cascade out`, `typewriter delete`, `maskSlide hide`, `scramble scatter`): `p ≤ 0` ⇒ rest; `p ≥ 1` ⇒ hidden.
- `scramble loop`: only between `start` and `start + D`; outside ⇒ rest.
- Eased progress `e = applyEase(p, ease)`; for a spring ease `p` is NOT clamped above 1 on entrances (the tail settles), otherwise clamp to 0..1.

Composition across behaviours (per piece): offsets add, rotations add, scales multiply, opacities multiply; clips: the LAST behaviour that sets one wins. Piece → cells: a cell's centre is rotated/scaled about the PIECE centre, then offset; offsets a behaviour states in the piece's own frame (`rise`, `drop`, mask travel) are rotated by `piece.angle` into the layer frame; Scramble offsets are already layer-frame.

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/motionx/text-evaluate.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { evaluateTextBehaviours, isTextBehaviour } from '~/lib/motionx/text'
import type { TextCell } from '~/lib/motionx/text/units'

const cell = (char: string, x: number, word = 0, line = 0, angle = 0): TextCell => ({ char, x, y: 0, w: 10, h: 20, angle, word, line })
const CELLS = [cell('A', -15), cell('B', -5), cell('C', 5, 1), cell('D', 15, 1)]
const FRAME = { w: 1000, h: 500 }
const beh = (kind: string, params: Record<string, unknown> = {}, start = 1, duration = 1) =>
  ({ id: 'b', layerId: 'L', kind, params: { ease: 'linear', stagger: 0, ...params }, timing: { start, duration } }) as any
const ev = (b: any | any[], t: number, cells = CELLS) => evaluateTextBehaviours(Array.isArray(b) ? b : [b], t, cells, FRAME)

describe('basics', () => {
  it('isTextBehaviour', () => { expect(isTextBehaviour({ kind: 'text.cascade' })).toBe(true); expect(isTextBehaviour({ kind: 'fade' })).toBe(false) })
  it('no text behaviours, or no cells → at rest', () => {
    expect(ev([], 1).atRest).toBe(true)
    expect(ev({ ...beh('fade') }, 1).atRest).toBe(true)
    expect(evaluateTextBehaviours([beh('text.cascade')], 1.5, [], FRAME)).toEqual({ atRest: true, cells: [] })
  })
  it('an unknown text.* kind is ignored', () => { expect(ev(beh('text.nope'), 1.5).atRest).toBe(true) })
})

describe('text.cascade', () => {
  it('in: hidden before the bar, exactly at rest after it', () => {
    const before = ev(beh('text.cascade', { style: 'fade' }), 0.5)
    expect(before.atRest).toBe(false)
    expect(before.cells.every((c) => c.opacity === 0)).toBe(true)
    expect(ev(beh('text.cascade', { style: 'fade' }), 2.5).atRest).toBe(true)
  })
  it('rise: half way, each letter sits half the amount BELOW its place and is half visible', () => {
    const f = ev(beh('text.cascade', { style: 'rise', amount: 1 }), 1.5)
    expect(f.cells[0]).toMatchObject({ x: -15, opacity: 0.5 })
    expect(f.cells[0]!.y).toBeCloseTo(10, 6)            // 0.5 × amount 1 × piece height 20
  })
  it('out mirrors in: at rest before, hidden after', () => {
    expect(ev(beh('text.cascade', { dir: 'out', style: 'fade' }), 0.5).atRest).toBe(true)
    expect(ev(beh('text.cascade', { dir: 'out', style: 'fade' }), 2.5).cells.every((c) => c.opacity === 0)).toBe(true)
  })
  it('stagger + order: with rtl the LAST letter leads', () => {
    const f = ev(beh('text.cascade', { style: 'fade', stagger: 0.2, order: 'rtl' }), 1.1)   // pieceDur 0.4
    expect(f.cells[3]!.opacity).toBeCloseTo(0.25, 6)
    expect(f.cells[0]!.opacity).toBe(0)
  })
  it('by words: a word grows about ITS centre, letters keep their spacing ratio', () => {
    const f = ev(beh('text.cascade', { style: 'grow', amount: 0, by: 'words' }), 1.5)     // scale 0.5
    expect(f.cells[0]!.scale).toBeCloseTo(0.5, 6)
    expect(f.cells[0]!.x).toBeCloseTo(-12.5, 6)        // word centre −10; −15 → −10 + (−5 × 0.5)
    expect(f.cells[1]!.x).toBeCloseTo(-7.5, 6)
  })
  it('spin rotates; on path text "rise" moves along the glyph\'s own normal', () => {
    expect(ev(beh('text.cascade', { style: 'spin', amount: 90 }), 1.5).cells[0]!.rotation).toBeCloseTo(-Math.PI / 4, 6)
    const tilted = [cell('A', 0, 0, 0, Math.PI / 2)]
    const f = ev(beh('text.cascade', { style: 'rise', amount: 1 }), 1.5, tilted)
    expect(f.cells[0]!.x).toBeCloseTo(-10, 6)          // local +y (10px) rotated by 90° → −x
    expect(f.cells[0]!.y).toBeCloseTo(0, 6)
    expect(f.cells[0]!.rotation).toBeCloseTo(Math.PI / 2, 6)
  })
  it('a spring ease overshoots past its place on the way in', () => {
    const b = beh('text.cascade', { style: 'rise', amount: 1, ease: { type: 'spring', bounce: 0.6 } })
    const ys = [1.3, 1.4, 1.5, 1.6, 1.8].map((t) => ev(b, t).cells[0]!.y)
    expect(Math.min(...ys)).toBeLessThan(0)            // went ABOVE rest (y < 0) before settling
  })
})

describe('text.typewriter', () => {
  it('hard cuts in reading order; the cursor sits after the last visible letter', () => {
    const b = beh('text.typewriter', { stagger: 0.25, cursor: 'bar', blink: 0 })
    const f = ev(b, 1.3)                               // letters 0 and 1 started (delays 0, .25)
    expect(f.cells.map((c) => c.opacity)).toEqual([1, 1, 0, 0])
    expect(f.cursor).toMatchObject({ x: 0, y: 0, h: 20, style: 'bar' })   // right edge of 'B' (−5 + 5)
  })
  it('delete removes from the end; no cursor when cursor is none', () => {
    const f = ev(beh('text.typewriter', { dir: 'delete', stagger: 0.25, cursor: 'none' }), 1.3)
    expect(f.cells.map((c) => c.opacity)).toEqual([1, 1, 0, 0])
    expect(f.cursor).toBeUndefined()
  })
  it('blink hides the cursor for half of each blink period', () => {
    const b = beh('text.typewriter', { stagger: 0.25, cursor: 'bar', blink: 1 })
    expect(ev(b, 1.1).cursor).toBeDefined()
    expect(ev(b, 1.6).cursor).toBeUndefined()
  })
})

describe('text.maskSlide', () => {
  it('reveal from up: the letter starts one height BELOW and is clipped to its own resting box', () => {
    const f = ev(beh('text.maskSlide', { from: 'up' }), 1.25)
    expect(f.cells[0]!.y).toBeCloseTo(15, 6)           // (1 − 0.25) × 20
    expect(f.cells[0]!.opacity).toBe(1)
    expect(f.cells[0]!.clip).toEqual({ x: -15, y: 0, w: 10, h: 20, angle: 0 })
  })
  it('from left travels along x by the piece width; hide is the mirror', () => {
    expect(ev(beh('text.maskSlide', { from: 'left' }), 1.5).cells[0]!.x).toBeCloseTo(-15 + 5, 6)
    const hide = ev(beh('text.maskSlide', { dir: 'hide', from: 'up' }), 1.75)
    expect(hide.cells[0]!.y).toBeCloseTo(15, 6)
  })
})

describe('text.scramble', () => {
  const S = (params: Record<string, unknown> = {}) => beh('text.scramble', { areaW: 0.5, areaH: 0.5, interval: 0.2, ...params }, 1, 2)
  it('settle: hidden before, jumping inside the area during, EXACTLY at rest after', () => {
    expect(ev(S(), 0.5).cells.every((c) => c.opacity === 0)).toBe(true)
    const mid = ev(S(), 1.5)
    for (const c of mid.cells) { expect(Math.abs(c.x)).toBeLessThanOrEqual(250); expect(Math.abs(c.y)).toBeLessThanOrEqual(125); expect(c.opacity).toBe(1) }
    expect(mid.cells.some((c, i) => Math.abs(c.x - CELLS[i]!.x) > 1)).toBe(true)
    expect(ev(S(), 3.5).atRest).toBe(true)
  })
  it('snap holds a spot for a whole interval, then cuts to the next', () => {
    const a = ev(S(), 1.01).cells[0]!, b = ev(S(), 1.19).cells[0]!, c = ev(S(), 1.21).cells[0]!
    expect([a.x, a.y]).toEqual([b.x, b.y])
    expect([c.x, c.y]).not.toEqual([a.x, a.y])
  })
  it('glide moves continuously and lands exactly on the rest position', () => {
    const g = S({ move: 'glide' })
    const a = ev(g, 1.05).cells[0]!, b = ev(g, 1.10).cells[0]!
    expect([a.x, a.y]).not.toEqual([b.x, b.y])
    const end = ev(g, 2.9999).cells[0]!              // last hop targets rest; 0.05% of a ≤250px hop left
    expect(end.x).toBeCloseTo(CELLS[0]!.x, 0); expect(end.y).toBeCloseTo(0, 0)
  })
  it('same seed same picture; another seed another picture', () => {
    expect(ev(S({ seed: 3 }), 1.5)).toEqual(ev(S({ seed: 3 }), 1.5))
    expect(ev(S({ seed: 4 }), 1.5)).not.toEqual(ev(S({ seed: 3 }), 1.5))
  })
  it('scatter: at rest before, gone after; loop: at rest outside the bar', () => {
    expect(ev(S({ mode: 'scatter' }), 0.5).atRest).toBe(true)
    expect(ev(S({ mode: 'scatter' }), 3.5).cells.every((c) => c.opacity === 0)).toBe(true)
    expect(ev(S({ mode: 'loop' }), 0.5).atRest).toBe(true)
    expect(ev(S({ mode: 'loop' }), 3.5).atRest).toBe(true)
    expect(ev(S({ mode: 'loop' }), 2).atRest).toBe(false)
  })
  it('by words: the letters of a word travel together', () => {
    const f = ev(S({ by: 'words' }), 1.5)
    expect(f.cells[1]!.x - f.cells[0]!.x).toBeCloseTo(10, 6)
    expect(f.cells[1]!.y).toBeCloseTo(f.cells[0]!.y, 6)
  })
  it('spin gives each jump a rotation within ±spin', () => {
    const f = ev(S({ spin: 90 }), 1.5)
    expect(f.cells.some((c) => Math.abs(c.rotation) > 0.01)).toBe(true)
    for (const c of f.cells) expect(Math.abs(c.rotation)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9)
  })
})

describe('composition', () => {
  it('two behaviours combine: offsets add, opacities multiply', () => {
    const a = beh('text.cascade', { style: 'rise', amount: 1 }), b = beh('text.cascade', { style: 'fade' })
    const f = ev([a, { ...b, id: 'b2' }], 1.5)
    expect(f.cells[0]!.y).toBeCloseTo(10, 6)
    expect(f.cells[0]!.opacity).toBeCloseTo(0.25, 6)
  })
})
```

- [ ] **Step 2: Run, expect failure** — `npm run test:unit -- motionx/text-evaluate`.

- [ ] **Step 3: Implement.** `index.ts` re-exports everything from `units`, `rng`, `order`, `evaluate` and imports `./behaviours` for its side-effect registration. Design (write it this way; the tests above are the judge):

`evaluate.ts`
```ts
import { applyEase, type Ease, type StoredBehaviour } from '~/lib/motionx'
import { isSpringEase } from '~/lib/motionx/ease'
import { groupCells, type Piece, type PieceBy, type TextCell } from './units'
import { pieceRanks, pieceTiming, type Order } from './order'

export interface CellDraw { x: number; y: number; rotation: number; scale: number; opacity: number; clip?: { x: number; y: number; w: number; h: number; angle: number } }
export interface CursorDraw { x: number; y: number; h: number; angle: number; style: 'bar' | 'underscore' }
export interface TextFrame { atRest: boolean; cells: CellDraw[]; cursor?: CursorDraw }
export interface FrameBox { w: number; h: number }

/** What one behaviour does to one piece. dx/dy px; `frame` says whether they are in the PIECE's
 *  own rotated frame (rise/drop/mask travel) or already in the LAYER frame (scramble). */
export interface PieceState { dx: number; dy: number; frame: 'piece' | 'layer'; rotation: number; scale: number; opacity: number; clip?: boolean }
export const REST: PieceState = Object.freeze({ dx: 0, dy: 0, frame: 'piece', rotation: 0, scale: 1, opacity: 1 }) as PieceState
export const HIDDEN: PieceState = Object.freeze({ ...REST, opacity: 0 }) as PieceState

export interface PieceCtx { piece: Piece; pieces: Piece[]; p: number; e: number; elapsed: number; pieceDur: number; t: number; seed: number; frame: FrameBox; params: Record<string, unknown> }
export interface TextBehaviourDef {
  phase: (params: Record<string, unknown>) => 'in' | 'out' | 'span'
  piece: (c: PieceCtx) => PieceState
  cursor?: (c: { pieces: Piece[]; visible: boolean[]; t: number; params: Record<string, unknown> }) => CursorDraw | undefined
}
const REGISTRY = new Map<string, TextBehaviourDef>()
export function registerTextBehaviour(kind: string, def: TextBehaviourDef): void { REGISTRY.set(kind, def) }
export const isTextBehaviour = (b: { kind: string }) => typeof b?.kind === 'string' && b.kind.startsWith('text.')
```
`evaluateTextBehaviours`: filter to registered `text.*` behaviours; if none or no cells → `{ atRest: true, cells: [] }`. For each behaviour: `pieces = groupCells(cells, by)`, ranks, timing, per piece compute `p` (raw), clamp by phase (`in`: p≤0 → HIDDEN, p≥1 and not spring → REST; `out`: p≤0 → REST, p≥1 → HIDDEN; `span`: outside [start, start+D] → REST), `e = applyEase(spring-on-entrance ? max(0,p) : clamp01(p), ease)`, call `def.piece(...)`. Accumulate per CELL a composed state: start from rest `{x: cell.x, y: cell.y, rotation: cell.angle, scale: 1, opacity: 1}`; for each behaviour's piece state: rotate the cell's offset from the piece centre by `state.rotation` (radians) and scale it by `state.scale`; add the behaviour offset (rotated by `piece.angle` when `frame === 'piece'`); `rotation += state.rotation`; `scale *= state.scale`; `opacity *= state.opacity`; when `state.clip` set `clip = { x: piece.cx, y: piece.cy, w: piece.w, h: piece.h, angle: piece.angle }`. `atRest` = every behaviour returned REST for every piece (track with a flag, not by float comparison) AND no cursor. Cursor: the last behaviour that defines one and returns it.

`behaviours.ts` — registers the four kinds. Exact maths the tests pin:
- cascade: `k = dir==='out' ? e : 1 − e` (k = how far from rest, 1→0 on the way in). `fade`: opacity `1 − k`. `rise`: `dy = +k × amount × piece.h` (starts below), opacity `1 − k`. `drop`: `dy = −k × amount × piece.h`. `grow`: `scale = amount + (1 − amount) × (1 − k)`, opacity `min(1, (1 − k) × 2)`. `spin`: `rotation = −k × amount° in radians`, opacity `1 − k`. With a spring, `1 − e` goes negative past the target — that is the overshoot; clamp only opacity to 0..1 and scale to ≥ 0.001.
- typewriter: piece visible iff `p > 0` (type) / `p <= 0` (delete) — hard cut, ignores ease; **delete runs the chosen order BACKWARDS** (`rank → maxRank − rank`, so with the default order the LAST letter goes first — the evaluator must apply this before `pieceTiming`; expose it as an optional `reverseOrder?: (params) => boolean` on `TextBehaviourDef`); `phase` in/out accordingly but NEVER returns partial opacity. Cursor: after the last VISIBLE piece in reading order (its right edge: `cx + w/2` along its angle; before anything is visible: the first piece's left edge), hidden when nothing has started typing yet and `dir==='type'`… keep it visible from the bar's start; blink: `blink > 0 && floor((t − start) × blink × 2) % 2 === 1` ⇒ hidden. No cursor outside the bar.
- maskSlide: travel `k` as cascade; `from: 'up'` → `dy = +k × piece.h`; `'down'` → `dy = −k × piece.h`; `'left'` → `dx = +k × piece.w`… NOTE the test pins `from: 'left'` at e=0.5 to x = rest + 5 (= +0.5 × w): the piece comes from the RIGHT side of its box travelling left? No — read the test: `-15 + 5`. Implement `'left'` → `dx = +k × piece.w`, `'right'` → `dx = −k × piece.w` and name the option labels in the UI (Task 5) after the direction of TRAVEL: `up` "Slides up", `down` "Slides down", `left` "Slides left", `right` "Slides right". `clip: true`, opacity 1 (the clip does the hiding), `frame: 'piece'`.
- scramble: `phase`: settle → in, scatter → out, loop → span. Jump index `j = floor(elapsed / interval)` where `elapsed` = seconds since the BAR start for settle/loop, since the piece's own start for scatter. Spot for jump `j`: `sx = (hash01(seed, piece.index, j, 1) − 0.5) × areaW × frame.w`, `sy = (hash01(seed, piece.index, j, 2) − 0.5) × areaH × frame.h`, rotation `(hash01(seed, piece.index, j, 3) − 0.5) × 2 × spin°`; the offset is `spot − pieceCentre` so spots are centred on the layer origin. SETTLE: piece `i` lands at `landAt = delays[i] + pieceDur` (bar-relative); for `elapsed ≥ landAt` → REST; the last hop — index `ceil(landAt / interval) − 1` — targets REST instead of a hashed spot (so glide lands exactly, and a `landAt` that falls on an interval boundary still gets a final hop). SCATTER: REST until the piece's start, then jumps; HIDDEN after the bar. `snap`: hold spot `j`. `glide`: interpolate spot `j−1`→`j` (spot −1 = the rest position for scatter/loop; for settle it is one more hashed spot, `j = −1`, so the very first hop already moves) by `applyEase(frac, ease)` with `frac = (elapsed mod interval) / interval`. `frame: 'layer'`. Because settle needs `delays`/`pieceDur` and bar-relative time, pass them in `PieceCtx` (add fields `delay`, `barElapsed`, `barDur` as needed — extend the interface, keep it documented).

- [ ] **Step 4: Run** — `npm run test:unit -- motionx` → all pass (existing motionx suite must stay green). Typecheck the new files: no output.
- [ ] **Step 5: Commit** — `feat(motionx): letter behaviour evaluator + Cascade, Typewriter, Mask slide, Scramble`.

---

### Task 3: Draw letters inside the normal text pipeline

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (SHARED, ~6000 lines — smallest possible diff)
- Modify: `frontend/app/lib/compositor/silhouetteCache.ts` (one string added to `SILHOUETTE_KEY_STRIP`)
- Modify: `frontend/app/lib/motionx/adapter/frame.ts` (new exported fold helper)
- Test: `frontend/tests/unit/motionx/text-draw.unit.spec.ts`, plus one case in `frontend/tests/unit/motionx/adapter-frame.unit.spec.ts`

**Interfaces:**
- Consumes (Task 2): `evaluateTextBehaviours`, `isTextBehaviour`, `TextCell`, `TextFrame`, `CellDraw`.
- Produces: `export interface TextMotion { behaviours: StoredBehaviour[]; t: number }` and `export function applyTextBehaviours(layers: LocalLayer[], behaviours: StoredBehaviour[] | undefined, t: number | undefined): LocalLayer[]` in `adapter/frame.ts` — returns the SAME array when `t == null`, there are no `text.*` behaviours, or none targets a text layer in `layers`; otherwise clones only the targeted text layers with a transient `textMotion: TextMotion` (their own `text.*` behaviours only). Never persisted (clones only, same contract as `motionScale`).

**What to build**
1. **Fold.** In `paintLayerStack`, wrap the existing fold so text motion is attached last: `applyTextBehaviours(applyMotionxTracks(…existing…), motion?.behaviours, t)`. (`motion` there is the frame motion doc; `behaviours` is `StoredBehaviour[]`.) Nothing else in that block changes.
2. **Cache.** Add `'textMotion'` to `SILHOUETTE_KEY_STRIP` and, where `silhouetteCacheable` is decided (search that name), make a layer with `textMotion` non-cacheable — its raster changes every frame.
3. **Path text** (`drawTextOnPath`): after `placeGlyphs`, if the layer has `textMotion`: build `TextCell[]` from the placed glyphs (`x, y, angle` as given; `w = advance`; `h = layer.fontSize * W`; `word` increments at each whitespace gap in the ORIGINAL run — `placeGlyphs` skips spaces, so derive word indices by walking `displayRun(layer)`; `line = 0`), call `evaluateTextBehaviours(tm.behaviours, tm.t, cells, { w: W, h: H })`; if `frame.atRest` fall through to the existing loop unchanged; otherwise replace the loop body's placement: per glyph `ctx.save(); [clip]; ctx.globalAlpha *= d.opacity; ctx.translate(d.x, d.y); ctx.rotate(d.rotation); ctx.scale(d.scale, d.scale); strokeTextPasses(…, 0, 0); ctx.fillText(g.ch, 0, 0); ctx.restore()`, skipping glyphs with `opacity <= 0`. The fill/stroke styles are still set ONCE before the loop exactly as today (a gradient stays defined over the whole text box). Skip `paintTextStrokeBands` (distance stroke bands) while letters are moving — documented limitation.
4. **Straight / wrapped text** (`drawText`): the function already computes `drawn[]` runs (text, x, y per run, incl. justify word runs) and emits each with `emitRun`. When the layer has `textMotion`: build cells from those runs by PREFIX measurement inside each run (`measureText(run.slice(0, k+1)).width − measureText(run.slice(0, k)).width` = advance; centre = run start + prefix + advance/2, honouring the run's `textAlign`), skipping whitespace, with `word` incrementing on whitespace and at run boundaries that are word boundaries, `line` = the run's line index, `angle = 0`, `h = fontPx`. Evaluate; if `atRest` → existing path untouched. Otherwise, instead of `emitRun` per run, draw per cell with `textAlign = 'center'` exactly like step 3. Underline / strikethrough: draw a line's decoration only when every cell on that line is at rest-equivalent (opacity 1 and not moved more than 0.5px); otherwise skip it for that frame.
5. **Clip** (`d.clip`): `ctx.save(); ctx.translate(clip.x, clip.y); ctx.rotate(clip.angle); ctx.beginPath(); ctx.rect(-clip.w/2, -clip.h/2, clip.w, clip.h); ctx.clip(); ctx.rotate(-clip.angle); ctx.translate(-clip.x, -clip.y)` before the glyph transform — pad the rect by 15% of `clip.h` vertically so descenders/ascenders are not shaved at rest.
6. **Cursor** (`frame.cursor`): `bar` = a `fillRect` 0.06 × h wide, h tall, centred vertically on `cursor.y` at `cursor.x`, rotated by `cursor.angle`; `underscore` = 0.5 × h wide, 0.06 × h tall at the baseline (`y + 0.35 × h`). Uses the current `fillStyle`.
7. **Out of scope, must keep today's behaviour:** the outline branch in `drawLayerContent` (`renderAsOutline` / geometry effects) and `drawExpressiveText` ignore `textMotion` entirely.

**Tests** (`text-draw.unit.spec.ts`) — use the recording-Proxy ctx pattern from `frontend/tests/unit/motion-text-stroke-stack.unit.spec.ts` (`record()`), and the fake measure ctx from `frontend/tests/unit/compositor-text-outline.unit.spec.ts` (`fakeMeasureCtx()`); find how those specs reach `drawText` / the text draw (exported helper or via `drawLocalLayer`) and do the same. Required cases:
- **Identity:** a text layer WITHOUT `textMotion` produces exactly the same recorded call sequence as before your change (record on HEAD's behaviour by asserting the known sequence: one `fillText` per run with the full run text).
- **At rest:** with `textMotion` whose behaviours are all outside their bars (`atRest`), the recorded sequence equals the no-`textMotion` sequence.
- **Active:** with a `text.cascade` fade at mid-progress on `"AB CD"`, there is one `fillText` per non-space glyph (`A`,`B`,`C`,`D`), each preceded by a `translate` to its prefix-measured centre, and `globalAlpha` was set to the layer alpha × 0.5.
- **Hidden glyphs are not drawn:** before the bar, zero `fillText` calls.
- **Path text:** same three checks through `drawTextOnPath` with a circle path (reuse `frontend/tests/unit/compositor-text-path.unit.spec.ts`'s `stubCtx`).
- **Fold** (`adapter-frame.unit.spec.ts`): `applyTextBehaviours` returns the same array reference with no `text.*` behaviours / `t == null`; clones only the targeted text layer; a non-text layer targeted by a `text.*` behaviour is left alone; the clone's `textMotion.behaviours` contains only that layer's `text.*` behaviours.

- [ ] Steps: write the failing tests → run (fail) → implement 1–7 → `npm run test:unit -- motionx compositor-text motion-text` all pass → typecheck (only the 3 baseline `useCompositorLayers.ts` errors) → before committing `useCompositorLayers.ts` confirm `git show HEAD:<path> | diff - <path>` shows ONLY your lines → commit `feat(compositor): text layers draw letter behaviours glyph by glyph inside the normal layer pipeline`.
- If threading the per-cell branch through `drawText` turns out to need restructuring beyond a guarded branch, STOP and report BLOCKED with what you found.

---

### Task 4: Author letter behaviours — modal + gallery

**Files:**
- Modify: `frontend/app/lib/motionx/gallery.ts`, `frontend/app/lib/motionx/bands.ts`, `frontend/app/components/vue-canvas/compositor/MotionGallery.vue`, `frontend/app/components/vue-canvas/CompositorModal.vue` (SHARED — smallest diff)
- Test: `frontend/tests/unit/motionx/gallery.unit.spec.ts`, `frontend/tests/unit/motionx/bands.unit.spec.ts`

**What to build**
- `gallery.ts`: `MoveGroup` gains `'Letters'` (first in `GROUP_ORDER`); `PreviewKind` gains `'letters-cascade' | 'letters-typewriter' | 'letters-mask' | 'letters-scramble'`; five moves, all `needs: 'text'`: `letters-cascade-in` (kind `text.cascade`, label "Cascade in", params `{ dir: 'in', style: 'rise' }`), `letters-cascade-out` ("Cascade out", `{ dir: 'out', style: 'rise' }`), `letters-typewriter` ("Typewriter", `{ dir: 'type' }`), `letters-mask` ("Mask slide", `{ dir: 'reveal', from: 'up' }`), `letters-scramble` ("Scramble", `{ mode: 'settle' }`). `defaultDurationFor('Letters')` = `1.2`; Scramble gets `cycle: 2`. Update the catalog test's allowed kinds/groups and add: Letters moves are hidden for non-text layers and offered for text layers.
- `bands.ts`: `BEHAVIOUR_LABELS` / `behaviourLabel` cover the four kinds: "Cascade in" / "Cascade out" (by `dir`), "Typewriter" / "Typewriter delete", "Mask slide" / "Mask slide out", "Scramble" + " · settle|scatter|keep going". Tests for each.
- `MotionGallery.vue`: CSS-only previews on the word "Type" (four `<span>` letters with staggered `animation-delay`): cascade (translateY + opacity), typewriter (steps opacity + a blinking bar), mask (each letter in an `overflow:hidden` inline-block, translateY(100%)→0), scramble (each letter `translate` to 3 seeded offsets then back, `steps(1)`). Respect `prefers-reduced-motion`.
- `CompositorModal.vue` — `addBehaviour`: for `text.*` kinds skip `compileBehaviourForLayer` (tracks = `[]`, so `setBehaviourTracks` adds nothing), do not set the whole-layer `loop` default, and refuse (return) when the selected layer is not a text layer. `editBehaviour`: same — no recompilation for `text.*`. Everything else (undo, delete, selection, agent merge) already works on `behaviours`.

- [ ] Steps: failing tests → implement → `npm run test:unit -- motionx` green → typecheck (only the 6 baseline modal errors) → verify only your hunks in the modal → commit `feat(compositor): Letters group in the behaviour gallery; letter behaviours author without tracks`.

---

### Task 5: Timeline row + inspector controls

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/MotionBandTimeline.vue`, `frontend/app/components/vue-canvas/compositor/MotionInspector.vue`

**What to build**
- **Dock:** `rowsFor(l)` currently places a behaviour bar in the row of its compiled track's path; `text.*` behaviours have no track and would vanish. Add a **Letters** row per layer (label "Letters", above the property rows) holding every `text.*` behaviour bar of that layer; include them in `rowCountFor`. Reuse the existing behaviour-bar markup, drags (`startBehDrag`) and selection. Letters bars never count as clashes (no amber), and hide the in-bar "Open ▾" chip. The Scramble bar in `loop` mode shows NO ghosts/∞ (its `Band.loop` is false because there is no track — confirm).
- **Inspector** (behaviour branch): when `behaviour.kind` starts with `text.` hide "Open into keyframes" and the whole-layer Loop checkbox; keep Easing, Start, Duration, Delete. Add a **Text** section (uppercase 10px heading like the others) with: "Animate by" segmented (Letters · Words · Lines), "Stagger" number (s, step 0.01, min 0), "Order" select (Left to right · Right to left · From the centre · From the edges · Random), "Shuffle" button (sets `params.seed` to a new integer 1–9999 — this is an authoring click, so `Math.random()` is fine HERE, never in render code) shown only when Order is Random or kind is `text.scramble`. Show "Each piece runs for N.NNs" computed with `pieceTiming` so the user sees when the stagger was scaled to fit. Per-kind rows: Cascade — Direction (In · Out), Style (Fade · Rise · Drop · Grow · Spin), Amount (label changes: "Distance (letter heights)" / "Start size" / "Degrees"; hidden for Fade). Typewriter — Direction (Type · Delete), Cursor (None · Bar · Underscore), Blink (per second). Mask slide — Direction (Reveal · Hide), Travel (Slides up · Slides down · Slides left · Slides right). Scramble — Mode (Settle · Scatter · Keep going), Area width %, Area height % (0–100), Time per jump (s, step 0.01, min 0.03), Move (Snap · Glide), Spin (°, 0–180). All edits go through the existing `setBehParams` (one `behaviour-change` each). To know the piece count for the "runs for" line the inspector needs the text: add an optional prop `pieceCounts?: { letters: number; words: number; lines: number }` and have the modal pass counts computed from the selected text layer's text (letters = non-whitespace chars; words = whitespace-separated tokens; lines = explicit `\\n` lines — wrapped lines are unknown here, say "about").
- Use the existing segmented / labelled-row styles already in the inspector; sentence case; no identifiers in copy.

- [ ] Steps: implement → typecheck clean for both components → `npm run test:unit -- motionx` green → commit `feat(compositor): Letters row in the timeline + letter behaviour controls in the inspector`. (No live check — the controller does it.)

---

### Task 6: Close out

- [ ] Controller: live checks (straight text Cascade; wrapped text Mask slide by lines; text on a circle Scramble → Settle; effects + mask still apply while letters move; undo/redo; bake parity), final whole-programme review on the most capable model, ledger + memory update.
