import type { ControlSpec, Params } from '../effect'
import { ringTransform, type TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'radius', label: 'Size', kind: 'slider', min: 2, max: 12, step: 0.1, default: 5, group: 'Layout' },
  { key: 'ringOpening', label: 'Opening', kind: 'slider', min: -1, max: 1, step: 0.01, default: 0.55, group: 'Layout' },
  { key: 'ringTilt', label: 'Tilt', kind: 'slider', min: -1.2, max: 1.2, step: 0.01, default: -0.28, group: 'Layout' },
]

// Ring opening's max lean off top-down (radians, ~80deg): opening 1 reveals the full
// circle face-on to the camera path; opening 0 collapses the ring to head-on.
export const OPEN_MAX = 1.4

export const ringLayout: ShowcaseLayout = {
  id: 'ring',
  label: 'Ring', family: 'Rings and globes',
  controls,
  place(i, n, p, t01): TileTransform {
    // The ring's spin is speed × direction × time; hand it the shaped travel as its "time"
    // at unit speed, so Motion / Easing / There-and-back reach the ring like every layout.
    return ringTransform(i, n, {
      radius: Number(p.radius), ringTilt: Number(p.ringTilt), cardSize: Number(p.cardSize),
      speed: 1, direction: 1,
    }, travel(p, t01, n))
  },
  loopRates: loopRatesOf,
  // Ring opening drives the primary X reveal; ring tilt is a lean on Z.
  pose(p) { return { rotX: -Number(p.ringOpening) * OPEN_MAX, rotY: 0, rotZ: Number(p.ringTilt) } },
  bendRadius(p) { return Number(p.radius) },
  depth(p) { return Number(p.radius) },
}
