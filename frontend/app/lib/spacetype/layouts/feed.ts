import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pathU, smoothstep } from './util'

const controls: ControlSpec[] = [
  { key: 'feedOffset', label: 'Stagger', kind: 'slider', min: 0, max: 1.5, step: 0.01, default: 0.6, group: 'Layout' },
  { key: 'feedOverlap', label: 'Overlap', kind: 'slider', min: 0, max: 0.6, step: 0.01, default: 0.25, group: 'Layout' },
]

/** A feed scrolling up the frame, cards stepping left and right of centre and tucking
 *  under one another. */
export const feedLayout: ShowcaseLayout = {
  id: 'feed', label: 'Feed scroll', family: 'Carousels', controls,
  place(i, n, p, t01): TileTransform {
    const size = Number(p.cardSize) * 1.35
    const length = Math.max(1, n) * size * (1 - Number(p.feedOverlap))
    const y = (pathU(i, n, p, t01) - 0.5) * length
    return {
      x: (i % 2 ? 1 : -1) * Number(p.feedOffset) * size, y, z: (i % 2) * 0.12, rotY: 0, scale: size,
      opacity: smoothstep(0, size, length / 2 - Math.abs(y)),
    }
  },
  loopRates: loopRatesOf,
}
