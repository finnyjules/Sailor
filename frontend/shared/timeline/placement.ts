import type { EditState, Track, Clip } from './types'
import type { Span } from './groupEdit'

// Where clips may land. Two clips on one track must not cover the same frames;
// when a move would do that, the moved clips hop to the nearest free track of
// the same kind, or get a new one.
// Idea from opencut-classic (MIT): placement resolves to "existing track" or "new track".

/** True when none of `spans` overlaps a clip on `track` (touching edges is fine). */
export function trackHasRoom(track: Track, spans: Span[], ignore: ReadonlySet<string>): boolean {
  for (const c of track.clips) {
    if (ignore.has(c.id)) continue
    const cEnd = c.start_frame + c.length
    for (const s of spans) if (s.start < cEnd && c.start_frame < s.end) return false
  }
  return true
}

export type Placement = { type: 'track'; trackId: string } | { type: 'new_track'; kind: Track['kind'] }

/** Prefer `fromTrackId`; otherwise walk outward to the nearest unlocked track
 *  of the same kind with room (on a tie the later track wins — it renders on
 *  top); otherwise ask for a new track. */
export function resolvePlacement(state: EditState, fromTrackId: string, spans: Span[], ignore: ReadonlySet<string>): Placement {
  const i = state.tracks.findIndex(t => t.id === fromTrackId)
  const from = state.tracks[i]
  if (!from) return { type: 'new_track', kind: 'video' }
  if (trackHasRoom(from, spans, ignore)) return { type: 'track', trackId: from.id }
  for (let d = 1; d < state.tracks.length; d++) {
    for (const j of [i + d, i - d]) {
      const t = state.tracks[j]
      if (t && t.kind === from.kind && !t.locked && trackHasRoom(t, spans, ignore)) return { type: 'track', trackId: t.id }
    }
  }
  return { type: 'new_track', kind: from.kind }
}

const KIND_LABEL: Record<Track['kind'], string> = { video: 'Video', audio: 'Audio', captions: 'Captions' }

/** Move `clipIds` to the placement. Transitions touching a moved clip are
 *  dropped — a transition only makes sense between neighbours on one track. */
export function relocateClips(state: EditState, clipIds: ReadonlySet<string>, placement: Placement, newTrackId: string): boolean {
  const existing = placement.type === 'track' ? state.tracks.find(t => t.id === placement.trackId) : undefined
  if (placement.type === 'track' && !existing) return false
  const moved: Clip[] = []
  for (const track of state.tracks) {
    if (track === existing) continue
    const keep: Clip[] = []
    for (const c of track.clips) (clipIds.has(c.id) ? moved : keep).push(c)
    if (keep.length !== track.clips.length) track.clips = keep
  }
  if (!moved.length) return false
  let target = existing
  if (!target) {
    const kind = placement.type === 'new_track' ? placement.kind : 'video'
    const count = state.tracks.filter(t => t.kind === kind).length
    target = { id: newTrackId, kind, name: `${KIND_LABEL[kind]} ${count + 1}`, muted: false, locked: false, clips: [] }
    state.tracks.push(target)
  }
  target.clips.push(...moved)
  const ids = new Set(moved.map(c => c.id))
  state.transitions = state.transitions.filter(t => !ids.has(t.from_clip_id) && !ids.has(t.to_clip_id))
  return true
}

/** After a move: for each track, if any moved clip on it now overlaps a clip
 *  that did not move, all the moved clips on that track go elsewhere together.
 *  Clips that are still in flight are ignored when looking for room, but a
 *  group that has ALREADY hopped counts as occupying its new track — otherwise
 *  two groups from two tracks would both pick the same free track and overlap
 *  each other there. */
export function settleOverlaps(state: EditState, movedIds: ReadonlySet<string>, newId: () => string): boolean {
  let changed = false
  const settled = new Set<string>()
  for (const track of [...state.tracks]) {
    if (track.locked) continue
    const mine = track.clips.filter(c => movedIds.has(c.id) && !settled.has(c.id))
    if (!mine.length) continue
    const ids = new Set(mine.map(c => c.id))
    const ignore = new Set([...movedIds].filter(id => !settled.has(id)))
    const spans = mine.map(c => ({ start: c.start_frame, end: c.start_frame + c.length }))
    if (trackHasRoom(track, spans, ignore)) continue
    const placement = resolvePlacement(state, track.id, spans, ignore)
    if (relocateClips(state, ids, placement, newId())) {
      changed = true
      for (const id of ids) settled.add(id)
    }
  }
  return changed
}
