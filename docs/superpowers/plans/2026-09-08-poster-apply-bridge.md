# Poster Apply Bridge (sub-project 1b-core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pure poster pattern engine (sub-project 1a) invocable on a real Frame: read a frame's elements into a `PatternContext`, run a pattern, and apply the resulting `LayerOp`s onto the real `LocalLayer`s as ONE undo step — with the palette projected to field/ink/accent roles (ink auto-contrasted) and a canvas-backed measure that also yields cap-height for optical work.

**Architecture:** Pure logic (role projection, op→layer patching) lives in framework-free modules under `frontend/app/lib/frame/patterns/` and is unit-tested. The only non-pure pieces are a thin canvas `measure` helper and a one-function apply wrapper that calls the existing editor's `recordHistory()`/`commit()`. No new UI — the Options sheet is sub-project 1b-ii.

**Tech Stack:** TypeScript, Vitest. Consumes 1a's engine (`~/lib/frame/patterns`), the existing seed→palette engine (`~/lib/color/*`), the grid helpers (`~/lib/frame/grid` + `~/lib/frame/gridConfig`), and the Frame editor's undo API (`useLocalLayerEditor`).

## Global Constraints

- **Coordinate space:** `LayerOp` positions are normalized-centre (x/y ∈ 0..1 of frame w/h; sizes normalized to frame **width**) — identical to `LocalLayer`'s own convention, so applying an op is a direct field copy (`op.x→layer.x`, `op.fontSize→layer.fontSize`, `op.w→layer.boxW` for text / `→layer.w` for rect/shape/image). No unit conversion.
- **One undo step:** apply builds the FULL next-layers array in plain JS, then calls `editor.recordHistory()` ONCE and `editor.commit(next)` ONCE. NEVER call `addLocal`/`setLocal`/`deleteLocal` per op (each records its own history → N undo steps). This is the load-bearing integration rule.
- **Paint is a string:** a solid colour Paint is just a hex string (`layer.color = '#ffffff'`). Role→paint is `palette[role]`. No wrapper/constructor exists.
- **The engine's contract is preserved on apply:** apply only ever writes position, size, rotation, line breaks, blend, and a colour resolved from a **role** (`ink`/`accent`/`field`) against the user's chosen palette. It never invents a face or a literal colour of its own.
- **Field colour is NOT applied here.** The frame background (`sailor_localBg`) is set when the user picks a palette (a separate action; `setBackground` records its own history) — apply touches layers only, so background + layers never need to share one undo step (the public editor API can't do that anyway). A `colorRole:'field'` on a *text* op means "paint this text in the field colour for knockout legibility" = `palette.field` — that is a text colour, not the background.
- **Grid resolution uses the real output size:** call `resolveGrid(readGrid(props), frameW, frameH)` where `frameW`/`frameH` are the node's real width/height widget values, not the arbitrary edit-time display box.
- **Reuse:** `readGrid` from `~/lib/frame/gridConfig` (NOT `grid.ts`); `resolveGrid` from `~/lib/frame/grid`; `inferElements`/`fittingPatterns`/`PATTERNS` from `~/lib/frame/patterns`; layer factories (`createTextLayer` etc.) from `~/composables/useCompositorLayers` for any created layer (none created in this plan — the 5 patterns patch existing layers).
- **Tests:** `frontend/tests/unit/<name>.unit.spec.ts`; run `cd frontend && npx vitest run tests/unit/<file>`. Import `{ describe, it, expect }` explicitly.
- **Commit hygiene (shared checkout):** every commit uses a PRIVATE index, and the ENTIRE recipe runs in ONE shell command (env vars do not survive across separate shell calls): `export GIT_INDEX_FILE=$(mktemp) && git read-tree HEAD && git add <exact new paths> && git diff --cached --name-only && git commit -m "…" && unset GIT_INDEX_FILE && git add -- <same paths>`. The `git diff --cached --name-only` must list ONLY your files. Never `git add -A`/`.`/`git stash`/`cp .git/index`. Commit on `main`.

---

## File Structure

- `frontend/app/lib/frame/patterns/palette.ts` (new) — `ResolvedPalette`, `roleToPaint`, `contrastRatio`, `autoInk`, `rolesFromFamily`. Pure. The colour seam: projects a `PaletteFamily` (from the seed engine) to `{field, ink, accent}` with ink WCAG-auto-contrasted.
- `frontend/app/lib/frame/patterns/apply.ts` (new) — `applyPlacement(layers, placement, elements, palette)`: pure, returns the next `LocalLayer[]`. The op→layer patcher.
- `frontend/app/lib/frame/patterns/frameContext.ts` (new) — `posterLayerViews(props)`, `buildFrameContext(props, frameW, frameH, measure)`: read a node's layers + grid into a `PatternContext`. Pure given an injected `measure`.
- `frontend/app/lib/frame/patterns/frameMeasure.ts` (new) — `makeFrameMeasure(face, weight)`: a canvas-backed width `measure` (width at size 100) + `capMetrics(face, weight)`: cap-height/ascent/descent via `TextMetrics`. The only canvas-touching module.
- `frontend/app/lib/frame/patterns/applyToFrame.ts` (new) — `applyPatternToFrame(node, editor, patternId, seed, palette)`: the ONE-undo-step wrapper (recordHistory + commit) + writes `sailor_posterState`. Thin glue.
- Tests: `frontend/tests/unit/frame-patterns-palette.unit.spec.ts`, `…-apply.unit.spec.ts`, `…-framecontext.unit.spec.ts`.

**Scope:** sub-project **1b-core**. Deferred to **1b-ii**: the Options sheet UI in `CompositorModal.vue` (a new `v-else-if="optionsOpen"` inspector branch modeled on the Frame Templates panel; a contact-sheet grid modeled on `ShapePicker.vue`; hover-preview via `ArtifactFrameNode.vue`'s `gate.hovered`/`applyGate()`/`renderPosterFrame()`), and the palette-picker that sets `sailor_localBg` to the chosen field. Deferred to **1c**: the remaining patterns, letter swaps, and the face/shape pickers.

---

### Task 1: Palette role projection + ink auto-contrast

**Files:**
- Create: `frontend/app/lib/frame/patterns/palette.ts`
- Test: `frontend/tests/unit/frame-patterns-palette.unit.spec.ts`

**Interfaces:**
- Consumes: `ColorRole` from `./types`; `PaletteFamily` from `~/lib/color/seedFamily` (shape `{ hexes: string[]; anchorIdxs: number[]; … }`).
- Produces: `ResolvedPalette = { field: string; ink: string; accent: string }`; `contrastRatio(a: string, b: string): number` (WCAG); `autoInk(field: string, candidates: string[]): { ink: string; ratio: number }`; `roleToPaint(role: ColorRole, p: ResolvedPalette): string`; `rolesFromFamily(family: { hexes: string[] }): ResolvedPalette`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-palette.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { contrastRatio, autoInk, roleToPaint, rolesFromFamily } from '~/lib/frame/patterns/palette'

describe('contrastRatio', () => {
  it('is ~21 for black on white and 1 for equal colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })
})

describe('autoInk', () => {
  it('rescues a clashing field by picking a high-contrast ink (>= 4.5)', () => {
    // vivid purple field; candidates include a low-contrast magenta
    const r = autoInk('#6d1fb0', ['#b0308a', '#3a2f8f'])
    expect(r.ratio).toBeGreaterThanOrEqual(4.5)      // white/black fallback guarantees it
  })
  it('always beats a naive mid-tone pick', () => {
    const naive = contrastRatio('#6d1fb0', '#b0308a')
    expect(autoInk('#6d1fb0', ['#b0308a']).ratio).toBeGreaterThan(naive)
  })
})

describe('rolesFromFamily', () => {
  it('picks a field, a contrasting ink, and a distinct accent', () => {
    const roles = rolesFromFamily({ hexes: ['#f2f0ef', '#121212', '#dd2200', '#3a2f8f'] })
    expect(contrastRatio(roles.field, roles.ink)).toBeGreaterThanOrEqual(4.5)
    expect(roles.accent).not.toBe(roles.field)
    expect(roles.accent).not.toBe(roles.ink)
  })
  it('roleToPaint maps a role to its hex', () => {
    const p = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
    expect(roleToPaint('ink', p)).toBe('#121212')
    expect(roleToPaint('accent', p)).toBe('#dd2200')
    expect(roleToPaint('field', p)).toBe('#f2f0ef')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-palette.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/palette`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/palette.ts
import type { ColorRole } from './types'

export interface ResolvedPalette { field: string; ink: string; accent: string }

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
function relLum(hex: string): number {
  const [r, g, b] = toRgb(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relLum(a), lb = relLum(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
/** Best-contrast ink on `field` from candidates + black/white/paper fallbacks (guarantees a legible pick). */
export function autoInk(field: string, candidates: string[]): { ink: string; ratio: number } {
  const pool = [...candidates, '#ffffff', '#0e0e0e', '#f2f0ef']
  let ink = pool[0]!, ratio = 0
  for (const c of pool) { const r = contrastRatio(field, c); if (r > ratio) { ratio = r; ink = c } }
  return { ink, ratio }
}
export function roleToPaint(role: ColorRole, p: ResolvedPalette): string { return p[role] }

/** Approx OKLCH-free chroma proxy: max-min channel spread (0..1). Good enough to
 *  rank "how colourful" for accent selection without pulling in the OKLCH lib. */
function chroma(hex: string): number {
  const [r, g, b] = toRgb(hex).map(v => v / 255) as [number, number, number]
  return Math.max(r, g, b) - Math.min(r, g, b)
}
/** Project a palette family to poster roles. field = the most ground-like member
 *  (lowest chroma; ties → most extreme lightness); ink = auto-contrast to field
 *  from the members + fallbacks; accent = the most colourful member distinct from
 *  field and ink. */
export function rolesFromFamily(family: { hexes: string[] }): ResolvedPalette {
  const hexes = family.hexes.length ? family.hexes : ['#f2f0ef', '#121212', '#dd2200']
  const field = [...hexes].sort((a, b) => {
    const dc = chroma(a) - chroma(b)
    if (Math.abs(dc) > 0.02) return dc            // lowest chroma first
    return Math.abs(relLum(a) - 0.5) < Math.abs(relLum(b) - 0.5) ? 1 : -1 // then most extreme lightness
  })[0]!
  const { ink } = autoInk(field, hexes)
  const accent = [...hexes]
    .filter(h => h !== field && h !== ink)
    .sort((a, b) => chroma(b) - chroma(a))[0] ?? hexes.find(h => h !== field && h !== ink) ?? '#dd2200'
  return { field, ink, accent }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-palette.unit.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit** (single-shell private-index recipe from Global Constraints)

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/palette.ts frontend/tests/unit/frame-patterns-palette.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): palette role projection + ink auto-contrast" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/palette.ts frontend/tests/unit/frame-patterns-palette.unit.spec.ts
```

---

### Task 2: Apply a placement to layers (pure)

**Files:**
- Create: `frontend/app/lib/frame/patterns/apply.ts`
- Test: `frontend/tests/unit/frame-patterns-apply.unit.spec.ts`

**Interfaces:**
- Consumes: `PatternPlacement`, `LayerOp`, `FrameElements`, `Role` from `./types`; `ResolvedPalette`, `roleToPaint` from `./palette`; `LocalLayer` from `~/composables/useCompositorLayers` (a type-only import).
- Produces: `applyPlacement(layers: LocalLayer[], placement: PatternPlacement, elements: FrameElements, palette: ResolvedPalette): LocalLayer[]` — returns a NEW array; each op resolves its target to a layer id (a `Role` via `elements[role].id`, or a literal id for image/shape ops) and patches that layer's geometry/colour/blend/text immutably. Ops whose target resolves to no layer are skipped.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-apply.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { PatternPlacement, FrameElements } from '~/lib/frame/patterns/types'

const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
function textLayer(id: string, over: Partial<any> = {}): any {
  return { id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NOISE',
    fontFamily: 'Inter', fontWeight: 700, fontSize: 0.08, color: '#000000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, ...over }
}
const elements = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [], shapes: [], shapeMode: null } as unknown as FrameElements

describe('applyPlacement', () => {
  it('patches the title layer geometry and ink colour from the op', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.2, y: 0.3, w: 0.9, fontSize: 0.25, rotation: 0, align: 'left', colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, elements, palette)
    expect(next).not.toBe(layers)                 // new array
    expect(next[0]).not.toBe(layers[0])           // new layer object (immutable)
    const t = next[0] as any
    expect([t.x, t.y]).toEqual([0.2, 0.3])
    expect(t.fontSize).toBe(0.25)
    expect(t.boxW).toBe(0.9)                       // op.w → text boxW
    expect(t.align).toBe('left')
    expect(t.color).toBe('#121212')               // ink role → hex
  })
  it('inserts line breaks and blend, and leaves the font/weight untouched', () => {
    const layers: LocalLayer[] = [textLayer('t', { fontFamily: 'Anton', fontWeight: 800 })]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.5, y: 0.5, fontSize: 0.2, colorRole: 'accent', blend: 'multiply', lineBreak: 'NO\nISE' },
    ] }
    const t = applyPlacement(layers, placement, elements, palette)[0] as any
    expect(t.text).toBe('NO\nISE')
    expect(t.blend).toBe('multiply')
    expect(t.color).toBe('#dd2200')
    expect(t.fontFamily).toBe('Anton')            // NEVER changed by apply
    expect(t.fontWeight).toBe(800)                // NEVER changed by apply
  })
  it('skips an op whose target resolves to no layer', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'details', kind: 'text', x: 0.1, y: 0.1, fontSize: 0.02, colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, elements, palette)
    expect(next[0]).toEqual(layers[0])            // unchanged (no details element)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-apply.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/apply`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/apply.ts
import type { PatternPlacement, LayerOp, FrameElements, Role } from './types'
import type { ResolvedPalette } from './palette'
import { roleToPaint } from './palette'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const ROLES: Role[] = ['title', 'details', 'caption', 'date']

/** Resolve an op's target to a concrete layer id: a role → the inferred element's
 *  id; anything else is treated as a literal layer id (image/shape ops). */
function targetId(op: LayerOp, elements: FrameElements): string | undefined {
  if ((ROLES as string[]).includes(op.target)) {
    const el = elements[op.target as Role]
    return el?.id
  }
  return op.target
}

/** Apply a placement's ops onto a copy of `layers`. Pure: returns a new array of
 *  new layer objects; never mutates the input. Geometry/colour-role/blend/line-
 *  breaks only — face, weight and content are never touched. */
export function applyPlacement(
  layers: LocalLayer[],
  placement: PatternPlacement,
  elements: FrameElements,
  palette: ResolvedPalette,
): LocalLayer[] {
  // index ops by resolved layer id (last op for an id wins — patterns emit one per element)
  const byId = new Map<string, LayerOp>()
  for (const op of placement.ops) { const id = targetId(op, elements); if (id) byId.set(id, op) }
  return layers.map(layer => {
    const op = byId.get(layer.id)
    if (!op) return layer
    const next: any = { ...layer, x: op.x, y: op.y }
    if (op.rotation != null) next.rotation = op.rotation
    if (op.blend) next.blend = op.blend
    if (op.colorRole) {
      const paint = roleToPaint(op.colorRole, palette)
      if (layer.kind === 'text') next.color = paint
      else if ('fill' in layer) next.fill = paint
    }
    if (layer.kind === 'text') {
      if (op.fontSize != null) next.fontSize = op.fontSize
      if (op.w != null) next.boxW = op.w
      if (op.align) next.align = op.align
      if (op.lineBreak != null) next.text = op.lineBreak
    } else {
      if (op.w != null) next.w = op.w
      if (op.h != null) next.h = op.h
    }
    return next as LocalLayer
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-apply.unit.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/apply.ts frontend/tests/unit/frame-patterns-apply.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): apply a poster placement onto layers (pure)" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/apply.ts frontend/tests/unit/frame-patterns-apply.unit.spec.ts
```

---

### Task 3: Build a PatternContext from a frame node's properties

**Files:**
- Create: `frontend/app/lib/frame/patterns/frameContext.ts`
- Test: `frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts`

**Interfaces:**
- Consumes: `PatternContext`, `PosterLayerView`, `FrameElements`, `Measure` from `./types`; `inferElements` from `./hierarchy`; `readGrid` from `~/lib/frame/gridConfig`; `resolveGrid` from `~/lib/frame/grid`; `LocalLayer`/`TextLayer` types from `~/composables/useCompositorLayers`.
- Produces:
  - `posterLayerViews(props: Record<string, unknown> | undefined): PosterLayerView[]` — read `sailor_localLayers` defensively (`?? []`), map each `LocalLayer` to a `PosterLayerView` (`{ id, kind: 'text'|'image'|'shape', text?, fontSize?, shapeId? }`; non-poster kinds like `brush`/`wired`/`line`/`deal`/`scatter` are dropped; `rect`/`ellipse`/`polygon`/`star`/`path` map to `kind:'shape'` with `shapeId` from a `shape` field if present).
  - `buildFrameContext(props, frameW, frameH, measure: Measure): PatternContext` — assembles `{ frame:{w,h}, grid, margin, elements, seed, measure }`; `grid = resolveGrid(g, frameW, frameH)` when `g.mode!=='off'` else `null`; `margin = g.margin`; `seed` from `props.sailor_posterState?.seed ?? 1`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { posterLayerViews, buildFrameContext } from '~/lib/frame/patterns/frameContext'

const stubMeasure = (t: string) => t.length * 60

const props = {
  sailor_localLayers: [
    { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5 },
    { id: 'd', kind: 'text', text: '12–14 October 2026', fontSize: 0.03, x: 0.5, y: 0.9 },
    { id: 'b', kind: 'brush', x: 0.5, y: 0.5 },                 // dropped
    { id: 'r', kind: 'rect', x: 0.5, y: 0.5, shape: 'circle' },  // → shape
    { id: 'i', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5 },
  ],
}

describe('posterLayerViews', () => {
  it('maps text/image/shape and drops non-poster kinds', () => {
    const v = posterLayerViews(props)
    expect(v.map(x => x.id)).toEqual(['t', 'd', 'r', 'i'])   // brush dropped
    expect(v.find(x => x.id === 'r')).toMatchObject({ kind: 'shape', shapeId: 'circle' })
    expect(v.find(x => x.id === 'i')).toMatchObject({ kind: 'image' })
  })
  it('defaults to empty on a bare node', () => {
    expect(posterLayerViews(undefined)).toEqual([])
    expect(posterLayerViews({})).toEqual([])
  })
})

describe('buildFrameContext', () => {
  it('assembles a context with inferred elements and no grid when off', () => {
    const ctx = buildFrameContext(props, 800, 1000, stubMeasure)
    expect(ctx.frame).toEqual({ w: 800, h: 1000 })
    expect(ctx.grid).toBeNull()                 // default grid mode is 'off'
    expect(ctx.elements.title?.id).toBe('t')
    expect(ctx.elements.date?.id).toBe('d')
    expect(ctx.measure('AB')).toBe(120)
    expect(typeof ctx.seed).toBe('number')
  })
  it('resolves a grid when the frame declares one', () => {
    const withGrid = { ...props, sailor_localGrid: { mode: 'explicit', columns: 4, rows: 4, margin: 0.05 } }
    const ctx = buildFrameContext(withGrid, 800, 1000, stubMeasure)
    expect(ctx.grid).not.toBeNull()
    expect(ctx.grid!.xs.length).toBeGreaterThan(0)
    expect(ctx.margin).toBeCloseTo(0.05, 5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-framecontext.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/frameContext`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/frameContext.ts
import type { PatternContext, PosterLayerView, Measure } from './types'
import { inferElements } from './hierarchy'
import { readGrid } from '~/lib/frame/gridConfig'
import { resolveGrid } from '~/lib/frame/grid'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const SHAPE_KINDS = new Set(['rect', 'ellipse', 'polygon', 'star', 'path'])

/** Read a frame's layers into the engine's read-only view. Non-poster kinds
 *  (brush/wired/line/deal/scatter) are dropped. */
export function posterLayerViews(props: Record<string, unknown> | undefined): PosterLayerView[] {
  const layers = (props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  const out: PosterLayerView[] = []
  for (const l of layers) {
    if (l.kind === 'text') out.push({ id: l.id, kind: 'text', text: (l as any).text, fontSize: (l as any).fontSize })
    else if (l.kind === 'image') out.push({ id: l.id, kind: 'image' })
    else if (SHAPE_KINDS.has(l.kind)) out.push({ id: l.id, kind: 'shape', shapeId: (l as any).shape ?? 'circle' })
  }
  return out
}

/** Assemble a PatternContext from a frame node's properties. `measure` is injected
 *  (the app passes a canvas-backed one; tests pass a stub). */
export function buildFrameContext(
  props: Record<string, unknown> | undefined,
  frameW: number,
  frameH: number,
  measure: Measure,
): PatternContext {
  const g = readGrid(props)
  const grid = g.mode !== 'off' ? resolveGrid(g, frameW, frameH) : null
  const elements = inferElements(posterLayerViews(props))
  const seed = (props?.sailor_posterState as { seed?: number } | undefined)?.seed ?? 1
  return { frame: { w: frameW, h: frameH }, grid, margin: g.margin, elements, seed, measure }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-framecontext.unit.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/frameContext.ts frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): build a PatternContext from a frame node" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/frameContext.ts frontend/tests/unit/frame-patterns-framecontext.unit.spec.ts
```

---

### Task 4: Canvas measure + cap-height metrics

**Files:**
- Create: `frontend/app/lib/frame/patterns/frameMeasure.ts`
- Test: `frontend/tests/unit/frame-patterns-measure.unit.spec.ts`

Rationale (Task Right-Sizing): this is the one canvas-touching module; it is thin glue but has a real fallback contract worth its own test.

**Interfaces:**
- Consumes: `Measure` from `./types`.
- Produces:
  - `fontStack(family: string): string` — a CSS font stack string with a generic fallback (this file rebuilds it because `cssFontStack` in `useCompositorLayers` is not exported).
  - `makeFrameMeasure(family: string, weight: number, ctx?: CanvasRenderingContext2D | null): Measure` — returns a `measure(text)` giving width in px at font-size 100 (so the engine's linear scaling holds). Uses a lazily-created offscreen 2D context; if none is available (SSR/no-DOM), falls back to `text.length * 60`.
  - `capMetrics(family: string, weight: number, sizePx: number, ctx?: CanvasRenderingContext2D | null): { cap: number; ascent: number; descent: number }` — via `TextMetrics.actualBoundingBoxAscent`/`fontBoundingBoxAscent`/`Descent`, each with a magic-number fallback (`cap = sizePx*0.72`, `ascent = sizePx*0.8`, `descent = sizePx*0.2`) when the metric is 0/absent (mirrors the Space Type precedent). *(Consumed by 1b-ii optical centering; shipped here so the measure module is complete.)*

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-measure.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { fontStack, makeFrameMeasure, capMetrics } from '~/lib/frame/patterns/frameMeasure'

// a fake 2D context: width = chars * 0.5 * fontSizePx (parsed from ctx.font)
function fakeCtx() {
  return {
    font: '', 
    measureText(t: string) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font)
      const px = m ? parseFloat(m[1]!) : 10
      return { width: t.length * 0.5 * px, actualBoundingBoxAscent: px * 0.7, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 } as any
    },
  } as unknown as CanvasRenderingContext2D
}

describe('fontStack', () => {
  it('quotes a multi-word family and appends a generic fallback', () => {
    expect(fontStack('Inter Tight')).toMatch(/"Inter Tight".*sans-serif/)
  })
})

describe('makeFrameMeasure', () => {
  it('returns width at size 100 using the injected ctx', () => {
    const m = makeFrameMeasure('Inter', 700, fakeCtx())
    expect(m('AB')).toBeCloseTo(2 * 0.5 * 100, 5)   // 2 chars * 0.5 * 100px
  })
  it('falls back to length*60 with no ctx', () => {
    const m = makeFrameMeasure('Inter', 700, null)
    expect(m('ABC')).toBe(180)
  })
})

describe('capMetrics', () => {
  it('reads TextMetrics from the ctx', () => {
    const cm = capMetrics('Inter', 700, 100, fakeCtx())
    expect(cm.cap).toBeCloseTo(70, 5)
    expect(cm.ascent).toBeCloseTo(80, 5)
  })
  it('falls back to size-proportional metrics with no ctx', () => {
    const cm = capMetrics('Inter', 700, 100, null)
    expect(cm.cap).toBeCloseTo(72, 5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-measure.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/frameMeasure`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/frameMeasure.ts
import type { Measure } from './types'

/** A CSS font stack with a generic fallback; multi-word families are quoted.
 *  (Rebuilt here — useCompositorLayers.cssFontStack is not exported.) */
export function fontStack(family: string): string {
  const quoted = /\s/.test(family) ? `"${family}"` : family
  return `${quoted}, system-ui, sans-serif`
}

let _fallbackCtx: CanvasRenderingContext2D | null | undefined
function defaultCtx(): CanvasRenderingContext2D | null {
  if (_fallbackCtx !== undefined) return _fallbackCtx
  try { _fallbackCtx = (typeof document !== 'undefined') ? document.createElement('canvas').getContext('2d') : null }
  catch { _fallbackCtx = null }
  return _fallbackCtx
}

/** width(text) in px at font-size 100, for the engine's linear scaling. No DOM ⇒ length*60. */
export function makeFrameMeasure(family: string, weight: number, ctx?: CanvasRenderingContext2D | null): Measure {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return (t: string) => t.length * 60
  return (t: string) => { c.font = `${weight} 100px ${fontStack(family)}`; return c.measureText(t).width }
}

/** Cap-height / ascent / descent in px at `sizePx`, from TextMetrics, with
 *  size-proportional fallbacks when a metric is 0/absent (Space Type precedent). */
export function capMetrics(family: string, weight: number, sizePx: number, ctx?: CanvasRenderingContext2D | null): { cap: number; ascent: number; descent: number } {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return { cap: sizePx * 0.72, ascent: sizePx * 0.8, descent: sizePx * 0.2 }
  c.font = `${weight} ${sizePx}px ${fontStack(family)}`
  const m = c.measureText('H')
  return {
    cap: m.actualBoundingBoxAscent || sizePx * 0.72,
    ascent: m.fontBoundingBoxAscent || sizePx * 0.8,
    descent: m.fontBoundingBoxDescent || sizePx * 0.2,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-measure.unit.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/frameMeasure.ts frontend/tests/unit/frame-patterns-measure.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): canvas measure + cap-height metrics for poster patterns" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/frameMeasure.ts frontend/tests/unit/frame-patterns-measure.unit.spec.ts
```

---

### Task 5: The one-undo-step apply wrapper + posterState

**Files:**
- Create: `frontend/app/lib/frame/patterns/applyToFrame.ts`
- Test: `frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts`

**Interfaces:**
- Consumes: `buildFrameContext` (`./frameContext`), `makeFrameMeasure` (`./frameMeasure`), `PATTERNS` (`./catalog`), `applyPlacement` (`./apply`), `ResolvedPalette` (`./palette`), `LocalLayer` (type, `~/composables/useCompositorLayers`).
- Produces: `applyPatternToFrame(args): { ok: boolean; posterState?: PosterState }` where `args = { props, frameW, frameH, patternId, seed, palette, titleFace, titleWeight, editor }` and `editor = { recordHistory(): void; commit(next: LocalLayer[]): void }` (the two methods from `useLocalLayerEditor`). It: builds the context (measure from `titleFace`/`titleWeight`), finds the pattern by id, runs `place`, applies the ops to a copy of the layers, then calls `editor.recordHistory()` ONCE and `editor.commit(next)` ONCE, and returns the `PosterState` (`{ patternId, seed }`) the caller writes to `props.sailor_posterState`. Unknown pattern id ⇒ `{ ok: false }` and no editor calls. `PosterState` interface is exported.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'

function frameProps() {
  return { sailor_localLayers: [
    { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 },
  ] }
}
const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }

describe('applyPatternToFrame', () => {
  it('records history once and commits once with the title moved', () => {
    const editor = { recordHistory: vi.fn(), commit: vi.fn() }
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette, titleFace: 'Inter', titleWeight: 700, editor })
    expect(out.ok).toBe(true)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit).toHaveBeenCalledTimes(1)
    const committed = editor.commit.mock.calls[0][0]
    expect(committed[0].id).toBe('t')
    expect(committed[0].fontFamily).toBe('Inter')       // face untouched
    expect(out.posterState).toEqual({ patternId: 'runoff', seed: 7 })
  })
  it('is a no-op for an unknown pattern id', () => {
    const editor = { recordHistory: vi.fn(), commit: vi.fn() }
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'nope', seed: 1, palette, titleFace: 'Inter', titleWeight: 700, editor })
    expect(out.ok).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled()
    expect(editor.commit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-applytoframe.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/frame/patterns/applyToFrame`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/lib/frame/patterns/applyToFrame.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import { buildFrameContext } from './frameContext'
import { makeFrameMeasure } from './frameMeasure'
import { PATTERNS } from './catalog'
import { applyPlacement } from './apply'

export interface PosterState { patternId: string; seed: number }

export interface ApplyArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  patternId: string
  seed: number
  palette: ResolvedPalette
  titleFace: string
  titleWeight: number
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void }
}

/** Run a pattern on a frame and apply its ops as ONE undo step. Returns the
 *  PosterState the caller writes to props.sailor_posterState. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return { ok: false }
  const measure = makeFrameMeasure(args.titleFace, args.titleWeight)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure)
  ctx.seed = args.seed
  const placement = pattern.place(ctx)
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []).slice()
  const next = applyPlacement(layers, placement, ctx.elements, args.palette)
  args.editor.recordHistory()
  args.editor.commit(next)
  return { ok: true, posterState: { patternId: args.patternId, seed: args.seed } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-applytoframe.unit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole new suite + typecheck scan**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts`
Expected: PASS (all files — the 1a suite plus the 5 new files here).
Run: `cd frontend && npx nuxt typecheck 2>&1 | grep -i "app/lib/frame/patterns" || echo "no engine type errors"`
Expected: `no engine type errors`.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/applyToFrame.ts frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): apply a pattern to a frame as one undo step" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/applyToFrame.ts frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts
```

---

## Notes for the executor

- **Commit hygiene:** every task's commit is the single-shell private-index recipe in Global Constraints. Confirm `git diff --cached --name-only` lists ONLY the two files before each commit. Another session has unrelated files staged — never sweep them.
- **Type-only imports:** `LocalLayer`/`TextLayer` come in as `import type` — this module must not create a runtime dependency on the Vue composable (it is pure logic). `applyToFrame` takes the `editor` as a plain `{ recordHistory, commit }` object, so it never imports the composable at runtime either.
- **Baseline:** the unit suite has pre-existing reds from other sessions; run only `frame-patterns-*` to judge this work.

## What 1b-ii (the Options sheet) will add — not in scope here

- A new `v-else-if="optionsOpen"` branch in `CompositorModal.vue`'s inspector chain (modeled on the Frame Templates panel `templatesOpen`), toggled by a toolbar button; a contact-sheet grid of tiles modeled on `ShapePicker.vue`; each tile calls `fittingPatterns(ctx)` + `pattern.place` to render a preview and, on click, `applyPatternToFrame(...)` then writes `props.sailor_posterState`.
- Hover-preview on the frame card via `ArtifactFrameNode.vue`'s `gate.hovered`/`applyGate()`/`renderPosterFrame()`.
- The palette picker (the seed→palette shelf via `assembleShelf` + `rolesFromFamily`), which on pick sets `sailor_localBg` to `palette.field` (its own undo step) and stores the chosen `ResolvedPalette` for apply.
- Optical vertical centering in the apply/placement path using `capMetrics` (the cap-height helper shipped in Task 4).
