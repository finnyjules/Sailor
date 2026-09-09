# 3D Studio programme: the modifier stack, depth-and-normal treatments, new treatments and finishes

Date: 2026-09-09
Status: programme design, approved in conversation ("build all that you mentioned"); each slice gets its
own task-level plan when reached.
Builds on: `2026-09-05-scene3d-object-treatments-design.md` (treatments as tree rows, landed 09-06).

## What this programme is

The 3D Studio's objects now carry treatments as child rows. This programme (1) brings the existing
geometry modifiers into the same model as an ordered, duplicable stack, (2) gives the live viewport a
depth-and-normal buffer and builds the treatments that only that buffer makes possible, (3) adds the
masked and edge treatments people expect, (4) makes material finishes layerable as treatments and
adds light linking, motion-driven treatments and an AI restyle pass.

## What exists to build on (verified 2026-09-09)

- Modifiers are a flat number bag on the object (`object.modifiers`), applied in a fixed order
  (subdivide, taper, twist, bend, noise, jitter, cloner) by `applyModifiers`; one instance per kind;
  the geometry cache key folds every modifier value in. They are real CPU geometry on purpose: the
  depth/normal exports use an override material, and picking reads real vertices.
- Treatments: four masked kinds in `treatmentStage.ts` (`applyEffect` switch), four edge kinds as shell
  materials in `treatmentShells.ts`; the add-a-kind recipe is five places. Treatment dials are already
  motion targets by id and in the agent vocabulary.
- No live depth or normal buffer is exposed: the stage's base target has a depth texture used only for
  its own composite; the only normal render is the export bake's `MeshNormalMaterial` override; GTAO
  keeps its buffers private.
- Finishes compose through a proven `onBeforeCompile` seam (`applyScreen`, `applyVaryTint` snapshot
  the cache key and chain the previous hook), shipped on seven base materials. Opalescent and
  holographic are whole materials, not overlays. A procedural matcap builder exists.
- Lights: point, spot, rect. No per-light layer masking. Layer bits 29, 30, 31 are taken.
- Motion sampling is stateless (`applyMotionToDoc(doc, t)`); no velocity is produced.
- No CSG library; the home-grown voxel module does SDF union, remesh, solidify and surface nets.
  Sculpt brushes: draw, smooth, inflate, flatten, grab, pinch, crease. `gem.ts` crystallises.
- No route sends the beauty/depth/normal bake to an edit model; `renderPasses` is the natural hook.
- The inspector's Geometry card is its own panel and the sculpt panel swaps exactly it; treatment rows
  and their emits are the pattern a modifier row mirrors.

## Slices, in build order

### S1 · The modifier stack
`object.modifierStack?: ModifierInstance[]` — id-stamped, ordered, duplicable — with a read-through
from the legacy flat bag (the effectStackOf pattern: a bag becomes the canonical-order stack, byte-
identical geometry). Pinned: subdivide first, cloner last (structural: clones come after deforms).
Rows under the object beside treatments, under a small "Modifiers" caption; selecting a row shows only
that modifier's dials; the Geometry card keeps the primitive's own parameters and the cloner's cost
readout. `applyModifiers` iterates the stack; `geoKeyFor` keys on it; motion targets and the agent
address `objects.<id>.modifierStack.<mid>.<field>`. Sculpt's Geometry-card swap keeps working.
Acceptance: a legacy object's geometry is byte-identical (vertex buffer compare); twist-then-bend
differs from bend-then-twist; two twists both apply; the vertex budget still holds.
Depends on: nothing. Enables: S2.

### S2 · New modifiers
Reusing engines where they exist: **shear**, **spherify / inflate**, **mirror**, **radial array**
(a cloner mode or its own modifier), **displace by noise or texture**, **smooth** (Laplacian),
**decimate** (three's SimplifyModifier), **lattice / cage deform** (a 3×3×3 control lattice with
trilinear weights), **melt** (gravity-weighted displacement), **shatter / explode** (per-face offset
along normals, optional convex-cell split), **voxelise** (the voxel module's lattice at a chosen cell
size), **boolean with another object** (SDF union / subtract / intersect through the voxel module,
referencing a sibling the way decals reference a target; cached by both geometries' keys).
Acceptance: unit test per modifier on a known geometry (vertex counts, bounds, a sampled vertex);
export depth/normal passes still render the modified geometry (override-material path).
Depends on: S1.

### S3 · A live depth-and-normal buffer and the treatments that need it
A per-frame G-buffer pass, rendered only when a treatment asks for it: normals via a `MeshNormalMaterial`
override into a render target, depth from the existing depth texture. Then:
- **Edge lines** from normal and depth discontinuities (Sobel), with width and threshold — the toon
  line that follows creases and does not gap at hard corners; offered alongside the existing hull
  outline.
- **Depth fog / atmospheric tint** per object (colour, start, end).
- **Curvature wear** (edge highlight or darkening from normal change; amount, width).
Acceptance: edge lines appear on a box's creases where the hull outline gaps (pixel probe);
byte-identical when no such treatment is present (the G-buffer pass does not run).
Depends on: the stage (landed).

### S4 · New masked and edge treatments
Masked (the `applyEffect` recipe): **colour grade** (hue, saturation, tint, duotone, posterise,
invert), **dissolve** (threshold, softness, seed), **halftone / dot screen** (cell, angle), **chromatic
split**, **glitch / scanlines**, **flat drop shadow** (a 2D offset shadow of the object's silhouette).
Edge (shells): **dashed outline**, **silhouette cutout** (flat colour), **cross-hatch shading**.
Acceptance: a Playwright case per family on the lab page with a pixel-change assertion; a unit test on
each pure helper.
Depends on: the stage.

### S5 · Finishes as treatments, and light linking
- **Finish overlay** treatments through the composable `onBeforeCompile` seam: **foil shimmer**,
  **opalescence** and **matcap overlay** applied on top of any base material (the way Screen already
  is), so a textured object can carry a holographic sheen without switching material.
- **Light linking**: per-object exclusion from a light and per-object colour cast. Three.js lights
  affect every object in a pass, so this is a shader-side mask injected through the same seam (a
  per-object bitmask against light index), spiked first; if the spike fails, fall back to a per-object
  colour cast only.
Acceptance: a finish overlay over an ambientCG-textured material renders both (pixel probe);
excluding an object from a light darkens it and nothing else.
Depends on: nothing beyond materials.

### S6 · Motion-driven treatments
- **Velocity motion blur**: sample motion at `t` and `t − dt`, project the object's centre to get a
  screen-space velocity, and blur the object's layer along it in the stage (amount, shutter).
- **Ghost trails / onion skin**: the stage draws the object alone already; draw N earlier samples
  faded and composite them behind (count, spacing, fade).
Acceptance: a moving object in the lab page renders blur along its path and none when still.
Depends on: the stage; motion (exists).

### S7 · AI restyle as a pass
A treatment that sends the object's beauty plus depth (and normal) crop to an edit model through
fal/Replicate (a route under `server/api/scene3d/`, allowlisted, behind the cost-confirm gate) and
composites the result back masked to the object's silhouette. Prompt and strength dials, a cached
result keyed by the inputs, re-run on demand only. Paid; one live run owed at acceptance.
Depends on: `renderPasses` (exists); a model choice made in the slice spec.

### S8 · The Scene row
Camera, Lighting, Background and the post stack move under a Scene row at the top of the tree, so
selecting an object shows only object things. Touches the agent and Collection contracts; its own
design as already recorded.
Depends on: nothing; ordered last because it is decongestion rather than capability.

## Constraints that bind every slice

- An object with no new treatment or modifier renders byte-identically; geometry compares by vertex
  buffer, pixels by a real-canvas A/B when the render path changes.
- Modifiers stay real CPU geometry; heavy ones cache by geometry key.
- Treatment and modifier dials are motion targets and agent controls by stable id, through the
  existing `iterate*Controls` pattern.
- UI copy is sentence case, human names, never a stored kind string.
- Layer bits 29–31 are reserved; any new layer use is declared in one place.
- One dev server per checkout; the lab page (`/dev/scene3d-lab?state=`) and the window hooks are the
  verification route.

## Out of scope

A full G-buffer deferred renderer; a real CSG library (the voxel SDF path is the boolean); rigging or
skinning; per-vertex painting beyond sculpt.
