import { buildUnits, type Unit } from './units'
import { inferAxisPin } from './infer'
import { sectionsAt, sectionOf } from './sections'
import type { FrameDoc, PinH, PinV, AxisMap, ResolvedBox } from './types'

export interface EffectivePins {
  h: PinH; v: PinV; keepSize: boolean; holdTo: 'frame' | 'section'
  hAuto: boolean; vAuto: boolean; keepAuto: boolean; holdAuto: boolean
  sectionAvailable: boolean
  unitId: string
}

const V_NAME: Record<'left' | 'right' | 'both' | 'center' | 'relative', PinV> =
  { left: 'top', right: 'bottom', both: 'both', center: 'middle', relative: 'relative' }

/** The unit that owns `layerId`'s pins, or null. */
function unitOf(units: Unit[], layerId: string): Unit | null {
  return units.find(u => u.memberIds.includes(layerId)) ?? null
}

/**
 * The pins that apply to `layerId`'s unit: stored where present, inferred (and
 * flagged automatic) where absent. `holdTo` is 'section' when the grid is on and
 * the unit sits in one section, unless a stored `holdTo:'frame'` overrides.
 */
export function effectivePins(frame: FrameDoc, layerId: string, ctx: CanvasRenderingContext2D | null): EffectivePins | null {
  const { designW: W0, designH: H0, grid } = frame
  if (!(W0 > 0) || !(H0 > 0)) return null
  const units = buildUnits(frame.layers, frame.groups, ctx, W0, H0)
  const unit = unitOf(units, layerId)
  if (!unit) return null
  const stored = unit.pins ?? {}
  const ref = { x: 0, y: 0, w: W0, h: H0 }
  const infH = inferAxisPin(unit.box.x, unit.box.w, ref.x, ref.w, unit.canStretch)
  const infV = V_NAME[inferAxisPin(unit.box.y, unit.box.h, ref.y, ref.h, unit.canStretch)]

  // Section availability: at the design size (s = 1), does the unit's box sit in one region?
  let sectionAvailable = false
  if (grid && grid.mode !== 'off') {
    const sec = sectionsAt(grid, W0, H0, 1, W0, H0)   // s = 1 at the design size
    if (sec) sectionAvailable = sectionOf(unit.box, sec.design.regions, 0.01 * W0) >= 0
  }
  const holdStored = stored.holdTo === 'frame'
  const holdTo: 'frame' | 'section' = holdStored ? 'frame' : (sectionAvailable ? 'section' : 'frame')

  return {
    h: stored.h ?? infH, v: stored.v ?? infV, keepSize: stored.keepSize ?? false,
    holdTo,
    hAuto: stored.h == null, vAuto: stored.v == null, keepAuto: stored.keepSize == null,
    holdAuto: stored.holdTo == null,
    sectionAvailable,
    unitId: unit.id,
  }
}

export interface GuideLines {
  left?: number; right?: number; top?: number; bottom?: number
  centerX?: boolean; centerY?: boolean
  box: ResolvedBox
}

/** Guide segments (box-normalized) for the unit's held edges, from its resolved box and maps. */
export function guideLinesFor(box: ResolvedBox, maps: { h: AxisMap; v: AxisMap }, W: number, H: number): GuideLines {
  const g: GuideLines = { box }
  const hk = maps.h.kind, vk = maps.v.kind
  if (hk === 'left' || hk === 'both') g.left = box.x / W
  if (hk === 'right' || hk === 'both') g.right = (box.x + box.w) / W
  if (hk === 'center') g.centerX = true
  if (vk === 'left' || vk === 'both') g.top = box.y / H
  if (vk === 'right' || vk === 'both') g.bottom = (box.y + box.h) / H
  if (vk === 'center') g.centerY = true
  return g
}
