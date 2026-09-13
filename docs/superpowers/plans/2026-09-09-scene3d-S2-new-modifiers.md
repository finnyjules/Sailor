# Scene3D S2 · New modifiers (on the S1 stack)

> Slice S2 of the 3D treatments programme. Adds new modifier KINDS to the stack S1 built
> ([[scene3d-modifier-stack-landed]]). Adding a kind is cheap now — the tree, add-menu, per-modifier
> inspector (with select index↔option coercion), agent vocab, motion targets, geoKeyFor and duplicate
> carry are all generic over MODIFIER_KINDS. A new modifier ≈ one apply fn + registration + a unit test.
> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps `- [ ]`. BASE fd58c4b3a.

## The one architectural change (Task 1)
S1's five deformers mutate vertices in place; most S2 modifiers PRODUCE new geometry (change vertex
count/topology) like the cloner. Generalize `applyModifierStack`'s middle loop to per-row dispatch:
`out = applyOne(out, row, ctx)` — a deform mutates and returns the same geo; a producer returns a new
geo. subdivide stays pinned first, cloner pinned last. Legacy byte-identity MUST hold (a legacy bag has
none of the new kinds → 95/95 oracle unchanged). Add a geometry↔MeshData bridge for the voxel engine.

## Tasks
1. **Enabling refactor + `mirror`.** Generalize the loop (deform vs producer dispatch); add `mirror`
   (axis; duplicate + flip across a plane + weld) as the first producer to exercise the path. Re-run the
   S1 byte-identity oracle (unchanged) + a mirror unit test (vertex count doubles pre-weld, bounds
   symmetric about the plane).
2. **In-place deformers:** `shear` (axis pair, amount), `spherify` (amount 0..1 toward the bounding
   sphere), `smooth` (Laplacian, iterations/strength), `melt` (gravity axis, amount — lower verts spread
   + sag). Each: apply fn + registration + unit test (vertex count unchanged, bounds/sampled vertex).
3. **`radial array`** (producer): N copies rotated about an axis (its own modifier, not a cloner mode).
   Unit test (count × N, rotational symmetry).
4. **`shatter`/explode** (producer): per-face split + offset along face normal by a seeded amount. Unit
   test (non-indexed, deterministic, bounds grow).
5. **`decimate`** (producer): three `SimplifyModifier` (examples/jsm/modifiers) at a ratio. Unit test
   (vertex count drops, bounds ~preserved).
6. **`lattice`** (deformer, vertex count unchanged): a 3×3×3 trilinear cage driven by a SMALL dial set
   (Bulge, Pinch, Twist per the cage) rather than 81 raw points — interactive cage handles are a
   follow-up, note it. Unit test.
7. **`voxelise`** (producer): voxel `remesh(meshData, resolution)` at a cell size; bridge geometry↔
   MeshData (meshDataFromGeometry / geometry-from-MeshData); cap resolution to VERTEX_BUDGET; open-mesh
   fallback returns input. Unit test.
8. **`boolean`** (producer, HARD): SDF union/subtract/intersect with a sibling via the voxel module,
   `refObjectId` (decals' targetId precedent). Resolve the sibling geometry at the ENGINE call site
   (geometryForObject) and pass it into applyModifierStack via ctx; cache by BOTH geoKeys; missing/self
   ref = no-op. Unit test + the engine plumbing.
9. **Export + agent + motion verification.** Confirm every new modifier flows through the generic
   surface (tree/inspector/agent/motion — should be free from S1) and that the export depth/normal
   passes render the MODIFIED geometry (override-material path). A lab Playwright smoke on 2-3 new
   producers (order + a render). Fix any gap.
10. **Whole-slice review + dashboard + memory.**

## Acceptance (spec)
Unit test per modifier on known geometry (vertex counts, bounds, a sampled vertex); export depth/normal
passes render the modified geometry; legacy byte-identity intact; no dead controls; vertex budget holds.
