# Frame Effects Programme — Plan of Slices

> **For agentic workers:** this is a PROGRAMME plan: it fixes the order, the interfaces between
> slices and each slice's tasks and acceptance. Each slice gets its own task-level plan (complete
> code, TDD steps, exact anchors) written when it is reached, executed with
> superpowers:subagent-driven-development exactly as the two landed features were.

**Goal:** Fill the Frame's per-layer effect stack with geometry effects, the missing layer styles,
backdrop effects, print recipes and the Shader Studio catalog, and make effect dials animatable.

**Spec:** `docs/superpowers/specs/2026-09-09-frame-effects-programme.md`.

**Global constraints (bind every slice):** a frame with none of a slice's new effects present renders
byte-identically (real-canvas A/B whenever the paint path changes); the stack's id/read-through/write
rules are unchanged; UI copy sentence case, human names; `CompositorModal.vue` staged by hunk
(`git diff` → `git apply --cached`), never by file; one dev server per checkout; commits end with
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Slice F1 · Text to outlines  (≈6 tasks) — ✅ LANDED 2026-09-09 (with F2; see memory frame-effects-programme)

**Interfaces produced**
- `lib/compositor/textOutline.ts`: `textLayerOutline(layer: TextLayer, W: number): { d: string; bbox } | null`
  — glyph outlines via Vector Type's `textOutlines`, positioned by the layer's font, size, letter
  spacing, alignment and box; local units, centred like path layers; cached by a typography key.
- `outlinePathData(layer, W)` returns the outline for text when `needsOutline(layer)` (a geometry
  effect is present or `layer.renderAsOutline` is set); otherwise null as today.
- Type-on-a-path: `placeGlyphs` gains an outline mode that returns per-glyph transformed paths.

**Tasks**
1. Font access: resolve the Compositor text layer's font (family, weight, style, Google/library cut)
   to a fontkit font through Vector Type's `font.ts` loader; unit test on two bundled fonts.
2. `textLayerOutline`: layout glyphs (advances from fontkit metrics, kerning via GPOS as Vector Type
   does), apply alignment and letter spacing, emit one `d`; unit test compares advances with
   `measureText` within 1 px at 48 px.
3. Draw path: when `needsOutline`, `drawLayerContent` fills/strokes the outline path instead of
   `fillText`; parity test — outlined vs `fillText` differ by at most one anti-aliasing step (measure
   the per-pixel delta histogram, assert ≥ 99% of pixels within Δ2).
4. Type-on-a-path outline mode; parity test at three guide kinds.
5. Byte-identity guard: Playwright — a frame with text and NO geometry effect renders the same before
   and after (`__compositorSetLayers` seeds, data URLs equal).
6. Font fallback and failure: missing font → `fillText` path with a console-free fallback; unit test.

**Acceptance:** tasks 3, 5 and 6 green; every existing text Playwright spec passes unchanged.

## Slice F2 · Geometry region + trim, offset, round corners, roughen  (≈9 tasks) — ✅ LANDED 2026-09-09 (base 56fa11cad → HEAD bcc7cab16; whole-slice review Approved-with-minors; see `2026-09-09-frame-effects-F2-geometry-region.md` and memory `frame-effects-programme`)

**Interfaces produced**
- `lib/compositor/geometryEffects.ts`: `GEOMETRY_KINDS`, `isGeometryKind`, `applyGeometry(d: string,
  effects: EffectInstance[], ctx: { W: number }): string` (pure, cached by `d` + JSON(effects)).
- `effectStack.ts`: `EFFECT_ORDER` gains the geometry kinds between `background_blur` and `dof`;
  `regionOf(kind): 'backdrop' | 'geometry' | 'content' | 'pixel' | 'stamp'`; `canReorder` refuses
  cross-region moves; `addEffect` places a geometry kind at the end of the geometry region.
- `paintLayer`: `outlinePathData` → `applyGeometry` → Path2D when any geometry effect is present.
- Add menu: geometry kinds disabled (with a title) on image, wired and brush layers.

**Tasks**
1. Region model in `effectStack.ts` + tests (order, cross-region reorder refused, add placement).
2. Path toolkit `lib/vector/pathOps.ts`: `flatten(d, tolerance)`, `resampleByLength(points, step)`,
   `toPathD(points, closed)`; reuse `morph.ts` internals where they exist; unit tests.
3. Trim path (start, end, offset; open result); unit test on a square's perimeter.
4. Offset path via paper.js (distance, join: round|miter|bevel); lazy `import('paper')` pattern from
   `geoshape/boolean.ts`; unit test on a rect (bounds grow by 2·distance).
5. Round corners (radius) — arc insertion at polyline vertices or paper.js smoothing; unit test.
6. Roughen (amount, detail, seed) — seeded per-point displacement; determinism test.
7. Wire `applyGeometry` into `paintLayer` + the silhouette cache key; byte-identity A/B for a frame
   without geometry effects (in-place old-module method from Task 3 of the stack plan).
8. Tree/inspector: region captions in the row list ("Geometry" / "Pixels"), disabled menu entries,
   dials via `treatmentControls`-style declarations; Playwright: add trim to a rect, two orders differ.
9. Agent surface accepts the new kinds; hint lists them.

**Acceptance:** byte-identity A/B 0 px; Playwright order test; each kind proven on rect, path,
library shape and outlined text.

## Slice F3 · Boolean, morph, warp, long shadow, shatter  (≈8 tasks) — ✅ LANDED 2026-09-10 (memory frame-effects-f3-landed)
1. Sibling reference plumbing (`refLayerId`) with the mask reference's lifecycle (delete/duplicate).
2. Boolean (unite|subtract|intersect|exclude) via paper.js; unit + Playwright.
3. Morph toward sibling (amount) via `prepareBlend`/`blendPath`.
4. Mesh warp engine `lib/compositor/meshWarp.ts` (N×N grid, bilinear) generalising `drawQuadWarp`;
   bulge, pinch, wave, twist as displacement fields; applies to outline points for vector layers and
   to pixels for raster layers (kind lives in the pixel region for raster).
5. Long shadow / extrude (angle, length, colour): geometry union of shape and offset copy, filled first.
6. Shatter: add `d3-delaunay` (MIT) or implement Bowyer–Watson; Voronoi cells clipped to the outline
   (paper.js intersect), gap dial, seed.
7. Playwright per kind; 8. agent + copy.

## Slice F4 · Missing layer styles  (≈8 tasks) — ✅ LANDED 2026-09-11 (memory frame-effects-f4-landed)
One task per family, each = pass fn + `PASS_TYPES` + defaults + kind + label + icon + agent + tests:
1. Outer glow, inner glow. 2. Colour overlay, gradient overlay (blend mode). 3. Stroke from alpha
(width, align, colour). 4. Directional, radial, zoom blur. 5. Levels, posterise, threshold, invert.
6. Rough edge, ink bleed (edge kinds). 7. Playwright per family. 8. Copy sweep + agent hint.

## Slice F5 · Shader catalog as a layer pass  (≈6 tasks) — ✅ LANDED 2026-09-14 (base 8afbb079a → bc7482d20; whole-slice review Ready-to-merge, live gate 10/10; agent PICKER-ONLY pending the hint-ceiling decision; see 2026-09-09-frame-effects-F5-shader-pass.md + memory frame-effects-f5-landed)
1. `shader` kind with `effectId` + `params` (manifest-derived controls, the studios' derived-inspector
   pattern). 2. GPU pass over the layer offscreen through `lib/studio/post/chain.ts` (`applyPost`
   with a single-pass settings object), alpha preserved, frame clock for time. 3. Effect picker in the
   effect inspector (reuse Shader Studio's picker). 4. Duplicates allowed; performance guard (cap or
   resolution step when animating, as the modal already does). 5. Parity test vs Shader Studio on
   the same pixels. 6. Agent + copy.

## Slice F6 · Backdrop effects  (4 tasks) — ✅ LANDED 2026-09-14 (base 3fe58bf59 → HEAD 0b92907d1; live F6 backdrop gate 10/10; whole-slice units 1034/1034; inspector + add-menu verified in-browser; see 2026-09-09-frame-effects-F6-backdrop-effects.md + memory frame-effects-f6-landed)
Scope chosen by user over the literal four kinds (refraction/frost/distortion overlap the glass lens
+ background_blur): 1. Extract `withBackdrop` from `applyBackdropBlur` (glass lens left as-is —
follow-up). 2. `backdrop_shader` — any input-sampling catalog effect over the layers behind,
additively, any layer incl text. 3. `backdrop_luminance_mask` — mask own content by backdrop
brightness (wraps own paint, not additive-under). 4. Inspector UI (F5 picker shared for the shader;
threshold/softness/invert for the mask) + animation hook + agent-reject + coexistence proofs. All
pinned in the backdrop region. Agent PICKER-ONLY (pending the hint-ceiling decision, as F5).
Follow-ups owed: refactor the glass lens onto withBackdrop; agent vocab (hint-ceiling); a
shape-following backdrop_shader variant.

## Slice F7 · Print recipes  (4 tasks) — ✅ LANDED 2026-09-15 (base 0b92907d1 → HEAD c29607cdd; live gate 6/6, whole-slice units 1116/1116, inspectors + add-menu verified in-browser; see 2026-09-09-frame-effects-F7-print-recipes.md + memory frame-effects-f7-landed)
Recipe kinds = orderable PIXEL effect kinds whose pure `expandRecipe()` → PostEffect[] runs the
EXISTING postEffects passes via applyPasses in the bodyPasses loop (no new render machinery, no new
GLSL, byte-identical when absent): 1. Risograph (contrast→posterise→gradientMap ink ramp→grain).
2. Photocopy (contrast→threshold→rough_edge+grain). 3. Letterpress (dark inner_glow deboss +
desaturate + grain; DROPPED the unused `angle` — directional emboss deferred). 4. Inspectors +
agent-reject (picker/UI-only, hint ceiling full). Follow-ups owed: directional emboss primitive
(re-adds letterpress angle); agent recipe vocab (hint-ceiling decision); by-eye ink palettes.

## Slice F8 · Effect dials as motion targets  (7 tasks) — ✅ LANDED 2026-09-15 (base c29607cdd → HEAD 1fa2af1d3; live gate 9/9, whole-slice units 1107, full Motion-tab UX by-eye verified; see 2026-09-09-frame-effects-F8-motion-targets.md + memory frame-effects-f8-landed)
Any numeric OR colour effect dial is keyframable via `layers.<id>.effects.<effectId>.<dial>` — resolved
by the existing nested `resolveIdPath` (effects are id-stamped), evaluated by a pure `applyEffectDialTracks`
fold at the ONE `paintLayerStack` choke point (byte-identical when absent; runs in preview AND bake).
Design (Julien): bespoke multi-keyframe tracks; numbers + colours; authoring in the Motion tab (a dial
picker + per-dial timeline keyframe rows), the inspector showing a variable-signal on driven dials. Agent
UI-only (ceiling full) — the tripwire test flips when the approved cap slice lands. Follow-ups: extend
per-dial inspector lock to shader/backdrop/recipe blocks; edit-at-playhead; enum/bool dials.

## 🎉 Frame Effects Programme COMPLETE — F1–F8 all landed (2026-09-09 → 2026-09-15).
## ✅ Cap slice (agent vocab) LANDED 2026-09-15 (base 1fa2af1d3 → HEAD 5ec450d0d; see
2026-09-09-frame-effects-Fcap-agent-vocab.md + memory fcap-agent-vocab-landed). Raised
`COMPOSITOR_HINT_CEILING` 26250→27700 and taught the compositor agent the deferred vocabulary in one pass:
F7 recipes + F6 backdrop_luminance_mask (schema-driven sanitizer), F5 shader + F6 backdrop_shader (curated
named looks, effectReadsInput-pinned), and F8 dial-animation (the new `animateDial` op). All four
"agent picker/UI-only" deferrals are flipped — the agent now drives the whole effect vocabulary by words.
Owed: a paid/live agent smoke (CI only mocks the model). So the Frame Effects Programme + its agent surface
are both complete.

---

**Recommended interleave with the 3D programme:** F1 → F2 → S1 → F4 → S3 → F5 → S4 → F3 → S2 →
F6 → S5 → F7 → S6 → S7 → F8 → S8. Capability first, decongestion last.
