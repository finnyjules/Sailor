import type { EditState } from './types'

// Ripple: after a trim or a delete, later clips on the same track slide so no
// gap (or overlap) is left. The shifts are worked out by comparing the timeline
// BEFORE and AFTER the edit, so any edit gets ripple without its own code.
// Idea from opencut-classic (MIT): infer ripple from a before/after diff.

export interface RippleEdit { trackId: string; fromFrame: number; delta: number }

export function computeRippleEdits(before: EditState, after: EditState): RippleEdit[] {
  const afterById = new Map<string, { trackId: string; start: number; end: number }>()
  for (const t of after.tracks) {
    for (const c of t.clips) afterById.set(c.id, { trackId: t.id, start: c.start_frame, end: c.start_frame + c.length })
  }
  const survivors = new Map<string, { start: number; end: number }[]>()
  for (const [, c] of afterById) {
    const list = survivors.get(c.trackId)
    if (list) list.push(c)
    else survivors.set(c.trackId, [c])
  }
  const edits: RippleEdit[] = []
  for (const t of before.tracks) {
    for (const c of t.clips) {
      const oldStart = c.start_frame
      const oldEnd = c.start_frame + c.length
      const now = afterById.get(c.id)
      if (!now) {
        // Deleted. Only the stretch that no surviving clip on this track covers
        // is a gap (older timelines may hold overlapping clips). With no
        // overlap this is the whole clip: fromFrame = its end, delta = -length.
        let lo = oldStart
        let hi = oldEnd
        for (const o of survivors.get(t.id) ?? []) {
          if (o.start < oldStart) lo = Math.max(lo, Math.min(o.end, oldEnd))
          else if (o.start < oldEnd) hi = Math.min(hi, o.start)
        }
        if (hi > lo) edits.push({ trackId: t.id, fromFrame: hi, delta: -(hi - lo) })
        continue
      }
      if (now.trackId !== t.id) continue
      const dStart = now.start - oldStart
      const dEnd = now.end - oldEnd
      if (dStart === dEnd) continue                       // moved or untouched
      if (dStart !== 0) edits.push({ trackId: t.id, fromFrame: Math.min(oldStart, now.start), delta: -dStart })
      if (dEnd !== 0) edits.push({ trackId: t.id, fromFrame: oldEnd, delta: dEnd })
    }
  }
  return edits
}

/** Shift clips in place. Returns whether anything moved. */
export function applyRippleEdits(state: EditState, edits: RippleEdit[]): boolean {
  let changed = false
  for (const track of state.tracks) {
    if (track.locked) continue
    const mine = edits.filter(e => e.trackId === track.id)
    if (!mine.length) continue
    for (const c of track.clips) {
      let shift = 0
      for (const e of mine) if (e.fromFrame <= c.start_frame) shift += e.delta
      const next = Math.max(0, c.start_frame + shift)
      if (next !== c.start_frame) { c.start_frame = next; changed = true }
    }
  }
  return changed
}
