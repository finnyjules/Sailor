import { evaluateTrack } from './track'
import type { Track, PropertyValue } from './types'

/** Evaluate every track at time `t`, keyed by property path (last track wins on a shared path). */
export function evaluateTracks(tracks: Track[], t: number): Map<string, PropertyValue> {
  const out = new Map<string, PropertyValue>()
  for (const track of tracks) {
    const v = evaluateTrack(track, t)
    if (v !== undefined) out.set(track.path, v)
  }
  return out
}
