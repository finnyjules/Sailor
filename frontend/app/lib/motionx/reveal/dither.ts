// The dither maths. A CELL is one square of the pattern, `cell × frameWidth` pixels on a side,
// addressed by integer (cx, cy) from the frame's top-left; cells outside the frame (negative,
// or past the last column) are legal — the editor shows pasteboard around the frame and the
// layer can hang over it. Pure functions of (amount, elapsed, dials): preview, bake and export
// agree frame for frame.
import type { MotionReveal } from './params'

// The classic 8×8 ordered-dither matrix, values 0..63.
const B8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]
const wrap8 = (n: number) => ((Math.floor(n) % 8) + 8) % 8
/** The threshold of cell (cx, cy), strictly inside (0, 1). Tiles every 8 cells. */
export function bayer8(cx: number, cy: number): number {
  return (B8[wrap8(cy) * 8 + wrap8(cx)]! + 0.5) / 64
}

/** How far the pattern has slid, in WHOLE cells — the stepping shimmer of an ordered dither. */
export function driftCells(r: MotionReveal): { dx: number; dy: number } {
  const d = Math.max(0, r.elapsed) * r.drift
  // `+ 0` turns a −0 into 0 so callers can compare with toEqual.
  return { dx: Math.floor(d * Math.cos(r.angle) + 1e-9) + 0, dy: Math.floor(d * Math.sin(r.angle) + 1e-9) + 0 }
}

/** Where cell (cx, cy) sits along the wipe's direction of travel: 0 at the side the edge starts
 *  from, 1 at the far side, measured across the FRAME's grid (so it can leave [0, 1] on the
 *  pasteboard). */
function along(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): number {
  const ux = Math.cos(r.angle), uy = Math.sin(r.angle)
  const proj = (x: number, y: number) => x * ux + y * uy
  const corners = [proj(0, 0), proj(grid.cols, 0), proj(0, grid.rows), proj(grid.cols, grid.rows)]
  const lo = Math.min(...corners), hi = Math.max(...corners)
  const s = hi - lo < 1e-9 ? 0 : (proj(cx + 0.5, cy + 0.5) - lo) / (hi - lo)
  // OUT keeps sweeping the same way: the EMPTY side grows from the start side.
  return r.out ? 1 - s : s
}

/** Dissolve and Wipe: is this cell shown? */
export function cellShown(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): boolean {
  if (!(r.amount > 0)) return false
  if (r.amount >= 1) return true
  const { dx, dy } = driftCells(r)
  const th = bayer8(cx - dx, cy - dy)
  if (r.style !== 'wipe') return r.amount > th
  const s = along(r, cx, cy, grid)
  if (r.softness <= 1e-6) return s < r.amount
  // The band of width `softness` sits just behind a front that runs 0 → 1 + softness, so the
  // frame is empty at amount 0 and full at amount 1 whatever the softness.
  const local = (r.amount * (1 + r.softness) - s) / r.softness
  return local >= 1 || (local > 0 && local > th)
}

/** Dots sit on a square grid this many cells apart. */
export const DOT_PITCH_CELLS = 3
/** Dot radius in PITCHES. Neighbouring dots close the last gap (the corner between four of
 *  them) at √½ ≈ 0.707, reached at amount ≈ 0.94 — before the transition ends. */
export function dotRadius(amount: number): number {
  return Math.max(0, Math.min(1, amount)) * 0.75
}
/** Dots: is the point (u, v) — in frame-WIDTH units from the frame's top-left — inside a dot?
 *  The grid slides smoothly (not in whole cells): a dot is a vector shape, it has no steps. */
export function dotShown(r: MotionReveal, u: number, v: number): boolean {
  if (!(r.amount > 0)) return false
  if (r.amount >= 1) return true
  const pitch = r.cell * DOT_PITCH_CELLS
  const slide = Math.max(0, r.elapsed) * r.drift * r.cell
  const fx = ((((u - slide * Math.cos(r.angle)) / pitch) % 1) + 1) % 1 - 0.5
  const fy = ((((v - slide * Math.sin(r.angle)) / pitch) % 1) + 1) % 1 - 0.5
  return Math.hypot(fx, fy) < dotRadius(r.amount)
}

const MAX_CELLS = 1_000_000
/** The block of cells that covers the whole visible canvas. `inv` maps DEVICE pixels back to
 *  frame pixels (the inverse of the painter's transform). Cut back to the frame itself when
 *  the honest answer would be absurd (a huge zoom-out at the finest cell size). */
export function cellRange(
  inv: { a: number; b: number; c: number; d: number; e: number; f: number },
  canvasW: number, canvasH: number, W: number, H: number, cell: number,
): { c0: number; r0: number; cols: number; rows: number } {
  const cellPx = Math.max(1e-6, cell * W)
  const frame = { c0: 0, r0: 0, cols: Math.max(1, Math.ceil(W / cellPx - 1e-9)), rows: Math.max(1, Math.ceil(H / cellPx - 1e-9)) }
  const xs: number[] = [], ys: number[] = []
  for (const [x, y] of [[0, 0], [canvasW, 0], [0, canvasH], [canvasW, canvasH]] as const) {
    xs.push(inv.a * x + inv.c * y + inv.e); ys.push(inv.b * x + inv.d * y + inv.f)
  }
  if (![...xs, ...ys].every(Number.isFinite)) return frame
  const c0 = Math.min(0, Math.floor(Math.min(...xs) / cellPx))
  const r0 = Math.min(0, Math.floor(Math.min(...ys) / cellPx))
  const c1 = Math.max(frame.cols, Math.ceil(Math.max(...xs) / cellPx))
  const r1 = Math.max(frame.rows, Math.ceil(Math.max(...ys) / cellPx))
  const cols = c1 - c0, rows = r1 - r0
  return cols * rows > MAX_CELLS ? frame : { c0, r0, cols, rows }
}

/** One RGBA pixel per cell of `range`; alpha 255 where the cell is HIDDEN. The painter scales
 *  it up with smoothing off, so a pixel is exactly a cell. */
export function buildHiddenMask(
  r: MotionReveal, range: { c0: number; r0: number; cols: number; rows: number }, grid: { cols: number; rows: number },
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(range.cols * range.rows * 4)
  for (let j = 0; j < range.rows; j++) for (let i = 0; i < range.cols; i++) {
    if (!cellShown(r, range.c0 + i, range.r0 + j, grid)) px[(j * range.cols + i) * 4 + 3] = 255
  }
  return px
}
