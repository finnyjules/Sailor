import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { hash01, loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'tossHeight', label: 'Height', kind: 'slider', min: 4, max: 16, step: 0.1, default: 10.5, group: 'Layout' },
  { key: 'tossSpin', label: 'Spin', kind: 'slider', min: 0, max: 6, step: 0.05, default: 2.2, group: 'Motion' },
]

const FLOOR = -9.5   // launch and landing height, below the frame

/** Cards tossed up from below the frame, tumbling through an arc and dropping back out —
 *  several in the air at once. */
export const tossLayout: ShowcaseLayout = {
  id: 'toss', label: 'Card toss', family: 'Scatter', controls,
  place(i, n, p, t01): TileTransform {
    const u = pmod(i / Math.max(1, n) + travel(p, t01, n), 1)
    const side = hash01(i, 4) < 0.5 ? -1 : 1
    const x0 = (hash01(i, 5) - 0.5) * 9
    return {
      x: x0 + side * (u - 0.5) * 3.5, y: FLOOR + 4 * Number(p.tossHeight) * u * (1 - u), z: (hash01(i, 6) - 0.5) * 3, rotY: 0,
      rotZ: side * (u - 0.5) * Number(p.tossSpin), scale: Number(p.cardSize) * 1.35, opacity: smoothstep(0, 0.06, u) * smoothstep(0, 0.06, 1 - u),
    }
  },
  loopRates: loopRatesOf,
}
