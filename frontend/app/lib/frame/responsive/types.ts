import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { LayoutGrid, ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'
import type { FrameFormat } from '~/lib/frame/formats'
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
  /** 'frame' = hold to the whole frame even where the layer sits on grid columns or rows. Absent (or anything else, e.g. an older 'section') = automatic. */
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
  /** The Frame's layout grid (readLayoutGrid at the design size), shown or hidden; null = hold to the frame. */
  grid: LayoutGrid | null
  /** The design size's format (covered areas shape the rows). Absent = none. */
  format?: FrameFormat | null
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
  refDesign: ResolvedBox                           // the grid span or the frame, per axis, design px
  refView: ResolvedBox                             // the same, view px
  h: AxisMap; v: AxisMap                           // resolved maps; .kind is the held (effective) pin
  hExplicit: boolean; vExplicit: boolean           // the pin on that axis is stored
  onGrid: { h: boolean; v: boolean }               // which axes hold to the grid (the others hold to the frame)
  vBox: { y: number; h: number }                   // the vertical extent the vertical pin is read from (design px; a text on rows: capitals to last baseline)
  vCanStretch: boolean                             // may a vertical 'both' be inferred (false for a lone text on rows)
  /** What the unit would hold to if its design box were `box` (and its lone layer carried `lonePatch`), as the
   *  resolver's next pass reads it. Lets an edit at a viewing size re-hold on drop. */
  holdAt?: (box: ResolvedBox, lonePatch?: Record<string, unknown>) => HeldAt
  /** The references a unit drawn over [a, b] (view px) on one axis could hold to after an edit at a
   *  viewing size: every grid span holding [a, b] there (spansAtView), then the frame. */
  refsAtView?: (axis: 'h' | 'v', a: number, b: number) => RefChoice[]
}

/** A reference an axis may hold to (design px / view px), with the map a pin makes against it. */
export interface RefChoice {
  dStart: number; dExtent: number; bStart: number; bExtent: number
  onGrid: boolean
  map: (kind: AxisPin) => AxisMap
}

/** One re-read of what a unit holds to (UnitInfo.holdAt). */
export interface HeldAt {
  refDesign: ResolvedBox; refView: ResolvedBox
  onGrid: { h: boolean; v: boolean }
  vBox: { y: number; h: number }; vCanStretch: boolean
  /** The pin each axis would infer there (ignoring any stored pin). */
  inferred: { h: AxisPin; v: AxisPin }
  /** The map a pin of `kind` makes against that reference. */
  map: (axis: 'h' | 'v', kind: AxisPin) => AxisMap
}

export interface LayoutResult {
  layers: LocalLayer[]
  motion: FrameMotion | null
  /** The layout grid resolved at the viewing size (gridsAt(...).view), or null without a grid. */
  grid: ResolvedLayoutGrid | null
  boxes: Map<string, ResolvedBox>
  maps: Map<string, { h: AxisMap; v: AxisMap }>
  /** Per member layer id: what an edit at this size needs. Empty unless `withBoxes`. */
  units: Map<string, UnitInfo>
  /** True when the inputs were returned by reference. */
  identity: boolean
}
