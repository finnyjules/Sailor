import { applyEase } from './ease'
import { interpolateValue } from './interpolate'
import type { Track, PropertyValue } from './types'

export function evaluateTrack(track: Track, t: number): PropertyValue | undefined {
  const kfs = track.keyframes
  if (!kfs.length) return undefined
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const first = sorted[0]!
  if (t <= first.t) return first.value
  const last = sorted[sorted.length - 1]!
  if (t >= last.t) return last.value
  let lo = first, hi = sorted[1]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t >= t) { lo = sorted[i - 1]!; hi = sorted[i]!; break }
  }
  const span = Math.max(1e-6, hi.t - lo.t)
  const p = applyEase((t - lo.t) / span, lo.ease)
  return interpolateValue(track.type, lo.value, hi.value, p, { mode: track.mode, space: track.space })
}
