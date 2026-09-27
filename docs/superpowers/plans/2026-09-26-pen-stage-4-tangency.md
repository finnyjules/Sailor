# The pen, stage 4 — tangency done right — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tangency between any two lines, arcs and circles — joined or not — as rules the solver keeps: two new rule kinds, a Tangent verb (plus Equal for two arcs) in the rules row, tangent snapping while an arc is bowed and when a line leaves an arc's end, and dragging an arc's bow (or, with ⌘, its centre) in Select.

**Architecture:** One new pure module `frontend/app/lib/sketch/tangency.ts` (reading the new rules' circle operands, the tangent rule for two pieces, the bow-snap geometry, the badge's touch point), two new cases in each of `residuals.ts` / `jacobian.ts`, and wiring in the shared pen (`composables/pen/penRules.ts`, `composables/pen/usePen.ts`, `composables/pen/penTips.ts`, `components/pen/PenOverlay.vue`). Every host (the pen page, the Frame, Shape Studio) inherits it through the shared pen; no host file changes.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (`tests/unit/**/*.unit.spec.ts`), Playwright against the running :3002 dev server.

**Spec:** `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — sections "Shared ground" and "Stage 4" are binding; only Stage 4 is in scope. Read both before your task.

## Global Constraints

- Work in the main checkout `/Users/julien/Documents/GitHub/Sailor` on `main`. No git worktree, no branch.
- NEVER run `npm run dev` and never start, stop, kill or restart any dev server (or ComfyUI). The shared server on http://127.0.0.1:3002 is used as-is. If it serves a stale module, `touch` the file and check the served module for a new identifier: `curl -s http://127.0.0.1:3002/_nuxt/Users/julien/Documents/GitHub/Sailor/frontend/app/<path> | grep -c <newIdentifier>`.
- Other sessions edit this checkout at the same time. Never `git stash`. Never touch, revert, format or stage a file you did not write for your task, even if it looks broken.
- Commit through a private index, exactly:
  ```bash
  cd /Users/julien/Documents/GitHub/Sailor
  export GIT_INDEX_FILE=$(mktemp /tmp/pidx.XXXX); git read-tree HEAD
  git add <your exact paths>
  git commit -m "<message>

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  rm -f $GIT_INDEX_FILE; unset GIT_INDEX_FILE
  ```
  then, in a separate command with `GIT_INDEX_FILE` unset: `git reset -q -- <your exact paths>`, then verify with `git log -1 --stat` (only your paths, HEAD moved). If a file you edit already carried someone else's uncommitted hunks when you started, stage only your hunks: `git hash-object -w <tmpfile-with-HEAD-plus-your-hunks>` + `git update-index --cacheinfo 100644,<sha>,<path>` inside the private index.
- Commit trailer exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- UI copy: sentence case, plain words, no identifiers (glyphs such as T ⊥ are fine). Explanations live in the tooltip cards (`PEN_TIPS`), not as extra text in panels.
- Tolerances are screen px converted with `pxToUnits(px, view)` (`lib/sketch/tolerance.ts`); use the existing `SNAP_PX` / `BOW_PX` constants.
- The pen's drag state must stay reactive to overlay computeds: every write to drag state goes through `setPathDrag` or bumps `pathDragTick` (usePen). New drag state follows the same rule (see Task 5's `setArcDrag`).
- Bézier (cubic) segments are excluded from everything in this stage: never a tangent piece, never a snap target, never bow-dragged.
- Every gesture is one undo step (`commitHistory()` once, on release).
- Path arc segments carry the invariant `equalDist [centre, start, centre, end]` (added by `addPath`); an arc segment you create in the pending path gets it through `finishPath` as today.
- Real-mouse checks use `page.mouse` / `page.keyboard` / `locator.click()`, never synthetic `dispatchEvent`. `window.__sketchDraw` hooks may only set up a drawing or read state.
- Unit tests: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run <files>`. Typecheck: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -E '<your files>'` — judged only on files you touched (the repo has a pre-existing error baseline). Browser specs: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test <spec files> --project=chromium`.
- Rulings made by this plan (where the spec left a detail open) are marked **Ruling:** and are binding for the implementer.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/app/lib/sketch/tangency.ts` (new) | circle operands of the new rules, badge touch point, pieces, tangent rule for two pieces, bow-snap geometry | 1, 2 |
| `frontend/app/lib/sketch/model.ts` | two new `ConstraintKind`s | 1 |
| `frontend/app/lib/sketch/residuals.ts`, `jacobian.ts` | residual + analytic rows for them | 1 |
| `frontend/app/lib/sketch/merge.ts`, `annotate.ts` | load/save and badges for them | 1 |
| `frontend/app/lib/sketch/infer.ts` | export `sweepFor` | 4 |
| `frontend/app/composables/pen/penRules.ts` | Tangent / Equal offers, refs | 3 |
| `frontend/app/composables/pen/penTips.ts` | two new tooltip cards | 3 |
| `frontend/app/composables/pen/usePen.ts` | Tangent apply path, selection pairing, bow-snap, line-leaves-arc snap, arc drag | 3, 4, 5 |
| `frontend/app/components/pen/PenOverlay.vue` | tangent chips, ghost circle, arc press/drag | 4, 5 |
| `frontend/tests/unit/sketch-tangent-rules.unit.spec.ts` (new) | residuals, Jacobian vs numeric, solve, merge, badges | 1 |
| `frontend/tests/unit/sketch-tangency.unit.spec.ts` (new) | pieces, tangent rule choice, bow-snap geometry | 2 |
| `frontend/tests/unit/pen-tangent-verbs.unit.spec.ts` (new) | Tangent / Equal through usePen | 3 |
| `frontend/tests/unit/pen-bow-tangent.unit.spec.ts` (new) | bow-snap and line-leaves-arc through usePen | 4 |
| `frontend/tests/unit/pen-arc-drag.unit.spec.ts` (new) | bow drag and centre drag through usePen | 5 |
| `frontend/tests/pen-tangent.spec.ts` (new) | real-mouse Playwright on `/dev/sketch-draw` | 6 |

---

### Task 1: The two new rule kinds — residuals, analytic Jacobian rows, load and badges

**Files:**
- Create: `frontend/app/lib/sketch/tangency.ts` (first half — operands and touch point)
- Modify: `frontend/app/lib/sketch/model.ts` (the `ConstraintKind` union)
- Modify: `frontend/app/lib/sketch/residuals.ts` (`residualsFor` switch)
- Modify: `frontend/app/lib/sketch/jacobian.ts` (`rowsFor` switch + header comment)
- Modify: `frontend/app/lib/sketch/merge.ts` (`CONSTRAINT_KINDS`, `NEEDS_VALUE`)
- Modify: `frontend/app/lib/sketch/annotate.ts` (`GLYPH`, `anchor`, `constraintMarks`)
- Test: `frontend/tests/unit/sketch-tangent-rules.unit.spec.ts`

**Rule shapes (from the spec, with rulings):**
- `tangentLineArc`, refs `[A, B, C, S]`: the distance from centre C to the infinite line AB equals |C S|. Residual `|signedDist(C; A→B)| − |C S|`.
  **Ruling:** refs may also be `[A, B, circleId]` (a circle's id in place of the `[C, S]` pair). The spec has no form for a *path line segment* tangent to a circle (`tangentLineCircle` needs a line entity), so this form fills that gap.
- `tangentArcs`, refs `[C1, S1, C2, S2]`, `value` +1 (outside each other) or −1 (one inside the other): `|C1 C2| − (r1 + r2)` for +1, `|C1 C2| − |r1 − r2|` for −1. Either `[C, S]` pair may be replaced by a circle id (the circle's centre and `r`): `[circleId, C2, S2]`, `[C1, S1, circleId]`, `[circleIdA, circleIdB]`.
- A rule whose refs don't parse into exactly the operands above, or a `tangentArcs` whose value isn't exactly 1 or −1, scores nothing (the residual and the Jacobian both return `null` — the same skip rule as a dangling ref).
- **Ruling:** the `tangentArcs` value is a side, not a dimension: its badge shows no number and clicking it removes the rule (like every glyph-only badge). Both kinds show the glyph `T`, placed at the touch point.

**Interfaces:**
- Consumes: nothing new.
- Produces (in `lib/sketch/tangency.ts`):
  ```ts
  export type CircleOperand =
    | { kind: 'pair'; c: PointEntity; s: PointEntity }
    | { kind: 'circle'; c: PointEntity; circle: CircleEntity }
  export function readCircleOperands(map: ReadonlyMap<EntityId, SketchEntity>, refs: EntityId[], start: number): CircleOperand[] | null
  export function operandRadius(o: CircleOperand): number
  export function tangentTouchPoint(doc: SketchDoc, c: SketchConstraint): Vec2 | null
  ```
  and `ConstraintKind` gains `'tangentLineArc' | 'tangentArcs'`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-tangent-rules.unit.spec.ts`:

```ts
// tests/unit/sketch-tangent-rules.unit.spec.ts
// The two tangency rules added in pen stage 4: tangentLineArc (a line and an
// arc or circle that don't share a point) and tangentArcs (two arcs/circles,
// outside or inside each other). Residuals, the analytic Jacobian checked
// against central differences, a solve that makes a drawing tangent, loading,
// and the badge.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, SketchConstraint } from '~/lib/sketch/model'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { buildJacobian } from '~/lib/sketch/jacobian'
import { solve } from '~/lib/sketch/solve'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { constraintMarks } from '~/lib/sketch/annotate'
import { tangentTouchPoint } from '~/lib/sketch/tangency'

type Slot = { kind: 'px' | 'py' | 'r'; id: EntityId }
function allSlots(doc: SketchDoc): Slot[] {
  const slots: Slot[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') slots.push({ kind: 'px', id: e.id }, { kind: 'py', id: e.id })
    else if (e.kind === 'circle') slots.push({ kind: 'r', id: e.id })
  }
  return slots
}
function readSlot(doc: SketchDoc, s: Slot): number {
  const e = doc.entities.find(x => x.id === s.id)! as any
  return s.kind === 'px' ? e.x : s.kind === 'py' ? e.y : e.r
}
function writeSlot(doc: SketchDoc, s: Slot, v: number): void {
  const e = doc.entities.find(x => x.id === s.id)! as any
  if (s.kind === 'px') e.x = v
  else if (s.kind === 'py') e.y = v
  else e.r = v
}
function numericalJacobian(doc: SketchDoc, slots: Slot[]): number[][] {
  const h = 1e-6
  const m = constraintResiduals(doc).length
  const J: number[][] = Array.from({ length: m }, () => new Array(slots.length).fill(0))
  slots.forEach((s, j) => {
    const orig = readSlot(doc, s)
    writeSlot(doc, s, orig + h); const plus = constraintResiduals(doc)
    writeSlot(doc, s, orig - h); const minus = constraintResiduals(doc)
    writeSlot(doc, s, orig)
    for (let i = 0; i < m; i++) J[i]![j] = (plus[i]! - minus[i]!) / (2 * h)
  })
  return J
}
function expectJacobianMatches(doc: SketchDoc): void {
  const slots = allSlots(doc)
  const a = buildJacobian(doc, slots)
  const n = numericalJacobian(doc, slots)
  expect(a.length).toBe(constraintResiduals(doc).length)
  expect(a.length).toBe(n.length)
  for (let i = 0; i < a.length; i++) for (let j = 0; j < slots.length; j++) {
    if (Math.abs(a[i]![j]! - n[i]![j]!) > 1e-4) throw new Error(`row ${i} col ${j} (${slots[j]!.kind}:${slots[j]!.id}): analytic=${a[i]![j]} numeric=${n[i]![j]}`)
  }
}
const pt = (id: string, x: number, y: number) => ({ id, kind: 'point' as const, x, y })
const circ = (id: string, center: string, r: number) => ({ id, kind: 'circle' as const, center, r })
const rule = (kind: any, refs: string[], value?: number): SketchConstraint => ({ id: 'k', kind, refs, ...(value != null ? { value } : {}) })

describe('tangentLineArc residual', () => {
  it('is zero when the arc touches the line, and the gap otherwise', () => {
    const touching: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3), pt('S', 8, 3)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] }
    expect(constraintResiduals(touching)[0]).toBeCloseTo(0, 12)
    const apart: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 4), pt('S', 8, 4)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] }
    expect(constraintResiduals(apart)[0]).toBeCloseTo(1, 12)
    // below the line counts the same (absolute distance)
    const below: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, -3), pt('S', 5, 0)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] }
    expect(constraintResiduals(below)[0]).toBeCloseTo(0, 12)
  })
  it('accepts a circle id in place of the centre and arc point', () => {
    const doc: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('cc', 5, 3), circ('K', 'cc', 3)], constraints: [rule('tangentLineArc', ['A', 'B', 'K'])] }
    expect(constraintResiduals(doc)).toHaveLength(1)
    expect(constraintResiduals(doc)[0]).toBeCloseTo(0, 12)
  })
  it('scores nothing for refs of the wrong shape', () => {
    const doc: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3)], constraints: [rule('tangentLineArc', ['A', 'B', 'C'])] }
    expect(constraintResiduals(doc)).toHaveLength(0)
    expect(buildJacobian(doc, allSlots(doc))).toHaveLength(0)
  })
})

describe('tangentArcs residual', () => {
  it('outside (+1): centres apart by the sum of the radii', () => {
    const doc: SketchDoc = { entities: [pt('C1', 0, 0), pt('S1', 2, 0), pt('C2', 5, 0), pt('S2', 5, 3)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], 1)] }
    expect(constraintResiduals(doc)[0]).toBeCloseTo(0, 12)
  })
  it('inside (−1): centres apart by the difference of the radii', () => {
    const doc: SketchDoc = { entities: [pt('C1', 0, 0), pt('S1', 5, 0), pt('C2', 2, 0), pt('S2', 2, 3)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] }
    expect(constraintResiduals(doc)[0]).toBeCloseTo(0, 12)
  })
  it('circle ids stand in for either pair', () => {
    const doc: SketchDoc = {
      entities: [pt('C1', 0, 0), pt('S1', 2, 0), pt('q', 5, 0), circ('K', 'q', 3), pt('q2', 0, 0), circ('K2', 'q2', 8)],
      constraints: [
        { id: 'k1', kind: 'tangentArcs', refs: ['C1', 'S1', 'K'], value: 1 },
        { id: 'k2', kind: 'tangentArcs', refs: ['K', 'C1', 'S1'], value: 1 },
        { id: 'k3', kind: 'tangentArcs', refs: ['K2', 'K'], value: -1 },
      ],
    }
    const r = constraintResiduals(doc)
    expect(r).toHaveLength(3)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(0, 12)
    expect(r[2]).toBeCloseTo(0, 12)   // |(0,0)-(5,0)| = 5 = 8 - 3
  })
  it('scores nothing without a side of exactly 1 or −1', () => {
    for (const v of [undefined, 0, 2]) {
      const doc: SketchDoc = { entities: [pt('C1', 0, 0), pt('S1', 2, 0), pt('C2', 5, 0), pt('S2', 5, 3)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], v)] }
      expect(constraintResiduals(doc)).toHaveLength(0)
    }
  })
})

describe('analytic Jacobian rows match central differences', () => {
  it('tangentLineArc, point pair form', () => {
    expectJacobianMatches({ entities: [pt('A', 0.3, -0.2), pt('B', 10, 2), pt('C', 5, 6), pt('S', 7.5, 4)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] })
  })
  it('tangentLineArc, centre below the line (negative signed distance)', () => {
    expectJacobianMatches({ entities: [pt('A', 0, 0), pt('B', 10, 1), pt('C', 4, -5), pt('S', 6, -2)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] })
  })
  it('tangentLineArc, circle form', () => {
    expectJacobianMatches({ entities: [pt('A', 0, 0), pt('B', 9, 3), pt('cc', 4, 7), circ('K', 'cc', 2.5)], constraints: [rule('tangentLineArc', ['A', 'B', 'K'])] })
  })
  it('tangentArcs outside, both pairs', () => {
    expectJacobianMatches({ entities: [pt('C1', 0, 0), pt('S1', 2, 1), pt('C2', 6, 2), pt('S2', 6, 5)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], 1)] })
  })
  it('tangentArcs inside, first larger', () => {
    expectJacobianMatches({ entities: [pt('C1', 0, 0), pt('S1', 6, 1), pt('C2', 1, 2), pt('S2', 1, 4)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] })
  })
  it('tangentArcs inside, second larger', () => {
    expectJacobianMatches({ entities: [pt('C1', 1, 2), pt('S1', 1, 4), pt('C2', 0, 0), pt('S2', 6, 1)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] })
  })
  it('tangentArcs with circle ids on either side and both sides', () => {
    expectJacobianMatches({
      entities: [pt('C1', 0, 0), pt('S1', 2, 1), pt('q', 6, 2), circ('K', 'q', 2.2), pt('q2', -1, 1), circ('K2', 'q2', 9)],
      constraints: [
        { id: 'k1', kind: 'tangentArcs', refs: ['C1', 'S1', 'K'], value: 1 },
        { id: 'k2', kind: 'tangentArcs', refs: ['K', 'C1', 'S1'], value: -1 },
        { id: 'k3', kind: 'tangentArcs', refs: ['K2', 'K'], value: -1 },
      ],
    })
  })
})

describe('solving', () => {
  it('pulls a free arc onto a fixed line', () => {
    const doc: SketchDoc = {
      entities: [{ ...pt('A', 0, 0), fixed: true }, { ...pt('B', 10, 0), fixed: true }, pt('C', 5, 4), pt('S', 8, 4)],
      constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])],
    }
    const res = solve(doc)
    expect(res.converged).toBe(true)
    expect(Math.abs(constraintResiduals(doc)[0]!)).toBeLessThan(1e-5)
  })
  it('pulls two arcs into touching, inside', () => {
    const doc: SketchDoc = {
      entities: [{ ...pt('C1', 0, 0), fixed: true }, { ...pt('S1', 5, 0), fixed: true }, pt('C2', 1, 0), pt('S2', 1, 3)],
      constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)],
    }
    expect(solve(doc).converged).toBe(true)
    expect(Math.abs(constraintResiduals(doc)[0]!)).toBeLessThan(1e-5)
  })
})

describe('loading and badges', () => {
  it('mergeSketchDoc keeps both kinds, and drops tangentArcs without its side', () => {
    const raw = {
      entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3), pt('S', 8, 3), pt('C2', 5, 9), pt('S2', 5, 6)],
      constraints: [
        { id: 'k1', kind: 'tangentLineArc', refs: ['A', 'B', 'C', 'S'] },
        { id: 'k2', kind: 'tangentArcs', refs: ['C', 'S', 'C2', 'S2'], value: 1 },
        { id: 'k3', kind: 'tangentArcs', refs: ['C', 'S', 'C2', 'S2'] },
      ],
    }
    expect(mergeSketchDoc(raw).constraints.map(c => c.id)).toEqual(['k1', 'k2'])
  })
  it('both show a T badge at the touch point, and the side is not shown as a number', () => {
    const doc: SketchDoc = {
      entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3), pt('S', 8, 3), pt('C2', 5, 8), pt('S2', 5, 6)],
      constraints: [
        { id: 'k1', kind: 'tangentLineArc', refs: ['A', 'B', 'C', 'S'] },
        { id: 'k2', kind: 'tangentArcs', refs: ['C', 'S', 'C2', 'S2'], value: 1 },
      ],
    }
    const marks = constraintMarks(doc)
    const m1 = marks.find(m => m.id === 'k1')!, m2 = marks.find(m => m.id === 'k2')!
    expect(m1.glyph).toBe('T'); expect(m2.glyph).toBe('T')
    expect(m2.text).toBeUndefined()
    expect(m1.x).toBeCloseTo(5, 9); expect(m1.y).toBeCloseTo(0, 9)   // foot of C on the line
    expect(m2.x).toBeCloseTo(5, 9); expect(m2.y).toBeCloseTo(6, 9)   // 3 up from C towards C2
  })
  it('the touch point of an inside pair lies on both circles', () => {
    const doc: SketchDoc = { entities: [pt('C1', 1, 0), pt('S1', 1, 2), pt('C2', 0, 0), pt('S2', 3, 0)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] }
    const t = tangentTouchPoint(doc, doc.constraints[0]!)!
    expect(Math.hypot(t.x - 1, t.y)).toBeCloseTo(2, 9)
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(3, 9)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-tangent-rules.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/tangency"`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/tangency.ts` (operands + touch point)**

```ts
// app/lib/sketch/tangency.ts
// Tangency, pen stage 4. Shared by the solver (the two new rule kinds read
// their circle operands here), the badges (the touch point), the rules row
// (which rule makes two pieces tangent) and the Pen's bow snap.
//
// A "circle operand" is how a tangency rule names a round thing: either a
// point pair [C, S] (centre, and any point on it — a path arc's centre and its
// start anchor) or a circle entity's id (its centre point and its r).
import type { SketchDoc, SketchEntity, SketchConstraint, PointEntity, CircleEntity, EntityId } from './model'
import type { Vec2 } from './geom'

export type CircleOperand =
  | { kind: 'pair'; c: PointEntity; s: PointEntity }
  | { kind: 'circle'; c: PointEntity; circle: CircleEntity }

/** Reads refs[start..] as circle operands: a circle id takes one ref, a point
 *  takes itself and the next ref (which must be a point). Null when anything
 *  is missing or of the wrong kind; the caller checks how many it needs. */
export function readCircleOperands(map: ReadonlyMap<EntityId, SketchEntity>, refs: EntityId[], start: number): CircleOperand[] | null {
  const out: CircleOperand[] = []
  let i = start
  while (i < refs.length) {
    const e = map.get(refs[i]!)
    if (!e) return null
    if (e.kind === 'circle') {
      const c = map.get(e.center)
      if (!c || c.kind !== 'point') return null
      out.push({ kind: 'circle', c, circle: e })
      i += 1
    } else if (e.kind === 'point') {
      const s = map.get(refs[i + 1] ?? '')
      if (!s || s.kind !== 'point') return null
      out.push({ kind: 'pair', c: e, s })
      i += 2
    } else {
      return null
    }
  }
  return out
}

export function operandRadius(o: CircleOperand): number {
  return o.kind === 'circle' ? o.circle.r : Math.hypot(o.s.x - o.c.x, o.s.y - o.c.y)
}

function entityMap(doc: SketchDoc): Map<EntityId, SketchEntity> {
  const m = new Map<EntityId, SketchEntity>()
  for (const e of doc.entities) m.set(e.id, e)
  return m
}

/** Where a tangentLineArc / tangentArcs rule touches (its badge sits here):
 *  the foot of the centre on the line, or the point on the line of centres at
 *  the first radius. Null for any other kind or unreadable refs. */
export function tangentTouchPoint(doc: SketchDoc, c: SketchConstraint): Vec2 | null {
  const map = entityMap(doc)
  if (c.kind === 'tangentLineArc') {
    const a = map.get(c.refs[0]!), b = map.get(c.refs[1]!)
    const ops = readCircleOperands(map, c.refs, 2)
    if (!a || a.kind !== 'point' || !b || b.kind !== 'point' || !ops || ops.length !== 1) return null
    const o = ops[0]!
    const dx = b.x - a.x, dy = b.y - a.y
    const L2 = dx * dx + dy * dy
    if (L2 < 1e-18) return null
    const t = ((o.c.x - a.x) * dx + (o.c.y - a.y) * dy) / L2
    return { x: a.x + t * dx, y: a.y + t * dy }
  }
  if (c.kind === 'tangentArcs') {
    const ops = readCircleOperands(map, c.refs, 0)
    if (!ops || ops.length !== 2) return null
    const [o1, o2] = ops as [CircleOperand, CircleOperand]
    const r1 = operandRadius(o1), r2 = operandRadius(o2)
    const dx = o2.c.x - o1.c.x, dy = o2.c.y - o1.c.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return { x: o1.c.x + r1, y: o1.c.y }
    // inside, first one smaller: it touches on its far side from the other centre
    const k = c.value === -1 && r1 < r2 ? -1 : 1
    return { x: o1.c.x + (k * r1 * dx) / d, y: o1.c.y + (k * r1 * dy) / d }
  }
  return null
}
```

- [ ] **Step 4: Add the kinds to `model.ts`** — in the `ConstraintKind` union, change the last line

```ts
  | 'perpendicular' | 'parallel' | 'midpoint' | 'equalRadius'
```
to
```ts
  | 'perpendicular' | 'parallel' | 'midpoint' | 'equalRadius'
  // pen stage 4 (tangency.ts): [A, B, C, S] or [A, B, circleId]; and
  // [C1, S1, C2, S2] (either pair may be a circle id) with value +1 outside / −1 inside
  | 'tangentLineArc' | 'tangentArcs'
```

- [ ] **Step 5: Residuals** — in `residuals.ts` add `import { readCircleOperands, operandRadius } from './tangency'` and, just before `default:` in `residualsFor`, add:

```ts
    case 'tangentLineArc': {
      // refs=[A, B, C, S] or [A, B, circleId] — |distance from the centre to line AB| = radius
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const ops = readCircleOperands(map, c.refs, 2)
      if (!a || !b || !ops || ops.length !== 1) return null
      const o = ops[0]!
      return [Math.abs(distPointToLine({ x: o.c.x, y: o.c.y }, a, b)) - operandRadius(o)]
    }
    case 'tangentArcs': {
      // two circle operands; value +1 outside each other, −1 one inside the other
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || (c.value !== 1 && c.value !== -1)) return null
      const [o1, o2] = ops as [typeof ops[0], typeof ops[0]]
      const d = dist({ x: o1.c.x, y: o1.c.y }, { x: o2.c.x, y: o2.c.y })
      const r1 = operandRadius(o1), r2 = operandRadius(o2)
      return [c.value === 1 ? d - (r1 + r2) : d - Math.abs(r1 - r2)]
    }
```

- [ ] **Step 6: Jacobian rows** — in `jacobian.ts` add `import { readCircleOperands, operandRadius, type CircleOperand } from './tangency'`, add this helper above `rowsFor`:

```ts
// ∂(k·radius)/∂params for a circle operand: a circle's r directly, or |C S|
// through its two points
function radiusEntries(o: CircleOperand, k: number): JacEntry[] {
  if (o.kind === 'circle') return [pr(o.circle.id, k)]
  const dx = o.s.x - o.c.x, dy = o.s.y - o.c.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return []
  const ux = dx / d, uy = dy / d
  return [px(o.s.id, k * ux), py(o.s.id, k * uy), px(o.c.id, -k * ux), py(o.c.id, -k * uy)]
}
```

and, just before `default:` in `rowsFor`:

```ts
    case 'tangentLineArc': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const ops = readCircleOperands(map, c.refs, 2)
      if (!a || !b || !ops || ops.length !== 1) return null
      const o = ops[0]!
      const row: JacEntry[] = []
      const sd = signedDistPartials(o.c.x, o.c.y, a.x, a.y, b.x, b.y)
      if (sd) {
        const sign = sd.s >= 0 ? 1 : -1
        row.push(
          px(o.c.id, sign * sd.dPx), py(o.c.id, sign * sd.dPy),
          px(a.id, sign * sd.dAx), py(a.id, sign * sd.dAy),
          px(b.id, sign * sd.dBx), py(b.id, sign * sd.dBy),
        )
      }
      row.push(...radiusEntries(o, -1))
      return [row]
    }
    case 'tangentArcs': {
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || (c.value !== 1 && c.value !== -1)) return null
      const [o1, o2] = ops as [CircleOperand, CircleOperand]
      const row: JacEntry[] = []
      const dx = o1.c.x - o2.c.x, dy = o1.c.y - o2.c.y
      const d = Math.hypot(dx, dy)
      if (d >= 1e-9) {
        const ux = dx / d, uy = dy / d
        row.push(px(o1.c.id, ux), py(o1.c.id, uy), px(o2.c.id, -ux), py(o2.c.id, -uy))
      }
      if (c.value === 1) {
        row.push(...radiusEntries(o1, -1), ...radiusEntries(o2, -1))
      } else {
        const sg = operandRadius(o1) - operandRadius(o2) >= 0 ? 1 : -1
        row.push(...radiusEntries(o1, -sg), ...radiusEntries(o2, sg))
      }
      return [row]
    }
```

Also add `tangentLineArc, tangentArcs` to the `ANALYTIC (closed-form):` list in the file's header comment. (Entries for the same parameter appear twice in a row — e.g. C in both the distance and the radius terms; `buildJacobian` and `buildJacobianSubstituted` already add with `+=`, so nothing else changes.)

- [ ] **Step 7: Loading** — in `merge.ts` change

```ts
  'perpendicular', 'parallel', 'midpoint', 'equalRadius',
]
const NEEDS_VALUE = new Set<ConstraintKind>(['distance', 'radius', 'rotatedFrom'])
```
to
```ts
  'perpendicular', 'parallel', 'midpoint', 'equalRadius',
  'tangentLineArc', 'tangentArcs',
]
const NEEDS_VALUE = new Set<ConstraintKind>(['distance', 'radius', 'rotatedFrom', 'tangentArcs'])
```

- [ ] **Step 8: Badges** — in `annotate.ts`: add `import { tangentTouchPoint } from './tangency'`; in `GLYPH` add `tangentLineArc: 'T', tangentArcs: 'T',`; at the top of `anchor(doc, c)` add

```ts
  if (c.kind === 'tangentLineArc' || c.kind === 'tangentArcs') {
    const t = tangentTouchPoint(doc, c)
    if (t) return t
  }
```
and in `constraintMarks` change the text spread to skip the side value:
```ts
    out.push({ id: c.id, kind: c.kind, glyph: GLYPH[c.kind], x: at.x, y: at.y, ...(c.value != null && c.kind !== 'tangentArcs' ? { text: String(Math.round(c.value * 100) / 100) } : {}) })
```

- [ ] **Step 9: Run the new test and every sketch spec**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-tangent-rules.unit.spec.ts tests/unit/sketch-jacobian.unit.spec.ts tests/unit/sketch-residuals.unit.spec.ts tests/unit/sketch-solve.unit.spec.ts tests/unit/sketch-merge.unit.spec.ts tests/unit/sketch-annotate.unit.spec.ts`
Expected: all PASS.

Typecheck: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(tangency|model|residuals|jacobian|merge|annotate)\.ts'` — expected: no output. (If `typeof ops[0]` in the residual tuple cast bothers the checker, cast to `[CircleOperand, CircleOperand]` with a type import instead.)

- [ ] **Step 10: Commit** (private index, per Global Constraints) the paths `frontend/app/lib/sketch/tangency.ts frontend/app/lib/sketch/model.ts frontend/app/lib/sketch/residuals.ts frontend/app/lib/sketch/jacobian.ts frontend/app/lib/sketch/merge.ts frontend/app/lib/sketch/annotate.ts frontend/tests/unit/sketch-tangent-rules.unit.spec.ts` with message `feat(sketch): tangency rules for a line and an arc, and two arcs, that don't share a point`.

---

### Task 2: Which rule makes two pieces tangent, and the bow-snap geometry (pure)

**Files:**
- Modify: `frontend/app/lib/sketch/tangency.ts` (second half)
- Test: `frontend/tests/unit/sketch-tangency.unit.spec.ts`

**Rulings:**
- Joined (the two pieces share an end point id) → the joint forms the pen already writes: line–arc `perpendicular [otherEndOfLine, J, J, C]`, arc–arc `collinear [C1, J, C2]`. Not joined → line–arc `tangentLineArc [A, B, C, S]`, path line segment–circle `tangentLineArc [A, B, circleId]`, line entity–circle `tangentLineCircle [lineId, circleId]` (kept), arc–arc / arc–circle / circle–circle `tangentArcs` with the circle-id form for circles. Line–line → none. Two round pieces with the same centre → none.
- The side of a new `tangentArcs` is whichever of outside / inside is nearer to true right now: `|d − (r1+r2)| ≤ |d − |r1−r2||` → +1, else −1.
- Bow snap: the arc being bowed runs through two fixed points J (start) and E (end), so its circle has one degree of freedom — its centre slides along the chord's perpendicular bisector. For each candidate curve (line entities, circles, path line and arc segments, guides included; Bézier segments excluded; any piece that ends at or is centred on J or E excluded) the free circle's *gap* is measured (line: `| |dist(centre, line)| − r |`; circle/arc: the smaller of `|d − (r+R)|` and `|d − |r−R||`). A candidate within the snap tolerance is solved exactly (a quadratic in the centre's offset along the bisector). For a circle or arc, outside and inside touching are separate snaps: a root counts only if the free circle's gap *for that side* is within the tolerance (otherwise a far inside-touching root can snap onto a small arc the bow is nowhere near). Of the remaining roots, the one whose centre is nearest the free centre is kept. The touch point must lie on the target's drawn extent (between a line's ends; on an arc's drawn sweep; anywhere on a circle). Among candidates the smallest gap wins. A snapped radius over 1e4 is refused (same cap as `bowArc`).

**Interfaces:**
- Consumes: Task 1 `tangency.ts` (same file), `curveGeom`, `allCurves`, `paramOf`, `pointAt`, `CurveRef` from `crossings.ts`.
- Produces (in `lib/sketch/tangency.ts`):
  ```ts
  export type TangentPiece =
    | { kind: 'line'; a: EntityId; b: EntityId; lineId?: EntityId }   // lineId only for a line entity
    | { kind: 'arc'; c: EntityId; s: EntityId; e: EntityId }          // a path arc segment: centre, start, end
    | { kind: 'circle'; id: EntityId; c: EntityId }
  export interface RuleSpec { kind: ConstraintKind; refs: EntityId[]; value?: number }
  export function pieceOf(doc: SketchDoc, ref: CurveRef): TangentPiece | null        // null for cubic / missing
  export function tangentRuleFor(doc: SketchDoc, p: TangentPiece, q: TangentPiece): RuleSpec | null
  export interface BowTangentSnap { center: Vec2; r: number; target: CurveRef; touch: Vec2; side: 1 | -1 }
  export function bowTangentSnap(doc: SketchDoc, J: Vec2, E: Vec2, freeCenter: Vec2, tol: number, skipPoints: EntityId[]): BowTangentSnap | null
  export function curveKey(ref: CurveRef): string
  ```

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-tangency.unit.spec.ts`:

```ts
// tests/unit/sketch-tangency.unit.spec.ts
// Pen stage 4 geometry: reading a curve as a tangent piece, choosing the rule
// that makes two pieces tangent (joined → the joint form, apart → the new
// forms, side from the geometry), and the snap that makes an arc being bowed
// through two fixed points touch a nearby line, circle or arc.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { pieceOf, tangentRuleFor, bowTangentSnap, curveKey } from '~/lib/sketch/tangency'

const empty = (): SketchDoc => ({ entities: [], constraints: [] })
const seg = (pathId: EntityId, segIndex = 0) => ({ kind: 'seg' as const, pathId, segIndex })

describe('pieceOf', () => {
  it('reads lines, circles, line and arc segments; refuses a Bézier segment', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    const l = addLine(d, a, b)
    const cc = addPoint(d, 9, 9); const k = addCircle(d, cc, 2)
    const p = addPoint(d, 0, 5), q = addPoint(d, 4, 5), c = addPoint(d, 2, 5)
    const arc = addPath(d, [p, q], [{ kind: 'arc', center: c, sweep: 1 }])
    const h1 = addPoint(d, 1, 8), h2 = addPoint(d, 3, 8)
    const cub = addPath(d, [addPoint(d, 0, 7), addPoint(d, 4, 7)], [{ kind: 'cubic', h1, h2 }])
    expect(pieceOf(d, { kind: 'line', id: l })).toEqual({ kind: 'line', a, b, lineId: l })
    expect(pieceOf(d, { kind: 'circle', id: k })).toEqual({ kind: 'circle', id: k, c: cc })
    expect(pieceOf(d, seg(arc))).toEqual({ kind: 'arc', c, s: p, e: q })
    expect(pieceOf(d, seg(cub))).toBeNull()
    expect(curveKey(seg(arc, 0))).toBe(`${arc}:0`)
    expect(curveKey({ kind: 'line', id: l })).toBe(l)
  })
})

describe('tangentRuleFor', () => {
  function drawing() {
    const d = empty()
    // a line segment (3,4)→(11,4), an arc (4,6)→(10,6) centred (7,9) dipping to y≈4.76,
    // a second arc well to the right, a circle, and a line entity
    const la = addPoint(d, 3, 4), lb = addPoint(d, 11, 4)
    const linePath = addPath(d, [la, lb], [{ kind: 'line' }])
    const A = addPoint(d, 4, 6), B = addPoint(d, 10, 6), C = addPoint(d, 7, 9)
    const arcPath = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    const A2 = addPoint(d, 14, 9), B2 = addPoint(d, 16, 9), C2 = addPoint(d, 15, 9)
    const arc2 = addPath(d, [A2, B2], [{ kind: 'arc', center: C2, sweep: 1 }])
    const kc = addPoint(d, 7, 16); const K = addCircle(d, kc, 2)
    const ea = addPoint(d, 0, 20), eb = addPoint(d, 10, 20); const L = addLine(d, ea, eb)
    return { d, la, lb, linePath, A, B, C, arcPath, A2, C2, arc2, K, L, ea, eb }
  }
  it('line segment + arc apart → tangentLineArc [A, B, C, S], in either order', () => {
    const g = drawing()
    const line = pieceOf(g.d, seg(g.linePath))!, arc = pieceOf(g.d, seg(g.arcPath))!
    const want = { kind: 'tangentLineArc', refs: [g.la, g.lb, g.C, g.A] }
    expect(tangentRuleFor(g.d, line, arc)).toEqual(want)
    expect(tangentRuleFor(g.d, arc, line)).toEqual(want)
  })
  it('line segment + circle → tangentLineArc [A, B, circle]; line entity + circle keeps tangentLineCircle', () => {
    const g = drawing()
    expect(tangentRuleFor(g.d, pieceOf(g.d, seg(g.linePath))!, pieceOf(g.d, { kind: 'circle', id: g.K })!))
      .toEqual({ kind: 'tangentLineArc', refs: [g.la, g.lb, g.K] })
    expect(tangentRuleFor(g.d, pieceOf(g.d, { kind: 'circle', id: g.K })!, pieceOf(g.d, { kind: 'line', id: g.L })!))
      .toEqual({ kind: 'tangentLineCircle', refs: [g.L, g.K] })
  })
  it('two arcs apart → tangentArcs with the side nearer to true', () => {
    const g = drawing()
    // r1 ≈ 4.24 centred (7,9); r2 = 1 centred (15,9): d = 8, outside gap 2.76 < inside gap 4.76 → +1
    expect(tangentRuleFor(g.d, pieceOf(g.d, seg(g.arcPath))!, pieceOf(g.d, seg(g.arc2))!))
      .toEqual({ kind: 'tangentArcs', refs: [g.C, g.A, g.C2, g.A2], value: 1 })
  })
  it('a small arc inside a big circle → side −1, circle by id', () => {
    const d = empty()
    const q = addPoint(d, 0, 0); const K = addCircle(d, q, 10)
    const A = addPoint(d, 1, 0), B = addPoint(d, 3, 0), C = addPoint(d, 2, 0)
    const arc = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    expect(tangentRuleFor(d, pieceOf(d, seg(arc))!, pieceOf(d, { kind: 'circle', id: K })!))
      .toEqual({ kind: 'tangentArcs', refs: [C, A, K], value: -1 })
  })
  it('joined line + arc → perpendicular [other end, J, J, C]; joined arcs → collinear [C1, J, C2]', () => {
    const d = empty()
    const P0 = addPoint(d, 1, 6), A = addPoint(d, 4, 6), B = addPoint(d, 10, 6), C = addPoint(d, 7, 9)
    const E = addPoint(d, 14, 6), C3 = addPoint(d, 12, 8)
    const path = addPath(d, [P0, A, B, E], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C3, sweep: 1 }])
    const line = pieceOf(d, seg(path, 0))!, arc = pieceOf(d, seg(path, 1))!, arc3 = pieceOf(d, seg(path, 2))!
    expect(tangentRuleFor(d, arc, line)).toEqual({ kind: 'perpendicular', refs: [P0, A, A, C] })
    expect(tangentRuleFor(d, arc, arc3)).toEqual({ kind: 'collinear', refs: [C, B, C3] })
  })
  it('two lines, or two round pieces on one centre, have no tangent rule', () => {
    const g = drawing()
    expect(tangentRuleFor(g.d, pieceOf(g.d, seg(g.linePath))!, pieceOf(g.d, { kind: 'line', id: g.L })!)).toBeNull()
    const d = empty()
    const c = addPoint(d, 0, 0); const K1 = addCircle(d, c, 1); const K2 = addCircle(d, c, 3)
    expect(tangentRuleFor(d, pieceOf(d, { kind: 'circle', id: K1 })!, pieceOf(d, { kind: 'circle', id: K2 })!)).toBeNull()
  })
})

describe('bowTangentSnap — an arc through J=(6,5) and E=(12,5)', () => {
  const J = { x: 6, y: 5 }, E = { x: 12, y: 5 }
  it('snaps onto a line it nearly touches: centre (9,5), radius 3, touching at (9,2)', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2))
    // the free arc through the pointer (9, 2.1) is centred at (9, 5.1017)
    const s = bowTangentSnap(d, J, E, { x: 9, y: 5.1017 }, 0.6, [])!
    expect(s.target).toEqual({ kind: 'line', id: l })
    expect(s.center.x).toBeCloseTo(9, 9); expect(s.center.y).toBeCloseTo(5, 9)
    expect(s.r).toBeCloseTo(3, 9)
    expect(s.touch.x).toBeCloseTo(9, 9); expect(s.touch.y).toBeCloseTo(2, 9)
    expect(s.side).toBe(1)
  })
  it('does nothing when the gap is over the tolerance', () => {
    const d = empty()
    addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2))
    expect(bowTangentSnap(d, J, E, { x: 9, y: 6.5 }, 0.6, [])).toBeNull()
  })
  it('the touch point must be between a line’s ends', () => {
    const d = empty()
    addLine(d, addPoint(d, 12, 2), addPoint(d, 16, 2))   // would touch at (9,2), off this line
    expect(bowTangentSnap(d, J, E, { x: 9, y: 5.1017 }, 0.6, [])).toBeNull()
  })
  it('skips a piece that ends at J or E', () => {
    const d = empty()
    const j = addPoint(d, 6, 5)
    addLine(d, j, addPoint(d, 6, 1))
    addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2))
    const s = bowTangentSnap(d, J, E, { x: 9, y: 5.1017 }, 0.6, [j])!
    expect(s.target.kind).toBe('line')
    expect(s.touch.y).toBeCloseTo(2, 9)
  })
  it('touches a circle from outside: centre (9,3.4), radius 3.4, at (9,0)', () => {
    const d = empty()
    const k = addCircle(d, addPoint(d, 9, -2), 2)
    const s = bowTangentSnap(d, J, E, { x: 9, y: 3.3 }, 0.6, [])!
    expect(s.target).toEqual({ kind: 'circle', id: k })
    expect(s.center.y).toBeCloseTo(3.4, 9); expect(s.r).toBeCloseTo(3.4, 9)
    expect(s.touch.x).toBeCloseTo(9, 9); expect(s.touch.y).toBeCloseTo(0, 9)
    expect(s.side).toBe(1)
  })
  it('touches a big circle from inside: centre (9,7.25), radius 3.75, at (9,11)', () => {
    const d = empty()
    addCircle(d, addPoint(d, 9, 5), 6)
    const s = bowTangentSnap(d, J, E, { x: 9, y: 7.1 }, 0.6, [])!
    expect(s.side).toBe(-1)
    expect(s.center.y).toBeCloseTo(7.25, 9); expect(s.r).toBeCloseTo(3.75, 9)
    expect(s.touch.y).toBeCloseTo(11, 9)
  })
  it('touches an arc only on its drawn part', () => {
    const top = empty()
    const a = addPoint(top, 7, -2), b = addPoint(top, 11, -2), c = addPoint(top, 9, -2)
    const arc = addPath(top, [a, b], [{ kind: 'arc', center: c, sweep: 0 }])   // the upper half, through (9,0)
    const s = bowTangentSnap(top, J, E, { x: 9, y: 3.3 }, 0.6, [])!
    expect(s.target).toEqual({ kind: 'seg', pathId: arc, segIndex: 0 })
    expect(s.touch.y).toBeCloseTo(0, 9)
    const bottom = empty()
    const a2 = addPoint(bottom, 7, -2), b2 = addPoint(bottom, 11, -2), c2 = addPoint(bottom, 9, -2)
    addPath(bottom, [a2, b2], [{ kind: 'arc', center: c2, sweep: 1 }])         // the lower half
    expect(bowTangentSnap(bottom, J, E, { x: 9, y: 3.3 }, 0.6, [])).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-tangency.unit.spec.ts`
Expected: FAIL — `pieceOf` (etc.) is not exported.

- [ ] **Step 3: Append to `frontend/app/lib/sketch/tangency.ts`** — extend the imports at the top to

```ts
import type { SketchDoc, SketchEntity, SketchConstraint, PointEntity, CircleEntity, EntityId, ConstraintKind } from './model'
import { getEntity, getPoint } from './model'
import { dist, type Vec2 } from './geom'
import { curveGeom, allCurves, paramOf, pointAt, type CurveRef } from './crossings'
```
(and delete the old `import type { Vec2 } from './geom'` line), then append:

```ts
// ── pieces and the rule that makes two of them tangent ─────────────────────

export type TangentPiece =
  | { kind: 'line'; a: EntityId; b: EntityId; lineId?: EntityId }
  | { kind: 'arc'; c: EntityId; s: EntityId; e: EntityId }
  | { kind: 'circle'; id: EntityId; c: EntityId }

export interface RuleSpec { kind: ConstraintKind; refs: EntityId[]; value?: number }

export function curveKey(ref: CurveRef): string {
  return ref.kind === 'seg' ? `${ref.pathId}:${ref.segIndex}` : ref.id
}

/** A line entity, circle entity or path line/arc segment as a tangent piece;
 *  null for a Bézier segment or anything that no longer resolves. */
export function pieceOf(doc: SketchDoc, ref: CurveRef): TangentPiece | null {
  if (ref.kind === 'line') {
    const e = getEntity(doc, ref.id)
    return e && e.kind === 'line' ? { kind: 'line', a: e.p1, b: e.p2, lineId: e.id } : null
  }
  if (ref.kind === 'circle') {
    const e = getEntity(doc, ref.id)
    return e && e.kind === 'circle' ? { kind: 'circle', id: e.id, c: e.center } : null
  }
  const p = getEntity(doc, ref.pathId)
  if (!p || p.kind !== 'path') return null
  const segCount = p.closed ? p.anchors.length : p.anchors.length - 1
  if (ref.segIndex < 0 || ref.segIndex >= segCount) return null
  const seg = p.segments[ref.segIndex]
  const a = p.anchors[ref.segIndex], b = p.anchors[(ref.segIndex + 1) % p.anchors.length]
  if (!seg || !a || !b) return null
  if (seg.kind === 'line') return { kind: 'line', a, b }
  if (seg.kind === 'arc') return { kind: 'arc', c: seg.center, s: a, e: b }
  return null
}

const endsOf = (p: TangentPiece): EntityId[] => (p.kind === 'line' ? [p.a, p.b] : p.kind === 'arc' ? [p.s, p.e] : [])
// how a round piece is named in a rule: an arc by [centre, start], a circle by its id
const operandRefs = (p: Exclude<TangentPiece, { kind: 'line' }>): EntityId[] => (p.kind === 'arc' ? [p.c, p.s] : [p.id])

function roundGeom(doc: SketchDoc, p: Exclude<TangentPiece, { kind: 'line' }>): { c: Vec2; r: number } | null {
  const c = getPoint(doc, p.c)
  if (!c) return null
  if (p.kind === 'circle') {
    const e = getEntity(doc, p.id)
    return e && e.kind === 'circle' ? { c: { x: c.x, y: c.y }, r: e.r } : null
  }
  const s = getPoint(doc, p.s)
  return s ? { c: { x: c.x, y: c.y }, r: dist(c, s) } : null
}

/** The rule that makes pieces p and q tangent. Joined at a shared end → the
 *  joint forms the Pen already writes; apart → tangentLineArc / tangentArcs
 *  (a line entity and a circle keep tangentLineCircle). Null for two lines,
 *  or two round pieces on one centre. */
export function tangentRuleFor(doc: SketchDoc, p: TangentPiece, q: TangentPiece): RuleSpec | null {
  if (p.kind === 'line' && q.kind === 'line') return null
  if (q.kind === 'line') [p, q] = [q, p]   // a line always comes first
  const shared = endsOf(p).find(id => endsOf(q).includes(id))
  if (shared && p.kind === 'line' && q.kind === 'arc') {
    const other = p.a === shared ? p.b : p.a
    return { kind: 'perpendicular', refs: [other, shared, shared, q.c] }
  }
  if (shared && p.kind === 'arc' && q.kind === 'arc') return { kind: 'collinear', refs: [p.c, shared, q.c] }
  if (p.kind === 'line') {
    const round = q as Exclude<TangentPiece, { kind: 'line' }>
    if (round.kind === 'circle' && p.lineId) return { kind: 'tangentLineCircle', refs: [p.lineId, round.id] }
    return { kind: 'tangentLineArc', refs: [p.a, p.b, ...operandRefs(round)] }
  }
  const g1 = roundGeom(doc, p), g2 = roundGeom(doc, q as Exclude<TangentPiece, { kind: 'line' }>)
  if (!g1 || !g2) return null
  const d = dist(g1.c, g2.c)
  if (d < 1e-9) return null
  const side = Math.abs(d - (g1.r + g2.r)) <= Math.abs(d - Math.abs(g1.r - g2.r)) ? 1 : -1
  return { kind: 'tangentArcs', refs: [...operandRefs(p), ...operandRefs(q as Exclude<TangentPiece, { kind: 'line' }>)], value: side }
}

// ── the Pen's bow snap ──────────────────────────────────────────────────────

export interface BowTangentSnap { center: Vec2; r: number; target: CurveRef; touch: Vec2; side: 1 | -1 }

function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b]
  const disc = b * b - 4 * a * c
  if (disc < 0) return []
  const sq = Math.sqrt(disc)
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]
}

function curveUsesAny(doc: SketchDoc, ref: CurveRef, pts: Set<EntityId>): boolean {
  const p = pieceOf(doc, ref)
  if (!p) return true
  if (p.kind === 'line') return pts.has(p.a) || pts.has(p.b)
  if (p.kind === 'arc') return pts.has(p.c) || pts.has(p.s) || pts.has(p.e)
  return pts.has(p.c)
}

/** The arc being bowed runs through J and E; `freeCenter` is where the pointer
 *  alone puts its centre. If its circle nearly touches (within `tol`, drawing
 *  units) a line, circle or path line/arc segment — none built on
 *  `skipPoints` — returns the exact touching circle of the same family (centre
 *  on the chord's perpendicular bisector) and where it touches. */
export function bowTangentSnap(doc: SketchDoc, J: Vec2, E: Vec2, freeCenter: Vec2, tol: number, skipPoints: EntityId[]): BowTangentSnap | null {
  const L = dist(J, E)
  if (L < 1e-9) return null
  const h = L / 2
  const M = { x: (J.x + E.x) / 2, y: (J.y + E.y) / 2 }
  const n = { x: -(E.y - J.y) / L, y: (E.x - J.x) / L }
  const sFree = (freeCenter.x - M.x) * n.x + (freeCenter.y - M.y) * n.y
  const rFree = Math.hypot(h, sFree)
  const at = (s: number): Vec2 => ({ x: M.x + s * n.x, y: M.y + s * n.y })
  const skip = new Set(skipPoints)
  let best: (BowTangentSnap & { gap: number }) | null = null
  for (const ref of allCurves(doc)) {
    if (curveUsesAny(doc, ref, skip)) continue
    const g = curveGeom(doc, ref)
    if (!g) continue
    const cands: { s: number; touch: Vec2; side: 1 | -1 }[] = []
    let gap: number
    if (g.kind === 'line') {
      const a = g.a!, b = g.b!
      const ll = dist(a, b)
      if (ll < 1e-9) continue
      const u = { x: -(b.y - a.y) / ll, y: (b.x - a.x) / ll }
      const d0 = (M.x - a.x) * u.x + (M.y - a.y) * u.y
      const k = n.x * u.x + n.y * u.y
      gap = Math.abs(Math.abs(d0 + sFree * k) - rFree)
      // (d0 + s·k)² = h² + s²
      for (const s of quadraticRoots(k * k - 1, 2 * d0 * k, d0 * d0 - h * h)) {
        const C = at(s)
        const sd = (C.x - a.x) * u.x + (C.y - a.y) * u.y
        const touch = { x: C.x - sd * u.x, y: C.y - sd * u.y }
        const t = ((touch.x - a.x) * (b.x - a.x) + (touch.y - a.y) * (b.y - a.y)) / (ll * ll)
        if (t < 0 || t > 1) continue
        cands.push({ s, touch, side: 1 })
      }
    } else {
      const Q = g.c!, R = g.r!
      const w = { x: M.x - Q.x, y: M.y - Q.y }
      const ww = w.x * w.x + w.y * w.y
      const wn = w.x * n.x + w.y * n.y
      const dFree = dist(freeCenter, Q)
      // outside and inside are separate snaps: a root only counts on a side whose own gap is in reach
      const gapOut = Math.abs(dFree - (rFree + R)), gapIn = Math.abs(dFree - Math.abs(rFree - R))
      gap = Math.min(gapOut, gapIn)
      // |C−Q|² − r² − R² = ±2rR, i.e. (A0 + 2s·wn)² = 4R²(h² + s²)
      const A0 = ww - h * h - R * R
      for (const s of quadraticRoots(4 * wn * wn - 4 * R * R, 4 * A0 * wn, A0 * A0 - 4 * R * R * h * h)) {
        const C = at(s)
        const r = Math.hypot(h, s)
        const dq = dist(C, Q)
        if (dq < 1e-9) continue
        const side: 1 | -1 = A0 + 2 * s * wn >= 0 ? 1 : -1
        if ((side === 1 ? gapOut : gapIn) > tol) continue
        const ux = (C.x - Q.x) / dq, uy = (C.y - Q.y) / dq
        // outside, or this circle inside the target: on the target towards C; target inside this one: away from C
        const touch = side === 1 || R > r ? { x: Q.x + R * ux, y: Q.y + R * uy } : { x: Q.x - R * ux, y: Q.y - R * uy }
        if (g.kind === 'arc' && dist(pointAt(g, paramOf(g, touch)), touch) > 1e-6 * Math.max(1, R)) continue
        cands.push({ s, touch, side })
      }
    }
    if (gap > tol || !cands.length) continue
    const pick = cands.reduce((m, c) => (Math.abs(c.s - sFree) < Math.abs(m.s - sFree) ? c : m))
    const r = Math.hypot(h, pick.s)
    if (r > 1e4) continue
    if (!best || gap < best.gap) best = { center: at(pick.s), r, target: ref, touch: pick.touch, side: pick.side, gap }
  }
  if (!best) return null
  return { center: best.center, r: best.r, target: best.target, touch: best.touch, side: best.side }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-tangency.unit.spec.ts tests/unit/sketch-tangent-rules.unit.spec.ts tests/unit/sketch-crossings.unit.spec.ts`
Expected: all PASS. Typecheck `lib/sketch/tangency.ts` as in Task 1 — no output.

- [ ] **Step 5: Commit** `frontend/app/lib/sketch/tangency.ts frontend/tests/unit/sketch-tangency.unit.spec.ts` — message `feat(sketch): the tangent rule for any two pieces, and the tangent snap for a bowing arc`.

---

### Task 3: Tangent and Equal in the rules row, with their tooltip cards

**Files:**
- Modify: `frontend/app/composables/pen/penRules.ts`
- Modify: `frontend/app/composables/pen/usePen.ts` (`pick`, `pickSegment`, `applyWithValue`, new `applyTangent`, return object)
- Modify: `frontend/app/composables/pen/penTips.ts`
- Modify: `frontend/tests/unit/pen-tips.unit.spec.ts` (the rule sweep)
- Test: `frontend/tests/unit/pen-tangent-verbs.unit.spec.ts`

**Behaviour (spec §"Tangent after the fact", with rulings):**
- Select two pieces — any mix of path line/arc segments (Option-click), line entities and circle entities (plain click / Shift-click) → **Tangent** appears in the rules row whenever `tangentRuleFor` has a rule for them; clicking it writes that rule (joint form when joined), solves, sparkles at the badge, clears the selection, one history step.
- **Ruling:** the entity + segment pairing that stage 3 allowed for one point + one segment now also allows one line or circle entity + one segment (so a line or circle can be paired with an Option-clicked arc). Any other mix still clears as today.
- **Ruling:** two whole entities keep today's verbs — line entity + circle keeps its existing Tangent (`tangentLineCircle`), two circles keep Concentric / Tangent (`tangentCircleCircle`) / Equal. The new Tangent is offered only when at least one path segment is selected.
- Two arc segments also get **Equal** (same radius) = `equalDist [C1, A1, C2, A2]` — the same rule kind the two-line Equal uses, so (like the two-line Equal) it has no badge. **Ruling:** Equal is only for two arc segments in v1 (not arc + circle).
- **Ruling:** applying Tangent when the identical rule already exists adds nothing (still one clean step, no duplicate).
- Point + arc segment keeps On curve only (unchanged).
- New tooltip cards: `tangent` and `equalArcs`.

**Interfaces:**
- Consumes: Task 2 `pieceOf`, `tangentRuleFor`, `RuleSpec`; `sameKey` from `lib/sketch/trim.ts`.
- Produces:
  - `RuleOption` gains `tangent?: boolean`.
  - `penRules.ts`: `export function tangentRuleForSelection(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleSpec | null` and `export function isArcSegment(doc: SketchDoc, seg: SegRef): boolean`.
  - `usePen` returns `applyTangent(): void`; `applyWithValue(v)` routes `v.tangent` to it.
  - Rules-row buttons: `data-verb="tangent"` (label "Tangent"), `data-verb="equalArcs"` (label "Equal").

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-tangent-verbs.unit.spec.ts`:

```ts
// tests/unit/pen-tangent-verbs.unit.spec.ts
// Pen stage 4, "Tangent after the fact": two selected pieces (path segments,
// lines, circles — joined or not) offer Tangent, which writes the joint form
// when they meet and the new forms when they don't; two arc segments also
// offer Equal. One history step each.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen }
}
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const tangentOf = (pen: ReturnType<typeof usePen>) => pen.availableConstraints().find(o => o.tip === 'tangent')
const maxResidual = (d: SketchDoc) => Math.max(0, ...constraintResiduals(d).map(Math.abs))

describe('Tangent on two segments that don’t meet', () => {
  it('a line segment and an arc segment → tangentLineArc, solved, one undo step', () => {
    let la = '', lb = '', A = '', C = '', line = '', arc = ''
    const { doc, pen } = mk(d => {
      la = addPoint(d, 3, 4); lb = addPoint(d, 11, 4)
      line = addPath(d, [la, lb], [{ kind: 'line' }])
      A = addPoint(d, 4, 6); const B = addPoint(d, 10, 6); C = addPoint(d, 7, 9)
      arc = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    })
    const before = doc.value.constraints.length
    pen.pickSegment(line, 0); pen.pickSegment(arc, 0, true)
    const opt = tangentOf(pen)!
    expect(opt).toMatchObject({ label: 'Tangent', tip: 'tangent', tangent: true })
    pen.applyWithValue(opt)
    const k = doc.value.constraints.find(c => c.kind === 'tangentLineArc')!
    expect(k.refs).toEqual([la, lb, C, A])
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
    expect(pen.selectedSegments.value).toEqual([])
    expect(pen.sparkleCount()).toBeGreaterThan(0)
    pen.undo()
    expect(doc.value.constraints.length).toBe(before)
  })
  it('applying it twice leaves one rule', () => {
    let line = '', arc = ''
    const { doc, pen } = mk(d => {
      line = addPath(d, [addPoint(d, 3, 4), addPoint(d, 11, 4)], [{ kind: 'line' }])
      arc = addPath(d, [addPoint(d, 4, 6), addPoint(d, 10, 6)], [{ kind: 'arc', center: addPoint(d, 7, 9), sweep: 1 }])
    })
    for (let i = 0; i < 2; i++) { pen.pickSegment(line, 0); pen.pickSegment(arc, 0, true); pen.applyWithValue(tangentOf(pen)!) }
    expect(doc.value.constraints.filter(c => c.kind === 'tangentLineArc')).toHaveLength(1)
  })
  it('two arc segments → Tangent (side from the geometry) and Equal', () => {
    let a1 = '', a2 = '', C1 = '', S1 = '', C2 = '', S2 = ''
    const { doc, pen } = mk(d => {
      S1 = addPoint(d, 4, 6); C1 = addPoint(d, 7, 9)
      a1 = addPath(d, [S1, addPoint(d, 10, 6)], [{ kind: 'arc', center: C1, sweep: 1 }])
      S2 = addPoint(d, 14, 9); C2 = addPoint(d, 15, 9)
      a2 = addPath(d, [S2, addPoint(d, 16, 9)], [{ kind: 'arc', center: C2, sweep: 1 }])
    })
    pen.pickSegment(a1, 0); pen.pickSegment(a2, 0, true)
    const opts = pen.availableConstraints()
    expect(opts.map(o => o.tip ?? o.kind)).toEqual(['tangent', 'equalArcs'])
    pen.applyWithValue(opts[0]!)
    expect(doc.value.constraints.find(c => c.kind === 'tangentArcs')).toMatchObject({ refs: [C1, S1, C2, S2], value: 1 })
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
    pen.pickSegment(a1, 0); pen.pickSegment(a2, 0, true)
    pen.applyWithValue(pen.availableConstraints().find(o => o.tip === 'equalArcs')!)
    expect(doc.value.constraints.some(c => c.kind === 'equalDist' && c.refs.join() === [C1, S1, C2, S2].join())).toBe(true)
    const r1 = Math.hypot(P(doc.value, S1).x - P(doc.value, C1).x, P(doc.value, S1).y - P(doc.value, C1).y)
    const r2 = Math.hypot(P(doc.value, S2).x - P(doc.value, C2).x, P(doc.value, S2).y - P(doc.value, C2).y)
    expect(r1).toBeCloseTo(r2, 4)
  })
  it('two line segments get no Tangent', () => {
    let path = ''
    const { pen } = mk(d => { path = addPath(d, [addPoint(d, 0, 0), addPoint(d, 5, 0), addPoint(d, 5, 5)], [{ kind: 'line' }, { kind: 'line' }]) })
    pen.pickSegment(path, 0); pen.pickSegment(path, 1, true)
    expect(tangentOf(pen)).toBeUndefined()
  })
})

describe('Tangent where the pieces already meet', () => {
  it('a line then an arc in one path → the joint rule, and the corner turns smooth', () => {
    let P0 = '', A = '', C = '', path = ''
    const { doc, pen } = mk(d => {
      P0 = addPoint(d, 1, 6); A = addPoint(d, 4, 6); C = addPoint(d, 7, 9)
      path = addPath(d, [P0, A, addPoint(d, 10, 6)], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }])
    })
    pen.pickSegment(path, 1); pen.pickSegment(path, 0, true)
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.find(c => c.kind === 'perpendicular')!.refs).toEqual([P0, A, A, C])
    const p0 = P(doc.value, P0), a = P(doc.value, A), c = P(doc.value, C)
    expect((a.x - p0.x) * (c.x - a.x) + (a.y - p0.y) * (c.y - a.y)).toBeCloseTo(0, 4)
  })
})

describe('Tangent with a whole line or circle', () => {
  it('a line entity kept with an Option-clicked arc → tangentLineArc on the line’s ends', () => {
    let l = '', a = '', b = '', C = '', A = '', arc = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 2); b = addPoint(d, 14, 2); l = addLine(d, a, b)
      A = addPoint(d, 4, 6); C = addPoint(d, 7, 9)
      arc = addPath(d, [A, addPoint(d, 10, 6)], [{ kind: 'arc', center: C, sweep: 1 }])
    })
    pen.pick(l)
    pen.pickSegment(arc, 0)
    expect(pen.selection.value).toEqual([l])
    expect(pen.selectedSegments.value).toEqual([{ pathId: arc, segIndex: 0 }])
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.find(c => c.kind === 'tangentLineArc')!.refs).toEqual([a, b, C, A])
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
  })
  it('a circle with a line segment → tangentLineArc [A, B, circle]', () => {
    let k = '', la = '', lb = '', line = ''
    const { doc, pen } = mk(d => {
      k = addCircle(d, addPoint(d, 7, 9), 2)
      la = addPoint(d, 0, 4); lb = addPoint(d, 14, 4)
      line = addPath(d, [la, lb], [{ kind: 'line' }])
    })
    pen.pickSegment(line, 0)
    pen.pick(k, true)
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.find(c => c.kind === 'tangentLineArc')!.refs).toEqual([la, lb, k])
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
  })
  it('a point with an arc segment still offers On curve only', () => {
    let p = '', arc = ''
    const { pen } = mk(d => {
      p = addPoint(d, 20, 20)
      arc = addPath(d, [addPoint(d, 4, 6), addPoint(d, 10, 6)], [{ kind: 'arc', center: addPoint(d, 7, 9), sweep: 1 }])
    })
    pen.pick(p); pen.pickSegment(arc, 0)
    expect(pen.availableConstraints().map(o => o.tip ?? o.kind)).toEqual(['onCurve'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-tangent-verbs.unit.spec.ts`
Expected: FAIL — no option with tip `tangent`.

- [ ] **Step 3: `penRules.ts`**

(a) Imports and `RuleOption`:
```ts
import type { SketchDoc, EntityId, ConstraintKind } from '~/lib/sketch/model'
import type { CurveRef } from '~/lib/sketch/crossings'
import { pieceOf, tangentRuleFor, type RuleSpec } from '~/lib/sketch/tangency'

// `tangent`: the button runs the pen's applyTangent (the rule kind is worked
// out from the two pieces — the joint form when they meet), not apply(kind)
export interface RuleOption { kind: ConstraintKind; label: string; value?: boolean; tip?: string; tangent?: boolean }
```

(b) Add, below `isLineSegment`:
```ts
export function isArcSegment(doc: SketchDoc, seg: SegRef): boolean {
  const path = doc.entities.find(e => e.id === seg.pathId) as any
  return !!path && path.kind === 'path' && path.segments[seg.segIndex]?.kind === 'arc'
}

// the selection as tangent pieces: line and circle entities, then path
// segments. Empty when anything else (a point, a whole path) is selected.
function selectedCurveRefs(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): CurveRef[] {
  const out: CurveRef[] = []
  for (const id of selection) {
    const e = doc.entities.find(x => x.id === id)
    if (e?.kind === 'line') out.push({ kind: 'line', id })
    else if (e?.kind === 'circle') out.push({ kind: 'circle', id })
    else return []
  }
  for (const s of segments) out.push({ kind: 'seg', pathId: s.pathId, segIndex: s.segIndex })
  return out
}

/** The tangent rule for exactly two selected pieces, at least one of them a
 *  path segment (two whole entities keep their own Tangent verbs). */
export function tangentRuleForSelection(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleSpec | null {
  if (!segments.length) return null
  const refs = selectedCurveRefs(doc, selection, segments)
  if (refs.length !== 2) return null
  const p = pieceOf(doc, refs[0]!), q = pieceOf(doc, refs[1]!)
  return p && q ? tangentRuleFor(doc, p, q) : null
}

function tangentOption(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleOption | null {
  const rule = tangentRuleForSelection(doc, selection, segments)
  return rule ? { kind: rule.kind, label: 'Tangent', tip: 'tangent', tangent: true } : null
}
```

(c) In `availableConstraints`, replace the first line of the entity+segment branch
```ts
    if (ids.length !== 1 || kinds[0] !== 'point' || segments.length !== 1) return out
```
with
```ts
    // one line or circle + one segment: Tangent
    if (ids.length === 1 && segments.length === 1 && (kinds[0] === 'line' || kinds[0] === 'circle')) {
      const t = tangentOption(doc, ids, segments)
      if (t) out.push(t)
      return out
    }
    if (ids.length !== 1 || kinds[0] !== 'point' || segments.length !== 1) return out
```
and replace the two-segment block
```ts
  if (!ids.length && segments.length === 2) {
    const [s1, s2] = segments as [SegRef, SegRef]
    if (isLineSegment(doc, s1) && isLineSegment(doc, s2)) {
      out.push({ kind: 'perpendicular', label: 'Perpendicular' }, { kind: 'parallel', label: 'Parallel' }, { kind: 'equalDist', label: 'Equal' })
    }
  }
```
with
```ts
  if (!ids.length && segments.length === 2) {
    const [s1, s2] = segments as [SegRef, SegRef]
    if (isLineSegment(doc, s1) && isLineSegment(doc, s2)) {
      out.push({ kind: 'perpendicular', label: 'Perpendicular' }, { kind: 'parallel', label: 'Parallel' }, { kind: 'equalDist', label: 'Equal' })
    } else {
      const t = tangentOption(doc, [], segments)
      if (t) out.push(t)
      if (isArcSegment(doc, s1) && isArcSegment(doc, s2)) out.push({ kind: 'equalDist', label: 'Equal', tip: 'equalArcs' })
    }
  }
```
Also add `'tangentLineArc', 'tangentArcs'` to `EXACT_GEOMETRY_RULES`.

(d) In `segmentConstraintRefs`, before the line-only guard, add the arc Equal:
```ts
  // two arc segments: Equal = the same radius, equalDist [C1, A1, C2, A2]
  if (kind === 'equalDist' && segs.length === 2 && segs.every(s => isArcSegment(doc, s))) {
    const pair = segs.map(s => {
      const path = doc.entities.find(e => e.id === s.pathId) as any
      return { c: path.segments[s.segIndex].center as EntityId, a: path.anchors[s.segIndex] as EntityId }
    })
    return [pair[0]!.c, pair[0]!.a, pair[1]!.c, pair[1]!.a]
  }
```
Update the guard's comment to "all other segment verbs are line-only".

- [ ] **Step 4: `usePen.ts`**

(a) Imports: add `tangentRuleForSelection` to the `./penRules` import list.

(b) Selection pairing — add next to `isPointId`:
```ts
  function isLineOrCircleId(id: EntityId) {
    const k = (doc.value.entities.find(e => e.id === id) as any)?.kind
    return k === 'line' || k === 'circle'
  }
```
In `pick`, change
```ts
    const pairs = selectedSegments.value.length === 1 && (sel.length === 0 || (sel.length === 1 && isPointId(sel[0]!)))
```
to
```ts
    const pairs = selectedSegments.value.length === 1 && (sel.length === 0 || (sel.length === 1 && (isPointId(sel[0]!) || isLineOrCircleId(sel[0]!))))
```
In `pickSegment`, change
```ts
    const pairs = selectedSegments.value.length <= 1 && sel.length === 1 && isPointId(sel[0]!)
```
to
```ts
    const pairs = selectedSegments.value.length <= 1 && sel.length === 1 && (isPointId(sel[0]!) || isLineOrCircleId(sel[0]!))
```
Update both functions' comments: the kept pairing is "one point, line or circle + one Option-clicked segment".

(c) Add `applyTangent` after `apply`:
```ts
  // Tangent (penRules tangentRuleForSelection): the rule for the two selected
  // pieces — the joint form where they meet, tangentLineArc / tangentArcs
  // where they don't. An identical rule already there is not added twice.
  function applyTangent() {
    const rule = tangentRuleForSelection(doc.value, selection.value, selectedSegments.value)
    clearSel()
    clearSegSel()
    if (!rule) return
    const key = sameKey({ id: '', kind: rule.kind, refs: rule.refs, value: rule.value })
    if (!doc.value.constraints.some(c => sameKey(c) === key)) {
      const id = addConstraint(doc.value, rule.kind, rule.refs, rule.value)
      runSolve()
      sparkleAtConstraint(id)
    }
    commitHistory()
  }
```
(d) `applyWithValue`:
```ts
  async function applyWithValue(v: { kind: ConstraintKind; label: string; value?: boolean; tangent?: boolean }) {
    if (v.tangent) { applyTangent(); return }
    if (!v.value) { apply(v.kind); return }
    ...unchanged
```
(e) Add `applyTangent` to the returned object's `// verbs` line.

- [ ] **Step 5: `penTips.ts`** — in the rules block add:
```ts
  tangent: { name: 'Tangent',
    caption: 'Makes two pieces touch at one point without crossing. Pieces that already meet turn smoothly through the join.' },
  equalArcs: { name: 'Equal',
    caption: 'Makes two arcs the same radius.' },
```

- [ ] **Step 6: Extend the tip sweep** — in `frontend/tests/unit/pen-tips.unit.spec.ts`, inside `everyRuleKind()` after the two existing point + segment `add(...)` calls, add:
```ts
  // two arcs, a line and an arc, a line entity with an arc (stage 4 Tangent / Equal)
  const g = addPoint(doc, 60, 0), h = addPoint(doc, 64, 0), k = addPoint(doc, 62, 0)
  const arc2 = addPath(doc, [g, h], [{ kind: 'arc', center: k, sweep: 1 }])
  add([], [{ pathId: arc, segIndex: 0 }, { pathId: arc2, segIndex: 0 }])
  add([], [{ pathId: path, segIndex: 0 }, { pathId: arc, segIndex: 0 }])
  add([l1], [{ pathId: arc, segIndex: 0 }])
```
and add `'tangent', 'equalArcs'` to the list in the test `'the rule sweep finds the rules row vocabulary'`.

- [ ] **Step 7: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-tangent-verbs.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-rules.unit.spec.ts tests/unit/pen-weld.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-snap.unit.spec.ts`
Expected: all PASS. Typecheck `composables/pen/(penRules|usePen|penTips)\.ts` — no new errors.

- [ ] **Step 8: Browser check (real mouse)** — the rules-row button must reach the page. Run the host specs: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-weld.spec.ts tests/pen-tips.spec.ts --project=chromium` — expected: all pass (the Tangent button itself is exercised with a real mouse in Task 6).

- [ ] **Step 9: Commit** `frontend/app/composables/pen/penRules.ts frontend/app/composables/pen/usePen.ts frontend/app/composables/pen/penTips.ts frontend/tests/unit/pen-tips.unit.spec.ts frontend/tests/unit/pen-tangent-verbs.unit.spec.ts` — message `feat(pen): Tangent for any two pieces, joined or not, and Equal for two arcs`.

---

### Task 4: Tangent snapping while drawing — the bowing arc, and a line leaving an arc

**Files:**
- Modify: `frontend/app/lib/sketch/infer.ts` (export `sweepFor`)
- Modify: `frontend/app/composables/pen/usePen.ts` (`bowArc` refactor, new `arcShape`, `snapArcTangent`, `bowPreview`, `commitBowedSegment`, `applyArcDimension`, `setPathDrag`, `pathMove`, `pathPlacement`, `captureArcTangent`, `pathDown`, `pathClick`, return object)
- Modify: `frontend/app/components/pen/PenOverlay.vue` (`pathBowChip`, ghost circle, tangent chips)
- Test: `frontend/tests/unit/pen-bow-tangent.unit.spec.ts`

**Behaviour (spec §"Snapping while drawing", with rulings):**
- While the Pen bows a segment into an arc, if its ghost circle comes within `SNAP_PX` (screen px) of touching a line, circle or path line/arc segment it isn't built on (Task 2's `bowTangentSnap`, skip points = the segment's two anchors), the arc snaps to the exact touching circle: the ghost circle and the R chip show the snapped radius, the ghost turns green, a **T** chip sits at the touch point on the other curve (`data-bow-tangent`), and a sparkle marks the moment it engages (once per target, not every move). Releasing writes the rule from `tangentRuleFor(arc piece, target piece)` (`tangentLineArc [A, B, C, S]`, `tangentArcs [C, S, …]` with the side) and sparkles at the touch point.
- **Ruling:** the existing joint tangency (the arc continuing smoothly from the previous segment, `snappedTangent`) wins: when it has snapped, the bow snap is not tried.
- **Ruling:** a typed radius (type-a-dimension while bowing) skips the bow snap — the typed value wins.
- **Ruling:** only committed geometry is a target; earlier segments of the path still being drawn are not (they are not in the drawing yet).
- A line placed from the end of an arc (the Pen's next click after an arc segment) snaps onto the arc's forward tangent line when the rubber band is within `PERP_SNAP_RAD` (4°, the right-angle snap's tolerance — **Ruling**) of it, pointing forward (the direction the arc was travelling — **Ruling**: never backwards). A **T** chip at the joint shows it (`data-tangent-chip`); placing the point writes `perpendicular [C, E, E, new]` (the joint form) and sparkles. If that press then bows into an arc, the rule is dropped exactly as the right-angle rule is (`pathDrag.perp`).

**Interfaces:**
- Consumes: Task 2 `bowTangentSnap`, `BowTangentSnap`, `pieceOf`, `tangentRuleFor`, `curveKey`.
- Produces:
  - `infer.ts`: `export function sweepFor(J: Vec2, end: Vec2, pointer: Vec2, C: Vec2): 0 | 1` (unchanged body, just exported).
  - `usePen.ts` module exports: `arcShape(J, end, pointer, center): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2 }`, `snapArcTangent(C: Vec2, E: Vec2, sweep: 0 | 1, pt: Vec2, tolRad: number): { pt: Vec2; snapped: boolean }`, `interface BowPreview { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean; touch: BowTangentSnap | null }`.
  - The pen returns `bowPreview(pointer: Vec2 | null, o?: { snap?: boolean }): BowPreview | null`; `placementPreview.value` gains `tangent: boolean`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-bow-tangent.unit.spec.ts`:

```ts
// tests/unit/pen-bow-tangent.unit.spec.ts
// Pen stage 4, snapping while drawing: a bowing arc's circle snaps to touch a
// nearby line, circle or arc (and releasing writes the rule); the joint's own
// tangency wins; a typed radius skips it; a line leaving an arc's end along
// its direction snaps onto the tangent and writes the joint rule.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { usePen, snapArcTangent } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }   // SNAP_PX = 0.6 units here
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV) })
  pen.selectTool('path')
  return { doc, pen }
}
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const lastPath = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path').pop() as any

// the Pen: click (6,5), then press (12,5) and bow through `pointer`
function bowFrom6to12(pen: ReturnType<typeof usePen>, pointer: { x: number; y: number }, release = true) {
  pen.pathDown(6, 5); pen.pathUp(6, 5)
  pen.pathDown(12, 5)
  pen.pathMove((12 + pointer.x) / 2, (5 + pointer.y) / 2)
  pen.pathMove(pointer.x, pointer.y)
  if (release) { pen.pathUp(pointer.x, pointer.y); pen.finishPath(false) }
}

describe('a bowing arc snaps tangent', () => {
  it('to a line: the preview locks the radius, and releasing writes tangentLineArc [A, B, C, S]', () => {
    let l1 = '', l2 = ''
    const { doc, pen } = mk(d => { l1 = addPoint(d, 2, 2); l2 = addPoint(d, 16, 2); addLine(d, l1, l2) })
    bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
    const pv = pen.bowPreview({ x: 9, y: 2.1 })!
    expect(pv.touch).not.toBeNull()
    expect(pv.center.x).toBeCloseTo(9, 9); expect(pv.center.y).toBeCloseTo(5, 9)
    expect(pv.r).toBeCloseTo(3, 9)
    expect(pv.touch!.touch.y).toBeCloseTo(2, 9)
    expect(pen.sparkleCount()).toBeGreaterThan(0)   // engaging sparkles
    pen.pathUp(9, 2.1); pen.finishPath(false)
    const path = lastPath(doc.value)
    const C = path.segments[0].center
    const k = doc.value.constraints.find(c => c.kind === 'tangentLineArc')!
    expect(k.refs).toEqual([l1, l2, C, path.anchors[0]])
    expect(P(doc.value, C).y).toBeCloseTo(5, 4)
  })
  it('to a circle, from outside', () => {
    let k = ''
    const { doc, pen } = mk(d => { k = addCircle(d, addPoint(d, 9, -2), 2) })
    bowFrom6to12(pen, { x: 9, y: -0.148 })   // the free arc's centre ≈ (9, 3.3)
    const path = lastPath(doc.value)
    expect(doc.value.constraints.find(c => c.kind === 'tangentArcs')).toMatchObject({ refs: [path.segments[0].center, path.anchors[0], k], value: 1 })
  })
  it('to an arc segment, on its drawn part', () => {
    let c2 = '', a2 = ''
    const { doc, pen } = mk(d => {
      a2 = addPoint(d, 7, -2); c2 = addPoint(d, 9, -2)
      addPath(d, [a2, addPoint(d, 11, -2)], [{ kind: 'arc', center: c2, sweep: 0 }])
    })
    bowFrom6to12(pen, { x: 9, y: -0.148 })
    const path = lastPath(doc.value)
    expect(doc.value.constraints.find(c => c.kind === 'tangentArcs')).toMatchObject({ refs: [path.segments[0].center, path.anchors[0], c2, a2], value: 1 })
  })
  it('the joint’s own tangency wins over a nearby line', () => {
    const { doc, pen } = mk(d => { addLine(d, addPoint(d, 2, 8.2), addPoint(d, 16, 8.2)) })
    // a vertical line (6,0)→(6,5), then an arc to (12,5) that leaves it smoothly (centre (9,5), top at y=8)
    pen.pathDown(6, 0); pen.pathUp(6, 0)
    pen.pathDown(6, 5); pen.pathUp(6, 5)
    pen.pathDown(12, 5); pen.pathMove(10, 7); pen.pathMove(9, 8.05)
    const pv = pen.bowPreview({ x: 9, y: 8.05 })!
    expect(pv.snappedTangent).toBe(true)
    expect(pv.touch).toBeNull()
    pen.pathUp(9, 8.05); pen.finishPath(false)
    expect(doc.value.constraints.some(c => c.kind === 'tangentLineArc')).toBe(false)
  })
  it('a typed radius skips the snap', () => {
    const { doc, pen } = mk(d => { addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2)) })
    bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
    pen.dimBuffer.value = '4'
    pen.commitDimension()
    pen.finishPath(false)
    expect(doc.value.constraints.some(c => c.kind === 'tangentLineArc')).toBe(false)
  })
  it('no snap when nothing is near', () => {
    const { doc, pen } = mk(d => { addLine(d, addPoint(d, 2, -6), addPoint(d, 16, -6)) })
    bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
    expect(pen.bowPreview({ x: 9, y: 2.1 })!.touch).toBeNull()
    expect(pen.sparkleCount()).toBe(0)
    pen.pathUp(9, 2.1); pen.finishPath(false)
    expect(doc.value.constraints.some(c => c.kind === 'tangentLineArc')).toBe(false)
  })
})

describe('a line leaving an arc’s end', () => {
  it('snapArcTangent: forward only, within the tolerance', () => {
    const C = { x: 7, y: 9 }, E = { x: 10, y: 6 }   // ccw travel at E points up-right (1,1)/√2
    const on = snapArcTangent(C, E, 1, { x: 12.2, y: 8.05 }, (4 * Math.PI) / 180)
    expect(on.snapped).toBe(true)
    expect(on.pt.x - E.x).toBeCloseTo(on.pt.y - E.y, 9)
    expect(snapArcTangent(C, E, 1, { x: 8, y: 4 }, (4 * Math.PI) / 180).snapped).toBe(false)     // backwards
    expect(snapArcTangent(C, E, 1, { x: 12.5, y: 7 }, (4 * Math.PI) / 180).snapped).toBe(false)  // too far off
    expect(snapArcTangent(C, E, 0, { x: 12.2, y: 8.05 }, (4 * Math.PI) / 180).snapped).toBe(false) // cw arc travels the other way
  })
  it('the Pen snaps the next point onto the tangent and writes perpendicular [C, E, E, new]', () => {
    const { doc, pen } = mk(() => {})
    pen.nextSegment.value = 'arc'
    pen.place(4, 6); pen.place(10, 6)          // arc centred (7,9), travelling ccw into (10,6)
    pen.nextSegment.value = 'line'
    pen.pathMove(12.2, 8.05)
    expect(pen.placementPreview.value?.tangent).toBe(true)
    pen.pathDown(12.2, 8.05); pen.pathUp(12.2, 8.05)
    pen.finishPath(false)
    const path = lastPath(doc.value)
    const [, E, N] = path.anchors
    const C = path.segments[0].center
    expect(doc.value.constraints.find(c => c.kind === 'perpendicular')!.refs).toEqual([C, E, E, N])
    const c = P(doc.value, C), e = P(doc.value, E), n = P(doc.value, N)
    expect((e.x - c.x) * (n.x - e.x) + (e.y - c.y) * (n.y - e.y)).toBeCloseTo(0, 6)
  })
  it('bowing that press into an arc drops the line’s tangent rule', () => {
    const { doc, pen } = mk(() => {})
    pen.nextSegment.value = 'arc'
    pen.place(4, 6); pen.place(10, 6)
    pen.nextSegment.value = 'line'
    pen.pathMove(12.2, 8.05)
    pen.pathDown(12.2, 8.05); pen.pathMove(12.5, 6.5); pen.pathMove(12.8, 6)
    pen.pathUp(12.8, 6); pen.finishPath(false)
    const path = lastPath(doc.value)
    const E = path.anchors[1], C = path.segments[0].center
    expect(doc.value.constraints.some(c => c.kind === 'perpendicular' && c.refs[0] === C && c.refs[1] === E && c.refs[2] === E)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-bow-tangent.unit.spec.ts`
Expected: FAIL — `snapArcTangent` / `bowPreview` do not exist.

- [ ] **Step 3: `infer.ts`** — change `function sweepFor(` to `export function sweepFor(` (body unchanged).

- [ ] **Step 4: `usePen.ts` module level**

(a) Imports: add `sweepFor` to the `~/lib/sketch/infer` import; add `import { bowTangentSnap, pieceOf, tangentRuleFor, curveKey, type BowTangentSnap } from '~/lib/sketch/tangency'`.

(b) Replace `bowArc` with the refactor below (same results — `arcShape` recomputes exactly what `bowArc` computed, from the same centre) and add `arcShape`, `BowPreview`, `snapArcTangent`:
```ts
// the SVG arc through J → end with this centre, on the pointer's side:
// radius, sweep (1 = ccw in drawing coords, matching pathD), large-arc flag,
// and the drawn arc's middle
export function arcShape(J: Vec2, end: Vec2, pointer: Vec2, center: Vec2): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2 } {
  const TAU = Math.PI * 2
  const r = Math.hypot(J.x - center.x, J.y - center.y)
  const sweep = sweepFor(J, end, pointer, center)
  const a0 = Math.atan2(J.y - center.y, J.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  const ccw = ((a1 - a0) % TAU + TAU) % TAU
  const span = sweep === 1 ? ccw : TAU - ccw
  const large: 0 | 1 = span > Math.PI ? 1 : 0
  const am = sweep === 1 ? a0 + span / 2 : a0 - span / 2
  return { center, r, sweep, large, mid: { x: center.x + r * Math.cos(am), y: center.y + r * Math.sin(am) } }
}

export function bowArc(J: Vec2, end: Vec2, pointer: Vec2, tangentDir: Vec2 | null): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean } | null {
  const arc = tangentJointArc(J, end, pointer, tangentDir)
  if (!arc || arc.radius > 1e4) return null
  return { ...arcShape(J, end, pointer, arc.center), snappedTangent: arc.snappedTangent }
}

// what the Pen shows and commits while bowing: bowArc, then (unless the
// joint's own tangency snapped) the tangent snap onto nearby geometry
export interface BowPreview { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean; touch: BowTangentSnap | null }

// A line leaving an arc's end E (centre C, `sweep` as stored): when the
// rubber band E→pt points forward within `tolRad` of the arc's direction of
// travel at E, `pt` is projected onto that tangent line. Pure.
export function snapArcTangent(C: Vec2, E: Vec2, sweep: 0 | 1, pt: Vec2, tolRad: number): { pt: Vec2; snapped: boolean } {
  const rx = E.x - C.x, ry = E.y - C.y
  const rl = Math.hypot(rx, ry)
  const vx = pt.x - E.x, vy = pt.y - E.y
  const vl = Math.hypot(vx, vy)
  if (rl < 1e-9 || vl < 1e-9) return { pt, snapped: false }
  const s = sweep === 1 ? 1 : -1
  const tx = (-ry / rl) * s, ty = (rx / rl) * s   // travel direction at E
  const along = vx * tx + vy * ty
  if (along <= 0) return { pt, snapped: false }
  if (Math.abs(vx * ty - vy * tx) / vl > Math.sin(tolRad)) return { pt, snapped: false }
  return { pt: { x: E.x + tx * along, y: E.y + ty * along }, snapped: true }
}
```

- [ ] **Step 5: `usePen.ts` inside the pen**

(a) `setPathDrag` — reset the engage key (declare the key just above it):
```ts
  // the curve the bow is snapped tangent to (curveKey), so the sparkle fires
  // once when the snap engages, not on every move
  let bowTouchKey: string | null = null
  function setPathDrag(v: PathDrag) { pathDrag = v; bowTouchKey = null; pathDragTick.value++ }
```

(b) Add `bowPreview` after `setPathDrag`:
```ts
  function bowPreview(pointer: Vec2 | null, o: { snap?: boolean } = {}): BowPreview | null {
    void pathDragTick.value
    if (!pointer || !pathDrag || !pathDrag.bowed) return null
    const pp = pendingPath.value
    if (!pp) return null
    const p0 = doc.value.entities.find(e => e.id === pathDrag!.prevAnchor) as any
    const p1 = doc.value.entities.find(e => e.id === pathDrag!.anchor) as any
    if (!p0 || p0.kind !== 'point' || !p1 || p1.kind !== 'point') return null
    const J = { x: p0.x, y: p0.y }, E = { x: p1.x, y: p1.y }
    const joint = jointInfoForSegment(pp, pp.segments.length - 1)
    const arc = bowArc(J, E, pointer, joint?.tangentDir ?? null)
    if (!arc) return null
    if (arc.snappedTangent || o.snap === false) return { ...arc, touch: null }
    const touch = bowTangentSnap(doc.value, J, E, arc.center, pxToUnits(SNAP_PX, opts.view.value), [pathDrag.prevAnchor, pathDrag.anchor])
    if (!touch) return { ...arc, touch: null }
    return { ...arcShape(J, E, pointer, touch.center), snappedTangent: false, touch }
  }
```

(c) `pathMove` — after the existing bowed-threshold line, add:
```ts
    if (pathDrag.bowed) {
      const pv = bowPreview({ x, y })
      const key = pv?.touch ? curveKey(pv.touch.target) : null
      if (key && key !== bowTouchKey) sparkle(pv!.touch!.touch.x, pv!.touch!.touch.y)
      bowTouchKey = key
    }
```

(d) `commitBowedSegment(pointer: Vec2, snap = true)` — replace its body from `const joint = …` through the end of the joint-tangent block with:
```ts
    const joint = jointInfoForSegment(pp, segIndex)
    const pv = bowPreview(pointer, { snap })
    if (!pv) return null
    const c = addPoint(doc.value, pv.center.x, pv.center.y)
    pp.segments[segIndex] = { kind: 'arc', center: c, sweep: pv.sweep }
    // the right-angle (or arc-tangent) rule this press captured was for a
    // straight segment — gone now it is an arc
    if (pathDrag.perp) removeConstraint(doc.value, pathDrag.perp)
    if (pv.snappedTangent && joint) {
      if (joint.prevKind === 'arc') addConstraint(doc.value, 'collinear', [joint.Cprev, prevAnchor, c])
      else addConstraint(doc.value, 'perpendicular', [joint.La, joint.Lb, prevAnchor, c])
      sparkle(p0.x, p0.y)   // joint anchor J
    } else if (pv.touch) {
      // snapped tangent onto nearby geometry: the rule that keeps it touching
      const target = pieceOf(doc.value, pv.touch.target)
      const rule = target ? tangentRuleFor(doc.value, { kind: 'arc', c, s: prevAnchor, e: anchor }, target) : null
      if (rule) { addConstraint(doc.value, rule.kind, rule.refs, rule.value); sparkle(pv.touch.touch.x, pv.touch.touch.y) }
    }
    return c
```
(keep the earlier guards in the function: `pathDrag.bowed`, `pp`, `seg.kind === 'line'`, `p0`/`p1` found). Update its doc comment to mention the tangent snap.

(e) `applyArcDimension`: change `const c = commitBowedSegment(cursor.value)` to `const c = commitBowedSegment(cursor.value, false)   // a typed radius wins over the tangent snap`.

(f) `pathPlacement` — widen the return type to `{ x: number; y: number; perpendicular: boolean; tangent: boolean }`, add `tangent: false` to every existing return, and replace
```ts
    const lastSeg = pp.segments[pp.segments.length - 1]
    if (pp.anchors.length < 2 || !lastSeg || lastSeg.kind !== 'line') return { x, y, perpendicular: false }
```
with
```ts
    const lastSeg = pp.segments[pp.segments.length - 1]
    // leaving an arc's end: snap onto its tangent (snapArcTangent)
    if (lastSeg && lastSeg.kind === 'arc') {
      const C = doc.value.entities.find(e => e.id === lastSeg.center) as any
      if (!C || C.kind !== 'point') return { x, y, perpendicular: false, tangent: false }
      const r = snapArcTangent({ x: C.x, y: C.y }, { x: prev.x, y: prev.y }, lastSeg.sweep, { x, y }, PERP_SNAP_RAD)
      return { x: r.pt.x, y: r.pt.y, perpendicular: false, tangent: r.snapped }
    }
    if (pp.anchors.length < 2 || !lastSeg || lastSeg.kind !== 'line') return { x, y, perpendicular: false, tangent: false }
```
and the final return becomes `return { x: r.pt.x, y: r.pt.y, perpendicular: r.snapped, tangent: false }`.

(g) Add `captureArcTangent` after `capturePerpendicular`:
```ts
  // The arc counterpart of capturePerpendicular: the new anchor landed exactly
  // on the previous arc's tangent (placement `tangent`) — capture the joint
  // rule perpendicular [C, E, E, new] (radius ⊥ the new line).
  function captureArcTangent(p: { x: number; y: number; tangent: boolean }, id: EntityId, own: boolean): EntityId | null {
    const pp = pendingPath.value
    if (!p.tangent || !own || !pp || pp.anchors.length < 3) return null
    const n = pp.anchors.length
    if (pp.anchors[n - 1] !== id) return null
    const arc = pp.segments[n - 3]
    if (!arc || arc.kind !== 'arc') return null
    const joint = pp.anchors[n - 2]!
    const placed = doc.value.entities.find(e => e.id === id) as any
    const corner = doc.value.entities.find(e => e.id === joint) as any
    if (!placed || placed.kind !== 'point' || !corner || corner.kind !== 'point') return null
    if (Math.abs(placed.x - p.x) > 1e-9 || Math.abs(placed.y - p.y) > 1e-9) return null
    const refs = [arc.center, joint, joint, id]
    if (doc.value.constraints.some(c => c.kind === 'perpendicular' && c.refs.join() === refs.join())) return null
    const cid = addConstraint(doc.value, 'perpendicular', refs)
    sparkle(corner.x, corner.y)
    return cid
  }
```
(h) `pathDown`: `const perp = capturePerpendicular(p, id, own) ?? captureArcTangent(p, id, own)`. `pathClick`: replace `if (nextSegment.value === 'line') capturePerpendicular(p, id, own)` with `if (nextSegment.value === 'line' && !capturePerpendicular(p, id, own)) captureArcTangent(p, id, own)`.

(i) Return object: add `bowPreview` next to `jointInfoForSegment` in the `// drawing` line.

- [ ] **Step 6: `PenOverlay.vue`**

(a) Destructure `bowPreview` from `props.pen` (drawing line). Keep the `bowArc` import only if still used; otherwise remove it from the import.

(b) Replace the body of `pathBowChip` from `const joint = …` to the `return` with:
```ts
  const pv = bowPreview(penCursor.value)
  if (!pv) return null
  const mid = toScreen(pv.mid)
  const c = toScreen(pv.center)
  const j = toScreen(p0)
  return {
    x: (c.x + mid.x) / 2, y: (c.y + mid.y) / 2,
    center: pv.center, r: pv.r, cx: c.x, cy: c.y, midX: mid.x, midY: mid.y,
    text: dimBuffer.value ? dimBuffer.value + '|' : `R ${pv.r.toFixed(1)}`,
    snappedTangent: pv.snappedTangent, jointX: j.x, jointY: j.y,
    // snapped tangent onto nearby geometry: where it touches (screen)
    touch: pv.touch ? toScreen(pv.touch.touch) : null,
  }
```
(keep the guards above it; `p1` / `pp` are no longer needed there — drop unused locals.)

(c) Add, after `rightAngleChip`:
```ts
// "T" chip at the joint while the next anchor is snapping onto the tangent of
// the arc it leaves (usePen's snapArcTangent)
const tangentChip = computed(() => {
  if (tool.value !== 'path' || getPathDrag() || !placementPreview.value?.tangent) return null
  const pp = pendingPath.value
  return pp ? screenPt(pp.anchors[pp.anchors.length - 1]!) : null
})
```

(d) Template: the ghost circle's stroke becomes `:stroke="pathBowChip.touch ? '#16a34a' : '#6366f1'"` and its opacity `:opacity="pathBowChip.touch ? 0.7 : 0.35"`, and add `:data-tangent="pathBowChip.touch ? '' : null"` on the `data-bow-ghost` group. After the existing joint `T` chip group add:
```html
    <g v-if="pathBowChip && pathBowChip.touch" pointer-events="none" data-bow-tangent>
      <circle :cx="pathBowChip.touch.x" :cy="pathBowChip.touch.y" r="3" fill="none" stroke="#16a34a" stroke-width="1.5" />
      <rect :x="pathBowChip.touch.x + 6" :y="pathBowChip.touch.y - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="pathBowChip.touch.x + 9" :y="pathBowChip.touch.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">T</text>
    </g>
```
and after the `data-right-angle` group:
```html
    <g v-if="tangentChip" pointer-events="none" data-tangent-chip>
      <rect :x="tangentChip.x + 6" :y="tangentChip.y - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="tangentChip.x + 9" :y="tangentChip.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">T</text>
    </g>
```

- [ ] **Step 7: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-bow-tangent.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-right-angle.unit.spec.ts tests/unit/sketch-tangent-joint.unit.spec.ts tests/unit/pen-curve.unit.spec.ts tests/unit/pen-overlay-cues.unit.spec.ts tests/unit/pen-snap.unit.spec.ts`
Expected: all PASS. Typecheck `lib/sketch/infer\.ts|composables/pen/usePen\.ts|components/pen/PenOverlay\.vue` — no new errors.

- [ ] **Step 8: Host specs stay green** — `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-snap.spec.ts --project=chromium`. If the page looks stale, `touch frontend/app/composables/pen/usePen.ts frontend/app/components/pen/PenOverlay.vue` and confirm the served module contains `bowPreview` (curl, Global Constraints) before re-running.

- [ ] **Step 9: Commit** `frontend/app/lib/sketch/infer.ts frontend/app/composables/pen/usePen.ts frontend/app/components/pen/PenOverlay.vue frontend/tests/unit/pen-bow-tangent.unit.spec.ts` — message `feat(pen): a bowing arc snaps tangent to what it nearly touches; a line leaving an arc snaps onto its tangent`.

---

### Task 5: Drag an arc's bow in Select, and ⌘-drag its centre

**Files:**
- Modify: `frontend/app/lib/sketch/infer.ts` (export `circumcenter`)
- Modify: `frontend/app/composables/pen/usePen.ts` (`runSolve` gains `hold`, arc drag state + API, `undo`, `redo`, `selectTool`, `finishSession`, `revert`, `reset`, `endGesture`, return object)
- Modify: `frontend/app/components/pen/PenOverlay.vue` (arc press → drag, transient point hidden)
- Test: `frontend/tests/unit/pen-arc-drag.unit.spec.ts`

**Behaviour (spec §"Dragging arcs", with rulings):**
- In Select, a press on a path arc segment (away from its ends — the end points sit on top and take the press) that moves past 3 screen px (the marquee threshold) drags the arc's bow: a transient point is added on the arc at the grab spot (a guide point, pinned on the arc by `equalDist [C, T, C, S]`), every move solves with that point held at the pointer, and release removes it and its rule and commits one history step.
- **Ruling (ends hold):** each move first solves with the arc's two end anchors held (treated as fixed for that solve only — the flag never reaches the drawing); if that doesn't converge (a rule needs an end to move, e.g. a joined tangent line), it solves again with the ends free, so a tangent neighbour's end slides.
- **Ruling (sweep):** if the pointer crosses the chord so the transient point leaves the drawn arc, the segment's sweep flips so the drawn arc keeps passing under the pointer. To make crossing possible at all, each move first puts the centre at the circle through both ends and the pointer (a warm start — the solver alone cannot walk through the infinite radius at the chord); a pointer exactly on the chord line (no such circle) leaves the arc as it was until it moves off.
- **⌘-drag** (Ctrl on Windows/Linux — the pen's existing no-join key) on an arc drags its centre point by the pointer's movement from the press (no transient point), exactly as dragging the centre dot does.
- **Ruling:** the press still selects the whole path on pointerdown, as today (existing specs rely on it); Shift- and Option-presses never start a drag. Circles are not bow-dragged in v1 (their size is typed with Radius…).
- Any interruption (tool switch, undo/redo, the overlay parking, finishing the session) settles a live arc drag first, as its own step, like a live Trim press. `revert` / `reset` drop it.

**Interfaces:**
- Consumes: `curveGeom`, `paramOf`, `pointAt` (`crossings.ts`), `addPoint`, `addConstraint`, `deleteEntity` (`edit.ts`), `runSolve`, `pathDragTick`; `circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null` from `infer.ts` (exported in this task).
- Produces (pen): `runSolve(drag?: DragTarget, hold?: EntityId[])`; `arcDragStart(pathId: EntityId, segIndex: number, x: number, y: number, centre?: boolean): boolean`; `arcDragMove(x: number, y: number): void`; `arcDragEnd(): void`; `arcDragTransient(): EntityId | null` (reactive through `pathDragTick`).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-arc-drag.unit.spec.ts`:

```ts
// tests/unit/pen-arc-drag.unit.spec.ts
// Pen stage 4, dragging arcs in Select: pulling the bow changes the radius
// while the ends stay put (unless a rule needs them to move), the transient
// point is gone afterwards, crossing the chord flips the arc, the drag is one
// undo step; ⌘-drag moves the centre.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
// an arc (4,6) → (10,6) centred (7,9), dipping to (7, 4.757)
function mkArc(extra?: (d: SketchDoc, ids: { A: string; B: string; C: string }) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const A = addPoint(doc.value, 4, 6), B = addPoint(doc.value, 10, 6), C = addPoint(doc.value, 7, 9)
  const path = addPath(doc.value, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
  extra?.(doc.value, { A, B, C })
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen, A, B, C, path }
}
const BOTTOM = { x: 7, y: 9 - Math.hypot(3, 3) }

describe('dragging an arc’s bow', () => {
  it('changes the radius, keeps the ends, leaves no extra point, and is one undo step', () => {
    const { doc, pen, A, B, C, path } = mkArc()
    const ents = doc.value.entities.length, cons = doc.value.constraints.length
    expect(pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)).toBe(true)
    const t = pen.arcDragTransient()!
    expect(P(doc.value, t)).toMatchObject({ construction: true })
    pen.arcDragMove(7, 4.2); pen.arcDragMove(7, 3.5)
    expect(P(doc.value, t).x).toBeCloseTo(7, 9); expect(P(doc.value, t).y).toBeCloseTo(3.5, 9)
    pen.arcDragEnd()
    expect(pen.arcDragTransient()).toBeNull()
    expect(doc.value.entities.length).toBe(ents)
    expect(doc.value.constraints.length).toBe(cons)
    expect(P(doc.value, A)).toMatchObject({ x: 4, y: 6 })
    expect(P(doc.value, B)).toMatchObject({ x: 10, y: 6 })
    expect(P(doc.value, C).x).toBeCloseTo(7, 4)
    expect(P(doc.value, C).y).toBeCloseTo(6.55, 4)   // through (4,6), (10,6), (7,3.5)
    pen.undo()
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
  it('a tangent line that isn’t joined follows; the rule holds', () => {
    const { doc, pen, path } = mkArc((d, { A, C }) => {
      const la = addPoint(d, 0, 9 - Math.hypot(3, 3)), lb = addPoint(d, 14, 9 - Math.hypot(3, 3))
      addLine(d, la, lb)
      addConstraint(d, 'tangentLineArc', [la, lb, C, A])
    })
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 4.2); pen.arcDragEnd()
    expect(Math.max(...constraintResiduals(doc.value).map(Math.abs))).toBeLessThan(1e-5)
  })
  it('a joined tangent line makes the shared end slide; the joint stays smooth', () => {
    let P0 = ''
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    P0 = addPoint(doc.value, 1, 9)
    const A = addPoint(doc.value, 4, 6), B = addPoint(doc.value, 10, 6), C = addPoint(doc.value, 7, 9)
    const path = addPath(doc.value, [P0, A, B], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }])
    addConstraint(doc.value, 'perpendicular', [P0, A, A, C])
    const pen = usePen({ doc, view: ref(DEV) })
    pen.arcDragStart(path, 1, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 4.5); pen.arcDragMove(7, 4.2); pen.arcDragEnd()
    expect(Math.max(...constraintResiduals(doc.value).map(Math.abs))).toBeLessThan(1e-5)
    expect(doc.value.entities.filter(e => e.kind === 'point')).toHaveLength(4)
  })
  it('pulling across the chord flips the arc so it still runs under the pointer', () => {
    const { doc, pen, C, path } = mkArc()
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 7)
    pen.arcDragEnd()
    const p = P(doc.value, path)
    expect(p.segments[0].sweep).toBe(0)
    expect(P(doc.value, C).y).toBeCloseTo(2, 4)   // through (4,6), (10,6), (7,7)
  })
  it('a press that never moves changes nothing and adds no history', () => {
    const { doc, pen, path } = mkArc()
    const before = JSON.stringify(doc.value)
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragEnd()
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
  it('undo during a drag settles it, then steps back over it', () => {
    const { doc, pen, C, path } = mkArc()
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 3.5)
    pen.undo()
    expect(pen.arcDragTransient()).toBeNull()
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
  it('refuses a line segment', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const path = addPath(doc.value, [addPoint(doc.value, 0, 0), addPoint(doc.value, 5, 0)], [{ kind: 'line' }])
    const pen = usePen({ doc, view: ref(DEV) })
    expect(pen.arcDragStart(path, 0, 2, 0)).toBe(false)
  })
})

describe('⌘-dragging an arc', () => {
  it('moves its centre by the pointer’s movement, one undo step, no extra point', () => {
    const { doc, pen, C, path } = mkArc()
    const ents = doc.value.entities.length
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y, true)
    expect(pen.arcDragTransient()).toBeNull()
    pen.arcDragMove(BOTTOM.x + 0.5, BOTTOM.y + 0.5); pen.arcDragMove(BOTTOM.x + 1, BOTTOM.y + 1)
    pen.arcDragEnd()
    expect(P(doc.value, C).x).toBeCloseTo(8, 9); expect(P(doc.value, C).y).toBeCloseTo(10, 9)
    expect(doc.value.entities.length).toBe(ents)
    pen.undo()
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-arc-drag.unit.spec.ts`
Expected: FAIL — `pen.arcDragStart is not a function`.

- [ ] **Step 3: `infer.ts` and `usePen.ts`**

In `infer.ts` change `function circumcenter(` to `export function circumcenter(` (body unchanged).

(a) Imports: add `circumcenter` to the `~/lib/sketch/infer` import; add `paramOf, pointAt` to the `~/lib/sketch/crossings` import; `deleteEntity`, `addPoint`, `addConstraint` are already imported from `edit`. Add `PointEntity` to the model type import if you use it.

(b) `runSolve(drag?: DragTarget, hold?: EntityId[])` — in the `plain` snapshot mark held points fixed (copy only; `fixed` is never copied back):
```ts
  function runSolve(drag?: DragTarget, hold?: EntityId[]) {
    const held = hold && hold.length ? new Set(hold) : null
    const plain: SketchDoc = {
      entities: doc.value.entities.map(e => ({
        ...toRaw(e),
        ...(held && e.kind === 'point' && held.has(e.id) ? { fixed: true } : {}),
        ...(e.kind === 'path' ? { anchors: [...e.anchors], segments: e.segments.map(s => ({ ...toRaw(s) })) } : {}),
      })),
      constraints: doc.value.constraints.map(c => ({ ...toRaw(c), refs: [...c.refs] })),
    }
    ...rest unchanged
```

(c) Arc drag — add after `cancelPointDrop`:
```ts
  // --- Select: drag an arc's bow (or, with ⌘, its centre) ---
  // A press on an arc segment that moves (PenOverlay) starts arcDragStart. Bow
  // mode adds a transient guide point on the arc at the grab spot, pinned on
  // it (equalDist [C, T, C, S]); each move solves with that point held at the
  // pointer and the arc's ends held too — or, if that can't converge (a rule
  // needs an end to move), with the ends free. Centre mode (⌘) moves the
  // centre point by the pointer's movement. arcDragEnd removes the transient
  // point and settles ONE history step (none when nothing moved). Plain
  // state, like pathDrag: every write goes through setArcDrag or bumps
  // pathDragTick, so arcDragTransient() stays reactive for the overlay.
  type ArcDrag = {
    pathId: EntityId; segIndex: number; centre: EntityId; ends: [EntityId, EntityId]
    transient: EntityId | null; from: Vec2; centreFrom: Vec2; moved: boolean
  } | null
  let arcDrag: ArcDrag = null
  function setArcDrag(v: ArcDrag) { arcDrag = v; pathDragTick.value++ }
  function arcDragTransient(): EntityId | null { void pathDragTick.value; return arcDrag?.transient ?? null }

  function arcDragStart(pathId: EntityId, segIndex: number, x: number, y: number, centre = false): boolean {
    if (arcDrag) arcDragEnd()
    const path = doc.value.entities.find(e => e.id === pathId)
    if (!path || path.kind !== 'path') return false
    const seg = path.segments[segIndex]
    if (!seg || seg.kind !== 'arc') return false
    const g = curveGeom(doc.value, { kind: 'seg', pathId, segIndex })
    const c = doc.value.entities.find(e => e.id === seg.center)
    if (!g || g.kind !== 'arc' || !c || c.kind !== 'point') return false
    const a = path.anchors[segIndex]!, b = path.anchors[(segIndex + 1) % path.anchors.length]!
    let transient: EntityId | null = null
    if (!centre) {
      const on = pointAt(g, paramOf(g, { x, y }))
      transient = addPoint(doc.value, on.x, on.y, { construction: true })
      addConstraint(doc.value, 'equalDist', [seg.center, transient, seg.center, a])
    }
    setArcDrag({ pathId, segIndex, centre: seg.center, ends: [a, b], transient, from: { x, y }, centreFrom: { x: c.x, y: c.y }, moved: false })
    return true
  }

  // the transient point left the drawn arc (the pointer crossed the chord):
  // flip the segment so the drawn arc runs under it again
  function keepTransientOnArc(d: NonNullable<ArcDrag>) {
    const t = doc.value.entities.find(e => e.id === d.transient)
    const g = curveGeom(doc.value, { kind: 'seg', pathId: d.pathId, segIndex: d.segIndex })
    if (!t || t.kind !== 'point' || !g || g.kind !== 'arc') return
    const on = pointAt(g, paramOf(g, t))
    if (dist(on, t) <= 1e-6 * Math.max(1, g.r!)) return
    const path = doc.value.entities.find(e => e.id === d.pathId) as PathEntity
    const seg = path.segments[d.segIndex]!
    if (seg.kind === 'arc') path.segments[d.segIndex] = { ...seg, sweep: seg.sweep === 1 ? 0 : 1 }
  }

  function arcDragMove(x: number, y: number): void {
    const d = arcDrag
    if (!d) return
    d.moved = true
    if (!d.transient) {
      runSolve({ point: d.centre, x: d.centreFrom.x + (x - d.from.x), y: d.centreFrom.y + (y - d.from.y) })
    } else {
      // warm start: the centre of the circle through both ends and the
      // pointer — exactly the answer when nothing else ties the arc, and the
      // only way across the chord (Gauss-Newton can't walk through the
      // infinite radius in between)
      const pa = doc.value.entities.find(e => e.id === d.ends[0]) as any
      const pb = doc.value.entities.find(e => e.id === d.ends[1]) as any
      const pc = doc.value.entities.find(e => e.id === d.centre) as any
      const cc = circumcenter({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }, { x, y })
      if (!cc || Math.hypot(cc.x - pa.x, cc.y - pa.y) > 1e4) return   // pointer on the chord line: no circle through it yet
      pc.x = cc.x; pc.y = cc.y
      const res = runSolve({ point: d.transient, x, y }, d.ends)
      if (!res.converged) runSolve({ point: d.transient, x, y })
      keepTransientOnArc(d)
    }
    pathDragTick.value++
  }

  function arcDragEnd(): void {
    const d = arcDrag
    if (!d) return
    setArcDrag(null)
    if (d.transient && doc.value.entities.some(e => e.id === d.transient)) deleteEntity(doc.value, d.transient)
    if (d.moved) { runSolve(); commitHistory() }
  }
```

(d) Interruptions: add `if (arcDrag) arcDragEnd()` as the first line of `undo`, `redo`, `selectTool` (before the `isToolAllowed` check is fine — after it is also fine; put it after), `finishSession`, and inside `endGesture` (next to the `trimPress` line). In `revert` and `reset` add `setArcDrag(null)` before the doc is replaced (no settle — the drawing is being thrown away).

(e) Return object: add `arcDragStart, arcDragMove, arcDragEnd, arcDragTransient,` on the `// select-tool point drag` line.

- [ ] **Step 4: `PenOverlay.vue`**

(a) Destructure `arcDragStart, arcDragMove, arcDragEnd, arcDragTransient` from `props.pen`.

(b) Hide the transient point — `pts` filter:
```ts
const pts = computed(() => (doc.value.entities.filter(e =>
  e.kind === 'point' && e.id !== arcDragTransient() && (!allHandleIds.value.has(e.id) || visibleHandleIds.value.has(e.id))) as any[])
  .map(p => ({ p, s: toScreen(p), handle: allHandleIds.value.has(p.id), role: pointRoleOf(p) })))
```

(c) Arc press state, next to `dragId`/`moved`:
```ts
// Select: a press on an arc segment, which becomes a bow drag (⌘ / Ctrl: a
// centre drag) once it moves past the marquee threshold; `live` once the pen
// has started the drag
let arcPress: { pathId: EntityId; segIndex: number; x: number; y: number; wx: number; wy: number; centre: boolean; live: boolean } | null = null
function isArcSegment(pathId: EntityId, segIndex: number): boolean {
  const p = doc.value.entities.find(e => e.id === pathId) as any
  return p?.kind === 'path' && p.segments[segIndex]?.kind === 'arc'
}
```

(d) `onSegmentPointerDown` — replace
```ts
  if (ev.altKey) pickSegment(pathId, segIndex, ev.shiftKey)
  else pick(pathId, ev.shiftKey)
  ev.stopPropagation()
```
with
```ts
  if (ev.altKey) pickSegment(pathId, segIndex, ev.shiftKey)
  else {
    pick(pathId, ev.shiftKey)
    // a plain (or ⌘) press on an arc may become a bow (or centre) drag
    if (!ev.shiftKey && isArcSegment(pathId, segIndex)) {
      const w = drawingXY(ev), l = localXY(ev)
      if (w) arcPress = { pathId, segIndex, x: l.x, y: l.y, wx: w.x, wy: w.y, centre: noJoinKey(ev), live: false }
    }
  }
  ev.stopPropagation()
```

(e) `onPointerMove` — immediately before the final `if (!dragId || ev.buttons === 0) return`, add:
```ts
  if (arcPress && tool.value === 'select') {
    if (ev.buttons === 0) return
    const l = localXY(ev), w = drawingXY(ev)
    if (!w) return
    if (!arcPress.live) {
      if (Math.hypot(l.x - arcPress.x, l.y - arcPress.y) <= MARQUEE_THRESHOLD_PX) return
      arcPress.live = arcDragStart(arcPress.pathId, arcPress.segIndex, arcPress.wx, arcPress.wy, arcPress.centre)
      if (!arcPress.live) { arcPress = null; return }
    }
    arcDragMove(w.x, w.y)
    return
  }
```

(f) `onPointerUp` — immediately before the `// settle a select-tool point drag` block, add:
```ts
  if (arcPress) {
    const live = arcPress.live
    arcPress = null
    if (live) arcDragEnd()
    return
  }
```
(g) `settleOverlayGesture` — add at its top: `if (arcPress) { if (arcPress.live) arcDragEnd(); arcPress = null }`.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-arc-drag.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-weld.unit.spec.ts tests/unit/pen-trim.unit.spec.ts tests/unit/pen-overlay-buttons.unit.spec.ts tests/unit/pen-overlay-host-keys.unit.spec.ts tests/unit/pen-bow-tangent.unit.spec.ts`
Expected: all PASS. Typecheck `lib/sketch/infer\.ts|composables/pen/usePen\.ts|components/pen/PenOverlay\.vue` — no new errors.

- [ ] **Step 6: Host specs stay green** — `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-weld.spec.ts --project=chromium` (stale page: touch + curl for `arcDragStart`, per Global Constraints).

- [ ] **Step 7: Commit** `frontend/app/lib/sketch/infer.ts frontend/app/composables/pen/usePen.ts frontend/app/components/pen/PenOverlay.vue frontend/tests/unit/pen-arc-drag.unit.spec.ts` — message `feat(pen): drag an arc's bow to resize it, ⌘-drag to move its centre`.

---

### Task 6: Real-mouse proof on the pen page

**Files:**
- Test: `frontend/tests/pen-tangent.spec.ts` (new)

**Ruling:** the spec's "one host check per stage that its new tool reaches the host" has nothing to check here — stage 4 adds no tool, key or option, and every host renders the same `PenOverlay` / `PenToolbar`. The Frame and Shape Studio pen specs staying green is the host check.

**Interfaces:**
- Consumes: everything above; page hooks `window.__sketchDraw` (`reset`, `setTool`, `setNextSegment`, `place`, `finishPath`, `doc`, `undo`) for setup and reads only; `data-seg`, `data-verb="tangent"`, `data-bow-tangent`, `data-bow-ghost[data-tangent]`, `data-tangent-chip` from the overlay/toolbar.

- [ ] **Step 1: Write the spec** — create `frontend/tests/pen-tangent.spec.ts`:

```ts
// tests/pen-tangent.spec.ts
// Pen stage 4 — tangency — with the REAL mouse on the pen dev page: a bowing
// arc snaps tangent to a line (chip at the touch point, rule on release); a
// line leaving an arc's end snaps onto its tangent; Tangent in the rules row
// on two Option-clicked segments, apart and joined; dragging an arc's bow in
// Select; ⌘-dragging an arc moves its centre. Every gesture is page.mouse /
// page.keyboard; __sketchDraw only sets drawings up and reads them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
// the dev page's default view: 34 px per unit, y up, origin at (40, 400)
const overlay = (page: Page) => page.locator('svg[width="680"][height="460"]')
async function screenOf(page: Page, x: number, y: number) {
  const box = (await overlay(page).boundingBox())!
  return { x: box.x + 40 + 34 * x, y: box.y + 400 - 34 * y }
}
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
// a point along a drawn segment (fraction f of its length), in client pixels
async function onSegment(page: Page, pathId: string, segIndex: number, f = 0.5) {
  return page.evaluate(({ pathId, segIndex, f }) => {
    const el = document.querySelector(`[data-seg="${pathId}:${segIndex}"]`) as SVGPathElement
    const p = el.getPointAtLength(el.getTotalLength() * f)
    const m = el.getScreenCTM()!
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
  }, { pathId, segIndex, f })
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const pt = (d: any, id: string) => d.entities.find((e: any) => e.id === id)

test('a bowing arc snaps tangent to a line, with a chip where it touches, and keeps the rule', async ({ page }) => {
  await open(page)
  const line = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('line'); D.place(2, 2); D.place(16, 2)
    D.setTool('path')
    const l = D.doc.entities.find((e: any) => e.kind === 'line')
    return { p1: l.p1 as string, p2: l.p2 as string }
  })
  const a = await screenOf(page, 6, 5)
  await page.mouse.click(a.x, a.y)
  const b = await screenOf(page, 12, 5)
  await page.mouse.move(b.x, b.y)
  await page.mouse.down()
  const bow = await screenOf(page, 9, 2.1)
  await page.mouse.move(bow.x, bow.y, { steps: 12 })
  await expect(page.locator('[data-bow-tangent]')).toBeVisible()
  await expect(page.locator('[data-bow-ghost][data-tangent]')).toHaveCount(1)
  await page.mouse.up()
  await expect(page.locator('[data-bow-tangent]')).toHaveCount(0)
  await page.evaluate(() => (window as any).__sketchDraw.finishPath(false))

  const d = await doc(page)
  const path = d.entities.find((e: any) => e.kind === 'path')
  const C = path.segments[0].center, S = path.anchors[0]
  const k = d.constraints.find((c: any) => c.kind === 'tangentLineArc')
  expect(k.refs).toEqual([line.p1, line.p2, C, S])
  const c = pt(d, C), s = pt(d, S), l1 = pt(d, line.p1), l2 = pt(d, line.p2)
  const lineDist = Math.abs((l2.x - l1.x) * (c.y - l1.y) - (l2.y - l1.y) * (c.x - l1.x)) / Math.hypot(l2.x - l1.x, l2.y - l1.y)
  expect(Math.abs(lineDist - Math.hypot(s.x - c.x, s.y - c.y))).toBeLessThan(1e-5)
})

test('a line leaving an arc’s end snaps onto its tangent and keeps the joint smooth', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6)            // arc centred (7,9), travelling ccw into (10,6)
    D.setNextSegment('line')
  })
  const near = await screenOf(page, 12.2, 8.05)
  await page.mouse.move(near.x - 20, near.y + 10)
  await page.mouse.move(near.x, near.y, { steps: 6 })
  await expect(page.locator('[data-tangent-chip]')).toBeVisible()
  await page.mouse.click(near.x, near.y)
  await page.evaluate(() => (window as any).__sketchDraw.finishPath(false))
  const d = await doc(page)
  const path = d.entities.find((e: any) => e.kind === 'path')
  const [, E, N] = path.anchors
  const C = path.segments[0].center
  expect(d.constraints.find((c: any) => c.kind === 'perpendicular').refs).toEqual([C, E, E, N])
  const c = pt(d, C), e = pt(d, E), n = pt(d, N)
  expect(Math.abs((e.x - c.x) * (n.x - e.x) + (e.y - c.y) * (n.y - e.y))).toBeLessThan(1e-5)
})

test('Tangent in the rules row: two segments apart, then a line and an arc that meet', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('line')
    D.place(3, 3); D.place(11, 3.4); D.finishPath(false)             // a line, not joined to the arc
    D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)               // an arc centred (7,9)
    D.setNextSegment('line')
    D.place(2, 9.5); D.place(5, 10.5)                                // a line then an arc that meet at (5,10.5)
    D.setNextSegment('arc'); D.place(9, 10.5); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('select')
    const [line, arc, joined] = D.doc.entities.filter((e: any) => e.kind === 'path')
    return { line: line.id as string, arc: arc.id as string, joined: joined.id as string }
  })
  const before = (await doc(page)).constraints.length

  // Option-click the line, Option-Shift-click the arc
  const p1 = await onSegment(page, ids.line, 0, 0.3)
  const p2 = await onSegment(page, ids.arc, 0)
  await page.keyboard.down('Alt')
  await page.mouse.click(p1.x, p1.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(p2.x, p2.y)
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
  const btn = page.locator('[data-verb="tangent"]')
  await expect(btn).toHaveText('Tangent')
  await btn.hover()
  await expect(page.locator('[data-pen-tip-id="tangent"]')).toBeVisible()
  await btn.click()
  let d = await doc(page)
  const k = d.constraints.find((c: any) => c.kind === 'tangentLineArc')
  expect(k).toBeTruthy()
  await expect(page.locator(`[data-constraint="${k.id}"]`)).toHaveAttribute('data-constraint-kind', 'tangentLineArc')
  const [A, B, C, S] = k.refs.map((id: string) => pt(d, id))
  const gap = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / Math.hypot(B.x - A.x, B.y - A.y) - Math.hypot(S.x - C.x, S.y - C.y)
  expect(Math.abs(gap)).toBeLessThan(1e-5)
  // one undo step takes it back
  await page.keyboard.press(`${META}+z`)
  expect((await doc(page)).constraints.length).toBe(before)

  // the joined pair: the joint rule, radius square to the line
  const q1 = await onSegment(page, ids.joined, 0)
  const q2 = await onSegment(page, ids.joined, 1)
  await page.keyboard.down('Alt')
  await page.mouse.click(q1.x, q1.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(q2.x, q2.y)
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
  await page.locator('[data-verb="tangent"]').click()
  d = await doc(page)
  const joined = d.entities.find((e: any) => e.id === ids.joined)
  const [P0, J] = joined.anchors
  const Cj = joined.segments[1].center
  expect(d.constraints.find((c: any) => c.kind === 'perpendicular' && c.refs[1] === J).refs).toEqual([P0, J, J, Cj])
})

test('dragging an arc’s bow in Select resizes it, ends held, in one undo step', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('select')
    const p = D.doc.entities.find((e: any) => e.kind === 'path')
    return { path: p.id as string, A: p.anchors[0] as string, B: p.anchors[1] as string, C: p.segments[0].center as string }
  })
  const before = await doc(page)
  const grab = await onSegment(page, ids.path, 0)
  const to = await screenOf(page, 7, 3.5)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
  const d = await doc(page)
  expect(d.entities.length).toBe(before.entities.length)
  expect(d.constraints.length).toBe(before.constraints.length)
  expect(pt(d, ids.A)).toMatchObject({ x: pt(before, ids.A).x, y: pt(before, ids.A).y })
  expect(pt(d, ids.B)).toMatchObject({ x: pt(before, ids.B).x, y: pt(before, ids.B).y })
  expect(pt(d, ids.C).y).toBeGreaterThan(6.4)
  expect(pt(d, ids.C).y).toBeLessThan(6.7)
  await page.keyboard.press(`${META}+z`)
  expect(pt(await doc(page), ids.C).y).toBeCloseTo(9, 6)
})

test('⌘-dragging an arc moves its centre', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('select')
    const p = D.doc.entities.find((e: any) => e.kind === 'path')
    return { path: p.id as string, C: p.segments[0].center as string }
  })
  const count = (await doc(page)).entities.length
  const grab = await onSegment(page, ids.path, 0)
  await page.keyboard.down(META)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 34, grab.y - 34, { steps: 10 })   // +1, +1 in drawing units
  await page.mouse.up()
  await page.keyboard.up(META)
  const d = await doc(page)
  expect(d.entities.length).toBe(count)
  expect(pt(d, ids.C).x).toBeCloseTo(8, 1)
  expect(pt(d, ids.C).y).toBeCloseTo(10, 1)
})
```

- [ ] **Step 2: Run it**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/pen-tangent.spec.ts --project=chromium`
Expected: 5 passed. If a check fails because the page serves old modules, `touch` the pen files and curl the served `usePen.ts` for `arcDragStart` / `bowPreview` (Global Constraints) — never restart the server. If a failure is real, fix the code in the file from the task that owns it (and re-run that task's unit tests) rather than loosening the spec; note it in your report.

- [ ] **Step 3: Run the host and stage specs**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-snap.spec.ts tests/pen-weld.spec.ts tests/pen-trim.spec.ts tests/pen-tips.spec.ts tests/pen-tangent.spec.ts --project=chromium`
Expected: all pass. Also run the whole pen/sketch unit set once: `npx vitest run tests/unit/pen-*.unit.spec.ts tests/unit/sketch-*.unit.spec.ts` — all pass (counts can wobble under load; re-run a failing file alone before calling it a failure).

- [ ] **Step 4: Commit** `frontend/tests/pen-tangent.spec.ts` (plus any fix you had to make, by exact path) — message `test(pen): tangency with the real mouse — bow snap, line off an arc, Tangent, bow and centre drags`.

---

### Task 7: Record it

**Files:**
- Modify: `docs/STATE.md` (new entry at the top of the landed list, above "The pen — trim, tooltip cards, coincident (stages 1–3)")
- Modify: `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` (status line only)

- [ ] **Step 1: STATE.md entry** — heading `### The pen — tangency done right (stage 4) — LANDED 2026-09-26 (spec docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md, plan docs/superpowers/plans/2026-09-26-pen-stage-4-tangency.md; <first>..<last> commits)`, then in the style of the stages 1–3 entry: what you can do (Tangent on any two pieces, joined or not; Equal for two arcs; bow snap with the T chip; a line off an arc snaps onto its tangent; drag an arc's bow; ⌘-drag its centre), what was proven (the unit files and `tests/pen-tangent.spec.ts`, host specs green), the rulings (circle-id form for `tangentLineArc`, joint tangency beats the bow snap, typed radius skips it, ends held first then freed, the centre warm-started at the circle through the ends and the pointer so the bow can cross the chord (sweep flips), circles not bow-dragged, arc Equal has no badge like line Equal), and known limits (earlier segments of the path being drawn are not bow-snap targets; trimming a circle still drops its tangent rules and counts them; the Line tool starting at an arc's end doesn't snap tangent).
- [ ] **Step 2: Spec status line** → `Status: designed 2026-09-26 on the owner's "let's build stage 4-8 first"; stage 4 built 2026-09-26`.
- [ ] **Step 3: Commit** `docs/STATE.md docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — message `docs(pen): stage 4 built — tangency done right`. (The controller, not the implementer, updates the build dashboard afterwards.)

---

## Self-review

**Spec coverage (Stage 4):**
- New rule shapes `tangentLineArc` and `tangentArcs` (with the circle-id form, side from geometry) → Tasks 1–2. Joint forms unchanged → Task 2 reuses them.
- Bow snap to line / arc / circle, radius lock, chip at the touch point, sparkle, rule on release → Task 4. Arc off a line's end already tangent (unchanged); line leaving an arc's end snaps and writes the rule → Task 4.
- Tangent for two segments (any mix of path segments, lines, circles), joint form when joined, new forms when apart; Equal for two arc segments; point + arc keeps On curve → Task 3.
- Drag an arc's bow (transient point, ends and rules hold, tangent neighbour slides, removed on release) and ⌘-drag the centre → Task 5.
- Tooltip cards for new buttons → Task 3. Shared ground: tolerances via `pxToUnits(SNAP_PX)` (Tasks 4–5), one undo step per gesture (Tasks 3–5), Bézier excluded (`pieceOf` / `allCurves`), three hosts via the shared pen with no host change (Task 6 runs their specs). Testing section: residual + Jacobian vs numeric (Task 1), tangent snapping (Tasks 2, 4), real-mouse spec (Task 6).

**Spec problems found:** (1) `PenOptions.features` is referenced in "Shared ground" ("below") but never defined — stage 4 needs no feature flag (every host gets tangency), so none is added here. (2) The spec's forms can't express a *path line segment* tangent to a *circle* (`tangentLineCircle` needs a line entity) — fixed by the ruled `[A, B, circleId]` form of `tangentLineArc`. (3) The `tangentArcs` value is a side, but `value` is shown and click-edited as a dimension on badges — ruled out in Task 1 (no text, click removes).

**Type consistency:** `RuleSpec`, `TangentPiece`, `BowTangentSnap`, `curveKey` (Task 2) are used with the same names and shapes in Tasks 3–4; `bowPreview` / `BowPreview` (Task 4) and `arcDragStart/Move/End/Transient` (Task 5) match the overlay and the tests; `RuleOption.tangent` (Task 3) matches `applyWithValue`.
