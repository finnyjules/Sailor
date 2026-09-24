/**
 * Does a live player draw what the editor draws? The pixel comparison behind that question,
 * shared by the export-time check (liveCheck.ts) and the Task 4 parity harness
 * (pages/dev/spacetype-live-parity.vue), so the two can never measure differently. Pure.
 *
 * The metric is the one Task 4 measured with: `mean` is the mean absolute difference over the
 * colour channels (R, G, B; 0–255); `shareOver` is the share of pixels any of whose channels,
 * alpha included, differs by more than OVER. On the same GPU both routes draw with the same
 * shaders and glyph outlines, so a faithful player differs by nothing at all — the thresholds
 * only leave room for a stray edge.
 */

export interface ImageDiff { mean: number; shareOver: number }

/** A channel differing by more than this many levels counts its pixel as different. */
export const OVER = 24

/** Both limits are strict: a diff at either limit does not match. */
export const LIVE_MATCH = { maxMean: 2, maxShareOver: 0.005 } as const

/** `a` and `b`: RGBA pixels (ImageData.data) of two pictures of the same size. */
export function diffImages(a: Uint8ClampedArray, b: Uint8ClampedArray): ImageDiff {
  if (a.length !== b.length) throw new Error(`pictures of different size (${a.length / 4} and ${b.length / 4} pixels)`)
  const n = a.length / 4
  if (!n) return { mean: 0, shareOver: 0 }
  let sum = 0, over = 0
  for (let p = 0; p < a.length; p += 4) {
    const dr = Math.abs(a[p]! - b[p]!), dg = Math.abs(a[p + 1]! - b[p + 1]!), db = Math.abs(a[p + 2]! - b[p + 2]!)
    const da = Math.abs(a[p + 3]! - b[p + 3]!)
    sum += dr + dg + db
    if (dr > OVER || dg > OVER || db > OVER || da > OVER) over++
  }
  return { mean: sum / (3 * n), shareOver: over / n }
}

export function matches(d: ImageDiff): boolean {
  return d.mean < LIVE_MATCH.maxMean && d.shareOver < LIVE_MATCH.maxShareOver
}
