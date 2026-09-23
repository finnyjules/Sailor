import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyMap, invertMap } from './axis'
import { inferAxisPin, V_NAME } from './infer'
import type { AxisMap, AxisPin, UnitInfo } from './types'

const EPS = 1e-6
/** How far (design px) a moved stretched edge stays inside its reference, so it never reads as touching it and gets welded (bled) to the real box edge. */
const EDGE_GAP = 0.01

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
  }
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
 *  A stretching pin maps each edge back; any other pin maps the centre back and keeps `designSize`. */
export function designExtentFor(ax: AxisInfo, pin: AxisPin, a: number, b: number, designSize: number): [number, number] {
  const kind: AxisPin = pin === 'both' && !ax.canStretch ? 'center' : pin
  const m: AxisMap = { ...ax.map, kind }
  if (kind === 'both') {
    const viewEnd = ax.refView.start + ax.refView.extent
    const near = Math.abs(a - ax.refView.start) < EPS ? ax.refDesign.start : invertMap(m, a, 'near')
    const far = Math.abs(b - viewEnd) < EPS ? ax.refDesign.start + ax.refDesign.extent : invertMap(m, b, 'far')
    return [near, far]
  }
  const c = invertMap(m, (a + b) / 2)
  return [c - designSize / 2, c + designSize / 2]
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
 * Either way the unit ends up drawn exactly at [a, b].
 */
export function settleAxis(ax: AxisInfo, a: number, b: number, designSize: number): Settled {
  const held = ax.map.kind
  if (ax.explicit) { const [near, far] = designExtentFor(ax, held, a, b, designSize); return { near, far, pin: null } }
  const viewPin = inferAxisPin(a, b - a, ax.refView.start, ax.refView.extent, ax.canStretch)
  for (const pin of viewPin === held ? [held] : [viewPin, held]) {
    const [near, far] = designExtentFor(ax, pin, a, b, designSize)
    if (inferAxisPin(near, far - near, ax.refDesign.start, ax.refDesign.extent, ax.canStretch) === pin) {
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

/**
 * Move a unit by (dx, dy) VIEW px from where it was drawn at drag start. `u` and `layers` are the
 * unit info and stored layers captured at drag start (x/y are the origins, so the delta is total,
 * never cumulative). 'drag' holds the pins; 'drop' runs the drop rule. A bleeding stretched axis
 * stays put (Ruling C).
 */
export function moveUnitAtView(u: UnitInfo, layers: LocalLayer[], W0: number, H0: number, dx: number, dy: number, phase: 'drag' | 'drop'): ViewEdit {
  const one = (axis: 'h' | 'v', d: number): Settled => {
    const ax = axisInfo(u, axis)
    const bl = bleeds(ax)
    if (bl.near || bl.far) return { near: ax.design.start, far: ax.design.start + ax.design.extent, pin: null }
    let a = ax.view.start + d, b = ax.view.start + ax.view.extent + d
    if (ax.map.kind === 'both') {
      // A stretched edge that reaches its reference would be drawn to the REAL box edge (bleed),
      // not where it was dropped: stop it EDGE_GAP design px inside, keeping the width.
      const lo = applyMap(ax.map, ax.refDesign.start + EDGE_GAP, 'near')
      const hi = applyMap(ax.map, ax.refDesign.start + ax.refDesign.extent - EDGE_GAP, 'far')
      if (a < lo) { b += lo - a; a = lo } else if (b > hi) { a += hi - b; b = hi }
    }
    return phase === 'drag' ? holdAxis(ax, a, b, ax.design.extent) : settleAxis(ax, a, b, ax.design.extent)
  }
  const sh = one('h', dx), sv = one('v', dy)
  const dcx = (sh.near + sh.far) / 2 - (u.designBox.x + u.designBox.w / 2)
  const dcy = (sv.near + sv.far) / 2 - (u.designBox.y + u.designBox.h / 2)
  const pins = pinsPatch(u, sh.pin, sv.pin)
  // Nothing moved (e.g. a welded background): no layer writes.
  if (Math.abs(dcx) < 1e-9 && Math.abs(dcy) < 1e-9) return { patches: [], pins }
  const byId = new Map(layers.map(l => [l.id, l]))
  const patches = u.memberIds.flatMap((id) => {
    const l = byId.get(id)
    return l ? [{ id, patch: { x: l.x + dcx / W0, y: l.y + dcy / H0 } as Record<string, unknown> }] : []
  })
  return { patches, pins }
}
