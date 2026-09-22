import { resolveGrid, type FrameGrid, type Rect } from '~/lib/frame/grid'

export interface Box { x: number; y: number; w: number; h: number }

/** Index of the single region `box` lies inside (edges may overhang by `tol` px), else -1. */
export function sectionOf(box: Box, regions: Rect[], tol: number): number {
  let found = -1
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!
    const inside = box.x >= r.x - tol && box.y >= r.y - tol
      && box.x + box.w <= r.x + r.w + tol && box.y + box.h <= r.y + r.h + tol
    if (!inside) continue
    if (found >= 0) return -1   // inside two overlapping regions: ambiguous → frame
    found = i
  }
  return found
}

/**
 * The grid resolved twice: at the design size (design px) and at the box (box px,
 * with margins/gutters following the fit scale `s`). Region order is stable
 * between the two, so index i is the same section in both. null when the grid is off.
 */
export function sectionsAt(grid: FrameGrid | null, W0: number, H0: number, s: number, W: number, H: number):
  { design: ReturnType<typeof resolveGrid>; box: ReturnType<typeof resolveGrid> } | null {
  if (!grid || grid.mode === 'off') return null
  return { design: resolveGrid(grid, W0, H0), box: resolveGrid(grid, W, H, s * W0) }
}
