import type { SketchDoc, SketchEntity, SketchConstraint, ConstraintKind, SketchFill } from './model'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const CONSTRAINT_KINDS: ConstraintKind[] = [
  'coincident', 'pointOnLine', 'pointOnCircle', 'tangentLineCircle', 'tangentCircleCircle',
  'concentric', 'horizontal', 'vertical', 'distance', 'radius',
  'equalDist', 'rotatedFrom', 'mirroredFrom', 'collinear',
  'perpendicular', 'parallel', 'midpoint', 'equalRadius',
  'tangentLineArc', 'tangentArcs',
]
const NEEDS_VALUE = new Set<ConstraintKind>(['distance', 'radius', 'rotatedFrom', 'tangentArcs'])

function mergeEntity(raw: any): SketchEntity | null {
  if (!raw || !isStr(raw.id)) return null
  const base = { id: raw.id, ...(raw.construction ? { construction: true } : {}) }
  if (raw.kind === 'point') {
    if (!isNum(raw.x) || !isNum(raw.y)) return null
    return { ...base, kind: 'point', x: raw.x, y: raw.y, ...(raw.fixed ? { fixed: true } : {}) }
  }
  if (raw.kind === 'line') {
    if (!isStr(raw.p1) || !isStr(raw.p2)) return null
    return { ...base, kind: 'line', p1: raw.p1, p2: raw.p2 }
  }
  if (raw.kind === 'circle') {
    if (!isStr(raw.center) || !isNum(raw.r)) return null
    return { ...base, kind: 'circle', center: raw.center, r: Math.max(0, raw.r) }
  }
  return null
}

export function mergeSketchDoc(raw: unknown): SketchDoc {
  const doc: SketchDoc = { entities: [], constraints: [] }
  if (!raw || typeof raw !== 'object') return doc
  const r = raw as any

  const seen = new Set<string>()
  // pass 1: non-path entities (unchanged logic)
  const rawPaths: any[] = []
  if (Array.isArray(r.entities)) {
    for (const e of r.entities) {
      if (e && e.kind === 'path') { rawPaths.push(e); continue }
      const m = mergeEntity(e)
      if (m && !seen.has(m.id)) { seen.add(m.id); doc.entities.push(m) }
    }
  }
  // pass 2: paths, validated against surviving points
  const pointIds = new Set(doc.entities.filter(e => e.kind === 'point').map(e => e.id))
  for (const p of rawPaths) {
    if (!isStr(p.id) || seen.has(p.id)) continue
    if (!Array.isArray(p.anchors) || p.anchors.length < 2) continue
    if (!p.anchors.every((a: unknown) => isStr(a) && pointIds.has(a as string))) continue
    const need = p.closed ? p.anchors.length : p.anchors.length - 1
    if (!Array.isArray(p.segments) || p.segments.length !== need) continue
    const segs: any[] = []
    let ok = true
    for (const s of p.segments) {
      if (s && s.kind === 'line') segs.push({ kind: 'line' })
      else if (s && s.kind === 'arc' && isStr(s.center) && pointIds.has(s.center) && (s.sweep === 0 || s.sweep === 1)) segs.push({ kind: 'arc', center: s.center, sweep: s.sweep })
      else if (s && s.kind === 'cubic' && (s.h1 == null || (isStr(s.h1) && pointIds.has(s.h1))) && (s.h2 == null || (isStr(s.h2) && pointIds.has(s.h2)))) segs.push({ kind: 'cubic', h1: s.h1 ?? null, h2: s.h2 ?? null })
      else { ok = false; break }
    }
    if (!ok) continue
    seen.add(p.id)
    doc.entities.push({ id: p.id, kind: 'path', anchors: [...p.anchors], segments: segs, closed: !!p.closed, ...(p.construction ? { construction: true } : {}) } as any)
  }

  const ids = new Set(doc.entities.map(e => e.id))
  const seenK = new Set<string>()
  if (Array.isArray(r.constraints)) {
    for (const c of r.constraints) {
      if (!c || !isStr(c.id) || seenK.has(c.id)) continue
      if (!CONSTRAINT_KINDS.includes(c.kind)) continue
      if (!Array.isArray(c.refs) || !c.refs.every((x: unknown) => isStr(x) && ids.has(x as string))) continue
      if (NEEDS_VALUE.has(c.kind) && !isNum(c.value)) continue
      seenK.add(c.id)
      doc.constraints.push({ id: c.id, kind: c.kind, refs: [...c.refs], ...(isNum(c.value) ? { value: c.value } : {}) } as SketchConstraint)
    }
  }
  // pen stage 7: fills (optional — a drawing from before stage 7 has none), each
  // kept only when its seed names pieces this drawing still has
  if (Array.isArray(r.fills)) {
    const points = new Set(doc.entities.filter(e => e.kind === 'point').map(e => e.id))
    const circles = new Set(doc.entities.filter(e => e.kind === 'circle').map(e => e.id))
    const seenF = new Set<string>()
    const fills: SketchFill[] = []
    for (const f of r.fills) {
      const s = f?.seed
      if (!f || !isStr(f.id) || seenF.has(f.id) || !s || typeof s !== 'object') continue
      if (!isNum(s.t) || s.t < 0 || s.t > 1 || (s.side !== 1 && s.side !== -1)) continue
      if (s.kind === 'line') { if (!points.has(s.a) || !points.has(s.b)) continue }
      else if (s.kind === 'arc') { if (!points.has(s.a) || !points.has(s.b) || !points.has(s.c) || typeof s.ccw !== 'boolean') continue }
      else if (s.kind === 'circle') { if (!circles.has(s.a) || s.b !== s.a || !points.has(s.c)) continue }
      else continue
      seenF.add(f.id)
      fills.push({ id: f.id, seed: {
        kind: s.kind, a: s.a, b: s.b,
        ...(s.kind !== 'line' ? { c: s.c } : {}),
        ...(s.kind === 'arc' ? { ccw: s.ccw } : {}),
        t: s.t, side: s.side,
      } })
    }
    if (fills.length) {
      doc.fills = fills
      if (isNum(r.fillGap) && r.fillGap > 0) doc.fillGap = r.fillGap
    }
  }
  return doc
}
