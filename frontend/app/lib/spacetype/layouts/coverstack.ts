import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, steppedPhase } from './util'

const controls: ControlSpec[] = [
  { key: 'coverPeek', label: 'Peek', kind: 'slider', min: 0, max: 0.4, step: 0.01, default: 0.12, group: 'Layout' },
  { key: 'coverAngle', label: 'Side angle', kind: 'slider', min: -0.8, max: 0.8, step: 0.01, default: 0.22, group: 'Layout' },
]

// The card on show, in Card sizes.
const ZOOM = 2.4
const PILE = 4   // earlier cards peeking out behind the one on show

/** One card large on show, the earlier ones piled behind it and peeking out on the left.
 *  Each new card slides in from the right, turning square as it lands on top. */
export const coverstackLayout: ShowcaseLayout = {
  id: 'coverstack', label: 'Cover stack', family: 'Stacks and decks', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const slots = Math.max(1, n)
    const size = Number(p.cardSize) * ZOOM, w = (aspects?.[i] || 1) * size
    // Steps since this card was on show: 0 on show, 1 the one before, … The next to arrive
    // counts up from n − 1 to n (≡ 0) as it slides in. Card 0 opens the loop on show.
    const a = pmod(steppedPhase(n, p, t01) - i, slots)
    if (slots > 1 && a > slots - 1) {
      const u = a - (slots - 1)                                  // 0 → 1 as it lands
      return {
        x: (1 - u) * w * 1.15, y: 0, z: (1 - u) * 0.3, rotY: -(1 - u) * 0.5, scale: size,
        opacity: smoothstep(0, 0.35, u),
      }
    }
    // The pile: each earlier card a little further left, further back and smaller. A short
    // list fades its oldest card out before that card is needed to arrive again.
    const fresh = slots > 1 ? smoothstep(0, 1, slots - 1 - a) : 1
    return {
      x: -a * Number(p.coverPeek) * w, y: 0, z: -a * 0.12, rotY: 0, scale: size * (1 - 0.03 * a),
      opacity: fresh * (1 - smoothstep(PILE - 1, PILE, a)),
    }
  },
  loopRates: loopRatesOf,
  pose(p) { return { rotX: 0, rotY: Number(p.coverAngle), rotZ: 0 } },
}
