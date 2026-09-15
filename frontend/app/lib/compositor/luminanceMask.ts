// F6 Task 3: the pure CPU twin of the `backdrop_luminance_mask` layer effect. Given the
// LUMINANCE of a backdrop pixel (0..1), returns the alpha the layer's OWN content keeps at
// that pixel. The effect wraps the layer's own-content paint: it builds a per-pixel mask by
// running this over the backdrop's luminance, multiplies it into the layer's rendered alpha
// (destination-in), and stamps the result — so the layer shows where the backdrop is bright
// and is hidden where it is dark (flipped by `invert`).
//
// Pure: no canvas, no DOM. Kept separate from useCompositorLayers.ts so the mapping is unit-
// testable without a GPU/2D context (the canvas recombine is covered by the live gate).

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Standard smoothstep with an edge0<edge1 guard: collapsed edges become a hard step. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** Maps a backdrop luminance (0..1) to the alpha the layer's own content keeps.
 *  Reveals where lum ≥ threshold by default; `invert` reveals where dark.
 *  `softness` (0..1) is the full width of the smoothstep transition band centred on
 *  threshold; softness ≈ 0 is a hard step. Returns 0..1. */
export function luminanceMaskAlpha(lum: number, threshold: number, softness: number, invert: boolean): number {
  const L = clamp01(lum)
  const th = clamp01(threshold)
  const s = clamp01(softness)
  const hw = Math.max(s, 1e-6) / 2
  let a = smoothstep(th - hw, th + hw, L)
  if (invert) a = 1 - a
  return clamp01(a)
}
