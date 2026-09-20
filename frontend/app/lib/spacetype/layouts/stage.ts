import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, queuePos, smoothstep } from './util'

// No dials of its own: Card size (in Cards) sets how large the card on show is.
const controls: ControlSpec[] = []

// The card on show, in Card sizes.
const ZOOM = 2.8

/** One card at a time, large in the middle. The next rises into place as the last swells
 *  and fades away. */
export const stageLayout: ShowcaseLayout = {
  id: 'stage', label: 'Centre stage', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    // Signed distance from the spot: +1 → 0 arriving, 0 → −1 leaving. Anything further is off.
    const d = Math.max(-1, Math.min(1, r <= slots / 2 ? r : r - slots))
    const size = Number(p.cardSize) * ZOOM
    return { x: 0, y: 0, z: -d * 0.6, rotY: 0, scale: size * (1 - 0.14 * d), opacity: 1 - smoothstep(0, 1, Math.abs(d)) }
  },
  loopRates: loopRatesOf,
}
