/**
 * Upscale (2×) in tiles (step 3, R11.6, ruling (i)): the picture cut into
 * the tiles shared/runner/upscaleTiles.ts tileGrid lays out, and the
 * upscaled tiles blended back into one picture at twice each side.
 *
 * Python's `_tiled_forward` averages overlapping tiles with equal weights,
 * which steps from one tile to two at the overlap's edge. Here each overlap
 * fades from one tile to the next in a straight line instead (the user's
 * fix-bugs rule: the same picture where tiles agree, no step where they
 * don't). The fade is separable: a row of tiles is blended side to side,
 * then its overlap with the row above top to bottom into the picture, so where four
 * tiles meet each counts by the product of its two fades (they add up to
 * one). Neighbours only ever overlap their own neighbours (each overlap is
 * about 32 pixels of the picture sent, far less than half a tile).
 *
 * Every value stays 8-bit: a fade weighs each side in 256ths and rounds.
 */
import type { TileGrid } from '#shared/runner/upscaleTiles'

/** One tile of an RGB8 picture `w` wide: its `tw` × `th` pixels from (x, y). */
export function cropRgb(rgb: Uint8Array, w: number, x: number, y: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th * 3)
  for (let r = 0; r < th; r++) {
    const from = ((y + r) * w + x) * 3
    out.set(rgb.subarray(from, from + tw * 3), r * tw * 3)
  }
  return out
}

/**
 * Each position's weight (in 256ths) of a tile starting at `start` and
 * `size` long, against the one before it ending at `prevEnd`: rising from
 * near 0 to near 256 across their overlap, 256 past it. No tile before it:
 * 256 all along.
 */
/** How many positions from `start` (a tile `size` long) the one before it, ending at `prevEnd`, still covers. */
function overlapSpan(start: number, size: number, prevEnd: number): number {
  return Math.max(0, Math.min(prevEnd, start + size) - start)
}

function fadeIn(start: number, size: number, prevEnd: number | null): Uint16Array {
  const w = new Uint16Array(size).fill(256)
  if (prevEnd === null) return w
  const span = overlapSpan(start, size, prevEnd)
  for (let i = 0; i < span; i++) w[i] = Math.round(((i + 0.5) / span) * 256)
  return w
}

/**
 * The upscaled picture, built tile by tile in grid order (row by row, left to
 * right): `put(row, col, rgb)` takes each tile's answer at `scale` × its
 * size; `done()` gives the picture. A tile out of order is refused.
 *
 * Fix round 1 (M1): only a row of tiles' top overlap (the rows that fade into
 * the row above) is blended side to side in a small band first; every other
 * row is blended side to side straight into the picture, which no later row
 * of tiles reaches before its own overlap. The band is W × (the overlap's
 * rows), about 2 MB for a 4K picture, so the peak is the picture itself.
 */
export function tiledCanvas(grid: TileGrid, w: number, h: number, scale: number): {
  put: (row: number, col: number, rgb: Uint8Array) => void
  done: () => Uint8Array
} {
  const W = w * scale
  const H = h * scale
  const TW = grid.tw * scale
  const TH = grid.th * scale
  const out = new Uint8Array(W * H * 3)
  const colFade = grid.xs.map((x, i) => fadeIn(x * scale, TW, i > 0 ? grid.xs[i - 1]! * scale + TW : null))
  const rowFade = grid.ys.map((y, j) => fadeIn(y * scale, TH, j > 0 ? grid.ys[j - 1]! * scale + TH : null))
  // Each row of tiles' overlap with the row above: its first `faded[j]` rows (fadeIn's span), the rest at 256.
  const faded = grid.ys.map((y, j) => (j > 0 ? overlapSpan(y * scale, TH, grid.ys[j - 1]! * scale + TH) : 0))
  const band = new Uint8Array(tiledBandBytes(grid, w, scale))
  let next = 0

  /** The band (a row of tiles' overlap rows, blended side to side) faded into the picture at its row. */
  const bandDown = (row: number) => {
    const y0 = grid.ys[row]! * scale
    const fade = rowFade[row]!
    for (let r = 0; r < faded[row]!; r++) {
      const a = fade[r]!
      const b = 256 - a
      const at = (y0 + r) * W * 3
      const src = band.subarray(r * W * 3, (r + 1) * W * 3)
      for (let k = 0; k < src.length; k++) out[at + k] = (out[at + k]! * b + src[k]! * a + 128) >> 8
    }
  }

  return {
    put(row, col, rgb) {
      if (row * grid.cols + col !== next) throw new Error('The tiles must come in order')
      if (rgb.length !== TW * TH * 3) throw new Error('A tile came back at the wrong size')
      const x0 = grid.xs[col]! * scale
      const y0 = grid.ys[row]! * scale
      const fade = colFade[col]!
      const inBand = faded[row]!
      for (let r = 0; r < TH; r++) {
        // An overlap row goes to the band (faded into the picture once its row of tiles is whole); any other straight in.
        const dst = r < inBand ? band : out
        const at = r < inBand ? (r * W + x0) * 3 : ((y0 + r) * W + x0) * 3
        const from = r * TW * 3
        for (let c = 0; c < TW; c++) {
          const a = fade[c]!
          const o = at + c * 3
          const s = from + c * 3
          if (a === 256) {
            dst[o] = rgb[s]!
            dst[o + 1] = rgb[s + 1]!
            dst[o + 2] = rgb[s + 2]!
            continue
          }
          const b = 256 - a
          dst[o] = (dst[o]! * b + rgb[s]! * a + 128) >> 8
          dst[o + 1] = (dst[o + 1]! * b + rgb[s + 1]! * a + 128) >> 8
          dst[o + 2] = (dst[o + 2]! * b + rgb[s + 2]! * a + 128) >> 8
        }
      }
      next++
      if (col === grid.cols - 1) bandDown(row)
    },
    done() {
      if (next !== grid.cols * grid.rows) throw new Error('Not every tile came back')
      return out
    },
  }
}

/** The blend's working memory besides the picture (fix round 1, M1): the band of overlap rows, in bytes. */
export function tiledBandBytes(grid: TileGrid, w: number, scale: number): number {
  const TH = grid.th * scale
  let most = 0
  for (const [j, y] of grid.ys.entries()) if (j > 0) most = Math.max(most, overlapSpan(y * scale, TH, grid.ys[j - 1]! * scale + TH))
  return w * scale * most * 3
}
