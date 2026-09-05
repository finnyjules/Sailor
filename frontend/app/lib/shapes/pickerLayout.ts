// Shared width for ShapePicker's floating panel and RowShape's anchor math — one number, not two.
export const SHAPE_PICKER_WIDTH = 360

// panel = 16 padding + 28 search row + 8 margin + 256 grid (max-h-64) = 308px, plus an 8px gap above the toolbar; the picker clamps itself if the guess is off
export const SHAPE_PICKER_APPROX_HEIGHT = 308 + 8

/** Anchor a ShapePicker above a toolbar cluster; the row-level pickers right-align instead — see RowShape. */
export function anchorAbove(rect: DOMRect | null | undefined): { x: number; y: number } {
  return rect ? { x: rect.left, y: Math.max(8, rect.top - SHAPE_PICKER_APPROX_HEIGHT) } : { x: 16, y: 16 }
}

// The Look library is wider than the shape picker: 4 card columns (~104px each) + the group rail.
export const LOOK_PICKER_WIDTH = 540
