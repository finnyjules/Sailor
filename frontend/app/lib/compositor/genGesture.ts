// Pure helpers for the Frame drag-to-generate gesture. Framework-free so the
// box-validity guard and the on-box bar placement are unit-testable without a DOM.

export interface GenGestureBounds { minX: number; minY: number; maxX: number; maxY: number }

/** Fixed defaults that replace the Generate-in-region panel's Style/Scene · Flux/Nano
 *  · box/brush/shape toggles for the streamlined gesture. */
export function genGestureDefaults(): { tool: 'box'; mode: 'style'; model: 'flux' } {
  return { tool: 'box', mode: 'style', model: 'flux' }
}

/** Reject click-sized boxes so a stray click never pops the bar. Mirrors the
 *  Draw-section min-size guard (normalized 0.005 × 0.002 of canvas WIDTH), applied to
 *  the box's pixel bounds. Height is normalized to WIDTH, matching the layer model. */
export function genBoxIsValid(bnd: GenGestureBounds, dispW: number, dispH: number): boolean {
  if (dispW <= 0) return false
  const wN = (bnd.maxX - bnd.minX) / dispW
  const hN = (bnd.maxY - bnd.minY) / dispW
  return wN >= 0.005 && hN >= 0.002
}

/** Place the on-box bar centred under the box, flipped above when it would fall off
 *  the bottom. Coordinates are artboard px (the overlay's own coordinate space). */
export function genBarPlacement(
  bnd: GenGestureBounds, dispW: number, dispH: number, barH = 44, margin = 12,
): { left: number; top: number; flip: boolean } {
  const cx = (bnd.minX + bnd.maxX) / 2
  const left = Math.min(Math.max(cx, 90), Math.max(90, dispW - 90))
  const below = bnd.maxY + margin
  const flip = below + barH > dispH
  const top = flip ? Math.max(margin, bnd.minY - margin - barH) : Math.min(below, dispH - barH)
  return { left, top, flip }
}
