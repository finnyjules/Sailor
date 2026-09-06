# 3D Studio: per-object treatments

Date: 2026-09-05
Status: approved design, plan not yet written

## Problem

Every effect in the 3D Studio today is whole-frame. The shared post stack has thirteen
switches (bloom, colour grade, chromatic aberration, lens blur, distort, film, halftone, dot
screen, glitch, grain, vignette, duotone, ambient occlusion) and all of them apply to the
entire render. Per object, the only "effects" are materials (glass, fresnel, toon, matcap,
gem, opalescent) and geometry modifiers (taper, twist, bend, noise, jitter, cloner).

You cannot blur one model while the rest stays sharp. You cannot put a rim light or an
outline on one model without changing its material. That is the gap this design fills.

A second, related problem: the right-hand inspector is crowded. With a model selected it
shows Transform, Geometry (plus Modifiers and Cloner), Material (plus seven sub-blocks),
Camera, Lighting, Background, and the thirteen post cards. Adding eight more effect cards
there would make it worse. Treatments therefore live in the left-hand object tree, and the
inspector only tunes whichever row is selected.

## What ships

Eight per-object treatments, in two families.

Masked family (rendered on the object's own layer, then composited):

- Blur
- Glow
- Pixelate
- Fade

Edge family (shell meshes or a material override on the object's root):

- Rim light
- Outline
- X-ray
- Wireframe

Each masked treatment has an "Everything else" toggle that inverts it: "blur this model"
and "blur everything but this model" are the same control flipped. Edge treatments have no
such toggle, since inverting them has no meaning.

## Section 1: Data

Each scene object gains an optional `treatments` list. An entry has:

- `id`: stable string id, generated on creation. Never an array index (see the
  list-addressing rule: stable ids, not positions).
- `kind`: one of `blur | glow | pixelate | fade | rimLight | outline | xray | wireframe`.
- `enabled`: boolean. The eye toggle in the tree.
- `invert`: boolean. The "Everything else" toggle. Stored for every kind for schema
  simplicity, only honoured by the masked family, and hidden in the inspector for the edge
  family.
- A small dial bag per kind:
  - Blur: `amount`.
  - Glow: `strength`, `threshold`, `tint` (colour).
  - Pixelate: `cellSize`.
  - Fade: `opacity`.
  - Rim light: `color`, `width`, `strength`.
  - Outline: `color`, `thickness`.
  - X-ray: `color`, `opacity`.
  - Wireframe: `color`, `lineOpacity`, `showSurface` (boolean).

Rules:

- The list lives on the object. Treatments are never entries in the flat `doc.objects`
  array and never carry a `parentId`. Eight modules iterate that array, and the agent path
  space and motion targets are built over it; none of them change.
- List order is stack order. The first entry applies first. Order matters for the masked
  family only.
- Duplicating an object copies its treatments with fresh ids. Grouping, ungrouping and
  deleting objects behave exactly as before, since treatments ride along on the object.
- Parsing an old document without the field yields an empty list. Parsing a partially
  valid entry drops that entry rather than the object. This mirrors the existing
  "validate then copy" posture in the document parser.
- Defaults for every dial live next to the other scene defaults so the inspector, the
  parser and the agent control list read one source.

## Section 2: Left panel

- Treatment rows render as pseudo-children under their object, indented one level below
  the object row, with a kind icon, the kind's human name, and an eye toggle on hover.
  Decal rows already set this "attached thing under the model" precedent.
- A plus button appears on hover of any primitive or imported-model row and opens a small
  menu listing the eight kinds. Groups, lights and decals do not get the plus button.
- There is no "Add effect" card in the inspector. Adding happens from the tree only.
- Selecting a treatment row sets a separate "selected treatment" state, shaped as
  `{ objectId, treatmentId }`. It clears the object selection highlight. The gizmo hides,
  since there is nothing to transform.
- With a treatment selected, the inspector shows a breadcrumb naming the parent object,
  then only that treatment's dials, then nothing else. Selecting the object again shows the
  object cards as today.
- Drag within one object's treatment rows reorders the stack. Dragging a treatment row to a
  different object is not supported in this pass.
- Delete and duplicate on a treatment row act on the treatment only. Duplicate inserts the
  copy directly after the original with a fresh id.
- Expand and collapse state of the object row already exists and is local UI state;
  treatment rows follow the same disclosure and are never persisted.
- Copy: all labels are sentence case and use human names, never stored identifiers
  ("Rim light", "X-ray", "Everything else").

## Section 3: Rendering, masked family

The engine's shared render function (the one both the viewport and the export bake call)
gains a treatment stage. It runs whenever any visible object has an enabled blur, glow,
pixelate or fade, regardless of whether global post is on. When no such treatment exists,
the render path is byte-for-byte what it is today.

Per frame, in this order:

1. Render the base scene with every masked-treated object hidden, into a colour target that
   also keeps a depth texture.
2. For each masked-treated object, in stack order across the tree:
   a. Draw that object alone (only its root visible; lights still light it; the shadow
      catcher and grid hidden) into an offscreen buffer with a transparent background and
      its own depth texture.
   b. Apply the effect to that buffer as a 2D pass. Blur spreads colour and alpha past the
      silhouette, so edges go soft rather than staying crisp. Pixelate quantises colour and
      alpha together, so edges go chunky. Fade multiplies alpha. Glow runs a bloom on the
      buffer and adds it back, so the halo stays attached to this object and never leaks
      into the global bloom setting.
   c. Composite the treated buffer over the base with a per-pixel depth test against the
      base depth, so a sharp object in front still occludes a blurred object behind. For
      halo pixels that have no depth of their own, the nearest opaque depth of the same
      buffer is used.
3. Hand the result to the existing post chain when global post is on, else to the screen.
   Global bloom and grade therefore apply on top of treatments. The existing gizmo overlay
   logic is unchanged and still draws last, un-post-processed.

"Everything else" flips which set is hidden in steps 1 and 2a: the treated object is drawn
sharp into the base, and the rest of the scene becomes the treated buffer.

Limits and consequences:

- A cap of eight masked-treated objects per frame. Objects beyond the cap render untreated,
  and their treatment rows show a small "Not rendered" mark. The cap is a named constant.
- Offscreen buffers are allocated at the renderer's current device size and reused across
  frames; they resize when the renderer does, matching how the post chain already tracks
  size. The export bake therefore gets output-resolution buffers for free.
- Depth and normal exports skip the stage entirely. A blurred model has no meaningful
  depth. Faded and x-rayed models still register as full geometry there, which is what
  ControlNet-style use wants.
- Because the stage is inside the shared render function, the baked still, the live Frame
  layer and the viewport all match.
- The stage never writes absolute renderer alpha or composite state that it does not
  restore; it follows the same save-and-restore discipline as the existing export bake.

## Section 4: Rendering, edge family

These attach to the object's own three root. No offscreen buffers, no cap.

- Rim light: a shell mesh sharing the object's geometry, drawn with an additive fresnel
  material (colour, width as the fresnel power, strength as intensity), depth write off.
  Because it is a separate mesh, it works over every material type including gradient and
  shader fills.
- Outline: a slightly inflated back-face shell in the outline colour. Thickness scales the
  inflation in screen-stable units so a zoomed-out model does not lose its line.
- X-ray: while active, the object's meshes render with a translucent override (colour,
  opacity) with depth test off, so it shows through everything in front of it. The original
  material is kept and restored when the treatment is disabled or removed.
- Wireframe: a child mesh sharing the geometry with a wireframe material (colour, line
  opacity). `showSurface` off hides the object's own surface meshes while the wireframe
  stays.

Shells and overrides rebuild through the same hook that rebuilds the object mesh, so they
follow geometry parameter changes, modifiers, sculpt commits and imported-model reloads.
They are flagged as editor-neutral, not editor helpers: they should appear in the beauty
export, and they are excluded from raycasting so clicking a rim light shell selects the
object underneath.

In the depth and normal exports, rim light and outline shells are hidden (they are
lighting, not geometry). X-ray and wireframe render as the plain geometry.

## Section 5: Motion, agent, tests

Motion:

- Every numeric dial and the `enabled` flag become animatable targets, addressed by
  treatment id: `objects.<objectId>.treatments.<treatmentId>.<dial>`. Reordering or
  deleting a sibling never retargets a keyframe.
- Targets are generated by the same routine that already expands per-object controls, so
  the motion timeline picks them up without a second list to maintain.

Agent:

- The agent control list gains the same paths with the same ranges and labels, produced
  from the one control declaration per kind.

Tests:

- Unit: parsing old documents (no field) and new ones; dropping an invalid entry without
  dropping the object; stack order preserved across parse and serialize; duplicate object
  gives fresh treatment ids; duplicate treatment inserts after the original; target path
  generation by id; the eight-object cap decides "rendered" versus "not rendered"
  deterministically.
- Browser (Playwright, real dev server, per the worktree E2E recipe): a scene with one
  blurred model next to one sharp model, screenshot compared against a golden; the same
  scene with "Everything else" flipped; export parity between a viewport screenshot and
  the baked still with a blur and a rim light active. Assert the treatment stage actually
  ran rather than accepting a graceful fallback to the plain render.

## Out of scope, noted as follow-ups

- A "Scene" row at the top of the tree owning Camera, Lighting, Background and the post
  cards, so selecting a model shows only model things. This is the larger decongestion
  move and touches the agent and Collection contract, so it is its own design.
- Depth-varying blur (true depth of field with a "focus on this object" pick).
- Dissolve, slice, hologram and other reveal treatments.
- Dragging a treatment between objects.

## Decisions recorded from the conversation

- Treatments are per object, set from the tree, with an invert toggle for the masked
  family. Not a separate "focus" concept.
- No "Add effect" card in the inspector: it would read as another post-processing block.
- Per-object layer rendering was chosen over silhouette masking because a masked blur has
  crisp edges and reads as a texture bug. The cheaper first cut was offered and declined.
- Edge treatments are shells and overrides rather than material variants so they work on
  every material type and show up in exports with no extra work.
