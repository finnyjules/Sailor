// Keeps a screen-space label chip (a constraint badge, an arc radius chip)
// fully inside the overlay, so a chip that lands near an edge is never cut
// off — e.g. the "R" at the right edge that motivated this (spec: "Radius
// labels stay on screen"). Pure; no doc, no solve.

/** Clamp a single scalar into [lo, hi]; if the range is degenerate
 *  (lo > hi — the overlay is narrower/shorter than the chip plus its
 *  margins) falls back to `lo` rather than producing NaN or an inverted range. */
export function clampRange(v: number, lo: number, hi: number): number {
  return hi >= lo ? Math.min(hi, Math.max(lo, v)) : lo
}

/** The clamped top-left corner (x, y) for a chip rect of `chipWidth` ×
 *  `chipHeight`, naively placed at (rawX, rawY), inside an overlay of
 *  `width` × `height` screen px — x kept in [4, width - chipWidth - 4],
 *  y kept in [16, height - 4]. */
export function clampChipOrigin(
  rawX: number, rawY: number,
  chipWidth: number, width: number, height: number,
): { x: number; y: number } {
  return {
    x: clampRange(rawX, 4, width - chipWidth - 4),
    y: clampRange(rawY, 16, height - 4),
  }
}
