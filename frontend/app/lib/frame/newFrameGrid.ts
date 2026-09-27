// A NEW Frame's layout grid (spec 2026-09-26-frame-layout-grid-design). `readLayoutGrid` reads
// "layers and no stored grid" as an old Frame and hides the grid, so every path that makes a Frame
// stamps a shown auto grid at birth — otherwise a Frame whose first layers arrive outside the modal
// (the card's Edit here, a template, a start-modal pick, a sent set entry) would be classed old.
// Auto: the values are re-derived from the Frame's size and format on every read; only `show` and
// the row mode are really stored.
import { suggestedLayoutGrid, layoutGridProperty, type LayoutGrid } from './layoutGrid'
import { formatFor } from './formats'
import { readFrameSize, type FrameSizeNodeData } from './frameSize'

/** The grid a new Frame starts with: the suggested auto grid for its size, shown. */
export function newFrameLayoutGrid(data: FrameSizeNodeData, keep?: { show?: boolean }): LayoutGrid {
  const { w, h } = readFrameSize(data)
  const W = w > 0 ? w : 1080, H = h > 0 ? h : 1080
  return { ...suggestedLayoutGrid(W, H, formatFor(data.properties ?? undefined, W, H)), show: keep?.show ?? true }
}

/** Stamp a new Frame's node data with its grid, unless it already carries one. */
export function stampNewFrameGrid(data: FrameSizeNodeData): void {
  const p = (data.properties ||= {})
  if (!p.sailor_layoutGrid) Object.assign(p, layoutGridProperty(newFrameLayoutGrid(data)))
}
