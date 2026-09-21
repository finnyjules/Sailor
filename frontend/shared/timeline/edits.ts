import type { EditState } from './types'
import { computeRippleEdits, applyRippleEdits } from './ripple'

// Whole edits the editor performs from more than one place (keyboard, toolbar,
// context menu, pointer release). They live here, as pure functions, so every
// entry point does the SAME thing and the unit tests run the real code.

/** Delete clips. Clips on locked tracks are never touched. Transitions that
 *  touched a deleted clip go with it. With `ripple`, later clips on each track
 *  close the gaps. Returns false (state untouched) when nothing could be deleted. */
export function deleteClipsFrom(state: EditState, ids: ReadonlySet<string>, ripple: boolean): boolean {
  if (!state.tracks.some(t => !t.locked && t.clips.some(c => ids.has(c.id)))) return false
  const before: EditState | null = ripple ? JSON.parse(JSON.stringify(state)) : null
  const gone = new Set<string>()
  for (const track of state.tracks) {
    if (track.locked) continue
    track.clips = track.clips.filter(c => {
      if (!ids.has(c.id)) return true
      gone.add(c.id)
      return false
    })
  }
  state.transitions = state.transitions.filter(t => !gone.has(t.from_clip_id) && !gone.has(t.to_clip_id))
  if (before) applyRippleEdits(state, computeRippleEdits(before, state))
  return true
}

/** A clip crosses tracks live while it is dragged, and leaving a track drops its
 *  transitions. When the drag ends with the clip back on a transition's own
 *  track (and its partner still there), put that transition back. `base` is the
 *  timeline as the drag began. */
export function restoreLostTransitions(state: EditState, base: EditState, clipId: string): boolean {
  let restored = false
  for (const t of base.transitions) {
    if (t.from_clip_id !== clipId && t.to_clip_id !== clipId) continue
    if (state.transitions.some(x => x.id === t.id)) continue
    const track = state.tracks.find(tr => tr.id === t.track_id)
    if (!track) continue
    if (!track.clips.some(c => c.id === t.from_clip_id) || !track.clips.some(c => c.id === t.to_clip_id)) continue
    state.transitions.push(JSON.parse(JSON.stringify(t)))
    restored = true
  }
  return restored
}
