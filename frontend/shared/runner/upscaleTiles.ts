/**
 * Upscale (2×) over 1440p, in tiles (step 3, R11.6, ruling (i)): the
 * arithmetic the node cuts a picture by (server/runner/generators/tiles.ts
 * blends the answers) and the price holds by, in one place so the two can
 * never disagree.
 *
 * A picture over the service's largest (`cap`, UPSCALE_2X_MAX_PIXELS: the
 * 2 096 704 pixels Replicate's GPU takes, measured 2026-10-01) is cut
 * into a grid of `cols` × `rows` overlapping tiles, every tile the same size
 * and at most `cap` pixels, neighbours overlapping by at least `overlap`
 * pixels (UPSCALE_TILE_OVERLAP: 128 since fix round 3; Python's
 * `_tiled_forward` overlaps by 32). Each column count c
 * gives the narrowest tile that covers the width with that overlap,
 * `tw = min(W, ceil((W + (c − 1)·overlap) / c))`, and the fewest rows whose
 * tile height keeps `tw × th` under the cap; the grid kept is the one with
 * the fewest tiles, the squarest tiles among equals (`tileGrid`). One tile, the whole picture, at or under the
 * cap: the call R7.2 made.
 *
 * The hold needs the count before the picture is seen, sometimes from a
 * pixel bound alone (a generator's stated largest). Whether a grid fits only
 * gets harder as either side grows, so the fewest tiles never falls as a side
 * grows; the most tiles any picture of at most P pixels needs is then the
 * most over W ≤ √P of the W × ⌊P / W⌋ picture (the narrower side W, the other
 * as long as it can be) — `tileCountBound`, a TRUE upper bound of what
 * `tileGrid` makes for every picture of at most P pixels, whatever its shape.
 *
 * Pure: no imports, so the price module and the server read the same rule.
 */

/**
 * Neighbouring tiles overlap by at least this many pixels of the picture
 * sent. Python's `_tiled_forward` overlaps by 32; fix round 3 (USER ruling,
 * "wider blend", after the live check showed faint bands on a flat sky)
 * overlaps by 128, inside each tile's pixel limit.
 */
export const UPSCALE_TILE_OVERLAP = 128

/**
 * R11.6 fix round 1 (L2): the narrowest side a tile may have. A picture
 * over the cap whose tiles would be thinner (its shorter side under this: a
 * strip such as 65 536 × 60) is refused plainly before the hold
 * (`tooThinToTile`), not sent: the model's own padding is untested on such
 * slivers. Twice the overlap (fix round 3: 256, was 64 with the 32-pixel
 * overlap), so a tile keeps as much of its own picture as it shares.
 */
export const UPSCALE_TILE_MIN_SIDE = 2 * UPSCALE_TILE_OVERLAP

/** One picture's tiles: the grid, each tile's size, and where each column and row starts. */
export interface TileGrid {
  cols: number
  rows: number
  /** Every tile's width and height (at most the picture's own). */
  tw: number
  th: number
  /** Each column's left edge and each row's top edge, in the picture, in order (the last ends at the picture's edge). */
  xs: number[]
  ys: number[]
}

/** The narrowest side of `n` equal tiles covering `side` with `overlap` between neighbours (never more than the side). */
function tileSide(side: number, n: number, overlap: number): number {
  return Math.min(side, Math.ceil((side + (n - 1) * overlap) / n))
}

/** The fewest rows (with their tile height) whose tiles, `tw` wide, stay under `cap`; null when none do. */
function rowsFor(h: number, tw: number, cap: number, overlap: number): { rows: number; th: number } | null {
  if (h * tw <= cap) return { rows: 1, th: h }
  const most = Math.floor(cap / tw)
  if (most <= overlap) return null
  // ceil((h + (r − 1)·overlap) / r) ≤ most  ⟺  r·(most − overlap) ≥ h − overlap.
  const rows = Math.ceil((h - overlap) / (most - overlap))
  const th = tileSide(h, rows, overlap)
  return th * tw <= cap ? { rows, th } : null
}

/** Each tile's start along a side: spread evenly from 0 to `side − tile`, rounded down (never less overlap than asked). */
function starts(side: number, tile: number, n: number): number[] {
  if (n === 1) return [0]
  return Array.from({ length: n }, (_, i) => Math.floor((i * (side - tile)) / (n - 1)))
}

function checkSides(w: number, h: number, cap: number): void {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new Error('A picture to tile needs whole sides above 0')
  if (!(Number.isInteger(cap) && cap > 0)) throw new Error('A tile needs a whole largest size above 0')
}

/** The fewest tiles a W × H picture is cut into (one at or under the cap), and their grid's columns and rows. */
function fewest(w: number, h: number, cap: number, overlap: number): { cols: number; rows: number; tw: number; th: number } {
  if (w * h <= cap) return { cols: 1, rows: 1, tw: w, th: h }
  let best: { cols: number; rows: number; tw: number; th: number } | null = null
  // How far a tile is from square (1 is square): of grids with as few tiles, the squarest (more of the picture around each pixel).
  const skew = (tw: number, th: number) => Math.max(tw / th, th / tw)
  // c columns make at least c tiles: no c past the best count can match it.
  for (let c = 1; c <= w && (!best || c <= best.cols * best.rows); c++) {
    const tw = tileSide(w, c, overlap)
    const r = rowsFor(h, tw, cap, overlap)
    if (!r) continue
    const n = c * r.rows
    if (!best || n < best.cols * best.rows || (n === best.cols * best.rows && skew(tw, r.th) < skew(best.tw, best.th))) best = { cols: c, rows: r.rows, tw, th: r.th }
  }
  // c = W makes tiles at most overlap + 1 wide, which fit some rows whenever the cap is well above the overlap
  // (the real one: 2 096 704 pixels, 1448², against 128).
  if (!best) throw new Error('This picture can’t be cut into tiles')
  return best
}

/** The tiles a W × H picture is cut into (see the header). */
export function tileGrid(w: number, h: number, cap: number, overlap = UPSCALE_TILE_OVERLAP): TileGrid {
  checkSides(w, h, cap)
  const g = fewest(w, h, cap, overlap)
  return { ...g, xs: starts(w, g.tw, g.cols), ys: starts(h, g.th, g.rows) }
}

/** How many tiles a W × H picture is cut into. */
export function tileCount(w: number, h: number, cap: number, overlap = UPSCALE_TILE_OVERLAP): number {
  checkSides(w, h, cap)
  const g = fewest(w, h, cap, overlap)
  return g.cols * g.rows
}

/**
 * Whether a W × H picture over the cap would be cut into tiles thinner than
 * UPSCALE_TILE_MIN_SIDE (refused before the hold). Never for one at or under
 * the cap (one call, the whole picture, as R7.2).
 */
export function tooThinToTile(w: number, h: number, cap: number, overlap = UPSCALE_TILE_OVERLAP): boolean {
  checkSides(w, h, cap)
  if (w * h <= cap) return false
  if (Math.min(w, h) < UPSCALE_TILE_MIN_SIDE) return true
  const g = fewest(w, h, cap, overlap)
  return Math.min(g.tw, g.th) < UPSCALE_TILE_MIN_SIDE
}

const BOUNDS = new Map<string, number>()

/**
 * The most tiles any picture of at most `pixels` pixels is cut into (see the
 * header: the most over W ≤ √P of the W × ⌊P / W⌋ picture). One at or under
 * the cap. Remembered: the badge and the quote ask for the same few bounds.
 */
export function tileCountBound(pixels: number, cap: number, overlap = UPSCALE_TILE_OVERLAP): number {
  if (!(Number.isFinite(pixels) && pixels > 0)) throw new Error('A picture to tile needs a size above 0')
  const p = Math.floor(pixels)
  if (p <= cap) return 1
  const key = `${p}:${cap}:${overlap}`
  const known = BOUNDS.get(key)
  if (known !== undefined) return known
  let most = 1
  for (let w = 1; w * w <= p; w++) {
    const g = fewest(w, Math.floor(p / w), cap, overlap)
    most = Math.max(most, g.cols * g.rows)
  }
  if (BOUNDS.size > 256) BOUNDS.clear()
  BOUNDS.set(key, most)
  return most
}
