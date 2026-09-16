# Gradient transitions — design

**Date:** 2026-09-16
**Status:** Approved (brainstorm), ready for implementation plan
**Surfaces (compositor / Frame only):** Frame **layer gradient fill** · **gradient-map effect**
**Authoring home:** the compositor **Motion tab** (`CompositorMotionTimeline`) — no inspector-block motion

## Goal

Animate the *colours* of a gradient over time on two Frame/compositor surfaces:

1. **Frame layer gradient fill** — e.g. a rectangle in a Frame whose fill is a gradient; animate
   that fill.
2. **Gradient-map effect** — the luminance→colour recolour applied to a Frame layer; animate its
   colour ramp.

Three animation modes, all loopable:

- **Crossfade** — morph from gradient A to gradient B.
- **Travel** — morph A→B with the colour stops physically sliding across space.
- **Scroll** — a single gradient whose colours cycle along it and loop back to themselves.

All authoring happens on the compositor **Motion tab**, matching its existing keyframe-timeline model
(USER RULE: motion is authored only in motion surfaces, never in an inspector control block). The
design and every interpolation decision below were validated on a live gradient-map over real images
with a throwaway prototype before writing this spec; the measured findings are recorded at the end.

## Non-goals / out of scope

- **Gradient Studio** (the standalone full-screen studio) is **not** a target. It already has its own
  Motion tab with from/to tracks; a "colour ramp" track kind there is a possible *future* follow-up,
  not part of this work.
- More than two endpoints (N-keyframe ramps beyond what the timeline naturally gives) — the timeline
  already supports multiple diamonds, but per-mode interpolation is defined pairwise between adjacent
  gradient keyframes.
- Nearest-position / smart pairing for Travel — resample-by-index only unless it proves ugly.
- OKLCH as a shipped colour-space option — omitted unless a concrete need appears.

## Current state (what exists)

- **Frame layer gradient fill** is authored statically in `app/components/vue-canvas/compositor/
  FillControl.vue` → `GradientEditor.vue` (multi-stop linear/radial, stop handles on a bar). No
  animation today.
- **Gradient-map effect**: `GradientMapEffect { stops; contrast; mix }` in
  `app/lib/compositor/postEffects.ts`; its stops/contrast/mix are edited in
  `PostEffectsControls.vue`. CPU `gradientMapInPlace` + GPU `gradient_map.frag`.
- **Compositor motion is a keyframe timeline.** `app/components/vue-canvas/compositor/
  CompositorMotionTimeline.vue` (transport + ruler + per-layer bands + per-dial keyframe lanes);
  reducers/evaluator in `app/lib/motion/effectTracks.ts` (`EffectDialTrack = { target, keyframes:
  [{ t, v, ease }] }`, scalar `v`). The Motion tab exposes an **"Animate a dial"** picker whose
  targets come from `app/lib/compositor/effectDials.ts`.
- **Colour/stops are deliberately un-animated today.** `effectDials.ts` lists only scalar dials
  (e.g. `gradientMap: [contrast, mix]`) and explicitly excludes stops ("nested"). Colour libs
  `app/lib/color/harmony.ts` (`toStops`) and `hueWalk.ts` already do OKLCH stop generation.

This feature adds two new **animatable targets** (fill gradient, gradient-map stops) and teaches the
timeline to carry **gradient-valued keyframes**, plus a scalar **phase** target for Scroll.

## The three modes

Each mode resolves, at clip time `t`, to a **256-entry colour LUT** — the common render input for
both the fill and the gradient-map pass. (Travel also has a natural stop-array form that builds the
LUT.)

| Mode | Endpoints | Pairing | Resolves to | Timeline representation |
|---|---|---|---|---|
| **Crossfade** | A → B | none | LUT (per-position single blend of A-LUT and B-LUT) | two+ **gradient-valued** keyframes; lane mode = crossfade |
| **Travel** | A → B | resample-to-max, pair by index | stops (per-stop colour+position ease) → LUT | two+ **gradient-valued** keyframes; lane mode = travel |
| **Scroll** | one gradient | stops evenly on a wheel by order | LUT (wheel sampled at position + phase) | one scalar **phase** dial (0→1), looped |

Details:

- **Crossfade.** For each position `u`, `out(u) = blend(sample(A,u), sample(B,u), local)` — a *single*
  blend between fixed endpoints, so it cannot snap and needs no pairing (any stop counts, any
  positions). Default feel for the gradient map.
- **Travel.** Resample the shorter ramp to `N = max(|A|,|B|)` (appearance-preserving), pair by index,
  ease each stop's colour and position. Stops physically slide — the intended motion for a *spatial*
  fill. Not appropriate for the map's luminance axis (see findings: sliding stops snaps).
- **Scroll.** Treat the gradient's stops as points spaced **evenly on a wheel by order**, with a real
  blended wrap segment from the last colour back to the first. Sample at `(u + phase)`; `phase`
  sweeping 0→1 = one full cycle. Seamless (`LUT(0) == LUT(1)`); at `phase = k/N` the wheel advances
  exactly `k` stops. Single gradient — authored as a looping scalar phase dial.

## Colour interpolation

- **Default: OKLab** (rectangular L,a,b). Spatially + temporally smooth, never flips. Cost: a true
  complementary crossing passes through a slightly muted midpoint — acceptable, natural.
- **Option: Hybrid** — OKLab *direction* with *chroma re-inflated* to the linear value; vivid
  complementary midpoints, small residual seam on near-complementary pairs. Per-lane override.
- **Rejected: OKLCH** — visible hue **seam** (adjacent positions take opposite arcs) and temporal
  flips between moving stops.

## Architecture

**New pure module `app/lib/color/gradientTween.ts`** (beside `harmony.ts` / `hueWalk.ts`), with no
knowledge of the compositor — stop arrays / phase in, resolved LUT (or stops) out. Single home for
pairing, cycling, and colour-space maths, so the fill and the effect behave identically. Exports
(indicative):

- `blend(space, hexA, hexB, t)` over `'oklab' | 'hybrid'`.
- `sampleRamp(space, stops, u)`, `buildLUT(space, stops)`.
- `resampleStops(stops, n)`, `pairStops(from, to)` — Travel pairing.
- `crossfadeLUT(space, from, to, t)`, `travelStops(space, from, to, t)`, `scrollLUT(space, stops,
  phase)` — the three resolvers.

**Timeline model (motion-native).** Extend the compositor keyframe system rather than adding a new
authoring surface:

- **Gradient-valued keyframes.** `effectTracks.ts` keyframe value gains a gradient variant
  (`{ stops: ColorStop[] }`) alongside the scalar `v`. A gradient lane carries its **mode**
  (crossfade | travel) and **space** (oklab | hybrid) at the track level; interpolation between two
  adjacent gradient keyframes calls `gradientTween` (crossfade or travel) at the local eased
  progress. Timing/loop/ping-pong come from the timeline as they do for scalar dials.
- **Scroll = a scalar phase dial.** A `…gradientPhase` target (0→1) reuses the existing scalar
  keyframe path entirely; the renderer maps phase through `scrollLUT`. Looping the phase 0→1 gives
  the seamless cycle.

**New animatable targets (`effectDials.ts`).** Two gradient targets and their phase siblings:

- Frame layer gradient **fill**: `fill.gradient` (gradient-valued) + `fill.gradientPhase` (scalar).
- Gradient-map effect: `gradientMap.stops` (gradient-valued) + `gradientMap.phase` (scalar).

(The existing `gradientMap: [contrast, mix]` scalar dials are unchanged; the "stops excluded" note
now means "not a *scalar* dial" — stops are animated as a gradient-valued lane instead.)

## Rendering integration

At each frame, the compositor evaluates its tracks and produces, for any animated gradient target, a
resolved **256 LUT** at time `t` via `gradientTween`:

- **Frame layer gradient fill** (`FillControl`/`GradientEditor` render path): when the layer's
  `fill.gradient` (or `fill.gradientPhase`) is animated, the fill is drawn from the resolved LUT for
  that frame instead of the static stops. Static fills are unchanged.
- **Gradient-map effect** (`gradientMapInPlace` + `gradient_map.frag`): today it interpolates static
  stops. Add an optional resolved-LUT input; when `gradientMap.stops`/`.phase` is animated, feed the
  pass the per-frame LUT. Contrast/mix keyframes keep working alongside.

## Authoring UX (all on the compositor Motion tab)

Flow for animating a rectangle's gradient fill (gradient-map is identical, different target):

1. Select the layer, open the **Motion** tab.
2. In **"Animate a dial"**, pick the new **"Fill gradient"** target (or "Gradient map · Ramp"). This
   adds a **lane** seeded with one keyframe holding the layer's current gradient.
3. Add a second keyframe at another time; **select it and edit its gradient** — the existing
   `GradientEditor` is reused as the selected-keyframe value editor (still on the Motion tab, so
   editing stays in the motion surface). The lane crossfades/travels between the two gradients.
4. The lane carries a **Mode** (Crossfade / Travel) and **Colour** (OKLab / Hybrid) setting.
5. For **Scroll**, instead pick the **"Fill gradient · Phase"** dial and loop it 0→1 — a normal
   scalar dial lane; the fill cycles seamlessly.

Loop / ping-pong / duration come from the timeline transport, same as any dial. UI copy follows house
rules (sentence case; selects over internal values carry `optionLabels`).

## Testing

Pure-core tests (`gradientTween`) are the oracle — both render paths call the same functions:

- **Endpoint fidelity.** Crossfade/Travel resolved output at local 0 == A, at 1 == B (exact for the
  un-resampled side).
- **Scroll seamless + stepped.** `LUT(phase 0) == LUT(phase 1)`; `phase = k/N` rotates the wheel by
  exactly `k` stops.
- **Pairing.** `pairStops` resamples the shorter ramp to `max` length; both arrays equal length.
- **Smoothness regression (the important one).** Encode the prototype's two metrics as tests over
  adversarial pairs (including a complementary pair): max per-frame *temporal* Δ and max
  adjacent-position *spatial* Δ in OKLab space. Assert OKLab < ~0.02; assert-and-document that OKLCH
  exceeds it (guards against silently reintroducing OKLCH).
- **Timeline integration.** A gradient-valued lane with keyframes A@t0, B@t1 resolves at the midpoint
  to the same LUT as `gradientTween` called directly (guard against "parity agrees on a wrong answer"
  by also checking one hand-computed known pair against the core).

## Key findings (prototype rationale)

Measured on a live gradient-map over real images; "smooth" ≈ 0.02 in OKLab Δ, ≥0.1 is a visible jump.
Adversarial pair: Ember (3 stops) → Ocean (5 stops).

- **Position travel snaps on a map.** Sliding stops across the luminance axis makes every pixel at a
  crossed brightness jump segments (worst temporal Δ ≈ 0.25). → Travel is for spatial fills; **maps
  use per-luminance crossfade** (worst temporal Δ ≈ 0.01).
- **Equal stop counts do not fix it.** Forcing 4→4 was *worse* (0.17) than 3→5 (0.10). The jump is
  about near-complementary pairs crossing, not counts → crossfade removes the pairing question.
- **OKLCH has a spatial hue seam.** Adjacent luminance levels take opposite hue arcs (worst spatial
  Δ ≈ 0.28). OKLab ≈ 0.01, Hybrid ≈ 0.09. → OKLab default, Hybrid vivid option, OKLCH out.
- **Scroll is seamless by construction** when stops sit evenly on the wheel with a real wrap segment
  (`LUT(0) == LUT(1)` verified).
