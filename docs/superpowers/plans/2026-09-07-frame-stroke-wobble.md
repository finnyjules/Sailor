# Frame Stroke Wobble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** A Frame layer's outlines can each be made wavy or zigzag, and both a band and marching shapes inherit it.

**Architecture:** `offsetPolyline` already moves every vertex of a flattened outline along its normal by a constant. Wobble makes that constant vary with arc length. Because `shapeStrokeGuideFit` already does flatten → offset → guide, marching shapes get it for nothing; a band needs a second construction (stroke the displaced polyline) because the existing distance band is a raster dilation, which can only be a constant radius.

**Tech Stack:** Nuxt 4 · Vue 3 · TypeScript · Canvas 2D · Vitest (node, recording fake ctx) · Playwright (real Chromium, real pixels).

Spec: `docs/superpowers/specs/2026-09-07-frame-stroke-wobble-design.md`. Read it before Task 1.

## Global Constraints

- **Main checkout, branch `main`.** No worktree, no branch — `CLAUDE.md` overrides any skill that starts with one.
- **Stage your own hunks under a private index, then resync the shared one.** Other sessions edit this checkout; `useCompositorLayers.ts` and `CompositorModal.vue` are the two files they collide on.
  ```bash
  export GIT_INDEX_FILE=$(mktemp -u /tmp/idx.XXXXXX)
  git add -- <exact paths>
  git commit -F - -- <the same exact paths>
  unset GIT_INDEX_FILE
  git add -- <the same exact paths>   # without this the shared index shows your files as staged DELETIONS
  ```
  Never `git add -A`, never `git stash`, never `git checkout` a file.
- **Byte-identity is inviolable.** `frontend/tests/fixtures/multi-stroke-legacy.txt` must stay byte-unchanged and its Playwright case green. **It is known to be intermittently flaky** (a `stackPixels` settling problem that predates this work) — re-run before concluding, and if it reddens repeatedly report BLOCKED. Never regenerate the baseline.
- **Wobble absent ⇒ not one statement of today's path changes.**
- **No wobble on text.** The Frame's text layer has no glyph outlines. `paintTextStrokeBands` / `textStrokePasses` are not touched by this plan.
- **UI copy: sentence case, never an internal identifier.** Every select needs human `optionLabels`.
- Vitest `npx vitest run <path>` and Playwright `npx playwright test <path> --reporter=line`, both from `frontend/`. Typecheck `npx nuxt typecheck` from `frontend/` — ~411 pre-existing errors in other sessions' files, none may be yours. 7 pre-existing failing unit specs are other sessions'; any eighth is yours.
- A dev server serves this checkout on **127.0.0.1:3002**. Verify with `lsof -a -p <pid> -d cwd`; do not start another — killing Nuxt here can take the ComfyUI backend with it.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Verified seams (checked against the code on 2026-09-07, not remembered)

| Symbol | Location |
| --- | --- |
| `offsetPolyline(pts, closed, distance)` | `frontend/app/lib/compositor/strokeShapes.ts:75` — **no callers outside its own module and tests** |
| `shapeStrokeGuideFit(d, distance, tolerance?)` | `strokeShapes.ts:155` — flatten → offset → guide, the one seam marching shapes use |
| `SHAPE_STROKE_MAX_MARKS` | `strokeShapes.ts` |
| `STROKE_STYLES` / `STROKE_JOINS` | `frontend/app/lib/compositor/strokeStack.ts:25` / `:21` |
| `paintStrokeStack` | `frontend/app/composables/useCompositorLayers.ts:2651` |
| its 3 call sites, **all already supplying `outline` + `outlineTolerance`** | `:2761` rect · `:2767` ellipse · `:3461` `drawPath` |
| `paintShapeStroke` | `useCompositorLayers.ts:2587` |
| `outlinePathData` | `useCompositorLayers.ts:2560` |
| `strokeReachPx` / `cornerPinPadPx` | `useCompositorLayers.ts` (split from the old `outsideStrokePadPx`) |
| gates | `frontend/app/lib/compositor/strokeInspector.ts` |

---

## Task 1: The wobble maths, the data model, and marching shapes

**Files:** modify `frontend/app/lib/compositor/strokeShapes.ts`, `frontend/app/lib/compositor/strokeStack.ts`; test `frontend/tests/unit/compositor-stroke-wobble.unit.spec.ts` (create), extend `compositor-stroke-shapes.unit.spec.ts` and `compositor-stroke-stack.unit.spec.ts`.

**Produces:** `STROKE_WOBBLES`, `StrokeWobble`, the four `StrokeInstance` fields and their normalisation; `WobbleSpec`, `wobbleSpecOf(stroke, unit)`, `resamplePolyline`, `wobbleValue`, a widened `offsetPolyline(pts, closed, distance, wobble?)` and `shapeStrokeGuideFit(d, distance, tolerance?, wobble?)`.

- [ ] **Step 1: The pure maths, test-first**

```ts
/** One full cycle of the wobble at phase-normalised position `u` ∈ [0,1), in [-1,1].
 *  Both start at 0 rising, so switching shape keeps the phase meaning. */
export function wobbleValue(shape: StrokeWobble, u: number): number {
  const f = u - Math.floor(u)
  if (shape === 'wave') return Math.sin(f * Math.PI * 2)
  // Triangle: 0 → 1 → 0 → -1 → 0, matching sin's shape so Phase means the same thing.
  if (f < 0.25) return 4 * f
  if (f < 0.75) return 2 - 4 * f
  return 4 * f - 4
}
```

Tests: `wave` matches `sin` at 0, ¼, ½, ¾; `zigzag` gives exactly 0, 1, 0, −1 at those points and is linear between them (check a midpoint: `u = 0.125` ⇒ 0.5); both are periodic (`u` and `u + 1` agree); both stay within [−1, 1] across 100 samples.

- [ ] **Step 2: Resampling — the trap, and a RECT is the fixture**

```ts
/** Even arc-length resample. A rectangle's edge flattens to TWO points, so a wobble applied
 *  to the raw flattened outline does nothing at all on every rect, polygon and star while
 *  looking right on a circle. Everything downstream of this depends on it. */
export function resamplePolyline(pts: readonly FlatPoint[], closed: boolean, step: number): FlatPoint[]
```

Walk the polyline (adding the implied closing chord when `closed`), emitting a point every `step`
of arc length. Cap the output at `WOBBLE_MAX_POINTS = 4000` so a near-zero step cannot hang the
draw loop. Return the input unchanged for a non-finite or non-positive `step`.

Tests, **on a rectangle**: a 2×1 rect (4 points, perimeter 6) resampled at 0.1 yields ~60 points,
each consecutive pair 0.1 apart to 1e-9, and the corners still lie on the outline; a closed
resample's last point is one step from the first, not on top of it; the cap holds at a tiny step;
a degenerate step returns the input.

- [ ] **Step 3: The spec object and the closed-cycle snap**

```ts
export interface WobbleSpec { shape: StrokeWobble; amount: number; length: number; phase: number }

/** The effective wavelength. On a CLOSED outline the cycle count snaps to `round(total/λ)`
 *  (min 1) so the wave meets itself in phase at the seam — the same seam fix
 *  `shapePlacements` makes for spacing. An OPEN outline keeps the requested λ. */
export function effectiveWavelength(total: number, length: number, closed: boolean): number
```

Tests: a perimeter of 8 with λ 0.7 snaps to 8/11; with λ 1 stays 1; an open outline never snaps; a
λ larger than the whole perimeter still yields exactly one cycle.

- [ ] **Step 4: Widen `offsetPolyline`, and let marching shapes have it**

`offsetPolyline(pts, closed, distance, wobble?)`: when `wobble` is present and its `amount` and
`length` are both positive, resample first (step = `effectiveWavelength / 16`, never coarser than
the incoming average spacing), then displace each point by `distance + amount · wobbleValue(shape, s/λeff + phase/360)`.
Absent or degenerate wobble ⇒ **the existing code path, unchanged**.

`shapeStrokeGuideFit(d, distance, tolerance?, wobble?)` passes it through. Nothing in
`paintShapeStroke` changes — marching shapes are done when this step is.

Tests: a rect with a wave deviates from the un-wobbled offset by at most `amount` and reaches it;
the deviation at a quarter-cycle equals `amount` within tolerance; **an un-wobbled call returns a
result identical to before** (compare against `offsetPolyline(pts, closed, distance)` with three
arguments); the existing `offsetPolyline` and `shapeStrokeGuideFit` suites stay green untouched.

- [ ] **Step 5: The data model**

Add `wobble`, `wobbleAmount`, `wobbleLength`, `wobblePhase` to `StrokeInstance` and export
`STROKE_WOBBLES = ['wave', 'zigzag'] as const`. In `strokeStackOf`, normalise the way `shapes`
is already normalised: an unrecognised shape, a non-positive or non-finite `wobbleLength`, or a
non-finite `wobbleAmount` reads as **off**; a non-finite `wobblePhase` reads as 0. Add
`wobbleSpecOf(stroke, unit): WobbleSpec | null` returning null when off, so every consumer asks
one function rather than re-deriving the "is it on" rule.

Tests: each degenerate field reads as off; a legacy layer is unaffected; `wobbleSpecOf` scales
`amount` and `length` by `unit`.

- [ ] **Step 6: Mutation-check, then commit**

Delete the resample call and confirm the rect wobble test goes red (it must — that is the trap).
Delete the closed snap and confirm the seam test goes red. Quote both. Then run
`npx vitest run tests/unit/compositor-stroke-*.unit.spec.ts` and commit
`strokeShapes.ts`, `strokeStack.ts` and the three specs.

---

## Task 2: The wobbled band, and the reach

**Runs in PARALLEL with Task 3.** You own `frontend/app/composables/useCompositorLayers.ts` and
`frontend/tests/unit/compositor-stroke-style.unit.spec.ts` **only**. Do not touch
`strokeInspector.ts`, `StrokeStyleRow.vue` or `CompositorModal.vue` — another agent owns those.

**Consumes:** everything Task 1 produced.

- [ ] **Step 1: The band route**

In `paintStrokeStack`, when `wobbleSpecOf(st, widthScale)` is non-null and the style is a band:
flatten `o.outline` (already supplied at all three call sites), run it through the widened
`offsetPolyline` with the stroke's distance and wobble, build a `Path2D` from the resulting
polyline (closing it when the subpath was closed) and stroke it at `width` with the stroke's
`join`, dash and paint. Do **not** route it through `paintStrokeBand`'s dilation construction —
that can only be a constant radius.

Wobble absent ⇒ the existing branch runs, statement for statement.

- [ ] **Step 2: The reach — this one fails silently**

`strokeReachPx` and `cornerPinPadPx` must each add the wobble amplitude to a wobbled stroke's
reach, for a band **and** for a shapes stroke. Without it the wave is clipped at a corner-pin or
DOF offscreen edge and cut by the torn-edge silhouette: a slightly wrong shape, never an error.
This consumer has needed updating three times in this feature family.

Add a unit case for each helper and **run it red by removing the amplitude term**. Quote what you saw.

- [ ] **Step 3: Verify and commit**

`npx vitest run tests/unit/compositor-stroke-*.unit.spec.ts`, then the byte-identity case
(`npx playwright test tests/compositor-multi-stroke.spec.ts --reporter=line`), then typecheck.
`git diff -- frontend/app/composables/useCompositorLayers.ts` must show only your hunks.

---

## Task 3: The rows

**Runs in PARALLEL with Task 2.** You own `frontend/app/lib/compositor/strokeInspector.ts`,
`frontend/app/components/vue-canvas/compositor/StrokeStyleRow.vue`,
`frontend/app/components/vue-canvas/CompositorModal.vue` and
`frontend/tests/unit/compositor-stroke-inspector.unit.spec.ts` **only**. Do not touch
`useCompositorLayers.ts` — another agent owns it.

**Consumes:** `STROKE_WOBBLES` and the four fields from Task 1.

- [ ] **Step 1: Four rows and their gates**

After Distance, before Style: **Wobble** (`optionLabels` `['Off', 'Wave', 'Zigzag']`), then
**Amount**, **Every** and **Phase**, shown only when Wobble is not Off. Wobble itself is hidden on
a text layer — waviness needs a path and a Frame text layer has none.

**And change one existing gate:** Corners shows only at `distance !== 0` today, because
`strokeAligned` never sets `lineJoin`. A wobbled band strokes a path and *does* honour the join, so
Corners must also show when Wobble is on — otherwise a zigzag's points are governed by a hidden
control. Cover that with its own case.

- [ ] **Step 2: Write in ONE patch**

Every edit goes through `writeStrokeStackToLayer(nextStack)` in one `setLocal`, as the existing
rows do. Turning Wobble on seeds `wobbleAmount` and `wobbleLength` in the same patch so the first
render shows something — a half-applied edit is the shape of bug that produced a band flash before.

- [ ] **Step 3: Test the WIRING, not just the gate**

A pure-gate test is blind to the prop wiring — that is how a row went missing last time. Extend the
live-DOM suite `frontend/tests/compositor-stroke-inspector-wiring.spec.ts` so the asserted row set
covers the four new rows and the widened Corners rule. Prove it red by feeding one row's `:show-`
prop the wrong gate. Quote it.

---

## Task 4: Proof in a real browser, and the review

**Consumes:** Tasks 1–3.

- [ ] **Step 1: Pixels**

Add to `frontend/tests/compositor-multi-stroke.spec.ts`:
- a wavy band on a **rect** deviates from the straight line by the amount, at the expected
  frequency — probe points **derived from the geometry, not guessed**;
- a **zigzag** on a rect reads as straight runs and points, not a curve;
- **marching shapes on a wobbled line** sit off the straight line by the amount;
- wobble **off** renders identically to a stroke with no wobble fields at all.

Run each red first. The rect matters: a circle would pass even if resampling were broken.

- [ ] **Step 2: Reach, live**

A wobbled stroke inside a corner-pin is not clipped. Red by forcing the amplitude term to 0.

- [ ] **Step 3: Full suites and the final review**

Full unit suite (baseline 7 failures, all other sessions'), typecheck at ~411, byte-identity green
and the fixture byte-unchanged. Then a whole-feature review on opus covering both parallel tasks
as one change, with the standing question for this family: **enumerate anything that can still
write a stroke field behind the reader's back.**

## Self-Review

**Spec coverage.** Wobble as a line property → Tasks 1, 2. Wave and zigzag → Task 1 Step 1.
Resampling trap → Task 1 Step 2 and Task 4 Step 1. Closed-cycle snap → Task 1 Step 3. Marching
shapes inherit → Task 1 Step 4. Band route → Task 2 Step 1. Reach → Task 2 Step 2. Rows and the
widened Corners gate → Task 3. Not-on-text → Task 3 Step 1 plus the fact that
`paintTextStrokeBands` is untouched. Byte-identity → Global Constraints, Task 2 Step 3, Task 4.

**Type consistency.** `StrokeWobble`, `STROKE_WOBBLES`, `WobbleSpec`, `wobbleValue`,
`resamplePolyline`, `effectiveWavelength`, `wobbleSpecOf`, `WOBBLE_MAX_POINTS` are spelled
identically at every mention. `amount` and `length` are in the same units as `width` at every
declaration and are scaled by `unit` exactly once, in `wobbleSpecOf`.

**Parallel safety.** Task 2 and Task 3 own disjoint file sets, listed explicitly in each. Task 1
must land before either starts.
