import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, queuePos, smoothstep } from './util'

const controls: ControlSpec[] = [
  { key: 'dominoGap', label: 'Spacing', kind: 'slider', min: 0.2, max: 1.5, step: 0.01, default: 0.8, group: 'Layout' },
  { key: 'dominoAngle', label: 'Side angle', kind: 'slider', min: -1.2, max: 1.2, step: 0.01, default: 0.5, group: 'Layout' },
]

// The card on show, in Card sizes.
const ZOOM = 1.9
const SHOWN = 5   // cards standing in the row behind the one on show

/** Cards standing in a row like dominoes. The front one falls flat toward the camera and
 *  shows the next; the row steps up and rests before the next one goes. */
export const dominoLayout: ShowcaseLayout = {
  id: 'domino', label: 'Domino fall', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    const size = Number(p.cardSize) * ZOOM, half = size / 2
    if (slots > 1 && r > slots - 1) {
      // Falling: 0 → 1 across the step, gathering speed like a real topple. It turns about
      // its bottom edge, so the centre swings down and forward round that edge.
      const q = slots - r, fall = q * q * (Math.PI / 2)
      return {
        x: 0, y: -half + half * Math.cos(fall), z: half * Math.sin(fall), rotY: 0, rotX: fall,
        scale: size, opacity: 1 - smoothstep(0.75, 1, q),
      }
    }
    // Standing: one spacing apart going back. The card that just fell rejoins at the end of
    // the row, fading in as the row steps up.
    const rejoin = slots > 1 ? smoothstep(0, 1, slots - 1 - r) : 1
    return {
      x: 0, y: 0, z: -r * size * Number(p.dominoGap), rotY: 0, scale: size,
      opacity: rejoin * (1 - smoothstep(SHOWN - 1, SHOWN, r)),
    }
  },
  loopRates: loopRatesOf,
  pose(p) { return { rotX: 0.12, rotY: Number(p.dominoAngle), rotZ: 0 } },
}
