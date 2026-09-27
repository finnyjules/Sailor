# The pen, stage 5 — Clean up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command — **Clean up** (toolbar button after Dissolve, key ⌥⇧C) — that joins what nearly meets, squares what is nearly square and evens what is nearly even, shows every change as a switchable badge over a faint ghost of the drawing, and lands as one undo step on Apply (Cancel / Esc leaves the drawing untouched).

**Architecture:** A new pure package `frontend/app/lib/sketch/cleanup/` — shared types and tolerances, complete-linkage grouping, a row-rank helper for "adds nothing", the spec's 11 detectors in three files, guards (a held solve on the touched part of the drawing, the movement cap, broken arcs) and a staged greedy runner (`runCleanup`) that always starts from the original drawing, so the same switches give the same answer. The shared pen gains a preview session (`usePen` + `penKeys`), the overlay draws the preview and the badges, the toolbar gets the button and the strength / Apply / Cancel row, and the tooltip cards get a Clean up card with a demo. Every host (the pen page, the Frame, Shape Studio) inherits it through the shared pen; no host file changes.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (`tests/unit/**/*.unit.spec.ts`), Playwright against the running :3002 dev server.

**Spec:** `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — sections "Shared ground" and "Stage 5" are binding; only Stage 5 is in scope. Read both before your task. Research behind the recipe (detectors, grouping, staged solve, guards): `/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/08811ebc-286d-4206-85f0-f2d098f0c5a5/scratchpad/zoah/report-cleanup.md` (optional background).

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
- Each task's commit is its own review package: the reviewer sees that task's diff and its tests only, so a task never leans on uncommitted work from a later one.
- UI copy: sentence case, plain words, no identifiers (glyphs such as ⌥⇧C × are fine). Explanations live in the tooltip cards (`PEN_TIPS`), not as extra text in panels. Badge labels quote what the fix does in plain words ("Joined", "Same radius ×4"), never a rule's internal name.
- Tolerances are screen px turned into drawing units with the `unitsPerPx` captured when Clean up opens (`pxToUnits(1, view)` from `lib/sketch/tolerance.ts`), × the strength factor. The spec's numbers live in `TOL` / `GUARD` (Task 1) — never hard-code a drawing-unit tolerance.
- Clean up adds no drag state. Its preview is `pen.cleanup`, a `shallowRef` that is **replaced** on every change (never mutated in place), so overlay and toolbar computeds follow it.
- Bézier (cubic) segments take no part in Clean up: never a piece, never joined, pinned, made tangent, sized or mirrored. Guides (construction pieces) take no part either, except as a mirror axis.
- Apply is one undo step (`commitHistory()` once). Opening Clean up, switching fixes, changing strength and Cancel write no step.
- Path arc segments carry the invariant `equalDist [centre, start, centre, end]` (added by `addPath`); `mergePoints` and the solver keep it.
- Clean up adds only EXISTING rule kinds (no new `ConstraintKind`), merges points only through `mergePoints` (`lib/sketch/trim.ts`, which drops what its `isTrivial` finds degenerate), and adds only guide pieces (construction points and lines) — so stage-3 editing (`trim.ts` pairSlots / followPair / followArcOperands / isTrivial, `edit.ts` deleteEntity) already handles everything it writes. Do not change `solve.ts`, `residuals.ts`, `jacobian.ts`, `trim.ts` or `edit.ts`.
- Real-mouse checks use `page.mouse` / `page.keyboard` / `locator.click()`, never synthetic `dispatchEvent`. `window.__sketchDraw` hooks may only set up a drawing or read state.
- Unit tests: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run <files>`. Typecheck: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -E '<your files>'` — judged only on files you touched (the repo has a pre-existing error baseline). Browser specs: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test <spec files> --project=chromium`.
- Rulings made by this plan (where the spec left a detail open) are marked **Ruling:** and are binding for the implementer.

---

## Rulings (the whole list; each task repeats the ones it needs)

1. **Clean up is a command, not a `PenTool`.** It is gated by a new `PenOptions.cleanup` (default `true`), so every host gets it with no host change. Its button is `data-act="cleanup"` (not `data-tool`, so the tool-count specs are unaffected).
2. **⌥⇧C is matched by `ev.code === 'KeyC'`** with Alt and Shift and no ⌘/Ctrl — on a Mac ⌥⇧C types "Ç", so `ev.key` can't be used.
3. **The preview never writes the drawing.** `pen.cleanup.result.doc` holds the cleaned copy; Apply replaces `doc.value` with it (one step). Anything that ends the session — a tool change, undo / redo, reset, revert, `finishSession`, parking the overlay (`endGesture`), `dispose` — drops the preview untouched.
4. **While previewing:** the rules row is hidden; the tool row is disabled except the Clean up button (which cancels); the pen owns every plain key (Enter applies — even with a toolbar button focused —, Escape and ⌥⇧C cancel, every other plain key is swallowed); ⌘Z / ⇧⌘Z only close the preview; other ⌘ combos go on to the host. Points, rule badges and radius chips are hidden; the drawing's pointer input is ignored except badge clicks.
5. **Tolerances are frozen at the zoom Clean up opened at**, so zooming mid-preview doesn't reshuffle the fixes.
6. **Scope:** selected pieces (whole paths, lines, circles, Option-picked segments). Points alone count as no selection (whole drawing). Every point of an unselected piece — including a point a selected piece shares with it — and every circle radius of an unselected circle is held (never moves). Unselected pieces may still be the *target* of a join or an On curve pin.
7. **Stages → passes:** joins = [ends meet] then [on curve, tangent] (re-detected after the joins, which make new joints); directions = [horizontal / vertical] then [parallel / perpendicular]; placement = [concentric] then [mirror pairs]; sizes = [equal lengths, equal radii, even spacing]; nudges = [round sizes]. Every pass re-reads the drawing the passes before it left; within a pass candidates go greedily by score.
8. **Guards on each candidate:** the held solve converges; it adds something (not an exact repeat of an existing rule, and the Jacobian rank rises — freedom that only places a new guide point doesn't count); no point moves further than **max(8 px, 10 % of the smallest piece it belongs to)** from where it was in the ORIGINAL drawing (cumulative, not scaled by strength; points merged away are exempt); no circle's radius changes more than max(8 px, 10 %); no arc breaks — its bulge crosses to the other side of its ends, its span jumps by more than 90°, or it ends shorter than 2 px (length or radius) when it wasn't. A dependent rule — implied or conflicting — is dropped silently.
9. **Targets:** a group's reference member is the one with a typed size (a distance / radius rule), else the longest; two different typed sizes in one group → no fix. The "length-weighted mean" comes from the solver's existing warm-start stay (turning or stretching a long piece moves its points further, so the long piece wins) — no solver change.
10. **Joins** meet in the middle; a held or fixed end stays and the other comes to it; two held/fixed ends → no join; never both ends of one piece; a gap may be at most 25 % of the shorter piece; at most one already-shared point per cluster; in an open-only pen (`openOnly`) a join that would close a path is refused.
11. **On curve** only for loose ends and free points, and never within the join distance of the curve's own ends (that is a join).
12. **Tangent** only at a point where exactly two pieces meet and at least one is an arc; nearly straight line–line joints are left to Dissolve.
13. **Directions:** Horizontal / Vertical per line; Parallel per group; perpendicular (label **"Square"**) between two groups when a line of one meets a line of the other at a corner, or both groups have two or more lines.
14. **Equal radius** ties arcs with arcs and circles with circles — no existing rule ties an arc's radius to a circle's.
15. **Evenly spaced:** (a) stacks of three or more exactly parallel, overlapping lines — each inner line is pinned through a guide point at the middle of its neighbours (`midpoint` + `collinear`); (b) points pinned on a line, with its ends (`equalDist` between neighbouring gaps). Straight runs of path anchors are "Same length", not "Evenly spaced".
16. **Mirror pairs:** candidate axes are the vertical and horizontal lines through the scope's bounding-box centre — each moved to the mean of its matched pairs' midpoints, so each side moves half the mismatch — plus every existing guide line. A new axis is a guide line with a Vertical / Horizontal rule, made by the first accepted pair and shared by the rest. One fix per matched pair of distinct pieces; the point on the negative side is the original, its partner the copy (`mirroredFrom [copy, orig, axis]`); a point that mirrors onto itself is pinned onto the axis; a circle pair also gets `equalRadius`. A piece symmetric to itself is not a fix.
17. **Round sizes:** whole drawing units only when one unit is at least 4 px on screen (else whole numbers are too fine to matter); never a typed size; applied with a temporary distance / radius rule that is removed after the solve.
18. **Labels:** Joined, On curve, Tangent, Horizontal, Vertical, Parallel, Square, Same centre, Mirror pair, Same length ×n, Same radius ×n, Evenly spaced, Rounded to N. Joined / Parallel / Same centre show "×n" only above 2; the equal-size groups always show it. More than 20 badges collapse into one per kind ("Tangent ×7"); clicking a collapsed badge switches every fix of that kind off when all are on, else all on.
19. **Refusals:** more than 150 pieces → no fixes, note "Too much to clean up at once — select a part"; rules that don't hold before Clean up starts → no fixes, note "Some rules don’t hold, so nothing is safe to change"; no fixes → note "Nothing to change". The preview still opens (so Strong can be tried).
20. **Fix ids are stable** (`kind:` + the point ids it ties), so a switched-off fix stays off across strength changes as long as it is still found. Each Clean up starts with every fix on (no remembered refusals — spec, out of scope).
21. **Apply sparkles** at up to 12 accepted fixes; status "Cleaned up · N changes".
22. **The Clean up card gets a demo** (the stage-2 demo system makes it one pure function); Apply, Cancel and the strength control get plain cards.
23. **Speed:** each candidate solves only the connected part of the drawing it touches (`componentOf`); the preview re-solves synchronously on every switch.
24. **The pen page gains a `load(doc)` test hook** (sets up a drawing — allowed by the hook rule) so the trimmed flower can be built with gaps smaller than the pen's own snap distance.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/app/lib/sketch/cleanup/types.ts` (new) | strengths, `TOL` / `GUARD`, fix kinds and names, `Candidate`, options, result | 1 |
| `frontend/app/lib/sketch/cleanup/cluster.ts` (new) | complete-linkage grouping (1-D, circular, pairwise), ambiguity guard | 1 |
| `frontend/app/lib/sketch/cleanup/rank.ts` (new) | `RowBasis` (incremental row rank), free slots, Jacobian rows | 1 |
| `frontend/app/lib/sketch/cleanup/context.ts` (new) | pieces, scope → held, copies, rule helpers | 2 |
| `frontend/app/lib/sketch/cleanup/detect-topology.ts` (new) | joins, on curve, tangent | 2 |
| `frontend/app/lib/sketch/cleanup/detect-directions.ts` (new) | horizontal / vertical, parallel / perpendicular | 3 |
| `frontend/app/lib/sketch/cleanup/detect-shape.ts` (new) | concentric, mirror pairs, equal lengths, equal radii, even spacing, round sizes | 4 |
| `frontend/app/lib/sketch/cleanup/guards.ts` (new) | held solve, connected part, baseline, movement cap, broken arcs | 5 |
| `frontend/app/lib/sketch/cleanup/run.ts` (new) | the staged greedy runner `runCleanup` | 5 |
| `frontend/app/lib/sketch/cleanup/badges.ts` (new) | badge layout and collapse | 7 |
| `frontend/app/lib/sketch/cleanup/index.ts` (new) | public exports | 5, 7 |
| `frontend/app/composables/pen/usePen.ts` | the preview session, options, key routing, session-end hooks | 6 |
| `frontend/app/composables/pen/penKeys.ts` | `isCleanupKey`, ⌥⇧C | 6 |
| `frontend/app/components/pen/PenOverlay.vue` | ghost + cleaned drawing, badges, input guards, key routing | 7 |
| `frontend/app/components/pen/PenToolbar.vue` | Clean up button, strength / Apply / Cancel row, disabled states | 8 |
| `frontend/app/composables/pen/penTips.ts`, `penTipDemos.ts` | four cards, the Clean up demo, ⌥ in key labels | 8 |
| `frontend/app/pages/dev/sketch-draw.vue` | `load` and `cleanup` test hooks | 9 |
| `frontend/tests/unit/cleanup-cluster.unit.spec.ts` (new) | Task 1 | 1 |
| `frontend/tests/unit/cleanup-topology.unit.spec.ts` (new) | Task 2 | 2 |
| `frontend/tests/unit/cleanup-directions.unit.spec.ts` (new) | Task 3 | 3 |
| `frontend/tests/unit/cleanup-shape.unit.spec.ts` (new) | Task 4 | 4 |
| `frontend/tests/unit/cleanup-run.unit.spec.ts` (new) | Task 5 | 5 |
| `frontend/tests/unit/pen-cleanup.unit.spec.ts` (new) | Task 6 | 6 |
| `frontend/tests/unit/cleanup-badges.unit.spec.ts`, `pen-overlay-cleanup.unit.spec.ts` (new) | Task 7 | 7 |
| `frontend/tests/unit/pen-tips.unit.spec.ts` | card sweep + demo list | 8 |
| `frontend/tests/pen-cleanup.spec.ts` (new) | real-mouse Playwright, hosts, widths | 9 |

---

### Task 1: Foundations — types and tolerances, complete-linkage grouping, row rank

**Files:**
- Create: `frontend/app/lib/sketch/cleanup/types.ts`
- Create: `frontend/app/lib/sketch/cleanup/cluster.ts`
- Create: `frontend/app/lib/sketch/cleanup/rank.ts`
- Test: `frontend/tests/unit/cleanup-cluster.unit.spec.ts`

**Interfaces:**
- Consumes: `RuleSpec` from `lib/sketch/tangency.ts`; `buildJacobian`, `SlotRef` from `lib/sketch/jacobian.ts`.
- Produces (exact names later tasks use):
  - `types.ts`: `CleanupStrength`, `STRENGTH_FACTOR`, `STRENGTHS`, `TOL`, `GUARD`, `FixKind`, `FIX_KIND_NAME`, `countLabel(name, n)`, `Candidate`, `CleanupScope`, `CleanupOptions`, `CleanupFix`, `CleanupResult`.
  - `cluster.ts`: `clusterSorted(items, value, fits)`, `clusterCircular(items, angle, tol, period?) → { items, values }[]`, `clusterPairs(items, near, allowed?)`, `outsideGap(lo, hi, others, period?)`, `unambiguous(lo, hi, others, period?)`, `mean(xs)`, `meanPoint(ps)`.
  - `rank.ts`: `class RowBasis { constructor(n, tol?); rank; add(row): boolean }`, `rankOf(rows, n)`, `freeSlots(doc, held): SlotRef[]`, `rowsFor(doc, slots, constraints): number[][]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/cleanup-cluster.unit.spec.ts`:

```ts
// tests/unit/cleanup-cluster.unit.spec.ts
// Clean up's foundations (pen stage 5): grouping similar values without
// chaining (complete linkage) in 1-D, on the 180° circle of line directions
// and pairwise in the plane; the ambiguity guard; and the incremental row
// rank that tells a rule that adds something from one that is already implied.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addCircle } from '~/lib/sketch/edit'
import { clusterSorted, clusterCircular, clusterPairs, outsideGap, unambiguous, meanPoint } from '~/lib/sketch/cleanup/cluster'
import { RowBasis, rankOf, freeSlots, rowsFor } from '~/lib/sketch/cleanup/rank'
import { STRENGTH_FACTOR, TOL, countLabel } from '~/lib/sketch/cleanup/types'

describe('types', () => {
  it('carries the spec’s strengths and tolerances', () => {
    expect(STRENGTH_FACTOR).toEqual({ gentle: 0.5, normal: 1, strong: 1.75 })
    expect(TOL).toMatchObject({ JOIN_PX: 6, ON_CURVE_PX: 5, KINK_DEG: 8, HV_DEG: 4, PAR_DEG: 4, CONC_PX: 6, CONC_FRAC: 0.04,
      LEN_FRAC: 0.04, LEN_PX: 4, RAD_FRAC: 0.05, RAD_PX: 3, GAP_FRAC: 0.06, MIRROR_PX: 6, ROUND_FRAC: 0.02 })
  })
  it('shows a count only above a pair', () => {
    expect(countLabel('Parallel', 2)).toBe('Parallel')
    expect(countLabel('Parallel', 3)).toBe('Parallel ×3')
  })
})

describe('clusterSorted', () => {
  it('groups without chaining: no group spreads past the tolerance', () => {
    const g = clusterSorted([1, 1.3, 1.6, 1.9], v => v, (lo, hi) => hi - lo <= 0.5)
    expect(g).toHaveLength(2)
    for (const x of g) expect(Math.max(...x) - Math.min(...x)).toBeLessThanOrEqual(0.5)
    expect(g.flat().sort()).toEqual([1, 1.3, 1.6, 1.9])
  })
  it('leaves values that fit nothing on their own', () => {
    expect(clusterSorted([1, 5, 9], v => v, (lo, hi) => hi - lo <= 0.5)).toEqual([[1], [5], [9]])
  })
})

describe('clusterCircular', () => {
  it('joins 179° and 1° across the wrap, and unwraps their values', () => {
    const g = clusterCircular([179, 1, 90, 91.5], a => a, 4)
    const wrap = g.find(x => x.items.includes(179))!
    expect(wrap.items.sort((a, b) => a - b)).toEqual([1, 179])
    expect(wrap.values).toEqual([179, 181])
    expect(g.find(x => x.items.includes(90))!.items.sort((a, b) => a - b)).toEqual([90, 91.5])
  })
})

describe('clusterPairs', () => {
  it('complete linkage: a chain of near pairs is not one group', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }]
    const near = (a: { x: number }, b: { x: number }) => (Math.abs(a.x - b.x) <= 0.6 ? Math.abs(a.x - b.x) : null)
    const g = clusterPairs(pts, near)
    expect(g.map(x => x.map(p => p.x))).toEqual([[0, 0.5], [1]])
  })
  it('a group can be vetoed', () => {
    const near = () => 0.1
    expect(clusterPairs([1, 2, 3], near, grp => grp.length <= 2)).toEqual([[1, 2], [3]])
  })
})

describe('the ambiguity guard', () => {
  it('skips a group whose spread is large next to the gap to the nearest other value', () => {
    expect(outsideGap(10, 10.3, [10.9])).toBeCloseTo(0.6, 12)
    expect(unambiguous(10, 10.3, [10.9])).toBe(false)
    expect(unambiguous(10, 10.3, [11.2])).toBe(true)
  })
  it('measures round the circle for angles', () => {
    expect(outsideGap(178, 180.5, [3], 180)).toBeCloseTo(2.5, 12)
    expect(unambiguous(178, 180.5, [3], 180)).toBe(false)
  })
  it('meanPoint', () => {
    expect(meanPoint([{ x: 0, y: 0 }, { x: 2, y: 4 }])).toEqual({ x: 1, y: 2 })
  })
})

describe('RowBasis', () => {
  it('counts independent rows only', () => {
    const b = new RowBasis(3)
    expect(b.add([1, 0, 0])).toBe(true)
    expect(b.add([0, 2, 0])).toBe(true)
    expect(b.add([3, 3, 0])).toBe(false)
    expect(b.add([1, 1, 1e-12])).toBe(false)
    expect(b.add([0, 0, 0])).toBe(false)
    expect(b.rank).toBe(2)
    expect(rankOf([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], 3)).toBe(3)
  })
})

describe('free slots and rows', () => {
  it('leave out fixed and held points and held circles', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), f = addPoint(d, 2, 0, { fixed: true })
    const c = addCircle(d, f, 1), c2 = addCircle(d, f, 2)
    const slots = freeSlots(d, new Set([b, c2]))
    expect(slots).toEqual([{ kind: 'px', id: a }, { kind: 'py', id: a }, { kind: 'r', id: c }])
  })
  it('one row per residual, in slot columns', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 3, 1)
    const slots = freeSlots(d, new Set())
    expect(rowsFor(d, slots, [{ id: 'x', kind: 'horizontal', refs: [a, b] }])).toEqual([[0, 1, 0, -1]])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-cluster.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/cleanup/cluster"`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/cleanup/types.ts`**

```ts
// app/lib/sketch/cleanup/types.ts
// Clean up (pen stage 5): the shared vocabulary of the detectors, the staged
// solve and the pen's preview — strengths, tolerances (screen px at the zoom
// Clean up opened at, × the strength), fix kinds and their plain names, the
// candidate a detector proposes and the result the pen previews.
import type { EntityId, SketchDoc } from '../model'
import type { Vec2 } from '../geom'
import type { RuleSpec } from '../tangency'

export type CleanupStrength = 'gentle' | 'normal' | 'strong'
export const STRENGTH_FACTOR: Record<CleanupStrength, number> = { gentle: 0.5, normal: 1, strong: 1.75 }
export const STRENGTHS: CleanupStrength[] = ['gentle', 'normal', 'strong']

/** The spec's detector tolerances: screen px (× unitsPerPx), degrees and
 *  fractions — every one of them × the strength factor. */
export const TOL = {
  JOIN_PX: 6,
  JOIN_SHORT_FRAC: 0.25,   // a gap may be at most this share of the shorter piece
  ON_CURVE_PX: 5,
  KINK_DEG: 8,
  HV_DEG: 4,
  PAR_DEG: 4,
  CONC_PX: 6,
  CONC_FRAC: 0.04,
  LEN_FRAC: 0.04,
  LEN_PX: 4,
  RAD_FRAC: 0.05,
  RAD_PX: 3,
  GAP_FRAC: 0.06,
  MIRROR_PX: 6,
  ROUND_FRAC: 0.02,
} as const

/** Guards on an accepted fix — not scaled by the strength. */
export const GUARD = {
  MOVE_PX: 8,            // no point moves further than this…
  MOVE_FRAC: 0.1,        // …or this share of the smallest piece it belongs to, whichever is larger
  ARC_MIN_PX: 2,         // no arc ends shorter than this (length or radius); no line under it is looked at
  MAX_PIECES: 150,       // above this Clean up refuses (select a part)
  ROUND_MIN_UNIT_PX: 4,  // round sizes only when one drawing unit is at least this big on screen
} as const

export type FixKind =
  | 'join' | 'onCurve' | 'tangent'
  | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular'
  | 'concentric' | 'mirror'
  | 'equalLength' | 'equalRadius' | 'evenSpacing'
  | 'round'

/** A kind's plain name — a collapsed badge reads "<name> ×<count>". */
export const FIX_KIND_NAME: Record<FixKind, string> = {
  join: 'Joined', onCurve: 'On curve', tangent: 'Tangent',
  horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Square',
  concentric: 'Same centre', mirror: 'Mirror pair',
  equalLength: 'Same length', equalRadius: 'Same radius', evenSpacing: 'Evenly spaced',
  round: 'Rounded',
}

/** "Parallel", "Parallel ×3": the count shows once a group is bigger than a pair. */
export function countLabel(name: string, n: number): string {
  return n > 2 ? `${name} ×${n}` : name
}

/** One proposed fix. Refs are the working drawing's ids at detection time. */
export interface Candidate {
  id: string                    // stable: kind + the point ids it ties
  kind: FixKind
  label: string
  score: number                 // higher first, within a pass
  anchor: EntityId[]            // the badge sits at the mean of these points
  /** points that become one, placed at `at` (unless one of them may not move) */
  merges?: { points: EntityId[]; at: Vec2 }
  rules?: RuleSpec[]
  /** adds guide pieces (construction points / lines) to the working drawing and
   *  returns the rules that use them; `guides` shares a guide between fixes */
  prepare?: (doc: SketchDoc, guides: Map<string, EntityId>) => RuleSpec[]
  /** a one-off size change: solved with a temporary rule that is then removed */
  nudge?: { refs: [EntityId, EntityId]; value: number } | { circle: EntityId; value: number }
}

export interface CleanupScope { entities: EntityId[]; segments: { pathId: EntityId; segIndex: number }[] }

export interface CleanupOptions {
  unitsPerPx: number            // drawing units per screen px, at the zoom Clean up opened at
  strength: CleanupStrength
  scope?: CleanupScope | null   // null: the whole drawing
  off?: ReadonlySet<string>     // fix ids switched off
  openOnly?: boolean            // a join may not close a path
}

export interface CleanupFix { id: string; kind: FixKind; label: string; on: boolean; at: Vec2 }

export interface CleanupResult {
  doc: SketchDoc
  fixes: CleanupFix[]
  refused?: 'conflict' | 'tooBig'
}
```

- [ ] **Step 4: Create `frontend/app/lib/sketch/cleanup/cluster.ts`**

```ts
// app/lib/sketch/cleanup/cluster.ts
// Grouping similar values without chaining (complete linkage): a group's
// spread never exceeds the tolerance, however many members sit in a row.
// 1-D values (lengths, radii), angles on a 180° circle, and pairs with their
// own nearness test (points in the plane). Plus the ambiguity guard: a group
// whose spread is large next to the distance to the nearest value outside it
// is a guess, and is skipped.
import type { Vec2 } from '../geom'

/** Complete-linkage groups of `items` by `value`. Groups are runs of the sorted
 *  values; the two neighbouring groups whose union spans least are merged while
 *  `fits(lo, hi)` holds for the union. */
export function clusterSorted<T>(items: readonly T[], value: (t: T) => number, fits: (lo: number, hi: number) => boolean): T[][] {
  const sorted = items.map((t, i) => ({ t, v: value(t), i })).sort((a, b) => a.v - b.v || a.i - b.i)
  const groups = sorted.map(x => [x])
  for (;;) {
    let best = -1
    let bestSpan = Infinity
    for (let k = 0; k + 1 < groups.length; k++) {
      const left = groups[k]!, right = groups[k + 1]!
      const lo = left[0]!.v, hi = right[right.length - 1]!.v
      if (!fits(lo, hi)) continue
      if (hi - lo < bestSpan) { bestSpan = hi - lo; best = k }
    }
    if (best < 0) break
    groups.splice(best, 2, [...groups[best]!, ...groups[best + 1]!])
  }
  return groups.map(g => g.map(x => x.t))
}

/** Complete-linkage groups of angles on a circle of `period` degrees (180 for
 *  line directions). Each group comes with its members' angles, unwrapped so
 *  they ascend without a jump (179 and 181 for 179° and 1°). */
export function clusterCircular<T>(items: readonly T[], angle: (t: T) => number, tol: number, period = 180): { items: T[]; values: number[] }[] {
  if (!items.length) return []
  const norm = (a: number) => ((a % period) + period) % period
  const vs = items.map((t, i) => ({ t, v: norm(angle(t)), i })).sort((a, b) => a.v - b.v || a.i - b.i)
  // cut the circle at its widest empty stretch, so no group straddles the cut
  let cut = 0
  let widest = vs[0]!.v + period - vs[vs.length - 1]!.v
  for (let k = 1; k < vs.length; k++) {
    const gap = vs[k]!.v - vs[k - 1]!.v
    if (gap > widest) { widest = gap; cut = k }
  }
  const line = [...vs.slice(cut), ...vs.slice(0, cut).map(x => ({ ...x, v: x.v + period }))]
  return clusterSorted(line, x => x.v, (lo, hi) => hi - lo <= tol)
    .map(g => ({ items: g.map(x => x.t), values: g.map(x => x.v) }))
}

/** Complete-linkage groups of items that are pairwise near. `near(a, b)` is the
 *  pair's distance when they may share a group, else null; `allowed` may veto
 *  a merged group. Closest pairs merge first. */
export function clusterPairs<T>(items: readonly T[], near: (a: T, b: T) => number | null, allowed: (group: T[]) => boolean = () => true): T[][] {
  const pairs: { i: number; j: number; d: number }[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = near(items[i]!, items[j]!)
      if (d != null) pairs.push({ i, j, d })
    }
  }
  pairs.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j)
  const group = items.map((_, i) => i)
  const members: number[][] = items.map((_, i) => [i])
  for (const p of pairs) {
    const gi = group[p.i]!, gj = group[p.j]!
    if (gi === gj) continue
    const A = members[gi]!, B = members[gj]!
    if (!A.every(a => B.every(b => near(items[a]!, items[b]!) != null))) continue
    const merged = [...A, ...B].sort((x, y) => x - y)
    if (!allowed(merged.map(k => items[k]!))) continue
    const keep = Math.min(gi, gj), drop = Math.max(gi, gj)
    members[keep] = merged
    members[drop] = []
    for (const k of merged) group[k] = keep
  }
  return members.filter(m => m.length).map(m => m.map(k => items[k]!))
}

/** The distance from the span [lo, hi] to the nearest of `others` (going round
 *  the circle when `period` is given). */
export function outsideGap(lo: number, hi: number, others: readonly number[], period?: number): number {
  let g = Infinity
  for (const o of others) {
    if (period) {
      const up = (((o - hi) % period) + period) % period
      const down = (((lo - o) % period) + period) % period
      g = Math.min(g, up, down)
    } else {
      g = Math.min(g, o > hi ? o - hi : o < lo ? lo - o : 0)
    }
  }
  return g
}

/** The ambiguity guard: a group is a clear call only when 2.5 × its spread
 *  fits in the gap to the nearest value outside it. */
export function unambiguous(lo: number, hi: number, others: readonly number[], period?: number): boolean {
  return (hi - lo) * 2.5 <= outsideGap(lo, hi, others, period)
}

export const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
export const meanPoint = (ps: readonly Vec2[]): Vec2 => ({ x: mean(ps.map(p => p.x)), y: mean(ps.map(p => p.y)) })
```

- [ ] **Step 5: Create `frontend/app/lib/sketch/cleanup/rank.ts`**

```ts
// app/lib/sketch/cleanup/rank.ts
// "Does this rule add anything?" A rule adds something when its Jacobian rows
// raise the rank of the rows the drawing already has (over the scalars that
// may move). An implied rule — or one that contradicts the others — does not.
import type { SketchDoc, SketchConstraint, EntityId } from '../model'
import { buildJacobian, type SlotRef } from '../jacobian'

/** An orthonormal basis of rows, grown one row at a time (modified
 *  Gram-Schmidt, done twice for stability). Rows are scaled to unit length
 *  before the test, so `tol` is relative. */
export class RowBasis {
  private readonly basis: Float64Array[] = []
  constructor(private readonly n: number, private readonly tol = 1e-7) {}
  get rank(): number { return this.basis.length }
  /** Adds the row when it is independent of the basis; true when it did. */
  add(row: ArrayLike<number>): boolean {
    let s = 0
    for (let i = 0; i < this.n; i++) s += (row[i] ?? 0) ** 2
    const n0 = Math.sqrt(s)
    if (n0 < 1e-12) return false
    const v = new Float64Array(this.n)
    for (let i = 0; i < this.n; i++) v[i] = (row[i] ?? 0) / n0
    for (let pass = 0; pass < 2; pass++) {
      for (const b of this.basis) {
        let d = 0
        for (let i = 0; i < this.n; i++) d += v[i]! * b[i]!
        if (d !== 0) for (let i = 0; i < this.n; i++) v[i] = v[i]! - d * b[i]!
      }
    }
    let r = 0
    for (let i = 0; i < this.n; i++) r += v[i]! * v[i]!
    r = Math.sqrt(r)
    if (r < this.tol) return false
    for (let i = 0; i < this.n; i++) v[i] = v[i]! / r
    this.basis.push(v)
    return true
  }
}

export function rankOf(rows: readonly ArrayLike<number>[], n: number): number {
  const b = new RowBasis(n)
  for (const r of rows) b.add(r)
  return b.rank
}

/** The solver's free scalars, with `held` points and circles held as well. */
export function freeSlots(doc: SketchDoc, held: ReadonlySet<EntityId>): SlotRef[] {
  const out: SlotRef[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') {
      if (!e.fixed && !held.has(e.id)) out.push({ kind: 'px', id: e.id }, { kind: 'py', id: e.id })
    } else if (e.kind === 'circle' && !held.has(e.id)) {
      out.push({ kind: 'r', id: e.id })
    }
  }
  return out
}

/** The Jacobian rows of `constraints` over `slots` (the analytic rows the solver uses). */
export function rowsFor(doc: SketchDoc, slots: SlotRef[], constraints: SketchConstraint[]): number[][] {
  return buildJacobian({ entities: doc.entities, constraints }, slots)
}
```

- [ ] **Step 6: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-cluster.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/cleanup/'` → no lines.

- [ ] **Step 7: Commit** `frontend/app/lib/sketch/cleanup/types.ts frontend/app/lib/sketch/cleanup/cluster.ts frontend/app/lib/sketch/cleanup/rank.ts frontend/tests/unit/cleanup-cluster.unit.spec.ts` — message `feat(pen): Clean up foundations — tolerances, complete-linkage grouping, row rank`.

---

### Task 2: The drawing as detectors read it, and the first stage — joins, On curve, Tangent

**Files:**
- Create: `frontend/app/lib/sketch/cleanup/context.ts`
- Create: `frontend/app/lib/sketch/cleanup/detect-topology.ts`
- Test: `frontend/tests/unit/cleanup-topology.unit.spec.ts`

**Behaviour (spec §"What it finds" 1–3, with rulings):**
- **Pieces** are line entities, circles and path line / arc segments — never guides (construction), never Bézier segments (`allCurves` already skips cubics).
- **Scope → held** (**Ruling 6**): with a selection of pieces, every point of an unselected piece (including one a selected piece shares with it), every point no selected piece uses, and every unselected circle's radius are held. No usable selection (nothing, or points only) holds nothing.
- **Copies:** the copy point (`refs[0]`) of every `rotatedFrom` / `mirroredFrom` rule. A piece is a copy when all its points are. A detector skips a candidate whose pieces / points are all copies; a candidate that mixes a source and a copy (a seam) is kept.
- **Ends that nearly meet** (1): points that are a loose end (`pointRole` 'end') of a line or arc piece, clustered with complete linkage by distance ≤ 6 px × strength with **Ruling 10**: two already-shared points ('joint') never cluster together, never both ends of one piece, the gap ≤ 25 % of the shorter piece. One candidate per cluster: `merges` = all its points at their mean. Label "Joined" (×n above 2). Id `join:<sorted point ids>`.
- **A point nearly on a curve** (2), ≤ 5 px × strength (**Ruling 11**): only loose ends and free points; the nearest piece that doesn't use the point; not within the join distance of that piece's own ends. The rule is the pen's own on-curve form: `pointOnLine [p, lineId]`, `pointOnCircle [p, circleId]`, `collinear [A, B, p]` on a path line segment, `equalDist [C, p, C, A]` on a path arc segment. Label "On curve". Id `onCurve:<p>:<piece key>`.
- **A nearly smooth joint** (3), kink ≤ 8° × strength (**Ruling 12**): a point where exactly two pieces meet, at least one of them an arc; the kink is the angle between one piece's outward direction and the reverse of the other's (a cusp — the pieces leaving the same way — is 180°, never smooth). The rule is `tangentRuleFor` (stage 4's joint forms: `perpendicular [other, J, J, C]` for line–arc, `collinear [C1, J, C2]` for arc–arc). Label "Tangent". Id `tangent:<J>`.

**Interfaces:**
- Consumes: Task 1 (`types.ts`, `cluster.ts`); `allCurves`, `curveGeom`, `paramOf`, `pointAt`, `CurveRef`, `CurveGeom` from `crossings.ts`; `curveKey`, `pieceOf`, `tangentRuleFor`, `RuleSpec` from `tangency.ts`; `pointRolesForDoc`, `PointRole` from `pointRoles.ts`.
- Produces:
  - `context.ts`: `interface Piece { key, ref, kind: 'line'|'arc'|'circle', a, b, c, circle, lineId, points, inScope, copy, len, size, geom }`, `interface CleanupContext { doc, s, unitsPerPx, openOnly, pieces, held, copies, roles, pts, tol(px) }`, `interface ContextEnv { held, copies, s, unitsPerPx, openOnly? }`, `pairKey(a, b)`, `stableKey(piece)`, `curvePoints(doc, ref)`, `copyPoints(doc)`, `heldForScope(doc, scope)`, `buildContext(doc, env)`, `onCurveRule(piece, p)`, `typedLength(doc, a, b)`, `typedSize(doc, piece)`, `radiusOf(piece)`, `lineAngleDeg(piece)`, `linePieces(ctx)`.
  - `detect-topology.ts`: `detectJoins(ctx)`, `detectOnCurve(ctx)`, `detectTangents(ctx)` — each `(ctx: CleanupContext) => Candidate[]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/cleanup-topology.unit.spec.ts`:

```ts
// tests/unit/cleanup-topology.unit.spec.ts
// Clean up, stage 1 (pen stage 5): what a detector sees of the drawing
// (pieces, scope, copies) and the three topology detectors — ends that
// nearly meet, a point nearly on a curve, a joint that is nearly smooth.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { buildContext, heldForScope, copyPoints, type ContextEnv } from '~/lib/sketch/cleanup/context'
import { detectJoins, detectOnCurve, detectTangents } from '~/lib/sketch/cleanup/detect-topology'
import { STRENGTH_FACTOR } from '~/lib/sketch/cleanup/types'

const U = 1 / 34   // the dev page's zoom: 34 px per drawing unit
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ held: new Set(), copies: new Set(), s: 1, unitsPerPx: U, ...o })
function line(d: SketchDoc, x0: number, y0: number, x1: number, y1: number) {
  const a = addPoint(d, x0, y0), b = addPoint(d, x1, y1)
  return { a, b, id: addPath(d, [a, b], [{ kind: 'line' }]) }
}

describe('buildContext', () => {
  it('lists lines, arcs and circles — not guides, not Bézier segments', () => {
    const d = blank()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    addLine(d, addPoint(d, 0, 2), addPoint(d, 4, 2), { construction: true })
    const c = addCircle(d, addPoint(d, 10, 10), 2)
    const a = addPoint(d, 0, 5), b = addPoint(d, 4, 5), m = addPoint(d, 8, 5)
    const path = addPath(d, [a, b, m], [{ kind: 'arc', center: addPoint(d, 2, 5), sweep: 1 }, { kind: 'cubic', h1: null, h2: null }])
    const ctx = buildContext(d, env())
    expect(ctx.pieces.map(p => p.key).sort()).toEqual([`${path}:0`, c, l].sort())
    expect(ctx.pieces.find(p => p.key === l)!.kind).toBe('line')
    expect(ctx.pieces.find(p => p.key === `${path}:0`)!.kind).toBe('arc')
    expect(ctx.pieces.find(p => p.key === `${path}:0`)!.len).toBeCloseTo(2 * Math.PI, 9)
  })
  it('a selection holds everything outside it, and points it shares with the rest', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0)
    const q = addPath(d, [p.b, addPoint(d, 8, 0)], [{ kind: 'line' }])
    const held = heldForScope(d, { entities: [p.id], segments: [] })
    expect(held.has(p.a)).toBe(false)
    expect(held.has(p.b)).toBe(true)
    const ctx = buildContext(d, env({ held }))
    expect(ctx.pieces.find(x => x.key === `${p.id}:0`)!.inScope).toBe(true)
    expect(ctx.pieces.find(x => x.key === `${q}:0`)!.inScope).toBe(false)
  })
  it('no usable selection holds nothing', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0)
    expect(heldForScope(d, { entities: [p.a], segments: [] }).size).toBe(0)
    expect(heldForScope(d, null).size).toBe(0)
  })
  it('copies are the copy points of Repeat and Mirror rules', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), c = addPoint(d, 0, 0, { fixed: true })
    addConstraint(d, 'rotatedFrom', [b, a, c], 90)
    expect([...copyPoints(d)]).toEqual([b])
  })
})

describe('detectJoins', () => {
  it('ends 3.4 px apart become one join, placed between them', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0), q = line(d, 4.1, 0, 8, 1)
    const c = detectJoins(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'join', label: 'Joined', id: `join:${[p.b, q.a].sort().join(',')}` })
    expect([...c[0]!.merges!.points].sort()).toEqual([p.b, q.a].sort())
    expect(c[0]!.merges!.at.x).toBeCloseTo(4.05, 9)
  })
  it('a 6.8 px gap joins only at Strong', () => {
    const d = blank()
    line(d, 0, 0, 4, 0); line(d, 4.2, 0, 8, 1)
    expect(detectJoins(buildContext(d, env()))).toHaveLength(0)
    expect(detectJoins(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(1)
  })
  it('never joins a gap bigger than a quarter of the shorter piece', () => {
    const d = blank()
    line(d, 0, 0, 4, 0); line(d, 4.1, 0, 4.4, 0)
    expect(detectJoins(buildContext(d, env()))).toHaveLength(0)
  })
  it('leaves two already-shared points alone', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 2, 0), c = addPoint(d, 4, 0)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    const e = addPoint(d, 2.05, 0.05), f = addPoint(d, 2, 3), g = addPoint(d, 2.1, 3.5)
    addPath(d, [f, e, g], [{ kind: 'line' }, { kind: 'line' }])
    expect(detectJoins(buildContext(d, env()))).toHaveLength(0)
  })
  it('skips a gap between two copies', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0), q = line(d, 4.1, 0, 8, 1)
    expect(detectJoins(buildContext(d, env({ copies: new Set([p.b, q.a]) })))).toHaveLength(0)
  })
})

describe('detectOnCurve', () => {
  it('pins a loose end onto a circle, a path line and a path arc with the pen’s own rules', () => {
    const d = blank()
    const circle = addCircle(d, addPoint(d, 0, 0), 3)
    const e1 = line(d, 3.1, 0, 6, 0)
    const seg = line(d, 10, 0, 10, 8)
    const e2 = line(d, 10.1, 4, 14, 4)
    const A = addPoint(d, 20, 0), B = addPoint(d, 26, 0), C = addPoint(d, 23, 0)
    addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])   // the lower half, lowest at (23, -3)
    const e3 = line(d, 23, -3.1, 23, -7)
    const c = detectOnCurve(buildContext(d, env()))
    const rule = (p: string) => c.find(x => x.anchor[0] === p)?.rules?.[0]
    expect(rule(e1.a)).toEqual({ kind: 'pointOnCircle', refs: [e1.a, circle] })
    expect(rule(e2.a)).toEqual({ kind: 'collinear', refs: [seg.a, seg.b, e2.a] })
    expect(rule(e3.a)).toEqual({ kind: 'equalDist', refs: [C, e3.a, C, A] })
    expect(c.every(x => x.label === 'On curve' && x.kind === 'onCurve')).toBe(true)
  })
  it('near a piece’s end it is a join, not a pin', () => {
    const d = blank()
    line(d, 0, 0, 4, 0)
    const q = line(d, 4.05, 0.1, 6, 3)
    expect(detectOnCurve(buildContext(d, env())).find(x => x.anchor[0] === q.a)).toBeUndefined()
  })
})

describe('detectTangents', () => {
  const r = 3
  function build(kinkDeg: number, sweep: 0 | 1 = 1) {
    const d = blank()
    const k = kinkDeg * Math.PI / 180
    const A = addPoint(d, 0, 0), J = addPoint(d, 4, 0)
    const C = addPoint(d, 4 + r * Math.sin(k), r * Math.cos(k))
    const E = addPoint(d, 4 + r * Math.sin(k) + r, r * Math.cos(k))
    addPath(d, [A, J, E], [{ kind: 'line' }, { kind: 'arc', center: C, sweep }])
    return { d, A, J, C }
  }
  it('a 5° kink between a line and an arc → the joint rule', () => {
    const { d, A, J, C } = build(5)
    const c = detectTangents(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ id: `tangent:${J}`, kind: 'tangent', label: 'Tangent', anchor: [J] })
    expect(c[0]!.rules).toEqual([{ kind: 'perpendicular', refs: [A, J, J, C] }])
  })
  it('a 12° kink is left alone at Normal and smoothed at Strong', () => {
    const { d } = build(12)
    expect(detectTangents(buildContext(d, env()))).toHaveLength(0)
    expect(detectTangents(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(1)
  })
  it('a cusp (the arc turning straight back) is not a smooth joint', () => {
    const { d } = build(0, 0)
    expect(detectTangents(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-topology.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/cleanup/context"`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/cleanup/context.ts`**

```ts
// app/lib/sketch/cleanup/context.ts
// What every Clean up detector reads: the drawing's pieces (lines, arcs and
// circles — never guides, never Bézier segments), which points may move (the
// selection's scope), which are Repeat/Mirror copies, point roles, and the
// tolerance in drawing units.
import type { SketchDoc, EntityId, PointEntity } from '../model'
import { getEntity } from '../model'
import { allCurves, curveGeom, type CurveRef, type CurveGeom } from '../crossings'
import { curveKey, type RuleSpec } from '../tangency'
import { pointRolesForDoc, type PointRole } from '../pointRoles'
import { GUARD, type CleanupScope } from './types'

export interface Piece {
  key: string                  // curveKey: a line / circle id, or "pathId:segIndex"
  ref: CurveRef
  kind: 'line' | 'arc' | 'circle'
  a: EntityId | null           // line / arc: start (a path segment's own order)
  b: EntityId | null           // line / arc: end
  c: EntityId | null           // arc / circle: centre
  circle: EntityId | null      // circle entity id
  lineId: EntityId | null      // line entity id
  points: EntityId[]           // a, b, c where present
  inScope: boolean             // something about it may move
  copy: boolean                // every point is a Repeat / Mirror copy
  len: number                  // line length, arc length, circle circumference
  size: number                 // for the movement cap: length (line, arc), radius (circle)
  geom: CurveGeom
}

export interface CleanupContext {
  doc: SketchDoc
  s: number                    // strength factor
  unitsPerPx: number
  openOnly: boolean
  pieces: Piece[]
  held: ReadonlySet<EntityId>  // points (and circle ids) that must not move
  copies: ReadonlySet<EntityId>
  roles: Map<EntityId, PointRole>
  pts: Map<EntityId, PointEntity>
  /** screen px × strength → drawing units */
  tol: (px: number) => number
}

export interface ContextEnv {
  held: ReadonlySet<EntityId>
  copies: ReadonlySet<EntityId>
  s: number
  unitsPerPx: number
  openOnly?: boolean
}

export const pairKey = (a: EntityId, b: EntityId): string => (a < b ? `${a}~${b}` : `${b}~${a}`)

/** A key for a piece built from its points, so it survives a path being joined or renumbered. */
export function stableKey(p: Piece): string {
  if (p.kind === 'circle') return p.circle!
  return p.kind === 'arc' ? `${p.c}@${pairKey(p.a!, p.b!)}` : pairKey(p.a!, p.b!)
}

/** The points a piece is built on: its ends and (arc, circle) its centre. */
export function curvePoints(doc: SketchDoc, ref: CurveRef): EntityId[] {
  if (ref.kind === 'line') { const e = getEntity(doc, ref.id); return e?.kind === 'line' ? [e.p1, e.p2] : [] }
  if (ref.kind === 'circle') { const e = getEntity(doc, ref.id); return e?.kind === 'circle' ? [e.center] : [] }
  const p = getEntity(doc, ref.pathId)
  if (!p || p.kind !== 'path') return []
  const seg = p.segments[ref.segIndex]
  const a = p.anchors[ref.segIndex], b = p.anchors[(ref.segIndex + 1) % p.anchors.length]
  if (!seg || !a || !b) return []
  return seg.kind === 'arc' ? [a, b, seg.center] : [a, b]
}

function isGuide(doc: SketchDoc, ref: CurveRef): boolean {
  const e = getEntity(doc, ref.kind === 'seg' ? ref.pathId : ref.id)
  return !!e && e.kind !== 'point' && !!e.construction
}

/** Points that are Repeat / Mirror copies (the copy of a rotatedFrom / mirroredFrom rule). */
export function copyPoints(doc: SketchDoc): Set<EntityId> {
  const out = new Set<EntityId>()
  for (const c of doc.constraints) if (c.kind === 'rotatedFrom' || c.kind === 'mirroredFrom') out.add(c.refs[0]!)
  return out
}

/** What must not move for a scope: with a selection of pieces, every point of
 *  an unselected piece (shared ones included), every point no selected piece
 *  uses, and every unselected circle's radius. No usable selection: nothing. */
export function heldForScope(doc: SketchDoc, scope: CleanupScope | null | undefined): Set<EntityId> {
  const held = new Set<EntityId>()
  if (!scope) return held
  const keys = new Set<string>()
  for (const id of scope.entities) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind === 'line' || e.kind === 'circle') keys.add(e.id)
    else if (e.kind === 'path') {
      const n = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < n; i++) keys.add(`${e.id}:${i}`)
    }
  }
  for (const s of scope.segments) keys.add(`${s.pathId}:${s.segIndex}`)
  const curves = allCurves(doc).filter(r => !isGuide(doc, r))
  if (!curves.some(r => keys.has(curveKey(r)))) return held
  const free = new Set<EntityId>(), pinned = new Set<EntityId>()
  for (const r of curves) {
    const mine = keys.has(curveKey(r))
    for (const id of curvePoints(doc, r)) (mine ? free : pinned).add(id)
    if (r.kind === 'circle' && !mine) held.add(r.id)
  }
  for (const e of doc.entities) if (e.kind === 'point' && (!free.has(e.id) || pinned.has(e.id))) held.add(e.id)
  return held
}

export function buildContext(doc: SketchDoc, env: ContextEnv): CleanupContext {
  const pts = new Map<EntityId, PointEntity>()
  for (const e of doc.entities) if (e.kind === 'point') pts.set(e.id, e)
  const pieces: Piece[] = []
  for (const ref of allCurves(doc)) {
    if (isGuide(doc, ref)) continue
    const geom = curveGeom(doc, ref)
    if (!geom) continue
    let a: EntityId | null = null, b: EntityId | null = null, c: EntityId | null = null
    let circle: EntityId | null = null, lineId: EntityId | null = null
    if (ref.kind === 'line') {
      const e = getEntity(doc, ref.id)
      if (e?.kind !== 'line') continue
      a = e.p1; b = e.p2; lineId = e.id
    } else if (ref.kind === 'circle') {
      const e = getEntity(doc, ref.id)
      if (e?.kind !== 'circle') continue
      c = e.center; circle = e.id
    } else {
      const [p, q, cc] = curvePoints(doc, ref)
      a = p ?? null; b = q ?? null; c = cc ?? null
    }
    const points = [a, b, c].filter((x): x is EntityId => !!x)
    const len = geom.kind === 'line' ? Math.hypot(geom.b!.x - geom.a!.x, geom.b!.y - geom.a!.y)
      : geom.kind === 'arc' ? geom.r! * Math.abs(geom.sweepAngle!) : 2 * Math.PI * geom.r!
    const inScope = ref.kind === 'circle' ? !env.held.has(circle!) || !env.held.has(c!) : points.some(id => !env.held.has(id))
    pieces.push({
      key: curveKey(ref), ref, kind: geom.kind, a, b, c, circle, lineId, points, inScope,
      copy: points.length > 0 && points.every(id => env.copies.has(id)),
      len, size: geom.kind === 'circle' ? geom.r! : len, geom,
    })
  }
  const u = env.unitsPerPx, s = env.s
  return {
    doc, s, unitsPerPx: u, openOnly: !!env.openOnly, pieces, held: env.held, copies: env.copies,
    roles: pointRolesForDoc(doc), pts, tol: px => px * s * u,
  }
}

/** The rule that keeps point `p` on piece `q` — the pen's own on-curve forms. */
export function onCurveRule(q: Piece, p: EntityId): RuleSpec | null {
  if (q.kind === 'circle') return q.circle ? { kind: 'pointOnCircle', refs: [p, q.circle] } : null
  if (q.kind === 'line') return q.lineId ? { kind: 'pointOnLine', refs: [p, q.lineId] } : { kind: 'collinear', refs: [q.a!, q.b!, p] }
  return { kind: 'equalDist', refs: [q.c!, p, q.c!, q.a!] }
}

/** A typed length (a distance rule — the value chip) between a and b, if any. */
export function typedLength(doc: SketchDoc, a: EntityId, b: EntityId): number | null {
  const c = doc.constraints.find(k => k.kind === 'distance' && k.value != null &&
    ((k.refs[0] === a && k.refs[1] === b) || (k.refs[0] === b && k.refs[1] === a)))
  return c?.value ?? null
}

/** A piece's typed size: a line's length, an arc's radius pin, a circle's radius rule. */
export function typedSize(doc: SketchDoc, p: Piece): number | null {
  if (p.kind === 'line') return typedLength(doc, p.a!, p.b!)
  if (p.kind === 'arc') return typedLength(doc, p.c!, p.a!) ?? typedLength(doc, p.c!, p.b!)
  const c = doc.constraints.find(k => k.kind === 'radius' && k.refs[0] === p.circle && k.value != null)
  return c?.value ?? null
}

export const radiusOf = (p: Piece): number => p.geom.r ?? 0

/** A line's direction in degrees, folded into [0, 180). */
export function lineAngleDeg(p: Piece): number {
  const g = p.geom
  const a = Math.atan2(g.b!.y - g.a!.y, g.b!.x - g.a!.x) * 180 / Math.PI
  return ((a % 180) + 180) % 180
}

/** Line pieces long enough to have a direction worth reading (≥ 2 px). */
export function linePieces(ctx: CleanupContext): Piece[] {
  const min = ctx.unitsPerPx * GUARD.ARC_MIN_PX
  return ctx.pieces.filter(p => p.kind === 'line' && p.len >= min)
}
```

- [ ] **Step 4: Create `frontend/app/lib/sketch/cleanup/detect-topology.ts`**

```ts
// app/lib/sketch/cleanup/detect-topology.ts
// Clean up's first stage: ends that nearly meet (joined into one point),
// points nearly on a curve (On curve) and joints that are nearly smooth
// (Tangent). Pure: reads a CleanupContext, returns candidates.
import type { EntityId } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { paramOf, pointAt } from '../crossings'
import { pieceOf, tangentRuleFor } from '../tangency'
import { clusterPairs, meanPoint } from './cluster'
import { onCurveRule, stableKey, type CleanupContext, type Piece } from './context'
import { TOL, countLabel, type Candidate } from './types'

export function detectJoins(ctx: CleanupContext): Candidate[] {
  const tol = ctx.tol(TOL.JOIN_PX)
  const endsOf = new Map<EntityId, Piece[]>()
  for (const p of ctx.pieces) {
    if (p.kind === 'circle') continue
    for (const id of [p.a!, p.b!]) endsOf.set(id, [...(endsOf.get(id) ?? []), p])
  }
  type Item = { id: EntityId; at: Vec2; pieces: Piece[]; end: boolean }
  const items: Item[] = []
  for (const [id, pieces] of endsOf) {
    const role = ctx.roles.get(id)
    const q = ctx.pts.get(id)
    if (!q || (role !== 'end' && role !== 'joint')) continue
    items.push({ id, at: { x: q.x, y: q.y }, pieces, end: role === 'end' })
  }
  const near = (u: Item, v: Item): number | null => {
    const d = dist(u.at, v.at)
    if (d > tol) return null
    if (!u.end && !v.end) return null                         // two joints: already built, leave them
    if (u.pieces.some(p => v.pieces.includes(p))) return null   // both ends of one piece
    const shortest = Math.min(...u.pieces.map(p => p.len), ...v.pieces.map(p => p.len))
    return d <= TOL.JOIN_SHORT_FRAC * shortest ? d : null
  }
  const out: Candidate[] = []
  for (const g of clusterPairs(items, near, grp => grp.filter(x => !x.end).length <= 1)) {
    if (g.length < 2) continue
    if (!g.some(x => x.pieces.some(p => p.inScope))) continue
    if (g.every(x => ctx.copies.has(x.id))) continue
    const ids = g.map(x => x.id).sort()
    let diam = 0
    for (const u of g) for (const v of g) diam = Math.max(diam, dist(u.at, v.at))
    out.push({
      id: `join:${ids.join(',')}`, kind: 'join', label: countLabel('Joined', g.length),
      score: 2 - diam / tol, anchor: ids, merges: { points: ids, at: meanPoint(g.map(x => x.at)) },
    })
  }
  return out
}

export function detectOnCurve(ctx: CleanupContext): Candidate[] {
  const tol = ctx.tol(TOL.ON_CURVE_PX), joinTol = ctx.tol(TOL.JOIN_PX)
  const out: Candidate[] = []
  for (const [id, pt] of ctx.pts) {
    const role = ctx.roles.get(id)
    if (pt.construction || (role !== 'end' && role !== 'free')) continue
    const movable = !ctx.held.has(id)
    let best: { q: Piece; d: number } | null = null
    for (const q of ctx.pieces) {
      if (q.points.includes(id)) continue
      if (!movable && !q.inScope) continue
      if (ctx.copies.has(id) && q.copy) continue
      const d = dist(pt, pointAt(q.geom, paramOf(q.geom, pt)))
      if (d > tol) continue
      // at a piece's own end it is a join, not a pin
      if (q.kind !== 'circle' && [q.a!, q.b!].some(e => { const E = ctx.pts.get(e); return !!E && dist(E, pt) <= joinTol })) continue
      if (!best || d < best.d) best = { q, d }
    }
    if (!best) continue
    const rule = onCurveRule(best.q, id)
    if (!rule) continue
    out.push({ id: `onCurve:${id}:${stableKey(best.q)}`, kind: 'onCurve', label: 'On curve', score: 1 - best.d / tol, anchor: [id], rules: [rule] })
  }
  return out
}

// the unit direction a piece leaves point `at` in
function outward(p: Piece, at: EntityId): Vec2 | null {
  const g = p.geom
  if (p.kind === 'line') {
    const from = at === p.a ? g.a! : g.b!, to = at === p.a ? g.b! : g.a!
    const L = dist(from, to)
    return L > 1e-12 ? { x: (to.x - from.x) / L, y: (to.y - from.y) / L } : null
  }
  if (p.kind !== 'arc') return null
  const sgn = Math.sign(g.sweepAngle!)
  const atEnd = at === p.b
  const ang = g.a0! + (atEnd ? g.sweepAngle! : 0)
  const travel = { x: -Math.sin(ang) * sgn, y: Math.cos(ang) * sgn }
  return atEnd ? { x: -travel.x, y: -travel.y } : travel
}

export function detectTangents(ctx: CleanupContext): Candidate[] {
  const tolDeg = TOL.KINK_DEG * ctx.s
  const at = new Map<EntityId, Piece[]>()
  for (const p of ctx.pieces) {
    if (p.kind === 'circle' || p.a === p.b) continue
    for (const id of [p.a!, p.b!]) at.set(id, [...(at.get(id) ?? []), p])
  }
  const out: Candidate[] = []
  for (const [J, ps] of at) {
    if (ps.length !== 2) continue
    const [p, q] = ps as [Piece, Piece]
    if (p.kind === 'line' && q.kind === 'line') continue
    if ((p.a === q.a || p.a === q.b) && (p.b === q.a || p.b === q.b)) continue   // two pieces on the same two points
    if (!p.inScope && !q.inScope) continue
    if (p.copy && q.copy) continue
    const u = outward(p, J), v = outward(q, J)
    if (!u || !v) continue
    const kink = Math.acos(Math.max(-1, Math.min(1, -(u.x * v.x + u.y * v.y)))) * 180 / Math.PI
    if (kink > tolDeg) continue
    const tp = pieceOf(ctx.doc, p.ref), tq = pieceOf(ctx.doc, q.ref)
    const rule = tp && tq ? tangentRuleFor(ctx.doc, tp, tq) : null
    if (!rule) continue
    out.push({ id: `tangent:${J}`, kind: 'tangent', label: 'Tangent', score: 1 - kink / tolDeg, anchor: [J], rules: [rule] })
  }
  return out
}
```

- [ ] **Step 5: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-topology.unit.spec.ts tests/unit/cleanup-cluster.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/cleanup/'` → no lines.

- [ ] **Step 6: Commit** `frontend/app/lib/sketch/cleanup/context.ts frontend/app/lib/sketch/cleanup/detect-topology.ts frontend/tests/unit/cleanup-topology.unit.spec.ts` — message `feat(pen): Clean up sees the drawing — pieces, scope, copies; finds ends that nearly meet, points nearly on a curve, nearly smooth joints`.

---

### Task 3: Directions — Horizontal / Vertical, Parallel, Square

**Files:**
- Create: `frontend/app/lib/sketch/cleanup/detect-directions.ts`
- Test: `frontend/tests/unit/cleanup-directions.unit.spec.ts`

**Behaviour (spec §"What it finds" 4–5, with rulings):**
- **Nearly horizontal / vertical** (4), ≤ 4° × strength: one candidate per in-scope, non-copy line piece at least 2 px long — `horizontal [a, b]` / `vertical [a, b]` (the pen's point-pair forms, which work for line entities and path segments alike). Labels "Horizontal" / "Vertical". Ids `horizontal:<pairKey>` / `vertical:<pairKey>`. (**Ruling 13**: per line.)
- **Nearly parallel** (5), ≤ 4° × strength: non-copy lines grouped by direction on the 180° circle with complete linkage (`clusterCircular`), groups that fail the ambiguity guard are dropped. One candidate per group of two or more with at least one in-scope line: every other member `parallel [ref.a, ref.b, m.a, m.b]` to the group's longest line. Label "Parallel" (×n above 2). Score starts with the group size, so the biggest group of similar directions goes first. Id `parallel:<sorted pairKeys joined by |>`.
- **Nearly perpendicular** (5): two groups (a group may be a single line) whose length-weighted mean directions are 90° ± 4° × strength apart, when a line of one meets a line of the other at a shared point (a corner) or both groups have two or more lines (**Ruling 13**). One rule: `perpendicular` on the corner's two lines (`[prev, corner, corner, next]` — the pen's Right-angle form) or on the two groups' longest lines. Label **"Square"**. Id `perpendicular:<the two group keys sorted, joined by #>`.

**Interfaces:**
- Consumes: Task 1 (`clusterCircular`, `unambiguous`, `TOL`, `countLabel`, `Candidate`); Task 2 (`linePieces`, `lineAngleDeg`, `pairKey`, `CleanupContext`, `Piece`); `RuleSpec` from `tangency.ts`.
- Produces: `detectHV(ctx)`, `detectParallelPerp(ctx)` — each `(ctx: CleanupContext) => Candidate[]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/cleanup-directions.unit.spec.ts`:

```ts
// tests/unit/cleanup-directions.unit.spec.ts
// Clean up, stage 2 (pen stage 5): nearly level / upright lines, groups of
// nearly parallel lines, and nearly square corners or groups.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { buildContext, type ContextEnv } from '~/lib/sketch/cleanup/context'
import { detectHV, detectParallelPerp } from '~/lib/sketch/cleanup/detect-directions'
import { STRENGTH_FACTOR } from '~/lib/sketch/cleanup/types'

const U = 1 / 34
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ held: new Set(), copies: new Set(), s: 1, unitsPerPx: U, ...o })
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}

describe('detectHV', () => {
  it('3° off level → Horizontal, 3° off upright → Vertical', () => {
    const d = blank()
    const h = lineAt(d, 0, 0, 3, 8), v = lineAt(d, 20, 0, 87, 8)
    const c = detectHV(buildContext(d, env()))
    expect(c.map(x => [x.kind, x.label])).toEqual([['horizontal', 'Horizontal'], ['vertical', 'Vertical']])
    expect(c[0]!.rules).toEqual([{ kind: 'horizontal', refs: [h.a, h.b] }])
    expect(c[1]!.rules).toEqual([{ kind: 'vertical', refs: [v.a, v.b] }])
    expect(c[0]!.id).toBe(`horizontal:${[h.a, h.b].sort().join('~')}`)
  })
  it('6° off level only at Strong', () => {
    const d = blank()
    lineAt(d, 0, 0, 6, 8)
    expect(detectHV(buildContext(d, env()))).toHaveLength(0)
    expect(detectHV(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(1)
  })
  it('copies and held lines take no part', () => {
    const d = blank()
    const h = lineAt(d, 0, 0, 3, 8)
    expect(detectHV(buildContext(d, env({ copies: new Set([h.a, h.b]) })))).toHaveLength(0)
    expect(detectHV(buildContext(d, env({ held: new Set([h.a, h.b]) })))).toHaveLength(0)
  })
})

describe('detectParallelPerp', () => {
  it('two lines at 30° and 32° → Parallel, tied to the longer one', () => {
    const d = blank()
    const L = lineAt(d, 0, 0, 30, 6), S = lineAt(d, 0, 5, 32, 3)
    const c = detectParallelPerp(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'parallel', label: 'Parallel' })
    expect(c[0]!.rules).toEqual([{ kind: 'parallel', refs: [L.a, L.b, S.a, S.b] }])
  })
  it('three → Parallel ×3', () => {
    const d = blank()
    lineAt(d, 0, 0, 30, 6); lineAt(d, 0, 4, 31, 5); lineAt(d, 0, 8, 33, 4)
    const c = detectParallelPerp(buildContext(d, env()))
    expect(c.map(x => x.label)).toEqual(['Parallel ×3'])
    expect(c[0]!.rules).toHaveLength(2)
  })
  it('an ambiguous group is skipped', () => {
    const d = blank()
    lineAt(d, 0, 0, 30, 5); lineAt(d, 0, 4, 33, 5); lineAt(d, 0, 8, 36.5, 5)
    expect(detectParallelPerp(buildContext(d, env()))).toHaveLength(0)
  })
  it('a nearly square corner → Square, written the pen’s Right-angle way', () => {
    const d = blank()
    const P0 = addPoint(d, 0, 0)
    const J = addPoint(d, 4 * Math.cos(rad(20)), 4 * Math.sin(rad(20)))
    const P2 = addPoint(d, 4 * Math.cos(rad(20)) + 3 * Math.cos(rad(108)), 4 * Math.sin(rad(20)) + 3 * Math.sin(rad(108)))
    addPath(d, [P0, J, P2], [{ kind: 'line' }, { kind: 'line' }])
    const c = detectParallelPerp(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'perpendicular', label: 'Square', anchor: [J] })
    expect(c[0]!.rules).toEqual([{ kind: 'perpendicular', refs: [P0, J, J, P2] }])
  })
  it('two unrelated single lines at 88° are not squared', () => {
    const d = blank()
    lineAt(d, 0, 0, 10, 4); lineAt(d, 10, 10, 98, 4)
    expect(detectParallelPerp(buildContext(d, env()))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-directions.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/cleanup/detect-directions"`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/cleanup/detect-directions.ts`**

```ts
// app/lib/sketch/cleanup/detect-directions.ts
// Clean up's second stage: lines that are nearly level or upright, groups of
// nearly parallel lines, and nearly square corners or groups ("Square").
import type { EntityId } from '../model'
import type { RuleSpec } from '../tangency'
import { clusterCircular, unambiguous } from './cluster'
import { linePieces, lineAngleDeg, pairKey, type CleanupContext, type Piece } from './context'
import { TOL, countLabel, type Candidate } from './types'

const longestFirst = (a: Piece, b: Piece) => b.len - a.len || (pairKey(a.a!, a.b!) < pairKey(b.a!, b.b!) ? -1 : 1)

export function detectHV(ctx: CleanupContext): Candidate[] {
  const tol = TOL.HV_DEG * ctx.s
  const out: Candidate[] = []
  for (const p of linePieces(ctx)) {
    if (!p.inScope || p.copy) continue
    const th = lineAngleDeg(p)
    const dH = Math.min(th, 180 - th), dV = Math.abs(th - 90)
    const key = pairKey(p.a!, p.b!)
    if (dH <= tol) {
      out.push({ id: `horizontal:${key}`, kind: 'horizontal', label: 'Horizontal', score: 1 - dH / tol, anchor: [p.a!, p.b!], rules: [{ kind: 'horizontal', refs: [p.a!, p.b!] }] })
    } else if (dV <= tol) {
      out.push({ id: `vertical:${key}`, kind: 'vertical', label: 'Vertical', score: 1 - dV / tol, anchor: [p.a!, p.b!], rules: [{ kind: 'vertical', refs: [p.a!, p.b!] }] })
    }
  }
  return out
}

interface Group { items: Piece[]; lo: number; hi: number; mean: number; ref: Piece; key: string; ok: boolean }

export function detectParallelPerp(ctx: CleanupContext): Candidate[] {
  const tol = TOL.PAR_DEG * ctx.s
  const ls = linePieces(ctx).filter(p => !p.copy)
  const groups: Group[] = clusterCircular(ls, lineAngleDeg, tol).map(({ items, values }) => {
    const lo = values[0]!, hi = values[values.length - 1]!
    const others = ls.filter(p => !items.includes(p)).map(lineAngleDeg)
    const w = items.reduce((s, p) => s + p.len, 0)
    const mean = values.reduce((s, v, i) => s + v * items[i]!.len, 0) / w
    return {
      items, lo, hi, mean, ref: [...items].sort(longestFirst)[0]!,
      key: items.map(p => pairKey(p.a!, p.b!)).sort().join('|'),
      ok: unambiguous(lo, hi, others, 180),
    }
  })
  const out: Candidate[] = []
  for (const g of groups) {
    if (g.items.length < 2 || !g.ok || !g.items.some(p => p.inScope)) continue
    const rules: RuleSpec[] = g.items.filter(p => p !== g.ref).map((p): RuleSpec => ({ kind: 'parallel', refs: [g.ref.a!, g.ref.b!, p.a!, p.b!] }))
    out.push({
      id: `parallel:${g.key}`, kind: 'parallel', label: countLabel('Parallel', g.items.length),
      score: g.items.length + 1 - (g.hi - g.lo) / tol, anchor: [g.ref.a!, g.ref.b!], rules,
    })
  }
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const A = groups[i]!, B = groups[j]!
      if (!A.ok || !B.ok) continue
      const dev = Math.abs((((A.mean - B.mean) % 180) + 180) % 180 - 90)
      if (dev > tol) continue
      let corner: { id: EntityId; la: Piece; lb: Piece } | null = null
      for (const la of A.items) {
        for (const lb of B.items) {
          const id = [la.a!, la.b!].find(x => x === lb.a || x === lb.b)
          if (id && !corner) corner = { id, la, lb }
        }
      }
      if (!corner && (A.items.length < 2 || B.items.length < 2)) continue
      if (![...A.items, ...B.items].some(p => p.inScope)) continue
      const la = corner?.la ?? A.ref, lb = corner?.lb ?? B.ref
      out.push({
        id: `perpendicular:${[A.key, B.key].sort().join('#')}`, kind: 'perpendicular', label: 'Square',
        score: A.items.length + B.items.length + 1 - dev / tol,
        anchor: corner ? [corner.id] : [A.ref.a!, A.ref.b!],
        rules: [{ kind: 'perpendicular', refs: [la.a!, la.b!, lb.a!, lb.b!] }],
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-directions.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/cleanup/'` → no lines.

- [ ] **Step 5: Commit** `frontend/app/lib/sketch/cleanup/detect-directions.ts frontend/tests/unit/cleanup-directions.unit.spec.ts` — message `feat(pen): Clean up finds nearly level, upright, parallel and square lines`.

---

### Task 4: Placement, sizes and nudges — Same centre, Mirror pair, Same length, Same radius, Evenly spaced, Rounded

**Files:**
- Create: `frontend/app/lib/sketch/cleanup/detect-shape.ts`
- Test: `frontend/tests/unit/cleanup-shape.unit.spec.ts`

**Behaviour (spec §"What it finds" 6–11, with rulings):**
- **Nearly concentric** (6): arc and circle centres (a shared centre counts once) clustered with complete linkage by distance ≤ max(6 px, 4 % of the smaller radius) × strength. One candidate per cluster of two or more: `merges` = the centres, at their mean weighted by the pieces' lengths (the spec's "a shared centre point"). Label "Same centre" (×n above 2). Id `concentric:<sorted centre ids>`.
- **Nearly equal lengths** (7): non-copy lines grouped with complete linkage on length where the group's spread ≤ 4 % × strength of its shortest AND ≤ 4 px × strength; ambiguity guard; at least one in-scope. Reference (**Ruling 9**): the member with a typed length (a `distance` rule on its two ends), else the longest; two different typed lengths → no candidate. Rules: `equalDist [ref.a, ref.b, m.a, m.b]` for every other member. Label "Same length ×n". Id `equalLength:<sorted pairKeys>`.
- **Nearly equal radii** (8): arcs and circles grouped the same way on radius (5 % and 3 px), then split (**Ruling 14**): the arcs of a group (two or more) → `equalDist [ref.c, ref.a, m.c, m.a]`; its circles (two or more) → `equalRadius [ref, m]`. Reference: typed radius (a `distance` pin on an arc's centre and an end, or a `radius` rule on a circle), else the longest. Label "Same radius ×n". Id `equalRadius:<sorted stable keys>`.
- **Nearly even spacing** (9) (**Ruling 15**): (a) lines whose directions agree within 0.05° (so already parallel), three or more, sorted by their offset across that direction; runs of two or more neighbouring gaps whose largest ÷ smallest ≤ 1 + 6 % × strength, each gap ≥ 2 px and each neighbouring pair overlapping along the direction. `prepare` adds, for every inner line, a guide point at the middle of its neighbours' first ends and returns `midpoint [M, prev.a, next.a]` + `collinear [line.a, line.b, M]`. (b) points pinned on a line (`pointOnLine` on a line entity, `collinear [A, B, p]` on a path line segment) plus the line's two ends, sorted along it, all gaps within the same ratio: `equalDist [p_i, p_i+1, p_i+1, p_i+2]`. Label "Evenly spaced". Ids `evenSpacing:<sorted keys>`.
- **Nearly mirror pairs** (10) (**Ruling 16**): candidate axes — the vertical and horizontal lines through the centre of the in-scope pieces' bounding box, plus every guide line. Two pieces of the same kind match when the reflection of each point lands within 6 px × strength of its partner (lines: ends either way round; arcs: ends either way round and centres; circles: centres, and radii within the same distance). Greedy by error, each piece in one pair per axis; for a new axis, the axis is then moved to the mean of the matched pairs' midpoints and the pairs are matched again. `prepare` makes the axis (a guide line through two guide points, 10 % past the box, with a `vertical` / `horizontal` rule — made once and shared through `guides['axis:v' | 'axis:h']`) and returns `mirroredFrom [copy, orig, axis]` per point pair (orig = the point on the negative side), `pointOnLine [p, axis]` for a point that pairs with itself, and `equalRadius` for a circle pair. Label "Mirror pair". Id `mirror:<axis key>:<the two stable keys sorted>`.
- **Round sizes** (11) (**Ruling 17**): only when one drawing unit is at least 4 screen px; in-scope, non-copy lines (length), arcs and circles (radius) with no typed size, within 2 % × strength of a whole number ≥ 1 (and not already on it) → `nudge` to it (`{ refs: [a, b] }` for a line, `{ refs: [c, a] }` for an arc, `{ circle }` for a circle). Label "Rounded to N". Id `round:<stable key>`.

**Interfaces:**
- Consumes: Task 1 (`clusterPairs`, `clusterSorted`, `clusterCircular`, `unambiguous`, `mean`, `TOL`, `GUARD`, `countLabel`, `Candidate`); Task 2 (`CleanupContext`, `Piece`, `pairKey`, `stableKey`, `typedSize`, `radiusOf`, `lineAngleDeg`, `linePieces`); `addPoint`, `addLine` from `edit.ts`; `RuleSpec` from `tangency.ts`.
- Produces: `detectConcentric`, `detectMirrorPairs`, `detectEqualLengths`, `detectEqualRadii`, `detectEvenSpacing`, `detectRound` — each `(ctx: CleanupContext) => Candidate[]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/cleanup-shape.unit.spec.ts`:

```ts
// tests/unit/cleanup-shape.unit.spec.ts
// Clean up, stages 3–5 (pen stage 5): nearly concentric centres, mirror
// pairs, nearly equal lengths and radii, nearly even spacing, and sizes a
// hair off a whole number.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { buildContext, type ContextEnv } from '~/lib/sketch/cleanup/context'
import { detectConcentric, detectMirrorPairs, detectEqualLengths, detectEqualRadii, detectEvenSpacing, detectRound } from '~/lib/sketch/cleanup/detect-shape'

const U = 1 / 34
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ held: new Set(), copies: new Set(), s: 1, unitsPerPx: U, ...o })
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}
function semicircle(d: SketchDoc, x0: number, x1: number) {   // from (x0, 0) to (x1, 0), bulging down
  const A = addPoint(d, x0, 0), B = addPoint(d, x1, 0), C = addPoint(d, (x0 + x1) / 2, 0)
  return { A, B, C, id: addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }]) }
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('detectConcentric', () => {
  it('two centres 3.4 px apart → one shared centre, weighted towards the bigger circle', () => {
    const d = blank()
    const c1 = addPoint(d, 5, 5), c2 = addPoint(d, 5.1, 5)
    addCircle(d, c1, 2); addCircle(d, c2, 3)
    const c = detectConcentric(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'concentric', label: 'Same centre', id: `concentric:${[c1, c2].sort().join(',')}` })
    expect(c[0]!.merges!.at.x).toBeCloseTo(5.06, 9)
  })
})

describe('detectEqualLengths', () => {
  it('5 and 5.1 → Same length ×2, tied to the longer', () => {
    const d = blank()
    const s = lineAt(d, 0, 0, 20, 5), l = lineAt(d, 10, 0, 70, 5.1)
    const c = detectEqualLengths(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'equalLength', label: 'Same length ×2' })
    expect(c[0]!.rules).toEqual([{ kind: 'equalDist', refs: [l.a, l.b, s.a, s.b] }])
  })
  it('a typed length is the one the others take', () => {
    const d = blank()
    const s = lineAt(d, 0, 0, 20, 5), l = lineAt(d, 10, 0, 70, 5.1)
    addConstraint(d, 'distance', [s.a, s.b], 5)
    expect(detectEqualLengths(buildContext(d, env()))[0]!.rules).toEqual([{ kind: 'equalDist', refs: [s.a, s.b, l.a, l.b] }])
  })
  it('two different typed lengths → nothing', () => {
    const d = blank()
    const s = lineAt(d, 0, 0, 20, 5), l = lineAt(d, 10, 0, 70, 5.1)
    addConstraint(d, 'distance', [s.a, s.b], 5); addConstraint(d, 'distance', [l.a, l.b], 5.1)
    expect(detectEqualLengths(buildContext(d, env()))).toHaveLength(0)
  })
})

describe('detectEqualRadii', () => {
  it('arcs go with arcs and circles with circles', () => {
    const d = blank()
    const a1 = semicircle(d, 0, 6), a2 = semicircle(d, 10, 16.1)
    const k1 = addCircle(d, addPoint(d, 30, 0), 3.02), k2 = addCircle(d, addPoint(d, 40, 0), 3.04)
    const c = detectEqualRadii(buildContext(d, env()))
    expect(c.map(x => x.label)).toEqual(['Same radius ×2', 'Same radius ×2'])
    expect(c[0]!.rules).toEqual([{ kind: 'equalDist', refs: [a2.C, a2.A, a1.C, a1.A] }])
    expect(c[1]!.rules).toEqual([{ kind: 'equalRadius', refs: [k2, k1] }])
  })
})

describe('detectEvenSpacing', () => {
  it('three stacked parallel lines with gaps 2 and 2.1 → a guide point at the middle and the middle line through it', () => {
    const d = blank()
    const l0 = addLine(d, addPoint(d, 0, 0), addPoint(d, 6, 0))
    const l1 = addLine(d, addPoint(d, 0, 2), addPoint(d, 6, 2))
    const l2 = addLine(d, addPoint(d, 0, 4.1), addPoint(d, 6, 4.1))
    const c = detectEvenSpacing(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'evenSpacing', label: 'Evenly spaced' })
    const w = cloneDoc(d)
    const rules = c[0]!.prepare!(w, new Map())
    const m = w.entities[w.entities.length - 1] as any
    expect(m).toMatchObject({ kind: 'point', construction: true, x: 0, y: 2.05 })
    const [L0, L1, L2] = [l0, l1, l2].map(id => P(d, id))
    expect(rules).toEqual([{ kind: 'midpoint', refs: [m.id, L0.p1, L2.p1] }, { kind: 'collinear', refs: [L1.p1, L1.p2, m.id] }])
  })
  it('points pinned on a line, with its ends → equal gaps', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 6, 0), line = addLine(d, a, b)
    const p1 = addPoint(d, 2.02, 0), p2 = addPoint(d, 4.05, 0)
    addConstraint(d, 'pointOnLine', [p1, line]); addConstraint(d, 'pointOnLine', [p2, line])
    const c = detectEvenSpacing(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]!.rules).toEqual([{ kind: 'equalDist', refs: [a, p1, p1, p2] }, { kind: 'equalDist', refs: [p1, p2, p2, b] }])
  })
  it('uneven gaps are left alone', () => {
    const d = blank()
    addLine(d, addPoint(d, 0, 0), addPoint(d, 6, 0)); addLine(d, addPoint(d, 0, 2), addPoint(d, 6, 2)); addLine(d, addPoint(d, 0, 4.4), addPoint(d, 6, 4.4))
    expect(detectEvenSpacing(buildContext(d, env()))).toHaveLength(0)
  })
})

describe('detectMirrorPairs', () => {
  it('two lines mirrored across an upright 3.4 px off → a new axis between them and mirror rules', () => {
    const d = blank()
    const L = { a: addPoint(d, 1, 1), b: addPoint(d, 3, 4) }; addLine(d, L.a, L.b)
    const R = { a: addPoint(d, 9.1, 1), b: addPoint(d, 7, 4) }; addLine(d, R.a, R.b)
    const c = detectMirrorPairs(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'mirror', label: 'Mirror pair' })
    expect(c[0]!.id.startsWith('mirror:v:')).toBe(true)
    const w = cloneDoc(d), guides = new Map<string, string>()
    const rules = c[0]!.prepare!(w, guides)
    const axis = w.entities.find(e => e.id === guides.get('axis:v')) as any
    expect(axis).toMatchObject({ kind: 'line', construction: true })
    expect(P(w, axis.p1).x).toBeCloseTo(5.025, 9)
    expect(P(w, axis.p2).x).toBeCloseTo(5.025, 9)
    expect(rules).toEqual([
      { kind: 'vertical', refs: [axis.p1, axis.p2] },
      { kind: 'mirroredFrom', refs: [R.a, L.a, axis.id] },
      { kind: 'mirroredFrom', refs: [R.b, L.b, axis.id] },
    ])
    // a second fix on the same axis reuses it
    expect(c[0]!.prepare!(w, guides)).toHaveLength(2)
  })
  it('pieces too far off mirroring are left alone', () => {
    const d = blank()
    addLine(d, addPoint(d, 1, 1), addPoint(d, 3, 4)); addLine(d, addPoint(d, 9.6, 1), addPoint(d, 7, 4))
    expect(detectMirrorPairs(buildContext(d, env()))).toHaveLength(0)
  })
})

describe('detectRound', () => {
  it('4.95 long → Rounded to 5; an arc of radius 3.04 → Rounded to 3', () => {
    const d = blank()
    const l = lineAt(d, 0, 0, 20, 4.95)
    const arc = semicircle(d, 10, 16.08)
    const c = detectRound(buildContext(d, env()))
    expect(c.map(x => x.label)).toEqual(['Rounded to 5', 'Rounded to 3'])
    expect(c[0]!.nudge).toEqual({ refs: [l.a, l.b], value: 5 })
    expect(c[1]!.nudge).toEqual({ refs: [arc.C, arc.A], value: 3 })
  })
  it('never a typed size, and not when a unit is under 4 px on screen', () => {
    const d = blank()
    const l = lineAt(d, 0, 0, 20, 4.95)
    expect(detectRound(buildContext(d, env({ unitsPerPx: 1 })))).toHaveLength(0)
    addConstraint(d, 'distance', [l.a, l.b], 4.95)
    expect(detectRound(buildContext(d, env()))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-shape.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/cleanup/detect-shape"`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/cleanup/detect-shape.ts`**

```ts
// app/lib/sketch/cleanup/detect-shape.ts
// Clean up's later stages: placement (centres that nearly coincide, pieces
// that nearly mirror each other), sizes (nearly equal lengths and radii,
// nearly even spacing) and nudges (sizes a hair off a whole number).
import type { SketchDoc, EntityId } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { addPoint, addLine } from '../edit'
import type { RuleSpec } from '../tangency'
import { clusterPairs, clusterSorted, clusterCircular, unambiguous, mean } from './cluster'
import { pairKey, stableKey, typedSize, radiusOf, lineAngleDeg, linePieces, type CleanupContext, type Piece } from './context'
import { TOL, GUARD, countLabel, type Candidate } from './types'

const isRound = (p: Piece) => p.kind === 'arc' || p.kind === 'circle'
const longestFirst = (a: Piece, b: Piece) => b.len - a.len || (stableKey(a) < stableKey(b) ? -1 : 1)

// ── placement: Same centre ──────────────────────────────────────────────────

export function detectConcentric(ctx: CleanupContext): Candidate[] {
  type Item = { c: EntityId; at: Vec2; r: number; pieces: Piece[] }
  const byCentre = new Map<EntityId, Item>()
  for (const p of ctx.pieces) {
    if (!isRound(p) || p.copy) continue
    const C = ctx.pts.get(p.c!)
    if (!C) continue
    const it = byCentre.get(p.c!) ?? { c: p.c!, at: { x: C.x, y: C.y }, r: Infinity, pieces: [] }
    it.r = Math.min(it.r, radiusOf(p))
    it.pieces.push(p)
    byCentre.set(p.c!, it)
  }
  const px = ctx.tol(TOL.CONC_PX)
  const tolOf = (u: Item, v: Item) => Math.max(px, TOL.CONC_FRAC * ctx.s * Math.min(u.r, v.r))
  const near = (u: Item, v: Item) => { const d = dist(u.at, v.at); return d <= tolOf(u, v) ? d : null }
  const out: Candidate[] = []
  for (const g of clusterPairs([...byCentre.values()], near)) {
    if (g.length < 2 || !g.some(x => x.pieces.some(p => p.inScope))) continue
    const ids = g.map(x => x.c).sort()
    let worst = 0
    for (const u of g) for (const v of g) if (u !== v) worst = Math.max(worst, dist(u.at, v.at) / tolOf(u, v))
    const w = g.map(x => x.pieces.reduce((s, p) => s + p.len, 0))
    const W = w.reduce((s, x) => s + x, 0)
    const at = { x: g.reduce((s, x, i) => s + x.at.x * w[i]!, 0) / W, y: g.reduce((s, x, i) => s + x.at.y * w[i]!, 0) / W }
    out.push({ id: `concentric:${ids.join(',')}`, kind: 'concentric', label: countLabel('Same centre', g.length), score: 2 - worst, anchor: ids, merges: { points: ids, at } })
  }
  return out
}

// ── placement: Mirror pair ──────────────────────────────────────────────────

type Axis = { key: string; kind: 'new'; dir: 'v' | 'h'; at: number } | { key: string; kind: 'line'; id: EntityId; a: Vec2; b: Vec2 }
interface Box { minX: number; minY: number; maxX: number; maxY: number; pad: number }
interface Match { p: Piece; q: Piece; pairs: [EntityId, EntityId][]; err: number }

function reflector(ax: Axis): (p: Vec2) => Vec2 {
  if (ax.kind === 'new') return ax.dir === 'v' ? p => ({ x: 2 * ax.at - p.x, y: p.y }) : p => ({ x: p.x, y: 2 * ax.at - p.y })
  const dx = ax.b.x - ax.a.x, dy = ax.b.y - ax.a.y, L = Math.hypot(dx, dy)
  const nx = -dy / L, ny = dx / L
  return p => { const s = (p.x - ax.a.x) * nx + (p.y - ax.a.y) * ny; return { x: p.x - 2 * s * nx, y: p.y - 2 * s * ny } }
}
function sideOf(ax: Axis, p: Vec2): number {
  if (ax.kind === 'new') return ax.dir === 'v' ? p.x - ax.at : p.y - ax.at
  const dx = ax.b.x - ax.a.x, dy = ax.b.y - ax.a.y
  return (dx * (p.y - ax.a.y) - dy * (p.x - ax.a.x)) / Math.hypot(dx, dy)
}

function matchPieces(ctx: CleanupContext, p: Piece, q: Piece, refl: (v: Vec2) => Vec2, tol: number): { pairs: [EntityId, EntityId][]; err: number } | null {
  if (p.kind !== q.kind || p === q) return null
  const at = (id: EntityId) => ctx.pts.get(id)!
  const tryPairs = (pp: [EntityId, EntityId][]) => {
    let err = 0
    for (const [x, y] of pp) {
      const d = dist(refl(at(x)), at(y))
      if (d > tol) return null
      err = Math.max(err, d)
    }
    return { pairs: pp, err }
  }
  let best: { pairs: [EntityId, EntityId][]; err: number } | null = null
  if (p.kind === 'circle') {
    const dr = Math.abs(radiusOf(p) - radiusOf(q))
    if (dr > tol) return null
    best = tryPairs([[p.c!, q.c!]])
    if (best) best.err = Math.max(best.err, dr)
  } else {
    const extra: [EntityId, EntityId][] = p.kind === 'arc' ? [[p.c!, q.c!]] : []
    const ways: [EntityId, EntityId][][] = [[[p.a!, q.a!], [p.b!, q.b!], ...extra], [[p.a!, q.b!], [p.b!, q.a!], ...extra]]
    for (const w of ways) {
      const m = tryPairs(w)
      if (m && (!best || m.err < best.err)) best = m
    }
  }
  if (!best || best.pairs.every(([x, y]) => x === y)) return null
  return best
}

// greedy by error: each piece in at most one pair; pairs oriented [orig, copy]
function pairUp(ctx: CleanupContext, ps: Piece[], ax: Axis, tol: number): Match[] {
  const refl = reflector(ax)
  const all: Match[] = []
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const p = ps[i]!, q = ps[j]!
      if (!p.inScope && !q.inScope) continue
      const m = matchPieces(ctx, p, q, refl, tol)
      if (!m) continue
      const pairs = m.pairs.map(([x, y]): [EntityId, EntityId] => (x === y || sideOf(ax, ctx.pts.get(x)!) < sideOf(ax, ctx.pts.get(y)!) ? [x, y] : [y, x]))
      all.push({ p, q, pairs, err: m.err })
    }
  }
  all.sort((a, b) => a.err - b.err || (stableKey(a.p) + stableKey(a.q) < stableKey(b.p) + stableKey(b.q) ? -1 : 1))
  const used = new Set<Piece>()
  const out: Match[] = []
  for (const m of all) {
    if (used.has(m.p) || used.has(m.q)) continue
    used.add(m.p); used.add(m.q)
    out.push(m)
  }
  return out
}

// the axis guide line: an existing guide, or a new one made once and shared through `guides`
function axisLine(doc: SketchDoc, guides: Map<string, EntityId>, ax: Axis, box: Box): { line: EntityId; rules: RuleSpec[] } {
  if (ax.kind === 'line') return { line: ax.id, rules: [] }
  const key = `axis:${ax.dir}`
  const had = guides.get(key)
  if (had && doc.entities.some(e => e.id === had)) return { line: had, rules: [] }
  const padX = Math.max(0.1 * (box.maxX - box.minX), box.pad), padY = Math.max(0.1 * (box.maxY - box.minY), box.pad)
  const [p, q] = ax.dir === 'v'
    ? [addPoint(doc, ax.at, box.minY - padY, { construction: true }), addPoint(doc, ax.at, box.maxY + padY, { construction: true })]
    : [addPoint(doc, box.minX - padX, ax.at, { construction: true }), addPoint(doc, box.maxX + padX, ax.at, { construction: true })]
  const line = addLine(doc, p, q, { construction: true })
  guides.set(key, line)
  return { line, rules: [{ kind: ax.dir === 'v' ? 'vertical' : 'horizontal', refs: [p, q] }] }
}

export function detectMirrorPairs(ctx: CleanupContext): Candidate[] {
  const tol = ctx.tol(TOL.MIRROR_PX)
  const ps = ctx.pieces.filter(p => !p.copy)
  const scoped = ps.filter(p => p.inScope)
  if (ps.length < 2 || !scoped.length) return []
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, pad: 20 * ctx.unitsPerPx }
  for (const p of scoped) {
    const r = p.kind === 'circle' ? radiusOf(p) : 0
    for (const id of p.points) {
      const P = ctx.pts.get(id)!
      box.minX = Math.min(box.minX, P.x - r); box.maxX = Math.max(box.maxX, P.x + r)
      box.minY = Math.min(box.minY, P.y - r); box.maxY = Math.max(box.maxY, P.y + r)
    }
  }
  const axes: Axis[] = [
    { key: 'v', kind: 'new', dir: 'v', at: (box.minX + box.maxX) / 2 },
    { key: 'h', kind: 'new', dir: 'h', at: (box.minY + box.maxY) / 2 },
  ]
  for (const e of ctx.doc.entities) {
    if (e.kind !== 'line' || !e.construction) continue
    const a = ctx.pts.get(e.p1), b = ctx.pts.get(e.p2)
    if (a && b && dist(a, b) > 1e-9) axes.push({ key: e.id, kind: 'line', id: e.id, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
  }
  const out: Candidate[] = []
  for (const start of axes) {
    let ax: Axis = start
    let matches = pairUp(ctx, ps, ax, tol)
    if (ax.kind === 'new' && matches.length) {
      // the new axis goes through the middle of the matched pairs: each side moves half the mismatch
      const dir = ax.dir
      const mids: number[] = []
      for (const m of matches) {
        for (const [x, y] of m.pairs) { const X = ctx.pts.get(x)!, Y = ctx.pts.get(y)!; mids.push(dir === 'v' ? (X.x + Y.x) / 2 : (X.y + Y.y) / 2) }
      }
      ax = { ...ax, at: mean(mids) }
      matches = pairUp(ctx, ps, ax, tol)
    }
    const axis = ax
    for (const m of matches) {
      out.push({
        id: `mirror:${axis.key}:${[stableKey(m.p), stableKey(m.q)].sort().join('|')}`, kind: 'mirror', label: 'Mirror pair',
        score: 1 - m.err / tol, anchor: [...new Set(m.pairs.flat())],
        prepare: (doc, guides) => {
          const { line, rules } = axisLine(doc, guides, axis, box)
          for (const [o, c] of m.pairs) rules.push(o === c ? { kind: 'pointOnLine', refs: [o, line] } : { kind: 'mirroredFrom', refs: [c, o, line] })
          if (m.p.kind === 'circle') rules.push({ kind: 'equalRadius', refs: [m.p.circle!, m.q.circle!] })
          return rules
        },
      })
    }
  }
  return out
}

// ── sizes: Same length, Same radius ─────────────────────────────────────────

function sizeGroups(ctx: CleanupContext, items: Piece[], size: (p: Piece) => number, frac: number, px: number) {
  const room = (lo: number) => Math.min(frac * ctx.s * lo, ctx.tol(px))
  const out: { g: Piece[]; lo: number; hi: number; room: number }[] = []
  for (const g of clusterSorted(items, size, (lo, hi) => hi - lo <= room(lo))) {
    if (g.length < 2) continue
    const vals = g.map(size), lo = Math.min(...vals), hi = Math.max(...vals)
    if (!unambiguous(lo, hi, items.filter(p => !g.includes(p)).map(size))) continue
    if (!g.some(p => p.inScope)) continue
    out.push({ g, lo, hi, room: room(lo) })
  }
  return out
}

/** The member the others are tied to: the one with a typed size, else the
 *  longest; null when two members carry different typed sizes. */
function referenceOf(doc: SketchDoc, g: Piece[]): Piece | null {
  const typed = g.filter(p => typedSize(doc, p) != null)
  const vals = typed.map(p => typedSize(doc, p)!)
  if (vals.length > 1 && Math.max(...vals) - Math.min(...vals) > 1e-9) return null
  return typed[0] ?? [...g].sort(longestFirst)[0]!
}
const closeness = (lo: number, hi: number, room: number) => (room > 0 ? 1 - (hi - lo) / room : 1)

export function detectEqualLengths(ctx: CleanupContext): Candidate[] {
  const out: Candidate[] = []
  for (const { g, lo, hi, room } of sizeGroups(ctx, linePieces(ctx).filter(p => !p.copy), p => p.len, TOL.LEN_FRAC, TOL.LEN_PX)) {
    const ref = referenceOf(ctx.doc, g)
    if (!ref) continue
    out.push({
      id: `equalLength:${g.map(p => pairKey(p.a!, p.b!)).sort().join('|')}`, kind: 'equalLength', label: `Same length ×${g.length}`,
      score: g.length + closeness(lo, hi, room), anchor: [ref.a!, ref.b!],
      rules: g.filter(p => p !== ref).map((p): RuleSpec => ({ kind: 'equalDist', refs: [ref.a!, ref.b!, p.a!, p.b!] })),
    })
  }
  return out
}

export function detectEqualRadii(ctx: CleanupContext): Candidate[] {
  const out: Candidate[] = []
  for (const { g, lo, hi, room } of sizeGroups(ctx, ctx.pieces.filter(p => isRound(p) && !p.copy), radiusOf, TOL.RAD_FRAC, TOL.RAD_PX)) {
    for (const part of [g.filter(p => p.kind === 'arc'), g.filter(p => p.kind === 'circle')]) {
      if (part.length < 2) continue
      const ref = referenceOf(ctx.doc, part)
      if (!ref) continue
      const rules: RuleSpec[] = part.filter(p => p !== ref).map((p): RuleSpec => (ref.kind === 'arc'
        ? { kind: 'equalDist', refs: [ref.c!, ref.a!, p.c!, p.a!] }
        : { kind: 'equalRadius', refs: [ref.circle!, p.circle!] }))
      out.push({
        id: `equalRadius:${part.map(stableKey).sort().join('|')}`, kind: 'equalRadius', label: `Same radius ×${part.length}`,
        score: part.length + closeness(lo, hi, room), anchor: ref.kind === 'arc' ? [ref.a!, ref.b!] : [ref.c!], rules,
      })
    }
  }
  return out
}

// ── sizes: Evenly spaced ────────────────────────────────────────────────────

export function detectEvenSpacing(ctx: CleanupContext): Candidate[] {
  const out: Candidate[] = []
  const maxRatio = 1 + TOL.GAP_FRAC * ctx.s
  const minGap = ctx.unitsPerPx * GUARD.ARC_MIN_PX
  const spreadScore = (n: number, ratio: number) => n + 1 - (ratio - 1) / (TOL.GAP_FRAC * ctx.s)
  // (a) a stack of parallel lines
  const ls = linePieces(ctx).filter(p => !p.copy)
  for (const { items } of clusterCircular(ls, lineAngleDeg, 0.05)) {
    if (items.length < 3) continue
    const ref = [...items].sort(longestFirst)[0]!
    const g = ref.geom
    const u = { x: (g.b!.x - g.a!.x) / ref.len, y: (g.b!.y - g.a!.y) / ref.len }, n = { x: -u.y, y: u.x }
    const rows = items.map(p => {
      const A = p.geom.a!, B = p.geom.b!
      const ta = A.x * u.x + A.y * u.y, tb = B.x * u.x + B.y * u.y
      return { p, o: ((A.x + B.x) / 2) * n.x + ((A.y + B.y) / 2) * n.y, lo: Math.min(ta, tb), hi: Math.max(ta, tb) }
    }).sort((x, y) => x.o - y.o)
    const gaps = rows.slice(1).map((r, k) => r.o - rows[k]!.o)
    const okGap = (k: number) => gaps[k]! >= minGap && Math.max(rows[k]!.lo, rows[k + 1]!.lo) < Math.min(rows[k]!.hi, rows[k + 1]!.hi)
    let i = 0
    while (i < gaps.length) {
      if (!okGap(i)) { i++; continue }
      let j = i
      while (j + 1 < gaps.length && okGap(j + 1)) {
        const run = gaps.slice(i, j + 2)
        if (Math.max(...run) / Math.min(...run) > maxRatio) break
        j++
      }
      if (j === i) { i++; continue }
      const run = rows.slice(i, j + 2).map(r => r.p)
      const runGaps = gaps.slice(i, j + 1)
      if (run.some(p => p.inScope)) {
        const inner = run.slice(1, -1).map((p, k) => ({ p, prev: run[k]!, next: run[k + 2]! }))
        out.push({
          id: `evenSpacing:${run.map(stableKey).sort().join('|')}`, kind: 'evenSpacing', label: 'Evenly spaced',
          score: spreadScore(run.length, Math.max(...runGaps) / Math.min(...runGaps)), anchor: [run[1]!.a!, run[1]!.b!],
          prepare: doc => inner.flatMap(({ p, prev, next }) => {
            const A = doc.entities.find(e => e.id === prev.a) as { x: number; y: number }
            const B = doc.entities.find(e => e.id === next.a) as { x: number; y: number }
            const m = addPoint(doc, (A.x + B.x) / 2, (A.y + B.y) / 2, { construction: true })
            return [{ kind: 'midpoint', refs: [m, prev.a!, next.a!] }, { kind: 'collinear', refs: [p.a!, p.b!, m] }] as RuleSpec[]
          }),
        })
      }
      i = j + 1
    }
  }
  // (b) points pinned on a line, with its ends
  for (const L of linePieces(ctx)) {
    if (L.copy) continue
    const pinned: EntityId[] = []
    for (const c of ctx.doc.constraints) {
      if (L.lineId && c.kind === 'pointOnLine' && c.refs[1] === L.lineId) pinned.push(c.refs[0]!)
      else if (!L.lineId && c.kind === 'collinear' && c.refs.length === 3 &&
        ((c.refs[0] === L.a && c.refs[1] === L.b) || (c.refs[0] === L.b && c.refs[1] === L.a))) pinned.push(c.refs[2]!)
    }
    const ids = [...new Set([L.a!, L.b!, ...pinned])].filter(id => ctx.pts.has(id))
    if (ids.length < 3) continue
    const A = L.geom.a!, u = { x: (L.geom.b!.x - A.x) / L.len, y: (L.geom.b!.y - A.y) / L.len }
    const along = ids.map(id => { const Q = ctx.pts.get(id)!; return { id, t: (Q.x - A.x) * u.x + (Q.y - A.y) * u.y } }).sort((x, y) => x.t - y.t)
    const gaps = along.slice(1).map((q, k) => q.t - along[k]!.t)
    const ratio = Math.max(...gaps) / Math.min(...gaps)
    if (Math.min(...gaps) < minGap || ratio > maxRatio) continue
    if (along.every(q => ctx.held.has(q.id))) continue
    out.push({
      id: `evenSpacing:${along.map(q => q.id).sort().join(',')}`, kind: 'evenSpacing', label: 'Evenly spaced',
      score: spreadScore(along.length, ratio), anchor: [L.a!, L.b!],
      rules: along.slice(0, -2).map((q, k): RuleSpec => ({ kind: 'equalDist', refs: [q.id, along[k + 1]!.id, along[k + 1]!.id, along[k + 2]!.id] })),
    })
  }
  return out
}

// ── nudges: Rounded ─────────────────────────────────────────────────────────

export function detectRound(ctx: CleanupContext): Candidate[] {
  if (1 / ctx.unitsPerPx < GUARD.ROUND_MIN_UNIT_PX) return []
  const frac = TOL.ROUND_FRAC * ctx.s
  const out: Candidate[] = []
  for (const p of ctx.pieces) {
    if (!p.inScope || p.copy || typedSize(ctx.doc, p) != null) continue
    const size = p.kind === 'line' ? p.len : radiusOf(p)
    const target = Math.round(size)
    const off = Math.abs(size - target)
    if (target < 1 || off < 1e-9 || off > frac * size) continue
    const nudge: Candidate['nudge'] = p.kind === 'line' ? { refs: [p.a!, p.b!], value: target }
      : p.kind === 'arc' ? { refs: [p.c!, p.a!], value: target }
      : { circle: p.circle!, value: target }
    out.push({
      id: `round:${stableKey(p)}`, kind: 'round', label: `Rounded to ${target}`, score: 1 - off / (frac * size),
      anchor: p.kind === 'circle' ? [p.c!] : [p.a!, p.b!], nudge,
    })
  }
  return out
}
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-shape.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/cleanup/'` → no lines.

- [ ] **Step 5: Commit** `frontend/app/lib/sketch/cleanup/detect-shape.ts frontend/tests/unit/cleanup-shape.unit.spec.ts` — message `feat(pen): Clean up finds shared centres, mirror pairs, equal lengths and radii, even spacing and round sizes`.

---

### Task 5: The staged greedy solve — guards and `runCleanup`

**Files:**
- Create: `frontend/app/lib/sketch/cleanup/guards.ts`
- Create: `frontend/app/lib/sketch/cleanup/run.ts`
- Create: `frontend/app/lib/sketch/cleanup/index.ts`
- Test: `frontend/tests/unit/cleanup-run.unit.spec.ts`

**Behaviour (spec §"How it decides", with rulings):**
- `runCleanup(doc, options)` never touches `doc`: it works on a clone and returns `{ doc: cleaned, fixes }`. It always starts from the drawing it is given, so the same options (strength, scope, switched-off ids) give the same answer, byte for byte (**Ruling 20**).
- **Refusals** (**Ruling 19**): more than `GUARD.MAX_PIECES` pieces → `refused: 'tooBig'`, no fixes; if the drawing's own rules don't hold (residual norm ≥ 1e-3 and a held solve fails) → `refused: 'conflict'`, no fixes. Both return a clone of the input as `doc`.
- **Passes** (**Ruling 7**), in order: `[detectJoins]`, `[detectOnCurve, detectTangents]`, `[detectHV]`, `[detectParallelPerp]`, `[detectConcentric]`, `[detectMirrorPairs]`, `[detectEqualLengths, detectEqualRadii, detectEvenSpacing]`, `[detectRound]`. Each pass rebuilds the context from the working drawing, sorts its candidates by score (then id), and tries them one by one. A candidate whose id is in `off` is listed as a fix with `on: false` and not applied.
- **Trying a candidate** (on the working drawing; on any refusal the drawing, the merge map and the guide map go back to how they were):
  1. `merges`: resolve ids through the merge map; the point that may not move (fixed or held) is kept (two such → refuse); otherwise the first id is kept and moved to `at`; the others `mergePoints` into it (a refused merge → refuse). In an open-only pen a merge that adds a closed path → refuse (**Ruling 10**).
  2. `rules` (+ whatever `prepare` returns): an exact repeat of a rule already there (`equivalentRuleKey`) is skipped; a rule whose Jacobian rows don't raise the rank of the rows already there (over the free scalars of the part of the drawing it touches) is skipped — unless it touches a guide point this candidate just made. The candidate adds something only when the rank gain exceeds what only places the new guide points (**Ruling 8**).
  3. `nudge`: a temporary `distance` (or `radius`) rule.
  4. Nothing added → refuse. Solve the connected part of the drawing the candidate touches with the held points (and held circles' radii) kept still (`solveHeld(componentOf(...))`); not converged → refuse. Remove the temporary rule.
  5. Guards against the ORIGINAL drawing: `movedTooFar` (**Ruling 8** cap) or `arcBroken` → refuse.
- **Fixes** come back in the order they were tried, each with its badge spot = the mean of its anchor points in the cleaned drawing (ids resolved through merges).

**Interfaces:**
- Consumes: Tasks 1–4; `cloneDoc` (`clone.ts`), `solve` (`solve.ts`), `constraintResiduals` (`residuals.ts`), `addConstraint`, `removeConstraint` (`edit.ts`), `mergePoints` (`trim.ts`), `equivalentRuleKey`, `RuleSpec` (`tangency.ts`), `curveGeom`, `pointAt`, `CurveRef` (`crossings.ts`), `getPoint` (`model.ts`).
- Produces:
  - `guards.ts`: `solveHeld(doc, held): boolean`, `componentOf(doc, seeds): SketchDoc` (entities and rules of the connected parts `seeds` touch — the entity objects are shared, not copied), `interface Baseline`, `baselineOf(doc, unitsPerPx): Baseline`, `movedTooFar(doc, base): boolean`, `arcBroken(doc, base, resolve): boolean`.
  - `run.ts`: `PASSES`, `runCleanup(doc: SketchDoc, o: CleanupOptions): CleanupResult`.
  - `index.ts`: re-exports `runCleanup` and everything in `types.ts` (Task 7 adds the badges export).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/cleanup-run.unit.spec.ts`:

```ts
// tests/unit/cleanup-run.unit.spec.ts
// Clean up's staged greedy solve (pen stage 5): the held solve, the guards
// (movement cap, broken arcs), and runCleanup end to end — the owner's
// trimmed flower joined into one loop, the same answer for the same switches,
// typed sizes that never move, fixes the other rules can't allow, rules the
// drawing already says, a Repeat's source only, a selection, an open-only
// pen, the size limit, and speed.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint, repeatEntities } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solveHeld, componentOf, baselineOf, movedTooFar, arcBroken } from '~/lib/sketch/cleanup/guards'
import { runCleanup } from '~/lib/sketch/cleanup/run'
import type { CleanupOptions } from '~/lib/sketch/cleanup/types'

const U = 1 / 34
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const opts = (o: Partial<CleanupOptions> = {}): CleanupOptions => ({ unitsPerPx: U, strength: 'normal', ...o })
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]
const maxRes = (d: SketchDoc) => Math.max(0, ...constraintResiduals(d).map(Math.abs))
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}
const len = (d: SketchDoc, l: { a: EntityId; b: EntityId }) => Math.hypot(P(d, l.b).x - P(d, l.a).x, P(d, l.b).y - P(d, l.a).y)
// the owner's trimmed flower: four petal arcs round a square, each ending 3.2 px short of the next one's start
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}

describe('solveHeld and componentOf', () => {
  it('keeps held points and held circle radii where they are', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 3, 1)
    addConstraint(d, 'horizontal', [a, b])
    const c = addCircle(d, addPoint(d, 10, 0), 2), c2 = addCircle(d, addPoint(d, 20, 0), 3)
    addConstraint(d, 'equalRadius', [c, c2])
    expect(solveHeld(d, new Set([b, c]))).toBe(true)
    expect(P(d, b)).toMatchObject({ x: 3, y: 1 })
    expect(P(d, b).fixed).toBeUndefined()
    expect(P(d, a).y).toBeCloseTo(1, 6)
    expect(P(d, c).r).toBeCloseTo(2, 5)
    expect(P(d, c2).r).toBeCloseTo(2, 5)
  })
  it('the connected part a point belongs to', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), l = addLine(d, a, b)
    const x = addPoint(d, 5, 5), y = addPoint(d, 6, 5), m = addLine(d, x, y)
    addConstraint(d, 'horizontal', [x, y])
    const part = componentOf(d, [a])
    expect(part.entities.map(e => e.id).sort()).toEqual([a, b, l].sort())
    expect(part.constraints).toEqual([])
    expect(componentOf(d, [y]).constraints).toHaveLength(1)
    expect(componentOf(d, [y]).entities.map(e => e.id).sort()).toEqual([x, y, m].sort())
  })
})

describe('guards', () => {
  it('a point may move 8 px, or a tenth of its smallest piece when that is more', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0)
    addLine(d, a, b)                                   // 34 px long: the 8 px floor wins
    const base = baselineOf(d, U)
    const w = cloneDoc(d)
    P(w, b).x += 7 * U
    expect(movedTooFar(w, base)).toBe(false)
    P(w, b).x += 2 * U
    expect(movedTooFar(w, base)).toBe(true)
    const long = blank()
    const p = addPoint(long, 0, 0), q = addPoint(long, 10, 0)
    addLine(long, p, q)                                // 340 px long: 34 px allowed
    const lb = baselineOf(long, U), lw = cloneDoc(long)
    P(lw, q).x += 30 * U
    expect(movedTooFar(lw, lb)).toBe(false)
  })
  const arcDoc = () => {
    const d = blank()
    const A = addPoint(d, 0, 0), B = addPoint(d, 4, 0), C = addPoint(d, 2, 3)
    addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])   // a shallow arc below its ends
    return { d, A, B, C }
  }
  it('an arc that jumps from small to large is broken', () => {
    const { d, C } = arcDoc()
    const base = baselineOf(d, U)
    expect(arcBroken(cloneDoc(d), base, id => id)).toBe(false)
    const w = cloneDoc(d)
    P(w, C).y = -3
    expect(arcBroken(w, base, id => id)).toBe(true)
  })
  it('an arc squeezed under 2 px is broken', () => {
    const { d, A, B, C } = arcDoc()
    const base = baselineOf(d, U)
    const w = cloneDoc(d)
    Object.assign(P(w, A), { x: 0, y: 0 }); Object.assign(P(w, B), { x: 0.04, y: 0 }); Object.assign(P(w, C), { x: 0.02, y: 0.01 })
    expect(arcBroken(w, base, id => id)).toBe(true)
  })
})

describe('runCleanup', () => {
  it('joins the trimmed flower into one closed loop and leaves the drawing it was given alone', () => {
    const d = blank(); flower(d)
    const before = JSON.stringify(d)
    const r = runCleanup(d, opts())
    expect(JSON.stringify(d)).toBe(before)
    expect(r.refused).toBeUndefined()
    expect(r.fixes.filter(f => f.kind === 'join' && f.on)).toHaveLength(4)
    const ps = paths(r.doc)
    expect(ps).toHaveLength(1)
    expect(ps[0].closed).toBe(true)
    expect(ps[0].segments.map((s: any) => s.kind)).toEqual(['arc', 'arc', 'arc', 'arc'])
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
  })
  it('gives the same answer for the same switches', () => {
    const d = blank(); flower(d)
    const a = runCleanup(d, opts()), b = runCleanup(d, opts())
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    const joinId = a.fixes.find(f => f.kind === 'join')!.id
    const off = runCleanup(d, opts({ off: new Set([joinId]) }))
    expect(off.fixes.find(f => f.id === joinId)!.on).toBe(false)
    expect(paths(off.doc)).toHaveLength(1)
    expect(paths(off.doc)[0].closed).toBe(false)
    expect(JSON.stringify(runCleanup(d, opts({ off: new Set() })))).toBe(JSON.stringify(a))
  })
  it('typed sizes never move: a nearly equal line takes the typed length', () => {
    const d = blank()
    const t = lineAt(d, 0, 0, 20, 5.1)
    addConstraint(d, 'distance', [t.a, t.b], 5.1)
    const u = lineAt(d, 10, 0, 70, 5)
    const r = runCleanup(d, opts())
    expect(r.fixes.find(f => f.kind === 'equalLength')?.on).toBe(true)
    expect(len(r.doc, t)).toBeCloseTo(5.1, 5)
    expect(len(r.doc, u)).toBeCloseTo(5.1, 5)
  })
  it('drops a fix the other rules can’t allow', () => {
    const d = blank()
    const k = Math.tan(rad(3))
    const A = addPoint(d, 0, 0, { fixed: true }), B = addPoint(d, 1, k), C = addPoint(d, 1, 1 + k, { fixed: true })
    addLine(d, A, B); addLine(d, B, C)
    addConstraint(d, 'vertical', [B, C]); addConstraint(d, 'distance', [B, C], 1)
    const r = runCleanup(d, opts())
    expect(r.fixes.some(f => f.kind === 'horizontal')).toBe(false)
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
  })
  it('adds nothing the drawing already says', () => {
    const d = blank()
    const p = ([[0, 0], [4, 0], [4, 4], [0, 4]] as const).map(([x, y]) => addPoint(d, x, y))
    addPath(d, p, [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    addConstraint(d, 'horizontal', [p[0]!, p[1]!]); addConstraint(d, 'vertical', [p[1]!, p[2]!])
    addConstraint(d, 'horizontal', [p[2]!, p[3]!]); addConstraint(d, 'vertical', [p[3]!, p[0]!])
    const r = runCleanup(d, opts())
    expect(r.fixes.filter(f => ['horizontal', 'vertical', 'parallel', 'perpendicular'].includes(f.kind))).toEqual([])
  })
  it('looks at a Repeat’s source only', () => {
    const d = blank()
    const centre = addPoint(d, 0, 0, { fixed: true })
    const a = addPoint(d, 3, 0), b = addPoint(d, 6, 3 * Math.tan(rad(3)))
    const l = addLine(d, a, b)
    repeatEntities(d, [l], centre, 4)
    const r = runCleanup(d, opts())
    const dirs = r.fixes.filter(f => f.kind === 'horizontal' || f.kind === 'vertical')
    expect(dirs).toHaveLength(1)
    expect(dirs[0]!.id).toBe(`horizontal:${[a, b].sort().join('~')}`)
    expect(dirs[0]!.on).toBe(true)
  })
  it('works on the selection, and leaves the rest exactly where it was', () => {
    const d = blank()
    const l1 = lineAt(d, 0, 0, 2, 8), l2 = lineAt(d, 0, 5, 2, 8)
    const r = runCleanup(d, opts({ scope: { entities: [l1.id], segments: [] } }))
    expect(r.fixes.filter(f => f.kind === 'horizontal' && f.on)).toHaveLength(1)
    for (const id of [l2.a, l2.b]) expect({ x: P(r.doc, id).x, y: P(r.doc, id).y }).toEqual({ x: P(d, id).x, y: P(d, id).y })
  })
  it('in an open-only pen a join never closes a path', () => {
    const d = blank()
    const A = addPoint(d, 0, 0), B = addPoint(d, 5, 0)
    addPath(d, [A, B], [{ kind: 'arc', center: addPoint(d, 2.5, 0), sweep: 1 }])
    const C = addPoint(d, 5.1, 0.05), D = addPoint(d, 0.08, 0.05)
    addPath(d, [C, D], [{ kind: 'arc', center: addPoint(d, 2.59, 0.05), sweep: 1 }])
    const open = runCleanup(d, opts({ openOnly: true }))
    expect(open.fixes.filter(f => f.kind === 'join' && f.on)).toHaveLength(1)
    expect(paths(open.doc).some(p => p.closed)).toBe(false)
    expect(paths(runCleanup(d, opts()).doc).some(p => p.closed)).toBe(true)
  })
  it('refuses a drawing of more than 150 pieces', () => {
    const d = blank()
    for (let i = 0; i < 151; i++) addLine(d, addPoint(d, i * 3, 0), addPoint(d, i * 3 + 1, 1))
    const r = runCleanup(d, opts())
    expect(r.refused).toBe('tooBig')
    expect(r.fixes).toEqual([])
  })
  it('cleans a 40-piece drawing in a few seconds', () => {
    const d = blank()
    for (let i = 0; i < 8; i++) {
      const x = (i % 4) * 8, y = Math.floor(i / 4) * 8
      const p = ([[0, 0], [4, 0.1], [4.05, 4], [0, 4.1]] as const).map(([dx, dy]) => addPoint(d, x + dx, y + dy))
      addPath(d, p, [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    }
    for (let i = 0; i < 8; i++) addLine(d, addPoint(d, i * 4, 20), addPoint(d, i * 4 + 3, 20.1))
    const t0 = performance.now()
    const r = runCleanup(d, opts())
    expect(performance.now() - t0).toBeLessThan(8000)
    expect(r.fixes.some(f => f.on)).toBe(true)
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-run.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/cleanup/guards"`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/cleanup/guards.ts`**

```ts
// app/lib/sketch/cleanup/guards.ts
// What keeps Clean up honest: a solve that holds what may not move (and only
// solves the part of the drawing a fix touches), and the checks every
// accepted fix must pass against the drawing as it was before Clean up — no
// point moved too far, no arc turned inside out or squeezed away.
import type { SketchDoc, EntityId } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { cloneDoc } from '../clone'
import { solve } from '../solve'
import { curveGeom, pointAt, type CurveGeom, type CurveRef } from '../crossings'
import { buildContext } from './context'
import { GUARD } from './types'

/** Solves `doc` in place with `held` points and circle radii kept where they
 *  are (the solver's own `fixed`, and a radius rule, on a private copy). False
 *  — and `doc` untouched — when it does not converge. */
export function solveHeld(doc: SketchDoc, held: ReadonlySet<EntityId>): boolean {
  const plain = cloneDoc(doc)
  for (const e of plain.entities) {
    if (e.kind === 'point' && held.has(e.id)) e.fixed = true
    else if (e.kind === 'circle' && held.has(e.id)) plain.constraints.push({ id: `__held_${e.id}`, kind: 'radius', refs: [e.id], value: e.r })
  }
  if (!solve(plain, { maxIter: 120 }).converged) return false
  const solved = new Map(plain.entities.map(e => [e.id, e]))
  for (const e of doc.entities) {
    const s = solved.get(e.id)
    if (e.kind === 'point' && s?.kind === 'point') { e.x = s.x; e.y = s.y }
    else if (e.kind === 'circle' && s?.kind === 'circle') e.r = s.r
  }
  return true
}

/** The entities and rules of the connected parts of the drawing that `seeds`
 *  (ids of points, pieces or circles) belong to — two things are connected
 *  when a piece or a rule ties their points. The entity objects are the
 *  drawing's own (not copies), so solving the part solves the drawing. */
export function componentOf(doc: SketchDoc, seeds: readonly EntityId[]): SketchDoc {
  const map = new Map(doc.entities.map(e => [e.id, e]))
  const parent = new Map<EntityId, EntityId>()
  const find = (x: EntityId): EntityId => {
    let r = x
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!
    let y = x
    while ((parent.get(y) ?? y) !== y) { const n = parent.get(y)!; parent.set(y, r); y = n }
    return r
  }
  const union = (ids: EntityId[]) => {
    const [first, ...rest] = ids
    if (!first) return
    const r = find(first)
    for (const x of rest) { const s = find(x); if (s !== r) parent.set(s, r) }
  }
  const pts = (id: EntityId): EntityId[] => {
    const e = map.get(id)
    if (!e) return []
    if (e.kind === 'point') return [e.id]
    if (e.kind === 'line') return [e.p1, e.p2]
    if (e.kind === 'circle') return [e.center, e.id]     // the radius travels with its centre
    const out = [...e.anchors]
    for (const s of e.segments) {
      if (s.kind === 'arc') out.push(s.center)
      else if (s.kind === 'cubic') { if (s.h1) out.push(s.h1); if (s.h2) out.push(s.h2) }
    }
    return out
  }
  for (const e of doc.entities) if (e.kind !== 'point') union(pts(e.id))
  for (const c of doc.constraints) union(c.refs.flatMap(pts))
  const roots = new Set(seeds.flatMap(pts).map(find))
  const keep = (id: EntityId) => pts(id).some(p => roots.has(find(p)))
  return { entities: doc.entities.filter(e => keep(e.id)), constraints: doc.constraints.filter(c => c.refs.some(keep)) }
}

interface ArcRecord { c: EntityId; a: EntityId; b: EntityId; side: number; span: number; len: number; r: number }
export interface Baseline {
  unitsPerPx: number
  pos: Map<EntityId, Vec2>
  cap: Map<EntityId, number>
  radius: Map<EntityId, { r: number; cap: number }>
  arcs: ArcRecord[]
}

// which side of its chord A→B the drawn arc's middle lies on (+1 / −1 / 0)
function arcSide(A: Vec2, B: Vec2, g: CurveGeom): number {
  const M = pointAt(g, 0.5)
  return Math.sign((B.x - A.x) * (M.y - A.y) - (B.y - A.y) * (M.x - A.x))
}

/** The original drawing, as the guards compare against it. */
export function baselineOf(doc: SketchDoc, unitsPerPx: number): Baseline {
  const ctx = buildContext(doc, { held: new Set(), copies: new Set(), s: 1, unitsPerPx })
  const floor = GUARD.MOVE_PX * unitsPerPx
  const smallest = new Map<EntityId, number>()
  for (const p of ctx.pieces) for (const id of p.points) smallest.set(id, Math.min(smallest.get(id) ?? Infinity, p.size))
  const pos = new Map<EntityId, Vec2>(), cap = new Map<EntityId, number>()
  for (const [id, Q] of ctx.pts) {
    pos.set(id, { x: Q.x, y: Q.y })
    const s = smallest.get(id)
    cap.set(id, Math.max(floor, s != null && Number.isFinite(s) ? GUARD.MOVE_FRAC * s : 0))
  }
  const radius = new Map<EntityId, { r: number; cap: number }>()
  const arcs: ArcRecord[] = []
  for (const p of ctx.pieces) {
    if (p.kind === 'circle') radius.set(p.circle!, { r: p.geom.r!, cap: Math.max(floor, GUARD.MOVE_FRAC * p.geom.r!) })
    else if (p.kind === 'arc') arcs.push({ c: p.c!, a: p.a!, b: p.b!, side: arcSide(p.geom.a!, p.geom.b!, p.geom), span: Math.abs(p.geom.sweepAngle!), len: p.len, r: p.geom.r! })
  }
  return { unitsPerPx, pos, cap, radius, arcs }
}

/** A point moved further from where it started than its cap, or a circle's
 *  radius changed by more than its cap. Points merged away, and guide points
 *  Clean up made, are not in the baseline and so are not held to it. */
export function movedTooFar(doc: SketchDoc, base: Baseline): boolean {
  for (const e of doc.entities) {
    if (e.kind === 'point') {
      const p0 = base.pos.get(e.id)
      if (p0 && dist(p0, e) > base.cap.get(e.id)! + 1e-9) return true
    } else if (e.kind === 'circle') {
      const r0 = base.radius.get(e.id)
      if (r0 && Math.abs(e.r - r0.r) > r0.cap + 1e-9) return true
    }
  }
  return false
}

function findArc(doc: SketchDoc, c: EntityId, a: EntityId, b: EntityId): CurveRef | null {
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    const n = e.closed ? e.anchors.length : e.anchors.length - 1
    for (let i = 0; i < n; i++) {
      const s = e.segments[i]
      if (s?.kind !== 'arc' || s.center !== c) continue
      const x = e.anchors[i], y = e.anchors[(i + 1) % e.anchors.length]
      if ((x === a && y === b) || (x === b && y === a)) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

/** An arc that turned inside out (its middle crossed to the other side of
 *  its ends, or it jumped between a small and a large arc) or ended shorter
 *  than 2 px (length or radius) when it wasn't. `resolve` maps an original
 *  point id to the id it became through merges. */
export function arcBroken(doc: SketchDoc, base: Baseline, resolve: (id: EntityId) => EntityId): boolean {
  const min = GUARD.ARC_MIN_PX * base.unitsPerPx
  const at = new Map<EntityId, Vec2>()
  for (const e of doc.entities) if (e.kind === 'point') at.set(e.id, e)
  for (const rec of base.arcs) {
    const c = resolve(rec.c), a = resolve(rec.a), b = resolve(rec.b)
    const ref = findArc(doc, c, a, b)
    if (!ref) continue
    const g = curveGeom(doc, ref)
    const A = at.get(a), B = at.get(b)
    if (!g || g.kind !== 'arc' || !A || !B) continue
    const side = arcSide(A, B, g)
    if (rec.side !== 0 && side !== 0 && side !== rec.side) return true
    if (Math.abs(Math.abs(g.sweepAngle!) - rec.span) > Math.PI / 2) return true
    const len = g.r! * Math.abs(g.sweepAngle!)
    if ((len < min && rec.len >= min) || (g.r! < min && rec.r >= min)) return true
  }
  return false
}
```

- [ ] **Step 4: Create `frontend/app/lib/sketch/cleanup/run.ts`**

```ts
// app/lib/sketch/cleanup/run.ts
// Clean up's staged greedy solve (spec "How it decides"): joins, then
// directions, then placement, then sizes, then nudges — each pass re-reads
// the drawing the passes before it left, tries its candidates best first,
// and keeps a candidate only when the held solve converges, it adds
// something, and the guards pass. Always from the drawing it is given, so
// the same switches give the same answer.
import type { SketchDoc, EntityId } from '../model'
import { getPoint } from '../model'
import { cloneDoc } from '../clone'
import { addConstraint, removeConstraint } from '../edit'
import { mergePoints } from '../trim'
import { constraintResiduals } from '../residuals'
import { equivalentRuleKey, type RuleSpec } from '../tangency'
import { meanPoint } from './cluster'
import { buildContext, heldForScope, copyPoints, type CleanupContext, type ContextEnv } from './context'
import { RowBasis, freeSlots, rowsFor } from './rank'
import { solveHeld, componentOf, baselineOf, movedTooFar, arcBroken, type Baseline } from './guards'
import { detectJoins, detectOnCurve, detectTangents } from './detect-topology'
import { detectHV, detectParallelPerp } from './detect-directions'
import { detectConcentric, detectMirrorPairs, detectEqualLengths, detectEqualRadii, detectEvenSpacing, detectRound } from './detect-shape'
import { STRENGTH_FACTOR, GUARD, type Candidate, type CleanupOptions, type CleanupResult, type CleanupFix } from './types'

type Pass = ((ctx: CleanupContext) => Candidate[])[]
/** The spec's stages in order — joins, directions, placement, sizes, nudges —
 *  split into passes. */
export const PASSES: Pass[] = [
  [detectJoins], [detectOnCurve, detectTangents],                   // joins
  [detectHV], [detectParallelPerp],                                 // directions
  [detectConcentric], [detectMirrorPairs],                          // placement
  [detectEqualLengths, detectEqualRadii, detectEvenSpacing],        // sizes
  [detectRound],                                                    // nudges
]

interface Env { held: ReadonlySet<EntityId>; base: Baseline; alias: Map<EntityId, EntityId>; guides: Map<string, EntityId>; openOnly: boolean }

const closedCount = (doc: SketchDoc) => doc.entities.filter(e => e.kind === 'path' && e.closed).length
function resolveIn(alias: ReadonlyMap<EntityId, EntityId>, id: EntityId): EntityId {
  let x = id
  for (let k = 0; alias.has(x) && k < 10000; k++) x = alias.get(x)!
  return x
}
const residualNorm = (doc: SketchDoc) => Math.sqrt(constraintResiduals(doc).reduce((s, r) => s + r * r, 0))

// Applies one candidate to `work` in place. False = refused (the caller puts
// `work`, the merge map and the guide map back).
function tryApply(work: SketchDoc, cand: Candidate, env: Env): boolean {
  const resolve = (id: EntityId) => resolveIn(env.alias, id)
  const seeds: EntityId[] = []
  let changed = false
  if (cand.merges) {
    const ids = [...new Set(cand.merges.points.map(resolve))]
    if (ids.length < 2) return false
    const pinned = ids.filter(id => { const p = getPoint(work, id); return !p || !!p.fixed || env.held.has(id) })
    if (pinned.length > 1) return false
    const into = pinned[0] ?? ids[0]!
    if (!pinned.length) { const p = getPoint(work, into)!; p.x = cand.merges.at.x; p.y = cand.merges.at.y }
    const closed = closedCount(work)
    for (const from of ids) {
      if (from === into) continue
      if (!mergePoints(work, from, into)) return false
      env.alias.set(from, into)
    }
    if (env.openOnly && closedCount(work) > closed) return false
    seeds.push(into)
    changed = true
  }
  const before = new Set(work.entities.map(e => e.id))
  const rules: RuleSpec[] = (cand.rules ?? []).map(r => ({ ...r, refs: r.refs.map(resolve) }))
  if (cand.prepare) rules.push(...cand.prepare(work, env.guides))
  const created = new Set(work.entities.filter(e => !before.has(e.id)).map(e => e.id))
  if (rules.length) {
    const part = componentOf(work, [...rules.flatMap(r => r.refs), ...created])
    const slots = freeSlots(part, env.held)
    const basis = new RowBasis(slots.length)
    for (const row of rowsFor(work, slots, part.constraints)) basis.add(row)
    const rank0 = basis.rank
    const keys = new Set(work.constraints.map(c => equivalentRuleKey(work, c)))
    const added: EntityId[] = []
    for (const r of rules) {
      const key = equivalentRuleKey(work, r)
      if (keys.has(key)) continue
      let independent = false
      for (const row of rowsFor(work, slots, [{ id: '__cleanup', ...r }])) if (basis.add(row)) independent = true
      if (!independent && !r.refs.some(id => created.has(id))) continue
      added.push(addConstraint(work, r.kind, r.refs, r.value))
      keys.add(key)
      seeds.push(...r.refs)
    }
    let gain = basis.rank - rank0
    if (created.size) {
      // freedom that only places the new guide points is not a change to the drawing
      const cols = slots.map((s, i) => (created.has(s.id) ? i : -1)).filter(i => i >= 0)
      const guide = new RowBasis(cols.length)
      for (const row of rowsFor(work, slots, work.constraints.filter(c => added.includes(c.id)))) guide.add(cols.map(i => row[i]!))
      gain -= guide.rank
    }
    if (gain > 0) changed = true
  }
  let temp: EntityId | null = null
  if (cand.nudge) {
    const n = cand.nudge
    temp = 'circle' in n
      ? addConstraint(work, 'radius', [resolve(n.circle)], n.value)
      : addConstraint(work, 'distance', n.refs.map(resolve), n.value)
    seeds.push(...('circle' in n ? [resolve(n.circle)] : n.refs.map(resolve)))
    changed = true
  }
  if (!changed) return false
  if (!solveHeld(componentOf(work, seeds), env.held)) return false
  if (temp) removeConstraint(work, temp)
  return !movedTooFar(work, env.base) && !arcBroken(work, env.base, resolve)
}

export function runCleanup(input: SketchDoc, o: CleanupOptions): CleanupResult {
  const off = o.off ?? new Set<string>()
  let work = cloneDoc(input)
  const held = heldForScope(work, o.scope)
  const env0: ContextEnv = { held, copies: copyPoints(work), s: STRENGTH_FACTOR[o.strength], unitsPerPx: o.unitsPerPx, openOnly: !!o.openOnly }
  if (buildContext(work, env0).pieces.length > GUARD.MAX_PIECES) return { doc: cloneDoc(input), fixes: [], refused: 'tooBig' }
  const base = baselineOf(work, o.unitsPerPx)
  if (residualNorm(work) >= 1e-3 && !solveHeld(work, held)) return { doc: cloneDoc(input), fixes: [], refused: 'conflict' }
  const alias = new Map<EntityId, EntityId>()
  let guides = new Map<string, EntityId>()
  const tried: { cand: Candidate; on: boolean }[] = []
  for (const pass of PASSES) {
    const ctx = buildContext(work, env0)
    const cands = pass.flatMap(detect => detect(ctx)).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const seen = new Set<string>()
    for (const cand of cands) {
      if (seen.has(cand.id)) continue
      seen.add(cand.id)
      if (off.has(cand.id)) { tried.push({ cand, on: false }); continue }
      const snap = cloneDoc(work), snapAlias = new Map(alias), snapGuides = new Map(guides)
      if (tryApply(work, cand, { held, base, alias, guides, openOnly: !!o.openOnly })) { tried.push({ cand, on: true }); continue }
      work = snap
      alias.clear()
      for (const [k, v] of snapAlias) alias.set(k, v)
      guides = snapGuides
    }
  }
  const fixes: CleanupFix[] = []
  for (const { cand, on } of tried) {
    const at = cand.anchor.map(id => getPoint(work, resolveIn(alias, id))).filter((p): p is NonNullable<typeof p> => !!p)
    if (at.length) fixes.push({ id: cand.id, kind: cand.kind, label: cand.label, on, at: meanPoint(at) })
  }
  return { doc: work, fixes }
}
```

- [ ] **Step 5: Create `frontend/app/lib/sketch/cleanup/index.ts`**

```ts
// app/lib/sketch/cleanup/index.ts
// Clean up (pen stage 5): the pen's entry points.
export { runCleanup } from './run'
export * from './types'
```

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-run.unit.spec.ts tests/unit/cleanup-shape.unit.spec.ts tests/unit/cleanup-directions.unit.spec.ts tests/unit/cleanup-topology.unit.spec.ts tests/unit/cleanup-cluster.unit.spec.ts`
Expected: all pass. If a runner case fails, find which candidate did it (log `tried` in a scratch run) and fix the detector or guard that owns it — never loosen the test's numbers. The speed case can wobble under load: re-run the file alone before calling it a failure. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/cleanup/'` → no lines.

- [ ] **Step 7: Commit** `frontend/app/lib/sketch/cleanup/guards.ts frontend/app/lib/sketch/cleanup/run.ts frontend/app/lib/sketch/cleanup/index.ts frontend/tests/unit/cleanup-run.unit.spec.ts` — message `feat(pen): Clean up's staged solve — joins, directions, placement, sizes, nudges; every fix re-solved and guarded`.

---

### Task 6: The Clean up session in the pen — start, switches, strength, Apply, Cancel, keys

**Files:**
- Modify: `frontend/app/composables/pen/usePen.ts` (imports, `PenOptions`, resolved options, a new Clean up section, `onKeydown`, the session-end functions, the return object)
- Modify: `frontend/app/composables/pen/penKeys.ts` (`isCleanupKey`, `PenKeyContext`, `handlePenKey`)
- Test: `frontend/tests/unit/pen-cleanup.unit.spec.ts`

**Behaviour (spec §"The command", with rulings):**
- `startCleanup()` (the toolbar button and ⌥⇧C, through `toggleCleanup()`): does nothing if the host turned Clean up off (`PenOptions.cleanup === false`, **Ruling 1**) or a preview is already open. It first settles every live gesture with `finishSession()` (a half-drawn path is finished, a live arc drag or Trim press settles, a half-armed Repeat / Mirror is dropped; the selection is kept; a step only if that changed anything), then takes the scope from the selection (**Ruling 6**: selected entities and Option-picked segments; none → `null`), freezes `unitsPerPx = pxToUnits(1, view)` (**Ruling 5**), clones the drawing as `original`, and opens the preview at strength Normal with every fix on (**Ruling 20**).
- The preview is `cleanup: ShallowRef<CleanupSession | null>` with `{ strength, off, scope, unitsPerPx, original, result }`; every change replaces the object (re-running `runCleanup` on `original`). `toggleCleanupFix(id)`, `toggleCleanupKind(kind)` (all of a kind off when all are on, else all on — **Ruling 18**), `setCleanupStrength(s)`.
- `applyCleanup()`: closes the preview; if at least one fix is on, `doc.value = cloneDoc(result.doc)`, clears both selections, `commitHistory()` once, sparkles at up to 12 accepted fixes, status `Cleaned up · N changes` (**Ruling 21**). `cancelCleanup()`: closes it, status `Clean up cancelled`, no step. `toggleCleanup()`: cancel if open, else start.
- **Keys** (**Rulings 2, 4**): with no preview, ⌥⇧C (`isCleanupKey`: Alt + Shift + `ev.code === 'KeyC'`, no ⌘/Ctrl) toggles Clean up when the host allows it (and is not the pen's key otherwise). While a preview is open, `onKeydown` routes everything to `cleanupKey`: Enter applies, Escape and ⌥⇧C cancel, ⌘Z / ⌘Y / ⇧⌘Z only close the preview, other ⌘ combos are not the pen's, bare modifiers are not the pen's, every other key is swallowed (returns true, does nothing).
- **Session ends drop the preview** (**Ruling 3**): `undo`, `redo`, `selectTool`, `reset`, `revert`, `finishSession`, `endGesture` and `dispose` call `closeCleanup()` first.

**Interfaces:**
- Consumes: Task 5 `runCleanup`, and from `~/lib/sketch/cleanup`: `CleanupResult`, `CleanupScope`, `CleanupStrength`, `FixKind`; `cloneDoc` from `~/lib/sketch/clone`.
- Produces:
  - `PenOptions` gains `cleanup?: boolean`; `pen.options.cleanup: boolean` (default `true`).
  - `usePen` returns `cleanup`, `toggleCleanup()`, `startCleanup()`, `applyCleanup()`, `cancelCleanup()`, `toggleCleanupFix(id: string)`, `toggleCleanupKind(kind: FixKind)`, `setCleanupStrength(s: CleanupStrength)`.
  - `penKeys.ts` exports `isCleanupKey(ev: KeyboardEvent): boolean`; `PenKeyContext` gains `cleanupAllowed: boolean` and `toggleCleanup: () => void`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-cleanup.unit.spec.ts`:

```ts
// tests/unit/pen-cleanup.unit.spec.ts
// Pen stage 5, Clean up in the shared pen: the preview never touches the
// drawing, Apply is one undo step, switches and strength re-solve from the
// drawing as it was, the pen owns the keys while previewing, a selection
// scopes it, live gestures settle first, anything that ends the session drops
// the preview, and a host can turn it off.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void = () => {}, options?: any) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV), options })
  return { doc, pen }
}
const key = (k: string, o: Record<string, unknown> = {}) =>
  ({ key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...o }) as unknown as KeyboardEvent
const CLEAN_UP = { code: 'KeyC', altKey: true, shiftKey: true }   // ⌥⇧C types "Ç" on a Mac
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}

describe('Clean up in the pen', () => {
  it('previews without touching the drawing; Apply is one undo step', () => {
    const { doc, pen } = mk(flower)
    expect(pen.options.cleanup).toBe(true)
    const before = JSON.stringify(doc.value)
    pen.startCleanup()
    expect(pen.cleanup.value!.strength).toBe('normal')
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'join')).toHaveLength(4)
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
    pen.applyCleanup()
    expect(pen.cleanup.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(1)
    expect(paths(doc.value)[0].closed).toBe(true)
    expect(pen.sparkleCount()).toBeGreaterThan(0)
    expect(pen.status.value).toMatch(/^Cleaned up · \d+ changes?$/)
    pen.undo()
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
  it('a switched-off fix is left out; switching it back gives the first answer again', () => {
    const { pen } = mk(flower)
    pen.startCleanup()
    const first = JSON.stringify(pen.cleanup.value!.result)
    const id = pen.cleanup.value!.result.fixes.find(f => f.kind === 'join')!.id
    pen.toggleCleanupFix(id)
    const r = pen.cleanup.value!.result
    expect(r.fixes.find(f => f.id === id)!.on).toBe(false)
    expect(paths(r.doc)[0].closed).toBe(false)
    pen.toggleCleanupFix(id)
    expect(JSON.stringify(pen.cleanup.value!.result)).toBe(first)
  })
  it('a collapsed kind switches all its fixes together', () => {
    const { pen } = mk(flower)
    pen.startCleanup()
    pen.toggleCleanupKind('join')
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'join').every(f => !f.on)).toBe(true)
    expect(paths(pen.cleanup.value!.result.doc)).toHaveLength(4)
    pen.toggleCleanupKind('join')
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'join').every(f => f.on)).toBe(true)
  })
  it('⌥⇧C opens it and Escape closes it with no step; the pen owns the keys meanwhile', () => {
    const { doc, pen } = mk(flower)
    const before = JSON.stringify(doc.value)
    expect(pen.onKeydown(key('Ç', CLEAN_UP))).toBe(true)
    expect(pen.cleanup.value).not.toBeNull()
    expect(pen.onKeydown(key('p'))).toBe(true)                      // swallowed: no tool change
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('Shift'))).toBe(false)
    expect(pen.onKeydown(key('s', { metaKey: true }))).toBe(false)  // other ⌘ keys stay the host's
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    expect(pen.status.value).toBe('Clean up cancelled')
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
  it('⌥⇧C again cancels; Enter applies; ⌘Z while previewing only closes the preview', () => {
    const { doc, pen } = mk(flower)
    pen.onKeydown(key('Ç', CLEAN_UP))
    expect(pen.onKeydown(key('Ç', CLEAN_UP))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    pen.onKeydown(key('Ç', CLEAN_UP))
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(4)
    pen.onKeydown(key('Ç', CLEAN_UP))
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    expect(paths(doc.value)).toHaveLength(1)
  })
  it('strength re-solves: a 6° line is levelled only at Strong', () => {
    const { pen } = mk(d => { lineAt(d, 2, 2, 6, 8) })
    pen.startCleanup()
    const hv = () => pen.cleanup.value!.result.fixes.filter(f => f.kind === 'horizontal')
    expect(hv()).toHaveLength(0)
    pen.setCleanupStrength('strong')
    expect(pen.cleanup.value!.strength).toBe('strong')
    expect(hv()).toHaveLength(1)
    pen.setCleanupStrength('gentle')
    expect(hv()).toHaveLength(0)
  })
  it('works on the selection only, and leaves the rest where it was', () => {
    let l1 = { a: '', b: '', id: '' }, l2 = { a: '', b: '', id: '' }
    const { doc, pen } = mk(d => { l1 = lineAt(d, 0, 0, 2, 8); l2 = lineAt(d, 0, 5, 2, 8) })
    const at = (id: EntityId) => { const p = doc.value.entities.find(e => e.id === id) as any; return { x: p.x, y: p.y } }
    const keep = [at(l2.a), at(l2.b)]
    pen.pick(l1.id)
    pen.startCleanup()
    expect(pen.cleanup.value!.scope).toEqual({ entities: [l1.id], segments: [] })
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'horizontal')).toHaveLength(1)
    pen.applyCleanup()
    expect([at(l2.a), at(l2.b)]).toEqual(keep)
    expect(pen.selection.value).toEqual([])
  })
  it('a half-drawn path is finished before Clean up looks', () => {
    const { doc, pen } = mk()
    pen.selectTool('path')
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0.1); pen.pathUp(4, 0.1)
    pen.startCleanup()
    expect(pen.pendingPath.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(1)
    expect(pen.cleanup.value).not.toBeNull()
  })
  it('a tool change, undo and finishSession drop the preview', () => {
    const { pen } = mk(flower)
    pen.startCleanup(); pen.selectTool('line')
    expect(pen.cleanup.value).toBeNull()
    pen.startCleanup(); pen.undo()
    expect(pen.cleanup.value).toBeNull()
    pen.startCleanup(); pen.finishSession()
    expect(pen.cleanup.value).toBeNull()
  })
  it('PenOptions.cleanup false: no Clean up, and ⌥⇧C is not the pen’s', () => {
    const { pen } = mk(flower, { cleanup: false })
    expect(pen.options.cleanup).toBe(false)
    pen.toggleCleanup()
    expect(pen.cleanup.value).toBeNull()
    expect(pen.onKeydown(key('Ç', CLEAN_UP))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-cleanup.unit.spec.ts`
Expected: FAIL — `pen.startCleanup is not a function` (and `pen.options.cleanup` undefined).

- [ ] **Step 3: `penKeys.ts`** — add, below `screenDeltaToDrawing`:

```ts
/** ⌥⇧C, Clean up. Matched by the key's position: on a Mac ⌥⇧C types "Ç". */
export function isCleanupKey(ev: KeyboardEvent): boolean {
  return ev.altKey && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && ev.code === 'KeyC'
}
```

In `PenKeyContext`, after `clearTrimGhosts: () => boolean`, add:

```ts
  // Clean up (pen stage 5): whether the host offers it, and the toggle
  cleanupAllowed: boolean
  toggleCleanup: () => void
```

In `handlePenKey`, right after the `if (meta) { … }` block, add:

```ts
  // ⌥⇧C: Clean up — only in a host that offers it
  if (isCleanupKey(ev)) {
    if (!ctx.cleanupAllowed) return false
    ctx.toggleCleanup()
    return true
  }
```

- [ ] **Step 4: `usePen.ts` — imports and options**

Change the penKeys import to
```ts
import { handlePenKey, isCleanupKey, type PenKeyContext, NUDGE_PX, NUDGE_PX_SHIFT, screenDeltaToDrawing } from './penKeys'
```
and add below the `~/lib/sketch/trim` import:
```ts
import { cloneDoc } from '~/lib/sketch/clone'
import { runCleanup, type CleanupResult, type CleanupScope, type CleanupStrength, type FixKind } from '~/lib/sketch/cleanup'
```
Change
```ts
export interface PenOptions { openOnly?: boolean; tools?: PenTool[] }
```
to
```ts
// cleanup: Clean up (pen stage 5) is offered unless a host sets it false
export interface PenOptions { openOnly?: boolean; tools?: PenTool[]; cleanup?: boolean }
```
Below `const openOnly = !!opts.options?.openOnly` add `const cleanupAllowed = opts.options?.cleanup !== false`, and change
```ts
  const options = Object.freeze({ openOnly, tools: Object.freeze(resolvedTools) })
```
to
```ts
  const options = Object.freeze({ openOnly, tools: Object.freeze(resolvedTools), cleanup: cleanupAllowed })
```

- [ ] **Step 5: `usePen.ts` — the Clean up section.** Insert right after the closing brace of `function fixSelected() { … }`:

```ts
  // --- Clean up (pen stage 5, lib/sketch/cleanup) ---
  // A preview: the drawing stays exactly as it is while `cleanup` holds the
  // cleaned copy, re-solved from the drawing as it was when Clean up opened
  // on every switch or strength change (so the same switches always give the
  // same answer). Apply writes it as ONE history step; Cancel, Escape, ⌥⇧C
  // again, or anything that ends the session (a tool change, undo / redo,
  // reset, revert, finishSession, parking, dispose) drops it untouched.
  // Tolerances use the zoom Clean up opened at, so zooming mid-preview does
  // not reshuffle the fixes. The object is replaced on every change, never
  // mutated, so the overlay's and toolbar's computeds follow it.
  interface CleanupSession {
    strength: CleanupStrength
    off: ReadonlySet<string>
    scope: CleanupScope | null
    unitsPerPx: number
    original: SketchDoc
    result: CleanupResult
  }
  const cleanup = shallowRef<CleanupSession | null>(null)
  function solveCleanup(s: Omit<CleanupSession, 'result'>): CleanupSession {
    return { ...s, result: runCleanup(s.original, { unitsPerPx: s.unitsPerPx, strength: s.strength, scope: s.scope, off: s.off, openOnly }) }
  }
  function startCleanup(): void {
    if (!cleanupAllowed || cleanup.value) return
    finishSession()   // every live gesture settles first (its own step, if it changed anything); the selection is kept
    const picked = selection.value.length > 0 || selectedSegments.value.length > 0
    const scope: CleanupScope | null = picked
      ? { entities: [...selection.value], segments: selectedSegments.value.map(s => ({ ...s })) }
      : null
    cleanup.value = solveCleanup({ strength: 'normal', off: new Set(), scope, unitsPerPx: pxToUnits(1, opts.view.value), original: cloneDoc(doc.value) })
  }
  function closeCleanup(): void { cleanup.value = null }
  function cancelCleanup(): void {
    if (!cleanup.value) return
    cleanup.value = null
    status.value = 'Clean up cancelled'
  }
  function toggleCleanup(): void {
    if (cleanup.value) cancelCleanup()
    else startCleanup()
  }
  function setCleanupStrength(strength: CleanupStrength): void {
    const s = cleanup.value
    if (!s || s.strength === strength) return
    cleanup.value = solveCleanup({ ...s, strength })
  }
  function toggleCleanupFix(id: string): void {
    const s = cleanup.value
    if (!s) return
    const off = new Set(s.off)
    if (off.has(id)) off.delete(id)
    else off.add(id)
    cleanup.value = solveCleanup({ ...s, off })
  }
  // a collapsed badge: every fix of that kind off when all are on, else all on
  function toggleCleanupKind(kind: FixKind): void {
    const s = cleanup.value
    if (!s) return
    const mine = s.result.fixes.filter(f => f.kind === kind)
    if (!mine.length) return
    const allOn = mine.every(f => f.on)
    const off = new Set(s.off)
    for (const f of mine) { if (allOn) off.add(f.id); else off.delete(f.id) }
    cleanup.value = solveCleanup({ ...s, off })
  }
  function applyCleanup(): void {
    const s = cleanup.value
    if (!s) return
    cleanup.value = null
    const on = s.result.fixes.filter(f => f.on)
    if (!on.length) return
    doc.value = cloneDoc(s.result.doc)
    clearSel()
    clearSegSel()
    commitHistory()
    for (const f of on.slice(0, 12)) sparkle(f.at.x, f.at.y)
    status.value = `Cleaned up · ${on.length} ${on.length === 1 ? 'change' : 'changes'}`
  }
  // keys while a preview is open: Enter applies, Escape / ⌥⇧C cancel, ⌘Z / ⌘Y
  // only close it; every other plain key is swallowed so nothing edits the
  // drawing under the preview; other ⌘ combos and bare modifiers are not the pen's
  function cleanupKey(ev: KeyboardEvent): boolean {
    if (ev.metaKey || ev.ctrlKey) {
      const k = ev.key.toLowerCase()
      if (k === 'z' || k === 'y') { cancelCleanup(); return true }
      return false
    }
    if (ev.key === 'Enter') { applyCleanup(); return true }
    if (ev.key === 'Escape' || isCleanupKey(ev)) { cancelCleanup(); return true }
    return !MODIFIER_KEYS.has(ev.key)
  }
```

- [ ] **Step 6: `usePen.ts` — key routing.** In `onKeydown`, before the `if (arcDrag && !MODIFIER_KEYS.has(ev.key)) arcDragEnd()` line, insert:

```ts
    // a Clean up preview owns the keys (cleanupKey)
    if (cleanup.value) {
      const handled = cleanupKey(ev)
      if (handled) { ev.preventDefault(); ev.stopPropagation() }
      return handled
    }
```
and in the `ctx` object literal there, after `selectTool, isToolAllowed, clearTrimGhosts,` add `cleanupAllowed, toggleCleanup,`.

- [ ] **Step 7: `usePen.ts` — session ends drop the preview.** Add `closeCleanup()` as the first statement of `undo()`, `redo()`, `reset()`, `finishSession()`, `revert()`, `endGesture()` and `dispose()`; in `selectTool(t)` add it right after `if (!isToolAllowed(t)) return`.

- [ ] **Step 8: `usePen.ts` — return object.** After the `// verbs` group add:

```ts
    // Clean up (pen stage 5)
    cleanup, toggleCleanup, startCleanup, applyCleanup, cancelCleanup, toggleCleanupFix, toggleCleanupKind, setCleanupStrength,
```

- [ ] **Step 9: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-cleanup.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-options.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-overlay-host-keys.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'composables/pen/(usePen|penKeys)'` → no lines.

- [ ] **Step 10: Commit** `frontend/app/composables/pen/usePen.ts frontend/app/composables/pen/penKeys.ts frontend/tests/unit/pen-cleanup.unit.spec.ts` — message `feat(pen): Clean up session — preview, switches, strength, Apply as one step, Cancel, ⌥⇧C`.

---

### Task 7: The preview on the canvas — ghost, cleaned drawing, badges

**Files:**
- Create: `frontend/app/lib/sketch/cleanup/badges.ts`
- Modify: `frontend/app/lib/sketch/cleanup/index.ts` (export the badges)
- Modify: `frontend/app/components/pen/PenOverlay.vue`
- Test: `frontend/tests/unit/cleanup-badges.unit.spec.ts`, `frontend/tests/unit/pen-overlay-cleanup.unit.spec.ts`

**Behaviour (spec §"Preview", with rulings):**
- While `pen.cleanup` is open the overlay draws, in drawing space, the drawing as it is as a faint dotted ghost (`data-cleanup-ghost`), the cleaned drawing's guides dashed (`data-cleanup-guides` — e.g. a new mirror axis) and the cleaned drawing solid on top (`data-cleanup-preview`). Points, handle arms, rule badges and radius chips are hidden, and the hit targets are not drawn (**Ruling 4**).
- One badge per fix, in screen space (`cleanupBadges`): a small dot where the fix acts and a chip up and right of it with the fix's label; chips that would cover each other stack downward; chips stay inside the overlay. An on fix is a green chip; an off fix is a dark chip with its label struck through. More than 20 fixes collapse into one chip per kind, "Tangent ×7" (**Ruling 18**). Attributes: `data-cleanup-fix="<fix id>"` (or `data-cleanup-kind="<kind>"` when collapsed), `data-fix-kind`, `data-on` / `data-off`. A click switches that fix (`toggleCleanupFix`) or that kind (`toggleCleanupKind`). The badges show whatever the Labels toggle says (they are the preview, not labels).
- Pointer input on the drawing is ignored while previewing (pointerdown / move on points, pieces, segments and the canvas).
- Keys: while previewing, `handleKeydownEvent` hands every key to `pen.onKeydown` before the focused-control rule, so Enter applies even while the Clean up button still has focus. With no preview, ⌥⇧C first settles the overlay's own live gesture (a marquee, a point drag, an arc press) — `settleOverlayGesture()` — then goes to the pen.

**Interfaces:**
- Consumes: Task 6 (`pen.cleanup`, `pen.toggleCleanupFix`, `pen.toggleCleanupKind`, `isCleanupKey`); Task 1 (`FIX_KIND_NAME`, `CleanupFix`, `FixKind`); `clampChipOrigin` from `lib/sketch/chipClamp.ts`; `sketchPathData`, `entityPath` from `lib/sketch/sketchPath.ts`.
- Produces: `badges.ts` — `BADGE_COLLAPSE_AT = 20`, `BADGE_H = 16`, `interface CleanupBadge { key, kind, label, on, ids, collapsed, x, y, w, ax, ay }`, `badgeWidth(label)`, `cleanupBadges(fixes, toScreen, width, height): CleanupBadge[]`; exported from `~/lib/sketch/cleanup`. Overlay attributes above.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/unit/cleanup-badges.unit.spec.ts`:

```ts
// tests/unit/cleanup-badges.unit.spec.ts
// Where Clean up's badges sit (pen stage 5): one per fix, up and right of its
// spot, stacked rather than overlapping, inside the overlay; more than 20
// collapse into one per kind with a count.
import { describe, it, expect } from 'vitest'
import { cleanupBadges, BADGE_COLLAPSE_AT } from '~/lib/sketch/cleanup'
import type { CleanupFix } from '~/lib/sketch/cleanup'

const same = (p: { x: number; y: number }) => p
const fix = (i: number, kind: CleanupFix['kind'], label: string, x: number, y: number, on = true): CleanupFix =>
  ({ id: `${kind}:${i}`, kind, label, on, at: { x, y } })

describe('cleanupBadges', () => {
  it('one badge per fix, up and right of its spot', () => {
    const b = cleanupBadges([fix(1, 'join', 'Joined', 100, 100), fix(2, 'tangent', 'Tangent', 300, 200, false)], same, 680, 460)
    expect(b.map(x => [x.key, x.label, x.on, x.collapsed])).toEqual([['join:1', 'Joined', true, false], ['tangent:2', 'Tangent', false, false]])
    expect(b[0]).toMatchObject({ x: 106, y: 80, ax: 100, ay: 100 })
  })
  it('badges on one spot stack instead of covering each other', () => {
    const b = cleanupBadges([fix(1, 'join', 'Joined', 100, 100), fix(2, 'tangent', 'Tangent', 100, 100)], same, 680, 460)
    expect(Math.abs(b[1]!.y - b[0]!.y)).toBeGreaterThanOrEqual(18)
  })
  it('stay inside the overlay', () => {
    const [b] = cleanupBadges([fix(1, 'join', 'Joined', 678, 2)], same, 680, 460)
    expect(b!.x + b!.w).toBeLessThanOrEqual(676)
    expect(b!.y).toBeGreaterThanOrEqual(16)
  })
  it(`more than ${BADGE_COLLAPSE_AT} collapse into one per kind with a count`, () => {
    const fixes = [
      ...Array.from({ length: 18 }, (_, i) => fix(i, 'tangent', 'Tangent', i * 30, 50)),
      ...Array.from({ length: 4 }, (_, i) => fix(i, 'join', 'Joined', i * 30, 300, i !== 0)),
    ]
    const b = cleanupBadges(fixes, same, 680, 460)
    expect(b.map(x => [x.label, x.collapsed, x.on, x.ids.length])).toEqual([['Tangent ×18', true, true, 18], ['Joined ×4', true, false, 4]])
    expect(b[0]!.key).toBe('kind:tangent')
  })
})
```

Create `frontend/tests/unit/pen-overlay-cleanup.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 5: PenOverlay while a Clean up preview is open — the cleaned
// drawing over a faint ghost, one badge per fix that switches it, the
// drawing's own points and input set aside, ⌥⇧C and Enter from the window.
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'

const view: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}
function mountFlower() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  flower(doc.value)
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const wrapper = mount(PenOverlay, { props: { pen, view, width: 680, height: 460 } })
  return { wrapper, doc, pen }
}

let mounted: ReturnType<typeof mountFlower>['wrapper'] | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
})

describe('PenOverlay — Clean up preview', () => {
  it('draws the cleaned drawing over a faint ghost, one badge per fix, and hides the points', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    expect(wrapper.findAll('circle[data-point]').length).toBeGreaterThan(0)
    pen.startCleanup(); await nextTick()
    expect(wrapper.find('[data-cleanup-preview]').exists()).toBe(true)
    expect(wrapper.find('[data-cleanup-ghost]').exists()).toBe(true)
    expect(wrapper.findAll('[data-fix-kind="join"]')).toHaveLength(4)
    expect(wrapper.find('[data-fix-kind="join"]').text()).toBe('Joined')
    expect(wrapper.findAll('circle[data-point]')).toHaveLength(0)
    expect(wrapper.findAll('[data-seg]')).toHaveLength(0)
    pen.cancelCleanup(); await nextTick()
    expect(wrapper.find('[data-cleanup-preview]').exists()).toBe(false)
    expect(wrapper.findAll('circle[data-point]').length).toBeGreaterThan(0)
  })
  it('a badge click switches its fix off, and on again', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    pen.startCleanup(); await nextTick()
    const id = wrapper.find('[data-fix-kind="join"]').attributes('data-cleanup-fix')!
    await wrapper.find(`[data-cleanup-fix="${id}"]`).trigger('click')
    expect(pen.cleanup.value!.off.has(id)).toBe(true)
    expect(wrapper.find(`[data-cleanup-fix="${id}"]`).attributes('data-off')).toBe('')
    await wrapper.find(`[data-cleanup-fix="${id}"]`).trigger('click')
    expect(pen.cleanup.value!.off.has(id)).toBe(false)
  })
  it('⌥⇧C opens it from the window; Enter applies it', async () => {
    const { wrapper, pen, doc } = mountFlower(); mounted = wrapper
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Ç', code: 'KeyC', altKey: true, shiftKey: true }))
    await nextTick()
    expect(pen.cleanup.value).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(pen.cleanup.value).toBeNull()
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(1)
  })
  it('pointer input on the drawing does nothing while previewing', async () => {
    const { wrapper, pen, doc } = mountFlower(); mounted = wrapper
    pen.selectTool('path')
    pen.startCleanup(); await nextTick()
    const n = doc.value.entities.length
    await wrapper.find('svg').trigger('pointerdown', { button: 0, clientX: 100, clientY: 100 })
    expect(doc.value.entities.length).toBe(n)
    expect(pen.pendingPath.value).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-badges.unit.spec.ts tests/unit/pen-overlay-cleanup.unit.spec.ts`
Expected: FAIL — `cleanupBadges` is not exported from `~/lib/sketch/cleanup`; the overlay has no `[data-cleanup-preview]`.

- [ ] **Step 3: Create `frontend/app/lib/sketch/cleanup/badges.ts`**

```ts
// app/lib/sketch/cleanup/badges.ts
// Where Clean up's badges sit on screen: one per fix, up and right of the
// spot it acts on, stacked so two never cover each other, kept inside the
// overlay; more than 20 collapse into one per kind with a count.
import type { Vec2 } from '../geom'
import { clampChipOrigin } from '../chipClamp'
import { FIX_KIND_NAME, type CleanupFix, type FixKind } from './types'

export const BADGE_COLLAPSE_AT = 20
export const BADGE_H = 16

export interface CleanupBadge {
  key: string            // the fix id, or "kind:<kind>" when collapsed
  kind: FixKind
  label: string
  on: boolean            // collapsed: every fix of the kind is on
  ids: string[]
  collapsed: boolean
  x: number              // the chip's top-left, and its width
  y: number
  w: number
  ax: number             // the spot it acts on
  ay: number
}

export function badgeWidth(label: string): number {
  return Math.round(label.length * 6.2 + 12)
}

export function cleanupBadges(fixes: readonly CleanupFix[], toScreen: (p: Vec2) => Vec2, width: number, height: number): CleanupBadge[] {
  type Raw = Omit<CleanupBadge, 'x' | 'y' | 'w' | 'ax' | 'ay'> & { s: Vec2 }
  let raw: Raw[]
  if (fixes.length > BADGE_COLLAPSE_AT) {
    const byKind = new Map<FixKind, CleanupFix[]>()
    for (const f of fixes) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
    raw = [...byKind].map(([kind, fs]) => {
      const pts = fs.map(f => toScreen(f.at))
      return {
        key: `kind:${kind}`, kind, label: `${FIX_KIND_NAME[kind]} ×${fs.length}`, on: fs.every(f => f.on),
        ids: fs.map(f => f.id), collapsed: true,
        s: { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length },
      }
    })
  } else {
    raw = fixes.map(f => ({ key: f.id, kind: f.kind, label: f.label, on: f.on, ids: [f.id], collapsed: false, s: toScreen(f.at) }))
  }
  const placed: CleanupBadge[] = []
  for (const { s, ...b } of raw) {
    const w = badgeWidth(b.label)
    const x = s.x + 6
    let y = s.y - 20
    for (let k = 0; k < 8 && placed.some(p => Math.abs(p.x - x) < Math.max(p.w, w) && Math.abs(p.y - y) < BADGE_H + 2); k++) y += BADGE_H + 2
    const o = clampChipOrigin(x, y, w, width, height, BADGE_H)
    placed.push({ ...b, x: o.x, y: o.y, w, ax: s.x, ay: s.y })
  }
  return placed
}
```

Add to `frontend/app/lib/sketch/cleanup/index.ts`:

```ts
export { cleanupBadges, badgeWidth, BADGE_COLLAPSE_AT, BADGE_H, type CleanupBadge } from './badges'
```

- [ ] **Step 4: `PenOverlay.vue` — script**

1. Imports: change `import { TOOL_KEYS } from '~/composables/pen/penKeys'` to `import { TOOL_KEYS, isCleanupKey } from '~/composables/pen/penKeys'` and add `import { cleanupBadges, type CleanupBadge } from '~/lib/sketch/cleanup'`.
2. In the `const { … } = props.pen` destructure, add a line: `cleanup: cleanupSession, toggleCleanupFix, toggleCleanupKind,`.
3. `pts`: change its first line `const pts = computed(() => (doc.value.entities.filter(e =>` to `const pts = computed(() => (cleanupSession.value ? [] : doc.value.entities.filter(e =>` (the rest of the expression is unchanged).
4. `handleArms`: make the first statement inside `computed(() => {` read `if (cleanupSession.value) return [] as { x1: number; y1: number; x2: number; y2: number }[]`.
5. `visibleMarks`: change `const visibleMarks = computed(() => marks.value` to `const visibleMarks = computed(() => (cleanupSession.value ? [] : marks.value)`.
6. `arcDims`: change `const arcDims = computed(() => arcDimensionMarks(doc.value).map(m => {` to `const arcDims = computed(() => (cleanupSession.value ? [] : arcDimensionMarks(doc.value)).map(m => {`.
7. After the `sparkleRender` computed, add:

```ts
// ---------- Clean up preview (pen stage 5) ----------
// the cleaned drawing, solid, over a faint ghost of the drawing as it is, with
// its guides dashed; one badge per fix (lib/sketch/cleanup/badges.ts) — a
// click switches that fix (or, collapsed, that kind) off and on
const cleanupD = computed(() => (cleanupSession.value ? sketchPathData(cleanupSession.value.result.doc) : ''))
const cleanupGuidesD = computed(() => {
  const s = cleanupSession.value
  if (!s) return ''
  const d = s.result.doc
  return d.entities.filter(e => e.kind !== 'point' && e.construction).map(e => entityPath(d, e.id)).filter(Boolean).join(' ')
})
const cleanupBadgeList = computed<CleanupBadge[]>(() => {
  const s = cleanupSession.value
  return s ? cleanupBadges(s.result.fixes, toScreen, props.width, props.height) : []
})
function onCleanupBadgeClick(b: CleanupBadge) {
  if (!props.active) return
  if (b.collapsed) toggleCleanupKind(b.kind)
  else toggleCleanupFix(b.key)
}
```

8. Pointer guards — add `if (cleanupSession.value) return` right after the first guard line of each of: `onEntityPointerDown`, `onPointerDownPoint` (after its `if (!props.active || …) return`), `onSegmentPointerDown` (likewise), `onPointerDownSvg` (likewise), and `onPointerMove` (after `if (!props.active) return`).
9. Keys — in `handleKeydownEvent`, right after `if (!props.active || isTypingInField()) return false`, add:

```ts
  // a Clean up preview owns the keys (usePen's cleanupKey): Enter applies even
  // while a toolbar button has focus
  if (cleanupSession.value) return props.pen.onKeydown(ev)
  // ⌥⇧C: the overlay's own live gesture settles before Clean up looks
  if (isCleanupKey(ev)) settleOverlayGesture()
```

- [ ] **Step 5: `PenOverlay.vue` — template**

1. In the drawing-space group, wrap its current contents: right after `<g :transform="svgTransform">` insert `<template v-if="!cleanupSession">`, and right before that group's closing `</g>` (the one after the `selectedSegments` template) insert:

```html
      </template>
      <template v-else>
        <path :d="pathDrawing" fill="none" stroke="#3730a3" stroke-width="1.5" stroke-dasharray="2 3" opacity="0.28"
              vector-effect="non-scaling-stroke" pointer-events="none" data-cleanup-ghost />
        <path :d="cleanupGuidesD" fill="none" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 3"
              vector-effect="non-scaling-stroke" pointer-events="none" data-cleanup-guides />
        <path :d="cleanupD" fill="none" stroke="#3730a3" stroke-width="1.75"
              vector-effect="non-scaling-stroke" pointer-events="none" data-cleanup-preview />
      </template>
```

2. Right before the `<rect v-if="marqueeRect" …>` line, add the badges:

```html
    <!-- Clean up: one badge per fix, with a dot where it acts -->
    <g v-for="b in cleanupBadgeList" :key="b.key" class="cleanup-badge" :pointer-events="active ? 'auto' : 'none'" style="cursor: pointer"
       :data-cleanup-fix="b.collapsed ? null : b.key" :data-cleanup-kind="b.collapsed ? b.kind : null"
       :data-fix-kind="b.kind" :data-on="b.on ? '' : null" :data-off="b.on ? null : ''"
       @pointerdown.stop @click.stop="onCleanupBadgeClick(b)">
      <circle :cx="b.ax" :cy="b.ay" r="2.5" :fill="b.on ? '#16a34a' : '#9ca3af'" pointer-events="none" />
      <rect :x="b.x" :y="b.y" :width="b.w" height="16" rx="4" :fill="b.on ? '#15803d' : '#111827'" :opacity="b.on ? 0.95 : 0.7" />
      <text :x="b.x + 6" :y="b.y + 11.5" :fill="b.on ? '#fff' : '#9ca3af'" font-size="10.5" font-family="ui-sans-serif, system-ui, sans-serif"
            :text-decoration="b.on ? undefined : 'line-through'">{{ b.label }}</text>
    </g>
```

3. In `<style scoped>` add:

```css
.cleanup-badge rect { transition: opacity 120ms ease; }
.cleanup-badge:hover rect { opacity: 1; }
```

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/cleanup-badges.unit.spec.ts tests/unit/pen-overlay-cleanup.unit.spec.ts tests/unit/pen-overlay-buttons.unit.spec.ts tests/unit/pen-overlay-cues.unit.spec.ts tests/unit/pen-overlay-host-keys.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'PenOverlay|lib/sketch/cleanup/'` → no lines.

- [ ] **Step 7: Commit** `frontend/app/lib/sketch/cleanup/badges.ts frontend/app/lib/sketch/cleanup/index.ts frontend/app/components/pen/PenOverlay.vue frontend/tests/unit/cleanup-badges.unit.spec.ts frontend/tests/unit/pen-overlay-cleanup.unit.spec.ts` — message `feat(pen): Clean up preview on the canvas — the cleaned drawing over a ghost, one switchable badge per fix`.

---

### Task 8: The toolbar — Clean up button, strength / Apply / Cancel row, tooltip cards and demo

**Files:**
- Modify: `frontend/app/components/pen/PenToolbar.vue`
- Modify: `frontend/app/composables/pen/penTips.ts` (four cards; ⌥ in `tipKeyLabel`)
- Modify: `frontend/app/composables/pen/penTipDemos.ts` (the `cleanup` demo)
- Modify: `frontend/tests/unit/pen-tips.unit.spec.ts`

**Behaviour (spec §"The command", "Strength", Shared ground "Copy", with rulings):**
- The tool row gains **Clean up** right after Dissolve (before the first separator): an icon button (`WandSparkles`), `data-act="cleanup"`, `aria-label="Clean up"`, `aria-pressed` while previewing, shown only when `pen.options.cleanup`. A click toggles the preview (**Ruling 1**).
- While previewing (**Ruling 4**): the rules row is hidden; every other button in the tool row is disabled (tools, Guide, Labels, Undo, Redo, Close / Finish, Cancel, Done); the hint row is replaced by the Clean up bar (`data-cleanup-bar`): a three-way segmented control **Gentle / Normal / Strong** (`role="radiogroup"`, buttons `role="radio"`, `data-strength`, `aria-checked`), a short state note when there is nothing to show (`data-cleanup-note`: "Nothing to change", "Too much to clean up at once — select a part", "Some rules don’t hold, so nothing is safe to change" — **Ruling 19**), **Cancel** (`data-act="cleanup-cancel"`) and **Apply** (`data-act="cleanup-apply"`, disabled when no fix is on).
- Cards (**Ruling 22**): `cleanup` (key ⌥⇧C, with a demo), `cleanup-apply` (key ↵), `cleanup-cancel` (key Esc), `cleanup-strength`. `tipKeyLabel` spells ⌥ as Alt off a Mac (⌥⇧C → Alt+Shift+C).
- The demo acts out Clean up on a small drawing: a shape whose top doesn't quite close and whose base sits a little off level; the cursor presses; the ends join, the base levels, the old drawing stays as a faint ghost, a sparkle marks the join.

**Interfaces:**
- Consumes: Task 6 (`pen.cleanup`, `pen.toggleCleanup`, `pen.applyCleanup`, `pen.cancelCleanup`, `pen.setCleanupStrength`, `pen.options.cleanup`); `STRENGTHS`, `CleanupStrength` from `~/lib/sketch/cleanup`.
- Produces: the DOM hooks above (Task 9's Playwright spec uses them); `PEN_TIPS.cleanup | 'cleanup-apply' | 'cleanup-cancel' | 'cleanup-strength'`; `PEN_TIP_DEMOS.cleanup`.

- [ ] **Step 1: Update the failing test** — in `frontend/tests/unit/pen-tips.unit.spec.ts`:

1. Below `const ALL_TOOLS …`, add `const DEMO_IDS = [...ALL_TOOLS, 'cleanup']`, and append `'cleanup-apply', 'cleanup-cancel', 'cleanup-strength'` to `FIXED_IDS`.
2. In `describe('pen tips table', …)`, change `const ids = [...ALL_TOOLS, ...FIXED_IDS, ...ruleKinds]` to `const ids = [...DEMO_IDS, ...FIXED_IDS, ...ruleKinds]`.
3. Replace the test `'the nine drawing and editing tools have a demo, and nothing else does'` with:

```ts
  it('the nine drawing and editing tools and Clean up have a demo, and nothing else does', () => {
    expect([...PEN_DEMO_TOOLS].sort()).toEqual([...DEMO_IDS].sort())
    for (const t of DEMO_IDS) expect(PEN_TIPS[t]!.demo).toBe(t)
    for (const id of FIXED_IDS) expect(PEN_TIPS[id]!.demo).toBeUndefined()
  })
  it('Clean up carries ⌥⇧C, spelled out off a Mac', () => {
    expect(PEN_TIPS.cleanup!.key).toBe('⌥⇧C')
    expect(tipKeyLabel('⌥⇧C', true)).toBe('⌥⇧C')
    expect(tipKeyLabel('⌥⇧C', false)).toBe('Alt+Shift+C')
  })
```

4. In `describe('pen tip demos', …)`, change both `it.each(ALL_TOOLS)` to `it.each(DEMO_IDS)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-tips.unit.spec.ts`
Expected: FAIL — no `cleanup` tip, no `cleanup` demo.

- [ ] **Step 3: `penTips.ts`**

In `PEN_TIPS`, after the `dissolve` entry, add:

```ts
  cleanup: { name: 'Clean up', key: '⌥⇧C', demo: 'cleanup',
    caption: 'Joins ends that nearly meet, squares what is nearly square and evens what is nearly even. Shows every change first; click one to leave it out.' },
```

After the `cancel` entry, add:

```ts
  'cleanup-apply': { name: 'Apply', key: '↵',
    caption: 'Keeps the changes that are switched on, as one step.' },
  'cleanup-cancel': { name: 'Cancel', key: 'Esc',
    caption: 'Closes Clean up and leaves the drawing as it was.' },
  'cleanup-strength': { name: 'Strength',
    caption: 'How far Clean up reaches: Gentle fixes only what is very close, Strong reaches further.' },
```

Replace `tipKeyLabel` with:

```ts
/** A tip's key badge text: Mac glyphs as-is on a Mac, spelled out elsewhere
 *  (⌘Z → Ctrl+Z, ⇧⌘Z → Ctrl+Shift+Z, ⌥⇧C → Alt+Shift+C). */
export function tipKeyLabel(key: string, isMac: boolean): string {
  if (isMac || !/[⌘⇧⌥]/.test(key)) return key
  const mods: string[] = []
  if (key.includes('⌘')) mods.push('Ctrl')
  if (key.includes('⌥')) mods.push('Alt')
  if (key.includes('⇧')) mods.push('Shift')
  return [...mods, key.replace(/[⌘⇧⌥]/g, '')].join('+')
}
```

Also update the file's header comment line "The nine drawing and editing tools also name a scripted demo in penTipDemos.ts." to "The nine drawing and editing tools, and Clean up, also name a scripted demo in penTipDemos.ts."

- [ ] **Step 4: `penTipDemos.ts`** — above `export const PEN_TIP_DEMOS`, add:

```ts
// Clean up: a shape whose top doesn't quite close and whose base sits a
// little off level; press, and it tidies — the ends join, the base levels,
// the old drawing stays as a faint ghost.
function cleanup(t: number): PenTipFrame {
  const done = t >= 0.53
  const L = v(36, 70), R = v(124, 70), top = v(80, 22)
  const Lo = v(36, 64), gapL = v(75, 25), gapR = v(85, 24)
  const before = sk()
    .path([Lo, gapL], [{ via: v(46, 36) }])
    .path([gapR, R], [{ via: v(116, 36) }])
    .line(Lo, R)
  const after = sk()
    .path([L, top, R], [{ via: v(44, 36) }, { via: v(116, 36) }])
    .line(L, R)
  const at = v(80, 88)
  const cursor = track(t, [[0.04, v(140, 90)], [0.34, at], [0.64, at], [0.84, v(112, 82)]])
  return {
    doc: done ? after.doc : before.doc, cursor, pressed: within(t, 0.5, 0.56),
    ghost: done ? before.doc : undefined,
    dots: done ? [L, top, R] : [Lo, gapL, gapR, R],
    ...sparkleAt(t, 0.53, top),
  }
}
```

and change the table to

```ts
export const PEN_TIP_DEMOS: Record<string, (t: number) => PenTipFrame> = {
  select, path, curve, line, circle, point, trim, cut, dissolve, cleanup,
}
```

Update the header comment "one scripted drawing per drawing/editing tool" to "one scripted drawing per drawing/editing tool, and one for Clean up".

- [ ] **Step 5: Run the tips test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-tips.unit.spec.ts`
Expected: all pass.

- [ ] **Step 6: `PenToolbar.vue` — script.** Add `WandSparkles` to the `lucide-vue-next` import, add `import { STRENGTHS, type CleanupStrength } from '~/lib/sketch/cleanup'`, add `cleanup, toggleCleanup, applyCleanup, cancelCleanup, setCleanupStrength,` to the `const { … } = props.pen` destructure, and add below `isSelectIdle`:

```ts
// Clean up (pen stage 5): while its preview is open the rules row hides, the
// tool row is disabled except Clean up itself, and the hint row becomes the
// strength / Cancel / Apply bar
const previewing = computed(() => !!cleanup.value)
const STRENGTH_LABEL: Record<CleanupStrength, string> = { gentle: 'Gentle', normal: 'Normal', strong: 'Strong' }
const cleanupHasOn = computed(() => !!cleanup.value?.result.fixes.some(f => f.on))
const cleanupNote = computed(() => {
  const s = cleanup.value
  if (!s) return ''
  if (s.result.refused === 'tooBig') return 'Too much to clean up at once — select a part'
  if (s.result.refused === 'conflict') return 'Some rules don’t hold, so nothing is safe to change'
  return s.result.fixes.length ? '' : 'Nothing to change'
})
```

- [ ] **Step 7: `PenToolbar.vue` — template**

1. Rules row: change `<div v-if="hasAnySelection" class="tb" role="toolbar" aria-label="Rules">` to `<div v-if="hasAnySelection && !previewing" class="tb" role="toolbar" aria-label="Rules">`.
2. Tool buttons: add `:disabled="previewing"` to the `[data-tool]` button, the Guide and Labels buttons, Close and Finish; change Undo's `:disabled="!canUndo()"` to `:disabled="!canUndo() || previewing"` and Redo's likewise; add `:disabled="previewing"` to the Cancel and Done `StudioButton`s.
3. Right after the `<PenTipCard v-for="t in TOOLS" …> … </PenTipCard>` loop (before the first `<span class="sep" />` of the tool row), add:

```html
      <PenTipCard v-if="options.cleanup" id="cleanup">
        <button class="tbtn icon toggle" data-act="cleanup" :aria-pressed="previewing" aria-label="Clean up"
                @click="toggleCleanup()">
          <WandSparkles :size="16" />
        </button>
      </PenTipCard>
```

4. Hint row: make the first branch of `.hint-wrap` the Clean up bar and turn the existing `v-if="opHint"` into `v-else-if="opHint"`:

```html
      <div v-if="cleanup" data-cleanup-bar class="hint cleanup-bar">
        <PenTipCard id="cleanup-strength">
          <div class="seg" role="radiogroup" aria-label="Strength">
            <button v-for="s in STRENGTHS" :key="s" class="seg-btn" role="radio" :data-strength="s"
                    :aria-checked="cleanup.strength === s" @click="setCleanupStrength(s)">{{ STRENGTH_LABEL[s] }}</button>
          </div>
        </PenTipCard>
        <span v-if="cleanupNote" data-cleanup-note>{{ cleanupNote }}</span>
        <PenTipCard id="cleanup-cancel">
          <button class="hint-btn" data-act="cleanup-cancel" aria-label="Cancel" @click="cancelCleanup()">Cancel</button>
        </PenTipCard>
        <PenTipCard id="cleanup-apply">
          <button class="hint-btn primary" data-act="cleanup-apply" aria-label="Apply" :disabled="!cleanupHasOn" @click="applyCleanup()">Apply</button>
        </PenTipCard>
      </div>
      <div v-else-if="opHint" data-op-hint class="hint">
```

5. Styles — add to `<style scoped>`:

```css
.cleanup-bar { gap: 8px; padding: 4px 6px; flex-wrap: wrap; justify-content: center; }
.seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); }
.seg-btn {
  height: 24px; padding: 0 10px; border: 0; border-radius: 4px; background: transparent;
  color: rgba(255, 255, 255, 0.7); font: 500 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
}
.seg-btn[aria-checked='true'] { background: #fff; color: #111; }
.seg-btn:hover:not([aria-checked='true']) { background: rgba(255, 255, 255, 0.08); }
.hint-btn {
  height: 24px; padding: 0 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2);
  background: transparent; color: rgba(255, 255, 255, 0.85); font: 500 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
}
.hint-btn.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
.hint-btn:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 8: Run the pen unit tests and typecheck**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-*.unit.spec.ts`
Expected: all pass. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'PenToolbar|penTips|penTipDemos'` → no lines. (The toolbar is proven in the browser in Task 9.)

- [ ] **Step 9: Commit** `frontend/app/components/pen/PenToolbar.vue frontend/app/composables/pen/penTips.ts frontend/app/composables/pen/penTipDemos.ts frontend/tests/unit/pen-tips.unit.spec.ts` — message `feat(pen): Clean up in the toolbar — the button after Dissolve, Gentle / Normal / Strong, Apply and Cancel, with their cards and a demo`.

---

### Task 9: Real-mouse proof — the pen page, the Frame, Shape Studio, laptop widths

**Files:**
- Modify: `frontend/app/pages/dev/sketch-draw.vue` (two test hooks)
- Test: `frontend/tests/pen-cleanup.spec.ts` (new)

**Behaviour:**
- **Ruling 24:** the pen page gains `__sketchDraw.load(raw)` — `reset()`, then `doc.value = mergeSketchDoc(raw)`, then `commitHistory()` (sets up a drawing; the one-step history then undoes back to it) — and `__sketchDraw.cleanup()`, a read-only snapshot `{ strength, fixes } | null` of the preview. The owner's trimmed flower has gaps (3.2 px) smaller than the pen's own snap distance (20.4 px), so it can't be drawn with `place`.
- The spec's host check: Clean up reaches the Frame's pen and Shape Studio's pen (the button, its card, ⌥⇧C / the button opening the bar, Escape closing it with the pen and the host still open), and their existing pen specs stay green.
- Laptop widths (spec "Testing"): at 1280 and 1024 px wide the Clean up bar and the tool row stay on screen and opening Clean up adds no sideways scroll.

**Interfaces:**
- Consumes: everything above; overlay / toolbar hooks `data-act="cleanup"`, `[data-cleanup-bar]`, `[data-cleanup-note]`, `[data-strength]`, `data-act="cleanup-apply" | "cleanup-cancel"`, `[data-cleanup-fix]`, `[data-fix-kind]`, `data-on` / `data-off`, `[data-cleanup-preview]`, `[data-cleanup-ghost]`, `[data-pen-tip-id="cleanup"]`, `[data-ent]`, `[data-tool]`.
- Produces: `__sketchDraw.load(raw: unknown): void`, `__sketchDraw.cleanup(): { strength: string; fixes: { id: string; kind: string; label: string; on: boolean }[] } | null`.

- [ ] **Step 1: The hooks** — in `frontend/app/pages/dev/sketch-draw.vue`, add `import { mergeSketchDoc } from '~/lib/sketch/merge'` to the imports, and in the `__sketchDraw` object (after `sparkleCount`) add:

```ts
    // pen stage 5 — Clean up: `load` sets up a drawing whose gaps are finer
    // than the pen's own snap (the trimmed flower) as one settled step;
    // `cleanup` reads the preview (never changes it)
    load: (raw: unknown) => { reset(); doc.value = mergeSketchDoc(raw); commitHistory() },
    cleanup: () => {
      const s = pen.cleanup.value
      return s ? { strength: s.strength, fixes: s.result.fixes.map(f => ({ id: f.id, kind: f.kind, label: f.label, on: f.on })) } : null
    },
```

- [ ] **Step 2: Write the spec** — create `frontend/tests/pen-cleanup.spec.ts`:

```ts
// tests/pen-cleanup.spec.ts
// Pen stage 5 — Clean up — with the REAL mouse and keyboard: the owner's
// trimmed flower (petals as separate open pieces whose ends nearly meet)
// previewed and joined into one closed loop in one undo step; a badge
// switched off and on; Escape leaves everything alone; Strength; a
// selection; laptop widths; and the Frame's and Shape Studio's pens.
// __sketchDraw only sets drawings up and reads them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const paths = (d: any) => d.entities.filter((e: any) => e.kind === 'path')

// four petal arcs round a square, each ending 3.2 px short of the next one's start
async function loadFlower(page: Page) {
  await page.evaluate(() => {
    const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
    const entities: any[] = [], constraints: any[] = []
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
      const ex = x1 + 0.08, ey = y1 + 0.05
      entities.push(
        { id: `s${i}`, kind: 'point', x: x0, y: y0 },
        { id: `e${i}`, kind: 'point', x: ex, y: ey },
        { id: `c${i}`, kind: 'point', x: (x0 + ex) / 2, y: (y0 + ey) / 2 },
        { id: `P${i}`, kind: 'path', anchors: [`s${i}`, `e${i}`], segments: [{ kind: 'arc', center: `c${i}`, sweep: 1 }], closed: false },
      )
      constraints.push({ id: `k${i}`, kind: 'equalDist', refs: [`c${i}`, `s${i}`, `c${i}`, `e${i}`] })
    }
    ;(window as any).__sketchDraw.load({ entities, constraints })
  })
}

test('Clean up joins the trimmed flower into one closed loop, previewed first, in one undo step', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  const before = await doc(page)
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
  await expect(page.locator('[data-act="cleanup"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-tool="path"]')).toBeDisabled()
  await expect(page.locator('[data-cleanup-preview]')).toHaveCount(1)
  await expect(page.locator('[data-cleanup-ghost]')).toHaveCount(1)
  await expect(page.locator('[data-fix-kind="join"]')).toHaveCount(4)
  await expect(page.locator('[data-fix-kind="join"]').first()).toHaveText('Joined')
  expect(await doc(page)).toEqual(before)                 // the preview never touches the drawing
  await page.keyboard.press('Enter')                      // the Clean up button still has focus: Enter applies
  await expect(page.locator('[data-cleanup-bar]')).toHaveCount(0)
  const d = await doc(page)
  expect(paths(d)).toHaveLength(1)
  expect(paths(d)[0].closed).toBe(true)
  expect(paths(d)[0].segments.map((s: any) => s.kind)).toEqual(['arc', 'arc', 'arc', 'arc'])
  await page.keyboard.press(`${META}+z`)
  expect(await doc(page)).toEqual(before)
})

test('⌥⇧C opens Clean up; a badge clicked off is left out, and Apply keeps the rest', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  await page.keyboard.press('Alt+Shift+KeyC')
  await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
  const id = await page.locator('[data-fix-kind="join"]').first().getAttribute('data-cleanup-fix')
  const badge = page.locator(`[data-cleanup-fix="${id}"]`)
  await badge.click()
  await expect(badge).toHaveAttribute('data-off', '')
  await badge.click()
  await expect(badge).toHaveAttribute('data-on', '')
  await badge.click()
  await expect(badge).toHaveAttribute('data-off', '')
  await page.locator('[data-act="cleanup-apply"]').click()
  const d = await doc(page)
  expect(paths(d)).toHaveLength(1)
  expect(paths(d)[0].closed).toBe(false)
  expect(paths(d)[0].anchors).toHaveLength(5)
})

test('Escape closes Clean up and leaves the drawing and its history alone', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  const before = await doc(page)
  const canUndo = await page.evaluate(() => (window as any).__sketchDraw.canUndo())
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-cleanup-bar]')).toHaveCount(0)
  await expect(page.locator('[data-cleanup-fix]')).toHaveCount(0)
  expect(await doc(page)).toEqual(before)
  expect(await page.evaluate(() => (window as any).__sketchDraw.canUndo())).toBe(canUndo)
  expect(await page.evaluate(() => (window as any).__sketchDraw.status())).toBe('Clean up cancelled')
})

test('Strength: a line 6° off level is only levelled at Strong; Cancel closes', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset(); D.setTool('line')
    D.place(2, 2); D.place(10, 2 + 8 * Math.tan(6 * Math.PI / 180))
    D.setTool('select')
  })
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-strength="normal"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(0)
  await page.locator('[data-strength="strong"]').click()
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(1)
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveText('Horizontal')
  await page.locator('[data-strength="gentle"]').click()
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(0)
  await page.locator('[data-act="cleanup-cancel"]').click()
  await expect(page.locator('[data-cleanup-bar]')).toHaveCount(0)
})

test('with a selection, Clean up works on it and leaves the rest where it was', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    const dy = 8 * Math.tan(2 * Math.PI / 180)
    D.reset(); D.setTool('line')
    D.place(2, 2); D.place(10, 2 + dy)
    D.place(2, 7); D.place(10, 7 + dy)
    D.setTool('select')
    const [l1, l2] = D.doc.entities.filter((e: any) => e.kind === 'line')
    return { l1: l1.id as string, p1: l2.p1 as string, p2: l2.p2 as string }
  })
  const before = await doc(page)
  await page.locator(`[data-ent="${ids.l1}"]`).click()
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(1)
  await page.locator('[data-act="cleanup-apply"]').click()
  const d = await doc(page)
  for (const id of [ids.p1, ids.p2]) expect(d.entities.find((e: any) => e.id === id)).toEqual(before.entities.find((e: any) => e.id === id))
})

for (const width of [1280, 1024]) {
  test(`the Clean up bar and the tool row fit at ${width} px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page)
    await loadFlower(page)
    const scrollBefore = await page.evaluate(() => document.documentElement.scrollWidth)
    await page.locator('[data-act="cleanup"]').click()
    await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
    for (const sel of ['[data-cleanup-bar]', '[aria-label="Pen tools"]']) {
      const box = (await page.locator(sel).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    const scrollAfter = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollAfter).toBeLessThanOrEqual(Math.max(scrollBefore, width))
  })
}

test('the Frame’s pen offers Clean up; Escape closes it and leaves the pen open', async ({ page }) => {
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]')
  await page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first().click()
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  const btn = page.locator('[data-act="cleanup"]')
  await expect(btn).toBeVisible()
  await btn.hover()
  await expect(page.locator('[data-pen-tip-id="cleanup"]')).toBeVisible()
  await btn.click()
  await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
  await expect(page.locator('[data-cleanup-note]')).toHaveText('Nothing to change')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-cleanup-bar]')).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await page.keyboard.press('Alt+Shift+KeyC')
  await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-cleanup-bar]')).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
})

test('Shape Studio’s pen offers Clean up; Escape closes it and leaves the studio open', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-cleanup-bar]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-cleanup-bar]')).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__shapeStudioLab.closes as number)).toBe(0)
})
```

- [ ] **Step 3: Run it**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/pen-cleanup.spec.ts --project=chromium`
Expected: 9 passed. If the page serves old modules, `touch` the pen files and curl the served `usePen.ts` for `startCleanup` (Global Constraints) — never restart the server. If a check fails for real, fix the code in the file from the task that owns it (and re-run that task's unit tests) rather than loosening the spec; note it in your report. (If the laptop-width case fails only because the page already scrolled sideways before Clean up opened, that is what the before/after comparison is for — do not remove it.)

- [ ] **Step 4: Run the host and stage specs, and the unit set**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-snap.spec.ts tests/pen-weld.spec.ts tests/pen-trim.spec.ts tests/pen-tips.spec.ts tests/pen-tangent.spec.ts tests/pen-cleanup.spec.ts --project=chromium`
Expected: all pass. Then `npx vitest run tests/unit/pen-*.unit.spec.ts tests/unit/sketch-*.unit.spec.ts tests/unit/cleanup-*.unit.spec.ts` — all pass (counts can wobble under load; re-run a failing file alone before calling it a failure).

- [ ] **Step 5: Commit** `frontend/app/pages/dev/sketch-draw.vue frontend/tests/pen-cleanup.spec.ts` (plus any fix you had to make, by exact path) — message `test(pen): Clean up with the real mouse — the trimmed flower joined, badges, Escape, strength, selection, widths, the Frame and Shape Studio`.

---

### Task 10: Record it

**Files:**
- Modify: `docs/STATE.md` (new entry at the top of the landed list, above "The pen — tangency done right (stage 4)")
- Modify: `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` (status line only)

- [ ] **Step 1: STATE.md entry** — heading `### The pen — Clean up (stage 5) — LANDED 2026-09-26 (spec docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md, plan docs/superpowers/plans/2026-09-26-pen-stage-5-clean-up.md; <first>..<last> commits)`, then in the style of the stage 4 entry: what you can do (Clean up button after Dissolve and ⌥⇧C; works on the selection or the whole drawing; the cleaned drawing over a faint ghost; a badge per fix, click to leave one out; Gentle / Normal / Strong; Apply = one undo step, Esc leaves it alone; the trimmed flower joins into one closed loop, so the Frame fills its centre), what was proven (the unit files and `tests/pen-cleanup.spec.ts`, the host specs green, 1280 / 1024 widths), the rulings (the list at the top of the plan — at least 1, 3–8, 13–19), and known limits (equal radius never ties an arc to a circle; evenly spaced parallel lines use guide points; round sizes only when a drawing unit is ≥ 4 px on screen; the preview re-solves synchronously, so a very busy drawing lags on each switch; no remembered refusals — spec, later).
- [ ] **Step 2: Spec status line** → `Status: designed 2026-09-26 on the owner's "let's build stage 4-8 first"; stages 4–5 built 2026-09-26`.
- [ ] **Step 3: Commit** `docs/STATE.md docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — message `docs(pen): stage 5 built — Clean up`. (The controller, not the implementer, updates the build dashboard afterwards.)

---

## Self-review

**Spec coverage (Stage 5):**
- The command: button after Dissolve + ⌥⇧C (Tasks 6, 8); selection scope with the rest held as reference (Tasks 2, 5, 6); preview with the cleaned drawing solid over a faint ghost (Task 7); badges with plain labels, click to switch, re-solved from the original every time (Tasks 5, 6, 7); >20 collapse per kind with a count (Task 7); Strength Gentle / Normal / Strong ×0.5 / ×1 / ×1.75 in the hint row, Normal default (Tasks 1, 6, 8); Apply (Enter) one undo step, Cancel (Esc) untouched (Tasks 6, 9).
- What it finds, 1–11: joins (Task 2, merge via `mergePoints`, the flower in Tasks 5, 6, 9), on curve (2), tangent (2), H/V (3), parallel / perpendicular with the biggest group first (3), concentric as a shared centre (4), equal lengths (4), equal radii (4), even spacing (4), mirror pairs on a guide axis (4), round sizes as a one-off nudge (4). Tolerances as the spec's px / % / ° × strength (Task 1 `TOL`).
- How it decides: sorted-value grouping without chaining, length-weighted target / typed values never move (Tasks 1, 4, Ruling 9); staged, greedy by score, each fix re-solved and dropped when the solve fails, it adds nothing, anything moves > 8 px or 10 %, or an arc flips or shrinks under 2 px (Task 5); Repeat / Mirror source only plus seams (Tasks 2–4, test in Task 5); each Clean up starts fresh (Task 6).
- Shared ground: one pen, three hosts — no host file changes, `PenOptions.cleanup` for a host that can't use it (Tasks 6, 9); existing rule kinds only, macros that make ordinary pieces (guide points / lines) (Tasks 4, 5); tolerances through `pxToUnits` (Task 6); one undo step (Task 6); copy rules and tooltip cards with a demo (Task 8); Bézier out (Task 2). Testing: every detector and its guards (Tasks 2–5), real mouse Clean up preview → switch a badge off → Apply → undo (Task 9), host checks and laptop widths (Task 9).
- Out of scope kept out: remembered refusals, curvature joins, Bézier, anything from stages 6–8.

**Spec problems found:** (1) "Square" is listed as a badge without saying for what — ruled the perpendicular fix; Horizontal / Vertical get their own labels. (2) Equal radii across an arc and a circle can't be said with any existing rule (`equalDist` needs points, `equalRadius` needs two circles) — ruled arcs with arcs, circles with circles. (3) "Evenly spaced" parallel lines can't be said with existing rules either — done with guide points (`midpoint` + `collinear`), which the "macros make ordinary pieces" principle allows. (4) "8 px or 10 % of its size" is ambiguous — ruled the larger of the two, on the smallest piece the point belongs to, measured against the original drawing. (5) Round sizes to whole units are meaningless where one unit is a fraction of a pixel (every size would be "within 2 %") — ruled only when a unit is ≥ 4 px on screen. (6) The spec's badge list omits several of its own detectors (On curve, Same centre, Same length, Rounded) — labels ruled in Ruling 18. (7) The research recipe's weak "stay" weighted by size is not in the solver; its uniform warm-start stay already favours long pieces, so no solver change (Ruling 9).

**Type consistency:** `Candidate`, `CleanupOptions`, `CleanupResult`, `CleanupFix`, `FixKind`, `CleanupStrength`, `STRENGTHS` (Task 1) are used with the same names in Tasks 2–8; `Piece`, `CleanupContext`, `ContextEnv`, `stableKey`, `pairKey`, `linePieces`, `typedSize`, `radiusOf`, `lineAngleDeg` (Task 2) match Tasks 3–5; `solveHeld`, `componentOf`, `baselineOf`, `movedTooFar`, `arcBroken`, `runCleanup` (Task 5) match Task 6; `pen.cleanup` / `toggleCleanup` / `startCleanup` / `applyCleanup` / `cancelCleanup` / `toggleCleanupFix` / `toggleCleanupKind` / `setCleanupStrength` / `isCleanupKey` (Task 6) match Tasks 7–9; `cleanupBadges` / `CleanupBadge` (Task 7) match the overlay; DOM hooks (Tasks 7–8) match Task 9.
