import { localLayerBox, layerMaskRef, cornerPinActive, type LocalLayer } from '~/composables/useCompositorLayers'
import { expandClones } from '~/composables/useCloner'
import { topGroupOf, layersInGroup, type LayerGroup } from '~/lib/compositor/layerGroups'
import type { Pins } from './types'

export interface Box { x: number; y: number; w: number; h: number }

export interface Unit {
  id: string
  kind: 'layer' | 'group' | 'maskPair' | 'cloner'
  memberIds: string[]
  /** Outer box at the design size, px, top-left. */
  box: Box
  /** The stored pins that apply to the whole unit (group's, mask source's, or the layer's). */
  pins: Pins | undefined
  /** Whether a 'both' pin may really change this unit's box (vs. placing it). */
  canStretch: boolean
}

const STRETCH_KINDS = new Set(['rect', 'ellipse', 'polygon', 'star', 'line', 'image', 'wired'])

/** Can this single layer's box be stretched by a 'both' pin? */
export function layerCanStretch(l: LocalLayer): boolean {
  if (l.rotation || l.skewX || l.skewY || cornerPinActive(l.cornerPin)) return false
  if (l.cloner?.enabled) return false
  if (l.kind === 'text') return (l.boxW ?? 0) > 0 && !l.path
  return STRETCH_KINDS.has(l.kind)
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Axis-aligned outer box of a w×h box rotated by `deg` about its centre. */
function rotatedExtent(w: number, h: number, deg: number): { w: number; h: number } {
  if (!deg) return { w, h }
  const a = (deg * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  return { w: w * c + h * s, h: w * s + h * c }
}

/**
 * A layer's outer box at the design size in px, top-left: the un-rotated box from
 * `localLayerBox`, rotated, then unioned across every cloner stamp.
 */
export function layerDesignBox(layer: LocalLayer, ctx: CanvasRenderingContext2D | null, W0: number, H0: number): Box {
  const base = localLayerBox(ctx, layer, W0, H0)
  let out: Box | null = null
  for (const c of expandClones(layer.cloner, W0 / H0)) {
    const cx = (layer.x + c.dx) * W0, cy = (layer.y + c.dy) * H0
    const e = rotatedExtent(base.w * c.dscale, base.h * c.dscale, (layer.rotation || 0) + c.drot)
    const b = { x: cx - e.w / 2, y: cy - e.h / 2, w: e.w, h: e.h }
    out = out ? unionBox(out, b) : b
  }
  return out!   // never null: expandClones yields the identity clone even with no cloner
}

/**
 * Partition the layers into rigid units. Order of precedence: outermost group,
 * then shape-mask pair, then cloner, then a plain layer. Every layer lands in
 * exactly one unit.
 */
export function buildUnits(layers: LocalLayer[], groups: LayerGroup[], ctx: CanvasRenderingContext2D | null, W0: number, H0: number): Unit[] {
  const byId = new Map(layers.map(l => [l.id, l]))
  const boxOf = new Map<string, Box>()
  for (const l of layers) boxOf.set(l.id, layerDesignBox(l, ctx, W0, H0))
  const claimed = new Set<string>()
  const units: Unit[] = []
  const union = (ids: string[]): Box => ids.map(id => boxOf.get(id)!).reduce(unionBox)

  // Who clips whom — read before the passes below, because the group pass needs it too.
  const clippedBySource = new Map<string, string[]>()
  for (const l of layers) {
    const ref = layerMaskRef(l)
    if (!ref || !ref.startsWith('l:')) continue
    const srcId = ref.slice(2)
    if (!byId.has(srcId)) continue
    const list = clippedBySource.get(srcId)
    if (list) list.push(l.id); else clippedBySource.set(srcId, [l.id])
  }

  // 1. Groups: every member of an outermost group, including nested groups' members.
  const groupById = new Map(groups.map(g => [g.id, g]))
  const groupUnitOf = new Map<string, Unit>()
  for (const l of layers) {
    if (!l.groupId || claimed.has(l.id)) continue
    const top = topGroupOf(l.groupId, groups)
    const memberIds = layersInGroup(top, layers, groups).filter(id => byId.has(id))
    if (memberIds.length === 0) continue
    const unit: Unit = { id: top, kind: 'group', memberIds, box: union(memberIds), pins: groupById.get(top)?.pins, canStretch: false }
    for (const id of memberIds) { claimed.add(id); groupUnitOf.set(id, unit) }
    units.push(unit)
  }
  // 1b. A clipped layer whose mask SOURCE is inside a group belongs to that group: the
  // group pass claimed the source first, so pass 2 skips the pair and the clipped layer
  // would otherwise fall through as a plain, stretchable unit and slide out of its crop.
  for (const [srcId, clippedIds] of clippedBySource) {
    const unit = groupUnitOf.get(srcId)
    if (!unit) continue
    for (const id of clippedIds) {
      if (claimed.has(id)) continue
      claimed.add(id)
      groupUnitOf.set(id, unit)
      unit.memberIds.push(id)
      unit.box = unionBox(unit.box, boxOf.get(id)!)
    }
  }
  // 2. Shape-mask pairs: a local mask source plus everything it clips.
  for (const [srcId, clippedIds] of clippedBySource) {
    if (claimed.has(srcId)) continue
    const memberIds = [srcId, ...clippedIds.filter(id => !claimed.has(id))]
    for (const id of memberIds) claimed.add(id)
    units.push({ id: srcId, kind: 'maskPair', memberIds, box: boxOf.get(srcId)!, pins: byId.get(srcId)!.pins, canStretch: false })
  }
  // 3. Cloners, then plain layers.
  for (const l of layers) {
    if (claimed.has(l.id)) continue
    claimed.add(l.id)
    if (l.cloner?.enabled) units.push({ id: l.id, kind: 'cloner', memberIds: [l.id], box: boxOf.get(l.id)!, pins: l.pins, canStretch: false })
    else units.push({ id: l.id, kind: 'layer', memberIds: [l.id], box: boxOf.get(l.id)!, pins: l.pins, canStretch: layerCanStretch(l) })
  }
  return units
}
