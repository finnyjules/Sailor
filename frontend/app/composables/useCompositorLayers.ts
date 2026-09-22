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

export type LocalLayerKind = 'text' | 'rect' | 'ellipse' | 'line' | 'path' | 'image' | 'polygon' | 'star' | 'brush' | 'wired' | 'deal' | 'scatter'

// ── Motion painter indirection ───────────────────────────────────────────────
// paintLayerStack(t) needs the motion module, but motion/paint.ts imports
// drawLocalLayer from THIS file — a static import here would be a cycle.
// paint.ts registers its functions on first import; callers that pass a time
// (modal preview, bake) import '~/lib/motion/paint' and guarantee registration.
// Type-only imports are erased at runtime, so they don't create a cycle
// (evaluate.ts/types.ts don't import this file).
import type { LayerMotionState } from '~/lib/motion/evaluate'
import type { FrameMotion } from '~/lib/motion/types'
import { applyEffectDialTracks, type EffectDialTrack } from '~/lib/motion/effectTracks'
import { applyMotionxTracks, applyTextBehaviours, applyRevealBehaviours, type TextMotion } from '~/lib/motionx/adapter/frame'
import type { StoredBehaviour, Track as MotionxTrack } from '~/lib/motionx'
import { beginReveal, finishReveal, type RevealPass } from '~/lib/motionx/reveal/paint'
import { drawRevealShaderStyle, revealShaderReady } from '~/lib/motionx/reveal/paintPixels'
import { isShaderRevealStyle } from '~/lib/motionx/reveal'
import type { MotionReveal } from '~/lib/motionx/reveal'
// Letter behaviours (unified motion, text slice): the per-glyph draw seam. Pure — canvas
// primitives and plain data only — so the branches it serves inside drawText /
// drawTextOnPath below stay two lines each.
import { drawTextCells, lineAtRest, movingTextFrame, pathGlyphCells, textRunCells } from '~/lib/motionx/text/draw'
import { applyFillPhaseTracks } from '~/lib/motion/fillTracks'
import { axesToVariationSettings } from '~/lib/motion/axes'
import { expandClones, type Cloner, type CloneTransform } from '~/composables/useCloner'
import { copyClock, staggerOf } from '~/lib/motionx/copies'
import { clipFrameIndex, clipFrameUrl, clipPlayedSeconds, type ImageClip } from '~/lib/compositor/clip'
import { fillIsShader, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { effectReadsInput, getEffectSync } from '~/lib/shaderfx/catalogStore'
import { dealShaderFill } from '~/lib/compositor/mosaic'
import { paintScatter, SCATTER_STYLES, DEFAULT_SCATTER_STYLE, DEFAULT_SCATTER_SEED, type ScatterStyle } from '~/lib/compositor/scatter'
import { withFieldFrame, renderFieldWithBase, effectFollowsShape, type FieldRequest, type LensShape } from '~/lib/shaderfill/field'
import {
  hasPaint, resolvePaint, OBJECT_SHADER_FIELD_PX, type ShaderFieldFrameCtx,
} from '~/lib/paint/resolve'
import { drawQuadWarp, drawMeshWarp, type Quad, type Pt as WarpPt } from '~/lib/compositor/warp'
import { warpPoint, type WarpField } from '~/lib/compositor/meshWarp'
// Task 1's pure stroke-stack data model. `StrokeAlign` already exists as a local type in
// this file (see below), so it is NOT re-imported from there to avoid a second import
// path for the same idea.
import {
  strokeStackOf, strokeSupportsStack, wobbleSpecOf,
  type StrokeJoin, type StrokeInstance, type ShapeStrokeSpec,
} from '~/lib/compositor/strokeStack'
// The repo's one hex-alpha stripper — the same helper the 3D vary path uses before
// handing a swatch to THREE.Color (see `tintScratch` below).
import { stripAlpha } from '~/lib/color/convert'
import {
  polygonPathData, starPathData, roundedRectPathData, ellipsePathData,
} from '~/lib/compositor/polygonGeometry'
// Text-outline bridge (Frame slice F1): the CSS family → fontkit bytes, and one
// drawn run → positioned glyph outlines. Used by `drawText`'s collect sink and
// `textLayerOutline` below.
import { getCompositorFont, runToCommands } from '~/lib/compositor/textOutline'
import type { VtFont } from '~/lib/compositor/textOutline'
import { commandsToPathData, type VectorCommand } from '~/lib/vector/svg'
// Task 5's pure geometry for a SHAPES stroke, and the shape library it marches.
import { shapeStrokeMarkMatrices, pathOutlineFlattenTolerance, offsetPolyline, type WobbleSpec } from '~/lib/compositor/strokeShapes'
import { DEFAULT_FLATTEN_TOLERANCE, longestSubpath } from '~/lib/compositor/pathFlatten'
import { shapeById } from '~/lib/shapes/catalog'
import { shapePath2D } from '~/lib/shapes/path2d'
import { resolveGroupCascade, type LayerGroup } from '~/lib/compositor/layerGroups'
import { layoutExpressive, isAccentGlyph, type ExpressiveParams, type AccentRule } from '~~/shared/text-layout/expressive'
import { type PaintStroke, stampStrokes, strokeBounds } from '~/lib/compositor/brushStamp'
import {
  applyBlurPass, applyPasses, applyStackPost, chainActive,
  strokeAlphaAlignOf, strokeAlphaBand,
  MOTION_BLUR_SAMPLES, RADIAL_BLUR_MAX_ANGLE, ZOOM_BLUR_MAX_SCALE, motionSampleSpan,
  ROUGH_EDGE_MAX_W, INK_BLEED_MAX_W,
  type AdjustEffect, type BloomEffect, type DofEffect, type DuotoneEffect,
  type GradientMapEffect, type GrainEffect, type PostEffect, type VignetteEffect,
} from '~/lib/compositor/postEffects'
import { applyDof, dofAvailable, dofShouldRun } from '~/lib/compositor/dofPass'
import { depthImageFor, requestDepth, depthSourceFromViewUrl, type DepthRef } from '~/lib/compositor/depthRegistry'
import { ensureFillBitmaps, getFillBitmap } from '~/lib/paint/imageFillCache'
import { applyTornEdge, type TornEdgeSpec } from '~/lib/compositor/tornEdge'
import { applyFeather, type FeatherSpec } from '~/lib/compositor/feather'
import { luminanceMaskAlpha } from '~/lib/compositor/luminanceMask'
import {
  LruCache, SILHOUETTE_CACHE_CAP, SILHOUETTE_CACHE_MAX_BYTES, silhouetteCacheKey,
  silhouettePadPx as silhouettePadPxPure, silhouetteContentReady as silhouetteContentReadyPure,
  silhouetteRasterFits,
} from '~/lib/compositor/silhouetteCache'
import { VARY_PALETTE_MAX } from '~/lib/vary'
import { paintMaskRelease } from '~/lib/compositor/maskBreak'
import { displayRun, guideFromSpec, measureRunPx, placeGlyphs, placedGlyphsToCommands, type TextPathSpec } from '~/lib/compositor/textPath'
// Runtime import is safe: wiredLayer.ts only imports the WiredLayer TYPE back from
// this file, and type imports are erased — so this is not a module cycle.
import { wiredLayerHeight } from '~/lib/compositor/wiredLayer'
import { resolveGrid, defaultGrid, type FrameGrid } from '~/lib/frame/grid'
import { pickDealPaint, keptCell, forceKeptCell, type DealVocab } from '~/lib/compositor/dealVocab'
import { paneRegions, paneCellGradient, panePalette, defaultPane, type PaneParams } from '~/lib/compositor/pane'
import { paintModular, modularPalette, defaultModular, type ModularParams } from '~/lib/compositor/modular'
import { paintParcel, defaultParcel, type ParcelParams } from '~/lib/compositor/parcel'
import { paintMosh, defaultMosh, type MoshParams } from '~/lib/compositor/mosh'
import { paintCarve, defaultCarve, normalizeCarve, type CarveParams } from '~/lib/compositor/carve'
import { paintTotem, defaultTotem, normalizeTotem, type TotemParams } from '~/lib/compositor/totem'
import { paintBlueprint, defaultBlueprint, normalizeBlueprint, type BlueprintParams } from '~/lib/compositor/blueprint'
import type { ChaffParams } from '~/lib/compositor/chaff'
import type { StrandParams } from '~/lib/compositor/strand'
import type { HuskParams } from '~/lib/compositor/husk'

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
import { effectStackOf, orderablePasses, pinnedEffect, rasterablePasses, splitTrailingBlurs, isGeometryKind } from '~/lib/compositor/effectStack'
import { expandRecipe } from '~/lib/compositor/recipes'
// Frame slice F2: the pure outline transform (trim / offset / round corners / roughen).
// `applyGeometry(d, effects, {W})` is identity (same reference) when no geometry effect
// is enabled, so the no-effect draw stays byte-identical below.
import { applyGeometry, longShadowBody, type ResolvedSibling } from '~/lib/compositor/geometryEffects'
// Frame slice F3: the sibling-reference rail. `makeSiblingOutlineResolver` turns a geometry
// effect's `refLayerId` (a StackKey) into the referenced layer's outline, transformed into the
// referencing layer's frame. PRESENT-BUT-UNCONSUMED until F3 Task 2 (boolean) — no current
// geometry kind carries a `refLayerId`, so the resolver is never invoked and every render stays
// byte-identical. See `~/lib/compositor/siblingRef.ts`.
import { makeSiblingOutlineResolver, type SiblingResolver } from '~/lib/compositor/siblingRef'

// Layer effects (Figma-style) live in ~/lib/compositor/effectStack, which owns the whole
// vocabulary (kinds, canonical order, the read-through that turns any layer into an ordered
// stack). Imported for this file's own use AND re-exported, so every existing consumer of
// these names is unaffected.
//
// Both lines are needed: `export type { X } from '…'` re-exports X without binding it in this
// module's scope, and this file references these names in its own signatures.
import type {
  DropShadowEffect, LayerBlurEffect, InnerShadowEffect, BackgroundBlurEffect,
  TornEdgeEffect, FeatherEffect, LayerEffect, EffectInstance, EffectKind, WarpEffect,
  ShaderPixelEffect, BackdropShaderEffect, BackdropLuminanceMaskEffect,
  RisographEffect, PhotocopyEffect, LetterpressEffect,
} from '~/lib/compositor/effectStack'
export type {
  DropShadowEffect, LayerBlurEffect, InnerShadowEffect, BackgroundBlurEffect,
  TornEdgeEffect, FeatherEffect, LayerEffect, EffectInstance, EffectKind,
  ShaderPixelEffect, BackdropShaderEffect, BackdropLuminanceMaskEffect,
  RisographEffect, PhotocopyEffect, LetterpressEffect,
}
export type { AdjustEffect, BloomEffect, DofEffect, DuotoneEffect, GradientMapEffect, GrainEffect, PostEffect, VignetteEffect }

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
  /** Responsive Frames: how this layer holds to the frame (or its grid section)
   *  when the box changes shape. Absent ⇒ automatic (inferred from where it sits).
   *  Ignored while the Frame is fixed. See lib/frame/responsive. */
  pins?: import('~/lib/frame/responsive/types').Pins
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
  boxFit?: 'wrap' | 'shrink' | 'fill' | 'break'
                         // how the type meets its box: 'wrap' (fixed size, words
                         // wrap — the default), 'shrink' (shrink the font to fit
                         // the box), 'fill' (size the font to fill boxW, and boxH
                         // when set), 'break' (split even a single long word across
                         // lines and grow it to fill the box — needs boxH; without
                         // boxH it behaves like 'fill'). Absent => 'wrap'
                         // (byte-identical).
  /** Live variable-font axis values (wght/wdth/slnt/…). When present, `wght`
   *  drives the numeric font-weight in the canvas `font` shorthand (the only
   *  variable-axis path that renders on every browser); the full set is also
   *  applied via `fontVariationSettings` where the canvas supports it. */
  axes?: Record<string, number>
  /** Expressive per-word layout. When present, words are grouped into lines by
   *  count and each is placed by a seeded rule (overriding flow `align`).
   *  Absent ⇒ normal line-based rendering (byte-identical to before). */
  expressive?: ExpressiveParams
  /** Follow a curve instead of flat baselines. Absent ⇒ the layer renders exactly
   *  as it always has. When present, the guide is owned by this layer (it adds no
   *  entry to the layer list) and the box/wrap/valign/justify/expressive controls
   *  no longer apply — see lib/compositor/textPath.ts. */
  path?: TextPathSpec
  /** Frame slice F1: render this layer from real glyph OUTLINES (a single SVG
   *  `d` path) instead of `fillText`, so a geometry effect (slice F2) can
   *  transform the letterforms. Absent/false ⇒ `fillText`, byte-identical to
   *  today. Only takes effect for a layer whose font has a fetchable byte source
   *  (see `getCompositorFont`); a system font falls back to `fillText` forever. */
  renderAsOutline?: boolean
  /** Per-glyph accent face (Letters mode only): the resolved, loaded CSS family
   *  a subset of glyphs render in. Absent ⇒ every glyph uses the base face. */
  accentFace?: string
  accentRule?: AccentRule
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
  /** A poster STAND-IN: no real file yet — the renderer paints a clear grey box
   *  so image moves are visible before a photo is dropped. Absent ⇒ a normal image. */
  standIn?: boolean
  w: number; h: number    // normalized to canvas width (aspect preserved on drop)
  tint?: Paint            // optional fill blended over the image, clipped to its alpha
  tintBlend?: string      // blend mode for the tint (same names as layer blend)
  tintOpacity?: number    // 0..1 tint strength; default 1
  displaceMap?: DisplaceMapSpec // present ⇒ layer is a lens warping everything below
  /** Living image: a looping frame sequence made from this still (see lib/compositor/clip).
   *  Absent ⇒ the layer is exactly the still. `filename` stays the still and paints while
   *  the clip loads or if its folder is gone. */
  clip?: ImageClip
  /** Every clip generated for this layer, oldest first (see lib/compositor/clip withTake).
   *  `clip` is the active one; Remove clip keeps the takes so a take can be restored. */
  takes?: ImageClip[]
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
  // How the deal is painted. 'solid' (default / absent) = the shared grid, one
  // vocabulary fill per kept cell. 'pane' = the Pane generator (lib/compositor/pane):
  // its OWN row-masonry (every cell flush and filled — grid / density / inset are
  // ignored) with a corner-to-corner two-ink HSL ramp per cell, inks drawn by
  // distance along the vocabulary's solids. 'modular' = the Modular generator
  // (lib/compositor/modular): its OWN merged module grid over a background, each
  // module empty / solid / block field / dot cluster / line grid / 2-stop ramp, with
  // hairlines over the whole grid — grid / density / inset are ignored too.
  // 'parcel' = the Parcel generator (lib/compositor/parcel): a coarse two-tone
  // block field (ground + ink, every cell one or the other) with hairline survey
  // grids floating on top — grid / density / inset are ignored too.
  // 'mosh' = the Mosh generator (lib/compositor/mosh): a corrupted framebuffer —
  // uneven horizontal bands, each a different failure (confetti runs / torn
  // mosaic blocks / thin smears / scan rows / chevron), every mark a filled,
  // column-quantised rect in full-strength inks — grid / density / inset are
  // ignored too.
  // 'carve' = the Carve generator (lib/compositor/carve): ONE rectangle carved
  // into panels by repeated splits, each panel a printed treatment in two of its
  // own inks — flat, two-pitch stripes, stacked chevrons, a grainy ramp, or the
  // single hairline grid — grid / density / inset are ignored too.
  // 'totem' = the Totem generator (lib/compositor/totem): a framed screenprint
  // plate on a speckled mat, its left half carved into blocks of two-colour cell
  // rules and folded onto the right, with a small stack of rectangles standing at
  // its exact middle — grid / density / inset are ignored too.
  // 'blueprint' = the Blueprint generator (lib/compositor/blueprint): a technical
  // drafting grid — a cartesian minor/major lattice plus a polar overlay (radial
  // dashed spokes, concentric arcs with hatch ticks and angle labels) struck from a
  // seeded origin — grid / density / inset are ignored too.
  // 'oddgrid' / 'static' = the two SHADER styles (shader_effects/oddgrid.frag,
  // static.frag): the box is painted with a shader Fill through the same
  // resolvePaint path a rect uses, `shader` below holding the spec — grid /
  // density / inset are ignored; the grid's seed is mirrored into the spec.
  // Absent behaves as 'solid'.
  // People see these as the Mosaic element's STYLES (lib/compositor/mosaic maps the
  // words: 'solid' is "Tiles"); the field keeps its name so saved frames load as-is.
  cellFill?: 'solid' | 'pane' | 'modular' | 'parcel' | 'mosh' | 'carve' | 'totem' | 'blueprint' | 'oddgrid' | 'static'
  // The ShaderSpec the shader styles paint with (effectId = the cellFill, seed =
  // grid.gen.seed, speed 0, frame-anchored); only read when cellFill is 'oddgrid'
  // or 'static'. Absent ⇒ derived at the layer's seed (mosaicShaderSpec).
  shader?: ShaderSpec
  // The last ShaderSpec set for EACH shader style, so hopping Oddgrid → Static →
  // Oddgrid brings back the Oddgrid dials (a single `shader` slot would reseed
  // from the first Look on the way back). Written by mosaicStylePatch.
  shaderSpecs?: Partial<Record<'oddgrid' | 'static', ShaderSpec>>
  // Pane's tunables (rows / cells / vary / diag / soft / spread); only read when
  // cellFill is 'pane'. Absent ⇒ defaultPane().
  pane?: PaneParams
  // Modular's tunables (columns / unit / merge / type weights / blockFill / dot /
  // rules / ruleW + bg / rule colour / ordered inks); only read when cellFill is
  // 'modular'. Absent ⇒ defaultModular().
  modular?: ModularParams
  // Parcel's tunables (cells / cover / chunk / grids / blend + the ground / ink /
  // hairline colours); only read when cellFill is 'parcel'. Absent ⇒ defaultParcel().
  parcel?: ParcelParams
  // Mosh's tunables (bands / cols / mix / tears / runs / bright + the 8 inks);
  // only read when cellFill is 'mosh'. Absent ⇒ defaultMosh().
  mosh?: MoshParams
  // Carve's tunables (cuts / uneven / gap / mix / stripePitch / grain / gridDetail
  // + the 6 ordered inks); only read when cellFill is 'carve'. Absent ⇒ defaultCarve().
  carve?: CarveParams
  // Totem's tunables (border / mat / matGrain / keyline / regions / grain / mirror /
  // variety / core / coreRings + the 5 ordered inks); only read when cellFill is
  // 'totem'. Absent ⇒ defaultTotem().
  totem?: TotemParams
  // Blueprint's tunables (cells / major / minorAlpha / majorWidth / corner / origin /
  // angleStart / angleStep / angleSpread / arcs / arcGap / tickStep / labels + the 3
  // role inks); only read when cellFill is 'blueprint'. Absent ⇒ defaultBlueprint().
  blueprint?: BlueprintParams
}

/**
 * A "scatter": ONE self-painting layer holding a scatter of thrown marks — the
 * Scatter element (lib/compositor/scatter holds the STYLE registry). A sibling of
 * the Mosaic element, not one of its styles: a mosaic is a composition (a frame
 * divided and filled), a scatter is marks thrown across a sheet. Which marks is
 * `style`; that style's own dials live under a field named after it, and `seed`
 * drives the whole picture, so "New variation" re-rolls it coherently. Like a deal
 * it is normal content: it renders, bakes and exports, and it is clipped to its own
 * box (both dims normalized to the canvas WIDTH, like RectLayer).
 */
export interface ScatterLayer extends LayerCommon {
  kind: 'scatter'
  w: number; h: number        // box size, BOTH normalized to canvas width (like RectLayer)
  seed: number                // 1..9999 — the one variation
  // Which generator paints this layer. 'chaff' = the Chaff generator
  // (lib/compositor/chaff): blades thrown at the paper, each an arc with a width
  // profile, printed through a half-size mask that a two-scale mottle thresholds
  // into two inks. Unknown / absent behaves as the default style (scatterStyleOf).
  style: ScatterStyle
  // Chaff's tunables (count / size / vary / apart / shape / curve / taper / slim /
  // mottle / coarse / grain + its two ordered role inks); only read when style is
  // 'chaff'. Absent ⇒ defaultChaff().
  chaff?: ChaffParams
  // Strand's tunables (count / len / wander / branch / thick / rod / notch / rough /
  // offset / edge / texKind / tex / grain + its three ordered role inks); only read
  // when style is 'strand'. Absent ⇒ defaultStrand().
  strand?: StrandParams
  // Husk's tunables (count / size / vary / lump / bite / eat / tex / grain + its
  // three ordered role inks); only read when style is 'husk'. Absent ⇒ defaultHusk().
  husk?: HuskParams
}

export type LocalLayer = TextLayer | RectLayer | EllipseLayer | LineLayer | ImageLayer | PathLayer | PolygonLayer | StarLayer | BrushLayer | WiredLayer | DealLayer | ScatterLayer

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
    pane: defaultPane(),
    modular: defaultModular(),
    parcel: defaultParcel(),
    mosh: defaultMosh(),
    carve: defaultCarve(),
    totem: defaultTotem(),
    blueprint: defaultBlueprint(),
    ...partial,
    grid,
  }
}

/**
 * The Mosaic element the toolbar's Shapes menu stamps: ONE deal layer filling the
 * frame (`w: 1`, `h: aspect` — boxes are width-normalized, so a frame's H/W is the
 * height that fills it), centred, in the Modular style at its defaults, on a fresh
 * generated grid of its own. A pure seam so the unit suite can pin the stamped shape
 * without mounting the modal. `kind` stays 'deal' and the style field stays
 * `cellFill` (persisted data is untouched; "Mosaic" is the label people see).
 */
export function newMosaicLayer(aspect: number): DealLayer {
  const h = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  return createDealLayer({ cellFill: 'modular', w: 1, h, x: 0.5, y: 0.5 })
}

/**
 * A scatter layer filling the whole frame by default, in the default style at its
 * defaults. EVERY registered style's params are seeded (like createDealLayer), so a
 * style hop in the inspector never paints a blank box while its dials catch up.
 */
export function createScatterLayer(partial: Partial<ScatterLayer> = {}): ScatterLayer {
  const styles: Record<string, unknown> = {}
  for (const row of SCATTER_STYLES) styles[row.id] = row.defaults()
  return {
    id: newId(), kind: 'scatter',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 1, h: 1,
    seed: DEFAULT_SCATTER_SEED,
    style: DEFAULT_SCATTER_STYLE,
    ...(styles as { chaff: ChaffParams; strand: StrandParams; husk: HuskParams }),
    ...partial,
  }
}

/**
 * The Scatter element the toolbar's Shapes menu stamps: ONE scatter layer filling
 * the frame (`w: 1`, `h: aspect` — boxes are width-normalized, so a frame's H/W is
 * the height that fills it), centred, in the Chaff style at its defaults. A pure
 * seam so the unit suite can pin the stamped shape without mounting the modal.
 */
export function newScatterLayer(aspect: number): ScatterLayer {
  const h = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  return createScatterLayer({ style: DEFAULT_SCATTER_STYLE, w: 1, h, x: 0.5, y: 0.5 })
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
 * The stroke STACK, carried through the shape→path conversion.
 *
 * This function copied only the legacy `stroke`/`strokeWidth`/`strokeAlign`/`strokeDash`
 * pair, which a stacked layer does not have: `writeStrokeStackToLayer` clears every one of
 * them in the same patch that stores `strokes`. So converting a multi-stroke rect for a
 * boolean op or the node editor produced a path with NO outline at all — every stroke
 * silently dropped, not merely the second one.
 *
 * Both shapes are copied, and the legacy pair is left exactly as it was: `strokeStackOf`
 * prefers a LIVE legacy field over the array (see its own note on an older build editing a
 * newer document), so carrying both means the converted layer reads back through the same
 * branch the source layer did. Units need no conversion — the conversion always emits
 * `scale: 1`, where a path layer's local units ARE width-normalized units, the same ones a
 * rect stores its widths and distances in.
 *
 * Omitted rather than written as `undefined` when there is no stack, so a legacy layer's
 * converted path is byte-identical to what it was before this existed.
 */
function strokeStackCarry(layer: LocalLayer): Record<string, unknown> {
  const s = (layer as unknown as { strokes?: unknown }).strokes
  return Array.isArray(s) && s.length ? { strokes: s } : {}
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
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash, ...strokeStackCarry(layer),
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
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash, ...strokeStackCarry(layer),
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
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash, ...strokeStackCarry(layer),
    })
  }
  if (layer.kind === 'star') {
    const d = starPathData(layer.points, layer.innerRatio, layer.w, layer.h, layer.cornerRadius)
    if (!d) return null
    return createPathLayer({
      d, bbox: { w: layer.w, h: layer.h }, scale: 1,
      x: layer.x, y: layer.y, rotation: layer.rotation, opacity: layer.opacity,
      fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
      strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash, ...strokeStackCarry(layer),
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

// ── Living-image clip frames ─────────────────────────────────────────────────
// Keyed by `${dir}:${frames}` (see `clipKey`), not dir alone — a regenerated folder or
// a clip whose stored `frames` count no longer matches what's on disk must never hand
// back the wrong (stale-length or wrong-content) array. A folder loads ONCE (all
// frames, in order); until every frame is in, the layer keeps painting its still, so a
// half-loaded clip never flickers.
const _clipCache = new Map<string, HTMLImageElement[]>()
const _clipLoading = new Map<string, Promise<void>>()
// A clip key where at least one frame failed to load. Without this, a broken folder
// would re-issue all N frame requests on every `ensureLayerImages` call (i.e. every
// layer edit) forever, since `loadClip` only populates `_clipCache` on full success —
// the still keeps painting either way, which is the intended fallback.
const _clipFailed = new Set<string>()
const CLIP_LOAD_PARALLEL = 8
// How many whole decoded clips may sit in memory at once. A clip is N full-size RGBA
// bitmaps (a 10 s 24 fps 1024px clip is ~240 frames ≈ 1 GB decoded), so an unbounded
// Map was a leak with a frame budget: every clip a session ever generated stayed
// resident. Two is enough for the one being edited plus the one it was compared to.
const CLIP_CACHE_MAX = 2

// The clip keys the last swept layer list actually referenced. Empty until the first
// `sweepClipCache` call, which makes the eviction below behave as a plain oldest-first
// cap for any surface that never sweeps.
const _clipLive = new Set<string>()

/**
 * Insert with an oldest-first eviction, so `_clipCache` never holds more than
 * CLIP_CACHE_MAX clips. Map iteration order IS insertion order, so the first key is the
 * oldest — re-inserting an existing key keeps its original position, which is fine here:
 * a key already cached is by definition not the one to drop.
 *
 * A key the CURRENT layer list still references is never evicted, even over the cap. The
 * cap and the sweep would otherwise disagree on a frame carrying three living images: the
 * sweep spares all three, the cap drops one, `ensureClip` sees the miss and re-fetches it,
 * and the frame re-downloads a clip on every layer edit forever. The cap's real job is
 * bounding what is kept AFTER it stops being referenced; the sweep bounds the rest.
 */
function putClipFrames(key: string, frames: HTMLImageElement[]): void {
  _clipCache.set(key, frames)
  if (_clipCache.size <= CLIP_CACHE_MAX) return
  for (const k of [..._clipCache.keys()]) {
    if (_clipCache.size <= CLIP_CACHE_MAX) break
    if (k !== key && !_clipLive.has(k)) _clipCache.delete(k)
  }
}

/**
 * Drop every cached clip the given layers no longer reference. Both callers of
 * `ensureLayerImages` (the modal and the Frame card) pass the FULL layer list, so a key
 * that is not referenced is a clip that was removed, regenerated, or whose layer is
 * gone — keeping its frames alive only costs memory. `_clipFailed` is swept the same
 * way, so a folder that is repaired (or a layer re-pointed at a good one) gets a fresh
 * attempt instead of being blacklisted for the life of the tab.
 *
 * Exported for the unit suite: `ensureLayerImages` returns early with no `window`, so
 * this is the only way to exercise the sweep in a node-env test.
 */
export function sweepClipCache(layers: LocalLayer[]): void {
  const live = new Set<string>()
  for (const l of layers) {
    if (l.kind === 'image' && l.clip) live.add(clipKey(l.clip))
  }
  for (const key of [..._clipCache.keys()]) if (!live.has(key)) _clipCache.delete(key)
  for (const key of [..._clipFailed]) if (!live.has(key)) _clipFailed.delete(key)
  _clipLive.clear()
  for (const key of live) _clipLive.add(key)
}

/** Test seam: the clip keys currently resident, oldest first. */
export function __clipCacheKeysForTest(): string[] {
  return [..._clipCache.keys()]
}

function clipKey(clip: ImageClip): string {
  return `${clip.dir}:${clip.frames}`
}

function loadOne(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => res(null)
    im.src = url
  })
}

async function loadClip(clip: ImageClip): Promise<void> {
  const out: (HTMLImageElement | null)[] = new Array(clip.frames).fill(null)
  let next = 0
  const worker = async () => {
    while (next < clip.frames) { const i = next++; out[i] = await loadOne(clipFrameUrl(clip, i)) }
  }
  await Promise.all(Array.from({ length: Math.min(CLIP_LOAD_PARALLEL, clip.frames) }, worker))
  const key = clipKey(clip)
  // One missing frame = a broken folder: keep the still rather than a stuttering loop,
  // and remember the key so `ensureClip` stops re-fetching it on every call.
  if (out.every(Boolean)) putClipFrames(key, out as HTMLImageElement[])
  else {
    _clipFailed.add(key)
    console.warn('[Frame] clip folder incomplete, keeping the still', clip.dir)
  }
}

function ensureClip(clip: ImageClip): Promise<void> {
  const key = clipKey(clip)
  if (_clipCache.has(key) || _clipFailed.has(key)) return Promise.resolve()
  let p = _clipLoading.get(key)
  if (!p) {
    p = loadClip(clip).finally(() => _clipLoading.delete(key))
    _clipLoading.set(key, p)
  }
  return p
}

/** The frame a living image shows at `tSec` for clone `k` of `n`, or null when the
 *  layer has no clip or its frames are not all loaded yet (paint the still then). */
export function clipFrameFor(layer: LocalLayer, tSec: number, k: number, n: number): HTMLImageElement | null {
  if (layer.kind !== 'image' || !layer.clip) return null
  const frames = _clipCache.get(clipKey(layer.clip))
  if (!frames || !frames.length) return null
  return frames[clipFrameIndex(layer.clip, tSec, k, n, layer.cloner?.phase ?? 1)] ?? null
}

/** Test seam: seed `_clipCache` directly, under the same `clipKey` `ensureClip` would
 *  use, so a unit test can exercise `clipFrameFor`'s populated-cache path without a DOM
 *  `Image` loader. A plain array of sentinels is enough — `clipFrameFor` only ever
 *  indexes into whatever is here. */
export function __setClipFramesForTest(clip: ImageClip, frames: unknown[]): void {
  putClipFrames(clipKey(clip), frames as HTMLImageElement[])
}

/** One clock per living image, in the shape `deriveMasterClock` takes. Played length,
 *  so a slowed clip still completes whole cycles in the export. */
export function clipClocks(layers: LocalLayer[]): { duration: number; fps: number }[] {
  const out: { duration: number; fps: number }[] = []
  for (const l of layers) {
    if (l.kind !== 'image' || !l.clip) continue
    const duration = clipPlayedSeconds(l.clip)
    if (duration > 0) out.push({ duration, fps: l.clip.fps })
  }
  return out
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
 *  `drawLocalLayer` can paint it. Resolves once all are loaded (or errored). Also
 *  loads each image layer's clip frames (see above), when it has one. */
export async function ensureLayerImages(layers: LocalLayer[]): Promise<void> {
  // Before anything else, and before the no-DOM bail: a layer list that no longer
  // names a clip is the signal that its frames can go (see sweepClipCache).
  sweepClipCache(layers)
  if (typeof window === 'undefined') return
  const jobs: Promise<unknown>[] = []
  for (const layer of layers) {
    if (layer.kind !== 'image') continue
    const url = imageLayerUrl(layer.filename)
    if (!_imageCache.get(url)?.complete) {
      jobs.push(new Promise((res) => {
        const im = new Image()
        im.onload = () => { _imageCache.set(url, im); res(null) }
        im.onerror = () => res(null)
        im.src = url
      }))
    }
    if (layer.clip && layer.clip.frames > 0) jobs.push(ensureClip(layer.clip))
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

/** The clone being painted right now (set by paintLayer's cloner loop, read by the
 *  image branch of drawLayerContent). Outside a cloner loop it is the original alone. */
const _cloneSlot = { k: 0, n: 1 }

// Frame slice F3: the current stack's sibling-outline resolver, bound to the live layer list at
// paintLayerStack time (module-global like `_fieldCtx`, for the same reason: `drawLayerContent`
// and `computedOutlineD` are reached through several closures that never carried the layer list).
// `_siblingResolveFor(self)` yields the `(key) => ResolvedSibling | null` closure a geometry
// effect's `refLayerId` resolves through. `null` outside a paint (thumbnails, hit tests) — the
// seam is then simply absent, which is byte-identical because no current kind consumes it.
// paintLayerStack sets it around its draw loop and clears it in the finally.
let _siblingResolveFor: ((self: LocalLayer) => (key: string) => ResolvedSibling | null) | null = null

/** How many canvas PIXELS one unit of a layer's OUTLINE `d` renders as — the isotropic content
 *  scale `drawLayerContent` applies: `1` for rect/ellipse/text (their `d` is already px),
 *  `scale·W` for a path (its ctx is scaled by `scale·W`), and `W` for a polygon/star (drawn as a
 *  `scale: 1` path). Fed to `layerAffine` so a sibling outline lands in the referencing layer's
 *  own units. */
function outlineUnitPx(layer: LocalLayer, W: number): number {
  if (layer.kind === 'path') return ((layer as unknown as { scale?: number }).scale || 1) * W
  if (layer.kind === 'polygon' || layer.kind === 'star') return W
  return 1
}

/** Build the sibling-outline resolver for one stack render. The sibling's own outline is
 *  computed with sibling-resolution DISABLED (`computedOutlineD(sibling, W)` with no resolver) —
 *  the S2 "sibling built with no ctx" cycle guard, so a partner's own boolean/morph can never
 *  recurse through here. */
function buildSiblingResolver(localLayers: LocalLayer[], W: number, H: number): SiblingResolver<LocalLayer> {
  return makeSiblingOutlineResolver<LocalLayer>({
    W, H, layers: localLayers,
    keyOf: l => `l:${l.id}`,
    eligible: l => canTakeGeometry(l),
    outlineOf: (l) => { const d = computedOutlineD(l, W); return d != null ? { d } : null },
    placementOf: l => ({
      x: l.x, y: l.y, rotation: l.rotation, skewX: l.skewX, skewY: l.skewY, unitPx: outlineUnitPx(l, W),
    }),
  })
}

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
export function transformCase(s: string, t: TextLayer['textTransform']): string {
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
 * Final render lines plus per-line justification metadata: explicit newlines,
 * then — when the layer has a text box (`boxW`) — greedy word-wrap each line to
 * fit the box. A word longer than the box overflows on its own line rather than
 * breaking mid-word, EXCEPT in 'break' fit (with a boxH set), where an over-long
 * word is split across lines at the character so a single word like NOISE stacks
 * (NO / ISE) to fill its box. Needs a 2D context for measurement; without one,
 * falls back to explicit lines only.
 *
 * `ragged[i]` marks a line that justify (`align: 'justify'`) must NOT stretch
 * edge-to-edge: the last line of a paragraph that actually wrapped (>1 line), so
 * body copy ends ragged-left like proper typesetting. A single-line paragraph
 * (e.g. a two-word title) is never ragged, so it still justifies full-width.
 */
export function wrappedTextLinesMeta(
  ctx: CanvasRenderingContext2D | null,
  layer: TextLayer,
  W: number,
): { lines: string[]; ragged: boolean[] } {
  const manual = textLines(layer)
  const boxPx = (layer.boxW ?? 0) * W
  // No wrapping: each explicit line is its own single-line paragraph, so none is
  // a wrapped-paragraph tail — justify treats them all as full lines.
  if (!ctx || !(boxPx > 0)) return { lines: manual, ragged: manual.map(() => false) }
  applyFont(ctx, layer, W)
  // Character-breaking only makes sense with a height to fill; without one it is
  // ambiguous (a word could grow forever), so 'break' falls back to plain wrap.
  const brk = layer.boxFit === 'break' && (layer.boxH ?? 0) > 0
  const fitsW = (s: string) => ctx.measureText(s).width <= boxPx
  const out: string[] = []
  // Split a token wider than the box into char chunks; returns the trailing
  // partial chunk for the caller to keep accumulating onto.
  const breakToken = (word: string): string => {
    let chunk = ''
    for (const ch of word) {
      if (chunk && !fitsW(chunk + ch)) { out.push(chunk); chunk = ch }
      else chunk += ch
    }
    return chunk
  }
  const ragged: boolean[] = []
  for (const line of manual) {
    const startLen = out.length
    const words = line.split(/\s+/).filter(Boolean)
    if (!words.length) { out.push('') }
    else {
      let cur = ''
      for (const word of words) {
        const candidate = cur ? `${cur} ${word}` : word
        if (fitsW(candidate)) { cur = candidate; continue }
        if (cur) { out.push(cur); cur = '' }         // flush what we have
        if (fitsW(word) || !brk) cur = word          // fits alone, or we don't break (may overflow)
        else cur = breakToken(word)                  // split the long word; keep the tail
      }
      if (cur) out.push(cur)
    }
    // Only a paragraph that wrapped (>1 line) gets a ragged tail; a single line
    // stays justifiable so titles still span the box edge-to-edge.
    const n = out.length - startLen
    for (let i = startLen; i < out.length; i++) ragged.push(n > 1 && i === out.length - 1)
  }
  return { lines: out, ragged }
}

/** Render lines only (see {@link wrappedTextLinesMeta}). */
export function wrappedTextLines(ctx: CanvasRenderingContext2D | null, layer: TextLayer, W: number): string[] {
  return wrappedTextLinesMeta(ctx, layer, W).lines
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

export function cssFontStack(family: string): string {
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
    // Curved text's extent is the guide's, not a line block's. Without this the
    // selection box, drag hit-test, rotation pivot, mask fit and every effect's
    // offscreen would all size themselves to a line of text that isn't drawn.
    // Inflated by the font size so ascenders/descenders either side of the
    // baseline stay inside the box.
    if (layer.path && ctx) {
      const guide = textPathGuide(ctx, layer, W)
      if (guide) {
        const b = guide.bounds()
        const pad = layer.fontSize * W
        return { w: Math.max(b.w + pad, 4), h: Math.max(b.h + pad, 4) }
      }
    }
    const lines = wrappedTextLines(ctx, layer, W)
    const lineH = layer.fontSize * W * layer.lineHeight
    // With a text box, the box width IS the layer width (selection/handles
    // track the box, not the glyph extents). An explicit boxH is the box height
    // too — so it shows in the selection box and resizes with the handles;
    // without it, the height falls back to the painted lines.
    if ((layer.boxW ?? 0) > 0) {
      const hpx = (layer.boxH ?? 0) > 0 ? layer.boxH! * W : Math.max(lines.length * lineH, lineH)
      return { w: Math.max(layer.boxW! * W, 4), h: Math.max(hpx, 4) }
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
 * How far (px) a text layer's block centre sits from its stored y-origin, so the
 * valign-anchored edge stays put as the block's height changes. The layer's y
 * marks the anchored edge: `top` ⇒ the top edge (block grows down), `bottom` ⇒
 * the bottom edge (block grows up), `middle`/`justify`/absent ⇒ centred (0), the
 * legacy behaviour every existing layer keeps. `boxHPx` is the block/box height
 * from `localLayerBox`. Both the renderer and the editor's box geometry read this
 * so the drawn text and its selection box stay in lockstep.
 */
export function textVAlignCenterOffset(layer: { kind: string; valign?: string }, boxHPx: number): number {
  if (layer.kind !== 'text') return 0
  return layer.valign === 'top' ? boxHPx / 2 : layer.valign === 'bottom' ? -boxHPx / 2 : 0
}

/**
 * Half the ink extent of ONE mark of a `style: 'shapes'` stroke, in the stroke's own stored
 * units — how far past its centre a mark can put ink, which is what such a stroke adds to its
 * `distance` to reach.
 *
 * Read off `shapeStrokeMarkMatrices`' placement maths rather than guessed at. A mark is the
 * library shape's ink box fitted into `size` (`s = min(size/bw, size/bh)`, so the fitted box
 * is `s·bw × s·bh` and its LARGER side is exactly `size`), CENTRED on its guide point. Upright
 * (`follow: false`) the furthest ink therefore sits half the larger side away — exactly
 * `size / 2`. Following the tangent, that same box turns about that same centre, so a corner
 * swings out to half the DIAGONAL: a square mark really reaches `size · √2 / 2`, 41% further
 * than `size / 2`, and padding for `size / 2` alone would clip it.
 *
 * 0 for every case `paintShapeStroke` itself no-ops on — no payload, an unknown `shapeId`, a
 * non-positive `size`/`spacing`, a degenerate ink box — so an inert entry pads nothing.
 */
function shapeStrokeMarkHalfExtent(spec: ShapeStrokeSpec | undefined): number {
  if (!spec || !(spec.size > 0) || !(spec.spacing > 0)) return 0
  const shape = shapeById(spec.shapeId)
  if (!shape) return 0
  const [, , bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0)) return 0
  const s = Math.min(spec.size / bw, spec.size / bh)
  return (spec.follow === false ? Math.max(s * bw, s * bh) : Math.hypot(s * bw, s * bh)) / 2
}

/**
 * How far the WIDEST-reaching stroke in a layer's stack lands beyond `localLayerBox`, in px —
 * the layer's HONEST reach, with nothing excused.
 *
 * Reads the stack, so a layer with several strokes answers for the one that reaches furthest:
 * a band by its alignment and `width`, a stroke pushed out by its `distance` by where it
 * actually lands, and a marching-shapes stroke by its mark size (see
 * `shapeStrokeMarkHalfExtent` — its `width` is a stale leftover the inspector no longer even
 * shows). A path's `scale` is folded in, because a path stores its stroke numbers in local
 * units at scale 1.
 *
 * This is the number a RASTER wants: the torn-edge / feather silhouette only has to be big
 * enough, and anything smaller cuts ink off. A caller sizing GEOMETRY wants `cornerPinPadPx`
 * below instead — read its comment before reaching for either.
 *
 * Still 0 for no stroke, a zero width, a `line` layer, and any kind without a stack at all.
 */
export function strokeReachPx(layer: LocalLayer, W: number): number {
  return strokeStackReachPx(layer, W, true)
}

/**
 * The pad a CORNER-PIN (or any other box-sized) offscreen needs so a stroke survives instead
 * of landing off-canvas and getting clipped away (see `strokeAligned`'s 'outside' knockout,
 * which paints the whole 2×width ring starting AT the silhouette edge — none of it inside the
 * box).
 *
 * `strokeReachPx` MINUS ONE DELIBERATE EXCEPTION, which is why it is its own named export
 * rather than a boolean argument: a stroke that is centre-aligned AND sits at distance 0
 * contributes 0 here, even though half its width genuinely lands outside the box. That is
 * load-bearing. This same pad also SCALES THE CORNER-PIN QUAD (`hw = box.w / 2 + pad`, and
 * every corner is then pulled by `cp.*.x * hw`), so counting the default centred stroke would
 * silently re-warp every already-saved corner-pinned frame. Such a stroke being clipped at
 * half its width inside a pinned offscreen is PRE-EXISTING behaviour; changing it needs the
 * quad to stop riding the pad first.
 *
 * Every other stroke contributes its real reach: outside-aligned, centred / inside with a
 * non-zero `distance`, or marching shapes — none of those cases could exist before the stack
 * did, so no saved frame's warp can move because of them.
 *
 * TEXT gets the exception in a WIDER form: a text stroke at distance 0 contributes 0 whatever
 * alignment it claims. `strokeText` has no path, so the text painter has always drawn a
 * centred outline and ignored `strokeAlign` outright — yet a saved text layer can perfectly
 * well carry `strokeAlign: 'outside'` from the shared inspector row. Reading that alignment
 * here would re-warp a saved pinned frame for ink that has never been anywhere but on the
 * glyph edge. A text stroke at a DISTANCE is a different thing entirely: it is a real dilation
 * band (see `paintTextStrokeBands`), it lands `distance + width` past the glyphs, no saved
 * frame can carry one, and without this pad the corner-pin offscreen clips it. Text's
 * SILHOUETTE overhang is still not this helper's business — see `silhouettePadPx`, whose text
 * branch is a full em plus the outline's reach.
 */
export function cornerPinPadPx(layer: LocalLayer, W: number): number {
  return strokeStackReachPx(layer, W, false) + geometryOutwardPx(layer, W)
}

/**
 * How far a layer's ENABLED geometry effects (F2) grow its outline OUTWARD, logical px.
 * A box-sized offscreen (corner-pin quad, DOF, torn-edge / feather silhouette) is sized
 * from `localLayerBox`, which knows nothing about the geometry transform — so a positive
 * `offset` or a `roughen` displaces ink PAST the box edge and the raster clips it. This
 * term grows the pad to contain the transformed outline.
 *
 * Per kind (matching `geometryEffects.ts`'s pixel math): offset grows by `max(0, distance)·W`
 * (a negative distance shrinks — 0 outward growth); roughen displaces by up to `amount·W`
 * along the outward normal; trim only removes and round_corners only cuts corners inward, so
 * both grow 0. The MAX across the layer's effects, not a sum — the single furthest-pushing
 * effect bounds the answer this helper reports (see the whole-slice note about a big offset
 * AND a big roughen together, a rarer combination left slightly under-padded on purpose).
 *
 * This term is ADDED to the stroke reach at both call sites, never max'd with it: the
 * geometry transform grows the OUTLINE first and the stroke is then drawn on that grown
 * outline, so the stroke reaches beyond the geometry growth — the two extents stack.
 *
 * 0 when the layer can't take geometry (`canTakeGeometry`: non-vector kinds, decorated
 * text) OR carries no enabled geometry effect — so a layer with none gets the byte-identical
 * pad it had before this fix, and the corner-pin quad it rides never re-warps a saved frame.
 */
export function geometryOutwardPx(layer: LocalLayer, W: number): number {
  if (!canTakeGeometry(layer)) return 0
  let out = 0
  for (const e of layerGeometryEffects(layer)) {
    const r = e as unknown as { type: string; distance?: number; amount?: number; length?: number }
    let grow = 0
    if (r.type === 'offset') {
      const d = typeof r.distance === 'number' && Number.isFinite(r.distance) ? r.distance : 0
      grow = Math.max(0, d) * W
    } else if (r.type === 'roughen') {
      const a = typeof r.amount === 'number' && Number.isFinite(r.amount) ? r.amount : 0
      grow = Math.max(0, a) * W
    } else if (r.type === 'long_shadow') {
      // The shadow body reaches at most `length·W` px beyond the outline along the cast angle
      // (the offset vector has magnitude `length·W`), so `length·W` is a safe radial bound on
      // every side — the same width-normalized ×W the other outward-growing kinds use.
      const l = typeof r.length === 'number' && Number.isFinite(r.length) ? r.length : 0
      grow = Math.max(0, l) * W
    }
    // trim (removes) and round_corners (cuts inward) never grow the outline outward → 0.
    if (grow > out) out = grow
  }
  return out
}

/**
 * How far a layer's ENABLED `outer_glow` effects blur their halo OUTSIDE the silhouette, logical
 * px — the MAX `radius·W` across the stack (0 with none). The outer-glow halo is built from the
 * layer alpha and blurred by `radius·W`, so it reaches roughly that far past the silhouette edge;
 * a box-sized raster must grow to hold it or the halo is clipped at the raster edge (the
 * long_shadow / F2 lesson — see `geometryOutwardPx`).
 *
 * Applies to ANY layer kind (image included), so unlike `geometryOutwardPx` it is NOT gated on
 * `canTakeGeometry`. 0 when no outer glow is present, keeping the raster (and the identity A/B)
 * byte-identical for every existing layer.
 *
 * NOTE on reachability: today an `outer_glow` in a layer's stack makes `rasterablePasses` false
 * (it is neither torn edge / feather nor layer blur), so the layer renders through the
 * FULL-DEVICE-CANVAS offscreen path in `paintLayer` — exactly like `bloom` — where the halo has
 * the whole canvas to bleed into and is never clipped by a box. This term is folded into
 * `silhouettePadPx` defensively, per the F4 outward-growth rule, so that IF a future change ever
 * bakes an outer glow into a box-sized silhouette raster the halo is already contained; it costs
 * one cheap stack scan and returns 0 in the overwhelmingly common no-glow case.
 */
export function outerGlowOutwardPx(layer: LocalLayer, W: number): number {
  let out = 0
  for (const e of effectStackOf(layer as unknown as Parameters<typeof effectStackOf>[0])) {
    if (e.type !== 'outer_glow' || e.visible === false) continue
    const r = e as unknown as { radius?: number }
    const rad = typeof r.radius === 'number' && Number.isFinite(r.radius) ? r.radius : 0
    const grow = Math.max(0, rad) * W
    if (grow > out) out = grow
  }
  return out
}

/**
 * How far a layer's ENABLED `stroke_from_alpha` effects paint OUTSIDE the silhouette, logical px —
 * the MAX outward band reach across the stack (0 with none). An `outside` stroke dilates the alpha
 * outward by `width·W`, a `center` one by `width·W / 2`, an `inside` one not at all — exactly
 * `strokeAlphaBand(...).outerPx`, so this reads the SAME arithmetic the pass uses (align respected).
 *
 * Applies to ANY layer kind (image included), like `outerGlowOutwardPx`, and is folded into
 * `silhouettePadPx` beside it (NOT `cornerPinPadPx`, which re-warps): the alpha-traced band grows
 * OUTSIDE the raster and would be clipped at its edge otherwise. 0 when no stroke_from_alpha is
 * present (or every one is inside-only), keeping the raster and the identity A/B byte-identical.
 *
 * Like the glow pad, this is defensive today: a `stroke_from_alpha` makes `rasterablePasses` false
 * (it is neither torn edge / feather nor layer blur), so the layer renders through the full-device
 * offscreen path in `paintLayer`, where the band has the whole canvas to grow into. It costs one
 * cheap stack scan and returns 0 in the common no-stroke case.
 */
export function strokeAlphaOutwardPx(layer: LocalLayer, W: number): number {
  let out = 0
  for (const e of effectStackOf(layer as unknown as Parameters<typeof effectStackOf>[0])) {
    if (e.type !== 'stroke_from_alpha' || e.visible === false) continue
    const r = e as unknown as { width?: number; align?: unknown }
    const wid = typeof r.width === 'number' && Number.isFinite(r.width) ? r.width : 0
    const grow = strokeAlphaBand(Math.max(0, wid) * W, strokeAlphaAlignOf(r.align)).outerPx
    if (grow > out) out = grow
  }
  return out
}

/**
 * How far a layer's ENABLED motion-blur effects smear OUTSIDE the silhouette, logical px — the MAX
 * outward reach across `directional_blur` / `radial_blur` / `zoom_blur` (0 with none). Read from the
 * SAME arithmetic the passes use (`motionSampleSpan(MOTION_BLUR_SAMPLES)` × the full swing):
 *  - directional smears along the angle by `distance·W`, reaching `distance·W · span` at the extreme
 *    tap (direction drops out of a bounding pad — it grows the same each way);
 *  - radial rotates about `(centerX·bw, centerY·bh)`, moving the farthest corner (radius `maxR`) by
 *    up to `maxR · amount·RADIAL_BLUR_MAX_ANGLE · span` (arc length ≥ chord, a safe upper bound);
 *  - zoom scales about that centre, moving the farthest corner by `maxR · amount·ZOOM_BLUR_MAX_SCALE
 *    · span`.
 * `box` is the pre-pad layer box in logical px, so `maxR` is measured there.
 *
 * Applies to ANY layer kind (image included), folded into `silhouettePadPx` beside the glow / stroke
 * terms (NOT `cornerPinPadPx`, which re-warps). 0 when no motion blur is present (or every amount /
 * distance is 0), keeping the raster and the identity A/B byte-identical.
 *
 * Like the glow / stroke pads, this is defensive today: a motion blur makes `rasterablePasses` false
 * (it is neither torn edge / feather nor layer blur), so the layer renders through the full-device
 * offscreen path in `paintLayer`, where the smear has the whole canvas to grow into. It costs one
 * cheap stack scan and returns 0 in the common no-blur case.
 */
export function motionBlurOutwardPx(layer: LocalLayer, W: number, box: { w: number; h: number }): number {
  const span = motionSampleSpan(MOTION_BLUR_SAMPLES)
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  let out = 0
  for (const e of effectStackOf(layer as unknown as Parameters<typeof effectStackOf>[0])) {
    if (e.visible === false) continue
    if (e.type === 'directional_blur') {
      const dist = Math.max(0, num((e as unknown as { distance?: number }).distance))
      out = Math.max(out, dist * W * span)
    } else if (e.type === 'radial_blur' || e.type === 'zoom_blur') {
      const r = e as unknown as { amount?: number; centerX?: number; centerY?: number }
      const amt = clamp01(num(r.amount))
      if (!(amt > 0)) continue
      const cx = clamp01(r.centerX === undefined ? 0.5 : num(r.centerX)) * box.w
      const cy = clamp01(r.centerY === undefined ? 0.5 : num(r.centerY)) * box.h
      const maxR = Math.max(
        Math.hypot(cx, cy), Math.hypot(box.w - cx, cy),
        Math.hypot(cx, box.h - cy), Math.hypot(box.w - cx, box.h - cy),
      )
      const swing = amt * (e.type === 'radial_blur' ? RADIAL_BLUR_MAX_ANGLE : ZOOM_BLUR_MAX_SCALE)
      out = Math.max(out, maxR * swing * span)
    }
  }
  return out
}

/**
 * How far a layer's ENABLED edge-distortion effects push the alpha OUTSIDE the silhouette, logical
 * px — the MAX outward reach across `rough_edge` (jitter amplitude `amount·ROUGH_EDGE_MAX_W·W`) and
 * `ink_bleed` (spread reach `amount·INK_BLEED_MAX_W·W`) (0 with none). Reads the SAME normalised-to-
 * width constants the passes use, so the pad and the pass agree; ink bleed's blotch factor is ≤ 1
 * and softness feathers WITHIN the reach, so `amount·INK_BLEED_MAX_W·W` is a true upper bound.
 *
 * Applies to ANY layer kind (image included), folded into `silhouettePadPx` beside the glow /
 * stroke / motion terms (NOT `cornerPinPadPx`, which re-warps). 0 when no edge distortion is present
 * (or every amount is 0), keeping the raster and the identity A/B byte-identical.
 *
 * Like the other outward-pad terms, this is defensive today: a rough_edge / ink_bleed makes
 * `rasterablePasses` false (neither torn edge / feather nor layer blur), so the layer renders
 * through the full-device offscreen path in `paintLayer`, where the distorted edge has the whole
 * canvas to grow into. It costs one cheap stack scan and returns 0 in the common no-effect case.
 */
export function edgeDistortOutwardPx(layer: LocalLayer, W: number): number {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  let out = 0
  for (const e of effectStackOf(layer as unknown as Parameters<typeof effectStackOf>[0])) {
    if (e.visible === false) continue
    if (e.type === 'rough_edge') {
      out = Math.max(out, clamp01(num((e as unknown as { amount?: number }).amount)) * ROUGH_EDGE_MAX_W * W)
    } else if (e.type === 'ink_bleed') {
      out = Math.max(out, clamp01(num((e as unknown as { amount?: number }).amount)) * INK_BLEED_MAX_W * W)
    }
  }
  return out
}

/**
 * How far a WOBBLED stroke deviates beyond where the same stroke running straight would
 * reach, in the stroke's own STORED units (`wobbleSpecOf` with `unit: 1` — the caller below
 * applies `scale * W` to the whole pad exactly once, as it already does for every other term).
 *
 * Asked of `wobbleSpecOf`, never read off `st.wobbleAmount`: "is this wobble live" has one
 * answer, and an unrecognised shape or a non-positive `wobbleLength` reads as off here for
 * the same reason it paints nothing.
 *
 * This term exists because THIS consumer fails silently. A wobbled stroke padded for its
 * straight reach alone has its wave clipped at the corner-pin or DOF offscreen edge and cut
 * by the torn-edge silhouette — a slightly wrong shape, never an error. It is the third time
 * this pair of helpers has needed a new term in this feature family, so both arms of the loop
 * below take it and each has a test that goes red without it.
 */
const strokeWobbleAmplitude = (st: StrokeInstance): number => {
  const w = wobbleSpecOf(st, 1)
  return w && w.amount > 0 ? w.amount : 0
}

/** The shared body of the two exports above. Private ON PURPOSE: `countCentredOnEdge` used to
 *  be a defaulted positional boolean on one exported function, so the corner-pin call site
 *  (which passes nothing) READ as if it wanted the honest reach, and a future third caller
 *  would silently have inherited the exception. Callers now name which answer they want. */
function strokeStackReachPx(
  layer: LocalLayer,
  W: number,
  /** true: a centred stroke on the edge counts its real half-width reach (`strokeReachPx`).
   *  false: it counts 0 — the corner-pin exception documented on `cornerPinPadPx`. */
  countCentredOnEdge: boolean,
): number {
  if (!strokeSupportsStack(layer.kind)) return 0
  const isText = layer.kind === 'text'
  // A path's strokeWidth (and distance) are stored in local units AT scale=1 (see
  // PathLayer), so their px extent also carries the layer's own uniform scale; every
  // other stroked kind stores them already normalized to canvas width.
  const scale = layer.kind === 'path' ? ((layer as PathLayer).scale ?? 1) : 1
  let pad = 0
  for (const st of strokeStackOf(layer as unknown as Parameters<typeof strokeStackOf>[0])) {
    if (st.visible === false || !hasPaint(st.paint)) continue
    // Non-finite reads as 0, matching `strokeDistancePx` (the painter) and
    // `silhouettePadPx` — this pad also SCALES the corner-pin quad, so an unguarded
    // Infinity here would not just mis-size a raster but re-warp the quad itself.
    const dRaw = st.distance ?? 0
    const d = Number.isFinite(dRaw) ? dRaw : 0
    // TEXT never paints a wobble whatever its stored fields say: it does not reach
    // `paintStrokeStack` at all (`paintTextStrokeBands` calls `paintStrokeBand` directly, and
    // that has no wobble route), and `outlinePathData` is null for it besides. Padding for a
    // wave that never appears would grow a raster — and the corner-pin quad — around nothing.
    const amp = isText ? 0 : strokeWobbleAmplitude(st)
    // A MARCHING-SHAPES stroke is sized by `shapes.size`, never by the `width` its row still
    // carries — Task 7 hid that width row, so the number left there is a stale leftover, and
    // the `width > 0` gate below would skip the entry outright: a mark bigger than that stale
    // width got clipped at the corner-pin / DOF offscreen edge and cut by the torn-edge
    // silhouette, silently — a slightly wrong box, not an error. Dispatched on STYLE before
    // that gate, exactly as the painter and the SVG writer both do.
    //
    // Neither exception above applies to it. It has no alignment (the painter never reads
    // one), it cannot exist on a text layer (`outlinePathData` is null there, so
    // `paintStrokeStack` is never reached at all), and no frame saved before the stack could
    // carry one — so there is no saved corner-pin quad for its reach to move.
    if ((st.style ?? 'band') === 'shapes') {
      const half = shapeStrokeMarkHalfExtent(st.shapes)
      // The wobble displaces the GUIDE the marks march along (`shapeStrokeGuideFit` passes it
      // straight to `offsetPolyline`), so a mark can sit a full `amount` further out than the
      // straight line would have put it, and still reaches `half` past that.
      if (half > 0 && d + half + amp > pad) pad = d + half + amp
      continue
    }
    if (!(st.width > 0)) continue
    const align = strokeAlignOf(st.align)
    // A centred stroke ON the edge is the shape every saved frame already has; it must
    // keep contributing 0 so the corner-pin quad above stays exactly where it was. See
    // `cornerPinPadPx`'s "centre-at-distance-0 exception".
    // A WOBBLED stroke is excused from the exception, on the same grounds marching shapes
    // are: no frame saved before this feature can carry a wobble, so counting its reach can
    // move no saved corner-pin quad — and leaving it out would clip the wave, which is the
    // exact silent failure this term is here to prevent.
    if (align === 'center' && d === 0 && amp <= 0 && !countCentredOnEdge) continue
    // Text on the edge is that same shape whatever its stored alignment says, because the
    // text painter never honoured the alignment — see `cornerPinPadPx`.
    if (isText && d === 0) continue
    // How far this stroke's OUTER edge reaches beyond the silhouette.
    // The wobble rides on top of wherever the band's outer edge already landed: the line is
    // displaced by up to `amount` either side, carrying the whole band width with it.
    const reach = (align === 'outside' ? d + st.width : align === 'inside' ? d : d + st.width / 2) + amp
    if (reach > pad) pad = reach
  }
  return Math.max(0, pad) * scale * W
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

// F5 Task 2: pure — the ShaderSpec (fillTile.ts) `renderFieldWithBase` needs for a shader
// pixel-pass, built from the stored effect. Only effectId/params/speed/seed are ever
// dereferenced by `resolve()`/`buildPasses()` on this path (see field.ts); anchor/input/
// readsBackdrop/readsLayerKey are fill-only concerns with no equivalent here — off's own
// pixels ARE the input, so there's nothing to anchor or read a backdrop through. Exported
// (and kept pure) so this mapping has its own unit test; the canvas recombine around it
// needs a real GPU context, which only the live Playwright gate can exercise.
export function shaderSpecFromEffect(e: Pick<ShaderPixelEffect, 'effectId' | 'params' | 'speed' | 'seed'>): ShaderSpec {
  return { effectId: e.effectId, params: e.params, speed: e.speed, seed: e.seed } as unknown as ShaderSpec
}

// F5 Task 2: the shader-catalog-as-a-pass pixel effect. Runs a named Shader Studio
// catalog effect over the layer's OWN already-rendered pixels (`off`) — a GPU pass,
// reorderable alongside the other pixel passes above. DISTINCT from a shader FILL
// (which replaces the layer's fill, `resolvePaint`/`paintTileBox`) and from the glass
// lens (`applyGlassFromLayer`, which refracts the layers BEHIND this one): this reads
// and writes `off`'s own current pixels only, full-frame (no `shape` arg — not
// shape-following), so it works the same over photos, text and shapes alike.
//
// Alpha: most catalog frags hard-code output alpha to 1.0 (see the comment at
// `applyGlassFromLayer`'s ownFill branch), so the shader's raw result would flood a
// text/cutout layer's transparent regions opaque. Recombine against `off`'s OWN
// pre-shader pixels — the exact `destination-in` recipe `applyGlassFromLayer` uses to
// clip its refracted result to the layer's silhouette (step 4, ~line 4940) — except the
// clip source here is `off`'s own snapshot rather than a separately rendered silhouette,
// since `off`'s pixels already carry the correct per-pixel alpha before the shader runs.
//
// `renderFieldWithBase` THROWS on a catalog miss (unloaded catalog, bad effectId) — the
// same precedent `applyGlassFromLayer`'s caller relies on — so a throw here is caught and
// leaves `off` completely untouched, never aborting the frame.
//
// F5 Task 4: exported (like `shaderSpecFromEffect` above) so the layer-pass-vs-studio-
// effect PARITY proof (compositor-layer-effects.spec.ts, "F5 Task 4") can call this real
// function directly against a synthetic base canvas and diff it against a hand-built
// `renderFieldWithBase` + destination-in recombine — proving this pass IS the studio
// effect rather than a parallel reimplementation. Not called from any new production
// site; `paintLayer`'s `case 'shader'` above remains the one dispatch path.
export function applyShaderPixelEffect(off: HTMLCanvasElement, e: ShaderPixelEffect, opts: { W: number; scale: number; t: number }): void {
  const w = off.width, h = off.height
  if (w < 1 || h < 1) return
  try {
    // Snapshot off's pre-shader pixels — the alpha source for the recombine below, and
    // (since renderFieldWithBase's returned canvas is only valid until the next render
    // call) what a throw leaves `off` looking like: untouched.
    const pre = document.createElement('canvas')
    pre.width = w; pre.height = h
    const pctx = pre.getContext('2d')
    if (!pctx) return
    pctx.drawImage(off, 0, 0)

    const spec = shaderSpecFromEffect(e)
    // off is already device-sized (opts.W/opts.scale exist for spatial params, matching
    // the sibling passes' W*scale convention, but the catalog's own params are already in
    // the shader's normalized units — no shape (undefined): a full-layer pass, not
    // shape-following.
    const result = renderFieldWithBase(spec, off, w, h, undefined, opts.t)

    const octx = off.getContext('2d')
    if (!octx) return
    octx.save()
    octx.setTransform(1, 0, 0, 1, 0, 0)
    octx.clearRect(0, 0, w, h)
    octx.drawImage(result, 0, 0)
    // Recombine: clip the shader's (possibly all-opaque) output back to off's own
    // original alpha, so a transparent region of the layer stays transparent.
    octx.globalCompositeOperation = 'destination-in'
    octx.drawImage(pre, 0, 0)
    octx.restore()
  } catch {
    // Unloaded catalog / bad effectId (renderFieldWithBase throws) — leave `off` as-is.
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
 *  The SHAPE kinds hand the pure helper `strokeReachPx` (the stack's furthest reach —
 *  alignment, distance, marching-shape mark size and a path's scale already folded in) to
 *  `silhouettePadPxPure` as its `strokeReachPx` input, so a layer with several strokes is
 *  padded for the one that actually reaches furthest. It is the HONEST reach, not
 *  `cornerPinPadPx`: a raster only has to be BIG ENOUGH, so unlike the corner-pin pad it must
 *  keep counting the outer half of a plain centred stroke — exactly the half-width the
 *  pre-stack `strokeAlign` rule counted. Text
 *  and line keep their own rules — see `silhouetteInkOverhangPx`. `strokeWidth` is
 *  guarded (`|| 0`) so a missing/NaN value can never make `bwD` NaN downstream.
 *
 *  EXPORTED for its tests. The pure helper it defers to is tested by handing it a
 *  `strokeReachPx` directly, which cannot see whether anything actually SUPPLIES one —
 *  delete the `reachPx = …` line below and every such test still passes, because a
 *  legacy layer's reach and the single-`strokeAlign` fallback agree by construction. Only
 *  a layer with a real `strokes` array (or a text layer with one) tells them apart, and
 *  that has to be resolved from a LAYER, i.e. here. */
export function silhouettePadPx(layer: LocalLayer, W: number, s: number, box: { w: number; h: number }): number {
  const l = layer as unknown as { strokeWidth?: number; strokeAlign?: unknown; stroke?: Paint; scale?: number; fontSize?: number; boxH?: number }
  const width = Math.max(0, l.strokeWidth || 0)
  // How far a geometry effect (F2) grows this layer's outline outward, so the baked
  // silhouette raster contains the transformed ink. 0 for a layer with none, keeping the
  // raster (and the identity A/B) byte-identical. Added to — never max'd with — the stroke
  // reach below: the stroke is drawn on the GROWN outline, so the two extents stack.
  const geoPx = geometryOutwardPx(layer, W)
  let strokePx = 0
  // Named `reachPx`, not `strokeReachPx`: that is the module-level helper it is assigned FROM
  // (a local of the same name would shadow it inside this function).
  let reachPx: number | undefined
  let strokeAlign: StrokeAlign = 'center'
  if (layer.kind === 'text') {
    // Text's overhang is a full em PLUS how far its outline reaches past the glyphs. For a
    // stroke on the edge that reach is its width — deliberately the FULL width rather than
    // the half a centred `strokeText` really paints, because a bigger raster is cheap and
    // a clipped glyph is a visible bug. A stroke at a positive `distance` is a dilation
    // band sitting `distance + width` out (`paintTextStrokeBands`), which no width alone
    // can express; a negative one bands INSIDE the ink and reaches no further than its own
    // width, so the `max(0, …)` keeps it at today's answer. `width` (the legacy field) is
    // kept in the max so a raster can never come out smaller than it did before the stack.
    let furthest = 0
    for (const st of strokeStackOf(layer as unknown as Parameters<typeof strokeStackOf>[0])) {
      if (st.visible === false || !hasPaint(st.paint) || !(st.width > 0)) continue
      const d = st.distance ?? 0
      const reach = st.width + (Number.isFinite(d) ? Math.max(0, d) : 0)
      if (reach > furthest) furthest = reach
    }
    // Outlined (non-decorated) text can carry a geometry effect too — add its outward growth
    // so an offset/roughen glyph outline is not clipped at the raster edge.
    strokePx = Math.max(width, furthest) * W + geoPx
  } else if (layer.kind === 'line') {
    // drawLayerContent floors a line's lineWidth at 1px, so a hairline still caps. A line
    // always strokes (defaulting to white), so this is deliberately NOT gated on paint.
    strokePx = Math.max(1, width * W)
  } else if (layer.kind === 'rect' || layer.kind === 'ellipse' || layer.kind === 'polygon' || layer.kind === 'star' || layer.kind === 'path') {
    // The stack's own answer for how far its furthest stroke reaches past the silhouette —
    // alignment, `distance`, a marching-shape's mark size and a path's `scale` all folded in. Reading a single
    // `strokeAlign` here instead would bake the wrong outline for a multi-stroked layer,
    // and do it SILENTLY: a slightly wrong torn edge, not an error.
    // Add the geometry outward growth to the stroke reach: applyGeometry grows the outline
    // and the stroke is drawn on that grown edge, so the raster must hold both (a sum, not a
    // max). 0 with no geometry effect ⇒ identical reachPx ⇒ byte-identical raster.
    reachPx = strokeReachPx(layer, W) + geoPx
    // A path's strokeWidth is stored in local units AT scale=1 (see PathLayer), so its
    // px extent carries the layer's own uniform scale — same correction strokeReachPx makes.
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
  // Grow the raster to hold an outer-glow halo's outward blur, an alpha-traced stroke's outward
  // band, a motion blur's outward smear AND an edge distortion's outward jitter / bleed (each 0
  // with none → byte-identical raster). Logical px, like the pure helper's own answer; summed since
  // a layer can carry all of them. See `outerGlowOutwardPx` / `strokeAlphaOutwardPx` /
  // `motionBlurOutwardPx` / `edgeDistortOutwardPx`.
  return silhouettePadPxPure({
    kind: layer.kind,
    strokeAlign,
    strokePx,
    strokeReachPx: reachPx,
    fontPx: isText ? Math.max(0, l.fontSize || 0) * W : 0,
    boxHPx: isText ? Math.max(0, l.boxH || 0) * W : 0,
    boxHeightPx: box.h,
    maxLineWPx,
    boxWidthPx: box.w,
  }, s) + outerGlowOutwardPx(layer, W) + strokeAlphaOutwardPx(layer, W) + motionBlurOutwardPx(layer, W, box) + edgeDistortOutwardPx(layer, W)
}

// Raster mesh-warp (F3 4b) constants. `RASTER_WARP_EPS` matches `geometryEffects.WARP_EPS`:
// an |amount| at or below it is treated as OFF, so a raster layer carrying a zero-amount warp
// renders byte-identically to one with no warp (the warp branch never runs). `RASTER_WARP_SUBDIV`
// is finer than corner-pin's 16 because a displacement field curves within a cell (perspective
// does not), so a coarser grid would facet a strong bulge/twist; 24 keeps curves smooth at a
// bounded 2·24² triangle cost per warped stamp.
const RASTER_WARP_EPS = 1e-4
const RASTER_WARP_SUBDIV = 24

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
  // The layer's ordered stack, old shape or new — see lib/compositor/effectStack.ts. For an
  // unedited (old-shape) layer this is the legacy canonical order, so the pass sequence below
  // is exactly what the fixed lookups used to produce.
  const stack = effectStackOf(layer).filter(e => e.visible)
  const shadow = pinnedEffect(stack, 'drop_shadow') as DropShadowEffect | undefined
  // Everything between the pinned three, in the user's order. inner shadow / the six chain
  // kinds / torn edge / feather / layer blur all run here.
  const passes = orderablePasses(stack)
  // A blur with nothing orderable after it stays on the stamp's `ctx.filter`, exactly where the
  // legacy code put its one blur — that is what keeps an unedited layer byte-identical (a blur
  // baked into the offscreen re-quantizes once more, and clips the bleed the drop shadow used to
  // see past a frame edge). Only a blur FOLLOWED by another pass — reachable solely by a user
  // reorder — has to run on the offscreen, since the stamp filter is last by construction.
  const { body: bodyPasses, trailing: trailingBlurs } = splitTrailingBlurs(passes)
  // The silhouette raster bakes torn edge + feather into the layer's own box. Layer blur may
  // ride along ONLY when every blur comes after every edge pass, which is the legacy order —
  // otherwise the raster would apply them the wrong way round. Such a blur is trailing, so it is
  // applied at the stamp, not on the raster.
  const rasterable = rasterablePasses(passes)
  // Content layers with a depth map only — nothing else has one to drive the blur.
  // An uploaded image keys depth by its `filename`; a WIRED layer keys it by the
  // host-supplied `depthKey` (the upstream `/view` URL). Both resolve through the
  // same depth registry, so a wired slot and an uploaded copy of the same picture
  // defocus identically — a gap between them reads as a bug (and losing it here is
  // what would have silently dropped DOF from every migrated frame).
  const dofRef: DepthRef | null | undefined = layer.kind === 'image'
    ? (layer as ImageLayer).filename
    : layer.kind === 'wired' ? depthSourceFromViewUrl((layer as WiredLayer).depthKey) : undefined
  const dof = dofRef ? (pinnedEffect(stack, 'dof') as DofEffect | undefined) : undefined
  // (background_blur is a stack-level effect — paintLayerStack applies it
  // against the backdrop before this layer paints.)

  // Slant (affine shear) + corner-pin (projective warp). Both fold into the per-clone
  // local transform / content draw, so absent ⇒ byte-identical to before.
  const skx = layer.skewX || 0, sky = layer.skewY || 0
  const hasSkew = skx !== 0 || sky !== 0
  const shearA = hasSkew ? Math.tan((sky * Math.PI) / 180) : 0
  const shearC = hasSkew ? Math.tan((skx * Math.PI) / 180) : 0
  const cp = cornerPinActive(layer.cornerPin) ? layer.cornerPin : null
  // Raster mesh-warp (F3 4b): the `warp` geometry kind, on a raster layer (image/wired/brush),
  // rendered as a pixel-domain warp of the layer's box-sized content rather than an outline
  // transform. Read straight from the stack — `warp` is a geometry kind, so `orderablePasses`
  // excludes it from the 2D pixel passes; it is applied inside `drawContent` instead (like
  // corner-pin). Vector layers get `undefined` here (canWarpRaster is false) and keep the 4a
  // outline path untouched; a warp at |amount| ≤ eps is treated as absent, so a zero-amount
  // raster warp is byte-identical to no warp. First visible warp wins (never more than one).
  const rasterWarp: WarpEffect | undefined = canWarpRaster(layer)
    ? (stack.find(e => e.type === 'warp' && Math.abs((e as WarpEffect).amount) > RASTER_WARP_EPS) as WarpEffect | undefined)
    : undefined
  // A living image (Task 3): each clone shows a different frame of the same clip (see
  // `_cloneSlot` / `clipFrameFor`), so anything below that would otherwise memoise "the"
  // content across clones — the silhouette bake and `dofMemo` — must not, for this layer.
  const isClipLayer = layer.kind === 'image' && !!layer.clip

  // Silhouette raster cache (see `_silhouetteCache`): only cases whose LOCAL BOX is a
  // faithful, self-contained render of the layer qualify — everything else keeps the
  // old full-canvas path, byte-identical.
  const silhouetteCacheable = rasterable
    && layer.kind !== 'wired'                                       // graph pixels change under us — no content signature
    && !cp && !dof                                                  // corner-pin / DOF have their own offscreen flows
    && !(layer.kind === 'text' && layer.expressive)                 // expressive layout places words outside localLayerBox
    && !(layer as unknown as { textMotion?: unknown }).textMotion   // letters move every frame — the raster is never twice the same
    && !layerPaints(layer).some(p => isFill(p) && fillIsShader(p))  // shader fills are live / frame-anchored
    && !isClipLayer                                                 // a living image changes every frame — never bake it
    && silhouetteContentReady(layer, W)
  // Memoized like `dofContent` below: identical for every clone of the SAME tint.
  //
  // COST NOTE, read before raising the swatch ceiling: `silhouetteCacheKey` deep-canonicalizes
  // and stringifies the layer, and `strokes` is NOT stripped from it. Before Vary this ran
  // once per paint call. Keying by tint means it now runs once per DISTINCT tint, so a
  // feathered or torn-edge brush layer in `blend` spread — where every copy is its own colour —
  // pays a full stroke-array stringify per stamp. Reach is narrow today (it needs an edge pass
  // AND vary colour AND blend spread AND a high count), and `cycle` spread is capped at 8
  // swatches. If that combination becomes common, hoist the layer half of the key out of this
  // function and vary only the tint suffix.
  //
  // Keyed by tint, not a single slot: Cloner Vary bakes the copy's colour INTO the raster
  // (see below), so copies in different swatches are different bitmaps. A single shared
  // slot tinted in place would bleed the first copy's colour into every other copy. In
  // `cycle` spread the palette is capped at VARY_PALETTE_MAX (8), so a whole array costs at
  // most 8 rasters; `blend` interpolates and can reach one per copy, which is why only the
  // first few reach the module-global LRU (see `tintedBaked` below).
  const silhouetteMemo = new Map<string, { canvas: HTMLCanvasElement; w: number; h: number } | null>()
  let tintedBaked = 0
  const silhouetteRaster = (
    s: number, tint: string | null, tintStrength: number,
  ): { canvas: HTMLCanvasElement; w: number; h: number } | null => {
    // A clip's frame is per-clone (`_cloneSlot.k`), so its memo key carries the clone
    // index too — otherwise the second clone of the same tint would read back the
    // first clone's (already-null, since `isClipLayer` disqualifies the bake) entry
    // without ever re-checking `silhouetteCacheable`. Harmless today (the entry is
    // always null for a clip layer) but keeps this memo correct on its own terms.
    const memoKey = (tint ? `${tint}@${tintStrength}` : '') + (isClipLayer ? `@k${_cloneSlot.k}` : '')
    const memoed = silhouetteMemo.get(memoKey)
    if (memoed !== undefined) return memoed
    const miss = (v: { canvas: HTMLCanvasElement; w: number; h: number } | null) => { silhouetteMemo.set(memoKey, v); return v }
    if (!silhouetteCacheable) return miss(null)
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
    if (!silhouetteRasterFits(bwD, bhD)) return miss(null)
    const key = silhouetteCacheKey(layer as unknown as Record<string, unknown>, s, bwD, bhD, W, tint, tintStrength)
    const hit = _silhouetteCache.get(key)
    if (hit) return miss({ canvas: hit, w: bwLx, h: bhLx })
    const cc = document.createElement('canvas'); cc.width = bwD; cc.height = bhD
    const cctx = cc.getContext('2d')
    if (!cctx) return miss(null)   // no raster ⇒ the caller takes the uncached path
    cctx.setTransform(s, 0, 0, s, bwD / 2, bhD / 2)   // centred, at device scale — the geometry drawLayerContent expects
    drawLayerContent(cctx, layer, W, wiredLive)
    // Cloner Vary colour, baked in BEFORE the edge passes below — which is the only place
    // it can go and stay consistent. `applyTornEdgeToData` paints an OPAQUE lip in
    // `spec.lipColor`; a tint applied to the finished raster would wash that lip, while a
    // sibling copy at cloner scale != 1 (which falls through to the uncached path, where the
    // tint precedes the whole chain) would keep its lip's own colour. One array, two lip
    // colours, decided by cache eligibility. Tinting here makes both branches agree.
    if (tint) tintScratch(cctx, tint, tintStrength)
    // In list order: a feather before a tear and a tear before a feather are different
    // pictures, and the raster has to agree with the uncached path below.
    for (const e of passes) {
      if (e.type === 'torn_edge') applyTornEdge(cc, e as unknown as TornEdgeSpec, { scale: s })
      else if (e.type === 'feather') applyFeather(cc, e as unknown as FeatherSpec)
    }
    // A `blend` spread gives every copy its own interpolated colour, so a 100-copy array
    // would push 100 one-frame entries through a 24-entry LRU — no hits for itself and every
    // OTHER layer's raster evicted. Only the first VARY_PALETTE_MAX tinted rasters of a paint
    // call are published globally; beyond that the per-call memo above still dedupes within
    // the frame, which is all a blend spread could ever have got anyway. Untinted rasters are
    // published exactly as before.
    if (!tint || ++tintedBaked <= VARY_PALETTE_MAX) _silhouetteCache.set(key, cc)
    return miss({ canvas: cc, w: bwLx, h: bhLx })
  }
  const applyXform = (c: CanvasRenderingContext2D, lx2: number, ly2: number, lrot2: number, ls2: number) => {
    c.translate(lx2 * W, ly2 * H)
    if (lrot2) c.rotate((lrot2 * Math.PI) / 180)
    if (hasSkew) c.transform(1, shearA, shearC, 1, 0, 0)
    if (ls2 !== 1) c.scale(ls2, ls2)
  }
  // ONE scratch surface for the whole array, not one per copy. A tinted copy has to be
  // composited in isolation (see the fast path below), and allocating a device-sized canvas
  // per copy per frame is what made a 100-copy tinted grid ~770 MB of allocation on a
  // 1600x1200 buffer. `undefined` = not tried yet, `null` = no DOM (SSR / node unit tests),
  // in which case every copy falls through to the untinted inline draw.
  //
  // Scoped to this paint call rather than the module: a module-global pool would have to
  // survive `document` swaps and re-entrant paints, and the effected path above already
  // allocates one device-sized offscreen per copy, so per-call is squarely inside this
  // file's existing cost profile. Reused surfaces MUST be reset — transform, alpha, blend,
  // filter, shadow and pixels — or copy 2 would tint copy 1's ink still sitting there.
  let varyScratchMemo: CanvasRenderingContext2D | null | undefined
  const varyScratchFor = (host: CanvasRenderingContext2D): CanvasRenderingContext2D | null => {
    if (varyScratchMemo === undefined) varyScratchMemo = scratchLike(host)
    const o = varyScratchMemo
    if (!o) return null
    o.setTransform(1, 0, 0, 1, 0, 0)
    o.clearRect(0, 0, o.canvas.width, o.canvas.height)
    o.globalAlpha = 1
    o.globalCompositeOperation = 'source-over'
    o.filter = 'none'
    o.shadowColor = 'transparent'
    o.shadowBlur = 0
    o.shadowOffsetX = 0
    o.shadowOffsetY = 0
    o.setTransform(host.getTransform())
    return o
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
    // A clip layer never reuses this across clones: each clone's DOF-blurred content
    // is built from a different frame (`drawLayerContent` below reads `_cloneSlot`), so
    // returning the first clone's bake for every later clone would freeze the loop.
    if (dofMemo !== undefined && !isClipLayer) return dofMemo
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
    // No corner-pin AND no raster warp ⇒ the original inline draw, byte-identical.
    if (!cp && !rasterWarp) {
      if (dofCanvas) {
        c.drawImage(dofCanvas, -dofCanvas.width / 2, -dofCanvas.height / 2)
        return
      }
      drawLayerContent(c, layer, W, wiredLive); return
    }
    const box = localLayerBox(measureCtx(), layer, W, H, wiredLive)
    // Outside-aligned strokes (and any stroke pushed out by a `distance`) paint
    // entirely beyond localLayerBox's plain w×h (see cornerPinPadPx) and
    // would be 100% clipped by this offscreen's edges otherwise. Pad it — and
    // grow the quad it warps into by the same amount, keeping the shape
    // centered — so the stroke survives the pin. NOTE that `pad` therefore also
    // SCALES the quad's corner pull below, which is why cornerPinPadPx
    // returns 0 for the plain centred stroke every saved frame has: same bw/bh,
    // same quad, same warp as before the stack existed. Skipped when DOF already produced the
    // source canvas (dofCanvas is used as-is, unpadded — a rarer combination
    // left as a pre-existing gap, not what this fix targets).
    const pad = dofCanvas ? 0 : cornerPinPadPx(layer, W)
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
    // Raster mesh-warp (F3 4b): displace the box-sized artwork through the warp field BEFORE it
    // is stamped or pinned — "warp the artwork, then place it in perspective". `cc` spans local
    // [-hw,hw]×[-hh,hh] (its pixel rect maps 1:1 onto that rect); sample `warpPoint` over an N×N
    // grid of that rect to build the destination mesh. `bbox` is the CONTENT box (pad excluded),
    // so `amount` reads the same on a raster layer as on the equivalent vector outline (4a).
    if (rasterWarp) {
      const bbox = { minX: -box.w / 2, minY: -box.h / 2, w: box.w, h: box.h }
      const params = { amount: rasterWarp.amount, frequency: rasterWarp.frequency }
      const field = rasterWarp.field as WarpField
      const N = RASTER_WARP_SUBDIV
      const grid: WarpPt[][] = []
      for (let j = 0; j <= N; j++) {
        const row: WarpPt[] = []
        for (let i = 0; i <= N; i++) {
          const px = -hw + (i / N) * hw * 2
          const py = -hh + (j / N) * hh * 2
          row.push(warpPoint({ x: px, y: py }, bbox, field, params))
        }
        grid.push(row)
      }
      // No corner-pin ⇒ draw the warped mesh straight onto `c` (local space); nothing clips the
      // mesh to the box here, so a bulge that pushes past the box edge still shows.
      if (!cp) { drawMeshWarp(c, cc, grid, N); return }
      // warp THEN corner-pin (rare): bake the warped artwork back into a box-sized offscreen so
      // the projective pin has a rectangle to map. This clips any warp overflow to the box (pad
      // is 0 on raster layers) — accepted for the warp+pin combination; the common case is the
      // no-pin branch above.
      const wc = document.createElement('canvas'); wc.width = bw; wc.height = bh
      const wctx = wc.getContext('2d')
      if (wctx) {
        wctx.translate(bw / 2, bh / 2)
        drawMeshWarp(wctx, cc, grid, N)
        cc = wc
      }
    }
    // Corner-pin (the 4a-era path, unchanged when there is no raster warp): warp `cc`'s rect
    // onto the corner-pin quad in local space. Only reached with `cp` truthy.
    const quad: Quad = [
      { x: -hw + cp!.tl.x * hw, y: -hh + cp!.tl.y * hh },
      { x:  hw + cp!.tr.x * hw, y: -hh + cp!.tr.y * hh },
      { x:  hw + cp!.br.x * hw, y:  hh + cp!.br.y * hh },
      { x: -hw + cp!.bl.x * hw, y:  hh + cp!.bl.y * hh },
    ]
    drawQuadWarp(c, cc, quad, 16)
  }

  // Linked cloner: paint once per clone (back-to-front; original last). No
  // cloner ⇒ a single identity transform ⇒ one paint exactly as before. Falloff
  // offset/rotation/scale fold into the layer's own translate/rotate/scale so
  // the rotation+scale pivot stays the layer center.
  // `_cloneSlot` is a STABLE object mutated in place (not a fresh literal per copy): a
  // cloner with hundreds of copies allocated one short-lived object per copy per frame,
  // and nothing holds a reference to it across the loop. The `finally` puts it back to
  // the original-alone slot even if a copy throws mid-paint, so the next layer can never
  // inherit a stale clone index (which for a living image is a visibly wrong frame).
  // (The loop body below is deliberately left at its original indentation so this wrap
  // stays a two-line diff in a file several sessions edit at once.)
  // `motionCopy` (transient, set only by paintLayerStack's copies-stagger expansion)
  // narrows the expansion to that ONE copy — the layer is being painted once per copy,
  // each at its own clock. Absent ⇒ undefined ⇒ the full array, exactly as before.
  try {
  for (const c of expandClones(layer.cloner, W / H, (layer as { motionCopy?: number }).motionCopy)) {
    _cloneSlot.k = c.k; _cloneSlot.n = c.n
    const lx = layer.x + c.dx
    const ly = layer.y + c.dy
    const lrot = layer.rotation + c.drot
    const lop = baseOpacity * c.dopacity
    const ls = c.dscale
    // Cloner Vary colour. A strength of 0 is the identity wash, so it is treated
    // as "no tint" here rather than inside tintScratch — that keeps such a copy on
    // the untinted code path instead of paying for a scratch detour that paints
    // nothing. No vary ⇒ null ⇒ every branch below is exactly what it always was.
    const tint = c.tint && c.tintStrength > 0 ? c.tint : null

    // Effected path: render the layer to an offscreen at canvas size, then
    // composite it with inner shadow / drop shadow / blur. Works identically for
    // text, shapes, vectors and images, and because bakeOverlay() renders through
    // here the effects are baked into generation exactly as previewed.
    if (shadow || passes.length) {
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
        const raster = ls === 1 ? silhouetteRaster(s, tint, c.tintStrength) : null
        if (raster) {
          applyXform(octx, lx, ly, lrot, ls)
          // `raster.w/h` are the rounded DEVICE size divided back by `s`, so under `t`
          // the destination is exactly the bitmap's own pixel size — no rescaling. The
          // translation is still fractional (`lx * W` lands anywhere), so the stamp can
          // resample by up to half a pixel in position; that is the same subpixel
          // placement the uncached draw does, not an extra softening from the cache.
          octx.drawImage(raster.canvas, -raster.w / 2, -raster.h / 2, raster.w, raster.h)
          // Torn edge / feather are already baked into the raster; `rasterablePasses` guarantees
          // any layer blur here is trailing, so it lands on the stamp's `ctx.filter` below.
          // The Vary tint is baked into the raster too — BEFORE those edge passes, and keyed
          // into both the per-call memo and the module cache — so it must NOT be re-applied to
          // `octx` here. Washing after the fact would recolour the torn edge's opaque lip on
          // this branch only, while a sibling copy on the uncached branch below kept its own.
        } else {
          applyXform(octx, lx, ly, lrot, ls)
          drawContent(octx)
          // Vary tint, on the copy's own offscreen and BEFORE its effect chain, so every pass
          // below (inner shadow, gradient map, torn edge, feather, a non-trailing blur…)
          // consumes the varied colour rather than the layer's base colour. That ordering is
          // load-bearing for the passes that ADD their own ink — the torn edge's opaque lip
          // most of all, which a later wash would recolour.
          //
          // It is NOT load-bearing for the drop shadow at the stamp, contrary to what this
          // comment used to claim: `source-atop` preserves destination alpha exactly, and a
          // canvas drop shadow is derived from source alpha and `shadowColor` alone, so the
          // shadow is bit-identical tinted or not. Same for feather, which only scales alpha.
          // The trailing blur is the one stamp-time consumer that really does see the colour.
          if (tint) tintScratch(octx, tint, c.tintStrength)
          // The layer's passes, in the user's order, minus any TRAILING layer blur (that one is
          // the stamp's `ctx.filter`, below). For an unedited layer the order is the legacy one
          // (inner shadow, then the six chain kinds, then torn edge, feather), so this produces
          // the same canvas operations the fixed sequence did.
          //
          // scale = device px per logical px, so bloom radius / grain size / blur radius land
          // at the right physical size on a device-resolution buffer (mirrors applyStackPost).
          for (const e of bodyPasses) {
            switch (e.type) {
              case 'inner_shadow':
                compositeInnerShadow(off, e as unknown as InnerShadowEffect, W, s); break
              // Torn edge carves the offscreen's alpha + paints the lip, in device px, so
              // preview and export tear identically.
              case 'torn_edge':
                applyTornEdge(off, e as unknown as TornEdgeSpec, { scale: s }); break
              // Feather softens whatever silhouette exists (including a torn one) by fading
              // alpha inward. amount is element-relative (derived from the rendered
              // silhouette's own bbox), so no canvas/scale is passed.
              case 'feather':
                applyFeather(off, e as unknown as FeatherSpec); break
              case 'layer_blur':
                applyBlurPass(off, Math.max(0, (e as LayerBlurEffect).radius * W * s)); break
              // F5 Task 2: runs a catalog shader over off's own pixels, alpha preserved.
              // See applyShaderPixelEffect above for the throw-safe / alpha recombine.
              case 'shader':
                applyShaderPixelEffect(off, e as unknown as ShaderPixelEffect, { W, scale: s, t: _fieldCtx.t }); break
              // F7 print recipes: expand the recipe's few dials into an ordered list of the
              // primitive passes and run them on the layer's device-res offscreen. Absent =>
              // this case never fires => byte-identical.
              case 'risograph':
              case 'photocopy':
              case 'letterpress':
                applyPasses(off, expandRecipe(e as unknown as RisographEffect | PhotocopyEffect | LetterpressEffect), { W, scale: s }); break
              default:
                applyPasses(off, [e], { W, scale: s })
            }
          }
        }
        ctx.save()
        // `off` already holds device pixels — stamp it 1:1 in device space, not under
        // `t` (which would upscale it a second time). Shadow/blur are specified in device px
        // here, so their logical W-normalized params scale by `s`. The canvas applies
        // filter → shadow → composite, so the drop shadow still follows the blurred
        // silhouette — and, exactly as before this stack rewrite, it sees the blur's bleed
        // past the offscreen's bounds. Several trailing blurs compose into one filter list.
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalAlpha = lop
        ctx.globalCompositeOperation = blendOp
        if (trailingBlurs.length) {
          ctx.filter = trailingBlurs
            .map(b => `blur(${Math.max(0, (b as unknown as LayerBlurEffect).radius * W * s)}px)`)
            .join(' ')
        }
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
    //
    // A TINTED copy cannot draw inline: `source-atop` on the shared ctx would wash
    // every layer already composited beneath this one, not just this copy. It takes a
    // scratch detour instead — the copy alone on a shared, per-call surface, tinted
    // there, then stamped under the same alpha/blend the inline draw would have used.
    // A clip is NOT a substitute: `source-atop` inside a clip still washes whatever was
    // already composited within it. `varyScratchFor` returns null with no DOM (SSR /
    // node unit tests), which falls through to the untinted draw.
    //
    // KNOWN, INHERENT to the detour: this changes the compositing MODEL for a tinted
    // copy. Drawn inline, every operation inside `drawContent` blends against the
    // backdrop individually at `lop` under `blendOp`. Through the scratch, the copy
    // composites flat first and stamps ONCE — group opacity. For a `multiply` layer at
    // 50% with a stroke overlapping its fill, the overlap multiplies twice inline and
    // once here, so moving the strength dial off 0 is a visible discontinuity, larger
    // than the colour shift itself. It is not a bug to be fixed at this site: isolation
    // is what makes `source-atop` safe at all. Strength 0 stays on the inline path
    // precisely so an untinted array never pays it.
    const scratch = tint ? varyScratchFor(ctx) : null
    if (scratch) {
      _fieldCtx = { ..._fieldCtx, base: scratch.getTransform() } // == ctx's, varyScratchFor re-sets it per copy
      applyXform(scratch, lx, ly, lrot, ls)
      drawContent(scratch)
      tintScratch(scratch, tint!, c.tintStrength)
      ctx.save()
      ctx.globalAlpha = lop
      ctx.globalCompositeOperation = blendOp
      stampScratch(ctx, scratch)
      ctx.restore()
      continue
    }
    ctx.save()
    ctx.globalAlpha = lop
    ctx.globalCompositeOperation = blendOp
    _fieldCtx = { ..._fieldCtx, base: ctx.getTransform() } // frame base, before this shape's own transform
    applyXform(ctx, lx, ly, lrot, ls)
    drawContent(ctx)
    ctx.restore()
  }
  } finally {
    _cloneSlot.k = 0; _cloneSlot.n = 1
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
 * The four corners of `s`'s DEVICE canvas, expressed in `s`'s CURRENT user units.
 *
 * Filling that quad covers every pixel of the surface WITHOUT leaving the transform the
 * drawing is happening under — which is what a `CanvasPattern`/`CanvasGradient` needs,
 * since Canvas2D resolves those at fill time (see `paintStrokeBand`'s colour pass, the
 * one caller). Returned in device order — top-left, top-right, bottom-right, bottom-left
 * — so the quad is traced without self-intersecting under any affine transform.
 *
 * `null` means the current transform cannot be inverted (a singular matrix inverts to
 * all-NaN in the browser rather than throwing) or this runtime's matrix has no `inverse`
 * at all; the caller falls back to a device-space fill rather than painting nothing.
 */
function deviceCoverQuad(s: CanvasRenderingContext2D): { x: number; y: number }[] | null {
  try {
    const m = typeof s.getTransform === 'function' ? s.getTransform() : null
    if (!m || typeof (m as DOMMatrix).inverse !== 'function') return null
    const i = (m as DOMMatrix).inverse()
    if (![i.a, i.b, i.c, i.d, i.e, i.f].every(v => Number.isFinite(v))) return null
    const w = s.canvas.width, h = s.canvas.height
    return ([[0, 0], [w, 0], [w, h], [0, h]] as [number, number][])
      .map(([x, y]) => ({ x: i.a * x + i.c * y + i.e, y: i.b * x + i.d * y + i.f }))
  } catch {
    return null   // not expected: `inverse()` returns NaNs, it does not throw
  }
}

/**
 * Cloner Vary: wash ONE clone's already-drawn pixels toward its palette colour.
 *
 * `source-atop` confines the fill to existing ink, so the copy's silhouette,
 * anti-aliased edges and any transparency survive untouched — which is also why
 * this may only ever run on a surface holding that ONE copy. On a shared canvas
 * it would wash every layer already composited beneath it; the callers take a
 * scratch detour precisely to avoid that.
 *
 * Runs in DEVICE space so the fill covers the whole surface regardless of the
 * caller's current transform, and restores everything it touched.
 *
 * Exported so the wash itself can be unit-tested without a rasterizer.
 */
export function tintScratch(octx: CanvasRenderingContext2D, tint: string, strength: number): void {
  const a = Math.max(0, Math.min(1, strength))
  if (!(a > 0)) return   // 0, negative and NaN all mean "leave the pixels alone"
  octx.save()
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalCompositeOperation = 'source-atop'
  octx.globalAlpha = a
  // STRIP THE SWATCH'S OWN ALPHA. `sanitizeVaryPalette` admits 8-digit `#rrggbbaa`,
  // and canvas honours it — so an `#ff000080` swatch would multiply its 0.5 into
  // `globalAlpha` and tint at HALF the strength the user dialled. Neither of the other
  // two paths does that: the Python mirror's hex parser reads six digits, and the 3D
  // path calls this same `stripAlpha` before `THREE.Color.set` (materials.ts). The
  // strength dial is the ONE place tint amount is expressed, on all three.
  octx.fillStyle = stripAlpha(tint)
  octx.fillRect(0, 0, octx.canvas.width, octx.canvas.height)
  octx.restore()
}

/**
 * THE single place any outline is painted, at any distance from the shape's edge.
 *
 * `distance` moves the band's REFERENCE EDGE out (positive) or in (negative) from the
 * shape's own edge; `align` then says how the band of `width` straddles that reference,
 * exactly as it always has. So `distance = 0` reduces to the statements `strokeAligned`
 * ran before this existed, and an untouched frame is byte-identical.
 *
 * At a non-zero distance the band is the difference of two canvas DILATIONS. Canvas gives
 * a dilation directly: `fill(path)` together with `stroke(path, 2r)` is the shape grown by
 * `r`, with `lineJoin` deciding the corners. So:
 *
 *     band = dilate(shape, outer) minus dilate(shape, inner)
 *
 * A negative radius is an EROSION, which is the same construction reflected: fill the
 * shape, then knock out a centred stroke at `2|r|`.
 *
 * The knockout MUST happen on a scratch canvas. A `destination-out` on `ctx` would eat the
 * layer's own fill and every backdrop pixel under the shape — the Critical this feature can
 * cause, and the reason there is a test asserting the shared context never sees one.
 *
 * `dash` is ignored once `distance !== 0`: a dashed offset band would have to run its dash
 * pattern along the OFFSET curve, which does not exist as a path here (only the two dilation
 * radii do) — so a dashed distance stroke draws as a solid band. The inspector hides the Dash
 * row for a stroke with a distance (Task 9).
 */
export function paintStrokeBand(ctx: CanvasRenderingContext2D, o: {
  width: number
  distance?: number
  style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
  align?: StrokeAlign
  join?: StrokeJoin
  dash?: [number, number] | null
  path?: Path2D | null
  fillRule?: CanvasFillRule
  build?: (c: CanvasRenderingContext2D) => void
  /** How the shape's INTERIOR is laid down on a dilation surface. Defaults to the path
   *  primitive — `fill(path)` when a Path2D is supplied, else `fill()` on the surface's
   *  current path. */
  inkFill?: (c: CanvasRenderingContext2D) => void
  /** How the shape's OUTLINE is stroked, at the `lineWidth` this helper has already set.
   *  Defaults to `stroke(path)` / `stroke()`. Supply BOTH of these together: a dilation is
   *  the fill plus the stroke of the same ink, so a mismatched pair bands nothing. */
  inkStroke?: (c: CanvasRenderingContext2D) => void
}) {
  if (!(o.width > 0)) return
  const d = typeof o.distance === 'number' && Number.isFinite(o.distance) ? o.distance : 0
  if (d === 0) { strokeAligned(ctx, o); return }

  const align = strokeAlignOf(o.align)
  // The band's two radii, measured from the shape's own edge.
  // `outer - inner === o.width` for all three alignments, and `o.width > 0` is
  // already guaranteed above, so `outer > inner` always holds here — no
  // `outer <= inner` guard is reachable (checked algebraically for all three
  // branches and confirmed no other case reaches this point).
  const outer = align === 'outside' ? d + o.width : align === 'inside' ? d : d + o.width / 2
  const inner = align === 'outside' ? d : align === 'inside' ? d - o.width : d - o.width / 2

  const s = scratchLike(ctx)
  if (!s) {
    // `strokeAligned`'s no-scratch fallback strokes `o.path` or ctx's CURRENT path — a
    // text band has neither (text draws with `fillText`/`strokeText`, never a path), so
    // that fallback's bare `ctx.stroke()` would draw nothing (or worse, whatever path a
    // previous layer happened to leave on `ctx`). Only text supplies `inkStroke`, so its
    // presence is what tells the two apart: fall back to it centred, honest ink rather
    // than a stroke with nothing to stroke.
    if (o.inkStroke) {
      ctx.lineWidth = o.width
      ctx.strokeStyle = o.style(ctx)
      o.inkStroke(ctx)
      return
    }
    strokeAligned(ctx, o); return   // no knockout on the shared ctx, ever
  }
  if (o.build) o.build(s)
  s.lineJoin = o.join === 'round' ? 'round' : 'miter'
  const rule = o.fillRule || 'nonzero'
  // The two ink primitives. A dilation by `r` is `fill(shape)` plus `stroke(shape)` at
  // `lineWidth = 2r` — a construction that says nothing about WHICH primitives lay the ink
  // down. Injecting the pair is what lets TEXT band at a distance with no path at all:
  // `fillText(t,x,y)` + `strokeText(t,x,y)` at the same lineWidth is the dilation of that
  // run's ink (see `paintTextStrokeBands`). Absent, these are exactly the path statements
  // this closure used to hardcode, so every shape kind is untouched.
  const inkFill = o.inkFill ?? ((c: CanvasRenderingContext2D) => { if (o.path) c.fill(o.path, rule); else c.fill(rule) })
  const inkStroke = o.inkStroke ?? ((c: CanvasRenderingContext2D) => { if (o.path) c.stroke(o.path); else c.stroke() })
  const region = (c: CanvasRenderingContext2D, r: number) => {
    // r > 0 grows the shape; r < 0 shrinks it; r == 0 is the shape itself.
    inkFill(c)
    if (r === 0) return
    c.lineWidth = Math.abs(r) * 2
    if (r > 0) {
      c.strokeStyle = '#000'
      inkStroke(c)
    } else {
      const prev = c.globalCompositeOperation
      c.globalCompositeOperation = 'destination-out'
      c.strokeStyle = '#000'
      inkStroke(c)
      c.globalCompositeOperation = prev
    }
  }
  region(s, outer)
  const knock = scratchLike(ctx)
  if (knock) {
    if (o.build) o.build(knock)
    knock.lineJoin = s.lineJoin
    region(knock, inner)
    s.globalCompositeOperation = 'destination-out'
    s.setTransform(1, 0, 0, 1, 0, 0)
    s.drawImage(knock.canvas, 0, 0)
    s.setTransform(ctx.getTransform())
    s.globalCompositeOperation = 'source-over'
  }
  // Paint the band's colour through the mask we just built.
  //
  // The fill MUST run under the transform the paint was RESOLVED against. `o.style(s)`
  // can hand back a `CanvasPattern` or a `CanvasGradient`, and Canvas2D resolves both of
  // those in the transform current at FILL time, not at creation time — `resolvePaint`
  // builds them centred on the origin in the caller's own units, so filling under identity
  // drops the tile at the DEVICE origin at the wrong scale (a small patch in the canvas
  // corner) and flattens a gradient to its padded end colour. A colour STRING is
  // transform-independent, which is exactly why only these two ever showed it, and why
  // every solid-colour stroke rendered correctly throughout.
  //
  // The mask still has to be covered completely, and the mask lives in DEVICE pixels — so
  // the region filled is the device canvas's four corners carried BACK through the inverse
  // of the current transform. That is exact under scale, rotation and shear alike, and it
  // never leaves user space, so the pattern's geometry stays where the shape put it.
  s.globalCompositeOperation = 'source-in'
  s.fillStyle = o.style(s)
  const cover = deviceCoverQuad(s)
  if (cover) {
    s.beginPath()
    s.moveTo(cover[0]!.x, cover[0]!.y)
    for (let i = 1; i < cover.length; i++) s.lineTo(cover[i]!.x, cover[i]!.y)
    s.closePath()
    s.fill()
  } else {
    // Nothing to map through: the transform is singular, or this runtime's matrix has no
    // `inverse`. Degrade to the device-space fill rather than throwing — a colour string
    // still lands exactly as it always did, and a collapsed transform has no recognisable
    // picture to get right either way.
    s.setTransform(1, 0, 0, 1, 0, 0)
    s.fillRect(0, 0, s.canvas.width, s.canvas.height)
    s.setTransform(ctx.getTransform())
  }
  s.globalCompositeOperation = 'source-over'
  stampScratch(ctx, s)
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

/**
 * A closed layer's outline as SVG path data, in the SAME units the context that draws the
 * layer is currently in: PIXELS for a rect/ellipse (their ctx is unscaled and `W` px per
 * stored unit), LOCAL units for a path (its ctx is already scaled by `scale * W`, and `d`
 * is stored in exactly those units). That invariant is what lets `paintStrokeStack` use
 * its own `widthScale` — `W` and 1 respectively — as the single unit conversion a shapes
 * stroke needs, the same number it already scales a band's width and distance by.
 *
 * Null for a kind with no outline, which is what makes a shapes stroke unreachable on TEXT
 * by construction rather than by a check somewhere in the UI (`strokeSupportsShapes` says
 * the same thing to the inspector). Text is doubly safe: it never reaches
 * `paintStrokeStack` at all — see `paintTextStrokeBands`.
 *
 * Polygon and star return their `polygonPathData` / `starPathData` outline in LOCAL units
 * at `scale: 1` (F2 needs a base `d` for the geometry seam). `drawLayerContent` still
 * rewrites both into a `kind: 'path'` layer to paint, so a shapes stroke marches the same
 * curve either way — the units match by construction.
 */
export function outlinePathData(layer: unknown, W: number, ctxOverride?: CanvasRenderingContext2D | null): string | null {
  const l = layer as LocalLayer | null | undefined
  if (!l) return null
  if (l.kind === 'rect') {
    const w = l.w * W, h = l.h * W
    const [tl, tr, br, bl] = cornerRadii(l.radius, w, h, W)
    return roundedRectPathData(-w / 2, -h / 2, w, h, tl, tr, br, bl)
  }
  if (l.kind === 'ellipse') return ellipsePathData((l.w * W) / 2, (l.h * W) / 2)
  if (l.kind === 'path') return l.d
  // Polygon / star: their `d` in the SAME LOCAL units a path uses (1 unit = canvas width,
  // ctx scaled by `scale`·W = W since these are drawn at scale 1). `drawLayerContent`
  // rewrites both into a path layer to paint, so returning their outline here lets the
  // geometry seam (`computedOutlineD`) and a shapes stroke march the identical curve.
  if (l.kind === 'polygon') {
    const pl = l as unknown as PolygonLayer
    return polygonPathData(pl.sides, pl.w, pl.h, pl.cornerRadius) || null
  }
  if (l.kind === 'star') {
    const sl = l as unknown as StarLayer
    return starPathData(sl.points, sl.innerRatio, sl.w, sl.h, sl.cornerRadius) || null
  }
  // Text (Frame slice F1): glyph outlines in the same LOCAL px a rect/ellipse use
  // (the text ctx is unscaled, `W` px per stored unit). `null` when the font can't
  // be outlined, so F2 can gate a geometry effect cleanly.
  if (l.kind === 'text') return textLayerOutline(l as unknown as TextLayer, W, ctxOverride)
  return null
}

// ── Frame slice F2: geometry effects on a layer's outline ─────────────────────
// The visible geometry effects (trim / offset / round corners / roughen) on a layer, in
// list order — the ones that transform the outline BEFORE it rasterises. Read straight
// through `effectStackOf`, so an old- or new-shape layer answers the same.
export function layerGeometryEffects(layer: unknown): EffectInstance[] {
  return effectStackOf(layer as Parameters<typeof effectStackOf>[0])
    .filter(e => e.visible && isGeometryKind(e.type))
}

/** A text layer that fillText must ink rather than outline: underline / strikethrough are
 *  drawn as rectangles, and a distance-band stroke is a dilation — neither has an outline
 *  counterpart (see `collectTextOutline`, which drops both). Such a layer skips the
 *  computed-outline path (and therefore geometry) silently. */
function textHasDecoration(layer: TextLayer): boolean {
  if (layer.underline || layer.strikethrough) return true
  return strokeStackOf(layer as unknown as Parameters<typeof strokeStackOf>[0])
    .some(st => st.visible !== false && (st.distance ?? 0) !== 0
      && hasPaint(st.paint) && (st.width ?? 0) > 0)
}

/**
 * True when a layer must be drawn from a computed outline `d` rather than its imperative
 * fast path: a text layer asking for outlines (F1) OR any vector layer carrying a geometry
 * effect (F2). Only the vector kinds that can PRODUCE an outline qualify (rect, ellipse,
 * path, polygon, star, text); image / wired / brush / deal / scatter / line never do.
 *
 * A DECORATED text layer is excluded (see `textHasDecoration`): it inks with fillText, so a
 * geometry effect on it is silently a no-op rather than dropping the decoration.
 */
export function needsComputedOutline(layer: LocalLayer): boolean {
  if (!canTakeGeometry(layer)) return false
  return needsTextOutline(layer) || layerGeometryEffects(layer).length > 0
}

/**
 * True when a layer is ELIGIBLE for a geometry effect — i.e. it can produce an outline the
 * transform can act on: a vector kind (rect / ellipse / path / polygon / star / text) that is
 * NOT decorated text. This is the vector half of `needsComputedOutline` without requiring an
 * effect to be present yet, so the add menu and the renderer share one answer: the menu greys
 * a geometry kind for exactly the layers on which the renderer would silently drop it.
 */
export function canTakeGeometry(layer: LocalLayer): boolean {
  const k = layer.kind
  const vector = k === 'rect' || k === 'ellipse' || k === 'path'
    || k === 'polygon' || k === 'star' || k === 'text'
  if (!vector) return false
  if (k === 'text' && textHasDecoration(layer as TextLayer)) return false
  return true
}

/**
 * True when a RASTER layer can take the `warp` effect as a pixel-domain mesh warp of its
 * rasterised content (F3 4b). Deliberately NOT `canTakeGeometry` (which is vector-only and
 * gates the other geometry kinds): `warp` is the one geometry kind that also runs on raster
 * layers, by warping the layer's own box-sized content offscreen rather than its outline.
 *
 * Only image / wired / brush qualify — the three kinds whose `localLayerBox` is a faithful,
 * self-contained render of their content (the same contract corner-pin relies on). Generative
 * kinds (deal / scatter / mosaic) and line paint outside their box, so a box-warp of them would
 * clip; they stay ineligible. Vectors are excluded here on purpose — they take the vector
 * outline warp through `applyGeometry` (Task 4a), never this raster path.
 */
export function canWarpRaster(layer: LocalLayer): boolean {
  const k = layer.kind
  return k === 'image' || k === 'wired' || k === 'brush'
}

/**
 * A layer's outline `d` with its geometry effects applied, in the SAME units
 * `outlinePathData` returns for that kind — PIXELS for rect / ellipse / text (drawn on an
 * unscaled ctx), LOCAL units for path / polygon / star (drawn on a ctx scaled by
 * `scale`·W). Null when the layer has no base outline (e.g. an image).
 *
 * Geometry dials are normalized to canvas width. For a pixel-unit outline the transform
 * scales them by W; for a local-unit one the same pixel size is `distance/scale` in local
 * units, so the ctx's own `scale`·W multiply lands it back on `distance`·W px. With no
 * geometry effect present `applyGeometry` returns the input by reference — so this equals
 * the untouched outline and the no-effect draw stays byte-identical.
 */
export function computedOutlineD(
  layer: unknown,
  W: number,
  resolveSibling?: (key: string) => ResolvedSibling | null,
): string | null {
  const base = outlinePathData(layer, W)
  if (base == null) return null
  const l = layer as LocalLayer
  const local = l.kind === 'path' || l.kind === 'polygon' || l.kind === 'star'
  const gW = local ? 1 / ((l as unknown as { scale?: number }).scale || 1) : W
  // F3 seam: `resolveSibling` is passed through to `applyGeometry` so a future boolean/morph
  // kind carrying a `refLayerId` can reach its partner's outline. Inert today (no current kind
  // reads it), and `undefined` for the sibling's own outline — the cycle guard.
  return applyGeometry(
    base,
    layerGeometryEffects(layer) as unknown as Parameters<typeof applyGeometry>[1],
    { W: gW, resolveSibling },
  )
}

/**
 * A stroke drawn as LIBRARY SHAPES marching along the (offset) outline, rather than as a
 * continuous band.
 *
 * Marks take the STROKE'S OWN paint, so a shapes stroke can be a gradient or a pattern
 * like any other. `drawShape` from lib/shapes/path2d is deliberately not used: its `fill`
 * is a colour STRING, and a resolved `Paint` here can be a `CanvasGradient` or a
 * `CanvasPattern`. Its fit arithmetic is reproduced instead (`Math.min(size/bw, size/bh)`
 * onto the ink box, origin at `bx`/`by`), so a mark is sized the way the same shape is
 * sized everywhere else in the app.
 *
 * `unit` is px per stored unit — `paintStrokeStack`'s own `widthScale`, so `size` and
 * `spacing` land in the same units as a band's `width`, exactly as `ShapeStrokeSpec` says.
 */
function paintShapeStroke(ctx: CanvasRenderingContext2D, o: {
  pathData: string
  distance: number
  spec: ShapeStrokeSpec
  style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
  unit: number
  /** Flatten tolerance for `pathData`, in `pathData`'s OWN units — see
   *  `pathOutlineFlattenTolerance`'s header. NOT simply `DEFAULT_FLATTEN_TOLERANCE * unit`:
   *  `unit` converts `size`/`spacing`/`distance`, which for a path layer is 1 regardless of
   *  the layer's `scale` (its ctx is pre-scaled instead) — using it for tolerance too left a
   *  scaled path's chord error growing with `scale` uncorrected (Finding 2, Task 6 review:
   *  5.4 px at `scale: 3` on a 1200-wide frame, not the ~1.8 px a fixed `unit`-based
   *  tolerance implies). The caller computes this because only it knows the outline's
   *  actual pixels-per-unit (1 for rect/ellipse, `scale * W` for a path). */
  tolerance: number
  /** The stroke's wobble, already in this ctx's units (`wobbleSpecOf(st, widthScale)`) — the
   *  SAME resolved spec `paintWobbledBand` takes, so a band and marching shapes on the same
   *  stroke ride one line. `null`/absent: today's constant-distance guide, unchanged. */
  wobble?: WobbleSpec | null
}): void {
  const shape = shapeById(o.spec.shapeId)
  if (!shape) return
  // WHERE each mark goes is `shapeStrokeMarkMatrices`' job, not this function's — the SVG
  // writer (`pathLayersToSvgDoc`) places its marks from the same call, so the exported file
  // and the canvas cannot drift. Everything left here is the CANVAS half: which Path2D,
  // which paint, one fill.
  const marks = shapeStrokeMarkMatrices({
    pathData: o.pathData,
    distance: o.distance,
    size: o.spec.size * o.unit,
    spacing: o.spec.spacing * o.unit,
    box: shape.box,
    follow: o.spec.follow,
    tolerance: o.tolerance,
    wobble: o.wobble,
  })
  if (!marks.length) return
  const src = shapePath2D(shape)
  // ONE path for the whole stroke, not one fill per mark. A CanvasGradient's coordinates
  // are read against the transform live at FILL time, so filling each mark under its own
  // translate/rotate/scale would squeeze a gradient stroke into every individual mark
  // instead of running it across the shape. Assembling the marks in the LAYER's space and
  // filling once keeps a gradient (or a pattern) meaning what it means on a band — and it
  // is a single canvas call instead of up to SHAPE_STROKE_MAX_MARKS of them.
  // (Every library shape is `nonzero` today; a future `evenodd` one whose marks OVERLAP —
  // which needs `spacing` below `size` — would hole itself where two marks meet.)
  const all = new Path2D()
  for (const m of marks) all.addPath(src, new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]))
  ctx.save()
  ctx.fillStyle = o.style(ctx)
  ctx.fill(all, shape.fillRule)
  ctx.restore()
}

/**
 * A band whose line WOBBLES — a different construction from `paintStrokeBand`'s, and
 * deliberately a separate function rather than a branch inside it.
 *
 * `paintStrokeBand` builds a band at a distance as the difference of two raster DILATIONS,
 * and a dilation has exactly ONE radius: it cannot express a line whose distance from the
 * edge varies with arc length. A wobbled band is therefore built the other way round —
 * flatten the outline, displace it through `offsetPolyline` (which does the wobbling), build
 * a `Path2D` from the result and STROKE it at `width`. Simpler, and it gets real joins and
 * caps for free, which is why the inspector shows Corners whenever a wobble is on.
 *
 * The consequence, and the reason for the separation: a straight band and a wobbled one are
 * now built by different code, so the straight one must stay PROVABLY untouched.
 * `paintStrokeStack` reaches this only when `wobbleSpecOf` says a wobble is live, so with no
 * wobble not one statement of the dilation path changes — which is what
 * `tests/fixtures/multi-stroke-legacy.txt` staying byte-identical proves.
 *
 * `align` moves the LINE, not the construction. The band an alignment describes spans
 * `[d, d + width]` (outside), `[d - width, d]` (inside) or `[d - width/2, d + width/2]`
 * (centre), so stroking at `width` about that span's MIDPOINT lays the ink exactly where the
 * dilation pair would have laid it — an amplitude approaching 0 lands on the straight band's
 * own place rather than half a width away from it.
 *
 * `dash` is honoured even at a non-zero distance, unlike `paintStrokeBand` (which drops it
 * there because the offset curve exists only as two dilation radii, never as a path). Here
 * the offset curve IS a path, so the pattern has something to run along.
 *
 * Only the LONGEST subpath wobbles — the same seam, and the same limit, marching shapes
 * already accept (see `shapeStrokeGuide`). `offsetPolyline` grows every ring by its OWN
 * winding, so displacing a hole ring alongside its outer ring would push the hole the wrong
 * way; taking one ring is honest about that limit instead of wrong about the geometry.
 *
 * Exported for the reason `paintStrokeBand` and `strokeAligned` are: it is the only way a
 * unit test can watch this route actually RUN, rather than infer it from pixels.
 */
export function paintWobbledBand(ctx: CanvasRenderingContext2D, o: {
  /** The layer's outline as path data, in the units this ctx currently draws in — exactly
   *  what `paintStrokeStack`'s `outline` supplies (see `outlinePathData`). */
  pathData: string
  width: number
  distance?: number
  /** Already resolved and already in this ctx's units — `wobbleSpecOf(st, widthScale)`. */
  wobble: WobbleSpec
  align?: StrokeAlign
  join?: StrokeJoin
  dash?: [number, number] | null
  style: (c: CanvasRenderingContext2D) => string | CanvasGradient | CanvasPattern
  /** Flatten tolerance for `pathData`, in `pathData`'s OWN units — see
   *  `pathOutlineFlattenTolerance`'s header for why a path layer cannot reuse `widthScale`. */
  tolerance?: number
}): void {
  if (!(o.width > 0)) return
  const d = typeof o.distance === 'number' && Number.isFinite(o.distance) ? o.distance : 0
  const align = strokeAlignOf(o.align)
  const centre = align === 'outside' ? d + o.width / 2 : align === 'inside' ? d - o.width / 2 : d
  const sub = longestSubpath(o.pathData, o.tolerance ? { tolerance: o.tolerance } : undefined)
  if (!sub) return
  const pts = offsetPolyline(sub.pts, sub.closed, centre, o.wobble)
  if (pts.length < 2) return
  const path = new Path2D()
  path.moveTo(pts[0]!.x, pts[0]!.y)
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]!.x, pts[i]!.y)
  if (sub.closed) path.closePath()
  // Wrapped in its own save/restore: `lineJoin`, `lineCap` and the dash list are all part of
  // the canvas state, so the shared ctx cannot leak any of them into the next stroke or the
  // next layer — the failure `strokeAligned`'s explicit dash reset exists to prevent.
  ctx.save()
  ctx.lineWidth = o.width
  ctx.lineJoin = o.join === 'round' ? 'round' : 'miter'
  // Caps only show on an OPEN outline, and they are the same corner question the join asks,
  // so one control governs both — a rounded zigzag with square ends would read as a bug.
  ctx.lineCap = o.join === 'round' ? 'round' : 'butt'
  ctx.strokeStyle = o.style(ctx)
  if (o.dash) ctx.setLineDash([o.dash[0], o.dash[1]])
  ctx.stroke(path)
  ctx.restore()
}

/**
 * Paint a layer's WHOLE stroke stack over a shape that is already on `ctx` (or handed in
 * as a `path`). THE single place a stroked kind's outlines are drawn, so rect, ellipse,
 * polygon, star and path can't drift apart on ordering, visibility or units.
 *
 * `widthScale` converts a stored stroke width (and distance) into the units the CURRENT
 * transform draws in: `W` for the kinds that store width normalized to canvas width, and
 * 1 for a path, whose ctx is already scaled by `scale * W` and whose widths are stored in
 * those same local units.
 *
 * A stack read through from the legacy single-stroke fields is exactly one entry at
 * distance 0, and `paintStrokeBand` delegates distance 0 straight to `strokeAligned` — so
 * for every frame saved before this existed, this loop runs the same statements the single
 * call it replaced ran, and the pixels are identical.
 */
function paintStrokeStack(
  ctx: CanvasRenderingContext2D,
  layer: unknown,
  paintBox: { w: number; h: number },
  o: {
    widthScale: number
    build?: (c: CanvasRenderingContext2D) => void
    path?: Path2D | null
    fillRule?: CanvasFillRule
    /** The layer's outline as path data IN THIS CONTEXT'S UNITS (see `outlinePathData`).
     *  A shapes stroke needs a path to flatten and march; absent, a stroke asking for that
     *  style simply paints nothing rather than falling back to a band that was not asked
     *  for.
     *
     *  MAY BE A THUNK, and should be whenever producing the data costs anything: only a
     *  `style: 'shapes'` entry reads it, and most layers have none — a rect or an ellipse
     *  built its (round-rect / four-bézier) path-data string on EVERY paint, on every frame
     *  of a live loop, for a stroke stack that never asks for it. Resolved at most once per
     *  call below, so several shapes strokes still cost one build. */
    outline?: string | null | (() => string | null)
    /** Flatten tolerance for `outline`, in `outline`'s OWN units — see
     *  `pathOutlineFlattenTolerance`'s header for why a path layer cannot reuse
     *  `widthScale` for this the way rect/ellipse do. Omitted ⇒
     *  `DEFAULT_FLATTEN_TOLERANCE * widthScale`, which is correct for rect/ellipse (whose
     *  outline is already in pixels) and is the fallback a future stroked kind gets if it
     *  forgets to pass one. */
    outlineTolerance?: number
  },
): void {
  const stack: StrokeInstance[] = strokeStackOf(layer as Parameters<typeof strokeStackOf>[0])
  if (!stack.length) return
  // `undefined` = not asked for yet; `null` = asked for, and there is none.
  let outlineMemo: string | null | undefined
  const outlineData = (): string | null => {
    if (outlineMemo === undefined) outlineMemo = (typeof o.outline === 'function' ? o.outline() : o.outline) ?? null
    return outlineMemo
  }
  // Painted in REVERSE list order so the FIRST row lands on top — the layer list's own
  // convention, and the one the tree shows.
  for (let i = stack.length - 1; i >= 0; i--) {
    const st = stack[i]!
    // `hasPaint` is re-checked here (not just in the reader) so the painter keeps the
    // exact gate it always had: a gradient with no stops paints nothing.
    if (st.visible === false || !hasPaint(st.paint)) continue
    // Dispatch on STYLE first, and `continue` unconditionally inside — not on whether
    // `st.shapes` happens to be truthy. `strokeStackOf` guarantees a style:'shapes' entry
    // always carries a real (if inert) `shapes` object, so `st.shapes` IS always truthy
    // here today; branching on style anyway means this loop cannot fall into the band arm
    // below for a shapes-style entry even if that upstream guarantee were ever weakened —
    // the missing/malformed-payload case (Finding 1, Task 6 review) used to fall through
    // to a full band paint here, using whatever stale `width` the row still carried.
    if ((st.style ?? 'band') === 'shapes') {
      // A shapes stroke is sized by its own `size`, not by the band `width` the row still
      // carries — so the zero-width gate below is the wrong question to ask of it.
      // `paintShapeStroke` does its own `size > 0` / `spacing > 0` check, and a zero/empty
      // `shapeId` (the normalised "no payload" case) resolves to no shape and no-ops too.
      const outline = outlineData()
      if (outline && st.shapes) {
        paintShapeStroke(ctx, {
          pathData: outline,
          distance: (st.distance ?? 0) * o.widthScale,
          spec: st.shapes,
          // REACH — `'extend'`, for the reason the straight band below spells out in full:
          // marks march at their own distance and size, landing clear of the paint box.
          style: (c) => resolvePaint(c, st.paint, paintBox, _fieldCtx, 'extend'),
          unit: o.widthScale,
          tolerance: o.outlineTolerance ?? DEFAULT_FLATTEN_TOLERANCE * o.widthScale,
          // Wobble is a property of the LINE, so both consumers of a stroke's line inherit
          // it: the band below reaches `paintWobbledBand` through this very same call, and
          // marching shapes ride the same displaced guide. Asked of `wobbleSpecOf` (not the
          // four raw fields) so "is it on" has one answer for both.
          wobble: wobbleSpecOf(st, o.widthScale),
        })
      }
      continue
    }
    if (!(st.width > 0)) continue
    // A WOBBLED band takes a different route entirely — see `paintWobbledBand`. The question
    // is put to `wobbleSpecOf` rather than re-derived from the four raw fields, and it is put
    // BEFORE `outlineData()` so an ordinary band still never pays to build the outline data
    // it does not read. `null` here ⇒ every statement below runs exactly as it always has.
    const wobble = wobbleSpecOf(st, o.widthScale)
    if (wobble) {
      const outline = outlineData()
      if (outline) {
        paintWobbledBand(ctx, {
          pathData: outline,
          width: st.width * o.widthScale,
          distance: (st.distance ?? 0) * o.widthScale,
          wobble,
          align: st.align,
          join: st.join,
          dash: strokeDashSegments(st.dash, o.widthScale),
          // REACH — `'extend'`, for the reason the straight band below spells out in full: a
          // wobbled band is displaced off the paint box as well as offset from it.
          style: (c) => resolvePaint(c, st.paint, paintBox, _fieldCtx, 'extend'),
          tolerance: o.outlineTolerance ?? DEFAULT_FLATTEN_TOLERANCE * o.widthScale,
        })
        continue
      }
      // No outline to wobble (a kind that has none). Falling through paints the straight band
      // this stroke would have painted before wobble existed — a wobble the geometry cannot
      // express must not cost the stroke its ink.
    }
    // DEFENSIVE, and deliberately kept as such. No branch below actually destroys `ctx`'s
    // current path: Canvas2D's `stroke()` / `fill()` / `clip()` do not consume it, and the
    // non-zero-distance band does all of its dilating and knocking out on SCRATCH contexts,
    // never touching `ctx`'s path at all. Rebuilding is therefore a no-op today — it is
    // here so that a future band style which does leave `ctx` mid-path cannot silently
    // corrupt the stroke after it. It is free of pixel consequences (byte-identity depends
    // on nothing here), so the safety is worth the redundant call.
    // A path layer hands its Path2D in instead and needs no rebuild.
    if (o.build && !o.path) o.build(ctx)
    paintStrokeBand(ctx, {
      width: st.width * o.widthScale,
      distance: (st.distance ?? 0) * o.widthScale,
      // REACH — `spread: 'extend'`. A band at a positive distance sits wholly outside the
      // shape's box, and even a distance-0 stroke puts its OUTER HALF beyond it.
      // The paint is anchored to the LAYER's box; ink beyond that box has no tile to sample
      // under the default `'box'` spread, so a `Fill` (Ombre, Grid, Stripes, Shapes, Paper…)
      // came out EMPTY there while a `Gradient` — which pads itself — did not. Measured before
      // the fix, red pixels against a flat-colour control on identical geometry: a band at
      // distance +0.06 inked 0 of 18,048; a wobbled one 0 of 14,022; marching shapes 138 of
      // 1,433; and a stroke ON THE EDGE 5,852 of 13,020, having lost its whole outer half.
      // `'extend'` cannot move a pixel INSIDE the box — the pad arm reuses `resolvePaint`'s own
      // ramp arithmetic and the repeat arm the same tile under the same transform — so no
      // already-correct pixel changes; see `PaintSpread` in ~/lib/paint/resolve.ts. A layer FILL
      // stays on `'box'`: its ink IS its box, and reach there would only be cost.
      style: (c) => resolvePaint(c, st.paint, paintBox, _fieldCtx, 'extend'),
      align: st.align,
      join: st.join,
      dash: strokeDashSegments(st.dash, o.widthScale),
      path: o.path,
      fillRule: o.fillRule,
      build: o.build,
    })
  }
}

// Per-kind shape rendering. Caller has already applied opacity + the layer's
// translate/rotate to `ctx`; here we just paint the geometry at the origin.
// `wiredLive`: same pre-resolved-content seam as `localLayerBox` above — paintLayer
// threads its once-per-call resolve through here too so the box a corner-pin/DOF
// offscreen was sized from is the exact same content it then draws.
/**
 * F3 long shadow: paint the SOLID directional shadow body BENEATH the shape's own fill + stroke.
 *
 * Called from each vector branch of `drawLayerContent` (rect / ellipse / path / polygon / star /
 * outlined text) right BEFORE that branch inks the shape, with the branch's FINAL geometry
 * outline `d` (already trimmed / offset / warped / boolean'd / morphed — `long_shadow` itself
 * no-ops in `applyGeometry`) and the geometry-unit width `gW` for that branch (px units → `W`;
 * local units → `1/scale` for path, `1` for polygon/star), so the length dial reads the same
 * pixel size on screen as `offset` does.
 *
 * A complete NO-OP when the layer carries no VISIBLE `long_shadow` (or its length ≤ 0):
 * `layerGeometryEffects` already filters to visible, `longShadowEffectOf` returns undefined for
 * length ≤ 0, and nothing touches the ctx — so a layer without the effect renders byte-
 * identically. The only ctx mutation is `fillStyle`, which every shape branch overwrites before
 * its own fill.
 */
function longShadowEffectOf(layer: LocalLayer): { angle?: number; length?: number; color?: string } | undefined {
  const eff = layerGeometryEffects(layer).find(e => e.type === 'long_shadow') as
    | { angle?: number; length?: number; color?: string } | undefined
  return eff && typeof eff.length === 'number' && Number.isFinite(eff.length) && eff.length > 0 ? eff : undefined
}
function maybePaintLongShadow(ctx: CanvasRenderingContext2D, layer: LocalLayer, outlineD: string | null, gW: number): void {
  if (!outlineD) return
  const eff = longShadowEffectOf(layer)
  if (!eff) return
  const angleDeg = typeof eff.angle === 'number' && Number.isFinite(eff.angle) ? eff.angle : 45
  const body = longShadowBody(outlineD, (angleDeg * Math.PI) / 180, (eff.length as number) * gW)
  if (!body) return
  ctx.fillStyle = typeof eff.color === 'string' && eff.color ? eff.color : 'rgba(0,0,0,0.35)'
  ctx.fill(new Path2D(body))
}

function drawLayerContent(ctx: CanvasRenderingContext2D, layer: LocalLayer, W: number, wiredLive?: WiredLive | null) {
  // F3 seam: the sibling-outline resolver for THIS layer, bound to the live stack (or undefined
  // outside a paint). Threaded into every geometry `applyGeometry`/`computedOutlineD` call below.
  // Inert until a geometry kind carries a `refLayerId` (F3 Task 2) — no current kind does, so the
  // resolver is never invoked and the rendered `d` is byte-identical with or without it.
  const rs = _siblingResolveFor ? _siblingResolveFor(layer) : undefined
  if (layer.kind === 'text') {
    // Frame slice F1: render from glyph outlines when the layer asks (and the font
    // can be outlined). Fill the outline `d` with the layer's text paint, then the
    // on-edge stroke passes over the SAME `d` — the byte-equivalent of the fillText
    // path's strokeText+fillText (strokes under the fill). When the font is still
    // loading `collectTextOutline` returns null: fall back to fillText this frame;
    // the host's `onCompositorFontReady` → renderStack wire repaints when it lands.
    // F2: a geometry effect must force the outline path even when `renderAsOutline` is unset,
    // or the effect is silently dropped. A decorated text layer is excluded (it inks with
    // fillText); a system font makes `collectTextOutline` return null → safe fillText fallback.
    const oc = (needsTextOutline(layer) || layerGeometryEffects(layer).length > 0)
      && !textHasDecoration(layer as TextLayer)
      ? collectTextOutline(layer, W) : null
    if (oc) {
      // F2: transform the outline by any geometry effect first. `needsComputedOutline`
      // is false for a decorated text layer, so a decorated one keeps its exact F1 `d`;
      // with no geometry effect `applyGeometry` returns `oc.d` by reference (byte-identical).
      const gd = needsComputedOutline(layer)
        ? applyGeometry(oc.d, layerGeometryEffects(layer) as unknown as Parameters<typeof applyGeometry>[1], { W, resolveSibling: rs })
        : oc.d
      // F3 long shadow: cast the body from the final glyph outline (px units) BENEATH both the
      // on-edge strokes and the text fill drawn below.
      maybePaintLongShadow(ctx, layer, gd, W)
      const path = new Path2D(gd)
      const passes = textStrokePasses(ctx, layer, W, oc.box)
      const anyDash = passes.some(p => p.dash)
      if (passes.length) ctx.lineJoin = 'round'
      for (const p of passes) {
        ctx.lineWidth = p.lineWidth
        ctx.strokeStyle = p.style
        if (anyDash) ctx.setLineDash(p.dash ? [p.dash[0], p.dash[1]] : [])
        ctx.stroke(path)
      }
      if (anyDash) ctx.setLineDash([])
      ctx.fillStyle = resolvePaint(ctx, layer.color, oc.box, _fieldCtx)
      ctx.fill(path)
    } else {
      drawText(ctx, layer, W)
    }
  } else if (layer.kind === 'rect') {
    const w = layer.w * W, h = layer.h * W
    const gd = needsComputedOutline(layer) ? computedOutlineD(layer, W, rs) : null
    if (gd != null) {
      // F2 geometry present: fill + stroke a SINGLE shared path (in pixels, unscaled ctx).
      maybePaintLongShadow(ctx, layer, gd, W) // F3: shadow body beneath the rect fill + stroke
      const path = new Path2D(gd)
      if (hasPaint(layer.fill)) { ctx.fillStyle = resolvePaint(ctx, layer.fill, { w, h }, _fieldCtx); ctx.fill(path) }
      paintStrokeStack(ctx, layer, { w, h }, { widthScale: W, path, outline: gd })
    } else {
      // One rounded path for every corner shape: a plain `radius` yields four
      // equal radii, so uniform rects draw exactly as before. `build` re-creates
      // the same path on the outside-align scratch canvas.
      const radii = cornerRadii(layer.radius, w, h, W)
      const build = (c: CanvasRenderingContext2D) => { c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h, radii) }
      build(ctx)
      if (hasPaint(layer.fill)) { ctx.fillStyle = resolvePaint(ctx, layer.fill, { w, h }, _fieldCtx); ctx.fill() }
      paintStrokeStack(ctx, layer, { w, h }, { widthScale: W, build, outline: () => outlinePathData(layer, W) })
    }
  } else if (layer.kind === 'ellipse') {
    const w = layer.w * W, h = layer.h * W
    const gd = needsComputedOutline(layer) ? computedOutlineD(layer, W, rs) : null
    if (gd != null) {
      maybePaintLongShadow(ctx, layer, gd, W) // F3: shadow body beneath the ellipse fill + stroke
      const path = new Path2D(gd)
      if (hasPaint(layer.fill)) { ctx.fillStyle = resolvePaint(ctx, layer.fill, { w, h }, _fieldCtx); ctx.fill(path) }
      paintStrokeStack(ctx, layer, { w, h }, { widthScale: W, path, outline: gd })
    } else {
      const build = (c: CanvasRenderingContext2D) => { c.beginPath(); c.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2) }
      build(ctx)
      if (hasPaint(layer.fill)) { ctx.fillStyle = resolvePaint(ctx, layer.fill, { w, h }, _fieldCtx); ctx.fill() }
      paintStrokeStack(ctx, layer, { w, h }, { widthScale: W, build, outline: () => outlinePathData(layer, W) })
    }
  } else if (layer.kind === 'path') {
    // F2: a geometry effect transforms `d` in the path's own local units (its ctx is
    // scaled by `scale`·W), so the pixel size of a width-normalized dial is preserved.
    // `drawPath` never reads `effects`, so handing it the transformed `d` cannot double-apply.
    if (needsComputedOutline(layer)) {
      const gd = computedOutlineD(layer, W, rs)
      if (gd != null) {
        // Path geometry runs in LOCAL units; `drawPath` scales the ctx by `scale·W` itself, so
        // the shadow body — built in the SAME local units as `gd` — must be painted under the
        // same transform. gW = 1/scale so `length·gW` local units land at `length·W` px on
        // screen, exactly like offset. Wrapped only when a long shadow is present (byte-identical
        // otherwise — no stray save/scale).
        if (longShadowEffectOf(layer)) {
          const s = ((layer as unknown as { scale?: number }).scale || 1) * W
          ctx.save(); ctx.scale(s, s)
          maybePaintLongShadow(ctx, layer, gd, 1 / ((layer as unknown as { scale?: number }).scale || 1))
          ctx.restore()
        }
        drawPath(ctx, { ...layer, d: gd }, W)
      }
    } else {
      drawPath(ctx, layer, W)
    }
  } else if (layer.kind === 'polygon' || layer.kind === 'star') {
    const base = layer.kind === 'polygon'
      ? polygonPathData(layer.sides, layer.w, layer.h, layer.cornerRadius)
      : starPathData(layer.points, layer.innerRatio, layer.w, layer.h, layer.cornerRadius)
    // Geometry runs in LOCAL units (scale 1 ⇒ ctx scaled by W below); no effect ⇒ `base`
    // unchanged, so the rewrite-to-path draw stays byte-identical.
    const d = needsComputedOutline(layer)
      ? applyGeometry(base, layerGeometryEffects(layer) as unknown as Parameters<typeof applyGeometry>[1], { W: 1, resolveSibling: rs })
      : base
    if (d) {
      // Polygon/star geometry runs at scale 1, so `drawPath` scales the ctx by W. Paint the
      // shadow body under the SAME W scale, with gW = 1 (the local unit IS the width-normalized
      // unit here), so `length` local units land at `length·W` px like offset. Wrapped only when
      // a long shadow is present (byte-identical otherwise).
      if (longShadowEffectOf(layer)) {
        ctx.save(); ctx.scale(W, W)
        maybePaintLongShadow(ctx, layer, d, 1)
        ctx.restore()
      }
      drawPath(ctx, {
        ...layer, kind: 'path', d, bbox: { w: layer.w, h: layer.h }, scale: 1, fillRule: 'nonzero',
        fill: layer.fill, stroke: layer.stroke, strokeWidth: layer.strokeWidth,
        // Alignment + dashes ride along: at scale 1 a polygon/star's local units
        // ARE width-normalized, so both mean the same thing on either side.
        strokeAlign: layer.strokeAlign, strokeDash: layer.strokeDash,
        // …and so does the stroke STACK, for the same reason, so `drawPath`'s own
        // `strokeStackOf` sees the identical list. Named explicitly rather than left to
        // the spread above so a future rename of the field can't silently drop it here.
        strokes: (layer as unknown as { strokes?: unknown }).strokes,
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
    // A living image draws the frame for the paint clock (`_fieldCtx.t`, set by
    // paintLayerStack) offset by the clone being painted; without a clip, or until
    // every frame is loaded, `clipFrameFor` is null and the still paints exactly as before.
    const img = clipFrameFor(layer, _fieldCtx.t, _cloneSlot.k, _cloneSlot.n)
      ?? _imageCache.get(imageLayerUrl(layer.filename))
    if (img && img.complete && img.naturalWidth) {
      if (hasPaint(layer.tint)) drawTintedImage(ctx, img, layer, w, h)
      else ctx.drawImage(img, -w / 2, -h / 2, w, h)
    } else if ((layer as ImageLayer).standIn) {
      // Poster stand-in: a clear grey "photo goes here" box (a real photo replaces it on apply).
      ctx.fillStyle = 'rgba(140,140,140,0.55)'
      ctx.fillRect(-w / 2, -h / 2, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.01)
      ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4)
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
        // Stroke space → device is now `W*dpr*scale` per unit (see octx.translate +
        // stampStrokes above), so BOTH the translate and the linear scale carry `* scale`
        // — a frame-anchored shader field must sample at the same density the strokes are
        // drawn at, or a resized brush's fill drifts out of alignment. (scale===1 for an
        // un-resized brush ⇒ dpr*1 ⇒ byte-identical to before.)
        _fieldCtx = { ..._fieldCtx, base: new DOMMatrix().translateSelf(-b.minX * W * dpr * scale, -b.minY * W * dpr * scale).scaleSelf(dpr * scale) }
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
    const seed = layer.grid.gen.seed
    ctx.save()
    ctx.translate(-boxW / 2, -boxH / 2)
    // Clip EVERY mode to the box. The ported generators rely on the canvas edge to
    // clip them (Parcel strokes edge-touching hairlines at W+.5; Mosh / Modular rects
    // are oversized by +1 so neighbours never show a seam) — a deal box has no edge,
    // so without this they spill 1 px past the box whenever the deal is smaller than
    // the frame. The solid path's tiles are drawn inside the box anyway; the clip
    // is a no-op for them. Undone by the restore() below.
    ctx.beginPath()
    ctx.rect(0, 0, boxW, boxH)
    ctx.clip()
    const shaderFill = dealShaderFill(layer)
    if (shaderFill) {
      // Oddgrid / Static: paint the box with the layer's shader Fill through the SAME
      // resolvePaint path a rect with a shader fill takes (its field was requested by
      // the pre-pass via layerPaints('deal') — without that request resolveField has
      // nothing and this falls back to the spec's input paint). resolvePaint's
      // geometry is CENTRED on the origin (see ~/lib/paint/resolve), so step back to
      // the box centre for the fill: the object-anchored pattern sits at
      // (-boxW/2, -boxH/2); the frame-anchored one is positioned from _fieldCtx.base
      // and ignores this translate either way. The clip above still bounds it.
      // The BOX is the shader's frame (review finding: a frame-anchored field is a
      // window the box slides over, and a thumbnail / selection PNG painted outside a
      // stack span read a stale frame base). Swapping _fieldCtx's frame for the box
      // — its size AND its base transform, captured here at the box's top-left —
      // makes the field render at the box's own aspect (square cells stay square),
      // sit exactly on the box, travel with it, and repeat per cloner copy. The
      // pre-pass requests this same box-sized field (see paintLayerStack), so the
      // key matches. Restored right after: the rest of the layer still sees the frame.
      const frameCtx = _fieldCtx
      _fieldCtx = { ...frameCtx, frameW: boxW, frameH: boxH, base: ctx.getTransform() }
      try {
        ctx.fillStyle = resolvePaint(ctx, shaderFill, { w: boxW, h: boxH }, _fieldCtx)
        ctx.fillRect(0, 0, boxW, boxH)
      } finally { _fieldCtx = frameCtx }
    } else if (layer.cellFill === 'pane') {
      // Pane paints its OWN masonry — NOT the shared grid: every cell is flush and
      // filled, so regularity / merge / density / inset don't apply here. Each cell
      // gets a canvas linear gradient over its EXACT corner/edge endpoints (the
      // direction is a vector in cell fractions, not an angle — building it directly
      // on the cell rect keeps the endpoints on the cell's corners, which is the look).
      const pane = layer.pane ?? defaultPane()
      const palette = panePalette(pane, layer.vocab)
      for (const r of paneRegions(pane, boxW, boxH, seed)) {
        const g = paneCellGradient(pane, palette, seed, r.i, r.j)
        const grad = ctx.createLinearGradient(r.x + g.x0 * r.w, r.y + g.y0 * r.h, r.x + g.x1 * r.w, r.y + g.y1 * r.h)
        for (const s of g.stops) grad.addColorStop(s.offset, s.color)
        ctx.fillStyle = grad
        ctx.fillRect(r.x, r.y, r.w, r.h)
      }
    } else if (layer.cellFill === 'modular') {
      // Modular paints its OWN module grid — NOT the shared grid: a background, then
      // every module by its type (empty / solid / blocks / dots / lines / grad) and
      // the hairlines over the whole box, straight on the real ctx (fillRect /
      // createLinearGradient / arc / stroke). Regularity / merge / density / inset /
      // force-keep don't apply; only the grid's seed carries the variation.
      const modular = layer.modular ?? defaultModular()
      paintModular(ctx, modular, modularPalette(modular, layer.vocab), boxW, boxH, seed)
    } else if (layer.cellFill === 'parcel') {
      // Parcel paints its OWN coarse grid — NOT the shared grid: ground over the
      // box, cell-snapped ink runs, then the hairline survey lattices stroked with
      // a multiply composite (when blend says so) straight on the real ctx, and the
      // composite op put back. Regularity / merge / density / inset / force-keep
      // don't apply; only the grid's seed carries the variation.
      const parcel = layer.parcel ?? defaultParcel()
      paintParcel(ctx, parcel, boxW, boxH, seed)
    } else if (layer.cellFill === 'mosh') {
      // Mosh paints its OWN bands — NOT the shared grid: uneven horizontal bands
      // of column-quantised filled rects, straight on the real ctx, fillStyle +
      // fillRect and nothing else (no alpha / composite writes — the layer's own
      // opacity and blend already on the ctx ride through). Regularity / merge /
      // density / inset / force-keep don't apply; only the grid's seed carries the
      // variation.
      const mosh = layer.mosh ?? defaultMosh()
      paintMosh(ctx, mosh, mosh.inks, boxW, boxH, seed)
    } else if (layer.cellFill === 'carve') {
      // Carve paints its OWN panels — NOT the shared grid: the box is carved by
      // repeated splits and every panel gets one printed treatment in two of the
      // style's own inks, straight on the real ctx (the grainy panels go through
      // an offscreen canvas and drawImage, so the layer's opacity, transform and
      // this box clip all still apply). Regularity / merge / density / inset /
      // force-keep don't apply; only the grid's seed carries the variation.
      // Raw layers reach paint un-normalized (hand-edited or imported frames may carry
      // a partial `carve` with no `inks`), and paintCarve's own internal normalizeCarve
      // only guards `params`, not the separate `palette` argument — so normalize here
      // and pass THAT object's inks, never the raw layer's.
      const carve = normalizeCarve(layer.carve)
      paintCarve(ctx, carve, carve.inks, boxW, boxH, seed)
    } else if (layer.cellFill === 'totem') {
      // Totem paints its OWN framed plate — NOT the shared grid: the mat, the border
      // speckle, the blocks carved out of the left half and mirrored onto the right,
      // and the emblem at the centre, all as filled rects on its own lattice straight
      // on the real ctx. Regularity / merge / density / inset / force-keep have no part
      // in it; only the grid's seed carries the variation. Raw layers reach paint
      // un-normalized (an imported or hand-edited frame may hold a half-written
      // `totem`), and paintTotem normalizes its params — including the ink row it reads
      // the roles off — so the raw object is safe to hand it.
      paintTotem(ctx, normalizeTotem(layer.totem ?? defaultTotem()), boxW, boxH, seed)
    } else if (layer.cellFill === 'blueprint') {
      // Blueprint paints its OWN drafting grid — NOT the shared grid: the paper ground,
      // the cartesian minor/major lattice, then the polar overlay (dashed radial spokes,
      // concentric arcs with hatch ticks, and angle labels) struck from a seeded origin,
      // straight on the real ctx. It writes no absolute globalAlpha / composite op (every
      // per-element dim is baked into an rgba ink), and resets its spoke line-dash. The
      // origin may sit outside the box; this branch's clip trims the fan. Regularity /
      // merge / density / inset / force-keep don't apply; only the grid's seed carries the
      // variation (it rolls the origin corner + offset). Raw layers reach paint
      // un-normalized, and paintBlueprint normalizes its own params.
      paintBlueprint(ctx, normalizeBlueprint(layer.blueprint ?? defaultBlueprint()), boxW, boxH, seed)
    } else {
      // Resolve cells FLUSH (gutter 0): the deal's only cell gap is `cellInset`, applied
      // per cell below. The grid's own gutter would add a second, hidden gap so cells are
      // never flush even at cellInset 0 — which is not what the inset control implies.
      const { regions } = resolveGrid({ ...layer.grid, gutter: 0 }, boxW, boxH)
      const density = layer.density ?? 1
      const inset = Math.max(0, Math.min(0.4, layer.cellInset ?? 0))
      // Force-keep one cell when density > 0 so a sparse deal never renders fully
      // blank (an invisible layer the user just added). Explicit density 0 stays empty.
      const forceIdx = density > 0 ? forceKeptCell(seed, regions.length) : -1
      for (let i = 0; i < regions.length; i++) {
        if (i !== forceIdx && !keptCell(seed, i, density)) continue
        const r = regions[i]!
        const ins = inset * Math.min(r.w, r.h)
        const cw = r.w - ins * 2, ch = r.h - ins * 2
        if (cw <= 0.5 || ch <= 0.5) continue
        // paintTileBox paints ANY Paint (solid / gradient / pattern Fill) at corner
        // origin; a shader-typed Fill unwraps to its input there, so no field request
        // is needed (see layerPaints('deal')). Drawn into the cell's own sub-box.
        const tile = paintTileBox(pickDealPaint(layer.vocab, seed, i), cw, ch)
        ctx.drawImage(tile, r.x + ins, r.y + ins, cw, ch)
      }
    }
    ctx.restore()
  } else if (layer.kind === 'scatter') {
    // The Scatter element: ONE self-painting layer of thrown marks. Centred like every
    // other layer — shift so the box top-left sits at (-boxW/2, -boxH/2) — then the
    // layer's STYLE paints one sheet over the box (lib/compositor/scatter routes it).
    // Opacity / blend / mask / effects all ride the shared LayerCommon machinery
    // around this draw (paintLayer wraps it), so this branch only lays down pixels.
    const boxW = Math.max(1, layer.w * W), boxH = Math.max(1, layer.h * W)
    ctx.save()
    ctx.translate(-boxW / 2, -boxH / 2)
    // Clip to the box, for the same reason the deal does: the ported generators rely
    // on the canvas edge to clip them (a Chaff blade is allowed to start well outside
    // the frame so the big ones run off the edges), and a scatter box has no edge.
    ctx.beginPath()
    ctx.rect(0, 0, boxW, boxH)
    ctx.clip()
    // Raw layers reach paint un-normalized (a hand-edited or imported frame may carry a
    // partial style object, or none at all) — paintScatter normalizes through the
    // style's own registry row before anything is drawn.
    paintScatter(ctx, layer, boxW, boxH)
    ctx.restore()
  }
}

/**
 * Build this layer's guide, with the font already applied so the natural run
 * width that sizes a `curve`/`wave` is measured under the real font.
 *
 * Returns null whenever the spec can't produce a curve; every caller treats that
 * as "render flat", never as "render nothing".
 */
function textPathGuide(ctx: CanvasRenderingContext2D, layer: TextLayer, W: number) {
  if (!layer.path) return null
  applyFont(ctx, layer, W)
  return guideFromSpec(layer.path, W, measureRunPx(ctx, layer))
}

/**
 * One ON-THE-EDGE text outline, resolved and ready to draw with `strokeText`.
 *
 * A text stroke at DISTANCE 0 is the centred outline text has always had — `strokeText`
 * takes no path, so `align` has nothing to straddle and is ignored. A stroke at a distance
 * is a different construction entirely (a dilation band, see `paintTextStrokeBands`) and
 * never becomes a pass here; `strokeDistancePx` is the single place that split is made.
 *
 * Text still does NOT go through `paintStrokeStack`: that helper bands a Path2D or the
 * context's current path, and a Frame text layer has neither — it stores a CSS family name
 * and draws with `fillText`/`strokeText`. (`strokeSupportsShapes` excludes text for the
 * related reason: marching shapes need real glyph outlines to flatten.)
 */
interface TextStrokePass {
  lineWidth: number
  style: string | CanvasGradient | CanvasPattern
  dash: [number, number] | null
}

/** One run of text exactly as it gets drawn: the string, the anchor `fillText` is given,
 *  and — text on a path only — the rotation each glyph is turned by about that anchor. */
interface TextRun { text: string; x: number; y: number; angle?: number }

/**
 * A stroke's distance in the units the current transform draws in, or 0 when it has none.
 *
 * THE one place a stroke is classified as on-the-edge or distant. Both text paths consult
 * it — `textStrokePasses` to take the 0s, `paintTextStrokeBands` to take the rest — so a
 * stroke can never be drawn by both or dropped by both. A non-finite stored value reads as
 * 0, i.e. the plain centred outline, rather than vanishing.
 */
function strokeDistancePx(st: StrokeInstance, scale: number): number {
  const d = (st.distance ?? 0) * scale
  return Number.isFinite(d) ? d : 0
}

/**
 * A text layer's stroke stack, resolved once, in PAINT order (reverse list order, so the
 * first row lands on top — the layer list's own convention).
 *
 * Resolved up front rather than inside the per-line/per-glyph draw loop so `resolvePaint`
 * runs exactly once per stroke, as it did when a text layer had only one: a paint that
 * builds a gradient or a pattern should not be rebuilt per line.
 */
function textStrokePasses(
  ctx: CanvasRenderingContext2D, layer: TextLayer, W: number, box: { w: number; h: number },
): TextStrokePass[] {
  const stack = strokeStackOf(layer as unknown as Parameters<typeof strokeStackOf>[0])
  const out: TextStrokePass[] = []
  for (let i = stack.length - 1; i >= 0; i--) {
    const st = stack[i]!
    if (st.visible === false || !hasPaint(st.paint) || !(st.width > 0)) continue
    // A stroke at a distance is a dilation band, painted by `paintTextStrokeBands` before
    // these passes run. Skipping it here is what stops it being drawn twice.
    if (strokeDistancePx(st, W) !== 0) continue
    out.push({
      lineWidth: st.width * W,
      // REACH — `'extend'`, for the reason `paintStrokeStack`'s band arm spells out in full:
      // a glyph outline's outer half falls outside the text box its paint is anchored to.
      style: resolvePaint(ctx, st.paint, box, _fieldCtx, 'extend'),
      dash: strokeDashSegments(st.dash, W),
    })
  }
  return out
}

/**
 * Draw one run of text once per stroke in the stack.
 *
 * `setLineDash` is only touched when at least ONE pass is dashed: an all-solid stack
 * leaves the context's dash state exactly as untouched as the single-stroke code did,
 * while a mixed stack still can't leak one stroke's pattern onto the next.
 */
function strokeTextPasses(
  ctx: CanvasRenderingContext2D, passes: TextStrokePass[], anyDash: boolean,
  text: string, x: number, y: number,
): void {
  for (const p of passes) {
    ctx.lineWidth = p.lineWidth
    ctx.strokeStyle = p.style
    if (anyDash) ctx.setLineDash(p.dash ? [p.dash[0], p.dash[1]] : [])
    ctx.strokeText(text, x, y)
  }
}

/**
 * Every stroke in a text layer's stack that sits at a DISTANCE, painted as a band around
 * the layer's whole run of text.
 *
 * The construction is the shapes' one with different primitives. `paintStrokeBand` builds
 * a band as the difference of two dilations, and a dilation by `r` is `fill(shape)` plus
 * `stroke(shape)` at `lineWidth = 2r` — which for text is `fillText(t, x, y)` plus
 * `strokeText(t, x, y)`. So the pair is handed in as `inkFill`/`inkStroke` and text needs
 * no path, no glyph outlines and no font-file resolution. `align` and `distance` then
 * compose exactly as they do on a rect (the radii are `paintStrokeBand`'s own arithmetic).
 *
 * ONE band per stroke for the WHOLE block, not one per line: every run is drawn into the
 * same two dilation surfaces, so a multi-line block gets a single outline around the lot
 * (the "sticker" reading of an offset outline) instead of per-line rings that cross each
 * other. It is also the cheap way round — two scratch canvases per distant stroke rather
 * than two per line, which matters most for text on a path, where a run is one GLYPH.
 *
 * ORDER, stated plainly because it is a real limitation: the bands go down as a group,
 * beneath the on-edge outlines and the fill, in stack paint order among themselves. Inside
 * the per-line loop the stack's exact z-order is preserved for the on-edge strokes only —
 * a whole-block band cannot be interleaved with a per-line draw without giving up one of
 * the two. Under the glyphs is the useful answer anyway: a band is offset AWAY from the
 * ink, so the case where the choice is visible is a small distance, where keeping the
 * letterform legible on top is what a reader wants.
 *
 * `scratchLike` copies the transform but not the text state, so `build` restates the font,
 * alignment and baseline on each dilation surface — the exact hook `paintStrokeBand`
 * already offers the shape kinds for re-creating their path.
 */
function paintTextStrokeBands(
  ctx: CanvasRenderingContext2D, layer: TextLayer, W: number,
  box: { w: number; h: number }, runs: TextRun[],
): void {
  if (!runs.length) return
  const stack = strokeStackOf(layer as unknown as Parameters<typeof strokeStackOf>[0])
  if (!stack.length) return
  const font = ctx.font
  const textAlign = ctx.textAlign
  const textBaseline = ctx.textBaseline
  const spacing = (ctx as unknown as { letterSpacing?: string }).letterSpacing
  const variations = (ctx as unknown as { fontVariationSettings?: string }).fontVariationSettings
  const build = (c: CanvasRenderingContext2D) => {
    c.font = font
    c.textAlign = textAlign
    c.textBaseline = textBaseline
    // Tracking and variable axes are set by `applyFont` and are NOT part of the `font`
    // shorthand, so a scratch that only copied `font` would measure and place the run
    // differently from the surface it is stamped onto.
    if (spacing != null && 'letterSpacing' in c) (c as unknown as { letterSpacing: string }).letterSpacing = spacing
    if (variations != null && 'fontVariationSettings' in c) (c as unknown as { fontVariationSettings: string }).fontVariationSettings = variations
  }
  const eachRun = (c: CanvasRenderingContext2D, draw: (t: string, x: number, y: number) => void) => {
    for (const r of runs) {
      if (r.angle) {
        // Text on a path: each glyph is drawn at the origin of its own turned frame,
        // exactly as `drawTextOnPath` draws it.
        c.save(); c.translate(r.x, r.y); c.rotate(r.angle); draw(r.text, 0, 0); c.restore()
      } else draw(r.text, r.x, r.y)
    }
  }
  // Reverse list order, so the FIRST row lands on top — the layer list's own convention,
  // and the same order `paintStrokeStack` and `textStrokePasses` use.
  for (let i = stack.length - 1; i >= 0; i--) {
    const st = stack[i]!
    if (st.visible === false || !hasPaint(st.paint) || !(st.width > 0)) continue
    const d = strokeDistancePx(st, W)
    if (d === 0) continue          // on the edge ⇒ the `strokeText` path, byte-identical
    paintStrokeBand(ctx, {
      width: st.width * W,
      distance: d,
      align: st.align,
      join: st.join,
      // REACH — `'extend'`, for the reason `paintStrokeStack`'s band arm spells out in full:
      // a text band pushed off the glyphs sits entirely outside the text box.
      style: (c) => resolvePaint(c, st.paint, box, _fieldCtx, 'extend'),
      build,
      inkFill: (c) => eachRun(c, (t, x, y) => c.fillText(t, x, y)),
      inkStroke: (c) => eachRun(c, (t, x, y) => c.strokeText(t, x, y)),
    })
  }
}

/** The frame a letter behaviour scatters within (`text.scramble` states its area as a
 *  fraction of it). The draw chain is handed `W` only, so the height comes from the frame
 *  state `paintLayerStack` sets; outside a paint that is the sentinel 1, and a square W box
 *  is a far better answer than scattering into a one-pixel band. */
const motionFrameBox = (W: number) => ({ w: W, h: _fieldCtx.frameH > 1 ? _fieldCtx.frameH : W })

/**
 * Text along a guide: one glyph at a time, each centred on its own half-advance
 * and turned to the tangent there. Advances come from `placeGlyphs`, which
 * measures cumulative prefixes so kerning pairs survive.
 *
 * Fills resolve against the GUIDE's box rather than a line box, so a gradient or
 * pattern fill spans the ring the type sits on — which is what "fit the text"
 * means once the text is a circle.
 *
 * Underline/strikethrough are deliberately not drawn here: on a curve they stop
 * being rectangles and become stroked path segments (see the design spec).
 */
function drawTextOnPath(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  W: number,
  guide: NonNullable<ReturnType<typeof textPathGuide>>,
) {
  applyFont(ctx, layer, W)
  const placed = placeGlyphs(ctx, layer, guide, W)
  if (!placed.length) return
  // Each glyph is drawn centred on its own placement, so the anchor is the glyph
  // centre in both axes — not the run's left edge.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const textBox = guide.bounds()
  const passes = textStrokePasses(ctx, layer, W, textBox)
  const anyDash = passes.some(p => p.dash)
  // Letter behaviours: `textMotion` is a transient the fold parks on a CLONE for one frame
  // (see applyTextBehaviours). Absent — every layer today — this is one property read and
  // nothing below changes. Present but outside every bar, `movingTextFrame` returns null and
  // the static loop runs untouched, so a resting glyph keeps its exact placement.
  const tm = (layer as unknown as { textMotion?: TextMotion }).textMotion
  const moving = tm
    ? movingTextFrame(pathGlyphCells(placed, displayRun(layer), layer.fontSize * W), tm.behaviours, tm.t, motionFrameBox(W))
    : null
  // A run here is one GLYPH, each in its own turned frame — the band dilates all of them
  // together, so the outline follows the whole word around the curve. Skipped while the
  // letters are moving: the band is one dilation of the WHOLE run, and there is no reading
  // of "the sticker outline of a run whose glyphs are in different places" — see the
  // documented limitation in the letter-behaviour spec.
  if (!moving) paintTextStrokeBands(ctx, layer, W, textBox, placed.map(g => ({ text: g.ch, x: g.x, y: g.y, angle: g.angle })))
  if (passes.length) ctx.lineJoin = 'round'
  ctx.fillStyle = resolvePaint(ctx, layer.color, textBox, _fieldCtx)
  if (moving) {
    // Same shape as the loop below, but placed by the evaluated frame instead of the guide.
    // Styles are already set, once, so a gradient still spans the ring the type sits on.
    drawTextCells(ctx, moving.cells, moving.frame, (ch) => {
      strokeTextPasses(ctx, passes, anyDash, ch, 0, 0)
      ctx.fillText(ch, 0, 0)
    })
    if (anyDash) ctx.setLineDash([])
    return
  }
  for (const g of placed) {
    ctx.save()
    ctx.translate(g.x, g.y)
    ctx.rotate(g.angle)
    strokeTextPasses(ctx, passes, anyDash, g.ch, 0, 0)
    ctx.fillText(g.ch, 0, 0)
    ctx.restore()
  }
  if (anyDash) ctx.setLineDash([])   // never leak the pattern to the next layer
}

/**
 * The on-path counterpart of `drawText`'s flat collect sink (Frame slice F1,
 * Task 4): place each glyph's OUTLINE along the guide instead of inking it.
 *
 * Positions are `placeGlyphs`' own — the exact `{x, y, angle}` `drawTextOnPath`
 * inks at — so the outlined render matches the fillText path render glyph for
 * glyph. `placeGlyphs` measures under the layer's font, so `applyFont` runs first
 * exactly as `drawTextOnPath` does. The guide's own box is the outline's box, the
 * same box `drawTextOnPath` resolves its fill against. Empty placement pushes
 * nothing, so `collectTextOutline` returns null and the caller degrades to
 * fillText.
 */
function collectTextOnPathOutline(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  W: number,
  guide: NonNullable<ReturnType<typeof textPathGuide>>,
  collect: TextOutlineCollect,
): void {
  applyFont(ctx, layer, W)
  const placed = placeGlyphs(ctx, layer, guide, W)
  if (!placed.length) return
  const cmds = placedGlyphsToCommands(collect.font, placed, layer.fontSize * W, outlineAxesForLayer(layer))
  for (const c of cmds) collect.out.push(c)
  collect.box = guide.bounds()
}

/**
 * The variable-font coords the OUTLINE must be shaped at so it matches what
 * `applyFont` renders: the layer's weight as the `wght` axis, overlaid by any
 * explicit `layer.axes` (whose own `wght` wins, mirroring `applyFont`'s
 * `axes.wght ?? fontWeight`). `textOutlines` clamps to the font's real axis
 * ranges and drops tags it lacks, so a static per-weight cut (no axes) ignores
 * this — its weight is already baked into the fetched bytes.
 */
function outlineAxesForLayer(layer: TextLayer): Record<string, number> {
  return { wght: layer.fontWeight, ...(layer.axes || {}) }
}

/**
 * The collect sink `drawText` writes to instead of inking, when asked to emit
 * glyph OUTLINES rather than draw (Frame slice F1). `drawText`'s layout is reused
 * unchanged — the same `text/x/y/align/baseline` fillText would use — and each run
 * is turned into positioned commands by `runToCommands`, so the outline lands on
 * the very pixels fillText would. `box` is the layer's measured text box, captured
 * for the caller (fill paint anchoring). Both the flat layout and the on-path
 * layout collect; only expressive per-word layout returns without emitting (out
 * of F1 scope).
 */
interface TextOutlineCollect {
  font: VtFont
  out: VectorCommand[]
  box: { w: number; h: number }
}

/** Fill mode: the largest fontSize (normalized to width) at which the wrapped
 *  text still fits boxW (and boxH when set). A binary search over the same wrap +
 *  measure the renderer uses, so what fits here is what draws. */
function fillFontSize(ctx: CanvasRenderingContext2D, layer: TextLayer, W: number): number {
  const boxWpx = (layer.boxW ?? 0) * W
  if (!(boxWpx > 0)) return layer.fontSize
  const boxHpx = (layer.boxH ?? 0) * W
  const fits = (fsPx: number): boolean => {
    const probe = { ...layer, fontSize: fsPx / W } as TextLayer
    const lines = wrappedTextLines(ctx, probe, W)
    applyFont(ctx, probe, W)
    let maxW = 0
    for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln || ' ').width)
    if (maxW > boxWpx + 0.5) return false
    if (boxHpx > 0 && lines.length * fsPx * layer.lineHeight > boxHpx + 0.5) return false
    return true
  }
  let lo = 2, hi = (boxHpx > 0 ? boxHpx : boxWpx) * 3
  for (let i = 0; i < 32 && hi - lo > 0.25; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid }
  return lo / W
}

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, W: number, collect?: TextOutlineCollect) {
  if (layer.boxFit && layer.boxFit !== 'wrap' && (layer.boxW ?? 0) > 0 && !layer.expressive && !layer.path) {
    const fit = fillFontSize(ctx, layer, W)
    layer = { ...layer, fontSize: layer.boxFit === 'shrink' ? Math.min(layer.fontSize, fit) : fit }
  }
  const lineH = layer.fontSize * W * layer.lineHeight
  // A path takes over the whole layout: one run along a curve, so box wrapping,
  // valign, justify and expressive placement have nothing to act on. `null` from
  // textPathGuide means the spec couldn't make a curve (missing dial, zero
  // radius) — fall through to flat text rather than drawing nothing.
  if (layer.path) {
    const guide = textPathGuide(ctx, layer, W)
    if (guide) {
      // Collect mode places each glyph's OUTLINE along the same guide instead of
      // inking it; draw mode inks as before. A null guide (broken/zero dial) falls
      // through to the flat layout in both modes.
      if (collect) { collectTextOnPathOutline(ctx, layer, W, guide, collect); return }
      drawTextOnPath(ctx, layer, W, guide); return
    }
  }
  // Expressive per-word layout has its own draw loop; outlining it is out of F1
  // scope, so collect mode emits nothing and the caller falls back to fillText.
  if (layer.expressive) { if (collect) return; drawExpressiveText(ctx, layer, W, lineH); return }
  const { lines, ragged } = wrappedTextLinesMeta(ctx, layer, W)
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
  // Anchor the whole block by valign so it grows FROM the aligned edge: `top`
  // pins the top and grows down, `bottom` pins the bottom and grows up. The same
  // offset feeds the selection box (via textVAlignCenterOffset), so handles track
  // the drawn text. middle/justify/absent ⇒ 0 ⇒ the legacy centred block.
  const oy = textVAlignCenterOffset(layer, H)
  const lineY = (i: number): number => {
    if (!va && boxHpx <= 0) return startY + i * lineH
    if (vJustify) return -H / 2 + lineH / 2 + (i / (lines.length - 1)) * (H - lineH)
    const s = va === 'top' ? -H / 2 + lineH / 2 : va === 'bottom' ? H / 2 - totalH + lineH / 2 : startY
    return s + i * lineH + oy
  }
  const textBox = { w: Math.max(blockW, 1), h: Math.max(H, 1) }
  // `strokeText` honours setLineDash, so a text outline dashes like a shape's.
  const passes = textStrokePasses(ctx, layer, W, textBox)
  const anyDash = passes.some(p => p.dash)
  const fontPx = layer.fontSize * W
  const deco = layer.underline || layer.strikethrough
  const decoThick = Math.max(1, fontPx * 0.06)

  // Every run as it will be drawn, plus each line's decoration span, worked out BEFORE any
  // ink lands: a stroke at a distance dilates the whole block in one go
  // (`paintTextStrokeBands`), which needs all the runs in hand. Only `measureText` moved up
  // here, and it is pure — the draw loop below issues exactly the calls, in exactly the
  // order, that this loop used to issue inline.
  const drawn: { runs: TextRun[]; deco: { left: number; y: number; w: number } | null }[] = []
  for (let i = 0; i < lines.length; i++) {
    const y = lineY(i)
    if (justifyH && !ragged[i]) {
      // Distribute the line's words edge-to-edge across blockW. A paragraph's
      // wrapped tail (`ragged[i]`) is skipped, so it falls through to the normal
      // left-anchored draw below — ragged-left, like proper justified body copy.
      const words = (lines[i] || '').split(/\s+/).filter(Boolean)
      const widths = words.map(w => ctx.measureText(w).width)
      const total = widths.reduce((a, b) => a + b, 0)
      const gap = words.length > 1 ? Math.max(0, (blockW - total) / (words.length - 1)) : 0
      let cx = -blockW / 2
      const runs: TextRun[] = []
      for (let k = 0; k < words.length; k++) {
        runs.push({ text: words[k]!, x: cx, y })
        cx += widths[k]! + gap
      }
      drawn.push({ runs, deco: deco && words.length ? { left: -blockW / 2, y, w: blockW } : null })
      continue
    }
    const line = lines[i]!
    let dec: { left: number; y: number; w: number } | null = null
    // Decoration lines span the drawn line, anchored to match the text alignment.
    if (deco && line) {
      const lw = ctx.measureText(line).width
      const left = canvasAlign === 'left' ? anchorX : canvasAlign === 'right' ? anchorX - lw : anchorX - lw / 2
      dec = { left, y, w: lw }
    }
    drawn.push({ runs: [{ text: line, x: anchorX, y }], deco: dec })
  }

  // Emit one run at (x, y): draw it as today (default), or — in collect mode —
  // convert it to positioned glyph outlines with the SAME font px / letter
  // spacing / align the ctx carries, so the outline matches fillText.
  // `ctx.letterSpacing` is the exact (rounded) px `applyFont` set, read back so
  // the outline's spacing equals the canvas's to the pixel.
  const lsStr = (ctx as unknown as { letterSpacing?: string }).letterSpacing
  const letterSpacingPx = lsStr != null && lsStr !== ''
    ? (parseFloat(lsStr) || 0)
    : (layer.letterSpacing || 0) * fontPx
  // Vertical anchor: `drawText` sets `textBaseline` (always 'middle' here), and
  // canvas positions a run's baseline from the FONT's own ascent/descent, read
  // however Chromium reads them. Rather than re-derive that from `font.raw` (which
  // drifted a few px on real fonts), ask the real ctx: with the CSS font applied,
  // `fontBoundingBoxAscent` is measured from the CURRENT baseline, so the gap to
  // the 'alphabetic' reading is exactly how far the alphabetic baseline sits below
  // this anchor. We then emit at 'alphabetic' with y shifted by that gap — the
  // canvas's own metric, so the outline lands on fillText's pixels for any font.
  let baselineToAlphabeticPx = 0
  if (collect) {
    const anchor = ctx.textBaseline
    if (anchor !== 'alphabetic' && typeof ctx.measureText === 'function') {
      const asc = (b: CanvasTextBaseline): number => {
        ctx.textBaseline = b
        return Number((ctx.measureText('M') as { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent) || 0
      }
      const alphaAsc = asc('alphabetic')
      const anchorAsc = asc(anchor)
      baselineToAlphabeticPx = alphaAsc - anchorAsc
      ctx.textBaseline = anchor // restore (harmless in collect mode, but keep state honest)
    }
  }
  const emitRun = (text: string, x: number, y: number) => {
    if (collect) {
      const cmds = runToCommands(collect.font, { text, x, y: y + baselineToAlphabeticPx }, {
        fontPx, letterSpacingPx, align: ctx.textAlign, baseline: 'alphabetic',
      }, outlineAxesForLayer(layer))
      for (const c of cmds) collect.out.push(c)
      return
    }
    strokeTextPasses(ctx, passes, anyDash, text, x, y)
    ctx.fillText(text, x, y)
  }

  if (collect) collect.box = textBox
  // Letter behaviours: `textMotion` is a transient the fold parks on a CLONE for one frame
  // (see applyTextBehaviours). Absent — every layer today — this is one property read and
  // not a line below changes. Present but outside every bar, `movingTextFrame` returns null
  // and the run loop below runs untouched, which is what keeps the kerning and ligatures of
  // whole-run `fillText` at rest. Cells are built from the draw's OWN runs, by prefix
  // measurement, so a moving letter starts exactly where the static one sits. Never in
  // collect mode: an outlined layer is out of scope (it has no per-glyph seam here).
  const tm = collect ? undefined : (layer as unknown as { textMotion?: TextMotion }).textMotion
  const moving = tm
    ? movingTextFrame(
        textRunCells(ctx, drawn.flatMap((d, i) => d.runs.map(r => ({ text: r.text, x: r.x, y: r.y, line: i }))), fontPx, canvasAlign),
        tm.behaviours, tm.t, motionFrameBox(W),
      )
    : null
  // Distance-band strokes are painted by dilating fillText/strokeText and have no
  // counterpart in the collected outline (F1 renders the outline's own on-edge
  // stroke only); skip them in collect mode rather than inking the measuring ctx.
  // Skipped while letters move for the same reason as on a path: one band dilates the
  // whole block, and a block whose glyphs are scattered has no single silhouette.
  if (!collect && !moving) paintTextStrokeBands(ctx, layer, W, textBox, drawn.flatMap(d => d.runs))

  if (passes.length) ctx.lineJoin = 'round'
  ctx.fillStyle = resolvePaint(ctx, layer.color, textBox, _fieldCtx)
  if (moving) {
    // Every glyph is drawn centred on its own placement, exactly as the on-path renderer
    // does. The fill/stroke styles above are already set, once, so a gradient stays defined
    // over the whole text BLOCK rather than being re-resolved per letter.
    ctx.textAlign = 'center'
    drawTextCells(ctx, moving.cells, moving.frame, (ch) => {
      strokeTextPasses(ctx, passes, anyDash, ch, 0, 0)
      ctx.fillText(ch, 0, 0)
    })
    // A decoration spans a whole line, so it is drawn only for a line that is WHOLLY at
    // rest — an underline under letters arriving one at a time has no honest length.
    if (deco) {
      for (let i = 0; i < drawn.length; i++) {
        const dc = drawn[i]!.deco
        if (!dc || !lineAtRest(moving.cells, moving.frame.cells, i)) continue
        if (layer.underline) ctx.fillRect(dc.left, dc.y + fontPx * 0.34, dc.w, decoThick)
        if (layer.strikethrough) ctx.fillRect(dc.left, dc.y - decoThick / 2, dc.w, decoThick)
      }
    }
    if (anyDash) ctx.setLineDash([])   // never leak the pattern to the next layer
    return
  }
  for (const d of drawn) {
    for (const r of d.runs) emitRun(r.text, r.x, r.y)
    // Decorations are drawn in the text's own fill so they inherit gradient/pattern fills.
    // In collect mode they are rectangles, not glyph outlines, so they are not part of
    // the emitted `d` (an outlined layer with underline/strikethrough is not an F1 case).
    if (d.deco && !collect) {
      if (layer.underline) ctx.fillRect(d.deco.left, d.deco.y + fontPx * 0.34, d.deco.w, decoThick)
      if (layer.strikethrough) ctx.fillRect(d.deco.left, d.deco.y - decoThick / 2, d.deco.w, decoThick)
    }
  }
  if (anyDash) ctx.setLineDash([])   // never leak the pattern to the next layer
}

/** TEST-ONLY seam. `drawText` is the innermost text emitter and has no other entry that
 *  inks (the outline collector runs it in collect mode), so specs that need its exact call
 *  sequence — letter behaviours, above all — reach it here rather than through `paintLayer`,
 *  which needs a real DOM. Not used by app code. */
export const __drawTextForTest = drawText

/**
 * A text layer's glyph outlines as one SVG `d`, plus its measured text box — or
 * `null` when the font has no fetchable byte source or its bytes are not loaded
 * yet. Runs `drawText`'s own layout through the collect sink (over a measuring
 * ctx), so the outline's wrapping/alignment/spacing/valign are fillText's, not a
 * reimplementation. `ctxOverride` exists for unit tests (node has no 2D canvas).
 */
function collectTextOutline(
  layer: TextLayer, W: number, ctxOverride?: CanvasRenderingContext2D | null,
): { d: string; box: { w: number; h: number } } | null {
  const font = getCompositorFont(layer)
  if (!font) return null
  const ctx = ctxOverride ?? measureCtx()
  if (!ctx) return null
  const collect: TextOutlineCollect = { font, out: [], box: { w: 1, h: 1 } }
  drawText(ctx, layer, W, collect)
  if (!collect.out.length) return null
  return { d: commandsToPathData(collect.out), box: collect.box }
}

/**
 * A text layer's outline path data (`d`) in the ctx's local px — the glyph
 * geometry `fillText` would ink — or `null` when unavailable (system/unresolved
 * font, or bytes still loading). See `collectTextOutline`.
 */
export function textLayerOutline(
  layer: TextLayer, W: number, ctxOverride?: CanvasRenderingContext2D | null,
): string | null {
  return collectTextOutline(layer, W, ctxOverride)?.d ?? null
}

/** F1: render a text layer from outlines when the layer asks for it. F2 will
 *  OR-in "a geometry effect is present" here. */
function needsTextOutline(layer: LocalLayer): boolean {
  return layer.kind === 'text' && (layer as TextLayer).renderAsOutline === true
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
  const passes = textStrokePasses(ctx, layer, W, textBox)
  const anyDash = passes.some(p => p.dash)
  // One run per placed word (`wd.y` is the line band's top, so + lineH/2 is its centre).
  const runs: TextRun[] = lay.words.map(wd => ({ text: wd.text, x: originX + wd.x, y: originY + wd.y + lineH / 2 }))
  paintTextStrokeBands(ctx, layer, W, textBox, runs)
  if (passes.length) ctx.lineJoin = 'round'
  ctx.fillStyle = resolvePaint(ctx, layer.color, textBox, _fieldCtx)
  const fontPx = layer.fontSize * W
  const deco = layer.underline || layer.strikethrough
  const decoThick = Math.max(1, fontPx * 0.06)
  // Accent face (Letters mode only): render a rule-selected subset of glyphs in a
  // second, user-chosen face. Layout measured with the base face; the swap is
  // draw-time only. When no accent face is set the font is never touched, so the
  // render is byte-identical. Base glyphs re-apply `applyFont` so their variable
  // axes / tracking survive an accent glyph's font reset.
  const accentOn = !!layer.expressive?.perChar && !!layer.accentFace
  const accentRule: AccentRule = layer.accentRule ?? 'first'
  const accentWeight = layer.axes?.wght != null && Number.isFinite(layer.axes.wght) ? Math.round(layer.axes.wght) : layer.fontWeight
  const accentFontStr = accentOn ? `${accentWeight} ${fontPx}px ${cssFontStack(layer.accentFace!)}` : ''
  for (let i = 0; i < lay.words.length; i++) {
    const wd = lay.words[i]!
    const { x, y } = runs[i]!
    if (accentOn) { if (isAccentGlyph(i, accentRule)) ctx.font = accentFontStr; else applyFont(ctx, layer, W) }
    strokeTextPasses(ctx, passes, anyDash, wd.text, x, y)
    ctx.fillText(wd.text, x, y)
    if (deco && wd.text) {
      if (layer.underline) ctx.fillRect(x, y + fontPx * 0.34, wd.w, decoThick)
      if (layer.strikethrough) ctx.fillRect(x, y - decoThick / 2, wd.w, decoThick)
    }
  }
  if (anyDash) ctx.setLineDash([])   // never leak the pattern to the next layer
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
  // Set unconditionally: `ctx` is inside this function's own save/restore and nothing
  // between here and the restore reads either, so a path with no stroke is unaffected.
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  // Width, dash and distance all live in the path's LOCAL units (the ctx is already
  // scaled by `s`), so `widthScale` is 1 here and an outline scales with the shape.
  paintStrokeStack(ctx, layer, layer.bbox, {
    widthScale: 1,
    path: p,
    fillRule: layer.fillRule || 'nonzero',
    // `d` IS the outline, already in the local units this ctx now draws in — which is also
    // why a polygon/star, rewritten into a path layer by `drawLayerContent`, gets a shapes
    // stroke for free.
    outline: layer.d,
    // `s` (= `layer.scale * W`) is how many canvas pixels ONE unit of `d` renders as under
    // this ctx's own `ctx.scale(s, s)` above — the `pixelPerUnit` a scaled path needs so
    // its shapes-stroke chord accuracy doesn't grow with `scale` (Finding 2, Task 6 review).
    outlineTolerance: pathOutlineFlattenTolerance(s, W),
    // The scratch canvas inherits this ctx's transform but not its line joins.
    build: (c) => { c.lineJoin = 'round'; c.lineCap = 'round' },
  })
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

// Shared scaffolding for any "read the already-painted backdrop, treat it,
// clip to the layer's silhouette, stamp it back" effect — factored out of the
// original `applyBackdropBlur` (Figma-style background blur) so later backdrop
// kinds (shader, luminance-mask) reuse the same device-space math instead of
// re-deriving it. Operates in device space so it's correct under the dpr
// transform renderers apply to the stack canvas.
//
// `treat` is the ONLY effect-specific part: it receives an untouched COPY of
// the backdrop snapshot (plus W/H and the transform's device scale) and
// returns the treated canvas, or mutates the one it was given and returns
// nothing. Everything else — the silhouette ghost/mask build, the
// destination-in clip, and the identity-transform stamp-back — lives here.
function withBackdrop(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  localLayers: LocalLayer[],
  W: number,
  H: number,
  treat: (snapshot: HTMLCanvasElement, W: number, H: number, scale: number) => HTMLCanvasElement | void,
) {
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
  // Snapshot the current backdrop, hand it to the caller's `treat`, clip the
  // result to the silhouette, stamp it back.
  const snap = mk()
  const snapCtx = snap.getContext('2d')
  if (!snapCtx) return
  snapCtx.drawImage(dev, 0, 0)
  const out = treat(snap, W, H, t.a) ?? snap
  const octx = out.getContext('2d')
  if (!octx) return
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(sil, 0, 0)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(out, 0, 0)
  ctx.restore()
}

// Figma background blur: blur the ALREADY-PAINTED backdrop within the layer's
// silhouette, then the layer paints on top. `treat` is the one blur-specific
// line — a CSS filter applied while re-drawing the snapshot onto a fresh
// canvas (`snap` is an exact pixel copy of the device canvas, so blurring it
// is byte-identical to blurring the device canvas directly).
function applyBackdropBlur(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  localLayers: LocalLayer[],
  W: number,
  H: number,
  radius: number,
) {
  if (!(radius > 0)) return
  withBackdrop(ctx, layer, localLayers, W, H, (snapshot, w, _h, scale) => {
    const out = document.createElement('canvas')
    out.width = snapshot.width; out.height = snapshot.height
    const octx = out.getContext('2d')
    if (!octx) return snapshot
    octx.filter = `blur(${Math.max(0, radius * w * scale)}px)`
    octx.drawImage(snapshot, 0, 0)
    return out
  })
}

// F6 Task 2: run any input-sampling Shader Studio catalog effect over the layers BEHIND
// this layer — ADDITIVELY (the layer's own content still paints on top, unlike the glass
// lens's fill-REPLACING `continue`), clipped to the layer's silhouette, on ANY layer
// including text. `treat` mirrors `applyShaderPixelEffect`'s recombine call
// (`shaderSpecFromEffect` + `renderFieldWithBase`) but over the BACKDROP snapshot
// `withBackdrop` hands it, not the layer's own pixels — so there is no destination-in
// recombine here: `withBackdrop` already clips the treated result to the silhouette itself.
// `renderFieldWithBase` THROWS on a catalog miss (unloaded catalog, bad effectId — same
// precedent as `applyShaderPixelEffect`/the glass lens); caught here so a bad pick leaves
// the backdrop untouched instead of aborting the whole frame.
function applyBackdropShader(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  e: BackdropShaderEffect,
  localLayers: LocalLayer[],
  W: number,
  H: number,
  t: number,
) {
  withBackdrop(ctx, layer, localLayers, W, H, (snapshot) => {
    try {
      // Render at the snapshot's DEVICE dimensions (like F5's applyShaderPixelEffect uses
      // off.width/height), NOT withBackdrop's logical W/H — the snapshot is device-sized, so
      // a logical size would produce a half-scale output (at dpr 2) that misses a centred layer.
      const lens = renderFieldWithBase(shaderSpecFromEffect(e), snapshot, snapshot.width, snapshot.height, undefined, t)
      // `lens` is the shared WebGL canvas — getContext('2d') on it returns null. withBackdrop
      // needs a 2D canvas to clip + stamp, so draw the treated result back onto the (2D)
      // snapshot and return THAT (the same drawImage-the-GL-result pattern F5 uses on `off`).
      const sctx = snapshot.getContext('2d')
      if (!sctx) return undefined
      sctx.clearRect(0, 0, snapshot.width, snapshot.height)
      sctx.drawImage(lens, 0, 0)
      return snapshot
    } catch {
      // Unloaded catalog / bad effectId — leave the backdrop untreated (`withBackdrop`
      // falls back to `snap` when `treat` returns nothing).
      return undefined
    }
  })
}

// F6 Task 3: mask the layer's OWN content by the backdrop's luminance. Reads the backdrop as
// painted so far (device canvas), builds a per-pixel luminance→alpha mask, renders the layer's
// own content to an offscreen at the SAME transform, multiplies the mask in (destination-in),
// and stamps the result. Unlike applyBackdropShader this REPLACES the own-content paint (the
// caller passes the exact paint it would otherwise run as `drawOwn`), so byte-identity when
// absent is automatic: with no effect the caller runs `drawOwn(ctx)` unchanged.
function applyBackdropLuminanceMask(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  e: BackdropLuminanceMaskEffect,
  _localLayers: LocalLayer[],
  _W: number,
  _H: number,
  drawOwn: (target: CanvasRenderingContext2D) => void,
) {
  const dev = ctx.canvas
  const T = ctx.getTransform()
  const mk = () => { const c = document.createElement('canvas'); c.width = dev.width; c.height = dev.height; return c }
  // 1. backdrop luminance → alpha mask (device space, identity transform).
  const maskC = mk(); const mctx = maskC.getContext('2d'); if (!mctx) { drawOwn(ctx); return }
  mctx.drawImage(dev, 0, 0)
  const img = mctx.getImageData(0, 0, maskC.width, maskC.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) / 255
    const a = luminanceMaskAlpha(lum, e.threshold, e.softness, e.invert)
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(a * 255)
  }
  mctx.putImageData(img, 0, 0)
  // 2. own content to an offscreen at the SAME transform the main ctx carries.
  const own = mk(); const octx = own.getContext('2d'); if (!octx) { drawOwn(ctx); return }
  octx.setTransform(T)
  drawOwn(octx)
  // 3. multiply the mask into the own content's alpha, then stamp.
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(maskC, 0, 0)
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(own, 0, 0); ctx.restore()
}

/**
 * Pure resolution of a glass shader's input source — mirrors mask resolution
 * (`byKey.get(ref)`) rather than reinventing it. `spec.readsLayerKey` set AND
 * present in `byKey` → render just that bound layer via `renderLayer`
 * ("bound-layer mode": glass refracts ONE specific layer, not everything behind
 * it). No key, or a dangling key (target removed/renamed since the fill was set
 * up), → `snap`, the full backdrop snapshot ("Layers behind", Task 4's behavior).
 * Kept free of canvas/DOM so it's unit-testable with plain mocks — `renderLayer`
 * is the only side-effecting piece, injected by the caller.
 */
export function resolveGlassSource<TSource, TItem>(
  spec: { readsLayerKey?: string },
  byKey: Map<string, TItem> | undefined,
  snap: TSource,
  renderLayer: (item: TItem) => TSource,
): TSource {
  const key = spec.readsLayerKey
  if (key && byKey) {
    const target = byKey.get(key)
    if (target) return renderLayer(target)
  }
  return snap
}

// Glass lens ("Layers behind" / bound-layer mode): the layer's own FILL is a
// backdrop-reading shader (see isGlassLayer). Instead of painting that fill flat,
// we build a source texture — either everything already painted below this layer
// (default), or, when `spec.readsLayerKey` names a live stack item, ONLY that
// layer's own pixels (see resolveGlassSource) — and run it through the shader as
// the input texture, then clip the refracted result to this layer's own shape and
// stamp it back. Modelled directly on applyBackdropBlur above — same device-space
// snapshot, silhouette/ghost-fill clip, destination-in, and identity-transform
// stamp — so it stays correct under the dpr transform renderers apply to the
// stack canvas.
//
// `byKey` is the SAME map paintLayerStack builds for mask resolution — passed
// through so bound-layer mode resolves a key exactly the way a mask ref does.
// The bound layer still paints normally in the stack (it is not suppressed);
// this only takes an extra copy of its pixels for the shader to sample.
//
// Returns true when it handled the layer (fill refracted; the caller then paints the
// stroke on top). Returns false — WITHOUT touching `ctx` — when the layer isn't a
// well-formed glass layer or an offscreen context is unavailable, so the caller can
/**
 * The silhouette as what a shape-following lens wants, packed into one texture:
 *
 *  R — the RIM field: the white-on-black silhouette blurred by the glass thickness,
 *      so 0.5 lands on the edge and 1.0 one thickness inside. Its gradient is the
 *      edge normal and it drives the rim band of a glass pane.
 *  G — the DEPTH field: the true distance to the outline (a chamfer transform on a
 *      128 px thumbnail, scaled back up), 0 on the edge and 1 at the deepest point.
 *      Coverage and anything concentric to the outline (Crystal's facet rings) read
 *      this one. A blur cannot stand in for it: on a star the thin arms blur away
 *      below the halfway level, and a lens reading the blur painted only a round
 *      blob in the middle while the arms showed the plain backdrop.
 *
 * Plus the uniforms that replace the effect's own Center/Radius: the bounds' centre
 * in texture space (y up) and its half short side as a fraction of the shorter canvas
 * side. Bounds come off the same thumbnail, so any shape, rotation or mask works.
 */
function lensShapeFromSilhouette(sil: HTMLCanvasElement, spec: ShaderSpec, w: number, h: number): LensShape | undefined {
  // 256, not 128: the distance field is upscaled to full resolution and read as a height field
  // by shape-following materials (Chrome domes and bevels from it). At 128 its facets showed as
  // a scalloped rim and speckled accent lights; 256 halves the facet size for a smooth pillow,
  // and the two-pass chamfer is still well under a millisecond. Benefits every lens/material.
  const T = 256
  const thumb = document.createElement('canvas')
  thumb.width = T; thumb.height = T
  const tctx = thumb.getContext('2d', { willReadFrequently: true })
  if (!tctx) return undefined
  tctx.drawImage(sil, 0, 0, T, T)
  const a = tctx.getImageData(0, 0, T, T).data
  let x0 = T, y0 = T, x1 = -1, y1 = -1
  const inside = new Uint8Array(T * T)
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    if ((a[(y * T + x) * 4 + 3] ?? 0) > 127) {
      inside[y * T + x] = 1
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return undefined                                    // nothing drawn
  const sx = w / T, sy = h / T
  const cx = ((x0 + x1 + 1) / 2) * sx, cy = ((y0 + y1 + 1) / 2) * sy
  const halfShort = Math.max(Math.min((x1 - x0 + 1) * sx, (y1 - y0 + 1) * sy) / 2, 1)

  // Depth: a two-pass chamfer distance (3-4 weights) from the nearest outside pixel,
  // normalised by its maximum. Thumbnail-sized, so it costs well under a millisecond.
  const BIG = 1e9
  const dist = new Float32Array(T * T)
  for (let i = 0; i < T * T; i++) dist[i] = inside[i] ? BIG : 0
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= T || y >= T) ? 0 : dist[y * T + x]!
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const i = y * T + x
    if (!inside[i]) continue
    dist[i] = Math.min(dist[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4)
  }
  let maxD = 0
  for (let y = T - 1; y >= 0; y--) for (let x = T - 1; x >= 0; x--) {
    const i = y * T + x
    if (!inside[i]) continue
    dist[i] = Math.min(dist[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4)
    if (dist[i]! > maxD) maxD = dist[i]!
  }
  const dimg = tctx.createImageData(T, T)
  for (let i = 0; i < T * T; i++) {
    const v = maxD > 0 ? Math.round(255 * dist[i]! / maxD) : 0
    dimg.data[i * 4] = v; dimg.data[i * 4 + 1] = v; dimg.data[i * 4 + 2] = v; dimg.data[i * 4 + 3] = 255
  }
  tctx.putImageData(dimg, 0, 0)

  // Rim: blur by the effect's Thickness (a fifth of the half short side when it has none).
  const thickness = Number(spec.params.thickness ?? 0.2)
  // A gaussian reaches ~1 about two sigmas in, so sigma = half the thickness in pixels.
  const sigma = Math.max(Math.min(thickness, 1) * halfShort * 0.5, 0.75)
  const hf = document.createElement('canvas')
  hf.width = w; hf.height = h
  const hctx = hf.getContext('2d')
  if (!hctx) return undefined
  hctx.fillStyle = '#000000'; hctx.fillRect(0, 0, w, h)
  hctx.filter = `blur(${sigma}px)`
  hctx.drawImage(sil, 0, 0)
  hctx.filter = 'none'
  // Keep the rim in R only, then add the depth in G: two GPU-side composites, no readback.
  hctx.globalCompositeOperation = 'multiply'
  hctx.fillStyle = '#ff0000'; hctx.fillRect(0, 0, w, h)
  const dg = document.createElement('canvas')
  dg.width = w; dg.height = h
  const dctx = dg.getContext('2d')
  if (dctx) {
    dctx.imageSmoothingEnabled = true
    dctx.drawImage(thumb, 0, 0, w, h)
    dctx.globalCompositeOperation = 'multiply'
    dctx.fillStyle = '#00ff00'; dctx.fillRect(0, 0, w, h)
    hctx.globalCompositeOperation = 'lighter'
    hctx.drawImage(dg, 0, 0)
  }
  hctx.globalCompositeOperation = 'source-over'
  return {
    texture: hf,
    uniforms: {
      u_hasShape: 1,
      u_shapeCX: cx / w,
      u_shapeCY: 1 - cy / h,
      u_shapeSize: halfShort / Math.min(w, h),
    },
  }
}

// fall back to the normal paint path. renderFieldWithBase THROWS on a catalog miss;
// the caller wraps this call in try/catch and treats a throw the same as `false`.
function applyGlassFromLayer(
  ctx: CanvasRenderingContext2D,
  layer: LocalLayer,
  localLayers: LocalLayer[],
  W: number,
  H: number,
  opacityMul = 1,
  byKey?: Map<string, StackItem>,
  t = 0,   // elapsed/scrub time → the shader's u_time, so an animated fill actually moves
): boolean {
  const fill = primaryFillOf(layer)
  // Narrow exactly as isGlassLayer does — the dispatch already checked isGlassLayer,
  // but this keeps `spec` well-typed and guards the should-be-unreachable case.
  if (!isFill(fill) || !fillIsShader(fill)) return false
  const spec = fill.shader
  const transform = ctx.getTransform()
  const dev = ctx.canvas
  const w = dev.width, h = dev.height          // device pixels — snapshot + field at full res
  if (w < 1 || h < 1) return false
  const mk = () => {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    return c
  }

  // 1. Snapshot the backdrop below this layer (device pixels; drawn in device space so
  //    the snapshot matches the field's own device-sized output pixel-for-pixel). This
  //    is both the "Layers behind" source and the fallback for a dangling bound-layer key.
  const snap = mk()
  const snctx = snap.getContext('2d')
  if (!snctx) return false
  snctx.drawImage(dev, 0, 0)

  // 1b. Bound-layer mode: if spec.readsLayerKey names a live stack item, render ONLY
  //    that layer (via the same drawItemContent path drawItemMasked uses for mask
  //    content) onto its own device-sized offscreen and sample that instead of the
  //    full backdrop. Resolution is pure (resolveGlassSource) and mask-style —
  //    byKey.get(key) — so a dangling key transparently falls back to `snap`.
  // Bound-layer mode is active only when the key resolves to a real live item; a dangling
  // key falls back to `snap` (opaque) and needs none of the alpha recovery below.
  const boundTarget = spec.readsLayerKey && byKey ? byKey.get(spec.readsLayerKey) : undefined
  // "Its own fill" on a shape-following effect (isShapeFollowingOwnFill): the shader's
  // picture is the fill's own input, painted frame-sized, not what lies behind.
  const ownFill = !spec.readsBackdrop
  const source = ownFill
    ? paintTileBox(spec.input, w, h)
    : resolveGlassSource(spec, byKey, snap, (item: StackItem) => {
      const c = mk()
      const ictx = c.getContext('2d')
      if (ictx) {
        ictx.setTransform(transform)
        drawItemContent(ictx, item, W, H)
      }
      return c
    })

  // 2. The layer's own silhouette (+ its own mask ref, mirroring applyBackdropBlur).
  //    The ghost uses an opaque solid fill so this is the pane's SHAPE alpha, not the
  //    shader's (possibly transparent) output alpha. Built before the render because a
  //    shape-following lens (manifest `followsShape`, e.g. Glass lens) is handed it as a
  //    soft height field, so its rim, bend and highlight run along the real edge —
  //    a rectangle stays a rectangle — instead of the effect's own stand-alone circle.
  const sil = mk()
  const silctx = sil.getContext('2d')
  if (!silctx) return false
  silctx.setTransform(transform)
  const ghost = { ...layer, fill: '#ffffff', opacity: 1, effects: undefined, blend: undefined } as LocalLayer
  const maskRef = layerMaskRef(layer)
  const maskLayer = maskRef?.startsWith('l:')
    ? localLayers.find(l => l.id === maskRef.slice(2)) ?? null
    : null
  drawLocalLayer(silctx, ghost, W, H, maskLayer)
  const shape = effectFollowsShape(spec) ? lensShapeFromSilhouette(sil, spec, w, h) : undefined

  // 3. Refract: run the source through the shader as its input texture. render()'s
  //    canvas is valid only until the next render call, so copy it out immediately.
  const lens = renderFieldWithBase(spec, source, w, h, shape, t)
  const clipped = mk()
  const cctx = clipped.getContext('2d')
  if (!cctx) return false
  cctx.drawImage(lens, 0, 0)

  // 2b. Bound-layer mode is alpha-aware. The bound layer is transparent outside its own
  //     shape, but the shader returns OPAQUE black there (it samples transparent-black and
  //     forces alpha = 1), which would fill the pane with black instead of letting the
  //     backdrop show through. Recover a per-pixel alpha by refracting the layer's COVERAGE
  //     (its silhouette as white-on-opaque-black) through the SAME shader — so the empty
  //     areas AND the reeded spread past the shape's edges get the exact same displacement —
  //     then multiply that luminance into the lens alpha. "Layers behind" samples an opaque
  //     snapshot, so boundTarget is undefined and this branch never runs — it is unchanged.
  if (boundTarget) {
    const cov = mk()
    const kctx = cov.getContext('2d')
    if (kctx) {
      kctx.drawImage(source, 0, 0)                            // colour + real transparency
      kctx.globalCompositeOperation = 'source-in'
      kctx.fillStyle = '#ffffff'; kctx.fillRect(0, 0, w, h)   // white where the layer is
      kctx.globalCompositeOperation = 'destination-over'
      kctx.fillStyle = '#000000'; kctx.fillRect(0, 0, w, h)   // opaque black behind
      // render()'s canvas is reused per call — this invalidates `lens`, but it is already
      // copied into `clipped`; copy covLens out at once, before any further render.
      const covLens = renderFieldWithBase(spec, cov, w, h, shape, t)
      const cl = mk()
      const clc = cl.getContext('2d')
      if (clc) {
        clc.drawImage(covLens, 0, 0)
        const lum = clc.getImageData(0, 0, w, h).data
        const img = cctx.getImageData(0, 0, w, h)
        const a = img.data
        for (let i = 0; i < a.length; i += 4) {
          const L = (lum[i] ?? 0) * 0.299 + (lum[i + 1] ?? 0) * 0.587 + (lum[i + 2] ?? 0) * 0.114
          a[i + 3] = Math.round((a[i + 3] ?? 0) * L / 255)
        }
        cctx.putImageData(img, 0, 0)
      }
    }
  }

  // 4. Clip the refracted result to the silhouette from step 2.
  cctx.globalCompositeOperation = 'destination-in'
  cctx.drawImage(sil, 0, 0)

  // 5. Stamp back in device space, honouring the layer's opacity (and group cascade)
  //    and its blend op — exactly the stamp drawLocalLayer uses for a masked layer.
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * opacityMul))
  ctx.globalCompositeOperation = localBlendOp(layer)
  ctx.drawImage(clipped, 0, 0)
  ctx.restore()
  return true
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
 *  the same set resolveFill will actually ask for during the pass. Exported so the
 *  unit suite can pin that a shader-style mosaic registers its field (a missing
 *  request is a BLANK box, not an error — the "graceful fallback hides integration
 *  failure" trap). */
export function layerPaints(layer: LocalLayer): Paint[] {
  switch (layer.kind) {
    case 'text': return [layer.color, layer.strokeColor]
    case 'line': return [layer.stroke]
    case 'image': return layer.tint ? [layer.tint] : []
    case 'brush': return layer.stroke ? [layer.fill, layer.stroke] : [layer.fill]
    case 'wired': return []                    // graph pixels — no authored Paint slots
    // The canvas styles' vocabularies are solid/gradient/pattern fills only (no live
    // shaders), so there's nothing for the shader-field pre-pass to register. The two
    // SHADER styles (oddgrid / static) paint ONE shader Fill over the box — the exact
    // Fill drawLayerContent's deal branch hands to resolvePaint — and it MUST be
    // returned here, or the pre-pass never renders the field and the box is blank.
    case 'deal': { const f = dealShaderFill(layer); return f ? [f] : [] }
    // A Scatter paints its own sheet from its style's generator — it carries no
    // authored Paint slot at all, so there is nothing for the pre-pass to register.
    // (It must be listed: the default branch below reads `fill`/`stroke`, which a
    // scatter has not got.)
    case 'scatter': return []
    default: return [layer.fill, layer.stroke] // rect / ellipse / polygon / star / path
  }
}

/** A layer's primary fill — the slot `layerPaints` lists first for its kind (`fill` for
 *  every paintable kind that has one; none for `wired`/`scatter`/`line`, which don't
 *  carry a `fill` Paint at all). No dedicated "main fill" accessor existed before
 *  `isGlassLayer` needed one. */
function primaryFillOf(layer: LocalLayer): Paint | undefined {
  return layerPaints(layer)[0]
}

/** True iff `layer`'s `.fill` slot SPECIFICALLY — not `primaryFillOf`, not `.color`/
 *  `.stroke`/`.tint` — carries a shader that both DECLARES it reads the compositor
 *  backdrop (`readsBackdrop === true`) and whose GLSL actually samples an input
 *  texture (`effectReadsInput`) — a purely generative effect can set `readsBackdrop`
 *  without it meaning anything, so both must hold. Backs the "glass lens" treatment:
 *  `applyGlassFromLayer` builds its silhouette/stroke ghosts by overriding `.fill`
 *  (`{...layer, fill:'#fff'}` / `{...layer, fill:'none'}`), which only makes sense
 *  for kinds whose primary paint IS `.fill` (shapes, brush). Text's primary paint is
 *  `.color`, so a text layer must never read as glass here even though it can carry
 *  a backdrop-reading shader in `.color` — that would re-run `applyGlassFromLayer`'s
 *  `.fill`-based ghosts and double-paint the glyphs on top of the refraction. */
export function isGlassLayer(layer: LocalLayer): boolean {
  if (!('fill' in layer)) return false
  const fill = (layer as { fill?: Paint }).fill
  if (!fill || !isFill(fill) || !fillIsShader(fill)) return false
  const spec = fill.shader
  return !!spec.readsBackdrop && effectReadsInput(spec.effectId)
}

/** A shape-following effect (manifest `followsShape`: Glass lens, Crystal, Liquid
 *  metal) painting the layer's OWN fill. It exists to take the shape it is applied
 *  to, and it can only do that when it is handed the layer's silhouette — which the
 *  plain tile path never does (it paints the effect's stand-alone circle inside the
 *  shape). So it goes through the glass paint path too, with the fill's own input
 *  standing in for the backdrop snapshot as the shader's picture. "Layers behind"
 *  and "Its own fill" then both fill the real outline; only what shows in the
 *  reflection or refraction differs. */
export function isShapeFollowingOwnFill(layer: LocalLayer): boolean {
  if (!('fill' in layer)) return false
  const fill = (layer as { fill?: Paint }).fill
  if (!fill || !isFill(fill) || !fillIsShader(fill)) return false
  const spec = fill.shader
  return !spec.readsBackdrop && effectFollowsShape(spec)
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
  // F5 Task 4: a shader-catalog-as-a-pass EFFECT (layer.effects, distinct from the
  // fill/stroke Paint checked above) can be just as animated as a shader FILL, and the
  // modal's live loop only advances when THIS predicate says so — an animated effect
  // that isn't recognised here renders once and freezes. "Animated" requires BOTH the
  // picked catalog effect's own def (`animated: true` — it samples u_time in its GLSL)
  // AND a nonzero speed — a static catalog def (e.g. the default `chromatic_aberration`,
  // `animated: false`) never reads u_time no matter what speed is dialled in, so OR'ing
  // in `speed !== 0` falsely called it live and spun a perpetual identical-frame loop.
  // An invisible effect never paints, so it never needs the clock either.
  const isLiveShaderEffect = (e: LayerEffect): boolean =>
    e.type === 'shader' && e.visible && getEffectSync(e.effectId)?.animated === true && e.speed !== 0
  // F6 Task 4: backdrop_shader is the same shader-catalog-as-a-pass shape as `shader` (just run
  // over the layers BEHIND this one rather than its own pixels), so it can be just as animated
  // and needs the identical predicate — BOTH an animated catalog def AND a nonzero speed. Note a
  // fresh backdrop_shader defaults to speed 0 (LOCAL_DEFAULTS), so a just-added one stays inert
  // and spins no loop until the user dials a speed (the F5 lesson: a static default at nonzero
  // speed must NOT be called live — hence AND, never OR).
  const isLiveBackdropShaderEffect = (e: LayerEffect): boolean =>
    e.type === 'backdrop_shader' && e.visible && getEffectSync(e.effectId)?.animated === true && e.speed !== 0
  for (const it of items) {
    if (it.type !== 'local') continue
    if (layerPaints(it.layer).some(isLiveShader)) return true
    if (effectStackOf(it.layer as unknown as Parameters<typeof effectStackOf>[0]).some(e => isLiveShaderEffect(e) || isLiveBackdropShaderEffect(e))) return true
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
  motion?: { fps: number; duration: number; tracks?: EffectDialTrack[]; motionx?: MotionxTrack[]; behaviours?: StoredBehaviour[] },
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
  // F8: fold any effect-dial motion tracks into the layers for this frame. Same-reference return
  // when there are no tracks / no clock ⇒ items & localLayers untouched ⇒ byte-identical.
  // Letter behaviours fold LAST: they are the only ones that hand the painter author state
  // (the behaviours themselves) rather than a resolved value, so they must see the layer the
  // rest of the fold already produced. Same-reference return when there are none.
  // Reveal transitions fold last of all: like letter behaviours they hand the painter author
  // state (the bar's look), and they need nothing from the layer but its id.
  // ONE definition of the chain: the main fold below runs it at the frame clock, and the
  // copies-stagger expansion under it re-runs the SAME chain per copy at that copy's own
  // clock. Same calls in the same order either way, so the identity returns each stage
  // makes (see their docs) still compose — a frame with no motion comes back by reference.
  const foldMotion = (ls: LocalLayer[], clock: number | undefined): LocalLayer[] =>
    applyRevealBehaviours(applyTextBehaviours(applyMotionxTracks(
      applyFillPhaseTracks(
        applyEffectDialTracks(ls, motion?.tracks, clock),
        motion?.tracks,
        clock,
      ),
      motion?.motionx,
      clock,
    ), motion?.behaviours, clock), motion?.motionx, motion?.behaviours, clock)

  const storedLocals = localLayers      // pre-fold, for the per-copy folds below
  const animatedLocals = foldMotion(localLayers, t)
  if (animatedLocals !== localLayers) {
    const byId = new Map(animatedLocals.map(l => [l.id, l]))
    items = items.map(it => (it.type === 'local' && byId.has(it.layer.id))
      ? { ...it, layer: byId.get(it.layer.id)! } : it)
    localLayers = animatedLocals
  }

  // Every StackKey reference (mask source, glass source) resolves against the stack as it
  // stands HERE, one item per key — not against the copies expansion below, whose entries
  // share their layer's key. A `new Map` over the expanded list would keep only the LAST
  // copy per key, silently reducing "masked by that array" to "masked by its original
  // copy". Same array reference whenever nothing expands, so this is a no-op for every
  // existing frame.
  const keyedItems = items

  // Copies stagger (spec Part 2): a cloned local layer whose Cloner carries a motion
  // stagger is painted ONCE PER COPY — each copy folded at its OWN clock and its Cloner
  // narrowed to that one copy (`motionCopy` → `expandClones`' `only` argument, read at
  // both stamp sites). Without this every copy would fold at the frame clock and the
  // array would move in unison, which is exactly what it does today.
  //
  // The `some` guard is the identity contract: stagger 0, no cloner, a disabled cloner or
  // no clock never enters the block, allocates nothing, and leaves `items` the array the
  // single fold above produced — so every Frame saved before this paints byte-for-byte as
  // it did. Nothing inside the per-layer draw loop changed either.
  if (t !== undefined && items.some(it => it.type === 'local' && staggerOf(it.layer.cloner) > 0 && !!it.layer.cloner?.enabled)) {
    const storedById = new Map(storedLocals.map(l => [l.id, l]))
    const expanded: StackItem[] = []
    let split = false
    for (const it of items) {
      if (it.type !== 'local') { expanded.push(it); continue }
      const cloner = it.layer.cloner
      if (!cloner?.enabled || staggerOf(cloner) === 0) { expanded.push(it); continue }
      const copies = expandClones(cloner, W / H)
      if (copies.length <= 1) { expanded.push(it); continue }
      // `k` is the copy's FALLOFF STEP (|iy|·nx + |ix|), not its index — mirrorX/mirrorY
      // put more than one copy at the same k (the ±ix twins share a falloff distance).
      // The stamp site narrows by k too (`expandClones(..., only: c.k)` in drawLayerContent),
      // so it always redraws EVERY copy at that k — one painted item per raw entry here would
      // have each twin's item redraw both twins, doubling (or with both mirrors, quadrupling)
      // the paint count. Emit one item per DISTINCT k instead, in the order `expandClones`
      // first yields each, so twins stamp together, sharing a rank and a clock — which is
      // right, since they share a falloff step. Rank/clock over the number of DISTINCT k
      // values, never `c.n` (the raw entry count) or `copies.length`: `copyRanks` must not
      // hand out ranks no k claims.
      const seenKs = new Set<number>()
      const distinctCopies: CloneTransform[] = []
      for (const c of copies) {
        if (seenKs.has(c.k)) continue
        seenKs.add(c.k)
        distinctCopies.push(c)
      }
      if (distinctCopies.length <= 1) { expanded.push(it); continue }
      // Fold from the STORED layer, never from the already-folded one in `items`: folding
      // a fold would apply every track twice. Falls back to the folded layer only if the
      // stack carries an item whose layer isn't in `localLayers` at all.
      const source = storedById.get(it.layer.id) ?? it.layer
      for (const c of distinctCopies) {
        const [folded] = foldMotion([source], copyClock(t, c.k, distinctCopies.length, cloner))
        // The Cloner is pinned to the FRAME clock's value even though the rest of the
        // layer is folded at the copy's: the array's own dials (count, radius, spacing —
        // Task 5's Copies properties) describe one shared array, and letting copy k
        // resolve a different array would hand the stamp site a `k` its own expansion no
        // longer contains, silently dropping that copy.
        expanded.push({ ...it, layer: { ...(folded ?? source), cloner, motionCopy: c.k } as unknown as LocalLayer })
      }
      split = true
    }
    // Copies land where the layer was in the stack, in `expandClones`' own back-to-front
    // order, so the array's z-order within the frame is the one it has without a stagger.
    if (split) items = expanded
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
    // A deal (mosaic) paints its shader Fill with its BOX as the frame (see the deal
    // branch in drawLayerContent), so its field must be requested at the box size —
    // both width-normalized (`* W`), exactly as that branch computes them — or the
    // pre-pass and the paint would ask for two different keys.
    const fw = it.layer.kind === 'deal' ? Math.max(1, it.layer.w * W) : W
    const fh = it.layer.kind === 'deal' ? Math.max(1, it.layer.h * W) : H
    for (const p of layerPaints(it.layer)) addShaderFieldRequest(shaderRequests, p, fw, fh, fieldT, fieldFps, bake)
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
  // F3: bind the sibling-outline resolver to THIS stack for the whole draw loop (nested
  // silhouette/offscreen renders below run inside it and see the same live layers), then clear
  // it in the finally so a later thumbnail/hit-test render never reads a stale factory. Inert
  // today — no geometry kind carries a `refLayerId` — so this changes no pixels.
  const siblingResolver = buildSiblingResolver(localLayers, W, H)
  _siblingResolveFor = (self: LocalLayer) => (key: string) => siblingResolver(key, self)
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

    const byKey = new Map(keyedItems.map(it => [it.key, it]))
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

    let motionScaleOpen = false
    // A reveal wraps ONE layer's whole draw (every `continue` below included), so — like the
    // draw-time scale — it is closed at the top of the next turn and once more after the loop.
    let revealOpen: RevealPass | null = null
    for (const item of items) {
      if (motionScaleOpen) { ctx.restore(); motionScaleOpen = false }
      if (revealOpen) { finishReveal(ctx, revealOpen); revealOpen = null }
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

      // A dither (reveal) bar mid-transition: nothing at all when fully hidden; otherwise keep
      // the backdrop so the hidden cells can be put back once the layer has drawn normally.
      const rv = (layer as unknown as { motionReveal?: MotionReveal }).motionReveal
      // Pixels and Assemble TRANSFORM the layer (drawn further down, once its mask is known);
      // the other styles MASK it: keep the backdrop so the hidden cells can be put back
      // afterwards. While the effect THAT bar needs is still loading, it draws as the Dissolve
      // mask rather than flashing the whole layer.
      let pixelsBase: DOMMatrix | null = null
      if (rv) {
        if (!(rv.amount > 0)) continue
        if (isShaderRevealStyle(rv.style) && revealShaderReady(rv)) pixelsBase = ctx.getTransform()
        else revealOpen = beginReveal(ctx, isShaderRevealStyle(rv.style) ? { ...rv, style: 'dissolve' } : rv, W, H)
      }

      // motionx `scale` on a layer kind with no native scale: draw-time scale about the centre.
      const ms = (layer as unknown as { motionScale?: number }).motionScale
      if (typeof ms === 'number' && Math.abs(ms - 1) > 1e-4) {
        ctx.save()
        ctx.translate(layer.x * W, layer.y * H)
        ctx.scale(Math.max(0.001, ms), Math.max(0.001, ms))
        ctx.translate(-layer.x * W, -layer.y * H)
        motionScaleOpen = true
      }

      const ref = layerMaskRef(layer)
      const maskItem = ref ? byKey.get(ref) ?? null : null
      // Pixels / Assemble: the layer is drawn ALONE at full opacity, run through its shader,
      // and stamped with its own opacity and blend. Effects that read the backdrop and the
      // pre-timeline animation engine sit out the transition (spec addendum). If it cannot
      // run after all, fall back to the Dissolve mask for this frame — except a settle bar,
      // which was never a mask: it just draws plainly.
      if (rv && pixelsBase) {
        const solo = { ...layer, opacity: 1, blend: 'normal' } as LocalLayer
        const drawSolo = (target: CanvasRenderingContext2D) => {
          if (maskItem && maskItem.type !== 'local') drawItemMasked(target, { ...item, layer: solo }, maskItem, W, H, 'source-over', 1)
          else drawLocalLayer(target, solo, W, H, maskItem?.type === 'local' ? maskItem.layer : null, 1)
        }
        if (drawRevealShaderStyle(ctx, rv, W, H, pixelsBase, drawSolo, { alpha: (layer.opacity ?? 1) * opacityMul, blend: localBlendOp(layer) })) continue
        if (rv.style !== 'settle') revealOpen = beginReveal(ctx, { ...rv, style: 'dissolve' }, W, H, pixelsBase)
      }
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
          const bdShader = layer.effects?.find(
            (e): e is BackdropShaderEffect => e.type === 'backdrop_shader' && e.visible,
          )
          if (bdShader) applyBackdropShader(ctx, layer, bdShader, localLayers, W, H, _fieldCtx.t)
          // Group-cascade limitation (Task 3, mirrors the mask limitation above): the
          // motion path composes its own effective layer in lib/motion/paint.ts and
          // doesn't thread an opacityMul through, so an animated layer's group cascade
          // opacity isn't applied for that frame. Visibility (gc.hidden) IS honored via
          // the `continue` above. Static (non-animated) layers are unaffected.
          // F6 Task 3: a backdrop luminance mask WRAPS the motion own-content paint the same
          // way the static path does — absent → drawOwn(ctx) runs drawLayerWithMotion verbatim.
          const bdLum = layer.effects?.find(
            (e): e is BackdropLuminanceMaskEffect => e.type === 'backdrop_luminance_mask' && e.visible,
          )
          const drawOwn = (target: CanvasRenderingContext2D) =>
            drawLayerWithMotion(target, layer, W, H, maskLocal, st, maskState)
          if (bdLum) applyBackdropLuminanceMask(ctx, layer, bdLum, localLayers, W, H, drawOwn)
          else drawOwn(ctx)
          continue
        }
      }
      const bgBlur = layer.effects?.find(
        (e): e is BackgroundBlurEffect => e.type === 'background_blur' && e.visible,
      )
      if (bgBlur) applyBackdropBlur(ctx, layer, localLayers, W, H, bgBlur.radius)
      const bdShader = layer.effects?.find(
        (e): e is BackdropShaderEffect => e.type === 'backdrop_shader' && e.visible,
      )
      if (bdShader) applyBackdropShader(ctx, layer, bdShader, localLayers, W, H, _fieldCtx.t)

      // Glass lens ("Layers behind"): the layer's fill is a backdrop-reading shader.
      // Refract everything painted below, clipped to this pane, then paint the stroke
      // (only) on top — the fill itself never paints. A throw from the shader path
      // (e.g. an unloaded catalog) must NOT abort the frame: on catch we fall through
      // to the normal fill+stroke paint below, so the layer still renders.
      if (isGlassLayer(layer) || isShapeFollowingOwnFill(layer)) {
        let refracted = false
        try {
          refracted = applyGlassFromLayer(ctx, layer, localLayers, W, H, opacityMul, byKey, fieldT)
        } catch (err) {
          if (import.meta.dev) console.warn('[paintLayerStack] glass refraction failed; painting the layer normally', err)
        }
        if (refracted) {
          // Fill was replaced by the refraction; the stroke still paints on top. A
          // stroke-only ghost (fill set to the non-painting 'none' Paint, so
          // hasPaint(fill) is false and only the stroke draws) reuses the normal
          // masked/blended paint path, so the stroke honours this layer's mask,
          // opacity and blend as usual.
          const strokeGhost = { ...layer, fill: 'none' } as LocalLayer
          drawLocalLayer(ctx, strokeGhost, W, H, maskItem?.type === 'local' ? maskItem.layer : null, opacityMul)
          continue
        }
        // else: refraction unavailable → fall through and paint the layer normally.
      }

      // F6 Task 3: a backdrop luminance mask WRAPS the own-content paint (modulates its
      // alpha by the backdrop's luminance), rather than stamping under it like the additive
      // backdrop treatments above. When absent, `drawOwn(ctx)` runs the exact same paint as
      // before → byte-identical.
      const bdLum = layer.effects?.find(
        (e): e is BackdropLuminanceMaskEffect => e.type === 'backdrop_luminance_mask' && e.visible,
      )
      const drawOwn = (target: CanvasRenderingContext2D) => {
        if (maskItem && maskItem.type !== 'local') {
          // Wired silhouette masking a local layer → generic cross-source path.
          drawItemMasked(target, item, maskItem, W, H, localBlendOp(layer), opacityMul)
        } else {
          // Local content + local mask (or no mask) → unchanged fast path.
          drawLocalLayer(target, layer, W, H, maskItem?.type === 'local' ? maskItem.layer : null, opacityMul)
        }
      }
      if (bdLum) applyBackdropLuminanceMask(ctx, layer, bdLum, localLayers, W, H, drawOwn)
      else drawOwn(ctx)
    }
    if (motionScaleOpen) ctx.restore()
    if (revealOpen) finishReveal(ctx, revealOpen)

    if (post && chainActive(post)) applyStackPost(ctx, post, W)
    return { frozenCount }
    })
  } finally {
    _fieldCtx.token = 0
    _siblingResolveFor = null // F3: unbind so a later out-of-paint render sees no stale resolver
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

  // Cloner Vary colour, memoised by swatch. The tinted scratch is a copy of `src` at the
  // SOURCE's own resolution, so it is by far the most expensive surface in this file — a
  // 4000x3000 upstream image is 48 MB a piece, and one per copy put a 100-copy array at
  // ~4.8 GB of allocation per frame. Every copy drawing the same swatch wants the same
  // bitmap, so `cycle` spread collapses a whole array to at most VARY_PALETTE_MAX (8);
  // `blend` interpolates per copy and still pays per distinct colour, which is the floor.
  //
  // `silhouetteRasterFits` rather than trusting `getContext('2d')`: past the engine's canvas
  // limits some engines hand back a context over a BLANK backing store instead of null, and
  // the copy would then stamp an empty (or, on a real null, an untinted) image beside tinted
  // siblings with no signal. The check is on iw/ih, which are the same for every copy, so the
  // outcome is all-or-nothing for the layer — a source too large to tint renders the array in
  // its own colours rather than half-varied.
  const tintFits = typeof document !== 'undefined' && silhouetteRasterFits(iw, ih)
  const tintedBySwatch = new Map<string, HTMLCanvasElement | null>()
  const tintedSrc = (tint: string, strength: number): HTMLCanvasElement | null => {
    const key = `${tint}@${strength}`
    const memo = tintedBySwatch.get(key)
    if (memo !== undefined) return memo
    let out: HTMLCanvasElement | null = null
    if (tintFits) {
      const sc = document.createElement('canvas')
      sc.width = iw
      sc.height = ih
      const sctx = sc.getContext('2d')
      if (sctx) {
        sctx.drawImage(src, 0, 0, iw, ih)
        tintScratch(sctx, tint, strength)
        out = sc
      }
    }
    tintedBySwatch.set(key, out)
    return out
  }

  // Linked cloner: stamp the layer once per clone (back-to-front; original last).
  // No cloner ⇒ a single identity transform ⇒ exactly one draw as before. `motionCopy`
  // narrows to one copy when the painter is drawing a staggered array copy by copy (see
  // paintLayerStack); a wired transform never carries it today, so this is inert here.
  for (const c of expandClones(layer.cloner, W / H, (layer as { motionCopy?: number }).motionCopy)) {
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * c.dopacity))
    ctx.globalCompositeOperation = op
    ctx.translate(W / 2 + (layer.x + c.dx) * W, H / 2 + (layer.y + c.dy) * H)
    const rot = layer.rotation + c.drot
    if (rot) ctx.rotate((rot * Math.PI) / 180)
    ctx.scale(layer.scale * c.dscale, layer.scale * c.dscale)
    // Cloner Vary colour. The mask and the defocus above are shared by every copy and
    // already folded into `src`; the tint is per-COLOUR, so it needs its own surface —
    // and it MUST have one, because `source-atop` on `ctx` would wash the whole frame
    // beneath this layer. Tinted at the source's own resolution, so the stamp below
    // resamples exactly once, as it did before. Strength 0 = identity ⇒ untinted path.
    const tint = c.tint && c.tintStrength > 0 ? c.tint : null
    // No tint (or no surface to tint on) ⇒ the original single draw, unchanged.
    const tinted = tint ? tintedSrc(tint, c.tintStrength) : null
    ctx.drawImage(tinted ?? src, -fitW / 2, -fitH / 2, fitW, fitH)
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
