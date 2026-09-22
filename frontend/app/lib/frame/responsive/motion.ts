import type { FrameMotion } from '~/lib/motion/types'
import type { Track } from '~/lib/motionx/types'
import { applyMap } from './axis'
import type { AxisMap } from './types'

const POS = /^layers\.([^.]+)\.(x|y)$/

/** A track value is a CENTRE, not an edge: a 'both' (stretched) map moves the two edges
 *  differently, so the centre travels by their midpoint (o + s·p + u/2). Every other kind
 *  ignores `edge`, so it maps straight through. */
function mapCentre(map: AxisMap, p: number): number {
  return map.kind === 'both'
    ? (applyMap(map, p, 'near') + applyMap(map, p, 'far')) / 2
    : applyMap(map, p)
}

/**
 * Map every `layers.<id>.x` / `.y` track through that layer's per-axis map so a
 * keyframed position adapts exactly like the resting position. Same reference
 * when no track is affected. Tracks for other properties come back by identity.
 */
export function remapMotion(
  motion: FrameMotion | null,
  maps: Map<string, { h: AxisMap; v: AxisMap }>,
  W0: number, H0: number, W: number, H: number,
): FrameMotion | null {
  if (!motion?.motionx?.length) return motion
  let changed = false
  const motionx = motion.motionx.map((tr): Track => {
    const m = tr.path.match(POS)
    if (!m) return tr
    const lm = maps.get(m[1]!)
    if (!lm) return tr
    const isX = m[2] === 'x'
    const map = isX ? lm.h : lm.v
    const design = isX ? W0 : H0, box = isX ? W : H
    changed = true
    return {
      ...tr,
      keyframes: tr.keyframes.map(kf => typeof kf.value === 'number'
        ? { ...kf, value: mapCentre(map, kf.value * design) / box }
        : kf),
    }
  })
  return changed ? { ...motion, motionx } : motion
}
