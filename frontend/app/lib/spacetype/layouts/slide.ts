import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, queuePos, smoothstep } from './util'

// No dials of its own: Card size (in Cards) sets how large the card on show is.
const controls: ControlSpec[] = []

// The card on show, in Card sizes.
const ZOOM = 2.8

const DROP = 16   // far enough below the frame that a waiting card is never seen

/** Each card slides up from below and lands over the last. Only the top card and the one
 *  arriving are ever in view; the rest wait below the frame. */
export const slideLayout: ShowcaseLayout = {
  id: 'slide', label: 'Stack slide', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    const size = Number(p.cardSize) * ZOOM
    // r 1 → 0: rising over the card on show (r = 0). Just left (r > n − 1): still in place,
    // underneath, until the newcomer has covered it. Everything else waits below.
    if (r <= 1) return { x: 0, y: -r * DROP, z: 0.3 * Math.min(1, r * 4), rotY: 0, scale: size }
    if (r > slots - 1) {
      // Sinks a touch and fades late, as the newcomer closes over it — so a card of a
      // different shape never blinks out from behind one that doesn't quite cover it.
      const q = slots - r
      return { x: 0, y: 0, z: -0.3 * q, rotY: 0, scale: size, opacity: 1 - smoothstep(0.8, 1, q) }
    }
    return { x: 0, y: -DROP, z: -0.6, rotY: 0, scale: size, opacity: 0 }
  },
  loopRates: loopRatesOf,
}
