import type { ControlSpec, Params } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'cubeTilt', label: 'Tilt', kind: 'slider', min: 0, max: 0.9, step: 0.01, default: 0.42, group: 'Layout' },
]

// The cube's edge, in Card sizes.
const ZOOM = 2.6

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** How many cards go round the sides, and how many quarter turns make one trip. The sides
 *  show cards in order, so a trip must end on a whole turn (a multiple of 4) AND back on the
 *  first card (a multiple of the side count): the least common multiple of the two. The
 *  base can't be seen from above, so it takes a card only when that makes the trip shorter
 *  (twelve cards: ten round the sides is 20 turns a trip, eleven would be 44). */
function cycle(n: number): { sides: number; steps: number; lid: boolean; base: boolean } {
  if (n < 6) return { sides: Math.max(1, n), steps: lcm4(Math.max(1, n)), lid: false, base: false }
  const both = lcm4(n - 2), lidOnly = lcm4(n - 1)
  return both <= lidOnly
    ? { sides: n - 2, steps: both, lid: true, base: true }
    : { sides: n - 1, steps: lidOnly, lid: true, base: false }
}
const lcm4 = (m: number) => (4 * m) / gcd(4, m)

/** Quarter turns so far, a face at a time with a rest on each. */
function quarterTurns(n: number, p: Params, t01: number): number {
  const { steps } = cycle(n)
  return travel(p, t01, steps, 'step') * steps
}

/** A cube of cards turning a face at a time. Each side takes the next card while it is
 *  round the back, so every card gets its turn on the front. With six or more cards the
 *  last two sit on the lid and the base. */
export const cubeLayout: ShowcaseLayout = {
  id: 'cube', label: 'Card cube', family: 'Rings and globes', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const edge = Number(p.cardSize) * ZOOM, h = edge / 2
    // A card fits inside its face whatever its shape, so a wide photo never pokes out.
    const scale = edge / Math.max(1, aspects?.[i] || 1)
    const count = Math.max(1, n), { sides } = cycle(count)
    const q = quarterTurns(count, p, t01), spin = (-q * Math.PI) / 2
    // The cards after the sides: the lid, then (when it takes one) the base.
    if (i >= sides) {
      const lid = i === sides
      return { x: 0, y: lid ? h : -h, z: 0, rotY: spin, rotX: lid ? -Math.PI / 2 : Math.PI / 2, scale }
    }
    // Appearance k is on the front at q = k, and its face takes a new card once it passes
    // the back (q = k + 2). This card's appearance is the first k after q − 2 with
    // k ≡ i (mod sides); only the four in (q − 2, q + 2] are on the cube.
    const first = Math.floor(q - 2) + 1
    const k = first + pmod(i - first, sides)
    if (k > q + 2) return { x: 0, y: 0, z: 0, rotY: 0, scale: 1e-3, opacity: 0 }
    // Face slots in turning order: front, right, back, left. Turning by −q quarter turns
    // brings slot k to the front at q = k.
    const yaw = (pmod(k, 4) * Math.PI) / 2 + spin
    return { x: Math.sin(yaw) * h, y: 0, z: Math.cos(yaw) * h, rotY: yaw, scale }
  },
  loopRates: loopRatesOf,
  // Turned a little off square, so the face on show and its neighbour both read as faces
  // of a solid rather than one flat card.
  pose(p) { return { rotX: Number(p.cubeTilt), rotY: -0.55, rotZ: 0 } },
  // Twelve cards is twenty turns a trip; at the usual one trip a loop that is a turn every
  // 0.3 s of a 6 s loop. Half speed gives each face time to be seen.
  hostDefaults: { speed: 0.5 },
}
