import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, steppedU } from './util'

const controls: ControlSpec[] = [
  { key: 'flowAxis', label: 'Orientation', kind: 'select', options: ['horizontal', 'vertical'], optionLabels: ['Sideways', 'Upright'], default: 'horizontal', group: 'Layout' },
  { key: 'flowSpacing', label: 'Spacing', kind: 'slider', min: 0.2, max: 1.5, step: 0.01, default: 0.55, group: 'Layout' },
  { key: 'flowAngle', label: 'Side angle', kind: 'slider', min: 0, max: 1.4, step: 0.01, default: 1.05, group: 'Layout' },
]

/** One card faces the camera; the rest stand turned in rows either side. The row moves a
 *  card at a time and rests, so every card gets its moment in the middle. */
export const coverflowLayout: ShowcaseLayout = {
  id: 'coverflow', label: 'Cover flow', family: 'Carousels', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), size = Number(p.cardSize) * 1.5
    // Signed slots from the middle, in [−n/2, n/2). Card 0 opens the loop in the middle.
    const s = (pmod(steppedU(i, n, p, t01) + 0.5, 1) - 0.5) * slots
    const c = Math.max(-1, Math.min(1, s)), side = Math.abs(c)
    const along = s * Number(p.flowSpacing) * size + c * size * 0.6
    const turn = c * Number(p.flowAngle)
    const rest = {
      z: -side * size * 0.9 - Math.max(0, Math.abs(s) - 1) * 0.12,
      scale: size * (1 + 0.3 * (1 - side)),
      opacity: smoothstep(0, 1, slots / 2 - Math.abs(s)),
    }
    // Upright: the same flow stood on end — cards above lean down toward the middle.
    return String(p.flowAxis) === 'vertical'
      ? { x: 0, y: along, rotY: 0, rotX: turn, ...rest }
      : { x: along, y: 0, rotY: -turn, ...rest }
  },
  loopRates: loopRatesOf,
}
