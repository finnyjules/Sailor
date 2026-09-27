// app/composables/pen/penTipDemos.ts
// The little looping animations on the pen toolbar's tooltip cards
// (PenTipCard.vue): one scripted drawing per drawing/editing tool, and one for
// Clean up, acting out the gesture in a few beats. Each demo is a pure function of t ∈ [0, 1)
// (one loop, ~2.4 s) returning a SketchDoc the card renders through the pen's
// own sketchPathData — so the demo looks exactly like the pen — plus the
// cursor, whether it is pressed, and a few overlays (a highlight, a dotted
// ghost of something removed, anchor dots, a sparkle).
//
// Coordinates are the card's own 160 × 96 box, y down (drawn straight into an
// SVG viewBox of that size — no view matrix).
import type { SketchDoc, EntityId, SegmentSpec } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import { toggleFillAt } from '~/lib/sketch/fills'

export const DEMO_W = 160
export const DEMO_H = 96
export const DEMO_LOOP_MS = 2400

export interface PenTipFrame {
  doc: SketchDoc
  cursor: Vec2
  pressed: boolean
  sparkle?: Vec2
  /** 0 → 1 over the sparkle's life (scale/fade) */
  sparkleT?: number
  /** highlighted geometry: a hovered piece, a rubber band, a handle */
  tint?: SketchDoc
  /** dotted remains of something just removed */
  ghost?: SketchDoc
  /** anchor dots */
  dots?: Vec2[]
  /** dots drawn highlighted (hovered / grabbed) */
  hot?: Vec2[]
  /** the Fill tool's hover: the area under this point is shown hatched */
  hatchAt?: Vec2
}

// ── tiny drawing builder ─────────────────────────────────────────────────────
type SegIn = 'line' | { via: Vec2 } | { h1?: Vec2; h2?: Vec2 }

class Sketch {
  doc: SketchDoc = { entities: [], constraints: [] }
  private n = 0
  private id(prefix: string): EntityId { return `${prefix}${this.n++}` }
  p(v: Vec2): EntityId {
    const id = this.id('p')
    this.doc.entities.push({ id, kind: 'point', x: v.x, y: v.y })
    return id
  }
  line(a: Vec2, b: Vec2): this {
    this.doc.entities.push({ id: this.id('l'), kind: 'line', p1: this.p(a), p2: this.p(b) })
    return this
  }
  circle(c: Vec2, r: number): this {
    this.doc.entities.push({ id: this.id('c'), kind: 'circle', center: this.p(c), r })
    return this
  }
  /** a path through `pts`; segment i joins pts[i] → pts[i+1] */
  path(pts: Vec2[], segs: SegIn[], closed = false): this {
    const anchors = pts.map(v => this.p(v))
    const segments: SegmentSpec[] = segs.map((s, i) => {
      const from = pts[i]!, to = pts[(i + 1) % pts.length]!
      if (s === 'line') return { kind: 'line' }
      if ('via' in s) {
        const arc = arcThrough(from, to, s.via)
        return arc ? { kind: 'arc', center: this.p(arc.c), sweep: arc.sweep } : { kind: 'line' }
      }
      return { kind: 'cubic', h1: s.h1 ? this.p(s.h1) : null, h2: s.h2 ? this.p(s.h2) : null }
    })
    this.doc.entities.push({ id: this.id('P'), kind: 'path', anchors, segments, closed })
    return this
  }
}
const sk = () => new Sketch()

/** the arc from `from` to `to` passing through `via`: its centre and the sweep
 *  flag sketchPath.ts's pathD reads (1 = increasing angle). Null when the
 *  three points are (nearly) in a line. */
function arcThrough(from: Vec2, to: Vec2, via: Vec2): { c: Vec2; sweep: 0 | 1 } | null {
  const ax = from.x, ay = from.y, bx = via.x, by = via.y, cx = to.x, cy = to.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-6) return null
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const c = {
    x: (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    y: (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  }
  if (Math.hypot(from.x - c.x, from.y - c.y) > 4000) return null
  const TAU = Math.PI * 2
  const ang = (v: Vec2) => Math.atan2(v.y - c.y, v.x - c.x)
  const ccw = (a: number, b: number) => ((b - a) % TAU + TAU) % TAU
  const a0 = ang(from)
  return { c, sweep: ccw(a0, ang(via)) < ccw(a0, ang(to)) ? 1 : 0 }
}

// ── timing helpers ───────────────────────────────────────────────────────────
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const ease = (x: number) => x * x * (3 - 2 * x)
/** eased progress of t through [a, b] */
const prog = (t: number, a: number, b: number) => ease(clamp01((t - a) / (b - a)))
const lerp = (a: Vec2, b: Vec2, k: number): Vec2 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
const v = (x: number, y: number): Vec2 => ({ x, y })
const within = (t: number, a: number, b: number) => t >= a && t < b
/** the cursor along keyframes [t, position], eased between each pair */
function track(t: number, keys: [number, Vec2][]): Vec2 {
  if (t <= keys[0]![0]) return keys[0]![1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1] = keys[i]!
    const [t0, p0] = keys[i - 1]!
    if (t <= t1) return lerp(p0, p1, prog(t, t0, t1))
  }
  return keys[keys.length - 1]![1]
}
/** a sparkle living over [a, a + 0.12) */
function sparkleAt(t: number, a: number, at: Vec2): Pick<PenTipFrame, 'sparkle' | 'sparkleT'> {
  return within(t, a, a + 0.12) ? { sparkle: at, sparkleT: (t - a) / 0.12 } : {}
}
const onCircle = (c: Vec2, r: number, deg: number): Vec2 => ({ x: c.x + r * Math.cos(deg * Math.PI / 180), y: c.y + r * Math.sin(deg * Math.PI / 180) })

// ── the demos ────────────────────────────────────────────────────────────────

// Select: point at a corner, press, drag it out, let go.
function select(t: number): PenTipFrame {
  const A = v(36, 76), B = v(116, 76), C = v(72, 26), C2 = v(104, 18)
  const cursor = track(t, [[0.05, v(140, 88)], [0.3, C], [0.36, C], [0.66, C2], [0.8, C2], [0.95, v(136, 60)]])
  const pressed = within(t, 0.36, 0.72)
  const c = t < 0.36 ? C : lerp(C, C2, prog(t, 0.36, 0.66))
  const near = Math.hypot(cursor.x - c.x, cursor.y - c.y) < 6
  return {
    doc: sk().path([A, B, c], ['line', 'line', 'line'], true).doc,
    cursor, pressed,
    dots: [A, B, c],
    hot: near || pressed ? [c] : [],
  }
}

// Pen: click a new point, then press on it and drag — the piece into it bends
// into an arc through the pointer (as the pen's bowArc: through the previous
// point, the new point and the pointer).
function path(t: number): PenTipFrame {
  const A = v(22, 72), B = v(64, 72), C = v(112, 46)
  const bulge = v(80, 43)   // where the drag ends: above the middle of B→C
  const cursor = track(t, [[0.04, v(76, 88)], [0.3, C], [0.46, C], [0.78, bulge], [0.96, bulge]])
  const pressed = within(t, 0.3, 0.36) || within(t, 0.46, 0.8)
  const placed = t >= 0.33
  const bent = t > 0.48
  const s = sk()
  if (!placed) s.path([A, B], ['line'])
  else s.path([A, B, C], ['line', bent ? { via: cursor } : 'line'])
  return {
    doc: s.doc, cursor, pressed,
    tint: placed ? undefined : sk().line(B, cursor).doc,
    dots: placed ? [A, B, C] : [A, B],
    hot: placed ? [C] : [],
  }
}

// Bézier curve: press where the next point goes and drag out its handles.
function curve(t: number): PenTipFrame {
  const A = v(22, 70), B = v(62, 44), C = v(112, 66), D = v(138, 36)
  const cursor = track(t, [[0.04, v(88, 86)], [0.3, C], [0.34, C], [0.72, D], [0.96, D]])
  const pressed = within(t, 0.34, 0.76)
  const placed = t >= 0.34
  const drag = lerp(C, D, prog(t, 0.34, 0.72))
  const back = v(2 * C.x - drag.x, 2 * C.y - drag.y)   // the handle behind the point mirrors the drag
  const pulled = Math.hypot(drag.x - C.x, drag.y - C.y) > 0.5
  const s = sk()
  if (!placed) s.path([A, B], ['line'])
  else s.path([A, B, C], ['line', pulled ? { h2: back } : 'line'])
  return {
    doc: s.doc, cursor, pressed,
    tint: !placed ? sk().line(B, cursor).doc : pulled ? sk().line(back, drag).doc : undefined,
    dots: placed ? (pulled ? [A, B, C, back, drag] : [A, B, C]) : [A, B],
    hot: placed ? [C] : [],
  }
}

// Line: click where it starts (it snaps onto the end already there), click where it ends.
function line(t: number): PenTipFrame {
  const G0 = v(18, 76), G1 = v(78, 76), E = v(132, 24)
  const cursor = track(t, [[0.02, v(60, 40)], [0.16, G1], [0.24, G1], [0.56, E], [0.96, E]])
  const pressed = within(t, 0.16, 0.22) || within(t, 0.56, 0.62)
  const s = sk().line(G0, G1)
  const done = t >= 0.59
  if (done) s.line(G1, E)
  return {
    doc: s.doc, cursor, pressed,
    tint: t >= 0.19 && !done ? sk().line(G1, cursor).doc : undefined,
    dots: done ? [G0, G1, E] : [G0, G1],
    hot: t >= 0.19 && !done ? [G1] : [],
    ...sparkleAt(t, 0.19, G1),
    ...(done ? sparkleAt(t, 0.59, E) : {}),
  }
}

// Circle: click the centre, move out, click again for the size.
function circle(t: number): PenTipFrame {
  const L0 = v(14, 60), L1 = v(146, 60), O = v(80, 60), R = v(104, 38)
  const cursor = track(t, [[0.02, v(40, 24)], [0.2, O], [0.28, O], [0.6, R], [0.96, R]])
  const pressed = within(t, 0.2, 0.26) || within(t, 0.6, 0.66)
  const r = Math.hypot(cursor.x - O.x, cursor.y - O.y)
  const s = sk().line(L0, L1)
  const done = t >= 0.63
  const live = t >= 0.23 && !done
  if (done) s.circle(O, Math.hypot(R.x - O.x, R.y - O.y))
  const band = sk().line(O, cursor)
  if (r > 1) band.circle(O, r)
  return {
    doc: s.doc, cursor, pressed,
    tint: live ? band.doc : undefined,
    dots: t >= 0.23 ? [O] : [],
    hot: live ? [O] : [],
    ...sparkleAt(t, 0.23, O),
  }
}

// Point: three clicks; each point snaps onto the circle with a sparkle.
function point(t: number): PenTipFrame {
  const O = v(80, 48), r = 30
  const P = [onCircle(O, r, 205), onCircle(O, r, 300), onCircle(O, r, 40)]
  const clicks = [0.22, 0.46, 0.7]
  const cursor = track(t, [[0.02, v(20, 88)], [0.2, P[0]!], [0.26, P[0]!], [0.44, P[1]!], [0.5, P[1]!], [0.68, P[2]!], [0.96, P[2]!]])
  const pressed = clicks.some(c => within(t, c - 0.02, c + 0.04))
  const placed = P.filter((_, i) => t >= clicks[i]! + 0.01)
  const last = clicks.map((c, i) => [c + 0.01, P[i]!] as const).filter(([c]) => t >= c).pop()
  return {
    doc: sk().circle(O, r).doc, cursor, pressed,
    dots: placed,
    ...(last ? sparkleAt(t, last[0], last[1]) : {}),
  }
}

// Trim: two crossing circles; point at the piece inside the other circle
// (it lights up), click, it goes and a dotted ghost stays.
function trim(t: number): PenTipFrame {
  const CA = v(62, 48), CB = v(98, 48), r = 26
  const h = Math.sqrt(r * r - 18 * 18)
  const T = v(80, 48 - h), U = v(80, 48 + h)
  const inner = v(CA.x + r, 48), outer = v(CA.x - r, 48)
  const at = v(inner.x - 1, inner.y + 3)
  // after the click the cursor steps aside so the ghost shows
  const cursor = track(t, [[0.04, v(140, 88)], [0.32, at], [0.64, at], [0.84, v(128, 80)]])
  const pressed = within(t, 0.5, 0.56)
  const removed = t >= 0.53
  const s = sk().circle(CB, r)
  if (removed) s.path([T, U], [{ via: outer }])
  else s.circle(CA, r)
  const piece = sk().path([T, U], [{ via: inner }]).doc
  return {
    doc: s.doc, cursor, pressed,
    tint: t >= 0.3 && !removed ? piece : undefined,
    ghost: removed ? piece : undefined,
    dots: removed ? [T, U] : [],
    ...sparkleAt(t, 0.53, inner),
  }
}

// Cut: point at a line (the cut point shows), click, it becomes two pieces.
function cut(t: number): PenTipFrame {
  const A = v(20, 68), B = v(140, 32), M = lerp(A, B, 0.5)
  const at = v(M.x + 1, M.y + 2)
  const cursor = track(t, [[0.04, v(60, 88)], [0.34, at], [0.64, at], [0.84, v(110, 76)]])
  const pressed = within(t, 0.5, 0.56)
  const done = t >= 0.53
  const s = sk()
  if (done) s.path([A, M, B], ['line', 'line'])
  else s.path([A, B], ['line'])
  return {
    doc: s.doc, cursor, pressed,
    tint: done ? sk().path([M, B], ['line']).doc : undefined,
    dots: done ? [A, M, B] : [A, B],
    hot: t >= 0.32 ? [M] : [],
    ...sparkleAt(t, 0.53, M),
  }
}

// Dissolve: an arc split by a point; point at it, click, one arc again.
function dissolve(t: number): PenTipFrame {
  const O = v(80, 84), r = 54
  const P0 = onCircle(O, r, 205), P1 = onCircle(O, r, 270), P2 = onCircle(O, r, 335)
  const at = v(P1.x + 1, P1.y + 2)
  const cursor = track(t, [[0.04, v(140, 88)], [0.34, at], [0.64, at], [0.84, v(112, 70)]])
  const pressed = within(t, 0.5, 0.56)
  const done = t >= 0.53
  const s = sk()
  if (done) s.path([P0, P2], [{ via: P1 }])
  else s.path([P0, P1, P2], [{ via: onCircle(O, r, 237) }, { via: onCircle(O, r, 303) }])
  return {
    doc: s.doc, cursor, pressed,
    tint: !done && t >= 0.32 ? sk().path([P0, P1, P2], [{ via: onCircle(O, r, 237) }, { via: onCircle(O, r, 303) }]).doc : undefined,
    dots: done ? [P0, P2] : [P0, P1, P2],
    hot: !done && t >= 0.32 ? [P1] : [],
    ...sparkleAt(t, 0.53, P1),
  }
}

// Fill: two crossing circles; point into the lens (it shows hatched), click,
// it fills; then point at the left crescent, which shows hatched in turn.
// The doc carries a real fill, so the card draws it the way the pen does.
function fill(t: number): PenTipFrame {
  const CA = v(62, 48), CB = v(98, 48), r = 26
  const lens = v(80, 48), crescent = v(47, 48)
  const cursor = track(t, [[0.04, v(140, 88)], [0.32, v(lens.x + 1, lens.y + 3)], [0.64, v(lens.x + 1, lens.y + 3)], [0.84, v(crescent.x + 1, crescent.y + 3)]])
  const filled = t >= 0.53
  const s = sk().circle(CA, r).circle(CB, r)
  if (filled) toggleFillAt(s.doc, lens, 0)
  return {
    doc: s.doc, cursor, pressed: within(t, 0.5, 0.56),
    hatchAt: t >= 0.3 && t < 0.5 ? lens : t >= 0.82 ? crescent : undefined,
    ...sparkleAt(t, 0.53, lens),
  }
}

// Round corner / Chamfer: an L; press on its corner and drag inward — the
// corner rounds (or is cut) further as the drag goes on.
function corner(kind: 'round' | 'chamfer') {
  return (t: number): PenTipFrame => {
    const A = v(40, 80), X = v(40, 24), B = v(128, 24)
    const at = v(X.x + 1, X.y + 2)
    const cursor = track(t, [[0.04, v(120, 80)], [0.3, at], [0.4, at], [0.7, v(62, 46)], [0.9, v(62, 46)]])
    const r = 30 * prog(t, 0.4, 0.7)
    const s = sk()
    if (r < 0.5) s.path([A, X, B], ['line', 'line'])
    else {
      const T1 = v(X.x, X.y + r), T2 = v(X.x + r, X.y)
      const mid = v(X.x + r * (1 - Math.SQRT1_2), X.y + r * (1 - Math.SQRT1_2))
      s.path([A, T1, T2, B], ['line', kind === 'round' ? { via: mid } : 'line', 'line'])
    }
    return {
      doc: s.doc, cursor, pressed: within(t, 0.4, 0.72),
      dots: r < 0.5 ? [A, X, B] : [A, B],
      hot: t >= 0.28 && t < 0.4 ? [X] : [],
      ...sparkleAt(t, 0.72, v(X.x + 9, X.y + 9)),
    }
  }
}
const round = corner('round'), chamfer = corner('chamfer')

// Clean up: a shape whose top doesn't quite close and whose base sits a
// little off level; press, and it tidies — the ends join, the base levels,
// the old drawing stays as a faint ghost.
function cleanup(t: number): PenTipFrame {
  const done = t >= 0.53
  const L = v(36, 70), R = v(124, 70), top = v(80, 22)
  const Lo = v(36, 64), gapL = v(75, 25), gapR = v(85, 24)
  const before = sk()
    .path([Lo, gapL], [{ via: v(46, 36) }])
    .path([gapR, R], [{ via: v(116, 36) }])
    .line(Lo, R)
  const after = sk()
    .path([L, top, R], [{ via: v(44, 36) }, { via: v(116, 36) }])
    .line(L, R)
  const at = v(80, 88)
  const cursor = track(t, [[0.04, v(140, 90)], [0.34, at], [0.64, at], [0.84, v(112, 82)]])
  return {
    doc: done ? after.doc : before.doc, cursor, pressed: within(t, 0.5, 0.56),
    ghost: done ? before.doc : undefined,
    dots: done ? [L, top, R] : [Lo, gapL, gapR, R],
    ...sparkleAt(t, 0.53, top),
  }
}

export const PEN_TIP_DEMOS: Record<string, (t: number) => PenTipFrame> = {
  select, path, curve, line, circle, point, trim, cut, dissolve, fill, round, chamfer, cleanup,
}
export const PEN_DEMO_TOOLS = Object.keys(PEN_TIP_DEMOS)
