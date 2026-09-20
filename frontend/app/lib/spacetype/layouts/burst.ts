import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { GOLDEN_ANGLE, hash01, loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'burstReach', label: 'Reach', kind: 'slider', min: 3, max: 14, step: 0.1, default: 8, group: 'Layout' },
]

/** Cards thrown out from the middle in every direction, growing as they come, one after
 *  another in a steady stream. */
export const burstLayout: ShowcaseLayout = {
  id: 'burst', label: 'Poster burst', family: 'Scatter', controls,
  place(i, n, p, t01): TileTransform {
    const u = pmod(i / Math.max(1, n) + travel(p, t01, n), 1)         // 0 = just born in the middle
    const a = i * GOLDEN_ANGLE, reach = u * u * Number(p.burstReach)
    return {
      x: Math.cos(a) * reach, y: Math.sin(a) * reach, z: u * 3, rotY: 0, rotZ: (hash01(i, 3) - 0.5) * 0.7,
      scale: Number(p.cardSize) * (0.25 + 1.6 * u), opacity: smoothstep(0, 0.12, u) * (1 - smoothstep(0.72, 1, u)),
    }
  },
  loopRates: loopRatesOf,
}
