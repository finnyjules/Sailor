# Cloner Vary — per-copy variation for the 3D and Frame cloners

Date: 2026-09-06
Status: design approved, ready for planning

## Problem

Both cloners produce identical copies. The 3D Studio cloner (`lib/scene3d/modifiers.ts`
`applyCloner`) merges N copies into one geometry with one material. The Frame cloner
(`composables/useCloner.ts` `expandClones`) stamps a layer N times with a fixed
rotation/scale/opacity step per index. Neither can vary colour, and the existing steps
only ever run as a linear accumulation along the copy index.

The user wants to vary colour — and other properties — across the copies of a cloner,
in both places, under one shared concept.

## Approach

**One shared "Vary" model, two renderers, plus a recipe seam in the 3D cloner.**

A pure module computes, per copy, a weight in `[0,1]` from one of three drivers, and maps
that weight onto property values (colour from a palette; scale/rotation/opacity from the
existing step numbers). The 3D cloner delivers colour as a per-vertex colour attribute on
the merged geometry, so one object stays one mesh. The Frame cloner delivers colour as a
per-copy tint pass on canvas, mirrored in Python for wired renders.

### Approaches considered and rejected

- **InstancedMesh for 3D copies.** Native per-instance colour and cheap at thousands of
  copies, but it breaks the one-mesh-per-object assumption that treatments, outlines,
  sculpt, decals, picking, the Light View clay swap and GLB export all rely on. A
  multi-week refactor to ship a colour feature.
- **Hue-rotation dial only.** Half a day of work, but it cannot hit chosen colours, and a
  palette was an explicit requirement.

The recipe seam (below) keeps the InstancedMesh route open without paying for it now.

## The Vary model

New module `frontend/app/lib/vary/` — pure TypeScript, no three.js, no canvas, no DOM.

### Stored shape

One optional `vary` object per cloner. Absent ⇒ current behaviour, exactly.

```ts
interface Vary {
  mode: 'sequence' | 'random' | 'falloff'
  seed: number             // random mode only
  falloffCenter: number    // 0..1 along the array extent
  falloffRadius: number    // 0..1
  colour: {
    enabled: boolean
    palette: string[]      // 2..8 hex swatches
    spread: 'cycle' | 'blend'
    strength: number       // 0..1
  }
}
```

Scale and rotation gain **no new fields**. The mode picker changes how the existing
`stepRot*` / `stepScale` (3D) and `stepRotation` / `stepScale` / `stepOpacity` (Frame)
numbers are applied.

### Job one — weights

`varyWeights(count, vary): number[]`

- **sequence** — `i / max(1, count - 1)`; copy 0 is 0, the last copy is 1.
- **random** — a seeded integer hash of `(i, seed)` normalised to `[0,1)`. The hash is
  specified explicitly (see Parity) so TypeScript and Python agree bit-for-bit.
- **falloff** — `d = |i/(count-1) - falloffCenter|`, then
  `w = smoothstep(1 - clamp(d / max(ε, falloffRadius), 0, 1))`. Copies at the centre get 1,
  copies beyond the radius get 0. Expressing the centre as a fraction of the array's
  extent — rather than a point in scene space — makes one control work for a line, a ring
  and a grid, and for both cloners.

`count === 1` ⇒ `[0]` in every mode.

### Job two — values

- **Colour, `spread: 'cycle'`** — picks one whole swatch, no interpolation. In sequence
  mode the index is `i % palette.length` (the Shape Studio per-clone look). In random and
  falloff modes it is `min(palette.length - 1, floor(w * palette.length))`, so the driver
  still chooses which swatch each copy gets.
- **Colour, `spread: 'blend'`** — interpolate through the palette by weight in every mode.
  **Linear sRGB, not OKLCH.** The same interpolation has to run identically in Python (PIL)
  for the wired compositor, and a perceptual space would need the whole conversion chain
  mirrored there for a difference only visible between distant hues. The palette editor
  lets the user place intermediate swatches, which is the better lever anyway.
- **Strength** — blends the resolved palette colour toward the copy's own base colour;
  `1` is the full palette colour, `0` is no change.
- **Scale / rotation / opacity** — the stored step value is the far end of the range;
  `value(i) = lerp(identity, stepApplied(i), w)` where `stepApplied` is today's
  accumulate-by-index result. In sequence mode `w` rises linearly to 1 at the last copy,
  which reproduces today's numbers for the last copy and eases the ones before it — so
  **sequence mode must special-case to the exact existing maths**, not the lerp, to
  guarantee byte-identical rendering of existing documents. Random and falloff use the lerp.

## 3D Studio

### Storage

A new optional `vary` on the primitive object, a sibling of `modifiers` (which stays a
flat `Record<string, number>` bag). Sanitised on load alongside `modifiers`.

**Allowlist audit (known trap):** `toMesh` and `retryGlb` drop unknown fields on
`SceneObject`. Both must be extended, and every other place that reconstructs a scene
object must be grepped and checked — this class of bug has bitten this codebase before.

### The recipe seam

`applyCloner` splits into two functions:

1. `planClones(count, settings, vary): CloneRecipe[]` — the copy's `index`, its `matrix`,
   its `weight`, and its resolved `colour` (or undefined). No geometry, no three.js beyond
   `Matrix4`. **This is the reusable unit**: a future InstancedMesh or child-mesh renderer
   consumes the same list without touching drivers, palette logic or UI.
2. `mergeClones(geo, recipes): BufferGeometry` — today's clone/transform/merge. When any
   recipe carries a colour, it writes a `color` BufferAttribute filled per copy before
   merging.

The vertex budget guard (`clampedClones`) runs before planning, unchanged.

### Materials

When the merged geometry carries vertex colours, the material factory sets
`vertexColors: true` and forces the base colour to white so the palette reads as chosen.
The material cache key gains a vertex-colours flag so a toggle cannot reuse a stale
program.

- **Works as-is:** standard, phong, toon, glass, matcap, fresnel, opalescent, holographic.
- **gradient** — the ramp *is* the colour, so vertex colour multiplies it (a tint). The
  control carries a hint saying so. Accepted, not a defect.
- **image, shaderFill** — no base colour is read. The colour control is hidden entirely for
  these two types.

### Untouched

One mesh per object. Treatments, outlines, sculpt, decals, picking, the Light View clay
swap and hit-testing all keep working with no changes. GLB export gains vertex colours for
free.

## Frame

`expandClones` returns `CloneTransform` per copy. It gains three fields: `weight`,
`tint?: string`, `tintStrength: number`. With no `vary` block, `tint` is undefined and
every existing field holds its current value.

Three draw sites consume it; each already has the machinery it needs:

| Site | File | Tint mechanism |
|---|---|---|
| Effected path | `useCompositorLayers.ts` (~L1860) | already renders the copy to an offscreen — tint it `source-atop` before the stamp |
| Fast path | `useCompositorLayers.ts` (~L1941) | draws inline — borrow `scratchLike` / `stampScratch`, tint on the scratch |
| Wired image path | `useCompositorLayers.ts` (~L3042) | same scratch-and-tint around the fitted `drawImage` |

The scratch detour is taken **only when `tint` is set**, so untinted rendering stays on
today's code path byte-for-byte.

## Parity — Python mirror

`comfy_extras/nodes_compositor.py` `_expand_clones` is a line-comparable mirror of
`expandClones` and must stay one. It gains the same `weight` / `tint` / `tintStrength`,
and the composite tints each clone with PIL before pasting.

The seeded hash is the parity risk. It is specified as an explicit integer routine
(32-bit ops, no language-native RNG, no float accumulation) and asserted by a test on a
fixed seed and count.

## Controls

One block, **Vary**, below the placement controls inside each cloner card. Identical
vocabulary in both surfaces.

- Mode picker: Sequence / Random / Falloff. Sequence is the default.
- Seed — Random only. Centre and Radius — Falloff only.
- Colour switch. On ⇒ reveals the palette list, a Cycle / Blend picker, and Strength.

The palette editor is **one small shared component** used by both surfaces, modelled on the
Shape Studio fills editor (which is bespoke and inline today — the new component does not
refactor it, but is written so Shape Studio could adopt it later).

Copy rules, per the standing project rule: sentence case throughout, no internal
identifiers in labels, and readable `optionLabels` on every picker whose stored values are
internal (`sequence`, `falloff`, `cycle`, `blend`).

3D Studio: the Colour switch is hidden for `image` and `shaderFill` materials, and carries
the tint hint on `gradient`.

## Testing

- **Unit — the vary module.** Each driver's boundary values (`count === 1`, first and last
  copy, falloff centre and beyond-radius). Palette cycle vs blend. A seeded-random snapshot.
- **Unit — parity.** TypeScript and Python clone expansions agree on one config, including
  the seeded hash and the resolved tints.
- **Unit — no-op.** A document with no `vary` block produces clone transforms identical to
  today and no `color` attribute on the merged geometry. This is the regression guard for
  every existing saved scene.
- **Live verification, both surfaces.** A real browser run on each cloner: palette applied,
  each of the three modes visibly different, colour switch off restores the original look.
  Not optional — render features in this codebase have been claimed as landed on unit tests
  alone and were wrong.

## Out of scope

- Per-copy material *type*, texture or geometry parameters. A merged mesh shares one
  material and one geometry; that needs real child meshes.
- Per-copy scalar material dials (roughness, metalness, emissive). Possible on the same
  seam later — one extra attribute plus a shader injection per material family — but not
  in this slice.
- Per-copy position jitter.
- Animating the vary weight over time.
- Agent addressability of the vary block.
