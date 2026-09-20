import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, rowPlace, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'stripGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.12, group: 'Layout' },
]

/** A single strip of cards running past the camera at an angle. */
export const filmstripLayout: ShowcaseLayout = {
  id: 'filmstrip', label: 'Film strip', family: 'Carousels', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const size = Number(p.cardSize) * 1.25
    const r = rowPlace(i, n, 1, aspects, size, Number(p.stripGap), travel(p, t01, n))
    return { x: r.x, y: 0, z: 0, rotY: 0, scale: size, opacity: r.fade }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0, rotY: -0.5, rotZ: -0.08 } },
}
