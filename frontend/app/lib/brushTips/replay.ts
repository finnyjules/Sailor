// One place that turns a saved tip stroke into drawable geometry, memoised per stroke object
// (strokes are immutable once committed; undo snapshots create new objects, which is fine).
import type { TipStroke } from './record'
import { simulateSpray } from './spray'
import { simulateRound } from './round'
import { bristleRibbon } from './bristle'

export type Replayed = ({ kind: 'dabs'; dabs: Float32Array } | { kind: 'ribbon'; data: Float32Array | null }) & { settled: boolean }
const memo = new WeakMap<TipStroke, Replayed>()

/** done=true: a committed stroke — full replay, drips settled, memoised.
 *  done=false: the live stroke — `tailMs` of drip time after the last sample (0 while painting). */
export function replayStroke(s: TipStroke, done = true, tailMs = 0): Replayed {
  if (done) { const hit = memo.get(s); if (hit) return hit }
  let out: Replayed
  if (s.tip === 'bristle') out = { kind: 'ribbon', data: bristleRibbon(s, done), settled: true }
  else if (s.tip === 'round') out = { kind: 'dabs', dabs: simulateRound(s).view().slice(), settled: true }
  else { const r = simulateSpray(s, done ? Infinity : tailMs); out = { kind: 'dabs', dabs: r.dabs.view().slice(), settled: r.settled } }
  if (done) memo.set(s, out)
  return out
}
