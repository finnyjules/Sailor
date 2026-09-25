# One pen for every tool

**Date:** 2026-09-24 · **Status:** design approved in chat, awaiting spec review

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
3. **The arc pen replaces the Frame's handles pen.** One way of drawing. Old saved handle paths keep
   drawing and editing exactly as they do today.
4. **Approach A:** one shared pen overlay that each tool hosts over its own canvas — you draw in place,
   over the real frame or preview.
5. **The pen has its own dedicated toolbar** with its tools and rule actions (tangent and the rest).

## 1. The shared pen

Three pieces.

### 1a. The maths — `lib/sketch/` (mostly unchanged)

The drawing model (points, lines, circles, arc paths, rules), the solver, snapping, tangent joints,
and `sketchPath` (drawing → SVG `d`). Already free of any screen code.

Two known fixes go in first (both recorded as owed in the sketch notes):

- **The solver never stops early.** Its in-loop check compares hard residual *plus* regularisation
  against `1e-6`, so it burns every iteration on every solve. Break on the hard residual alone.
- **The `n === 0` early return skips restoring positions** after a failed solve. Same three lines.

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
| `toScreen(p)` / `toDrawing(p)` | Position mapping between screen pixels and drawing units. The Frame maps through the layer's position, scale and rotation. |
| `options` | Which tools to show; `openOnly` (text guides); `closedOnly` (if a host ever needs it); starting tool. |
| `commit` / `cancel` events | Fired on Enter / Done and Escape / Cancel. The host decides what happens. |

### What the pen does not do

It does not store anything, pick colours for the finished shape, zoom or pan the host, or know which
tool it is in.

### Snapping measured on screen

Snapping tolerances today are in drawing units (`infer.ts` default `tol 0.6`), which only feels right at
the test page's fixed 34 px per unit. The pen converts a **screen distance (≈12 px)** into drawing
units through the mapping on every use, so snapping feels the same in a small Frame and a zoomed-in
Shape Studio. The tangent-joint angle tolerance (12°) is already scale-free and stays.

### Orientation

The drawing is stored in the **host's own units and axis direction**. `sketchPath` emits `d` in the same
space, so an arc's sweep flag is correct without flipping. Only the test page, which shows y-up,
flips for display (it already does).

## 2. The pen toolbar

A dedicated floating toolbar that belongs to the pen, the same in every host. While the pen is open it
**replaces the host's own tool bar** (the Frame's bottom toolbar; Shape Studio's preview controls), so
there is one set of tools on screen at a time. Built from the studios' shared button parts
(`StudioButton`), icons with tooltips, sentence-case labels.

**Tool row — always shown**

- Select · Pen (arcs) · Line · Circle · Point
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

**Hint line.** While drawing, a one-line hint under the toolbar says what the next click does ("Click to
add a point, drag to bend it into an arc, click the first point to close"). While Repeat / Mirror waits
for a pick, it says what to pick, with Cancel.

The exact layout (one bar or two, where it floats, grouping) is settled with a **clickable prototype
first**, before the component is built.

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

0. **Solver fixes.** Check: sketch unit tests green; a new test shows a drag solve stops in a few
   iterations instead of the full count.
1. **Pen toolbar prototype, then pull the pen out.** A clickable prototype of the toolbar is reviewed
   first. Then `usePen` + `PenOverlay` (with the toolbar), the mapping and screen-pixel snapping, and
   the test page rehosted. Check: the existing sketch browser tests pass unchanged; drawing, snapping,
   tangent joints and undo behave as today, driven with **real mouse clicks** (simulated pointer events
   did not drive the pen last time).
2. **Frame pen and path layers.** Pen tool, `sketch` on path layers, double-click to reopen, the
   `writePathD` boundary helper, `useVectorPen` deleted. Check: unit tests for re-centring and for every
   `d` writer dropping `sketch`; live — draw, move, scale, rotate, reopen, points under the cursor on a
   rotated layer; existing frames render **pixel-identical** (no saved layer has a `sketch` yet).
3. **Text "Drawn path".** Check: live — draw a guide, edit it, change Path size, edit again; the type
   follows each time. Existing type-on-a-path tests stay green.
4. **Shape Studio "Drawn" shape.** Check: live — draw a petal, radial ×12, fold, save, reload, same
   picture; a damaged saved drawing loads as empty; the drift guard updated.

## Out of scope this round

- Space Type string paths, the Loft spine, Gradient curve handles (they edit smooth splines through
  points — a different job; they can move onto the pen later).
- Agent drawing verbs.
- Turning imported / library / handle paths into drawings (fitting arcs and rules to arbitrary curves).
- A handles mode in the pen.
