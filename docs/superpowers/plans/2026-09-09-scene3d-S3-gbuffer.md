# Scene3D S3 · Live G-buffer + edge lines, depth fog, curvature wear

> Slice S3 of the 3D treatments programme. A per-frame depth-and-normal buffer, rendered ONLY when a
> consuming treatment exists, feeding three new per-object treatments. Builds on the treatment stage +
> per-object treatments ([[scene3d-object-treatments-landed]]). REQUIRED SUB-SKILL:
> superpowers:subagent-driven-development. Steps `- [ ]`. BASE e45630a5a.

## The safety guarantee
When no edgeLines/depthFog/curvatureWear treatment is present, the GBufferPass does NOT run and the frame
is BYTE-IDENTICAL to before S3 (real-canvas A/B on the lab page, 0 changed pixels). Same discipline as
the modifier byte-identity: a new capability that is invisible until asked for.

## Tasks
1. **GBufferPass + edge lines** (the pass and its first consumer, together). A normals render target
   (MeshNormalMaterial override, like passes.ts's export bake) + depth, built once per frame in the
   treatment stage, gated on a consuming treatment existing; released when idle. **edge lines** as the
   first consumer: a Sobel over normal + depth discontinuities → a toon crease line (width, threshold,
   colour) that does NOT gap at hard corners. Register the kind (a new BUFFER group or an extension),
   interface, defaults, controls, parser, stage renderer. Prove: byte-identity when absent; edge lines
   on a box's creases.
2. **Depth fog / atmospheric tint** (colour, start, end) — reuses the G-buffer's depth. Register + composite.
3. **Curvature wear** (edge highlight/darken from normal change; amount, width) — reuses the normals. Register + composite.
4. **Lab-page Playwright**: a box's creases get lines where the S1 hull `outline` treatment gaps (pixel probe); byte-identity when no S3 treatment; fog darkens by depth; curvature marks the edges.
5. **Agent + motion**: verify the three kinds flow through iterateTreatmentControls generically (objects.<id>.treatments.<tid>.<field>); fix any gap. Bump enumeration guards.
6. **convertToMesh / duplicate carry + the G-buffer in the export bake** (a treated object exports with its edge lines — the bake path renders the same treatments).
7. **Whole-slice review + dashboard + memory.**

## Acceptance (spec)
Edge lines appear on a box's creases where the hull outline gaps (pixel probe); byte-identical when no
such treatment is present (the G-buffer pass does not run); no dead controls; the stage size guard holds.
