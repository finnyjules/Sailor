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
 * about 128 pixels of the picture sent, fix round 3, far less than half a
 * tile).
 *
 * Fix round 3 (USER ruling, the live check's faint bands on a flat sky):
 * before it is faded in, each tile's tone is matched to the source picture's
 * own low frequencies (`matchTone`): the model may brighten or tint one tile
 * a little differently from its neighbour, which a wide fade alone spreads
 * but doesn't remove. Anchoring every tile to the source (not to its
 * neighbour) can't drift across many tiles.
 *
 * Every value stays 8-bit: a fade weighs each side in 256ths and rounds.
 */
import { tileGrid, type TileGrid } from '#shared/runner/upscaleTiles'

/** One tile of an RGB8 picture `w` wide: its `tw` × `th` pixels from (x, y). */
export function cropRgb(rgb: Uint8Array, w: number, x: number, y: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th * 3)
  for (let r = 0; r < th; r++) {
    const from = ((y + r) * w + x) * 3
    out.set(rgb.subarray(from, from + tw * 3), r * tw * 3)
  }
  return out
}

/** How many positions from `start` (a tile `size` long) the one before it, ending at `prevEnd`, still covers. */
function overlapSpan(start: number, size: number, prevEnd: number): number {
  return Math.max(0, Math.min(prevEnd, start + size) - start)
}

/**
 * Each position's weight (in 256ths) of a tile starting at `start` and
 * `size` long, against the one before it ending at `prevEnd`: rising from
 * near 0 to near 256 across their overlap, 256 past it. No tile before it:
 * 256 all along.
 */
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

/**
 * The side (in pixels of the picture sent) of the blocks whose mean tone a
 * tile is matched on (fix round 3): coarse enough to leave every detail the
 * model adds, fine enough to follow a sky's gradient.
 */
export const TONE_BLOCK = 32

/** Each block's sum per channel of an RGB8 picture `w` × `h`, blocks of `b` × `b` (the last ones partial). */
function blockSums(rgb: Uint8Array, w: number, h: number, b: number, nx: number, ny: number): Float64Array {
  const sums = new Float64Array(nx * ny * 3)
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / b) * nx
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const o = (row + Math.floor(x / b)) * 3
      sums[o] = sums[o]! + rgb[i]!
      sums[o + 1] = sums[o + 1]! + rgb[i + 1]!
      sums[o + 2] = sums[o + 2]! + rgb[i + 2]!
    }
  }
  return sums
}

/** For each output position along a side: the two block centres it lies between and the second's weight (edges clamped). */
function lerpAxis(outSize: number, scale: number, block: number, srcSize: number, n: number): { i0: Int32Array; i1: Int32Array; t: Float32Array } {
  const i0 = new Int32Array(outSize)
  const i1 = new Int32Array(outSize)
  const t = new Float32Array(outSize)
  const centre = (k: number) => (k * block + Math.min(srcSize, (k + 1) * block)) / 2
  for (let X = 0; X < outSize; X++) {
    const u = (X + 0.5) / scale
    let k = 0
    while (k < n - 1 && centre(k + 1) <= u) k++
    if (k >= n - 1 || u <= centre(0)) {
      const j = u <= centre(0) ? 0 : n - 1
      i0[X] = j
      i1[X] = j
      t[X] = 0
      continue
    }
    i0[X] = k
    i1[X] = k + 1
    t[X] = (u - centre(k)) / (centre(k + 1) - centre(k))
  }
  return { i0, i1, t }
}

/**
 * A tile's answer (`ans`, `scale` × the tile each side) with its tone matched
 * to the source tile's (`src`, `tw` × `th`), fix round 3: per block of
 * TONE_BLOCK source pixels and per channel, the source's mean less the
 * answer's mean over the same area; that difference, smoothed between block
 * centres (bilinear), is added to every pixel. Only the low frequencies
 * move: an answer that already keeps the source's tone (the model's usual
 * case, and a picture doubled pixel for pixel) is unchanged.
 */
export function matchTone(src: Uint8Array, tw: number, th: number, ans: Uint8Array, scale: number, block = TONE_BLOCK): Uint8Array {
  const W = tw * scale
  const H = th * scale
  if (ans.length !== W * H * 3) throw new Error('A tile came back at the wrong size')
  const nx = Math.ceil(tw / block)
  const ny = Math.ceil(th / block)
  const s = blockSums(src, tw, th, block, nx, ny)
  const a = blockSums(ans, W, H, block * scale, nx, ny)
  const diff = new Float32Array(nx * ny * 3)
  let moved = false
  for (let by = 0; by < ny; by++) {
    for (let bx = 0; bx < nx; bx++) {
      const area = (Math.min(tw, (bx + 1) * block) - bx * block) * (Math.min(th, (by + 1) * block) - by * block)
      for (let c = 0; c < 3; c++) {
        const k = (by * nx + bx) * 3 + c
        const d = s[k]! / area - a[k]! / (area * scale * scale)
        diff[k] = d
        if (Math.abs(d) > 1e-6) moved = true
      }
    }
  }
  if (!moved) return ans
  const ax = lerpAxis(W, scale, block, tw, nx)
  const ay = lerpAxis(H, scale, block, th, ny)
  const out = new Uint8Array(ans.length)
  for (let Y = 0; Y < H; Y++) {
    const r0 = ay.i0[Y]! * nx
    const r1 = ay.i1[Y]! * nx
    const ty = ay.t[Y]!
    for (let X = 0; X < W; X++) {
      const c0 = ax.i0[X]!
      const c1 = ax.i1[X]!
      const tx = ax.t[X]!
      const o = (Y * W + X) * 3
      for (let c = 0; c < 3; c++) {
        const top = diff[(r0 + c0) * 3 + c]! * (1 - tx) + diff[(r0 + c1) * 3 + c]! * tx
        const bottom = diff[(r1 + c0) * 3 + c]! * (1 - tx) + diff[(r1 + c1) * 3 + c]! * tx
        const v = Math.round(ans[o + c]! + top * (1 - ty) + bottom * ty)
        out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
  }
  return out
}

/**
 * A picture upscaled in tiles (R11.6; fix round 3 shared with R3.5's Upscale
 * on Real-ESRGAN): cut by tileGrid under `cap`, each tile sent by `send` (one
 * at a time, in grid order; it gives the answer as RGB8 at exactly `scale` ×
 * the tile), its tone matched to the source, then faded in. Returns the
 * picture at `scale` × each side. Stop between tiles throws `stopped()`.
 */
export async function upscaleInTiles(o: {
  rgb: Uint8Array; w: number; h: number; scale: number; cap: number; signal: AbortSignal
  send: (k: number, tile: Uint8Array, tw: number, th: number) => Promise<Uint8Array>
  stopped: () => Error
}): Promise<{ rgb: Uint8Array; tiles: number }> {
  const grid = tileGrid(o.w, o.h, o.cap)
  const canvas = tiledCanvas(grid, o.w, o.h, o.scale)
  let k = 0
  for (const [row, y] of grid.ys.entries()) {
    for (const [col, x] of grid.xs.entries()) {
      if (o.signal.aborted) throw o.stopped()
      const tile = cropRgb(o.rgb, o.w, x, y, grid.tw, grid.th)
      const ans = await o.send(k, tile, grid.tw, grid.th)
      canvas.put(row, col, matchTone(tile, grid.tw, grid.th, ans, o.scale))
      k++
    }
  }
  return { rgb: canvas.done(), tiles: k }
}
