import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'wheelRadius', label: 'Size', kind: 'slider', min: 2, max: 12, step: 0.1, default: 6, group: 'Layout' },
  { key: 'wheelDrop', label: 'Drop', kind: 'slider', min: 0, max: 1.2, step: 0.01, default: 0.85, group: 'Layout' },
]

/** Cards round the rim of a wheel that faces the camera, each pointing out from the hub.
 *  Drop lowers the hub out of frame so only the top arc shows. */
export const wheelLayout: ShowcaseLayout = {
  id: 'wheel', label: 'Wheel spin', family: 'Orbits and wheels', controls,
  place(i, n, p, t01): TileTransform {
    const R = Number(p.wheelRadius)
    // Card 0 starts at the top; clockwise on screen is a DEcreasing angle.
    const a = Math.PI / 2 - 2 * Math.PI * (i / Math.max(1, n) + travel(p, t01, n))
    const rotZ = Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))
    return { x: Math.cos(a) * R, y: Math.sin(a) * R - R * Number(p.wheelDrop), z: 0, rotY: 0, rotZ, scale: Number(p.cardSize) }
  },
  loopRates: loopRatesOf,
}
