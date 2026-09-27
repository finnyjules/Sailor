import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { FrameGrid } from '~/lib/compositor/mosaicGrid'
import type { FrameMotion } from '~/lib/motion/types'

/**
 * A layer's key in the unified stack: `l:<id>` local, `w:<slot>` wired. The
 * compositor has no exported type for it — ArtifactFrameNode and CompositorModal
 * each declare `type StackKey = string` locally — so it is spelled once here.
 */
export type StackKey = string

/** One pin per axis. 'both' = stretch; 'relative' = slide proportionally (today's behaviour). */
export type PinH = 'left' | 'right' | 'both' | 'center' | 'relative'
export type PinV = 'top' | 'bottom' | 'both' | 'middle' | 'relative'

/** Stored on a layer or a group. Absent field = automatic. */
export interface Pins {
  h?: PinH
  v?: PinV
  keepSize?: boolean
  /** 'frame' = hold to the whole frame even when inside a grid section. Absent = automatic. */
  holdTo?: 'frame'
}

/** The axis-neutral pin name the maths works in. */
export type AxisPin = 'left' | 'right' | 'both' | 'center' | 'relative'

/** A straight-line map from design px to box px on one axis: box = o + s·p + u·k(p). */
export interface AxisMap {
  kind: AxisPin
  s: number      // fit scale
  u: number      // usable spare room on this axis (after the guard)
  // Outer offset, in BOX px: the reference rectangle's box start, plus the guarded remainder
  // split evenly, MINUS the reference's fitted design start (s·refStart). That last term is
  // what makes `o + s·p` absolute box px for an absolute design `p` — every kind but
  // 'relative' feeds applyMap the un-shifted coordinate, so a reference that does not begin
  // at the origin would otherwise count its own start twice.
  o: number
  ref: number    // the reference extent in design px (frame or section)
  refStart: number // where the reference rectangle starts, in design px
}

/** Everything the resolver reads. Built by the caller from the node's sailor_* properties. */
export interface FrameDoc {
  responsive: boolean
  designW: number
  designH: number
  layers: LocalLayer[]
  stackOrder: StackKey[]
  groups: LayerGroup[]
  grid: FrameGrid | null
  motion: FrameMotion | null
}

export interface ResolveOptions {
  /** A scratch 2D context for text measuring. null ⇒ text keeps its centre (no re-wrap). */
  measureCtx?: CanvasRenderingContext2D | null
  /**
   * Fill `boxes`, `maps` and `units` even when the layout is otherwise identity — for the
   * editor, which needs them at every size. Layers still come back by reference when nothing moved.
   */
  withBoxes?: boolean
}

export interface ResolvedBox { x: number; y: number; w: number; h: number } // box px, top-left

/** What an edit at a viewing size needs to know about the unit a layer belongs to. */
export interface UnitInfo {
  unitId: string                                   // layer id, group id, or mask-source id
  kind: 'layer' | 'group' | 'maskPair' | 'cloner'
  memberIds: string[]
  canStretch: boolean                              // after Keep size
  kSize: number                                    // view px per design px for the unit's size
  designBox: ResolvedBox                           // design px, top-left
  viewBox: ResolvedBox                             // view px, top-left (as drawn)
  mappedBox: ResolvedBox                           // the span the pins place, view px — equals viewBox except for re-wrapped text
  refDesign: ResolvedBox                           // the section or frame, design px
  refView: ResolvedBox                             // the same, view px
  h: AxisMap; v: AxisMap                           // resolved maps; .kind is the held (effective) pin
  hExplicit: boolean; vExplicit: boolean           // the pin on that axis is stored
}

export interface LayoutResult {
  layers: LocalLayer[]
  motion: FrameMotion | null
  /** Resolved grid lines/regions in box px, or null when the grid is off. */
  grid: { xs: number[]; ys: number[]; regions: ResolvedBox[] } | null
  boxes: Map<string, ResolvedBox>
  maps: Map<string, { h: AxisMap; v: AxisMap }>
  /** Per member layer id: what an edit at this size needs. Empty unless `withBoxes`. */
  units: Map<string, UnitInfo>
  /** True when the inputs were returned by reference. */
  identity: boolean
}
