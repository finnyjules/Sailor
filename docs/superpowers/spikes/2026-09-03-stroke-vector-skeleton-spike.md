# Spike — stroke-vector skeleton from shipped fonts (Stage 1 round-trip gate)

**Status:** started 2026-09-03. Dev-only, throwaway-quality allowed. Julien approved a hard-gated Stage-1 spike over committing to the whole engine.

## The question the spike answers, and nothing more

Can we extract a **stroke skeleton + thickness** from an ordinary shipped font outline well enough that **re-inflating it at stretch 1 reproduces the drawn glyph within ~1 pixel**? That one number is the gate. If a sans fails it, the stroke-vector road ends and Vector Type ships a measured universal dial range on the slice engine instead. If it passes, Stage 2 (stretch the skeleton) and Stage 3 (an honest per-glyph breaking point) become worth the four-to-six-week build.

Out of scope for this spike: actually stretching the skeleton, any UI, any studio wiring, any variable-axis interaction. Skeleton → thickness → re-inflate → measure. That is all.

## Why this is cheap to try

Phase A already does the hard half. `analyzeGrid` (`app/lib/vectortype/stretch.ts:828`) flattens a glyph to segments, marks terminals, and runs a **two-pass chamfer distance transform** over a 96×96 grid, producing an interior distance-to-boundary field (`buildGrid`'s `dist`) and an even-odd `ink` mask. The **medial-axis theorem** says the shape equals the union of every maximal inscribed disk: a disk centred on a ridge of that distance field, with radius equal to the field value there. So:

- the **skeleton** is the ridge of the existing distance field (interior cells that are local maxima of `dist` along the gradient);
- the **half-thickness** at each skeleton point is the `dist` value there, in font units;
- **re-inflation** is: a pixel is ink iff it lies within `halfwidth(s)` of some skeleton point `s`.

A perfect ridge reconstructs the glyph exactly. The measured round-trip error is therefore exactly how much our *discrete* extraction loses — which is what we need to know.

## Build (one dev module + one measurement harness)

**Files (all new, dev/spike):**
- `frontend/app/lib/vectortype/skeleton.ts` — the extraction + re-inflation, pure.
- `frontend/tests/unit/vectortype-skeleton.unit.spec.ts` — the measurement, run as a test so the numbers are reproducible and CI-visible; it is a MEASUREMENT harness, not a pass/fail regression (it prints per-glyph error and asserts only the loosest sanity floors so it cannot silently rot).
- Extend `analyzeGrid`'s return with `dist: Float64Array` (the interior distance field it already computes internally). One field, additive, no behaviour change; existing callers ignore it.

**Interfaces the spike produces:**
```ts
export interface StrokeSkeleton {
  // Skeleton points in FONT UNITS, grouped into traced polylines.
  strokes: { x: number; y: number; halfWidth: number }[][]
  unitsPerEm: number
}
export function skeletonize(glyph: GlyphOutline, opts?: { grid?: number }): StrokeSkeleton
// Re-inflate to a raster mask at `res`×`res` over the glyph bbox; ink = within halfWidth of a stroke point.
export function inflateMask(skel: StrokeSkeleton, bbox: VtBBox, res: number): Uint8Array
// The drawn glyph's own ink mask at the same res, for comparison (even-odd scanline).
export function inkMask(glyph: GlyphOutline, bbox: VtBBox, res: number): Uint8Array
// Symmetric-difference / union (1 − IoU) and the max boundary deviation in font units.
export function roundTripError(a: Uint8Array, b: Uint8Array, res: number, bbox: VtBBox): { mismatch: number; maxDevEm: number }
```

**Extraction steps (in `skeletonize`):**
1. Interior distance field + ink from the grid (reuse `analyzeGrid`, now returning `dist`).
2. Ridge cells: interior cell `c` is a ridge cell if `dist[c]` ≥ both neighbours along whichever axis (x or y) has the steeper `dist` gradient (an approximate medial axis; a small tolerance `≥ max(neighbour) − ε` keeps flat ridges connected).
3. Thin the ridge mask to 1-cell width (a standard morphological thinning pass is fine; correctness over speed).
4. Trace connected ridge cells into polylines (walk from endpoints/junctions; a junction is a cell with ≥3 ridge neighbours — record it, do not try to resolve it prettily this spike).
5. Convert cell coordinates to font units (`bbox.minX + (c+0.5)*cw`, etc.); `halfWidth = dist[cell]` (already font units).

**Measurement (in the spec):** for each fixture glyph, `skeletonize` → `inflateMask` at res 256 → compare to `inkMask` at 256 → print `mismatch` (1 − IoU, %) and `maxDevEm` (max boundary deviation as a fraction of em). Run the SAME measurement at grid 96 and grid 192 and print both, so we can see whether error is discretization (shrinks with the finer grid → fixable) or structural (does not → fatal). Fixtures: **Inter** (sans, the gate), **Source Serif 4** (serif), **Fraunces** (display serif, high contrast), **Unbounded** (heavy display) — all in the curated catalog; load via the existing test-font pattern. Glyphs: `S a e o g i l r` (curves, junctions, a dot, a stem, a bowl).

## The gate (decide after the numbers land)

- **PASS** (build Stage 2): Inter's letters reconstruct within ~1.5% of em `maxDevEm` and < ~4% `mismatch` at grid 192, and the error clearly shrinks 96→192 (discretization-bound, not structural). A serif being worse is acceptable at this stage; a *sans* failing is the fatal signal.
- **FALSE START** (ship a measured range instead): Inter cannot be reconstructed within a pixel at any grid, or the junctions of `a`/`e`/`g` produce skeletons that re-inflate to visibly wrong shapes.

Report is the printed per-glyph table plus a rendered overlay (skeleton over outline, and re-inflated vs drawn) sent to Julien. His eye is the second gate, as in Phase A.

## Notes / expected trouble

- Contrast faces (Fraunces): one `halfWidth` per skeleton point already captures thick-thin, since the distance field does; the risk is the ridge wandering at a sharp thick→thin transition. Measure, do not pre-judge.
- Serifs and terminals will spawn short ridge spurs. This spike does NOT prune them; it measures whether they hurt re-inflation (they may be harmless, since a spur's disk is small).
- 96×96 is coarse for a hairline; that is exactly why the 96-vs-192 comparison is the load-bearing measurement.
- Junction resolution (the `a` bowl/stem meeting) is Stage 2's problem; this spike only records where junctions are and whether they wreck the round trip.
