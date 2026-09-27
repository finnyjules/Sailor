// app/lib/sketch/cleanup/detect-shape.ts
// Clean up's later stages: placement (centres that nearly coincide, pieces
// that nearly mirror each other), sizes (nearly equal lengths and radii,
// nearly even spacing) and nudges (sizes a hair off a whole number).
import type { SketchDoc, EntityId } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { addPoint, addLine } from '../edit'
import type { RuleSpec } from '../tangency'
import { clusterPairs, clusterSorted, clusterCircular, unambiguous, mean } from './cluster'
import { pairKey, stableKey, typedSize, radiusOf, lineAngleDeg, linePieces, type CleanupContext, type Piece } from './context'
import { partNames } from './guards'
import { TOL, GUARD, countLabel, type Candidate } from './types'

const isRound = (p: Piece) => p.kind === 'arc' || p.kind === 'circle'
const longestFirst = (a: Piece, b: Piece) => b.len - a.len || (stableKey(a) < stableKey(b) ? -1 : 1)

// ── placement: Same centre ──────────────────────────────────────────────────

export function detectConcentric(ctx: CleanupContext): Candidate[] {
  type Item = { c: EntityId; at: Vec2; r: number; pieces: Piece[] }
  const byCentre = new Map<EntityId, Item>()
  for (const p of ctx.pieces) {
    if (!isRound(p) || p.copy) continue
    const C = ctx.pts.get(p.c!)
    if (!C) continue
    const it = byCentre.get(p.c!) ?? { c: p.c!, at: { x: C.x, y: C.y }, r: Infinity, pieces: [] }
    it.r = Math.min(it.r, radiusOf(p))
    it.pieces.push(p)
    byCentre.set(p.c!, it)
  }
  const px = ctx.tol(TOL.CONC_PX)
  const tolOf = (u: Item, v: Item) => Math.max(px, TOL.CONC_FRAC * ctx.s * Math.min(u.r, v.r))
  const near = (u: Item, v: Item) => { const d = dist(u.at, v.at); return d <= tolOf(u, v) ? d : null }
  const out: Candidate[] = []
  for (const g of clusterPairs([...byCentre.values()], near)) {
    if (g.length < 2 || !g.some(x => x.pieces.some(p => p.inScope))) continue
    const ids = g.map(x => x.c).sort()
    let worst = 0
    for (const u of g) for (const v of g) if (u !== v) worst = Math.max(worst, dist(u.at, v.at) / tolOf(u, v))
    const w = g.map(x => x.pieces.reduce((s, p) => s + p.len, 0))
    const W = w.reduce((s, x) => s + x, 0)
    const at = { x: g.reduce((s, x, i) => s + x.at.x * w[i]!, 0) / W, y: g.reduce((s, x, i) => s + x.at.y * w[i]!, 0) / W }
    out.push({ id: `concentric:${ids.join(',')}`, kind: 'concentric', label: countLabel('Same centre', g.length), score: 2 - worst, anchor: ids, merges: { points: ids, at } })
  }
  return out
}

// ── placement: Mirror pair ──────────────────────────────────────────────────

type Axis = { key: string; kind: 'new'; dir: 'v' | 'h'; at: number } | { key: string; kind: 'line'; id: EntityId; a: Vec2; b: Vec2 }
interface Box { minX: number; minY: number; maxX: number; maxY: number; pad: number }
interface Match { p: Piece; q: Piece; pairs: [EntityId, EntityId][]; err: number }

function reflector(ax: Axis): (p: Vec2) => Vec2 {
  if (ax.kind === 'new') return ax.dir === 'v' ? p => ({ x: 2 * ax.at - p.x, y: p.y }) : p => ({ x: p.x, y: 2 * ax.at - p.y })
  const dx = ax.b.x - ax.a.x, dy = ax.b.y - ax.a.y, L = Math.hypot(dx, dy)
  const nx = -dy / L, ny = dx / L
  return p => { const s = (p.x - ax.a.x) * nx + (p.y - ax.a.y) * ny; return { x: p.x - 2 * s * nx, y: p.y - 2 * s * ny } }
}
function sideOf(ax: Axis, p: Vec2): number {
  if (ax.kind === 'new') return ax.dir === 'v' ? p.x - ax.at : p.y - ax.at
  const dx = ax.b.x - ax.a.x, dy = ax.b.y - ax.a.y
  return (dx * (p.y - ax.a.y) - dy * (p.x - ax.a.x)) / Math.hypot(dx, dy)
}

function matchPieces(ctx: CleanupContext, p: Piece, q: Piece, refl: (v: Vec2) => Vec2, tol: number): { pairs: [EntityId, EntityId][]; err: number } | null {
  if (p.kind !== q.kind || p === q) return null
  const at = (id: EntityId) => ctx.pts.get(id)!
  const tryPairs = (pp: [EntityId, EntityId][]) => {
    let err = 0
    for (const [x, y] of pp) {
      const d = dist(refl(at(x)), at(y))
      if (d > tol) return null
      err = Math.max(err, d)
    }
    return { pairs: pp, err }
  }
  let best: { pairs: [EntityId, EntityId][]; err: number } | null = null
  if (p.kind === 'circle') {
    const dr = Math.abs(radiusOf(p) - radiusOf(q))
    if (dr > tol) return null
    best = tryPairs([[p.c!, q.c!]])
    if (best) best.err = Math.max(best.err, dr)
  } else {
    const extra: [EntityId, EntityId][] = p.kind === 'arc' ? [[p.c!, q.c!]] : []
    const ways: [EntityId, EntityId][][] = [[[p.a!, q.a!], [p.b!, q.b!], ...extra], [[p.a!, q.b!], [p.b!, q.a!], ...extra]]
    for (const w of ways) {
      const m = tryPairs(w)
      if (m && (!best || m.err < best.err)) best = m
    }
  }
  if (!best || best.pairs.every(([x, y]) => x === y)) return null
  return best
}

// greedy by error: each piece in at most one pair; pairs oriented [orig, copy]
function pairUp(ctx: CleanupContext, ps: Piece[], ax: Axis, tol: number): Match[] {
  const refl = reflector(ax)
  const all: Match[] = []
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const p = ps[i]!, q = ps[j]!
      if (!p.inScope && !q.inScope) continue
      const m = matchPieces(ctx, p, q, refl, tol)
      if (!m) continue
      const pairs = m.pairs.map(([x, y]): [EntityId, EntityId] => (x === y || sideOf(ax, ctx.pts.get(x)!) < sideOf(ax, ctx.pts.get(y)!) ? [x, y] : [y, x]))
      all.push({ p, q, pairs, err: m.err })
    }
  }
  all.sort((a, b) => a.err - b.err || (stableKey(a.p) + stableKey(a.q) < stableKey(b.p) + stableKey(b.q) ? -1 : 1))
  const used = new Set<Piece>()
  const out: Match[] = []
  for (const m of all) {
    if (used.has(m.p) || used.has(m.q)) continue
    used.add(m.p); used.add(m.q)
    out.push(m)
  }
  return out
}

// the axis guide line: an existing guide, or a new one made once and shared through `guides`
function axisLine(doc: SketchDoc, guides: Map<string, EntityId>, ax: Axis, box: Box, part: EntityId): { line: EntityId; rules: RuleSpec[] } {
  if (ax.kind === 'line') return { line: ax.id, rules: [] }
  const key = `axis:${ax.dir}:${part}`
  const had = guides.get(key)
  if (had && doc.entities.some(e => e.id === had)) return { line: had, rules: [] }
  const padX = Math.max(0.1 * (box.maxX - box.minX), box.pad), padY = Math.max(0.1 * (box.maxY - box.minY), box.pad)
  const [p, q] = ax.dir === 'v'
    ? [addPoint(doc, ax.at, box.minY - padY, { construction: true }), addPoint(doc, ax.at, box.maxY + padY, { construction: true })]
    : [addPoint(doc, box.minX - padX, ax.at, { construction: true }), addPoint(doc, box.maxX + padX, ax.at, { construction: true })]
  const line = addLine(doc, p, q, { construction: true })
  guides.set(key, line)
  return { line, rules: [{ kind: ax.dir === 'v' ? 'vertical' : 'horizontal', refs: [p, q] }] }
}

function boxOf(ctx: CleanupContext, ps: Piece[]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, pad: 20 * ctx.unitsPerPx }
  for (const p of ps) {
    const r = p.kind === 'circle' ? radiusOf(p) : 0
    for (const id of p.points) {
      const P = ctx.pts.get(id)!
      box.minX = Math.min(box.minX, P.x - r); box.maxX = Math.max(box.maxX, P.x + r)
      box.minY = Math.min(box.minY, P.y - r); box.maxY = Math.max(box.maxY, P.y + r)
    }
  }
  return box
}

/** **Ruling (final review):** a Mirror pair only pairs two pieces of the same
 *  connected part (points shared, or tied by a rule — a Repeat / Mirror rule
 *  counts), never two separate shapes, and each part gets its own axis — a
 *  shared axis would tie the shapes together. An existing guide line serves
 *  the part it is tied to; a free one serves the one part it pairs best. */
export function detectMirrorPairs(ctx: CleanupContext): Candidate[] {
  const tol = ctx.tol(TOL.MIRROR_PX)
  const ps = ctx.pieces.filter(p => !p.copy)
  const scoped = ps.filter(p => p.inScope)
  if (ps.length < 2 || !scoped.length) return []
  const box = boxOf(ctx, scoped)
  const axes: Axis[] = [
    { key: 'v', kind: 'new', dir: 'v', at: (box.minX + box.maxX) / 2 },
    { key: 'h', kind: 'new', dir: 'h', at: (box.minY + box.maxY) / 2 },
  ]
  for (const e of ctx.doc.entities) {
    if (e.kind !== 'line' || !e.construction) continue
    const a = ctx.pts.get(e.p1), b = ctx.pts.get(e.p2)
    if (a && b && dist(a, b) > 1e-9) axes.push({ key: e.id, kind: 'line', id: e.id, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
  }
  const names = partNames(ctx.doc)
  const parts = new Map<EntityId, Piece[]>()
  for (const p of ps) {
    const k = names.get(p.points[0]!) ?? p.key
    const list = parts.get(k)
    if (list) list.push(p); else parts.set(k, [p])
  }
  const out: Candidate[] = []
  for (const start of axes) {
    type Found = { part: EntityId; axis: Axis; matches: Match[] }
    let found: Found[] = []
    for (const [part, members] of parts) {
      if (members.length < 2 || !members.some(p => p.inScope)) continue
      let ax: Axis = start
      let matches = pairUp(ctx, members, ax, tol)
      if (ax.kind === 'new' && matches.length) {
        // the new axis goes through the middle of the matched pairs: each side moves half the mismatch
        const dir = ax.dir
        const mids: number[] = []
        for (const m of matches) {
          for (const [x, y] of m.pairs) { const X = ctx.pts.get(x)!, Y = ctx.pts.get(y)!; mids.push(dir === 'v' ? (X.x + Y.x) / 2 : (X.y + Y.y) / 2) }
        }
        ax = { ...ax, at: mean(mids) }
        matches = pairUp(ctx, members, ax, tol)
      }
      if (matches.length) found.push({ part, axis: ax, matches })
    }
    if (start.kind === 'line') {
      const g = ctx.doc.entities.find(e => e.id === start.id)
      const own = g?.kind === 'line' ? names.get(g.p1) : undefined
      const worst = (f: Found) => Math.max(...f.matches.map(m => m.err))
      if (own != null && parts.has(own)) found = found.filter(f => f.part === own)
      // a free guide: the part with the most pairs, then the closest ones
      else if (found.length > 1) found = [[...found].sort((x, y) => y.matches.length - x.matches.length || worst(x) - worst(y) || (x.part < y.part ? -1 : 1))[0]!]
    }
    for (const { part, axis, matches } of found) {
      const partBox = boxOf(ctx, parts.get(part)!)
      for (const m of matches) {
        out.push({
          id: `mirror:${axis.key}:${[stableKey(m.p), stableKey(m.q)].sort().join('|')}`, kind: 'mirror', label: 'Mirror pair',
          score: 1 - m.err / tol, anchor: [...new Set(m.pairs.flat())],
          prepare: (doc, guides) => {
            const { line, rules } = axisLine(doc, guides, axis, partBox, part)
            for (const [o, c] of m.pairs) rules.push(o === c ? { kind: 'pointOnLine', refs: [o, line] } : { kind: 'mirroredFrom', refs: [c, o, line] })
            if (m.p.kind === 'circle') rules.push({ kind: 'equalRadius', refs: [m.p.circle!, m.q.circle!] })
            return rules
          },
        })
      }
    }
  }
  return out
}

// ── sizes: Same length, Same radius ─────────────────────────────────────────

function sizeGroups(ctx: CleanupContext, items: Piece[], size: (p: Piece) => number, frac: number, px: number) {
  const room = (lo: number) => Math.min(frac * ctx.s * lo, ctx.tol(px))
  const out: { g: Piece[]; lo: number; hi: number; room: number }[] = []
  for (const g of clusterSorted(items, size, (lo, hi) => hi - lo <= room(lo))) {
    if (g.length < 2) continue
    const vals = g.map(size), lo = Math.min(...vals), hi = Math.max(...vals)
    if (!unambiguous(lo, hi, items.filter(p => !g.includes(p)).map(size))) continue
    if (!g.some(p => p.inScope)) continue
    out.push({ g, lo, hi, room: room(lo) })
  }
  return out
}

/** The member the others are tied to: the one with a typed size, else the
 *  longest; null when two members carry different typed sizes. */
function referenceOf(doc: SketchDoc, g: Piece[]): Piece | null {
  const typed = g.filter(p => typedSize(doc, p) != null)
  const vals = typed.map(p => typedSize(doc, p)!)
  if (vals.length > 1 && Math.max(...vals) - Math.min(...vals) > 1e-9) return null
  return typed[0] ?? [...g].sort(longestFirst)[0]!
}
const closeness = (lo: number, hi: number, room: number) => (room > 0 ? 1 - (hi - lo) / room : 1)

export function detectEqualLengths(ctx: CleanupContext): Candidate[] {
  const out: Candidate[] = []
  for (const { g, lo, hi, room } of sizeGroups(ctx, linePieces(ctx).filter(p => !p.copy), p => p.len, TOL.LEN_FRAC, TOL.LEN_PX)) {
    const ref = referenceOf(ctx.doc, g)
    if (!ref) continue
    out.push({
      id: `equalLength:${g.map(p => pairKey(p.a!, p.b!)).sort().join('|')}`, kind: 'equalLength', label: `Same length ×${g.length}`,
      score: g.length + closeness(lo, hi, room), anchor: [ref.a!, ref.b!],
      rules: g.filter(p => p !== ref).map((p): RuleSpec => ({ kind: 'equalDist', refs: [ref.a!, ref.b!, p.a!, p.b!] })),
    })
  }
  return out
}

export function detectEqualRadii(ctx: CleanupContext): Candidate[] {
  const out: Candidate[] = []
  for (const { g, lo, hi, room } of sizeGroups(ctx, ctx.pieces.filter(p => isRound(p) && !p.copy), radiusOf, TOL.RAD_FRAC, TOL.RAD_PX)) {
    for (const part of [g.filter(p => p.kind === 'arc'), g.filter(p => p.kind === 'circle')]) {
      if (part.length < 2) continue
      const ref = referenceOf(ctx.doc, part)
      if (!ref) continue
      const rules: RuleSpec[] = part.filter(p => p !== ref).map((p): RuleSpec => (ref.kind === 'arc'
        ? { kind: 'equalDist', refs: [ref.c!, ref.a!, p.c!, p.a!] }
        : { kind: 'equalRadius', refs: [ref.circle!, p.circle!] }))
      out.push({
        id: `equalRadius:${part.map(stableKey).sort().join('|')}`, kind: 'equalRadius', label: `Same radius ×${part.length}`,
        score: part.length + closeness(lo, hi, room), anchor: ref.kind === 'arc' ? [ref.a!, ref.b!] : [ref.c!], rules,
      })
    }
  }
  return out
}

// ── sizes: Evenly spaced ────────────────────────────────────────────────────

export function detectEvenSpacing(ctx: CleanupContext): Candidate[] {
  const out: Candidate[] = []
  const maxRatio = 1 + TOL.GAP_FRAC * ctx.s
  const minGap = ctx.unitsPerPx * GUARD.ARC_MIN_PX
  const spreadScore = (n: number, ratio: number) => n + 1 - (ratio - 1) / (TOL.GAP_FRAC * ctx.s)
  // (a) a stack of parallel lines
  const ls = linePieces(ctx).filter(p => !p.copy)
  for (const { items } of clusterCircular(ls, lineAngleDeg, 0.05)) {
    if (items.length < 3) continue
    const ref = [...items].sort(longestFirst)[0]!
    const g = ref.geom
    const u = { x: (g.b!.x - g.a!.x) / ref.len, y: (g.b!.y - g.a!.y) / ref.len }, n = { x: -u.y, y: u.x }
    const rows = items.map(p => {
      const A = p.geom.a!, B = p.geom.b!
      const ta = A.x * u.x + A.y * u.y, tb = B.x * u.x + B.y * u.y
      return { p, o: ((A.x + B.x) / 2) * n.x + ((A.y + B.y) / 2) * n.y, lo: Math.min(ta, tb), hi: Math.max(ta, tb) }
    }).sort((x, y) => x.o - y.o)
    const gaps = rows.slice(1).map((r, k) => r.o - rows[k]!.o)
    const okGap = (k: number) => gaps[k]! >= minGap && Math.max(rows[k]!.lo, rows[k + 1]!.lo) < Math.min(rows[k]!.hi, rows[k + 1]!.hi)
    let i = 0
    while (i < gaps.length) {
      if (!okGap(i)) { i++; continue }
      let j = i
      while (j + 1 < gaps.length && okGap(j + 1)) {
        const run = gaps.slice(i, j + 2)
        if (Math.max(...run) / Math.min(...run) > maxRatio) break
        j++
      }
      if (j === i) { i++; continue }
      const run = rows.slice(i, j + 2).map(r => r.p)
      const runGaps = gaps.slice(i, j + 1)
      if (run.some(p => p.inScope)) {
        const inner = run.slice(1, -1).map((p, k) => ({ p, prev: run[k]!, next: run[k + 2]! }))
        out.push({
          id: `evenSpacing:${run.map(stableKey).sort().join('|')}`, kind: 'evenSpacing', label: 'Evenly spaced',
          score: spreadScore(run.length, Math.max(...runGaps) / Math.min(...runGaps)), anchor: [run[1]!.a!, run[1]!.b!],
          prepare: doc => inner.flatMap(({ p, prev, next }) => {
            const A = doc.entities.find(e => e.id === prev.a) as { x: number; y: number }
            const B = doc.entities.find(e => e.id === next.a) as { x: number; y: number }
            const m = addPoint(doc, (A.x + B.x) / 2, (A.y + B.y) / 2, { construction: true })
            return [{ kind: 'midpoint', refs: [m, prev.a!, next.a!] }, { kind: 'collinear', refs: [p.a!, p.b!, m] }] as RuleSpec[]
          }),
        })
      }
      i = j + 1
    }
  }
  // (b) points pinned on a line, with its ends
  for (const L of linePieces(ctx)) {
    if (L.copy) continue
    const pinned: EntityId[] = []
    for (const c of ctx.doc.constraints) {
      if (L.lineId && c.kind === 'pointOnLine' && c.refs[1] === L.lineId) pinned.push(c.refs[0]!)
      else if (!L.lineId && c.kind === 'collinear' && c.refs.length === 3 &&
        ((c.refs[0] === L.a && c.refs[1] === L.b) || (c.refs[0] === L.b && c.refs[1] === L.a))) pinned.push(c.refs[2]!)
    }
    const ids = [...new Set([L.a!, L.b!, ...pinned])].filter(id => ctx.pts.has(id))
    if (ids.length < 3) continue
    const A = L.geom.a!, u = { x: (L.geom.b!.x - A.x) / L.len, y: (L.geom.b!.y - A.y) / L.len }
    const along = ids.map(id => { const Q = ctx.pts.get(id)!; return { id, t: (Q.x - A.x) * u.x + (Q.y - A.y) * u.y } }).sort((x, y) => x.t - y.t)
    const gaps = along.slice(1).map((q, k) => q.t - along[k]!.t)
    const ratio = Math.max(...gaps) / Math.min(...gaps)
    if (Math.min(...gaps) < minGap || ratio > maxRatio) continue
    if (along.every(q => ctx.held.has(q.id))) continue
    out.push({
      id: `evenSpacing:${along.map(q => q.id).sort().join(',')}`, kind: 'evenSpacing', label: 'Evenly spaced',
      score: spreadScore(along.length, ratio), anchor: [L.a!, L.b!],
      rules: along.slice(0, -2).map((q, k): RuleSpec => ({ kind: 'equalDist', refs: [q.id, along[k + 1]!.id, along[k + 1]!.id, along[k + 2]!.id] })),
    })
  }
  return out
}

// ── nudges: Rounded ─────────────────────────────────────────────────────────

export function detectRound(ctx: CleanupContext): Candidate[] {
  if (1 / ctx.unitsPerPx < GUARD.ROUND_MIN_UNIT_PX) return []
  const frac = TOL.ROUND_FRAC * ctx.s
  const out: Candidate[] = []
  for (const p of ctx.pieces) {
    if (!p.inScope || p.copy || typedSize(ctx.doc, p) != null) continue
    const size = p.kind === 'line' ? p.len : radiusOf(p)
    const target = Math.round(size)
    const off = Math.abs(size - target)
    if (target < 1 || off < 1e-9 || off > frac * size) continue
    const nudge: Candidate['nudge'] = p.kind === 'line' ? { refs: [p.a!, p.b!], value: target }
      : p.kind === 'arc' ? { refs: [p.c!, p.a!], value: target }
      : { circle: p.circle!, value: target }
    out.push({
      id: `round:${stableKey(p)}`, kind: 'round', label: `Rounded to ${target}`, score: 1 - off / (frac * size),
      anchor: p.kind === 'circle' ? [p.c!] : [p.a!, p.b!], nudge,
    })
  }
  return out
}
