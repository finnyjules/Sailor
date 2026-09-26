# The pen, stages 1–3 — trim, tooltip cards, coincident

Status: designed 2026-09-26 on the owner's "run with it". Stages 1–3 of the pen programme below.

## Why

The owner compared our shared pen with Zoah (formerly Opacity) and said we are missing key ideas: cleaning up where arcs and lines cross, tangents, coincident that works the way theirs does, better tooltips, and a clean-up command. We studied every Zoah video frame by frame, read help.zoah.com, and surveyed the CAD sketchers (Fusion 360, Onshape, SOLIDWORKS, FreeCAD, Shapr3D, Plasticity) and the beautification research (Igarashi's Pegasus, ShipShape). The findings live in the Opacity reference memory; this spec turns them into the first three stages.

## The programme (order agreed in chat)

1. **Crossings and trimming** — this spec
2. **Tooltip cards for every pen button** — this spec
3. **Coincident done right** — this spec
4. Tangency done right (ghost circle snaps tangent to anything nearby while bowing; tangent for any two segments; drag an arc's bow or centre with tangency holding)
5. Clean up (near-relations, near-misses, spacing and balance; preview with switchable badges; Gentle / Normal / Strong)
6. Right-click menu, radial wheel and a properties panel listing each point's rules
7. Fills (paint bucket on the areas crossings make)
8. Round corners, Chamfer, Offset, Repeat along a line or path

Stages 4–8 get their own specs.

## How it works in Zoah and CAD (what we are matching)

- **Trim.** Crossings split every curve into crossing-to-crossing pieces without touching the drawing. Hovering tints one piece; clicking removes it; sweeping removes several. What is left ends exactly at the crossing and stays pinned to the curve that cut it (FreeCAD stores a point-on-object there). Zoah's scissors is **Cut** (add a point mid-segment without moving the curve) and **Dissolve** heals it back. A circle with no crossings is deleted whole (CAD).
- **Coincident.** One ⊙ for point-on-point and point-on-curve — and "curve" includes the arcs inside a drawn shape. The ⊙ shows at the cursor while hovering, before the click. A point on a curve slides along it. Two ends made coincident become one point (that is how Zoah closes a circle drawn with the pen). Dropping a dragged end onto a point or a curve joins it; the target decides the rule (CAD). Joined points draw as small solid dots, loose ends as hollow squares.
- **Tooltip cards.** Name, a key badge for the shortcut, a tiny looping animation of the gesture, and a one-line caption. They appear quickly and stay out of the way.

## Stage 1 — crossings and trimming

### Curves that take part
Line entities, circle entities, and the line and arc segments of paths. **Bézier (cubic) segments are left out of v1** in both roles — they neither cut nor get trimmed (hover shows nothing on them).

### Crossings (pure geometry, `lib/sketch/crossings.ts`)
- A curve reference: `{ kind: 'line', id }`, `{ kind: 'circle', id }`, `{ kind: 'seg', pathId, segIndex }` (line or arc segment).
- Each curve has a parameter `t`: lines and line segments 0→1 from start to end; circles an angle 0→2π measured from +x in drawing space; arc segments 0→1 from the segment's start anchor to its end anchor along its sweep.
- Exact intersections: line–line, line–circle/arc, circle/arc–circle/arc, restricted to each curve's own extent. Tangent touches (a single contact) count as one crossing. Overlapping collinear lines or co-circular arcs are not crossings in v1.
- Every other curve in the drawing cuts, including guides. A curve's own endpoints are span boundaries; its own neighbours in the same path do not create crossings at the shared anchor.
- `spanAt(doc, curve, t)` returns the piece containing `t`: its `t0`, `t1` and, for each end, either "curve end" or the cutter curve and the crossing point.

### The Trim tool (key **T**, scissors icon)
- **Hover:** the piece under the cursor is drawn thick and tinted (the "will be removed" look) with a small ring at each crossing end. Nothing on a Bézier segment.
- **Click:** removes that piece.
- **Press and sweep:** removes every piece the pointer passes over, re-reading crossings after each removal. The whole press→release is **one undo step**.
- **Ghosts:** removed pieces stay drawn as faint dotted lines while the Trim tool stays armed, then clear. They are overlay only, never stored.
- **Status line** after a removal that dropped rules: "Removed 2 rules with that piece".

### What removing a piece does to the drawing (`lib/sketch/trim.ts`)
- **A new end at a crossing** is a new point placed at the crossing and pinned to the cutter:
  - cutter is a line entity → `pointOnLine [p, line]`
  - cutter is a circle entity → `pointOnCircle [p, circle]`
  - cutter is a path line segment A→B → `collinear [A, B, p]`
  - cutter is a path arc segment with centre C and start anchor A → `equalDist [C, p, C, A]`
  - if the crossing lands on one of the cutter's own anchors (within 1e-6 of the drawing's size), the new end **reuses that anchor** instead (one point, no rule).
- **Line entity p1→p2, piece [t0, t1]:** whole line → delete it. Touching one end → that end moves to the crossing (a new point; the old endpoint is removed only if nothing else references it). Interior → the line becomes two lines, p1→X0 and X1→p2.
- **Path segment:** the segment is first split at the crossing(s) (line → two lines; arc → two arcs sharing the same centre point and sweep; each new arc gets its `equalDist [C, start, C, end]` invariant), then the middle segment is removed. Removing a segment from an **open** path splits it into up to two open paths (an empty remainder disappears). From a **closed** path it becomes one open path that starts just after the gap and ends just before it. A path left with no segments is deleted.
- **Circle entity:** fewer than two crossings → the circle is deleted. Otherwise the removed piece is the arc between the crossings either side of the click; the circle is replaced by an open path with one arc segment covering the rest, centred on the circle's own centre point. Rules on the circle: `pointOnCircle [q, circle]` becomes `equalDist [C, q, C, arcStart]`; `concentric` with another circle is kept by turning it into the arc centre sharing that circle's centre where possible, otherwise dropped; every other circle rule (tangent, equal radius, radius) is dropped and counted in the status line.
- **Surviving geometry keeps its ids** where it survives, so rules on it stay attached. Rules whose references disappear are dropped (existing `deleteEntity` behaviour) and counted.

### Cut (key **C**) and Dissolve (key **D**)
- **Cut:** click on a line segment or arc segment of a path to add an anchor there; the curve does not move (line → two lines; arc → two arcs with the shared centre and their invariants). On a line entity it splits into two line entities sharing the new point. Not on circles or Bézier segments in v1 (the hint says "Cut works on a path's lines and arcs").
- **Dissolve:** click an interior anchor of a path where the two segments meeting there are both lines lying on one line (within 0.5° and 1 screen px), or both arcs with the same centre point (or centres within 1 screen px and equal radii within 1 px) → they merge into one segment and the anchor is removed if nothing else references it. Otherwise the hint says "These two sides don't line up, so they can't merge".

### Deleting selected segments
Segments picked with Option-click can now be deleted (Delete key, and the toolbar's Delete button appears for a segment selection). It uses the same "remove a whole segment" path as Trim.

## Stage 2 — tooltip cards

- **A card on every pen button:** the six drawing tools, Trim, Cut, Dissolve, Guide, Labels, Undo, Redo, Close, Finish, Done, Cancel, and every button in the rules row (each rule, Fix, Repeat…, Mirror, Flip horizontal, Flip vertical, Make guide, Delete).
- **Card content:** the name, a key badge when there is a shortcut, a one-line caption saying exactly what to do, and — for the nine drawing and editing tools (Select, Pen, Bézier curve, Line, Circle, Point, Trim, Cut, Dissolve) — a small looping animation of the gesture (about 160 × 96, cursor included), drawn from a scripted little drawing through the pen's own path renderer (`sketchPathData`), so it looks exactly like the pen.
- **Timing:** first card after ~350 ms of hover; moving to another button inside the toolbar shows the next card at once for ~600 ms (warm-up). Built on the existing `components/ui/tooltip` (reka). The animation runs only while its card is open.
- **Shortcuts (new, only while the pen owns the keyboard and no modifier is held and no text field has focus):** V Select, P Pen, B Bézier curve, L Line, O Circle, N Point, T Trim, C Cut, D Dissolve. A host that doesn't offer a tool ignores its key. The native `title` attributes go (the card replaces them); `aria-label` stays.
- **Copy:** sentence case, no identifiers, captions in the voice of Zoah's ("Click to place, drag to bend it into an arc.").

## Stage 3 — coincident done right

### Snap targets while drawing
`snapPoint` is extended; priority when several are within reach: **point > midpoint > curve**, then nearest.
- **Points** (unchanged): the new point **is** the existing point.
- **Midpoints** of line entities and of path line segments (within the snap radius of the exact middle) → new point + `midpoint [p, A, B]`.
- **Curves**, each clamped to its own extent (no more infinite lines):
  - line entity → `pointOnLine [p, line]`, only between its ends;
  - circle entity → `pointOnCircle [p, circle]`;
  - path line segment A→B → `collinear [A, B, p]`, only between its ends;
  - path arc segment (centre C, start A) → `equalDist [C, p, C, A]`, only on the drawn arc.
- Bézier segments are not snap targets in v1.

### The ⊙ preview
While any drawing tool hovers, and while a point is dragged, a small chip at the snapped spot shows what will happen: **⊙** onto a point, a midpoint glyph onto a middle, an on-curve glyph onto a curve. It replaces the plain glow ring there (the glow stays for a press with no snap).

### Drag onto something to join it
- In Select, dragging a single point shows the ⊙ preview for points and curves it passes (never itself, never a point it is already one with).
- **Release on a point → the two become one point** (merge). **Release on a curve → the point is pinned to it** with the curve's rule. A sparkle marks the join.
- Hold **⌘ / Ctrl** while dragging to move without joining.
- Merging (`mergePoints(doc, from, into)`): every reference to `from` (entities, segment centres, handles, rules) becomes `into`; `from` is deleted; rules that became meaningless are dropped (`coincident [a, a]`, `distance [a, a]`, a rule listing the same point twice where that makes it trivial); a line whose ends became the same point is deleted; a path segment whose two anchors became the same point is removed (closing a path when its two ends merge: the path becomes **closed**).

### The Coincident rule
- Two points selected → **Coincident merges them** into one point (the first selected stays where it is), instead of adding a `coincident` rule. The old rule kind stays readable for saved drawings.
- One point + one Option-clicked segment → **On curve** (and **Midpoint** for a line segment). Selecting a segment while points are selected keeps the points (and vice versa) for this pairing.

### How points look
- A point shared by two or more pieces (path joints, merged points, T-junctions) → a **small solid dot**.
- A loose end (an end of an open path or a line used by nothing else) → a **hollow square**.
- An arc or circle centre → a **hollow circle**. Construction points keep their current look. Hit areas stay the same size.

### Radius labels stay on screen
Arc radius chips are clamped inside the overlay so a label near the edge is never cut off (the "R" at the right edge in the owner's screenshot).

## Testing
- Pure geometry and topology have unit tests (every intersection pair, span boundaries, each removal case, merge cases, dissolve rules, snap priority and clamping).
- A real-mouse Playwright spec on the pen test page (`/dev/sketch-draw`): draw two overlapping circles and a line across them, trim pieces by click and by sweep, undo the sweep in one step, cut and dissolve, drag an end onto an arc and onto a point, and check the cards appear on hover.
- The Frame and Shape Studio pen specs stay green; both hosts get the three new tools.

## Out of scope for stages 1–3
Bézier segments in crossings and snapping; retracing a sweep to restore pieces; Extend; tangency (stage 4); Clean up (stage 5); menus, wheel and properties panel (stage 6); fills (stage 7).
