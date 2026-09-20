import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, steppedU } from './util'

const controls: ControlSpec[] = [
  { key: 'cascadeStep', label: 'Spacing', kind: 'slider', min: 0.2, max: 1.4, step: 0.01, default: 0.6, group: 'Layout' },
  { key: 'cascadeSlope', label: 'Slope', kind: 'slider', min: -1.5, max: 1.5, step: 0.01, default: -0.75, group: 'Layout' },
]

/** Overlapping cards stepping down a diagonal, each one laid over the last. The line moves
 *  a card at a time. */
export const cascadeLayout: ShowcaseLayout = {
  id: 'cascade', label: 'Cascade deck', family: 'Carousels', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), size = Number(p.cardSize) * 1.5
    const s = (pmod(steppedU(i, n, p, t01) + 0.5, 1) - 0.5) * slots
    const x = s * Number(p.cascadeStep) * size
    // z climbs along the line so the overlap order never flips mid-move.
    return { x, y: x * Number(p.cascadeSlope), z: s * 0.08, rotY: 0, scale: size, opacity: smoothstep(0, 1, slots / 2 - Math.abs(s)) }
  },
  loopRates: loopRatesOf,
}
