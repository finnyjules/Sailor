import type { ResolvedGrid, Measure } from './types'

export interface PxBox { x: number; y: number; w: number; h: number }

/** The content rectangle in px: margin is normalized to width, inset uniformly. */
export function marginBox(frame: { w: number; h: number }, margin: number): PxBox {
  const m = margin * frame.w
  return { x: m, y: m, w: frame.w - 2 * m, h: frame.h - 2 * m }
}

/** A px box (top-left + size) → normalized CENTRE coordinates (LocalLayer space). */
export function toNorm(box: PxBox, frame: { w: number; h: number }): { x: number; y: number } {
  return { x: (box.x + box.w / 2) / frame.w, y: (box.y + box.h / 2) / frame.h }
}

/** A px length → normalized to frame WIDTH (as fontSize/boxW are stored). */
export function normLen(px: number, frameW: number): number {
  return px / frameW
}

/** Font size in px so `text` renders `targetPx` wide, by linear scale from measure@100. */
export function fitSize(text: string, targetPx: number, measure: Measure): number {
  const at100 = measure(text)
  if (at100 <= 0) return 0
  return (100 * targetPx) / at100
}

function nearest(px: number, edges: number[]): number {
  if (!edges.length) return px
  let best = edges[0]!, bd = Math.abs(px - best)
  for (const e of edges) { const d = Math.abs(px - e); if (d < bd) { bd = d; best = e } }
  return best
}

export function snapX(px: number, grid: ResolvedGrid | null): number {
  return grid ? nearest(px, grid.xs) : px
}
export function snapY(px: number, grid: ResolvedGrid | null): number {
  return grid ? nearest(px, grid.ys) : px
}
