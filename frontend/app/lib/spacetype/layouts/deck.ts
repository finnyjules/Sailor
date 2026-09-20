import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, queuePos, smoothstep } from './util'

// No dials of its own: Card size (in Cards) sets how large the card on show is.
const controls: ControlSpec[] = []

// The card on show, in Card sizes.
const ZOOM = 2.3

const SHOWN = 4   // cards visible in the pile behind the top one

/** A pile of cards, the edges of the next few peeking above the top one. The top card lifts
 *  away and fades; the pile shuffles forward. */
export const deckLayout: ShowcaseLayout = {
  id: 'deck', label: 'Deck peel', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    const size = Number(p.cardSize) * ZOOM
    const leaving = slots > 1 && r > slots - 1
    if (leaving) {
      const q = slots - r                                            // 0 → 1 as it peels off
      return { x: 0, y: q * size * 0.9, z: 0.4, rotY: 0, rotZ: q * 0.14, scale: size, opacity: 1 - smoothstep(0.1, 1, q) }
    }
    const depth = Math.min(r, SHOWN)
    return { x: 0, y: depth * size * 0.07, z: -depth * 0.25, rotY: 0, scale: size * (1 - 0.05 * depth), opacity: 1 - smoothstep(SHOWN - 1, SHOWN, r) }
  },
  loopRates: loopRatesOf,
}
