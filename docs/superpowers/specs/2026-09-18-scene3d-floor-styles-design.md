# 3D Studio — Floor styles (Off / Shadow only / Reflection / Polished)

Date: 2026-09-18
Status: Design approved, ready for implementation plan

## Goal

Give the 3D Studio floor real looks. Today the floor is one boolean, `doc.showFloor`,
gating a reference grid + a transparent shadow-catcher; Cinematic swaps in a matte
`cinematicFloor`. There has never been a visible or reflective floor surface in the
viewport. This adds a **Floor mode** with four options — Off, Shadow only, Reflection,
Polished — where Reflection (the object's mirror image fading to transparent beneath it)
is the hero look for dropping a 3D object into a Frame layer with a real reflection and no
background.

This is feature 5 of a shortlist of three.js capabilities to leverage; a separate spec
covers the cloth primitive.

## Non-goals (v1)

- **Blurred / glossy reflection** (MeshReflectorMaterial-style roughness blur). Sharp
  fade first; blur is a later add.
- **Grid as its own viewport toggle.** The grid stays coupled to floor mode
  (visible when mode ≠ Off), same as today. Decoupling it is a separate change.
- Any change to the cloth work.

## Data model

Replace `doc.showFloor: boolean` with:

- `doc.floorMode: 'off' | 'shadow' | 'reflection' | 'polished'`
- `doc.floorReflectivity: number` (0–1) — reflection strength; used by Reflection and
  Polished only.
- `doc.floorColor: string` (hex) — used by Polished only.

`config.ts` owns the `SceneDoc` type, the defaults block, and the sanitiser (currently
`showFloor: raw.showFloor !== false` at config.ts:1621).

### Migration (lossless)

The sanitiser reads legacy docs and maps to the new field so old projects render
identically:

- `showFloor === false` → `floorMode: 'off'`
- `showFloor === true` or absent → `floorMode: 'shadow'` (today's default look)
- `floorReflectivity` default `0.6`; `floorColor` default `'#15151a'` (the current
  `cinematicFloor` colour).

New docs default to `floorMode: 'shadow'` so nothing about the out-of-box look changes.
The `showFloor` key is dropped from `SceneDoc`; the sanitiser still reads `raw.showFloor`
for the migration only.

## The four modes — raster viewport

The current floor wiring is three objects on the scene (engine.ts): `grid`
(GridHelper), `shadowGround` (Mesh + ShadowMaterial), `cinematicFloor` (Mesh +
MeshStandardMaterial, cinematic-only). This adds one more: `reflectorFloor`, a
customized three `Reflector` (`three/examples/jsm/objects/Reflector.js`) at y ≈ 0.

Per-mode visibility, applied in `syncFromDoc` (replacing the three lines at
engine.ts:1075–1078):

| Mode        | grid | shadowGround | reflectorFloor | cinematicFloor (raster) |
|-------------|------|--------------|----------------|-------------------------|
| Off         | off  | off          | off            | off                     |
| Shadow only | on   | on           | off            | off                     |
| Reflection  | on*  | on           | on (fade shader) | off                   |
| Polished    | off  | off          | on (polished shader) | off                 |

*Reflection keeps the grid + shadow catcher so contact shadows still ground the object;
the reflection reads over them. Polished hides the grid (it would reflect as clutter) and
the shadow catcher (the glossy surface carries the grounding instead).

### Reflector customization

One `Reflector` instance serves both Reflection and Polished; the mode swaps its
fragment shader (or a single shader branched on a `uMode` uniform):

- **Reflection shader:** sample the mirrored render, multiply by `floorReflectivity`,
  and **fade alpha to 0 with distance** from the object footprint (radial or camera-space
  depth fade) so there is no hard floor edge and no visible surface — just the reflection
  dying out. Output premultiplied alpha so it composites over any background.
- **Polished shader:** sample the mirrored render, mix with `floorColor` base, add a
  Fresnel term so grazing angles brighten; opacity 1. Reflection amount = `floorReflectivity`.

**Self-reflection / feedback guard:** the Reflector renders the scene from the mirrored
camera each frame. It must exclude the reference grid, both ground planes, gizmos, and
treatment shells — reuse the existing helper-hide list already maintained for the path
tracer (the `__scene3dCineHelperCheck` set: `.isShadowMaterial`, `.isLine`, gizmos,
treatment shells). Factor that set into a shared `hiddenFromReflection()` helper so the
Reflector and the tracer stay in sync.

## Cinematic path trace

The path tracer gives true reflections for free, so **no Reflector in Cinematic** — the
enum only tunes the existing `cinematicFloor` material and visibility (the mapping at
engine.ts:1078 and the material built at engine.ts:743):

| Mode        | cinematicFloor |
|-------------|----------------|
| Off         | hidden (today's Off) |
| Shadow only | visible, matte (today's cinematic floor: roughness 0.5, colour `#15151a`) |
| Reflection  | visible, roughness driven low by `floorReflectivity` (1 → ~0.05, 0 → 0.5) |
| Polished    | visible, `floorColor` + low roughness from `floorReflectivity` |

`reflectorFloor.visible` is always false while `_cinematic` is true (the tracer owns the
floor). The moiré fix stays intact: the ShadowMaterial catcher and lines remain excluded
from the BVH; `reflectorFloor` is a Mesh too, so it joins the tracer's hidden-mesh list in
`begin()` / restored in `end()`.

## Transparent export

- **Off / Shadow only** — unchanged (soft shadow alpha from the ShadowMaterial catcher over
  a null background).
- **Reflection** — the reflection's own premultiplied alpha composites cleanly over
  transparent. This is the hero case: a 3D object + real fading reflection, no background,
  straight into a Frame layer.
- **Polished** — opaque surface fills the frame. Surface a one-line hint on the mode
  steering transparent shots toward Reflection.

`renderPasses` already keeps the grid hidden for the beauty bake and renders with the
ground's current visibility (engine.ts comment at 1072–1074). Verify the reflectorFloor is
included in the beauty bake (it must render) but the grid is not (it must not) — extend the
existing bake hide/show logic.

## UI

In the existing **Background** control group where `showFloor` lives today
(controls.ts:838, panelPresentation.ts:618 group list):

- Replace the `showFloor` switch with a `floorMode` **select** (`kind: 'select'`), label
  "Floor". Option labels sentence-case per the UI copy rule (needs `optionLabels`, since
  the stored values are lowercase identifiers): "Off", "Shadow only", "Reflection",
  "Polished".
- `floorReflectivity` slider (0–1), label "Reflection", shown via `showWhen` when
  `floorMode` equals `reflection` or `polished`.
- `floorColor` StudioColor, label "Floor colour", shown via `showWhen` when `floorMode`
  equals `polished`.

Relevance gating uses the existing `showWhen` system. Note the landed constraint: the
gating helper supports `equals` only (see the slice_shift note). `floorReflectivity` must
show for two values (reflection **or** polished), which `equals` can't express.
**Decision: extend the gating predicate with an `in` operator** — small, reusable, and
cleaner than splitting the control in two.

Update `panelPresentation.ts`: the `showFloor` special-cases at lines 245 (value read)
and 726 (hint) become `floorMode` / the new keys; the Background group list at line 618
gains the two new keys.

## Files touched

- `frontend/app/lib/scene3d/config.ts` — SceneDoc type, defaults, sanitiser + migration.
- `frontend/app/lib/scene3d/engine.ts` — `reflectorFloor` object, per-mode visibility in
  `syncFromDoc`, cinematicFloor material mapping, shared `hiddenFromReflection()` helper,
  tracer `begin()`/`end()` hide list, beauty-bake visibility.
- `frontend/app/lib/scene3d/controls.ts` — replace `showFloor` switch with `floorMode`
  select + two gated controls.
- `frontend/app/lib/scene3d/panelPresentation.ts` — group list, value reads, hints.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — the `showFloor` set path
  (lines 1945, 2743) becomes `floorMode` + the new keys.
- `frontend/app/lib/scene3d/` new file for the reflector shader variants
  (e.g. `reflectorFloor.ts`).
- Relevance gating helper — add `in` predicate.
- Tests (below).

## Testing

- **Unit (config):** legacy `showFloor:false` → `floorMode:'off'`; `showFloor:true` and
  absent → `'shadow'`; new fields get defaults; round-trip through the sanitiser is stable.
- **Unit (gating):** the new `in` predicate; `floorReflectivity` visible for reflection +
  polished, hidden for off + shadow; `floorColor` visible only for polished.
- **Unit (engine mapping):** a pure function from `floorMode` → the four visibility flags
  + the cinematic roughness value, tested without a GL context (the engine reads it).
- **Live (Playwright, real visible viewport — hidden pane pauses rAF):** each mode renders
  without console errors; Reflection produces non-zero alpha beneath the object and ~zero
  alpha far away (fade); Polished produces an opaque floor; switching Cinematic on with
  Reflection keeps the tracer's visible-shadow-catcher count at 0 (moiré guard) while the
  cinematicFloor stays visible.
- **Transparent export:** Reflection export has a transparent far field and a visible
  reflection band; Off/Shadow export unchanged from a HEAD baseline.

## Cost

Reflection and Polished add one extra full scene render per frame in the raster viewport,
only while active. Off and Shadow only are byte-identical to today. Cinematic adds nothing
(material-only change).

## Open details (decide during implementation, low risk)

- Fade function for Reflection: radial from object footprint vs camera-space depth. Start
  with camera-space depth fade (simpler, reads well at most angles); revisit if grazing
  angles look wrong.
- Reflector render-target resolution: half-res is usually enough for a fading reflection
  and halves the cost; start half-res, expose nothing.
