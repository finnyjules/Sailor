# Shape Studio — Blend layout (stacked outlines between two shapes)

**Date:** 2026-09-03
**Status:** designed, not built
**Surface:** Shape Studio (`frontend/app/lib/geoshape/*`, `frontend/app/components/vue-canvas/ShapeStudioSurface.vue`)
**Reference:** Carsten Gueth / @die_doing — hundreds of thin outlines stepping from one shape to another, each a slightly different colour, reading as a gradient from afar and as moiré lines up close.

## In plain words

**What is missing.** Shape Studio clones one shape and arranges the copies. It cannot draw the steps *between* two different shapes, it cannot draw outlines only, and its per-copy colours cycle through a short list instead of fading smoothly. Those three things together are the "blend tool" look.

**What changes.** The Layout menu gains a fourth option, **Blend**. Shape A is the existing base shape. A new **Blend to** group describes shape B: its kind, size, rotation, and offset from A. Count becomes the number of steps. Two dials shape the blend: **Spacing** bunches the steps toward one end, **Twist** rotates which point of A maps to which point of B, which is what makes the stacked outlines spiral and moiré. Two colour options work in every layout, not only Blend: **Colour ramp** fades smoothly across the copies, and **Colour applies to** chooses fill, outline, or both. Outline only, thin stroke, colour ramp, high count is the reference look.

**What falls out of it.** Every existing ramp (rotation step, scale start/end, skew) still applies on top of a blend. The layer stack, symmetry, clip masks, PNG, and SVG export all work unchanged because a blend is just a different set of clone shapes handed to the same compositor. A Shape Studio node wired into a Frame shows the blend as a still layer.

**Two phases.** Phase one is everything below in Shape Studio, as stills. Phase two (section 11, approved 2026-09-03) adds a native **Blend layer** to the Frame: pick two shape layers you already placed and blend between them in place, Illustrator-style. Phase one builds the morph and colour-ramp modules as pure, studio-free code so phase two reuses them unchanged.

**What is not in this pass.** Motion. Shape Studio makes stills today, and it will gain motion through the shared moves panel (see `2026-09-03-motion-moves-shared-core-design.md`), where it is the second consumer. Building the old track rows here first would be throwaway work.

**What is risky.** Matching up two different outlines is guesswork when their point counts and start points differ. The rules below (winding fix, best start offset, twist) handle the common cases; odd shapes may fold through themselves, and Twist is the user's escape hatch. A blend in **single** fill mode runs a boolean fold over up to 200 morphed shapes, which is slow; **per-clone** (the default for the reference look) is pure drawing and fast.

## 1. Data model (`lib/geoshape/config.ts`)

All new fields have defaults, so every saved document loads and renders exactly as before. Keys stay flat (control key = config key, pinned by the drift-guard test).

- `GeoLayout` gains `'blend'`; `LAYOUTS` (config.ts and controls.ts) both list it.
- Shape B, read only when `layout === 'blend'`:
  - `blendShape: BaseShapeKind` — default `'polygon'`
  - `blendLibraryShape: string` — default `DEFAULT_LIBRARY_SHAPE`, `isShapeId`-normalised like `libraryShape`
  - `blendSides: number` — 3..24, default 3
  - `blendStarInner: number` — 0.01..0.99, default 0.45
  - `blendIrregularSeed: number` — 1..9999, default 1
  - `blendSize: number` — 20..600, default 180
  - `blendRotate: number` — −180..180 degrees, default 0
  - `blendX: number`, `blendY: number` — −800..800 document units, default 0 (concentric)
  - `blendEase: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'` — default `'linear'`
  - `blendTwist: number` — 0..1, default 0 (fraction of a full turn of the point correspondence)
- Colour, read in every layout:
  - `fillCycle: 'cycle' | 'ramp'` — default `'cycle'` (today's behaviour)
  - `paintTarget: 'fill' | 'outline' | 'both'` — default `'fill'` (today's behaviour)
- `strokeWidth` keeps its range but its control step becomes 0.25 so hairlines are reachable.

`mergeConfig` validates each with the existing `num` / `oneOf` / `clampNum` helpers (`blendSides`, `blendIrregularSeed`, `blendSize` clamped like their A-side twins).

## 2. Placements (`lib/geoshape/arrange.ts`)

`ClonePlacement` gains an optional `blend?: number` — the 0..1 position of this clone between A and B. Only the blend layout sets it.

For `layout === 'blend'` with `count` steps:

- `u = rampT(i, count)` (0 for count 1, as today)
- `t = ease(u)` per `blendEase` — linear; easeIn `u²`; easeOut `1 − (1−u)²`; easeInOut smoothstep
- `x = lerp(0, blendX, t)`, `y = lerp(0, blendY, t)`
- `scale = lerp(scaleStart, scaleEnd, u)`, `rotate = rotateBase + i·rotateStep`, `skew` — unchanged semantics
- `blend = t`

Stagger, radius, spacing, spin, and evenAngle are ignored in this layout.

## 3. The morph (`lib/vector/morph.ts`, new, pure)

Lives beside `lib/vector/svg.ts`, not under `geoshape/`, because the Frame is its second consumer (section 11). Dependency-light like `arrange.ts`: no paper.js, no DOM, no `three`, no studio imports. Input is two SVG `d` strings; output is one `d` string.

- `parsePathD(d)` → subpaths of absolute segments (line, cubic). Accepts `M L H V C S Q T A Z` in absolute and relative forms; arcs convert to cubics (standard endpoint-to-centre parameterisation). Base shapes emit `M L C Q A Z`; library shapes emit `M L C Z`.
- `flattenSubpath(sub)` → closed polyline; each curve splits into a fixed 12 segments (deterministic, no tolerance knob).
- `resample(poly, K)` → `K` points spaced evenly by arc length. `BLEND_SAMPLES = 128`.
- `alignCorrespondence(A, B, twist)`:
  1. If the signed areas of A and B have opposite signs, reverse B (winding fix).
  2. Choose the start offset `s` in `[0, K)` that minimises `Σ |A_i − B_(i+s) mod K|²` (O(K²), ~16k operations per pair, computed once per render).
  3. Add `round(twist · K)` to `s`.
- `blendPath(dA, dB, t, { twist })`:
  - **Exact path.** If A and B have the same command skeleton (same subpath count, same command sequence per subpath), interpolate the numeric arguments directly. Curves stay curves; output stays small. B is rotated by `blendRotate` (about the origin) before comparison and interpolation.
  - **Resampled path.** Otherwise pair subpaths by index after sorting each shape's subpaths by absolute area, largest first; resample each pair to `K` points, align, and interpolate point by point. A subpath with no partner pairs with `K` copies of the other shape's centroid, so it shrinks to a point over the blend. Output is `M x,y L … Z` per subpath, coordinates rounded to 2 decimals.
  - `t = 0` reproduces A's geometry, `t = 1` reproduces B's (within flattening error on the resampled path).

`renderShapes` (render.ts) builds `dA` as today and, in Blend layout, `dB` from the `blend*` fields, then `ds[i] = blendPath(dA, dB, placements[i].blend, { twist })`. `composite(baseD: string | string[], …)` accepts a per-clone array; a string means "same shape for every clone" (today). No other change to `composite`'s three fill strategies.

## 4. Colour (`lib/geoshape/boolean.ts` emit sites, `lib/geoshape/render.ts`)

- **Colour ramp.** Where per-clone and pieces modes hand out `fills[rank % fills.length]`, `fillCycle === 'ramp'` instead takes `rampColour(fills, rank / (N − 1))` (new, in `lib/color/ramp.ts`, shared with phase two): the fills list is treated as evenly spaced stops and the colour is interpolated between the two nearest with `mixHex` from `lib/color/mix.ts` in its default space (OKLab — a straight perceptual line with no hue-wrap decision). Only solid colours interpolate; a gradient or pattern stop is used as-is at its nearest position (no interpolation into or out of it). Single mode ignores `fillCycle` (one fill).
- **Colour applies to.** At every shape emit site:
  - `fill` (today): shape fill = clone paint, stroke = the single `stroke` colour if set.
  - `outline`: shape `fill: null` (SVG `fill="none"`), stroke = the clone's colour (solid; a non-solid clone paint falls back to `solidOf`), `strokeWidth` as set.
  - `both`: fill = clone paint AND stroke = the clone's colour.
  - Single mode: `outline` = the fold outlined in `stroke ?? fill`, no fill; `both` = fill plus stroke in `stroke ?? '#000000'`.
- `drawToCanvas` already skips the fill call when a shape has no `paint` and `fill === null` (`paint ?? fill` is falsy), and `toSvg` already writes `fill="none"` for `null`; a render test pins both so outline mode cannot regress.
- `framePad` already adds `strokeWidth / 2`, so hairline outlines are not clipped.

## 5. Controls (`lib/geoshape/controls.ts`)

- `GEO_SECTIONS` gains `'Blend'` after `'Layout'`.
- Layout select lists `blend`. The existing radial / grid-or-linear gates already hide radius, spacing, evenAngle, angleStep, stagger and spin in Blend layout. `count` shows (it is gated on not-grid).
- New `Blend` group, all gated `isBlend`:
  - `blendShape` select (same options as `shape`), hint says it is the shape the steps run toward
  - `blendLibraryShape` shape picker (`kind: 'shape'`), when `blendShape === 'library'`
  - `blendSides` (when star / irregular / polygon), `blendStarInner` (star), `blendIrregularSeed` (irregular)
  - `blendSize`, `blendRotate`, `blendX`, `blendY`
  - `blendEase` select with option labels Even / Ease in / Ease out / Ease in-out
  - `blendTwist` slider, hint: "Rotates which point of A meets which point of B — small values spiral the outlines"
- Paint group: `fillCycle` select (labels Cycle / Ramp), gated `isMultiFill`; `paintTarget` select (labels Fill / Outline / Both), always shown; `strokeWidth` now shows when `stroke !== null || paintTarget !== 'fill'`.
- The drift-guard test derives expected keys from `DEFAULT_CONFIG`, so every new field must have a control (all do).

## 6. Re-roll (`lib/geoshape/randomize.ts`)

Re-roll may pick `blend` as a layout. A new `blend` roll group (lock key `blend`, like the other `GEO_SECTIONS` names) rolls `blendShape` (and its library id / sides / inner), `blendSize` 80..320, `blendRotate` −45..45, `blendX`/`blendY` −160..160, `blendTwist` 0..0.25, `blendEase` linear. Paint stays curated: `fillCycle` and `paintTarget` are never rolled, matching the existing rule that re-roll never touches the Paint group.

## 7. Agent (`GEO_GUIDANCE`, `geoAgentControls`)

New fields flow into the agent vocabulary through `GEO_CONTROLS`. `GEO_GUIDANCE` gains:

- A BLEND paragraph: layout `blend` draws `count` steps from the base shape to the Blend-to shape; `blendX/Y` offset the target, `blendEase` bunches the steps, `blendTwist` spirals them.
- A recipe: "blend", "stacked outlines", "moiré lines", "die doing", "gradient made of lines" → `layout: 'blend'`, `fillStrategy: 'perClone'`, `paintTarget: 'outline'`, `fillCycle: 'ramp'`, `count` 80–200, `strokeWidth` 0.5–1, two vivid `fills`, `blendTwist` 0.05–0.2, `stroke` unset.
- A worked example with those values.

## 8. Performance

- Per-clone and both-outline: `count` paper `CompoundPath` constructions and transforms, no booleans. 200 outlines of 128 points render in tens of milliseconds.
- Single mode: an even-odd fold over `count` morphed shapes — same cost class as today's single mode at that count, slow above ~60. Unchanged, documented in the Blend group hint.
- Pieces mode keeps `PIECES_MAX_CLONES = 48`.
- SVG size: 200 × 128 points ≈ 350 KB. Acceptable; the exact path keeps same-skeleton blends far smaller.

## 9. Testing (TDD, `tests/unit`)

- `vector-morph`: parse+flatten handles `M L C Q A Z` (a rounded polygon with arcs flattens to a closed polyline whose bounds match `controlPointBounds` within 1%); `resample` returns `K` points with segment lengths within 1% of each other; alignment recovers a known index rotation of B; a reversed copy of A blends to A at `t = 0.5` (winding fix); twist shifts the start offset by `round(twist·K)`; same-skeleton hexagon→hexagon at `t = 0.5` equals the argument-wise midpoint exactly; `t = 0` / `t = 1` reproduce A / B; an unpaired subpath collapses to the partner's centroid.
- `geoshape-arrange`: blend with `count 5`, `blendX 100` gives x = 0, 25, 50, 75, 100; easeIn is monotone and front-loaded; `count 1` yields one placement at `blend 0`.
- `geoshape-render`: blend `count 1` renders the same commands as linear `count 1` (parity with shape A); `paintTarget 'outline'` yields `fill: null` and a stroke on every shape; `fillCycle 'ramp'` with two fills and five clones yields five distinct colours whose ends equal the stops.
- `geoshape-config`: defaults for every new field; junk `blendEase` → linear; `blendSides` clamps.
- `geoshape-controls`: Blend layout shows the Blend group and hides radius/spacing/stagger; `strokeWidth` shows with `paintTarget 'outline'` and `stroke null`; drift guard stays green.
- `geoshape-randomize`: a re-roll landing on blend produces a config `mergeConfig` leaves unchanged.
- Live (Browser pane, dev server): two library shapes, 150 steps, outline, ramp magenta→cyan, twist 0.1, hairline stroke — screenshot and compare feel against the reference; export SVG and confirm `fill="none"` outlines.

## 10. Out of scope

- Motion (shared moves panel, separate spec).
- Chains of more than two key shapes (A→B→C). The layer stack can approximate it today with two blend layers.
- Feature-matching correspondence (corners to corners). Twist plus the best-offset search is the v1 answer.

## 11. Phase two — a native Blend layer in the Frame (approved 2026-09-03, planned after phase one)

**In plain words.** In the Frame editor you select two shape layers you already placed, choose **Blend…**, and a new layer appears that draws the steps between them. The two originals stay where they are and stay editable; move or reshape either one and the steps follow. The blend has the same dials as the studio's Blend group (steps, spacing, twist, colour ramp, colour applies to, stroke width). **Expand** turns it into ordinary path layers when you want to edit the steps by hand.

**Why a second phase.** Phase one proves the look and builds the pure pieces. What phase two adds is a *derived* layer — one whose geometry comes from two other layers — which is a new idea in the Frame's layer model, plus a new layer kind across the roughly fourteen files that switch on layer kinds.

### 11.1 Data model (`composables/useCompositorLayers.ts`)

```ts
export interface BlendLayer extends LayerCommon, StrokeStyleFields {
  kind: 'blend'
  fromId: string          // source layer ids; both must be shape-like (path, rect, ellipse, polygon, star)
  toId: string
  steps: number           // 2..200, steps drawn BETWEEN the sources
  ease: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  twist: number           // 0..1
  fillCycle: 'cycle' | 'ramp'
  paintTarget: 'fill' | 'outline' | 'both'
  fills: Paint[]          // per-step colours, cycled or ramped
}
```

`LocalLayerKind` gains `'blend'`. A blend layer has no transform of its own: `x, y, w, h, rotation` are derived from its steps' union box for hit-testing and selection outlines, and are recomputed whenever a source changes. It is never a boolean operand, never a mask target, and never a repeat-stamp face.

### 11.2 Geometry

At paint time the two sources are read from the live layer list: each shape-like layer becomes an SVG `d` in canvas space through the existing shape→path conversion (the same one node-editing uses), including its transform. `blendPath(dA, dB, t, { twist })` from `lib/vector/morph.ts` gives each step's outline; step colours come from `rampColour` / cycling exactly as in section 4. Sources that are wired image layers, text, or brush strokes are refused with a one-line reason ("Blend needs two shapes").

### 11.3 Rules for a derived layer

- **Deleting a source** deletes the blend too (one undo step restores both).
- **Duplicating the blend** duplicates the link (same two sources). Duplicating a source does not add it to any blend.
- **Grouping / moving a source** is fine: the blend reads the source's effective canvas-space geometry.
- **Expand** replaces the blend with `steps` plain path layers carrying the step colours, in the blend's z-position.
- **Reordering** is allowed; the blend is created just below the upper source.
- Wired layers cannot be sources. A Shape Studio node wired into the Frame remains the route for a blend the studio made.

### 11.4 Where it shows up

- **Creation:** with exactly two shape layers selected, a **Blend…** row in the Shapes ▾ menu and the layer context menu; the agent gets `blendLayers(fromId, toId, steps)`.
- **Inspector:** a Blend section with the dials above and an Expand button; the Fill row becomes the fills list editor from Shape Studio; Stroke rows as today.
- **Painter (`drawLocalLayer`):** one branch drawing the steps; so preview, the Frame card's client bake, thumbnails, and the Timeline's Frame clips all render it with no server change. The plan verifies the ComfyUI Run path composites it through the same painted image the other local layers use.
- **SVG export:** each step emitted as a path with `fill="none"` where outline-only.
- **Motion:** the blend animates as one layer under the Frame's presets and keyframes (it moves as a whole). Per-step stagger is a later idea.
- **Seams to touch** (the switch sites): layer creation helpers, the painter, hit-testing, selection outline, the inspector panel, the inline toolbar (Expand), group resize (a blend is skipped — resize its sources), `lib/agent/surfaces/compositor.ts`, the SVG writer, and the sketch tools (which must ignore it).

### 11.5 Testing

- Unit: creating a blend from two rects yields `steps` outlines whose first and last approach the sources; moving a source changes the blend's derived box; deleting a source removes the blend; Expand yields `steps` path layers with the ramped colours; wired/text sources are refused.
- Painter parity: a Frame with a blend layer painted at two sizes scales cleanly (no per-step drift).
- Live: place a circle and a star, Blend… with 60 steps, outline, ramp; drag the star and watch the steps follow; Expand and edit one step; export SVG.

### 11.6 Out of scope for phase two

Blending more than two layers; per-step motion stagger; blending text outlines (would need glyph-to-path first); a blend as a mask or boolean operand.

