import type { LayoutDef } from '../kit/types'
import { bottomHeavy, footer, fourCorners, fullBleed, index, photoBehind, runoff, shapeCounter, statement, tilt } from './swissCore'
import { block, diagonal, edges, kicker, ragged, sidebar, spacedLines, staircase, wall } from './swissLines'
import { badge, cascade, cells, knockout, ring, scatter, shapeBleed, split } from './swissShapes'

// ORDER RULE (Ruling R9): a layout's index in this list seeds its random choices
// (`7000 + index·97 + 13 + arr·7919`, as in the prototype). The FINAL order of this list must
// equal the prototype's `def(...)` order in docs/superpowers/specs/assets/
// 2026-09-23-frame-layout-system/layout-sheet.html (def, then defNew, then defOver, top to
// bottom), so the seeds reproduce what the user approved there. Insert each ported layout at
// its prototype position — between its neighbours, not at the end. Until every layout is
// ported, indices past a gap shift as later tasks fill it; only the final order is binding.
export const LAYOUTS: LayoutDef[] = [
  runoff,
  statement,
  index,
  shapeCounter,
  photoBehind,
  fullBleed,
  tilt,
  bottomHeavy,
  fourCorners,
  spacedLines,
  ragged,
  edges,
  staircase,
  block,
  knockout,
  shapeBleed,
  badge,
  split,
  diagonal,
  wall,
  scatter,
  cascade,
  ring,
  cells,
  kicker,
  sidebar,
  footer,
  // defNew (plate … rising) and defOver (overprint … ghost) follow footer.
]

export function layoutById(id: string): LayoutDef | undefined {
  return LAYOUTS.find(l => l.id === id)
}

/** Tests only: add a layout to the catalog. Returns a function that removes it again. */
export function __registerLayoutForTest(def: LayoutDef): () => void {
  LAYOUTS.push(def)
  return () => {
    const i = LAYOUTS.indexOf(def)
    if (i >= 0) LAYOUTS.splice(i, 1)
  }
}
