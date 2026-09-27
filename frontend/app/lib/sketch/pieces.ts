// app/lib/sketch/pieces.ts
// Pen stage 6: the drawing as the right-click menu and the Properties panel
// talk about it — pieces (points, lines, arcs, circles, curves) with names in
// drawing order ("Line 2", "Arc 3"), which pieces a rule ties, a rule's name
// in plain words, the rules that belong to a selection, and a selection's
// heading ("2 points", "1 arc", "3 selected"). Pure.
import type { SketchDoc, SketchConstraint, EntityId, PathEntity, SegmentSpec } from './model'
import { getEntity } from './model'
import { isPointReferenced } from './edit'

export type PieceRef =
  | { kind: 'point' | 'line' | 'circle'; id: EntityId }
  | { kind: 'seg'; pathId: EntityId; segIndex: number }

/** An Option-picked path segment (the pen's `selectedSegments` entries). */
export interface SegPick { pathId: EntityId; segIndex: number }

export function pieceKey(p: PieceRef): string {
  return p.kind === 'seg' ? `seg:${p.pathId}:${p.segIndex}` : `${p.kind}:${p.id}`
}

export const segCount = (p: PathEntity): number => (p.closed ? p.anchors.length : p.anchors.length - 1)
const endsOf = (p: PathEntity, i: number): [EntityId, EntityId] => [p.anchors[i]!, p.anchors[(i + 1) % p.anchors.length]!]
const segNoun = (s: SegmentSpec | undefined): string => (s?.kind === 'arc' ? 'arc' : s?.kind === 'cubic' ? 'curve' : 'line')

/** Every cubic handle point's id, keyed to the curve piece it shapes. */
export function handleCurves(doc: SketchDoc): Map<EntityId, PieceRef> {
  const out = new Map<EntityId, PieceRef>()
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (let i = 0; i < e.segments.length; i++) {
      const s = e.segments[i]
      if (s?.kind !== 'cubic') continue
      if (s.h1) out.set(s.h1, { kind: 'seg', pathId: e.id, segIndex: i })
      if (s.h2) out.set(s.h2, { kind: 'seg', pathId: e.id, segIndex: i })
    }
  }
  return out
}
// the curve a handle point shapes, or null (controller ruling C2: a Bézier
// handle is not a piece of its own — a rule on it reads as its curve)
function handleCurve(doc: SketchDoc, id: EntityId): PieceRef | null {
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (let i = 0; i < e.segments.length; i++) {
      const s = e.segments[i]
      if (s?.kind === 'cubic' && (s.h1 === id || s.h2 === id)) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

/** Every piece's name, keyed by pieceKey (Ruling 10). Bézier handle points
 *  get no name and no number (C2): they read as their curve. */
export function pieceNames(doc: SketchDoc): Map<string, string> {
  const out = new Map<string, string>()
  const n = { point: 0, line: 0, arc: 0, circle: 0, curve: 0 }
  const NAME: Record<string, string> = { line: 'Line', arc: 'Arc', curve: 'Curve' }
  const handles = handleCurves(doc)
  for (const e of doc.entities) {
    if (e.kind === 'point') { if (!handles.has(e.id)) out.set(`point:${e.id}`, `Point ${++n.point}`) }
    else if (e.kind === 'line') out.set(`line:${e.id}`, `Line ${++n.line}`)
    else if (e.kind === 'circle') out.set(`circle:${e.id}`, `Circle ${++n.circle}`)
    else {
      for (let i = 0; i < segCount(e); i++) {
        const noun = segNoun(e.segments[i]) as 'line' | 'arc' | 'curve'
        out.set(`seg:${e.id}:${i}`, `${NAME[noun]} ${++n[noun]}`)
      }
    }
  }
  return out
}

/** The line entity or straight path piece running between a and b (either way round). */
export function lineBetween(doc: SketchDoc, a: EntityId, b: EntityId): PieceRef | null {
  const pair = (x: EntityId, y: EntityId) => (x === a && y === b) || (x === b && y === a)
  for (const e of doc.entities) {
    if (e.kind === 'line' && pair(e.p1, e.p2)) return { kind: 'line', id: e.id }
    if (e.kind !== 'path') continue
    for (let i = 0; i < segCount(e); i++) {
      const [x, y] = endsOf(e, i)
      if (e.segments[i]?.kind === 'line' && pair(x, y)) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

/** The path arc with centre c that starts or ends at s. */
export function arcAt(doc: SketchDoc, c: EntityId, s: EntityId): PieceRef | null {
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (let i = 0; i < segCount(e); i++) {
      const seg = e.segments[i]
      if (seg?.kind !== 'arc' || seg.center !== c) continue
      const [x, y] = endsOf(e, i)
      if (x === s || y === s) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

function entityPiece(doc: SketchDoc, id: EntityId): PieceRef | null {
  const e = getEntity(doc, id)
  if (!e || e.kind === 'path') return null
  if (e.kind === 'point') { const h = handleCurve(doc, id); if (h) return h }
  return { kind: e.kind, id }
}
// a pair of point refs: the line between them, else the arc they are the
// centre and an end of (either order), else the two points
function pairPieces(doc: SketchDoc, x: EntityId, y: EntityId): (PieceRef | null)[] {
  const one = lineBetween(doc, x, y) ?? arcAt(doc, x, y) ?? arcAt(doc, y, x)
  return one ? [one] : [entityPiece(doc, x), entityPiece(doc, y)]
}
function dedupe(ps: (PieceRef | null)[]): PieceRef[] {
  const seen = new Set<string>()
  const out: PieceRef[] = []
  for (const p of ps) {
    if (!p) continue
    const k = pieceKey(p)
    if (!seen.has(k)) { seen.add(k); out.push(p) }
  }
  return out
}
// tangentArcs operands: a circle id alone, or an arc's [C, S]
function operandPieces(doc: SketchDoc, refs: EntityId[], from: number): (PieceRef | null)[] {
  const out: (PieceRef | null)[] = []
  for (let i = from; i < refs.length;) {
    if (getEntity(doc, refs[i]!)?.kind === 'circle') { out.push(entityPiece(doc, refs[i]!)); i += 1 }
    else { out.push(...pairPieces(doc, refs[i]!, refs[i + 1] ?? '')); i += 2 }
  }
  return out
}

/** `equalDist [C, A, C, B]` where an arc segment with centre C runs between A and B — every arc's own rule. */
export function isArcInvariant(doc: SketchDoc, c: SketchConstraint): boolean {
  if (c.kind !== 'equalDist' || c.refs.length !== 4 || c.refs[0] !== c.refs[2]) return false
  const [cen, a, , b] = c.refs as [EntityId, EntityId, EntityId, EntityId]
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (let i = 0; i < segCount(e); i++) {
      const s = e.segments[i]
      if (s?.kind !== 'arc' || s.center !== cen) continue
      const [x, y] = endsOf(e, i)
      if ((x === a && y === b) || (x === b && y === a)) return true
    }
  }
  return false
}

/** The pieces a rule ties, in ref order, without repeats. */
export function rulePieces(doc: SketchDoc, c: SketchConstraint): PieceRef[] {
  const r = c.refs
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
      return dedupe(r.length === 1 ? [entityPiece(doc, r[0]!)] : pairPieces(doc, r[0]!, r[1]!))
    case 'distance':
      return dedupe(pairPieces(doc, r[0]!, r[1]!))
    case 'equalDist':
      if (r.length === 4 && r[0] === r[2]) {
        return dedupe([arcAt(doc, r[0]!, r[1]!) ?? entityPiece(doc, r[1]!), arcAt(doc, r[0]!, r[3]!) ?? entityPiece(doc, r[3]!)])
      }
      if (r.length === 4) return dedupe([...pairPieces(doc, r[0]!, r[1]!), ...pairPieces(doc, r[2]!, r[3]!)])
      return dedupe(r.map(id => entityPiece(doc, id)))
    case 'perpendicular':
    case 'parallel':
      if (r.length === 4) return dedupe([...pairPieces(doc, r[0]!, r[1]!), ...pairPieces(doc, r[2]!, r[3]!)])
      return dedupe(r.map(id => entityPiece(doc, id)))
    case 'collinear': {
      const [a, b, p] = r as [EntityId, EntityId, EntityId]
      const arc1 = arcAt(doc, a, b), arc2 = arcAt(doc, p, b)
      if (arc1 && arc2) return dedupe([arc1, arc2])
      const l = lineBetween(doc, a, b)
      if (l) return dedupe([l, entityPiece(doc, p)])
      return dedupe(r.map(id => entityPiece(doc, id)))
    }
    case 'midpoint':
      return dedupe([entityPiece(doc, r[0]!), ...pairPieces(doc, r[1]!, r[2]!)])
    case 'tangentLineArc':
      return dedupe([...pairPieces(doc, r[0]!, r[1]!), ...operandPieces(doc, r, 2)])
    case 'tangentArcs':
      return dedupe(operandPieces(doc, r, 0))
    default:
      return dedupe(r.map(id => entityPiece(doc, id)))
  }
}

const fmt = (v: number | undefined) => String(Number((v ?? 0).toFixed(2)))

/** A rule's name in plain words (Ruling 11). */
export function ruleName(doc: SketchDoc, c: SketchConstraint): string {
  const r = c.refs
  switch (c.kind) {
    case 'coincident': return 'Coincident'
    case 'pointOnLine': return 'On line'
    case 'pointOnCircle': return 'On circle'
    case 'tangentLineCircle': case 'tangentCircleCircle': case 'tangentLineArc': case 'tangentArcs': return 'Tangent'
    case 'concentric': return 'Concentric'
    case 'horizontal': return 'Horizontal'
    case 'vertical': return 'Vertical'
    case 'distance': return (arcAt(doc, r[0]!, r[1]!) || arcAt(doc, r[1]!, r[0]!)) ? `Radius ${fmt(c.value)}` : `Distance ${fmt(c.value)}`
    case 'radius': return `Radius ${fmt(c.value)}`
    case 'equalDist':
      if (r.length === 4 && r[0] === r[2] && !(arcAt(doc, r[0]!, r[1]!) && arcAt(doc, r[0]!, r[3]!))) return 'On curve'
      return 'Equal'
    case 'equalRadius': return 'Equal'
    case 'rotatedFrom': return 'Repeat copy'
    case 'mirroredFrom': return 'Mirror copy'
    case 'collinear':
      if (arcAt(doc, r[0]!, r[1]!) && arcAt(doc, r[2]!, r[1]!)) return 'Tangent'
      if (lineBetween(doc, r[0]!, r[1]!)) return 'On curve'
      return 'Smooth'
    case 'perpendicular':
      if (r.length === 4 && r[1] === r[2]) {
        return (arcAt(doc, r[3]!, r[2]!) || arcAt(doc, r[0]!, r[1]!)) ? 'Tangent' : 'Right angle'
      }
      return 'Perpendicular'
    case 'parallel': return 'Parallel'
    case 'midpoint': return 'Midpoint'
  }
}

/** "Tangent — Line 2 · Arc 3" */
export function ruleLabel(doc: SketchDoc, c: SketchConstraint, names: Map<string, string>): string {
  const pieces = rulePieces(doc, c).map(p => names.get(pieceKey(p))).filter((x): x is string => !!x)
  return pieces.length ? `${ruleName(doc, c)} — ${pieces.join(' · ')}` : ruleName(doc, c)
}

/** The piece keys a selection covers: a whole path counts its pieces and its points. */
export function selectionKeys(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): Set<string> {
  const out = new Set<string>()
  for (const id of sel) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind !== 'path') { out.add(`${e.kind}:${id}`); continue }
    for (let i = 0; i < segCount(e); i++) out.add(`seg:${id}:${i}`)
    for (const a of e.anchors) out.add(`point:${a}`)
  }
  for (const s of segs) out.add(`seg:${s.pathId}:${s.segIndex}`)
  return out
}

/** A Repeat / Mirror copy's own bookkeeping rule — hidden from the rules
 *  list like the canvas badges hide it (controller ruling C2: a ring of
 *  copies would flood the list). */
export const isCopyRule = (c: SketchConstraint): boolean => c.kind === 'rotatedFrom' || c.kind === 'mirroredFrom'

/** Every rule that ties a selected piece, except each arc's own equal-ends
 *  rule (Ruling 11) and the copy rules (C2). A selected handle point counts
 *  as its curve. */
export function rulesForSelection(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): SketchConstraint[] {
  const keys = selectionKeys(doc, sel, segs)
  if (!keys.size) return []
  const handles = handleCurves(doc)
  for (const id of sel) { const h = handles.get(id); if (h) keys.add(pieceKey(h)) }
  return doc.constraints.filter(c => !isCopyRule(c) && !isArcInvariant(doc, c) && rulePieces(doc, c).some(p => keys.has(pieceKey(p))))
}

function nounOf(doc: SketchDoc, id: EntityId): string | null {
  const e = getEntity(doc, id)
  if (!e) return null
  if (e.kind !== 'path') return e.kind
  return segCount(e) === 1 ? segNoun(e.segments[0]) : 'path'
}

/** "Nothing selected", "2 points", "1 arc", "3 selected" — a one-piece path reads as its piece. */
export function selectionLabel(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): string {
  const nouns = [
    ...sel.map(id => nounOf(doc, id)),
    ...segs.map(s => { const p = getEntity(doc, s.pathId); return p?.kind === 'path' ? segNoun(p.segments[s.segIndex]) : null }),
  ].filter((n): n is string => !!n)
  if (!nouns.length) return 'Nothing selected'
  const n = nouns.length
  return nouns.every(x => x === nouns[0]) ? `${n} ${nouns[0]}${n === 1 ? '' : 's'}` : `${n} selected`
}

/** Every piece that isn't a point, plus points no piece uses — what Select all selects. */
export function topLevelIds(doc: SketchDoc): EntityId[] {
  return doc.entities.filter(e => e.kind !== 'point' || !isPointReferenced(doc, e.id)).map(e => e.id)
}
