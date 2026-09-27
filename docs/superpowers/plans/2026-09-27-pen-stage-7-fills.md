# The pen, stage 7 — fills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Fill** tool (key **G**, bucket icon) in the shared pen: hovering hatches the area the drawing encloses under the pointer, a click fills it, a click on a filled area empties it; fills are stored by a seed on one of their area's edges, so they follow drags, a split keeps both halves filled, a merge keeps one fill, an opened area sleeps with a gap marker until it closes again; the filled areas leave the pen as one closed outline with true arcs — the Frame's path layer fills it (`fillD`) and strokes its outline (`d`), Shape Studio's Drawn shape becomes the filled areas — and a drawing with no fills behaves and renders exactly as today.

**Architecture:** Two new pure modules in `lib/sketch/`: `faces.ts` (split every non-guide line, arc and circle at its crossings and touches — reusing `crossings.ts`'s exact intersections — bridge near-touching ends, walk the planar graph face by face with exact arc geometry, nest holes, write true-arc outlines; cached by a geometry fingerprint) and `fills.ts` (seeds ↔ faces, the Fill tool's click, the outline out, the gap markers, `reconcileFills` which carries fills across any edit, and the seed moves the renaming edits need). `SketchDoc` gains two optional fields (`fills`, `fillGap`); `clone.ts`, `merge.ts`, `trim.ts` (Cut / Dissolve / merging points), `edit.ts` (Repeat / Mirror) and `clipboard.ts` (Copy / Paste) carry them. The shared pen gets the tool (`usePen`: hover, click, and a fill settle inside every commit; `penKeys`: G; `penCopies`: Flip), the overlay draws filled areas, the hover hatch and the gap rings, the toolbar and the tooltip cards get the button, the card and a demo. The Frame's `PathLayer` gains `fillD` (painter, geometry effects, Morph, SVG export, shape swap, the pen session's writes); Shape Studio's `drawnPath` draws the filled areas.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, lucide-vue-next (`PaintBucket`), vitest (`tests/unit/**/*.unit.spec.ts`, happy-dom for components), Playwright against the running :3002 dev server.

**Spec:** `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — sections "Shared ground" and "Stage 7" are binding; only Stage 7 is in scope. Read both before your task. (The CAD / Zoah research reports the spec cites were not on disk when this plan was written; the plan's own rulings below stand in for them.)

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
- UI copy: sentence case, plain words, no identifiers (glyphs such as ⌘Z are fine). Explanations live in the tooltip cards (`PEN_TIPS`), not as extra text in panels. Status lines are plain words ("Filled", "Emptied", "Click inside an enclosed area").
- Screen-px thresholds go through `pxToUnits(px, view)` (`lib/sketch/tolerance.ts`) at the moment they are used — never a hard-coded drawing-unit number. The one exception is deliberate and stored: a drawing's fill gap is fixed in drawing units at its first fill (Ruling 3), so the output never depends on the zoom.
- **No new piece kinds, no new rule kinds.** Fills are not pieces: they are two optional `SketchDoc` fields (`fills`, `fillGap`). A drawing without them loads, saves, clones, solves and renders exactly as before. Do not change `solve.ts`, `residuals.ts`, `jacobian.ts`, `tangency.ts`, `pieces.ts`, `ruleCheck.ts`, `sizes.ts` or anything under `lib/sketch/cleanup/`. `trim.ts`, `edit.ts`, `clipboard.ts` change only in the hunks Task 4 lists.
- **Every gesture is one undo step:** a Fill click is `commitHistory()` once; hovering writes no step. The fill settle (Ruling 6) runs INSIDE `commitHistory`, so it never adds a step of its own, and an edit that changes nothing leaves the fills byte-identical (no dead undo step).
- **Performance (stages 4–6 lessons, binding):** measure on ONE connected drawing (~150 pieces: the 161-piece ring of Task 1) and on a symmetric grid (21 × 21 lines), never on scattered shapes. Derived data is computed on the RAW drawing (`toRaw(doc.value)`), never through Vue's deep proxies (~100× slower), and cached: faces by a geometry fingerprint (`facesFor`), overlay reads keyed by `docRevision` plus the live outline. Nothing heavy per pointermove: the Fill hover is a cached face lookup plus one point-in-polygon test; a drawing with no fills does no face work anywhere (every fill path returns early on `!fills?.length`, except the Fill tool's own hover). Budgets are in Task 1 and Task 5.
- **Trial work never goes through `onLiveChange`** (the Frame writes previews into the layer): face finding and reconciling are pure reads on copies/raw data; only real, settled or live drawing changes reach the host.
- **Stored data must survive every edit:** fill seeds are carried by stage-3 editing (Cut / Dissolve / merging points in `trim.ts`; Trim and Delete through the settle), Clean up's merges (`mergePoints`), Copy / Paste (`clipboard.ts`), Repeat / Mirror copies (`edit.ts`), Flip (`penCopies.ts`), undo / redo (the snapshots carry the fields; `cloneDoc` copies them) and a save / load (`mergeSketchDoc` validates them). Each is tested.
- **Renderless / multi-root components:** `PenToolbar` has a renderless `TooltipProvider` root and `PenOverlay` is multi-root; both keep `defineOptions({ inheritAttrs: false })` and `v-bind="$attrs"` on their real element — do not add a root or move `$attrs`.
- **Mac checks:** anything that asks "is this a Mac" uses `isApple()` from `composables/pen/penKeys.ts`, never its own `/Mac/` test.
- **`CompositorModal.vue` is heavily edited by other sessions.** This stage needs no edit there (the Frame's pen session lives in `composables/frame/useFramePenSession.ts`). If you ever find you must touch it, make only that edit and stage only your hunks (the recipe above).
- Test pen layouts at 1280 and 1024 px wide — the toolbar with its extra button must not push anything off screen or add sideways scroll.
- Real-mouse checks use `page.mouse` / `page.keyboard` / `locator.click()`, never synthetic `dispatchEvent`. `window.__sketchDraw` hooks may only set up a drawing or read state.
- Unit tests: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run <files>`. Typecheck: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -E '<your files>'` — judged only on files you touched (the repo has a pre-existing error baseline). Browser specs: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test <spec files> --project=chromium`.
- Rulings made by this plan (where the spec left a detail open) are marked **Ruling:** and are binding for the implementer.

---

## Rulings (the whole list; each task repeats the ones it needs)

1. **What bounds an area.** The drawing's non-guide lines (line entities and straight path pieces), arcs (arc path pieces) and circles. Guides (construction pieces) neither bound nor split an area. Bézier (cubic) pieces bound nothing in v1 (spec: out of scope) — a path with one is a gap there. Points bound nothing.
2. **Exactness.** Pieces are split at every crossing (`crossings.ts` intersections, exported as `intersectCurves`) and wherever a piece's end touches another piece within the weld tolerance, **1e-4 of the drawing's size** (the diagonal of its pieces' box) — invisible at any zoom, far above what a solve leaves between a trimmed end and the curve it is pinned to. An "area" smaller than a millionth of the drawing's square (a sliver where two ends cross by a hair) is not an area. Tangent touches (a circle touching a line, two arcs touching) split correctly: at an equal leaving direction the turn order uses the curvature.
3. **Near-touch.** An open end (a vertex with one edge) that stops within the drawing's **fill gap** of another point (another open end, or a place where pieces meet) — or, failing that, of a point on another piece — is bridged by a straight edge: points before pieces, nearest first, one bridge per open end. The fill gap is **6 screen px** (`FILL_GAP_PX`, Clean up's join distance) at the zoom of the drawing's FIRST fill, stored in drawing units as `SketchDoc.fillGap` so the output never depends on the zoom; it is cleared when the last fill goes. Before the first fill, the Fill tool's hover uses 6 px at the current zoom. The stroke outline `d` still shows the gap; only the fill bridges it. So the owner's trimmed flower fills petal by petal without Clean up (spec), and a gap wider than the fill gap sleeps with a marker until Clean up (or the user) closes it.
4. **Holes are nested, not even-odd.** A face is its counter-clockwise outer cycle plus the outer outlines of the drawings directly inside it. Filling the outer face does not fill a drawing inside it; that drawing's own faces fill on their own click. Outlines are written for a non-zero fill: outer cycles counter-clockwise, holes clockwise; spurs (a line poking into an area and ending there) are left out of the outline.
5. **Storage.** `SketchDoc.fills?: SketchFill[]` (`{ id, seed }`) and `SketchDoc.fillGap?: number`, both optional. A seed is `{ kind: 'line' | 'arc' | 'circle', a, b, c?, ccw?, t, side }`: the piece by its points in its own direction of travel (a line p1→p2 or a path piece anchor i→i+1; an arc also by its centre `c` and turning `ccw`; a circle by its own id in `a` and `b` and its centre `c`), `t` along it (0..1 from `a`; a circle: angle / 2π counter-clockwise from +x) and `side` (1 = the area is left of the direction of travel, −1 = right). Fill ids are `F1`, `F2`, … (their own namespace). One colour per drawing (spec).
6. **Carrying fills across an edit (`reconcileFills`, run inside every `commitHistory`).** Against the drawing as the last settled step left it: a fill whose seed still finds a bounded area keeps it; every area that takes up part of a surviving fill's old area is filled too — found by the edges they share (same piece, same side, overlapping stretch), plus, when the old area's points did not move, by an inside point — so a split fills both halves; an area holding two fills keeps the first (a merge is one fill); a fill whose area opened sleeps on an edge it still has (its own, or another edge of its old area) and is dropped only when none is left; every seed ends on its own area. A fill missing from the new drawing was emptied on purpose and never comes back. Mid-gesture (a live drag, a Trim sweep) fills resolve by their seed alone; the other half of a split fills when the gesture settles. An edit that changes nothing returns the fills exactly as they were.
7. **Edits that rename pieces carry seeds themselves.** Cut moves a seed onto the half it lies on (`splitSeeds`), Dissolve onto the merged piece (`joinSeeds`), merging points — drop-to-join, Coincident, Clean up's joins — renames it (`renameSeedPoints` inside `mergePoints`), so a SLEEPING fill (which the settle cannot re-find) survives them: Clean up joining a sleeping fill's gap wakes it. Trim and Delete of the piece holding a sleeping fill's seed drop that fill (its area is gone); a live fill whose edge is trimmed is re-seeded by the settle.
8. **Copies.** Repeat and Mirror copy a fill when every piece around its area is copied (circles by id; `fillsWithin`); the copy's seed is mapped onto the copied ids (`mapSeed`: a mirror flips the side, reflects a circle seed and flips an arc's turning; a turn rotates a circle seed). Copy / Paste do the same (a paste from another host turned upside down mirrors its seeds; the copy's fill gap comes along when the target has none). A pen that can't fill (a text guide) takes pieces without their fills. Flip (⇧H / ⇧V) turns line and circle seeds over in place before the points move; it keeps each arc's turning (existing behaviour), so an arc seed is left for the settle.
9. **Colour.** Each filled area takes the layer's fill in the Frame and the shape's fill in Shape Studio (spec). When a Frame layer gets its first filled area while its own fill paints nothing (an open drawing's style), it takes the pen's fill colour `#3b82f6` (`filledStyle`); Cancel puts the old fill back. A new drawing with a filled area gets the pen's closed style.
10. **Output.** Frame: `PathLayer.fillD` — the filled areas as ONE closed outline in LOCAL units with true arcs, written for a non-zero fill — present only when at least one area is filled; invariant `fillD === sketchFillToLocalD(sketch)`. The painter fills `fillD` (non-zero) and strokes `d` when `fillD` is present, and is exactly as before otherwise (proven by a call-log snapshot recorded BEFORE the change). Geometry effects run on both outlines; Morph drops `fillD` (the morph's outline is the whole face); the SVG export fills `fillD`; swapping in a library shape drops it with `sketch`; booleans read `d` as today (booleans on drawn shapes are out of scope). Every paint path — the editor, the card (`ArtifactFrameNode`), the layout tiles, the bake, the web export (`lib/embed/surfaces/frame.ts`) — goes through `paintLayerStack` → `drawLocalLayer` → `drawPath`, so the one painter change reaches all of them.
11. **A drawing whose fills all sleep** writes no `fillD`; the layer then shows as a drawing without fills (closed paths fill, open strokes). A layer that loses its filled areas at commit is treated like a closed drawing trimmed open (`openedStyle`): a filled drawing counts as closed (`isClosedDrawing`).
12. **Shape Studio.** A Drawn shape with a filled area IS the filled areas: `drawnPath` draws their outline, fitted by the WHOLE drawing's box (so filling never moves or resizes the shape); no area filled → the outline as today. A filled drawing counts as closed (`hasClosedOutline`), so it stays painted as a fill at commit.
13. **The tool.** Key **G** (free in `TOOL_KEYS`), lucide `PaintBucket`, after Dissolve in the tool row. The pen page, the Frame's new-drawing and reopened-layer pens and Shape Studio offer it; an open-only pen (a text guide) never does (dropped with Circle). Hover: indigo hatch over an empty area (a click fills it), red hatch over a filled one (a click empties it); nothing under the pointer → no hatch. Filled areas show as a soft indigo tint in the overlay in every tool (the pen page has no other render; in the hosts it sits over the real colour). A sleeping fill shows amber dashed rings at the open ends of its drawing nearest its seed (two at most per fill). A click on no area sets the status "Click inside an enclosed area". The hatch is drawn in screen space through a clip of the area's outline in drawing space, so its spacing holds under any zoom, rotation or mirroring.
14. **Clean up's preview** hides the fill tint and rings (the preview shows the cleaned outline only); Apply is a commit, so the settle carries fills onto the cleaned drawing.
15. **Menus.** The right-click menu, the wheel and Properties get no Fill entries (the spec lists none).
16. **Budgets** (vitest, generous for a loaded machine — measured ~9 ms / ~3 ms idle): `findFaces` ≤ 40 ms on the 161-piece ring and on the 21 × 21 grid; a cached `facesFor` ≤ 1 ms; `faceAt` ≤ 0.05 ms; a Fill hover on the ring ≤ 2 ms per move after the first.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/app/lib/sketch/crossings.ts` | export `intersectCurves` + `IntersectionPoint` (renamed from the private `intersect`) | 1 |
| `frontend/app/lib/sketch/faces.ts` (new) | pieces, splits, bridges, planar graph, faces with holes, `faceAt`, true-arc outlines, the geometry-keyed cache | 1 |
| `frontend/app/lib/sketch/model.ts` | `FillSeed`, `SketchFill`, `SketchDoc.fills?`, `SketchDoc.fillGap?` | 2 |
| `frontend/app/lib/sketch/clone.ts` | `cloneDoc` copies fills | 2 |
| `frontend/app/lib/sketch/merge.ts` | `mergeSketchDoc` validates fills | 2 |
| `frontend/app/lib/sketch/fills.ts` (new) | seeds ↔ faces, fill state, outline, gap markers, the Fill click (2); `reconcileFills` (3); seed moves for renames and copies, `fillsWithin`, `flipSeeds` (4) | 2–4 |
| `frontend/app/lib/sketch/trim.ts` | Cut / Dissolve / merging points carry seeds (three hunks) | 4 |
| `frontend/app/lib/sketch/edit.ts` | Repeat / Mirror copy fills | 4 |
| `frontend/app/lib/sketch/clipboard.ts` | Copy / Paste / resize carry fills | 4 |
| `frontend/app/composables/pen/penHistory.ts` | `current()` — the last settled drawing | 5 |
| `frontend/app/composables/pen/usePen.ts` | the `fill` tool, hover / click / view, the settle inside `commitHistory`, open-only pens | 5 |
| `frontend/app/composables/pen/penKeys.ts` | G | 5 |
| `frontend/app/composables/pen/penCopies.ts` | Flip turns seeds over | 5 |
| `frontend/app/components/pen/PenOverlay.vue` | tint, hatch, rings, Fill pointer routing | 6 |
| `frontend/app/components/pen/PenToolbar.vue` | the bucket button, the hint | 6 |
| `frontend/app/composables/pen/penTips.ts` | the Fill card | 6 |
| `frontend/app/composables/pen/penTipDemos.ts` | the Fill demo, `hatchAt` | 6 |
| `frontend/app/components/pen/PenTipCard.vue` | draws a demo's fills and hatch | 6 |
| `frontend/app/composables/useCompositorLayers.ts` | `PathLayer.fillD`, `drawPath`, geometry effects, Morph | 7 |
| `frontend/app/composables/useVectorSvg.ts` | the SVG export fills `fillD` | 7 |
| `frontend/app/lib/shapes/pathLayer.ts` | `swapShapeLayer` drops `fillD` | 7 |
| `frontend/app/lib/compositor/penFrame.ts` | `sketchFillToLocalD`, `penOutlines`, `withPenOutlines` | 7 |
| `frontend/app/composables/frame/useFramePenSession.ts` | Fill in the Frame's pens, `fillD` writes, `filledStyle`, Cancel, guides never fill | 7 |
| `frontend/app/lib/geoshape/shapes.ts` | `drawnPath` draws the filled areas | 8 |
| `frontend/app/composables/geoshape/useShapePenSession.ts` | Fill in Shape Studio's pen, `hasClosedOutline` | 8 |
| `frontend/app/pages/dev/sketch-draw.vue` | read-only `fills()` hook | 9 |
| `frontend/tests/unit/sketch-faces.unit.spec.ts` (new) | Task 1 | 1 |
| `frontend/tests/unit/sketch-fills.unit.spec.ts` (new) | Task 2 | 2 |
| `frontend/tests/unit/sketch-fills-carry.unit.spec.ts` (new) | Task 3 | 3 |
| `frontend/tests/unit/sketch-fills-edits.unit.spec.ts` (new) | Task 4 | 4 |
| `frontend/tests/unit/pen-fills.unit.spec.ts` (new) | Task 5 | 5 |
| `frontend/tests/unit/pen-overlay-fills.unit.spec.ts` (new), `pen-tips.unit.spec.ts` | Task 6 | 6 |
| `frontend/tests/unit/frame-path-fill.unit.spec.ts` (new) + its snapshot, `frame-pen-fills.unit.spec.ts` (new), `frame-pen-session.unit.spec.ts` | Task 7 | 7 |
| `frontend/tests/unit/shape-pen-fills.unit.spec.ts` (new) | Task 8 | 8 |
| `frontend/tests/pen-fills.spec.ts` (new), `frontend/tests/pen-tips.spec.ts` | real mouse, three hosts, widths | 9 |

---

### Task 1: Faces — the areas a drawing encloses (pure)

**Files:**
- Modify: `frontend/app/lib/sketch/crossings.ts` (export the intersection function)
- Create: `frontend/app/lib/sketch/faces.ts`
- Test: `frontend/tests/unit/sketch-faces.unit.spec.ts`

**Behaviour (Rulings 1–4, 16):**
- `findFaces(doc, { gap })` collects the non-guide lines, arcs and circles (never Bézier pieces, never guides), splits each at every crossing with another (`intersectCurves`) and wherever an end touches it within the weld tolerance (1e-4 of the drawing's size), clusters vertices within the tolerance, and builds half-edge pairs with exact geometry (lines; arcs by centre, radius, start angle and signed sweep; a circle with no crossing is one loop). Outgoing half-edges round each vertex are ordered counter-clockwise by leaving direction, then by signed curvature (right-turning first). Faces are walked with next(h) = the half-edge leaving h's end just clockwise of h's twin; each cycle's area is exact (½∮x dy − y dx, arcs in closed form). Per connected component the lowest-area cycle is its outline on the plane; every other cycle with area above a millionth of the drawing's square is a bounded face; a component's outline lying inside another component's face is a hole of the smallest such face.
- With `gap > 0`: open ends (degree-one vertices) are bridged (Ruling 3) and the graph is rebuilt with the bridges as straight pieces (`kind: 'bridge'`, never a seed).
- `faceAt(fs, p)` — the smallest face whose outer polygon (arcs flattened at ≤ π/32 per step) winds round p and none of whose holes does; `null` in the open.
- `facesD(fs, faceIds, scale)` — one outline: `M … L … A r r 0 large sweep … Z` per cycle (outer, then holes), spurs removed, a full-turn arc written as two halves, coordinates × scale.
- `facesFor(doc, gap)` — `findFaces` remembered for the last six geometries, keyed by `geometryKey(doc)` (a hash of every entity's kind, id, guide flag, points, radii, path anchors and segments — never the fills) plus the gap.

**Interfaces:**
- Consumes: `curveGeom`, `paramOf`, `pointAt`, `CurveGeom`, `CurveRef` from `lib/sketch/crossings.ts`; `SketchDoc`, `EntityId` from `model.ts`; `Vec2` from `geom.ts`.
- Produces: `intersectCurves(g1: CurveGeom, g2: CurveGeom): IntersectionPoint[]` and `interface IntersectionPoint { p: Vec2; tSelf: number; tOther: number }` (crossings.ts); `type FacePiece`, `facePieceKey(p): string`, `interface HalfEdge`, `interface Box`, `interface FaceCycle`, `interface Face`, `interface FaceSet`, `winding(poly, p): number`, `findFaces(doc, opts?): FaceSet`, `faceAt(fs, p): number | null`, `faceOfHalfEdge(fs, h): number | null`, `facesD(fs, faceIds, scale?): string`, `geometryKey(doc): string`, `facesFor(doc, gap?): FaceSet` (faces.ts).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-faces.unit.spec.ts`:

```ts
// tests/unit/sketch-faces.unit.spec.ts
// Pen stage 7: the areas a drawing encloses — lines, arcs and circles split
// where they cross or touch, the planar graph walked face by face with exact
// arc geometry, holes nested, guides and Bézier pieces left out, gaps
// bridged, true-arc outlines out — and fast enough on one connected drawing
// and a symmetric grid.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { findFaces, faceAt, facesD, facesFor, geometryKey } from '~/lib/sketch/faces'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function square(d: SketchDoc, x: number, y: number, s: number): string {
  const ids = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => addPoint(d, px!, py!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
/** The owner's trimmed flower from stage 5: four petal arcs round a square, each
 *  a separate open piece ending 3.2 px (at 34 px per unit) short of the next. */
function gappyFlower(d: SketchDoc) {
  const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1! + 0.08, ey = y1! + 0.05
    const s = addPoint(d, x0!, y0!), e = addPoint(d, ex, ey), c = addPoint(d, (x0! + ex) / 2, (y0! + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}

describe('faces', () => {
  it('a closed square is one face, with a straight outline', () => {
    const d = doc(); square(d, 0, 0, 4)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[0]!.area).toBeCloseTo(16, 9)
    expect(faceAt(fs, { x: 1, y: 1 })).toBe(0)
    expect(faceAt(fs, { x: 5, y: 1 })).toBeNull()
    expect(facesD(fs, [0])).toBe('M 0 0 L 4 0 L 4 4 L 0 4 L 0 0 Z')
  })
  it('two crossing circles make three faces, measured exactly; the lens is two true arcs', () => {
    const d = doc(); addCircle(d, addPoint(d, 0, 0), 2); addCircle(d, addPoint(d, 2, 0), 2)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(3)
    const lens = 2 * 4 * Math.acos(2 / 4) - Math.sqrt(16 - 4)
    expect(fs.faces.reduce((s, f) => s + f.area, 0)).toBeCloseTo(2 * Math.PI * 4 - lens, 9)
    const mid = faceAt(fs, { x: 1, y: 0 })!
    expect(fs.faces[mid]!.area).toBeCloseTo(lens, 9)
    const out = facesD(fs, [mid])
    expect((out.match(/ A /g) ?? []).length).toBe(2)
    expect(out.endsWith(' Z')).toBe(true)
  })
  it('a whole circle is one face of area πr², written as two half arcs', () => {
    const d = doc(); addCircle(d, addPoint(d, 1, 1), 3)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[0]!.area).toBeCloseTo(9 * Math.PI, 9)
    expect((facesD(fs, [0]).match(/ A /g) ?? []).length).toBe(2)
  })
  it('a circle inside a square is a hole of the square’s face, and a face of its own', () => {
    const d = doc(); square(d, 0, 0, 10); addCircle(d, addPoint(d, 5, 5), 2)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(2)
    const ring = faceAt(fs, { x: 1, y: 1 })!, disc = faceAt(fs, { x: 5, y: 5 })!
    expect(ring).not.toBe(disc)
    expect(fs.faces[ring]!.area).toBeCloseTo(100 - 4 * Math.PI, 9)
    expect(fs.faces[ring]!.holes).toHaveLength(1)
    // the ring's outline carries the hole (a second subpath)
    expect((facesD(fs, [ring]).match(/M /g) ?? []).length).toBe(2)
  })
  it('a 3 × 3 grid of open lines makes four cells', () => {
    const d = doc()
    for (let i = 0; i < 3; i++) {
      addLine(d, addPoint(d, -1, i * 2), addPoint(d, 5, i * 2))
      addLine(d, addPoint(d, i * 2, -1), addPoint(d, i * 2, 5))
    }
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(4)
    for (const f of fs.faces) expect(f.area).toBeCloseTo(4, 9)
  })
  it('guides bound nothing; Bézier pieces bound nothing', () => {
    const d = doc(); const id = square(d, 0, 0, 4)
    ;(d.entities.find(e => e.id === id) as { construction?: boolean }).construction = true
    expect(findFaces(d).faces).toHaveLength(0)
    const e = doc()
    const a = addPoint(e, 0, 0), b = addPoint(e, 4, 0), c = addPoint(e, 2, 3)
    addPath(e, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'cubic', h1: null, h2: null }], true)
    expect(findFaces(e).faces).toHaveLength(0)
  })
  it('three open lines crossing make a triangle; the ends poking out are left out of its outline', () => {
    const d = doc()
    addLine(d, addPoint(d, -1, 0), addPoint(d, 5, 0))
    addLine(d, addPoint(d, 0, -1), addPoint(d, 2.5, 5))
    addLine(d, addPoint(d, 4, -1), addPoint(d, 1.5, 5))
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect((facesD(fs, [0]).match(/ L /g) ?? []).length).toBe(3)
  })
  it('a lens of two arcs; a circle touching a D shape tangentially from inside splits it in three', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    addPath(d, [a, b], [{ kind: 'arc', center: addPoint(d, 2, -1), sweep: 1 }, { kind: 'arc', center: addPoint(d, 2, 1), sweep: 1 }], true)
    expect(findFaces(d).faces).toHaveLength(1)
    const e = doc()
    const p = addPoint(e, -2, 0), q = addPoint(e, 2, 0)
    addPath(e, [p, q], [{ kind: 'arc', center: addPoint(e, 0, 0), sweep: 0 }])
    addLine(e, p, q)
    addCircle(e, addPoint(e, 0, 1), 1)   // touches the line at (0,0) and the arc at (0,2)
    const fs = findFaces(e)
    expect(fs.faces).toHaveLength(3)
    expect(fs.faces.reduce((s, f) => s + f.area, 0)).toBeCloseTo(2 * Math.PI, 6)
  })
  it('a nearly-closed drawing is an area only when its gaps are bridged', () => {
    const d = doc(); gappyFlower(d)
    expect(findFaces(d).faces).toHaveLength(0)
    const fs = findFaces(d, { gap: 6 / 34 })
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[faceAt(fs, { x: 9, y: 5 })!]!.area).toBeGreaterThan(90)
    expect(fs.bridges.length).toBeGreaterThanOrEqual(4)
    expect(fs.dangling).toHaveLength(0)
    const tight = findFaces(d, { gap: 1 / 34 })
    expect(tight.faces).toHaveLength(0)
    expect(tight.dangling.length).toBeGreaterThanOrEqual(8)
  })
  it('faces are cached by geometry: an unchanged drawing is a lookup, a moved point is not', () => {
    const d = doc(); square(d, 0, 0, 4)
    const a = facesFor(d)
    expect(facesFor(JSON.parse(JSON.stringify(d)))).toBe(a)
    expect(facesFor(d, 0.1)).not.toBe(a)
    const k = geometryKey(d)
    ;(d.entities[0] as { x: number }).x += 1e-9
    expect(geometryKey(d)).not.toBe(k)
    expect(facesFor(d)).not.toBe(a)
  })
})

describe('faces — speed (one connected drawing, a symmetric grid)', () => {
  it('161 pieces round a ring and a 21 × 21 grid stay well inside a frame', () => {
    // 64 two-arc petals round a circle, a spoke to every other one: one connected drawing
    const d = doc()
    const O = addPoint(d, 0, 0); addCircle(d, O, 10)
    for (let k = 0; k < 64; k++) {
      const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
      const s = addPoint(d, 10 * Math.cos(a0), 10 * Math.sin(a0)), e = addPoint(d, 10 * Math.cos(a1), 10 * Math.sin(a1))
      addPath(d, [s, e], [
        { kind: 'arc', center: addPoint(d, 9 * Math.cos(am), 9 * Math.sin(am)), sweep: 1 },
        { kind: 'arc', center: addPoint(d, 14 * Math.cos(am), 14 * Math.sin(am)), sweep: 1 },
      ], true)
      if (k % 2 === 0) addLine(d, O, s)
    }
    const pieces = d.entities.reduce((n, e) => n + (e.kind === 'path' ? e.segments.length : e.kind === 'point' ? 0 : 1), 0)
    expect(pieces).toBe(161)
    findFaces(d)   // warm up
    let t = performance.now()
    const fs = findFaces(d)
    const cold = performance.now() - t
    expect(fs.faces.length).toBeGreaterThan(200)
    expect(cold).toBeLessThan(40)
    facesFor(d)
    t = performance.now(); for (let i = 0; i < 10; i++) facesFor(d); const hit = (performance.now() - t) / 10
    expect(hit).toBeLessThan(1)
    t = performance.now(); for (let i = 0; i < 100; i++) faceAt(fs, { x: 3, y: 1 }); const probe = (performance.now() - t) / 100
    expect(probe).toBeLessThan(0.05)

    const g = doc()
    for (let i = 0; i <= 20; i++) {
      addLine(g, addPoint(g, -1, i), addPoint(g, 21, i))
      addLine(g, addPoint(g, i, -1), addPoint(g, i, 21))
    }
    findFaces(g)
    t = performance.now()
    const gs = findFaces(g)
    expect(performance.now() - t).toBeLessThan(40)
    expect(gs.faces).toHaveLength(400)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-faces.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/faces"`.

- [ ] **Step 3: Export the exact intersections from `crossings.ts`** — two edits, nothing else in the file changes:
  - `interface IntersectionPoint { p: Vec2; tSelf: number; tOther: number }` → `export interface IntersectionPoint { p: Vec2; tSelf: number; tOther: number }`
  - `function intersect(g1: CurveGeom, g2: CurveGeom): IntersectionPoint[] {` → `export function intersectCurves(g1: CurveGeom, g2: CurveGeom): IntersectionPoint[] {`, and its one caller in `crossingsOn` (`for (const ip of intersect(g, g2)) {`) → `for (const ip of intersectCurves(g, g2)) {`.

- [ ] **Step 4: Create `frontend/app/lib/sketch/faces.ts`:**

```ts
// app/lib/sketch/faces.ts
// Pen stage 7, the areas a drawing encloses. The drawing's lines, arcs and
// circles (not guides, not Bézier pieces) are split at every crossing and
// wherever an end touches another piece, and the resulting planar graph is
// walked face by face with exact arc geometry: every bounded face is one
// counter-clockwise outer cycle plus the clockwise outer cycles of whatever
// drawings sit inside it (holes). `gap` (drawing units) bridges an end that
// stops short of another piece by at most that much with a straight edge, so
// a nearly-closed area still counts. Faces are cached by a fingerprint of the
// geometry (facesFor), so hover and the overlay never recompute on a frame
// where nothing moved. Pure — no Vue, no DOM.
import type { SketchDoc, EntityId } from './model'
import { getPoint } from './model'
import type { Vec2 } from './geom'
import { curveGeom, intersectCurves, paramOf, pointAt, type CurveGeom, type CurveRef } from './crossings'

const TAU = Math.PI * 2

/** One piece of the drawing that can bound an area, in its own direction of
 *  travel: a line entity p1→p2 or a straight path piece anchor i→i+1; an arc
 *  path piece anchor i→i+1 about c (ccw = sweep 1, angle increasing); a whole
 *  circle counter-clockwise from +x; or a straight bridge across a gap. */
export type FacePiece =
  | { kind: 'line'; a: EntityId; b: EntityId }
  | { kind: 'arc'; a: EntityId; b: EntityId; c: EntityId; ccw: boolean }
  | { kind: 'circle'; id: EntityId; c: EntityId }
  | { kind: 'bridge' }

/** A key naming a piece by its points, the same whichever way round it was
 *  drawn (a line by its two ends; an arc by its ends, centre and turning;
 *  a circle by its own id). */
export function facePieceKey(p: FacePiece): string {
  if (p.kind === 'line') return p.a < p.b ? `L|${p.a}|${p.b}` : `L|${p.b}|${p.a}`
  if (p.kind === 'arc') {
    const lo = p.a < p.b
    return `A|${lo ? p.a : p.b}|${lo ? p.b : p.a}|${p.c}|${(lo ? p.ccw : !p.ccw) ? 1 : 0}`
  }
  if (p.kind === 'circle') return `C|${p.id}`
  return 'B'
}

export interface HalfEdge {
  piece: number
  /** the piece's own parameter where this half-edge starts / ends (line, arc:
   *  0..1 from its start; circle: angle / 2π, may pass 1 on the wrap) */
  t0: number
  t1: number
  /** runs the piece's own way */
  forward: boolean
  from: number
  to: number
  kind: 'line' | 'arc'
  p0: Vec2
  p1: Vec2
  c?: Vec2
  r?: number
  /** arcs: start angle and signed sweep (+ = counter-clockwise, angle increasing) */
  a0?: number
  sweep?: number
  /** leaving direction and signed curvature at the start (for the turn order) */
  ang: number
  k: number
  len: number
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface FaceCycle { edges: number[]; area: number; poly: Vec2[]; box: Box; comp: number }
export interface Face { outer: number; holes: number[]; area: number; box: Box }

export interface FaceSet {
  tol: number
  pieces: FacePiece[]
  /** facePieceKey → piece index (the first piece with that key) */
  byKey: Map<string, number>
  /** each piece's half-edge pairs in parameter order: forward half-edge ids */
  pieceEdges: number[][]
  vertices: Vec2[]
  halfEdges: HalfEdge[]
  cycles: FaceCycle[]
  cycleOf: number[]
  /** the face a cycle bounds (its outer cycle, or one of its holes); null = the open plane */
  faceOfCycle: (number | null)[]
  faces: Face[]
  /** ends that stay open (no bridge reached them), and the component each vertex / piece is in */
  dangling: number[]
  vertexComp: number[]
  pieceComp: number[]
  bridges: { from: Vec2; to: Vec2 }[]
}

// ── geometry helpers ────────────────────────────────────────────────────────

const norm = (a: number) => ((a % TAU) + TAU) % TAU

function boxOf(pts: Vec2[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y }
  return { x0, y0, x1, y1 }
}
const boxHit = (b: Box, p: Vec2, pad = 0) => p.x >= b.x0 - pad && p.x <= b.x1 + pad && p.y >= b.y0 - pad && p.y <= b.y1 + pad
const boxesMeet = (a: Box, b: Box, pad: number) => a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1

// the piece's point at its own parameter (circle: u = angle / 2π)
function at(g: CurveGeom, u: number): Vec2 { return pointAt(g, g.kind === 'circle' ? u * TAU : u) }
// the piece's own parameter nearest p (circle: angle / 2π)
function paramNear(g: CurveGeom, p: Vec2): number { const t = paramOf(g, p); return g.kind === 'circle' ? t / TAU : t }
function geomBox(g: CurveGeom): Box {
  if (g.kind === 'line') return boxOf([g.a!, g.b!])
  const c = g.c!, r = g.r!
  return { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }
}

/** Winding number of a closed polygon around p (non-zero = inside). */
export function winding(poly: Vec2[], p: Vec2): number {
  let w = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    if (a.y <= p.y) { if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++ }
    else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--
  }
  return w
}

// ── the pieces ──────────────────────────────────────────────────────────────

interface Src { piece: FacePiece; g: CurveGeom; box: Box }

function collectPieces(doc: SketchDoc): Src[] {
  const out: Src[] = []
  const push = (piece: FacePiece, ref: CurveRef) => {
    const g = curveGeom(doc, ref)
    if (g) out.push({ piece, g, box: geomBox(g) })
  }
  for (const e of doc.entities) {
    if (e.construction) continue
    if (e.kind === 'line') push({ kind: 'line', a: e.p1, b: e.p2 }, { kind: 'line', id: e.id })
    else if (e.kind === 'circle') push({ kind: 'circle', id: e.id, c: e.center }, { kind: 'circle', id: e.id })
    else if (e.kind === 'path') {
      const n = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < n; i++) {
        const s = e.segments[i]
        if (!s || s.kind === 'cubic') continue
        const a = e.anchors[i]!, b = e.anchors[(i + 1) % e.anchors.length]!
        push(s.kind === 'arc' ? { kind: 'arc', a, b, c: s.center, ccw: s.sweep === 1 } : { kind: 'line', a, b }, { kind: 'seg', pathId: e.id, segIndex: i })
      }
    }
  }
  return out
}

/** The weld tolerance: 1e-4 of the drawing's size — invisible at any zoom,
 *  well above what a solve leaves between a pinned end and its curve. */
function weldTol(srcs: Src[]): number {
  if (!srcs.length) return 1e-9
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of srcs) { x0 = Math.min(x0, s.box.x0); y0 = Math.min(y0, s.box.y0); x1 = Math.max(x1, s.box.x1); y1 = Math.max(y1, s.box.y1) }
  return Math.max(1e-9, 1e-4 * Math.hypot(x1 - x0, y1 - y0))
}

// ── the graph ───────────────────────────────────────────────────────────────

interface Graph {
  vertices: Vec2[]
  halfEdges: HalfEdge[]
  pieceEdges: number[][]
  out: number[][]
}

function edgeLen(h: Pick<HalfEdge, 'kind' | 'p0' | 'p1' | 'r' | 'sweep'>): number {
  return h.kind === 'line' ? Math.hypot(h.p1.x - h.p0.x, h.p1.y - h.p0.y) : Math.abs(h.sweep!) * h.r!
}

function buildGraph(srcs: Src[], params: number[][], bridges: { from: Vec2; to: Vec2 }[], tol: number): Graph {
  const vertices: Vec2[] = []
  const grid = new Map<string, number[]>()
  const cell = (x: number) => Math.floor(x / tol)
  function vid(p: Vec2): number {
    const cx = cell(p.x), cy = cell(p.y)
    let best = -1, bd = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = Math.hypot(vertices[i]!.x - p.x, vertices[i]!.y - p.y)
        if (d <= tol && d < bd) { bd = d; best = i }
      }
    }
    if (best >= 0) return best
    vertices.push({ x: p.x, y: p.y })
    const k = `${cx},${cy}`
    const list = grid.get(k)
    if (list) list.push(vertices.length - 1); else grid.set(k, [vertices.length - 1])
    return vertices.length - 1
  }
  const halfEdges: HalfEdge[] = []
  const pieceEdges: number[][] = []
  function addPair(piece: number, g: CurveGeom | null, u0: number, u1: number, p0: Vec2, p1: Vec2): number | null {
    const from = vid(p0), to = vid(p1)
    let fwd: Omit<HalfEdge, 'from' | 'to' | 'len' | 'ang' | 'k'>
    let back: Omit<HalfEdge, 'from' | 'to' | 'len' | 'ang' | 'k'>
    if (!g || g.kind === 'line') {
      if (from === to) return null
      fwd = { piece, t0: u0, t1: u1, forward: true, kind: 'line', p0, p1 }
      back = { piece, t0: u1, t1: u0, forward: false, kind: 'line', p0: p1, p1: p0 }
    } else {
      const c = g.c!, r = g.r!
      const sweepAll = g.kind === 'circle' ? TAU : g.sweepAngle!
      const a0 = g.kind === 'circle' ? u0 * TAU : g.a0! + sweepAll * u0
      const sweep = g.kind === 'circle' ? (u1 - u0) * TAU : sweepAll * (u1 - u0)
      if (Math.abs(sweep) * r <= tol && from === to) return null
      fwd = { piece, t0: u0, t1: u1, forward: true, kind: 'arc', p0, p1, c, r, a0, sweep }
      back = { piece, t0: u1, t1: u0, forward: false, kind: 'arc', p0: p1, p1: p0, c, r, a0: a0 + sweep, sweep: -sweep }
    }
    const h = halfEdges.length
    for (const [e, f, t] of [[fwd, from, to], [back, to, from]] as const) {
      const ang = e.kind === 'line' ? norm(Math.atan2(e.p1.y - e.p0.y, e.p1.x - e.p0.x)) : norm(e.a0! + (e.sweep! > 0 ? Math.PI / 2 : -Math.PI / 2))
      const k = e.kind === 'line' ? 0 : Math.sign(e.sweep!) / e.r!
      halfEdges.push({ ...e, from: f, to: t, ang, k, len: 0 })
    }
    halfEdges[h]!.len = halfEdges[h + 1]!.len = edgeLen(halfEdges[h]!)
    return h
  }
  srcs.forEach((s, i) => {
    const g = s.g
    const list: number[] = []
    // parameters sorted, points closer than tol collapsed into one
    const ps = [...params[i]!].sort((x, y) => x - y)
    const uniq: number[] = []
    for (const u of ps) {
      const prev = uniq[uniq.length - 1]
      if (prev == null) { uniq.push(u); continue }
      const d = Math.hypot(at(g, u).x - at(g, prev).x, at(g, u).y - at(g, prev).y)
      if (d > tol) uniq.push(u)
      else if (u === 1 && g.kind !== 'circle') uniq[uniq.length - 1] = 1   // a piece's own end wins
    }
    if (g.kind === 'circle') {
      if (uniq.length > 1) {
        const first = uniq[0]!, last = uniq[uniq.length - 1]!
        if (Math.hypot(at(g, first).x - at(g, last).x, at(g, first).y - at(g, last).y) <= tol) uniq.pop()
      }
      const cuts = uniq.length ? uniq : [0]
      for (let j = 0; j < cuts.length; j++) {
        const u0 = cuts[j]!, u1 = j + 1 < cuts.length ? cuts[j + 1]! : cuts[0]! + 1
        const h = addPair(i, g, u0, u1, at(g, u0), at(g, u1))
        if (h != null) list.push(h)
      }
    } else {
      for (let j = 0; j + 1 < uniq.length; j++) {
        const u0 = uniq[j]!, u1 = uniq[j + 1]!
        const h = addPair(i, g, u0, u1, at(g, u0), at(g, u1))
        if (h != null) list.push(h)
      }
    }
    pieceEdges.push(list)
  })
  for (const b of bridges) {
    const pi = pieceEdges.length
    pieceEdges.push([])
    const h = addPair(pi, null, 0, 1, b.from, b.to)
    if (h != null) pieceEdges[pi]!.push(h)
  }
  // outgoing half-edges round each vertex, counter-clockwise; at an equal
  // leaving direction the one turning right comes first
  const out: number[][] = vertices.map(() => [])
  halfEdges.forEach((h, i) => out[h.from]!.push(i))
  for (const list of out) {
    list.sort((i, j) => {
      const a = halfEdges[i]!, b = halfEdges[j]!
      let d = a.ang - b.ang
      if (Math.abs(d) < 1e-9 || Math.abs(Math.abs(d) - TAU) < 1e-9) d = 0
      return d !== 0 ? d : a.k - b.k || i - j
    })
  }
  return { vertices, halfEdges, pieceEdges, out }
}

// ── crossings and touches ───────────────────────────────────────────────────

function splitParams(srcs: Src[], tol: number): number[][] {
  const params = srcs.map(s => (s.g.kind === 'circle' ? [] : [0, 1]))
  for (let i = 0; i < srcs.length; i++) {
    for (let j = i + 1; j < srcs.length; j++) {
      const A = srcs[i]!, B = srcs[j]!
      if (!boxesMeet(A.box, B.box, tol)) continue
      for (const ip of intersectCurves(A.g, B.g)) {
        params[i]!.push(A.g.kind === 'circle' ? norm(ip.tSelf) / TAU : ip.tSelf)
        params[j]!.push(B.g.kind === 'circle' ? norm(ip.tOther) / TAU : ip.tOther)
      }
    }
  }
  // an end that touches another piece (a trimmed end pinned onto it, a
  // T-junction the float maths just missed) splits that piece there
  const ends: Vec2[] = []
  for (const s of srcs) if (s.g.kind !== 'circle') ends.push(s.g.a!, s.g.b!)
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i]!
    for (const e of ends) {
      if (!boxHit(s.box, e, tol)) continue
      const u = paramNear(s.g, e)
      const q = at(s.g, u)
      if (Math.hypot(q.x - e.x, q.y - e.y) <= tol) params[i]!.push(u)
    }
  }
  return params
}

// ── gap bridges ─────────────────────────────────────────────────────────────

function findBridges(srcs: Src[], gr: Graph, gap: number, tol: number): { params: { piece: number; u: number }[]; bridges: { from: Vec2; to: Vec2 }[] } {
  const V = gr.vertices
  const deg = V.map((_, v) => gr.out[v]!.length)
  const ends = V.map((_, v) => v).filter(v => deg[v] === 1)
  type Cand = { v: number; d: number; to: Vec2; end?: number; piece?: number; u?: number }
  const cands: Cand[] = []
  for (const v of ends) {
    const P = V[v]!
    const own = gr.halfEdges[gr.out[v]![0]!]!
    // another open end, or a vertex where pieces already meet
    V.forEach((Q, w) => {
      if (w === v || deg[w] === 0) return
      const d = Math.hypot(Q.x - P.x, Q.y - P.y)
      if (d > gap || d <= tol) return
      if (w === own.to && deg[w] === 1) return   // the other end of one short piece
      cands.push({ v, d, to: Q, ...(deg[w] === 1 ? { end: w } : {}) })
    })
    // or the nearest point on a piece (not the edge it ends)
    srcs.forEach((s, i) => {
      if (!boxHit(s.box, P, gap)) return
      const u = paramNear(s.g, P)
      const q = at(s.g, u)
      const d = Math.hypot(q.x - P.x, q.y - P.y)
      if (d > gap || d <= tol) return
      if (i === own.piece && u >= Math.min(own.t0, own.t1) - 1e-9 && u <= Math.max(own.t0, own.t1) + 1e-9) return
      cands.push({ v, d, to: q, piece: i, u })
    })
  }
  // points first (another open end, a corner), then points on pieces;
  // nearest first within each; each open end takes one bridge, and an end
  // reached by another end's bridge is closed by it
  cands.sort((x, y) => (x.piece != null ? 1 : 0) - (y.piece != null ? 1 : 0) || x.d - y.d)
  const used = new Set<number>()
  const params: { piece: number; u: number }[] = []
  const bridges: { from: Vec2; to: Vec2 }[] = []
  for (const c of cands) {
    if (used.has(c.v) || (c.end != null && used.has(c.end))) continue
    used.add(c.v)
    if (c.end != null) used.add(c.end)
    if (c.piece != null) params.push({ piece: c.piece, u: c.u! })
    bridges.push({ from: V[c.v]!, to: c.to })
  }
  return { params, bridges }
}

// ── faces ───────────────────────────────────────────────────────────────────

function flatten(h: HalfEdge, pts: Vec2[]): void {
  if (h.kind === 'line') { pts.push(h.p1); return }
  const n = Math.max(1, Math.ceil(Math.abs(h.sweep!) / (Math.PI / 32)))
  for (let i = 1; i <= n; i++) {
    const a = h.a0! + (h.sweep! * i) / n
    pts.push({ x: h.c!.x + h.r! * Math.cos(a), y: h.c!.y + h.r! * Math.sin(a) })
  }
}

// ½∮(x dy − y dx) along one half-edge, exact for arcs
function areaPart(h: HalfEdge): number {
  if (h.kind === 'line') return 0.5 * (h.p0.x * h.p1.y - h.p0.y * h.p1.x)
  const { x: cx, y: cy } = h.c!, r = h.r!, f0 = h.a0!, f1 = h.a0! + h.sweep!
  return 0.5 * (r * r * h.sweep! + r * (cx * (Math.sin(f1) - Math.sin(f0)) - cy * (Math.cos(f1) - Math.cos(f0))))
}

/** Every area the drawing encloses. `gap`: bridge ends that stop at most this
 *  far (drawing units) short of another piece. */
export function findFaces(doc: SketchDoc, opts: { gap?: number } = {}): FaceSet {
  const srcs = collectPieces(doc)
  const tol = weldTol(srcs)
  const params = splitParams(srcs, tol)
  let gr = buildGraph(srcs, params, [], tol)
  let bridges: { from: Vec2; to: Vec2 }[] = []
  const gap = opts.gap ?? 0
  if (gap > tol) {
    const found = findBridges(srcs, gr, gap, tol)
    if (found.bridges.length) {
      for (const p of found.params) params[p.piece]!.push(p.u)
      bridges = found.bridges
      gr = buildGraph(srcs, params, bridges, tol)
    }
  }
  const { vertices, halfEdges, pieceEdges, out } = gr
  const pieces: FacePiece[] = [...srcs.map(s => s.piece), ...bridges.map(() => ({ kind: 'bridge' as const }))]
  const byKey = new Map<string, number>()
  pieces.forEach((p, i) => { if (p.kind !== 'bridge') { const k = facePieceKey(p); if (!byKey.has(k)) byKey.set(k, i) } })

  // components (union-find over vertices)
  const parent = vertices.map((_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]! } return x }
  for (let h = 0; h < halfEdges.length; h += 2) { const a = find(halfEdges[h]!.from), b = find(halfEdges[h]!.to); if (a !== b) parent[a] = b }
  const vertexComp = vertices.map((_, i) => find(i))
  const pieceComp = pieceEdges.map(list => (list.length ? vertexComp[halfEdges[list[0]!]!.from]! : -1))

  // walk: next(h) = the half-edge leaving h's end just clockwise of h's twin
  const pos = new Map<number, number>()
  out.forEach(list => list.forEach((h, i) => pos.set(h, i)))
  const next = (h: number): number => {
    const t = h ^ 1
    const list = out[halfEdges[t]!.from]!
    return list[(pos.get(t)! - 1 + list.length) % list.length]!
  }
  const cycleOf = new Array<number>(halfEdges.length).fill(-1)
  const cycles: FaceCycle[] = []
  for (let s = 0; s < halfEdges.length; s++) {
    if (cycleOf[s] !== -1) continue
    const edges: number[] = []
    let h = s, guard = 0
    while (cycleOf[h] === -1 && guard++ <= halfEdges.length) { cycleOf[h] = cycles.length; edges.push(h); h = next(h) }
    let area = 0
    const poly: Vec2[] = [halfEdges[edges[0]!]!.p0]
    for (const e of edges) { area += areaPart(halfEdges[e]!); flatten(halfEdges[e]!, poly) }
    poly.pop()
    cycles.push({ edges, area, poly, box: boxOf(poly), comp: vertexComp[halfEdges[s]!.from]! })
  }

  // bounded faces: counter-clockwise cycles with area; each component's
  // lowest-area cycle is its outline on the plane
  // an area smaller than a millionth of the drawing's square (a sliver where
  // two ends cross by a hair) is not an area
  const areaEps = 100 * tol * tol
  const faceOfCycle: (number | null)[] = cycles.map(() => null)
  const faces: Face[] = []
  const outerOfComp = new Map<number, number>()
  cycles.forEach((c, i) => {
    const o = outerOfComp.get(c.comp)
    if (o == null || c.area < cycles[o]!.area) outerOfComp.set(c.comp, i)
  })
  cycles.forEach((c, i) => {
    if (outerOfComp.get(c.comp) === i || !(c.area > areaEps)) return
    faceOfCycle[i] = faces.length
    faces.push({ outer: i, holes: [], area: c.area, box: c.box })
  })
  // a component inside another's face is a hole of the smallest such face
  for (const [comp, oi] of outerOfComp) {
    const oc = cycles[oi]!
    const e0 = halfEdges[oc.edges[0]!]!
    const probe = e0.kind === 'line' ? { x: (e0.p0.x + e0.p1.x) / 2, y: (e0.p0.y + e0.p1.y) / 2 } : at({ kind: 'circle', c: e0.c!, r: e0.r! } as CurveGeom, norm(e0.a0! + e0.sweep! / 2) / TAU)
    let best: number | null = null
    faces.forEach((f, fi) => {
      if (cycles[f.outer]!.comp === comp || !boxHit(f.box, probe)) return
      if (winding(cycles[f.outer]!.poly, probe) === 0) return
      if (best == null || f.area < faces[best]!.area) best = fi
    })
    if (best != null) {
      faces[best]!.holes.push(oi)
      faces[best]!.area += Math.min(0, oc.area)
      faceOfCycle[oi] = best
    }
  }
  const dangling = vertices.map((_, v) => v).filter(v => out[v]!.length === 1)
  return { tol, pieces, byKey, pieceEdges, vertices, halfEdges, cycles, cycleOf, faceOfCycle, faces, dangling, vertexComp, pieceComp, bridges }
}

/** The face under p (the smallest, should faces nest), or null. */
export function faceAt(fs: FaceSet, p: Vec2): number | null {
  let best: number | null = null
  fs.faces.forEach((f, i) => {
    if (!boxHit(f.box, p)) return
    if (winding(fs.cycles[f.outer]!.poly, p) === 0) return
    for (const h of f.holes) if (Math.abs(fs.cycles[h]!.area) > fs.tol * fs.tol && winding(fs.cycles[h]!.poly, p) !== 0) return
    if (best == null || f.area < fs.faces[best]!.area) best = i
  })
  return best
}

/** The face a half-edge's left side belongs to (null = the open plane). */
export function faceOfHalfEdge(fs: FaceSet, h: number): number | null {
  return fs.faceOfCycle[fs.cycleOf[h]!] ?? null
}

// ── outlines ────────────────────────────────────────────────────────────────

const num = (n: number) => (Object.is(n, -0) ? 0 : n)

// a cycle's half-edges with the out-and-back spurs (a line poking into the
// face and ending there) taken out — they bound nothing
function withoutSpurs(edges: number[]): number[] {
  const st: number[] = []
  for (const e of edges) {
    if (st.length && (st[st.length - 1]! ^ 1) === e) st.pop()
    else st.push(e)
  }
  while (st.length > 1 && (st[0]! ^ 1) === st[st.length - 1]!) { st.shift(); st.pop() }
  return st
}

function cycleD(fs: FaceSet, ci: number, s: number): string {
  const edges = withoutSpurs(fs.cycles[ci]!.edges)
  if (!edges.length) return ''
  const P = (p: Vec2) => `${num(p.x * s)} ${num(p.y * s)}`
  let d = `M ${P(fs.halfEdges[edges[0]!]!.p0)}`
  for (const e of edges) {
    const h = fs.halfEdges[e]!
    if (h.kind === 'line') { d += ` L ${P(h.p1)}`; continue }
    const r = num(h.r! * s), sw = h.sweep! > 0 ? 1 : 0
    const arc = (a: number, sweep: number) => {
      const end = { x: h.c!.x + h.r! * Math.cos(a + sweep), y: h.c!.y + h.r! * Math.sin(a + sweep) }
      d += ` A ${r} ${r} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} ${sw} ${P(end)}`
    }
    if (Math.abs(h.sweep!) >= TAU - 1e-9) { arc(h.a0!, h.sweep! / 2); arc(h.a0! + h.sweep! / 2, h.sweep! / 2) }
    else d += ` A ${r} ${r} 0 ${Math.abs(h.sweep!) > Math.PI ? 1 : 0} ${sw} ${P(h.p1)}`
  }
  return d + ' Z'
}

/** One closed outline (true arcs) for these faces, holes included: outer
 *  cycles counter-clockwise, holes clockwise, so a non-zero fill paints
 *  exactly the faces. Coordinates × `scale`. */
export function facesD(fs: FaceSet, faceIds: number[], scale = 1): string {
  const parts: string[] = []
  for (const f of faceIds) {
    const face = fs.faces[f]
    if (!face) continue
    for (const ci of [face.outer, ...face.holes]) {
      if (ci !== face.outer && !(Math.abs(fs.cycles[ci]!.area) > fs.tol * fs.tol)) continue
      const d = cycleD(fs, ci, scale)
      if (d) parts.push(d)
    }
  }
  return parts.join(' ')
}

// ── the cache ───────────────────────────────────────────────────────────────

// a fingerprint of everything faces depend on (pieces, their points, radii,
// guide flags) — never the fills — so a frame where nothing moved is a hit
const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
export function geometryKey(doc: SketchDoc): string {
  let h1 = 0x811c9dc5, h2 = 5381, n = 0
  const mix = (x: number) => { h1 = Math.imul(h1 ^ x, 16777619); h2 = (Math.imul(h2, 33) ^ x) | 0; n++ }
  const str = (s: string) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(0) }
  const numb = (v: number) => { f64[0] = v; mix(u32[0]!); mix(u32[1]!) }
  for (const e of doc.entities) {
    str(e.kind); str(e.id); mix(e.construction ? 1 : 0)
    if (e.kind === 'point') { numb(e.x); numb(e.y) }
    else if (e.kind === 'line') { str(e.p1); str(e.p2) }
    else if (e.kind === 'circle') { str(e.center); numb(e.r) }
    else {
      mix(e.closed ? 1 : 0)
      for (const a of e.anchors) str(a)
      for (const s of e.segments) { str(s.kind); if (s.kind === 'arc') { str(s.center); mix(s.sweep) } }
    }
  }
  return `${h1 >>> 0}:${h2 >>> 0}:${n}`
}

const CACHE_SIZE = 6
const cache: { key: string; fs: FaceSet }[] = []
/** findFaces, remembered for the last few geometries (a hover, the overlay and
 *  a host's preview asking about the same drawing share one answer). */
export function facesFor(doc: SketchDoc, gap = 0): FaceSet {
  const key = `${geometryKey(doc)}|${gap}`
  const i = cache.findIndex(c => c.key === key)
  if (i >= 0) { const [hit] = cache.splice(i, 1); cache.unshift(hit!); return hit!.fs }
  const fs = findFaces(doc, { gap })
  cache.unshift({ key, fs })
  if (cache.length > CACHE_SIZE) cache.pop()
  return fs
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-faces.unit.spec.ts tests/unit/sketch-crossings.unit.spec.ts tests/unit/pen-trim.unit.spec.ts`
Expected: PASS (the two existing files prove the rename changed nothing).

- [ ] **Step 6: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(faces|crossings)\.ts'` → no output.

- [ ] **Step 7: Commit** `frontend/app/lib/sketch/crossings.ts frontend/app/lib/sketch/faces.ts frontend/tests/unit/sketch-faces.unit.spec.ts` — message `feat(pen): the areas a drawing encloses — faces with exact arcs, holes and gap bridges (stage 7)`.

---

### Task 2: Fills stored by a seed — the model, the Fill click, the outline (pure)

**Files:**
- Modify: `frontend/app/lib/sketch/model.ts`, `frontend/app/lib/sketch/clone.ts`, `frontend/app/lib/sketch/merge.ts`
- Create: `frontend/app/lib/sketch/fills.ts`
- Test: `frontend/tests/unit/sketch-fills.unit.spec.ts`

**Behaviour (Rulings 3, 5, 13):**
- `SketchDoc` gains `fills?` and `fillGap?`, both optional; `cloneDoc` copies them (only when present, so a drawing without them clones to exactly the same JSON); `mergeSketchDoc` keeps a fill only when its seed names pieces the drawing has (line / arc ends are points, an arc's centre is a point and `ccw` a boolean, a circle seed's `a === b` is a circle and `c` a point; `t` in [0, 1]; `side` ±1; ids unique), and keeps `fillGap` (> 0) only beside at least one fill.
- `halfEdgeOfSeed` finds the piece by its key (either way round: a reversed piece reads `1 − t` and the other side), then the half-edge on the seed's side at `t`; `resolveFill` → its face or `null` (asleep). `seedForFace` seeds the middle of a face's longest outer edge (never a bridge).
- `fillState(doc)` — which faces are filled (unique) and which fills sleep; `fillPathData(doc, scale)` — the filled faces' outline, `''` with no fills or none awake; `gapMarkers(doc)` — for each sleeping fill, the open ends of its piece's component nearest its seed (≤ 2).
- `fillTarget(doc, p, gapIfNone)` — the face under p (the drawing's own gap, else `gapIfNone`), whether it is filled, its outline; `toggleFillAt(doc, p, gapIfNone)` fills an empty face (first fill: `fillGap = gapIfNone` when > 0) or removes every fill on a filled one (last fill: both fields deleted); `addFillAt(doc, p)`; `withoutFills(doc)`.

**Interfaces:**
- Consumes: Task 1's `facesFor`, `faceAt`, `facesD`, `faceOfHalfEdge`, `facePieceKey`, `FaceSet`, `FacePiece`, `HalfEdge`.
- Produces: `interface FillSeed`, `interface SketchFill`, `SketchDoc.fills?`, `SketchDoc.fillGap?` (model.ts); `FILL_GAP_PX = 6`, `fillFaces(doc, gapIfNone?)`, `halfEdgeOfSeed(fs, seed)`, `resolveFill(fs, fill)`, `seedOnHalfEdge(fs, h)`, `seedForFace(fs, f)`, `freshFillId(doc)`, `withoutFills(doc)`, `interface FillState { fs; filled: number[]; asleep: SketchFill[] }`, `fillState(doc)`, `fillPathData(doc, scale?)`, `gapMarkers(doc): Vec2[]`, `fillTarget(doc, p, gapIfNone): { face; filled; d } | null`, `toggleFillAt(doc, p, gapIfNone): boolean`, `addFillAt(doc, p): boolean` (fills.ts).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-fills.unit.spec.ts`:

```ts
// tests/unit/sketch-fills.unit.spec.ts
// Pen stage 7: fills stored by a seed on an edge — the Fill tool's click
// (fill, empty), the hover target, following a drag, the owner's trimmed
// flower filled petal by petal without joining, the outline out, and the
// fields surviving a clone and a save / load (a drawing from before stage 7
// loads unchanged).
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addCircle, addPath } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { fillState, fillPathData, fillTarget, toggleFillAt, withoutFills } from '~/lib/sketch/fills'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function square(d: SketchDoc, x: number, y: number, s: number) {
  const ids = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => addPoint(d, px!, py!))
  return { id: addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true), ids }
}
/** A square centre with four petal arcs on its sides, each petal a separate open
 *  piece whose ends stop ~3 px (at 34 px per unit) short of the square's corners. */
function flower(d: SketchDoc) {
  const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
  square(d, 6, 2, 6)
  const dl = 0.03
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const cx = (x0! + x1!) / 2, cy = (y0! + y1!) / 2, r = 3
    const a0 = Math.atan2(y0! - cy, x0! - cx) + dl, a1 = a0 + Math.PI - 2 * dl
    const s = addPoint(d, cx + r * Math.cos(a0), cy + r * Math.sin(a0)), e = addPoint(d, cx + r * Math.cos(a1), cy + r * Math.sin(a1))
    addPath(d, [s, e], [{ kind: 'arc', center: addPoint(d, cx, cy), sweep: 1 }])
  }
}

describe('the Fill tool’s click', () => {
  it('fills the area under the point, empties it on a second click; the first fill fixes the gap, the last clears it', () => {
    const d = doc(); square(d, 0, 0, 4)
    expect(fillTarget(d, { x: 1, y: 1 }, 0.1)).toMatchObject({ filled: false })
    expect(toggleFillAt(d, { x: 1, y: 1 }, 0.1)).toBe(true)
    expect(d.fills).toHaveLength(1)
    expect(d.fillGap).toBe(0.1)
    expect(d.fills![0]!.seed).toMatchObject({ kind: 'line', side: expect.any(Number) })
    expect(fillPathData(d)).toBe('M 0 0 L 4 0 L 4 4 L 0 4 L 0 0 Z')
    expect(fillPathData(d, 0.5)).toBe('M 0 0 L 2 0 L 2 2 L 0 2 L 0 0 Z')
    expect(fillTarget(d, { x: 1, y: 1 }, 0.1)).toMatchObject({ filled: true })
    expect(toggleFillAt(d, { x: 1, y: 1 }, 0.1)).toBe(true)
    expect(d.fills).toBeUndefined()
    expect(d.fillGap).toBeUndefined()
    expect(fillPathData(d)).toBe('')
  })
  it('a click outside every area changes nothing', () => {
    const d = doc(); square(d, 0, 0, 4)
    expect(fillTarget(d, { x: 9, y: 9 }, 0)).toBeNull()
    expect(toggleFillAt(d, { x: 9, y: 9 }, 0)).toBe(false)
    expect(d.fills).toBeUndefined()
  })
  it('a circle’s fill is seeded on the circle itself', () => {
    const d = doc(); const c = addCircle(d, addPoint(d, 0, 0), 2)
    toggleFillAt(d, { x: 0.5, y: 0 }, 0)
    expect(d.fills![0]!.seed).toMatchObject({ kind: 'circle', a: c, b: c })
    expect(fillState(d).filled).toHaveLength(1)
  })
})

describe('a fill follows the drawing', () => {
  it('dragging a corner: the same fill, a bigger area', () => {
    const d = doc(); const s = square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const p = d.entities.find(e => e.id === s.ids[2]) as { x: number; y: number }
    p.x = 10; p.y = 10
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeGreaterThan(16)
  })
  it('the owner’s trimmed flower: the centre and all four petals fill without joining anything', () => {
    const d = doc(); flower(d)
    const gap = 6 / 34
    for (const p of [{ x: 9, y: 5 }, { x: 9, y: 0.2 }, { x: 13.8, y: 5 }, { x: 9, y: 9.8 }, { x: 4.2, y: 5 }]) {
      expect(toggleFillAt(d, p, gap)).toBe(true)
    }
    const st = fillState(d)
    expect(st.filled).toHaveLength(5)
    expect(st.asleep).toHaveLength(0)
    expect((fillPathData(d).match(/M /g) ?? []).length).toBe(5)
  })
})

describe('storage', () => {
  it('a clone and a save / load keep fills; a drawing from before fills loads unchanged; broken seeds are dropped', () => {
    const d = doc(); square(d, 0, 0, 4); addCircle(d, addPoint(d, 10, 2), 1)
    toggleFillAt(d, { x: 1, y: 1 }, 0.2); toggleFillAt(d, { x: 10, y: 2 }, 0.2)
    const c = cloneDoc(d)
    expect(c.fills).toEqual(d.fills); expect(c.fills).not.toBe(d.fills); expect(c.fillGap).toBe(0.2)
    const loaded = mergeSketchDoc(JSON.parse(JSON.stringify(d)))
    expect(loaded.fills).toEqual(d.fills); expect(loaded.fillGap).toBe(0.2)
    expect(fillState(loaded).filled).toHaveLength(2)
    const old = mergeSketchDoc(JSON.parse(JSON.stringify({ entities: d.entities, constraints: d.constraints })))
    expect('fills' in old).toBe(false); expect('fillGap' in old).toBe(false)
    expect(JSON.stringify(cloneDoc(old))).toBe(JSON.stringify(old))
    const broken = JSON.parse(JSON.stringify(d)); broken.fills[0].seed.a = 'nope'; broken.fills[1].seed.side = 0
    const b = mergeSketchDoc(broken)
    expect(b.fills).toBeUndefined(); expect(b.fillGap).toBeUndefined()
  })
  it('withoutFills drops both fields and leaves the rest', () => {
    const d = doc(); square(d, 0, 0, 4); toggleFillAt(d, { x: 1, y: 1 }, 0.2)
    const w = withoutFills(d)
    expect('fills' in w).toBe(false); expect('fillGap' in w).toBe(false)
    expect(w.entities).toBe(d.entities)
    const plain = doc()
    expect(withoutFills(plain)).toBe(plain)
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/unit/sketch-fills.unit.spec.ts` → FAIL (`~/lib/sketch/fills` does not resolve).

- [ ] **Step 3: The model** — in `frontend/app/lib/sketch/model.ts` replace
`export interface SketchDoc { entities: SketchEntity[]; constraints: SketchConstraint[] }` with:

```ts
/** Pen stage 7: where a filled area is — a spot on one of its edges, so the
 *  fill follows the drawing (see lib/sketch/fills.ts). The piece is named by
 *  its points in its own direction of travel: a line p1→p2 or a straight path
 *  piece anchor i→i+1; an arc path piece anchor i→i+1 about centre `c`,
 *  turning counter-clockwise when `ccw`; a circle by its own id (`a` and `b`)
 *  and its centre `c`. `t` is how far along it (0..1 from `a`; a circle: the
 *  angle / 2π counter-clockwise from +x), `side` which side the area lies on
 *  (1 = left of the direction of travel, −1 = right). */
export interface FillSeed {
  kind: 'line' | 'arc' | 'circle'
  a: EntityId
  b: EntityId
  c?: EntityId
  ccw?: boolean
  t: number
  side: 1 | -1
}
export interface SketchFill { id: EntityId; seed: FillSeed }

export interface SketchDoc {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  /** pen stage 7: filled areas (absent = none; a drawing from before stage 7) */
  fills?: SketchFill[]
  /** pen stage 7: how far (drawing units) an open end may stop short and its
   *  area still fill — fixed at the first fill, cleared with the last */
  fillGap?: number
}
```

- [ ] **Step 4: Clone** — in `frontend/app/lib/sketch/clone.ts`, `cloneDoc` becomes:

```ts
export function cloneDoc(doc: SketchDoc): SketchDoc {
  const out: SketchDoc = {
    entities: doc.entities.map(e => {
      if (e.kind === 'path') return { ...e, anchors: [...e.anchors], segments: e.segments.map(s => ({ ...s })) }
      return { ...e }
    }) as SketchEntity[],
    constraints: doc.constraints.map(c => ({ ...c, refs: [...c.refs] })) as SketchConstraint[],
  }
  // pen stage 7: fills, only when there are any (a drawing without them clones exactly as before)
  if (doc.fills) out.fills = doc.fills.map(f => ({ id: f.id, seed: { ...f.seed } }))
  if (doc.fillGap != null) out.fillGap = doc.fillGap
  return out
}
```

- [ ] **Step 5: Load** — in `frontend/app/lib/sketch/merge.ts` add `SketchFill` to the model type import, and replace the function's final `return doc` with:

```ts
  // pen stage 7: fills (optional — a drawing from before stage 7 has none), each
  // kept only when its seed names pieces this drawing still has
  if (Array.isArray(r.fills)) {
    const points = new Set(doc.entities.filter(e => e.kind === 'point').map(e => e.id))
    const circles = new Set(doc.entities.filter(e => e.kind === 'circle').map(e => e.id))
    const seenF = new Set<string>()
    const fills: SketchFill[] = []
    for (const f of r.fills) {
      const s = f?.seed
      if (!f || !isStr(f.id) || seenF.has(f.id) || !s || typeof s !== 'object') continue
      if (!isNum(s.t) || s.t < 0 || s.t > 1 || (s.side !== 1 && s.side !== -1)) continue
      if (s.kind === 'line') { if (!points.has(s.a) || !points.has(s.b)) continue }
      else if (s.kind === 'arc') { if (!points.has(s.a) || !points.has(s.b) || !points.has(s.c) || typeof s.ccw !== 'boolean') continue }
      else if (s.kind === 'circle') { if (!circles.has(s.a) || s.b !== s.a || !points.has(s.c)) continue }
      else continue
      seenF.add(f.id)
      fills.push({ id: f.id, seed: {
        kind: s.kind, a: s.a, b: s.b,
        ...(s.kind !== 'line' ? { c: s.c } : {}),
        ...(s.kind === 'arc' ? { ccw: s.ccw } : {}),
        t: s.t, side: s.side,
      } })
    }
    if (fills.length) {
      doc.fills = fills
      if (isNum(r.fillGap) && r.fillGap > 0) doc.fillGap = r.fillGap
    }
  }
  return doc
```

- [ ] **Step 6: Create `frontend/app/lib/sketch/fills.ts`** (Tasks 3 and 4 append to it):

```ts
// app/lib/sketch/fills.ts
// Pen stage 7, filled areas. A fill is stored by a seed on one of its
// area's edges — the piece (named by its points), how far along it, and on
// which side — never by an area id, so it follows every drag. Faces come from
// faces.ts. reconcileFills carries fills across an edit (split → both halves,
// merge → one, opened → asleep with a gap marker); the structural edits that
// rename pieces (Cut, Dissolve, merging points, copies) move seeds themselves
// through splitSeeds / joinSeeds / renameSeedPoints / mapSeed. Pure.
import type { SketchDoc, SketchFill, FillSeed, EntityId } from './model'
import type { Vec2 } from './geom'
import { facesFor, faceAt, facesD, faceOfHalfEdge, facePieceKey, type FaceSet, type FacePiece, type HalfEdge } from './faces'

/** How far (screen px, at the zoom of the first fill) a nearly-closed area's
 *  gap may be and still fill — Clean up's join distance. */
export const FILL_GAP_PX = 6

/** The faces this drawing's fills live on (its stored gap). */
export function fillFaces(doc: SketchDoc, gapIfNone = 0): FaceSet {
  return facesFor(doc, doc.fillGap ?? gapIfNone)
}

// ── seeds ↔ half-edges ─────────────────────────────────────────────────────

function pieceOfSeed(s: FillSeed): FacePiece {
  if (s.kind === 'circle') return { kind: 'circle', id: s.a, c: s.c ?? s.a }
  if (s.kind === 'arc') return { kind: 'arc', a: s.a, b: s.b, c: s.c ?? '', ccw: !!s.ccw }
  return { kind: 'line', a: s.a, b: s.b }
}

/** The half-edge whose left side the seed's area is on, or null when its piece is gone. */
export function halfEdgeOfSeed(fs: FaceSet, s: FillSeed): number | null {
  const pi = fs.byKey.get(facePieceKey(pieceOfSeed(s)))
  if (pi == null) return null
  const piece = fs.pieces[pi]!
  let t = s.t, side = s.side
  if ((piece.kind === 'line' || piece.kind === 'arc') && piece.a !== s.a) { t = 1 - t; side = side === 1 ? -1 : 1 }
  for (const h of fs.pieceEdges[pi]!) {
    const e = fs.halfEdges[h]!
    let u = t
    if (piece.kind === 'circle' && u < e.t0 - 1e-12) u += 1
    if (u >= e.t0 - 1e-12 && u <= e.t1 + 1e-12) return side === 1 ? h : h ^ 1
  }
  return null
}

/** The face a fill sits on now, or null (asleep). */
export function resolveFill(fs: FaceSet, f: SketchFill): number | null {
  const h = halfEdgeOfSeed(fs, f.seed)
  return h == null ? null : faceOfHalfEdge(fs, h)
}

/** A seed in the middle of half-edge h, on its left (its face's side). */
export function seedOnHalfEdge(fs: FaceSet, h: number): FillSeed | null {
  const e = fs.halfEdges[h]!
  const p = fs.pieces[e.piece]!
  if (p.kind === 'bridge') return null
  const mid = (e.t0 + e.t1) / 2
  const t = p.kind === 'circle' ? ((mid % 1) + 1) % 1 : mid
  const side: 1 | -1 = e.forward ? 1 : -1
  if (p.kind === 'circle') return { kind: 'circle', a: p.id, b: p.id, c: p.c, t, side }
  if (p.kind === 'arc') return { kind: 'arc', a: p.a, b: p.b, c: p.c, ccw: p.ccw, t, side }
  return { kind: 'line', a: p.a, b: p.b, t, side }
}

/** A seed for face f: the middle of its longest outer edge (never a bridge). */
export function seedForFace(fs: FaceSet, f: number): FillSeed | null {
  const face = fs.faces[f]
  if (!face) return null
  let best: number | null = null
  for (const h of fs.cycles[face.outer]!.edges) {
    if (fs.pieces[fs.halfEdges[h]!.piece]!.kind === 'bridge') continue
    if (best == null || fs.halfEdges[h]!.len > fs.halfEdges[best]!.len) best = h
  }
  return best == null ? null : seedOnHalfEdge(fs, best)
}

export function freshFillId(doc: SketchDoc): EntityId {
  const have = new Set((doc.fills ?? []).map(f => f.id))
  let n = have.size + 1
  while (have.has(`F${n}`)) n++
  return `F${n}`
}

/** The drawing without its fills (a pen that can't fill: a text guide). */
export function withoutFills(doc: SketchDoc): SketchDoc {
  if (!doc.fills && doc.fillGap == null) return doc
  const { fills: _f, fillGap: _g, ...rest } = doc
  return rest
}

// ── what shows ──────────────────────────────────────────────────────────────

export interface FillState { fs: FaceSet; filled: number[]; asleep: SketchFill[] }

/** Which faces are filled, and which fills sleep (their area is open). */
export function fillState(doc: SketchDoc): FillState {
  const fs = fillFaces(doc)
  const filled: number[] = []
  const asleep: SketchFill[] = []
  for (const f of doc.fills ?? []) {
    const face = resolveFill(fs, f)
    if (face == null) asleep.push(f)
    else if (!filled.includes(face)) filled.push(face)
  }
  return { fs, filled, asleep }
}

/** The filled areas as one closed outline (true arcs), coordinates × scale;
 *  '' when nothing is filled (no fills, or every fill asleep). */
export function fillPathData(doc: SketchDoc, scale = 1): string {
  if (!doc.fills?.length) return ''
  const st = fillState(doc)
  return st.filled.length ? facesD(st.fs, st.filled, scale) : ''
}

function pointOnHalfEdge(e: HalfEdge, u: number): Vec2 {
  const k = e.t1 === e.t0 ? 0.5 : (u - e.t0) / (e.t1 - e.t0)
  if (e.kind === 'line') return { x: e.p0.x + (e.p1.x - e.p0.x) * k, y: e.p0.y + (e.p1.y - e.p0.y) * k }
  const a = e.a0! + e.sweep! * k
  return { x: e.c!.x + e.r! * Math.cos(a), y: e.c!.y + e.r! * Math.sin(a) }
}

/** Where to show that a fill sleeps: the open ends of the drawing its edge
 *  belongs to, nearest its seed first (at most two per fill). */
export function gapMarkers(doc: SketchDoc): Vec2[] {
  const st = fillState(doc)
  const out: Vec2[] = []
  for (const f of st.asleep) {
    const h = halfEdgeOfSeed(st.fs, f.seed)
    if (h == null) continue
    const e = st.fs.halfEdges[h]!
    const at = pointOnHalfEdge(e, f.seed.t)
    const comp = st.fs.pieceComp[e.piece]!
    const ends = st.fs.dangling.filter(v => st.fs.vertexComp[v] === comp).map(v => st.fs.vertices[v]!)
    ends.sort((p, q) => Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y))
    for (const p of ends.slice(0, 2)) if (!out.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9)) out.push(p)
  }
  return out
}

// ── the Fill tool ───────────────────────────────────────────────────────────

/** The face under p as the Fill tool sees it (the drawing's own gap, or
 *  `gapIfNone` before its first fill), and whether it is filled. */
export function fillTarget(doc: SketchDoc, p: Vec2, gapIfNone: number): { face: number; filled: boolean; d: string } | null {
  const fs = fillFaces(doc, gapIfNone)
  const f = faceAt(fs, p)
  if (f == null) return null
  const filled = (doc.fills ?? []).some(x => resolveFill(fs, x) === f)
  return { face: f, filled, d: facesD(fs, [f]) }
}

/** Click: fill the face under p, or empty it if it is filled. The first
 *  fill fixes the drawing's gap; the last one clears it. True if it changed. */
export function toggleFillAt(doc: SketchDoc, p: Vec2, gapIfNone: number): boolean {
  const gap = doc.fillGap ?? gapIfNone
  const fs = facesFor(doc, gap)
  const f = faceAt(fs, p)
  if (f == null) return false
  const fills = doc.fills ?? []
  const on = fills.filter(x => resolveFill(fs, x) === f)
  if (on.length) {
    doc.fills = fills.filter(x => !on.includes(x))
    if (!doc.fills.length) { delete doc.fills; delete doc.fillGap }
    return true
  }
  const seed = seedForFace(fs, f)
  if (!seed) return false
  doc.fills = [...fills, { id: freshFillId(doc), seed }]
  if (doc.fillGap == null && gap > 0) doc.fillGap = gap
  return true
}

/** Fill the face at p unless it already is (copies landing on their place). */
export function addFillAt(doc: SketchDoc, p: Vec2): boolean {
  const fs = fillFaces(doc)
  const f = faceAt(fs, p)
  if (f == null) return false
  const fills = doc.fills ?? []
  if (fills.some(x => resolveFill(fs, x) === f)) return false
  const seed = seedForFace(fs, f)
  if (!seed) return false
  doc.fills = [...fills, { id: freshFillId(doc), seed }]
  return true
}
```

- [ ] **Step 7: Run the tests to see them pass** — `npx vitest run tests/unit/sketch-fills.unit.spec.ts tests/unit/sketch-faces.unit.spec.ts tests/unit/sketch-clone.unit.spec.ts tests/unit/sketch-merge.unit.spec.ts tests/unit/pen-weld.unit.spec.ts` → PASS.

- [ ] **Step 8: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(fills|model|clone|merge)\.ts'` → no output.

- [ ] **Step 9: Commit** `frontend/app/lib/sketch/model.ts frontend/app/lib/sketch/clone.ts frontend/app/lib/sketch/merge.ts frontend/app/lib/sketch/fills.ts frontend/tests/unit/sketch-fills.unit.spec.ts` — message `feat(pen): fills stored by a seed on an edge — click to fill or empty, outline out, saved and loaded (stage 7)`.

---

### Task 3: Fills carried across an edit — split, merge, asleep (pure)

**Files:**
- Modify: `frontend/app/lib/sketch/fills.ts` (append a section; add `getPoint` to the model import)
- Test: `frontend/tests/unit/sketch-fills-carry.unit.spec.ts`

**Behaviour (Ruling 6):** `reconcileFills(before, after)` returns the fills `after` should have (it never writes). Steps: (1) each fill of `after` whose seed resolves claims its face (first claim wins — a merge keeps one fill); the rest are asleep candidates. (2) For each fill of `after` that `before` also had and that resolved there to face `fb`: every face of `after` that shares an edge stretch with `fb` on the same side (pieces compared by key in the key's own orientation, parameter intervals overlapping by more than 1e-9) is filled; when every boundary point of `fb` stayed within 0.1 % of `fb`'s size, every face of `after` with an inside point that lies in `fb` is filled too. An asleep candidate whose area grew back takes its own id on the first such face; new halves get fresh ids. (3) An asleep candidate whose seed piece is gone but whose old area had an edge still in `after` is re-seeded onto that edge; one with neither is dropped. (4) Output order: `after`'s own fills in their order (seed kept when it still lands on its face, else re-seeded onto it), then new halves by face index — so an edit that changes nothing returns the input exactly.

**Interfaces:**
- Consumes: Task 2's `fillFaces`, `halfEdgeOfSeed`, `resolveFill`, `seedOnHalfEdge`, `seedForFace`, `pointOnHalfEdge`; Task 1's `facesFor`, `faceAt`, `faceOfHalfEdge`, `facePieceKey`.
- Produces: `interiorPoint(fs, g): Vec2 | null`, `reconcileFills(before, after): SketchFill[]`; internal `keyed`, `faceCycles`, `sharedEdgeFaces`, `boundaryPoints`, `stayedPut` (Task 4 uses `faceCycles` and `boundaryPoints`).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-fills-carry.unit.spec.ts`:

```ts
// tests/unit/sketch-fills-carry.unit.spec.ts
// Pen stage 7: fills carried across an edit (reconcileFills, run on every
// settled step): nothing changed → exactly the same fills; a line across a
// filled area → both halves; the divider trimmed → one fill; the area opened
// → the fill sleeps (gap rings) on an edge it still has, and wakes when the
// area closes; an emptied fill never comes back.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { removeSpan } from '~/lib/sketch/trim'
import { spanAt } from '~/lib/sketch/crossings'
import { fillState, toggleFillAt, reconcileFills, gapMarkers } from '~/lib/sketch/fills'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function square(d: SketchDoc, x: number, y: number, s: number) {
  const ids = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => addPoint(d, px!, py!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
/** what the pen's commit does: carry the fills from the last settled drawing */
function settle(before: SketchDoc, after: SketchDoc) {
  const f = reconcileFills(before, after)
  if (f.length) after.fills = f
  else { delete after.fills; delete after.fillGap }
}
const pathOf = (d: SketchDoc) => d.entities.find(e => e.kind === 'path') as { id: string; anchors: string[] }

describe('reconcileFills', () => {
  it('an edit that changes nothing leaves the fills exactly as they were', () => {
    const d = doc(); square(d, 0, 0, 4); square(d, 6, 0, 4)
    toggleFillAt(d, { x: 7, y: 1 }, 0); toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    expect(reconcileFills(before, cloneDoc(d))).toEqual(before.fills)
  })
  it('a line drawn across a filled area fills both halves; trimming the divider leaves one fill', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const b1 = cloneDoc(d)
    const line = addLine(d, addPoint(d, 2, -1), addPoint(d, 2, 5))
    expect(fillState(d).filled).toHaveLength(1)    // the seed alone finds one half…
    settle(b1, d)
    expect(d.fills).toHaveLength(2)                 // …the settle fills the other
    expect(fillState(d).filled).toHaveLength(2)
    const b2 = cloneDoc(d)
    expect(removeSpan(d, spanAt(d, { kind: 'line', id: line }, 0.5)!).ok).toBe(true)
    settle(b2, d)
    expect(d.fills).toHaveLength(1)
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(16, 6)
  })
  it('opening the area puts the fill to sleep with rings at the gap; closing it again wakes it', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const b1 = cloneDoc(d)
    const P = pathOf(d)
    const far = (P.anchors.indexOf(d.fills![0]!.seed.a) + 2) % 4   // the side opposite the seed
    expect(removeSpan(d, spanAt(d, { kind: 'seg', pathId: P.id, segIndex: far }, 0.5)!).ok).toBe(true)
    settle(b1, d)
    expect(d.fills).toHaveLength(1)
    expect(fillState(d).asleep).toHaveLength(1)
    expect(gapMarkers(d)).toHaveLength(2)
    const open = pathOf(d)
    const b2 = cloneDoc(d)
    addLine(d, open.anchors[0]!, open.anchors[open.anchors.length - 1]!)
    settle(b2, d)
    expect(fillState(d).filled).toHaveLength(1)
    expect(gapMarkers(d)).toHaveLength(0)
  })
  it('opening the area by trimming the seed’s own edge moves the sleeping fill onto an edge that is left', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    const P = pathOf(d)
    const own = P.anchors.indexOf(d.fills![0]!.seed.a)
    expect(removeSpan(d, spanAt(d, { kind: 'seg', pathId: P.id, segIndex: own }, 0.5)!).ok).toBe(true)
    settle(before, d)
    expect(d.fills).toHaveLength(1)
    expect(fillState(d).asleep).toHaveLength(1)
    expect(gapMarkers(d)).toHaveLength(2)
  })
  it('a fill emptied on purpose is never brought back', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    expect(reconcileFills(before, d)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/unit/sketch-fills-carry.unit.spec.ts` → FAIL (`reconcileFills` is not exported).

- [ ] **Step 3: Implement** — in `frontend/app/lib/sketch/fills.ts` change the model import to

```ts
import type { SketchDoc, SketchFill, FillSeed, EntityId } from './model'
import { getPoint } from './model'
```

and append at the end of the file:

```ts
// ── carrying fills across an edit ───────────────────────────────────────────

// a half-edge in its piece key's own orientation: the key, whether it runs
// the key's way, and its parameter interval measured the key's way
interface KeyedEdge { key: string; dir: boolean; lo: number; hi: number; h: number }
function keyed(fs: FaceSet, h: number): KeyedEdge | null {
  const e = fs.halfEdges[h]!
  const p = fs.pieces[e.piece]!
  if (p.kind === 'bridge') return null
  const key = facePieceKey(p)
  // does the piece's own direction run the key's way?
  const along = p.kind === 'circle' ? true : p.a < p.b || (p.a === p.b)
  const u0 = along ? e.t0 : 1 - e.t0, u1 = along ? e.t1 : 1 - e.t1
  const dir = along ? e.forward : !e.forward
  return { key, dir, lo: Math.min(u0, u1), hi: Math.max(u0, u1), h }
}

function faceCycles(fs: FaceSet, f: number): number[] {
  const face = fs.faces[f]!
  return [face.outer, ...face.holes]
}

// the faces of `after` that take up part of face fb of `before`, found by
// the edges they share (same piece, same side, overlapping stretch)
function sharedEdgeFaces(FB: FaceSet, fb: number, FA: FaceSet, index: Map<string, KeyedEdge[]>): Set<number> {
  const out = new Set<number>()
  for (const ci of faceCycles(FB, fb)) {
    for (const h of FB.cycles[ci]!.edges) {
      const k = keyed(FB, h)
      if (!k) continue
      for (const m of index.get(k.key) ?? []) {
        if (m.dir !== k.dir) continue
        if (Math.min(m.hi, k.hi) - Math.max(m.lo, k.lo) <= 1e-9) continue
        const g = faceOfHalfEdge(FA, m.h)
        if (g != null) out.add(g)
      }
    }
  }
  return out
}

// a point well inside face g (a step in from the middle of one of its edges)
export function interiorPoint(fs: FaceSet, g: number): Vec2 | null {
  const face = fs.faces[g]!
  const size = Math.hypot(face.box.x1 - face.box.x0, face.box.y1 - face.box.y0)
  const edges = [...fs.cycles[face.outer]!.edges].sort((a, b) => fs.halfEdges[b]!.len - fs.halfEdges[a]!.len)
  for (const step of [1e-3, 1e-2, 5e-2]) {
    for (const h of edges.slice(0, 6)) {
      const e = fs.halfEdges[h]!
      const m = pointOnHalfEdge(e, (e.t0 + e.t1) / 2)
      // the left normal of the direction of travel at m
      let tx: number, ty: number
      if (e.kind === 'line') { tx = e.p1.x - e.p0.x; ty = e.p1.y - e.p0.y }
      else { const a = e.a0! + e.sweep! / 2; const s = e.sweep! > 0 ? 1 : -1; tx = -Math.sin(a) * s; ty = Math.cos(a) * s }
      const L = Math.hypot(tx, ty) || 1
      const p = { x: m.x - (ty / L) * step * size, y: m.y + (tx / L) * step * size }
      if (faceAt(fs, p) === g) return p
    }
  }
  return null
}

// every point id on face f's boundary pieces
function boundaryPoints(fs: FaceSet, f: number): EntityId[] {
  const ids = new Set<EntityId>()
  for (const ci of faceCycles(fs, f)) {
    for (const h of fs.cycles[ci]!.edges) {
      const p = fs.pieces[fs.halfEdges[h]!.piece]!
      if (p.kind === 'line') { ids.add(p.a); ids.add(p.b) }
      else if (p.kind === 'arc') { ids.add(p.a); ids.add(p.b); ids.add(p.c) }
      else if (p.kind === 'circle') ids.add(p.c)
    }
  }
  return [...ids]
}

// face fb's boundary points are all still there, within 0.1 % of its size
function stayedPut(before: SketchDoc, after: SketchDoc, FB: FaceSet, fb: number): boolean {
  const b = FB.faces[fb]!.box
  const tol = 1e-3 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
  for (const id of boundaryPoints(FB, fb)) {
    const p = getPoint(before, id), q = getPoint(after, id)
    if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y) > tol) return false
  }
  return true
}

/** The fills `after` should have, given the drawing was `before` a moment
 *  ago: every fill whose seed still finds its face keeps it; every face that
 *  takes up part of a surviving fill's old face is filled too (split → both
 *  halves); faces holding two fills keep one (merge → one); a fill whose area
 *  opened sleeps on an edge it still has (or goes, if none is left); every
 *  seed ends on its own face. A fill missing from `after` was emptied on
 *  purpose and is never brought back. */
export function reconcileFills(before: SketchDoc, after: SketchDoc): SketchFill[] {
  const now = after.fills ?? []
  if (!now.length) return []
  const gap = after.fillGap ?? before.fillGap ?? 0
  const FA = facesFor(after, gap)
  const FB = facesFor(before, before.fillGap ?? gap)
  const was = new Map((before.fills ?? []).map(f => [f.id, f]))
  const claimed = new Map<number, SketchFill>()
  const asleep: SketchFill[] = []
  for (const f of now) {
    const g = resolveFill(FA, f)
    if (g == null) asleep.push(f)
    else if (!claimed.has(g)) claimed.set(g, f)
  }
  // index `after`'s half-edges by piece key, once
  const index = new Map<string, KeyedEdge[]>()
  for (let h = 0; h < FA.halfEdges.length; h++) {
    const k = keyed(FA, h)
    if (!k) continue
    const list = index.get(k.key)
    if (list) list.push(k); else index.set(k.key, [k])
  }
  const pts = new Map<number, Vec2 | null>()
  const inside = (g: number) => { if (!pts.has(g)) pts.set(g, interiorPoint(FA, g)); return pts.get(g)! }
  const reborn = new Set<SketchFill>()
  for (const f of now) {
    const old = was.get(f.id)
    if (!old) continue
    const fb = resolveFill(FB, old)
    if (fb == null) continue
    const grow = sharedEdgeFaces(FB, fb, FA, index)
    if (stayedPut(before, after, FB, fb)) {
      FA.faces.forEach((_, g) => { if (!grow.has(g)) { const p = inside(g); if (p && faceAt(FB, p) === fb) grow.add(g) } })
    }
    const sleeping = asleep.includes(f)
    for (const g of [...grow].sort((x, y) => x - y)) {
      if (claimed.has(g)) continue
      const seed = seedForFace(FA, g)
      if (!seed) continue
      if (sleeping && !reborn.has(f)) { claimed.set(g, { id: f.id, seed }); reborn.add(f) }
      else claimed.set(g, { id: '', seed })
    }
    if (sleeping && !reborn.has(f) && halfEdgeOfSeed(FA, f.seed) == null) {
      // its area opened and its own edge went: sleep on an edge of the old area that is left
      for (const ci of faceCycles(FB, fb)) {
        for (const h of FB.cycles[ci]!.edges) {
          const s = seedOnHalfEdge(FB, h)
          if (s && halfEdgeOfSeed(FA, s) != null) { reborn.add(f); asleep[asleep.indexOf(f)] = { id: f.id, seed: s }; break }
        }
        if (reborn.has(f)) break
      }
    }
  }
  // the drawing's own fills first, in their order (so an edit that changes
  // nothing leaves them exactly as they were), then the new halves by face
  const out: SketchFill[] = []
  const taken = new Set<string>()
  const placed = new Set<number>()
  const settled = (g: number, f: SketchFill): SketchFill | null => {
    const seed = resolveFill(FA, f) === g ? f.seed : seedForFace(FA, g)
    return seed ? (seed === f.seed ? f : { id: f.id, seed }) : null
  }
  for (const f of now) {
    const hit = [...claimed].find(([, c]) => c === f || (c.id === f.id && reborn.has(f)))
    if (hit) {
      const s2 = settled(hit[0], hit[1])
      if (s2) { out.push(s2); taken.add(f.id); placed.add(hit[0]) }
      continue
    }
    const sleeper = asleep.find(x => x.id === f.id)
    if (sleeper && halfEdgeOfSeed(FA, sleeper.seed) != null && !taken.has(f.id)) { out.push(sleeper); taken.add(f.id) }
  }
  let n = 1
  for (const [g, c] of [...claimed].sort((x, y) => x[0] - y[0])) {
    if (placed.has(g) || c.id) continue
    const s2 = settled(g, c)
    if (!s2) continue
    while (taken.has(`F${n}`)) n++
    out.push({ id: `F${n}`, seed: s2.seed }); taken.add(`F${n}`)
  }
  return out
}
```

- [ ] **Step 4: Run the tests to see them pass** — `npx vitest run tests/unit/sketch-fills-carry.unit.spec.ts tests/unit/sketch-fills.unit.spec.ts tests/unit/sketch-faces.unit.spec.ts` → PASS.

- [ ] **Step 5: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/fills\.ts'` → no output.

- [ ] **Step 6: Commit** `frontend/app/lib/sketch/fills.ts frontend/tests/unit/sketch-fills-carry.unit.spec.ts` — message `feat(pen): fills follow edits — a split fills both halves, a merge keeps one, an opened area sleeps (stage 7)`.

---

### Task 4: The edits that rename or copy pieces carry fills — Cut, Dissolve, merging, Repeat, Mirror, Copy / Paste, Flip (pure)

**Files:**
- Modify: `frontend/app/lib/sketch/fills.ts` (append a section)
- Modify: `frontend/app/lib/sketch/trim.ts` (three hunks: `cutAt`, `dissolveAt`, `mergePoints`, plus the import)
- Modify: `frontend/app/lib/sketch/edit.ts` (`copyStructure` records circle copies; `copyFills`; `repeatEntities`, `mirrorEntities`)
- Modify: `frontend/app/lib/sketch/clipboard.ts` (`extractPieces`, `insertPieces`, `scalePieces`)
- Test: `frontend/tests/unit/sketch-fills-edits.unit.spec.ts`

**Behaviour (Rulings 7, 8):**
- `splitSeeds(doc, a, b, c, tc, x)` — Cut split the piece a→b (an arc about `c`, or a line when `c` is null) at its own parameter `tc` with the new point `x`: a seed on it (either way round) moves onto the half it lies on, `t` rescaled.
- `joinSeeds(doc, a, q, b, c1, c2, share)` — Dissolve merged a→q and q→b (arcs about `c1` / `c2`) into a→b; `share` is the first piece's part of the whole (by turn for arcs, by length for lines); an arc seed takes the centre `c1`.
- `renameSeedPoints(doc, from, into)` — called by `mergePoints` right where it re-points rules.
- `mapSeed(seed, map, { mirror?, turn? })` — points renamed through `map`; `mirror` (the axis angle) flips a line / arc seed's side, flips an arc seed's `ccw` and reflects a circle seed's `t`; `turn` rotates a circle seed's `t`.
- `fillsWithin(doc, ids)` — the live fills whose whole area is bounded by pieces made only of the points (and circles) in `ids`.
- `flipSeeds(doc, ids, axis)` — before Flip moves the points: fills within them turn over (line seeds change side, circle seeds reflect; arc seeds are left, Ruling 8).
- Repeat / Mirror (`edit.ts`) copy each fill within the copied closure onto every copy (`copyStructure` now records each circle's copy in an optional `ents` map — entity ids are NOT added to the point `map`, so `copyClosureConstraints` copies exactly the rules it copied before). Copy (`extractPieces`) takes the fills within the copied closure and the drawing's `fillGap`; Paste (`insertPieces`) adds them with fresh fill ids on the pasted ids and adopts the copy's `fillGap` when the drawing has none; `scalePieces` scales `fillGap` and, turned upside down, mirrors the seeds.

**Interfaces:**
- Consumes: Task 3's `faceCycles`, `boundaryPoints`; Task 2's `fillFaces`, `resolveFill`, `freshFillId`.
- Produces: `splitSeeds`, `joinSeeds`, `renameSeedPoints`, `mapSeed`, `fillsWithin`, `flipSeeds` (fills.ts) — `flipSeeds` is used by Task 5.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-fills-edits.unit.spec.ts`:

```ts
// tests/unit/sketch-fills-edits.unit.spec.ts
// Pen stage 7: the edits that rename or copy pieces carry fills themselves —
// Cut and Dissolve keep a seed on its piece, merging points renames it,
// Repeat and Mirror copy a fill whose whole area they copy (circles too,
// mirrored seeds on the other side), Copy / Paste take fills along (a paste
// turned upside down too; one side of an area takes none), Flip keeps a
// filled shape filled.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, repeatEntities, mirrorEntities } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { cutAt, dissolveAt, mergePoints } from '~/lib/sketch/trim'
import { extractPieces, insertPieces, scalePieces } from '~/lib/sketch/clipboard'
import { fillState, toggleFillAt, reconcileFills, flipSeeds, fillsWithin } from '~/lib/sketch/fills'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function poly(d: SketchDoc, pts: number[][]) {
  const ids = pts.map(([x, y]) => addPoint(d, x!, y!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
const anchorsOf = (d: SketchDoc, id: string) => (d.entities.find(e => e.id === id) as { anchors: string[] }).anchors

describe('Cut, Dissolve and merging points carry the seed', () => {
  it('four cuts and a dissolve leave the square filled by the same fill', () => {
    const d = doc()
    const P = poly(d, [[0, 0], [4, 0], [4, 4], [0, 4]])
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const id = d.fills![0]!.id
    for (let i = 0; i < 4; i++) {
      expect(cutAt(d, { kind: 'seg', pathId: P, segIndex: i * 2 }, 0.3)).toBeTruthy()
      expect(fillState(d).filled).toHaveLength(1)
    }
    expect(anchorsOf(d, P)).toHaveLength(8)
    expect(dissolveAt(d, P, 1, 1e-6, 0.5).ok).toBe(true)
    expect(fillState(d).filled).toHaveLength(1)
    expect(d.fills!.map(f => f.id)).toEqual([id])
  })
  it('a cut line entity: the seed moves to the half it lies on', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 2, 3)
    const L = addLine(d, a, b); addLine(d, b, c); addLine(d, c, a)
    toggleFillAt(d, { x: 2, y: 1 }, 0)
    for (const t of [0.25, 0.5]) {
      const lines = d.entities.filter(e => e.kind === 'line')
      for (const l of lines) cutAt(d, { kind: 'line', id: l.id }, t)
      expect(fillState(d).filled).toHaveLength(1)
    }
    expect(L).toBeTruthy()
  })
  it('merging a seed’s point into another renames it in the seed', () => {
    const d = doc()
    const P = poly(d, [[0, 0], [4, 0], [4, 4], [0, 4]])
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const from = d.fills![0]!.seed.a
    const at = d.entities.find(e => e.id === from) as { x: number; y: number }
    const x = addPoint(d, at.x, at.y)   // a second point on the same corner (a drop-to-join)
    expect(mergePoints(d, from, x)).toBe(true)
    expect(d.fills![0]!.seed.a === x || d.fills![0]!.seed.b === x).toBe(true)
    expect(fillState(d).filled).toHaveLength(1)
    expect(P).toBeTruthy()
  })
})

describe('copies carry the fills of what they copy whole', () => {
  it('Repeat: a filled petal ×6 is six filled petals', () => {
    const d = doc()
    const c = addPoint(d, 0, 0)
    const P = poly(d, [[3, -0.5], [5, 0], [3, 0.5]])
    toggleFillAt(d, { x: 3.5, y: 0 }, 0)
    repeatEntities(d, [P], c, 6)
    expect(d.fills).toHaveLength(6)
    expect(fillState(d).filled).toHaveLength(6)
  })
  it('Repeat: a filled circle ×4 is four filled circles', () => {
    const d = doc()
    const C = addCircle(d, addPoint(d, 4, 0), 1)
    toggleFillAt(d, { x: 4, y: 0.2 }, 0)
    repeatEntities(d, [C], addPoint(d, 0, 0), 4)
    expect(fillState(d).filled).toHaveLength(4)
  })
  it('Mirror: the copy is filled — lines and arcs', () => {
    const d = doc()
    const ax = addLine(d, addPoint(d, 0, -5), addPoint(d, 0, 5))
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    mirrorEntities(d, [P], ax)
    expect(fillState(d).filled).toHaveLength(2)
    const e = doc()
    const ax2 = addLine(e, addPoint(e, 0, -5), addPoint(e, 0, 5))
    const a = addPoint(e, 1, 0), b = addPoint(e, 3, 0)
    const Q = addPath(e, [a, b], [{ kind: 'arc', center: addPoint(e, 2, 0), sweep: 1 }, { kind: 'line' }], true)
    toggleFillAt(e, { x: 2, y: -0.5 }, 0)
    expect(fillState(e).filled).toHaveLength(1)
    mirrorEntities(e, [Q], ax2)
    expect(fillState(e).filled).toHaveLength(2)
  })
  it('Copy / Paste take the fill along — upside down too; one side of an area takes none', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0.1)
    const clip = extractPieces(d, [P], [])
    expect(clip.fills).toHaveLength(1)
    expect(clip.fillGap).toBe(0.1)
    insertPieces(d, clip, { x: 5, y: 0 })
    expect(fillState(d).filled).toHaveLength(2)
    insertPieces(d, scalePieces(clip, 2, true), { x: 12, y: 0 })
    expect(fillState(d).filled).toHaveLength(3)
    expect(extractPieces(d, [], [{ pathId: P, segIndex: 0 }]).fills).toBeUndefined()
    // pasting into a drawing without fills brings the copy's gap along
    const e = doc()
    insertPieces(e, clip, { x: 0, y: 0 })
    expect(e.fillGap).toBe(0.1)
    expect(fillState(e).filled).toHaveLength(1)
  })
  it('fillsWithin: only fills whose whole area is made of the given points', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    const all = new Set([P, ...anchorsOf(d, P)])
    expect(fillsWithin(d, all)).toHaveLength(1)
    expect(fillsWithin(d, new Set(anchorsOf(d, P).slice(0, 2)))).toHaveLength(0)
  })
})

describe('Flip', () => {
  it('a filled triangle flipped in place stays filled', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    const before = cloneDoc(d)
    flipSeeds(d, new Set([P, ...anchorsOf(d, P)]), 'h')
    for (const e of d.entities) if (e.kind === 'point') e.x = 4 - e.x
    expect(fillState(d).filled).toHaveLength(1)
    const next = reconcileFills(before, d)
    expect(next).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/unit/sketch-fills-edits.unit.spec.ts` → FAIL (`flipSeeds` / `fillsWithin` not exported; copies carry no fills).

- [ ] **Step 3: Append to `frontend/app/lib/sketch/fills.ts`:**

```ts
// ── structural edits that rename pieces ─────────────────────────────────────

const TAU = Math.PI * 2

const sameLine = (s: FillSeed, a: EntityId, b: EntityId) => s.kind === 'line' && ((s.a === a && s.b === b) || (s.a === b && s.b === a))
const sameArc = (s: FillSeed, a: EntityId, b: EntityId, c: EntityId) => s.kind === 'arc' && s.c === c && ((s.a === a && s.b === b) || (s.a === b && s.b === a))

/** Cut: the piece a→b (an arc about c when given) now runs a→x→b, split at
 *  its own parameter tc. Seeds on it move onto the half they lie on. */
export function splitSeeds(doc: SketchDoc, a: EntityId, b: EntityId, c: EntityId | null, tc: number, x: EntityId): void {
  for (const f of doc.fills ?? []) {
    const s = f.seed
    if (!(c ? sameArc(s, a, b, c) : sameLine(s, a, b))) continue
    const fwd = s.a === a
    const t = fwd ? s.t : 1 - s.t
    const first = t <= tc
    const u = first ? t / tc : (t - tc) / (1 - tc)
    const [na, nb] = first ? [a, x] : [x, b]
    f.seed = { ...s, a: fwd ? na : nb, b: fwd ? nb : na, t: fwd ? u : 1 - u }
  }
}

/** Dissolve: pieces a→q and q→b became one piece a→b; `share` is how much of
 *  it the first piece was (by length for lines, by turn for arcs). An arc's
 *  centre becomes `c` (the first piece's). */
export function joinSeeds(doc: SketchDoc, a: EntityId, q: EntityId, b: EntityId, c1: EntityId | null, c2: EntityId | null, share: number): void {
  for (const f of doc.fills ?? []) {
    const s = f.seed
    const onFirst = c1 ? sameArc(s, a, q, c1) : sameLine(s, a, q)
    const onSecond = !onFirst && (c2 ? sameArc(s, q, b, c2) : sameLine(s, q, b))
    if (!onFirst && !onSecond) continue
    const fwd = onFirst ? s.a === a : s.a === q
    const t = fwd ? s.t : 1 - s.t
    const u = onFirst ? t * share : share + t * (1 - share)
    f.seed = { ...s, a: fwd ? a : b, b: fwd ? b : a, ...(c1 ? { c: c1 } : {}), t: fwd ? u : 1 - u }
  }
}

/** Merging point `from` into `into`: seeds naming it name `into`. */
export function renameSeedPoints(doc: SketchDoc, from: EntityId, into: EntityId): void {
  const sw = (id: EntityId) => (id === from ? into : id)
  for (const f of doc.fills ?? []) {
    const s = f.seed
    if (s.kind === 'circle') { if (s.c === from) f.seed = { ...s, c: into } }
    else if (s.a === from || s.b === from || s.c === from) f.seed = { ...s, a: sw(s.a), b: sw(s.b), ...(s.c ? { c: sw(s.c) } : {}) }
  }
}

/** A seed carried onto a copy: points renamed by `map`; `mirror` (the axis
 *  angle, radians) reflects it, `turn` (radians) turns it about a centre. */
export function mapSeed(s: FillSeed, map: (id: EntityId) => EntityId, how: { mirror?: number; turn?: number } = {}): FillSeed {
  const out: FillSeed = { ...s, a: map(s.a), b: map(s.b), ...(s.c ? { c: map(s.c) } : {}) }
  const wrap = (u: number) => ((u % 1) + 1) % 1
  if (how.mirror != null) {
    if (s.kind === 'circle') out.t = wrap((2 * how.mirror) / TAU - s.t)
    else out.side = s.side === 1 ? -1 : 1
    if (s.kind === 'arc') out.ccw = !s.ccw
  }
  if (how.turn != null && s.kind === 'circle') out.t = wrap(s.t + how.turn / TAU)
  return out
}

/** The live fills whose whole area is bounded by pieces made only of the
 *  points in `ids` — what a copy of those points carries. */
export function fillsWithin(doc: SketchDoc, ids: ReadonlySet<EntityId>): SketchFill[] {
  if (!doc.fills?.length) return []
  const fs = fillFaces(doc)
  return doc.fills.filter(f => {
    const g = resolveFill(fs, f)
    if (g == null) return false
    for (const ci of faceCycles(fs, g)) {
      for (const h of fs.cycles[ci]!.edges) {
        const p = fs.pieces[fs.halfEdges[h]!.piece]!
        if (p.kind === 'circle' && !ids.has(p.id)) return false
      }
    }
    return boundaryPoints(fs, g).every(id => ids.has(id))
  })
}

/** Flip (⇧H / ⇧V) turns these points over in place: the fills inside them
 *  lie on the other side of their lines, and a circle's seed turns with it.
 *  Call before the points move. (Flip keeps each arc's turning, so an arc
 *  seed is left for reconcileFills to carry.) */
export function flipSeeds(doc: SketchDoc, ids: ReadonlySet<EntityId>, axis: 'h' | 'v'): void {
  const inside = new Set(fillsWithin(doc, ids).map(f => f.id))
  if (!inside.size) return
  doc.fills = doc.fills!.map(f => {
    if (!inside.has(f.id)) return f
    const s = f.seed
    if (s.kind === 'line') return { id: f.id, seed: { ...s, side: s.side === 1 ? -1 : 1 } }
    if (s.kind === 'circle') return { id: f.id, seed: { ...s, t: ((((axis === 'h' ? 0.5 : 0) - s.t) % 1) + 1) % 1 } }
    return f
  })
}
```

- [ ] **Step 4: `trim.ts`** — add after `import { tangentTouchPoint } from './tangency'`:

```ts
import { splitSeeds, joinSeeds, renameSeedPoints } from './fills'
```

In `cutAt`, the line-entity branch: after `followPair(doc, p1, p2, { kind: 'cut', x })` add

```ts
    splitSeeds(doc, p1, p2, null, t, x)   // pen stage 7: a fill's seed stays on its half
```

and the path branch's tail

```ts
  followPair(doc, a, b, { kind: 'cut', x })
  splitSegment(doc, path, ref.segIndex, x)
  return x
```

becomes

```ts
  followPair(doc, a, b, { kind: 'cut', x })
  const seg = path.segments[ref.segIndex]!
  splitSeeds(doc, a, b, seg.kind === 'arc' ? seg.center : null, t, x)   // pen stage 7
  splitSegment(doc, path, ref.segIndex, x)
  return x
```

In `dissolveAt`, right after `const sIn = path.segments[inSeg]!, sOut = path.segments[outSeg]!` add

```ts
  // pen stage 7: how much of the merged piece the first half was (by turn for
  // arcs, by length for lines) — a fill's seed on either half moves onto it
  const gIn = curveGeom(doc, { kind: 'seg', pathId, segIndex: inSeg })
  const gOut = curveGeom(doc, { kind: 'seg', pathId, segIndex: outSeg })
  const partOf = (g: typeof gIn) => (!g ? 0 : g.kind === 'line' ? dist(g.a!, g.b!) : Math.abs(g.sweepAngle!))
  const share = partOf(gIn) / Math.max(1e-12, partOf(gIn) + partOf(gOut))
  joinSeeds(doc, a, q, b, sIn.kind === 'arc' ? sIn.center : null, sOut.kind === 'arc' ? sOut.center : null, share)
```

In `mergePoints`, right after the loop that re-points rules (`for (const c of doc.constraints) { if (c.refs.includes(from)) { … } }`) and before `doc.entities = doc.entities.filter(e => e.id !== from)`, add

```ts
  renameSeedPoints(doc, from, into)   // pen stage 7: a fill's seed names the merged point
```

- [ ] **Step 5: `edit.ts`** — the model type import gains `SketchFill`; add `import { fillsWithin, freshFillId, mapSeed } from './fills'` after `import { freshId } from './ids'`. `copyStructure` gains an optional last parameter and records circle copies:

```ts
// `ents` (pen stage 7): records each copied circle's new id, for its fills
function copyStructure(doc: SketchDoc, ids: EntityId[], map: Map<EntityId, EntityId>, flipSweep: boolean, ents?: Map<EntityId, EntityId>): EntityId[] {
```

with its circle line becoming

```ts
    else if (e.kind === 'circle') { const nc = addCircle(doc, map.get(e.center)!, e.r, e.construction ? { construction: true } : {}); ents?.set(e.id, nc); created.push(nc) }
```

Add above `copyClosureConstraints`:

```ts
// pen stage 7: the fills a copy carries, re-seeded onto it
function copyFills(doc: SketchDoc, fills: SketchFill[], map: Map<EntityId, EntityId>, ents: Map<EntityId, EntityId>, how: { mirror?: number; turn?: number }): void {
  if (!fills.length) return
  const m = (id: EntityId) => map.get(id) ?? ents.get(id) ?? id
  for (const f of fills) {
    const list = doc.fills ?? (doc.fills = [])
    list.push({ id: freshFillId(doc), seed: mapSeed(f.seed, m, how) })
  }
}
```

In `repeatEntities`, after `if (!pts.every(pid => !!getPoint(doc, pid))) return []` add `const carried = fillsWithin(doc, new Set([...pts, ...ids]))`, and in the loop replace

```ts
    created.push(...copyStructure(doc, ids, map, false))
    copyClosureConstraints(doc, map)
```

with

```ts
    const ents = new Map<EntityId, EntityId>()
    created.push(...copyStructure(doc, ids, map, false, ents))
    copyClosureConstraints(doc, map)
    copyFills(doc, carried, map, ents, { turn: rad })
```

In `mirrorEntities`, after its `if (!pts.every(pid => !!getPoint(doc, pid))) return []` add the same `const carried = …` line, and replace

```ts
  created.push(...copyStructure(doc, ids, map, true))
  copyClosureConstraints(doc, map)
```

with

```ts
  const ents = new Map<EntityId, EntityId>()
  created.push(...copyStructure(doc, ids, map, true, ents))
  copyClosureConstraints(doc, map)
  copyFills(doc, carried, map, ents, { mirror: Math.atan2(diry, dirx) })
```

(`carried` is read BEFORE any copy exists, so it is the source's fills only.)

- [ ] **Step 6: `clipboard.ts`** — add `import { fillsWithin, freshFillId, mapSeed } from './fills'` after the `pieces` import. In `extractPieces`, before `return out`:

```ts
  // pen stage 7: the fills whose whole area is copied go with it
  const fills = fillsWithin(doc, keep)
  if (fills.length) {
    out.fills = fills.map(f => ({ id: f.id, seed: { ...f.seed } }))
    if (doc.fillGap != null) out.fillGap = doc.fillGap
  }
```

In `insertPieces`, right after `for (const c of clip.constraints) addConstraint(doc, c.kind, c.refs.map(m), c.value)`:

```ts
  // pen stage 7: the copy's fills, on the pasted pieces
  for (const f of clip.fills ?? []) {
    const list = doc.fills ?? (doc.fills = [])
    list.push({ id: freshFillId(doc), seed: mapSeed(f.seed, m) })
  }
  if (clip.fills?.length && doc.fillGap == null && clip.fillGap != null) doc.fillGap = clip.fillGap
```

In `scalePieces`, replace `return { entities, constraints }` with:

```ts
  const out: SketchDoc = { entities, constraints }
  // pen stage 7: seeds by the same ids; upside down, each lies on the other side
  if (clip.fills?.length) {
    out.fills = clip.fills.map(f => ({ id: f.id, seed: flipY ? mapSeed(f.seed, id => id, { mirror: 0 }) : { ...f.seed } }))
    if (clip.fillGap != null) out.fillGap = clip.fillGap * factor
  }
  return out
```

- [ ] **Step 7: Run the tests to see them pass** — `npx vitest run tests/unit/sketch-fills-edits.unit.spec.ts tests/unit/sketch-fills-carry.unit.spec.ts tests/unit/sketch-fills.unit.spec.ts tests/unit/pen-trim.unit.spec.ts tests/unit/sketch-clipboard.unit.spec.ts tests/unit/pen-copy-paste.unit.spec.ts` and every existing `tests/unit/{sketch,pen}*` file that touches repeat / mirror / merge (`ls tests/unit | grep -E '^(sketch|pen)'`; running the whole `tests/unit/{sketch,pen}*` set is fine — 70-odd files, about a minute) → PASS.

- [ ] **Step 8: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(fills|trim|edit|clipboard)\.ts'` → no output.

- [ ] **Step 9: Commit** `frontend/app/lib/sketch/fills.ts frontend/app/lib/sketch/trim.ts frontend/app/lib/sketch/edit.ts frontend/app/lib/sketch/clipboard.ts frontend/tests/unit/sketch-fills-edits.unit.spec.ts` — message `feat(pen): Cut, Dissolve, joins, Repeat, Mirror, Copy / Paste and Flip carry fills (stage 7)`.

---

### Task 5: The Fill tool in the shared pen — hover, click, the settle, G, Flip

**Files:**
- Modify: `frontend/app/composables/pen/penHistory.ts` (`current()`)
- Modify: `frontend/app/composables/pen/usePen.ts`
- Modify: `frontend/app/composables/pen/penKeys.ts` (G)
- Modify: `frontend/app/composables/pen/penCopies.ts` (Flip)
- Test: `frontend/tests/unit/pen-fills.unit.spec.ts`

**Behaviour (Rulings 3, 6, 8, 13, 16):**
- `PenTool` gains `'fill'`; it is in `ALL_PEN_TOOLS` (so the pen page offers it by default) and dropped for an open-only pen, like Circle. `TOOL_KEYS.g = 'fill'` (the existing tool-key rules: no modifier, only when the host offers it, a live gesture settles first).
- `fillMove(x, y)` (drawing coords, Fill tool only) sets `fillHover` to `{ d, filled }` for the face under the point — the drawing's own gap, or 6 px at this zoom before the first fill — or `null`; it replaces the shallowRef only when the hovered outline or its state changed. Faces are read on `toRaw(doc.value)` and come from the geometry-keyed cache.
- `fillClick(x, y)` fills or empties that face (`toggleFillAt` on the raw drawing), then `commitHistory()` once; status "Filled" / "Emptied"; a click on no face: status `FILL_MISS` ("Click inside an enclosed area"), nothing else.
- **The settle:** `commitHistory` (the pen's, used by every verb) first runs `settleFills()` — when the drawing has fills, `reconcileFills(penHistory.current(), raw)` and write the result (or delete both fields when none is left); with no fills it only drops a stray `fillGap` — then pushes the snapshot. `penHistory.current()` is the last settled drawing, raw (never through the history's reactive proxy). Undo / redo restore snapshots that already hold the fields.
- `fillView()` → `{ d, gaps, filled, asleep }` for the overlay (the filled faces' outline in drawing space, the gap markers, counts) — `NO_FILLS` without work when the drawing has no fills.
- `clearToolHover` (tool change, pointer leaving, undo / redo, session end) clears `fillHover`; the placement glow (`hoverSnap`) is off in Fill like in Trim / Cut / Dissolve.
- An open-only pen pastes a copy without its fills (`withoutFills`).
- Flip (`penCopies.flip`) turns the fills inside the flipped points over (`flipSeeds`) BEFORE moving them.

**Interfaces:**
- Consumes: `FILL_GAP_PX`, `fillTarget`, `toggleFillAt`, `fillState`, `gapMarkers`, `reconcileFills`, `withoutFills`, `flipSeeds` (fills.ts); `facesD` (faces.ts).
- Produces: `PenTool` `'fill'`; `FILL_MISS`; `interface FillView { d: string; gaps: Vec2[]; filled: number; asleep: number }`; pen API `fillHover: ShallowRef<{ d: string; filled: boolean } | null>`, `fillMove(x, y)`, `fillClick(x, y)`, `fillView(): FillView`; `penHistory.current(): SketchDoc | null`; `TOOL_KEYS.g`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-fills.unit.spec.ts`:

```ts
// tests/unit/pen-fills.unit.spec.ts
// Pen stage 7, the shared pen's Fill tool: hover shows the area (and whether
// it is filled), a click fills or empties it as one undo step, the first fill
// fixes the gap at 6 px of this zoom, every settled step carries fills (a line
// drawn across fills both halves), G picks the tool and a text-guide pen has
// none, Flip keeps a filled shape filled, the hover stays cheap on one
// connected drawing, and a drawing with no fills does no face work.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath, addLine, addCircle } from '~/lib/sketch/edit'
import { usePen, FILL_MISS } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function penWithSquare(options?: any) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const ids = [[1, 1], [5, 1], [5, 5], [1, 5]].map(([x, y]) => addPoint(doc.value, x!, y!))
  addPath(doc.value, ids, ids.map(() => ({ kind: 'line' as const })), true)
  let changes = 0
  const pen = usePen({ doc, view: ref(DEV), options, onChange: () => { changes++ } })
  return { doc, pen, ids, changes: () => changes }
}
describe('the pen’s Fill tool', () => {
  it('hover shows the area, click fills it as one step, click again empties it; undo / redo', () => {
    const { doc, pen, changes } = penWithSquare()
    expect(pen.options.tools).toContain('fill')
    pen.selectTool('fill')
    pen.fillMove(2, 2)
    expect(pen.fillHover.value?.filled).toBe(false)
    expect(pen.fillHover.value?.d).toMatch(/^M .* Z$/)
    const c0 = changes()
    pen.fillClick(2, 2)
    expect(changes()).toBe(c0 + 1)
    expect(doc.value.fills?.length).toBe(1)
    expect(doc.value.fillGap).toBeCloseTo(6 / 34, 9)
    expect(pen.status.value).toBe('Filled')
    expect(pen.fillView().filled).toBe(1)
    expect(pen.fillHover.value?.filled).toBe(true)
    pen.fillClick(2, 2)
    expect(doc.value.fills).toBeUndefined()
    expect(pen.status.value).toBe('Emptied')
    pen.undo(); expect(pen.fillView().filled).toBe(1)
    pen.redo(); expect(pen.fillView().filled).toBe(0)
    pen.fillClick(9, 9); expect(pen.status.value).toBe(FILL_MISS)
    pen.fillMove(9, 9); expect(pen.fillHover.value).toBeNull()
  })
  it('a line drawn across a filled area fills both halves when it settles; undo takes both back', () => {
    const { doc, pen } = penWithSquare()
    pen.selectTool('fill'); pen.fillClick(2, 2)
    pen.selectTool('line')
    pen.place(3, 0); pen.place(3, 6)
    expect(pen.fillView().filled).toBe(2)
    expect(doc.value.fills!.length).toBe(2)
    pen.undo()
    expect(pen.fillView().filled).toBe(1)
  })
  it('G picks the Fill tool; a text-guide pen offers no Fill', () => {
    const { pen } = penWithSquare()
    const ev = { key: 'g', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} } as any
    expect(pen.onKeydown(ev)).toBe(true)
    expect(pen.tool.value).toBe('fill')
    const g = penWithSquare({ openOnly: true })
    expect(g.pen.options.tools).not.toContain('fill')
    expect(g.pen.onKeydown(ev)).toBe(false)
  })
  it('Flip keeps a filled shape filled', () => {
    const { doc, pen } = penWithSquare()
    pen.selectTool('fill'); pen.fillClick(2, 2)
    pen.selectTool('select')
    const path = doc.value.entities.find(e => e.kind === 'path')!
    pen.pick(path.id, false)
    pen.flip('h')
    expect(pen.fillView().filled).toBe(1)
    expect(doc.value.fills!.length).toBe(1)
  })
  it('the Fill hover stays cheap on one connected drawing of 161 pieces', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const d = doc.value
    const O = addPoint(d, 0, 0); addCircle(d, O, 10)
    for (let k = 0; k < 64; k++) {
      const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
      const s = addPoint(d, 10 * Math.cos(a0), 10 * Math.sin(a0)), e = addPoint(d, 10 * Math.cos(a1), 10 * Math.sin(a1))
      addPath(d, [s, e], [
        { kind: 'arc', center: addPoint(d, 9 * Math.cos(am), 9 * Math.sin(am)), sweep: 1 },
        { kind: 'arc', center: addPoint(d, 14 * Math.cos(am), 14 * Math.sin(am)), sweep: 1 },
      ], true)
      if (k % 2 === 0) addLine(d, O, s)
    }
    const pen = usePen({ doc, view: ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 }) })
    pen.selectTool('fill')
    pen.fillClick(3, 1)
    expect(pen.fillView().filled).toBe(1)
    pen.fillMove(3, 1.1)   // warm
    const t = performance.now()
    for (let i = 0; i < 50; i++) pen.fillMove(3 + Math.cos(i) * 5, 1 + Math.sin(i) * 5)
    expect((performance.now() - t) / 50).toBeLessThan(2)
  })
  it('a drawing with no fills does no face work at commit', () => {
    const { doc, pen } = penWithSquare()
    pen.selectTool('line'); pen.place(7, 0); pen.place(7, 6)
    expect(doc.value.fills).toBeUndefined()
    expect(pen.fillView()).toEqual({ d: '', gaps: [], filled: 0, asleep: 0 })
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/unit/pen-fills.unit.spec.ts` → FAIL (`fill` is not a tool; `fillMove` is not a function).

- [ ] **Step 3: `penHistory.ts`** — `import { ref, type Ref } from 'vue'` → `import { ref, toRaw, type Ref } from 'vue'`; add before `function canUndo()`:

```ts
  /** The drawing as the last settled step left it (plain, never to be
   *  changed) — what the next step's fills are carried from (pen stage 7). */
  function current(): SketchDoc | null {
    const top = history.value[histPtr.value]
    return top ? toRaw(top) : null
  }
```

and add `current` to the returned object: `return { initHistory, commitHistory, undo, redo, canUndo, canRedo, revert, live, rev, current }`.

- [ ] **Step 4: `penKeys.ts`** — `TOOL_KEYS` gains `g: 'fill'`:

```ts
export const TOOL_KEYS: Record<string, PenTool> = {
  v: 'select', p: 'path', b: 'curve', l: 'line', o: 'circle', n: 'point',
  t: 'trim', c: 'cut', d: 'dissolve', g: 'fill',
}
```

- [ ] **Step 5: `penCopies.ts`** — `import type { Ref } from 'vue'` → `import { toRaw, type Ref } from 'vue'`; add `import { flipSeeds } from '~/lib/sketch/fills'` after the `edit` import; in `flip`, right after `const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2` add:

```ts
    // pen stage 7: the fills inside turn over with the points (before they move)
    flipSeeds(toRaw(ctx.doc.value), new Set([...ptIds, ...ctx.selection.value]), axis)
```

- [ ] **Step 6: `usePen.ts`** — eight edits:
  1. After `import { removeSpan, removeSegment, cutAt, canDissolve, dissolveAt, mergePoints, sameKey } from '~/lib/sketch/trim'` add:
     ```ts
     import { FILL_GAP_PX, fillTarget, toggleFillAt, fillState, gapMarkers, reconcileFills, withoutFills } from '~/lib/sketch/fills'
     import { facesD } from '~/lib/sketch/faces'
     ```
  2. The `PenTool` comment's last line and the type:
     ```ts
     // merges the two pieces at a point back into one (see the Trim section);
     // 'fill' fills and empties the areas the drawing encloses (pen stage 7).
     export type PenTool = 'select' | 'point' | 'line' | 'circle' | 'path' | 'curve' | 'trim' | 'cut' | 'dissolve' | 'fill'
     ```
  3. After `export const SPARKLE_LIFETIME_MS = 380` add:
     ```ts
     // pen stage 7: a Fill click that lands on no enclosed area
     export const FILL_MISS = 'Click inside an enclosed area'
     export interface FillView { d: string; gaps: Vec2[]; filled: number; asleep: number }
     const NO_FILLS: FillView = Object.freeze({ d: '', gaps: [], filled: 0, asleep: 0 }) as FillView
     ```
  4. `const ALL_PEN_TOOLS: PenTool[] = [..., 'dissolve']` gains `'fill'` at the end, and `if (openOnly) list = list.filter(t => t !== 'circle')` → `if (openOnly) list = list.filter(t => t !== 'circle' && t !== 'fill')`.
  5. Replace `const { commitHistory, initHistory, canUndo, canRedo } = penHistory` with:
     ```ts
     const { initHistory, canUndo, canRedo } = penHistory
     // Every settled step carries the fills first (pen stage 7): each area that
     // takes up part of a filled area is filled (a split fills both halves), two
     // fills on one area become one, a fill whose area opened sleeps — measured
     // against the drawing as the last step left it. A drawing with no fills
     // does no work here.
     function commitHistory() {
       settleFills()
       penHistory.commitHistory()
     }
     function settleFills(): void {
       const now = toRaw(doc.value)
       if (!now.fills?.length) { if (now.fillGap != null) delete now.fillGap; return }
       const before = penHistory.current()
       if (!before) return
       const next = reconcileFills(before, now)
       if (next.length) now.fills = next
       else { delete now.fills; delete now.fillGap }
     }
     ```
     (A function declaration, so `createPenCopies({ …, commitHistory })` further down and every verb get the settling version.)
  6. In `hoverSnap`: `if (!c || t === 'trim' || t === 'cut' || t === 'dissolve') return null` → `if (!c || t === 'trim' || t === 'cut' || t === 'dissolve' || t === 'fill') return null`.
  7. Right before `// the pointer left the drawing: nothing is under it any more` (the `clearToolHover` block) insert:
     ```ts
     // --- Fill (pen stage 7: lib/sketch/faces.ts + fills.ts) ---
     // Hovering shows the area under the pointer (fillHover: its outline in
     // drawing space, and whether it is filled — a click then empties it); a
     // click fills or empties it as one step. Faces are cached by geometry
     // (facesFor), so a hover where nothing moved is a lookup, and read on the
     // raw drawing (never through Vue's proxies). The first fill fixes the
     // drawing's gap (FILL_GAP_PX at this zoom, stored in drawing units).
     const fillHover = shallowRef<{ d: string; filled: boolean } | null>(null)
     const fillGapUnits = () => pxToUnits(FILL_GAP_PX, opts.view.value)
     function fillMove(x: number, y: number) {
       if (tool.value !== 'fill') return
       const t = fillTarget(toRaw(doc.value), { x, y }, fillGapUnits())
       const prev = fillHover.value
       if (!t) { if (prev) fillHover.value = null; return }
       if (!prev || prev.d !== t.d || prev.filled !== t.filled) fillHover.value = { d: t.d, filled: t.filled }
     }
     function fillClick(x: number, y: number) {
       if (tool.value !== 'fill') return
       const raw = toRaw(doc.value)
       const hit = fillTarget(raw, { x, y }, fillGapUnits())
       if (!hit) { status.value = FILL_MISS; return }
       if (!toggleFillAt(raw, { x, y }, fillGapUnits())) return
       commitHistory()
       status.value = hit.filled ? 'Emptied' : 'Filled'
       fillHover.value = null
       fillMove(x, y)
     }
     /** What the overlay shows for fills: the filled areas as one outline
      *  (drawing space), the rings at the open ends of a sleeping fill's drawing,
      *  and how many areas are filled / fills sleep. Nothing to do without fills. */
     function fillView(): FillView {
       const raw = toRaw(doc.value)
       if (!raw.fills?.length) return NO_FILLS
       const st = fillState(raw)
       return { d: st.filled.length ? facesD(st.fs, st.filled) : '', gaps: gapMarkers(raw), filled: st.filled.length, asleep: st.asleep.length }
     }

     ```
     and in `clearToolHover()` add `fillHover.value = null` as its first line.
  8. In `paste`, `let clip = c.doc` → 
     ```ts
     // a pen that can't fill (a text guide) takes the pieces without their fills
     let clip = openOnly ? withoutFills(c.doc) : c.doc
     ```
     and in the returned object, after the `// trim / cut / dissolve` group's second line, add:
     ```ts
     // fill (pen stage 7)
     fillHover, fillMove, fillClick, fillView,
     ```
  Fills are written on the RAW drawing (never through `doc.value`'s proxy); readers key on `docRevision`, which the commit right after bumps.

- [ ] **Step 7: Run the tests to see them pass** — `npx vitest run tests/unit/pen-fills.unit.spec.ts`, then the whole pen / sketch / host unit set `npx vitest run tests/unit/pen tests/unit/sketch tests/unit/frame-pen tests/unit/shape-pen tests/unit/geoshape` → all PASS (the toolbar has no Fill button yet — Task 6 — and the Frame / Shape Studio tool lists are unchanged until Tasks 7–8). Under load, vitest timing budgets can wobble: re-run a timing failure once alone before treating it as real.

- [ ] **Step 8: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'composables/pen/(usePen|penHistory|penKeys|penCopies)\.ts'` → no output.

- [ ] **Step 9: Commit** `frontend/app/composables/pen/penHistory.ts frontend/app/composables/pen/usePen.ts frontend/app/composables/pen/penKeys.ts frontend/app/composables/pen/penCopies.ts frontend/tests/unit/pen-fills.unit.spec.ts` — message `feat(pen): the Fill tool — hover shows the area, click fills or empties it, every step carries fills (stage 7)`.

---

### Task 6: What the pen shows — the tint, the hatch, the gap rings, the bucket button, the card and its demo

**Files:**
- Modify: `frontend/app/components/pen/PenOverlay.vue`
- Modify: `frontend/app/components/pen/PenToolbar.vue`
- Modify: `frontend/app/composables/pen/penTips.ts`, `frontend/app/composables/pen/penTipDemos.ts`
- Modify: `frontend/app/components/pen/PenTipCard.vue`
- Modify: `frontend/tests/unit/pen-tips.unit.spec.ts`
- Test: `frontend/tests/unit/pen-overlay-fills.unit.spec.ts`

**Behaviour (Rulings 13, 14):**
- Overlay, drawing space, first thing inside the non-preview group (under the outline): `<path data-fill-area>` with `fillView().d`, indigo `#6366f1` at 0.16 opacity, no stroke, no pointer events — in every tool, hidden during Clean up's preview. The computed reads `docRevision` (settled changes) and `pathDrawing` (live geometry) so it follows drags and never recomputes when nothing moved.
- Overlay, screen space, before the Trim hover: in the Fill tool with something under the pointer, a `<defs>` holding a 6 px 45° line `<pattern>` (indigo `#4f46e5`, red `#ef4444` when the area is filled) and a `<clipPath>` whose path is the hovered outline under `svgTransform`, and a full-size `<rect data-fill-hover :data-filled="yes|no">` filled with the pattern and clipped. Ids are unique per overlay (`useId()`, sanitised).
- Overlay, screen space, before the Dissolve ring: `<circle data-fill-gap>` r 6, amber `#f59e0b`, dashed, at each gap marker (hidden during the preview).
- Pointer: a Fill press calls `fillClick`, a Fill move `fillMove` (with Trim / Cut / Dissolve's leave-the-drawing handling).
- Toolbar: `{ id: 'fill', icon: PaintBucket }` after Dissolve; hint "Click an enclosed area to fill it, or a filled one to empty it".
- Card `fill`: name "Fill", key G, demo `fill`, caption "Fills an area the drawing encloses. Point to see the area, click to fill it; click a filled area to empty it."
- Demo `fill`: two crossing circles; the cursor goes into the lens (hatched from t 0.3), clicks at 0.5, the lens fills at 0.53 (the demo doc carries a real fill, `toggleFillAt`), then the cursor moves to the left crescent, hatched from 0.82. `PenTipFrame` gains `hatchAt?: Vec2`. The card draws the demo doc's `fillPathData` as `.fill-area` and the face under `hatchAt` (`fillTarget(doc, hatchAt, 0)`) with its own pattern, under the ink.

**Interfaces:**
- Consumes: Task 5's `fillHover`, `fillMove`, `fillClick`, `fillView`, `docRevision`; `fillPathData`, `fillTarget`, `toggleFillAt` (fills.ts).
- Produces: DOM hooks `[data-tool="fill"]`, `[data-fill-area]`, `[data-fill-hover][data-filled]`, `[data-fill-gap]`; `PEN_TIPS.fill`; `PEN_TIP_DEMOS.fill`; `PenTipFrame.hatchAt`.

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/pen-overlay-fills.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 7, PenOverlay: in Fill the area under the pointer is hatched
// (through a clip of its outline drawn under the view), filled areas are
// tinted, a sleeping fill rings its gap, undo brings the fill back.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
const { default: PenOverlay } = await import('~/components/pen/PenOverlay.vue')
const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mountSquare() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const ids = [[1, 1], [5, 1], [5, 5], [1, 5]].map(([x, y]) => addPoint(doc.value, x!, y!))
  addPath(doc.value, ids, ids.map(() => ({ kind: 'line' as const })), true)
  const pen = usePen({ doc, view: ref(view) })
  const wrapper = mount(PenOverlay, { props: { pen, view, width: 680, height: 460 }, attachTo: document.body })
  return { wrapper, doc, pen }
}
describe('PenOverlay fills', () => {
  it('hatches the area under the pointer in Fill, tints filled areas, rings a sleeping fill’s gap', async () => {
    const { wrapper, pen, doc } = mountSquare()
    pen.selectTool('fill')
    pen.fillMove(2, 2); await nextTick()
    const hover = wrapper.find('[data-fill-hover]')
    expect(hover.exists()).toBe(true)
    expect(hover.attributes('data-filled')).toBe('no')
    const clip = wrapper.find('clipPath path')
    expect(clip.attributes('d')).toMatch(/^M /)
    expect(clip.attributes('transform')).toMatch(/^matrix\(/)
    pen.fillClick(2, 2); await nextTick()
    expect(wrapper.find('[data-fill-area]').attributes('d')).toMatch(/Z$/)
    expect(wrapper.find('[data-fill-hover]').attributes('data-filled')).toBe('yes')
    // open the square: remove one side with Trim, the fill sleeps and rings show
    pen.selectTool('trim')
    pen.trimDown(3, 5); pen.trimUp(3, 5); await nextTick()
    expect(wrapper.find('[data-fill-area]').exists()).toBe(false)
    expect(wrapper.findAll('[data-fill-gap]').length).toBe(2)
    pen.undo(); await nextTick()
    expect(wrapper.find('[data-fill-area]').exists()).toBe(true)
    expect(wrapper.findAll('[data-fill-gap]').length).toBe(0)
    wrapper.unmount()
  })
})
```

and update `frontend/tests/unit/pen-tips.unit.spec.ts`:
  - `const ALL_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve']` → add `'fill'` at the end;
  - the keys expectation gains `fill: 'G'` (`… trim: 'T', cut: 'C', dissolve: 'D', fill: 'G' }`);
  - `it('the nine drawing and editing tools and Clean up have a demo, …` → `it('the ten drawing and editing tools and Clean up have a demo, …`;
  - add `import { fillPathData } from '~/lib/sketch/fills'` after the `sketchPath` import;
  - in `'%s acts out a gesture: …'` the changing-frames line becomes (Fill changes what is filled, not the outline):
    ```ts
        // (Fill changes what is filled, not the outline)
        expect(new Set(frames.map(f => sketchPathData(f.doc) + JSON.stringify(f.dots ?? []) + JSON.stringify(f.doc.fills ?? []))).size).toBeGreaterThan(1)
    ```
  - add before `it('trim removes the hovered piece and leaves a ghost of it', …`:
    ```ts
      it('fill shows the lens hatched, fills it on the click, then points at the crescent', () => {
        const hover = PEN_TIP_DEMOS.fill!(0.4)
        const done = PEN_TIP_DEMOS.fill!(0.7)
        const next = PEN_TIP_DEMOS.fill!(0.9)
        expect(hover.hatchAt).toBeTruthy()
        expect(hover.doc.fills).toBeUndefined()
        expect(done.doc.fills).toHaveLength(1)
        expect(fillPathData(done.doc)).toMatch(/^M .* Z$/)
        expect(next.hatchAt && next.hatchAt.x).toBeLessThan(60)
      })
    ```

- [ ] **Step 2: Run them to see them fail** — `npx vitest run tests/unit/pen-overlay-fills.unit.spec.ts tests/unit/pen-tips.unit.spec.ts` → FAIL (no `[data-fill-hover]`; no `fill` tip or demo).

- [ ] **Step 3: `PenOverlay.vue`** — script:
  - `import { ref, computed, watch, onMounted, onUnmounted } from 'vue'` → add `useId`.
  - The destructured pen list gains a line before `} = props.pen`: `fillHover, fillMove, fillClick, fillView, docRevision,`.
  - After the `dissolveHoverScreen` computed add:
    ```ts
    // ---------- Fill (pen stage 7) ----------
    // The filled areas, a soft tint in drawing space under the outline, in every
    // tool; the rings at the open ends of a sleeping fill's drawing (screen
    // space); and in the Fill tool the area under the pointer, hatched in screen
    // space (so the hatch keeps its spacing under any zoom or rotation) through a
    // clip of that area's outline drawn in drawing space. Read on the drawing as
    // it settles (docRevision) and as it moves (pathDrawing).
    const fillShown = computed(() => { void docRevision.value; void pathDrawing.value; return fillView() })
    const fillGapScreens = computed(() => fillShown.value.gaps.map(p => toScreen(p)))
    const fillHoverShown = computed(() => (tool.value === 'fill' && !cleanupSession.value ? fillHover.value : null))
    // ids unique to this overlay (a page may show two pens)
    const fillUid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const hatchId = `pen-fill-hatch-${fillUid}`
    const hatchClipId = `pen-fill-clip-${fillUid}`
    ```
  - In `onPointerDownSvg`, after `if (tool.value === 'dissolve') { dissolveClick(w.x, w.y); return }` add `if (tool.value === 'fill') { fillClick(w.x, w.y); return }`.
  - In `onPointerMove`, the Trim / Cut / Dissolve block becomes:
    ```ts
      if (tool.value === 'trim' || tool.value === 'cut' || tool.value === 'dissolve' || tool.value === 'fill') {
        const w = drawingXY(ev)
        if (!w) { clearToolHover(); return }
        if (tool.value === 'trim') trimMove(w.x, w.y)
        else if (tool.value === 'cut') cutMove(w.x, w.y)
        else if (tool.value === 'fill') fillMove(w.x, w.y)
        else dissolveMove(w.x, w.y)
        return
      }
    ```
  Template:
  - `<template v-if="!cleanupSession">` + the outline path becomes:
    ```vue
          <template v-if="!cleanupSession">
          <!-- filled areas (pen stage 7): a soft tint under the outline -->
          <path v-if="fillShown.d" :d="fillShown.d" fill="#6366f1" fill-opacity="0.16" stroke="none" pointer-events="none" data-fill-area />
          <path :d="pathDrawing" fill="none" stroke="#3730a3" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    ```
  - Right before `<g v-if="trimHoverD" :transform="svgTransform" pointer-events="none" data-trim-hover>`:
    ```vue
        <!-- Fill: the area under the pointer, hatched (indigo: a click fills it;
             red: it is filled and a click empties it) -->
        <template v-if="fillHoverShown">
          <defs>
            <pattern :id="hatchId" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" :stroke="fillHoverShown.filled ? '#ef4444' : '#4f46e5'" stroke-width="1.5" />
            </pattern>
            <clipPath :id="hatchClipId">
              <path :d="fillHoverShown.d" :transform="svgTransform" />
            </clipPath>
          </defs>
          <rect x="0" y="0" :width="width" :height="height" :fill="`url(#${hatchId})`" :clip-path="`url(#${hatchClipId})`"
                opacity="0.7" pointer-events="none" data-fill-hover :data-filled="fillHoverShown.filled ? 'yes' : 'no'" />
        </template>
    ```
  - Right before `<circle v-if="dissolveHoverScreen" …`:
    ```vue
        <!-- a sleeping fill: rings at the open ends that keep its area from closing -->
        <template v-if="!cleanupSession">
          <circle v-for="(g, i) in fillGapScreens" :key="'fillgap-' + i" :cx="g.x" :cy="g.y" r="6" fill="none"
                  stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 2.5" pointer-events="none" data-fill-gap />
        </template>
    ```

- [ ] **Step 4: `PenToolbar.vue`** — add `PaintBucket` to the `lucide-vue-next` import; `ALL_TOOLS` gains `{ id: 'fill', icon: PaintBucket },` after the Dissolve entry; `TOOL_HINTS` gains `fill: 'Click an enclosed area to fill it, or a filled one to empty it',` after `dissolve`.

- [ ] **Step 5: `penTips.ts`** — the header's "The nine drawing and editing tools" → "The ten drawing and editing tools"; add before the `cleanup` entry:

```ts
  fill: { name: 'Fill', key: 'G', demo: 'fill',
    caption: 'Fills an area the drawing encloses. Point to see the area, click to fill it; click a filled area to empty it.' },
```

- [ ] **Step 6: `penTipDemos.ts`** — add `import { toggleFillAt } from '~/lib/sketch/fills'` after the `geom` import; `PenTipFrame` gains, after `hot?: Vec2[]`:

```ts
  /** the Fill tool's hover: the area under this point is shown hatched */
  hatchAt?: Vec2
```

add before the Clean up demo:

```ts
// Fill: two crossing circles; point into the lens (it shows hatched), click,
// it fills; then point at the left crescent, which shows hatched in turn.
// The doc carries a real fill, so the card draws it the way the pen does.
function fill(t: number): PenTipFrame {
  const CA = v(62, 48), CB = v(98, 48), r = 26
  const lens = v(80, 48), crescent = v(47, 48)
  const cursor = track(t, [[0.04, v(140, 88)], [0.32, v(lens.x + 1, lens.y + 3)], [0.64, v(lens.x + 1, lens.y + 3)], [0.84, v(crescent.x + 1, crescent.y + 3)]])
  const filled = t >= 0.53
  const s = sk().circle(CA, r).circle(CB, r)
  if (filled) toggleFillAt(s.doc, lens, 0)
  return {
    doc: s.doc, cursor, pressed: within(t, 0.5, 0.56),
    hatchAt: t >= 0.3 && t < 0.5 ? lens : t >= 0.82 ? crescent : undefined,
    ...sparkleAt(t, 0.53, lens),
  }
}
```

and `PEN_TIP_DEMOS` becomes `{ select, path, curve, line, circle, point, trim, cut, dissolve, fill, cleanup, }`.

- [ ] **Step 7: `PenTipCard.vue`** — `import { computed, onBeforeUnmount, ref, watch } from 'vue'` → add `useId`; add `import { fillPathData, fillTarget } from '~/lib/sketch/fills'` after the `sketchPath` import; after the `ghostD` computed:

```ts
// the Fill demo: the areas its drawing fills, and the area under its hover
const fillD = computed(() => (frame.value?.doc.fills?.length ? fillPathData(frame.value.doc) : ''))
const hatchD = computed(() => (frame.value?.hatchAt ? fillTarget(frame.value.doc, frame.value.hatchAt, 0)?.d ?? '' : ''))
const hatchId = `pen-tip-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
```

in the demo svg's `<template v-if="frame">`, before `<path v-if="ghostD" …>`:

```vue
            <defs v-if="hatchD">
              <pattern :id="hatchId" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="5" class="hatch-line" />
              </pattern>
            </defs>
            <path v-if="fillD" :d="fillD" class="fill-area" />
            <path v-if="hatchD" :d="hatchD" class="fill-hatch" :fill="`url(#${hatchId})`" />
```

and in the style block, before `.pen-tip-demo .ghost {`:

```css
.pen-tip-demo .fill-area { fill: var(--tip-hot); fill-opacity: 0.3; stroke: none; }
.pen-tip-demo .fill-hatch { stroke: none; }
.pen-tip-demo .hatch-line { stroke: var(--tip-hot); stroke-width: 1.4; }
```

- [ ] **Step 8: Run the tests to see them pass** — `npx vitest run tests/unit/pen-overlay-fills.unit.spec.ts tests/unit/pen-tips.unit.spec.ts` and every `tests/unit/pen-overlay-*`, `tests/unit/pen-toolbar-*`, `tests/unit/pen-menu-components.unit.spec.ts`, `tests/unit/pen-properties.unit.spec.ts` → PASS.

- [ ] **Step 9: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'components/pen/(PenOverlay|PenToolbar|PenTipCard)\.vue|composables/pen/(penTips|penTipDemos)\.ts'` → no output.

- [ ] **Step 10: Commit** `frontend/app/components/pen/PenOverlay.vue frontend/app/components/pen/PenToolbar.vue frontend/app/components/pen/PenTipCard.vue frontend/app/composables/pen/penTips.ts frontend/app/composables/pen/penTipDemos.ts frontend/tests/unit/pen-overlay-fills.unit.spec.ts frontend/tests/unit/pen-tips.unit.spec.ts` — message `feat(pen): filled areas tinted, the area under the Fill tool hatched, gap rings, the bucket button, card and demo (stage 7)`.

---

### Task 7: The Frame — `fillD` in the layer, painted, exported, written by the pen

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (four hunks: `PathLayer.fillD`, `resolveMorphs`' swap, the path branch of the geometry-effect draw, `drawPath`)
- Modify: `frontend/app/composables/useVectorSvg.ts` (one hunk), `frontend/app/lib/shapes/pathLayer.ts` (one hunk)
- Modify: `frontend/app/lib/compositor/penFrame.ts`, `frontend/app/composables/frame/useFramePenSession.ts`
- Modify: `frontend/tests/unit/frame-pen-session.unit.spec.ts` (the new-drawing tools list)
- Test: `frontend/tests/unit/frame-path-fill.unit.spec.ts` (+ its snapshot file), `frontend/tests/unit/frame-pen-fills.unit.spec.ts`

**Behaviour (Rulings 9–11):**
- `PathLayer.fillD?: string` — the invariant in its doc comment (present iff the drawing has a filled area, then `=== sketchFillToLocalD(sketch)`).
- `drawPath`: with `fillD`, the fill paints `path2dFor(fillD)` with `'nonzero'`; the stroke stack still strokes `d` (same `path`, `fillRule` and `outline` arguments as today). Without `fillD`, every call is exactly as before — proven by a call-log snapshot recorded at HEAD before `drawPath` is touched (Steps 1–2).
- A layer with a geometry effect: the effect runs on `fillD` too (`computedOutlineD({ ...layer, d: layer.fillD }, W, rs)`). Morph's swap sets `fillD: undefined`; Morph's per-letter pieces draw with `fillD: undefined`.
- The SVG export's fill `<path>` uses `fillD` with `fill-rule="nonzero"` when present, else `d` and the layer's rule as today. `swapShapeLayer` drops `fillD` with `sketch`.
- `penFrame.ts`: `sketchFillToLocalD(sketch)` = `fillPathData(sketch, 1 / SKETCH_UNITS)` (faces found in drawing units, so the pen's overlay and the host's preview share one cached answer; only the numbers are scaled); `penOutlines(sketch)` → `{ d, fillD? }`; `withPenOutlines(l, sketch)` → `l` without its old `fillD`, with `d`, `sketch` and `fillD` only when filled — for a drawing without fills exactly `{ ...l, d, sketch }` (same keys, same order).
- `useFramePenSession.ts`: `FRAME_PEN_TOOLS` gains `'fill'` (not `GUIDE_PEN_TOOLS`); `isClosedDrawing` also counts a filled area; `filledStyle(l)` — `{ fill: '#3b82f6' }` when `l.fill` paints nothing, else `{}`. A layer session's preview writes `withPenOutlines(l, sk)` and, when that gives a `fillD` and the layer's fill paints nothing, `filledStyle(l)` too (remembered in `penFilled`); Cancel puts back `d`, `sketch`, `fillD` (or its absence) and — only if the pen gave it — the old `fill`. Commit (new drawing, re-centred layer, cloner layer) writes through `penOutlines` / `withPenOutlines`. A text guide never keeps fills: `openGuide` starts from `withoutFills(...)` and `guideWrite` stores `withoutFills(...)`.

**Interfaces:**
- Consumes: `fillPathData`, `withoutFills` (fills.ts); `hasPaint` (`lib/paint/resolve.ts`); Task 5's pen Fill API (the tests drive it).
- Produces: `PathLayer.fillD`; `sketchFillToLocalD`, `penOutlines`, `withPenOutlines` (penFrame.ts); `filledStyle`, `FRAME_PEN_TOOLS` with `'fill'` (useFramePenSession.ts).

- [ ] **Step 1: Record today's painting BEFORE touching the painter** — create `frontend/tests/unit/frame-path-fill.unit.spec.ts` with exactly:

```ts
// tests/unit/frame-path-fill.unit.spec.ts
// Pen stage 7, the Frame's painter: the canvas calls a path layer makes,
// recorded on a stand-in context (node has no canvas). The snapshot was
// written BEFORE drawPath learnt fillD — a layer without fillD must keep
// making exactly those calls. A layer with fillD fills it (non-zero) and
// strokes d; the SVG export and the shape swap treat fillD the same way.
import { describe, it, expect } from 'vitest'
class FakePath2D { constructor(public d: string) {} }
;(globalThis as any).Path2D = FakePath2D
const { drawLocalLayer, createPathLayer } = await import('~/composables/useCompositorLayers')

function record(layer: any): string[] {
  const log: string[] = []
  const fmt = (v: unknown) => (v instanceof FakePath2D ? `Path(${v.d})` : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const ctx: any = new Proxy({ canvas: { width: 1000, height: 800 } }, {
    get(t, k) {
      if (k in t) return (t as any)[k]
      if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return (...args: unknown[]) => { log.push(`${String(k)}(${args.map(fmt).join(', ')})`) }
    },
    set(t, k, v) { log.push(`${String(k)} = ${fmt(v)}`); (t as any)[k] = v; return true },
  })
  drawLocalLayer(ctx, layer, 1000, 800)
  return log
}
const TRI = 'M 0 0 L 0.1 0 L 0.05 0.1 Z'
const OPEN = 'M 0 0 L 0.1 0 M 0.02 -0.02 L 0.05 0.1'
const CASES: Record<string, any> = {
  'closed drawing, fill only': createPathLayer({ id: 'a', d: TRI, sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '', strokeWidth: 0 } as any),
  'open drawing, stroke only': createPathLayer({ id: 'b', d: OPEN, sketch: { entities: [], constraints: [] }, fill: 'none', stroke: '#3b82f6', strokeWidth: 0.004 } as any),
  'library path, even-odd, fill and stroke': createPathLayer({ id: 'c', d: TRI + ' M 0.03 0.02 L 0.07 0.02 L 0.05 0.06 Z', fillRule: 'evenodd', fill: '#111111', stroke: '#eeeeee', strokeWidth: 0.002, rotation: 12, scale: 1.5 } as any),
}
describe('a Frame path layer paints exactly as before stage 7 when it has no fillD', () => {
  for (const [name, layer] of Object.entries(CASES)) it(name, () => { expect(record(layer)).toMatchSnapshot() })
})
```

- [ ] **Step 2: Write the snapshot at HEAD** — `npx vitest run tests/unit/frame-path-fill.unit.spec.ts` → PASS with "3 written"; `frontend/tests/unit/__snapshots__/frame-path-fill.unit.spec.ts.snap` now holds today's call logs. Never regenerate it (`-u`) in this task: it is the byte-identity proof.

- [ ] **Step 3: Add the failing tests** — append to `frontend/tests/unit/frame-path-fill.unit.spec.ts`:

```ts
describe('a layer with fillD fills it and strokes d', () => {
  it('fills fillD non-zero, strokes d', () => {
    const l = createPathLayer({ id: 'f', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] }, fillRule: 'evenodd', fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004 } as any)
    const log = record(l)
    expect(log).toContain(`fill(Path(${TRI}), nonzero)`)
    expect(log).toContain(`stroke(Path(${OPEN}))`)
    expect(log.some(x => x.startsWith('fill(Path(' + OPEN))).toBe(false)
  })
})
describe('the other writers of a path layer', () => {
  it('the SVG export fills fillD non-zero and keeps d for the outline', async () => {
    const { pathLayersToSvgDoc } = await import('~/composables/useVectorSvg')
    const l = createPathLayer({ id: 'f', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004 } as any)
    const { svg } = pathLayersToSvgDoc([l as any], 1)
    expect(svg).toContain(`<path d="${TRI}" fill="#3b82f6" fill-rule="nonzero"/>`)
    expect(svg).toContain(`d="${OPEN}"`)
    const plain = createPathLayer({ id: 'g', d: TRI, fillRule: 'evenodd', fill: '#3b82f6' } as any)
    expect(pathLayersToSvgDoc([plain as any], 1).svg).toContain(`<path d="${TRI}" fill="#3b82f6" fill-rule="evenodd"/>`)
  })
  it('swapping in a library shape drops fillD with the sketch', async () => {
    const { swapShapeLayer } = await import('~/lib/shapes/pathLayer')
    const { SHAPES } = await import('~/lib/shapes/catalog')
    const l = createPathLayer({ id: 'f', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] } } as any)
    const out = swapShapeLayer(l as any, SHAPES[0]!)
    expect(out.sketch).toBeUndefined()
    expect(out.fillD).toBeUndefined()
  })
})
```

and create `frontend/tests/unit/frame-pen-fills.unit.spec.ts`:

```ts
// tests/unit/frame-pen-fills.unit.spec.ts
// Pen stage 7, the Frame's pen session: Fill is offered; a filled drawing
// counts as closed; fillD is written only when an area is filled (and a
// drawing without fills writes exactly what it did before); a new drawing of
// open lines with a filled area becomes a filled layer; reopening an open
// layer and filling it previews fillD and the pen's fill colour, and Cancel
// puts both back; a text guide never keeps fills.
import { describe, it, expect, vi } from 'vitest'
import { addPoint, addPath, addLine } from '~/lib/sketch/edit'
import { sketchToLocalD, sketchFillToLocalD, withPenOutlines } from '~/lib/compositor/penFrame'
import { useFramePenSession, isClosedDrawing, filledStyle, PEN_STYLE_OPEN, PEN_STYLE_CLOSED, FRAME_PEN_TOOLS, guideWrite } from '~/composables/frame/useFramePenSession'
import { toggleFillAt } from '~/lib/sketch/fills'
import type { SketchDoc } from '~/lib/sketch/model'

const W = 680, H = 400
function liveHost(initial: any[]) {
  let list = initial
  const added: any[] = []
  const host = {
    layers: () => list, size: () => ({ W, H }), recordHistory: vi.fn(),
    commit: vi.fn((next: any[]) => { list = next }),
    addPathLayers: vi.fn((ls: any[]) => { added.push(...ls); list = [...list, ...ls] }), selectLocal: vi.fn(),
  }
  return { host, added, get: (id: string) => list.find(l => l.id === id) }
}
// three open lines crossing in a triangle (drawing units: 100 per canvas width)
function crossingLines(doc: SketchDoc) {
  addLine(doc, addPoint(doc, -12, 0), addPoint(doc, 12, 0))
  addLine(doc, addPoint(doc, -10, -4), addPoint(doc, 2, 14))
  addLine(doc, addPoint(doc, 10, -4), addPoint(doc, -2, 14))
}
describe('Frame: fills', () => {
  it('Fill is a tool of the Frame’s pen; a filled drawing counts as closed', () => {
    expect(FRAME_PEN_TOOLS).toContain('fill')
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    expect(isClosedDrawing(d)).toBe(false)
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    expect(isClosedDrawing(d)).toBe(true)
    expect(filledStyle({ fill: 'none' })).toEqual({ fill: PEN_STYLE_CLOSED.fill })
    expect(filledStyle({ fill: '#ff0000' })).toEqual({})
  })
  it('withPenOutlines writes fillD only when an area is filled, and exactly {...l, d, sketch} otherwise', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'x', kind: 'path', d: 'old', sketch: d, fill: 'none', fillD: 'stale' }
    const none = withPenOutlines(l, d)
    expect('fillD' in none).toBe(false)
    const plain = { id: 'y', kind: 'path', d: 'old', sketch: d, fill: 'none' }
    expect(JSON.stringify(withPenOutlines(plain, d))).toBe(JSON.stringify({ ...plain, d: sketchToLocalD(d), sketch: d }))
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    const w = withPenOutlines(l, d)
    expect(w.fillD).toBe(sketchFillToLocalD(d))
    expect(w.fillD).toMatch(/^M .* Z$/)
  })
  it('a new drawing of open lines with a filled area becomes a filled layer with fillD', () => {
    const { host, added } = liveHost([])
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    const pen = s.session.value!.pen
    crossingLines(s.session.value!.doc.value)
    pen.commitHistory()
    pen.selectTool('fill'); pen.fillClick(0, 3)
    s.commitSession()
    const layer = added[0]
    expect(layer.fill).toBe(PEN_STYLE_CLOSED.fill)
    expect(layer.fillD).toBe(sketchFillToLocalD(layer.sketch))
    expect(layer.d).toBe(sketchToLocalD(layer.sketch))
  })
  it('reopening an open layer: filling previews fillD and the pen’s fill colour; Cancel puts both back', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'L', kind: 'path', x: 0.5, y: 0.5, scale: 1, rotation: 0, d: sketchToLocalD(d), sketch: d, bbox: { w: 0.2, h: 0.2 }, ...PEN_STYLE_OPEN }
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'L' })
    const pen = s.session.value!.pen
    pen.selectTool('fill'); pen.fillClick(0, 3)
    expect(get('L').fillD).toBe(sketchFillToLocalD(get('L').sketch))
    expect(get('L').fill).toBe(PEN_STYLE_CLOSED.fill)
    s.cancelSession()
    expect('fillD' in get('L')).toBe(false)
    expect(get('L').fill).toBe('none')
    expect(get('L').d).toBe(l.d)
  })
  it('a guide never keeps fills', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 5, 8)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    toggleFillAt(d, { x: 5, y: 2 }, 0)
    const out = guideWrite({ id: 't', kind: 'text', x: 0.5, y: 0.5, path: {} }, d, { x: 0.5, y: 0.5, rotation: 0, skewX: 0, skewY: 0, k: 1, mid: { x: 0, y: 0 } }, W, H)
    expect(out.path.sketch.fills).toBeUndefined()
  })
})
```

and in `frontend/tests/unit/frame-pen-session.unit.spec.ts` the new-drawing assertion becomes `expect(a.pen.options.tools).toEqual(['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve', 'fill'])` (the guide's list further down stays as it is).

- [ ] **Step 4: Run them to see them fail** — `npx vitest run tests/unit/frame-path-fill.unit.spec.ts tests/unit/frame-pen-fills.unit.spec.ts tests/unit/frame-pen-session.unit.spec.ts` → the three snapshot tests PASS, the new ones FAIL.

- [ ] **Step 5: `useCompositorLayers.ts`** (four hunks, nothing else):
  1. In `interface PathLayer`, after the `sketch?:` field:
     ```ts
       /** Pen stage 7: the drawing's filled areas as ONE closed outline (LOCAL units, true arcs,
        *  filled non-zero), present only when this layer came from the pen (`sketch`) and at least
        *  one area is filled. INVARIANT: `fillD === sketchFillToLocalD(sketch)` whenever present,
        *  and absent when that is '' (`penFrame.ts`). The painter FILLS `fillD` and strokes `d`;
        *  a layer without it paints exactly as before. Anything that drops `sketch` drops this too. */
       fillD?: string
     ```
  2. In `resolveMorphs`, the swapped layer: after `kind: 'path', d, bbox: ringsBBoxOfD(d), scale: sT / W, fillRule: 'nonzero',` add
     ```ts
           // a drawing's filled areas don't morph (the morph's outline is the whole face)
           fillD: undefined,
     ```
  3. In the path branch of the layer draw (`} else if (layer.kind === 'path') {` → `if (needsComputedOutline(layer)) {`), replace `drawPath(ctx, { ...layer, d: gd }, W)` with
     ```ts
             // pen stage 7: the filled areas take the same geometry effects as the outline
             const fillD = layer.fillD ? computedOutlineD({ ...layer, d: layer.fillD }, W, rs) ?? undefined : undefined
             drawPath(ctx, { ...layer, d: gd, fillD }, W)
     ```
  4. In `drawPath`: the letter-pieces recursion becomes `drawPath(ctx, { ...layer, d: pc.d, fillD: undefined, motionPieces: undefined } as unknown as PathLayer, W)`, and
     ```ts
       const p = path2dFor(layer.d)
       if (!p) return
       const s = (layer.scale || 1) * W
       ctx.save()
       ctx.scale(s, s)
       if (isFoilFill(layer.fill)) {
         paintFoilRegion(ctx, layer.fill, (c, ink) => { c.fillStyle = ink; c.fill(p, layer.fillRule || 'nonzero') })
       } else if (hasPaint(layer.fill)) {
         ctx.fillStyle = resolvePaint(ctx, layer.fill, layer.bbox, _fieldCtx)
         ctx.fill(p, layer.fillRule || 'nonzero')
       }
     ```
     becomes
     ```ts
       const p = path2dFor(layer.d)
       if (!p) return
       // pen stage 7: a drawing with filled areas fills those (`fillD`, non-zero) and
       // strokes its outline `d`; without `fillD` this is exactly the old fill of `d`
       const fp = layer.fillD ? path2dFor(layer.fillD) : null
       const fillPath = fp ?? p
       const fillRule = fp ? 'nonzero' : (layer.fillRule || 'nonzero')
       const s = (layer.scale || 1) * W
       ctx.save()
       ctx.scale(s, s)
       if (isFoilFill(layer.fill)) {
         paintFoilRegion(ctx, layer.fill, (c, ink) => { c.fillStyle = ink; c.fill(fillPath, fillRule) })
       } else if (hasPaint(layer.fill)) {
         ctx.fillStyle = resolvePaint(ctx, layer.fill, layer.bbox, _fieldCtx)
         ctx.fill(fillPath, fillRule)
       }
     ```
     (`paintStrokeStack`'s arguments below stay exactly as they are — the stroke is `d`.)

- [ ] **Step 6: `useVectorSvg.ts`** — in `pathLayersToSvgDoc`,
  ```ts
      children.push(
        `<path d="${esc(l.d)}" fill="${fill.color}" fill-rule="${l.fillRule || 'nonzero'}"/>`,
      )
  ```
  becomes
  ```ts
      // pen stage 7: a drawing with filled areas fills those (non-zero), its outline stays `d`
      children.push(l.fillD
        ? `<path d="${esc(l.fillD)}" fill="${fill.color}" fill-rule="nonzero"/>`
        : `<path d="${esc(l.d)}" fill="${fill.color}" fill-rule="${l.fillRule || 'nonzero'}"/>`,
      )
  ```
  **`lib/shapes/pathLayer.ts`** — `swapShapeLayer` returns `{ ...layer, d: g.d, bbox: g.bbox, fillRule: shape.fillRule, shapeId: shape.id, sketch: undefined, fillD: undefined }`, and its doc comment's last sentence gains "— and its filled areas (`fillD`, pen stage 7) with it".

- [ ] **Step 7: `penFrame.ts`** — add `import { fillPathData } from '~/lib/sketch/fills'` after the `textPath` import, and right after `sketchToLocalD`:

```ts
/** Pen stage 7: a stored `sketch`'s filled areas as ONE closed outline in LOCAL units
 *  (true arcs, written for a non-zero fill); '' when nothing is filled. Anywhere a
 *  `sketch` with filled areas is stored beside a `fillD`, `fillD ===
 *  sketchFillToLocalD(sketch)` is the invariant. The faces come from the drawing in its
 *  own units (so a host's preview and the overlay share one cached answer) and only the
 *  written numbers are scaled. */
export function sketchFillToLocalD(sketch: SketchDoc): string {
  return fillPathData(sketch, 1 / SKETCH_UNITS)
}

/** What a pen-drawn path layer stores for its drawing: `d`, and `fillD` only when an
 *  area is filled. */
export function penOutlines(sketch: SketchDoc): { d: string; fillD?: string } {
  const fillD = sketchFillToLocalD(sketch)
  return fillD ? { d: sketchToLocalD(sketch), fillD } : { d: sketchToLocalD(sketch) }
}

/** `l` with the pen's drawing written into it: `d`, `sketch`, and `fillD` (dropped when
 *  nothing is filled). A drawing without fills gives exactly `{ ...l, d, sketch }`. */
export function withPenOutlines<L extends { fillD?: string }>(l: L, sketch: SketchDoc): Omit<L, 'fillD'> & { d: string; sketch: SketchDoc; fillD?: string } {
  const { fillD: _old, ...rest } = l
  const o = penOutlines(sketch)
  return { ...rest, d: o.d, sketch, ...(o.fillD ? { fillD: o.fillD } : {}) }
}
```

- [ ] **Step 8: `useFramePenSession.ts`:**
  1. The `penFrame` import gains `penOutlines, withPenOutlines,`; add after it:
     ```ts
     import { fillPathData, withoutFills } from '~/lib/sketch/fills'
     import { hasPaint } from '~/lib/paint/resolve'
     ```
  2. `FRAME_PEN_TOOLS` gains `'fill'` at the end.
  3. `isClosedDrawing` and a new `filledStyle`:
     ```ts
     /** True when the drawing's visible outline is closed: any non-construction
      *  path that is closed, or any non-construction circle — or (pen stage 7) it
      *  has a filled area. */
     export function isClosedDrawing(doc: SketchDoc): boolean {
       return doc.entities.some(e =>
         !e.construction && ((e.kind === 'path' && e.closed) || e.kind === 'circle'))
         || !!fillPathData(doc)
     }

     /** Pen stage 7: the fill a layer takes when its drawing gains a filled area
      *  while its own fill paints nothing (an open drawing's style) — the pen's
      *  fill colour. Nothing when it already has a fill of its own. */
     export function filledStyle(l: { fill?: unknown }): { fill?: string } {
       return hasPaint(l.fill as never) ? {} : { fill: PEN_STYLE_CLOSED.fill }
     }
     ```
  4. `guideWrite`'s return: `sketch: cloneDoc(sk)` → `sketch: withoutFills(cloneDoc(sk))`, with the comment `// a guide never fills (pen stage 7): its drawing is stored without fills` above the `return`.
  5. After `let recorded = false` (session state) add:
     ```ts
       // `{ kind: 'layer' }`: the pen gave the layer its fill colour (its first filled
       // area, on a layer whose fill painted nothing) — Cancel puts the old fill back
       let penFilled = false
     ```
     and in `close()` add `penFilled = false` after `recorded = false`.
  6. In `openLayer`'s `preview`, `writeLayer(id, l => ({ ...l, d: sketchToLocalD(sk), sketch: sk }))` becomes:
     ```ts
           writeLayer(id, l => {
             const next = withPenOutlines(l, sk)
             if (!next.fillD || hasPaint(l.fill)) return next
             penFilled = true
             return { ...next, ...filledStyle(l) }
           })
     ```
  7. In `openGuide`, `start = cloneDoc(spec.sketch)` → `start = withoutFills(cloneDoc(spec.sketch))`.
  8. In `commitSession`: the new-drawing `createPathLayer({ d: sketchToLocalD(r.sketch), sketch: r.sketch, …` → `createPathLayer({ ...penOutlines(r.sketch), sketch: r.sketch, …`; the cloner branch `writeLayer(id, l => ({ ...l, d: sketchToLocalD(sk), sketch: sk, bbox, ...(opened ? openedStyle(l) : {}) }))` → `writeLayer(id, l => ({ ...withPenOutlines(l, sk), bbox, ...(opened ? openedStyle(l) : {}) }))`; the re-centred branch `writeLayer(id, l => ({ ...l, d: sketchToLocalD(r.sketch), sketch: r.sketch, bbox: r.bbox, x, y, ...(opened ? openedStyle(l) : {}) }))` → `writeLayer(id, l => ({ ...withPenOutlines(l, r.sketch), bbox: r.bbox, x, y, ...(opened ? openedStyle(l) : {}) }))`.
  9. In `cancelSession`'s layer branch:
     ```ts
           const id = s.target.id, orig = original, wrote = recorded, filled = penFilled
           close()
           // only what the pen wrote goes back (previews touch d/sketch/fillD alone,
           // and the fill colour only when the pen gave it), so an inspector edit made
           // meanwhile (fill, stroke) survives; nothing written → nothing to put back,
           // and no undo step was left behind
           if (wrote) {
             writeLayer(id, l => {
               const { fillD: _pen, ...rest } = l
               return { ...rest, d: orig.d, sketch: orig.sketch, ...(orig.fillD ? { fillD: orig.fillD } : {}), ...(filled ? { fill: orig.fill } : {}) }
             })
           }
     ```
  (`sketchToLocalD` stays imported: `commitSession` still measures outlines with it.)

- [ ] **Step 9: Run the tests to see them pass** — `npx vitest run tests/unit/frame-path-fill.unit.spec.ts tests/unit/frame-pen-fills.unit.spec.ts tests/unit/frame-pen-session.unit.spec.ts tests/unit/pen-frame-sketch-field.unit.spec.ts tests/unit/compositor-stroke-vector.unit.spec.ts tests/unit/shapes-path-layer.unit.spec.ts` and every `tests/unit/compositor-*` and `tests/unit/frame-*` file (`npx vitest run tests/unit/compositor tests/unit/frame`) → PASS, and the snapshot report says nothing was written, updated or obsolete.

- [ ] **Step 10: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'useCompositorLayers\.ts|useVectorSvg\.ts|shapes/pathLayer\.ts|penFrame\.ts|useFramePenSession\.ts'` → no lines that were not there before your edit. (These big files may carry baseline errors: before Step 5, save that same grep's output to your scratchpad and compare.)

- [ ] **Step 11: Commit** `frontend/app/composables/useCompositorLayers.ts frontend/app/composables/useVectorSvg.ts frontend/app/lib/shapes/pathLayer.ts frontend/app/lib/compositor/penFrame.ts frontend/app/composables/frame/useFramePenSession.ts frontend/tests/unit/frame-path-fill.unit.spec.ts frontend/tests/unit/__snapshots__/frame-path-fill.unit.spec.ts.snap frontend/tests/unit/frame-pen-fills.unit.spec.ts frontend/tests/unit/frame-pen-session.unit.spec.ts` — message `feat(frame): a drawn path layer fills its filled areas (fillD) and strokes its outline; the pen writes both (stage 7)`. `useCompositorLayers.ts` is edited by other sessions: if it carried someone else's hunks when you started, stage only yours (the Global Constraints recipe).

---

### Task 8: Shape Studio — a Drawn shape is its filled areas

**Files:**
- Modify: `frontend/app/lib/geoshape/shapes.ts` (`drawnPath`)
- Modify: `frontend/app/composables/geoshape/useShapePenSession.ts`
- Test: `frontend/tests/unit/shape-pen-fills.unit.spec.ts`

**Behaviour (Ruling 12):** `drawnPath(sketch, size)` fits exactly as today (the whole drawing's flattened outline box: `k = size / extent`, centred on the box centre) but draws `fillPathData(sketch) || outline` — the filled areas when any is filled. `SHAPE_PEN_TOOLS` gains `'fill'`; `hasClosedOutline` also counts a filled area, so a filled drawing of open lines stays painted as a fill at commit. `mergeConfig` keeps fills because it loads the drawing through `mergeSketchDoc` (Task 2).

**Interfaces:**
- Consumes: `fillPathData` (fills.ts); Task 5's pen Fill API (the tests drive it).
- Produces: `drawnPath` drawing filled areas; `SHAPE_PEN_TOOLS` with `'fill'`; `hasClosedOutline` counting fills.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/shape-pen-fills.unit.spec.ts`:

```ts
// tests/unit/shape-pen-fills.unit.spec.ts
// Pen stage 7, Shape Studio: a Drawn shape with a filled area is that area,
// fitted by the whole drawing; a filled open drawing stays painted as a fill.
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { addPoint, addLine } from '~/lib/sketch/edit'
import { mergeLayer, type GeoStudioDoc } from '~/lib/geoshape/studio'
import { drawnPath, sketchOutlineBounds } from '~/lib/geoshape/shapes'
import { useShapePenSession, hasClosedOutline, SHAPE_PEN_TOOLS } from '~/composables/geoshape/useShapePenSession'
import { toggleFillAt, fillPathData } from '~/lib/sketch/fills'
import type { SketchDoc } from '~/lib/sketch/model'

function crossing(d: SketchDoc) {
  addLine(d, addPoint(d, -12, 0), addPoint(d, 12, 0))
  addLine(d, addPoint(d, -10, -4), addPoint(d, 2, 14))
  addLine(d, addPoint(d, 10, -4), addPoint(d, -2, 14))
}
describe('Shape Studio: fills', () => {
  it('a Drawn shape with a filled area is that area, fitted by the whole drawing', () => {
    expect(SHAPE_PEN_TOOLS).toContain('fill')
    const d: SketchDoc = { entities: [], constraints: [] }
    crossing(d)
    const before = drawnPath(d, 100)
    expect(hasClosedOutline(d)).toBe(false)
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    expect(hasClosedOutline(d)).toBe(true)
    const after = drawnPath(d, 100)
    expect(after).not.toBe(before)
    expect((after.match(/L/g) ?? []).length).toBe(3)      // the triangle, no spurs
    expect(after.trim().endsWith('Z')).toBe(true)
    // fitted by the whole drawing's box: the drawing is 24 wide → k = 100/24; the triangle's
    // apex (0, 4-ish) stays where the outline put it
    const ob = sketchOutlineBounds(d)!
    expect(ob.maxX - ob.minX).toBeCloseTo(24, 9)
  })
  it('commit keeps a filled open drawing painted as a fill', () => {
    const doc = reactive({ layers: [mergeLayer({})] }) as unknown as GeoStudioDoc
    const s = useShapePenSession({ doc: () => doc, layerIndex: () => 0, frameFor: () => ({ cx: 0, cy: 0, scale: 1, cssW: 600, cssH: 600 }) })
    s.open()
    const pen = s.session.value!.pen
    crossing(s.session.value!.doc.value)
    pen.commitHistory()
    pen.selectTool('fill'); pen.fillClick(0, 3)
    s.commitSession()
    const m = doc.layers[0]!.mark
    expect(m.sketch!.fills).toHaveLength(1)
    expect(m.paintTarget).toBe('fill')
    expect(fillPathData(m.sketch!)).not.toBe('')
  })
})
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/unit/shape-pen-fills.unit.spec.ts` → FAIL.

- [ ] **Step 3: `shapes.ts`** — add `import { fillPathData } from '~/lib/sketch/fills'` after the `pathFlatten` import. In `drawnPath`'s doc comment, before "The transform is exact…", add the paragraph:

```ts
 * Pen stage 7: a drawing with filled areas IS those areas — the path is their
 * outline (`fillPathData`), fitted by the WHOLE drawing's box, so filling an
 * area never moves or resizes the shape. No area filled → the outline as before.
 *
```

(and "from `sketchPathData`" in the next paragraph → "from `sketchPathData` / `fillPathData`"). In the body,

```ts
  const { d: d0, minX, minY, maxX, maxY } = ob
```

becomes

```ts
  const { minX, minY, maxX, maxY } = ob
  const d0 = fillPathData(sketch!) || ob.d
```

(the rest — `ext`, `k`, the token loop — is unchanged: `fillPathData` writes the same `M / L / A / Z` grammar).

- [ ] **Step 4: `useShapePenSession.ts`** — add `import { fillPathData } from '~/lib/sketch/fills'` after the `usePen` import; `SHAPE_PEN_TOOLS` gains `'fill'` at the end; `hasClosedOutline` becomes:

```ts
/** True when the drawing's visible outline has a closed path or a circle — or
 *  (pen stage 7) a filled area, which the shape then is. */
export function hasClosedOutline(doc: SketchDoc): boolean {
  return doc.entities.some(e => !e.construction && ((e.kind === 'path' && e.closed) || e.kind === 'circle'))
    || !!fillPathData(doc)
}
```

- [ ] **Step 5: Run the tests to see them pass** — `npx vitest run tests/unit/shape-pen-fills.unit.spec.ts tests/unit/shape-pen-session.unit.spec.ts tests/unit/geoshape-drawn.unit.spec.ts tests/unit/geoshape-pen-shape.unit.spec.ts` and `npx vitest run tests/unit/geoshape` → PASS (the 20-seed re-roll snapshot included — Drawn is never rolled).

- [ ] **Step 6: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'geoshape/shapes\.ts|useShapePenSession\.ts'` → no output.

- [ ] **Step 7: Commit** `frontend/app/lib/geoshape/shapes.ts frontend/app/composables/geoshape/useShapePenSession.ts frontend/tests/unit/shape-pen-fills.unit.spec.ts` — message `feat(shape-studio): a Drawn shape with filled areas is those areas (stage 7)`.

---

### Task 9: Real-mouse proof — the pen page, the Frame, Shape Studio, laptop widths

**Files:**
- Modify: `frontend/app/pages/dev/sketch-draw.vue` (a read-only `fills()` hook)
- Modify: `frontend/tests/pen-tips.spec.ts` (G in the tool-key test)
- Test: `frontend/tests/pen-fills.spec.ts` (new)

**Behaviour:** the spec's Stage 7 testing line, with the real mouse and keyboard: fill hover, click, drag-follows, split, merge, an opened area asleep with its gap rings, undo; the owner's trimmed flower filled petal by petal without joining; the Frame renders the fill in the layer (a pixel check) and loses it when emptied; Shape Studio's Drawn shape takes the filled area; the bucket button reachable at 1280 and 1024 wide in all three hosts. `__sketchDraw` only sets drawings up (`load`) and reads them back (`fills`, `doc`, `tool`). Then the ten existing pen specs must stay green.

**Interfaces:**
- Consumes: every DOM hook of Task 6; `__sketchDraw.load`, `.doc`, `.tool`, and the new `.fills()` → `{ count, filled, asleep, gaps, d, area }`; the Frame's `__compositorLayers()` / `__compositorSetLayers()`; Shape Studio's `__shapeStudioLab.props`.

- [ ] **Step 1: The page hook** — in `frontend/app/pages/dev/sketch-draw.vue`: `import { ref, computed, onMounted, onUnmounted } from 'vue'` → add `toRaw`; add `import { fillState } from '~/lib/sketch/fills'` after the `pieces` import; in `__sketchDraw`, after the stage 6 `highlight:` hook add:

```ts
    // pen stage 7 — read the fills (never change them): how many are stored,
    // how many areas are filled, how many sleep, the gap rings, the filled
    // outline and its total area
    fills: () => {
      const v = pen.fillView()
      const raw = toRaw(doc.value)
      const st = raw.fills?.length ? fillState(raw) : null
      return {
        count: raw.fills?.length ?? 0, filled: v.filled, asleep: v.asleep, gaps: v.gaps.length, d: v.d,
        area: st ? st.filled.reduce((s, f) => s + st.fs.faces[f]!.area, 0) : 0,
      }
    },
```

- [ ] **Step 2: G in the tool-key test** — in `frontend/tests/pen-tips.spec.ts` the test title `'P, B, L, O, N, T, C, D and V pick their tools from the keyboard'` → `'P, B, L, O, N, T, C, D, G and V pick their tools from the keyboard'`, and its `want` list gains `['g', 'fill']` before `['v', 'select']`.

- [ ] **Step 3: Write the spec** — create `frontend/tests/pen-fills.spec.ts`:

```ts
// tests/pen-fills.spec.ts
// Pen stage 7 with the REAL mouse and keyboard: G picks Fill; hovering hatches
// the area under the pointer, a click fills it, a second click empties it, ⌘Z
// and ⇧⌘Z; dragging a corner, the fill follows; a line drawn across fills both
// halves, trimming the divider leaves one fill, trimming an edge puts it to
// sleep with its gap rings and ⌘Z wakes it; the owner's trimmed flower fills
// petal by petal without joining; the Frame paints the fill in the layer and
// drops it when emptied; Shape Studio's Drawn shape takes the filled area;
// the bucket button at laptop widths in all three hosts.
// __sketchDraw / __compositorSetLayers only set drawings up and read them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const svg = (page: Page) => page.locator('svg[data-pen-overlay]')
// drawing → page px on the pen page (34 px/unit, y up, origin at (40, 400) of the board)
async function at(page: Page, x: number, y: number) {
  const b = (await svg(page).boundingBox())!
  return { x: b.x + 40 + 34 * x, y: b.y + 400 - 34 * y }
}
async function click(page: Page, x: number, y: number) {
  const p = await at(page, x, y)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down(); await page.mouse.up()
}
const fills = (page: Page) => page.evaluate(() => (window as any).__sketchDraw.fills())
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const status = (page: Page) => page.locator('[data-status]')

/** a closed square (1,1)–(5,5) */
async function loadSquare(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__sketchDraw.load({
      entities: [
        { id: 'a', kind: 'point', x: 1, y: 1 }, { id: 'b', kind: 'point', x: 5, y: 1 },
        { id: 'c', kind: 'point', x: 5, y: 5 }, { id: 'd', kind: 'point', x: 1, y: 5 },
        { id: 'S', kind: 'path', anchors: ['a', 'b', 'c', 'd'], segments: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], closed: true },
      ],
      constraints: [],
    })
  })
}

/** The owner's trimmed flower: a square centre (6,2)–(12,8) and a petal arc on
 *  each side, each petal a separate open piece whose ends stop ~3 px short of the
 *  square's corners (nothing joined). */
function flower() {
  const entities: any[] = [
    { id: 'q0', kind: 'point', x: 6, y: 2 }, { id: 'q1', kind: 'point', x: 12, y: 2 },
    { id: 'q2', kind: 'point', x: 12, y: 8 }, { id: 'q3', kind: 'point', x: 6, y: 8 },
    { id: 'SQ', kind: 'path', anchors: ['q0', 'q1', 'q2', 'q3'], segments: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], closed: true },
  ]
  const constraints: any[] = []
  const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const cx = (x0! + x1!) / 2, cy = (y0! + y1!) / 2, r = 3, dl = 0.03
    const a0 = Math.atan2(y0! - cy, x0! - cx) + dl, a1 = a0 + Math.PI - 2 * dl
    entities.push(
      { id: `s${i}`, kind: 'point', x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) },
      { id: `e${i}`, kind: 'point', x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) },
      { id: `m${i}`, kind: 'point', x: cx, y: cy },
      { id: `P${i}`, kind: 'path', anchors: [`s${i}`, `e${i}`], segments: [{ kind: 'arc', center: `m${i}`, sweep: 1 }], closed: false },
    )
    constraints.push({ id: `k${i}`, kind: 'equalDist', refs: [`m${i}`, `s${i}`, `m${i}`, `e${i}`] })
  }
  return { entities, constraints }
}

test('G picks Fill; hovering hatches the area, a click fills it, a second click empties it; ⌘Z and ⇧⌘Z', async ({ page }) => {
  await open(page); await loadSquare(page)
  await page.keyboard.press('g')
  await expect(page.locator('[data-tool="fill"]')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('fill')
  const p = await at(page, 3, 3)
  await page.mouse.move(p.x, p.y)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'no')
  await page.mouse.down(); await page.mouse.up()
  await expect.poll(async () => (await fills(page)).filled).toBe(1)
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'yes')
  await expect(status(page)).toHaveText('Filled')
  expect((await fills(page)).area).toBeCloseTo(16, 6)

  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => (await fills(page)).filled).toBe(0)
  await page.keyboard.press(`${META}+Shift+z`)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)

  await page.mouse.down(); await page.mouse.up()   // still over the square: empties it
  await expect.poll(async () => (await fills(page)).count).toBe(0)
  await expect(status(page)).toHaveText('Emptied')
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)

  await click(page, 8, 8)                            // open space
  await expect(status(page)).toHaveText('Click inside an enclosed area')
  await expect(page.locator('[data-fill-hover]')).toHaveCount(0)
  expect((await fills(page)).count).toBe(0)
})

test('dragging a corner: the fill follows the edge', async ({ page }) => {
  await open(page); await loadSquare(page)
  await page.keyboard.press('g'); await click(page, 3, 3)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)
  await page.keyboard.press('v')
  const from = await at(page, 5, 5), to = await at(page, 7, 6)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  // mid-drag the tint already follows (it reads the moving outline)
  await expect.poll(async () => (await fills(page)).area).toBeGreaterThan(16.5)
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  const f = await fills(page)
  expect(f.count).toBe(1)
  expect(f.filled).toBe(1)
  expect(f.area).toBeGreaterThan(19)   // the square with its corner pulled out to (7, 6)
  const c = (await doc(page)).entities.find((e: any) => e.id === 'c')
  expect(c.x).toBeCloseTo(7, 1); expect(c.y).toBeCloseTo(6, 1)
})

test('a line drawn across fills both halves; trimming the divider leaves one; trimming an edge puts it to sleep with rings; ⌘Z wakes it', async ({ page }) => {
  await open(page); await loadSquare(page)
  await page.keyboard.press('g'); await click(page, 3, 3)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)

  await page.keyboard.press('l')
  await click(page, 3, 0); await click(page, 3, 6)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 2, filled: 2, asleep: 0 })

  await page.keyboard.press('t')
  await click(page, 3, 3)                            // the divider's piece inside the square
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 1, asleep: 0 })
  expect((await fills(page)).area).toBeCloseTo(16, 4)

  await click(page, 2, 1)                            // the bottom edge's left piece: the square opens
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 0, asleep: 1 })
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  await expect(page.locator('[data-fill-gap]').first()).toBeVisible()
  expect(await page.locator('[data-fill-gap]').count()).toBeGreaterThanOrEqual(1)

  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 1, asleep: 0 })
  await expect(page.locator('[data-fill-gap]')).toHaveCount(0)
})

test('the owner’s trimmed flower: the centre and every petal fill by bucket, nothing joined', async ({ page }) => {
  await open(page)
  await page.evaluate((raw) => (window as any).__sketchDraw.load(raw), flower())
  const before = await doc(page)
  await page.keyboard.press('g')
  for (const [x, y] of [[9, 5], [9, 0.2], [13.8, 5], [9, 9.8], [4.2, 5]] as const) await click(page, x, y)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 5, filled: 5, asleep: 0 })
  const after = await doc(page)
  expect(after.entities.length).toBe(before.entities.length)   // nothing merged, nothing added
  expect(after.entities.filter((e: any) => e.kind === 'path')).toHaveLength(5)
  expect(after.fillGap).toBeGreaterThan(0)
})

// ── the Frame ──

type Box = { x: number; y: number; width: number; height: number }
const layers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers() as any[])
const framePenButton = (page: Page) => page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first()
const frameOverlay = (page: Page) => page.locator('[data-testid="frame-pen-overlay"]')
/** the stage's colour at a screen point (a real screenshot of one pixel) */
async function pixel(page: Page, at: { x: number; y: number }) {
  const png = await page.screenshot({ clip: { x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 } })
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
    const c = document.createElement('canvas'); c.width = c.height = 1
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0)
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }, png.toString('base64'))
}
const isBlue = (rgb: number[]) => Math.abs(rgb[0]! - 0x3b) < 24 && Math.abs(rgb[1]! - 0x82) < 24 && Math.abs(rgb[2]! - 0xf6) < 24
async function clickAt(page: Page, p: { x: number; y: number }) {
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up()
}
/** three open lines crossing in a triangle round (cx, cy): apex ~46 px up, base 40 px down */
async function crossingLines(page: Page, cx: number, cy: number) {
  await page.keyboard.press('l')
  for (const [a, b] of [[[-90, 40], [90, 40]], [[-70, 75], [20, -80]], [[70, 75], [-20, -80]]] as const) {
    await clickAt(page, { x: cx + a[0], y: cy + a[1] })
    await clickAt(page, { x: cx + b[0], y: cy + b[1] })
  }
}

test('the Frame: three crossing lines, the triangle bucket-filled, paint in the layer; emptied, the fill goes', async ({ page }) => {
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]')
  const before = await layers(page)
  await framePenButton(page).click()
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  const box = (await frameOverlay(page).boundingBox())! as Box
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await crossingLines(page, cx, cy)
  await page.keyboard.press('g')
  const inside = { x: cx, y: cy + 10 }, below = { x: cx, y: cy + 60 }
  await page.mouse.move(inside.x, inside.y)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'no')
  await page.mouse.down(); await page.mouse.up()
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="fill"]')).toBeHidden()

  const layer = (await layers(page)).find((l: any) => !before.some((b: any) => b.id === l.id))
  expect(layer?.kind).toBe('path')
  expect(layer.fill).toBe('#3b82f6')
  expect(layer.fillD).toMatch(/^M .* Z$/)
  expect(layer.sketch.fills).toHaveLength(1)
  await expect.poll(async () => isBlue(await pixel(page, inside))).toBe(true)
  expect(isBlue(await pixel(page, below))).toBe(false)   // under the base: not enclosed

  // reopen (a double-click on the filled area), empty it, Enter
  await page.mouse.dblclick(inside.x, inside.y)
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  await page.keyboard.press('g')
  await clickAt(page, inside)
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="fill"]')).toBeHidden()
  const done = (await layers(page)).find((l: any) => l.id === layer.id)
  expect('fillD' in done).toBe(false)
  expect(done.fill).toBe('none')                       // open lines again: stroked, not filled
  await expect.poll(async () => isBlue(await pixel(page, inside))).toBe(false)
})

// ── Shape Studio ──

const markOf = (page: Page) => page.evaluate(() =>
  (window as any).__shapeStudioLab.props.sailor_shapeStudio?.doc?.layers?.[0]?.mark ?? null)

test('Shape Studio: three crossing lines with the triangle filled make a Drawn shape painted as a fill', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  const box = (await page.locator('[data-testid="shape-pen-overlay"]').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await crossingLines(page, cx, cy)
  await page.keyboard.press('g')
  await clickAt(page, { x: cx, y: cy + 10 })
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  await page.locator('[data-act="done"]').click()
  await expect(page.locator('[data-tool="fill"]')).toHaveCount(0)
  await expect.poll(async () => (await markOf(page))?.sketch?.fills?.length ?? 0, { timeout: 15_000 }).toBe(1)
  const m = await markOf(page)
  expect(m.shape).toBe('drawn')
  expect(m.paintTarget).toBe('fill')
})

// ── laptop widths ──

for (const width of [1280, 1024]) {
  test(`the bucket button is on screen at ${width} px in all three hosts`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const onScreen = async () => {
      const b = (await page.locator('[data-tool="fill"]').boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
    await open(page)
    await expect(page.locator('[data-tool="fill"]')).toBeVisible()
    await onScreen()

    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await framePenButton(page).click()
    await expect(page.locator('[data-tool="fill"]')).toBeVisible()
    await onScreen()

    await page.goto('/dev/shape-studio-lab')
    await page.locator('[data-ready]').waitFor()
    await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
    await expect(page.locator('[data-tool="fill"]')).toBeVisible()
    await onScreen()
  })
}
```

- [ ] **Step 4: Make sure the server serves the new code** — `touch` every file Tasks 1–8 changed, then `curl -s http://127.0.0.1:3002/_nuxt/Users/julien/Documents/GitHub/Sailor/frontend/app/composables/pen/usePen.ts | grep -c fillClick` and `curl -s http://127.0.0.1:3002/_nuxt/Users/julien/Documents/GitHub/Sailor/frontend/app/composables/useCompositorLayers.ts | grep -c fillD` → both ≥ 1. If the server answers 500 or "The service is no longer running", STOP and report it (never restart it yourself).

- [ ] **Step 5: Run the new spec** — `npx playwright test tests/pen-fills.spec.ts --project=chromium` → PASS. A failure is a finding about the product, not the test, until shown otherwise: look at the screenshot / trace first. If a click in the Frame or Shape Studio lands differently than the pen page (their views are not 34 px/unit), keep the screen-space coordinates as written and adjust only the probe points' distances, never switch to `__sketchDraw`-style set-ups for the gesture under test.

- [ ] **Step 6: The other pen specs stay green** — `npx playwright test tests/sketch-draw.spec.ts tests/pen-snap.spec.ts tests/pen-tangent.spec.ts tests/pen-tips.spec.ts tests/pen-trim.spec.ts tests/pen-weld.spec.ts tests/pen-cleanup.spec.ts tests/pen-menus.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts --project=chromium` → all PASS.

- [ ] **Step 7: Typecheck** — `npx vue-tsc --noEmit 2>&1 | grep -E 'pages/dev/sketch-draw\.vue'` → no output.

- [ ] **Step 8: Commit** `frontend/app/pages/dev/sketch-draw.vue frontend/tests/pen-fills.spec.ts frontend/tests/pen-tips.spec.ts` — message `test(pen): fills with the real mouse — hover, fill, drag, split, sleep, the flower, the Frame, Shape Studio, laptop widths (stage 7)`.

---

### Task 10: Record it

**Files:**
- Modify: `docs/STATE.md` (new entry at the top of the landed list, above "The pen — right-click menu, action wheel, properties (stage 6)")
- Modify: `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` (status line only)

- [ ] **Step 1: STATE.md entry** — heading `### The pen — fills (stage 7) — LANDED <date> (spec docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md, plan docs/superpowers/plans/2026-09-27-pen-stage-7-fills.md; <first>..<last> commits)`, then in the style of the stage 6 entry: what you can do (G / bucket: hover hatches the enclosed area, click fills, click a filled area empties it; filled areas tinted in the pen; fills follow drags, a line across fills both halves, a merge keeps one, an opened area sleeps with amber rings and wakes when it closes; Cut, Dissolve, joins, Clean up, Repeat, Mirror, Copy / Paste, Flip and undo carry them; the Frame's path layer fills `fillD` and strokes `d`, new drawings of open lines with a fill come out filled; Shape Studio's Drawn shape becomes the filled areas; the owner's trimmed flower fills petal by petal without Clean up), what was proven (the unit files, the byte-identity snapshot of the painter, `tests/pen-fills.spec.ts`, the ten pen specs green, 1280 / 1024), the rulings (the list at the top of the plan — at least 1–4, 6, 7, 9–13), and known limits (Bézier pieces bound nothing; one colour per drawing; a gap is bridged only up to 6 px at the zoom of the first fill — wider gaps sleep until joined; Flip keeps each arc's turning, so an arc seed relies on the settle; a live drag shows one half of a split until release; overlapping copies (a dense Repeat) cut each other's areas into pieces, and only the pieces touching the original's edges or its old place fill; booleans on a filled drawn layer read its outline, not its fill).
- [ ] **Step 2: Spec status line** → `Status: designed 2026-09-26 on the owner's "let's build stage 4-8 first"; stage 4 built 2026-09-26; stage 5 built 2026-09-27; stage 6 built 2026-09-27; stage 7 built <date>`.
- [ ] **Step 3: Commit** `docs/STATE.md docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — message `docs(pen): stage 7 built — fills`. (The controller, not the implementer, updates the build dashboard afterwards.)

---

## Self-review

**Spec coverage (Stage 7):**
- Fill tool, key G, bucket icon (Tasks 5, 6; Ruling 13); hovering shows the enclosed area under the pointer hatched (Tasks 5, 6, 9); click fills, click a filled area empties it (Tasks 2, 5, 9); areas are the faces lines, arcs and circles make where they cross, guides don't bound (Task 1; Rulings 1, 2).
- Areas follow edits: a seed tied to an edge — piece, position, side — never an area id (Task 2; Ruling 5); follows drags (Tasks 2, 9); a split keeps both halves filled, a merge is filled once, an opened area sleeps with a small gap marker until it closes (Tasks 3, 5, 6, 9; Ruling 6); seeds survive stage-3 edits, Clean up's joins, copies, Flip and undo (Tasks 4, 5; Rulings 7, 8).
- Colour: the layer's fill in the Frame, the shape's fill in Shape Studio, one colour per drawing (Tasks 7, 8; Ruling 9).
- Output: one closed outline with true arcs, separate from the stroke outline (Tasks 1, 2); Frame `fillD` filled, `d` stroked, in every paint path (Task 7; Ruling 10); Shape Studio: the filled areas are the shape (Task 8; Ruling 12); no fills → exactly as today (the painter snapshot, `withPenOutlines`' no-fill shape, `cloneDoc` / `mergeSketchDoc` leaving the fields out — Tasks 2, 7).
- The owner's trimmed flower: bucket-fill the centre and every petal (Tasks 2, 9; Ruling 3), or Clean up first (its merges carry seeds — Task 4).
- Shared ground: one pen, three hosts (Tasks 5–8, checked in Task 9); no new pieces or rule kinds (Global Constraints); px tolerances (Ruling 3); one undo step (Task 5); a card with a demo for the new tool (Task 6); Bézier out (Ruling 1). Testing: unit tests for face finding and seed tracking (Tasks 1–4), real-mouse fill hover, click, drag-follows, split (Task 9), the Frame renders through `fillD` (Tasks 7, 9), 1280 / 1024 (Task 9).
- Out of scope kept out: per-area colours; Bézier; booleans on drawn shapes; stage 8.

**Spec problems found:** (1) The spec's "areas are the faces" alone cannot fill the owner's trimmed flower, whose pieces stop ~3 px short of each other — near-touching ends must be bridged; ruled a stored, zoom-independent gap fixed at the first fill (Ruling 3). (2) A seed alone cannot keep "both halves filled" after a split — a seed finds one face; ruled a settle inside every commit that carries fills from the last settled drawing (Ruling 6), with seeds moved by the renaming edits so sleeping fills survive them (Ruling 7). (3) "The layer's fill" is `none` on an open drawing's layer, so a first fill would be invisible; ruled the pen's fill colour then, put back on Cancel (Ruling 9). (4) Holes (a drawing inside an area) are not mentioned; ruled true nesting, not even-odd (Ruling 4). (5) The spec says nothing about a text guide; its pen is open-only and never fills (Ruling 13). (6) Geometry effects, Morph, the SVG export and shape swaps also read a path layer's `d`; ruled how each treats `fillD` (Ruling 10). (7) Flip moves points but keeps arcs' turning (existing behaviour), so an arc seed can't be mirrored exactly; left to the settle (Ruling 8). (8) The CAD / Zoah research reports cited for this stage were not on disk when the plan was written; the rulings stand in for them and each can be overturned.

**Type consistency:** `intersectCurves`, `IntersectionPoint` (Task 1, crossings.ts) are used by `faces.ts` only; `FacePiece`, `facePieceKey`, `HalfEdge`, `Box`, `FaceCycle`, `Face`, `FaceSet`, `findFaces`, `faceAt`, `faceOfHalfEdge`, `facesD`, `geometryKey`, `facesFor` (Task 1) are used with those names in Tasks 2–5; `FillSeed`, `SketchFill`, `SketchDoc.fills`, `SketchDoc.fillGap` (Task 2, model.ts) everywhere after; `FILL_GAP_PX`, `fillFaces`, `halfEdgeOfSeed`, `resolveFill`, `seedOnHalfEdge`, `seedForFace`, `freshFillId`, `withoutFills`, `FillState`, `fillState`, `fillPathData`, `gapMarkers`, `fillTarget`, `toggleFillAt`, `addFillAt` (Task 2) in Tasks 3–9; `interiorPoint`, `reconcileFills` (Task 3) in Task 5; `splitSeeds`, `joinSeeds`, `renameSeedPoints`, `mapSeed`, `fillsWithin`, `flipSeeds` (Task 4) in `trim.ts` / `edit.ts` / `clipboard.ts` (Task 4) and `penCopies.ts` (Task 5); `FILL_MISS`, `FillView`, `fillHover`, `fillMove`, `fillClick`, `fillView`, `penHistory.current` (Task 5) in Tasks 6, 7, 9; `PenTipFrame.hatchAt`, `PEN_TIPS.fill`, `PEN_TIP_DEMOS.fill` (Task 6); `PathLayer.fillD`, `sketchFillToLocalD`, `penOutlines`, `withPenOutlines`, `filledStyle` (Task 7); DOM hooks `[data-tool="fill"]`, `[data-fill-area]`, `[data-fill-hover][data-filled]`, `[data-fill-gap]` (Task 6) and `__sketchDraw.fills()` (Task 9) match Task 9's spec.

