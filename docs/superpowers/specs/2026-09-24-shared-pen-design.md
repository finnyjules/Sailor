# One pen for every tool

**Date:** 2026-09-24 · **Status:** approved. Plans: A `docs/superpowers/plans/2026-09-24-shared-pen-a.md` (the pen); B (Frame) and C (Shape Studio) to follow

## Why

Sailor has five separate ways to draw a path, and the best one is locked in a test page.

- The **arc pen** (click to place, drag to bow a segment into a perfect arc, smooth joints, snapping,
  live rules, typed sizes, Repeat / Mirror) was built 2026-08-29 → 08-31 on `/dev/sketch-draw`. The
  plan always said it would move into Shape Studio next; the last plan (M5) left that as "the next
  decision" and nobody picked it up.
- The **Frame pen** (`composables/useVectorPen.ts`) is the older click-and-drag-handles pen. It draws
  new path layers and the text "Drawn path" guide.
- Space Type's string path editor, the Loft spine editor and the Gradient curve handles each have their
  own editor too (out of scope here — see the end).

The goal: **one pen, shared by every tool that needs one.** Fix it once, and it is fixed everywhere.

## Decisions made in chat

1. **First round: Shape Studio and the Frame** (the Frame pen tool and the text "Drawn path"). The pen
   is built so other tools can plug in later.
2. **Drawings keep their rules everywhere.** A path drawn with the pen can be reopened later, and
   dragging one point re-arranges the rest. Paths made another way (imported SVG, library shapes,
   old handle-drawn paths) stay plain paths.
3. **The shared pen replaces the Frame's handles pen.** Arcs are the default way of drawing; a second
   **Curve** tool draws Bézier curves with handles, for freeform shapes (tracing, organic outlines, wavy
   guides). Both can go into the same path. Old saved handle paths keep drawing and editing exactly as
   they do today.
4. **Approach A:** one shared pen overlay that each tool hosts over its own canvas — you draw in place,
   over the real frame or preview.
5. **The pen has its own dedicated toolbar** with its tools and rule actions (tangent and the rest).

## 1. The shared pen

Three pieces.

### 1a. The maths — `lib/sketch/` (mostly unchanged)

The drawing model (points, lines, circles, arc paths, rules), the solver, snapping, tangent joints,
and `sketchPath` (drawing → SVG `d`). Already free of any screen code.

The two solver fixes the sketch notes listed as owed (stop early on the hard residual; restore after a
failed `n === 0` solve) are **already in `solve.ts` at HEAD** — checked 2026-09-24. No work.

### 1b. The pen's state — `composables/usePen.ts` (new)

Everything `pages/dev/sketch-draw.vue` tracks today, moved out of the page:

- current tool, guide mode, labels on/off;
- selection (entities and path segments);
- the half-drawn path, rubber band, the live arc being bowed, pending Repeat / Mirror operation;
- drag in progress and the live solve;
- undo / redo history (view changes never enter it);
- typed sizes while drawing.

It knows nothing about pixels or where it is drawn. It takes positions in **drawing units** and a
**screen-pixels-per-unit** figure from the host (for snapping, below).

### 1c. The pen overlay — `components/pen/PenOverlay.vue` (new)

A see-through layer placed exactly over the host's canvas. It:

- draws the drawing, rubber band, live arc, points, handles, rule badges and size chips;
- handles pointer and keyboard input (Enter finishes, Escape cancels or backs out, Delete, arrows
  nudge, Shift captures horizontal / vertical, space-drag is left to the host if the host pans);
- shows the pen toolbar (section 2).

### What a host gives the pen

| Input | Meaning |
|---|---|
| `doc` (`v-model`) | The drawing to edit. Handed back on every change. |
| `view` | One affine matrix, drawing → screen (`{a,b,c,d,e,f}`, SVG order). It may translate, scale unevenly, rotate and mirror. The Frame builds it from the layer's position, scale and rotation. The pen inverts it for pointer input. |
| `options` | Which tools to show; `openOnly` (text guides); `closedOnly` (if a host ever needs it); starting tool. |
| `commit` / `cancel` events | Fired on Enter / Done and Escape / Cancel. The host decides what happens. |

### What the pen does not do

It does not store anything, pick colours for the finished shape, zoom or pan the host, or know which
tool it is in.

### Snapping measured on screen

Snapping tolerances today are in drawing units (`infer.ts` default `tol 0.6`, bow threshold 0.15, minimum
radius 0.2), which only feel right at the test page's default 34 px per unit. The pen holds them as
**screen distances — 20.4 px, 5.1 px, 6.8 px**, exactly today's feel at that zoom — and converts them
into drawing units through the view matrix on every use, so snapping feels the same in a small Frame and a zoomed-in
Shape Studio. The tangent-joint angle tolerance (12°) is already scale-free and stays.

### Orientation

The drawing is stored in the **host's own units and axis direction**, and `sketchPath` emits `d` in the
same space. The overlay draws that outline **in drawing space inside `<g transform="matrix(…)">`** with
non-scaling strokes, so rotation, uneven scale and mirroring (the test page's y-up view) need no arc
correction. Today's trick — rebuilding a screen-space copy and flipping each arc's sweep — only works
without rotation or uneven scale, and goes. Only live screen-space previews of an arc check whether
the matrix mirrors.

## 2. The pen toolbar

A dedicated floating toolbar that belongs to the pen, the same in every host. While the pen is open it
**replaces the host's own tool bar** (the Frame's bottom toolbar; Shape Studio's preview controls), so
there is one set of tools on screen at a time. Built from the studios' shared button parts
(`StudioButton`), icons with tooltips, sentence-case labels.

**Tool row — always shown**

- Select · Pen (arcs, the default) · Curve (Bézier, tooltip "Bézier curve — drag to pull out handles")
  · Line · Circle · Point
- Guide (toggle: new geometry is construction geometry that shapes the drawing but is not drawn)
- Labels (toggle: show / hide rule badges and size chips)
- Undo · Redo
- Cancel · Done

**Rules row — appears when something is selected, showing only actions that apply**

The same selection-sensitive list the test page's `availableConstraints()` computes today, including:

- Tangent · Concentric · Equal · Coincident · Midpoint · Point on line · Point on circle
- Horizontal · Vertical · Perpendicular (Right angle on one segment) · Parallel
- Distance… · Radius… (type a value)
- Fix · Repeat… · Mirror · Flip horizontal · Flip vertical · Make guide · Delete

"Copy SVG" stays on the test page only (it is a developer aid).

Rules that need exact geometry — Tangent, Radius, Concentric, tangent joints — only apply to arcs,
lines and circles. When a Curve segment is selected the rules row hides them rather than offering
actions that do nothing.

**Hint line.** While drawing, a one-line hint under the toolbar says what the next click does ("Click to
add a point, drag to bend it into an arc, click the first point to close"). While Repeat / Mirror waits
for a pick, it says what to pick, with Cancel.

The exact layout (one bar or two, where it floats, grouping) is settled with a **clickable prototype
first**, before the component is built.

**Toolbar decision (2026-09-24, from the prototype https://claude.ai/artifact/VrpxMPqoCMzMULZmNmUymq):
layout A — two rows.** The tool row sits centred along the bottom of the host canvas. When something is
selected, the rules row appears directly above it: "N selected", then the rules that apply, a divider,
Fix · Repeat… · Mirror · Flip horizontal · Flip vertical · Make guide, a divider, Delete (red). The hint
line sits under the tool row. Rejected: B (a rules bar floating over the selection) and C (a right-click
menu).

## 2b. The Curve tool (Bézier)

The drawing model already has a cubic Bézier segment (`kind: 'cubic'`, two handle points) and
`sketchPath` already draws it as `C`. The draw tool for it was retired on 2026-08-31 (`78788db4a`) when
arcs became the single gesture; this brings it back as the second tool.

- **Gesture:** click places a sharp point; click-and-drag places a smooth point and pulls out its handles
  (the opposite handle mirrors, held by a `collinear` rule).
- **Mixed paths:** Pen and Curve add to the same open path; each new segment is an arc/line or a curve
  depending on the tool active when its end point is placed. Switching tools mid-path does not end it.
- **Editing:** drag a handle; on a smooth point the opposite handle follows. Handles ride along when
  their point is dragged. Deleting a handle turns the point into a sharp corner — never deletes the path.
- **Rules:** point rules (Fix, Coincident, Horizontal, Vertical, Point on line / circle, Distance) work
  on a curve's points. A joint between a curve and an arc is not made tangent automatically this round.

Carried over from the 08-29 build notes, so they are not relearned:

- after a sharp point, always clear the previous out-handle (`else lastHOut = null`), or the next
  segment inherits a stale handle;
- handle points are construction points and are excluded from snapping;
- build plain (non-reactive) drawing copies before cloning — `structuredClone` throws on Vue-reactive
  arrays.

## 3. The Frame

### Storage

A Frame `PathLayer` gains one optional field: **`sketch?: SketchDoc`**, the pen's drawing in the
layer's local units (1 unit = frame width, centred on the path — the same frame as `d`).

- **`d` stays what everything draws from.** Rendering, export, strokes, effects, booleans, masks, the
  web embed: unchanged. `sketch` is only for editing.
- On each pen change: `d = sketchPath(sketch)`, then **re-centre** — shift the drawing so its outline is
  centred again and move the layer's `x / y` by the same amount, so nothing jumps on screen — and
  update `bbox`.

### The one boundary rule

If anything **other than the pen** writes a path layer's `d` (point editing, a boolean, an SVG replace,
a morph, recolour-to-path, anything), `sketch` is dropped, because it no longer describes the shape.
This lives in **one helper** that every `d` writer goes through (e.g. `writePathD(layer, d)`), not in
each site. Stage 2 greps every writer of `.d` on path layers and routes it through the helper.

(Lesson from the multi-stroke build, where one stale field destroyed stored data in four different
places because each writer had its own copy of the rule.)

### Pen tool

The toolbar pen button opens the shared pen over the frame, mapping screen ↔ normalised artboard.
Finishing creates a path layer with the current pen style, carrying `d` and `sketch`. Cancelling adds
nothing. **`useVectorPen.ts` is deleted**, along with its overlay and the `finishPen` branch.

### Editing later

- **Double-click a path that has a `sketch`** → the pen reopens on it, rules intact, mapped through the
  layer's position, scale and rotation (points land under the cursor on a rotated layer).
- **Double-click any other path** → the existing point editor (`useVectorNodeEdit`), unchanged.

### Text "Drawn path"

- The text guide (`TextPathSpec`, `follow: 'custom'`) gains `sketch?: SketchDoc` next to its `d`.
- The button reads **"Draw a path"** (none yet) or **"Edit the path"** (has one); both open the shared
  pen with `openOnly`.
- The pen's mapping matches how `guideFromPathD` places the guide — the bbox re-centring and the
  **Path size** refit — so the line you edit sits exactly where the type runs.
- While editing, the type keeps re-laying along the line as you drag.
- "Or use a path on the frame" copies that layer's `sketch` too, when it has one.
- A guide with `d` but no `sketch` (drawn before this change) shows "Draw a path" and a new drawing
  replaces it.

## 4. Shape Studio

### A drawn shape is a base shape, not a new layer type

The 2026-08-28 spec proposed a separate `kind: 'sketch'` layer. **Changed:** add **Drawn** to the existing
Shape picker (`BaseShapeKind`), next to Polygon, Star, Hexagon, Irregular and Library, and store the
drawing on the mark as **`mark.sketch`**. Everything Shape Studio already does then works on a drawn
shape: copies and arrangements (radial, grid, linear, blend), overlaps, folds, fills, colour order, the
layer stack, background. (The old spec's own principle: repeating a shape is Shape Studio's job.)

### Drawing it

- With **Drawn** selected, a **"Draw the shape"** button opens the shared pen over the preview. Picking
  Drawn with no drawing yet opens the pen straight away.
- You draw **one unit**, centred, in the layer's own units at its **Size**.
- While the pen is open, the other copies show faintly behind and follow along. **During a drag** they
  update as plain outlines; **the fold** (holes, pieces, crossings — O(N²)) runs **when you let go**.
- Done / Enter closes the pen and the full result renders.
- An empty drawing renders nothing (like a zero Size), never an error.

### Saved and shared

- `mergeConfig` validates `sketch` through the existing tolerant `mergeSketchDoc`: a damaged save
  becomes an empty drawing.
- All four readers of `node.data.properties.sailor_shapeStudio` go through `studioDocFromPersisted`
  (the studio surface, the node bake, the agent tuner in `lib/agent/studioTune.ts`, Collections in
  `lib/collection/studioControls.ts`), so they pick it up without edits. The control drift guard in
  `lib/geoshape/controls.ts` excludes `sketch` like the other bespoke fields.
- The agent can change count, layout and fills on a drawn shape but cannot draw. **Agent drawing verbs
  are out of scope.**

### The test page

`/dev/sketch-draw` becomes a thin host of `PenOverlay` over its own y-up canvas with pan and zoom, and
stays the lab. Its `window.__sketchDraw` API keeps working for the existing browser tests.

## 5. Build order and checks

Each stage lands on its own and leaves the app working.

0. ~~Solver fixes~~ — already done at HEAD.
1. **Pen toolbar prototype, then pull the pen out.** A clickable prototype of the toolbar is reviewed
   first. Then `usePen` + `PenOverlay` (with the toolbar), the mapping and screen-pixel snapping, and
   the test page rehosted. Check: the existing sketch browser tests pass unchanged; drawing, snapping,
   tangent joints and undo behave as today, driven with **real mouse clicks** (simulated pointer events
   did not drive the pen last time).
2. **Curve tool (Bézier).** Drawing and handle editing in the shared pen, before the Frame switches
   over so it never loses freeform curves. Check: unit tests for mixed arc / curve paths and handle
   deletion; live with real clicks — draw an S-curve, drag handles, delete one, mix with arcs, undo
   each step.
3. **Frame pen and path layers.** Pen tool, `sketch` on path layers, double-click to reopen, the
   `writePathD` boundary helper, `useVectorPen` deleted. Check: unit tests for re-centring and for every
   `d` writer dropping `sketch`; live — draw, move, scale, rotate, reopen, points under the cursor on a
   rotated layer; existing frames render **pixel-identical** (no saved layer has a `sketch` yet).
4. **Text "Drawn path".** Check: live — draw a guide, edit it, change Path size, edit again; the type
   follows each time. Existing type-on-a-path tests stay green.
5. **Shape Studio "Drawn" shape.** Check: live — draw a petal, radial ×12, fold, save, reload, same
   picture; a damaged saved drawing loads as empty; the drift guard updated.

## Out of scope this round

- Space Type string paths, the Loft spine, Gradient curve handles (they edit smooth splines through
  points — a different job; they can move onto the pen later).
- Agent drawing verbs.
- Turning imported / library / handle paths into drawings (fitting arcs and rules to arbitrary curves).
- Automatic tangent joints between a Curve segment and an arc (the handle lining up with the arc).
