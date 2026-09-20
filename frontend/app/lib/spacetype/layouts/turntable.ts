import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'turntableCols', label: 'Columns', kind: 'slider', min: 1, max: 8, step: 1, default: 4, group: 'Layout' },
  { key: 'turntableGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Layout' },
]

/** A grid of cards lying on a tabletop that turns under the camera. The turn happens in the
 *  table's own plane (positions and roll together), so the tabletop pose stays put. */
export const turntableLayout: ShowcaseLayout = {
  id: 'turntable', label: 'Iso orbit', family: 'Grids and walls', controls,
  place(i, n, p, t01): TileTransform {
    const size = Number(p.cardSize) * 1.1
    const cols = Math.max(1, Math.round(Number(p.turntableCols) || 1))
    const rows = Math.max(1, Math.ceil(Math.max(1, n) / cols))
    const pitch = size * (1 + Number(p.turntableGap))
    const gx = ((i % cols) - (cols - 1) / 2) * pitch, gy = -(Math.floor(i / cols) - (rows - 1) / 2) * pitch
    const a = 2 * Math.PI * travel(p, t01, n), ca = Math.cos(a), sa = Math.sin(a)
    return { x: gx * ca - gy * sa, y: gx * sa + gy * ca, z: 0, rotY: 0, rotZ: Math.atan2(sa, ca), scale: size }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: -1.0, rotY: 0, rotZ: 0 } },
}
