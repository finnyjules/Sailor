import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { endFade, loopRatesOf, pmod, smoothstep, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'beltLanes', label: 'Lanes', kind: 'slider', min: 1, max: 4, step: 1, default: 1, group: 'Layout' },
  { key: 'beltGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.12, group: 'Layout' },
  { key: 'beltTilt', label: 'Tilt', kind: 'slider', min: 0.3, max: 1.5, step: 0.01, default: 1.05, group: 'Layout' },
]

// The cards, in Card sizes.
const ZOOM = 2.1
// How much of the belt shows, front to back, in world units. A long belt runs on out of
// sight both ways instead of reaching past the camera.
const VIEW = 34

/** Cards lying flat on a belt, seen from steeply above, gliding toward the camera. */
export const conveyorLayout: ShowcaseLayout = {
  id: 'conveyor', label: 'Conveyor belt', family: 'Carousels', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const size = Number(p.cardSize) * ZOOM
    const lanes = Math.max(1, Math.min(Math.round(Number(p.beltLanes) || 1), Math.max(1, n)))
    const lane = i % lanes, perLane = Math.ceil(Math.max(1, n) / lanes)
    const gap = Number(p.beltGap) * size
    // Along the belt every card is one card deep (its height lies along it), so the belt's
    // length is a whole number of steps and one trip carries each card once round.
    const step = size + gap, length = perLane * step
    // Lanes stagger by half a card so a multi-lane belt doesn't march in ranks.
    const along = Math.floor(i / lanes) * step + (lane % 2) * step / 2
    const u = pmod(along / length + travel(p, t01, perLane), 1)
    const z = u * length - length / 2
    const x = (lane - (lanes - 1) / 2) * ((aspects?.[i] || 1) * size + gap)
    const inView = 1 - smoothstep(VIEW / 2 - step, VIEW / 2, Math.abs(z))
    // Lying flat, face up, its top edge pointing away from the camera.
    return { x, y: 0, z, rotY: 0, rotX: -Math.PI / 2, scale: size, opacity: endFade(u, Math.min(0.2, step / length)) * inView }
  },
  loopRates: loopRatesOf,
  pose(p) { return { rotX: Number(p.beltTilt), rotY: 0, rotZ: 0 } },
}
