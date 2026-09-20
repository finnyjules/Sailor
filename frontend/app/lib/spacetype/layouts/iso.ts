import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, rowPlace, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'isoRows', label: 'Rows', kind: 'slider', min: 1, max: 8, step: 1, default: 4, group: 'Layout' },
  { key: 'isoGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Layout' },
  { key: 'isoLift', label: 'Swell', kind: 'slider', min: 0, max: 2, step: 0.01, default: 0.5, group: 'Motion' },
]

/** Cards laid on a tabletop seen from a corner, rows sliding against each other while a
 *  swell lifts them off the surface in turn. */
export const isoLayout: ShowcaseLayout = {
  id: 'iso', label: 'Iso cascade', family: 'Grids and walls', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const size = Number(p.cardSize) * 1.2, gap = Number(p.isoGap)
    const rows = Math.max(1, Math.min(Math.round(Number(p.isoRows) || 1), Math.max(1, n)))
    const row = i % rows
    const moved = travel(p, t01, Math.ceil(n / rows))
    const r = rowPlace(i, n, rows, aspects, size, gap, (row % 2 ? -1 : 1) * moved)
    // The swell is a whole wave along the row AND whole waves per trip, so neither the
    // row's wrap nor the loop's seam shows in it. It runs at twice the rows' pace: at the
    // same pace, the rows travelling with it would ride one crest and never move.
    const swell = Math.sin(2 * Math.PI * (r.x / r.length + row / rows + 2 * moved))
    return { x: r.x, y: -(row - (rows - 1) / 2) * size * (1 + gap), z: (swell * 0.5 + 0.5) * Number(p.isoLift), rotY: 0, scale: size, opacity: r.fade }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: -0.96, rotY: 0, rotZ: 0.785 } },
}
