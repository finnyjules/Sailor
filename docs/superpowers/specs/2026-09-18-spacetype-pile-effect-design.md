# Space Type "Pile" effect — physics-driven falling tokens

Date: 2026-09-18
Status: Design (approved in brainstorming, pending spec review)

## Summary

A new Space Type (Expressive Studio) effect, **Pile**, in which words, letters, and/or
library shapes fall under gravity and settle into a natural-looking heap inside the frame.

Physics is **baked, not live**: a 2D rigid-body simulation runs once (in `buildScene`) when
the content or settings change, records each token's fall-and-settle path, and the per-frame
`update(t01)` simply plays that recorded path back. This keeps the effect deterministic,
scrubbable, and exportable exactly like every other Space Type effect — no physics in the
render loop, no async in the scene build.

The falling bodies are **mixable**: the phrase can enter as word-boxes *or* as individual
letters, and library shapes can rain down alongside them in the same pile.

## Why baked, not live

Space Type's contract is `update(t01, params, root)` — the engine must be able to render any
loop-time `t01 ∈ [0,1]` reproducibly, and clips get baked to frames. A real-time,
mouse-interactive sim would break that (frame `t` would stop being reproducible, and it would
not bake/loop/export cleanly). Baking the trajectory once and sampling it by `t01` gives:

- **Determinism** — same seed + params ⇒ same pile, every render (uses the existing
  `mulberry32` / `hashSeed` from `lib/spacetype/rng.ts`).
- **Free scrubbing** — "the still is wherever you stop" falls straight out of sampling a
  recorded track; there is no live state to be mid-step.
- **Zero per-frame physics cost** — `update` is a table lookup + transform set.

Live grab-and-throw is explicitly **out of scope** (a possible future carve-out, noted below).

## The physics library: Matter.js (offline baker)

Add **matter-js** (`matter-js` + `@types/matter-js`) to `frontend/`.

It is chosen specifically because the sim runs **once, synchronously, offline, in 2D**:

- **Pure JS, synchronous** — drops straight into the synchronous `buildScene` with no WASM
  async-init plumbing. (Rapier 2D is more strongly deterministic across machines but is WASM
  with async init that fights the synchronous scene build; unnecessary here since output bakes
  to frames.)
- **Proven stable box-stacking** with friction and resting contacts — the exact behaviour that
  is painful to hand-roll (naive solvers jitter or explode on resting stacks of rotating
  boxes).
- We build a world, step it to completion, record the trajectory, and **discard the world**.
  Matter is never on the render hot path.

Determinism requirement: Matter must be driven with a **fixed timestep** and all randomness
must come from the seeded RNG (initial positions, rotations, per-token size jitter, shape
choice). No `Math.random`, no wall-clock, no variable `delta`.

## Architecture

One new module `frontend/app/lib/spacetype/effects/pile.ts` plus a token-producer helper.

### Token producer (the one seam)

A small pure function turns params into a flat list of tokens, independent of physics:

```
interface PileToken {
  mesh: THREE.Object3D      // the drawable: word/letter quad, or shape mesh (+ optional box quad)
  halfW: number             // collider half-extents (world units)
  halfH: number
  // shape colliders are box in v1 (circle upgrade is a future note)
}
makePileTokens(three, params, textTexture, rng): PileToken[]
```

Sources, both additive into one list:

- **Text source** (`textAs` = `off | words | letters`):
  - `words` — split the phrase on whitespace; one box per word. Each mesh is a plane sampling
    that word's slice of the shared text texture, optionally on a filled/outlined box quad.
  - `letters` — one body per glyph, using the per-glyph UV ranges already produced by
    `lib/spacetype/charLayout.ts` (each `CharGlyph` gives `u0/u1/aspect`). Each letter is its
    own quad sampled from the shared texture.
- **Shapes source** (`shapeCount > 0`): `shapeCount` bodies drawn from the shape library
  (`~/lib/shapes/catalog`, via `drawShape` / `shapeAspect` as `charLayout.ts` already does),
  sized by `shapeSize` with seeded `sizeVariation`, filled from the shared fill rails.

### buildScene

1. Derive the seed: `mulberry32(hashSeed(text + seed + saltFromRelevantParams))`.
2. `tokens = makePileTokens(...)`.
3. Build a Matter world: a static **floor** and two **side walls** positioned from
   `container` (fraction of frame width), gravity magnitude from `gravity`, restitution from
   `bounciness`. One dynamic body per token (rectangle collider from `halfW/halfH`), placed
   above the frame at seeded x within the container and seeded initial angle, spread by
   `dropSpread`. Stagger drop start times across the fall window so they don't all appear at once.
4. **Step to completion** at a fixed timestep for the fall window, sampling every token's
   `{x, y, angle}` at each output frame into a trajectory table. Continue until motion falls
   below a rest threshold or the fall window ends, then **hold** the final settled pose for the
   remainder of the loop.
5. Add each `token.mesh` under the root; stash `{ tokens, trajectory, frameCount }` on
   `root.userData.pileState` (per-scene state on userData, never a module var — the card
   preview and headless frame source run concurrent engines over the singleton effect).

### update(t01, params, root)

Read `pileState`; map `t01` to a trajectory frame index (with interpolation between samples);
set each `mesh.position`/`mesh.rotation.z`. `liveKeys` covers only camera/transform params
(`scale`, `rotateX/Y/Z`) — every physics/content param triggers a rebuild, so they are NOT
live keys.

## Controls

Groups follow the existing panel section model. **UI copy rule**: sentence case, no internal
identifiers; every select whose options are internal values carries `optionLabels`.

- **Type:** Text, Font, Type size, Type weight, Tracking (shared text controls).
- **Content:**
  - `Text as` — select `off | words | letters`, labels "None / Words / Letters", default Words.
  - `Box style` — select `filled | bare | outline`, labels "Filled box / Just words / Outline",
    default Filled. Applies to word & letter tokens.
  - `Padding`, `Corner radius` — box geometry (shown when Box style ≠ Just words).
- **Shapes:**
  - `Shape count` — slider 0..40, default 0 (0 = no shapes).
  - `Shape` — shape picker (kind `shape`), default a simple shape.
  - `Shape size`, `Size variation` — slider; seeded per-token jitter.
- **Physics:**
  - `Container` — floor/wall width as a fraction of the frame.
  - `Gravity`, `Bounciness`, `Drop spread`.
  - `Settle time` — fraction of the loop spent falling before the pile holds.
  - `Seed` — reshuffles the pile.
- **Color:** `fills` (fillList) — box/shape fills + text colour, shared rails.
- **Transform:** Scale, camera rotate X/Y/Z (shared, applied by the engine).

## Registration & bundling

- Import `pileEffect` and add it to `SPACE_TYPE_EFFECTS` in `effects/index.ts` (keep the
  `/* @__PURE__ */` annotation intact — it is load-bearing for the per-effect embed split).
- Mark Pile **separator-ineligible** in `separator.ts` (add its id to `RAW_WORD_EFFECTS` or the
  equivalent gate) so `withSeparatorControls` does not append tile-separator controls it can't use.
- A new per-effect embed (`public/embed/spacetype-pile.js`) is produced by the existing split;
  the embed-build-output unit test asserts markers per effect — extend it for `pile`.

## Loop behaviour

**Hold-and-cut**: tokens fall over `Settle time`, then the settled pile holds for the rest of
the loop. This means a hard cut at the loop wrap (settled pile → empty), which is correct for a
settled still and a drop-in animation, but is not a seamless loop like the spinning effects.
A future optional "release" mode (pile blasts back out for a seamless fall→hold→release loop)
is noted below, not built.

## Testing

- **Trajectory determinism (primary, byte-reproducible):** unit-test `makePileTokens` +
  the bake — same seed/params ⇒ identical token count and identical trajectory arrays; changing
  the seed changes the settled poses. This is the reproducible core (GPU render is *not*
  byte-reproducible — see the seeded-randomness and GPU-capture notes in memory).
- **Content model:** `textAs=off` + `shapeCount=0` ⇒ zero tokens; `words` vs `letters` produce
  the expected token counts from a known phrase; shapes are additive to text tokens.
- **No-overlap-at-rest sanity:** after settle, dynamic bodies rest above the floor and are not
  interpenetrating beyond a small tolerance.
- **Live visual check:** render via the Space Type harness (`pages/dev/spacetype-harness.vue`) /
  Playwright and confirm a real pile at a mid and settled `t01`. A hidden pane pauses rAF, so a
  headless/foregrounded capture is the reliable oracle (per the scene3d treatment lessons).

## Out of scope / future directions

Deferred, but the reason the dependency pays for itself (all 2D, all reusing this baker):

- **Live interactive** grab-and-throw (needs a Space Type carve-out; won't bake/loop).
- **Release loop** — settle then blast apart for a seamless loop.
- **Circle/polygon colliders** for round shapes so they *roll* into a nicer pile.
- Sibling effects on the same baker: **drop-in/assemble** (tokens settle at real layout
  positions via attractors), **explode/shatter**, **fill-a-shape** (pour tokens into a letter/
  logo outline), **hang/swing/jiggle** (Matter springs & constraints).
- Beyond Space Type: a Frame/compositor pile element or gravity-settled `scatter` poster
  pattern, and **Matter as an offline layout/relaxation solver** (de-overlap packing for Cloner
  Vary / Mosaic / distribute).
