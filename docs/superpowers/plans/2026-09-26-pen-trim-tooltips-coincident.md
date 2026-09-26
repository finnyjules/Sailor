# The pen, stages 1–3 — trim, tooltip cards, coincident — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim / Cut / Dissolve with crossing detection, tooltip cards with shortcuts and animated demos on every pen button, and coincident that snaps onto arcs and midpoints, previews ⊙, welds by drag and merges points.

**Architecture:** Two new pure modules in `frontend/app/lib/sketch/` (`crossings.ts` for intersections and spans, `trim.ts` for topology edits and `mergePoints`), wired into the shared pen (`composables/pen/usePen.ts`, `components/pen/PenOverlay.vue`, `components/pen/PenToolbar.vue`, `composables/pen/penKeys.ts`, `composables/pen/penRules.ts`, `lib/sketch/infer.ts`). A new `components/pen/PenTipCard.vue` (+ `pen/penTips.ts` content, `pen/penTipDemos.ts` scripted drawings) on top of `components/ui/tooltip`. Every host (dev page, Frame, Shape Studio) inherits it through the shared pen.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest, Playwright (against the existing :3002 dev server).

**Spec:** `docs/superpowers/specs/2026-09-26-pen-trim-tooltips-coincident-design.md` — read it; it is the authority for behaviour.

## Global Constraints
- UI copy: sentence case, no identifiers; glyphs (⊙ ⊥ T R) fine.
- Never run `npm run dev`, never start or kill servers. A dev server serves the main checkout on :3002; if a live probe looks stale, check the served module for your new identifier (`curl -s http://127.0.0.1:3002/_nuxt/Users/julien/Documents/GitHub/Sailor/frontend/app/<path>`) and `touch` the file if it is old.
- Other sessions edit this checkout. Never `git stash`. Touch only your files. Commit through a private index: `export GIT_INDEX_FILE=$(mktemp …)`, `git read-tree HEAD`, `git add <exact paths>`, commit, then in a separate call with GIT_INDEX_FILE unset `git reset -q -- <paths>`. Foreign hunks in a file you edit: stage only yours via `git hash-object -w` + `git update-index --cacheinfo`.
- Commit trailer exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The pen's drag state must stay reactive to overlay computeds: every write to `pathDrag` goes through `setPathDrag` / `pathDragTick` (see usePen). Any new drag/hover state read by overlay computeds must be a ref or bump a tick.
- Tolerances are screen px converted with `pxToUnits(px, view)` (`lib/sketch/tolerance.ts`).
- Path arc segments carry the invariant `equalDist [centre, start, centre, end]` (added by `addPath`); every new arc segment you create must get it, and removing one must drop it.
- Bézier (cubic) segments are out of scope: they neither cut, nor get trimmed, nor act as snap targets.
- Unit tests: `cd frontend && npx vitest run <files>`; typecheck `npx vue-tsc --noEmit`, judged only on files you touched (the repo has a pre-existing error baseline). Pen browser specs: `npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts` (run your own new spec too).

---

### Task 1: Crossings and spans (`lib/sketch/crossings.ts`)

**Files:** Create `frontend/app/lib/sketch/crossings.ts`, `frontend/tests/unit/sketch-crossings.unit.spec.ts`.

**Interfaces (produces):**
```ts
export type CurveRef = { kind: 'line'; id: EntityId } | { kind: 'circle'; id: EntityId } | { kind: 'seg'; pathId: EntityId; segIndex: number }
export interface CurveGeom { ref: CurveRef; kind: 'line' | 'arc' | 'circle'; a?: Vec2; b?: Vec2; c?: Vec2; r?: number; a0?: number; sweepAngle?: number /* signed */ }
export function curveGeom(doc: SketchDoc, ref: CurveRef): CurveGeom | null         // null for cubic / missing
export function allCurves(doc: SketchDoc): CurveRef[]                                // lines, circles, line+arc path segments
export function pointAt(g: CurveGeom, t: number): Vec2
export function paramOf(g: CurveGeom, p: Vec2): number                              // nearest-point parameter, clamped to extent
export function nearestCurve(doc: SketchDoc, p: Vec2, tol: number): { ref: CurveRef; t: number; dist: number } | null
export interface Crossing { t: number; point: Vec2; cutter: CurveRef; cutterT: number }
export function crossingsOn(doc: SketchDoc, ref: CurveRef): Crossing[]             // sorted by t, excludes shared-anchor joints with own-path neighbours
export interface SpanEnd { t: number; point: Vec2; cutter: CurveRef | null; cutterT?: number }  // cutter null = the curve's own end
export interface Span { ref: CurveRef; start: SpanEnd; end: SpanEnd; wraps?: boolean }          // circles: may wrap past 2π
export function spanAt(doc: SketchDoc, ref: CurveRef, t: number): Span | null
```
Parameters exactly as the spec (lines/segments 0→1, circles angle 0→2π from +x, arcs 0→1 along the sweep). Arc sweep direction must match `sketchPath.ts`'s `pathD` convention for that segment (read it).

- [ ] Write failing tests: line–line crossing (and parallel = none, out-of-extent = none); line–circle two points / tangent one / miss; circle–circle two / tangent / none / concentric; arc restricted to its sweep (both sweep values); a path's own neighbouring segments at their shared anchor are NOT crossings but a non-neighbour segment of the same path crossing IS; `spanAt` on a line crossed twice returns the middle piece with both cutters; on a circle crossed at 2 points returns the arc containing t (test wrap across 0/2π); no crossings → span is the whole curve with null cutters; a cubic segment → `curveGeom` null and never appears in crossings.
- [ ] Run → fail. Implement. Run → pass. Typecheck the file.
- [ ] Commit `feat(sketch): crossings and spans between lines, circles and path arcs`.

### Task 2: Trim, Cut, Dissolve, merge — topology (`lib/sketch/trim.ts`)

**Files:** Create `frontend/app/lib/sketch/trim.ts`, `frontend/tests/unit/sketch-trim.unit.spec.ts`. Read `lib/sketch/edit.ts` (addPath, deleteEntity, isPointReferenced) and reuse.

**Interfaces (produces):**
```ts
export interface TrimResult { ok: boolean; droppedRules: number }
export function pinToCurve(doc: SketchDoc, p: EntityId, cutter: CurveRef, at: Vec2): EntityId   // returns the point id actually used (reuses a cutter anchor when the crossing is on it, else adds the rule from the spec and returns p)
export function removeSpan(doc: SketchDoc, span: Span): TrimResult
export function removeSegment(doc: SketchDoc, pathId: EntityId, segIndex: number): TrimResult  // whole segment: open → split into ≤2 paths; closed → reopen after the gap
export function cutAt(doc: SketchDoc, ref: CurveRef, t: number): EntityId | null               // new anchor id; null when not allowed (circle, cubic)
export function canDissolve(doc: SketchDoc, pathId: EntityId, anchorIndex: number, tolUnits: number, tolDeg: number): boolean
export function dissolveAt(doc: SketchDoc, pathId: EntityId, anchorIndex: number, tolUnits: number, tolDeg: number): boolean
export function mergePoints(doc: SketchDoc, from: EntityId, into: EntityId): void              // spec §"Drag onto something": references rewired, degenerate rules/lines/segments dropped, ends-merged path becomes closed
```
Behaviour exactly per spec §Stage 1 "What removing a piece does" and §Stage 3 merging (circles → open arc path with rule remapping; new ends pinned to cutters; surviving ids kept; dropped rules counted). New points take the crossing position.

- [ ] Failing tests, one per case: line whole / one end / interior; path line segment interior of an open path (→ two paths), end segment (→ shorter path), only segment (→ path deleted); closed path segment (→ one open path, correct anchor order, arc invariants intact); arc segment split keeps shared centre, sweep, and adds invariants for both halves (run `solve` afterwards and assert geometry unchanged within 1e-6); circle with 2 crossings → one-arc open path, `pointOnCircle` remapped to `equalDist`, tangent rule dropped and counted; circle with 0/1 crossings → deleted; new end pinned with the right rule kind for each cutter kind (line, circle, path line seg → collinear, path arc seg → equalDist) and reuse of a cutter anchor when the crossing is on it; `cutAt` on line seg / arc seg / line entity leaves the drawing unchanged after `solve`; `dissolveAt` merges collinear lines and same-centre arcs and refuses a corner; `mergePoints` rewires a line end, a path anchor, a constraint ref, drops `coincident[a,a]`, deletes a line collapsed to one point, and closes a path whose two ends merge.
- [ ] Run → fail. Implement. Run → pass (plus the existing `tests/unit/pen-*.unit.spec.ts` and `sketch-*` specs). Typecheck.
- [ ] Commit `feat(sketch): trim a piece between crossings, cut, dissolve, merge points`.

### Task 3: Trim, Cut and Dissolve tools in the pen

**Files:** Modify `composables/pen/usePen.ts`, `components/pen/PenOverlay.vue`, `components/pen/PenToolbar.vue`, `composables/pen/penKeys.ts`, `composables/frame/useFramePenSession.ts` (FRAME_PEN_TOOLS gains 'trim','cut','dissolve'; GUIDE_PEN_TOOLS gains 'trim','cut','dissolve'), `composables/geoshape/useShapePenSession.ts` (SHAPE_PEN_TOOLS gains them), `pages/dev/sketch-draw.vue` if it lists tools. Tests: `tests/unit/pen-trim.unit.spec.ts`, new Playwright `tests/pen-trim.spec.ts`.

**Consumes:** Task 1 `nearestCurve`, `spanAt`; Task 2 `removeSpan`, `removeSegment`, `cutAt`, `dissolveAt`, `canDissolve`.

**Produces:** `PenTool` gains `'trim' | 'cut' | 'dissolve'`; pen exposes `trimHover` (ref: `Span | null`), `trimGhosts` (ref: array of SVG path d strings in drawing space), `trimDown/trimMove/trimUp(x,y)`, `cutClick(x,y)`, `dissolveClick(x,y)`, and `status` messages ("Removed 2 rules with that piece", "Cut works on a path's lines and arcs", "These two sides don't line up, so they can't merge"). `del()` also removes `selectedSegments` via `removeSegment` (highest index first per path), and the toolbar shows Delete when only segments are selected.

- Hover (no button): `nearestCurve` within `pxToUnits(SNAP_PX)`; `trimHover = spanAt(...)`. Overlay draws it in drawing space thick (≈4 px, non-scaling), tinted `#ef4444` at ~0.55 opacity, with a 4 px ring at each non-null cutter end; `data-trim-hover`. Nothing for cubic segments.
- Press: remove the hovered span (if any), record its drawing-space d into `trimGhosts`; while pressed, every pointermove re-hovers and removes the span under the pointer; history: ONE entry for the whole press→release (commit on release; follow the existing commitHistory/lazy history pattern). Ghosts: dotted, 1 px, 35 % opacity, `data-trim-ghost`, cleared on tool change/Escape/session end.
- Cut/Dissolve: click only; Dissolve targets the nearest path anchor within snap radius that is interior; hover highlights the target (anchor ring / the insertion point on the curve).
- Keys (only when no modifier and not typing, and the host offers the tool): T trim, C cut, D dissolve. Escape in Trim clears ghosts then falls back as today.
- Toolbar: three buttons after Point, icons from lucide (`Scissors`, `Slice` or `SplitSquareVertical` for cut, `Bandage` for dissolve — pick what exists in the installed lucide-vue-next), keep `aria-label`; hints: Trim "Click a piece between crossings to remove it, or sweep across several", Cut "Click a line or arc to add a point there", Dissolve "Click a point between two pieces that line up to merge them".
- [ ] Failing unit tests through `usePen` (the style of `tests/unit/pen-use-pen.unit.spec.ts`): hover sets `trimHover` on the right span; a press+moves+release across two pieces removes both and `undo()` restores both in one step; cut then dissolve round-trips; Delete removes an Option-selected segment; tools absent from options ignore keys.
- [ ] Implement. Unit tests pass. Write `tests/pen-trim.spec.ts` with REAL `page.mouse` on `/dev/sketch-draw` (see `tests/sketch-draw.spec.ts` for page hooks `window.__sketchDraw`, `[data-ready]`): build two overlapping circles and a line across them via the hooks, select the Trim tool by pressing T, hover a piece and assert `[data-trim-hover]`, click to remove (entity/segment count changes), sweep across two pieces, ⌘Z once restores both, cut a line segment and dissolve it back. Run it plus the three existing pen specs.
- [ ] Commit `feat(pen): Trim, Cut and Dissolve tools — remove pieces between crossings`.

### Task 4: Tooltip cards and tool shortcuts

**Files:** Create `components/pen/PenTipCard.vue`, `composables/pen/penTips.ts` (content table), `composables/pen/penTipDemos.ts` (scripted demo drawings), `tests/unit/pen-tips.unit.spec.ts`. Modify `components/pen/PenToolbar.vue`, `composables/pen/penKeys.ts`. Read `components/ui/tooltip/*` and use it (TooltipProvider with ~350 ms delay and ~600 ms skip-delay warm-up).

**Produces:** `PEN_TIPS: Record<string, { name: string; key?: string; caption: string; demo?: string }>` keyed by button id (tool ids, 'guide', 'labels', 'undo', 'redo', 'close', 'finish', 'done', 'cancel', every rule kind the rules row can show, 'fix', 'repeat', 'mirror', 'flip-h', 'flip-v', 'construction', 'delete'); `PEN_TIP_DEMOS: Record<string, (t: number) => { doc: SketchDoc; cursor: Vec2; pressed: boolean; sparkle?: Vec2 }>` for the nine tools (select, path, curve, line, circle, point, trim, cut, dissolve), t ∈ [0,1) looping over ~2.4 s.

- Card: name + `<kbd>` badge + caption; demo tools add a ~160×96 SVG (theme-aware colours) that renders `sketchPathData(frame.doc)` plus a cursor arrow (filled when pressed) and a sparkle; it animates with rAF only while the card is open. Sentence-case captions, e.g. Pen "Click to place a point, press on it and drag to bend the last piece into an arc."; Trim "Click a piece between crossings to remove it, or sweep across several."; Coincident "Joins two points into one, or pins a point onto a curve."
- Every toolbar button (tools, toggles, undo/redo, Close, Finish, Done, Cancel, each rules-row button) is wrapped with the card; remove `title=` attributes there, keep `aria-label` (add one to rules-row buttons).
- Shortcuts in `penKeys.ts`: V select, P path, B curve, L line, O circle, N point (T/C/D from Task 3), only when no modifier, not typing, the host offers the tool; they call `selectTool`.
- [ ] Failing tests: every button id the toolbar can render has a tip with a non-empty caption in sentence case (first letter upper, no `_`/camelCase identifiers); each demo function returns a doc that `sketchPathData` renders non-empty at t = 0, 0.5, 0.9; key handling selects tools and ignores keys with a modifier or when the tool is not offered.
- [ ] Implement; tests pass; extend `tests/pen-trim.spec.ts` (or a new `tests/pen-tips.spec.ts`) with a real hover over the Pen button asserting the card text and that its demo SVG contains a path, and pressing P/T switching tools. Run the pen specs.
- [ ] Commit `feat(pen): tooltip cards with shortcuts and animated demos on every button`.

### Task 5: Snapping onto arcs, segments and midpoints, with the ⊙ preview

**Files:** Modify `lib/sketch/infer.ts` (`snapPoint`, `PointSnap`), `composables/pen/usePen.ts` (`placePoint`, `hoverSnap`), `components/pen/PenOverlay.vue`. Tests: extend `tests/unit/sketch-*` or add `tests/unit/sketch-snap.unit.spec.ts`, plus `pen-*` unit coverage.

**Produces:** `PointSnap.kind` gains `'midpoint' | 'onSegment'`; a snap carries what `placePoint` needs to write the rule (`targetId` for points/lines/circles; `{ pathId, segIndex }` for segments; `{ a, b }` for midpoints). Priority point > midpoint > curve, then nearest; lines clamped to their ends; path line segments (`collinear [A,B,p]`) and path arc segments (`equalDist [C,p,C,A]`) clamped to their extent; cubic segments ignored. `hoverSnap` returns `{ x, y, kind }`.

- Overlay: a chip at the hover snap spot with **⊙** (point), a midpoint glyph (e.g. "½"-free: use a short bar with a centre tick drawn in SVG, or the text "mid" — pick an SVG glyph, not an identifier), or an on-curve glyph (a dot on a short arc); `data-snap-preview` with `data-snap-kind`. It replaces the glow ring when a snap exists; the glow stays for a press with no snap.
- [ ] Failing tests: snap to a path arc segment point writes `equalDist [C,p,C,A]` and `solve` keeps it on the arc when the arc's centre moves; path line segment → `collinear`; line entity projection outside its ends does NOT snap; midpoint beats curve at the middle; point beats midpoint; cubic ignored; `hoverSnap.kind` values.
- [ ] Implement; tests pass; update any existing test that relied on infinite-line snapping (note it in the report). Commit `feat(pen): snap onto arcs, segments and midpoints, with a preview of the join`.

### Task 6: Join by dragging, Coincident merges, point + segment rules

**Files:** Modify `composables/pen/usePen.ts`, `components/pen/PenOverlay.vue`, `composables/pen/penRules.ts`. Tests: `tests/unit/pen-weld.unit.spec.ts`; extend the Playwright spec.

**Consumes:** Task 2 `mergePoints`; Task 5 snapping.

- Select-tool drag of a single point: during the drag show the Task-5 preview for points and curves (exclude the dragged point, points already merged with it, and curves that use it as an end or centre); on release: onto a point → `mergePoints(doc, dragged, target)`; onto a curve → pin with the curve's rule; sparkle; one history entry for the drag. ⌘/Ctrl held → no snapping, no join.
- `availableConstraints`: two points → "Coincident" now merges (the first selected stays put); keep "Distance…". One point + one path segment (selection + selectedSegments together) → "On curve" (+ "Midpoint" for a line segment). Allow keeping entity selection when Option-clicking a segment and vice versa for this pairing (read how selection/selectedSegments clear each other today and change it minimally).
- [ ] Failing tests: drag an open path's end onto its start → one closed path; drag an end onto an arc segment → `equalDist` rule and it slides with the arc; drag with ⌘ → no join; Coincident on two points → one point, references rewired; point + arc segment → On curve adds `equalDist`.
- [ ] Implement; tests pass; extend the Playwright spec with a real drag of an end onto an arc and onto a point. Commit `feat(pen): drop a point onto a point or curve to join it; Coincident merges`.

### Task 7: Point looks and on-screen radius labels

**Files:** Modify `components/pen/PenOverlay.vue` (+ a small pure helper, e.g. `lib/sketch/pointRoles.ts` with `pointRole(doc, id): 'joint' | 'end' | 'centre' | 'free'`), tests `tests/unit/sketch-point-roles.unit.spec.ts`.

- Joint (referenced as anchor/endpoint by ≥2 pieces, or an interior anchor, or a T-junction via an on-curve rule) → small solid dot (r≈3); loose end → hollow square (≈7 px); arc/circle centre → hollow circle; construction points unchanged; selected/hover states keep working; hit areas unchanged (keep an invisible hit circle at today's radius). `data-point-role` attribute.
- Clamp arc radius chips (`arcDims`) and constraint badges inside the overlay: x ∈ [4, width − chipWidth − 4], y ∈ [16, height − 4].
- [ ] Failing tests for `pointRole`; implement; overlay change; run the pen unit specs and the three pen Playwright specs (they select points by `data-point` — keep that attribute on the element that receives pointer events). Commit `feat(pen): joined points read as dots, loose ends as squares; labels stay on screen`.

### Task 8: Record it

**Files:** `docs/STATE.md` (new top entry "The pen — trim, tooltip cards, coincident (stages 1–3)" in the style of the shared-pen entries: what you can do, what was proven, known limits, commits), spec status line → "Stages 1–3 built".

- [ ] Write and commit `docs(pen): stages 1–3 built — trim, tooltip cards, coincident`.
