/**
 * A stroke whose fill FOLLOWS THE LINE: the paint is drawn into a straight strip as long as the
 * band's centreline and as deep as the band, then bent round the stroke piece by piece.
 *
 * Pure: no canvas, no DOM. `paintFollowedBand` in useCompositorLayers.ts is the one painter.
 * Spec: docs/superpowers/specs/2026-09-25-stroke-fill-follows-line.md
 */
import { isFill, isGradient, type Paint } from '~/lib/compositor/paint'

/** Which paints have anything to bend. A flat colour looks the same either way; foil and
 *  image fills are not in scope; a shader fill is a live field with no tile to repeat. */
export function paintCanFollow(paint: Paint | undefined): boolean {
  if (isGradient(paint)) return paint.stops.length > 0
  if (isFill(paint)) return paint.type !== 'solid' && paint.type !== 'shader'
  return false
}
