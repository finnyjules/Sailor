# Responsive Frames (pins and text re-wrap) — Design

**Date:** 2026-09-21
**Status:** Draft — awaiting Julien's review
**Scope:** design only. No plan and no code until this is approved.

## In plain words

Today a Frame is a fixed artboard. Shown in a box of another shape it can only
be scaled as a whole. This spec adds a second kind of Frame — a **responsive
Frame** — that adapts to any box in the same family of shapes, the way a Figma
frame with constraints does, plus text that re-wraps.

- **What changes for the designer.** The Frame's size picker gains one choice,
  "Responsive". A responsive Frame has draggable artboard edges (to see it at
  other sizes, Webflow-style, with no mode to switch on), a size readout, and
  one new inspector card, "When the frame resizes". Sailor picks every layer's
  behaviour automatically from where the layer sits; the card is only for
  overrides.
- **Layers that push each other.** A group can be arranged as a Row or a
  Column. Its members then make room for each other, so a headline that
  re-wraps taller slides the paragraph and the button down. This uses Yoga,
  the open-source layout engine Rive and React Native use, and it ships in an
  export only when the Frame has such a group.
- **What does not change.** Every Frame that exists today is a fixed Frame and
  stays exactly as it is: same pixels, same editor, nothing new on screen.
- **What falls out of it.** The web export can offer a third choice, "Adapt",
  for responsive Frames, next to its "Fit" and "Fill".
- **What is risky.** (1) Drawing each layer at its own scale without touching
  dozens of size fields — settled by a short spike at the start of the plan.
  (2) Editing layers while the artboard is at another size — the pin maths is
  run backwards; the rules are below.

## Decisions taken in the brainstorm

1. **Range:** one Frame adapts across the *same family of shapes* (a hero from
   laptop to ultra-wide; a poster from 4:5 to 2:3). A jump from landscape to
   tall portrait is not a goal; it degrades smoothly (see "The guard").
2. **Authoring:** per-layer pins, chosen automatically, **and** a pin can hold
   to a grid section instead of the whole frame — attached automatically when
   the layer sits inside one section.
3. **Sizes:** everything scales to fit; pins use the spare room. One per-layer
   switch, "Keep size", opts a layer out of scaling.
4. **Narrower boxes:** everything shrinks to fit. Text re-wraps only when its
   box gets relatively wider. Layers cannot collide or fall off (the one
   exception is a layer the designer has set to "Keep size", which by
   definition does not shrink).
5. **Viewing other sizes:** always-draggable artboard edges plus one size
   readout. No mode, no paused editing, no row of shortcut buttons.
6. **Fixed vs responsive is a property of the Frame**, chosen with its size.
7. **Under the hood:** one pure step before the renderer; the renderer draws
   each layer at a scale the way motion already does.
8. **Jev (TypeSafe's decision model):** door left open only. The rule that
   picks default pins is replaceable, and pins can be set through the agent
   route. Nothing is built for Jev now.
9. **Arranged groups (added 2026-09-21, second round).** A group can be
   arranged as a **Row** or a **Column**, so its members push each other: a
   headline that re-wraps taller slides the paragraph down. One level only,
   no wrapping onto new lines. Laid out by **Yoga** (the open-source flexbox
   engine Rive and React Native use), never by an engine of our own. Yoga
   ships in an export only when the Frame contains an arranged group. Pins
   themselves stay a few lines of arithmetic.
10. **Naming.** No new noun. The group card gets one setting, "Arrange: Free /
    Row / Column". "Layout" is already taken twice in Sailor (the Layout tab,
    Smart Layout) and "stack" already means z-order in the code.

## Prior art (so we do not reinvent)

| Tool | What they do | What we take |
|---|---|---|
| Figma | Five per-axis constraints; with a stretch layout grid, constraints become relative to the nearest column automatically | The exact pin set, the pin diagram, automatic section attachment |
| Sketch | "Pin to edge" + "Fix size" | "Keep size" |
| Rive | Runtime fit modes: Contain / Cover / **Layout** (adapts the artboard), plus one overall scale factor; Yoga inside | "Adapt" as one more fit choice in the export, next to Fit and Fill; fit-scale-then-adapt |
| Webflow | Canvas edge always draggable, width readout, editing never paused | The viewing-size UX |
| Ad builders | Percent positions for small changes; separate variants for big shape jumps | Confirms the range decision; Smart Layout already covers distinct formats |

Deliberate difference from Figma: Figma defaults every layer to top-left and
makes the designer fix it. Sailor infers the pin (defaults over controls).

**Smart Layout stays separate.** Pins = continuous change within a family of
shapes. Smart Layout = distinct formats from a template. They do not share
code or data in v1.

## The model

### Fixed and responsive Frames

- A Frame is **fixed** unless `sailor_frame.responsive === true`.
- The size picker on the Frame node (`ArtifactFrameNode.vue`, today: Square,
  16:9, Tall, Portrait, Classic, A4, Custom) gains **"Responsive"**. Picking it
  sets `responsive: true` and keeps the current width and height as the
  **design size** — the size the Frame is designed at. The width/height fields
  stay, labelled "Designed at". Picking any other entry sets it back to fixed.
- A Frame with no explicit size (it follows its bottom wired image) gets its
  current effective size written as the design size when it becomes responsive.
- Pins stored on layers are kept but ignored while a Frame is fixed.
- How the designer can tell: the node card and the editor header read
  "Responsive · designed at 1920 × 1080" instead of a plain size; the artboard
  edges show grips on hover; the pins card exists. A fixed Frame shows none of
  this.

### The one rule

For a box `W × H` and a design size `W0 × H0`:

1. **Fit.** `s = min(W / W0, H / H0)`. Everything scales by `s`.
2. **Spare room.** `ΔW = W − s·W0`, `ΔH = H − s·H0`. Both are ≥ 0 and at least
   one is 0. Pins decide what each layer does with it.

At the design's own shape both are 0 and `s` is a plain uniform scale.

**Box size is not pixel count.** `W × H` is the box in layout units: the
viewing size in the editor, the container's CSS pixels in the web export.
How many pixels get painted (a small card preview, a 2× bake, a retina
screen) is a separate matter the painter already handles. Card previews and
bakes always lay out at the design size and only change the pixel count, so
they never go through pins at all.

### Pins

One pin per axis. For a point `p` (design px) on the horizontal axis, with
`u` = the usable spare room (see "The guard") and `o` = the outer offset:

| Pin (horizontal / vertical label) | Maps `p` to | Effect |
|---|---|---|
| Left / Top | `o + s·p` | keeps its distance from that edge |
| Right / Bottom | `o + s·p + u` | keeps its distance from that edge |
| Center / Middle | `o + s·p + u/2` | stays centred |
| Left and right / Top and bottom | near edge as Left, far edge as Right | stretches by `u` |
| Keep relative position | `o + s·p + u·(p / W0)` | slides proportionally (today's behaviour) |

Every map is a straight line in `p`. That matters twice: keyframes can be
mapped exactly, and edits made at a viewing size can be mapped back exactly.

**Keep size.** The layer ignores `s` for its own size (it keeps its designed
pixel size in box units). Its pinned gap still scales with `s`. For a logo or
a legal line.

### Holding to a grid section

- The Frame grid is resolved for the box with margins, gutters and the base
  module scaled by `s` (not by the box width); sections share what is left.
  `resolveGrid` gains one optional "unit width" input; omitted, it is
  byte-identical to today.
- Region order is stable across sizes (the seeded draws depend on counts, not
  on pixels), so "the section this layer sits in" is the same section at every
  size.
- A layer held to a section uses the same five pins against that section's
  rectangle and that section's spare room (`section width at the box − s ×
  section width at the design`). The whole frame is simply the one big section.
- **Attachment is automatic:** grid on, and the layer's box lies inside one
  section (within 1% of the frame width) → it holds to that section. Otherwise
  the frame. The only stored override is "hold to the whole frame". No section
  number is ever stored, so nothing goes stale when the grid is edited.

### Automatic pins

Nothing is stored until the designer overrides. Pins are inferred from the
layer's (or unit's) box within its reference rectangle, per axis:

1. Spans ≥ 80% of the axis, or touches both edges, **and** the kind can
   stretch → Left and right. A layer covering the whole frame on both axes is a
   background: it stretches both ways.
2. Centre within 4% of the reference centre → Center.
3. Otherwise the nearer edge.

"Keep relative position" and "Keep size" are never chosen automatically.

This rule lives in one replaceable function (`inferPins`). A later "Suggest
pins" step (Jev, the Sailor agent) would write ordinary stored pins; the
resolver never calls a model.

### The guard at the extremes

Pins use spare room only up to the fitted design's own extent on that axis:
`u = min(Δ, s·W0)`. The rest is split evenly as the outer offset `o`, so the
arrangement stops spreading and sits centred. A stretch pin whose design gap
to the edge is ≤ 0 (it touches or overhangs) holds to the **real** box edge,
so backgrounds always bleed. The change is continuous — no sudden switch.
The guard works at frame level: the grid and its sections are resolved inside
the guarded area, so section-held layers inherit it.

### What "stretch" means per kind

| Kind | Stretch |
|---|---|
| rect, ellipse, polygon, star, line (unrotated) | Box changes; radius and stroke keep the fit scale |
| text with a box | Box widens, words re-wrap; font size follows `s` only. An auto-height box keeps its pinned edge (top-pinned keeps its top). `shrink` / `fill` / `break` fit modes keep working against the new box |
| text without a box | Never stretches; placed only |
| image, wired | Never distorted: scaled to cover the new box, overflow cropped to it |
| path, brush, deal, scatter; anything rotated, skewed or corner-pinned; groups; cloners | No stretch in v1. Scaled by `s`, placed by pins. Auto never picks stretch |

### Rigid units

Some layers adapt together as one rigid unit — placed by one set of pins,
inferred from (and overridden on) the unit's overall box, members keeping
their arrangement scaled by `s`:

- **Free groups** (outermost group, Arrange = Free). Pins are stored on the
  group record. No stretch inside a free group, so a full-bleed background
  belongs outside.
- **Arranged groups** (Arrange = Row or Column) are placed by pins like a free
  group, but their members are laid out inside the box — see "Arranged
  groups" below.
- **Shape-mask pairs:** a mask source and every layer it clips. Pins come from
  the mask source's box. Break-out lines and painted mask strokes ride along.
- **Cloners:** the whole stamped arrangement. Pins inferred from its full
  extent. No extra copies, no wider gaps.

A layer's own crop region follows the layer and stretches with it. For a
stretched image that already has a crop region, the crop region is the box
that stretches and the picture covers it.

### Arranged groups

Pins know about the frame's edges, not about neighbours. An arranged group
is where layers push each other.

**What it is.** A group whose "Arrange" is Row or Column. Its members sit
side by side (Row) or one under the other (Column) and move to make room for
each other. It has a **gap**, a **padding** on each side, and an **align**
across the flow (start, centre, end, or stretch). Each member has one
setting along the flow: **Hug** (its natural size, the default) or **Fill**
(take a share of the spare room; several Fill members share it equally).
One level only: a member cannot itself be an arranged group in v1, and
members never wrap onto a new line.

**Switching it on moves nothing.** When a group is set to Row or Column,
Sailor reads the current arrangement: members are ordered by position along
the flow; the gap is the average of the spaces between them; the align is the
edge they share (or centre); the padding is the space between the members and
the group's box. Two members that overlap, or one that is clearly out of
line, are nudged into place — the only case where anything moves. Setting it
back to Free keeps every member where it is.

**Who owns the members' positions.** In a free group the members' `x`/`y`
are the design. In an arranged group they are the **result** of the
arrangement at the design size: every edit that can change the layout (text
edited, a member resized, gap or padding changed, a member added, removed or
reordered) re-runs the arrangement at the design size and writes the members'
`x`/`y` (and a text box's width, when align is stretch) back into the
document as one undo step. So at the design size the stored layers are
already correct, the identity fast path still holds, and a fixed Frame never
runs Yoga at all.

**At another size.** `resolveLayout` places the group's box by its pins,
then lays the members out inside it. A member's size is the fitted size
(`× s`) unless it is Fill or stretched; text takes the width it is given and
re-wraps, so its height changes and what follows moves. If the members need
more room than the box has along the flow, the box grows along the flow to
hold them (it hugs), anchored by the group's pin on that axis; it never clips
and members never overlap. Across the flow the box is exactly what the pins
gave it.

**Sizes inside an arranged group.** The group's inner box and every member
size are in fitted units, so "Keep size" applies to a member as anywhere
else; a Keep-size member simply hugs at its design pixel size.

**Automatic pins for the group** are inferred from its box like any group's.
Typical: a Column of headline, paragraph and button near the left margin
infers Left and Top; set its vertical pin to "Top and bottom" and the Fill
member absorbs the tall box.

**What members can be.** Text, images, wired layers, shapes, paths, brush
strokes and free groups. A member's own rotation, skew and corner-pin are
kept and its outer box is what the arrangement places. Cloners, deal and
scatter layers can be members as one box each. A shape-mask pair inside an
arranged group moves as one member (the mask source's box).

**Motion inside an arranged group.** A position keyframe on a member is an
**offset** from its arranged position (this is the one place where keyframes
are offsets rather than positions). Scale, rotation, opacity and letter
behaviours are untouched; a letter behaviour runs on the re-wrapped cells.
Arrange, gap, padding, align, Hug and Fill are not animatable.

**Editing.** Dragging a member along the flow reorders it (its slot follows
the pointer); dragging it out of the group's box removes it from the group.
Resizing a member sets its Hug size. All of this works at a viewing size
through the same backwards mapping as elsewhere, with the reorder committed
at the design size.

**Yoga.** The arrangement is computed by Yoga (`yoga-layout`, WebAssembly,
version pinned), driven through one small adapter that builds a two-level
tree — the group as a flex container, each member as a leaf whose measure
function is the same injected text measurer used for re-wrap — and reads the
computed boxes back. Yoga is deterministic for the same inputs; the version
is pinned so the export and the app agree. Rounding is ours, not Yoga's
(point scale factor 1), so it matches the painter's. If Yoga has not loaded
(the export's mount awaits it; the app loads it on first use), an arranged
group renders as a free group at its stored positions — the design-size
picture — rather than nothing.

**Cost.** Yoga's WebAssembly file ships in an export only when the Frame
contains at least one arranged group; the export sheet states the added
size. The plan's first task measures it (older builds ranged from roughly
100 KB to 300 KB; the current 3.x build is to be measured, not assumed).

### Motion

- Position keyframes (`layers.<id>.x` / `.y`) go through the same map as the
  layer's resting position. Because the map is a straight line, mapping the
  keyframes and then interpolating equals interpolating and then mapping —
  easing and path shape are preserved exactly. Pinned layers: travel scales
  with `s`. "Keep relative position": travel stretches with the box. The one
  exception is a member of an arranged group, whose position keyframes are
  offsets from its arranged position (see "Arranged groups").
- Scale, rotation, opacity and effect-dial tracks are untouched; keyframed
  scale multiplies on top of the layout scale.
- Preset moves and letter behaviours ride inside the layer's scale. Letter
  behaviours run on the cells *after* re-wrap.
- Pins, stretch and Keep size are not animatable. Nothing about animation
  appears in the pins card (motion authoring lives in Motion surfaces only).

### Frame-level things

Background fills the whole box (gradients stretch with it). Frame-wide post
effects and frame-anchored shader fills cover the whole box.

## What the designer sees

Responsive Frames only.

### Artboard edges and the size readout

- The artboard's right edge, bottom edge and corner are always draggable;
  grips appear on hover. Dragging adapts the layout live. Nothing is switched
  on and nothing is paused.
- The editor's top bar (next to zoom) shows one readout: two number fields and
  a small "Shapes" menu (Your design, Wide, Tall, Square, Banner). At the
  design size it is labelled "Design size". Away from it, it turns accent
  coloured, is labelled "Viewing size", and a quiet "Back to design size"
  button appears. Typing in the readout changes the viewing size only; the
  design size is changed only in the node's "Designed at" fields.
- The viewing size is editor state only. It is never saved; reopening the
  editor starts at the design size. The node card always shows the design.
- The selected layer shows thin guide lines to the edges (or centre line, or
  section edges) it holds.

### The inspector card: "When the frame resizes"

- A clickable pin diagram (box, four edge ticks, centre cross) — Figma's
  familiar control.
- "Horizontal": Left · Right · Left and right · Center · Keep relative position.
- "Vertical": Top · Bottom · Top and bottom · Middle · Keep relative position.
- "Keep size" switch.
- "Holds to: Section / Whole frame" — only when the grid is on and the layer
  sits in a section.
- A quiet "Automatic" marker while Sailor is choosing; after any change, a
  "Back to automatic" link.
- Works on multi-selection; for a group or a masked pair it shows the unit's
  pins. Built from the existing studio controls.
- For a member of an arranged group the card shows, instead of pins, one
  choice along the flow — "In this column: Hug its content / Fill the space"
  (or "In this row") — plus "Keep size".

### The group card: "Arrange"

- One select on the group's existing card: "Arrange: Free / Row / Column".
  Free is today and the default.
- Row or Column reveals: "Gap", "Padding" (one value, with a disclosure for
  four sides), and "Align: Start / Centre / End / Stretch". All are filled in
  by Sailor from the current arrangement when switched on; the designer
  rarely touches them.
- Available on fixed Frames too: an arranged group is useful for tidy spacing
  even when nothing ever resizes, and it costs a fixed Frame nothing at render
  time (positions are written back into the document).

### Editing at a viewing size

The design size stays the truth. An edit made at a viewing size is stored at
the design size by running the layer's map backwards.

- **Works at any size:** select, move, resize, rotate, nudge, edit text, every
  inspector change, delete, duplicate, reorder, add text / shape / image,
  record a position keyframe.
- **The drop rule (no jumps).** During a drag the layer's pins are held. On
  release, for each axis without an explicit pin: try the pin inferred from
  where the layer now sits *in the viewing box*, then the pin it had; take the
  first whose mapped-back design position infers the same pin — the layer
  stays automatic. If neither agrees, keep the pin the designer was looking at
  as an explicit pin. Either way the layer stays exactly where it was dropped.
- **Tools that draw straight onto the artboard** — brush, pen and node
  editing, mask painting, region-based generation, smart select, Layout-tab
  patterns, grid editing — bring the artboard back to the design size when
  picked (the size animates back; no dialog). Making each work at a viewing
  size is later work.
- Applying a Layout-tab pattern clears explicit pins on the layers it moves.

## The seam

### One pure function

```
resolveLayout(frame, W, H, opts?) → {
  layers,      // ordinary LocalLayer[] for paintLayerStack
  motion,      // same motion, position tracks mapped
  grid,        // resolved grid at the box (for the editor overlay)
  boxes,       // id → resolved box in px (selection, guides, hit-testing)
  maps,        // id → the per-axis straight-line maps (for editing backwards)
  identity,    // true when nothing changed
}
```

- `frame` = design size, layers, stack order, groups, grid config, motion,
  wired treatments. `opts.measure` = injected text measurer.
- No Vue, no network, no DOM except through `opts.measure`. Never mutates or
  persists anything.
- **Identity fast path:** fixed Frame, or box equal to the design size →
  returns the same array and object references it was given. (A box of the
  same shape but another size is a plain uniform scale for every layer except
  "Keep size" ones, so it is cheap but not identity.)
- Runs in the editor (on viewing-size change, not per frame) and in the web
  export inside `setSize(w, h)` (once per size; each frame paints the cached
  result). The export spec is not edited here; see "Fit with the web export
  spec" below for what the two need from each other.

### Where it lives

`frontend/app/lib/frame/responsive/` — small files, each with one job:

| File | Job |
|---|---|
| `types.ts` | `Pins`, pin names, result types |
| `infer.ts` | `inferPins` — the replaceable default rule |
| `units.ts` | groups, mask pairs, cloners → rigid units and their boxes |
| `axis.ts` | the per-axis maps, forwards and backwards; the guard |
| `stretch.ts` | per-kind stretch, image cover-and-crop, text re-wrap |
| `motion.ts` | map position tracks |
| `resolve.ts` | the orchestrator and the identity fast path |
| `dropRule.ts` | the no-jump rule for edits at a viewing size |
| `arrange/yoga.ts` | the Yoga adapter: two-level tree in, boxes out; lazy WebAssembly load |
| `arrange/infer.ts` | read gap, padding, align and order off a free group when it is switched on |
| `arrange/layout.ts` | lay an arranged group's members out in a given box (design size and other sizes alike) |

It refers to `useCompositorLayers.ts` by `import type` only, so the export
bundle does not pull the renderer in twice.

### Stored data

```ts
// on LayerCommon and on LayerGroup — optional, absent = automatic
pins?: {
  h?: 'left' | 'right' | 'both' | 'center' | 'relative'
  v?: 'top' | 'bottom' | 'both' | 'middle' | 'relative'
  keepSize?: boolean
  holdTo?: 'frame'          // absent = automatic (section when inside one)
}
// on LayerGroup — optional, absent = 'free'
arrange?: {
  direction: 'row' | 'column'
  gap: number                        // normalized to design width
  padding: number | [number, number, number, number]   // top, right, bottom, left
  align: 'start' | 'center' | 'end' | 'stretch'
}
// on LayerCommon — only read while the layer is a member of an arranged group
flow?: 'hug' | 'fill'                // absent = 'hug'
// on sailor_frame
responsive?: boolean
```

Plain data: it rides along with copy, paste, duplicate, templates and undo.
The agent's `setLayerProps` patch accepts `pins` and `flow`; its group edit
accepts `arrange`.

### How a resolved layer reaches the renderer

A resolved layer is an ordinary layer with new `x` / `y`, new box fields if it
stretched, a transient crop for a covered image, and one transient number,
`layoutScale` — never saved, the same contract as motion's `motionScale`
(and multiplied with it).

**Open technical risk, settled first in the plan by a spike.** Today the
draw-time scale wraps a whole layer pass, including a mask shape drawn inside
it, and wired layers draw through a separate path. For layout the scale must
apply per drawn layer (mask sources, cloner stamps, wired pictures each get
their own), and the editor's selection boxes must agree with it. Two
candidate techniques: (a) `layoutScale` applied where a layer's own transform
is set up; (b) drawing each layer against a "virtual canvas" of the fitted
design size plus a translation, which needs no per-field work and keeps
shadows and text hinting exact, but must not clip stretched layers. The spike
picks one. **Correctness is defined by the tests below, not by the
technique.**

### Text re-wrap

Re-wrap and auto-height use the renderer's own line-breaking through
`opts.measure` (the same injection the Layout tab's pattern engine uses), so
the resolver and the painter cannot disagree about where lines break. With no
measurer, text keeps its centre (documented degradation).

## Fit with the web export spec

Checked against `2026-09-21-frame-web-export-design.md` as landed on main
(`6a01fe869`). That spec is not edited here; these are the points where the
two meet.

- **The choice.** The export stores `fit: 'fit' | 'fill'`. "Adapt" would be a
  third value, offered only for responsive Frames. For a fixed Frame nothing
  in the export changes.
- **Same picture when nothing adapts.** The export paints the background once
  across the whole box, then the layers under one scale-and-offset. With every
  layer pinned Center/Middle, "Adapt" must give exactly that picture (pixel
  test 11). At the design's own shape both are identical to the studio, so the
  export's parity tests keep running there.
- **What the snapshot needs.** A `FrameVariant` carries the design size,
  layers, groups and motion already. For "Adapt" it also needs the grid
  config (for section-held pins) and the Frame's `responsive` flag. Both are
  optional additions; the format's version does not have to change.
- **`setSize(w, h)`.** Calls `resolveLayout` once, caches the result, and
  each `setTime` paints the cached layers and motion. The pixel size handed to
  each nested child comes from the result's `boxes`.
- **Text measuring.** The adapter has a canvas and has already registered and
  awaited the fonts at mount, so it can supply `opts.measure`.
- **Asset sizes.** The export downsizes images to at most 2× the size they are
  drawn at. In a responsive Frame a stretched image can be drawn larger than
  at the design size (up to the guard's limit), so the "drawn size" used for
  that budget should be the largest the guard allows, not the design size.
- **Nested live pieces.** A stretched wired layer is cover-and-crop in v1,
  everywhere. In the export a nested live child could instead be given its
  new box and re-render at that shape; that is a later improvement, not v1.
- **Yoga in the bundle.** When a variant contains an arranged group, the
  bundle includes the Yoga WebAssembly file and `mount` awaits it before the
  first paint. Without one, the bundle is exactly what the export spec
  describes. The sheet's notices gain one sentence stating the added size.
- **Shared risk.** The export notes that painting layers under an *offset* is
  untested for the backdrop-reading effects (glass, backdrop shader,
  displacement lens) and gives it a test. The rendering spike here hits the
  same question per layer, so it should reuse that test rather than write a
  second one.

## Back-compat guarantee

- Every existing Frame is fixed → `resolveLayout` is never asked to change it,
  and if called returns the inputs by reference. Byte-identical.
- A responsive Frame laid out at its design size → identity as well. Card
  previews and high-resolution bakes always lay out at the design size and
  only change the pixel count, so they are identity too.
- `resolveGrid`'s new input is optional and defaults to today's behaviour.
- No existing call site of `paintLayerStack` changes meaning; only the new
  callers pass resolved layers.

## Testing

Pure unit tests:
1. Identity: fixed Frame, or box equal to the design size → same references
   out. Same shape at another size → every layer uniformly scaled, except
   "Keep size" layers.
2. Each pin's map, forwards and backwards (round trip), with and without the
   guard; Keep size.
3. `inferPins` table: edges, centre, spans, backgrounds, non-stretch kinds.
4. Section attachment; region identity across sizes for explicit and
   generated grids (merge on, mirror on).
5. Rigid units: group, mask pair, cloner boxes and placement.
5a. Arranged groups: switching on reads gap/padding/align/order back exactly
    for a tidy group and moves nothing; overlapping members get nudged;
    Hug and Fill share room correctly; text pushes what follows; the box hugs
    along the flow when members overflow; a member keyframe is an offset;
    Yoga unavailable renders the stored design-size positions. Golden tests
    pin the Yoga version: the same tree gives the same boxes.
6. Motion: map-then-interpolate equals interpolate-then-map.
7. Per-kind stretch; image cover-and-crop; text keeps its pinned edge.
8. The drop rule: crossing the midline flips an automatic pin with no jump;
   disagreement stores an explicit pin.

Pixel tests (real canvas):
9. Responsive Frame at its design size == the same Frame fixed.
10. Same shape, other box size, no "Keep size" layers == today's render at
    that size.
11. Every layer pinned Center/Middle == the export's fit-and-bleed.
12. Every layer pinned Left/Top == the design, scaled by `s`, at the top-left.

Interaction: a **real-mouse** check of edge dragging, moving a layer at a
viewing size, and "Back to design size" (synthetic pointer events do not count).

## Build order

This is one spec but five slices, each shippable on its own. The plan should
follow this order:

1. **The resolver.** The rendering spike, then `lib/frame/responsive/` with
   its unit and pixel tests. Nothing visible in the app.
2. **Responsive Frames you can look at.** The "Responsive" choice in the size
   picker, draggable edges, the size readout, the pins card, guide lines.
   Editing tools return to the design size for now.
3. **Editing at a viewing size.** Running the maps backwards, the drop rule,
   selection and hit-testing from resolved boxes.
4. **Arranged groups.** Measure Yoga's real size first (go/no-go on the
   figure); the adapter and its golden tests; the group card's "Arrange";
   switch-on inference and write-back at the design size; members' Hug/Fill;
   reorder by drag. Works on fixed Frames as well as responsive ones, and
   inside `resolveLayout` for other sizes.
5. **"Adapt" in the web export.** Owned by the web export work; this spec
   only provides `resolveLayout` for its `setSize`, and the Yoga file for
   variants that need it.

## Not in v1

- Arranged groups inside arranged groups; members wrapping onto new lines;
  space-between and other distributions; a member that ignores the
  arrangement (absolute position); min/max sizes on members.
- Layers pushing each other **without** an arranged group (no automatic
  stacking of free layers).
- Alternate layouts per shape / breakpoints (Smart Layout covers formats).
- Stretch for paths, brush, deal, scatter, rotated or corner-pinned layers,
  free groups, cloners.
- Min/max sizes, a type-size floor, per-size overrides.
- Animating pins.
- A side-by-side sheet of sizes.
- "Suggest pins" (Jev or the agent) — only the seam exists.
- Dragging a **fixed** Frame's edge to really resize it with pins, and "use
  this viewing size as the design size". Both need every size number on every
  layer rewritten permanently; that is its own project. Changing a Frame's
  size keeps today's behaviour.
- Brush, pen, mask painting, region generation, smart select, patterns and
  grid editing at a viewing size.
- Timeline scenes and canvas cards: they keep rendering the design as today.
