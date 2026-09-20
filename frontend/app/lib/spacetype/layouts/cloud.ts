import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { GOLDEN_ANGLE, loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'cloudRadius', label: 'Size', kind: 'slider', min: 1, max: 8, step: 0.1, default: 3, group: 'Layout' },
]

/** A loose ball of cards turning about its axis while every card keeps facing the camera —
 *  so it reads as a cluster of pictures, not a solid. */
export const cloudLayout: ShowcaseLayout = {
  id: 'cloud', label: 'Orbit globe', family: 'Rings and globes', controls,
  place(i, n, p, t01): TileTransform {
    const R = Number(p.cloudRadius)
    const y = 1 - 2 * (i + 0.5) / Math.max(1, n)
    const rad = Math.sqrt(Math.max(0, 1 - y * y))
    const th = i * GOLDEN_ANGLE + 2 * Math.PI * travel(p, t01, n)
    return { x: Math.cos(th) * rad * R, y: y * R * 0.8, z: Math.sin(th) * rad * R, rotY: 0, scale: Number(p.cardSize) * 1.15 }
  },
  loopRates: loopRatesOf,
  depth(p) { return Number(p.cloudRadius) },
}
