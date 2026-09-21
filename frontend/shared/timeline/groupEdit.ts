// Moving and trimming several clips as one. Pure frame maths; the editor owns
// pointers and pixels.

import { computeLeftTrim, type TrimBase } from './trim'

/** A clip's place on the timeline. `end` is exclusive (start + length). */
export interface Span { start: number; end: number }

/** Snap a whole moving selection: EVERY member's start and end may snap, and
 *  the closest hit wins. Callers must leave the moving clips out of `targets`,
 *  or the selection snaps to itself.
 *  Idea from opencut-classic (MIT): group snap tests all member edges. */
export function snapGroupDelta(
  members: Span[], rawDelta: number, targets: number[], thresholdFrames: number,
): { delta: number; guideFrame: number | null } {
  const raw = Math.round(rawDelta)
  let delta = raw
  let guideFrame: number | null = null
  let bestDist = thresholdFrames
  for (const m of members) {
    for (const edge of [m.start, m.end]) {
      const moved = edge + raw
      for (const t of targets) {
        const d = Math.abs(t - moved)
        if (d < bestDist) { bestDist = d; delta = raw + (t - moved); guideFrame = t }
      }
    }
  }
  let minStart = Infinity
  for (const m of members) minStart = Math.min(minStart, m.start)
  if (members.length && minStart + delta < 0) { delta = -minStart; guideFrame = null }
  return { delta, guideFrame }
}

export interface ResizeMember {
  id: string
  start_frame: number
  in_frame: number
  length: number
  /** Source-backed kinds (video/audio): the left edge trims INTO the source. */
  anchored: boolean
  /** Known source length in frames; null = unbounded. */
  sourceFrames: number | null
  speed: number
  /** Free frames to the nearest non-trimming clip on the same track; null = no limit. */
  gapBefore: number | null
  gapAfter: number | null
}

/** Room on each side of `memberId`, measured to the nearest clip on the same
 *  track that is not part of the trim. Overlapping neighbours give 0. */
export function neighbourGaps(
  clips: { id: string; start_frame: number; length: number }[], memberId: string, ignore: ReadonlySet<string>,
): { gapBefore: number | null; gapAfter: number | null } {
  const me = clips.find(c => c.id === memberId)
  if (!me) return { gapBefore: null, gapAfter: null }
  const myEnd = me.start_frame + me.length
  let gapBefore: number | null = null
  let gapAfter: number | null = null
  for (const c of clips) {
    if (ignore.has(c.id)) continue
    const cEnd = c.start_frame + c.length
    if (c.start_frame >= me.start_frame) {
      const g = Math.max(0, c.start_frame - myEnd)
      gapAfter = gapAfter == null ? g : Math.min(gapAfter, g)
    } else {
      const g = Math.max(0, me.start_frame - cEnd)
      gapBefore = gapBefore == null ? g : Math.min(gapBefore, g)
    }
  }
  return { gapBefore, gapAfter }
}

/** Trim a whole selection by ONE shared amount. Every member's limits are
 *  intersected first, the delta is clamped once, and every field is derived
 *  from that one number — so start + length (and in_frame) can never drift
 *  apart between members. Callers snap `rawDelta` BEFORE calling.
 *  Idea from opencut-classic (MIT): clamp the group delta once, derive all fields from it. */
export function computeGroupResize(
  members: ResizeMember[], edge: 'left' | 'right', rawDelta: number,
): { delta: number; patches: Map<string, TrimBase> } {
  let min = -Infinity
  let max = Infinity
  for (const m of members) {
    if (edge === 'right') {
      min = Math.max(min, 1 - m.length)
      if (m.sourceFrames != null) {
        const budget = Math.floor((m.sourceFrames - m.in_frame) / Math.max(0.1, m.speed))
        max = Math.min(max, Math.max(0, budget - m.length))
      }
      if (m.gapAfter != null) max = Math.min(max, m.gapAfter)
    } else {
      max = Math.min(max, m.length - 1)
      min = Math.max(min, -m.start_frame)
      if (m.anchored) min = Math.max(min, -m.in_frame)
      if (m.gapBefore != null) min = Math.max(min, -m.gapBefore)
    }
  }
  // `|| 0` turns -0 into 0 so patches compare cleanly.
  const delta = members.length ? (Math.max(min, Math.min(Math.round(rawDelta), max)) || 0) : 0
  const patches = new Map<string, TrimBase>()
  for (const m of members) {
    const base: TrimBase = { start_frame: m.start_frame, in_frame: m.in_frame, length: m.length }
    patches.set(m.id, edge === 'right'
      ? { ...base, length: m.length + delta }
      : computeLeftTrim(base, m.start_frame + delta, m.anchored))
  }
  return { delta, patches }
}
