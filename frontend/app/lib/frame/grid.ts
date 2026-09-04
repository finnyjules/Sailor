// frontend/app/lib/frame/grid.ts
export interface Rect { x: number; y: number; w: number; h: number }

export interface FrameGrid {
  mode: 'off' | 'explicit' | 'generated'
  baseModule: number    // normalized to frame width; alignment unit
  gutter: number        // normalized to frame width
  margin: number        // normalized to frame width
  columns: number       // explicit mode
  rows: number          // explicit mode
  gen: {
    colRange: [number, number]
    rowRange: [number, number]
    regularity: number  // 0 free … 1 strict/equal
    merge: boolean
    mergeMaxSpan: number
    symmetry: 'none' | 'mirror'
    seed: number
  }
  overlay: boolean
}

export function defaultGrid(): FrameGrid {
  return {
    mode: 'off', baseModule: 1 / 12, gutter: 0.01, margin: 0.04,
    columns: 6, rows: 4,
    gen: { colRange: [3, 7], rowRange: [2, 5], regularity: 0.8, merge: true, mergeMaxSpan: 3, symmetry: 'none', seed: 42 },
    overlay: true,
  }
}

/** Even edges across [start,end] for `n` divisions, gutter-shrunk cells handled by the caller. */
function evenEdges(startPx: number, endPx: number, n: number): number[] {
  const step = (endPx - startPx) / n
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(Math.round(startPx + i * step))
  return out
}

/** From column/row edges, the per-cell region rects (no merge). */
function cellRegions(xs: number[], ys: number[]): Rect[] {
  const out: Rect[] = []
  for (let j = 0; j < ys.length - 1; j++)
    for (let i = 0; i < xs.length - 1; i++)
      out.push({ x: xs[i]!, y: ys[j]!, w: xs[i + 1]! - xs[i]!, h: ys[j + 1]! - ys[j]! })
  return out
}

export function resolveGrid(grid: FrameGrid, w: number, h: number): { xs: number[]; ys: number[]; regions: Rect[] } {
  if (grid.mode === 'off') return { xs: [], ys: [], regions: [] }
  const mx = grid.margin * w, my = grid.margin * w   // margin normalized to width on both axes (uniform inset)
  if (grid.mode === 'explicit') {
    const xs = evenEdges(mx, w - mx, Math.max(1, Math.round(grid.columns)))
    const ys = evenEdges(my, h - my, Math.max(1, Math.round(grid.rows)))
    return { xs, ys, regions: cellRegions(xs, ys) }
  }
  return { xs: [], ys: [], regions: [] }   // generated: Task 2
}
