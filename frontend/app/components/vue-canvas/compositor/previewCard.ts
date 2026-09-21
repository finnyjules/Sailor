// The tiny synthetic "card" every gallery tile's live preview draws over: a rounded
// rectangle with a diagonal `#7c9cff → #ff7ac3` gradient and a white caption bar,
// transparent everywhere outside it — so a reveal/settle preview reads as a shape
// appearing or resolving, not as noise filling the whole tile.
//
// Shared by `MotionDitherPreview.vue` (Dither / Assemble) and `MotionSettlePreview.vue`
// (the ten settle effects) so every tile's tiny canvas agrees on what "the layer" looks
// like. Pure: no Vue, no DOM beyond the typed array it returns.

export const PREVIEW_COLS = 48
export const PREVIEW_ROWS = 30
const INSET_X = 5
const INSET_Y = 4
const RADIUS = 4

/** Is grid cell (x, y) inside the inset rounded card? Cell-granularity rounded-rect test. */
export function insidePreviewCard(x: number, y: number, cols = PREVIEW_COLS, rows = PREVIEW_ROWS): boolean {
  const x0 = INSET_X, y0 = INSET_Y, x1 = cols - INSET_X, y1 = rows - INSET_Y
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false
  const cx = x < x0 + RADIUS ? x0 + RADIUS : x >= x1 - RADIUS ? x1 - RADIUS : x
  const cy = y < y0 + RADIUS ? y0 + RADIUS : y >= y1 - RADIUS ? y1 - RADIUS : y
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

/** Built once per component instance: a rounded card, a diagonal gradient, and a white bar
 *  standing in for a caption — transparent everywhere outside the card. Callers re-sample
 *  this same buffer every frame; it never changes. */
export function buildPreviewCard(cols = PREVIEW_COLS, rows = PREVIEW_ROWS): Uint8ClampedArray {
  const px = new Uint8ClampedArray(cols * rows * 4)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!insidePreviewCard(x, y, cols, rows)) continue
      const i = (y * cols + x) * 4
      const t = (x / (cols - 1) + y / (rows - 1)) / 2
      px[i] = 0x7c + (0xff - 0x7c) * t
      px[i + 1] = 0x9c + (0x7a - 0x9c) * t
      px[i + 2] = 0xff + (0xc3 - 0xff) * t
      px[i + 3] = 255
    }
  }
  const barY0 = Math.round(rows * 0.6), barY1 = Math.round(rows * 0.72)
  const barX0 = INSET_X + 3, barX1 = cols - INSET_X - 3
  for (let y = barY0; y < barY1; y++) {
    for (let x = barX0; x < barX1; x++) {
      if (!insidePreviewCard(x, y, cols, rows)) continue
      const i = (y * cols + x) * 4
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255
    }
  }
  return px
}
