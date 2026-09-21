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

/** Seconds into the bar, never negative and never non-finite — a NaN here would turn every
 *  threshold into NaN and hide the whole layer. */
const secondsIn = (r: MotionReveal) => (Number.isFinite(r.elapsed) ? Math.max(0, r.elapsed) : 0)

/** How far the pattern has slid, in WHOLE cells — the stepping shimmer of an ordered dither. */
export function driftCells(r: MotionReveal): { dx: number; dy: number } {
  const d = secondsIn(r) * r.drift
  // `+ 0` turns a −0 into 0 so callers can compare with toEqual.
  return { dx: Math.floor(d * Math.cos(r.angle) + 1e-9) + 0, dy: Math.floor(d * Math.sin(r.angle) + 1e-9) + 0 }
}

/**
 * Dissolve and Wipe: the test for ONE frame, with everything that is the same for every cell
 * worked out once — the drift, and for Wipe the direction of travel and the frame's extent
 * along it. `buildHiddenMask` asks it up to a million times a frame; doing the trigonometry
 * per cell made the mask 2–4× slower for no change in the answer.
 *
 * Wipe measures a cell's place along the travel across the FRAME's grid: 0 at the side the
 * edge starts from, 1 at the far side. On the editor's pasteboard that leaves [0, 1], so the
 * part of a layer hanging past the far edge only fills in as the amount reaches 1 — right for
 * export (which is the frame), and the price of cells that are identical in preview and export.
 */
export function cellTest(r: MotionReveal, grid: { cols: number; rows: number }): (cx: number, cy: number) => boolean {
  if (!(r.amount > 0)) return () => false
  if (r.amount >= 1) return () => true
  const { dx, dy } = driftCells(r)
  const amount = r.amount
  if (r.style !== 'wipe') return (cx, cy) => amount > bayer8(cx - dx, cy - dy)
  const ux = Math.cos(r.angle), uy = Math.sin(r.angle)
  const c1 = grid.cols * ux, c2 = grid.rows * uy
  const lo = Math.min(0, c1, c2, c1 + c2), span = Math.max(0, c1, c2, c1 + c2) - lo
  const out = r.out, soft = r.softness
  // OUT keeps sweeping the same way: the EMPTY side grows from the start side.
  const along = (cx: number, cy: number) => {
    const s = span < 1e-9 ? 0 : ((cx + 0.5) * ux + (cy + 0.5) * uy - lo) / span
    return out ? 1 - s : s
  }
  if (soft <= 1e-6) return (cx, cy) => along(cx, cy) < amount
  // The band of width `softness` sits just behind a front that runs 0 → 1 + softness, so the
  // frame is empty at amount 0 and full at amount 1 whatever the softness.
  const front = amount * (1 + soft)
  return (cx, cy) => {
    const local = (front - along(cx, cy)) / soft
    return local >= 1 || local > bayer8(cx - dx, cy - dy)
  }
}

/** Dissolve and Wipe: is this cell shown? (One-off form of `cellTest`.) */
export function cellShown(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): boolean {
  return cellTest(r, grid)(cx, cy)
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
  const slide = secondsIn(r) * r.drift * r.cell
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
): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(range.cols * range.rows * 4)
  const shown = cellTest(r, grid)
  for (let j = 0; j < range.rows; j++) for (let i = 0; i < range.cols; i++) {
    if (!shown(range.c0 + i, range.r0 + j)) px[(j * range.cols + i) * 4 + 3] = 255
  }
  return px
}
