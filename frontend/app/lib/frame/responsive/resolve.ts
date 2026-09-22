import type { LocalLayer } from '~/composables/useCompositorLayers'
import { fitScale, spareRoom, guardedRoom, applyMap } from './axis'
import { inferAxisPin, axisOfV } from './infer'
import { sectionsAt, sectionOf } from './sections'
import { buildUnits, type Box } from './units'
import { placeLayer, textNaturalHeightPx } from './stretch'
import { remapMotion } from './motion'
import type { AxisMap, AxisPin, FrameDoc, LayoutResult, ResolveOptions, ResolvedBox } from './types'

interface Ref { design: Box; box: Box }

function identityResult(frame: FrameDoc, gridBox: LayoutResult['grid']): LayoutResult {
  return { layers: frame.layers, motion: frame.motion, grid: gridBox, boxes: new Map(), maps: new Map(), identity: true }
}

/** One axis of one unit: the map plus the resolved near/far edges in box px. */
function resolveAxis(
  kind: AxisPin, canStretch: boolean, s: number,
  uStart: number, uExtent: number,          // the unit's design box on this axis
  ref: { dStart: number; dExtent: number; bStart: number; bExtent: number },
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
  const ctx = opts.measureCtx ?? null
  const sections = sectionsAt(frame.grid, W0, H0, s, W, H)
  const gridOut: LayoutResult['grid'] = sections ? { xs: sections.box.xs, ys: sections.box.ys, regions: sections.box.regions } : null
  // Read keepSize straight off the stored pins, BEFORE buildUnits: the fast path must not pay
  // for a canvas text measurement per layer just to discover it had nothing to do.
  const hasKeep = frame.layers.some(l => l.pins?.keepSize) || frame.groups.some(g => g.pins?.keepSize)
  if (spare.x === 0 && spare.y === 0 && Math.abs(k - 1) < 1e-12 && !hasKeep) return identityResult(frame, gridOut)
  const units = buildUnits(frame.layers, frame.groups, ctx, W0, H0)

  const frameRef: Ref = { design: { x: 0, y: 0, w: W0, h: H0 }, box: { x: 0, y: 0, w: W, h: H } }
  const byId = new Map(frame.layers.map(l => [l.id, l]))
  const boxes = new Map<string, ResolvedBox>()
  const maps = new Map<string, { h: AxisMap; v: AxisMap }>()
  const placed = new Map<string, LocalLayer>()

  for (const unit of units) {
    // Reference rectangle: the design section the unit sits in, unless held to the frame.
    let ref = frameRef
    if (sections && unit.pins?.holdTo !== 'frame') {
      const i = sectionOf(unit.box, sections.design.regions, 0.01 * W0)
      if (i >= 0) ref = { design: sections.design.regions[i]!, box: sections.box.regions[i]! }
    }
    const keep = !!unit.pins?.keepSize
    const kSize = keep ? 1 : s
    const kLayer = keep ? kKeep : k
    // Keeping its size is the opposite of stretching: a keepSize unit is always PLACED, so a
    // 'both' pin — stored or inferred — reads as 'center' on both axes.
    const canStretch = unit.canStretch && !keep
    const hPin: AxisPin = unit.pins?.h ?? inferAxisPin(unit.box.x, unit.box.w, ref.design.x, ref.design.w, canStretch)
    const vPin: AxisPin = unit.pins?.v ? axisOfV(unit.pins.v) : inferAxisPin(unit.box.y, unit.box.h, ref.design.y, ref.design.h, canStretch)
    const hx = resolveAxis(hPin, canStretch, s, unit.box.x, unit.box.w, { dStart: ref.design.x, dExtent: ref.design.w, bStart: ref.box.x, bExtent: ref.box.w }, kSize)
    const vy = resolveAxis(vPin, canStretch, s, unit.box.y, unit.box.h, { dStart: ref.design.y, dExtent: ref.design.h, bStart: ref.box.y, bExtent: ref.box.h }, kSize)
    const unitBox: ResolvedBox = { x: hx.near, y: vy.near, w: hx.far - hx.near, h: vy.far - vy.near }
    const ucx = unit.box.x + unit.box.w / 2, ucy = unit.box.y + unit.box.h / 2
    const ucx2 = unitBox.x + unitBox.w / 2, ucy2 = unitBox.y + unitBox.h / 2

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
        // the re-wrapped height, not the design one. An explicit `boxH` fixes the box height
        // (localLayerBox reads `boxH * W` whenever it is set), so such a text does not re-wrap
        // its box at all and keeps the plain mapped centre.
        if (layer.kind === 'text' && hx.stretched && !vy.stretched && (layer.boxH ?? 0) <= 0 && ctx) {
          const natural = textNaturalHeightPx(layer, boxW / kSize, ctx, W0) * kSize
          if (vPin === 'left') { target.cy = vy.near + natural / 2; boxH = natural }
          else if (vPin === 'right') { target.cy = vy.far - natural / 2; boxH = natural }
        }
        boxes.set(id, { x: target.cx - boxW / 2, y: target.cy - boxH / 2, w: boxW, h: boxH })
      } else {
        // Rigid unit: members keep their arrangement, scaled by kSize about the unit centre.
        // Selection and pins act on the UNIT, so every member reports the unit's box.
        const lcx = layer.x * W0, lcy = layer.y * H0
        target = { cx: ucx2 + (lcx - ucx) * kSize, cy: ucy2 + (lcy - ucy) * kSize }
        boxes.set(id, unitBox)
      }
      let out = placeLayer(layer, target, W, H, kLayer, ctx)
      if (Math.abs(kLayer - 1) > 1e-12) out = { ...out, layoutScale: kLayer } as unknown as LocalLayer
      placed.set(id, out)
    }
  }

  let changed = false
  const layers = frame.layers.map(l => { const p = placed.get(l.id) ?? l; if (p !== l) changed = true; return p })
  const motion = remapMotion(frame.motion, maps, W0, H0, W, H)
  if (!changed && motion === frame.motion) return identityResult(frame, gridOut)
  return { layers, motion, grid: gridOut, boxes, maps, identity: false }
}
