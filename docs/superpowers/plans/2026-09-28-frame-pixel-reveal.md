# Frame Pixel reveal transition — design + plan (2026-09-28)

**Asked for:** Julien, 2026-09-27/28 — "i'd like to build it as a motion effect" (reference:
pixel-text-reveal.vercel.app), "i'd do any layer yes", then on the prototype: "this is awesome.
please implement".

**Approved look:** the prototype at `docs/superpowers/specs/assets/2026-09-28-pixel-reveal-prototype.html`
(published https://claude.ai/artifact/VvARdeWF5EKCTRahkybi7t). It is the REFERENCE for every
number and for the fragment shader's behaviour. Read it before any task. It is our own code; the
reference site ships without a licence, so nothing may be pasted from the site — only from the
prototype.

## What it is, in plain words

A new Motion-tab transition, **Pixel reveal**, in the same family as Dither and Settle. The layer
starts as big blocks, each filled with the exact average colour of the layer under it. Blocks
split into four as they "live", a set number of times, then the layer turns sharp. When each
block goes is decided by a direction mixed with a pattern (random, clusters, scanlines, rain,
typewriter, zigzag, cascade, ordered dither, flow). Fresh blocks can arrive in a hot colour and
cool into the layer's own colour. It works on ANY layer; on a text layer it can run per word,
per letter or per line, and pieces can rise out of their line.

Nine looks ship as gallery tiles, In and Out each (18 tiles): Materialize, Signal, Typewriter,
Dissolve, Rain, Radiate, Bitmap, Glitch, Flow. Their numbers are the prototype's `PRESETS`.

## Decisions

1. **One new behaviour kind `pixelreveal`** on the existing `reveal` track (0→1 In, 1→0 Out,
   LINEAR, exactly like `settle`, `behaviour.ts`). The look lives on the bar's params and is read
   through ONE reader, `pixelRevealParams(params)`.
2. **Stored params** (what the bar keeps; everything optional, the look fills the rest):
   `{ dir: 'in'|'out', look: <one of the 9 ids>, pieces?: 'words'|'letters'|'lines'|'whole',
   pattern?, direction?, pixel?: number (frame px at 1080 wide — see 6), levels?: 0..5,
   spread?: 0.05..1, heat?: string|null }` — `heat` absent = the look's own colour(s);
   `null` = no heat; a hex = that colour (a look with two colours, Glitch, keeps its second).
3. **Timing inside the bar.** A look's own timing (stagger, duration, revealDelay, rise,
   riseDuration, eases, sweep) is kept as SHAPE, and scaled so the whole transition fills the
   bar: `local = amount × lookTotal(nPieces)`, where `lookTotal` is the prototype's `timeline()`
   total. So a 0.8 s bar and a 3 s bar play the same choreography at different speeds. Out plays
   the same choreography backwards (amount runs 1→0).
4. **Pieces.** Images, shapes and every non-text layer: one piece, the whole layer. Text: pieces
   are the text's own cells (`textMotionCells`) grouped by `groupCells` (words/letters/lines);
   each piece's box is its cells' ADVANCE box (non-overlapping) extended to its line's band.
   Pieces fall back to ONE whole piece when: the layer is rotated (|rotation| > 0.01), text is on
   a path, `textMotionCells` returns null (system font, loading font, runs, expressive), or
   `pieces: 'whole'`. The fallback is silent and correct (the whole layer still reveals).
5. **Rendering: our own small WebGL2 program.** The shared shader renderer has no mipmaps and a
   fixed pass model, so the painter owns ONE lazily created WebGL2 context (module singleton,
   `GpuPost` in `lib/compositor/gpuPost.ts` is the template for setup / `available()` /
   context-loss tolerance). Flow per frame: `soloPass` draws the layer alone on a frame-sized
   device canvas → each piece's box is copied (clipped) from the solo canvas into a grid-aligned
   slot of a power-of-two atlas → `texImage2D` (premultiplied) + `generateMipmap` → one draw per
   piece with the prototype's vertex/fragment shaders → the GL canvas is `drawImage`d onto a 2D
   scratch (NEVER `getContext('2d')` on a GL canvas) → stamped with the layer's opacity and blend
   exactly like `paintSettle.ts` does.
6. **Pixel size is resolution-independent.** Stored `pixel` is in frame px as if the frame were
   1080 px wide; at paint time `targetDevicePx = pixel × (fw / 1080)` goes to `pickGrid`
   (prototype), so an export at 4K and the editor at 900 px show the same block count.
7. **End state is exact.** The fold already returns the unchanged layer at amount ≥ 1, so the
   painter never draws the finished frame; at amount 0 (In) the layer is skipped.
8. **No catalogue wait.** The program compiles synchronously; `revealShaderReady` answers true
   for `pixelreveal` when WebGL2 is available. With no WebGL2 the painter returns `false` and the
   compositor falls back to the Dissolve mask (the existing non-settle fallback).
9. **Agent:** none this slice (Settle has none either). **Motion dials:** none.

## Files

- NEW `frontend/app/lib/motionx/reveal/pixelReveal.ts` — DOM-free: looks table, reader, grid
  pick, piece order, the scaled timeline, CPU mirrors of the when-field and level thresholds
  (for tests and the tile preview).
- NEW `frontend/app/lib/motionx/reveal/paintPixelReveal.ts` — the WebGL2 painter.
- NEW `frontend/app/components/vue-canvas/compositor/MotionPixelRevealPreview.vue` — 48×30 tile.
- EDIT `behaviour.ts`, `reveal/params.ts` (`MotionReveal` gains `style: … | 'pixelreveal'` and a
  `pixel?` note; `isShaderRevealStyle`), `reveal/index.ts` (barrel: the DOM-free file only),
  `adapter/frame.ts` (`applyRevealBehaviours` branch), `bands.ts` (label), `gallery.ts` (18
  tiles + `PreviewKind`), `reveal/paintPixels.ts` (router + `revealShaderReady`),
  `composables/useCompositorLayers.ts` (pass text pieces into the painter), `MotionGallery.vue`,
  `MotionInspector.vue`.

## Tasks

Every task: TDD where the code is testable; run the task's unit specs AND the adjacent guards
listed; `npx vue-tsc` is not installed — run `npx tsc --noEmit -p .nuxt/tsconfig.app.json` and
compare error COUNT on touched files only (the repo has ~400 pre-existing errors). **Never run
`npm run dev` / `pnpm dev` / any dev server** (it kills the shared :3002). **Do not commit** —
report changed paths and test output; the controller commits.

### Task 1 — the DOM-free core (`pixelReveal.ts`)
- `PIXEL_REVEAL_LOOKS`: the 9 looks `{ id, label, blurb, settings }` with the prototype's
  `DEFAULTS` merged, heat as `{ colours: [a, b?] | null, mix }` — Materialize/Signal/Typewriter/
  Rain/Radiate/Flow use ultramarine `#1700c7`; Dissolve/Bitmap none; Glitch `#ff3d00`+`#00d1ff`
  mix .5.
- `PIXEL_REVEAL_PATTERNS` / `_DIRECTIONS` with sentence-case labels (prototype's
  `PATTERN_LABELS`, `DIR_LABELS`).
- `pixelRevealParams(params)` → resolved `{ look, out, pieces, pattern, direction, pixel,
  levels, spread, heat, …timing }`, clamped (pixel 4..64, levels 0..5, spread .05..1).
- `pickGrid(targetDevicePx, levels)` → `{ s, m, k, levels }` (prototype).
- `pieceOrder(n, from, seed)` (prototype `orderOf`, seeded).
- `pieceStates(p, n, amount)` → per piece `{ progress, riseFrac }` using decision 3 (ease
  functions from the prototype's `EASE`), plus `lookTotal(p, n)`.
- CPU mirrors used by the tile preview and tests: `revealWhen(cell, ...)`, `levelAt(life, blk,
  levels)` — same maths as the prototype shader (hash may differ; tests pin ranges/monotonicity,
  not exact values).
- Unit spec `tests/unit/motionx/reveal-pixelreveal.unit.spec.ts`: 9 looks with unique ids and
  their key numbers (Signal pixel 16 / scanlines / right; Typewriter letters; Dissolve heat null;
  Glitch two colours); reader defaults + clamps + overrides; pickGrid choices (e.g. 24→(3,3),
  16→(1,4)) and level caps; pieceOrder permutations for every `from`; pieceStates: all 0 at
  amount 0, all progress 1 and rise 0 at amount 1, monotone in amount, a later piece never ahead
  of an earlier one under `from:start` with stagger > 0.

### Task 2 — registration (kind, fold, label, gallery)
- `registerBehaviour('pixelreveal', …)` — same body as `settle`.
- `params.ts`: `MotionReveal.style` gains `'pixelreveal'`; add `pixel?: PixelRevealNote`
  (the resolved params needed at paint time); `isShaderRevealStyle` true for it;
  `motionUsesShaderStyle` unchanged semantics (it drives catalogue waits — `pixelreveal` needs
  none, so keep it FALSE for these bars, and make sure no export waits forever on it).
- `adapter/frame.ts` `applyRevealBehaviours`: accept `pixelreveal` bars; note =
  `{ ...revealParams({}), style: 'pixelreveal', out, amount, elapsed, pixel: <resolved> }`.
- `bands.ts`: label `"<Look label> in|out"` via the reader.
- `gallery.ts`: 18 tiles, id `pixelreveal-<look>-<dir>`, `preview: 'pixelreveal'`, placed after
  the Settle tiles in In and in Out; `PreviewKind` gains it.
- Update the pinned guards: `tests/unit/motionx/gallery.unit.spec.ts` (kind whitelist, tile
  counts/order), `bands.unit.spec.ts` (labels), `reveal-fold.unit.spec.ts` (a pixelreveal bar
  folds; amount ≥ 1 returns the same layer reference). Grep tests for other kind/tile counts.

### Task 3 — the painter (`paintPixelReveal.ts`) + dispatch
- `drawRevealPixelReveal(ctx, reveal, W, H, base, drawLayer, stamp, pieces?)` returns boolean,
  `false` = ctx untouched. `pieces` are `{ box:{x,y,w,h}, line:{top,bottom}, lineIdx, lineX:{l,w} }`
  in FRAME px (pre-`base`); the painter maps them with `base` (scale + translate only — soloPass
  already rejects rotation). No pieces → one piece = the solo canvas's ink box (scan alpha,
  step 2).
- WebGL2 singleton, program = prototype VS/FS (keep them in this file as template strings,
  commented in the house style), atlas upload with `UNPACK_PREMULTIPLY_ALPHA_WEBGL`,
  `NEAREST_MIPMAP_NEAREST`, `generateMipmap`; per-piece uniforms exactly as the prototype's
  `draw()`; `uTime` = `reveal.elapsed` (flicker/tear animate with the bar, deterministic per t).
  Size the GL canvas to the solo canvas; clear per frame.
- Stamp like `paintSettle.ts` (filter none, shadow transparent, identity transform, alpha,
  blend, `drawImage` at `base.e, base.f`).
- Router: `drawRevealShaderStyle` → this painter for `style === 'pixelreveal'`;
  `revealShaderReady` → `pixelRevealAvailable()`.
- `useCompositorLayers.ts` `paintLayerStack`: for a `pixelreveal` note on an unrotated flat text
  layer whose resolved `pieces !== 'whole'`, build pieces from `textMotionCells(layer, W)` +
  `groupCells`, mapped from layer-local (origin = layer centre, pre-rotation) to frame px the
  same way `drawText` places them (read `drawText` to get this exactly right — scale, alignment,
  the layer's x/y as fractions of W/H). Pass them as the new last argument. Otherwise pass
  nothing.
- Unit spec `tests/unit/motionx/reveal-paint-pixelreveal.unit.spec.ts` with injectable seams
  (follow `reveal-paint-settle.unit.spec.ts`): returns false without WebGL2; atlas slot packing
  is grid-aligned and non-overlapping (export the pure packer); piece mapping through a
  scale+translate `base`; the stamp uses the layer alpha and blend.

### Task 4 — inspector + gallery preview
- `MotionGallery.vue`: `preview === 'pixelreveal'` → `<MotionPixelRevealPreview :look :out>`.
- `MotionPixelRevealPreview.vue`: 48×30 canvas on `buildPreviewCard`, CPU block refinement using
  Task 1's mirrors (mean colour per block from an ImageData box average), same 2.4 s cycle,
  reduced-motion still frame, cleanup on unmount (copy `MotionSettlePreview.vue`'s lifecycle).
- `MotionInspector.vue` block for `pixelreveal` bars (sentence case, NO explanatory copy —
  tooltips only, per Julien's rule): Look select (swapping a look keeps `dir`, clears the
  per-setting overrides), In/Out segmented, Pieces segmented (Words / Letters / Lines / Whole;
  disabled unless the layer is text), Pattern select, Direction select, Pixel slider, Levels
  slider, Front width slider, Heat swatches (look colour / 4 colours / none). Writes through
  `setBehParams` / `setBehNum` like the Settle block. Testids `pixelreveal-*`.
- Unit spec `tests/unit/motionx/pixelreveal-ui.unit.spec.ts` in the style of
  `settle-ui.unit.spec.ts`.

### Task 5 — live verification + record (controller)
- In `/dev/frame-lab` on :3002: a text layer and an image layer each with a Materialize In bar;
  seek to 0.3 / 0.6 / 1.0 of the bar via the timeline; pixels change mid-bar, blocks are visibly
  coarse-to-fine, amount 1 is byte-identical to the plain layer; the tiles render; the inspector
  drives the look. Contact sheet to Julien.
- Playwright case in `tests/compositor-layer-effects.spec.ts` or a new `tests/motion-pixel-reveal.spec.ts`:
  mid-bar differs from the plain layer, end of bar identical.
- `docs/STATE.md`, dashboard, memory.
