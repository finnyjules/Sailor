# 3D Studio — Lighting panel rethink (light-source modes)

Status: approved by Julien 2026-09-17. Supersedes the piled-up Lighting card.

## Problem

The Lighting card grew ~30 controls across **three systems that write the same values**, with
hidden override rules:

1. **Look + dials** — picking a Look rewrites direction/environment/preset/sun/ambient; the
   Softness/Warmth/Brightness dials *live-recompute* sun intensity + ambient from the Look recipe
   (`resolveDials`). So a manual Sun-intensity/Ambient edit is silently overwritten next time a dial
   or Look changes.
2. **Advanced raw** — the same sun/ambient/preset/environment, editable by hand → fights (1).
3. **HDRI vs Environment** — two separate controls that override each other; the ~15 gel sliders and
   the procedural Environment stay on screen doing nothing while an HDRI is active.

Root cause: **shared values, no single owner, no "I've taken this over" state.**

## Principle

One owner per value; nothing recomputes silently. A Look is a **starting point you stamp**, not a
live parent. HDRI is **not** a sub-option of the Look — it is a **parallel light source** that
replaces the procedural system, because a real studio HDRI already *is* the light (layering a Look's
procedural sun on top is the exact double-owner mess we're removing).

## Model

A **Light source** segmented at the top of the card decides the world; each mode shows ONLY the
controls that own something in it.

### Studio look mode  (`lighting.hdri === null`)
- **Primary (always):** Look picker · Softness · Warmth · Brightness · Light direction · Light
  height · Environment (Room/Dark/Softbox/Studio/Gels — procedural only; HDRIs are NOT in this list).
- **Gels:** the gel controls, only when Environment = Gels (unchanged gate).
- **Fine-tune (collapsed, opt-in):** Shadow preset · Sun intensity · Ambient.
- **Custom detach:** editing any Fine-tune control sets `lighting.custom = true`. While custom:
  the dials **hide** (option A) and `resolveDials`/Look-apply STOP recomputing — the manual values
  stick. Picking a Look, or **Reset to Look**, clears `custom` and re-derives. `lighting.look` always
  keeps the last real recipe id (so "Custom" can name its base, and Reset has a target).

### HDRI mode  (`lighting.hdri !== null`)
The HDRI is the light. Controls (all `when: !!lighting.hdri`):
- **HDRI picker** — the curated studio HDRIs (no "None"; leaving HDRI is the mode segmented).
- **Exposure** (`lighting.hdriExposure`, default 1) → `scene.environmentIntensity`.
- **Rotation** (`lighting.hdriRotation`, default 0°) → `scene.environmentRotation` +
  `scene.backgroundRotation` (spins the studio → moves highlights/reflections on the gem).
- **Reflection softness** — DEFERRED (PMREM already blurs by material roughness; a clean global
  blur needs a pre-blurred equirect / BlurredEnvMapGenerator — a later add, not v1).
No sun, gels, direction, preset, or Look in this mode — none of them own anything here.

### Light source segmented
Synthetic control `lighting.lightSource` (options: "Studio look", "HDRI"):
- read: `lighting.hdri ? 'HDRI' : 'Studio look'`.
- write "HDRI": `lighting.hdri = <remembered last HDRI or DEFAULT_HDRI>`.
- write "Studio look": `lighting.hdri = null`.
Remember the last HDRI in a session ref so toggling back restores the choice.

## Doc fields (config.ts)
- add `lighting.hdriExposure: number` (default 1)
- add `lighting.hdriRotation: number` (default 0)
- add `lighting.custom: boolean` (default false)
(`lighting.hdri` already exists.)

## Engine (engine.ts)
- HDRI mode: `scene.environmentIntensity = lighting.hdriExposure` (was hardcoded 1);
  apply `hdriRotation` to `scene.environmentRotation` + `scene.backgroundRotation` (raster) and pass
  rotation to the tracer env (cinematic — three-gpu-pathtracer reads `scene.backgroundRotation`/env
  rotation on setScene; re-`begin` on change).
- Studio-look mode unchanged.

## Controls / panel (controls.ts, panelPresentation.ts, surface)
- Move Environment out of Advanced into the Studio-look primary zone.
- Re-gate every lighting control by mode (`when` on `lighting.hdri` null-ness) + custom (dials).
- Add `lighting.lightSource` segmented, `lighting.hdriExposure`, `lighting.hdriRotation` controls.
- HDRI picker options drop "None" (mode segmented owns leaving HDRI); when Studio look, hide it.
- Rename the `advanced` toggle to "Fine-tune"; it now gates only preset/sun/ambient.
- Watchers: dial watcher + Look-apply short-circuit when `custom`; Fine-tune edits set `custom`.

## Build slices
1. Fields + parse/defaults + engine exposure/rotation (HDRI mode).
2. Mode split: `lightSource` segmented + `when`-gating (HDRI-only vs Studio-look-only) + Exposure/
   Rotation controls + HDRI picker without None.
3. Custom detach: `custom` flag, dial hide + no-recompute, Fine-tune sets it, Reset to Look.
4. Cleanup: Environment into primary, "Advanced"→"Fine-tune", remove dead HDRI override paths.

## Verify
Unit: config round-trip (new fields), control gating per mode (studio-look controls absent in HDRI
mode and vice-versa), lightSource read/write ↔ hdri. Live (real viewport): mode toggle swaps the
control set; HDRI exposure/rotation move the light; Custom hides dials + stops stomping.
