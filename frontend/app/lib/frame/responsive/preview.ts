import { buildUnits, type Unit } from './units'
import { inferAxisPin, V_NAME } from './infer'
import { gridsAt, holdOf } from './spans'
import type { FrameDoc, PinH, PinV, AxisMap, ResolvedBox } from './types'

export interface EffectivePins {
  h: PinH; v: PinV; keepSize: boolean; holdTo: 'frame' | 'grid'
  hAuto: boolean; vAuto: boolean; keepAuto: boolean; holdAuto: boolean
  gridAvailable: boolean
  unitId: string
}

/** The unit that owns `layerId`'s pins, or null. */
function unitOf(units: Unit[], layerId: string): Unit | null {
  return units.find(u => u.memberIds.includes(layerId)) ?? null
}

/**
 * The pins that apply to `layerId`'s unit: stored where present, inferred (and flagged automatic) where absent — inferred against what the unit holds to (its grid span per axis, else the frame), as the resolver infers them. `holdTo` is 'grid' when the unit lies on grid columns or rows, unless a stored `holdTo: 'frame'` overrides.
 */
export function effectivePins(frame: FrameDoc, layerId: string, ctx: CanvasRenderingContext2D | null): EffectivePins | null {
  const { designW: W0, designH: H0, grid } = frame
  if (!(W0 > 0) || !(H0 > 0)) return null
  const units = buildUnits(frame.layers, frame.groups, ctx, W0, H0)
  const unit = unitOf(units, layerId)
  if (!unit) return null
  const stored = unit.pins ?? {}
  // At the design size (W = W0): what the unit would hold to automatically, and what it holds to now.
  const pair = gridsAt(grid, frame.format ?? null, W0, H0, W0, H0)
  const lone = unit.kind === 'layer' ? frame.layers.find(l => l.id === unit.memberIds[0]) : undefined
  const auto = holdOf({ ...unit, pins: { ...stored, holdTo: undefined } }, lone, pair, W0, H0, W0, H0, ctx)
  const gridAvailable = auto.onGrid.h || auto.onGrid.v
  const holdStored = stored.holdTo === 'frame'
  const hold = holdStored ? holdOf(unit, lone, pair, W0, H0, W0, H0, ctx) : auto
  // Inferred against the same rectangle, and with the same stretch rule, the resolver uses (a unit
  // that keeps its size is placed, never stretched), so the card says what really happens.
  const cs = unit.canStretch && !stored.keepSize
  const infH = inferAxisPin(unit.box.x, unit.box.w, hold.h.dStart, hold.h.dExtent, cs)
  const infV = V_NAME[inferAxisPin(hold.vBox.y, hold.vBox.h, hold.v.dStart, hold.v.dExtent, cs && hold.vCanStretch)]
  const holdTo: 'frame' | 'grid' = holdStored ? 'frame' : (gridAvailable ? 'grid' : 'frame')

  return {
    h: stored.h ?? infH, v: stored.v ?? infV, keepSize: stored.keepSize ?? false,
    holdTo,
    hAuto: stored.h == null, vAuto: stored.v == null, keepAuto: stored.keepSize == null,
    holdAuto: !holdStored,
    gridAvailable,
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
