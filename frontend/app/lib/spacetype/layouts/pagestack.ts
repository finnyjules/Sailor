import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'pagePer', label: 'Cards per page', kind: 'slider', min: 1, max: 8, step: 1, default: 3, group: 'Layout' },
  { key: 'pageGap', label: 'Gap', kind: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.08, group: 'Layout' },
  { key: 'pageTilt', label: 'Tilt', kind: 'slider', min: 0.2, max: 1.4, step: 0.01, default: 1.1, group: 'Layout' },
]

// The room one page's cards may take across, in world units; a page of many cards shrinks
// its cards to fit rather than running off the sides.
const FIT_W = 11
const SHOWN = 3        // pages visible in the stack under the top one
const LAYER = 0.28     // how far each page sits under the one above, in card sizes

/** Pages of cards lying in a stack, seen from above. The cards on a page sit side by side
 *  (two rows once a page holds more than four); the top page lifts away and the next one is
 *  underneath, resting before it goes too. */
export const pagestackLayout: ShowcaseLayout = {
  id: 'pagestack', label: 'Page stack', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const count = Math.max(1, n)
    const per = Math.max(1, Math.min(count, Math.round(Number(p.pagePer) || 1)))
    const pages = Math.ceil(count / per)
    const page = Math.floor(i / per), k = i % per
    const onPage = Math.min(per, count - page * per)
    const cols = onPage <= 4 ? onPage : Math.ceil(onPage / 2), rows = Math.ceil(onPage / cols)
    const pitch = 1 + Number(p.pageGap)
    const size = Math.min(Number(p.cardSize) * 1.8, FIT_W / (Math.max(cols, Math.min(per, 4)) * pitch))
    // Laid flat on the page: across, and front-to-back for a second row.
    const x = (k % cols - (cols - 1) / 2) * size * pitch
    const z = (Math.floor(k / cols) - (rows - 1) / 2) * size * pitch
    // The page's place in the stack: 0 on top, then the pages under it. Page 0 opens the loop.
    const r = pmod(page - travel(p, t01, pages, 'step') * pages, pages)
    const flat = -Math.PI / 2
    if (pages > 1 && r > pages - 1) {
      // Lifting away: up off the stack and back out of the top of the frame, peeling as it goes.
      const q = pages - r
      return {
        x, y: q * size * 1.6, z: z - q * size * 2.2, rotY: 0, rotX: flat + q * 0.45, scale: size,
        opacity: 1 - smoothstep(0.25, 1, q),
      }
    }
    // The page that just lifted rejoins at the bottom, fading in as the stack rises.
    const rejoin = pages > 1 ? smoothstep(0, 1, pages - 1 - r) : 1
    return {
      x, y: -r * size * LAYER, z, rotY: 0, rotX: flat, scale: size,
      opacity: rejoin * (1 - smoothstep(SHOWN - 1, SHOWN, r)),
    }
  },
  loopRates: loopRatesOf,
  pose(p) { return { rotX: Number(p.pageTilt), rotY: 0, rotZ: 0 } },
}
