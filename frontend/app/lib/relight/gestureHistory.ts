/**
 * One undo step per gesture for Relight's on-canvas lights.
 * - A drag records on its FIRST move, so a click that never moves records nothing.
 * - A wheel run records on the first event after `idleMs` of quiet; the rest of the run writes
 *   without history (a trackpad sends dozens of events a second).
 */
export function recordOnce(record: () => void): () => void {
  let done = false
  return () => { if (!done) { done = true; record() } }
}

export function wheelGestureRecorder(record: () => void, now: () => number = () => performance.now(), idleMs = 300): () => void {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last >= idleMs) record()
    last = t
  }
}
