// One place that turns a saved tip stroke into drawable geometry, memoised per stroke object
// (strokes are immutable once committed; undo snapshots create new objects, which is fine).
import type { TipStroke } from './record'
import { simulateSpray, LiveSpray } from './spray'
import { simulateRound } from './round'
import { bristleRibbon } from './bristle'

export type Replayed = ({ kind: 'dabs'; dabs: Float32Array; coords: Float32Array | null } | { kind: 'ribbon'; data: Float32Array | null }) & { settled: boolean }
const memo = new WeakMap<TipStroke, Replayed>()

// The live spray stroke's single incremental simulation (keyed by the stroke object). Every
// live frame, and the host's "have the drips settled?" check, read this same sim — it is fed
// only the new samples and advanced, never re-run from the start. The committed stroke still
// replays from its record (below, memoised); LiveSpray.sync reproduces simulateSpray exactly.
let liveSpray: LiveSpray | null = null

/** done=true: a committed stroke — full replay, drips settled, memoised.
 *  done=false: the live stroke — `tailMs` of drip time after the last sample (0 while painting).
 *  A live spray's dabs are a view into the running sim: use them before the next call. */
export function replayStroke(s: TipStroke, done = true, tailMs = 0): Replayed {
  if (done) {
    if (liveSpray?.stroke === s) liveSpray = null
    const hit = memo.get(s); if (hit) return hit
  }
  let out: Replayed
  if (s.tip === 'bristle') out = { kind: 'ribbon', data: bristleRibbon(s, done), settled: true }
  else if (s.tip === 'round') {
    const r = simulateRound(s)
    out = { kind: 'dabs', dabs: r.dabs.view().slice(), coords: r.coords.view().slice(), settled: true }
  } else if (!done) {
    if (liveSpray?.stroke !== s) liveSpray = new LiveSpray(s)
    liveSpray.sync(tailMs)
    out = { kind: 'dabs', dabs: liveSpray.sim.dabs.view(), coords: null, settled: liveSpray.sim.settled }
  } else { const r = simulateSpray(s); out = { kind: 'dabs', dabs: r.dabs.view().slice(), coords: null, settled: r.settled } }
  if (done) memo.set(s, out)
  return out
}
