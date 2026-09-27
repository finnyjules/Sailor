// Stage 3: after a layout runs on the Frame's layout grid, its text is settled onto the grid
// (spec 2026-09-26-frame-layout-grid-design, "The Layout tab on this grid"). A block of text within
// one unit of a row top hangs its capitals from it, or within one unit of a row bottom stands its
// lowest baseline on it (whichever is nearer); every other line moves at most half a unit, so its
// first baseline is on the baseline grid. The checker's rules 11 and 12 then hold for everything
// the layout placed on purpose. Mutates the elements' `top` / `base`; a sheet with no grid is left alone.
import type { El, Sheet } from './types'
import { GRID_EPS, onGridText, textBlocks, textMarks } from './check'

export function settleOnGrid(els: El[], S: Sheet): void {
  const U = S.U
  if (!(U > 0)) return
  const up = (y: number) => Math.ceil((y + S.Y0) / U - 1e-9) * U - S.Y0
  const near = (y: number) => Math.round((y + S.Y0) / U) * U - S.Y0
  const move = (e: El, dy: number) => {
    if (e.k !== 't' && e.k !== 'own') return
    if (e.top != null) e.top += dy
    else if (e.base != null) e.base += dy
  }
  const anchored = new Set<El>()
  for (const bl of S.rows.length ? textBlocks(els, S) : []) {
    let bestDy = Infinity
    let anchor: El | null = null
    for (const r of S.rows) {
      if (Math.abs(r.a - bl.capTop) <= U + GRID_EPS) {
        // Capitals on the row top: the first baseline goes to the first grid line at or below
        // (row top + capital height) — exact for whole-unit capitals, within a unit otherwise.
        const dy = up(r.a + bl.capH) - bl.capH - bl.capTop
        if (Math.abs(dy) < Math.abs(bestDy) - GRID_EPS) { bestDy = dy; anchor = bl.els[0]! }
      }
      if (Math.abs(r.b - bl.lastBase) <= U + GRID_EPS) {
        const dy = r.b - bl.lastBase
        if (Math.abs(dy) < Math.abs(bestDy) - GRID_EPS) { bestDy = dy; anchor = bl.last }
      }
    }
    if (anchor) {
      for (const e of bl.els) move(e, bestDy)
      anchored.add(anchor)
    }
  }
  for (const e of els) {
    if (!onGridText(e) || anchored.has(e) || (e.top == null && e.base == null)) continue
    const b = textMarks(e, S).baselines[0]!
    move(e, near(b) - b)
  }
}
