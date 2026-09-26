import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'turnLeaves', label: 'Leaves', kind: 'slider', min: 3, max: 12, step: 1, default: 6, group: 'Layout' },
  { key: 'turnHub', label: 'Hub', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.06, group: 'Layout' },
  { key: 'turnTilt', label: 'Tilt', kind: 'slider', min: -0.8, max: 0.8, step: 0.01, default: 0.22, group: 'Layout' },
]

// The cards, in Card sizes.
const ZOOM = 1.9

/** Leaves standing out from an upright pole, turning like a revolving door a leaf at a
 *  time. A leaf shows its card only while its face is toward the camera — from behind the
 *  picture would read mirrored — and takes the next card while it is turned away, so every
 *  card comes round however few leaves there are. */
export const turnstileLayout: ShowcaseLayout = {
  id: 'turnstile', label: 'Revolving door', family: 'Orbits and wheels', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const count = Math.max(1, n)
    const leaves = Math.max(1, Math.min(count, Math.round(Number(p.turnLeaves) || 1)))
    const size = Number(p.cardSize) * ZOOM, w = (aspects?.[i] || 1) * size
    // Leaf steps so far. Appearance k is square to the camera at q = k and is on the door
    // for the half-turn either side; this card's appearance is the one in that window.
    const q = travel(p, t01, count, 'step') * count
    const first = Math.floor(q - leaves / 2) + 1
    const k = first + pmod(i - first, count)
    if (k > q + leaves / 2) return { x: 0, y: 0, z: 0, rotY: 0, scale: 1e-3, opacity: 0 }
    // Angle round the pole: −π/2 is the leaf on show, lying left of the pole, face on.
    const a = (2 * Math.PI * (k - q)) / leaves - Math.PI / 2
    const r = w / 2 + Number(p.turnHub) * size
    // Its face points toward the camera while it is on the left half (sin a < 0); it goes
    // edge-on at the front and back, and that is where it fades.
    const facing = -Math.sin(a)
    return {
      // The pole stands right of centre, so the leaf on show sits in the middle.
      x: Math.sin(a) * r + size * (0.5 + Number(p.turnHub)), y: 0, z: Math.cos(a) * r,
      rotY: a + Math.PI / 2, scale: size, opacity: smoothstep(0, 0.35, facing),
    }
  },
  loopRates: loopRatesOf,
  pose(p) { return { rotX: Number(p.turnTilt), rotY: 0, rotZ: 0 } },
}
