import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'trailSpacing', label: 'Trail length', kind: 'slider', min: 0.005, max: 0.08, step: 0.001, default: 0.028, group: 'Layout' },
]

/** The first card sweeps a figure-of-eight; the rest follow in its wake, each a little
 *  later, smaller and fainter. The path closes on itself, so the loop does too. */
export const trailLayout: ShowcaseLayout = {
  id: 'trail', label: 'Image trail', family: 'Scatter', controls,
  place(i, n, p, t01): TileTransform {
    const k = i / Math.max(1, n)                                     // 0 head … →1 tail
    const v = 2 * Math.PI * (travel(p, t01, n) - i * Number(p.trailSpacing))
    return {
      x: Math.sin(v) * 4.6, y: Math.sin(2 * v + 0.6) * 2.6, z: -i * 0.06, rotY: 0,
      rotZ: Math.cos(v) * 0.18, scale: Number(p.cardSize) * (1.5 - 1.0 * k), opacity: 1 - 0.75 * k,
    }
  },
  loopRates: loopRatesOf,
}
