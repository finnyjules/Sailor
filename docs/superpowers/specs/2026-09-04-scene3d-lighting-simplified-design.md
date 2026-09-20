# Simple lighting for 3D Studio — design

**Date:** 2026-09-04
**Status:** Design. Not yet planned or built.
**One line:** Replace "place lights in 3D space" with "art-direct the light like a photographer," because the 3D scene is a blockout for a generation, not a final render.

---

## Why this exists

Lighting is the hardest part of most 3D programs, and 3D Studio inherits the whole difficulty:

- **You set causes, but judge effects.** Today lighting is a sun you aim with two angle sliders (`sunAzimuth` 0–360, `sunElevation` 5–90), an intensity slider, an ambient slider, a "preset" dropdown, and an "environment" dropdown — six-plus controls in `app/lib/scene3d/config.ts`'s `SceneLighting`, surfaced as sliders in `controls.ts`. You move a light in space and guess what it does to the picture.
- **Numbers with no reference.** `sunIntensity` 0–3 and `ambient` 0–2 mean nothing without a mental model of exposure. Too low reads black, too high blows out, and neither number tells you which way to go.
- **You need the vocabulary to even ask.** Key, fill, rim, ratio, soft vs hard — a beginner doesn't have these words, so the panel can't help them get a look they can already picture.
- **Rigs are hand-built.** A real product look is three lights balanced against each other. Today you add each light object by hand (`createLight`, point/spot/rect) with no notion of a rig, and the "preset" only changes one sun's shadow flag plus environment intensity (`engine.ts` `PRESETS`) — it is not a rig at all.

## The unlock

The 3D scene here is a **blockout that feeds an image model**, not a final frame. The model paints realism afterward. So the lighting only has to carry **direction, softness, contrast, warmth, and where the highlight and shadow fall** — not physically correct photometry. That lets us throw away most of the precision a 3D renderer forces on people and present lighting the way a photographer thinks about it: pick a mood, aim it, adjust a couple of feelings.

Two facts make this cheap to build:

1. **The engine already does image-based lighting.** `buildEnvironmentScene` (`environments.ts`) gives soft, flattering light from a softbox/room/gel world with zero light placement. That is the good-looking default we should lean on.
2. **We can build the simple controls as a resolver over the existing fields.** The engine keeps consuming `sunAzimuth/Elevation/Intensity`, `ambient`, `environment`, and light objects exactly as now. The new controls are a presentation layer that *writes* those fields. The engine and the serialized `scene_state` barely change. This matches Sailor's existing resolver pattern (Space Type state resolvers, "the ControlSpec is the source").

## The new model

Lighting becomes **one Look, three dials, and a direction** — plus auto-exposure so numbers disappear.

### 1. Look — the mood, not the rig

A named photographic look the user picks first — each a recipe, not a single light. The picker is a **browsable library**: **every setup in the library below is selectable**, grouped by family (portrait/beauty, product/commercial, cinematic/mood, natural/time-of-day), with a **Featured** row of the most-reached-for looks surfaced first so a beginner never has to browse the whole set. A search and mood filter sit on top. Think a preset or LUT library, not a four-item dropdown.

Picking a Look sets sensible values for the dials; the user then only nudges. Under the hood every Look resolves — through the pure `resolveLighting` function — to the existing sun/ambient/environment fields, and, for looks that need more than one source, spawns **managed rig light objects** (see Phase 2). "Look" replaces the current `preset` dropdown as the primary control. Angles below are azimuth (around the subject, 0° = behind camera) and elevation (above the horizon); Softness and Warmth are 0–1 (hard↔soft, cool↔warm).

A handful of entries are **additive** (marked **+**): a kicker, a rim, a background sweep, or a gobo doesn't define a whole scene, so selecting one *adds* it to the current Look rather than replacing it. Every other entry is a full Look that resolves the lighting on its own. The full, selectable library is in the section below.

### 2. Three dials, all plain words

After a Look, expose only these, each with live effect and no bare number:

- **Direction** — where the light comes from. Driven by a **direction pad** (a small hemisphere/orb you drag around the subject), not two angle sliders. Writes the existing `sunAzimuth` / `sunElevation`.
- **Softness** — hard sun ↔ big soft box. This is light *size*, the single control that most changes how a shot feels and the one beginners never touch. Maps to shadow penumbra (`sun.shadow.radius`), environment blur/intensity, and rig light size. New field `softness` (0–1).
- **Warmth** — cool ↔ warm. Maps to the sun's color, which today is hardcoded white (`engine.ts`: `new THREE.DirectionalLight(0xffffff, …)`). New field `warmth` (0–1, or a Kelvin range), applied to the sun and rim colors.

Optionally a fourth, **Contrast** (flat ↔ dramatic), which is really the key-to-fill ratio — maps inversely to `ambient` plus environment intensity. Some teams fold this into the Look; expose it if playtests want it.

### 3. Auto-exposure — kill the intensity number

The biggest single source of "why is my render black" is absolute intensity. Add `exposure: 'auto' | number`:

- **Auto (default):** the system normalizes so the subject reads well-lit regardless of the light's raw intensity. The user sets only *relative* brightness through the dials; `sunIntensity` and `ambient` become computed outputs, not inputs.
- **Override:** a single Brightness slider for the person who deliberately wants a darker or brighter frame.

Auto-exposure can be a simple metering pass (sample the rendered subject's luminance, scale sun+ambient to hit a target), run once on change — cheap in a real-time engine.

## Interactions, in order of magic

1. **Direction pad (table stakes).** Drag a dot on a hemisphere to aim the key. Replaces the two angle sliders. The most basic "don't type angles" win.
2. **Drag the highlight on the preview (the delight).** The user drags on the subject itself; the sun re-solves so the specular highlight lands where they pointed. You touch the *result*, not the cause — the thing a traditional 3D program never gives you. Feasible: at the picked surface point the normal is known, so the light direction that puts a highlight there for the current camera is `reflect(viewDir, normal)`; solve azimuth/elevation from that vector. Gate on a lit material.
3. **Light from a reference image (show, don't configure).** Drop a photo whose lighting you like; estimate its dominant light direction, softness, and warmth; set the dials from it. Approximate is fine for a blockout. The product already has a relight-from-a-reference concept, so the idea isn't foreign.

## The prompt bridge

Because the blockout feeds a model, the lighting decision should be said once. The chosen Look plus Warmth resolve to a short lighting phrase ("soft studio softbox lighting, warm") that seeds the generation prompt when the blockout is wired into "Turn into a photo." One decision, applied to both the 3D render and the words, so they agree instead of fighting.

## Data model changes

Additive to `SceneLighting` (`config.ts`). Keep every existing field — the engine and serialization stay as they are; new fields drive them through a resolver.

```
SceneLighting {
  // existing (now mostly derived outputs of the resolver):
  preset, environment, sunAzimuth, sunElevation, sunIntensity, ambient, gel*…

  // new (the simple controls the panel actually shows):
  look:     LightingLook          // 'softbox' | 'hardSun' | 'rim' | 'rembrandt'
                                   //  | 'goldenHour' | 'moody' | 'ecommerce'
  softness: number                // 0..1  (hard ↔ soft)
  warmth:   number                // 0..1  (cool ↔ warm)  → sun/rim color
  contrast?: number               // 0..1  (flat ↔ dramatic), optional
  exposure: 'auto' | number       // auto-exposure, or a brightness override
}
```

A pure `resolveLighting(look, {softness, warmth, contrast, exposure})` function returns the engine-facing values (`sunAzimuth/Elevation/Intensity`, `ambient`, `environment`, plus a new `sunColor` for warmth) and a list of managed rig light objects. Pure and unit-testable with no WebGL, like the other scene3d resolvers. The engine gains exactly one new input it doesn't have today: a sun color (for warmth).

Rig light objects a Look spawns are tagged (e.g. `object.rigOwned = true`, plus which look made them) so re-applying a Look or moving a dial cleanly replaces them instead of piling up, and so the user can still select and hand-tune "Key" / "Rim" / "Fill" after the fact. They auto-name meaningfully ("Key light", "Rim light"), which also feeds the per-object-mask naming idea from the staging discussion.

## Non-goals

- Physically accurate photometric units, IES profiles, or exact area-light soft-shadow sampling. It's a blockout.
- A full node-based or gel-by-gel lighting console. The `colorGels` granular controls can stay as an "advanced" affordance for the rare user who wants them.
- Removing manual light objects. Power users keep the ability to add and place raw lights; the simple model is the default, not a cage.

## Phasing

1. **Phase 1 — the 80%.** Look picker + three dials (Direction pad, Softness, Warmth) + auto-exposure, built as `resolveLighting` writing the existing fields. Add sun color to the engine. Collapse the current six-slider lighting panel into this. Transforms the UX on its own; no rig objects yet (single sun + IBL).
2. **Phase 2 — real rigs.** Looks that need more than one source spawn managed rig light objects (Rim, Rembrandt, Softbox-beauty). Now the Looks are true multi-light setups that stay tunable.
3. **Phase 3 — drag the highlight.** The on-preview highlight-placement interaction.
4. **Phase 4 — light from a reference image.** Estimate direction/softness/warmth from a dropped photo.
5. **Phase 5 — prompt bridge + agent.** The Look/Warmth phrase seeds the generation prompt; add an agent op `applyLightingLook` so "light it like golden hour" works from the copilot (one op, sidestepping the current one-primitive-per-patch limit).

## Open decisions

- **Look set and names.** The seven above are a starting point; the exact list and wording want a pass with real product shots.
- **Contrast as its own dial, or folded into each Look?** Start folded; expose only if playtests reach for it.
- **Warmth units.** A 0–1 feeling versus a Kelvin scale (3200K–6500K). Kelvin is more honest to photographers; 0–1 is friendlier. Lean 0–1 with a Kelvin readout.
- **Auto-exposure target.** What luminance counts as "well-lit," and whether it meters the subject only or the whole frame. Subject-only is more predictable.
- **Environment coupling.** Whether each Look hard-owns an environment kind or lets the user swap the world independently. Lean: Look sets a default world, user may override.

---

## The Look library — all selectable

Every row below is a selectable Look. **★ = Featured** (surfaced first in the picker, the eight most-reached-for). **+ = additive** (adds to the current Look instead of replacing it). Every entry resolves through `resolveLighting` into the same four things the model exposes — a **direction** (key azimuth/elevation), a **softness** (0–1, source size), a **warmth** (0–1, color temperature), and a small **rig** (fill, rim, background) — plus a default **environment** world, so all of them ship without new machinery. The Soft/Warm columns are the default dial values a Look sets; the user nudges from there.

### A. Portrait and beauty
Named by the shadow they make on a face, but they shape any hero subject the same way.

| Look | Best for | Rig — key · fill · rim | Soft | Warm | Env |
|---|---|---|---|---|---|
| Rembrandt ★ | dramatic character | key 45°az / 45°el · weak fill opposite · — | 0.35 | 0.5 | room (dim) |
| Loop | everyday flattering | key 30–45°az, just above · soft fill · — | 0.6 | 0.5 | room |
| Butterfly (Paramount) | glamour, beauty | key front-on, high · reflector below · — | 0.8 | 0.5 | softbox |
| Clamshell | cosmetics, skin | soft key above · soft fill directly below · — | 0.9 | 0.5 | softbox |
| Split | moody, edgy | key 90°az side · little/no fill · — | 0.3 | 0.5 | room (dim) |
| Broad / Short | widen / slim | key on near vs. far side · soft fill · — | 0.55 | 0.5 | room |
| + Rim / hair | separation | — · — · light behind, above | 0.4 | 0.5 | adds |

### B. Product and commercial
The group a sneaker hero shot lives in.

| Look | Best for | Rig — key · fill · rim/bg | Soft | Warm | Env |
|---|---|---|---|---|---|
| Softbox beauty ★ | clean catalog hero | soft key ~35°az / 40°el · high soft fill · — | 0.85 | 0.5 | softbox |
| E-commerce flat ★ | honest, even catalog | two soft keys ~±45°az · high fill · — | 0.9 | 0.5 | room (bright) |
| Rim on dark ★ | premium tech / sneaker | dim front fill · — · two hard rims behind | 0.3 | 0.5 | darkStrips |
| Hard single key ★ | editorial, texture | one hard key ~40°az / 35°el · low fill · — | 0.15 | 0.5 | room (dim) |
| Two-tone gels ★ | modern hype | gel A vs gel B, opposite sides | 0.5 | per-gel | colorGels |
| Three-point | universal base | key 45°az · fill opposite · rim behind | 0.6 | 0.5 | room |
| Light tent / high-key | glossy, reflective goods | wraparound even light · white sweep | 0.95 | 0.5 | softbox (bright) |
| Backlit / contre-jour | translucency (gum soles, mesh) | main light behind · front fill · — | 0.5 | 0.5 | room |
| + Background sweep | premium hero | light on the backdrop → tonal gradient | 0.6 | 0.5 | adds |
| + Kicker | edge / texture pop | low front-side hard skim | 0.2 | 0.5 | adds |
| + Gobo / cucoloris | narrative set | shaped shadow (blinds, leaves) on backdrop | 0.3 | 0.5 | adds |

### C. Cinematic and mood
From film lighting.

| Look | Best for | Rig — key · fill · rim | Soft | Warm | Env |
|---|---|---|---|---|---|
| Motivated single source | naturalism | one dominant "practical" (lamp / window) · — | 0.5 | 0.55 | room (dim) |
| Low-key / noir | tension, premium | hard key · minimal fill · deep blacks | 0.15 | 0.45 | room (dim) |
| High-key | upbeat, clean | bright · near-shadowless · low contrast | 0.95 | 0.5 | softbox (bright) |
| Chiaroscuro | painterly drama | single directional · extreme light-dark · — | 0.25 | 0.5 | room (dim) |
| Silhouette | shape, mystery | bright background · subject unlit | — | 0.5 | bright bg |
| Top light | ominous, sculptural | hard source straight down · — | 0.2 | 0.5 | room (dim) |
| Underlight | unsettling / hero-angle | source from below · — | 0.3 | 0.5 | room (dim) |
| Edge-only on black | logo / tech reveal | rim(s) only · no front | 0.3 | 0.5 | darkStrips |

### D. Natural and time-of-day
Sky and environment as the source.

| Look | Best for | Rig — key · fill · rim | Soft | Warm | Env |
|---|---|---|---|---|---|
| Golden hour ★ | warm cinematic | low warm key ~15°el · cool soft fill · warm back-rim | 0.6 | 0.85 | room |
| Overcast / open shade ★ | flattering, no-fuss | no directional key; all soft IBL | 1.0 | 0.4 | room (bright) |
| Blue hour / twilight | cool, moody | low cool ambient · soft · — | 0.8 | 0.2 | room |
| Hard noon | punchy realism | high hard key · short shadow · — | 0.1 | 0.45 | room |
| Window light | interior natural | soft directional from the side · falloff · — | 0.7 | 0.5 | room |
| Sunset backlight | glow, halation | — · cool front fill · warm rim behind | 0.6 | 0.8 | room |
| Moonlight | night, stylized | cool low single source · deep shadow · — | 0.5 | 0.15 | room (dim) |
| Firelight / candlelight | intimate | very warm low key from below/side · — | 0.6 | 0.95 | room (dim) |

**Featured set (surfaced first):** Rembrandt, Softbox beauty, E-commerce flat, Rim on dark, Hard single key, Two-tone gels, Golden hour, Overcast/open shade. Everything else is one browse or search away. Featured membership can later be driven by usage rather than fixed.
