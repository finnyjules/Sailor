# Frame Multi-Stroke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Frame layer carries an ordered list of strokes, each with its own distance from the shape's edge, and each optionally drawn as library shapes marching along that edge instead of a continuous band.

**Architecture:** A new pure module `lib/compositor/strokeStack.ts` owns the data model and a read-through that folds today's single-stroke fields into a one-entry list without writing anything (the pattern `lib/compositor/effectStack.ts` proved on 2026-09-07). One painter, `paintStrokeBand`, replaces `strokeAligned` as the single place any outline is drawn; a distance becomes the difference of two canvas dilations on a scratch canvas. A second pure module `lib/compositor/strokeShapes.ts` offsets the flattened outline as a polyline and hands it to the existing `guideFromPolyline` so shapes can be placed along it by arc length.

**Tech Stack:** Nuxt 4 · Vue 3 · TypeScript · Canvas 2D · Vitest (node environment, recording fake context) · Playwright (real Chromium, real pixels).

Spec: `docs/superpowers/specs/2026-09-07-frame-multi-stroke-design.md`. Read it before Task 1.

## Global Constraints

- **Work in the main checkout.** No worktree, no feature branch. `CLAUDE.md` says so and it overrides any skill that treats a worktree as step one.
- **Stage your own hunks under a private index.** Several sessions share this checkout, and `CompositorModal.vue` and `useCompositorLayers.ts` are the two files they collide on — whole-file staging swept hunks both ways on 2026-09-07. Every commit in this plan runs:
  ```bash
  export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
  git add -- <exact paths you changed>
  git commit -F - -- <the same exact paths>
  unset GIT_INDEX_FILE
  ```
  Never `git add -A`. Never `git stash` (the stash stack is shared). Leave files you did not write alone even when they look broken.
- **One dev server.** `:3002` serves the main checkout and is already running. Check with `lsof -nP -iTCP -sTCP:LISTEN | grep node` and `lsof -a -p <pid> -d cwd` before starting anything. Do not start a second server. Killing a Nuxt server can take ComfyUI with it.
- **UI copy: sentence case, never internal identifiers.** No lowercase-start labels, blurbs or hints. Every select over internal values needs human `optionLabels` — `'sharp'` must render as "Sharp", never as `sharp`.
- **Nothing is written to a stored layer until the user edits a stroke.** Read-through only. A migration on load would rewrite every saved frame.
- **`localLayerBox` is not touched.** It deliberately excludes stroke; widening it would move selection handles on every already-stroked layer.
- Unit tests run in the **node** environment against a recording fake canvas context (`tests/unit/compositor-stroke-style.unit.spec.ts` is the reference idiom) — they assert the *sequence of canvas calls*, never pixels. Pixels are asserted in Playwright only.
- Run typecheck with `cd frontend && npm run typecheck` and hold it at its existing baseline; do not fix unrelated pre-existing errors.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/app/lib/compositor/strokeStack.ts` | **Create.** The `StrokeInstance` model, the read-through `strokeStackOf`, and the list mutations. Pure: no canvas, no DOM. |
| `frontend/app/lib/compositor/strokeShapes.ts` | **Create.** Polyline offsetting and arc-length placement maths for a shape stroke. Pure. |
| `frontend/app/composables/useCompositorLayers.ts` | **Modify.** `paintStrokeBand` replaces `strokeAligned` as the painter; every stroked kind loops the stack; `outsideStrokePadPx` reads the stack. |
| `frontend/app/components/vue-canvas/compositor/CompositorStrokeRow.vue` | **Create.** One stroke row under its layer in the tree. Modelled line-for-line on `CompositorEffectRow.vue`. |
| `frontend/app/components/vue-canvas/compositor/StrokeStyleRow.vue` | **Modify.** Gains Distance, Corners and Style. |
| `frontend/app/components/vue-canvas/compositor/ShapeStrokeRow.vue` | **Create.** The shape / size / spacing / follow dials, shown only for a shapes stroke. |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | **Modify.** Tree rows, plus-menu, breadcrumb inspector, stroke handlers. |
| `frontend/app/lib/agent/surfaces/compositor.ts` | **Modify.** Describe and edit the stack. |
| `frontend/tests/unit/compositor-stroke-stack.unit.spec.ts` | **Create.** Read-through + mutations. |
| `frontend/tests/unit/compositor-stroke-band.unit.spec.ts` | **Create.** The painter's call sequence. |
| `frontend/tests/unit/compositor-stroke-shapes.unit.spec.ts` | **Create.** Offset + placement maths. |
| `frontend/tests/compositor-multi-stroke.spec.ts` | **Create.** Playwright: byte-identity A/B, measured distance, order, shape count, reach, live tree flow. |

---

## Task 1: The stroke stack model and read-through

**Files:**
- Create: `frontend/app/lib/compositor/strokeStack.ts`
- Test: `frontend/tests/unit/compositor-stroke-stack.unit.spec.ts`

**Interfaces:**
- Consumes: `Paint` from `~/lib/compositor/paint`; `StrokeAlign`, `StrokeDash` re-declared here to avoid a cycle back into the composable (see Step 3's note).
- Produces: `StrokeInstance`, `StrokeJoin`, `StrokeStyle`, `ShapeStrokeSpec`, `STROKE_STYLES`, `STROKE_JOINS`, `strokeStackOf(layer)`, `writeStrokeStackToLayer(stack)`, `createStroke()`, `addStroke(stack)`, `removeStroke(stack, id)`, `duplicateStroke(stack, id)`, `reorderStroke(stack, fromId, toId)`, `canReorderStroke(stack, fromId, toId)`, `strokeRowLabel(stroke, W)`, `strokeSupportsStack(kind)`, `strokeSupportsShapes(kind)`.

- [ ] **Step 1: Read the two files this mirrors**

Read `frontend/app/lib/compositor/effectStack.ts` in full — this module is its sibling and must match its conventions (id stamping, the `visible !== false` normalisation, the "new shape AND a live legacy field ⇒ trust the legacy branch" guard, immutable list mutations that return the SAME array reference when nothing changed).

Read `frontend/app/composables/useCompositorLayers.ts` lines 386–500 for `StrokeAlign`, `StrokeDash`, and which kinds carry `stroke` versus `strokeColor`.

- [ ] **Step 2: Write the failing test**

Create `frontend/tests/unit/compositor-stroke-stack.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  strokeStackOf, writeStrokeStackToLayer, createStroke,
  addStroke, removeStroke, duplicateStroke, reorderStroke, canReorderStroke,
  strokeRowLabel, strokeSupportsStack, strokeSupportsShapes,
  type StrokeInstance,
} from '~/lib/compositor/strokeStack'

describe('strokeStackOf — read-through', () => {
  it('folds a legacy stroked rect into a one-entry list at distance 0', () => {
    const stack = strokeStackOf({
      kind: 'rect', stroke: '#ff0000', strokeWidth: 0.01,
      strokeAlign: 'outside', strokeDash: { dash: 0.02, gap: 0.01 },
    })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#ff0000')
    expect(stack[0]!.width).toBe(0.01)
    expect(stack[0]!.align).toBe('outside')
    expect(stack[0]!.dash).toEqual({ dash: 0.02, gap: 0.01 })
    expect(stack[0]!.distance ?? 0).toBe(0)
    expect(stack[0]!.style ?? 'band').toBe('band')
    expect(stack[0]!.id).toBeTruthy()
  })

  it('reads a text layer from strokeColor, not stroke', () => {
    const stack = strokeStackOf({ kind: 'text', strokeColor: '#0f0', strokeWidth: 0.004 })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#0f0')
    expect(stack[0]!.width).toBe(0.004)
  })

  it('is empty for a layer with no stroke, a "none" stroke, or a zero width', () => {
    expect(strokeStackOf({ kind: 'rect', stroke: '', strokeWidth: 0 })).toEqual([])
    expect(strokeStackOf({ kind: 'rect', stroke: 'none', strokeWidth: 0.01 })).toEqual([])
    expect(strokeStackOf({ kind: 'rect', stroke: '#fff', strokeWidth: 0 })).toEqual([])
    expect(strokeStackOf(null)).toEqual([])
  })

  it('returns a stored new-shape stack as-is, normalising visible', () => {
    const stored = [
      { id: 's1', paint: '#fff', width: 0.01 },
      { id: 's2', paint: '#000', width: 0.02, visible: false, distance: 0.03 },
    ]
    const stack = strokeStackOf({ kind: 'rect', strokes: stored, stroke: '', strokeWidth: 0 })
    expect(stack.map(s => s.id)).toEqual(['s1', 's2'])
    expect(stack[0]!.visible).toBe(true)
    expect(stack[1]!.visible).toBe(false)
    expect(stack[1]!.distance).toBe(0.03)
  })

  it('trusts the LEGACY branch when a new-shape layer also carries a live legacy stroke', () => {
    // An older build editing a newer document. The legacy field is the one with a
    // trustworthy meaning, exactly as effectStackOf decides for tornEdge/feather.
    const stack = strokeStackOf({
      kind: 'rect', strokes: [{ id: 's1', paint: '#fff', width: 0.01 }],
      stroke: '#ff0000', strokeWidth: 0.05,
    })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#ff0000')
    expect(stack[0]!.width).toBe(0.05)
  })

  it('drops entries that are not usable strokes rather than throwing', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [null, { id: 's1', paint: '#fff', width: 0.01 }, { paint: '#000', width: 1 }, 7],
      stroke: '', strokeWidth: 0,
    } as any)
    // The un-ided entry means "not all ided" ⇒ the whole thing falls to the legacy
    // branch, and the legacy fields are empty ⇒ no strokes.
    expect(stack).toEqual([])
  })
})

describe('writeStrokeStackToLayer', () => {
  it('writes the list and clears every legacy field', () => {
    expect(writeStrokeStackToLayer([{ id: 's1', paint: '#fff', width: 0.01 }])).toEqual({
      strokes: [{ id: 's1', paint: '#fff', width: 0.01 }],
      stroke: undefined, strokeColor: undefined, strokeWidth: undefined,
      strokeAlign: undefined, strokeDash: undefined,
    })
  })
})

describe('list mutations', () => {
  const s = (id: string): StrokeInstance => ({ id, paint: '#fff', width: 0.01 })

  it('adds to the END, so a new stroke paints under the existing ones', () => {
    const next = addStroke([s('a')])
    expect(next).toHaveLength(2)
    expect(next[0]!.id).toBe('a')
    expect(next[1]!.id).not.toBe('a')
  })

  it('removes by id and returns the SAME array when the id is unknown', () => {
    const stack = [s('a'), s('b')]
    expect(removeStroke(stack, 'a').map(x => x.id)).toEqual(['b'])
    expect(removeStroke(stack, 'zz')).toBe(stack)
  })

  it('duplicates directly after the original with a fresh id and no shared nesting', () => {
    const stack: StrokeInstance[] = [{ id: 'a', paint: '#fff', width: 0.01, dash: { dash: 0.02, gap: 0.01 } }]
    const next = duplicateStroke(stack, 'a')
    expect(next.map(x => x.id)).toEqual(['a', next[1]!.id])
    expect(next[1]!.id).not.toBe('a')
    expect(next[1]!.dash).toEqual({ dash: 0.02, gap: 0.01 })
    expect(next[1]!.dash).not.toBe(stack[0]!.dash)   // deep, not shared
  })

  it('reorders a FORWARD drag correctly — the index must be read before the splice', () => {
    const stack = [s('a'), s('b'), s('c')]
    expect(reorderStroke(stack, 'a', 'c').map(x => x.id)).toEqual(['b', 'c', 'a'])
    expect(reorderStroke(stack, 'c', 'a').map(x => x.id)).toEqual(['c', 'a', 'b'])
    expect(reorderStroke(stack, 'a', 'a')).toBe(stack)
    expect(canReorderStroke(stack, 'a', 'zz')).toBe(false)
  })
})

describe('kind gates', () => {
  it('lets closed shapes and text stack; a line and an image do not', () => {
    for (const k of ['rect', 'ellipse', 'polygon', 'star', 'path', 'text']) {
      expect(strokeSupportsStack(k)).toBe(true)
    }
    for (const k of ['line', 'image', 'brush', 'wired']) {
      expect(strokeSupportsStack(k)).toBe(false)
    }
  })

  it('offers marching shapes on closed shapes only — text has no glyph outlines here', () => {
    for (const k of ['rect', 'ellipse', 'polygon', 'star', 'path']) {
      expect(strokeSupportsShapes(k)).toBe(true)
    }
    expect(strokeSupportsShapes('text')).toBe(false)
    expect(strokeSupportsShapes('line')).toBe(false)
  })
})

describe('strokeRowLabel', () => {
  it('names a plain stroke by its width in px', () => {
    expect(strokeRowLabel({ id: 'a', paint: '#fff', width: 0.01 }, 600)).toBe('6 px')
  })
  it('adds the distance when there is one, outward and inward', () => {
    expect(strokeRowLabel({ id: 'a', paint: '#fff', width: 0.01, distance: 0.02 }, 600)).toBe('6 px, 12 px out')
    expect(strokeRowLabel({ id: 'a', paint: '#fff', width: 0.01, distance: -0.02 }, 600)).toBe('6 px, 12 px in')
  })
  it('names a shape stroke by its shape', () => {
    expect(strokeRowLabel(
      { id: 'a', paint: '#fff', width: 0.01, style: 'shapes', shapes: { shapeId: 'star', size: 0.02, spacing: 0.03 } },
      600,
    )).toBe('Star')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-stack.unit.spec.ts
```

Expected: FAIL — `Failed to resolve import "~/lib/compositor/strokeStack"`.

- [ ] **Step 4: Write the module**

Create `frontend/app/lib/compositor/strokeStack.ts`.

**Import note:** do NOT import `StrokeAlign` / `StrokeDash` from `~/composables/useCompositorLayers` — that composable will import this module in Task 3, and the cycle would break the eager module consts this codebase has already been bitten by. Declare the two aliases here and have the composable re-export them.

```ts
/**
 * A layer's strokes, as an ordered list.
 *
 * The sibling of `effectStack.ts`, and deliberately built the same way: stored layers are
 * read with a raw cast in several places and there is no sanitize step, so a migration on
 * load would rewrite every saved frame the moment it opened. `strokeStackOf` READS THROUGH
 * the legacy single-stroke fields instead, and the new shape is written only on an edit.
 *
 * Pure: no canvas, no DOM, no Path2D. The painter decides how a stroke is drawn; this
 * decides only what strokes a layer has and in what order.
 */
import type { Paint } from '~/lib/compositor/paint'

/** Where a band sits relative to its reference edge. Mirrors the composable's type; declared
 *  here rather than imported because the composable imports THIS module (cycle). */
export type StrokeAlign = 'center' | 'inside' | 'outside'
export interface StrokeDash { dash: number; gap: number }

/** How the OFFSET treats corners. 'sharp' (canvas miter) keeps a star's spikes as spikes;
 *  'round' is the literal reading of "distance from the edge" — every point exactly d away. */
export const STROKE_JOINS = ['sharp', 'round'] as const
export type StrokeJoin = typeof STROKE_JOINS[number]

/** A continuous band, or library shapes marching along the edge. */
export const STROKE_STYLES = ['band', 'shapes'] as const
export type StrokeStyle = typeof STROKE_STYLES[number]

export interface ShapeStrokeSpec {
  /** An id from lib/shapes/catalog. */
  shapeId: string
  /** Same units as `width`: normalized to canvas width, or a path layer's local units. */
  size: number
  /** Centre-to-centre along the edge, same units as `size`. */
  spacing: number
  /** true (default): each mark rotates to the tangent. false: all upright. */
  follow?: boolean
}

export interface StrokeInstance {
  id: string
  /** Absent ⇒ visible, the same convention as EffectInstance. */
  visible?: boolean
  paint: Paint
  /** Normalized to canvas width; a path layer stores local units at scale 1, as today. */
  width: number
  /** How far the band's REFERENCE EDGE sits from the shape's own edge, same units as
   *  `width`. 0 = the shape's edge, i.e. exactly today. Positive out, negative in. */
  distance?: number
  align?: StrokeAlign
  dash?: StrokeDash
  join?: StrokeJoin
  style?: StrokeStyle
  shapes?: ShapeStrokeSpec
}

/** The kinds whose stroke can become a list. A line has no interior to offset from, so it
 *  keeps its single stroke — it still READS through this module, so the painter has no
 *  special case, but the tree offers it no plus-menu. */
const STACKABLE = new Set(['rect', 'ellipse', 'polygon', 'star', 'path', 'text'])
export function strokeSupportsStack(kind: string): boolean { return STACKABLE.has(kind) }

/** Marching shapes need an exact path to flatten. The Frame's text layer stores only a CSS
 *  family name — it has no glyph outlines — so text is band-only. See the spec's "text limit". */
const SHAPEABLE = new Set(['rect', 'ellipse', 'polygon', 'star', 'path'])
export function strokeSupportsShapes(kind: string): boolean { return SHAPEABLE.has(kind) }

let _seq = 0
export function newStrokeId(): string { return `st${Date.now().toString(36)}${(_seq++).toString(36)}` }

/** A fresh stroke: on the edge, centred, 6 px on a 1200-wide frame. */
export function createStroke(): StrokeInstance {
  return { id: newStrokeId(), paint: '#ffffff', width: 0.005, distance: 0, align: 'center', join: 'sharp', style: 'band' }
}

interface StrokeHost {
  kind?: unknown
  strokes?: unknown
  stroke?: unknown
  strokeColor?: unknown
  strokeWidth?: unknown
  strokeAlign?: unknown
  strokeDash?: unknown
}

const hasInk = (p: unknown): boolean => {
  if (typeof p === 'string') return p !== '' && p !== 'none'
  return !!p && typeof p === 'object'
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** THE reader. Every consumer goes through this — the painter, the pad helper, the SVG
 *  writer, the agent and the inspector — so they cannot disagree about what a layer's
 *  strokes are. */
export function strokeStackOf(layer: StrokeHost | null | undefined): StrokeInstance[] {
  if (!layer) return []
  const raw = Array.isArray(layer.strokes) ? layer.strokes : []
  const known = raw.filter(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
      && (s as { id: string }).id !== '' && hasInk((s as { paint?: unknown }).paint),
  )
  const allIded = known.length > 0 && known.length === raw.length
  // A new-shape layer that ALSO carries a live legacy stroke can only come from an older
  // build editing a newer document; the legacy field is the one with a trustworthy meaning,
  // so it falls through. Same decision effectStackOf makes for tornEdge/feather.
  const legacyPaint = layer.kind === 'text' ? layer.strokeColor : layer.stroke
  const legacyLive = hasInk(legacyPaint) && num(layer.strokeWidth) > 0
  if (allIded && !legacyLive) {
    return known.map(s => ({ ...s, visible: s.visible !== false })) as unknown as StrokeInstance[]
  }
  if (!legacyLive) return []
  const one: StrokeInstance = {
    id: 'legacy',
    visible: true,
    paint: legacyPaint as Paint,
    width: num(layer.strokeWidth),
    distance: 0,
    style: 'band',
  }
  if (layer.strokeAlign === 'inside' || layer.strokeAlign === 'outside') one.align = layer.strokeAlign
  const d = layer.strokeDash as StrokeDash | undefined
  if (d && typeof d === 'object' && num(d.dash) > 0) one.dash = { dash: num(d.dash), gap: num(d.gap) }
  return [one]
}

/** The patch that stores a stack. Every legacy field is cleared in the SAME patch, so a
 *  layer can never carry both shapes and fall into the legacy branch on the next read. */
export function writeStrokeStackToLayer(stack: StrokeInstance[]): {
  strokes: StrokeInstance[]
  stroke: undefined; strokeColor: undefined; strokeWidth: undefined
  strokeAlign: undefined; strokeDash: undefined
} {
  return {
    strokes: stack,
    stroke: undefined, strokeColor: undefined, strokeWidth: undefined,
    strokeAlign: undefined, strokeDash: undefined,
  }
}

/** Appended, so a new stroke paints UNDER the existing ones — adding one never changes
 *  what you already see. */
export function addStroke(stack: StrokeInstance[]): StrokeInstance[] {
  return [...stack, createStroke()]
}

export function removeStroke(stack: StrokeInstance[], id: string): StrokeInstance[] {
  const next = stack.filter(s => s.id !== id)
  return next.length === stack.length ? stack : next
}

/** A copy directly after the original with a fresh id. Deep-cloned: a shallow copy would
 *  share the original's nested `dash` / `shapes` objects with its duplicate. */
export function duplicateStroke(stack: StrokeInstance[], id: string): StrokeInstance[] {
  const i = stack.findIndex(s => s.id === id)
  if (i === -1) return stack
  const copy = { ...(JSON.parse(JSON.stringify(stack[i]!)) as StrokeInstance), id: newStrokeId() }
  return [...stack.slice(0, i + 1), copy, ...stack.slice(i + 1)]
}

export function canReorderStroke(stack: StrokeInstance[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  return stack.some(s => s.id === fromId) && stack.some(s => s.id === toId)
}

export function reorderStroke(stack: StrokeInstance[], fromId: string, toId: string): StrokeInstance[] {
  if (!canReorderStroke(stack, fromId, toId)) return stack
  const next = [...stack]
  const from = next.findIndex(s => s.id === fromId)
  // `to` MUST be read before the splice below. Reading it after — against the already
  // shortened array — yields a stale index that silently undoes a forward drag. This is
  // the exact bug the effect stack's own tests caught in its plan's reference code.
  const to = next.findIndex(s => s.id === toId)
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** The tree row's label. Sentence case, no internal identifiers (house rule). */
export function strokeRowLabel(stroke: StrokeInstance, W: number): string {
  if ((stroke.style ?? 'band') === 'shapes' && stroke.shapes) {
    const id = stroke.shapes.shapeId
    return id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ') : 'Shapes'
  }
  const px = Math.round(stroke.width * W)
  const d = Math.round(num(stroke.distance) * W)
  if (d > 0) return `${px} px, ${d} px out`
  if (d < 0) return `${px} px, ${-d} px in`
  return `${px} px`
}
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-stack.unit.spec.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 6: Mutation-check the reorder test**

Temporarily move the `const to = …` line to AFTER the `splice(from, 1)` and re-run. The forward-drag case must FAIL. Restore the line. A reorder test that cannot fail is worthless — this codebase has shipped two of them.

- [ ] **Step 7: Typecheck and commit**

```bash
cd frontend && npm run typecheck
```

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/app/lib/compositor/strokeStack.ts frontend/tests/unit/compositor-stroke-stack.unit.spec.ts
git commit -F - -- frontend/app/lib/compositor/strokeStack.ts frontend/tests/unit/compositor-stroke-stack.unit.spec.ts <<'MSG'
feat(frame): a layer's strokes as an ordered list, read through from the legacy fields

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 2: `paintStrokeBand` — one painter, with a distance

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (add beside `strokeAligned`, around line 2183)
- Test: `frontend/tests/unit/compositor-stroke-band.unit.spec.ts`

**Interfaces:**
- Consumes: `StrokeAlign`, `StrokeJoin` from Task 1's module; the file-private `scratchLike` (line 2107) and `stampScratch` (line 2122).
- Produces:
  ```ts
  export function paintStrokeBand(ctx: CanvasRenderingContext2D, o: {
    width: number
    distance?: number
    style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
    align?: StrokeAlign
    join?: StrokeJoin
    dash?: [number, number] | null
    path?: Path2D | null
    fillRule?: CanvasFillRule
    build?: (c: CanvasRenderingContext2D) => void
  }): void
  ```
  `strokeAligned` stays exported with its current signature, as a `distance: 0` wrapper, so its existing tests keep guarding the legacy path.

- [ ] **Step 1: Read the existing painter and its tests**

Read `frontend/app/composables/useCompositorLayers.ts` lines 2100–2230 (`scratchLike`, `stampScratch`, `strokeAligned`) and `frontend/tests/unit/compositor-stroke-style.unit.spec.ts` lines 88–330 — the recording fake context, `makeCtx`, and the existing "destination-out must not touch the shared ctx" case. Your new tests use that same harness.

- [ ] **Step 2: Write the failing test**

Create `frontend/tests/unit/compositor-stroke-band.unit.spec.ts`.

**Superseded during execution — do not copy the harness.** The recording context lives file-private in `compositor-stroke-style.unit.spec.ts`. EXTRACT it into a shared `frontend/tests/unit/_strokeCtx.ts` that both suites import; duplicating a logic block is a review defect, and `tests/_helpers.ts` is the existing precedent for shared test utilities. The pre-existing suite must stay green through the move — if it goes red, fix the extraction, never the assertions.

The harness is an ink-replay `Recorder`, NOT the property-recording `calls()`/`scratches()` shape sketched in the test below; that shape does not exist in this repo. Adapt the assertions to the real recorder and keep the algorithm as written.

```ts
import { describe, it, expect } from 'vitest'
import { paintStrokeBand } from '~/composables/useCompositorLayers'
// … the recording-ctx harness, copied from compositor-stroke-style.unit.spec.ts …

describe('paintStrokeBand at distance 0', () => {
  it('emits exactly the centred stroke the legacy painter emitted', () => {
    const { ctx, calls } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, style: () => '#f00' })
    expect(calls()).toEqual([
      { op: 'set', k: 'lineWidth', v: 10 },
      { op: 'set', k: 'strokeStyle', v: '#f00' },
      { op: 'stroke' },
    ])
  })

  it('clips and doubles for inside, exactly as before', () => {
    const { ctx, calls } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, style: () => '#f00', align: 'inside' })
    expect(calls().map(c => c.op)).toEqual(['save', 'clip', 'set', 'set', 'stroke', 'restore'])
    expect(calls().find(c => c.k === 'lineWidth')!.v).toBe(20)
  })

  it('never runs destination-out on the shared context', () => {
    const { ctx, calls } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, style: () => '#f00', align: 'outside', build: () => {} })
    expect(calls().some(c => c.k === 'globalCompositeOperation' && c.v === 'destination-out')).toBe(false)
  })
})

describe('paintStrokeBand at a distance', () => {
  it('draws the two dilations on a SCRATCH canvas and stamps once', () => {
    const { ctx, calls, scratches } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, distance: 30, style: () => '#f00', build: () => {} })
    // Nothing but the stamp lands on the shared context.
    expect(calls().some(c => c.op === 'stroke')).toBe(false)
    expect(calls().some(c => c.op === 'drawImage')).toBe(true)
    const s = scratches()[0]!
    // Outer dilation then inner knockout: centre alignment ⇒ radii 35 and 25 ⇒ 2× each.
    const widths = s.calls().filter(c => c.k === 'lineWidth').map(c => c.v)
    expect(widths).toEqual([70, 50])
    expect(s.calls().some(c => c.k === 'globalCompositeOperation' && c.v === 'destination-out')).toBe(true)
  })

  it('uses the alignment to pick the two radii', () => {
    const outer = (align: 'center' | 'inside' | 'outside') => {
      const { ctx, scratches } = makeCtx('main')
      paintStrokeBand(ctx, { width: 10, distance: 30, align, style: () => '#f00', build: () => {} })
      return scratches()[0]!.calls().filter(c => c.k === 'lineWidth').map(c => c.v)
    }
    expect(outer('center')).toEqual([70, 50])    // 35, 25
    expect(outer('outside')).toEqual([80, 60])   // 40, 30
    expect(outer('inside')).toEqual([60, 40])    // 30, 20
  })

  it('sets the corner join from `join`, defaulting to miter', () => {
    const joins = (join?: 'sharp' | 'round') => {
      const { ctx, scratches } = makeCtx('main')
      paintStrokeBand(ctx, { width: 10, distance: 30, join, style: () => '#f00', build: () => {} })
      return scratches()[0]!.calls().filter(c => c.k === 'lineJoin').map(c => c.v)
    }
    expect(joins()).toContain('miter')
    expect(joins('sharp')).toContain('miter')
    expect(joins('round')).toContain('round')
  })

  it('draws nothing at all for a zero or negative width', () => {
    const { ctx, calls } = makeCtx('main')
    paintStrokeBand(ctx, { width: 0, distance: 30, style: () => '#f00' })
    expect(calls()).toEqual([])
  })

  it('falls back to the centred stroke when no scratch canvas exists', () => {
    // A worker/SSR context with no document: knocking out on the shared ctx would eat
    // the layer's own fill and every backdrop pixel under it, so it must not try.
    const { ctx, calls } = makeCtxWithoutDocument('main')
    paintStrokeBand(ctx, { width: 10, distance: 30, style: () => '#f00' })
    expect(calls().some(c => c.k === 'globalCompositeOperation' && c.v === 'destination-out')).toBe(false)
    expect(calls().some(c => c.op === 'stroke')).toBe(true)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-band.unit.spec.ts
```

Expected: FAIL — `paintStrokeBand is not a function`.

- [ ] **Step 4: Implement the painter**

In `frontend/app/composables/useCompositorLayers.ts`, immediately above the existing `strokeAligned`:

```ts
/**
 * THE single place any outline is painted, at any distance from the shape's edge.
 *
 * `distance` moves the band's REFERENCE EDGE out (positive) or in (negative) from the
 * shape's own edge; `align` then says how the band of `width` straddles that reference,
 * exactly as it always has. So `distance = 0` reduces to the statements `strokeAligned`
 * ran before this existed, and an untouched frame is byte-identical.
 *
 * At a non-zero distance the band is the difference of two canvas DILATIONS. Canvas gives
 * a dilation directly: `fill(path)` together with `stroke(path, 2r)` is the shape grown by
 * `r`, with `lineJoin` deciding the corners. So:
 *
 *     band = dilate(shape, outer) minus dilate(shape, inner)
 *
 * A negative radius is an EROSION, which is the same construction reflected: fill the
 * shape, then knock out a centred stroke at `2|r|`.
 *
 * The knockout MUST happen on a scratch canvas. A `destination-out` on `ctx` would eat the
 * layer's own fill and every backdrop pixel under the shape — the Critical this feature can
 * cause, and the reason there is a test asserting the shared context never sees one.
 */
export function paintStrokeBand(ctx: CanvasRenderingContext2D, o: {
  width: number
  distance?: number
  style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
  align?: StrokeAlign
  join?: StrokeJoin
  dash?: [number, number] | null
  path?: Path2D | null
  fillRule?: CanvasFillRule
  build?: (c: CanvasRenderingContext2D) => void
}) {
  if (!(o.width > 0)) return
  const d = typeof o.distance === 'number' && Number.isFinite(o.distance) ? o.distance : 0
  if (d === 0) { strokeAligned(ctx, o); return }

  const align = strokeAlignOf(o.align)
  // The band's two radii, measured from the shape's own edge.
  const outer = align === 'outside' ? d + o.width : align === 'inside' ? d : d + o.width / 2
  const inner = align === 'outside' ? d : align === 'inside' ? d - o.width : d - o.width / 2
  if (outer <= inner) return

  const s = scratchLike(ctx)
  if (!s) { strokeAligned(ctx, o); return }   // no knockout on the shared ctx, ever
  if (o.build) o.build(s)
  s.lineJoin = o.join === 'round' ? 'round' : 'miter'
  const rule = o.fillRule || 'nonzero'
  const region = (c: CanvasRenderingContext2D, r: number) => {
    // r > 0 grows the shape; r < 0 shrinks it; r == 0 is the shape itself.
    if (o.path) c.fill(o.path, rule); else c.fill(rule)
    if (r === 0) return
    c.lineWidth = Math.abs(r) * 2
    if (r > 0) {
      c.strokeStyle = '#000'
      if (o.path) c.stroke(o.path); else c.stroke()
    } else {
      const prev = c.globalCompositeOperation
      c.globalCompositeOperation = 'destination-out'
      c.strokeStyle = '#000'
      if (o.path) c.stroke(o.path); else c.stroke()
      c.globalCompositeOperation = prev
    }
  }
  region(s, outer)
  const knock = scratchLike(ctx)
  if (knock) {
    if (o.build) o.build(knock)
    knock.lineJoin = s.lineJoin
    region(knock, inner)
    s.globalCompositeOperation = 'destination-out'
    s.setTransform(1, 0, 0, 1, 0, 0)
    s.drawImage(knock.canvas, 0, 0)
    s.setTransform(ctx.getTransform())
    s.globalCompositeOperation = 'source-over'
  }
  // Paint the band's colour through the mask we just built.
  s.globalCompositeOperation = 'source-in'
  s.fillStyle = o.style(s)
  s.setTransform(1, 0, 0, 1, 0, 0)
  s.fillRect(0, 0, s.canvas.width, s.canvas.height)
  s.setTransform(ctx.getTransform())
  s.globalCompositeOperation = 'source-over'
  stampScratch(ctx, s)
}
```

Note on `dash` at a distance: a dashed offset band is not expressible by this construction (the dash would have to run along the offset curve, which is not a path here). `paintStrokeBand` ignores `o.dash` when `d !== 0`; the inspector hides the Dash row for a stroke with a distance, which Task 9 wires. Add that as a comment on the function.

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-band.unit.spec.ts tests/unit/compositor-stroke-style.unit.spec.ts
```

Expected: PASS. **The existing `compositor-stroke-style` suite must stay green untouched** — it is the legacy path's guard.

- [ ] **Step 6: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/compositor-stroke-band.unit.spec.ts
git commit -F - -- frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/compositor-stroke-band.unit.spec.ts <<'MSG'
feat(frame): paintStrokeBand — an outline at any distance from the edge

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 3: Route every stroked kind through the stack, and prove byte-identity

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` — `drawLayerContent` (rect, ellipse, polygon/star arms), `drawPath`, `drawText`, `outsideStrokePadPx`
- Test: `frontend/tests/compositor-multi-stroke.spec.ts` (create; the byte-identity case only — later tasks add to it)

**Interfaces:**
- Consumes: `strokeStackOf`, `strokeSupportsStack` (Task 1); `paintStrokeBand` (Task 2).
- Produces: every stroked kind painting `strokeStackOf(layer)` in order; `outsideStrokePadPx` reading the stack.

- [ ] **Step 1: Replace each single-stroke block with a stack loop**

For rect (and identically for ellipse), replace:

```ts
    if (hasPaint(layer.stroke) && layer.strokeWidth > 0) {
      strokeAligned(ctx, {
        width: layer.strokeWidth * W,
        style: (c) => resolvePaint(c, layer.stroke, { w, h }, _fieldCtx),
        align: layer.strokeAlign, dash: strokeDashSegments(layer.strokeDash, W), build,
      })
    }
```

with:

```ts
    // Painted in REVERSE list order so the first row lands on top, matching the layer
    // list's own convention. A stack read through from a legacy field is one entry, so
    // this loop is byte-identical to the single call it replaces.
    const stack = strokeStackOf(layer)
    for (let i = stack.length - 1; i >= 0; i--) {
      const st = stack[i]!
      if (st.visible === false || !hasPaint(st.paint) || !(st.width > 0)) continue
      build(ctx)
      paintStrokeBand(ctx, {
        width: st.width * W,
        distance: (st.distance ?? 0) * W,
        style: (c) => resolvePaint(c, st.paint, { w, h }, _fieldCtx),
        align: st.align, join: st.join, dash: strokeDashSegments(st.dash, W), build,
      })
    }
```

`build(ctx)` is re-run per stroke because `paintStrokeBand`'s centred path consumes the current path on `ctx`.

For polygon and star, which delegate to `drawPath`, pass `strokes: layer.strokes` through in the object literal alongside the existing `stroke` / `strokeWidth` / `strokeAlign` / `strokeDash` so `drawPath`'s own `strokeStackOf` sees the same list.

For `drawPath`, the same loop, remembering a path's units: `st.width * scale * W` and `(st.distance ?? 0) * scale * W`, where `scale` is the layer's uniform scale — exactly the factor the existing code already applies to `strokeWidth`.

For `drawText`, the same loop against `strokeStackOf(layer)` (which reads `strokeColor` for a text layer), with `build` being the `strokeText`/`fillText` pair.

- [ ] **Step 2: Widen the offscreen pad**

Replace `outsideStrokePadPx`'s body:

```ts
export function outsideStrokePadPx(layer: LocalLayer, W: number): number {
  if (!strokeSupportsStack(layer.kind) || layer.kind === 'text') return 0
  const scale = layer.kind === 'path' ? ((layer as PathLayer).scale ?? 1) : 1
  let pad = 0
  for (const st of strokeStackOf(layer as unknown as Parameters<typeof strokeStackOf>[0])) {
    if (st.visible === false || !hasPaint(st.paint) || !(st.width > 0)) continue
    const d = st.distance ?? 0
    const align = strokeAlignOf(st.align)
    // How far this stroke's OUTER edge reaches beyond the silhouette.
    const reach = align === 'outside' ? d + st.width : align === 'inside' ? d : d + st.width / 2
    if (reach > pad) pad = reach
  }
  return Math.max(0, pad) * scale * W
}
```

**This is a behaviour change for centre-aligned strokes** — they used to return 0 and now return half a width. That is the correct answer (a centred stroke does reach half a width beyond the box), and it only ever makes an offscreen larger, so nothing is clipped that was not clipped before. Update the existing `outsideStrokePadPx` cases in `compositor-stroke-style.unit.spec.ts` that assert 0 for centre, changing the expectation and adding a comment saying why — **do not** weaken the "0 for no stroke" and "0 for zero width" cases.

- [ ] **Step 3: Run every unit suite that touches this file**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-style.unit.spec.ts tests/unit/compositor-stroke-band.unit.spec.ts tests/unit/compositor-stroke-stack.unit.spec.ts tests/unit/compositor-effect-passes.unit.spec.ts tests/unit/layer-mask-composite.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Write the byte-identity browser test**

Create `frontend/tests/compositor-multi-stroke.spec.ts`. `openCompositor` and `stackPixels` are file-private in `tests/compositor-layer-effects.spec.ts` — **extract them into `tests/_helpers.ts`** (which that suite already imports from) and have both suites use them, rather than copying. Same reasoning as Task 2's harness.

```ts
/**
 * The load-bearing case. Every stroked kind, stored in TODAY'S single-stroke shape, must
 * render the same pixels through the stack painter as it did through the single call. This
 * is what protects every saved frame, and no screenshot can argue with it.
 */
const LEGACY_LAYERS = [
  { kind: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.15, fill: '#3b82f6', stroke: '#ff0000', strokeWidth: 0.01, radius: 0.02 },
  { kind: 'rect', x: 0.5, y: 0.2, w: 0.2, h: 0.15, fill: '#f59e0b', stroke: '#000', strokeWidth: 0.012, strokeAlign: 'outside', radius: 0 },
  { kind: 'rect', x: 0.8, y: 0.2, w: 0.15, h: 0.15, fill: '#22c55e', stroke: '#fff', strokeWidth: 0.012, strokeAlign: 'inside', radius: 0.04 },
  { kind: 'ellipse', x: 0.2, y: 0.5, w: 0.18, h: 0.18, fill: '#ef4444', stroke: '#fff', strokeWidth: 0.008 },
  { kind: 'ellipse', x: 0.45, y: 0.5, w: 0.18, h: 0.12, fill: 'none', stroke: '#0ff', strokeWidth: 0.01, strokeDash: { dash: 0.02, gap: 0.012 } },
  { kind: 'polygon', x: 0.7, y: 0.5, w: 0.16, h: 0.16, sides: 6, fill: '#a855f7', stroke: '#fff', strokeWidth: 0.01, cornerRadius: 0 },
  { kind: 'star', x: 0.9, y: 0.5, w: 0.16, h: 0.16, points: 5, innerRatio: 0.5, fill: '#fde047', stroke: '#000', strokeWidth: 0.008, cornerRadius: 0 },
  { kind: 'path', x: 0.25, y: 0.8, d: 'M -0.1 -0.05 L 0.1 -0.05 L 0 0.08 Z', bbox: { w: 0.2, h: 0.13 }, scale: 1, fill: '#06b6d4', fillRule: 'nonzero', stroke: '#fff', strokeWidth: 0.006 },
  { kind: 'path', x: 0.5, y: 0.8, d: 'M -0.1 -0.05 L 0.1 -0.05 L 0 0.08 Z', bbox: { w: 0.2, h: 0.13 }, scale: 1.8, fill: 'none', fillRule: 'nonzero', stroke: '#f0f', strokeWidth: 0.006, strokeAlign: 'outside' },
  { kind: 'text', x: 0.78, y: 0.8, text: 'Edge', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.07, color: '#ffffff', align: 'center', lineHeight: 1.1, strokeColor: '#ff0000', strokeWidth: 0.004 },
  { kind: 'line', x: 0.5, y: 0.95, w: 0.6, stroke: '#fff', strokeWidth: 0.004, strokeDash: { dash: 0.02, gap: 0.01 } },
  { kind: 'rect', x: 0.35, y: 0.35, w: 0.2, h: 0.2, fill: '#111', stroke: 'none', strokeWidth: 0, radius: 0 },
  { kind: 'ellipse', x: 0.6, y: 0.35, w: 0.14, h: 0.14, fill: '#eee', stroke: '#333', strokeWidth: 0 },
  { kind: 'rect', x: 0.1, y: 0.65, w: 0.1, h: 0.1, fill: 'none', stroke: { type: 'gradient', stops: [{ color: '#f00', offset: 0 }, { color: '#00f', offset: 1 }], angle: 45 }, strokeWidth: 0.014, radius: 0 },
]

test('every legacy stroked layer renders identically through the stack painter', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(
    ls.map((l, i) => ({ ...l, id: `l${i}`, opacity: 1, rotation: 0, visible: true }))), LEGACY_LAYERS)
  const after = await stackPixels(page)
  // The BASELINE is committed alongside this test, produced by running it once against the
  // pre-stack painter. Regenerating it is a deliberate act, never a fix for a red run.
  const baseline = readFileSync(new URL('./fixtures/multi-stroke-legacy.txt', import.meta.url), 'utf8').trim()
  expect(after).toBe(baseline)
})
```

To produce the baseline: `git stash` is forbidden here (shared stack) — instead check out the pre-Task-3 file into a scratch path, run the test with the painter reverted **in a separate throwaway copy of the file**, capture the data URL, and write it to `frontend/tests/fixtures/multi-stroke-legacy.txt`. Concretely:

```bash
cd /Users/julien/Documents/GitHub/Sailor
git show HEAD~1:frontend/app/composables/useCompositorLayers.ts > /tmp/pre.ts
cp frontend/app/composables/useCompositorLayers.ts /tmp/post.ts
cp /tmp/pre.ts frontend/app/composables/useCompositorLayers.ts
cd frontend && npx playwright test tests/compositor-multi-stroke.spec.ts --grep "identically" --reporter=line || true
# the test writes the captured URL to tests/fixtures/multi-stroke-legacy.txt on its first run
cd .. && cp /tmp/post.ts frontend/app/composables/useCompositorLayers.ts
```

Have the test write the fixture when it is missing, and compare when it exists.

- [ ] **Step 5: Run it RED first**

Before running it green, break `paintStrokeBand` deliberately — add `+ 1` to the centred `lineWidth` — and confirm the test FAILS. A byte-identity test that cannot fail is the single most expensive kind of false comfort in this repo. Restore.

- [ ] **Step 6: Run it green**

```bash
cd frontend && npx playwright test tests/compositor-multi-stroke.spec.ts --reporter=line
```

Expected: PASS, 0 px different.

- [ ] **Step 7: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/app/composables/useCompositorLayers.ts frontend/tests/compositor-multi-stroke.spec.ts frontend/tests/fixtures/multi-stroke-legacy.txt frontend/tests/unit/compositor-stroke-style.unit.spec.ts
git commit -F - -- frontend/app/composables/useCompositorLayers.ts frontend/tests/compositor-multi-stroke.spec.ts frontend/tests/fixtures/multi-stroke-legacy.txt frontend/tests/unit/compositor-stroke-style.unit.spec.ts <<'MSG'
feat(frame): every stroked kind paints its stroke stack; legacy frames byte-identical

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 4: Distance and order, measured in a real browser

**Files:**
- Modify: `frontend/tests/compositor-multi-stroke.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Produces no new module surface — this task exists because a dial that stores its value without reaching a pixel is this codebase's most common defect, and only pixels disprove it.

- [ ] **Step 1: Write the measured-distance test**

```ts
/** The colour of the pixel at (x, y) in the settled stack canvas, as [r,g,b,a]. */
async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(({ x, y }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(Math.round(x * cv.width), Math.round(y * cv.height), 1, 1).data
    return [d[0]!, d[1]!, d[2]!, d[3]!]
  }, { x, y })
}

test('a stroke at a distance sits that far from the edge, on every side', async ({ page }) => {
  await openCompositor(page)
  // A black square, 0.4 wide, centred. One red stroke, 0.01 wide, 0.05 out.
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: 0.05, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  // The square's right edge is at 0.7. The band's centre must be at 0.75, and there must
  // be clean air between the shape and the band.
  expect(isRed(await pixelAt(page, 0.75, 0.5))).toBe(true)
  expect(isRed(await pixelAt(page, 0.72, 0.5))).toBe(false)   // the gap
  expect(isRed(await pixelAt(page, 0.79, 0.5))).toBe(false)   // beyond the band
  // Same distance on the top edge — this is what a scale-instead-of-offset would get wrong,
  // and on a square it would not; the non-square case below is the one that catches it.
  expect(isRed(await pixelAt(page, 0.5, 0.25))).toBe(true)
})

test('the distance is uniform on a NON-square shape — an offset, not a scale', async ({ page }) => {
  await openCompositor(page)
  // 0.6 wide, 0.2 tall. A scale-based fake would put the horizontal gap 3× the vertical one.
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.6, h: 0.2, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: 0.05, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  expect(isRed(await pixelAt(page, 0.85, 0.5))).toBe(true)     // right: edge 0.8 + 0.05
  expect(isRed(await pixelAt(page, 0.82, 0.5))).toBe(false)
  // The frame is square in normalized units for both axes here, so the vertical edge sits
  // at 0.5 + 0.1 = 0.6 and the band centre at 0.65.
  expect(isRed(await pixelAt(page, 0.5, 0.65))).toBe(true)
  expect(isRed(await pixelAt(page, 0.5, 0.62))).toBe(false)
})

test('a negative distance puts the stroke inside the shape', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: -0.05, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  expect(isRed(await pixelAt(page, 0.65, 0.5))).toBe(true)     // edge 0.7 minus 0.05
  expect(isRed(await pixelAt(page, 0.69, 0.5))).toBe(false)
})

test('the first stroke in the list paints on top', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, rotation: 0, opacity: 1, visible: true,
    fill: 'none', radius: 0,
    strokes: [
      { id: 'top', paint: '#ff0000', width: 0.01, distance: 0, align: 'center' },
      { id: 'under', paint: '#0000ff', width: 0.04, distance: 0, align: 'center' },
    ],
  }]))
  await stackPixels(page)
  const p = await pixelAt(page, 0.65, 0.5)   // on the shared edge
  expect(p[0]!).toBeGreaterThan(200)          // red, not blue
  expect(p[2]!).toBeLessThan(60)
})

test('a hidden stroke paints nothing', async ({ page }) => { /* same shape, visible: false, assert no red */ })
```

- [ ] **Step 2: Run them RED first**

Set `distance` to `0` inside `paintStrokeBand` (ignore the caller's value) and confirm the four distance tests FAIL. Restore. Then set the paint loop to forward order and confirm the ordering test FAILS. Restore.

- [ ] **Step 3: Run green**

```bash
cd frontend && npx playwright test tests/compositor-multi-stroke.spec.ts --reporter=line
```

- [ ] **Step 4: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/tests/compositor-multi-stroke.spec.ts
git commit -F - -- frontend/tests/compositor-multi-stroke.spec.ts <<'MSG'
test(frame): the distance dial reaches the pixels, on every side and both signs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 5: Offset polyline and arc-length placement

**Files:**
- Create: `frontend/app/lib/compositor/strokeShapes.ts`
- Test: `frontend/tests/unit/compositor-stroke-shapes.unit.spec.ts`

**Interfaces:**
- Consumes: `FlatPoint`, `FlatSubpath`, `flattenPath`, `longestSubpath` from `~/lib/compositor/pathFlatten`; `Guide`, `guideFromPolyline` from `~/lib/compositor/textPath`.
- Produces:
  ```ts
  export function offsetPolyline(pts: readonly FlatPoint[], closed: boolean, distance: number): FlatPoint[]
  export interface ShapePlacement { x: number; y: number; angle: number }
  export function shapePlacements(guide: Guide, spacing: number): ShapePlacement[]
  export function shapeStrokeGuide(d: string, distance: number, tolerance?: number): Guide | null
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { offsetPolyline, shapePlacements, shapeStrokeGuide } from '~/lib/compositor/strokeShapes'
import { guideFromPolyline } from '~/lib/compositor/textPath'

describe('offsetPolyline', () => {
  it('returns the points unchanged at distance 0', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    expect(offsetPolyline(sq, true, 0)).toEqual(sq)
  })

  it('grows a closed square outward by the distance at every corner', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const out = offsetPolyline(sq, true, 0.5)
    // A square offset outward by 0.5 is the square of half-extent 1.5. Corners are mitred,
    // so each vertex moves along its diagonal to exactly (±1.5, ±1.5).
    for (const p of out) {
      expect(Math.abs(p.x)).toBeCloseTo(1.5, 6)
      expect(Math.abs(p.y)).toBeCloseTo(1.5, 6)
    }
  })

  it('shrinks on a negative distance', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    for (const p of offsetPolyline(sq, true, -0.25)) {
      expect(Math.abs(p.x)).toBeCloseTo(0.75, 6)
      expect(Math.abs(p.y)).toBeCloseTo(0.75, 6)
    }
  })

  it('keeps winding-independence — a reversed square still grows outward', () => {
    const cw = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const ccw = [...cw].reverse()
    const a = offsetPolyline(cw, true, 0.5)
    const b = offsetPolyline(ccw, true, 0.5)
    const extent = (ps: { x: number; y: number }[]) => Math.max(...ps.map(p => Math.abs(p.x)))
    expect(extent(a)).toBeCloseTo(1.5, 6)
    expect(extent(b)).toBeCloseTo(1.5, 6)
  })

  it('offsets an OPEN polyline along its segment normals without closing it', () => {
    const line = [{ x: 0, y: 0 }, { x: 2, y: 0 }]
    const out = offsetPolyline(line, false, 1)
    expect(out).toHaveLength(2)
    expect(out.every(p => Math.abs(p.y) === 1)).toBe(true)
  })

  it('drops degenerate input rather than emitting NaN', () => {
    expect(offsetPolyline([{ x: 0, y: 0 }], true, 1)).toEqual([])
    expect(offsetPolyline([{ x: 0, y: 0 }, { x: 0, y: 0 }], true, 1)).toEqual([])
  })
})

describe('shapePlacements', () => {
  it('spreads marks evenly and closes without an overlap at the seam', () => {
    // A closed square of side 2 → perimeter 8. Spacing 1 → exactly 8 marks.
    const g = guideFromPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true)!
    const marks = shapePlacements(g, 1)
    expect(marks).toHaveLength(8)
    const first = marks[0]!, last = marks[7]!
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(0.5)
  })

  it('rounds the count so an indivisible spacing has no seam gap', () => {
    const g = guideFromPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true)!
    // perimeter 8, spacing 0.7 → round(11.43) = 11 marks, actual step 8/11.
    const marks = shapePlacements(g, 0.7)
    expect(marks).toHaveLength(11)
  })

  it('returns nothing for a non-positive or absurdly small spacing', () => {
    const g = guideFromPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true)!
    expect(shapePlacements(g, 0)).toEqual([])
    expect(shapePlacements(g, -1)).toEqual([])
    // A spacing that would ask for more than the cap yields the cap, not a hang.
    expect(shapePlacements(g, 1e-6).length).toBeLessThanOrEqual(2000)
  })

  it('carries the tangent angle so a mark can turn with the edge', () => {
    const g = guideFromPolyline([{ x: -1, y: 0 }, { x: 1, y: 0 }], false)!
    const [m] = shapePlacements(g, 1)
    expect(m!.angle).toBeCloseTo(0, 6)
  })
})

describe('shapeStrokeGuide', () => {
  it('builds a closed guide from a path string at a distance', () => {
    const g = shapeStrokeGuide('M -1 -1 L 1 -1 L 1 1 L -1 1 Z', 0)!
    expect(g).toBeTruthy()
    expect(g.closed).toBe(true)
    expect(g.length).toBeCloseTo(8, 3)
    const grown = shapeStrokeGuide('M -1 -1 L 1 -1 L 1 1 L -1 1 Z', 0.5)!
    expect(grown.length).toBeCloseTo(12, 3)   // side 3 → perimeter 12
  })

  it('is null for an empty or unparseable path rather than throwing', () => {
    expect(shapeStrokeGuide('', 0)).toBeNull()
    expect(shapeStrokeGuide('not a path', 0)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-shapes.unit.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
/**
 * Geometry for a SHAPES stroke: library shapes marching along a shape's edge.
 *
 * Two pure steps, both testable as data:
 *   1. offset the flattened outline as a POLYLINE (each vertex along its angle bisector) —
 *      the easy half of the offset problem. Offsetting a bezier path is the hard half, the
 *      one `lib/vectortype/extrude.ts` says out loud that paper 0.12 cannot do.
 *   2. walk the resulting `Guide` by arc length, placing a mark every `spacing`.
 *
 * Nothing here draws. The painter decides what a mark looks like.
 */
import { type FlatPoint, flattenPath, longestSubpath } from '~/lib/compositor/pathFlatten'
import { type Guide, guideFromPolyline } from '~/lib/compositor/textPath'

/** A hard ceiling on marks per stroke. A spacing near zero would otherwise ask for
 *  millions and hang the draw loop; the cap turns a bad dial into a dense ring. */
export const SHAPE_STROKE_MAX_MARKS = 2000

const dedupe = (pts: readonly FlatPoint[]): FlatPoint[] => {
  const out: FlatPoint[] = []
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 1e-12 && Math.abs(last.y - p.y) < 1e-12) continue
    out.push({ x: p.x, y: p.y })
  }
  return out
}

/** Signed area × 2. Positive for counter-clockwise in a y-down space. */
function shoelace(pts: readonly FlatPoint[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!
    a += p.x * q.y - q.x * p.y
  }
  return a
}

/**
 * Move every vertex along its angle bisector by `distance`, outward for a positive value.
 *
 * OUTWARD is defined by the polygon's own winding for a closed ring, so a shape authored
 * clockwise and the same shape authored counter-clockwise both GROW — otherwise the same
 * dial would grow one library shape and shrink the next, which is exactly the class of bug
 * the type-on-a-path work hit with path direction.
 *
 * Concave corners can self-cross at a large distance; that is a known and accepted limit
 * (the spec says to measure where it starts rather than pre-build a cleanup pass).
 */
export function offsetPolyline(pts: readonly FlatPoint[], closed: boolean, distance: number): FlatPoint[] {
  const src = dedupe(pts)
  if (src.length < 2) return []
  if (!Number.isFinite(distance) || distance === 0) return src
  const n = src.length
  const sign = closed && shoelace(src) < 0 ? -1 : 1
  const out: FlatPoint[] = []
  for (let i = 0; i < n; i++) {
    const prev = src[(i - 1 + n) % n]!, cur = src[i]!, next = src[(i + 1) % n]!
    // Segment normals either side of this vertex (y-down space: left normal of (dx,dy) is (dy,-dx)).
    const nrm = (a: FlatPoint, b: FlatPoint) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      return { x: dy / len, y: -dx / len }
    }
    let nx = 0, ny = 0
    const hasPrev = closed || i > 0
    const hasNext = closed || i < n - 1
    if (hasPrev) { const m = nrm(prev, cur); nx += m.x; ny += m.y }
    if (hasNext) { const m = nrm(cur, next); nx += m.x; ny += m.y }
    const len = Math.hypot(nx, ny)
    if (len < 1e-9) { out.push({ x: cur.x, y: cur.y }); continue }
    nx /= len; ny /= len
    // Miter length: the bisector must travel further than the offset at a sharp corner so
    // the two offset segments actually meet. Capped so a needle-thin spike cannot shoot off.
    let scale = 1
    if (hasPrev && hasNext) {
      const a = nrm(prev, cur), b = nrm(cur, next)
      const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))
      scale = Math.min(10, 1 / Math.max(0.1, Math.sqrt((1 + cos) / 2)))
    }
    const step = distance * sign * scale
    out.push({ x: cur.x + nx * step, y: cur.y + ny * step })
  }
  return out
}

export interface ShapePlacement { x: number; y: number; angle: number }

/**
 * Marks along a guide, every `spacing` of arc length.
 *
 * On a CLOSED guide the count is `round(length / spacing)` and the actual step is
 * `length / count`, so the last mark never lands on top of the first and there is no seam
 * gap — asking for a spacing the perimeter does not divide gives evenly spread marks at
 * close to the requested spacing.
 */
export function shapePlacements(guide: Guide, spacing: number): ShapePlacement[] {
  if (!(spacing > 0) || !(guide.length > 0)) return []
  const wanted = guide.closed
    ? Math.max(1, Math.round(guide.length / spacing))
    : Math.max(1, Math.floor(guide.length / spacing) + 1)
  const count = Math.min(wanted, SHAPE_STROKE_MAX_MARKS)
  const step = guide.closed ? guide.length / count : spacing
  const out: ShapePlacement[] = []
  for (let i = 0; i < count; i++) out.push(guide.at(i * step))
  return out
}

/** The guide a shapes stroke marches along: the layer's own outline, offset by `distance`.
 *  Only the LONGEST subpath is followed, so a shape with interior detail still runs its
 *  marks round the outline — the same rule type-on-a-path settled on. */
export function shapeStrokeGuide(d: string, distance: number, tolerance?: number): Guide | null {
  const sub = longestSubpath(d, tolerance ? { tolerance } : undefined)
  if (!sub) return null
  const pts = offsetPolyline(sub.pts, sub.closed, distance)
  if (pts.length < 2) return null
  return guideFromPolyline(pts, sub.closed)
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-shapes.unit.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Mutation-check the winding case**

Delete the `sign` term (`const sign = 1`) and re-run. The winding-independence test must FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/app/lib/compositor/strokeShapes.ts frontend/tests/unit/compositor-stroke-shapes.unit.spec.ts
git commit -F - -- frontend/app/lib/compositor/strokeShapes.ts frontend/tests/unit/compositor-stroke-shapes.unit.spec.ts <<'MSG'
feat(frame): offset a flattened outline and place marks along it by arc length

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 6: Paint the shapes stroke

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`
- Modify: `frontend/tests/compositor-multi-stroke.spec.ts`

**Interfaces:**
- Consumes: `shapeStrokeGuide`, `shapePlacements` (Task 5); `shapeById` from `~/lib/shapes/catalog`; `shapePath2D` from `~/lib/shapes/path2d`; `resolvePaint`.
- Produces: `paintShapeStroke(ctx, o)`, file-private, called from the stack loop when `style === 'shapes'`.

- [ ] **Step 1: Add a path-data accessor per kind**

The shapes stroke needs the layer's outline **as a path string**. Rect and ellipse do not have one. Add a file-private helper next to `drawLayerContent`:

```ts
/** A closed layer's outline as SVG path data in the SAME units the layer draws in (px for
 *  rect/ellipse/polygon/star, local units for a path). Null for a kind with no outline —
 *  which is what makes a shapes stroke unreachable on text, by construction rather than by
 *  a check somewhere in the UI. */
function outlinePathData(layer: LocalLayer, W: number): string | null {
  if (layer.kind === 'rect') {
    const w = layer.w * W, h = layer.h * W
    const [tl, tr, br, bl] = cornerRadii(layer.radius, w, h, W)
    return roundedRectPathData(-w / 2, -h / 2, w, h, tl, tr, br, bl)
  }
  if (layer.kind === 'ellipse') return ellipsePathData(layer.w * W / 2, layer.h * W / 2)
  if (layer.kind === 'polygon') return polygonPathData(layer.sides, layer.w * W, layer.h * W, layer.cornerRadius * W)
  if (layer.kind === 'star') return starPathData(layer.points, layer.innerRatio, layer.w * W, layer.h * W, layer.cornerRadius * W)
  if (layer.kind === 'path') return layer.d
  return null
}
```

`roundedRectPathData` and `ellipsePathData` do not exist — add them to `frontend/app/lib/compositor/polygonGeometry.ts` beside `polygonPathData`, exported, each with a unit test in `tests/unit/` asserting the emitted string's start point and command sequence and that a zero radius emits a plain four-line rect. A rounded rect is four lines and four `A` arcs; an ellipse is two `A` arcs.

- [ ] **Step 2: Write the painter**

```ts
/**
 * A stroke drawn as library shapes marching along the (offset) outline.
 *
 * Marks take the STROKE'S OWN paint, so a shape stroke can be a gradient or a pattern like
 * any other. `drawShape` is deliberately not used: it accepts a colour string only, and a
 * resolved Paint can be a CanvasGradient or CanvasPattern.
 */
function paintShapeStroke(ctx: CanvasRenderingContext2D, o: {
  pathData: string
  distance: number
  spec: ShapeStrokeSpec
  style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
  unit: number      // px per stored unit: W, or scale*W for a path layer
}) {
  const shape = shapeById(o.spec.shapeId)
  if (!shape) return
  const size = o.spec.size * o.unit
  const spacing = o.spec.spacing * o.unit
  if (!(size > 0) || !(spacing > 0)) return
  const guide = shapeStrokeGuide(o.pathData, o.distance)
  if (!guide) return
  const marks = shapePlacements(guide, spacing)
  if (!marks.length) return

  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0)) return
  const s = Math.min(size / bw, size / bh)
  const path = shapePath2D(shape)
  const follow = o.spec.follow !== false
  ctx.save()
  ctx.fillStyle = o.style(ctx)
  for (const m of marks) {
    ctx.save()
    ctx.translate(m.x, m.y)
    if (follow) ctx.rotate(m.angle)
    ctx.scale(s, s)
    // Centre the ink box on the mark rather than its top-left, so spacing means
    // centre-to-centre as the type says it does.
    ctx.translate(-bx - bw / 2, -by - bh / 2)
    ctx.fill(path, shape.fillRule)
    ctx.restore()
  }
  ctx.restore()
}
```

- [ ] **Step 3: Branch in the stack loop**

Inside each kind's stack loop, before the `paintStrokeBand` call:

```ts
      if ((st.style ?? 'band') === 'shapes' && st.shapes) {
        const pd = outlinePathData(layer, W)
        if (pd) {
          paintShapeStroke(ctx, {
            pathData: pd, distance: (st.distance ?? 0) * W, spec: st.shapes,
            style: (c) => resolvePaint(c, st.paint, { w, h }, _fieldCtx), unit: W,
          })
        }
        continue
      }
```

For the path arm, `unit` is `scale * W` and `distance` is `(st.distance ?? 0) * scale * W`, matching how the width is already scaled there.

- [ ] **Step 4: Write the browser test**

```ts
test('a shapes stroke puts the expected number of marks around a circle', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'e', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
    fill: 'none',
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.004, distance: 0, style: 'shapes',
                shapes: { shapeId: 'sparkle', size: 0.04, spacing: 0.12, follow: true } }],
  }]))
  await stackPixels(page)
  // Count red blobs by walking a ring just inside the marks' radius and counting the
  // transitions from not-red to red. A circle of radius 0.2 has circumference ~1.257;
  // spacing 0.12 ⇒ round(10.47) = 10 marks.
  const runs = await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const g = cv.getContext('2d')!
    let n = 0, prev = false
    for (let i = 0; i < 1440; i++) {
      const a = (i / 1440) * Math.PI * 2
      const x = Math.round((0.5 + Math.cos(a) * 0.2) * cv.width)
      const y = Math.round((0.5 + Math.sin(a) * 0.2) * cv.height)
      const d = g.getImageData(x, y, 1, 1).data
      const red = d[0]! > 180 && d[1]! < 80 && d[3]! > 150
      if (red && !prev) n++
      prev = red
    }
    return n
  })
  expect(runs).toBe(10)
})

test('follow off leaves every mark at the same angle', async ({ page }) => {
  // Two renders of an asymmetric shape (an arrow), follow true vs false, must differ —
  // and the follow:false render must be unchanged when the whole layer is rotated by a
  // multiple of the spacing, which a rotating mark would not be.
})

test('a shape stroke takes the stroke\'s paint, not a hardcoded colour', async ({ page }) => {
  // Same layer with paint '#00ff00'; assert green marks and no red anywhere.
})
```

- [ ] **Step 5: Run RED first, then green**

Break `shapePlacements` to always return one mark; the count test must fail. Restore. Then:

```bash
cd frontend && npx playwright test tests/compositor-multi-stroke.spec.ts --reporter=line
cd frontend && npx vitest run tests/unit/
```

- [ ] **Step 6: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/app/composables/useCompositorLayers.ts frontend/app/lib/compositor/polygonGeometry.ts frontend/tests/compositor-multi-stroke.spec.ts frontend/tests/unit/
git commit -F - -- frontend/app/composables/useCompositorLayers.ts frontend/app/lib/compositor/polygonGeometry.ts frontend/tests/compositor-multi-stroke.spec.ts frontend/tests/unit/ <<'MSG'
feat(frame): a stroke can be library shapes marching along the edge

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 7: The stroke rows, the plus-menu and the inspector

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/CompositorStrokeRow.vue`
- Create: `frontend/app/components/vue-canvas/compositor/ShapeStrokeRow.vue`
- Modify: `frontend/app/components/vue-canvas/compositor/StrokeStyleRow.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`
- Test: `frontend/tests/unit/compositor-stroke-inspector.unit.spec.ts`

**Interfaces:**
- Consumes: everything from Task 1; `CompositorEffectRow.vue` as the structural template.
- Produces: `selectedStrokeId` state and the handlers `pickStrokeAdd`, `onStrokeSelect`, `onStrokeRemove`, `onStrokeDuplicate`, `onStrokeToggleVisible`, `onStrokeDragStart`, `onStrokeDropOn`, `onStrokeDragEnd`, `setStrokeField(layerId, strokeId, patch)` in the modal.

- [ ] **Step 1: Read the template you are copying**

Read `frontend/app/components/vue-canvas/compositor/CompositorEffectRow.vue` in full, then the modal's effect-row handlers (search `pickFxKind`, `activeEffect`, `layerStack`). Your row is the same component with stroke words. **Match its accessibility exactly** — `role`, `tabindex`, Enter and Space select, and hover buttons revealing on `group-focus-within` — because effect rows a keyboard could not reach was a finding in that feature's own review.

- [ ] **Step 2: Build `CompositorStrokeRow.vue`**

Same props and events as the effect row, with `stroke: StrokeInstance` instead of `effect`, no `pinned` (no stroke is pinned), and the label from `strokeRowLabel(stroke, outWidth)`. A colour chip at the row's left showing the stroke's paint, so a stack of four is readable at a glance. `data-testid="stroke-row"`.

- [ ] **Step 3: Wire the modal**

- Render stroke rows under each layer, after its effect rows, only when `strokeSupportsStack(layer.kind)`.
- The layer's hover plus-menu gains an "Add stroke" entry above the effect kinds, separated by a rule. Not offered on a line, an image, a brush or wired content.
- Selecting a stroke row clears `selectedEffectId` and vice versa — one breadcrumb at a time.
- The inspector, when a stroke row is selected, shows: the paint (`FillControl` with `allow-none`), Width, **Distance**, **Corners** (`optionLabels` `['Sharp', 'Rounded']`), Alignment, Dash, and **Style** (`optionLabels` `['Band', 'Shapes']`) — Style only when `strokeSupportsShapes(layer.kind)`.
- **Dash is hidden when the stroke has a non-zero distance** (Task 2 ignores it there; a control that stores a value nothing reads is a dead control, and this repo's rule is to hide, not grey).
- Choosing Shapes seeds `shapes: { shapeId: 'sparkle', size: <2× the width>, spacing: <4× the width>, follow: true }` so the first render shows something, and reveals `ShapeStrokeRow.vue` (shape picker, Size, Spacing, "Turn with the edge" toggle).
- Every edit writes through `writeStrokeStackToLayer(nextStack)` in ONE `setLocal` patch, so the legacy fields are cleared in the same undo step that stores the list.

- [ ] **Step 4: Write the inspector unit test**

Mirror `tests/unit/compositor-effect-inspector.unit.spec.ts`: mount the modal's inspector for a selected stroke on each supporting kind and assert the row set, the gating (no Style row on text; no Dash row at a distance), and that every select carries human `optionLabels` — no raw `sharp` / `band` / `shapes` string reaches the DOM.

- [ ] **Step 5: Run, then commit**

```bash
cd frontend && npx vitest run tests/unit/compositor-stroke-inspector.unit.spec.ts && npm run typecheck
```

```bash
export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
git add -- frontend/app/components/vue-canvas/compositor/CompositorStrokeRow.vue frontend/app/components/vue-canvas/compositor/ShapeStrokeRow.vue frontend/app/components/vue-canvas/compositor/StrokeStyleRow.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/unit/compositor-stroke-inspector.unit.spec.ts
git commit -F - -- frontend/app/components/vue-canvas/compositor/CompositorStrokeRow.vue frontend/app/components/vue-canvas/compositor/ShapeStrokeRow.vue frontend/app/components/vue-canvas/compositor/StrokeStyleRow.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/unit/compositor-stroke-inspector.unit.spec.ts <<'MSG'
feat(frame): strokes as child rows in the tree, with distance, corners and style

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
unset GIT_INDEX_FILE
```

---

## Task 8: The agent and the SVG export

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (the `layerToVector` descriptors, around lines 950–1000)
- Test: `frontend/tests/unit/compositor-stroke-vector.unit.spec.ts` (create); extend `tests/unit/agent-capability-routing.unit.spec.ts` only if it already covers stroke ops

**Interfaces:**
- Consumes: `strokeStackOf`, `writeStrokeStackToLayer`, `addStroke`, `removeStroke` (Task 1).
- Produces: agent ops `addStroke`, `removeStroke`, `setStrokeProps`; `layerToVector` emitting one shape descriptor per band stroke.

- [ ] **Step 1: SVG export**

Each band stroke becomes its own descriptor: the same geometry, `fill: 'none'`, that stroke's paint, width and dash. **A stroke with a non-zero distance cannot be exact** — the offset geometry is raster, not a path. Write it at its stored width on the un-offset path and register a degrade note through the writer's existing mechanism, naming the layer. A shapes stroke writes each mark as a transformed copy of the library shape's path.

- [ ] **Step 2: Test it**

Assert: a two-stroke rect emits two `<path>` elements in the same order they paint; a distant stroke emits a degrade note; a shapes stroke emits one path per mark and no `stroke` attribute on them.

- [ ] **Step 3: Agent**

`strokeField(kind)` returning one field name is now wrong. Replace its callers with the stack. Describe a layer's strokes as a short list ("2 strokes: 6 px red; 2 px black, 12 px out"). Add `addStroke` / `removeStroke` / `setStrokeProps(layerId, strokeId, patch)`. Check the Compositor command-menu hint against `COMPOSITOR_HINT_CEILING` (21,500; 21,399 already used) — **there is almost no headroom, so compress an existing hint rather than raising the ceiling.**

- [ ] **Step 4: Run and commit** — the whole unit suite, typecheck, then commit the exact paths.

---

## Task 9: Live, in a real browser

**Files:**
- Modify: `frontend/tests/compositor-multi-stroke.spec.ts`

- [ ] **Step 1: The tree flow**

Add a rect through the toolbar; add three strokes from the layer's plus-menu; assert three `stroke-row`s appear. Select the second, change its distance, and assert the canvas pixel hash **changes**; undo and assert it **returns exactly**. Drag the third above the first and assert the order in `__compositorLayers()`. Backspace on a stroke row removes the stroke, not the layer. Tab to a stroke row and press Enter to select it.

Synthetic pointer events prove nothing here — use real clicks and real `dragstart`/`drop` events, the lesson from the type-on-a-path pen hand-off.

- [ ] **Step 2: Reach**

A rect with a stroke at a large distance inside a corner-pin: assert the stroke's outer edge is present in the output, i.e. not clipped at the offscreen boundary. Run it red by forcing `outsideStrokePadPx` to return 0.

- [ ] **Step 3: Read-through, live**

Seed a layer in the LEGACY shape, open the inspector, and assert one stroke row appears with the right label — and that `__compositorLayers()` still shows the legacy fields and **no `strokes` array** until an edit is made. Then edit, and assert the swap happened in one step.

- [ ] **Step 4: Run everything and commit**

```bash
cd frontend && npx playwright test tests/compositor-multi-stroke.spec.ts --reporter=line
cd frontend && npx vitest run
cd frontend && npm run typecheck
```

Record the unit-suite pass/fail counts in the commit message and compare against the pre-existing baseline of **7 failures owned by other sessions** (`capabilities.ts`, `fills.ts`, `fillTile.ts`, `RowSlider.vue`). Any eighth failure is yours.

---

## Task 10: Whole-feature review

- [ ] **Step 1: Dispatch a fresh reviewer over the whole branch diff**

The brief: read the spec, then every commit from Task 1 to Task 9 as one change. Look specifically for —

- a control that stores a value nothing reads (chase every dial to the leaf it writes);
- a test that cannot fail (mutate the implementation and confirm each new test goes red);
- the read-through writing on open (seed a legacy frame, open it, diff the stored document);
- `destination-out` reaching a shared context;
- a hint or label rendering an internal identifier;
- the byte-identity fixture regenerated rather than honoured.

- [ ] **Step 2: Fix what it finds, re-review the fixes, then update the dashboard**

Re-read the live "Sailor — State of the Build" artifact before editing it — another session republished it on 2026-09-07, so any local copy is stale — then add the Landed entry and republish in place.

---

## Self-Review

**Spec coverage.** Ordered list → Task 1. Distance as a true offset → Tasks 2, 4. Shapes along the edge → Tasks 5, 6. Tree rows → Task 7. Read-through → Tasks 1, 9. Corners dial → Tasks 2, 7. Text supported for band strokes, excluded from shapes → Tasks 1 (`strokeSupportsShapes`), 3 (`drawText`), 6 (`outlinePathData` returns null), 7 (no Style row). Every consumer in the spec's table → Task 3 (painter, pad), Task 8 (SVG, agent), Task 7 (modal, StrokeStyleRow). `silhouetteCache.ts` reads `strokeAlign` — **gap found: no task covered it.** Added to Task 3, Step 2's scope: `silhouetteCache.ts` must read the stack's widest reach the same way `outsideStrokePadPx` does, or a torn edge on a multi-stroked layer bakes the wrong silhouette. Implementer: treat that as part of Task 3 and cover it with a unit case.

**Placeholders.** Task 6 Step 4's second and third browser tests are described rather than written out; every other code step carries its code. Those two follow the pattern of the first test in the same block and the implementer has the harness in hand.

**Type consistency.** `strokeStackOf`, `writeStrokeStackToLayer`, `paintStrokeBand`, `shapeStrokeGuide`, `shapePlacements`, `offsetPolyline`, `outsideStrokePadPx`, `strokeRowLabel`, `strokeSupportsStack`, `strokeSupportsShapes` are spelled identically everywhere they appear. `StrokeInstance.paint` (not `color`, not `stroke`) throughout. `distance` is in stored units at every declaration and multiplied by `W` (or `scale * W`) at every call site.
