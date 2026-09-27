import type { Vec2 } from './geom'

export type EntityId = string

export interface PointEntity { id: EntityId; kind: 'point'; x: number; y: number; construction?: boolean; fixed?: boolean }
export interface LineEntity { id: EntityId; kind: 'line'; p1: EntityId; p2: EntityId; construction?: boolean }
export interface CircleEntity { id: EntityId; kind: 'circle'; center: EntityId; r: number; construction?: boolean }

export type SegmentSpec =
  | { kind: 'line' }
  | { kind: 'arc'; center: EntityId; sweep: 0 | 1 }
  | { kind: 'cubic'; h1: EntityId | null; h2: EntityId | null }   // reserved for M2

export interface PathEntity {
  id: EntityId
  kind: 'path'
  anchors: EntityId[]           // ordered point ids, length >= 2
  segments: SegmentSpec[]       // length == anchors.length - 1 (open) or anchors.length (closed)
  closed: boolean
  construction?: boolean
}

export type SketchEntity = PointEntity | LineEntity | CircleEntity | PathEntity

export type ConstraintKind =
  | 'coincident' | 'pointOnLine' | 'pointOnCircle'
  | 'tangentLineCircle' | 'tangentCircleCircle' | 'concentric'
  | 'horizontal' | 'vertical' | 'distance' | 'radius'
  | 'equalDist' | 'rotatedFrom' | 'mirroredFrom' | 'collinear'
  | 'perpendicular' | 'parallel' | 'midpoint' | 'equalRadius'
  // pen stage 4 (tangency.ts): [A, B, C, S] or [A, B, circleId]; and
  // [C1, S1, C2, S2] (either pair may be a circle id) with value +1 outside / −1 inside
  | 'tangentLineArc' | 'tangentArcs'
  // pen stage 8 (Ruling 1): offsetLine [A, B, P] value d — P's signed
  // distance from line A→B is d (left positive); offsetRadius [C, S, C, T]
  // value d — |C T| − |C S| = d (either pair may be a circle id);
  // translatedFrom [copy, orig, from, to] value k — copy = orig + k·(to − from)
  | 'offsetLine' | 'offsetRadius' | 'translatedFrom'

export interface SketchConstraint {
  id: EntityId
  kind: ConstraintKind
  refs: EntityId[]     // entity ids the constraint relates, order defined per kind
  value?: number       // for 'distance' and 'radius'
}

/** Pen stage 7: where a filled area is — a spot on one of its edges, so the
 *  fill follows the drawing (see lib/sketch/fills.ts). The piece is named by
 *  its points in its own direction of travel: a line p1→p2 or a straight path
 *  piece anchor i→i+1; an arc path piece anchor i→i+1 about centre `c`,
 *  turning counter-clockwise when `ccw`; a circle by its own id (`a` and `b`)
 *  and its centre `c`. `t` is how far along it (0..1 from `a`; a circle: the
 *  angle / 2π counter-clockwise from +x), `side` which side the area lies on
 *  (1 = left of the direction of travel, −1 = right). */
export interface FillSeed {
  kind: 'line' | 'arc' | 'circle'
  a: EntityId
  b: EntityId
  c?: EntityId
  ccw?: boolean
  t: number
  side: 1 | -1
}
export interface SketchFill { id: EntityId; seed: FillSeed }

export interface SketchDoc {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  /** pen stage 7: filled areas (absent = none; a drawing from before stage 7) */
  fills?: SketchFill[]
  /** pen stage 7: how far (drawing units) an open end may stop short and its
   *  area still fill — fixed at the first fill, cleared with the last */
  fillGap?: number
}

export function getEntity(doc: SketchDoc, id: EntityId): SketchEntity | undefined {
  return doc.entities.find(e => e.id === id)
}

export function getPoint(doc: SketchDoc, id: EntityId): PointEntity | undefined {
  const e = getEntity(doc, id)
  return e && e.kind === 'point' ? e : undefined
}

export function lineEndpoints(doc: SketchDoc, line: LineEntity): { a: Vec2; b: Vec2 } | null {
  const a = getPoint(doc, line.p1)
  const b = getPoint(doc, line.p2)
  if (!a || !b) return null
  return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } }
}

export function circleCenter(doc: SketchDoc, circle: CircleEntity): Vec2 | null {
  const c = getPoint(doc, circle.center)
  return c ? { x: c.x, y: c.y } : null
}
