import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, steppedU } from './util'

const controls: ControlSpec[] = [
  { key: 'coverAxis', label: 'Orientation', kind: 'select', options: ['horizontal', 'vertical'], optionLabels: ['Sideways', 'Upright'], default: 'horizontal', group: 'Layout' },
  { key: 'coverSpacing', label: 'Spacing', kind: 'slider', min: 1, max: 2.5, step: 0.01, default: 1.25, group: 'Layout' },
]

/** A ring seen level from the front: one card square-on and large, its neighbours curving
 *  away behind it. Turns a card at a time. Upright stands the ring on its side. */
export const coverringLayout: ShowcaseLayout = {
  id: 'coverring', label: 'Cover ring', family: 'Rings and globes', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), size = Number(p.cardSize) * 2.3
    // Wide enough that neighbours clear each other; never so tight the ring folds up.
    const R = Math.max(size * 1.1, slots * size * Number(p.coverSpacing) / (2 * Math.PI))
    const a = 2 * Math.PI * (pmod(steppedU(i, n, p, t01) + 0.5, 1) - 0.5)   // 0 = the front card
    const along = R * Math.sin(a), z = R * Math.cos(a) - R
    return String(p.coverAxis) === 'vertical'
      ? { x: 0, y: along, z, rotY: 0, rotX: -a, scale: size }
      : { x: along, y: 0, z, rotY: a, scale: size }
  },
  loopRates: loopRatesOf,
}
