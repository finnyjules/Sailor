// Moving and trimming several clips as one. Pure frame maths; the editor owns
// pointers and pixels.

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
