// app/lib/sketch/cleanup/detect-directions.ts
// Clean up's second stage: lines that are nearly level or upright, groups of
// nearly parallel lines, and nearly square corners or groups ("Square").
import type { EntityId } from '../model'
import type { RuleSpec } from '../tangency'
import { clusterCircular, unambiguous } from './cluster'
import { linePieces, lineAngleDeg, pairKey, type CleanupContext, type Piece } from './context'
import { TOL, countLabel, type Candidate } from './types'

const longestFirst = (a: Piece, b: Piece) => b.len - a.len || (pairKey(a.a!, a.b!) < pairKey(b.a!, b.b!) ? -1 : 1)

export function detectHV(ctx: CleanupContext): Candidate[] {
  const tol = TOL.HV_DEG * ctx.s
  const out: Candidate[] = []
  for (const p of linePieces(ctx)) {
    if (!p.inScope || p.copy) continue
    const th = lineAngleDeg(p)
    const dH = Math.min(th, 180 - th), dV = Math.abs(th - 90)
    const key = pairKey(p.a!, p.b!)
    if (dH <= tol) {
      out.push({ id: `horizontal:${key}`, kind: 'horizontal', label: 'Horizontal', score: 1 - dH / tol, anchor: [p.a!, p.b!], rules: [{ kind: 'horizontal', refs: [p.a!, p.b!] }] })
    } else if (dV <= tol) {
      out.push({ id: `vertical:${key}`, kind: 'vertical', label: 'Vertical', score: 1 - dV / tol, anchor: [p.a!, p.b!], rules: [{ kind: 'vertical', refs: [p.a!, p.b!] }] })
    }
  }
  return out
}

interface Group { items: Piece[]; lo: number; hi: number; mean: number; ref: Piece; key: string; ok: boolean }

export function detectParallelPerp(ctx: CleanupContext): Candidate[] {
  const tol = TOL.PAR_DEG * ctx.s
  const ls = linePieces(ctx).filter(p => !p.copy)
  const groups: Group[] = clusterCircular(ls, lineAngleDeg, tol).map(({ items, values }) => {
    const lo = values[0]!, hi = values[values.length - 1]!
    const others = ls.filter(p => !items.includes(p)).map(lineAngleDeg)
    const w = items.reduce((s, p) => s + p.len, 0)
    const mean = values.reduce((s, v, i) => s + v * items[i]!.len, 0) / w
    return {
      items, lo, hi, mean, ref: [...items].sort(longestFirst)[0]!,
      key: items.map(p => pairKey(p.a!, p.b!)).sort().join('|'),
      ok: unambiguous(lo, hi, others, 180),
    }
  })
  const out: Candidate[] = []
  for (const g of groups) {
    if (g.items.length < 2 || !g.ok || !g.items.some(p => p.inScope)) continue
    const rules: RuleSpec[] = g.items.filter(p => p !== g.ref).map((p): RuleSpec => ({ kind: 'parallel', refs: [g.ref.a!, g.ref.b!, p.a!, p.b!] }))
    out.push({
      id: `parallel:${g.key}`, kind: 'parallel', label: countLabel('Parallel', g.items.length),
      score: g.items.length + 1 - (g.hi - g.lo) / tol, anchor: [g.ref.a!, g.ref.b!], rules,
    })
  }
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const A = groups[i]!, B = groups[j]!
      if (!A.ok || !B.ok) continue
      const dev = Math.abs((((A.mean - B.mean) % 180) + 180) % 180 - 90)
      if (dev > tol) continue
      let corner: { id: EntityId; la: Piece; lb: Piece } | null = null
      for (const la of A.items) {
        for (const lb of B.items) {
          const id = [la.a!, la.b!].find(x => x === lb.a || x === lb.b)
          if (id && !corner) corner = { id, la, lb }
        }
      }
      if (!corner && (A.items.length < 2 || B.items.length < 2)) continue
      if (![...A.items, ...B.items].some(p => p.inScope)) continue
      const la = corner?.la ?? A.ref, lb = corner?.lb ?? B.ref
      out.push({
        id: `perpendicular:${[A.key, B.key].sort().join('#')}`, kind: 'perpendicular', label: 'Square',
        score: A.items.length + B.items.length + 1 - dev / tol,
        anchor: corner ? [corner.id] : [A.ref.a!, A.ref.b!],
        rules: [{ kind: 'perpendicular', refs: [la.a!, la.b!, lb.a!, lb.b!] }],
      })
    }
  }
  return out
}
