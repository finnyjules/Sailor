import { evaluateTrack } from './track'
import type { Track, PropertyValue } from './types'

const startOf = (tr: Track) => (tr.keyframes.length ? Math.min(...tr.keyframes.map((k) => k.t)) : 0)

/** Evaluate every track at time `t`, keyed by property path.
 *
 *  Precedence on a shared path: the most recently STARTED track wins (start ≤ t, latest
 *  start; ties → later in the array). A track that has not started yet contributes
 *  nothing — except when NO track on the path has started, in which case the earliest-
 *  starting one supplies its lead-in (hold-before) value, so a single track evaluates
 *  exactly as `evaluateTrack` alone (byte-identity). Holds persist naturally: an In
 *  band keeps its end value until a later-starting band takes over. */
export function evaluateTracks(tracks: Track[], t: number): Map<string, PropertyValue> {
  const byPath = new Map<string, Track[]>()
  for (const track of tracks) {
    const list = byPath.get(track.path)
    if (list) list.push(track); else byPath.set(track.path, [track])
  }
  const out = new Map<string, PropertyValue>()
  for (const [path, list] of byPath) {
    let pick: Track | undefined
    let pickStart = -Infinity
    for (const tr of list) {                       // started: latest start wins, ties → later
      const s = startOf(tr)
      if (s <= t && s >= pickStart) { pick = tr; pickStart = s }
    }
    if (!pick) {                                   // none started: earliest lead-in, ties → later
      let best = Infinity
      for (const tr of list) { const s = startOf(tr); if (s <= best) { pick = tr; best = s } }
    }
    const v = pick ? evaluateTrack(pick, t) : undefined
    if (v !== undefined) out.set(path, v)
  }
  return out
}
