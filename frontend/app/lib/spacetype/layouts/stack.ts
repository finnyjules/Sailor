import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'stackDepth', label: 'Depth', kind: 'slider', min: 4, max: 30, step: 0.5, default: 10, group: 'Layout' },
  { key: 'stackRise', label: 'Rise', kind: 'slider', min: -1, max: 1, step: 0.01, default: 0.6, group: 'Layout' },
]

const NEAR_Z = 5

/** A deck receding from the camera, each card a step higher than the one in front. Cards
 *  come forward one after another; the front one fades out and rejoins at the back. */
export const stackLayout: ShowcaseLayout = {
  id: 'stack', label: 'Depth stack', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const depth = Number(p.stackDepth)
    const u = pmod(i / Math.max(1, n) - travel(p, t01, n), 1)   // 0 = front of the deck
    return {
      x: 0, y: (u - 0.35) * Number(p.stackRise) * depth * 0.5, z: NEAR_Z - u * depth, rotY: 0,
      scale: Number(p.cardSize) * 1.7, opacity: smoothstep(0, 0.1, u) * smoothstep(0, 0.35, 1 - u),
    }
  },
  loopRates: loopRatesOf,
}
