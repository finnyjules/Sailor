import { applyEase, isSpringEase } from './ease'
import { interpolateValue } from './interpolate'
import type { Track, PropertyValue } from './types'

export function evaluateTrack(track: Track, t: number): PropertyValue | undefined {
  const kfs = track.keyframes
  if (!kfs.length) return undefined
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  if (track.loop && sorted.length > 1) {
    const span = last.t - first.t
    if (span > 1e-9 && t > first.t) t = first.t + ((t - first.t) % span)
  }
  if (t <= first.t) return first.value
  if (t >= last.t) {
    // A spring into the last keyframe keeps settling past it (the bounce tail), then rests
    // exactly on the end value. Numbers only — colours/gradients can't extrapolate.
    const prev = sorted[sorted.length - 2]
    if (!track.loop && prev && track.type === 'number' && isSpringEase(prev.ease)) {
      const p = applyEase((t - prev.t) / Math.max(1e-6, last.t - prev.t), prev.ease)
      return interpolateValue(track.type, prev.value, last.value, p, { mode: track.mode, space: track.space })
    }
    return last.value
  }
  let lo = first, hi = sorted[1]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t >= t) { lo = sorted[i - 1]!; hi = sorted[i]!; break }
  }
  const span = Math.max(1e-6, hi.t - lo.t)
  let p = applyEase((t - lo.t) / span, lo.ease)
  if (track.type !== 'number') p = Math.min(1, Math.max(0, p))
  return interpolateValue(track.type, lo.value, hi.value, p, { mode: track.mode, space: track.space })
}
