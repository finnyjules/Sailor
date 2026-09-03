# 3D Studio — Screen finish (surface-anchored halftone on any material)

**Date:** 2026-09-03
**Status:** designed, not built
**Surface:** Scene3D Studio (`frontend/app/lib/scene3d/`, schema-drawn inspector, `Scene3DStudioSurface.vue`)
**Reference:** Carsten Gueth / @die_doing — spheres and blobs whose shading is made of dots or lines that wrap the form, denser in shadow, with red/blue fringes at the edges, dissolving into the background between dots.

## In plain words

**What is missing.** The post stack already has Halftone and Dot screen, but they work on the finished picture, so the dots sit flat on the screen and do not wrap the object. There is no way to have dots that follow a sphere's surface and shrink into its shadow.

**What changes.** Every 3D material except glass gains a **Screen** section, off by default. Pattern picks dots, lines, or cross-hatch. The pattern is anchored to the object's own surface coordinates, so dots wrap the form and bunch toward the poles like a printed globe. Dot size follows the lit shading: bright areas get big dots, shadows get small ones. Colour comes from the material underneath, so a gradient or opalescent material shows through as coloured dots. Between the dots the object is transparent by default, so the background shows through, or a chosen colour. **Misregister** offsets the red and blue channels for the print-fringe look.

**What falls out of it.** Every dial is a slider in the shared control schema, so the agent can set them and motion tracks can animate them (animating Angle or Density gives the breathing look). Viewport, still bake, video bake, and thumbnails all get it because it lives in the material.

**What is risky.** Transparent gaps on a lit material need alpha blending, which can misorder overlapping objects. The design keeps depth writes on and uses a small alpha cutoff; the live check covers two overlapping spheres. If it looks wrong, the fallback is hard-edged cutouts (discard), which loses edge smoothing but never misorders.

## 1. Data model (`lib/scene3d/config.ts`)

```ts
export type ScreenPattern = 'none' | 'dots' | 'lines' | 'cross'
export interface ScreenSpec {
  pattern: ScreenPattern
  density: number      // 4..200 cells across one surface span, default 48
  angle: number        // 0..180 degrees, default 45
  contrast: number     // 0.25..4, default 1 — gamma on how fast dots shrink in shadow
  softness: number     // 0..1, default 0.15 — edge blur
  misregister: number  // 0..1, default 0 — red/blue grid offset, in cells
  invert?: boolean     // false: bright = big dot; true: dark = big dot
  gap: 'transparent' | 'colour'   // default 'transparent'
  gapColor?: string    // default '#ffffff', read when gap === 'colour'
  ink: 'lit' | 'colour'           // default 'lit' — dot colour is the lit material colour
  inkColor?: string    // default '#111111', read when ink === 'colour'
}
```

- `SceneMaterial.screen?: ScreenSpec`. Absent = no screen, exactly as before. `MaterialType` and `MATERIAL_TYPES` do not change (the material-count guard test stays as is).
- `MATERIAL_DEFAULTS` gains `screenDensity 48, screenAngle 45, screenContrast 1, screenSoftness 0.15, screenMisregister 0, screenGapColor '#ffffff', screenInkColor '#111111'`.
- `parseMaterial`: copy-when-present like relief; a junk `pattern` degrades to `'none'`, numbers go through `num()` and clamp to their ranges, colours through the existing hex check.

## 2. Material factory (`lib/scene3d/materials.ts`)

One helper, `applyScreen(m, mat)`, runs at the end of `buildMaterial` after `applyRelief` / `applyTextureSet`, for every material type except `glass`, and only when `pattern !== 'none'`.

- **Uniforms** held outside the compile closure in `m.userData.screenUniforms`: `uScrPattern` (0 dots / 1 lines / 2 cross), `uScrDensity`, `uScrAngle` (radians), `uScrContrast`, `uScrSoft`, `uScrMisreg`, `uScrInvert`, `uScrGapMode` (0 transparent / 1 colour), `uScrGapColor`, `uScrInkMode` (0 lit / 1 colour), `uScrInkColor`.
- **Injection chains onto any existing `onBeforeCompile`** (gradient, fresnel, opalescent inject at `color_fragment` / `emissivemap_fragment` / `begin_vertex`): `const prev = m.onBeforeCompile; m.onBeforeCompile = (shader, renderer) => { prev?.call(m, shader, renderer); …inject… }`. Injection points are ones no other material touches:
  - vertex: append `varying vec2 vScrUv;` after `#include <uv_pars_vertex>` and `vScrUv = uv;` after `#include <uv_vertex>`. The `uv` attribute is always declared by three's vertex prefix, so this does not depend on `USE_UV` or on the material having a texture.
  - fragment: declare the varying and helpers after `#include <uv_pars_fragment>`; replace `#include <opaque_fragment>` with the screen body. `outgoingLight` and `diffuseColor.a` exist there in every built-in material (standard, physical, phong, toon, matcap, basic).
- **Shader body** (`SCREEN_FRAG_BODY`):
  - `p = rotate(uScrAngle) · vScrUv · uScrDensity`
  - `lum = pow(clamp(luminance(outgoingLight), 0, 1), uScrContrast)`, flipped when `uScrInvert`
  - coverage per pattern: dots — `r = sqrt(lum) · 0.7071` (dot area proportional to brightness), `cov = 1 − smoothstep(r − soft, r + soft, distance(fract(p) − 0.5))`; lines — half-width `lum · 0.5` around `fract(p.y) − 0.5`; cross — max of the line coverage in x and y. `soft = uScrSoft · 0.25 + fwidth(p) · 0.5` so edges stay anti-aliased at any zoom.
  - misregister: `covR = cov(p + (uScrMisreg·0.35, 0))`, `covG = cov(p)`, `covB = cov(p − (uScrMisreg·0.35, 0))`.
  - ink colour `c = uScrInkMode == 0 ? outgoingLight : uScrInkColor`; per channel `rgb = c · (covR, covG, covB)`.
  - gap transparent: `gl_FragColor = vec4(rgb / max(alpha, 1e-4), alpha · diffuseColor.a)` with `alpha = max(covR, covG, covB)`; gap colour: `gl_FragColor = vec4(mix(uScrGapColor, rgb, (covR, covG, covB)), diffuseColor.a)`.
- **Transparent gaps** set `m.transparent = true`, `m.alphaTest = 0.02`, `m.depthWrite = true`. Colour gaps leave the material opaque.
- **Program cache key**: `customProgramCacheKey` composes — the previous key (or `scene3d-<type>`) plus `|screen`. Pattern kind, gap mode, and ink mode are uniforms, so switching dots→lines or lit→colour ink does not recompile.
- **Identity** (`identityKey`): a `screenKey(mat)` suffix with two boundaries only: screen off↔on, and gap transparent↔colour (it flips `transparent`). Everything else updates in place.
- **`updateMaterial`**: when `m.userData.screenUniforms` exists, write every uniform `.value` from `mat.screen` — a slider drag never rebuilds.
- Nothing to dispose (no textures, no tracking set) and no per-frame feed (no time uniform).

**Geometry without surface coordinates.** The gem hull already gets spherical UVs (`addSphericalUV`). Extruded text and SVG solids carry UVs from `ExtrudeGeometry`. The GLB load path adds the same spherical fallback when a mesh has no `uv` attribute, so no object renders as one giant dot.

## 3. Controls (`lib/scene3d/controls.ts`)

Group `Material`, gated by `screenApplies = isEditableMaterial && type !== 'glass'`; the dials additionally require `pattern !== 'none'`. Keys use the nested path like relief (`object.material.screen.*`).

- `screen.pattern` — select, labels None / Dots / Lines / Cross, hint "Print-style dots that wrap the object and shrink in shadow"
- `screen.density` — slider 4..200 step 1, "How many dots across the surface"
- `screen.angle` — slider 0..180 step 1, "Rotates the dot grid"
- `screen.contrast` — slider 0.25..4 step 0.05, "How fast dots shrink into shadow"
- `screen.softness` — slider 0..1 step 0.01, "Edge blur on each dot"
- `screen.misregister` — slider 0..1 step 0.01, "Offsets red and blue so edges fringe like a misprint"
- `screen.invert` — switch, `agent: false`
- `screen.gap` — select, labels Transparent / Colour, "What shows between the dots"
- `screen.gapColor` — colour, when gap is Colour
- `screen.ink` — select, labels Lit colour / Colour, "Dot colour: the material's own shading, or one ink"
- `screen.inkColor` — colour, when ink is Colour

Sliders are animatable by default, so the motion picker offers angle, density, contrast, softness, misregister. The panel-parity and motion-target allow-list tests (`scene3d-panel-parity`, `scene3d-motion-targets`) gain the new rows. The inspector is schema-drawn, so no bespoke block in `Scene3DStudioSurface.vue`; the plan verifies the Material section shows the group.

## 4. Agent (`lib/scene3d/agentControls.ts`)

A SCREEN paragraph: "halftone", "dot screen", "print dots", "engraved lines", "risograph sphere", "die doing", "dots that wrap the object" → `object.material.screen.pattern = 'dots'`, density 40–80, misregister 0.3–0.6, transparent gaps; pair with a `gradient` material for colour and a flat background colour so the dissolve reads. Contrast with the post-stack `dotScreen`: that one screens the whole picture flat; use `screen` when the dots should follow the form. A worked example: "a pink-to-blue dotted sphere dissolving into magenta" → `primitive sphere`, `object.material.type 'gradient'`, two stops, `screen.pattern 'dots'`, `screen.density 60`, `screen.misregister 0.4`, `background '#ff2d95'`.

## 5. Testing (TDD, `tests/unit` unless noted)

- `scene3d-config`: absent screen stays absent; junk pattern → `'none'`; numbers clamp; colours validate; a doc round-trips byte-identical.
- `scene3d-materials` identity: off→dots changes `identityKey`; dots→lines does not; gap transparent→colour does; density change does not. `updateMaterial` writes the new uniform values in place and returns true.
- Injection (pure string test on a fake shader object): after `applyScreen` on a gradient material, the fragment still contains the gradient body AND the screen body, and no `#include <opaque_fragment>` remains; the vertex declares `vScrUv` once.
- Controls: glass withholds the group; dials hidden when pattern is none; panel-parity and motion-target lists updated; agent controls include the screen keys.
- Input-correlation render (same harness the opalescent material used): density 20 vs 80 differ; angle 0 vs 90 differ; pattern `none` renders byte-identical to the plain material; an unrelated dial (roughness) with pattern none does not change pixels — proving the test can see the effect.
- Live (Browser pane): sphere + gradient material + dots 60 + misregister 0.4 + transparent gaps over a magenta background; screenshot; two overlapping spheres to check ordering; toon and opalescent underneath to confirm the chain composes; a motion track on angle to confirm the breathing look.

## 6. Out of scope

- Screen-space anchoring (the post-stack Dot screen covers it).
- Triplanar projection for meshes with poor UVs beyond the spherical fallback.
- Paper grain or ink texture (post Grain exists).
- A time-drift dial (an Angle track does this).
- Glass. Transmission plus alpha gaps is a rendering rabbit hole; revisit if asked.
