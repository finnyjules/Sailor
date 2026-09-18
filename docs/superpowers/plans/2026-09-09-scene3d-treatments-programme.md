# 3D Studio Treatments & Modifiers Programme — Plan of Slices

> **For agentic workers:** PROGRAMME plan — order, interfaces, tasks and acceptance per slice. Each
> slice gets its own task-level plan (complete code, TDD, anchors) when reached, executed with
> superpowers:subagent-driven-development as the treatments feature was.

**Goal:** Modifiers as an ordered stack in the tree; a live depth-and-normal buffer and the treatments
it enables; the expected masked and edge treatments; finishes as overlays; light linking; motion-driven
treatments; an AI restyle pass; the Scene row.

**Spec:** `docs/superpowers/specs/2026-09-09-scene3d-treatments-programme.md`.

**Global constraints:** byte-identical geometry (vertex-buffer compare) and pixels (real-canvas A/B on
the lab page) for objects without a slice's new rows; modifiers stay real CPU geometry; dials are
motion targets and agent controls by stable id via `iterate*Controls`; UI copy sentence case; layer
bits 29–31 reserved; one dev server; verification through `/dev/scene3d-lab?state=` and the
`__scene3d*` hooks; commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Slice S1 · The modifier stack  (≈9 tasks) — ✅ LANDED 2026-09-10 (base 7483f7853 → 627a19d14; whole-slice review Approved-with-minors; see 2026-09-09-scene3d-S1-modifier-stack.md + memory scene3d-modifier-stack-landed)

**Interfaces produced**
- `lib/scene3d/modifierStack.ts` (pure): `MODIFIER_KINDS` (`subdivide, taper, twist, bend, noise,
  jitter, cloner` + later kinds), `MODIFIER_ORDER`, `PINNED_MODIFIERS = ['subdivide', 'cloner']`,
  `ModifierInstance = { id, kind, enabled, ...params }`, `modifierStackOf(obj)` read-through (legacy
  flat bag → canonical stack with deterministic ids), `writeModifierStack(stack)` patch clearing
  `modifiers`, `addModifier/removeModifier/duplicateModifier/reorderModifier/canReorderModifier`.
- `modifiers.ts`: `applyModifierStack(geometry, stack, budget)` iterating in order; `applyModifiers`
  becomes a wrapper over the read-through (byte-identical for a bag).
- `engine.ts` `geoKeyFor` keys on the stack; `panelPresentation` drops the Modifiers/Cloner sub-cards
  in favour of rows; `Scene3DObjectRow` emits `addModifier`; a `Scene3DModifierRow.vue` mirrors the
  treatment row; inspector shows one modifier's dials (from `MODIFIER_SPECS`) under a breadcrumb.

**Tasks**
1. Pure model + read-through + list ops + tests (legacy bag → canonical order; ids deterministic).
2. `applyModifierStack` + `applyModifiers` wrapper; vertex-buffer byte-identity test on every
   primitive with every legacy modifier set.
3. `geoKeyFor` on the stack; cache test.
4. Motion targets + agent vocabulary by id (`iterateModifierControls`), tests.
5. Tree rows + add menu (+ "Modifiers" caption), drag within the region, pinned first/last.
6. Inspector: selected modifier's dials; Geometry card slims; sculpt swap still works.
7. Duplicate object copies the stack with fresh ids; convert-to-mesh and GLB retry carry it (the
   allowlist lesson).
8. Playwright on the lab page: twist-then-bend ≠ bend-then-twist; two twists; legacy doc identical.
9. Copy + dashboard.

## Slice S2 · New modifiers  (≈10 tasks) — ✅ LANDED 2026-09-10 (base fd58c4b3a → 7ad94f0b8; 11 kinds; whole-slice review Approved-with-minors; see 2026-09-09-scene3d-S2-new-modifiers.md + memory scene3d-modifiers-s2-landed)
Shear; spherify/inflate; mirror; radial array; displace by noise/texture; smooth (Laplacian);
decimate (SimplifyModifier); lattice deform (3×3×3, trilinear); melt; shatter/explode;
voxelise (voxel module); boolean with a sibling (SDF union/subtract/intersect via the voxel module,
`refObjectId` like decals' `targetId`). One task each (grouped where trivial), each with a
known-geometry unit test and the export override-material path checked.

## Slice S3 · Live G-buffer + edge lines, depth fog, curvature wear  (≈7 tasks) — ✅ LANDED 2026-09-10 (base e45630a5a → fef808715; edgeLines/depthFog/curvatureWear; whole-slice review Approved-with-minors; see 2026-09-09-scene3d-S3-gbuffer.md + memory scene3d-gbuffer-treatments-s3-landed)
1. `GBufferPass` in the stage: normals via `MeshNormalMaterial` override into an RT, depth from the
   base target; runs only when a consuming treatment exists; byte-identity A/B otherwise.
2. Edge lines (Sobel over normal+depth; width, threshold, colour) as a masked treatment.
3. Depth fog / atmospheric tint. 4. Curvature wear. 5. Lab-page Playwright: a box's creases get lines
   where the hull outline gaps. 6. Agent/motion. 7. Copy.

## Slice S4 · New masked and edge treatments  (≈8 tasks)
Masked: colour grade; dissolve; halftone/dot screen; chromatic split; glitch/scanlines; flat drop
shadow. Edge: dashed outline; silhouette cutout; cross-hatch. One task per family + Playwright.

## Slice S5 · Finishes as treatments; light linking  (≈7 tasks)
1. `applyFinish` seam (the `applyScreen` pattern) for foil shimmer, opalescence, matcap overlay;
2–4. the three finishes; 5. light-linking SPIKE (shader-side mask by light index through the seam);
6. light exclusion + per-object colour cast, or colour cast only if the spike fails; 7. proofs.

## Slice S6 · Motion-driven treatments  (≈5 tasks)
1. Velocity from two motion samples (`t`, `t − dt`) projected to screen; 2. velocity motion blur in
the stage; 3. ghost trails / onion skin (N samples faded); 4. Playwright: blur along the path, none
when still; 5. agent/motion/copy.

## Slice S7 · AI restyle pass  (≈6 tasks)
1. Model choice + route `server/api/scene3d/restyle.post.ts` (fal/Replicate; allowlist; cost gate);
2. crop beauty + depth (+ normal) for the object from `renderPasses`; 3. treatment kind with prompt,
strength, re-run; 4. composite masked to the silhouette, cached by inputs; 5. one live paid run at
acceptance (owed until done); 6. copy.

## Slice S8 · The Scene row  (≈5 tasks; own design first)
Camera, Lighting, Background, post under a Scene row; agent and Collection contracts adjusted;
selection semantics; tests.

---

**Recommended interleave with the Frame programme:** see the Frame plan's closing line.
