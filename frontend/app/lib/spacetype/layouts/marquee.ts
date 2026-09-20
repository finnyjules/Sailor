import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, rowPlace, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'marqueeAxis', label: 'Lanes', kind: 'select', options: ['rows', 'columns'], optionLabels: ['Rows', 'Columns'], default: 'rows', group: 'Layout' },
  { key: 'marqueeRows', label: 'Lane count', kind: 'slider', min: 1, max: 6, step: 1, default: 3, group: 'Layout' },
  { key: 'marqueeGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.12, group: 'Layout' },
]

/** Rows of cards sliding past each other, every other row the opposite way — or, with Flow
 *  set to Columns, columns rising and falling. */
export const marqueeLayout: ShowcaseLayout = {
  id: 'marquee', label: 'Mosaic marquee', family: 'Grids and walls', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const size = Number(p.cardSize) * 1.3, gap = Number(p.marqueeGap)
    const rows = Math.max(1, Math.min(Math.round(Number(p.marqueeRows) || 1), Math.max(1, n)))
    const row = i % rows
    const r = rowPlace(i, n, rows, aspects, size, gap, (row % 2 ? -1 : 1) * travel(p, t01, Math.ceil(n / rows)))
    const across = -(row - (rows - 1) / 2) * size * (1 + gap)
    if (String(p.marqueeAxis) === 'columns') {
      // Cards are a fixed height, so a column spaces evenly whatever the photos' widths.
      const c = rowPlace(i, n, rows, undefined, size, gap, (row % 2 ? -1 : 1) * travel(p, t01, Math.ceil(n / rows)))
      return { x: -across, y: c.x, z: 0, rotY: 0, scale: size, opacity: c.fade }
    }
    return { x: r.x, y: across, z: 0, rotY: 0, scale: size, opacity: r.fade }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0, rotY: 0, rotZ: -0.1 } },
}
