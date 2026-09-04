// Bridges a seed-engine PaletteFamily onto GeoShape's discrete `fills` list —
// the first DISCRETE-palette consumer (gradient consumers project through
// gradientize/toStops instead; see lib/color/project.ts).
import { distribute } from '~/lib/color/project'

/** Apply a palette as discrete GeoShape fills. Flips fillStrategy off 'single'
 *  (its default) or the write is invisible — GeoShape only reads `fills` in
 *  perClone/pieces mode.
 *
 *  `mark.fills` is typed `unknown[]` (only `.length` is read) rather than
 *  `string[]` because the real caller's fills are `Paint[]` (string | Gradient |
 *  Fill | ImageFill, see lib/compositor/paint.ts) — widening here avoids pulling
 *  that type into this pure helper while staying assignable from both. */
export function distributeToGeoFills(
  mark: { fills: unknown[]; fillStrategy: string },
  hexes: string[],
): { fills: string[]; fillStrategy: string } {
  const fills = distribute(hexes, Math.max(hexes.length, mark.fills.length), 'cycle')
  const fillStrategy = mark.fillStrategy === 'single' ? 'perClone' : mark.fillStrategy
  return { fills, fillStrategy }
}
