import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'orbitRadius', label: 'Size', kind: 'slider', min: 2, max: 10, step: 0.1, default: 5.4, group: 'Layout' },
  { key: 'orbitTilt', label: 'Tilt', kind: 'slider', min: -1.2, max: 1.2, step: 0.01, default: 0.42, group: 'Layout' },
]

/** The first card is the hero, large and still in the middle; the rest circle it, always
 *  facing the camera. The orbit is tilted here rather than by the group pose, so the hero
 *  stays square-on. */
export const orbitLayout: ShowcaseLayout = {
  id: 'orbit', label: 'Hero orbit', family: 'Orbits and wheels', controls,
  place(i, n, p, t01): TileTransform {
    const size = Number(p.cardSize)
    if (i === 0) return { x: 0, y: 0, z: 0, rotY: 0, scale: size * 1.7 }
    const a = 2 * Math.PI * ((i - 1) / Math.max(1, n - 1) + travel(p, t01, n - 1))
    const R = Number(p.orbitRadius), tilt = Number(p.orbitTilt)
    const z0 = Math.sin(a) * R
    return { x: Math.cos(a) * R, y: -z0 * Math.sin(tilt), z: z0 * Math.cos(tilt), rotY: 0, scale: size * 0.62 }
  },
  loopRates: loopRatesOf,
  depth(p) { return Number(p.orbitRadius) },
}
