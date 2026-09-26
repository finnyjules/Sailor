# The pen, stages 4–8 — tangency, Clean up, menus and properties, fills, corners / offset / repeat

Status: designed 2026-09-26 on the owner's "let's build stage 4-8 first" (building starts the same day, stage by stage)

## Why

Stages 1–3 (trim, tooltip cards, coincident) closed the first half of the Zoah gap list. The owner asked to build the rest of the programme before the Trim auto-join fix. The research behind every choice here is the Zoah study (four video viewers, help.zoah.com, the CAD survey and the beautification survey), saved in the Opacity reference memory and in the session scratchpad reports. Where the research left a choice open, this spec makes a **ruling** (marked "Ruling:") so the build never stalls; each can be overturned.

## Shared ground

- **One pen, three hosts.** Every stage lands in the shared pen (`usePen`, `PenOverlay`, `PenToolbar`, `lib/sketch/`) and so appears on the pen page (`/dev/sketch-draw`), in the Frame and in Shape Studio. A host that can't use a feature leaves it out through `PenOptions.tools` (and the new `PenOptions.features`, below).
- **Model rule (Onshape's principle):** few pieces (points, lines, arcs in paths, circles) plus separate rules. New features are *macros* that create ordinary pieces and rules; they never add new piece types. New rule kinds are allowed when an existing one can't say it; each gets a residual, an analytic Jacobian row (or the local numeric fallback `mirroredFrom` uses) and unit tests.
- **Tolerances** are screen px through `pxToUnits`, as now.
- **Every gesture is one undo step.** Every new tool key follows the stage-2 rules (no modifier, not typing, host offers it, settles a live gesture first).
- **Copy:** sentence case, plain words, the user's own content; hints live in the tooltip cards, not as extra text in panels. Every new button gets a tooltip card (stage 2's `PEN_TIPS`), the drawing tools with an animation.
- **Bézier segments** stay out of tangency, fills, offset and corners in v1, as they were out of trim.

## Stage 4 — tangency done right

### New rule shapes (point refs, so they work on path segments, lines and circles alike)
- **Line–arc, not joined** — `tangentLineArc [A, B, C, S]`: the distance from centre C to line AB equals |C S| (S is any point on the arc, its start anchor). Line entity: A,B are its ends. A circle entity keeps `tangentLineCircle`.
- **Arc–arc / arc–circle, not joined** — `tangentArcs [C1, S1, C2, S2]` with `value` +1 (outside each other) or −1 (one inside the other): |C1 C2| = r1 + r2 or |r1 − r2|. The side is chosen from the geometry when the rule is made. A circle entity's radius is read through a new optional form: refs may name a circle id in place of the [C, S] pair.
- **Joined at a shared point** — the forms the pen already writes at a joint (`perpendicular [C, A, A, B]` line–arc, `collinear` of the two centres and the joint for arc–arc) stay as they are.

### Snapping while drawing
- While an arc is being bowed, its ghost circle **snaps tangent** to any nearby line, arc or circle (touching within the snap distance, even one it isn't joined to); the radius locks to the touching one, a tangent chip sits at the touch point on the other curve, a sparkle marks it, and releasing writes the rule.
- An arc pulled off a line's end starts tangent (already true); a line leaving an arc's end along its direction snaps tangent and writes the rule.

### Tangent after the fact
- Select **two segments** (lines or arcs, joined or not — any mix of path segments, lines and circles) → **Tangent** in the rules row. Joined → the joint form; not joined → the new forms. Arc segments also get **Equal** (same radius).
- A point + an arc segment keeps On curve; stage 3 behaviour unchanged.

### Dragging arcs
- **Drag an arc's bow** (in Select, press on the arc away from its ends): the arc's radius follows the pointer while its ends and every rule hold (a tangent neighbour's end slides along it). Implementation: a transient point on the arc at the grab spot, pinned on the arc and pulled to the pointer, removed on release.
- **⌘-drag an arc** drags its centre instead (Zoah's coach tip). Pressing the centre dot itself already drags the centre.

## Stage 5 — Clean up

One command that makes a drawing "feel right": joins what nearly meets, squares what is nearly square, evens what is nearly even — and shows you every change before it lands.

### The command
- **Clean up** button in the pen toolbar (tool row, after Dissolve) and key **⌥⇧C**. It works on the selection if there is one (everything unselected stays put as a reference), otherwise on the whole drawing.
- **Preview:** the drawing shows its cleaned form solid over a faint ghost of the original; every fix gets a small badge ("Joined", "Tangent", "Square", "Same radius ×4", "Parallel", "Evenly spaced"). Click a badge to switch that fix off (and on again); the preview re-solves from the *original* drawing on every change, so it is always the same answer for the same switches. More than 20 badges collapse into one per kind with a count.
- **Strength:** Gentle / Normal / Strong in the hint row (tolerances ×0.5 / ×1 / ×1.75). Ruling: Normal is the default; curvy drawings don't get a different default in v1.
- **Apply** (Enter) = one undo step. **Cancel** (Esc) leaves the drawing untouched.

### What it finds (v1, in screen px at the current zoom)
1. Ends that nearly meet — gap ≤ 6 px → joined into one point (a merge, as stage 3's drop-to-join). *This alone repairs the trimmed flower the owner showed.*
2. A point nearly on a curve — ≤ 5 px → On curve.
3. A joint that is nearly smooth — kink ≤ 8° → Tangent.
4. Nearly horizontal / vertical lines — ≤ 4° → Horizontal / Vertical.
5. Nearly parallel / perpendicular lines — ≤ 4° → Parallel / Perpendicular (joins the biggest group of similar directions first).
6. Nearly concentric arcs and circles — centres ≤ 6 px or ≤ 4 % of the radius → Concentric (a shared centre point).
7. Nearly equal lengths — within 4 % and 4 px → Equal.
8. Nearly equal radii — within 5 % and 3 px → Equal.
9. Nearly even spacing — three or more parallel lines, or points along a line, whose gaps differ by ≤ 6 % → Evenly spaced (equal-distance rules).
10. Nearly mirror pairs — two pieces that mirror each other across a vertical or horizontal line through the drawing's centre (or an existing guide line) within 6 px → Mirror pair (a mirror rule on a guide axis).
11. Round sizes — a length or radius within 2 % of a whole number of drawing units (the value chip's own rounding) → nudged to it, as a one-off, not a rule.

### How it decides (from the research recipe)
- Candidates found by comparing values in sorted lists; similar values grouped without chaining (a group's spread ≤ the tolerance); a group's target is its length-weighted mean, or a value you typed (typed values and dimension chips never move).
- Solved in stages — joins, then directions, then placement, then sizes, then nudges — each stage greedy by score, each accepted fix checked by re-solving: a fix is dropped if the solve fails, if it adds nothing (already implied), if anything moves more than 8 px or 10 % of its size, or if an arc flips or shrinks under 2 px.
- Detection runs on a Repeat's or Mirror's source only, plus the seams between source and copies.
- Ruling: remembered refusals (a fix you switched off stays off next time) are left for later; each Clean up starts fresh.

## Stage 6 — right-click menu, action wheel, properties panel

### Right-click menu
- A right-click on the drawing (or on a selection) opens a list menu headed by what is selected ("2 points", "1 arc", "3 selected"). It lists what the rules row offers for that selection, then the actions — Make guide (X), Flip horizontal (⇧H), Flip vertical (⇧V), Mirror…, Repeat…, Offset… (stage 8), Round corner… / Chamfer… (stage 8), Copy (⌘C), Copy as SVG, Paste (⌘V), Delete — each with its key. Greyed items say why in their tooltip. A right-click on empty space selects nothing and offers Paste and Select all.
- Right-clicking an unselected piece selects it first.
- **Copy / Paste inside the pen**: copies the selected pieces with the rules among them; paste offsets them by 16 px and selects them. Copy as SVG uses the existing export.

### Action wheel
- **Press the right button and drag** → an 8-slice wheel around the pointer; release on a slice to run it, release in the middle to cancel. Layouts from Zoah — point: N Fix, NE Vertical, E Dissolve, SE Flip horizontal, S Repeat, SW Flip vertical, W Coincident, NW Horizontal; segment: N Tangent, E Perpendicular, W Parallel, the others as for a point. A slice that doesn't apply is greyed. Ruling: the slices are fixed in v1 (Zoah lets you customise them).

### Properties panel
- A **Properties** panel for the selection, shown by each host in its own side panel while the pen is open (pen page: beside the canvas; Frame: the right inspector's place; Shape Studio: the rail's place).
- **Point**: X, Y (typed values move it, rules permitting). **Line**: Length, Angle. **Arc**: Radius (with a lock = a radius rule), Length, Sweep. **Circle**: Radius (lock). Values are typed with the existing inline value row.
- **Rules** list for the selection: each rule by name and what it ties ("Tangent — Line 2 · Arc 3"), hover lights both pieces on the canvas, × removes it. A **+** row adds any rule the rules row offers.
- A rule that can't be added says why, in plain words: "Already true", "Conflicts with another rule", "Doesn't apply to this selection".

## Stage 7 — fills

- **Fill tool** (key **G**, bucket icon): hovering shows the enclosed area under the pointer hatched; click fills it, click a filled area to empty it. Areas are the faces the drawing's lines, arcs and circles make where they cross (guides don't bound areas).
- **Areas follow edits:** a fill is stored by a seed tied to one of its edges (edge, position along it, side), not by an area id, so it follows drags; when an edit splits a filled area both halves stay filled; when two merge, the merge is filled; when an edit opens a filled area (a gap), the fill sleeps and shows a small gap marker until the area closes again.
- **Colour:** each filled area takes the layer's fill in the Frame and the shape's fill in Shape Studio. Ruling: one colour per drawing in v1; per-area colours later.
- **Output:** the filled areas become one closed outline (true arcs), separate from the stroke outline. Frame: a path layer with fills gains `fillD` — the layer fills `fillD` and strokes `d`. Shape Studio: a Drawn shape with fills uses the filled areas as the shape. A drawing with no fills behaves exactly as today (closed paths fill, open paths stroke).
- The owner's trimmed flower: bucket-fill the centre and every petal, or Clean up to join the pieces first.

## Stage 8 — round corners, chamfer, offset, repeat modes

### Round corner (key **F**) and Chamfer (key **H**)
- Pick a corner (a joint of two lines, a line and an arc, or two arcs) → it becomes a tangent arc; drag to set the radius or type it. Several selected corners get one radius, tied with Equal. Too big a radius previews red and can't be applied.
- Chamfer: the same, with a straight cut at equal setbacks.
- The corner point is kept as a hidden guide point where the two sides would meet ("virtual sharp"), so rules on the corner still hold.

### Offset (key **E**)
- Select a path (or pieces of one) → a live parallel copy at a distance you drag or type, on either side. Lines offset to parallel lines, arcs to arcs on the **same centre point** with the radius ± the distance; corners meet sharp (Ruling: round corners are a later option).
- Kept live by new rules: `offsetLine [A, B, P]` value d (P's signed distance from line AB is d) and `offsetRadius [C, S, C, T]` value d (|C T| − |C S| = d). Changing the source changes the copy.

### Repeat modes
- **Repeat…** opens a small panel (the pen's own, in the host's side panel like Properties): **Radial** (centre picked on the canvas — as today — copies, sweep), **Linear** (a direction and a step or a total span, copies) and **Along a path** (pick the path, copies, spread evenly).
- Radial and Linear copies are live (`rotatedFrom`, and a new `translatedFrom [copy, orig, from, to]` value k: copy = orig + k·(to − from)). Ruling: Along a path places copies once, not live, in v1.
- Count includes the original; Apply / Cancel.

## Testing

- Pure geometry and solving: unit tests for every new rule's residual and Jacobian row (checked against numeric differences), tangent snapping, every Clean up detector and its guards, face finding and seed tracking, fillet / chamfer / offset construction, linear repeat.
- Real-mouse Playwright on the pen page for each stage (bow-snap tangent, Tangent verb, bow drag; Clean up preview → switch a badge off → Apply → undo; right-click menu, wheel, properties typing and rule removal; fill hover, click, drag-follows, split; round corner drag; offset; linear repeat).
- Frame and Shape Studio pen specs stay green, plus one host check per stage that its new tool reaches the host (fills render through `fillD` in the Frame).
- Test pen layouts at laptop widths (1280 and 1024) — the toolbar and the side panels must not push anything off screen.

## Out of scope

Per-area fill colours; customisable wheel slices; remembered Clean up refusals; live Along-a-path repeat; round offset corners; curvature (G2) joins; Bézier segments in any of the above; booleans and warps on drawn shapes; the Trim auto-join fix (next, on the owner's order).

## Build order

Stage 4 → 5 → 6 → 7 → 8, one implementation plan per stage (written just before that stage is built, against the code as it then stands), each executed task by task with a review per task, a final review per stage, and the three hosts checked with a real mouse before the stage is called landed.
