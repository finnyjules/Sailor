import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { hash01, loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'parallaxSpread', label: 'Spread', kind: 'slider', min: 1, max: 10, step: 0.1, default: 5.5, group: 'Layout' },
]

const LAYER_Z = [-7, -2, 3]   // far, middle, near
const HEIGHT = 20

/** Cards drifting up the frame on three depth layers. Near layers make more trips per loop
 *  than far ones — whole multiples, so the loop still closes — which is the parallax. */
export const parallaxLayout: ShowcaseLayout = {
  id: 'parallax', label: 'Parallax drift', family: 'Grids and walls', controls,
  place(i, n, p, t01): TileTransform {
    const layer = i % 3
    const y = (pmod(hash01(i, 1) + (layer + 1) * travel(p, t01, Math.ceil(n / 3)), 1) - 0.5) * HEIGHT
    return {
      x: (hash01(i, 2) - 0.5) * 2 * Number(p.parallaxSpread), y, z: LAYER_Z[layer]!, rotY: 0,
      scale: Number(p.cardSize) * 1.2, opacity: smoothstep(0, 2, HEIGHT / 2 - Math.abs(y)),
    }
  },
  loopRates: loopRatesOf,
}
