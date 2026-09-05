<script setup lang="ts">
import {
  Image as ImageIcon, X, MousePointer2,
  Type, Square, Circle, Minus, Plus, Trash2,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Bold, ArrowUp, ArrowDown, Lock, LockOpen,
  Eye, EyeOff, Underline, Strikethrough, CaseUpper, CaseLower, CaseSensitive,
  Hexagon, Star, Copy, Shapes,
} from 'lucide-vue-next'
import {
  type TextLayer, type RectLayer, type EllipseLayer, type LocalLayer, type StackItem, type CornerPin, type BrushLayer, type Paint,
  type WiredLayer, type DealLayer,
  cornerRadii, drawLocalLayer, drawWiredImageLayer, ensureLayerFonts, ensureLayerImages, paintLayerStack, layerMaskRef, localLayerBox, createBrushLayer, createDealLayer,
  hasAnimatedShaderFill, withWiredContent, _registerWiredContent, renderLayerThumbnail,
} from '~/composables/useCompositorLayers'
import { DEAL_VOCABS, type DealVocab } from '~/lib/compositor/dealVocab'
import { defaultPane, PANE_LIMITS, type PaneParams } from '~/lib/compositor/pane'
import { defaultModular, MODULAR_LIMITS, MODULAR_PRESET_NAMES, modularPresetPatch, modularPresetOf, type ModularParams, type ModularPresetName, type ModularType } from '~/lib/compositor/modular'
import { defaultParcel, PARCEL_LIMITS, PARCEL_PRESET_NAMES, parcelPresetPatch, parcelPresetOf, type ParcelParams, type ParcelPresetName } from '~/lib/compositor/parcel'
import { defaultMosh, MOSH_LIMITS, MOSH_PRESET_NAMES, moshPresetPatch, moshPresetOf, type MoshParams, type MoshPresetName } from '~/lib/compositor/mosh'
import { migrateFrameToUnifiedLayers } from '~/lib/compositor/wiredMigration'
import { framePresentKeys, finalizeWiredSentinels, reconcileWiredContent, syncWiredLayerLinks, wiredReconcileKey, legacyWiredFlagsActive, isWiredSentinel } from '~/lib/compositor/frameStack'
import { createWiredMaskCache } from '~/lib/compositor/wiredMaskCache'
import { readWiredTreatments, setWiredMask, setWiredMaskShowSource, setWiredMaskUrl, maskCandidateKeys } from '~/composables/useWiredTreatments'
import { maskBreakFromEdge, type MaskBreak, type MaskBreakEdge } from '~/lib/compositor/maskBreak'
import { useLocalLayerEditor, resizableKind, cornerResizableKind } from '~/composables/useLocalLayerEditor'
import { snapshotFrameAsTemplate, addSlot } from '~/lib/frametemplate/author'
import { placeTemplate, setInstanceSlot, freezeInstance, staleInstances, updateInstance, applySlotToLayer } from '~/lib/frametemplate/apply'
import type { Template, TemplateInstance, SlotKind } from '~/lib/frametemplate/types'
import { useTemplateLibrary } from '~/composables/useTemplateLibrary'
import { serializeLayersForOS, parseLayersFromOS, setClipboard, type ClipboardPayload } from '~/lib/compositor/layerClipboard'
import {
  allGroupIds, childGroupIds, layersInGroup, groupDisplayName, isDescendantOrSelf,
  reparentGroup as reparentGroupOp, directLayerIds, upsertGroup,
} from '~/lib/compositor/layerGroups'
import { arrangeMembers, unionBBoxPx } from '~/lib/compositor/expressiveArrange'
import { rotatedUnionBoxPx } from '~/lib/compositor/groupResize'
import { insertStackKeyAbove, pruneWiredSlotFlags, pruneSlotKeyedRecord } from '~/lib/compositor/wiredSlots'
import { defaultExpressiveBoxParams, type ExpressiveBoxParams } from '~~/shared/text-layout/boxes'
import { useCompositorAgent } from '~/composables/useCompositorAgent'
import AgentBar from '~/components/agent/AgentBar.vue'
import AgentProposal from '~/components/agent/AgentProposal.vue'
import AgentProgress from '~/components/agent/AgentProgress.vue'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import { useVectorPen, buildPathLayerFromAnchors } from '~/composables/useVectorPen'
import { useBrushPaint } from '~/composables/useBrushPaint'
import { toWidthNorm, brushBoxFromStrokes, strokeRadiusPx, maskStrokeToLocal, type PaintStroke } from '~/lib/compositor/brushStamp'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import { useVectorNodeEdit } from '~/composables/useVectorNodeEdit'
import { generateVectorFromText, vectorizeImage, urlToDataUrl } from '~/composables/useVectorAi'
import { imageLayerUrl } from '~/composables/useCompositorLayers'
import { useInpaint, loadImage, capDims, imageToDataUrl, cleanCutoutAlpha } from '~/composables/useInpaint'
import { useLayerImageEdit } from '~/composables/useLayerImageEdit'
import { useRegionFx } from '~/composables/useRegionFx'
import type { Cloner } from '~/composables/useCloner'
import { resolveWiredSourceKind } from '~/lib/studio/frameResolve'
import { frameSourceEpoch, type StudioFrameSource } from '~/lib/studio/frameSource'
import { deriveMasterClock, slotPhase01, masterFrameIndex } from '~/lib/compositor/masterClock'
import {
  onDepthChange, depthImageFor, requestDepth, depthSourceFromViewUrl,
} from '~/lib/compositor/depthRegistry'
import { DEFAULT_DISPLACE_MAP } from '~/lib/compositor/displace'
import { imageUrlForNode } from '~/lib/canvas/nodeImage'
import { imageUrlToFile } from '~/lib/canvas/imageUrlToFile'
import { DEFAULT_FRAME_MOTION, type FrameMotion } from '~/lib/motion/types'
import { LIVE_FIELD_CEILING } from '~/lib/shaderfill/descriptor'
import '~/lib/motion/paint' // registers the motion painter for paintLayerStack(t)
import { bakeAndUpload, motionSourceKey, type MotionParams } from '~/lib/motion/bake'
import { readGrid } from '~/lib/frame/gridConfig'
import { resolveGrid, type FrameGrid } from '~/lib/frame/grid'
import CompositorMotionTimeline from '~/components/vue-canvas/compositor/CompositorMotionTimeline.vue'
import MotionLayerEditor from '~/components/vue-canvas/compositor/MotionLayerEditor.vue'
import AddImageSourcePopover from '~/components/vue-canvas/compositor/AddImageSourcePopover.vue'
import CompositorClonerPanel from '~/components/vue-canvas/compositor/CompositorClonerPanel.vue'
import CompositorTornEdgePanel from '~/components/vue-canvas/compositor/CompositorTornEdgePanel.vue'
import { DEFAULT_TORN_EDGE } from '~/lib/compositor/tornEdge'
import CompositorFeatherPanel from '~/components/vue-canvas/compositor/CompositorFeatherPanel.vue'
import { DEFAULT_FEATHER } from '~/lib/compositor/feather'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import StrokeStyleRow from '~/components/vue-canvas/compositor/StrokeStyleRow.vue'
import FillSwatch from '~/components/vue-canvas/compositor/FillSwatch.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import type { PaletteFamily } from '~/lib/color/seedFamily'
import type { GradientStop } from '~/lib/color/harmony'
import { layerPaletteAssignments } from '~/lib/compositor/distribute'
import PostEffectsControls from '~/components/vue-canvas/PostEffectsControls.vue'
import { isChainEffect, isGpuEffect } from '~/lib/compositor/postEffects'
import { encodeFrames } from '~/lib/engine/encodeVideo'
/** Everything the post-effects panel owns: the 2D chain plus the GPU stage. */
const isPanelEffect = (e: { type: string }) => isChainEffect(e) || isGpuEffect(e)
import {
  samplePointsFromStroke, layerAffine, invertAffine, applyAffine, wiredImageAffine,
  luminanceToAlpha, alphaBounds, cutoutPlacement, wiredCutoutPlacement, pickSamSegments,
  type Affine, type BBox, type Pt, type SamPoint, type MaskCandidate,
} from '~/lib/compositor/smartSelect'
import { toast } from 'vue-sonner'
import { paintPrimaryColor } from '~/lib/spacetype/fillTile'
import FontPicker from '~/components/vue-canvas/widgets/FontPicker.vue'
import { VARIABLE_FONTS } from '~/data/variable-fonts'
import type { GoogleFont } from '~/data/google-fonts'
import { libraryFamily } from '~/data/library-fonts'
import { defaultExpressiveParams, type ExpressiveParams } from '~~/shared/text-layout/expressive'
import { PenTool, Brush, Sparkles, Wand2, Lasso, Undo2, Redo2, ChevronRight, ChevronDown, ChevronUp, GripVertical, Play, Palette, Check, RefreshCw, ImagePlus, FileUp, LayoutGrid, LayoutTemplate, Snowflake } from 'lucide-vue-next'
import {
  TOOLBAR_SHAPES, TOOLBAR_AI, TOOLBAR_INSERT,
  DEFAULT_SHAPE_FACE, DEFAULT_AI_FACE, DEFAULT_INSERT_FACE,
  resolveShapeFace, shapeFaceLabel, smartSelectRowState,
  resolveAiFace, aiFaceLabel, resolveInsertFace, insertFaceLabel,
  type ToolbarShapeId, type ToolbarAiId, type ToolbarInsertId,
} from '~/lib/compositor/toolbarMenus'
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import { shapeById } from '~/lib/shapes/catalog'
import { createShapeLayer, swapShapeLayer } from '~/lib/shapes/pathLayer'
import { SHAPE_PICKER_WIDTH, anchorAbove } from '~/lib/shapes/pickerLayout'
import type { Component, ComputedRef } from 'vue'
import type { BrandKit } from '~~/shared/brand/types'
import { brandSwatches } from '~~/shared/brand/resolve'
import { PhCheckerboard } from '@phosphor-icons/vue'
import {
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalSpaceAround, AlignVerticalSpaceAround, Group, Ungroup,
} from 'lucide-vue-next'

const props = defineProps<{
  nodeId: string
  nodes: any[]
  edges: any[]
}>()

const emit = defineEmits<{ close: [] }>()

const { ensure: ensureGoogleFont } = useGoogleFontPreview()
const { ensure: ensureLibraryFont } = useLibraryFonts()

// Record generated stills/videos as the current project's assets (Assets panel)
// — mirrors GradientStudioSurface's "outputs" idiom exactly.
const { recordAsset } = useProjectGenerations()
const { activeTab } = useTabs()

const PROPS_PER_LAYER = ['x', 'y', 'rotation', 'scale', 'opacity', 'blend'] as const
const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'soft_light',
                     'hard_light', 'difference', 'lighten', 'darken', 'add']
// Font picker (shared full-catalog widget): map its pick → a fontFamily string,
// ensure the Google face loads, then patch the selected text layer.
const fontPickerKey = computed(() => {
  const fam = (selectedLocal.value as any)?.fontFamily || ''
  const v = VARIABLE_FONTS.find(f => f.family === fam)
  if (v) return 'var:' + v.id
  if (libraryFamily(fam)) return 'lib:' + fam
  return 'goog:' + fam
})
function onPickFont(payload: { source: 'variable'; id: string } | { source: 'google'; font: GoogleFont } | { source: 'library'; family: string }) {
  const id = selectedLocalId.value
  if (!id) return
  if (payload.source === 'library') {
    if (!payload.family) return
    ensureLibraryFont(payload.family)
    setLocal(id, { fontFamily: payload.family })
    return
  }
  const family = payload.source === 'variable'
    ? (VARIABLE_FONTS.find(f => f.id === payload.id)?.family ?? '')
    : payload.font.family
  if (!family) return
  ensureGoogleFont(family)
  setLocal(id, { fontFamily: family })
}

const compositor = computed(() => props.nodes.find((n: any) => n.id === props.nodeId))
// The Frame's display name (user-renamed node title), shown top-left.
const frameName = computed(() => {
  const d = compositor.value?.data as any
  return (d?.title || d?.subgraphName || 'Frame') as string
})

// ── Wired image layers (connected to the Compositor's slots) ────────────────
interface Layer {
  slot: number
  // Draw/cache key. Real /view URL for a baked image; synthetic `live:<slot>` for a
  // live studio slot, whose frame source is in `live` (pulled as a still — the
  // animated loop is a follow-on).
  url: string
  live?: StudioFrameSource
  x: number; y: number
  rotation: number; scale: number
  opacity: number; blend: string
  cloner?: Cloner
}

const layers = computed<Layer[]>(() => {
  frameSourceEpoch.value  // re-resolve when a studio (un)registers its frame source
  const node = compositor.value
  if (!node) return []
  const defs = node.data.widgetDefs as any[]
  const wv = node.data.widgetsValues as any[]
  const widgetIdx = (name: string) => defs.findIndex((d: any) => d.name === name)
  const out: Layer[] = []
  // Keep in sync with `_MAX_LAYERS` in comfy_extras/nodes_compositor.py.
  for (let i = 1; i <= 16; i++) {
    const kind = resolveWiredSourceKind(String(props.nodeId), `input-${i - 1}`, props.nodes, props.edges)
    if (!kind) continue
    const live = kind.kind === 'live' ? kind.source : undefined
    const url = kind.kind === 'url' ? kind.url : `live:${i}`
    out.push({
      slot: i,
      url,
      live,
      x: wv[widgetIdx(`layer${i}_x`)] ?? 0,
      y: wv[widgetIdx(`layer${i}_y`)] ?? 0,
      rotation: wv[widgetIdx(`layer${i}_rotation`)] ?? 0,
      scale: wv[widgetIdx(`layer${i}_scale`)] ?? 1,
      opacity: wv[widgetIdx(`layer${i}_opacity`)] ?? 1,
      blend: wv[widgetIdx(`layer${i}_blend`)] ?? 'normal',
      // Wired cloner is editor state on a node property (works without a backend
      // restart, like hidden/locked); it's stamped into the layer{i}_cloner
      // widget at submit by injectCompositorCloners.
      cloner: ((node.data.properties as any)?.sailor_wiredCloners ?? {})[i] as Cloner | undefined,
    })
  }
  return out
})

// Wired layer cloner is stored as editor state on a node property (slot → Cloner,
// 1-based to match layer{i}_cloner), NOT directly on the backend widget — so the
// toggle + live preview work immediately, without a ComfyUI restart (mirrors how
// hidden/locked wired flags and motion are kept). It's stamped into the
// layer{i}_cloner widget at submit by injectCompositorCloners (VueNodeCanvas).
function setWiredCloner(slot: number, cloner: Cloner) {
  const node = compositor.value
  if (!node) return
  const p = (node.data.properties ||= {})
  p.sailor_wiredCloners = { ...((p as any).sailor_wiredCloners ?? {}), [slot]: cloner }
}

// ── Canvas sizing — match the artboard/base aspect so positions are exact ───
const naturalDims = ref<Record<number, { w: number; h: number }>>({})
/** Record a decoded wired image for `slot` (1-based) — its pixel dims drive the
 *  artboard aspect and the contain-fit, and the element itself is what the
 *  content provider hands to paint. */
function setWiredImage(slot: number, img: HTMLImageElement) {
  if (!img.naturalWidth) return
  naturalDims.value = { ...naturalDims.value, [slot]: { w: img.naturalWidth, h: img.naturalHeight } }
  wiredImageEls.value = { ...wiredImageEls.value, [slot]: img }
}
const baseAspect = computed(() => {
  const node = compositor.value
  const defs = node?.data?.widgetDefs as any[] | undefined
  const wv = node?.data?.widgetsValues as any[] | undefined
  if (defs && wv) {
    const wi = defs.findIndex((d: any) => d.name === 'width')
    const hi = defs.findIndex((d: any) => d.name === 'height')
    const fw = wi >= 0 ? Number(wv[wi]) || 0 : 0
    const fh = hi >= 0 ? Number(wv[hi]) || 0 : 0
    if (fw > 0 && fh > 0) return fw / fh
  }
  const base = layers.value[0]
  if (!base) return 1
  const d = naturalDims.value[base.slot]
  return d && d.h ? d.w / d.h : 1
})
const canvasDisplay = reactive({ w: 680, h: 680 })
// ── Grid overlay + inspector ─────────────────────────────────────────────────
// `gridConfig` is display-only wiring: it feeds the overlay below (lines +
// region rects drawn over the stage). It is never consumed by any
// paintLayerStack/bake call in this file (those all draw into an offscreen
// `off` canvas, not this DOM overlay), so it can't leak into an export or
// embed. The modal IS the editor, so there is no separate "edit mode" gate
// the way the card has — visible whenever the grid itself is on.
// Writes go through the editor's `setGrid` (below, in the "No selection" panel's
// Grid section) — same property-write path as `setBackground`/`setPostEffects`.
const gridConfig = computed(() => readGrid(compositor.value?.data?.properties as any))
const gridResolved = computed(() => resolveGrid(gridConfig.value, canvasDisplay.w, canvasDisplay.h))
const showGridOverlay = computed(() => gridConfig.value.mode !== 'off' && gridConfig.value.overlay)
function patchGrid(patch: Partial<FrameGrid>) {
  setGrid({ ...gridConfig.value, ...patch })
}
function patchGen(patch: Partial<FrameGrid['gen']>) {
  setGrid({ ...gridConfig.value, gen: { ...gridConfig.value.gen, ...patch } })
}
const stageBoxRef = ref<HTMLElement | null>(null)
// The stage box is full-bleed (inset-0): the glass panels float ABOVE it, so
// zoomed/panned content slides under them instead of cropping at their edge.
// These gutters mirror the floating panels' own classes and are the only reason
// Fit still respects them — keep them in sync with the template:
//   left panel  `absolute left-4 w-60`  → 16 + 240 + 16 breathing = 272
//   right panel `absolute right-4 w-72` → 16 + 288 + 16 breathing = 320
const PANEL_GUTTER_LEFT = 272
const PANEL_GUTTER_RIGHT = 320
// Matte reserved around the artboard inside the stage box. The artboard fits
// whatever space remains (aspect preserved); stagePadBottom biases the centered
// artboard up so the top and bottom reserves can differ (0 while they match).
const STAGE_MATTE_X = 24
const STAGE_MATTE_TOP = 24
const STAGE_MATTE_BOTTOM = 24

// ── Hideable chrome (⌘\) ────────────────────────────────────────────────────
// Both glass panels slide out together. The preference is per-session (a
// reopened modal in the same tab remembers; a new tab starts with chrome on).
// Read in onMounted, never during setup, so SSR and the client agree.
const PANELS_KEY = 'sailor:compositor:panels'
const panelsVisible = ref(true)
/** Gutter Fit must clear on each side — nothing but the matte once panels are gone. */
const fitGutter = computed(() => panelsVisible.value ? Math.max(PANEL_GUTTER_LEFT, PANEL_GUTTER_RIGHT) : 0)
/** Left/right insets of the visible gap (used by the docked timeline + zoom-to-selection). */
const gapLeft = computed(() => panelsVisible.value ? PANEL_GUTTER_LEFT : STAGE_MATTE_X)
const gapRight = computed(() => panelsVisible.value ? PANEL_GUTTER_RIGHT : STAGE_MATTE_X)
function setPanelsVisible(v: boolean) {
  panelsVisible.value = v
  try { sessionStorage.setItem(PANELS_KEY, v ? '1' : '0') } catch { /* private mode / SSR */ }
  fitCanvasToStage()
}
function togglePanels() { setPanelsVisible(!panelsVisible.value) }

// Extra bottom allowance, in px, for chrome docked over the stage. Motion mode
// parks a full-width timeline at bottom-8; the artboard must re-fit ABOVE it
// rather than pay a permanent matte in every other mode. Written by the
// timeline's ResizeObserver (see `motionTimelineRef` below) — declared here so
// `fitCanvasToStage` never reads a ref through the temporal dead zone.
const stageBottomReserve = ref(0)
const stagePadBottom = computed(() => STAGE_MATTE_BOTTOM + stageBottomReserve.value - STAGE_MATTE_TOP)
function fitCanvasToStage() {
  const a = baseAspect.value || 1
  const box = stageBoxRef.value
  // Fit must land the artboard in the PANEL GAP, not in the full-bleed stage,
  // or "Fit" would tuck content under the glass. The artboard is centred on the
  // stage (= on the modal), so the binding constraint is the WIDER gutter: half
  // the artboard has to clear it on both sides. With the panels hidden there is
  // no gutter left to respect and Fit uses the full modal width.
  const availW = box
    ? Math.max(120, box.clientWidth - fitGutter.value * 2 - STAGE_MATTE_X * 2)
    : 680
  // clientHeight INCLUDES stagePadBottom (padding is inside the client box), so
  // the reserve is subtracted once here and once as padding — that pair is what
  // biases the centred artboard up clear of the docked timeline.
  const availH = box
    ? Math.max(120, box.clientHeight - STAGE_MATTE_TOP - STAGE_MATTE_BOTTOM - stageBottomReserve.value)
    : 600
  let w = availW, h = w / a
  if (h > availH) { h = availH; w = h * a }
  canvasDisplay.w = Math.round(w)
  canvasDisplay.h = Math.round(h)
}
watch(stageBottomReserve, () => fitCanvasToStage())
watch(baseAspect, fitCanvasToStage)
let stageRO: ResizeObserver | null = null
onMounted(() => {
  try { panelsVisible.value = sessionStorage.getItem(PANELS_KEY) !== '0' } catch { /* private mode */ }
  fitCanvasToStage()
  if (typeof ResizeObserver !== 'undefined' && stageBoxRef.value) {
    stageRO = new ResizeObserver(() => fitCanvasToStage())
    stageRO.observe(stageBoxRef.value)
  }
})
onBeforeUnmount(() => { stageRO?.disconnect(); stageRO = null })

// The docked motion timeline measures itself into `stageBottomReserve`, so the
// allowance tracks the real chrome (a taller timeline, more layers, a wrapped
// control row) instead of a hard-coded number that drifts.
const MOTION_TIMELINE_INSET = 32   // `bottom-8` on the docked timeline
const MOTION_TIMELINE_GAP = 12     // breathing room between artboard and timeline
const motionTimelineRef = ref<HTMLElement | null>(null)
let motionRO: ResizeObserver | null = null
watch(motionTimelineRef, (el) => {
  motionRO?.disconnect(); motionRO = null
  if (!el) { stageBottomReserve.value = 0; return }
  const measure = () => {
    stageBottomReserve.value = Math.round(el.getBoundingClientRect().height) + MOTION_TIMELINE_INSET + MOTION_TIMELINE_GAP
  }
  measure()
  if (typeof ResizeObserver !== 'undefined') { motionRO = new ResizeObserver(measure); motionRO.observe(el) }
})
onBeforeUnmount(() => { motionRO?.disconnect(); motionRO = null })

// ── Pan & zoom ──────────────────────────────────────────────────────────────
// A CSS transform on the stage wrapper. All hit-testing reads
// getBoundingClientRect(), which already reflects the transform, so layer drag,
// marquee, and handles stay pixel-accurate at any zoom. transform-origin 0 0
// keeps the zoom-to-cursor maths simple (screen-space translate).
const stageWrapRef = ref<HTMLElement | null>(null)
const view = reactive({ scale: 1, tx: 0, ty: 0 })
const ZOOM_MIN = 0.2, ZOOM_MAX = 8
// True while the user is actively panning/zooming the stage. The live-preview render
// loop (`liveFrameTick`) composites the whole stack — the wired studio pull plus every
// shader fill — at full device resolution each frame (~50 ms on this frame; ~19 fps
// even idle). Panning needs the frame budget for compositing the CSS transform, and the
// loop steals it, so a pan drops to ~5 fps. This flag pauses the loop's heavy work for
// the duration of the gesture (and 180 ms after the last move) so panning gets the whole
// budget; the loop keeps its rAF alive and resumes animating the moment the gesture ends.
// (No `will-change`/GPU-layer promotion here — that allocates VRAM and crashed the tab.)
const viewMoving = ref(false)
let viewMoveTimer: ReturnType<typeof setTimeout> | null = null
function markViewMoving() {
  viewMoving.value = true
  if (viewMoveTimer) clearTimeout(viewMoveTimer)
  viewMoveTimer = setTimeout(() => { viewMoving.value = false; viewMoveTimer = null }, 180)
}
const viewStyle = computed(() => ({
  width: canvasDisplay.w + 'px',
  height: canvasDisplay.h + 'px',
  transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
  transformOrigin: '0 0',
}))
function resetView() { view.scale = 1; view.tx = 0; view.ty = 0 }
function zoomAround(cx: number, cy: number, factor: number) {
  const wrap = stageWrapRef.value; if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  const s0 = view.scale
  const s1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s0 * factor))
  if (s1 === s0) return
  markViewMoving()
  // Keep the point under (cx,cy) fixed on screen.
  view.tx += (cx - rect.left) * (1 - s1 / s0)
  view.ty += (cy - rect.top) * (1 - s1 / s0)
  view.scale = s1
}
function zoomBy(factor: number) {
  zoomMenuOpen.value = false // the −/+ toolbar buttons sit inside the menu's
  // @click.stop wrapper (so their click doesn't trigger the stage's click-away),
  // which meant clicking them left an already-open menu stuck open. Keyboard
  // shortcuts route through here too; closing an already-closed menu is a no-op.
  const box = stageBoxRef.value; if (!box) return
  const r = box.getBoundingClientRect()
  zoomAround(r.left + r.width / 2, r.top + r.height / 2, factor)
}

// ── Zoom menu actions ───────────────────────────────────────────────────────
// Fit is the only one that re-measures: it clears the pan/zoom transform AND
// re-fits the artboard, so it always uses whatever width the chrome leaves.
const zoomMenuOpen = ref(false)
function zoomFit() { resetView(); fitCanvasToStage(); zoomMenuOpen.value = false }
/** Absolute zoom about the centre of the visible gap. */
function zoomToScale(target: number) {
  const s0 = view.scale
  const s1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target))
  zoomMenuOpen.value = false
  if (s1 === s0) return
  const c = gapCentre(); if (!c) return
  zoomAround(c.x, c.y, s1 / s0)
}
/** Centre of the space actually left between the panels, in client coords. */
function gapCentre(): { x: number, y: number, w: number, h: number } | null {
  const box = stageBoxRef.value; if (!box) return null
  const r = box.getBoundingClientRect()
  const w = Math.max(120, r.width - gapLeft.value - gapRight.value)
  const h = Math.max(120, r.height - STAGE_MATTE_TOP - STAGE_MATTE_BOTTOM - stageBottomReserve.value)
  return { x: r.left + gapLeft.value + w / 2, y: r.top + STAGE_MATTE_TOP + h / 2, w, h }
}
/** Selection bounds in ARTBOARD px (rotation-aware, single layer or multi).
 *
 *  The multi-select branch deliberately does NOT read `selectionBox` (the
 *  editor's un-rotated union, used for the overlay rectangle + resize handles):
 *  a rotated member's on-screen extent is bigger than its un-rotated box, so
 *  using `selectionBox` here would crop that member out of the ⌘2 zoom. Instead
 *  this unions each member's ROTATED corner AABB via `rotatedUnionBoxPx` — the
 *  same per-member math as the single-layer path below. See that helper's doc
 *  comment for why the overlay keeps the plain union. */
function selectionBoundsPx(): { cx: number, cy: number, w: number, h: number } | null {
  if (selectedLayers.value.length >= 2) {
    const W = canvasDisplay.w, H = canvasDisplay.h
    const b = rotatedUnionBoxPx(selectedLayers.value, boxPx, W, H)
    if (b) return { cx: b.cx, cy: b.cy, w: Math.max(1, b.w), h: Math.max(1, b.h) }
  }
  const h = localHandlePositions.value
  if (!h) return null
  const xs = [h.tl.x, h.tr.x, h.br.x, h.bl.x], ys = [h.tl.y, h.tr.y, h.br.y, h.bl.y]
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}
const hasSelectionToZoom = computed(() => !!selectionBox.value || !!localHandlePositions.value)
/** ⌘2 — fill ~60% of the visible gap with the selection, centred in that gap. */
const ZOOM_SELECTION_FILL = 0.6
function zoomToSelection(): boolean {
  zoomMenuOpen.value = false
  const b = selectionBoundsPx(); const c = gapCentre(); const wrap = stageWrapRef.value
  if (!b || !c || !wrap) return false
  // A degenerate (<2px) box is an unresolved wired sentinel or otherwise not yet
  // visible — dividing the gap by it would push the zoom factor to ZOOM_MAX and
  // strand the user on a blank, maxed-out canvas. No-op instead (menu hint stays
  // as-is; the selection is real, it just has nothing to frame yet).
  if (b.w < 2 || b.h < 2) return false
  const s1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
    Math.min(c.w * ZOOM_SELECTION_FILL / b.w, c.h * ZOOM_SELECTION_FILL / b.h)))
  // transform-origin is 0 0 and the translate is applied BEFORE the scale, so
  // the wrapper's untransformed origin is just its current rect minus the pan.
  const rect = wrap.getBoundingClientRect()
  const baseLeft = rect.left - view.tx
  const baseTop = rect.top - view.ty
  view.scale = s1
  view.tx = c.x - baseLeft - b.cx * s1
  view.ty = c.y - baseTop - b.cy * s1
  return true
}
const zoomMenuItems = computed(() => [
  { id: 'fit', label: 'Fit', hint: '⌘0', disabled: false, run: zoomFit },
  { id: '100', label: '100%', hint: '', disabled: false, run: () => zoomToScale(1) },
  { id: '200', label: '200%', hint: '', disabled: false, run: () => zoomToScale(2) },
  { id: 'selection', label: 'Zoom to selection', hint: '⌘2', disabled: !hasSelectionToZoom.value, run: () => { zoomToSelection() } },
])

function onStageWheel(e: WheelEvent) {
  e.preventDefault()
  markViewMoving()
  if (e.ctrlKey || e.metaKey) zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01))
  else { view.tx -= e.deltaX; view.ty -= e.deltaY } // two-finger / wheel scroll → pan
}
// Space-drag (or middle-mouse) panning — universal, works with any pointer.
const spaceDown = ref(false)
const panning = ref(false)
let panFrom: { x: number, y: number, tx: number, ty: number } | null = null
let didPan = false
function onStagePointerDownPan(e: PointerEvent) {
  if (e.button === 1 || (spaceDown.value && e.button === 0)) {
    e.preventDefault(); e.stopPropagation()
    panning.value = true; didPan = false
    markViewMoving() // pause the render loop at gesture START, not first move, so the
    // pan doesn't wait a render cycle (~50–200 ms) before it starts moving smoothly
    panFrom = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
}
function onStagePointerMovePan(e: PointerEvent) {
  if (!panFrom) return
  didPan = true
  markViewMoving()
  view.tx = panFrom.tx + (e.clientX - panFrom.x)
  view.ty = panFrom.ty + (e.clientY - panFrom.y)
}
function onStagePointerUpPan() { panFrom = null; panning.value = false }

const canvasRef = ref<HTMLDivElement | null>(null)
function canvasRect(): DOMRect | null { return canvasRef.value?.getBoundingClientRect() ?? null }

// ── Local-layer editing engine (shared with the Frame node) ─────────────────
// ── Wired content, keyed the way the unified model keys it ──────────────────
// This modal's own `Layer.slot` / `naturalDims` / `wiredImageEls` are 1-BASED
// (`layer1` = slot 1); `WiredLayer.slot` is the 0-BASED input-port index. The
// shift lives HERE, at every boundary, spelled out — a silent off-by-one
// produces wrong widths rather than a crash.
const wiredMaskCache = createWiredMaskCache()
/** 0-based slot → decoded content (per-slot mask already punched out).
 *
 *  Gated on the slots that are CONNECTED right now (`layers` is derived from the
 *  graph's edges every tick). `wiredImageEls` is a decode cache and is never
 *  pruned, so without the gate a slot whose edge was cut kept handing back its
 *  last bitmap: the layer painted its old pixels while wearing the "unlinked"
 *  badge, and export / motion bake baked that ghost. The Frame card has always
 *  returned null for a disconnected slot (its url lookup only sees connected
 *  ones) — this is the modal matching it. An unlinked layer keeps its BOX (from
 *  `lastAspect`), so it stays selectable and re-wiring brings the pixels back. */
function wiredContentForSlot(slot: number): CanvasImageSource | null {
  const n = slot + 1
  if (!layers.value.some(l => l.slot === n)) return null
  return wiredMaskCache.apply(slot, wiredImageEls.value[n] ?? null, wiredMaskEls.value[n] ?? null)
}
/** 0-based slot → the content's real pixel dims, for the write-through's fit. */
function wiredDimsForSlot(slot: number): { w: number; h: number } | undefined {
  return naturalDims.value[slot + 1]
}

const editor = useLocalLayerEditor({
  node: () => compositor.value,
  dims: () => ({ w: canvasDisplay.w, h: canvasDisplay.h }),
  getRect: () => canvasRect(),
  wiredDims: wiredDimsForSlot,
  wiredContent: wiredContentForSlot,
  // Deleting a wired layer takes the slot's edge with it (only the canvas owns
  // edges, so ask it). Undo restores the LAYER, not the edge — it comes back
  // `unlinked`, and the toast says how to relink it.
  onWiredRemoved: (wired) => {
    for (const w of wired) {
      window.dispatchEvent(new CustomEvent('sailor:frameUnwireSlot', { detail: { nodeId: props.nodeId, slot: w.slot } }))
    }
    if (wired.length) {
      toast('Layer removed and its input unwired', {
        description: 'Undo brings the layer back unlinked — re-wire the input to reconnect it.',
      })
    }
  },
  // ⌘D / copy on a wired layer never clones the live link: it bakes what you SEE
  // into a normal image layer (the existing "Copy into frame" path), which is the
  // only copy that can stand on its own.
  materializeWired: (w) => copyWiredIntoFrame(w.slot + 1),
  // Push the same ⌘C payload to the OS clipboard (Sailor layer JSON + a
  // composited PNG) so copy/paste reaches across frames, projects and sessions.
  onOSCopy: (payload) => { void writeLayersToOSClipboard(payload) },
})
const layerEdit = useLayerImageEdit()
const {
  localLayers, setLocal, addLocal, deleteLocal, selectLocal,
  selectedId: selectedLocalId, selected: selectedLocal,
  editingId, editingLayer, beginEdit, endEdit,
  boxPx, handlePositions: localHandlePositions,
  startScale: onLocalScalePointerDown, startRotate: onLocalRotatePointerDown, startResize: onLocalResizePointerDown,
  onCanvasPointerDown, onCanvasDblClick,
  addText, addRect, addEllipse, addLine, addPolygon, addStar, addImageFromFile, addImageFromName, addImageFromCanvasSrc,
  addPathLayers, addPathFromSvg, deleteLayers,
  background, setBackground,
  postEffects, setPostEffects,
  setGrid,
  undo, redo, canUndo, canRedo,
  selectedIds, selectedLayers, toggleSelect, applyBoolean, alignSelected, recordHistory, commit, handleEditorKey, pasteClipboard,
  selectionBox, selectionHandles, startGroupResize,
  groupSelected, ungroupSelected, ungroupGroup, renameGroup, canGroup, canUngroup,
  localGroups, commitBoth, selectGroupById, writeGroups,
  setGroupHidden, setGroupLocked, setGroupOpacity, groupCascade,
  editingLayerNameId, layerNameDraft, startLayerRename, commitLayerRename,
  snapGuides, marquee, startMarquee, moveMarquee, endMarquee,
  hud,
  fillGridWithSections, resnapSelected,
  drawSectionActive, setDrawSectionActive, finishDrawSection,
} = editor

// Region-count cap for "Fill grid with sections": a dense generated/explicit
// grid (say 12×8) can resolve to dozens of cells — stamping a rect per cell past
// this point is real, avoidable layer-panel/render clutter for a feature meant
// for coarse layout grids. Dense fills are a later feature (see Task 7 brief).
const GRID_SECTIONS_CAP = 24
function onFillGridWithSections() {
  const { regions } = gridResolved.value
  if (!regions.length) { toast('Turn the grid on first', { description: 'Fill grid with sections needs an explicit or generated grid.' }); return }
  if (regions.length > GRID_SECTIONS_CAP) {
    toast('Too many regions for sections', { description: 'Use a coarser grid — dense fills are a later feature.' })
    return
  }
  fillGridWithSections(regions)
}

// ── The generative deal (grid slice 2) ──────────────────────────────────────
// ONE self-painting layer that deals every cell of the CURRENT layout grid a fill
// from a weighted vocabulary — a dense decorative grid as a single layer that
// BAKES (unlike the editor-only grid overlay). Deep-copies the frame's grid so the
// deal is self-contained; a grid that's off is dealt as a generated one.
function onDealGrid() {
  const g = JSON.parse(JSON.stringify(gridConfig.value)) as typeof gridConfig.value
  if (g.mode === 'off') g.mode = 'generated'
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  addLocal(createDealLayer({ grid: g, w: 1, h: aspect }))
}

/** Patch a deal layer's own grid (one history step via setLocal). */
function patchDealGrid(layer: DealLayer, patch: Partial<typeof layer.grid>) {
  setLocal(layer.id, { grid: { ...layer.grid, ...patch } })
}
/** Re-roll a deal's seed for a fresh coherent variation (layout + fills + density). */
function rerollDeal(layer: DealLayer) {
  patchDealGrid(layer, { gen: { ...layer.grid.gen, seed: Math.floor(Math.random() * 9999) + 1 } })
}

/** One-click "Pane" — the Pane generator (lib/compositor/pane): its own row-masonry
 *  of flush cells, each a corner-to-corner two-ink ramp (cellFill:'pane'), at the
 *  original's defaults (rows 3 / cells 6 / vary .55 / diag .45 / soft .85 / spread
 *  .55). Configures the selected deal, or — with none selected — creates a fresh deal
 *  filling the frame, in one undoable step. The deal's grid is untouched: Pane
 *  ignores it (only its seed carries the variation). */
function onPane() {
  if (selectedLocal.value?.kind === 'deal') {
    const layer = selectedLocal.value as DealLayer
    setLocal(layer.id, { cellFill: 'pane', pane: defaultPane() } as Partial<DealLayer>)
    return
  }
  const g = JSON.parse(JSON.stringify(gridConfig.value)) as typeof gridConfig.value
  if (g.mode === 'off') g.mode = 'generated'
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  addLocal(createDealLayer({ grid: g, w: 1, h: aspect, cellFill: 'pane', pane: defaultPane() }))
}
/** Patch a deal's Pane tunables (one history step via setLocal). */
function patchPane(layer: DealLayer, patch: Partial<PaneParams>) {
  setLocal(layer.id, { pane: { ...(layer.pane ?? defaultPane()), ...patch } } as Partial<DealLayer>)
}

/** One-click "Modular" — the Modular generator (lib/compositor/modular): a merged
 *  module grid over a background, each module empty / solid / block field / dot
 *  cluster / line grid / 2-stop ramp, hairlines over the whole grid (cellFill:
 *  'modular'), at the original's defaults (6 columns / unit 4 / merge .45 / the
 *  source type weights / block fill .5 / dot .62 / rules .22 / rule width 1).
 *  Configures the selected deal, or — with none selected — creates a fresh deal
 *  filling the frame, in one undoable step. The deal's grid is untouched: Modular
 *  ignores it (only its seed carries the variation). */
function onModular() {
  if (selectedLocal.value?.kind === 'deal') {
    const layer = selectedLocal.value as DealLayer
    setLocal(layer.id, { cellFill: 'modular', modular: defaultModular() } as Partial<DealLayer>)
    return
  }
  const g = JSON.parse(JSON.stringify(gridConfig.value)) as typeof gridConfig.value
  if (g.mode === 'off') g.mode = 'generated'
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  addLocal(createDealLayer({ grid: g, w: 1, h: aspect, cellFill: 'modular', modular: defaultModular() }))
}
/** Patch a deal's Modular tunables (one history step via setLocal). */
function patchModular(layer: DealLayer, patch: Partial<ModularParams>) {
  setLocal(layer.id, { modular: { ...(layer.modular ?? defaultModular()), ...patch } } as Partial<DealLayer>)
}
/** Patch ONE of Modular's six type weights. */
function patchModularWeight(layer: DealLayer, type: ModularType, v: number) {
  const m = layer.modular ?? defaultModular()
  patchModular(layer, { w: { ...m.w, [type]: v } })
}
/** Apply a named palette preset (bg + rule + the ordered inks) to a Modular deal. */
function applyModularPreset(layer: DealLayer, name: string) {
  if (!(MODULAR_PRESET_NAMES as string[]).includes(name)) return
  patchModular(layer, modularPresetPatch(name as ModularPresetName))
}
/** Which preset the selected Modular deal currently matches ('' when custom). */
const modularPreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return modularPresetOf((l as DealLayer).modular ?? defaultModular()) ?? ''
})
/** Plain-language labels for the six module types, in pick order. */
const MODULAR_TYPE_LABELS: readonly { type: ModularType; label: string }[] = [
  { type: 'empty', label: 'Empty' }, { type: 'solid', label: 'Solid' }, { type: 'blocks', label: 'Blocks' },
  { type: 'dots', label: 'Dots' }, { type: 'lines', label: 'Lines' }, { type: 'grad', label: 'Gradient' },
]

/** One-click "Parcel" — the Parcel generator (lib/compositor/parcel): a coarse
 *  two-tone block field (ground + ink, every cell one or the other) with ragged
 *  hairline survey grids floating on top that darken what they cross (cellFill:
 *  'parcel'), at the original's defaults (16 cells / cover .5 / chunk 1 / 4 survey
 *  grids / multiply / lime ink on grey). Configures the selected deal, or — with
 *  none selected — creates a fresh deal filling the frame, in one undoable step.
 *  The deal's grid is untouched: Parcel ignores it (only its seed carries the
 *  variation). */
function onParcel() {
  if (selectedLocal.value?.kind === 'deal') {
    const layer = selectedLocal.value as DealLayer
    setLocal(layer.id, { cellFill: 'parcel', parcel: defaultParcel() } as Partial<DealLayer>)
    return
  }
  const g = JSON.parse(JSON.stringify(gridConfig.value)) as typeof gridConfig.value
  if (g.mode === 'off') g.mode = 'generated'
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  addLocal(createDealLayer({ grid: g, w: 1, h: aspect, cellFill: 'parcel', parcel: defaultParcel() }))
}
/** Patch a deal's Parcel tunables (one history step via setLocal). */
function patchParcel(layer: DealLayer, patch: Partial<ParcelParams>) {
  setLocal(layer.id, { parcel: { ...(layer.parcel ?? defaultParcel()), ...patch } } as Partial<DealLayer>)
}
/** Apply a named palette preset (ground + ink + hairline) to a Parcel deal. */
function applyParcelPreset(layer: DealLayer, name: string) {
  if (!(PARCEL_PRESET_NAMES as string[]).includes(name)) return
  patchParcel(layer, parcelPresetPatch(name as ParcelPresetName))
}
/** Which preset the selected Parcel deal currently matches ('' when custom). */
const parcelPreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return parcelPresetOf((l as DealLayer).parcel ?? defaultParcel()) ?? ''
})
/** One-click "Mosh" — the Mosh generator (lib/compositor/mosh): a corrupted
 *  framebuffer — uneven horizontal bands, each a different failure (confetti runs,
 *  torn mosaic blocks, thin smears, full-width scan rows with bright cuts, a
 *  chevron herringbone), every mark a column-quantised filled rect in
 *  full-strength colour-cube inks with dead near-black patches (cellFill:'mosh'),
 *  at the original's defaults (6 bands / 150 cells across / mix .62 / tears .55 /
 *  runs .5 / bright .3 / the pure cube). Configures the selected deal, or — with
 *  none selected — creates a fresh deal filling the frame, in one undoable step.
 *  The deal's grid is untouched: Mosh ignores it (only its seed carries the
 *  variation). */
function onMosh() {
  if (selectedLocal.value?.kind === 'deal') {
    const layer = selectedLocal.value as DealLayer
    setLocal(layer.id, { cellFill: 'mosh', mosh: defaultMosh() } as Partial<DealLayer>)
    return
  }
  const g = JSON.parse(JSON.stringify(gridConfig.value)) as typeof gridConfig.value
  if (g.mode === 'off') g.mode = 'generated'
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  addLocal(createDealLayer({ grid: g, w: 1, h: aspect, cellFill: 'mosh', mosh: defaultMosh() }))
}
/** Patch a deal's Mosh tunables (one history step via setLocal). */
function patchMosh(layer: DealLayer, patch: Partial<MoshParams>) {
  setLocal(layer.id, { mosh: { ...(layer.mosh ?? defaultMosh()), ...patch } } as Partial<DealLayer>)
}
/** Apply a named palette preset (the 8 inks) to a Mosh deal. */
function applyMoshPreset(layer: DealLayer, name: string) {
  if (!(MOSH_PRESET_NAMES as string[]).includes(name)) return
  patchMosh(layer, moshPresetPatch(name as MoshPresetName))
}
/** Which preset the selected Mosh deal currently matches ('' when custom). */
const moshPreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return moshPresetOf((l as DealLayer).mosh ?? defaultMosh()) ?? ''
})
/** The five cell fills as the segmented control's plain labels. */
const DEAL_FILL_LABELS: readonly { fill: NonNullable<DealLayer['cellFill']>; label: string }[] = [
  { fill: 'solid', label: 'Solid' }, { fill: 'pane', label: 'Pane' }, { fill: 'modular', label: 'Modular' }, { fill: 'parcel', label: 'Parcel' }, { fill: 'mosh', label: 'Mosh' },
]
const dealFillLabel = (layer: DealLayer) => DEAL_FILL_LABELS.find(f => f.fill === layer.cellFill)?.label ?? 'Solid'
/** Switch a deal's cell fill, seeding that fill's params with the defaults when absent. */
function setDealFill(layer: DealLayer, label: string) {
  const fill = DEAL_FILL_LABELS.find(f => f.label === label)?.fill ?? 'solid'
  const patch: Partial<DealLayer> = { cellFill: fill }
  if (fill === 'pane') patch.pane = layer.pane ?? defaultPane()
  if (fill === 'modular') patch.modular = layer.modular ?? defaultModular()
  if (fill === 'parcel') patch.parcel = layer.parcel ?? defaultParcel()
  if (fill === 'mosh') patch.mosh = layer.mosh ?? defaultMosh()
  setLocal(layer.id, patch)
}

// Normalize brush layers to a tight box: brush strokes are stored in absolute
// artboard coords, and a layer's x/y/w/h should equal their bounds so the render
// centres them in place and selection/handles hug the marks. Layers painted before
// the tight-box change kept a full-artboard box (x/y=0.5, w=1); re-derive it here.
// Idempotent (eps-guarded) so it runs once per stale layer and never loops; a
// correctly-boxed new layer matches its bounds and is skipped.
watch(
  () => localLayers.value.filter(l => l.kind === 'brush')
    .map(l => `${l.id}:${(l as BrushLayer).strokes.length}`).join(',') + `|${canvasDisplay.w}x${canvasDisplay.h}`,
  () => {
    if (!localLayers.value.some(l => l.kind === 'brush')) return
    const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
    let changed = false
    const next = localLayers.value.map((l) => {
      if (l.kind !== 'brush' || !(l as BrushLayer).strokes.length) return l
      const bl = l as BrushLayer
      const box = brushBoxFromStrokes(bl.strokes, aspect)
      if (Math.abs(bl.x - box.x) < 1e-4 && Math.abs(bl.y - box.y) < 1e-4
        && Math.abs(bl.w - box.w) < 1e-4 && Math.abs(bl.h - box.h) < 1e-4) return l
      changed = true
      return { ...bl, ...box }
    })
    if (changed) commit(next as LocalLayer[])
  },
  { immediate: true },
)

// In-product agent (Phase 2, 2nd home) — drives the frame through the Compositor
// command surface. Bridges to the local-layer editor: read layers + background;
// write via commit (+ setBackground when it changes).
const { getLocalSetting } = useLocalSettings()
const {
  busy: caBusy, error: caError, notice: caNotice,
  changes: caChanges, issues: caIssues, review: caReview, reviewing: caReviewing, hasProposal: caHasProposal, hovered: caHovered,
  ask: caAsk, acceptChange: caAccept, rejectChange: caReject, reroll: caReroll, keep: caKeep, revert: caRevert,
} = useCompositorAgent({
  getState: () => ({
    layers: localLayers.value,
    background: background.value,
    postEffects: postEffects.value,
    grid: readGrid(compositor.value?.data?.properties as any),
    brandPalette: brandSwatches(projectBrand?.activeKit.value),
  }),
  setState: (s) => {
    commit(s.layers)
    if (s.background !== background.value) setBackground(s.background)
    if (JSON.stringify(s.postEffects ?? []) !== JSON.stringify(postEffects.value)) setPostEffects(s.postEffects ?? [])
    if (s.grid && JSON.stringify(s.grid) !== JSON.stringify(gridConfig.value)) setGrid(s.grid)
  },
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  dims: () => ({ w: canvasDisplay.w, h: canvasDisplay.h }),
})
// The agent's progress / proposed changes take over the right inspector while active.
const caPanelActive = computed(() => caBusy.value || caReviewing.value || caHasProposal.value)

// ── Frame templates: save / place / fill slots / freeze ─────────────────────
// A template is a frozen snapshot of this frame's layers+groups with a subset
// of layers marked as "slots" (text/color/image) — see lib/frametemplate/.
// Placed COPIES persist as `TemplateInstance`s in
// `node.data.properties.sailor_frametemplates` (an array), which round-trips
// automatically because `convertToLiteGraph` passes `properties` through
// wholesale. Id minting for placement lives HERE, not in the pure module —
// the pure functions only ever take id factories.
const templateLib = useTemplateLibrary()
function templateFrameSize(): { w: number; h: number } { return { w: canvasDisplay.w, h: canvasDisplay.h } }
const frameTemplateInstances = computed<TemplateInstance[]>(() =>
  ((compositor.value?.data?.properties)?.sailor_frametemplates as TemplateInstance[]) ?? [])
function commitTemplateInstances(next: TemplateInstance[]) {
  const n = compositor.value; if (!n) return
  if (!n.data.properties) n.data.properties = {}
  n.data.properties.sailor_frametemplates = next
}
let _tplIdSeq = 0
const mkTemplateId = (prefix: string) => () => `${prefix}-${Date.now().toString(36)}-${++_tplIdSeq}`

/** Snapshot the current frame into a Template, applying any marked slots.
 *  Pass `existingId` to re-save into an existing template (bumps its version
 *  instead of minting a fresh one) — used by the future update flow. */
async function saveAsTemplate(
  name: string,
  slotPicks: { layerId: string; kind: SlotKind; label: string }[],
  existingId?: string,
): Promise<Template> {
  const id = existingId ?? `tpl-${Date.now().toString(36)}`
  let t = snapshotFrameAsTemplate({
    id, name, layers: localLayers.value, groups: localGroups.value,
    frameSize: templateFrameSize(),
    mkKey: (i) => `k${i}`,
  })
  // Map the user's tapped layer ids → template layer keys (same order as the snapshot).
  const keyByLayerId = new Map(localLayers.value.map((l, i) => [l.id, `k${i}`]))
  let slotSeq = 0
  for (const pick of slotPicks) {
    const key = keyByLayerId.get(pick.layerId); if (!key) continue
    t = addSlot(t, key, pick.kind, pick.label, () => `slot-${slotSeq++}`)
  }
  // Re-saving an EXISTING template bumps its version (snapshotFrameAsTemplate
  // always returns version 1) — required so a later update flow can tell a
  // placed copy its template moved on.
  const existing = templateLib.get(id)
  if (existing) t = { ...t, version: (existing.version as number) + 1 }
  await templateLib.save(t as any)
  return t
}

/** Seed each slot's initial value from the template layer's current content. */
function defaultSlotValues(t: Template): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of t.slots) {
    const tl = t.layers.find(l => l.key === s.layerKey)?.layer as any
    out[s.id] = s.kind === 'text' ? (tl?.text ?? '') : s.kind === 'image' ? (tl?.filename ?? '') : (tl?.color ?? tl?.fill ?? '#000000')
  }
  return out
}

function placeTemplateIntoFrame(t: Template) {
  const r = placeTemplate({ layers: localLayers.value, groups: localGroups.value }, t, defaultSlotValues(t), {
    mkLayerId: mkTemplateId('ll'), mkGroupId: mkTemplateId('g'), mkInstanceId: mkTemplateId('inst'),
  })
  recordHistory()
  commitBoth(r.layers, r.groups)
  commitTemplateInstances([...frameTemplateInstances.value, r.instance])
}

function fillTemplateSlot(inst: TemplateInstance, t: Template, slotId: string, value: string) {
  const r = setInstanceSlot(localLayers.value, t, inst, slotId, value)
  recordHistory(); commit(r.layers)
  commitTemplateInstances(frameTemplateInstances.value.map(i => (i.instanceId === inst.instanceId ? r.instance : i)))
}

function freezeTemplateInstance(inst: TemplateInstance) {
  recordHistory()
  commitTemplateInstances(freezeInstance(frameTemplateInstances.value, inst.instanceId))
  toast('Template copy frozen', { description: 'It stays on the frame as regular layers, no longer linked to the template.' })
}

// ── Per-project "template changed" prompt ────────────────────────────────
// Placed copies pin the template version they were placed/updated from
// (`instance.templateVersion`). When the library's copy is newer AND the
// copy's slots still line up (staleInstances excludes reshaped copies —
// those aren't offered, matching Task 5's guard), surface a small
// non-blocking banner instead of forcing the update.
const pendingTemplateUpdates = ref<{ instance: TemplateInstance; template: Template }[]>([])
function checkForTemplateUpdates() {
  pendingTemplateUpdates.value = staleInstances(
    frameTemplateInstances.value,
    (id) => templateLib.get(id) as unknown as Template | undefined,
  )
}
function dismissTemplateUpdates() { pendingTemplateUpdates.value = [] }
function applyTemplateUpdate(u: { instance: TemplateInstance; template: Template }) {
  const r = updateInstance({ layers: localLayers.value, groups: localGroups.value }, u.template, u.instance, {
    mkLayerId: mkTemplateId('ll'), mkGroupId: mkTemplateId('g'),
  })
  recordHistory()
  commitBoth(r.layers, r.groups)
  commitTemplateInstances(frameTemplateInstances.value.map(i => (i.instanceId === u.instance.instanceId ? r.instance : i)))
}
function applyAllTemplateUpdates() {
  const updates = pendingTemplateUpdates.value
  pendingTemplateUpdates.value = []
  for (const u of updates) applyTemplateUpdate(u)
  toast(updates.length === 1 ? 'Updated 1 copy' : `Updated ${updates.length} copies`, {
    description: 'Slot values kept; the rest re-synced from the template.',
  })
}
// Detect stale copies as soon as the Frame binds (library may already be
// warm from a prior modal), then again once the library has pulled server
// truth — a template edited from another project/tab must be caught too.
onMounted(() => {
  checkForTemplateUpdates()
  templateLib.refresh().then(checkForTemplateUpdates).catch(() => { /* offline — keep the pre-refresh check */ })
})

/** Which placed instance (if any) the current selection touches — any overlap
 *  between the selected layer ids and the instance's placed layer ids counts,
 *  so both a lone slot layer and the whole copy (selected as a group) resolve
 *  to it. */
const activeTemplateInstance = computed<TemplateInstance | null>(() => {
  if (!selectedIds.value.size) return null
  return frameTemplateInstances.value.find(inst =>
    Object.values(inst.placedKeys).some(id => selectedIds.value.has(id))) ?? null
})
const activeTemplateInstanceTemplate = computed<Template | null>(() => {
  const inst = activeTemplateInstance.value
  if (!inst) return null
  return (templateLib.get(inst.templateId) as unknown as Template) ?? null
})

// ── "Save as template" sheet: name it, tap layers in the left panel to mark
// them as slots (kind defaults from the layer kind: text→text, image→image,
// any shape→color; both are editable per pick). ───────────────────────────
const templatesOpen = ref(false)
const savingTemplate = ref(false)
const saveTemplateName = ref('')
interface SlotPick { layerId: string; kind: SlotKind; label: string }
const slotPicks = ref<SlotPick[]>([])
function defaultSlotKindFor(kind: string): SlotKind {
  return kind === 'text' ? 'text' : kind === 'image' ? 'image' : 'color'
}
function defaultSlotLabelFor(l: any): string {
  if (!l) return 'Layer'
  if (l.kind === 'text') return (String(l.text ?? '').split('\n')[0] || 'Text').slice(0, 24)
  return l.kind.charAt(0).toUpperCase() + l.kind.slice(1)
}
function openTemplatesPanel() { templatesOpen.value = true }
function toggleTemplatesPanel() {
  if (templatesOpen.value) { templatesOpen.value = false; cancelSaveTemplate() }
  else openTemplatesPanel()
}
function beginSaveTemplate() {
  templatesOpen.value = true
  savingTemplate.value = true
  saveTemplateName.value = ''
  slotPicks.value = []
}
function cancelSaveTemplate() {
  savingTemplate.value = false
  saveTemplateName.value = ''
  slotPicks.value = []
}
/** Toggle a layer's slot pick — the left layer panel calls this while the
 *  save sheet is open (see `onRowClick`). */
function toggleSlotPick(layerId: string) {
  const i = slotPicks.value.findIndex(p => p.layerId === layerId)
  if (i >= 0) { slotPicks.value.splice(i, 1); return }
  const l = localLayers.value.find(x => x.id === layerId)
  slotPicks.value.push({ layerId, kind: defaultSlotKindFor(l?.kind ?? ''), label: defaultSlotLabelFor(l) })
}
function isSlotPicked(layerId: string) { return slotPicks.value.some(p => p.layerId === layerId) }
async function confirmSaveTemplate() {
  const name = saveTemplateName.value.trim()
  if (!name) { toast('Name the template first'); return }
  const t = await saveAsTemplate(name, slotPicks.value)
  toast(`Saved template "${t.name}"`)
  cancelSaveTemplate()
}

// ── Slot-fill panel: per-slot value editors for a selected placed copy ──────
const templateImageInputRef = ref<HTMLInputElement | null>(null)
const pendingImageSlotId = ref<string | null>(null)
function pickSlotImage(slotId: string) {
  pendingImageSlotId.value = slotId
  templateImageInputRef.value?.click()
}
async function onTemplateSlotImageFile(e: Event) {
  const file = (e.target as HTMLInputElement)?.files?.[0]
  const slotId = pendingImageSlotId.value
  pendingImageSlotId.value = null
  if (e.target) (e.target as HTMLInputElement).value = ''
  const inst = activeTemplateInstance.value; const t = activeTemplateInstanceTemplate.value
  if (!file || !slotId || !inst || !t) return
  try {
    const ts = Date.now()
    const safe = `tpl_${ts}_${(file.name || 'image.png').replace(/[^\w.-]+/g, '_')}`
    const fd = new FormData()
    fd.append('image', new File([file], safe, { type: file.type }))
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    const uploadedName = (await res.json())?.name || safe
    fillTemplateSlot(inst, t, slotId, uploadedName)
  } catch (err) {
    console.error('[Compositor] template slot image upload failed:', err)
    toast('Image upload failed')
  }
}

// ── Prompt bar: collapsed pill until it's wanted ────────────────────────────
// The AgentBar stays MOUNTED at all times — collapsing is width/opacity only —
// so focusing it works and the half-typed phrase it owns internally survives.
// The draft is mirrored here (from the bubbling `input` event, no prop drilling)
// for one decision: a bar with text in it does NOT collapse on blur. Losing
// sight of a phrase you were still writing is worse than a slightly wider bar.
const promptFocused = ref(false)
const promptDraft = ref('')
const promptExpanded = computed(() => promptFocused.value || promptDraft.value.trim().length > 0)
const promptDockRef = ref<HTMLElement | null>(null)
function onPromptInput(e: Event) {
  const t = e.target as HTMLInputElement | null
  if (t && 'value' in t) promptDraft.value = t.value
}
function onPromptFocusOut() {
  // `relatedTarget` is not enough: the collapsed pill is a BUTTON inside the
  // dock, and hiding it (v-show) fires a focusout with relatedTarget null even
  // though focus is on its way to the input. Settle a frame, then ask where
  // focus actually landed — inside the dock (input ⇄ send button) is not a blur.
  requestAnimationFrame(() => {
    const el = document.activeElement
    if (el && promptDockRef.value?.contains(el)) return
    promptFocused.value = false
  })
}
function focusPrompt() {
  promptFocused.value = true
  nextTick(() => promptDockRef.value?.querySelector('input')?.focus())
}

const selectedCount = computed(() => selectedLayers.value.length)
// Distribute a seed-engine palette across the multi-selection, one hex per
// layer (cycling short / resampling long — layerPaletteAssignments). `wired`
// layers have no paint field of their own (their pixels come from an upstream
// node), so they're excluded from both the distribution and the write —
// exactly like clonableSelection() excludes them from duplication.
const showMultiPalette = ref(false)
// Core of the distribution, reached via apply-stops only (gallery and harmony
// panes emit apply-stops; the seed shelf emits apply-family separately, via
// applyPaletteToSelection, and also emits apply-literal-stops — which is
// deliberately NOT bound below, since binding it double-fires this on every
// seed-tile click) — see the @apply-* bindings on the picker below.
function distributePaletteToSelection(hexes: string[]) {
  const targets = selectedLayers.value.filter(l => l.kind !== 'wired')
  if (!targets.length) { showMultiPalette.value = false; return }
  const assignments = layerPaletteAssignments(targets.map(l => l.id), hexes)
  recordHistory()
  commit(localLayers.value.map((l) => {
    const hex = assignments[l.id]
    if (!hex) return l
    const copy: any = { ...l }
    applySlotToLayer(copy, 'color', hex)
    return copy as LocalLayer
  }))
  showMultiPalette.value = false
}
function applyPaletteToSelection(fam: PaletteFamily) {
  distributePaletteToSelection(fam.hexes)
}
// Box layers (rect/ellipse/image) get full Figma-style resize (corners + edges,
// anchored opposite side); text/line/path keep uniform corner scale (no 2D box).
const selectedResizable = computed(() => !!selectedLocal.value && resizableKind(selectedLocal.value.kind))
// Wired layers join the anchored corner path (aspect-locked, no edge handles):
// the grabbed corner follows the pointer and the opposite corner stays pinned,
// which is the Figma feel. Only kinds with NO box at all (text/line/path) still
// fall back to the uniform-from-centre scale.
const selectedCornerResizable = computed(() => !!selectedLocal.value && cornerResizableKind(selectedLocal.value.kind))
const ALIGN_BTNS = [
  { mode: 'left', icon: AlignStartVertical, title: 'Align left' },
  { mode: 'hcenter', icon: AlignCenterVertical, title: 'Align horizontal centers' },
  { mode: 'right', icon: AlignEndVertical, title: 'Align right' },
  { mode: 'top', icon: AlignStartHorizontal, title: 'Align top' },
  { mode: 'vcenter', icon: AlignCenterHorizontal, title: 'Align vertical centers' },
  { mode: 'bottom', icon: AlignEndHorizontal, title: 'Align bottom' },
  { mode: 'hdist', icon: AlignHorizontalSpaceAround, title: 'Distribute horizontally' },
  { mode: 'vdist', icon: AlignVerticalSpaceAround, title: 'Distribute vertically' },
] as const

// ── Node edit (direct anchor/handle selection) ──────────────────────────────
const nodeEdit = useVectorNodeEdit()
const editDims = () => ({ w: canvasDisplay.w, h: canvasDisplay.h })

async function enterNodeEdit(id: string) {
  const l = localLayers.value.find(x => x.id === id)
  if (!l || l.kind !== 'path') return false
  selectLocal(id)
  return await nodeEdit.enter(l as any, editDims())
}
function exitNodeEdit() { nodeEdit.reset() }

// Outline box for a multi-selected layer (logical coords, rotated about center).
function multiOutlineStyle(l: any) {
  const b = boxPx(l)
  return {
    left: l.x * canvasDisplay.w + 'px', top: l.y * canvasDisplay.h + 'px',
    width: b.w + 'px', height: b.h + 'px',
    transform: `translate(-50%, -50%) rotate(${l.rotation || 0}deg)`,
  }
}

// Boolean ops work on any closed-outline shapes (paths + rect/ellipse/line/
// polygon/star, which get converted to paths). Available when ≥2 are selected.
const BOOLEANABLE = new Set(['path', 'rect', 'ellipse', 'line', 'polygon', 'star'])
const selectedPathCount = computed(() => selectedLayers.value.filter((l: any) => BOOLEANABLE.has(l.kind)).length)
const BOOL_OPS = [
  { op: 'unite', label: 'Unite' }, { op: 'subtract', label: 'Subtract' },
  { op: 'intersect', label: 'Intersect' }, { op: 'exclude', label: 'Exclude' },
] as const
function onNodePointerDown(e: PointerEvent) {
  const p = clientToNorm(e); if (!p) return
  if (nodeEdit.down(p.nx, p.ny)) { e.preventDefault(); e.stopPropagation() }
}
function onNodePointerMove(e: PointerEvent) {
  if (!nodeEdit.hot.value) return
  const p = clientToNorm(e); if (!p) return
  nodeEdit.move(p.nx, p.ny)
}
async function onNodePointerUp() {
  if (!nodeEdit.hot.value) return
  nodeEdit.up()
  await commitNodeEdit()
}
async function commitNodeEdit() {
  const rebuilt = await nodeEdit.buildLayer(editDims())
  if (!rebuilt || !nodeEdit.layerId.value) return
  rebuilt.id = nodeEdit.layerId.value // keep identity → in-place edit + clean undo
  recordHistory()
  // Replace, not setLocal-merge: a merge would resurrect shapeId (and other stale fields) on hand-edited geometry — the rebuilt layer is the whole truth.
  commit(localLayers.value.map(l => (l.id === rebuilt.id ? rebuilt : l)))
}
async function deleteNodeAnchor() {
  nodeEdit.deleteSelected()
  await commitNodeEdit()
}

// ── Pen tool + SVG import ────────────────────────────────────────────────────
const pen = useVectorPen()
const brush = useBrushPaint()
const PEN_STYLE = { fill: '#3b82f6', stroke: '', strokeWidth: 0 }

function clientToNorm(e: PointerEvent | MouseEvent) {
  const r = canvasRect(); if (!r) return null
  return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height }
}
function onPenPointerDown(e: PointerEvent) {
  const p = clientToNorm(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  if (pen.down(p.nx, p.ny) === 'closed') finishPen()
}
function onPenPointerMove(e: PointerEvent) {
  const p = clientToNorm(e); if (!p) return
  pen.move(p.nx, p.ny)
}
function onPenPointerUp() { pen.up() }
function finishPen() {
  const layer = buildPathLayerFromAnchors(
    pen.anchors.value, pen.draftClosed.value,
    { w: canvasDisplay.w, h: canvasDisplay.h }, PEN_STYLE,
  )
  pen.setActive(false)
  if (layer) addPathLayers([layer])
}
function togglePen() { if (smartActive.value) { if (smartActionBusy.value) return; exitSmartMode() }; pen.setActive(!pen.active.value); if (pen.active.value) { selectLocal(null); exitNodeEdit(); brush.setActive(false) } }
// Return to the default Select tool: leave pen/node-edit/generate modes.
function selectTool() {
  if (pen.active.value) pen.setActive(false)
  if (nodeEdit.active.value) exitNodeEdit()
  if (genActive.value) exitGenMode()
}
const isSelectTool = computed(() => !pen.active.value && !nodeEdit.active.value && !genActive.value && !brush.active.value)

/** True when an image layer has an active tint fill (shows blend + opacity). */
function hasTint(l: any): boolean { const t = l?.tint; return !!t && t !== 'none' && t !== '' }

// ── Distort: slant (skew) + corner-pin / perspective ─────────────────────────
const distortTool = ref(false)
function toggleDistort() {
  if (smartActive.value) { if (smartActionBusy.value) return; exitSmartMode() }
  distortTool.value = !distortTool.value
  if (distortTool.value) { pen.setActive(false); exitNodeEdit(); if (genActive.value) exitGenMode(); brush.setActive(false) }
}
// ── Brush: freehand paint tool (mutually exclusive with pen/node/gen/distort) ─
function toggleBrush() {
  if (smartActive.value) { if (smartActionBusy.value) return; exitSmartMode() }
  brush.setActive(!brush.active.value)
  if (brush.active.value) {
    pen.setActive(false); exitNodeEdit(); if (genActive.value) exitGenMode(); distortTool.value = false
    // If a brush layer is already selected, keep it as the paint target so you can
    // KEEP EDITING it (add/erase more strokes). Otherwise start a fresh layer.
    // (You can also retarget while painting by clicking a brush layer in the panel.)
    const sel = selectedLocal.value
    if (sel && sel.kind === 'brush') brushLayerId = sel.id
    // Keep a non-brush layer selected so it can be the Mask-mode target
    // (mask strokes write maskStrokes onto selectedLocal — deselecting here
    // silently broke masking). Paint mode is unaffected: activeBrushLayer()
    // returns null for a non-brush selection, so it still starts a fresh layer.
    else brushLayerId = null
  } else {
    brushLayerId = null
  }
}
function normCp(cp: unknown): CornerPin {
  const c = (cp ?? {}) as any
  const p = (q: any) => ({ x: q?.x || 0, y: q?.y || 0 })
  return { tl: p(c.tl), tr: p(c.tr), br: p(c.br), bl: p(c.bl) }
}
function resetDistort(id: string) { setLocal(id, { cornerPin: undefined, skewX: 0, skewY: 0 } as any) }
/** Perspective slider → a symmetric trapezoid (positive narrows the TOP edge,
 *  negative narrows the BOTTOM), written into cornerPin. */
function setPerspective(id: string, p: number) {
  const top = Math.max(0, p), bot = Math.max(0, -p)
  setLocal(id, { cornerPin: { tl: { x: top, y: 0 }, tr: { x: -top, y: 0 }, bl: { x: -bot, y: 0 }, br: { x: bot, y: 0 } } } as any)
}
function perspectiveAmount(l: any): number {
  const cp = l?.cornerPin; if (!cp) return 0
  const top = ((cp.tl?.x || 0) - (cp.tr?.x || 0)) / 2
  const bot = ((cp.br?.x || 0) - (cp.bl?.x || 0)) / 2
  return top - bot
}
/** The 4 corner-pin handle positions in canvas-display px (box corner + its offset,
 *  rotated/positioned with the layer). Shown only while the Distort tool is active. */
const distortHandlePositions = computed(() => {
  const l = selectedLocal.value as any
  if (!l) return null
  const W = canvasDisplay.w, H = canvasDisplay.h
  const box = boxPx(l)
  const hw = box.w / 2, hh = box.h / 2
  const cx = l.x * W, cy = l.y * H
  const rad = ((l.rotation || 0) * Math.PI) / 180, cosA = Math.cos(rad), sinA = Math.sin(rad)
  const cp = normCp(l.cornerPin)
  const C = (sx: number, sy: number, off: { x: number; y: number }) => {
    const dx = sx * hw + off.x * hw, dy = sy * hh + off.y * hh
    return { x: cx + dx * cosA - dy * sinA, y: cy + dx * sinA + dy * cosA }
  }
  return { tl: C(-1, -1, cp.tl), tr: C(1, -1, cp.tr), br: C(1, 1, cp.br), bl: C(-1, 1, cp.bl) }
})
function onDistortPointerDown(cornerKey: 'tl' | 'tr' | 'br' | 'bl', e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  const l = selectedLocal.value as any; const r = canvasRect()
  if (!l || !r) return
  const W = canvasDisplay.w, H = canvasDisplay.h
  const box = boxPx(l); const hw = box.w / 2, hh = box.h / 2
  const cx = l.x * W, cy = l.y * H
  const rad = ((l.rotation || 0) * Math.PI) / 180, cosA = Math.cos(rad), sinA = Math.sin(rad)
  const baseSx = (cornerKey === 'tl' || cornerKey === 'bl') ? -1 : 1
  const baseSy = (cornerKey === 'tl' || cornerKey === 'tr') ? -1 : 1
  const move = (ev: PointerEvent) => {
    const mx = ((ev.clientX - r.left) / r.width) * W - cx
    const my = ((ev.clientY - r.top) / r.height) * H - cy
    const lx = mx * cosA + my * sinA      // un-rotate into the layer's local box space
    const ly = -mx * sinA + my * cosA
    const offX = hw ? (lx - baseSx * hw) / hw : 0
    const offY = hh ? (ly - baseSy * hh) / hh : 0
    const next = normCp(l.cornerPin)
    next[cornerKey] = { x: offX, y: offY }
    setLocal(l.id, { cornerPin: next } as any)
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}

const svgInputRef = ref<HTMLInputElement | null>(null)
function triggerImportSvg() { svgInputRef.value?.click() }
async function onImportSvgFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]; input.value = ''
  if (!file) return
  try { await addPathFromSvg(await file.text(), { targetWidth: 0.5 }) }
  catch (err) { console.error('[Compositor] SVG import failed:', err) }
}

// ── Drag a file onto the canvas → drop it in as a layer ─────────────────────
// SVGs become editable path layers (placed at the drop point); raster images
// become image layers. Highlight the artboard while a file hovers over it.
const dropActive = ref(false)
function isFileDrag(e: DragEvent) {
  return Array.from(e.dataTransfer?.types || []).includes('Files')
}
function onCanvasDragOver(e: DragEvent) {
  if (!isFileDrag(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dropActive.value = true
}
function onCanvasDragLeave(e: DragEvent) {
  const ct = e.currentTarget as Node | null
  if (ct && e.relatedTarget instanceof Node && ct.contains(e.relatedTarget)) return // moved to a child
  dropActive.value = false
}
async function onCanvasDrop(e: DragEvent) {
  dropActive.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  e.preventDefault()
  // Map the drop point onto the artboard (normalized, clamped so it stays visible).
  const r = canvasRect()
  const cx = r ? Math.min(0.92, Math.max(0.08, (e.clientX - r.left) / r.width)) : 0.5
  const cy = r ? Math.min(0.92, Math.max(0.08, (e.clientY - r.top) / r.height)) : 0.5
  for (const file of files) {
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
    try {
      if (isSvg) await addPathFromSvg(await file.text(), { targetWidth: 0.5, cx, cy })
      else if (file.type.startsWith('image/')) await addImageFromFile(file)
    } catch (err) { console.error('[Compositor] drop import failed:', err) }
  }
}

// ── AI vector: text→SVG generate + raster→SVG vectorize ─────────────────────
const aiOpen = ref(false)
const aiPrompt = ref('')
const aiStyle = ref<'any' | 'line_art' | 'engraving' | 'linocut'>('any')
const aiBusy = ref(false)
const aiError = ref('')

// URL of the currently-selected image to vectorize (local image layer or wired).
const vectorizableUrl = computed<string | null>(() => {
  const l = selectedLocal.value
  if (l && l.kind === 'image') return imageLayerUrl(l.filename)
  // A wired layer is an ordinary selection now; its pixels still come from the
  // slot, so resolve the URL through this modal's 1-based slot numbering.
  if (l && l.kind === 'wired') {
    const w = layers.value.find((x: any) => x.slot === (l as any).slot + 1)
    if (w?.url) return w.url as string
  }
  return null
})

async function runGenerate() {
  const prompt = aiPrompt.value.trim()
  if (!prompt || aiBusy.value) return
  aiBusy.value = true; aiError.value = ''
  try {
    const svg = await generateVectorFromText(prompt, { style: aiStyle.value })
    await addPathFromSvg(svg, { targetWidth: 0.7 })
    aiPrompt.value = ''
  } catch (err: any) {
    aiError.value = err?.data?.message || err?.message || 'Generation failed'
  } finally { aiBusy.value = false }
}

async function runVectorize(backend: 'local' | 'recraft') {
  const url = vectorizableUrl.value
  if (!url || aiBusy.value) return
  aiBusy.value = true; aiError.value = ''
  try {
    // Recraft needs a data URL it can ingest; local can fetch the URL itself.
    const image = backend === 'recraft' ? await urlToDataUrl(url) : url
    const svg = await vectorizeImage(image, { backend })
    await addPathFromSvg(svg, { targetWidth: 0.8 })
  } catch (err: any) {
    aiError.value = err?.data?.message || err?.message || 'Vectorize failed'
  } finally { aiBusy.value = false }
}

// Esc cancels an in-progress pen draft (before it bubbles to modal-close).
function onKeydown(e: KeyboardEvent) {
  // Keyboard nudge/duplicate on the current selection — deferred first so it
  // doesn't fire while typing in a field or text-editing a layer.
  const t = e.target as HTMLElement | null
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  // The shape-library picker (toolbar face or inspector) owns the keyboard while
  // open — it has its own arrow-key grid nav and Escape handling, so the editor
  // must not also nudge the selection, toggle tools, or start a space-hold pan.
  const shapePickerOpen = libraryPickerOpen.value || inspectorShapePickerOpen.value
  if (shapePickerOpen) return
  if (!typing && !editingId.value && handleEditorKey(e)) return
  if (e.key === 'Escape' && pen.active.value) { e.stopPropagation(); pen.setActive(false); return }
  if (e.key === 'Enter' && pen.active.value && pen.anchors.value.length >= 2) { e.preventDefault(); finishPen(); return }
  // V → Select tool (when not typing in a field).
  if ((e.key === 'v' || e.key === 'V') && !e.metaKey && !e.ctrlKey && !editingId.value) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') { selectTool(); return }
  }
  // B → toggle the freehand Brush tool (when not typing in a field).
  if ((e.key === 'b' || e.key === 'B') && !e.metaKey && !e.ctrlKey && !editingId.value) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') { toggleBrush(); return }
  }
  // Node edit: Esc/Enter exit, Delete removes the selected anchor.
  if (nodeEdit.active.value) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); exitNodeEdit(); return }
    if ((e.key === 'Delete' || e.key === 'Backspace') && nodeEdit.selected.value != null && !editingId.value) {
      e.preventDefault(); deleteNodeAnchor(); return
    }
  }
  const tag = (e.target as HTMLElement)?.tagName
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!editingId.value
  // Space → hold-to-pan. Prevent the default page scroll while held.
  if (e.code === 'Space' && !inField) { e.preventDefault(); spaceDown.value = true }
  // ⌘\ hides/shows both glass panels. Unlike the zoom combos it is allowed while
  // typing: backslash means nothing to a text field, and a user who has just
  // hidden the chrome and clicked into the prompt must still be able to bring it
  // back without reaching for the mouse.
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); togglePanels(); return }
  // Zoom shortcuts: ⌘/Ctrl +, −, 0 (fit) and 2 (zoom to selection).
  if ((e.metaKey || e.ctrlKey) && !inField) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.2); return }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.2); return }
    if (e.key === '0') { e.preventDefault(); zoomFit(); return }
    if (e.key === '2') { e.preventDefault(); zoomToSelection(); return }
  }
  // Undo/redo — skip while editing text so the textarea handles it natively.
  const meta = e.metaKey || e.ctrlKey
  if (meta && (e.key === 'z' || e.key === 'Z') && !editingId.value) {
    e.preventDefault(); e.stopPropagation()
    if (e.shiftKey) redo(); else undo()
  } else if (meta && (e.key === 'g' || e.key === 'G') && !editingId.value) {
    e.preventDefault(); e.stopPropagation()
    if (e.shiftKey) ungroupSelected(); else groupSelected()
  }
}
function onKeyup(e: KeyboardEvent) { if (e.code === 'Space') spaceDown.value = false }
// If focus leaves the window while Space is held (alt/⌘-tab, clicking into the
// cross-origin ComfyUI iframe, tab switch), the keyup lands elsewhere and
// spaceDown would stay stuck true — freezing layer select/move behind pan mode.
// Reset the whole pan gesture on blur / visibility loss.
function clearPan() {
  spaceDown.value = false; panning.value = false; panFrom = null
  if (viewMoveTimer) { clearTimeout(viewMoveTimer); viewMoveTimer = null }
  viewMoving.value = false
}
function onVisibility() { if (document.hidden) clearPan() }
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('blur', clearPan)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('keyup', onKeyup, true)
  window.removeEventListener('blur', clearPan)
  document.removeEventListener('visibilitychange', onVisibility)
})

// ── Selection ───────────────────────────────────────────────────────────────
// There is only ONE selection now. A wired slot is a layer, so it selects into
// `selectedIds` like any other and the old parallel `selectedSlot` ref is gone —
// with it the whole "image slot OR local layer, mutually exclusive" dance.
// Any selection change invalidates the live brush-mask canvas — it's seeded
// per-slot from that slot's maskUrl and must not be reused stale.
watch(selectedLocalId, () => { wiredBrushMask = null })
// Leaving Brush entirely, or flipping to Paint mode, also drops the live mask
// canvas so re-entering Mask mode re-seeds it from the persisted maskUrl.
watch(brush.active, (on) => { if (!on) wiredBrushMask = null })
watch(brush.mode, (m) => { if (m === 'paint') wiredBrushMask = null })

// ── Unified z-order stack (mirrors ArtifactFrameNode's model) ───────────────
// Keys: `w:<slot>` for a wired image, `l:<id>` for a local layer. Persisted on
// the node as `sailor_stackOrder`; array order is bottom→top. This is the
// single source of truth for depth — any layer can sit above or below any other.
type StackKey = string
function wiredKey(slot: number): StackKey { return `w:${slot}` }
function localKey(id: string): StackKey { return `l:${id}` }

// A migrated slot is a LAYER: it contributes `l:<id>` and NOT also its legacy
// `w:` key. Emitting both gives one layer two depths in the stack (and, on the
// submit path, bakes it a second time as if it were a local overlay). Slots no
// layer has claimed still emit `w:`, so a pre-schema-2 frame is unchanged.
// `framePresentKeys` takes 0-based slots; this modal's `Layer.slot` is 1-based.
const presentKeys = computed<StackKey[]>(() =>
  framePresentKeys(layers.value.map(l => l.slot - 1), localLayers.value))
const stackKeys = computed<StackKey[]>(() => {
  const saved = ((compositor.value?.data?.properties as any)?.sailor_stackOrder as StackKey[]) ?? []
  const present = new Set(presentKeys.value)
  const kept = saved.filter((k: string) => present.has(k))
  const keptSet = new Set(kept)
  return [...kept, ...presentKeys.value.filter(k => !keptSet.has(k))]
})
function moveStackZ(key: StackKey, dir: -1 | 1) {
  const arr = [...stackKeys.value]
  const i = arr.findIndex(k => k === key)
  const j = i + dir
  if (i < 0 || j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  const node = compositor.value
  if (!node) return
  if (!node.data.properties) node.data.properties = {}
  ;(node.data.properties as any).sailor_stackOrder = arr
}
function resolveStackKey(key: StackKey): { type: 'wired'; layer: Layer } | { type: 'local'; layer: any } | null {
  if (key.startsWith('w:')) {
    const slot = Number(key.slice(2))
    const layer = layers.value.find(l => l.slot === slot)
    return layer ? { type: 'wired', layer } : null
  }
  const id = key.slice(2)
  const layer = localLayers.value.find((l: any) => l.id === id)
  return layer ? { type: 'local', layer } : null
}
const selectedStackKey = computed<StackKey | null>(() => {
  if (selectedLocalId.value) return localKey(selectedLocalId.value)
  return null
})
// Pre-resolved stack for the sidebar list (top-first).
const resolvedStack = computed(() =>
  [...stackKeys.value].reverse().map(key => {
    const r = resolveStackKey(key)
    return r ? { key, ...r } : null
  }).filter(Boolean) as { key: StackKey; type: 'wired' | 'local'; layer: any }[],
)

// ── Nested layer tree (panel) ────────────────────────────────────────────────
// Local layers keep a flat immediate `groupId`; nesting comes from the group
// registry (parentId). The panel walks the tree recursively; rendering itself is
// always a flat z-ordered stack, so this is purely an organization view.

// Stack index per key (resolvedStack is top-first) → orders tree siblings so a
// group sits where its topmost member sits.
const stackIndexByKey = computed(() => {
  const m = new Map<string, number>()
  resolvedStack.value.forEach((it, i) => m.set(it.key, i))
  return m
})
const localItemById = computed(() => {
  const m = new Map<string, any>()
  for (const it of resolvedStack.value) if (it.type === 'local') m.set(it.layer.id, it)
  return m
})
function groupCount(gid: string): number { return layersInGroup(gid, localLayers.value, localGroups.value).length }
function groupSortIndex(gid: string): number {
  let min = Infinity
  for (const id of layersInGroup(gid, localLayers.value, localGroups.value)) {
    const it = localItemById.value.get(id)
    if (it) min = Math.min(min, stackIndexByKey.value.get(it.key) ?? Infinity)
  }
  return min
}

const expandedGroups = ref<Set<string>>(new Set())
function toggleGroup(gid: string) {
  const s = new Set(expandedGroups.value)
  s.has(gid) ? s.delete(gid) : s.add(gid)
  expandedGroups.value = s
}
function selectGroup(gid: string) { selectGroupById(gid) }
function deleteGroup(gid: string) { deleteLayers(layersInGroup(gid, localLayers.value, localGroups.value)) }
function isGroupSelected(gid: string) { return layersInGroup(gid, localLayers.value, localGroups.value).some(id => selectedIds.value.has(id)) }
function groupLabel(gid: string) { return groupDisplayName(gid, localLayers.value, localGroups.value) }

// Group rename (double-click the group label).
const editingGroupId = ref<string | null>(null)
const groupNameDraft = ref('')
function startGroupRename(gid: string) { editingGroupId.value = gid; const n = groupLabel(gid); groupNameDraft.value = n === 'Group' ? '' : n }
function commitGroupRename() {
  if (editingGroupId.value) renameGroup(editingGroupId.value, groupNameDraft.value)
  editingGroupId.value = null
}

// Flat, depth-tagged rows from a recursive walk of the group tree. A group's
// header is immediately followed by its whole subtree (contiguous block), which
// the drag code relies on. `depth` drives indentation.
type FlatRow =
  | { rk: string; kind: 'group'; groupId: string; depth: number; count: number }
  | { rk: string; kind: 'child' | 'local'; key: StackKey; layerId: string; groupId?: string; depth: number; layer: any }
  | { rk: string; kind: 'wired'; key: StackKey; slot: number; depth: number; layer: any }
const flatRows = computed<FlatRow[]>(() => {
  const rows: FlatRow[] = []
  const groups = localGroups.value
  const si = stackIndexByKey.value
  type Sortable = { kind: 'group'; id: string; sort: number } | { kind: 'item'; item: any; sort: number }

  const emitGroup = (gid: string, depth: number) => {
    rows.push({ rk: 'gh:' + gid, kind: 'group', groupId: gid, depth, count: groupCount(gid) })
    if (!expandedGroups.value.has(gid)) return
    const kids: Sortable[] = []
    for (const cg of childGroupIds(gid, groups)) if (groupCount(cg) > 0) kids.push({ kind: 'group', id: cg, sort: groupSortIndex(cg) })
    for (const it of resolvedStack.value) {
      if (it.type === 'local' && it.layer.groupId === gid) kids.push({ kind: 'item', item: it, sort: si.get(it.key) ?? Infinity })
    }
    kids.sort((a, b) => a.sort - b.sort)
    for (const k of kids) {
      if (k.kind === 'group') emitGroup(k.id, depth + 1)
      else rows.push({ rk: k.item.key, kind: 'child', key: k.item.key, layerId: k.item.layer.id, groupId: gid, depth: depth + 1, layer: k.item.layer })
    }
  }

  // Top level: root groups (holding ≥1 layer) + ungrouped locals + wired.
  const tops: Sortable[] = []
  for (const gid of allGroupIds(localLayers.value, groups)) {
    const p = groups.find(g => g.id === gid)?.parentId
    const isRoot = !p || !groups.some(g => g.id === p)
    if (isRoot && groupCount(gid) > 0) tops.push({ kind: 'group', id: gid, sort: groupSortIndex(gid) })
  }
  for (const it of resolvedStack.value) {
    if (it.type === 'local' && it.layer.groupId) continue // rendered under its group
    tops.push({ kind: 'item', item: it, sort: si.get(it.key) ?? Infinity })
  }
  tops.sort((a, b) => a.sort - b.sort)
  for (const t of tops) {
    if (t.kind === 'group') emitGroup(t.id, 0)
    else if (t.item.type === 'local') rows.push({ rk: t.item.key, kind: 'local', key: t.item.key, layerId: t.item.layer.id, depth: 0, layer: t.item.layer })
    else rows.push({ rk: t.item.key, kind: 'wired', key: t.item.key, slot: t.item.layer.slot, depth: 0, layer: t.item.layer })
  }
  return rows
})
function rowSelected(row: any) {
  if (row.kind === 'group') return isGroupSelected(row.groupId)
  // A `wired` ROW is now only ever a legacy, unmigrated slot (a schema-2 slot is
  // a layer and renders as a `local` row). Those have no selection state left.
  if (row.kind === 'wired') return false
  // While the Save-as-template sheet is open, the panel shows slot picks
  // instead of the normal selection (see `onRowClick`).
  if (savingTemplate.value) return isSlotPicked(row.layerId)
  return selectedIds.value.has(row.layerId)
}
function onRowClick(row: any) {
  // Save-as-template sheet open: tapping a real layer marks/unmarks it as a
  // slot instead of selecting it (kind/label are edited in the sheet).
  if (savingTemplate.value && (row.kind === 'local' || row.kind === 'child')) { toggleSlotPick(row.layerId); return }
  if (row.kind === 'group') selectGroup(row.groupId)
  else if (row.kind === 'wired') { /* legacy unmigrated slot — nothing to select */ }
  else selectLocal(row.layerId)
}
function onRowDblClick(row: any) {
  if ((row.kind === 'local' || row.kind === 'child') && row.layer.kind === 'text') beginEdit(row.layerId)
}
function rowLabel(row: any) {
  const l = row.layer
  if (l.name) return l.name
  // A wired layer's honest default name is its slot — "wired" tells you nothing
  // about WHICH input it is.
  if (l.kind === 'wired') return `Layer ${l.slot + 1}`
  return l.kind === 'text' ? (l.text?.split('\n')[0] || 'Text') : l.kind
}
/** The 1-BASED modal slot a row's wired content lives on, or null when the row is
 *  not wired. Covers BOTH shapes: a schema-2 wired layer arrives as a `local`
 *  row (its `layer.kind` is 'wired'), a pre-migration slot as a `wired` row.
 *  Panel affordances that act on the slot (Copy into frame) gate on this rather
 *  than on `row.kind`, which after unification stopped being the whole story. */
function rowWiredSlot1(row: any): number | null {
  if (row?.kind === 'wired') return row.slot as number
  if (row?.layer?.kind === 'wired') return (row.layer.slot as number) + 1
  return null
}
// Row icon → live image preview when the layer resolves to a still image.
// Wired live sources (streams) and non-image locals fall through to their icon.
function rowThumbUrl(row: any): string | null {
  if (row.kind === 'wired') return row.layer?.live ? null : ((row.layer?.url as string) || null)
  // A migrated wired slot is a `local` row now, but its thumbnail still comes
  // from the slot feeding it — losing it would make the layer list less legible
  // than before unification.
  if (row.layer?.kind === 'wired') {
    const w = layers.value.find(x => x.slot === row.layer.slot + 1)
    return w && !w.live ? (w.url || null) : null
  }
  if ((row.kind === 'local' || row.kind === 'child') && row.layer?.kind === 'image' && row.layer?.filename) {
    return imageLayerUrl(row.layer.filename)
  }
  return null
}
// Layer-row thumbnails: see the `renderLayerThumbnail` scheduler further down
// (defined after `wiredImageEls` / `wiredContentInfo0`, which its content
// signature reads). `rowThumb(row)` there feeds the template.

// ── Drag-and-drop reorder (unified z-order + group membership / nesting) ──────
function setStackOrder(topFirstKeys: StackKey[]) {
  const node = compositor.value; if (!node) return
  if (!node.data.properties) node.data.properties = {}
  ;(node.data.properties as any).sailor_stackOrder = [...topFirstKeys].reverse() // stored bottom→top
}
const dragRk = ref<string | null>(null)
const dropIndex = ref<number | null>(null)   // flat insertion index 0..flatRows.length
function onGripDragStart(rk: string, e: DragEvent) {
  dragRk.value = rk
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', rk) }
}
function onRowDragOver(idx: number, e: DragEvent) {
  if (dragRk.value == null) return
  e.preventDefault()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropIndex.value = idx + (e.clientY > r.top + r.height / 2 ? 1 : 0)
}
function onListDrop() {
  if (dragRk.value != null && dropIndex.value != null) applyReorder(dragRk.value, dropIndex.value)
  dragRk.value = null; dropIndex.value = null
}
function onDragEnd() { dragRk.value = null; dropIndex.value = null }

// The immediate group a drop just below `above` targets, or undefined for loose.
function dropTargetGroup(above: any): string | undefined {
  if (!above) return undefined
  if (above.kind === 'child') return above.groupId
  if (above.kind === 'group' && expandedGroups.value.has(above.groupId)) return above.groupId
  return undefined
}

function applyReorder(rk: string, dropFi: number) {
  const rows = flatRows.value
  const start = rows.findIndex(r => r.rk === rk)
  if (start < 0) return
  const dragRow: any = rows[start]

  // ── Whole-group drag → move its contiguous subtree block + re-nest it ──────
  if (dragRow.kind === 'group') {
    const gid = dragRow.groupId
    let end = start + 1
    while (end < rows.length && (rows[end] as any).depth > dragRow.depth) end++
    const block = rows.slice(start, end)
    const blockKeys = block.filter((r: any) => r.kind !== 'group').map((r: any) => r.key as string)
    const blockRks = new Set(block.map(r => r.rk))
    // Target parent from the first row above the gap that isn't part of the block.
    let ai = dropFi - 1
    while (ai >= 0 && blockRks.has(rows[ai]!.rk)) ai--
    const newParent = dropTargetGroup(rows[ai])
    if (newParent && isDescendantOrSelf(newParent, gid, localGroups.value)) return // no cycles
    recordHistory()
    writeGroups(reparentGroupOp(localGroups.value, gid, newParent))
    // Reorder z-keys: pull the block out, reinsert at the drop position.
    const allKeys = rows.filter(r => r.kind !== 'group').map((r: any) => r.key as string)
    const blockSet = new Set(blockKeys)
    const remaining = allKeys.filter(k => !blockSet.has(k))
    let ki = 0
    for (let i = 0; i < dropFi && i < rows.length; i++) {
      const r: any = rows[i]
      if (r.kind !== 'group' && !blockSet.has(r.key)) ki++
    }
    ki = Math.max(0, Math.min(remaining.length, ki))
    remaining.splice(ki, 0, ...blockKeys)
    setStackOrder(remaining)
    return
  }

  // ── Single layer / image drag → move one key + (re)assign group membership ──
  const dragKey = dragRow.key as string
  const isWired = dragRow.kind === 'wired'
  const targetGroup = isWired ? undefined : dropTargetGroup(rows[dropFi - 1])
  recordHistory()
  const curKeys = rows.filter(r => r.kind !== 'group').map((r: any) => r.key as string)
  let ki = 0
  for (let i = 0; i < dropFi && i < rows.length; i++) if (rows[i].kind !== 'group') ki++
  const curPos = curKeys.indexOf(dragKey)
  const without = curKeys.filter(k => k !== dragKey)
  let insertAt = (curPos > -1 && curPos < ki) ? ki - 1 : ki
  insertAt = Math.max(0, Math.min(without.length, insertAt))
  without.splice(insertAt, 0, dragKey)
  if (!isWired) {
    commit(localLayers.value.map((l: any) => (l.id === dragRow.layerId ? { ...l, groupId: targetGroup } : l)))
  }
  setStackOrder(without)
}

// Shared corner/rotation-handle geometry for a rotated box centered at (cx, cy).
function boxHandles(cx: number, cy: number, hw: number, hh: number, rotationDeg: number, scale = 1) {
  const rad = (rotationDeg * Math.PI) / 180
  const cosA = Math.cos(rad), sinA = Math.sin(rad)
  const transform = (dx: number, dy: number) => ({ x: cx + dx * cosA - dy * sinA, y: cy + dx * sinA + dy * cosA })
  return {
    tl: transform(-hw, -hh), tr: transform(hw, -hh), br: transform(hw, hh), bl: transform(-hw, hh),
    rot: transform(0, -hh - 30 / Math.max(scale, 0.1)), topCenter: transform(0, -hh), center: { x: cx, y: cy },
  }
}
// Wired layers select, move, scale and rotate through the SAME handles as every
// other layer now (`useLocalLayerEditor`), so the amber handle set and its
// uniform-from-centre `onScalePointerDown` are gone. Corner resize on a wired
// layer is the editor's aspect-locked corner scale — the text/line behaviour, not
// the free 2D rect resize, because a wired layer has no independent height (its
// height follows the live content aspect; see `resizableKind`).

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

// ── Canvas pointer routing ──────────────────────────────────────────────────
// Pixel/alpha test: render JUST this layer to a reusable offscreen and check
// whether the click lands on an opaque pixel (sampling a small neighbourhood so
// thin strokes/lines stay easy to grab). This is what makes the bbox hit accurate:
// a layer's TRANSPARENT areas (the gaps in/around text glyphs, an unfilled shape)
// no longer capture clicks meant for a visible layer below. A tainted canvas
// (cross-origin wired image) can't be read → treat as a hit (falls back to bbox).
let _hitCanvas: HTMLCanvasElement | null = null
function layerHitAt(res: { type: 'local'; layer: any }, px: number, py: number, W: number, H: number): boolean {
  const x = Math.round(px), y = Math.round(py)
  if (x < 0 || y < 0 || x >= W || y >= H) return false
  // An unlinked (edge cut) wired layer paints NO pixels but keeps its box from
  // `lastAspect` — so it takes the same bbox fallback the tainted-canvas case
  // takes, and stays grabbable on canvas instead of becoming click-through.
  // Gated on the LAYER's `unlinked` flag, not on "no content this instant": a
  // connected slot whose image is still decoding would otherwise swallow every
  // click across its whole bounding box, including the transparent parts.
  if (res.layer?.kind === 'wired' && res.layer.unlinked) return true
  if (!_hitCanvas) _hitCanvas = document.createElement('canvas')
  const c = _hitCanvas
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H }
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return true
  ctx.clearRect(0, 0, W, H)
  try {
    // Only LOCAL items reach here — `hitTopStackKey` skips legacy `w:` rows, which
    // have no selection state any more. A migrated wired layer arrives as a local
    // item and needs this frame's slot resolver installed, or it would draw
    // nothing and every click would fall through to whatever is underneath.
    withWiredContent(wiredContentForSlot, () => drawLocalLayer(ctx, res.layer as LocalLayer, W, H))
  } catch { return true }
  try {
    const R = 2
    const sx = Math.max(0, x - R), sy = Math.max(0, y - R)
    const sw = Math.min(W - sx, R * 2 + 1), sh = Math.min(H - sy, R * 2 + 1)
    const data = ctx.getImageData(sx, sy, sw, sh).data
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 8) return true
    return false
  } catch { return true }  // tainted → fall back to the bbox hit
}

// Unified, z-aware, PIXEL-ACCURATE hit test: walk the stack top→bottom and return
// the key of the first layer whose rotated box contains the point AND that paints
// an opaque pixel there. The box is a cheap pre-filter; the alpha test is what stops
// a big transparent text bbox from grabbing clicks on the image showing through it.
function hitTopStackKey(clientX: number, clientY: number): StackKey | null {
  const r = canvasRect(); if (!r) return null
  const W = canvasDisplay.w, H = canvasDisplay.h
  const px = ((clientX - r.left) / r.width) * W
  const py = ((clientY - r.top) / r.height) * H
  const inBox = (cx: number, cy: number, hw: number, hh: number, rotDeg: number) => {
    const rad = (-rotDeg * Math.PI) / 180
    const dx = px - cx, dy = py - cy
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
    return Math.abs(lx) <= hw && Math.abs(ly) <= hh
  }
  const keys = stackKeys.value
  for (let i = keys.length - 1; i >= 0; i--) {        // top → bottom
    const k = keys[i]; if (!k) continue
    const res = resolveStackKey(k); if (!res) continue
    // Hidden or locked layers are transparent to canvas hits (Figma behavior:
    // the layers panel can still select a locked layer, the canvas can't).
    // A `wired` item here is a legacy unmigrated slot: it has no selection state
    // any more, so it is transparent to hits rather than swallowing clicks meant
    // for the layers below it.
    if (res.type === 'wired') continue
    {
      const l = res.layer
      if (l.visible === false || l.locked) continue
      const b = boxPx(l)
      if (!inBox(l.x * W, l.y * H, b.w / 2 + 8, b.h / 2 + 8, l.rotation)) continue
    }
    if (layerHitAt(res, px, py, W, H)) return k
  }
  return null
}

function onCanvasPointerDownCapture(e: PointerEvent) {
  // The generated-object mini toolbar lives inside the canvas — let its buttons
  // receive the click instead of starting a region draw / deselecting.
  if ((e.target as HTMLElement)?.closest?.('[data-gen-bar]')) return
  if ((e.target as HTMLElement)?.closest?.('[data-smart-bar]')) return
  if (smartActive.value) { onSmartPointerDown(e); return } // smart select owns the canvas
  // Generate mode: brush/box paint the region; shape mode falls through so a
  // shape can still be selected (then promoted via "Use shape").
  if (genActive.value && (genTool.value === 'brush' || genTool.value === 'box')) { onGenPointerDown(e); return }
  if (brush.active.value) { onBrushPointerDown(e); return } // brush mode owns the canvas
  if (pen.active.value) { onPenPointerDown(e); return } // pen mode owns the canvas
  if (nodeEdit.active.value) { onNodePointerDown(e); return } // node edit owns the canvas
  if (drawSectionActive.value) {
    // Draw-section mode owns the canvas: ALWAYS starts a fresh marquee (never a
    // layer hit/move), so selection is untouched while the mode is on — see
    // `finishDrawSection`, the separate branch that turns the drag into a rect.
    // `lastDownHitLayer = true` stops the trailing `click` from deselecting the
    // rect `finishDrawSection` just selected (same guard the layer-hit path uses).
    lastDownHitLayer = true
    const p = clientToNorm(e)
    if (p) startMarquee(p.nx, p.ny)
    return
  }
  if ((e.target as HTMLElement)?.closest?.('[data-handle]')) return // a handle's own drag
  const key = hitTopStackKey(e.clientX, e.clientY)
  const res = key ? resolveStackKey(key) : null
  if (res?.type === 'local') {
    lastDownHitLayer = true
    onCanvasPointerDown(e, res.layer.id) // select the EXACT layer the pixel-accurate hit found (not the editor's bbox re-test)
  } else {
    // Empty space → begin a marquee (rubber-band) selection.
    lastDownHitLayer = false
    if (!e.shiftKey) selectLocal(null)
    const p = clientToNorm(e)
    if (p) startMarquee(p.nx, p.ny)
  }
}
function onCanvasPointerMoveCapture(e: PointerEvent) {
  if (smartActive.value) { onSmartPointerMove(e); return }
  if (genActive.value) {
    if (genTool.value === 'brush') { const p = genPointFromEvent(e); if (p) { genCursor.x = p.x; genCursor.y = p.y; genCursor.on = true } }
    if (genDraw.value) { onGenPointerMove(e); return }
    if (genTool.value === 'brush' || genTool.value === 'box') return
  }
  if (brush.active.value) { onBrushPointerMove(e); return }
  if (pen.active.value) onPenPointerMove(e)
  else if (nodeEdit.active.value) onNodePointerMove(e)
  else if (drawSectionActive.value) { if (marquee.value) { const p = clientToNorm(e); if (p) moveMarquee(p.nx, p.ny) } }
  else if (marquee.value) { const p = clientToNorm(e); if (p) moveMarquee(p.nx, p.ny) }
}
function onCanvasPointerUpCapture(e: PointerEvent) {
  if (smartActive.value) { void onSmartPointerUp(e); return }
  if (genActive.value && genDraw.value) { onGenPointerUp(e); return }
  if (brush.active.value) { void onBrushPointerUp(); return }
  if (pen.active.value) onPenPointerUp()
  else if (nodeEdit.active.value) onNodePointerUp()
  else if (drawSectionActive.value) { if (marquee.value) finishDrawSection() }
  else if (marquee.value) endMarquee(e.shiftKey)
}
function onCanvasDblClickCapture(e: MouseEvent) {
  // Double-click a path → enter node edit; otherwise fall back to text edit.
  if (!pen.active.value && !nodeEdit.active.value) {
    const id = hitTopStackKey(e.clientX, e.clientY)
    const res = id ? resolveStackKey(id) : null
    if (res?.type === 'local' && res.layer.kind === 'path') {
      e.preventDefault(); e.stopPropagation(); enterNodeEdit(res.layer.id); return
    }
    onCanvasDblClick(e, res?.type === 'local' ? res.layer.id : null)
    return
  }
  onCanvasDblClick(e)
}
// Set in onCanvasPointerDownCapture: was the just-completed press on a layer?
// Local shapes are painted on a pointer-events-none canvas, so the trailing
// `click` targets the artboard div — without this guard it would deselect the
// shape we just selected on pointer-down.
let lastDownHitLayer = false
function onCanvasClick(e: MouseEvent) {
  if (brush.active.value) return // brush owns the canvas
  if (smartActive.value) return // smart select owns the canvas
  if (genActive.value && genTool.value !== 'shape') return // region-paint owns the canvas
  if (lastDownHitLayer) { lastDownHitLayer = false; return }
  if (e.target === canvasRef.value) selectLocal(null)
}
// Click in the empty stage gutter (outside the artboard) → deselect. A pan that
// ends on the gutter also fires a click here, so swallow it.
function onStageBackgroundClick(e: MouseEvent) {
  closeToolbarMenus()          // click-away for the toolbar's flyouts
  if (brush.active.value) return // brush owns the canvas
  if (smartActive.value) return // smart select owns the canvas
  if (genActive.value && genTool.value !== 'shape') return
  if (didPan) { didPan = false; return }
  if (e.target === stageBoxRef.value || e.target === stageWrapRef.value) selectLocal(null)
}

// ── Text editing: focus the inline textarea when editing starts ─────────────
// The "when" lives in the editor's focus contract (shared with the Frame card),
// so Add text, double-click and the layers panel all behave the same; the host
// only says WHICH element.
const editRef = ref<HTMLTextAreaElement | null>(null)
editor.registerEditFocus(() => editRef.value)
const editingStyle = computed(() => {
  const l = editingLayer.value
  if (!l) return {}
  const box = boxPx(l)
  return {
    left: l.x * canvasDisplay.w + 'px', top: l.y * canvasDisplay.h + 'px',
    width: Math.max(box.w + 8, 40) + 'px', height: Math.max(box.h + 6, 24) + 'px',
    transform: `translate(-50%, -50%) rotate(${l.rotation}deg)`,
    fontFamily: /\s/.test(l.fontFamily) ? `"${l.fontFamily}", sans-serif` : `${l.fontFamily}, sans-serif`,
    fontWeight: String(l.fontWeight), fontSize: l.fontSize * canvasDisplay.w + 'px',
    lineHeight: String(l.lineHeight), color: paintPrimaryColor(l.color, '#ffffff'), textAlign: l.align as any,
    letterSpacing: `${l.letterSpacing || 0}em`,
    textTransform: (l.textTransform || 'none') as any,
    textDecoration: [l.underline && 'underline', l.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none',
    opacity: String(l.opacity), caretColor: paintPrimaryColor(l.color, '#ffffff'),
  }
})

// ── Unified stack canvas (wired + local layers in z-order → WYSIWYG) ────────
// One canvas draws everything interleaved by the unified stackKeys, so a local
// shape can sit below a wired image. Wired drawing uses the shared
// `drawWiredImageLayer` so the node and modal render pixel-identically.
const wiredImageEls = ref<Record<number, HTMLImageElement | HTMLCanvasElement>>({})
// Decode each non-live slot's image OURSELVES rather than depending on an <img>
// in the template firing `@load`. That listener is attached during hydration, so a
// server-rendered host can miss the event entirely and end up with no dims at all
// — which leaves every wired layer stuck as an unresolved sentinel: no box, no
// pixels, no error. The Frame card has always decoded explicitly; this is the same
// thing, and it takes the render path off the DOM.
watch(() => layers.value.filter(l => !l.live).map(l => `${l.slot}:${l.url}`).join('|'), () => {
  if (typeof window === 'undefined') return   // no decoding on the server
  for (const l of layers.value) {
    if (l.live || !l.url) continue
    const cur = wiredImageEls.value[l.slot] as HTMLImageElement | undefined
    if (cur?.dataset?.url === l.url) continue
    const im = new Image()
    im.onload = () => { im.dataset.url = l.url; setWiredImage(l.slot, im); renderStack() }
    im.src = l.url
  }
}, { immediate: true })
// A live studio slot has no <img> to @load — pull its frame at normalized time t01 and
// COPY it into a canvas we OWN (the source reuses its buffer). The owned canvas is created
// once per slot and drawn into in place, so per-frame animation doesn't churn the reactive
// map (only first pull / size change reassigns it; the loop calls renderStack itself).
async function pullLiveFrameModal(l: Layer, t01: number) {
  const src = l.live!
  const w = Math.max(1, src.width || 1024), h = Math.max(1, src.height || 1024)
  try {
    const surface = await src.getFrame(t01, w, h)
    let cv = wiredImageEls.value[l.slot]
    if (!(cv instanceof HTMLCanvasElement) || cv.width !== w || cv.height !== h) {
      cv = document.createElement('canvas'); cv.width = w; cv.height = h
      naturalDims.value = { ...naturalDims.value, [l.slot]: { w, h } }
      wiredImageEls.value = { ...wiredImageEls.value, [l.slot]: cv }
    }
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)   // transparent studios (e.g. Type Studio) would otherwise stack frames
    ctx.drawImage(surface as CanvasImageSource, 0, 0, w, h)
  } catch (e) { console.warn('[Compositor] live slot pull failed for slot', l.slot, e) }
}
// Initial / still pull, re-run on wiring + frameSourceEpoch so a late-registering studio appears.
watch(() => layers.value.map(l => l.live ? `L${l.slot}` : l.url).join('|') + '|' + frameSourceEpoch.value, () => {
  for (const l of layers.value) if (l.live) void pullLiveFrameModal(l, 0)
}, { immediate: true })

// ── Live animation loop (mirrors the Frame node card) ────────────────────────
// `previewT` is declared here (hoisted above its natural "Motion preview" section
// below) because `needsWallClock`'s computed reads it, and a plain `watch(computed, ...)`
// dereferences its source synchronously at setup time — a later `const previewT` would
// throw a TDZ ReferenceError (same trap documented on the Frame node card for
// `wiredTreatments`).
const previewT = ref<number | null>(null)
const MAX_LIVE_SLOTS = 8
const liveMasterClock = computed(() => deriveMasterClock(
  layers.value.filter(l => l.live).map(l => ({ duration: l.live!.duration, fps: l.live!.fps })),
  ((compositor.value?.data?.properties as any)?.sailor_frame?.clock) ?? null))
const hasAnimatedSlot = computed(() => layers.value.some(l => l.live && l.live.duration > 0))
// A live (speed !== 0) shader fill also needs SOME clock advancing it. The scrubbable
// playhead (`previewT`) is authoritative whenever it's set — Motion tab, scrubbing or
// playing (see `renderStack`'s `clockT` below) — so this wall clock only needs to run
// while idle (`previewT == null`, i.e. Design tab / not in a motion preview). Gating on
// `previewT == null` rather than `!playing` means pausing/scrubbing to a stop does NOT
// wake this loop back up to fight the frozen scrub position with a free-running clock.
// Hoisted from the per-layer visibility section below, where they belong conceptually.
// `watch(needsLiveLoop, …)` a few lines down evaluates its source DURING setup (Vue
// seeds a watcher's old value immediately, even without `immediate: true`), which runs
// buildStackItems → the wired branch → `hiddenWired`. Declared at their original site
// these were still in the temporal dead zone at that moment, throwing
// "Cannot access 'hiddenWired' before initialization" and killing the whole modal.
// Latent since the shaderfill clock landed, because only documents with a WIRED slot
// reach that branch. `readSlotArr` is a hoisted function declaration, so it is safe here.
// Schema 2 retired the slot-keyed flag arrays: a wired slot is a LAYER, and its
// hidden/locked state lives on the layer like every other kind's. The arrays are
// left on disk untouched (rollback safety — see wiredMigration's header), so they
// must be actively IGNORED here rather than merely stopped being written, or a
// pre-migration `sailor_hiddenWired: [1]` would keep hiding a slot whose layer
// says visible. Only a schema < 2 frame still consults them.
const frameSchemaUnified = computed(() =>
  !legacyWiredFlagsActive((compositor.value?.data?.properties as any) ?? null))
const hiddenWired = computed(() => (frameSchemaUnified.value ? new Set<number>() : new Set(readSlotArr('sailor_hiddenWired'))))
const lockedWired = computed(() => (frameSchemaUnified.value ? new Set<number>() : new Set(readSlotArr('sailor_lockedWired'))))

const hasAnimatedFill = computed(() => hasAnimatedShaderFill(buildStackItems(), background.value))
const needsWallClock = computed(() => hasAnimatedFill.value && previewT.value == null)
const needsLiveLoop = computed(() => hasAnimatedSlot.value || needsWallClock.value)
let liveRaf = 0, liveStart = 0, liveInFlight = false, liveCapWarned = false
// Live-preview cost controls, ported from the Frame card (ArtifactFrameNode). The modal
// had neither, so its idle loop composited the whole stack at full device resolution on
// EVERY rAF — the ~50 ms/frame that held it at ~19 fps. `LIVE_PREVIEW_MAXPX` caps the
// live backing store; `SHADER_PREVIEW_FPS` caps how often a shader-only frame repaints;
// `lastLiveFrame` is the content-frame-index guard that skips redundant repaints.
const LIVE_PREVIEW_MAXPX = 640_000, SHADER_PREVIEW_FPS = 30
let lastLiveFrame = -1
function liveFrameTick(ts: number) {
  if (!liveStart) liveStart = ts
  // Pause the heavy per-frame composite while the user pans/zooms, so the gesture gets
  // the full frame budget. `liveStart` was captured once and `wallT` is derived from
  // real elapsed time, so animation resumes at the right point when the gesture ends —
  // no freeze, no jump. Keep the rAF chain alive.
  if (viewMoving.value) { liveRaf = requestAnimationFrame(liveFrameTick); return }
  const mc = liveMasterClock.value
  const wallT = (ts - liveStart) / 1000
  // Render at CONTENT fps, not display refresh rate (ported from the Frame card): rAF
  // fires up to 120 Hz, but the content has only `fps` distinct frames and each paint is
  // an expensive pull + composite. Skip any tick mapping to the already-rendered frame
  // index — repainting the same frame 2-4× is wasted work that starves interaction.
  const previewFps = mc && mc.duration > 0 ? mc.fps : SHADER_PREVIEW_FPS
  const frameIdx = masterFrameIndex(wallT, previewFps)
  const frameChanged = frameIdx !== lastLiveFrame
  if (mc && mc.duration > 0) {
    if (!liveInFlight && frameChanged) {
      lastLiveFrame = frameIdx
      liveInFlight = true
      const t = wallT % mc.duration
      let animated = layers.value.filter(l => l.live && l.live.duration > 0)
      if (animated.length > MAX_LIVE_SLOTS) {
        if (!liveCapWarned) { console.warn(`[Compositor] ${animated.length} animated slots > cap ${MAX_LIVE_SLOTS}; extras shown as stills`); liveCapWarned = true }
        animated = animated.slice(0, MAX_LIVE_SLOTS)
      }
      Promise.all(animated.map(l => pullLiveFrameModal(l, slotPhase01(t, l.live!.duration))))
        .then(() => renderStack(wallT, true))
        .finally(() => { liveInFlight = false })
    }
  } else if (needsWallClock.value && frameChanged) {
    // No animated wired slot to pull frames for (mc idle/null), but a live shader fill
    // still needs a fresh paint to advance — throttled to SHADER_PREVIEW_FPS, not rAF.
    lastLiveFrame = frameIdx
    renderStack(wallT, true)
  }
  liveRaf = requestAnimationFrame(liveFrameTick)
}
function startLive() { cancelAnimationFrame(liveRaf); liveStart = 0; liveInFlight = false; lastLiveFrame = -1; if (needsLiveLoop.value) liveRaf = requestAnimationFrame(liveFrameTick) }
function stopLive() { cancelAnimationFrame(liveRaf); liveRaf = 0 }
watch(needsLiveLoop, startLive)
onMounted(startLive)
onBeforeUnmount(stopLive)
/** Depth source for a wired slot, or null when there is no file behind it (a live
 *  studio slot). Kept here so the render path and the panel agree on one answer. */
function wiredDepthSource(layer: Layer) {
  return depthSourceFromViewUrl(layer.url)
}

/**
 * Depth source for whatever layer the ONE inspector is showing. An uploaded image
 * keys depth by its filename; a wired layer keys it by the `/view` URL of the slot
 * feeding it (`depthKey`, kept current by the content reconciler). Anything else —
 * a shape, a live studio slot with no file behind it — has no depth, and the panel
 * then hides Defocus instead of offering a control that could never render.
 */
function localDepthSource(l: any) {
  if (!l) return undefined
  if (l.kind === 'image') return l.filename
  if (l.kind === 'wired') return depthSourceFromViewUrl(l.depthKey) ?? undefined
  return undefined
}

function drawWiredLayer(ctx: CanvasRenderingContext2D, layer: Layer, W: number, H: number) {
  // Depth of field, matching a local image layer. Depth is read SYNCHRONOUSLY and the
  // layer renders through unblurred until it arrives, exactly as on the local path.
  const dof = wiredTreatments.value[wiredKey(layer.slot)]?.dof ?? null
  let depth: HTMLImageElement | null = null
  if (dof?.visible !== false && dof) {
    const src = wiredDepthSource(layer)
    if (src) {
      depth = depthImageFor(src)
      if (!depth) requestDepth(src)
    }
  }
  drawWiredImageLayer(
    ctx, wiredImageEls.value[layer.slot], layer, W, H,
    wiredMaskEls.value[layer.slot] ?? null, dof, depth,
  )
}

// ── Per-layer visibility & lock ──────────────────────────────────────────────
// Local layers carry visible/locked on the layer itself; wired layers persist
// them on node properties as 1-based slot arrays (same numbering as the w:N
// stack keys). Hidden wired layers get opacity 0 stamped on the outgoing copy
// at submit; hidden locals are skipped from bakes entirely.
function readSlotArr(propKey: string): number[] {
  return (((compositor.value?.data?.properties as any)?.[propKey] as number[] | undefined) ?? []).map(Number)
}
function writeSlotArr(propKey: string, arr: number[]) {
  const node = compositor.value
  if (!node) return
  if (!node.data.properties) node.data.properties = {}
  ;(node.data.properties as any)[propKey] = arr
}
// `hiddenWired` / `lockedWired` are declared ABOVE, next to the live-loop computeds —
// see the note there. They belong here conceptually but must exist before
// `watch(needsLiveLoop, …)` evaluates its source during setup.
// Drop hidden/locked flags for slots that no longer have a wire. Slots come
// from EDGES only (see the `layers` computed), so an absent slot is genuinely
// gone — there's no load-time window where a legitimately hidden slot looks
// absent. Without this, hiding a slot and unplugging it leaves a stale entry
// and the NEXT image wired into that port renders invisible.
watch(layers, (ls) => {
  // `layers` is [] while the node is still resolving — pruning then would wipe
  // every flag, so require a resolved compositor node first.
  if (!compositor.value) return
  const live = ls.map(l => l.slot)
  // Schema-2 frames leave these arrays untouched on disk (rollback safety —
  // see wiredMigration's header); pruning them here would contradict that
  // contract even though nothing reads them anymore.
  const legacyFlags = legacyWiredFlagsActive((compositor.value.data.properties as any) ?? null)
  if (legacyFlags) {
    for (const key of ['sailor_hiddenWired', 'sailor_lockedWired'] as const) {
      const pruned = pruneWiredSlotFlags(readSlotArr(key), live)
      if (pruned) writeSlotArr(key, pruned)   // null ⇒ unchanged, skip the write
    }
  }
  // Same trap for the sibling slot-keyed state: a stale mask/cloner would be
  // inherited by the NEXT image wired into that port (invisible or half-erased).
  const props = (compositor.value.data.properties ?? {}) as any
  // UNGATED deliberately: `maskUrl` never migrated onto the layer model, so a
  // schema-2 frame still reads `sailor_wiredTreatments` BY SLOT and a stale
  // entry would still leak onto the next image wired into that port.
  const treatments = props.sailor_wiredTreatments as Record<string, unknown> | undefined
  if (treatments) {
    const next = pruneSlotKeyedRecord(treatments, live, k => { const m = /^w:(\d+)$/.exec(k); return m ? Number(m[1]) : null })
    if (next) props.sailor_wiredTreatments = next
  }
  // Cloners and names DID migrate onto the layer (`cloner` / `name`), so on a
  // schema-2 frame these registries are dead weight kept only for rollback —
  // same contract as hidden/locked above, hence the same gate.
  if (legacyFlags) {
    const cloners = props.sailor_wiredCloners as Record<string, unknown> | undefined
    if (cloners) {
      const next = pruneSlotKeyedRecord(cloners, live, k => (/^\d+$/.test(k) ? Number(k) : null))
      if (next) props.sailor_wiredCloners = next
    }
    const names = props.sailor_wiredNames as Record<string, unknown> | undefined
    if (names) {
      const next = pruneSlotKeyedRecord(names, live, k => (/^\d+$/.test(k) ? Number(k) : null))
      if (next) props.sailor_wiredNames = next
    }
  }
}, { immediate: true })
/** LEGACY (schema < 2) only: toggle a slot-keyed hidden/locked flag. A schema-2
 *  frame has a layer for the slot and toggles `visible`/`locked` on it instead
 *  (`toggleRowHidden` / `toggleRowLocked`), so this is a no-op there — writing the
 *  dead array would leave state that nothing reads and rollback would misread. */
function toggleWiredFlag(propKey: 'sailor_hiddenWired' | 'sailor_lockedWired', slot: number) {
  if (frameSchemaUnified.value) return
  const cur = readSlotArr(propKey)
  writeSlotArr(propKey, cur.includes(slot) ? cur.filter(s => s !== slot) : [...cur, slot])
}
/** The layer holding a 1-BASED modal slot, once the frame is on schema 2. */
function wiredLayerForSlot1(slot: number): WiredLayer | undefined {
  return localLayers.value.find(l => l.kind === 'wired' && (l as WiredLayer).slot === slot - 1) as WiredLayer | undefined
}
/** Set (not toggle) a wired slot's hidden flag, whichever schema the frame is on.
 *  On schema 2 that is the LAYER's `visible` — the only flag the preview, the
 *  motion bake and the submit path all read for a wired layer. */
function setWiredHidden(slot: number, hidden: boolean) {
  const wl = wiredLayerForSlot1(slot)
  if (wl) {
    if ((wl.visible === false) === hidden) return
    setLocal(wl.id, { visible: hidden ? false : undefined } as any)
    return
  }
  const cur = readSlotArr('sailor_hiddenWired')
  if (cur.includes(slot) === hidden) return
  writeSlotArr('sailor_hiddenWired', hidden ? [...cur, slot] : cur.filter(s => s !== slot))
}
// ── Wired-layer names ────────────────────────────────────────────────────────
// Wired image layers have no LocalLayer to hang a `name` on, so custom names
// live in a slot→name map on the node's properties (pruned with the other
// slot-keyed state when a wire is removed — see the watch(layers) above).
function readSlotNames(): Record<number, string> {
  return ((compositor.value?.data?.properties as any)?.sailor_wiredNames as Record<number, string> | undefined) ?? {}
}
const wiredNames = computed<Record<number, string>>(() => readSlotNames())
function wiredLabel(slot: number): string { return wiredNames.value[slot]?.trim() || `Layer ${slot}` }
const editingWiredSlot = ref<number | null>(null)
const wiredNameDraft = ref('')
function startWiredRename(slot: number) {
  editingWiredSlot.value = slot
  wiredNameDraft.value = readSlotNames()[slot] ?? ''
}
function commitWiredRename() {
  const slot = editingWiredSlot.value
  const node = compositor.value
  if (slot != null && node) {
    if (!node.data.properties) node.data.properties = {}
    const next = { ...readSlotNames() }
    const name = wiredNameDraft.value.trim()
    if (name) next[slot] = name; else delete next[slot]
    ;(node.data.properties as any).sailor_wiredNames = next
  }
  editingWiredSlot.value = null
}
/** Persist a full bottom→top stack order. */
function writeStackOrder(arr: StackKey[]) {
  const node = compositor.value
  if (!node) return
  if (!node.data.properties) node.data.properties = {}
  ;(node.data.properties as any).sailor_stackOrder = arr
}
// Hide / lock read and write the LAYER's own fields for every kind — wired
// included, since a wired slot is a layer now. The `w:` branch is the legacy
// (schema < 2) row, which has no layer to carry the flag; on a schema-2 frame
// `hiddenWired`/`lockedWired` are empty and `toggleWiredFlag` is a no-op, so that
// branch is unreachable state rather than a second source of truth.
// NOTE: a legacy `w:` row also carries a `layer`, but it is the graph-side `Layer`
// (slot/url/scale), NOT a LocalLayer — it has no `id` to patch — so that branch has
// to be tested FIRST.
function rowHidden(row: any): boolean {
  if (row.kind === 'wired') return hiddenWired.value.has(row.slot)
  return row.layer ? row.layer.visible === false : false
}
function rowLocked(row: any): boolean {
  if (row.kind === 'wired') return lockedWired.value.has(row.slot)
  return row.layer ? !!row.layer.locked : false
}
function toggleRowHidden(row: any) {
  if (row.kind === 'wired') toggleWiredFlag('sailor_hiddenWired', row.slot)
  else if (row.layer) setLocal(row.layer.id, { visible: row.layer.visible === false ? undefined : false } as any)
}
function toggleRowLocked(row: any) {
  if (row.kind === 'wired') toggleWiredFlag('sailor_lockedWired', row.slot)
  else if (row.layer) setLocal(row.layer.id, { locked: !row.layer.locked } as any)
}
// ── Group-row hide/lock/opacity (Task 4: mirrors the layer-row toggles above,
// but reads/writes the group's own record via the Task 2 setters) ───────────
function groupRowHidden(gid: string): boolean {
  return !!localGroups.value.find(g => g.id === gid)?.hidden
}
function groupRowLocked(gid: string): boolean {
  return !!localGroups.value.find(g => g.id === gid)?.locked
}
function groupRowOpacity(gid: string): number {
  return localGroups.value.find(g => g.id === gid)?.opacity ?? 1
}

// ── Motion preview (kinetic slates) ──────────────────────────────────────────
// The frame-level motion doc (fps/duration) persists on the node like the
// local layers do: a direct property write that Vue reactivity picks up and
// the workflow save serializes (see useLocalLayerEditor.commit).
const motionDoc = computed<FrameMotion>(() => {
  const p = compositor.value?.data?.properties as Record<string, any> | undefined
  return { ...DEFAULT_FRAME_MOTION, ...(p?.sailor_motion ?? {}) }
})
function setMotion(patch: Partial<FrameMotion>) {
  const node = compositor.value
  if (!node) return
  const p = (node.data.properties ||= {})
  p.sailor_motion = { ...motionDoc.value, ...patch }
  if (previewT.value != null) {
    // Read the new duration from the patch — the computed may lag the in-place
    // properties mutation depending on the node object's reactivity depth.
    previewT.value = Math.min(previewT.value, patch.duration ?? motionDoc.value.duration)
    renderStack()
  }
}
// The docked timeline mutates layer.animation in place during a drag, then
// emits 'commit' (no payload) on pointerup. `commit()` from the local-layer
// editor takes the next array — re-assigning the same (already-mutated)
// reference persists it. The timeline emits 'beforeChange' (wired to
// recordHistory below) before the first mutation of each drag, so the undo
// snapshot captures the pre-edit state.
function commitMotionTimeline() {
  commit(localLayers.value)
}

const playing = ref(false)
let rafId = 0
let playStartWall = 0
let playStartT = 0

function tickPlayback(now: number) {
  if (!playing.value) return
  const t = (playStartT + (now - playStartWall) / 1000) % effectiveMotion.value.duration
  previewT.value = t
  renderStack()
  rafId = requestAnimationFrame(tickPlayback)
}
function play() {
  cancelAnimationFrame(rafId) // never stack a second rAF chain
  playing.value = true
  playStartT = previewT.value ?? 0
  playStartWall = performance.now()
  rafId = requestAnimationFrame(tickPlayback)
}
function pause() {
  playing.value = false
  cancelAnimationFrame(rafId)
}
function scrubTo(t: number) {
  pause()
  previewT.value = Math.max(0, Math.min(effectiveMotion.value.duration, t))
  renderStack()
}
function exitMotionPreview() {
  pause()
  previewT.value = null
  bakeError.value = ''
  renderStack()
}

// ── Design | Motion inspector tabs (3D Studio Build|Motion idiom) ───────────
// Motion active ⇔ motion mode: the docked timeline replaces the bottom
// toolbar cluster and the inspector shows animation controls.
const inspectorTab = ref<'design' | 'motion'>('design')
watch(inspectorTab, (tab) => {
  if (tab === 'motion') { if (previewT.value == null) scrubTo(0) }
  else exitMotionPreview()
})

// ── Brand library (project kit entry point) ─────────────────────────────────
// The layout (default.vue) provides the project's active brand kit; this
// toolbar entry opens the same library popover the project menu uses, so
// "Set active" here and there write to the one doc-owned brandKitId.
const projectBrand = inject<{
  activeKit: ComputedRef<BrandKit | undefined>
  activeKitId: ComputedRef<string | null>
  setBrandKit: (id: string | null) => void
} | null>('sailor:brand', null)
const brandOpen = ref(false)

// ── Motion bake (PNG sequence → motion_params) ──────────────────────────────
// Bake renders every frame through the same buildStackItems()/paintLayerStack
// path as the preview, uploads PNGs to /upload/image, and persists the result
// on node properties.
//
// Params are stored at node.data.properties.sailor_motionParams and stamped
// into the backend's `motion_params` widget at submit time by
// injectCompositorMotionParams (VueNodeCanvas.vue, called from the Run path in
// layouts/default.vue — same pattern as the Timeline's edit_state injection).
// When `rendered` is non-empty the backend Compositor returns the baked frame
// batch + a real VIDEO output instead of the static server-side composite.
//
// NOTE: source_key hashes local layers + motion + size only — wired-layer
// PIXEL content is not hashed, so an upstream graph re-run does not flip the
// stale badge. Known v1 limitation.
const baking = ref(false)
const bakeProgress = ref(0)
const bakeError = ref('')

/** Read a numeric node widget by name (0 when unset/absent). */
function readNodeIntWidget(name: string): number {
  const node = compositor.value
  const defs = node?.data?.widgetDefs as any[] | undefined
  const wv = node?.data?.widgetsValues as any[] | undefined
  const wi = defs?.findIndex((d: any) => d.name === name) ?? -1
  return wi >= 0 ? Number(wv?.[wi]) || 0 : 0
}

// Bake at the explicit artboard resolution when set; else the editor canvas.
function bakeSize(): { W: number; H: number } {
  const w = readNodeIntWidget('width')
  const h = readNodeIntWidget('height')
  if (w > 0 && h > 0) return { W: w, H: h }
  if (w > 0) return { W: w, H: Math.round(w * canvasDisplay.h / canvasDisplay.w) }
  return { W: canvasDisplay.w, H: canvasDisplay.h }
}

// Full composite (wired + local) at bake resolution, for Harmonize context.
// Mirrors renderStack()'s paint call (background + wiredTreatments + groups)
// so the scene crop matches exactly what the editor shows — unlike bakeMotion,
// which only needs layer pixels frame-by-frame and skips those extras.
function renderSceneForHarmonize(): { canvas: HTMLCanvasElement; W: number; H: number } {
  const { W, H } = bakeSize()
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  // bake=true (Task 10): a Harmonize render is a final full-resolution export, not a
  // live preview — shader-fill fields must render unclamped, same as Render/Export below.
  withWiredContent(wiredContentForSlot, () =>
    paintLayerStack(ctx, W, H, buildStackItems(), localLayers.value as LocalLayer[],
      undefined, undefined, undefined, wiredTreatments.value, background.value, localGroups.value, postEffects.value, true))
  return { canvas, W, H }
}

const storedMotionParams = computed<MotionParams | null>(() => {
  const p = compositor.value?.data?.properties as Record<string, any> | undefined
  return (p?.sailor_motionParams as MotionParams | undefined) ?? null
})

// ── One source of truth for "what motion would a bake use right now" ───────
// When no local layer animates AND the user has never touched the frame's own
// timing (sailor_motion is unset), a wired studio's natural clock — not the
// 4s/30fps default — is the honest answer. The moment the user sets anything
// via setMotion(), sailor_motion becomes explicit and wins everywhere.
const hasLocalAnims = computed(() => localLayers.value.some((l: any) => l.animation))
const hasStoredMotion = computed(() => {
  const p = compositor.value?.data?.properties as Record<string, any> | undefined
  return p?.sailor_motion != null
})
const effectiveMotion = computed<FrameMotion>(() => {
  const mc = liveMasterClock.value
  return (!hasLocalAnims.value && !hasStoredMotion.value && mc)
    ? { ...motionDoc.value, duration: mc.duration, fps: mc.fps }
    : motionDoc.value
})
const motionStale = computed(() => {
  const stored = storedMotionParams.value
  if (!stored) return false
  const { W, H } = bakeSize()
  return stored.source_key !== motionSourceKey(localLayers.value as LocalLayer[], effectiveMotion.value, W, H)
})

async function bakeMotion(motionOverride?: FrameMotion) {
  if (baking.value) return
  const node = compositor.value
  if (!node) return
  baking.value = true
  bakeProgress.value = 0
  bakeError.value = ''
  pause() // don't fight the rAF preview loop for the layer state
  stopLive() // don't let the live studio RAF race the bake's per-frame pulls
  try {
    const { W, H } = bakeSize()
    const motion = motionOverride ?? effectiveMotion.value
    const previousFrames = storedMotionParams.value?.rendered ?? []
    // The bake is ASYNC (one awaited upload per frame), so the scoped
    // `withWiredContent` span can't hold across it — a global registration is the
    // only correct shape here. Safe for the bake's duration: the modal covers the
    // canvas, so every Frame card's own loop is occlusion-gated off. Cleared in
    // `finally` so no stale resolver outlives the bake.
    _registerWiredContent(wiredContentForSlot)
    const params = await bakeAndUpload(
      () => buildStackItems(), localLayers.value as LocalLayer[], W, H, motion,
      (done, total) => { bakeProgress.value = done / total },
      async (t) => {
        const animated = layers.value.filter(l => l.live && l.live.duration > 0)
        await Promise.all(animated.map(l => pullLiveFrameModal(l, slotPhase01(t, l.live!.duration))))
      },
    )
    const p = (node.data.properties ||= {})
    p.sailor_motionParams = params
    // The new bake supersedes the old PNG sequence — delete it server-side.
    // Best-effort: stale frames are harmless, so failures are swallowed.
    const superseded = previousFrames.filter(f => !params.rendered.includes(f))
    if (superseded.length) {
      fetch('/sailor/motion/cleanup_frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: superseded, keep: params.rendered }),
      }).catch(() => {})
    }
  } catch (err: any) {
    console.error('[compositor motion bake]', err)
    bakeError.value = err?.message || 'Motion bake failed'
  } finally {
    _registerWiredContent(null)
    baking.value = false
    startLive()
  }
}

// Static Render freshness: hash the inputs that affect the client-side composite.
function staticSourceKey(): string {
  const { W, H } = bakeSize()
  const s = JSON.stringify({
    local: localLayers.value, order: stackKeys.value,
    treatments: wiredTreatments.value, wired: layers.value, W, H,
    fx: postEffects.value,
  })
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}
const lastRenderKey = computed<string | null>(() =>
  (compositor.value?.data?.properties as any)?.sailor_renderKey ?? null)
const renderStale = computed(() => lastRenderKey.value !== staticSourceKey())
const rendering = ref(false)
const renderError = ref('')
const encoding = ref(false)

// Render the static unified stack to a PNG blob at W×H (no motion, no preview skip).
async function renderStaticComposite(W: number, H: number): Promise<Blob | null> {
  const off = document.createElement('canvas')
  off.width = Math.max(1, Math.round(W)); off.height = Math.max(1, Math.round(H))
  const ctx = off.getContext('2d'); if (!ctx) return null
  await ensureLayerImages(localLayers.value as LocalLayer[])
  await ensureLayerFonts(localLayers.value as LocalLayer[], W)
  // bake=true (Task 10): the static Render/Export path — final output, not preview.
  withWiredContent(wiredContentForSlot, () =>
    paintLayerStack(ctx, W, H, buildStackItems(), localLayers.value as LocalLayer[],
      undefined, undefined, undefined, wiredTreatments.value, background.value, localGroups.value, postEffects.value, true))
  return await new Promise<Blob | null>(resolve => off.toBlob(b => resolve(b), 'image/png'))
}

// True when any local layer carries a motion window OR a wired studio slot is
// animated — gates "Generate as video". hasAnimatedSlot is defined above
// (~line 1292), before this computed, so it can be referenced directly.
const hasMotion = computed(() => localLayers.value.some((l: any) => l.animation) || hasAnimatedSlot.value)

// ── outputs (mirror Gradient Studio's generateImage/generateVideo idiom) ────
async function generateImage() {
  const node = compositor.value
  if (!node || rendering.value || baking.value || encoding.value) return
  rendering.value = true
  renderError.value = ''
  try {
    const { W, H } = bakeSize()
    const blob = await renderStaticComposite(W, H)
    if (!blob) return
    const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
    const [filename] = await uploadFrameBatch([blob], 'frame_img')
    if (filename) {
      const p = (node.data.properties ||= {})
      p.sailor_renderKey = staticSourceKey()
      node.data.images = [`/view?${new URLSearchParams({ filename, type: 'input' })}`]
      await recordAsset(activeTab.value?.projectUuid, 'image', filename)
      window.dispatchEvent(new CustomEvent('sailor:compositorOutput', {
        detail: { sourceNodeId: node.id, nodeType: 'Image', widgetOverrides: { image: filename } },
      }))
      emit('close')
    }
  } catch (err: any) {
    console.error('[compositor generate]', err)
    renderError.value = err?.message || 'Render failed'
  } finally {
    rendering.value = false
  }
}

async function generateVideo() {
  const node = compositor.value
  if (!node || rendering.value || baking.value || encoding.value || !hasMotion.value) return
  encoding.value = true
  renderError.value = ''
  try {
    // bakeMotion() with no override defaults to effectiveMotion — which already
    // falls back to a wired studio's own master clock (duration/fps) when no
    // local layer animates and the user hasn't set explicit frame timing, so
    // the video loops on the studios' natural timing with zero configuration.
    await bakeMotion()
    if (bakeError.value) { renderError.value = bakeError.value; return }
    const { W, H } = bakeSize()
    // Use the fps actually baked (carried on storedMotionParams), not motionDoc,
    // so the encode matches the effective motion used above.
    const fps = storedMotionParams.value?.fps ?? motionDoc.value.fps
    try {
      const encoded = await encodeFrames({ frames: storedMotionParams.value!.rendered, fps, width: W, height: H })
      await recordAsset(activeTab.value?.projectUuid, 'video', encoded.filename)
      window.dispatchEvent(new CustomEvent('sailor:compositorOutput', {
        detail: { sourceNodeId: node.id, nodeType: 'Video', widgetOverrides: { file: encoded.filename } },
      }))
      emit('close')
    } catch (encErr) {
      renderError.value = 'Encode failed — restart ComfyUI to load the encoder.'
      console.error('[compositor generate] encode failed', encErr)
    }
  } catch (err: any) {
    console.error('[compositor generate]', err)
    renderError.value = err?.message || 'Video generate failed'
  } finally {
    encoding.value = false
  }
}

const wiredTreatments = computed(() => readWiredTreatments(compositor.value))

// Decoded per-slot visibility masks, kept in sync with `wiredTreatments`. White =
// hidden, in the wired image's pixel space (see drawWiredImageLayer).
const wiredMaskEls = ref<Record<number, HTMLImageElement | null>>({})
watch(wiredTreatments, (tr) => {
  const liveSlots = new Set<number>()
  for (const [key, t] of Object.entries(tr)) {
    const m = /^w:(\d+)$/.exec(key); if (!m) continue
    const slot = Number(m[1]); const url = (t as any).maskUrl as string | undefined
    if (!url) { if (wiredMaskEls.value[slot]) { const n = { ...wiredMaskEls.value }; delete n[slot]; wiredMaskEls.value = n } continue }
    liveSlots.add(slot)
    const cur = wiredMaskEls.value[slot]
    if (cur && cur.dataset.url === url) continue
    const im = new Image(); im.onload = () => { im.dataset.url = url; wiredMaskEls.value = { ...wiredMaskEls.value, [slot]: im }; renderStack() }
    im.src = url
  }
  // Prune cache entries whose treatment key vanished entirely (e.g. Clear mask
  // drops the `w:<slot>` entry rather than leaving maskUrl empty) — otherwise
  // the loop above never revisits that slot and a stale decoded mask lingers.
  const stale = Object.keys(wiredMaskEls.value).map(Number).filter(slot => !liveSlots.has(slot))
  if (stale.length) {
    const n = { ...wiredMaskEls.value }
    for (const slot of stale) delete n[slot]
    wiredMaskEls.value = n
    renderStack()
  }
}, { deep: true, immediate: true })

// ── Schema 2: a connected slot IS a layer ───────────────────────────────────
// 0-based input-port indices with an edge, read straight off the graph (the one
// thing the migration cannot see for itself).
const connectedSlots0 = computed<number[]>(() => {
  const out = new Set<number>()
  for (const e of (props.edges ?? []) as any[]) {
    if (String(e?.target) !== String(props.nodeId)) continue
    const m = /^input-(\d+)$/.exec(String(e?.targetHandle ?? ''))
    if (m) out.add(Number(m[1]))
  }
  return [...out].sort((a, b) => a - b)
})
function slotDimsMap0(): Record<number, { w: number; h: number } | undefined> {
  const out: Record<number, { w: number; h: number } | undefined> = {}
  for (const s of connectedSlots0.value) out[s] = wiredDimsForSlot(s)
  return out
}
// Runs on open and on every wiring change; self-no-ops once the frame is schema 2.
// Skipped while nothing is connected — there would be nothing to fold, and
// stamping the schema then would freeze a frame whose edges hadn't arrived.
watch(() => connectedSlots0.value.join(','), () => {
  const slots = connectedSlots0.value
  if (!compositor.value) return
  if (slots.length) {
    migrateFrameToUnifiedLayers({ data: compositor.value.data, connectedSlots: [...slots] }, slotDimsMap0())
  }
  // Edge lifecycle: a new edge mints a layer, a cut edge marks its layer
  // `unlinked` rather than deleting it — placement, name, mask, cloner and
  // z-position all survive — and re-wiring the same slot relinks it. Committed
  // without a history step: this mirrors the graph, and undoing it would only
  // fight the graph on the next tick.
  const linked = syncWiredLayerLinks(localLayers.value as LocalLayer[], slots)
  if (linked) {
    commit(linked.layers)
    const last = linked.addedIds[linked.addedIds.length - 1]
    // A freshly-minted wired layer is always a `w <= 0` sentinel (no content has
    // resolved yet) — invisible and zero-size. Selecting it left the user staring
    // at nothing, and ⌘2 (zoom to selection) maxed out the zoom on a degenerate
    // box. Skip selection here; the layer becomes selectable once the finalizer
    // resolves its box from real content.
    const lastLayer = last ? linked.layers.find(l => l.id === last) : undefined
    if (last && lastLayer && !isWiredSentinel(lastLayer)) selectLocal(last)
  }
}, { immediate: true })

/** What the reconciler knows about a slot's content this tick (0-based slot). */
function wiredContentInfo0(slot: number) {
  const l = layers.value.find(x => x.slot === slot + 1)
  const url = l && !l.live ? l.url : undefined
  return { dims: wiredDimsForSlot(slot), depthKey: url }
}
// First real content resolves the migration's `w <= 0` sentinels (preserving the
// surviving `layer{N}_scale`), and every later content change refreshes the
// cached aspect + depth key — without which the preview re-fits live while the
// widget `scale` the server renders from drifts permanently. Committed WITHOUT
// recordHistory: reconciliation is bookkeeping, not an undoable edit.
// The layer array is part of the key (via the sentinel set) so an undo that
// lands BACK on a sentinel re-finalizes instead of leaving the layer invisible
// until the next resize — see `wiredReconcileKey`.
watch(
  () => wiredReconcileKey(
    connectedSlots0.value, wiredContentInfo0,
    { w: canvasDisplay.w, h: canvasDisplay.h },
    localLayers.value as LocalLayer[],
  ),
  () => {
    const canvas = { w: canvasDisplay.w, h: canvasDisplay.h }
    const fin = finalizeWiredSentinels(localLayers.value as LocalLayer[], compositor.value?.data, canvas, wiredDimsForSlot)
    if (fin) commit(fin)
    const rec = reconcileWiredContent(localLayers.value as LocalLayer[], wiredContentInfo0)
    if (rec) commit(rec)
  },
  { immediate: true },
)

// One StackItem builder shared by the live preview AND the motion bake, so the
// baked frames render exactly what the editor shows (wired layers included).
function buildStackItems(): StackItem[] {
  return stackKeys.value.map((key): StackItem | null => {
    const r = resolveStackKey(key)
    if (!r) return null
    if (r.type === 'wired') {
      if (hiddenWired.value.has((r.layer as Layer).slot)) return null
      return { type: 'wired', key, draw: (c, w, h) => drawWiredLayer(c, r.layer as Layer, w, h) }
    }
    return { type: 'local', key, layer: r.layer as LocalLayer }
  }).filter((x): x is StackItem => x != null)
}

const overlayCanvas = ref<HTMLCanvasElement | null>(null)
// Task 6: beginFieldFrame's live-field ceiling is applied once per paintLayerStack
// call (this frame's own shader fills, never pooled with an open Space Type/Shape
// Studio node — see useCompositorLayers.ts's doc on _fieldCtx). Surfaced here so a
// capped frame never animates silently, matching Space Type/Shape Studio's own hint.
const shaderFieldsFrozen = ref(0)
// `wallT` is the idle-fallback clock from `liveFrameTick` (real elapsed seconds since
// that loop started) — see the "Live animation loop" section above for why it's the
// ONLY source of time when `previewT` is null. Every other call site (many — brush
// strokes, layer edits, wiring changes) omits it, which is correct: whenever the
// playhead is set it wins outright, and whenever it's null AND nothing is animating,
// t=0 is indistinguishable from "no clock needed" (`hasAnimatedFill` is false, so the
// wall-clock loop isn't running to call this with a real `wallT` anyway).
function renderStack(wallT?: number, live = false) {
  const cv = overlayCanvas.value
  if (!cv) return
  const __probeS = performance.now()   // TEMP open-cost probe
  const W = canvasDisplay.w, H = canvasDisplay.h
  const deviceDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  // Cap the backing store while the animation loop drives this (`live`): compositing the
  // wired pull + every shader fill at full device resolution each tick is the modal's
  // ~50 ms/frame cost. Static repaints, bakes and exports pass `live=false` and keep full
  // resolution, so committed/exported quality is unchanged; only the moving preview is
  // slightly softer. (Same cap the Frame card uses.)
  const dpr = live
    ? Math.max(1, Math.min(deviceDpr, Math.sqrt(LIVE_PREVIEW_MAXPX / Math.max(1, W * H))))
    : deviceDpr
  // Resize only when it actually changes — assigning width/height reallocates and clears
  // the backing store, and doing that every tick is itself a jank source. `clearRect`
  // below does the per-frame clear.
  const dw = Math.max(1, Math.round(W * dpr)), dh = Math.max(1, Math.round(H * dpr))
  if (cv.width !== dw) cv.width = dw
  if (cv.height !== dh) cv.height = dh
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const items = buildStackItems()
  // Live brush stroke preview (paint mode): fold the in-progress stroke into the
  // layer actually being drawn, so the preview MATCHES the committed result — an
  // eraser stroke subtracts in real time (destination-out within the layer), and a
  // paint stroke previews through the layer's real fill (gradient/pattern), not a
  // flat blob. New-layer strokes get a transient top layer with the brush colour.
  const ls = brush.active.value && brush.mode.value === 'paint' ? brush.liveStroke() : null
  if (ls && ls.points.length) {
    const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
    const target = activeBrushLayer()
    if (target) {
      const idx = items.findIndex(it => it.type === 'local' && it.layer.id === target.id)
      if (idx >= 0) {
        const it = items[idx] as Extract<StackItem, { type: 'local' }>
        const strokes = [...(it.layer as BrushLayer).strokes, ls]
        // Re-fit the box so the preview renders at the same place it will commit to.
        items[idx] = { ...it, layer: { ...it.layer, strokes, ...brushBoxFromStrokes(strokes, aspect) } as LocalLayer }
      }
    } else {
      const strokes = [ls]
      const tmp = createBrushLayer({ strokes, fill: brush.color.value, ...brushBoxFromStrokes(strokes, aspect) })
      items.push({ type: 'local', key: `l:${tmp.id}`, layer: tmp })
    }
  }
  // Playhead wins outright when set (Motion tab — scrubbing or playing); otherwise fall
  // back to the idle wall clock so a shader fill still animates in the Design tab. Never
  // both: `motionArg` (which activates the Kinetic Slate motion path) only follows
  // `previewT`, never `wallT` — the wall clock is field-time only, exactly like the
  // Frame node card.
  const clockT = previewT.value ?? wallT
  const motionArg = previewT.value != null ? motionDoc.value : undefined
  // Scoped to THIS frame's slots — the wired resolver is a module global and the
  // Frame cards on the canvas number their own slots exactly the same way.
  const { frozenCount } = withWiredContent(wiredContentForSlot, () =>
    paintLayerStack(ctx, W, H, items, localLayers.value as LocalLayer[], l =>
      l.id === editingId.value || (nodeEdit.active.value && l.id === nodeEdit.layerId.value),
      clockT, motionArg,
      wiredTreatments.value, background.value, localGroups.value, postEffects.value))
  shaderFieldsFrozen.value = frozenCount
  // TEMP open-cost probe: count calls + per-call time, non-live only (skip the animation loop).
  if (!live) {
    const w = window as any
    if (!w.__compRS) w.__compRS = { n: 0, ms: 0, t0: __probeS }
    const d = performance.now() - __probeS
    w.__compRS.n++; w.__compRS.ms += d
    console.log(`[comp-open] renderStack #${w.__compRS.n}: ${d.toFixed(0)}ms · items=${items.length} · cumulative ${w.__compRS.ms.toFixed(0)}ms over ${(performance.now() - w.__compRS.t0).toFixed(0)}ms wall`)
  }
}

// Depth maps arrive asynchronously (see lib/compositor/depthRegistry). paintLayer reads
// them synchronously and renders through unchanged when one is missing, so without this
// subscription a DOF layer would stay unblurred until some unrelated interaction
// happened to trigger a repaint.
let stopDepthWatch: (() => void) | null = null
onMounted(() => { stopDepthWatch = onDepthChange(() => renderStack()) })
onBeforeUnmount(() => { stopDepthWatch?.(); stopDepthWatch = null })

watch(
  () => [
    JSON.stringify(localLayers.value), editingId.value,
    canvasDisplay.w, canvasDisplay.h,
    JSON.stringify(layers.value), JSON.stringify(stackKeys.value),
    Object.keys(wiredImageEls.value).length,
    nodeEdit.active.value, nodeEdit.layerId.value,
    JSON.stringify(readSlotArr('sailor_hiddenWired')),
    JSON.stringify(wiredTreatments.value),
    JSON.stringify(background.value),
    JSON.stringify(postEffects.value),
    JSON.stringify(localGroups.value),
  ] as const,
  async () => {
    for (const l of localLayers.value) if (l.kind === 'text') {
      ensureGoogleFont((l as TextLayer).fontFamily)
      ensureLibraryFont((l as TextLayer).fontFamily)
    }
    await ensureLayerFonts(localLayers.value, canvasDisplay.w)
    await ensureLayerImages(localLayers.value)
    renderStack()
  },
  { immediate: true },
)

// ── Layer-row thumbnails (Task 5) ────────────────────────────────────────────
// Every text/shape/line/brush/path row (and a group's first child) shows a small
// live thumbnail rendered from the SAME per-layer draw the stack uses. This is
// deliberately OFF any per-frame path: a thumb re-renders only after its layer's
// serialized content (or its wired slot's content) changes — debounced, then
// drained a few per animation frame so a long list can't stall. The rAF only runs
// while a queue is non-empty; it is not a standing loop. Image/wired-image rows
// keep their cheaper direct <img> (`rowThumbUrl`); a group's first child renders
// through here even when the group is collapsed. Placed after `wiredImageEls` /
// `wiredContentInfo0` — its content signature reads them, and this immediate watch
// runs during setup.
const THUMB_SIZE = 24
const layerThumbs = ref<Record<string, string>>({})   // layerId → dataURL
const thumbSigs = new Map<string, string>()           // layerId → last-rendered signature
let thumbTimer: ReturnType<typeof setTimeout> | null = null
let thumbCancel: (() => void) | null = null           // cancels the in-flight drain tick

function thumbDpr(): number {
  return Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
}
// Prefer rAF so the drain caps work to one batch per PAINTED frame; fall back to a
// short timer when the tab is hidden (rAF is paused there) so an off-screen edit —
// e.g. the agent mutating layers while the user looks elsewhere — still refreshes
// on its own instead of freezing until refocus. Either way the tick is one-shot
// (re-armed only while the queue is non-empty), never a standing loop.
function scheduleThumbTick(fn: () => void): () => void {
  if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame !== 'undefined') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(fn, 32)
  return () => clearTimeout(id)
}
// Content signature: everything that changes a layer's PIXELS, minus its frame
// placement (x/y/rotation) — a move or spin leaves the thumb identical, so those
// don't trigger a re-render during a drag. A wired layer folds in its slot's
// content id so a still-image swap refreshes it; a live studio animating every
// frame keeps a STABLE id here, so its thumb updates on wiring/size only, never
// per frame (the whole point — no per-frame thumbnail work).
function thumbSig(layer: any): string {
  // skewX/skewY/cornerPin are applied as OUTER canvas transforms in paintLayer,
  // wrapped AROUND drawLayerContent (see applyXform + the corner-pin quad warp) —
  // drawLayerContent itself never reads them. This thumb calls drawLayerContent
  // directly, so a slant/corner-pin drag can never change its pixels; strip them
  // alongside x/y/rotation so that gesture doesn't churn a byte-identical thumb.
  const { x, y, rotation, skewX, skewY, cornerPin, ...rest } = layer
  void x; void y; void rotation; void skewX; void skewY; void cornerPin
  let sig = JSON.stringify(rest)
  if (layer.kind === 'wired') {
    sig += '|w:' + JSON.stringify(wiredContentInfo0(layer.slot)) + (wiredImageEls.value[layer.slot + 1] ? ':1' : ':0')
  }
  return sig
}
/** The top-most descendant layer of a group, whatever the expand state — the
 *  cheap honest group thumb (first child, per spec). */
function groupFirstLayerId(gid: string): string | null {
  const ids = layersInGroup(gid, localLayers.value, localGroups.value)
  if (!ids.length) return null
  const si = stackIndexByKey.value
  let best: string | null = null, bestIdx = Infinity
  for (const id of ids) {
    const idx = si.get('l:' + id) ?? Infinity
    if (idx < bestIdx) { bestIdx = idx; best = id }
  }
  return best ?? ids[0] ?? null
}
/** The rendered thumbnail data URL for a row, or null (row falls back to swatch/
 *  icon). Group rows show their first child's thumb. */
function rowThumb(row: any): string | null {
  if (row.kind === 'group') {
    const id = groupFirstLayerId(row.groupId)
    return id ? (layerThumbs.value[id] || null) : null
  }
  return row.layer ? (layerThumbs.value[row.layer.id] || null) : null
}
function scheduleThumbs() {
  if (thumbTimer) clearTimeout(thumbTimer)
  thumbTimer = setTimeout(runThumbPass, 200)
}
async function runThumbPass() {
  thumbTimer = null
  if (typeof window === 'undefined') return
  // The thumbs' fonts/images must be resolved or a text/image thumb draws blank —
  // idempotent + cached (the main render watcher ensures the same set). This does
  // NOT re-run when a font/image resolves later (no fonts.ready hook here) — it
  // mirrors the main-canvas render watcher and inherits the same font-race
  // behavior: whatever asset state is available at THIS pass is what gets baked in.
  await ensureLayerFonts(localLayers.value, canvasDisplay.w)
  await ensureLayerImages(localLayers.value)
  // Which layers need a thumb right now: every text/shape/line/brush/path row that
  // is listed, plus each group's first child (any kind, incl. collapsed groups).
  // Image / wired-image direct rows are skipped — they render via `rowThumbUrl`.
  const wanted = new Map<string, any>()
  const rows = flatRows.value
  for (const r of rows as any[]) {
    if (r.kind === 'group') {
      const id = groupFirstLayerId(r.groupId)
      const lyr = id ? localLayers.value.find(l => l.id === id) : null
      if (lyr) wanted.set(lyr.id, lyr)
    } else if ((r.kind === 'local' || r.kind === 'child') && r.layer) {
      const l = r.layer
      if (l.kind === 'image' || l.kind === 'wired') continue
      wanted.set(l.id, l)
    }
  }
  // Evict cache entries for layers no longer shown.
  let evicted = false
  const next: Record<string, string> = {}
  for (const [id, url] of Object.entries(layerThumbs.value)) {
    if (wanted.has(id)) next[id] = url
    else { evicted = true; thumbSigs.delete(id) }
  }
  if (evicted) layerThumbs.value = next
  // Queue only the layers whose signature changed since their last render.
  const queue: { layer: any; sig: string }[] = []
  for (const layer of wanted.values()) {
    const sig = thumbSig(layer)
    if (thumbSigs.get(layer.id) !== sig) queue.push({ layer, sig })
  }
  drainThumbQueue(queue)
}
function drainThumbQueue(queue: { layer: any; sig: string }[]) {
  if (thumbCancel) { thumbCancel(); thumbCancel = null }
  if (!queue.length) return
  const CAP = 6   // thumbs per tick — caps work on a long list
  const step = () => {
    thumbCancel = null
    const batch = queue.splice(0, CAP)
    let patch: Record<string, string> | null = null
    for (const { layer, sig } of batch) {
      const url = withWiredContent(wiredContentForSlot, () => {
        const c = renderLayerThumbnail(layer, THUMB_SIZE, thumbDpr())
        return c ? c.toDataURL() : null
      })
      thumbSigs.set(layer.id, sig)   // mark done even on null so we don't re-attempt every pass
      if (url) (patch ||= {})[layer.id] = url
    }
    if (patch) layerThumbs.value = { ...layerThumbs.value, ...patch }
    if (queue.length) thumbCancel = scheduleThumbTick(step)
  }
  thumbCancel = scheduleThumbTick(step)
}
// Re-thumb on content changes only: layer content (placement + outer-transform
// fields — x/y/rotation/skewX/skewY/cornerPin — stripped so a drag doesn't churn;
// see thumbSig above for why those specific fields are outer transforms), group
// membership, wired slot content, decoded wired bitmaps, and a late-registering
// live studio. NOT on the playhead / wall clock.
watch(
  () => [
    JSON.stringify(localLayers.value.map((l: any) => { const { x, y, rotation, skewX, skewY, cornerPin, ...r } = l; void x; void y; void rotation; void skewX; void skewY; void cornerPin; return r })),
    JSON.stringify(localGroups.value),
    JSON.stringify(layers.value),
    Object.keys(wiredImageEls.value).length,
    frameSourceEpoch.value,
  ] as const,
  scheduleThumbs,
  { immediate: true },
)
onBeforeUnmount(() => {
  if (thumbTimer) { clearTimeout(thumbTimer); thumbTimer = null }
  if (thumbCancel) { thumbCancel(); thumbCancel = null }
})

// ── Property-panel helpers ───────────────────────────────────────────────────
// Sizes read in true output px when the artboard has an explicit resolution
// (so the number is stable regardless of display/zoom); else fall back to the
// editor-canvas width.
const outWidth = computed(() => {
  const node = compositor.value
  const defs = node?.data?.widgetDefs as any[] | undefined
  const wv = node?.data?.widgetsValues as any[] | undefined
  const wi = defs?.findIndex((d: any) => d.name === 'width') ?? -1
  const w = wi >= 0 ? Number(wv?.[wi]) || 0 : 0
  return w || canvasDisplay.w
})
function pxW(norm: number) { return Math.round(norm * outWidth.value) }
function setSizePx(id: string, key: string, px: number) { setLocal(id, { [key]: Math.max(0, px) / outWidth.value }) }

// A shape's stroke needs BOTH a colour and a width > 0 to show. New shapes start
// at strokeWidth 0, so adding a stroke colour alone paints nothing — the stroke
// reads as "didn't work". When a colour is added to a widthless stroke, give it a
// visible default (~6px on a standard frame), Figma-style; removing the colour
// (→ 'none') leaves the width alone so re-adding restores it.
const DEFAULT_STROKE_W = 0.005 // normalized to canvas width
function setStroke(id: string, v: any) {
  const l = localLayers.value.find((x: any) => x.id === id) as any
  const addingColour = v && v !== 'none' && !((l?.strokeWidth as number) > 0)
  setLocal(id, addingColour ? { stroke: v, strokeWidth: DEFAULT_STROKE_W } : { stroke: v })
}
/** True when a layer actually has a stroke — the width / alignment / dash rows are
 *  meaningless without one, so they only show once a stroke exists (the FillControl's
 *  "Add" is the sole affordance until then). Shapes/lines/paths use `stroke`; text
 *  uses `strokeColor`. */
function hasStroke(l: any): boolean {
  const s = l?.stroke ?? l?.strokeColor
  return !!s && s !== 'none'
}

// ── Corner radius (linked ⇔ per-corner) ──────────────────────────────────────
// A rect stores `radius` as ONE number (uniform) or as [tl, tr, br, bl]. The
// linked field writes a plain number — editing it always re-links all four —
// and the expand toggle reveals the four per-corner fields. Displayed values are
// the STORED ones (unclamped): the painter clamps to half the shorter side, so a
// squashed rect still remembers the radius you typed.
const radiusExpanded = ref(false)
// The radius array is stored clockwise [tl, tr, br, bl], but the 2-column grid
// fills left-to-right per row — so the fields are laid out in SPATIAL order
// (tl, tr on the top row; bl, br on the bottom row), each carrying its real
// array index. Iterating the array order instead put "Bottom right" (index 2)
// in the bottom-LEFT cell.
const CORNER_FIELDS = [
  { label: 'Top left', i: 0 },
  { label: 'Top right', i: 1 },
  { label: 'Bottom left', i: 3 },
  { label: 'Bottom right', i: 2 },
]
function radiusCorners(l: any): number[] {
  const r = l?.radius
  const one = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return Array.isArray(r) ? [one(r[0]), one(r[1]), one(r[2]), one(r[3])] : [one(r), one(r), one(r), one(r)]
}
/** A doc that already carries four corners opens expanded, whatever the toggle says. */
const radiusRowExpanded = computed(() => radiusExpanded.value || Array.isArray((selectedLocal.value as any)?.radius))
/** The linked field shows the largest corner when they differ (a number input can't say "mixed"). */
function radiusLinkedPx(l: any) { return pxW(Math.max(...radiusCorners(l))) }
function setRadiusLinkedPx(l: any, px: number) { setLocal(l.id, { radius: Math.max(0, px) / outWidth.value }) }
function setRadiusCornerPx(l: any, i: number, px: number) {
  const c = radiusCorners(l)
  c[i] = Math.max(0, px) / outWidth.value
  setLocal(l.id, { radius: [c[0]!, c[1]!, c[2]!, c[3]!] })
}
function toggleRadiusExpanded(l: any) {
  if (radiusRowExpanded.value) {
    // Collapsing re-links: the four corners fold back to the largest of them.
    if (Array.isArray(l?.radius)) setLocal(l.id, { radius: Math.max(...radiusCorners(l)) })
    radiusExpanded.value = false
  } else radiusExpanded.value = true
}

// ── Expressive text layout ────────────────────────────────────────────────
function setExpressive(l: any, patch: Partial<ExpressiveParams>) {
  if (!l) return
  const cur: ExpressiveParams = l.expressive || defaultExpressiveParams()
  setLocal(l.id, { expressive: { ...cur, ...patch } } as any)
}
function toggleExpressive(l: any) {
  if (!l) return
  setLocal(l.id, { expressive: l.expressive ? undefined : defaultExpressiveParams() } as any)
}
function rerollExpressive(l: any) {
  if (!l?.expressive) return
  setExpressive(l, { seed: ((l.expressive.seed | 0) + 1) })
}

// ── Expressive group arrangement (scatter a group's members) ────────────────
const outHeight = computed(() => {
  const node = compositor.value
  const defs = node?.data?.widgetDefs as any[] | undefined
  const wv = node?.data?.widgetsValues as any[] | undefined
  const hi = defs?.findIndex((d: any) => d.name === 'height') ?? -1
  const h = hi >= 0 ? Number(wv?.[hi]) || 0 : 0
  return h || canvasDisplay.h
})
let _measureCanvas: HTMLCanvasElement | null = null
function measureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas')
  return _measureCanvas.getContext('2d')
}
function groupMemberLayers(gid: string): any[] {
  const ids = new Set(directLayerIds(gid, localLayers.value as any))
  return (localLayers.value as any[]).filter(l => ids.has(l.id))
}
function memberSizePx(layer: any, W: number, H: number): { w: number; h: number } {
  const box = localLayerBox(measureCtx(), layer, W, H)
  return { w: Math.max(1, box.w), h: Math.max(1, box.h) }
}
/** (Re)scatter a group's direct members within its box using the given params,
 *  baking the computed centre/rotation into each member layer. Persists params +
 *  the (possibly newly-snapshotted) box in ONE registry write — no re-read of
 *  reactive group state between steps. */
function arrangeGroupWith(gid: string, params: ExpressiveBoxParams) {
  const g = localGroups.value.find(x => x.id === gid)
  const members = groupMemberLayers(gid)
  if (!members.length) return
  const W = outWidth.value, H = outHeight.value
  const sized = members.map(l => ({ layer: l, ...memberSizePx(l, W, H) }))
  // Frozen box if already snapshotted, else snapshot the current bounds now.
  const boxNorm = g?.expressiveBox
    ?? (() => {
      const bb = unionBBoxPx(sized.map(s => ({ cx: W / 2 + s.layer.x * W, cy: H / 2 + s.layer.y * H, wPx: s.w, hPx: s.h })))
      return { x: bb.x / W, y: bb.y / H, w: bb.w / W, h: bb.h / H }
    })()
  const boxPx = { x: boxNorm.x * W, y: boxNorm.y * H, w: boxNorm.w * W, h: boxNorm.h * H }
  writeGroups(upsertGroup(localGroups.value, gid, { expressive: params, expressiveBox: boxNorm }))
  const results = arrangeMembers(sized.map(s => ({ id: s.layer.id, wPx: s.w, hPx: s.h })), boxPx, params)
  for (const r of results) setLocal(r.id, { x: (r.cx - W / 2) / W, y: (r.cy - H / 2) / H, rotation: r.rotation } as any)
}
function toggleGroupExpressive(gid: string, on: boolean) {
  if (on) arrangeGroupWith(gid, defaultExpressiveBoxParams())
  else writeGroups(upsertGroup(localGroups.value, gid, { expressive: undefined, expressiveBox: undefined }))
}
function setGroupExpressive(gid: string, patch: Partial<ExpressiveBoxParams>) {
  const cur = localGroups.value.find(x => x.id === gid)?.expressive ?? defaultExpressiveBoxParams()
  arrangeGroupWith(gid, { ...cur, ...patch })
}
function rerollGroupExpressive(gid: string) {
  const cur = localGroups.value.find(x => x.id === gid)?.expressive
  if (cur) setGroupExpressive(gid, { seed: (cur.seed | 0) + 1 })
}
/** The group id when the current selection is exactly one whole group's members
 *  (≥2), else null — drives the inspector's Expressive-group panel. */
const soleSelectedGroup = computed<string | null>(() => {
  const sel = selectedIds.value
  if (sel.size < 2) return null
  for (const gid of allGroupIds(localLayers.value as any, localGroups.value)) {
    const members = layersInGroup(gid, localLayers.value as any, localGroups.value)
    if (members.length >= 2 && members.length === sel.size && members.every(id => sel.has(id))) return gid
  }
  return null
})
const soleSelectedGroupExpr = computed<ExpressiveBoxParams | undefined>(() =>
  soleSelectedGroup.value ? localGroups.value.find(g => g.id === soleSelectedGroup.value)?.expressive : undefined)

// ── Drop-shadow layer effect ────────────────────────────────────────────────
// Stored on layer.effects as a single drop_shadow; rendered by drawLocalLayer
// (and baked identically). color is an rgba string (hex picker + opacity).
function parseRgba(s: string): { hex: string, a: number } {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(s || '')
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
    return { hex, a: m[4] != null ? parseFloat(m[4]) : 1 }
  }
  return { hex: (s && s.startsWith('#')) ? s.slice(0, 7) : '#000000', a: 1 }
}
function composeRgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`
}
function localShadow(l: any): any | undefined { return l?.effects?.find((e: any) => e.type === 'drop_shadow') }
function shadowHex(l: any): string { return parseRgba(localShadow(l)?.color || '').hex }
function shadowAlpha(l: any): number { return parseRgba(localShadow(l)?.color || '').a }
function setLocalShadow(l: any, patch: Record<string, any>) {
  if (!l) return
  const cur = localShadow(l) || { type: 'drop_shadow', color: 'rgba(0, 0, 0, 0.35)', x: 0, y: 0.012, blur: 0.03, visible: true }
  const next = { ...cur, ...patch }
  setLocal(l.id, { effects: [...((l.effects || []).filter((e: any) => e.type !== 'drop_shadow')), next] })
}
function toggleLocalShadow(l: any) {
  if (!l) return
  if (localShadow(l)) setLocal(l.id, { effects: (l.effects || []).filter((e: any) => e.type !== 'drop_shadow') })
  else setLocalShadow(l, {})
}
function setShadowHex(l: any, raw: string) {
  let h = '#' + (raw || '').trim().replace(/^#/, '')
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(h)
  if (m3) h = '#' + m3[1].split('').map(c => c + c).join('')
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return // ignore partial/invalid input
  setLocalShadow(l, { color: composeRgba(h, shadowAlpha(l)) })
}

// ── Clip mask ───────────────────────────────────────────────────────────────
function layerMask(l: any): any | undefined { return l?.mask }
function setLayerMask(l: any, patch: Record<string, any>) {
  if (!l) return
  const cur = l.mask || {
    kind: 'ellipse',
    x: l.x ?? 0.5, y: l.y ?? 0.5,
    w: (l.w ?? 0.4), h: (l.h ?? l.w ?? 0.4),
  }
  setLocal(l.id, { mask: { ...cur, ...patch } })
}
function toggleLayerMask(l: any) {
  if (!l) return
  if (l.mask) setLocal(l.id, { mask: undefined })
  else setLayerMask(l, {})
}

// ── Layer blur effect ───────────────────────────────────────────────────────
function layerBlur(l: any): any | undefined { return l?.effects?.find((e: any) => e.type === 'layer_blur') }
function setLayerBlur(l: any, radius: number) {
  if (!l) return
  const others = (l.effects || []).filter((e: any) => e.type !== 'layer_blur')
  setLocal(l.id, { effects: radius > 0 ? [...others, { type: 'layer_blur', radius, visible: true }] : others })
}
function toggleLayerBlur(l: any) {
  if (!l) return
  if (layerBlur(l)) setLocal(l.id, { effects: (l.effects || []).filter((e: any) => e.type !== 'layer_blur') })
  else setLayerBlur(l, 0.02)
}

// ── Inner shadow (cast inward from the silhouette edge) ──────────────────────
function innerShadow(l: any): any | undefined { return l?.effects?.find((e: any) => e.type === 'inner_shadow') }
function innerShadowHex(l: any): string { return parseRgba(innerShadow(l)?.color || '').hex }
function innerShadowAlpha(l: any): number { return parseRgba(innerShadow(l)?.color || '').a }
function setInnerShadow(l: any, patch: Record<string, any>) {
  if (!l) return
  const cur = innerShadow(l) || { type: 'inner_shadow', color: 'rgba(0, 0, 0, 0.45)', x: 0, y: 0.008, blur: 0.02, visible: true }
  const next = { ...cur, ...patch }
  setLocal(l.id, { effects: [...((l.effects || []).filter((e: any) => e.type !== 'inner_shadow')), next] })
}
function toggleInnerShadow(l: any) {
  if (!l) return
  if (innerShadow(l)) setLocal(l.id, { effects: (l.effects || []).filter((e: any) => e.type !== 'inner_shadow') })
  else setInnerShadow(l, {})
}

// ── Background blur (blur what's behind the layer, within its silhouette) ───
function bgBlur(l: any): any | undefined { return l?.effects?.find((e: any) => e.type === 'background_blur') }
function setBgBlur(l: any, radius: number) {
  if (!l) return
  const others = (l.effects || []).filter((e: any) => e.type !== 'background_blur')
  setLocal(l.id, { effects: radius > 0 ? [...others, { type: 'background_blur', radius, visible: true }] : others })
}
function toggleBgBlur(l: any) {
  if (!l) return
  if (bgBlur(l)) setLocal(l.id, { effects: (l.effects || []).filter((e: any) => e.type !== 'background_blur') })
  else setBgBlur(l, 0.02)
}

// ── Feather (soften layer edges to transparent) ──────────────────────────────
function setFeather(l: any, patch: Record<string, any>) {
  if (!l) return
  const cur = l.feather || { ...DEFAULT_FEATHER }
  setLocal(l.id, { feather: { ...cur, ...patch } })
}
function toggleFeather(l: any, on: boolean) {
  if (!l) return
  setLocal(l.id, { feather: on ? { ...DEFAULT_FEATHER } : undefined })
}

// ── Torn paper edge ─────────────────────────────────────────────────────────
function setTornEdge(l: any, patch: Record<string, any>) {
  if (!l) return
  const cur = l.tornEdge || { ...DEFAULT_TORN_EDGE }
  setLocal(l.id, { tornEdge: { ...cur, ...patch } })
}
function toggleTornEdge(l: any, on: boolean) {
  if (!l) return
  setLocal(l.id, { tornEdge: on ? { ...DEFAULT_TORN_EDGE } : undefined })
}

// ── Displacement map (this image layer warps everything below it) ───────────
function localDisplace(l: any): any | undefined { return l?.displaceMap }
function setLocalDisplace(l: any, patch: Record<string, any>) {
  if (!l) return
  const cur = localDisplace(l) || { ...DEFAULT_DISPLACE_MAP }
  setLocal(l.id, { displaceMap: { ...cur, ...patch } })
}
function toggleLocalDisplace(l: any) {
  if (!l) return
  if (localDisplace(l)) setLocal(l.id, { displaceMap: undefined })
  else setLocalDisplace(l, {})
}

// Blend modes shared with the backend Compositor's layer{N}_blend combo (and
// WIRED_BLEND_OP in the draw engine) — keep all three lists in sync.
const LOCAL_BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light',
  'difference', 'lighten', 'darken', 'add',
]

// Full Google-Fonts weight range; the loader requests 100..900 optimistically
// and the browser snaps to the nearest weight the family actually has.
const FONT_WEIGHTS = [
  { v: 100, label: 'Thin' }, { v: 200, label: 'Extra Light' }, { v: 300, label: 'Light' },
  { v: 400, label: 'Regular' }, { v: 500, label: 'Medium' }, { v: 600, label: 'Semi Bold' },
  { v: 700, label: 'Bold' }, { v: 800, label: 'Extra Bold' }, { v: 900, label: 'Black' },
]

// ── Layer mask (this layer is clipped by another layer's silhouette) ─────────
function layerLabelByKey(key: StackKey): string {
  const r = resolveStackKey(key)
  if (!r) return key
  if (r.type === 'wired') return wiredLabel((r.layer as Layer).slot)
  return `${r.layer.kind} ${String(r.layer.id).slice(-4)}`
}
// Candidate mask sources for the selected layer: every other present layer (cross-source).
function maskCandidates(selfKey: StackKey): { key: StackKey; label: string }[] {
  return maskCandidateKeys(presentKeys.value, selfKey).map(k => ({ key: k, label: layerLabelByKey(k) }))
}
// Current mask ref for any selected key (local → layerMaskRef; wired → treatments).
function currentMaskRef(key: StackKey): string {
  const r = resolveStackKey(key)
  if (!r) return ''
  if (r.type === 'local') return layerMaskRef(r.layer) ?? ''
  return wiredTreatments.value[key]?.maskedByKey ?? ''
}
// Set the mask ref for any selected key.
function setMaskRef(key: StackKey, ref: string) {
  const r = resolveStackKey(key)
  if (!r) return
  if (r.type === 'local') setLocal(r.layer.id, { maskedByKey: ref || undefined, maskedById: undefined } as any)
  else setWiredMask(compositor.value, (r.layer as Layer).slot, ref)
}
// Whether the mask source for this key is also shown at its own z-position.
function maskShowSource(key: StackKey): boolean {
  const r = resolveStackKey(key)
  if (!r) return false
  if (r.type === 'local') return !!(r.layer as any).maskShowSource
  return !!wiredTreatments.value[key]?.showSource
}
// Toggle the showSource flag for the mask source of the selected key.
function setMaskShowSource(key: StackKey, show: boolean) {
  const r = resolveStackKey(key)
  if (!r) return
  if (r.type === 'local') setLocal(r.layer.id, { maskShowSource: show || undefined } as any)
  else setWiredMaskShowSource(compositor.value, (r.layer as Layer).slot, show)
}

// ── Mask break-out: open the mask on one edge so a masked subject escapes it ─
/** The current mask layer's normalized box for the selected layer, or null. */
function maskBreakBox(): { x: number; y: number; w: number; h: number } | null {
  const l = selectedLocal.value
  if (!l) return null
  const ref = currentMaskRef(localKey(l.id))
  if (!ref) return null
  const m = localLayers.value.find(x => `l:${x.id}` === ref)   // local shape masks only (v1)
  if (!m) return null
  const b = localLayerBox(null, m as any, 1, 1)
  return { x: (m as any).x, y: (m as any).y, w: b.w, h: b.h }
}
/** True only when the selected layer's mask is a LOCAL shape (a break-out can open it). */
function maskIsLocalShape(): boolean {
  const l = selectedLocal.value; if (!l) return false
  const ref = currentMaskRef(localKey(l.id))
  return !!ref && ref.startsWith('l:') && !!maskBreakBox()
}
function selectedBreak(): MaskBreak | null { return (selectedLocal.value as any)?.maskBreak ?? null }
function breakEdge(): MaskBreakEdge {
  const a = ((selectedBreak()?.angle ?? 0) % 360 + 360) % 360
  return a === 180 ? 'bottom' : a === 270 ? 'left' : a === 90 ? 'right' : 'top'
}
/** Recover the 0..1 offset the break sits at, from the break + the mask box. */
function breakOffset(): number {
  const b = selectedBreak(); const box = maskBreakBox(); if (!b || !box) return 0
  const e = breakEdge()
  if (e === 'top')    return box.h ? (b.y - (box.y - box.h / 2)) / box.h : 0
  if (e === 'bottom') return box.h ? ((box.y + box.h / 2) - b.y) / box.h : 0
  if (e === 'left')   return box.w ? (b.x - (box.x - box.w / 2)) / box.w : 0
  return box.w ? ((box.x + box.w / 2) - b.x) / box.w : 0
}
function setBreakEnabled(on: boolean) {
  const l = selectedLocal.value; const box = maskBreakBox(); if (!l) return
  setLocal(l.id, { maskBreak: on && box ? maskBreakFromEdge('top', box, 0) : undefined } as any)
  renderStack()
}
function setBreakEdge(e: MaskBreakEdge) {
  const l = selectedLocal.value; const box = maskBreakBox(); if (!l || !box) return
  setLocal(l.id, { maskBreak: maskBreakFromEdge(e, box, breakOffset()) } as any); renderStack()
}
function setBreakOffset(v: number) {
  const l = selectedLocal.value; const box = maskBreakBox(); if (!l || !box) return
  setLocal(l.id, { maskBreak: maskBreakFromEdge(breakEdge(), box, Math.max(0, Math.min(1, v))) } as any); renderStack()
}

// ── Generative Fill: regenerate a region of an image in place ────────────────
// A "Generate" mode where you mark a region directly on the canvas — drag a Box,
// paint with a Brush, or promote a selected Shape — and inpaint ONLY that region
// of the target image (surrounding pixels are kept). The region is painted in
// artboard pixels and projected onto the target image's own pixels through the
// inverse of its draw transform, so it's correct under scale and rotation.
const inpaint = useInpaint()
const genPrompt = ref('')

// Generate Object: new-layer generation has two modes — Style (prompt, optional
// trained LoRA) and Scene (fit the existing frame). Both output a transparent
// cutout. Only shown when there's no target image (i.e. making a NEW layer).
type GenMode = 'style' | 'scene'
const genMode = ref<GenMode>('style')
const styleList = useStyleList()
const genStyle = ref<import('~/composables/useStyleList').StyleItem | null>(null)
const stylePickerOpen = ref(false)
// Generation model: Flux Schnell (fast/cheap, supports trained styles) vs Nano
// Banana 2 (higher quality, scene-aware; pricier, no trained styles).
type GenModel = 'flux' | 'nano'
const GEN_MODELS: { id: GenModel; name: string; hint: string }[] = [
  { id: 'flux', name: 'Flux Schnell', hint: 'Fast and cheap' },
  { id: 'nano', name: 'Nano Banana Pro', hint: 'Top quality, scene-aware — slower & pricier' },
]
const genModel = ref<GenModel>('flux')
const modelPickerOpen = ref(false)
const currentModel = computed(() => GEN_MODELS.find(m => m.id === genModel.value) ?? GEN_MODELS[0]!)
// The trained-style picker only applies to Flux object generation.
const showStylePicker = computed(() => genModel.value === 'flux' && genMode.value === 'style')

// After a new-object generation, a mini toolbar (cancel / re-roll / confirm)
// anchors to the result. We keep the region snapshot + bounds so re-roll can
// regenerate with the exact same area and settings.
type GenBounds = { minX: number; minY: number; maxX: number; maxY: number }
const genResult = ref<{ layerId: string; mask: HTMLCanvasElement; bnd: GenBounds } | null>(null)

type GenTool = 'box' | 'brush' | 'shape'
const GEN_TOOLS: GenTool[] = ['box', 'brush', 'shape']
const genActive = ref(false)
const genTool = ref<GenTool>('brush')
const genBrush = ref(56)                  // brush diameter, artboard px
const genTargetId = ref<string | null>(null)
const genVersion = ref(0)                 // bump → repaint the tinted overlay
const genHasMask = ref(false)
const genCursor = reactive({ x: -999, y: -999, on: false })

// Source-of-truth region mask: opaque white on transparent, in artboard px.
let genMaskCanvas: HTMLCanvasElement | null = null
function genMaskCtx(): CanvasRenderingContext2D | null {
  const W = Math.max(1, Math.round(canvasDisplay.w)), H = Math.max(1, Math.round(canvasDisplay.h))
  if (!genMaskCanvas) genMaskCanvas = document.createElement('canvas')
  if (genMaskCanvas.width !== W || genMaskCanvas.height !== H) { genMaskCanvas.width = W; genMaskCanvas.height = H }
  return genMaskCanvas.getContext('2d')
}
function clearGenMask() {
  const ctx = genMaskCtx()
  if (ctx && genMaskCanvas) ctx.clearRect(0, 0, genMaskCanvas.width, genMaskCanvas.height)
  genHasMask.value = false; genVersion.value++
}

// Target image layer: locked at enter to the SELECTED image, if any. No
// selection → null → generate a brand-new image (never grab an existing one).
const genTarget = computed<any | null>(() =>
  genTargetId.value
    ? localLayers.value.find((l: any) => l.id === genTargetId.value && l.kind === 'image') ?? null
    : null,
)
const genTargetLabel = computed(() => {
  const t = genTarget.value
  if (!t) return 'New layer'   // no image target → generate against the composite
  return `Image ${localLayers.value.filter((l: any) => l.kind === 'image').indexOf(t) + 1}`
})
const genShapeCandidate = computed(() => {
  const l = selectedLocal.value
  return l && (l.kind === 'rect' || l.kind === 'ellipse' || l.kind === 'path' || l.kind === 'line') ? l : null
})

function enterGenMode() {
  // Lock the target to the selected image (if any) at the moment we enter;
  // nothing selected → new image.
  const sel = selectedLocal.value?.kind === 'image' ? selectedLocal.value.id : null
  if (!exitOtherToolsFor('region')) return
  genActive.value = true
  genTargetId.value = sel
  genStyle.value = null
  stylePickerOpen.value = false
  styleList.refresh()
  clearGenMask()
}
function exitGenMode() { genActive.value = false; genCursor.on = false; clearGenMask(); genResult.value = null }
function toggleGenMode() { genActive.value ? exitGenMode() : enterGenMode() }

// ── Wired-image mask target: resolves a selected wired image + its live,
// per-slot brush-mask canvas (capped image px), used by Brush Mask mode below. ─
// The wired image slot currently eligible as a brush mask target (a selected
// wired image with a ready element), else null.
function selectedWiredImage(): { slot: number; el: HTMLImageElement | HTMLCanvasElement } | null {
  // The selection is unified: a wired image is a selected LAYER whose kind is
  // 'wired'. Its `slot` is 0-based; everything downstream (treatments, image
  // elements) is this modal's 1-based numbering, so shift once, here.
  const l = selectedLocal.value as any
  if (!l || l.kind !== 'wired') return null
  const slot = l.slot + 1
  const el = wiredImageEls.value[slot]
  return el ? { slot, el } : null
}
// Current wired mask URL for a slot (if any) — gates the "Clear mask"
// affordance in the Smart select and Brush→Mask panels.
function wiredMaskUrlFor(slot: number): string | undefined {
  return wiredTreatments.value[`w:${slot}`]?.maskUrl
}
// Recovery path for the non-undoable wired mask (see the note near
// smartHideWired): drops the slot's maskUrl treatment and re-renders.
function clearWiredMask(slot: number) {
  setWiredMaskUrl(compositor.value, slot, '')
  renderStack()
}
// ── Copy a wired image into the frame ───────────────────────────────────────
// Bakes what you SEE for a wired slot (source pixels + any painted/smart-select
// mask) into a normal local image layer at the same z-position, transform,
// opacity and blend — then hides the wired slot so you see one image, not two.
// The frame then owns the image: it survives unplugging the wire and supports
// every local-layer feature (Generate fill, destructive edits, …).
const copyingSlot = ref<number | null>(null)
async function copyWiredIntoFrame(slot: number) {
  if (copyingSlot.value != null) return
  const layer = layers.value.find(l => l.slot === slot)
  const el = wiredImageEls.value[slot]
  const iw = el ? (('naturalWidth' in el ? el.naturalWidth : el.width) || 0) : 0
  const ih = el ? (('naturalHeight' in el ? el.naturalHeight : el.height) || 0) : 0
  if (!layer || !el || !iw || !ih) { toast('That layer’s image isn’t ready yet'); return }
  copyingSlot.value = slot
  try {
    // 1. Bake: native-resolution source with the slot's visibility mask applied
    //    (destination-out — same polarity drawWiredImageLayer uses).
    const c = document.createElement('canvas'); c.width = iw; c.height = ih
    const ctx = c.getContext('2d')!
    ctx.drawImage(el, 0, 0, iw, ih)
    const tr = wiredTreatments.value[`w:${slot}`]
    if (tr?.maskUrl) {
      try {
        const mi = await loadImage(tr.maskUrl)
        ctx.globalCompositeOperation = 'destination-out'
        ctx.drawImage(mi, 0, 0, iw, ih)
        ctx.globalCompositeOperation = 'source-over'
      } catch { /* unreadable mask → copy the image unmasked rather than failing */ }
    }
    let dataUrl: string
    try { dataUrl = c.toDataURL('image/png') }
    catch (err) {
      console.error('[Compositor] copy into frame: pixel read failed', err)
      toast('Can’t read this image’s pixels')
      return
    }
    const name = await inpaint.uploadDataUrl(dataUrl, 'framecopy')
    // 2. Place it exactly where the wired image sits. A full-image bbox makes
    //    wiredCutoutPlacement reproduce the wired transform (its own unit test).
    const place = wiredCutoutPlacement(
      { minX: 0, minY: 0, maxX: iw - 1, maxY: ih - 1 },
      { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation },
      iw, ih, iw, ih, canvasDisplay.w, canvasDisplay.h,
    )
    // On a schema-2 frame the slot's clip ref lives on its LAYER — migration
    // remapped `treatments['w:N'].maskedByKey`/`showSource` onto the layer's
    // `maskedByKey`/`maskShowSource` (repointing any `w:` key to `l:<id>` too)
    // but left the registry entry itself un-remapped for rollback, so it's
    // stale once a layer claims the slot. Prefer the layer; fall back to the
    // registry only pre-migration, when no layer claims the slot at all.
    const wl = wiredLayerForSlot1(slot)
    const maskedByKey = wl ? wl.maskedByKey : tr?.maskedByKey
    const maskShowSource = wl ? wl.maskShowSource : tr?.showSource
    const before = new Set(localLayers.value.map(l => l.id))
    addImageFromName(name, iw / ih, {
      ...place,
      opacity: layer.opacity,
      blend: layer.blend,
      // A wired image clipped by another layer's silhouette stays clipped —
      // carried as the same treatment rather than baked into the pixels.
      ...(maskedByKey ? { maskedByKey, maskShowSource: maskShowSource || undefined } : {}),
    } as any)
    const added = localLayers.value.find(l => !before.has(l.id))
    // 3. Hold the wired slot's z-position (else the copy jumps to the top). On a
    //    schema-2 frame the slot's key in the stack is its LAYER's `l:<id>`, not
    //    the legacy `w:<slot>` — anchoring to the dead key would silently leave
    //    the copy on top of everything.
    const anchorKey = wl ? localKey(wl.id) : wiredKey(slot)
    if (added) writeStackOrder(insertStackKeyAbove(stackKeys.value, localKey(added.id), anchorKey) as StackKey[])
    // 4. Hide the now-redundant wired slot — only after the copy landed, so a
    //    failed upload never leaves an empty frame.
    setWiredHidden(slot, true)
    if (layer.cloner?.enabled) toast('Copied the base image — cloner repeats aren’t carried over.')
    renderStack()
  } catch (err) {
    console.error('[Compositor] copy into frame failed:', err)
    toast('Could not copy that layer into the frame')
  } finally {
    copyingSlot.value = null
  }
}
function compositorLayer(slot: number): Layer | undefined {
  return layers.value.find(l => l.slot === slot)
}
// Live per-slot mask canvas (capped image px) seeded from the slot's maskUrl.
// Reset (see the selectedLocalId/brush watchers above) whenever the target slot,
// or brush activation, changes — so a stale slot's canvas is never reused.
let wiredBrushMask: { slot: number; canvas: HTMLCanvasElement } | null = null
async function ensureWiredBrushMask(slot: number, el: HTMLImageElement | HTMLCanvasElement): Promise<HTMLCanvasElement> {
  if (wiredBrushMask?.slot === slot) return wiredBrushMask.canvas
  const iw = ('naturalWidth' in el ? el.naturalWidth : el.width) || 1
  const ih = ('naturalHeight' in el ? el.naturalHeight : el.height) || 1
  const { w: capW, h: capH } = capDims(iw, ih)
  const c = document.createElement('canvas'); c.width = capW; c.height = capH
  const existing = wiredTreatments.value[`w:${slot}`]?.maskUrl
  if (existing) { try { const im = await loadImage(existing); c.getContext('2d')!.drawImage(im, 0, 0, capW, capH) } catch { /* start empty */ } }
  wiredBrushMask = { slot, canvas: c }
  return c
}
// Paint a width-normalized brush stroke into a wired image's mask canvas
// (image px). Plain stroke → WHITE (hide); erase stroke → destination-out
// (restore). `artW` is the artboard width the stroke's points/radius are
// normalized against (canvasDisplay.w); `aff` maps artboard px → image px.
function stampWidthNormStrokeToMask(mctx: CanvasRenderingContext2D, s: PaintStroke, aff: Affine, artW: number) {
  const pts = s.points.map(p => applyAffine(aff, { x: p.x * artW, y: p.y * artW /* width-normalized: both axes ÷ artboard width */ }))
  if (!pts.length) return
  // width-normalized radius → artboard px (strokeRadiusPx) → image px, scaled
  // by the affine's uniform scale factor (|aff| via a/b since rotation preserves length).
  const scale = Math.hypot(aff.a, aff.b)
  const r = strokeRadiusPx(s, artW) * scale
  mctx.save()
  mctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#fff'; mctx.lineCap = 'round'; mctx.lineJoin = 'round'; mctx.lineWidth = r * 2
  mctx.beginPath(); mctx.moveTo(pts[0]!.x, pts[0]!.y)
  for (const p of pts.slice(1)) mctx.lineTo(p.x, p.y)
  mctx.stroke()
  for (const p of pts) { mctx.beginPath(); mctx.arc(p.x, p.y, r, 0, Math.PI * 2); mctx.fill() }
  mctx.restore()
}

// ── Brush painting: freehand strokes commit to a BrushLayer via the editor ────
// The brush layer strokes land on. Reuse the selected brush layer, else create one.
let brushLayerId: string | null = null
function activeBrushLayer(): BrushLayer | null {
  const sel = selectedLocal.value
  if (sel && sel.kind === 'brush') return sel as BrushLayer
  if (brushLayerId) { const l = localLayers.value.find(x => x.id === brushLayerId); if (l && l.kind === 'brush') return l as BrushLayer }
  return null
}
function onBrushPointerDown(e: PointerEvent) {
  const p = clientToNorm(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  canvasRef.value?.setPointerCapture?.(e.pointerId)
  // clientToNorm returns ny as a fraction of HEIGHT; strokes are stored
  // width-normalized, so rescale Y by the aspect before handing to the engine.
  // The cursor ring keeps the SCREEN-normalized coord (its template scales by H).
  const wn = toWidthNorm(p.nx, p.ny, canvasDisplay.w, canvasDisplay.h)
  brush.beginStroke(wn.x, wn.y, canvasDisplay.w)
  brush.cursor.value = { x: p.nx, y: p.ny }
  renderStack() // show the live stroke immediately (see Task 4 overlay hook)
}
function onBrushPointerMove(e: PointerEvent) {
  const p = clientToNorm(e); if (!p) return
  brush.cursor.value = { x: p.nx, y: p.ny }
  if (!brush.hasLiveStroke.value) return
  const wn = toWidthNorm(p.nx, p.ny, canvasDisplay.w, canvasDisplay.h)
  brush.extendStroke(wn.x, wn.y)
  renderStack()
}
async function onBrushPointerUp() {
  const s = brush.endStroke(); if (!s) { return }
  // Mask mode: paint the freehand stroke as visibility onto the selected layer
  // (destination-in at render time for local layers; via maskUrl for wired
  // images). Needs a selected non-brush target; else no-op.
  if (brush.mode.value === 'mask') {
    const wired = selectedWiredImage()
    if (wired) {
      const el = wired.el
      const iw = ('naturalWidth' in el ? el.naturalWidth : el.width) || 1
      const ih = ('naturalHeight' in el ? el.naturalHeight : el.height) || 1
      const { w: capW, h: capH } = capDims(iw, ih)
      const canvas = await ensureWiredBrushMask(wired.slot, el)
      const mctx = canvas.getContext('2d')!
      const layer = compositorLayer(wired.slot)
      const aff = wiredImageAffine(
        { x: layer?.x ?? 0, y: layer?.y ?? 0, scale: layer?.scale ?? 1, rotation: layer?.rotation ?? 0 },
        canvasDisplay.w, canvasDisplay.h, iw, ih, capW, capH,
      )
      stampWidthNormStrokeToMask(mctx, s, aff, canvasDisplay.w)
      setWiredMaskUrl(compositor.value, wired.slot, canvas.toDataURL('image/png'))
      renderStack()
      return
    }
    const sel = selectedLocal.value
    if (sel && sel.kind !== 'brush') {
      // Store the stroke in the layer's LOCAL frame so the mask follows the layer
      // when it's moved/rotated (applyStrokeMask replays the same translate+rotate).
      const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
      const local = maskStrokeToLocal(s, { x: sel.x ?? 0.5, y: sel.y ?? 0.5, rotation: sel.rotation ?? 0 }, aspect)
      setLocal(sel.id, { maskStrokes: [...(sel.maskStrokes ?? []), local] })
    }
    return
  }
  const existing = activeBrushLayer()
  // An erase-only first stroke has nothing to carve — don't spawn an empty,
  // invisible brush layer (FIX #8). Only guard when there's no layer to append to.
  if (!existing && s.erase) return
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  if (existing) {
    const strokes = [...existing.strokes, s]
    // Re-fit the layer box to the painted bounds so selection/handles hug the marks.
    setLocal(existing.id, { strokes, ...brushBoxFromStrokes(strokes, aspect) })
    brushLayerId = existing.id
  } else {
    const strokes = [s]
    const layer = createBrushLayer({ strokes, fill: brush.color.value, ...brushBoxFromStrokes(strokes, aspect) })
    addLocal(layer)            // records history + selects
    brushLayerId = layer.id
  }
}

// ── Region painting (all tools write into the one artboard-space mask) ───────
const genDraw = ref<{ tool: GenTool; x0: number; y0: number; lx: number; ly: number } | null>(null)
function genPointFromEvent(e: PointerEvent) {
  const p = clientToNorm(e); if (!p) return null
  return { x: p.nx * canvasDisplay.w, y: p.ny * canvasDisplay.h }
}
function genStrokeTo(x: number, y: number) {
  const ctx = genMaskCtx(); if (!ctx) return
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = genBrush.value
  if (genDraw.value) { ctx.beginPath(); ctx.moveTo(genDraw.value.lx, genDraw.value.ly); ctx.lineTo(x, y); ctx.stroke() }
  ctx.beginPath(); ctx.arc(x, y, genBrush.value / 2, 0, Math.PI * 2); ctx.fill()
}
function genBoxTo(x0: number, y0: number, x1: number, y1: number) {
  const ctx = genMaskCtx(); if (!ctx || !genMaskCanvas) return
  ctx.clearRect(0, 0, genMaskCanvas.width, genMaskCanvas.height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
}
function onGenPointerDown(e: PointerEvent) {
  const p = genPointFromEvent(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  canvasRef.value?.setPointerCapture?.(e.pointerId)
  genDraw.value = { tool: genTool.value, x0: p.x, y0: p.y, lx: p.x, ly: p.y }
  if (genTool.value === 'brush') genStrokeTo(p.x, p.y)
  else genBoxTo(p.x, p.y, p.x, p.y)
  genHasMask.value = true; genVersion.value++
}
function onGenPointerMove(e: PointerEvent) {
  if (!genDraw.value) return
  const p = genPointFromEvent(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  if (genDraw.value.tool === 'brush') { genStrokeTo(p.x, p.y); genDraw.value.lx = p.x; genDraw.value.ly = p.y }
  else genBoxTo(genDraw.value.x0, genDraw.value.y0, p.x, p.y)
  genHasMask.value = true; genVersion.value++
}
function onGenPointerUp(e: PointerEvent) {
  if (!genDraw.value) return
  e.preventDefault(); e.stopPropagation()
  genDraw.value = null
}

// Fill a shape/path silhouette (the current fillStyle) — mirrors the renderer's
// per-kind geometry (1 unit = artboard width), so "Use shape" matches the canvas.
function drawMaskShape(ctx: CanvasRenderingContext2D, l: any, W: number) {
  if (l.kind === 'rect') {
    const w = l.w * W, h = l.h * W
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, cornerRadii(l.radius, w, h, W)); ctx.fill()
  } else if (l.kind === 'ellipse') {
    const w = l.w * W, h = l.h * W
    ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill()
  } else if (l.kind === 'path') {
    try {
      const p = new Path2D(l.d), s = (l.scale || 1) * W
      ctx.save(); ctx.scale(s, s); ctx.fill(p, l.fillRule || 'nonzero'); ctx.restore()
    } catch { /* bad path data */ }
  } else if (l.kind === 'line') {
    const w = l.w * W
    ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0)
    ctx.lineCap = 'round'; ctx.lineWidth = Math.max(10, (l.strokeWidth || 0.01) * W); ctx.stroke()
  }
}
function genUseShape() {
  const l = genShapeCandidate.value; const ctx = genMaskCtx()
  if (!l || !ctx) return
  ctx.save()
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'
  ctx.translate(l.x * canvasDisplay.w, l.y * canvasDisplay.h)
  if (l.rotation) ctx.rotate((l.rotation * Math.PI) / 180)
  drawMaskShape(ctx, l, canvasDisplay.w)
  ctx.restore()
  genHasMask.value = true; genVersion.value++
}

// Animated "generate in region" overlay (pulse fill + flowing pastel stroke) plus
// the glimm prism "generating" sweep — now shared with the Image-artifact Inpaint
// modal via the useRegionFx composable so both read as one design.
const genOverlayCanvas = ref<HTMLCanvasElement | null>(null)
const genSweepCanvas = ref<HTMLCanvasElement | null>(null)
const regionFx = useRegionFx({
  overlay: genOverlayCanvas,
  sweep: genSweepCanvas,
  getMask: () => (genHasMask.value && genMaskCanvas) ? genMaskCanvas : null,
  getDims: () => canvasDisplay,
  busy: () => inpaint.busy.value,
})
const { sweepMaskUrl: genSweepMaskUrl } = regionFx
watch(genActive, (on) => { on ? regionFx.start() : regionFx.stop() })
watch([genVersion, () => canvasDisplay.w, () => canvasDisplay.h], () => regionFx.rebuild())

// flux-dev's supported aspect ratios → nearest match for a region's bbox.
const FLUX_ASPECTS: [string, number][] = [
  ['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['3:2', 3 / 2], ['2:3', 2 / 3],
  ['4:5', 4 / 5], ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:4', 3 / 4], ['21:9', 21 / 9], ['9:21', 9 / 21],
]
function pickAspectRatio(r: number): string {
  let best = '1:1', bd = Infinity
  for (const [s, v] of FLUX_ASPECTS) { const d = Math.abs(Math.log(r / v)); if (d < bd) { bd = d; best = s } }
  return best
}
// Bounding box of the painted region (artboard px), or null if empty.
function genMaskBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!genMaskCanvas) return null
  const W = genMaskCanvas.width, H = genMaskCanvas.height
  const d = genMaskCanvas.getContext('2d')!.getImageData(0, 0, W, H).data
  let minX = W, minY = H, maxX = 0, maxY = 0, found = false
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 20) { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  return found ? { minX, minY, maxX, maxY } : null
}

// Generate inside the painted region. Two clear modes, driven by selection:
//  • an image is selected (target) → INPAINT within its own pixels (project the
//    artboard region through the inverse of its draw transform) and replace it.
//  • nothing selected → TEXT-TO-IMAGE: generate a brand-new image from the
//    prompt, sized to the region's bbox, dropped in as a new layer.
// Clone the live region mask so a generation result can be re-rolled later.
function cloneGenMask(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  if (genMaskCanvas) {
    c.width = genMaskCanvas.width; c.height = genMaskCanvas.height
    c.getContext('2d')!.drawImage(genMaskCanvas, 0, 0)
  }
  return c
}

// Generate a new transparent object from `maskCanvas`/`bnd` with the current
// mode/model/style, place it contained in the box, and return its layer id.
async function generateObjectInto(maskCanvas: HTMLCanvasElement, bnd: GenBounds): Promise<string | null> {
  const W = canvasDisplay.w, H = canvasDisplay.h
  const cx = (bnd.minX + bnd.maxX) / 2, cy = (bnd.minY + bnd.maxY) / 2
  const boxW = Math.max(1, bnd.maxX - bnd.minX), boxH = Math.max(1, bnd.maxY - bnd.minY)
  const prompt = genPrompt.value.trim() || 'subject'
  const aspect = pickAspectRatio(boxW / boxH)
  // Style: push hard for a WHOLE, uncropped object. Models (esp. flux-schnell)
  // otherwise zoom in and clip the subject at the frame. Scene keeps the bare
  // prompt — it fills the region to fit the frame.
  const objectPrompt = `${prompt}. Show the COMPLETE object in full: the entire subject visible from top to bottom and side to side, nothing cut off or cropped, nothing touching the image edges. Zoomed out, small in frame, with generous empty margin on all four sides. Centered, isolated on a plain solid white background.`

  let raw: string | undefined
  if (genMode.value === 'scene') {
    const compBlob = await renderStaticComposite(W, H); if (!compBlob) return null
    const compUrl = URL.createObjectURL(compBlob)
    const compImg = await loadImage(compUrl)
    URL.revokeObjectURL(compUrl)
    if (genModel.value === 'nano') {
      const cw = Math.max(1, Math.round(boxW)), ch = Math.max(1, Math.round(boxH))
      const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch
      crop.getContext('2d')!.drawImage(compImg, bnd.minX, bnd.minY, boxW, boxH, 0, 0, cw, ch)
      const instr = `Add ${prompt} into this image, integrated naturally and matching the existing lighting, perspective, colour and style. The object should sit within the frame; keep the rest of the scene unchanged.`
      const r = await inpaint.nanoGen(instr, crop.toDataURL('image/png'))
      raw = r[0]
    } else {
      const { w: capW, h: capH } = capDims(W, H)
      const imageData = imageToDataUrl(compImg, capW, capH)
      const mc = document.createElement('canvas'); mc.width = capW; mc.height = capH
      const mctx = mc.getContext('2d')!
      mctx.fillStyle = '#000'; mctx.fillRect(0, 0, capW, capH)          // BLACK = keep
      mctx.drawImage(maskCanvas, 0, 0, capW, capH)                      // WHITE region = generate
      const filled = await inpaint.fluxFill(imageData, mc.toDataURL('image/png'), prompt)
      if (!filled.length) return null
      const r0 = await loadImage(filled[0])
      const sx = (bnd.minX / W) * capW, sy = (bnd.minY / H) * capH
      const sw = (boxW / W) * capW, sh = (boxH / H) * capH
      const crop = document.createElement('canvas')
      crop.width = Math.max(1, Math.round(sw)); crop.height = Math.max(1, Math.round(sh))
      crop.getContext('2d')!.drawImage(r0, sx, sy, sw, sh, 0, 0, crop.width, crop.height)
      raw = crop.toDataURL('image/png')
    }
  } else if (genModel.value === 'nano') {
    const r = await inpaint.nanoGen(objectPrompt); raw = r[0]
  } else if (genStyle.value) {
    const r = await inpaint.loraGen(genStyle.value.filename, objectPrompt, aspect); raw = r[0]
  } else {
    const r = await inpaint.text2img(objectPrompt, aspect); raw = r[0]
  }
  if (!raw) return null

  // Cut out → clean haze → crop tight → place contained in the box.
  const cutoutRaw = await inpaint.removeBackground(raw)
  const { url: cutout, aspect: genAspect } = await cleanCutoutAlpha(cutoutRaw)
  const name = await inpaint.uploadDataUrl(cutout, 'compobj')
  const bwN = boxW / W, bhN = boxH / W
  let w = bwN, h = bwN / genAspect
  if (h > bhN) { h = bhN; w = bhN * genAspect }
  addImageFromName(name, genAspect, { x: cx / W, y: cy / H, w, h })
  return selectedLocalId.value
}

// Mini-toolbar actions on the last generated object.
async function rerollObject() {
  const r = genResult.value
  if (!r || inpaint.busy.value) return
  try {
    const newId = await generateObjectInto(r.mask, r.bnd)
    if (newId) { deleteLocal(r.layerId); genResult.value = { ...r, layerId: newId } }
  } catch (err) { console.error('[compositor reroll]', err) }
}
function cancelObject() {
  const r = genResult.value; if (!r) return
  deleteLocal(r.layerId)
  genResult.value = null
  clearGenMask()                 // discarded → drop the drawn area too
}
function confirmObject() {
  genResult.value = null
  clearGenMask()                 // validated → the drawn area has served its purpose
}

async function runRegionFill() {
  if (!genHasMask.value || inpaint.busy.value || !genMaskCanvas) return
  const layer = genTarget.value
  try {
    if (layer) {
      const img = await loadImage(imageLayerUrl(layer.filename))
      const { w: capW, h: capH } = capDims(img.naturalWidth || 1024, img.naturalHeight || 1024)
      const imageData = imageToDataUrl(img, capW, capH)
      // Affine (artboard px → image px): inverse of the image's draw transform.
      const W = canvasDisplay.w, H = canvasDisplay.h
      const cx = layer.x * W, cy = layer.y * H
      const bw = (layer.w || 0.0001) * W, bh = (layer.h || 0.0001) * W
      const th = ((layer.rotation || 0) * Math.PI) / 180
      const cos = Math.cos(th), sin = Math.sin(th)
      const a = (capW * cos) / bw, c = (capW * sin) / bw
      const b = (-capH * sin) / bh, d = (capH * cos) / bh
      const e = capW / 2 - a * cx - c * cy
      const f = capH / 2 - b * cx - d * cy
      const mc = document.createElement('canvas'); mc.width = capW; mc.height = capH
      const mctx = mc.getContext('2d')!
      mctx.fillStyle = '#000'; mctx.fillRect(0, 0, capW, capH)   // BLACK = keep
      mctx.setTransform(a, b, c, d, e, f)
      mctx.drawImage(genMaskCanvas, 0, 0)                        // WHITE region = inpaint
      mctx.setTransform(1, 0, 0, 1, 0, 0)
      const results = await inpaint.fluxFill(imageData, mc.toDataURL('image/png'), genPrompt.value.trim())
      if (!results.length) return
      const newName = await inpaint.uploadDataUrl(results[0], 'compinpaint')
      setLocal(layer.id, { filename: newName })
    } else {
      // No target image → generate a brand-new object, then keep the region
      // snapshot + bounds so the mini toolbar can re-roll / cancel / confirm it.
      const bnd = genMaskBounds(); if (!bnd) return
      const mask = cloneGenMask()
      const layerId = await generateObjectInto(mask, bnd)
      if (layerId) genResult.value = { layerId, mask, bnd }
    }
    // Keep the drawn region visible while a result awaits validation (genResult set,
    // confirm/cancel pending). Otherwise (direct layer inpaint, nothing to validate)
    // clear it now. confirmObject / cancelObject clear it once the user decides.
    if (!genResult.value) clearGenMask()
  } catch (err) {
    console.error('[compositor inpaint]', err)
  }
}

// ── Smart select: scribble → SAM-refined selection ───────────────────────────
// Roughly brush over an object on the SELECTED image layer; the scribble is
// sampled into SAM point prompts (in the layer's own pixel space, via the same
// artboard→image affine as runRegionFill) and the returned silhouette becomes
// the active selection. Alt-scribble subtracts (label 0). If the API fails the
// raw scribble IS the selection — every action still works (spec requirement).
const smart = useSmartSelect({ segment: (image, points) => inpaint.segmentPoints(image, points) })
const smartActive = ref(false)
const smartBrush = ref(48)                     // brush diameter, artboard px
const smartTargetId = ref<string | null>(null)
const smartCursor = reactive({ x: -999, y: -999, on: false })
const smartVersion = ref(0)                    // bump → regionFx rebuild
const smartBnd = ref<BBox | null>(null)        // selection bbox, ARTBOARD px (action bar anchor)
const smartHasScribble = ref(false)

const smartTarget = computed<any | null>(() =>
  smartTargetId.value
    ? localLayers.value.find((l: any) => l.id === smartTargetId.value && l.kind === 'image') ?? null
    : null,
)
// A selected wired image, captured (slot) at enterSmartMode the same way the
// local path captures smartTargetId — a live re-lookup of the element so it
// tracks the slot's current frame even if it changes mid-session.
const smartWiredSlot = ref<number | null>(null)

// Unified smart-select target: the local layer path above stays exactly as it
// was (smartTarget/smartTargetId untouched); this generalizes on top of it so
// capture/affine/placement can branch once instead of re-deriving "which kind
// of target" everywhere.
type SmartTarget = { type: 'local'; layer: any } | { type: 'wired'; slot: number; el: HTMLImageElement | HTMLCanvasElement }
const smartTargetRef = computed<SmartTarget | null>(() => {
  if (smartTarget.value) return { type: 'local', layer: smartTarget.value }
  if (smartWiredSlot.value != null) {
    const el = wiredImageEls.value[smartWiredSlot.value]
    return el ? { type: 'wired', slot: smartWiredSlot.value, el } : null
  }
  return null
})
function elDims(el: HTMLImageElement | HTMLCanvasElement): { iw: number; ih: number } {
  return {
    iw: ('naturalWidth' in el ? el.naturalWidth : el.width) || 1,
    ih: ('naturalHeight' in el ? el.naturalHeight : el.height) || 1,
  }
}
// The wired target's live transform (compositorLayer, defaulted) + native dims —
// shared by the capture/affine/placement branches below.
function smartWiredEntry(target: { slot: number; el: HTMLImageElement | HTMLCanvasElement }) {
  const { iw, ih } = elDims(target.el)
  const l = compositorLayer(target.slot)
  return { layer: { x: l?.x ?? 0, y: l?.y ?? 0, scale: l?.scale ?? 1, rotation: l?.rotation ?? 0 }, iw, ih }
}

// Source capture: the target's pixels at capped resolution + the artboard→image
// affine, cached for the whole mode session. `img` (local, from imageLayerUrl)
// or `el` (wired, drawn from the live element) — smartCaptureSource() picks
// whichever is set so downstream extraction doesn't care which target kind it is.
type SmartCapture = { img?: HTMLImageElement; el?: HTMLCanvasElement; capW: number; capH: number; dataUrl: string }
function smartCaptureSource(cap: SmartCapture): CanvasImageSource { return (cap.img ?? cap.el)! }
let smartCapture: SmartCapture | null = null
async function ensureSmartCapture(): Promise<SmartCapture | null> {
  if (smartCapture) return smartCapture
  const target = smartTargetRef.value
  if (!target) return null
  if (target.type === 'wired') {
    try {
      const { iw, ih } = elDims(target.el)
      const { w: capW, h: capH } = capDims(iw, ih)
      const c = document.createElement('canvas'); c.width = capW; c.height = capH
      c.getContext('2d')!.drawImage(target.el, 0, 0, capW, capH)
      const dataUrl = c.toDataURL('image/png')   // may throw on a tainted (cross-origin) source
      smartCapture = { el: c, capW, capH, dataUrl }
    } catch (err) {
      console.error('[smart select] wired capture failed', err)
      toast("Can't read this image's pixels — try adding it directly")
      exitSmartMode(true)
      return null
    }
    return smartCapture
  }
  const layer = target.layer
  const img = await loadImage(imageLayerUrl(layer.filename))
  const { w: capW, h: capH } = capDims(img.naturalWidth || 1024, img.naturalHeight || 1024)
  smartCapture = {
    img, capW, capH,
    dataUrl: imageToDataUrl(img, capW, capH),
  }
  return smartCapture
}

// Affine is computed LIVE (not cached in SmartCapture): the target layer can
// be nudged mid-session, and image space is layer-intrinsic — recomputing
// keeps the selection glued to the layer wherever it moves.
function smartAffine(): Affine | null {
  const target = smartTargetRef.value
  if (!target || !smartCapture) return null
  if (target.type === 'wired') {
    const { layer, iw, ih } = smartWiredEntry(target)
    return wiredImageAffine(layer, canvasDisplay.w, canvasDisplay.h, iw, ih, smartCapture.capW, smartCapture.capH)
  }
  return layerAffine(target.layer, canvasDisplay.w, canvasDisplay.h, smartCapture.capW, smartCapture.capH)
}

// Raw scribble, ARTBOARD px (overlay + API-failure fallback). White = selected.
let smartScribbleCanvas: HTMLCanvasElement | null = null
function smartScribbleCtx(): CanvasRenderingContext2D | null {
  const W = Math.max(1, Math.round(canvasDisplay.w)), H = Math.max(1, Math.round(canvasDisplay.h))
  if (!smartScribbleCanvas) smartScribbleCanvas = document.createElement('canvas')
  if (smartScribbleCanvas.width !== W || smartScribbleCanvas.height !== H) { smartScribbleCanvas.width = W; smartScribbleCanvas.height = H }
  return smartScribbleCanvas.getContext('2d')
}

// Refined SAM mask, IMAGE space (capW×capH), white-on-transparent alpha.
let smartRefinedCanvas: HTMLCanvasElement | null = null
// Artboard-space projection of the active selection (refined if present, else
// scribble) — what the overlay shows and what Generate fill consumes.
let smartProjCache: HTMLCanvasElement | null = null
function smartProjCanvas(): HTMLCanvasElement | null {
  if (smartProjCache) return smartProjCache
  const W = Math.max(1, Math.round(canvasDisplay.w)), H = Math.max(1, Math.round(canvasDisplay.h))
  if (smartRefinedCanvas && smartCapture) {
    const aff = smartAffine()
    if (aff) {
      const c = document.createElement('canvas'); c.width = W; c.height = H
      const ctx = c.getContext('2d')!
      const m = invertAffine(aff)   // image px → artboard px
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
      ctx.drawImage(smartRefinedCanvas, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      smartProjCache = c
      return c
    }
  }
  if (smartHasScribble.value && smartScribbleCanvas) { smartProjCache = smartScribbleCanvas; return smartScribbleCanvas }
  return null
}
// `light` skips the getImageData bbox scan — used on every pointer-move, where
// a full-canvas readback per event would jank; the bbox refreshes on stroke end.
function smartInvalidateProjection(light = false) {
  smartProjCache = null
  if (!light) {
    const proj = smartProjCanvas()
    smartBnd.value = proj
      ? alphaBounds(proj.getContext('2d')!.getImageData(0, 0, proj.width, proj.height).data, proj.width, proj.height)
      : null
  }
  smartVersion.value++
}

function enterSmartMode() {
  const sel = selectedLocal.value?.kind === 'image' ? selectedLocal.value.id : null
  const wired = !sel ? selectedWiredImage() : null
  if (!sel && !wired) return
  exitOtherToolsFor('smart')   // smart has no busy-guard for its own entry
  smartActive.value = true
  smartTargetId.value = sel
  smartWiredSlot.value = wired ? wired.slot : null
  smart.reset()
  smartCapture = null
  smartRefinedCanvas = null
  smartCandCache = null
  smartHasScribble.value = false
  const ctx = smartScribbleCtx()
  if (ctx && smartScribbleCanvas) ctx.clearRect(0, 0, smartScribbleCanvas.width, smartScribbleCanvas.height)
  smartInvalidateProjection()
  void ensureSmartCapture()   // warm the capture so the first stroke refines fast
}
function exitSmartMode(force = false) {
  // Mid-action exits look like a cancel while the in-flight upload still
  // lands afterwards (and Cut out would TypeError on the nulled capture) —
  // only the action pipeline itself may exit while one is running.
  if (smartActionBusy.value && !force) return
  smartActive.value = false
  smartCursor.on = false
  smartTargetId.value = null
  smartWiredSlot.value = null
  smart.reset()
  smartCapture = null
  smartRefinedCanvas = null
  smartCandCache = null
  smartHasScribble.value = false
  smartProjCache = null
  smartBnd.value = null
}
function toggleSmartMode() { smartActive.value ? exitSmartMode() : enterSmartMode() }

// Pointer handling: record the raw polyline (for point sampling) and paint the
// scribble (white; Alt = erase) for the overlay/fallback.
const smartDraw = ref<{ sub: boolean; pts: Pt[]; lx: number; ly: number } | null>(null)
function onSmartPointerDown(e: PointerEvent) {
  const p = genPointFromEvent(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  canvasRef.value?.setPointerCapture?.(e.pointerId)
  smartDraw.value = { sub: e.altKey, pts: [{ x: p.x, y: p.y }], lx: p.x, ly: p.y }
  smartStrokeTo(p.x, p.y)
}
function smartStrokeTo(x: number, y: number) {
  const d = smartDraw.value
  const ctx = smartScribbleCtx(); if (!ctx || !d) return
  ctx.globalCompositeOperation = d.sub ? 'destination-out' : 'source-over'
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = smartBrush.value
  ctx.beginPath(); ctx.moveTo(d.lx, d.ly); ctx.lineTo(x, y); ctx.stroke()
  ctx.beginPath(); ctx.arc(x, y, smartBrush.value / 2, 0, Math.PI * 2); ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  if (!d.sub) smartHasScribble.value = true
}
function onSmartPointerMove(e: PointerEvent) {
  const p = genPointFromEvent(e); if (!p) return
  smartCursor.x = p.x; smartCursor.y = p.y; smartCursor.on = true
  const d = smartDraw.value; if (!d) return
  e.preventDefault(); e.stopPropagation()
  smartStrokeTo(p.x, p.y)
  d.pts.push({ x: p.x, y: p.y }); d.lx = p.x; d.ly = p.y
  smartInvalidateProjection(true)
}
async function onSmartPointerUp(e: PointerEvent) {
  const d = smartDraw.value; if (!d) return
  e.preventDefault(); e.stopPropagation()
  smartDraw.value = null
  smartInvalidateProjection()
  const cap = await ensureSmartCapture(); if (!cap) return
  const aff = smartAffine(); if (!aff) return
  const label = d.sub ? 0 : 1
  const imgPts: SamPoint[] = samplePointsFromStroke(d.pts)
    .map(pt => applyAffine(aff, pt))
    .filter(pt => pt.x >= 0 && pt.y >= 0 && pt.x < cap.capW && pt.y < cap.capH)
    .map(pt => ({ x: pt.x, y: pt.y, label: label as 0 | 1 }))
  if (!imgPts.length) return   // scribble entirely off the target layer
  smart.addPoints(imgPts)
  await smart.refine(cap.dataUrl)
}

// Refined candidate masks arrived, or the prompt points changed → this SAM
// deployment is segment-everything (individual_masks = EVERY segment in the
// image, independent of the points). Each foreground point claims the
// smallest segment containing it, background points subtract theirs, and the
// winners union into the refined mask (pickSamSegments). Candidates are
// decoded once per urls array — a points-only change just re-picks from the
// cached decode, no re-fetch/re-decode.
let smartCandCache: { key: string; cands: MaskCandidate[]; imgs: HTMLImageElement[] } | null = null
watch([() => smart.maskUrls.value, () => smart.points.value], async ([urls]) => {
  if (!urls?.length || !smartCapture) { smartRefinedCanvas = null; smartInvalidateProjection(); return }
  try {
    const cap = smartCapture
    const key = urls.join('|')
    if (!smartCandCache || smartCandCache.key !== key) {
      const imgs = await Promise.all(urls.slice(0, 12).map(u => loadImage(u)))
      const cands: MaskCandidate[] = imgs.map(img => {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const id = ctx.getImageData(0, 0, c.width, c.height)
        return { data: id.data, w: c.width, h: c.height }
      })
      smartCandCache = { key, cands, imgs }
    }
    const { cands, imgs } = smartCandCache
    const fg = smart.points.value.filter(p => p.label === 1)
    const bg = smart.points.value.filter(p => p.label === 0)
    const idxs = pickSamSegments(cands, fg, bg, cap.capW, cap.capH)
    if (!idxs.length) {
      // No segment qualifies for the current points — leave smartRefinedCanvas
      // null so the raw scribble stays the selection. This is silent on
      // purpose: the API call itself succeeded, so we do NOT set smart.failed
      // (that's reserved for actual request failures).
      smartRefinedCanvas = null
    } else {
      const c = document.createElement('canvas')
      c.width = cap.capW; c.height = cap.capH
      const ctx = c.getContext('2d')!
      for (const idx of idxs) {
        const win = imgs[idx]!
        const t = document.createElement('canvas')
        t.width = cap.capW; t.height = cap.capH
        const tctx = t.getContext('2d')!
        tctx.drawImage(win, 0, 0, t.width, t.height)
        const id = tctx.getImageData(0, 0, t.width, t.height)
        luminanceToAlpha(id.data)
        tctx.putImageData(id, 0, 0)
        ctx.drawImage(t, 0, 0)   // source-over unions the alphas
      }
      smartRefinedCanvas = c
    }
  } catch {
    smartRefinedCanvas = null   // unloadable mask(s) → scribble fallback
  }
  smartInvalidateProjection()
})

// Overlay: a second useRegionFx instance over the smart canvases (gen and
// smart modes are mutually exclusive, but each keeps its own canvas pair).
const smartOverlayCanvas = ref<HTMLCanvasElement | null>(null)
const smartSweepCanvas = ref<HTMLCanvasElement | null>(null)
const smartFx = useRegionFx({
  overlay: smartOverlayCanvas,
  sweep: smartSweepCanvas,
  getMask: () => smartProjCanvas(),
  getDims: () => canvasDisplay,
  busy: () => smart.busy.value,
})
const { sweepMaskUrl: smartSweepMaskUrl } = smartFx
watch(smartActive, (on) => { on ? smartFx.start() : smartFx.stop() })
watch([smartVersion, () => canvasDisplay.w, () => canvasDisplay.h], () => smartFx.rebuild())

// ── Smart-select actions ──────────────────────────────────────────────────────
// All actions consume the IMAGE-space mask: the refined SAM mask, or (fallback)
// the scribble projected into image space through the artboard→image affine.
const smartActionBusy = ref(false)
const smartSelectionReady = computed(() => !!smartBnd.value && !smart.busy.value)

function smartImageMask(): HTMLCanvasElement | null {
  if (smartRefinedCanvas) return smartRefinedCanvas
  if (!smartCapture || !smartHasScribble.value || !smartScribbleCanvas) return null
  const c = document.createElement('canvas')
  c.width = smartCapture.capW; c.height = smartCapture.capH
  const ctx = c.getContext('2d')!
  const m = smartAffine()
  if (!m) return null
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
  ctx.drawImage(smartScribbleCanvas, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return c
}

// Masked source pixels (image space) + their tight bbox, or null if empty.
function smartExtract(): { canvas: HTMLCanvasElement; bbox: BBox } | null {
  const cap = smartCapture; const mask = smartImageMask()
  if (!cap || !mask) return null
  const c = document.createElement('canvas'); c.width = cap.capW; c.height = cap.capH
  const ctx = c.getContext('2d')!
  ctx.drawImage(smartCaptureSource(cap), 0, 0, cap.capW, cap.capH)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(mask, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  const bbox = alphaBounds(ctx.getImageData(0, 0, cap.capW, cap.capH).data, cap.capW, cap.capH)
  return bbox ? { canvas: c, bbox } : null
}

function cropToDataUrl(src: HTMLCanvasElement, bbox: BBox): string {
  const w = bbox.maxX - bbox.minX + 1, h = bbox.maxY - bbox.minY + 1
  const c = document.createElement('canvas'); c.width = w; c.height = h
  c.getContext('2d')!.drawImage(src, bbox.minX, bbox.minY, w, h, 0, 0, w, h)
  return c.toDataURL('image/png')
}

// Upload a crop and add it as a layer placed exactly over its source pixels.
// Placement is a local-vs-wired branch: cutoutPlacement (layerAffine's inverse)
// for a local source layer, wiredCutoutPlacement (wiredImageAffine's inverse)
// for a wired one — both map the crop bbox (capped image px) → artboard.
async function smartAddCropAsLayer(src: HTMLCanvasElement, bbox: BBox, nameHint: string) {
  const cap = smartCapture!; const target = smartTargetRef.value!
  const name = await inpaint.uploadDataUrl(cropToDataUrl(src, bbox), nameHint)
  const place = target.type === 'wired'
    ? (() => {
        const { layer, iw, ih } = smartWiredEntry(target)
        return wiredCutoutPlacement(bbox, layer, iw, ih, cap.capW, cap.capH, canvasDisplay.w, canvasDisplay.h)
      })()
    : cutoutPlacement(bbox, target.layer, cap.capW, cap.capH, canvasDisplay.w, canvasDisplay.h)
  const aspect = (bbox.maxX - bbox.minX + 1) / (bbox.maxY - bbox.minY + 1)
  addImageFromName(name, aspect, place as any)   // records history + selects
}

// Bake the inverse of the mask into the source layer (remove selected pixels).
// Local-only — Cut out / Delete branch to smartHideWired below for a wired target.
async function smartBakeHole() {
  const cap = smartCapture!; const layer = smartTarget.value!; const mask = smartImageMask()!
  const c = document.createElement('canvas'); c.width = cap.capW; c.height = cap.capH
  const ctx = c.getContext('2d')!
  ctx.drawImage(smartCaptureSource(cap), 0, 0, cap.capW, cap.capH)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(mask, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  const name = await inpaint.uploadDataUrl(c.toDataURL('image/png'), 'smarthole')
  setLocal(layer.id, { filename: name })
}

// Wired equivalent of smartBakeHole: a wired image's source pixels aren't
// editable (they live in the graph), so "removing" the selection means OR-ing
// the selection silhouette into the slot's existing visibility mask instead of
// baking a hole into new pixels — non-destructive, BUT NOT undo-able: wired
// masks live in node properties (sailor_wiredTreatments), which are NOT in the
// local-layer undo history (same as maskedByKey) — so this hide can't be
// Cmd+Z'd. Recovery is the "Clear mask" affordance (see clearWiredMask below)
// or brush Mask-mode erase. Cut out's extracted layer IS undoable independently.
async function smartHideWired(slot: number, capW: number, capH: number, silhouette: HTMLCanvasElement) {
  const c = document.createElement('canvas'); c.width = capW; c.height = capH
  const ctx = c.getContext('2d')!
  const existing = wiredTreatments.value[`w:${slot}`]?.maskUrl
  if (existing) { try { ctx.drawImage(await loadImage(existing), 0, 0, capW, capH) } catch { /* start fresh */ } }
  // silhouette is white-on-transparent where selected → draw it in as-is
  // (source-over) so it unions with the existing mask; white = hidden.
  ctx.drawImage(silhouette, 0, 0, capW, capH)
  setWiredMaskUrl(compositor.value, slot, c.toDataURL('image/png'))
  renderStack()
}

// Guard wrapper: every action needs a ready selection + capture, sets busy,
// logs failures, and (unless told otherwise) leaves smart mode when done.
async function smartAction(fn: () => Promise<void>, opts: { exit?: boolean } = {}) {
  if (!smartSelectionReady.value || smartActionBusy.value || !smartCapture || !smartTargetRef.value) return
  smartActionBusy.value = true
  try {
    await fn()
    // smartActionBusy is still true here (finally clears it below) — this is
    // the action pipeline's own exit, so it must force past the busy guard.
    if (opts.exit !== false) exitSmartMode(true)
  } catch (err) {
    console.error('[smart select]', err)
  } finally {
    smartActionBusy.value = false
  }
}

// New layer — non-destructive copy of the selection.
function smartNewLayer() {
  return smartAction(async () => {
    const ex = smartExtract(); if (!ex) return
    await smartAddCropAsLayer(ex.canvas, ex.bbox, 'smartcut')
  })
}
// Cut out — copy to a new layer AND remove from the source (two undo steps:
// the layer add, then the source swap).
function smartCutOut() {
  return smartAction(async () => {
    const ex = smartExtract(); if (!ex) return
    await smartAddCropAsLayer(ex.canvas, ex.bbox, 'smartcut')
    const target = smartTargetRef.value
    if (target?.type === 'wired') {
      const cap = smartCapture!; const mask = smartImageMask(); if (!mask) return
      await smartHideWired(target.slot, cap.capW, cap.capH, mask)
      return
    }
    await smartBakeHole()
  })
}
// Delete — remove the selection from the source: bakes a transparent hole for
// a local layer, or non-destructively hides the region for a wired image
// (Generate fill is the content-aware alternative, local-only for now).
function smartDelete() {
  return smartAction(async () => {
    const target = smartTargetRef.value
    if (target?.type === 'wired') {
      const cap = smartCapture!; const mask = smartImageMask(); if (!mask) return
      await smartHideWired(target.slot, cap.capW, cap.capH, mask)
      return
    }
    await smartBakeHole()
  })
}
// Use as mask — add the silhouette as a white stencil layer other layers can
// clip by via the existing Layer-mask (maskedByKey) picker.
function smartUseAsMask() {
  return smartAction(async () => {
    const mask = smartImageMask(); if (!mask) return
    const bbox = alphaBounds(mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height).data, mask.width, mask.height)
    if (!bbox) return
    await smartAddCropAsLayer(mask, bbox, 'smartmask')
  })
}
// Generate fill — hand the artboard-space selection to Generate mode as its
// region and let its prompt/Generate flow take over (target = same layer).
function smartGenerateFill() {
  return smartAction(async () => {
    if (smartTargetRef.value?.type === 'wired') return // W6: wired generate-fill lands separately
    const proj = smartProjCanvas(); if (!proj) return
    const snapshot = document.createElement('canvas')
    snapshot.width = proj.width; snapshot.height = proj.height
    snapshot.getContext('2d')!.drawImage(proj, 0, 0)
    exitSmartMode(true)                      // clears smart state (proj is snapshotted)
    enterGenMode()                           // locks target to the still-selected image
    const ctx = genMaskCtx()
    if (ctx) { ctx.drawImage(snapshot, 0, 0); genHasMask.value = true; genVersion.value++ }
  }, { exit: false })
}

// Cloud background removal — replace an image layer with its transparent cutout.
// Delegates to useLayerImageEdit (shared with Task 9's Harmonize) so the
// swap always happens through one setLocal call (one undo step).
async function removeImageBg(layer: any) {
  if (!layer || layer.kind !== 'image' || layerEdit.busy.value) return
  await layerEdit.cutOutLayer(layer, setLocal)
}

// W/H editing for shapes, with an optional aspect-ratio lock. Both w and h are
// normalized to the artboard width (the layer model's convention), so a single
// outWidth conversion works for either axis. When locked, editing one axis
// scales the other by the same factor.
const lockRatio = ref(true)
function setDimPx(l: any, key: 'w' | 'h', px: number) {
  const next = Math.max(0, px) / outWidth.value
  const other = key === 'w' ? 'h' : 'w'
  if (lockRatio.value && l[key] > 0 && typeof l[other] === 'number') {
    const ratio = next / l[key]
    setLocal(l.id, { [key]: next, [other]: Math.max(0.002, l[other] * ratio) })
  } else {
    setLocal(l.id, { [key]: next })
  }
}
function kindIcon(kind: string) {
  return kind === 'text' ? Type : kind === 'rect' ? Square
    : kind === 'ellipse' ? Circle : kind === 'image' ? ImageIcon
    : kind === 'polygon' ? Hexagon : kind === 'star' ? Star
    : kind === 'brush' ? Brush : kind === 'deal' ? LayoutGrid : Minus
}
// A layer's fill Paint for the layer-list swatch, or null for kinds without a
// meaningful fill (image = its own pixels, line = a stroke). Falls back to the
// kind icon when null.
function rowFill(layer: LocalLayer): Paint | null {
  if (layer.kind === 'image' || layer.kind === 'line') return null
  const f = (layer as { fill?: Paint }).fill
  return f && f !== 'none' && f !== '' ? f : null
}

// ── Add an image layer from the toolbar ─────────────────────────────────────
const imageInputRef = ref<HTMLInputElement | null>(null)
function triggerAddImage() { imageInputRef.value?.click() }
async function onAddImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) { try { await addImageFromFile(file) } catch (err) { console.error('[Compositor] add image failed:', err) } }
}
/** Second hop of the Insert flyout: the centered picker surface, rendering only
 *  FillImagePicker. The anchored flyout is the first hop (see below). */
const pickerDialogOpen = ref(false)
async function onPickCanvasImage(src: string) {
  pickerDialogOpen.value = false
  try { await addImageFromCanvasSrc(src) } catch (err) { console.error('[Compositor] add canvas image failed:', err) }
}

// ── Toolbar menus: Shapes ▾, Insert ▾ and AI ✦ ▾ ────────────────────────────
// Same idiom as the zoom menu: a ref per menu, the cluster wrapper stops the
// click (the toolbar sits inside the stage, whose click handler is the
// click-away), Escape closes the open one. Opening one closes the others so two
// flyouts can never overlap.
const shapesMenuOpen = ref(false)
const aiMenuOpen = ref(false)
const insertMenuOpen = ref(false)
/** Last-used shape, worn by the Shapes button. Component state on purpose —
 *  the spec asks for no persistence beyond the open modal. Same for the AI and
 *  Insert faces below: plain refs, so every session starts on the default. */
const shapeFace = ref<ToolbarShapeId>(DEFAULT_SHAPE_FACE)
const aiFace = ref<ToolbarAiId>(DEFAULT_AI_FACE)
const insertFace = ref<ToolbarInsertId>(DEFAULT_INSERT_FACE)
/** The library shape the face wears once one has been picked; null on a fresh
 *  modal (component state on purpose — no persistence, like shapeFace). */
const libraryShapeId = ref<string | null>(null)
const libraryShape = computed(() => (libraryShapeId.value ? shapeById(libraryShapeId.value) : undefined))
const hasLibraryShape = computed(() => !!libraryShape.value)
/** The face id actually worn right now, with the library-without-a-shape case
 *  already downgraded to the default — computed once and reused by the face
 *  button's v-if, :is and title, rather than each re-deriving it. */
const shapeFaceResolved = computed(() => resolveShapeFace(shapeFace.value, hasLibraryShape.value))
const faceTitle = computed(() => shapeFaceResolved.value === 'library' && libraryShape.value ? 'Add ' + libraryShape.value.name : 'Add ' + shapeFaceLabel(shapeFace.value, hasLibraryShape.value).toLowerCase())
const libraryPickerOpen = ref(false)
const libraryPickerAnchor = ref({ x: 0, y: 0 })
const shapesClusterRef = ref<HTMLElement | null>(null)
/** Declared here, beside libraryPickerOpen, rather than down by its own
 *  open/pick helpers: closeToolbarMenus (below) references it, and a
 *  declaration after that reference would be a TDZ hazard the moment
 *  closeToolbarMenus is called before this module finishes initializing. */
const inspectorShapePickerOpen = ref(false)
const inspectorShapeAnchor = ref({ x: 0, y: 0 })
const inspectorShapeButtonRef = ref<HTMLElement | null>(null)
const SHAPE_ICONS: Record<ToolbarShapeId, Component> = {
  rect: Square, ellipse: Circle, line: Minus, polygon: Hexagon, star: Star, library: Shapes,
}
function stampLibraryShape() {
  const s = libraryShape.value
  // Defensive only: every caller reaches this fn via shapeFaceResolved, which
  // already downgrades 'library' to the default face when hasLibraryShape is
  // false — so `s` should always be set here. Kept as a guard, not a live path.
  if (!s) { openLibraryPicker(); return }
  addLocal(createShapeLayer(s))
}
const SHAPE_STAMP: Record<ToolbarShapeId, () => void> = {
  rect: addRect, ellipse: addEllipse, line: addLine, polygon: addPolygon, star: addStar, library: stampLibraryShape,
}
/** Anchor the picker above the Shapes cluster; the picker clamps itself to the viewport. */
function openLibraryPicker() {
  libraryPickerAnchor.value = anchorAbove(shapesClusterRef.value?.getBoundingClientRect())
  shapesMenuOpen.value = false
  libraryPickerOpen.value = true
}
function onLibraryPick(id: string) {
  const s = shapeById(id)
  if (!s) return
  libraryShapeId.value = id
  shapeFace.value = 'library'
  addLocal(createShapeLayer(s))
}
const AI_ICONS: Record<ToolbarAiId, Component> = {
  vector: Sparkles, region: Wand2, smart: Lasso,
}
const INSERT_ICONS: Record<ToolbarInsertId, Component> = {
  upload: ImagePlus, canvas: LayoutGrid, svg: FileUp,
}
function closeToolbarMenus() {
  zoomMenuOpen.value = false
  shapesMenuOpen.value = false
  aiMenuOpen.value = false
  insertMenuOpen.value = false
  libraryPickerOpen.value = false
  inspectorShapePickerOpen.value = false
}
function toggleInsertMenu() { const next = !insertMenuOpen.value; closeToolbarMenus(); insertMenuOpen.value = next }
function toggleZoomMenu() { const next = !zoomMenuOpen.value; closeToolbarMenus(); zoomMenuOpen.value = next }
function toggleShapesMenu() { const next = !shapesMenuOpen.value; closeToolbarMenus(); shapesMenuOpen.value = next }
function toggleAiMenu() { const next = !aiMenuOpen.value; closeToolbarMenus(); aiMenuOpen.value = next }
/** Menu row → stamp it now AND wear it, so repeat stamping is one click.
 *  The library row opens the picker instead; the pick both stamps and wears. */
function pickShape(id: ToolbarShapeId) {
  if (id === 'library') { openLibraryPicker(); return }
  shapeFace.value = id
  shapesMenuOpen.value = false
  SHAPE_STAMP[id]()
}
/** The face button itself: stamp the current shape without opening anything. */
function stampFaceShape() { closeToolbarMenus(); SHAPE_STAMP[resolveShapeFace(shapeFace.value, hasLibraryShape.value)]() }
const selectedShape = computed(() => {
  const l = selectedLocal.value
  return l && l.kind === 'path' && l.shapeId ? shapeById(l.shapeId) : undefined
})
function openInspectorShapePicker() {
  if (inspectorShapePickerOpen.value) { inspectorShapePickerOpen.value = false; return }
  const r = inspectorShapeButtonRef.value?.getBoundingClientRect()
  inspectorShapeAnchor.value = r ? { x: r.right - SHAPE_PICKER_WIDTH, y: r.bottom + 4 } : { x: 16, y: 16 }
  inspectorShapePickerOpen.value = true
}
function onInspectorShapePick(id: string) {
  const l = selectedLocal.value
  const s = shapeById(id)
  if (!l || l.kind !== 'path' || !s) return
  setLocal(l.id, swapShapeLayer(l, s))
}
// A picker anchored to the inspector's shape swatch is only meaningful for the
// layer it opened on — switching selection out from under it would swap some
// OTHER layer's shape on pick, so close it the moment selection changes.
watch(() => selectedLocal.value?.id, () => { inspectorShapePickerOpen.value = false })
/** Called during render (not a computed): `selectedWiredImage()` reads the DOM,
 *  so it must be re-evaluated with the rest of the template, exactly as the old
 *  Smart-select button's :disabled/:title bindings did. */
function smartRowState() {
  return smartSelectRowState(selectedLocal.value?.kind === 'image' || !!selectedWiredImage(), smartActive.value)
}
/** Shared gate for entering any of the three AI flows (and, via selectTool,
 *  node-edit): exits pen, brush, and any OTHER running AI flow first, so the
 *  three can never collide — mirrors what enterGenMode/enterSmartMode already
 *  did ad hoc, factored so the trio can't drift apart again. `flow` is the one
 *  about to become active; its own state is left untouched here, the caller
 *  flips it on right after. Returns false when a smart-select action is
 *  mid-flight, in which case the caller must abort rather than start
 *  something new on top of it (same guard togglePen/toggleBrush/toggleDistort
 *  already use). */
function exitOtherToolsFor(flow: ToolbarAiId): boolean {
  if (flow !== 'smart' && smartActive.value) {
    if (smartActionBusy.value) return false
    exitSmartMode()
  }
  selectTool(); exitNodeEdit()
  if (pen.active.value) pen.setActive(false)
  brush.setActive(false)
  if (flow !== 'vector') aiOpen.value = false
  if (flow !== 'region' && genActive.value) exitGenMode()
  return true
}
/** Run a flow WITHOUT touching the face (the face button's own path). */
function runAiFlow(id: ToolbarAiId) {
  if (id === 'vector') {
    if (aiOpen.value) { aiOpen.value = false; return }
    if (!exitOtherToolsFor('vector')) return
    aiOpen.value = true
    return
  }
  if (id === 'region') { toggleGenMode(); return }
  toggleSmartMode()
}
/** Menu row → run it now AND wear it, so re-entering is one click. */
function runAiRow(id: ToolbarAiId) {
  aiFace.value = id
  aiMenuOpen.value = false
  runAiFlow(id)
}
/** The face button: re-enter the last-used flow without opening anything. */
function runAiFace() {
  const face = resolveAiFace(aiFace.value)
  closeToolbarMenus()
  runAiFlow(face)
}
/** The face mirrors its row's disabled+hint state (Smart select needs an image
 *  layer). The caret is never disabled — the other two flows stay reachable. */
function aiFaceState() {
  return resolveAiFace(aiFace.value) === 'smart'
    ? smartRowState()
    : { disabled: false, hint: TOOLBAR_AI.find(r => r.id === resolveAiFace(aiFace.value))!.hint }
}
/** True when ANY of the three AI flows is running, regardless of which one is
 *  currently faced — drives the face+caret cluster's "AI is running" highlight
 *  (the old single button OR'd all three the same way; a caret-entered flow
 *  must read as active even while a different flow sits on the face). */
const aiToolActive = computed(() => aiOpen.value || genActive.value || smartActive.value)

// ── Insert ▾ ────────────────────────────────────────────────────────────────
// Anchored flyout (same idiom/styling as Shapes). Upload and Import SVG act
// immediately; "Pick from canvas…" is a second hop onto the picker surface —
// driven by TOOLBAR_INSERT's `secondHop` flag rather than a hardcoded id list,
// so the row data and the handler can't drift apart.
const INSERT_ROW_ACTIONS: Partial<Record<ToolbarInsertId, () => void>> = {
  upload: () => triggerAddImage(),
  svg: () => triggerImportSvg(),
}
function runInsertRowAction(id: ToolbarInsertId) {
  const row = TOOLBAR_INSERT.find(r => r.id === id)!
  if (row.secondHop) { pickerDialogOpen.value = true; return }
  INSERT_ROW_ACTIONS[id]?.()
}
function pickInsertRow(id: ToolbarInsertId) {
  insertFace.value = id
  insertMenuOpen.value = false
  runInsertRowAction(id)
}
function runInsertFace() {
  const face = resolveInsertFace(insertFace.value)
  closeToolbarMenus()
  runInsertRowAction(face)
}

// ── Fill a brush layer with an image ────────────────────────────────────────
// Reuses the add-image flow, then clips the freshly-added image to the brush
// layer's painted silhouette via maskedByKey (+ maskShowSource=false) so the
// image shows ONLY through the painted shape.
const brushFillInputRef = ref<HTMLInputElement | null>(null)
const pendingBrushFillId = ref<string | null>(null)
function triggerBrushFillImage(brushId: string) {
  pendingBrushFillId.value = brushId
  brushFillInputRef.value?.click()
}
async function onBrushFillImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const brushId = pendingBrushFillId.value
  pendingBrushFillId.value = null
  if (!file || !brushId) return
  try {
    const before = new Set(localLayers.value.map(l => l.id))
    await addImageFromFile(file)   // appends + selects the new image layer
    const img = localLayers.value.find(l => l.kind === 'image' && !before.has(l.id))
    if (img) setLocal(img.id, { maskedByKey: localKey(brushId), maskShowSource: false })
  } catch (err) {
    console.error('[Compositor] fill brush with image failed:', err)
  }
}

function handleKeydown(e: KeyboardEvent) {
  // A shape picker owns the keyboard while open (Delete/Backspace must not
  // reach the layer) — see onKeydown's matching guard for the full story on
  // why the picker, not this handler, is the source of truth for its own keys.
  if (libraryPickerOpen.value || inspectorShapePickerOpen.value) return
  const ae = document.activeElement
  // Where the key was pressed, not only where focus is NOW: the inline
  // textarea's own Escape handler ends the edit, Vue unmounts the box in the
  // microtask before this listener runs, and focus is already back on <body> —
  // so an activeElement-only guard let one Escape both leave the text AND close
  // the whole modal. `e.target` still names the box it was typed into.
  const tgt = e.target as Element | null
  const typing = (tgt instanceof Element && !!tgt.closest('input, textarea, [contenteditable]'))
    || (ae instanceof Element && ae.matches('input, textarea, [contenteditable]'))
  if (e.key === 'Escape') {
    // Any handler that preventDefaults Escape has already consumed it (ShapePicker, SweepPopover, the inline text/rename inputs). A picker's own open-flag is already false by the time this bubble-phase handler runs, so the event is the only reliable signal.
    if (e.defaultPrevented) return
    if (zoomMenuOpen.value) { zoomMenuOpen.value = false; return }
    if (shapesMenuOpen.value) { shapesMenuOpen.value = false; return }
    if (aiMenuOpen.value) { aiMenuOpen.value = false; return }
    if (insertMenuOpen.value) { insertMenuOpen.value = false; return }
    if (pickerDialogOpen.value) { pickerDialogOpen.value = false; return }
    if (editingId.value) { endEdit(); return }
    if (typing) return
    // The busy guard now lives inside exitSmartMode itself.
    if (smartActive.value) { exitSmartMode(); return }
    if (genActive.value) { exitGenMode(); return }
    emit('close')
    return
  }
  // Don't delete the target layer while painting a generative-fill region.
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLocalId.value && !typing && !genActive.value && !smartActive.value && !brush.active.value) {
    e.preventDefault()
    deleteLocal(selectedLocalId.value)
  }
}
// ── Paste an image into the frame ───────────────────────────────────────────
// Cmd/Ctrl+V with an image on the clipboard adds it as a local image layer via
// the SAME path as drag-drop (addImageFromFile), so upload, history and
// selection behave identically. Registered in the CAPTURE phase on purpose:
// VueNodeCanvas listens for 'paste' on window in the bubble phase and would
// otherwise turn the image into a standalone Image node on the graph. Capture
// runs first, and stopImmediatePropagation keeps that handler from firing.
// ── OS clipboard: copy/paste layers across frames, projects and sessions ─────
// ⌘C fills the in-session clipboard (module singleton) AND — via the editor's
// onOSCopy hook — pushes the SAME selection to the real OS clipboard: our layer
// JSON on text/plain (the load-bearing half, read back on ⌘V), plus a composited
// PNG on image/png for pasting into external apps. ⌘V prefers our JSON found on
// the paste event's clipboardData (no permission prompt, unlike navigator
// .clipboard.read()), else falls back to the existing image paste.

// Composite just the copied selection to a transparent PNG at bake resolution.
// Best-effort: the JSON is what a Sailor paste consumes; this PNG only matters
// for pasting into another app, so any failure resolves to null and is dropped.
async function compositeSelectionBlob(payload: ClipboardPayload): Promise<Blob | null> {
  try {
    const { W, H } = bakeSize()
    const off = document.createElement('canvas')
    off.width = Math.max(1, Math.round(W)); off.height = Math.max(1, Math.round(H))
    const ctx = off.getContext('2d'); if (!ctx) return null
    const sel = payload.layers as LocalLayer[]
    if (!sel.length) return null
    await ensureLayerImages(sel)
    await ensureLayerFonts(sel, W)
    // Paint bottom-up over a transparent ground. Wired kinds never reach the
    // payload, so no wired content provider is needed.
    withWiredContent(wiredContentForSlot, () => {
      for (const l of sel) drawLocalLayer(ctx, l, W, H)
    })
    return await new Promise<Blob | null>(resolve => off.toBlob(b => resolve(b), 'image/png'))
  } catch (err) {
    console.debug('[Compositor] selection PNG composite skipped', err)
    return null
  }
}

async function writeLayersToOSClipboard(payload: ClipboardPayload): Promise<void> {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  if (!nav?.clipboard) return
  const json = serializeLayersForOS(payload.layers, payload.groups)
  // Preferred: one ClipboardItem carrying our JSON + a composited PNG.
  //
  // The ClipboardItem must be CONSTRUCTED and clipboard.write() must be CALLED
  // synchronously, inside the ⌘C keydown handler's call stack — Safari and
  // Firefox only honor a write that starts in the same gesture; `await`ing
  // compositeSelectionBlob() (which itself awaits ensureLayerImages /
  // ensureLayerFonts / canvas.toBlob) before calling write() opens an async gap
  // that makes those browsers silently reject the whole call, degrading the
  // cross-session paste feature to in-session-only. Passing a PROMISE as the
  // item's value sidesteps this: write() fires synchronously and the browser
  // awaits the blob itself. If the PNG promise resolves to null (composite
  // skipped/failed) it re-rejects rather than shipping a broken 0-byte image —
  // that fails this whole write() and falls through to the writeText-only
  // fallback below, which is the same end state the old "only add the key
  // when non-null" branch produced.
  if (typeof ClipboardItem !== 'undefined' && nav.clipboard.write) {
    try {
      const png = compositeSelectionBlob(payload).then((b) => {
        if (!b) throw new Error('[Compositor] selection PNG composite unavailable')
        return b
      })
      const items: Record<string, Blob | Promise<Blob>> = {
        'text/plain': new Blob([json], { type: 'text/plain' }),
        'image/png': png,
      }
      await nav.clipboard.write([new ClipboardItem(items)])
      return
    } catch (err) {
      // Permission denied, no gesture, PNG composite unavailable, or write()
      // unsupported — in-session clipboard already holds the payload, so
      // same-session paste is unaffected.
      console.debug('[Compositor] OS clipboard write() failed; trying writeText', err)
    }
  }
  // Fallback: JSON only (the load-bearing half). writeText() takes no gesture-
  // sensitive async dependency, so calling it here (already outside the
  // keydown's synchronous stack) is safe — it has nothing to await beforehand.
  try { await nav.clipboard.writeText?.(json) }
  catch (err) { console.debug('[Compositor] OS clipboard writeText failed', err) }
}

// Paste a Sailor layer payload lifted from the OS clipboard into THIS frame.
// Routes through the existing in-session paste path (setClipboard + the editor's
// pasteClipboard), so ids are re-minted, placement is offset, history records,
// and the copies become the selection — identical to an in-session ⌘V.
async function pasteOSLayers(payload: ClipboardPayload): Promise<void> {
  setClipboard(payload)
  pasteClipboard(false)
  // Cross-frame/project image layers reference a filename in ComfyUI's input
  // dir; resolve their bitmaps now so they paint. Cross-SESSION/server the
  // filename may 404 (v1 limitation — no re-upload-from-PNG yet).
  try { await ensureLayerImages(localLayers.value as LocalLayer[]) } catch { /* best-effort */ }
  renderStack()
}

function isEditablePasteTarget(n: EventTarget | null): boolean {
  const el = n instanceof Element ? n : null
  if (!el) return false
  const sel = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  return el.matches(sel) || !!el.closest(sel)
}
function clipboardImageFile(e: ClipboardEvent): File | null {
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) return f
    }
  }
  const f0 = e.clipboardData?.files?.[0]
  return f0 && f0.type.startsWith('image/') ? f0 : null
}
/**
 * Copying an image artifact on the canvas writes to `useNodeClipboard` — an IN-APP
 * singleton, not the OS clipboard — so `e.clipboardData` is empty and the image-file
 * path above finds nothing. Without this branch, Cmd+V in the Compositor after copying
 * a canvas image silently did nothing at all.
 *
 * Resolved through the shared `imageUrlForNode` so this agrees with what the node is
 * actually showing (a rendered output beats the file widget), then fetched and handed to
 * `addImageFromFile` — the same path as drag-drop and OS paste, so upload, history and
 * selection all behave identically.
 */
const nodeClipboard = useNodeClipboard()

async function pastedNodeImageFile(): Promise<File | null> {
  const clip = nodeClipboard.read()
  if (!clip?.nodes?.length) return null
  for (const n of clip.nodes) {
    const url = imageUrlForNode(n)
    if (!url) continue
    return imageUrlToFile(url, 'pasted.png')
  }
  return null
}

async function onModalPaste(e: ClipboardEvent) {
  // Never hijack a real text paste (agent prompt bar, layer rename, text edit).
  if (isEditablePasteTarget(e.target) || isEditablePasteTarget(document.activeElement)) return

  // Sailor layer JSON on the OS clipboard wins over everything: it is how copy
  // reaches across frames, projects and sessions. Read it straight off the paste
  // event's clipboardData (synchronous, no permission prompt) rather than the
  // async navigator.clipboard.read() API. A foreign text paste parses to null and
  // falls through to the image path below. (Same-session ⌘V never reaches here —
  // the in-session clipboard consumes the keydown and suppresses the paste event.)
  const osLayers = parseLayersFromOS(e.clipboardData?.getData('text/plain') ?? null)
  if (osLayers) {
    e.preventDefault()
    e.stopImmediatePropagation()
    try {
      await pasteOSLayers(osLayers)
    } catch (err) {
      console.error('[Compositor] paste layers failed:', err)
      toast('Could not paste those layers')
    }
    return
  }

  const file = clipboardImageFile(e)
  if (file) {
    e.preventDefault()
    e.stopImmediatePropagation()
    try {
      await addImageFromFile(file)
    } catch (err) {
      console.error('[Compositor] paste image failed:', err)
      toast('Could not paste that image')
    }
    return
  }

  // No OS-clipboard image — try a canvas image artifact copied in-app.
  if (!nodeClipboard.has()) return  // nothing for us; let normal paste proceed
  e.preventDefault()
  e.stopImmediatePropagation()
  try {
    const nodeFile = await pastedNodeImageFile()
    if (!nodeFile) { toast('That copied node has no image to paste'); return }
    await addImageFromFile(nodeFile)
  } catch (err) {
    console.error('[Compositor] paste node image failed:', err)
    toast('Could not paste that image')
  }
}
// Templates gallery panel (sidebar door) dispatches this on "Place" — route
// it straight into placeTemplateIntoFrame, same as the in-modal Place button.
function handlePlaceTemplateEvent(e: Event) {
  const t = (e as CustomEvent).detail?.template as Template | undefined
  if (t) placeTemplateIntoFrame(t)
}
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('paste', onModalPaste, true)   // capture — see onModalPaste
  window.addEventListener('sailor:placeTemplate', handlePlaceTemplateEvent)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('paste', onModalPaste, true)
  window.removeEventListener('sailor:placeTemplate', handlePlaceTemplateEvent)
  pause()
})
</script>

<template>
  <div
    class="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-6"
    @click.self="emit('close')"
    @dragover.prevent
    @drop.prevent
  >
    <div class="w-full h-full max-w-[1560px] max-h-[960px] bg-[#0a0a0a] rounded-xl border border-white/10 shadow-2xl relative antialiased text-white/85 overflow-hidden">
    <!-- Modal title (top-left, studio-style). The stage is full-bleed, so zoomed
         content passes UNDER this chip — it carries the same glass scrim as the
         floating panels so it stays readable over a bright layer. -->
    <div class="glass-panel absolute top-4 left-4 z-30 rounded-lg border border-white/10 bg-[#0e0e10]/75 backdrop-blur-md shadow-lg px-2.5 py-1 text-sm font-semibold tracking-tight text-white truncate max-w-[260px]" :title="frameName">{{ frameName }}</div>

    <!-- Glimm sweep over the frame while the agent works. -->
    <AgentSweep :active="caBusy" />

    <!-- Left sidebar: floating glass layer panel.
         ⌘\ slides it out instead of unmounting it: the list keeps its scroll
         position, expanded groups and in-flight renames across a hide/show. -->
    <div
      data-testid="compositor-left-panel"
      :data-hidden="panelsVisible ? '0' : '1'"
      class="glass-panel absolute top-16 left-4 bottom-4 z-20 w-60 flex flex-col rounded-xl border border-white/10 bg-[#0e0e10]/80 backdrop-blur-md shadow-2xl overflow-hidden transition-all duration-200 ease-out"
      :class="panelsVisible ? 'translate-x-0 opacity-100' : '-translate-x-[130%] opacity-0 pointer-events-none'">
      <div class="px-3 pt-3 pb-3 flex-1 min-h-0 overflow-y-auto">
        <div class="panel-heading mb-2 px-1">Layers</div>

        <!-- Unified z-order stack (top-first). Grouped layers indent; grip to reorder. -->
        <div @drop="onListDrop" @dragover.prevent>
          <template v-for="(row, idx) in flatRows" :key="row.rk">
            <div v-if="dropIndex === idx" class="h-0.5 bg-white/70 rounded mx-1.5 my-0.5" />
            <div
              class="group/row flex items-center gap-1.5 pr-2 py-1.5 rounded transition-colors"
              :style="{ paddingLeft: ((row as any).depth * 14 + 4) + 'px' }"
              :class="[
                rowSelected(row) ? 'bg-white/10' : 'hover:bg-white/[0.04]',
                (row as any).depth > 0 ? 'border-l border-white/10' : '',
                dragRk === row.rk ? 'opacity-40' : '',
                editingGroupId === (row as any).groupId && row.kind === 'group' ? 'cursor-default' : 'cursor-pointer',
              ]"
              @dragover="onRowDragOver(idx, $event)"
              @drop="onListDrop"
              @click="onRowClick(row)"
              @dblclick="onRowDblClick(row)"
            >
              <!-- Grip (drag source) -->
              <span
                class="opacity-0 group-hover/row:opacity-100 text-white/25 hover:text-white/70 cursor-grab active:cursor-grabbing shrink-0"
                draggable="true" title="Drag to reorder"
                @dragstart="onGripDragStart(row.rk, $event)" @dragend="onDragEnd" @click.stop
              >
                <GripVertical class="size-3.5" />
              </span>
              <!-- Group chevron -->
              <button v-if="row.kind === 'group'" class="text-white/40 hover:text-white/80 p-0.5 cursor-pointer -ml-0.5"
                title="Expand/collapse" @click.stop="toggleGroup(row.groupId)">
                <component :is="expandedGroups.has(row.groupId) ? ChevronDown : ChevronRight" class="size-3.5" />
              </button>
              <!-- Icon / thumbnail -->
              <!-- Group: its first child's live thumb, else the group icon. -->
              <template v-if="row.kind === 'group'">
                <img v-if="rowThumb(row)" :src="rowThumb(row)!"
                  class="rounded object-contain shrink-0 ring-1 ring-white/10 bg-white/[0.03] size-4"
                  alt="" draggable="false" title="Group" data-testid="layer-thumb" />
                <Group v-else class="size-3.5 text-white/60 shrink-0" />
              </template>
              <!-- Live image preview for image layers (local + wired), so the row reads at a glance -->
              <img v-else-if="rowThumbUrl(row)" :src="rowThumbUrl(row)!"
                class="rounded object-cover shrink-0 ring-1 ring-white/10 bg-white/[0.03]"
                :class="row.kind === 'child' ? 'size-3.5' : 'size-4'"
                alt="" draggable="false" data-testid="layer-thumb" />
              <ImageIcon v-else-if="row.kind === 'wired'" class="size-3.5 text-white/60 shrink-0" />
              <!-- Live rendered thumbnail (text / shape / line / brush / path), from the
                   same per-layer draw the stack uses. -->
              <img v-else-if="rowThumb(row)" :src="rowThumb(row)!"
                class="rounded object-contain shrink-0 ring-1 ring-white/10 bg-white/[0.03]"
                :class="row.kind === 'child' ? 'size-3.5' : 'size-4'"
                alt="" draggable="false" data-testid="layer-thumb" />
              <!-- Fill swatch (so a layer's colour/gradient/pattern is identifiable at a glance), else the kind icon -->
              <FillSwatch v-else-if="rowFill(row.layer)" :paint="rowFill(row.layer)!" :size="row.kind === 'child' ? 12 : 14" />
              <component v-else :is="kindIcon(row.layer.kind)"
                :class="row.kind === 'child' ? 'size-3 text-white/45 shrink-0' : 'size-3.5 text-white/60 shrink-0'" />
              <!-- Label / rename input -->
              <input
                v-if="row.kind === 'group' && editingGroupId === row.groupId"
                v-model="groupNameDraft"
                :ref="(el: any) => el?.focus?.()"
                class="flex-1 min-w-0 bg-white/[0.06] rounded px-1 text-sm outline-none"
                @click.stop @mousedown.stop
                @keydown.enter.prevent="commitGroupRename"
                @keydown.esc.prevent="editingGroupId = null"
                @blur="commitGroupRename"
              />
              <input
                v-else-if="(row.kind === 'local' || row.kind === 'child') && editingLayerNameId === row.layer.id"
                v-model="layerNameDraft"
                :ref="(el: any) => el?.focus?.()"
                class="flex-1 min-w-0 bg-white/[0.06] rounded px-1 text-sm outline-none"
                @click.stop @mousedown.stop
                @keydown.enter.prevent="commitLayerRename"
                @keydown.esc.prevent="editingLayerNameId = null"
                @blur="commitLayerRename"
              />
              <span v-else-if="row.kind === 'group'" class="text-sm truncate flex-1" title="Double-click to rename"
                @dblclick.stop="startGroupRename(row.groupId)">{{ groupLabel(row.groupId) }} <span class="text-white/40">· {{ row.count }}</span></span>
              <input
                v-else-if="row.kind === 'wired' && editingWiredSlot === row.slot"
                v-model="wiredNameDraft"
                :ref="(el: any) => el?.focus?.()"
                class="flex-1 min-w-0 bg-white/[0.06] rounded px-1 text-sm outline-none"
                @click.stop @mousedown.stop
                @keydown.enter.prevent="commitWiredRename"
                @keydown.esc.prevent="editingWiredSlot = null"
                @blur="commitWiredRename"
              />
              <span v-else-if="row.kind === 'wired'" class="text-sm truncate flex-1"
                :class="rowHidden(row) ? 'text-white/35' : ''"
                title="Double-click to rename"
                @dblclick.stop="startWiredRename(row.slot)">{{ wiredLabel(row.slot) }}</span>
              <span v-else class="truncate flex-1 capitalize" :class="[row.kind === 'child' ? 'text-[13px] text-white/65' : 'text-sm', rowHidden(row) ? 'text-white/35 line-through decoration-white/20' : '']"
                title="Double-click to rename"
                @dblclick.stop="startLayerRename(row.layer.id)">{{ rowLabel(row) }}</span>
              <!-- Unlinked: the slot's edge is gone, so the layer keeps its last
                   size and placement but has no pixels to draw. Say so here rather
                   than letting it read as an empty layer. -->
              <span v-if="(row as any).layer?.kind === 'wired' && (row as any).layer?.unlinked"
                class="shrink-0 rounded px-1 py-px text-[9.5px] uppercase tracking-wide bg-amber-400/15 text-amber-300/90 border border-amber-400/25"
                title="This layer's input was disconnected — reconnect the input to bring its pixels back">unlinked</span>
              <!-- Lock (locked layers render but ignore canvas clicks/drags) -->
              <button v-if="row.kind !== 'group'"
                class="transition cursor-pointer"
                :class="rowLocked(row) ? 'text-amber-300/90' : 'opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80'"
                :title="rowLocked(row) ? 'Unlock' : 'Lock (not selectable on canvas)'"
                @click.stop="toggleRowLocked(row)">
                <component :is="rowLocked(row) ? Lock : LockOpen" class="size-3.5" />
              </button>
              <!-- Visibility (hidden layers drop out of render, bake and export) -->
              <button v-if="row.kind !== 'group'"
                class="transition cursor-pointer"
                :class="rowHidden(row) ? 'text-white/70' : 'opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80'"
                :title="rowHidden(row) ? 'Show' : 'Hide'"
                @click.stop="toggleRowHidden(row)">
                <component :is="rowHidden(row) ? EyeOff : Eye" class="size-3.5" />
              </button>
              <!-- Copy a wired image into the frame: bake a local copy, hide the wire.
                   Gated on the ROW'S SLOT, not `row.kind` — after unification a wired
                   slot lists as a normal layer row, and gating on the kind silently
                   dropped this affordance from every migrated frame. -->
              <button v-if="rowWiredSlot1(row) != null"
                class="transition cursor-pointer opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80 disabled:opacity-30 disabled:cursor-default"
                :disabled="copyingSlot != null"
                title="Copy into frame — bakes a local copy and hides the wired layer (not undoable; use Show to restore)"
                data-testid="wired-copy-into-frame"
                @click.stop="copyWiredIntoFrame(rowWiredSlot1(row)!)">
                <Copy class="size-3.5" />
              </button>
              <!-- Group opacity (compact hover-reveal slider; cascades to descendants) -->
              <input v-if="row.kind === 'group'"
                type="range" min="0" max="1" step="0.05"
                class="w-10 h-3 accent-white/70 opacity-0 group-hover/row:opacity-100 transition shrink-0 cursor-pointer"
                title="Group opacity"
                :value="groupRowOpacity(row.groupId)"
                @click.stop @mousedown.stop @pointerdown.stop
                @input="setGroupOpacity(row.groupId, +($event.target as HTMLInputElement).value)"
              />
              <!-- Lock (group-locked ⇒ all descendants not selectable on canvas) -->
              <button v-if="row.kind === 'group'"
                class="transition cursor-pointer"
                :class="groupRowLocked(row.groupId) ? 'text-amber-300/90' : 'opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80'"
                :title="groupRowLocked(row.groupId) ? 'Unlock group' : 'Lock group (not selectable on canvas)'"
                @click.stop="setGroupLocked(row.groupId, !groupRowLocked(row.groupId))">
                <component :is="groupRowLocked(row.groupId) ? Lock : LockOpen" class="size-3.5" />
              </button>
              <!-- Visibility (group-hidden ⇒ all descendants hidden) -->
              <button v-if="row.kind === 'group'"
                class="transition cursor-pointer"
                :class="groupRowHidden(row.groupId) ? 'text-white/70' : 'opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80'"
                :title="groupRowHidden(row.groupId) ? 'Show group' : 'Hide group'"
                @click.stop="setGroupHidden(row.groupId, !groupRowHidden(row.groupId))">
                <component :is="groupRowHidden(row.groupId) ? EyeOff : Eye" class="size-3.5" />
              </button>
              <!-- Ungroup (dissolve this level) -->
              <button v-if="row.kind === 'group'" class="opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80 transition cursor-pointer"
                title="Ungroup" @click.stop="ungroupGroup(row.groupId)">
                <Ungroup class="size-3.5" />
              </button>
              <!-- Delete -->
              <button v-if="row.kind === 'group'" class="opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-red-400 transition cursor-pointer"
                title="Delete group" @click.stop="deleteGroup(row.groupId)">
                <Trash2 class="size-3.5" />
              </button>
              <button v-else-if="row.kind !== 'wired'" class="opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-red-400 transition cursor-pointer"
                title="Delete" @click.stop="deleteLocal(row.layerId)">
                <Trash2 class="size-3.5" />
              </button>
            </div>
          </template>
          <div v-if="dropIndex === flatRows.length" class="h-0.5 bg-white/70 rounded mx-1.5 my-0.5" />
        </div>
        <div v-if="!layers.length && !localLayers.length" class="text-xs text-white/30 px-1 py-2 italic">
          Connect images to the Compositor's layer ports, or add text/shapes below.
        </div>
      </div>
    </div>

    <!-- Full-bleed stage: spans the whole modal and passes UNDER the floating
         glass panels (z-20) and the title / close chrome (z-30), so zoomed and
         panned content slides beneath them instead of cropping at their edge.
         Fit still respects the panel gap — see PANEL_GUTTER_* above. -->
    <div
      ref="stageBoxRef"
      class="absolute inset-0 flex items-center justify-center overflow-hidden"
      :class="panning ? 'cursor-grabbing' : spaceDown ? 'cursor-grab' : ''"
      :style="{ paddingBottom: stagePadBottom + 'px' }"
      @wheel="onStageWheel"
      @pointerdown.capture="onStagePointerDownPan"
      @pointermove="onStagePointerMovePan"
      @pointerup="onStagePointerUpPan"
      @click="onStageBackgroundClick"
      @dragover="onCanvasDragOver"
      @dragleave="onCanvasDragLeave"
      @drop="onCanvasDrop"
    >
      <!-- Stage wrapper (overflow-visible): the artboard clips rendered layers,
           but selection controls live here so their handles can spill into the gutter.
           The pan/zoom view transform is applied here. -->
      <div ref="stageWrapRef" class="relative" :style="viewStyle">
      <div
        ref="canvasRef"
        class="absolute inset-0 bg-[#1a1a1a] rounded-md overflow-hidden ring-1 ring-white/5 transition-shadow"
        :class="[
          (pen.active.value || nodeEdit.active.value || (genActive && genTool === 'box')) ? 'cursor-crosshair' : ((genActive && genTool === 'brush') || brush.active.value || smartActive) ? 'cursor-none' : '',
          dropActive ? '!ring-2 !ring-white/70' : '',
        ]"
        @click="onCanvasClick"
        @pointerdown.capture="onCanvasPointerDownCapture"
        @pointermove="onCanvasPointerMoveCapture"
        @pointerup="onCanvasPointerUpCapture"
        @pointerleave="genCursor.on = false; smartCursor.on = false; brush.cursor.value = null"
        @dblclick.capture="onCanvasDblClickCapture"
      >
        <!-- Unified stack canvas: wired + local layers in z-order (WYSIWYG) -->
        <canvas
          ref="overlayCanvas"
          data-testid="compositor-stack-canvas"
          class="absolute inset-0 pointer-events-none"
          :style="{ width: canvasDisplay.w + 'px', height: canvasDisplay.h + 'px' }"
        />

        <!-- Grid overlay — editor guide only. Gated on the grid config; lives
             entirely outside the paint/bake path (see gridConfig above, and every
             paintLayerStack call in this file draws into an offscreen canvas, not
             this DOM overlay), so it can never appear in an export or embed. -->
        <svg
          v-if="showGridOverlay"
          data-testid="compositor-grid-overlay"
          class="absolute inset-0 pointer-events-none"
          :width="canvasDisplay.w" :height="canvasDisplay.h" :viewBox="`0 0 ${canvasDisplay.w} ${canvasDisplay.h}`"
        >
          <rect
            v-for="(r, i) in gridResolved.regions" :key="'region-' + i"
            :x="r.x" :y="r.y" :width="r.w" :height="r.h"
            fill="#22d3ee" fill-opacity="0.05" stroke="none"
          />
          <line
            v-for="(x, i) in gridResolved.xs" :key="'x-' + i"
            :x1="x" :y1="0" :x2="x" :y2="canvasDisplay.h"
            stroke="#22d3ee" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"
          />
          <line
            v-for="(y, i) in gridResolved.ys" :key="'y-' + i"
            :x1="0" :y1="y" :x2="canvasDisplay.w" :y2="y"
            stroke="#22d3ee" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"
          />
        </svg>

        <!-- Shader-fill live-field ceiling hint (Task 6) — never truncate silently,
             same wording as Space Type / Shape Studio's own hint. -->
        <div v-if="shaderFieldsFrozen > 0"
             data-testid="compositor-shader-fields-frozen-hint"
             class="pointer-events-none absolute inset-x-3 bottom-3 rounded-md border border-amber-400/30 bg-black/70 px-3 py-2 text-[11px] text-amber-200/90">
          {{ shaderFieldsFrozen }} shader fill{{ shaderFieldsFrozen > 1 ? 's' : '' }} frozen — too many live shader
          fields at once (limit {{ LIVE_FIELD_CEILING }}). Remove a shader fill for full motion.
        </div>

        <!-- Generative-fill region overlay (tinted mask preview) -->
        <canvas
          v-show="genActive"
          ref="genOverlayCanvas"
          class="absolute inset-0 pointer-events-none"
          :style="{ width: canvasDisplay.w + 'px', height: canvasDisplay.h + 'px', opacity: 0.9 }"
        />
        <!-- glimm prism sweep while a generation is running, clipped to the region
             silhouette via a CSS mask (the mask updates only when the region changes). -->
        <canvas
          v-show="genActive"
          ref="genSweepCanvas"
          class="absolute inset-0 pointer-events-none"
          :style="{
            width: canvasDisplay.w + 'px',
            height: canvasDisplay.h + 'px',
            opacity: inpaint.busy.value ? 1 : 0,
            transition: 'opacity 240ms ease',
            maskImage: genSweepMaskUrl ? `url(${genSweepMaskUrl})` : 'none',
            WebkitMaskImage: genSweepMaskUrl ? `url(${genSweepMaskUrl})` : 'none',
            maskSize: '100% 100%', WebkitMaskSize: '100% 100%',
            maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
          }"
        />
        <!-- Smart-select overlay (tinted selection preview) + busy sweep -->
        <canvas
          v-show="smartActive"
          ref="smartOverlayCanvas"
          class="absolute inset-0 pointer-events-none"
          :style="{ width: canvasDisplay.w + 'px', height: canvasDisplay.h + 'px', opacity: 0.9 }"
        />
        <canvas
          v-show="smartActive"
          ref="smartSweepCanvas"
          class="absolute inset-0 pointer-events-none"
          :style="{
            width: canvasDisplay.w + 'px',
            height: canvasDisplay.h + 'px',
            opacity: smart.busy.value ? 1 : 0,
            transition: 'opacity 240ms ease',
            maskImage: smartSweepMaskUrl ? `url(${smartSweepMaskUrl})` : 'none',
            WebkitMaskImage: smartSweepMaskUrl ? `url(${smartSweepMaskUrl})` : 'none',
            maskSize: '100% 100%', WebkitMaskSize: '100% 100%',
            maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
          }"
        />
        <!-- Brush cursor ring (smart select) -->
        <div
          v-if="smartActive && smartCursor.on"
          class="absolute pointer-events-none rounded-full border border-white/90 bg-white/10"
          :style="{ left: (smartCursor.x - smartBrush / 2) + 'px', top: (smartCursor.y - smartBrush / 2) + 'px', width: smartBrush + 'px', height: smartBrush + 'px', zIndex: 30 }"
        />
        <!-- Brush cursor ring (gen region) -->
        <div
          v-if="genActive && genTool === 'brush' && genCursor.on"
          class="absolute pointer-events-none rounded-full border border-white/90 bg-white/10"
          :style="{ left: (genCursor.x - genBrush / 2) + 'px', top: (genCursor.y - genBrush / 2) + 'px', width: genBrush + 'px', height: genBrush + 'px', zIndex: 30 }"
        />
        <!-- Brush cursor ring (freehand paint) -->
        <div
          v-if="brush.active.value && brush.cursor.value"
          class="absolute pointer-events-none rounded-full border border-white/90 bg-white/10"
          :style="{ left: (brush.cursor.value.x * canvasDisplay.w - brush.sizePx.value / 2) + 'px', top: (brush.cursor.value.y * canvasDisplay.h - brush.sizePx.value / 2) + 'px', width: brush.sizePx.value + 'px', height: brush.sizePx.value + 'px', zIndex: 30 }"
        />

        <!-- Generated-object mini toolbar: cancel / re-roll / confirm -->
        <div
          v-if="genResult"
          data-gen-bar
          class="absolute z-40 -translate-x-1/2 flex items-center gap-1 bg-[#1a1a1a]/95 backdrop-blur-sm rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg"
          :style="{ left: Math.min(Math.max((genResult.bnd.minX + genResult.bnd.maxX) / 2, 64), canvasDisplay.w - 64) + 'px', top: Math.min(genResult.bnd.maxY + 12, canvasDisplay.h - 44) + 'px' }"
          @pointerdown.stop @click.stop
        >
          <button class="flex items-center justify-center size-8 rounded-[8px] hover:bg-white/10 text-white/80 cursor-pointer disabled:opacity-40 disabled:cursor-default" title="Cancel" :disabled="inpaint.busy.value" @click="cancelObject"><X class="size-4" /></button>
          <button class="flex items-center justify-center size-8 rounded-[8px] hover:bg-white/10 text-white/80 cursor-pointer disabled:opacity-40 disabled:cursor-default" title="Re-render" :disabled="inpaint.busy.value" @click="rerollObject"><RefreshCw class="size-4" :class="inpaint.busy.value ? 'animate-spin' : ''" /></button>
          <button class="flex items-center justify-center size-8 rounded-[8px] bg-white text-neutral-900 hover:bg-white/90 cursor-pointer disabled:opacity-40 disabled:cursor-default" title="Confirm" :disabled="inpaint.busy.value" @click="confirmObject"><Check class="size-4" /></button>
        </div>

        <!-- Smart-select action bar -->
        <div
          v-if="smartActive && smartBnd"
          data-smart-bar
          class="absolute z-40 -translate-x-1/2 flex items-center gap-0.5 bg-[#1a1a1a]/95 backdrop-blur-sm rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg"
          :style="{ left: Math.min(Math.max((smartBnd.minX + smartBnd.maxX) / 2, 130), canvasDisplay.w - 130) + 'px', top: Math.min(smartBnd.maxY + 12, canvasDisplay.h - 44) + 'px' }"
          @pointerdown.stop @click.stop
        >
          <button class="h-8 px-2 rounded-[8px] hover:bg-white/10 text-white/80 text-[11px] cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap"
            :disabled="!smartSelectionReady || smartActionBusy" title="Copy the selection to a new layer (source untouched)"
            data-testid="smart-action-new-layer" @click="smartNewLayer">New layer</button>
          <button class="h-8 px-2 rounded-[8px] hover:bg-white/10 text-white/80 text-[11px] cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap"
            :disabled="!smartSelectionReady || smartActionBusy" title="Lift the selection to a new layer and remove it from the source"
            data-testid="smart-action-cut-out" @click="smartCutOut">Cut out</button>
          <!-- wired generate-fill deferred (W6) -->
          <button v-if="smartTargetRef?.type !== 'wired'" class="h-8 px-2 rounded-[8px] hover:bg-white/10 text-white/80 text-[11px] cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap"
            :disabled="!smartSelectionReady || smartActionBusy" title="Regenerate the selected area with a prompt (Generate mode)"
            data-testid="smart-action-generate-fill" @click="smartGenerateFill">Generate fill</button>
          <button class="h-8 px-2 rounded-[8px] hover:bg-white/10 text-white/80 text-[11px] cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap"
            :disabled="!smartSelectionReady || smartActionBusy" title="Add the silhouette as a stencil layer for Layer mask clipping"
            data-testid="smart-action-use-as-mask" @click="smartUseAsMask">Use as mask</button>
          <button class="h-8 px-2 rounded-[8px] hover:bg-white/10 text-rose-300/90 text-[11px] cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap"
            :disabled="!smartSelectionReady || smartActionBusy" title="Erase the selection from the layer (transparent hole)"
            data-testid="smart-action-delete" @click="smartDelete">Delete</button>
        </div>

        <!-- Multi-select outlines (when 2+ layers selected) -->
        <template v-if="selectedCount > 1 && !nodeEdit.active.value && !genActive">
          <div v-for="l in selectedLayers" :key="'ms-' + l.id"
            class="absolute pointer-events-none border border-white/40 rounded-[1px]"
            :style="multiOutlineStyle(l)" />
        </template>

        <!-- Snap guides (while dragging) -->
        <div v-if="snapGuides.vx != null" class="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
          :style="{ left: snapGuides.vx * canvasDisplay.w + 'px' }" />
        <div v-if="snapGuides.hy != null" class="absolute left-0 right-0 h-px bg-white/80 pointer-events-none"
          :style="{ top: snapGuides.hy * canvasDisplay.h + 'px' }" />

        <!-- Dimension HUD (while dragging) -->
        <div v-if="hud" class="absolute px-1.5 py-0.5 rounded bg-black/80 text-white text-[11px] font-medium tabular-nums pointer-events-none whitespace-nowrap"
          :style="{ left: hud.left + 'px', top: hud.top + 'px', transform: 'translate(-50%, -100%)' }">{{ hud.text }}</div>

        <!-- Marquee (rubber-band) selection rect -->
        <div v-if="marquee" class="absolute border border-white/80 bg-white/10 pointer-events-none"
          :style="{
            left: Math.min(marquee.x0, marquee.x1) * canvasDisplay.w + 'px',
            top: Math.min(marquee.y0, marquee.y1) * canvasDisplay.h + 'px',
            width: Math.abs(marquee.x1 - marquee.x0) * canvasDisplay.w + 'px',
            height: Math.abs(marquee.y1 - marquee.y0) * canvasDisplay.h + 'px',
          }" />

        <!-- Pen-tool draft overlay: live path preview + anchor dots (0..100 vb) -->
        <svg
          v-if="pen.active.value"
          class="absolute inset-0 pointer-events-none"
          :style="{ width: canvasDisplay.w + 'px', height: canvasDisplay.h + 'px' }"
          viewBox="0 0 100 100" preserveAspectRatio="none"
        >
          <path :d="pen.previewD.value" fill="none" stroke="#ffffff" stroke-width="0.4"
            vector-effect="non-scaling-stroke" />
          <g v-for="(a, i) in pen.anchors.value" :key="i">
            <circle :cx="a.x * 100" :cy="a.y * 100" r="0.8" :fill="i === 0 ? '#fde047' : '#ffffff'"
              vector-effect="non-scaling-stroke" stroke="#0a0a0a" stroke-width="0.3" />
          </g>
        </svg>

        <!-- Node-edit overlay: live path + bezier handles + anchor points -->
        <svg
          v-if="nodeEdit.active.value"
          class="absolute inset-0 pointer-events-none"
          :style="{ width: canvasDisplay.w + 'px', height: canvasDisplay.h + 'px' }"
          viewBox="0 0 100 100" preserveAspectRatio="none"
        >
          <path :d="nodeEdit.previewD.value" fill="none" stroke="#ffffff" stroke-width="0.4" vector-effect="non-scaling-stroke" />
          <template v-for="(s, i) in nodeEdit.segments.value" :key="i">
            <template v-if="i === nodeEdit.selected.value">
              <line v-if="s.inH" :x1="s.point.x*100" :y1="s.point.y*100" :x2="s.inH.x*100" :y2="s.inH.y*100"
                stroke="#ffffff" stroke-width="0.25" vector-effect="non-scaling-stroke" />
              <line v-if="s.outH" :x1="s.point.x*100" :y1="s.point.y*100" :x2="s.outH.x*100" :y2="s.outH.y*100"
                stroke="#ffffff" stroke-width="0.25" vector-effect="non-scaling-stroke" />
              <circle v-if="s.inH" :cx="s.inH.x*100" :cy="s.inH.y*100" r="0.7" fill="#0a0a0a" stroke="#ffffff" stroke-width="0.3" vector-effect="non-scaling-stroke" />
              <circle v-if="s.outH" :cx="s.outH.x*100" :cy="s.outH.y*100" r="0.7" fill="#0a0a0a" stroke="#ffffff" stroke-width="0.3" vector-effect="non-scaling-stroke" />
            </template>
            <rect :x="s.point.x*100 - 0.8" :y="s.point.y*100 - 0.8" width="1.6" height="1.6"
              :fill="i === nodeEdit.selected.value ? '#fde047' : '#ffffff'" stroke="#0a0a0a" stroke-width="0.3" vector-effect="non-scaling-stroke" />
          </template>
        </svg>

        <!-- Inline text editor -->
        <textarea
          v-if="editingLayer"
          ref="editRef"
          data-testid="frame-modal-text-edit"
          :value="editingLayer.text"
          class="absolute bg-transparent outline-none resize-none overflow-hidden border border-dashed border-yellow-400/70 px-0.5 nopan nodrag"
          :style="editingStyle"
          @input="setLocal(editingLayer!.id, { text: ($event.target as HTMLTextAreaElement).value })"
          @blur="endEdit"
          @keydown.escape.prevent="endEdit"
          @pointerdown.stop
        />

      </div>
      <!-- end artboard (clipped) — selection controls below live in the wrapper, unclipped -->

        <!-- Unlinked wired layer: the box is still there (last known size), but
             nothing is feeding it. Badge it on the selection itself, not only in
             the layers panel, or an empty selection box reads as a bug. -->
        <div
          v-if="localHandlePositions && (selectedLocal as any)?.kind === 'wired' && (selectedLocal as any)?.unlinked"
          class="absolute z-20 pointer-events-none rounded px-1.5 py-px text-[10px] uppercase tracking-wide bg-amber-400/20 text-amber-200 border border-amber-400/40 whitespace-nowrap"
          :style="{ left: localHandlePositions.topCenter.x + 'px', top: (localHandlePositions.topCenter.y - 18) + 'px', transform: 'translate(-50%, -100%)' }"
        >unlinked — re-wire this input</div>

        <!-- Local-layer selection / handles (single selection only — multi-select uses the group box below) -->
        <svg
          v-if="localHandlePositions && selectedIds.size <= 1 && !editingId && !genActive && !brush.active.value"
          class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          :viewBox="`0 0 ${canvasDisplay.w} ${canvasDisplay.h}`"
        >
          <polygon
            :points="`${localHandlePositions.tl.x},${localHandlePositions.tl.y} ${localHandlePositions.tr.x},${localHandlePositions.tr.y} ${localHandlePositions.br.x},${localHandlePositions.br.y} ${localHandlePositions.bl.x},${localHandlePositions.bl.y}`"
            fill="none" stroke="#ffffff" stroke-width="2" vector-effect="non-scaling-stroke"
          />
          <line
            :x1="localHandlePositions.topCenter.x" :y1="localHandlePositions.topCenter.y"
            :x2="localHandlePositions.rot.x" :y2="localHandlePositions.rot.y"
            stroke="#ffffff" stroke-width="2" vector-effect="non-scaling-stroke"
          />
        </svg>
        <template v-if="localHandlePositions && selectedIds.size <= 1 && !editingId && !genActive && !brush.active.value">
          <div
            v-for="corner in (['tl', 'tr', 'br', 'bl'] as const)"
            :key="'l-' + corner"
            data-handle
            class="absolute z-20 size-2.5 bg-white border border-white/60 cursor-nwse-resize"
            :style="{ left: localHandlePositions[corner].x + 'px', top: localHandlePositions[corner].y + 'px', transform: 'translate(-50%, -50%)' }"
            @pointerdown="selectedCornerResizable ? onLocalResizePointerDown(corner, $event) : onLocalScalePointerDown($event)"
          />
          <template v-if="selectedResizable">
            <div
              v-for="edge in (['t', 'r', 'b', 'l'] as const)"
              :key="'l-e-' + edge"
              data-handle
              :class="['absolute z-20 size-2.5 bg-white border border-white/60', edge === 't' || edge === 'b' ? 'cursor-ns-resize' : 'cursor-ew-resize']"
              :style="{ left: localHandlePositions[edge].x + 'px', top: localHandlePositions[edge].y + 'px', transform: 'translate(-50%, -50%)' }"
              @pointerdown="onLocalResizePointerDown(edge, $event)"
            />
          </template>
          <div
            data-handle
            class="absolute z-20 size-3 rounded-full bg-white cursor-grab border-2 border-[#1a1a1a]"
            :style="{ left: localHandlePositions.rot.x + 'px', top: localHandlePositions.rot.y + 'px', transform: 'translate(-50%, -50%)' }"
            @pointerdown="onLocalRotatePointerDown($event)"
          />
        </template>

        <!-- Group selection box + resize handles (≥2 selected) -->
        <svg
          v-if="selectionBox && !editingId && !genActive"
          class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          :viewBox="`0 0 ${canvasDisplay.w} ${canvasDisplay.h}`"
        >
          <rect
            :x="selectionBox.cx - selectionBox.w / 2" :y="selectionBox.cy - selectionBox.h / 2"
            :width="selectionBox.w" :height="selectionBox.h"
            fill="none" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"
          />
        </svg>
        <template v-if="selectionBox && !editingId && !genActive">
          <div
            v-for="corner in (['tl', 'tr', 'br', 'bl'] as const)"
            :key="'g-' + corner"
            data-handle
            class="absolute z-20 size-2.5 bg-white border border-white/60 cursor-nwse-resize"
            :style="{ left: selectionHandles![corner].x + 'px', top: selectionHandles![corner].y + 'px', transform: 'translate(-50%, -50%)' }"
            @pointerdown="startGroupResize(corner, $event)"
          />
        </template>

        <!-- Corner-pin distort handles (Distort tool active) -->
        <svg
          v-if="distortTool && distortHandlePositions && !editingId && !genActive"
          class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          :viewBox="`0 0 ${canvasDisplay.w} ${canvasDisplay.h}`"
        >
          <polygon
            :points="`${distortHandlePositions.tl.x},${distortHandlePositions.tl.y} ${distortHandlePositions.tr.x},${distortHandlePositions.tr.y} ${distortHandlePositions.br.x},${distortHandlePositions.br.y} ${distortHandlePositions.bl.x},${distortHandlePositions.bl.y}`"
            fill="none" stroke="#22d3ee" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"
          />
        </svg>
        <template v-if="distortTool && distortHandlePositions && !editingId && !genActive">
          <div
            v-for="ck in (['tl', 'tr', 'br', 'bl'] as const)"
            :key="'d-' + ck"
            data-handle
            class="absolute z-20 size-3 rounded-full bg-cyan-400 border-2 border-[#0a0a0a] cursor-move"
            :style="{ left: distortHandlePositions[ck].x + 'px', top: distortHandlePositions[ck].y + 'px', transform: 'translate(-50%, -50%)' }"
            @pointerdown="onDistortPointerDown(ck, $event)"
          />
        </template>
      </div>

      <!-- Chrome below is positioned against the stage box, which is now full-bleed
           (it used to start at top-16 / end at bottom-4). Their offsets carry a
           +64px top / +16px bottom compensation so they sit exactly where they did. -->

      <!-- Multi-select bar: align/distribute (any ≥2) + booleans (≥2 paths) -->
      <div
        v-if="selectedCount >= 2 && !nodeEdit.active.value"
        class="absolute top-[124px] left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#1a1a1a]/95 rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg"
        @pointerdown.stop
      >
        <button v-for="a in ALIGN_BTNS" :key="a.mode"
          class="flex items-center justify-center size-7 rounded hover:bg-white/12 text-white/80 cursor-pointer disabled:opacity-25"
          :disabled="(a.mode === 'hdist' || a.mode === 'vdist') && selectedCount < 3"
          :title="a.title" @click="alignSelected(a.mode)">
          <component :is="a.icon" class="size-4" />
        </button>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <button class="flex items-center justify-center size-7 rounded hover:bg-white/12 text-white/80 cursor-pointer disabled:opacity-25"
          :disabled="!canGroup" title="Group (⌘G)" @click="groupSelected"><Group class="size-4" /></button>
        <button class="flex items-center justify-center size-7 rounded hover:bg-white/12 text-white/80 cursor-pointer disabled:opacity-25"
          :disabled="!canUngroup" title="Ungroup (⌘⇧G)" @click="ungroupSelected"><Ungroup class="size-4" /></button>
        <template v-if="selectedPathCount >= 2">
          <div class="w-px h-5 bg-white/10 mx-0.5" />
          <button v-for="b in BOOL_OPS" :key="b.op"
            class="h-7 px-2 rounded bg-white/[0.06] hover:bg-white/12 text-[11px] text-white/85 cursor-pointer"
            @click="applyBoolean(b.op)">{{ b.label }}</button>
        </template>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <div class="relative">
          <button
            class="flex items-center justify-center size-7 rounded hover:bg-white/12 cursor-pointer"
            :class="showMultiPalette ? 'text-yellow-400' : 'text-white/80'"
            title="Apply palette to selected layers" @click="showMultiPalette = !showMultiPalette">
            <Palette class="size-4" />
          </button>
          <div v-if="showMultiPalette"
            class="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-[280px] rounded-[10px] border border-[#2a2a2a] bg-[#1a1a1a]/97 p-2 shadow-xl z-30"
            @pointerdown.stop>
            <div class="mb-1.5 text-[11px] text-white/60">Apply palette to {{ selectedCount }} selected layers</div>
            <PalettePicker mode="stops" @apply-family="applyPaletteToSelection"
              @apply-stops="(stops: GradientStop[]) => distributePaletteToSelection(stops.map(s => s.color))" />
          </div>
        </div>
      </div>
      <div
        v-else-if="nodeEdit.active.value"
        class="absolute top-[124px] left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white/15 rounded-[10px] px-3 py-1.5 border border-white/20 shadow-lg text-[11px] text-white/80"
        @pointerdown.stop
      >
        Editing path nodes — drag points & handles · Del removes a point ·
        <button class="underline hover:text-white cursor-pointer" @click="exitNodeEdit">Done (Esc)</button>
      </div>

      <!-- AI vector panel (floats above the toolbar) -->
      <Transition
        enter-active-class="transition-all duration-150 ease-out"
        leave-active-class="transition-all duration-100 ease-in"
        enter-from-class="opacity-0 translate-y-1"
        leave-to-class="opacity-0 translate-y-1"
      >
      <div
        v-if="aiOpen"
        class="absolute bottom-[84px] w-[340px] bg-[#1a1a1a]/97 rounded-[12px] p-3 border border-[#2a2a2a] shadow-xl text-white/85"
        @pointerdown.stop
      >
        <div class="flex items-center gap-1.5 mb-2 text-[11px] uppercase tracking-wide text-white/40">
          <Sparkles class="size-3.5" /> Generate vector
        </div>
        <textarea
          v-model="aiPrompt"
          rows="2"
          placeholder="a minimalist mountain logo, flat vector…"
          class="w-full bg-white/[0.06] rounded-md text-[12px] px-2 py-1.5 outline-none resize-none placeholder:text-white/25"
          @keydown.enter.exact.prevent="runGenerate"
        />
        <div class="flex items-center gap-1.5 mt-2">
          <select v-model="aiStyle" class="h-7 bg-white/[0.06] rounded text-[11px] px-1 outline-none cursor-pointer">
            <option value="any">Any</option>
            <option value="line_art">Line art</option>
            <option value="engraving">Engraving</option>
            <option value="linocut">Linocut</option>
          </select>
          <button
            class="flex-1 h-7 rounded bg-white hover:bg-white/90 text-neutral-900 text-[12px] font-medium cursor-pointer disabled:opacity-40 disabled:cursor-default"
            :disabled="aiBusy || !aiPrompt.trim()"
            @click="runGenerate"
          >{{ aiBusy ? 'Generating…' : 'Generate' }}</button>
        </div>

        <div class="mt-3 pt-2.5 border-t border-white/10">
          <div class="flex items-center gap-1.5 mb-2 text-[11px] uppercase tracking-wide text-white/40">
            <Wand2 class="size-3.5" /> Vectorize selected image
          </div>
          <div v-if="vectorizableUrl" class="flex items-center gap-1.5">
            <button
              class="flex-1 h-7 rounded bg-white/10 hover:bg-white/15 text-[12px] cursor-pointer disabled:opacity-40"
              :disabled="aiBusy" title="Free local VTracer"
              @click="runVectorize('local')"
            >{{ aiBusy ? '…' : 'Trace (free)' }}</button>
            <button
              class="flex-1 h-7 rounded bg-white/10 hover:bg-white/15 text-[12px] cursor-pointer disabled:opacity-40"
              :disabled="aiBusy" title="Recraft — higher fidelity, paid"
              @click="runVectorize('recraft')"
            >Recraft</button>
          </div>
          <div v-else class="text-[11px] text-white/30">Select an image layer to vectorize.</div>
        </div>

        <div v-if="aiError" class="mt-2 text-[11px] text-rose-400">{{ aiError }}</div>
      </div>
      </Transition>

      <!-- Bottom cluster: agent command bar + toolbar. The column is bottom-anchored
           and shrink-wraps to the toolbar's width (its widest child), so the bare
           prompt above stretches to exactly match the toolbar. -->
      <div v-if="inspectorTab !== 'motion'" class="absolute bottom-8 flex flex-col items-stretch gap-2 pointer-events-none">
      <!-- Agent command bar — bare prompt; its progress + proposal render in the
           right inspector (see the Assistant takeover branch).
           Collapsed to a pill until it's wanted: the AgentBar is never unmounted,
           only clipped and faded, so focus lands in the real input and a draft
           phrase survives (and in fact keeps the bar open — see promptExpanded). -->
      <div
        ref="promptDockRef"
        data-testid="compositor-prompt-dock"
        :data-expanded="promptExpanded ? '1' : '0'"
        class="pointer-events-auto relative self-start overflow-hidden transition-all duration-200 ease-out"
        :style="{ width: promptExpanded ? '100%' : '164px' }"
        @focusin="promptFocused = true"
        @focusout="onPromptFocusOut"
        @input="onPromptInput"
      >
        <div class="transition-opacity duration-150" :class="promptExpanded ? 'opacity-100' : 'opacity-0'">
          <AgentBar :busy="caBusy" :error="caError" :notice="caNotice" :chips="[]" @submit="caAsk" @chip="caAsk" />
        </div>
        <!-- The collapsed face. Not a replacement for the bar — it sits ON it and
             hands focus straight to the input underneath. -->
        <button
          v-show="!promptExpanded"
          type="button"
          data-testid="compositor-prompt-pill"
          class="absolute inset-0 flex items-center gap-2 rounded-md border border-white/[0.12] bg-[#141416] px-2.5 text-left text-[12px] text-white/45 hover:text-white/75 hover:border-white/20 cursor-pointer"
          title="Ask the assistant"
          @mousedown.prevent="focusPrompt"
          @click="focusPrompt"
        >
          <span class="text-[13px] text-white/80">✦</span>
          <span class="truncate">Ask…</span>
        </button>
      </div>
      <!-- Toolbar -->
      <div class="pointer-events-auto flex items-center gap-1 bg-[#1a1a1a]/95 rounded-[12px] p-1.5 border border-[#2a2a2a] shadow-lg">
        <!-- Zoom cluster: −, the % (opens the menu), +. The menu carries the
             navigation shortcuts, which had no home when the pill floated. -->
        <!-- .stop: the toolbar lives INSIDE the full-bleed stage, whose click
             handler is the menu's click-away — without this the toggle would
             open and immediately close itself on the same click. -->
        <div class="relative flex items-center gap-0.5" @click.stop>
          <button class="flex items-center justify-center size-8 rounded hover:bg-white/10 text-white/80 cursor-pointer"
            data-testid="zoom-out" title="Zoom out (⌘−)" @click="zoomBy(1 / 1.2)">
            <Minus class="size-4" />
          </button>
          <button
            class="h-8 min-w-[52px] px-1.5 rounded cursor-pointer text-[11px] tabular-nums"
            :class="zoomMenuOpen ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
            data-testid="zoom-menu-toggle" title="Zoom & navigation"
            @click="toggleZoomMenu()">
            {{ Math.round(view.scale * 100) }}%
          </button>
          <button class="flex items-center justify-center size-8 rounded hover:bg-white/10 text-white/80 cursor-pointer"
            data-testid="zoom-in" title="Zoom in (⌘+)" @click="zoomBy(1.2)">
            <Plus class="size-4" />
          </button>
          <Transition
            enter-active-class="transition-all duration-150 ease-out"
            leave-active-class="transition-all duration-100 ease-in"
            enter-from-class="opacity-0 translate-y-1"
            leave-to-class="opacity-0 translate-y-1"
          >
            <div v-if="zoomMenuOpen"
              data-testid="zoom-menu"
              class="absolute bottom-full left-0 mb-2 w-[248px] rounded-[10px] border border-[#2a2a2a] bg-[#1a1a1a]/97 p-1 shadow-xl"
              @pointerdown.stop>
              <button v-for="item in zoomMenuItems" :key="item.id"
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] cursor-pointer disabled:opacity-30 disabled:cursor-default hover:bg-white/10 text-white/85"
                :data-testid="'zoom-menu-' + item.id" :disabled="item.disabled" @click="item.run()">
                <span class="flex-1 text-left">{{ item.label }}</span>
                <span class="text-[11px] text-white/35 tabular-nums">{{ item.hint }}</span>
              </button>
              <!-- Each clause is atomic: a wrap mid-shortcut ("⌘\ —" / "hide panels") reads as noise. -->
              <div class="mt-1 border-t border-white/10 px-2 pb-1 pt-1.5 text-[10.5px] leading-relaxed text-white/40"
                data-testid="zoom-menu-hints"><span class="whitespace-nowrap">Space — pan</span> · <span class="whitespace-nowrap">Pinch/⌘ scroll — zoom</span> · <span class="whitespace-nowrap">⌘\ — hide panels</span></div>
            </div>
          </Transition>
        </div>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <button
          class="flex items-center justify-center size-8 rounded cursor-pointer"
          :class="isSelectTool ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
          title="Select (V)" @click="selectTool">
          <MousePointer2 class="size-4" />
        </button>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <button class="flex items-center justify-center size-8 rounded cursor-pointer disabled:opacity-30 hover:bg-white/10 text-white/80"
          title="Undo (⌘Z)" :disabled="!canUndo" @click="undo">
          <Undo2 class="size-4" />
        </button>
        <button class="flex items-center justify-center size-8 rounded cursor-pointer disabled:opacity-30 hover:bg-white/10 text-white/80"
          title="Redo (⌘⇧Z)" :disabled="!canRedo" @click="redo">
          <Redo2 class="size-4" />
        </button>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <button class="flex items-center justify-center size-8 rounded hover:bg-white/10 text-white/80 cursor-pointer" data-testid="add-text" title="Add text" @click="addText">
          <Type class="size-4" />
        </button>
        <!-- Shapes: the face stamps the last-used shape (one click to repeat),
             the chevron opens the list. Two real buttons rather than hit-testing
             zones inside one, so a 16px chevron target is still a real target. -->
        <div class="relative flex items-center" ref="shapesClusterRef" @click.stop>
          <button
            class="flex items-center justify-center h-8 w-7 rounded-l hover:bg-white/10 text-white/80 cursor-pointer"
            data-testid="shapes-face" :title="faceTitle"
            @click="stampFaceShape()">
            <svg v-if="shapeFaceResolved === 'library' && libraryShape" viewBox="0 0 96 96" class="size-4" fill="currentColor" aria-hidden="true">
              <path :d="libraryShape.d" :fill-rule="libraryShape.fillRule" />
            </svg>
            <component v-else :is="SHAPE_ICONS[shapeFaceResolved]" class="size-4" />
          </button>
          <button
            class="flex items-center justify-center h-8 w-4 rounded-r cursor-pointer"
            :class="shapesMenuOpen ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/50'"
            data-testid="shapes-menu-toggle" title="Shapes"
            @click="toggleShapesMenu()">
            <ChevronUp class="size-3" />
          </button>
          <Transition
            enter-active-class="transition-all duration-150 ease-out"
            leave-active-class="transition-all duration-100 ease-in"
            enter-from-class="opacity-0 translate-y-1"
            leave-to-class="opacity-0 translate-y-1"
          >
            <div v-if="shapesMenuOpen"
              data-testid="shapes-menu"
              class="absolute bottom-full left-0 mb-2 w-[160px] rounded-[10px] border border-[#2a2a2a] bg-[#1a1a1a]/97 p-1 shadow-xl"
              @pointerdown.stop>
              <button v-for="row in TOOLBAR_SHAPES" :key="row.id"
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] cursor-pointer text-white/85"
                :class="row.id === shapeFace ? 'bg-white/10' : 'hover:bg-white/10'"
                :data-testid="'shapes-menu-' + row.id" @click="pickShape(row.id)">
                <component :is="SHAPE_ICONS[row.id]" class="size-3.5 text-white/60" />
                <span class="flex-1 text-left">{{ row.label }}</span>
              </button>
            </div>
          </Transition>
          <ShapePicker
            v-if="libraryPickerOpen"
            :model-value="libraryShapeId ?? 'none'"
            :allow-none="false"
            :anchor="libraryPickerAnchor"
            :ignore="shapesClusterRef"
            @update:model-value="onLibraryPick"
            @close="libraryPickerOpen = false"
          />
        </div>
        <button
          class="flex items-center justify-center size-8 rounded cursor-pointer"
          :class="pen.active.value ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
          title="Pen — click to add points, drag for curves, click the first point or Enter to finish, Esc to cancel"
          @click="togglePen"
        >
          <PenTool class="size-4" />
        </button>
        <button
          class="flex items-center justify-center size-8 rounded cursor-pointer"
          :class="brush.active.value ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
          title="Brush — paint a freehand region (B)"
          @click="toggleBrush">
          <Brush class="size-4" />
        </button>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <!-- Insert: face+caret like Shapes. The face repeats the last-used row;
             the caret opens the anchored flyout. "Pick from canvas…" is the one
             row with a second hop (the centered picker surface). -->
        <div class="relative flex items-center" @click.stop>
          <button
            class="flex items-center justify-center h-8 w-7 rounded-l hover:bg-white/10 text-white/80 cursor-pointer"
            data-testid="insert-face" :title="insertFaceLabel(insertFace)"
            @click="runInsertFace()">
            <component :is="INSERT_ICONS[insertFace]" class="size-4" />
          </button>
          <button
            class="flex items-center justify-center h-8 w-4 rounded-r cursor-pointer"
            :class="insertMenuOpen ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/50'"
            data-testid="insert-menu-toggle" title="Insert — image or SVG"
            @click="toggleInsertMenu()">
            <ChevronUp class="size-3" />
          </button>
          <Transition
            enter-active-class="transition-all duration-150 ease-out"
            leave-active-class="transition-all duration-100 ease-in"
            enter-from-class="opacity-0 translate-y-1"
            leave-to-class="opacity-0 translate-y-1"
          >
            <div v-if="insertMenuOpen"
              data-testid="insert-menu"
              class="absolute bottom-full left-0 mb-2 w-[176px] rounded-[10px] border border-[#2a2a2a] bg-[#1a1a1a]/97 p-1 shadow-xl"
              @pointerdown.stop>
              <button v-for="row in TOOLBAR_INSERT" :key="row.id"
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] cursor-pointer text-white/85"
                :class="row.id === insertFace ? 'bg-white/10' : 'hover:bg-white/10'"
                :data-testid="'insert-menu-' + row.id" @click="pickInsertRow(row.id)">
                <component :is="INSERT_ICONS[row.id]" class="size-3.5 text-white/60" />
                <span class="flex-1 text-left">{{ row.label }}</span>
              </button>
            </div>
          </Transition>
          <!-- Second hop: the picker surface only (the Frame card keeps the
               full chooser, hence `picker-only` rather than a new component). -->
          <AddImageSourcePopover :open="pickerDialogOpen" picker-only
            @pick="onPickCanvasImage" @close="pickerDialogOpen = false" />
        </div>
        <!-- AI: the three generative flows, one button. Rows keep their old
             tooltips as subtitles; Smart select greys out without an image. -->
        <div class="relative flex items-center" @click.stop>
          <button
            class="flex items-center justify-center h-8 w-7 rounded-l cursor-pointer disabled:opacity-30 disabled:cursor-default"
            :class="aiToolActive ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
            data-testid="ai-face" :title="aiFaceLabel(aiFace) + ' — ' + aiFaceState().hint"
            :disabled="aiFaceState().disabled"
            @click="runAiFace()">
            <component :is="AI_ICONS[aiFace]" class="size-4" />
          </button>
          <button
            class="flex items-center justify-center h-8 w-4 rounded-r cursor-pointer"
            :class="aiMenuOpen ? 'bg-white text-neutral-900' : aiToolActive ? 'hover:bg-white/10 text-white/80' : 'hover:bg-white/10 text-white/50'"
            data-testid="ai-menu-toggle" title="AI — vector, generate in region, smart select"
            @click="toggleAiMenu()">
            <ChevronUp class="size-3" />
          </button>
          <Transition
            enter-active-class="transition-all duration-150 ease-out"
            leave-active-class="transition-all duration-100 ease-in"
            enter-from-class="opacity-0 translate-y-1"
            leave-to-class="opacity-0 translate-y-1"
          >
            <div v-if="aiMenuOpen"
              data-testid="ai-menu"
              class="absolute bottom-full right-0 mb-2 w-[268px] rounded-[10px] border border-[#2a2a2a] bg-[#1a1a1a]/97 p-1 shadow-xl"
              @pointerdown.stop>
              <button v-for="row in TOOLBAR_AI" :key="row.id"
                class="flex w-full items-start gap-2 rounded px-2 py-1.5 text-[12px] cursor-pointer disabled:opacity-30 disabled:cursor-default hover:bg-white/10 text-white/85"
                :class="{
                  'bg-white/10': (row.id === 'vector' && aiOpen) || (row.id === 'region' && genActive) || (row.id === 'smart' && smartActive),
                }"
                :data-testid="'ai-menu-' + row.id"
                :disabled="row.id === 'smart' && smartRowState().disabled"
                @click="runAiRow(row.id)">
                <Sparkles v-if="row.id === 'vector'" class="mt-0.5 size-3.5 text-white/60" />
                <Wand2 v-else-if="row.id === 'region'" class="mt-0.5 size-3.5 text-white/60" />
                <Lasso v-else class="mt-0.5 size-3.5 text-white/60" />
                <span class="flex-1 text-left">
                  {{ row.label }}
                  <span class="mt-0.5 block text-[10.5px] leading-snug text-white/40"
                    :data-testid="'ai-menu-hint-' + row.id">{{ row.id === 'smart' ? smartRowState().hint : row.hint }}</span>
                </span>
              </button>
            </div>
          </Transition>
        </div>
        <BrandImagePicker @add="(name, aspect) => addImageFromName(name, aspect)" />
        <button
          class="flex items-center justify-center size-8 rounded cursor-pointer"
          :class="brandOpen ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
          title="Brand — pick the project's active brand kit"
          @click="brandOpen = !brandOpen"
        >
          <Palette class="size-4" />
        </button>
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <button
          class="flex items-center justify-center size-8 rounded cursor-pointer"
          :class="templatesOpen ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
          data-testid="templates-toggle"
          title="Templates — save this frame as a reusable template, or place one"
          @click="toggleTemplatesPanel"
        >
          <LayoutTemplate class="size-4" />
        </button>
        <input ref="imageInputRef" type="file" accept="image/*" class="hidden" @change="onAddImageFile" />
        <input ref="brushFillInputRef" type="file" accept="image/*" class="hidden" @change="onBrushFillImageFile" />
        <input ref="svgInputRef" type="file" accept=".svg,image/svg+xml" class="hidden" @change="onImportSvgFile" />
        <input ref="templateImageInputRef" type="file" accept="image/*" class="hidden" @change="onTemplateSlotImageFile" />
      </div>
      </div>

      <!-- Docked motion timeline (replaces the agent bar + toolbar in Motion mode) -->
      <!-- Full-width chrome, so it is pinned to the panel gap by hand (the stage
           behind it is full-bleed): panel gutter + the same 16px inset as before. -->
      <div v-if="inspectorTab === 'motion'" ref="motionTimelineRef" class="absolute bottom-8 z-20 pointer-events-auto"
        :style="{ left: (gapLeft + 16) + 'px', right: (gapRight + 16) + 'px' }"
        @pointerdown.stop @click.stop @dblclick.stop>
        <CompositorMotionTimeline
          :layers="localLayers" :selected-id="selectedLocal?.id ?? null"
          :motion="effectiveMotion" :t="previewT" :playing="playing"
          :baking="baking" :bake-progress="bakeProgress" :stale="motionStale" :bake-error="bakeError"
          @select="(id: string) => selectLocal(id)"
          @play="play" @pause="pause" @scrub="scrubTo" @bake="bakeMotion"
          @update:motion="setMotion" @commit="commitMotionTimeline" @before-change="recordHistory"
        />
      </div>
    </div>

    <!-- Floating top-right: esc/close (studio chrome). Same glass scrim as the
         title — these sit over the full-bleed stage and must survive light content. -->
    <div class="glass-panel absolute top-4 right-4 z-30 flex items-center gap-2 rounded-lg border border-white/10 bg-[#0e0e10]/75 backdrop-blur-md shadow-lg px-2 py-1">
      <span class="rounded border border-white/15 px-1.5 py-0.5 text-[11px] text-white/45 select-none">esc</span>
      <button type="button" aria-label="Close" title="Close (Esc)"
        class="text-white/55 transition-colors hover:text-white text-base leading-none px-1 cursor-pointer"
        @click="emit('close')">✕</button>
    </div>

    <!-- Per-project "template changed" banner: non-blocking, top-center between the
         title and close chips. Only ever lists copies staleInstances() considers
         SAFE (behind AND still slot-compatible) — a reshaped copy silently keeps
         its current version until someone re-picks its slots by hand. -->
    <div
      v-if="pendingTemplateUpdates.length"
      data-testid="template-update-banner"
      class="glass-panel absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 rounded-lg border border-white/10 bg-[#0e0e10]/75 backdrop-blur-md shadow-lg pl-2.5 pr-2 py-1.5"
    >
      <LayoutTemplate class="size-3.5 text-white/60 shrink-0" />
      <span class="text-[12px] text-white/80 whitespace-nowrap">
        {{ pendingTemplateUpdates.length === 1 ? '1 copy uses a template that changed' : `${pendingTemplateUpdates.length} copies use templates that changed` }} — review updates?
      </span>
      <StudioButton variant="primary" @click="applyAllTemplateUpdates">Update all</StudioButton>
      <StudioButton variant="subtle" @click="dismissTemplateUpdates">Dismiss</StudioButton>
    </div>

    <!-- Right sidebar: floating glass properties panel -->
    <div
      data-testid="compositor-right-panel"
      :data-hidden="panelsVisible ? '0' : '1'"
      class="glass-panel absolute top-16 right-4 bottom-4 z-20 w-72 flex flex-col rounded-xl border border-white/10 bg-[#0e0e10]/80 backdrop-blur-md shadow-2xl overflow-hidden transition-all duration-200 ease-out"
      :class="panelsVisible ? 'translate-x-0 opacity-100' : 'translate-x-[130%] opacity-0 pointer-events-none'">
      <!-- Design | Motion tabs (hidden while the Assistant takes the panel over) -->
      <div v-if="!caPanelActive" class="shrink-0 px-3 pt-3">
        <div class="flex gap-1 rounded-lg bg-white/[0.04] p-1 text-[11px]">
          <button type="button" class="flex-1 rounded px-2 py-1 cursor-pointer"
                  :class="inspectorTab === 'design' ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                  @click="inspectorTab = 'design'">Design</button>
          <button type="button" class="flex-1 rounded px-2 py-1 cursor-pointer"
                  :class="inspectorTab === 'motion' ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                  @click="inspectorTab = 'motion'">Motion</button>
        </div>
      </div>
      <!-- Assistant: the agent's progress / proposed changes take over the inspector. -->
      <template v-if="caPanelActive">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Sparkles class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">Assistant</span>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-y-auto">
          <AgentProgress v-if="caBusy" :active="caBusy" />
          <div v-else-if="caReviewing && !caHasProposal" class="flex items-center gap-1.5 text-[11.5px] text-white/55">
            <span class="text-white/75">✦</span> Analyzing the result for imperfections<span class="animate-pulse">…</span>
          </div>
          <AgentProposal
            v-else-if="caHasProposal"
            :changes="caChanges" :busy="caBusy" :issues="caIssues" :review="caReview" :reviewing="caReviewing"
            @accept="caAccept" @reject="caReject" @reroll="caReroll"
            @keep="caKeep" @revert="caRevert" @hover="(i: number | null) => caHovered = i"
          />
        </div>
      </template>

      <!-- Brand kits (opening the palette takes over the inspector) -->
      <template v-else-if="brandOpen">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Palette class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">Brand kits</span>
          <button class="ml-auto text-white/40 hover:text-white/80 p-1" title="Close" @click="brandOpen = false"><X class="size-3.5" /></button>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-y-auto">
          <BrandLibraryPopover
            embedded
            :active-kit-id="projectBrand?.activeKitId.value ?? null"
            @set-active="(id) => projectBrand?.setBrandKit(id)"
          />
        </div>
      </template>

      <!-- Frame templates: save this frame as a reusable template (tap layers in
           the left panel to mark slots), or place one from the library. -->
      <template v-else-if="templatesOpen">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <LayoutTemplate class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">Templates</span>
          <button class="ml-auto text-white/40 hover:text-white/80 p-1" title="Close"
            @click="templatesOpen = false; cancelSaveTemplate()"><X class="size-3.5" /></button>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-y-auto">
          <template v-if="savingTemplate">
            <div class="mb-3">
              <div class="panel-label mb-1.5">Name</div>
              <input v-model="saveTemplateName" type="text" placeholder="e.g. Product card"
                data-testid="template-name-input"
                class="w-full h-8 px-2 rounded bg-white/[0.06] text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                @keydown.enter="confirmSaveTemplate" />
            </div>
            <p class="text-[10px] text-white/40 leading-snug mb-3">
              Click layers in the left panel to mark them as slots — the parts a placed copy can customize.
            </p>
            <div v-if="slotPicks.length" class="space-y-2 mb-3" data-testid="template-slot-picks">
              <div v-for="pick in slotPicks" :key="pick.layerId"
                class="rounded border border-white/[0.06] bg-white/[0.03] p-2 space-y-1.5">
                <div class="flex items-center gap-1.5">
                  <input v-model="pick.label" type="text" placeholder="Slot label"
                    class="flex-1 min-w-0 h-7 px-1.5 rounded bg-white/[0.06] text-[11px] outline-none" />
                  <select v-model="pick.kind" class="h-7 px-1 rounded bg-white/[0.06] text-[11px] outline-none">
                    <option value="text">Text</option>
                    <option value="color">Color</option>
                    <option value="image">Image</option>
                  </select>
                  <button class="text-white/35 hover:text-red-400 p-1 shrink-0" title="Remove slot"
                    @click="toggleSlotPick(pick.layerId)"><X class="size-3.5" /></button>
                </div>
              </div>
            </div>
            <p v-else class="text-[10.5px] text-white/30 italic mb-3">No slots marked yet — the template will still place, just with nothing to customize.</p>
            <div class="flex items-center gap-2">
              <button class="flex-1 h-8 rounded text-[11px] bg-white/[0.05] hover:bg-white/10 text-white/75 cursor-pointer"
                @click="cancelSaveTemplate">Cancel</button>
              <button class="flex-1 h-8 rounded text-[11px] bg-white text-neutral-900 font-medium cursor-pointer disabled:opacity-40"
                data-testid="template-save-confirm"
                :disabled="!saveTemplateName.trim()"
                @click="confirmSaveTemplate">Save template</button>
            </div>
          </template>
          <template v-else>
            <button
              class="w-full flex items-center justify-center gap-1.5 h-8 rounded text-[12px] bg-white/[0.06] hover:bg-white/12 text-white/85 cursor-pointer mb-4"
              data-testid="template-save-start"
              @click="beginSaveTemplate">
              <LayoutTemplate class="size-3.5" /> Save this frame as a template
            </button>
            <div class="panel-label mb-2">Library</div>
            <p v-if="!templateLib.templates.value.length" class="text-[10.5px] text-white/30 italic">No saved templates yet.</p>
            <div v-else class="space-y-1.5" data-testid="template-library-list">
              <div v-for="t in templateLib.templates.value" :key="t.id"
                class="flex items-center gap-2 rounded px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.06]">
                <LayoutTemplate class="size-3.5 text-white/40 shrink-0" />
                <span class="flex-1 min-w-0 truncate text-[12px]" :title="t.name">{{ t.name }}</span>
                <span class="text-[10px] text-white/35 tabular-nums shrink-0">v{{ t.version }}</span>
                <button class="h-6 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-white/12 text-white/80 cursor-pointer shrink-0"
                  data-testid="template-place"
                  @click="placeTemplateIntoFrame(t as unknown as Template)">Place</button>
              </div>
            </div>
          </template>
        </div>
      </template>

      <!-- Generate-in-region controls (mode owns the inspector) -->
      <template v-else-if="genActive">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Wand2 class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">Generate in region</span>
          <button class="ml-auto text-white/40 hover:text-white/80 p-1" title="Done (Esc)" @click="exitGenMode"><X class="size-3.5" /></button>
        </div>
        <div class="p-5 flex flex-col gap-6 flex-1 min-h-0 overflow-y-auto">
          <!-- Target -->
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-white/40">Target</span>
            <span class="text-white/70">{{ genTargetLabel }}</span>
          </div>

          <!-- Mode + model + style (new-object generation only) -->
          <template v-if="!genTarget">
            <div>
              <div class="panel-label mb-2">Mode</div>
              <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05]">
                <button
                  class="flex-1 h-8 rounded text-[11px] cursor-pointer transition-colors"
                  :class="genMode === 'style' ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
                  @click="genMode = 'style'">Style</button>
                <button
                  class="flex-1 h-8 rounded text-[11px] cursor-pointer transition-colors"
                  :class="genMode === 'scene' ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
                  @click="genMode = 'scene'">Scene</button>
              </div>
              <p class="text-[10px] text-white/35 mt-2 text-pretty leading-relaxed">
                {{ genMode === 'style' ? 'Generate from your prompt (optionally a trained style).' : 'Fit the new object to the existing frame.' }}
              </p>
            </div>

            <!-- Model picker -->
            <div>
              <div class="panel-label mb-2">Model</div>
              <div class="relative">
                <button
                  class="w-full h-9 px-3 rounded bg-white/[0.06] hover:bg-white/12 text-[12px] flex items-center justify-between gap-2 cursor-pointer"
                  @click="modelPickerOpen = !modelPickerOpen">
                  <span class="truncate text-left">{{ currentModel.name }}</span>
                  <ChevronDown class="size-3.5 text-white/40 shrink-0 transition-transform" :class="modelPickerOpen ? 'rotate-180' : ''" />
                </button>
                <Transition
                  enter-active-class="transition-all duration-150 ease-out"
                  leave-active-class="transition-all duration-100 ease-in"
                  enter-from-class="opacity-0 -translate-y-1"
                  leave-to-class="opacity-0 -translate-y-1"
                >
                <div v-if="modelPickerOpen" class="absolute top-full left-0 right-0 mt-1.5 z-30 rounded-md bg-neutral-900 border border-white/10 overflow-hidden shadow-xl">
                  <button v-for="m in GEN_MODELS" :key="m.id"
                    class="w-full px-3 py-2.5 text-left hover:bg-white/10 cursor-pointer flex flex-col gap-0.5"
                    :class="m.id === genModel ? 'bg-white/[0.06]' : ''"
                    @click="genModel = m.id; modelPickerOpen = false">
                    <span class="text-[12px]">{{ m.name }}</span>
                    <span class="text-[10px] text-white/40 leading-relaxed">{{ m.hint }}</span>
                  </button>
                </div>
                </Transition>
              </div>
            </div>

            <!-- Style picker (Flux + Style mode only) -->
            <div v-if="showStylePicker">
              <div class="panel-label mb-2">Style</div>
              <div class="relative">
                <button
                  class="w-full h-9 px-3 rounded bg-white/[0.06] hover:bg-white/12 text-[12px] flex items-center gap-2 cursor-pointer"
                  @click="stylePickerOpen = !stylePickerOpen">
                  <img v-if="genStyle?.coverUrl" :src="genStyle.coverUrl" class="size-5 rounded object-cover ring-1 ring-white/10" />
                  <span class="truncate text-left flex-1">{{ genStyle ? genStyle.name : 'None' }}</span>
                  <span v-if="genStyle" role="button" tabindex="0" class="text-white/40 hover:text-white/80" title="Clear" @click.stop="genStyle = null"><X class="size-3" /></span>
                  <ChevronDown v-else class="size-3.5 text-white/40 shrink-0 transition-transform" :class="stylePickerOpen ? 'rotate-180' : ''" />
                </button>
                <Transition
                  enter-active-class="transition-all duration-150 ease-out"
                  leave-active-class="transition-all duration-100 ease-in"
                  enter-from-class="opacity-0 -translate-y-1"
                  leave-to-class="opacity-0 -translate-y-1"
                >
                <div v-if="stylePickerOpen" class="absolute top-full left-0 right-0 mt-1.5 z-30 max-h-48 overflow-y-auto rounded-md bg-neutral-900 border border-white/10 shadow-xl flex flex-col">
                  <button class="px-3 py-2.5 text-left text-[12px] hover:bg-white/10 cursor-pointer"
                    @click="genStyle = null; stylePickerOpen = false">None</button>
                  <button v-for="s in styleList.styles.value" :key="s.filename"
                    class="px-3 py-2.5 text-left text-[12px] hover:bg-white/10 cursor-pointer flex items-center gap-2.5"
                    @click="genStyle = s; stylePickerOpen = false">
                    <img v-if="s.coverUrl" :src="s.coverUrl" class="size-6 rounded object-cover ring-1 ring-white/10" />
                    <span class="truncate">{{ s.name }}</span>
                  </button>
                  <p v-if="!styleList.styles.value.length" class="px-3 py-2.5 text-[11px] text-white/30">
                    {{ styleList.loading.value ? 'Loading…' : 'No trained styles yet.' }}
                  </p>
                </div>
                </Transition>
              </div>
            </div>
          </template>

          <!-- Region tool -->
          <div>
            <div class="panel-label mb-1.5">Region</div>
            <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05]">
              <button v-for="t in GEN_TOOLS" :key="t"
                class="flex-1 h-7 rounded text-[11px] capitalize cursor-pointer transition-colors"
                :class="genTool === t ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
                @click="genTool = t">{{ t }}</button>
            </div>
            <div v-if="genTool === 'brush'" class="flex items-center gap-2 mt-2">
              <span class="text-[10px] text-white/40 w-12 shrink-0">Brush</span>
              <input type="range" min="8" max="240" step="2" v-model.number="genBrush" class="flex-1 accent-white cursor-pointer" />
              <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ genBrush }}</span>
            </div>
            <button v-else-if="genTool === 'shape'"
              class="w-full h-7 mt-2 rounded bg-white/10 hover:bg-white/15 text-[12px] cursor-pointer disabled:opacity-40 disabled:cursor-default"
              :disabled="!genShapeCandidate" @click="genUseShape"
            >{{ genShapeCandidate ? 'Use selected shape →' : 'Select a shape/path first' }}</button>
            <p v-else class="text-[10px] text-white/35 mt-2">Drag a box over the canvas.</p>
          </div>

          <!-- Prompt -->
          <div>
            <div class="panel-label mb-1.5">Prompt</div>
            <textarea
              v-model="genPrompt"
              rows="3"
              placeholder="what object to generate…"
              class="pastel-hairline block w-full rounded-md text-[12px] px-2 py-1.5 outline-none resize-none placeholder:text-white/25"
              style="--pastel-hairline-bg: #16161b;"
              @keydown.enter.exact.prevent="runRegionFill"
            />
          </div>

          <div class="flex items-center gap-1.5">
            <button
              class="h-8 px-2.5 rounded bg-white/[0.06] hover:bg-white/12 text-[11px] cursor-pointer disabled:opacity-30 disabled:cursor-default"
              :disabled="!genHasMask" title="Clear region" @click="clearGenMask"
            >Clear</button>
            <button
              class="gen-pastel flex-1 h-8 rounded text-neutral-900 text-[12px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-default"
              :disabled="inpaint.busy.value || !genHasMask"
              @click="runRegionFill"
            >{{ inpaint.busy.value ? 'Generating…' : 'Generate' }}</button>
          </div>
          <p v-if="!genHasMask" class="text-[10px] text-white/30 -mt-1">Mark a region on the canvas to enable Generate.</p>
          <div v-if="inpaint.error.value" class="text-[11px] text-rose-400">{{ inpaint.error.value }}</div>
        </div>
      </template>

      <template v-else-if="inspectorTab === 'motion'">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Play class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">{{ selectedLocal ? 'Layer motion' : 'Frame motion' }}</span>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-y-auto">
          <MotionLayerEditor v-if="selectedLocal"
            :animation="(selectedLocal as any).animation" :frame-duration="effectiveMotion.duration"
            :layer-kind="selectedLocal.kind"
            @update="(a) => setLocal(selectedLocal!.id, { animation: a } as any)"
          />
          <div v-else class="flex flex-col gap-3 text-xs text-white/55">
            <p class="text-white/40 italic">Select a layer to animate it, or set the frame's timing below.</p>
            <label class="flex items-center justify-between gap-2">Duration (s)
              <input v-scrubnum type="number" min="0.5" max="60" step="0.5" :value="effectiveMotion.duration"
                class="w-16 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/90 outline-none"
                @change="setMotion({ duration: Math.max(0.5, Number(($event.target as HTMLInputElement).value) || 4) })">
            </label>
            <label class="flex items-center justify-between gap-2">FPS
              <input v-scrubnum type="number" min="1" max="60" step="1" :value="effectiveMotion.fps"
                class="w-16 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/90 outline-none"
                @change="setMotion({ fps: Math.max(1, Math.min(60, Number(($event.target as HTMLInputElement).value) || 30)) })">
            </label>
            <label class="flex items-center justify-between gap-2">Loop playback
              <input type="checkbox" class="accent-white/80" :checked="effectiveMotion.loop ?? false"
                @change="setMotion({ loop: ($event.target as HTMLInputElement).checked })">
            </label>
          </div>
        </div>
      </template>

      <!-- Smart select options -->
      <template v-else-if="smartActive">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Lasso class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">Smart select</span>
          <button class="ml-auto text-white/40 hover:text-white/80 p-1 disabled:opacity-40 disabled:cursor-default" title="Done (Esc)" :disabled="smartActionBusy" @click="exitSmartMode"><X class="size-3.5" /></button>
        </div>
        <div class="p-5 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
          <p class="text-[11px] text-white/45 leading-snug">
            Scribble roughly over an object on <span class="text-white/70">{{ smartTargetRef ? 'the selected image' : 'an image layer' }}</span> —
            the selection snaps to it. Hold <kbd class="px-1 rounded bg-white/10">Alt</kbd> to subtract.
          </p>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-white/40 w-12 shrink-0">Brush</span>
            <input type="range" min="8" max="240" step="2" v-model.number="smartBrush" class="flex-1 accent-white cursor-pointer" />
            <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ smartBrush }}</span>
          </div>
          <div class="text-[11px]" :class="smart.failed.value ? 'text-amber-400' : 'text-white/40'">
            <template v-if="smart.busy.value">Refining selection…</template>
            <template v-else-if="smart.failed.value">Smart refine unavailable — using your scribble.</template>
            <template v-else-if="smart.maskUrls.value?.length">Selection refined. Scribble to add, Alt-scribble to subtract.</template>
            <template v-else-if="smartHasScribble">Using your scribble as the selection.</template>
          </div>
          <button
            class="h-8 px-2.5 rounded bg-white/[0.06] hover:bg-white/12 text-[11px] cursor-pointer disabled:opacity-30 disabled:cursor-default self-start"
            :disabled="!smartBnd || smartActionBusy" @click="enterSmartMode()"
          >Clear selection</button>
          <button
            v-if="smartTargetRef?.type === 'wired' && wiredMaskUrlFor(smartTargetRef.slot)"
            class="h-8 px-2.5 rounded bg-white/[0.06] hover:bg-white/12 text-[11px] cursor-pointer disabled:opacity-30 disabled:cursor-default self-start"
            :disabled="smartActionBusy" data-testid="wired-clear-mask"
            title="Remove this slot's wired visibility mask" @click="clearWiredMask(smartTargetRef.slot)"
          >Clear mask</button>
        </div>
      </template>

      <!-- Brush tool options (freehand paint) -->
      <template v-else-if="brush.active.value">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Brush class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">Brush</span>
          <button class="ml-auto text-white/40 hover:text-white/80 p-1" title="Done (B)" @click="toggleBrush"><X class="size-3.5" /></button>
        </div>
        <div class="p-5 flex flex-col flex-1 min-h-0 overflow-y-auto">
          <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05] mb-2">
            <button v-for="m in ['paint','mask']" :key="m" class="flex-1 h-7 rounded text-[11px] capitalize cursor-pointer"
              :class="brush.mode.value === m ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
              @click="brush.mode.value = (m as any)">{{ m }}</button>
          </div>
          <p v-if="brush.mode.value === 'mask' && !((selectedLocal && selectedLocal.kind !== 'brush') || selectedWiredImage())"
            class="text-[10px] text-white/40 mb-2 leading-snug">Select a layer to mask</p>
          <button
            v-if="brush.mode.value === 'mask' && selectedWiredImage() && wiredMaskUrlFor(selectedWiredImage()!.slot)"
            class="h-7 px-2.5 rounded bg-white/[0.06] hover:bg-white/12 text-[11px] cursor-pointer self-start mb-2"
            data-testid="wired-clear-mask"
            title="Remove this slot's wired visibility mask" @click="clearWiredMask(selectedWiredImage()!.slot)"
          >Clear mask</button>
          <div v-if="brush.mode.value === 'paint'" class="flex items-center gap-2 mb-2">
            <span class="text-[10px] text-white/40 w-12 shrink-0">Color</span>
            <StudioColor :model-value="brush.color.value" @update:model-value="(v: string) => brush.color.value = v" />
          </div>
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[10px] text-white/40 w-12 shrink-0">Size</span>
            <input type="range" min="2" max="240" step="1" v-model.number="brush.sizePx.value" class="flex-1 accent-white cursor-pointer" />
            <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ brush.sizePx.value }}</span>
          </div>
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[10px] text-white/40 w-12 shrink-0">Flow</span>
            <input type="range" min="0.05" max="1" step="0.05" v-model.number="brush.opacity.value" class="flex-1 accent-white cursor-pointer" />
            <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ Math.round(brush.opacity.value * 100) }}</span>
          </div>
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[10px] text-white/40 w-12 shrink-0">Soft</span>
            <input type="range" min="0" max="1" step="0.05" :value="1 - brush.hardness.value"
              @input="brush.hardness.value = 1 - Number(($event.target as HTMLInputElement).value)" class="flex-1 accent-white cursor-pointer" />
            <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ Math.round((1 - brush.hardness.value) * 100) }}</span>
          </div>
          <button class="w-full h-7 rounded text-[11px] cursor-pointer"
            :class="brush.eraser.value ? 'bg-white text-neutral-900' : 'bg-white/[0.05] text-white/70 hover:bg-white/10'"
            @click="brush.eraser.value = !brush.eraser.value">{{ brush.eraser.value ? 'Eraser on' : 'Eraser' }}</button>
        </div>
      </template>

      <!-- Placed template copy: slot-fill panel + Freeze. Takes over whenever the
           selection touches a placed instance's layers (a single slot layer or
           the whole copy selected as a group both resolve here). -->
      <template v-else-if="activeTemplateInstance && activeTemplateInstanceTemplate">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <LayoutTemplate class="size-3.5 text-white/70" />
          <span class="text-sm font-medium truncate" :title="activeTemplateInstanceTemplate!.name">{{ activeTemplateInstanceTemplate!.name }}</span>
          <span class="text-[10px] text-white/35 tabular-nums shrink-0">v{{ activeTemplateInstance!.templateVersion }}</span>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-y-auto space-y-3" data-testid="template-instance-slots">
          <p v-if="!activeTemplateInstanceTemplate!.slots.length" class="text-[10.5px] text-white/30 italic">This template has no slots to fill.</p>
          <div v-for="slot in activeTemplateInstanceTemplate!.slots" :key="slot.id">
            <div class="panel-label mb-1.5">{{ slot.label }}</div>
            <input v-if="slot.kind === 'text'" type="text"
              :value="activeTemplateInstance!.slotValues[slot.id] ?? ''"
              data-testid="template-slot-text"
              class="w-full h-8 px-2 rounded bg-white/[0.06] text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              @change="fillTemplateSlot(activeTemplateInstance!, activeTemplateInstanceTemplate!, slot.id, ($event.target as HTMLInputElement).value)" />
            <StudioColor v-else-if="slot.kind === 'color'"
              :model-value="activeTemplateInstance!.slotValues[slot.id] ?? '#000000'"
              @update:model-value="(v: string) => fillTemplateSlot(activeTemplateInstance!, activeTemplateInstanceTemplate!, slot.id, v)" />
            <div v-else class="flex items-center gap-2">
              <span class="flex-1 min-w-0 truncate text-[11px] text-white/50" :title="activeTemplateInstance!.slotValues[slot.id]">{{ activeTemplateInstance!.slotValues[slot.id] || 'No image' }}</span>
              <button class="h-7 px-2 rounded text-[11px] bg-white/[0.06] hover:bg-white/12 text-white/80 cursor-pointer shrink-0"
                data-testid="template-slot-image-pick"
                @click="pickSlotImage(slot.id)">Change…</button>
            </div>
          </div>
          <div class="border-t border-white/[0.06] pt-3">
            <button
              class="w-full flex items-center justify-center gap-1.5 h-8 rounded text-[12px] bg-white/[0.06] hover:bg-white/12 text-white/85 cursor-pointer"
              data-testid="template-freeze"
              title="Detach this copy from the template — it stays on the frame as regular layers, no longer linked."
              @click="freezeTemplateInstance(activeTemplateInstance!)">
              <Snowflake class="size-3.5" /> Freeze
            </button>
          </div>
        </div>
      </template>

      <!-- Local-layer properties -->
      <template v-else-if="selectedLocal">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <component :is="kindIcon(selectedLocal.kind)" class="size-3.5 text-white/60" />
          <span class="text-sm font-medium capitalize">{{ selectedLocal.kind }}</span>
          <div class="ml-auto flex items-center gap-1">
            <button v-if="gridConfig.mode !== 'off'" class="text-white/40 hover:text-white/80 p-1" title="Re-snap to grid" @click="resnapSelected"><LayoutGrid class="size-3.5" /></button>
            <button class="text-white/40 hover:text-white/80 p-1" title="Bring forward" @click="moveStackZ(localKey(selectedLocal.id), 1)"><ArrowUp class="size-3.5" /></button>
            <button class="text-white/40 hover:text-white/80 p-1" title="Send backward" @click="moveStackZ(localKey(selectedLocal.id), -1)"><ArrowDown class="size-3.5" /></button>
            <button class="text-white/40 hover:text-red-400 p-1" title="Delete" @click="deleteLocal(selectedLocal.id)"><Trash2 class="size-3.5" /></button>
          </div>
        </div>
        <div class="inspector-body p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
          <!-- Text controls -->
          <template v-if="selectedLocal.kind === 'text'">
            <div>
              <div class="panel-label mb-1.5">Text</div>
              <textarea
                :value="(selectedLocal as any).text" rows="2"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none resize-none"
                @input="setLocal(selectedLocal!.id, { text: ($event.target as HTMLTextAreaElement).value })"
              />
            </div>
            <div>
              <div class="panel-label mb-1.5">Font</div>
              <FontPicker
                :selected-key="fontPickerKey"
                :label="(selectedLocal as any).fontFamily || 'Inter'"
                sublabel=""
                @pick="onPickFont"
              />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="panel-label mb-1.5">Size</div>
                <input v-scrubnum type="number" min="1" :value="pxW((selectedLocal as any).fontSize)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setSizePx(selectedLocal!.id, 'fontSize', parseFloat(($event.target as HTMLInputElement).value) || 1)" />
              </div>
              <div>
                <div class="panel-label mb-1.5">Weight</div>
                <select :value="(selectedLocal as any).fontWeight || 400"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                  @change="setLocal(selectedLocal!.id, { fontWeight: parseInt(($event.target as HTMLSelectElement).value) || 400 })">
                  <option v-for="w in FONT_WEIGHTS" :key="w.v" :value="w.v">{{ w.label }} · {{ w.v }}</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="panel-label mb-1.5">Align</div>
                <div class="flex gap-1">
                  <button v-for="a in (['left','center','right','justify'] as const)" :key="a" :title="a"
                    class="flex-1 flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5"
                    :class="(selectedLocal as any).align === a ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setLocal(selectedLocal!.id, { align: a })">
                    <component :is="a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : a === 'right' ? AlignRight : AlignJustify" class="size-3.5" />
                  </button>
                </div>
              </div>
              <div>
                <div class="panel-label mb-1.5">V-align</div>
                <div class="flex gap-1">
                  <button v-for="v in (['top','middle','bottom','justify'] as const)" :key="v" :title="(selectedLocal as any).boxH ? v : 'Set box H to enable'"
                    class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-[10px]"
                    :class="((selectedLocal as any).valign ?? 'top') === v ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50'"
                    @click="setLocal(selectedLocal!.id, { valign: v } as any)">{{ v === 'justify' ? '↕' : v.charAt(0).toUpperCase() }}</button>
                </div>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="panel-label mb-1.5" title="Set a width to auto-wrap words; clear for free-flowing text">Text box W</div>
                <input v-scrubnum type="number" min="0" placeholder="auto"
                  :value="(selectedLocal as any).boxW ? pxW((selectedLocal as any).boxW) : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none placeholder-white/25"
                  @input="(e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); setLocal(selectedLocal!.id, { boxW: v > 0 ? v / outWidth : undefined } as any) }" />
              </div>
              <div>
                <div class="panel-label mb-1.5" title="Set a height to enable vertical align / justify">Text box H</div>
                <input v-scrubnum type="number" min="0" placeholder="auto"
                  :value="(selectedLocal as any).boxH ? pxW((selectedLocal as any).boxH) : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none placeholder-white/25"
                  @input="(e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); setLocal(selectedLocal!.id, { boxH: v > 0 ? v / outWidth : undefined } as any) }" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="panel-label mb-1.5" title="Line height as a multiple of the font size">Line height</div>
                <input v-scrubnum type="number" min="0.5" max="4" step="0.05" :value="(selectedLocal as any).lineHeight ?? 1.2"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setLocal(selectedLocal!.id, { lineHeight: parseFloat(($event.target as HTMLInputElement).value) || 1.2 })" />
              </div>
              <div>
                <div class="panel-label mb-1.5" title="Tracking, in em (fraction of the font size)">Letter spacing</div>
                <input v-scrubnum type="number" step="0.01" :value="(selectedLocal as any).letterSpacing ?? 0"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setLocal(selectedLocal!.id, { letterSpacing: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
              </div>
            </div>
            <div>
              <div class="panel-label mb-1.5">Style</div>
              <div class="flex gap-1">
                <button title="Underline"
                  class="flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 px-2.5"
                  :class="(selectedLocal as any).underline ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                  @click="setLocal(selectedLocal!.id, { underline: !(selectedLocal as any).underline })">
                  <Underline class="size-3.5" />
                </button>
                <button title="Strikethrough"
                  class="flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 px-2.5"
                  :class="(selectedLocal as any).strikethrough ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                  @click="setLocal(selectedLocal!.id, { strikethrough: !(selectedLocal as any).strikethrough })">
                  <Strikethrough class="size-3.5" />
                </button>
                <div class="w-px bg-white/[0.08] mx-0.5"></div>
                <button v-for="c in (['uppercase','lowercase','capitalize'] as const)" :key="c" :title="c"
                  class="flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 px-2.5"
                  :class="(selectedLocal as any).textTransform === c ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                  @click="setLocal(selectedLocal!.id, { textTransform: (selectedLocal as any).textTransform === c ? undefined : c })">
                  <component :is="c === 'uppercase' ? CaseUpper : c === 'lowercase' ? CaseLower : CaseSensitive" class="size-3.5" />
                </button>
              </div>
            </div>
            <div>
              <div class="flex items-center justify-between mb-1.5">
                <div class="panel-label" title="Place words individually — overrides Align">Expressive layout</div>
                <button
                  class="text-[10px] px-1.5 py-0.5 rounded border"
                  :class="(selectedLocal as any).expressive ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                  @click="toggleExpressive(selectedLocal)">
                  {{ (selectedLocal as any).expressive ? 'On' : 'Off' }}
                </button>
              </div>
              <div v-if="(selectedLocal as any).expressive" class="space-y-2.5">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <div class="panel-label mb-1">Words / line</div>
                    <input v-scrubnum type="number" min="1" max="12" :value="(selectedLocal as any).expressive.wordsPerLine"
                      class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                      @input="setExpressive(selectedLocal, { wordsPerLine: Math.max(1, parseInt(($event.target as HTMLInputElement).value) || 1) })" />
                  </div>
                  <div>
                    <div class="panel-label mb-1">Placement</div>
                    <select :value="(selectedLocal as any).expressive.placement"
                      class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                      @change="setExpressive(selectedLocal, { placement: ($event.target as HTMLSelectElement).value as any })">
                      <option value="random">Random</option>
                      <option value="edges">Edges</option>
                      <option value="staircase">Staircase</option>
                      <option value="alternate">Alternate</option>
                    </select>
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <div class="panel-label mb-1">Jitter X · {{ Math.round((selectedLocal as any).expressive.jitterX * 100) }}%</div>
                    <input type="range" min="0" max="1" step="0.05" :value="(selectedLocal as any).expressive.jitterX"
                      class="w-full" @input="setExpressive(selectedLocal, { jitterX: parseFloat(($event.target as HTMLInputElement).value) })" />
                  </div>
                  <div>
                    <div class="panel-label mb-1">Jitter Y · {{ Math.round((selectedLocal as any).expressive.jitterY * 100) }}%</div>
                    <input type="range" min="0" max="1" step="0.05" :value="(selectedLocal as any).expressive.jitterY"
                      class="w-full" @input="setExpressive(selectedLocal, { jitterY: parseFloat(($event.target as HTMLInputElement).value) })" />
                  </div>
                </div>
                <button
                  class="w-full flex items-center justify-center gap-1.5 bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-xs text-white/80 hover:text-white"
                  @click="rerollExpressive(selectedLocal)">
                  <RefreshCw class="size-3.5" /> Re-render
                </button>
              </div>
            </div>
            <div class="space-y-3">
              <div>
                <div class="panel-label mb-1.5">Color</div>
                <FillControl :model-value="(selectedLocal as any).color"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { color: v })" />
              </div>
              <div>
                <div class="panel-label mb-1.5">Outline</div>
                <FillControl allow-none :model-value="(selectedLocal as any).strokeColor"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { strokeColor: v })" />
                <input v-if="hasStroke(selectedLocal)" v-scrubnum type="number" min="0" step="1" :value="pxW((selectedLocal as any).strokeWidth)" placeholder="Outline width"
                  class="mt-1.5 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setSizePx(selectedLocal!.id, 'strokeWidth', parseFloat(($event.target as HTMLInputElement).value) || 0)" />
                <StrokeStyleRow v-if="hasStroke(selectedLocal)" class="mt-1.5" :align="(selectedLocal as any).strokeAlign" :dash="(selectedLocal as any).strokeDash"
                  :show-align="false" :out-width="outWidth"
                  @update:align="(v: any) => setLocal(selectedLocal!.id, { strokeAlign: v })"
                  @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
              </div>
            </div>
          </template>

          <!-- Rect / ellipse controls -->
          <template v-if="selectedLocal.kind === 'rect' || selectedLocal.kind === 'ellipse'">
            <div>
              <div class="panel-label mb-1.5">Fill</div>
              <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Stroke</div>
              <FillControl allow-none :model-value="(selectedLocal as any).stroke"
                @update:model-value="(v: any) => setStroke(selectedLocal!.id, v)" />
              <input v-if="hasStroke(selectedLocal)" v-scrubnum type="number" min="0" step="1" :value="pxW((selectedLocal as any).strokeWidth)" placeholder="Stroke width"
                class="mt-1.5 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setSizePx(selectedLocal!.id, 'strokeWidth', parseFloat(($event.target as HTMLInputElement).value) || 0)" />
              <StrokeStyleRow v-if="hasStroke(selectedLocal)" class="mt-1.5" :align="(selectedLocal as any).strokeAlign" :dash="(selectedLocal as any).strokeDash"
                show-align :out-width="outWidth"
                @update:align="(v: any) => setLocal(selectedLocal!.id, { strokeAlign: v })"
                @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
            </div>
            <div v-if="selectedLocal.kind === 'rect'">
              <div class="panel-label mb-1.5">Corner radius</div>
              <div class="flex items-center gap-1.5">
                <input v-scrubnum type="number" min="0" step="1" :value="radiusLinkedPx(selectedLocal)" data-radius-linked
                  class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setRadiusLinkedPx(selectedLocal, parseFloat(($event.target as HTMLInputElement).value) || 0)" />
                <button
                  class="shrink-0 size-[26px] flex items-center justify-center rounded border transition-colors"
                  :class="radiusRowExpanded ? 'bg-white/10 border-white/20 text-white/90' : 'bg-white/[0.04] border-white/[0.06] text-white/50 hover:text-white/80'"
                  :title="radiusRowExpanded ? 'Use one radius for every corner' : 'Set each corner separately'"
                  data-radius-expand
                  @click="toggleRadiusExpanded(selectedLocal)">
                  <component :is="radiusRowExpanded ? ChevronUp : ChevronDown" class="size-3.5" />
                </button>
              </div>
              <div v-if="radiusRowExpanded" class="grid grid-cols-2 gap-1.5 mt-1.5">
                <div v-for="corner in CORNER_FIELDS" :key="corner.label">
                  <div class="panel-label mb-1">{{ corner.label }}</div>
                  <input v-scrubnum type="number" min="0" step="1" :value="pxW(radiusCorners(selectedLocal)[corner.i]!)"
                    :data-radius-corner="corner.i"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setRadiusCornerPx(selectedLocal, corner.i, parseFloat(($event.target as HTMLInputElement).value) || 0)" />
                </div>
              </div>
            </div>
          </template>

          <!-- Polygon controls -->
          <template v-if="selectedLocal.kind === 'polygon'">
            <div>
              <div class="panel-label mb-1.5">Fill</div>
              <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Stroke</div>
              <FillControl allow-none :model-value="(selectedLocal as any).stroke"
                @update:model-value="(v: any) => setStroke(selectedLocal!.id, v)" />
              <input v-if="hasStroke(selectedLocal)" v-scrubnum type="number" min="0" step="1" :value="pxW((selectedLocal as any).strokeWidth)" placeholder="Stroke width"
                class="mt-1.5 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setSizePx(selectedLocal!.id, 'strokeWidth', parseFloat(($event.target as HTMLInputElement).value) || 0)" />
              <StrokeStyleRow v-if="hasStroke(selectedLocal)" class="mt-1.5" :align="(selectedLocal as any).strokeAlign" :dash="(selectedLocal as any).strokeDash"
                show-align :out-width="outWidth"
                @update:align="(v: any) => setLocal(selectedLocal!.id, { strokeAlign: v })"
                @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Sides</div>
              <input v-scrubnum type="number" min="3" step="1" :value="(selectedLocal as any).sides"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setLocal(selectedLocal!.id, { sides: Math.max(3, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 3)) })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Corner radius</div>
              <input type="range" min="0" max="1" step="0.01" :value="(selectedLocal as any).cornerRadius"
                class="w-full accent-white cursor-pointer"
                @input="setLocal(selectedLocal!.id, { cornerRadius: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
            </div>
          </template>

          <!-- Star controls -->
          <template v-if="selectedLocal.kind === 'star'">
            <div>
              <div class="panel-label mb-1.5">Fill</div>
              <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Stroke</div>
              <FillControl allow-none :model-value="(selectedLocal as any).stroke"
                @update:model-value="(v: any) => setStroke(selectedLocal!.id, v)" />
              <input v-if="hasStroke(selectedLocal)" v-scrubnum type="number" min="0" step="1" :value="pxW((selectedLocal as any).strokeWidth)" placeholder="Stroke width"
                class="mt-1.5 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setSizePx(selectedLocal!.id, 'strokeWidth', parseFloat(($event.target as HTMLInputElement).value) || 0)" />
              <StrokeStyleRow v-if="hasStroke(selectedLocal)" class="mt-1.5" :align="(selectedLocal as any).strokeAlign" :dash="(selectedLocal as any).strokeDash"
                show-align :out-width="outWidth"
                @update:align="(v: any) => setLocal(selectedLocal!.id, { strokeAlign: v })"
                @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Points</div>
              <input v-scrubnum type="number" min="3" step="1" :value="(selectedLocal as any).points"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setLocal(selectedLocal!.id, { points: Math.max(3, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 3)) })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Inner radius</div>
              <input type="range" min="0.01" max="0.99" step="0.01" :value="(selectedLocal as any).innerRatio"
                class="w-full accent-white cursor-pointer"
                @input="setLocal(selectedLocal!.id, { innerRatio: parseFloat(($event.target as HTMLInputElement).value) || 0.5 })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Corner radius</div>
              <input type="range" min="0" max="1" step="0.01" :value="(selectedLocal as any).cornerRadius"
                class="w-full accent-white cursor-pointer"
                @input="setLocal(selectedLocal!.id, { cornerRadius: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
            </div>
          </template>

          <!-- Line controls -->
          <template v-if="selectedLocal.kind === 'line'">
            <div>
              <div class="panel-label mb-1.5">Color</div>
              <FillControl allow-none :model-value="(selectedLocal as any).stroke"
                @update:model-value="(v: any) => setStroke(selectedLocal!.id, v)" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Thickness</div>
              <input v-scrubnum type="number" min="1" step="1" :value="pxW((selectedLocal as any).strokeWidth)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setSizePx(selectedLocal!.id, 'strokeWidth', parseFloat(($event.target as HTMLInputElement).value) || 1)" />
            </div>
            <div>
              <StrokeStyleRow :dash="(selectedLocal as any).strokeDash" :out-width="outWidth"
                @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
            </div>
          </template>

          <!-- Path (vector) controls -->
          <template v-if="selectedLocal.kind === 'path'">
            <div v-if="selectedShape">
              <div class="panel-label mb-1.5">Shape</div>
              <button
                ref="inspectorShapeButtonRef"
                type="button"
                class="w-full flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 cursor-pointer transition-colors"
                title="Swap for another library shape"
                @click="openInspectorShapePicker"
              >
                <svg viewBox="0 0 96 96" class="size-4 shrink-0" fill="currentColor" aria-hidden="true"><path :d="selectedShape.d" :fill-rule="selectedShape.fillRule" /></svg>
                <span class="flex-1 text-left">{{ selectedShape.name }}</span>
              </button>
              <ShapePicker
                v-if="inspectorShapePickerOpen"
                :model-value="selectedShape.id"
                :allow-none="false"
                :anchor="inspectorShapeAnchor"
                :ignore="inspectorShapeButtonRef"
                @update:model-value="onInspectorShapePick"
                @close="inspectorShapePickerOpen = false"
              />
            </div>
            <div>
              <div class="panel-label mb-1.5">Fill</div>
              <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
            </div>
            <div>
              <div class="panel-label mb-1.5">Stroke</div>
              <FillControl allow-none :model-value="(selectedLocal as any).stroke"
                @update:model-value="(v: any) => setStroke(selectedLocal!.id, v)" />
              <StrokeStyleRow v-if="hasStroke(selectedLocal)" class="mt-1.5" :align="(selectedLocal as any).strokeAlign" :dash="(selectedLocal as any).strokeDash"
                show-align :out-width="outWidth" :scale="(selectedLocal as any).scale || 1"
                @update:align="(v: any) => setLocal(selectedLocal!.id, { strokeAlign: v })"
                @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
            </div>
          </template>

          <!-- Brush (freehand paint) controls: the stroke region takes any Paint fill -->
          <template v-if="selectedLocal.kind === 'brush'">
            <div>
              <div class="panel-label mb-1.5">Fill</div>
              <FillControl allow-image :model-value="(selectedLocal as any).fill"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
              <button
                class="mt-2 w-full flex items-center justify-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/70 hover:text-white/90 cursor-pointer transition-colors"
                title="Fill the painted shape with an image"
                @click="triggerBrushFillImage(selectedLocal!.id)"
              >
                <ImageIcon class="size-3.5" />
                Fill with image…
              </button>
            </div>
          </template>

          <!-- Deal (generative grid): the vocabulary + density + inset + seed drive
               the whole self-painting grid. Regularity/merge live in the doc Grid
               section; this deal carries its OWN grid seeded from it. -->
          <template v-if="selectedLocal.kind === 'deal'">
            <div>
              <div class="panel-label mb-1.5">Generator</div>
              <div class="flex flex-wrap gap-1.5">
                <StudioButton variant="secondary" title="Pane — rows of flush panes, each a two-colour ramp running corner to corner or edge to edge"
                  @click="onPane()">Pane</StudioButton>
                <StudioButton variant="secondary" title="Modular — a merged module grid over a background: empty, solid, block fields, dot clusters, line grids and ramps, with hairlines"
                  @click="onModular()">Modular</StudioButton>
                <StudioButton variant="secondary" title="Parcel — a coarse two-tone field of chunky ink blocks on a ground, with ragged hairline survey grids floating on top"
                  @click="onParcel()">Parcel</StudioButton>
                <StudioButton variant="secondary" title="Mosh — a corrupted signal: stacked bands of glitch, each a different failure, in hard full-strength inks with dead dark patches"
                  @click="onMosh()">Mosh</StudioButton>
              </div>
              <p class="mt-1 text-[10px] text-white/30 leading-snug">One click switches this deal to a generator at its own defaults; your current variation is kept.</p>
            </div>
            <div class="mt-2">
              <div class="panel-label mb-1.5">Palette</div>
              <StudioSegmented :options="DEAL_VOCABS as any" :model-value="(selectedLocal as any).vocab"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { vocab: v })" />
            </div>
            <div class="mt-2">
              <div class="panel-label mb-1.5">Cell fill</div>
              <StudioSegmented :options="DEAL_FILL_LABELS.map(f => f.label)"
                :model-value="dealFillLabel(selectedLocal as DealLayer)"
                @update:model-value="(v: any) => setDealFill(selectedLocal as DealLayer, v)" />
            </div>
            <!-- Mosh has its OWN layout (horizontal bands of glitch), so the grid controls
                 (density / inset / regularity / merge) don't apply to it. -->
            <div v-if="(selectedLocal as any).cellFill === 'mosh'" class="mt-2 flex flex-col gap-1.5">
              <StudioSelect label="Palette preset" :options="MOSH_PRESET_NAMES as any"
                :model-value="moshPreset" @update:model-value="(v: any) => applyMoshPreset(selectedLocal as DealLayer, v)" />
              <StudioSlider label="Bands" :min="MOSH_LIMITS.bands[0]" :max="MOSH_LIMITS.bands[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).mosh ?? defaultMosh()).bands"
                @update:model-value="(v: number) => patchMosh(selectedLocal as DealLayer, { bands: Math.round(v) })" />
              <StudioSlider label="Cells across" :min="MOSH_LIMITS.cols[0]" :max="MOSH_LIMITS.cols[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).mosh ?? defaultMosh()).cols"
                @update:model-value="(v: number) => patchMosh(selectedLocal as DealLayer, { cols: Math.round(v) })" />
              <StudioSlider label="Mix" :min="MOSH_LIMITS.mix[0]" :max="MOSH_LIMITS.mix[1]" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).mosh ?? defaultMosh()).mix"
                @update:model-value="(v: number) => patchMosh(selectedLocal as DealLayer, { mix: v })" />
              <StudioSlider label="Tears" :min="MOSH_LIMITS.tears[0]" :max="MOSH_LIMITS.tears[1]" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).mosh ?? defaultMosh()).tears"
                @update:model-value="(v: number) => patchMosh(selectedLocal as DealLayer, { tears: v })" />
              <StudioSlider label="Runs" :min="MOSH_LIMITS.runs[0]" :max="MOSH_LIMITS.runs[1]" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).mosh ?? defaultMosh()).runs"
                @update:model-value="(v: number) => patchMosh(selectedLocal as DealLayer, { runs: v })" />
              <StudioSlider label="Bright" :min="MOSH_LIMITS.bright[0]" :max="MOSH_LIMITS.bright[1]" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).mosh ?? defaultMosh()).bright"
                @update:model-value="(v: number) => patchMosh(selectedLocal as DealLayer, { bright: v })" />
            </div>
            <!-- Parcel has its OWN layout (a coarse two-tone block field with survey grids
                 on top), so the grid controls (density / inset / regularity / merge) don't
                 apply to it. -->
            <div v-else-if="(selectedLocal as any).cellFill === 'parcel'" class="mt-2 flex flex-col gap-1.5">
              <StudioSelect label="Palette preset" :options="PARCEL_PRESET_NAMES as any"
                :model-value="parcelPreset" @update:model-value="(v: any) => applyParcelPreset(selectedLocal as DealLayer, v)" />
              <div class="flex items-center gap-2">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="text-[11px] text-white/55">Ground</span>
                  <StudioColor :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).ground"
                    @update:model-value="(v: string) => patchParcel(selectedLocal as DealLayer, { ground: v })" />
                </div>
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="text-[11px] text-white/55">Ink</span>
                  <StudioColor :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).ink"
                    @update:model-value="(v: string) => patchParcel(selectedLocal as DealLayer, { ink: v })" />
                </div>
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="text-[11px] text-white/55">Lines</span>
                  <StudioColor :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).hairline"
                    @update:model-value="(v: string) => patchParcel(selectedLocal as DealLayer, { hairline: v })" />
                </div>
              </div>
              <StudioSlider label="Cells" :min="PARCEL_LIMITS.cells[0]" :max="PARCEL_LIMITS.cells[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).cells"
                @update:model-value="(v: number) => patchParcel(selectedLocal as DealLayer, { cells: Math.round(v) })" />
              <StudioSlider label="Cover" :min="PARCEL_LIMITS.cover[0]" :max="PARCEL_LIMITS.cover[1]" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).cover"
                @update:model-value="(v: number) => patchParcel(selectedLocal as DealLayer, { cover: v })" />
              <StudioSlider label="Chunk" :min="PARCEL_LIMITS.chunk[0]" :max="PARCEL_LIMITS.chunk[1]" :step="0.05" :bindable="false"
                :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).chunk"
                @update:model-value="(v: number) => patchParcel(selectedLocal as DealLayer, { chunk: v })" />
              <StudioSlider label="Survey grids" :min="PARCEL_LIMITS.grids[0]" :max="PARCEL_LIMITS.grids[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).grids"
                @update:model-value="(v: number) => patchParcel(selectedLocal as DealLayer, { grids: Math.round(v) })" />
              <div>
                <div class="panel-label mb-1.5">Blend</div>
                <StudioSegmented :options="['Multiply', 'Normal']"
                  :model-value="((selectedLocal as DealLayer).parcel ?? defaultParcel()).blend === 'normal' ? 'Normal' : 'Multiply'"
                  @update:model-value="(v: any) => patchParcel(selectedLocal as DealLayer, { blend: v === 'Normal' ? 'normal' : 'multiply' })" />
              </div>
            </div>
            <!-- Modular has its OWN layout (a merged module grid over a background), so the
                 grid controls (density / inset / regularity / merge) don't apply to it. -->
            <div v-else-if="(selectedLocal as any).cellFill === 'modular'" class="mt-2 flex flex-col gap-1.5">
              <div>
                <div class="panel-label mb-1.5">Palette preset</div>
                <StudioSegmented :options="MODULAR_PRESET_NAMES as any" :model-value="modularPreset"
                  @update:model-value="(v: any) => applyModularPreset(selectedLocal as DealLayer, v)" />
              </div>
              <div class="flex items-center gap-2">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="text-[11px] text-white/55">Background</span>
                  <StudioColor :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).bg"
                    @update:model-value="(v: string) => patchModular(selectedLocal as DealLayer, { bg: v })" />
                </div>
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="text-[11px] text-white/55">Rule</span>
                  <StudioColor :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).rule"
                    @update:model-value="(v: string) => patchModular(selectedLocal as DealLayer, { rule: v })" />
                </div>
              </div>
              <StudioSlider label="Columns" :min="MODULAR_LIMITS.gcols[0]" :max="MODULAR_LIMITS.gcols[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).gcols"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { gcols: Math.round(v) })" />
              <StudioSlider label="Unit" :min="MODULAR_LIMITS.unit[0]" :max="MODULAR_LIMITS.unit[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).unit"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { unit: Math.round(v) })" />
              <StudioSlider label="Merge" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).merge"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { merge: v })" />
              <div class="panel-label mt-1">Module mix</div>
              <StudioSlider v-for="t in MODULAR_TYPE_LABELS" :key="t.type" :label="t.label"
                :min="MODULAR_LIMITS.weight[0]" :max="MODULAR_LIMITS.weight[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).w[t.type]"
                @update:model-value="(v: number) => patchModularWeight(selectedLocal as DealLayer, t.type, Math.round(v))" />
              <StudioSlider label="Block fill" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).blockFill"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { blockFill: v })" />
              <StudioSlider label="Dot size" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).dot"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { dot: v })" />
              <StudioSlider label="Rules" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).rules"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { rules: v })" />
              <StudioSlider label="Rule width" :min="MODULAR_LIMITS.ruleW[0]" :max="MODULAR_LIMITS.ruleW[1]" :step="0.5" :bindable="false"
                :model-value="((selectedLocal as DealLayer).modular ?? defaultModular()).ruleW"
                @update:model-value="(v: number) => patchModular(selectedLocal as DealLayer, { ruleW: v })" />
            </div>
            <!-- Pane has its OWN layout (row masonry, every cell flush and filled), so the
                 grid controls (density / inset / regularity / merge) don't apply to it. -->
            <div v-else-if="(selectedLocal as any).cellFill === 'pane'" class="mt-2 flex flex-col gap-1.5">
              <StudioSlider label="Rows" :min="PANE_LIMITS.rows[0]" :max="PANE_LIMITS.rows[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).pane ?? defaultPane()).rows"
                @update:model-value="(v: number) => patchPane(selectedLocal as DealLayer, { rows: Math.round(v) })" />
              <StudioSlider label="Cells per row" :min="PANE_LIMITS.cells[0]" :max="PANE_LIMITS.cells[1]" :step="1" :bindable="false"
                :model-value="((selectedLocal as DealLayer).pane ?? defaultPane()).cells"
                @update:model-value="(v: number) => patchPane(selectedLocal as DealLayer, { cells: Math.round(v) })" />
              <StudioSlider label="Vary" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).pane ?? defaultPane()).vary"
                @update:model-value="(v: number) => patchPane(selectedLocal as DealLayer, { vary: v })" />
              <StudioSlider label="Diagonals" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).pane ?? defaultPane()).diag"
                @update:model-value="(v: number) => patchPane(selectedLocal as DealLayer, { diag: v })" />
              <StudioSlider label="Softness" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).pane ?? defaultPane()).soft"
                @update:model-value="(v: number) => patchPane(selectedLocal as DealLayer, { soft: v })" />
              <StudioSlider label="Spread" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="((selectedLocal as DealLayer).pane ?? defaultPane()).spread"
                @update:model-value="(v: number) => patchPane(selectedLocal as DealLayer, { spread: v })" />
            </div>
            <div v-else class="mt-2 flex flex-col gap-1.5">
              <StudioSlider label="Density" :min="0.05" :max="1" :step="0.02" :bindable="false"
                :model-value="(selectedLocal as any).density"
                @update:model-value="(v: number) => setLocal(selectedLocal!.id, { density: v })" />
              <StudioSlider label="Cell inset" :min="0" :max="0.4" :step="0.01" :bindable="false"
                :model-value="(selectedLocal as any).cellInset"
                @update:model-value="(v: number) => setLocal(selectedLocal!.id, { cellInset: v })" />
              <StudioSlider label="Regularity" :min="0" :max="1" :step="0.01" :bindable="false"
                :model-value="(selectedLocal as DealLayer).grid.gen.regularity"
                @update:model-value="(v: number) => patchDealGrid(selectedLocal as DealLayer, { gen: { ...(selectedLocal as DealLayer).grid.gen, regularity: v } })" />
              <StudioSwitch label="Merge cells" :model-value="(selectedLocal as DealLayer).grid.gen.merge"
                @update:model-value="(v: boolean) => patchDealGrid(selectedLocal as DealLayer, { gen: { ...(selectedLocal as DealLayer).grid.gen, merge: v } })" />
            </div>
            <div class="mt-2 flex items-center gap-2">
              <StudioButton variant="secondary" @click="rerollDeal(selectedLocal as DealLayer)">New variation</StudioButton>
              <div class="min-w-0 flex-1">
                <StudioSlider label="Seed" :min="1" :max="9999" :step="1" :default="42" :bindable="false"
                  :model-value="(selectedLocal as DealLayer).grid.gen.seed"
                  @update:model-value="(v: number) => patchDealGrid(selectedLocal as DealLayer, { gen: { ...(selectedLocal as DealLayer).grid.gen, seed: v } })" />
              </div>
            </div>
          </template>

          <!-- Image tint: fill blended over the image, clipped to its alpha -->
          <template v-if="selectedLocal.kind === 'image'">
            <div>
              <div class="panel-label mb-1.5">Tint</div>
              <FillControl allow-none :model-value="(selectedLocal as any).tint"
                @update:model-value="(v: any) => setLocal(selectedLocal!.id, { tint: v })" />
              <div v-if="hasTint(selectedLocal)" class="mt-1.5 grid grid-cols-2 gap-2">
                <select :value="(selectedLocal as any).tintBlend || 'normal'"
                  class="bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer capitalize"
                  @change="setLocal(selectedLocal!.id, { tintBlend: ($event.target as HTMLSelectElement).value } as any)">
                  <option v-for="m in LOCAL_BLEND_MODES" :key="m" :value="m">{{ m.replace('_', ' ') }}</option>
                </select>
                <div class="flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.06] rounded px-2">
                  <input type="range" min="0" max="100" step="1" :value="Math.round(((selectedLocal as any).tintOpacity ?? 1) * 100)" class="w-full accent-white cursor-pointer"
                    @input="setLocal(selectedLocal!.id, { tintOpacity: Math.max(0, Math.min(1, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) } as any)" />
                  <span class="text-[10px] text-white/40 tabular-nums w-7 text-right">{{ Math.round(((selectedLocal as any).tintOpacity ?? 1) * 100) }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- Size: W / H with aspect-ratio lock (shapes & images) -->
          <div v-if="selectedLocal.kind === 'rect' || selectedLocal.kind === 'ellipse' || selectedLocal.kind === 'image' || selectedLocal.kind === 'polygon' || selectedLocal.kind === 'star'">
            <div class="panel-label mb-1.5">Size</div>
            <div class="flex items-center gap-2">
              <label class="flex-1 flex items-center gap-2 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5">
                <span class="text-xs text-white/40">W</span>
                <input v-scrubnum type="number" min="1" :value="pxW((selectedLocal as any).w)"
                  class="w-full bg-transparent text-xs text-white/90 outline-none"
                  @input="setDimPx(selectedLocal!, 'w', parseFloat(($event.target as HTMLInputElement).value) || 0)" />
              </label>
              <button
                class="shrink-0 size-7 rounded flex items-center justify-center border border-[#2a2a2a] cursor-pointer transition-colors"
                :class="lockRatio ? 'text-yellow-400 bg-yellow-400/10 border-yellow-400/40' : 'text-white/40 hover:text-white/80'"
                :title="lockRatio ? 'Aspect ratio locked — click to unlock' : 'Aspect ratio unlocked — click to lock'"
                @click="lockRatio = !lockRatio"
              >
                <Lock v-if="lockRatio" class="size-3.5" />
                <LockOpen v-else class="size-3.5" />
              </button>
              <label class="flex-1 flex items-center gap-2 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5">
                <span class="text-xs text-white/40">H</span>
                <input v-scrubnum type="number" min="1" :value="pxW((selectedLocal as any).h)"
                  class="w-full bg-transparent text-xs text-white/90 outline-none"
                  @input="setDimPx(selectedLocal!, 'h', parseFloat(($event.target as HTMLInputElement).value) || 0)" />
              </label>
            </div>
          </div>
          <!-- Line: single length value -->
          <div v-else-if="selectedLocal.kind === 'line'">
            <div class="panel-label mb-1.5">Length</div>
            <input v-scrubnum type="number" min="1" :value="pxW((selectedLocal as any).w)"
              class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="setSizePx(selectedLocal!.id, 'w', parseFloat(($event.target as HTMLInputElement).value) || 1)" />
          </div>

          <!-- Common: rotation + opacity -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <div class="panel-label mb-1.5">Rotation</div>
              <input v-scrubnum type="number" step="1" :value="Math.round(selectedLocal.rotation)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setLocal(selectedLocal!.id, { rotation: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
            </div>
            <div v-if="!localDisplace(selectedLocal)">
              <div class="panel-label mb-1.5">Opacity</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(selectedLocal.opacity * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setLocal(selectedLocal!.id, { opacity: Math.max(0, Math.min(1, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
          </div>

          <!-- Distort: slant (affine) + perspective + free corner-pin (Distort tool) -->
          <div>
            <div class="panel-label mb-1.5">Distort</div>
            <div class="grid grid-cols-2 gap-3 mb-2">
              <div>
                <div class="flex items-center justify-between panel-sublabel mb-1"><span>Slant X</span><span class="tabular-nums normal-case">{{ Math.round((selectedLocal as any).skewX || 0) }}°</span></div>
                <input type="range" min="-60" max="60" step="1" :value="(selectedLocal as any).skewX || 0" class="w-full accent-white cursor-pointer"
                  @input="setLocal(selectedLocal!.id, { skewX: parseFloat(($event.target as HTMLInputElement).value) || 0 } as any)" />
              </div>
              <div>
                <div class="flex items-center justify-between panel-sublabel mb-1"><span>Slant Y</span><span class="tabular-nums normal-case">{{ Math.round((selectedLocal as any).skewY || 0) }}°</span></div>
                <input type="range" min="-60" max="60" step="1" :value="(selectedLocal as any).skewY || 0" class="w-full accent-white cursor-pointer"
                  @input="setLocal(selectedLocal!.id, { skewY: parseFloat(($event.target as HTMLInputElement).value) || 0 } as any)" />
              </div>
            </div>
            <div class="mb-2">
              <div class="flex items-center justify-between panel-sublabel mb-1"><span>Perspective</span><span class="tabular-nums normal-case">{{ Math.round(perspectiveAmount(selectedLocal) * 100) }}</span></div>
              <input type="range" min="-80" max="80" step="1" :value="Math.round(perspectiveAmount(selectedLocal) * 100)" class="w-full accent-white cursor-pointer"
                @input="setPerspective(selectedLocal!.id, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)" />
            </div>
            <div class="flex items-center gap-1.5">
              <button class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors" :class="distortTool ? 'bg-white text-neutral-900 font-medium' : 'bg-white/[0.05] text-white/70 hover:bg-white/10'" title="Drag the 4 corners on the canvas" @click="toggleDistort">Corner pin</button>
              <button class="h-7 px-2.5 rounded text-[11px] bg-white/[0.05] text-white/60 hover:bg-white/10 cursor-pointer" title="Reset slant + perspective" @click="resetDistort(selectedLocal!.id)">Reset</button>
            </div>
          </div>

          <!-- Blend mode (vs layers below; same modes as wired layers) -->
          <div v-if="!localDisplace(selectedLocal)">
            <div class="panel-label mb-1.5">Blend</div>
            <select :value="(selectedLocal as any).blend || 'normal'"
              class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
              @change="setLocal(selectedLocal!.id, { blend: ($event.target as HTMLSelectElement).value } as any)">
              <option v-for="m in LOCAL_BLEND_MODES" :key="m" :value="m">{{ m.replace('_', ' ') }}</option>
            </select>
          </div>

          <!-- Drop shadow effect -->
          <div class="mt-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="panel-label">Drop shadow</div>
              <button class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
                @click="toggleLocalShadow(selectedLocal!)">{{ localShadow(selectedLocal) ? 'Remove' : 'Add' }}</button>
            </div>
            <div v-if="localShadow(selectedLocal)" class="space-y-1.5">
              <div class="flex items-center gap-1.5">
                <input type="color" :value="shadowHex(selectedLocal)" title="Shadow color"
                  class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                  @input="setLocalShadow(selectedLocal!, { color: composeRgba(($event.target as HTMLInputElement).value, shadowAlpha(selectedLocal)) })" />
                <input type="text" spellcheck="false" maxlength="7" :value="shadowHex(selectedLocal)" title="Hex color"
                  class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                  @change="setShadowHex(selectedLocal!, ($event.target as HTMLInputElement).value)" />
                <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Shadow opacity (alpha)">
                  <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(shadowAlpha(selectedLocal) * 100)"
                    class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                    @input="setLocalShadow(selectedLocal!, { color: composeRgba(shadowHex(selectedLocal), (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                  <span class="text-[10px] text-white/35 select-none">%</span>
                </div>
              </div>
              <div class="grid grid-cols-3 gap-1.5">
                <div>
                  <div class="panel-sublabel mb-1">X</div>
                  <input v-scrubnum type="number" step="0.5" :value="Math.round((localShadow(selectedLocal)?.x || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setLocalShadow(selectedLocal!, { x: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
                </div>
                <div>
                  <div class="panel-sublabel mb-1">Y</div>
                  <input v-scrubnum type="number" step="0.5" :value="Math.round((localShadow(selectedLocal)?.y || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setLocalShadow(selectedLocal!, { y: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
                </div>
                <div>
                  <div class="panel-sublabel mb-1">Blur</div>
                  <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round((localShadow(selectedLocal)?.blur || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setLocalShadow(selectedLocal!, { blur: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                </div>
              </div>
            </div>
          </div>

          <!-- Inner shadow -->
          <div class="mt-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="panel-label">Inner shadow</div>
              <button class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
                @click="toggleInnerShadow(selectedLocal!)">{{ innerShadow(selectedLocal) ? 'Remove' : 'Add' }}</button>
            </div>
            <div v-if="innerShadow(selectedLocal)" class="space-y-1.5">
              <div class="flex items-center gap-1.5">
                <input type="color" :value="innerShadowHex(selectedLocal)" title="Shadow color"
                  class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                  @input="setInnerShadow(selectedLocal!, { color: composeRgba(($event.target as HTMLInputElement).value, innerShadowAlpha(selectedLocal)) })" />
                <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Shadow opacity (alpha)">
                  <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(innerShadowAlpha(selectedLocal) * 100)"
                    class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                    @input="setInnerShadow(selectedLocal!, { color: composeRgba(innerShadowHex(selectedLocal), (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                  <span class="text-[10px] text-white/35 select-none">%</span>
                </div>
              </div>
              <div class="grid grid-cols-3 gap-1.5">
                <div>
                  <div class="panel-sublabel mb-1">X</div>
                  <input v-scrubnum type="number" step="0.5" :value="Math.round((innerShadow(selectedLocal)?.x || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setInnerShadow(selectedLocal!, { x: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
                </div>
                <div>
                  <div class="panel-sublabel mb-1">Y</div>
                  <input v-scrubnum type="number" step="0.5" :value="Math.round((innerShadow(selectedLocal)?.y || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setInnerShadow(selectedLocal!, { y: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
                </div>
                <div>
                  <div class="panel-sublabel mb-1">Blur</div>
                  <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round((innerShadow(selectedLocal)?.blur || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setInnerShadow(selectedLocal!, { blur: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                </div>
              </div>
            </div>
          </div>

          <!-- Layer blur -->
          <div class="mt-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="panel-label">Layer blur</div>
              <button class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
                @click="toggleLayerBlur(selectedLocal!)">{{ layerBlur(selectedLocal) ? 'Remove' : 'Add' }}</button>
            </div>
            <div v-if="layerBlur(selectedLocal)" class="flex items-center gap-2">
              <div class="panel-sublabel shrink-0">Radius</div>
              <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round((layerBlur(selectedLocal)?.radius || 0) * 1000) / 10"
                class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setLayerBlur(selectedLocal!, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100))" />
            </div>
          </div>

          <!-- Background blur (blurs what's behind the layer, inside its shape) -->
          <div class="mt-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="panel-label">Background blur</div>
              <button class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
                @click="toggleBgBlur(selectedLocal!)">{{ bgBlur(selectedLocal) ? 'Remove' : 'Add' }}</button>
            </div>
            <div v-if="bgBlur(selectedLocal)" class="flex items-center gap-2">
              <div class="panel-sublabel shrink-0">Radius</div>
              <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round((bgBlur(selectedLocal)?.radius || 0) * 1000) / 10"
                class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="setBgBlur(selectedLocal!, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100))" />
            </div>
          </div>

          <!-- Displacement map: turn this image into a lens that warps everything below it -->
          <div v-if="selectedLocal?.kind === 'image'" class="mt-3">
            <div class="flex items-center justify-between">
              <div class="panel-label">Displacement map</div>
              <button type="button"
                class="text-xs px-2 py-1 rounded border border-white/[0.06] text-white/80 hover:bg-white/[0.06]"
                :class="localDisplace(selectedLocal) ? 'bg-[#2563eb]/30 text-white' : 'bg-white/[0.04]'"
                @click="toggleLocalDisplace(selectedLocal)">
                {{ localDisplace(selectedLocal) ? 'On' : 'Off' }}
              </button>
            </div>
            <div v-if="localDisplace(selectedLocal)" class="mt-2 flex flex-col gap-2">
              <div>
                <div class="panel-label mb-1.5">Read</div>
                <select :value="localDisplace(selectedLocal).read"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                  @change="setLocalDisplace(selectedLocal, { read: ($event.target as HTMLSelectElement).value })">
                  <option value="height">Height (brightness)</option>
                  <option value="channels">Channels (R→x, G→y)</option>
                  <option value="bulge">Bulge (white out / black in)</option>
                </select>
              </div>
              <div>
                <div class="panel-label mb-1.5">Amount</div>
                <input v-scrubnum type="number" min="0" max="200" step="1" :value="localDisplace(selectedLocal).amount"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setLocalDisplace(selectedLocal, { amount: Math.max(0, Math.min(200, parseFloat(($event.target as HTMLInputElement).value) || 0)) })" />
              </div>
              <div>
                <div class="panel-label mb-1.5">Softness</div>
                <input v-scrubnum type="number" min="0" max="20" step="1" :value="localDisplace(selectedLocal).softness ?? 0"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="setLocalDisplace(selectedLocal, { softness: Math.max(0, Math.min(20, parseFloat(($event.target as HTMLInputElement).value) || 0)) })" />
              </div>
              <label v-if="localDisplace(selectedLocal).read === 'height' || localDisplace(selectedLocal).read === 'bulge'" class="flex items-center gap-2 text-xs text-white/80">
                <input type="checkbox" :checked="!!localDisplace(selectedLocal).invert"
                  @change="setLocalDisplace(selectedLocal, { invert: ($event.target as HTMLInputElement).checked })" />
                Invert
              </label>
            </div>
          </div>

          <!-- Post-processing (adjust / bloom / grain / vignette / duotone / dof).
               Both the 2D chain and the GPU stage are edited here, so the filter has to
               admit both — passing only isChainEffect would silently drop dof. -->
          <PostEffectsControls class="mt-3"
            :effects="(((selectedLocal as any).effects || []).filter(isPanelEffect) as any)"
            :depth-source="localDepthSource(selectedLocal)"
            @update="(fx: any[]) => setLocal(selectedLocal!.id, { effects: [...((selectedLocal as any).effects || []).filter((e: any) => !isPanelEffect(e)), ...fx] } as any)" />

          <!-- Layer mask: clip this layer to another layer's silhouette (cross-source) -->
          <div class="mt-3">
            <div class="panel-label mb-1.5">Mask</div>
            <select :value="currentMaskRef(localKey(selectedLocal!.id))"
              class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @change="setMaskRef(localKey(selectedLocal!.id), ($event.target as HTMLSelectElement).value)">
              <option value="">No mask</option>
              <option v-for="o in maskCandidates(localKey(selectedLocal!.id))" :key="o.key" :value="o.key">Mask with {{ o.label }}</option>
            </select>
            <label v-if="currentMaskRef(localKey(selectedLocal!.id))" class="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
              <input type="checkbox" :checked="maskShowSource(localKey(selectedLocal!.id))"
                @change="setMaskShowSource(localKey(selectedLocal!.id), ($event.target as HTMLInputElement).checked)" />
              Show mask layer
            </label>
            <div v-if="maskIsLocalShape()" class="mt-2">
              <label class="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
                <input type="checkbox" :checked="!!selectedBreak()" @change="setBreakEnabled(($event.target as HTMLInputElement).checked)" />
                Break out
              </label>
              <div v-if="selectedBreak()" class="mt-1.5 space-y-1.5">
                <StudioSegmented :options="['top','bottom','left','right']" :model-value="breakEdge()"
                  @update:model-value="(e: string) => setBreakEdge(e as any)" />
                <div>
                  <div class="panel-sublabel mb-1">Offset</div>
                  <input type="range" min="0" max="1" step="0.01" :value="breakOffset()"
                    class="w-full accent-white cursor-pointer"
                    @input="setBreakOffset(parseFloat(($event.target as HTMLInputElement).value) || 0)" />
                </div>
              </div>
            </div>
          </div>

          <!-- Crop to a rect/ellipse region -->
          <div class="mt-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="panel-label">Crop</div>
              <button class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
                @click="toggleLayerMask(selectedLocal!)">{{ layerMask(selectedLocal) ? 'Remove' : 'Add' }}</button>
            </div>
            <div v-if="layerMask(selectedLocal)" class="space-y-1.5">
              <div class="flex gap-1">
                <button class="flex-1 py-1 rounded text-[11px] border"
                  :class="layerMask(selectedLocal)?.kind === 'rect' ? 'bg-white/10 border-white/20 text-white/90' : 'border-[#2a2a2a] text-white/50 hover:text-white/80'"
                  @click="setLayerMask(selectedLocal!, { kind: 'rect' })">Rect</button>
                <button class="flex-1 py-1 rounded text-[11px] border"
                  :class="layerMask(selectedLocal)?.kind === 'ellipse' ? 'bg-white/10 border-white/20 text-white/90' : 'border-[#2a2a2a] text-white/50 hover:text-white/80'"
                  @click="setLayerMask(selectedLocal!, { kind: 'ellipse' })">Ellipse</button>
              </div>
              <div class="grid grid-cols-4 gap-1.5">
                <div v-for="k in (['x','y','w','h'] as const)" :key="k">
                  <div class="panel-sublabel mb-1">{{ k }}</div>
                  <input v-scrubnum type="number" step="0.5" :value="Math.round((layerMask(selectedLocal)?.[k] || 0) * 1000) / 10"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                    @input="setLayerMask(selectedLocal!, { [k]: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                </div>
              </div>
            </div>
          </div>

          <!-- Torn paper edge: raggedy, grain-dissolved silhouette boundary -->
          <div class="mt-3">
            <CompositorTornEdgePanel
              :value="(selectedLocal as any).tornEdge"
              @update="(patch) => setTornEdge(selectedLocal!, patch)"
              @toggle="(on) => toggleTornEdge(selectedLocal!, on)"
            />
            <CompositorFeatherPanel
              :value="(selectedLocal as any).feather"
              @update="(patch) => setFeather(selectedLocal!, patch)"
              @toggle="(on) => toggleFeather(selectedLocal!, on)"
            />
          </div>

          <!-- Cloner: repeat this layer (linear/grid/radial) with falloff -->
          <CompositorClonerPanel
            class="mt-1"
            :cloner="(selectedLocal as any).cloner"
            @update="(cl) => setLocal(selectedLocal!.id, { cloner: cl } as any)"
          />

          <!-- Image AI actions -->
          <div v-if="selectedLocal.kind === 'image'" class="mt-3 flex flex-col gap-1.5">
            <button
              class="w-full py-1.5 rounded text-[11px] font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              :class="genActive ? 'bg-white text-neutral-900' : 'bg-white/[0.06] hover:bg-white/12 text-white/85'"
              @click="enterGenMode"
            ><Wand2 class="size-3" /> Generate in region…</button>
            <button
              class="w-full py-1.5 rounded text-[11px] font-medium flex items-center justify-center gap-1.5 cursor-pointer bg-white/[0.06] hover:bg-white/12 text-white/85 disabled:opacity-40 disabled:cursor-default"
              :disabled="layerEdit.busy.value"
              title="Cloud background removal — replaces the image with a transparent cutout, in place"
              @click="removeImageBg(selectedLocal)"
            ><PhCheckerboard class="size-3" /> {{ layerEdit.busy.value ? 'Working…' : 'Cut out subject' }}</button>
            <button
              class="w-full py-1.5 rounded text-[11px] font-medium flex items-center justify-center gap-1.5 cursor-pointer bg-white/[0.06] hover:bg-white/12 text-white/85 disabled:opacity-40 disabled:cursor-default"
              :disabled="layerEdit.busy.value"
              title="Relight + color-match this layer to the scene around it, in place"
              @click="layerEdit.harmonizeLayer(selectedLocal as any, setLocal, renderSceneForHarmonize)"
            ><Wand2 class="size-3" /> {{ layerEdit.busy.value ? 'Working…' : 'Harmonize into scene' }}</button>
            <div v-if="layerEdit.error.value" class="text-[10px] text-rose-400">{{ layerEdit.error.value }}</div>
          </div>
        </div>
      </template>

      <!-- Frame properties — shown when nothing is selected. A wired slot is a
           layer now, so it uses the SAME layer inspector above; the parallel
           "image-layer properties" panel it used to get is gone. -->
      <template v-else>
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <ImageIcon class="size-3.5 text-white/60" />
          <span class="text-sm font-medium">No selection</span>
        </div>
        <!-- Scrolls like every layer-selected panel does — without this, the frame
             properties (Background → Post-processing → Grid → Deal grid → templates)
             overflow the window and the lower controls become unreachable. -->
        <div class="p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
          <!-- Canvas background fill (bottom-most; baked into the frame) -->
          <div>
            <div class="panel-label mb-1.5">Background</div>
            <FillControl allow-none :model-value="background"
              @update:model-value="(v: any) => setBackground(v)" />
            <p class="mt-1.5 text-[10px] text-white/30 leading-snug">Fills behind every layer and bakes into the frame. An opaque generated image will sit on top of it.</p>
          </div>
          <!-- Whole-frame post-processing (after all layers composite) -->
          <div class="border-t border-white/[0.06] pt-3">
            <div class="panel-label mb-1.5">Post-processing</div>
            <p class="text-[10px] text-white/30 leading-snug mb-2">Grades the whole frame after all layers composite — bakes into renders, exports and motion stills.</p>
            <PostEffectsControls :effects="postEffects" @update="(fx: any[]) => setPostEffects(fx as any)" />
          </div>
          <!-- Grid — a layout guide (explicit or seeded-generated) that snaps
               drag/resize and, optionally, draws an editor-only overlay. Never
               baked into the render (see the comment above `gridConfig`). -->
          <div class="border-t border-white/[0.06] pt-3">
            <div class="panel-label mb-1.5">Grid</div>
            <StudioSegmented :options="['off', 'explicit', 'generated']" :model-value="gridConfig.mode"
              @update:model-value="(v: any) => patchGrid({ mode: v })" />

            <template v-if="gridConfig.mode === 'explicit'">
              <div class="mt-2 flex flex-col gap-1.5">
                <StudioSlider label="Columns" :min="1" :max="24" :step="1" :bindable="false"
                  :model-value="gridConfig.columns" @update:model-value="(v: number) => patchGrid({ columns: v })" />
                <StudioSlider label="Rows" :min="1" :max="24" :step="1" :bindable="false"
                  :model-value="gridConfig.rows" @update:model-value="(v: number) => patchGrid({ rows: v })" />
                <StudioSlider label="Gutter" :min="0" :max="0.1" :step="0.002" :bindable="false"
                  :model-value="gridConfig.gutter" @update:model-value="(v: number) => patchGrid({ gutter: v })" />
                <StudioSlider label="Margin" :min="0" :max="0.2" :step="0.002" :bindable="false"
                  :model-value="gridConfig.margin" @update:model-value="(v: number) => patchGrid({ margin: v })" />
              </div>
            </template>

            <template v-else-if="gridConfig.mode === 'generated'">
              <div class="mt-2 flex flex-col gap-1.5">
                <div class="grid grid-cols-2 gap-1.5">
                  <StudioSlider label="Cols min" :min="1" :max="24" :step="1" :bindable="false"
                    :model-value="gridConfig.gen.colRange[0]"
                    @update:model-value="(v: number) => patchGen({ colRange: [v, Math.max(v, gridConfig.gen.colRange[1])] })" />
                  <StudioSlider label="Cols max" :min="1" :max="24" :step="1" :bindable="false"
                    :model-value="gridConfig.gen.colRange[1]"
                    @update:model-value="(v: number) => patchGen({ colRange: [Math.min(gridConfig.gen.colRange[0], v), v] })" />
                </div>
                <div class="grid grid-cols-2 gap-1.5">
                  <StudioSlider label="Rows min" :min="1" :max="24" :step="1" :bindable="false"
                    :model-value="gridConfig.gen.rowRange[0]"
                    @update:model-value="(v: number) => patchGen({ rowRange: [v, Math.max(v, gridConfig.gen.rowRange[1])] })" />
                  <StudioSlider label="Rows max" :min="1" :max="24" :step="1" :bindable="false"
                    :model-value="gridConfig.gen.rowRange[1]"
                    @update:model-value="(v: number) => patchGen({ rowRange: [Math.min(gridConfig.gen.rowRange[0], v), v] })" />
                </div>
                <StudioSlider label="Regularity" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="gridConfig.gen.regularity" @update:model-value="(v: number) => patchGen({ regularity: v })" />
                <StudioSwitch label="Merge cells" :model-value="gridConfig.gen.merge"
                  @update:model-value="(v: boolean) => patchGen({ merge: v })" />
                <StudioSlider v-if="gridConfig.gen.merge" label="Max span" :min="1" :max="8" :step="1" :bindable="false"
                  :model-value="gridConfig.gen.mergeMaxSpan" @update:model-value="(v: number) => patchGen({ mergeMaxSpan: v })" />
                <div class="panel-label mt-1 mb-1">Symmetry</div>
                <StudioSegmented :options="['none', 'mirror']" :model-value="gridConfig.gen.symmetry"
                  @update:model-value="(v: any) => patchGen({ symmetry: v })" />
                <div class="mt-1 flex items-center gap-2">
                  <StudioButton variant="secondary" @click="patchGen({ seed: Math.floor(Math.random() * 9999) + 1 })">New variation</StudioButton>
                  <div class="min-w-0 flex-1">
                    <StudioSlider label="Seed" :min="1" :max="9999" :step="1" :default="42" :bindable="false"
                      :model-value="gridConfig.gen.seed" @update:model-value="(v: number) => patchGen({ seed: v })" />
                  </div>
                </div>
              </div>
            </template>

            <div v-if="gridConfig.mode !== 'off'" class="mt-2 flex flex-col gap-1.5">
              <StudioSwitch label="Show overlay" :model-value="gridConfig.overlay"
                @update:model-value="(v: boolean) => patchGrid({ overlay: v })" />
              <StudioSwitch label="Draw section" hint="Drag on the artboard to stamp a rect snapped to the grid"
                :model-value="drawSectionActive" @update:model-value="(v: boolean) => setDrawSectionActive(v)" />
              <StudioButton variant="secondary" @click="onFillGridWithSections">Fill grid with sections</StudioButton>
              <StudioButton variant="secondary" @click="onDealGrid">Deal grid</StudioButton>
              <p class="text-[10px] text-white/30 leading-snug">Deal fills every cell of a dense grid from a palette — one self-painting layer that bakes.</p>
              <div class="panel-label mt-1 mb-1">Generators</div>
              <div class="flex flex-wrap gap-1.5">
                <StudioButton variant="secondary" title="Pane — rows of flush panes, each a two-colour ramp running corner to corner or edge to edge"
                  @click="onPane()">Pane</StudioButton>
                <StudioButton variant="secondary" title="Modular — a merged module grid over a background: empty, solid, block fields, dot clusters, line grids and ramps, with hairlines"
                  @click="onModular()">Modular</StudioButton>
                <StudioButton variant="secondary" title="Parcel — a coarse two-tone field of chunky ink blocks on a ground, with ragged hairline survey grids floating on top"
                  @click="onParcel()">Parcel</StudioButton>
                <StudioButton variant="secondary" title="Mosh — a corrupted signal: stacked bands of glitch, each a different failure, in hard full-strength inks with dead dark patches"
                  @click="onMosh()">Mosh</StudioButton>
              </div>
            </div>
          </div>
          <!-- Expressive arrange (a whole group is selected) -->
          <div v-if="soleSelectedGroup" class="border-t border-white/[0.06] pt-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="panel-label">Expressive arrange</div>
              <button
                class="text-[10px] px-1.5 py-0.5 rounded border"
                :class="soleSelectedGroupExpr ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                @click="toggleGroupExpressive(soleSelectedGroup, !soleSelectedGroupExpr)">
                {{ soleSelectedGroupExpr ? 'On' : 'Off' }}
              </button>
            </div>
            <p class="text-[10px] text-white/30 leading-snug mb-2">Scatter this group's items within their current bounds. Reroll for a new arrangement.</p>
            <div v-if="soleSelectedGroupExpr" class="space-y-2.5">
              <div>
                <div class="panel-label mb-1">Placement</div>
                <div class="grid grid-cols-2 gap-1">
                  <button v-for="p in (['scatter', 'grid', 'pile', 'corners'] as const)" :key="p"
                    class="bg-white/[0.04] border border-white/[0.06] rounded py-1 text-[11px]"
                    :class="soleSelectedGroupExpr.placement === p ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setGroupExpressive(soleSelectedGroup!, { placement: p })">{{ p }}</button>
                </div>
              </div>
              <div>
                <div class="panel-label mb-1">Jitter · {{ Math.round(soleSelectedGroupExpr.jitter * 100) }}%</div>
                <input type="range" min="0" max="1" step="0.05" :value="soleSelectedGroupExpr.jitter" class="w-full"
                  @input="setGroupExpressive(soleSelectedGroup!, { jitter: parseFloat(($event.target as HTMLInputElement).value) })">
              </div>
              <div>
                <div class="panel-label mb-1">Rotation · {{ Math.round(soleSelectedGroupExpr.rotation * 100) }}%</div>
                <input type="range" min="0" max="1" step="0.05" :value="soleSelectedGroupExpr.rotation" class="w-full"
                  @input="setGroupExpressive(soleSelectedGroup!, { rotation: parseFloat(($event.target as HTMLInputElement).value) })">
              </div>
              <div>
                <div class="panel-label mb-1">Justify (spread to edges)</div>
                <div class="flex gap-1">
                  <button class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded py-1 text-[11px]"
                    :class="soleSelectedGroupExpr.justifyX ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setGroupExpressive(soleSelectedGroup!, { justifyX: !soleSelectedGroupExpr.justifyX })">Horizontal</button>
                  <button class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded py-1 text-[11px]"
                    :class="soleSelectedGroupExpr.justifyY ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setGroupExpressive(soleSelectedGroup!, { justifyY: !soleSelectedGroupExpr.justifyY })">Vertical</button>
                </div>
              </div>
              <button
                class="w-full flex items-center justify-center gap-1.5 bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-xs text-white/80 hover:text-white"
                @click="rerollGroupExpressive(soleSelectedGroup!)">
                <RefreshCw class="size-3.5" /> Re-render
              </button>
            </div>
          </div>
          <p v-else class="text-xs text-white/40 italic">
            Select a layer to edit its properties, or use the toolbar to add text and shapes.
          </p>
        </div>
      </template>

      <!-- Sticky footer: Generate as image / Generate as video — renders & records
           artifacts (mirrors the Gradient/Shader/Space Type studio idiom). Sits
           outside every template branch so it stays pinned bottom-right in all
           panel states. -->
      <div class="mt-auto shrink-0 border-t border-white/10 p-3 flex items-center justify-end gap-2">
        <span v-if="renderError" class="text-[11px] text-rose-400 min-w-0 flex-1 truncate" :title="renderError">{{ renderError }}</span>
        <button
          class="h-8 px-3 rounded text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-white/[0.06] hover:bg-white/12 text-white/85"
          :disabled="rendering || baking || encoding || !hasMotion"
          :title="hasMotion ? 'Bake the motion timeline and generate a video artifact' : 'Add motion to a layer (Motion tab) or wire an animated studio'"
          @click="generateVideo">
          {{ baking ? `Baking ${Math.round((bakeProgress ?? 0) * 100)}%` : encoding ? 'Encoding…' : 'Generate as video' }}
        </button>
        <button
          class="h-8 px-3 rounded text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-white hover:bg-white/90 text-neutral-900"
          :disabled="rendering || baking || encoding"
          title="Render the frame and generate an image artifact"
          @click="generateImage">
          <Play class="size-3" />
          {{ rendering ? 'Rendering…' : 'Generate as image' }}
        </button>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
/* Glassy section cards in the inspector — each top-level control group becomes a
   bordered translucent card (the studios' panel look) without restructuring the
   template. Direct children only, so nested grids/rows are unaffected. */
/* Glassy floating panels (left layers list + right inspector) — a soft diagonal
   sheen layered over the translucent fill (separate background-image, so the
   bg-[#0e0e10]/80 fill is preserved). */
.glass-panel {
  background-image: linear-gradient(140deg, rgba(255, 255, 255, 0.055) 0%, rgba(255, 255, 255, 0.008) 42%, rgba(255, 255, 255, 0.035) 100%);
}

.inspector-body > div {
  border-radius: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.09);
  /* A diagonal sheen layered over a faint fill = the studios' glassy card. The
     gradient is part of the background so it sits behind the controls. */
  background:
    linear-gradient(125deg, rgba(255, 255, 255, 0.07) 0%, rgba(255, 255, 255, 0.018) 45%, rgba(255, 255, 255, 0.05) 100%),
    rgba(255, 255, 255, 0.025);
  padding: 0.75rem;
}

/* Strip the native number-input spinner arrows in the inspector. */
input[type="number"]::-webkit-inner-spin-button,
input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield;
}

/* Dynamically-updating values shouldn't jitter the field width as digits change. */
input[type="number"],
input[type="text"] {
  font-variant-numeric: tabular-nums;
}

/* Subtle tactile press feedback. Transform-only so it never overrides the
   colour transitions on the segmented/tool buttons. */
button {
  transition: transform 0.12s ease;
}
button:active:not(:disabled) {
  transform: scale(0.96);
}

/* The Generate-in-region button uses the shared `.gen-pastel` utility and the
   prompt hairline the shared `.pastel-hairline` utility — both in
   app/assets/css/main.css — so the canvas-node Inpaint modal stays cohesive.
   Interior bg is set inline via --pastel-hairline-bg on the textarea. */
</style>
