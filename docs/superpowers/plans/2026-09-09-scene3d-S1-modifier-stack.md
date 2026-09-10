# Scene3D S1 · The modifier stack (bag → ordered rows)

> Slice S1 of the 3D treatments programme (`2026-09-09-scene3d-treatments-programme.md`). Turns the flat
> modifier bag into an ordered, id-stamped, duplicable, reorderable stack shown as rows under the object —
> the effect-stack UX ([[frame-layer-effect-stack-landed]]) and the treatment UX
> ([[scene3d-object-treatments-landed]]), applied to geometry modifiers. REQUIRED SUB-SKILL:
> superpowers:subagent-driven-development, task-by-task. Steps use `- [ ]`. BASE 7483f7853.

## The shape of it
Legacy: `object.modifiers?: Record<string, number>` — a flat numeric bag, one value per param, fixed
pipeline order (subdivide→taper→twist→bend→noise→jitter→cloner), at most one of each. New:
`object.modifierStack?: ModifierInstance[]` — ordered, id-stamped, duplicable. Read-through
`modifierStackOf(obj)` folds a bag into the canonical-order stack (byte-identical geometry); the new
shape persists only on edit. Pinned: subdivide first, cloner last.

## Tasks
1. **Pure model + read-through + list ops** (`lib/scene3d/modifierStack.ts`, new): `MODIFIER_KINDS`
   (`subdivide,taper,twist,bend,noise,jitter,cloner`), `MODIFIER_ORDER`, `PINNED_MODIFIERS=['subdivide','cloner']`,
   `MODIFIER_KIND_PARAMS` (kind→its param keys, from MODIFIER_SPECS), `ModifierInstance={id,kind,enabled,...params}`,
   `modifierStackOf(obj)` (bag→canonical stack, deterministic ids `mod:<kind>:0`, only ACTIVE modifiers
   per today's hasModifiers logic; subdivide included only when a deform is present, matching applyModifiers),
   `writeModifierStack(stack)` (patch clearing `modifiers`), `add/remove/duplicate/reorder/canReorderModifier`,
   `MODIFIER_LABELS`. Unit tests: bag→canonical order; ids deterministic & stable on re-read; all-zero bag → empty stack.
2. **`applyModifierStack(geo, stack, {vary,budget})` + `applyModifiers` wrapper.** Iterate the STACK in
   order (subdivide budget-aware, cloner last via planClones/mergeClones exactly as today). `applyModifiers(geo,bag,vary)`
   = `applyModifierStack(geo, modifierStackOf({modifiers:bag}), {vary})`. VERTEX-BUFFER byte-identity test:
   every primitive × every legacy modifier set, buffer compared, incl. the all-zero no-op returning the same object.
3. **`geoKeyFor` on the stack** (engine.ts): key on kinds+order+params (still exclude varyColorStrength). Cache test.
4. **Motion targets + agent vocabulary** by id: `objects.<id>.modifierStack.<mid>.<field>` (`iterateModifierControls`); tests.
5. **Tree rows + add menu** (+ "Modifiers" caption), drag within the orderable region, subdivide pinned first / cloner pinned last; a `Scene3DModifierRow.vue` mirroring the treatment row; `Scene3DObjectRow` emits `addModifier`.
6. **Inspector**: selected modifier's dials from MODIFIER_SPECS under a breadcrumb; Geometry card slims to the primitive's own params + cloner cost readout; sculpt's Geometry-card swap still works.
7. **Duplicate object copies the stack with fresh ids**; convertToMesh + GLB retry carry it (the allowlist lesson).
8. **Playwright on the lab page**: twist-then-bend ≠ bend-then-twist; two twists both apply; a legacy doc renders byte-identical.
9. **Copy + dashboard + memory.**

## Acceptance (from the spec)
A legacy object's geometry is byte-identical (vertex buffer compare); twist-then-bend differs from
bend-then-twist; two twists both apply; the vertex budget still holds; sculpt swap works; no dead controls.
