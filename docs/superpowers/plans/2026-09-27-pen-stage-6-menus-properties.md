# The pen, stage 6 — right-click menu, action wheel, properties panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-click on the drawing opens a list menu of what the selection can do (its rules, then the actions, each with its key; greyed items say why); a right-press-and-drag opens an 8-slice action wheel at the press point; Copy / Paste work inside the pen (pieces plus the rules among them); and a Properties panel shows the selection's sizes (typed with the pen's inline value field) and its rules (named, hover lights the pieces, × removes, + adds) — in the pen page, the Frame and Shape Studio.

**Architecture:** Three new pure modules in `lib/sketch/` — `pieces.ts` (piece names, which pieces a rule ties, rule names, a selection's rules and heading), `clipboard.ts` (copy out / paste in with fresh ids), `ruleCheck.ts` (Already true / Conflicts, by Jacobian rank and a trial solve) — plus `sizes.ts` (what the Properties panel measures and how a typed size moves the drawing). In the shared pen: `penReasons.ts` (the plain-words refusal reasons), `penClipboard.ts` (one clipboard for every pen on the page), `penActions.ts` (the one action registry the menu, the wheel and Properties read; stage 8 extends it), new verbs, menu and wheel state and keys in `usePen.ts` / `penKeys.ts`, and new components `PenContextMenu.vue`, `PenActionWheel.vue`, `PenNumberInput.vue` (the value row's field, shared), `PenProperties.vue`. `PenOverlay` turns right presses into the menu or the wheel and draws the hover highlight. Hosts only mount `PenProperties` (pen page beside the canvas, Frame in the right panel's body, Shape Studio in the left rail's place).

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, reka-ui tooltips (`PenTipCard`), vitest (`tests/unit/**/*.unit.spec.ts`, happy-dom for components), Playwright against the running :3002 dev server.

**Spec:** `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — sections "Shared ground" and "Stage 6" are binding; only Stage 6 is in scope. Read both before your task.

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
- UI copy: sentence case, plain words, no identifiers (glyphs such as ⌘C ⇧H ⌫ × are fine). Explanations live in the tooltip cards (`PEN_TIPS`), not as extra text in panels. Labels quote the user's own content (piece names, sizes), never a rule's internal name. The three refusal reasons are exactly "Already true", "Conflicts with another rule", "Doesn’t apply to this selection" (typographic apostrophe, like every `PEN_TIPS` string).
- Screen-px thresholds (the wheel's 12 px open distance, 24 px dead zone, the 16 px paste step) are screen pixels; drawing-unit tolerances go through `pxToUnits(px, view)` (`lib/sketch/tolerance.ts`), never a hard-coded drawing-unit number.
- **No new rule kinds, no new piece kinds.** Stage 6 writes only existing `ConstraintKind`s, and Copy / Paste re-point every copied rule's refs to the pasted ids (`insertPieces`), so stage-3 editing (`trim.ts` pairSlots / followPair / isTrivial, `edit.ts` deleteEntity) already handles everything it writes. Do not change `solve.ts`, `residuals.ts`, `jacobian.ts`, `trim.ts`, `edit.ts`, `tangency.ts` or anything under `lib/sketch/cleanup/`.
- Every gesture is one undo step: a paste, a typed size, a lock, a rule added or removed from any surface, a menu item, a wheel slice — `commitHistory()` once. Opening, moving over and closing the menu or the wheel, and hovering a rule, write no step.
- The pen's menu and wheel are `shallowRef`s that are **replaced** on every change (never mutated in place), like `pen.cleanup`, so component computeds follow them.
- **Renderless roots:** `PenToolbar` and `PenProperties` have a renderless `TooltipProvider` root, and `PenOverlay` becomes multi-root in this stage (the svg plus the teleported menu and wheel) — each uses `defineOptions({ inheritAttrs: false })` and binds `v-bind="$attrs"` on its real element, so a host's `class` / `data-testid` still lands.
- **Host keys:** the Frame (`CompositorModal.vue`, capture-phase listener, `keyboard="host"`) and Shape Studio (`ShapeStudioSurface.vue`) forward every key to `PenOverlay.onHostKeydown` while a pen session is open and stop it — so focused-element key handlers inside a menu never run there. The menu and wheel therefore take their keys through `pen.onKeydown`, like Clean up's bar. A text field is left to itself by every host (`isTypingInField`), so a field must `stopPropagation` its own Enter / Escape (Shape Studio's shell closes on a bubbling Escape).
- `:focus-visible` cannot tell mouse from keyboard inside capture listeners (stage 5 lesson): the menu's keyboard highlight is pen state (`menu.active` → `data-active`), never `:focus-visible`.
- **Host right-click:** until this stage the pen ignored right-click and a Mac ctrl-click in every host (`PenOverlay` `isCtrlContextClick`). Now a right press on the pen's svg is the pen's while a session is open; the svg keeps `@contextmenu.prevent`, and the Frame's own `onCanvasContextMenu` already `preventDefault`s and returns while `penSession` is set — so the Frame's image menu never also opens (keep it that way; do not touch that function).
- `CompositorModal.vue` is heavily edited by other sessions: make only the edits Task 10 lists and stage only those hunks (recipe in Task 10).
- Test pen layouts at 1280 and 1024 px wide — the toolbar, the menu and the Properties panel must not push anything off screen or add sideways scroll.
- Real-mouse checks use `page.mouse` (including `page.mouse.down({ button: 'right' })` → moves → `page.mouse.up({ button: 'right' })` for the wheel) / `page.keyboard` / `locator.click()`, never synthetic `dispatchEvent`. `window.__sketchDraw` hooks may only set up a drawing or read state.
- Unit tests: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run <files>`. Typecheck: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -E '<your files>'` — judged only on files you touched (the repo has a pre-existing error baseline). Browser specs: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test <spec files> --project=chromium`.
- Rulings made by this plan (where the spec left a detail open) are marked **Ruling:** and are binding for the implementer.

---

## Rulings (the whole list; each task repeats the ones it needs)

1. **One registry.** `composables/pen/penActions.ts` is the single source for the list menu, the wheel and Properties' + list: its rule entries are exactly `availableConstraints()` (the rules row's own list, id `rule:<tip ?? kind>`), each checked (Ruling 12); its actions are the `ACTIONS` table. The rules row in `PenToolbar` keeps reading `availableConstraints()` directly and keeps its stage 1–5 behaviour (no greying, no refusal), so its specs stay green; greying and refusals live in the menu, the wheel and Properties.
2. **Stage 8 items are absent, not greyed.** The selection menu is `SELECTION_MENU` (groups of action ids). Stage 8 adds `offset`, `round-corner`, `chamfer` to `ACTIONS` and inserts their ids into group 0 after `repeat`; until then nothing mentions them.
3. **Menu contents.** A selection: header (`selectionLabel`, e.g. "2 points", "1 arc", "3 selected") → the rules → [Fix (only when a point is selected), Dissolve (only when exactly one point is selected), Make guide X, Flip horizontal ⇧H, Flip vertical ⇧V, Mirror…, Repeat…] → [Copy ⌘C, Copy as SVG, Paste ⌘V] → [Delete ⌫], a line between groups. Empty space: no header, [Paste ⌘V, Select all ⌘A]. Greyed items stay in the list (`aria-disabled`), skipped by the arrow keys, and say why in their card.
4. **Right press.** In Select, a right press on an unselected piece selects it first (Option: just that segment); a press on a selected piece keeps the selection. On empty space in Select the selection is cleared when the menu opens (not when a wheel opens). In other tools the selection is left alone (the draw tools keep it empty, so the empty-space menu shows). A right press never finishes or drops a half-drawn path — it only settles the overlay's own live gesture (marquee, point drag, arc press).
5. **Wheel.** Opens once a right-drag has gone 12 screen px from the press, centred on the press point, only when something is selected (else nothing opens and the release does nothing). Eight 45° slices, dead zone 24 px, drawn radius 100 px; the release picks by direction even beyond the drawn radius; a release in the dead zone cancels; a greyed slice does nothing and puts its reason in the status. A note under the wheel names the slice under the pointer, or says why it is greyed. Layout = segment when the selection holds any piece that isn't a point (line, circle, path, Option-picked segment), else point. Rule slices find the rules-row option by label (every Tangent form lands on N; "Right angle" is not Perpendicular). The wheel is not clamped to the window (it must stay centred on the press). Slices are fixed (spec).
6. **Keys while open.** Menu: ↑/↓ (and Tab / ⇧Tab) move over enabled items, wrapping; Home / End; Enter runs the highlighted item; Escape closes; any other plain key is swallowed; a ⌘/Ctrl combo closes the menu and then acts as usual (⌘Z undoes). Space never runs an item (it is the hosts' pan key). Wheel: Escape cancels, every other plain key is swallowed.
7. **New keys** (not while typing; each only when it can act, otherwise the key is left to the host / browser): X Make guide, ⇧H Flip horizontal, ⇧V Flip vertical, ⌘C Copy, ⌘V Paste, ⌘A Select all. The overlay settles its live gesture before X / ⇧H / ⇧V like before a tool key.
8. **Clipboard.** The pen's own, module-level in `penClipboard.ts`, shared by every pen on the page for the page session (so a copy in the pen page, the Frame or Shape Studio pastes in any of them); it is not the system clipboard. Copy as SVG writes the system clipboard with `sketchPathData` of the selection — the format of the existing export (the pen page's Copy SVG button).
9. **Copy / Paste.** Copy takes the selected entities with their point closure, Option-picked segments as one-piece open paths, and every rule whose refs are all copied. Paste gives fresh ids and re-points refs; ⌘V offsets the copy 16 screen px down-right of where it was copied, +16 px for each further paste of the same copy; the menu's Paste centres the copy on the right-clicked point; a paste switches to Select, selects the pasted top-level pieces, and is one undo step. An open-only pen (a text guide) refuses a copy holding a circle or a closed path ("Only open lines can go here").
10. **Piece names.** Per-kind counters in drawing order: "Point n" (every point), "Line n" (line entities and straight path pieces share one count), "Arc n", "Circle n", "Curve n"; recomputed on every change, so a deletion renumbers later pieces.
11. **Rules list.** Every rule that ties a selected piece — a whole path counts its pieces and its points — except each arc's own equal-ends rule (`isArcInvariant`). Named by `ruleName` (joint tangent forms read "Tangent", a square corner "Right angle", an arc radius pin "Radius 2", a pinned point on an arc "On curve") then " — " and the tied pieces joined by " · ".
12. **Refusals.** "Doesn’t apply to this selection" when the selection can't make the rule (`ruleSpecFor` → null, or a wheel slice whose rule the rules row doesn't offer). "Already true" when an equivalent rule is there (`equivalentRuleKey`) or the others imply it (its Jacobian rows don't raise the rank over the part it touches, and a trial solve with it moves nothing). "Conflicts with another rule" when the rank doesn't rise but the trial solve would move things, the trial solve fails, or a line, arc or circle would collapse. A rule that asks for a value (Distance…, Radius…) is checked at its current measured value. Coincident is checked as the merge it is.
13. **Properties sizes.** Point: X, Y. Line (a line entity, a straight segment, or a one-piece straight path): Length, Angle. Arc (an arc segment or a one-piece arc path): Radius + lock, Length, Sweep. Circle: Radius + lock. Angle and Sweep in degrees; Angle as seen on screen, 0° pointing right, counter-clockwise positive, (−180, 180]. Typed Length / Angle / Sweep / an unlocked Radius are one-off moves (a drag solve, or a temporary radius rule removed after the solve), refused with status "That size can’t be kept with these rules" when the solve fails. The lock is the arc's `distance [centre, start]` pin (the chip's existing pin) / the circle's `radius` rule; a typed radius while locked updates that rule. Enter commits; Escape, or leaving the field without Enter, puts the shown value back. A fixed point's X / Y are disabled; a line whose ends are both fixed has Length and Angle disabled. More than one piece, or a whole multi-piece path: no sizes, the rules only.
14. **Where Properties sits.** Pen page: to the right of the canvas, 240 px wide. Frame: the right panel's body while a session is open — the Design / Motion / Layout tabs stay (a click on Motion still closes the pen, an existing spec). Shape Studio: the left rail's place — the rail is not rendered while the pen is open (it was locked anyway), and `tests/shape-pen.spec.ts` asserts Properties instead of the lock.
15. **Two points offer Horizontal and Vertical** (after Coincident and Distance…), in the rules row too — the spec's point layout needs them and `horizontal` / `vertical` already accept a point pair. `tests/unit/pen-weld.unit.spec.ts` line 190's expected list gains them.
16. **Where the menu and wheel render.** From `PenOverlay`, as siblings of its svg, each self-teleported to `<body>` (`position: fixed`, `z-index: 10040`, under the 10050 tip cards); a Teleport inside the svg would create SVG-namespace elements.
17. **Click-away.** A pointerdown outside the menu closes it; on the drawing (`[data-pen-overlay]`) a left / middle press is consumed (no marquee, no point), a right press goes through and opens a new menu there; presses elsewhere (toolbar, panels) go through. Scrolling, resizing and window blur close it.
18. **Cards.** Every menu item and every new Properties button has a `PenTipCard`; `PenTipCard` gains `reason` (the refusal, shown above the caption). Wheel slices have no cards — it is a gesture, the note under it says why.
19. **Clean up preview:** no menu or wheel opens; Properties is shown inert.
20. **`tests/frame-pen.spec.ts`** asserted that a right-click during the pen does nothing; the spec now makes it open the pen's menu. That test is updated to see the pen's menu, close it with Escape, and still assert the image menu never opens and nothing else changed.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/app/lib/sketch/pieces.ts` (new) | `PieceRef`, piece names, pieces a rule ties, rule names / labels, a selection's rules and heading, top-level pieces | 1 |
| `frontend/app/lib/sketch/clipboard.ts` (new) | `extractPieces`, `insertPieces`, `piecesCentre`, `hasClosedPieces` | 2 |
| `frontend/app/lib/sketch/ruleCheck.ts` (new) | `checkRule` — ok / already / conflict | 3 |
| `frontend/app/composables/pen/penRules.ts` | `ruleSpecFor`; two points offer Horizontal / Vertical | 3 |
| `frontend/app/composables/pen/penReasons.ts` (new) | `ActionState`, `OK`, `no`, `REASON` | 4 |
| `frontend/app/composables/pen/penClipboard.ts` (new) | the shared pen clipboard, paste step | 4 |
| `frontend/app/lib/sketch/sizes.ts` (new) | `sizeTargetFor`, `measureSizes`, screen angles, arc ends, the lock rules | 5 |
| `frontend/app/composables/pen/penActions.ts` (new) | `ACTIONS`, `SELECTION_MENU`, `EMPTY_MENU`, rule items, `menuFor`, `runItem`, wheel layouts, `wheelFor`, `wheelDirAt` | 6 |
| `frontend/app/composables/pen/usePen.ts` | `apply` via `ruleSpecFor` (3); copy / paste / select all / dissolve a point (4); sizes, highlight, `view` (5); menu and wheel state, action host, keys, session ends (6) | 3–6 |
| `frontend/app/composables/pen/penKeys.ts` | `runKeyAction`, X / ⇧H / ⇧V / ⌘C / ⌘V / ⌘A | 6 |
| `frontend/app/composables/pen/penTips.ts` | new cards, keys on Make guide / Flip, two-point captions | 7 |
| `frontend/app/components/pen/PenTipCard.vue` | `reason` prop | 7 |
| `frontend/app/components/pen/PenContextMenu.vue` (new) | the list menu | 7 |
| `frontend/app/components/pen/PenActionWheel.vue` (new) | the wheel | 7 |
| `frontend/app/components/pen/PenOverlay.vue` | right press → menu / wheel, highlight, multi-root, key routing | 8 |
| `frontend/app/components/pen/PenNumberInput.vue` (new) | the value row's field, shared | 9 |
| `frontend/app/components/pen/PenValueRow.vue` | uses `PenNumberInput` | 9 |
| `frontend/app/components/pen/PenProperties.vue` (new) | the Properties panel | 9 |
| `frontend/app/pages/dev/sketch-draw.vue` | Properties beside the canvas; read-only test hooks | 10 |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Properties in the right panel (two hunks) | 10 |
| `frontend/app/components/vue-canvas/ShapeStudioSurface.vue` | Properties in the rail's place (two hunks) | 10 |
| `frontend/tests/frame-pen.spec.ts`, `frontend/tests/shape-pen.spec.ts` | updated for Rulings 14, 20 | 10 |
| `frontend/tests/unit/pen-weld.unit.spec.ts` | Ruling 15 | 3 |
| `frontend/tests/unit/sketch-pieces.unit.spec.ts` (new) | Task 1 | 1 |
| `frontend/tests/unit/sketch-clipboard.unit.spec.ts` (new) | Task 2 | 2 |
| `frontend/tests/unit/pen-rule-check.unit.spec.ts` (new) | Task 3 | 3 |
| `frontend/tests/unit/pen-copy-paste.unit.spec.ts` (new) | Task 4 | 4 |
| `frontend/tests/unit/pen-sizes.unit.spec.ts` (new) | Task 5 | 5 |
| `frontend/tests/unit/pen-actions.unit.spec.ts` (new) | Task 6 | 6 |
| `frontend/tests/unit/pen-menu-components.unit.spec.ts` (new), `pen-tips.unit.spec.ts` | Task 7 | 7 |
| `frontend/tests/unit/pen-overlay-menus.unit.spec.ts` (new) | Task 8 | 8 |
| `frontend/tests/unit/pen-properties.unit.spec.ts` (new) | Task 9 | 9 |
| `frontend/tests/pen-menus.spec.ts` (new) | real-mouse Playwright, three hosts, widths | 11 |

---

### Task 1: Pieces, names and the rules of a selection (pure)

**Files:**
- Create: `frontend/app/lib/sketch/pieces.ts`
- Test: `frontend/tests/unit/sketch-pieces.unit.spec.ts`

**Behaviour (Rulings 10, 11, 3's heading):**
- `pieceNames(doc)` numbers pieces per kind in drawing order (Ruling 10). A path's pieces are named by segment kind: straight → "Line", arc → "Arc", cubic → "Curve".
- `rulePieces(doc, c)` — the pieces a rule ties, in ref order, without repeats. A pair of point refs becomes the line between them, else the arc they are the centre and an end of (either order), else the two points. Special forms: `equalDist [C, p, C, q]` (centre form) → for each of p, q: the arc at C ending there, else the point; `collinear [C1, J, C2]` where both are arcs at J → the two arcs; `collinear [A, B, p]` on a straight piece → that piece and p; `midpoint [p, A, B]` → p and the piece A–B; `tangentLineArc` → the line and the arc (or circle); `tangentArcs` → its two operands (circle id or `[C, S]` arc); entity refs (lines, circles, points) as themselves.
- `ruleName(doc, c)`: Coincident, On line, On circle, Tangent (every tangent kind; `perpendicular [X, J, J, C]` at an arc joint; `collinear` of two arc centres through their joint), Concentric, Horizontal, Vertical, Distance n / Radius n (a `distance` between an arc's centre and end is its radius), Radius n, On curve (`equalDist` centre form whose point isn't an end of an arc at that centre; `collinear [A, B, p]` on a straight piece), Equal, Repeat copy, Mirror copy, Smooth (a Bézier smooth point), Right angle (`perpendicular [A, B, B, C]` between straight pieces), Perpendicular, Parallel, Midpoint. Values print with at most 2 decimals, no trailing zeros.
- `ruleLabel(doc, c, names)` = `"<name> — <piece> · <piece>"`.
- `isArcInvariant(doc, c)`: `equalDist [C, A, C, B]` where an arc segment with centre C runs between A and B.
- `rulesForSelection(doc, sel, segs)` (Ruling 11), `selectionLabel(doc, sel, segs)` ("Nothing selected", "2 points", "1 arc", "3 selected"; a one-piece path reads as its piece), `topLevelIds(doc)` (every non-point entity, plus points no piece uses).

**Interfaces:**
- Consumes: `SketchDoc`, `SketchConstraint`, `EntityId`, `PathEntity`, `getEntity` from `lib/sketch/model.ts`; `isPointReferenced` from `lib/sketch/edit.ts`.
- Produces: `type PieceRef = { kind: 'point' | 'line' | 'circle'; id: EntityId } | { kind: 'seg'; pathId: EntityId; segIndex: number }`, `interface SegPick { pathId: EntityId; segIndex: number }`, `pieceKey(p: PieceRef): string` (`point:<id>` / `line:<id>` / `circle:<id>` / `seg:<pathId>:<i>`), `segCount(p: PathEntity): number`, `pieceNames(doc): Map<string, string>`, `lineBetween(doc, a, b): PieceRef | null`, `arcAt(doc, c, s): PieceRef | null`, `rulePieces(doc, c): PieceRef[]`, `ruleName(doc, c): string`, `ruleLabel(doc, c, names): string`, `isArcInvariant(doc, c): boolean`, `selectionKeys(doc, sel, segs): Set<string>`, `rulesForSelection(doc, sel, segs): SketchConstraint[]`, `selectionLabel(doc, sel, segs): string`, `topLevelIds(doc): EntityId[]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-pieces.unit.spec.ts`:

```ts
// tests/unit/sketch-pieces.unit.spec.ts
// Pen stage 6: the drawing as the right-click menu and the Properties panel
// talk about it — piece names in drawing order, which pieces a rule ties and
// what it is called, the rules that belong to a selection, and the heading.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import {
  pieceNames, pieceKey, rulePieces, ruleName, ruleLabel, isArcInvariant,
  rulesForSelection, selectionLabel, topLevelIds,
} from '~/lib/sketch/pieces'

// a line running into a tangent arc, a loose circle and a lone point
function scene() {
  const d: SketchDoc = { entities: [], constraints: [] }
  const p1 = addPoint(d, 2, 2), p2 = addPoint(d, 6, 2), p5 = addPoint(d, 8, 4), c = addPoint(d, 6, 4)
  const line = addLine(d, p1, p2)
  const arc = addPath(d, [p2, p5], [{ kind: 'arc', center: c, sweep: 1 }])   // adds the arc's own equalDist
  const tan = addConstraint(d, 'perpendicular', [p1, p2, p2, c])             // the joint tangent form
  const cc = addPoint(d, 12, 4)
  const circle = addCircle(d, cc, 1.5)
  const lone = addPoint(d, 14, 8)
  return { d, p1, p2, p5, c, line, arc, tan, cc, circle, lone }
}
const find = (d: SketchDoc, id: string) => d.constraints.find(k => k.id === id)!

describe('piece names', () => {
  it('numbers each kind in drawing order', () => {
    const s = scene()
    const n = pieceNames(s.d)
    expect(n.get(`point:${s.p1}`)).toBe('Point 1')
    expect(n.get(`point:${s.c}`)).toBe('Point 4')
    expect(n.get(`line:${s.line}`)).toBe('Line 1')
    expect(n.get(`seg:${s.arc}:0`)).toBe('Arc 1')
    expect(n.get(`circle:${s.circle}`)).toBe('Circle 1')
    expect(n.get(`point:${s.lone}`)).toBe('Point 6')
  })
  it('straight path pieces share the line count', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0))
    const q = addPoint(d, 2, 0), r = addPoint(d, 3, 0), t = addPoint(d, 3, 1)
    const P = addPath(d, [q, r, t], [{ kind: 'line' }, { kind: 'line' }])
    expect(pieceNames(d).get(`seg:${P}:1`)).toBe('Line 3')
  })
})

describe('what a rule ties, and its name', () => {
  it('the joint tangent: the line and the arc', () => {
    const s = scene()
    const c = find(s.d, s.tan)
    expect(rulePieces(s.d, c).map(pieceKey)).toEqual([`line:${s.line}`, `seg:${s.arc}:0`])
    expect(ruleName(s.d, c)).toBe('Tangent')
    expect(ruleLabel(s.d, c, pieceNames(s.d))).toBe('Tangent — Line 1 · Arc 1')
  })
  it('an arc radius pin reads as that arc’s radius', () => {
    const s = scene()
    const id = addConstraint(s.d, 'distance', [s.c, s.p2], 2)
    expect(ruleLabel(s.d, find(s.d, id), pieceNames(s.d))).toBe('Radius 2 — Arc 1')
  })
  it('two points held level, a point on an arc, a circle’s size, a whole line held level', () => {
    const s = scene()
    const names = pieceNames(s.d)
    const lab = (id: string) => ruleLabel(s.d, find(s.d, id), names)
    expect(lab(addConstraint(s.d, 'horizontal', [s.p1, s.lone]))).toBe('Horizontal — Point 1 · Point 6')
    expect(lab(addConstraint(s.d, 'equalDist', [s.c, s.lone, s.c, s.p2]))).toBe('On curve — Point 6 · Arc 1')
    expect(lab(addConstraint(s.d, 'radius', [s.circle], 1.5))).toBe('Radius 1.5 — Circle 1')
    expect(lab(addConstraint(s.d, 'horizontal', [s.line]))).toBe('Horizontal — Line 1')
  })
  it('a square corner between two straight pieces is a right angle', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 4, 3)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    const k = addConstraint(d, 'perpendicular', [a, b, b, c])
    expect(ruleLabel(d, find(d, k), pieceNames(d))).toBe('Right angle — Line 1 · Line 2')
  })
  it('two arcs joined smoothly: collinear centres read as Tangent', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), j = addPoint(d, 2, 0), b = addPoint(d, 4, 0)
    const c1 = addPoint(d, 1, 0), c2 = addPoint(d, 3, 0)
    const P = addPath(d, [a, j, b], [{ kind: 'arc', center: c1, sweep: 1 }, { kind: 'arc', center: c2, sweep: 0 }])
    const k = addConstraint(d, 'collinear', [c1, j, c2])
    expect(ruleLabel(d, find(d, k), pieceNames(d))).toBe('Tangent — Arc 1 · Arc 2')
    expect(rulePieces(d, find(d, k)).map(pieceKey)).toEqual([`seg:${P}:0`, `seg:${P}:1`])
  })
})

describe('the rules of a selection', () => {
  it('an arc lists its tangent and hides its own equal-ends rule', () => {
    const s = scene()
    const inv = s.d.constraints.find(k => k.kind === 'equalDist')!
    expect(isArcInvariant(s.d, inv)).toBe(true)
    expect(rulesForSelection(s.d, [], [{ pathId: s.arc, segIndex: 0 }]).map(c => c.id)).toEqual([s.tan])
  })
  it('a whole path counts its pieces and its points', () => {
    const s = scene()
    const k = addConstraint(s.d, 'horizontal', [s.p5, s.lone])
    expect(rulesForSelection(s.d, [s.arc], []).map(c => c.id).sort()).toEqual([s.tan, k].sort())
  })
  it('a piece with no rules lists none', () => {
    const s = scene()
    expect(rulesForSelection(s.d, [s.circle], [])).toEqual([])
  })
})

describe('the heading', () => {
  it('names one kind with a count, otherwise counts', () => {
    const s = scene()
    expect(selectionLabel(s.d, [], [])).toBe('Nothing selected')
    expect(selectionLabel(s.d, [s.p1, s.lone], [])).toBe('2 points')
    expect(selectionLabel(s.d, [], [{ pathId: s.arc, segIndex: 0 }])).toBe('1 arc')
    expect(selectionLabel(s.d, [s.arc], [])).toBe('1 arc')
    expect(selectionLabel(s.d, [s.line, s.circle, s.lone], [])).toBe('3 selected')
  })
  it('top-level pieces: every piece plus points no piece uses', () => {
    const s = scene()
    expect(topLevelIds(s.d).sort()).toEqual([s.line, s.arc, s.circle, s.lone].sort())
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-pieces.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/sketch/pieces`.

- [ ] **Step 3: Write `frontend/app/lib/sketch/pieces.ts`**

```ts
// app/lib/sketch/pieces.ts
// Pen stage 6: the drawing as the right-click menu and the Properties panel
// talk about it — pieces (points, lines, arcs, circles, curves) with names in
// drawing order ("Line 2", "Arc 3"), which pieces a rule ties, a rule's name
// in plain words, the rules that belong to a selection, and a selection's
// heading ("2 points", "1 arc", "3 selected"). Pure.
import type { SketchDoc, SketchConstraint, EntityId, PathEntity, SegmentSpec } from './model'
import { getEntity } from './model'
import { isPointReferenced } from './edit'

export type PieceRef =
  | { kind: 'point' | 'line' | 'circle'; id: EntityId }
  | { kind: 'seg'; pathId: EntityId; segIndex: number }

/** An Option-picked path segment (the pen's `selectedSegments` entries). */
export interface SegPick { pathId: EntityId; segIndex: number }

export function pieceKey(p: PieceRef): string {
  return p.kind === 'seg' ? `seg:${p.pathId}:${p.segIndex}` : `${p.kind}:${p.id}`
}

export const segCount = (p: PathEntity): number => (p.closed ? p.anchors.length : p.anchors.length - 1)
const endsOf = (p: PathEntity, i: number): [EntityId, EntityId] => [p.anchors[i]!, p.anchors[(i + 1) % p.anchors.length]!]
const segNoun = (s: SegmentSpec | undefined): string => (s?.kind === 'arc' ? 'arc' : s?.kind === 'cubic' ? 'curve' : 'line')

/** Every piece's name, keyed by pieceKey (Ruling 10). */
export function pieceNames(doc: SketchDoc): Map<string, string> {
  const out = new Map<string, string>()
  const n = { point: 0, line: 0, arc: 0, circle: 0, curve: 0 }
  const NAME: Record<string, string> = { line: 'Line', arc: 'Arc', curve: 'Curve' }
  for (const e of doc.entities) {
    if (e.kind === 'point') out.set(`point:${e.id}`, `Point ${++n.point}`)
    else if (e.kind === 'line') out.set(`line:${e.id}`, `Line ${++n.line}`)
    else if (e.kind === 'circle') out.set(`circle:${e.id}`, `Circle ${++n.circle}`)
    else {
      for (let i = 0; i < segCount(e); i++) {
        const noun = segNoun(e.segments[i]) as 'line' | 'arc' | 'curve'
        out.set(`seg:${e.id}:${i}`, `${NAME[noun]} ${++n[noun]}`)
      }
    }
  }
  return out
}

/** The line entity or straight path piece running between a and b (either way round). */
export function lineBetween(doc: SketchDoc, a: EntityId, b: EntityId): PieceRef | null {
  const pair = (x: EntityId, y: EntityId) => (x === a && y === b) || (x === b && y === a)
  for (const e of doc.entities) {
    if (e.kind === 'line' && pair(e.p1, e.p2)) return { kind: 'line', id: e.id }
    if (e.kind !== 'path') continue
    for (let i = 0; i < segCount(e); i++) {
      const [x, y] = endsOf(e, i)
      if (e.segments[i]?.kind === 'line' && pair(x, y)) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

/** The path arc with centre c that starts or ends at s. */
export function arcAt(doc: SketchDoc, c: EntityId, s: EntityId): PieceRef | null {
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (let i = 0; i < segCount(e); i++) {
      const seg = e.segments[i]
      if (seg?.kind !== 'arc' || seg.center !== c) continue
      const [x, y] = endsOf(e, i)
      if (x === s || y === s) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

function entityPiece(doc: SketchDoc, id: EntityId): PieceRef | null {
  const e = getEntity(doc, id)
  if (!e || e.kind === 'path') return null
  return { kind: e.kind, id }
}
// a pair of point refs: the line between them, else the arc they are the
// centre and an end of (either order), else the two points
function pairPieces(doc: SketchDoc, x: EntityId, y: EntityId): (PieceRef | null)[] {
  const one = lineBetween(doc, x, y) ?? arcAt(doc, x, y) ?? arcAt(doc, y, x)
  return one ? [one] : [entityPiece(doc, x), entityPiece(doc, y)]
}
function dedupe(ps: (PieceRef | null)[]): PieceRef[] {
  const seen = new Set<string>()
  const out: PieceRef[] = []
  for (const p of ps) {
    if (!p) continue
    const k = pieceKey(p)
    if (!seen.has(k)) { seen.add(k); out.push(p) }
  }
  return out
}
// tangentArcs operands: a circle id alone, or an arc's [C, S]
function operandPieces(doc: SketchDoc, refs: EntityId[], from: number): (PieceRef | null)[] {
  const out: (PieceRef | null)[] = []
  for (let i = from; i < refs.length;) {
    if (getEntity(doc, refs[i]!)?.kind === 'circle') { out.push(entityPiece(doc, refs[i]!)); i += 1 }
    else { out.push(...pairPieces(doc, refs[i]!, refs[i + 1] ?? '')); i += 2 }
  }
  return out
}

/** `equalDist [C, A, C, B]` where an arc segment with centre C runs between A and B — every arc's own rule. */
export function isArcInvariant(doc: SketchDoc, c: SketchConstraint): boolean {
  if (c.kind !== 'equalDist' || c.refs.length !== 4 || c.refs[0] !== c.refs[2]) return false
  const [cen, a, , b] = c.refs as [EntityId, EntityId, EntityId, EntityId]
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (let i = 0; i < segCount(e); i++) {
      const s = e.segments[i]
      if (s?.kind !== 'arc' || s.center !== cen) continue
      const [x, y] = endsOf(e, i)
      if ((x === a && y === b) || (x === b && y === a)) return true
    }
  }
  return false
}

/** The pieces a rule ties, in ref order, without repeats. */
export function rulePieces(doc: SketchDoc, c: SketchConstraint): PieceRef[] {
  const r = c.refs
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
      return dedupe(r.length === 1 ? [entityPiece(doc, r[0]!)] : pairPieces(doc, r[0]!, r[1]!))
    case 'distance':
      return dedupe(pairPieces(doc, r[0]!, r[1]!))
    case 'equalDist':
      if (r.length === 4 && r[0] === r[2]) {
        return dedupe([arcAt(doc, r[0]!, r[1]!) ?? entityPiece(doc, r[1]!), arcAt(doc, r[0]!, r[3]!) ?? entityPiece(doc, r[3]!)])
      }
      if (r.length === 4) return dedupe([...pairPieces(doc, r[0]!, r[1]!), ...pairPieces(doc, r[2]!, r[3]!)])
      return dedupe(r.map(id => entityPiece(doc, id)))
    case 'perpendicular':
    case 'parallel':
      if (r.length === 4) return dedupe([...pairPieces(doc, r[0]!, r[1]!), ...pairPieces(doc, r[2]!, r[3]!)])
      return dedupe(r.map(id => entityPiece(doc, id)))
    case 'collinear': {
      const [a, b, p] = r as [EntityId, EntityId, EntityId]
      const arc1 = arcAt(doc, a, b), arc2 = arcAt(doc, p, b)
      if (arc1 && arc2) return dedupe([arc1, arc2])
      const l = lineBetween(doc, a, b)
      if (l) return dedupe([l, entityPiece(doc, p)])
      return dedupe(r.map(id => entityPiece(doc, id)))
    }
    case 'midpoint':
      return dedupe([entityPiece(doc, r[0]!), ...pairPieces(doc, r[1]!, r[2]!)])
    case 'tangentLineArc':
      return dedupe([...pairPieces(doc, r[0]!, r[1]!), ...operandPieces(doc, r, 2)])
    case 'tangentArcs':
      return dedupe(operandPieces(doc, r, 0))
    default:
      return dedupe(r.map(id => entityPiece(doc, id)))
  }
}

const fmt = (v: number | undefined) => String(Number((v ?? 0).toFixed(2)))

/** A rule's name in plain words (Ruling 11). */
export function ruleName(doc: SketchDoc, c: SketchConstraint): string {
  const r = c.refs
  switch (c.kind) {
    case 'coincident': return 'Coincident'
    case 'pointOnLine': return 'On line'
    case 'pointOnCircle': return 'On circle'
    case 'tangentLineCircle': case 'tangentCircleCircle': case 'tangentLineArc': case 'tangentArcs': return 'Tangent'
    case 'concentric': return 'Concentric'
    case 'horizontal': return 'Horizontal'
    case 'vertical': return 'Vertical'
    case 'distance': return (arcAt(doc, r[0]!, r[1]!) || arcAt(doc, r[1]!, r[0]!)) ? `Radius ${fmt(c.value)}` : `Distance ${fmt(c.value)}`
    case 'radius': return `Radius ${fmt(c.value)}`
    case 'equalDist':
      if (r.length === 4 && r[0] === r[2] && !(arcAt(doc, r[0]!, r[1]!) && arcAt(doc, r[0]!, r[3]!))) return 'On curve'
      return 'Equal'
    case 'equalRadius': return 'Equal'
    case 'rotatedFrom': return 'Repeat copy'
    case 'mirroredFrom': return 'Mirror copy'
    case 'collinear':
      if (arcAt(doc, r[0]!, r[1]!) && arcAt(doc, r[2]!, r[1]!)) return 'Tangent'
      if (lineBetween(doc, r[0]!, r[1]!)) return 'On curve'
      return 'Smooth'
    case 'perpendicular':
      if (r.length === 4 && r[1] === r[2]) {
        return (arcAt(doc, r[3]!, r[2]!) || arcAt(doc, r[0]!, r[1]!)) ? 'Tangent' : 'Right angle'
      }
      return 'Perpendicular'
    case 'parallel': return 'Parallel'
    case 'midpoint': return 'Midpoint'
  }
}

/** "Tangent — Line 2 · Arc 3" */
export function ruleLabel(doc: SketchDoc, c: SketchConstraint, names: Map<string, string>): string {
  const pieces = rulePieces(doc, c).map(p => names.get(pieceKey(p))).filter((x): x is string => !!x)
  return pieces.length ? `${ruleName(doc, c)} — ${pieces.join(' · ')}` : ruleName(doc, c)
}

/** The piece keys a selection covers: a whole path counts its pieces and its points. */
export function selectionKeys(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): Set<string> {
  const out = new Set<string>()
  for (const id of sel) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind !== 'path') { out.add(`${e.kind}:${id}`); continue }
    for (let i = 0; i < segCount(e); i++) out.add(`seg:${id}:${i}`)
    for (const a of e.anchors) out.add(`point:${a}`)
  }
  for (const s of segs) out.add(`seg:${s.pathId}:${s.segIndex}`)
  return out
}

/** Every rule that ties a selected piece, except each arc's own equal-ends rule (Ruling 11). */
export function rulesForSelection(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): SketchConstraint[] {
  const keys = selectionKeys(doc, sel, segs)
  if (!keys.size) return []
  return doc.constraints.filter(c => !isArcInvariant(doc, c) && rulePieces(doc, c).some(p => keys.has(pieceKey(p))))
}

function nounOf(doc: SketchDoc, id: EntityId): string | null {
  const e = getEntity(doc, id)
  if (!e) return null
  if (e.kind !== 'path') return e.kind
  return segCount(e) === 1 ? segNoun(e.segments[0]) : 'path'
}

/** "Nothing selected", "2 points", "1 arc", "3 selected" — a one-piece path reads as its piece. */
export function selectionLabel(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): string {
  const nouns = [
    ...sel.map(id => nounOf(doc, id)),
    ...segs.map(s => { const p = getEntity(doc, s.pathId); return p?.kind === 'path' ? segNoun(p.segments[s.segIndex]) : null }),
  ].filter((n): n is string => !!n)
  if (!nouns.length) return 'Nothing selected'
  const n = nouns.length
  return nouns.every(x => x === nouns[0]) ? `${n} ${nouns[0]}${n === 1 ? '' : 's'}` : `${n} selected`
}

/** Every piece that isn't a point, plus points no piece uses — what Select all selects. */
export function topLevelIds(doc: SketchDoc): EntityId[] {
  return doc.entities.filter(e => e.kind !== 'point' || !isPointReferenced(doc, e.id)).map(e => e.id)
}
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-pieces.unit.spec.ts`
Expected: PASS (12 tests). Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E 'lib/sketch/pieces'` — no lines. (`ruleName`'s switch must be exhaustive over `ConstraintKind`; if vue-tsc reports a missing return, a kind was added since this plan — give it a plain name and a test line.)

- [ ] **Step 5: Commit** `frontend/app/lib/sketch/pieces.ts frontend/tests/unit/sketch-pieces.unit.spec.ts` — message `feat(pen): pieces and their names — what a rule ties, rule names, a selection's rules and heading (stage 6)`.

---

### Task 2: Copy out and paste in (pure)

**Files:**
- Create: `frontend/app/lib/sketch/clipboard.ts`
- Test: `frontend/tests/unit/sketch-clipboard.unit.spec.ts`

**Behaviour (Ruling 9):**
- `extractPieces(doc, ids, segs)` returns a separate drawing (plain copies, never the drawing's own objects): the selected entities' point closure, their non-point entities, and each Option-picked segment whose path isn't itself selected as a one-piece open path (id `<pathId>~<i>`, with its ends, arc centre or handles; `construction` kept) — in drawing order, the segment paths last — plus every rule whose refs are all in the copy.
- `insertPieces(doc, clip, offset)` adds the copy with fresh ids (`freshId` with the kind's usual prefix: `p` `l` `c` `P`), re-points every ref (line ends, circle centre, path anchors, arc centres, handles, rule refs), moves every point by `offset`, and returns `{ created, top }` — `top` = the pasted non-point entities plus pasted points no pasted piece uses.
- `piecesCentre(clip)` = the middle of the copy's bounding box (points, circles by their full extent). `hasClosedPieces(clip)` = a circle or a closed path in it.

**Interfaces:**
- Consumes: `pointClosure`, `addConstraint` (`lib/sketch/edit.ts`), `freshId` (`lib/sketch/ids.ts`), `SegPick`, `segCount` (Task 1).
- Produces: `extractPieces(doc: SketchDoc, ids: readonly EntityId[], segs: readonly SegPick[]): SketchDoc`, `insertPieces(doc: SketchDoc, clip: SketchDoc, offset: Vec2): { created: EntityId[]; top: EntityId[] }`, `piecesCentre(clip: SketchDoc): Vec2`, `hasClosedPieces(clip: SketchDoc): boolean`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/sketch-clipboard.unit.spec.ts`:

```ts
// tests/unit/sketch-clipboard.unit.spec.ts
// Pen stage 6, Copy / Paste: the pieces with the rules among them go out as
// a drawing of their own, and come back in with fresh ids, moved, every ref
// re-pointed — so no rule ever ties a pasted piece to the original.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { extractPieces, insertPieces, piecesCentre, hasClosedPieces } from '~/lib/sketch/clipboard'

const empty = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('extractPieces', () => {
  it('takes the pieces, their points and only the rules among them — as copies', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), far = addPoint(d, 9, 9)
    const l = addLine(d, a, b)
    const h = addConstraint(d, 'horizontal', [a, b])
    addConstraint(d, 'distance', [b, far], 3)
    const clip = extractPieces(d, [l], [])
    expect(clip.entities.map(e => e.id).sort()).toEqual([a, b, l].sort())
    expect(clip.constraints.map(c => c.id)).toEqual([h])
    P(clip, a).x = 99
    expect(P(d, a).x).toBe(0)
  })
  it('an Option-picked arc becomes a one-piece open path that keeps its equal-ends rule', () => {
    const d = empty()
    const s = addPoint(d, 0, 0), e = addPoint(d, 2, 2), m = addPoint(d, 4, 2), c = addPoint(d, 2, 0)
    const path = addPath(d, [s, e, m], [{ kind: 'arc', center: c, sweep: 1 }, { kind: 'line' }])
    const clip = extractPieces(d, [], [{ pathId: path, segIndex: 0 }])
    const paths = clip.entities.filter(x => x.kind === 'path') as any[]
    expect(paths).toHaveLength(1)
    expect(paths[0].anchors).toEqual([s, e])
    expect(paths[0].segments).toEqual([{ kind: 'arc', center: c, sweep: 1 }])
    expect(paths[0].closed).toBe(false)
    expect(clip.constraints.map(k => k.kind)).toEqual(['equalDist'])
    expect(clip.entities.some(x => x.id === m)).toBe(false)
  })
})

describe('insertPieces', () => {
  it('pastes with fresh ids, moved, rules re-pointed; returns the pasted pieces', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    const l = addLine(d, a, b)
    addConstraint(d, 'horizontal', [a, b])
    const clip = extractPieces(d, [l], [])
    const before = d.entities.length
    const { top, created } = insertPieces(d, clip, { x: 1, y: -1 })
    expect(d.entities.length).toBe(before + 3)
    expect(created).toHaveLength(3)
    expect(top).toHaveLength(1)
    const nl = P(d, top[0]!)
    expect(nl.kind).toBe('line')
    expect([nl.p1, nl.p2]).not.toContain(a)
    expect(P(d, nl.p1)).toMatchObject({ x: 1, y: -1 })
    expect(P(d, nl.p2)).toMatchObject({ x: 5, y: -1 })
    const hs = d.constraints.filter(c => c.kind === 'horizontal')
    expect(hs).toHaveLength(2)
    expect(hs[1]!.refs).toEqual([nl.p1, nl.p2])
    const ids = [...d.entities.map(e => e.id), ...d.constraints.map(c => c.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('a path keeps its arc centre and its equal-ends rule on the new points', () => {
    const d = empty()
    const s = addPoint(d, 0, 0), e = addPoint(d, 2, 2), c = addPoint(d, 2, 0)
    const path = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    const { top } = insertPieces(d, extractPieces(d, [path], []), { x: 10, y: 0 })
    const np = P(d, top[0]!)
    expect(np.kind).toBe('path')
    expect(np.anchors).not.toContain(s)
    expect(P(d, np.segments[0].center)).toMatchObject({ x: 12, y: 0 })
    const eq = d.constraints.filter(k => k.kind === 'equalDist')
    expect(eq).toHaveLength(2)
    expect(eq[1]!.refs).toEqual([np.segments[0].center, np.anchors[0], np.segments[0].center, np.anchors[1]])
  })
  it('pasting one copy twice makes two copies', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0))
    const clip = extractPieces(d, [l], [])
    insertPieces(d, clip, { x: 1, y: 0 })
    insertPieces(d, clip, { x: 2, y: 0 })
    expect(d.entities.filter(e => e.kind === 'line')).toHaveLength(3)
  })
})

describe('centre and closed pieces', () => {
  it('measures the copy and tells a closed one', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 2))
    expect(piecesCentre(extractPieces(d, [l], []))).toEqual({ x: 2, y: 1 })
    expect(hasClosedPieces(extractPieces(d, [l], []))).toBe(false)
    const circle = addCircle(d, addPoint(d, 5, 5), 1)
    const clip = extractPieces(d, [circle], [])
    expect(piecesCentre(clip)).toEqual({ x: 5, y: 5 })
    expect(hasClosedPieces(clip)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-clipboard.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/sketch/clipboard`.

- [ ] **Step 3: Write `frontend/app/lib/sketch/clipboard.ts`**

```ts
// app/lib/sketch/clipboard.ts
// Pen stage 6, Copy / Paste inside the pen: the selected pieces with their
// points and the rules among them go out as a drawing of their own
// (extractPieces), and come back in with fresh ids, moved, and every ref
// re-pointed (insertPieces) — so a pasted rule never ties back to the
// original, and stage-3 editing handles pasted pieces like any others. Pure.
import type { SketchDoc, SketchEntity, EntityId, PathEntity } from './model'
import { getEntity } from './model'
import type { Vec2 } from './geom'
import { pointClosure, addConstraint } from './edit'
import { freshId } from './ids'
import { segCount, type SegPick } from './pieces'

function copyEntity(e: SketchEntity): SketchEntity {
  if (e.kind === 'path') return { ...e, anchors: [...e.anchors], segments: e.segments.map(s => ({ ...s })) }
  return { ...e }
}

/** The selection as a drawing of its own (Ruling 9). */
export function extractPieces(doc: SketchDoc, ids: readonly EntityId[], segs: readonly SegPick[]): SketchDoc {
  const keep = new Set<EntityId>(pointClosure(doc, [...ids]))
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (e && e.kind !== 'point') keep.add(id)
  }
  const segPaths: PathEntity[] = []
  for (const s of segs) {
    const p = getEntity(doc, s.pathId)
    if (!p || p.kind !== 'path' || keep.has(p.id) || s.segIndex < 0 || s.segIndex >= segCount(p)) continue
    const seg = p.segments[s.segIndex]!
    const a = p.anchors[s.segIndex]!, b = p.anchors[(s.segIndex + 1) % p.anchors.length]!
    keep.add(a); keep.add(b)
    if (seg.kind === 'arc') keep.add(seg.center)
    if (seg.kind === 'cubic') { if (seg.h1) keep.add(seg.h1); if (seg.h2) keep.add(seg.h2) }
    segPaths.push({ id: `${p.id}~${s.segIndex}`, kind: 'path', anchors: [a, b], segments: [{ ...seg }], closed: false, ...(p.construction ? { construction: true } : {}) })
  }
  const out: SketchDoc = { entities: [], constraints: [] }
  for (const e of doc.entities) if (keep.has(e.id)) out.entities.push(copyEntity(e))
  out.entities.push(...segPaths)
  const have = new Set(out.entities.map(e => e.id))
  for (const c of doc.constraints) {
    if (c.refs.length && c.refs.every(r => have.has(r))) out.constraints.push({ ...c, refs: [...c.refs] })
  }
  return out
}

const PREFIX: Record<SketchEntity['kind'], string> = { point: 'p', line: 'l', circle: 'c', path: 'P' }

/** Adds the copy with fresh ids, moved by `offset`; every ref re-pointed. */
export function insertPieces(doc: SketchDoc, clip: SketchDoc, offset: Vec2): { created: EntityId[]; top: EntityId[] } {
  const map = new Map<EntityId, EntityId>()
  const added: SketchEntity[] = []
  // ids first (each pushed at once, so freshId never hands out one twice) …
  for (const e of clip.entities) {
    const copy = copyEntity(e)
    copy.id = freshId(doc, PREFIX[e.kind])
    map.set(e.id, copy.id)
    doc.entities.push(copy)
    added.push(copy)
  }
  // … then every ref, whatever order the copy's entities came in
  const m = (x: EntityId) => map.get(x) ?? x
  for (const e of added) {
    if (e.kind === 'point') { e.x += offset.x; e.y += offset.y }
    else if (e.kind === 'line') { e.p1 = m(e.p1); e.p2 = m(e.p2) }
    else if (e.kind === 'circle') e.center = m(e.center)
    else {
      e.anchors = e.anchors.map(m)
      e.segments = e.segments.map(s =>
        s.kind === 'arc' ? { ...s, center: m(s.center) }
        : s.kind === 'cubic' ? { ...s, h1: s.h1 ? m(s.h1) : null, h2: s.h2 ? m(s.h2) : null }
        : { ...s })
    }
  }
  for (const c of clip.constraints) addConstraint(doc, c.kind, c.refs.map(m), c.value)
  const used = new Set<EntityId>()
  for (const e of added) {
    if (e.kind === 'line') { used.add(e.p1); used.add(e.p2) }
    else if (e.kind === 'circle') used.add(e.center)
    else if (e.kind === 'path') {
      for (const a of e.anchors) used.add(a)
      for (const s of e.segments) {
        if (s.kind === 'arc') used.add(s.center)
        else if (s.kind === 'cubic') { if (s.h1) used.add(s.h1); if (s.h2) used.add(s.h2) }
      }
    }
  }
  return {
    created: added.map(e => e.id),
    top: added.filter(e => e.kind !== 'point' || !used.has(e.id)).map(e => e.id),
  }
}

/** The middle of the copy's bounding box (circles by their full extent). */
export function piecesCentre(clip: SketchDoc): Vec2 {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const grow = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r) }
  const pts = new Map(clip.entities.filter(e => e.kind === 'point').map(e => [e.id, e as { x: number; y: number }]))
  for (const p of pts.values()) grow(p.x, p.y)
  for (const e of clip.entities) {
    if (e.kind === 'circle') { const c = pts.get(e.center); if (c) grow(c.x, c.y, e.r) }
  }
  return Number.isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : { x: 0, y: 0 }
}

/** A circle or a closed path — what an open-only pen can't take. */
export function hasClosedPieces(clip: SketchDoc): boolean {
  return clip.entities.some(e => e.kind === 'circle' || (e.kind === 'path' && e.closed))
}
```

- [ ] **Step 4: Run the test**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/sketch-clipboard.unit.spec.ts tests/unit/sketch-pieces.unit.spec.ts`
Expected: PASS. Typecheck `lib/sketch/clipboard` — no lines.

- [ ] **Step 5: Commit** `frontend/app/lib/sketch/clipboard.ts frontend/tests/unit/sketch-clipboard.unit.spec.ts` — message `feat(pen): copy out and paste in — fresh ids, rules re-pointed (stage 6)`.

---

### Task 3: The rule a selection makes, and whether it can be added

**Files:**
- Create: `frontend/app/lib/sketch/ruleCheck.ts`
- Modify: `frontend/app/composables/pen/penRules.ts` (two points offer Horizontal / Vertical; `ruleSpecFor`)
- Modify: `frontend/app/composables/pen/usePen.ts` (`apply` builds its rule with `ruleSpecFor`)
- Modify: `frontend/tests/unit/pen-weld.unit.spec.ts` (line 190's expected list — Ruling 15)
- Test: `frontend/tests/unit/pen-rule-check.unit.spec.ts`

**Behaviour (Rulings 12, 15):**
- `ruleSpecFor(doc, selection, segments, option, value?)` is the rule `apply` writes for that selection — the same branches in the same order: `option.tangent` → `tangentRuleForSelection`; one point + one segment → `pointSegmentRefs`; Coincident on two points → `{ merge: [first, second] }` (the first stays, as `apply` does); segments → `segmentConstraintRefs`; entities → `orderRefs`; nothing selected → `null`. `apply` is refactored to call it, with no change in what it writes (the test pins each case's refs by hand).
- `checkRule(doc, spec)` (Ruling 12). Merge: same point → `'already'`; `mergePoints` refuses (two fixed points apart) → `'conflict'`; else a trial solve decides. Rule: an equivalent rule present → `'already'`; the rule's rows over the free slots of the connected part it touches (`componentOf`) raise the rank of that part's rows → a trial solve on a copy of the whole drawing must converge with nothing collapsing → `'ok'`, else `'conflict'`; no rise → `'already'` when the trial solve converges and no point moves more than 1e-5 × the drawing's size, else `'conflict'`. A collapse is a line, straight piece, arc radius or circle radius over 1e-9 that ends under 1/1000 of what it was.
- Two points offer `['Coincident', 'Distance…', 'Horizontal', 'Vertical']`.

**Interfaces:**
- Consumes: `componentOf` (`lib/sketch/cleanup/guards.ts`), `RowBasis`, `freeSlots`, `rowsFor` (`lib/sketch/cleanup/rank.ts`), `equivalentRuleKey`, `RuleSpec` (`lib/sketch/tangency.ts`), `mergePoints` (`lib/sketch/trim.ts`), `solve`, `cloneDoc`.
- Produces: `lib/sketch/ruleCheck.ts`: `type MergeSpec = { merge: [EntityId, EntityId] }`, `type RuleCheck = 'ok' | 'already' | 'conflict'`, `checkRule(doc: SketchDoc, spec: RuleSpec | MergeSpec): RuleCheck`. `penRules.ts`: `ruleSpecFor(doc, selection: EntityId[], segments: SegRef[], option: RuleOption, value?: number): RuleSpec | MergeSpec | null`, re-exports `type MergeSpec`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-rule-check.unit.spec.ts`:

```ts
// tests/unit/pen-rule-check.unit.spec.ts
// Pen stage 6: the rule a selection makes (what apply writes, pinned case by
// case) and whether it can be added — "Already true" (there, or implied by
// the others), "Conflicts with another rule" (would move things it can't, or
// collapse a piece), else fine. Two points now offer Horizontal / Vertical.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { checkRule } from '~/lib/sketch/ruleCheck'
import { ruleSpecFor } from '~/composables/pen/penRules'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const empty = (): SketchDoc => ({ entities: [], constraints: [] })
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>(empty())
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}

describe('checkRule', () => {
  it('a rule already there is already true', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    addConstraint(d, 'horizontal', [l])
    expect(checkRule(d, { kind: 'horizontal', refs: [l] })).toBe('already')
  })
  it('a rule the others imply is already true', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 0, 2), e = addPoint(d, 4, 2)
    addConstraint(d, 'horizontal', [a, b]); addConstraint(d, 'horizontal', [c, e])
    expect(checkRule(d, { kind: 'parallel', refs: [a, b, c, e] })).toBe('already')
  })
  it('a rule that fights another conflicts', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    addConstraint(d, 'horizontal', [l])
    expect(checkRule(d, { kind: 'vertical', refs: [l] })).toBe('conflict')
  })
  it('a rule that can hold is fine', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0.3))
    expect(checkRule(d, { kind: 'horizontal', refs: [l] })).toBe('ok')
  })
  it('joining two points: fine, but not two fixed points in different places', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 1)
    expect(checkRule(d, { merge: [a, b] })).toBe('ok')
    const f = empty()
    const x = addPoint(f, 0, 0, { fixed: true }), y = addPoint(f, 1, 1, { fixed: true })
    expect(checkRule(f, { merge: [x, y] })).toBe('conflict')
  })
})

describe('ruleSpecFor is what apply writes', () => {
  it('two lines: the four ends, in pick order', () => {
    let a = '', b = '', c = '', e = '', l1 = '', l2 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 4, 0.2); c = addPoint(d, 0, 2); e = addPoint(d, 4, 2.5)
      l1 = addLine(d, a, b); l2 = addLine(d, c, e)
    })
    for (const kind of ['perpendicular', 'parallel', 'equalDist'] as const) {
      expect(ruleSpecFor(doc.value, [l1, l2], [], { kind, label: '' })).toEqual({ kind, refs: [a, b, c, e] })
    }
    pen.pick(l1); pen.pick(l2, true)
    pen.apply('parallel')
    expect(doc.value.constraints.at(-1)).toMatchObject({ kind: 'parallel', refs: [a, b, c, e] })
  })
  it('a point and a line: on line, midpoint', () => {
    let p = '', a = '', b = '', l = ''
    const { doc } = mk(d => { p = addPoint(d, 1, 1); a = addPoint(d, 0, 0); b = addPoint(d, 4, 0); l = addLine(d, a, b) })
    expect(ruleSpecFor(doc.value, [l, p], [], { kind: 'pointOnLine', label: '' })).toEqual({ kind: 'pointOnLine', refs: [p, l] })
    expect(ruleSpecFor(doc.value, [p, l], [], { kind: 'midpoint', label: '' })).toEqual({ kind: 'midpoint', refs: [p, a, b] })
  })
  it('segments: a straight one levelled; a point on a straight or round one; two arcs made equal', () => {
    let a = '', b = '', c = '', P = '', q = '', s = '', t = '', cen = '', Q = '', s2 = '', t2 = '', cen2 = '', R = ''
    const { doc } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 4, 0.3); c = addPoint(d, 4, 3)
      P = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
      q = addPoint(d, 9, 9)
      s = addPoint(d, 10, 0); t = addPoint(d, 12, 2); cen = addPoint(d, 12, 0)
      Q = addPath(d, [s, t], [{ kind: 'arc', center: cen, sweep: 1 }])
      s2 = addPoint(d, 20, 0); t2 = addPoint(d, 23, 3); cen2 = addPoint(d, 23, 0)
      R = addPath(d, [s2, t2], [{ kind: 'arc', center: cen2, sweep: 1 }])
    })
    expect(ruleSpecFor(doc.value, [], [{ pathId: P, segIndex: 0 }], { kind: 'horizontal', label: '' })).toEqual({ kind: 'horizontal', refs: [a, b] })
    expect(ruleSpecFor(doc.value, [q], [{ pathId: P, segIndex: 1 }], { kind: 'collinear', label: '' })).toEqual({ kind: 'collinear', refs: [b, c, q] })
    expect(ruleSpecFor(doc.value, [q], [{ pathId: Q, segIndex: 0 }], { kind: 'equalDist', label: '' })).toEqual({ kind: 'equalDist', refs: [cen, q, cen, s] })
    expect(ruleSpecFor(doc.value, [], [{ pathId: Q, segIndex: 0 }, { pathId: R, segIndex: 0 }], { kind: 'equalDist', label: '' }))
      .toEqual({ kind: 'equalDist', refs: [cen, s, cen2, s2] })
  })
  it('a circle’s radius carries its value; two points join as a merge; nothing selected makes nothing', () => {
    let c = '', a = '', b = ''
    const { doc } = mk(d => { c = addCircle(d, addPoint(d, 0, 0), 2); a = addPoint(d, 5, 5); b = addPoint(d, 6, 6) })
    expect(ruleSpecFor(doc.value, [c], [], { kind: 'radius', label: '' }, 3)).toEqual({ kind: 'radius', refs: [c], value: 3 })
    expect(ruleSpecFor(doc.value, [a, b], [], { kind: 'coincident', label: '' })).toEqual({ merge: [a, b] })
    expect(ruleSpecFor(doc.value, [], [], { kind: 'horizontal', label: '' })).toBeNull()
  })
})

describe('two points', () => {
  it('offer Horizontal and Vertical after Coincident and Distance; Horizontal lines them up', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 5, 1) })
    pen.pick(a); pen.pick(b, true)
    expect(pen.availableConstraints().map(r => r.label)).toEqual(['Coincident', 'Distance…', 'Horizontal', 'Vertical'])
    pen.apply('horizontal')
    const pa = doc.value.entities.find(e => e.id === a) as any, pb = doc.value.entities.find(e => e.id === b) as any
    expect(pa.y).toBeCloseTo(pb.y, 6)
    expect(doc.value.constraints.at(-1)).toMatchObject({ kind: 'horizontal', refs: [a, b] })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-rule-check.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/sketch/ruleCheck` (and `ruleSpecFor` is not exported).

- [ ] **Step 3: Write `frontend/app/lib/sketch/ruleCheck.ts`**

```ts
// app/lib/sketch/ruleCheck.ts
// Pen stage 6: can this rule be added? "already" — the same rule is there, or
// the others already imply it (its Jacobian rows add no rank over the part of
// the drawing it touches, and a trial solve moves nothing); "conflict" — it
// would move what it can't, the trial solve fails, or a piece collapses;
// otherwise "ok". Coincident is checked as the merge it is. Pure; the drawing
// is never changed (every trial runs on a copy).
import type { SketchDoc, SketchConstraint, EntityId } from './model'
import { cloneDoc } from './clone'
import { solve } from './solve'
import { equivalentRuleKey, type RuleSpec } from './tangency'
import { mergePoints } from './trim'
import { componentOf } from './cleanup/guards'
import { RowBasis, freeSlots, rowsFor } from './cleanup/rank'

export type MergeSpec = { merge: [EntityId, EntityId] }   // [keep, gone]
export type RuleCheck = 'ok' | 'already' | 'conflict'

// every line, straight piece, arc radius and circle radius, by a stable key
function sizes(doc: SketchDoc): Map<string, number> {
  const pt = new Map<EntityId, { x: number; y: number }>()
  for (const e of doc.entities) if (e.kind === 'point') pt.set(e.id, e)
  const d = (a?: { x: number; y: number }, b?: { x: number; y: number }) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : NaN)
  const out = new Map<string, number>()
  for (const e of doc.entities) {
    if (e.kind === 'line') out.set(e.id, d(pt.get(e.p1), pt.get(e.p2)))
    else if (e.kind === 'circle') out.set(e.id, e.r)
    else if (e.kind === 'path') {
      const n = e.anchors.length
      const count = e.closed ? n : n - 1
      for (let i = 0; i < count; i++) {
        const s = e.segments[i]
        const a = pt.get(e.anchors[i]!), b = pt.get(e.anchors[(i + 1) % n]!)
        if (s?.kind === 'line') out.set(`${e.id}:${i}`, d(a, b))
        else if (s?.kind === 'arc') out.set(`${e.id}:${i}`, d(pt.get(s.center), a))
      }
    }
  }
  return out
}
function collapsed(before: SketchDoc, after: SketchDoc): boolean {
  const b = sizes(before), a = sizes(after)
  for (const [k, v0] of b) {
    const v1 = a.get(k)
    if (Number.isFinite(v0) && v0 > 1e-9 && v1 != null && Number.isFinite(v1) && v1 < v0 * 1e-3) return true
  }
  return false
}
function span(doc: SketchDoc): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of doc.entities) if (e.kind === 'point') { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x); y1 = Math.max(y1, e.y) }
  return Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 0
}
function maxMove(before: SketchDoc, after: SketchDoc): number {
  const was = new Map<EntityId, { x: number; y: number }>()
  for (const e of before.entities) if (e.kind === 'point') was.set(e.id, e)
  let m = 0
  for (const e of after.entities) {
    if (e.kind !== 'point') continue
    const p = was.get(e.id)
    if (p) m = Math.max(m, Math.hypot(e.x - p.x, e.y - p.y))
  }
  return m
}

export function checkRule(doc: SketchDoc, spec: RuleSpec | MergeSpec): RuleCheck {
  if ('merge' in spec) {
    const [keep, gone] = spec.merge
    if (keep === gone) return 'already'
    const trial = cloneDoc(doc)
    if (!mergePoints(trial, gone, keep)) return 'conflict'
    return solve(trial, { maxIter: 120 }).converged ? 'ok' : 'conflict'
  }
  const key = equivalentRuleKey(doc, spec)
  if (doc.constraints.some(c => equivalentRuleKey(doc, c) === key)) return 'already'
  const rule: SketchConstraint = { id: '__check', kind: spec.kind, refs: [...spec.refs], ...(spec.value != null ? { value: spec.value } : {}) }
  // does it add freedom-removing rank over the part it touches?
  const part = componentOf(doc, spec.refs)
  const slots = freeSlots(part, new Set())
  const basis = new RowBasis(slots.length)
  for (const row of rowsFor(part, slots, part.constraints)) basis.add(row)
  let adds = false
  for (const row of rowsFor(part, slots, [rule])) if (basis.add(row)) adds = true
  // a trial on a copy of the whole drawing
  const trial = cloneDoc(doc)
  trial.constraints.push(rule)
  if (!solve(trial, { maxIter: 120 }).converged || collapsed(doc, trial)) return 'conflict'
  if (adds) return 'ok'
  return maxMove(doc, trial) <= 1e-5 * Math.max(1, span(doc)) ? 'already' : 'conflict'
}
```

- [ ] **Step 4: `penRules.ts`** — in `availableConstraints`, change the two-points line to:

```ts
  if (ids.length === 2 && count('point') === 2) {
    // pen stage 6 (Ruling 15): two points can also be lined up level or upright
    // (horizontal / vertical take a point pair — residuals.ts)
    out.push({ kind: 'coincident', label: 'Coincident' }, { kind: 'distance', label: 'Distance…', value: true },
      { kind: 'horizontal', label: 'Horizontal' }, { kind: 'vertical', label: 'Vertical' })
  }
```

Add the imports `import type { MergeSpec } from '~/lib/sketch/ruleCheck'` and `export type { MergeSpec }` next to the existing tangency import, and append:

```ts
/** The rule `apply` writes for this selection (pen stage 6) — the same
 *  branches, in the same order: Tangent → the tangent rule for the two
 *  pieces; one point + one segment → pointSegmentRefs; Coincident on two
 *  points → a merge (the first picked stays); segments →
 *  segmentConstraintRefs; entities → orderRefs. Null when the selection
 *  can't make it. */
export function ruleSpecFor(doc: SketchDoc, selection: EntityId[], segments: SegRef[], option: RuleOption, value?: number): RuleSpec | MergeSpec | null {
  if (option.tangent) return tangentRuleForSelection(doc, selection, segments)
  const kind = option.kind
  const v = value != null ? { value } : {}
  if (segments.length && selection.length) {
    const refs = selection.length === 1 && segments.length === 1 ? pointSegmentRefs(doc, kind, selection[0]!, segments[0]!) : null
    return refs ? { kind, refs, ...v } : null
  }
  if (kind === 'coincident' && selection.length === 2 && selection.every(id => doc.entities.find(e => e.id === id)?.kind === 'point')) {
    return { merge: [selection[0]!, selection[1]!] }
  }
  if (segments.length) {
    const refs = segmentConstraintRefs(doc, kind, segments)
    return refs ? { kind, refs, ...v } : null
  }
  if (!selection.length) return null
  return { kind, refs: orderRefs(doc, kind, selection), ...v }
}
```

- [ ] **Step 5: `usePen.ts` — `apply` through `ruleSpecFor`.** Add `ruleSpecFor` to the `./penRules` import list, and replace the whole body of `function apply(kind: ConstraintKind, value?: number) { … }` with:

```ts
  function apply(kind: ConstraintKind, value?: number) {
    const spec = ruleSpecFor(doc.value, selection.value, selectedSegments.value, { kind, label: '' }, value)
    // two points: Coincident makes them ONE point — the second picked merges
    // into the first, which stays where it is (a `coincident` rule is only
    // ever read back from older drawings)
    if (spec && 'merge' in spec) {
      const [keep, gone] = spec.merge
      const refusal = joinRefusal(gone, keep)
      if (refusal) { status.value = refusal; return }
      clearSel()
      const pairs = segmentPairs()
      if (!mergePoints(doc.value, gone, keep)) { status.value = BOTH_FIXED; return }
      pruneSelections()
      segmentsAfterMerge(pairs, gone, keep)
      runSolve()
      const k = doc.value.entities.find(e => e.id === keep)
      if (k?.kind === 'point') sparkle(k.x, k.y)
      commitHistory()
      return
    }
    // every other rule: written from ruleSpecFor (penRules.ts) — one point +
    // one segment (On curve / Midpoint), segments, or entities
    if (spec) { const id = addConstraint(doc.value, spec.kind, spec.refs, spec.value); sparkleAtConstraint(id) }
    clearSel()
    clearSegSel()
    runSolve()
    commitHistory()
  }
```

(`orderRefsFor`, `segmentConstraintRefs` and `pointSegmentRefs` may now be unused in `usePen.ts`; remove only the ones vue-tsc / eslint report as unused — `orderRefsFor` is still used by `orderRefs()`.)

- [ ] **Step 6: `pen-weld.unit.spec.ts`** — line 190 becomes:

```ts
    expect(pen.availableConstraints().map(r => r.label)).toEqual(['Coincident', 'Distance…', 'Horizontal', 'Vertical'])
```

- [ ] **Step 7: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-rule-check.unit.spec.ts tests/unit/pen-weld.unit.spec.ts tests/unit/pen-rules.unit.spec.ts tests/unit/pen-tangent-verbs.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/sketch-hv-pointpair.unit.spec.ts`
Expected: PASS. If another existing test lists the two-point rules exactly, update only that expected list the same way and name it in your report. Typecheck `ruleCheck|penRules|usePen` — nothing new.

- [ ] **Step 8: Commit** `frontend/app/lib/sketch/ruleCheck.ts frontend/app/composables/pen/penRules.ts frontend/app/composables/pen/usePen.ts frontend/tests/unit/pen-rule-check.unit.spec.ts frontend/tests/unit/pen-weld.unit.spec.ts` — message `feat(pen): the rule a selection makes and whether it can be added — already true / conflicts; two points level or upright (stage 6)`.

---

### Task 4: Copy, paste, select all and dissolve a point in the pen

**Files:**
- Create: `frontend/app/composables/pen/penReasons.ts`
- Create: `frontend/app/composables/pen/penClipboard.ts`
- Modify: `frontend/app/composables/pen/usePen.ts` (imports, a new section after Fix, the return object)
- Test: `frontend/tests/unit/pen-copy-paste.unit.spec.ts`

**Behaviour (Rulings 8, 9):**
- `copySelection()` — false with nothing picked; else puts `extractPieces` of the selection on the shared clipboard, status `Copied <heading>`, true. No history step.
- `pasteState()` — `REASON.emptyClip` with an empty clipboard, `REASON.openOnly` for a closed copy in an open-only pen, else `OK`.
- `paste(at?)` — refuses unless `pasteState().ok`; switches to Select; offset = centre the copy on `at` when given, else `k ×` the drawing delta of 16 × 16 screen px (`screenDeltaToDrawing`), k = 1, 2, 3 … per paste of the same copy (`nextPasteStep`); `insertPieces`; selects `top`; solve; one step; status `Pasted <heading>`.
- `copySvg()` — `sketchPathData(extractPieces(selection))` written to the system clipboard when there is one (errors swallowed), status `Copied as SVG`, returns the path data (`''` with nothing drawable).
- `selectAll()` — false for an empty drawing; switches to Select; selects `topLevelIds`; no step.
- `dissolveState(id)` / `dissolvePoint(id)` — the Dissolve tool's rule for one point: it must be an interior anchor of a path (an open path's two ends and a closed path under 3 anchors don't count → `REASON.notBetween`), and `canDissolve` at `DISSOLVE_PX` / `DISSOLVE_DEG` (→ `REASON.noMerge`). `dissolvePoint` runs `dissolveAt`, clears the selection, solves, one step, sparkles.

**Interfaces:**
- Consumes: Task 1 `selectionLabel`, `topLevelIds`; Task 2 `extractPieces`, `insertPieces`, `piecesCentre`, `hasClosedPieces`; `sketchPathData`.
- Produces:
  - `penReasons.ts`: `type ActionState = { ok: true } | { ok: false; reason: string }`, `OK: ActionState`, `no(reason: string): ActionState`, `REASON` (keys `already`, `conflict`, `notHere`, `nothing`, `shape`, `point`, `onePoint`, `notBetween`, `noMerge`, `emptyClip`, `openOnly`, `noPieces`).
  - `penClipboard.ts`: `PASTE_STEP_PX = 16`, `interface PenClip { doc: SketchDoc; pastes: number }`, `penClipboard: ShallowRef<PenClip | null>`, `setPenClipboard(doc)`, `nextPasteStep(): number`, `clearPenClipboard()`.
  - `usePen` returns `copySelection(): boolean`, `pasteState(): ActionState`, `paste(at?: Vec2 | null): boolean`, `copySvg(): string`, `selectAll(): boolean`, `dissolveState(id: EntityId): ActionState`, `dissolvePoint(id: EntityId): boolean`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-copy-paste.unit.spec.ts`:

```ts
// tests/unit/pen-copy-paste.unit.spec.ts
// Pen stage 6: Copy / Paste inside the pen (16 px down-right per paste, the
// copy selected, one undo step, the clipboard shared by every pen), paste
// centred on a point, open-only refusals, Option-picked segments, Select all,
// Copy as SVG, and Dissolve on one selected point.
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import { clearPenClipboard, penClipboard } from '~/composables/pen/penClipboard'
import { REASON } from '~/composables/pen/penReasons'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void = () => {}, options?: any) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV), options }) }
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const lines = (d: SketchDoc) => d.entities.filter(e => e.kind === 'line') as any[]
beforeEach(() => clearPenClipboard())

describe('Copy and Paste', () => {
  it('copies a line with its rule; each paste lands 16 px further down-right, selected, one step', () => {
    let l = ''
    const { doc, pen } = mk(d => { const a = addPoint(d, 2, 2), b = addPoint(d, 8, 2); l = addLine(d, a, b); addConstraint(d, 'horizontal', [a, b]) })
    pen.pick(l)
    expect(pen.copySelection()).toBe(true)
    expect(pen.status.value).toBe('Copied 1 line')
    expect(pen.canUndo()).toBe(false)
    expect(pen.paste()).toBe(true)
    const nl = lines(doc.value)[1]
    expect(pen.selection.value).toEqual([nl.id])
    expect(P(doc.value, nl.p1).x).toBeCloseTo(2 + 16 / 34, 9)
    expect(P(doc.value, nl.p1).y).toBeCloseTo(2 - 16 / 34, 9)
    expect(doc.value.constraints.filter(k => k.kind === 'horizontal')).toHaveLength(2)
    expect(pen.status.value).toBe('Pasted 1 line')
    pen.paste()
    expect(P(doc.value, lines(doc.value)[2].p1).x).toBeCloseTo(2 + 32 / 34, 9)
    pen.undo(); pen.undo()
    expect(lines(doc.value)).toHaveLength(1)
  })
  it('the menu’s Paste centres the copy on the point', () => {
    let l = ''
    const { doc, pen } = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 2)) })
    pen.pick(l); pen.copySelection()
    pen.paste({ x: 10, y: 10 })
    const nl = lines(doc.value)[1]
    expect(P(doc.value, nl.p1)).toMatchObject({ x: 8, y: 9 })
    expect(P(doc.value, nl.p2)).toMatchObject({ x: 12, y: 11 })
  })
  it('says why nothing can be pasted, and an open-only pen refuses closed pieces', () => {
    let c = ''
    const { pen } = mk(d => { c = addCircle(d, addPoint(d, 0, 0), 1) })
    expect(pen.pasteState()).toEqual({ ok: false, reason: REASON.emptyClip })
    pen.pick(c); pen.copySelection()
    expect(pen.pasteState().ok).toBe(true)
    const guide = mk(() => {}, { openOnly: true, tools: ['select', 'path', 'curve'] }).pen
    expect(guide.pasteState()).toEqual({ ok: false, reason: REASON.openOnly })
    expect(guide.paste()).toBe(false)
  })
  it('one clipboard for every pen on the page', () => {
    let l = ''
    const a = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)) })
    a.pen.pick(l); a.pen.copySelection()
    const b = mk()
    expect(b.pen.paste()).toBe(true)
    expect(lines(b.doc.value)).toHaveLength(1)
    expect(penClipboard.value).not.toBeNull()
  })
  it('copies Option-picked segments as pieces of their own', () => {
    let P1 = ''
    const { doc, pen } = mk(d => {
      const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 4, 3)
      P1 = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    })
    pen.pickSegment(P1, 1)
    pen.copySelection(); pen.paste()
    const paths = doc.value.entities.filter(e => e.kind === 'path') as any[]
    expect(paths).toHaveLength(2)
    expect(paths[1].anchors).toHaveLength(2)
  })
})

describe('Select all, Copy as SVG, Dissolve a point', () => {
  it('Select all picks every piece and lone point, in Select', () => {
    let l = '', lone = ''
    const { pen } = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)); lone = addPoint(d, 5, 5) })
    pen.selectTool('line')
    expect(pen.selectAll()).toBe(true)
    expect(pen.tool.value).toBe('select')
    expect(pen.selection.value.sort()).toEqual([l, lone].sort())
    expect(mk().pen.selectAll()).toBe(false)
  })
  it('Copy as SVG gives the selection’s outline', () => {
    let l = ''
    const { pen } = mk(d => { l = addLine(d, addPoint(d, 2, 2), addPoint(d, 8, 2)); addLine(d, addPoint(d, 0, 5), addPoint(d, 1, 5)) })
    pen.pick(l)
    expect(pen.copySvg()).toBe('M 2 2 L 8 2')
    expect(pen.status.value).toBe('Copied as SVG')
  })
  it('dissolves a selected point between two pieces that line up; says why it can’t otherwise', () => {
    let m = '', a = '', corner = '', P1 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); m = addPoint(d, 2, 0); const b = addPoint(d, 4, 0)
      P1 = addPath(d, [a, m, b], [{ kind: 'line' }, { kind: 'line' }])
      const x = addPoint(d, 10, 0); corner = addPoint(d, 12, 0); const y = addPoint(d, 12, 2)
      addPath(d, [x, corner, y], [{ kind: 'line' }, { kind: 'line' }])
    })
    expect(pen.dissolveState(a)).toEqual({ ok: false, reason: REASON.notBetween })
    expect(pen.dissolveState(corner)).toEqual({ ok: false, reason: REASON.noMerge })
    expect(pen.dissolveState(m)).toEqual({ ok: true })
    pen.pick(m)
    expect(pen.dissolvePoint(m)).toBe(true)
    expect(P(doc.value, P1).anchors).toHaveLength(2)
    expect(pen.selection.value).toEqual([])
    pen.undo()
    expect(P(doc.value, P1).anchors).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-copy-paste.unit.spec.ts`
Expected: FAIL — cannot resolve `~/composables/pen/penClipboard`.

- [ ] **Step 3: Create `frontend/app/composables/pen/penReasons.ts`**

```ts
// app/composables/pen/penReasons.ts
// Pen stage 6: whether an action can run now, and — when it can't — why, in
// plain words (shown in the menu item's card, the wheel's note and the
// Properties + list). Copy rules as PEN_TIPS: sentence case, typographic ’.
export type ActionState = { ok: true } | { ok: false; reason: string }
export const OK: ActionState = { ok: true }
export const no = (reason: string): ActionState => ({ ok: false, reason })

export const REASON = {
  already: 'Already true',
  conflict: 'Conflicts with another rule',
  notHere: 'Doesn’t apply to this selection',
  nothing: 'Select something first',
  shape: 'Select a shape first',
  point: 'Select a point first',
  onePoint: 'Select one point first',
  notBetween: 'This point isn’t between two pieces',
  noMerge: 'These two sides don’t line up, so they can’t merge',
  emptyClip: 'Nothing to paste',
  openOnly: 'Only open lines can go here',
  noPieces: 'Nothing to select',
} as const
```

- [ ] **Step 4: Create `frontend/app/composables/pen/penClipboard.ts`**

```ts
// app/composables/pen/penClipboard.ts
// Pen stage 6 (Ruling 8): the pen's own clipboard — module-level, so every
// pen on the page (the pen page, the Frame, Shape Studio) shares one for the
// page session. Not the system clipboard: only Copy as SVG writes that. A
// copy remembers how often it has been pasted, so each ⌘V steps 16 px further.
import { shallowRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'

export const PASTE_STEP_PX = 16
export interface PenClip { doc: SketchDoc; pastes: number }
export const penClipboard = shallowRef<PenClip | null>(null)

export function setPenClipboard(doc: SketchDoc): void { penClipboard.value = { doc: cloneDoc(doc), pastes: 0 } }
/** 1 for the first paste of this copy, 2 for the next … */
export function nextPasteStep(): number {
  const c = penClipboard.value
  if (!c) return 0
  c.pastes += 1
  return c.pastes
}
export function clearPenClipboard(): void { penClipboard.value = null }
```

- [ ] **Step 5: `usePen.ts`** — add imports:

```ts
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { extractPieces, insertPieces, piecesCentre, hasClosedPieces } from '~/lib/sketch/clipboard'
import { selectionLabel, topLevelIds } from '~/lib/sketch/pieces'
import { penClipboard, setPenClipboard, nextPasteStep, PASTE_STEP_PX } from './penClipboard'
import { OK, no, REASON, type ActionState } from './penReasons'
```

After `fixSelected()` (before the `// --- Clean up` section) add:

```ts
  // --- Copy / Paste / Select all / Dissolve a point (pen stage 6) ---
  // The pen's own clipboard (penClipboard.ts) holds a copy of the pieces and
  // the rules among them, shared by every pen on the page; pasting gives the
  // pieces fresh ids (lib/sketch/clipboard.ts). Copy as SVG writes the
  // selection's outline — the pen page's Copy SVG format — to the system
  // clipboard. Copy and Select all write no history; Paste and Dissolve are
  // one step each.
  const hasPick = () => selection.value.length > 0 || selectedSegments.value.length > 0
  function copySelection(): boolean {
    if (!hasPick()) return false
    const clip = extractPieces(doc.value, selection.value, selectedSegments.value)
    if (!clip.entities.length) return false
    setPenClipboard(clip)
    status.value = `Copied ${selectionLabel(doc.value, selection.value, selectedSegments.value)}`
    return true
  }
  function pasteState(): ActionState {
    const c = penClipboard.value
    if (!c) return no(REASON.emptyClip)
    if (openOnly && hasClosedPieces(c.doc)) return no(REASON.openOnly)
    return OK
  }
  // `at` (the menu's Paste): the copy's centre lands there; else (⌘V) 16 px
  // down-right on screen of where it was copied, 16 px more per paste
  function paste(at?: Vec2 | null): boolean {
    if (!pasteState().ok) return false
    const c = penClipboard.value!
    if (tool.value !== 'select') selectTool('select')
    let offset: Vec2 = { x: 0, y: 0 }
    if (at) {
      const ctr = piecesCentre(c.doc)
      offset = { x: at.x - ctr.x, y: at.y - ctr.y }
    } else {
      const step = screenDeltaToDrawing(opts.view.value, PASTE_STEP_PX, PASTE_STEP_PX)
      const k = nextPasteStep()
      if (step) offset = { x: step.x * k, y: step.y * k }
    }
    const { top } = insertPieces(doc.value, c.doc, offset)
    clearSegSel()
    selection.value = top
    runSolve()
    commitHistory()
    status.value = `Pasted ${selectionLabel(doc.value, top, [])}`
    return true
  }
  function copySvg(): string {
    if (!hasPick()) return ''
    const d = sketchPathData(extractPieces(doc.value, selection.value, selectedSegments.value))
    if (!d) return ''
    try { if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(d)?.catch?.(() => {}) } catch {}
    status.value = 'Copied as SVG'
    return d
  }
  function selectAll(): boolean {
    const ids = topLevelIds(doc.value)
    if (!ids.length) return false
    if (tool.value !== 'select') selectTool('select')
    clearSegSel()
    selection.value = ids
    return true
  }
  // Dissolve on one selected point: it must sit between two pieces of a path
  // (an open path's ends don't) — the Dissolve tool's rule
  function dissolveSpot(id: EntityId): { pathId: EntityId; anchorIndex: number } | null {
    for (const e of doc.value.entities) {
      if (e.kind !== 'path') continue
      const n = e.anchors.length
      for (let k = 0; k < n; k++) {
        if (e.anchors[k] !== id) continue
        if (e.closed ? n >= 3 : k > 0 && k < n - 1) return { pathId: e.id, anchorIndex: k }
      }
    }
    return null
  }
  function dissolveState(id: EntityId): ActionState {
    const s = dissolveSpot(id)
    if (!s) return no(REASON.notBetween)
    return canDissolve(doc.value, s.pathId, s.anchorIndex, pxToUnits(DISSOLVE_PX, opts.view.value), DISSOLVE_DEG) ? OK : no(REASON.noMerge)
  }
  function dissolvePoint(id: EntityId): boolean {
    const s = dissolveSpot(id)
    const p = doc.value.entities.find(e => e.id === id)
    if (!s || p?.kind !== 'point') return false
    const { x, y } = p
    const res = dissolveAt(doc.value, s.pathId, s.anchorIndex, pxToUnits(DISSOLVE_PX, opts.view.value), DISSOLVE_DEG)
    if (!res.ok) { status.value = DISSOLVE_REFUSED; return false }
    clearSel()
    clearSegSel()
    runSolve()
    commitHistory()
    sparkle(x, y)
    return true
  }
```

In the return object add a line after the Clean up group:

```ts
    // copy / paste / select all / dissolve a point (pen stage 6)
    copySelection, pasteState, paste, copySvg, selectAll, dissolveState, dissolvePoint,
```

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-copy-paste.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-trim.unit.spec.ts`
Expected: PASS. Typecheck `penReasons|penClipboard|usePen` — nothing new.

- [ ] **Step 7: Commit** `frontend/app/composables/pen/penReasons.ts frontend/app/composables/pen/penClipboard.ts frontend/app/composables/pen/usePen.ts frontend/tests/unit/pen-copy-paste.unit.spec.ts` — message `feat(pen): copy and paste inside the pen, select all, dissolve a selected point (stage 6)`.

---

### Task 5: Typed sizes and the hover highlight

**Files:**
- Create: `frontend/app/lib/sketch/sizes.ts`
- Modify: `frontend/app/composables/pen/usePen.ts` (a Properties section, `highlight`, `view` in the return object)
- Test: `frontend/tests/unit/pen-sizes.unit.spec.ts`

**Behaviour (Ruling 13):**
- `sizeTargetFor(doc, sel, segs)`: exactly one point / line / circle entity, or exactly one Option-picked segment, or exactly one whole path with one piece → the target; a cubic piece or anything else → `null`.
- `measureSizes(doc, target, view)`: point `{ x, y, fixed }`; line `{ length, angle, fixed }` (`fixed` = both ends fixed; angle via `screenAngleDeg`); arc `{ radius, length, sweep, locked }` (sweep in degrees from `curveGeom`'s `sweepAngle`; `locked` = a `distance [c, s]` pin, either order); circle `{ radius, locked }` (`locked` = a `radius` rule on it).
- In the pen, every typed size first runs on a copy (`solve`, 120 iterations, the same drag / temporary rule); a failed solve refuses with status `SIZE_REFUSED = 'That size can’t be kept with these rules'` and changes nothing; else the same edit runs on the drawing (`runSolve`), a temporary rule is removed, one step.
  - `setPointXY(id, x, y)`: refuses a fixed point (`status 'Fixed points stay where they are'`); drag the point to (x, y).
  - `setLineLength(a, b, len)` (`len > 0`): drag b to `a + unit(b − a) · len`; if b is fixed, drag a the other way; both fixed → refuse.
  - `setLineAngle(a, b, deg)`: the same with the direction `drawingDirForScreenAngle(view, deg)` and the current length.
  - `setArcRadiusValue(pathId, segIndex, r)` (`r > 0`): locked → set the pin's value; else a temporary `distance [c, s] = r`.
  - `setArcSweep(pathId, segIndex, deg)`: clamp to [0.5, 359.5]; drag the end to `arcEndForSweep(...)`; refuse if the end is fixed. `setArcLength(pathId, segIndex, len)` = `setArcSweep` with `len / r` radians in degrees.
  - `toggleArcRadiusLock(pathId, segIndex)`: a pin → `removeConstraintById(pin)`; else `setArcRadius(pathId, segIndex, current r)` (the chip's own pin, its own step).
  - `setCircleRadius(id, r)`: locked → set the rule's value; else set `r` and a temporary `radius` rule. `toggleCircleRadiusLock(id)`: remove the rule, or add `radius [id] = r` (solve, one step).
- `highlight: ShallowRef<PieceRef[]>` and `setHighlight(pieces)` — view state for the Properties hover (no history).
- `usePen` returns `view: opts.view` (Properties needs it for angles).

**Interfaces:**
- Consumes: Task 1 `PieceRef`, `SegPick`, `segCount`; `curveGeom` (`lib/sketch/crossings.ts`), `invertView` (`lib/sketch/view.ts`).
- Produces:
  - `sizes.ts`: `type SizeTarget = { kind: 'point'; id } | { kind: 'line'; a; b; piece: PieceRef } | { kind: 'arc'; pathId; segIndex; c; s; e } | { kind: 'circle'; id; c }`, `interface Sizes { x?; y?; length?; angle?; radius?; sweep?; locked?; fixed? }` (numbers / booleans), `sizeTargetFor(doc, sel, segs): SizeTarget | null`, `measureSizes(doc, t, view): Sizes`, `screenAngleDeg(view, d: Vec2): number`, `drawingDirForScreenAngle(view, deg): Vec2 | null`, `arcEndForSweep(c: Vec2, s: Vec2, dir: 1 | -1, deg: number): Vec2`, `radiusPinOf(doc, c, s): SketchConstraint | undefined`, `circleRadiusRuleOf(doc, id): SketchConstraint | undefined`, `SIZE_REFUSED`.
  - `usePen` returns `view`, `highlight`, `setHighlight(p: PieceRef[])`, `setPointXY`, `setLineLength`, `setLineAngle`, `setArcRadiusValue`, `setArcSweep`, `setArcLength`, `toggleArcRadiusLock`, `setCircleRadius`, `toggleCircleRadiusLock` (each setter returns `boolean`).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-sizes.unit.spec.ts`:

```ts
// tests/unit/pen-sizes.unit.spec.ts
// Pen stage 6, the Properties panel's sizes: what is measured for a point, a
// line, an arc and a circle; a typed size moves the drawing as one step,
// rules permitting (refused otherwise, nothing changed); the radius lock is
// the arc's pin / the circle's radius rule; angles read as on screen.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import { sizeTargetFor, measureSizes, screenAngleDeg, SIZE_REFUSED } from '~/lib/sketch/sizes'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }   // y up on screen
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const dist = (d: SketchDoc, a: string, b: string) => Math.hypot(P(d, a).x - P(d, b).x, P(d, a).y - P(d, b).y)

describe('what is measured', () => {
  it('a point, a line, a quarter arc (as a segment or a one-piece path), a circle', () => {
    let a = '', b = '', l = '', s = '', e = '', c = '', arc = '', circle = ''
    const { doc } = mk(d => {
      a = addPoint(d, 1, 1); b = addPoint(d, 4, 5); l = addLine(d, a, b)
      s = addPoint(d, 10, 0); e = addPoint(d, 12, 2); c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 0 }])
      circle = addCircle(d, addPoint(d, 20, 0), 1.5)
    })
    const m = (sel: string[], segs: any[] = []) => measureSizes(doc.value, sizeTargetFor(doc.value, sel, segs)!, DEV)
    expect(m([a])).toMatchObject({ x: 1, y: 1, fixed: false })
    expect(m([l]).length).toBeCloseTo(5, 9)
    expect(m([l]).angle).toBeCloseTo(Math.atan2(4, 3) * 180 / Math.PI, 9)
    const q = m([], [{ pathId: arc, segIndex: 0 }])   // (10,0) → (12,2) clockwise round (12,0): a quarter
    expect(q.radius).toBeCloseTo(2, 9); expect(q.sweep).toBeCloseTo(90, 6); expect(q.length).toBeCloseTo(Math.PI, 6)
    expect(q.locked).toBe(false)
    expect(m([arc]).radius).toBeCloseTo(2, 9)
    expect(m([circle])).toMatchObject({ radius: 1.5, locked: false })
    expect(sizeTargetFor(doc.value, [a, b], [])).toBeNull()
  })
  it('reads angles as on screen, whichever way the view is mirrored', () => {
    const flipped = { a: 10, b: 0, c: 0, d: 10, e: 0, f: 0 }   // y down on screen
    expect(screenAngleDeg(DEV, { x: 0, y: 1 })).toBeCloseTo(90, 9)
    expect(screenAngleDeg(flipped, { x: 0, y: 1 })).toBeCloseTo(-90, 9)
  })
})

describe('typed sizes', () => {
  it('a point moves to the typed spot as one step; a fixed one refuses', () => {
    let a = '', f = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 1, 1); f = addPoint(d, 3, 3, { fixed: true }) })
    expect(pen.setPointXY(a, 2.5, -1)).toBe(true)
    expect(P(doc.value, a)).toMatchObject({ x: 2.5, y: -1 })
    expect(pen.setPointXY(f, 0, 0)).toBe(false)
    expect(P(doc.value, f)).toMatchObject({ x: 3, y: 3 })
    pen.undo()
    expect(P(doc.value, a)).toMatchObject({ x: 1, y: 1 })
  })
  it('a line’s length keeps its first end; its angle turns it on screen', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 3, 4); addLine(d, a, b) })
    pen.setLineLength(a, b, 10)
    expect(P(doc.value, a)).toMatchObject({ x: 0, y: 0 })
    expect(dist(doc.value, a, b)).toBeCloseTo(10, 6)
    pen.setLineAngle(a, b, 90)
    expect(P(doc.value, b).x).toBeCloseTo(0, 6)
    expect(P(doc.value, b).y).toBeCloseTo(10, 6)
  })
  it('a size the rules can’t keep is refused and nothing moves', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0, { fixed: true }); b = addPoint(d, 4, 0); addLine(d, a, b)
      addConstraint(d, 'distance', [a, b], 4)
    })
    expect(pen.setLineLength(a, b, 7)).toBe(false)
    expect(pen.status.value).toBe(SIZE_REFUSED)
    expect(P(doc.value, b)).toMatchObject({ x: 4, y: 0 })
    expect(pen.canUndo()).toBe(false)
  })
  it('an arc: a one-off radius leaves no rule; the lock pins it and a typed radius moves the pin', () => {
    let arc = '', s = '', c = ''
    const { doc, pen } = mk(d => {
      s = addPoint(d, 10, 0); const e = addPoint(d, 12, 2); c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 0 }])
    })
    const rules = doc.value.constraints.length
    expect(pen.setArcRadiusValue(arc, 0, 3)).toBe(true)
    expect(dist(doc.value, c, s)).toBeCloseTo(3, 5)
    expect(doc.value.constraints.length).toBe(rules)
    pen.toggleArcRadiusLock(arc, 0)
    const pin = doc.value.constraints.find(k => k.kind === 'distance')!
    expect(pin.value).toBeCloseTo(3, 5)
    pen.setArcRadiusValue(arc, 0, 4)
    expect(doc.value.constraints.find(k => k.id === pin.id)!.value).toBe(4)
    expect(dist(doc.value, c, s)).toBeCloseTo(4, 5)
    pen.toggleArcRadiusLock(arc, 0)
    expect(doc.value.constraints.some(k => k.kind === 'distance')).toBe(false)
  })
  it('an arc’s sweep and length move its end round the centre', () => {
    let arc = '', e = '', c = ''
    const { doc, pen } = mk(d => {
      const s = addPoint(d, 10, 0); e = addPoint(d, 12, -2); c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])   // 90°, counter-clockwise (π → 3π/2)
    })
    pen.setArcSweep(arc, 0, 180)
    expect(P(doc.value, e).x).toBeCloseTo(14, 5); expect(P(doc.value, e).y).toBeCloseTo(0, 5)
    pen.setArcLength(arc, 0, Math.PI)       // r = 2 → 90°
    expect(P(doc.value, e).x).toBeCloseTo(12, 5); expect(P(doc.value, e).y).toBeCloseTo(-2, 5)
  })
  it('a circle: one-off radius, then the lock', () => {
    let c = ''
    const { doc, pen } = mk(d => { c = addCircle(d, addPoint(d, 0, 0), 1) })
    pen.setCircleRadius(c, 2)
    expect(P(doc.value, c).r).toBeCloseTo(2, 6)
    expect(doc.value.constraints).toHaveLength(0)
    pen.toggleCircleRadiusLock(c)
    expect(doc.value.constraints[0]).toMatchObject({ kind: 'radius', refs: [c], value: 2 })
    pen.setCircleRadius(c, 3)
    expect(doc.value.constraints[0]!.value).toBe(3)
  })
  it('the hover highlight is view state only', () => {
    let l = ''
    const { pen } = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)) })
    pen.setHighlight([{ kind: 'line', id: l }])
    expect(pen.highlight.value).toEqual([{ kind: 'line', id: l }])
    expect(pen.canUndo()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-sizes.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/sketch/sizes`.

- [ ] **Step 3: Write `frontend/app/lib/sketch/sizes.ts`**

```ts
// app/lib/sketch/sizes.ts
// Pen stage 6, the Properties panel's sizes (Ruling 13): which piece the
// selection is (a point, a line, an arc, a circle), what is measured for it,
// angles as seen on screen, where an arc's end goes for a typed sweep, and the
// rules the radius lock stands for (an arc's distance pin between its centre
// and start — the chip's own —, a circle's radius rule). Pure.
import type { SketchDoc, SketchConstraint, EntityId } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { invertView, type ViewMatrix } from './view'
import { curveGeom } from './crossings'
import { segCount, type PieceRef, type SegPick } from './pieces'

export const SIZE_REFUSED = 'That size can’t be kept with these rules'

export type SizeTarget =
  | { kind: 'point'; id: EntityId }
  | { kind: 'line'; a: EntityId; b: EntityId; piece: PieceRef }
  | { kind: 'arc'; pathId: EntityId; segIndex: number; c: EntityId; s: EntityId; e: EntityId }
  | { kind: 'circle'; id: EntityId; c: EntityId }

export interface Sizes { x?: number; y?: number; length?: number; angle?: number; radius?: number; sweep?: number; locked?: boolean; fixed?: boolean }

export function sizeTargetFor(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): SizeTarget | null {
  let seg: SegPick | null = null
  if (!sel.length && segs.length === 1) seg = segs[0]!
  else if (sel.length === 1 && !segs.length) {
    const e = getEntity(doc, sel[0]!)
    if (!e) return null
    if (e.kind === 'point') return { kind: 'point', id: e.id }
    if (e.kind === 'line') return { kind: 'line', a: e.p1, b: e.p2, piece: { kind: 'line', id: e.id } }
    if (e.kind === 'circle') return { kind: 'circle', id: e.id, c: e.center }
    if (segCount(e) === 1) seg = { pathId: e.id, segIndex: 0 }
  }
  if (!seg) return null
  const p = getEntity(doc, seg.pathId)
  if (!p || p.kind !== 'path') return null
  const s = p.segments[seg.segIndex]
  const a = p.anchors[seg.segIndex], b = p.anchors[(seg.segIndex + 1) % p.anchors.length]
  if (!s || !a || !b) return null
  if (s.kind === 'line') return { kind: 'line', a, b, piece: { kind: 'seg', ...seg } }
  if (s.kind === 'arc') return { kind: 'arc', pathId: seg.pathId, segIndex: seg.segIndex, c: s.center, s: a, e: b }
  return null
}

/** 0° pointing right on screen, counter-clockwise positive, in (−180, 180]. */
export function screenAngleDeg(view: ViewMatrix, d: Vec2): number {
  const sx = view.a * d.x + view.c * d.y, sy = view.b * d.x + view.d * d.y
  let a = Math.atan2(-sy, sx) * 180 / Math.PI
  if (a <= -180) a += 360
  return a
}
/** The unit drawing direction that reads as `deg` on screen. */
export function drawingDirForScreenAngle(view: ViewMatrix, deg: number): Vec2 | null {
  const inv = invertView(view)
  if (!inv) return null
  const r = deg * Math.PI / 180
  const sx = Math.cos(r), sy = -Math.sin(r)
  const x = inv.a * sx + inv.c * sy, y = inv.b * sx + inv.d * sy
  const n = Math.hypot(x, y)
  return n > 1e-12 ? { x: x / n, y: y / n } : null
}
/** The end of an arc from `s` round `c`, `deg` degrees in direction `dir` (+1 counter-clockwise in drawing units). */
export function arcEndForSweep(c: Vec2, s: Vec2, dir: 1 | -1, deg: number): Vec2 {
  const r = Math.hypot(s.x - c.x, s.y - c.y)
  const a = Math.atan2(s.y - c.y, s.x - c.x) + dir * deg * Math.PI / 180
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }
}
export function radiusPinOf(doc: SketchDoc, c: EntityId, s: EntityId): SketchConstraint | undefined {
  return doc.constraints.find(k => k.kind === 'distance' && ((k.refs[0] === c && k.refs[1] === s) || (k.refs[0] === s && k.refs[1] === c)))
}
export function circleRadiusRuleOf(doc: SketchDoc, id: EntityId): SketchConstraint | undefined {
  return doc.constraints.find(k => k.kind === 'radius' && k.refs[0] === id)
}

export function measureSizes(doc: SketchDoc, t: SizeTarget, view: ViewMatrix): Sizes {
  if (t.kind === 'point') {
    const p = getPoint(doc, t.id)
    return p ? { x: p.x, y: p.y, fixed: !!p.fixed } : {}
  }
  if (t.kind === 'line') {
    const a = getPoint(doc, t.a), b = getPoint(doc, t.b)
    if (!a || !b) return {}
    return { length: Math.hypot(b.x - a.x, b.y - a.y), angle: screenAngleDeg(view, { x: b.x - a.x, y: b.y - a.y }), fixed: !!a.fixed && !!b.fixed }
  }
  if (t.kind === 'arc') {
    const g = curveGeom(doc, { kind: 'seg', pathId: t.pathId, segIndex: t.segIndex })
    if (!g || g.kind !== 'arc') return {}
    const sweep = Math.abs(g.sweepAngle!)
    return { radius: g.r!, length: g.r! * sweep, sweep: sweep * 180 / Math.PI, locked: !!radiusPinOf(doc, t.c, t.s) }
  }
  const e = getEntity(doc, t.id)
  return e?.kind === 'circle' ? { radius: e.r, locked: !!circleRadiusRuleOf(doc, t.id) } : {}
}
```

- [ ] **Step 4: `usePen.ts`** — imports:

```ts
import type { PieceRef } from '~/lib/sketch/pieces'
import { SIZE_REFUSED, drawingDirForScreenAngle, arcEndForSweep, radiusPinOf, circleRadiusRuleOf } from '~/lib/sketch/sizes'
```

(`curveGeom` and `solve` are already imported.) After the Task 4 section add:

```ts
  // --- Properties: typed sizes and the hover highlight (pen stage 6) ---
  // A typed size runs first on a copy (the same drag or temporary rule); a
  // solve that fails refuses it and changes nothing. Else the same edit runs
  // on the drawing, any temporary rule goes again, and it is one step.
  type SizeEdit = { drag?: DragTarget; temp?: { kind: ConstraintKind; refs: EntityId[]; value: number } }
  function tryEdit(edit: (d: SketchDoc) => SizeEdit | null): boolean {
    const trial = cloneDoc(doc.value)
    const plan = edit(trial)
    if (!plan) return false
    if (plan.temp) trial.constraints.push({ id: '__size', kind: plan.temp.kind, refs: [...plan.temp.refs], value: plan.temp.value })
    if (!solve(trial, { maxIter: 120, drag: plan.drag }).converged) { status.value = SIZE_REFUSED; return false }
    const real = edit(doc.value)!
    const tempId = real.temp ? addConstraint(doc.value, real.temp.kind, real.temp.refs, real.temp.value) : null
    runSolve(real.drag)
    if (tempId) removeConstraint(doc.value, tempId)
    commitHistory()
    return true
  }
  const ptOf = (d: SketchDoc, id: EntityId) => { const p = d.entities.find(e => e.id === id); return p?.kind === 'point' ? p : null }
  function setPointXY(id: EntityId, x: number, y: number): boolean {
    const p = ptOf(doc.value, id)
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return false
    if (p.fixed) { status.value = 'Fixed points stay where they are'; return false }
    return tryEdit(() => ({ drag: { point: id, x, y } }))
  }
  // move the free end of a–b so it runs `len` along `dir` from the other end
  function moveLineEnd(a: EntityId, b: EntityId, dirOf: (A: Vec2, B: Vec2) => Vec2 | null, lenOf: (A: Vec2, B: Vec2) => number): boolean {
    return tryEdit(d => {
      const A = ptOf(d, a), B = ptOf(d, b)
      if (!A || !B || (A.fixed && B.fixed)) return null
      const dir = dirOf(A, B), len = lenOf(A, B)
      if (!dir || !(len > 0)) return null
      if (!B.fixed) return { drag: { point: b, x: A.x + dir.x * len, y: A.y + dir.y * len } }
      return { drag: { point: a, x: B.x - dir.x * len, y: B.y - dir.y * len } }
    })
  }
  const unit = (A: Vec2, B: Vec2): Vec2 | null => { const n = Math.hypot(B.x - A.x, B.y - A.y); return n > 1e-12 ? { x: (B.x - A.x) / n, y: (B.y - A.y) / n } : null }
  function setLineLength(a: EntityId, b: EntityId, len: number): boolean {
    if (!(len > 0)) return false
    return moveLineEnd(a, b, unit, () => len)
  }
  function setLineAngle(a: EntityId, b: EntityId, deg: number): boolean {
    if (!Number.isFinite(deg)) return false
    return moveLineEnd(a, b, () => drawingDirForScreenAngle(opts.view.value, deg), (A, B) => Math.hypot(B.x - A.x, B.y - A.y))
  }
  function arcParts(d: SketchDoc, pathId: EntityId, segIndex: number) {
    const p = d.entities.find(e => e.id === pathId)
    if (p?.kind !== 'path') return null
    const seg = p.segments[segIndex]
    if (seg?.kind !== 'arc') return null
    const s = p.anchors[segIndex]!, e = p.anchors[(segIndex + 1) % p.anchors.length]!
    return { c: seg.center, s, e, sweep: seg.sweep }
  }
  function setArcRadiusValue(pathId: EntityId, segIndex: number, r: number): boolean {
    if (!(r > 0)) return false
    return tryEdit(d => {
      const a = arcParts(d, pathId, segIndex)
      if (!a) return null
      const pin = radiusPinOf(d, a.c, a.s)
      if (pin) { pin.value = r; return {} }
      return { temp: { kind: 'distance', refs: [a.c, a.s], value: r } }
    })
  }
  function setArcSweep(pathId: EntityId, segIndex: number, deg: number): boolean {
    if (!Number.isFinite(deg)) return false
    const sweepDeg = Math.min(359.5, Math.max(0.5, deg))
    return tryEdit(d => {
      const a = arcParts(d, pathId, segIndex)
      const C = a && ptOf(d, a.c), S = a && ptOf(d, a.s), E = a && ptOf(d, a.e)
      if (!a || !C || !S || !E || E.fixed) return null
      const to = arcEndForSweep(C, S, a.sweep === 1 ? 1 : -1, sweepDeg)
      return { drag: { point: a.e, x: to.x, y: to.y } }
    })
  }
  function setArcLength(pathId: EntityId, segIndex: number, len: number): boolean {
    const a = arcParts(doc.value, pathId, segIndex)
    const C = a && ptOf(doc.value, a.c), S = a && ptOf(doc.value, a.s)
    if (!C || !S || !(len > 0)) return false
    const r = Math.hypot(S.x - C.x, S.y - C.y)
    return r > 1e-12 ? setArcSweep(pathId, segIndex, (len / r) * 180 / Math.PI) : false
  }
  function toggleArcRadiusLock(pathId: EntityId, segIndex: number): void {
    const a = arcParts(doc.value, pathId, segIndex)
    const C = a && ptOf(doc.value, a.c), S = a && ptOf(doc.value, a.s)
    if (!a || !C || !S) return
    const pin = radiusPinOf(doc.value, a.c, a.s)
    if (pin) removeConstraintById(pin.id)
    else setArcRadius(pathId, segIndex, Math.hypot(S.x - C.x, S.y - C.y))
  }
  function setCircleRadius(id: EntityId, r: number): boolean {
    if (!(r > 0)) return false
    return tryEdit(d => {
      const c = d.entities.find(e => e.id === id)
      if (c?.kind !== 'circle') return null
      const rule = circleRadiusRuleOf(d, id)
      if (rule) { rule.value = r; return {} }
      c.r = r
      return { temp: { kind: 'radius', refs: [id], value: r } }
    })
  }
  function toggleCircleRadiusLock(id: EntityId): void {
    const c = doc.value.entities.find(e => e.id === id)
    if (c?.kind !== 'circle') return
    const rule = circleRadiusRuleOf(doc.value, id)
    if (rule) { removeConstraintById(rule.id); return }
    addConstraint(doc.value, 'radius', [id], c.r)
    runSolve()
    commitHistory()
  }
  // what the Properties panel lights while a rule row is hovered — view state
  const highlight = shallowRef<PieceRef[]>([])
  function setHighlight(p: PieceRef[]): void { highlight.value = p }
```

Return object: add `view: opts.view,` after `options,`; and a line:

```ts
    // Properties (pen stage 6)
    highlight, setHighlight, setPointXY, setLineLength, setLineAngle, setArcRadiusValue, setArcSweep, setArcLength,
    toggleArcRadiusLock, setCircleRadius, toggleCircleRadiusLock,
```

In `dispose()` add `highlight.value = []`.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-sizes.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/sketch-arc-dim.unit.spec.ts`
Expected: PASS. Typecheck `sizes|usePen` — nothing new.

- [ ] **Step 6: Commit** `frontend/app/lib/sketch/sizes.ts frontend/app/composables/pen/usePen.ts frontend/tests/unit/pen-sizes.unit.spec.ts` — message `feat(pen): typed sizes — point, line, arc and circle, rules permitting; radius lock; hover highlight (stage 6)`.

---

### Task 6: The action registry, the menu and wheel state, and the new keys

**Files:**
- Create: `frontend/app/composables/pen/penActions.ts`
- Modify: `frontend/app/composables/pen/usePen.ts` (menu / wheel section, action host, `onKeydown` routing, session ends, return object)
- Modify: `frontend/app/composables/pen/penKeys.ts` (`runKeyAction`, the six keys)
- Test: `frontend/tests/unit/pen-actions.unit.spec.ts`

**Behaviour (Rulings 1–7, 19):**
- `ACTIONS` (ids = their `PEN_TIPS` ids): `fix`, `dissolve-point`, `construction` (Make guide, X), `flip-h` (⇧H), `flip-v` (⇧V), `mirror` (Mirror…), `repeat` (Repeat…), `copy` (⌘C), `copy-svg`, `paste` (⌘V), `delete` (⌫, danger), `select-all` (⌘A) — each `{ label, tip, key?, danger?, shown?, state, run }`; states in the table below.
- Rule items: `ruleItems(host)` — one per `availableConstraints()` option, id `rule:<tip ?? kind>`, state from `ruleState` (`ruleSpecFor` at the current measured value for value rules → `checkRule`).
- `menuFor(host)`, `runItem(host, id, at)`, `wheelFor(host)`, `wheelDirAt(dx, dy)`.
- The pen: `menu` / `wheel` shallowRefs; `openMenu(at, drawingAt)` (not while previewing Clean up), `closeMenu()`, `closeMenus()`, `setMenuActive(id | null)`, `runMenuItem(id)` (a greyed item does nothing, the menu stays; else close, then run), `openWheel(at): boolean`, `wheelPointer(at)`, `releaseWheel()`, `closeWheel()`, `ruleItems()`, `runAction(id, at?)`. `onKeydown`: Clean up first; then an open menu (Ruling 6 — a ⌘/Ctrl combo closes it and falls through to the usual handling); then an open wheel. Session ends (`selectTool`, `undo`, `redo`, `reset`, `revert`, `finishSession`, `endGesture`, `dispose`, `startCleanup`) call `closeMenus()` first.
- Keys (Ruling 7) through `ctx.runKeyAction(id)`: runs `ACTIONS[id]` when its state is ok and returns true; otherwise false (the key isn't the pen's).

| Action | Shown in the menu | Greyed when (reason) |
|---|---|---|
| Fix | a point is selected | no point (`point`); every selected point already fixed (`already`) |
| Dissolve | exactly one point, no segments | not exactly one point (`onePoint`); `dissolveState` |
| Make guide | always | no selected piece that isn't a point (`shape`) |
| Flip horizontal / vertical | always | the selection's point closure has under 2 points (`shape`) |
| Mirror… | always | nothing selected that isn't a line (`shape`) — `doMirror`'s own rule |
| Repeat… | always | no selected piece that isn't a point (`shape`) |
| Copy | always | nothing picked (`nothing`) |
| Copy as SVG | always | no piece that isn't a point and no segment (`shape`) |
| Paste | always | `pasteState` |
| Delete | always | nothing picked (`nothing`) |
| Select all | (empty menu) | nothing to select (`noPieces`) |

**Interfaces:**
- Consumes: Task 3 `ruleSpecFor`, `checkRule`; Task 4 `penReasons`, verbs; Task 1 `selectionLabel`, `topLevelIds`; `RuleOption`, `SegRef` from `penRules.ts`; `pointClosure`.
- Produces:
  - `penActions.ts`: `interface PenActionHost { doc; selection; selectedSegments; availableConstraints(); applyWithValue(o); fixSelected(); dissolveState(id); dissolvePoint(id); makeConstruction(); flip(axis); doMirror(); repeatPrompt(); copySelection(); copySvg(); pasteState(); paste(at?); del(); selectAll() }`, `interface ActionDef`, `ACTIONS: Record<string, ActionDef>`, `SELECTION_MENU: string[][]`, `EMPTY_MENU: string[][]`, `interface PenMenuItem { id; label; tip; key?; danger?; state: ActionState }`, `ruleItemId(o)`, `ruleState(doc, sel, segs, o): ActionState`, `ruleItems(host): PenMenuItem[]`, `actionItem(host, id): PenMenuItem`, `menuFor(host): { header: string | null; groups: PenMenuItem[][] }`, `runItem(host, id, at: Vec2 | null): void`, `type WheelDir`, `WHEEL_DIRS`, `WHEEL_LAYOUTS`, `interface WheelSlice { dir; id; label; state }`, `wheelFor(host): { layout: 'point' | 'segment'; slices: WheelSlice[] } | null`, `wheelDirAt(dx, dy): WheelDir | null`, `WHEEL_OPEN_PX = 12`, `WHEEL_DEAD_PX = 24`, `WHEEL_R = 100`, `WHEEL_LABEL_R = 66`.
  - `usePen` returns `menu`, `wheel`, `openMenu`, `closeMenu`, `closeMenus`, `setMenuActive`, `runMenuItem`, `openWheel`, `wheelPointer`, `releaseWheel`, `closeWheel`, `ruleItems`, `runAction`; `export interface PenMenu { at: Vec2; drawingAt: Vec2 | null; header: string | null; groups: PenMenuItem[][]; active: string | null }`, `export interface PenWheel { at: Vec2; layout: 'point' | 'segment'; slices: WheelSlice[]; hover: WheelDir | null }`.
  - `penKeys.ts`: `PenKeyContext.runKeyAction: (id: string) => boolean`; `export function isActionKey(ev: KeyboardEvent): boolean` (X, ⇧H, ⇧V).

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-actions.unit.spec.ts`:

```ts
// tests/unit/pen-actions.unit.spec.ts
// Pen stage 6: the one action registry — the list menu for a selection and
// for empty space (heading, rules, actions with keys, greyed with reasons,
// stage 8's items absent), the wheel's point and segment layouts, the keys
// while a menu or wheel is open, the new shortcut keys, and every session
// end closing them.
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import { SELECTION_MENU, ACTIONS, wheelDirAt } from '~/composables/pen/penActions'
import { clearPenClipboard } from '~/composables/pen/penClipboard'
import { REASON } from '~/composables/pen/penReasons'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void = () => {}) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}
const key = (k: string, o: Record<string, unknown> = {}) =>
  ({ key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...o }) as unknown as KeyboardEvent
const items = (pen: ReturnType<typeof usePen>) => pen.menu.value!.groups.flat()
const item = (pen: ReturnType<typeof usePen>, id: string) => items(pen).find(i => i.id === id)
let l1 = '', l2 = '', a = '', b = ''
function twoLines(d: SketchDoc) {
  a = addPoint(d, 2, 2); b = addPoint(d, 8, 2); l1 = addLine(d, a, b)
  l2 = addLine(d, addPoint(d, 2, 5), addPoint(d, 8, 6))
}
beforeEach(() => clearPenClipboard())

describe('the list menu', () => {
  it('for one line: heading, its rules, then the actions with their keys', () => {
    const { pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 100, y: 100 }, { x: 5, y: 5 })
    const m = pen.menu.value!
    expect(m.header).toBe('1 line')
    expect(m.groups[0]!.map(i => i.id)).toEqual(['rule:horizontal', 'rule:vertical'])
    expect(m.groups.slice(1).map(g => g.map(i => i.id))).toEqual([
      ['construction', 'flip-h', 'flip-v', 'mirror', 'repeat'], ['copy', 'copy-svg', 'paste'], ['delete']])
    expect(item(pen, 'construction')!.key).toBe('X')
    expect(item(pen, 'flip-h')!.key).toBe('⇧H')
    expect(item(pen, 'mirror')!.state).toEqual({ ok: false, reason: REASON.shape })
    expect(item(pen, 'paste')!.state).toEqual({ ok: false, reason: REASON.emptyClip })
  })
  it('stage 8’s items are absent, not greyed', () => {
    expect(SELECTION_MENU.flat()).not.toContain('offset')
    expect(Object.keys(ACTIONS)).not.toContain('round-corner')
  })
  it('a rule already there, and one that fights it, are greyed with their reasons', () => {
    const { pen } = mk(d => { twoLines(d); addConstraint(d, 'horizontal', [l1]) })
    pen.pick(l1)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(item(pen, 'rule:horizontal')!.state).toEqual({ ok: false, reason: REASON.already })
    expect(item(pen, 'rule:vertical')!.state).toEqual({ ok: false, reason: REASON.conflict })
  })
  it('points: Fix and Dissolve join the actions', () => {
    const { pen } = mk(twoLines)
    pen.pick(a)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value!.header).toBe('1 point')
    expect(pen.menu.value!.groups[0]!.map(i => i.id)).toEqual(['fix', 'dissolve-point', 'construction', 'flip-h', 'flip-v', 'mirror', 'repeat'])
    expect(item(pen, 'dissolve-point')!.state).toEqual({ ok: false, reason: REASON.notBetween })
  })
  it('empty space: no heading, Paste and Select all', () => {
    const { pen } = mk(twoLines)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value!.header).toBeNull()
    expect(items(pen).map(i => i.id)).toEqual(['paste', 'select-all'])
  })
  it('an item runs and closes the menu; a greyed one does nothing', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null)
    pen.runMenuItem('mirror')
    expect(pen.menu.value).not.toBeNull()
    pen.runMenuItem('rule:horizontal')
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('Paste from the menu lands on the right-clicked point', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l1); pen.copySelection(); pen.clearSel()
    pen.openMenu({ x: 0, y: 0 }, { x: 20, y: 20 })
    pen.runMenuItem('paste')
    const last = doc.value.entities.filter(e => e.kind === 'line').at(-1) as any
    const p1 = doc.value.entities.find(e => e.id === last.p1) as any
    expect(p1).toMatchObject({ x: 17, y: 20 })
  })
})

describe('keys while the menu is open', () => {
  it('arrows move over enabled items and wrap; Enter runs; Escape closes', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.onKeydown(key('ArrowDown'))).toBe(true)
    expect(pen.menu.value!.active).toBe('rule:horizontal')
    pen.onKeydown(key('ArrowUp'))
    expect(pen.menu.value!.active).toBe('delete')        // wrapped, past greyed Paste
    pen.onKeydown(key('Home'))
    expect(pen.menu.value!.active).toBe('rule:horizontal')
    expect(pen.onKeydown(key('p'))).toBe(true)           // swallowed: no tool change
    expect(pen.tool.value).toBe('select')
    pen.onKeydown(key('Enter'))
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
    pen.openMenu({ x: 0, y: 0 }, null)
    pen.onKeydown(key('Escape'))
    expect(pen.menu.value).toBeNull()
  })
  it('⌘Z closes the menu and undoes', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2); pen.apply('horizontal')
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints).toHaveLength(0)
  })
})

describe('the wheel', () => {
  it('slices by direction, with a dead zone', () => {
    expect(wheelDirAt(0, -60)).toBe('n')
    expect(wheelDirAt(60, 0)).toBe('e')
    expect(wheelDirAt(-42, 42)).toBe('sw')
    expect(wheelDirAt(-500, -10)).toBe('w')
    expect(wheelDirAt(5, 5)).toBeNull()
  })
  it('a line opens the segment layout; releasing on Horizontal adds it', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2)
    expect(pen.openWheel({ x: 100, y: 100 })).toBe(true)
    const w = pen.wheel.value!
    expect(w.layout).toBe('segment')
    expect(Object.fromEntries(w.slices.map(s => [s.dir, s.label]))).toEqual({
      n: 'Tangent', ne: 'Vertical', e: 'Perpendicular', se: 'Flip horizontal', s: 'Repeat…', sw: 'Flip vertical', w: 'Parallel', nw: 'Horizontal' })
    expect(w.slices.find(s => s.dir === 'n')!.state).toEqual({ ok: false, reason: REASON.notHere })
    pen.wheelPointer({ x: 60, y: 60 })
    expect(pen.wheel.value!.hover).toBe('nw')
    pen.releaseWheel()
    expect(pen.wheel.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('two points open the point layout; West joins them', () => {
    let p = ''
    const { doc, pen } = mk(d => { twoLines(d); p = addPoint(d, 3, 3) })
    pen.pick(a); pen.pick(p, true)
    pen.openWheel({ x: 0, y: 0 })
    expect(pen.wheel.value!.layout).toBe('point')
    pen.wheelPointer({ x: -60, y: 0 })
    pen.releaseWheel()
    expect(doc.value.entities.some(e => e.id === p)).toBe(false)
  })
  it('a release in the middle, or on a greyed slice, does nothing; nothing selected opens nothing', () => {
    const { doc, pen } = mk(twoLines)
    expect(pen.openWheel({ x: 0, y: 0 })).toBe(false)
    pen.pick(l2)
    pen.openWheel({ x: 0, y: 0 })
    pen.wheelPointer({ x: 3, y: 3 }); pen.releaseWheel()
    pen.openWheel({ x: 0, y: 0 })
    pen.wheelPointer({ x: 0, y: -60 }); pen.releaseWheel()
    expect(pen.status.value).toBe(REASON.notHere)
    expect(doc.value.constraints).toHaveLength(0)
  })
  it('Escape cancels the wheel', () => {
    const { pen } = mk(twoLines)
    pen.pick(l2); pen.openWheel({ x: 0, y: 0 })
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.wheel.value).toBeNull()
  })
})

describe('the new keys', () => {
  it('X makes a guide, ⇧H flips; each only when it can act', () => {
    const { doc, pen } = mk(twoLines)
    expect(pen.onKeydown(key('x'))).toBe(false)
    pen.pick(l1)
    expect(pen.onKeydown(key('x'))).toBe(true)
    expect((doc.value.entities.find(e => e.id === l1) as any).construction).toBe(true)
    pen.pick(l2)
    const before = JSON.stringify(doc.value)
    expect(pen.onKeydown(key('H', { shiftKey: true }))).toBe(true)
    expect(JSON.stringify(doc.value)).not.toBe(before)
  })
  it('⌘C copies, ⌘V pastes, ⌘A selects all — and are left alone when they can’t act', () => {
    const { doc, pen } = mk(twoLines)
    expect(pen.onKeydown(key('c', { metaKey: true }))).toBe(false)
    expect(pen.onKeydown(key('v', { metaKey: true }))).toBe(false)
    pen.pick(l1)
    expect(pen.onKeydown(key('c', { metaKey: true }))).toBe(true)
    expect(pen.onKeydown(key('v', { metaKey: true }))).toBe(true)
    expect(doc.value.entities.filter(e => e.kind === 'line')).toHaveLength(3)
    expect(pen.onKeydown(key('a', { metaKey: true }))).toBe(true)
    expect(pen.selection.value).toHaveLength(3)
    expect(mk().pen.onKeydown(key('a', { metaKey: true }))).toBe(false)
  })
})

describe('session ends close the menu and the wheel', () => {
  it('a tool change, undo and Clean up', () => {
    const { pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null); pen.selectTool('line')
    expect(pen.menu.value).toBeNull()
    pen.selectTool('select'); pen.pick(l2)
    pen.openWheel({ x: 0, y: 0 }); pen.undo()
    expect(pen.wheel.value).toBeNull()
    pen.openMenu({ x: 0, y: 0 }, null); pen.startCleanup()
    expect(pen.menu.value).toBeNull()
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value).toBeNull()                    // not while previewing
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-actions.unit.spec.ts`
Expected: FAIL — cannot resolve `~/composables/pen/penActions`.

- [ ] **Step 3: Write `frontend/app/composables/pen/penActions.ts`**

```ts
// app/composables/pen/penActions.ts
// Pen stage 6: the ONE registry of what a selection can do (Ruling 1). The
// right-click list menu, the action wheel and the Properties panel's + list
// all read it; the rules row's own list (availableConstraints) is its rule
// entries. Each entry says whether it can run now and, if not, why
// (penReasons.ts). Pure over the host it is handed (usePen builds one).
//
// Stage 8 extends it: add `offset`, `round-corner` and `chamfer` to ACTIONS
// and their ids to SELECTION_MENU's first group after `repeat` (Ruling 2).
// Until then they are absent, not greyed.
import type { Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import { pointClosure } from '~/lib/sketch/edit'
import { checkRule } from '~/lib/sketch/ruleCheck'
import { selectionLabel, topLevelIds } from '~/lib/sketch/pieces'
import { ruleSpecFor, type RuleOption, type SegRef } from './penRules'
import { OK, no, REASON, type ActionState } from './penReasons'

export interface PenActionHost {
  doc: Ref<SketchDoc>
  selection: Ref<EntityId[]>
  selectedSegments: Ref<SegRef[]>
  availableConstraints(): RuleOption[]
  applyWithValue(o: RuleOption): unknown
  fixSelected(): void
  dissolveState(id: EntityId): ActionState
  dissolvePoint(id: EntityId): boolean
  makeConstruction(): void
  flip(axis: 'h' | 'v'): void
  doMirror(): void
  repeatPrompt(): unknown
  copySelection(): boolean
  copySvg(): string
  pasteState(): ActionState
  paste(at?: Vec2 | null): boolean
  del(): void
  selectAll(): boolean
}

export interface ActionDef {
  label: string
  tip: string                 // PEN_TIPS id (the same as the action id)
  key?: string                // Mac glyphs; tipKeyLabel spells them for others
  danger?: boolean
  shown?: (h: PenActionHost) => boolean
  state: (h: PenActionHost) => ActionState
  run: (h: PenActionHost, at: Vec2 | null) => void
}

const kindOf = (h: PenActionHost, id: EntityId) => h.doc.value.entities.find(e => e.id === id)?.kind
const hasPick = (h: PenActionHost) => h.selection.value.length > 0 || h.selectedSegments.value.length > 0
const hasShape = (h: PenActionHost) => h.selection.value.some(id => { const k = kindOf(h, id); return !!k && k !== 'point' })
const pointsOf = (h: PenActionHost) => h.selection.value.filter(id => kindOf(h, id) === 'point')
const onePoint = (h: PenActionHost) => h.selection.value.length === 1 && !h.selectedSegments.value.length && pointsOf(h).length === 1

export const ACTIONS: Record<string, ActionDef> = {
  fix: {
    label: 'Fix', tip: 'fix',
    shown: h => pointsOf(h).length > 0,
    state: h => {
      const ps = pointsOf(h)
      if (!ps.length) return no(REASON.point)
      return ps.every(id => (h.doc.value.entities.find(e => e.id === id) as { fixed?: boolean } | undefined)?.fixed) ? no(REASON.already) : OK
    },
    run: h => h.fixSelected(),
  },
  'dissolve-point': {
    label: 'Dissolve', tip: 'dissolve-point',
    shown: onePoint,
    state: h => (onePoint(h) ? h.dissolveState(pointsOf(h)[0]!) : no(REASON.onePoint)),
    run: h => { h.dissolvePoint(pointsOf(h)[0]!) },
  },
  construction: { label: 'Make guide', tip: 'construction', key: 'X', state: h => (hasShape(h) ? OK : no(REASON.shape)), run: h => h.makeConstruction() },
  'flip-h': { label: 'Flip horizontal', tip: 'flip-h', key: '⇧H', state: h => (pointClosure(h.doc.value, h.selection.value).length >= 2 ? OK : no(REASON.shape)), run: h => h.flip('h') },
  'flip-v': { label: 'Flip vertical', tip: 'flip-v', key: '⇧V', state: h => (pointClosure(h.doc.value, h.selection.value).length >= 2 ? OK : no(REASON.shape)), run: h => h.flip('v') },
  mirror: { label: 'Mirror…', tip: 'mirror', state: h => (h.selection.value.some(id => kindOf(h, id) !== 'line') ? OK : no(REASON.shape)), run: h => h.doMirror() },
  repeat: { label: 'Repeat…', tip: 'repeat', state: h => (hasShape(h) ? OK : no(REASON.shape)), run: h => { void h.repeatPrompt() } },
  copy: { label: 'Copy', tip: 'copy', key: '⌘C', state: h => (hasPick(h) ? OK : no(REASON.nothing)), run: h => { h.copySelection() } },
  'copy-svg': { label: 'Copy as SVG', tip: 'copy-svg', state: h => (hasShape(h) || h.selectedSegments.value.length ? OK : no(REASON.shape)), run: h => { h.copySvg() } },
  paste: { label: 'Paste', tip: 'paste', key: '⌘V', state: h => h.pasteState(), run: (h, at) => { h.paste(at) } },
  delete: { label: 'Delete', tip: 'delete', key: '⌫', danger: true, state: h => (hasPick(h) ? OK : no(REASON.nothing)), run: h => h.del() },
  'select-all': { label: 'Select all', tip: 'select-all', key: '⌘A', state: h => (topLevelIds(h.doc.value).length ? OK : no(REASON.noPieces)), run: h => { h.selectAll() } },
}

/** The selection menu's action groups (a line between groups) — Ruling 3. */
export const SELECTION_MENU: string[][] = [
  ['fix', 'dissolve-point', 'construction', 'flip-h', 'flip-v', 'mirror', 'repeat'],
  ['copy', 'copy-svg', 'paste'],
  ['delete'],
]
/** A right-click on empty space. */
export const EMPTY_MENU: string[][] = [['paste', 'select-all']]

export interface PenMenuItem { id: string; label: string; tip: string; key?: string; danger?: boolean; state: ActionState }

export const ruleItemId = (o: RuleOption) => `rule:${o.tip ?? o.kind}`

// a rule that asks for a value is checked at the value it has now (Ruling 12)
function measuredValue(doc: SketchDoc, sel: EntityId[], o: RuleOption): number | undefined {
  if (!o.value) return undefined
  const ents = sel.map(id => doc.entities.find(e => e.id === id))
  if (o.kind === 'distance' && ents.length === 2 && ents.every(e => e?.kind === 'point')) {
    const [p, q] = ents as { x: number; y: number }[]
    return Math.hypot(p!.x - q!.x, p!.y - q!.y)
  }
  if (o.kind === 'radius' && ents[0]?.kind === 'circle') return ents[0].r
  return undefined
}

export function ruleState(doc: SketchDoc, sel: EntityId[], segs: SegRef[], o: RuleOption): ActionState {
  const spec = ruleSpecFor(doc, sel, segs, o, measuredValue(doc, sel, o))
  if (!spec) return no(REASON.notHere)
  const r = checkRule(doc, spec)
  return r === 'ok' ? OK : no(r === 'already' ? REASON.already : REASON.conflict)
}

export function ruleItems(h: PenActionHost): PenMenuItem[] {
  const doc = h.doc.value, sel = h.selection.value, segs = h.selectedSegments.value
  return h.availableConstraints().map(o => ({ id: ruleItemId(o), label: o.label, tip: o.tip ?? o.kind, state: ruleState(doc, sel, segs, o) }))
}

export function actionItem(h: PenActionHost, id: string): PenMenuItem {
  const d = ACTIONS[id]!
  return { id, label: d.label, tip: d.tip, ...(d.key ? { key: d.key } : {}), ...(d.danger ? { danger: true } : {}), state: d.state(h) }
}

export function menuFor(h: PenActionHost): { header: string | null; groups: PenMenuItem[][] } {
  if (!hasPick(h)) return { header: null, groups: EMPTY_MENU.map(g => g.map(id => actionItem(h, id))) }
  const groups = SELECTION_MENU
    .map(g => g.filter(id => ACTIONS[id]?.shown?.(h) ?? true).map(id => actionItem(h, id)))
    .filter(g => g.length)
  const rules = ruleItems(h)
  return {
    header: selectionLabel(h.doc.value, h.selection.value, h.selectedSegments.value),
    groups: rules.length ? [rules, ...groups] : groups,
  }
}

export function runItem(h: PenActionHost, id: string, at: Vec2 | null): void {
  if (id.startsWith('rule:')) {
    const o = h.availableConstraints().find(x => ruleItemId(x) === id)
    if (o) void h.applyWithValue(o)
    return
  }
  ACTIONS[id]?.run(h, at)
}

// ── the wheel (Ruling 5) ──
export type WheelDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
/** Counter-clockwise from east, 45° apart. */
export const WHEEL_DIRS: WheelDir[] = ['e', 'ne', 'n', 'nw', 'w', 'sw', 's', 'se']
export const WHEEL_OPEN_PX = 12
export const WHEEL_DEAD_PX = 24
export const WHEEL_R = 100
export const WHEEL_LABEL_R = 66
type SliceDef = { action: string } | { rule: string }   // rule: the rules-row option's label
export const WHEEL_LAYOUTS: Record<'point' | 'segment', Record<WheelDir, SliceDef>> = {
  point: {
    n: { action: 'fix' }, ne: { rule: 'Vertical' }, e: { action: 'dissolve-point' }, se: { action: 'flip-h' },
    s: { action: 'repeat' }, sw: { action: 'flip-v' }, w: { rule: 'Coincident' }, nw: { rule: 'Horizontal' },
  },
  segment: {
    n: { rule: 'Tangent' }, ne: { rule: 'Vertical' }, e: { rule: 'Perpendicular' }, se: { action: 'flip-h' },
    s: { action: 'repeat' }, sw: { action: 'flip-v' }, w: { rule: 'Parallel' }, nw: { rule: 'Horizontal' },
  },
}
export interface WheelSlice { dir: WheelDir; id: string; label: string; state: ActionState }

export function wheelFor(h: PenActionHost): { layout: 'point' | 'segment'; slices: WheelSlice[] } | null {
  if (!hasPick(h)) return null
  const layout = hasShape(h) || h.selectedSegments.value.length ? 'segment' : 'point'
  const doc = h.doc.value, sel = h.selection.value, segs = h.selectedSegments.value
  const opts = h.availableConstraints()
  const slices = WHEEL_DIRS.map((dir): WheelSlice => {
    const def = WHEEL_LAYOUTS[layout][dir]
    if ('action' in def) { const a = ACTIONS[def.action]!; return { dir, id: def.action, label: a.label, state: a.state(h) } }
    const o = opts.find(x => x.label === def.rule)
    return o
      ? { dir, id: ruleItemId(o), label: def.rule, state: ruleState(doc, sel, segs, o) }
      : { dir, id: `rule:${def.rule.toLowerCase()}`, label: def.rule, state: no(REASON.notHere) }
  })
  return { layout, slices }
}

/** The slice a pointer offset (screen px, y down) from the wheel's centre is on; null in the dead zone. */
export function wheelDirAt(dx: number, dy: number): WheelDir | null {
  if (Math.hypot(dx, dy) < WHEEL_DEAD_PX) return null
  const a = Math.atan2(-dy, dx)
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8
  return WHEEL_DIRS[i]!
}
```

- [ ] **Step 4: `penKeys.ts`** — add to `PenKeyContext` (after `toggleCleanup`):

```ts
  // pen stage 6: X / ⇧H / ⇧V / ⌘C / ⌘V / ⌘A run a registry action when it can
  // act now (penActions.ts ACTIONS); false leaves the key to the host
  runKeyAction: (id: string) => boolean
```

Add, after `isCleanupKey`:

```ts
/** X (Make guide), ⇧H / ⇧V (flip) — the pen stage 6 action letters. */
export function isActionKey(ev: KeyboardEvent): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.key.length !== 1) return false
  const k = ev.key.toLowerCase()
  return (!ev.shiftKey && k === 'x') || (ev.shiftKey && (k === 'h' || k === 'v'))
}
```

In `handlePenKey`'s meta branch, before its final `return false`:

```ts
    // pen stage 6: ⌘C copies a selection, ⌘V pastes the pen's own clipboard,
    // ⌘A selects every piece — each only when it can act
    if (!ev.shiftKey && !ev.altKey && (key === 'c' || key === 'v' || key === 'a')) {
      return ctx.runKeyAction(key === 'c' ? 'copy' : key === 'v' ? 'paste' : 'select-all')
    }
```

and right after the two `gestureActive` digit lines (before the tool-letter block):

```ts
  // pen stage 6: X makes the selection a guide, ⇧H / ⇧V flip it
  if (isActionKey(ev)) {
    const k = ev.key.toLowerCase()
    return ctx.runKeyAction(k === 'x' ? 'construction' : k === 'h' ? 'flip-h' : 'flip-v')
  }
```

- [ ] **Step 5: `usePen.ts`** — imports:

```ts
import {
  ACTIONS, menuFor, runItem, wheelFor, wheelDirAt, ruleItems as registryRuleItems,
  type PenActionHost, type PenMenuItem, type WheelSlice, type WheelDir,
} from './penActions'
```

Add module-level exported types next to `PenOptions`:

```ts
// pen stage 6: the right-click list menu and the action wheel, as pen state
// (replaced on every change). `at` is the host's client px (where to draw);
// `drawingAt` is where the menu's Paste lands.
export interface PenMenu { at: Vec2; drawingAt: Vec2 | null; header: string | null; groups: PenMenuItem[][]; active: string | null }
export interface PenWheel { at: Vec2; layout: 'point' | 'segment'; slices: WheelSlice[]; hover: WheelDir | null }
```

After the Task 5 section (before the Clean up section) add:

```ts
  // --- the right-click menu and the action wheel (pen stage 6) ---
  // Both read penActions.ts through `actionHost` (built below, just before
  // the return — only called after setup). While one is open the pen owns
  // the keys (menuKey / wheelKey); anything that ends the session closes them.
  const menu = shallowRef<PenMenu | null>(null)
  const wheel = shallowRef<PenWheel | null>(null)
  function openMenu(at: Vec2, drawingAt: Vec2 | null): void {
    if (cleanup.value) return
    wheel.value = null
    menu.value = { at, drawingAt, ...menuFor(actionHost), active: null }
  }
  function closeMenu(): void { menu.value = null }
  function closeWheel(): void { wheel.value = null }
  function closeMenus(): void { menu.value = null; wheel.value = null }
  function setMenuActive(id: string | null): void {
    const m = menu.value
    if (m && m.active !== id) menu.value = { ...m, active: id }
  }
  function runMenuItem(id: string): void {
    const m = menu.value
    const it = m?.groups.flat().find(i => i.id === id)
    if (!m || !it || !it.state.ok) return   // a greyed item does nothing; the menu stays
    menu.value = null
    runItem(actionHost, id, m.drawingAt)
  }
  function menuKey(ev: KeyboardEvent): boolean {
    const m = menu.value!
    if (MODIFIER_KEYS.has(ev.key)) return false
    const order = m.groups.flat().filter(i => i.state.ok).map(i => i.id)
    const step = (d: number) => {
      if (!order.length) return
      const i = m.active ? order.indexOf(m.active) : -1
      setMenuActive(order[i < 0 ? (d > 0 ? 0 : order.length - 1) : (i + d + order.length) % order.length]!)
    }
    if (ev.key === 'Escape') { closeMenu(); return true }
    if (ev.key === 'ArrowDown' || (ev.key === 'Tab' && !ev.shiftKey)) { step(1); return true }
    if (ev.key === 'ArrowUp' || (ev.key === 'Tab' && ev.shiftKey)) { step(-1); return true }
    if (ev.key === 'Home') { if (order.length) setMenuActive(order[0]!); return true }
    if (ev.key === 'End') { if (order.length) setMenuActive(order.at(-1)!); return true }
    if (ev.key === 'Enter') { if (m.active) runMenuItem(m.active); return true }
    return true   // every other plain key is swallowed while the menu is open
  }
  function openWheel(at: Vec2): boolean {
    if (cleanup.value) return false
    const w = wheelFor(actionHost)
    if (!w) return false
    menu.value = null
    wheel.value = { at, ...w, hover: null }
    return true
  }
  function wheelPointer(at: Vec2): void {
    const w = wheel.value
    if (!w) return
    const hover = wheelDirAt(at.x - w.at.x, at.y - w.at.y)
    if (hover !== w.hover) wheel.value = { ...w, hover }
  }
  function releaseWheel(): void {
    const w = wheel.value
    wheel.value = null
    const s = w?.hover ? w.slices.find(x => x.dir === w.hover) : null
    if (!s) return
    if (!s.state.ok) { status.value = s.state.reason; return }
    runItem(actionHost, s.id, null)
  }
  function wheelKey(ev: KeyboardEvent): boolean {
    if (MODIFIER_KEYS.has(ev.key)) return false
    if (ev.key === 'Escape') closeWheel()
    return true
  }
  function runKeyAction(id: string): boolean {
    const d = ACTIONS[id]
    if (!d || !d.state(actionHost).ok) return false
    d.run(actionHost, null)
    return true
  }
```

`MODIFIER_KEYS` is declared later in the file (`const MODIFIER_KEYS = new Set([...])` near `dragPoint`); it is only read inside these functions at call time, so no reordering is needed.

In `onKeydown`, after the `if (cleanup.value) { … }` block, insert:

```ts
    // pen stage 6: an open menu owns the keys (a ⌘ combo closes it and then
    // goes on as usual), so does an open wheel
    if (menu.value) {
      if ((ev.metaKey || ev.ctrlKey) && !MODIFIER_KEYS.has(ev.key)) closeMenu()
      else {
        const handled = menuKey(ev)
        if (handled) { ev.preventDefault(); ev.stopPropagation() }
        return handled
      }
    }
    if (wheel.value) {
      const handled = wheelKey(ev)
      if (handled) { ev.preventDefault(); ev.stopPropagation() }
      return handled
    }
```

and add `runKeyAction,` to the `ctx` object literal. Add `closeMenus()` as the first line of `undo()`, `redo()`, `reset()`, `revert()`, `finishSession()`, `endGesture()`, `dispose()` and `startCleanup()`, and in `selectTool` right after the `isToolAllowed` guard.

Just before `initHistory()` at the end of `usePen`, add:

```ts
  // what penActions.ts runs against (pen stage 6)
  const actionHost: PenActionHost = {
    doc, selection, selectedSegments,
    availableConstraints, applyWithValue, fixSelected, dissolveState, dissolvePoint,
    makeConstruction, flip, doMirror, repeatPrompt,
    copySelection, copySvg, pasteState, paste, del, selectAll,
  }
  function ruleItems(): PenMenuItem[] { return registryRuleItems(actionHost) }
  function runAction(id: string, at: Vec2 | null = null): void { runItem(actionHost, id, at) }
```

Return object:

```ts
    // right-click menu and action wheel (pen stage 6)
    menu, wheel, openMenu, closeMenu, closeMenus, setMenuActive, runMenuItem,
    openWheel, wheelPointer, releaseWheel, closeWheel, ruleItems, runAction,
```

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-actions.unit.spec.ts tests/unit/pen-cleanup.unit.spec.ts tests/unit/pen-use-pen.unit.spec.ts tests/unit/pen-copy-paste.unit.spec.ts tests/unit/pen-options.unit.spec.ts tests/unit/pen-weld.unit.spec.ts`
Expected: PASS. Typecheck `penActions|penKeys|usePen` — nothing new.

- [ ] **Step 7: Commit** `frontend/app/composables/pen/penActions.ts frontend/app/composables/pen/penKeys.ts frontend/app/composables/pen/usePen.ts frontend/tests/unit/pen-actions.unit.spec.ts` — message `feat(pen): one action registry — the list menu, the action wheel and their keys; X, ⇧H, ⇧V, ⌘C, ⌘V, ⌘A (stage 6)`.

---

### Task 7: Cards, the menu component and the wheel component

**Files:**
- Modify: `frontend/app/composables/pen/penTips.ts`
- Modify: `frontend/app/components/pen/PenTipCard.vue` (`reason`)
- Create: `frontend/app/components/pen/PenContextMenu.vue`
- Create: `frontend/app/components/pen/PenActionWheel.vue`
- Modify: `frontend/tests/unit/pen-tips.unit.spec.ts`
- Test: `frontend/tests/unit/pen-menu-components.unit.spec.ts`

**Behaviour (Rulings 3, 5, 6, 16–18):**
- New cards: `copy` (⌘C), `copy-svg`, `paste` (⌘V), `select-all` (⌘A), `dissolve-point`, `prop-lock`, `prop-add-rule`, `prop-remove-rule`. Keys added: `construction` X, `flip-h` ⇧H, `flip-v` ⇧V. `horizontal` / `vertical` captions mention two points.
- `PenTipCard` `reason?: string` renders `<p class="pen-tip-reason" data-pen-tip-reason>` between the name row / demo and the caption.
- `PenContextMenu` (mounted by the overlay only while `pen.menu` is set): teleported, `position: fixed` at `menu.at`, clamped 8 px inside the window after it draws (and again when `at` changes); `[data-pen-menu]` `role="menu"`, header `[data-pen-menu-header]`, a `role="separator"` line between groups, items `button role="menuitem" [data-menu-item=<id>]` with `aria-disabled="true"` when greyed (not `disabled` — the card must open on hover), `data-active` for the pen's highlighted item, the key through `tipKeyLabel`; mouse-enter highlights an enabled item; click → `pen.runMenuItem(id)`. Its own `TooltipProvider`. Window listeners (Ruling 17): `pointerdown` (capture) outside the menu and outside a tip card closes it, consuming a non-right press on `[data-pen-overlay]`; `wheel` (capture), `resize`, `blur` close it.
- `PenActionWheel` (mounted only while `pen.wheel` is set): teleported, `pointer-events: none`, centred on `wheel.at`; eight `[data-wheel-slice=<dir>]` groups with `data-action`, `data-greyed`, `data-hover`; a note `[data-pen-wheel-note]` under it: the hovered slice's label, or its reason when greyed.

**Interfaces:**
- Consumes: Task 6 `pen.menu`, `pen.wheel`, `closeMenu`, `runMenuItem`, `setMenuActive`, `WHEEL_R`, `WHEEL_DEAD_PX`, `WHEEL_LABEL_R`, `WHEEL_DIRS`; `tipKeyLabel`.
- Produces: `PenContextMenu` / `PenActionWheel` (prop `pen: Pen`); `PenTipCard` prop `reason`; DOM hooks above; `PEN_TIPS` ids above.

- [ ] **Step 1: Write the failing tests** — create `frontend/tests/unit/pen-menu-components.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 6: the list menu and the wheel as components — the menu draws
// the pen's items (heading, groups, keys, greyed items still hoverable), runs
// an enabled item, ignores a greyed one, follows the pen's highlight, closes
// on a click away; the wheel draws eight slices and says what is under the
// pointer, or why it is greyed.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine } from '~/lib/sketch/edit'
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
const { default: PenContextMenu } = await import('~/components/pen/PenContextMenu.vue')
const { default: PenActionWheel } = await import('~/components/pen/PenActionWheel.vue')

const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const l = addLine(doc.value, addPoint(doc.value, 2, 5), addPoint(doc.value, 8, 6))
  return { doc, l, pen: usePen({ doc, view: ref(view) }) }
}
let wrapper: ReturnType<typeof mount> | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = '' })
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null

describe('PenContextMenu', () => {
  it('draws the heading, the items with keys, greyed ones hoverable; runs an enabled one', async () => {
    const { doc, l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: 40, y: 50 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick()
    expect(q('[data-pen-menu-header]')!.textContent).toBe('1 line')
    const mirror = q('[data-menu-item="mirror"]')!
    expect(mirror.getAttribute('aria-disabled')).toBe('true')
    expect(mirror.hasAttribute('disabled')).toBe(false)
    expect(q('[data-menu-item="construction"]')!.textContent).toContain('X')
    mirror.click()
    expect(pen.menu.value).not.toBeNull()
    q('[data-menu-item="rule:horizontal"]')!.click()
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('follows the pen’s highlight and mouse-enter', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: 0, y: 0 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick()
    q('[data-menu-item="copy"]')!.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(pen.menu.value!.active).toBe('copy')
    expect(q('[data-menu-item="copy"]')!.hasAttribute('data-active')).toBe(true)
  })
  it('stays inside the window and closes on a press elsewhere', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: window.innerWidth - 2, y: window.innerHeight - 2 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick(); await nextTick()
    const el = q('[data-pen-menu]')!
    expect(parseFloat(el.style.left)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(el.style.top)).toBeLessThanOrEqual(window.innerHeight - 8)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(pen.menu.value).toBeNull()
  })
})

describe('PenActionWheel', () => {
  it('draws eight slices and names the one under the pointer, or why it is greyed', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openWheel({ x: 200, y: 200 })
    wrapper = mount(PenActionWheel, { props: { pen } })
    await nextTick()
    expect(document.body.querySelectorAll('[data-wheel-slice]')).toHaveLength(8)
    expect(q('[data-pen-wheel]')!.getAttribute('data-layout')).toBe('segment')
    pen.wheelPointer({ x: 140, y: 140 })
    await nextTick()
    expect(q('[data-wheel-slice="nw"]')!.hasAttribute('data-hover')).toBe(true)
    expect(q('[data-pen-wheel-note]')!.textContent).toBe('Horizontal')
    pen.wheelPointer({ x: 200, y: 130 })
    await nextTick()
    expect(q('[data-wheel-slice="n"]')!.hasAttribute('data-greyed')).toBe(true)
    expect(q('[data-pen-wheel-note]')!.textContent).toBe('Doesn’t apply to this selection')
  })
})
```

Update `frontend/tests/unit/pen-tips.unit.spec.ts`: extend `FIXED_IDS` with `'copy', 'copy-svg', 'paste', 'select-all', 'dissolve-point', 'prop-lock', 'prop-add-rule', 'prop-remove-rule'`, and add to the `pen tips table` describe:

```ts
  it('the menu’s actions carry their keys', () => {
    expect(PEN_TIPS.construction!.key).toBe('X')
    expect(PEN_TIPS['flip-h']!.key).toBe('⇧H')
    expect(PEN_TIPS['flip-v']!.key).toBe('⇧V')
    expect(PEN_TIPS.copy!.key).toBe('⌘C')
    expect(PEN_TIPS.paste!.key).toBe('⌘V')
    expect(PEN_TIPS['select-all']!.key).toBe('⌘A')
    expect(tipKeyLabel('⇧H', false)).toBe('Shift+H')
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-menu-components.unit.spec.ts tests/unit/pen-tips.unit.spec.ts`
Expected: FAIL — the components don't exist; the new tips are missing.

- [ ] **Step 3: `penTips.ts`** — change the three existing entries and the two rule captions:

```ts
  construction: { name: 'Make guide', key: 'X',
    caption: 'Turns the selection into guides that shape the drawing but aren’t drawn, or back again.' },
  'flip-h': { name: 'Flip horizontal', key: '⇧H',
    caption: 'Flips the selection left to right, in place.' },
  'flip-v': { name: 'Flip vertical', key: '⇧V',
    caption: 'Flips the selection top to bottom, in place.' },
  horizontal: { name: 'Horizontal',
    caption: 'Lays a line or segment flat, or lines two points up side by side.' },
  vertical: { name: 'Vertical',
    caption: 'Stands a line or segment straight up, or lines two points up one above the other.' },
```

and add a block after `delete`:

```ts
  // ── the right-click menu's actions and the Properties panel (pen stage 6) ──
  copy: { name: 'Copy', key: '⌘C',
    caption: 'Copies the selection with the rules between its pieces, to paste into this drawing or another.' },
  'copy-svg': { name: 'Copy as SVG',
    caption: 'Copies the outline of the selection as SVG path data, to paste into another app.' },
  paste: { name: 'Paste', key: '⌘V',
    caption: 'Adds what you copied, a little down and to the right, and selects it. From this menu it lands where you clicked.' },
  'select-all': { name: 'Select all', key: '⌘A',
    caption: 'Selects every piece of the drawing.' },
  'dissolve-point': { name: 'Dissolve',
    caption: 'Heals the selected point back into one piece, where the two sides line up.' },
  'prop-lock': { name: 'Lock radius',
    caption: 'Keeps this radius when other things change, as a rule. Click again to let it go.' },
  'prop-add-rule': { name: 'Add a rule',
    caption: 'Lists the rules you can add to the selection; one that can’t be added says why.' },
  'prop-remove-rule': { name: 'Remove',
    caption: 'Takes this rule off. The pieces stay where they are.' },
```

- [ ] **Step 4: `PenTipCard.vue`** — `const props = withDefaults(defineProps<{ id: string; name?: string; side?: 'top' | 'bottom' | 'left' | 'right'; reason?: string }>(), { side: 'top' })`, and just before `<p class="pen-tip-caption">`:

```vue
        <p v-if="reason" class="pen-tip-reason" data-pen-tip-reason>{{ reason }}</p>
```

with the style rule `.pen-tip-reason { margin-top: 6px; color: #f59e0b; font-weight: 500; text-wrap: pretty; }`.

- [ ] **Step 5: Create `frontend/app/components/pen/PenContextMenu.vue`**

```vue
<!-- app/components/pen/PenContextMenu.vue -->
<script setup lang="ts">
// The pen's right-click list menu (pen stage 6). Draws `pen.menu` — built by
// penActions.ts — and nothing else: the pen owns its keys (usePen menuKey:
// arrows, Enter, Escape), so this component only renders, follows the mouse
// and closes on a click away. Mounted by PenOverlay while `pen.menu` is set,
// teleported to <body> above every modal (z 10040, under the tip cards).
// Greyed items are aria-disabled, not disabled, so their card still opens on
// hover and says why.
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import PenTipCard from '~/components/pen/PenTipCard.vue'
import { TooltipProvider } from '~/components/ui/tooltip'
import { tipKeyLabel } from '~/composables/pen/penTips'

const props = defineProps<{ pen: Pen }>()
const { menu, closeMenu, runMenuItem, setMenuActive } = props.pen
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const root = ref<HTMLElement | null>(null)
const pos = ref({ x: menu.value?.at.x ?? 0, y: menu.value?.at.y ?? 0 })
// keep the whole menu inside the window (8 px margin), measured once drawn
async function place() {
  const m = menu.value
  if (!m) return
  pos.value = { x: m.at.x, y: m.at.y }
  await nextTick()
  const el = root.value
  if (!el || typeof window === 'undefined') return
  const r = el.getBoundingClientRect()
  pos.value = {
    x: Math.max(8, Math.min(m.at.x, window.innerWidth - r.width - 8)),
    y: Math.max(8, Math.min(m.at.y, window.innerHeight - r.height - 8)),
  }
}
watch(() => menu.value?.at, place)

// a press outside closes it; on the drawing a left / middle press only closes
// it (no marquee, no point) — a right press there opens a new menu
function onWindowPointerDown(e: PointerEvent) {
  if (!menu.value) return
  const t = e.target as Element | null
  if (t && (root.value?.contains(t) || t.closest?.('[data-pen-tip]'))) return
  closeMenu()
  if (e.button !== 2 && t?.closest?.('[data-pen-overlay]')) { e.stopPropagation(); e.preventDefault() }
}
function onAway() { closeMenu() }
onMounted(() => {
  void place()
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('wheel', onAway, { capture: true, passive: true })
  window.addEventListener('resize', onAway)
  window.addEventListener('blur', onAway)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('wheel', onAway, { capture: true } as EventListenerOptions)
  window.removeEventListener('resize', onAway)
  window.removeEventListener('blur', onAway)
})
</script>

<template>
  <Teleport to="body">
    <TooltipProvider :delay-duration="350" :skip-delay-duration="600" disable-hoverable-content>
      <div v-if="menu" ref="root" data-pen-menu role="menu" :aria-label="menu.header ?? 'Drawing'" class="pen-menu"
           :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @contextmenu.prevent>
        <div v-if="menu.header" class="pen-menu-header" data-pen-menu-header>{{ menu.header }}</div>
        <template v-for="(group, gi) in menu.groups" :key="gi">
          <div v-if="gi > 0 || menu.header" class="pen-menu-sep" role="separator" />
          <PenTipCard v-for="it in group" :id="it.tip" :key="it.id" :name="it.label" side="right"
                      :reason="it.state.ok ? undefined : it.state.reason">
            <button type="button" role="menuitem" tabindex="-1" class="pen-menu-item" :class="{ danger: it.danger }"
                    :data-menu-item="it.id" :aria-disabled="it.state.ok ? undefined : 'true'"
                    :data-active="menu.active === it.id ? '' : null"
                    @mouseenter="setMenuActive(it.state.ok ? it.id : null)" @click="runMenuItem(it.id)">
              <span class="label">{{ it.label }}</span>
              <kbd v-if="it.key" class="key">{{ tipKeyLabel(it.key, isMac) }}</kbd>
            </button>
          </PenTipCard>
        </template>
      </div>
    </TooltipProvider>
  </Teleport>
</template>

<style scoped>
/* the look of CanvasContextMenu (the app's other right-click menus) */
.pen-menu {
  position: fixed; z-index: 10040; min-width: 208px; max-width: 280px; padding: 4px 0;
  background: color-mix(in srgb, #1a1a1a 97%, transparent); border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.9); font: 400 13px/1.2 ui-sans-serif, system-ui, sans-serif; user-select: none;
}
.pen-menu-header { padding: 6px 12px 5px; font-size: 11px; color: rgba(255, 255, 255, 0.5); }
.pen-menu-sep { height: 1px; margin: 4px 8px; background: rgba(255, 255, 255, 0.1); }
.pen-menu-item {
  display: flex; width: 100%; align-items: center; gap: 12px; padding: 6px 12px; border: 0; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.pen-menu-item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pen-menu-item .key { font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: rgba(255, 255, 255, 0.4); }
.pen-menu-item[data-active] { background: rgba(255, 255, 255, 0.08); }
.pen-menu-item.danger { color: #fda4af; }
.pen-menu-item[aria-disabled='true'] { opacity: 0.4; cursor: default; }
</style>
```

- [ ] **Step 6: Create `frontend/app/components/pen/PenActionWheel.vue`**

```vue
<!-- app/components/pen/PenActionWheel.vue -->
<script setup lang="ts">
// The pen's action wheel (pen stage 6): eight slices round the right-press
// point, drawn from `pen.wheel` (penActions.ts wheelFor). Look only — the
// overlay holds the pointer and tells the pen where it is (wheelPointer), the
// release picks (releaseWheel). A note under it names the slice under the
// pointer, or says why it is greyed. Teleported to <body>, above every modal.
import { computed } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import { WHEEL_R, WHEEL_DEAD_PX, WHEEL_LABEL_R, WHEEL_DIRS, type WheelDir } from '~/composables/pen/penActions'

const props = defineProps<{ pen: Pen }>()
const { wheel } = props.pen
const SIZE = WHEEL_R * 2 + 8
// slice i of WHEEL_DIRS is centred on i·45° counter-clockwise from east (y down on screen)
const angleOf = (dir: WheelDir) => WHEEL_DIRS.indexOf(dir) * Math.PI / 4
const at = (r: number, a: number) => ({ x: r * Math.cos(a), y: -r * Math.sin(a) })
function slicePath(dir: WheelDir): string {
  const a = angleOf(dir), h = Math.PI / 8 - 0.02
  const o1 = at(WHEEL_R, a + h), o2 = at(WHEEL_R, a - h), i1 = at(WHEEL_DEAD_PX, a - h), i2 = at(WHEEL_DEAD_PX, a + h)
  return `M ${o1.x} ${o1.y} A ${WHEEL_R} ${WHEEL_R} 0 0 1 ${o2.x} ${o2.y} L ${i1.x} ${i1.y} A ${WHEEL_DEAD_PX} ${WHEEL_DEAD_PX} 0 0 0 ${i2.x} ${i2.y} Z`
}
const labelAt = (dir: WheelDir) => at(WHEEL_LABEL_R, angleOf(dir))
const note = computed(() => {
  const w = wheel.value
  const s = w?.hover ? w.slices.find(x => x.dir === w.hover) : null
  return s ? (s.state.ok ? s.label : s.state.reason) : ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="wheel" data-pen-wheel :data-layout="wheel.layout" class="pen-wheel"
         :style="{ left: wheel.at.x - SIZE / 2 + 'px', top: wheel.at.y - SIZE / 2 + 'px', width: SIZE + 'px', height: SIZE + 'px' }">
      <svg :width="SIZE" :height="SIZE" :viewBox="`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`" aria-hidden="true">
        <g v-for="s in wheel.slices" :key="s.dir" :data-wheel-slice="s.dir" :data-action="s.id"
           :data-greyed="s.state.ok ? null : ''" :data-hover="wheel.hover === s.dir ? '' : null" class="slice">
          <path :d="slicePath(s.dir)" />
          <text :x="labelAt(s.dir).x" :y="labelAt(s.dir).y" text-anchor="middle" dominant-baseline="middle">{{ s.label }}</text>
        </g>
        <circle :r="WHEEL_DEAD_PX - 4" class="hub" />
      </svg>
      <div v-if="note" class="pen-wheel-note" data-pen-wheel-note>{{ note }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.pen-wheel { position: fixed; z-index: 10040; pointer-events: none; }
.slice path { fill: rgba(20, 20, 20, 0.92); stroke: rgba(255, 255, 255, 0.12); stroke-width: 1; }
.slice text { fill: rgba(255, 255, 255, 0.88); font: 500 11px/1 ui-sans-serif, system-ui, sans-serif; }
.slice[data-hover] path { fill: #2f6bff; }
.slice[data-hover] text { fill: #fff; }
.slice[data-greyed] text { fill: rgba(255, 255, 255, 0.35); }
.slice[data-greyed][data-hover] path { fill: rgba(60, 60, 60, 0.95); }
.hub { fill: rgba(20, 20, 20, 0.92); stroke: rgba(255, 255, 255, 0.2); }
.pen-wheel-note {
  position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 4px; white-space: nowrap;
  padding: 3px 8px; border-radius: 6px; background: rgba(10, 10, 10, 0.85); color: rgba(255, 255, 255, 0.85);
  font: 500 11.5px/1.3 ui-sans-serif, system-ui, sans-serif;
}
</style>
```

- [ ] **Step 7: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-menu-components.unit.spec.ts tests/unit/pen-tips.unit.spec.ts tests/unit/pen-toolbar-cleanup.unit.spec.ts`
Expected: PASS. Typecheck `PenContextMenu|PenActionWheel|PenTipCard|penTips` — nothing new.

- [ ] **Step 8: Commit** `frontend/app/composables/pen/penTips.ts frontend/app/components/pen/PenTipCard.vue frontend/app/components/pen/PenContextMenu.vue frontend/app/components/pen/PenActionWheel.vue frontend/tests/unit/pen-menu-components.unit.spec.ts frontend/tests/unit/pen-tips.unit.spec.ts` — message `feat(pen): the right-click menu and the action wheel as components; cards for the new actions (stage 6)`.

---

### Task 8: The overlay — right press to menu or wheel, highlight, keys

**Files:**
- Modify: `frontend/app/components/pen/PenOverlay.vue`
- Test: `frontend/tests/unit/pen-overlay-menus.unit.spec.ts`

**Behaviour (Rulings 4, 5, 6, 16, 17, 19):**
- `defineOptions({ inheritAttrs: false })`; the svg gets `v-bind="$attrs"` and `data-pen-overlay`; after the svg, `<PenContextMenu v-if="menu" :pen="pen" />` and `<PenActionWheel v-if="wheel" :pen="pen" />`.
- A right press (`button === 2`, or a Mac ctrl-click) on a point, a line / circle hit path, a path segment hit path, or empty space → `startRightPress(ev, target)`: ignored while inactive or previewing Clean up; settles the overlay's own gesture; in Select selects an unselected target (Option on a segment → `pickSegment`); `closeMenus()`; remembers `{ pointerId, clientX, clientY, drawing point, empty }`; captures the pointer on the svg; stops the event. It never finishes a half-drawn path.
- Moves with a right press: past `WHEEL_OPEN_PX` → `openWheel(press point)` once; while open → `wheelPointer(client point)`. Other move handling is skipped during a right press.
- Release: the wheel → `releaseWheel()`; else (empty space in Select → clear both selections) `openMenu(press point, drawing point)`. `pointercancel` drops the press and closes any wheel; `pointerleave` is ignored during a right press (the svg holds the pointer).
- `handleKeydownEvent`: an open menu or wheel gets the key (through `pen.onKeydown`) ahead of the focused-control rule, like Clean up; `isActionKey` settles the overlay gesture like a tool key.
- Highlight: `pen.highlight` pieces drawn in `#06b6d4` — lines, circles and segments in drawing space (3.5 px, non-scaling), points as 8 px screen rings — each with `data-highlight="<pieceKey>"`, `pointer-events="none"`.

**Interfaces:**
- Consumes: Task 5 `highlight`; Task 6 `menu`, `wheel`, `openMenu`, `closeMenus`, `openWheel`, `wheelPointer`, `releaseWheel`, `closeWheel`, `WHEEL_OPEN_PX`, `isActionKey`; Task 7 components; `pieceKey`.
- Produces: DOM hooks `[data-pen-overlay]` (the svg), `[data-highlight]`.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-overlay-menus.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 6, PenOverlay: a right press on a piece selects it first (in
// Select) and its release opens the list menu; on empty space the selection
// clears; a right drag past 12 px opens the wheel at the press point and the
// release runs the slice; a draw tool's half-drawn path survives a right
// click; keys go to the open menu; the hover highlight is drawn; host attrs
// still land on the svg.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine } from '~/lib/sketch/edit'
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
function mountIt(keyboard?: 'host') {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const l = addLine(doc.value, addPoint(doc.value, 2, 5), addPoint(doc.value, 8, 6))
  const pen = usePen({ doc, view: ref(view) })
  const wrapper = mount(PenOverlay, { props: { pen, view, width: 680, height: 460, ...(keyboard ? { keyboard } : {}) }, attrs: { 'data-testid': 'host-overlay', class: 'host-class' } })
  return { wrapper, doc, pen, l }
}
let wrapper: ReturnType<typeof mount> | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = '' })
const R = (x: number, y: number) => ({ button: 2, buttons: 2, clientX: x, clientY: y, pointerId: 1 })

describe('PenOverlay right press', () => {
  it('host attrs land on the svg', () => {
    const m = mountIt(); wrapper = m.wrapper
    const svg = m.wrapper.find('svg[data-pen-overlay]')
    expect(svg.attributes('data-testid')).toBe('host-overlay')
    expect(svg.classes()).toContain('host-class')
  })
  it('selects the piece under it, and the release opens the list menu', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    expect(m.pen.selection.value).toEqual([m.l])
    await m.wrapper.find('svg').trigger('pointerup', R(200, 210))
    expect(m.pen.menu.value!.header).toBe('1 line')
    expect(m.pen.menu.value!.at).toEqual({ x: 200, y: 210 })
    await nextTick()
    expect(document.body.querySelector('[data-pen-menu]')).not.toBeNull()
  })
  it('on empty space it clears the selection and offers Paste and Select all', async () => {
    const m = mountIt(); wrapper = m.wrapper
    m.pen.pick(m.l)
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', R(600, 40))
    await svg.trigger('pointerup', R(600, 40))
    expect(m.pen.selection.value).toEqual([])
    expect(m.pen.menu.value!.groups.flat().map(i => i.id)).toEqual(['paste', 'select-all'])
  })
  it('a right drag opens the wheel at the press point; the release runs the slice', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointermove', R(195, 205))
    expect(m.pen.wheel.value).toBeNull()                      // under 12 px
    await svg.trigger('pointermove', R(150, 160))
    expect(m.pen.wheel.value!.at).toEqual({ x: 200, y: 210 })
    expect(m.pen.wheel.value!.hover).toBe('nw')
    await svg.trigger('pointerup', R(150, 160))
    expect(m.pen.wheel.value).toBeNull()
    expect(m.pen.menu.value).toBeNull()
    expect(m.doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('a right click in the Pen tool keeps the half-drawn path', async () => {
    const m = mountIt(); wrapper = m.wrapper
    m.pen.selectTool('path')
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    await svg.trigger('pointerup', { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    const n = m.doc.value.entities.length
    await svg.trigger('pointerdown', R(300, 300))
    await svg.trigger('pointerup', R(300, 300))
    expect(m.doc.value.entities.length).toBe(n)
    expect(m.pen.pendingPath.value).not.toBeNull()
    expect(m.pen.menu.value).not.toBeNull()
  })
  it('keys go to the open menu, even with a host feeding them', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    m.pen.pick(m.l)
    m.pen.openMenu({ x: 0, y: 0 }, null)
    const onHostKeydown = (m.wrapper.vm as any).onHostKeydown
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true)
    expect(m.pen.menu.value!.active).toBe('rule:horizontal')
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(m.pen.menu.value).toBeNull()
    expect(m.wrapper.emitted('cancel')).toBeUndefined()
  })
  it('draws the hover highlight', async () => {
    const m = mountIt(); wrapper = m.wrapper
    m.pen.setHighlight([{ kind: 'line', id: m.l }])
    await nextTick()
    expect(m.wrapper.find(`[data-highlight="line:${m.l}"]`).exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-overlay-menus.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: `PenOverlay.vue` script** — imports:

```ts
import { TOOL_KEYS, isCleanupKey, isActionKey } from '~/composables/pen/penKeys'
import { WHEEL_OPEN_PX } from '~/composables/pen/penActions'
import { pieceKey } from '~/lib/sketch/pieces'
import PenContextMenu from '~/components/pen/PenContextMenu.vue'
import PenActionWheel from '~/components/pen/PenActionWheel.vue'
```

After `withDefaults(defineProps…)`, add `defineOptions({ inheritAttrs: false })` with the comment `// multi-root (pen stage 6): the svg plus the teleported menu and wheel — host attrs go on the svg`. Add to the destructured pen: `highlight, menu, wheel, openMenu, closeMenus, openWheel, wheelPointer, releaseWheel, closeWheel,`.

After `onCleanupBadgeClick`, add:

```ts
// ---------- right press: the list menu and the action wheel (pen stage 6) ----------
// A right press (or a Mac ctrl-click) selects the piece under it first (in
// Select only); released where it was pressed it opens the list menu, dragged
// past WHEEL_OPEN_PX it opens the wheel at the press point and the release
// picks a slice. The svg holds the pointer until the release, so the wheel
// keeps tracking outside the drawing. A half-drawn path is never touched.
type RightTarget = { kind: 'point' | 'line' | 'circle'; id: EntityId } | { kind: 'seg'; pathId: EntityId; segIndex: number }
let rightPress: { pointerId: number; x: number; y: number; at: { x: number; y: number } | null; empty: boolean; wheel: boolean } | null = null
function isRightPress(ev: PointerEvent) { return ev.button === 2 || isCtrlContextClick(ev) }
function isPicked(t: RightTarget): boolean {
  if (t.kind === 'seg') return selection.value.includes(t.pathId) || selectedSegments.value.some(s => s.pathId === t.pathId && s.segIndex === t.segIndex)
  return selection.value.includes(t.id)
}
function startRightPress(ev: PointerEvent, target: RightTarget | null): void {
  ev.stopPropagation()
  ev.preventDefault()
  if (!props.active || cleanupSession.value) return
  settleOverlayGesture()
  if (tool.value === 'select' && target && !isPicked(target)) {
    if (target.kind === 'seg') { if (ev.altKey) pickSegment(target.pathId, target.segIndex); else pick(target.pathId) }
    else pick(target.id)
  }
  closeMenus()
  rightPress = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, at: drawingXY(ev), empty: !target, wheel: false }
  try { svgEl.value?.setPointerCapture?.(ev.pointerId) } catch { /* not every environment has it */ }
}
function rightPressMove(ev: PointerEvent): void {
  const rp = rightPress!
  if (!rp.wheel && Math.hypot(ev.clientX - rp.x, ev.clientY - rp.y) > WHEEL_OPEN_PX) {
    rp.wheel = true
    openWheel({ x: rp.x, y: rp.y })   // nothing selected → no wheel; the release then does nothing
  }
  if (rp.wheel) wheelPointer({ x: ev.clientX, y: ev.clientY })
}
function endRightPress(ev: PointerEvent): void {
  const rp = rightPress!
  rightPress = null
  try { svgEl.value?.releasePointerCapture?.(rp.pointerId) } catch { /* already released */ }
  if (ev.type === 'pointercancel') { closeWheel(); return }
  if (rp.wheel) { releaseWheel(); return }
  if (rp.empty && tool.value === 'select') { clearSel(); clearSegSel() }
  openMenu({ x: rp.x, y: rp.y }, rp.at)
}
const entityKind = (id: EntityId) => (doc.value.entities.find(e => e.id === id)?.kind ?? 'line') as 'point' | 'line' | 'circle'

// the Properties panel's hover: the pieces of the rule under the pointer
const HIGHLIGHT = '#06b6d4'
const highlightPaths = computed(() => highlight.value.filter(p => p.kind !== 'point').map(p => ({
  key: pieceKey(p), d: p.kind === 'seg' ? segmentPathDrawing(p.pathId, p.segIndex) : entityPathDrawing(p.id),
})).filter(h => h.d))
const highlightPoints = computed(() => highlight.value.filter(p => p.kind === 'point')
  .map(p => ({ key: pieceKey(p), s: p.kind === 'point' ? screenPt(p.id) : null }))
  .filter((h): h is { key: string; s: { x: number; y: number } } => !!h.s))
```

Then, at the top of each pointerdown handler (before the existing `button !== 0` checks):

- `onEntityPointerDown(id, ev)`: first line `if (isRightPress(ev)) { startRightPress(ev, { kind: entityKind(id), id }); return }`.
- `onPointerDownPoint(id, ev)`: after `settleArcPress()`, `if (isRightPress(ev)) { startRightPress(ev, { kind: 'point', id }); return }`.
- `onSegmentPointerDown(pathId, segIndex, ev)`: after `settleArcPress()`, `if (isRightPress(ev)) { startRightPress(ev, { kind: 'seg', pathId, segIndex }); return }`.
- `onPointerDownSvg(ev)`: after `settleArcPress()`, `if (isRightPress(ev)) { startRightPress(ev, null); return }`.

`onPointerMove(ev)`: after the `if (!props.active) return` line, `if (rightPress) { rightPressMove(ev); return }`. `onPointerUp(ev)`: after its `if (!props.active) return`, `if (rightPress) { endRightPress(ev); return }`. `onPointerLeave(ev)`: after its `if (!props.active) return`, `if (rightPress) { if (ev.type === 'pointercancel') endRightPress(ev); return }`.

In the `watch(() => props.active, …)` parked branch nothing changes (`endGesture()` closes the menus). In `settleOverlayGesture()` add a first line `rightPress = null`.

`handleKeydownEvent`: after `if (cleanupSession.value) return props.pen.onKeydown(ev)` add

```ts
  // pen stage 6: an open menu or wheel owns the keys, ahead of the
  // focused-control rule (Enter runs the highlighted item)
  if (menu.value || wheel.value) return props.pen.onKeydown(ev)
```

and change `if (isToolKey(ev)) settleOverlayGesture()` to `if (isToolKey(ev) || isActionKey(ev)) settleOverlayGesture()`.

- [ ] **Step 4: `PenOverlay.vue` template** — on the root `<svg …>` add `v-bind="$attrs" data-pen-overlay`. Inside it, after the selected-segment highlight `<template v-for="s in selectedSegments" …>` block (still inside `<template v-if="!cleanupSession">`), add:

```vue
      <!-- Properties hover (pen stage 6): the pieces of the rule under the pointer -->
      <path v-for="h in highlightPaths" :key="'hl-' + h.key" :d="h.d" fill="none" :stroke="HIGHLIGHT" stroke-width="3.5"
            stroke-linecap="round" vector-effect="non-scaling-stroke" pointer-events="none" :data-highlight="h.key" />
```

and in screen space, right before the sparkles `<g v-for="p in sparkleRender" …>`:

```vue
    <circle v-for="h in highlightPoints" :key="'hlp-' + h.key" :cx="h.s.x" :cy="h.s.y" r="8" fill="none"
            :stroke="HIGHLIGHT" stroke-width="2" pointer-events="none" :data-highlight="h.key" />
```

After the closing `</svg>`:

```vue
  <!-- pen stage 6: the list menu and the wheel, each teleported to <body> -->
  <PenContextMenu v-if="menu" :pen="pen" />
  <PenActionWheel v-if="wheel" :pen="pen" />
```

- [ ] **Step 5: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-overlay-menus.unit.spec.ts tests/unit/pen-overlay-buttons.unit.spec.ts tests/unit/pen-overlay-host-keys.unit.spec.ts tests/unit/pen-overlay-cleanup.unit.spec.ts tests/unit/pen-overlay-cues.unit.spec.ts tests/unit/pen-arc-drag.unit.spec.ts`
Expected: PASS (the "right-click places nothing" and "contextmenu is prevented" cases stay green). Typecheck `PenOverlay` — nothing new.

- [ ] **Step 6: Commit** `frontend/app/components/pen/PenOverlay.vue frontend/tests/unit/pen-overlay-menus.unit.spec.ts` — message `feat(pen): right-click opens the pen's menu, right-drag its wheel; hover highlight (stage 6)`.

---

### Task 9: The Properties panel

**Files:**
- Create: `frontend/app/components/pen/PenNumberInput.vue`
- Modify: `frontend/app/components/pen/PenValueRow.vue` (uses it)
- Create: `frontend/app/components/pen/PenProperties.vue`
- Test: `frontend/tests/unit/pen-properties.unit.spec.ts`

**Behaviour (Rulings 11, 13, 18, 19):**
- `PenNumberInput` — the value row's field, shared: `<input type="number">` showing `value` (2 decimals, trailing zeros dropped); Enter → emits `submit(n)` when the draft is a finite number ≥ `min` (else ignored); Escape → draft back to `value`, emits `cancel`; both keys `preventDefault` + `stopPropagation` (hosts leave typing to the field; Shape Studio's shell closes on a bubbling Escape); leaving the field puts the shown value back (Enter-only commit); follows `value` changes; exposes `focus()` and `commit()`; attrs go on the input. `PenValueRow` renders it (its `data-testid="pen-value-input"` passes through), focuses it on every request, ✓ calls `commit()`.
- `PenProperties` (`inheritAttrs: false`, `v-bind="$attrs"` on its root div, `[data-pen-properties]`, `inert` + dimmed while Clean up previews):
  - header `[data-props-header]` = `selectionLabel`.
  - sizes (Ruling 13) as `[data-prop=<x|y|length|angle|radius|sweep>]` rows: a label and a `PenNumberInput` (aria-label = the label); the radius row adds `[data-act="radius-lock"]` (`aria-pressed`, card `prop-lock`, Lock / LockOpen icon). Submits call `setPointXY` (the other coordinate unchanged), `setLineLength` / `setLineAngle`, `setArcRadiusValue` / `setArcLength` / `setArcSweep`, `setCircleRadius`; the lock calls `toggleArcRadiusLock` / `toggleCircleRadiusLock`. Disabled per Ruling 13.
  - "Rules" `[data-props-rules]`, only with a selection: one `[data-rule-row=<id>]` per `rulesForSelection` rule, showing `ruleLabel`; mouse-enter → `setHighlight(rulePieces)`, mouse-leave → `setHighlight([])`; `[data-act="rule-remove"]` (card `prop-remove-rule`, aria-label "Remove rule") clears the highlight then `removeConstraintById`.
  - `[data-act="rule-add"]` "Add a rule" (card `prop-add-rule`, `aria-expanded`) only when `availableConstraints()` is non-empty; it toggles a list of `pen.ruleItems()` (computed only while open) as `[data-rule-add=<id>]` buttons, greyed ones `aria-disabled` with the reason in their card; an enabled one runs `pen.runAction(id)` and closes the list. The list closes when the selection changes; the highlight clears then and on unmount.

**Interfaces:**
- Consumes: Tasks 1, 5, 6 (`selectionLabel`, `pieceNames`, `rulesForSelection`, `ruleLabel`, `rulePieces`, `sizeTargetFor`, `measureSizes`, the setters, `highlight`, `ruleItems`, `runAction`, `view`, `cleanup`).
- Produces: `PenNumberInput` (props `value: number`, `min?: number`, `disabled?: boolean`; emits `submit: [number]`, `cancel: []`; exposes `focus()`, `commit()`); `PenProperties` (prop `pen: Pen`); DOM hooks above.

- [ ] **Step 1: Write the failing test** — create `frontend/tests/unit/pen-properties.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
//
// Pen stage 6, the Properties panel: the heading and the sizes for a point,
// a line and an arc (typed with the value row's field — Enter commits,
// Escape puts it back), the radius lock, the rules list (named, hover lights
// the pieces, × removes) and the + list with its refusals; inert while Clean
// up previews. The value row still works through the shared field.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
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
const { default: PenProperties } = await import('~/components/pen/PenProperties.vue')
const { default: PenValueRow } = await import('~/components/pen/PenValueRow.vue')

const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
// a line into a tangent arc (the joint form), as in the pieces test
function scene() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const d = doc.value
  const p1 = addPoint(d, 2, 2), p2 = addPoint(d, 6, 2), p5 = addPoint(d, 8, 4), c = addPoint(d, 6, 4)
  const line = addLine(d, p1, p2)
  const arc = addPath(d, [p2, p5], [{ kind: 'arc', center: c, sweep: 1 }])
  const tan = addConstraint(d, 'perpendicular', [p1, p2, p2, c])
  return { doc, p1, p2, c, line, arc, tan, pen: usePen({ doc, view: ref(view) }) }
}
let wrapper: ReturnType<typeof mount> | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null })
async function type(w: ReturnType<typeof mount>, sel: string, v: string, k = 'Enter') {
  const input = w.find(`${sel} input`)
  await input.setValue(v)
  await input.trigger('keydown', { key: k })
  await nextTick()
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('PenProperties', () => {
  it('nothing selected: the heading only', () => {
    const s = scene()
    wrapper = mount(PenProperties, { props: { pen: s.pen }, attrs: { 'data-testid': 'host-props' } })
    expect(wrapper.find('[data-pen-properties]').attributes('data-testid')).toBe('host-props')
    expect(wrapper.find('[data-props-header]').text()).toBe('Nothing selected')
    expect(wrapper.find('[data-prop]').exists()).toBe(false)
    expect(wrapper.find('[data-props-rules]').exists()).toBe(false)
  })
  it('a point: X and Y, typed with Enter; Escape puts the value back', async () => {
    const s = scene()
    s.pen.pick(s.p1)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-props-header]').text()).toBe('1 point')
    expect((wrapper.find('[data-prop="x"] input').element as HTMLInputElement).value).toBe('2')
    await type(wrapper, '[data-prop="x"]', '1.5')
    expect(P(s.doc.value, s.p1)).toMatchObject({ x: 1.5, y: 2 })
    await type(wrapper, '[data-prop="y"]', '9', 'Escape')
    expect(P(s.doc.value, s.p1).y).toBe(2)
    expect((wrapper.find('[data-prop="y"] input').element as HTMLInputElement).value).toBe('2')
  })
  it('a line: Length and Angle', async () => {
    const s = scene()
    s.pen.pick(s.line)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-prop="length"] input').element).toBeTruthy()
    expect(wrapper.find('[data-prop="angle"]').exists()).toBe(true)
  })
  it('an arc: its sizes, the lock, and its rules — hover lights both pieces, × removes', async () => {
    const s = scene()
    s.pen.pickSegment(s.arc, 0)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-props-header]').text()).toBe('1 arc')
    for (const k of ['radius', 'length', 'sweep']) expect(wrapper.find(`[data-prop="${k}"]`).exists()).toBe(true)
    const row = wrapper.find(`[data-rule-row="${s.tan}"]`)
    expect(row.text()).toContain('Tangent — Line 1 · Arc 1')
    await row.trigger('mouseenter')
    expect(s.pen.highlight.value).toHaveLength(2)
    await row.trigger('mouseleave')
    expect(s.pen.highlight.value).toHaveLength(0)
    await wrapper.find('[data-act="radius-lock"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-act="radius-lock"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('Radius 2 — Arc 1')
    await wrapper.find(`[data-rule-row="${s.tan}"] [data-act="rule-remove"]`).trigger('click')
    await nextTick()
    expect(s.doc.value.constraints.some(k => k.id === s.tan)).toBe(false)
    expect(wrapper.find(`[data-rule-row="${s.tan}"]`).exists()).toBe(false)
  })
  it('the + list offers the rules row’s rules, greyed ones say why', async () => {
    const s = scene()
    addConstraint(s.doc.value, 'horizontal', [s.line])
    s.pen.pick(s.line)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find('[data-act="rule-add"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-rule-add="rule:horizontal"]').attributes('aria-disabled')).toBe('true')
    await wrapper.find('[data-rule-add="rule:vertical"]').trigger('click')
    expect(s.doc.value.constraints.some(k => k.kind === 'vertical')).toBe(false)   // conflicts: nothing added
  })
  it('is inert while Clean up previews', async () => {
    const s = scene()
    s.pen.startCleanup()
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-pen-properties]').attributes('inert')).toBeDefined()
  })
})

describe('PenValueRow through the shared field', () => {
  it('still submits on Enter (Distance… between two points)', async () => {
    const s = scene()
    wrapper = mount(PenValueRow, { props: { pen: s.pen } })
    s.pen.pick(s.p1); s.pen.pick(s.c, true)
    const done = s.pen.applyWithValue({ kind: 'distance', label: 'Distance…', value: true })
    await nextTick()
    const input = wrapper.find('[data-testid="pen-value-input"]')
    await input.setValue('4')
    await input.trigger('keydown', { key: 'Enter' })
    await done
    expect(s.doc.value.constraints.at(-1)).toMatchObject({ kind: 'distance', value: 4 })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-properties.unit.spec.ts`
Expected: FAIL — the components don't exist.

- [ ] **Step 3: Create `frontend/app/components/pen/PenNumberInput.vue`**

```vue
<!-- app/components/pen/PenNumberInput.vue -->
<script setup lang="ts">
// The pen's inline number field (pen stage 6: split out of PenValueRow so the
// Properties panel types sizes the same way). Enter submits a finite number
// at or above `min` (anything else is ignored); Escape puts the shown value
// back. Both keys are stopped here: hosts leave typing to the field (their
// capture listeners return while a field has focus), so an Enter or Escape
// that bubbled on would commit or close the host. Leaving the field without
// Enter puts the shown value back (Enter-only, like the value row's ✓).
import { ref, watch } from 'vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ value: number; min?: number; disabled?: boolean }>()
const emit = defineEmits<{ submit: [value: number]; cancel: [] }>()
const show = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(2))) : '')
const draft = ref(show(props.value))
const el = ref<HTMLInputElement | null>(null)
watch(() => props.value, v => { draft.value = show(v) })

function commit() {
  const n = Number(draft.value)
  if (draft.value.trim() === '' || !Number.isFinite(n)) return
  if (props.min != null && n < props.min) return
  emit('submit', n)
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); commit() }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); draft.value = show(props.value); emit('cancel') }
}
function onBlur() { draft.value = show(props.value) }
defineExpose({ focus: () => el.value?.focus(), commit })
</script>

<template>
  <input ref="el" v-model="draft" v-bind="$attrs" type="number" step="any" class="pen-number"
         :min="min" :disabled="disabled" @keydown="onKeydown" @blur="onBlur" />
</template>

<style scoped>
.pen-number {
  width: 72px; height: 28px; padding: 0 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06); color: #fff; font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
}
.pen-number:focus { outline: none; border-color: rgba(147, 197, 253, 0.6); }
.pen-number:disabled { opacity: 0.45; }
</style>
```

- [ ] **Step 4: `PenValueRow.vue`** — replace the script's draft / input / key handling and the `<input>`:

```vue
<script setup lang="ts">
// The pen's inline value request — replaces the four window.prompt() calls
// (Distance/Radius/Copies) so the pen can live inside the Frame editor, which
// cannot host a browser-native prompt. Renders only while `pen.valueRequest`
// is set (usePen.ts's requestValue/submitValue/cancelValue); PenToolbar shows
// this as its top row (layout A). The field is PenNumberInput (shared with
// the Properties panel since pen stage 6): it stops its own Enter / Escape.
import { ref, watch, nextTick } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import PenNumberInput from '~/components/pen/PenNumberInput.vue'

const props = defineProps<{ pen: Pen }>()
const { valueRequest, submitValue, cancelValue } = props.pen
const field = ref<InstanceType<typeof PenNumberInput> | null>(null)
// (re)focus every time a new request comes in — including a second request
// replacing a still-pending one
watch(valueRequest, (req) => { if (req) nextTick(() => field.value?.focus()) }, { immediate: true })
</script>

<template>
  <div v-if="valueRequest" class="pen-value-row" role="group" :aria-label="valueRequest.label">
    <span class="label">{{ valueRequest.label }}</span>
    <PenNumberInput ref="field" :key="valueRequest.label + ':' + valueRequest.initial" :value="valueRequest.initial"
                    :min="valueRequest.min" data-testid="pen-value-input" class="value-input"
                    @submit="submitValue" @cancel="cancelValue" />
    <button class="tbtn ok" data-act="value-submit" title="Apply" aria-label="Apply" @click="field?.commit()">✓</button>
  </div>
</template>
```

Keep the existing styles, dropping the now-unused `.value-input` input rules (the field brings its own).

- [ ] **Step 5: Create `frontend/app/components/pen/PenProperties.vue`**

```vue
<!-- app/components/pen/PenProperties.vue -->
<script setup lang="ts">
// The pen's Properties panel (pen stage 6): the selection's sizes, typed with
// the pen's own number field (Enter commits, rules permitting), and its rules
// — named after the pieces they tie ("Tangent — Line 2 · Arc 3"), hover
// lights those pieces on the drawing, × removes one, + adds any rule the
// rules row offers (one that can't be added says why in its card). Each host
// places it in its own side panel while the pen is open; it assumes nothing
// about its position and fills the width it is given.
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import PenTipCard from '~/components/pen/PenTipCard.vue'
import PenNumberInput from '~/components/pen/PenNumberInput.vue'
import { TooltipProvider } from '~/components/ui/tooltip'
import { pieceNames, rulesForSelection, ruleLabel, rulePieces, selectionLabel } from '~/lib/sketch/pieces'
import { sizeTargetFor, measureSizes } from '~/lib/sketch/sizes'
import { Lock, LockOpen, Plus, X } from 'lucide-vue-next'

// the root is the renderless TooltipProvider: host attrs go on the panel by hand
defineOptions({ inheritAttrs: false })
const props = defineProps<{ pen: Pen }>()
const {
  doc, view, selection, selectedSegments, cleanup, availableConstraints, ruleItems, runAction,
  setHighlight, removeConstraintById, setPointXY, setLineLength, setLineAngle,
  setArcRadiusValue, setArcLength, setArcSweep, toggleArcRadiusLock, setCircleRadius, toggleCircleRadiusLock,
} = props.pen

const header = computed(() => selectionLabel(doc.value, selection.value, selectedSegments.value))
const picked = computed(() => selection.value.length > 0 || selectedSegments.value.length > 0)
const target = computed(() => sizeTargetFor(doc.value, selection.value, selectedSegments.value))
const sizes = computed(() => (target.value ? measureSizes(doc.value, target.value, view.value) : null))
const names = computed(() => pieceNames(doc.value))
const rules = computed(() => rulesForSelection(doc.value, selection.value, selectedSegments.value)
  .map(c => ({ c, label: ruleLabel(doc.value, c, names.value), pieces: rulePieces(doc.value, c) })))
const canAdd = computed(() => picked.value && availableConstraints().length > 0)
const adding = ref(false)
const addable = computed(() => (adding.value ? ruleItems() : []))
watch([selection, selectedSegments], () => { adding.value = false; setHighlight([]) }, { deep: true })
onBeforeUnmount(() => setHighlight([]))

interface Row { key: 'x' | 'y' | 'length' | 'angle' | 'radius' | 'sweep'; label: string; value: number; min?: number; disabled?: boolean; submit: (n: number) => void }
const rows = computed<Row[]>(() => {
  const t = target.value, s = sizes.value
  if (!t || !s) return []
  if (t.kind === 'point') return [
    { key: 'x', label: 'X', value: s.x!, disabled: s.fixed, submit: n => setPointXY(t.id, n, s.y!) },
    { key: 'y', label: 'Y', value: s.y!, disabled: s.fixed, submit: n => setPointXY(t.id, s.x!, n) },
  ]
  if (t.kind === 'line') return [
    { key: 'length', label: 'Length', value: s.length!, min: 0, disabled: s.fixed, submit: n => setLineLength(t.a, t.b, n) },
    { key: 'angle', label: 'Angle °', value: s.angle!, disabled: s.fixed, submit: n => setLineAngle(t.a, t.b, n) },
  ]
  if (t.kind === 'arc') return [
    { key: 'radius', label: 'Radius', value: s.radius!, min: 0, submit: n => setArcRadiusValue(t.pathId, t.segIndex, n) },
    { key: 'length', label: 'Length', value: s.length!, min: 0, submit: n => setArcLength(t.pathId, t.segIndex, n) },
    { key: 'sweep', label: 'Sweep °', value: s.sweep!, min: 0, submit: n => setArcSweep(t.pathId, t.segIndex, n) },
  ]
  return [{ key: 'radius', label: 'Radius', value: s.radius!, min: 0, submit: n => setCircleRadius(t.id, n) }]
})
function toggleLock() {
  const t = target.value
  if (t?.kind === 'arc') toggleArcRadiusLock(t.pathId, t.segIndex)
  else if (t?.kind === 'circle') toggleCircleRadiusLock(t.id)
}
function remove(id: string) { setHighlight([]); removeConstraintById(id) }
function add(id: string, ok: boolean) { if (!ok) return; adding.value = false; runAction(id) }
</script>

<template>
  <TooltipProvider :delay-duration="350" :skip-delay-duration="600" disable-hoverable-content>
    <div v-bind="$attrs" data-pen-properties class="pen-props" :inert="!!cleanup" :class="{ previewing: !!cleanup }">
      <div class="head" data-props-header>{{ header }}</div>
      <div v-if="rows.length" class="sizes">
        <label v-for="r in rows" :key="r.key" class="row" :data-prop="r.key">
          <span class="name">{{ r.label }}</span>
          <PenNumberInput :value="r.value" :min="r.min" :disabled="r.disabled" :aria-label="r.label" @submit="r.submit" />
          <PenTipCard v-if="r.key === 'radius'" id="prop-lock" side="left">
            <button type="button" class="icon" data-act="radius-lock" :aria-pressed="!!sizes?.locked" aria-label="Lock radius"
                    @click.prevent="toggleLock()">
              <Lock v-if="sizes?.locked" :size="14" /><LockOpen v-else :size="14" />
            </button>
          </PenTipCard>
        </label>
      </div>
      <div v-if="picked" class="rules" data-props-rules>
        <div class="sub">Rules</div>
        <ul>
          <li v-for="r in rules" :key="r.c.id" class="rule" :data-rule-row="r.c.id"
              @mouseenter="setHighlight(r.pieces)" @mouseleave="setHighlight([])">
            <span class="rule-name">{{ r.label }}</span>
            <PenTipCard id="prop-remove-rule" side="left">
              <button type="button" class="icon" data-act="rule-remove" aria-label="Remove rule" @click="remove(r.c.id)"><X :size="13" /></button>
            </PenTipCard>
          </li>
        </ul>
        <template v-if="canAdd">
          <PenTipCard id="prop-add-rule" side="left">
            <button type="button" class="add" data-act="rule-add" :aria-expanded="adding" @click="adding = !adding">
              <Plus :size="13" /> Add a rule
            </button>
          </PenTipCard>
          <div v-if="adding" class="add-list">
            <PenTipCard v-for="it in addable" :id="it.tip" :key="it.id" :name="it.label" side="left"
                        :reason="it.state.ok ? undefined : it.state.reason">
              <button type="button" class="add-item" :data-rule-add="it.id" :aria-disabled="it.state.ok ? undefined : 'true'"
                      @click="add(it.id, it.state.ok)">{{ it.label }}</button>
            </PenTipCard>
          </div>
        </template>
      </div>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.pen-props { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px; color: rgba(255, 255, 255, 0.85);
  font: 400 12px/1.3 ui-sans-serif, system-ui, sans-serif; }
.pen-props.previewing { opacity: 0.5; }
.head { font-weight: 600; font-size: 12.5px; color: #fff; }
.sizes { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 8px; }
.name { flex: 1; min-width: 0; color: rgba(255, 255, 255, 0.55); }
.sub { font-size: 11px; color: rgba(255, 255, 255, 0.45); margin-bottom: 4px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.rule { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; }
.rule:hover { background: rgba(6, 182, 212, 0.12); }
.rule-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 6px;
  background: transparent; color: rgba(255, 255, 255, 0.6); cursor: pointer; flex: none; }
.icon:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.icon[aria-pressed='true'] { color: #b9ccff; background: rgba(47, 107, 255, 0.18); }
.add { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; height: 26px; padding: 0 8px; border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px; background: transparent; color: rgba(255, 255, 255, 0.8); font: inherit; cursor: pointer; }
.add-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.add-item { height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.85);
  font: inherit; cursor: pointer; }
.add-item[aria-disabled='true'] { opacity: 0.4; cursor: default; }
</style>
```

- [ ] **Step 6: Run the tests**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/pen-properties.unit.spec.ts tests/unit/pen-value-request.unit.spec.ts tests/unit/pen-toolbar-cleanup.unit.spec.ts`
Expected: PASS. Typecheck `PenNumberInput|PenValueRow|PenProperties` — nothing new.

- [ ] **Step 7: Commit** `frontend/app/components/pen/PenNumberInput.vue frontend/app/components/pen/PenValueRow.vue frontend/app/components/pen/PenProperties.vue frontend/tests/unit/pen-properties.unit.spec.ts` — message `feat(pen): the Properties panel — sizes typed with the value field, radius lock, rules named, hover, remove, add (stage 6)`.

---

### Task 10: The hosts — pen page, Frame, Shape Studio

**Files:**
- Modify: `frontend/app/pages/dev/sketch-draw.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (two hunks)
- Modify: `frontend/app/components/vue-canvas/ShapeStudioSurface.vue` (two hunks)
- Modify: `frontend/tests/frame-pen.spec.ts` (Ruling 20), `frontend/tests/shape-pen.spec.ts` (Ruling 14)

**Behaviour (Ruling 14):**
- Pen page: the canvas and the toolbar in a column, `PenProperties` to their right, 240 px wide, a dark card (`data-testid="sketch-pen-properties"`); page hooks (read-only): `menu()` → `{ header, items: [{ id, ok }] } | null`, `wheel()` → `{ layout, hover } | null`, `highlight()` → piece keys.
- Frame: in `compositor-right-panel`, right after the tabs row, `<PenProperties v-if="penSession" …>` as a new first branch of the panel body's `v-if` chain (the Brand kits branch becomes `v-else-if`); tabs untouched.
- Shape Studio: in `#aside`, `<PenProperties v-if="penSession" …>`, the existing rail wrapper gets `v-else`.

**Interfaces:**
- Consumes: `PenProperties`, `pieceKey`.
- Produces: `data-testid="sketch-pen-properties" | "frame-pen-properties" | "shape-pen-properties"`; `__sketchDraw.menu()`, `.wheel()`, `.highlight()`.

- [ ] **Step 1: The pen page** — in `sketch-draw.vue` add `import PenProperties from '~/components/pen/PenProperties.vue'` and `import { pieceKey } from '~/lib/sketch/pieces'`; in `__sketchDraw` after `cleanup:` add:

```ts
    // pen stage 6 — read the right-click menu, the wheel and the Properties hover (never change them)
    menu: () => {
      const m = pen.menu.value
      return m ? { header: m.header, items: m.groups.flat().map(i => ({ id: i.id, ok: i.state.ok })) } : null
    },
    wheel: () => (pen.wheel.value ? { layout: pen.wheel.value.layout, hover: pen.wheel.value.hover } : null),
    highlight: () => pen.highlight.value.map(pieceKey),
```

Replace the template's canvas `<div …>` + `<PenToolbar …/>` with:

```vue
    <div style="display: flex; gap: 12px; align-items: flex-start">
      <!-- a fixed-width column, so a long rules row wraps under the canvas
           instead of pushing Properties off a 1024 px screen -->
      <div :style="{ flex: 'none', width: CANVAS_W + 'px' }">
        <div :style="{ position: 'relative', width: CANVAS_W + 'px', height: CANVAS_H + 'px', background: '#fafafa', borderRadius: '8px', overflow: 'hidden', touchAction: 'none' }"
             @pointerdown.capture="onCanvasPointerDown" @pointermove.capture="onCanvasPointerMove"
             @pointerup.capture="onCanvasPointerUp" @pointerleave="onCanvasPointerLeave" @wheel="onWheel">
          <PenOverlay :pen="pen" :view="view" :width="CANVAS_W" :height="CANVAS_H" :cursor="svgCursor"
                      @commit="handlePenCommit" @cancel="handlePenCancel" />
        </div>
        <!-- the dev page has no overlay dock, so it places the toolbar below the
             canvas — a host with one (the Frame editor) puts it there instead. -->
        <PenToolbar :pen="pen" style="margin-top: 12px" @commit="handlePenCommit" @cancel="handlePenCancel" />
      </div>
      <!-- pen stage 6: the Properties panel beside the canvas -->
      <PenProperties :pen="pen" data-testid="sketch-pen-properties"
                     style="width: 240px; flex: none; background: #141414; border: 1px solid #2a2a2a; border-radius: 10px" />
    </div>
```

(the canvas wrapper's attributes and handlers are exactly today's — only its nesting changes).

- [ ] **Step 2: The Frame** — before editing, save your starting point for hunk staging: `cp frontend/app/components/vue-canvas/CompositorModal.vue /tmp/cm-before.vue; git show HEAD:frontend/app/components/vue-canvas/CompositorModal.vue > /tmp/cm-head.vue`. Then in `CompositorModal.vue`:
  - add `import PenProperties from '~/components/pen/PenProperties.vue'` directly under `import PenToolbar from '~/components/pen/PenToolbar.vue'`;
  - in the `compositor-right-panel` block, right after the closing `</div>` of the "Design | Motion | Layout tabs" row, insert:

```vue
      <!-- The shared pen's Properties take the panel's body while a session is
           open (pen stage 6); the tabs stay — Motion still closes the pen. -->
      <PenProperties v-if="penSession" :key="penSession.key" :pen="penSession.pen"
                     data-testid="frame-pen-properties" class="flex-1 min-h-0 overflow-y-auto" />
```

  - change the next line `<template v-if="brandOpen">` to `<template v-else-if="brandOpen">`.

  Stage only these hunks: apply the same three edits to `/tmp/cm-head.vue` (with the Edit tool, same old/new strings), then inside your private index `git update-index --cacheinfo 100644,$(git hash-object -w /tmp/cm-head.vue),frontend/app/components/vue-canvas/CompositorModal.vue` instead of `git add` for this path. Check `git diff --cached -- frontend/app/components/vue-canvas/CompositorModal.vue` (private index) shows exactly your three changes.

- [ ] **Step 3: Shape Studio** — in `ShapeStudioSurface.vue` add `import PenProperties from '~/components/pen/PenProperties.vue'` under `import PenToolbar …`, and in `<template #aside>` put before the existing `<div class="relative flex min-h-0 w-full">`:

```vue
      <!-- pen stage 6: while the pen is open its Properties take the rail's place
           (the rail was locked then anyway — the session belongs to one layer) -->
      <PenProperties v-if="penSession" :key="penSession.key" :pen="penSession.pen" data-testid="shape-pen-properties" class="w-full" />
```

and add `v-else` to that `<div class="relative flex min-h-0 w-full">`. (Its inner `penSession` lock bits are left as they are — unreachable now, harmless; not this stage's clean-up.) If the file carries other sessions' uncommitted hunks, stage with the same HEAD-copy recipe as Step 2.

- [ ] **Step 4: Update the two host specs**
  - `tests/shape-pen.spec.ts` lines 114–116 become:

```ts
  await expect(page.getByTestId('shape-pen-properties')).toBeVisible()   // Properties take the rail's place
  await expect(actionRows).toHaveCount(0)
  await expect(page.getByTestId('shape-rail')).toHaveCount(0)
```

  and the comment above them: `// Edit it again. Nothing else edits the layer while the pen is open: no action rows (Try other settings, Randomize), the rail replaced by the pen's Properties, the Shape rows locked.`
  - `tests/frame-pen.spec.ts`, in 'paste, right-click and a file drop do nothing while the pen is open…': rename it to `'paste, a file drop and the Frame's right-click menu do nothing while the pen is open; each works again once it closes'`, change the `// (b) right-click on the image layer` comment to `// (b) right-click on the image layer: the pen's own menu opens, never the image's`, and insert right before `// ── controls: with the pen closed, the same routes do act ──`:

```ts
    await expect(page.locator('[data-pen-menu]')).toBeVisible()
    await page.keyboard.press('Escape')                       // closes the pen's menu; the pen stays open
    await expect(page.locator('[data-pen-menu]')).toHaveCount(0)
    await expect(penToolbar(page)).toBeVisible()
```

- [ ] **Step 5: Run the host specs**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts --project=chromium`
Expected: all pass. If a page serves old modules, `touch` the changed files and curl the served `PenProperties.vue` for `data-pen-properties` (Global Constraints) — never restart the server. A layout check in `sketch-draw.spec.ts` that measured the canvas's position may move by the flex wrapper; if one fails only because of the new column, fix the page layout (not the spec) so the canvas keeps its old top-left.

- [ ] **Step 6: Commit** `frontend/app/pages/dev/sketch-draw.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/app/components/vue-canvas/ShapeStudioSurface.vue frontend/tests/frame-pen.spec.ts frontend/tests/shape-pen.spec.ts` (CompositorModal / ShapeStudioSurface through `update-index` if they carried others' hunks) — message `feat(pen): Properties in every host — beside the pen page's canvas, the Frame's right panel, Shape Studio's rail (stage 6)`.

---

### Task 11: Real-mouse proof — menu, wheel, copy / paste, Properties, three hosts, widths

**Files:**
- Test: `frontend/tests/pen-menus.spec.ts` (new)

**Behaviour:** the spec's Stage 6 testing line, with the real mouse and keyboard (right button press-drag for the wheel), on the pen page, the Frame and Shape Studio, at 1280 and 1024 wide. `__sketchDraw` only sets drawings up (`load`) and reads them back.

**Interfaces:**
- Consumes: every DOM hook above; `__sketchDraw.load`, `.doc`, `.selection`, `.menu`, `.wheel`, `.highlight`, `.status`, `.canUndo`.

- [ ] **Step 1: Write the spec** — create `frontend/tests/pen-menus.spec.ts`:

```ts
// tests/pen-menus.spec.ts
// Pen stage 6 with the REAL mouse and keyboard: the right-click list menu
// (heading, rules, actions with keys, greyed items and their reasons, the
// keyboard, empty space), the action wheel (right-press-drag, release on a
// slice, the middle cancels, greyed slices), Copy / Paste and Copy as SVG,
// the Properties panel (typing, the radius lock, rule hover and removal),
// the Frame and Shape Studio, and laptop widths.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const D = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const svg = (page: Page) => page.locator('svg[data-pen-overlay]')
// drawing → page px on the pen page (34 px/unit, y up, origin at (40, 400) of the 680×460 board)
async function at(page: Page, x: number, y: number) {
  const b = (await svg(page).boundingBox())!
  return { x: b.x + 40 + 34 * x, y: b.y + 400 - 34 * y }
}
// two lines, a line running into a tangent arc
async function load(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__sketchDraw.load({
      entities: [
        { id: 'a', kind: 'point', x: 2, y: 2 }, { id: 'b', kind: 'point', x: 8, y: 2 }, { id: 'L1', kind: 'line', p1: 'a', p2: 'b' },
        { id: 'c', kind: 'point', x: 2, y: 5 }, { id: 'd', kind: 'point', x: 8, y: 6 }, { id: 'L2', kind: 'line', p1: 'c', p2: 'd' },
        { id: 'q1', kind: 'point', x: 10, y: 2 }, { id: 'q2', kind: 'point', x: 14, y: 2 }, { id: 'q5', kind: 'point', x: 16, y: 4 },
        { id: 'qc', kind: 'point', x: 14, y: 4 }, { id: 'L3', kind: 'line', p1: 'q1', p2: 'q2' },
        { id: 'A1', kind: 'path', anchors: ['q2', 'q5'], segments: [{ kind: 'arc', center: 'qc', sweep: 1 }], closed: false },
      ],
      constraints: [
        { id: 'k1', kind: 'equalDist', refs: ['qc', 'q2', 'qc', 'q5'] },
        { id: 'k2', kind: 'perpendicular', refs: ['q1', 'q2', 'q2', 'qc'] },
      ],
    })
  })
}
const menu = (page: Page) => page.locator('[data-pen-menu]')
const mi = (page: Page, id: string) => page.locator(`[data-pen-menu] [data-menu-item="${id}"]`)

test('a right-click on a line selects it and lists its rules and actions; a greyed one says why', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 5.5)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__sketchDraw.selection)).toEqual(['L2'])
  await expect(page.locator('[data-pen-menu-header]')).toHaveText('1 line')
  await expect(mi(page, 'rule:horizontal')).toBeVisible()
  await expect(mi(page, 'construction')).toContainText('X')
  await expect(mi(page, 'mirror')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'mirror').hover()
  await expect(page.locator('[data-pen-tip-id="mirror"] [data-pen-tip-reason]')).toHaveText('Select a shape first')
  await mi(page, 'rule:horizontal').click()
  await expect(menu(page)).toHaveCount(0)
  const d = await D(page)
  expect(d.constraints.some((k: any) => k.kind === 'horizontal')).toBe(true)
  const c = d.entities.find((e: any) => e.id === 'c'), dd = d.entities.find((e: any) => e.id === 'd')
  expect(Math.abs(c.y - dd.y)).toBeLessThan(1e-6)
})

test('the menu by keyboard: arrows, Enter; then the same rule reads Already true and Vertical conflicts', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 2)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.keyboard.press('ArrowDown')
  await expect(mi(page, 'rule:horizontal')).toHaveAttribute('data-active', '')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(mi(page, 'rule:horizontal')).toHaveAttribute('aria-disabled', 'true')
  await expect(mi(page, 'rule:vertical')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'rule:vertical').hover()
  await expect(page.locator('[data-pen-tip-id="vertical"] [data-pen-tip-reason]')).toHaveText('Conflicts with another rule')
  const before = await D(page)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(await D(page)).toEqual(before)
})

test('empty space offers Paste and Select all; Select all selects every piece', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 17, 11)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(page.locator('[data-pen-menu-header]')).toHaveCount(0)
  await expect(mi(page, 'paste')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'select-all').click()
  expect((await page.evaluate(() => (window as any).__sketchDraw.selection)).sort()).toEqual(['A1', 'L1', 'L2', 'L3'])
})

test('a click on the drawing closes the menu and does nothing else', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 17, 11)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  const l2 = await at(page, 5, 5.5)
  await page.mouse.click(l2.x, l2.y)
  await expect(menu(page)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__sketchDraw.selection)).toEqual([])
})

test('⌘C / ⌘V copy a line with its rule, 16 px down-right, selected; one undo step', async ({ page }) => {
  await open(page); await load(page)
  await page.evaluate(() => {
    const raw = JSON.parse(JSON.stringify((window as any).__sketchDraw.doc))
    raw.constraints.push({ id: 'h1', kind: 'horizontal', refs: ['a', 'b'] })   // already level: the solve moves nothing
    ;(window as any).__sketchDraw.load(raw)
  })
  const p = await at(page, 5, 2)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press(`${META}+c`)
  await page.keyboard.press(`${META}+v`)
  const d = await D(page)
  const lines = d.entities.filter((e: any) => e.kind === 'line')
  expect(lines).toHaveLength(4)
  const nl = lines[3]
  expect(await page.evaluate(() => (window as any).__sketchDraw.selection)).toEqual([nl.id])
  const np = d.entities.find((e: any) => e.id === nl.p1), a = d.entities.find((e: any) => e.id === 'a')
  expect(np.x - a.x).toBeCloseTo(16 / 34, 4)
  expect(np.y - a.y).toBeCloseTo(-16 / 34, 4)
  expect(d.constraints.filter((k: any) => k.kind === 'horizontal')).toHaveLength(2)
  await page.keyboard.press(`${META}+z`)
  expect((await D(page)).entities.filter((e: any) => e.kind === 'line')).toHaveLength(3)
})

test('the menu’s Paste lands on the right-clicked spot; Copy as SVG writes the outline', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page); await load(page)
  const l1 = await at(page, 5, 2)
  await page.mouse.click(l1.x, l1.y, { button: 'right' })
  await mi(page, 'copy-svg').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('M 2 2 L 8 2')
  await page.mouse.click(l1.x, l1.y, { button: 'right' })
  await mi(page, 'copy').click()
  const spot = await at(page, 12, 10)
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await mi(page, 'paste').click()
  const d = await D(page)
  const nl = d.entities.filter((e: any) => e.kind === 'line').at(-1)
  const p1 = d.entities.find((e: any) => e.id === nl.p1), p2 = d.entities.find((e: any) => e.id === nl.p2)
  expect((p1.x + p2.x) / 2).toBeCloseTo(12, 1)
  expect((p1.y + p2.y) / 2).toBeCloseTo(10, 1)
})

test('the wheel: right-press-drag opens it at the press point; a slice runs; the middle cancels; greyed says why', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 5.5)
  const drag = async (dx: number, dy: number) => {
    await page.mouse.move(p.x, p.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 })
  }
  // the middle cancels
  await drag(60, 0)
  await expect(page.locator('[data-pen-wheel]')).toBeVisible()
  await page.mouse.move(p.x + 2, p.y + 2, { steps: 4 })
  await page.mouse.up({ button: 'right' })
  await expect(page.locator('[data-pen-wheel]')).toHaveCount(0)
  await expect(menu(page)).toHaveCount(0)
  expect((await D(page)).constraints.map((k: any) => k.id)).toEqual(['k1', 'k2'])
  // a greyed slice says why and does nothing
  await drag(0, -70)
  await expect(page.locator('[data-wheel-slice="n"]')).toHaveAttribute('data-greyed', '')
  await expect(page.locator('[data-pen-wheel-note]')).toHaveText('Doesn’t apply to this selection')
  await page.mouse.up({ button: 'right' })
  expect((await D(page)).constraints).toHaveLength(2)
  // up-left is Horizontal
  await drag(-50, -50)
  await expect(page.locator('[data-pen-wheel]')).toHaveAttribute('data-layout', 'segment')
  await expect(page.locator('[data-wheel-slice="nw"]')).toHaveAttribute('data-hover', '')
  await expect(page.locator('[data-pen-wheel-note]')).toHaveText('Horizontal')
  await page.mouse.up({ button: 'right' })
  expect((await D(page)).constraints.some((k: any) => k.kind === 'horizontal')).toBe(true)
})

test('the point wheel: two points, West joins them', async ({ page }) => {
  await open(page); await load(page)
  const a = await at(page, 2, 2), c = await at(page, 2, 5)
  await page.mouse.click(a.x, a.y)
  await page.keyboard.down('Shift'); await page.mouse.click(c.x, c.y); await page.keyboard.up('Shift')
  await page.mouse.move(c.x, c.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(c.x - 70, c.y, { steps: 8 })
  await expect(page.locator('[data-pen-wheel]')).toHaveAttribute('data-layout', 'point')
  await page.mouse.up({ button: 'right' })
  expect((await D(page)).entities.some((e: any) => e.id === 'c')).toBe(false)
})

test('a Mac ctrl-click opens the menu too', async ({ page }) => {
  test.skip(process.platform !== 'darwin', 'Mac only')
  await open(page); await load(page)
  const p = await at(page, 5, 5.5)
  await page.keyboard.down('Control')
  await page.mouse.click(p.x, p.y)
  await page.keyboard.up('Control')
  await expect(menu(page)).toBeVisible()
})

test('Properties: a line’s length and a point’s X typed; an arc’s lock, its rule hover and removal', async ({ page }) => {
  await open(page); await load(page)
  const props = page.getByTestId('sketch-pen-properties')
  await expect(props.locator('[data-props-header]')).toHaveText('Nothing selected')
  const l1 = await at(page, 5, 2)
  await page.mouse.click(l1.x, l1.y)
  await expect(props.locator('[data-props-header]')).toHaveText('1 line')
  const len = props.locator('[data-prop="length"] input')
  await len.click({ clickCount: 3 }); await page.keyboard.type('4'); await page.keyboard.press('Enter')
  let d = await D(page)
  const A = d.entities.find((e: any) => e.id === 'a'), B = d.entities.find((e: any) => e.id === 'b')
  expect(Math.hypot(B.x - A.x, B.y - A.y)).toBeCloseTo(4, 4)
  const dot = page.locator('[data-point="c"]')
  await dot.click()
  const x = props.locator('[data-prop="x"] input')
  await x.click({ clickCount: 3 }); await page.keyboard.type('3'); await page.keyboard.press('Enter')
  expect((await D(page)).entities.find((e: any) => e.id === 'c').x).toBeCloseTo(3, 6)
  // the arc: Option-click picks the segment
  const arc = await at(page, 14 + 2 * Math.cos(-Math.PI / 4), 4 + 2 * Math.sin(-Math.PI / 4))
  await page.keyboard.down('Alt'); await page.mouse.click(arc.x, arc.y); await page.keyboard.up('Alt')
  await expect(props.locator('[data-props-header]')).toHaveText('1 arc')
  await props.locator('[data-act="radius-lock"]').click()
  await expect(props.locator('[data-act="radius-lock"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(props).toContainText('Radius 2 — Arc 1')
  const row = props.locator('[data-rule-row="k2"]')
  await expect(row).toContainText('Tangent — Line 3 · Arc 1')
  await row.hover()
  expect((await page.evaluate(() => (window as any).__sketchDraw.highlight())).sort()).toEqual(['line:L3', 'seg:A1:0'].sort())
  await expect(page.locator('[data-highlight]')).toHaveCount(2)
  await row.locator('[data-act="rule-remove"]').click()
  d = await D(page)
  expect(d.constraints.some((k: any) => k.id === 'k2')).toBe(false)
  await expect(page.locator('[data-highlight]')).toHaveCount(0)
})

for (const width of [1280, 1024]) {
  test(`the menu and Properties fit at ${width} px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page); await load(page)
    const scrollBefore = await page.evaluate(() => document.documentElement.scrollWidth)
    const props = (await page.getByTestId('sketch-pen-properties').boundingBox())!
    expect(props.x + props.width).toBeLessThanOrEqual(width)
    const edge = await at(page, 18.5, 1)      // near the canvas's right edge (it ends at 18.8)
    await page.mouse.click(edge.x, edge.y, { button: 'right' })
    const m = (await menu(page).boundingBox())!
    expect(m.x).toBeGreaterThanOrEqual(0)
    expect(m.x + m.width).toBeLessThanOrEqual(width)
    expect(m.y + m.height).toBeLessThanOrEqual(800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(Math.max(scrollBefore, width))
  })
}

for (const width of [1280, 1024]) {
  test(`the Frame’s pen: right-click opens the pen’s menu, not the Frame’s; Properties in the right panel (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first().click()
    await expect(page.locator('[data-tool="path"]')).toBeVisible()
    const box = (await page.locator('[data-testid="frame-pen-overlay"]').boundingBox())!
    await page.locator('[data-tool="line"]').click()
    const y = box.y + box.height / 2
    await page.mouse.click(box.x + box.width * 0.3, y)
    await page.mouse.click(box.x + box.width * 0.6, y)
    await page.locator('[data-tool="select"]').click()
    await page.mouse.click(box.x + box.width * 0.45, y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(page.locator('[data-pen-menu-header]')).toHaveText('1 line')
    await expect(page.getByText('Edit image…', { exact: true })).toHaveCount(0)
    const props = page.getByTestId('frame-pen-properties')
    await expect(props).toBeVisible()
    await expect(page.locator('[data-testid="compositor-right-panel"] [data-testid="frame-pen-properties"]')).toHaveCount(1)
    await expect(props.locator('[data-prop="length"]')).toBeVisible()
    const pb = (await props.boundingBox())!
    expect(pb.x + pb.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(page.locator('[data-tool="path"]')).toBeVisible()
    // the wheel reaches the Frame too
    await page.mouse.move(box.x + box.width * 0.45, y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(box.x + box.width * 0.45 - 50, y - 50, { steps: 8 })
    await expect(page.locator('[data-pen-wheel]')).toBeVisible()
    await page.mouse.up({ button: 'right' })
    await expect(page.locator('[data-pen-wheel]')).toHaveCount(0)
    await expect(page.locator('[data-tool="path"]')).toBeVisible()
  })
}

test('Shape Studio’s pen: right-click opens the pen’s menu; Properties in the rail’s place; Escape leaves the studio open', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await expect(page.getByTestId('shape-pen-properties')).toBeVisible()
  const box = (await page.locator('[data-testid="shape-pen-overlay"]').boundingBox())!
  await page.locator('[data-tool="line"]').click()
  const y = box.y + box.height * 0.7
  await page.mouse.click(box.x + box.width * 0.3, y)
  await page.mouse.click(box.x + box.width * 0.6, y)
  await page.locator('[data-tool="select"]').click()
  await page.mouse.click(box.x + box.width * 0.45, y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__shapeStudioLab.closes as number)).toBe(0)
})
```

- [ ] **Step 2: Run it**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/pen-menus.spec.ts --project=chromium`
Expected: all pass (the Mac ctrl-click case skips off a Mac). If the page serves old modules, `touch` the pen files and curl the served `PenOverlay.vue` for `startRightPress` — never restart the server. If a check fails for real, fix the code in the file from the task that owns it (re-run that task's unit tests) rather than loosening the spec, and say so in your report. If the Frame or Shape Studio line lands on existing artwork so the right-click hits something else, move the line to an empty band of the board — keep the assertions.

- [ ] **Step 3: Run the other pen specs and the unit set**

Run: `cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/sketch-draw.spec.ts tests/frame-pen.spec.ts tests/shape-pen.spec.ts tests/pen-snap.spec.ts tests/pen-weld.spec.ts tests/pen-trim.spec.ts tests/pen-tips.spec.ts tests/pen-tangent.spec.ts tests/pen-cleanup.spec.ts tests/pen-menus.spec.ts --project=chromium`
Expected: all pass. Then `npx vitest run tests/unit/pen-*.unit.spec.ts tests/unit/sketch-*.unit.spec.ts tests/unit/cleanup-*.unit.spec.ts` — all pass (counts wobble under load; re-run a failing file alone before calling it a failure).

- [ ] **Step 4: Commit** `frontend/tests/pen-menus.spec.ts` (plus any fix, by exact path) — message `test(pen): menus, wheel, copy and paste, Properties with the real mouse — pen page, Frame, Shape Studio, laptop widths (stage 6)`.

---

### Task 12: Record it

**Files:**
- Modify: `docs/STATE.md` (new entry at the top of the landed list, above "The pen — Clean up (stage 5)")
- Modify: `docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` (status line only)

- [ ] **Step 1: STATE.md entry** — heading `### The pen — right-click menu, action wheel, properties (stage 6) — LANDED <date> (spec docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md, plan docs/superpowers/plans/2026-09-27-pen-stage-6-menus-properties.md; <first>..<last> commits)`, then in the style of the stage 5 entry: what you can do (right-click → menu headed by the selection, its rules then the actions with keys, greyed items say why; empty space → Paste / Select all; right-press-drag → the 8-slice wheel, point and segment layouts; ⌘C / ⌘V inside the pen, shared across hosts, Copy as SVG; X, ⇧H, ⇧V, ⌘A; Properties beside the pen page's canvas, in the Frame's right panel, in Shape Studio's rail: sizes typed, radius lock, rules named, hover lights both pieces, × removes, + adds with refusals), what was proven (the unit files, `tests/pen-menus.spec.ts`, the host specs green, 1280 / 1024), the rulings (the list at the top of the plan — at least 1–5, 8, 9, 12–15, 20), and known limits (the rules row doesn't grey or refuse — only the menu, wheel and Properties do; piece numbers shift after a deletion; a paste into another host lands at the copy's own drawing coordinates, which may be off screen — use the menu's Paste; the rule check trial-solves the whole drawing, so a very large drawing opens the menu slower; wheel slices fixed; stage 8's Offset / Round corner / Chamfer slot in through `SELECTION_MENU`).
- [ ] **Step 2: Spec status line** → `Status: designed 2026-09-26 on the owner's "let's build stage 4-8 first"; stage 4 built 2026-09-26; stage 5 built 2026-09-27; stage 6 built <date>`.
- [ ] **Step 3: Commit** `docs/STATE.md docs/superpowers/specs/2026-09-26-pen-stages-4-8-design.md` — message `docs(pen): stage 6 built — right-click menu, action wheel, properties`. (The controller, not the implementer, updates the build dashboard afterwards.)

---

## Self-review

**Spec coverage (Stage 6):**
- Right-click menu: list menu on a right-click on the drawing or a selection (Tasks 6–8, 11); headed by the selection ("2 points" / "1 arc" / "3 selected" — Task 1 `selectionLabel`); the rules row's rules then Make guide (X), Flip horizontal (⇧H), Flip vertical (⇧V), Mirror…, Repeat…, Copy (⌘C), Copy as SVG, Paste (⌘V), Delete, each with its key (Tasks 6, 7); Offset… / Round corner… / Chamfer… absent until stage 8 extends `SELECTION_MENU` (Ruling 2, test in Task 6); greyed items say why in their card (Tasks 6, 7, 11); empty space selects nothing and offers Paste and Select all (Tasks 6, 8, 11); right-clicking an unselected piece selects it first (Task 8, Ruling 4); Copy / Paste with the rules among them, paste 16 px and selected (Tasks 2, 4, 11); Copy as SVG through the existing export's format (Tasks 4, 11).
- Action wheel: right-press and drag → 8 slices round the pointer, release on a slice runs it, the middle cancels (Tasks 6, 8, 11); Zoah's point and segment layouts exactly (Task 6 `WHEEL_LAYOUTS`, test); greyed slices (Tasks 6, 7, 11); fixed slices (Ruling 5); a plain right-click still opens the list menu (Task 8).
- Properties: in each host's side panel while the pen is open — pen page beside the canvas, Frame the right inspector's place, Shape Studio the rail's place (Task 10); Point X / Y, Line Length / Angle, Arc Radius (lock) / Length / Sweep, Circle Radius (lock), typed with the inline value field (Tasks 5, 9); Rules list by name and what it ties, hover lights both pieces, × removes, + adds any rule the rules row offers (Tasks 1, 9, 11); refusals "Already true", "Conflicts with another rule", "Doesn’t apply to this selection" (Tasks 3, 6, 9).
- Shared ground: one pen, three hosts (Task 10, checks in Task 11); no new pieces or rule kinds, paste re-points refs (Global Constraints, Task 2); px tolerances (wheel, paste step); one undo step per gesture (Tasks 4, 5, 6); copy rules and a card for every new button (Task 7, 9); Bézier untouched (sizes skip cubic pieces; copy carries them as they are). Testing: real-mouse right-click menu, wheel, properties typing and rule removal (Task 11); the Frame and Shape Studio pen specs stay green and each host reached (Tasks 10, 11); 1280 / 1024 (Task 11).
- Out of scope kept out: customisable wheel slices, stage 7–8 features.

**Spec problems found:** (1) "Copy as SVG uses the existing export" — the only export is the pen page's Copy SVG button, which writes bare path data (`sketchPathData`), not an SVG document; ruled the same format, for the selection (Ruling 8). (2) The point layout puts Horizontal and Vertical on points, but no rule offered them for points; `horizontal` / `vertical` already take a point pair, so two points now offer them — in the rules row too, which changes one existing unit expectation (Ruling 15). (3) "Right-clicking an unselected piece selects it first" says nothing about draw tools, where selecting would leave a stale selection under the next stroke; ruled Select only (Ruling 4). (4) Fix, Dissolve, Coincident and Select all are wheel slices / the empty-space menu but not in the menu's list; ruled where each appears (Ruling 3). (5) "The right inspector's place" — the Frame's right panel carries Design / Motion / Layout tabs and an existing spec clicks Motion to close the pen, so the tabs stay and Properties takes the body (Ruling 14). (6) Shape Studio's "rail" is taken as the left layer rail (locked while the pen is open anyway); an existing spec asserted its lock and now asserts Properties (Ruling 14). (7) `tests/frame-pen.spec.ts` asserted a right-click does nothing during the pen, which the spec now overturns; updated to see the pen's menu (Ruling 20). (8) The spec doesn't say whether the rules row greys too; greying it would change stage 1–5 behaviour and specs, so it doesn't (Ruling 1). (9) "Length" of a line and "Sweep" of an arc have no lock in the spec — ruled one-off moves, rules permitting (Ruling 13).

**Type consistency:** `PieceRef`, `SegPick`, `pieceKey`, `segCount`, `pieceNames`, `rulePieces`, `ruleLabel`, `rulesForSelection`, `selectionLabel`, `topLevelIds` (Task 1) are used with those names in Tasks 2, 4, 5, 6, 8, 9, 10; `extractPieces`, `insertPieces`, `piecesCentre`, `hasClosedPieces` (Task 2) in Task 4; `checkRule`, `MergeSpec`, `ruleSpecFor` (Task 3) in Task 6; `ActionState`, `OK`, `no`, `REASON` (Task 4 `penReasons.ts`) in Tasks 6, 7 tests; `penClipboard`, `setPenClipboard`, `nextPasteStep`, `clearPenClipboard`, `PASTE_STEP_PX` (Task 4) in Tasks 4, 6 tests; `SizeTarget`, `sizeTargetFor`, `measureSizes`, `SIZE_REFUSED` and the pen setters `setPointXY` / `setLineLength` / `setLineAngle` / `setArcRadiusValue` / `setArcSweep` / `setArcLength` / `toggleArcRadiusLock` / `setCircleRadius` / `toggleCircleRadiusLock`, `highlight`, `setHighlight`, `view` (Task 5) in Task 9; `ACTIONS`, `SELECTION_MENU`, `EMPTY_MENU`, `PenMenuItem`, `menuFor`, `runItem`, `wheelFor`, `wheelDirAt`, `WHEEL_*`, `PenMenu`, `PenWheel`, `menu`, `wheel`, `openMenu`, `closeMenu`, `closeMenus`, `setMenuActive`, `runMenuItem`, `openWheel`, `wheelPointer`, `releaseWheel`, `closeWheel`, `ruleItems`, `runAction`, `runKeyAction`, `isActionKey` (Task 6) in Tasks 7–10; DOM hooks (`data-pen-overlay`, `data-pen-menu`, `data-pen-menu-header`, `data-menu-item`, `data-active`, `data-pen-tip-reason`, `data-pen-wheel`, `data-layout`, `data-wheel-slice`, `data-greyed`, `data-hover`, `data-pen-wheel-note`, `data-highlight`, `data-pen-properties`, `data-props-header`, `data-prop`, `data-act="radius-lock" | "rule-remove" | "rule-add"`, `data-rule-row`, `data-rule-add`, the three `*-pen-properties` test ids) match Task 11.
