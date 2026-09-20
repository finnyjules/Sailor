import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'vortexRadius', label: 'Size', kind: 'slider', min: 2, max: 10, step: 0.1, default: 5.2, group: 'Layout' },
  { key: 'vortexRings', label: 'Rings', kind: 'slider', min: 1, max: 5, step: 1, default: 2, group: 'Layout' },
]

/** Concentric wheels of cards turning against each other, smaller toward the middle. */
export const vortexLayout: ShowcaseLayout = {
  id: 'vortex', label: 'Vortex spin', family: 'Orbits and wheels', controls,
  place(i, n, p, t01): TileTransform {
    const rings = Math.max(1, Math.min(Math.round(Number(p.vortexRings) || 1), Math.max(1, n)))
    const ring = i % rings
    const inRing = Math.ceil((Math.max(1, n) - ring) / rings)
    const k = (ring + 1) / rings                                    // 0…1 outward
    const R = Number(p.vortexRadius) * (0.3 + 0.7 * k)
    // Each ring starts a fraction of a slot on from the last, so the loop never opens with
    // the rings lined up in spokes.
    const a = Math.PI / 2 - 2 * Math.PI * ((Math.floor(i / rings) + ring / rings) / Math.max(1, inRing) + (ring % 2 ? -1 : 1) * travel(p, t01, inRing))
    return {
      x: Math.cos(a) * R, y: Math.sin(a) * R, z: 0, rotY: 0,
      rotZ: Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2)), scale: Number(p.cardSize) * (0.45 + 0.5 * k),
    }
  },
  loopRates: loopRatesOf,
}
