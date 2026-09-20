import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pathU, smoothstep } from './util'

const controls: ControlSpec[] = [
  { key: 'totemGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.1, group: 'Layout' },
  { key: 'totemSway', label: 'Sway', kind: 'slider', min: 0, max: 1.2, step: 0.01, default: 0.5, group: 'Layout' },
]

/** A column of cards rising past the camera, each turning one way then the other as it
 *  climbs. The turn is a whole wave along the column, so the wrap is invisible. */
export const totemLayout: ShowcaseLayout = {
  id: 'totem', label: 'Card totem', family: 'Carousels', controls,
  place(i, n, p, t01): TileTransform {
    const size = Number(p.cardSize)
    const length = Math.max(1, n) * size * (1 + Number(p.totemGap))
    const u = pathU(i, n, p, t01)
    const y = (u - 0.5) * length
    return {
      x: 0, y, z: 0, rotY: Math.sin(2 * Math.PI * u) * Number(p.totemSway), scale: size,
      opacity: smoothstep(0, size, length / 2 - Math.abs(y)),
    }
  },
  loopRates: loopRatesOf,
}
