import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { hash01, lerp, loopRatesOf, steppedPhase } from './util'

const controls: ControlSpec[] = [
  { key: 'danceSpread', label: 'Spread', kind: 'slider', min: 0.4, max: 2, step: 0.01, default: 1, group: 'Layout' },
]

/** One of n fixed spots scattered over the frame, each with its own size. A jittered grid,
 *  so spots never pile up; repeatable, so the scatter is the same every frame. */
function spot(j: number, n: number, spread: number) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.5))), rows = Math.max(1, Math.ceil(n / cols))
  const cx = (j % cols) - (cols - 1) / 2, cy = Math.floor(j / cols) - (rows - 1) / 2
  return {
    x: (cx + (hash01(j, 7) - 0.5) * 0.7) * (11 / cols) * spread,
    y: -(cy + (hash01(j, 8) - 0.5) * 0.7) * (7.5 / rows) * spread,
    scale: 0.55 + hash01(j, 9) * 0.95,
  }
}

/** A hop that lands far away: the smallest stride ≥ n/2 sharing no factor with n, so every
 *  card still visits every spot. */
function stride(n: number): number {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  for (let s = Math.max(1, Math.floor(n / 2)); s < n; s++) if (gcd(s, n) === 1) return s
  return 1
}

/** Cards swap places around a loose scatter of spots, all moving on the same beat and
 *  taking on the size of wherever they land. */
export const danceLayout: ShowcaseLayout = {
  id: 'dance', label: 'Position dance', family: 'Scatter', controls,
  place(i, n, p, t01): TileTransform {
    const slots = Math.max(1, n), hop = stride(slots), spread = Number(p.danceSpread)
    const phase = steppedPhase(n, p, t01), whole = Math.floor(phase), f = phase - whole
    const at = (k: number) => spot((((i + k) * hop) % slots + slots) % slots, slots, spread)
    const a = at(whole), b = at(whole + 1)
    return {
      x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: Math.sin(Math.PI * f) * 1.2 + i * 0.02, rotY: 0,
      scale: Number(p.cardSize) * lerp(a.scale, b.scale, f),
    }
  },
  loopRates: loopRatesOf,
}
