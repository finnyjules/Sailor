<script setup lang="ts">
import { clipClocks } from '~/composables/useCompositorLayers'
import { hasPaint } from '~/lib/paint/resolve'
import {
  Image as ImageIcon, X, MousePointer2,
  Type, Square, Circle, Minus, Plus, Trash2,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Bold, ArrowUp, ArrowDown, Lock, LockOpen,
  Eye, EyeOff, Underline, Strikethrough, CaseUpper, CaseLower, CaseSensitive,
  Hexagon, Star, Copy, Shapes,
} from 'lucide-vue-next'
import {
  type TextLayer, type RectLayer, type EllipseLayer, type LocalLayer, type StackItem, type CornerPin, type BrushLayer, type Paint,
  type WiredLayer, type DealLayer, type ScatterLayer,
  cornerRadii, drawLocalLayer, drawWiredImageLayer, ensureLayerFonts, ensureLayerImages, paintLayerStack, layerMaskRef, localLayerBox, createBrushLayer, newMosaicLayer,
  newScatterLayer,
  hasAnimatedShaderFill, withWiredContent, _registerWiredContent, renderLayerThumbnail,
  outlinePathData, canTakeGeometry, canWarpRaster, cornerPinActive,
  applyShaderPixelEffect, shaderSpecFromEffect, type ShaderPixelEffect,
} from '~/composables/useCompositorLayers'
import { onPaperBooleanReady, warmPaperBoolean } from '~/lib/compositor/booleanGeometry'
import { DEAL_VOCABS, dealVocabDrivesLook, type DealVocab } from '~/lib/compositor/dealVocab'
import { MOSAIC_STYLE_LABELS, cellFillOfLabel, mosaicLabelOf, mosaicStylePatch, mosaicSeedPatch, freshMosaicSeed, isMosaicShaderFill, mosaicShaderSpec, mosaicLookNames, mosaicLookOf, applyMosaicLook } from '~/lib/compositor/mosaic'
import ShaderFillEditor from '~/components/vue-canvas/widgets/ShaderFillEditor.vue'
import { onFieldCatalogReady, retryFieldCatalog, renderFieldWithBase } from '~/lib/shaderfill/field'
import { onCompositorFontReady } from '~/lib/compositor/textOutline'
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN, withTake, withTakeSpeed, type ImageClip } from '~/lib/compositor/clip'
import { defaultPane, PANE_LIMITS, PANE_PRESET_NAMES, panePresetPatch, panePresetOf, panePalette, paneInkPatch, type PaneParams, type PanePresetName } from '~/lib/compositor/pane'
import { defaultModular, MODULAR_LIMITS, MODULAR_PRESET_NAMES, modularPresetPatch, modularPresetOf, type ModularParams, type ModularPresetName, type ModularType } from '~/lib/compositor/modular'
import { defaultParcel, PARCEL_LIMITS, PARCEL_PRESET_NAMES, parcelPresetPatch, parcelPresetOf, type ParcelParams, type ParcelPresetName } from '~/lib/compositor/parcel'
import { defaultMosh, MOSH_LIMITS, MOSH_PRESET_NAMES, moshPresetPatch, moshPresetOf, type MoshParams, type MoshPresetName } from '~/lib/compositor/mosh'
import { defaultCarve, CARVE_LIMITS, CARVE_PRESET_NAMES, carvePresetPatch, carvePresetOf, type CarveParams, type CarvePresetName } from '~/lib/compositor/carve'
import { defaultTotem, normalizeTotem, TOTEM_LIMITS, TOTEM_PRESET_NAMES, totemPresetPatch, totemPresetOf, totemInkPatch, type TotemParams, type TotemPresetName } from '~/lib/compositor/totem'
import { defaultBlueprint, normalizeBlueprint, BLUEPRINT_LIMITS, BLUEPRINT_CORNERS, BLUEPRINT_DASH, BLUEPRINT_PRESET_NAMES, blueprintPresetPatch, blueprintPresetOf, type BlueprintParams, type BlueprintPresetName } from '~/lib/compositor/blueprint'
import {
  SCATTER_STYLE_LABELS, scatterStyleRow, scatterLabelOf, scatterStyleOfLabel, scatterParams,
  scatterStylePatch, scatterSeedPatch, freshScatterSeed, DEFAULT_SCATTER_SEED,
  type ScatterControl, type ScatterSelectControl,
} from '~/lib/compositor/scatter'
import { migrateFrameToUnifiedLayers } from '~/lib/compositor/wiredMigration'
import { framePresentKeys, finalizeWiredSentinels, reconcileWiredContent, syncWiredLayerLinks, wiredReconcileKey, legacyWiredFlagsActive, isWiredSentinel } from '~/lib/compositor/frameStack'
import { createWiredMaskCache } from '~/lib/compositor/wiredMaskCache'
import { readWiredTreatments, setWiredMask, setWiredMaskShowSource, setWiredMaskUrl, maskCandidateKeys } from '~/composables/useWiredTreatments'
import { maskBreakFromEdge, type MaskBreak, type MaskBreakEdge } from '~/lib/compositor/maskBreak'
import { useLocalLayerEditor, resizableKind, cornerResizableKind, textBoxResizable } from '~/composables/useLocalLayerEditor'
import { useLayoutSheet } from '~/composables/useLayoutSheet'
import LayoutTile from '~/components/vue-canvas/compositor/LayoutTile.vue'
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
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import { useVectorNodeEdit } from '~/composables/useVectorNodeEdit'
import { imageLayerUrl } from '~/composables/useCompositorLayers'
import { useInpaint, loadImage, capDims, imageToDataUrl, cleanCutoutAlpha } from '~/composables/useInpaint'
import { useLayerImageEdit } from '~/composables/useLayerImageEdit'
import { WHOLE_IMAGE_MODELS, REGION_MODELS } from '~/lib/compositor/imageEditModels'
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
import { effectDialTargets, addDialTrack, removeDialTrack, animatedDialKeysOf, type EffectDialTrack, type DialTargetSpec } from '~/lib/motion/effectTracks'
import { compileBehaviourForLayer, animatableProperties } from '~/lib/motionx/adapter/frame'
import { type Behaviour, type StoredBehaviour, type Timing, type Track as MotionxTrack } from '~/lib/motionx'
import { setBehaviourTracks, bakeBehaviour, upsertBehaviour, removeBehaviour } from '~/lib/motionx/behaviourStore'
import { seedHoldTrack, setBandTrack } from '~/lib/motionx/bandEdit'
import type { AnimatableProperty } from '~/lib/motionx/adapter/frame'
import MotionPropertyPicker from '~/components/vue-canvas/compositor/MotionPropertyPicker.vue'
import { fillDialTargets } from '~/lib/motion/fillTracks'
import { getByIdPath } from '~/lib/studio/idPath'
import { paintStopsToColor } from '~/lib/compositor/gradientPaint'
import { isGradient } from '~/lib/compositor/paint'
import { LIVE_FIELD_CEILING } from '~/lib/shaderfill/descriptor'
// F5 Task 3: the shader-catalog-as-a-pass effect inspector — reuses the app's canonical
// CatalogModal (the same picker ShaderFillEditor.vue mounts for a shader FILL) and the shared
// buildShaderParamRows/derivedShaderFillControls dial walk, filtered to input-sampling effects
// only (effectReadsInput) since a PASS over the layer's own pixels has no separate Input paint
// to fall back to if the picked effect is purely generative.
import CatalogModal from '~/components/CatalogModal.vue'
import { fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import { effectReadsInput } from '~/lib/shaderfx/catalogStore'
import type { EffectDef, ParamValue, ShaderFxCatalog } from '~/lib/shaderfx/types'
import { cleanStops } from '~/lib/shaderfx/params'
import { buildShaderParamRows, type ShaderParamRow } from '~/lib/shaderfill/controls'
import '~/lib/motion/paint' // registers the motion painter for paintLayerStack(t)
import { bakeAndUpload, motionSourceKey, type MotionParams } from '~/lib/motion/bake'
import { readGrid } from '~/lib/frame/gridConfig'
import { resolveGrid, type FrameGrid } from '~/lib/frame/grid'
import CompositorMotionTimeline from '~/components/vue-canvas/compositor/CompositorMotionTimeline.vue'
import MotionBandTimeline from '~/components/vue-canvas/compositor/MotionBandTimeline.vue'
import MotionGallery from '~/components/vue-canvas/compositor/MotionGallery.vue'
import MotionInspector from '~/components/vue-canvas/compositor/MotionInspector.vue'
import { behavioursForMove, defaultDurationFor, type GalleryMove } from '~/lib/motionx/gallery'
import MotionLayerEditor from '~/components/vue-canvas/compositor/MotionLayerEditor.vue'
import AddImageSourcePopover from '~/components/vue-canvas/compositor/AddImageSourcePopover.vue'
import CompositorClonerPanel from '~/components/vue-canvas/compositor/CompositorClonerPanel.vue'
import CompositorAnimatePanel from '~/components/vue-canvas/compositor/CompositorAnimatePanel.vue'
import { useLayerAnimate } from '~/composables/useLayerAnimate'
import CompositorTornEdgePanel from '~/components/vue-canvas/compositor/CompositorTornEdgePanel.vue'
import CompositorFeatherPanel from '~/components/vue-canvas/compositor/CompositorFeatherPanel.vue'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import StrokeStyleRow from '~/components/vue-canvas/compositor/StrokeStyleRow.vue'
import FillSwatch from '~/components/vue-canvas/compositor/FillSwatch.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import type { PaletteFamily } from '~/lib/color/seedFamily'
import type { GradientStop } from '~/lib/color/harmony'
import { layerPaletteAssignments } from '~/lib/compositor/distribute'
import ColourSlots from '~/components/vue-canvas/compositor/ColourSlots.vue'
import { colourSites } from '~/lib/compositor/recolour/sites'
import { slotsOf, inkOf } from '~/lib/compositor/recolour/slots'
import { mapFamily } from '~/lib/compositor/recolour/map'
import { recolourFrame, recolourSlot } from '~/lib/compositor/recolour/apply'
import { applyImageMaps, removeImageMaps } from '~/lib/compositor/recolour/imageMap'
import type { OwnedMaps } from '~/lib/compositor/recolour/imageMap'
import PostEffectsControls, { PANEL_EFFECT_KINDS } from '~/components/vue-canvas/PostEffectsControls.vue'
import CompositorEffectRow from '~/components/vue-canvas/compositor/CompositorEffectRow.vue'
import CompositorStrokeRow from '~/components/vue-canvas/compositor/CompositorStrokeRow.vue'
import ShapeStrokeRow from '~/components/vue-canvas/compositor/ShapeStrokeRow.vue'
import {
  EFFECT_ORDER, EFFECT_LABELS, isPinnedKind, isGeometryKind, effectStackOf, writeStackToLayer,
  addEffect, removeEffect, duplicateEffect, reorderEffect, canReorder,
  type EffectInstance, type EffectKind,
} from '~/lib/compositor/effectStack'
import { OVERLAY_BLENDS, STROKE_ALPHA_ALIGNS } from '~/lib/compositor/postEffects'
import {
  strokeStackOf, writeStrokeStackToLayer, addStroke, removeStroke, duplicateStroke,
  reorderStroke, canReorderStroke, strokeSupportsStack, strokeSupportsShapes, strokeRowLabel,
  layerStoresStrokeStack, LEGACY_STROKE_ID,
  type StrokeInstance,
} from '~/lib/compositor/strokeStack'
import {
  strokeInspectorRows, strokeStylePatch, strokeWobblePatch, strokeDistanceOf, strokeStyleOf,
  showsTextDistantNote, TEXT_DISTANT_STROKE_NOTE,
  type StrokeWobbleChoice,
} from '~/lib/compositor/strokeInspector'
import { encodeFrames } from '~/lib/engine/encodeVideo'
import {
  samplePointsFromStroke, layerAffine, invertAffine, applyAffine, wiredImageAffine,
  luminanceToAlpha, alphaBounds, cutoutPlacement, wiredCutoutPlacement,
  type Affine, type BBox, type Pt, type SamPoint,
} from '~/lib/compositor/smartSelect'
import { toast } from 'vue-sonner'
import { paintPrimaryColor } from '~/lib/spacetype/fillTile'
import FontPicker from '~/components/vue-canvas/widgets/FontPicker.vue'
import { VARIABLE_FONTS } from '~/data/variable-fonts'
import type { GoogleFont } from '~/data/google-fonts'
import { libraryFamily } from '~/data/library-fonts'
import { defaultExpressiveParams, type ExpressiveParams } from '~~/shared/text-layout/expressive'
import { PenTool, Brush, Sparkles, Wand2, Lasso, Undo2, Redo2, ChevronRight, ChevronDown, ChevronUp, GripVertical, Play, Palette, Check, RefreshCw, ImagePlus, FileUp, LayoutGrid, LayoutTemplate, Snowflake, Wheat, SquareDashedMousePointer } from 'lucide-vue-next'
import {
  TOOLBAR_SHAPES, TOOLBAR_INSERT,
  DEFAULT_SHAPE_FACE, DEFAULT_INSERT_FACE,
  resolveShapeFace, shapeFaceLabel,
  resolveInsertFace, insertFaceLabel,
  type ToolbarShapeId, type ToolbarInsertId,
} from '~/lib/compositor/toolbarMenus'
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import CanvasContextMenu, { type MenuItem } from '~/components/vue-canvas/CanvasContextMenu.vue'
import type { TextPathSpec, TextPathFollow } from '~/lib/compositor/textPath'
import { genGestureDefaults, genBoxIsValid, genBarPlacement } from '~/lib/compositor/genGesture'
import { shapeById, SHAPE_NONE, SHAPE_FAMILIES } from '~/lib/shapes/catalog'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { posterLayerViews } from '~/lib/frame/patterns/frameContext'
import { suggestTextFace } from '~/lib/frame/patterns/pairings'
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
const layerAnimate = useLayerAnimate()
async function animateLayer(layer: any, opts: { prompt: string; model: string; seconds: number }) {
  if (!layer || layer.kind !== 'image' || layerAnimate.busy.value) return
  try {
    const clip = await layerAnimate.animate(layer, opts)
    // Keep every generation: a re-roll appends a take instead of orphaning the last one.
    setLocal(layer.id, { clip, takes: withTake(layer.takes, clip) } as any)
    await ensureLayerImages(localLayers.value as LocalLayer[])
    renderStack()
  } catch { /* error text is on layerAnimate.error; the layer is untouched */ }
}
function setClipSpeed(layer: any, speed: number) {
  if (!layer?.clip) return
  // Clamp to the SAME constants the Speed slider's min/max come from (lib/compositor/clip)
  // — the literals that used to sit here were a second copy of the range, free to drift
  // away from the control that feeds it. The matching take remembers the speed too.
  const s = Math.max(CLIP_SPEED_MIN, Math.min(CLIP_SPEED_MAX, speed))
  setLocal(layer.id, { clip: { ...layer.clip, speed: s }, takes: withTakeSpeed(layer.takes, layer.clip.dir, s) } as any)
}
/** Remove clip keeps the takes — the still shows, and any take can be brought back. */
function removeClip(layer: any) { if (layer?.clip) setLocal(layer.id, { clip: undefined } as any) }
async function restoreTake(layer: any, take: ImageClip) {
  if (!layer || layer.kind !== 'image') return
  setLocal(layer.id, { clip: { ...take } } as any)
  await ensureLayerImages(localLayers.value as LocalLayer[])
  renderStack()
}
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
  selectedIds, selectedLayers, toggleSelect, applyBoolean, alignSelected, alignToFrame, recordHistory, commit, handleEditorKey, pasteClipboard,
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

// Layout tab — the poster engine's sheet over this frame's own elements.
const layoutSheet = useLayoutSheet({
  props: () => compositor.value?.data?.properties as Record<string, unknown> | undefined,
  frameW: () => canvasDisplay.w,
  frameH: () => canvasDisplay.h,
  connectedSlots: () => connectedSlots0.value,
  editor: () => editor,
  remember: (s) => { const n = compositor.value; if (!n) return; const p = (n.data.properties ||= {}); (p as any).sailor_posterState = s },
})

// Shape picker for the Layout tab: choose a library shape the engine may use
// even without a placed shape layer (sets the sheet's shapeMode).
const layoutShapeOpen = ref(false)
const layoutShapeAnchor = ref({ x: 0, y: 0 })
const layoutShapeTrigger = ref<HTMLElement | null>(null)
const layoutShapeValue = computed(() => {
  const m = layoutSheet.shapeMode.value
  return m && 'id' in m ? m.id : SHAPE_NONE
})
// Trigger label + family mode: shapeMode can be a specific {id} OR a {family}
// (the seed picks a shape within it per tile — the engine already handles both).
const layoutShapeLabel = computed(() => {
  const m = layoutSheet.shapeMode.value
  if (!m) return 'No shape'
  if ('family' in m) return 'Any ' + (SHAPE_FAMILIES.find(f => f.id === m.family)?.label ?? m.family).toLowerCase()
  return shapeById(m.id)?.name ?? m.id
})
const layoutFamily = computed(() => { const m = layoutSheet.shapeMode.value; return m && 'family' in m ? m.family : '' })
function pickLayoutFamily(fam: string) { if (fam) layoutSheet.setShapeMode({ family: fam }) }
function openLayoutShape(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  layoutShapeTrigger.value = el
  layoutShapeAnchor.value = { x: r.left, y: r.bottom + 6 }
  layoutShapeOpen.value = !layoutShapeOpen.value
}
function pickLayoutShape(id: string) {
  layoutSheet.setShapeMode(id === SHAPE_NONE ? null : { id })
}
function onLayoutPalette(fam: { hexes: string[] }) { layoutSheet.setPaletteMode(fam.hexes) }
function onLayoutPaletteStops(stops: GradientStop[]) { layoutSheet.setPaletteMode(stops.map(s => s.color)) }
function clearLayoutPalette() { layoutSheet.setPaletteMode(null) }
const layoutPaletteHexes = computed(() => layoutSheet.paletteMode.value)

// Face pickers for the Layout tab: title face → the inferred title layer; text
// face → the inferred details/caption/date layers; Suggest pairs a text face
// from the standalone table. These are USER picks (setLocal on your own layers),
// like the shape/palette — the sheet never rolls a face.
const posterFaceEls = computed(() => {
  const els = inferElements(posterLayerViews(compositor.value?.data?.properties as Record<string, unknown> | undefined))
  return { titleId: els.title?.id as string | undefined, textIds: [els.details?.id, els.caption?.id, els.date?.id] as (string | undefined)[] }
})
function faceKeyFor(fam: string): string {
  if (!fam) return 'goog:Inter'
  const v = VARIABLE_FONTS.find(f => f.family === fam)
  if (v) return 'var:' + v.id
  if (libraryFamily(fam)) return 'lib:' + fam
  return 'goog:' + fam
}
function familyFromLayer(id: string | undefined): string {
  const l = id ? (localLayers.value.find((x: any) => x.id === id) as any) : null
  return l?.fontFamily || ''
}
const titleFaceFamily = computed(() => familyFromLayer(posterFaceEls.value.titleId) || 'Inter')
const textFaceFamily = computed(() => familyFromLayer(posterFaceEls.value.textIds.find(Boolean)) || titleFaceFamily.value)
const titleFaceKey = computed(() => faceKeyFor(titleFaceFamily.value))
const textFaceKey = computed(() => faceKeyFor(textFaceFamily.value))
const hasTextRole = computed(() => posterFaceEls.value.textIds.some(Boolean))
type FontPick = { source: 'variable'; id: string } | { source: 'google'; font: GoogleFont } | { source: 'library'; family: string }
function familyFromPick(p: FontPick): string {
  if (p.source === 'library') { if (p.family) ensureLibraryFont(p.family); return p.family }
  const family = p.source === 'variable' ? (VARIABLE_FONTS.find(f => f.id === p.id)?.family ?? '') : p.font.family
  if (family) ensureGoogleFont(family)
  return family
}
function applyFaceTo(ids: (string | undefined)[], family: string) {
  if (!family) return
  for (const id of ids) if (id) setLocal(id, { fontFamily: family })
}
function onPickTitleFace(p: FontPick) { applyFaceTo([posterFaceEls.value.titleId], familyFromPick(p)) }
function onPickTextFace(p: FontPick) { applyFaceTo(posterFaceEls.value.textIds, familyFromPick(p)) }
function onPickAccentFace(p: FontPick) { if (selectedLocal.value) setLocal(selectedLocal.value.id, { accentFace: familyFromPick(p) } as any) }
function clearAccentFace() { if (selectedLocal.value) setLocal(selectedLocal.value.id, { accentFace: undefined } as any) }
function onSuggestTextFace() {
  const s = suggestTextFace(titleFaceFamily.value)
  ensureGoogleFont(s.family); ensureLibraryFont(s.family)
  applyFaceTo(posterFaceEls.value.textIds, s.family)
  toast(`Text face: ${s.family}`, { description: s.reason })
}

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

// ── Mosaic (the generative deal layer, kind 'deal') ─────────────────────────
// ONE self-painting layer — a playgrnd-style composition (Tiles / Pane / Modular /
// Parcel / Mosh, and the Oddgrid / Static shaders) as a single layer that BAKES
// (unlike the editor-only grid overlay). It is an ELEMENT: added from the toolbar's
// Shapes menu (addMosaic, below with the other stamps), tuned in the inspector
// while selected. The frame's Grid section is only the layout guide — it no longer
// creates or configures mosaics. The layer carries its OWN grid, so the frame grid
// is never read here.

/** Patch a deal layer's own grid (one history step via setLocal). */
function patchDealGrid(layer: DealLayer, patch: Partial<typeof layer.grid>) {
  setLocal(layer.id, { grid: { ...layer.grid, ...patch } })
}
/** Set a mosaic's seed — grid.gen.seed AND, for a shader style, the spec's seed
 *  (one variation; see mosaicSeedPatch). One history step via setLocal. */
function setDealSeed(layer: DealLayer, seed: number) {
  setLocal(layer.id, mosaicSeedPatch(layer, seed))
}
/** Re-roll a mosaic's seed for a fresh coherent variation (layout + fills + density
 *  for Tiles; the whole composition for every other style). */
function rerollDeal(layer: DealLayer) {
  setDealSeed(layer, freshMosaicSeed())
}
/** The ShaderSpec the selected shader-style mosaic edits — derived at the layer's
 *  seed when the layer has none yet (an agent-made layer), so the editor never
 *  binds to undefined. */
function mosaicShader(layer: DealLayer) {
  return isMosaicShaderFill(layer.cellFill) ? mosaicShaderSpec(layer.cellFill, layer.grid.gen.seed, layer.shader) : null
}
/** The Look (the shader styles' Palette) the selected mosaic currently matches —
 *  'Custom' once any dial moved off every Look. */
const MOSAIC_CUSTOM_LOOK = 'Custom'
const mosaicLook = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  const spec = mosaicShader(l as DealLayer)
  return spec ? (mosaicLookOf(spec) || MOSAIC_CUSTOM_LOOK) : ''
})
const mosaicLookOptions = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal' || !isMosaicShaderFill((l as DealLayer).cellFill)) return []
  const names = mosaicLookNames((l as DealLayer).cellFill as string)
  return mosaicLook.value === MOSAIC_CUSTOM_LOOK ? [...names, MOSAIC_CUSTOM_LOOK] : names
})
function applyMosaicLookTo(layer: DealLayer, name: string) {
  const spec = mosaicShader(layer)
  if (!spec || name === MOSAIC_CUSTOM_LOOK) return
  setLocal(layer.id, { shader: applyMosaicLook(spec, name) } as Partial<DealLayer>)
}

/** Pane — the Pane generator (lib/compositor/pane): its own row-masonry of flush
 *  cells, each a corner-to-corner two-ink ramp (cellFill:'pane'). The deal's grid is
 *  untouched: Pane ignores it (only its seed carries the variation). */
/** Patch a deal's Pane tunables (one history step via setLocal). */
function patchPane(layer: DealLayer, patch: Partial<PaneParams>) {
  setLocal(layer.id, { pane: { ...(layer.pane ?? defaultPane()), ...patch } } as Partial<DealLayer>)
}
/** One ink of the Pane's ordered palette, changed by hand (see paneInkPatch). */
function patchPaneInk(layer: DealLayer, index: number, hex: string) {
  const patch = paneInkPatch(layer.pane ?? defaultPane(), layer.vocab, index, hex)
  if (patch) patchPane(layer, patch)
}
/** The ordered palette the selected Pane is painting with (its own inks or the vocab's). */
const paneInks = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return [] as string[]
  return panePalette((l as DealLayer).pane ?? defaultPane(), (l as DealLayer).vocab)
})
/** Apply a named palette preset (the ordered 8 inks) to a Pane deal. */
function applyPanePreset(layer: DealLayer, name: string) {
  if (!(PANE_PRESET_NAMES as string[]).includes(name)) return
  patchPane(layer, panePresetPatch(name as PanePresetName))
}
/** Which preset the selected Pane deal currently matches ('' when custom / vocab). */
const panePreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return panePresetOf((l as DealLayer).pane ?? defaultPane()) ?? ''
})

/** Modular — the Modular generator (lib/compositor/modular): a merged module grid
 *  over a background, each module empty / solid / block field / dot cluster / line
 *  grid / 2-stop ramp, hairlines over the whole grid (cellFill:'modular'). The deal's
 *  grid is untouched: Modular ignores it (only its seed carries the variation). */
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

/** Parcel — the Parcel generator (lib/compositor/parcel): a coarse two-tone block
 *  field (ground + ink, every cell one or the other) with ragged hairline survey
 *  grids floating on top that darken what they cross (cellFill:'parcel'). The deal's
 *  grid is untouched: Parcel ignores it (only its seed carries the variation). */
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
/** Mosh — the Mosh generator (lib/compositor/mosh): a corrupted framebuffer —
 *  uneven horizontal bands, each a different failure (confetti runs, torn mosaic
 *  blocks, thin smears, full-width scan rows with bright cuts, a chevron
 *  herringbone), every mark a column-quantised filled rect in full-strength
 *  colour-cube inks with dead near-black patches (cellFill:'mosh'). The deal's grid
 *  is untouched: Mosh ignores it (only its seed carries the variation). */
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
/** Carve — the Carve generator (lib/compositor/carve): ONE rectangle carved into
 *  panels by repeated splits, each panel a printed treatment in two of the style's
 *  own inks — flat, two-pitch stripes, stacked chevrons, a grainy ramp, or the one
 *  hairline grid (cellFill:'carve'). The deal's grid is untouched: Carve ignores it
 *  (only its seed carries the variation). */
/** Patch a deal's Carve tunables (one history step via setLocal). */
function patchCarve(layer: DealLayer, patch: Partial<CarveParams>) {
  setLocal(layer.id, { carve: { ...(layer.carve ?? defaultCarve()), ...patch } } as Partial<DealLayer>)
}
/** Apply a named palette preset (the 6 ordered inks) to a Carve deal. */
function applyCarvePreset(layer: DealLayer, name: string) {
  if (!(CARVE_PRESET_NAMES as string[]).includes(name)) return
  patchCarve(layer, carvePresetPatch(name as CarvePresetName))
}
/** Which preset the selected Carve deal currently matches ('' when custom). */
const carvePreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return carvePresetOf((l as DealLayer).carve ?? defaultCarve()) ?? ''
})
/** Totem — the Totem generator (lib/compositor/totem): a framed screenprint plate on
 *  a speckled mat, the left half carved into blocks of two-colour cell rules and
 *  folded onto the right, with a stack of nested rects at its middle (cellFill:'totem'). The
 *  deal's grid is untouched: only its seed carries the variation. */
/** Patch a deal's Totem tunables (one history step via setLocal). */
function patchTotem(layer: DealLayer, patch: Partial<TotemParams>) {
  setLocal(layer.id, { totem: { ...(layer.totem ?? defaultTotem()), ...patch } } as Partial<DealLayer>)
}
/** One swatch of the Totem's ordered row, changed by hand (see totemInkPatch). */
function patchTotemInk(layer: DealLayer, index: number, hex: string) {
  const patch = totemInkPatch(layer.totem ?? defaultTotem(), index, hex)
  if (patch) patchTotem(layer, patch)
}
/** The ordered row the selected Totem is printing with. */
const totemInks = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return [] as string[]
  return normalizeTotem((l as DealLayer).totem ?? defaultTotem()).inks
})
/** Apply a named palette preset (the 5 ordered inks) to a Totem deal. */
function applyTotemPreset(layer: DealLayer, name: string) {
  if (!(TOTEM_PRESET_NAMES as string[]).includes(name)) return
  patchTotem(layer, totemPresetPatch(name as TotemPresetName))
}
/** Which preset the selected Totem deal currently matches ('' when custom). */
const totemPreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return totemPresetOf(normalizeTotem((l as DealLayer).totem ?? defaultTotem())) ?? ''
})
/** Blueprint — a technical drafting grid (lib/compositor/blueprint): a cartesian
 *  minor/major lattice plus a polar overlay (dashed radial spokes, concentric arcs
 *  with hatch ticks and angle labels) struck from a seeded origin (cellFill:'blueprint').
 *  The deal's grid is untouched: only its seed carries the variation. */
/** Patch a deal's Blueprint tunables (one history step via setLocal). */
function patchBlueprint(layer: DealLayer, patch: Partial<BlueprintParams>) {
  setLocal(layer.id, { blueprint: { ...(layer.blueprint ?? defaultBlueprint()), ...patch } } as Partial<DealLayer>)
}
/** One role ink of the Blueprint changed by hand — the picker's alpha is cut (an ink
 *  is opaque; per-element dimming comes from the dials, not the hex). */
function patchBlueprintInk(layer: DealLayer, role: 'paper' | 'ink' | 'inkDim', hex: string) {
  const cut = /^#[0-9a-fA-F]{8}$/.test(hex) ? hex.slice(0, 7) : hex
  patchBlueprint(layer, { [role]: cut } as Partial<BlueprintParams>)
}
/** The selected Blueprint's normalized params (for reading dials / swatches back). */
const blueprintParams = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return defaultBlueprint()
  return normalizeBlueprint((l as DealLayer).blueprint ?? defaultBlueprint())
})
/** Apply a named palette preset (paper + ink + inkDim) to a Blueprint deal. */
function applyBlueprintPreset(layer: DealLayer, name: string) {
  if (!(BLUEPRINT_PRESET_NAMES as string[]).includes(name)) return
  patchBlueprint(layer, blueprintPresetPatch(name as BlueprintPresetName))
}
/** Which preset the selected Blueprint deal currently matches ('' when custom). */
const blueprintPreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'deal') return ''
  return blueprintPresetOf(normalizeBlueprint((l as DealLayer).blueprint ?? defaultBlueprint())) ?? ''
})
/** The Mosaic's Style option currently showing (the style table lives in
 *  lib/compositor/mosaic — one vocabulary for the inspector, the agent and the specs). */
const mosaicStyleLabel = (layer: DealLayer) => mosaicLabelOf(layer.cellFill)
/** Whether the selected mosaic's vocabulary changes its look (gates the vocabulary
 *  Palette control — Parcel / Mosh / a Pane with its own inks never read it). */
const vocabDrivesLook = computed(() => {
  const l = selectedLocal.value
  return !!l && l.kind === 'deal' && dealVocabDrivesLook(l as DealLayer)
})
/** Switch a Mosaic's style (its cellFill), seeding that style's params with the
 *  defaults when absent. The layer, its box and its seed (grid.gen.seed) are kept —
 *  only the composition changes, so "New variation" history and placement survive
 *  a style hop. One history step via setLocal. */
function setMosaicStyle(layer: DealLayer, label: string) {
  setLocal(layer.id, mosaicStylePatch(layer, cellFillOfLabel(label)))
}

// ── Scatter (the thrown-marks layer, kind 'scatter') ────────────────────────
// A SIBLING of the Mosaic element, not one of its styles: a mosaic is a composition
// (a frame divided and filled), a scatter is marks thrown across a sheet. Added from
// the toolbar's Shapes menu (addScatter, below with the other stamps) and tuned here.
//
// There is deliberately NO per-style block below: a style ships its own dials in its
// registry row (lib/compositor/scatter), and the template renders them from that
// list. That is why the anchors for the next two styles say "no edit here".
//   STYLE: strand — no inspector change needed; its dials come from its registry row.
//   STYLE: husk — no inspector change needed; its dials come from its registry row.

/** The selected scatter's registry row (its label, dials and palettes). */
const scatterRow = computed(() => scatterStyleRow((selectedLocal.value as ScatterLayer | null)?.style))
/** …and its NORMALIZED params, so a hand-edited save still drives real controls. */
const scatterDials = computed<Record<string, unknown>>(() => {
  const l = selectedLocal.value
  return l && l.kind === 'scatter' ? scatterParams(l as unknown as { style: string; seed: number }) : {}
})
/** Which palette preset the selected scatter matches ('' when custom). */
const scatterPreset = computed(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'scatter') return ''
  return scatterRow.value.presetOf(scatterDials.value) ?? ''
})
/** Patch ONE dial of the selected scatter's style (one history step via setLocal). */
function patchScatterParam(layer: ScatterLayer, key: string, value: unknown) {
  const row = scatterStyleRow(layer.style)
  const next = row.normalize({ ...scatterParams(layer as unknown as { style: string; seed: number }), [key]: value })
  setLocal(layer.id, { [row.id]: next } as Partial<ScatterLayer>)
}
/** Apply a named palette preset (the style's roles, in order) to a scatter. */
function applyScatterPreset(layer: ScatterLayer, name: string) {
  const row = scatterStyleRow(layer.style)
  if (!row.presetNames.includes(name)) return
  const next = row.normalize({ ...scatterParams(layer as unknown as { style: string; seed: number }), ...row.presetPatch(name) })
  setLocal(layer.id, { [row.id]: next } as Partial<ScatterLayer>)
}
/** The ordered inks the selected scatter is painting with — its style's roles, in the
 *  order that style's paint reads them (`row.inkLabels` names each one). */
const scatterInks = computed<string[]>(() => {
  const l = selectedLocal.value
  if (!l || l.kind !== 'scatter') return []
  const inks = (scatterDials.value as { inks?: unknown }).inks
  return Array.isArray(inks) ? (inks as string[]) : []
})
/** One ink of the selected scatter's ordered palette, changed by hand. Validate,
 *  bounds-check, then patch through the one-history-step dial path — which also drops
 *  the Palette select to custom, since presetOf no longer matches. Unlike Pane's inks,
 *  ALPHA IS KEPT: the styles' printers write each ink's own alpha, so a Cleared or
 *  translucent ground lets the marks sit over whatever is beneath the layer. A fully
 *  opaque pick (`…ff`) is stored as the six-digit form so it still matches a preset. */
function patchScatterInk(layer: ScatterLayer, index: number, hex: string) {
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(hex)) return
  const inks = [...scatterInks.value]
  if (!Number.isInteger(index) || index < 0 || index >= inks.length) return
  inks[index] = hex.length === 9 && /ff$/i.test(hex) ? hex.slice(0, 7) : hex
  patchScatterParam(layer, 'inks', inks)
}
/** Switch a Scatter's style, seeding that style's params with its defaults when
 *  absent. The layer, its box and its seed are kept, so placement and variation
 *  survive a style hop. */
function setScatterStyle(layer: ScatterLayer, label: string) {
  setLocal(layer.id, scatterStylePatch(layer, scatterStyleOfLabel(label)) as Partial<ScatterLayer>)
}
/** Set a scatter's seed — the whole variation. */
function setScatterSeed(layer: ScatterLayer, seed: number) {
  setLocal(layer.id, scatterSeedPatch(layer, seed) as Partial<ScatterLayer>)
}
/** Re-roll for a fresh variation. */
function rerollScatter(layer: ScatterLayer) {
  setScatterSeed(layer, freshScatterSeed())
}
/** A select dial's option LABELS, and the label ↔ value mapping (a style's enum dial
 *  stores its own word; people read the capitalised one). */
const scatterOptionLabels = (c: ScatterSelectControl) => c.options.map(o => o.label)
const scatterOptionLabel = (c: ScatterSelectControl, value: unknown) =>
  c.options.find(o => o.value === value)?.label ?? c.options[0]!.label
const scatterOptionValue = (c: ScatterSelectControl, label: string) =>
  c.options.find(o => o.label === label)?.value ?? c.options[0]!.value
/** Narrowing helpers for the template (a discriminated union needs a cast there). */
const asScatterSelect = (c: ScatterControl) => c as ScatterSelectControl

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
    // H/W, same as the UI's Deal buttons use, so an agent-created deal fills the
    // frame instead of a square (layer boxes are width-normalized).
    aspect: canvasDisplay.h / Math.max(1, canvasDisplay.w),
    brandPalette: brandSwatches(projectBrand?.activeKit.value),
    motion: motionDoc.value,
  }),
  setState: (s) => {
    commit(s.layers)
    if (s.background !== background.value) setBackground(s.background)
    if (JSON.stringify(s.postEffects ?? []) !== JSON.stringify(postEffects.value)) setPostEffects(s.postEffects ?? [])
    if (s.grid && JSON.stringify(s.grid) !== JSON.stringify(gridConfig.value)) setGrid(s.grid)
    // Only the effect-dial TRACKS flow back (animateDial authors them) — fps/duration are the
    // timeline's own controls, never touched by the agent.
    if (JSON.stringify(s.motion?.tracks ?? []) !== JSON.stringify(motionDoc.value.tracks ?? [])) {
      setMotion({ tracks: s.motion?.tracks ?? [] })
      commitMotionTimeline()
    }
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
// ── Recolour the whole frame from a palette family (Design tab, no selection) ──
const frameColourSlots = computed(() => slotsOf(colourSites(localLayers.value as LocalLayer[], background.value, canvasDisplay.h / Math.max(1, canvasDisplay.w))))
type RecolourMemory = { hexes: string[]; applied: Record<string, string>; images?: boolean; imageEffects?: OwnedMaps }
const recolourMemory = computed<RecolourMemory | null>(() => ((compositor.value?.data?.properties as any)?.sailor_recolour ?? null))
const recolourSeed = computed(() => inkOf(frameColourSlots.value)?.hex ?? '#4f8ad9')
const recolourImages = ref<boolean>(!!recolourMemory.value?.images)
watch(recolourMemory, m => { recolourImages.value = !!m?.images })
function writeRecolourMemory(m: RecolourMemory) {
  const n = compositor.value; if (!n) return
  const p = (n.data.properties ||= {}); (p as any).sailor_recolour = m
}
// Persist the switch position on its own, so flipping it (without re-picking a palette)
// survives a reload. Guarded twice: never MINT a memory object for an untouched frame
// from the ref's false→false init, and never fight `watch(recolourMemory, …)` above —
// that mirror already syncs this ref FROM memory, so only write back when this ref is
// the side that actually changed.
watch(recolourImages, (v) => {
  const m = recolourMemory.value
  if (!m && !v) return
  if (m?.images === v) return
  writeRecolourMemory({ hexes: m?.hexes ?? [], applied: m?.applied ?? {}, images: v, imageEffects: m?.imageEffects ?? {} })
})
function recolourWith(hexes: string[]) {
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  const mapping = mapFamily(frameColourSlots.value, hexes)
  const next = recolourFrame(localLayers.value as LocalLayer[], background.value, mapping, aspect)
  const prior = recolourMemory.value?.imageEffects ?? {}
  const identity = Object.entries(mapping).every(([from, to]) => from === to)
  let layers = next.layers, imageEffects: OwnedMaps = prior
  if (recolourImages.value) { const r = applyImageMaps(layers, hexes, prior); layers = r.layers; imageEffects = r.owned }
  else if (Object.keys(prior).length) { const r = removeImageMaps(layers, prior); layers = r.layers; imageEffects = r.owned }
  // A real comparison, not `recolourImages.value || prior non-empty`: that flag was true
  // on every click while the switch was on, even when the map refresh produced byte-identical
  // output (same hexes re-applied) — recording an empty undo step each time.
  const changed = !identity || JSON.stringify(layers) !== JSON.stringify(localLayers.value)
  if (!changed) return
  recordHistory(); commit(layers); editor.writeBackground(next.background)
  writeRecolourMemory({ hexes: hexes.map(h => h.toLowerCase()), applied: mapping, images: recolourImages.value, imageEffects })
}
function applyFamilyToFrame(fam: PaletteFamily) { recolourWith(fam.hexes) }
function applyStopsToFrame(stops: GradientStop[]) { recolourWith(stops.map(s => s.color)) }
function reassignSlot(slotHex: string, toHex: string, alpha?: string) {
  if (toHex.toLowerCase() === slotHex.toLowerCase() && alpha === undefined) return
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  const next = recolourSlot(localLayers.value as LocalLayer[], background.value, slotHex, toHex, aspect, alpha)
  recordHistory(); commit(next.layers); editor.writeBackground(next.background)
  const m = recolourMemory.value; if (m) writeRecolourMemory({ ...m, applied: { ...m.applied, [slotHex.toLowerCase()]: toHex.toLowerCase() } })
}
// Box layers (rect/ellipse/image) get full Figma-style resize (corners + edges,
// anchored opposite side); text/line/path keep uniform corner scale (no 2D box).
const selectedResizable = computed(() => !!selectedLocal.value && (resizableKind(selectedLocal.value.kind) || textBoxResizable(selectedLocal.value)))
// Wired layers join the anchored corner path (aspect-locked, no edge handles):
// the grabbed corner follows the pointer and the opposite corner stays pinned,
// which is the Figma feel. Only kinds with NO box at all (text/line/path) still
// fall back to the uniform-from-centre scale.
const selectedCornerResizable = computed(() => !!selectedLocal.value && (cornerResizableKind(selectedLocal.value.kind) || textBoxResizable(selectedLocal.value)))
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
// Align the selected layer(s) to the FRAME (works for one layer, unlike ALIGN_BTNS).
const ALIGN_FRAME_BTNS = [
  { mode: 'left', icon: AlignStartVertical, title: 'Align left edge of frame' },
  { mode: 'hcenter', icon: AlignCenterVertical, title: 'Centre horizontally in frame' },
  { mode: 'right', icon: AlignEndVertical, title: 'Align right edge of frame' },
  { mode: 'top', icon: AlignStartHorizontal, title: 'Align top of frame' },
  { mode: 'vcenter', icon: AlignCenterHorizontal, title: 'Centre vertically in frame' },
  { mode: 'bottom', icon: AlignEndHorizontal, title: 'Align bottom of frame' },
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
  const guideFor = penGuideTargetId.value
  penGuideTargetId.value = null
  pen.setActive(false)
  penJustFinished = true
  if (!layer) return
  // Drawing FOR a text layer: the path becomes that layer's guide and never
  // becomes a layer of its own. Same ownership rule as every other follow mode —
  // nothing extra in the layer list, and it dies with the text.
  if (guideFor) {
    const target = localLayers.value.find(l => l.id === guideFor && l.kind === 'text')
    if (target) {
      setLocal(guideFor, {
        path: {
          ...((target as any).path ?? {}),
          follow: 'custom',
          d: layer.d,
          size: layer.bbox.w * (layer.scale ?? 1),
        },
      } as any)
      selectLocal(guideFor)
      return
    }
  }
  addPathLayers([layer])
}
/** One-shot: swallow the click that closed a pen path (see onCanvasClick). */
let penJustFinished = false
/** The text layer waiting for a drawn guide, if any. Cleared when the pen is
 *  cancelled, so leaving the tool never silently rewires a layer later. */
const penGuideTargetId = ref<string | null>(null)
function drawGuideForSelectedText() {
  const l = selectedLocal.value
  if (!l || l.kind !== 'text') return
  penGuideTargetId.value = l.id
  if (!pen.active.value) togglePen()
}
function togglePen() { if (smartActive.value) { if (smartActionBusy.value) return; exitSmartMode() }; pen.setActive(!pen.active.value); if (pen.active.value) { selectLocal(null); exitNodeEdit(); brush.setActive(false) } else { penGuideTargetId.value = null } }
// Return to the default Select tool: leave pen/node-edit/generate modes.
function selectTool() {
  if (pen.active.value) { pen.setActive(false); penGuideTargetId.value = null }
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
  // Escape disarms the drag-to-generate gesture — checked before the pen's own
  // Escape and BEFORE handleKeydown's bubble-phase Escape (which closes the whole
  // modal) can see the event, so stopPropagation here wins while armed.
  if (e.key === 'Escape' && genGesture.value) {
    e.stopPropagation()
    if (genResult.value) cancelObject()
    else disarmGenGesture()
    return
  }
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
  // Option/Alt spring-loads the drag-to-generate gesture (like holding Space to pan).
  // Only from a clean Select state, and never while typing (the on-box prompt is a field).
  if (e.key === 'Alt' && !inField && !optDown.value && !genActive.value
      && !smartActive.value && isSelectTool.value && !editingId.value) {
    optDown.value = true
    armGenGesture(true)
    return
  }
  // Space on the Motion tab → play / pause the timeline (standard transport shortcut).
  // `repeat` is ignored so holding the key doesn't flicker; the pan gesture below is
  // a Design-tab affordance and must not arm here.
  if (e.code === 'Space' && !inField && inspectorTab.value === 'motion') {
    e.preventDefault()
    // This listener is capture-phase on window; stopping here keeps Space from also
    // reaching the app layout's bubble handler, which opens the canvas node search
    // behind the modal.
    e.stopPropagation()
    if (!e.repeat) (playing.value ? pause() : play())
    return
  }
  // Space → hold-to-pan. Prevent the default page scroll while held, and stop the key
  // here (capture phase) so the app layout doesn't open the node search behind the modal.
  if (e.code === 'Space' && !inField) { e.preventDefault(); e.stopPropagation(); spaceDown.value = true }
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
function onKeyup(e: KeyboardEvent) {
  if (e.code === 'Space') spaceDown.value = false
  if (e.key === 'Alt') {
    optDown.value = false
    // Keep-alive: releasing Option MID-GESTURE (a box is being/has been drawn, or a
    // result awaits) does NOT disarm — matches Space-pan. Otherwise, drop the arm.
    if (genSpring.value && !genDraw.value && !genHasMask.value && !genResult.value) disarmGenGesture()
    else genSpring.value = false   // committed to a box → becomes a sticky arm
  }
}
// If focus leaves the window while Space is held (alt/⌘-tab, clicking into the
// cross-origin ComfyUI iframe, tab switch), the keyup lands elsewhere and
// spaceDown would stay stuck true — freezing layer select/move behind pan mode.
// Reset the whole pan gesture on blur / visibility loss. Option/Alt has the same
// hazard for the drag-to-generate spring arm, so drop it here too (same keep-alive
// predicate as the Alt keyup): a spring arm the user never committed to disarms,
// rather than stranding optDown + the crosshair with the next click drawing a box.
function clearPan() {
  spaceDown.value = false; panning.value = false; panFrom = null
  optDown.value = false
  if (genSpring.value && !genDraw.value && !genHasMask.value && !genResult.value) disarmGenGesture()
  else genSpring.value = false
  if (viewMoveTimer) { clearTimeout(viewMoveTimer); viewMoveTimer = null }
  viewMoving.value = false
}
function onVisibility() { if (document.hidden) clearPan() }
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('blur', clearPan)
  document.addEventListener('visibilitychange', onVisibility)
  // Test hooks (mirrors Scene3DStudioSurface's __scene3dDoc): read and replace the open
  // document's layers, so a spec can seed a legacy-shaped layer without a save/reload cycle.
  // `commit` is the editor's own whole-array writer, so the normal write-through and
  // reactivity paths run exactly as they do for a user edit.
  if (import.meta.dev) {
    ;(window as any).__compositorLayers = () => JSON.parse(JSON.stringify(localLayers.value))
    ;(window as any).__compositorSetLayers = (next: any[]) => { commit(next as any) }
    // Frame slice F1 proof hook: the outline `d` a text layer resolves to (null
    // while its font is loading / for a system font). Lets the parity spec confirm
    // the outline path actually ran rather than silently falling back to fillText.
    ;(window as any).__compositorTextOutline = (i: number) =>
      outlinePathData(localLayers.value[i], canvasDisplay.w)
    // F5 Task 4 parity proof hook: proves the `shader` layer PASS (applyShaderPixelEffect)
    // is exactly `renderFieldWithBase` + the documented destination-in alpha recombine —
    // the studio effect itself, not a parallel reimplementation. Builds its OWN synthetic
    // base canvas (a flat-colour split with a punched-out transparent corner, so both the
    // RGB-split and the alpha recombine have something real to bite on) rather than reusing
    // whatever layer happens to be open, so the comparison is not tangled up in a layer's
    // own box geometry/transform. See compositor-layer-effects.spec.ts "F5 Task 4".
    ;(window as any).__compositorShaderParityProbe = (effect: ShaderPixelEffect, w: number, h: number) => {
      const base = document.createElement('canvas')
      base.width = w; base.height = h
      const bctx = base.getContext('2d')!
      bctx.fillStyle = '#ff0000'; bctx.fillRect(0, 0, w, h)
      bctx.clearRect(0, 0, Math.round(w * 0.2), Math.round(h * 0.2))
      bctx.fillStyle = '#00ff00'; bctx.fillRect(Math.round(w / 2), 0, Math.round(w / 2), h)

      // 1) The real pass under test.
      const actual = document.createElement('canvas')
      actual.width = w; actual.height = h
      actual.getContext('2d')!.drawImage(base, 0, 0)
      applyShaderPixelEffect(actual, effect, { W: w, scale: 1, t: 0 })

      // 2) The hand-built "studio effect" recipe: renderFieldWithBase over the SAME base,
      //    then destination-in against that SAME base — applyShaderPixelEffect's own
      //    documented recombine, spelled out here independently.
      const spec = shaderSpecFromEffect(effect)
      const fieldResult = renderFieldWithBase(spec, base, w, h, undefined, 0)
      const expected = document.createElement('canvas')
      expected.width = w; expected.height = h
      const ectx = expected.getContext('2d')!
      ectx.drawImage(fieldResult, 0, 0)
      ectx.globalCompositeOperation = 'destination-in'
      ectx.drawImage(base, 0, 0)

      return { actual: actual.toDataURL(), expected: expected.toDataURL() }
    }
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('keyup', onKeyup, true)
  window.removeEventListener('blur', clearPan)
  document.removeEventListener('visibilitychange', onVisibility)
  if (import.meta.dev) {
    delete (window as any).__compositorLayers
    delete (window as any).__compositorSetLayers
    delete (window as any).__compositorTextOutline
  }
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

// ── Per-layer effect stack: tree state and mutations ──────────────────────────
// Which layers show their effect rows. Local UI state on purpose — persisting it would dirty
// the document on a disclosure click, exactly as expandedGroups already avoids.
const expandedLayers = ref<Set<string>>(new Set())
const layerStack = (layer: any): EffectInstance[] => effectStackOf(layer)
// How many effects each layer carries, so the row template can decide whether to draw the
// disclosure chevron without rebuilding a stack array for every layer on every render.
const layerFxCount = computed(() => {
  const m = new Map<string, number>()
  for (const l of localLayers.value as any[]) if (l?.id) m.set(l.id, effectStackOf(l).length)
  return m
})
const setLayerStack = (layerId: string, stack: EffectInstance[]) =>
  setLocal(layerId, writeStackToLayer(stack) as any)
const layerById = (layerId: string): any => localLayers.value.find((l: any) => l.id === layerId)

// The selection a Task 6 inspector reads. Kept here so the tree is usable on its own.
const selectedEffect = ref<{ layerId: string; effectId: string } | null>(null)
// Clears the stroke selection: the inspector shows ONE breadcrumb, and `onStrokeSelect`
// does the mirror of this. Written as a plain assignment rather than a watcher so the two
// selections can never both be live for a tick.
const selectEffect = (layerId: string, effectId: string) => {
  selectedStroke.value = null
  selectedEffect.value = { layerId, effectId }
}

// ── The selected effect, as the inspector reads and writes it ─────────────────
// A separate concept from the layer selection: picking an effect row leaves the layer
// selected (the breadcrumb needs its name), but the inspector then shows only the effect.
// Picking a layer row clears the effect (see `onRowClick`).
const activeEffect = computed<EffectInstance | null>(() => {
  const sel = selectedEffect.value
  if (!sel) return null
  const l = layerById(sel.layerId)
  return l ? (layerStack(l).find(e => e.id === sel.effectId) ?? null) : null
})
const activeEffectLayer = computed<any>(() => (selectedEffect.value ? layerById(selectedEffect.value.layerId) : null))
// Depth of field is the one panel kind with a precondition: no depth map, no dials. The
// inspector says so rather than showing a breadcrumb over an empty body.
const activeEffectDepth = computed(() => (activeEffectLayer.value ? localDepthSource(activeEffectLayer.value) : undefined))
/** Write a patch onto the selected instance, BY ID, keeping the stack's order. */
function updateActiveEffect(patch: Record<string, unknown>) {
  const sel = selectedEffect.value
  const l = sel ? layerById(sel.layerId) : null
  if (!sel || !l) return
  setLayerStack(sel.layerId, layerStack(l).map(e => (e.id === sel.effectId ? { ...e, ...patch } : e)))
}
/** The kinds `PostEffectsControls` draws — read from that component's own section list,
 *  so adding a section there cannot leave an effect row selecting into an empty panel. */
const isPanelKind = (k: EffectKind) => (PANEL_EFFECT_KINDS as string[]).includes(k)
/** Human labels for the curated overlay blend modes — the stored value is the internal name,
 *  the select shows sentence-case copy (per the UI copy rule for selects over internal values). */
const OVERLAY_BLEND_LABELS: Record<string, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', 'soft-light': 'Soft light',
}
/** Human labels for the alpha-stroke alignment, same select-copy rule as the blend labels. */
const STROKE_ALPHA_ALIGN_LABELS: Record<string, string> = {
  inside: 'Inside', center: 'Centre', outside: 'Outside',
}
// The selection is by id, so a vanished effect — its layer deleted, or an undo that
// rolled the stack back — must not leave the inspector pointing at nothing. One watcher
// covers every removal path (`deleteLocal`, `deleteLayers`, undo/redo), none of which
// live in this file.
watch(activeEffect, v => { if (!v) selectedEffect.value = null })
// The selected instance's rgba colour, split for the hex + alpha inputs the two shadow
// cards share.
const activeFxHex = computed(() => parseRgba((activeEffect.value as any)?.color || '').hex)
const activeFxAlpha = computed(() => parseRgba((activeEffect.value as any)?.color || '').a)
function setActiveFxHex(raw: string) {
  let h = '#' + (raw || '').trim().replace(/^#/, '')
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(h)
  if (m3) h = '#' + m3[1]!.split('').map(c => c + c).join('')
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return // ignore partial/invalid input
  updateActiveEffect({ color: composeRgba(h, activeFxAlpha.value) })
}

// ── The F3 sibling picker, SHARED by every geometry effect that rides the sibling rail ───────
// Combine shapes (boolean) and Morph to shape (morph) both pick a partner outline via
// `refLayerId`, with the IDENTICAL eligibility rule. One definition here, both cards below use
// it — no drift between the two.
//
// Human labels for the four boolean ops — sentence case, never the stored value (UI-copy rule).
const BOOLEAN_OP_LABELS: Record<string, string> = {
  unite: 'Unite', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude',
}
// Human names for the four warp fields — sentence case, never the stored value (UI-copy rule).
const WARP_FIELD_LABELS: Record<string, string> = {
  bulge: 'Bulge', pinch: 'Pinch', wave: 'Wave', twist: 'Twist',
}
/** Eligible sibling partners for the selected geometry effect: every OTHER local layer that can
 *  take a geometry outline (`canTakeGeometry`), minus any carrying a corner pin or a cloner —
 *  the sibling resolver models affine placement only, so a pinned/cloned partner would combine
 *  against the WRONG outline. Excluding them keeps the picker honest rather than silently wrong. */
const geometrySiblingCandidates = computed<{ key: string; label: string }[]>(() => {
  const self = activeEffectLayer.value
  if (!self) return []
  return (localLayers.value as LocalLayer[])
    .filter(l => l.id !== self.id
      && canTakeGeometry(l)
      && !cornerPinActive((l as any).cornerPin)
      && !(l as any).cloner)
    .map(l => ({ key: localKey(l.id), label: layerLabelByKey(localKey(l.id)) }))
})
/** The referenced layer, if the current ref points at a live, still-eligible vector partner. */
function geometrySiblingRefResolvable(ref: string): boolean {
  if (!ref) return false
  return geometrySiblingCandidates.value.some(c => c.key === ref)
}
/** Why the picker is greyed / warns, or '' when it is usable. Shared copy — neutral enough to
 *  sit under either the boolean "Combine with" picker or the morph "Morph to shape" picker. */
const geometrySiblingReason = computed<string>(() => {
  if (geometrySiblingCandidates.value.length === 0) return 'Add another shape layer to reference'
  const ref = (activeEffect.value as any)?.refLayerId as string | undefined
  if (ref && !geometrySiblingRefResolvable(ref)) return 'The chosen layer is no longer a shape — pick another'
  return ''
})

// ── F5 Task 3: the shader-pass effect inspector (picker + derived param dials) ──────────
// Mirrors ShaderFillEditor.vue's picker/dials shape (CatalogModal + derivedShaderFillControls,
// via the shared buildShaderParamRows walk) but trimmed to what a PASS over the layer's own
// pixels needs: no anchor toggle, no nested input-fill editor, no Reads/glass picker — there is
// no separate `input` Paint here to anchor or read a backdrop through (ShaderPixelEffect's own
// doc in effectStack.ts). `activeEffect` is the single read/write source, via updateActiveEffect.
const shaderFxCatalog = ref<ShaderFxCatalog | null>(null)
function loadShaderFxCatalog() {
  retryFieldCatalog()
  fetchShaderFxCatalog().then((c) => { shaderFxCatalog.value = c }).catch(() => { /* picker falls back to the raw id */ })
}
onMounted(loadShaderFxCatalog)

const activeShaderEffectId = computed<string>(() => ((activeEffect.value as any)?.effectId as string | undefined) ?? '')
const activeShaderEffectDef = computed<EffectDef | null>(() => {
  if (!activeShaderEffectId.value) return null
  return shaderFxCatalog.value?.effects.find((e) => e.id === resolveEffectId(activeShaderEffectId.value)) ?? null
})
function shaderFxTitleCase(s: string): string {
  return s.replace(/(^|[_\s])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).trim()
}

// Picker filtered to input-sampling effects only — a purely generative effect would overwrite
// the layer's pixels rather than process them (the F5 plan's picker-eligibility gate, same rule
// the glass lens's Reads picker applies to what it may read).
const shaderFxAllItems = computed<EffectDef[]>(() =>
  (shaderFxCatalog.value?.effects ?? []).filter((e) => effectReadsInput(e.id)))
const shaderFxPickerOpen = ref(false)
const shaderFxPickerSearch = ref('')
const shaderFxPickerFilter = ref('all')
const shaderFxPickerFilters = computed(() => {
  const counts = new Map<string, number>()
  for (const e of shaderFxAllItems.value) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  return [
    { id: 'all', label: 'All', count: shaderFxAllItems.value.length },
    ...[...counts].map(([id, count]) => ({ id, label: shaderFxTitleCase(id), count })),
  ]
})
const shaderFxPickerItems = computed<EffectDef[]>(() => {
  const q = shaderFxPickerSearch.value.trim().toLowerCase()
  return shaderFxAllItems.value.filter((e) =>
    (shaderFxPickerFilter.value === 'all' || e.category === shaderFxPickerFilter.value)
    && (!q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)))
})
function openShaderFxPicker() {
  shaderFxPickerSearch.value = ''
  shaderFxPickerFilter.value = 'all'
  shaderFxPickerOpen.value = true
}
function pickShaderFxEffect(id: string) {
  // Params are per-effect — reset rather than carry stale values across the switch (mirrors
  // ShaderFillEditor's pickEffect); `params: {}` lets the newly picked effect's own catalog
  // defaults show through until the user tunes a dial.
  updateActiveEffect({ effectId: id, params: {} })
  shaderFxPickerOpen.value = false
  retryFieldCatalog()
}

// ── Derived per-effect param dials, same row shape ShaderFillEditor renders ─────────────
const SHADER_FX_PREFIX = 'layer.shader'
const shaderFxParamRows = computed<ShaderParamRow[]>(() => {
  const eff = activeShaderEffectDef.value
  return eff ? buildShaderParamRows(eff, SHADER_FX_PREFIX) : []
})
const isShaderFxColourParam = (r: ShaderParamRow) => r.kind === 'color' || r.kind === 'gradientStops'
function shaderFxDividesAbove(i: number): boolean {
  const rows = shaderFxParamRows.value
  const prev = rows[i - 1]
  return i > 0 && !!prev && isShaderFxColourParam(rows[i]!) !== isShaderFxColourParam(prev)
}
function shaderFxParamsOf(): Record<string, ParamValue> {
  return ((activeEffect.value as any)?.params as Record<string, ParamValue> | undefined) ?? {}
}
function shaderFxParamValue(row: ShaderParamRow): number {
  const raw = shaderFxParamsOf()[row.key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : (row.default as number)
}
function shaderFxColorValue(row: ShaderParamRow): string {
  const raw = shaderFxParamsOf()[row.key]
  return typeof raw === 'string' && raw ? raw : String(row.default)
}
function shaderFxStopsValue(row: ShaderParamRow): GradientStop[] {
  const fallback = cleanStops(row.default, row.maxStops ?? 8, [])
  return cleanStops(shaderFxParamsOf()[row.key], row.maxStops ?? 8, fallback)
}
function shaderFxRampCss(stops: GradientStop[]): string {
  const s = [...stops].sort((a, b) => a.pos - b.pos)
  if (!s.length) return 'transparent'
  return `linear-gradient(to right, ${s.map((x) => `${x.color} ${Math.round(x.pos * 100)}%`).join(', ')})`
}
function setShaderFxParam(key: string, v: ParamValue) {
  updateActiveEffect({ params: { ...shaderFxParamsOf(), [key]: v } })
}
function applyShaderFxRowStops(row: ShaderParamRow, v: GradientStop[]) {
  setShaderFxParam(row.key, v.slice(0, row.maxStops ?? 8).map((s) => ({ pos: s.pos, color: s.color })))
}
const shaderFxClampUnit = (n: number) => Math.max(0, Math.min(1, n))
function editShaderFxRowStopColor(row: ShaderParamRow, i: number, color: string) {
  applyShaderFxRowStops(row, shaderFxStopsValue(row).map((s, j) => (j === i ? { ...s, color } : s)))
}
function editShaderFxRowStopPos(row: ShaderParamRow, i: number, pos: number) {
  applyShaderFxRowStops(row, shaderFxStopsValue(row).map((s, j) => (j === i ? { ...s, pos: shaderFxClampUnit(pos) } : s)))
}
function removeShaderFxRowStop(row: ShaderParamRow, i: number) {
  const s = shaderFxStopsValue(row)
  if (s.length > 2) applyShaderFxRowStops(row, s.filter((_, j) => j !== i))
}
function addShaderFxRowStop(row: ShaderParamRow) {
  const s = [...shaderFxStopsValue(row)].sort((a, b) => a.pos - b.pos)
  let gap = -1, at = 0.5
  for (let i = 0; i < s.length - 1; i++) {
    const g = s[i + 1]!.pos - s[i]!.pos
    if (g > gap) { gap = g; at = (s[i]!.pos + s[i + 1]!.pos) / 2 }
  }
  applyShaderFxRowStops(row, [...shaderFxStopsValue(row), { pos: at, color: s[Math.floor(s.length / 2)]?.color ?? '#888888' }])
}
// Palette generator, folded (same disclosure ShaderFillEditor uses) — keyed per row.
const shaderFxOpenPickers = ref<Record<string, boolean>>({})
function toggleShaderFxPicker(key: string) {
  shaderFxOpenPickers.value = { ...shaderFxOpenPickers.value, [key]: !shaderFxOpenPickers.value[key] }
}

function addLayerEffect(layerId: string, kind: EffectKind) {
  const l = layerById(layerId); if (!l) return
  // Read the BEFORE stack once: after setLayerStack the layer is the new stack, so diffing
  // against a re-read would find nothing and fall back to the last entry — wrong for a pinned
  // kind, which lands at its canonical position rather than at the end.
  const before = layerStack(l)
  const beforeIds = new Set(before.map(e => e.id))
  const next = addEffect(before, kind)
  // A pinned kind already on the layer is refused by returning the same array. Nothing was
  // added, so write nothing and move the selection nowhere.
  if (next === before) return
  setLayerStack(layerId, next)
  expandedLayers.value = new Set(expandedLayers.value).add(layerId)
  // A boolean needs paper.js; warm it now so its result appears as soon as the user picks a
  // sibling (the render path also kicks the warm, but pre-warming avoids a first-frame no-op).
  // Shatter also clips its cells through paper — pre-warm so it fragments on the very first frame.
  if (kind === 'boolean' || kind === 'shatter') void warmPaperBoolean()
  // Select what was just added so its dials are on screen straight away.
  const fresh = next.find(e => !beforeIds.has(e.id)) ?? next[next.length - 1]
  if (fresh) selectEffect(layerId, fresh.id)
}
function removeLayerEffect(layerId: string, effectId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStack(layerId, removeEffect(layerStack(l), effectId))
  if (selectedEffect.value?.effectId === effectId) selectedEffect.value = null
}
function duplicateLayerEffect(layerId: string, effectId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStack(layerId, duplicateEffect(layerStack(l), effectId))
}
function toggleLayerEffect(layerId: string, effectId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStack(layerId, layerStack(l).map(e => (e.id === effectId ? { ...e, visible: !e.visible } : e)))
}
function reorderLayerEffect(layerId: string, fromId: string, toId: string) {
  const l = layerById(layerId); if (!l) return
  const stack = layerStack(l)
  if (!canReorder(stack, fromId, toId)) return
  setLayerStack(layerId, reorderEffect(stack, fromId, toId))
}

// ── the add-effect menu, anchored to the clicked layer row ─────────────────────────────
const fxMenuLayerId = ref<string | null>(null)
const fxMenuPos = ref({ top: 0, left: 0, maxHeight: 0 })
function onFxMenuOutside(ev: PointerEvent) {
  const t = ev.target as HTMLElement | null
  if (t?.closest('[data-fx-menu]')) return
  // A plus button closes/reopens through its own click handler. Closing here first would
  // make a second click on the SAME plus reopen the menu instead of dismissing it.
  if (t?.closest('[data-testid="add-effect"]')) return
  closeFxMenu()
}
/** One menu item's height, and the menu's own width (`w-48`), for the viewport clamp. */
const FX_MENU_ITEM_H = 30
const FX_MENU_W = 192
function openFxMenu(layerId: string, ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  // Keep the whole menu on screen: flip it above the button when the full list would run off
  // the bottom (a layer near the end of a long panel), and pull it left off the right edge.
  // The stroked kinds get an extra "Add outline" entry plus its separating rule.
  const l = layerById(layerId)
  const extra = l && strokeSupportsStack(l.kind) ? FX_MENU_ITEM_H + 9 : 0
  const h = EFFECT_ORDER.length * FX_MENU_ITEM_H + extra + 8
  // The full list is now taller than a short viewport (F3 added five geometry kinds), so the menu
  // must be able to SCROLL rather than run off-screen. Open on whichever side of the button has
  // more room, and cap the height to that room — `maxHeight` drives the container's overflow.
  const MARGIN = 8
  const below = window.innerHeight - (r.bottom + 4) - MARGIN
  const above = (r.top - 4) - MARGIN
  let top: number, maxHeight: number
  if (h <= below || below >= above) {
    top = r.bottom + 4
    maxHeight = Math.min(h, below)
  } else {
    maxHeight = Math.min(h, above)
    top = Math.max(MARGIN, r.top - 4 - maxHeight)
  }
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - FX_MENU_W))
  fxMenuPos.value = { top, left, maxHeight }
  fxMenuLayerId.value = layerId
  document.addEventListener('pointerdown', onFxMenuOutside, true)
  // The menu is teleported and fixed, so it would hang in place while the layer panel scrolls
  // out from under its anchor. Dismiss on an OUTSIDE scroll — but not when the user scrolls the
  // menu's own (now overflowing) list, which also fires a captured scroll event.
  document.addEventListener('scroll', onFxMenuScroll, true)
}
function onFxMenuScroll(ev: Event) {
  if ((ev.target as HTMLElement | null)?.closest?.('[data-fx-menu]')) return
  closeFxMenu()
}
function closeFxMenu() {
  fxMenuLayerId.value = null
  document.removeEventListener('pointerdown', onFxMenuOutside, true)
  document.removeEventListener('scroll', onFxMenuScroll, true)
}
function pickFxKind(kind: EffectKind) {
  if (fxMenuLayerId.value) addLayerEffect(fxMenuLayerId.value, kind)
  closeFxMenu()
}
/** Whether the open plus menu's layer can take another outline. A line has no interior to
 *  offset a band from and keeps its single stroke by design; an image, a brush layer and
 *  wired content have no outline at all — `strokeSupportsStack` is the one place that list
 *  lives, so the menu asks it rather than restating it. */
const fxMenuOffersStroke = computed(() => {
  const l = fxMenuLayerId.value ? layerById(fxMenuLayerId.value) : null
  return !!l && strokeSupportsStack(l.kind)
})
/** A pinned kind already on the layer cannot be added twice; orderable kinds always can.
 *  Depth of field is the one kind the LAYER can refuse: without a depth map it has nothing
 *  to defocus against, so offering it would add a dead effect. */
function fxKindDisabled(kind: EffectKind): boolean {
  const l = fxMenuLayerId.value ? layerById(fxMenuLayerId.value) : null
  if (!l) return false
  if (kind === 'dof' && !localDepthSource(l)) return true
  // Geometry effects transform a vector outline before it rasterises: a layer with no outline
  // (image / wired / brush / line / deal / scatter / mosaic) or decorated text can't take one.
  // WARP is the exception (F3 4b): on a raster layer (image / wired / brush) it runs as a
  // pixel-domain mesh warp of the content, so it stays enabled there even though canTakeGeometry
  // is false.
  if (isGeometryKind(kind) && !canTakeGeometry(l as LocalLayer)) {
    if (!(kind === 'warp' && canWarpRaster(l as LocalLayer))) return true
  }
  return isPinnedKind(kind) && layerStack(l).some(e => e.type === kind)
}
/** Why a greyed menu entry is greyed — depth of field and the geometry kinds each have a
 *  human reason worth spelling out. */
function fxKindDisabledTitle(kind: EffectKind): string | undefined {
  const l = fxMenuLayerId.value ? layerById(fxMenuLayerId.value) : null
  if (!l) return undefined
  if (kind === 'dof' && !localDepthSource(l)) return 'Depth of field needs an image with a depth map'
  if (isGeometryKind(kind) && !canTakeGeometry(l as LocalLayer)) {
    // Warp on a raster layer is enabled (pixel-domain mesh warp) — no greyed reason.
    if (kind === 'warp' && canWarpRaster(l as LocalLayer)) return undefined
    return l.kind === 'text'
      ? 'Underlined or struck-through text can\'t take geometry effects'
      : 'Geometry effects need a vector shape'
  }
  return undefined
}
onBeforeUnmount(closeFxMenu)

// Drag state for effect reordering, scoped to one layer.
const fxDragFrom = ref<{ layerId: string; effectId: string } | null>(null)
const onEffectDragStart = (layerId: string, effectId: string) => { fxDragFrom.value = { layerId, effectId } }
function onEffectDrop(layerId: string, effectId: string) {
  const from = fxDragFrom.value
  fxDragFrom.value = null
  if (from && from.layerId === layerId) reorderLayerEffect(layerId, from.effectId, effectId)
}

// ── Per-layer stroke stack: tree state and mutations ─────────────────────────
// The sibling of the effect stack above, statement for statement, with one difference:
// nothing here is pinned, so every stroke can be dragged.
const strokeStackFor = (layer: any): StrokeInstance[] => strokeStackOf(layer)
// How many strokes each layer carries, so the row template can decide whether to draw the
// disclosure chevron without rebuilding a stack array per layer per render.
const layerStrokeCount = computed(() => {
  const m = new Map<string, number>()
  // Gated on `strokeSupportsStack` for the same reason the rows are: a LINE reads through
  // to a one-entry stack but gets no rows, and counting it would draw a disclosure chevron
  // that expands to nothing.
  for (const l of localLayers.value as any[]) {
    if (l?.id) m.set(l.id, strokeSupportsStack(l.kind) ? strokeStackOf(l).length : 0)
  }
  return m
})
/**
 * Whether the LAYER inspector still offers its pre-stack "Stroke" / "Outline" section.
 *
 * That section writes the legacy `stroke` / `strokeWidth` pair straight onto the layer, and
 * on a layer that already stores a stack that pair is not an edit — it is a takeover:
 * `strokeStackOf` treats a live legacy field as the trustworthy one and ignores the WHOLE
 * array (see `storedStrokeEntries`). One click on its Add took a rect from three outlines to
 * one — three rows gone from the tree, three bands gone from the canvas — with the array
 * still in the document and one stroke-row edit away from being written over for good. The
 * third instance of this feature's "the stack silently collapses to one entry", and the one
 * no unit test could see, because it lives in a different panel entirely.
 *
 * Kept for a layer with NO stored stack: there it is still the front door for a first
 * outline, `strokeStackOf` reads it through exactly as it always did, and nothing can
 * conflict with it. A LINE is unaffected either way — it is not stackable, and its own
 * Color / Thickness rows are a different section.
 */
const showsLegacyStrokeSection = (l: any) => !!l && !layerStoresStrokeStack(l)
const selectedStroke = ref<{ layerId: string; strokeId: string } | null>(null)
/** THE write. `writeStrokeStackToLayer` clears every legacy single-stroke field in the SAME
 *  patch that stores the list, so one edit is one undo step and a layer can never carry both
 *  shapes at once (which would send the next read down the legacy branch).
 *
 *  It also mints a real id for the entry `strokeStackOf` SYNTHESISED from a legacy layer —
 *  the sentinel is a reading artefact and must not be stored. That entry is the row the user
 *  has selected when they edit a legacy layer's only outline, so the selection follows it to
 *  its new id; the patch is index-for-index with the stack, which is what makes that exact. */
const setLayerStrokes = (layerId: string, stack: StrokeInstance[]) => {
  const patch = writeStrokeStackToLayer(stack)
  const sel = selectedStroke.value
  if (sel && sel.layerId === layerId && sel.strokeId === LEGACY_STROKE_ID) {
    const i = stack.findIndex(st => st.id === LEGACY_STROKE_ID)
    // Not found ⇒ that row was the one just removed, and the watcher below clears it.
    if (i >= 0) selectedStroke.value = { layerId, strokeId: patch.strokes[i]!.id }
  }
  setLocal(layerId, patch as any)
}

/** The selected stroke's id, for the tree row's `selected` prop. */
const selectedStrokeId = computed(() => selectedStroke.value?.strokeId ?? null)
const activeStroke = computed<StrokeInstance | null>(() => {
  const sel = selectedStroke.value
  if (!sel) return null
  const l = layerById(sel.layerId)
  return l ? (strokeStackFor(l).find(st => st.id === sel.strokeId) ?? null) : null
})
const activeStrokeLayer = computed<any>(() => (selectedStroke.value ? layerById(selectedStroke.value.layerId) : null))
const activeStrokeKind = computed<string>(() => (activeStrokeLayer.value?.kind as string) || '')
/** Which rows the selected stroke gets — every one gated on something the PAINTER reads.
 *  See lib/compositor/strokeInspector.ts for the gate-by-gate derivation. */
const activeStrokeRows = computed<string[]>(() =>
  activeStroke.value ? strokeInspectorRows(activeStrokeKind.value, activeStroke.value) : [])
const hasStrokeRow = (id: string) => activeStrokeRows.value.includes(id)
/** A path layer stores its stroke width, distance, dash, mark size and spacing in LOCAL
 *  units at scale 1 — the same conversion StrokeStyleRow documents. */
const activeStrokeScale = computed(() =>
  activeStrokeKind.value === 'path' ? ((activeStrokeLayer.value?.scale as number) || 1) : 1)
const strokePxW = (norm: number) => Math.round(norm * outWidth.value * activeStrokeScale.value)
const strokeNormW = (px: number) => px / (outWidth.value * activeStrokeScale.value)
/** Distance is the ONE size field here that is signed: negative pulls the band inside the
 *  shape, so it must not be clamped at 0 the way a width is. */
const strokeNormSigned = (px: number) => px / (outWidth.value * activeStrokeScale.value)

/** Write a patch onto ONE stroke, by id, keeping the stack's order. */
function setStrokeField(layerId: string, strokeId: string, patch: Partial<StrokeInstance>) {
  const l = layerById(layerId); if (!l) return
  setLayerStrokes(layerId, strokeStackFor(l).map(st => (st.id === strokeId ? { ...st, ...patch } : st)))
}
function updateActiveStroke(patch: Partial<StrokeInstance>) {
  const sel = selectedStroke.value
  if (sel) setStrokeField(sel.layerId, sel.strokeId, patch)
}
/** Style and its payload in ONE patch: a `style: 'shapes'` stroke must never exist without
 *  a usable `shapes`, and two writes leave exactly that state between them. */
function setActiveStrokeStyle(style: string) {
  const st = activeStroke.value
  if (st) updateActiveStroke(strokeStylePatch(st, style === 'shapes' ? 'shapes' : 'band'))
}
/** Wobble and its seed in ONE patch: turning it on from Off must seed `wobbleAmount` and
 *  `wobbleLength` in the same write, or the first render is a wobble at nothing — the exact
 *  half-applied-edit shape `setActiveStrokeStyle` already guards against for Style. */
function setActiveStrokeWobble(next: string) {
  const st = activeStroke.value
  if (st) updateActiveStroke(strokeWobblePatch(st, (next === 'wave' || next === 'zigzag' ? next : 'off') as StrokeWobbleChoice))
}
function updateActiveStrokeShapes(patch: Record<string, unknown>) {
  const st = activeStroke.value
  if (st?.shapes) updateActiveStroke({ shapes: { ...st.shapes, ...patch } })
}
// The selection is by id, so a vanished stroke — its layer deleted, the stroke removed, or
// an undo that rolled the stack back — must not leave the inspector pointing at nothing.
watch(activeStroke, v => { if (!v) selectedStroke.value = null })

/** One breadcrumb at a time: picking a stroke row hands the inspector to the stroke and
 *  drops any effect selection (and `onRowClick` does the reverse). */
function onStrokeSelect(layerId: string, strokeId: string) {
  selectedEffect.value = null
  selectedStroke.value = { layerId, strokeId }
}
/** Add-stroke, from the layer row's plus menu. Appended, so a new stroke paints UNDER the
 *  existing ones — adding one never changes what you already see. */
function pickStrokeAdd(layerId: string) {
  const l = layerById(layerId); if (!l || !strokeSupportsStack(l.kind)) { closeFxMenu(); return }
  const before = strokeStackFor(l)
  const beforeIds = new Set(before.map(st => st.id))
  const next = addStroke(before)
  setLayerStrokes(layerId, next)
  expandedLayers.value = new Set(expandedLayers.value).add(layerId)
  const fresh = next.find(st => !beforeIds.has(st.id)) ?? next[next.length - 1]
  if (fresh) onStrokeSelect(layerId, fresh.id)
  closeFxMenu()
}
function onStrokeRemove(layerId: string, strokeId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStrokes(layerId, removeStroke(strokeStackFor(l), strokeId))
  if (selectedStroke.value?.strokeId === strokeId) selectedStroke.value = null
}
function onStrokeDuplicate(layerId: string, strokeId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStrokes(layerId, duplicateStroke(strokeStackFor(l), strokeId))
}
function onStrokeToggleVisible(layerId: string, strokeId: string) {
  const l = layerById(layerId); if (!l) return
  setLayerStrokes(layerId, strokeStackFor(l).map(st => (st.id === strokeId ? { ...st, visible: st.visible === false } : st)))
}
const strokeDragFrom = ref<{ layerId: string; strokeId: string } | null>(null)
const onStrokeDragStart = (layerId: string, strokeId: string) => { strokeDragFrom.value = { layerId, strokeId } }
const onStrokeDragEnd = () => { strokeDragFrom.value = null }
function onStrokeDropOn(layerId: string, strokeId: string) {
  const from = strokeDragFrom.value
  strokeDragFrom.value = null
  if (!from || from.layerId !== layerId) return
  const l = layerById(layerId); if (!l) return
  const stack = strokeStackFor(l)
  if (!canReorderStroke(stack, from.strokeId, strokeId)) return
  setLayerStrokes(layerId, reorderStroke(stack, from.strokeId, strokeId))
}

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
  | { rk: string; kind: 'effect'; layerId: string; effectId: string; depth: number; effect: EffectInstance; pinned: boolean }
  | { rk: string; kind: 'stroke'; layerId: string; strokeId: string; depth: number; stroke: StrokeInstance }
const flatRows = computed<FlatRow[]>(() => {
  const rows: FlatRow[] = []
  // Effects first, then the strokes, so a layer's pseudo-children read in the order the
  // inspector groups them. A LINE deliberately gets no stroke rows: `strokeSupportsStack`
  // excludes it (the painter's line arm reads `layer.stroke`/`strokeWidth` directly and
  // never calls `strokeStackOf`), so listing one would offer an outline that edits nothing.
  const pushEffectRows = (layer: any, depth: number) => {
    if (!layer?.id || !expandedLayers.value.has(layer.id)) return
    for (const e of effectStackOf(layer)) {
      rows.push({
        rk: `fx:${layer.id}:${e.id}`, kind: 'effect', layerId: layer.id, effectId: e.id,
        depth, effect: e, pinned: isPinnedKind(e.type),
      })
    }
    if (!strokeSupportsStack(layer.kind)) return
    for (const st of strokeStackOf(layer)) {
      rows.push({ rk: `st:${layer.id}:${st.id}`, kind: 'stroke', layerId: layer.id, strokeId: st.id, depth, stroke: st })
    }
  }
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
      else {
        rows.push({ rk: k.item.key, kind: 'child', key: k.item.key, layerId: k.item.layer.id, groupId: gid, depth: depth + 1, layer: k.item.layer })
        pushEffectRows(k.item.layer, depth + 2)
      }
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
    else if (t.item.type === 'local') {
      rows.push({ rk: t.item.key, kind: 'local', key: t.item.key, layerId: t.item.layer.id, depth: 0, layer: t.item.layer })
      pushEffectRows(t.item.layer, 1)
    }
    else {
      rows.push({ rk: t.item.key, kind: 'wired', key: t.item.key, slot: t.item.layer.slot, depth: 0, layer: t.item.layer })
      pushEffectRows(t.item.layer, 1)
    }
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
  // Selecting anything that is not an effect row hands the inspector back to the layer.
  if (row.kind !== 'effect') selectedEffect.value = null
  // …and the same for a stroke row: one breadcrumb at a time. UNCONDITIONAL on purpose:
  // this handler is bound only on the `v-else` branch of the row list, and an effect row
  // and a stroke row each render through their own component whose `@click.stop` never
  // lets the event reach here — so `row.kind` is never 'stroke' at this line and a guard
  // for it only reads as though the case were possible. (The `!== 'effect'` guard above
  // is dead for exactly the same reason; it belongs to the effect stack and is left as it
  // stands rather than swept into this fix.) The CLEAR itself is load-bearing: it is what
  // hands the panel back when a layer row is clicked while a stroke is selected, which
  // `one breadcrumb at a time` in tests/compositor-stroke-inspector-wiring.spec.ts covers.
  selectedStroke.value = null
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
  // A deal layer is the Mosaic element — "deal" is its internal kind, not a name.
  if (l.kind === 'deal') return 'Mosaic'
  // A scatter layer is the Scatter element; its kind reads lowercase otherwise.
  if (l.kind === 'scatter') return 'Scatter'
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
  // Effect rows are pseudo-children with NO stack key. The z-order arithmetic below maps
  // every non-group row to `row.key`, so leaving them in would splice `undefined` into the
  // stack order and shift every insertion index once a layer's effects are expanded.
  // Drop the effect rows and rebase the drop index onto the filtered list.
  const all = flatRows.value
  const rows = all.filter(r => r.kind !== 'effect')
  const dropAt = all.slice(0, dropFi).filter(r => r.kind !== 'effect').length
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
    let ai = dropAt - 1
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
    for (let i = 0; i < dropAt && i < rows.length; i++) {
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
  const targetGroup = isWired ? undefined : dropTargetGroup(rows[dropAt - 1])
  recordHistory()
  const curKeys = rows.filter(r => r.kind !== 'group').map((r: any) => r.key as string)
  let ki = 0
  for (let i = 0; i < dropAt && i < rows.length; i++) if (rows[i].kind !== 'group') ki++
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
  // Edit-an-area "Box" tool: the box drag owns the canvas ahead of the plain
  // brush/box gen path below (genTool stays 'brush' throughout an edit-area
  // session regardless of regionSelectTool, so this must be checked first).
  if (regionSelectActive.value) { onRegionSelectPointerDown(e); return }
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
const imageCtxMenu = ref<{ x: number; y: number; layerId: string; items: MenuItem[] } | null>(null)
function onCanvasContextMenu(e: MouseEvent) {
  const key = hitTopStackKey(e.clientX, e.clientY)
  const res = key ? resolveStackKey(key) : null
  if (res?.type !== 'local' || res.layer.kind !== 'image') return // native menu for non-images
  e.preventDefault()
  selectLocal(res.layer.id)
  const id = res.layer.id
  imageCtxMenu.value = {
    x: e.clientX, y: e.clientY, layerId: id,
    items: [
      { id: 'edit-image', label: 'Edit image…', icon: Wand2, action: () => { imageCtxMenu.value = null; editImageStart(id) } },
      { id: 'edit-region', label: 'Edit an area…', icon: SquareDashedMousePointer, action: () => { imageCtxMenu.value = null; editRegionStart(id) } },
      // "Select an object" (SAM smart-select) hidden for now — see SMART_SELECT_ENABLED.
      ...(SMART_SELECT_ENABLED ? [
        { divider: true },
        { id: 'select-object', label: 'Select an object…', icon: Lasso, action: () => { imageCtxMenu.value = null; selectObjectStart(id) } },
      ] : []),
    ],
  }
}
// Task 3/4 replace these bodies:
function editImageStart(id: string) {
  exitOtherToolsFor('region')      // leave any other tool; reuse the mutual-exclusion reducer
  if (editRegion.value) editRegionCancel()   // peer takeover slot — only one of the two can be up
  editImage.value = { layerId: id }
  editImagePrompt.value = ''
  selectLocal(id)
}
function editImageCancel() { editImage.value = null; editImagePrompt.value = ''; editResult.value = null }

// The edit models (Kontext / Nano / FLUX Fill) return OPAQUE images — they fill in any
// transparency. So editing a transparent element (a cutout, an alpha shape) would come back
// as a solid rectangle. These restore alpha before the result is saved, and are skipped (a
// no-op) when the source is already opaque. Whole-image edits re-cut the result (its new
// silhouette is honoured); region edits keep the original outside the mask.
function srcHasTransparency(srcImg: HTMLImageElement, w: number, h: number): boolean {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')!; ctx.drawImage(srcImg, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < d.length; i += 4 * 37) if (d[i]! < 250) return true
  return false
}
/** Whole-image edit of a cutout: re-cut the RESULT through background removal for a fresh
 *  alpha, so the edited thing keeps ITS OWN outline — a shape-growing edit like "add a hat"
 *  is not cropped back to the original silhouette. If the re-cut fails, the (opaque) edit is
 *  kept and the failure is surfaced, not silently dropped. */
async function reapplyAlpha(resultUrl: string, srcImg: HTMLImageElement, w: number, h: number): Promise<string> {
  if (!srcHasTransparency(srcImg, w, h)) return resultUrl
  try {
    return await inpaint.removeBackground(resultUrl)
  } catch {
    inpaint.error.value = 'Edited, but the transparency could not be re-cut — the result is opaque.'
    return resultUrl
  }
}
/** Region inpaint: keep the ORIGINAL (with its alpha) outside the mask, take the (opaque)
 *  inpaint result only inside it — so transparency outside the edited region survives.
 *  `maskCanvas` is white=inpaint / black=keep in srcImg's px space. */
async function compositeInpaintAlpha(resultUrl: string, srcImg: HTMLImageElement, maskCanvas: HTMLCanvasElement, w: number, h: number): Promise<string> {
  if (!srcHasTransparency(srcImg, w, h)) return resultUrl   // opaque source: keep the fill as-is
  const res = await loadImage(resultUrl)
  // Mask → alpha (white = the edited region).
  const ma = document.createElement('canvas'); ma.width = w; ma.height = h
  const mactx = ma.getContext('2d')!; mactx.drawImage(maskCanvas, 0, 0, w, h)
  const mid = mactx.getImageData(0, 0, w, h); luminanceToAlpha(mid.data); mactx.putImageData(mid, 0, 0)
  // Bounding box of the edited region.
  const md = mid.data; let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (md[(y * w + x) * 4 + 3]! > 128) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  // Re-cut the FILL so a cutout stays cut: FLUX flattens transparency onto black, so
  // its fill is opaque. Crop the result to the edited region and remove that crop's
  // background — here the fill's black IS the crop's background, so it lifts cleanly
  // (a whole-image re-cut can't, since the black is interior to the kept subject).
  let patchSrc: CanvasImageSource = res
  let px = 0, py = 0, pw = w, ph = h
  if (maxX >= minX) {
    const bw = maxX - minX + 1, bh = maxY - minY + 1
    const crop = document.createElement('canvas'); crop.width = bw; crop.height = bh
    crop.getContext('2d')!.drawImage(res, minX, minY, bw, bh, 0, 0, bw, bh)
    try {
      patchSrc = await loadImage(await inpaint.removeBackground(crop.toDataURL('image/png')))
      px = minX; py = minY; pw = bw; ph = bh
    } catch { /* re-cut unavailable → fall back to the raw (opaque) fill */ }
  }
  // Place the (cut) fill and clip it to the mask.
  const clip = document.createElement('canvas'); clip.width = w; clip.height = h
  const cctx = clip.getContext('2d')!
  cctx.drawImage(patchSrc, px, py, pw, ph)
  cctx.globalCompositeOperation = 'destination-in'
  cctx.drawImage(ma, 0, 0)
  // Original (alpha kept) + the fill over it, inside the mask only.
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')!
  ctx.drawImage(srcImg, 0, 0, w, h)
  ctx.drawImage(clip, 0, 0)
  return cv.toDataURL('image/png')
}

async function runImageEdit() {
  const e = editImage.value; if (!e || !editImagePrompt.value.trim() || inpaint.busy.value) return
  const layer = localLayers.value.find((l: any) => l.id === e.layerId && l.kind === 'image') as any
  if (!layer) return
  const layerId = layer.id
  const origFilename = layer.filename        // revert target + re-roll source (never compound)
  const prompt = styledPrompt(editImagePrompt.value.trim())
  const m = wholeEditModel.value
  // Generate from the ORIGINAL image every call (a re-roll must not stack on the
  // previous result). Returns true on success.
  const apply = async (): Promise<boolean> => {
    const img = await loadImage(imageLayerUrl(origFilename))
    const { w, h } = capDims(img.naturalWidth || 1024, img.naturalHeight || 1024)
    const src = imageToDataUrl(img, w, h)
    // Reference editors (image_urls+prompt) go through nanoGen with a variant;
    // 'kontext' is the FLUX.2 route.
    const out = (m === 'nano' || m === 'nano2' || m === 'seedream' || m === 'gptimage')
      ? await inpaint.nanoGen(prompt, src, undefined, m)
      : await inpaint.kontext(src, prompt)
    const first = out[0]; if (!first) { inpaint.error.value = 'The edit returned no image — try again.'; return false }
    const name = await inpaint.uploadDataUrl(await reapplyAlpha(first, img, w, h), 'compedit')
    setLocal(layerId, { filename: name })
    return true
  }
  try {
    if (await apply()) {
      const b = boxPx(layer)
      const cx = layer.x * canvasDisplay.w, cy = layer.y * canvasDisplay.h
      editResult.value = {
        layerId, origFilename,
        bnd: { minX: cx - b.w / 2, minY: cy - b.h / 2, maxX: cx + b.w / 2, maxY: cy + b.h / 2 },
        reroll: async () => { await apply() },
      }
    }
  } catch (err) { console.error('[compositor edit image]', err) /* inpaint.error is shown in the panel */ }
}
function editRegionStart(id: string) {
  exitOtherToolsFor('region')      // leave any other tool; reuse the mutual-exclusion reducer
  editImage.value = null           // peer takeover slot — only one of the two can be up
  editRegion.value = { layerId: id }
  selectLocal(id)
  genActive.value = true
  genTargetId.value = id
  genTool.value = 'brush'
  regionSelectTool.value = 'box'
  regionPrompt.value = ''
  clearGenMask()
}
function editRegionCancel() { editRegion.value = null; exitGenMode(); regionPrompt.value = '' }
function setRegionSelectTool(t: 'box' | 'brush') {
  regionSelectTool.value = t
  if (t === 'box') genCursor.on = false   // drop the brush-size ring immediately
}
async function runRegionEdit() {
  if (!editRegion.value || !genHasMask.value || !regionPrompt.value.trim() || inpaint.busy.value) return
  // FLUX Fill only for now — regionEditModel is captured but 'nano' isn't wired
  // to a region-crop-and-composite path yet (see task-4-report.md, deferred).
  genPrompt.value = styledPrompt(regionPrompt.value.trim())
  await runRegionFill()
}
function selectObjectStart(id: string) { editImageCancel(); editRegionCancel(); selectLocal(id); toggleSmartMode() }
function onCanvasPointerMoveCapture(e: PointerEvent) {
  if (smartActive.value) { onSmartPointerMove(e); return }
  if (regionSelectActive.value) { onRegionSelectPointerMove(e); return }
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
  if (regionSelectActive.value) { onRegionSelectPointerUp(e); return }
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
  // The click that CLOSED a pen path arrives here after the pen has already
  // switched itself off, so without this one-shot it would deselect the layer
  // finishPen just selected — you would finish drawing a type guide and land on
  // nothing. Same idiom as `lastDownHitLayer` above.
  if (penJustFinished) { penJustFinished = false; return }
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
  [
    ...layers.value.filter(l => l.live).map(l => ({ duration: l.live!.duration, fps: l.live!.fps })),
    ...clipClocks(localLayers.value as LocalLayer[]),
  ],
  ((compositor.value?.data?.properties as any)?.sailor_frame?.clock) ?? null))
// "Something here plays on its own": a wired studio with a loop, or a living image.
const hasAnimatedSlot = computed(() =>
  layers.value.some(l => l.live && l.live.duration > 0)
  || clipClocks(localLayers.value as LocalLayer[]).length > 0)
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
//
// 640k → 1.0M (2026-09-11): an animated shape-following material (Chrome, Liquid metal — they
// orbit/flow, so the modal is ALWAYS in this live loop while one is present) rendered its mirror
// reflection visibly soft on a retina modal, where 640k lands the backing store near ~0.6× of
// display. The modal is ONE focused editing surface (not the many small Frame cards), so it can
// afford the sharper backing store; export/bake were always full resolution regardless. Higher
// still trades preview frame rate roughly linearly with pixel count.
const LIVE_PREVIEW_MAXPX = 1_000_000, SHADER_PREVIEW_FPS = 30
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

// ── Motion tab · animate an effect dial ─────────────────────────────────────
// The picker lists the selected layer's animatable effect dials (F8) and adds/
// removes a frame-level EffectDialTrack. `sailor_motion.tracks` is an untyped
// field on the persisted doc (FrameMotion carries it structurally through the
// painter seam), so it is read through a small cast here.
const motionTracks = computed<EffectDialTrack[]>(() => (motionDoc.value as any).tracks ?? [])
const animatableDials = computed<DialTargetSpec[]>(() => {
  const l = selectedLocal.value
  if (!l) return []
  // Layer-level fill targets (a gradient fill's scroll phase) precede the effect dials.
  return [...fillDialTargets(l as any), ...effectDialTargets(l as any)]
})
function dialIsAnimated(target: string): boolean {
  return motionTracks.value.some((tr) => tr.target === target)
}
// A stable, DOM-safe id fragment for a dial target's data-testid (paths carry
// dots and colons from the effect id).
function dialTestKey(target: string): string {
  return target.replace(/[^a-z0-9]+/gi, '-')
}
function toggleDialTrack(spec: DialTargetSpec) {
  const l = selectedLocal.value
  if (!l) return
  if (dialIsAnimated(spec.path)) {
    setMotion({ tracks: removeDialTrack(motionTracks.value, spec.path) } as Partial<FrameMotion>)
    return
  }
  if (spec.kind === 'gradient') {
    // Seed from the CURRENT gradient's stops. `gradientMap.stops` targets already
    // resolve (via getByIdPath) to a GradientMapStop[] — already {pos,color}. A
    // `layers.<id>.fill` target resolves to the layer's Paint, so read the fill
    // directly and adapt it via `paintStopsToColor`; a non-gradient fill falls
    // back to a sensible 2-stop default.
    const cur = getByIdPath({ layers: [l] }, spec.path)
    const fill = (l as unknown as { fill?: Paint }).fill
    const seed = Array.isArray(cur)
      ? cur
      : isGradient(fill)
        ? paintStopsToColor(fill)
        : [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]
    setMotion({
      tracks: addDialTrack(motionTracks.value, spec.path, previewT.value ?? 0, seed, undefined, {
        mode: 'crossfade',
        blendSpace: 'oklab',
      }),
    } as Partial<FrameMotion>)
    return
  }
  // Seed the first keyframe from the dial's CURRENT value at the playhead, so the
  // track starts as a no-op hold until a second keyframe is authored (Task 5).
  const cur = getByIdPath({ layers: [l] }, spec.path)
  const seed: number | string =
    typeof cur === 'number' || typeof cur === 'string'
      ? cur
      : spec.kind === 'color'
        ? '#ffffff'
        : (spec.min ?? 0)
  setMotion({
    tracks: addDialTrack(
      motionTracks.value,
      spec.path,
      previewT.value ?? 0,
      seed,
      spec.kind === 'color' ? 'oklch' : undefined,
    ),
  } as Partial<FrameMotion>)
}

// ── Motion tab · unified-motion behaviours (motionx, live slice 1) ──────────
// Temporary entry point: a behaviour compiles to Track[] (via the Frame
// adapter) against the selected layer's CURRENT values and is appended to
// `sailor_motion.motionx`. The render fold (paintLayerStack) already reads
// this field — see CLAUDE.md / um-p3 report. No preview gallery or band
// timeline yet; that lands next.
const motionxTracks = computed<MotionxTrack[]>(() => (motionDoc.value as any).motionx ?? [])
const behaviourPickerOpen = ref(false)
// The Motion tab renders ONE DialKit-style dock (MotionBandTimeline). The legacy dial
// picker + dial timeline are kept in code until 6b deletes them, behind this flag.
const legacyMotionUi = ref(false)
// Slice 2/3: band-timeline selection (a behaviour band, a property band, or a control point)
// drives the contextual inspector in the Motion right column. Writes flow through setMotion.
const motionSel = ref<{ kind: 'band' | 'point' | 'behaviour'; path: string; index?: number } | null>(null)
const motionBehaviours = computed<StoredBehaviour[]>(() => (motionDoc.value as any).behaviours ?? [])
function updateMotionx(tracks: MotionxTrack[]) {
  setMotion({ motionx: tracks } as Partial<FrameMotion>)
}
function selectMotionBand(path: string) { motionSel.value = { kind: 'band', path } }
function selectMotionBehaviour(id: string) { motionSel.value = { kind: 'behaviour', path: id } }
// Slice 4: what behaviour groups the selected layer supports (gradient fill / text layer).
const motionLayerCaps = computed(() => {
  const l = selectedLocal.value
  const fill = (l as unknown as { fill?: Paint })?.fill
  return { gradient: !!l && isGradient(fill), text: l?.kind === 'text' }
})
// A tile is a RECIPE: one or more single-property behaviours, all placed at the
// playhead with the group's default length. The first lands selected.
function onGalleryAdd(move: GalleryMove) {
  const parts = behavioursForMove(move)
  const timing = { start: previewT.value ?? 0, duration: defaultDurationFor(move.group) }
  recordHistory()
  parts.forEach((p, i) => addBehaviour(p.kind, p.params ?? {}, timing, { select: i === 0, record: false }))
  behaviourPickerOpen.value = false
}
// 6a: "Add property" — animate ANY property directly (transform, fill, effect dials) as
// a plain property band. Seeds a flat hold at the property's current value so the band
// is visible + retimeable immediately and a no-op until a point is changed.
const propertyPickerOpen = ref(false)
const selectedAnimatableProps = computed<AnimatableProperty[]>(() =>
  selectedLocal.value ? animatableProperties(selectedLocal.value as LocalLayer) : [])
const animatedPropertyPaths = computed<string[]>(() =>
  motionxTracks.value.filter((t) => !t.behaviourId).map((t) => t.path))
function currentPropertyValue(l: LocalLayer, p: AnimatableProperty): number | string | Array<{ pos: number; color: string }> {
  const prop = p.path.replace(`layers.${l.id}.`, '')
  const rec = l as unknown as Record<string, unknown>
  if (prop === 'fill.phase') return 0
  if (prop === 'fill') { const f = rec.fill as Paint | undefined; return isGradient(f) ? paintStopsToColor(f) : [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }
  const cur = prop.startsWith('effects.') ? getByIdPath({ layers: [l] }, p.path) : rec[prop]
  if (p.type === 'number') return typeof cur === 'number' ? cur : (p.min ?? 0)
  if (p.type === 'color') return typeof cur === 'string' ? cur : '#ffffff'
  return Array.isArray(cur) ? (cur as Array<{ pos: number; color: string }>) : [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]
}
function addProperty(p: AnimatableProperty) {
  const l = selectedLocal.value as LocalLayer | null
  if (!l || animatedPropertyPaths.value.includes(p.path)) return
  const track = seedHoldTrack(p.path, p.type, currentPropertyValue(l, p), motionDoc.value.duration ?? 4)
  recordHistory()
  setMotion({ motionx: setBandTrack(motionxTracks.value, p.path, track) } as Partial<FrameMotion>)
  motionSel.value = { kind: 'band', path: p.path }
  propertyPickerOpen.value = false
}
function selectMotionPoint(sel: { path: string; index: number }) { motionSel.value = { kind: 'point', ...sel } }
function clearMotionSel() { motionSel.value = null }
// Human label for the selected band's property path (Fill · Gradient, Opacity, …).
const motionSelLabel = computed<string>(() => {
  const l = selectedLocal.value, sel = motionSel.value
  if (!l || !sel) return ''
  return animatableProperties(l).find((p) => p.path === sel.path)?.label || sel.path.split('.').pop() || ''
})
// Selecting a different layer clears the motion selection (bands are per-layer).
watch(() => selectedLocal.value?.id, () => { motionSel.value = null })
// Slice 3: a behaviour is a live, param-editable band. Adding one stores a StoredBehaviour
// AND its compiled tracks (tagged with the behaviour id) so the render path (which reads
// motionx) is unchanged, while the band UI shows a single labeled behaviour band.
// Adds ONE single-property behaviour. `timing` defaults to the playhead + the full
// remaining timeline; gallery tiles pass their group's default length (In/Out 0.8s,
// Loop → to the end) so new bars sequence naturally instead of all landing at 0–4s.
function addBehaviour(kind: string, params: Record<string, unknown> = {}, timing?: { start?: number; duration?: number }, opts: { select?: boolean; record?: boolean } = {}) {
  const l = selectedLocal.value
  if (!l) return
  const total = motionDoc.value.duration ?? 4
  const start = Math.max(0, Math.min(total - 0.05, timing?.start ?? previewT.value ?? 0))
  const duration = Math.max(0.05, Math.min(total - start, timing?.duration ?? (total - start)))
  const loop = kind === 'gradientScroll' || kind === 'spin' || kind === 'pulse' || kind === 'sway' || kind === 'float'
  const b: StoredBehaviour = {
    id: 'b' + Date.now() + Math.random().toString(36).slice(2, 6),
    layerId: l.id,
    kind,
    timing: { start, duration, loop },
    params: { ...(kind === 'fade' ? { dir: 'in' } : {}), ...params },
  }
  const tracks = compileBehaviourForLayer(l, b as Behaviour)
  if (opts.record !== false) recordHistory()
  setMotion({
    behaviours: upsertBehaviour(motionBehaviours.value, b),
    motionx: setBehaviourTracks(motionxTracks.value, b.id, tracks),
  } as Partial<FrameMotion>)
  if (opts.select !== false) motionSel.value = { kind: 'behaviour', path: b.id }
  return b.id
}
// Edit a live behaviour's params/timing → recompile its tracks against the current layer.
// `record=false` for continuous edits (timeline drags) — the drag already emitted
// before-change once, so per-move recompiles must not push a history entry each.
function editBehaviour(id: string, patch: { params?: Record<string, unknown>; timing?: Partial<Timing>; kind?: string }, record = true) {
  const cur = motionBehaviours.value.find((b) => b.id === id)
  const l = cur ? localLayers.value.find((x) => x.id === cur.layerId) : null
  if (!cur || !l) return
  const next: StoredBehaviour = {
    ...cur, ...patch,
    timing: { ...cur.timing, ...(patch.timing ?? {}) },
    params: { ...cur.params, ...(patch.params ?? {}) },
  }
  const tracks = compileBehaviourForLayer(l as LocalLayer, next as Behaviour)
  if (record) recordHistory()
  setMotion({
    behaviours: upsertBehaviour(motionBehaviours.value, next),
    motionx: setBehaviourTracks(motionxTracks.value, id, tracks),
  } as Partial<FrameMotion>)
}
// Open = bake: strip the behaviour tag (tracks become plain property bands) + drop the behaviour.
function openBehaviour(id: string) {
  recordHistory()
  setMotion({
    behaviours: removeBehaviour(motionBehaviours.value, id),
    motionx: bakeBehaviour(motionxTracks.value, id),
  } as Partial<FrameMotion>)
  motionSel.value = null
}
// Delete whatever is selected on the timeline: a behaviour (bar + its track), a whole
// property band, or a single control point (dropping the band when it was the last).
function deleteMotionSelection() {
  const sel = motionSel.value
  if (!sel) return
  if (sel.kind === 'behaviour') { deleteBehaviour(sel.path); return }
  const tk = motionxTracks.value.find((t) => t.path === sel.path && !t.behaviourId)
  if (!tk) { motionSel.value = null; return }
  recordHistory()
  if (sel.kind === 'point' && sel.index != null && tk.keyframes.length > 1) {
    const next = { ...tk, keyframes: tk.keyframes.filter((_, i) => i !== sel.index) }
    setMotion({ motionx: setBandTrack(motionxTracks.value, sel.path, next) } as Partial<FrameMotion>)
    motionSel.value = { kind: 'band', path: sel.path }
    return
  }
  setMotion({ motionx: setBandTrack(motionxTracks.value, sel.path, null) } as Partial<FrameMotion>)
  motionSel.value = null
}
// Delete a behaviour entirely (band + its tracks).
function deleteBehaviour(id: string) {
  recordHistory()
  setMotion({
    behaviours: removeBehaviour(motionBehaviours.value, id),
    motionx: setBehaviourTracks(motionxTracks.value, id, []),
  } as Partial<FrameMotion>)
  motionSel.value = null
}

// ── F8 Task 6 · signal driven dials in the effect inspector ──────────────────
// Authoring stays on the Motion tab; the inspector only SIGNALS that a dial is a
// variable (it has a motion track) and refuses to present a driven dial as a plain
// editable static value — the track overrides the stored value at paint, so editing
// the static slider would do nothing visible (misleading). `animatedDialKeys` is the
// set of the OPEN effect's dial KEYS that a track drives; `animatedDialLabels` names
// them (dial half only) for the compact summary drawn under the breadcrumb.
const animatedDialKeys = computed<Set<string>>(() => {
  const layer = activeEffectLayer.value
  const fx = activeEffect.value
  if (!layer || !fx) return new Set<string>()
  return animatedDialKeysOf(effectDialTargets(layer as any), (fx as any).id, motionTracks.value)
})
const animatedDialLabels = computed<string[]>(() => {
  const layer = activeEffectLayer.value
  const fx = activeEffect.value
  if (!layer || !fx || !animatedDialKeys.value.size) return []
  const out: string[] = []
  for (const spec of effectDialTargets(layer as any)) {
    // spec.label is "Effect · Dial"; the summary already sits under the effect
    // breadcrumb, so show just the dial half.
    if (spec.effectId === (fx as any).id && animatedDialKeys.value.has(spec.dialKey)) {
      out.push(spec.label.split(' · ').pop() || spec.label)
    }
  }
  return out
})

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
const inspectorTab = ref<'design' | 'motion' | 'layout'>('design')
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
      const encoded = await encodeFrames({
        frames: storedMotionParams.value!.rendered, fps, width: W, height: H,
        // Transparent WebM when the frame has no background of its own; mp4 otherwise.
        alpha: !hasPaint(background.value),
      })
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
}

// Depth maps arrive asynchronously (see lib/compositor/depthRegistry). paintLayer reads
// them synchronously and renders through unchanged when one is missing, so without this
// subscription a DOF layer would stay unblurred until some unrelated interaction
// happened to trigger a repaint.
let stopDepthWatch: (() => void) | null = null
onMounted(() => { stopDepthWatch = onDepthChange(() => renderStack()) })
// A still shader fill (a Mosaic in the Oddgrid / Static style, speed 0) has no clock
// to re-render it once the shader catalog lands — the first paint after a cold load
// falls back to the spec's input paint and would stay that way until the next edit.
// Same nudge ArtifactFrameNode / Scene3DStudioNode / VectorTypeSurface carry.
let stopFieldCatalog: (() => void) | null = null
onMounted(() => { stopFieldCatalog = onFieldCatalogReady(() => renderStack()) })
onBeforeUnmount(() => { stopFieldCatalog?.(); stopFieldCatalog = null })
// A text layer rendered from glyph OUTLINES (renderAsOutline / a geometry effect)
// falls back to fillText while its font bytes are in flight; this repaints once
// they land, so the outline replaces the fallback with no user interaction. Same
// nudge shape as the depth / field-catalog watchers above.
let stopFontOutline: (() => void) | null = null
onMounted(() => { stopFontOutline = onCompositorFontReady(() => renderStack()) })
onBeforeUnmount(() => { stopFontOutline?.(); stopFontOutline = null })
// A Combine-shapes (boolean) effect no-ops on its cold first frame while paper.js loads (it is
// out of the no-boolean bundle for byte-identity); this repaints once paper is warm so the
// boolean result replaces the pass-through with no user interaction. Same nudge shape as above.
let stopPaperBoolean: (() => void) | null = null
onMounted(() => { stopPaperBoolean = onPaperBooleanReady(() => renderStack()) })
onBeforeUnmount(() => { stopPaperBoolean?.(); stopPaperBoolean = null })
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
    // TEMP open-cost probe: split the wall time between font/image prep and the
    // actual render, both measured from the Edit click (window.__openT).
    const w = typeof window !== 'undefined' ? (window as any) : null
    const t0 = w?.__openT
    for (const l of localLayers.value) if (l.kind === 'text') {
      ensureGoogleFont((l as TextLayer).fontFamily)
      ensureLibraryFont((l as TextLayer).fontFamily)
    }
    await ensureLayerFonts(localLayers.value, canvasDisplay.w)
    await ensureLayerImages(localLayers.value)
    const afterAssets = performance.now()
    renderStack()
    if (w && t0 != null && !w.__openLogged) {
      w.__openLogged = true
      setTimeout(() => { w.__openLogged = false }, 1000)
      console.warn(`[OPEN-PROBE] click→assets-ready ${(afterAssets - t0).toFixed(0)}ms · render ${(performance.now() - afterAssets).toFixed(0)}ms · click→painted ${(performance.now() - t0).toFixed(0)}ms`)
    }
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

// Text-box dimensions in the unit the user is thinking in: pixels, % of the
// composition width, or grid columns (1/columns of the width — the module).
// Values are stored normalized to width, so a column reads as boxW·columns.
const boxUnit = ref<'col' | '%' | 'px'>('col')
// boxW and boxH are BOTH stored normalized to width. So px is absolute for both
// (·width = px), but % and columns/rows must read against the axis the user means:
// width for the width field, HEIGHT for the height field — via the W/H factor.
function boxToUnit(norm: number | undefined, dim: 'w' | 'h' = 'w'): string | number {
  if (!norm) return ''
  if (boxUnit.value === 'px') return pxW(norm)
  const frac = dim === 'h' ? norm * outWidth.value / Math.max(1, outHeight.value) : norm
  if (boxUnit.value === '%') return Math.round(frac * 100)
  return Math.round(frac * (gridConfig.value.columns || 16) * 10) / 10
}
function setBoxDim(id: string, key: 'boxW' | 'boxH', raw: string) {
  const v = parseFloat(raw)
  let norm: number | undefined
  if (!(v > 0)) norm = undefined
  else if (boxUnit.value === 'px') norm = v / outWidth.value
  else {
    const frac = boxUnit.value === '%' ? v / 100 : v / (gridConfig.value.columns || 16)
    norm = key === 'boxH' ? frac * outHeight.value / Math.max(1, outWidth.value) : frac
  }
  setLocal(id, { [key]: norm } as any)
}
function setBoxFit(l: any, fit: 'wrap' | 'shrink' | 'fill' | 'break') { setLocal(l.id, { boxFit: fit } as any) }

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
// ── Type on a path ──────────────────────────────────────────────────────────
// The guide is OWNED by the text layer: no entry in the layer list, no separate
// object to keep in sync, and it dies with the layer. See lib/compositor/textPath.ts.
const textPath = computed<TextPathSpec | undefined>(() => (selectedLocal.value as any)?.path)
/** Dials that must be PRESENT for a mode to produce a curve at all. Switching
 *  mode without seeding these would leave the type flat with a full panel of
 *  controls that visibly do nothing. */
function textPathDefaults(follow: TextPathFollow): TextPathSpec {
  switch (follow) {
    // start 0.5 puts the run over the TOP of the ring reading upright — the badge
    // everyone means by "type on a circle". start 0 would centre it at 6 o'clock,
    // upside down (verified against the placement engine in a real browser).
    case 'circle': return { follow, radius: 0.22, startAngle: 0, start: 0.5 }
    case 'wave': return { follow, amplitude: 0.04, frequency: 2 }
    // Closed outlines are normalised to start at their top (see textPath.ts), so
    // the same 0.5 that centres type over a ring centres it over any shape.
    case 'shape': return { follow, shapeId: 'circle', size: 0.5, start: 0.5 }
    case 'custom': return { follow, size: 0.5 }
    default: return { follow: 'curve', bend: 0.35 }
  }
}
function setTextPath(l: any, patch: Partial<TextPathSpec>) {
  if (!l) return
  const cur: TextPathSpec = l.path ?? textPathDefaults('curve')
  setLocal(l.id, { path: { ...cur, ...patch } } as any)
}
/** Switching mode keeps every dial already set (so going circle → curve → circle
 *  comes back to the ring you had) and seeds only what the new mode needs. */
/** Dials remembered across an Off, keyed by layer. Turning a path off stores no
 *  spec on the layer (absent `path` is what "flat text" means, and saved
 *  documents should not carry a disabled one), but wiping a tuned ring because
 *  someone glanced at Off would be its own bug — so the last spec is held here
 *  for the session and handed back on the way in. */
const textPathMemo = new Map<string, TextPathSpec>()
function setTextFollow(l: any, follow: TextPathFollow | 'off') {
  if (!l) return
  const cur = l.path as TextPathSpec | undefined
  if (follow === 'off') {
    if (cur) textPathMemo.set(l.id, cur)
    setLocal(l.id, { path: undefined } as any)
    return
  }
  const remembered = cur ?? textPathMemo.get(l.id)
  setLocal(l.id, { path: { ...textPathDefaults(follow), ...(remembered ?? {}), follow } } as any)
}
/**
 * `Start` as the SLIDER sees it.
 *
 * An inside run walks the guide backwards (`s' = length − s`), so raising the
 * stored `start` slides the type anticlockwise while an outside run slides
 * clockwise. Dragging the same slider right would move the type opposite ways
 * depending on Side, which reads as a bug. Mirroring the value here keeps the
 * gesture consistent and leaves the engine (and its tests) untouched.
 */
const mirrorStart = (v: number) => (1 - v) % 1   // involution; fixes 0, reverses direction
const textPathStartUi = computed(() => {
  const p = textPath.value
  const v = p?.start ?? 0
  return p?.side === 'inside' ? mirrorStart(v) : v
})
function setTextPathStartUi(l: any, ui: number) {
  const inside = (l?.path as TextPathSpec | undefined)?.side === 'inside'
  setTextPath(l, { start: inside ? mirrorStart(ui) : ui })
}
/**
 * Flipping Side moves the run half way round the guide as well as turning it
 * over. Without that, top-of-ring type flipped to the inside stays at the top
 * and reads upside down; with it, it lands under the ring the right way up —
 * the two halves of a badge, which is what the control is for.
 */
function setTextPathSide(l: any, side: 'outside' | 'inside') {
  const cur = l?.path as TextPathSpec | undefined
  if (!cur || (cur.side ?? 'outside') === side) return
  setTextPath(l, { side, start: ((cur.start ?? 0) + 0.5) % 1 })
}
/** Paths already on this frame, offered as ready-made guides. Copying the `d`
 *  (rather than pointing at the layer) keeps the guide owned by the text: the
 *  original path can be moved, restyled or deleted without breaking the type. */
const framePathLayers = computed(() =>
  (localLayers.value as any[])
    .filter(l => l.kind === 'path' && typeof l.d === 'string' && l.d.length > 0)
    .map((l, i) => ({ id: l.id, label: l.name || (l.shapeId ? `Shape · ${l.shapeId}` : `Path ${i + 1}`) })),
)
function useFramePathAsGuide(l: any, pathLayerId: string) {
  if (!l || !pathLayerId) return
  const src = (localLayers.value as any[]).find(x => x.id === pathLayerId)
  if (!src?.d) return
  setTextPath(l, { follow: 'custom', d: src.d, size: (src.bbox?.w ?? 0.3) * (src.scale ?? 1) })
}
const TEXT_FOLLOW_OPTIONS: { v: TextPathFollow | 'off'; label: string }[] = [
  { v: 'off', label: 'Off' },
  { v: 'curve', label: 'Curve' },
  { v: 'circle', label: 'Circle' },
  { v: 'wave', label: 'Wave' },
  { v: 'shape', label: 'Shape' },
  { v: 'custom', label: 'Drawn path' },
]
const textPathShape = computed(() => {
  const id = textPath.value?.shapeId
  return id ? shapeById(id) : undefined
})
function openTextPathShapePicker() {
  if (textPathShapePickerOpen.value) { textPathShapePickerOpen.value = false; return }
  const r = textPathShapeButtonRef.value?.getBoundingClientRect()
  textPathShapeAnchor.value = r ? { x: r.right - SHAPE_PICKER_WIDTH, y: r.bottom + 4 } : { x: 16, y: 16 }
  textPathShapePickerOpen.value = true
}
const textPathShapePickerOpen = ref(false)
const textPathShapeAnchor = ref({ x: 0, y: 0 })
const textPathShapeButtonRef = ref<HTMLElement | null>(null)
// Anchored to the layer it opened on — switching selection would otherwise
// re-point some OTHER layer's guide on pick.
watch(() => selectedLocal.value?.id, () => { textPathShapePickerOpen.value = false })

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

// ── rgba colour, split for a hex picker + an opacity field ──────────────────
// Shared by the two shadow effects, whose stored `color` is an rgba string.
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
// Candidate layers for a glass fill's "A specific layer" Reads picker — same cross-source
// list as the mask picker (maskCandidates), keyed off the selected local layer the way the
// Mask <select> below (`maskCandidates(localKey(selectedLocal!.id))`) already does. Guarded
// to `[]` with no selection since this is read outside any v-if="selectedLocal" block.
const glassCandidates = computed<{ key: StackKey; label: string }[]>(() => {
  if (!selectedLocal.value) return []
  return maskCandidates(localKey(selectedLocal.value.id))
})
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

// Edit image: whole-image instruction edit (right-click → Edit image…). A
// modal-like inspector takeover, same tier as Brand kits / Templates above —
// see the `editImage` branch in the inspector template.
const editImage = ref<{ layerId: string } | null>(null)
const editImagePrompt = ref('')
const wholeEditModel = ref<string>(WHOLE_IMAGE_MODELS[0]!.value)   // 'kontext'

// Edit an area: drag a box OR brush a mask over an image layer, then inpaint
// just that area (right-click → Edit an area…). No SAM. Reuses the gen-mask
// machinery (`genActive`/`genMaskCanvas`/`runRegionFill`) that drives the
// on-canvas region-paint flow; `regionSelectTool` ('box' | 'brush') picks which
// gesture the canvas routes to while `editRegion` is set.
const editRegion = ref<{ layerId: string } | null>(null)
const regionSelectTool = ref<'box' | 'brush'>('box')
const regionEditModel = ref<string>(REGION_MODELS[0]!.value)   // 'flux'
const regionPrompt = ref('')

// ── Edit surfaces: a FIXED toolbar (modes + model, docked above the main
// toolbar) and a FLOATING prompt bar over the area. Replaces the old right-panel
// takeover — prompting on the side panel felt off to the side of the work. ──
const modelMenuOpen = ref(false)
const editPromptRef = ref<HTMLInputElement | null>(null)
// Keep the edited image in its own existing style. Area fills already blend, but
// whole-image editors can drift, so (when on) we append a style-lock clause to the
// prompt. Off lets a deliberate restyle through ("make it a watercolour").
const keepStyle = ref(true)
function styledPrompt(p: string): string {
  return keepStyle.value ? `${p} — keep the original art style, colours and detail; change only what is described` : p
}
const editMode = computed<'image' | 'region' | 'none'>(() =>
  editImage.value ? 'image' : editRegion.value ? 'region' : 'none')
// The image the edit toolbar acts on: the one being edited, else the single
// selected image layer (so the fixed toolbar is also how you START an edit).
const editToolbarLayer = computed<LocalLayer | null>(() => {
  const id = editImage.value?.layerId ?? editRegion.value?.layerId
  if (id) return (localLayers.value as LocalLayer[]).find(l => l.id === id) ?? null
  const sel = selectedLayers.value
  const only = sel.length === 1 ? sel[0] : null
  return only && only.kind === 'image' ? only : null
})
// The toolbar swaps to the inpaint controls whenever an image is selected (or a
// mode is active) — selecting an image is the entry, not just a right-click.
const showEditToolbar = computed(() =>
  !!editToolbarLayer.value && (editMode.value !== 'none' || isSelectTool.value))
// Model picker, contextual to the active mode: whole-image (FLUX.2/Nano) vs
// area (FLUX Fill/FLUX General/Qwen). One dropdown drives both refs.
const editModels = computed(() => editMode.value === 'region' ? REGION_MODELS : WHOLE_IMAGE_MODELS)
const editModelValue = computed(() => editMode.value === 'region' ? regionEditModel.value : wholeEditModel.value)
const editModelLabel = computed(() =>
  (editModels.value.find(m => m.value === editModelValue.value) ?? editModels.value[0]!).label)
function pickEditModel(v: string) {
  if (editMode.value === 'region') regionEditModel.value = v; else wholeEditModel.value = v
  modelMenuOpen.value = false
}
watch([editImage, editRegion], async () => {
  if (editImage.value || editRegion.value) { await nextTick(); editPromptRef.value?.focus() }
})
const regionSelectActive = computed(() => !!editRegion.value && regionSelectTool.value === 'box')
// Plain function (not a template-visible ref/computed): the deep per-layer
// inspector reads this well past the `v-else-if="editRegion"` branch above,
// where vue-tsc's control-flow narrowing otherwise infers `editRegion` as
// `never` (it's already been narrowed to null by the earlier else-if check
// in the same compiled template function).
function isEditingRegionOf(id: string): boolean { return editRegion.value?.layerId === id }

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

// After a whole-image or region edit lands, the change is applied to the layer
// immediately but stays PENDING: an on-image toolbar offers revert (restore the
// pre-edit image), re-roll (regenerate from the ORIGINAL with a fresh seed), and
// validate (accept). `origFilename` is the revert target; `reroll` re-runs the
// same generation (always from the original, so rolls never compound); `bnd`
// (artboard px) anchors the toolbar. Cleared on revert/validate and on exit.
const editResult = ref<{ layerId: string; origFilename: string; bnd: GenBounds; reroll: () => Promise<void> } | null>(null)
function revertEdit() {
  const r = editResult.value; if (!r || inpaint.busy.value) return
  setLocal(r.layerId, { filename: r.origFilename })
  editResult.value = null
}
async function rerollEdit() {
  const r = editResult.value; if (!r || inpaint.busy.value) return
  try { await r.reroll() } catch (err) { console.error('[compositor edit reroll]', err) }
}
function validateEdit() { editResult.value = null }

// ── Streamlined drag-to-generate gesture ─────────────────────────────────────
// The Generate-in-region engine (genActive + box tool) re-surfaced as a direct
// canvas gesture: a top-level Generate tool + hold-Option drag, a minimal on-box
// bar, and fixed defaults hiding the Style/Scene · Flux/Nano · brush/shape panel.
const genGesture = ref(false)   // armed via the streamlined tool (button or Option)
const genSpring = ref(false)    // this arm came from a held Option (spring-loaded)
const optDown = ref(false)      // Option/Alt currently held
const lastGenStyle = ref<import('~/composables/useStyleList').StyleItem | null>(null)
const genBarBnd = ref<GenBounds | null>(null)   // box bounds (artboard px) the on-box bar anchors to
const genPromptRef = ref<HTMLInputElement | null>(null)
const genBarStyle = computed(() => {
  if (!genBarBnd.value) return {}
  const p = genBarPlacement(genBarBnd.value, canvasDisplay.w, canvasDisplay.h)
  return { left: p.left + 'px', top: p.top + 'px' }
})
// Autofocus the prompt when the bar appears.
watch(genBarBnd, (b) => { if (b) nextTick(() => genPromptRef.value?.focus()) })

function armGenGesture(spring = false) {
  if (!exitOtherToolsFor('region')) return
  const d = genGestureDefaults()
  genActive.value = true
  genGesture.value = true
  genSpring.value = spring
  genTool.value = d.tool          // 'box'
  genMode.value = d.mode          // 'style'
  genModel.value = d.model        // 'flux'
  genTargetId.value = null        // always a NEW layer
  genStyle.value = lastGenStyle.value   // persistence: keep the last style
  genPrompt.value = ''            // fresh prompt each arm
  stylePickerOpen.value = false
  genBarBnd.value = null
  styleList.refresh()
  clearGenMask()
}
function disarmGenGesture() {
  genGesture.value = false
  genSpring.value = false
  genBarBnd.value = null
  exitGenMode()                   // genActive=false, cursor off, clearGenMask, genResult=null
}
function toggleGenGesture() {
  if (genActive.value && genGesture.value) disarmGenGesture()
  else armGenGesture(false)
}

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
  genBarBnd.value = null
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
function exitGenMode() { genActive.value = false; genCursor.on = false; clearGenMask(); genResult.value = null; editResult.value = null }
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
  // Streamlined gesture: reject click-sized boxes so a stray click never pops the
  // bar, and snapshot the box bounds the on-box bar anchors to.
  if (genGesture.value) {
    const bnd = genMaskBounds()
    if (bnd && genBoxIsValid(bnd, canvasDisplay.w, canvasDisplay.h)) genBarBnd.value = bnd
    else { clearGenMask() }
  }
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
// Whole-image edit: a white silhouette of the selected image in artboard space, so
// the glimm sweep can run over the image (not just a painted region) while it edits.
let editSilhouetteCanvas: HTMLCanvasElement | null = null
const regionFx = useRegionFx({
  overlay: genOverlayCanvas,
  sweep: genSweepCanvas,
  getMask: () => editImage.value ? editSilhouetteCanvas
    : (genHasMask.value && genMaskCanvas) ? genMaskCanvas : null,
  getDims: () => canvasDisplay,
  busy: () => inpaint.busy.value,
})
const { sweepMaskUrl: genSweepMaskUrl } = regionFx
watch([genActive, editImage], ([g, e]) => { (g || e) ? regionFx.start() : regionFx.stop() })
watch([genVersion, () => canvasDisplay.w, () => canvasDisplay.h], () => regionFx.rebuild())
async function buildEditSilhouette() {
  const e = editImage.value
  const layer = e ? (localLayers.value.find((l: any) => l.id === e.layerId && l.kind === 'image') as any) : null
  if (!layer) { editSilhouetteCanvas = null; return }
  const W = Math.max(1, Math.round(canvasDisplay.w)), H = Math.max(1, Math.round(canvasDisplay.h))
  try {
    const imgEl = await loadImage(imageLayerUrl(layer.filename))
    const iw = imgEl.naturalWidth || 1, ih = imgEl.naturalHeight || 1
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H
    const ctx = cv.getContext('2d')!
    const inv = regionAffine(layer, iw, ih).inverse()   // image px → artboard px
    ctx.save(); ctx.setTransform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f); ctx.drawImage(imgEl, 0, 0, iw, ih); ctx.restore()
    ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H)  // → white silhouette
    editSilhouetteCanvas = cv
  } catch { editSilhouetteCanvas = null }
  regionFx.rebuild()
}
watch(editImage, (v) => { if (v) void buildEditSilhouette(); else { editSilhouetteCanvas = null; regionFx.rebuild() } })

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
  if (genGesture.value) disarmGenGesture()   // gesture: back to Select
}
function confirmObject() {
  if (genGesture.value) lastGenStyle.value = genStyle.value   // remember the style
  genResult.value = null
  clearGenMask()                 // validated → the drawn area has served its purpose
  if (genGesture.value) disarmGenGesture()   // gesture: back to Select
}

// Artboard px → image px, mirroring the renderer's `applyXform` forward chain
// EXACTLY (translate → rotate → skew-shear → scale → box-fit onto the capped
// capture), so a skewed/scaled layer's region mask still lands on the object.
// Built as a forward (image px → artboard px) DOMMatrix, then inverted — same
// direction/convention `layerAffine` (smartSelect.ts) returns, but that helper
// only serves the un-skewed smart-select scribble path and is left as-is;
// this is the one path (region fill + SAM-select mask) that must handle skew.
// A non-transformed layer (rot=0, no skew, scale=1) reduces to the exact same
// numbers `layerAffine`/the old hand-rolled affine produced — verified by hand
// for that case, since there is no browser available here to eyeball the
// overlay landing on the object (left for the live-verify pass, see report).
function regionAffine(layer: any, capW: number, capH: number): DOMMatrix {
  const W = canvasDisplay.w, H = canvasDisplay.h
  const w = (layer.w || 0.0001) * W, h = (layer.h || 0.0001) * W   // local box, BOTH normalized to W (matches drawLayerContent)
  const skx = layer.skewX || 0, sky = layer.skewY || 0
  const hasSkew = skx !== 0 || sky !== 0
  const shearA = hasSkew ? Math.tan((sky * Math.PI) / 180) : 0
  const shearC = hasSkew ? Math.tan((skx * Math.PI) / 180) : 0
  let forward = new DOMMatrix().translate(layer.x * W, layer.y * H)
  if (layer.rotation) forward = forward.rotate(layer.rotation)
  if (hasSkew) forward = forward.multiply(new DOMMatrix([1, shearA, shearC, 1, 0, 0]))
  // Center + fit the capW×capH capture into the layer's w×h box — the same
  // mapping `ctx.drawImage(img, -w/2, -h/2, w, h)` performs in drawLayerContent.
  forward = forward.translate(-w / 2, -h / 2).scale(w / capW, h / capH)
  return forward.inverse()   // artboard px → image px
}

// ── Region select: drag a BOX → a rectangular mask (no SAM). Brush is the other
// tool. Both paint genMaskCanvas directly in artboard px (genBoxTo / genStrokeTo);
// runRegionFill then projects the mask into the image via regionAffine. A box
// REPLACES the mask; a click (no real drag) clears it. ──
const regionSelectDraw = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
const REGION_DRAG_THRESH = 4   // artboard px — below this it's a click, not a box
function onRegionSelectPointerDown(e: PointerEvent) {
  const p = genPointFromEvent(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  canvasRef.value?.setPointerCapture?.(e.pointerId)
  regionSelectDraw.value = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
}
function onRegionSelectPointerMove(e: PointerEvent) {
  const d = regionSelectDraw.value; if (!d) return
  const p = genPointFromEvent(e); if (!p) return
  e.preventDefault(); e.stopPropagation()
  d.x1 = p.x; d.y1 = p.y
  genBoxTo(d.x0, d.y0, d.x1, d.y1)   // live rectangle into the mask
  genHasMask.value = Math.abs(d.x1 - d.x0) >= REGION_DRAG_THRESH && Math.abs(d.y1 - d.y0) >= REGION_DRAG_THRESH
  genVersion.value++
}
function onRegionSelectPointerUp(e: PointerEvent) {
  const d = regionSelectDraw.value; if (!d) return
  e.preventDefault(); e.stopPropagation()
  regionSelectDraw.value = null
  if (Math.abs(d.x1 - d.x0) < REGION_DRAG_THRESH || Math.abs(d.y1 - d.y0) < REGION_DRAG_THRESH) {
    clearGenMask()   // a click, not a box — nothing selected
  } else {
    genHasMask.value = true; genVersion.value++
  }
}

async function runRegionFill() {
  if (!genHasMask.value || inpaint.busy.value || !genMaskCanvas) return
  const layer = genTarget.value
  try {
    if (layer) {
      const layerId = layer.id
      const origFilename = layer.filename    // revert target + re-roll source (never compound)
      const img = await loadImage(imageLayerUrl(origFilename))
      const { w: capW, h: capH } = capDims(img.naturalWidth || 1024, img.naturalHeight || 1024)
      const imageData = imageToDataUrl(img, capW, capH)
      // Affine (artboard px → image px): inverse of the image's draw transform.
      const m = regionAffine(layer, capW, capH)
      const mc = document.createElement('canvas'); mc.width = capW; mc.height = capH
      const mctx = mc.getContext('2d')!
      mctx.fillStyle = '#000'; mctx.fillRect(0, 0, capW, capH)   // BLACK = keep
      mctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
      mctx.drawImage(genMaskCanvas, 0, 0)                        // WHITE region = inpaint
      mctx.setTransform(1, 0, 0, 1, 0, 0)
      const maskPng = mc.toDataURL('image/png')
      // Keep the named subject WHOLE inside the box: FLUX Fill treats the region as a
      // window and will draw a close-up that the edge crops, so — like the new-object
      // path — tell it to draw the subject small and centred with margin. No white-
      // background clause here: this must blend into the layer, not sit on white.
      const framed = `${genPrompt.value.trim() || 'subject'}. Keep everything requested fully inside this region and complete: the whole subject visible, drawn small and centred with generous empty margin on all sides, nothing cropped or touching the edges of the filled area.`
      // Same original image + mask every call, so a re-roll re-fills the identical
      // region from the untouched source rather than stacking on the last fill.
      const apply = async (): Promise<boolean> => {
        const results = await inpaint.fluxFill(imageData, maskPng, framed,
          { model: regionEditModel.value, tier: regionEditModel.value === 'flux' ? 'pro' : undefined })
        const r0 = results[0]; if (!r0) { inpaint.error.value = 'The edit returned no image — try again.'; return false }
        const newName = await inpaint.uploadDataUrl(await compositeInpaintAlpha(r0, img, mc, capW, capH), 'compinpaint')
        setLocal(layerId, { filename: newName })
        return true
      }
      const bnd = genMaskBounds()   // capture before clearGenMask() wipes the region
      if (await apply() && bnd) {
        editResult.value = { layerId, origFilename, bnd, reroll: async () => { await apply() } }
      }
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
// HIDDEN for now (2026-09-12): the "Select an object" entry is gated off — flip
// to true to restore it. The machinery below is left intact.
const SMART_SELECT_ENABLED = false
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

// SAM 3's mask arrived → it already reflects the accumulated points (promptable
// segmentation, no client-side picking). Load it, convert its white-on-black
// pixels to alpha, and scale onto the capture (capW×capH) as the refined mask.
watch(() => smart.maskUrl.value, async (url) => {
  if (!url || !smartCapture) { smartRefinedCanvas = null; smartInvalidateProjection(); return }
  try {
    const cap = smartCapture
    const img = await loadImage(url)
    const c = document.createElement('canvas')
    c.width = cap.capW; c.height = cap.capH
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const id = ctx.getImageData(0, 0, c.width, c.height)
    luminanceToAlpha(id.data)
    ctx.putImageData(id, 0, 0)
    smartRefinedCanvas = c
  } catch {
    smartRefinedCanvas = null   // unloadable mask → scribble fallback
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
// Generate fill — hand the artboard-space selection to the Edit-region flow as
// its region and let its prompt/Generate take over (target = same layer). Was
// wired to the old (Task 1-removed) region panel via enterGenMode; now opens
// the Edit-region panel instead, carrying the current SAM selection over as
// its starting mask so the user drops straight into typing a prompt.
function smartGenerateFill() {
  return smartAction(async () => {
    if (smartTargetRef.value?.type === 'wired') return // W6: wired generate-fill lands separately
    const proj = smartProjCanvas(); if (!proj) return
    const snapshot = document.createElement('canvas')
    snapshot.width = proj.width; snapshot.height = proj.height
    snapshot.getContext('2d')!.drawImage(proj, 0, 0)
    const targetId = smartTargetId.value
    exitSmartMode(true)                      // clears smart state (proj is snapshotted)
    if (!targetId) return
    editRegionStart(targetId)                // opens Edit a region, locked to this image
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
    : kind === 'brush' ? Brush : kind === 'deal' ? LayoutGrid
    : kind === 'scatter' ? Wheat : Minus
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
const insertMenuOpen = ref(false)
/** Last-used shape, worn by the Shapes button. Component state on purpose —
 *  the spec asks for no persistence beyond the open modal. Same for the
 *  Insert face below: a plain ref, so every session starts on the default. */
const shapeFace = ref<ToolbarShapeId>(DEFAULT_SHAPE_FACE)
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
  rect: Square, ellipse: Circle, line: Minus, polygon: Hexagon, star: Star, mosaic: LayoutGrid, scatter: Wheat, library: Shapes,
}
/** Stamp a Mosaic: a frame-filling Modular composition (one deal layer; see
 *  newMosaicLayer). `h = aspect` because boxes are width-normalized — the same
 *  expression the old Grid-section create used. Records history + selects via
 *  addLocal, like every other stamp. */
function addMosaic() {
  addLocal(newMosaicLayer(canvasDisplay.h / Math.max(1, canvasDisplay.w)))
}
/** Stamp a Scatter: a frame-filling Chaff scatter (one scatter layer; see
 *  newScatterLayer). `h = aspect` because boxes are width-normalized, the same as
 *  the Mosaic stamp above. Records history + selects via addLocal. */
function addScatter() {
  addLocal(newScatterLayer(canvasDisplay.h / Math.max(1, canvasDisplay.w)))
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
  rect: addRect, ellipse: addEllipse, line: addLine, polygon: addPolygon, star: addStar, mosaic: addMosaic, scatter: addScatter, library: stampLibraryShape,
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
const INSERT_ICONS: Record<ToolbarInsertId, Component> = {
  upload: ImagePlus, canvas: LayoutGrid, svg: FileUp,
}
function closeToolbarMenus() {
  zoomMenuOpen.value = false
  shapesMenuOpen.value = false
  insertMenuOpen.value = false
  libraryPickerOpen.value = false
  inspectorShapePickerOpen.value = false
}
function toggleInsertMenu() { const next = !insertMenuOpen.value; closeToolbarMenus(); insertMenuOpen.value = next }
function toggleZoomMenu() { const next = !zoomMenuOpen.value; closeToolbarMenus(); zoomMenuOpen.value = next }
function toggleShapesMenu() { const next = !shapesMenuOpen.value; closeToolbarMenus(); shapesMenuOpen.value = next }
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
/** Shared gate for entering the region-generate or smart-select flow (and, via
 *  selectTool, node-edit): exits pen, brush, and whichever OTHER flow is
 *  running first, so the two can never collide — mirrors what
 *  enterGenMode/enterSmartMode already did ad hoc, factored so they can't
 *  drift apart again. `flow` is the one about to become active; its own state
 *  is left untouched here, the caller flips it on right after. Returns false
 *  when a smart-select action is mid-flight, in which case the caller must
 *  abort rather than start something new on top of it (same guard
 *  togglePen/toggleBrush/toggleDistort already use). Kept for later tasks'
 *  right-click edit flows, which enter these same two modes without the
 *  retired AI ✦ menu. */
function exitOtherToolsFor(flow: 'region' | 'smart'): boolean {
  if (flow !== 'smart' && smartActive.value) {
    if (smartActionBusy.value) return false
    exitSmartMode()
  }
  selectTool(); exitNodeEdit()
  if (pen.active.value) pen.setActive(false)
  brush.setActive(false)
  if (flow !== 'region' && genActive.value) exitGenMode()
  return true
}

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
    if (insertMenuOpen.value) { insertMenuOpen.value = false; return }
    if (pickerDialogOpen.value) { pickerDialogOpen.value = false; return }
    if (fxMenuLayerId.value) { closeFxMenu(); return }
    if (editingId.value) { endEdit(); return }
    if (typing) return
    // The busy guard now lives inside exitSmartMode itself.
    if (smartActive.value) { exitSmartMode(); return }
    // editRegion sets genActive too — must be checked BEFORE the plain genActive
    // exit below, or a first Escape would clear genActive but leave editRegion
    // (and its panel) dangling, and a second Escape would then close the modal
    // instead of finishing the cancel.
    if (editRegion.value) { editRegionCancel(); return }
    if (genActive.value) { exitGenMode(); return }
    if (editImage.value) { editImageCancel(); return }
    emit('close')
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && !genActive.value && !smartActive.value && !brush.active.value) {
    // A timeline selection (behaviour bar / property band / control point) is a pseudo-
    // child of its layer exactly like an effect row: Delete must remove THAT and stop,
    // never fall through to deleteLocal and throw away the layer being animated.
    if (motionSel.value) {
      e.preventDefault()
      deleteMotionSelection()
      return
    }
    // An effect row is a pseudo-child of its layer, so while one is selected Delete must
    // remove THAT EFFECT and stop — reaching `deleteLocal` below would throw away the whole
    // layer the user was tuning.
    const sel = selectedEffect.value
    if (sel) {
      e.preventDefault()
      removeLayerEffect(sel.layerId, sel.effectId)
      return
    }
    // A STROKE row is the same kind of pseudo-child, and needs the same claim on the key.
    // Without it Backspace fell straight through to `deleteLocal` below and threw away the
    // whole layer the user was outlining — the two selections are mutually exclusive (see
    // `selectEffect` / `onStrokeSelect`), so this can only ever fire when a stroke row, and
    // no effect row, is the thing on screen. Found by driving the tree in a real browser;
    // the stack's unit suite cannot see a window key handler.
    const selStroke = selectedStroke.value
    if (selStroke) {
      e.preventDefault()
      onStrokeRemove(selStroke.layerId, selStroke.strokeId)
      return
    }
    // Don't delete the target layer while painting a generative-fill region.
    if (selectedLocalId.value) {
      e.preventDefault()
      deleteLocal(selectedLocalId.value)
    }
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
            <CompositorEffectRow
              v-if="row.kind === 'effect'"
              :effect="row.effect"
              :layer-id="row.layerId"
              :depth="row.depth"
              :pinned="row.pinned"
              :selected="selectedEffect?.layerId === row.layerId && selectedEffect?.effectId === row.effectId"
              @select="selectEffect"
              @remove="removeLayerEffect"
              @duplicate="duplicateLayerEffect"
              @toggle-visible="toggleLayerEffect"
              @drag-start="onEffectDragStart"
              @drop-on="onEffectDrop"
              @drag-end="fxDragFrom = null"
            />
            <CompositorStrokeRow
              v-else-if="row.kind === 'stroke'"
              :stroke="row.stroke"
              :layer-id="row.layerId"
              :depth="row.depth"
              :out-width="outWidth"
              :selected="selectedStroke?.layerId === row.layerId && selectedStrokeId === row.strokeId"
              @select="onStrokeSelect"
              @remove="onStrokeRemove"
              @duplicate="onStrokeDuplicate"
              @toggle-visible="onStrokeToggleVisible"
              @drag-start="onStrokeDragStart"
              @drop-on="onStrokeDropOn"
              @drag-end="onStrokeDragEnd"
            />
            <div
              v-else
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
              <!-- Layer effect disclosure — only on a layer that actually has effects. -->
              <button
                v-if="(row.kind === 'local' || row.kind === 'child' || row.kind === 'wired')
                  && row.layer?.id && ((layerFxCount.get(row.layer.id) ?? 0) + (layerStrokeCount.get(row.layer.id) ?? 0)) > 0"
                type="button" data-testid="layer-fx-toggle"
                title="Show/hide effects and outlines"
                class="-ml-1 shrink-0 text-white/40 hover:text-white/80 cursor-pointer"
                @click.stop="expandedLayers = expandedLayers.has(row.layer.id)
                  ? new Set([...expandedLayers].filter(x => x !== row.layer.id))
                  : new Set(expandedLayers).add(row.layer.id)"
              ><component :is="expandedLayers.has(row.layer.id) ? ChevronDown : ChevronRight" class="size-3" /></button>
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
              <!-- Add effect: opens the kind menu anchored under this row. Group rows never
                   get one; a legacy unmigrated wired slot has no layer id to write an effect to.
                   Sits BEFORE the Delete block so the group/local delete v-if chain stays
                   contiguous — a v-if wedged between them would orphan the local delete. -->
              <button
                v-if="(row.kind === 'local' || row.kind === 'child' || row.kind === 'wired') && row.layer?.id"
                type="button" data-testid="add-effect" aria-label="Add effect or outline"
                class="shrink-0 opacity-0 group-hover/row:opacity-100 text-white/40 hover:text-white/80 cursor-pointer"
                :class="fxMenuLayerId === row.layer.id ? '!opacity-100' : ''"
                @click.stop="fxMenuLayerId === row.layer.id ? closeFxMenu() : openFxMenu(row.layer.id, $event)"
              ><Plus class="size-3.5" /></button>
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
          (pen.active.value || nodeEdit.active.value || (genActive && genTool === 'box') || regionSelectActive) ? 'cursor-crosshair' : ((genActive && genTool === 'brush' && !regionSelectActive) || brush.active.value || smartActive) ? 'cursor-none' : '',
          dropActive ? '!ring-2 !ring-white/70' : '',
        ]"
        @click="onCanvasClick"
        @pointerdown.capture="onCanvasPointerDownCapture"
        @pointermove="onCanvasPointerMoveCapture"
        @pointerup="onCanvasPointerUpCapture"
        @pointerleave="genCursor.on = false; smartCursor.on = false; brush.cursor.value = null"
        @dblclick.capture="onCanvasDblClickCapture"
        @contextmenu="onCanvasContextMenu"
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
        <!-- glimm prism sweep while a generation is running, clipped to the region (or, in
             whole-image Edit, the image) silhouette via a CSS mask. -->
        <canvas
          v-show="genActive || !!editImage"
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
          v-if="genActive && genTool === 'brush' && genCursor.on && !regionSelectActive"
          class="absolute pointer-events-none rounded-full border border-white/90 bg-white/10"
          :style="{ left: (genCursor.x - genBrush / 2) + 'px', top: (genCursor.y - genBrush / 2) + 'px', width: genBrush + 'px', height: genBrush + 'px', zIndex: 30 }"
        />
        <!-- Brush cursor ring (freehand paint) -->
        <div
          v-if="brush.active.value && brush.cursor.value"
          class="absolute pointer-events-none rounded-full border border-white/90 bg-white/10"
          :style="{ left: (brush.cursor.value.x * canvasDisplay.w - brush.sizePx.value / 2) + 'px', top: (brush.cursor.value.y * canvasDisplay.h - brush.sizePx.value / 2) + 'px', width: brush.sizePx.value + 'px', height: brush.sizePx.value + 'px', zIndex: 30 }"
        />

        <!-- Drag-to-generate on-box bar: prompt + style + Generate. Shown after a
             valid box is dragged, before generation; the mini toolbar below replaces
             it once a result exists. -->
        <div
          v-if="genGesture && genBarBnd && !genResult && !inpaint.busy.value"
          data-gen-bar
          data-testid="gen-onbox-bar"
          class="absolute z-40 -translate-x-1/2 flex items-center gap-1 bg-[#1a1a1a]/95 backdrop-blur-sm rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg"
          :style="genBarStyle"
          @pointerdown.stop @click.stop
        >
          <input
            ref="genPromptRef"
            v-model="genPrompt"
            type="text"
            data-testid="gen-onbox-prompt"
            placeholder="Describe the element…"
            class="h-8 w-44 rounded-[8px] bg-white/5 px-2 text-[12px] text-white/90 placeholder-white/35 outline-none focus:bg-white/10"
            @keydown.enter="genPrompt.trim() && runRegionFill()"
          />
          <div class="relative">
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-2 rounded-[8px] hover:bg-white/10 text-white/80 text-[11px] cursor-pointer whitespace-nowrap"
              title="Style"
              @click="stylePickerOpen = !stylePickerOpen"
            >
              <img v-if="genStyle?.coverUrl" :src="genStyle.coverUrl" class="size-4 rounded object-cover ring-1 ring-white/10" />
              <span class="max-w-24 truncate">{{ genStyle ? genStyle.name : 'No style' }}</span>
              <ChevronDown class="size-3 text-white/40" :class="stylePickerOpen ? 'rotate-180' : ''" />
            </button>
            <div v-if="stylePickerOpen" class="absolute bottom-full left-0 mb-1.5 z-50 w-52 max-h-56 overflow-y-auto rounded-md bg-neutral-900 border border-white/10 shadow-xl flex flex-col">
              <button class="px-3 py-2 text-left text-[12px] hover:bg-white/10 cursor-pointer"
                @click="genStyle = null; stylePickerOpen = false">No style</button>
              <button v-for="s in styleList.styles.value" :key="s.filename"
                class="px-3 py-2 text-left text-[12px] hover:bg-white/10 cursor-pointer flex items-center gap-2.5"
                @click="genStyle = s; stylePickerOpen = false">
                <img v-if="s.coverUrl" :src="s.coverUrl" class="size-6 rounded object-cover ring-1 ring-white/10" />
                <span class="truncate">{{ s.name }}</span>
              </button>
              <p v-if="!styleList.styles.value.length" class="px-3 py-2 text-[11px] text-white/30">
                {{ styleList.loading.value ? 'Loading…' : 'No trained styles yet.' }}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="gen-onbox-generate"
            class="flex items-center justify-center h-8 px-3 rounded-[8px] bg-white text-neutral-900 hover:bg-white/90 text-[12px] font-medium cursor-pointer disabled:opacity-40 disabled:cursor-default"
            :disabled="!genPrompt.trim() || inpaint.busy.value"
            @click="runRegionFill"
          >Generate</button>
        </div>

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

        <!-- Applied-edit toolbar: revert / re-roll / validate (whole-image + region) -->
        <div
          v-if="editResult"
          data-edit-result-bar
          class="absolute z-40 -translate-x-1/2 flex items-center gap-1 bg-[#1a1a1a]/95 backdrop-blur-sm rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg"
          :style="{ left: Math.min(Math.max((editResult.bnd.minX + editResult.bnd.maxX) / 2, 64), canvasDisplay.w - 64) + 'px', top: Math.min(editResult.bnd.maxY + 12, canvasDisplay.h - 44) + 'px' }"
          @pointerdown.stop @click.stop
        >
          <button data-testid="edit-result-revert" class="flex items-center justify-center size-8 rounded-[8px] hover:bg-white/10 text-white/80 cursor-pointer disabled:opacity-40 disabled:cursor-default" title="Revert to the original" :disabled="inpaint.busy.value" @click="revertEdit"><Undo2 class="size-4" /></button>
          <button data-testid="edit-result-reroll" class="flex items-center justify-center size-8 rounded-[8px] hover:bg-white/10 text-white/80 cursor-pointer disabled:opacity-40 disabled:cursor-default" title="Re-roll" :disabled="inpaint.busy.value" @click="rerollEdit"><RefreshCw class="size-4" :class="inpaint.busy.value ? 'animate-spin' : ''" /></button>
          <button data-testid="edit-result-validate" class="flex items-center justify-center size-8 rounded-[8px] bg-white text-neutral-900 hover:bg-white/90 cursor-pointer disabled:opacity-40 disabled:cursor-default" title="Validate" :disabled="inpaint.busy.value" @click="validateEdit"><Check class="size-4" /></button>
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
          <!-- In Edit image mode the selection outline animates as a pastel gradient stroke. -->
          <defs v-if="editImage">
            <linearGradient id="editStrokeGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#ffb3c7" />
              <stop offset="33%" stop-color="#ffd9a8" />
              <stop offset="66%" stop-color="#c3b8ff" />
              <stop offset="100%" stop-color="#a8ffe0" />
              <animateTransform attributeName="gradientTransform" type="rotate"
                values="0 0.5 0.5;360 0.5 0.5" dur="5s" repeatCount="indefinite" />
            </linearGradient>
          </defs>
          <polygon
            :points="`${localHandlePositions.tl.x},${localHandlePositions.tl.y} ${localHandlePositions.tr.x},${localHandlePositions.tr.y} ${localHandlePositions.br.x},${localHandlePositions.br.y} ${localHandlePositions.bl.x},${localHandlePositions.bl.y}`"
            fill="none" :stroke="editImage ? 'url(#editStrokeGrad)' : '#ffffff'"
            :stroke-width="editImage ? 2.5 : 2"
            vector-effect="non-scaling-stroke"
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

      <!-- Entry to inpaint mode is the right-click menu (Edit image / Edit a region
           / Select an object). Only THEN do the inpaint controls take over the main
           toolbar (see the toolbar's v-else below) — selecting an image alone does
           nothing to the toolbar, and there is no floating bar over the image. -->

      <!-- Edit PROMPT bar: while in inpaint mode the prompt sits just above the
           (swapped) main toolbar. The agent bar is hidden meanwhile, so this
           space is clear. -->
      <div v-if="editMode !== 'none' && !editResult"
        class="pointer-events-auto absolute bottom-[92px] left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-1.5"
        @pointerdown.stop @click.stop>
        <div v-if="editRegion && !genHasMask" class="text-[11px] text-white/60 bg-[#1a1a1a]/95 border border-[#2a2a2a] rounded-[8px] px-2 py-0.5">
          {{ regionSelectTool === 'box' ? 'Drag a box over the area to change.' : 'Paint over the area to change.' }}
        </div>
        <div v-if="inpaint.error.value" data-testid="edit-error"
          class="max-w-[360px] rounded bg-rose-950/95 border border-rose-500/30 px-2 py-1 text-[11px] text-rose-200 text-center shadow-lg">{{ inpaint.error.value }}</div>
        <div class="flex items-center gap-1 bg-[#1a1a1a]/95 backdrop-blur-sm rounded-[10px] p-1 border border-[#2a2a2a] shadow-lg">
          <button type="button" data-testid="edit-keep-style"
            role="checkbox" :aria-checked="keepStyle"
            class="flex items-center gap-1.5 h-8 pl-1.5 pr-2.5 rounded-[8px] text-[11px] cursor-pointer whitespace-nowrap ring-1 transition-colors"
            :class="keepStyle ? 'bg-white/20 text-white ring-white/25' : 'bg-transparent text-white/50 ring-white/10 hover:bg-white/[0.06]'"
            :title="keepStyle ? 'Keeping the original style — click to allow a restyle' : 'Restyle allowed — click to keep the original style'"
            @click="keepStyle = !keepStyle">
            <span class="flex size-3.5 items-center justify-center rounded-[4px] border transition-colors"
              :class="keepStyle ? 'border-white bg-white text-[#1a1a1a]' : 'border-white/40 text-transparent'">
              <svg viewBox="0 0 12 12" class="size-2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2 5 8.6 9.5 3.6" /></svg>
            </span>
            Keep style
          </button>
          <input ref="editPromptRef" type="text"
            :value="editImage ? editImagePrompt : regionPrompt"
            :data-testid="editImage ? 'edit-image-prompt' : 'edit-region-prompt'"
            :placeholder="editImage ? 'Describe the change…' : 'Describe what should appear there…'"
            class="h-8 w-72 rounded-[8px] bg-white/5 px-2 text-[12px] text-white/90 placeholder-white/35 outline-none focus:bg-white/10"
            @input="(e) => { const v = (e.target as HTMLInputElement).value; if (editImage) editImagePrompt = v; else regionPrompt = v }"
            @keydown.enter="editImage ? (editImagePrompt.trim() && !inpaint.busy.value && runImageEdit()) : (genHasMask && regionPrompt.trim() && !inpaint.busy.value && runRegionEdit())"
            @keydown.esc.stop.prevent="editImage ? editImageCancel() : editRegionCancel()" />
          <button type="button"
            :data-testid="editImage ? 'edit-image-run' : 'edit-region-run'"
            class="flex items-center justify-center h-8 px-3 rounded-[8px] bg-white text-neutral-900 hover:bg-white/90 text-[12px] font-medium cursor-pointer disabled:opacity-40 disabled:cursor-default whitespace-nowrap"
            :disabled="inpaint.busy.value || (editImage ? !editImagePrompt.trim() : (!genHasMask || !regionPrompt.trim()))"
            @click="editImage ? runImageEdit() : runRegionEdit()">
            {{ inpaint.busy.value ? (editImage ? 'Editing…' : 'Generating…') : (editImage ? 'Edit' : 'Generate') }}</button>
        </div>
      </div>

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
        v-show="editMode === 'none'"
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
        <!-- Select tool — hidden once an image is selected. Collapses out with the
             same tb-expand transition as the canvas tools, concurrently with the
             inpaint cluster expanding in, so the swap is one continuous morph. -->
        <Transition name="tb-expand">
        <div v-if="!showEditToolbar" class="tb-cluster">
        <div class="tb-cluster-inner flex items-center gap-1">
          <div class="w-px h-5 bg-white/10 mx-0.5" />
          <button
            class="flex items-center justify-center size-8 rounded cursor-pointer"
            :class="isSelectTool ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
            title="Select (V)" @click="selectTool">
            <MousePointer2 class="size-4" />
          </button>
        </div>
        </div>
        </Transition>
        <!-- Undo / redo — kept in inpaint mode too (take back a brush stroke). -->
        <div class="w-px h-5 bg-white/10 mx-0.5" />
        <button class="flex items-center justify-center size-8 rounded cursor-pointer disabled:opacity-30 hover:bg-white/10 text-white/80"
          title="Undo (⌘Z)" :disabled="!canUndo" @click="undo">
          <Undo2 class="size-4" />
        </button>
        <button class="flex items-center justify-center size-8 rounded cursor-pointer disabled:opacity-30 hover:bg-white/10 text-white/80"
          title="Redo (⌘⇧Z)" :disabled="!canRedo" @click="redo">
          <Redo2 class="size-4" />
        </button>
        <!-- Canvas tools — collapse out as the inpaint controls expand in. Both run
             the tb-expand transition at once, so it reads as one fluid handoff
             rather than a hard cut then a separate expand. -->
        <Transition name="tb-expand">
        <div v-if="!showEditToolbar" class="tb-cluster">
        <div class="tb-cluster-inner flex items-center gap-1">
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
        <!-- Generate: a top-level tool (a mode, not a stamp) — arms the drag-to-
             generate gesture; hold Option/Alt + drag does the same without the click. -->
        <button
          class="flex items-center justify-center size-8 rounded cursor-pointer"
          :class="genActive && genGesture ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
          data-testid="generate-tool-toggle"
          title="Generate an element (drag a box, or hold Option and drag)"
          @click="toggleGenGesture">
          <Wand2 class="size-4" />
        </button>
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
        </div>
        </div>
        </Transition>
        <!-- Inpaint controls: the modes + region tools + model take the tools' slot.
             They expand in (grid 0fr→1fr, so the buttons keep their real size) as
             the canvas tools swap out — see .tb-cluster in <style>. -->
        <Transition name="tb-expand">
        <div v-if="showEditToolbar" key="inpaint-cluster" class="tb-cluster">
        <div class="tb-cluster-inner flex items-center gap-1">
          <div class="w-px h-5 bg-white/10 mx-0.5" />
          <button type="button" data-testid="edit-mode-image"
            class="h-8 px-2.5 rounded text-[12px] cursor-pointer whitespace-nowrap"
            :class="editImage ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
            @click="editImageStart(editToolbarLayer!.id)">Edit image</button>
          <button type="button" data-testid="edit-mode-region"
            class="h-8 px-2.5 rounded text-[12px] cursor-pointer whitespace-nowrap"
            :class="editRegion ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
            @click="editRegionStart(editToolbarLayer!.id)">Edit an area</button>
          <button v-if="SMART_SELECT_ENABLED" type="button" data-testid="edit-mode-select"
            class="h-8 px-2.5 rounded text-[12px] cursor-pointer whitespace-nowrap"
            :class="smartActive ? 'bg-white text-neutral-900' : 'hover:bg-white/10 text-white/80'"
            @click="selectObjectStart(editToolbarLayer!.id)">Select an object</button>

          <!-- Area tools morph in the same way the cluster itself did (grid 0fr→1fr). -->
          <Transition name="tb-expand">
          <div v-if="editRegion" class="tb-cluster">
          <div class="tb-cluster-inner flex items-center gap-1">
            <div class="w-px h-5 bg-white/10 mx-0.5" />
            <button type="button" class="h-8 px-2 rounded text-[11px] cursor-pointer whitespace-nowrap"
              :class="regionSelectTool === 'box' ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-white/70'"
              @click="setRegionSelectTool('box')">Box</button>
            <button type="button" class="h-8 px-2 rounded text-[11px] cursor-pointer whitespace-nowrap"
              :class="regionSelectTool === 'brush' ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-white/70'"
              @click="setRegionSelectTool('brush')">Brush</button>
            <div v-if="regionSelectTool === 'brush'" class="flex items-center gap-1.5 px-1">
              <span class="text-[10px] text-white/40">Size</span>
              <input type="range" min="8" max="240" step="2" v-model.number="genBrush" class="w-24 accent-white cursor-pointer" />
            </div>
          </div>
          </div>
          </Transition>

          <!-- Model + close only once a mode is active; at plain selection the toolbar
               shows just the modes (pick one, then the model/prompt appear). Morphs
               in with the same grid 0fr→1fr expand as the cluster. -->
          <Transition name="tb-expand">
          <div v-if="editMode !== 'none'" class="tb-cluster">
          <div class="tb-cluster-inner flex items-center gap-1">
            <!-- Model — contextual: whole-image (FLUX.2/Nano/…) or area (FLUX Fill/…). -->
            <div class="w-px h-5 bg-white/10 mx-0.5" />
            <div class="relative">
              <button type="button" data-testid="edit-model-menu"
                class="flex items-center gap-1.5 h-8 px-2 rounded hover:bg-white/10 text-white/80 text-[11px] cursor-pointer whitespace-nowrap"
                title="Model" @click="modelMenuOpen = !modelMenuOpen">
                <span>{{ editModelLabel }}</span>
                <ChevronDown class="size-3 text-white/40" :class="modelMenuOpen ? 'rotate-180' : ''" />
              </button>
              <div v-if="modelMenuOpen" class="absolute bottom-full right-0 mb-1.5 z-50 w-56 rounded-md bg-neutral-900 border border-white/10 shadow-xl flex flex-col overflow-hidden">
                <button v-for="m in editModels" :key="m.value" type="button"
                  class="flex flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-white/10 cursor-pointer"
                  :class="m.value === editModelValue ? 'text-white' : 'text-white/70'"
                  @click="pickEditModel(m.value)">
                  <span class="text-[12px] leading-tight">{{ m.label }}</span>
                  <span class="text-[10.5px] leading-tight text-white/40">{{ m.hint }}</span>
                </button>
              </div>
            </div>

            <!-- Close inpaint mode back to plain selection. -->
            <div class="w-px h-5 bg-white/10 mx-0.5" />
            <button type="button" class="flex items-center justify-center size-8 rounded hover:bg-white/10 text-white/60 cursor-pointer"
              title="Done (Esc)" @click="editImageCancel(); editRegionCancel()"><X class="size-4" /></button>
          </div>
          </div>
          </Transition>
        </div>
        </div>
        </Transition>
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
        <!-- The Motion tab is ONE DialKit-style dock (MotionBandTimeline): transport +
             Add behaviour + Bake in its header, the gallery inside it, ruler, grouped rows.
             The legacy dial picker + dial timeline below stay in code (deleted in 6b) but
             only render behind `legacyMotionUi`. -->
        <div v-if="selectedLocal && legacyMotionUi" data-testid="dial-picker"
          class="glass-panel mb-2 rounded-lg border border-white/10 bg-[#0e0e10]/80 backdrop-blur-md shadow-lg px-3 py-2">
          <div class="text-[11px] font-medium text-white/60 mb-1.5">Animate a dial</div>
          <p v-if="!animatableDials.length" class="text-[11px] text-white/35">
            No animatable effect dials on this layer.
          </p>
          <div v-else class="flex flex-wrap gap-1.5">
            <button v-for="spec in animatableDials" :key="spec.path" type="button"
              :data-testid="'dial-add-' + dialTestKey(spec.path)"
              :aria-pressed="dialIsAnimated(spec.path)"
              class="flex items-center gap-1.5 h-7 px-2 rounded text-[11px] cursor-pointer whitespace-nowrap border transition-colors"
              :class="dialIsAnimated(spec.path)
                ? 'bg-white/15 text-white border-white/20'
                : 'text-white/70 border-white/10 hover:bg-white/10'"
              @click="toggleDialTrack(spec)">
              <span>{{ dialIsAnimated(spec.path) ? '✓' : '+' }}</span>
              <span>{{ spec.label }}</span>
            </button>
          </div>
        </div>

        <MotionBandTimeline
          :layers="localLayers" :selected-id="selectedLocal?.id ?? null"
          :motionx="motionxTracks" :behaviours="motionBehaviours"
          :duration="effectiveMotion.duration" :t="previewT"
          :selection="motionSel"
          :playing="playing" :fps="effectiveMotion.fps" :loop="effectiveMotion.loop ?? false"
          :baking="baking" :bake-progress="bakeProgress" :stale="motionStale" :bake-error="bakeError"
          :gallery-open="behaviourPickerOpen && !!selectedLocal"
          :property-picker-open="propertyPickerOpen && !!selectedLocal"
          @select="(id: string) => selectLocal(id)"
          @select-band="selectMotionBand" @select-point="selectMotionPoint" @select-behaviour="selectMotionBehaviour"
          @update:motionx="updateMotionx" @before-change="recordHistory"
          @scrub="scrubTo" @pause="pause" @play="play" @bake="bakeMotion"
          @update:motion="setMotion"
          @toggle-gallery="behaviourPickerOpen = !behaviourPickerOpen; if (behaviourPickerOpen) propertyPickerOpen = false"
          @toggle-property-picker="propertyPickerOpen = !propertyPickerOpen; if (propertyPickerOpen) behaviourPickerOpen = false"
          @behaviour-change="(id: string, p: { timing: { start?: number; duration?: number } }) => editBehaviour(id, p, false)"
          @behaviour-open="openBehaviour">
          <template #gallery>
            <MotionGallery :caps="motionLayerCaps" @add="onGalleryAdd" @close="behaviourPickerOpen = false" />
          </template>
          <template #property-picker>
            <MotionPropertyPicker :properties="selectedAnimatableProps" :animated-paths="animatedPropertyPaths"
              @add="addProperty" @close="propertyPickerOpen = false" />
          </template>
        </MotionBandTimeline>
        <CompositorMotionTimeline v-if="legacyMotionUi" class="mt-2"
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
          <button type="button" class="flex-1 rounded px-2 py-1 cursor-pointer" data-testid="layout-tab"
                  :class="inspectorTab === 'layout' ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                  @click="inspectorTab = 'layout'">Layout</button>
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

      <!-- Edit image / Edit a region no longer take over this panel — their modes
           and model live on the fixed edit toolbar, and the prompt on a floating
           bar over the area (see the stage overlay). -->

      <!-- Layout tab: the poster engine's sheet. Every tile arranges THIS frame's
           own elements (face, weight, colour, content untouched); click applies it
           as one undo step; Another re-rolls the seed; More narrows to one pattern. -->
      <template v-else-if="inspectorTab === 'layout'">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <LayoutGrid class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">{{ layoutSheet.focus.value ? 'More like this' : 'Frame layout' }}</span>
        </div>
        <div v-if="posterFaceEls.titleId" class="px-4 pt-3 flex flex-col gap-2">
          <div class="flex items-center gap-2 text-[11px] text-white/55">
            <span class="w-16 shrink-0">Title face</span>
            <div class="flex-1 min-w-0"><FontPicker :selected-key="titleFaceKey" :label="titleFaceFamily" sublabel="" @pick="onPickTitleFace" /></div>
          </div>
          <div v-if="hasTextRole" class="flex items-center gap-2 text-[11px] text-white/55">
            <span class="w-16 shrink-0">Text face</span>
            <div class="flex-1 min-w-0"><FontPicker :selected-key="textFaceKey" :label="textFaceFamily" sublabel="" @pick="onPickTextFace" /></div>
            <button type="button" data-testid="layout-suggest-face" class="h-7 px-2 shrink-0 rounded-[7px] ring-1 ring-white/10 bg-white/5 hover:bg-white/10 text-white/80" @click="onSuggestTextFace">Suggest</button>
          </div>
        </div>
        <div class="px-4 pt-3 flex items-center gap-2 text-[11px] text-white/55">
          <span class="shrink-0">Shape for the engine</span>
          <select data-testid="layout-shape-family" :value="layoutFamily"
            class="ml-auto h-7 rounded-[7px] ring-1 ring-white/10 bg-white/5 hover:bg-white/10 text-white/80 px-1.5 cursor-pointer outline-none"
            @change="pickLayoutFamily(($event.target as HTMLSelectElement).value)">
            <option value="">a shape…</option>
            <option v-for="f in SHAPE_FAMILIES" :key="f.id" :value="f.id">Any {{ f.label.toLowerCase() }}</option>
          </select>
          <button type="button" data-testid="layout-shape-trigger"
            class="flex items-center gap-1.5 h-7 px-2 shrink-0 rounded-[7px] ring-1 ring-white/10 bg-white/5 hover:bg-white/10 text-white/80"
            @click="openLayoutShape">
            {{ layoutShapeLabel }}
          </button>
        </div>
        <ShapePicker v-if="layoutShapeOpen"
          :model-value="layoutShapeValue" :anchor="layoutShapeAnchor" :ignore="layoutShapeTrigger"
          @update:model-value="pickLayoutShape" @close="layoutShapeOpen = false" />
        <div class="px-4 pt-3">
          <StudioSwitch :model-value="layoutSheet.imageMode.value" data-testid="layout-photo-moves"
            label="Photo moves" hint="Show photo layouts with a grey stand-in, even before you drop a photo."
            @update:model-value="layoutSheet.setImageMode" />
        </div>
        <div class="px-4 pt-3 space-y-1.5">
          <div class="flex items-center gap-2 text-[11px] text-white/55">
            <span class="shrink-0">Palette</span>
            <span v-if="layoutPaletteHexes" class="flex items-center gap-1 ml-1">
              <span v-for="(h, i) in layoutPaletteHexes" :key="i" class="size-3.5 rounded-sm ring-1 ring-white/10" :style="{ background: h }"></span>
            </span>
            <span v-else class="text-white/40 italic">Frame's own colours</span>
            <button v-if="layoutPaletteHexes" data-testid="layout-palette-clear"
              class="ml-auto h-6 px-2 shrink-0 rounded-[7px] ring-1 ring-white/10 bg-white/5 hover:bg-white/10 text-white/80" @click="clearLayoutPalette">Reset</button>
          </div>
          <PalettePicker mode="stops" data-testid="layout-palette" @apply-family="onLayoutPalette" @apply-stops="onLayoutPaletteStops" />
        </div>
        <div data-testid="layout-sheet" class="p-4 flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
          <p v-if="!layoutSheet.tiles.value.length" class="text-xs text-white/40 italic">Add a text layer to get layout options. The largest text is read as the title.</p>
          <template v-else>
            <p class="text-[11px] text-white/45">Your elements, arranged. Faces, weights and colours stay as you set them.</p>
            <div class="grid grid-cols-2 gap-3 justify-items-center">
              <LayoutTile
                v-for="t in layoutSheet.tiles.value" :key="t.patternId + ':' + t.seed"
                :plan="t.plan" :frame-w="canvasDisplay.w" :frame-h="canvasDisplay.h"
                :background="background" :groups="localGroups" :label="t.name"
                :wired-content="wiredContentForSlot"
                :selected="(compositor?.data?.properties as any)?.sailor_posterState?.patternId === t.patternId && (compositor?.data?.properties as any)?.sailor_posterState?.seed === t.seed"
                @pick="layoutSheet.apply(t)" @more="layoutSheet.moreLikeThis(t)"
              />
            </div>
            <div class="flex gap-2 pt-1">
              <StudioButton v-if="layoutSheet.focus.value" variant="secondary" class="flex-1" data-testid="layout-back" @click="layoutSheet.back()">All layouts</StudioButton>
              <StudioButton variant="secondary" class="flex-1" data-testid="layout-another" @click="layoutSheet.another()">Another</StudioButton>
            </div>
          </template>
        </div>
      </template>

      <template v-else-if="inspectorTab === 'motion'">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Play class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">{{ selectedLocal ? 'Layer motion' : 'Frame motion' }}</span>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-y-auto">
          <!-- Contextual motion inspector (Slice 2): shows the selected band's timing/easing
               or the selected control point's typed value editor. Decision A — right column. -->
          <MotionInspector v-if="motionSel"
            class="mb-3"
            :motionx="motionxTracks" :behaviours="motionBehaviours" :selection="motionSel"
            :duration="effectiveMotion.duration" :t="previewT"
            :label="motionSelLabel"
            @update:motionx="updateMotionx" @before-change="recordHistory"
            @select-point="selectMotionPoint" @clear="clearMotionSel"
            @behaviour-change="editBehaviour" @behaviour-open="openBehaviour" @behaviour-delete="deleteBehaviour" />
          <!-- Animate: make this still a looping, transparent clip. Lives in Motion (not
               Design) because it is how the layer moves — it composes with the keyframes below. -->
          <CompositorAnimatePanel v-if="selectedLocal?.kind === 'image'"
            :layer="selectedLocal as any"
            :busy="layerAnimate.busy.value"
            :error="layerAnimate.error.value"
            @generate="(o) => animateLayer(selectedLocal, o)"
            @speed="(v) => setClipSpeed(selectedLocal, v)"
            @remove="removeClip(selectedLocal)"
            @take="(t) => restoreTake(selectedLocal, t)"
          />
          <!-- Legacy In/Loop/Out preset editor (layer.animation). Replaced by behaviours
               (gallery In/Loop/Out); kept in code behind legacyMotionUi until 6b deletes it. -->
          <MotionLayerEditor v-if="selectedLocal && legacyMotionUi"
            :animation="(selectedLocal as any).animation" :frame-duration="effectiveMotion.duration"
            :layer-kind="selectedLocal.kind"
            @update="(a) => setLocal(selectedLocal!.id, { animation: a } as any)"
          />
          <!-- Empty state: the dock owns frame timing (dur/fps/loop) and Add behaviour;
               this panel is the contextual inspector for whatever is selected on it. -->
          <p v-else-if="!motionSel" class="text-xs text-white/40">
            {{ selectedLocal
              ? 'Select a band on the timeline to edit it, or add a behaviour from the timeline.'
              : 'Select a layer, then add a behaviour from the timeline.' }}
          </p>
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
          <StudioSlider v-model="smartBrush" label="Brush" :min="8" :max="240" :step="2" :bindable="false" />
          <div class="text-[11px]" :class="smart.failed.value ? 'text-amber-400' : 'text-white/40'">
            <template v-if="smart.busy.value">Refining selection…</template>
            <template v-else-if="smart.failed.value">Smart refine unavailable — using your scribble.</template>
            <template v-else-if="smart.maskUrl.value">Selection refined. Scribble to add, Alt-scribble to subtract.</template>
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
          <StudioSlider class="mb-2" v-model="brush.sizePx.value" label="Size" :min="2" :max="240" :step="1" :bindable="false" />
          <StudioSlider class="mb-2" v-model="brush.opacity.value" label="Flow" :min="0.05" :max="1" :step="0.05" :bindable="false" />
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
      <template v-else-if="activeTemplateInstance && activeTemplateInstanceTemplate && !activeEffect && !activeStroke">
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
      <!-- One effect, tuned on its own. Reached by selecting an effect row in the layer
           tree; the effect cards are gone from the layer view below, so the inspector
           shows the dials of exactly one INSTANCE — a second inner shadow edits itself,
           not the first one of its type. -->
      <template v-else-if="activeEffect">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-1.5 text-[11px] text-white/50" data-testid="effect-breadcrumb">
          <button type="button" class="truncate capitalize hover:text-white/80" @click="selectedEffect = null">{{ activeEffectLayer ? rowLabel({ layer: activeEffectLayer }) : 'Layer' }}</button>
          <ChevronRight class="size-3 shrink-0 opacity-60" />
          <span class="truncate text-white/80">{{ EFFECT_LABELS[activeEffect!.type] }}</span>
        </div>
        <div class="inspector-body p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
          <!-- Variable signal: which of this effect's dials are driven by a Motion-tab
               track. Authoring stays on the Motion tab; this is the primary per-effect
               "it's animated" cue, drawn in the motion accent (amber, as the timeline
               diamonds + playhead use). -->
          <div v-if="animatedDialKeys.size" data-testid="inspector-animated-dials"
            class="flex items-start gap-1.5 rounded-md border border-amber-400/25 bg-amber-400/10 px-2.5 py-1.5 text-[11px] leading-snug text-amber-300">
            <span class="shrink-0" aria-hidden="true">◆</span>
            <span>Animated: {{ animatedDialLabels.join(', ') }} — edit on the Motion tab</span>
          </div>
          <!-- The seven kinds PostEffectsControls already draws. `only` narrows it to the
               selected kind, and `effects` is the one instance, so its patch comes back as
               a single-entry array we write straight onto that id. -->
          <p v-if="activeEffect!.type === 'dof' && !activeEffectDepth" class="text-xs text-white/50"
            data-testid="effect-dof-no-depth">
            Depth of field needs an image with a depth map. Add it to an image layer, or
            generate depth for this one first.
          </p>
          <!-- PostEffectsControls is a packaged panel (not per-row editable from here), so a
               driven dial is signalled + delegated with a shared wrapper: a compact ◆ marker
               and the panel muted + non-interactive (a driven dial must not read as a freely
               editable static value — the track wins at paint). -->
          <div v-else-if="isPanelKind(activeEffect!.type)">
            <div v-if="animatedDialKeys.size" data-testid="effect-panel-dial-lock"
              class="mb-2 inline-flex items-center gap-1 text-[10px] text-amber-300"
              title="Animated — edit on the Motion tab timeline">
              <span aria-hidden="true">◆</span><span>Animated</span>
            </div>
            <div :class="animatedDialKeys.size ? 'opacity-50 pointer-events-none select-none' : ''"
              :title="animatedDialKeys.size ? 'Animated — edit on the Motion tab timeline' : undefined">
              <PostEffectsControls
                :effects="([activeEffect] as any)"
                :only="([activeEffect!.type] as any)"
                :depth-source="activeEffectDepth"
                :hide-toggle="true"
                @update="(fx: any[]) => { const n = fx[0]; if (n) updateActiveEffect(n) }" />
            </div>
          </div>

          <!-- Drop shadow (per-dial: a driven dial is marked ◆ + disabled, edit on Motion tab) -->
          <div v-else-if="activeEffect!.type === 'drop_shadow'" class="space-y-1.5">
            <div class="flex items-center gap-1.5"
              :class="animatedDialKeys.has('color') ? 'opacity-50' : ''"
              :title="animatedDialKeys.has('color') ? 'Animated — edit on the Motion tab timeline' : undefined">
              <span v-if="animatedDialKeys.has('color')" class="text-amber-300 text-[10px] shrink-0" aria-hidden="true">◆</span>
              <input type="color" :value="activeFxHex" title="Shadow color"
                :disabled="animatedDialKeys.has('color')"
                :class="animatedDialKeys.has('color') ? 'pointer-events-none' : ''"
                class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                @input="updateActiveEffect({ color: composeRgba(($event.target as HTMLInputElement).value, activeFxAlpha) })" />
              <input type="text" spellcheck="false" maxlength="7" :value="activeFxHex" title="Hex color"
                :disabled="animatedDialKeys.has('color')"
                :class="animatedDialKeys.has('color') ? 'pointer-events-none' : ''"
                class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                @change="setActiveFxHex(($event.target as HTMLInputElement).value)" />
              <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Shadow opacity (alpha)">
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(activeFxAlpha * 100)"
                  :disabled="animatedDialKeys.has('color')"
                  :class="animatedDialKeys.has('color') ? 'pointer-events-none' : ''"
                  class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                  @input="updateActiveEffect({ color: composeRgba(activeFxHex, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                <span class="text-[10px] text-white/35 select-none">%</span>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <div :class="animatedDialKeys.has('x') ? 'opacity-50' : ''">
                <div class="panel-sublabel mb-1">X<span v-if="animatedDialKeys.has('x')" class="ml-1 text-amber-300" title="Animated — edit on the Motion tab timeline" aria-hidden="true">◆</span></div>
                <input v-scrubnum type="number" step="0.5" :value="Math.round(((activeEffect as any).x || 0) * 1000) / 10"
                  :disabled="animatedDialKeys.has('x')"
                  :class="animatedDialKeys.has('x') ? 'pointer-events-none' : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ x: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
              </div>
              <div :class="animatedDialKeys.has('y') ? 'opacity-50' : ''">
                <div class="panel-sublabel mb-1">Y<span v-if="animatedDialKeys.has('y')" class="ml-1 text-amber-300" title="Animated — edit on the Motion tab timeline" aria-hidden="true">◆</span></div>
                <input v-scrubnum type="number" step="0.5" :value="Math.round(((activeEffect as any).y || 0) * 1000) / 10"
                  :disabled="animatedDialKeys.has('y')"
                  :class="animatedDialKeys.has('y') ? 'pointer-events-none' : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ y: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
              </div>
              <div :class="animatedDialKeys.has('blur') ? 'opacity-50' : ''">
                <div class="panel-sublabel mb-1">Blur<span v-if="animatedDialKeys.has('blur')" class="ml-1 text-amber-300" title="Animated — edit on the Motion tab timeline" aria-hidden="true">◆</span></div>
                <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).blur || 0) * 1000) / 10"
                  :disabled="animatedDialKeys.has('blur')"
                  :class="animatedDialKeys.has('blur') ? 'pointer-events-none' : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ blur: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
              </div>
            </div>
          </div>

          <!-- Inner shadow (per-dial: a driven dial is marked ◆ + disabled, edit on Motion tab) -->
          <div v-else-if="activeEffect!.type === 'inner_shadow'" class="space-y-1.5">
            <div class="flex items-center gap-1.5"
              :class="animatedDialKeys.has('color') ? 'opacity-50' : ''"
              :title="animatedDialKeys.has('color') ? 'Animated — edit on the Motion tab timeline' : undefined">
              <span v-if="animatedDialKeys.has('color')" class="text-amber-300 text-[10px] shrink-0" aria-hidden="true">◆</span>
              <input type="color" :value="activeFxHex" title="Shadow color"
                :disabled="animatedDialKeys.has('color')"
                :class="animatedDialKeys.has('color') ? 'pointer-events-none' : ''"
                class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                @input="updateActiveEffect({ color: composeRgba(($event.target as HTMLInputElement).value, activeFxAlpha) })" />
              <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Shadow opacity (alpha)">
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(activeFxAlpha * 100)"
                  :disabled="animatedDialKeys.has('color')"
                  :class="animatedDialKeys.has('color') ? 'pointer-events-none' : ''"
                  class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                  @input="updateActiveEffect({ color: composeRgba(activeFxHex, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                <span class="text-[10px] text-white/35 select-none">%</span>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <div :class="animatedDialKeys.has('x') ? 'opacity-50' : ''">
                <div class="panel-sublabel mb-1">X<span v-if="animatedDialKeys.has('x')" class="ml-1 text-amber-300" title="Animated — edit on the Motion tab timeline" aria-hidden="true">◆</span></div>
                <input v-scrubnum type="number" step="0.5" :value="Math.round(((activeEffect as any).x || 0) * 1000) / 10"
                  :disabled="animatedDialKeys.has('x')"
                  :class="animatedDialKeys.has('x') ? 'pointer-events-none' : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ x: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
              </div>
              <div :class="animatedDialKeys.has('y') ? 'opacity-50' : ''">
                <div class="panel-sublabel mb-1">Y<span v-if="animatedDialKeys.has('y')" class="ml-1 text-amber-300" title="Animated — edit on the Motion tab timeline" aria-hidden="true">◆</span></div>
                <input v-scrubnum type="number" step="0.5" :value="Math.round(((activeEffect as any).y || 0) * 1000) / 10"
                  :disabled="animatedDialKeys.has('y')"
                  :class="animatedDialKeys.has('y') ? 'pointer-events-none' : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ y: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
              </div>
              <div :class="animatedDialKeys.has('blur') ? 'opacity-50' : ''">
                <div class="panel-sublabel mb-1">Blur<span v-if="animatedDialKeys.has('blur')" class="ml-1 text-amber-300" title="Animated — edit on the Motion tab timeline" aria-hidden="true">◆</span></div>
                <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).blur || 0) * 1000) / 10"
                  :disabled="animatedDialKeys.has('blur')"
                  :class="animatedDialKeys.has('blur') ? 'pointer-events-none' : ''"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ blur: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
              </div>
            </div>
          </div>

          <!-- Layer blur (Radius is the sole dial — marked ◆ + disabled when animated) -->
          <div v-else-if="activeEffect!.type === 'layer_blur'" class="flex items-center gap-2"
            :class="animatedDialKeys.has('radius') ? 'opacity-50' : ''"
            :title="animatedDialKeys.has('radius') ? 'Animated — edit on the Motion tab timeline' : undefined">
            <div class="panel-sublabel shrink-0">Radius<span v-if="animatedDialKeys.has('radius')" class="ml-1 text-amber-300" aria-hidden="true">◆</span></div>
            <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).radius || 0) * 1000) / 10"
              :disabled="animatedDialKeys.has('radius')"
              :class="animatedDialKeys.has('radius') ? 'pointer-events-none' : ''"
              class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="updateActiveEffect({ radius: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
          </div>

          <!-- Background blur (blurs what's behind the layer, inside its shape) -->
          <div v-else-if="activeEffect!.type === 'background_blur'" class="flex items-center gap-2"
            :class="animatedDialKeys.has('radius') ? 'opacity-50' : ''"
            :title="animatedDialKeys.has('radius') ? 'Animated — edit on the Motion tab timeline' : undefined">
            <div class="panel-sublabel shrink-0">Radius<span v-if="animatedDialKeys.has('radius')" class="ml-1 text-amber-300" aria-hidden="true">◆</span></div>
            <input v-scrubnum type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).radius || 0) * 1000) / 10"
              :disabled="animatedDialKeys.has('radius')"
              :class="animatedDialKeys.has('radius') ? 'pointer-events-none' : ''"
              class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="updateActiveEffect({ radius: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
          </div>

          <!-- Torn paper edge and feather: the panels take the whole spec as `value`, and the
               instance IS the spec (plus type/visible/id), so it can be handed over as-is.
               No @toggle — the tree row's eye owns visibility and its trash owns removal. -->
          <CompositorTornEdgePanel
            v-else-if="activeEffect!.type === 'torn_edge'"
            :value="(activeEffect as any)"
            :hide-toggle="true"
            @update="(patch: any) => updateActiveEffect(patch)" />
          <CompositorFeatherPanel
            v-else-if="activeEffect!.type === 'feather'"
            :value="(activeEffect as any)"
            :hide-toggle="true"
            @update="(patch: any) => updateActiveEffect(patch)" />

          <!-- Geometry effects (F2): each dial writes a param `applyGeometry` reads, so none
               are dead. Start/End/Offset are fractions of the outline's length (shown as %);
               Distance/Radius/Amount are normalized to canvas width (shown ×100 like the
               shadow offsets). -->
          <!-- Trim path -->
          <div v-else-if="activeEffect!.type === 'trim'" class="space-y-1.5">
            <div class="grid grid-cols-3 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Start</div>
                <input v-scrubnum data-testid="geo-trim-start" type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).start || 0) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ start: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">End</div>
                <input v-scrubnum data-testid="geo-trim-end" type="number" min="0" max="100" step="1" :value="Math.round((((activeEffect as any).end ?? 1)) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ end: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Offset</div>
                <input v-scrubnum data-testid="geo-trim-offset" type="number" min="-100" max="100" step="1" :value="Math.round(((activeEffect as any).offset || 0) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ offset: Math.min(1, Math.max(-1, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
            </div>
          </div>

          <!-- Offset path (grow positive / shrink negative, normalized to width) -->
          <div v-else-if="activeEffect!.type === 'offset'" class="flex items-center gap-2">
            <div class="panel-sublabel shrink-0">Distance</div>
            <input v-scrubnum data-testid="geo-offset-distance" type="number" step="0.5" :value="Math.round(((activeEffect as any).distance || 0) * 1000) / 10"
              class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="updateActiveEffect({ distance: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
          </div>

          <!-- Round corners -->
          <div v-else-if="activeEffect!.type === 'round_corners'" class="flex items-center gap-2">
            <div class="panel-sublabel shrink-0">Radius</div>
            <input v-scrubnum data-testid="geo-round-radius" type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).radius || 0) * 1000) / 10"
              class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="updateActiveEffect({ radius: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
          </div>

          <!-- Roughen -->
          <div v-else-if="activeEffect!.type === 'roughen'" class="space-y-1.5">
            <div class="grid grid-cols-3 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Amount</div>
                <input v-scrubnum data-testid="geo-roughen-amount" type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).amount || 0) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ amount: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Detail</div>
                <input v-scrubnum data-testid="geo-roughen-detail" type="number" min="1" max="32" step="1" :value="Math.round((activeEffect as any).detail ?? 8)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ detail: Math.min(32, Math.max(1, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 8))) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Seed</div>
                <input v-scrubnum data-testid="geo-roughen-seed" type="number" step="1" :value="Math.round((activeEffect as any).seed ?? 1)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ seed: Math.round(parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
              </div>
            </div>
          </div>

          <!-- Combine shapes (boolean, F3): the op select + a dynamic sibling picker. Both feed
               `applyGeometry`'s boolean case — the op runs the paper.js boolean, the picker
               writes `refLayerId` (the sibling rail). Neither is a dead control. -->
          <div v-else-if="activeEffect!.type === 'boolean'" class="space-y-1.5">
            <div>
              <div class="panel-sublabel mb-1">Operation</div>
              <select data-testid="geo-boolean-op"
                :value="(activeEffect as any).op || 'unite'"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @change="updateActiveEffect({ op: ($event.target as HTMLSelectElement).value })">
                <option v-for="op in ['unite', 'subtract', 'intersect', 'exclude']" :key="op" :value="op">{{ BOOLEAN_OP_LABELS[op] }}</option>
              </select>
            </div>
            <div>
              <div class="panel-sublabel mb-1">Combine with</div>
              <select data-testid="geo-boolean-ref"
                :value="(activeEffect as any).refLayerId || ''"
                :disabled="geometrySiblingCandidates.length === 0"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                @change="updateActiveEffect({ refLayerId: ($event.target as HTMLSelectElement).value || undefined })">
                <option value="">None</option>
                <option v-for="c in geometrySiblingCandidates" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
              <p v-if="geometrySiblingReason" class="mt-1 text-[11px] text-white/50" data-testid="geo-boolean-reason">{{ geometrySiblingReason }}</p>
            </div>
          </div>

          <!-- Morph to shape (F3): an amount slider + the same dynamic sibling picker. Amount
               feeds `applyGeometry`'s morph case (blend toward the sibling), the picker writes
               `refLayerId` (the shared sibling rail). Neither is a dead control; there is no
               twist dial — the plan is amount-only. -->
          <div v-else-if="activeEffect!.type === 'morph'" class="space-y-1.5">
            <div class="flex items-center gap-2">
              <div class="panel-sublabel shrink-0">Amount</div>
              <input v-scrubnum data-testid="geo-morph-amount" type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).amount ?? 0.5) * 100)"
                class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ amount: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Morph to shape</div>
              <select data-testid="geo-morph-ref"
                :value="(activeEffect as any).refLayerId || ''"
                :disabled="geometrySiblingCandidates.length === 0"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                @change="updateActiveEffect({ refLayerId: ($event.target as HTMLSelectElement).value || undefined })">
                <option value="">None</option>
                <option v-for="c in geometrySiblingCandidates" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
              <p v-if="geometrySiblingReason" class="mt-1 text-[11px] text-white/50" data-testid="geo-morph-reason">{{ geometrySiblingReason }}</p>
            </div>
          </div>

          <!-- Warp (F3): a field picker + an amount dial; the wave field adds a frequency. Every
               control shown here is read by `applyGeometry`'s warp case (bbox-relative outline
               displacement in `meshWarp.ts`) — the frequency row appears ONLY for the wave field,
               which is the only field that reads it, so there is no dead control. Self-only: no
               sibling picker. Amount is shown ×100 like the other width-normalized geometry dials. -->
          <div v-else-if="activeEffect!.type === 'warp'" class="space-y-1.5">
            <div>
              <div class="panel-sublabel mb-1">Style</div>
              <select data-testid="geo-warp-field"
                :value="(activeEffect as any).field || 'bulge'"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @change="updateActiveEffect({ field: ($event.target as HTMLSelectElement).value })">
                <option v-for="f in ['bulge', 'pinch', 'wave', 'twist']" :key="f" :value="f">{{ WARP_FIELD_LABELS[f] }}</option>
              </select>
            </div>
            <div class="flex items-center gap-2">
              <div class="panel-sublabel shrink-0">Amount</div>
              <input v-scrubnum data-testid="geo-warp-amount" type="number" step="0.5" :value="Math.round(((activeEffect as any).amount ?? 0.3) * 1000) / 10"
                class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ amount: (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100 })" />
            </div>
            <div v-if="(activeEffect as any).field === 'wave'" class="flex items-center gap-2">
              <div class="panel-sublabel shrink-0">Frequency</div>
              <input v-scrubnum data-testid="geo-warp-frequency" type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).frequency ?? 3) * 10) / 10"
                class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ frequency: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
            </div>
          </div>

          <!-- Long shadow (F3): an angle dial, a length dial and a colour card. Angle steers the
               cast direction, length is the reach (width-normalized, shown ×100 like offset), and
               the colour card (shared `activeFxHex`/`activeFxAlpha`/`composeRgba`, same as drop
               shadow) tints the solid body painted beneath the shape. Every control is read by the
               body paint in `drawLayerContent` — no dead control. Self-only: no sibling picker. -->
          <div v-else-if="activeEffect!.type === 'long_shadow'" class="space-y-1.5">
            <div class="flex items-center gap-1.5">
              <input type="color" :value="activeFxHex" title="Shadow color"
                class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                @input="updateActiveEffect({ color: composeRgba(($event.target as HTMLInputElement).value, activeFxAlpha) })" />
              <input type="text" spellcheck="false" maxlength="7" :value="activeFxHex" title="Hex color"
                class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                @change="setActiveFxHex(($event.target as HTMLInputElement).value)" />
              <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Shadow opacity (alpha)">
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(activeFxAlpha * 100)"
                  class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                  @input="updateActiveEffect({ color: composeRgba(activeFxHex, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                <span class="text-[10px] text-white/35 select-none">%</span>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Angle</div>
                <input v-scrubnum data-testid="geo-long-shadow-angle" type="number" step="1" :value="Math.round((activeEffect as any).angle ?? 45)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ angle: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Length</div>
                <input v-scrubnum data-testid="geo-long-shadow-length" type="number" min="0" step="0.5" :value="Math.round(((activeEffect as any).length ?? 0.05) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ length: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
              </div>
            </div>
          </div>

          <!-- Shatter (F3): cells + gap + seed, mirroring the roughen 3-dial grid. Cells sets the
               fragment count, gap the inward shrink between shards (width-normalized, shown ×100
               like offset), seed the deterministic scatter. Every dial is read by `applyGeometry`'s
               shatter case (Voronoi cells clipped to the outline in `geometryEffects.applyShatter`)
               — no dead control. Self-only: no sibling picker. -->
          <div v-else-if="activeEffect!.type === 'shatter'" class="space-y-1.5">
            <div class="grid grid-cols-3 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Cells</div>
                <input v-scrubnum data-testid="geo-shatter-cells" type="number" min="1" max="96" step="1" :value="Math.round((activeEffect as any).cells ?? 12)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ cells: Math.min(96, Math.max(1, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 12))) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Gap</div>
                <input v-scrubnum data-testid="geo-shatter-gap" type="number" min="0" step="0.1" :value="Math.round(((activeEffect as any).gap ?? 0.004) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ gap: Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Seed</div>
                <input v-scrubnum data-testid="geo-shatter-seed" type="number" step="1" :value="Math.round((activeEffect as any).seed ?? 1)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ seed: Math.round(parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
              </div>
            </div>
          </div>

          <!-- Shader (F5) + Backdrop shader (F6): ONE inspector serves both, because they carry
               the identical effectId/params/speed/seed shape and every helper this block uses
               (activeShaderEffectId, activeShaderEffectDef, shaderFxParamRows, setShaderFxParam,
               shaderFxParamValue, shaderFxPickerItems — filtered to effectReadsInput —
               updateActiveEffect, the Speed slider) reads `activeEffect` generically. They differ
               only in WHAT the picked catalog effect processes:
                 • `shader` (F5) runs the effect over this layer's OWN already-rendered pixels —
                   a GPU pass (applyShaderPixelEffect, useCompositorLayers.ts), not a fill.
                 • `backdrop_shader` (F6) runs the same effect over the LAYERS BEHIND this one
                   (an additive backdrop treatment stamped under the layer, via withBackdrop).
               Picker → derived param dials → Speed, the same picker/dials shape ShaderFillEditor.vue
               uses for a shader FILL, minus the fill-only anchor toggle and nested input-fill editor
               (there is no separate Input paint here to anchor or blend — the input is the layer's
               own pixels for `shader`, the backdrop for `backdrop_shader`). The picker is filtered
               to effectReadsInput effects only: a purely generative pick would overwrite the input
               instead of processing it. -->
          <div v-else-if="activeEffect!.type === 'shader' || activeEffect!.type === 'backdrop_shader'" class="space-y-2.5" data-testid="shader-fx-inspector">
            <div>
              <div class="mb-1 flex items-center justify-between gap-2">
                <label class="block panel-label">Effect</label>
                <button
                  v-if="shaderFxCatalog && !activeShaderEffectDef"
                  type="button"
                  title="Retry loading this effect"
                  class="nopan nodrag flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
                  @click="loadShaderFxCatalog"
                ><RefreshCw class="size-2.5" :stroke-width="2" /> Retry</button>
              </div>
              <button
                type="button" data-testid="shader-fx-picker"
                class="flex w-full cursor-pointer items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                @click="openShaderFxPicker"
              >
                <Sparkles class="size-3.5 shrink-0 text-white/60" :stroke-width="1.75" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[11px] font-medium leading-tight text-white/90" data-testid="shader-fx-effect-name">{{ activeShaderEffectDef?.name ?? activeShaderEffectId }}</span>
                  <span v-if="activeShaderEffectDef" class="block truncate text-[10px] leading-tight text-white/40">{{ shaderFxTitleCase(activeShaderEffectDef.category) }}</span>
                </span>
                <ChevronRight class="size-3.5 shrink-0 text-white/30" />
              </button>
            </div>

            <!-- Effect params (derived per catalog effect). A hairline rules the colour
                 params off from the shape/number ones wherever the two meet — same layout
                 ShaderFillEditor uses for a shader fill's dials. -->
            <div
              v-for="(row, i) in shaderFxParamRows" :key="row.key"
              :data-testid="`shader-fx-param-${row.key}`"
              :class="shaderFxDividesAbove(i) ? 'border-t border-white/[0.06] pt-2.5' : ''"
            >
              <template v-if="row.kind === 'select'">
                <StudioSelect
                  :label="row.label"
                  :options="(row.options ?? []).map((o) => String(o.value))"
                  :option-labels="(row.options ?? []).map((o) => o.label)"
                  :model-value="String(shaderFxParamValue(row))"
                  @update:model-value="(v: string) => setShaderFxParam(row.key, Number(v))"
                />
              </template>
              <template v-else-if="row.kind === 'color'">
                <StudioColorField
                  :label="row.label"
                  :model-value="shaderFxColorValue(row)"
                  @update:model-value="(v: string) => setShaderFxParam(row.key, v)"
                />
              </template>
              <template v-else-if="row.kind === 'gradientStops'">
                <label class="mb-1 block panel-label">{{ row.label }}</label>
                <div class="mb-1.5 h-5 overflow-hidden rounded border border-white/10" :style="{ background: shaderFxRampCss(shaderFxStopsValue(row)) }" />
                <div class="mb-2 flex flex-col gap-1">
                  <div v-for="(s, si) in shaderFxStopsValue(row)" :key="si" class="flex items-center gap-2">
                    <StudioColor :model-value="s.color" @update:model-value="(c: string) => editShaderFxRowStopColor(row, si, c)" />
                    <div class="min-w-0 flex-1">
                      <StudioSlider :model-value="Math.round(s.pos * 100)" @update:model-value="(v: number) => editShaderFxRowStopPos(row, si, v / 100)"
                        :min="0" :max="100" :step="1" :bindable="false" />
                    </div>
                    <button class="shrink-0 rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/70 disabled:opacity-20"
                      :disabled="shaderFxStopsValue(row).length <= 2" title="Remove ink" @click="removeShaderFxRowStop(row, si)"><Trash2 :size="12" /></button>
                  </div>
                  <button class="mt-0.5 flex items-center justify-center gap-1 rounded border border-dashed border-white/15 py-1 text-[11px] text-white/50 hover:border-white/30 hover:text-white/80 disabled:opacity-30"
                    :disabled="shaderFxStopsValue(row).length >= (row.maxStops ?? 8)" @click="addShaderFxRowStop(row)"><Plus :size="12" /> Add ink</button>
                </div>
                <button
                  class="flex w-full items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 transition hover:bg-white/[0.08] hover:text-white/90"
                  @click="toggleShaderFxPicker(row.key)"
                >
                  <Palette :size="12" class="shrink-0 opacity-70" />
                  <span>Generate a palette</span>
                  <ChevronRight :size="12" class="ml-auto shrink-0 opacity-60 transition-transform" :class="shaderFxOpenPickers[row.key] ? 'rotate-90' : ''" />
                </button>
                <div v-if="shaderFxOpenPickers[row.key]" class="mt-1.5 rounded border border-white/10 bg-white/[0.02] p-2">
                  <PalettePicker
                    mode="stops" manual-stops
                    :stop-count="shaderFxStopsValue(row).length || 3"
                    :seed="shaderFxStopsValue(row)[0]?.color ?? '#4f8ad9'"
                    @apply-stops="(v: GradientStop[]) => applyShaderFxRowStops(row, v)"
                    @apply-literal-stops="(v: GradientStop[]) => applyShaderFxRowStops(row, v)"
                  />
                </div>
              </template>
              <StudioSlider
                v-else
                :model-value="shaderFxParamValue(row)"
                :label="row.label" :min="row.min ?? 0" :max="row.max ?? 1" :step="row.step ?? 0.01" :default="Number(row.default)"
                @update:model-value="(v: number) => setShaderFxParam(row.key, v)"
              />
            </div>

            <!-- Speed: the one non-param control — no anchor, no nested input fill (this is a
                 pass over the layer's own pixels, not a fill with its own Input paint). -->
            <StudioSlider
              data-testid="shader-fx-speed"
              :model-value="(activeEffect as any).speed ?? 1"
              label="Speed" :min="0" :max="4" :step="0.05" :default="1"
              @update:model-value="(v: number) => updateActiveEffect({ speed: v })"
            />

            <CatalogModal
              :open="shaderFxPickerOpen"
              title="Shader effects"
              :subtitle="activeEffect!.type === 'backdrop_shader' ? 'Pick an effect to treat the layers behind this one' : 'Pick an effect to process this layer\'s pixels'"
              :items="shaderFxPickerItems"
              :selected-id="resolveEffectId(activeShaderEffectId)"
              :filters="shaderFxPickerFilters"
              :active-filter-id="shaderFxPickerFilter"
              :search-query="shaderFxPickerSearch"
              search-placeholder="Search effects…"
              confirm-label="Use effect"
              empty-message="No effects match your search."
              @close="shaderFxPickerOpen = false"
              @confirm="pickShaderFxEffect(($event as EffectDef).id)"
              @update:active-filter-id="shaderFxPickerFilter = $event"
              @update:search-query="shaderFxPickerSearch = $event"
            >
              <template #card="{ item }">
                <div class="flex aspect-video items-center justify-center bg-white/[0.03]">
                  <Sparkles class="size-5 text-white/25" :stroke-width="1.5" />
                </div>
                <div class="px-2 py-1.5">
                  <div class="truncate text-[11px] text-white/85">{{ (item as EffectDef).name }}</div>
                  <div class="truncate text-[10px] capitalize text-white/35">{{ (item as EffectDef).category }}</div>
                </div>
              </template>
            </CatalogModal>
          </div>

          <!-- Backdrop luminance mask (F6): masks the layer's OWN content by the luminance of the
               backdrop painted behind it — reveals where the backdrop is bright (lum ≥ threshold),
               hides where dark; Softness feathers the cut-over; Invert flips it. Pure CPU, three
               controls, all read by applyBackdropLuminanceMask — no dead control. -->
          <div v-else-if="activeEffect!.type === 'backdrop_luminance_mask'" class="space-y-1.5">
            <p class="text-xs text-white/50">Reveals the layer where the backdrop behind it is bright; invert to reveal over dark areas.</p>
            <StudioSlider
              data-testid="lum-mask-threshold"
              label="Threshold"
              :min="0" :max="1" :step="0.01" :default="0.5"
              :model-value="(activeEffect as any).threshold ?? 0.5"
              @update:model-value="(v: number) => updateActiveEffect({ threshold: v })"
            />
            <StudioSlider
              data-testid="lum-mask-softness"
              label="Softness"
              :min="0" :max="1" :step="0.01" :default="0.25"
              :model-value="(activeEffect as any).softness ?? 0.25"
              @update:model-value="(v: number) => updateActiveEffect({ softness: v })"
            />
            <label class="flex items-center justify-between gap-2 panel-label">Invert
              <input type="checkbox" class="accent-white/80" data-testid="lum-mask-invert"
                :checked="!!(activeEffect as any).invert"
                @change="(e) => updateActiveEffect({ invert: (e.target as HTMLInputElement).checked })">
            </label>
          </div>

          <!-- Print recipe · Risograph (F7): flat limited-ink bands on paper, expanded at paint time
               into contrast → posterise → riso ramp → grain. Two inks, band count, grain and
               contrast — every dial is read by expandRecipe, no dead control. -->
          <div v-else-if="activeEffect!.type === 'risograph'" class="space-y-1.5">
            <p class="text-xs text-white/50">Flat ink bands on paper, like a risograph print.</p>
            <StudioColorField
              data-testid="riso-ink"
              label="Ink"
              :model-value="(activeEffect as any).ink ?? '#2b3a8c'"
              @update:model-value="(v: string) => updateActiveEffect({ ink: v })"
            />
            <StudioColorField
              data-testid="riso-ink-two"
              label="Second ink"
              :model-value="(activeEffect as any).inkTwo ?? '#e03a6d'"
              @update:model-value="(v: string) => updateActiveEffect({ inkTwo: v })"
            />
            <StudioSlider
              data-testid="riso-levels"
              label="Levels"
              :min="2" :max="8" :step="1" :default="4"
              :model-value="(activeEffect as any).levels ?? 4"
              @update:model-value="(v: number) => updateActiveEffect({ levels: v })"
            />
            <StudioSlider
              data-testid="riso-grain"
              label="Grain"
              :min="0" :max="1" :step="0.01" :default="0.16"
              :model-value="(activeEffect as any).grain ?? 0.16"
              @update:model-value="(v: number) => updateActiveEffect({ grain: v })"
            />
            <StudioSlider
              data-testid="riso-contrast"
              label="Contrast"
              :min="0.5" :max="2" :step="0.01" :default="1.12"
              :model-value="(activeEffect as any).contrast ?? 1.12"
              @update:model-value="(v: number) => updateActiveEffect({ contrast: v })"
            />
          </div>

          <!-- Print recipe · Photocopy (F7): harsh 1-bit crush with dirt, expanded into contrast →
               threshold → ink bleed + rough edge → grain. Threshold, dirt and contrast are all read
               by expandRecipe — no dead control. -->
          <div v-else-if="activeEffect!.type === 'photocopy'" class="space-y-1.5">
            <p class="text-xs text-white/50">Harsh high-contrast black and white, like a photocopy.</p>
            <StudioSlider
              data-testid="pc-threshold"
              label="Threshold"
              :min="0" :max="1" :step="0.01" :default="0.5"
              :model-value="(activeEffect as any).threshold ?? 0.5"
              @update:model-value="(v: number) => updateActiveEffect({ threshold: v })"
            />
            <StudioSlider
              data-testid="pc-dirt"
              label="Dirt"
              :min="0" :max="1" :step="0.01" :default="0.2"
              :model-value="(activeEffect as any).dirt ?? 0.2"
              @update:model-value="(v: number) => updateActiveEffect({ dirt: v })"
            />
            <StudioSlider
              data-testid="pc-contrast"
              label="Contrast"
              :min="0.5" :max="2" :step="0.01" :default="1.4"
              :model-value="(activeEffect as any).contrast ?? 1.4"
              @update:model-value="(v: number) => updateActiveEffect({ contrast: v })"
            />
          </div>

          <!-- Print recipe · Letterpress (F7): a pressed-in impression on textured paper, expanded
               into a debossed inner shadow + paper tint + slight desaturate. Depth, ink and paper are
               all read by expandRecipe — no dead control. -->
          <div v-else-if="activeEffect!.type === 'letterpress'" class="space-y-1.5">
            <p class="text-xs text-white/50">A pressed-in impression on textured paper.</p>
            <StudioSlider
              data-testid="lp-depth"
              label="Depth"
              :min="0" :max="1" :step="0.01" :default="0.5"
              :model-value="(activeEffect as any).depth ?? 0.5"
              @update:model-value="(v: number) => updateActiveEffect({ depth: v })"
            />
            <StudioColorField
              data-testid="lp-ink"
              label="Ink"
              :model-value="(activeEffect as any).ink ?? '#2a2a2a'"
              @update:model-value="(v: string) => updateActiveEffect({ ink: v })"
            />
            <StudioSlider
              data-testid="lp-paper"
              label="Paper"
              :min="0" :max="1" :step="0.01" :default="0.3"
              :model-value="(activeEffect as any).paper ?? 0.3"
              @update:model-value="(v: number) => updateActiveEffect({ paper: v })"
            />
          </div>

          <!-- Outer glow / Inner glow: a tinted halo outside (behind) or inside (clipped to) the
               layer's silhouette. Colour card (shared activeFxHex/activeFxAlpha/composeRgba, same
               as drop shadow), then Radius (blur/spread, width-normalized, shown ×100 like the
               shadow offsets) and Intensity (0..2 strength). All three are read by passOuterGlow /
               passInnerGlow — no dead control. -->
          <div v-else-if="activeEffect!.type === 'outer_glow' || activeEffect!.type === 'inner_glow'" class="space-y-1.5">
            <div class="flex items-center gap-1.5">
              <input type="color" :value="activeFxHex" title="Glow colour"
                class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                @input="updateActiveEffect({ color: composeRgba(($event.target as HTMLInputElement).value, activeFxAlpha) })" />
              <input type="text" spellcheck="false" maxlength="7" :value="activeFxHex" title="Hex colour"
                class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                @change="setActiveFxHex(($event.target as HTMLInputElement).value)" />
              <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Glow opacity (alpha)">
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(activeFxAlpha * 100)"
                  class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                  @input="updateActiveEffect({ color: composeRgba(activeFxHex, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                <span class="text-[10px] text-white/35 select-none">%</span>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Radius</div>
                <input v-scrubnum type="number" min="0" max="50" step="0.5" :value="Math.round(((activeEffect as any).radius ?? 0.02) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ radius: Math.min(0.5, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Intensity</div>
                <input v-scrubnum type="number" min="0" max="2" step="0.05" :value="Math.round(((activeEffect as any).intensity ?? 0.8) * 100) / 100"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ intensity: Math.min(2, Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0)) })" />
              </div>
            </div>
          </div>

          <!-- Colour overlay: a flat colour composited over the layer at a blend + opacity,
               clipped to the layer's alpha. Colour (plain hex), blend and opacity are all read
               by passColorOverlay — no dead control. -->
          <div v-else-if="activeEffect!.type === 'color_overlay'" class="space-y-1.5">
            <div class="flex items-center gap-1.5">
              <input type="color" :value="(activeEffect as any).color || '#808080'" title="Overlay colour"
                class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                @input="updateActiveEffect({ color: ($event.target as HTMLInputElement).value })" />
              <input type="text" spellcheck="false" maxlength="7" :value="(activeEffect as any).color || '#808080'" title="Hex colour"
                class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                @change="updateActiveEffect({ color: ($event.target as HTMLInputElement).value })" />
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Blend</div>
                <select :value="(activeEffect as any).blend || 'normal'"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @change="updateActiveEffect({ blend: ($event.target as HTMLSelectElement).value })">
                  <option v-for="b in OVERLAY_BLENDS" :key="b" :value="b">{{ OVERLAY_BLEND_LABELS[b] }}</option>
                </select>
              </div>
              <div>
                <div class="panel-sublabel mb-1">Opacity</div>
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).opacity ?? 1) * 100)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ opacity: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
            </div>
          </div>

          <!-- Gradient overlay: a two-colour linear gradient (From→To) at an angle, composited
               over the layer at a blend + opacity, clipped to the layer's alpha. Every control
               is read by passGradientOverlay. -->
          <div v-else-if="activeEffect!.type === 'gradient_overlay'" class="space-y-1.5">
            <div class="grid grid-cols-2 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">From</div>
                <div class="flex items-center gap-1.5">
                  <input type="color" :value="(activeEffect as any).from || '#ff5b5b'" title="Gradient start colour"
                    class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                    @input="updateActiveEffect({ from: ($event.target as HTMLInputElement).value })" />
                  <input type="text" spellcheck="false" maxlength="7" :value="(activeEffect as any).from || '#ff5b5b'" title="Hex colour"
                    class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                    @change="updateActiveEffect({ from: ($event.target as HTMLInputElement).value })" />
                </div>
              </div>
              <div>
                <div class="panel-sublabel mb-1">To</div>
                <div class="flex items-center gap-1.5">
                  <input type="color" :value="(activeEffect as any).to || '#4f8ad9'" title="Gradient end colour"
                    class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                    @input="updateActiveEffect({ to: ($event.target as HTMLInputElement).value })" />
                  <input type="text" spellcheck="false" maxlength="7" :value="(activeEffect as any).to || '#4f8ad9'" title="Hex colour"
                    class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                    @change="updateActiveEffect({ to: ($event.target as HTMLInputElement).value })" />
                </div>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Angle</div>
                <input v-scrubnum type="number" min="0" max="360" step="1" :value="Math.round((activeEffect as any).angle ?? 0)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ angle: Math.min(360, Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0)) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Blend</div>
                <select :value="(activeEffect as any).blend || 'normal'"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @change="updateActiveEffect({ blend: ($event.target as HTMLSelectElement).value })">
                  <option v-for="b in OVERLAY_BLENDS" :key="b" :value="b">{{ OVERLAY_BLEND_LABELS[b] }}</option>
                </select>
              </div>
              <div>
                <div class="panel-sublabel mb-1">Opacity</div>
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).opacity ?? 1) * 100)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ opacity: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
            </div>
          </div>

          <!-- Stroke from alpha: a band traced from the layer's OWN rasterised alpha edge (any
               layer kind), filled with a colour. Width, align and colour are all read by
               passStrokeFromAlpha — no dead control. Colour card is the shared drop-shadow
               pattern (activeFxHex/activeFxAlpha/composeRgba), so rgba strokes work too. -->
          <div v-else-if="activeEffect!.type === 'stroke_from_alpha'" class="space-y-1.5">
            <div class="flex items-center gap-1.5">
              <input type="color" :value="activeFxHex" title="Stroke colour"
                class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
                @input="updateActiveEffect({ color: composeRgba(($event.target as HTMLInputElement).value, activeFxAlpha) })" />
              <input type="text" spellcheck="false" maxlength="7" :value="activeFxHex" title="Hex colour"
                class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs font-mono uppercase text-white/90 outline-none"
                @change="setActiveFxHex(($event.target as HTMLInputElement).value)" />
              <div class="flex items-center gap-0.5 shrink-0 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-1.5" title="Stroke opacity (alpha)">
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(activeFxAlpha * 100)"
                  class="w-7 bg-transparent text-xs text-white/90 outline-none text-right"
                  @input="updateActiveEffect({ color: composeRgba(activeFxHex, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100) })" />
                <span class="text-[10px] text-white/35 select-none">%</span>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Width</div>
                <input v-scrubnum type="number" min="0" max="20" step="0.1" :value="Math.round(((activeEffect as any).width ?? 0.006) * 1000) / 10"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ width: Math.min(0.2, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Align</div>
                <select :value="(activeEffect as any).align || 'center'"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @change="updateActiveEffect({ align: ($event.target as HTMLSelectElement).value })">
                  <option v-for="a in STROKE_ALPHA_ALIGNS" :key="a" :value="a">{{ STROKE_ALPHA_ALIGN_LABELS[a] }}</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Directional blur: a linear smear along an angle for a distance. Both dials are read
               by passDirectionalBlur — no dead control. Distance shows as a percentage of the
               canvas width, matching every other normalised distance in the inspector. -->
          <div v-else-if="activeEffect!.type === 'directional_blur'" class="grid grid-cols-2 gap-1.5">
            <div>
              <div class="panel-sublabel mb-1">Angle</div>
              <input v-scrubnum type="number" min="0" max="360" step="1" :value="Math.round((activeEffect as any).angle ?? 0)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ angle: Math.min(360, Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Distance</div>
              <input v-scrubnum type="number" min="0" max="20" step="0.1" :value="Math.round(((activeEffect as any).distance ?? 0.03) * 1000) / 10"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ distance: Math.min(0.2, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
          </div>

          <!-- Radial (spin) and zoom blur: a strength plus the centre they revolve / radiate about.
               Every dial is read by passRadialBlur / passZoomBlur — no dead control. Centre and
               amount show as percentages. -->
          <div v-else-if="activeEffect!.type === 'radial_blur' || activeEffect!.type === 'zoom_blur'" class="space-y-1.5">
            <div>
              <div class="panel-sublabel mb-1">Amount</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).amount ?? 0.3) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ amount: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <div>
                <div class="panel-sublabel mb-1">Centre X</div>
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).centerX ?? 0.5) * 100)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ centerX: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
              <div>
                <div class="panel-sublabel mb-1">Centre Y</div>
                <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).centerY ?? 0.5) * 100)"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                  @input="updateActiveEffect({ centerY: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
              </div>
            </div>
          </div>

          <!-- Levels: remap the tonal range. Black / white (input window, shown as percentages)
               and gamma (midtone bend) are all read by passLevels — no dead control. -->
          <div v-else-if="activeEffect!.type === 'levels'" class="grid grid-cols-3 gap-1.5">
            <div>
              <div class="panel-sublabel mb-1">Black</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).black ?? 0) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ black: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">White</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).white ?? 1) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ white: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Gamma</div>
              <input v-scrubnum type="number" min="0.1" max="5" step="0.05" :value="Math.round(((activeEffect as any).gamma ?? 1) * 100) / 100"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ gamma: Math.min(5, Math.max(0.1, parseFloat(($event.target as HTMLInputElement).value) || 1)) })" />
            </div>
          </div>

          <!-- Posterise: quantise each channel to a number of steps. Levels is read by
               passPosterise — no dead control. -->
          <div v-else-if="activeEffect!.type === 'posterise'" class="space-y-1.5">
            <div>
              <div class="panel-sublabel mb-1">Levels</div>
              <input v-scrubnum type="number" min="2" max="32" step="1" :value="Math.round((activeEffect as any).levels ?? 6)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ levels: Math.min(32, Math.max(2, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 6))) })" />
            </div>
          </div>

          <!-- Threshold: split every pixel to black or white by luminance. Cutoff (shown as a
               percentage) is read by passThreshold — no dead control. -->
          <div v-else-if="activeEffect!.type === 'threshold'" class="space-y-1.5">
            <div>
              <div class="panel-sublabel mb-1">Cutoff</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).cutoff ?? 0.5) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ cutoff: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
          </div>

          <!-- Invert: mix toward the inverted colour. Amount (shown as a percentage) is read by
               passInvert — no dead control. -->
          <div v-else-if="activeEffect!.type === 'invert'" class="space-y-1.5">
            <div>
              <div class="panel-sublabel mb-1">Amount</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).amount ?? 1) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ amount: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
          </div>

          <!-- Rough edge: jitter the alpha boundary in and out by a seeded noise field. Amount
               (percentage), detail (noise frequency) and seed are all read by passRoughEdge — no
               dead control. Mirrors the roughen 3-dial grid. -->
          <div v-else-if="activeEffect!.type === 'rough_edge'" class="grid grid-cols-3 gap-1.5">
            <div>
              <div class="panel-sublabel mb-1">Amount</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).amount ?? 0.5) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ amount: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Detail</div>
              <input v-scrubnum type="number" min="1" max="32" step="1" :value="Math.round((activeEffect as any).detail ?? 8)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ detail: Math.min(32, Math.max(1, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 8))) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Seed</div>
              <input v-scrubnum type="number" step="1" :value="Math.round((activeEffect as any).seed ?? 1)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ seed: Math.round(parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
            </div>
          </div>

          <!-- Ink bleed: an organic outward spread of the alpha. Amount (reach) and softness
               (percentages) and seed are all read by passInkBleed — no dead control. -->
          <div v-else-if="activeEffect!.type === 'ink_bleed'" class="grid grid-cols-3 gap-1.5">
            <div>
              <div class="panel-sublabel mb-1">Amount</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).amount ?? 0.4) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ amount: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Softness</div>
              <input v-scrubnum type="number" min="0" max="100" step="1" :value="Math.round(((activeEffect as any).softness ?? 0.3) * 100)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ softness: Math.min(1, Math.max(0, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
            </div>
            <div>
              <div class="panel-sublabel mb-1">Seed</div>
              <input v-scrubnum type="number" step="1" :value="Math.round((activeEffect as any).seed ?? 1)"
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveEffect({ seed: Math.round(parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
            </div>
          </div>
        </div>
      </template>


      <!-- One outline, tuned on its own. Reached by selecting a stroke row in the layer tree.
           Every row here is gated by `strokeInspectorRows` on something the PAINTER reads —
           a control that only stores its value is a dead control, and this repo hides an
           inapplicable row rather than greying it. -->
      <template v-else-if="activeStroke">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-1.5 text-[11px] text-white/50" data-testid="stroke-breadcrumb">
          <button type="button" class="truncate capitalize hover:text-white/80" @click="selectedStroke = null">{{ activeStrokeLayer ? rowLabel({ layer: activeStrokeLayer }) : 'Layer' }}</button>
          <ChevronRight class="size-3 shrink-0 opacity-60" />
          <span class="truncate text-white/80">{{ strokeRowLabel(activeStroke!, outWidth) }}</span>
        </div>
        <div class="inspector-body p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto" data-testid="stroke-inspector">
          <div>
            <div class="panel-label mb-1.5">Colour</div>
            <FillControl allow-none :model-value="activeStroke!.paint"
              @update:model-value="(v: any) => updateActiveStroke({ paint: v })" />
            <div v-if="hasStrokeRow('width')" class="mt-1.5">
              <div class="panel-label mb-1">Width</div>
              <input v-scrubnum type="number" min="0" step="1" :value="strokePxW(activeStroke!.width)" data-stroke-width
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveStroke({ width: Math.max(0, strokeNormW(parseFloat(($event.target as HTMLInputElement).value) || 0)) })" />
            </div>
            <div class="mt-1.5">
              <div class="panel-label mb-1">Distance from the edge</div>
              <!-- Signed on purpose: positive pushes the band out, negative pulls it in. -->
              <input v-scrubnum type="number" step="1" :value="strokePxW(strokeDistanceOf(activeStroke!))" data-stroke-distance
                class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                @input="updateActiveStroke({ distance: strokeNormSigned(parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
            </div>
            <StrokeStyleRow class="mt-1.5"
              :align="activeStroke!.align" :dash="activeStroke!.dash"
              :join="activeStroke!.join" :stroke-style="strokeStyleOf(activeStroke!)"
              :wobble="activeStroke!.wobble" :wobble-amount="activeStroke!.wobbleAmount"
              :wobble-length="activeStroke!.wobbleLength" :wobble-phase="activeStroke!.wobblePhase"
              :show-align="hasStrokeRow('align')"
              :show-join="hasStrokeRow('join')"
              :show-dash="hasStrokeRow('dash')"
              :show-style="hasStrokeRow('style')"
              :show-wobble="hasStrokeRow('wobble')"
              :show-wobble-amount="hasStrokeRow('wobbleAmount')"
              :show-wobble-length="hasStrokeRow('wobbleLength')"
              :show-wobble-phase="hasStrokeRow('wobblePhase')"
              :out-width="outWidth" :scale="activeStrokeScale"
              @update:align="(v: any) => updateActiveStroke({ align: v })"
              @update:dash="(v: any) => updateActiveStroke({ dash: v })"
              @update:join="(v: any) => updateActiveStroke({ join: v })"
              @update:style="(v: any) => setActiveStrokeStyle(v)"
              @update:wobble="(v: any) => setActiveStrokeWobble(v)"
              @update:wobbleAmount="(v: number) => updateActiveStroke({ wobbleAmount: v })"
              @update:wobbleLength="(v: number) => updateActiveStroke({ wobbleLength: v })"
              @update:wobblePhase="(v: number) => updateActiveStroke({ wobblePhase: v })" />
            <ShapeStrokeRow v-if="hasStrokeRow('shapes') && activeStroke!.shapes" class="mt-1.5"
              :spec="activeStroke!.shapes!" :out-width="outWidth" :scale="activeStrokeScale"
              @update="(patch: any) => updateActiveStrokeShapes(patch)" />
            <p v-if="showsTextDistantNote(activeStrokeKind, activeStroke!)" class="mt-2 text-[10.5px] leading-snug text-white/40"
              data-testid="stroke-text-distance-note">{{ TEXT_DISTANT_STROKE_NOTE }}</p>
          </div>
        </div>
      </template>

      <template v-else-if="selectedLocal && !activeEffect && !activeStroke">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <component :is="kindIcon(selectedLocal.kind)" class="size-3.5 text-white/60" />
          <span class="text-sm font-medium capitalize">{{ selectedLocal.kind === 'deal' ? 'Mosaic' : selectedLocal.kind }}</span>
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
            <StudioSection title="Text">
              <div>
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
                <div v-if="!textPath">
                  <div class="panel-label mb-1.5">V-align</div>
                  <div class="flex gap-1">
                    <button v-for="v in (['top','middle','bottom','justify'] as const)" :key="v" :title="(selectedLocal as any).boxH ? v : 'Set box H to enable'"
                      class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-[10px]"
                      :class="((selectedLocal as any).valign ?? 'top') === v ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50'"
                      @click="setLocal(selectedLocal!.id, { valign: v } as any)">{{ v === 'justify' ? '↕' : v.charAt(0).toUpperCase() }}</button>
                  </div>
                </div>
              </div>
              <div v-if="!textPath" class="space-y-2">
                <div class="panel-label" title="The text box, sized in columns, %, or pixels. Fill sizes the type to the box.">Text box</div>
                <div class="flex items-center gap-1">
                  <button v-for="f in (['wrap','shrink','fill','break'] as const)" :key="f"
                    class="flex-1 text-[11px] py-1 rounded border capitalize"
                    :class="((selectedLocal as any).boxFit ?? 'wrap') === f ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                    :title="f === 'wrap' ? 'Words wrap; the type keeps its size' : f === 'shrink' ? 'Shrink the type to fit the box' : f === 'fill' ? 'Size the type to fill the box' : 'Break even a single word across lines to fill the box (needs a height)'"
                    @click="setBoxFit(selectedLocal, f)">{{ f }}</button>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <div class="panel-label mb-1">Width</div>
                    <div class="relative">
                      <input v-scrubnum type="number" min="0" :placeholder="boxUnit === 'col' ? 'cols' : 'auto'"
                        :value="boxToUnit((selectedLocal as any).boxW)"
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded pl-2 pr-11 py-1.5 text-xs text-white/90 outline-none placeholder-white/25"
                        @input="(e: Event) => setBoxDim(selectedLocal!.id, 'boxW', (e.target as HTMLInputElement).value)" />
                      <div class="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-white/30 text-[8px]">▾</div>
                      <select :value="boxUnit" title="Unit: columns, percent, or pixels"
                        class="absolute inset-y-0 right-0 my-px mr-px pl-1.5 pr-4 rounded-r bg-transparent text-[10px] text-white/50 outline-none cursor-pointer appearance-none hover:text-white/80"
                        @change="boxUnit = ($event.target as HTMLSelectElement).value as any">
                        <option v-for="u in (['col','%','px'] as const)" :key="u" :value="u" class="bg-neutral-800 text-white">{{ u }}</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <div class="panel-label mb-1">Height</div>
                    <div class="relative">
                      <input v-scrubnum type="number" min="0" :placeholder="boxUnit === 'col' ? 'rows' : 'auto'"
                        :value="boxToUnit((selectedLocal as any).boxH, 'h')"
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded pl-2 pr-11 py-1.5 text-xs text-white/90 outline-none placeholder-white/25"
                        @input="(e: Event) => setBoxDim(selectedLocal!.id, 'boxH', (e.target as HTMLInputElement).value)" />
                      <div class="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-white/30 text-[8px]">▾</div>
                      <select :value="boxUnit" title="Unit: columns, percent, or pixels"
                        class="absolute inset-y-0 right-0 my-px mr-px pl-1.5 pr-4 rounded-r bg-transparent text-[10px] text-white/50 outline-none cursor-pointer appearance-none hover:text-white/80"
                        @change="boxUnit = ($event.target as HTMLSelectElement).value as any">
                        <option v-for="u in (['col','%','px'] as const)" :key="u" :value="u" class="bg-neutral-800 text-white">{{ u }}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
              <!-- Type on a path. The guide belongs to this layer: it shows only
                   while the layer is selected and never appears in the layer list. -->
              <div>
                <div class="panel-label mb-1.5" title="Run the type along a curve instead of flat lines">Follow a path</div>
                <select :value="textPath?.follow ?? 'off'"
                  class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                  @change="setTextFollow(selectedLocal, ($event.target as HTMLSelectElement).value as any)">
                  <option v-for="o in TEXT_FOLLOW_OPTIONS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>

                <div v-if="textPath" class="mt-2.5 space-y-2.5">
                  <!-- Curve: one dial from flat, through an arch, to a closed ring. -->
                  <StudioSlider v-if="textPath.follow === 'curve'" label="Bend"
                    :model-value="textPath.bend ?? 0" :min="-1" :max="1" :step="0.01" :bindable="false"
                    @update:model-value="(v) => setTextPath(selectedLocal, { bend: v })" />

                  <div v-if="textPath.follow === 'circle'" class="grid grid-cols-2 gap-3">
                    <div>
                      <div class="panel-label mb-1">Radius</div>
                      <input v-scrubnum type="number" min="1" :value="pxW(textPath.radius ?? 0)"
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                        @input="setTextPath(selectedLocal, { radius: Math.max(1, parseFloat(($event.target as HTMLInputElement).value) || 1) / outWidth })" />
                    </div>
                    <div>
                      <div class="panel-label mb-1" title="Degrees clockwise from the top of the ring">Start angle</div>
                      <input v-scrubnum type="number" step="1" :value="Math.round(textPath.startAngle ?? 0)"
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                        @input="setTextPath(selectedLocal, { startAngle: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
                    </div>
                  </div>

                  <div v-if="textPath.follow === 'wave'" class="grid grid-cols-2 gap-3">
                    <div>
                      <div class="panel-label mb-1">Height</div>
                      <input v-scrubnum type="number" min="0" :value="pxW(textPath.amplitude ?? 0)"
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                        @input="setTextPath(selectedLocal, { amplitude: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0) / outWidth })" />
                    </div>
                    <div>
                      <div class="panel-label mb-1" title="How many full waves the run crosses">Waves</div>
                      <input v-scrubnum type="number" min="0" step="0.25" :value="textPath.frequency ?? 0"
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                        @input="setTextPath(selectedLocal, { frequency: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0) })" />
                    </div>
                  </div>

                  <!-- Shape: the outline of any library shape becomes the guide. -->
                  <div v-if="textPath.follow === 'shape'">
                    <div class="panel-label mb-1">Shape</div>
                    <button
                      ref="textPathShapeButtonRef"
                      type="button"
                      class="w-full flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 cursor-pointer transition-colors"
                      title="Pick the shape the type runs around"
                      @click="openTextPathShapePicker"
                    >
                      <svg v-if="textPathShape" viewBox="0 0 96 96" class="size-4 shrink-0" fill="currentColor" aria-hidden="true"><path :d="textPathShape.d" :fill-rule="textPathShape.fillRule" /></svg>
                      <span class="flex-1 text-left">{{ textPathShape?.name ?? 'Pick a shape' }}</span>
                    </button>
                    <ShapePicker
                      v-if="textPathShapePickerOpen"
                      :model-value="textPath.shapeId ?? ''"
                      :allow-none="false"
                      :anchor="textPathShapeAnchor"
                      :ignore="textPathShapeButtonRef"
                      @update:model-value="(id: string) => { setTextPath(selectedLocal, { shapeId: id }); textPathShapePickerOpen = false }"
                      @close="textPathShapePickerOpen = false"
                    />
                  </div>

                  <div v-if="textPath.follow === 'custom'" class="space-y-2">
                    <button
                      class="w-full flex items-center justify-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded py-1.5 text-xs text-white/80 hover:text-white cursor-pointer transition-colors"
                      :title="textPath.d ? 'Draw a new path for this type to follow' : 'Draw the path this type will follow'"
                      @click="drawGuideForSelectedText"
                    >
                      <PenTool class="size-3.5" /> {{ textPath.d ? 'Redraw the path' : 'Draw a path' }}
                    </button>
                    <div v-if="framePathLayers.length" class="flex items-center gap-2">
                      <span class="text-[10px] text-white/40 shrink-0">Or use</span>
                      <select
                        class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                        title="Follow a path already on this frame"
                        @change="useFramePathAsGuide(selectedLocal, ($event.target as HTMLSelectElement).value)"
                      >
                        <option value="">A path on the frame…</option>
                        <option v-for="pl in framePathLayers" :key="pl.id" :value="pl.id">{{ pl.label }}</option>
                      </select>
                    </div>
                    <p v-if="!textPath.d" class="text-[11px] text-white/45 leading-snug">
                      Click to place points, drag to curve them. The path guides the type and isn't drawn.
                    </p>
                  </div>

                  <div v-if="textPath.follow === 'shape' || textPath.follow === 'custom'">
                    <div class="panel-label mb-1" title="How big the path is — the type's own size is set above">Path size</div>
                    <input v-scrubnum type="number" min="1" :value="pxW(textPath.size ?? 0)"
                      class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                      @input="setTextPath(selectedLocal, { size: Math.max(1, parseFloat(($event.target as HTMLInputElement).value) || 1) / outWidth })" />
                  </div>

                  <!-- Shared dials, meaningful on every guide. -->
                  <div>
                    <div class="panel-label mb-1" title="Slide the type along the path">Start · {{ Math.round(textPathStartUi * 100) }}%</div>
                    <input type="range" min="0" max="1" step="0.005" :value="textPathStartUi"
                      class="w-full accent-white cursor-pointer"
                      @input="setTextPathStartUi(selectedLocal, parseFloat(($event.target as HTMLInputElement).value))" />
                  </div>
                  <div>
                    <div class="panel-label mb-1" title="Lift the type off the path, or drop it below">Baseline shift</div>
                    <input v-scrubnum type="number" step="1" :value="pxW(textPath.shift ?? 0)"
                      class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
                      @input="setTextPath(selectedLocal, { shift: (parseFloat(($event.target as HTMLInputElement).value) || 0) / outWidth })" />
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <div class="panel-label mb-1" title="Which side of the path the type sits on">Side</div>
                      <div class="flex gap-1">
                        <button v-for="sd in (['outside','inside'] as const)" :key="sd"
                          class="flex-1 bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-[10px] cursor-pointer"
                          :class="(textPath.side ?? 'outside') === sd ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50'"
                          @click="setTextPathSide(selectedLocal, sd)">{{ sd === 'outside' ? 'Outside' : 'Inside' }}</button>
                      </div>
                    </div>
                    <div>
                      <div class="panel-label mb-1" title="Space the letters so they fill the whole path">Fit to path</div>
                      <button
                        class="w-full bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-[10px] cursor-pointer"
                        :class="textPath.fit ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50'"
                        @click="setTextPath(selectedLocal, { fit: !textPath!.fit })">{{ textPath.fit ? 'On' : 'Off' }}</button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div v-if="!textPath">
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
                  <button v-if="!textPath" title="Underline"
                    class="flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 px-2.5"
                    :class="(selectedLocal as any).underline ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setLocal(selectedLocal!.id, { underline: !(selectedLocal as any).underline })">
                    <Underline class="size-3.5" />
                  </button>
                  <button v-if="!textPath" title="Strikethrough"
                    class="flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 px-2.5"
                    :class="(selectedLocal as any).strikethrough ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setLocal(selectedLocal!.id, { strikethrough: !(selectedLocal as any).strikethrough })">
                    <Strikethrough class="size-3.5" />
                  </button>
                  <div v-if="!textPath" class="w-px bg-white/[0.08] mx-0.5"></div>
                  <button v-for="c in (['uppercase','lowercase','capitalize'] as const)" :key="c" :title="c"
                    class="flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 px-2.5"
                    :class="(selectedLocal as any).textTransform === c ? 'text-yellow-400 border-yellow-400/50' : 'text-white/60'"
                    @click="setLocal(selectedLocal!.id, { textTransform: (selectedLocal as any).textTransform === c ? undefined : c })">
                    <component :is="c === 'uppercase' ? CaseUpper : c === 'lowercase' ? CaseLower : CaseSensitive" class="size-3.5" />
                  </button>
                </div>
              </div>
              <div v-if="!textPath">
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
                  <div class="flex items-center gap-1">
                    <button
                      class="flex-1 text-[11px] py-1 rounded border"
                      :class="!(selectedLocal as any).expressive.perChar ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                      @click="setExpressive(selectedLocal, { perChar: false })">Words</button>
                    <button
                      class="flex-1 text-[11px] py-1 rounded border"
                      :class="(selectedLocal as any).expressive.perChar ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                      @click="setExpressive(selectedLocal, { perChar: true })">Letters</button>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <div class="panel-label mb-1">{{ (selectedLocal as any).expressive.perChar ? 'Glyphs / line' : 'Words / line' }}</div>
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
                        <option value="ring">Ring</option>
                      </select>
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <StudioSlider label="Jitter X" :model-value="(selectedLocal as any).expressive.jitterX"
                      :min="0" :max="1" :step="0.05" :bindable="false"
                      @update:model-value="(v) => setExpressive(selectedLocal, { jitterX: v })" />
                    <StudioSlider label="Jitter Y" :model-value="(selectedLocal as any).expressive.jitterY"
                      :min="0" :max="1" :step="0.05" :bindable="false"
                      @update:model-value="(v) => setExpressive(selectedLocal, { jitterY: v })" />
                  </div>
                  <button
                    class="w-full flex items-center justify-center gap-1.5 bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-xs text-white/80 hover:text-white"
                    @click="rerollExpressive(selectedLocal)">
                    <RefreshCw class="size-3.5" /> Re-render
                  </button>
                  <div v-if="(selectedLocal as any).expressive.perChar" class="space-y-1.5 pt-1 border-t border-white/[0.06]">
                    <div class="panel-label" title="Render some letters in a second face">Accent face</div>
                    <div class="flex items-center gap-1.5">
                      <div class="flex-1 min-w-0">
                        <FontPicker :selected-key="(selectedLocal as any).accentFace || ''" :label="(selectedLocal as any).accentFace || 'None'" sublabel="" @pick="onPickAccentFace" />
                      </div>
                      <button v-if="(selectedLocal as any).accentFace" title="Clear the accent face"
                        class="shrink-0 px-2 py-1.5 rounded border border-white/[0.08] text-white/50 hover:text-white/80 text-xs" @click="clearAccentFace">Clear</button>
                    </div>
                    <select v-if="(selectedLocal as any).accentFace" :value="(selectedLocal as any).accentRule || 'first'"
                      class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                      @change="setLocal(selectedLocal!.id, { accentRule: ($event.target as HTMLSelectElement).value as any })">
                      <option value="first">First letter</option>
                      <option value="alternate">Every other letter</option>
                    </select>
                  </div>
                </div>
              </div>
              <div class="space-y-3">
                <div>
                  <div class="panel-label mb-1.5">Color</div>
                  <FillControl :model-value="(selectedLocal as any).color"
                    @update:model-value="(v: any) => setLocal(selectedLocal!.id, { color: v })" />
                </div>
                <div v-if="showsLegacyStrokeSection(selectedLocal)" data-testid="legacy-stroke-section">
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
            </StudioSection>
          </template>

          <!-- Rect / ellipse controls -->
          <template v-if="selectedLocal.kind === 'rect' || selectedLocal.kind === 'ellipse'">
            <StudioSection title="Fill and outline">
              <div>
                <div class="panel-label mb-1.5">Fill</div>
                <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill" allow-reads-backdrop :other-layers="glassCandidates"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
              </div>
              <div v-if="showsLegacyStrokeSection(selectedLocal)" data-testid="legacy-stroke-section">
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
            </StudioSection>
          </template>

          <!-- Polygon controls -->
          <template v-if="selectedLocal.kind === 'polygon'">
            <StudioSection title="Fill and outline">
              <div>
                <div class="panel-label mb-1.5">Fill</div>
                <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill" allow-reads-backdrop :other-layers="glassCandidates"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
              </div>
              <div v-if="showsLegacyStrokeSection(selectedLocal)" data-testid="legacy-stroke-section">
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
              <StudioSlider label="Corner radius" :model-value="(selectedLocal as any).cornerRadius"
                :min="0" :max="1" :step="0.01" :bindable="false"
                @update:model-value="(v) => setLocal(selectedLocal!.id, { cornerRadius: v })" />
            </StudioSection>
          </template>

          <!-- Star controls -->
          <template v-if="selectedLocal.kind === 'star'">
            <StudioSection title="Fill and outline">
              <div>
                <div class="panel-label mb-1.5">Fill</div>
                <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill" allow-reads-backdrop :other-layers="glassCandidates"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
              </div>
              <div v-if="showsLegacyStrokeSection(selectedLocal)" data-testid="legacy-stroke-section">
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
              <StudioSlider label="Inner radius" :model-value="(selectedLocal as any).innerRatio"
                :min="0.01" :max="0.99" :step="0.01" :bindable="false"
                @update:model-value="(v) => setLocal(selectedLocal!.id, { innerRatio: v })" />
              <StudioSlider label="Corner radius" :model-value="(selectedLocal as any).cornerRadius"
                :min="0" :max="1" :step="0.01" :bindable="false"
                @update:model-value="(v) => setLocal(selectedLocal!.id, { cornerRadius: v })" />
            </StudioSection>
          </template>

          <!-- Line controls -->
          <template v-if="selectedLocal.kind === 'line'">
            <StudioSection title="Fill and outline">
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
            </StudioSection>
          </template>

          <!-- Path (vector) controls -->
          <template v-if="selectedLocal.kind === 'path'">
            <StudioSection title="Fill and outline">
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
                <FillControl allow-none allow-image :model-value="(selectedLocal as any).fill" allow-reads-backdrop :other-layers="glassCandidates"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { fill: v })" />
              </div>
              <div v-if="showsLegacyStrokeSection(selectedLocal)" data-testid="legacy-stroke-section">
                <div class="panel-label mb-1.5">Stroke</div>
                <FillControl allow-none :model-value="(selectedLocal as any).stroke"
                  @update:model-value="(v: any) => setStroke(selectedLocal!.id, v)" />
                <StrokeStyleRow v-if="hasStroke(selectedLocal)" class="mt-1.5" :align="(selectedLocal as any).strokeAlign" :dash="(selectedLocal as any).strokeDash"
                  show-align :out-width="outWidth" :scale="(selectedLocal as any).scale || 1"
                  @update:align="(v: any) => setLocal(selectedLocal!.id, { strokeAlign: v })"
                  @update:dash="(v: any) => setLocal(selectedLocal!.id, { strokeDash: v })" />
              </div>
            </StudioSection>
          </template>

          <!-- Brush (freehand paint) controls: the stroke region takes any Paint fill -->
          <template v-if="selectedLocal.kind === 'brush'">
            <StudioSection title="Fill and outline">
              <div>
                <div class="panel-label mb-1.5">Fill</div>
                <FillControl allow-image :model-value="(selectedLocal as any).fill" allow-reads-backdrop :other-layers="glassCandidates"
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
            </StudioSection>
          </template>

          <!-- Mosaic (kind 'deal'): Style first — which composition this layer is —
               then that style's dials, its Palette, and New variation. The layer
               carries its OWN grid (Tiles reads it; the other styles have their own
               layouts and only read its seed). -->
          <template v-if="selectedLocal.kind === 'deal'">
            <StudioSection title="Style">
              <StudioSelect label="Style" :options="MOSAIC_STYLE_LABELS as any"
                :model-value="mosaicStyleLabel(selectedLocal as DealLayer)"
                @update:model-value="(v: any) => setMosaicStyle(selectedLocal as DealLayer, v)" />
              <!-- Mosh has its OWN layout (horizontal bands of glitch), so the grid controls
                   (density / inset / regularity / merge) don't apply to it. -->
              <div v-if="(selectedLocal as any).cellFill === 'mosh'" class="mt-2 flex flex-col gap-1.5">
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
                <StudioSelect label="Palette" :options="MOSH_PRESET_NAMES as any"
                  :model-value="moshPreset" @update:model-value="(v: any) => applyMoshPreset(selectedLocal as DealLayer, v)" />
              </div>
              <!-- Parcel has its OWN layout (a coarse two-tone block field with survey grids
                   on top), so the grid controls (density / inset / regularity / merge) don't
                   apply to it. -->
              <div v-else-if="(selectedLocal as any).cellFill === 'parcel'" class="mt-2 flex flex-col gap-1.5">
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
                <StudioSelect label="Palette" :options="PARCEL_PRESET_NAMES as any"
                  :model-value="parcelPreset" @update:model-value="(v: any) => applyParcelPreset(selectedLocal as DealLayer, v)" />
              </div>
              <!-- Modular has its OWN layout (a merged module grid over a background), so the
                   grid controls (density / inset / regularity / merge) don't apply to it. -->
              <div v-else-if="(selectedLocal as any).cellFill === 'modular'" class="mt-2 flex flex-col gap-1.5">
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
                <div>
                  <div class="panel-label mb-1.5">Palette</div>
                  <StudioSegmented :options="MODULAR_PRESET_NAMES as any" :model-value="modularPreset"
                    @update:model-value="(v: any) => applyModularPreset(selectedLocal as DealLayer, v)" />
                </div>
              </div>
              <!-- Carve has its OWN layout (one rectangle carved into panels), so the grid
                   controls (density / inset / regularity / merge) don't apply to it. -->
              <div v-else-if="(selectedLocal as any).cellFill === 'carve'" class="mt-2 flex flex-col gap-1.5">
                <StudioSlider label="Cuts" :min="CARVE_LIMITS.cuts[0]" :max="CARVE_LIMITS.cuts[1]" :step="1" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).cuts"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { cuts: Math.round(v) })" />
                <StudioSlider label="Unevenness" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).uneven"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { uneven: v })" />
                <StudioSlider label="Gap" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).gap"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { gap: v })" />
                <div class="panel-label mt-1">Treatments</div>
                <StudioSlider label="Patterned" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).mix"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { mix: v })" />
                <StudioSlider label="Stripe pitch" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).stripePitch"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { stripePitch: v })" />
                <StudioSlider label="Grain" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).grain"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { grain: v })" />
                <StudioSlider label="Grid detail" :min="0" :max="1" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).carve ?? defaultCarve()).gridDetail"
                  @update:model-value="(v: number) => patchCarve(selectedLocal as DealLayer, { gridDetail: v })" />
                <StudioSelect label="Palette" :options="CARVE_PRESET_NAMES as any"
                  :model-value="carvePreset" @update:model-value="(v: any) => applyCarvePreset(selectedLocal as DealLayer, v)" />
              </div>
              <!-- Totem lays out its own framed plate, so the grid controls (density /
                   inset / regularity / merge) have nothing to say about it. -->
              <div v-else-if="(selectedLocal as any).cellFill === 'totem'" class="mt-2 flex flex-col gap-1.5">
                <StudioSlider label="Border" :min="TOTEM_LIMITS.border[0]" :max="TOTEM_LIMITS.border[1]" :step="0.005" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).border"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { border: v })" />
                <StudioSlider label="Speckle" :min="TOTEM_LIMITS.mat[0]" :max="TOTEM_LIMITS.mat[1]" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).mat"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { mat: v })" />
                <StudioSlider label="Speckle size" :min="TOTEM_LIMITS.matGrain[0]" :max="TOTEM_LIMITS.matGrain[1]" :step="1" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).matGrain"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { matGrain: Math.round(v) })" />
                <div class="panel-label mt-1">Plate</div>
                <StudioSlider label="Inset" :min="TOTEM_LIMITS.keyline[0]" :max="TOTEM_LIMITS.keyline[1]" :step="1" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).keyline"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { keyline: Math.round(v) })" />
                <StudioSlider label="Blocks" :min="TOTEM_LIMITS.regions[0]" :max="TOTEM_LIMITS.regions[1]" :step="1" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).regions"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { regions: Math.round(v) })" />
                <StudioSlider label="Detail" :min="TOTEM_LIMITS.grain[0]" :max="TOTEM_LIMITS.grain[1]" :step="1" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).grain"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { grain: Math.round(v) })" />
                <StudioSlider label="Mirror" :min="TOTEM_LIMITS.mirror[0]" :max="TOTEM_LIMITS.mirror[1]" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).mirror"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { mirror: v })" />
                <StudioSlider label="Variety" :min="TOTEM_LIMITS.variety[0]" :max="TOTEM_LIMITS.variety[1]" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).variety"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { variety: v })" />
                <div class="panel-label mt-1">Centre</div>
                <StudioSlider label="Size" :min="TOTEM_LIMITS.core[0]" :max="TOTEM_LIMITS.core[1]" :step="0.01" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).core"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { core: v })" />
                <StudioSlider label="Rings" :min="TOTEM_LIMITS.coreRings[0]" :max="TOTEM_LIMITS.coreRings[1]" :step="1" :bindable="false"
                  :model-value="((selectedLocal as DealLayer).totem ?? defaultTotem()).coreRings"
                  @update:model-value="(v: number) => patchTotem(selectedLocal as DealLayer, { coreRings: Math.round(v) })" />
                <!-- The five inks, left to right as the picture reads them: the order is
                     what hands out the jobs, so editing one leaves the rest where they are. -->
                <div class="panel-label mt-1">Inks</div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <StudioColor v-for="(ink, i) in totemInks" :key="i" :model-value="ink"
                    @update:model-value="(v: string) => patchTotemInk(selectedLocal as DealLayer, i, v)" />
                </div>
                <StudioSelect label="Palette" :options="TOTEM_PRESET_NAMES as any"
                  :model-value="totemPreset" @update:model-value="(v: any) => applyTotemPreset(selectedLocal as DealLayer, v)" />
              </div>
              <!-- Blueprint draws its OWN drafting grid, so the shared grid controls
                   (density / inset / regularity / merge) have nothing to say about it. -->
              <div v-else-if="(selectedLocal as any).cellFill === 'blueprint'" class="mt-2 flex flex-col gap-1.5">
                <div class="panel-label mt-1">Grid</div>
                <StudioSlider label="Cells" :min="BLUEPRINT_LIMITS.cells[0]" :max="BLUEPRINT_LIMITS.cells[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.cells"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { cells: Math.round(v) })" />
                <StudioSlider label="Major every" :min="BLUEPRINT_LIMITS.major[0]" :max="BLUEPRINT_LIMITS.major[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.major"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { major: Math.round(v) })" />
                <StudioSlider label="Minor opacity" :min="BLUEPRINT_LIMITS.minorAlpha[0]" :max="BLUEPRINT_LIMITS.minorAlpha[1]" :step="0.01" :bindable="false"
                  :model-value="blueprintParams.minorAlpha"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { minorAlpha: v })" />
                <StudioSlider label="Major weight" :min="BLUEPRINT_LIMITS.majorWidth[0]" :max="BLUEPRINT_LIMITS.majorWidth[1]" :step="0.05" :bindable="false"
                  :model-value="blueprintParams.majorWidth"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { majorWidth: v })" />
                <div class="panel-label mt-1">Origin &amp; fan</div>
                <StudioSelect label="Origin" :options="BLUEPRINT_CORNERS as any"
                  :option-labels="['Auto', 'Bottom left', 'Bottom right', 'Top right', 'Top left', 'Center']"
                  :model-value="blueprintParams.corner" @update:model-value="(v: any) => patchBlueprint(selectedLocal as DealLayer, { corner: v })" />
                <StudioSlider label="Origin X" :min="BLUEPRINT_LIMITS.originX[0]" :max="BLUEPRINT_LIMITS.originX[1]" :step="0.01" :bindable="false"
                  :model-value="blueprintParams.originX"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { originX: v })" />
                <StudioSlider label="Origin Y" :min="BLUEPRINT_LIMITS.originY[0]" :max="BLUEPRINT_LIMITS.originY[1]" :step="0.01" :bindable="false"
                  :model-value="blueprintParams.originY"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { originY: v })" />
                <StudioSlider label="Angle start" :min="BLUEPRINT_LIMITS.angleStart[0]" :max="BLUEPRINT_LIMITS.angleStart[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.angleStart"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { angleStart: v })" />
                <StudioSlider label="Angle step" :min="BLUEPRINT_LIMITS.angleStep[0]" :max="BLUEPRINT_LIMITS.angleStep[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.angleStep"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { angleStep: Math.round(v) })" />
                <StudioSlider label="Angle spread" :min="BLUEPRINT_LIMITS.angleSpread[0]" :max="BLUEPRINT_LIMITS.angleSpread[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.angleSpread"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { angleSpread: v })" />
                <div class="panel-label mt-1">Arcs &amp; labels</div>
                <StudioSlider label="Arcs" :min="BLUEPRINT_LIMITS.arcs[0]" :max="BLUEPRINT_LIMITS.arcs[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.arcs"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { arcs: Math.round(v) })" />
                <StudioSlider label="Arc gap" :min="BLUEPRINT_LIMITS.arcGap[0]" :max="BLUEPRINT_LIMITS.arcGap[1]" :step="0.01" :bindable="false"
                  :model-value="blueprintParams.arcGap"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { arcGap: v })" />
                <StudioSlider label="Tick step" :min="BLUEPRINT_LIMITS.tickStep[0]" :max="BLUEPRINT_LIMITS.tickStep[1]" :step="1" :bindable="false"
                  :model-value="blueprintParams.tickStep"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { tickStep: Math.round(v) })" />
                <StudioSlider label="Labels" :min="BLUEPRINT_LIMITS.labels[0]" :max="BLUEPRINT_LIMITS.labels[1]" :step="0.01" :bindable="false"
                  :model-value="blueprintParams.labels"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { labels: v })" />
                <!-- Per-type stroke width (× the minor grid line) and the dash pattern scale. -->
                <div class="panel-label mt-1">Line widths</div>
                <StudioSlider label="Spoke weight" :min="BLUEPRINT_LIMITS.spokeWidth[0]" :max="BLUEPRINT_LIMITS.spokeWidth[1]" :step="0.05" :bindable="false"
                  :model-value="blueprintParams.spokeWidth"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { spokeWidth: v })" />
                <StudioSlider label="Arc weight" :min="BLUEPRINT_LIMITS.arcWidth[0]" :max="BLUEPRINT_LIMITS.arcWidth[1]" :step="0.05" :bindable="false"
                  :model-value="blueprintParams.arcWidth"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { arcWidth: v })" />
                <StudioSlider label="Tick weight" :min="BLUEPRINT_LIMITS.tickWidth[0]" :max="BLUEPRINT_LIMITS.tickWidth[1]" :step="0.05" :bindable="false"
                  :model-value="blueprintParams.tickWidth"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { tickWidth: v })" />
                <StudioSlider label="Dash scale" :min="BLUEPRINT_LIMITS.dashScale[0]" :max="BLUEPRINT_LIMITS.dashScale[1]" :step="0.1" :bindable="false"
                  :model-value="blueprintParams.dashScale"
                  @update:model-value="(v: number) => patchBlueprint(selectedLocal as DealLayer, { dashScale: v })" />
                <!-- Line style per type: a continuous line or a dashed one. -->
                <div class="panel-label mt-1">Line style</div>
                <StudioSelect label="Grid" :options="BLUEPRINT_DASH as any" :option-labels="['Solid', 'Dashed']"
                  :model-value="blueprintParams.gridDash" @update:model-value="(v: any) => patchBlueprint(selectedLocal as DealLayer, { gridDash: v })" />
                <StudioSelect label="Spokes" :options="BLUEPRINT_DASH as any" :option-labels="['Solid', 'Dashed']"
                  :model-value="blueprintParams.spokeDash" @update:model-value="(v: any) => patchBlueprint(selectedLocal as DealLayer, { spokeDash: v })" />
                <StudioSelect label="Arcs" :options="BLUEPRINT_DASH as any" :option-labels="['Solid', 'Dashed']"
                  :model-value="blueprintParams.arcDash" @update:model-value="(v: any) => patchBlueprint(selectedLocal as DealLayer, { arcDash: v })" />
                <StudioSelect label="Ticks" :options="BLUEPRINT_DASH as any" :option-labels="['Solid', 'Dashed']"
                  :model-value="blueprintParams.tickDash" @update:model-value="(v: any) => patchBlueprint(selectedLocal as DealLayer, { tickDash: v })" />
                <!-- Three role inks: paper (ground), ink (lines/labels), inkDim (minor grid). -->
                <div class="panel-label mt-1">Inks</div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <StudioColor :model-value="blueprintParams.paper" @update:model-value="(v: string) => patchBlueprintInk(selectedLocal as DealLayer, 'paper', v)" />
                  <StudioColor :model-value="blueprintParams.ink" @update:model-value="(v: string) => patchBlueprintInk(selectedLocal as DealLayer, 'ink', v)" />
                  <StudioColor :model-value="blueprintParams.inkDim" @update:model-value="(v: string) => patchBlueprintInk(selectedLocal as DealLayer, 'inkDim', v)" />
                </div>
                <StudioSelect label="Palette" :options="BLUEPRINT_PRESET_NAMES as any"
                  :model-value="blueprintPreset" @update:model-value="(v: any) => applyBlueprintPreset(selectedLocal as DealLayer, v)" />
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
                <!-- The ordered palette. Spread is a distance along THIS order (rule 5), so the
                     swatches read left to right in palette order; editing one keeps the rest. -->
                <div class="panel-label mt-1">Inks</div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <StudioColor v-for="(ink, i) in paneInks" :key="i" :model-value="ink"
                    @update:model-value="(v: string) => patchPaneInk(selectedLocal as DealLayer, i, v)" />
                </div>
                <StudioSelect label="Palette" :options="PANE_PRESET_NAMES as any"
                  :model-value="panePreset" @update:model-value="(v: any) => applyPanePreset(selectedLocal as DealLayer, v)" />
              </div>
              <!-- Oddgrid / Static: the shader styles. The style IS the effect, so the
                   shared shader-fill editor mounts with its picker locked, its own seed
                   / speed / input / anchor rows hidden (the Mosaic owns the seed; speed
                   is 0; the input is meaningless here; the box IS the shader's frame —
                   see the deal branch in useCompositorLayers). The effect's Looks are
                   its Palette. -->
              <div v-else-if="isMosaicShaderFill((selectedLocal as any).cellFill)" class="mt-2 flex flex-col gap-1.5">
                <ShaderFillEditor :model-value="mosaicShader(selectedLocal as DealLayer)!" lock-effect
                  :show-anchor="false" :show-speed="false" :show-seed="false" :show-input="false"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { shader: v } as any)" />
                <StudioSelect label="Palette" :options="mosaicLookOptions"
                  :model-value="mosaicLook" @update:model-value="(v: any) => applyMosaicLookTo(selectedLocal as DealLayer, v)" />
              </div>
              <!-- Tiles: the seeded grid itself — density / inset / regularity / merge. -->
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
              <!-- The vocabulary palette only shows when something reads it: Tiles always,
                   Modular / Pane only while they have no inks of their own. Parcel and
                   Mosh carry their own colours (see dealVocabDrivesLook). Labelled "Inks"
                   beside a style that already has a Palette control of its own, so two
                   adjacent rows never both say Palette. -->
              <div v-if="vocabDrivesLook" class="mt-2">
                <div class="panel-label mb-1.5">{{ (selectedLocal as any).cellFill && (selectedLocal as any).cellFill !== 'solid' ? 'Inks' : 'Palette' }}</div>
                <StudioSegmented :options="DEAL_VOCABS as any" :model-value="(selectedLocal as any).vocab"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { vocab: v })" />
                <p v-if="(selectedLocal as any).cellFill && (selectedLocal as any).cellFill !== 'solid'" class="mt-1 text-[10px] text-white/30 leading-snug">This style has no inks of its own, so it draws from this palette.</p>
              </div>
              <div class="mt-2 flex items-center gap-2">
                <StudioButton variant="secondary" @click="rerollDeal(selectedLocal as DealLayer)">New variation</StudioButton>
                <div class="min-w-0 flex-1">
                  <StudioSlider label="Seed" :min="1" :max="9999" :step="1" :default="42" :bindable="false"
                    :model-value="(selectedLocal as DealLayer).grid.gen.seed"
                    @update:model-value="(v: number) => setDealSeed(selectedLocal as DealLayer, v)" />
                </div>
              </div>
            </StudioSection>
          </template>

          <!-- Scatter (kind 'scatter'): Style first — which marks these are — then
               that style's dials, its Palette, and New variation. The dials are
               rendered from the style's REGISTRY ROW (lib/compositor/scatter), so a
               new style ships its controls with its module and needs no block here. -->
          <template v-if="selectedLocal.kind === 'scatter'">
            <StudioSection title="Style">
              <StudioSelect label="Style" :options="SCATTER_STYLE_LABELS as any"
                :model-value="scatterLabelOf((selectedLocal as ScatterLayer).style)"
                @update:model-value="(v: any) => setScatterStyle(selectedLocal as ScatterLayer, v)" />
              <div class="mt-2 flex flex-col gap-1.5">
                <template v-for="c in scatterRow.controls" :key="c.key">
                  <StudioSlider v-if="c.kind === 'slider'" :label="c.label" :min="c.min" :max="c.max" :step="c.step" :bindable="false"
                    :model-value="(scatterDials[c.key] as number)"
                    @update:model-value="(v: number) => patchScatterParam(selectedLocal as ScatterLayer, c.key, c.step >= 1 ? Math.round(v) : v)" />
                  <StudioSelect v-else :label="c.label" :options="scatterOptionLabels(asScatterSelect(c))"
                    :model-value="scatterOptionLabel(asScatterSelect(c), scatterDials[c.key])"
                    @update:model-value="(v: any) => patchScatterParam(selectedLocal as ScatterLayer, c.key, scatterOptionValue(asScatterSelect(c), v))" />
                </template>
                <!-- The ordered inks the style paints with, one swatch per role (Chaff: ground /
                     ink; Strand: ground / plate / fill; Husk: ground / silhouette / fill). Editing
                     one keeps the rest and drops the Palette select to custom (presetOf → null),
                     the same way Pane's ink row behaves. -->
                <div class="panel-label mt-1">Inks</div>
                <div class="flex flex-wrap items-center gap-2">
                  <div v-for="(ink, i) in scatterInks" :key="i" class="flex items-center gap-1">
                    <StudioColor :model-value="ink"
                      @update:model-value="(v: string) => patchScatterInk(selectedLocal as ScatterLayer, i, v)" />
                    <span class="text-[10px] text-white/45">{{ scatterRow.inkLabels[i] ?? `Ink ${i + 1}` }}</span>
                  </div>
                </div>
                <StudioSelect label="Palette" :options="scatterRow.presetNames as any"
                  :model-value="scatterPreset" @update:model-value="(v: any) => applyScatterPreset(selectedLocal as ScatterLayer, v)" />
              </div>
              <div class="mt-2 flex items-center gap-2">
                <StudioButton variant="secondary" @click="rerollScatter(selectedLocal as ScatterLayer)">New variation</StudioButton>
                <div class="min-w-0 flex-1">
                  <StudioSlider label="Seed" :min="1" :max="9999" :step="1" :default="DEFAULT_SCATTER_SEED" :bindable="false"
                    :model-value="(selectedLocal as ScatterLayer).seed"
                    @update:model-value="(v: number) => setScatterSeed(selectedLocal as ScatterLayer, v)" />
                </div>
              </div>
            </StudioSection>
          </template>

          <!-- Image tint: fill blended over the image, clipped to its alpha -->
          <template v-if="selectedLocal.kind === 'image'">
            <StudioSection title="Image">
              <div>
                <div class="panel-label mb-1.5">Tint</div>
                <FillControl allow-none :model-value="(selectedLocal as any).tint"
                  @update:model-value="(v: any) => setLocal(selectedLocal!.id, { tint: v })" />
                <div v-if="hasTint(selectedLocal)" class="mt-1.5 flex flex-col gap-1.5">
                  <select :value="(selectedLocal as any).tintBlend || 'normal'"
                    class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer capitalize"
                    @change="setLocal(selectedLocal!.id, { tintBlend: ($event.target as HTMLSelectElement).value } as any)">
                    <option v-for="m in LOCAL_BLEND_MODES" :key="m" :value="m">{{ m.replace('_', ' ') }}</option>
                  </select>
                  <StudioSlider :model-value="Math.round(((selectedLocal as any).tintOpacity ?? 1) * 100)"
                    @update:model-value="(n) => setLocal(selectedLocal!.id, { tintOpacity: Math.max(0, Math.min(1, (n || 0) / 100)) } as any)"
                    label="Opacity" :min="0" :max="100" :step="1" :bindable="false" />
                </div>
              </div>
            </StudioSection>
          </template>

          <!-- Size: W / H with aspect-ratio lock (shapes & images) -->
          <StudioSection title="Transform">
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

            <!-- Common: align the layer to the frame (edges + centres) -->
            <div>
              <div class="panel-label mb-1.5">Align to frame</div>
              <div class="flex items-center gap-1">
                <button v-for="a in ALIGN_FRAME_BTNS" :key="a.mode" :title="a.title"
                  class="flex-1 flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded py-1.5 text-white/60 hover:text-yellow-400 hover:border-yellow-400/50 transition-colors"
                  @click="alignToFrame(a.mode)">
                  <component :is="a.icon" class="size-3.5" />
                </button>
              </div>
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
          </StudioSection>

          <!-- Distort: slant (affine) + perspective + free corner-pin (Distort tool) -->
          <StudioSection title="Distort and blend">
            <div>
              <div class="panel-label mb-1.5">Distort</div>
              <div class="grid grid-cols-2 gap-3 mb-2">
                <StudioSlider label="Slant X" :model-value="(selectedLocal as any).skewX || 0"
                  :min="-60" :max="60" :step="1" :bindable="false"
                  @update:model-value="(v) => setLocal(selectedLocal!.id, { skewX: v } as any)" />
                <StudioSlider label="Slant Y" :model-value="(selectedLocal as any).skewY || 0"
                  :min="-60" :max="60" :step="1" :bindable="false"
                  @update:model-value="(v) => setLocal(selectedLocal!.id, { skewY: v } as any)" />
              </div>
              <div class="mb-2">
                <StudioSlider :model-value="Math.round(perspectiveAmount(selectedLocal) * 100)" @update:model-value="(n) => setPerspective(selectedLocal!.id, (n || 0) / 100)"
                  label="Perspective" :min="-80" :max="80" :step="1" :bindable="false" />
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
          </StudioSection>


          <!-- Layer mask: clip this layer to another layer's silhouette (cross-source) -->
          <StudioSection title="Mask and crop">
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
                  <StudioSlider label="Offset" :model-value="breakOffset()"
                    :min="0" :max="1" :step="0.01" :bindable="false"
                    @update:model-value="(v) => setBreakOffset(v)" />
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
          </StudioSection>

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
              :class="isEditingRegionOf(selectedLocal.id) ? 'bg-white text-neutral-900' : 'bg-white/[0.06] hover:bg-white/12 text-white/85'"
              @click="editRegionStart(selectedLocal.id)"
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
             properties (Background → Post-processing → Grid → templates)
             overflow the window and the lower controls become unreachable. -->
        <div class="p-4 flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
          <!-- Canvas background fill (bottom-most; baked into the frame) -->
          <StudioSection title="Background">
            <FillControl allow-none :model-value="background"
              @update:model-value="(v: any) => setBackground(v)" />
            <p class="mt-1.5 text-[10px] text-white/30 leading-snug">Fills behind every layer and bakes into the frame. An opaque generated image will sit on top of it.</p>
          </StudioSection>
          <!-- Colours: the frame's palette as slots, and a palette family to swap it for -->
          <StudioSection title="Colours">
            <div data-testid="frame-colours">
              <p v-if="!frameColourSlots.length" class="text-[11px] text-white/40 italic">Add a background, text or a shape to see the frame's colours.</p>
              <template v-else>
                <ColourSlots :slots="frameColourSlots" @recolour="reassignSlot" />
                <p class="mt-2 mb-1.5 text-[11px] text-white/45">Pick a palette to recolour the frame. Things that share a colour keep sharing one; the darkest stays darkest.</p>
                <div data-testid="recolour-images" class="mb-1.5">
                  <StudioSwitch v-model="recolourImages" label="Images too" hint="Photos take the palette as a gradient map." />
                </div>
                <PalettePicker :key="compositor?.id ?? 'frame-recolour'" mode="stops" :seed="recolourSeed" @apply-family="applyFamilyToFrame" @apply-stops="applyStopsToFrame" />
              </template>
            </div>
          </StudioSection>
          <!-- Whole-frame post-processing (after all layers composite) -->
          <StudioSection title="Post-processing">
            <p class="text-[10px] text-white/30 leading-snug mb-2">Grades the whole frame after all layers composite — bakes into renders, exports and motion stills.</p>
            <PostEffectsControls :effects="postEffects" @update="(fx: any[]) => setPostEffects(fx as any)" />
          </StudioSection>
          <!-- Grid — a layout guide (explicit or seeded-generated) that snaps
               drag/resize and, optionally, draws an editor-only overlay. Never
               baked into the render (see the comment above `gridConfig`). -->
          <StudioSection title="Grid">
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
            </div>
          </StudioSection>
          <!-- Expressive arrange (a whole group is selected) -->
          <StudioSection v-if="soleSelectedGroup" title="Arrange">
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
              <StudioSlider label="Jitter" :model-value="soleSelectedGroupExpr.jitter"
                :min="0" :max="1" :step="0.05" :bindable="false"
                @update:model-value="(v) => setGroupExpressive(soleSelectedGroup!, { jitter: v })" />
              <StudioSlider label="Rotation" :model-value="soleSelectedGroupExpr.rotation"
                :min="0" :max="1" :step="0.05" :bindable="false"
                @update:model-value="(v) => setGroupExpressive(soleSelectedGroup!, { rotation: v })" />
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
          </StudioSection>
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

    <!-- Add-effect menu. Teleported because the layer panel scrolls and would clip an
         absolutely positioned popover. -->
    <Teleport to="body">
      <div v-if="fxMenuLayerId" data-fx-menu
        class="fixed z-[200] w-48 overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#161616] p-1 shadow-2xl"
        :style="{ top: `${fxMenuPos.top}px`, left: `${fxMenuPos.left}px`, maxHeight: `${fxMenuPos.maxHeight}px` }" @pointerdown.stop>
        <!-- Outlines come first: on a stroked layer it is the entry most often wanted, and
             the rule keeps it from reading as one more effect kind. -->
        <template v-if="fxMenuOffersStroke">
          <button type="button" data-testid="add-stroke"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
            @click.stop="pickStrokeAdd(fxMenuLayerId!)">Add outline</button>
          <div class="my-1 h-px bg-white/10" />
        </template>
        <button v-for="kind in EFFECT_ORDER" :key="kind" type="button"
          data-testid="add-effect-item" :data-kind="kind" :disabled="fxKindDisabled(kind)"
          :title="fxKindDisabledTitle(kind)"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-white/80 cursor-pointer"
          @click.stop="pickFxKind(kind)">{{ EFFECT_LABELS[kind] }}</button>
      </div>
    </Teleport>

    <!-- Right-click menu for an image layer. CanvasContextMenu self-teleports to
         body (its own root is a Teleport), so it's already immune to the pan/zoom
         stage's transform — no wrapper needed here. -->
    <CanvasContextMenu v-if="imageCtxMenu" :x="imageCtxMenu.x" :y="imageCtxMenu.y" :items="imageCtxMenu.items" @close="imageCtxMenu = null" />
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

/* Toolbar swap: the outgoing cluster (Select + canvas tools) collapses while the
   inpaint cluster expands, CONCURRENTLY, so it reads as one fluid morph instead
   of a hard cut then a separate expand. Each side is a single grid track
   animating 0fr↔1fr — grows/shrinks to intrinsic width without squishing the
   buttons (unlike a scaleX). The resting state lives here so enter-from wins. */
.tb-cluster {
  display: grid;
  grid-template-columns: 1fr;
  align-items: center;
}
/* Enter (expand-in) and leave (collapse-out) share IDENTICAL timing + easing so
   the two sides mirror each other exactly — no lurch from a fast-out/slow-in
   mismatch. */
.tb-expand-enter-active,
.tb-expand-leave-active {
  transition:
    grid-template-columns 0.34s cubic-bezier(0.33, 0.7, 0.15, 1),
    opacity 0.26s cubic-bezier(0.33, 0.7, 0.15, 1);
}
.tb-expand-enter-from,
.tb-expand-leave-to {
  grid-template-columns: 0fr;
  opacity: 0;
}
/* Clip to the animating track WHILE animating only — the min-width:0 + overflow
   lets the fr track collapse past min-content. Never at rest, or the popovers
   (model dropdown, shape/insert menus) that open above the bar would be clipped. */
.tb-expand-enter-active > .tb-cluster-inner,
.tb-expand-leave-active > .tb-cluster-inner {
  overflow: hidden;
  min-width: 0;
}
</style>
