// app/lib/sketch/cleanup/cluster.ts
// Grouping similar values without chaining (complete linkage): a group's
// spread never exceeds the tolerance, however many members sit in a row.
// 1-D values (lengths, radii), angles on a 180° circle, and pairs with their
// own nearness test (points in the plane). Plus the ambiguity guard: a group
// whose spread is large next to the distance to the nearest value outside it
// is a guess, and is skipped.
import type { Vec2 } from '../geom'

/** Complete-linkage groups of `items` by `value`. Groups are runs of the sorted
 *  values; the two neighbouring groups whose union spans least are merged while
 *  `fits(lo, hi)` holds for the union. */
export function clusterSorted<T>(items: readonly T[], value: (t: T) => number, fits: (lo: number, hi: number) => boolean): T[][] {
  const sorted = items.map((t, i) => ({ t, v: value(t), i })).sort((a, b) => a.v - b.v || a.i - b.i)
  const groups = sorted.map(x => [x])
  for (;;) {
    let best = -1
    let bestSpan = Infinity
    for (let k = 0; k + 1 < groups.length; k++) {
      const left = groups[k]!, right = groups[k + 1]!
      const lo = left[0]!.v, hi = right[right.length - 1]!.v
      if (!fits(lo, hi)) continue
      if (hi - lo < bestSpan) { bestSpan = hi - lo; best = k }
    }
    if (best < 0) break
    groups.splice(best, 2, [...groups[best]!, ...groups[best + 1]!])
  }
  return groups.map(g => g.map(x => x.t))
}

/** Complete-linkage groups of angles on a circle of `period` degrees (180 for
 *  line directions). Each group comes with its members' angles, unwrapped so
 *  they ascend without a jump (179 and 181 for 179° and 1°). */
export function clusterCircular<T>(items: readonly T[], angle: (t: T) => number, tol: number, period = 180): { items: T[]; values: number[] }[] {
  if (!items.length) return []
  const norm = (a: number) => ((a % period) + period) % period
  const vs = items.map((t, i) => ({ t, v: norm(angle(t)), i })).sort((a, b) => a.v - b.v || a.i - b.i)
  // cut the circle at its widest empty stretch, so no group straddles the cut
  let cut = 0
  let widest = vs[0]!.v + period - vs[vs.length - 1]!.v
  for (let k = 1; k < vs.length; k++) {
    const gap = vs[k]!.v - vs[k - 1]!.v
    if (gap > widest) { widest = gap; cut = k }
  }
  const line = [...vs.slice(cut), ...vs.slice(0, cut).map(x => ({ ...x, v: x.v + period }))]
  return clusterSorted(line, x => x.v, (lo, hi) => hi - lo <= tol)
    .map(g => ({ items: g.map(x => x.t), values: g.map(x => x.v) }))
}

/** Complete-linkage groups of items that are pairwise near. `near(a, b)` is the
 *  pair's distance when they may share a group, else null; `allowed` may veto
 *  a merged group. Closest pairs merge first. */
export function clusterPairs<T>(items: readonly T[], near: (a: T, b: T) => number | null, allowed: (group: T[]) => boolean = () => true): T[][] {
  const pairs: { i: number; j: number; d: number }[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = near(items[i]!, items[j]!)
      if (d != null) pairs.push({ i, j, d })
    }
  }
  pairs.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j)
  const group = items.map((_, i) => i)
  const members: number[][] = items.map((_, i) => [i])
  for (const p of pairs) {
    const gi = group[p.i]!, gj = group[p.j]!
    if (gi === gj) continue
    const A = members[gi]!, B = members[gj]!
    if (!A.every(a => B.every(b => near(items[a]!, items[b]!) != null))) continue
    const merged = [...A, ...B].sort((x, y) => x - y)
    if (!allowed(merged.map(k => items[k]!))) continue
    const keep = Math.min(gi, gj), drop = Math.max(gi, gj)
    members[keep] = merged
    members[drop] = []
    for (const k of merged) group[k] = keep
  }
  return members.filter(m => m.length).map(m => m.map(k => items[k]!))
}

/** The distance from the span [lo, hi] to the nearest of `others` (going round
 *  the circle when `period` is given). */
export function outsideGap(lo: number, hi: number, others: readonly number[], period?: number): number {
  let g = Infinity
  for (const o of others) {
    if (period) {
      const up = (((o - hi) % period) + period) % period
      const down = (((lo - o) % period) + period) % period
      g = Math.min(g, up, down)
    } else {
      g = Math.min(g, o > hi ? o - hi : o < lo ? lo - o : 0)
    }
  }
  return g
}

/** The ambiguity guard: a group is a clear call only when 2.5 × its spread
 *  fits in the gap to the nearest value outside it. */
export function unambiguous(lo: number, hi: number, others: readonly number[], period?: number): boolean {
  return (hi - lo) * 2.5 <= outsideGap(lo, hi, others, period)
}

export const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
export const meanPoint = (ps: readonly Vec2[]): Vec2 => ({ x: mean(ps.map(p => p.x)), y: mean(ps.map(p => p.y)) })
