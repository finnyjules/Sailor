import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'domeFlow', label: 'Lanes', kind: 'select', options: ['rows', 'columns'], optionLabels: ['Rows', 'Columns'], default: 'rows', group: 'Layout' },
  { key: 'domeRows', label: 'Lane count', kind: 'slider', min: 1, max: 8, step: 1, default: 3, group: 'Layout' },
  { key: 'domeCurve', label: 'Curve', kind: 'slider', min: 0.2, max: 1, step: 0.01, default: 0.6, group: 'Layout' },
]

// The wall's centre sits this far behind the origin; its radius follows from Curve.
const WALL_Z = 2

/** A wall of cards curving round the camera, seen from inside. Rows slide sideways against
 *  each other, or columns rise and fall — every other one the opposite way. */
export const domeLayout: ShowcaseLayout = {
  id: 'dome', label: 'Curved wall', family: 'Rings and globes', controls,
  place(i, n, p, t01): TileTransform {
    const size = Number(p.cardSize) * 1.35
    const R = 6 / Math.max(0.2, Number(p.domeCurve))          // tighter curve → smaller radius
    const rows = Math.max(1, Math.min(Math.round(Number(p.domeRows) || 1), Math.max(1, n)))
    const cols = Math.max(1, Math.ceil(Math.max(1, n) / rows))
    const step = size * 1.12 / R                                // angle between neighbours
    const byRows = String(p.domeFlow) !== 'columns'
    const row = i % rows, col = Math.floor(i / rows)
    const lane = byRows ? row : col
    const moved = (lane % 2 ? -1 : 1) * travel(p, t01, byRows ? cols : rows)
    // The moving axis wraps round its own length; the other axis is fixed.
    const lenA = cols * step, lenE = rows * step
    let a = (col - (cols - 1) / 2) * step, e = -(row - (rows - 1) / 2) * step, fade = 1
    if (byRows) { a = pmod(a + moved * lenA + lenA / 2, lenA) - lenA / 2; fade = smoothstep(0, step, lenA / 2 - Math.abs(a)) }
    else { e = pmod(e + moved * lenE + lenE / 2, lenE) - lenE / 2; fade = smoothstep(0, step, lenE / 2 - Math.abs(e)) }
    // A point on the inside of a sphere centred in front of the wall, facing that centre.
    return {
      x: R * Math.sin(a) * Math.cos(e), y: R * Math.sin(e), z: WALL_Z + R - R * Math.cos(a) * Math.cos(e),
      rotY: -a, rotX: e, scale: size, opacity: fade,
    }
  },
  loopRates: loopRatesOf,
}
