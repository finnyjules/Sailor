import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'bloomHub', label: 'Spine gap', kind: 'slider', min: 0, max: 3, step: 0.05, default: 0.35, group: 'Layout' },
]

/** Cards standing like the pages of an open book around a spine, turning about it. Each
 *  card's WIDTH runs out from the spine, so it is hinged there rather than facing out. */
export const bloomLayout: ShowcaseLayout = {
  id: 'bloom', label: 'Orbit bloom', family: 'Rings and globes', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const size = Number(p.cardSize) * 1.9
    const a = 2 * Math.PI * (i / Math.max(1, n) + travel(p, t01, n))
    const r = Number(p.bloomHub) + (aspects?.[i] || 1) * size / 2
    // local +X must point along the spoke (cos a, 0, sin a): a quad yawed by rotY has its
    // +X at (cos rotY, 0, −sin rotY), hence −a.
    return { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, rotY: Math.atan2(Math.sin(-a), Math.cos(-a)), scale: size }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0.5, rotY: 0, rotZ: 0.22 } },
}
