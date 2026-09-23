import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyMap, invertMap } from './axis'
import { inferAxisPin, V_NAME } from './infer'
import { layerCanStretch } from './units'
import type { AxisMap, AxisPin, ResolvedBox, UnitInfo } from './types'

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
 *  A stretching pin maps each edge back; any other pin maps the centre back and keeps `designSize`.
 *  Never returns an extent below MIN_EXTENT. A stretching pin's edges are also bounded:
 *  - A welded (bleeding) edge keeps its design position.
 *  - Every other edge stops EDGE_GAP inside the reference. An edge that reached the reference would
 *    be drawn at the REAL box edge (bleed), so bleeding cannot be made by dragging at a view.
 *  - When the extent would drop below MIN_EXTENT, the edge that moved further stops. */
export function designExtentFor(ax: AxisInfo, pin: AxisPin, a: number, b: number, designSize: number): [number, number] {
  const kind: AxisPin = pin === 'both' && !ax.canStretch ? 'center' : pin
  const m: AxisMap = { ...ax.map, kind }
  if (kind === 'both') {
    const weld = bleeds(ax)
    const dNear = ax.design.start, dFar = ax.design.start + ax.design.extent
    const lo = ax.refDesign.start + EDGE_GAP, hi = ax.refDesign.start + ax.refDesign.extent - EDGE_GAP
    let near = weld.near ? dNear : Math.max(lo, invertMap(m, a, 'near'))
    let far = weld.far ? dFar : Math.min(hi, invertMap(m, b, 'far'))
    if (far - near < MIN_EXTENT) {
      const farMoves = weld.near || (!weld.far && Math.abs(far - dFar) >= Math.abs(near - dNear))
      if (farMoves) far = near + MIN_EXTENT
      else near = far - MIN_EXTENT
    }
    return [near, far]
  }
  const size = Math.max(designSize, MIN_EXTENT)
  const c = invertMap(m, (a + b) / 2)
  return [c - size / 2, c + size / 2]
}

/** Whether a stretching design extent draws exactly at [a, b]. Used to reject a clamped candidate. */
function drawsAt(ax: AxisInfo, near: number, far: number, a: number, b: number): boolean {
  const m: AxisMap = { ...ax.map, kind: 'both' }
  return Math.abs(applyMap(m, near, 'near') - a) < EPS && Math.abs(applyMap(m, far, 'far') - b) < EPS
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
    // A stretching candidate that is not the held pin must draw where it was dropped. If its edges
    // were stopped inside the reference it would jump on release, so reject it. The held pin was
    // already stopped the same way while dragging, so it draws where the drag left it.
    if (pin !== held && pin === 'both' && ax.canStretch && !drawsAt(ax, near, far, a, b)) continue
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
  let welded = 0
  const one = (axis: 'h' | 'v', d: number): Settled => {
    const ax = axisInfo(u, axis)
    const bl = bleeds(ax)
    if (bl.near || bl.far) { welded++; return { near: ax.design.start, far: ax.design.start + ax.design.extent, pin: null } }
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
  // Both axes welded (e.g. a full-bleed background): it cannot move, so no layer writes. Any other
  // unit ALWAYS gets its origin-based position — the editor writes only returned patches, so a
  // return to the start pixel must write the origin back.
  if (welded === 2) return { patches: [], pins }
  const byId = new Map(layers.map(l => [l.id, l]))
  const patches = u.memberIds.flatMap((id) => {
    const l = byId.get(id)
    return l ? [{ id, patch: { x: l.x + dcx / W0, y: l.y + dcy / H0 } as Record<string, unknown> }] : []
  })
  return { patches, pins }
}

/** The pins after an edit that keeps the centre where it is (scale, rotate): hold them while
 *  dragging; on drop an automatic axis stays automatic if the new design box still reads as the
 *  held pin, otherwise the held pin is stored so nothing moves. */
function holdPins(u: UnitInfo, nb: ResolvedBox, canStretch: boolean, phase: 'drag' | 'drop'): ViewEdit['pins'] {
  const one = (axis: 'h' | 'v'): PinWrite => {
    const ax = axisInfo(u, axis)
    if (ax.explicit) return null
    if (phase === 'drag') return { set: ax.map.kind }
    const start = axis === 'h' ? nb.x : nb.y, extent = axis === 'h' ? nb.w : nb.h
    return inferAxisPin(start, extent, ax.refDesign.start, ax.refDesign.extent, canStretch) === ax.map.kind
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
  const one = (axis: 'h' | 'v', a0: number, b0: number): Settled & { changed: boolean } => {
    const ax = axisInfo(u, axis)
    const drawnStart = axis === 'h' ? u.viewBox.x : u.viewBox.y
    const drawnExtent = axis === 'h' ? u.viewBox.w : u.viewBox.h
    const changed = Math.abs((b0 - a0) - drawnExtent) > EPS
    let a = changed ? a0 : a0 + (ax.view.start - drawnStart)
    let b = changed ? b0 : a + ax.view.extent
    const bl = bleeds(ax)
    if (bl.near) a = ax.view.start
    if (bl.far) b = ax.view.start + ax.view.extent
    const size = (b - a) / u.kSize
    return { ...(phase === 'drag' ? holdAxis(ax, a, b, size) : settleAxis(ax, a, b, size)), changed }
  }
  const sh = one('h', box.x, box.x + box.w)
  const sv = one('v', box.y, box.y + box.h)
  const patch: Record<string, unknown> = { x: (sh.near + sh.far) / 2 / W0, y: (sv.near + sv.far) / 2 / H0 }
  patch[fields.w] = (sh.far - sh.near) / W0
  const hasH = fields.h != null && Number((layer as unknown as Record<string, unknown>)[fields.h]) > 0
  if (fields.h && (sv.changed || hasH)) patch[fields.h] = (sv.far - sv.near) / W0
  return { patches: [{ id: layer.id, patch }], pins: pinsPatch(u, sh.pin, sv.pin) }
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
