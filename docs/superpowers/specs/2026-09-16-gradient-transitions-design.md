# Gradient transitions — design

**Date:** 2026-09-16
**Status:** Approved (brainstorm), ready for implementation plan
**Surfaces:** Frame gradient fills (Gradient Studio layers) · compositor gradient-map effect

## Goal

Animate gradients over time on two surfaces:

1. **Frame gradient fills** — a Gradient Studio layer's colour ramp.
2. **Compositor gradient-map effect** — the luminance→colour recolour applied to layers/images.

Three animation modes, all loopable:

- **Crossfade** — morph from gradient A to gradient B.
- **Travel** — morph A→B with the colour stops physically sliding across space.
- **Scroll** — a single gradient whose colours cycle along it and loop back to themselves.

The design and every interpolation decision below were validated on a live gradient-map on real
images with a throwaway prototype before writing this spec. The measured findings that drove the
decisions are recorded at the end.

## Current state (what exists)

- **Two gradient concepts, no shared type.** Gradient Studio (`app/lib/gradientfx/types.ts` —
  `ColorStop { color; pos }`, `ColorConfig.stops`) and the compositor gradient-map
  (`app/lib/compositor/postEffects.ts` — `GradientMapStop { pos; color }`,
  `GradientMapEffect { stops; contrast; mix }`).
- **Two motion systems.** The shared easing engine `app/lib/studio/track.ts`
  (`TrackTiming { from; to; easing; loops; hold; cycleOffset; delay }`, `trackProgress`) is the
  loop/ping-pong/hold/delay machinery. Gradient Studio binds it in `app/lib/gradientfx/motion.ts`;
  the compositor keyframes effect dials via `app/lib/compositor/effectDials.ts`.
- **Stops are deliberately un-animated today.** Gradient Studio motion tracks target scalar paths
  only; `effectDials.ts` explicitly excludes gradient-map `stops` ("stops excluded (nested)").
  Colour libs `app/lib/color/harmony.ts` (`toStops`) and `app/lib/color/hueWalk.ts` already do
  OKLCH stop generation. This feature closes the "animate the whole ramp" gap.

## The three modes

Each mode resolves, at clip time `t`, to a concrete render input. The two surfaces both consume a
**256-entry colour LUT**, so that is the common resolved form; Travel additionally has a natural
stop-array form.

| Mode | Endpoints | Pairing | Resolves to | Primary surface |
|---|---|---|---|---|
| **Crossfade** | A → B | none | LUT (per-position single blend of A-LUT and B-LUT) | gradient map (and fills) |
| **Travel** | A → B | resample-to-max, pair by index | stops (per-stop colour+position ease) → LUT | Frame fill (spatial) |
| **Scroll** | one gradient | stops evenly on a wheel by order | LUT (wheel sampled at position + phase) | both |

Details:

- **Crossfade.** For each position `u`, `out(u) = blend(sample(A,u), sample(B,u), t)` — a *single*
  blend between fixed endpoints, so it cannot snap and needs no pairing (any stop counts, any
  positions). This is the default for the gradient map.
- **Travel.** Resample the shorter ramp up to `N = max(|A|,|B|)` (appearance-preserving), pair by
  index, and ease each stop's colour and position A→B. The stops physically slide — the intended
  motion for a *spatial* fill. Not used on the map (see findings: sliding stops across the
  luminance axis snaps).
- **Scroll.** Treat the gradient's stops as points spaced **evenly on a wheel by order**, with a
  real blended wrap segment from the last colour back to the first. Sample at `(u + phase)` with
  `phase` sweeping 0→1 over the loop. Seamless by construction (`LUT(0) == LUT(1)`); at `phase =
  k/N` the wheel has advanced exactly `k` stops. Single gradient — the "to" endpoint is unused.

## Colour interpolation

- **Default: OKLab** (rectangular L,a,b). Spatially and temporally smooth, never flips arcs. Cost:
  a true complementary crossing passes through a slightly muted midpoint — acceptable and natural.
- **Option: Hybrid** — OKLab *direction* (no flip) with *chroma re-inflated* to the linear value,
  so complementary midpoints stay vivid. Cost: a small residual spatial seam on near-complementary
  pairs. Exposed as a per-transition override for when punchier midpoints are wanted.
- **Rejected: OKLCH** (polar shortest-arc hue). Vivid but produces a visible hue **seam** because
  adjacent positions can take opposite arcs, and flips over time when interpolating between
  *moving* stops. Kept out of the default path; may remain as an advanced override only if a use
  emerges.

## Architecture

**New pure module `app/lib/color/gradientTween.ts`** (beside `harmony.ts` / `hueWalk.ts`), with no
knowledge of Gradient Studio or the compositor — stop arrays / phase in, resolved output out. This
is the single home for pairing, cycling, and colour-space maths, so both surfaces behave
identically (the codebase has a history of duplicated-twin parity bugs; this avoids another).

Exports (names indicative):

- `blend(space, hexA, hexB, t)` — dispatch over `'oklab' | 'hybrid'` (+ the OKLab/Hybrid impls).
- `sampleRamp(space, stops, u)` — piecewise sample of a static ramp.
- `resampleStops(stops, n)` / `pairStops(from, to)` — Travel pairing.
- `resolveTransition(transition, fromStops, t)` → `{ kind: 'lut', lut } | { kind: 'stops', stops }`:
  - crossfade → `{ lut }` (needs `transition.to`)
  - travel → `{ stops }` (needs `transition.to`)
  - scroll → `{ lut }` (single gradient)
- `buildLUT(space, stops)` — stops → 256 LUT (used by Travel's stop output and by static ramps).

**Shared timing.** `transition.timing` is a `TrackTiming`; `t = trackProgress(timing, clock, dur)`.
Loop, ping-pong, hold-at-ends, delay, cycle-offset all come for free. Scroll pairs naturally with
Loop (it is seamless); Once/Ping-pong still work.

## Data model

```ts
// app/lib/color/gradientTween.ts (or a shared types file it owns)
interface GradientTransition {
  mode: 'crossfade' | 'travel' | 'scroll';
  space: 'oklab' | 'hybrid';        // default 'oklab'
  to?: ColorStop[];                 // required for crossfade & travel; omitted for scroll
  timing: TrackTiming;              // from app/lib/studio/track.ts
  reverse?: boolean;                // scroll direction only (default false)
}
```

Storage:

- **Frame fill.** A `transition?: GradientTransition` on the Gradient Studio layer's colour config
  (`LayerConfig` / `ColorConfig` in `app/lib/gradientfx/types.ts`). Resolved in the renderer at
  clip time; serialized with the config, so preview and bake share one path.
- **Gradient-map effect.** A `transition?: GradientTransition` on `GradientMapEffect`
  (`app/lib/compositor/postEffects.ts`). This is a self-contained transition block, *not* per-stop
  keyframes — `effectDials.ts` stays numbers-and-colours only; its "stops excluded" note stands for
  keyframes, and the transition block is the sanctioned way to animate the ramp.

## Rendering integration

- **Gradient Studio** (`app/lib/gradientfx/renderer.ts`): where a layer's colour LUT is built
  (`uploadRamp`), if the layer has a `transition`, resolve it at time `t` — crossfade/scroll give a
  LUT directly; travel gives stops that feed the existing LUT build. No change to compositing.
- **Compositor gradient-map** (`gradientMapInPlace` + `gradient_map.frag`): today it interpolates
  stops. Add an optional resolved-LUT input; when a `transition` is active, the compositor resolves
  it once per frame via `gradientTween.resolveTransition(...)` and feeds the pass the 256 LUT
  (travel resolves to stops → `buildLUT`). Static (no-transition) behaviour is unchanged.

## Authoring UX (outline)

A shared "Transition" control block used in both the gradient-fill inspector and the gradient-map
effect inspector:

- **Mode** select: Crossfade / Travel / Scroll.
- **To gradient** picker (Crossfade & Travel only).
- **Colour** select: OKLab (default) / Hybrid.
- **Timing**: duration, easing, and Loop / Ping-pong / Once.
- **Direction** toggle (Scroll only).

UI copy follows the house rules: sentence case, no lowercase-start labels/identifiers; any select
over internal values (mode, space) carries `optionLabels`.

## Testing

Pure-core tests (`gradientTween`) are the backbone — the surfaces call the same functions, so the
core is the oracle:

- **Endpoint fidelity.** Crossfade/Travel: resolved output at `t=0` equals A, at `t=1` equals B
  (exact for the un-resampled side).
- **Scroll seamless + stepped.** `LUT(phase=0) == LUT(phase=1)`; `phase=k/N` rotates the wheel by
  exactly `k` stops.
- **Pairing.** `pairStops` resamples the shorter ramp to `max` length; both arrays equal length.
- **Smoothness regression (the important one).** Encode the prototype's two metrics as tests over a
  set of adversarial pairs (including a complementary pair): max per-frame *temporal* Δ and max
  adjacent-position *spatial* Δ in OKLab space. Assert OKLab stays below a smooth threshold
  (~0.02); assert-and-document that OKLCH exceeds it (records why OKLCH is rejected, guards against
  a regression that silently reintroduces it).
- **Integration parity.** Gradient-map resolve at sampled `t` matches the core LUT; renderer
  preview matches bake at sampled `t`. Guard against "parity tests agree on a wrong answer" by also
  asserting one hand-computed known pair against the independent core, not just surface-vs-surface.

## Out of scope (YAGNI)

- More than two endpoints (N-keyframe ramps) — from/to only; Scroll covers cyclic motion.
- Per-stop keyframe animation in the compositor timeline — the transition block replaces the need.
- Nearest-position / smart pairing for Travel — resample-by-index only, unless it proves ugly in
  practice.
- OKLCH as a shipped option — omitted unless a concrete need appears.

## Key findings (prototype rationale)

Measured on a live gradient-map over real images; "smooth" ≈ 0.02 in OKLab Δ, ≥0.1 is a visible
jump. Adversarial pair: Ember (3 stops) → Ocean (5 stops).

- **Position travel snaps on a map.** Sliding stops across the luminance axis makes every pixel at a
  crossed brightness jump segments (worst temporal Δ ≈ 0.25). → Travel is for spatial fills;
  **maps use per-luminance crossfade** (worst temporal Δ ≈ 0.01).
- **Equal stop counts do not fix it.** Forcing 4→4 was *worse* (0.17) than 3→5 (0.10). The jump is
  about near-complementary stop pairs crossing, not counts → crossfade removes the pairing question
  entirely.
- **OKLCH has a spatial hue seam.** Adjacent luminance levels take opposite hue arcs (worst spatial
  Δ ≈ 0.28). OKLab ≈ 0.01, Hybrid ≈ 0.09. → OKLab default, Hybrid vivid option, OKLCH out.
- **Scroll is seamless by construction** when stops sit evenly on the wheel with a real wrap segment
  (`LUT(0) == LUT(1)` verified).
