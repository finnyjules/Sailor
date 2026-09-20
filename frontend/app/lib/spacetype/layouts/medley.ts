import { defaultsFromControls, type ControlSpec, type Params } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout, ShowcasePose } from './index'
import { gridLayout } from './grid'
import { ringLayout } from './ring'
import { coverflowLayout } from './coverflow'
import { lerp, lerpAngle, loopRatesOf, pmod, smoothstep, travelOf } from './util'

const controls: ControlSpec[] = [
  { key: 'medleyHold', label: 'Scene hold', kind: 'slider', min: 0.2, max: 0.9, step: 0.01, default: 0.62, group: 'Motion' },
]

// The scenes, in playing order. Each is an ordinary layout reading its own dials, and keeps
// running underneath — so the grid ripples and the ring turns while they are on show.
const SCENES: ShowcaseLayout[] = [gridLayout, ringLayout, coverflowLayout]
const HEAD_ON: ShowcasePose = { rotX: 0, rotY: 0, rotZ: 0 }

/** Which two scenes are in play and how far between them: each scene holds for Hold of its
 *  turn, then the cards fly to the next. One trip plays every scene once. */
function mix(p: Params, t01: number): { from: number; to: number; w: number } {
  const at = pmod(travelOf(p, t01), 1) * SCENES.length
  const from = Math.floor(at) % SCENES.length
  return { from, to: (from + 1) % SCENES.length, w: smoothstep(Number(p.medleyHold), 1, at - Math.floor(at)) }
}

/** Three scenes in one loop: the same cards as a grid, then a ring, then a cover flow. */
export const medleyLayout: ShowcaseLayout = {
  id: 'medley', label: 'Triple scene', family: 'Multiscene', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const { from, to, w } = mix(p, t01)
    const a = SCENES[from]!.place(i, n, p, t01, aspects)
    if (w <= 0) return a
    const b = SCENES[to]!.place(i, n, p, t01, aspects)
    return {
      x: lerp(a.x, b.x, w), y: lerp(a.y, b.y, w), z: lerp(a.z, b.z, w) + Math.sin(Math.PI * w) * 1.5,
      rotY: lerpAngle(a.rotY, b.rotY, w), rotX: lerpAngle(a.rotX ?? 0, b.rotX ?? 0, w), rotZ: lerpAngle(a.rotZ ?? 0, b.rotZ ?? 0, w),
      scale: lerp(a.scale, b.scale, w), opacity: lerp(a.opacity ?? 1, b.opacity ?? 1, w),
    }
  },
  loopRates: loopRatesOf,
  paramDefaults() { return defaultsFromControls(SCENES.flatMap(l => l.controls)) },
  pose(p, t01) {
    const { from, to, w } = mix(p, t01)
    const a = SCENES[from]!.pose?.(p, t01) ?? HEAD_ON, b = SCENES[to]!.pose?.(p, t01) ?? HEAD_ON
    return { rotX: lerp(a.rotX, b.rotX, w), rotY: lerp(a.rotY, b.rotY, w), rotZ: lerp(a.rotZ, b.rotZ, w) }
  },
}
