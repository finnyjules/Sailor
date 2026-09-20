import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { GOLDEN_ANGLE, loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'globeRadius', label: 'Size', kind: 'slider', min: 2, max: 12, step: 0.1, default: 4.5, group: 'Layout' },
]

// Keep cards off the poles, where they would pile up facing straight up and down.
const LAT_SPAN = 0.82

/** Cards tiled over a globe, each one lying ON the surface (pitched as well as turned) —
 *  unlike Sphere wall, whose cards stay upright. */
export const globeLayout: ShowcaseLayout = {
  id: 'globe', label: 'Card globe', family: 'Rings and globes', controls,
  place(i, n, p, t01): TileTransform {
    const R = Number(p.globeRadius)
    const ny = (1 - 2 * (i + 0.5) / Math.max(1, n)) * LAT_SPAN
    const rad = Math.sqrt(Math.max(0, 1 - ny * ny))
    const th = i * GOLDEN_ANGLE + 2 * Math.PI * travel(p, t01, n)
    const nx = Math.cos(th) * rad, nz = Math.sin(th) * rad
    // Host order is yaw → pitch: a +Z quad ends up facing (sin yaw·cos pitch, −sin pitch,
    // cos yaw·cos pitch), so the outward normal (nx, ny, nz) needs these two angles.
    return { x: nx * R, y: ny * R, z: nz * R, rotY: Math.atan2(nx, nz), rotX: -Math.asin(ny), scale: Number(p.cardSize) }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0.18, rotY: 0, rotZ: -0.2 } },
  bendRadius(p) { return Number(p.globeRadius) },
  depth(p) { return Number(p.globeRadius) },
}
