// Adapters between the compositor fill gradient ({offset,color}) and the colour-lib
// stop shape ({pos,color}) that gradientTween speaks, plus the pure fill-scroll
// resolver. Keeps Paint/Gradient knowledge OUT of gradientTween.
import type { Gradient } from './paint'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import { scrollStops } from '~/lib/color/gradientTween'

export function paintStopsToColor(g: Gradient): ColorStop[] {
  return g.stops.map(s => ({ pos: s.offset, color: s.color }))
}

/** A new gradient of the same type/angle, stops replaced by the scrolled wheel. */
export function withScrolledStops(g: Gradient, phase: number): Gradient {
  const scrolled = scrollStops(paintStopsToColor(g), phase).map(s => ({ offset: s.pos, color: s.color }))
  return g.type === 'radial'
    ? { type: 'radial', stops: scrolled }
    : { type: 'linear', angle: g.angle, stops: scrolled }
}
