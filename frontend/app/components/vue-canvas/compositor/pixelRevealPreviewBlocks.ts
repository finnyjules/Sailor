// Pure block-fill maths for the Pixel reveal gallery tile (task 4 of the addendum): turns a
// look's settings and a bar's `amount` into filled RGBA blocks on the shared 48×30 preview
// card, using the CPU mirrors from `pixelReveal.ts` (`pickGrid`, `revealWhen`, `levelAt`,
// `pieceStates`) so the tile's SHAPE agrees with the real transition, even though its blocks
// are box-averaged here rather than sampled from a GPU mipmap atlas. No Vue, no DOM — only
// `MotionPixelRevealPreview.vue` calls this.
import { pickGrid, revealWhen, levelAt, pieceStates, type PixelRevealSettings } from '~/lib/motionx/reveal/pixelReveal'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (lo: number, hi: number, x: number) => {
  const t = clamp01((x - lo) / Math.max(hi - lo, 1e-9))
  return t * t * (3 - 2 * t)
}

/** Alpha-weighted box average of a straight-RGBA `cols`×`rows` buffer over the pixel rect
 *  `[x0,x1) × [y0,y1)`, clamped to the buffer's own bounds — a block straddling the card's
 *  edge fades towards transparent instead of picking up the transparent surround at full
 *  strength. `[0,0,0,0]` when the rect is empty or fully transparent. */
export function meanColor(
  src: Uint8ClampedArray, cols: number, rows: number, x0: number, y0: number, x1: number, y1: number,
): [number, number, number, number] {
  const xs = Math.max(0, Math.floor(x0)), ys = Math.max(0, Math.floor(y0))
  const xe = Math.min(cols, Math.ceil(x1)), ye = Math.min(rows, Math.ceil(y1))
  let r = 0, g = 0, b = 0, aSum = 0, n = 0
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const i = (y * cols + x) * 4
      const alpha = src[i + 3]!
      r += src[i]! * alpha; g += src[i + 1]! * alpha; b += src[i + 2]! * alpha
      aSum += alpha
      n++
    }
  }
  if (n === 0 || aSum === 0) return [0, 0, 0, 0]
  return [r / aSum, g / aSum, b / aSum, aSum / n]
}

const hex3 = (h: string): [number, number, number] => {
  const n = /^#[0-9a-f]{6}$/i.test(h) ? parseInt(h.slice(1), 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Fills `data` (a straight-RGBA `cols`×`rows` buffer, e.g. an `ImageData`'s own `.data`) with
 * one frame of a look's reveal at `amount`. `pickGrid(targetBlockPx, settings.levels)` chooses
 * the block ladder — `targetBlockPx` is already in the CALLER's px space (see
 * `MotionPixelRevealPreview.vue` for why it is not the real painter's 1080-wide frame basis).
 * `revealWhen`/`levelAt` (mirrors of the shader's own `when()`/level loop) decide each block's
 * life and how many times it has halved; a surviving block is painted the box-averaged mean of
 * the card underneath it, at `grid.levels` (the ladder's OWN halving cap, same as the painter's
 * `uLevels`) rather than the look's raw, possibly-uncappable `settings.levels`. Heat blends in
 * near a block's own threshold, the same `smoothstep` shape the shader uses, picking between a
 * two-colour look's pair by a cheap per-block parity check instead of a hashed coin flip.
 */
export function paintPixelRevealFrame(
  data: Uint8ClampedArray, source: Uint8ClampedArray, cols: number, rows: number,
  settings: PixelRevealSettings, amount: number, targetBlockPx: number,
): void {
  data.fill(0)
  const grid = pickGrid(targetBlockPx, settings.levels)
  const rect = { x: 0, y: 0, w: cols, h: rows }
  const progress = pieceStates(settings, 1, amount)[0]?.progress ?? 0
  const spread = Math.max(settings.spread, 1e-6)
  const colours = settings.heat.colours
  const hotA = colours ? hex3(colours[0]) : null
  const hotB = colours && colours[1] ? hex3(colours[1]) : hotA

  for (let by = 0; by * grid.s < rows; by++) {
    for (let bx = 0; bx * grid.s < cols; bx++) {
      const cell = { x: bx, y: by }
      const at = { x: (bx + 0.5) * grid.s, y: (by + 0.5) * grid.s }
      const when = revealWhen(cell, {
        at, rect, pattern: settings.pattern, direction: settings.direction,
        noise: settings.noise, scatter: settings.scatter,
      })
      const life = clamp01((progress - when * (1 - spread)) / spread)
      if (life <= 0) continue
      const lvl = levelAt(life, cell, grid.levels)
      const sharp = lvl >= grid.levels
      const blockPx = sharp ? 1 : grid.s / 2 ** lvl
      const x0 = bx * grid.s, y0 = by * grid.s
      for (let sy = y0; sy < Math.min(rows, y0 + grid.s); sy += blockPx) {
        for (let sx = x0; sx < Math.min(cols, x0 + grid.s); sx += blockPx) {
          const [r, g, b, a] = meanColor(source, cols, rows, sx, sy, sx + blockPx, sy + blockPx)
          if (a <= 0) continue
          let cr = r, cg = g, cb = b
          if (hotA) {
            const hotFrac = clamp01(1 - smoothstep(0, Math.max(settings.accentWidth, 1e-3), life))
            if (hotFrac > 0) {
              const hot = ((bx + by) & 1) === 0 ? hotA : hotB!
              cr += (hot[0] - cr) * hotFrac
              cg += (hot[1] - cg) * hotFrac
              cb += (hot[2] - cb) * hotFrac
            }
          }
          const xe = Math.min(cols, sx + blockPx), ye = Math.min(rows, sy + blockPx)
          for (let py = Math.floor(sy); py < ye; py++) {
            for (let px = Math.floor(sx); px < xe; px++) {
              const i = (py * cols + px) * 4
              data[i] = cr; data[i + 1] = cg; data[i + 2] = cb; data[i + 3] = a
            }
          }
        }
      }
    }
  }
}
