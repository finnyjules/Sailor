import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { hash01, lerp, loopRatesOf, pmod, smoothstep, travelOf } from './util'

const controls: ControlSpec[] = [
  { key: 'assembleCols', label: 'Columns', kind: 'slider', min: 1, max: 6, step: 1, default: 3, group: 'Layout' },
  { key: 'assembleGap', label: 'Gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.1, group: 'Layout' },
  { key: 'assembleHold', label: 'Grid hold', kind: 'slider', min: 0.1, max: 0.8, step: 0.01, default: 0.4, group: 'Motion' },
]

// The room the finished grid may take, in world units (the frame at the cards' depth is
// about 12.6 tall). The grid shrinks to fit rather than running off the edges.
const FIT_W = 9, FIT_H = 11
// How far apart the cards' clocks run, as a share of the trip.
const SPREAD = 0.25

/** Cards tumble in from all round the frame and land in a grid, hold, then scatter back
 *  out the way they came. One trip is one gathering; the loop opens on the grid. */
export const assembleLayout: ShowcaseLayout = {
  id: 'assemble', label: 'Assemble', family: 'Scatter', controls,
  place(i, n, p, t01): TileTransform {
    const count = Math.max(1, n)
    const cols = Math.max(1, Math.min(count, Math.round(Number(p.assembleCols) || 1)))
    const rows = Math.ceil(count / cols)
    const pitch = 1 + Number(p.assembleGap)
    const size = Math.min(Number(p.cardSize) * 1.3, FIT_W / (cols * pitch), FIT_H / (rows * pitch))
    const col = i % cols, row = Math.floor(i / cols)
    const gx = (col - (cols - 1) / 2) * size * pitch, gy = -(row - (rows - 1) / 2) * size * pitch

    // Where this card flies from and back to: off the frame edge, nearer the camera,
    // tumbled. The same spot every loop, so the loop closes.
    const a = 2 * Math.PI * hash01(i, 1), far = 9 + 4 * hash01(i, 2)
    const out = {
      x: Math.cos(a) * far, y: Math.sin(a) * far, z: 2 + 4 * hash01(i, 3),
      rotX: (hash01(i, 4) - 0.5) * 3, rotY: (hash01(i, 5) - 0.5) * 3, rotZ: (hash01(i, 6) - 0.5) * 3,
    }
    // The trip: fly in, hold the grid for Grid hold of it, fly out. Each card runs that on
    // its own clock, a little behind or ahead of the rest, so the cards land and leave one
    // after another and the frame is never empty. Every clock is inside its hold for a
    // stretch of the trip (the spread is kept under the hold), and the loop opens in the
    // middle of that stretch — its first frame, and the gallery thumbnail, are the grid.
    const hold = Number(p.assembleHold), fly = (1 - hold) / 2
    const spread = Math.min(SPREAD, hold * 0.6)
    const ph = pmod(travelOf(p, t01) + fly + (spread + hold) / 2 - hash01(i, 7) * spread, 1)
    const g = ph < fly + hold                             // 0 scattered … 1 in the grid
      ? smoothstep(0, fly, ph)
      : 1 - smoothstep(fly + hold, 1, ph)
    return {
      x: lerp(out.x, gx, g), y: lerp(out.y, gy, g), z: lerp(out.z, 0, g),
      rotX: lerp(out.rotX, 0, g), rotY: lerp(out.rotY, 0, g), rotZ: lerp(out.rotZ, 0, g),
      scale: size, opacity: smoothstep(0, 0.25, g),
    }
  },
  loopRates: loopRatesOf,
}
