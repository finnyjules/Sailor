import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { endFade, loopRatesOf, steppedU } from './util'

const controls: ControlSpec[] = [
  { key: 'fanReach', label: 'Reach', kind: 'slider', min: 2, max: 12, step: 0.1, default: 7, group: 'Layout' },
  { key: 'fanSpread', label: 'Spread', kind: 'slider', min: 0.3, max: 3, step: 0.01, default: 1.7, group: 'Layout' },
]

/** A hand of cards fanned from a pivot below the frame. Cards are dealt across the fan one
 *  at a time; the last one fades out and comes back in on the other side. */
export const fanLayout: ShowcaseLayout = {
  id: 'fan', label: 'Fan shuffle', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const L = Number(p.fanReach)
    const u = steppedU(i, n, p, t01)
    const a = (u - 0.5) * Number(p.fanSpread)
    // z steps up across the fan so overlapping cards stack in a fixed order.
    return { x: Math.sin(a) * L, y: (Math.cos(a) - 1) * L, z: u * 0.05 * Math.max(1, n), rotY: 0, rotZ: -a, scale: Number(p.cardSize) * 1.4, opacity: endFade(u, 0.1) }
  },
  loopRates: loopRatesOf,
}
