import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { lerp, loopRatesOf, queuePos, smoothstep } from './util'

const controls: ControlSpec[] = [
  { key: 'shiftZoom', label: 'Hero size', kind: 'slider', min: 1.2, max: 3.5, step: 0.05, default: 2.3, group: 'Layout' },
]

const QUEUE = 3   // thumbnails shown in the column

/** A large hero on the left with the next few cards queued in a column on the right. The
 *  top of the column grows into the hero's place as the old hero fades. */
export const focusshiftLayout: ShowcaseLayout = {
  id: 'focusshift', label: 'Focus shift', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    const size = Number(p.cardSize), hero = size * Number(p.shiftZoom), thumb = size * 0.8
    const heroX = -thumb * 0.75, colX = heroX + hero / 2 + thumb * 0.75
    if (slots > 1 && r > slots - 1) {                                // the old hero, fading where it stands
      const q = slots - r
      return { x: heroX, y: 0, z: -0.2, rotY: 0, scale: hero * (1 - 0.06 * q), opacity: 1 - smoothstep(0, 0.8, q) }
    }
    const spot = (k: number) => ((QUEUE - 1) / 2 - (k - 1)) * thumb * 1.12   // column y for queue place k ≥ 1
    const k = Math.min(r, 1)
    return {
      x: lerp(heroX, colX, k), y: r <= 1 ? lerp(0, spot(1), k) : spot(r), z: 0.1 * (1 - k), rotY: 0,
      scale: lerp(hero, thumb, k), opacity: 1 - smoothstep(QUEUE, QUEUE + 1, r),
    }
  },
  loopRates: loopRatesOf,
}
