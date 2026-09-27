import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyMap, invertMap } from './axis'
import { inferAxisPin, V_NAME } from './infer'
import { layerCanStretch } from './units'
import type { AxisMap, AxisPin, HeldAt, ResolvedBox, UnitInfo } from './types'

const EPS = 1e-6
/** How far (design px) a moved stretched edge stays inside its reference, so it never reads as touching it and gets welded (bled) to the real box edge. */
const EDGE_GAP = 0.01
/** The smallest design extent (px) that an edit at a viewing size can leave. A stretched edge stops here instead of crossing over. */
const MIN_EXTENT = 1

export interface AxisSpan { start: number; extent: number }
/** One axis of a unit as the resolver placed it at the viewing size. Design px / view px. */
export interface AxisInfo {
  map: AxisMap              // map.kind is the HELD (effective) pin
  canStretch: boolean
  explicit: boolean         // the pin on this axis is stored
  design: AxisSpan          // the unit's design extent
  view: AxisSpan            // the span the pins place (UnitInfo.mappedBox), not the re-wrapped drawn box
  refDesign: AxisSpan       // the section or frame, design px
  refView: AxisSpan         // the same, view px
  onGrid: boolean           // the reference is a grid span (else the frame)
  /** How the pin is READ on this axis: the extent it is inferred from is the unit's own extent moved
   *  by `off` and grown by `dExt` (design px) — nonzero only for a text on rows, read from its
   *  capitals to its last baseline — and a 'both' may be inferred only when `inferStretch`. */
  infer: { off: number; dExt: number; stretch: boolean }
  k: number                 // view px per design px for the unit's size (UnitInfo.kSize)
}
/** What to do with the stored pin on one axis. null = leave it alone. */
export type PinWrite = { set: AxisPin } | { clear: true } | null
export interface Settled { near: number; far: number; pin: PinWrite }
export interface ViewEdit {
  patches: Array<{ id: string; patch: Record<string, unknown> }>
  pins: { unitId: string; onGroup: boolean; patch: Record<string, unknown> } | null
}

export function axisInfo(u: UnitInfo, axis: 'h' | 'v'): AxisInfo {
  const H = axis === 'h'
  const span = (b: { x: number; y: number; w: number; h: number }): AxisSpan =>
    H ? { start: b.x, extent: b.w } : { start: b.y, extent: b.h }
  return {
    map: H ? u.h : u.v, canStretch: u.canStretch, explicit: H ? u.hExplicit : u.vExplicit,
    design: span(u.designBox), view: span(u.mappedBox), refDesign: span(u.refDesign), refView: span(u.refView),
    onGrid: !!u.onGrid?.[axis],
    infer: inferOf(axis, u.designBox, u.vBox, u.canStretch, u.vCanStretch),
    k: u.kSize,
  }
}

function inferOf(axis: 'h' | 'v', box: ResolvedBox, vBox: { y: number; h: number } | undefined, canStretch: boolean, vCanStretch: boolean | undefined): AxisInfo['infer'] {
  if (axis === 'h' || !vBox) return { off: 0, dExt: 0, stretch: canStretch }
  return { off: vBox.y - box.y, dExt: vBox.h - box.h, stretch: canStretch && vCanStretch !== false }
}

/** The pin the resolver infers for a unit whose extent on this axis is [start, start+extent] inside
 *  [refStart, refStart+refExtent]. `k` scales the read offsets: 1 in design px, ax.k in view px. */
function inferOn(ax: AxisInfo, start: number, extent: number, refStart: number, refExtent: number, k: number): AxisPin {
  return inferAxisPin(start + ax.infer.off * k, extent + ax.infer.dExt * k, refStart, refExtent, ax.infer.stretch)
}

/** The edges that stay welded (drawn at the reference's real edge) while the unit is edited. Only
 *  an axis held to the FRAME welds; a grid-held axis moves by the inverse map and re-holds on drop. */
function welds(ax: AxisInfo): { near: boolean; far: boolean } {
  return ax.onGrid ? { near: false, far: false } : bleeds(ax)
}

/** A stretched axis touching the reference edge is drawn to the REAL box edge (bleed). No design
 *  position maps there by the straight line, so a bleeding edge cannot follow the pointer. */
export function bleeds(ax: AxisInfo): { near: boolean; far: boolean } {
  if (ax.map.kind !== 'both') return { near: false, far: false }
  return {
    near: ax.design.start <= ax.refDesign.start + EPS,
    far: ax.design.start + ax.design.extent >= ax.refDesign.start + ax.refDesign.extent - EPS,
  }
}

/** The design extent [near, far] that draws at view extent [a, b] under `pin`.
 *  A stretching pin maps each edge back; any other pin maps the centre back and keeps `designSize`.
 *  Never returns an extent below MIN_EXTENT. A stretching pin's edges are also bounded:
 *  - A welded (bleeding) edge keeps its design position.
 *  - Every other edge stops EDGE_GAP inside the reference. An edge that reached the reference would
 *    be drawn at the REAL box edge (bleed), so bleeding cannot be made by dragging at a view.
 *  - When the extent would drop below the floor, the edge that moved further stops. The floor is
 *    MIN_EXTENT, or the unit's own extent if that is already smaller, so a move never grows a
 *    sub-1 px hairline. */
export function designExtentFor(ax: AxisInfo, pin: AxisPin, a: number, b: number, designSize: number): [number, number] {
  const kind: AxisPin = pin === 'both' && !ax.canStretch ? 'center' : pin
  const m: AxisMap = { ...ax.map, kind }
  if (kind === 'both') {
    const weld = welds(ax)
    const dNear = ax.design.start, dFar = ax.design.start + ax.design.extent
    // A grid-held edge may leave its span (the unit re-holds on drop); only the frame's edges stop it.
    const lo = ax.onGrid ? -Infinity : ax.refDesign.start + EDGE_GAP
    const hi = ax.onGrid ? Infinity : ax.refDesign.start + ax.refDesign.extent - EDGE_GAP
    let near = weld.near ? dNear : Math.max(lo, invertMap(m, a, 'near'))
    let far = weld.far ? dFar : Math.min(hi, invertMap(m, b, 'far'))
    const floor = minExtentFor(ax)
    if (far - near < floor - 1e-9) {
      const farMoves = weld.near || (!weld.far && Math.abs(far - dFar) >= Math.abs(near - dNear))
      if (farMoves) far = near + floor
      else near = far - floor
    }
    return [near, far]
  }
  const size = Math.max(designSize, minExtentFor(ax))
  const c = invertMap(m, (a + b) / 2)
  return [c - size / 2, c + size / 2]
}

/** The smallest extent an edit may leave on this axis: MIN_EXTENT, or the unit's own design extent
 *  when that is already smaller (never grow what the user drew). */
function minExtentFor(ax: AxisInfo): number {
  return Math.max(0, Math.min(MIN_EXTENT, ax.design.extent))
}

/** Whether a stretching design extent draws at [a, b], i.e. no clamp moved it. Compared in design
 *  px against half the edge gap, so view/canvas round-off on the caller's box never counts as a clamp. */
function drawsAt(ax: AxisInfo, near: number, far: number, a: number, b: number): boolean {
  const m: AxisMap = { ...ax.map, kind: 'both' }
  return Math.abs(near - invertMap(m, a, 'near')) < EDGE_GAP / 2 && Math.abs(far - invertMap(m, b, 'far')) < EDGE_GAP / 2
}

/** Where a HELD stretch pin actually draws [a, b] once its clamps apply (edge gap, 1 px stop). A
 *  welded edge stays where it is drawn (the real box edge). Any other held pin draws at [a, b]. */
function heldDrawnSpan(ax: AxisInfo, a: number, b: number, designSize: number): [number, number] {
  if (ax.map.kind !== 'both') return [a, b]
  const weld = welds(ax)
  const [near, far] = designExtentFor(ax, 'both', a, b, designSize)
  return [weld.near ? a : applyMap(ax.map, near, 'near'), weld.far ? b : applyMap(ax.map, far, 'far')]
}

/** During a drag: map back with the held pin and hold it (write it on an automatic axis). */
export function holdAxis(ax: AxisInfo, a: number, b: number, designSize: number): Settled {
  const [near, far] = designExtentFor(ax, ax.map.kind, a, b, designSize)
  return { near, far, pin: ax.explicit ? null : { set: ax.map.kind } }
}

/**
 * The drop rule on one axis (spec: "Editing at a viewing size"). [a, b] is where the unit is drawn
 * after the edit (view px). An explicit pin maps straight back. An automatic axis tries the pin read
 * from where it now sits in the VIEW, then the pin it had; the first whose mapped-back design
 * position reads as that same pin keeps it automatic. If neither does, the held pin is stored.
 * Either way the unit ends up drawn where the last drag frame (holdAxis) drew it: [a, b], or for a
 * held stretch, [a, b] after its edge stops.
 */
export function settleAxis(ax: AxisInfo, a0: number, b0: number, designSize0: number): Settled {
  const held = ax.map.kind
  if (ax.explicit) { const [near, far] = designExtentFor(ax, held, a0, b0, designSize0); return { near, far, pin: null } }
  // Judge the drop from where the last drag frame drew it: a held stretch stops its edges (edge
  // gap, 1 px), so run the rule on that stopped box, not the pointer's. A no-op for other pins.
  const [a, b] = heldDrawnSpan(ax, a0, b0, designSize0)
  const designSize = (a === a0 && b === b0) ? designSize0 : designSize0 + (b - a - (b0 - a0)) / ax.map.s
  const viewPin = inferOn(ax, a, b - a, ax.refView.start, ax.refView.extent, ax.k)
  for (const pin of viewPin === held ? [held] : [viewPin, held]) {
    const [near, far] = designExtentFor(ax, pin, a, b, designSize)
    // A stretching candidate that is not the held pin must draw where it was dropped. If its edges
    // were stopped inside the reference it would jump on release, so reject it. [a, b] is already
    // the held pin's stopped box, so every accepted candidate draws where the last drag frame did.
    if (pin !== held && pin === 'both' && ax.canStretch && !drawsAt(ax, near, far, a, b)) continue
    if (inferOn(ax, near, far - near, ax.refDesign.start, ax.refDesign.extent, 1) === pin) {
      return { near, far, pin: { clear: true } }
    }
  }
  const [near, far] = designExtentFor(ax, held, a, b, designSize)
  return { near, far, pin: { set: held } }
}

/** Pins to merge onto the unit: `set` writes the pin (vertical spelled top/bottom/middle), `clear`
 *  writes `undefined` (back to automatic). null when there is nothing to write. */
export function pinsPatch(u: UnitInfo, h: PinWrite, v: PinWrite): ViewEdit['pins'] {
  const patch: Record<string, unknown> = {}
  if (h) patch.h = 'set' in h ? h.set : undefined
  if (v) patch.v = 'set' in v ? V_NAME[v.set] : undefined
  return Object.keys(patch).length ? { unitId: u.unitId, onGroup: u.kind === 'group', patch } : null
}

/** One axis of an edit at a viewing size: the unit's axis at drag start, the view span it is drawn
 *  to [a, b], its design size, and how it settled. A `fixed` axis (welded) is never re-held. */
interface AxisEdit { ax: AxisInfo; a: number; b: number; size: number; s: Settled; fixed: boolean }

const sameSpan = (p: AxisSpan, q: AxisSpan) => Math.abs(p.start - q.start) < 1e-6 && Math.abs(p.extent - q.extent) < 1e-6

/** The settled design box of a two-axis edit. */
const boxOf = (h: Settled, v: Settled): ResolvedBox => ({ x: h.near, y: v.near, w: h.far - h.near, h: v.far - v.near })
const spanOn = (b: ResolvedBox, axis: 'h' | 'v'): AxisSpan => axis === 'h' ? { start: b.x, extent: b.w } : { start: b.y, extent: b.h }

/** The pin that will apply on an axis after this settle: stored before the edit (pin null on a
 *  non-welded axis), or written by it; null = automatic (the pin inferred where it lands). */
function storedAfter(ax: AxisInfo, st: Settled): AxisPin | null {
  return st.pin == null ? ax.map.kind : ('set' in st.pin ? st.pin.set : null)
}

/** Where the resolver draws one settled axis (view px), given what the unit holds to there. */
function drawnSpan(held: HeldAt, axis: 'h' | 'v', kind: AxisPin, st: Settled, k: number): [number, number] {
  const m = held.map(axis, kind), ref = spanOn(held.refDesign, axis), view = spanOn(held.refView, axis)
  if (m.kind === 'both') {
    const near = st.near <= ref.start + 1e-6 ? view.start : applyMap(m, st.near, 'near')
    const far = st.far >= ref.start + ref.extent - 1e-6 ? view.start + view.extent : applyMap(m, st.far, 'far')
    return [near, far]
  }
  const c = applyMap(m, (st.near + st.far) / 2), half = ((st.far - st.near) * k) / 2
  return [c - half, c + half]
}

type Pair = { h: Settled; v: Settled }

/**
 * Re-hold after settling (I1). Each axis was settled against the reference it held to at drag
 * start, but the next resolve reads what the unit holds to from the NEW design box: moving onto or
 * off a column/row span changes the reference, and the unit would be drawn elsewhere. So when the
 * settled box holds to something else, the axis is settled again against each reference it could
 * hold to — what it held to, what the settled box reads, every grid span holding the drop in the
 * view (also with the drop moved just inside that span), the frame, then (up to 3 rounds) whatever
 * those tries read in turn — and the try the resolver really draws nearest the drop is kept (ties:
 * the one inside what it holds to, then an automatic pin, then the earlier try). A pin the user
 * stored is never changed; an automatic axis runs the drop rule, or stores a pin. Some view spots no
 * design position reaches (between two view rows, or where a span's tolerance captures the box):
 * there the nearest reachable one is taken. Axes are independent (a unit's columns never depend on
 * its rows), so each is re-held with the other at its first settle. `keepSize`: a move writes the
 * position only, so tries that change the extent are skipped.
 */
function rehold(u: UnitInfo, e: { h: AxisEdit; v: AxisEdit }, lonePatchOf: (sh: Settled, sv: Settled) => Record<string, unknown> | undefined, phase: 'drag' | 'drop', keepSize: boolean): Pair {
  const first: Pair = { h: e.h.s, v: e.v.s }
  const holdAt = u.holdAt
  if (!holdAt) return first
  const pair = (axis: 'h' | 'v', st: Settled): Pair => axis === 'h' ? { h: st, v: first.v } : { h: first.h, v: st }
  const heldFor = (p: Pair) => holdAt(boxOf(p.h, p.v), lonePatchOf(p.h, p.v))
  const one = (axis: 'h' | 'v'): Settled => {
    const ed = e[axis]
    if (ed.fixed) return ed.s
    const held0 = heldFor(first)
    if (sameSpan(spanOn(held0.refDesign, axis), ed.ax.refDesign) && sameSpan(spanOn(held0.refView, axis), ed.ax.refView)) return ed.s
    // Where the resolver draws a try (how far from the drop), and how far its design extent pokes
    // out of what it then holds to (a try right on the edge of the span's tolerance is fragile).
    const score = (st: Settled): { err: number; slack: number } => {
      const held = heldFor(pair(axis, st))
      const kind = storedAfter(ed.ax, st) ?? held.inferred[axis]
      const [n, f] = drawnSpan(held, axis, kind, st, u.kSize)
      const ref = spanOn(held.refDesign, axis)
      return {
        err: Math.max(Math.abs(n - ed.a), Math.abs(f - ed.b)),
        slack: Math.max(0, ref.start - st.near) + Math.max(0, st.far - ref.start - ref.extent),
      }
    }
    const box0 = boxOf(first.h, first.v)
    type Ref = { refDesign: AxisSpan; refView: AxisSpan; onGrid: boolean; map: (k: AxisPin) => AxisMap }
    const fromHeld = (h: HeldAt): Ref => ({ refDesign: spanOn(h.refDesign, axis), refView: spanOn(h.refView, axis), onGrid: h.onGrid[axis], map: k => h.map(axis, k) })
    const tried: Ref[] = []
    const isNew = (r: Ref) => !tried.some(t => sameSpan(t.refDesign, r.refDesign) && sameSpan(t.refView, r.refView))
    const cands: Settled[] = [ed.s]
    const held = ed.ax.map.kind
    const tryRef = (r: Ref) => {
      tried.push(r)
      const base: AxisInfo = { ...ed.ax, refDesign: r.refDesign, refView: r.refView, onGrid: r.onGrid, design: spanOn(box0, axis) }
      // On a grid span, also try the drop moved just inside the span (snapped onto its columns/rows).
      const targets: Array<[number, number]> = [[ed.a, ed.b]]
      if (r.onGrid) {
        const lo = r.refView.start, hi = lo + r.refView.extent
        const shift = ed.b - ed.a >= hi - lo ? lo - ed.a : ed.a < lo ? lo - ed.a : ed.b > hi ? hi - ed.b : 0
        if (shift) targets.push([ed.a + shift, ed.b + shift])
      }
      for (const [a, b] of targets) {
        const mapped = (kind: AxisPin, pin: PinWrite): Settled => {
          const ax2: AxisInfo = { ...base, map: r.map(kind), explicit: true }
          const s2 = phase === 'drag' ? holdAxis(ax2, a, b, ed.size) : settleAxis(ax2, a, b, ed.size)
          return { ...s2, pin }
        }
        if (ed.ax.explicit) { cands.push(mapped(held, null)); continue }
        cands.push(settleAxis({ ...base, map: r.map(held), explicit: false }, a, b, ed.size))
        cands.push(mapped(held, { set: held }))
        const viewPin = inferOn(base, a, b - a, r.refView.start, r.refView.extent, ed.ax.k)
        if (viewPin !== held) cands.push(mapped(viewPin, { set: viewPin }))
      }
    }
    // What it held to, what the settled box reads, the spans the drop sits on in the view, the frame…
    const start: Ref = { refDesign: ed.ax.refDesign, refView: ed.ax.refView, onGrid: ed.ax.onGrid, map: k => ({ ...ed.ax.map, kind: k === 'both' && !ed.ax.canStretch ? 'center' : k }) }
    for (const r of [start, fromHeld(held0), ...(u.refsAtView?.(axis, ed.a, ed.b) ?? []).map((c): Ref => ({ refDesign: { start: c.dStart, extent: c.dExtent }, refView: { start: c.bStart, extent: c.bExtent }, onGrid: c.onGrid, map: c.map }))]) {
      if (isNew(r)) tryRef(r)
    }
    // …then whatever those tries read, settling once more against each new reference (3 rounds).
    for (let round = 0, from = 0; round < 3; round++) {
      const to = cands.length
      for (const c of cands.slice(from, to)) { const r = fromHeld(heldFor(pair(axis, c))); if (isNew(r)) tryRef(r) }
      if (cands.length === to) break
      from = to
    }
    // Nearest the drop (to half a px) wins; then the one sitting inside what it holds to; then an
    // automatic pin over a stored one; then the earlier try.
    let best = ed.s, key: [number, number, number] = [Infinity, Infinity, 1]
    for (const c of cands) {
      // A move writes the position only: a try that changes the extent cannot be written.
      if (keepSize && Math.abs((c.far - c.near) - (ed.s.far - ed.s.near)) > 1e-6) continue
      const { err, slack } = score(c)
      const k: [number, number, number] = [err, slack, c.pin && 'set' in c.pin ? 1 : 0]
      const better = k[0] < key[0] - 0.5 || (k[0] <= key[0] + 0.5 && (k[1] < key[1] - 1e-6 || (Math.abs(k[1] - key[1]) <= 1e-6 && k[2] < key[2])))
      if (better) { best = c; key = k }
    }
    // A drag frame holds its pin: an automatic try is written as the pin it reads where it lands.
    if (phase === 'drag' && best.pin && 'clear' in best.pin) best = { ...best, pin: { set: heldFor(pair(axis, best)).inferred[axis] } }
    return best
  }
  return { h: one('h'), v: one('v') }
}

/**
 * Move a unit by (dx, dy) VIEW px from where it was drawn at drag start. `u` and `layers` are the
 * unit info and stored layers captured at drag start (x/y are the origins, so the delta is total,
 * never cumulative). 'drag' holds the pins; 'drop' runs the drop rule. A bleeding stretched axis
 * held to the frame stays put (Ruling C); a grid-held axis moves and re-holds (see rehold).
 */
export function moveUnitAtView(u: UnitInfo, layers: LocalLayer[], W0: number, H0: number, dx: number, dy: number, phase: 'drag' | 'drop'): ViewEdit {
  let welded = 0
  const one = (axis: 'h' | 'v', d: number): AxisEdit => {
    const ax = axisInfo(u, axis)
    const bl = welds(ax)
    if (bl.near || bl.far) {
      welded++
      const near = ax.design.start, far = ax.design.start + ax.design.extent
      return { ax, a: ax.view.start, b: ax.view.start + ax.view.extent, size: ax.design.extent, s: { near, far, pin: null }, fixed: true }
    }
    let a = ax.view.start + d, b = ax.view.start + ax.view.extent + d
    if (ax.map.kind === 'both' && !ax.onGrid) {
      // A stretched edge that reaches its (frame) reference would be drawn to the REAL box edge
      // (bleed), not where it was dropped: stop it EDGE_GAP design px inside, keeping the width.
      const lo = applyMap(ax.map, ax.refDesign.start + EDGE_GAP, 'near')
      const hi = applyMap(ax.map, ax.refDesign.start + ax.refDesign.extent - EDGE_GAP, 'far')
      if (a < lo) { b += lo - a; a = lo } else if (b > hi) { a += hi - b; b = hi }
    }
    const s = phase === 'drag' ? holdAxis(ax, a, b, ax.design.extent) : settleAxis(ax, a, b, ax.design.extent)
    return { ax, a, b, size: ax.design.extent, s, fixed: false }
  }
  const eh = one('h', dx), ev = one('v', dy)
  const byId = new Map(layers.map(l => [l.id, l]))
  const delta = (sh: Settled, sv: Settled) => ({
    dcx: (sh.near + sh.far) / 2 - (u.designBox.x + u.designBox.w / 2),
    dcy: (sv.near + sv.far) / 2 - (u.designBox.y + u.designBox.h / 2),
  })
  const lone = u.kind === 'layer' ? byId.get(u.memberIds[0]!) : undefined
  const { h: sh, v: sv } = welded === 2 ? { h: eh.s, v: ev.s } : rehold(u, { h: eh, v: ev }, (h, v) => {
    if (!lone) return undefined
    const { dcx, dcy } = delta(h, v)
    return { x: lone.x + dcx / W0, y: lone.y + dcy / H0 }
  }, phase, true)
  const { dcx, dcy } = delta(sh, sv)
  const pins = pinsPatch(u, sh.pin, sv.pin)
  // Both axes welded (e.g. a full-bleed background): it cannot move, so no layer writes. Any other
  // unit ALWAYS gets its origin-based position — the editor writes only returned patches, so a
  // return to the start pixel must write the origin back.
  if (welded === 2) return { patches: [], pins }
  const patches = u.memberIds.flatMap((id) => {
    const l = byId.get(id)
    return l ? [{ id, patch: { x: l.x + dcx / W0, y: l.y + dcy / H0 } as Record<string, unknown> }] : []
  })
  return { patches, pins }
}

/** The pins after an edit that keeps the centre where it is (scale, rotate): hold them while
 *  dragging; on drop an automatic axis stays automatic if the new design box still reads as the
 *  held pin, otherwise the held pin is stored so nothing moves. The held pin is compared as it
 *  takes EFFECT: a layer that cannot stretch (rotated) draws a held "both" centred, so an automatic
 *  stretched layer that is rotated and reads as centred stays automatic. */
function holdPins(u: UnitInfo, nb: ResolvedBox, canStretch: boolean, phase: 'drag' | 'drop'): ViewEdit['pins'] {
  const one = (axis: 'h' | 'v'): PinWrite => {
    const ax = axisInfo(u, axis)
    if (ax.explicit) return null
    if (phase === 'drag') return { set: ax.map.kind }
    const start = axis === 'h' ? nb.x : nb.y, extent = axis === 'h' ? nb.w : nb.h
    const effective: AxisPin = ax.map.kind === 'both' && !canStretch ? 'center' : ax.map.kind
    // Read as the resolver reads it: a text on rows from its capitals and baselines, never stretched down.
    const read = { ...ax, infer: inferOf(axis, u.designBox, u.vBox, canStretch, u.vCanStretch) }
    return inferOn(read, start, extent, ax.refDesign.start, ax.refDesign.extent, 1) === effective
      ? { clear: true } : { set: ax.map.kind }
  }
  return pinsPatch(u, one('h'), one('v'))
}

/**
 * Resize a single-layer unit to the drawn `box` (view px). Both edges map back, so the stored size
 * changes; a bleeding side stays welded, and a stretched free edge stops EDGE_GAP inside the
 * reference and never closer than MIN_EXTENT to the other edge (see designExtentFor).
 *
 * Each axis settles from the PLACED span (UnitInfo.mappedBox), not the drawn one: they differ for a
 * re-wrapped text, whose drawn height follows the view's wrap. If the gesture left the drawn
 * extent unchanged, the placed span, shifted by how far the drawn box moved, is settled, so the
 * design position and size stay as they were. If the extent changed, the new box is settled as
 * drawn: the height field is then written, and a text with its own box height draws its placed span.
 * The height field (`fields.h`) is written only when the vertical extent changed, or when the layer
 * already has one.
 */
export function resizeLayerAtView(u: UnitInfo, layer: LocalLayer, box: ResolvedBox, W0: number, H0: number, phase: 'drag' | 'drop', fields: { w: string; h: string | null }): ViewEdit {
  const one = (axis: 'h' | 'v', a0: number, b0: number): AxisEdit & { changed: boolean } => {
    const ax = axisInfo(u, axis)
    const drawnStart = axis === 'h' ? u.viewBox.x : u.viewBox.y
    const drawnExtent = axis === 'h' ? u.viewBox.w : u.viewBox.h
    const changed = Math.abs((b0 - a0) - drawnExtent) > EPS
    let a = changed ? a0 : a0 + (ax.view.start - drawnStart)
    let b = changed ? b0 : a + ax.view.extent
    const bl = welds(ax)
    if (bl.near) a = ax.view.start
    if (bl.far) b = ax.view.start + ax.view.extent
    const size = (b - a) / u.kSize
    const s = phase === 'drag' ? holdAxis(ax, a, b, size) : settleAxis(ax, a, b, size)
    return { ax, a, b, size, s, fixed: false, changed }
  }
  const eh = one('h', box.x, box.x + box.w)
  const ev = one('v', box.y, box.y + box.h)
  const hasH = fields.h != null && Number((layer as unknown as Record<string, unknown>)[fields.h]) > 0
  const patchOf = (sh: Settled, sv: Settled): Record<string, unknown> => {
    const patch: Record<string, unknown> = { x: (sh.near + sh.far) / 2 / W0, y: (sv.near + sv.far) / 2 / H0 }
    patch[fields.w] = (sh.far - sh.near) / W0
    if (fields.h && (ev.changed || hasH)) patch[fields.h] = (sv.far - sv.near) / W0
    return patch
  }
  const { h: sh, v: sv } = rehold(u, { h: eh, v: ev }, patchOf, phase, false)
  return { patches: [{ id: layer.id, patch: patchOf(sh, sv) }], pins: pinsPatch(u, sh.pin, sv.pin) }
}

/**
 * Scale uniformly about the design centre: each `start` field is multiplied by the ratio and
 * clamped to 0.002..4. On a stretched axis the free edges stop EDGE_GAP inside the reference, the
 * same way moves and resizes stop. A growing ratio is capped to keep that gap, so the scale stays
 * uniform and the centre stays put.
 */
export function scaleLayerAtView(u: UnitInfo, layer: LocalLayer, start: Record<string, number>, ratio: number, phase: 'drag' | 'drop'): ViewEdit {
  let r = ratio
  if (ratio > 1) {
    for (const axis of ['h', 'v'] as const) {
      const ax = axisInfo(u, axis)
      if (ax.map.kind !== 'both' || ax.design.extent <= 0) continue
      const bl = bleeds(ax)
      const half = ax.design.extent / 2, c = ax.design.start + half
      const refEnd = ax.refDesign.start + ax.refDesign.extent
      if (!bl.near) r = Math.min(r, Math.max(1, (c - ax.refDesign.start - EDGE_GAP) / half))
      if (!bl.far) r = Math.min(r, Math.max(1, (refEnd - EDGE_GAP - c) / half))
    }
  }
  const patch: Record<string, unknown> = {}
  for (const k of Object.keys(start)) patch[k] = Math.min(4, Math.max(0.002, start[k]! * r))
  const b = u.designBox
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const nb = { x: cx - (b.w * r) / 2, y: cy - (b.h * r) / 2, w: b.w * r, h: b.h * r }
  return { patches: [{ id: layer.id, patch }], pins: holdPins(u, nb, u.canStretch, phase) }
}

export function rotateLayerAtView(u: UnitInfo, layer: LocalLayer, rotation: number, designLocal: { w: number; h: number }, phase: 'drag' | 'drop'): ViewEdit {
  const b = u.designBox
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const r = (rotation * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r))
  const w = designLocal.w * c + designLocal.h * s, h = designLocal.w * s + designLocal.h * c
  const nb = { x: cx - w / 2, y: cy - h / 2, w, h }
  // Judge stretch from the NEW rotation. `u.canStretch` already includes the start rotation, so a
  // layer rotated back to 0° would wrongly read as unable to stretch. keepSize is read exactly as
  // the resolver reads it: off the unit's pins, which for a single layer are the layer's own.
  const canStretch = u.kind === 'layer' && layerCanStretch({ ...layer, rotation }) && !layer.pins?.keepSize
  return { patches: [{ id: layer.id, patch: { rotation } }], pins: holdPins(u, nb, canStretch, phase) }
}

export function hitTestView(boxes: Map<string, ResolvedBox>, idsTopFirst: string[], x: number, y: number, pad: number): string | null {
  for (const id of idsTopFirst) {
    const b = boxes.get(id)
    if (b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return id
  }
  return null
}

export function viewSelectionGeometry(u: UnitInfo, rotation: number, designLocal: { w: number; h: number }, viewScale: number): { cx: number; cy: number; hw: number; hh: number; rot: number } {
  const vb = u.viewBox
  const single = u.kind === 'layer'
  // An unrotated layer's drawn box IS its box (stretch and text re-wrap included); a rotated one
  // cannot stretch, so its own size × the fit scale is exact.
  const useDrawn = !single || Math.abs(rotation) < EPS
  const w = useDrawn ? vb.w : designLocal.w * u.kSize
  const h = useDrawn ? vb.h : designLocal.h * u.kSize
  return { cx: (vb.x + vb.w / 2) * viewScale, cy: (vb.y + vb.h / 2) * viewScale, hw: (w / 2) * viewScale, hh: (h / 2) * viewScale, rot: single ? rotation : 0 }
}
