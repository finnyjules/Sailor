import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, steppedU } from './util'

const controls: ControlSpec[] = [
  { key: 'focusZoom', label: 'Hero size', kind: 'slider', min: 1, max: 4, step: 0.05, default: 2.4, group: 'Layout' },
]

/** A row where the middle card is the hero, several times the size of the cards queuing
 *  either side. The row moves a card at a time; each grows as it takes the middle. */
export const focusLayout: ShowcaseLayout = {
  id: 'focus', label: 'Focus slider', family: 'Carousels', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), size = Number(p.cardSize), zoom = Number(p.focusZoom)
    const s = (pmod(steppedU(i, n, p, t01) + 0.5, 1) - 0.5) * slots
    const c = Math.max(-1, Math.min(1, s)), side = Math.abs(c)
    // The first neighbour clears half the hero plus half itself; the rest follow at card pitch.
    const first = size * (zoom / 2 + 0.5 + 0.18)
    return {
      x: c * first + (s - c) * size * 1.12, y: 0, z: -side * 0.4, rotY: 0,
      scale: size * (zoom - (zoom - 0.9) * side), opacity: smoothstep(0, 1, slots / 2 - Math.abs(s)),
    }
  },
  loopRates: loopRatesOf,
}
