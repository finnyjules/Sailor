# Frame effects — Slice F3: boolean, morph, warp, long shadow, shatter

BASE 0b66d452f. Five new **geometry-region** effect kinds on F2's outline pipeline. Each
transforms a vector layer's outline `d` before it rasterises; absent them the document is
byte-identical to HEAD.

## The five kinds
- **boolean** (`unite | subtract | intersect | exclude`) with a SIBLING layer, via paper.js
  `PathItem` boolean ops. Greys out unless the reference is a vector layer.
- **morph** toward a sibling by `amount`, via `prepareBlend`/`blendPath` (`app/lib/vector/morph.ts`).
- **warp** (`bulge | pinch | wave | twist`) — a mesh-warp engine `lib/compositor/meshWarp.ts`
  (N×N grid, bilinear) generalising `drawQuadWarp`. Vector layers: displace the outline points.
  Raster layers (outline not vector): warp the rasterised pixels (kind lives in the pixel region
  for raster).
- **long_shadow / extrude** (`angle`, `length`, `colour`): geometry union of the shape and an
  offset copy, filled first (self-only, no sibling).
- **shatter**: Voronoi cells clipped to the outline (paper.js intersect), `gap`, `seed`; needs
  `d3-delaunay` (MIT) or a Bowyer–Watson impl.

## Sibling reference (the F3 rail)
`refLayerId` is a `StackKey` param on the effects that need a partner (boolean, morph), modelled
on the compositor mask reference (`maskedByKey`): dangling-tolerant (deleted target → no-op +
greyed reason, never throws, no delete cleanup), carried verbatim on duplicate (points at the
original sibling). `applyGeometry` gains an optional `resolveSiblingOutline(key, self) -> {d,W}|null`
resolver built at the `drawLayerContent` boundary — returns the sibling's outline in the self
frame, cycle-guarded (sibling resolved with the resolver off), self/non-vector/missing → null.
The `applyGeometry` cache key folds `refLayerId` + the resolved sibling's key/geometry + relative
transform (moving either layer re-renders).

## Tasks (≈8)
1. **Sibling reference plumbing** (`refLayerId`) with the mask reference's lifecycle
   (delete = dangling-tolerant no-op, duplicate = verbatim carry). Pure resolver
   `resolveSiblingOutline` + the `applyGeometry` options seam (present, unconsumed until Task 2)
   + cache-key fold + lifecycle unit tests. No new EffectKind, no picker yet.
2. **boolean** kind (paper.js unite/subtract/intersect/exclude) + the sibling picker in the
   inspector (greys on non-vector ref) + add-menu gating + `canTakeGeometry` + unit + Playwright.
3. **morph** toward sibling (`amount`) via `prepareBlend`/`blendPath`; reuses the Task 1 rail.
4a. **mesh-warp engine** `lib/compositor/meshWarp.ts` (pure displacement fields:
   bulge/pinch/wave/twist) + the VECTOR path: `warp` as a geometry kind that displaces the
   outline points through `applyGeometry`. Inspector + unit + Playwright.
4b. **raster warp** — warp on image/wired/brush as a PIXEL-region pass generalising
   `drawQuadWarp` over the rasterised layer canvas; needs per-kind eligibility (not the blanket
   `canTakeGeometry`) + region/reorder layer-awareness. Split out because "one kind, two
   regions" destabilises the clean geometry-region invariant and needs its own reviewable slice.
5. **long shadow / extrude** (angle, length, colour): union of shape + offset copy, filled first.
6. **shatter**: add `d3-delaunay` (MIT) or Bowyer–Watson; Voronoi cells clipped to the outline
   (paper.js intersect); gap dial, seed.
7. **Playwright** pixel-change case per kind.
8. **agent surface** (`setLayerEffect` widens to the five kinds via the geometry sanitizer) +
   hint copy (mind `COMPOSITOR_HINT_CEILING`).

## Guarantees
- No new effect on a layer ⇒ byte-identical to HEAD (real-canvas A/B on paint-path changes).
- Geometry effects only on vector-backed layers + outlined text; F1 decoration gate holds.
- Every kind's dials/pickers are consumed (no dead controls); UI copy sentence case.
- Own-hunks staging on the four shared files; private HEAD-seeded `GIT_INDEX_FILE`.
