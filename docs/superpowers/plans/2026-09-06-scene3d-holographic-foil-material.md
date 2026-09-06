# 3D Studio — Holographic foil material

**Date:** 2026-09-06 · **Status:** building · **Owner session:** 46d3881a

## What it is

An 11th material type, `holographic`: the rainbow-diffraction foil of stickers, laminated
packaging and "chrome holo" nail polish. A bright **metallic base** with a rainbow **streak**
that sweeps across the surface as the light or the camera moves, oriented by a **grating
angle**; a **Flakes** dial breaks the grating into randomly-rotated cells so it turns into
glitter foil.

It is a sibling of `opalescent`, not a mode of it. Opalescent is a thin-film driven by the
surface normal / viewing angle (soap bubble, oil slick). Foil is driven by the **half vector
between the key light and the view** projected onto a surface **grating direction** — a
diffraction grating. Different physics, different look, and the user asked for a new type.

Builds on the shipped opalescent recipe (memory `scene3d-opalescent-material-landed`): same
`MeshPhysicalMaterial` + `onBeforeCompile` injection at `#include <emissivemap_fragment>`, same
ramp LUT (`opalStopsOf` → `buildRampTexture`), same "uniform objects outside the closure" rule.

## Look

- **Base**: `MeshPhysicalMaterial`, `metalness = 1` always (a foil IS metal — no shared
  metalness row, so nothing is a dead control), `roughness = mix(0.55, 0.04, holoGloss)`,
  `color` = base tint (shared field, "Base tint" label like opal), clearcoat /
  clearcoatRoughness / envMapIntensity shared (widen `hasReflectiveCoat`).
- **Rainbow**: in the fragment shader at `emissivemap_fragment`:
  - `L` = `directionalLights[0].direction` when `NUM_DIR_LIGHTS > 0` (the engine's sun is added
    at construction so it is index 0), else `vec3(0,0,1)`; `V = normalize(vViewPosition)`;
    `H = normalize(L + V)`.
  - Tangent frame from the view-space normal: `t0 = normalize(cross(ref, nrm))`,
    `b0 = cross(nrm, t0)` with `ref = up` unless the normal is near-vertical.
    `tang = t0*cos(a) + b0*sin(a)` with `a = radians(holoAngle) + flakeJitter`.
  - `u = dot(tang, H)` — position across the diffraction sweep, −1..1.
  - `s = fract(abs(u) * holoBands + holoHueShift/360)`; `rainbow = texture2D(uRamp, vec2(s, .5))`.
  - Envelope: `env = smoothstep(0.02, 0.12, |u|) * (1 - smoothstep(0.55, 0.95, |u|))` so the
    zero order (plain specular) stays white and the sweep fades at its edges; multiply by
    `pow(clamp(dot(nrm, H), 0, 1), 2.0)` so it lives near the highlight like a real foil.
  - Output: `totalEmissiveRadiance += rainbow * env * holoStrength` (additive — foil rainbow
    is dispersed light, it glows) AND `diffuseColor.rgb = mix(diffuseColor.rgb,
    diffuseColor.rgb * (0.35 + rainbow), env * min(holoStrength, 1) * 0.7)` so the metal's
    reflections take the tint too (metalness 1 → diffuseColor is the specular colour).
- **Flakes**: vertex injection at `#include <worldpos_vertex>` → `vHoloPos = transformed;`
  (object-local so the cells stick to the surface as the object moves). Cell id =
  `floor(vHoloPos / holoFlakeSize)`; `holoHash(cell)` → jitter angle
  `(r - 0.5) * 2π * holoFlakes`. `holoFlakes = 0` → clean linear foil (no jitter);
  `1` → every flake a random grating → glitter. Name the hash `holoHash` (three's `<common>`
  owns `rand`).
- No per-frame cost: nothing time-driven. No tracking `Set`, no `refresh*`.

## Dials (all `Material` group, gated by `isHoloMaterial`; labels/hints sentence case per the
casing rule — NO camelCase or lowercase-only copy in labels/hints)

| key | label | range | default | hint |
|---|---|---|---|---|
| `object.material.holoStrength` | Rainbow strength | 0–2 step 0.01 | 1 | How bright the rainbow streak glows over the metal |
| `object.material.holoBands` | Bands | 0.5–8 step 0.05 | 3 | How many rainbow repeats fit in one sweep — fine foil is high |
| `object.material.holoAngle` | Grating angle | 0–180 step 1 | 0 | Turns the direction the rainbow streak runs in |
| `object.material.holoFlakes` | Flakes | 0–1 step 0.01 | 0 | 0 is a clean foil; higher breaks it into randomly turned glitter flakes |
| `object.material.holoFlakeSize` | Flake size | 0.01–0.5 step 0.005 | 0.08 | Size of each glitter flake |
| `object.material.holoGloss` | Gloss | 0–1 step 0.01 | 0.85 | Polished mirror foil at high, brushed at low |
| `object.material.holoHueShift` | Hue shift | 0–360 step 1 | 0 | Rotates the whole rainbow around the colour wheel |

Plus shared rows, in this body order (`MATERIAL_BODY.holographic`):
`ui.material.opalStops` (Spectrum — reuse the anchor; widen its `visible` to opalescent OR
holographic; the surface's `matOpalStops` already reads `opalStopsOf(material)`, which is
type-agnostic), `object.material.color` (label override "Base tint"), the seven `holo*`
rows above, `object.material.clearcoat`, `object.material.clearcoatRoughness`,
`object.material.envMapIntensity` (label override "Reflection intensity"). NOT roughness /
metalness / texture set (`hasPbrSurface` and `TEXTURE_TYPES` unchanged).

## Seams (the 6-seam recipe)

1. `lib/scene3d/config.ts` — `MaterialType` union + `MATERIAL_TYPES` (append after
   `'opalescent'`), seven `holo*?: number` fields with comments, `MATERIAL_DEFAULTS`,
   `parseMaterial` numeric lines (same `num(...)` shape as the opal ones).
2. `lib/scene3d/materials.ts` — `HOLO_VERT_DECL/HOLO_VERT_BODY/HOLO_FRAG_DECL/HOLO_FRAG_BODY`,
   build case (`customProgramCacheKey = () => 'scene3d-holographic'`,
   `userData.holoUniforms`, `userData.rampSig`), update case (mutate uniform `.value`s,
   rebuild the LUT only on `rampSignature` change), `disposeMaterial` ramp chain gains
   `?? holoUniforms.uRamp.value`. Chain-safe with the screen finish (it wraps `prev`).
3. `lib/scene3d/controls.ts` — `isHoloMaterial`; `hasReflectiveCoat` = physical OR opal OR
   holo; `COLOR_TYPES` + `'holographic'`; seven sliders (`summary` on strength + flakes).
4. `lib/scene3d/panelPresentation.ts` — `MATERIAL_BODY.holographic`; `ui.material.opalStops`
   visible for both; `HOLO_OVERRIDE` (color → "Base tint", envMapIntensity → "Reflection
   intensity", clearcoat hint "Adds a thin glossy laminate on top") applied next to
   `OPAL_OVERRIDE`.
5. `Scene3DStudioSurface.vue` — nothing expected (the `#control-ui.material.opalStops` slot
   and generic `object.material.*` slider handling already cover it); verify by reading.
6. `lib/scene3d/agentControls.ts` — extend the MATERIAL type list; add a HOLOGRAPHIC FOIL
   paragraph; split the GEM/IRIDESCENT recipe so "holographic", "holo foil", "holographic
   sticker", "glitter foil", "chrome holo" → `holographic`, while "iridescent / opal / oil
   slick / soap bubble / rainbow sheen" stay `opalescent`; worked example
   `{"primitive":"sphere","object.material.type":"holographic","object.material.holoFlakes":0.8}`.
   Only the surrounding docstring — another session has uncommitted treatment hunks in this
   file at lines ~6 and ~99–130; do not touch or stage them.

## Tests

- New `tests/unit/scene3d-holographic-config.unit.spec.ts` (mirror the opal config spec:
  type registered, defaults, round-trip, absent stays absent, non-numeric rejected).
- New `tests/unit/scene3d-holographic-controls.unit.spec.ts` (mirror the opal controls spec:
  the seven rows appear only for a holographic object; clearcoat/envMapIntensity offered;
  roughness/metalness NOT offered; `object.material.type` options include it).
- `scene3d-panel-parity.unit.spec.ts` — ROW entries for the seven, `HOLO_ROW` overrides,
  `holographic` block in the per-type `want` table, and generalise the
  `type === 'opalescent' ? OPAL_ROW[key]` lookup to a per-type override map.
- `scene3d-motion-targets.unit.spec.ts` — add the `['holographic', [...COAT, ...RELIEF,
  ...SCREEN, the seven 'material.holo*' paths]]` row (another session has an uncommitted
  treatments describe at ~305+; leave it alone).
- Run the full scene3d suite + `nuxt typecheck` anchored against HEAD.

## Verification owed

Live render check is owed (Browser pane is hidden this session): switch a sphere to
Holographic under the default Look, confirm a rainbow streak near the highlight that moves
when the camera orbits; Flakes → 1 turns it to glitter; Rainbow strength → 0 leaves a clean
metal. Record in memory `scene3d-holographic-foil-landed`.
