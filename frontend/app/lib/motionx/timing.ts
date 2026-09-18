import type { Timing } from './types'

/**
 * Raw 0..1 progress through a behaviour's timing window at time `t`.
 * `delay` (default 0) and `start` shift the window; before `start+delay` → 0.
 * Non-loop past the end → 1. `loop` wraps `local % 1`. `hold` (0..0.49)
 * flattens both extremes. Easing is NOT applied here (callers apply `applyEase`).
 */
export function progress(timing: Timing, t: number): number {
  const start = timing.start + (timing.delay ?? 0)
  const d = Math.max(1e-4, timing.duration)
  let local = (t - start) / d
  if (local <= 0) return 0
  if (timing.loop) local = ((local % 1) + 1) % 1
  else if (local >= 1) return 1
  const h = Math.min(0.49, Math.max(0, timing.hold ?? 0))
  if (h > 0) {
    if (local <= h) return 0
    if (local >= 1 - h) return 1
    local = (local - h) / (1 - 2 * h)
  }
  return local
}
