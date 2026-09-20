import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const GA = Math.PI * (3 - Math.sqrt(5))

const controls: ControlSpec[] = [
  { key: 'sphereRadius', label: 'Size', kind: 'slider', min: 2, max: 12, step: 0.1, default: 5, group: 'Layout' },
]

export const sphereLayout: ShowcaseLayout = {
  id: 'sphere', label: 'Sphere wall', family: 'Rings and globes', controls,
  place(i, n, p, t01): TileTransform {
    const R = Number(p.sphereRadius)
    const spin = 2 * Math.PI * travel(p, t01, n)
    const y = 1 - 2 * (i + 0.5) / Math.max(1, n)
    const rad = Math.sqrt(Math.max(0, 1 - y * y))
    const th = i * GA + spin
    // Face outward-horizontally: a quad's +Z normal turned by rotY becomes (sin rotY, 0, cos rotY);
    // we want it = the outward radial (cos th, 0, sin th), so rotY = atan2(cos th, sin th) (= π/2−th,
    // wrapped) — same convention as the ring. NOT atan2(sin,cos), which points the card tangentially.
    return { x: Math.cos(th) * rad * R, y: y * R, z: Math.sin(th) * rad * R, rotY: Math.atan2(Math.cos(th), Math.sin(th)), scale: Number(p.cardSize) }
  },
  loopRates: loopRatesOf,
  pose() { return { rotX: 0.22, rotY: 0, rotZ: -0.12 } },
  depth(p) { return Number(p.sphereRadius) },
}
