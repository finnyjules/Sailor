// How a point looks in the pen overlay (spec: "How points look").
//
// A point that is shared by two or more pieces — a path's interior anchor
// (incident to two of its segments), two entities merged onto the same
// point, or a point pinned onto a curve by an on-curve rule (pointOnLine,
// pointOnCircle, midpoint, a collinear on-curve pin, or an equalDist on-arc
// pin — a "T-junction") — reads as a JOINT (small solid dot). A point used
// as exactly one line/path-segment endpoint and nothing else is a loose END
// (hollow square). A circle or arc-segment centre used only as a centre is a
// CENTRE (hollow circle). Anything else — a lone, unattached point — is FREE
// (today's plain look). Construction points keep their own look regardless
// of role; the overlay decides that, this module only reports topology.
//
// Pure: never mutates `doc`, never solves.
import type { SketchDoc, EntityId, PathEntity } from './model'

export type PointRole = 'joint' | 'end' | 'centre' | 'free'

// every point id used as a cubic segment's h1/h2 handle, across committed
// paths only (pending-path handles are not in `doc` yet, and don't matter —
// pointRole is a read of the committed doc, like the rest of this module)
function handleIdSet(doc: SketchDoc): Set<EntityId> {
  const out = new Set<EntityId>()
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    for (const s of e.segments) {
      if (s.kind !== 'cubic') continue
      if (s.h1) out.add(s.h1)
      if (s.h2) out.add(s.h2)
    }
  }
  return out
}

// per arc-segment centre id, the set of that arc's OWN start/end anchors —
// used to tell a structural arc-integrity invariant (equalDist[C,start,C,end],
// added by addPath) apart from a genuine on-curve pin (equalDist[C,p,C,a])
// that shares the same [C, x, C, y] shape.
function arcOwnAnchorsByCentre(doc: SketchDoc): Map<EntityId, Set<EntityId>> {
  const out = new Map<EntityId, Set<EntityId>>()
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    const p = e as PathEntity
    const n = p.anchors.length
    for (let i = 0; i < p.segments.length; i++) {
      const seg = p.segments[i]!
      if (seg.kind !== 'arc') continue
      const a = p.anchors[i]!, b = p.anchors[(i + 1) % n]!
      let set = out.get(seg.center)
      if (!set) { set = new Set(); out.set(seg.center, set) }
      set.add(a); set.add(b)
    }
  }
  return out
}

/** Every point's role, computed once over the whole doc. Prefer this in a
 *  render loop that looks up many points; `pointRole` recomputes it each call. */
export function pointRolesForDoc(doc: SketchDoc): Map<EntityId, PointRole> {
  // total "piece" references — a line end, a path-segment end, a circle or
  // arc centre — landing on this point. >=2 (of any mix) is a joint: a point
  // shared between two pieces, however they're combined.
  const refs = new Map<EntityId, number>()
  const centreRefs = new Map<EntityId, number>()
  const bump = (m: Map<EntityId, number>, id: EntityId) => m.set(id, (m.get(id) ?? 0) + 1)

  for (const e of doc.entities) {
    if (e.kind === 'line') {
      bump(refs, e.p1); bump(refs, e.p2)
    } else if (e.kind === 'circle') {
      bump(refs, e.center); bump(centreRefs, e.center)
    } else if (e.kind === 'path') {
      const n = e.anchors.length
      for (let i = 0; i < e.segments.length; i++) {
        const seg = e.segments[i]!
        const a = e.anchors[i]!, b = e.anchors[(i + 1) % n]!
        bump(refs, a); bump(refs, b)
        if (seg.kind === 'arc') { bump(refs, seg.center); bump(centreRefs, seg.center) }
      }
    }
  }

  // T-junction pins: points an on-curve constraint lands on a line, circle,
  // path line segment or path arc segment — always a joint, regardless of
  // how many "piece" refs it separately carries (usually just one).
  const tJunction = new Set<EntityId>()
  const handles = handleIdSet(doc)
  const arcOwn = arcOwnAnchorsByCentre(doc)
  for (const c of doc.constraints) {
    if (c.kind === 'pointOnLine' || c.kind === 'pointOnCircle') {
      if (c.refs[0]) tJunction.add(c.refs[0])
    } else if (c.kind === 'midpoint') {
      if (c.refs[0]) tJunction.add(c.refs[0])
    } else if (c.kind === 'collinear' && c.refs.length === 3) {
      const [x, , z] = c.refs as [EntityId, EntityId, EntityId]
      // [hIn, anchor, hOut] (a smooth path anchor's own rule) vs.
      // [A, B, p] (a point pinned onto line segment A→B) — handles only ever
      // appear in the smooth-anchor form, so their presence tells them apart.
      if (!handles.has(x) && !handles.has(z)) tJunction.add(z)
    } else if (c.kind === 'equalDist' && c.refs.length === 4 && c.refs[0] === c.refs[2]) {
      const centre = c.refs[0]!
      const own = arcOwn.get(centre)
      const x = c.refs[1]!, y = c.refs[3]!
      if (!own || !own.has(x)) tJunction.add(x)
      if (!own || !own.has(y)) tJunction.add(y)
    }
  }

  const out = new Map<EntityId, PointRole>()
  for (const e of doc.entities) {
    if (e.kind !== 'point') continue
    const total = refs.get(e.id) ?? 0
    const centre = centreRefs.get(e.id) ?? 0
    let role: PointRole
    if (total >= 2) role = 'joint'
    else if (tJunction.has(e.id)) role = 'joint'
    else if (total === 1 && centre === 0) role = 'end'
    else if (centre >= 1) role = 'centre'
    else role = 'free'
    out.set(e.id, role)
  }
  return out
}

/** A single point's role — see `pointRolesForDoc` for the rule and a batch
 *  form cheaper to use for every point in a render pass. */
export function pointRole(doc: SketchDoc, id: EntityId): PointRole {
  return pointRolesForDoc(doc).get(id) ?? 'free'
}
