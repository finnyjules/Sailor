import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { dominoLayout } from './domino'
import { loopRatesOf } from './util'

// No dials of its own: Card size (in Cards) sets how large the card on show is.
const controls: ControlSpec[] = []

/** The card on show tips forward toward the camera from its bottom edge and falls away,
 *  showing the next one right behind it. Domino fall's move, with the row closed up and
 *  seen straight on. */
export const peelLayout: ShowcaseLayout = {
  id: 'peel', label: 'Peel', family: 'Stacks and decks', controls,
  place(i, n, p, t01, aspects): TileTransform {
    return dominoLayout.place(i, n, { ...p, dominoGap: 0.02 }, t01, aspects)
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0.06, rotY: 0, rotZ: 0 } },
}
