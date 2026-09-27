import type { LocalLayer } from '~/composables/useCompositorLayers'
import { fitScale, spareRoom, guardedRoom, applyMap } from './axis'
import { inferAxisPin, axisOfV } from './infer'
import { gridsAt, holdOf, type AxisRef } from './spans'
import { buildUnits } from './units'
import { placeLayer, textNaturalHeightPx } from './stretch'
import { remapMotion } from './motion'
import type { AxisMap, AxisPin, FrameDoc, LayoutResult, ResolveOptions, ResolvedBox, UnitInfo } from './types'

function identityResult(frame: FrameDoc, gridBox: LayoutResult['grid']): LayoutResult {
  return { layers: frame.layers, motion: frame.motion, grid: gridBox, boxes: new Map(), maps: new Map(), units: new Map(), identity: true }
}

/** One axis of one unit: the map plus the resolved near/far edges in box px. */
function resolveAxis(
  kind: AxisPin, canStretch: boolean, s: number,
  uStart: number, uExtent: number,          // the unit's design box on this axis
  ref: AxisRef,
  kSize: number,                            // kSize: px per design px for this unit's SIZE (s, or 1 for keepSize)
): { map: AxisMap; near: number; far: number; stretched: boolean } {
  const spare = ref.bExtent - s * ref.dExtent
  const { u, o } = guardedRoom(Math.max(0, spare), s * ref.dExtent)
  const effective: AxisPin = kind === 'both' && !canStretch ? 'center' : kind
  // `applyMap` reads the ABSOLUTE design coordinate (`o + s·p`; only 'relative' subtracts
  // refStart), so the reference's own fitted start must be taken back out of `o` — otherwise a
  // section that does not begin at the origin counts its start twice and pushes past the frame.
  const map: AxisMap = { kind: effective, s, u, o: ref.bStart + o - s * ref.dStart, ref: ref.dExtent, refStart: ref.dStart }
  const size = uExtent * kSize
  if (effective === 'both') {
    // Bleed: a side whose design gap to the reference edge is ≤ 0 holds the REAL edge.
    const nearGap = uStart - ref.dStart, farGap = ref.dStart + ref.dExtent - (uStart + uExtent)
    const near = nearGap <= 1e-6 ? ref.bStart : applyMap(map, uStart, 'near')
    const far = farGap <= 1e-6 ? ref.bStart + ref.bExtent : applyMap(map, uStart + uExtent, 'far')
    return { map, near, far, stretched: true }
  }
  const c = applyMap(map, uStart + uExtent / 2)
  return { map, near: c - size / 2, far: c + size / 2, stretched: false }
}

export function resolveLayout(frame: FrameDoc, W: number, H: number, opts: ResolveOptions = {}): LayoutResult {
  const { designW: W0, designH: H0 } = frame
  // A degenerate design OR box would make fitScale/invertMap produce NaN, so both guard.
  if (!frame.responsive || frame.layers.length === 0 || !(W0 > 0) || !(H0 > 0) || !(W > 0) || !(H > 0)) return identityResult(frame, null)
  const s = fitScale(W0, H0, W, H)
  const spare = spareRoom(W0, H0, W, H)
  const k = s * W0 / W                       // layoutScale for every non-keepSize layer
  const kKeep = W0 / W                        // layoutScale for a keepSize layer
  // The same two scales on the vertical axis, for the one thing stored as a fraction of
  // the frame HEIGHT rather than its width: a cloner's `dy` (see scaleCloner).
  const kv = s * H0 / H
  const kvKeep = H0 / H
  const ctx = opts.measureCtx ?? null
  const grids = gridsAt(frame.grid, frame.format ?? null, W0, H0, W, H)
  const gridOut: LayoutResult['grid'] = grids ? grids.view : null
  // Read keepSize straight off the stored pins, BEFORE buildUnits: the fast path must not pay
  // for a canvas text measurement per layer just to discover it had nothing to do.
  const hasKeep = frame.layers.some(l => l.pins?.keepSize) || frame.groups.some(g => g.pins?.keepSize)
  if (!opts.withBoxes && spare.x === 0 && spare.y === 0 && Math.abs(k - 1) < 1e-12 && !hasKeep) return identityResult(frame, gridOut)
  const units = buildUnits(frame.layers, frame.groups, ctx, W0, H0)

  const byId = new Map(frame.layers.map(l => [l.id, l]))
  const boxes = new Map<string, ResolvedBox>()
  const maps = new Map<string, { h: AxisMap; v: AxisMap }>()
  // Filled only with `withBoxes` (the `units` name is taken by buildUnits' list above).
  const unitInfos = new Map<string, UnitInfo>()
  const withBoxes = !!opts.withBoxes
  const placed = new Map<string, LocalLayer>()

  for (const unit of units) {
    // What the unit holds to, per axis: its columns (and rows) on the layout grid when it lies on
    // them, else the frame — the same rule the pins card reads (effectivePins).
    const lone = unit.kind === 'layer' ? byId.get(unit.memberIds[0]!) : undefined
    const hold = holdOf(unit, lone, grids, W0, H0, W, H, ctx)
    const refDesign: ResolvedBox = { x: hold.h.dStart, y: hold.v.dStart, w: hold.h.dExtent, h: hold.v.dExtent }
    const refView: ResolvedBox = { x: hold.h.bStart, y: hold.v.bStart, w: hold.h.bExtent, h: hold.v.bExtent }
    const keep = !!unit.pins?.keepSize
    const kSize = keep ? 1 : s
    const kLayer = keep ? kKeep : k
    const kvLayer = keep ? kvKeep : kv
    // Keeping its size is the opposite of stretching: a keepSize unit is always PLACED, so a
    // 'both' pin — stored or inferred — reads as 'center' on both axes.
    const canStretch = unit.canStretch && !keep
    const hPin: AxisPin = unit.pins?.h ?? inferAxisPin(unit.box.x, unit.box.w, hold.h.dStart, hold.h.dExtent, canStretch)
    // Text on rows reads its pin from its capitals and baselines (hold.vBox) and never infers a stretch.
    const vPin: AxisPin = unit.pins?.v ? axisOfV(unit.pins.v) : inferAxisPin(hold.vBox.y, hold.vBox.h, hold.v.dStart, hold.v.dExtent, canStretch && hold.vCanStretch)
    const hx = resolveAxis(hPin, canStretch, s, unit.box.x, unit.box.w, hold.h, kSize)
    const vy = resolveAxis(vPin, canStretch, s, unit.box.y, unit.box.h, hold.v, kSize)
    const unitBox: ResolvedBox = { x: hx.near, y: vy.near, w: hx.far - hx.near, h: vy.far - vy.near }
    const ucx = unit.box.x + unit.box.w / 2, ucy = unit.box.y + unit.box.h / 2
    const ucx2 = unitBox.x + unitBox.w / 2, ucy2 = unitBox.y + unitBox.h / 2
    const info: Omit<UnitInfo, 'viewBox'> | null = withBoxes
      ? {
          unitId: unit.id, kind: unit.kind, memberIds: unit.memberIds, canStretch, kSize,
          designBox: unit.box, mappedBox: unitBox, refDesign, refView,
          h: hx.map, v: vy.map, hExplicit: unit.pins?.h != null, vExplicit: unit.pins?.v != null,
        }
      : null

    for (const id of unit.memberIds) {
      const layer = byId.get(id)!
      maps.set(id, { h: hx.map, v: vy.map })
      let target: { cx: number; cy: number; w?: number; h?: number }
      if (unit.kind === 'layer') {
        target = { cx: ucx2, cy: ucy2 }
        if (hx.stretched) target.w = unitBox.w
        if (vy.stretched) target.h = unitBox.h
        const boxW = target.w ?? unit.box.w * kSize
        let boxH = target.h ?? unit.box.h * kSize
        // A boxed text with a stretched width: its height changes with the re-wrap, so a
        // top/bottom pin keeps THAT edge instead of the centre — and the resolved box reports
        // the re-wrapped height, not the design one. Any other pin keeps the mapped centre (the
        // painter centres the block on it) and still reports the re-wrapped height, so the box
        // is what is drawn; `mappedBox` keeps the placed span. An explicit `boxH` fixes the box height
        // (localLayerBox reads `boxH * W` whenever it is set), so such a text does not re-wrap
        // its box at all and keeps the plain mapped centre.
        if (layer.kind === 'text' && hx.stretched && !vy.stretched && (layer.boxH ?? 0) <= 0 && ctx) {
          const natural = textNaturalHeightPx(layer, boxW / kSize, ctx, W0) * kSize
          if (vPin === 'left') { target.cy = vy.near + natural / 2; boxH = natural }
          else if (vPin === 'right') { target.cy = vy.far - natural / 2; boxH = natural }
          else boxH = natural
        }
        boxes.set(id, { x: target.cx - boxW / 2, y: target.cy - boxH / 2, w: boxW, h: boxH })
        if (info) unitInfos.set(id, { ...info, viewBox: boxes.get(id)! })
      } else {
        // Rigid unit: members keep their arrangement, scaled by kSize about the unit centre.
        // Selection and pins act on the UNIT, so every member reports the unit's box.
        const lcx = layer.x * W0, lcy = layer.y * H0
        target = { cx: ucx2 + (lcx - ucx) * kSize, cy: ucy2 + (lcy - ucy) * kSize }
        boxes.set(id, unitBox)
        if (info) unitInfos.set(id, { ...info, viewBox: unitBox })
      }
      let out = placeLayer(layer, target, W, H, kLayer, ctx, kvLayer)
      if (Math.abs(kLayer - 1) > 1e-12) out = { ...out, layoutScale: kLayer } as unknown as LocalLayer
      placed.set(id, out)
    }
  }

  let changed = false
  const layers = frame.layers.map(l => { const p = placed.get(l.id) ?? l; if (p !== l) changed = true; return p })
  const motion = remapMotion(frame.motion, maps, W0, H0, W, H)
  if (!changed && motion === frame.motion) {
    return withBoxes
      ? { layers: frame.layers, motion: frame.motion, grid: gridOut, boxes, maps, units: unitInfos, identity: true }
      : identityResult(frame, gridOut)
  }
  return { layers, motion, grid: gridOut, boxes, maps, units: unitInfos, identity: false }
}
