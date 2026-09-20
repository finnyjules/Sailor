import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { endFade, loopRatesOf, pathU } from './util'

const controls: ControlSpec[] = [
  { key: 'spiralRadius', label: 'Size', kind: 'slider', min: 1.5, max: 10, step: 0.1, default: 3.6, group: 'Layout' },
  { key: 'spiralHeight', label: 'Height', kind: 'slider', min: 2, max: 20, step: 0.1, default: 9, group: 'Layout' },
  { key: 'spiralCoils', label: 'Coils', kind: 'slider', min: 0.5, max: 5, step: 0.25, default: 2, group: 'Layout' },
]

/** Cards climb a helix. A card that reaches the top re-enters at the bottom, so both ends
 *  fade — which is also why Coils needn't be a whole number. */
export const spiralLayout: ShowcaseLayout = {
  id: 'spiral', label: 'Spiral stream', family: 'Rings and globes', controls,
  place(i, n, p, t01): TileTransform {
    const R = Number(p.spiralRadius)
    const u = pathU(i, n, p, t01)
    const th = 2 * Math.PI * Number(p.spiralCoils) * u
    return {
      x: Math.cos(th) * R, y: (u - 0.5) * Number(p.spiralHeight), z: Math.sin(th) * R,
      rotY: Math.atan2(Math.cos(th), Math.sin(th)), scale: Number(p.cardSize), opacity: endFade(u),
    }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0.12, rotY: 0, rotZ: 0.16 } },
  bendRadius(p) { return Number(p.spiralRadius) },
  depth(p) { return Number(p.spiralRadius) },
}
