/**
 * Local "design" layers for the Compositor — text and shapes authored directly
 * in the editor, with no upstream graph node. They live on the compositor node
 * (`node.data.properties.sailor_localLayers`) and are baked client-side into
 * a single RGBA overlay at submit time, then fed to the backend as an alpha
 * overlay (see `nodes_compositor.py`).
 *
 * Geometry is resolution-independent so the editor preview, the node thumbnail,
 * and the final bake all match exactly:
 *   - `x`, `y`      → normalized CENTER position (0..1 of canvas width/height)
 *   - sizes         → normalized to canvas WIDTH (uniform, so rotation never
 *                     shears regardless of canvas aspect)
 * One renderer (`drawLocalLayer`) draws to any 2D context at any resolution.
 */

export type LocalLayerKind = 'text' | 'rect' | 'ellipse' | 'line' | 'path' | 'image' | 'polygon' | 'star' | 'brush' | 'wired' | 'deal'

// ── Motion painter indirection ───────────────────────────────────────────────
// paintLayerStack(t) needs the motion module, but motion/paint.ts imports
// drawLocalLayer from THIS file — a static import here would be a cycle.
// paint.ts registers its functions on first import; callers that pass a time
// (modal preview, bake) import '~/lib/motion/paint' and guarantee registration.
// Type-only imports are erased at runtime, so they don't create a cycle
// (evaluate.ts/types.ts don't import this file).
import type { LayerMotionState } from '~/lib/motion/evaluate'
import type { FrameMotion } from '~/lib/motion/types'
import { axesToVariationSettings } from '~/lib/motion/axes'
import { expandClones, type Cloner } from '~/composables/useCloner'
import { fillIsShader } from '~/lib/spacetype/fillTile'
import { withFieldFrame, type FieldRequest } from '~/lib/shaderfill/field'
import {
  hasPaint, resolvePaint, OBJECT_SHADER_FIELD_PX, type ShaderFieldFrameCtx,
} from '~/lib/paint/resolve'
import { drawQuadWarp, type Quad } from '~/lib/compositor/warp'
import { polygonPathData, starPathData } from '~/lib/compositor/polygonGeometry'
import { resolveGroupCascade, type LayerGroup } from '~/lib/compositor/layerGroups'
import { layoutExpressive, type ExpressiveParams } from '~~/shared/text-layout/expressive'
import { type PaintStroke, stampStrokes, strokeBounds } from '~/lib/compositor/brushStamp'
import {
  applyEffectChain, applyStackPost, chainActive, isChainEffect,
  type AdjustEffect, type BloomEffect, type DofEffect, type DuotoneEffect,
  type GradientMapEffect, type GrainEffect, type PostEffect, type VignetteEffect,
} from '~/lib/compositor/postEffects'
import { applyDof, dofAvailable, dofShouldRun } from '~/lib/compositor/dofPass'
import { depthImageFor, requestDepth, depthSourceFromViewUrl, type DepthRef } from '~/lib/compositor/depthRegistry'
import { ensureFillBitmaps, getFillBitmap } from '~/lib/paint/imageFillCache'
import { applyTornEdge, tornEdgeActive } from '~/lib/compositor/tornEdge'
import { applyFeather, featherActive } from '~/lib/compositor/feather'
import {
  LruCache, SILHOUETTE_CACHE_CAP, SILHOUETTE_CACHE_MAX_BYTES, silhouetteCacheKey,
  silhouettePadPx as silhouettePadPxPure, silhouetteContentReady as silhouetteContentReadyPure,
  silhouetteRasterFits,
} from '~/lib/compositor/silhouetteCache'
import { paintMaskRelease } from '~/lib/compositor/maskBreak'
// Runtime import is safe: wiredLayer.ts only imports the WiredLayer TYPE back from
// this file, and type imports are erased — so this is not a module cycle.
import { wiredLayerHeight } from '~/lib/compositor/wiredLayer'
import { resolveGrid, defaultGrid, type FrameGrid } from '~/lib/frame/grid'
import { pickDealPaint, keptCell, forceKeptCell, type DealVocab } from '~/lib/compositor/dealVocab'
import { paneCellGradient } from '~/lib/compositor/pane'

// Throwaway 2D context used only for text measurement (localLayerBox mutates the
// ctx font), so it never touches a real render target.
let _measureCtx: CanvasRenderingContext2D | null = null
function measureCtx(): CanvasRenderingContext2D | null {
  if (!_measureCtx && typeof document !== 'undefined') _measureCtx = document.createElement('canvas').getContext('2d')
  return _measureCtx
}

interface MotionPainter {
  motionStateFor: (layer: LocalLayer, t: number, motion: FrameMotion) => LayerMotionState | null
  drawLayerWithMotion: (
    ctx: CanvasRenderingContext2D, layer: LocalLayer, W: number, H: number,
    maskLayer: LocalLayer | null, st: LayerMotionState, maskState: LayerMotionState | null,
  ) => void
  identityState: () => LayerMotionState
}
let _motionPainterImpl: MotionPainter | null = null
export function _registerMotionPainter(impl: MotionPainter) { _motionPainterImpl = impl }

// ── Wired content indirection ────────────────────────────────────────────────
// A wired layer's pixels come from an upstream graph slot, which only the HOST
// (the Frame node card, the Compositor modal, the bake) can resolve — it owns the
// image cache / live studio surfaces keyed by slot. Rather than thread a resolver
// argument through paintLayerStack → drawLocalLayer → paintLayer → drawLayerContent
// (six signatures, every call site), the host registers one provider here, exactly
// like `_registerMotionPainter` above.
//
// The provider is called on EVERY draw, never memoized: that IS the liveness
// contract. Re-running the upstream node swaps the content behind the same slot
// and the very next frame re-fits to its new aspect with no invalidation step.
//
// Because it's called fresh each time, it MUST be a cheap accessor (cache/ref
// lookup, no decode/compute work) and MUST be stable WITHIN a single frame —
// paintLayer resolves it once per layer per paint and reuses that one result
// for both box-sizing and drawing (see `wiredLive` in paintLayer below); a
// provider that returns a fresh surface with different dimensions on back-to-
// back calls would size the corner-pin/DOF offscreen from one call and draw
// into it from another, producing a misfit warp.
export type WiredContentProvider = (slot: number) => CanvasImageSource | null
let _wiredContentImpl: WiredContentProvider | null = null
/** Register (or clear, with `null`) the host's slot → live content resolver. */
export function _registerWiredContent(provider: WiredContentProvider | null) { _wiredContentImpl = provider }

/**
 * Run `fn` with `provider` installed as THE wired resolver, restoring whatever
 * was there before — the scoping seam for the fact that slot numbers are
 * HOST-scoped while this registry is one module global.
 *
 * Two live hosts (a Frame card and the Compositor modal, or two cards) each own
 * a different node's slots, so a single global registration means whoever
 * painted last decides what "slot 2" resolves to for everybody. That is not
 * only a pixel bug: `localLayerBox` resolves the provider too, so a cross-host
 * leak mis-sizes SELECTION HANDLES and the pixel hit test, not just the image.
 *
 * Every synchronous span that can resolve wired content — a paint, an export, a
 * hit test, a box measurement — wraps itself here with its OWN provider. Nesting
 * is safe (the previous provider is restored on the way out, exceptions
 * included), and passing a nullish provider runs `fn` untouched so a host with
 * nothing wired never clobbers another host's registration.
 *
 * `fn` MUST be synchronous: an `await` inside would let another host's span
 * interleave while this one's provider is still installed.
 */
export function withWiredContent<T>(provider: WiredContentProvider | null | undefined, fn: () => T): T {
  if (!provider) return fn()
  const prev = _wiredContentImpl
  _wiredContentImpl = provider
  try { return fn() } finally { _wiredContentImpl = prev }
}

/** Resolved wired-slot content: the source plus its native pixel dimensions. */
type WiredLive = { src: CanvasImageSource; w: number; h: number }

/**
 * The live content for a wired layer's slot together with its pixel dimensions,
 * or null when there is nothing drawable this frame (no provider, slot empty,
 * `<img>` still decoding, zero-sized source). A null here is NOT an error state:
 * the layer simply contributes no pixels, and hosts render the "unlinked" badge
 * in the DOM from `layer.unlinked` — paint never draws placeholder art.
 */
function wiredContent(layer: WiredLayer): WiredLive | null {
  if (!_wiredContentImpl) return null
  let src: CanvasImageSource | null = null
  // A host provider reaches into caches/refs; a throw here must degrade to "no
  // content this frame", never take the whole stack down mid-paint.
  try { src = _wiredContentImpl(layer.slot) } catch { return null }
  if (!src) return null
  const s = src as unknown as Record<string, unknown>
  if ('complete' in s && s.complete === false) return null      // undecoded <img>
  // naturalW/H → <img>; videoW/H → <video>; displayW/H → VideoFrame; w/h → canvas,
  // OffscreenCanvas, ImageBitmap. Anything else isn't measurable, so isn't drawable.
  const num = (...keys: string[]) => {
    for (const k of keys) { const v = s[k]; if (typeof v === 'number' && v > 0) return v }
    return 0
  }
  const w = num('naturalWidth', 'videoWidth', 'displayWidth', 'width')
  const h = num('naturalHeight', 'videoHeight', 'displayHeight', 'height')
  if (!(w > 0) || !(h > 0)) return null
  return { src, w, h }
}

/**
 * The aspect (contentH / contentW) a wired layer RENDERS at this frame. Live
 * content wins over the cached `lastAspect` so a re-run upstream node re-fits
 * instead of stretching — except when the layer is `unlinked`, which is exactly
 * the flag that means "keep the size I set, whatever the graph does now".
 *
 * Deliberately read-only: this never writes `lastAspect` back. Paint is pure —
 * hosts reconcile the cached aspect in their own state layer, so a render pass
 * (which also runs for hit tests, silhouettes and bakes) can't mutate the doc.
 */
function wiredAspect(layer: WiredLayer, live: { w: number; h: number } | null): number {
  if (live && !layer.unlinked) return live.h / live.w
  return layer.lastAspect || 1
}

/**
 * Render box of a wired layer in PIXELS, centred on the layer origin like every
 * other kind. Width is the layer's own width-normalized `w`; height follows the
 * aspect it draws at this frame, through `wiredLayerHeight` so the "h = w ×
 * aspect" rule has exactly one definition (the migration math in
 * lib/compositor/wiredLayer.ts is the other consumer of it).
 */
function wiredBoxPx(layer: WiredLayer, W: number, live: { w: number; h: number } | null): { w: number; h: number } {
  return {
    w: layer.w * W,
    h: wiredLayerHeight({ w: layer.w, lastAspect: wiredAspect(layer, live) }) * W,
  }
}

// ── Paint (solid color or gradient) ──────────────────────────────────────────
// Moved to lib/compositor/paint.ts so CPU-only lib/ modules (fillTile.ts) can
// reference `Paint` without pointing back up at this composable — re-exported
// here unchanged so this file's ~40 existing importers don't need to move.
export {
  type GradientStop, type LinearGradient, type RadialGradient, type Gradient, type Paint, type ImageFill,
  isGradient, isFill, isImageFill,
} from '~/lib/compositor/paint'
import { type Paint, isFill, isImageFill, paintTileBox } from '~/lib/compositor/paint'
import { buildDisplacementField, resampleBilinear, type DisplaceMapSpec } from '~/lib/compositor/displace'

// Layer effects (Figma-style). All distances normalized to canvas width, like
// every other dimension here, so they survive resize/export unchanged.
export interface DropShadowEffect {
  type: 'drop_shadow'
  color: string   // rgba/hex (alpha allowed)
  x: number       // offset X, normalized to canvas width
  y: number       // offset Y, normalized to canvas width
  blur: number    // blur radius, normalized to canvas width
  visible: boolean
}
export interface LayerBlurEffect {
  type: 'layer_blur'
  radius: number  // blur radius, normalized to canvas width
  visible: boolean
}
// Shadow cast inward from the layer's silhouette edge (Figma inner shadow).
export interface InnerShadowEffect {
  type: 'inner_shadow'
  color: string
  x: number       // offset X, normalized to canvas width
  y: number       // offset Y, normalized to canvas width
  blur: number    // blur radius, normalized to canvas width
  visible: boolean
}
// Blur what's BEHIND the layer, within its silhouette (Figma background blur).
// Previews correctly wherever the full stack is painted (paintLayerStack); a
// bake of locals alone can only blur the local backdrop below it — wired
// pixels behind it composite server-side, so they can't be pre-blurred.
export interface BackgroundBlurEffect {
  type: 'background_blur'
  radius: number  // blur radius, normalized to canvas width
  visible: boolean
}
export type { AdjustEffect, BloomEffect, DofEffect, DuotoneEffect, GradientMapEffect, GrainEffect, PostEffect, VignetteEffect }
export type LayerEffect =
  | DropShadowEffect | LayerBlurEffect | InnerShadowEffect | BackgroundBlurEffect
  | AdjustEffect | BloomEffect | GrainEffect | VignetteEffect | DuotoneEffect | GradientMapEffect
  // GPU-stage. Lives in the same per-layer effects array as the rest, but is routed by
  // GPU_TYPES rather than CHAIN_TYPES so applyEffectChain never sees it.
  | DofEffect

// Clip mask: the layer is clipped to a rect/ellipse region in CANVAS space
// (axis-aligned, normalized like everything else). For local layers this is
// applied in the canvas and carried into the bake, so the clipped alpha is also
// the generation coverage — the seam for "mask region == inpaint region".
export interface LayerMask {
  kind: 'rect' | 'ellipse'
  x: number          // normalized center X (of width)
  y: number          // normalized center Y (of height)
  w: number          // normalized to canvas width
  h: number          // normalized to canvas width
}

/** 4-corner projective (corner-pin / perspective) warp. Each corner is an OFFSET
 *  from the layer box's natural corner, normalized to the box half-extent
 *  (0 ⇒ no offset = the un-warped rectangle). Applied in the layer's local space. */
export interface CornerPin {
  tl: { x: number; y: number }
  tr: { x: number; y: number }
  br: { x: number; y: number }
  bl: { x: number; y: number }
}
export const IDENTITY_CORNER_PIN: CornerPin = { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } }
/** True when a corner-pin actually distorts (any corner offset is non-trivial). */
export function cornerPinActive(c: CornerPin | undefined | null): c is CornerPin {
  if (!c) return false
  const e = 1e-4
  return [c.tl, c.tr, c.br, c.bl].some(p => Math.abs(p.x) > e || Math.abs(p.y) > e)
}

interface LayerCommon {
  id: string
  kind: LocalLayerKind
  x: number          // normalized center X (0..1 of width)
  y: number          // normalized center Y (0..1 of height)
  rotation: number   // degrees
  skewX?: number     // horizontal slant in degrees (affine shear); default 0
  skewY?: number     // vertical slant in degrees; default 0
  cornerPin?: CornerPin // 4-corner projective warp; absent/identity ⇒ no distortion
  opacity: number    // 0..1
  visible?: boolean  // false = hidden everywhere (render, bake, export); undefined = visible
  locked?: boolean   // true = not selectable/editable from the canvas (panel still can)
  blend?: string     // blend mode vs layers below ('normal' default; same names as wired)
  groupId?: string   // layers sharing a groupId select/move/transform together
  groupName?: string // display name for the group (mirrored on every member)
  name?: string      // user-set display name (overrides the derived label)
  effects?: LayerEffect[] // drop shadow etc. — applied at render time
  mask?: LayerMask        // crop to a rect/ellipse region — applied at render time
  maskedById?: string     // DEPRECATED legacy local-only ref; read via layerMaskRef()
  maskedByKey?: string     // clipped by another layer's silhouette; a StackKey ('w:<slot>'|'l:<id>')
  maskShowSource?: boolean // when true, the mask source also renders normally at its z-position
  /** Freehand visibility painted on THIS layer (brush "Mask mode"). Strokes are
   *  width-normalized to the artboard and applied `destination-in` when the layer
   *  renders. Absent/empty ⇒ no stroke mask. */
  maskStrokes?: import('~/lib/compositor/brushStamp').PaintStroke[]
  /** Base visibility the stroke mask starts from. 'visible' (default): fully
   *  shown, erase strokes cut holes (brush hides, eraser un-hides). 'hidden':
   *  fully clipped, non-erase strokes reveal (invert). */
  maskBase?: 'visible' | 'hidden'
  /** Break-out: open the shape mask on one side of a line so the subject escapes
   *  an edge (see lib/compositor/maskBreak). Only meaningful with maskedByKey. */
  maskBreak?: import('~/lib/compositor/maskBreak').MaskBreak
  /** Linked cloner: stamp this layer N times (linear/grid/radial) with falloff.
   *  Absent/disabled ⇒ a single instance, i.e. today's behavior. */
  cloner?: Cloner
  /** Motion (Kinetic Slates): timing + presets evaluated by app/lib/motion.
   *  Absent ⇒ the layer is static and always visible. */
  animation?: import('~/lib/motion/types').LayerAnimation
  /** Torn-paper edge: raggedizes this layer's alpha boundary + optional white
   *  lip. Absent/inactive ⇒ a clean edge. See lib/compositor/tornEdge. */
  tornEdge?: import('~/lib/compositor/tornEdge').TornEdgeSpec
  /** Soft alpha falloff at the layer's edges (feather). Absent/inactive ⇒ crisp
   *  edge. amount is normalized to canvas width. See lib/compositor/feather. */
  feather?: import('~/lib/compositor/feather').FeatherSpec
}

/** True when a layer is hidden (visible === false; undefined means visible). */
export function layerHidden(l: { visible?: boolean } | null | undefined): boolean {
  return l?.visible === false
}

/**
 * The StackKey of the layer this one is masked by, or undefined. Prefers the
 * new cross-source `maskedByKey`; falls back to the legacy local-only
 * `maskedById` (interpreted as `l:<id>`) so old frames keep rendering.
 */
export function layerMaskRef(
  l: { maskedByKey?: string; maskedById?: string } | null | undefined,
): string | undefined {
  if (l?.maskedByKey) return l.maskedByKey
  if (l?.maskedById) return `l:${l.maskedById}`
  return undefined
}

export interface TextLayer extends LayerCommon {
  kind: 'text'
  text: string
  fontFamily: string
  fontWeight: number     // 100..900 (was 400 | 700 — old values stay valid)
  fontSize: number       // normalized to canvas width
  color: Paint           // text fill — solid, gradient, or a patterned Fill
  align: 'left' | 'center' | 'right' | 'justify'
  /** Vertical alignment within the text box (`boxH`). Absent ⇒ 'top'. Only
   *  meaningful when `boxH` is set (otherwise there's no height to align in). */
  valign?: 'top' | 'middle' | 'bottom' | 'justify'
  lineHeight: number     // multiplier
  letterSpacing?: number // tracking in em (fraction of font size); default 0
  underline?: boolean    // draw an underline under each line
  strikethrough?: boolean// draw a line-through each line
  /** Display-only case transform (the stored `text` is left untouched, so it
   *  round-trips through inline editing). Absent ⇒ text renders verbatim. */
  textTransform?: 'uppercase' | 'lowercase' | 'capitalize'
  strokeColor: Paint
  strokeWidth: number    // normalized to canvas width (0 = no outline)
  /** Dashed outline (see StrokeDash). `strokeText` honours setLineDash, so the
   *  text outline dashes exactly like a shape's does. Absent ⇒ solid. */
  strokeDash?: StrokeDash
  boxW?: number          // optional text-box width (normalized to canvas width);
                         // set => words auto-wrap to fit, unset => explicit \n only
  boxH?: number          // optional text-box height (normalized to canvas width);
                         // enables valign + vertical justify. Absent => natural height.
  /** Live variable-font axis values (wght/wdth/slnt/…). When present, `wght`
   *  drives the numeric font-weight in the canvas `font` shorthand (the only
   *  variable-axis path that renders on every browser); the full set is also
   *  applied via `fontVariationSettings` where the canvas supports it. */
  axes?: Record<string, number>
  /** Expressive per-word layout. When present, words are grouped into lines by
   *  count and each is placed by a seeded rule (overriding flow `align`).
   *  Absent ⇒ normal line-based rendering (byte-identical to before). */
  expressive?: ExpressiveParams
}

/**
 * A rectangle's corner rounding. A plain number is UNIFORM (what every rect
 * stored before per-corner radii existed, so saved docs are byte-identical);
 * the tuple is per-corner, clockwise from the top-left: [tl, tr, br, bl].
 * Either form is normalized to canvas width, like every other dimension.
 *
 * NOT animatable: layer motion (lib/motion) only ever produces transform/opacity
 * deltas, so no keyframe or preset can reach `radius` in either form — and the
 * agent's setLayerProps accepts a number only (lib/agent/surfaces/compositor.ts).
 */
export type RectRadius = number | [number, number, number, number]

/**
 * Where a closed shape's outline sits relative to its edge. Canvas2D only
 * strokes CENTERED (half in, half out) — the other two are built from that:
 * 'inside' clips to the shape and strokes at 2× width (the outer half is
 * clipped away), 'outside' strokes at 2× width and knocks the interior out.
 * Absent ⇒ 'center', which is exactly what every shape did before this existed.
 *
 * Closed kinds only (rect, ellipse, polygon, star, path). A line and a text
 * outline have no interior to align against, so they stay centered.
 */
export type StrokeAlign = 'center' | 'inside' | 'outside'

/**
 * Dashed outline: `dash` px on, `gap` px off, both normalized to canvas width
 * like every other dimension (path layers carry them in the same LOCAL units as
 * their `strokeWidth`, so a dash scales with the shape). Absent ⇒ solid.
 *
 * NOT animatable in v1 (layer motion only produces transform/opacity deltas).
 */
export interface StrokeDash { dash: number; gap: number }

/** Fields every stroked closed shape shares. Both optional; absent = today. */
interface StrokeStyleFields {
  strokeAlign?: StrokeAlign
  strokeDash?: StrokeDash
}

/**
 * The concrete `setLineDash` segments for a stored dash, in the caller's units
 * (`scale` = the same factor the caller uses for `lineWidth`, so the dash keeps
 * its ratio to the outline's thickness at any size). Returns null for "solid" —
 * absent, malformed, or a non-positive dash — which is the untouched legacy path.
 */
export function strokeDashSegments(dash: StrokeDash | undefined | null, scale = 1): [number, number] | null {
  if (!dash || typeof dash !== 'object') return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const d = num(dash.dash) * scale
  if (!(d > 0)) return null
  return [d, Math.max(0, num(dash.gap) * scale)]
}

/** Normalize a stored `strokeAlign` (anything unrecognized ⇒ 'center'). */
export function strokeAlignOf(v: unknown): StrokeAlign {
  return v === 'inside' || v === 'outside' ? v : 'center'
}

export interface RectLayer extends LayerCommon, StrokeStyleFields {
  kind: 'rect'
  w: number; h: number    // normalized to canvas width
  fill: Paint             // '' / 'none' = no fill; or a gradient / patterned Fill
  stroke: Paint
  strokeWidth: number     // normalized to canvas width
  radius: RectRadius      // normalized to canvas width; number = uniform
}

/**
 * Resolve a rect's `radius` to four concrete corner radii in the SAME units as
 * `w`/`h`, clamped so no corner can exceed half the shorter side (and never
 * negative / NaN). `scale` converts the stored width-normalized radius into the
 * caller's space (px when drawing, 1 when staying in local units).
 *
 * This is the single place a rect's rounding is interpreted — paint, the
 * shape→path conversion and the mask silhouette all go through it, so the card,
 * the modal and client bakes agree by construction.
 */
export function cornerRadii(radius: RectRadius | undefined | null, w: number, h: number, scale = 1): [number, number, number, number] {
  const max = Math.max(0, Math.min(Math.abs(w), Math.abs(h)) / 2)
  const one = (v: unknown) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v * scale : 0
    return Math.max(0, Math.min(n, max))
  }
  return Array.isArray(radius)
    ? [one(radius[0]), one(radius[1]), one(radius[2]), one(radius[3])]
    : [one(radius), one(radius), one(radius), one(radius)]
}

export interface EllipseLayer extends LayerCommon, StrokeStyleFields {
  kind: 'ellipse'
  w: number; h: number
  fill: Paint
  stroke: Paint
  strokeWidth: number
}

/**
 * Bezier vector path — the core of the vector editor. Geometry is stored as an
 * SVG path string `d` whose coordinates are in LOCAL units (1 unit = canvas
 * width) and CENTERED on the path's bounding-box midpoint, so the layer's x/y +
 * rotation transform behaves exactly like every other layer. `scale` is a
 * uniform multiplier the resize handle drives; `bbox` is the un-scaled local
 * extent (cached on import/edit) used for selection boxes and hit-testing.
 */
export interface PathLayer extends LayerCommon, StrokeStyleFields {
  kind: 'path'
  d: string               // SVG path data, local units, centered on (0,0)
  bbox: { w: number; h: number } // un-scaled local extent (width-fraction units)
  scale: number           // uniform size multiplier
  fill: Paint             // '' / 'none' = no fill; or a gradient / patterned Fill
  fillRule: 'nonzero' | 'evenodd'
  stroke: Paint
  strokeWidth: number     // local units at scale=1 (scales with the shape)
  /** Provenance when the geometry came from the shape library (lib/shapes): the
   *  manifest id. Lets the inspector offer a swap and the agent name the shape.
   *  Absent on imported / drawn / boolean-result paths. Node editing rebuilds the
   *  layer through createPathLayer, which never sets it — so hand-edited geometry
   *  drops the id by construction. */
  shapeId?: string
}

export interface LineLayer extends LayerCommon {
  kind: 'line'
  w: number               // length, normalized to canvas width
  stroke: Paint
  strokeWidth: number
  /** Dashes apply to a line too; alignment doesn't (no interior). */
  strokeDash?: StrokeDash
}

export interface ImageLayer extends LayerCommon {
  kind: 'image'
  filename: string        // uploaded image in ComfyUI's input dir
  w: number; h: number    // normalized to canvas width (aspect preserved on drop)
  tint?: Paint            // optional fill blended over the image, clipped to its alpha
  tintBlend?: string      // blend mode for the tint (same names as layer blend)
  tintOpacity?: number    // 0..1 tint strength; default 1
  displaceMap?: DisplaceMapSpec // present ⇒ layer is a lens warping everything below
}

/**
 * A graph-input image, expressed as an ordinary layer. The pixels come from an
 * upstream node (identified by `slot`), not from a file on the layer — but the
 * geometry is the SAME width-normalized box every other layer uses, so wired
 * content moves, rotates, masks and stacks through one code path.
 *
 * There is no stored `h`: the render height follows the LIVE content aspect
 * (`h = w * lastAspect`), so re-running the upstream node at a new aspect
 * re-fits the layer instead of stretching it. `lastAspect` caches the most
 * recent content aspect (contentH / contentW) so the box survives a frame with
 * no content yet, and so `unlinked` layers (deliberately detached from the live
 * aspect after a manual resize) keep the size the user set.
 */
export interface WiredLayer extends LayerCommon {
  kind: 'wired'
  slot: number       // upstream input slot the pixels come from
  w: number          // normalized to canvas width (like every other layer)
  lastAspect: number // contentH / contentW of the last-seen content
  unlinked?: boolean // true = keep `lastAspect` even when live content differs
  /**
   * Depth-map cache key for this slot's content (the upstream `/view` URL), so a
   * wired layer can carry a `dof` effect like a local image layer does — which is
   * keyed by `filename` for exactly the same reason. HOST-OWNED and refreshed
   * whenever the slot's content changes; absent means "no depth source" (a live
   * studio slot has no file behind it), and DOF then no-ops instead of blurring
   * against a stale map.
   */
  depthKey?: string
}

export interface PolygonLayer extends LayerCommon, StrokeStyleFields {
  kind: 'polygon'
  w: number; h: number
  sides: number          // integer >= 3
  cornerRadius: number   // 0..1 ratio (scale-invariant)
  fill: Paint; stroke: Paint; strokeWidth: number
}
export interface StarLayer extends LayerCommon, StrokeStyleFields {
  kind: 'star'
  w: number; h: number
  points: number         // integer >= 3
  innerRatio: number     // 0.01..0.99 (inner radius / outer radius)
  cornerRadius: number   // 0..1 ratio
  fill: Paint; stroke: Paint; strokeWidth: number
}

export interface BrushLayer extends LayerCommon {
  kind: 'brush'
  strokes: PaintStroke[]
  fill: Paint            // region fill — full FillControl set; '' / 'none' = no fill
  stroke?: Paint         // optional outline of the painted silhouette
  strokeWidth?: number   // normalized to width
  w: number              // full-artboard bounds; 1 = artboard width
  h: number              // aspect (artboardH / artboardW)
}

/**
 * A "generative deal": ONE self-painting layer that deals every cell of a modular
 * grid a fill from a weighted vocabulary, keyed by a seed. This is how a dense
 * decorative grid (Oddgrid / Modular / Mosh / Static) is a single layer instead of
 * N rect layers. The layer carries its OWN grid (so multiple deals can coexist and
 * the deal is self-contained), and `grid.gen.seed` drives BOTH the cell layout
 * (via resolveGrid) and the per-cell fill pick + density drop — so "New variation"
 * re-rolls the whole look coherently. Unlike the editor-only grid OVERLAY, a deal
 * is normal content: it renders, bakes and exports.
 */
export interface DealLayer extends LayerCommon {
  kind: 'deal'
  w: number; h: number        // box size, BOTH normalized to canvas width (like RectLayer)
  grid: FrameGrid             // the cell layout for THIS layer
  vocab: DealVocab            // named weighted fill vocabulary
  density: number             // 0..1 fraction of cells that get filled (rest transparent)
  cellInset: number           // 0..0.4 normalized inset per cell (gutter look on top of the grid's own)
  // How each kept cell is painted. 'solid' (default / absent) = one vocabulary fill
  // per cell; 'pane' = a hue-walked two-ink linear gradient per cell (a "gradient
  // mosaic" / Pane look), from the same palette. Absent behaves as 'solid' so
  // existing deals are unchanged.
  cellFill?: 'solid' | 'pane'
}

export type LocalLayer = TextLayer | RectLayer | EllipseLayer | LineLayer | ImageLayer | PathLayer | PolygonLayer | StarLayer | BrushLayer | WiredLayer | DealLayer

// Re-export so consumers of local layers can import the stroke type from one place.
export type { PaintStroke } from '~/lib/compositor/brushStamp'

let _idSeq = 0
function newId(): string {
  _idSeq += 1
  return `ll-${Date.now().toString(36)}-${_idSeq}`
}

// ── Ideogram Layerize import ─────────────────────────────────────────────────
// Convert the layers_json emitted by LayerizeGraphicNode (Ideogram Layerize)
// into Frame text layers. Ideogram reports a `resolution` (often different
// from the input size — it re-renders) and text containers whose item boxes
// are top-left px rects in that resolution space; our layers are normalized
// center coords, so the math here is the whole conversion. Schema sample:
//   { data: [{ resolution: "1152x864", text_containers: [{ items: [{
//       x, y, width, height, angle, alignment, font_file, font_size,
//       line_height, spans: [{ color, text }] }] }] }] }
export interface IdeogramImport { width: number; height: number; textLayers: TextLayer[] }

export function parseIdeogramLayers(json: string): IdeogramImport | null {
  let root: any
  try { root = JSON.parse(json) } catch { return null }
  const d = root?.data?.[0]
  if (!d) return null
  const [W, H] = String(d.resolution || '').split('x').map(Number)
  if (!W || !H) return null
  const textLayers: TextLayer[] = []
  for (const container of d.text_containers ?? []) {
    for (const item of container.items ?? []) {
      const spans: any[] = item.spans ?? []
      const text = spans.map((s) => s?.text ?? '').join('')
      if (!text.trim()) continue
      // 'Montserrat-Medium.ttf' → 'Montserrat'; camel-case splits get spaces.
      const file = String(item.font_file || '')
      const family = file.replace(/\.(ttf|otf)$/i, '').split('-')[0]
        .replace(/([a-z])([A-Z])/g, '$1 $2').trim()
      textLayers.push(createTextLayer({
        x: ((item.x ?? 0) + (item.width ?? 0) / 2) / W,
        y: ((item.y ?? 0) + (item.height ?? 0) / 2) / H,
        rotation: Number(item.angle) || 0,
        text,
        fontFamily: family || 'Inter',
        fontWeight: /bold|black|heavy|700|800|900/i.test(file) ? 700 : 400,
        fontSize: (Number(item.font_size) || 32) / W,
        color: spans[0]?.color || '#ffffff',
        align: (['left', 'center', 'right'] as const).includes(item.alignment) ? item.alignment : 'center',
        lineHeight: typeof item.line_height === 'number' && item.line_height > 0 ? item.line_height : 1.2,
      }))
    }
  }
  return { width: W, height: H, textLayers }
}

// ── Seedream Layerize import ─────────────────────────────────────────────────
// Convert the layers_json emitted by SeedreamLayerizeNode into Compositor image
// layers. Each layer's PNG lives in the input dir (referenced by `filename`);
// geometry follows the shared convention — x/y are normalized centers, w AND h
// normalize to WIDTH. A boxless layer (the base) fills the canvas. Ordered
// bottom→top by z. Schema sample:
//   { source: "seedream", width, height, layers: [{
//       filename, z_index, box: [left,top,right,bottom]|null, name, description }] }
export interface SeedreamImport { width: number; height: number; imageLayers: ImageLayer[] }

/** Convert a SeedreamLayerizeNode `layers_json` into Compositor image layers.
 *  Each layer's PNG lives in the input dir (referenced by `filename`); geometry
 *  follows the shared convention — x/y are normalized centers, w AND h normalize
 *  to WIDTH. A boxless layer (the base) fills the canvas. Ordered bottom→top by z. */
export function parseSeedreamLayers(json: string): SeedreamImport | null {
  let root: any
  try { root = JSON.parse(json) } catch { return null }
  const W = Number(root?.width), H = Number(root?.height)
  const raw: any[] = Array.isArray(root?.layers) ? root.layers : []
  if (!W || !H || !raw.length) return null
  const sorted = [...raw].sort((a, b) => (Number(a?.z_index) || 0) - (Number(b?.z_index) || 0))
  const imageLayers: ImageLayer[] = []
  for (const l of sorted) {
    const filename = String(l?.filename || '')
    if (!filename) continue
    const box = Array.isArray(l?.box) && l.box.length === 4 ? l.box.map(Number) : null
    let x = 0.5, y = 0.5, w = 1, h = H / W
    if (box) {
      const [left, top, right, bottom] = box
      x = ((left + right) / 2) / W
      y = ((top + bottom) / 2) / H
      w = (right - left) / W
      h = (bottom - top) / W        // width-normalized, per LayerCommon convention
    }
    imageLayers.push(createImageLayer(filename, 1, {
      x, y, w, h, opacity: 1, name: String(l?.name || '') || undefined,
    }))
  }
  if (!imageLayers.length) return null
  return { width: W, height: H, imageLayers }
}

// ── Factories ───────────────────────────────────────────────────────────────

export function createTextLayer(partial: Partial<TextLayer> = {}): TextLayer {
  return {
    id: newId(), kind: 'text',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    text: 'Double-click to edit',
    fontFamily: 'Inter', fontWeight: 700,
    fontSize: 0.08, color: '#ffffff', align: 'center', lineHeight: 1.2,
    strokeColor: '#000000', strokeWidth: 0,
    ...partial,
  }
}

export function createRectLayer(partial: Partial<RectLayer> = {}): RectLayer {
  return {
    id: newId(), kind: 'rect',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.3, h: 0.18, fill: '#3b82f6', stroke: '', strokeWidth: 0, radius: 0.02,
    ...partial,
  }
}

/**
 * A deal layer filling the whole frame by default. `grid` defaults to a generated
 * grid (so a fresh deal is non-empty); pass a deep-copied grid to seed it from the
 * frame's current layout. Both `w`/`h` are width-normalized: h defaults to a
 * square deal — the caller should set it to the frame aspect to fill the frame.
 */
export function createDealLayer(partial: Partial<DealLayer> = {}): DealLayer {
  const grid = partial.grid ?? { ...defaultGrid(), mode: 'generated' as const }
  return {
    id: newId(), kind: 'deal',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 1, h: 1,
    vocab: 'brand',
    density: 1,
    cellInset: 0,
    cellFill: 'solid',
    ...partial,
    grid,
  }
}

export function createEllipseLayer(partial: Partial<EllipseLayer> = {}): EllipseLayer {
  return {
    id: newId(), kind: 'ellipse',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.24, h: 0.24, fill: '#ef4444', stroke: '', strokeWidth: 0,
    ...partial,
  }
}

export function createPolygonLayer(partial: Partial<PolygonLayer> = {}): PolygonLayer {
  return {
    id: newId(), kind: 'polygon',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.24, h: 0.24, sides: 6, cornerRadius: 0,
    fill: '#3b82f6', stroke: '', strokeWidth: 0,
    ...partial,
  }
}
export function createStarLayer(partial: Partial<StarLayer> = {}): StarLayer {
  return {
    id: newId(), kind: 'star',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.24, h: 0.24, points: 5, innerRatio: 0.5, cornerRadius: 0,
    fill: '#f59e0b', stroke: '', strokeWidth: 0,
    ...partial,
  }
}

export function createLineLayer(partial: Partial<LineLayer> = {}): LineLayer {
  return {
    id: newId(), kind: 'line',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.4, stroke: '#ffffff', strokeWidth: 0.01,
    ...partial,
  }
}

export function createPathLayer(partial: Partial<PathLayer> = {}): PathLayer {
  return {
    id: newId(), kind: 'path',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    d: '', bbox: { w: 0.3, h: 0.3 }, scale: 1,
    fill: '#3b82f6', fillRule: 'nonzero', stroke: '', strokeWidth: 0,
    ...partial,
  }
}

/**
 * Convert a primitive shape (rect / ellipse / line) to an equivalent PathLayer
 * so it can take part in boolean ops, node editing, etc. Geometry is expressed
 * in the path local frame (centered on origin, units = canvas width), matching
 * the shape's own x/y/rotation. Returns the layer unchanged if already a path,
 * or null for kinds without a closed outline to convert (text / image).
 */
export function shapeToPathLayer(layer: LocalLayer): PathLayer | null {
  if (layer.kind === 'path') return layer
  const f = (v: number) => +v.toFixed(5)
  if (layer.kind === 'rect') {
    const { w, h } = layer
    const [tl, tr, br, bl] = cornerRadii(layer.radius, w, h)
    const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2
    // Square corners emit a plain line so a zero-radius rect keeps its old,
    // curve-free path data; a uniform radius reproduces the old string exactly.
    const d = (tl + tr + br + bl) <= 0
      ? `M ${f(x0)} ${f(y0)} L ${f(x1)} ${f(y0)} L ${f(x1)} ${f(y1)} L ${f(x0)} ${f(y1)} Z`
      : `M ${f(x0 + tl)} ${f(y0)} L ${f(x1 - tr)} ${f(y0)}` +
        (tr > 0 ? ` Q ${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + tr)}` : '') +
        ` L ${f(x1)} ${f(y1 - br)}` +
        (br > 0 ? ` Q ${f(x1)} ${f(y1)} ${f(x1 - br)} ${f(y1)}` : '') +
        ` L ${f(x0 + bl)} ${f(y1)}` +
        (bl > 0 ? ` Q ${f(x0)} ${f(y1)} ${f(x0)} ${f(y1 - bl)}` : '') +
        ` L ${f(x0)} ${f(y0 + tl)}` +
        (tl > 0 ? ` Q ${f(x0)} ${f(y0)} ${f(x0 + tl)} ${f(y0)}` : '') + ' Z'
    return createPathLayer({
      d, bbox: { w, h }, scale: 1, x: layer.x, y: layer.y, rotation: layer.rotation,
      opacity: layer.opacity, fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash,
    })
  }
  if (layer.kind === 'ellipse') {
    const rx = layer.w / 2, ry = layer.h / 2, k = 0.5522847498 // cubic circle constant
    const kx = rx * k, ky = ry * k
    const d = `M 0 ${f(-ry)} C ${f(kx)} ${f(-ry)} ${f(rx)} ${f(-ky)} ${f(rx)} 0` +
      ` C ${f(rx)} ${f(ky)} ${f(kx)} ${f(ry)} 0 ${f(ry)}` +
      ` C ${f(-kx)} ${f(ry)} ${f(-rx)} ${f(ky)} ${f(-rx)} 0` +
      ` C ${f(-rx)} ${f(-ky)} ${f(-kx)} ${f(-ry)} 0 ${f(-ry)} Z`
    return createPathLayer({
      d, bbox: { w: layer.w, h: layer.h }, scale: 1, x: layer.x, y: layer.y, rotation: layer.rotation,
      opacity: layer.opacity, fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash,
    })
  }
  if (layer.kind === 'line') {
    const w = layer.w
    return createPathLayer({
      d: `M ${f(-w / 2)} 0 L ${f(w / 2)} 0`, bbox: { w, h: Math.max(layer.strokeWidth, 0.001) },
      scale: 1, x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity,
      fill: 'none', stroke: layer.stroke, strokeWidth: layer.strokeWidth, strokeDash: layer.strokeDash,
    })
  }
  if (layer.kind === 'polygon') {
    const d = polygonPathData(layer.sides, layer.w, layer.h, layer.cornerRadius)
    if (!d) return null
    return createPathLayer({
      d, bbox: { w: layer.w, h: layer.h }, scale: 1,
      x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity,
      fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash,
    })
  }
  if (layer.kind === 'star') {
    const d = starPathData(layer.points, layer.innerRatio, layer.w, layer.h, layer.cornerRadius)
    if (!d) return null
    return createPathLayer({
      d, bbox: { w: layer.w, h: layer.h }, scale: 1,
      x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity,
      fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash,
    })
  }
  return null
}

/** Create an image layer. `aspect` (w/h) sizes the box so the image isn't
 *  distorted; defaults to a square. */
export function createImageLayer(filename: string, aspect = 1, partial: Partial<ImageLayer> = {}): ImageLayer {
  // Derive h from the *effective* width (a partial.w override included) so the
  // box keeps the image's aspect; partial can still override h explicitly.
  const w = partial.w ?? 0.6
  return {
    id: newId(), kind: 'image',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    filename, w, h: w / (aspect || 1),
    ...partial,
  }
}

export function createBrushLayer(partial: Partial<BrushLayer> = {}): BrushLayer {
  return {
    id: newId(), kind: 'brush',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 1, h: 1, strokes: [], fill: '#3b82f6', stroke: '', strokeWidth: 0,
    ...partial,
  }
}

// ── Image-layer asset loading ────────────────────────────────────────────────
const _imageCache = new Map<string, HTMLImageElement>()

/** Resolve an image layer's filename to a ComfyUI /view URL. */
export function imageLayerUrl(filename: string): string {
  return `/view?${new URLSearchParams({ filename, type: 'input' })}`
}

/** Every ImageFill `src` referenced by a layer's fill or stroke, de-duplicated.
 *  Drives the preload so the synchronous resolve arm has the bitmap in hand. */
export function collectFillImageSrcs(layers: LocalLayer[]): string[] {
  const out = new Set<string>()
  for (const l of layers) {
    for (const p of [(l as any).fill, (l as any).stroke]) {
      if (isImageFill(p) && p.src) out.add(p.src)
    }
  }
  return [...out]
}

/** Preload every image layer's bitmap into the module cache so the synchronous
 *  `drawLocalLayer` can paint it. Resolves once all are loaded (or errored). */
export async function ensureLayerImages(layers: LocalLayer[]): Promise<void> {
  if (typeof window === 'undefined') return
  const jobs: Promise<unknown>[] = []
  for (const layer of layers) {
    if (layer.kind !== 'image') continue
    const url = imageLayerUrl(layer.filename)
    if (_imageCache.get(url)?.complete) continue
    jobs.push(new Promise((res) => {
      const im = new Image()
      im.onload = () => { _imageCache.set(url, im); res(null) }
      im.onerror = () => res(null)
      im.src = url
    }))
  }
  jobs.push(ensureFillBitmaps(collectFillImageSrcs(layers)))
  if (jobs.length) await Promise.all(jobs)
}

// ── Rendering ─────────────────────────────────────────────────────────────--

// `hasPaint` / `resolvePaint` / `resolveFill` / `resolveShaderFill` (and the fill-tile
// cache + OBJECT_SHADER_FIELD_PX) now live in ~/lib/paint/resolve.ts, verbatim, so a
// second studio can use the same resolver instead of growing a near-copy. Behaviour is
// unchanged; the only difference is that the frame state below is passed IN explicitly
// rather than read off a module global inside the resolver.

// ── Shader fills on frame primitives (Task 6) ────────────────────────────────────
// The Compositor is its OWN shader-fill host: `withFieldFrame`'s live-field ceiling
// (see ~/lib/shaderfill/field.ts) and the frozen-field count it returns must be this
// frame's own, never pooled with an open Space Type/Shape Studio node — those are a
// DIFFERENT host with their own per-owner call in ~/lib/spacetype/fills.ts's
// refreshLiveShaderFills (Task 4's `withShaderFillContext` scheme). `paintLayerStack`
// (below) is the ONE place that calls `withFieldFrame`, once per synchronous pass,
// with every shader fill this frame's own layers + background actually carry — so as
// long as it never awaits mid-pass (it doesn't), no other host's span can land
// between it and the resolveField calls that consume its `liveKeys`.
//
// `_fieldCtx` is THIS host's frame state, threaded into every resolvePaint call below
// as the explicit `field` argument (see ~/lib/paint/resolve.ts's header for why it is
// no longer a global inside the resolver). Its `.base` field and the pattern-matrix
// reasoning that consumes it are documented on `ShaderFieldFrameCtx` over there; the
// capture points are here (before every `applyXform`, and before the background's own
// center translate).
let _fieldCtx: ShaderFieldFrameCtx = { frameW: 1, frameH: 1, t: 0, fps: 30, base: null, bake: false, token: 0 }

/** Draw an image with a fill (`tint`) blended over it, clipped to the image's
 *  alpha. Three passes in a centered offscreen: image → blend-fill tint → keep
 *  only where the image is opaque (destination-in). Then place it centered. */
function drawTintedImage(
  ctx: CanvasRenderingContext2D, img: CanvasImageSource, layer: ImageLayer, w: number, h: number,
): void {
  const tw = Math.max(1, Math.round(w)), th = Math.max(1, Math.round(h))
  const off = document.createElement('canvas'); off.width = tw; off.height = th
  const octx = off.getContext('2d')
  if (!octx) { ctx.drawImage(img, -w / 2, -h / 2, w, h); return }
  octx.translate(tw / 2, th / 2) // center, so resolvePaint's gradient/pattern geometry lines up
  octx.drawImage(img, -tw / 2, -th / 2, tw, th)
  octx.globalCompositeOperation = WIRED_BLEND_OP[layer.tintBlend ?? 'normal'] ?? 'source-over'
  octx.globalAlpha = Math.max(0, Math.min(1, layer.tintOpacity ?? 1))
  octx.fillStyle = resolvePaint(octx, layer.tint!, { w: tw, h: th }, _fieldCtx)
  octx.fillRect(-tw / 2, -th / 2, tw, th)
  octx.globalAlpha = 1
  octx.globalCompositeOperation = 'destination-in' // clip the tint back to the image silhouette
  octx.drawImage(img, -tw / 2, -th / 2, tw, th)
  ctx.drawImage(off, -w / 2, -h / 2, w, h)
}

/** Apply a layer's display-only case transform to a string. */
function transformCase(s: string, t: TextLayer['textTransform']): string {
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  if (t === 'capitalize') return s.replace(/\b\p{L}/gu, c => c.toUpperCase())
  return s
}

/** Split text into explicit-newline lines, applying any case transform so that
 *  measurement (wrap, box) and drawing operate on the same displayed glyphs. */
function textLines(layer: TextLayer): string[] {
  return transformCase(layer.text ?? '', layer.textTransform).split('\n')
}

/**
 * Final render lines: explicit newlines, then — when the layer has a text box
 * (`boxW`) — greedy word-wrap each line to fit the box. A word longer than the
 * box overflows on its own line rather than breaking mid-word. Needs a 2D
 * context for measurement; without one, falls back to explicit lines only.
 */
export function wrappedTextLines(ctx: CanvasRenderingContext2D | null, layer: TextLayer, W: number): string[] {
  const manual = textLines(layer)
  const boxPx = (layer.boxW ?? 0) * W
  if (!ctx || !(boxPx > 0)) return manual
  applyFont(ctx, layer, W)
  const out: string[] = []
  for (const line of manual) {
    const words = line.split(/\s+/).filter(Boolean)
    if (!words.length) { out.push(''); continue }
    let cur = words[0]
    for (let i = 1; i < words.length; i++) {
      const candidate = `${cur} ${words[i]}`
      if (ctx.measureText(candidate).width <= boxPx) cur = candidate
      else { out.push(cur); cur = words[i] }
    }
    out.push(cur)
  }
  return out
}

export function applyFont(ctx: CanvasRenderingContext2D, layer: TextLayer, W: number) {
  // A live `wght` axis drives the numeric weight in the `font` shorthand — the
  // one variable-axis path canvas honors on every browser (when a variable face
  // is loaded). Without this, an animated weight silently renders the static one.
  const wght = layer.axes?.wght
  const weight = wght != null && Number.isFinite(wght) ? Math.round(wght) : layer.fontWeight
  ctx.font = `${weight} ${layer.fontSize * W}px ${cssFontStack(layer.fontFamily)}`
  // Letter spacing (tracking). Canvas exposes `ctx.letterSpacing` as a CSS length
  // on modern browsers; `font` does NOT reset it, so we set it every time (0 when
  // unset) to avoid it leaking between layers. measureText honors it too, so wrap
  // and box math stay correct with no extra work.
  if ('letterSpacing' in ctx) {
    const tracking = Math.round((layer.letterSpacing || 0) * layer.fontSize * W * 1000) / 1000
    ;(ctx as unknown as { letterSpacing: string }).letterSpacing = `${tracking}px`
  }
  // Progressive enhancement: apply the FULL axis set (slnt/wdth/opsz/custom) via
  // fontVariationSettings, in the correct order (AFTER `font`, which resets it),
  // on browsers that expose the (non-standard) canvas property.
  if (layer.axes && 'fontVariationSettings' in ctx) {
    ;(ctx as unknown as { fontVariationSettings: string }).fontVariationSettings =
      axesToVariationSettings(layer.axes) || 'normal'
  }
}

function cssFontStack(family: string): string {
  // Quote families with spaces; keep a generic fallback so canvas always draws.
  const quoted = /\s/.test(family) ? `"${family}"` : family
  return `${quoted}, sans-serif`
}

/**
 * Bounding box of a layer in PIXELS (un-rotated), centered on origin.
 * For text this measures the rendered glyph block. A 2D context is required
 * for text measurement; pass any scratch context.
 */
export function localLayerBox(
  ctx: CanvasRenderingContext2D | null,
  layer: LocalLayer,
  W: number,
  H: number,
  // Pre-resolved wired content, threaded in by paintLayer so a single paint call
  // resolves the provider once and reuses it for both box-sizing and drawing (see
  // `wiredLive` there). `undefined` (the default) means "not supplied — resolve it
  // here"; every caller outside paintLayer (editors, selection, hit-testing) omits
  // this and gets that own-resolve behavior, each on its own separate frame, which
  // is fine. `null` is a valid resolved value (no drawable content this frame) and
  // must NOT trigger a second resolve.
  wiredLive?: WiredLive | null,
): { w: number; h: number } {
  if (layer.kind === 'text') {
    const lines = wrappedTextLines(ctx, layer, W)
    const lineH = layer.fontSize * W * layer.lineHeight
    // With a text box, the box width IS the layer width (selection/handles
    // track the box, not the glyph extents).
    if ((layer.boxW ?? 0) > 0) {
      return { w: Math.max(layer.boxW! * W, 4), h: Math.max(lines.length * lineH, lineH) }
    }
    let maxW = 0
    if (ctx) {
      applyFont(ctx, layer, W)
      for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln || ' ').width)
    } else {
      // Rough fallback without measurement.
      maxW = Math.max(...lines.map(l => (l.length || 1))) * layer.fontSize * W * 0.6
    }
    return { w: Math.max(maxW, 4), h: Math.max(lines.length * lineH, lineH) }
  }
  if (layer.kind === 'line') {
    return { w: layer.w * W, h: Math.max(layer.strokeWidth * W, 6) }
  }
  if (layer.kind === 'path') {
    const s = (layer.scale || 1) * W
    return { w: Math.max(layer.bbox.w * s, 4), h: Math.max(layer.bbox.h * s, 4) }
  }
  if (layer.kind === 'brush') {
    // Size the selection box from the painted bounds LIVE, so it hugs the marks
    // regardless of the layer's stored w/h (which may be stale full-frame values).
    // The box is centred at the layer's x/y, which is exactly where the render
    // centres the strokes' bounds — so it wraps the rendered marks precisely.
    // Uniform "keep proportions" resize: the stored `w` drives a scale of the
    // strokes' NATURAL width, and the height rides that same scale — so handles +
    // hit-testing match the scaled render. At paint-commit `w == naturalW`, so
    // scale === 1 and this box is byte-identical to the un-resized bounds.
    const b = strokeBounds((layer as BrushLayer).strokes)
    const nw = b.maxX - b.minX, nh = b.maxY - b.minY
    const scale = nw > 1e-6 ? (layer as BrushLayer).w / nw : 1
    return { w: Math.max(4, nw * scale * W), h: Math.max(4, nh * scale * W) }
  }
  if (layer.kind === 'wired') {
    // A wired layer has no stored `h` (the height follows the content aspect), so
    // it must NOT fall through to the generic `w × h` return below — that reads an
    // absent property and yields a NaN box, which silently breaks selection,
    // corner-pin and every other consumer of this function. Resolved from the SAME
    // live content the draw uses, so the box always hugs what actually paints.
    // `w <= 0` is the migration's UNRESOLVED_WIRED_W sentinel (content size not
    // known yet) — a zero-size box at the layer centre, not `wiredBoxPx`'s
    // negative-width result, so selection/handles/hit-testing see "nothing here"
    // instead of a flipped, wrong-sized box.
    if (layer.w <= 0) return { w: 0, h: 0 }
    return wiredBoxPx(layer, W, wiredLive !== undefined ? wiredLive : wiredContent(layer))
  }
  return { w: (layer as RectLayer).w * W, h: (layer as RectLayer).h * W }
}

/**
 * How far an OUTSIDE-aligned stroke reaches beyond `localLayerBox`, in px — the
 * padding a corner-pin (or any other box-sized) offscreen needs so that stroke
 * survives instead of landing entirely off-canvas and getting clipped away (see
 * `strokeAligned`'s 'outside' knockout, which paints the whole 2×width ring
 * starting AT the silhouette edge — none of it is inside the box).
 *
 * 0 for every other case (no stroke, center, inside, or a kind without
 * `strokeAlign` at all) — callers that add this unconditionally to a box's
 * half-extent stay byte-identical to before when it's 0.
 */
export function outsideStrokePadPx(layer: LocalLayer, W: number): number {
  if (layer.kind !== 'rect' && layer.kind !== 'ellipse' && layer.kind !== 'polygon' && layer.kind !== 'star' && layer.kind !== 'path') return 0
  const l = layer
  if (!hasPaint(l.stroke) || !(l.strokeWidth > 0)) return 0
  if (strokeAlignOf(l.strokeAlign) !== 'outside') return 0
  // A path's strokeWidth is stored in local units AT scale=1 (see PathLayer),
  // so its px extent also carries the layer's own uniform scale; every other
  // stroked kind stores strokeWidth already normalized to canvas width.
  const scale = l.kind === 'path' ? (l.scale ?? 1) : 1
  return l.strokeWidth * scale * W
}

/**
 * Fit a layer box (px, `boxW`×`boxH`) into a `size`×`size` square, preserving
 * aspect and never upscaling past `size`. Returns integer canvas dims ≥ 1 so the
 * result is always a valid <canvas> size. Pure — the testable seam of the layer
 * thumbnail (see `renderLayerThumbnail`).
 */
export function thumbBox(boxW: number, boxH: number, size: number): { w: number; h: number } {
  const bw = Math.max(1e-6, boxW), bh = Math.max(1e-6, boxH)
  const s = Math.min(size / bw, size / bh)
  return { w: Math.max(1, Math.round(bw * s)), h: Math.max(1, Math.round(bh * s)) }
}

/**
 * Render ONE layer's content into a small offscreen canvas fitted to `size` px,
 * transparent background, unrotated and stripped of its frame position — a
 * layer-list thumbnail. Reuses the SAME per-layer content draw the stack uses
 * (`drawLayerContent`), so the thumb agrees with the real render by construction;
 * the corner-pin path builds its offscreen the identical way (translate to the
 * box centre, then draw the origin-centred content).
 *
 * Wired layers draw their live slot pixels via the ambient `withWiredContent`
 * provider — the caller MUST install it (both the box measure and the draw resolve
 * through it). A layer with no drawable box (an unresolved/empty wired slot) yields
 * null so the row falls back to its kind icon. Text fonts / image bitmaps must be
 * loaded first (`ensureLayerFonts` / `ensureLayerImages`) or the content draws its
 * own faint placeholder — the caller re-renders once they resolve.
 */
export function renderLayerThumbnail(layer: LocalLayer, size: number, dpr = 1): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  // A square reference frame: every kind normalizes its box to the WIDTH (text
  // height included, via lineH = fontSize·W·lineHeight), so the box aspect is
  // independent of the real frame's aspect — a square ref keeps the math simple.
  const REF = 512
  const box = localLayerBox(measureCtx(), layer, REF, REF)
  if (!(box.w > 0) || !(box.h > 0)) return null
  const fit = thumbBox(box.w, box.h, size)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(fit.w * dpr))
  canvas.height = Math.max(1, Math.round(fit.h * dpr))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const scale = (canvas.width / box.w) // maps the box's px extent onto the (dpr-scaled) canvas
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.scale(scale, scale)
  try { drawLayerContent(ctx, layer, REF) } catch { return null }
  return canvas
}

/** Draw a single local layer onto a 2D context sized W×H. */
// Clip the context to a layer's mask region (canvas space). Caller wraps this in
// save()/restore(). No-op shape support beyond rect/ellipse for now.
function applyMaskClip(ctx: CanvasRenderingContext2D, mask: LayerMask, W: number, H: number) {
  const cx = mask.x * W, cy = mask.y * H, w = Math.max(0, mask.w * W), h = Math.max(0, mask.h * W)
  ctx.beginPath()
  if (mask.kind === 'ellipse') ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2)
  else ctx.rect(cx - w / 2, cy - h / 2, w, h)
  ctx.clip()
}

export function drawLocalLayer(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  W: number,
  H: number,
  maskLayer?: LocalLayer | null,
  opacityMul = 1,
) {
  // Layer mask: clip this layer to another layer's alpha silhouette (Figma
  // "use as mask"). Render the content, then keep only where the mask layer's
  // alpha is, via destination-in on an offscreen.
  if (maskLayer) {
    // Offscreens are sized to the DEVICE canvas and rendered through the current
    // transform, so a masked layer stays sharp under any ctx scale (dpr preview,
    // or a high-res export that scales logical W×H up). Sizing to logical W×H
    // would composite at preview resolution and then upscale → blur.
    const t = ctx.getTransform()
    const dev = ctx.canvas
    const mk = () => {
      const c = document.createElement('canvas')
      c.width = Math.max(1, dev.width); c.height = Math.max(1, dev.height)
      return c
    }
    const off = mk()
    const octx = off.getContext('2d')
    if (octx) {
      octx.setTransform(t)
      drawLocalLayerSelf(octx, layer, W, H, opacityMul)
      // The mask must be rendered on its OWN offscreen and composited with
      // drawImage: paintLayer (inside drawLocalLayerSelf) sets
      // globalCompositeOperation itself, which would silently overwrite a
      // destination-in set here and paint the mask instead of clipping with it.
      const maskOff = mk()
      const mctx = maskOff.getContext('2d')
      if (mctx) {
        mctx.setTransform(t)
        drawLocalLayerSelf(mctx, maskLayer, W, H)
        paintMaskRelease(mctx, layer.maskBreak, W, H)
        octx.setTransform(1, 0, 0, 1, 0, 0) // composite in device space
        octx.globalCompositeOperation = 'destination-in'
        octx.drawImage(maskOff, 0, 0)
        octx.globalCompositeOperation = 'source-over'
      }
      // The layer's blend mode applies at the final composite against the real
      // backdrop (inside the offscreen it blends against transparency = no-op).
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0) // device-space stamp
      ctx.globalCompositeOperation = localBlendOp(layer)
      ctx.drawImage(off, 0, 0)
      ctx.restore()
      return
    }
  }
  drawLocalLayerSelf(ctx, layer, W, H, opacityMul)
}

/**
 * Render an item's alpha silhouette (full opacity, no effects/blend) onto `ctx`,
 * sized W×H. Used as the clip source for another item's mask. Wired items render
 * via their draw closure; local items via their own paint (no nested mask).
 *
 * RESERVED FOR PHASE 2 (submit-time mask compile → layer{i}_mask PNG): the live
 * renderer's mask path uses drawItemContent (real paint), not this silhouette.
 */
export function drawLayerSilhouette(ctx: CanvasRenderingContext2D, item: StackItem, W: number, H: number) {
  if (item.type === 'wired') {
    ctx.save()
    item.draw(ctx, W, H)
    ctx.restore()
    return
  }
  const ghost = { ...item.layer, opacity: 1, effects: undefined, blend: undefined } as LocalLayer
  drawLocalLayerSelf(ctx, ghost, W, H)
}

// True when a layer carries a freehand visibility mask (brush "Mask mode").
function hasStrokeMask(layer: LocalLayer): boolean {
  return (layer.maskStrokes?.length ?? 0) > 0 || layer.maskBase === 'hidden'
}

// A layer's own paint, including its crop (rect/ellipse) region — but NOT any
// stroke mask (applied around this by drawLocalLayerSelf) or layer-mask (applied
// by drawLocalLayer).
function paintLayerCropped(ctx: CanvasRenderingContext2D, layer: LocalLayer, W: number, H: number, opacityMul: number) {
  if (layer.mask) {
    ctx.save()
    applyMaskClip(ctx, layer.mask, W, H)
    paintLayer(ctx, layer, W, H, opacityMul)
    ctx.restore()
  } else {
    paintLayer(ctx, layer, W, H, opacityMul)
  }
}

/**
 * Clip a layer's already-rendered pixels to its freehand visibility mask
 * (`maskStrokes` + `maskBase`), applied `destination-in`. `ctx` holds the
 * layer's pixels rendered through the current transform `t` on a device-sized
 * offscreen; the mask is built on its OWN device-sized offscreen through the
 * SAME `t` (so a stroke normalized to the artboard lands on the same device
 * pixels as the layer), then composited in device space. Mirrors the
 * drawLocalLayer / drawItemMasked layer-mask recipe exactly.
 *
 * Semantics ("brush HIDES, eraser RESTORES" — the inverse of a paint layer, so a
 * mask stroke reads oppositely to a paint stroke): base 'visible' → fill white
 * (fully shown), then a PLAIN stroke carves a hole (destination-out, hides the
 * layer) and an ERASE stroke paints white back (restores visibility). This is
 * achieved by flipping each stroke's `erase` flag before stampStrokes, whose
 * carve/paint logic then does exactly that. base 'hidden' (not surfaced in v1) →
 * start transparent, plain strokes paint white (reveal) — normal stampStrokes.
 */
function applyStrokeMask(ctx: CanvasRenderingContext2D, layer: LocalLayer, W: number, H: number) {
  const t = ctx.getTransform()
  const dev = ctx.canvas
  const mask = document.createElement('canvas')
  mask.width = Math.max(1, dev.width); mask.height = Math.max(1, dev.height)
  const mctx = mask.getContext('2d')
  if (!mctx) return
  const strokes = layer.maskStrokes ?? []
  const visibleBase = (layer.maskBase ?? 'visible') === 'visible'
  // Base fill = "visible everywhere". It covers the WHOLE device buffer and is NOT
  // part of the layer's local frame, so it is stamped in raw device space — never
  // through the layer transform (which would place a W×H rect at the layer center).
  if (visibleBase) {
    mctx.setTransform(1, 0, 0, 1, 0, 0)
    mctx.fillStyle = '#fff'
    mctx.fillRect(0, 0, mask.width, mask.height)
  }
  // Strokes are stored in the layer's LOCAL frame (see maskStrokeToLocal): replay
  // the layer's own translate+rotate — the SAME transform paintLayer's applyXform
  // applies to the content — so the mask tracks the layer under move/rotate. `base
  // = W`: strokes are width-normalized (W px in this transform space).
  mctx.setTransform(t)
  mctx.translate((layer.x ?? 0.5) * W, (layer.y ?? 0.5) * H)
  if (layer.rotation) mctx.rotate((layer.rotation * Math.PI) / 180)
  if (visibleBase) {
    // A plain brush stroke carves a hole (hide) and an eraser stroke paints white
    // back (restore). Invert `erase` so stampStrokes' destination-out carve fires
    // for plain strokes and its white paint for erase.
    const inverted = strokes.map(s => ({ ...s, erase: !s.erase }))
    stampStrokes(mctx, inverted, W)
  } else {
    // base 'hidden': start transparent, plain strokes reveal (paint white).
    stampStrokes(mctx, strokes, W)
  }
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0) // device space — matches the layer's pixels
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(mask, 0, 0)
  ctx.restore()
}

// A layer's own paint including its crop AND its freehand stroke mask — but NOT
// any layer-mask, which drawLocalLayer applies around this.
function drawLocalLayerSelf(ctx: CanvasRenderingContext2D, layer: LocalLayer, W: number, H: number, opacityMul = 1) {
  if (!hasStrokeMask(layer)) {
    paintLayerCropped(ctx, layer, W, H, opacityMul)
    return
  }
  // Stroke mask: isolate the layer on a device-sized offscreen so destination-in
  // clips ONLY this layer (not the shared context), apply the mask, then stamp
  // back with the layer's blend (a no-op inside the transparent offscreen, so it
  // takes effect here against the real backdrop). Same recipe as the layer-mask.
  const t = ctx.getTransform()
  const dev = ctx.canvas
  const off = document.createElement('canvas')
  off.width = Math.max(1, dev.width); off.height = Math.max(1, dev.height)
  const octx = off.getContext('2d')
  if (!octx) { paintLayerCropped(ctx, layer, W, H, opacityMul); return }
  octx.setTransform(t)
  paintLayerCropped(octx, layer, W, H, opacityMul)
  applyStrokeMask(octx, layer, W, H)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0) // device-space stamp
  ctx.globalCompositeOperation = localBlendOp(layer)
  ctx.drawImage(off, 0, 0)
  ctx.restore()
}

/** A local layer's blend mode → canvas composite op ('normal' = source-over). */
export function localBlendOp(layer: { blend?: string }): GlobalCompositeOperation {
  return WIRED_BLEND_OP[layer.blend ?? 'normal'] ?? 'source-over'
}

// Composite an inner shadow INTO a rendered layer offscreen. Standard recipe:
// take the inverse of the content alpha, draw it with canvas shadow params (the
// shadow spills inward across the silhouette edge), keep only the part inside
// the content (destination-in), then stamp that over the content.
function compositeInnerShadow(off: HTMLCanvasElement, fx: InnerShadowEffect, W: number, scale = 1) {
  const mk = () => {
    const c = document.createElement('canvas')
    c.width = off.width; c.height = off.height
    return c
  }
  const inv = mk()
  const ictx = inv.getContext('2d')
  const sh = mk()
  const sctx = sh.getContext('2d')
  if (!ictx || !sctx) return
  ictx.fillStyle = '#000'
  ictx.fillRect(0, 0, inv.width, inv.height)
  ictx.globalCompositeOperation = 'destination-out'
  ictx.drawImage(off, 0, 0)
  sctx.shadowColor = fx.color
  sctx.shadowBlur = Math.max(0, fx.blur * W * scale)
  sctx.shadowOffsetX = fx.x * W * scale
  sctx.shadowOffsetY = fx.y * W * scale
  sctx.drawImage(inv, 0, 0)
  sctx.shadowColor = 'transparent'
  sctx.globalCompositeOperation = 'destination-in'
  sctx.drawImage(off, 0, 0)
  // off's context still carries the layer's translate/rotate from the content
  // draw — stamp the shadow in identity space or it lands displaced.
  const octx = off.getContext('2d')
  if (octx) {
    octx.save()
    octx.setTransform(1, 0, 0, 1, 0, 0)
    octx.drawImage(sh, 0, 0)
    octx.restore()
  }
}

// ── Silhouette raster cache (torn edge + feather) ────────────────────────────
// Both effects are per-pixel CPU passes over the layer's rasterized alpha, and
// paintLayer used to re-run them on every repaint — so dragging a torn-edge layer
// re-tore the whole device-resolution bitmap on every pointer move although only
// x/y had changed. Bake the layer's own local box once, keyed on everything that
// changes its pixels, and later repaints just stamp that raster (see paintLayer).
// Bounded by BOTH a count cap and a byte budget: the values are device-resolution
// canvases, so a count alone would let this module-global cache reach hundreds of MB
// (24 full-screen retina rasters). 4 bytes per device px is the backing store's size.
const _silhouetteCache = new LruCache<HTMLCanvasElement>(SILHOUETTE_CACHE_CAP, {
  sizeOf: c => c.width * c.height * 4,
  maxBytes: SILHOUETTE_CACHE_MAX_BYTES,
})

/** Whether a text layer's REAL font face is loaded. A fallback-font render must
 *  never be baked: the cache key can't see that the font arrived later, so the
 *  wrong glyphs would stick. Same spec string `ensureLayerFonts` loads. */
function textFontReady(layer: TextLayer, W: number): boolean {
  try {
    const fonts = typeof document !== 'undefined' ? (document as any).fonts : null
    if (!fonts) return true
    return !!fonts.check(`${layer.fontWeight} ${Math.max(8, layer.fontSize * W)}px ${cssFontStack(layer.fontFamily)}`)
  } catch { return true }
}

/** Whether everything this layer draws with is actually in hand. Image layers and
 *  image fills paint a placeholder until their bitmap decodes, and fonts fall back
 *  until they load — none of that is visible to the cache key, so baking one would
 *  freeze the placeholder for as long as nothing else about the layer changes.
 *  DOM/cache lookups happen here; the actual three-way rule is the pure
 *  `silhouetteContentReadyPure` in silhouetteCache.ts (CPU-only, unit-tested). */
function silhouetteContentReady(layer: LocalLayer, W: number): boolean {
  const font = layer.kind !== 'text' || textFontReady(layer, W)
  let image = true
  if (layer.kind === 'image') {
    const img = _imageCache.get(imageLayerUrl(layer.filename))
    image = !!img && img.complete && !!img.naturalWidth
  }
  const fillBitmaps = !layerPaints(layer).some(p => isImageFill(p) && p.src && !getFillBitmap(p.src))
  return silhouetteContentReadyPure(layer.kind, { font, image, fillBitmaps })
}

/** Padding (logical px) around `localLayerBox` for a baked silhouette raster. Resolves
 *  the layer down to primitives (kind, real stroke alignment, and the font size / stroke
 *  width / height box already scaled to logical px by W) plus the box `localLayerBox`
 *  actually measured, then defers to the pure `silhouettePadPxPure` in silhouetteCache.ts
 *  for the arithmetic (raster margin + ink overhang).
 *
 *  NOT `outsideStrokePadPx`: that answers a narrower question for the corner-pin
 *  offscreen and is 0 for the DEFAULT 'center' alignment, whose ink still reaches half a
 *  stroke width past the box — padding by it alone clipped the outer half of every
 *  default stroke out of the cached raster. `strokeWidth` is guarded (`|| 0`) so a
 *  missing/NaN value can never make `bwD` NaN downstream. */
function silhouettePadPx(layer: LocalLayer, W: number, s: number, box: { w: number; h: number }): number {
  const l = layer as unknown as { strokeWidth?: number; strokeAlign?: unknown; stroke?: Paint; scale?: number; fontSize?: number; boxH?: number }
  const width = Math.max(0, l.strokeWidth || 0)
  let strokePx = 0
  let strokeAlign: StrokeAlign = 'center'
  if (layer.kind === 'text') {
    strokePx = width * W
  } else if (layer.kind === 'line') {
    // drawLayerContent floors a line's lineWidth at 1px, so a hairline still caps.
    strokePx = Math.max(1, width * W)
  } else if (layer.kind === 'rect' || layer.kind === 'ellipse' || layer.kind === 'polygon' || layer.kind === 'star' || layer.kind === 'path') {
    // A path's strokeWidth is stored in local units AT scale=1 (see PathLayer), so its
    // px extent carries the layer's own uniform scale — same correction outsideStrokePadPx makes.
    if (hasPaint(l.stroke)) strokePx = width * (layer.kind === 'path' ? (l.scale ?? 1) : 1) * W
    strokeAlign = strokeAlignOf(l.strokeAlign)
  }
  const isText = layer.kind === 'text'
  // The widest of wrappedTextLines' lines, measured with the SAME font drawText uses —
  // this is what catches a single word/URL wider than a fixed boxW (wrappedTextLines
  // only breaks on whitespace), which localLayerBox's boxW branch doesn't reflect.
  let maxLineWPx = 0
  if (isText) {
    const mctx = measureCtx()
    if (mctx) {
      applyFont(mctx, layer as TextLayer, W)
      for (const ln of wrappedTextLines(mctx, layer as TextLayer, W)) maxLineWPx = Math.max(maxLineWPx, mctx.measureText(ln || ' ').width)
    }
  }
  return silhouettePadPxPure({
    kind: layer.kind,
    strokeAlign,
    strokePx,
    fontPx: isText ? Math.max(0, l.fontSize || 0) * W : 0,
    boxHPx: isText ? Math.max(0, l.boxH || 0) * W : 0,
    boxHeightPx: box.h,
    maxLineWPx,
    boxWidthPx: box.w,
  }, s)
}

function paintLayer(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  W: number,
  H: number,
  opacityMul = 1,
) {
  const baseOpacity = Math.max(0, Math.min(1, layer.opacity * opacityMul))
  const blendOp = localBlendOp(layer)
  // Resolve the wired provider (if any) exactly ONCE for this whole paint call, and
  // thread that single result through both box-sizing (localLayerBox, for corner-pin
  // and DOF offscreens) and the actual draw (drawLayerContent) below — including
  // across every clone. Calling the provider twice per clone (once to size, once to
  // draw) risked a provider that hands back a fresh surface each call sizing the
  // offscreen from one call and drawing a differently-sized one into it, producing a
  // misfit warp. `wiredLive` stays `undefined` for non-wired layers, so the callees'
  // own-resolve fallback (used by callers outside paintLayer) never triggers here.
  const wiredLive: WiredLive | null | undefined = layer.kind === 'wired' ? wiredContent(layer as WiredLayer) : undefined
  const fx = (layer.effects ?? []).filter(e => e.visible)
  const shadow = fx.find((e): e is DropShadowEffect => e.type === 'drop_shadow')
  const blur = fx.find((e): e is LayerBlurEffect => e.type === 'layer_blur')
  const inner = fx.find((e): e is InnerShadowEffect => e.type === 'inner_shadow')
  const chain = fx.filter(isChainEffect)
  const tornEdge = tornEdgeActive(layer.tornEdge) ? layer.tornEdge : undefined
  const feather = featherActive(layer.feather) ? layer.feather : undefined
  // Content layers with a depth map only — nothing else has one to drive the blur.
  // An uploaded image keys depth by its `filename`; a WIRED layer keys it by the
  // host-supplied `depthKey` (the upstream `/view` URL). Both resolve through the
  // same depth registry, so a wired slot and an uploaded copy of the same picture
  // defocus identically — a gap between them reads as a bug (and losing it here is
  // what would have silently dropped DOF from every migrated frame).
  const dofRef: DepthRef | null | undefined = layer.kind === 'image'
    ? (layer as ImageLayer).filename
    : layer.kind === 'wired' ? depthSourceFromViewUrl((layer as WiredLayer).depthKey) : undefined
  const dof = dofRef ? fx.find((e): e is DofEffect => e.type === 'dof') : undefined
  // (background_blur is a stack-level effect — paintLayerStack applies it
  // against the backdrop before this layer paints.)

  // Slant (affine shear) + corner-pin (projective warp). Both fold into the per-clone
  // local transform / content draw, so absent ⇒ byte-identical to before.
  const skx = layer.skewX || 0, sky = layer.skewY || 0
  const hasSkew = skx !== 0 || sky !== 0
  const shearA = hasSkew ? Math.tan((sky * Math.PI) / 180) : 0
  const shearC = hasSkew ? Math.tan((skx * Math.PI) / 180) : 0
  const cp = cornerPinActive(layer.cornerPin) ? layer.cornerPin : null

  // Silhouette raster cache (see `_silhouetteCache`): only cases whose LOCAL BOX is a
  // faithful, self-contained render of the layer qualify — everything else keeps the
  // old full-canvas path, byte-identical.
  const silhouetteCacheable = !!(tornEdge || feather)
    && layer.kind !== 'wired'                                       // graph pixels change under us — no content signature
    && !cp && !dof                                                  // corner-pin / DOF have their own offscreen flows
    && !inner && !chain.length                                      // inner shadow + chain effects (bloom!) spread past the box
    && !(layer.kind === 'text' && layer.expressive)                 // expressive layout places words outside localLayerBox
    && !layerPaints(layer).some(p => isFill(p) && fillIsShader(p))  // shader fills are live / frame-anchored
    && silhouetteContentReady(layer, W)
  // Memoized like `dofContent` below: identical for every clone, and the key is a
  // stringify of the layer, so it must not be rebuilt once per stamp.
  let silhouetteMemo: { canvas: HTMLCanvasElement; w: number; h: number } | null | undefined
  const silhouetteRaster = (s: number): { canvas: HTMLCanvasElement; w: number; h: number } | null => {
    if (silhouetteMemo !== undefined) return silhouetteMemo
    silhouetteMemo = null
    if (!silhouetteCacheable) return silhouetteMemo
    const box = localLayerBox(measureCtx(), layer, W, H, wiredLive)
    const pad = silhouettePadPx(layer, W, s, box)
    const bwL = box.w + pad * 2, bhL = box.h + pad * 2                                     // logical px
    const bwD = Math.max(1, Math.round(bwL * s)), bhD = Math.max(1, Math.round(bhL * s))   // device px
    // The LOGICAL size the caller stamps at, derived BACK from the rounded device
    // size rather than from bwL/bhL: drawn under scale `s` this lands on exactly
    // bwD × bhD device px, so the raster resamples not at all. Using bwL directly
    // would ask for `bwL * s` device px out of a `bwD`-wide bitmap — up to half a
    // pixel of resampling on every stamp, for nothing.
    const bwLx = bwD / s, bhLx = bhD / s
    // Past these caps `getContext('2d')` isn't guaranteed to return null on an
    // oversized canvas (some engines hand back a context over a blank backing
    // store instead), so an unbounded bwD/bhD could silently cache emptiness for
    // a huge layer. Bail to the uncached path — same as a null context below.
    if (!silhouetteRasterFits(bwD, bhD)) return silhouetteMemo
    const key = silhouetteCacheKey(layer as unknown as Record<string, unknown>, s, bwD, bhD, W)
    const hit = _silhouetteCache.get(key)
    if (hit) { silhouetteMemo = { canvas: hit, w: bwLx, h: bhLx }; return silhouetteMemo }
    const cc = document.createElement('canvas'); cc.width = bwD; cc.height = bhD
    const cctx = cc.getContext('2d')
    if (!cctx) return silhouetteMemo   // no raster ⇒ the caller takes the uncached path
    cctx.setTransform(s, 0, 0, s, bwD / 2, bhD / 2)   // centred, at device scale — the geometry drawLayerContent expects
    drawLayerContent(cctx, layer, W, wiredLive)
    if (tornEdge) applyTornEdge(cc, tornEdge, { scale: s })
    if (feather) applyFeather(cc, feather)
    _silhouetteCache.set(key, cc)
    silhouetteMemo = { canvas: cc, w: bwLx, h: bhLx }
    return silhouetteMemo
  }
  const applyXform = (c: CanvasRenderingContext2D, lx2: number, ly2: number, lrot2: number, ls2: number) => {
    c.translate(lx2 * W, ly2 * H)
    if (lrot2) c.rotate((lrot2 * Math.PI) / 180)
    if (hasSkew) c.transform(1, shearA, shearC, 1, 0, 0)
    if (ls2 !== 1) c.scale(ls2, ls2)
  }
  // No corner-pin ⇒ draw content directly. With it: render content to a box-sized
  // offscreen (centered, like the normal draw), then projectively warp that box onto
  // the corner-pin quad in local space.
  // Depth of field runs on the GPU (postEffects' 2D chain cannot do a variable-radius
  // shaped blur), so it renders the layer's content to an offscreen and hands back a
  // canvas. null ⇒ off, unavailable, or depth not ready yet — every caller falls back
  // to the normal draw, so a layer ALWAYS renders.
  //
  // Memoized because expandClones calls drawContent once per clone and the DOF result
  // is identical for all of them. The result is copied out of the pass's canvas, which
  // is reused between calls — holding a reference to it would alias.
  let dofMemo: HTMLCanvasElement | null | undefined
  const dofContent = (): HTMLCanvasElement | null => {
    if (dofMemo !== undefined) return dofMemo
    dofMemo = null
    if (!dof || !dofAvailable()) return dofMemo

    const depth = depthImageFor(dofRef!)
    if (!depth) { requestDepth(dofRef!); return dofMemo }
    if (!dofShouldRun(dof, true)) return dofMemo

    const box = localLayerBox(measureCtx(), layer, W, H, wiredLive)
    const bw = Math.max(1, Math.round(box.w)), bh = Math.max(1, Math.round(box.h))
    const src = document.createElement('canvas'); src.width = bw; src.height = bh
    const sctx = src.getContext('2d')
    if (!sctx) return dofMemo
    sctx.translate(bw / 2, bh / 2)
    drawLayerContent(sctx, layer, W, wiredLive)

    const out = applyDof(src, depth, dof, W, bw, bh)
    if (!out) return dofMemo

    const owned = document.createElement('canvas'); owned.width = bw; owned.height = bh
    owned.getContext('2d')?.drawImage(out, 0, 0)
    dofMemo = owned
    return dofMemo
  }

  const drawContent = (c: CanvasRenderingContext2D) => {
    const dofCanvas = dofContent()
    if (!cp) {
      if (dofCanvas) {
        c.drawImage(dofCanvas, -dofCanvas.width / 2, -dofCanvas.height / 2)
        return
      }
      drawLayerContent(c, layer, W, wiredLive); return
    }
    const box = localLayerBox(measureCtx(), layer, W, H, wiredLive)
    // Outside-aligned strokes paint entirely beyond localLayerBox's plain w×h
    // (see outsideStrokePadPx) and would be 100% clipped by this offscreen's
    // edges otherwise. Pad it — and grow the quad it warps into by the same
    // amount, keeping the shape centered — so the stroke survives the pin. 0
    // for every other case (no stroke, center, inside) keeps this identical to
    // before: same bw/bh, same quad. Skipped when DOF already produced the
    // source canvas (dofCanvas is used as-is, unpadded — a rarer combination
    // left as a pre-existing gap, not what this fix targets).
    const pad = dofCanvas ? 0 : outsideStrokePadPx(layer, W)
    const bw = Math.max(1, Math.round(box.w + pad * 2)), bh = Math.max(1, Math.round(box.h + pad * 2))
    // Corner-pin warps whatever the content is — including the defocused version, so
    // the two effects compose instead of one silently winning.
    let cc: HTMLCanvasElement
    if (dofCanvas) {
      cc = dofCanvas
    } else {
      cc = document.createElement('canvas'); cc.width = bw; cc.height = bh
      const cctx = cc.getContext('2d')
      if (!cctx) { drawLayerContent(c, layer, W, wiredLive); return }
      cctx.translate(bw / 2, bh / 2)
      drawLayerContent(cctx, layer, W, wiredLive)
    }
    const hw = box.w / 2 + pad, hh = box.h / 2 + pad
    const quad: Quad = [
      { x: -hw + cp.tl.x * hw, y: -hh + cp.tl.y * hh },
      { x:  hw + cp.tr.x * hw, y: -hh + cp.tr.y * hh },
      { x:  hw + cp.br.x * hw, y:  hh + cp.br.y * hh },
      { x: -hw + cp.bl.x * hw, y:  hh + cp.bl.y * hh },
    ]
    drawQuadWarp(c, cc, quad, 16)
  }

  // Linked cloner: paint once per clone (back-to-front; original last). No
  // cloner ⇒ a single identity transform ⇒ one paint exactly as before. Falloff
  // offset/rotation/scale fold into the layer's own translate/rotate/scale so
  // the rotation+scale pivot stays the layer center.
  for (const c of expandClones(layer.cloner, W / H)) {
    const lx = layer.x + c.dx
    const ly = layer.y + c.dy
    const lrot = layer.rotation + c.drot
    const lop = baseOpacity * c.dopacity
    const ls = c.dscale

    // Effected path: render the layer to an offscreen at canvas size, then
    // composite it with inner shadow / drop shadow / blur. Works identically for
    // text, shapes, vectors and images, and because bakeOverlay() renders through
    // here the effects are baked into generation exactly as previewed.
    if (shadow || blur || inner || chain.length || tornEdge || feather) {
      // Size the offscreen to the DEVICE canvas and render it through the current
      // transform `t`, exactly like the mask path (drawLocalLayer) and the brush
      // path do. Sizing to logical W×H instead would rasterize the layer at preview
      // resolution and then upscale it to the device canvas on the stamp below —
      // visibly softening any layer that carries an effect (a gradient map is the
      // most obvious, since it preserves detail rather than blurring it away). On a
      // dpr=1 display (t.a === 1, device === logical) this is byte-identical to the
      // old logical-sized path.
      const t = ctx.getTransform()
      const s = t.a || 1
      const dev = ctx.canvas
      const off = document.createElement('canvas')
      off.width = Math.max(1, dev.width)
      off.height = Math.max(1, dev.height)
      const octx = off.getContext('2d')
      if (octx) {
        octx.setTransform(t)
        // Frame base for shader fills = the device transform, captured BEFORE the
        // shape's own local transform below (matches the fast path at line ~1157),
        // so a frame-anchored fill samples the shared field at the correct
        // frame-space location under any ctx scale (see resolveShaderFill).
        _fieldCtx = { ..._fieldCtx, base: t }
        // Torn edge / feather are per-pixel CPU passes, so re-running them for a layer
        // that only MOVED is the whole cost of a drag. When the layer's local box is a
        // faithful render of it, bake that box once and stamp the cached raster here
        // instead. The tear/feather noise is then sampled in the layer's own box rather
        // than at its position in the frame, so the pattern travels with the layer.
        // Only at clone scale 1: the raster is baked at device scale `s` alone, so a
        // cloner falloff with `ls !== 1` would stamp a resampled (soft/aliased) copy —
        // that clone falls through to the uncached path instead.
        const raster = ls === 1 ? silhouetteRaster(s) : null
        if (raster) {
          applyXform(octx, lx, ly, lrot, ls)
          // `raster.w/h` are the rounded DEVICE size divided back by `s`, so under `t`
          // the destination is exactly the bitmap's own pixel size — no rescaling. The
          // translation is still fractional (`lx * W` lands anywhere), so the stamp can
          // resample by up to half a pixel in position; that is the same subpixel
          // placement the uncached draw does, not an extra softening from the cache.
          octx.drawImage(raster.canvas, -raster.w / 2, -raster.h / 2, raster.w, raster.h)
        } else {
          applyXform(octx, lx, ly, lrot, ls)
          drawContent(octx)
          if (inner) compositeInnerShadow(off, inner, W, s)
          // scale = device px per logical px, so bloom radius / grain size land at the
          // right physical size on a device-resolution buffer (mirrors applyStackPost).
          if (chain.length) applyEffectChain(off, chain, { W, scale: s })
          // Torn edge carves the offscreen's alpha + paints the lip, in device px,
          // so preview and export tear identically. Runs after content + 2D effects
          // so grain/adjust sit inside the tear, and before the stamp so drop-shadow
          // and blur (applied below) follow the torn silhouette.
          if (tornEdge) applyTornEdge(off, tornEdge, { scale: s })
          // Feather softens whatever silhouette exists (including a torn one) by
          // fading alpha inward. Runs before the drop-shadow/blur stamp below so
          // those follow the feathered edge. amount is element-relative (derived
          // from the rendered silhouette's own bbox), so no canvas/scale is passed.
          if (feather) applyFeather(off, feather)
        }
        ctx.save()
        // `off` already holds device pixels — stamp it 1:1 in device space, not under
        // `t` (which would upscale it a second time). Shadow/blur are specified in
        // device px here, so their logical W-normalized params scale by `s`.
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalAlpha = lop
        ctx.globalCompositeOperation = blendOp
        if (blur) ctx.filter = `blur(${Math.max(0, blur.radius * W * s)}px)`
        if (shadow) {
          ctx.shadowColor = shadow.color
          ctx.shadowBlur = Math.max(0, shadow.blur * W * s)
          ctx.shadowOffsetX = shadow.x * W * s
          ctx.shadowOffsetY = shadow.y * W * s
        }
        ctx.drawImage(off, 0, 0)
        ctx.restore()
        continue
      }
    }

    // Fast path (no effects): draw inline. No skew/cornerPin ⇒ identical to before.
    ctx.save()
    ctx.globalAlpha = lop
    ctx.globalCompositeOperation = blendOp
    _fieldCtx = { ..._fieldCtx, base: ctx.getTransform() } // frame base, before this shape's own transform
    applyXform(ctx, lx, ly, lrot, ls)
    drawContent(ctx)
    ctx.restore()
  }
}

/**
 * A device-sized scratch canvas that shares `ctx`'s CURRENT transform, so
 * anything drawn on it lands on exactly the same pixels it would have on `ctx`.
 * Stamped back 1:1 in device space by `stampScratch`. Returns null where there's
 * no DOM (SSR / unit tests), and callers then take a safe fallback.
 */
function scratchLike(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  const dev = ctx.canvas
  const c = document.createElement('canvas')
  c.width = Math.max(1, dev.width || 1)
  c.height = Math.max(1, dev.height || 1)
  const o = c.getContext('2d')
  if (!o) return null
  o.setTransform(ctx.getTransform())
  return o
}

/** Composite a `scratchLike` canvas back onto `ctx` (device pixels, 1:1). The
 *  caller's globalAlpha / blend still apply, so the stamped ink behaves like it
 *  had been drawn inline. */
function stampScratch(ctx: CanvasRenderingContext2D, scratch: CanvasRenderingContext2D) {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(scratch.canvas, 0, 0)
  ctx.restore()
}

/**
 * Stroke a closed shape honouring alignment + dashes. THE single place any
 * shape's outline is painted, so the card, the modal and client bakes agree.
 *
 * - center (default): `lineWidth = width; strokeStyle = …; stroke()` — literally
 *   the statements every kind ran before this helper existed, so an absent
 *   `strokeAlign`/`strokeDash` is byte-identical to the legacy path.
 * - inside: clip to the shape, stroke at 2× width — the outer half is clipped away.
 * - outside: stroke at 2× width on a scratch canvas, knock the interior out of
 *   THAT, then stamp it. The knockout MUST NOT happen on `ctx`: a
 *   `destination-out` fill there would eat the layer's own fill and every pixel
 *   of backdrop under the shape.
 *
 * `path` (a Path2D) is used when supplied; otherwise the shape is the current
 * path on `ctx`, and `build` re-creates it on the scratch context.
 *
 * Exported so the dash-pattern reset (see the "Deterministic reset" comment
 * below) can be unit-tested directly: calling this twice on the SAME ctx with
 * no enclosing save()/restore() is the only way to observe it, since every
 * real caller (paintLayer) already wraps each layer's draw in save()/restore(),
 * which would mask a missing reset on its own.
 */
export function strokeAligned(ctx: CanvasRenderingContext2D, o: {
  width: number
  style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
  align?: StrokeAlign
  dash?: [number, number] | null
  path?: Path2D | null
  fillRule?: CanvasFillRule
  build?: (c: CanvasRenderingContext2D) => void
}) {
  if (!(o.width > 0)) return
  const dash = o.dash ?? null
  const strokeOn = (c: CanvasRenderingContext2D, w: number) => {
    c.lineWidth = w
    c.strokeStyle = o.style(c)
    if (dash) c.setLineDash([dash[0], dash[1]])
    if (o.path) c.stroke(o.path); else c.stroke()
    // Deterministic reset: a leaked dash pattern would silently dash the NEXT
    // layer painted on this shared context.
    if (dash) c.setLineDash([])
  }
  const align = strokeAlignOf(o.align)
  if (align === 'inside') {
    ctx.save()
    if (o.path) ctx.clip(o.path, o.fillRule || 'nonzero'); else ctx.clip(o.fillRule || 'nonzero')
    strokeOn(ctx, o.width * 2)
    ctx.restore()
    return
  }
  if (align === 'outside') {
    const s = scratchLike(ctx)
    if (s) {
      if (o.build) o.build(s)
      strokeOn(s, o.width * 2)
      s.globalCompositeOperation = 'destination-out'
      if (o.path) s.fill(o.path, o.fillRule || 'nonzero'); else s.fill(o.fillRule || 'nonzero')
      s.globalCompositeOperation = 'source-over'
      stampScratch(ctx, s)
      return
    }
    // No scratch canvas available — fall back to the centered stroke rather
    // than knocking out on the shared context (which would eat the backdrop).
  }
  strokeOn(ctx, o.width)
}

// Per-kind shape rendering. Caller has already applied opacity + the layer's
// translate/rotate to `ctx`; here we just paint the geometry at the origin.
// `wiredLive`: same pre-resolved-content seam as `localLayerBox` above — paintLayer
// threads its once-per-call resolve through here too so the box a corner-pin/DOF
// offscreen was sized from is the exact same content it then draws.
function drawLayerContent(ctx: CanvasRenderingContext2D, layer: LocalLayer, W: number, wiredLive?: WiredLive | null) {
  if (layer.kind === 'text') {
    drawText(ctx, layer, W)
  } else if (layer.kind === 'rect') {
    const w = layer.w * W, h = layer.h * W
    // One rounded path for every corner shape: a plain `radius` yields four
    // equal radii, so uniform rects draw exactly as before. `build` re-creates
    // the same path on the outside-align scratch canvas.
    const radii = cornerRadii(layer.radius, w, h, W)
    const build = (c: CanvasRenderingContext2D) => { c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h, radii) }
    build(ctx)
    if (hasPaint(layer.fill)) { ctx.fillStyle = resolvePaint(ctx, layer.fill, { w, h }, _fieldCtx); ctx.fill() }
    if (hasPaint(layer.stroke) && layer.strokeWidth > 0) {
      strokeAligned(ctx, {
        width: layer.strokeWidth * W,
        style: (c) => resolvePaint(c, layer.stroke, { w, h }, _fieldCtx),
        align: layer.strokeAlign, dash: strokeDashSegments(layer.strokeDash, W), build,
      })
    }
  } else if (layer.kind === 'ellipse') {
    const w = layer.w * W, h = layer.h * W
    const build = (c: CanvasRenderingContext2D) => { c.beginPath(); c.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2) }
    build(ctx)
    if (hasPaint(layer.fill)) { ctx.fillStyle = resolvePaint(ctx, layer.fill, { w, h }, _fieldCtx); ctx.fill() }
    if (hasPaint(layer.stroke) && layer.strokeWidth > 0) {
      strokeAligned(ctx, {
        width: layer.strokeWidth * W,
        style: (c) => resolvePaint(c, layer.stroke, { w, h }, _fieldCtx),
        align: layer.strokeAlign, dash: strokeDashSegments(layer.strokeDash, W), build,
      })
    }
  } else if (layer.kind === 'path') {
    drawPath(ctx, layer, W)
  } else if (layer.kind === 'polygon' || layer.kind === 'star') {
    const d = layer.kind === 'polygon'
      ? polygonPathData(layer.sides, layer.w, layer.h, layer.cornerRadius)
      : starPathData(layer.points, layer.innerRatio, layer.w, layer.h, layer.cornerRadius)
    if (d) {
      drawPath(ctx, {
        ...layer, kind: 'path', d, bbox: { w: layer.w, h: layer.h }, scale: 1, fillRule: 'nonzero',
        fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
        // Alignment + dashes ride along: at scale 1 a polygon/star's local units
        // ARE width-normalized, so both mean the same thing on either side.
        strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash,
      } as any, W)
    }
  } else if (layer.kind === 'line') {
    const w = layer.w * W
    ctx.beginPath()
    ctx.moveTo(-w / 2, 0)
    ctx.lineTo(w / 2, 0)
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(1, layer.strokeWidth * W)
    ctx.strokeStyle = hasPaint(layer.stroke) ? resolvePaint(ctx, layer.stroke, { w, h: Math.max(layer.strokeWidth * W, 1) }, _fieldCtx) : '#ffffff'
    // A line has no interior, so alignment doesn't apply — dashes do. Reset the
    // pattern right after so it can't leak into the next layer's stroke.
    const dash = strokeDashSegments(layer.strokeDash, W)
    if (dash) ctx.setLineDash([dash[0], dash[1]])
    ctx.stroke()
    if (dash) ctx.setLineDash([])
  } else if (layer.kind === 'image') {
    const w = layer.w * W, h = layer.h * W
    const img = _imageCache.get(imageLayerUrl(layer.filename))
    if (img && img.complete && img.naturalWidth) {
      if (hasPaint(layer.tint)) drawTintedImage(ctx, img, layer, w, h)
      else ctx.drawImage(img, -w / 2, -h / 2, w, h)
    } else {
      // Not loaded yet — faint placeholder; a preload + re-render fills it in.
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.fillRect(-w / 2, -h / 2, w, h)
    }
  } else if (layer.kind === 'wired') {
    // Graph pixels, drawn like any other content: centred on the origin the caller
    // already translated to, in the layer's own box. Everything around this draw —
    // opacity, blend, effects, crop/stroke/layer masks, cloner, motion — comes from
    // the shared LayerCommon machinery, because a wired layer reaches here through
    // exactly the same paintLayer path as a rect or an image.
    // `w <= 0` is the migration's UNRESOLVED_WIRED_W sentinel (content size not
    // known yet) — draw nothing rather than let a negative width reach
    // `ctx.drawImage`, which treats it as a horizontal flip instead of "skip".
    if (layer.w <= 0) return
    const live = wiredLive !== undefined ? wiredLive : wiredContent(layer)
    // No content this frame: draw NOTHING. The layer keeps its last-known box (see
    // localLayerBox, which falls back to `lastAspect` the same way) so selection and
    // handles stay put, and the host shows the unlinked badge in the DOM. Painting a
    // placeholder here would bake into exports.
    if (!live) return
    const box = wiredBoxPx(layer, W, live)
    ctx.drawImage(live.src, -box.w / 2, -box.h / 2, box.w, box.h)
  } else if (layer.kind === 'brush') {
    if (!layer.strokes.length) return
    // Size the offscreen to the painted BOUNDS (a tight box), not the whole artboard,
    // so the layer's box/selection hug the marks. Strokes are width-normalized; shift
    // the offscreen so the bounds' top-left maps to (0,0). Rasterize at DEVICE
    // resolution (dpr) so the committed layer stays crisp on retina — `ctx` is
    // DPR-scaled, so the final drawImage at LOGICAL size renders the hi-res offscreen 1:1.
    const b = strokeBounds(layer.strokes)
    // Uniform "keep proportions" scale: `w` drives a scale of the strokes' natural
    // width, and multiplying every artboard-width factor (W) by it below scales the
    // whole shape AND the stroke thickness together, staying centred. At paint-commit
    // `w == naturalW` so scale === 1 → every `* scale` is a no-op and this renders
    // byte-identical to the un-resized brush.
    // NOTE: painting MORE strokes onto a resized brush re-fits `w` to the new natural
    // bounds (brushBoxFromStrokes), resetting the scale — acceptable, out of scope.
    const nw = b.maxX - b.minX
    const scale = nw > 1e-6 ? layer.w / nw : 1
    const w = Math.max(1, Math.round((b.maxX - b.minX) * W * scale))
    const h = Math.max(1, Math.round((b.maxY - b.minY) * W * scale))
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const dw = Math.max(1, Math.round(w * dpr))
    const dh = Math.max(1, Math.round(h * dpr))
    const off = document.createElement('canvas'); off.width = dw; off.height = dh
    const octx = off.getContext('2d'); if (!octx) return
    octx.save()
    octx.translate(-b.minX * W * dpr * scale, -b.minY * W * dpr * scale) // bounds' top-left → offscreen origin
    stampStrokes(octx, layer.strokes, W * dpr * scale)   // base = artboard-width scale × keep-proportions scale
    octx.restore()
    if (hasPaint(layer.fill)) {
      octx.save()
      octx.translate(dw / 2, dh / 2)             // center so resolvePaint's gradient/pattern lines up
      octx.globalCompositeOperation = 'source-in' // keep fill only where strokes painted
      // Brush's inner offscreen is bounds-cropped + dpr-scaled, NOT a plain copy of
      // frame-pixel space like the other primitives' offscreens are (see the capture
      // points in paintLayer above) — so a frame-anchored fill needs its OWN frame
      // base, computed directly from the same bounds/dpr/W used to build `off` above,
      // rather than inheriting whatever the outer shape transform last captured.
      const prevFieldBase = _fieldCtx.base
      if (typeof DOMMatrix !== 'undefined' && isFill(layer.fill) && fillIsShader(layer.fill) && layer.fill.shader.anchor === 'frame') {
        // Stroke space is now scaled by W*dpr*scale (see octx.translate above), so the
        // translate carries `* scale` to match; scaleSelf(dpr) stays as-is (the field
        // base maps stroke space → device, and the dpr scale of that mapping is unchanged).
        _fieldCtx = { ..._fieldCtx, base: new DOMMatrix().translateSelf(-b.minX * W * dpr * scale, -b.minY * W * dpr * scale).scaleSelf(dpr) }
      }
      octx.fillStyle = resolvePaint(octx, layer.fill, { w: dw, h: dh }, _fieldCtx)
      _fieldCtx = { ..._fieldCtx, base: prevFieldBase }
      octx.fillRect(-dw / 2, -dh / 2, dw, dh)
      octx.restore()
    }
    // Centered at the layer origin, which the caller placed at the bounds' centre.
    ctx.drawImage(off, -w / 2, -h / 2, w, h)
  } else if (layer.kind === 'deal') {
    // The generative deal: resolve THIS layer's grid over its own box, then paint
    // each kept cell a seeded fill from the chosen vocabulary. Centered like every
    // other layer — shift so the box top-left sits at (-boxW/2, -boxH/2), then draw
    // each cell at its corner-origin sub-box. Opacity / blend / mask / effects all
    // ride the shared LayerCommon machinery around this draw (paintLayer wraps it),
    // so this branch only lays down pixels.
    const boxW = Math.max(1, layer.w * W), boxH = Math.max(1, layer.h * W)
    // Resolve cells FLUSH (gutter 0): the deal's only cell gap is `cellInset`, applied
    // per cell below. The grid's own gutter would add a second, hidden gap so cells are
    // never flush even at cellInset 0 — which is not what the inset control implies.
    const { regions } = resolveGrid({ ...layer.grid, gutter: 0 }, boxW, boxH)
    if (!regions.length) return
    const seed = layer.grid.gen.seed
    const density = layer.density ?? 1
    const inset = Math.max(0, Math.min(0.4, layer.cellInset ?? 0))
    // Force-keep one cell when density > 0 so a sparse deal never renders fully
    // blank (an invisible layer the user just added). Explicit density 0 stays empty.
    const forceIdx = density > 0 ? forceKeptCell(seed, regions.length) : -1
    ctx.save()
    ctx.translate(-boxW / 2, -boxH / 2)
    for (let i = 0; i < regions.length; i++) {
      if (i !== forceIdx && !keptCell(seed, i, density)) continue
      const r = regions[i]!
      const ins = inset * Math.min(r.w, r.h)
      const cw = r.w - ins * 2, ch = r.h - ins * 2
      if (cw <= 0.5 || ch <= 0.5) continue
      // paintTileBox paints ANY Paint (solid / gradient / pattern Fill) at corner
      // origin; a shader-typed Fill unwraps to its input there, so no field request
      // is needed (see layerPaints('deal')). Drawn into the cell's own sub-box.
      // 'pane' cell fill swaps the solid vocabulary pick for a hue-walked two-ink
      // gradient (a "gradient mosaic"); everything else about the cell is unchanged.
      const cellPaint = layer.cellFill === 'pane'
        ? paneCellGradient(layer.vocab, seed, i)
        : pickDealPaint(layer.vocab, seed, i)
      const tile = paintTileBox(cellPaint, cw, ch)
      ctx.drawImage(tile, r.x + ins, r.y + ins, cw, ch)
    }
    ctx.restore()
  }
}

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, W: number) {
  const lineH = layer.fontSize * W * layer.lineHeight
  if (layer.expressive) { drawExpressiveText(ctx, layer, W, lineH); return }
  const lines = wrappedTextLines(ctx, layer, W)
  applyFont(ctx, layer, W)
  ctx.textBaseline = 'middle'
  // 'justify' isn't a canvas textAlign — draw its words manually, left-anchored.
  const canvasAlign = layer.align === 'justify' ? 'left' : layer.align
  ctx.textAlign = canvasAlign
  // Alignment anchors against the text box when one is set, else the widest line.
  let blockW: number
  if ((layer.boxW ?? 0) > 0) {
    blockW = layer.boxW! * W
  } else {
    blockW = 0
    for (const ln of lines) blockW = Math.max(blockW, ctx.measureText(ln || ' ').width)
  }
  const anchorX = canvasAlign === 'left' ? -blockW / 2 : canvasAlign === 'right' ? blockW / 2 : 0
  const totalH = lines.length * lineH
  // Horizontal justify needs a real box width to fill (nothing to justify to
  // otherwise); vertical position honours valign within the height box (boxH),
  // falling back to the legacy centred block when neither valign nor boxH set.
  const justifyH = layer.align === 'justify' && (layer.boxW ?? 0) > 0
  const boxHpx = (layer.boxH ?? 0) * W
  const va = layer.valign
  const startY = -totalH / 2 + lineH / 2          // legacy: block centred on origin
  const H = boxHpx > 0 ? boxHpx : totalH
  const vJustify = va === 'justify' && lines.length > 1
  const lineY = (i: number): number => {
    if (!va && boxHpx <= 0) return startY + i * lineH
    if (vJustify) return -H / 2 + lineH / 2 + (i / (lines.length - 1)) * (H - lineH)
    const s = va === 'top' ? -H / 2 + lineH / 2 : va === 'bottom' ? H / 2 - totalH + lineH / 2 : startY
    return s + i * lineH
  }
  const textBox = { w: Math.max(blockW, 1), h: Math.max(H, 1) }
  const stroke = hasPaint(layer.strokeColor) && layer.strokeWidth > 0
  // `strokeText` honours setLineDash, so a text outline dashes like a shape's.
  const dash = stroke ? strokeDashSegments(layer.strokeDash, W) : null
  if (stroke) {
    ctx.lineJoin = 'round'
    ctx.lineWidth = layer.strokeWidth * W
    ctx.strokeStyle = resolvePaint(ctx, layer.strokeColor, textBox, _fieldCtx)
    if (dash) ctx.setLineDash([dash[0], dash[1]])
  }
  ctx.fillStyle = resolvePaint(ctx, layer.color, textBox, _fieldCtx)
  const fontPx = layer.fontSize * W
  const deco = layer.underline || layer.strikethrough
  const decoThick = Math.max(1, fontPx * 0.06)
  for (let i = 0; i < lines.length; i++) {
    const y = lineY(i)
    if (justifyH) {
      // Distribute the line's words edge-to-edge across blockW (last line too —
      // expressive/box justify has no ragged-last-line concept).
      const words = (lines[i] || '').split(/\s+/).filter(Boolean)
      const widths = words.map(w => ctx.measureText(w).width)
      const total = widths.reduce((a, b) => a + b, 0)
      const gap = words.length > 1 ? Math.max(0, (blockW - total) / (words.length - 1)) : 0
      let cx = -blockW / 2
      for (let k = 0; k < words.length; k++) {
        if (stroke) ctx.strokeText(words[k]!, cx, y)
        ctx.fillText(words[k]!, cx, y)
        cx += widths[k]! + gap
      }
      if (deco && words.length) {
        if (layer.underline) ctx.fillRect(-blockW / 2, y + fontPx * 0.34, blockW, decoThick)
        if (layer.strikethrough) ctx.fillRect(-blockW / 2, y - decoThick / 2, blockW, decoThick)
      }
      continue
    }
    if (stroke) ctx.strokeText(lines[i], anchorX, y)
    ctx.fillText(lines[i], anchorX, y)
    // Decoration lines span the drawn line, anchored to match the text alignment.
    // Drawn in the text's own fill so they inherit gradient/pattern fills.
    if (deco && lines[i]) {
      const lw = ctx.measureText(lines[i]).width
      const left = canvasAlign === 'left' ? anchorX : canvasAlign === 'right' ? anchorX - lw : anchorX - lw / 2
      if (layer.underline) ctx.fillRect(left, y + fontPx * 0.34, lw, decoThick)
      if (layer.strikethrough) ctx.fillRect(left, y - decoThick / 2, lw, decoThick)
    }
  }
  if (dash) ctx.setLineDash([])   // never leak the pattern to the next layer
}

/**
 * Expressive text: each word placed by the shared layout engine (overrides the
 * flow `align`). The block is centered on origin exactly like `drawText`, but we
 * position every word individually with a left anchor and the middle baseline.
 * Horizontal bound = the text box if set, else the widest natural line.
 */
function drawExpressiveText(ctx: CanvasRenderingContext2D, layer: TextLayer, W: number, lineH: number) {
  applyFont(ctx, layer, W)
  const source = transformCase(layer.text ?? '', layer.textTransform)
  let boxWidth = (layer.boxW ?? 0) * W
  if (!(boxWidth > 0)) {
    for (const ln of textLines(layer)) boxWidth = Math.max(boxWidth, ctx.measureText(ln || ' ').width)
    boxWidth = Math.max(boxWidth, 1)
  }
  // Height box (boxH) bounds vertical justify; without it, natural height.
  const boxHeight = (layer.boxH ?? 0) * W || undefined
  const lay = layoutExpressive({
    text: source, boxWidth, boxHeight, lineHeight: lineH,
    measure: (word) => ctx.measureText(word).width,
    params: layer.expressive!,
    justifyX: layer.align === 'justify',
    justifyY: layer.valign === 'justify',
  })
  if (!lay.words.length) return
  const originX = -boxWidth / 2
  const originY = -lay.height / 2
  const textBox = { w: Math.max(boxWidth, 1), h: Math.max(lay.height, 1) }
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const stroke = hasPaint(layer.strokeColor) && layer.strokeWidth > 0
  const dash = stroke ? strokeDashSegments(layer.strokeDash, W) : null
  if (stroke) {
    ctx.lineJoin = 'round'
    ctx.lineWidth = layer.strokeWidth * W
    ctx.strokeStyle = resolvePaint(ctx, layer.strokeColor, textBox, _fieldCtx)
    if (dash) ctx.setLineDash([dash[0], dash[1]])
  }
  ctx.fillStyle = resolvePaint(ctx, layer.color, textBox, _fieldCtx)
  const fontPx = layer.fontSize * W
  const deco = layer.underline || layer.strikethrough
  const decoThick = Math.max(1, fontPx * 0.06)
  for (const wd of lay.words) {
    const x = originX + wd.x
    const y = originY + wd.y + lineH / 2   // band top → line's vertical center
    if (stroke) ctx.strokeText(wd.text, x, y)
    ctx.fillText(wd.text, x, y)
    if (deco && wd.text) {
      if (layer.underline) ctx.fillRect(x, y + fontPx * 0.34, wd.w, decoThick)
      if (layer.strikethrough) ctx.fillRect(x, y - decoThick / 2, wd.w, decoThick)
    }
  }
  if (dash) ctx.setLineDash([])   // never leak the pattern to the next layer
}

/**
 * Module-cached Path2D per `d` string — building a Path2D parses the path data,
 * which we'd otherwise repeat every animation frame.
 */
const _pathCache = new Map<string, Path2D>()
function path2dFor(d: string): Path2D | null {
  if (!d) return null
  let p = _pathCache.get(d)
  if (!p) {
    try { p = new Path2D(d) } catch { return null }
    if (_pathCache.size > 400) _pathCache.clear()
    _pathCache.set(d, p)
  }
  return p
}

/**
 * Draw a vector path layer. The context is already translated to the layer
 * center and rotated; here we scale into the path's local units (1 unit =
 * canvas width) times the layer's uniform `scale`, then fill/stroke the cached
 * Path2D. Gradients resolve against the un-scaled local bbox.
 */
function drawPath(ctx: CanvasRenderingContext2D, layer: PathLayer, W: number) {
  const p = path2dFor(layer.d)
  if (!p) return
  const s = (layer.scale || 1) * W
  ctx.save()
  ctx.scale(s, s)
  if (hasPaint(layer.fill)) {
    ctx.fillStyle = resolvePaint(ctx, layer.fill, layer.bbox, _fieldCtx)
    ctx.fill(p, layer.fillRule || 'nonzero')
  }
  if (hasPaint(layer.stroke) && layer.strokeWidth > 0) {
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // Width, dash and alignment all live in the path's LOCAL units (the ctx is
    // already scaled by `s`), so an outline scales with the shape.
    strokeAligned(ctx, {
      width: layer.strokeWidth,
      style: (c) => resolvePaint(c, layer.stroke, layer.bbox, _fieldCtx),
      align: layer.strokeAlign,
      dash: strokeDashSegments(layer.strokeDash),
      path: p,
      fillRule: layer.fillRule || 'nonzero',
      // The scratch canvas inherits this ctx's transform but not its line joins.
      build: (c) => { c.lineJoin = 'round'; c.lineCap = 'round' },
    })
  }
  ctx.restore()
}

/** Draw all local layers (bottom→top order = array order). */
// One ordered stack item: a wired image layer (drawn via its own closure) or a
// local layer. The single source of truth for stack rendering — both canvases
// (Frame node, Compositor modal) and the bake go through paintLayerStack, so
// masking/effects can't drift between them (the bug-class this prevents).
export type StackItem =
  | { type: 'wired'; key: string; draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void }
  | { type: 'local'; key: string; layer: LocalLayer }

// Figma background blur: blur the ALREADY-PAINTED backdrop within the layer's
// silhouette, then the layer paints on top. Operates in device space so it's
// correct under the dpr transform renderers apply to the stack canvas.
function applyBackdropBlur(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  localLayers: LocalLayer[],
  W: number,
  H: number,
  radius: number,
) {
  if (!(radius > 0)) return
  const t = ctx.getTransform()
  const dev = ctx.canvas
  const mk = () => {
    const c = document.createElement('canvas')
    c.width = dev.width; c.height = dev.height
    return c
  }
  // Silhouette: the layer's own alpha (full opacity, no effects) at device scale.
  const sil = mk()
  const silctx = sil.getContext('2d')
  if (!silctx) return
  silctx.setTransform(t)
  const ghost = { ...layer, opacity: 1, effects: undefined, blend: undefined } as LocalLayer
  const maskRef = layerMaskRef(layer)
  const maskLayer = maskRef?.startsWith('l:')
    ? localLayers.find(l => l.id === maskRef.slice(2)) ?? null
    : null
  drawLocalLayer(silctx, ghost, W, H, maskLayer)
  // Blur the current backdrop, clip to the silhouette, stamp it back.
  const out = mk()
  const octx = out.getContext('2d')
  if (!octx) return
  octx.filter = `blur(${Math.max(0, radius * W * t.a)}px)`
  octx.drawImage(dev, 0, 0)
  octx.filter = 'none'
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(sil, 0, 0)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(out, 0, 0)
  ctx.restore()
}

// Displacement map: the layer's pixels are NOT drawn — instead they warp the backdrop
// already painted below this layer. Called from paintLayerStack's item loop. `ghost` draws
// a faint preview of the map in the editor so the layer doesn't appear to vanish (never in bake).
function applyDisplaceFromLayer(
  ctx: CanvasRenderingContext2D,
  layer: ImageLayer,
  W: number,
  H: number,
  opts?: { ghost?: boolean },
) {
  const spec = layer.displaceMap
  if (!spec) return
  const dev = ctx.canvas
  const w = dev.width, h = dev.height
  if (w < 1 || h < 1) return
  const t = ctx.getTransform()

  // 1. Snapshot the backdrop below this layer (device pixels; getImageData ignores transform).
  const src = ctx.getImageData(0, 0, w, h)

  // 2. Render the map layer (full colour, its transform baked in) to a device-sized offscreen.
  const off = document.createElement('canvas')
  off.width = w; off.height = h
  const octx = off.getContext('2d')
  if (!octx) return
  octx.setTransform(t)
  const mapGhost = { ...layer, opacity: 1, effects: undefined, blend: undefined, displaceMap: undefined } as LocalLayer
  drawLocalLayerSelf(octx, mapGhost, W, H)
  const mapData = octx.getImageData(0, 0, w, h)

  // 3+4. Build the offset field and resample the backdrop. amount is SCREEN px → scale to device.
  const field = buildDisplacementField(mapData.data, w, h, spec, t.a || 1)
  const amountDev = spec.amount * (t.a || 1)
  const outArr = resampleBilinear(src.data, field, amountDev, w, h)

  // 5. Write the warped backdrop back (putImageData is always device-space).
  ctx.putImageData(new ImageData(outArr, w, h), 0, 0)

  // Editor affordance: faint ghost of the map so it's visible/selectable. Never in bake.
  if (opts?.ghost) {
    const g = { ...layer, opacity: 0.14, effects: undefined, blend: undefined, displaceMap: undefined } as LocalLayer
    drawLocalLayerSelf(ctx, g, W, H)
  }
}

/** Every Paint slot a local layer can carry, kind-specific — walked by paintLayerStack's
 *  pre-pass (below) to find shader fills BEFORE anything paints, so beginFieldFrame sees
 *  the same set resolveFill will actually ask for during the pass. */
function layerPaints(layer: LocalLayer): Paint[] {
  switch (layer.kind) {
    case 'text': return [layer.color, layer.strokeColor]
    case 'line': return [layer.stroke]
    case 'image': return layer.tint ? [layer.tint] : []
    case 'brush': return layer.stroke ? [layer.fill, layer.stroke] : [layer.fill]
    case 'wired': return []                    // graph pixels — no authored Paint slots
    // v1 deal vocabularies are solid/gradient/pattern fills only (no live shaders),
    // so there's nothing for the shader-field pre-pass to register. A future shader
    // vocabulary would return its ShaderSpec fills here.
    case 'deal': return []
    default: return [layer.fill, layer.stroke] // rect / ellipse / polygon / star / path
  }
}

/** Whether `items`/`background` currently carry a LIVE shader fill — one whose
 *  `speed !== 0`, and therefore needs a real clock (`t`) to animate at all. A
 *  `speed: 0` fill is deliberately frozen and must NOT count here, or "frozen"
 *  becomes impossible to express: a host that starts a rAF loop whenever any
 *  shader fill exists (animated or not) would spin forever for a still fill.
 *  Pure + host-agnostic on purpose: both the Frame node card and the Compositor
 *  modal use this to decide whether THEY need to own a clock, and a unit test
 *  pins it directly so "does this need a clock" can't silently regress into
 *  waking every Frame on the canvas (see saf-frame-clock-report.md). */
export function hasAnimatedShaderFill(items: StackItem[], background?: Paint): boolean {
  const isLiveShader = (p: Paint | undefined): boolean => isFill(p) && fillIsShader(p) && p.shader.speed !== 0
  if (isLiveShader(background)) return true
  for (const it of items) {
    if (it.type !== 'local') continue
    if (layerPaints(it.layer).some(isLiveShader)) return true
  }
  return false
}

/** Collect a shader-fill Paint into `out` as a FieldRequest, sized EXACTLY the way
 *  resolveShaderFill sizes it at paint time (frame anchor → frame size; object anchor →
 *  the fixed OBJECT_SHADER_FIELD_PX) — see resolveShaderFill's doc for why the two must
 *  agree, and OBJECT_SHADER_FIELD_PX's doc for why object anchor doesn't need the box. */
function addShaderFieldRequest(out: FieldRequest[], paint: Paint | undefined, W: number, H: number, t: number, fps: number, bake: boolean) {
  if (!isFill(paint) || !fillIsShader(paint)) return
  const frame = paint.shader.anchor === 'frame'
  out.push({
    spec: paint.shader,
    w: frame ? Math.max(1, Math.round(W)) : OBJECT_SHADER_FIELD_PX,
    h: frame ? Math.max(1, Math.round(H)) : OBJECT_SHADER_FIELD_PX,
    t, fps, bake,
  })
}

export function paintLayerStack(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  items: StackItem[],
  localLayers: LocalLayer[],
  skip?: (layer: LocalLayer) => boolean,
  t?: number,
  motion?: { fps: number; duration: number },
  /** Per-key treatments for wired layers (mask ref + showSource). Locals carry their own. */
  wiredTreatments?: Record<string, { maskedByKey?: string; showSource?: boolean }>,
  /** Doc-level background fill, painted first (behind every layer). */
  background?: Paint,
  /** Nested-group registry (Task 1). Absent ⇒ no cascade, byte-identical to before. */
  groups?: LayerGroup[],
  /** Doc-level post-processing chain, applied to the finished composite.
   *  Absent/empty ⇒ byte-identical output. */
  post?: PostEffect[],
  /** True for a final export/bake (Render, motion bake, Frame download/publish) —
   *  opts shader-fill fields out of both the 512px live-preview clamp AND
   *  LIVE_FIELD_CEILING (Task 10): a bake has no frame budget, so every distinct
   *  descriptor renders at full resolution and stays live, however many there are.
   *  False (the default) is the live-preview behaviour byte-identical to before this
   *  param existed — every EXISTING positional call site is therefore unaffected;
   *  only export call sites pass `true` explicitly. */
  bake = false,
): { frozenCount: number } {
  const fieldT = t ?? 0, fieldFps = motion?.fps ?? 30
  _fieldCtx = {
    frameW: W, frameH: H, t: fieldT, fps: fieldFps,
    base: typeof ctx.getTransform === 'function' ? ctx.getTransform() : null,
    bake, token: 0,
  }
  // Task 6 / Item 1 (final review): one `withFieldFrame` call per rendered frame, scoped
  // to exactly the shader fills THIS document's layers/background carry this pass — see
  // the doc above resolveShaderFill for why this is the Compositor's own host boundary.
  // `withFieldFrame` owns the begin/end pairing in a try/finally (see its doc in
  // ~/lib/shaderfill/field.ts), so an exception anywhere in the drawing loop below (a
  // broken canvas op, a WebGL hiccup) can no longer leave the module-global field-frame
  // span stuck open and freeze every OTHER host's next frame. paintLayerStack never
  // awaits, so no other host's span can land inside this one either way.
  const shaderRequests: FieldRequest[] = []
  for (const it of items) {
    if (it.type !== 'local') continue
    for (const p of layerPaints(it.layer)) addShaderFieldRequest(shaderRequests, p, W, H, fieldT, fieldFps, bake)
  }
  addShaderFieldRequest(shaderRequests, background, W, H, fieldT, fieldFps, bake)

  // Make a missing clock DETECTABLE instead of silently rendering "frozen at zero"
  // forever — the exact failure mode that shipped Frames looking broken (the caller
  // passed no `t`, `fieldT` defaulted to 0, and a still gradient is indistinguishable
  // from a working-but-idle one). Only warns when a LIVE (`speed !== 0`) shader fill is
  // actually present and `t` itself was omitted — a `speed: 0` fill intentionally wants
  // t=0 and must stay silent. Dev-only: this is a wiring smell for whoever adds the next
  // surface, not a runtime condition to report in production.
  if (import.meta.dev && t === undefined && shaderRequests.some(r => r.spec.speed !== 0)) {
    console.warn(
      '[paintLayerStack] a live shader fill (speed !== 0) was painted with no `t` — it will ' +
      'render frozen at t=0. Pass real elapsed/scrub time as the `t` argument instead of ' +
      'leaving it `undefined`.',
    )
  }

  // Item 2 fix (final review): `_fieldCtx.token` must not outlive this span — the `finally`
  // below resets it to `0` (field.ts's own "no span" sentinel, see its "ACTUAL CURRENT RULE"
  // doc above `resolveField`) once this call returns, whether it threw or not. Before this
  // fix, `_fieldCtx.token` stayed set to the LAST real token forever, so any later call made
  // OUTSIDE this span — CompositorModal's `layerHitAt` → `drawLocalLayer` → `resolveShaderFill`
  // runs on every canvas hit test, never inside a `withFieldFrame` of its own — replayed that
  // now-stale nonzero token against whatever `_liveKeysToken` a completely unrelated host's
  // rAF loop had since advanced to, logging a HOST-ISOLATION violation on every click that
  // never actually happened.
  try {
    return withFieldFrame(shaderRequests, (frozenCount, token) => {
      _fieldCtx.token = token   // resolveShaderFill reads this to pass into every resolveField call

    // Background fill — the bottom-most thing in the frame, baked into output.
    if (hasPaint(background)) {
      ctx.save()
      _fieldCtx = { ..._fieldCtx, base: ctx.getTransform() } // frame base, before the center translate below
      ctx.translate(W / 2, H / 2) // center so gradient/pattern geometry spans the canvas
      ctx.fillStyle = resolvePaint(ctx, background!, { w: W, h: H }, _fieldCtx)
      ctx.fillRect(-W / 2, -H / 2, W, H)
      ctx.restore()
    }

    const byKey = new Map(items.map(it => [it.key, it]))
    // Resolve every item's mask reference (local → layerMaskRef; wired → treatments).
    const maskRefOf = (it: StackItem): string | undefined =>
      it.type === 'local' ? layerMaskRef(it.layer) : wiredTreatments?.[it.key]?.maskedByKey
    // Whether an item requests that its mask source remains visible at its own z-position.
    const showSourceOf = (it: StackItem): boolean =>
      it.type === 'local' ? !!it.layer.maskShowSource : !!wiredTreatments?.[it.key]?.showSource
    // Keys used as a mask source by someone → those items only clip, never self-paint
    // (unless the masked item sets showSource, in which case the source also renders normally).
    const maskSourceKeys = new Set<string>()
    const keepVisibleKeys = new Set<string>()
    for (const it of items) {
      const r = maskRefOf(it)
      if (r) {
        maskSourceKeys.add(r)
        if (showSourceOf(it)) keepVisibleKeys.add(r)
      }
    }

    for (const item of items) {
      if (maskSourceKeys.has(item.key) && !keepVisibleKeys.has(item.key)) continue

      if (item.type === 'wired') {
        const ref = maskRefOf(item)
        const maskItem = ref ? byKey.get(ref) ?? null : null
        if (maskItem) { drawItemMasked(ctx, item, maskItem, W, H, 'source-over'); continue }
        item.draw(ctx, W, H)
        continue
      }

      const layer = item.layer
      // Nested-group cascade (Task 1): absent `groups` ⇒ gc stays null ⇒ opacityMul
      // defaults to 1 everywhere below, byte-identical to pre-cascade behavior.
      const gc = groups ? resolveGroupCascade(layer.groupId, groups) : null
      if (layerHidden(layer) || gc?.hidden) continue
      if (skip?.(layer)) continue

      // Displacement map: consume this image layer as a lens over everything below.
      // Placed before mask/blend/motion — a map layer ignores all of those.
      if (layer.kind === 'image' && (layer as ImageLayer).displaceMap) {
        applyDisplaceFromLayer(ctx, layer as ImageLayer, W, H, { ghost: !bake })
        continue
      }

      const opacityMul = gc ? gc.opacity : 1

      const ref = layerMaskRef(layer)
      const maskItem = ref ? byKey.get(ref) ?? null : null
      const motionActive = t !== undefined && motion && _motionPainterImpl
        && (layer.animation || (maskItem?.type === 'local' && maskItem.layer.animation))
      if (motionActive) {
        const { motionStateFor, drawLayerWithMotion, identityState } = _motionPainterImpl!
        const st = layer.animation ? motionStateFor(layer, t!, motion!) : identityState()
        if (st) {
          if (!st.visible) continue
          // Phase-1 limitation: the motion path only carries a LOCAL mask. An
          // animated local layer masked by a WIRED silhouette renders unmasked for
          // that frame (the static path below handles wired-masks-local correctly).
          const maskLocal = maskItem?.type === 'local' ? maskItem.layer : null
          const maskState = maskLocal?.animation ? motionStateFor(maskLocal, t!, motion!) : null
          if (maskState && !maskState.visible) continue
          const bgBlur = layer.effects?.find(
            (e): e is BackgroundBlurEffect => e.type === 'background_blur' && e.visible,
          )
          if (bgBlur) applyBackdropBlur(ctx, layer, localLayers, W, H, bgBlur.radius)
          // Group-cascade limitation (Task 3, mirrors the mask limitation above): the
          // motion path composes its own effective layer in lib/motion/paint.ts and
          // doesn't thread an opacityMul through, so an animated layer's group cascade
          // opacity isn't applied for that frame. Visibility (gc.hidden) IS honored via
          // the `continue` above. Static (non-animated) layers are unaffected.
          drawLayerWithMotion(ctx, layer, W, H, maskLocal, st, maskState)
          continue
        }
      }
      const bgBlur = layer.effects?.find(
        (e): e is BackgroundBlurEffect => e.type === 'background_blur' && e.visible,
      )
      if (bgBlur) applyBackdropBlur(ctx, layer, localLayers, W, H, bgBlur.radius)

      if (maskItem && maskItem.type !== 'local') {
        // Wired silhouette masking a local layer → generic cross-source path.
        drawItemMasked(ctx, item, maskItem, W, H, localBlendOp(layer), opacityMul)
      } else {
        // Local content + local mask (or no mask) → unchanged fast path.
        drawLocalLayer(ctx, layer, W, H, maskItem?.type === 'local' ? maskItem.layer : null, opacityMul)
      }
    }

    if (post && chainActive(post)) applyStackPost(ctx, post, W)
    return { frozenCount }
    })
  } finally {
    _fieldCtx.token = 0
  }
}

/**
 * Render an item's REAL content onto `ctx` (wired image via its draw closure,
 * which folds the wired layer's own opacity/blend; local via `drawLocalLayerSelf`,
 * which includes the layer's crop). NOT a silhouette — full pixels/opacity/effects
 * preserved. Wired closures are wrapped in save/restore (no state-hygiene contract).
 */
function drawItemContent(ctx: CanvasRenderingContext2D, item: StackItem, W: number, H: number, opacityMul = 1) {
  if (item.type === 'wired') { ctx.save(); item.draw(ctx, W, H); ctx.restore(); return }
  drawLocalLayerSelf(ctx, item.layer, W, H, opacityMul)
}

/**
 * Draw `content` clipped to `mask`'s alpha, then stamp onto `ctx` with `blendOp`.
 * Both render their REAL paint on separate offscreens (mirrors the original
 * drawLocalLayer path), then destination-in keeps only where the mask is opaque.
 * Phase-1 limitation: a WIRED content layer's non-normal blend is folded inside
 * its draw closure against the transparent offscreen, so it's effectively lost
 * while masked — callers pass 'source-over' for wired content. Local content
 * stamps with its own blend, re-applied here against the real backdrop as before.
 */
function drawItemMasked(
  ctx: CanvasRenderingContext2D,
  content: StackItem,
  mask: StackItem,
  W: number,
  H: number,
  blendOp: string,
  opacityMul = 1,
) {
  // Device-resolution offscreens rendered through the current transform, so a
  // masked layer stays sharp under any ctx scale (dpr preview / high-res export).
  // Logical W×H offscreens would composite at preview res and upscale → blur.
  const t = ctx.getTransform()
  const dev = ctx.canvas
  const mk = () => {
    const c = document.createElement('canvas')
    c.width = Math.max(1, dev.width); c.height = Math.max(1, dev.height)
    return c
  }
  const off = mk()
  const octx = off.getContext('2d'); if (!octx) return
  octx.setTransform(t)
  drawItemContent(octx, content, W, H, opacityMul)
  const maskOff = mk()
  const mctx = maskOff.getContext('2d'); if (!mctx) return
  mctx.setTransform(t)
  drawItemContent(mctx, mask, W, H)
  paintMaskRelease(mctx, content.type === 'local' ? content.layer.maskBreak : null, W, H)
  octx.setTransform(1, 0, 0, 1, 0, 0) // composite in device space
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(maskOff, 0, 0)
  octx.globalCompositeOperation = 'source-over'
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0) // device-space stamp
  ctx.globalCompositeOperation = blendOp as GlobalCompositeOperation
  ctx.drawImage(off, 0, 0)
  ctx.restore()
}

export function drawLocalLayers(
  ctx: CanvasRenderingContext2D,
  layers: LocalLayer[],
  W: number,
  H: number,
  bake = false,
) {
  paintLayerStack(ctx, W, H, layers.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l })), layers,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, bake)
}

/** Blend-mode name → canvas composite op (shared by node + modal wired draws). */
export const WIRED_BLEND_OP: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  soft_light: 'soft-light', hard_light: 'hard-light', difference: 'difference',
  lighten: 'lighten', darken: 'darken', add: 'lighter',
}

/** Transform of a wired image layer (normalized x/y, scale, rotation, blend). */
export interface WiredTransform {
  x: number; y: number; scale: number; rotation: number; opacity: number; blend: string
  cloner?: Cloner // linked cloner — stamp the layer N times (see useCloner)
}

/**
 * Draw one wired image layer — the SINGLE source of truth shared by the Frame
 * node and the Compositor modal so their previews can't drift apart. The image
 * is aspect-fit (contain) into the W×H artboard, then translated by the layer's
 * normalized x/y, rotated, and scaled. Fit is computed from the *actual* image
 * (not a separately-tracked dimension cache), so it never falls back to a
 * stretch-fill when a cache entry is missing.
 */
export function drawWiredImageLayer(
  ctx: CanvasRenderingContext2D,
  // Accepts a canvas too: a live studio slot supplies its frame as a canvas, which
  // has width/height but no naturalWidth/complete. Image behaviour is unchanged.
  img: HTMLImageElement | HTMLCanvasElement | undefined | null,
  layer: WiredTransform,
  W: number,
  H: number,
  maskImg?: HTMLImageElement | HTMLCanvasElement | null,   // white = hidden, image pixel space
  // Depth of field, matching what a local image layer gets. A wired image and an
  // uploaded one must expose the same features — a gap between them reads as a bug.
  dof?: DofEffect | null,
  depthImg?: CanvasImageSource | null,
) {
  if (!img) return
  const iw = 'naturalWidth' in img ? img.naturalWidth : img.width
  const ih = 'naturalHeight' in img ? img.naturalHeight : img.height
  if (!iw || !ih) return
  if ('complete' in img && !img.complete) return   // undecoded <img> — skip, as before
  // Apply the per-slot visibility mask ONCE (destination-out by the mask's alpha),
  // then the cloner loop draws the masked pixels exactly as it drew the plain image.
  let src: HTMLImageElement | HTMLCanvasElement = img
  const mReady = maskImg && (!('complete' in maskImg) || maskImg.complete)
    && (('naturalWidth' in maskImg ? maskImg.naturalWidth : maskImg.width) > 0)
  if (mReady) {
    const off = document.createElement('canvas'); off.width = iw; off.height = ih
    const octx = off.getContext('2d')
    if (octx) {
      octx.drawImage(img, 0, 0, iw, ih)
      octx.globalCompositeOperation = 'destination-out'
      octx.drawImage(maskImg as CanvasImageSource, 0, 0, iw, ih)
      src = off
    }
  }
  const cAspect = W / H, iAspect = iw / ih
  let fitW: number, fitH: number
  if (iAspect > cAspect) { fitW = W; fitH = W / iAspect } else { fitH = H; fitW = H * iAspect }

  // Defocus runs on the masked source, before the cloner stamps it — so every clone
  // shows the same blur and the GPU pass runs once. Needs fitW, hence its position
  // here: the pass renders at native size but must normalize by the ON-CANVAS width,
  // or the blur would track the source file's resolution rather than what you see.
  if (dof && depthImg && dofAvailable() && dofShouldRun(dof, true)) {
    const out = applyDof(src, depthImg, dof, W, iw, ih, fitW * layer.scale)
    if (out) {
      // Copy out of the pass's canvas — it is reused between calls, so holding the
      // reference would alias once a second DOF layer rendered.
      const owned = document.createElement('canvas'); owned.width = iw; owned.height = ih
      owned.getContext('2d')?.drawImage(out, 0, 0)
      src = owned
    }
  }

  const op = WIRED_BLEND_OP[layer.blend] ?? 'source-over'
  // Linked cloner: stamp the layer once per clone (back-to-front; original last).
  // No cloner ⇒ a single identity transform ⇒ exactly one draw as before.
  for (const c of expandClones(layer.cloner, W / H)) {
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * c.dopacity))
    ctx.globalCompositeOperation = op
    ctx.translate(W / 2 + (layer.x + c.dx) * W, H / 2 + (layer.y + c.dy) * H)
    const rot = layer.rotation + c.drot
    if (rot) ctx.rotate((rot * Math.PI) / 180)
    ctx.scale(layer.scale * c.dscale, layer.scale * c.dscale)
    ctx.drawImage(src, -fitW / 2, -fitH / 2, fitW, fitH)
    ctx.restore()
  }
}

/**
 * Bake local layers into a transparent RGBA PNG blob at W×H. Returns null if
 * there are no layers. Fonts must already be loaded (call `ensureLayerFonts`).
 */
export function bakeOverlay(layers: LocalLayer[], W: number, H: number): Promise<Blob | null> {
  if (!layers.length) return Promise.resolve(null)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(W))
  canvas.height = Math.max(1, Math.round(H))
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height) // stay transparent
  drawLocalLayers(ctx, layers, canvas.width, canvas.height, true) // export/bake: unclamped shader fields
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

/**
 * Ensure every text layer's font face is loaded so canvas text renders with the
 * real glyphs instead of a fallback. Resolves once all are ready (or timed out).
 */
export async function ensureLayerFonts(layers: LocalLayer[], W: number): Promise<void> {
  if (typeof document === 'undefined' || !(document as any).fonts) return
  const jobs: Promise<unknown>[] = []
  for (const layer of layers) {
    if (layer.kind !== 'text') continue
    const spec = `${layer.fontWeight} ${Math.max(8, layer.fontSize * W)}px ${cssFontStack(layer.fontFamily)}`
    try { jobs.push((document as any).fonts.load(spec)) } catch { /* ignore */ }
  }
  if (jobs.length) await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 1500))])
}
