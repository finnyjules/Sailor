# Poster Pattern Engine (sub-project 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, unit-tested engine that, given a Frame's elements + a seed, returns a `PatternPlacement` (a list of `LayerOp`s) arranging those elements as a typographic-poster composition — without touching face, weight, colour, or content.

**Architecture:** A framework-free module under `frontend/app/lib/frame/patterns/`. Each **pattern** is a pure function `(ctx) => PatternPlacement`. Patterns emit `LayerOp`s in the Frame's **normalized-centre** coordinate space (x/y ∈ 0..1 of frame w/h; sizes normalized to frame width), so a later apply step (plan 1b) maps them straight onto `LocalLayer` fields. The engine reads the Frame's existing grid via `resolveGrid` and picks shapes from the existing shape catalog. No DOM, no canvas, no network — text width comes from an injected `measure` callback. **The five patterns here place at the box/line level** (whole-title fit, corner blocks, grid-snapped columns, one element behind the title). The per-**word** patterns that consume `shared/text-layout/expressive.ts` (`layoutExpressive`) — Ragged, Edges, Spaced lines, Staircase — are the first tasks of plan **1c**, which wires that seam; this plan deliberately does not, so it stays free of any coordinate assumption about that engine it hasn't verified.

**Tech Stack:** TypeScript, Vitest. Reuses `app/lib/rng.ts` (`mulberry32`), `app/lib/frame/grid.ts` (`resolveGrid`), `app/lib/shapes/catalog.ts` (`SHAPES`, `familyOf`, `shapeById`).

## Global Constraints

- **Coordinate space:** all `LayerOp` positions are **normalized centre** — `x`,`y` ∈ 0..1 of frame width/height; `fontSize`, `w`, `h` normalized to frame **width** (matching `LocalLayer`/`TextLayer`). Internal maths may use pixels but every emitted op is normalized. Copy this rule into every pattern.
- **Purity:** no DOM/canvas/network/`Math.random`. Determinism comes only from `ctx.seed`; text width only from `ctx.measure`. Same `(elements, grid, seed)` ⇒ identical ops.
- **The contract:** an op may set position, size, rotation, line breaks, colour-**role** (`'ink'|'accent'|'field'`), blend, and (for shape/image) fill mode and z-hint. An op may **never** carry a font family, weight, or literal colour — those stay on the user's layers. `colorRole` is a role, mapped to real paint in plan 1b.
- **Reuse, don't reinvent:** the grid is read from `resolveGrid` output, never re-derived; the RNG is `mulberry32` from `app/lib/rng.ts`.
- **Test location/'convention:** `frontend/tests/unit/<name>.unit.spec.ts`. Run from `frontend/` with `npx vitest run tests/unit/<file>`.
- **UI copy / naming:** none in this plan (pure engine). Pattern `name` fields are sentence-case display strings; `did` strings are plain-language, sentence-case.

---

## File Structure

- `frontend/app/lib/frame/patterns/types.ts` — all engine types (`PosterKind`, `Role`, `PosterLayerView`, `FrameElements`, `ResolvedGrid`, `PatternContext`, `ColorRole`, `LayerOp`, `PatternPlacement`, `Pattern`). One responsibility: the contract.
- `frontend/app/lib/frame/patterns/rng.ts` — `PatternRng` (float/int/pick/chance) over `mulberry32`; `rngFor(seed, patternIndex)`.
- `frontend/app/lib/frame/patterns/space.ts` — coordinate helpers: `marginBox`, `toNorm` (px box → normalized-centre op fields), `snapX`/`snapY` (nearest grid line), `fitSize` (fit text to a target width via `measure`).
- `frontend/app/lib/frame/patterns/hierarchy.ts` — `inferElements(layers, extra)` → `FrameElements` (role assignment by font size + date regex).
- `frontend/app/lib/frame/patterns/shapePick.ts` — `pickShape(elements, rng)` from a specific id or a family.
- `frontend/app/lib/frame/patterns/patterns/runOff.ts`, `statement.ts`, `indexPattern.ts`, `shapeCounter.ts`, `photoBehind.ts` — one pattern each.
- `frontend/app/lib/frame/patterns/catalog.ts` — `PATTERNS` registry + `fittingPatterns(ctx)`.
- `frontend/app/lib/frame/patterns/index.ts` — re-exports the public surface.
- Tests: `frontend/tests/unit/frame-patterns-*.unit.spec.ts`, one per module/pattern.

**Scope:** this plan is sub-project **1a** (the pure engine) of sub-project 1 in `docs/superpowers/specs/2026-09-08-poster-composition-design.md`. Deferred to **1b**: applying a `PatternPlacement` to real `LocalLayer`s as one undo step, writing `sailor_posterState`, and the Options sheet UI. Deferred to **1c**: the remaining ~60 patterns (including ones that create layers — Stack/Wall/Scatter), the three face pickers, the Shape picker, letter swaps, and the expressive placement sliders. The five patterns here map **one-to-one** onto existing elements (no layer creation), which keeps 1b's apply trivial.

---

### Task 1: Engine types

**Files:**
- Create: `frontend/app/lib/frame/patterns/types.ts`
- Test: `frontend/tests/unit/frame-patterns-types.unit.spec.ts`

**Interfaces:**
- Consumes: `Rect` from `~/lib/frame/grid`.
- Produces: `PosterKind`, `Role`, `PosterLayerView`, `FrameElements`, `ResolvedGrid`, `ColorRole`, `LayerOp`, `PatternPlacement`, `PatternContext`, `Pattern` (all exported types); `kindOf(wordCount)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-types.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { kindOf } from '~/lib/frame/patterns/types'

describe('kindOf', () => {
  it('classifies by word count', () => {
    expect(kindOf(1)).toBe('word')
    expect(kindOf(3)).toBe('phrase')
    expect(kindOf(4)).toBe('phrase')
    expect(kindOf(5)).toBe('sentence')
    expect(kindOf(20)).toBe('sentence')
  })
  it('treats zero as a word (empty title still classifies)', () => {
    expect(kindOf(0)).toBe('word')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-types.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/types`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/types.ts
import type { Rect } from '~/lib/frame/grid'

/** What the user brought, inferred from the title's word count. */
export type PosterKind = 'word' | 'phrase' | 'sentence'

/** Inferred role of an element on the poster. */
export type Role = 'title' | 'details' | 'caption' | 'date'

/** Classify a title by its word count: 1 = word, 2–4 = phrase, 5+ = sentence. */
export function kindOf(wordCount: number): PosterKind {
  if (wordCount <= 1) return 'word'
  if (wordCount <= 4) return 'phrase'
  return 'sentence'
}

/** The read-only view of a Frame layer the engine needs. The app (plan 1b) maps
 *  a full LocalLayer down to this; tests build it directly. */
export interface PosterLayerView {
  id: string
  kind: 'text' | 'image' | 'shape'
  /** Present for text layers: the words. */
  text?: string
  /** Present for text layers: font size normalized to frame width (as LocalLayer stores it). */
  fontSize?: number
  /** Present for shape layers: the library shape id. */
  shapeId?: string
}

export interface TextEl { role: Role; id: string; text: string; words: string[] }
export interface ImageEl { id: string }
export interface ShapeEl { id: string; shapeId: string }

/** The user's elements, hierarchy-inferred. Faces/palette are NOT here — the
 *  engine places geometry only; `ctx.measure` closes over the title face, and
 *  colours are emitted as roles. `shapeMode` says which library shape to use
 *  when a pattern wants one and no shape layer was placed. */
export interface FrameElements {
  title?: TextEl
  details?: TextEl
  caption?: TextEl
  date?: TextEl
  images: ImageEl[]
  shapes: ShapeEl[]
  shapeMode: { id: string } | { family: string } | null
}

/** Exactly the shape `resolveGrid` returns. `null` when grid mode is 'off'. */
export type ResolvedGrid = { xs: number[]; ys: number[]; regions: Rect[] }

export type ColorRole = 'ink' | 'accent' | 'field'

/** One placement instruction. Positions are normalized-centre (0..1 of frame
 *  w/h); sizes normalized to frame width. Never carries a face/weight/colour. */
export interface LayerOp {
  /** Which element this moves: a role, or the literal element id for images/shapes. */
  target: Role | string
  kind: 'text' | 'image' | 'shape'
  x: number
  y: number
  w?: number
  h?: number
  fontSize?: number
  rotation?: number
  align?: 'left' | 'center' | 'right' | 'justify'
  colorRole?: ColorRole
  blend?: 'normal' | 'multiply'
  /** The text re-broken with '\n' inserted (text ops only). */
  lineBreak?: string
  /** For a shape op: which library shape to draw (from shapeMode/element). */
  shapeId?: string
  /** Shape/image fill treatment. */
  fill?: 'solid' | 'outline' | 'photo'
  /** Relative stacking hint: lower renders behind. Default 0. */
  z?: number
}

export interface PatternPlacement {
  ops: LayerOp[]
  /** Plain-language label of what the pattern did (drives the sheet tile label). */
  did: string
}

/** Injected width oracle: width in px of `text` set at fontSize 100 in the
 *  title face. The app passes a canvas-backed measurer; tests pass a stub. */
export type Measure = (text: string) => number

export interface PatternContext {
  frame: { w: number; h: number }
  grid: ResolvedGrid | null
  /** Frame margin, normalized to width (from the grid, or a default when off). */
  margin: number
  elements: FrameElements
  seed: number
  measure: Measure
}

export interface Pattern {
  id: string
  name: string
  fits: PosterKind[]
  needs?: { shape?: boolean; image?: boolean }
  place(ctx: PatternContext): PatternPlacement
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-types.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/types.ts frontend/tests/unit/frame-patterns-types.unit.spec.ts
git commit -m "feat(frame): poster pattern-engine types + kindOf"
```

---

### Task 2: Seeded RNG

**Files:**
- Create: `frontend/app/lib/frame/patterns/rng.ts`
- Test: `frontend/tests/unit/frame-patterns-rng.unit.spec.ts`

**Interfaces:**
- Consumes: `mulberry32` from `~/lib/rng`.
- Produces: `PatternRng` interface `{ f(): number; range(a,b): number; int(a,b): number; pick<T>(arr: T[]): T; chance(p): boolean }`; `rngFor(seed: number, patternIndex: number): PatternRng`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-rng.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { rngFor } from '~/lib/frame/patterns/rng'

describe('rngFor', () => {
  it('is deterministic for the same (seed, index)', () => {
    const a = rngFor(7, 3), b = rngFor(7, 3)
    expect([a.f(), a.f(), a.f()]).toEqual([b.f(), b.f(), b.f()])
  })
  it('differs across index and across seed', () => {
    expect(rngFor(7, 3).f()).not.toEqual(rngFor(7, 4).f())
    expect(rngFor(7, 3).f()).not.toEqual(rngFor(8, 3).f())
  })
  it('range/int/pick/chance stay in bounds', () => {
    const r = rngFor(1, 0)
    for (let i = 0; i < 200; i++) {
      const v = r.range(2, 5); expect(v).toBeGreaterThanOrEqual(2); expect(v).toBeLessThanOrEqual(5)
      const n = r.int(1, 3); expect(Number.isInteger(n)).toBe(true); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(3)
      expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']))
      expect(typeof r.chance(0.5)).toBe('boolean')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-rng.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/rng`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/rng.ts
import { mulberry32 } from '~/lib/rng'

export interface PatternRng {
  f(): number
  range(a: number, b: number): number
  int(a: number, b: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
}

/** One RNG per (tile seed, pattern index), so each tile of the sheet varies
 *  independently yet reproducibly. */
export function rngFor(seed: number, patternIndex: number): PatternRng {
  const next = mulberry32((seed * 1000 + patternIndex * 17 + 1) | 0)
  return {
    f: next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)]!,
    chance: (p) => next() < p,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-rng.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/rng.ts frontend/tests/unit/frame-patterns-rng.unit.spec.ts
git commit -m "feat(frame): seeded RNG for poster patterns"
```

---

### Task 3: Coordinate + fit helpers

**Files:**
- Create: `frontend/app/lib/frame/patterns/space.ts`
- Test: `frontend/tests/unit/frame-patterns-space.unit.spec.ts`

**Interfaces:**
- Consumes: `ResolvedGrid`, `Measure` from `./types`.
- Produces:
  - `marginBox(frame, margin): { x: number; y: number; w: number; h: number }` — the content rect in **px**.
  - `toNorm(box, frame): { x: number; y: number }` — px top-left+size box → normalized-**centre** x/y.
  - `normLen(px, frameW): number` — px length → normalized-to-width.
  - `fitSize(text, targetPx, measure): number` — font size in **px** so `text` is `targetPx` wide (linear scale from measure@100).
  - `snapX(px, grid): number` / `snapY(px, grid): number` — nearest grid edge (identity when grid null/empty).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-space.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { marginBox, toNorm, normLen, fitSize, snapX, snapY } from '~/lib/frame/patterns/space'
import type { ResolvedGrid } from '~/lib/frame/patterns/types'

const frame = { w: 800, h: 1000 }

describe('space helpers', () => {
  it('marginBox insets by margin*width on all sides', () => {
    expect(marginBox(frame, 0.05)).toEqual({ x: 40, y: 40, w: 720, h: 920 })
  })
  it('toNorm converts a px box to a normalized centre', () => {
    expect(toNorm({ x: 0, y: 0, w: 400, h: 500 }, frame)).toEqual({ x: 0.25, y: 0.25 })
    expect(toNorm({ x: 400, y: 500, w: 400, h: 500 }, frame)).toEqual({ x: 0.75, y: 0.75 })
  })
  it('normLen divides by frame width', () => {
    expect(normLen(80, 800)).toBeCloseTo(0.1, 6)
  })
  it('fitSize scales linearly from measure@100', () => {
    const measure = (t: string) => t.length * 60 // 0.6em per char at size 100
    // "AB" is 2*60 = 120px at size 100 → to be 360px wide needs size 300
    expect(fitSize('AB', 360, measure)).toBeCloseTo(300, 6)
  })
  it('snapX/snapY snap to the nearest grid edge, identity when off', () => {
    const grid: ResolvedGrid = { xs: [40, 240, 440, 640, 760], ys: [40, 500, 960], regions: [] }
    expect(snapX(250, grid)).toBe(240)
    expect(snapX(700, grid)).toBe(640)
    expect(snapY(470, grid)).toBe(500)
    expect(snapX(250, null)).toBe(250)
    expect(snapX(250, { xs: [], ys: [], regions: [] })).toBe(250)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-space.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/space`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/space.ts
import type { ResolvedGrid, Measure } from './types'

export interface PxBox { x: number; y: number; w: number; h: number }

/** The content rectangle in px: margin is normalized to width, inset uniformly. */
export function marginBox(frame: { w: number; h: number }, margin: number): PxBox {
  const m = margin * frame.w
  return { x: m, y: m, w: frame.w - 2 * m, h: frame.h - 2 * m }
}

/** A px box (top-left + size) → normalized CENTRE coordinates (LocalLayer space). */
export function toNorm(box: PxBox, frame: { w: number; h: number }): { x: number; y: number } {
  return { x: (box.x + box.w / 2) / frame.w, y: (box.y + box.h / 2) / frame.h }
}

/** A px length → normalized to frame WIDTH (as fontSize/boxW are stored). */
export function normLen(px: number, frameW: number): number {
  return px / frameW
}

/** Font size in px so `text` renders `targetPx` wide, by linear scale from measure@100. */
export function fitSize(text: string, targetPx: number, measure: Measure): number {
  const at100 = measure(text)
  if (at100 <= 0) return 0
  return (100 * targetPx) / at100
}

function nearest(px: number, edges: number[]): number {
  if (!edges.length) return px
  let best = edges[0]!, bd = Math.abs(px - best)
  for (const e of edges) { const d = Math.abs(px - e); if (d < bd) { bd = d; best = e } }
  return best
}

export function snapX(px: number, grid: ResolvedGrid | null): number {
  return grid ? nearest(px, grid.xs) : px
}
export function snapY(px: number, grid: ResolvedGrid | null): number {
  return grid ? nearest(px, grid.ys) : px
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-space.unit.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/space.ts frontend/tests/unit/frame-patterns-space.unit.spec.ts
git commit -m "feat(frame): coordinate + fit helpers for poster patterns"
```

---

### Task 4: Hierarchy inference

**Files:**
- Create: `frontend/app/lib/frame/patterns/hierarchy.ts`
- Test: `frontend/tests/unit/frame-patterns-hierarchy.unit.spec.ts`

**Interfaces:**
- Consumes: `PosterLayerView`, `FrameElements`, `TextEl` from `./types`.
- Produces: `inferElements(layers: PosterLayerView[], shapeMode?: FrameElements['shapeMode']): FrameElements` — largest text ⇒ title, smallest ⇒ caption, a date-shaped line ⇒ date, the rest ⇒ details; images/shapes collected.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-hierarchy.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import type { PosterLayerView } from '~/lib/frame/patterns/types'

describe('inferElements', () => {
  it('assigns title/details/caption by size and finds a date', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
      { id: 'd', kind: 'text', text: 'Talks on sound', fontSize: 0.03 },
      { id: 'dt', kind: 'text', text: '12–14 October 2026', fontSize: 0.03 },
      { id: 'c', kind: 'text', text: 'free entry', fontSize: 0.018 },
      { id: 'img', kind: 'image' },
      { id: 'sh', kind: 'shape', shapeId: 'circle' },
    ]
    const e = inferElements(layers)
    expect(e.title?.id).toBe('t')
    expect(e.title?.words).toEqual(['NOISE'])
    expect(e.caption?.id).toBe('c')
    expect(e.date?.id).toBe('dt')          // the "…2026" line is date-shaped
    expect(e.details?.id).toBe('d')        // remaining non-date, non-caption text
    expect(e.images.map(i => i.id)).toEqual(['img'])
    expect(e.shapes[0]).toEqual({ id: 'sh', shapeId: 'circle' })
  })
  it('a lone title yields only a title', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'SILENCE', fontSize: 0.2 }])
    expect(e.title?.id).toBe('t')
    expect(e.details).toBeUndefined()
    expect(e.caption).toBeUndefined()
    expect(e.date).toBeUndefined()
  })
  it('carries shapeMode through', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'X', fontSize: 0.2 }], { family: 'suns' })
    expect(e.shapeMode).toEqual({ family: 'suns' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-hierarchy.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/hierarchy`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/hierarchy.ts
import type { PosterLayerView, FrameElements, TextEl, ImageEl, ShapeEl } from './types'

const DATE_RE = /\b(\d{4})\b|\d{1,2}[./-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean)
const asText = (l: PosterLayerView, role: TextEl['role']): TextEl =>
  ({ role, id: l.id, text: l.text ?? '', words: words(l.text ?? '') })

/** Largest text ⇒ title, smallest ⇒ caption, a date-shaped remaining line ⇒
 *  date, the rest ⇒ details. Images/shapes collected in document order. */
export function inferElements(
  layers: PosterLayerView[],
  shapeMode: FrameElements['shapeMode'] = null,
): FrameElements {
  const texts = layers.filter(l => l.kind === 'text' && (l.text ?? '').trim().length > 0)
  const images: ImageEl[] = layers.filter(l => l.kind === 'image').map(l => ({ id: l.id }))
  const shapes: ShapeEl[] = layers
    .filter(l => l.kind === 'shape')
    .map(l => ({ id: l.id, shapeId: l.shapeId ?? 'circle' }))

  const base: FrameElements = { images, shapes, shapeMode }
  if (!texts.length) return base

  const bySize = [...texts].sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))
  const title = bySize[0]!
  base.title = asText(title, 'title')
  const rest = bySize.slice(1)
  if (!rest.length) return base

  const caption = rest[rest.length - 1]!
  base.caption = asText(caption, 'caption')
  const middle = rest.slice(0, -1)

  const dateLayer = middle.find(l => DATE_RE.test(l.text ?? ''))
  if (dateLayer) base.date = asText(dateLayer, 'date')
  const details = middle.find(l => l !== dateLayer)
  if (details) base.details = asText(details, 'details')
  else if (!base.details && !dateLayer && middle.length === 0) { /* none */ }
  return base
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-hierarchy.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/hierarchy.ts frontend/tests/unit/frame-patterns-hierarchy.unit.spec.ts
git commit -m "feat(frame): infer poster element hierarchy from layers"
```

---

### Task 5: Shape picker

**Files:**
- Create: `frontend/app/lib/frame/patterns/shapePick.ts`
- Test: `frontend/tests/unit/frame-patterns-shapepick.unit.spec.ts`

**Interfaces:**
- Consumes: `FrameElements` from `./types`; `PatternRng` from `./rng`; `SHAPES`, `shapeById`, `familyOf` from `~/lib/shapes/catalog`.
- Produces: `pickShape(elements: FrameElements, rng: PatternRng): { id: string; aspect: number } | null` — returns the placed shape element if any, else `shapeMode`'s specific id, else a seeded pick from `shapeMode`'s family; `aspect` = box h/w.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-shapepick.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { pickShape } from '~/lib/frame/patterns/shapePick'
import { rngFor } from '~/lib/frame/patterns/rng'
import { familyOf, shapeById } from '~/lib/shapes/catalog'
import type { FrameElements } from '~/lib/frame/patterns/types'

const base: FrameElements = { images: [], shapes: [], shapeMode: null }

describe('pickShape', () => {
  it('returns null when nothing is chosen', () => {
    expect(pickShape(base, rngFor(1, 0))).toBeNull()
  })
  it('prefers a placed shape element', () => {
    const s = pickShape({ ...base, shapes: [{ id: 'x', shapeId: 'circle' }] }, rngFor(1, 0))
    expect(s?.id).toBe('circle')
    const box = shapeById('circle')!.box
    expect(s?.aspect).toBeCloseTo(box[3] / box[2], 6)
  })
  it('uses a specific shapeMode id', () => {
    expect(pickShape({ ...base, shapeMode: { id: 'sun-rays' } }, rngFor(1, 0))?.id).toBe('sun-rays')
  })
  it('picks within a family, deterministically, and it belongs to that family', () => {
    const a = pickShape({ ...base, shapeMode: { family: 'suns' } }, rngFor(5, 2))
    const b = pickShape({ ...base, shapeMode: { family: 'suns' } }, rngFor(5, 2))
    expect(a?.id).toBe(b?.id)
    expect(familyOf(a!.id)).toBe('suns')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-shapepick.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/shapePick`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/shapePick.ts
import type { FrameElements } from './types'
import type { PatternRng } from './rng'
import { SHAPES, shapeById, familyOf } from '~/lib/shapes/catalog'

const withAspect = (id: string) => {
  const sh = shapeById(id)
  if (!sh) return null
  return { id, aspect: sh.box[3] / sh.box[2] }
}

/** A placed shape wins; else a specific shapeMode id; else a seeded pick from a
 *  family. Returns the shape id + its ink-box aspect (h/w), or null. */
export function pickShape(elements: FrameElements, rng: PatternRng): { id: string; aspect: number } | null {
  if (elements.shapes.length) return withAspect(elements.shapes[0]!.shapeId)
  const mode = elements.shapeMode
  if (!mode) return null
  if ('id' in mode) return withAspect(mode.id)
  const pool = SHAPES.filter(s => familyOf(s.id) === mode.family)
  if (!pool.length) return null
  return withAspect(rng.pick(pool).id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-shapepick.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/shapePick.ts frontend/tests/unit/frame-patterns-shapepick.unit.spec.ts
git commit -m "feat(frame): shape picker (element | id | seeded family)"
```

---

### Task 6: Shared test fixtures

**Files:**
- Create: `frontend/tests/unit/_poster-fixtures.ts`
- Test: exercised by later tasks (no standalone test; a fixture module).

**Interfaces:**
- Produces: `stubMeasure` (`(t) => t.length * 60`, i.e. 0.6em/char at size 100); `ctxFor(overrides)` building a valid `PatternContext` with an 800×1000 frame, margin 0.05, grid null, a NOISE title + details + date + caption + one image + one shape, seed 7.

Rationale (Task Right-Sizing): this fixture is shared setup for Tasks 7–11; folding it into one task keeps those focused on behaviour. It ships with its first consumer.

- [ ] **Step 1: Write the fixture (no failing test — it is test scaffolding)**

```ts
// frontend/tests/unit/_poster-fixtures.ts
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import type { PatternContext, PosterLayerView, FrameElements } from '~/lib/frame/patterns/types'

/** 0.6em per character at font size 100 — a deterministic monospace-ish oracle. */
export const stubMeasure = (t: string) => t.length * 60

export const NOISE_LAYERS: PosterLayerView[] = [
  { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'Talks on sound and the city', fontSize: 0.03 },
  { id: 'dt', kind: 'text', text: '12–14 October 2026', fontSize: 0.03 },
  { id: 'c', kind: 'text', text: 'free entry', fontSize: 0.018 },
  { id: 'img', kind: 'image' },
  { id: 'sh', kind: 'shape', shapeId: 'circle' },
]

export function ctxFor(overrides: Partial<PatternContext> = {}): PatternContext {
  const elements: FrameElements = overrides.elements ?? inferElements(NOISE_LAYERS)
  return {
    frame: { w: 800, h: 1000 },
    grid: null,
    margin: 0.05,
    elements,
    seed: 7,
    measure: stubMeasure,
    ...overrides,
  }
}

/** Assert every op is finite and roughly on the page (off-edge crop allowed). */
export function assertSaneOps(ops: { x: number; y: number; fontSize?: number; w?: number }[]) {
  for (const op of ops) {
    expect(Number.isFinite(op.x)).toBe(true)
    expect(Number.isFinite(op.y)).toBe(true)
    expect(op.x).toBeGreaterThan(-1); expect(op.x).toBeLessThan(2)
    expect(op.y).toBeGreaterThan(-1); expect(op.y).toBeLessThan(2)
    if (op.fontSize != null) { expect(op.fontSize).toBeGreaterThan(0); expect(Number.isFinite(op.fontSize)).toBe(true) }
    if (op.w != null) { expect(op.w).toBeGreaterThan(0); expect(Number.isFinite(op.w)).toBe(true) }
  }
}
```

Note: `expect` is available in-scope because this module is only imported by `*.unit.spec.ts` files running under Vitest globals. If the repo's Vitest config does not enable globals, add `import { expect } from 'vitest'` at the top (check `frontend/vitest.config.*` — the existing `tests/unit/*.unit.spec.ts` files show whether `expect` is imported or global; match them).

- [ ] **Step 2: Verify it type-checks by importing it in the next task.** (No standalone run.)

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/unit/_poster-fixtures.ts
git commit -m "test(frame): shared fixtures for poster pattern tests"
```

---

### Task 7: Pattern — Run-off (free placement, off-edge crop)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/runOff.ts`
- Test: `frontend/tests/unit/frame-patterns-runoff.unit.spec.ts`

**Interfaces:**
- Consumes: `Pattern`, `PatternContext`, `LayerOp` from `../types`; `rngFor` from `../rng`; `marginBox`, `toNorm`, `normLen`, `fitSize` from `../space`.
- Produces: `runOff: Pattern` (id `'runoff'`, fits all kinds). Places the title oversize and cropped by the left or right edge; details and caption to opposite corners.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-runoff.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { runOff } from '~/lib/frame/patterns/patterns/runOff'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('runOff', () => {
  it('is deterministic', () => {
    expect(runOff.place(ctxFor())).toEqual(runOff.place(ctxFor()))
  })
  it('emits a title op that is oversize (wider than the frame) and cropped off an edge', () => {
    const { ops, did } = runOff.place(ctxFor())
    const title = ops.find(o => o.target === 'title')!
    expect(title.kind).toBe('text')
    expect(title.fontSize).toBeGreaterThan(0)
    // oversize: the normalized title width exceeds 1 (runs off the frame)
    expect(title.w!).toBeGreaterThan(1)
    // cropped: its centre sits outside [0,1] on x, so part is off-page
    expect(title.x < 0 || title.x > 1).toBe(true)
    expect(did).toMatch(/cropped by the (left|right) edge/)
  })
  it('places details and caption and keeps every op finite/on-page-ish', () => {
    const { ops } = runOff.place(ctxFor())
    expect(ops.find(o => o.target === 'details')).toBeTruthy()
    expect(ops.find(o => o.target === 'caption')).toBeTruthy()
    assertSaneOps(ops.filter(o => o.target !== 'title')) // title is intentionally off-page
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-runoff.unit.spec.ts`
Expected: FAIL — cannot resolve `runOff`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/patterns/runOff.ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, normLen, fitSize } from '../space'

export const runOff: Pattern = {
  id: 'runoff',
  name: 'Run-off',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 0)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const t = elements.title
    const scale = r.range(1.3, 2.0)                    // title width as a multiple of frame width
    const targetPx = frame.w * scale
    const text = t?.text ?? 'WORD'
    const sizePx = fitSize(text, targetPx, measure)
    const wpx = measure(text) * (sizePx / 100)         // actual title width in px
    const edge = r.pick(['left', 'right'] as const)
    // left: push the word left so its right end sits near the right margin.
    const xLeftPx = edge === 'left' ? -(wpx - (frame.w - mb.x)) : mb.x - (wpx - (frame.w - mb.x)) * r.range(0, 0.15)
    const slot = r.pick(['top', 'mid', 'bottom'] as const)
    const capH = sizePx * 0.72
    const yTopPx = slot === 'top' ? mb.y - capH * 0.08 : slot === 'mid' ? (frame.h - capH) / 2 : frame.h - mb.y - capH
    const centre = toNorm({ x: xLeftPx, y: yTopPx, w: wpx, h: capH }, frame)
    ops.push({
      target: 'title', kind: 'text',
      x: centre.x, y: centre.y,
      w: normLen(wpx, frame.w),
      fontSize: normLen(sizePx, frame.w),
      align: 'left', colorRole: 'ink',
    })
    // details + caption in the opposite corners from the title's slot.
    const detTop = slot !== 'top'
    if (elements.details) ops.push(cornerText('details', elements.details.text, detTop ? 'tl' : 'bl', ctx))
    if (elements.caption) ops.push(cornerText('caption', elements.caption.text, detTop ? 'tr' : 'br', ctx))
    return { ops, did: `title at ${Math.round(scale * 100)}% of the width, cropped by the ${edge} edge` }
  },
}

/** A small text op pinned to a margin corner. */
function cornerText(target: 'details' | 'caption', text: string, corner: 'tl' | 'tr' | 'bl' | 'br', ctx: import('../types').PatternContext): LayerOp {
  const { frame, margin } = ctx
  const mb = marginBox(frame, margin)
  const sizePx = frame.w * 0.024
  const wpx = mb.w * 0.42
  const right = corner.includes('r')
  const bottom = corner.includes('b')
  const xLeft = right ? mb.x + mb.w - wpx : mb.x
  const yTop = bottom ? mb.y + mb.h - sizePx : mb.y
  const centre = toNorm({ x: xLeft, y: yTop, w: wpx, h: sizePx }, frame)
  return {
    target, kind: 'text', x: centre.x, y: centre.y,
    w: wpx / frame.w, fontSize: sizePx / frame.w,
    align: right ? 'right' : 'left', colorRole: 'ink',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-runoff.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/patterns/runOff.ts frontend/tests/unit/frame-patterns-runoff.unit.spec.ts
git commit -m "feat(frame): Run-off poster pattern"
```

---

### Task 8: Pattern — Statement (fit to margins, one word per line)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/statement.ts`
- Test: `frontend/tests/unit/frame-patterns-statement.unit.spec.ts`

**Interfaces:**
- Consumes: `Pattern`, `LayerOp`, `PatternContext` from `../types`; `rngFor`; `marginBox`, `toNorm`, `fitSize`.
- Produces: `statement: Pattern` (id `'statement'`, fits all). Title fitted to the margin width, one word per line (`lineBreak` = words joined by `'\n'`), pinned top or bottom; details/caption in the free corners.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-statement.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { statement } from '~/lib/frame/patterns/patterns/statement'
import { ctxFor, assertSaneOps, stubMeasure } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('statement', () => {
  it('is deterministic and sane', () => {
    const a = statement.place(ctxFor()); const b = statement.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('breaks a multi-word title one word per line', () => {
    const elements = inferElements([
      { id: 't', kind: 'text', text: 'SOUND AND SILENCE', fontSize: 0.2 },
    ])
    const title = statement.place(ctxFor({ elements })).ops.find(o => o.target === 'title')!
    expect(title.lineBreak).toBe('SOUND\nAND\nSILENCE')
    expect(title.align).toMatch(/left|center|right/)
  })
  it('fits the widest word inside the margin box (never wider than the frame)', () => {
    const title = statement.place(ctxFor()).ops.find(o => o.target === 'title')!
    // fontSize normalized to width; the single word NOISE must fit within margins
    const marginW = (1 - 2 * 0.05)
    const widthEm = stubMeasure('NOISE') / 100        // width per unit font size
    expect(title.fontSize! * widthEm).toBeLessThanOrEqual(marginW + 1e-6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-statement.unit.spec.ts`
Expected: FAIL — cannot resolve `statement`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/patterns/statement.ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const statement: Pattern = {
  id: 'statement',
  name: 'Statement',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 1)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    // fit the widest word to the margin width
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const sizePx = fitSize(widest, mb.w, measure)
    const capH = sizePx * 0.86
    const blockH = capH * words.length
    const top = r.chance(0.5)
    const yTop = top ? mb.y : mb.y + mb.h - blockH
    const align = r.pick(['left', 'center', 'right'] as const)
    const centre = toNorm({ x: mb.x, y: yTop, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: centre.x, y: centre.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align, lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    if (elements.details) ops.push(cornerText('details', top ? 'bl' : 'tl', ctx))
    if (elements.caption) ops.push(cornerText('caption', top ? 'br' : 'tr', ctx))
    return { ops, did: `title fitted to the margins, one word per line, ${align}, ${top ? 'top' : 'bottom'}` }
  },
}

function cornerText(target: 'details' | 'caption', corner: 'tl' | 'tr' | 'bl' | 'br', ctx: import('../types').PatternContext): LayerOp {
  const { frame, margin } = ctx
  const mb = marginBox(frame, margin)
  const sizePx = frame.w * 0.024
  const wpx = mb.w * 0.42
  const right = corner.includes('r'); const bottom = corner.includes('b')
  const xLeft = right ? mb.x + mb.w - wpx : mb.x
  const yTop = bottom ? mb.y + mb.h - sizePx : mb.y
  const c = toNorm({ x: xLeft, y: yTop, w: wpx, h: sizePx }, frame)
  return { target, kind: 'text', x: c.x, y: c.y, w: wpx / frame.w, fontSize: sizePx / frame.w, align: right ? 'right' : 'left', colorRole: 'ink' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-statement.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/patterns/statement.ts frontend/tests/unit/frame-patterns-statement.unit.spec.ts
git commit -m "feat(frame): Statement poster pattern"
```

---

### Task 9: Pattern — Index (grid seam + date-as-hero)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/indexPattern.ts`
- Test: `frontend/tests/unit/frame-patterns-index.unit.spec.ts`

**Interfaces:**
- Consumes: `Pattern`, `LayerOp` from `../types`; `rngFor`; `marginBox`, `toNorm`, `fitSize`, `snapX`.
- Produces: `indexPattern: Pattern` (id `'index'`, fits all). Title top-left; the date set large at the foot in the accent role; details ruled on the right, snapped to a grid line when a grid is present.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-index.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { indexPattern } from '~/lib/frame/patterns/patterns/indexPattern'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import type { ResolvedGrid } from '~/lib/frame/patterns/types'

describe('indexPattern', () => {
  it('is deterministic and sane', () => {
    const a = indexPattern.place(ctxFor()); const b = indexPattern.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('sets the date large and in the accent role', () => {
    const { ops } = indexPattern.place(ctxFor())
    const date = ops.find(o => o.target === 'date')!
    const title = ops.find(o => o.target === 'title')!
    const caption = ops.find(o => o.target === 'caption')
    expect(date.colorRole).toBe('accent')
    expect(date.fontSize!).toBeGreaterThan(caption ? caption.fontSize! : 0)
    expect(title).toBeTruthy()
  })
  it('snaps the details column to a grid line when a grid is present', () => {
    const grid: ResolvedGrid = { xs: [40, 240, 440, 560, 760], ys: [40, 500, 960], regions: [] }
    const { ops } = indexPattern.place(ctxFor({ grid }))
    const details = ops.find(o => o.target === 'details')!
    // the details left edge (centre.x*w - w/2) must sit on one of the xs (±1px)
    const leftPx = details.x * 800 - (details.w! * 800) / 2
    const onLine = grid.xs.some(e => Math.abs(e - leftPx) < 1.5)
    expect(onLine).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-index.unit.spec.ts`
Expected: FAIL — cannot resolve `indexPattern`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/patterns/indexPattern.ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize, snapX } from '../space'

export const indexPattern: Pattern = {
  id: 'index',
  name: 'Index',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 2)
    const { frame, margin, grid, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []

    // title top-left, fitted to a fraction of the width
    const tText = elements.title?.text ?? 'WORD'
    const tSize = fitSize(tText, mb.w * r.range(0.5, 0.72), measure)
    const tWpx = measure(tText) * (tSize / 100)
    const tc = toNorm({ x: mb.x, y: mb.y - tSize * 0.06, w: tWpx, h: tSize * 0.72 }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: tWpx / frame.w, fontSize: tSize / frame.w, align: 'left', colorRole: 'ink' })

    // details ruled on the right; left edge snapped to a grid line when present
    if (elements.details) {
      const rawX = frame.w * 0.58
      const colX = snapX(rawX, grid)
      const colW = (frame.w - margin * frame.w) - colX
      const dSize = frame.w * 0.024
      const dc = toNorm({ x: colX, y: mb.y, w: colW, h: dSize }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: colW / frame.w, fontSize: dSize / frame.w, align: 'left', colorRole: 'ink' })
    }

    // the date set large at the foot, in accent
    if (elements.date) {
      const dText = elements.date.text
      const dSize = Math.min(fitSize(dText, mb.w, measure), frame.h * r.range(0.1, 0.18))
      const dWpx = measure(dText) * (dSize / 100)
      const dc = toNorm({ x: mb.x, y: frame.h - mb.y - dSize * 0.72, w: dWpx, h: dSize * 0.72 }, frame)
      ops.push({ target: 'date', kind: 'text', x: dc.x, y: dc.y, w: dWpx / frame.w, fontSize: dSize / frame.w, align: 'left', colorRole: 'accent' })
    }

    if (elements.caption) {
      const cSize = frame.w * 0.019
      const cc = toNorm({ x: mb.x, y: frame.h - mb.y - cSize, w: mb.w * 0.42, h: cSize }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: (mb.w * 0.42) / frame.w, fontSize: cSize / frame.w, align: 'left', colorRole: 'ink' })
    }

    return { ops, did: 'title top-left; details ruled on the right; the date large at the foot in accent' }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-index.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/patterns/indexPattern.ts frontend/tests/unit/frame-patterns-index.unit.spec.ts
git commit -m "feat(frame): Index poster pattern (grid snap + date hero)"
```

---

### Task 10: Pattern — Shape counter-form (needs a shape) & Photo behind (needs an image)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/shapeCounter.ts`
- Create: `frontend/app/lib/frame/patterns/patterns/photoBehind.ts`
- Test: `frontend/tests/unit/frame-patterns-shape-image.unit.spec.ts`

Rationale (Task Right-Sizing): both are short "one element behind the title" patterns exercising the `needs` gate; they share a test file and reviewer gate.

**Interfaces:**
- Consumes: `Pattern`, `LayerOp` from `../types`; `rngFor`; `marginBox`, `toNorm`, `fitSize`; `pickShape` from `../shapePick`.
- Produces: `shapeCounter: Pattern` (id `'shapeCounter'`, `needs.shape`), `photoBehind: Pattern` (id `'photoBehind'`, `needs.image`). Each emits the non-text element behind the title (lower `z`) with the title overprinting (`blend:'multiply'`).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-shape-image.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { shapeCounter } from '~/lib/frame/patterns/patterns/shapeCounter'
import { photoBehind } from '~/lib/frame/patterns/patterns/photoBehind'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('shapeCounter', () => {
  it('puts the shape behind the title and overprints', () => {
    const { ops } = shapeCounter.place(ctxFor({ elements: inferElements([
      { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
      { id: 'sh', kind: 'shape', shapeId: 'circle' },
    ]) }))
    const shape = ops.find(o => o.kind === 'shape')!
    const title = ops.find(o => o.target === 'title')!
    expect(shape.shapeId).toBe('circle')
    expect(shape.colorRole).toBe('accent')
    expect((shape.z ?? 0)).toBeLessThan(title.z ?? 0)
    expect(title.blend).toBe('multiply')
    assertSaneOps(ops)
  })
  it('declares needs.shape', () => { expect(shapeCounter.needs?.shape).toBe(true) })
})

describe('photoBehind', () => {
  it('puts the image behind the title', () => {
    const { ops } = photoBehind.place(ctxFor())
    const img = ops.find(o => o.kind === 'image')!
    const title = ops.find(o => o.target === 'title')!
    expect(img.target).toBe('img')
    expect((img.z ?? 0)).toBeLessThan(title.z ?? 0)
    expect(img.w!).toBeGreaterThan(0)
    assertSaneOps(ops.filter(o => o.kind === 'text'))
  })
  it('declares needs.image', () => { expect(photoBehind.needs?.image).toBe(true) })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-shape-image.unit.spec.ts`
Expected: FAIL — cannot resolve the two patterns.

- [ ] **Step 3: Write minimal implementations**

```ts
// frontend/app/lib/frame/patterns/patterns/shapeCounter.ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const shapeCounter: Pattern = {
  id: 'shapeCounter',
  name: 'Shape counter-form',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 3)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    if (sh) {
      const wpx = frame.w * r.range(0.55, 1.05)
      const hpx = wpx * sh.aspect
      const xLeft = mb.x + (mb.w - wpx) * r.f()
      const yTop = mb.y + (mb.h - hpx) * r.f()
      const c = toNorm({ x: xLeft, y: yTop, w: wpx, h: hpx }, frame)
      ops.push({ target: 'shape', kind: 'shape', shapeId: sh.id, x: c.x, y: c.y, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
    }
    const text = elements.title?.text ?? 'WORD'
    const size = fitSize(text, mb.w * r.range(0.95, 1.25), measure)
    const wpx = measure(text) * (size / 100)
    const yTop = mb.y + (mb.h - size * 0.72) * r.f()
    const tc = toNorm({ x: mb.x, y: yTop, w: wpx, h: size * 0.72 }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: wpx / frame.w, fontSize: size / frame.w, align: 'left', colorRole: 'ink', blend: 'multiply', z: 1 })
    return { ops, did: `${sh ? sh.id : 'a shape'} in accent behind the title as a counter-form; title overprints it` }
  },
}
```

```ts
// frontend/app/lib/frame/patterns/patterns/photoBehind.ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const photoBehind: Pattern = {
  id: 'photoBehind',
  name: 'Photo behind',
  fits: ['word', 'phrase', 'sentence'],
  needs: { image: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 4)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const img = elements.images[0]
    // title upper-ish, oversize
    const text = elements.title?.text ?? 'WORD'
    const size = fitSize(text, mb.w * r.range(1.1, 1.6), measure)
    const wpx = measure(text) * (size / 100)
    const tyTop = mb.y + mb.h * r.range(0, 0.25)
    const tc = toNorm({ x: mb.x, y: tyTop, w: wpx, h: size * 0.72 }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: wpx / frame.w, fontSize: size / frame.w, align: 'left', colorRole: 'ink', z: 1 })
    // image behind, covering the title's lower part down to the foot
    if (img) {
      const pyTop = tyTop + size * 0.4
      const full = r.chance(0.5)
      const pxLeft = full ? 0 : mb.x
      const pw = full ? frame.w : mb.w
      const c = toNorm({ x: pxLeft, y: pyTop, w: pw, h: frame.h - pyTop }, frame)
      ops.push({ target: img.id, kind: 'image', x: c.x, y: c.y, w: pw / frame.w, h: (frame.h - pyTop) / frame.w, fill: 'photo', z: 0 })
    }
    if (elements.caption) {
      const cSize = frame.w * 0.019
      const cc = toNorm({ x: mb.x, y: frame.h - mb.y - cSize, w: mb.w * 0.42, h: cSize }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: (mb.w * 0.42) / frame.w, fontSize: cSize / frame.w, align: 'left', colorRole: 'field', z: 2 })
    }
    return { ops, did: 'the title sits behind the photo, its lower part hidden' }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-shape-image.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/frame/patterns/patterns/shapeCounter.ts frontend/app/lib/frame/patterns/patterns/photoBehind.ts frontend/tests/unit/frame-patterns-shape-image.unit.spec.ts
git commit -m "feat(frame): Shape counter-form + Photo behind patterns"
```

---

### Task 11: Registry, fit filter, and public surface

**Files:**
- Create: `frontend/app/lib/frame/patterns/catalog.ts`
- Create: `frontend/app/lib/frame/patterns/index.ts`
- Test: `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`

**Interfaces:**
- Consumes: the five patterns; `Pattern`, `PatternContext` from `./types`.
- Produces: `PATTERNS: Pattern[]`; `fittingPatterns(ctx): Pattern[]` (filters by `kindOf(title word count)` against `fits`, and drops patterns whose `needs.shape`/`needs.image` aren't satisfied); the barrel `index.ts` re-exporting the public API.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-catalog.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { PATTERNS, fittingPatterns } from '~/lib/frame/patterns/catalog'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { ctxFor } from './_poster-fixtures'

describe('catalog', () => {
  it('registers the five patterns with unique ids', () => {
    const ids = PATTERNS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(['runoff', 'statement', 'index', 'shapeCounter', 'photoBehind']))
  })
  it('every pattern is deterministic and returns at least a title op', () => {
    for (const p of PATTERNS) {
      const ctx = ctxFor()
      if (p.needs?.shape && !ctx.elements.shapes.length) continue
      const out = p.place(ctx)
      expect(out).toEqual(p.place(ctxFor()))
      expect(out.ops.some(o => o.target === 'title')).toBe(true)
      expect(typeof out.did).toBe('string')
    }
  })
  it('drops shape/image patterns when the element is absent', () => {
    const bare = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const ids = fittingPatterns(ctxFor({ elements: bare })).map(p => p.id)
    expect(ids).not.toContain('shapeCounter')
    expect(ids).not.toContain('photoBehind')
    expect(ids).toContain('runoff')
  })
  it('keeps shape/image patterns when the element is present', () => {
    const ids = fittingPatterns(ctxFor()).map(p => p.id) // fixture has an image + a shape
    expect(ids).toContain('shapeCounter')
    expect(ids).toContain('photoBehind')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-catalog.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/catalog`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/catalog.ts
import type { Pattern, PatternContext } from './types'
import { kindOf } from './types'
import { runOff } from './patterns/runOff'
import { statement } from './patterns/statement'
import { indexPattern } from './patterns/indexPattern'
import { shapeCounter } from './patterns/shapeCounter'
import { photoBehind } from './patterns/photoBehind'

export const PATTERNS: Pattern[] = [runOff, statement, indexPattern, shapeCounter, photoBehind]

/** Patterns that fit the title's kind and whose required elements are present. */
export function fittingPatterns(ctx: PatternContext): Pattern[] {
  const kind = kindOf(ctx.elements.title?.words.length ?? 0)
  const hasShape = ctx.elements.shapes.length > 0 || ctx.elements.shapeMode != null
  const hasImage = ctx.elements.images.length > 0
  return PATTERNS.filter(p => {
    if (!p.fits.includes(kind)) return false
    if (p.needs?.shape && !hasShape) return false
    if (p.needs?.image && !hasImage) return false
    return true
  })
}
```

```ts
// frontend/app/lib/frame/patterns/index.ts
export * from './types'
export { PATTERNS, fittingPatterns } from './catalog'
export { inferElements } from './hierarchy'
export { rngFor } from './rng'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-catalog.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the whole engine suite and typecheck**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts`
Expected: PASS (all files).
Run: `cd frontend && npx nuxi typecheck 2>&1 | grep -i "app/lib/frame/patterns" || echo "no engine type errors"`
Expected: `no engine type errors` (the engine adds no new type errors; pre-existing baseline errors elsewhere are out of scope — see the typecheck-baseline memory).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/frame/patterns/catalog.ts frontend/app/lib/frame/patterns/index.ts frontend/tests/unit/frame-patterns-catalog.unit.spec.ts
git commit -m "feat(frame): poster pattern registry + fit filter"
```

---

## Notes for the executor

- **Commit hygiene (shared checkout):** this repo is shared across sessions. Use a private index for EVERY commit: `export GIT_INDEX_FILE=$(mktemp)`, `git read-tree HEAD`, `git add <only your exact new paths>`, `git diff --cached --stat` (confirm ONLY your files), commit via `git write-tree` + `git commit-tree -p HEAD` + `git update-ref refs/heads/main`, then `unset GIT_INDEX_FILE`. **Never `cp .git/index`** (it carries other sessions' staged work). Never `git stash`.
- **Import alias:** `~/` = `frontend/app/`, `~~/` = repo root (`frontend/` in this Nuxt 4 layout). Match the alias the neighbouring files under `app/lib/frame/` already use.
- **Vitest globals:** confirm whether existing `tests/unit/*.unit.spec.ts` import `{ describe, it, expect }` or rely on globals, and match. The plan's tests import them explicitly, which is safe either way.
- **Baseline:** per the main-test-suite-triage memory, the unit suite has pre-existing reds from other sessions; run only the `frame-patterns-*` files to judge this work, not the whole suite.

## What plan 1b will add (not in scope here)

- `applyPlacement(placement, layers)`: map each `LayerOp` onto the real `LocalLayer` (x/y centre, `fontSize`, `boxW=w`, `rotation`, `align`, `text` with `lineBreak`, `blend`, `color` from `colorRole` via the frame palette, z-order from `z`), as **one undo step**.
- `buildContext(node)`: read `sailor_localLayers` → `PosterLayerView[]`, `resolveGrid(readGrid(props), w, h)`, a canvas-backed `measure`, assemble `PatternContext`.
- Write `sailor_posterState = { patternId, seed, shapeMode }` for later reflow.
- The Options sheet UI in the frame panel (contact sheet, hover-preview via the occlusion/loop gate, Apply / Another / More-like-this).
