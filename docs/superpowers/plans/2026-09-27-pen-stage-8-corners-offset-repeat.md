# The pen, stage 8 — round corners, chamfer, offset, repeat modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four new ways to build in the shared pen: **Round corner** (key **F**) and **Chamfer** (key **H**) turn a corner into a tangent arc or a straight cut, with the corner kept as a hidden guide point so rules on it still hold; **Offset** (key **E**) makes a live parallel copy of a path at a distance you drag or type; and a **Repeat…** panel (in each host's side panel, like Properties) that repeats a selection **Radial** (live), **Linear** (live) or **Along a path** (placed once) — every one previewed on the canvas only, applied as one undo step, cancelled with Esc leaving the drawing byte-identical.

**Architecture:** Three new rule kinds in the solver (`offsetLine`, `offsetRadius`, `translatedFrom`, each with a residual, an analytic Jacobian row and — for `translatedFrom` — the copy-point substitution Repeat already uses), taught to every consumer (trim, merge, delete, Cut, Dissolve, clipboard, mirror copies, Clean up, rule checks, labels, badges). Three new pure modules build the geometry: `lib/sketch/corners.ts` (which points are corners, the fillet / chamfer geometry, the construction with its rules and seed moves, the preview), `lib/sketch/offset.ts` (the source chains, the offset geometry with sharp corners, the construction with its rules, the preview), `lib/sketch/repeatModes.ts` (placements shared by the real copies and the preview; path sampling) plus `edit.ts`'s new `translateEntities` / `copyAlongPath` and a `sweep` for `repeatEntities`. Three new pen composables hold each gesture's overlay-only preview (`penCorners.ts`, `penOffset.ts`, `penRepeat.ts`, wired into `usePen` the way `penCopies.ts` is); `PenOverlay` draws the previews and routes the pointer; `PenToolbar` gets three tool buttons; `PenProperties` swaps its body for the new `PenRepeatPanel` while Repeat is open (so all three hosts get the panel with no host edit); `penActions` gets the menu entries.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, lucide-vue-next (`SquareRoundCorner`, `Octagon`, `SquareSquare`), vitest (`tests/unit/**/*.unit.spec.ts`, happy-dom for components), Playwright against the running :3002 dev server.

**Spec:** `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — sections "Shared ground", "Stage 8 — round corners, chamfer, offset, repeat modes", "Testing" and "Out of scope" are binding; only Stage 8 is in scope. Read them before your task.

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
- Each task's commit is its own review package: the reviewer sees that task's diff and its tests only, so a task never leans on uncommitted work from a later one. Every task leaves `npx vue-tsc --noEmit` clean on the files it touched.
- **Model rule (spec, Shared ground):** no new piece kinds. Round corner, Chamfer, Offset and Repeat are macros that make ordinary points, lines, path pieces, circles and rules. The only new rule kinds are `offsetLine`, `offsetRadius` and `translatedFrom` (Task 1); each gets a residual, an analytic Jacobian row checked against central differences in a unit test, and tests for its degenerate cases (zero-length line, zero radius, `from` = `to`).
- **Every new rule kind is taught to every consumer (stage 4 lesson — a rule trim left dangling pulled the drawing invisibly):** trim / Cut / Dissolve / merging points (`trim.ts`), delete (`edit.ts deleteEntity`), Mirror copies (`edit.ts`), Copy / Paste / resize (`clipboard.ts`), save / load (`merge.ts`), Clean up (`cleanup/guards.ts` joining rules and window hops, `cleanup/context.ts` copy points — detectors must not fight it), rule checks (`ruleCheck.ts` quick / full verdicts), labels (`pieces.ts`: sentence case, plain words), the Properties rule list (hover lights, × removes), the canvas badges (`annotate.ts`, `PenOverlay` hidden kinds) and fills (seeds carried by the corner edits, Repeat copies filled by `fillCopiedAreas`). Tasks 1 and 2 do this, one test per consumer.
- **Never refuse, drop or fill on a guess.** A rule check's "unsure" is allowed. A too-big radius / setback / offset is certain geometry: it previews red and Apply refuses it, saying why in the status line.
- **Trial and preview work never goes through `onLiveChange`** (the Frame writes previews into the layer). Every preview (corner drag, offset drag, the Repeat panel) lives in a `shallowRef` read only by the overlay; the drawing is untouched until Apply. Cancel / Esc / a tool change / undo / finishing the session drop the preview and leave the drawing and the Frame layer byte-identical. Apply is exactly one `commitHistory()`.
- **Apply solves only when it must:** the constructions place everything exactly, so Apply runs `runSolve()` only when one of the rules it added does not hold as placed (residual above `1e-7 × drawing size`). (Dragging a ~160-piece connected drawing already stalls in `solve.ts` — a pre-existing problem being fixed separately; stage 8 must not depend on that fix and must not measure against it.)
- **Speed (binding):** previews compute on the RAW drawing (`toRaw(doc.value)`), never through Vue's deep proxies (~100× slower); anything derived from the drawing's make-up (the corner list) is cached by `docRevision` + the raw doc object. Measure on ONE connected drawing (the 150-piece `gear()` of `tests/unit/__fixtures__/penStage8.ts`) and on a symmetric grid (`rectGrid(37)`). Budget: a preview frame ≤ 16 ms (typical ≤ 4 ms; the tests assert ≤ 16 ms on a loaded machine). Previews never build copies they don't need: the Repeat preview draws the source pieces moved (`copiesPreviewD`), it never runs the copy functions.
- **Keys (stage-2 rules):** F / H / E are single-letter tool keys — no modifier, never while typing in a field, only when the host offers the tool (`PenOptions.tools`), a live gesture settles first (the existing `selectTool` path). Grep result recorded for this plan: `penKeys.ts TOOL_KEYS` uses v p b l o n t c d g; `isActionKey` uses x and ⇧H / ⇧V (Shift held, so plain **h** is free); the Frame (`CompositorModal.onKeydown`) and Shape Studio (`ShapeStudioSurface.onPenKeydown`) hand every non-viewport key to the pen while it is open; the pen page only takes ⌘0 and Space. **F, H and E collide with nothing.** Modifier combos are matched by `ev.code`; "is this a Mac" is `isApple()` from `composables/pen/penKeys.ts`.
- **Hosts:** the pen page, the Frame's new-drawing and reopened-layer pens and Shape Studio offer Round corner, Chamfer and Offset. The Frame's text-guide pens (`openOnly`) offer Round corner and Chamfer (they reshape the one line the text follows) but not Offset (a second line the text can't follow) — `usePen` drops `offset` for every `openOnly` pen. Repeat stays offered wherever it is today. The toolbar and side panels must fit at 1280 and 1024 px wide in all three hosts (stage 6 found the Frame's side panels hid the tool row at 1024).
- **UI copy:** sentence case, plain words, no identifiers (glyphs such as ⌘Z are fine), things labelled by the user's own content (piece names from `pieceNames`). Explanations live in tooltip cards (`PEN_TIPS`), never as extra text in panels; the toolbar's existing hint row says what to click next, as it does today. Every new button gets a `PEN_TIPS` card; the three new tools get looping demos like the other drawing tools.
- **Bézier segments stay out** of corners and offset (spec): a corner touching a Bézier piece and a source holding one are refused, greyed in the menu with the reason in its card.
- **Frame output:** results are ordinary pieces, so they reach `PathLayer.d` / `fillD` through the existing `sketchToLocalD` / `penOutlines`; guides (virtual sharps, the linear-repeat guide line) never reach the output. No painter change: layers without these features paint byte-identically.
- **Focus and keys in the new panel:** `:focus-visible` can't tell mouse from keyboard in capture listeners, so the Repeat panel's buttons never take focus from a mouse press (`@mousedown.prevent`), fields blur after their Enter, and `isCleanupBarFocused()` also covers `[data-repeat-panel]` — so Space still pans after a click in the panel, Space presses a keyboard-focused control, and Enter on a panel button applies (or cancels on Cancel) and never finishes the pen.
- **Renderless / multi-root components:** `PenToolbar` and `PenProperties` have a renderless `TooltipProvider` root and `PenOverlay` is multi-root; keep `defineOptions({ inheritAttrs: false })` and `v-bind="$attrs"` on their real element. `PenRepeatPanel` renders inside `PenProperties`' real element.
- **`CompositorModal.vue` is heavily edited by other sessions.** This stage needs no edit there (the panel arrives through `PenProperties`, the tools through `useFramePenSession.ts`). If you ever find you must touch it, stage only your hunks (the recipe above).
- Real-mouse checks use `page.mouse` / `page.keyboard` / `locator.click()`, never synthetic `dispatchEvent`. `window.__sketchDraw` hooks may only set up a drawing or read state.
- Unit tests: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run <files>`. Typecheck: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -E '<your files>'` — judged only on files you touched (the repo has a pre-existing error baseline). Browser specs: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test <spec files> --project=chromium` (base URL `http://127.0.0.1:3002` from `playwright.config.ts`).
- Rulings made by this plan (where the spec left a detail open) are marked **Ruling:** and are binding for the implementer.

---

## Rulings (the whole list; each task repeats the ones it needs)

1. **Rule shapes.** `offsetLine [A, B, P]` value d: P's signed distance from the line A→B is d, positive on the left of A→B (drawing axes; the residual's sign is `geom.ts`'s `cross(B − A, P − A) / |AB|`). `offsetRadius [C, S, C, T]` value d: |C T| − |C S| = d; either `[C, S]` pair may instead be one circle id, read with `readCircleOperands` exactly like `tangentArcs` (so a circle offsets to a circle: `offsetRadius [circle, copyCircle]`). `translatedFrom [copy, orig, from, to]` value k: copy = orig + k·(to − from). A rule whose line has zero length is skipped by both the residual and the Jacobian (rows stay aligned); a zero radius and `from` = `to` score normally.
2. **`translatedFrom` copies are substituted** like `rotatedFrom` / `mirroredFrom` copies (`substitute.ts`): a point that is the copy of exactly one copy rule of any of the three kinds is derived, so a linear repeat costs the solver what a radial one does.
3. **What a corner is.** A point where exactly two drawn (non-guide) pieces end — two pieces of one path running through it (then the corner is spliced into that path), or two separate pieces (line entities or open-path ends) meeting there (then the new corner piece is its own one-piece path) — and nothing else uses it (no circle centred on it, no arc centred on it, no handle). A Bézier piece there makes it a "curve" corner: refused. Two pieces leaving in opposite directions (within 0.5°) are already smooth: refused ("This corner is already smooth"). A fold-back (0°) is not a corner. Guides form no corners.
4. **The virtual sharp.** The corner point stays where it is and becomes a guide point (`construction: true` — the small grey hollow dot every guide point is; never in the output). It is tied back: on a straight side `collinear [far, T, X]` (reads "On curve"), on an arc side `equalDist [C, T, C, X]` (reads "On curve"). Every rule that named the corner keeps naming it, so it holds as before.
5. **The new corner piece.** Round: an arc on a new centre point, tangent to both sides with the joint forms the pen already writes (`perpendicular [far, T, T, c]` for a straight side, `collinear [Cside, T, c]` for an arc side) and its own `equalDist [c, T1, c, T2]`. Chamfer: a straight piece with equal setbacks `equalDist [X, T1, X, T2]`. Which of the candidate fillet circles: the one inside the corner's turn (both touch points ahead of the corner on their pieces, the centre inside the wedge of the two leaving directions) with the touch points nearest the corner. A chamfer setback is the straight distance from the corner (on an arc: the point of the arc that far from the corner).
6. **Too big.** A size fits when each touch point lies strictly inside its piece — a piece is never used up — measured on the drawing as the earlier corners of the same apply have left it (so two corners on one short piece can't overlap). A size that doesn't fit previews red and Apply refuses it with "Too big for this corner"; a size with no geometry at all shows a red ring on the corner.
7. **Several corners** get one size, tied with Equal to the first picked: round `equalDist [c₀, T1₀, cₖ, T1ₖ]` (reads "Equal — Arc 3 · Arc 5"), chamfer `equalDist [X₀, T1₀, Xₖ, T1ₖ]`.
8. **The corner tools' gesture.** A press on a corner and a drag sets the size from the pointer (the arc's middle, or the cut's middle, follows the pointer along the corner's bisector) and the release applies. A click (no drag past 3 px) picks the corner (Shift-click adds or removes one) and shows the preview at the default size, waiting for digits (typed in drawing units, shown in the chip) and Enter; Esc cancels. Corners selected before F / H start picked. Default size: the last size used in this pen, else 12 screen px — halved until it fits (up to 8 times). The digits typed win over the pointer.
9. **Offset source.** A selected whole path, line or circle; or the Option-picked pieces of one path, in runs of pieces that follow on from each other (each run offsets on its own). Guides are left out. Any Bézier piece in the source refuses the whole offset ("Bézier curves can’t be offset"). In the tool, a click on a piece takes its whole path (Option-click: just that piece; Shift-click adds).
10. **Offset geometry.** Lines offset to parallel lines, arcs to arcs on the **same centre point** (not a copy of it) with the radius ∓ the distance, a circle to a circle on the same centre; neighbouring offset pieces meet sharp at their carriers' crossing nearest the naive offset of the shared point (parallel neighbours: the naive point). Open chains end opposite the source's ends: `perpendicular [A, B, A, A′]` on a straight end, `collinear [C, A, A′]` on an arc end. Kept live by `offsetLine [A, B, P]` for both ends of every straight offset piece and one `offsetRadius [C, A, C, A′]` per arc piece (the arc's own rule keeps its other end on the circle). The distance is signed: positive on the left of the source's direction of travel (a circle: outside). An offset whose piece would turn back on itself (too far into a tight corner, past an arc's centre, a circle shrunk to nothing) previews red and can't be applied ("Too far for this path"). Round offset corners are out of scope (spec ruling).
11. **The offset gesture.** A press and drag sets the distance and side from the pointer (its signed distance from the nearest source piece) and the release applies. A click on a source shows the preview at the default distance (the last one used, else 12 screen px) on the side of the click, waiting for digits and Enter; typing **−** flips the side. Esc cancels.
12. **Repeat… opens a panel** in the host's side panel — rendered by `PenProperties`, which swaps its body for `PenRepeatPanel` while Repeat is open (no host edit). While it is open the drawing is in preview like Clean up: tools, menus and the wheel are off, a canvas click only picks what the panel asks for, Enter applies, Esc cancels. `repeatPrompt()` keeps its name and now opens the panel; the old count prompt is gone (its two tests are rewritten in Task 8).
13. **Radial:** copies (including the original, 2–64, default 6), sweep (degrees, default 360; 360 spreads the copies evenly round the full turn, less spreads them from 0 to the sweep inclusive), centre — a point clicked, or an empty spot clicked (a fixed point is made there on Apply), or the one point selected with the shapes (today's fast path). Live (`rotatedFrom`).
14. **Linear:** copies, angle (degrees on screen, 0 = right, counter-clockwise, as Properties' Angle), Step or Span and its distance (drawing units; default: the selection's width along the direction × 1.25, so the first preview never overlaps). Live by `translatedFrom` to a dashed guide line from the selection's centre, one step long (Step) or the whole span long (Span; then k = i / (copies − 1)); dragging the guide's far end later changes the spacing and the direction.
15. **Along a path:** copies and the path (a click on any piece takes its whole path; a line or a circle may stand for a path; a Bézier path or one of the repeated pieces is refused). The original stays where it is and counts as the first; the copies' centres land on the path at the points 1…copies−1 of copies points spread evenly by length (open: from start to end, point 0 left to the original; closed: round the loop from its start). Copies keep their orientation and are not tied to the original (spec ruling: not live in v1).
16. **The panel's copy.** Heading "Repeat"; kinds Radial / Linear / Along a path; rows Copies, Centre, Sweep, Angle, Step / Span, Distance, Path; Cancel and Apply. A centre or path not yet picked shows "—" (the hint row says what to click); a picked one shows its name ("Point 4", "Arc 3"); an empty spot shows "New point".
17. **Previews show outlines only** (no fills); the corner preview draws the new and shortened pieces over the drawing, the offset and repeat previews draw the new pieces. Colours: indigo `#6366f1` when it can be applied, red `#ef4444` when it can't.
18. **Canvas badges.** `translatedFrom`, `offsetLine` and `offsetRadius` badges are hidden like the copy rules (one per point would bury the drawing). `translatedFrom` is hidden from the Properties rule list like the other copy rules; the offset rules are listed ("Offset 0.5 — Line 2 · Point 9", "Offset 0.5 — Arc 1 · Arc 4"), hover lights them, × removes one.
19. **Consumers.** On a Cut or a split, an `offsetLine` stays with the half of its source line nearest its offset point, like a tangent line's rule; it goes with the last piece between its line's ends (trim, delete). An `offsetRadius` pair follows its arc like any `[C, S]` operand. A merge that makes a rule meaningless drops it (`offsetLine` with A = B or P on its own line's end, `offsetRadius` with a pair collapsed or the same pair twice, `translatedFrom` with copy = orig or `from` = `to`). A Mirror copy negates `offsetLine` values (its left is the original's right); a resize scales `offsetLine` / `offsetRadius` values, and an upside-down paste negates `offsetLine`. Clean up counts offset points and `translatedFrom` copies as copies (detection runs on sources) and follows the three rules as joining rules. Offset copies take no fill.
20. **Menus.** The selection menu's first group gains Offset… (E), Round corner… (F), Chamfer… (H) after Repeat… (spec order); each picks its tool with the selection as its start, greyed with its reason when it can't act ("Select a corner where two pieces meet", "Bézier curves can’t be rounded or cut", "This corner is already smooth", "Select a path first", "Bézier curves can’t be offset"), hidden in a host that doesn't offer the tool. The wheel is unchanged (its S slice, Repeat, now opens the panel).
21. **Icons and order.** Tool row: … Dissolve, Fill, Round corner (`SquareRoundCorner`), Chamfer (`Octagon`), Offset (`SquareSquare`); the row already wraps (`flex-wrap`), so no host change is needed at 1024 px — the browser spec proves it.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/app/lib/sketch/model.ts` | three new `ConstraintKind`s | 1 |
| `frontend/app/lib/sketch/residuals.ts` | their residuals | 1 |
| `frontend/app/lib/sketch/jacobian.ts` | their analytic rows | 1 |
| `frontend/app/lib/sketch/substitute.ts` | `translatedFrom` copies derived | 1 |
| `frontend/app/lib/sketch/merge.ts` | save / load keeps them | 1 |
| `frontend/app/lib/sketch/annotate.ts` | badge glyphs | 1 |
| `frontend/app/lib/sketch/pieces.ts` | names, tied pieces, copy rule | 1 |
| `frontend/app/lib/sketch/trim.ts` | follow / drop on Cut, split, Dissolve, merge | 2 |
| `frontend/app/lib/sketch/edit.ts` | delete drops `offsetLine`; Mirror negates it (2); `sweep`, `translateEntities`, `copyAlongPath` (7) | 2, 7 |
| `frontend/app/lib/sketch/clipboard.ts` | resize / upside-down values | 2 |
| `frontend/app/lib/sketch/cleanup/guards.ts` | joining rules | 2 |
| `frontend/app/lib/sketch/cleanup/context.ts` | copy points | 2 |
| `frontend/app/components/pen/PenOverlay.vue` | hidden badge kinds (2); corner preview + routing (4); offset (6); repeat preview, picks, keys (8) | 2, 4, 6, 8 |
| `frontend/app/lib/sketch/fills.ts` | `cornerSeeds` | 3 |
| `frontend/app/lib/sketch/corners.ts` (new) | corners, geometry, construction, preview | 3 |
| `frontend/app/composables/pen/penCorners.ts` (new) | the Round corner / Chamfer gesture | 4 |
| `frontend/app/composables/pen/usePen.ts` | tools, wiring, keys, drops (4, 6, 8); action host (9) | 4, 6, 8, 9 |
| `frontend/app/composables/pen/penKeys.ts` | F, H (4), E (6), preview keys | 4, 6 |
| `frontend/app/components/pen/PenToolbar.vue` | buttons, hints (4, 6); Repeat preview state (8) | 4, 6, 8 |
| `frontend/app/composables/pen/penTips.ts` | cards (4, 6, 8) | 4, 6, 8 |
| `frontend/app/composables/pen/penTipDemos.ts` | demos (4, 6) | 4, 6 |
| `frontend/app/pages/dev/sketch-draw.vue` | read-only hooks `corner()`, `offset()`, `repeat()` | 4, 6, 8 |
| `frontend/app/lib/sketch/offset.ts` (new) | offset source, geometry, construction, preview | 5 |
| `frontend/app/composables/pen/penOffset.ts` (new) | the Offset gesture | 6 |
| `frontend/app/lib/sketch/repeatModes.ts` (new) | placements, path sampling, centre, preview | 7 |
| `frontend/app/composables/pen/penRepeat.ts` (new) | the Repeat panel's session | 8 |
| `frontend/app/components/pen/PenRepeatPanel.vue` (new) | the panel | 8 |
| `frontend/app/components/pen/PenProperties.vue` | swaps in the panel | 8 |
| `frontend/app/composables/pen/penActions.ts` | menu entries | 9 |
| `frontend/app/composables/pen/penReasons.ts` | reasons | 9 |
| `frontend/app/composables/frame/useFramePenSession.ts` | Frame tool lists | 9 |
| `frontend/app/composables/geoshape/useShapePenSession.ts` | Shape Studio tool list | 9 |
| `frontend/tests/unit/__fixtures__/penStage8.ts` (new) | `gear`, `rectGrid`, `squarePath` | 3 |
| `frontend/tests/unit/sketch-stage8-rules.unit.spec.ts` (new) | Task 1 | 1 |
| `frontend/tests/unit/sketch-stage8-consumers.unit.spec.ts` (new) | Task 2 | 2 |
| `frontend/tests/unit/sketch-corners.unit.spec.ts` (new) | Task 3 | 3 |
| `frontend/tests/unit/pen-corners.unit.spec.ts` (new), `pen-tips.unit.spec.ts` | Task 4 | 4 |
| `frontend/tests/unit/sketch-offset.unit.spec.ts` (new) | Task 5 | 5 |
| `frontend/tests/unit/pen-offset.unit.spec.ts` (new), `pen-tips.unit.spec.ts` | Task 6 | 6 |
| `frontend/tests/unit/sketch-repeat-modes.unit.spec.ts` (new) | Task 7 | 7 |
| `frontend/tests/unit/pen-repeat-panel.unit.spec.ts` (new), `pen-value-request.unit.spec.ts`, `frontend/tests/sketch-draw.spec.ts` | Task 8 | 8 |
| `frontend/tests/unit/pen-actions.unit.spec.ts`, `frame-pen-session.unit.spec.ts`, `shape-pen-session.unit.spec.ts` | Task 9 | 9 |
| `frontend/tests/pen-corners-offset-repeat.spec.ts` (new), `frame-pen.spec.ts`, `shape-pen.spec.ts` | real mouse, three hosts, widths | 10 |

---
### Task 1: Three new rule kinds in the solver, saved, named and badged

**Files:**
- Modify: `frontend/app/lib/sketch/model.ts` (the `ConstraintKind` union)
- Modify: `frontend/app/lib/sketch/residuals.ts` (three `case`s in `residualsFor`)
- Modify: `frontend/app/lib/sketch/jacobian.ts` (three `case`s in `rowsFor`, header comment)
- Modify: `frontend/app/lib/sketch/substitute.ts` (`translatedFrom` derived)
- Modify: `frontend/app/lib/sketch/merge.ts` (`CONSTRAINT_KINDS`, `NEEDS_VALUE`)
- Modify: `frontend/app/lib/sketch/annotate.ts` (`GLYPH`)
- Modify: `frontend/app/lib/sketch/pieces.ts` (`ruleName`, `rulePieces`, `isCopyRule`)
- Test: `frontend/tests/unit/sketch-stage8-rules.unit.spec.ts`

**Behaviour (Rulings 1, 2, 18):** the residuals, rows and substitution below; `mergeSketchDoc` keeps the three kinds when they carry a finite value and drops them otherwise; labels "Offset 0.5" (the distance's size, the value chip's rounding) and "Linear copy"; `translatedFrom` is a copy rule (hidden from `rulesForSelection`).

**Interfaces:**
- Consumes: `readCircleOperands`, `operandRadius` (`tangency.ts`); `signedDistPartials`, `radiusEntries` (private in `jacobian.ts`).
- Produces: `ConstraintKind` gains `'offsetLine' | 'offsetRadius' | 'translatedFrom'`; `DerivedRule.kind` gains `'translatedFrom'` with optional `fromId`, `toId`, `k`; `isCopyRule(c)` is true for `translatedFrom`; `ruleName` returns `Offset <d>` / `Linear copy`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-stage8-rules.unit.spec.ts`:

```ts
// tests/unit/sketch-stage8-rules.unit.spec.ts
// Pen stage 8: offsetLine / offsetRadius / translatedFrom — residuals, analytic
// Jacobian rows against central differences, degenerate cases, solving (and
// translatedFrom copies substituted like Repeat's), save / load, names.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { buildJacobian } from '~/lib/sketch/jacobian'
import { analyzeDerived } from '~/lib/sketch/substitute'
import { solve } from '~/lib/sketch/solve'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { addPoint, addPath, addCircle, addConstraint } from '~/lib/sketch/edit'
import { ruleName, ruleLabel, pieceNames, pieceIndex, rulesForSelection, isCopyRule } from '~/lib/sketch/pieces'

type Slot = { kind: 'px' | 'py' | 'r'; id: EntityId }
function allSlots(doc: SketchDoc): Slot[] {
  const s: Slot[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') s.push({ kind: 'px', id: e.id }, { kind: 'py', id: e.id })
    else if (e.kind === 'circle') s.push({ kind: 'r', id: e.id })
  }
  return s
}
const get = (d: SketchDoc, s: Slot) => { const e = d.entities.find(x => x.id === s.id) as any; return s.kind === 'px' ? e.x : s.kind === 'py' ? e.y : e.r }
const set = (d: SketchDoc, s: Slot, v: number) => { const e = d.entities.find(x => x.id === s.id) as any; if (s.kind === 'px') e.x = v; else if (s.kind === 'py') e.y = v; else e.r = v }
function numeric(doc: SketchDoc, slots: Slot[]): number[][] {
  const h = 1e-6, m = constraintResiduals(doc).length
  const J = Array.from({ length: m }, () => new Array(slots.length).fill(0))
  slots.forEach((s, j) => {
    const o = get(doc, s)
    set(doc, s, o + h); const rp = constraintResiduals(doc)
    set(doc, s, o - h); const rm = constraintResiduals(doc)
    set(doc, s, o)
    for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * h)
  })
  return J
}
function expectRowsMatch(doc: SketchDoc) {
  const slots = allSlots(doc)
  const a = buildJacobian(doc, slots), n = numeric(doc, slots)
  expect(a.length).toBe(n.length)
  a.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(v - n[i]![j]!), `row ${i} col ${j}`).toBeLessThan(1e-4)))
}
const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('offsetLine [A, B, P] value d', () => {
  it('is P’s signed distance from A→B (left positive) minus d', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 2), q = addPoint(d, 3, -1)
    addConstraint(d, 'offsetLine', [a, b, p], 2)
    addConstraint(d, 'offsetLine', [a, b, q], 2)
    const r = constraintResiduals(d)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(-3, 12)
  })
  it('analytic rows match central differences, either side, slanted', () => {
    const d = doc()
    const a = addPoint(d, 0.3, -0.2), b = addPoint(d, 4.1, 1.7), p = addPoint(d, 1, 2.5), q = addPoint(d, 3, -1)
    addConstraint(d, 'offsetLine', [a, b, p], 1.5)
    addConstraint(d, 'offsetLine', [a, b, q], -0.7)
    expectRowsMatch(d)
  })
  it('a zero-length line scores nothing and has no row', () => {
    const d = doc()
    const a = addPoint(d, 1, 1), b = addPoint(d, 1, 1), p = addPoint(d, 3, 3)
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    expect(constraintResiduals(d)).toHaveLength(0)
    expect(buildJacobian(d, allSlots(d))).toHaveLength(0)
  })
  it('without a value it scores nothing', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 2)
    addConstraint(d, 'offsetLine', [a, b, p])
    expect(constraintResiduals(d)).toHaveLength(0)
    expect(buildJacobian(d, allSlots(d))).toHaveLength(0)
  })
  it('solving holds the copy at the distance when its source line turns', () => {
    const d = doc()
    const a = addPoint(d, 0, 0, { fixed: true }), b = addPoint(d, 4, 0), p = addPoint(d, 2, 1)
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    expect(solve(d, { drag: { point: b, x: 0, y: 4 } }).converged).toBe(true)
    // the line now runs up the y axis: its left is −x
    expect(P(d, p).x).toBeCloseTo(-1, 5)
  })
})

describe('offsetRadius [C, S, C, T] value d', () => {
  it('is |CT| − |CS| − d, pairs or circle ids', () => {
    const d = doc()
    const c = addPoint(d, 0, 0), s = addPoint(d, 3, 0), t = addPoint(d, 0, 4)
    addConstraint(d, 'offsetRadius', [c, s, c, t], 1)
    const c1 = addCircle(d, c, 2), c2 = addCircle(d, c, 2.5)
    addConstraint(d, 'offsetRadius', [c1, c2], 0.5)
    addConstraint(d, 'offsetRadius', [c, s, c2], -1)
    const r = constraintResiduals(d)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(0, 12)
    expect(r[2]).toBeCloseTo(0.5, 12)
  })
  it('analytic rows match central differences (pairs, circles, mixed)', () => {
    const d = doc()
    const c = addPoint(d, 0.2, -0.3), s = addPoint(d, 3, 0.5), t = addPoint(d, -0.5, 4), c3 = addPoint(d, 5, 5)
    addConstraint(d, 'offsetRadius', [c, s, c, t], 1)
    const k1 = addCircle(d, c3, 2), k2 = addCircle(d, c3, 2.7)
    addConstraint(d, 'offsetRadius', [k1, k2], 0.5)
    addConstraint(d, 'offsetRadius', [c, s, k2], -1)
    expectRowsMatch(d)
  })
  it('a zero radius still scores (|CT| − 0 − d), one row', () => {
    const d = doc()
    const c = addPoint(d, 1, 1), s = addPoint(d, 1, 1), t = addPoint(d, 1, 3)
    addConstraint(d, 'offsetRadius', [c, s, c, t], 2)
    expect(constraintResiduals(d)).toEqual([0])
    expect(buildJacobian(d, allSlots(d))).toHaveLength(1)
  })
  it('solving keeps an offset arc’s radius when the source arc grows', () => {
    const d = doc()
    const c = addPoint(d, 0, 0, { fixed: true }), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    const t = addPoint(d, 2, 0), u = addPoint(d, 0, 2)
    addPath(d, [t, u], [{ kind: 'arc', center: c, sweep: 1 }])
    addConstraint(d, 'offsetRadius', [c, s, c, t], -1)
    expect(solve(d, { drag: { point: s, x: 5, y: 0 } }).converged).toBe(true)
    expect(Math.hypot(P(d, t).x, P(d, t).y)).toBeCloseTo(4, 5)
    expect(Math.hypot(P(d, u).x, P(d, u).y)).toBeCloseTo(4, 5)
  })
})

describe('translatedFrom [copy, orig, from, to] value k', () => {
  it('is copy − (orig + k·(to − from)), two rows', () => {
    const d = doc()
    const o = addPoint(d, 1, 1), f = addPoint(d, 0, 0), t = addPoint(d, 2, 1), c = addPoint(d, 5, 3)
    addConstraint(d, 'translatedFrom', [c, o, f, t], 2)
    expect(constraintResiduals(d).map(v => Math.abs(v) < 1e-12)).toEqual([true, true])
  })
  it('analytic rows match central differences, k = 2.5 and from = to', () => {
    const d = doc()
    const o = addPoint(d, 1, 1.5), f = addPoint(d, -0.2, 0.1), t = addPoint(d, 2, 1), c = addPoint(d, 7, 3)
    addConstraint(d, 'translatedFrom', [c, o, f, t], 2.5)
    addConstraint(d, 'translatedFrom', [c, o, f, f], 1)   // from = to: copy = orig
    expectRowsMatch(d)
    expect(constraintResiduals(d).slice(2)).toEqual([P(d, c).x - P(d, o).x, P(d, c).y - P(d, o).y])
  })
  it('its copies are derived (substituted) like Repeat’s, and follow a drag of the guide’s end', () => {
    const d = doc()
    const f = addPoint(d, 0, 0, { fixed: true }), t = addPoint(d, 2, 0)
    const src = [[0, 0.5], [1, 0.5], [1, 1.5]].map(([x, y]) => addPoint(d, x!, y!))
    const copies: string[] = []
    for (const k of [1, 2, 3]) for (const s of src) {
      const cp = addPoint(d, P(d, s).x + 2 * k, P(d, s).y)
      addConstraint(d, 'translatedFrom', [cp, s, f, t], k)
      copies.push(cp)
    }
    expect(analyzeDerived(d, new Set()).rules.size).toBe(9)
    expect(solve(d, { drag: { point: t, x: 0, y: 3 } }).converged).toBe(true)
    // the third copy of the first source point: (0, 0.5) + 3·(0, 3)
    expect(P(d, copies[6]!).x).toBeCloseTo(0, 6)
    expect(P(d, copies[6]!).y).toBeCloseTo(9.5, 6)
  })
})

describe('save / load and names', () => {
  it('mergeSketchDoc keeps the three kinds with a value and drops one without', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 2)
    addConstraint(d, 'offsetLine', [a, b, p], 2)
    addConstraint(d, 'offsetRadius', [a, b, a, p], 1)
    addConstraint(d, 'translatedFrom', [p, a, a, b], 1)
    addConstraint(d, 'offsetLine', [a, b, p])
    const m = mergeSketchDoc(JSON.parse(JSON.stringify(d)))
    expect(m.constraints.map(c => c.kind)).toEqual(['offsetLine', 'offsetRadius', 'translatedFrom'])
  })
  it('names in plain words, pieces by their names; linear copies hidden, offsets listed', () => {
    const d = doc()
    const c = addPoint(d, 0, 0), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3), t = addPoint(d, 2, 0), u = addPoint(d, 0, 2)
    const arc1 = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    addPath(d, [t, u], [{ kind: 'arc', center: c, sweep: 1 }])
    const off = addConstraint(d, 'offsetRadius', [c, s, c, t], -1)
    const lin = addConstraint(d, 'translatedFrom', [u, e, c, s], 0.5)
    const ix = pieceIndex(d), names = pieceNames(d, ix)
    const k = (id: string) => d.constraints.find(x => x.id === id)!
    expect(ruleName(d, k(off), ix)).toBe('Offset 1')
    expect(ruleLabel(d, k(off), names, ix)).toBe('Offset 1 — Arc 1 · Arc 2')
    expect(ruleName(d, k(lin), ix)).toBe('Linear copy')
    expect(isCopyRule(k(lin))).toBe(true)
    const listed = rulesForSelection(d, [arc1], [], ix).map(x => x.id)
    expect(listed).toContain(off)
    expect(listed).not.toContain(lin)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-stage8-rules.unit.spec.ts`
Expected: FAIL — the residual tests score nothing for the unknown kinds (`expected [] to have length …`), the merge test keeps none, the names are `undefined`.

- [ ] **Step 3: Add the kinds** — in `frontend/app/lib/sketch/model.ts`, extend the union after `| 'tangentLineArc' | 'tangentArcs'`:

```ts
  // pen stage 8 (Ruling 1): offsetLine [A, B, P] value d — P's signed
  // distance from line A→B is d (left positive); offsetRadius [C, S, C, T]
  // value d — |C T| − |C S| = d (either pair may be a circle id);
  // translatedFrom [copy, orig, from, to] value k — copy = orig + k·(to − from)
  | 'offsetLine' | 'offsetRadius' | 'translatedFrom'
```

- [ ] **Step 4: Residuals** — in `frontend/app/lib/sketch/residuals.ts`, add before `default:` in `residualsFor`:

```ts
    case 'offsetLine': {
      // refs=[A, B, P]: P's signed distance from A→B (left +) minus d; a
      // zero-length line scores nothing (jacobian.ts skips it the same way)
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!); const p = pointOf(map, c.refs[2]!)
      if (!a || !b || !p || c.value == null) return null
      const dx = b.x - a.x, dy = b.y - a.y
      const L = Math.hypot(dx, dy)
      if (L < 1e-12) return null
      return [(dx * (p.y - a.y) - dy * (p.x - a.x)) / L - c.value]
    }
    case 'offsetRadius': {
      // two circle operands ([C, S] pairs or circle ids): r2 − r1 − d
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || c.value == null) return null
      return [operandRadius(ops[1]!) - operandRadius(ops[0]!) - c.value]
    }
    case 'translatedFrom': {
      // refs=[copy, orig, from, to]: copy = orig + k·(to − from)
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!)
      const fr = pointOf(map, c.refs[2]!); const to = pointOf(map, c.refs[3]!)
      if (!cp || !og || !fr || !to || c.value == null) return null
      const k = c.value
      return [cp.x - og.x - k * (to.x - fr.x), cp.y - og.y - k * (to.y - fr.y)]
    }
```

- [ ] **Step 5: Analytic rows** — in `frontend/app/lib/sketch/jacobian.ts`, add `offsetLine, offsetRadius, translatedFrom` to the header's ANALYTIC list, and add before `default:` in `rowsFor`:

```ts
    case 'offsetLine': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!); const p = pointOf(map, c.refs[2]!)
      if (!a || !b || !p || c.value == null) return null
      // the same signed distance residualsFor scores (num / L); null for a
      // zero-length line, which residualsFor skips too — rows stay aligned
      const sd = signedDistPartials(p.x, p.y, a.x, a.y, b.x, b.y)
      if (!sd) return null
      return [[
        px(p.id, sd.dPx), py(p.id, sd.dPy),
        px(a.id, sd.dAx), py(a.id, sd.dAy),
        px(b.id, sd.dBx), py(b.id, sd.dBy),
      ]]
    }
    case 'offsetRadius': {
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || c.value == null) return null
      return [[...radiusEntries(ops[1]!, 1), ...radiusEntries(ops[0]!, -1)]]
    }
    case 'translatedFrom': {
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!)
      const fr = pointOf(map, c.refs[2]!); const to = pointOf(map, c.refs[3]!)
      if (!cp || !og || !fr || !to || c.value == null) return null
      const k = c.value
      // from = to (one id): the ±k entries land in one column and cancel
      return [
        [px(cp.id, 1), px(og.id, -1), px(to.id, -k), px(fr.id, k)],
        [py(cp.id, 1), py(og.id, -1), py(to.id, -k), py(fr.id, k)],
      ]
    }
```

- [ ] **Step 6: Substitution** — in `frontend/app/lib/sketch/substitute.ts`:
  - extend the header comment's list with `translatedFrom[D, orig, from, to], k: D = orig + k·(to − from)`;
  - in `DerivedRule`: `kind: 'rotatedFrom' | 'mirroredFrom' | 'translatedFrom'` and add
    ```ts
      fromId?: EntityId       // translatedFrom: refs[2]
      toId?: EntityId         // translatedFrom: refs[3]
      k?: number              // translatedFrom: value
    ```
  - add under the imports `const COPY_KINDS = new Set<string>(['rotatedFrom', 'mirroredFrom', 'translatedFrom'])`;
  - in `analyzeDerived`, count with `if (COPY_KINDS.has(c.kind))`, skip with `if (!COPY_KINDS.has(c.kind)) continue`, and replace the `if (c.kind === 'rotatedFrom') { … } else { … }` block with:
    ```ts
    if (c.kind === 'rotatedFrom') {
      const og = pt(map, c.refs[1]!); const ce = pt(map, c.refs[2]!)
      if (!og || !ce || c.value == null) continue
      const a = c.value * Math.PI / 180
      rules.set(d, { id: d, constraintId: c.id, kind: 'rotatedFrom', origId: og.id, centerId: ce.id, cos: Math.cos(a), sin: Math.sin(a) })
    } else if (c.kind === 'translatedFrom') {
      const og = pt(map, c.refs[1]!); const fr = pt(map, c.refs[2]!); const to = pt(map, c.refs[3]!)
      if (!og || !fr || !to || c.value == null) continue
      rules.set(d, { id: d, constraintId: c.id, kind: 'translatedFrom', origId: og.id, fromId: fr.id, toId: to.id, k: c.value, cos: 0, sin: 0 })
    } else {
      const og = pt(map, c.refs[1]!); const l = map.get(c.refs[2]!)
      if (!og || !l || l.kind !== 'line') continue
      const a = pt(map, l.p1); const b = pt(map, l.p2)
      if (!a || !b) continue
      rules.set(d, { id: d, constraintId: c.id, kind: 'mirroredFrom', origId: og.id, axisAId: a.id, axisBId: b.id, cos: 0, sin: 0 })
    }
    ```
  - `sourcesOf`:
    ```ts
    const sourcesOf = (r: DerivedRule): EntityId[] =>
      r.kind === 'rotatedFrom' ? [r.origId, r.centerId!]
      : r.kind === 'translatedFrom' ? [r.origId, r.fromId!, r.toId!]
      : [r.origId, r.axisAId!, r.axisBId!]
    ```
    (a copy that is its own original lists itself as a pending source, never emits, and drops back to a free point — correctness over speed, as the comment there says);
  - `forwardSubstitute`, a branch before the mirror `else`:
    ```ts
    } else if (r.kind === 'translatedFrom') {
      const og = map.get(r.origId) as PointEntity
      const fr = map.get(r.fromId!) as PointEntity
      const to = map.get(r.toId!) as PointEntity
      D.x = og.x + r.k! * (to.x - fr.x)
      D.y = og.y + r.k! * (to.y - fr.y)
    }
    ```
  - `derivedGradients`, before the mirror part:
    ```ts
    if (r.kind === 'translatedFrom') {
      const k = r.k!
      return {
        gx: [{ id: r.origId, comp: 'px', d: 1 }, { id: r.toId!, comp: 'px', d: k }, { id: r.fromId!, comp: 'px', d: -k }],
        gy: [{ id: r.origId, comp: 'py', d: 1 }, { id: r.toId!, comp: 'py', d: k }, { id: r.fromId!, comp: 'py', d: -k }],
      }
    }
    ```

- [ ] **Step 7: Save / load, glyphs, names** —
  - `frontend/app/lib/sketch/merge.ts`: append `'offsetLine', 'offsetRadius', 'translatedFrom'` to `CONSTRAINT_KINDS` and add all three to `NEEDS_VALUE`.
  - `frontend/app/lib/sketch/annotate.ts`: add to `GLYPH` `offsetLine: '⇉', offsetRadius: '⇉', translatedFrom: '→',` (hidden on the canvas by Task 2; the record must name every kind).
  - `frontend/app/lib/sketch/pieces.ts`:
    - in `rulePieces`, before `default:`:
      ```ts
      case 'offsetLine':
        return dedupe([...pairPieces(ix, r[0]!, r[1]!), entityPiece(ix, r[2]!)])
      case 'offsetRadius':
        return dedupe(operandPieces(ix, r, 0))
      ```
    - in `ruleName`, after `case 'midpoint'`:
      ```ts
      case 'offsetLine': case 'offsetRadius': return `Offset ${fmt(Math.abs(c.value ?? 0))}`
      case 'translatedFrom': return 'Linear copy'
      ```
    - `export const isCopyRule = (c: SketchConstraint): boolean => c.kind === 'rotatedFrom' || c.kind === 'mirroredFrom' || c.kind === 'translatedFrom'` and add "Linear" to its comment.

- [ ] **Step 8: Run the tests to verify they pass, and the solver's own suites**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-stage8-rules.unit.spec.ts tests/unit/sketch-jacobian.unit.spec.ts tests/unit/sketch-substitution.unit.spec.ts tests/unit/sketch-solve.unit.spec.ts tests/unit/sketch-solve-perf.unit.spec.ts tests/unit/sketch-pieces.unit.spec.ts tests/unit/sketch-model.unit.spec.ts`
Expected: PASS. Then `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(model|residuals|jacobian|substitute|merge|annotate|pieces)\.ts'` prints nothing.

- [ ] **Step 9: Commit**

```bash
git add frontend/app/lib/sketch/model.ts frontend/app/lib/sketch/residuals.ts frontend/app/lib/sketch/jacobian.ts frontend/app/lib/sketch/substitute.ts frontend/app/lib/sketch/merge.ts frontend/app/lib/sketch/annotate.ts frontend/app/lib/sketch/pieces.ts frontend/tests/unit/sketch-stage8-rules.unit.spec.ts
git commit -m "feat(pen): offsetLine, offsetRadius and translatedFrom rules — residuals, analytic rows, substituted copies, saved and named (stage 8)"
```
(through the private index — Global Constraints)

---

### Task 2: Every consumer learns the new rules

**Files:**
- Modify: `frontend/app/lib/sketch/trim.ts` (`pairSlots` / `followPair` / `nearerHalf`, `operandSlots`, `isTrivial`)
- Modify: `frontend/app/lib/sketch/edit.ts` (`deleteEntity`; `mirrorEntities` via `copyClosureConstraints`)
- Modify: `frontend/app/lib/sketch/clipboard.ts` (`scalePieces`)
- Modify: `frontend/app/lib/sketch/cleanup/guards.ts` (`JOINING`)
- Modify: `frontend/app/lib/sketch/cleanup/context.ts` (`copyPoints`)
- Modify: `frontend/app/components/pen/PenOverlay.vue` (`STRUCTURAL_MARK_KINDS`)
- Test: `frontend/tests/unit/sketch-stage8-consumers.unit.spec.ts`

**Behaviour (Rulings 18, 19):**
- trim.ts: a new pair category `'off'` for `offsetLine` (slot `[0, 1]`): removed with its pair; rewritten when an end moves along the same line or grows (Dissolve); on a split or a Cut it goes to the half nearest its offset point (the foot of refs[2] on the line) — the same treatment `'tan'` gets, with the foot in place of the touch point. `operandSlots` reads `offsetRadius`'s operands (pairs only; circle ids skipped) so `followArcOperands` re-aims or drops them. `isTrivial`: `offsetLine` with A = B or P = A or P = B; `offsetRadius` with a collapsed pair (C = S) or the same operand twice; `translatedFrom` with copy = orig or `from` = `to`.
- edit.ts: `deleteEntity` of a line drops the `offsetLine`s naming its ends when no piece spans them any more (as it does `tangentLineArc`). `mirrorEntities`' copied closure rules negate `offsetLine` values.
- clipboard.ts: `scalePieces` scales `offsetLine` / `offsetRadius` values by the factor and negates `offsetLine` when turned upside down.
- Clean up: `offsetLine`, `offsetRadius`, `translatedFrom` join parts (window hops follow them); `copyPoints` adds `translatedFrom`'s copy (refs[0]), `offsetLine`'s offset point (refs[2]) and every `[C, T]` operand point of `offsetRadius`'s second pair (refs[3]) — the copy side, never the source.
- Rule checks need no change (they read residuals and rows generically); the test proves the verdicts.
- The canvas hides the three kinds' badges.

**Interfaces:**
- Consumes: Task 1's kinds.
- Produces: nothing new for later tasks (behaviour only).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-stage8-consumers.unit.spec.ts`:

```ts
// tests/unit/sketch-stage8-consumers.unit.spec.ts
// Pen stage 8: every consumer of the rules knows offsetLine / offsetRadius /
// translatedFrom — trim, Cut, Dissolve, merging points, delete, Mirror copies,
// Copy / Paste / resize, Clean up (joining, copy points, no fights), the rule
// checks — so none is ever left dangling, pulling the drawing invisibly.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint, deleteEntity, mirrorEntities } from '~/lib/sketch/edit'
import { cutAt, removeSpan, dissolveAt, mergePoints } from '~/lib/sketch/trim'
import { spanAt } from '~/lib/sketch/crossings'
import { extractPieces, insertPieces, scalePieces } from '~/lib/sketch/clipboard'
import { joinsParts } from '~/lib/sketch/cleanup/guards'
import { copyPoints } from '~/lib/sketch/cleanup/context'
import { runCleanup } from '~/lib/sketch/cleanup'
import { checkRule, quickRuleCheck } from '~/lib/sketch/ruleCheck'
import { constraintResiduals } from '~/lib/sketch/residuals'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const rules = (d: SketchDoc, kind: string) => d.constraints.filter(c => c.kind === kind)
/** every rule's refs resolve to something in the drawing */
function noDangling(d: SketchDoc) {
  const ids = new Set(d.entities.map(e => e.id))
  for (const c of d.constraints) for (const r of c.refs) expect(ids.has(r), `${c.kind} ${c.id} → ${r}`).toBe(true)
}
/** a source path line A→B (one piece) and an offset copy's two ends P, Q at +1 */
function offsetPair() {
  const d = doc()
  const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
  const src = addPath(d, [a, b], [{ kind: 'line' }])
  const p = addPoint(d, 0, 1), q = addPoint(d, 10, 1)
  const cp = addPath(d, [p, q], [{ kind: 'line' }])
  const k1 = addConstraint(d, 'offsetLine', [a, b, p], 1), k2 = addConstraint(d, 'offsetLine', [a, b, q], 1)
  return { d, a, b, p, q, src, cp, k1, k2 }
}

describe('trim, Cut, Dissolve, merging points', () => {
  it('Cut: each offsetLine goes to the half of its source nearest its offset point', () => {
    const { d, src, p, q } = offsetPair()
    expect(cutAt(d, { kind: 'seg', pathId: src, segIndex: 0 }, 0.5)).not.toBeNull()
    const P = (id: EntityId) => d.entities.find(e => e.id === id) as any
    for (const c of rules(d, 'offsetLine')) {
      const [a, b, pt] = c.refs.map(P)
      const midX = (a.x + b.x) / 2
      expect(Math.abs(midX - pt.x)).toBeLessThan(3)   // the near half (the whole line's middle is 5 away)
    }
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-9)).toBe(true)
    noDangling(d)
    void p; void q
  })
  it('Trim away a source side whose ends stay: its offsetLines go (counted), none names a gone piece', () => {
    const d = doc()
    const [a, b, c, e] = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => addPoint(d, x!, y!))
    const sq = addPath(d, [a!, b!, c!, e!], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    const p = addPoint(d, 0, -1), q = addPoint(d, 10, -1)
    addPath(d, [p, q], [{ kind: 'line' }])
    addConstraint(d, 'offsetLine', [a!, b!, p], -1); addConstraint(d, 'offsetLine', [a!, b!, q], -1)
    const r = removeSpan(d, spanAt(d, { kind: 'seg', pathId: sq, segIndex: 0 }, 0.5)!)
    expect(r.ok).toBe(true)
    expect(d.entities.some(x => x.id === a) && d.entities.some(x => x.id === b)).toBe(true)
    expect(rules(d, 'offsetLine')).toHaveLength(0)
    expect(r.droppedRules).toBe(2)
    noDangling(d)
  })
  it('Dissolve two collinear source pieces: the rules follow onto the one piece', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), m = addPoint(d, 5, 0), b = addPoint(d, 10, 0)
    const path = addPath(d, [a, m, b], [{ kind: 'line' }, { kind: 'line' }])
    const p = addPoint(d, 2, 1)
    addConstraint(d, 'offsetLine', [a, m, p], 1)
    expect(dissolveAt(d, path, 1, 1e-6, 0.5).ok).toBe(true)
    expect(rules(d, 'offsetLine').map(c => c.refs)).toEqual([[a, b, p]])
  })
  it('merging points drops what became meaningless', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 1), f = addPoint(d, 0, 3), t = addPoint(d, 1, 3), cp = addPoint(d, 2, 2)
    addLine(d, a, b)
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    addConstraint(d, 'translatedFrom', [cp, p, f, t], 1)
    mergePoints(d, t, f)                 // from = to
    expect(rules(d, 'translatedFrom')).toHaveLength(0)
    mergePoints(d, p, a)                 // P onto its own line's end
    expect(rules(d, 'offsetLine')).toHaveLength(0)
  })
  it('an offsetRadius pair follows its arc when the arc is cut', () => {
    const d = doc()
    const c = addPoint(d, 0, 0), s = addPoint(d, 3, 0), e = addPoint(d, -3, 0), t = addPoint(d, 2, 0), u = addPoint(d, -2, 0)
    const arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    addPath(d, [t, u], [{ kind: 'arc', center: c, sweep: 1 }])
    addConstraint(d, 'offsetRadius', [c, s, c, t], -1)
    expect(cutAt(d, { kind: 'seg', pathId: arc, segIndex: 0 }, 0.5)).not.toBeNull()
    expect(rules(d, 'offsetRadius')).toHaveLength(1)
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-9)).toBe(true)
    noDangling(d)
  })
})

describe('delete, Mirror, Copy / Paste, resize', () => {
  it('deleting the source line drops its offsetLines', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), p = addPoint(d, 0, 1)
    const l = addLine(d, a, b)
    addPath(d, [p, addPoint(d, 10, 1)], [{ kind: 'line' }])
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    deleteEntity(d, l)
    expect(rules(d, 'offsetLine')).toHaveLength(0)
    noDangling(d)
  })
  it('a Mirror copy of an offset pair keeps the copy on the mirrored side', () => {
    const { d, src, cp } = offsetPair()
    const ax1 = addPoint(d, -5, -5), ax2 = addPoint(d, -5, 5)
    const axis = addLine(d, ax1, ax2, { construction: true })
    mirrorEntities(d, [src, cp], axis)
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-9)).toBe(true)
    expect(rules(d, 'offsetLine').filter(c => c.value === -1)).toHaveLength(2)
  })
  it('Copy / Paste re-points every ref; resize scales, upside down flips the side', () => {
    const { d, src, cp } = offsetPair()
    const clip = extractPieces(d, [src, cp], [])
    expect(rules(clip, 'offsetLine')).toHaveLength(2)
    const big = scalePieces(clip, 2)
    expect(rules(big, 'offsetLine').map(c => c.value)).toEqual([2, 2])
    const flipped = scalePieces(clip, 1, true)
    expect(rules(flipped, 'offsetLine').map(c => c.value)).toEqual([-1, -1])
    expect(constraintResiduals(flipped).every(v => Math.abs(v) < 1e-9)).toBe(true)
    const before = new Set(d.entities.map(e => e.id))
    insertPieces(d, clip, { x: 0, y: 5 })
    const pasted = d.constraints.filter(c => c.kind === 'offsetLine' && c.refs.every(r => !before.has(r)))
    expect(pasted).toHaveLength(2)
    noDangling(d)
  })
})

describe('Clean up and the rule checks', () => {
  it('the three kinds join parts; offset points and linear copies are copies', () => {
    const { d, p, q } = offsetPair()
    const f = addPoint(d, 0, 5), t = addPoint(d, 3, 5), o = addPoint(d, 20, 20), c = addPoint(d, 23, 20)
    addConstraint(d, 'translatedFrom', [c, o, f, t], 1)
    for (const k of d.constraints) expect(joinsParts(k)).toBe(true)
    const copies = copyPoints(d)
    expect([...copies].sort()).toEqual([c, p, q].sort())
  })
  it('Clean up proposes nothing between a source and its offset copy', () => {
    const { d } = offsetPair()
    const r = runCleanup(d, { unitsPerPx: 0.05, strength: 'strong', scope: null, off: new Set(), budgetMs: 1e9 })
    expect(r.fixes.filter(f => f.kind === 'parallel' || f.kind === 'equalLength')).toHaveLength(0)
  })
  it('Parallel between a source and its offset copy is already true', () => {
    const { d, a, b, p, q } = offsetPair()
    const spec = { kind: 'parallel' as const, refs: [a, b, p, q] }
    expect(quickRuleCheck(d, spec)).toBe('ok')           // no equivalent rule written: the cheap check allows it
    expect(checkRule(d, spec)).toBe('already')           // the full check finds it implied
  })
})
```

(The names are the ones `trim.ts` exports today: `cutAt(doc, ref, t) → EntityId | null`, `removeSpan(doc, span) → TrimResult`, `dissolveAt(doc, pathId, anchorIndex, tolUnits, tolDeg) → TrimResult`; Clean up's fix kinds are `FixKind` in `cleanup/types.ts`. If one has moved since, change only the test's call, never what it asserts.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-stage8-consumers.unit.spec.ts`
Expected: FAIL — Cut leaves both `offsetLine`s on the far pair, trim leaves them dangling (`droppedRules` 0), merges keep meaningless rules, delete keeps them, Mirror keeps `+1`, resize keeps `1`, `joinsParts` is false, `copyPoints` is empty.

- [ ] **Step 3: trim.ts** —
  - `type PairCat = 'dir' | 'len' | 'pin' | 'tan' | 'off'` and, in `pairSlots`, before `default:`:
    ```ts
    case 'offsetLine':
      return r.length === 3 ? { cat: 'off', slots: [[0, 1]] } : null
    ```
  - generalise `nearerHalf` to take the spot the rule belongs near:
    ```ts
    // the spot a rule on a line belongs near: a tangent line's touch point, an
    // offset line's copy point dropped onto the line
    function ruleSpot(doc: SketchDoc, c: SketchConstraint): Vec2 | null {
      if (c.kind === 'offsetLine') {
        const a = getPoint(doc, c.refs[0]!), b = getPoint(doc, c.refs[1]!), p = getPoint(doc, c.refs[2]!)
        if (!a || !b || !p) return null
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy
        if (L2 < 1e-18) return null
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2
        return { x: a.x + t * dx, y: a.y + t * dy }
      }
      return tangentTouchPoint(doc, c)
    }
    ```
    and in `nearerHalf` replace `const touch = tangentTouchPoint(doc, c)` with `const touch = ruleSpot(doc, c)`.
  - in `followPair`, treat `'off'` exactly as `'tan'`: change the two `info.cat === 'tan'` tests to `(info.cat === 'tan' || info.cat === 'off')`. (On `moved` / `grow` the `else` branch already rewrites any non-`len` rule.)
  - `operandSlots`, before `if (c.kind !== 'tangentArcs') return []`:
    ```ts
    if (c.kind === 'offsetRadius') {
      const out: [number, number][] = []
      for (let i = 0; i < r.length;) {
        if (getEntity(doc, r[i]!)?.kind === 'circle') { i += 1; continue }
        out.push([i, i + 1]); i += 2
      }
      return out
    }
    ```
  - `isTrivial`, before `default:`:
    ```ts
    case 'offsetLine':
      return r[0] === r[1] || r[2] === r[0] || r[2] === r[1]
    case 'offsetRadius': {
      const ops: string[] = []
      for (let i = 0; i < r.length;) {
        if (getEntity(doc, r[i]!)?.kind === 'circle') { ops.push(r[i]!); i += 1; continue }
        if (r[i] === r[i + 1]) return true            // a pair collapsed to one point
        ops.push(`${r[i]},${r[i + 1]}`); i += 2
      }
      return ops.length === 2 && ops[0] === ops[1]
    }
    case 'translatedFrom':
      return r[0] === r[1] || r[2] === r[3]
    ```

- [ ] **Step 4: edit.ts** —
  - in `deleteEntity`, widen the tangent-line filter:
    ```ts
    if (e.kind === 'line' && !spansLine(doc, e.p1, e.p2)) {
      // a tangent or offset line names its ends, not its id: it goes with the last piece between them
      doc.constraints = doc.constraints.filter(c => !((c.kind === 'tangentLineArc' || c.kind === 'offsetLine') &&
        ((c.refs[0] === e.p1 && c.refs[1] === e.p2) || (c.refs[0] === e.p2 && c.refs[1] === e.p1))))
    }
    ```
    and do the same for a path whose line segment was the last piece between two points: after the path's own `equalDist` filter in the `e.kind === 'path'` branch, add
    ```ts
    // tangent / offset lines that named one of its straight pieces go with the last piece between those ends
    e.segments.forEach((s, i) => {
      if (s.kind !== 'line') return
      const a = e.anchors[i]!, b = e.anchors[(i + 1) % e.anchors.length]!
      if (spansLine(doc, a, b)) return
      doc.constraints = doc.constraints.filter(c => !((c.kind === 'tangentLineArc' || c.kind === 'offsetLine') &&
        ((c.refs[0] === a && c.refs[1] === b) || (c.refs[0] === b && c.refs[1] === a))))
    })
    ```
    (this block must run before the member-point orphan clean, which reads `doc.constraints`; the `e.segments` captured before removal are still on `e`).
  - `copyClosureConstraints` gains a flag so Mirror can flip offset sides:
    ```ts
    function copyClosureConstraints(doc: SketchDoc, map: Map<EntityId, EntityId>, mirrored = false): void {
      const source = new Set(map.keys())
      for (const c of [...doc.constraints]) {
        if (c.refs.length > 0 && c.refs.every(r => source.has(r))) {
          // a mirror copy's left is the original's right (Ruling 19)
          const value = mirrored && c.kind === 'offsetLine' && c.value != null ? -c.value : c.value
          addConstraint(doc, c.kind, c.refs.map(r => map.get(r)!), value)
        }
      }
    }
    ```
    and call `copyClosureConstraints(doc, map, true)` in `mirrorEntities` (leave `repeatEntities`' call as is).

- [ ] **Step 5: clipboard.ts** — in `scalePieces`' `constraints` map:

```ts
  const constraints = clip.constraints.map(k => {
    const c = { ...k, refs: [...k.refs] }
    if (c.value != null && (c.kind === 'distance' || c.kind === 'radius' || c.kind === 'offsetLine' || c.kind === 'offsetRadius')) c.value *= factor
    if (c.value != null && flipY && (c.kind === 'rotatedFrom' || c.kind === 'offsetLine')) c.value = -c.value
    return c
  })
```
and extend its doc comment: "offset distances scale; upside down, an offset lies on the other side".

- [ ] **Step 6: Clean up** —
  - `cleanup/guards.ts` `JOINING`: add `'offsetLine', 'offsetRadius', 'translatedFrom'` after `'rotatedFrom', 'mirroredFrom',`.
  - `cleanup/context.ts` `copyPoints`:
    ```ts
    /** Points that are copies: of Repeat / Mirror / Linear (rotatedFrom /
     *  mirroredFrom / translatedFrom's first ref) and offset points (offsetLine's
     *  third ref, offsetRadius' second pair's point) — Clean up detects on
     *  sources only and never ties a copy to its source (pen stage 8). */
    export function copyPoints(doc: SketchDoc): Set<EntityId> {
      const out = new Set<EntityId>()
      for (const c of doc.constraints) {
        if (c.kind === 'rotatedFrom' || c.kind === 'mirroredFrom' || c.kind === 'translatedFrom') out.add(c.refs[0]!)
        else if (c.kind === 'offsetLine') out.add(c.refs[2]!)
        else if (c.kind === 'offsetRadius' && c.refs.length === 4) out.add(c.refs[3]!)
      }
      return out
    }
    ```
- [ ] **Step 7: Badges** — in `frontend/app/components/pen/PenOverlay.vue`: `const STRUCTURAL_MARK_KINDS: ConstraintKind[] = ['rotatedFrom', 'mirroredFrom', 'equalDist', 'translatedFrom', 'offsetLine', 'offsetRadius']`, and add "Linear copies and offsets (pen stage 8)" to the comment above it.

- [ ] **Step 8: Run the tests** (this task's, and the suites of every file touched)

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-stage8-consumers.unit.spec.ts tests/unit/sketch-trim.unit.spec.ts tests/unit/sketch-trim-tangent.unit.spec.ts tests/unit/sketch-merge.unit.spec.ts tests/unit/sketch-edit.unit.spec.ts tests/unit/sketch-clipboard.unit.spec.ts tests/unit/pen-cleanup.unit.spec.ts tests/unit/pen-rule-check.unit.spec.ts tests/unit/pen-overlay-cues.unit.spec.ts tests/unit/sketch-fills-edits.unit.spec.ts tests/unit/pen-copy-paste.unit.spec.ts`
Expected: PASS. If `Clean up proposes nothing …` fails because Clean up suggests a fix between the copy and the source, the copy-point set is not reaching that detector: follow `ctx.copies` in `cleanup/detect-*.ts` and skip a pair when both are copies or one is the other's copy — do not loosen the test. Typecheck the touched files: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(trim|edit|clipboard)\.ts|cleanup/(guards|context)\.ts|PenOverlay\.vue'` prints nothing new.

- [ ] **Step 9: Commit**

```bash
git add frontend/app/lib/sketch/trim.ts frontend/app/lib/sketch/edit.ts frontend/app/lib/sketch/clipboard.ts frontend/app/lib/sketch/cleanup/guards.ts frontend/app/lib/sketch/cleanup/context.ts frontend/app/components/pen/PenOverlay.vue frontend/tests/unit/sketch-stage8-consumers.unit.spec.ts
git commit -m "feat(pen): trim, delete, Mirror, Paste, Clean up and rule checks follow the offset and linear-copy rules (stage 8)"
```

---
### Task 3: Corners — which points are corners, the fillet and chamfer geometry, the construction, the preview (pure)

**Files:**
- Create: `frontend/tests/unit/__fixtures__/penStage8.ts`
- Modify: `frontend/app/lib/sketch/fills.ts` (add `cornerSeeds`)
- Create: `frontend/app/lib/sketch/corners.ts`
- Test: `frontend/tests/unit/sketch-corners.unit.spec.ts`

**Behaviour (Rulings 3–8, 17):** as the rulings say. `cornersOf(doc)` is one pass over the drawing (a map of every point to the pieces ending there), so the pen can cache it per revision. `cornerGeom` returns the touch points (`t1` on side a, `t2` on side b), the fillet centre / radius / sweep, how far along each side the touch lies (`fa`, `fb`: 0 at the corner, 1 at the side's far end) and whether it `fits` (0 < fa < 1 and 0 < fb < 1). `roundCorners` builds corners one after another on the drawing it is given (callers pass a clone), carrying fill seeds with `splitSeeds` + `cornerSeeds`, and returns the ids of the rules it added (the pen checks only those before deciding to solve). `cornerPreview` builds on a fill-less clone and returns the new and shortened pieces' outline plus, for every corner that can't be built, a red outline (or a ring when there is no geometry at all).

**Interfaces:**
- Consumes: `splitSeeds` (`fills.ts`); `addPoint`, `addConstraint`, `addPath` (`edit.ts`); `entityPath` (`sketchPath.ts`); `cloneDoc`.
- Produces (`corners.ts`):
  ```ts
  export type CornerKind = 'round' | 'chamfer'
  export interface CornerSide { host: 'seg' | 'line'; id: EntityId; segIndex: number; far: EntityId; xIsStart: boolean; kind: 'line' | 'arc'; center?: EntityId; sweep?: 0 | 1 }
  export interface Corner { x: EntityId; a: CornerSide; b: CornerSide; spliced: boolean }
  export type CornerCheck = { ok: true; corner: Corner } | { ok: false; why: 'notCorner' | 'curve' | 'smooth' }
  export interface CornerGeom { t1: Vec2; t2: Vec2; c?: Vec2; r?: number; sweep?: 0 | 1; fa: number; fb: number; fits: boolean }
  export interface CornerBuild { ok: boolean; bad: EntityId[]; rules: EntityId[]; created: EntityId[] }
  export interface CornerPreview { d: string; fits: boolean; bad: { at: Vec2; d: string }[] }
  export function cornerCheck(doc: SketchDoc, x: EntityId): CornerCheck
  export function cornersOf(doc: SketchDoc): Map<EntityId, Corner>
  export function cornerAt(doc: SketchDoc, p: Vec2, tol: number, corners?: Map<EntityId, Corner>): EntityId | null
  export function cornerGeom(doc: SketchDoc, corner: Corner, kind: CornerKind, size: number): CornerGeom | null
  export function sizeFromPointer(doc: SketchDoc, corner: Corner, kind: CornerKind, p: Vec2): number
  export function roundCorners(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, size: number): CornerBuild
  export function cornerPreview(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, size: number): CornerPreview
  export function fittingSize(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, want: number): number
  ```
- Produces (`fills.ts`): `export function cornerSeeds(doc: SketchDoc, x: EntityId, t1: EntityId, t2: EntityId, cut?: { c?: EntityId; ccw?: boolean }): void`
- Produces (fixtures): `gear(n?: number): { doc: SketchDoc; path: EntityId; anchors: EntityId[] }`, `rectGrid(count?: number): { doc: SketchDoc; paths: EntityId[] }`, `squarePath(doc: SketchDoc, x0: number, y0: number, s: number): { path: EntityId; pts: EntityId[] }`

- [ ] **Step 1: The shared speed fixtures** — create `frontend/tests/unit/__fixtures__/penStage8.ts`:

```ts
// tests/unit/__fixtures__/penStage8.ts
// Pen stage 8's speed fixtures (Global Constraints): ONE connected drawing
// and a symmetric grid — never scattered shapes.
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'

/** A closed path of `n` straight pieces round a centre, its anchors at
 *  radii 10 and 8 in turn — one connected drawing whose every anchor is a corner. */
export function gear(n = 150): { doc: SketchDoc; path: EntityId; anchors: EntityId[] } {
  const doc: SketchDoc = { entities: [], constraints: [] }
  const anchors: EntityId[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, r = i % 2 ? 8 : 10
    anchors.push(addPoint(doc, r * Math.cos(a), r * Math.sin(a)))
  }
  const path = addPath(doc, anchors, anchors.map(() => ({ kind: 'line' as const })), true)
  return { doc, path, anchors }
}

/** A closed counter-clockwise square path (x0, y0)–(x0 + s, y0 + s). */
export function squarePath(doc: SketchDoc, x0: number, y0: number, s: number): { path: EntityId; pts: EntityId[] } {
  const pts = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]].map(([x, y]) => addPoint(doc, x!, y!))
  return { path: addPath(doc, pts, pts.map(() => ({ kind: 'line' as const })), true), pts }
}

/** `count` separate closed rectangles (1 × 0.6), 2 apart in rows of 7. */
export function rectGrid(count = 37): { doc: SketchDoc; paths: EntityId[] } {
  const doc: SketchDoc = { entities: [], constraints: [] }
  const paths: EntityId[] = []
  for (let i = 0; i < count; i++) {
    const x0 = (i % 7) * 2, y0 = Math.floor(i / 7) * 2
    const pts = [[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 0.6], [x0, y0 + 0.6]].map(([x, y]) => addPoint(doc, x!, y!))
    paths.push(addPath(doc, pts, pts.map(() => ({ kind: 'line' as const })), true))
  }
  return { doc, paths }
}
```

- [ ] **Step 2: Write the failing test** — create `frontend/tests/unit/sketch-corners.unit.spec.ts`:

```ts
// tests/unit/sketch-corners.unit.spec.ts
// Pen stage 8: Round corner and Chamfer, pure — which points are corners
// (spliced into one path, or two separate pieces), the fillet (line–line,
// line–arc, arc–arc) and the chamfer, too big, the virtual sharp keeping
// rules on the corner, several corners tied Equal, fills carried, the
// preview, and speed on one connected drawing and a symmetric grid.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, PathEntity } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'
import { toggleFillAt, fillState } from '~/lib/sketch/fills'
import { cornerCheck, cornersOf, cornerAt, cornerGeom, sizeFromPointer, roundCorners, cornerPreview, fittingSize } from '~/lib/sketch/corners'
import { gear, rectGrid, squarePath } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const allHold = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-7)
const pathOf = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as PathEntity

describe('which points are corners', () => {
  it('every anchor of a closed square is a spliced corner; its sides run into and out of it', () => {
    const d = doc(); const { path, pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.corner.spliced).toBe(true)
    expect(c.corner.a).toMatchObject({ host: 'seg', id: path, segIndex: 3, far: pts[3], xIsStart: false, kind: 'line' })
    expect(c.corner.b).toMatchObject({ host: 'seg', id: path, segIndex: 0, far: pts[1], xIsStart: true, kind: 'line' })
    expect(cornersOf(d).size).toBe(4)
  })
  it('two line entities sharing an end make a corner that is not spliced', () => {
    const d = doc()
    const a = addPoint(d, 0, 4), x = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    addLine(d, a, x); addLine(d, x, b)
    const c = cornerCheck(d, x)
    expect(c.ok && !c.corner.spliced).toBe(true)
  })
  it('refuses: an open end, a T-junction, a centre, a Bézier side, a straight run, a guide', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 8, 0), t = addPoint(d, 4, 4)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    addLine(d, b, t)
    expect(cornerCheck(d, a)).toEqual({ ok: false, why: 'notCorner' })   // an open end
    expect(cornerCheck(d, b)).toEqual({ ok: false, why: 'notCorner' })   // three pieces
    const d2 = doc()
    const p = addPoint(d2, 0, 0), q = addPoint(d2, 4, 0), r = addPoint(d2, 8, 0), h = addPoint(d2, 6, 2)
    addPath(d2, [p, q, r], [{ kind: 'line' }, { kind: 'cubic', h1: h, h2: null }])
    expect(cornerCheck(d2, q)).toEqual({ ok: false, why: 'curve' })
    const d3 = doc()
    const u = addPoint(d3, 0, 0), v = addPoint(d3, 4, 0), w = addPoint(d3, 8, 0)
    addPath(d3, [u, v, w], [{ kind: 'line' }, { kind: 'line' }])
    expect(cornerCheck(d3, v)).toEqual({ ok: false, why: 'smooth' })
    const d4 = doc()
    const g1 = addPoint(d4, 0, 4), gx = addPoint(d4, 0, 0), g2 = addPoint(d4, 4, 0)
    addLine(d4, g1, gx, { construction: true }); addLine(d4, gx, g2, { construction: true })
    expect(cornerCheck(d4, gx).ok).toBe(false)
  })
  it('cornerAt finds the nearest corner within the tolerance', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    expect(cornerAt(d, { x: 4.1, y: 3.9 }, 0.3)).toBe(pts[2])
    expect(cornerAt(d, { x: 2, y: 2 }, 0.3)).toBeNull()
  })
})

describe('geometry', () => {
  it('a right-angle line corner: touch points r back, centre on the bisector', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!); if (!c.ok) throw new Error()
    const g = cornerGeom(d, c.corner, 'round', 1)!
    expect(g.fits).toBe(true)
    expect(g.t1.x).toBeCloseTo(0, 9); expect(g.t1.y).toBeCloseTo(1, 9)   // on the side from (0,4)
    expect(g.t2.x).toBeCloseTo(1, 9); expect(g.t2.y).toBeCloseTo(0, 9)   // on the side to (4,0)
    expect(g.c!.x).toBeCloseTo(1, 9); expect(g.c!.y).toBeCloseTo(1, 9)
    expect(g.fa).toBeCloseTo(0.25, 9); expect(g.fb).toBeCloseTo(0.25, 9)
  })
  it('a chamfer: equal straight setbacks', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[1]!); if (!c.ok) throw new Error()
    const g = cornerGeom(d, c.corner, 'chamfer', 1.5)!
    expect(Math.hypot(g.t1.x - 4, g.t1.y)).toBeCloseTo(1.5, 9)
    expect(Math.hypot(g.t2.x - 4, g.t2.y)).toBeCloseTo(1.5, 9)
  })
  it('a line into an arc: the fillet touches both, inside the turn', () => {
    const d = doc()
    const a = addPoint(d, -4, 0), x = addPoint(d, 0, 0), e = addPoint(d, 3, 3), ca = addPoint(d, 3, 0)
    addPath(d, [a, x, e], [{ kind: 'line' }, { kind: 'arc', center: ca, sweep: 0 }])
    const c = cornerCheck(d, x); if (!c.ok) throw new Error(JSON.stringify(c))
    const g = cornerGeom(d, c.corner, 'round', 0.5)!
    expect(g.fits).toBe(true)
    // the corner turns from "left along the line" to "up along the arc": the
    // fillet sits up and to the left, touching the arc's circle from outside
    expect(g.c!.x).toBeLessThan(0); expect(g.c!.y).toBeGreaterThan(0)
    expect(Math.abs(g.c!.y - g.t1.y)).toBeCloseTo(0.5, 6)                              // r from the line
    expect(Math.hypot(g.c!.x - 3, g.c!.y)).toBeCloseTo(3 + 0.5, 6)
    expect(Math.hypot(g.t2.x - 3, g.t2.y)).toBeCloseTo(3, 6)
    expect(Math.hypot(g.t2.x - g.c!.x, g.t2.y - g.c!.y)).toBeCloseTo(0.5, 6)
  })
  it('two arcs (a lens’ tip): the fillet sits inside, touching both circles from inside', () => {
    const d = doc()
    const L = addPoint(d, -3, 0), R = addPoint(d, 3, 0), cu = addPoint(d, 0, -3), cl = addPoint(d, 0, 3)
    addPath(d, [L, R], [{ kind: 'arc', center: cu, sweep: 0 }, { kind: 'arc', center: cl, sweep: 0 }], true)
    const c = cornerCheck(d, R); if (!c.ok) throw new Error(JSON.stringify(c))
    expect(c.corner.spliced).toBe(true)
    const g = cornerGeom(d, c.corner, 'round', 0.3)!
    expect(g.fits).toBe(true)
    const R0 = Math.hypot(3, 3)
    expect(Math.hypot(g.c!.x, g.c!.y + 3)).toBeCloseTo(R0 - 0.3, 6)
    expect(Math.hypot(g.c!.x, g.c!.y - 3)).toBeCloseTo(R0 - 0.3, 6)
    expect(g.c!.x).toBeLessThan(3); expect(Math.abs(g.c!.y)).toBeLessThan(1e-6)
    const work = cloneDoc(d)
    expect(roundCorners(work, [R], 'round', 0.3).ok).toBe(true)
    expect(allHold(work)).toBe(true)
  })
  it('too big: a radius longer than a side does not fit; fittingSize halves until it does', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!); if (!c.ok) throw new Error()
    expect(cornerGeom(d, c.corner, 'round', 5)!.fits).toBe(false)
    expect(fittingSize(d, [pts[0]!], 'round', 20)).toBeCloseTo(2.5, 9)
  })
  it('the size follows the pointer along the bisector', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!); if (!c.ok) throw new Error()
    // the arc's middle for r = 1 sits at (1 − √½, 1 − √½)
    const m = 1 - Math.SQRT1_2
    expect(sizeFromPointer(d, c.corner, 'round', { x: m, y: m })).toBeCloseTo(1, 9)
    expect(sizeFromPointer(d, c.corner, 'chamfer', { x: 0.75, y: 0.75 })).toBeCloseTo(1.5, 9)
    expect(sizeFromPointer(d, c.corner, 'round', { x: -1, y: -1 })).toBe(0)
  })
})

describe('construction', () => {
  it('rounds a square’s corner into its path: one more piece, an arc, every rule holding', () => {
    const d = doc(); const { path, pts } = squarePath(d, 0, 0, 4)
    const r = roundCorners(d, [pts[0]!], 'round', 1)
    expect(r.ok).toBe(true)
    const p = pathOf(d, path)
    expect(p.anchors).toHaveLength(5)
    expect(p.segments.filter(s => s.kind === 'arc')).toHaveLength(1)
    expect(P(d, pts[0]!).construction).toBe(true)             // the virtual sharp
    expect(p.anchors.includes(pts[0]!)).toBe(false)
    expect(allHold(d)).toBe(true)
    expect(r.rules.length).toBeGreaterThanOrEqual(5)
  })
  it('a rule on the corner still holds after rounding, and a drag keeps the arc tangent', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    addConstraint(d, 'perpendicular', [pts[3]!, pts[0]!, pts[0]!, pts[1]!])   // a right angle at the corner
    roundCorners(d, [pts[0]!], 'round', 1)
    expect(allHold(d)).toBe(true)
    expect(solve(d, { drag: { point: pts[1]!, x: 5, y: 0.5 } }).converged).toBe(true)
    expect(allHold(d)).toBe(true)
  })
  it('two separate lines: their ends move to the touch points and the arc is its own piece', () => {
    const d = doc()
    const a = addPoint(d, 0, 4), x = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    const l1 = addLine(d, a, x), l2 = addLine(d, x, b)
    const r = roundCorners(d, [x], 'chamfer', 1)
    expect(r.ok).toBe(true)
    expect([P(d, l1).p1, P(d, l1).p2]).not.toContain(x)
    expect([P(d, l2).p1, P(d, l2).p2]).not.toContain(x)
    expect(d.entities.filter(e => e.kind === 'path')).toHaveLength(1)
    expect(allHold(d)).toBe(true)
  })
  it('several corners get one size, tied Equal to the first', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const r = roundCorners(d, pts, 'round', 1)
    expect(r.ok).toBe(true)
    const equals = d.constraints.filter(c => c.kind === 'equalDist' && c.refs[0] !== c.refs[2])
    expect(equals).toHaveLength(3)
    expect(allHold(d)).toBe(true)
  })
  it('refuses the whole set when one corner is too big, and says which', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const r = roundCorners(d, [pts[0]!, pts[1]!], 'round', 2.5)   // 2.5 + 2.5 > 4 on the shared side
    expect(r.ok).toBe(false)
    expect(r.bad).toEqual([pts[1]])
  })
  it('a filled square stays filled when one corner, then every corner, is rounded', () => {
    const d = doc(); squarePath(d, 0, 0, 4)
    expect(toggleFillAt(d, { x: 2, y: 2 }, 0)).toBe(true)
    const one = cloneDoc(d)
    const c0 = [...cornersOf(one).keys()][0]!
    roundCorners(one, [c0], 'round', 1)
    expect(fillState(one).filled).toHaveLength(1)
    const all = cloneDoc(d)
    roundCorners(all, [...cornersOf(all).keys()], 'chamfer', 1)
    const st = fillState(all)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(16 - 4 * 0.5, 6)
  })
})

describe('preview', () => {
  it('draws the new pieces, changes nothing, and goes red with the too-big corners', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const before = JSON.stringify(d)
    const ok = cornerPreview(d, [pts[0]!], 'round', 1)
    expect(ok.fits).toBe(true)
    expect(ok.d).toMatch(/ A 1 1 /)
    expect(JSON.stringify(d)).toBe(before)
    const bad = cornerPreview(d, [pts[0]!], 'round', 9)
    expect(bad.fits).toBe(false)
    expect(bad.bad).toHaveLength(1)
    expect(bad.bad[0]!.d).not.toBe('')
  })
})

describe('speed (one connected drawing, a symmetric grid)', () => {
  it('a preview frame stays well inside 16 ms', () => {
    const { doc: g, anchors } = gear(150)
    const map = cornersOf(g)
    expect(map.size).toBe(150)
    cornerPreview(g, [anchors[0]!], 'round', 0.1)   // warm up
    let t = performance.now()
    for (let i = 0; i < 10; i++) cornerPreview(g, [anchors[0]!], 'round', 0.1 + i * 0.01)
    expect((performance.now() - t) / 10).toBeLessThan(16)
    t = performance.now()
    const every = cornerPreview(g, anchors, 'round', 0.05)
    expect(performance.now() - t).toBeLessThan(16 * 4)          // all 150 corners at once: a rare, one-off frame
    expect(every.fits).toBe(true)
    t = performance.now(); for (let i = 0; i < 20; i++) cornersOf(g); expect((performance.now() - t) / 20).toBeLessThan(4)

    const { doc: grid } = rectGrid(37)
    const gm = cornersOf(grid)
    expect(gm.size).toBe(148)
    const some = [...gm.keys()].filter((_, i) => i % 4 === 0)
    t = performance.now()
    for (let i = 0; i < 10; i++) cornerPreview(grid, some, 'chamfer', 0.1)
    expect((performance.now() - t) / 10).toBeLessThan(16)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-corners.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/corners"`.

- [ ] **Step 4: `cornerSeeds`** — in `frontend/app/lib/sketch/fills.ts`, after `renameSeedPoints`:

```ts
/** Round corner / Chamfer (pen stage 8): corner `x`, whose sides were split
 *  (splitSeeds) at t1 (the side running into the corner) and t2 (the side
 *  running out), is cut off by a new piece t1 → t2 — an arc about `c` turning
 *  counter-clockwise when `ccw`, or a straight cut. Seeds on the cut-off
 *  stretches t1–x and x–t2 move onto the new piece halfway along, on the same
 *  side (the way of travel runs on through the corner). */
export function cornerSeeds(doc: SketchDoc, x: EntityId, t1: EntityId, t2: EntityId, cut: { c?: EntityId; ccw?: boolean } = {}): void {
  for (const f of doc.fills ?? []) {
    const s = f.seed
    if (s.kind === 'circle') continue
    const first = (s.a === t1 && s.b === x) || (s.a === x && s.b === t1)
    const second = (s.a === x && s.b === t2) || (s.a === t2 && s.b === x)
    if (!first && !second) continue
    // towards the corner on the first stretch, or away from it on the second, is the new piece's own way
    const along = first ? s.a === t1 : s.a === x
    const a = along ? t1 : t2, b = along ? t2 : t1
    f.seed = cut.c
      ? { kind: 'arc', a, b, c: cut.c, ccw: along ? !!cut.ccw : !cut.ccw, t: 0.5, side: s.side }
      : { kind: 'line', a, b, t: 0.5, side: s.side }
  }
}
```

- [ ] **Step 5: `corners.ts`** — create `frontend/app/lib/sketch/corners.ts`:

```ts
// app/lib/sketch/corners.ts
// Pen stage 8, Round corner and Chamfer (spec "Stage 8"). A corner is a point
// where exactly two drawn pieces end (Ruling 3). Rounding makes a tangent arc
// between two touch points on its sides, chamfering a straight cut at equal
// setbacks; the corner point stays as a guide — the "virtual sharp" — tied to
// both sides, so every rule that named it still holds (Ruling 4). Everything
// is made of ordinary points, pieces and rules. Pure.
import type { SketchDoc, EntityId, PathEntity, SegmentSpec } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { addPoint, addConstraint, addPath } from './edit'
import { splitSeeds, cornerSeeds } from './fills'
import { entityPath } from './sketchPath'
import { cloneDoc } from './clone'

const TAU = Math.PI * 2
const EPS = 1e-9
/** two leaving directions this close to opposite: the corner is already smooth (Ruling 3) */
const SMOOTH_COS = Math.cos((0.5 * Math.PI) / 180)

export type CornerKind = 'round' | 'chamfer'
/** One side of a corner: the piece ending at the corner point, as stored. */
export interface CornerSide {
  host: 'seg' | 'line'
  id: EntityId            // the path's id (host 'seg') or the line's
  segIndex: number        // host 'seg'; −1 for a line
  far: EntityId           // the piece's other end
  xIsStart: boolean       // stored running from the corner (x → far)
  kind: 'line' | 'arc'
  center?: EntityId       // arc
  sweep?: 0 | 1           // arc, as stored (1 = counter-clockwise)
}
/** `a` runs into the corner, `b` out of it (for a spliced corner, in path order). */
export interface Corner { x: EntityId; a: CornerSide; b: CornerSide; spliced: boolean }
export type CornerCheck = { ok: true; corner: Corner } | { ok: false; why: 'notCorner' | 'curve' | 'smooth' }
export interface CornerGeom { t1: Vec2; t2: Vec2; c?: Vec2; r?: number; sweep?: 0 | 1; fa: number; fb: number; fits: boolean }
export interface CornerBuild { ok: boolean; bad: EntityId[]; rules: EntityId[]; created: EntityId[] }
export interface CornerPreview { d: string; fits: boolean; bad: { at: Vec2; d: string }[] }

const NOT: CornerCheck = { ok: false, why: 'notCorner' }

// ── which points are corners ────────────────────────────────────────────────

interface Uses { sides: CornerSide[]; cubic: number; blocked: boolean }

// every point's pieces, in one pass (guides left out)
function usesOf(doc: SketchDoc, only?: EntityId): Map<EntityId, Uses> {
  const out = new Map<EntityId, Uses>()
  const at = (id: EntityId): Uses | null => {
    if (only && id !== only) return null
    let u = out.get(id)
    if (!u) out.set(id, (u = { sides: [], cubic: 0, blocked: false }))
    return u
  }
  for (const e of doc.entities) {
    if (e.kind === 'point' || e.construction) continue
    if (e.kind === 'circle') { const u = at(e.center); if (u) u.blocked = true; continue }
    if (e.kind === 'line') {
      if (e.p1 === e.p2) continue
      at(e.p1)?.sides.push({ host: 'line', id: e.id, segIndex: -1, far: e.p2, xIsStart: true, kind: 'line' })
      at(e.p2)?.sides.push({ host: 'line', id: e.id, segIndex: -1, far: e.p1, xIsStart: false, kind: 'line' })
      continue
    }
    const n = e.anchors.length, count = e.closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      const s = e.segments[i]!, a = e.anchors[i]!, b = e.anchors[(i + 1) % n]!
      if (s.kind === 'arc') { const u = at(s.center); if (u) u.blocked = true }
      if (s.kind === 'cubic') {
        for (const h of [s.h1, s.h2]) if (h) { const u = at(h); if (u) u.blocked = true }
        if (a !== b) { const ua = at(a); if (ua) ua.cubic++; const ub = at(b); if (ub) ub.cubic++ }
        continue
      }
      if (a === b) continue
      const base = { host: 'seg' as const, id: e.id, segIndex: i, kind: s.kind, ...(s.kind === 'arc' ? { center: s.center, sweep: s.sweep } : {}) }
      at(a)?.sides.push({ ...base, far: b, xIsStart: true })
      at(b)?.sides.push({ ...base, far: a, xIsStart: false })
    }
  }
  return out
}

function checkUses(doc: SketchDoc, x: EntityId, u: Uses | undefined): CornerCheck {
  const X = getPoint(doc, x)
  if (!X || !u || u.blocked || u.sides.length + u.cubic !== 2) return NOT
  if (u.cubic) return { ok: false, why: 'curve' }
  let [a, b] = u.sides as [CornerSide, CornerSide]
  let spliced = false
  if (a.host === 'seg' && b.host === 'seg' && a.id === b.id) {
    const p = getEntity(doc, a.id) as PathEntity
    const count = p.closed ? p.anchors.length : p.anchors.length - 1
    const follows = (s: CornerSide, t: CornerSide) => !s.xIsStart && t.xIsStart && (s.segIndex + 1) % count === t.segIndex
    if (follows(b, a)) [a, b] = [b, a]
    spliced = follows(a, b)
  }
  const ga = sideGeom(doc, a, X), gb = sideGeom(doc, b, X)
  if (!ga || !gb) return NOT
  const cos = ga.u.x * gb.u.x + ga.u.y * gb.u.y
  if (cos < -SMOOTH_COS) return { ok: false, why: 'smooth' }
  if (cos > SMOOTH_COS) return NOT   // folded back on itself
  return { ok: true, corner: { x, a, b, spliced } }
}

export function cornerCheck(doc: SketchDoc, x: EntityId): CornerCheck {
  return checkUses(doc, x, usesOf(doc, x).get(x))
}

/** Every corner of the drawing, by its point (one pass; cache it per revision). */
export function cornersOf(doc: SketchDoc): Map<EntityId, Corner> {
  const out = new Map<EntityId, Corner>()
  for (const [id, u] of usesOf(doc)) {
    if (u.sides.length + u.cubic !== 2) continue
    const c = checkUses(doc, id, u)
    if (c.ok) out.set(id, c.corner)
  }
  return out
}

/** The corner nearest `p` within `tol` (drawing units), or null. */
export function cornerAt(doc: SketchDoc, p: Vec2, tol: number, corners: Map<EntityId, Corner> = cornersOf(doc)): EntityId | null {
  let best: EntityId | null = null, bd = tol
  for (const id of corners.keys()) {
    const q = getPoint(doc, id)
    if (!q) continue
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= bd) { bd = d; best = id }
  }
  return best
}

// ── a side's geometry, seen from the corner ────────────────────────────────

type SideGeom =
  | { kind: 'line'; X: Vec2; u: Vec2; len: number }
  | { kind: 'arc'; X: Vec2; u: Vec2; c: Vec2; r: number; dir: 1 | -1; span: number }

const norm = (a: number) => ((a % TAU) + TAU) % TAU

function sideGeom(doc: SketchDoc, s: CornerSide, X: Vec2): SideGeom | null {
  const F = getPoint(doc, s.far)
  if (!F) return null
  if (s.kind === 'line') {
    const len = Math.hypot(F.x - X.x, F.y - X.y)
    if (len < EPS) return null
    return { kind: 'line', X, u: { x: (F.x - X.x) / len, y: (F.y - X.y) / len }, len }
  }
  const C = getPoint(doc, s.center!)
  if (!C) return null
  const r = Math.hypot(X.x - C.x, X.y - C.y)
  if (r < EPS) return null
  // stored s → e with sweep 1 = counter-clockwise; travelled from the corner
  const stored: 1 | -1 = s.sweep === 1 ? 1 : -1
  const dir: 1 | -1 = s.xIsStart ? stored : (-stored as 1 | -1)
  const angX = Math.atan2(X.y - C.y, X.x - C.x), angF = Math.atan2(F.y - C.y, F.x - C.x)
  const span = norm(dir * (angF - angX)) || TAU
  const u = { x: (-dir * (X.y - C.y)) / r, y: (dir * (X.x - C.x)) / r }
  return { kind: 'arc', X, u, c: { x: C.x, y: C.y }, r, dir, span }
}

// how far along a side (0 at the corner, 1 at its far end) point T lies
function fraction(g: SideGeom, T: Vec2): number {
  if (g.kind === 'line') return ((T.x - g.X.x) * g.u.x + (T.y - g.X.y) * g.u.y) / g.len
  const a0 = Math.atan2(g.X.y - g.c.y, g.X.x - g.c.x), a = Math.atan2(T.y - g.c.y, T.x - g.c.x)
  let t = norm(g.dir * (a - a0))
  if (t > TAU - 1e-9) t = 0
  return t / g.span
}

// ── round: the tangent circle inside the corner ─────────────────────────────

type Carrier = { kind: 'line'; p: Vec2; u: Vec2 } | { kind: 'circle'; c: Vec2; r: number }

function offsetCarriers(g: SideGeom, r: number): Carrier[] {
  if (g.kind === 'line') {
    const n = { x: -g.u.y, y: g.u.x }
    return [
      { kind: 'line', p: { x: g.X.x + r * n.x, y: g.X.y + r * n.y }, u: g.u },
      { kind: 'line', p: { x: g.X.x - r * n.x, y: g.X.y - r * n.y }, u: g.u },
    ]
  }
  const out: Carrier[] = [{ kind: 'circle', c: g.c, r: g.r + r }]
  if (g.r - r > EPS) out.push({ kind: 'circle', c: g.c, r: g.r - r })
  if (r - g.r > EPS) out.push({ kind: 'circle', c: g.c, r: r - g.r })
  return out
}

/** Where two carriers cross (a tangent touch counts once). */
export function intersectCarriers(a: Carrier, b: Carrier): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const den = a.u.x * b.u.y - a.u.y * b.u.x
    if (Math.abs(den) < 1e-12) return []
    const t = ((b.p.x - a.p.x) * b.u.y - (b.p.y - a.p.y) * b.u.x) / den
    return [{ x: a.p.x + t * a.u.x, y: a.p.y + t * a.u.y }]
  }
  if (a.kind === 'circle' && b.kind === 'line') return intersectCarriers(b, a)
  if (a.kind === 'line' && b.kind === 'circle') {
    const fx = a.p.x - b.c.x, fy = a.p.y - b.c.y
    const B = fx * a.u.x + fy * a.u.y, C = fx * fx + fy * fy - b.r * b.r
    const disc = B * B - C
    if (disc < -1e-12) return []
    const s = Math.sqrt(Math.max(0, disc))
    const ts = s < 1e-12 ? [-B] : [-B - s, -B + s]
    return ts.map(t => ({ x: a.p.x + t * a.u.x, y: a.p.y + t * a.u.y }))
  }
  const A = a as Extract<Carrier, { kind: 'circle' }>, Bc = b as Extract<Carrier, { kind: 'circle' }>
  const dx = Bc.c.x - A.c.x, dy = Bc.c.y - A.c.y, d = Math.hypot(dx, dy)
  if (d < EPS || d > A.r + Bc.r + 1e-12 || d < Math.abs(A.r - Bc.r) - 1e-12) return []
  const l = (A.r * A.r - Bc.r * Bc.r + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, A.r * A.r - l * l))
  const mx = A.c.x + (l * dx) / d, my = A.c.y + (l * dy) / d
  if (h < 1e-12) return [{ x: mx, y: my }]
  return [{ x: mx - (h * dy) / d, y: my + (h * dx) / d }, { x: mx + (h * dy) / d, y: my - (h * dx) / d }]
}

// the point of a side's carrier that a circle of radius r round C touches
function touch(g: SideGeom, C: Vec2, r: number): Vec2 {
  if (g.kind === 'line') {
    const t = (C.x - g.X.x) * g.u.x + (C.y - g.X.y) * g.u.y
    return { x: g.X.x + t * g.u.x, y: g.X.y + t * g.u.y }
  }
  const dx = C.x - g.c.x, dy = C.y - g.c.y, d = Math.hypot(dx, dy) || 1
  const near = { x: g.c.x + (g.r * dx) / d, y: g.c.y + (g.r * dy) / d }
  const far = { x: g.c.x - (g.r * dx) / d, y: g.c.y - (g.r * dy) / d }
  const err = (q: Vec2) => Math.abs(Math.hypot(q.x - C.x, q.y - C.y) - r)
  return err(near) <= err(far) ? near : far
}

const crossZ = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x

function roundGeom(ga: SideGeom, gb: SideGeom, X: Vec2, r: number): CornerGeom | null {
  if (!(r > EPS)) return null
  const sg = Math.sign(crossZ(ga.u, gb.u))
  let best: CornerGeom | null = null, bestD = Infinity
  for (const ca of offsetCarriers(ga, r)) {
    for (const cb of offsetCarriers(gb, r)) {
      for (const C of intersectCarriers(ca, cb)) {
        const w = { x: C.x - X.x, y: C.y - X.y }
        // inside the wedge of the two leaving directions
        if (Math.sign(crossZ(ga.u, w)) !== sg || Math.sign(crossZ(gb.u, w)) !== -sg) continue
        const t1 = touch(ga, C, r), t2 = touch(gb, C, r)
        const fa = fraction(ga, t1), fb = fraction(gb, t2)
        if (!(fa > EPS) || !(fb > EPS)) continue
        const dd = Math.hypot(t1.x - X.x, t1.y - X.y) + Math.hypot(t2.x - X.x, t2.y - X.y)
        if (dd >= bestD) continue
        bestD = dd
        const sweep: 0 | 1 = crossZ({ x: t1.x - C.x, y: t1.y - C.y }, { x: t2.x - C.x, y: t2.y - C.y }) > 0 ? 1 : 0
        best = { t1, t2, c: C, r, sweep, fa, fb, fits: fa < 1 - EPS && fb < 1 - EPS }
      }
    }
  }
  return best
}

// ── chamfer: equal straight setbacks ────────────────────────────────────────

function setbackPoint(g: SideGeom, s: number): Vec2 | null {
  if (g.kind === 'line') return { x: g.X.x + s * g.u.x, y: g.X.y + s * g.u.y }
  const pts = intersectCarriers({ kind: 'circle', c: g.X, r: s }, { kind: 'circle', c: g.c, r: g.r })
  let best: Vec2 | null = null, bt = Infinity
  for (const q of pts) {
    const t = fraction(g, q)
    if (t > EPS && t < bt) { bt = t; best = q }
  }
  return best
}

function chamferGeom(ga: SideGeom, gb: SideGeom, s: number): CornerGeom | null {
  if (!(s > EPS)) return null
  const t1 = setbackPoint(ga, s), t2 = setbackPoint(gb, s)
  if (!t1 || !t2) return null
  const fa = fraction(ga, t1), fb = fraction(gb, t2)
  return { t1, t2, fa, fb, fits: fa > EPS && fa < 1 - EPS && fb > EPS && fb < 1 - EPS }
}

export function cornerGeom(doc: SketchDoc, corner: Corner, kind: CornerKind, size: number): CornerGeom | null {
  const X = getPoint(doc, corner.x)
  if (!X) return null
  const ga = sideGeom(doc, corner.a, X), gb = sideGeom(doc, corner.b, X)
  if (!ga || !gb) return null
  return kind === 'round' ? roundGeom(ga, gb, { x: X.x, y: X.y }, size) : chamferGeom(ga, gb, size)
}

/** The size that puts the arc's (or the cut's) middle at the pointer's
 *  projection on the corner's bisector (Ruling 8); 0 behind the corner. */
export function sizeFromPointer(doc: SketchDoc, corner: Corner, kind: CornerKind, p: Vec2): number {
  const X = getPoint(doc, corner.x)
  if (!X) return 0
  const ga = sideGeom(doc, corner.a, X), gb = sideGeom(doc, corner.b, X)
  if (!ga || !gb) return 0
  const wx = ga.u.x + gb.u.x, wy = ga.u.y + gb.u.y, wl = Math.hypot(wx, wy)
  if (wl < 1e-9) return 0
  const d = ((p.x - X.x) * wx + (p.y - X.y) * wy) / wl
  if (d <= 0) return 0
  const half = Math.acos(Math.max(-1, Math.min(1, ga.u.x * gb.u.x + ga.u.y * gb.u.y))) / 2
  const sh = Math.sin(half)
  return kind === 'round' ? (d * sh) / (1 - sh) : d / Math.cos(half)
}

// ── building a corner ───────────────────────────────────────────────────────

// the seeds on a side's piece, split where the touch point lands
function splitSide(doc: SketchDoc, s: CornerSide, x: EntityId, fromCorner: number, t: EntityId): void {
  splitSeeds(doc, s.far, x, s.kind === 'arc' ? s.center! : null, 1 - fromCorner, t)
}

// a separate piece's end at the corner moves to its touch point
function moveEnd(doc: SketchDoc, s: CornerSide, x: EntityId, t: EntityId): void {
  const e = getEntity(doc, s.id)
  if (!e) return
  if (e.kind === 'line') { if (e.p1 === x) e.p1 = t; else if (e.p2 === x) e.p2 = t; return }
  if (e.kind !== 'path') return
  const last = e.anchors.length - 1
  if (e.anchors[0] === x) e.anchors[0] = t
  else if (e.anchors[last] === x) e.anchors[last] = t
}

// an arc side's own rule equalDist [C, far, C, x] now names its new end
function reaimArcRule(doc: SketchDoc, s: CornerSide, x: EntityId, t: EntityId): void {
  if (s.kind !== 'arc') return
  const C = s.center!
  const k = doc.constraints.find(c => c.kind === 'equalDist' && c.refs[0] === C && c.refs[2] === C &&
    ((c.refs[1] === s.far && c.refs[3] === x) || (c.refs[1] === x && c.refs[3] === s.far)))
  if (k) k.refs = k.refs.map(r => (r === x ? t : r))
  else addConstraint(doc, 'equalDist', [C, s.far, C, t])
}

interface Built { x: EntityId; t1: EntityId; t2: EntityId; c: EntityId | null; touched: EntityId[]; rules: EntityId[]; created: EntityId[] }

function buildCorner(doc: SketchDoc, corner: Corner, g: CornerGeom, kind: CornerKind): Built {
  const X = corner.x
  const t1 = addPoint(doc, g.t1.x, g.t1.y), t2 = addPoint(doc, g.t2.x, g.t2.y)
  const c = kind === 'round' ? addPoint(doc, g.c!.x, g.c!.y) : null
  // fill seeds first, while they still name the pieces as they were
  splitSide(doc, corner.a, X, g.fa, t1)
  splitSide(doc, corner.b, X, g.fb, t2)
  cornerSeeds(doc, X, t1, t2, c ? { c, ccw: g.sweep === 1 } : {})
  const seg: SegmentSpec = c ? { kind: 'arc', center: c, sweep: g.sweep! } : { kind: 'line' }
  const rules: EntityId[] = []
  const touched = [corner.a.id, corner.b.id]
  const created = [t1, t2, ...(c ? [c] : [])]
  reaimArcRule(doc, corner.a, X, t1)
  reaimArcRule(doc, corner.b, X, t2)
  if (corner.spliced) {
    const p = getEntity(doc, corner.a.id) as PathEntity
    const j = p.anchors.indexOf(X)
    p.anchors.splice(j, 1, t1, t2)
    p.segments.splice(j, 0, seg)
    if (c) rules.push(addConstraint(doc, 'equalDist', [c, t1, c, t2]))
  } else {
    moveEnd(doc, corner.a, X, t1)
    moveEnd(doc, corner.b, X, t2)
    const before = doc.constraints.length
    const pid = addPath(doc, [t1, t2], [seg])
    touched.push(pid); created.push(pid)
    for (const k of doc.constraints.slice(before)) rules.push(k.id)
  }
  // the virtual sharp: a guide point tied back to both sides (Ruling 4)
  const xp = getPoint(doc, X)!
  xp.construction = true
  for (const [side, t] of [[corner.a, t1], [corner.b, t2]] as const) {
    if (side.kind === 'line') rules.push(addConstraint(doc, 'collinear', [side.far, t, X]))
    else rules.push(addConstraint(doc, 'equalDist', [side.center!, t, side.center!, X]))
    if (c) {
      if (side.kind === 'line') rules.push(addConstraint(doc, 'perpendicular', [side.far, t, t, c]))
      else rules.push(addConstraint(doc, 'collinear', [side.center!, t, c]))
    }
  }
  if (!c) rules.push(addConstraint(doc, 'equalDist', [X, t1, X, t2]))
  return { x: X, t1, t2, c, touched, rules, created }
}

/** Rounds (or chamfers) the corners `xs` with one size, in order, on `doc`
 *  itself — callers hand in a clone and keep it only when `ok`. Several
 *  corners are tied Equal to the first (Ruling 7). Not ok (and `bad` names
 *  them) when any corner isn't one or its size doesn't fit (Ruling 6). */
export function roundCorners(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, size: number): CornerBuild {
  const built: Built[] = []
  const bad: EntityId[] = []
  for (const x of [...new Set(xs)]) {
    const chk = cornerCheck(doc, x)
    const g = chk.ok ? cornerGeom(doc, chk.corner, kind, size) : null
    if (!chk.ok || !g || !g.fits) { bad.push(x); continue }
    built.push(buildCorner(doc, chk.corner, g, kind))
  }
  if (bad.length || !built.length) return { ok: false, bad, rules: [], created: [] }
  const rules = built.flatMap(b => b.rules)
  const first = built[0]!
  for (const b of built.slice(1)) {
    rules.push(kind === 'round'
      ? addConstraint(doc, 'equalDist', [first.c!, first.t1, b.c!, b.t1])
      : addConstraint(doc, 'equalDist', [first.x, first.t1, b.x, b.t1]))
  }
  return { ok: true, bad, rules, created: built.flatMap(b => b.created) }
}

// ── the preview ─────────────────────────────────────────────────────────────

function rawCornerD(g: CornerGeom): string {
  const f = (v: number) => Number(v.toFixed(6))
  if (g.c) return `M ${f(g.t1.x)} ${f(g.t1.y)} A ${f(g.r!)} ${f(g.r!)} 0 0 ${g.sweep} ${f(g.t2.x)} ${f(g.t2.y)}`
  return `M ${f(g.t1.x)} ${f(g.t1.y)} L ${f(g.t2.x)} ${f(g.t2.y)}`
}

/** What the corner tools show (Ruling 17): the new and shortened pieces as
 *  they would be, and every corner that can't be made (red: its circle or
 *  cut where it would fall, or '' for a ring). Builds on a fill-less clone;
 *  `doc` is never changed. */
export function cornerPreview(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, size: number): CornerPreview {
  const work = cloneDoc({ entities: doc.entities, constraints: doc.constraints })
  const touched = new Set<EntityId>()
  const bad: { at: Vec2; d: string }[] = []
  for (const x of [...new Set(xs)]) {
    const X = getPoint(work, x)
    const chk = cornerCheck(work, x)
    const g = chk.ok ? cornerGeom(work, chk.corner, kind, size) : null
    if (!chk.ok || !g || !g.fits) {
      if (X) bad.push({ at: { x: X.x, y: X.y }, d: g ? rawCornerD(g) : '' })
      continue
    }
    for (const id of buildCorner(work, chk.corner, g, kind).touched) touched.add(id)
  }
  const d = [...touched].map(id => entityPath(work, id)).filter(Boolean).join(' ')
  return { d, fits: bad.length === 0 && touched.size > 0, bad }
}

/** `want`, halved (up to 8 times) until every corner takes it (Ruling 8). */
export function fittingSize(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, want: number): number {
  let s = want
  for (let i = 0; i < 8; i++) {
    const work = cloneDoc({ entities: doc.entities, constraints: doc.constraints })
    if (roundCorners(work, xs, kind, s).ok) return s
    s /= 2
  }
  return want
}
```

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-corners.unit.spec.ts tests/unit/sketch-fills-edits.unit.spec.ts tests/unit/sketch-fills.unit.spec.ts`
Expected: PASS. Two things to check if a geometry test fails: `sideGeom`'s arc direction (a stored arc with `sweep: 0` runs clockwise from its start anchor — mirror `crossings.ts curveGeom`'s convention exactly), and the wedge test's signs (the centre must sit on the same side of side a's direction as side b, and vice versa). Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(corners|fills)\.ts|__fixtures__/penStage8'` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add frontend/tests/unit/__fixtures__/penStage8.ts frontend/app/lib/sketch/fills.ts frontend/app/lib/sketch/corners.ts frontend/tests/unit/sketch-corners.unit.spec.ts
git commit -m "feat(pen): round corners and chamfers — corners, tangent fillets, equal setbacks, virtual sharps, fills carried, preview (stage 8)"
```

---
### Task 4: The Round corner and Chamfer tools in the pen (F, H)

**Files:**
- Create: `frontend/app/composables/pen/penCorners.ts`
- Modify: `frontend/app/composables/pen/usePen.ts` (tool union, wiring, drops, keys, exports)
- Modify: `frontend/app/composables/pen/penKeys.ts` (F, H; the preview keys)
- Modify: `frontend/app/components/pen/PenOverlay.vue` (pointer routing, preview, rings, chip)
- Modify: `frontend/app/components/pen/PenToolbar.vue` (two buttons, two hints)
- Modify: `frontend/app/composables/pen/penTips.ts` (two cards)
- Modify: `frontend/app/composables/pen/penTipDemos.ts` (two demos)
- Modify: `frontend/app/pages/dev/sketch-draw.vue` (read-only `corner()` hook)
- Test: `frontend/tests/unit/pen-corners.unit.spec.ts`, `frontend/tests/unit/pen-tips.unit.spec.ts`

**Behaviour (Rulings 3–8, 17, 21; Global Constraints on previews, keys, speed):**
- F picks Round corner, H picks Chamfer (stage-2 rules; a host that doesn't list them ignores the keys). The selection's corners (points) start picked, with the preview at the default size.
- Hover over a corner rings it (`data-corner-hover`). A press on a corner and a drag past 3 px sets the size from the pointer; the release applies (or, too big, says "Too big for this corner" and keeps the preview). A click picks (Shift toggles one more) and waits for digits / Enter. Digits, `.` and Backspace edit the typed size (chip `R 1.5` / `1.5` measured, `1.5|` typed); Enter applies; Esc cancels ("Cancelled"). A press away from any corner says "Click a corner where two pieces meet".
- The preview is a `shallowRef` (`cornerView`) the overlay draws in drawing space — indigo when it fits, red dashed pieces / rings where it doesn't (`data-corner-preview[data-fits]`, `data-corner-bad`), picked corners ringed (`data-corner-picked`), a chip (`data-corner-chip`). Nothing touches `doc` until Apply; `onLiveChange` never fires for it.
- Apply: `roundCorners` on a raw clone; when ok the clone becomes the drawing, a solve runs only if one of the added rules doesn't hold, one `commitHistory()`, sparkles on the corners, status "Rounded" / "Chamfered". The size is remembered per kind for the next default.
- Dropped untouched by: a tool change, undo, redo, reset, revert, finishing the session, parking (`endGesture`), dispose, opening Clean up.
- The corner list is `cornersOf(toRaw(doc))`, cached by `docRevision` + raw doc identity; a hover is a lookup and a distance test.

**Interfaces:**
- Consumes (Task 3): `cornersOf`, `cornerAt`, `cornerPreview`, `roundCorners`, `sizeFromPointer`, `fittingSize`, `CornerKind`, `Corner`.
- Produces: `PenTool` gains `'round' | 'chamfer'`; `createPenCorners(ctx: PenCornersContext)` returning `{ view, hover, start, move, down, up, key, apply, cancel }`; `usePen` exports `cornerView: ShallowRef<CornerToolView | null>`, `cornerHover: ShallowRef<EntityId | null>`, `cornerMove(x, y)`, `cornerDown(x, y, additive)`, `cornerUp()`, `applyCorners(): boolean`, `cancelCorners(): void`; `PenKeyContext.previewKey: (ev: KeyboardEvent) => boolean`; exported constants `CORNER_TOO_BIG = 'Too big for this corner'`, `CORNER_MISS = 'Click a corner where two pieces meet'`.
  ```ts
  export interface CornerToolView {
    kind: CornerKind
    corners: EntityId[]        // picked corner points
    size: number               // radius or setback, drawing units
    typed: string              // digits typed ('' = none)
    d: string                  // the new pieces (drawing space)
    fits: boolean
    bad: { at: Vec2; d: string }[]
    chip: Vec2                 // the first corner (drawing space)
  }
  ```

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/pen-corners.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 8, the Round corner and Chamfer tools in the shared pen: F / H,
// the selection's corners start picked, drag to size and release to apply
// (one undo step), click + digits + Enter, too big refused, Esc and a tool
// change leave the drawing exactly as it was (and never reach onLiveChange),
// the overlay draws the preview, and the hover stays cheap on one big drawing.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc, PathEntity } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type PenTool } from '~/composables/pen/usePen'
import { CORNER_TOO_BIG, CORNER_MISS } from '~/composables/pen/penCorners'
import { gear, squarePath } from './__fixtures__/penStage8'

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

const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() {}, stopPropagation() {}, ...mods,
}) as unknown as KeyboardEvent
function setup(tools?: PenTool[]) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const sq = squarePath(doc.value, 1, 1, 4)
  let live = 0, changes = 0
  const pen = usePen({ doc, view: ref(DEV), options: tools ? { tools } : undefined, onLiveChange: () => { live++ }, onChange: () => { changes++ } })
  return { doc, pen, ...sq, live: () => live, changes: () => changes }
}
const json = (d: SketchDoc) => JSON.stringify(d)

describe('Round corner and Chamfer — keys and start', () => {
  it('F picks Round corner and H Chamfer; ⇧H is still Flip; a host without them ignores the keys', () => {
    const { pen } = setup()
    expect(pen.onKeydown(key('f'))).toBe(true); expect(pen.tool.value).toBe('round')
    expect(pen.onKeydown(key('h'))).toBe(true); expect(pen.tool.value).toBe('chamfer')
    expect(pen.onKeydown(key('H', { shiftKey: true }))).toBe(false)   // Flip needs a selection; never the tool
    expect(pen.tool.value).toBe('chamfer')
    const { pen: bare } = setup(['select', 'path'])
    expect(bare.onKeydown(key('f'))).toBe(false)
    expect(bare.onKeydown(key('h'))).toBe(false)
    expect(bare.tool.value).toBe('select')
  })
  it('the selection’s corners start picked, previewed at 12 px (0.35 units here)', () => {
    const { pen, pts, doc } = setup()
    pen.pick(pts[0]!); pen.pick(pts[2]!, true)
    const before = json(doc.value)
    pen.selectTool('round')
    const v = pen.cornerView.value!
    expect(v.corners).toEqual([pts[0], pts[2]])
    expect(v.size).toBeCloseTo(12 / 34, 9)
    expect(v.fits).toBe(true)
    expect(v.d).toMatch(/ A /)
    expect(json(doc.value)).toBe(before)
  })
})

describe('Round corner — the gesture', () => {
  it('press on a corner, drag, release: one undo step, nothing live before it', () => {
    const { pen, doc, pts, path, live } = setup()
    const before = json(doc.value)
    pen.selectTool('round')
    pen.cornerDown(1, 1, false)
    pen.cornerMove(1.2, 1.2); pen.cornerMove(1.3, 1.3)
    expect(pen.cornerView.value!.size).toBeGreaterThan(0.3)
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    pen.cornerUp()
    expect(pen.cornerView.value).toBeNull()
    const p = doc.value.entities.find(e => e.id === path) as PathEntity
    expect(p.segments.filter(s => s.kind === 'arc')).toHaveLength(1)
    expect(pen.status.value).toBe('Rounded')
    pen.undo()
    expect(json(doc.value)).toBe(before)
    pen.redo()
    expect((doc.value.entities.find(e => e.id === path) as PathEntity).anchors).toHaveLength(5)
    void pts
  })
  it('click, digits, Enter: the typed radius', () => {
    const { pen, doc } = setup()
    pen.selectTool('round')
    pen.cornerDown(5, 1, false); pen.cornerUp()
    for (const k of ['1', '.', '5']) expect(pen.onKeydown(key(k))).toBe(true)
    expect(pen.cornerView.value!.typed).toBe('1.5')
    expect(pen.cornerView.value!.size).toBe(1.5)
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    const arcs = doc.value.entities.filter(e => e.kind === 'path').flatMap(e => (e as PathEntity).segments.filter(s => s.kind === 'arc'))
    expect(arcs).toHaveLength(1)
    const c = doc.value.entities.find(e => e.id === (arcs[0] as any).center) as any
    const t = doc.value.entities.find(e => e.kind === 'point' && Math.abs(Math.hypot((e as any).x - c.x, (e as any).y - c.y) - 1.5) < 1e-9)
    expect(t).toBeTruthy()
  })
  it('too big: the preview is red and Enter refuses, saying why', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('round')
    pen.cornerDown(1, 1, false); pen.cornerUp()
    for (const k of ['9']) pen.onKeydown(key(k))
    expect(pen.cornerView.value!.fits).toBe(false)
    pen.onKeydown(key('Enter'))
    expect(pen.status.value).toBe(CORNER_TOO_BIG)
    expect(json(doc.value)).toBe(before)
    expect(pen.cornerView.value).not.toBeNull()
  })
  it('Esc, a tool change and undo each drop the preview, leaving the drawing exactly as it was', () => {
    const { pen, doc, changes } = setup()
    const before = json(doc.value), c0 = changes()
    pen.selectTool('round')
    pen.cornerDown(1, 1, false); pen.cornerMove(1.3, 1.3)
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.cornerView.value).toBeNull()
    pen.cornerUp()
    expect(json(doc.value)).toBe(before)
    pen.cornerDown(1, 1, false); pen.cornerUp()
    pen.selectTool('select')
    expect(pen.cornerView.value).toBeNull()
    pen.selectTool('chamfer'); pen.cornerDown(1, 1, false); pen.cornerUp()
    pen.undo()
    expect(pen.cornerView.value).toBeNull()
    expect(json(doc.value)).toBe(before)
    expect(changes()).toBe(c0)   // no step was ever written
  })
  it('a press away from any corner says what to click', () => {
    const { pen } = setup()
    pen.selectTool('round')
    pen.cornerDown(3, 3, false)
    expect(pen.status.value).toBe(CORNER_MISS)
    expect(pen.cornerView.value).toBeNull()
  })
  it('Shift-click adds a corner; one drag sizes both; they are tied Equal', () => {
    const { pen, doc } = setup()
    pen.selectTool('chamfer')
    pen.cornerDown(1, 1, false); pen.cornerUp()
    pen.cornerDown(5, 5, true)
    pen.cornerMove(4.8, 4.8); pen.cornerMove(4.6, 4.6)
    expect(pen.cornerView.value!.corners).toHaveLength(2)
    pen.cornerUp()
    expect(pen.status.value).toBe('Chamfered')
    expect(doc.value.constraints.filter(c => c.kind === 'equalDist' && c.refs[0] !== c.refs[2])).toHaveLength(1)
  })
})

describe('PenOverlay draws it', () => {
  it('hover ring, preview (indigo, then red), picked rings, the chip', async () => {
    const { pen } = setup()
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.selectTool('round')
    pen.cornerMove(1.05, 1.05); await nextTick()
    expect(w.find('[data-corner-hover]').exists()).toBe(true)
    pen.cornerDown(1, 1, false); pen.cornerUp(); await nextTick()
    expect(w.find('[data-corner-preview]').attributes('data-fits')).toBe('yes')
    expect(w.findAll('[data-corner-picked]')).toHaveLength(1)
    expect(w.find('[data-corner-chip]').text()).toMatch(/^R 0\.35$/)
    pen.onKeydown(key('9')); await nextTick()
    expect(w.find('[data-corner-chip]').text()).toBe('9|')
    expect(w.find('[data-corner-preview]').exists()).toBe(false)
    expect(w.findAll('[data-corner-bad]')).toHaveLength(1)
    w.unmount()
  })
})

describe('speed', () => {
  it('a hover and a drag frame on the 150-piece gear stay inside 16 ms', () => {
    const { doc: g, anchors } = gear(150)
    const doc = ref(g)
    const pen = usePen({ doc, view: ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 }) })
    pen.selectTool('round')
    const a0 = g.entities.find(e => e.id === anchors[0]) as any
    pen.cornerMove(a0.x, a0.y)   // warm the corner cache
    let t = performance.now()
    for (let i = 0; i < 20; i++) pen.cornerMove(a0.x + i * 1e-3, a0.y)
    expect((performance.now() - t) / 20).toBeLessThan(16)
    pen.cornerDown(a0.x, a0.y, false)
    t = performance.now()
    for (let i = 1; i <= 20; i++) pen.cornerMove(a0.x * (1 - 0.004 * i), a0.y * (1 - 0.004 * i))
    expect((performance.now() - t) / 20).toBeLessThan(16)
  })
})
```

Add to `frontend/tests/unit/pen-tips.unit.spec.ts`: extend `ALL_TOOLS` with `'round', 'chamfer'`, the key table in "the drawing tools carry their single-letter keys" with `round: 'F', chamfer: 'H'`, rename "the ten drawing and editing tools" to "the drawing and editing tools", and add

```ts
  it('round corner and chamfer demos round and cut the corner as the drag goes on', () => {
    for (const id of ['round', 'chamfer']) {
      const early = PEN_TIP_DEMOS[id]!(0.1), late = PEN_TIP_DEMOS[id]!(0.8)
      const pieces = (f: typeof early) => f.doc.entities.filter(e => e.kind === 'path').flatMap(e => (e as any).segments)
      expect(pieces(early)).toHaveLength(2)
      expect(pieces(late)).toHaveLength(3)
      expect(pieces(late)[1].kind).toBe(id === 'round' ? 'arc' : 'line')
    }
  })
```
and in the tool-keys block `it('F and H pick Round corner and Chamfer', …)` (a copy of the V P B L… test with `{ f: 'round', h: 'chamfer' }`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-corners.unit.spec.ts tests/unit/pen-tips.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/composables/pen/penCorners"`, and the tips tests find no `round` / `chamfer` cards.

- [ ] **Step 3: `penCorners.ts`** — create `frontend/app/composables/pen/penCorners.ts`:

```ts
// app/composables/pen/penCorners.ts
// Pen stage 8: the Round corner and Chamfer tools (lib/sketch/corners.ts
// does the geometry). The preview lives in `view` only — the drawing is
// untouched until Apply, which is one history step; anything that ends the
// gesture without Apply drops it (Global Constraints). Pure over the refs it
// is handed (usePen builds it, as penCopies).
import { shallowRef, toRaw, type Ref } from 'vue'
import type { SketchDoc, EntityId, PointEntity } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import type { ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits } from '~/lib/sketch/tolerance'
import { cloneDoc } from '~/lib/sketch/clone'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { cornersOf, cornerAt, cornerPreview, roundCorners, sizeFromPointer, fittingSize, type CornerKind, type Corner } from '~/lib/sketch/corners'

export const CORNER_HIT_PX = 10
export const CORNER_DEFAULT_PX = 12
export const CORNER_DRAG_PX = 3
export const CORNER_TOO_BIG = 'Too big for this corner'
export const CORNER_MISS = 'Click a corner where two pieces meet'

export interface CornerToolView {
  kind: CornerKind
  corners: EntityId[]
  size: number
  typed: string
  d: string
  fits: boolean
  bad: { at: Vec2; d: string }[]
  chip: Vec2
}

export interface PenCornersContext {
  doc: Ref<SketchDoc>
  view: Ref<ViewMatrix>
  tool: Ref<string>
  status: Ref<string>
  docRevision: Ref<number>
  commitHistory: () => void
  runSolve: () => void
  clearSel: () => void
  closeMenus: () => void
  sparkle: (x: number, y: number) => void
}

/** The new rules hold as placed (Global Constraints: Apply solves only when they don't). */
export function rulesHold(doc: SketchDoc, ids: readonly EntityId[]): boolean {
  if (!ids.length) return true
  const set = new Set(ids)
  const r = constraintResiduals({ entities: doc.entities, constraints: doc.constraints.filter(c => set.has(c.id)) })
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of doc.entities) if (e.kind === 'point') { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x); y1 = Math.max(y1, e.y) }
  const tol = 1e-7 * Math.max(1, Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 1)
  return r.every(v => Math.abs(v) <= tol)
}

export function createPenCorners(ctx: PenCornersContext) {
  const view = shallowRef<CornerToolView | null>(null)
  const hover = shallowRef<EntityId | null>(null)
  const lastSize: Partial<Record<CornerKind, number>> = {}
  let press: { corner: EntityId; sx: number; sy: number; moved: boolean } | null = null
  let cache: { rev: number; raw: SketchDoc; map: Map<EntityId, Corner> } | null = null

  const raw = () => toRaw(ctx.doc.value)
  const active = () => ctx.tool.value === 'round' || ctx.tool.value === 'chamfer'
  const kindNow = (): CornerKind => (ctx.tool.value === 'chamfer' ? 'chamfer' : 'round')
  function corners(): Map<EntityId, Corner> {
    const d = raw()
    if (!cache || cache.rev !== ctx.docRevision.value || cache.raw !== d) cache = { rev: ctx.docRevision.value, raw: d, map: cornersOf(d) }
    return cache.map
  }
  function show(kind: CornerKind, picks: EntityId[], size: number, typed: string): void {
    const d = raw()
    const pv = cornerPreview(d, picks, kind, size)
    const first = d.entities.find(e => e.id === picks[0])
    const chip = first && first.kind === 'point' ? { x: first.x, y: first.y } : { x: 0, y: 0 }
    view.value = { kind, corners: picks, size, typed, d: pv.d, fits: pv.fits, bad: pv.bad, chip }
  }
  function defaultSize(kind: CornerKind, picks: EntityId[]): number {
    return fittingSize(raw(), picks, kind, lastSize[kind] ?? pxToUnits(CORNER_DEFAULT_PX, ctx.view.value))
  }
  /** The tool was just picked: the corners among `sel` start picked. */
  function start(kind: CornerKind, sel: readonly EntityId[]): void {
    cancel(false)
    const map = corners()
    const picks = sel.filter(id => map.has(id))
    if (picks.length) show(kind, picks, defaultSize(kind, picks), '')
  }
  function move(x: number, y: number): void {
    if (!active()) { if (hover.value) hover.value = null; return }
    if (press) {
      const v = view.value
      if (!v) return
      if (!press.moved && Math.hypot(x - press.sx, y - press.sy) > pxToUnits(CORNER_DRAG_PX, ctx.view.value)) press.moved = true
      if (!press.moved || v.typed) return   // a typed size wins over the pointer
      const c = corners().get(press.corner)
      if (!c) return
      show(v.kind, v.corners, sizeFromPointer(raw(), c, v.kind, { x, y }), '')
      return
    }
    const hit = cornerAt(raw(), { x, y }, pxToUnits(CORNER_HIT_PX, ctx.view.value), corners())
    if (hit !== hover.value) hover.value = hit
  }
  function down(x: number, y: number, additive: boolean): void {
    if (!active()) return
    ctx.closeMenus()
    const hit = cornerAt(raw(), { x, y }, pxToUnits(CORNER_HIT_PX, ctx.view.value), corners())
    if (!hit) { ctx.status.value = CORNER_MISS; return }
    const kind = kindNow(), v = view.value
    const had = v?.corners ?? []
    const picks = additive ? (had.includes(hit) ? had.filter(id => id !== hit) : [...had, hit]) : (had.includes(hit) ? had : [hit])
    if (!picks.length) { cancel(false); return }
    const size = v && v.kind === kind ? v.size : defaultSize(kind, picks)
    show(kind, picks, v?.typed ? Number(v.typed) || size : size, v?.typed ?? '')
    press = picks.includes(hit) ? { corner: hit, sx: x, sy: y, moved: false } : null
  }
  function up(): void {
    const p = press
    press = null
    if (p?.moved && view.value) apply()
  }
  function typeTo(s: string): void {
    const v = view.value!
    const n = Number(s)
    show(v.kind, v.corners, s && Number.isFinite(n) && n > 0 ? n : v.size, s)
  }
  /** Digits, `.`, Backspace, Enter, Escape while a preview is live. */
  function key(ev: KeyboardEvent): boolean {
    const v = view.value
    if (!v || !active() || ev.metaKey || ev.ctrlKey || ev.altKey) return false
    if (/^[0-9]$/.test(ev.key) || (ev.key === '.' && !v.typed.includes('.'))) { typeTo(v.typed + ev.key); return true }
    if (ev.key === 'Backspace' && v.typed) { typeTo(v.typed.slice(0, -1)); return true }
    if (ev.key === 'Enter') { apply(); return true }
    if (ev.key === 'Escape') { cancel(true); return true }
    return false
  }
  function apply(): boolean {
    const v = view.value
    if (!v) return false
    if (!v.fits) { ctx.status.value = CORNER_TOO_BIG; return false }
    const work = cloneDoc(raw())
    const built = roundCorners(work, v.corners, v.kind, v.size)
    if (!built.ok) { ctx.status.value = CORNER_TOO_BIG; return false }
    const at = v.corners.map(id => work.entities.find(e => e.id === id)).filter((e): e is PointEntity => e?.kind === 'point')
    press = null
    view.value = null
    hover.value = null
    lastSize[v.kind] = v.size
    ctx.doc.value = work
    ctx.clearSel()
    if (!rulesHold(work, built.rules)) ctx.runSolve()
    ctx.commitHistory()
    for (const p of at.slice(0, 12)) ctx.sparkle(p.x, p.y)
    ctx.status.value = v.kind === 'round' ? 'Rounded' : 'Chamfered'
    return true
  }
  function cancel(say: boolean): void {
    press = null
    const had = !!view.value
    view.value = null
    if (say && had) ctx.status.value = 'Cancelled'
  }
  return { view, hover, start, move, down, up, key, apply, cancel }
}
```

- [ ] **Step 4: Wire it into `usePen.ts`** —
  - `export type PenTool = 'select' | 'point' | 'line' | 'circle' | 'path' | 'curve' | 'trim' | 'cut' | 'dissolve' | 'fill' | 'round' | 'chamfer'` and add `'round', 'chamfer'` to `ALL_PEN_TOOLS`.
  - import `import { createPenCorners } from './penCorners'` and, right after `const penCopies = createPenCopies(...)`:
    ```ts
    // --- Round corner / Chamfer (pen stage 8): see penCorners.ts — the preview
    // is overlay-only; Apply is one step; anything else drops it untouched
    const penCorners = createPenCorners({
      doc, view: opts.view, tool, status, docRevision, commitHistory, runSolve,
      clearSel: () => { clearSel(); clearSegSel() }, closeMenus, sparkle,
    })
    const cornerView = penCorners.view, cornerHover = penCorners.hover
    function cornerMove(x: number, y: number) { penCorners.move(x, y) }
    function cornerDown(x: number, y: number, additive = false) { if (!cleanup.value) penCorners.down(x, y, additive) }
    function cornerUp() { penCorners.up() }
    function applyCorners(): boolean { return penCorners.apply() }
    function cancelCorners(): void { penCorners.cancel(false) }
    ```
    (`closeMenus` and `sparkle` are function declarations, hoisted; `cleanup` is a `const` declared further down, but it is only read when `cornerDown` runs, long after setup.)
  - a single drop helper used everywhere a gesture ends:
    ```ts
    function dropPreviews(): void { penCorners.cancel(false) }
    ```
    and call `dropPreviews()` in: `undo()` and `redo()` (their FIRST line, next to `closeMenus()` — before the `if (!penHistory.undo()) return` guard, so ⌘Z with nothing to undo still drops a preview), `reset()`, `revert()`, `finishSession()` (after `closeCleanup()`), `endGesture()`, `dispose()`, `startCleanup()` (before `finishSession()`).
  - `selectTool(t)`: capture the selection before it is cleared and start the tool after it is set:
    ```ts
    const carried = selection.value.slice()        // first line inside selectTool, after the isToolAllowed guard
    …
    dropPreviews()                                  // next to resetEditTools()
    …
    tool.value = t                                  // (existing line)
    if (t === 'round' || t === 'chamfer') penCorners.start(t, carried)
    ```
  - `onKeydown`'s context: add `previewKey: (ev: KeyboardEvent) => penCorners.key(ev),` to the `ctx` object.
  - `clearToolHover()` (the pointer left the drawing): add `penCorners.hover.value = null`.
  - return object: add `cornerView, cornerHover, cornerMove, cornerDown, cornerUp, applyCorners, cancelCorners,` under a `// round corner / chamfer (pen stage 8)` comment.

- [ ] **Step 5: `penKeys.ts`** — add `previewKey: (ev: KeyboardEvent) => boolean` to `PenKeyContext` (comment: "pen stage 8: a live corner / offset preview's own keys — digits, '.', '−', Backspace, Enter, Escape"), extend `TOOL_KEYS` with `f: 'round', h: 'chamfer'`, and in `handlePenKey`, right after the `isCleanupKey` block:

```ts
  // pen stage 8: a live Round corner / Chamfer / Offset preview takes its
  // digits, Backspace, Enter and Escape first (tool letters still switch —
  // selectTool drops the preview)
  if (ctx.previewKey(ev)) return true
```

- [ ] **Step 6: `PenOverlay.vue`** —
  - destructure `cornerView, cornerHover, cornerMove, cornerDown, cornerUp,` from the pen with the other tool functions;
  - `onPointerDownSvg`, next to the Fill line: `if (tool.value === 'round' || tool.value === 'chamfer') { cornerDown(w.x, w.y, ev.shiftKey); return }`;
  - `onPointerMove`: add `tool.value === 'round' || tool.value === 'chamfer'` to the hover branch's condition and `else if (tool.value === 'round' || tool.value === 'chamfer') cornerMove(w.x, w.y)` inside it;
  - `onPointerUp`, before the path branch: `if (tool.value === 'round' || tool.value === 'chamfer') { cornerUp(); return }`;
  - script:
    ```ts
    // Round corner / Chamfer (pen stage 8): the preview in drawing space, the
    // picked and hovered corners ringed and the size chip in screen space
    const cornerShown = computed(() => (cleanupSession.value ? null : cornerView.value))
    const cornerRings = computed(() => {
      const v = cornerShown.value
      return v ? v.corners.map(id => screenPt(id)).filter((s): s is { x: number; y: number } => !!s) : []
    })
    const cornerHoverScreen = computed(() => (cornerHover.value && (tool.value === 'round' || tool.value === 'chamfer') ? screenPt(cornerHover.value) : null))
    const cornerChip = computed(() => {
      const v = cornerShown.value
      if (!v) return null
      const s = toScreen(v.chip)
      const text = v.typed ? `${v.typed}|` : v.kind === 'round' ? `R ${v.size.toFixed(2).replace(/0$/, '')}` : v.size.toFixed(2).replace(/0$/, '')
      const w = 8 + text.length * 6
      return { ...chipOrigin(s, w), w, text }
    })
    ```
    (the chip rounds to two places and drops one trailing zero: 0.3529 → "0.35", 1.5 → "1.5");
  - template, after the trim ghosts group:
    ```html
    <g v-if="cornerShown" :transform="svgTransform" pointer-events="none">
      <path v-if="cornerShown.d && cornerShown.fits" :d="cornerShown.d" fill="none" stroke="#6366f1" stroke-width="2"
            vector-effect="non-scaling-stroke" data-corner-preview data-fits="yes" />
      <path v-for="(b, i) in cornerShown.bad.filter(x => x.d)" :key="'cbad-' + i" :d="b.d" fill="none" stroke="#ef4444"
            stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" data-corner-bad />
    </g>
    <circle v-for="(s, i) in cornerRings" :key="'cpick-' + i" :cx="s.x" :cy="s.y" r="8" fill="none"
            :stroke="cornerShown?.fits ? '#6366f1' : '#ef4444'" stroke-width="2" pointer-events="none" data-corner-picked />
    <circle v-if="cornerHoverScreen" :cx="cornerHoverScreen.x" :cy="cornerHoverScreen.y" r="10" fill="none"
            stroke="#6366f1" stroke-opacity="0.6" stroke-width="2" pointer-events="none" data-corner-hover />
    <g v-if="cornerChip" pointer-events="none" data-corner-chip>
      <rect :x="cornerChip.x" :y="cornerChip.y" :width="cornerChip.w" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="cornerChip.x + 4" :y="cornerChip.y + 11" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ cornerChip.text }}</text>
    </g>
    ```
    A bad corner without geometry (`d === ''`) is shown by its ring turning red. The test's `data-corner-preview` absent while red matches this markup (the red pieces carry `data-corner-bad`).

- [ ] **Step 7: Toolbar, cards, demos, page hook** —
  - `PenToolbar.vue`: import `SquareRoundCorner, Octagon` from `lucide-vue-next`; append to `ALL_TOOLS` `{ id: 'round', icon: SquareRoundCorner }, { id: 'chamfer', icon: Octagon },`; add to `TOOL_HINTS`
    ```ts
    round: 'Drag from a corner to round it, or click it and type the radius · Shift-click adds corners',
    chamfer: 'Drag from a corner to cut it off, or click it and type how far · Shift-click adds corners',
    ```
    and update the comment "Tool row: …" with "then Round corner and Chamfer (pen stage 8)".
  - `penTips.ts`, after `fill`:
    ```ts
    round: { name: 'Round corner', key: 'F', demo: 'round',
      caption: 'Turns a corner into a smooth arc. Drag from the corner, or click it and type the radius; Shift-click more corners to give them the same one.' },
    chamfer: { name: 'Chamfer', key: 'H', demo: 'chamfer',
      caption: 'Cuts a corner off straight, the same distance back along both sides. Drag from the corner, or click it and type how far.' },
    ```
    and change "The ten drawing and editing tools" in its header comment to "The drawing and editing tools".
  - `penTipDemos.ts`, before `cleanup`:
    ```ts
    // Round corner / Chamfer: an L; press on its corner and drag inward — the
    // corner rounds (or is cut) further as the drag goes on.
    function corner(kind: 'round' | 'chamfer') {
      return (t: number): PenTipFrame => {
        const A = v(40, 80), X = v(40, 24), B = v(128, 24)
        const at = v(X.x + 1, X.y + 2)
        const cursor = track(t, [[0.04, v(120, 80)], [0.3, at], [0.4, at], [0.7, v(62, 46)], [0.9, v(62, 46)]])
        const r = 30 * prog(t, 0.4, 0.7)
        const s = sk()
        if (r < 0.5) s.path([A, X, B], ['line', 'line'])
        else {
          const T1 = v(X.x, X.y + r), T2 = v(X.x + r, X.y)
          const mid = v(X.x + r * (1 - Math.SQRT1_2), X.y + r * (1 - Math.SQRT1_2))
          s.path([A, T1, T2, B], ['line', kind === 'round' ? { via: mid } : 'line', 'line'])
        }
        return {
          doc: s.doc, cursor, pressed: within(t, 0.4, 0.72),
          dots: r < 0.5 ? [A, X, B] : [A, B],
          hot: t >= 0.28 && t < 0.4 ? [X] : [],
          ...sparkleAt(t, 0.72, v(X.x + 9, X.y + 9)),
        }
      }
    }
    const round = corner('round'), chamfer = corner('chamfer')
    ```
    and add `round, chamfer,` to `PEN_TIP_DEMOS` (before `cleanup`). Check `track`, `prog`, `within`, `sparkleAt` against the helpers at the top of the file (they are used by `trim` / `cut` the same way).
  - `pages/dev/sketch-draw.vue`, in `__sketchDraw` after `fills`:
    ```ts
    // pen stage 8 — read the corner tools' preview (never change it)
    corner: () => {
      const v = pen.cornerView.value
      return v ? { kind: v.kind, corners: v.corners.slice(), size: v.size, typed: v.typed, fits: v.fits, bad: v.bad.length } : null
    },
    ```

- [ ] **Step 8: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-corners.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-options.unit.spec.ts tests/unit/pen-overlay-host-keys.unit.spec.ts tests/unit/pen-overlay-buttons.unit.spec.ts tests/unit/pen-fills.unit.spec.ts tests/unit/pen-toolbar-cleanup.unit.spec.ts`
Expected: PASS. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'composables/pen/(penCorners|usePen|penKeys|penTips|penTipDemos)\.ts|components/pen/(PenOverlay|PenToolbar)\.vue|pages/dev/sketch-draw\.vue'` prints nothing new (a `Record<PenTool, …>` anywhere else that now misses `round` / `chamfer` must get entries too — grep `Record<PenTool` first).

- [ ] **Step 9: Commit**

```bash
git add frontend/app/composables/pen/penCorners.ts frontend/app/composables/pen/usePen.ts frontend/app/composables/pen/penKeys.ts frontend/app/components/pen/PenOverlay.vue frontend/app/components/pen/PenToolbar.vue frontend/app/composables/pen/penTips.ts frontend/app/composables/pen/penTipDemos.ts frontend/app/pages/dev/sketch-draw.vue frontend/tests/unit/pen-corners.unit.spec.ts frontend/tests/unit/pen-tips.unit.spec.ts
git commit -m "feat(pen): Round corner (F) and Chamfer (H) tools — drag or type, overlay-only preview, one step (stage 8)"
```

---
### Task 5: Offset — the source, the geometry with sharp corners, the live construction, the preview (pure)

**Files:**
- Create: `frontend/app/lib/sketch/offset.ts`
- Test: `frontend/tests/unit/sketch-offset.unit.spec.ts`

**Behaviour (Rulings 9, 10, 17):** as the rulings say. `offsetGeom` never changes the drawing; `applyOffset` adds the copy with its rules (and returns the ids of the rules it added, for the pen's "solve only if needed"); `offsetDistanceAt` is the signed distance of a point from the nearest source piece (left of travel positive; a circle: outside positive).

**Interfaces:**
- Consumes: `addPoint`, `addPath`, `addCircle`, `addConstraint` (`edit.ts`); `segCount`, `SegPick` (`pieces.ts`); `intersectCarriers` (Task 3, `corners.ts`).
- Produces (`offset.ts`):
  ```ts
  export type ChainPiece = { kind: 'line'; a: EntityId; b: EntityId } | { kind: 'arc'; a: EntityId; b: EntityId; c: EntityId; sweep: 0 | 1 }
  export type OffsetChain = { kind: 'chain'; pieces: ChainPiece[]; closed: boolean } | { kind: 'circle'; id: EntityId; c: EntityId }
  export type OffsetSource = { ok: true; chains: OffsetChain[] } | { ok: false; why: 'nothing' | 'curve' }
  export interface OffsetChainGeom { pts: Vec2[]; radii: (number | null)[]; centres: (Vec2 | null)[]; sweeps: (0 | 1 | null)[]; closed: boolean; circle?: { c: Vec2; r: number } }
  export interface OffsetGeom { chains: OffsetChainGeom[]; ok: boolean }
  export interface OffsetBuild { ok: boolean; created: EntityId[]; rules: EntityId[] }
  export function offsetSource(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): OffsetSource
  export function offsetGeom(doc: SketchDoc, chains: readonly OffsetChain[], d: number): OffsetGeom
  export function offsetGeomD(g: OffsetGeom): string
  export function applyOffset(doc: SketchDoc, chains: readonly OffsetChain[], d: number): OffsetBuild
  export function offsetDistanceAt(doc: SketchDoc, chains: readonly OffsetChain[], p: Vec2): number
  ```

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-offset.unit.spec.ts`:

```ts
// tests/unit/sketch-offset.unit.spec.ts
// Pen stage 8: Offset, pure — the source (whole paths, runs of picked pieces,
// lines, circles; Bézier refused), lines to parallels and arcs to arcs on the
// same centre meeting sharp, open ends held opposite the source's ends, the
// copy kept live by its rules, too far refused, the pointer's signed
// distance, and speed on one connected drawing.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, PathEntity } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addCircle } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'
import { offsetSource, offsetGeom, offsetGeomD, applyOffset, offsetDistanceAt } from '~/lib/sketch/offset'
import { gear, squarePath } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const allHold = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-7)
const chainsOf = (d: SketchDoc, sel: string[], segs: { pathId: string; segIndex: number }[] = []) => {
  const s = offsetSource(d, sel, segs)
  if (!s.ok) throw new Error(s.why)
  return s.chains
}

describe('the source', () => {
  it('a whole closed path, a line, a circle; runs of picked pieces; guides left out; Bézier refused', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    const l = addLine(d, addPoint(d, 10, 0), addPoint(d, 14, 0))
    const c = addCircle(d, addPoint(d, 20, 0), 2)
    const chains = chainsOf(d, [path, l, c])
    expect(chains.map(k => k.kind)).toEqual(['chain', 'chain', 'circle'])
    expect(chains[0]).toMatchObject({ closed: true })
    expect((chains[0] as any).pieces).toHaveLength(4)
    const runs = chainsOf(d, [], [{ pathId: path, segIndex: 0 }, { pathId: path, segIndex: 1 }, { pathId: path, segIndex: 3 }])
    // 3 → 0 → 1 follow on round the closed path: one run of three
    expect(runs).toHaveLength(1)
    expect((runs[0] as any).pieces).toHaveLength(3)
    const g = addLine(d, addPoint(d, 0, 9), addPoint(d, 4, 9), { construction: true })
    expect(offsetSource(d, [g], [])).toEqual({ ok: false, why: 'nothing' })
    const h = addPoint(d, 30, 3)
    const bz = addPath(d, [addPoint(d, 30, 0), addPoint(d, 34, 0)], [{ kind: 'cubic', h1: h, h2: null }])
    expect(offsetSource(d, [bz], [])).toEqual({ ok: false, why: 'curve' })
  })
})

describe('geometry and construction', () => {
  it('a square offset outwards by 1: a square 2 bigger, sharp corners, every rule holding', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)   // counter-clockwise: its left is inside
    const chains = chainsOf(d, [path])
    const g = offsetGeom(d, chains, -1)
    expect(g.ok).toBe(true)
    const xs = g.chains[0]!.pts.map(p => [Number(p.x.toFixed(9)), Number(p.y.toFixed(9))])
    expect(xs).toEqual([[-1, -1], [5, -1], [5, 5], [-1, 5]])
    const built = applyOffset(d, chains, -1)
    expect(built.ok).toBe(true)
    expect(d.entities.filter(e => e.kind === 'path')).toHaveLength(2)
    expect(d.constraints.filter(c => c.kind === 'offsetLine')).toHaveLength(8)
    expect(allHold(d)).toBe(true)
    expect(offsetGeomD(g)).toMatch(/^M -1 -1 L 5 -1 L 5 5 L -1 5 Z$/)
  })
  it('live: a source corner dragged, the copy follows at the same distance', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 4)
    P(d, pts[0]!).fixed = true
    const copy = applyOffset(d, chainsOf(d, [path]), 1).created
    const cp = d.entities.find(e => e.kind === 'path' && copy.includes(e.id)) as PathEntity
    expect(solve(d, { drag: { point: pts[2]!, x: 6, y: 6 } }).converged).toBe(true)
    expect(allHold(d)).toBe(true)
    // the inner copy's corner opposite the fixed one sits 1 in from both sides
    const q = P(d, cp.anchors[2]!)
    expect(q.x).toBeLessThan(6); expect(q.y).toBeLessThan(6)
  })
  it('an open L: its ends sit opposite the source’s ends', () => {
    const d = doc()
    const a = addPoint(d, 0, 4), b = addPoint(d, 0, 0), c = addPoint(d, 4, 0)
    const path = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    const built = applyOffset(d, chainsOf(d, [path]), 1)
    expect(built.ok).toBe(true)
    const cp = d.entities.find(e => e.kind === 'path' && e.id !== path) as PathEntity
    const [e0, k, e1] = cp.anchors.map(id => P(d, id))
    // travelling down then right, the left is +x then +y
    expect([e0.x, e0.y]).toEqual([1, 4]); expect([k.x, k.y]).toEqual([1, 1]); expect([e1.x, e1.y]).toEqual([4, 1])
    expect(d.constraints.filter(x => x.kind === 'perpendicular')).toHaveLength(2)
    expect(allHold(d)).toBe(true)
  })
  it('an arc offsets on the same centre point, radius minus the distance on its left', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3)
    const path = addPath(d, [s, e], [{ kind: 'arc', center: ctr, sweep: 1 }])   // counter-clockwise: left is inside
    const built = applyOffset(d, chainsOf(d, [path]), 1)
    expect(built.ok).toBe(true)
    const cp = d.entities.find(x => x.kind === 'path' && x.id !== path) as PathEntity
    expect(cp.segments[0]).toEqual({ kind: 'arc', center: ctr, sweep: 1 })
    expect(Math.hypot(P(d, cp.anchors[0]!).x, P(d, cp.anchors[0]!).y)).toBeCloseTo(2, 9)
    expect(d.constraints.find(x => x.kind === 'offsetRadius')?.value).toBe(-1)
    expect(allHold(d)).toBe(true)
  })
  it('a circle offsets to a circle on the same centre', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0), c = addCircle(d, ctr, 2)
    const built = applyOffset(d, chainsOf(d, [c]), 0.5)
    expect(built.ok).toBe(true)
    const nc = d.entities.find(x => x.kind === 'circle' && x.id !== c) as any
    expect(nc.center).toBe(ctr); expect(nc.r).toBe(2.5)
    expect(d.constraints.find(x => x.kind === 'offsetRadius')?.refs).toEqual([c, nc.id])
  })
  it('too far: inside a small square, past an arc’s centre, a circle to nothing — refused', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    expect(offsetGeom(d, chainsOf(d, [path]), 2.5).ok).toBe(false)
    const ctr = addPoint(d, 10, 0), s = addPoint(d, 13, 0), e = addPoint(d, 10, 3)
    const arc = addPath(d, [s, e], [{ kind: 'arc', center: ctr, sweep: 1 }])
    expect(offsetGeom(d, chainsOf(d, [arc]), 3).ok).toBe(false)
    const c = addCircle(d, addPoint(d, 20, 0), 1)
    expect(offsetGeom(d, chainsOf(d, [c]), -1).ok).toBe(false)
    expect(offsetGeom(d, chainsOf(d, [c]), 0).ok).toBe(false)
    const before = JSON.stringify(d)
    expect(applyOffset(d, chainsOf(d, [path]), 2.5).ok).toBe(false)
    expect(JSON.stringify(d)).toBe(before)
  })
  it('the pointer’s signed distance: left of travel positive, a circle outside positive', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    const chains = chainsOf(d, [path])
    expect(offsetDistanceAt(d, chains, { x: 2, y: 1 })).toBeCloseTo(1, 9)     // inside = left of a ccw square
    expect(offsetDistanceAt(d, chains, { x: 2, y: -1.5 })).toBeCloseTo(-1.5, 9)
    const c = addCircle(d, addPoint(d, 20, 0), 2)
    expect(offsetDistanceAt(d, chainsOf(d, [c]), { x: 23, y: 0 })).toBeCloseTo(1, 9)
  })
})

describe('speed (one connected drawing)', () => {
  it('a preview frame of the 150-piece gear stays inside 16 ms', () => {
    const { doc: g, path } = gear(150)
    const chains = chainsOf(g, [path])
    offsetGeom(g, chains, -0.1)
    const t = performance.now()
    for (let i = 0; i < 10; i++) { const og = offsetGeom(g, chains, -0.1 - i * 0.01); offsetGeomD(og); offsetDistanceAt(g, chains, { x: 12, y: 0 }) }
    expect((performance.now() - t) / 10).toBeLessThan(16)
    expect(offsetGeom(g, chains, -0.1).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-offset.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/offset"`.

- [ ] **Step 3: Implement** — create `frontend/app/lib/sketch/offset.ts`:

```ts
// app/lib/sketch/offset.ts
// Pen stage 8, Offset (spec "Stage 8 — Offset"): a parallel copy of a path at
// a signed distance — lines to parallel lines, arcs to arcs on the same centre
// point, a circle to a circle on its centre — meeting sharp (Ruling 10), kept
// live by offsetLine / offsetRadius (and, at an open chain's ends,
// perpendicular / collinear). Pure.
import type { SketchDoc, EntityId, SegmentSpec } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { addPoint, addPath, addCircle, addConstraint } from './edit'
import { segCount, type SegPick } from './pieces'
import { intersectCarriers } from './corners'

const TAU = Math.PI * 2
const EPS = 1e-9

export type ChainPiece =
  | { kind: 'line'; a: EntityId; b: EntityId }
  | { kind: 'arc'; a: EntityId; b: EntityId; c: EntityId; sweep: 0 | 1 }
export type OffsetChain =
  | { kind: 'chain'; pieces: ChainPiece[]; closed: boolean }
  | { kind: 'circle'; id: EntityId; c: EntityId }
export type OffsetSource = { ok: true; chains: OffsetChain[] } | { ok: false; why: 'nothing' | 'curve' }
export interface OffsetChainGeom { pts: Vec2[]; radii: (number | null)[]; centres: (Vec2 | null)[]; sweeps: (0 | 1 | null)[]; closed: boolean; circle?: { c: Vec2; r: number } }
export interface OffsetGeom { chains: OffsetChainGeom[]; ok: boolean }
export interface OffsetBuild { ok: boolean; created: EntityId[]; rules: EntityId[] }

// ── the source (Ruling 9) ───────────────────────────────────────────────────

function piecesOf(p: Extract<SketchDoc['entities'][number], { kind: 'path' }>, idx: number[]): ChainPiece[] | null {
  const n = p.anchors.length
  const out: ChainPiece[] = []
  for (const i of idx) {
    const s = p.segments[i]!, a = p.anchors[i]!, b = p.anchors[(i + 1) % n]!
    if (s.kind === 'cubic') return null
    out.push(s.kind === 'arc' ? { kind: 'arc', a, b, c: s.center, sweep: s.sweep } : { kind: 'line', a, b })
  }
  return out
}

export function offsetSource(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): OffsetSource {
  const chains: OffsetChain[] = []
  let curve = false
  for (const id of sel) {
    const e = getEntity(doc, id)
    if (!e || e.kind === 'point' || e.construction) continue
    if (e.kind === 'line') chains.push({ kind: 'chain', pieces: [{ kind: 'line', a: e.p1, b: e.p2 }], closed: false })
    else if (e.kind === 'circle') chains.push({ kind: 'circle', id: e.id, c: e.center })
    else {
      const ps = piecesOf(e, [...Array(segCount(e)).keys()])
      if (!ps) curve = true
      else chains.push({ kind: 'chain', pieces: ps, closed: e.closed })
    }
  }
  const byPath = new Map<EntityId, Set<number>>()
  for (const s of segs) {
    if (sel.includes(s.pathId)) continue
    const set = byPath.get(s.pathId) ?? new Set<number>()
    set.add(s.segIndex); byPath.set(s.pathId, set)
  }
  for (const [pid, set] of byPath) {
    const p = getEntity(doc, pid)
    if (!p || p.kind !== 'path' || p.construction) continue
    const n = segCount(p)
    const ok = [...set].filter(i => i >= 0 && i < n).sort((x, y) => x - y)
    if (p.closed && ok.length === n) {
      const ps = piecesOf(p, ok)
      if (!ps) curve = true; else chains.push({ kind: 'chain', pieces: ps, closed: true })
      continue
    }
    const has = new Set(ok)
    const prevOf = (i: number) => (p.closed ? (i - 1 + n) % n : i - 1)
    for (const i of ok) {
      if (has.has(prevOf(i))) continue           // not the start of a run
      const run: number[] = []
      for (let k = i; has.has(k) && run.length < n; k = p.closed ? (k + 1) % n : k + 1) run.push(k)
      const ps = piecesOf(p, run)
      if (!ps) curve = true; else chains.push({ kind: 'chain', pieces: ps, closed: false })
    }
  }
  if (curve) return { ok: false, why: 'curve' }
  return chains.length ? { ok: true, chains } : { ok: false, why: 'nothing' }
}

// ── geometry (Ruling 10) ────────────────────────────────────────────────────

type PieceGeom =
  | { kind: 'line'; A: Vec2; B: Vec2; n: Vec2 }
  | { kind: 'arc'; A: Vec2; B: Vec2; C: Vec2; R: number; sgn: 1 | -1 }
type Carrier = { kind: 'line'; p: Vec2; u: Vec2 } | { kind: 'circle'; c: Vec2; r: number }

const pt = (doc: SketchDoc, id: EntityId): Vec2 | null => { const p = getPoint(doc, id); return p ? { x: p.x, y: p.y } : null }
const norm = (a: number) => ((a % TAU) + TAU) % TAU

function pieceGeom(doc: SketchDoc, pc: ChainPiece): PieceGeom | null {
  const A = pt(doc, pc.a), B = pt(doc, pc.b)
  if (!A || !B) return null
  if (pc.kind === 'line') {
    const L = Math.hypot(B.x - A.x, B.y - A.y)
    if (L < EPS) return null
    return { kind: 'line', A, B, n: { x: -(B.y - A.y) / L, y: (B.x - A.x) / L } }
  }
  const C = pt(doc, pc.c)
  if (!C) return null
  const R = Math.hypot(A.x - C.x, A.y - C.y)
  if (R < EPS) return null
  return { kind: 'arc', A, B, C, R, sgn: pc.sweep === 1 ? 1 : -1 }
}
// the left normal of the way of travel at P
function normalAt(g: PieceGeom, P: Vec2): Vec2 {
  if (g.kind === 'line') return g.n
  return { x: (g.sgn * (g.C.x - P.x)) / g.R, y: (g.sgn * (g.C.y - P.y)) / g.R }
}
function carrier(g: PieceGeom, d: number): Carrier {
  if (g.kind === 'line') {
    const L = Math.hypot(g.B.x - g.A.x, g.B.y - g.A.y)
    return { kind: 'line', p: { x: g.A.x + d * g.n.x, y: g.A.y + d * g.n.y }, u: { x: (g.B.x - g.A.x) / L, y: (g.B.y - g.A.y) / L } }
  }
  return { kind: 'circle', c: g.C, r: g.R - g.sgn * d }
}
const shift = (P: Vec2, n: Vec2, d: number): Vec2 => ({ x: P.x + d * n.x, y: P.y + d * n.y })

export function offsetGeom(doc: SketchDoc, chains: readonly OffsetChain[], d: number): OffsetGeom {
  const out: OffsetChainGeom[] = []
  let ok = Math.abs(d) > EPS
  for (const ch of chains) {
    if (ch.kind === 'circle') {
      const e = getEntity(doc, ch.id), c = pt(doc, ch.c)
      const r = e?.kind === 'circle' ? e.r + d : -1
      if (!c || !(r > EPS)) ok = false
      out.push({ pts: [], radii: [], centres: [], sweeps: [], closed: true, circle: { c: c ?? { x: 0, y: 0 }, r: Math.max(r, 0) } })
      continue
    }
    const gs = ch.pieces.map(pc => pieceGeom(doc, pc))
    if (gs.some(g => !g)) { ok = false; out.push({ pts: [], radii: [], centres: [], sweeps: [], closed: ch.closed }); continue }
    const G = gs as PieceGeom[], m = G.length
    const cars = G.map(g => carrier(g, d))
    const radii = cars.map(c => (c.kind === 'circle' ? c.r : null))
    const centres = G.map(g => (g.kind === 'arc' ? g.C : null))
    const sweeps = ch.pieces.map(pc => (pc.kind === 'arc' ? pc.sweep : null))
    if (radii.some(r => r != null && !(r > EPS))) ok = false
    const corner = (j: number): Vec2 => {          // where piece j−1 meets piece j (at piece j's start)
      const prev = G[(j - 1 + m) % m]!, next = G[j]!
      const naive = shift(next.A, normalAt(prev, next.A), d)
      const cand = intersectCarriers(cars[(j - 1 + m) % m]!, cars[j]!)
      if (!cand.length) {
        if (!(prev.kind === 'line' && next.kind === 'line')) ok = false
        return naive
      }
      return cand.reduce((b, q) => (Math.hypot(q.x - naive.x, q.y - naive.y) < Math.hypot(b.x - naive.x, b.y - naive.y) ? q : b))
    }
    const pts: Vec2[] = []
    if (ch.closed) for (let j = 0; j < m; j++) pts.push(corner(j))
    else {
      pts.push(shift(G[0]!.A, normalAt(G[0]!, G[0]!.A), d))
      for (let j = 1; j < m; j++) pts.push(corner(j))
      pts.push(shift(G[m - 1]!.B, normalAt(G[m - 1]!, G[m - 1]!.B), d))
    }
    // a piece that would turn back on itself: too far (Ruling 10)
    for (let i = 0; i < m && ok; i++) {
      const g = G[i]!, p0 = pts[i]!, p1 = pts[ch.closed ? (i + 1) % m : i + 1]!
      if (g.kind === 'line') {
        if ((p1.x - p0.x) * (g.B.x - g.A.x) + (p1.y - p0.y) * (g.B.y - g.A.y) <= EPS) ok = false
      } else {
        const span = (P: Vec2, Q: Vec2) => norm(g.sgn * (Math.atan2(Q.y - g.C.y, Q.x - g.C.x) - Math.atan2(P.y - g.C.y, P.x - g.C.x)))
        if (Math.abs(span(p0, p1) - span(g.A, g.B)) > Math.PI / 2) ok = false
      }
    }
    out.push({ pts, radii, centres, sweeps, closed: ch.closed })
  }
  return { chains: out, ok }
}

const f = (v: number) => { const r = Number(v.toFixed(9)); return Object.is(r, -0) ? 0 : r }

/** The offset as SVG path data (drawing space) — the preview. */
export function offsetGeomD(g: OffsetGeom): string {
  const parts: string[] = []
  for (const ch of g.chains) {
    if (ch.circle) {
      const { c, r } = ch.circle
      if (r > 0) parts.push(`M ${f(c.x - r)} ${f(c.y)} A ${f(r)} ${f(r)} 0 0 1 ${f(c.x + r)} ${f(c.y)} A ${f(r)} ${f(r)} 0 0 1 ${f(c.x - r)} ${f(c.y)} Z`)
      continue
    }
    if (!ch.pts.length) continue
    const m = ch.radii.length
    let s = `M ${f(ch.pts[0]!.x)} ${f(ch.pts[0]!.y)}`
    for (let i = 0; i < m; i++) {
      const p0 = ch.pts[i]!, q = ch.pts[ch.closed ? (i + 1) % m : i + 1]!
      const r = ch.radii[i], c = ch.centres[i], sw = ch.sweeps[i]
      if (r == null || !c || sw == null) { s += ` L ${f(q.x)} ${f(q.y)}`; continue }
      // as sketchPath.ts pathD writes an arc: the piece's own sweep, large from its span
      const span = norm((sw === 1 ? 1 : -1) * (Math.atan2(q.y - c.y, q.x - c.x) - Math.atan2(p0.y - c.y, p0.x - c.x)))
      s += ` A ${f(r)} ${f(r)} 0 ${span > Math.PI ? 1 : 0} ${sw} ${f(q.x)} ${f(q.y)}`
    }
    parts.push(ch.closed ? `${s} Z` : s)
  }
  return parts.join(' ')
}
```

and, in the same file:

```ts
/** Adds the offset (Ruling 10) and the rules that keep it live. Not ok (and
 *  `doc` untouched) when the distance is 0 or too far anywhere. */
export function applyOffset(doc: SketchDoc, chains: readonly OffsetChain[], d: number): OffsetBuild {
  const g = offsetGeom(doc, chains, d)
  if (!g.ok) return { ok: false, created: [], rules: [] }
  const created: EntityId[] = [], rules: EntityId[] = []
  const rule = (...a: Parameters<typeof addConstraint>) => { const id = addConstraint(...a); rules.push(id); return id }
  chains.forEach((ch, k) => {
    const cg = g.chains[k]!
    if (ch.kind === 'circle') {
      const nc = addCircle(doc, ch.c, cg.circle!.r)
      created.push(nc)
      rule(doc, 'offsetRadius', [ch.id, nc], d)
      return
    }
    const ids = cg.pts.map(p => addPoint(doc, p.x, p.y))
    const m = ch.pieces.length
    const at = (i: number) => ids[ch.closed ? i % m : i]!
    const segs: SegmentSpec[] = ch.pieces.map(pc => (pc.kind === 'arc' ? { kind: 'arc', center: pc.c, sweep: pc.sweep } : { kind: 'line' }))
    const before = doc.constraints.length
    const pid = addPath(doc, ids, segs, ch.closed)
    for (const c of doc.constraints.slice(before)) rules.push(c.id)   // each offset arc's own rule
    created.push(pid, ...ids)
    ch.pieces.forEach((pc, i) => {
      if (pc.kind === 'line') { rule(doc, 'offsetLine', [pc.a, pc.b, at(i)], d); rule(doc, 'offsetLine', [pc.a, pc.b, at(i + 1)], d) }
      else rule(doc, 'offsetRadius', [pc.c, pc.a, pc.c, at(i)], -(pc.sweep === 1 ? 1 : -1) * d)
    })
    if (!ch.closed) {
      const first = ch.pieces[0]!, last = ch.pieces[m - 1]!
      if (first.kind === 'line') rule(doc, 'perpendicular', [first.a, first.b, first.a, at(0)])
      else rule(doc, 'collinear', [first.c, first.a, at(0)])
      if (last.kind === 'line') rule(doc, 'perpendicular', [last.a, last.b, last.b, at(m)])
      else rule(doc, 'collinear', [last.c, last.b, at(m)])
    }
  })
  return { ok: true, created, rules }
}

/** The signed distance of `p` from the nearest source piece: left of the way
 *  of travel positive; a circle: outside positive (Ruling 11). 0 with no source. */
export function offsetDistanceAt(doc: SketchDoc, chains: readonly OffsetChain[], p: Vec2): number {
  let best = Infinity, signed = 0
  for (const ch of chains) {
    if (ch.kind === 'circle') {
      const e = getEntity(doc, ch.id), c = pt(doc, ch.c)
      if (!c || e?.kind !== 'circle') continue
      const s = Math.hypot(p.x - c.x, p.y - c.y) - e.r
      if (Math.abs(s) < best) { best = Math.abs(s); signed = s }
      continue
    }
    for (const pc of ch.pieces) {
      const g = pieceGeom(doc, pc)
      if (!g) continue
      let away: number, s: number
      if (g.kind === 'line') {
        const dx = g.B.x - g.A.x, dy = g.B.y - g.A.y, L2 = dx * dx + dy * dy
        const t = Math.max(0, Math.min(1, ((p.x - g.A.x) * dx + (p.y - g.A.y) * dy) / L2))
        away = Math.hypot(p.x - g.A.x - t * dx, p.y - g.A.y - t * dy)
        s = (dx * (p.y - g.A.y) - dy * (p.x - g.A.x)) / Math.sqrt(L2)
      } else {
        const r = Math.hypot(p.x - g.C.x, p.y - g.C.y)
        s = g.sgn * (g.R - r)
        const span = norm(g.sgn * (Math.atan2(g.B.y - g.C.y, g.B.x - g.C.x) - Math.atan2(g.A.y - g.C.y, g.A.x - g.C.x)))
        const at = norm(g.sgn * (Math.atan2(p.y - g.C.y, p.x - g.C.x) - Math.atan2(g.A.y - g.C.y, g.A.x - g.C.x)))
        away = at <= span ? Math.abs(s) : Math.min(Math.hypot(p.x - g.A.x, p.y - g.A.y), Math.hypot(p.x - g.B.x, p.y - g.B.y))
      }
      if (away < best) { best = away; signed = s }
    }
  }
  return signed
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-offset.unit.spec.ts tests/unit/sketch-corners.unit.spec.ts`
Expected: PASS. If the open-L test's corner comes out at the naive point instead of (1, 1), `intersectCarriers` isn't getting the two offset lines — check `carrier()`'s point is the offset start, not the source start. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/offset\.ts'` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/sketch/offset.ts frontend/tests/unit/sketch-offset.unit.spec.ts
git commit -m "feat(pen): offset — parallel lines, arcs on the same centre, sharp corners, kept live by offsetLine / offsetRadius (stage 8)"
```

---
### Task 6: The Offset tool in the pen (E)

**Files:**
- Create: `frontend/app/composables/pen/penOffset.ts`
- Modify: `frontend/app/composables/pen/usePen.ts` (tool union, `openOnly` drop, wiring, drops, preview keys, exports)
- Modify: `frontend/app/composables/pen/penKeys.ts` (E)
- Modify: `frontend/app/components/pen/PenOverlay.vue` (routing, source highlight, preview, chip)
- Modify: `frontend/app/components/pen/PenToolbar.vue` (button, hint)
- Modify: `frontend/app/composables/pen/penTips.ts`, `frontend/app/composables/pen/penTipDemos.ts`
- Modify: `frontend/app/pages/dev/sketch-draw.vue` (read-only `offset()` hook)
- Test: `frontend/tests/unit/pen-offset.unit.spec.ts`, `frontend/tests/unit/pen-tips.unit.spec.ts`

**Behaviour (Rulings 9–11, 17, 21; Global Constraints):**
- E picks Offset (stage-2 rules); every `openOnly` pen drops it even if its host lists it. The selection (whole paths, lines, circles, Option-picked pieces) starts as the source, previewed at the default distance.
- With no source, hovering highlights the piece's path under the pointer (`data-offset-hover`); a click takes that whole path (Option-click just that piece, Shift-click adds to the source) and shows the preview at the default distance (the last one used, else 12 screen px, on the left). A press and drag (on a source piece or anywhere once there is a source) sets the distance and side from the pointer; the release applies. Digits / `.` / Backspace type the distance (its size; the side stays), `-` flips the side, Enter applies, Esc cancels ("Cancelled"). A Bézier piece clicked says "Bézier curves can’t be offset"; empty space with no source says "Click a path, line or circle to offset".
- The preview (`offsetView`) is overlay-only: the source dashed (`data-offset-source`), the offset indigo or red (`data-offset-preview[data-ok]`), a chip (`data-offset-chip`, "0.35", "−0.35", "1|"). Apply: `applyOffset` on a raw clone; solve only if an added rule doesn't hold; one step; status "Offset"; the distance remembered. Dropped by everything that drops the corner preview.

**Interfaces:**
- Consumes (Task 5): `offsetSource`, `offsetGeom`, `offsetGeomD`, `applyOffset`, `offsetDistanceAt`, `OffsetChain`; (Task 4) `rulesHold` from `penCorners.ts`, `dropPreviews` / `previewKey` wiring in `usePen`; `nearestCurve` (`crossings.ts`).
- Produces: `PenTool` gains `'offset'`; `createPenOffset(ctx: PenOffsetContext)` → `{ view, hover, start, move, down, up, key, apply, cancel }`; `usePen` exports `offsetView`, `offsetHover`, `offsetMove(x, y)`, `offsetDown(x, y, additive, onePiece)`, `offsetUp()`, `applyOffsetTool(): boolean`, `cancelOffset(): void`; constants `OFFSET_TOO_FAR = 'Too far for this path'`, `OFFSET_MISS = 'Click a path, line or circle to offset'`, `OFFSET_CURVE = 'Bézier curves can’t be offset'`.
  ```ts
  export interface OffsetToolView {
    chains: OffsetChain[]
    d: number            // signed distance, drawing units (left of travel +)
    typed: string
    source: string       // the source's outline (drawing space)
    preview: string      // the offset's outline (drawing space)
    ok: boolean
    chip: Vec2           // drawing space
  }
  ```

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/pen-offset.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 8, the Offset tool in the shared pen: E (never in an open-only
// pen), the selection starts as the source, press-drag-release applies one
// step, click + digits + Enter, − flips the side, too far refused, Esc leaves
// the drawing exactly as it was (never reaching onLiveChange), Option-click
// takes one piece, the overlay draws it, and a drag frame stays cheap.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type PenTool } from '~/composables/pen/usePen'
import { OFFSET_TOO_FAR, OFFSET_MISS } from '~/composables/pen/penOffset'
import { gear, squarePath } from './__fixtures__/penStage8'

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

const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() {}, stopPropagation() {}, ...mods,
}) as unknown as KeyboardEvent
function setup(options?: { tools?: PenTool[]; openOnly?: boolean }) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const sq = squarePath(doc.value, 1, 1, 4)
  let live = 0
  const pen = usePen({ doc, view: ref(DEV), options, onLiveChange: () => { live++ } })
  return { doc, pen, ...sq, live: () => live }
}
const json = (d: SketchDoc) => JSON.stringify(d)

describe('Offset — keys and start', () => {
  it('E picks Offset; an open-only pen never offers it', () => {
    const { pen } = setup()
    expect(pen.onKeydown(key('e'))).toBe(true); expect(pen.tool.value).toBe('offset')
    const { pen: guide } = setup({ openOnly: true, tools: ['select', 'path', 'offset', 'round'] })
    expect(guide.options.tools).not.toContain('offset')
    expect(guide.options.tools).toContain('round')
    expect(guide.onKeydown(key('e'))).toBe(false)
  })
  it('a selected path starts as the source, previewed 12 px to its left', () => {
    const { pen, path, doc } = setup()
    pen.pick(path)
    const before = json(doc.value)
    pen.selectTool('offset')
    const v = pen.offsetView.value!
    expect(v.d).toBeCloseTo(12 / 34, 9)
    expect(v.ok).toBe(true)
    expect(v.preview).toMatch(/Z$/)
    expect(json(doc.value)).toBe(before)
  })
})

describe('Offset — the gesture', () => {
  it('press on a side, drag outward, release: an outer copy, one step, nothing live before it', () => {
    const { pen, doc, live } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false)
    pen.offsetMove(3, 0.7); pen.offsetMove(3, 0)
    expect(pen.offsetView.value!.d).toBeCloseTo(-1, 9)
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    pen.offsetUp()
    expect(pen.offsetView.value).toBeNull()
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(2)
    expect(doc.value.constraints.filter(c => c.kind === 'offsetLine')).toHaveLength(8)
    expect(pen.status.value).toBe('Offset')
    pen.undo()
    expect(json(doc.value)).toBe(before)
  })
  it('click, digits, − flips, Enter', () => {
    const { pen, doc } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    for (const k of ['0', '.', '5']) expect(pen.onKeydown(key(k))).toBe(true)
    expect(pen.offsetView.value!.d).toBeCloseTo(0.5, 9)
    expect(pen.onKeydown(key('-'))).toBe(true)
    expect(pen.offsetView.value!.d).toBeCloseTo(-0.5, 9)
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    expect(doc.value.constraints.filter(c => c.kind === 'offsetLine').every(c => c.value === -0.5)).toBe(true)
  })
  it('too far: red, Enter refuses and says why', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.onKeydown(key('3'))
    expect(pen.offsetView.value!.ok).toBe(false)
    pen.onKeydown(key('Enter'))
    expect(pen.status.value).toBe(OFFSET_TOO_FAR)
    expect(json(doc.value)).toBe(before)
  })
  it('Esc mid-drag and a tool change leave the drawing exactly as it was', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetMove(3, 0)
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    pen.offsetUp()
    expect(json(doc.value)).toBe(before)
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.onKeydown(key('v'))
    expect(pen.offsetView.value).toBeNull()
    expect(json(doc.value)).toBe(before)
  })
  it('Option-click takes one piece; empty space with no source says what to click', () => {
    const { pen } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 3, false, false)
    expect(pen.status.value).toBe(OFFSET_MISS)
    pen.offsetDown(3, 1, false, true); pen.offsetUp()
    const ch = pen.offsetView.value!.chains
    expect(ch).toHaveLength(1)
    expect((ch[0] as any).pieces).toHaveLength(1)
  })
})

describe('PenOverlay draws it', () => {
  it('hover, source, preview and chip', async () => {
    const { pen } = setup()
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.selectTool('offset')
    pen.offsetMove(3, 1.02); await nextTick()
    expect(w.find('[data-offset-hover]').exists()).toBe(true)
    pen.offsetDown(3, 1, false, false); pen.offsetUp(); await nextTick()
    expect(w.find('[data-offset-source]').attributes('d')).toMatch(/Z$/)
    expect(w.find('[data-offset-preview]').attributes('data-ok')).toBe('yes')
    expect(w.find('[data-offset-chip]').text()).toBe('0.35')
    pen.onKeydown(key('-')); await nextTick()
    expect(w.find('[data-offset-chip]').text()).toBe('−0.35')
    w.unmount()
  })
})

describe('speed', () => {
  it('a drag frame on the 150-piece gear stays inside 16 ms', () => {
    const { doc: g, path } = gear(150)
    const doc = ref(g)
    const pen = usePen({ doc, view: ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 }) })
    pen.pick(path)
    pen.selectTool('offset')
    pen.offsetDown(10, 0, false, false)
    pen.offsetMove(10.2, 0)
    const t = performance.now()
    for (let i = 1; i <= 20; i++) pen.offsetMove(10 + 0.01 * i, 0)
    expect((performance.now() - t) / 20).toBeLessThan(16)
  })
})
```

In `frontend/tests/unit/pen-tips.unit.spec.ts`: add `'offset'` to `ALL_TOOLS` and `offset: 'E'` to the keys table, a key test for `e`, and

```ts
  it('offset demo: a copy moves off the caret as the drag goes on', () => {
    const early = PEN_TIP_DEMOS.offset!(0.1), late = PEN_TIP_DEMOS.offset!(0.8)
    const paths = (f: typeof early) => f.doc.entities.filter(e => e.kind === 'path')
    expect(paths(early)).toHaveLength(1)
    expect(paths(late)).toHaveLength(2)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-offset.unit.spec.ts tests/unit/pen-tips.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/composables/pen/penOffset"`.

- [ ] **Step 3: `penOffset.ts`** — create `frontend/app/composables/pen/penOffset.ts`:

```ts
// app/composables/pen/penOffset.ts
// Pen stage 8: the Offset tool (lib/sketch/offset.ts does the geometry).
// Overlay-only preview; Apply is one step; anything else drops it (Global
// Constraints). Built by usePen, as penCorners.
import { shallowRef, toRaw, type Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import type { ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits } from '~/lib/sketch/tolerance'
import { cloneDoc } from '~/lib/sketch/clone'
import { nearestCurve, type CurveRef } from '~/lib/sketch/crossings'
import type { SegPick } from '~/lib/sketch/pieces'
import { offsetSource, offsetGeom, offsetGeomD, applyOffset, offsetDistanceAt, type OffsetChain } from '~/lib/sketch/offset'
import { rulesHold } from './penCorners'

export const OFFSET_HIT_PX = 8
export const OFFSET_DEFAULT_PX = 12
export const OFFSET_DRAG_PX = 3
export const OFFSET_TOO_FAR = 'Too far for this path'
export const OFFSET_MISS = 'Click a path, line or circle to offset'
export const OFFSET_CURVE = 'Bézier curves can’t be offset'

export interface OffsetToolView { chains: OffsetChain[]; d: number; typed: string; source: string; preview: string; ok: boolean; chip: Vec2 }
export interface PenOffsetContext {
  doc: Ref<SketchDoc>; view: Ref<ViewMatrix>; tool: Ref<string>; status: Ref<string>
  commitHistory: () => void; runSolve: () => void; clearSel: () => void; closeMenus: () => void
}

export function createPenOffset(ctx: PenOffsetContext) {
  const view = shallowRef<OffsetToolView | null>(null)
  const hover = shallowRef<string | null>(null)
  let lastD: number | null = null
  let press: { sx: number; sy: number; moved: boolean } | null = null
  let picks: { sel: EntityId[]; segs: SegPick[] } = { sel: [], segs: [] }

  const raw = () => toRaw(ctx.doc.value)
  const active = () => ctx.tool.value === 'offset'
  const tol = () => pxToUnits(OFFSET_HIT_PX, ctx.view.value)
  function show(chains: OffsetChain[], d: number, typed: string, chip?: Vec2): void {
    const r = raw()
    const g = offsetGeom(r, chains, d)
    const src = offsetGeomD(offsetGeom(r, chains, 0))
    const first = g.chains.find(c => c.pts.length)?.pts[0] ?? g.chains[0]?.circle?.c ?? { x: 0, y: 0 }
    view.value = { chains, d, typed, source: src, preview: offsetGeomD(g), ok: g.ok, chip: chip ?? view.value?.chip ?? first }
  }
  const defaultD = () => lastD ?? pxToUnits(OFFSET_DEFAULT_PX, ctx.view.value)
  function fromPicks(): boolean {
    const s = offsetSource(raw(), picks.sel, picks.segs)
    if (!s.ok) { if (s.why === 'curve') ctx.status.value = OFFSET_CURVE; return false }
    show(s.chains, view.value?.d ?? defaultD(), view.value?.typed ?? '')
    return true
  }
  /** The tool was just picked: the selection starts as the source. */
  function start(sel: readonly EntityId[], segs: readonly SegPick[]): void {
    cancel(false)
    picks = { sel: [...sel], segs: segs.map(s => ({ ...s })) }
    if (picks.sel.length || picks.segs.length) fromPicks()
  }
  function pickOf(ref: CurveRef, onePiece: boolean): { sel: EntityId[]; segs: SegPick[] } {
    if (ref.kind === 'seg') return onePiece ? { sel: [], segs: [{ pathId: ref.pathId, segIndex: ref.segIndex }] } : { sel: [ref.pathId], segs: [] }
    return { sel: [ref.id], segs: [] }
  }
  function move(x: number, y: number): void {
    if (!active()) { if (hover.value) hover.value = null; return }
    const v = view.value
    if (press && v) {
      if (!press.moved && Math.hypot(x - press.sx, y - press.sy) > pxToUnits(OFFSET_DRAG_PX, ctx.view.value)) press.moved = true
      if (!press.moved || v.typed) return
      show(v.chains, offsetDistanceAt(raw(), v.chains, { x, y }), '', { x, y })
      return
    }
    if (v) { if (hover.value) hover.value = null; return }
    const hit = nearestCurve(raw(), { x, y }, tol())
    const p = hit ? pickOf(hit.ref, false) : null
    const s = p ? offsetSource(raw(), p.sel, p.segs) : null
    const d = s?.ok ? offsetGeomD(offsetGeom(raw(), s.chains, 0)) : null
    if (d !== hover.value) hover.value = d
  }
  function down(x: number, y: number, additive: boolean, onePiece: boolean): void {
    if (!active()) return
    ctx.closeMenus()
    const hit = nearestCurve(raw(), { x, y }, tol())
    if (hit) {
      const p = pickOf(hit.ref, onePiece)
      const inSource = view.value && (picks.sel.includes(p.sel[0] ?? '') || picks.segs.some(s => p.segs[0] && s.pathId === p.segs[0].pathId && s.segIndex === p.segs[0].segIndex) || (hit.ref.kind === 'seg' && picks.sel.includes(hit.ref.pathId)))
      if (!inSource) {
        picks = additive && view.value ? { sel: [...picks.sel, ...p.sel], segs: [...picks.segs, ...p.segs] } : p
        if (!fromPicks()) { if (!view.value) picks = { sel: [], segs: [] }; return }
      }
      hover.value = null
      press = { sx: x, sy: y, moved: false }
      return
    }
    if (!view.value) { ctx.status.value = OFFSET_MISS; return }
    press = { sx: x, sy: y, moved: false }
  }
  function up(): void {
    const p = press
    press = null
    if (p?.moved && view.value) apply()
  }
  function key(ev: KeyboardEvent): boolean {
    const v = view.value
    if (!v || !active() || ev.metaKey || ev.ctrlKey || ev.altKey) return false
    const sign = v.d < 0 ? -1 : 1
    const typeTo = (s: string) => { const n = Number(s); show(v.chains, s && Number.isFinite(n) && n > 0 ? sign * n : v.d, s) }
    if (/^[0-9]$/.test(ev.key) || (ev.key === '.' && !v.typed.includes('.'))) { typeTo(v.typed + ev.key); return true }
    if (ev.key === 'Backspace' && v.typed) { typeTo(v.typed.slice(0, -1)); return true }
    if (ev.key === '-' || ev.key === '−') { show(v.chains, -v.d, v.typed); return true }
    if (ev.key === 'Enter') { apply(); return true }
    if (ev.key === 'Escape') { cancel(true); return true }
    return false
  }
  function apply(): boolean {
    const v = view.value
    if (!v) return false
    if (!v.ok) { ctx.status.value = OFFSET_TOO_FAR; return false }
    const work = cloneDoc(raw())
    const built = applyOffset(work, v.chains, v.d)
    if (!built.ok) { ctx.status.value = OFFSET_TOO_FAR; return false }
    press = null; view.value = null; hover.value = null
    picks = { sel: [], segs: [] }
    lastD = v.d
    ctx.doc.value = work
    ctx.clearSel()
    if (!rulesHold(work, built.rules)) ctx.runSolve()
    ctx.commitHistory()
    ctx.status.value = 'Offset'
    return true
  }
  function cancel(say: boolean): void {
    press = null
    picks = { sel: [], segs: [] }
    const had = !!view.value
    view.value = null
    if (say && had) ctx.status.value = 'Cancelled'
  }
  return { view, hover, start, move, down, up, key, apply, cancel }
}
```

- [ ] **Step 4: Wire into `usePen.ts`, `penKeys.ts`, the overlay, the toolbar, tips, demos, page hook** —
  - `usePen.ts`: `PenTool` gains `| 'offset'`; `ALL_PEN_TOOLS` gains `'offset'`; in `resolvedTools` the open-only filter becomes `list.filter(t => t !== 'circle' && t !== 'fill' && t !== 'offset')` (comment: "an open-path guide has no use for a closed shape, a fill or a second line"); create after `penCorners`:
    ```ts
    const penOffset = createPenOffset({ doc, view: opts.view, tool, status, commitHistory, runSolve, clearSel: () => { clearSel(); clearSegSel() }, closeMenus })
    const offsetView = penOffset.view, offsetHover = penOffset.hover
    function offsetMove(x: number, y: number) { penOffset.move(x, y) }
    function offsetDown(x: number, y: number, additive = false, onePiece = false) { if (!cleanup.value) penOffset.down(x, y, additive, onePiece) }
    function offsetUp() { penOffset.up() }
    function applyOffsetTool(): boolean { return penOffset.apply() }
    function cancelOffset(): void { penOffset.cancel(false) }
    ```
    `dropPreviews()` also calls `penOffset.cancel(false)`; `selectTool` captures `const carriedSegs = selectedSegments.value.slice()` beside `carried` and adds `if (t === 'offset') penOffset.start(carried, carriedSegs)`; `previewKey: (ev) => penCorners.key(ev) || penOffset.key(ev)`; `clearToolHover()` also sets `penOffset.hover.value = null`; export the six names under the stage-8 comment.
  - `penKeys.ts`: `TOOL_KEYS` gains `e: 'offset'`.
  - `PenOverlay.vue`: destructure `offsetView, offsetHover, offsetMove, offsetDown, offsetUp`; `onPointerDownSvg`: `if (tool.value === 'offset') { offsetDown(w.x, w.y, ev.shiftKey, ev.altKey); return }`; `onPointerMove`: `'offset'` joins the hover branch → `offsetMove(w.x, w.y)`; `onPointerUp`: `if (tool.value === 'offset') { offsetUp(); return }`. Script:
    ```ts
    // Offset (pen stage 8): the source dashed, the offset (indigo / red) and
    // the hovered path in drawing space; the distance chip in screen space
    const offsetShown = computed(() => (cleanupSession.value ? null : offsetView.value))
    const offsetHoverD = computed(() => (tool.value === 'offset' && !offsetShown.value ? offsetHover.value : null))
    const offsetChip = computed(() => {
      const v = offsetShown.value
      if (!v) return null
      const n = (x: number) => x.toFixed(2).replace(/0$/, '')
      const text = v.typed ? `${v.d < 0 ? '−' : ''}${v.typed}|` : `${v.d < 0 ? '−' : ''}${n(Math.abs(v.d))}`
      const w = 8 + text.length * 6
      return { ...chipOrigin(toScreen(v.chip), w), w, text }
    })
    ```
    Template, beside the corner preview:
    ```html
    <g v-if="offsetShown || offsetHoverD" :transform="svgTransform" pointer-events="none">
      <path v-if="offsetHoverD" :d="offsetHoverD" fill="none" stroke="#6366f1" stroke-opacity="0.5" stroke-width="3"
            vector-effect="non-scaling-stroke" data-offset-hover />
      <template v-if="offsetShown">
        <path :d="offsetShown.source" fill="none" stroke="#6366f1" stroke-width="1.5" stroke-dasharray="4 3"
              vector-effect="non-scaling-stroke" data-offset-source />
        <path :d="offsetShown.preview" fill="none" :stroke="offsetShown.ok ? '#6366f1' : '#ef4444'" stroke-width="2"
              vector-effect="non-scaling-stroke" data-offset-preview :data-ok="offsetShown.ok ? 'yes' : 'no'" />
      </template>
    </g>
    <g v-if="offsetChip" pointer-events="none" data-offset-chip>
      <rect :x="offsetChip.x" :y="offsetChip.y" :width="offsetChip.w" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="offsetChip.x + 4" :y="offsetChip.y + 11" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ offsetChip.text }}</text>
    </g>
    ```
  - `PenToolbar.vue`: import `SquareSquare`; `ALL_TOOLS` gains `{ id: 'offset', icon: SquareSquare }` after Chamfer; `TOOL_HINTS.offset = 'Drag from a path to set the distance, or click it and type it · type − for the other side'`.
  - `penTips.ts`, after `chamfer`:
    ```ts
    offset: { name: 'Offset', key: 'E', demo: 'offset',
      caption: 'A copy that runs alongside a path at a set distance and follows it when the path changes. Drag from the path, or click it and type the distance; type − for the other side.' },
    ```
  - `penTipDemos.ts`, before `cleanup`:
    ```ts
    // Offset: a caret; press on it and drag up — a copy follows alongside,
    // its corner meeting sharp, further off as the drag goes on.
    function offsetCaret(pts: Vec2[], d: number): Vec2[] {
      const nrm = (a: Vec2, b: Vec2) => { const L = Math.hypot(b.x - a.x, b.y - a.y); return v((b.y - a.y) / L, -(b.x - a.x) / L) }   // left of travel, y down
      return pts.map((p, i) => {
        const n1 = i > 0 ? nrm(pts[i - 1]!, p) : null, n2 = i < pts.length - 1 ? nrm(p, pts[i + 1]!) : null
        if (!n1) return v(p.x + d * n2!.x, p.y + d * n2!.y)
        if (!n2) return v(p.x + d * n1.x, p.y + d * n1.y)
        const k = d / (1 + n1.x * n2.x + n1.y * n2.y)
        return v(p.x + k * (n1.x + n2.x), p.y + k * (n1.y + n2.y))
      })
    }
    function offset(t: number): PenTipFrame {
      const src = [v(24, 76), v(80, 44), v(136, 76)]
      const at = v(80, 46)
      const cursor = track(t, [[0.04, v(140, 90)], [0.3, at], [0.4, at], [0.7, v(80, 24)], [0.9, v(80, 24)]])
      const dd = 18 * prog(t, 0.4, 0.7)
      const s = sk().path(src, ['line', 'line'])
      if (dd > 0.5) s.path(offsetCaret(src, dd), ['line', 'line'])
      return { doc: s.doc, cursor, pressed: within(t, 0.4, 0.72), dots: src, ...sparkleAt(t, 0.72, v(80, 44 - dd)) }
    }
    ```
    and add `offset,` to `PEN_TIP_DEMOS`. (In the card's y-down box, `(dy, −dx) / L` is the left of travel: moving right-and-up along the caret's first leg it points up-left, so the copy sits above the caret.)
  - `sketch-draw.vue` hook after `corner`:
    ```ts
    offset: () => {
      const v = pen.offsetView.value
      return v ? { d: v.d, typed: v.typed, ok: v.ok, chains: v.chains.length } : null
    },
    ```

- [ ] **Step 5: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-offset.unit.spec.ts tests/unit/pen-corners.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-options.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-frame.unit.spec.ts`
Expected: PASS. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'composables/pen/(penOffset|usePen|penKeys|penTips|penTipDemos)\.ts|components/pen/(PenOverlay|PenToolbar)\.vue|pages/dev/sketch-draw\.vue'` prints nothing new.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/composables/pen/penOffset.ts frontend/app/composables/pen/usePen.ts frontend/app/composables/pen/penKeys.ts frontend/app/components/pen/PenOverlay.vue frontend/app/components/pen/PenToolbar.vue frontend/app/composables/pen/penTips.ts frontend/app/composables/pen/penTipDemos.ts frontend/app/pages/dev/sketch-draw.vue frontend/tests/unit/pen-offset.unit.spec.ts frontend/tests/unit/pen-tips.unit.spec.ts
git commit -m "feat(pen): Offset tool (E) — drag or type the distance, − for the other side, overlay-only preview, one step (stage 8)"
```

---
### Task 7: Repeat modes — sweep, linear (live), along a path (placed once), and the preview (pure)

**Files:**
- Create: `frontend/app/lib/sketch/repeatModes.ts`
- Modify: `frontend/app/lib/sketch/edit.ts` (`repeatEntities` gains `sweep` and uses `rotateAbout`; new `translateEntities`, `copyAlongPath`)
- Test: `frontend/tests/unit/sketch-repeat-modes.unit.spec.ts`

**Behaviour (Rulings 13–15, 17):**
- `radialAngles(count, sweep)`: k = 1…count−1; sweep ≥ 360 → k·360/count, else k·sweep/(count−1). `repeatEntities(doc, ids, center, count, sweep = 360)` places copy k at `rotateAbout(centre, angle)` — with the default sweep exactly as today.
- `translateEntities(doc, ids, from, to, count, spacing)`: copy k of each point at `orig + f·(to − from)`, f = k (Step) or k/(count−1) (Span), tied by `translatedFrom [copy, orig, from, to]` value f; the pieces and the rules among the copied points copied as Repeat does; fills carried as Repeat does (`fillsWithin` + `copyFills` + `fillCopiedAreas`). `[]` (nothing made) for a count outside 2–64, a missing `from` / `to`, or a selection that uses `from` or `to`.
- `copyAlongPath(doc, ids, along, count)`: copies 1…count−1 moved so the selection's centre lands on `alongPoints(doc, along, count)`; not tied to the original; pieces, inner rules and fills copied. `[]` for a Bézier path, a path that is one of `ids`, or a bad count.
- `copiesPreviewD(doc, ids, placements)`: the source pieces drawn moved by each placement — the Repeat preview, built without making any copy; it draws exactly what the real copies draw (same placement functions).

**Interfaces:**
- Consumes: private `rawPointRefs`, `copyStructure`, `copyClosureConstraints`, `copyFills`, `copiedId` in `edit.ts`; `fillsWithin`, `fillAreas`, `moveAreas`, `fillCopiedAreas`, `mapSeed` (`fills.ts`); `sketchPathData` (`sketchPath.ts`).
- Produces (`repeatModes.ts`):
  ```ts
  export type Placement = (p: Vec2) => Vec2
  export type Spacing = 'step' | 'span'
  export function radialAngles(count: number, sweep?: number): number[]
  export function linearFactors(count: number, spacing: Spacing): number[]
  export function rotateAbout(c: Vec2, deg: number): Placement
  export function shiftBy(v: Vec2, k: number): Placement
  export function selectionCentre(doc: SketchDoc, ids: readonly EntityId[]): Vec2 | null
  export interface PathWalk { length: number; closed: boolean; at(s: number): Vec2 }
  export function pathWalk(doc: SketchDoc, id: EntityId): PathWalk | null
  export function alongPoints(doc: SketchDoc, along: EntityId, count: number): Vec2[] | null
  export function radialPlacements(c: Vec2, count: number, sweep?: number): Placement[]
  export function linearPlacements(vec: Vec2, count: number, spacing: Spacing): Placement[]
  export function alongPlacements(doc: SketchDoc, ids: readonly EntityId[], along: EntityId, count: number): Placement[] | null
  export function copiesPreviewD(doc: SketchDoc, ids: readonly EntityId[], placements: readonly Placement[]): string
  ```
- Produces (`edit.ts`): `repeatEntities(doc, ids, center, count, sweep = 360): EntityId[][]`, `translateEntities(doc, ids, from, to, count, spacing: Spacing): EntityId[][]`, `copyAlongPath(doc, ids, along, count): EntityId[][]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-repeat-modes.unit.spec.ts`:

```ts
// tests/unit/sketch-repeat-modes.unit.spec.ts
// Pen stage 8: Repeat's modes, pure — radial with a sweep, linear (live by
// translatedFrom, Step or Span), along a path (placed once, not tied), fills
// carried, the preview drawing exactly what the copies draw, and speed on a
// symmetric grid and one connected drawing.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addCircle, repeatEntities, translateEntities, copyAlongPath } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { toggleFillAt, fillState } from '~/lib/sketch/fills'
import { radialAngles, linearFactors, selectionCentre, alongPoints, radialPlacements, linearPlacements, copiesPreviewD } from '~/lib/sketch/repeatModes'
import { gear, rectGrid, squarePath } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const allHold = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-7)
const onlyThese = (d: SketchDoc, ids: EntityId[]): SketchDoc => {
  const keep = new Set(ids)
  return { entities: d.entities.filter(e => keep.has(e.id) || e.kind === 'point'), constraints: [] }
}

describe('placements', () => {
  it('radial angles: the full turn evenly, or 0 to the sweep inclusive; linear factors', () => {
    expect(radialAngles(6)).toEqual([60, 120, 180, 240, 300])
    expect(radialAngles(4, 90)).toEqual([30, 60, 90])
    expect(radialAngles(1)).toEqual([]); expect(radialAngles(65)).toEqual([]); expect(radialAngles(3, 0)).toEqual([])
    expect(linearFactors(4, 'step')).toEqual([1, 2, 3])
    expect(linearFactors(3, 'span')).toEqual([0.5, 1])
  })
  it('the selection’s centre: the box round its points, a circle by its full extent', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 2)
    const c = addCircle(d, addPoint(d, 10, 0), 1)
    expect(selectionCentre(d, [path])).toEqual({ x: 1, y: 1 })
    expect(selectionCentre(d, [path, c])).toEqual({ x: 5.5, y: 0.5 })
  })
})

describe('radial with a sweep', () => {
  it('four copies over 90°: at 30°, 60°, 90° — and the default sweep is today’s', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0, { fixed: true }), a = addPoint(d, 1, 0), b = addPoint(d, 2, 0)
    const l = addLine(d, a, b)
    const made = repeatEntities(d, [l], ctr, 4, 90)
    expect(made).toHaveLength(3)
    expect(d.constraints.filter(c => c.kind === 'rotatedFrom').map(c => c.value)).toEqual([30, 30, 60, 60, 90, 90])
    const d2 = doc()
    const c2 = addPoint(d2, 0, 0, { fixed: true }), l2 = addLine(d2, addPoint(d2, 1, 0), addPoint(d2, 2, 0))
    repeatEntities(d2, [l2], c2, 6)
    expect(d2.constraints.filter(c => c.kind === 'rotatedFrom').map(c => c.value)).toEqual([60, 60, 120, 120, 180, 180, 240, 240, 300, 300])
  })
})

describe('linear', () => {
  it('Step: copies one step apart, tied by translatedFrom; dragging the guide’s end moves them', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 1)
    const from = addPoint(d, 0.5, 0.5, { construction: true, fixed: true }), to = addPoint(d, 2.5, 0.5, { construction: true })
    addLine(d, from, to, { construction: true })
    const made = translateEntities(d, [path], from, to, 3, 'step')
    expect(made).toHaveLength(2)
    const tf = d.constraints.filter(c => c.kind === 'translatedFrom')
    expect(tf.map(c => c.value)).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    expect(allHold(d)).toBe(true)
    const copyOfFirst = (k: number) => P(d, tf.filter(c => c.refs[1] === pts[0])[k]!.refs[0]!)
    expect([copyOfFirst(1).x, copyOfFirst(1).y]).toEqual([4, 0])
    expect(solve(d, { drag: { point: to, x: 0.5, y: 3.5 } }).converged).toBe(true)
    expect(copyOfFirst(1).x).toBeCloseTo(0, 6); expect(copyOfFirst(1).y).toBeCloseTo(6, 6)
  })
  it('Span: the copies share out the span', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 1)
    const from = addPoint(d, 0, 0, { construction: true }), to = addPoint(d, 4, 0, { construction: true })
    translateEntities(d, [path], from, to, 3, 'span')
    expect([...new Set(d.constraints.filter(c => c.kind === 'translatedFrom').map(c => c.value))]).toEqual([0.5, 1])
  })
  it('refuses a bad count or a selection that uses the guide', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 1)
    const to = addPoint(d, 3, 0)
    expect(translateEntities(d, [path], pts[0]!, to, 3, 'step')).toEqual([])
    const from = addPoint(d, 0, 0)
    expect(translateEntities(d, [path], from, to, 1, 'step')).toEqual([])
    expect(translateEntities(d, [path], from, to, 65, 'step')).toEqual([])
  })
  it('a filled square’s copies are filled too', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 1)
    toggleFillAt(d, { x: 0.5, y: 0.5 }, 0)
    const from = addPoint(d, 0, 0, { construction: true }), to = addPoint(d, 2, 0, { construction: true })
    translateEntities(d, [path], from, to, 3, 'step')
    expect(fillState(d).filled).toHaveLength(3)
  })
})

describe('along a path', () => {
  it('an open line: the copies land at the middle and the end; nothing ties them', () => {
    const d = doc()
    const { path } = squarePath(d, -0.5, -0.5, 1)          // centred on (0, 0)
    const rail = addPath(d, [addPoint(d, 0, -5), addPoint(d, 10, -5)], [{ kind: 'line' }])
    expect(alongPoints(d, rail, 3)).toEqual([{ x: 5, y: -5 }, { x: 10, y: -5 }])
    const before = d.constraints.length
    const made = copyAlongPath(d, [path], rail, 3)
    expect(made).toHaveLength(2)
    expect(d.constraints.length).toBe(before)                // no rule ties a copy to the original
    const centres = made.map(ids => selectionCentre(d, ids.filter(id => P(d, id).kind === 'path')))
    expect(centres).toEqual([{ x: 5, y: -5 }, { x: 10, y: -5 }])
  })
  it('a circle: spread round it from angle 0; a Bézier path or a path being repeated is refused', () => {
    const d = doc()
    const { path } = squarePath(d, -0.5, -0.5, 1)
    const ring = addCircle(d, addPoint(d, 20, 0), 5)
    const pts = alongPoints(d, ring, 4)!.map(p => [Number(p.x.toFixed(9)), Number(p.y.toFixed(9))])
    expect(pts).toEqual([[20, 5], [15, 0], [20, -5]])
    const h = addPoint(d, 3, 9)
    const bz = addPath(d, [addPoint(d, 0, 8), addPoint(d, 6, 8)], [{ kind: 'cubic', h1: h, h2: null }])
    expect(copyAlongPath(d, [path], bz, 3)).toEqual([])
    expect(copyAlongPath(d, [path], path, 3)).toEqual([])
  })
})

describe('the preview draws exactly what the copies draw', () => {
  it('radial and linear', () => {
    const d = doc()
    const { path } = squarePath(d, 1, 0, 1)
    const ctr = addPoint(d, 0, 0, { fixed: true })
    const pv = copiesPreviewD(d, [path], radialPlacements({ x: 0, y: 0 }, 5, 360))
    const real = structuredClone(d)
    const made = repeatEntities(real, [path], ctr, 5)
    expect(pv).toBe(sketchPathData(onlyThese(real, made.flat())))
    const lv = copiesPreviewD(d, [path], linearPlacements({ x: 3, y: 1 }, 4, 'step'))
    const real2 = structuredClone(d)
    const f = addPoint(real2, 0, 0), t = addPoint(real2, 3, 1)
    const made2 = translateEntities(real2, [path], f, t, 4, 'step')
    expect(lv).toBe(sketchPathData(onlyThese(real2, made2.flat())))
  })
})

describe('speed (a symmetric grid, one connected drawing)', () => {
  it('a Repeat preview of 37 rectangles ×12 and along the 150-piece gear stay inside 16 ms', () => {
    const { doc: grid, paths } = rectGrid(37)
    copiesPreviewD(grid, paths, radialPlacements({ x: 6, y: 5 }, 12))
    let t = performance.now()
    for (let i = 0; i < 5; i++) copiesPreviewD(grid, paths, radialPlacements({ x: 6, y: 5 }, 12, 360 - i))
    expect((performance.now() - t) / 5).toBeLessThan(16)
    t = performance.now()
    for (let i = 0; i < 5; i++) copiesPreviewD(grid, paths, linearPlacements({ x: 0, y: 20 + i }, 12, 'step'))
    expect((performance.now() - t) / 5).toBeLessThan(16)
    const { doc: g, path } = gear(150)
    t = performance.now()
    for (let i = 0; i < 5; i++) alongPoints(g, path, 64)
    expect((performance.now() - t) / 5).toBeLessThan(16)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-repeat-modes.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/lib/sketch/repeatModes"` (and `translateEntities` / `copyAlongPath` not exported).

- [ ] **Step 3: `repeatModes.ts`** — create `frontend/app/lib/sketch/repeatModes.ts`:

```ts
// app/lib/sketch/repeatModes.ts
// Pen stage 8, Repeat's modes: where the copies go (radial angles, linear
// factors, points along a path) as placements shared by the real copies
// (edit.ts) and the panel's preview — which draws the source pieces moved,
// never building a copy (Global Constraints: speed). Pure; imports nothing
// from edit.ts (edit.ts imports this).
import type { SketchDoc, EntityId, SketchEntity, PointEntity } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { sketchPathData } from './sketchPath'

export type Placement = (p: Vec2) => Vec2
export type Spacing = 'step' | 'span'
const TAU = Math.PI * 2
const MAX = 64

const count2 = (count: number) => { const n = Math.round(count); return n >= 2 && n <= MAX ? n : 0 }

/** Copy k's angle in degrees, k = 1…count−1 (Ruling 13). */
export function radialAngles(count: number, sweep = 360): number[] {
  const n = count2(count)
  if (!n || !(sweep > 0)) return []
  const step = sweep >= 360 - 1e-9 ? 360 / n : sweep / (n - 1)
  return Array.from({ length: n - 1 }, (_, i) => (i + 1) * step)
}
/** Copy k's factor on the guide, k = 1…count−1 (Ruling 14). */
export function linearFactors(count: number, spacing: Spacing): number[] {
  const n = count2(count)
  return n ? Array.from({ length: n - 1 }, (_, i) => (spacing === 'step' ? i + 1 : (i + 1) / (n - 1))) : []
}
/** Turn about c by `deg` — the arithmetic repeatEntities' copies use. */
export function rotateAbout(c: Vec2, deg: number): Placement {
  const r = deg * Math.PI / 180, co = Math.cos(r), si = Math.sin(r)
  return p => { const dx = p.x - c.x, dy = p.y - c.y; return { x: c.x + co * dx - si * dy, y: c.y + si * dx + co * dy } }
}
/** Move by k·v — the arithmetic translateEntities' copies use. */
export function shiftBy(v: Vec2, k: number): Placement {
  return p => ({ x: p.x + k * v.x, y: p.y + k * v.y })
}

// every point id the ids stand for (edit.ts rawPointRefs, kept here so this
// module never imports edit.ts)
function closure(doc: SketchDoc, ids: readonly EntityId[]): EntityId[] {
  const out = new Set<EntityId>()
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind === 'point') out.add(e.id)
    else if (e.kind === 'line') { out.add(e.p1); out.add(e.p2) }
    else if (e.kind === 'circle') out.add(e.center)
    else {
      for (const a of e.anchors) out.add(a)
      for (const s of e.segments) {
        if (s.kind === 'arc') out.add(s.center)
        else if (s.kind === 'cubic') { if (s.h1) out.add(s.h1); if (s.h2) out.add(s.h2) }
      }
    }
  }
  return [...out].filter(id => !!getPoint(doc, id))
}

/** The middle of the box round the selection's points (a circle by its full extent). */
export function selectionCentre(doc: SketchDoc, ids: readonly EntityId[]): Vec2 | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const grow = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r) }
  for (const id of closure(doc, ids)) { const p = getPoint(doc, id)!; grow(p.x, p.y) }
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (e?.kind === 'circle') { const c = getPoint(doc, e.center); if (c) grow(c.x, c.y, e.r) }
  }
  return Number.isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : null
}

export interface PathWalk { length: number; closed: boolean; at(s: number): Vec2 }
type Leg = { kind: 'line'; a: Vec2; b: Vec2; len: number } | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number; len: number }

/** A path, a line or a circle walked by length (a circle from angle 0,
 *  counter-clockwise). Null for a Bézier piece, a missing id or no length. */
export function pathWalk(doc: SketchDoc, id: EntityId): PathWalk | null {
  const e = getEntity(doc, id)
  const P = (pid: EntityId): Vec2 | null => { const p = getPoint(doc, pid); return p ? { x: p.x, y: p.y } : null }
  const legs: Leg[] = []
  let closed = false
  if (e?.kind === 'line') {
    const a = P(e.p1), b = P(e.p2)
    if (!a || !b) return null
    legs.push({ kind: 'line', a, b, len: Math.hypot(b.x - a.x, b.y - a.y) })
  } else if (e?.kind === 'circle') {
    const c = P(e.center)
    if (!c) return null
    legs.push({ kind: 'arc', c, r: e.r, a0: 0, sweep: TAU, len: TAU * e.r })
    closed = true
  } else if (e?.kind === 'path') {
    closed = e.closed
    const n = e.anchors.length, count = e.closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      const s = e.segments[i]!, a = P(e.anchors[i]!), b = P(e.anchors[(i + 1) % n]!)
      if (!a || !b || s.kind === 'cubic') return null
      if (s.kind === 'line') { legs.push({ kind: 'line', a, b, len: Math.hypot(b.x - a.x, b.y - a.y) }); continue }
      const c = P(s.center)
      if (!c) return null
      const r = Math.hypot(a.x - c.x, a.y - c.y)
      const a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x)
      const ccw = (((a1 - a0) % TAU) + TAU) % TAU
      const sweep = s.sweep === 1 ? ccw : -(TAU - ccw)
      legs.push({ kind: 'arc', c, r, a0, sweep, len: r * Math.abs(sweep) })
    }
  } else return null
  const length = legs.reduce((t, l) => t + l.len, 0)
  if (!(length > 1e-12)) return null
  return {
    length, closed,
    at(s: number): Vec2 {
      let u = closed ? (((s % length) + length) % length) : Math.max(0, Math.min(length, s))
      for (const l of legs) {
        if (u <= l.len || l === legs[legs.length - 1]) {
          const f = l.len > 0 ? Math.min(1, u / l.len) : 0
          if (l.kind === 'line') return { x: l.a.x + f * (l.b.x - l.a.x), y: l.a.y + f * (l.b.y - l.a.y) }
          const ang = l.a0 + f * l.sweep
          return { x: l.c.x + l.r * Math.cos(ang), y: l.c.y + l.r * Math.sin(ang) }
        }
        u -= l.len
      }
      return { x: 0, y: 0 }
    },
  }
}

/** Where copies 1…count−1 land along `along` (Ruling 15); null when it can't be followed. */
export function alongPoints(doc: SketchDoc, along: EntityId, count: number): Vec2[] | null {
  const n = count2(count), w = pathWalk(doc, along)
  if (!n || !w) return null
  const step = w.closed ? w.length / n : w.length / (n - 1)
  return Array.from({ length: n - 1 }, (_, i) => w.at((i + 1) * step))
}

export function radialPlacements(c: Vec2, count: number, sweep = 360): Placement[] {
  return radialAngles(count, sweep).map(deg => rotateAbout(c, deg))
}
export function linearPlacements(vec: Vec2, count: number, spacing: Spacing): Placement[] {
  return linearFactors(count, spacing).map(k => shiftBy(vec, k))
}
export function alongPlacements(doc: SketchDoc, ids: readonly EntityId[], along: EntityId, count: number): Placement[] | null {
  if (ids.includes(along)) return null
  const at = alongPoints(doc, along, count), c = selectionCentre(doc, ids)
  if (!at || !c) return null
  return at.map(q => shiftBy({ x: q.x - c.x, y: q.y - c.y }, 1))
}

/** The selection's pieces drawn moved by each placement, as one outline —
 *  the Repeat preview (Ruling 17). Builds a small drawing of the selection
 *  alone and moves its points; never copies into `doc`. */
export function copiesPreviewD(doc: SketchDoc, ids: readonly EntityId[], placements: readonly Placement[]): string {
  const pts = closure(doc, ids).map(id => getPoint(doc, id)!) as PointEntity[]
  const pieces = ids.map(id => getEntity(doc, id)).filter((e): e is SketchEntity => !!e && e.kind !== 'point')
  const parts: string[] = []
  for (const move of placements) {
    const moved: SketchEntity[] = pts.map(p => ({ ...p, ...move(p) }))
    const d = sketchPathData({ entities: [...moved, ...pieces], constraints: [] })
    if (d) parts.push(d)
  }
  return parts.join(' ')
}
```

- [ ] **Step 4: `edit.ts`** —
  - import `import { radialAngles, linearFactors, rotateAbout, shiftBy, alongPoints, selectionCentre, type Spacing } from './repeatModes'`;
  - `repeatEntities(doc, ids, center, count, sweep = 360)`: replace `count = Math.round(count); if (count < 2 || count > 64) return []` with `const angles = radialAngles(count, sweep); if (!angles.length) return []`, loop `angles.forEach((angle) => { … })` instead of `for (let k = 1; k < count; k++)`, and compute every position with `const place = rotateAbout(ce, angle)`: `const q = place(p); const nid = addPoint(doc, q.x, q.y)`; the areas move with `moveAreas(srcAreas, place, …)`; `rad` stays `angle * Math.PI / 180` for `mapSeed`'s `turn`. (Positions are bit-for-bit what they were: `rotateAbout` does the same arithmetic in the same order.)
  - add after `repeatEntities`:
    ```ts
    /** Linear repeat (pen stage 8, Ruling 14): copies k = 1…count−1 at
     *  orig + f·(to − from), f = k (Step) or k/(count−1) (Span), each point tied
     *  by translatedFrom [copy, orig, from, to] value f. [] when nothing can be made. */
    export function translateEntities(doc: SketchDoc, ids: EntityId[], from: EntityId, to: EntityId, count: number, spacing: Spacing): EntityId[][] {
      const factors = linearFactors(count, spacing)
      const F = getPoint(doc, from), T = getPoint(doc, to)
      if (!factors.length || !F || !T) return []
      const pts = rawPointRefs(doc, ids)
      if (!pts.every(pid => !!getPoint(doc, pid)) || pts.includes(from) || pts.includes(to)) return []
      const carried = fillsWithin(doc, new Set([...pts, ...ids]), ids.flatMap(id => getEntity(doc, id) ?? []))
      const srcAreas = fillAreas(doc, carried, p => p)
      const vec = { x: T.x - F.x, y: T.y - F.y }
      const areas: FillArea[] = []
      const all: EntityId[][] = []
      for (const f of factors) {
        const place = shiftBy(vec, f)
        const map = new Map<EntityId, EntityId>()
        const created: EntityId[] = []
        for (const pid of pts) {
          const q = place(getPoint(doc, pid)!)
          const nid = addPoint(doc, q.x, q.y)
          map.set(pid, nid); created.push(nid)
          addConstraint(doc, 'translatedFrom', [nid, pid, from, to], f)
        }
        const ents = new Map<EntityId, EntityId>()
        created.push(...copyStructure(doc, ids, map, false, ents))
        copyClosureConstraints(doc, map)
        copyFills(doc, carried, map, ents, {})
        areas.push(...moveAreas(srcAreas, place, sd => mapSeed(sd, copiedId(map, ents))))
        all.push(created)
      }
      fillCopiedAreas(doc, areas)
      return all
    }

    /** Along a path (pen stage 8, Ruling 15): count − 1 copies moved so the
     *  selection's centre lands on points spread evenly along `along`; not tied
     *  to the original. [] for a Bézier path, a path being repeated, a bad count. */
    export function copyAlongPath(doc: SketchDoc, ids: EntityId[], along: EntityId, count: number): EntityId[][] {
      if (ids.includes(along)) return []
      const at = alongPoints(doc, along, count), c = selectionCentre(doc, ids)
      if (!at || !c) return []
      const pts = rawPointRefs(doc, ids)
      if (!pts.every(pid => !!getPoint(doc, pid))) return []
      const carried = fillsWithin(doc, new Set([...pts, ...ids]), ids.flatMap(id => getEntity(doc, id) ?? []))
      const srcAreas = fillAreas(doc, carried, p => p)
      const areas: FillArea[] = []
      const all: EntityId[][] = []
      for (const q of at) {
        const place = shiftBy({ x: q.x - c.x, y: q.y - c.y }, 1)
        const map = new Map<EntityId, EntityId>()
        const created: EntityId[] = []
        for (const pid of pts) {
          const r = place(getPoint(doc, pid)!)
          const nid = addPoint(doc, r.x, r.y, getPoint(doc, pid)!.fixed ? { fixed: true } : {})
          map.set(pid, nid); created.push(nid)
        }
        const ents = new Map<EntityId, EntityId>()
        created.push(...copyStructure(doc, ids, map, false, ents))
        copyClosureConstraints(doc, map)
        copyFills(doc, carried, map, ents, {})
        areas.push(...moveAreas(srcAreas, place, sd => mapSeed(sd, copiedId(map, ents))))
        all.push(created)
      }
      fillCopiedAreas(doc, areas)
      return all
    }
    ```
    (`copyStructure` pushes a path's raw entity without its arc rules; `copyClosureConstraints` then copies the arc rules with the other inner rules — the same as Repeat and Mirror.)

- [ ] **Step 5: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-repeat-modes.unit.spec.ts tests/unit/sketch-edit.unit.spec.ts tests/unit/sketch-substitution.unit.spec.ts tests/unit/sketch-fills-copies.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts`
Expected: PASS (the existing repeat tests prove the default sweep is unchanged). Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/(repeatModes|edit)\.ts'` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/sketch/repeatModes.ts frontend/app/lib/sketch/edit.ts frontend/tests/unit/sketch-repeat-modes.unit.spec.ts
git commit -m "feat(pen): repeat modes — radial sweep, live linear repeat (translatedFrom), copies along a path, preview without copies (stage 8)"
```

---
### Task 8: The Repeat… panel — Radial, Linear, Along a path — in every host's side panel

**Files:**
- Create: `frontend/app/composables/pen/penRepeat.ts`
- Create: `frontend/app/components/pen/PenRepeatPanel.vue`
- Modify: `frontend/app/components/pen/PenProperties.vue` (the panel takes the body while Repeat is open)
- Modify: `frontend/app/composables/pen/usePen.ts` (wiring; `repeatPrompt` opens the panel; its keys; menus, wheel and actions off while open; drops; `isCleanupBarFocused` covers the panel)
- Modify: `frontend/app/components/pen/PenOverlay.vue` (clicks pick the centre / path; the preview; keys)
- Modify: `frontend/app/components/pen/PenToolbar.vue` (tools off while open; the hint)
- Modify: `frontend/app/composables/pen/penTips.ts` (the Repeat card; the panel's cards)
- Modify: `frontend/app/pages/dev/sketch-draw.vue` (read-only `repeat()` hook)
- Modify: `frontend/tests/unit/pen-value-request.unit.spec.ts`, `frontend/tests/sketch-draw.spec.ts` (the old count prompt's two tests, rewritten)
- Test: `frontend/tests/unit/pen-repeat-panel.unit.spec.ts`

**Behaviour (Rulings 12–17; Global Constraints on previews and focus):**
- `repeatPrompt()` (the rules row's Repeat…, the menu's Repeat…, the wheel's S slice) settles live gestures, drops the corner / offset preview and opens the panel on the selection's shapes (none: "Select a shape first, then Repeat…"). Radial first, copies 6, sweep 360; the one point selected with the shapes is the centre.
- While open: the overlay's clicks go to `repeatPick` (Radial: a point → centre, empty space → a new centre there; Along a path: a piece → its path); the tool row, Clean up, undo / redo, Cancel / Done, the menus and the wheel are off; the pen owns the keys (Enter applies — or cancels on a focused Cancel — Esc and ⌘Z / ⌘Y cancel, Tab and Space on a focused control are left to the browser, every other plain key is swallowed). The toolbar's hint row says what to click ("Click the centre of the ring — a point, or empty space" / "Click the path to repeat along").
- The preview (drawing space, `data-repeat-preview`; the centre marked, `data-repeat-centre`) is recomputed on every panel change from the raw drawing with `copiesPreviewD`; the drawing is untouched. Apply (enabled only when the preview can be made) makes the copies on a clone (Radial: `repeatEntities`, a fixed centre point made at an empty spot; Linear: a dashed guide line from the selection's centre, one step or the whole span long, then `translateEntities`; Along: `copyAlongPath`), no solve (the copies are exact), one step, status "Repeated ×N". Cancel / Esc: "Repeat cancelled", drawing byte-identical.
- The panel (`PenRepeatPanel`, `data-repeat-panel`): heading "Repeat", kind radios (`data-repeat-mode`), Copies, then Radial: Centre (name / "New point" / "—"), Sweep °; Linear: Angle °, Step / Span radios (`data-repeat-spacing`), Distance; Along a path: Path (name / "—"); Cancel (`data-act="repeat-cancel"`), Apply (`data-act="repeat-apply"`). Buttons never take focus from a mouse press; a field blurs after its Enter; Apply commits any field being typed first.

**Interfaces:**
- Consumes (Task 7): `repeatEntities` (with sweep), `translateEntities`, `copyAlongPath`, `radialPlacements`, `linearPlacements`, `alongPlacements`, `copiesPreviewD`, `selectionCentre`, `Spacing`; `drawingDirForScreenAngle` (`sizes.ts`); `pointClosure`, `addPoint`, `addLine` (`edit.ts`); `pieceIndex`, `pieceNames`, `pieceKey`, `PieceRef` (`pieces.ts`); Task 4's `dropPreviews`.
- Produces (`penRepeat.ts`):
  ```ts
  export type RepeatMode = 'radial' | 'linear' | 'along'
  export type RepeatCentre = { id: EntityId } | { at: Vec2 } | null
  export type RepeatTarget = { kind: 'point'; id: EntityId } | { kind: 'piece'; ref: PieceRef } | { kind: 'empty'; at: Vec2 }
  export interface RepeatState {
    mode: RepeatMode; units: EntityId[]; count: number; sweep: number; centre: RepeatCentre
    angle: number; spacing: Spacing; distance: number; along: EntityId | null; alongPiece: PieceRef | null
    preview: { d: string; ok: boolean; centre: Vec2 | null }
  }
  export type RepeatPatch = Partial<Pick<RepeatState, 'mode' | 'count' | 'sweep' | 'angle' | 'spacing' | 'distance'>>
  export const REPEAT_NEED_SHAPE: string, REPEAT_HINT_CENTRE: string, REPEAT_HINT_PATH: string, REPEAT_BAD_PATH: string
  export function createPenRepeat(ctx: PenRepeatContext): { state, open, set, pick, apply, cancel, key, hint, names }
  ```
  `usePen` exports `repeat: ShallowRef<RepeatState | null>`, `repeatHint: ComputedRef<string | null>`, `repeatNames: ComputedRef<{ centre: string; path: string }>`, `setRepeat(patch)`, `repeatPick(target)`, `applyRepeatPanel(): boolean`, `cancelRepeat(): void`; `repeatPrompt(): boolean` (was async, asked for a count).

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/pen-repeat-panel.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 8, the Repeat… panel: opens on the selection's shapes, Radial
// (centre clicked, or the selected point), Linear (live, a dashed guide),
// Along a path (placed once); the preview never touches the drawing; Apply is
// one step; Cancel / Esc leave it byte-identical; the pen owns the keys while
// it is open; the panel takes Properties' place; its buttons never take focus
// from the mouse, so Space still pans.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { usePen, isCleanupBarFocused } from '~/composables/pen/usePen'
import { REPEAT_NEED_SHAPE, REPEAT_HINT_CENTRE, REPEAT_BAD_PATH } from '~/composables/pen/penRepeat'
import { squarePath } from './__fixtures__/penStage8'

vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
const { default: PenProperties } = await import('~/components/pen/PenProperties.vue')
const { default: PenToolbar } = await import('~/components/pen/PenToolbar.vue')
const { default: PenOverlay } = await import('~/components/pen/PenOverlay.vue')

const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null,
  preventDefault() {}, stopPropagation() {}, ...mods,
}) as unknown as KeyboardEvent
function setup() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const sq = squarePath(doc.value, 1, 1, 1)
  const rail = addPath(doc.value, [addPoint(doc.value, 0, -3), addPoint(doc.value, 10, -3)], [{ kind: 'line' }])
  let live = 0, changes = 0
  const pen = usePen({ doc, view: ref(DEV), onLiveChange: () => { live++ }, onChange: () => { changes++ } })
  return { doc, pen, ...sq, rail, live: () => live, changes: () => changes }
}
const json = (d: SketchDoc) => JSON.stringify(d)
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path' && !e.construction).length

describe('Repeat… opens the panel', () => {
  it('needs a shape; opens Radial with no centre, nothing changed, the hint says what to click', () => {
    const { pen, doc, path } = setup()
    expect(pen.repeatPrompt()).toBe(false)
    expect(pen.status.value).toBe(REPEAT_NEED_SHAPE)
    pen.pick(path)
    const before = json(doc.value)
    expect(pen.repeatPrompt()).toBe(true)
    expect(pen.repeat.value).toMatchObject({ mode: 'radial', count: 6, sweep: 360, centre: null })
    expect(pen.repeat.value!.preview.ok).toBe(false)
    expect(pen.repeatHint.value).toBe(REPEAT_HINT_CENTRE)
    expect(json(doc.value)).toBe(before)
    expect(pen.valueRequest.value).toBeNull()        // no count prompt any more
  })
  it('the point selected with the shapes is the centre', () => {
    const { pen, doc, path } = setup()
    const c = addPoint(doc.value, 0, 0)
    pen.pick(path); pen.pick(c, true)
    pen.repeatPrompt()
    expect(pen.repeat.value!.centre).toEqual({ id: c })
    expect(pen.repeat.value!.preview.ok).toBe(true)
    expect(pen.repeatNames.value.centre).toMatch(/^Point \d+$/)
  })
})

describe('Radial, Linear, Along a path', () => {
  it('Radial: an empty-space click picks the centre; Apply makes the ring as one step', () => {
    const { pen, doc, path, live, changes } = setup()
    pen.pick(path); pen.repeatPrompt()
    const before = json(doc.value), c0 = changes()
    pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    expect(pen.repeat.value!.preview.d).toMatch(/Z/)
    expect(pen.repeatNames.value.centre).toBe('New point')
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    expect(pen.applyRepeatPanel()).toBe(true)
    expect(pen.repeat.value).toBeNull()
    expect(paths(doc.value)).toBe(2 + 5)
    expect(doc.value.entities.some(e => e.kind === 'point' && e.fixed && e.x === 0 && e.y === 0)).toBe(true)
    expect(pen.status.value).toBe('Repeated ×6')
    expect(changes()).toBe(c0 + 1)
    pen.undo()
    expect(json(doc.value)).toBe(before)
  })
  it('Radial: a sweep under 360 spreads the copies over it', () => {
    const { pen, doc, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    pen.setRepeat({ count: 3, sweep: 90 })
    pen.applyRepeatPanel()
    expect([...new Set(doc.value.constraints.filter(c => c.kind === 'rotatedFrom').map(c => c.value))]).toEqual([45, 90])
  })
  it('Linear: copies to the right on screen, tied to a dashed guide', () => {
    const { pen, doc, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.setRepeat({ mode: 'linear', count: 3, angle: 0, spacing: 'step', distance: 2 })
    expect(pen.repeat.value!.preview.ok).toBe(true)
    pen.applyRepeatPanel()
    const tf = doc.value.constraints.filter(c => c.kind === 'translatedFrom')
    expect(tf).toHaveLength(8)
    const guide = doc.value.entities.find(e => e.kind === 'line' && e.construction) as any
    const from = doc.value.entities.find(e => e.id === guide.p1) as any, to = doc.value.entities.find(e => e.id === guide.p2) as any
    expect(to.x - from.x).toBeCloseTo(2, 9); expect(to.y - from.y).toBeCloseTo(0, 9)
  })
  it('Along a path: the path clicked; one of the repeated pieces is refused', () => {
    const { pen, doc, path, rail } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.setRepeat({ mode: 'along', count: 3 })
    pen.repeatPick({ kind: 'piece', ref: { kind: 'seg', pathId: path, segIndex: 0 } })
    expect(pen.status.value).toBe(REPEAT_BAD_PATH)
    pen.repeatPick({ kind: 'piece', ref: { kind: 'seg', pathId: rail, segIndex: 0 } })
    expect(pen.repeatNames.value.path).toMatch(/^Line \d+$/)
    pen.applyRepeatPanel()
    expect(paths(doc.value)).toBe(2 + 2)
    expect(doc.value.constraints.some(c => c.kind === 'translatedFrom' || c.kind === 'rotatedFrom')).toBe(false)
  })
})

describe('while it is open', () => {
  it('Esc cancels leaving the drawing byte-identical; ⌘Z closes it; Enter applies', () => {
    const { pen, doc, path, changes } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    const before = json(doc.value), c0 = changes()
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.repeat.value).toBeNull()
    expect(json(doc.value)).toBe(before)
    expect(changes()).toBe(c0)
    pen.pick(path); pen.repeatPrompt()
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.repeat.value).toBeNull()
    pen.pick(path); pen.repeatPrompt(); pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    expect(paths(doc.value)).toBe(7)
  })
  it('tool letters are swallowed, Tab is left to the browser, menus and the wheel stay shut', () => {
    const { pen, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    expect(pen.onKeydown(key('l'))).toBe(true)
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('Tab'))).toBe(false)
    pen.openMenu({ x: 10, y: 10 }, null)
    expect(pen.menu.value).toBeNull()
    expect(pen.openWheel({ x: 10, y: 10 })).toBe(false)
  })
})

describe('the panel, the toolbar and the overlay', () => {
  it('takes Properties’ place; kinds switch; a typed field commits and blurs; Apply never takes focus from the mouse', async () => {
    const { pen, path } = setup()
    const w = mount(PenProperties, { props: { pen }, attachTo: document.body })
    pen.pick(path); await nextTick()
    expect(w.find('[data-props-rules]').exists()).toBe(true)
    pen.repeatPrompt(); await nextTick()
    expect(w.find('[data-repeat-panel]').exists()).toBe(true)
    expect(w.find('[data-props-rules]').exists()).toBe(false)
    await w.find('[data-repeat-mode="linear"]').trigger('click')
    expect(pen.repeat.value!.mode).toBe('linear')
    expect(w.find('[data-repeat-field="distance"]').exists()).toBe(true)
    const input = w.find('[data-repeat-field="count"] input')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('4'); await input.trigger('keydown', { key: 'Enter' })
    expect(pen.repeat.value!.count).toBe(4)
    expect(document.activeElement).not.toBe(input.element)
    const apply = w.find('[data-act="repeat-apply"]')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    apply.element.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    ;(apply.element as HTMLElement).focus()
    expect(isCleanupBarFocused()).toBe(true)          // a keyboard-focused panel control keeps Space
    await apply.trigger('click')
    expect(pen.repeat.value).toBeNull()
    w.unmount()
  })
  it('the toolbar: tools off and the hint row asks for the centre', async () => {
    const { pen, path } = setup()
    const w = mount(PenToolbar, { props: { pen }, attachTo: document.body })
    pen.pick(path); pen.repeatPrompt(); await nextTick()
    expect(w.find('[data-tool="path"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-act="cleanup"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-repeat-hint]').text()).toBe(REPEAT_HINT_CENTRE)
    w.unmount()
  })
  it('the overlay: a point click picks the centre; the preview and the centre are drawn', async () => {
    const { pen, path, pts } = setup()
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.pick(path); pen.repeatPrompt(); await nextTick()
    await w.find(`circle[data-point="${pts[0]}"]`).trigger('pointerdown', { button: 0, pointerId: 1 })
    expect(pen.repeat.value!.centre).toEqual({ id: pts[0] })
    await nextTick()
    expect(w.find('[data-repeat-preview]').attributes('d')).toMatch(/Z/)
    expect(w.find('[data-repeat-centre]').exists()).toBe(true)
    w.unmount()
  })
})
```

Rewrite the old count-prompt tests:
- `frontend/tests/unit/pen-value-request.unit.spec.ts`: replace `it('Repeat… asks for a count and repeats on submit', …)` with
  ```ts
  it('Repeat… opens the Repeat panel — no count is asked', () => {
    const { doc, pen } = mk()
    pen.selectTool('circle'); pen.place(0, 0); pen.place(1, 0)
    pen.selectTool('select')
    const circle = doc.value.entities.find(e => e.kind === 'circle')!
    pen.pick(circle.id)
    expect(pen.repeatPrompt()).toBe(true)
    expect(pen.valueRequest.value).toBeNull()
    expect(pen.repeat.value?.mode).toBe('radial')
  })
  ```
  (the `window.prompt` source check below it stays and must still pass — the panel adds no prompt).
- `frontend/tests/sketch-draw.spec.ts`: replace the test `'inline value request: the real Repeat… button shows a toolbar input; typing a count and Enter arms the ring (no window.prompt)'` with
  ```ts
  test('the real Repeat… button opens the Repeat panel beside the canvas; a click on empty space picks the centre; Apply makes the ring', async ({ page }) => {
    await page.goto('/dev/sketch-draw')
    await page.waitForSelector('[data-ready]')
    await page.waitForFunction(() => !!(window as any).__sketchDraw)
    await page.evaluate(() => {
      const D = (window as any).__sketchDraw
      D.reset()
      D.setTool('circle'); D.place(11, 6); D.place(12, 6)
      const circle = D.doc.entities.find((e: any) => e.kind === 'circle')
      D.setTool('select')
      D.pick(circle.id)
    })
    await page.locator('[data-verb="repeat"]').click()
    await expect(page.locator('[data-repeat-panel]')).toBeVisible()
    await expect(page.locator('[data-testid="pen-value-input"]')).toHaveCount(0)
    const b = (await page.locator('svg[data-pen-overlay]').boundingBox())!
    await page.mouse.click(b.x + 40 + 34 * 8, b.y + 400 - 34 * 6)     // empty space at (8, 6)
    await expect(page.locator('[data-repeat-preview]')).toHaveCount(1)
    await page.locator('[data-act="repeat-apply"]').click()
    await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__sketchDraw.doc.entities.filter((e: any) => e.kind === 'circle').length)).toBe(6)
  })
  ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-repeat-panel.unit.spec.ts tests/unit/pen-value-request.unit.spec.ts`
Expected: FAIL — `Failed to resolve import "~/composables/pen/penRepeat"`; the rewritten value-request test finds a count prompt.

- [ ] **Step 3: `penRepeat.ts`** — create `frontend/app/composables/pen/penRepeat.ts`:

```ts
// app/composables/pen/penRepeat.ts
// Pen stage 8: the Repeat… panel's session (Rulings 12–17). The panel
// (PenRepeatPanel, inside PenProperties) edits it; the overlay's clicks pick
// its centre or path; the preview is drawn from the raw drawing with
// copiesPreviewD and never touches it; Apply is one step; while it is open
// the pen owns the keys (key()), as Clean up's preview does.
import { shallowRef, computed, toRaw, type Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import type { ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits } from '~/lib/sketch/tolerance'
import { cloneDoc } from '~/lib/sketch/clone'
import { addPoint, addLine, pointClosure, repeatEntities, translateEntities, copyAlongPath } from '~/lib/sketch/edit'
import { drawingDirForScreenAngle } from '~/lib/sketch/sizes'
import { pieceIndex, pieceNames, pieceKey, type PieceRef } from '~/lib/sketch/pieces'
import { radialPlacements, linearPlacements, alongPlacements, copiesPreviewD, selectionCentre, type Placement, type Spacing } from '~/lib/sketch/repeatModes'

export type RepeatMode = 'radial' | 'linear' | 'along'
export type RepeatCentre = { id: EntityId } | { at: Vec2 } | null
export type RepeatTarget = { kind: 'point'; id: EntityId } | { kind: 'piece'; ref: PieceRef } | { kind: 'empty'; at: Vec2 }
export interface RepeatState {
  mode: RepeatMode
  units: EntityId[]
  count: number
  sweep: number
  centre: RepeatCentre
  angle: number
  spacing: Spacing
  distance: number
  along: EntityId | null
  alongPiece: PieceRef | null
  preview: { d: string; ok: boolean; centre: Vec2 | null }
}
export type RepeatPatch = Partial<Pick<RepeatState, 'mode' | 'count' | 'sweep' | 'angle' | 'spacing' | 'distance'>>

export const REPEAT_NEED_SHAPE = 'Select a shape first, then Repeat…'
export const REPEAT_HINT_CENTRE = 'Click the centre of the ring — a point, or empty space'
export const REPEAT_HINT_PATH = 'Click the path to repeat along'
export const REPEAT_BAD_PATH = 'That path can’t be followed'
const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'])

export interface PenRepeatContext {
  doc: Ref<SketchDoc>
  view: Ref<ViewMatrix>
  status: Ref<string>
  selection: Ref<EntityId[]>
  commitHistory: () => void
  clearSel: () => void
  closeMenus: () => void
}

// the key's target (else the focused element) inside a control / the Cancel button
function focused(ev: KeyboardEvent, sel: string): boolean {
  const t = (ev.target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as Element | null
  return !!(t && typeof t.closest === 'function' && t.closest(sel))
}

export function createPenRepeat(ctx: PenRepeatContext) {
  const state = shallowRef<RepeatState | null>(null)
  const raw = () => toRaw(ctx.doc.value)
  const kindOf = (id: EntityId) => raw().entities.find(e => e.id === id)?.kind

  function centreAt(s: Omit<RepeatState, 'preview'>): Vec2 | null {
    const c = s.centre
    if (!c) return null
    if ('at' in c) return c.at
    const p = raw().entities.find(e => e.id === c.id)
    return p?.kind === 'point' ? { x: p.x, y: p.y } : null
  }
  function linearVec(s: Pick<RepeatState, 'angle' | 'distance'>): Vec2 | null {
    const dir = drawingDirForScreenAngle(ctx.view.value, s.angle)
    return dir ? { x: dir.x * s.distance, y: dir.y * s.distance } : null
  }
  function withPreview(s: Omit<RepeatState, 'preview'>): RepeatState {
    const d = raw()
    let placements: Placement[] | null = null
    let centre: Vec2 | null = null
    if (s.mode === 'radial') { centre = centreAt(s); placements = centre ? radialPlacements(centre, s.count, s.sweep) : null }
    else if (s.mode === 'linear') { const v = linearVec(s); placements = v ? linearPlacements(v, s.count, s.spacing) : null }
    else placements = s.along ? alongPlacements(d, s.units, s.along, s.count) : null
    const ok = !!placements?.length
    return { ...s, preview: { d: ok ? copiesPreviewD(d, s.units, placements!) : '', ok, centre } }
  }
  // the selection's width along the linear direction, × 1.25 (Ruling 14)
  function defaultDistance(units: EntityId[], angle: number): number {
    const d = raw(), dir = drawingDirForScreenAngle(ctx.view.value, angle)
    let lo = Infinity, hi = -Infinity
    for (const id of pointClosure(d, units)) {
      const p = d.entities.find(e => e.id === id)
      if (p?.kind !== 'point' || !dir) continue
      const t = p.x * dir.x + p.y * dir.y
      lo = Math.min(lo, t); hi = Math.max(hi, t)
    }
    for (const id of units) {
      const e = d.entities.find(x => x.id === id)
      if (e?.kind !== 'circle' || !dir) continue
      const c = d.entities.find(x => x.id === e.center)
      if (c?.kind === 'point') { const t = c.x * dir.x + c.y * dir.y; lo = Math.min(lo, t - e.r); hi = Math.max(hi, t + e.r) }
    }
    const w = hi - lo
    return Number.isFinite(w) && w > 0 ? 1.25 * w : pxToUnits(40, ctx.view.value)
  }

  function open(): boolean {
    const sel = ctx.selection.value
    const pts = sel.filter(id => kindOf(id) === 'point')
    const units = sel.filter(id => { const k = kindOf(id); return !!k && k !== 'point' })
    if (!units.length) { ctx.status.value = REPEAT_NEED_SHAPE; return false }
    ctx.closeMenus()
    state.value = withPreview({
      mode: 'radial', units, count: 6, sweep: 360, centre: pts.length === 1 ? { id: pts[0]! } : null,
      angle: 0, spacing: 'step', distance: defaultDistance(units, 0), along: null, alongPiece: null,
    })
    return true
  }
  function set(patch: RepeatPatch): void {
    const s = state.value
    if (!s) return
    const next = { ...s, ...patch }
    next.count = Number.isFinite(next.count) ? Math.min(64, Math.max(2, Math.round(next.count))) : s.count
    if (!(next.sweep > 0) || next.sweep > 360) next.sweep = s.sweep
    if (!(next.distance > 0)) next.distance = s.distance
    if (!Number.isFinite(next.angle)) next.angle = s.angle
    state.value = withPreview(next)
  }
  function pick(t: RepeatTarget): void {
    const s = state.value
    if (!s) return
    if (s.mode === 'radial') {
      if (t.kind === 'point') state.value = withPreview({ ...s, centre: { id: t.id } })
      else if (t.kind === 'empty') state.value = withPreview({ ...s, centre: { at: t.at } })
      else ctx.status.value = REPEAT_HINT_CENTRE
      return
    }
    if (s.mode !== 'along') return
    if (t.kind !== 'piece') { ctx.status.value = REPEAT_HINT_PATH; return }
    const along = t.ref.kind === 'seg' ? t.ref.pathId : t.ref.id
    if (s.units.includes(along) || !alongPlacements(raw(), s.units, along, s.count)) { ctx.status.value = REPEAT_BAD_PATH; return }
    state.value = withPreview({ ...s, along, alongPiece: t.ref })
  }
  function apply(): boolean {
    const s = state.value
    if (!s || !s.preview.ok) return false
    const work = cloneDoc(raw())
    let made: EntityId[][] = []
    if (s.mode === 'radial') {
      const c = s.centre!
      const centre = 'id' in c ? c.id : addPoint(work, c.at.x, c.at.y, { fixed: true })
      made = repeatEntities(work, s.units, centre, s.count, s.sweep)
    } else if (s.mode === 'linear') {
      const c = selectionCentre(work, s.units), v = linearVec(s)
      if (!c || !v) return false
      const from = addPoint(work, c.x, c.y, { construction: true })
      const to = addPoint(work, c.x + v.x, c.y + v.y, { construction: true })
      addLine(work, from, to, { construction: true })
      made = translateEntities(work, s.units, from, to, s.count, s.spacing)
    } else {
      made = copyAlongPath(work, s.units, s.along!, s.count)
    }
    if (!made.length) { ctx.status.value = 'Nothing to repeat'; return false }
    state.value = null
    ctx.doc.value = work
    ctx.clearSel()
    ctx.commitHistory()   // the copies are placed exactly: no solve
    ctx.status.value = `Repeated ×${s.count}`
    return true
  }
  function cancel(say = true): void {
    if (!state.value) return
    state.value = null
    if (say) ctx.status.value = 'Repeat cancelled'
  }
  // keys while the panel is open (Ruling 12)
  function key(ev: KeyboardEvent): boolean {
    if (ev.metaKey || ev.ctrlKey) {
      const k = ev.key.toLowerCase()
      if (k === 'z' || k === 'y') { cancel(); return true }
      return false
    }
    if (ev.key === 'Enter') { if (focused(ev, '[data-act="repeat-cancel"]')) cancel(); else apply(); return true }
    if (ev.key === 'Escape') { cancel(); return true }
    if (ev.key === 'Tab') return false
    if (ev.key === ' ' && focused(ev, 'button, input, select, textarea, [role="radio"]')) return false
    return !MODIFIERS.has(ev.key)
  }
  const hint = computed(() => {
    const s = state.value
    if (!s) return null
    if (s.mode === 'radial' && !s.centre) return REPEAT_HINT_CENTRE
    if (s.mode === 'along' && !s.along) return REPEAT_HINT_PATH
    return null
  })
  const names = computed(() => {
    const s = state.value
    if (!s) return { centre: '—', path: '—' }
    const d = raw(), n = pieceNames(d, pieceIndex(d))
    const centre = !s.centre ? '—' : 'at' in s.centre ? 'New point' : (n.get(`point:${s.centre.id}`) ?? '—')
    const path = s.alongPiece ? (n.get(pieceKey(s.alongPiece)) ?? '—') : '—'
    return { centre, path }
  })
  return { state, open, set, pick, apply, cancel, key, hint, names }
}
```

- [ ] **Step 4: Wire into `usePen.ts`** —
  - import `createPenRepeat` and `type RepeatPatch, type RepeatTarget` from `./penRepeat`; after `penOffset`:
    ```ts
    // --- the Repeat… panel (pen stage 8): see penRepeat.ts
    const penRepeat = createPenRepeat({ doc, view: opts.view, status, selection, commitHistory, clearSel: () => { clearSel(); clearSegSel() }, closeMenus })
    const repeat = penRepeat.state, repeatHint = penRepeat.hint, repeatNames = penRepeat.names
    function setRepeat(patch: RepeatPatch): void { penRepeat.set(patch) }
    function repeatPick(t: RepeatTarget): void { penRepeat.pick(t) }
    function applyRepeatPanel(): boolean { return penRepeat.apply() }
    function cancelRepeat(): void { penRepeat.cancel() }
    ```
  - replace the async `repeatPrompt` with:
    ```ts
    // Repeat… (rules row, menu, wheel): opens the Repeat panel on the
    // selection's shapes (pen stage 8, Ruling 12) — no count is asked
    function repeatPrompt(): boolean {
      closeMenus()
      if (cleanup.value || repeat.value) return false
      settleLive()
      dropPreviews()
      return penRepeat.open()
    }
    ```
    (keep `doRepeat`, `armRepeat`, `applyRepeat` — the test hooks);
  - `dropPreviews()` additionally calls `penRepeat.cancel(false)` — but only from the places listed in Task 4 (it is called inside `repeatPrompt` before `open()`, so the panel it opens is never dropped by itself);
  - `onKeydown`, right after the Clean up block:
    ```ts
    // the Repeat panel owns the keys while it is open (penRepeat.key)
    if (repeat.value) {
      const handled = penRepeat.key(ev)
      if (handled) { ev.preventDefault(); ev.stopPropagation() }
      return handled
    }
    ```
  - `openMenu`: `if (cleanup.value || repeat.value) return`; `openWheel`: `if (cleanup.value || repeat.value) return false`; `runKeyAction`, `runAction`: add `|| repeat.value` to their `cleanup.value` refusals; `startCleanup`: `if (!cleanupAllowed || cleanup.value || repeat.value) return`.
  - `isCleanupBarFocused()`: `return !!el?.closest?.('[data-cleanup-bar], [data-repeat-panel]')` and extend its comment: "…or inside the Repeat panel (pen stage 8) — its buttons never take focus from a mouse press, so a focused one got there by keyboard".
  - return object: `repeat, repeatHint, repeatNames, setRepeat, repeatPick, applyRepeatPanel, cancelRepeat,` under the stage-8 comment (`repeatPrompt` is already exported).

- [ ] **Step 5: `PenRepeatPanel.vue`** — create `frontend/app/components/pen/PenRepeatPanel.vue`:

```vue
<!-- app/components/pen/PenRepeatPanel.vue -->
<script setup lang="ts">
// The Repeat… panel (pen stage 8, Rulings 12–16). PenProperties shows it in
// its place while Repeat is open, so each host shows it in its own side
// panel with no change of its own. Buttons never take focus from a mouse
// press (mousedown.prevent): Space keeps panning after a click, and a
// focused button got there by keyboard (isCleanupBarFocused covers this
// panel). A field blurs after its Enter for the same reason; Apply commits
// a field still being typed first. Hints live in the cards, not here.
import { ref } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import type { RepeatMode } from '~/composables/pen/penRepeat'
import PenTipCard from '~/components/pen/PenTipCard.vue'
import PenNumberInput from '~/components/pen/PenNumberInput.vue'

const props = defineProps<{ pen: Pen }>()
const { repeat, repeatNames, setRepeat, applyRepeatPanel, cancelRepeat } = props.pen
const MODES: { id: RepeatMode; label: string }[] = [
  { id: 'radial', label: 'Radial' }, { id: 'linear', label: 'Linear' }, { id: 'along', label: 'Along a path' },
]
// one ref per field (several same-named refs outside a v-for keep only the last)
type Field = InstanceType<typeof PenNumberInput> | null
const countField = ref<Field>(null), sweepField = ref<Field>(null), angleField = ref<Field>(null), distanceField = ref<Field>(null)
function blurField(): void {
  const a = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  if (a?.closest?.('[data-repeat-panel]')) a.blur()
}
function submit(patch: Parameters<typeof setRepeat>[0]): void { setRepeat(patch); blurField() }
function apply(): void {
  for (const f of [countField.value, sweepField.value, angleField.value, distanceField.value]) f?.commit()
  applyRepeatPanel()
}
</script>

<template>
  <div v-if="repeat" class="repeat" data-repeat-panel role="group" aria-label="Repeat">
    <div class="head">Repeat</div>
    <div class="seg" role="radiogroup" aria-label="Kind">
      <PenTipCard v-for="m in MODES" :id="`repeat-${m.id}`" :key="m.id" side="left">
        <button type="button" class="seg-btn" role="radio" :data-repeat-mode="m.id" :aria-checked="repeat.mode === m.id"
                @mousedown.prevent @click="setRepeat({ mode: m.id })">{{ m.label }}</button>
      </PenTipCard>
    </div>

    <div class="row" data-repeat-field="count">
      <span class="name">Copies</span>
      <PenNumberInput ref="countField" :value="repeat.count" :min="2" :revert-on-blur="false" aria-label="Copies" @submit="n => submit({ count: n })" />
    </div>

    <template v-if="repeat.mode === 'radial'">
      <div class="row" data-repeat-field="centre"><span class="name">Centre</span><span class="value">{{ repeatNames.centre }}</span></div>
      <div class="row" data-repeat-field="sweep">
        <span class="name">Sweep</span>
        <span class="field"><PenNumberInput ref="sweepField" :value="repeat.sweep" :revert-on-blur="false" aria-label="Sweep" @submit="n => submit({ sweep: n })" /><span class="unit">°</span></span>
      </div>
    </template>

    <template v-else-if="repeat.mode === 'linear'">
      <div class="row" data-repeat-field="angle">
        <span class="name">Angle</span>
        <span class="field"><PenNumberInput ref="angleField" :value="repeat.angle" :revert-on-blur="false" aria-label="Angle" @submit="n => submit({ angle: n })" /><span class="unit">°</span></span>
      </div>
      <PenTipCard id="repeat-spacing" side="left">
        <div class="seg" role="radiogroup" aria-label="Spacing">
          <button v-for="sp in (['step', 'span'] as const)" :key="sp" type="button" class="seg-btn" role="radio" :data-repeat-spacing="sp"
                  :aria-checked="repeat.spacing === sp" @mousedown.prevent @click="setRepeat({ spacing: sp })">{{ sp === 'step' ? 'Step' : 'Span' }}</button>
        </div>
      </PenTipCard>
      <div class="row" data-repeat-field="distance">
        <span class="name">Distance</span>
        <PenNumberInput ref="distanceField" :value="repeat.distance" :revert-on-blur="false" aria-label="Distance" @submit="n => submit({ distance: n })" />
      </div>
    </template>

    <template v-else>
      <div class="row" data-repeat-field="path"><span class="name">Path</span><span class="value">{{ repeatNames.path }}</span></div>
    </template>

    <div class="actions">
      <PenTipCard id="repeat-cancel" side="left">
        <button type="button" class="btn" data-act="repeat-cancel" @mousedown.prevent @click="cancelRepeat()">Cancel</button>
      </PenTipCard>
      <PenTipCard id="repeat-apply" side="left">
        <button type="button" class="btn primary" data-act="repeat-apply" :disabled="!repeat.preview.ok" @mousedown.prevent @click="apply()">Apply</button>
      </PenTipCard>
    </div>
  </div>
</template>

<style scoped>
.repeat { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.head { font-weight: 600; font-size: 12.5px; color: #fff; }
.seg { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); }
.seg-btn {
  flex: 1 1 auto; height: 24px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent;
  color: rgba(255, 255, 255, 0.7); font: 500 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; white-space: nowrap;
}
.seg-btn[aria-checked='true'] { background: #fff; color: #111; }
.seg-btn:hover:not([aria-checked='true']) { background: rgba(255, 255, 255, 0.08); }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { flex: 1; min-width: 0; color: rgba(255, 255, 255, 0.55); }
.value { color: rgba(255, 255, 255, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.field { display: inline-flex; align-items: center; gap: 2px; }
.unit { width: 8px; color: rgba(255, 255, 255, 0.45); }
.actions { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.btn {
  height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2); background: transparent;
  color: rgba(255, 255, 255, 0.85); font: 500 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
}
.btn.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
.btn:disabled { opacity: 0.4; cursor: default; }
</style>
```

- [ ] **Step 6: `PenProperties.vue`** — import `PenRepeatPanel from '~/components/pen/PenRepeatPanel.vue'`, add `repeat` to the destructured pen, and inside the root `<div v-bind="$attrs" data-pen-properties …>` render `<PenRepeatPanel v-if="repeat" :pen="pen" />` first and wrap everything else (heading, sizes, rules) in `<template v-else>`. Add to its header comment: "While Repeat… is open, the Repeat panel takes the body (pen stage 8)".

- [ ] **Step 7: `PenOverlay.vue`** — destructure `repeat: repeatSession, repeatPick`;
  - `handleKeydownEvent`: `if (cleanupSession.value || repeatSession.value) return props.pen.onKeydown(ev)`;
  - `onPointerDownSvg`, after `if (cleanupSession.value) return`: `if (repeatSession.value) { const w = drawingXY(ev); if (w) repeatPick({ kind: 'empty', at: w }); return }`;
  - `onPointerDownPoint`, before its `if (!props.active || … tool.value !== 'select') return`: `if (repeatSession.value) { if (props.active && ev.button === 0 && !isCtrlContextClick(ev)) { repeatPick({ kind: 'point', id }); ev.stopPropagation() } return }`;
  - `onSegmentPointerDown`, the same place: `if (repeatSession.value) { if (props.active && ev.button === 0 && !isCtrlContextClick(ev)) { repeatPick({ kind: 'piece', ref: { kind: 'seg', pathId, segIndex } }); ev.stopPropagation() } return }`;
  - `onEntityPointerDown`, after `if (cleanupSession.value) return`: `if (repeatSession.value) { const k = entityKind(id); if (k === 'line' || k === 'circle') repeatPick({ kind: 'piece', ref: { kind: k, id } }); ev.stopPropagation(); return }`;
  - `onPointerMove`: `if (cleanupSession.value || repeatSession.value) return`;
  - script: `const repeatCentreScreen = computed(() => (repeatSession.value?.preview.centre ? toScreen(repeatSession.value.preview.centre) : null))`;
  - template, beside the offset preview:
    ```html
    <g v-if="repeatSession && repeatSession.preview.d" :transform="svgTransform" pointer-events="none">
      <path :d="repeatSession.preview.d" fill="none" stroke="#6366f1" stroke-width="1.5" opacity="0.85"
            vector-effect="non-scaling-stroke" data-repeat-preview />
    </g>
    <g v-if="repeatCentreScreen" pointer-events="none" data-repeat-centre>
      <circle :cx="repeatCentreScreen.x" :cy="repeatCentreScreen.y" r="6" fill="none" stroke="#6366f1" stroke-width="1.5" />
      <path :d="`M ${repeatCentreScreen.x - 9} ${repeatCentreScreen.y} H ${repeatCentreScreen.x + 9} M ${repeatCentreScreen.x} ${repeatCentreScreen.y - 9} V ${repeatCentreScreen.y + 9}`"
            stroke="#6366f1" stroke-width="1.5" />
    </g>
    ```

- [ ] **Step 8: `PenToolbar.vue`, `penTips.ts`, page hook** —
  - `PenToolbar.vue`: destructure `repeat, repeatHint`; `const previewing = computed(() => !!cleanup.value || !!repeat.value)`; the Clean up button gets `:disabled="!!repeat"`; in the hint row, after the `cleanup-bar` branch: `<div v-else-if="repeatHint" data-repeat-hint class="hint">{{ repeatHint }}</div>`. (The `watch(previewing, …)` blur stays right for both previews.)
  - `penTips.ts`: `repeat.caption` becomes `'Repeats the selection round a centre, in a row, or along a path. Set it up in the panel; the copies show first and are made when you apply.'`, and add (the panel's cards):
    ```ts
    'repeat-radial': { name: 'Radial',
      caption: 'Copies round a centre: click a point, or empty space for a new one. A sweep under 360° spreads them over part of the turn.' },
    'repeat-linear': { name: 'Linear',
      caption: 'Copies in a row at an angle. They follow a dashed guide: drag its end later to change the gap or the angle.' },
    'repeat-along': { name: 'Along a path',
      caption: 'Copies spread evenly along a path you click, from its start. They are placed once and don’t follow later changes.' },
    'repeat-spacing': { name: 'Step or span',
      caption: 'Step: the distance from one copy to the next. Span: the distance from the original to the last copy.' },
    'repeat-apply': { name: 'Apply', key: '↵', caption: 'Makes the copies, as one step.' },
    'repeat-cancel': { name: 'Cancel', key: 'Esc', caption: 'Closes Repeat and leaves the drawing as it was.' },
    ```
  - `sketch-draw.vue` hook after `offset`:
    ```ts
    repeat: () => {
      const s = pen.repeat.value
      return s ? { mode: s.mode, count: s.count, ok: s.preview.ok, centre: s.centre, along: s.along } : null
    },
    ```

- [ ] **Step 9: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-repeat-panel.unit.spec.ts tests/unit/pen-value-request.unit.spec.ts tests/unit/pen-properties.unit.spec.ts tests/unit/pen-menu-components.unit.spec.ts tests/unit/pen-overlay-menus.unit.spec.ts tests/unit/pen-actions.unit.spec.ts tests/unit/pen-toolbar-cleanup.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-overlay-host-keys.unit.spec.ts`
Expected: PASS. Then the rewritten browser test: `npx playwright test tests/sketch-draw.spec.ts -g "Repeat panel" --project=chromium` — PASS. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'composables/pen/(penRepeat|usePen|penTips)\.ts|components/pen/(PenRepeatPanel|PenProperties|PenOverlay|PenToolbar)\.vue|pages/dev/sketch-draw\.vue'` prints nothing new.

- [ ] **Step 10: Commit**

```bash
git add frontend/app/composables/pen/penRepeat.ts frontend/app/components/pen/PenRepeatPanel.vue frontend/app/components/pen/PenProperties.vue frontend/app/composables/pen/usePen.ts frontend/app/components/pen/PenOverlay.vue frontend/app/components/pen/PenToolbar.vue frontend/app/composables/pen/penTips.ts frontend/app/pages/dev/sketch-draw.vue frontend/tests/unit/pen-repeat-panel.unit.spec.ts frontend/tests/unit/pen-value-request.unit.spec.ts frontend/tests/sketch-draw.spec.ts
git commit -m "feat(pen): the Repeat… panel — radial with sweep, live linear, along a path — previewed, one step, in every host's side panel (stage 8)"
```

---
### Task 9: Menu entries, reasons, and the hosts' tool lists

**Files:**
- Modify: `frontend/app/composables/pen/penReasons.ts` (five reasons)
- Modify: `frontend/app/composables/pen/penActions.ts` (`PenActionHost`, three actions, `SELECTION_MENU`, header note)
- Modify: `frontend/app/composables/pen/usePen.ts` (`actionHost` gains `toolOffered`, `startTool`)
- Modify: `frontend/app/composables/frame/useFramePenSession.ts` (`FRAME_PEN_TOOLS`, `GUIDE_PEN_TOOLS`)
- Modify: `frontend/app/composables/geoshape/useShapePenSession.ts` (`SHAPE_PEN_TOOLS`)
- Test: `frontend/tests/unit/pen-actions.unit.spec.ts`, `frontend/tests/unit/frame-pen-session.unit.spec.ts`, `frontend/tests/unit/shape-pen-session.unit.spec.ts`

**Behaviour (Rulings 20, 21; Global Constraints — Hosts):** the selection menu's first group ends `…, Mirror…, Repeat…, Offset…, Round corner…, Chamfer…`, each with its key (E, F, H) and its card (`offset`, `round`, `chamfer`); a greyed one says why; one whose tool the host doesn't offer is left out. Picking one runs the same path as its key: live gestures settle, the tool is picked, and the selection (corners / the source) starts it. The Frame's new-drawing and reopened-layer pens and Shape Studio's pen offer all three tools; the Frame's text-guide pens offer Round corner and Chamfer (and `usePen` already drops Offset for any `openOnly` pen).

**Interfaces:**
- Consumes: `cornerCheck` (Task 3), `offsetSource` (Task 5), Task 4 / 6 tools.
- Produces: `PenActionHost.toolOffered(t: PenTool): boolean`, `PenActionHost.startTool(t: PenTool): void`; `REASON.corner`, `REASON.curveCorner`, `REASON.smoothCorner`, `REASON.path`, `REASON.curveOffset`; `ACTIONS.offset`, `ACTIONS['round-corner']`, `ACTIONS.chamfer`.

- [ ] **Step 1: Write the failing tests** —
  - `frontend/tests/unit/pen-actions.unit.spec.ts`: in the "1 line" test change the second group expectation to `['construction', 'flip-h', 'flip-v', 'mirror', 'repeat', 'offset', 'round-corner', 'chamfer']`, in "points: Fix and Dissolve join the actions" to `['fix', 'dissolve-point', 'construction', 'flip-h', 'flip-v', 'mirror', 'repeat', 'offset', 'round-corner', 'chamfer']`, the `SELECTION_MENU` literal (if the file asserts it) likewise, and add:
    ```ts
    describe('pen stage 8 — Offset…, Round corner…, Chamfer…', () => {
      const square = (d: SketchDoc) => {
        const ids = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([x, y]) => addPoint(d, x!, y!))
        return { ids, path: addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true) }
      }
      it('a square’s corner: Round corner… and Chamfer… act, and start their tool with it picked', () => {
        let s!: ReturnType<typeof square>
        const { pen } = mk(d => { s = square(d) })
        pen.pick(s.ids[0]!)
        pen.openMenu({ x: 0, y: 0 }, null)
        expect(item(pen, 'round-corner')).toMatchObject({ label: 'Round corner…', key: 'F', state: { ok: true } })
        expect(item(pen, 'chamfer')).toMatchObject({ label: 'Chamfer…', key: 'H', state: { ok: true } })
        expect(item(pen, 'offset')!.state).toEqual({ ok: false, reason: REASON.path })
        pen.runMenuItem('round-corner')
        expect(pen.tool.value).toBe('round')
        expect(pen.cornerView.value?.corners).toEqual([s.ids[0]])
      })
      it('says why: not a corner, a Bézier joint, a straight run', () => {
        let a = '', q = '', m = ''
        const { pen } = mk(d => {
          a = addPoint(d, 0, 0); q = addPoint(d, 4, 0); const r = addPoint(d, 8, 0), h = addPoint(d, 6, 2)
          addPath(d, [a, q, r], [{ kind: 'line' }, { kind: 'cubic', h1: h, h2: null }])
          const u = addPoint(d, 0, 9); m = addPoint(d, 4, 9); const w = addPoint(d, 8, 9)
          addPath(d, [u, m, w], [{ kind: 'line' }, { kind: 'line' }])
        })
        const reason = () => { pen.openMenu({ x: 0, y: 0 }, null); const r = (item(pen, 'round-corner')!.state as { reason: string }).reason; pen.closeMenu(); return r }
        pen.pick(a); expect(reason()).toBe(REASON.corner)        // an open end
        pen.pick(q); expect(reason()).toBe(REASON.curveCorner)
        pen.pick(m); expect(reason()).toBe(REASON.smoothCorner)
      })
      it('a path: Offset… acts and starts the tool with it; a Bézier path says why', () => {
        let s!: ReturnType<typeof square>, bz = ''
        const { pen } = mk(d => {
          s = square(d)
          const h = addPoint(d, 12, 3)
          bz = addPath(d, [addPoint(d, 10, 0), addPoint(d, 14, 0)], [{ kind: 'cubic', h1: h, h2: null }])
        })
        pen.pick(bz); pen.openMenu({ x: 0, y: 0 }, null)
        expect(item(pen, 'offset')!.state).toEqual({ ok: false, reason: REASON.curveOffset })
        pen.closeMenu(); pen.pick(s.path); pen.openMenu({ x: 0, y: 0 }, null)
        expect(item(pen, 'offset')).toMatchObject({ label: 'Offset…', key: 'E', state: { ok: true } })
        pen.runMenuItem('offset')
        expect(pen.tool.value).toBe('offset')
        expect(pen.offsetView.value?.chains).toHaveLength(1)
      })
      it('a host without the tools leaves them out; an open-only pen keeps the corners, not Offset', () => {
        let s!: ReturnType<typeof square>
        const bare = mk(d => { s = square(d) }, { tools: ['select', 'path'] })
        bare.pen.pick(s.path); bare.pen.openMenu({ x: 0, y: 0 }, null)
        const ids = bare.pen.menu.value!.groups.flat().map(i => i.id)
        for (const id of ['offset', 'round-corner', 'chamfer']) expect(ids).not.toContain(id)
        const guide = mk(d => { s = square(d) }, { openOnly: true, tools: ['select', 'path', 'curve', 'round', 'chamfer', 'offset'] })
        guide.pen.pick(s.path); guide.pen.openMenu({ x: 0, y: 0 }, null)
        const gids = guide.pen.menu.value!.groups.flat().map(i => i.id)
        expect(gids).toContain('round-corner'); expect(gids).toContain('chamfer'); expect(gids).not.toContain('offset')
      })
    })
    ```
    Give the file's `mk` a second parameter passed straight to `usePen`: `function mk(build: (d: SketchDoc) => void = () => {}, options?: PenOptions)` → `usePen({ doc, view: ref(DEV), options })` (import `type PenOptions` from `~/composables/pen/usePen`). Replace the test `'stage 8’s items are absent, not greyed'` (it asserted the opposite of this task) with `it('stage 8’s items follow Repeat… in the first group', () => { expect(SELECTION_MENU[0]!.slice(-4)).toEqual(['repeat', 'offset', 'round-corner', 'chamfer']) })`, and change the header comment's "stage 8's items absent" to "stage 8's Offset…, Round corner… and Chamfer… after Repeat…".
  - `frontend/tests/unit/frame-pen-session.unit.spec.ts` line 35: `['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve', 'fill', 'round', 'chamfer', 'offset']`; line 434: `['select', 'path', 'curve', 'trim', 'cut', 'dissolve', 'round', 'chamfer']`.
  - `frontend/tests/unit/shape-pen-session.unit.spec.ts`: add
    ```ts
    it('Shape Studio’s pen offers Round corner, Chamfer and Offset (pen stage 8)', () => {
      expect(SHAPE_PEN_TOOLS).toEqual(expect.arrayContaining(['round', 'chamfer', 'offset']))
    })
    ```
    importing `SHAPE_PEN_TOOLS` from `~/composables/geoshape/useShapePenSession`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-actions.unit.spec.ts tests/unit/frame-pen-session.unit.spec.ts tests/unit/shape-pen-session.unit.spec.ts`
Expected: FAIL — the menus lack the three entries; the hosts' lists lack the tools.

- [ ] **Step 3: Reasons** — in `frontend/app/composables/pen/penReasons.ts` add to `REASON`:

```ts
  // pen stage 8: Round corner / Chamfer / Offset
  corner: 'Select a corner where two pieces meet',
  curveCorner: 'Bézier curves can’t be rounded or cut',
  smoothCorner: 'This corner is already smooth',
  path: 'Select a path first',
  curveOffset: 'Bézier curves can’t be offset',
```

- [ ] **Step 4: Actions** — in `frontend/app/composables/pen/penActions.ts`:
  - replace the "Stage 8 extends it…" header paragraph with "Pen stage 8: Offset…, Round corner… and Chamfer… pick their tools with the selection as the start; hidden in a host that doesn't offer the tool (Ruling 20)."
  - imports: `import type { PenTool } from './usePen'`, `import { cornerCheck } from '~/lib/sketch/corners'`, `import { offsetSource } from '~/lib/sketch/offset'`;
  - `PenActionHost` gains
    ```ts
      /** pen stage 8: whether this host offers a tool (PenOptions.tools, resolved) */
      toolOffered(t: PenTool): boolean
      /** pen stage 8: pick a tool, the selection starting it (usePen selectTool) */
      startTool(t: PenTool): void
    ```
  - state helpers:
    ```ts
    // a selected point that is a corner lets Round corner / Chamfer act; else the plainest reason
    const cornerState = (h: PenActionHost): ActionState => {
      const pts = pointsOf(h)
      if (!pts.length) return no(REASON.corner)
      const doc = toRaw(h.doc.value)
      let why: string = REASON.corner
      for (const id of pts) {
        const c = cornerCheck(doc, id)
        if (c.ok) return OK
        if (c.why === 'curve') why = REASON.curveCorner
        else if (c.why === 'smooth' && why === REASON.corner) why = REASON.smoothCorner
      }
      return no(why)
    }
    const offsetState = (h: PenActionHost): ActionState => {
      const s = offsetSource(toRaw(h.doc.value), toRaw(h.selection.value), toRaw(h.selectedSegments.value))
      return s.ok ? OK : no(s.why === 'curve' ? REASON.curveOffset : REASON.path)
    }
    ```
  - `ACTIONS`, after `repeat`:
    ```ts
    offset: { label: 'Offset…', tip: 'offset', key: 'E', shown: h => h.toolOffered('offset'), state: offsetState, run: h => h.startTool('offset') },
    'round-corner': { label: 'Round corner…', tip: 'round', key: 'F', shown: h => h.toolOffered('round'), state: cornerState, run: h => h.startTool('round') },
    chamfer: { label: 'Chamfer…', tip: 'chamfer', key: 'H', shown: h => h.toolOffered('chamfer'), state: cornerState, run: h => h.startTool('chamfer') },
    ```
  - `SELECTION_MENU[0]`: `['fix', 'dissolve-point', 'construction', 'flip-h', 'flip-v', 'mirror', 'repeat', 'offset', 'round-corner', 'chamfer']`.
  - `usePen.ts` `actionHost`: add `toolOffered: isToolAllowed, startTool: (t: PenTool) => selectTool(t),`.

- [ ] **Step 5: Hosts** —
  - `useFramePenSession.ts`: `export const FRAME_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve', 'fill', 'round', 'chamfer', 'offset']`; `export const GUIDE_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'trim', 'cut', 'dissolve', 'round', 'chamfer']` and extend its comment: "…and Round corner / Chamfer, which reshape the one line (pen stage 8); no Offset — a second line the text can't follow".
  - `useShapePenSession.ts`: `export const SHAPE_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve', 'fill', 'round', 'chamfer', 'offset']`.

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-actions.unit.spec.ts tests/unit/frame-pen-session.unit.spec.ts tests/unit/shape-pen-session.unit.spec.ts tests/unit/pen-menu-components.unit.spec.ts tests/unit/pen-overlay-menus.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-frame.unit.spec.ts tests/unit/geoshape-pen-shape.unit.spec.ts`
Expected: PASS. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'composables/pen/(penActions|penReasons|usePen)\.ts|useFramePenSession\.ts|useShapePenSession\.ts'` prints nothing new.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/composables/pen/penReasons.ts frontend/app/composables/pen/penActions.ts frontend/app/composables/pen/usePen.ts frontend/app/composables/frame/useFramePenSession.ts frontend/app/composables/geoshape/useShapePenSession.ts frontend/tests/unit/pen-actions.unit.spec.ts frontend/tests/unit/frame-pen-session.unit.spec.ts frontend/tests/unit/shape-pen-session.unit.spec.ts
git commit -m "feat(pen): Offset…, Round corner…, Chamfer… in the right-click menu; the Frame, its text guides and Shape Studio offer the tools (stage 8)"
```

---

### Task 10: Real mouse, three hosts, laptop widths

**Files:**
- Create: `frontend/tests/pen-corners-offset-repeat.spec.ts`
- Modify: `frontend/tests/frame-pen.spec.ts` (a stage-8 block)
- Modify: `frontend/tests/shape-pen.spec.ts` (a stage-8 test)

**Behaviour:** the spec's Testing list for stage 8 with the real mouse and keyboard — round corner drag; chamfer; offset; linear repeat; along a path; radial with a sweep; Esc leaves it as it was; undo — plus Space still panning after a click in the Repeat panel, Enter on a keyboard-focused Apply applying without closing the pen, the three tool buttons and the panel on screen at 1280 and 1024 px in all three hosts, the Frame layer's `d` taking the round corner (and byte-identical after Esc mid-drag), the Frame's text guide offering Round corner and Chamfer but not Offset, and Shape Studio's Drawn shape taking an offset. `__sketchDraw` / `__compositorLayers` / `__shapeStudioLab` only set drawings up and read state.

**Interfaces:** consumes the page hooks `corner()`, `offset()`, `repeat()` (Tasks 4, 6, 8), `load`, `doc`, `getViewport`, and the data attributes of Tasks 4–8.

- [ ] **Step 1: Write the pen-page spec** — create `frontend/tests/pen-corners-offset-repeat.spec.ts`:

```ts
// tests/pen-corners-offset-repeat.spec.ts
// Pen stage 8 with the REAL mouse and keyboard on the pen page: F rounds a
// corner by dragging (one step, ⌘Z / ⇧⌘Z), too big stays red and Enter says
// why, H chamfers with a typed setback, Shift-click shares one radius, E
// offsets by dragging and the copy follows its source, typed with − for the
// other side; Repeat… from the right-click menu — Linear (then the guide's end
// dragged), Along a path, Radial with a sweep; Esc leaves every preview as it
// was; Space still pans after a click in the panel; Enter on a keyboard-focused
// Apply applies and keeps the pen; the buttons and the panel fit at laptop widths.
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
async function click(page: Page, x: number, y: number, mods: ('Shift' | 'Alt')[] = []) {
  const p = await at(page, x, y)
  for (const m of mods) await page.keyboard.down(m)
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up()
  for (const m of mods) await page.keyboard.up(m)
}
async function drag(page: Page, from: [number, number], to: [number, number], mid?: () => Promise<void>) {
  const a = await at(page, ...from), b = await at(page, ...to)
  await page.mouse.move(a.x, a.y); await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8)
    if (i === 5 && mid) await mid()
  }
  await page.mouse.up()
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const read = (page: Page, hook: 'corner' | 'offset' | 'repeat') => page.evaluate((h) => (window as any).__sketchDraw[h](), hook)
const status = (page: Page) => page.locator('[data-status]')
const load = (page: Page, raw: unknown) => page.evaluate((r) => (window as any).__sketchDraw.load(r), raw)
const SQUARE = {
  entities: [
    ...[['a', 1, 1], ['b', 5, 1], ['c', 5, 5], ['d', 1, 5]].map(([id, x, y]) => ({ id, kind: 'point', x, y })),
    { id: 'S', kind: 'path', anchors: ['a', 'b', 'c', 'd'], segments: [0, 1, 2, 3].map(() => ({ kind: 'line' })), closed: true },
  ],
  constraints: [],
}
const pathOf = (d: any, id = 'S') => d.entities.find((e: any) => e.id === id)
const arcs = (d: any) => d.entities.filter((e: any) => e.kind === 'path').flatMap((e: any) => e.segments.filter((s: any) => s.kind === 'arc'))

test('F: drag from a corner rounds it — the preview first, then one step; ⌘Z and ⇧⌘Z', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('f')
  await expect(page.locator('[data-tool="round"]')).toHaveAttribute('aria-pressed', 'true')
  const c = await at(page, 1, 1)
  await page.mouse.move(c.x + 2, c.y - 2)
  await expect(page.locator('[data-corner-hover]')).toHaveCount(1)
  await drag(page, [1, 1], [1.6, 1.6], async () => {
    await expect(page.locator('[data-corner-preview]')).toHaveAttribute('data-fits', 'yes')
    expect(JSON.stringify(await doc(page))).toBe(d0)                    // nothing written mid-drag
  })
  await expect.poll(async () => arcs(await doc(page)).length).toBe(1)
  const d1 = await doc(page)
  expect(d1.entities.find((e: any) => e.id === 'a').construction).toBe(true)   // the corner stays as a guide
  expect(pathOf(d1).anchors).toHaveLength(5)
  await expect(status(page)).toHaveText('Rounded')
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press(`${META}+Shift+z`)
  await expect.poll(async () => arcs(await doc(page)).length).toBe(1)
})

test('too big stays red; Enter says why; Esc leaves the drawing as it was', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('f')
  await click(page, 1, 1)
  await page.keyboard.type('9')
  await expect(page.locator('[data-corner-chip]')).toHaveText('9|')
  await expect(page.locator('[data-corner-bad]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Too big for this corner')
  await page.keyboard.press('Escape')
  expect(await read(page, 'corner')).toBeNull()
  expect(JSON.stringify(await doc(page))).toBe(d0)
  // Esc mid-drag too
  const a = await at(page, 1, 1)
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 20, a.y - 20, { steps: 4 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(JSON.stringify(await doc(page))).toBe(d0)
})

test('H: click a corner, type 1.5, Enter — equal setbacks; Shift-click shares one radius', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('h')
  await click(page, 5, 1)
  await page.keyboard.type('1.5'); await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Chamfered')
  const d = await doc(page)
  const P = (id: string) => d.entities.find((e: any) => e.id === id)
  const sq = pathOf(d), i = sq.anchors.length
  expect(i).toBe(5)
  const near = sq.anchors.map(P).filter((p: any) => Math.abs(Math.hypot(p.x - 5, p.y - 1) - 1.5) < 1e-6)
  expect(near).toHaveLength(2)
  await load(page, SQUARE)
  await page.keyboard.press('f')
  await click(page, 1, 1); await click(page, 5, 5, ['Shift'])
  expect((await read(page, 'corner')).corners).toEqual(['a', 'c'])
  await drag(page, [5, 5], [4.6, 4.6])
  await expect.poll(async () => arcs(await doc(page)).length).toBe(2)
  const eq = (await doc(page)).constraints.filter((k: any) => k.kind === 'equalDist' && k.refs[0] !== k.refs[2])
  expect(eq).toHaveLength(1)
})

test('E: drag from a side outward makes the outer copy; a source corner dragged, the copy follows', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('e')
  await drag(page, [3, 1], [3, 0])
  await expect.poll(async () => (await doc(page)).entities.filter((e: any) => e.kind === 'path').length).toBe(2)
  await expect(status(page)).toHaveText('Offset')
  const d1 = await doc(page)
  const copy = d1.entities.find((e: any) => e.kind === 'path' && e.id !== 'S')
  const P = (d: any, id: string) => d.entities.find((e: any) => e.id === id)
  const corner = copy.anchors.map((id: string) => P(d1, id)).find((p: any) => Math.abs(p.x - 6) < 1e-6 && Math.abs(p.y - 6) < 1e-6)
  expect(corner).toBeTruthy()
  await page.keyboard.press('v')
  // (dropped well away from the copy's own corner at (6, 6), so the drop never joins onto it)
  await drag(page, [5, 5], [5.3, 7])
  const d2 = await doc(page)
  const moved = P(d2, corner.id)
  expect(moved.x).toBeGreaterThan(6); expect(moved.y).toBeGreaterThan(7)
})

test('E: click, type 0.5, − for the inside, Enter', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('e')
  await click(page, 3, 1)
  await page.keyboard.type('0.5')
  await expect(page.locator('[data-offset-chip]')).toHaveText('0.5|')
  await page.keyboard.press('-')
  await expect(page.locator('[data-offset-chip]')).toHaveText('−0.5|')
  await page.keyboard.press('Enter')
  const d = await doc(page)
  expect(d.constraints.filter((k: any) => k.kind === 'offsetLine').every((k: any) => k.value === -0.5)).toBe(true)
})

async function repeatFromMenu(page: Page) {
  await page.keyboard.press('v')
  await click(page, 3, 1)                                        // selects the square
  const p = await at(page, 3, 1)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.locator('[data-menu-item="repeat"]').click()
  await expect(page.locator('[data-repeat-panel]')).toBeVisible()
}

test('Repeat… Linear: three in a row, the guide’s end dragged and they follow; one ⌘Z', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await repeatFromMenu(page)
  await page.locator('[data-repeat-mode="linear"]').click()
  const count = page.locator('[data-repeat-field="count"] input')
  await count.fill('3'); await count.press('Enter')
  const dist = page.locator('[data-repeat-field="distance"] input')
  await dist.fill('6'); await dist.press('Enter')
  await expect(page.locator('[data-repeat-preview]')).toHaveCount(1)
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.locator('[data-act="repeat-apply"]').click()
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  const d1 = await doc(page)
  expect(d1.entities.filter((e: any) => e.kind === 'path' && !e.construction)).toHaveLength(3)
  const guide = d1.entities.find((e: any) => e.kind === 'line' && e.construction)
  const to = d1.entities.find((e: any) => e.id === guide.p2)
  await drag(page, [to.x, to.y], [to.x, to.y + 2])
  const d2 = await doc(page)
  const tf = d2.constraints.filter((k: any) => k.kind === 'translatedFrom' && k.value === 2 && k.refs[1] === 'a')
  const far = d2.entities.find((e: any) => e.id === tf[0].refs[0])
  expect(far.y).toBeGreaterThan(4)                              // (1, 1) + 2·(6, 2)
  await page.keyboard.press(`${META}+z`)                         // the guide drag
  await page.keyboard.press(`${META}+z`)                         // the repeat
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
})

test('Repeat… Along a path and Radial with a sweep', async ({ page }) => {
  await open(page)
  await load(page, {
    entities: [...SQUARE.entities,
      { id: 'r0', kind: 'point', x: 0, y: -3 }, { id: 'r1', kind: 'point', x: 12, y: -3 },
      { id: 'R', kind: 'path', anchors: ['r0', 'r1'], segments: [{ kind: 'line' }], closed: false }],
    constraints: [],
  })
  await repeatFromMenu(page)
  await page.locator('[data-repeat-mode="along"]').click()
  await expect(page.locator('[data-repeat-hint]')).toHaveText('Click the path to repeat along')
  await click(page, 6, -3)
  await expect(page.locator('[data-repeat-field="path"]')).toContainText(/Line \d+/)
  await page.locator('[data-act="repeat-apply"]').click()
  expect((await doc(page)).entities.filter((e: any) => e.kind === 'path' && !e.construction)).toHaveLength(2 + 5)
  await load(page, SQUARE)
  await repeatFromMenu(page)
  await click(page, 8, 3)                                        // the centre: empty space
  const sweep = page.locator('[data-repeat-field="sweep"] input')
  await sweep.fill('90'); await sweep.press('Enter')
  const count = page.locator('[data-repeat-field="count"] input')
  await count.fill('3'); await count.press('Enter')
  await page.locator('[data-act="repeat-apply"]').click()
  const vals = [...new Set((await doc(page)).constraints.filter((k: any) => k.kind === 'rotatedFrom').map((k: any) => k.value))]
  expect(vals).toEqual([45, 90])
})

test('the panel: Esc leaves it as it was, Space still pans after a click in it, Enter on a focused Apply applies and keeps the pen', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await repeatFromMenu(page)
  await click(page, 8, 3)
  await page.locator('[data-repeat-mode="linear"]').click()     // a mouse click: the button takes no focus
  await page.locator('[data-repeat-mode="radial"]').click()
  const v0 = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  const m = await at(page, 10, 8)
  await page.mouse.move(m.x, m.y)
  await page.keyboard.down('Space')
  await page.mouse.down(); await page.mouse.move(m.x + 60, m.y + 30, { steps: 5 }); await page.mouse.up()
  await page.keyboard.up('Space')
  const v1 = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  expect(JSON.stringify(v1)).not.toBe(JSON.stringify(v0))       // it panned
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await repeatFromMenu(page)
  await click(page, 8, 3)
  await page.locator('[data-act="repeat-apply"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  await expect(page.locator('[data-tool="round"]')).toBeVisible()  // the pen is still open
  expect((await doc(page)).entities.filter((e: any) => e.kind === 'path').length).toBe(6)
})

for (const width of [1280, 1024]) {
  test(`the new buttons and the Repeat panel fit at ${width} px on the pen page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page); await load(page, SQUARE)
    for (const t of ['round', 'chamfer', 'offset']) {
      const b = (await page.locator(`[data-tool="${t}"]`).boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width); expect(b.y + b.height).toBeLessThanOrEqual(800)
    }
    await page.locator('[data-tool="offset"]').click()
    expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('offset')
    await repeatFromMenu(page)
    const p = (await page.locator('[data-act="repeat-apply"]').boundingBox())!
    expect(p.x + p.width).toBeLessThanOrEqual(width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
```

- [ ] **Step 2: Add the Frame checks** — append to `frontend/tests/frame-pen.spec.ts` (it already has `openPen`, `drawTriangle`, `layers`, `layerById`, `corners`, `sketchToScreen`, `drag`, `dblclickLayer`, `penToolbar`, `overlay`):

```ts
test.describe('Frame pen — pen stage 8', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
  })
  test('a triangle corner rounded by dragging reaches the layer; Esc mid-drag leaves the layer byte-identical', async ({ page }) => {
    const { tri, box } = await drawTriangle(page)
    await dblclickLayer(page, tri, box)
    await expect(penToolbar(page)).toBeVisible()
    const l0 = JSON.parse(JSON.stringify(await layerById(page, tri.id)))
    const c0 = sketchToScreen(l0, corners(l0)[0]!, box)
    const cs = corners(l0)
    const mid = sketchToScreen(l0, { x: (cs[0]!.x * 2 + cs[1]!.x + cs[2]!.x) / 4, y: (cs[0]!.y * 2 + cs[1]!.y + cs[2]!.y) / 4 }, box)
    await page.keyboard.press('f')
    // Esc mid-drag: nothing reaches the layer
    await page.mouse.move(c0.x, c0.y); await page.mouse.down()
    await page.mouse.move((c0.x + mid.x) / 2, (c0.y + mid.y) / 2, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await layerById(page, tri.id)).toEqual(l0)
    // a real drag: the layer's outline takes the arc
    await drag(page, c0, { x: (c0.x * 3 + mid.x) / 4, y: (c0.y * 3 + mid.y) / 4 })
    await expect.poll(async () => (await layerById(page, tri.id)).d).toMatch(/ A /)
    await page.keyboard.press('Enter')
    await expect(penToolbar(page)).toBeHidden()
    expect((await layerById(page, tri.id)).d).toMatch(/ A /)
  })
  test('the Repeat panel takes the inspector’s place, on screen at 1280 and 1024', async ({ page }) => {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/dev/frame-lab'); await page.waitForSelector('[data-ready]')
      const { tri, box } = await drawTriangle(page)
      await dblclickLayer(page, tri, box)
      for (const t of ['round', 'chamfer', 'offset']) {
        const b = (await page.locator(`[data-tool="${t}"]`).boundingBox())!
        expect(b.x + b.width).toBeLessThanOrEqual(width); expect(b.y + b.height).toBeLessThanOrEqual(800)
      }
      // select the drawing (a click on its first edge with Select), then right-click it
      const cs = corners(tri)
      const edge = sketchToScreen(tri, { x: (cs[0]!.x + cs[1]!.x) / 2, y: (cs[0]!.y + cs[1]!.y) / 2 }, box)
      await page.keyboard.press('v')
      await page.mouse.click(edge.x, edge.y)
      await page.mouse.click(edge.x, edge.y, { button: 'right' })
      await page.locator('[data-menu-item="repeat"]').click()
      const panel = page.locator('[data-testid="frame-pen-properties"] [data-repeat-panel]')
      await expect(panel).toBeVisible()
      const pb = (await page.locator('[data-act="repeat-apply"]').boundingBox())!
      expect(pb.x + pb.width).toBeLessThanOrEqual(width)
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
  })
  test('a text guide’s pen offers Round corner and Chamfer, not Offset', async ({ page }) => {
    // opened as the text-guide block above opens it: the "Plain text" layer, Follow a path → Drawn path, Draw a path
    await page.locator('[title="Double-click to rename"]', { hasText: /Plain text/ }).first().click()
    await page.locator('div:has(> .panel-label:text-is("Follow a path")) > select').first().selectOption('custom')
    await page.locator('button:has-text("Draw a path"), button:has-text("Edit the path")').first().click()
    await expect(penToolbar(page)).toBeVisible()
    await expect(page.locator('[data-tool="round"]')).toBeVisible()
    await expect(page.locator('[data-tool="chamfer"]')).toBeVisible()
    await expect(page.locator('[data-tool="offset"]')).toHaveCount(0)
  })
})
```

- [ ] **Step 3: Add the Shape Studio check** — append to `frontend/tests/shape-pen.spec.ts`:

```ts
test('pen stage 8: the Drawn shape takes an offset, and the new tools fit at 1024', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  for (const t of ['round', 'chamfer', 'offset']) {
    const b = (await page.locator(`[data-tool="${t}"]`).boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(1024); expect(b.y + b.height).toBeLessThanOrEqual(800)
  }
  const box = (await page.locator('[data-testid="shape-pen-overlay"]').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  // a closed triangle with the Pen
  await page.keyboard.press('p')
  for (const [dx, dy] of [[-70, 40], [70, 40], [0, -60], [-70, 40]]) {
    await page.mouse.move(cx + dx!, cy + dy!); await page.mouse.down(); await page.mouse.up()
  }
  await page.keyboard.press('e')
  await page.mouse.move(cx, cy + 40); await page.mouse.down()
  await page.mouse.move(cx, cy + 50, { steps: 3 }); await page.mouse.move(cx, cy + 60, { steps: 3 })
  await page.mouse.up()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="offset"]')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => {
    const m = (window as any).__shapeStudioLab.props.sailor_shapeStudio?.doc?.layers?.[0]?.mark
    return m?.sketch?.entities?.filter((e: any) => e.kind === 'path').length ?? 0
  }), { timeout: 15_000 }).toBe(2)
})
```

- [ ] **Step 4: Run the browser specs** (the shared :3002 server; never start one)

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/pen-corners-offset-repeat.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-menus.spec.ts tests/pen-fills.spec.ts tests/pen-tips.spec.ts --project=chromium`
Expected: PASS. If the server serves stale modules, `touch` the changed files and confirm with the `curl … | grep -c` check in Global Constraints before rerunning. A failure at 1024 px that pushes a tool button off screen in a host is a real layout bug: fix it in `PenToolbar.vue`'s styles (the row already wraps — check the host's container isn't `overflow: hidden` with a fixed height), never by shrinking the test.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/pen-corners-offset-repeat.spec.ts frontend/tests/frame-pen.spec.ts frontend/tests/shape-pen.spec.ts
git commit -m "test(pen): stage 8 with the real mouse — round corners, chamfer, offset, repeat modes, three hosts at laptop widths"
```

---

## Self-review (done while writing; kept for the executor)

- **Spec coverage.** Round corner (F) with drag / type, several corners with Equal, red when too big → Tasks 3, 4 (Rulings 5–8). Chamfer (H) with equal setbacks → Tasks 3, 4. Virtual sharp → Task 3 (Ruling 4). Offset (E), either side, lines to parallels, arcs on the same centre point, sharp corners, `offsetLine` / `offsetRadius`, live → Tasks 1, 5, 6. Repeat… panel in the host's side panel with Radial (centre on the canvas, copies, sweep), Linear (direction, step or total span, copies; live by `translatedFrom`), Along a path (not live), count including the original, Apply / Cancel → Tasks 1, 7, 8. Menu entries after Repeat… → Task 9. Testing section (residual + Jacobian checks, construction tests, real mouse for round corner / offset / linear repeat, host checks, 1280 / 1024) → Tasks 1–10. Out of scope respected: no live Along a path, no round offset corners, no Bézier in any of it.
- **Placeholder scan.** No step leaves code to be invented; where a test calls existing code (trim's exported names, the Frame lab's text-guide opening) the calls are the ones the code has today.
- **Type consistency.** `CornerKind`, `Corner`, `CornerSide` (Task 3) are what `penCorners.ts` (Task 4) and `penActions.ts` (Task 9) import; `OffsetChain` / `offsetSource` (Task 5) are what `penOffset.ts` (Task 6) and `penActions.ts` use; `Spacing`, placements and `copiesPreviewD` (Task 7) are what `penRepeat.ts` (Task 8) uses; `rulesHold` is exported by `penCorners.ts` and reused by `penOffset.ts`; `dropPreviews` (Task 4) grows in Tasks 6 and 8; `intersectCarriers` is exported by `corners.ts` for `offset.ts`.
