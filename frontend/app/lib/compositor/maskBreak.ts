/**
 * Mask break-out: open a silhouette mask on one side of a line so a masked
 * subject escapes an edge of its shape (the head pops over the top of a circle
 * while the body stays clipped). Pure; the renderer calls paintMaskRelease on
 * the mask offscreen just before its destination-in composite.
 */
export interface MaskBreak {
  x: number      // point on the line, normalized to canvas width/height
  y: number
  angle: number  // degrees; 0 = horizontal. Release side is +normal (up at 0).
}

export type MaskBreakEdge = 'top' | 'bottom' | 'left' | 'right'

/** Fill the release half-plane opaque-white on the mask offscreen. No-op if null. */
export function paintMaskRelease(mctx: CanvasRenderingContext2D, break_: MaskBreak | null | undefined, W: number, H: number): void {
  if (!break_) return
  const a = (break_.angle * Math.PI) / 180
  const px = break_.x * W, py = break_.y * H
  // Line direction (dx,dy); normal points to the release side.
  const dx = Math.cos(a), dy = Math.sin(a)
  const nx = Math.sin(a), ny = -Math.cos(a)
  const S = (W + H) * 4 // extend well past the canvas so the fill reaches every edge
  // Polygon: two far points along the line, pushed out along +normal.
  const ax = px - dx * S, ay = py - dy * S
  const bx = px + dx * S, by = py + dy * S
  mctx.save()
  mctx.beginPath()
  mctx.moveTo(ax, ay)
  mctx.lineTo(bx, by)
  mctx.lineTo(bx + nx * S, by + ny * S)
  mctx.lineTo(ax + nx * S, ay + ny * S)
  mctx.closePath()
  mctx.clip()
  mctx.fillStyle = '#ffffff'
  mctx.fillRect(0, 0, W, H)
  mctx.restore()
}

/** Build a break from an edge of the mask's bounding box (normalized) + an offset
 *  (0 = the shape edge, 1 = the opposite edge) along the inward normal. */
export function maskBreakFromEdge(edge: MaskBreakEdge, box: { x: number; y: number; w: number; h: number }, offset = 0): MaskBreak {
  const left = box.x - box.w / 2, right = box.x + box.w / 2
  const top = box.y - box.h / 2, bottom = box.y + box.h / 2
  const cx = box.x, cy = box.y
  switch (edge) {
    case 'top':    return { x: cx, y: top + offset * box.h, angle: 0 }
    case 'bottom': return { x: cx, y: bottom - offset * box.h, angle: 180 }
    case 'left':   return { x: left + offset * box.w, y: cy, angle: 90 }
    case 'right':  return { x: right - offset * box.w, y: cy, angle: 270 }
  }
}
