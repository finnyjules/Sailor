import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'haloRadius', label: 'Size', kind: 'slider', min: 1.5, max: 10, step: 0.1, default: 3.8, group: 'Layout' },
]

/** Cards circling in the plane of the screen, overlapping like a wreath, each staying
 *  upright (unlike Wheel spin, whose cards point out from the hub). */
export const haloLayout: ShowcaseLayout = {
  id: 'halo', label: 'Photo orbit', family: 'Orbits and wheels', controls,
  place(i, n, p, t01): TileTransform {
    const R = Number(p.haloRadius)
    const a = Math.PI / 2 - 2 * Math.PI * (i / Math.max(1, n) + travel(p, t01, n))
    // A fixed step in z per card keeps the overlap order steady all the way round.
    return { x: Math.cos(a) * R, y: Math.sin(a) * R, z: i * 0.04, rotY: 0, scale: Number(p.cardSize) * 1.15 }
  },
  loopRates: loopRatesOf,
}
