# Unified Motion Model (Frame) — design

**Date:** 2026-09-17
**Status:** Approved (brainstorm). Programme of 4 phases; Phase 1 first.
**Scope:** the **Frame** compositor's motion (`CompositorModal.vue` + `app/lib/motion/*`). NOT the NLE video timeline (future consumer), NOT the standalone studios (future consumers).

## The problem

Frame has **seven** overlapping animation models with no shared representation (full inventory in the brainstorm). The damage:

- **3–4 incompatible "keyframe" types** — `Keyframe` (frames, absolute), `LayerKeyframe` (seconds, additive), `DialKeyframe` (seconds, num/color/gradient), `AxisKeyframe` (0..1) — different clocks, value semantics, and easing vocabularies.
- **Two authoring surfaces in one Motion tab** — the In/Loop/Out preset gallery *and* the "Animate a dial" keyframe timeline — different paradigms side by side.
- **Two parallel folds over one `tracks` array** (`applyEffectDialTracks` + `applyFillTracks`), split by a string-path technicality.
- **Five timing/progress engines** each re-implementing loop/hold/easing.
- **A layer can be animated four ways at once** with nothing reconciling them.
- Concretely: you add a dial and there's **no way to set its value** (scalar dials have no value editor), so "Fill · Scroll" produces a track that never moves.

## The model (hybrid: behaviours over universal keyframes)

One representation underneath, behaviours as the fast way in, every property keyframable.

### 1. One property space
A single registry answers "what can I animate on this layer?": transform (`x`,`y`,`scale`,`rotation`), `opacity`, every effect dial (`effects.<id>.<dial>`), the fill (solid colour, gradient, gradient `phase`), font axes. Each property declares a **path** (the existing `idPath` scheme), a **type** (`number | color | gradient | …`), a range, and a default. Generalises today's three separate enumerators (`effectDialTargets`, `fillDialTargets`, transforms) into one `animatableProperties(layer)`.

### 2. One keyframe + track
`Track { property: PropertyPath; keyframes: Keyframe[] }`, `Keyframe { t: seconds; value: PropertyValue; ease: Ease }`. **One** keyframe type, one seconds clock, one easing vocabulary. `value` is typed by the property; interpolation is dispatched by a **typed interpolator** registry (number → lerp; colour → OKLab mix; gradient → the crossfade/travel/scroll core already landed in `gradientTween`). Keyframes are **absolute** (the value at that time), not additive deltas.

### 3. One evaluator + timing engine
`evaluate(layer, t)` reads a layer's tracks, interpolates each property at `t` via its typed interpolator, and applies them in a defined order — replacing the four-folds-in-sequence mess. One shared timing engine owns loop / hold / ease / delay (today there are five). Byte-identity preserved when a layer has no active tracks (same-reference return, as the current folds do).

### 4. Behaviours (the fast way in)
A **behaviour** is a parameterised generator: `Behaviour { id; kind; params; timing: { start; duration; loop?; easing } }`. Given a layer it **compiles to ordinary tracks**. Dropping one produces its keyframes immediately (you see the motion at once — the thing that's broken today). Everything is a behaviour — the ~40 existing kinetic presets *and* the gradient modes (Scroll / Crossfade / Travel) collapse into one list, no special cases. Consistent anatomy: which property/properties, a timing window, optional loop, a few params, an easing.

- **Open = bake.** A behaviour is "live" (edit via params) until you **Open** it; then it expands into raw keyframes on the property lanes and the behaviour dissolves into them (params gone, edit anything). No live params-plus-manual-edits hybrid in v1.

### 5. The authoring UI (one surface)
Replaces the preset-gallery-panel + dial-timeline split with a single Motion timeline:

- **Behaviour bands** on a layer's row (drag to retime; each parametric with an **Open** action).
- **Twirl a layer open → property keyframe lanes** (Transform, Opacity, each animated effect/fill/gradient property), After-Effects style.
- **Keyframe value editor** — selecting a keyframe opens a typed editor (number field / colour picker / gradient editor). This is the missing piece today.
- **Gradient keyframes render as swatches**; the lane carries the Crossfade/Travel + OKLab/Hybrid control.
- **Add behaviour → a previewing gallery.** Each tile plays a live preview of the move; grouped **In / Loop / Out / Gradient**; **filtered to what the selected layer supports** (text-only moves like Typewriter/Scramble hidden on a shape; Gradient shown only when the fill is a gradient). Reuses the existing kinetic-preset catalog as behaviour generators — not a new list.

## Scope boundaries

- **Clip / cloner playback** (living-image frame-swap, MoGraph clone phase) are *content playback*, not property animation. They keep working, share the seconds clock, and are **not** part of the keyframe unification. "Animate a property" and "play a clip" are two clean, coexisting concepts.
- **Clean break** (agreed): existing saved animations are not migrated; the model is designed free of legacy shapes.
- **Surface-agnostic core (key constraint).** Phase 1's core is a **standalone motion package with ZERO Frame/compositor coupling** — property paths + tracks + typed interpolators (plug-ins) + evaluator + behaviours. Frame is its first consumer; the studios (retiring `studio/track.ts` + `moves/*`) and the NLE become future consumers of the *same* core. Building it uncoupled is what makes that future cheap.

## The programme (4 phases)

Each phase is shippable and reviewable; the app stays working at every step.

- **Phase 1 — Unified core (headless).** Property registry, `Track`/`Keyframe`, typed interpolators (reusing `gradientTween`), one evaluator, one timing engine — a standalone package, no Frame coupling. The ~40 kinetic presets and the gradient work compile into it. **Rendering parity proven by tests.** No visible UI change; the existing UI drives the new core behind a flag.
- **Phase 2 — Unified timeline UI.** The one Motion surface: behaviour bands + twirl property lanes + the keyframe value editor. Built alongside the old UI; switched on only when complete.
- **Phase 3 — Behaviours + previewing gallery.** Behaviours first-class (compile-to-tracks, Open = bake); the grouped/filtered previewing gallery reusing kinetic presets; Scroll / Morph.
- **Phase 4 — Retire the old models.** Delete the superseded plumbing (separate In/Loop/Out panel, the two parallel folds, the duplicate keyframe types) once everything routes through the core.

## Testing

Pure core (Phase 1) is the backbone: property registry enumeration; typed interpolators (number/colour/gradient — endpoint fidelity, smoothness reuse); one evaluator (byte-identity when idle; correct order); behaviour→track compilation for a representative set of kinetic presets + the gradient behaviours; one timing engine (loop/hold/ease parity with the shapes it replaces). Rendering parity: the new core, driving the existing render, matches the old output for a set of fixtures. UI phases verified in the running app.

## Out of scope (this programme)

- The NLE video-editor timeline (`TimelineEditor`) — future consumer.
- The standalone studios adopting the core — future consumers (the core is built to make it cheap).
- Migration of existing saved animations (clean break).
