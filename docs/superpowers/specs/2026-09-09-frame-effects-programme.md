# Frame effects programme: geometry effects, the missing layer styles, shaders as passes

Date: 2026-09-09
Status: programme design, approved in conversation ("build all that you mentioned"); each slice gets its
own task-level plan when reached.
Builds on: `2026-09-06-frame-layer-effects-tree-design.md` (the ordered effect stack, landed 09-07).

## What this programme is

The Frame now has one place for anything applied to a layer: the effect stack, shown as child rows
under the layer, tuned one at a time. This programme fills that place with three families:

1. **Geometry effects** — transforms of a layer's vector outline BEFORE it is rasterised. New position
   in the pipeline, new class of row, and the reason text needs real outlines.
2. **The missing layer styles** — the pixel effects people expect from Figma and Photoshop that the
   stack does not have yet, plus print-process recipes and backdrop effects.
3. **The shader catalog as a pass** — every Shader Studio effect available on any layer through one
   row kind, which is the biggest set of effects for the least new code.

## Where things sit in the pipeline (settled)

```
background_blur (pinned) → GEOMETRY EFFECTS (new region, orderable, vector layers only)
  → rasterise → dof (pinned, content) → PIXEL PASSES (orderable) → drop_shadow (pinned)
```

Geometry effects only appear on vector-backed layers: rectangle, ellipse, path, library shape,
polygon and star (they already convert to path data), and text once converted to outlines. The add
menu greys them out on images, wired layers and brushes.

## What exists to build on (verified 2026-09-09)

- A layer's outline is one function today: `outlinePathData(layer, W)` returns an SVG `d` string for
  rect/ellipse/path, null for text. Path2D is built and cached from `d`.
- Text is drawn with `fillText`/`strokeText` only; there is no outline anywhere in the Compositor.
  Vector Type extracts real glyph outlines in the browser with fontkit (`lib/vectortype/outline.ts`
  `textOutlines`, pure, importable).
- paper.js is a dependency, used headless and lazily (`import('paper')`) for booleans in Shape Studio
  and path layers. There is no offset, simplify or general resample at the layer level.
- A pure morph engine exists (`lib/vector/morph.ts`: parse, flatten, resample, align, lerp).
- No Voronoi/shatter and no mesh warp beyond the 16-slice projective corner-pin.
- GPU passes on a layer exist twice: DOF via `GpuPost` (own WebGL2 context, readback) and the universal
  post stack `lib/studio/post/chain.ts` `applyPost(source, post, w, h, t)` which already runs Shader
  Studio effects over any canvas. Shader Studio's renderer takes texture + per-pass uniforms.
- Backdrop access is a recipe, not a helper: `applyBackdropBlur` snapshots the stack canvas, draws a
  silhouette ghost, and clips with destination-in; the glass lens fill duplicates it.
- Motion: the Compositor has preset animation plus keyframes on transform and opacity only. Effect
  dials cannot be animated today.
- Adding a pixel effect kind touches four places: a pass function + `PASS_TYPES` + defaults in
  `postEffects.ts`; `EFFECT_ORDER`/`EFFECT_LABELS` in `effectStack.ts`; the row icon and add menu;
  the agent surface's kind validation.

## Slices, in build order

Each slice is one spec-to-plan-to-execution cycle sized like the two features already landed
(six to ten tasks, a review per task, a final review). Later slices depend on earlier ones as noted.

### F1 · Text to outlines
Text layers gain a converted vector form so geometry effects can reach them. `textOutlines` from Vector
Type produces glyph paths for the layer's font, size, letter spacing and alignment; the result is a
path in the layer's local units, cached by the text run and its typography. Rendering stays on
`fillText` until a geometry effect is present (byte-identical otherwise); with one present the
outline path is what gets drawn and effected. Type-on-a-path gets the same treatment by placing
glyph outlines along the guide. Acceptance: with no geometry effect, pixels are unchanged; with a
no-op geometry effect, text renders from outlines within one anti-aliasing step of `fillText`
(measured, not eyeballed); every existing text Playwright case passes.
Depends on: nothing. Enables: F2, F3 on text.

### F2 · The geometry region and its first four effects
The effect stack gains the geometry region (orderable among themselves, pinned as a group between
background blur and rasterise). A pure `applyGeometry(d, effects)` returns the transformed `d`, cached
by input and stack. First four kinds, each borrowing an engine:
- **Trim path** (start %, end %, offset) on the flattened outline — resampler from `morph.ts`.
- **Offset path** (distance, join) — paper.js `PathItem.offset` / stroke-expansion.
- **Round corners** (radius) on any path — paper.js smoothing or arc insertion at vertices.
- **Roughen** (amount, detail, seed) — resample and displace with seeded noise.
Plus, if cheap in the same slice: zig-zag, scallop, simplify. Acceptance: a legacy frame renders
byte-identically (no geometry effects present → the region is skipped); two orders of two effects
render differently (Playwright); each effect on rect, path, library shape and outlined text.
Depends on: the stack (landed); F1 for text.

**Gate decided in F1's review:** once F2 forces the outline on when a geometry effect is
present, a text layer with underline/strikethrough or a distance-band stroke would silently lose
those extras (a full fillText fallback is no longer possible). F2 MUST resolve this — either
`collectTextOutline` returns null for decorated/banded text (the layer keeps fillText and the
geometry effect is skipped, matching how expressive text already fully falls back), or the add
menu greys geometry effects for such layers with a reason. Pick one in F2's task plan.

### F3 · Geometry effects that reference another layer or need new engines
- **Boolean with a sibling layer** (unite, subtract, intersect, exclude) — paper.js; the sibling is
  referenced the way masks reference a layer; the effect greys out when the reference is not a vector
  layer.
- **Morph toward another shape** (amount) — `morph.ts` `prepareBlend`/`blendPath`.
- **Warp** (bulge, pinch, wave, twist; amount, centre) — a mesh warp over a subdivided quad,
  generalising `drawQuadWarp`; applies to the rasterised layer when the outline is not vector, so it
  can also live in the pixel region. Decide per kind in the slice spec.
- **Long shadow / extrude** (angle, length, colour) — fill between the shape and its offset copy.
- **Shatter** (pieces, seed, gap) — Voronoi over the outline's bounds; add `d3-delaunay` (small, MIT)
  or a Bowyer–Watson implementation; pieces render as one path with gaps.
Acceptance: each has a Playwright case asserting a pixel change and a unit test on the path maths.
Depends on: F2.

### F4 · The missing layer styles (pixel passes)
Each is a pass function plus a kind, following the four-place recipe:
outer glow, inner glow, colour overlay (colour + blend), gradient overlay (stops + angle + blend),
stroke from alpha (width, align, colour), directional blur (angle, length), radial and zoom blur
(centre, amount), levels (black, white, gamma), posterise (levels), threshold, invert, rough edge
and ink bleed (edge siblings of torn edge and feather, in the orderable region).
Acceptance: unit test per kernel on a synthetic canvas; one Playwright case per family proving a
pixel change and restore on remove; the document-level post stack unchanged.
Depends on: nothing beyond the stack.

### F5 · Any Shader Studio effect as a layer pass
One kind `shader` with an effect picker (the Shader Studio catalog), whose dials are drawn from the
effect's manifest — the same derived-controls pattern the studios use. Runs through
`lib/studio/post/chain.ts` over the layer's offscreen (a GPU round trip like DOF), with the layer's
alpha preserved and time fed from the frame clock for animated effects. Duplicates allowed (two
shader rows with different effects). Acceptance: three effects from different catalog families
render on a layer and match a Shader Studio render of the same effect on the same pixels within a
tolerance; alpha-only layers keep their edges.
Depends on: the stack; the post chain (exists).

### F6 · Backdrop effects
Extract the backdrop recipe from `applyBackdropBlur` into one helper (snapshot below, silhouette
ghost, clip) and add: **refraction** (index, thickness — displaces the backdrop by the layer's
luminance or normal-from-alpha), **frosted glass** (blur + noise + tint), **backdrop distortion**
(warp field), and a **luminance mask from below** (the layer shows only where the backdrop is
bright/dark). All pinned first with background blur, since they sample the backdrop.
Depends on: nothing beyond the stack.

### F7 · Print processes as recipes
Composite kinds that expand to passes at paint time, with three dials each: **Risograph** (inks, misregistration, grain), **Photocopy** (threshold, blur, grain), **Letterpress** (impression depth,
paper texture, ink spread). A recipe is one row in the tree; expanding it is internal.
Depends on: F4 (threshold, overlay, stroke).

### F8 · Effect dials as motion targets
The Compositor has no id-addressed animatable fields. This slice adds them for effect dials, mirroring
Scene3D's `animatableTargets` (`layers.<id>.effects.<effectId>.<dial>`), so trim path, roughen seed,
warp amount and every pixel dial can be keyed. This is a new motion capability and its own design.
Depends on: F2 for the effects worth animating first.

## Constraints that bind every slice

- A frame with no new effect present renders byte-identically to before the slice. Proven by a
  real-canvas A/B where the change touches the paint path, not assumed.
- Ids stay stable; the stack's read-through and write rules from the landed spec are unchanged.
- UI copy is sentence case, human names, never a stored kind string.
- `CompositorModal.vue` is shared with other sessions: stage own hunks by hunk, never by file.
- One dev server per checkout; never start another for verification.

## Out of scope

Dragging an effect between layers; effects on groups; a new poster/type surface; retiring the old
text-on-path widget (separate debt item).
