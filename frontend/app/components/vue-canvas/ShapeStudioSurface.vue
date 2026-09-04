<script setup lang="ts">
// Full-screen editor for the Shape Studio node — a procedural 2D-vector
// "clone and arrange" logo generator (geoshape). Modeled on
// VectorTypeSurface/GradientStudioSurface for the shell wiring (StudioModalShell,
// StudioControlPanel, StudioLayerStack, useStudioAutosave, useStudioAgent, the
// sailor:*StudioOutput image-output path) but the RENDERER is a plain 2D `<canvas>`
// painted by `drawToCanvas` off the `geoshape/render.ts` pipeline, re-run via an
// rAF-coalesced demand drain (see `drainRenders`) rather than a persistent frame loop.
//
// LAYERS: the studio now edits a `GeoStudioDoc` — a STACK of independent marks
// (each a full `GeoShapeConfig`) plus a stack-level intersection palette and one
// shared frame. The left rail (StudioLayerStack) selects a layer; the right panel
// scopes to that layer's `mark`. Deselecting (click the active row again) shows the
// composite properties (Frame + — Phase 2 — Intersections). A one-layer doc renders
// identically to the old single-mark studio (see studio.ts migration).
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Dices } from 'lucide-vue-next'
import type { ControlSpec } from '~/lib/spacetype/effect'
import type { GeoShapeConfig } from '~/lib/geoshape/config'
import {
  renderStudio, studioToSvg, drawToCanvas, warmPaints, studioWarmPaints, hasAsyncPaint, studioFramePad,
} from '~/lib/geoshape/render'
import {
  LAYER_MAX, mergeLayer, studioDocFromPersisted, normalizeBackground, type GeoStudioDoc, type GeoLayer,
} from '~/lib/geoshape/studio'
import { reroll } from '~/lib/geoshape/randomize'
import { GEO_CONTROLS, GEO_SECTIONS, visibleGeoControls, type GeoControl } from '~/lib/geoshape/controls'
import { geoAgentControls, GEO_GUIDANCE } from '~/lib/geoshape/agentControls'
import { distributeToGeoFills } from '~/lib/geoshape/distribute'
import StudioModalShell from '~/components/vue-canvas/StudioModalShell.vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioLayerStack from '~/components/vue-canvas/StudioLayerStack.vue'
import StudioActionsFooter from '~/components/vue-canvas/studio/StudioActionsFooter.vue'
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioControlPanel from '~/components/vue-canvas/studio/StudioControlPanel.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import type { Paint } from '~/lib/compositor/paint'
import type { PaletteFamily } from '~/lib/color/seedFamily'
import type { GradientStop } from '~/lib/color/harmony'
import { useStudioAgent } from '~/composables/useStudioAgent'
import { makeConfigParams } from '~/lib/agent/configParams'
import { docAspect } from '~/lib/agent/takeThumbs'
import { useStudioAutosave } from '~/lib/studio/autosave'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'

// `nodes` is optional (defaults to []) so this surface can be smoke-tested standalone
// before it is wired into VueNodeCanvas as `nodeId` + the live `nodes` array.
const props = withDefaults(defineProps<{ nodeId: string; nodes?: any[]; edges?: any[] }>(), { nodes: () => [] })
const emit = defineEmits<{ (e: 'close'): void }>()

const { recordAsset } = useProjectGenerations()
const { activeTab } = useTabs()

function currentNode(): any | undefined {
  return props.nodes?.find((n: any) => String(n?.id) === String(props.nodeId))
}

// ── canvas dimensions (NOT part of the doc — mirrors every other studio's separate
// W/H/aspectKey persisted alongside the effect config rather than inside it) ──
const ASPECTS: Record<string, number> = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '3:2': 3 / 2, '2:3': 2 / 3 }
const ASPECT_OPTIONS = Object.keys(ASPECTS)

// ── doc (single source of truth) — hydrate synchronously from the node's persisted
// blob, migrating a legacy single-mark `{ config }` into a one-layer doc (studio.ts).
const persisted = currentNode()?.data?.properties?.sailor_shapeStudio as
  { doc?: unknown; config?: unknown; canvasW?: number; canvasH?: number; aspectKey?: string } | undefined

const doc = ref<GeoStudioDoc>(studioDocFromPersisted(persisted))
const aspectKey = ref<string>(persisted?.aspectKey && ASPECTS[persisted.aspectKey] ? persisted.aspectKey : '1:1')
const canvasW = ref<number>(typeof persisted?.canvasW === 'number' ? persisted.canvasW : 1024)
const canvasH = ref<number>(
  typeof persisted?.canvasH === 'number' ? persisted.canvasH : Math.round(1024 / (ASPECTS[aspectKey.value] ?? 1)),
)
watch(aspectKey, (k) => { canvasH.value = Math.max(16, Math.round(canvasW.value / (ASPECTS[k] ?? 1))) })

// ── layer selection. `activeLayer` is an index, or -1 for NO selection (which shows
// the composite properties: Frame + Intersections). `activeLayerObj`/`activeMark`
// fall back to layer 0 so proxies/agent never dereference undefined even when nothing
// is selected (the per-layer panel is hidden then, so the fallback is never shown).
const activeLayer = ref<number>(0)
const isSelected = computed(() => activeLayer.value >= 0 && activeLayer.value < doc.value.layers.length)
const activeLayerIdx = computed(() => (isSelected.value ? activeLayer.value : 0))
const activeLayerObj = computed<GeoLayer>(() => doc.value.layers[activeLayerIdx.value]!)
const activeMark = computed<GeoShapeConfig>(() => activeLayerObj.value.mark)
/** The same mark, but inside ANY copy of the doc — the live one for the panel, a
 *  clone for a take's thumbnail. */
const markIn = (d: GeoStudioDoc): GeoShapeConfig | undefined => d?.layers?.[activeLayerIdx.value]?.mark

function saveConfig() {
  const n = currentNode(); if (!n) return
  n.data ||= {}; n.data.properties ||= {}
  n.data.properties.sailor_shapeStudio = {
    doc: JSON.parse(JSON.stringify(doc.value)),
    canvasW: canvasW.value, canvasH: canvasH.value, aspectKey: aspectKey.value,
  }
}
function closeEditor() {
  try { saveConfig() } catch (e) { console.error('[shape-studio] saveConfig failed', e) }
  emit('close')
}

const { saving: autoSaving, saved: autoSaved } = useStudioAutosave(
  () => ({ doc: doc.value, canvasW: canvasW.value, canvasH: canvasH.value, aspectKey: aspectKey.value }),
  saveConfig,
)

// ── in-product agent — "tune" the SELECTED LAYER's mark in natural language. The
// proxy + vocabulary are rooted at the active layer's `mark`, so the geoshape control
// keys stay flat (1:1 with GeoShapeConfig) exactly as before; the agent edits whichever
// layer is selected, matching every other studio's active-layer convention.
const { getLocalSetting } = useLocalSettings()
const paramsProxy = makeConfigParams(() => activeMark.value)
const activeAgentControls = computed(() => geoAgentControls(activeMark.value))
const shapeAgent = useStudioAgent({
  controls: () => activeAgentControls.value, params: paramsProxy, label: () => 'Shape studio',
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  guidance: () => GEO_GUIDANCE,
  // Four Takes. The agent patches the SELECTED layer's mark, but a tile is drawn
  // from the WHOLE doc — a take previewed live shows the composite, so a thumb of
  // the isolated mark would disagree with the thing it is a picture of.
  takes: {
    studio: 'shape',
    config: () => doc.value,
    paramsOf: c => makeConfigParams(() => markIn(c as GeoStudioDoc)),
    // The canvas shape lives on the NODE, not in the doc a take carries, so the
    // tile can only be truthful if the studio hands it over.
    aspect: () => docAspect(canvasW.value, canvasH.value),
  },
})

// ── StudioControlPanel wiring (per-layer). GEO_CONTROLS/GEO_SECTIONS drives every
// slider/select/switch/color except the bespoke paint slots (fill/overlapFill/stroke)
// and the seed/re-roll row. `seed` is dropped (the bespoke row shows it); `padding` is
// dropped too — it is now the STACK frame (doc.padding), shown in the no-selection Frame
// panel, not a per-layer knob.
const panelGeoControls = GEO_CONTROLS.filter((c) => c.key !== 'seed' && c.key !== 'padding')
const visibleControlSet = computed(() => new Set<GeoControl>(visibleGeoControls(activeMark.value)))
function controlVisible(c: ControlSpec): boolean {
  return visibleControlSet.value.has(c as GeoControl)
}
function setGeoControl(key: string, value: string | number | boolean | Paint | Paint[]) {
  paramsProxy[key] = value as string | number
}
function paramValue(key: string): string | number | boolean {
  return paramsProxy[key] as string | number | boolean
}

// ── stack-level controls (composite properties, shown when nothing is selected).
// `padding` is the single frame margin around the whole composite; the range matches
// the per-mark padding lever (negative overscans/bleeds — see render.ts framePad).
const stackProxy = makeConfigParams(() => doc.value)
const stackControls: ControlSpec[] = [
  {
    key: 'padding', label: 'Padding', kind: 'slider', min: -400, max: 200, step: 1, default: 40, group: 'Frame',
    hint: 'Space framed around the whole composite. Lower to grow the marks toward the edges; 0 fills edge-to-edge; negative bleeds past the edges.',
  } as ControlSpec,
]
function setStackControl(key: string, value: string | number | boolean | Paint | Paint[]) {
  stackProxy[key] = value as string | number
}
function stackValue(key: string): string | number | boolean {
  return stackProxy[key] as string | number | boolean
}

// ── Intersections (stack-level cross-layer overlap palette) — the payoff colouring:
// where ≥2 layers cross, the region is painted from `overlap.fills` by `overlap.order`
// (+ crossingMode). Mirrors the per-mark fills-list editor, but on `doc.overlap`.
const OVERLAP_ORDERS = ['created', 'depth', 'leftRight', 'topBottom', 'rows', 'columns', 'centerOut', 'around']
const OVERLAP_CROSSINGS = ['depth', 'split']
function addOverlapPaletteFill() { doc.value.overlap.fills = [...doc.value.overlap.fills, '#7c3aed'] }
function removeOverlapPaletteFill(i: number) {
  if (doc.value.overlap.fills.length <= 1) return
  doc.value.overlap.fills = doc.value.overlap.fills.filter((_, j) => j !== i)
}
function updateOverlapPaletteFill(i: number, p: Paint) {
  doc.value.overlap.fills = doc.value.overlap.fills.map((x, j) => (j === i ? p : x))
}

// ── Background — full-composite fill painted behind every layer. `null` is
// transparent; `normalizeBackground` collapses the FillControl none-sentinels
// ('none'/'') to that same `null` (see studio.ts). Direct doc mutation, like the
// overlap-palette setters above — the deep watch in useStudioAutosave persists it.
function setBackground(p: Paint) {
  doc.value.background = normalizeBackground(p)
}

// ── re-roll — regenerates every UNLOCKED section of the SELECTED layer's mark from a
// fresh derived seed. `mark.locks` starts empty, so a plain click re-rolls the whole
// active mark.
function rerollConfig() {
  const l = activeLayerObj.value
  l.mark = reroll(l.mark, l.mark.locks)
}

// ── layer rail intents ─────────────────────────────────────────────────────────
// Identity-based labels (derived from each layer's shape, de-duped with ordinals) so
// reordering doesn't renumber and break references — same rationale as Gradient's
// layerLabels.
function titleCase(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }
function layerLabel(i: number): string {
  const layers = doc.value.layers
  const shape = layers[i]?.mark.shape
  if (!shape) return `Layer ${i + 1}`
  let total = 0, ord = 0
  for (let j = 0; j < layers.length; j++) {
    if (layers[j]!.mark.shape === shape) { total++; if (j === i) ord = total }
  }
  return total > 1 ? `${titleCase(shape)} ${ord}` : titleCase(shape)
}
const railLayers = computed(() => doc.value.layers.map((l, i) => ({ label: layerLabel(i), enabled: l.enabled })))

// Click a row to select it; click the ALREADY-active row again to deselect → the
// right panel flips to the composite (Frame/Intersections) properties.
function onSelectLayer(i: number) { activeLayer.value = activeLayer.value === i ? -1 : i }
// A new/duplicated layer lands EXACTLY on top of an identical mark reads as one
// shape — editing it then looks like it "does nothing" or "changes everything".
// So a fresh layer is nudged diagonally off the layer it stacks onto: its
// independence is immediately visible, and the partial overlap feeds the
// Intersections colouring. Nudge ~half the mark's radius so it clearly overlaps
// rather than clearing it. Users who want a concentric stack can zero the offset.
function addLayer() {
  if (doc.value.layers.length >= LAYER_MAX) return
  const idx = doc.value.layers.length
  const layer = mergeLayer({})
  const prev = doc.value.layers[idx - 1]
  const nudge = Math.max(60, Math.round(layer.mark.size * 0.5))
  layer.offset.x = (prev?.offset.x ?? 0) + nudge
  layer.offset.y = (prev?.offset.y ?? 0) + nudge
  doc.value.layers.push(layer)
  activeLayer.value = idx
}
function duplicateLayer(i: number) {
  const src = doc.value.layers[i]; if (!src) return
  const copy = mergeLayer(JSON.parse(JSON.stringify(src)))
  copy.layerId = mergeLayer({}).layerId // fresh id so the two are addressable apart
  const nudge = Math.max(40, Math.round(copy.mark.size * 0.35))
  copy.offset.x += nudge // offset the copy so it isn't hidden behind its source
  copy.offset.y += nudge
  doc.value.layers.splice(i + 1, 0, copy)
  activeLayer.value = i + 1
}
function removeLayer(i: number) {
  if (doc.value.layers.length <= 1) return
  doc.value.layers.splice(i, 1)
  // Keep the SAME layer selected: removing one BELOW the active index shifts the
  // active layer down by one; clamp if the active (or a higher) layer was removed.
  if (i < activeLayer.value) activeLayer.value--
  if (activeLayer.value >= doc.value.layers.length) activeLayer.value = doc.value.layers.length - 1
}
function reorderLayer(from: number, to: number) {
  const layers = doc.value.layers
  if (from < 0 || from >= layers.length || to < 0 || to >= layers.length) return
  // Follow the user's CURRENT selection by id, not the dragged row — reordering a
  // non-active layer must not hijack the selection to it.
  const activeId = isSelected.value ? layers[activeLayer.value]?.layerId : null
  const [m] = layers.splice(from, 1)
  layers.splice(to, 0, m!)
  if (activeId) {
    const idx = layers.findIndex((l) => l.layerId === activeId)
    if (idx >= 0) activeLayer.value = idx
  }
}
function toggleLayer(i: number) {
  const l = doc.value.layers[i]; if (l) l.enabled = !l.enabled
}

// ── Paint — fill/overlapFill are full `Paint`, edited via FillControl. `stroke` stays
// a plain solid string, nullable. All bound to the SELECTED layer's mark.
const lastStrokeColor = ref(activeMark.value.stroke ?? '#000000')
const strokeEnabled = computed<boolean>({
  get: () => activeMark.value.stroke !== null,
  set: (v: boolean) => { activeMark.value.stroke = v ? lastStrokeColor.value : null },
})
const strokeHex = computed<string>({
  get: () => activeMark.value.stroke ?? lastStrokeColor.value,
  set: (v: string) => { lastStrokeColor.value = v; activeMark.value.stroke = v },
})
// Re-seed the remembered stroke colour when switching layers, so toggling stroke
// on layer B restores B's own last colour rather than a different layer's.
watch(activeLayer, () => {
  const s = activeMark.value.stroke
  if (s != null) lastStrokeColor.value = s
})

// ── fills / overlapFills list editors — operate on the SELECTED layer's mark via the
// same paramsProxy write path every control uses (reassigns a fresh array so the deep
// watch trips and the preview re-renders).
function addFill() { setGeoControl('fills', [...activeMark.value.fills, '#4c6ef5']) }
function removeFill(i: number) {
  if (activeMark.value.fills.length <= 1) return
  setGeoControl('fills', activeMark.value.fills.filter((_, j) => j !== i))
}
function updateFill(i: number, p: Paint) {
  setGeoControl('fills', activeMark.value.fills.map((x, j) => (j === i ? p : x)))
}
const fillDrag = reactive<{ from: number; over: number }>({ from: -1, over: -1 })
function fillDragStart(i: number, e: DragEvent) {
  fillDrag.from = i; fillDrag.over = i
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
    const row = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null
    if (row) e.dataTransfer.setDragImage(row, 14, 14)
  }
}
function fillDragOver(i: number, e: DragEvent) { e.preventDefault(); fillDrag.over = i }
function fillDrop(i: number) {
  if (fillDrag.from !== i && fillDrag.from >= 0) {
    const next = [...activeMark.value.fills]
    const [m] = next.splice(fillDrag.from, 1)
    next.splice(i, 0, m!)
    setGeoControl('fills', next)
  }
  fillDragEnd()
}
function fillDragEnd() { fillDrag.from = -1; fillDrag.over = -1 }

// Seed-engine palette → discrete fills (Task 12: first DISCRETE-palette consumer —
// lands N palette colors as N separate fills rather than a gradient projection).
// Flips fillStrategy off 'single' so the write is visible immediately.
// Shared by all three PalettePicker panes: the seed pane emits apply-family
// (fam.hexes), gallery/harmony emit apply-stops / apply-literal-stops
// (GradientStop[], mapped to hexes at the binding) — see the @apply-* bindings
// on the picker below.
function applyGeoPalette(hexes: string[]) {
  const next = distributeToGeoFills(activeMark.value, hexes)
  setGeoControl('fills', next.fills)
  setGeoControl('fillStrategy', next.fillStrategy)
}
function applyPaletteToFills(fam: PaletteFamily) {
  applyGeoPalette(fam.hexes)
}

function addOverlapFill() { setGeoControl('overlapFills', [...activeMark.value.overlapFills, '#ffffff']) }
function removeOverlapFill(i: number) {
  if (activeMark.value.overlapFills.length <= 1) return
  setGeoControl('overlapFills', activeMark.value.overlapFills.filter((_, j) => j !== i))
}
function updateOverlapFill(i: number, p: Paint) {
  setGeoControl('overlapFills', activeMark.value.overlapFills.map((x, j) => (j === i ? p : x)))
}

// ── preview: a plain 2D canvas, event-driven (rAF-coalesced demand drain) ─────────
const canvas = ref<HTMLCanvasElement | null>(null)
const exporting = ref(false)
const svgExporting = ref(false)
const actionError = ref('')
let actionErrorTimer: ReturnType<typeof setTimeout> | null = null
function setActionError(msg: string) {
  actionError.value = msg
  if (actionErrorTimer) clearTimeout(actionErrorTimer)
  actionErrorTimer = setTimeout(() => { actionError.value = '' }, 5000)
}

const PREVIEW_MAX = 620
function previewDims() {
  const el = canvas.value
  const ar = Math.max(0.1, canvasW.value / Math.max(1, canvasH.value))
  const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2)
  const wrap = el?.parentElement
  const availW = wrap?.clientWidth || PREVIEW_MAX
  const availH = wrap?.clientHeight || Math.round(PREVIEW_MAX / ar)
  let cssW = Math.min(availW, PREVIEW_MAX)
  let cssH = cssW / ar
  if (cssH > availH) { cssH = availH; cssW = availH * ar }
  cssW = Math.max(1, Math.round(cssW)); cssH = Math.max(1, Math.round(cssH))
  return { cssW, cssH, w: Math.max(1, Math.round(cssW * dpr)), h: Math.max(1, Math.round(cssH * dpr)) }
}

let lastW = 0, lastH = 0
let renderToken = 0
async function renderPreview() {
  const el = canvas.value
  if (!el) return
  const { cssW, cssH, w, h } = previewDims()
  el.style.width = `${cssW}px`
  el.style.height = `${cssH}px`
  if (w !== lastW || h !== lastH) { el.width = w; el.height = h; lastW = w; lastH = h }
  const ctx = el.getContext('2d')
  if (!ctx) return
  const token = ++renderToken
  try {
    const shapes = await renderStudio(doc.value)
    if (token !== renderToken) return // superseded by a later render
    const pad = studioFramePad(doc.value)
    drawToCanvas(shapes, ctx, el.width, el.height, pad, doc.value.background)
    // Image/shader fills resolve to FALLBACK_FILL until warmed — warm-then-repaint.
    const paints = studioWarmPaints(shapes, doc.value.background)
    if (hasAsyncPaint(paints)) {
      await warmPaints(paints, { w: el.width, h: el.height })
      if (token !== renderToken) return
      drawToCanvas(shapes, ctx, el.width, el.height, pad, doc.value.background)
    }
  } catch (e) {
    console.error('[shape-studio] preview render failed', e)
  }
}

let rafId: number | null = null
let rendering = false
let dirty = false
async function drainRenders() {
  rafId = null
  if (rendering) return
  rendering = true
  try {
    while (dirty) { dirty = false; await renderPreview() }
  } finally {
    rendering = false
    if (dirty && rafId == null) rafId = requestAnimationFrame(() => { void drainRenders() })
  }
}
function scheduleRender() {
  dirty = true
  if (rafId == null && !rendering) rafId = requestAnimationFrame(() => { void drainRenders() })
}
watch(doc, scheduleRender, { deep: true })
watch([canvasW, canvasH], scheduleRender)

function onWindowResize() { scheduleRender() }

onMounted(() => {
  void renderPreview()
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  saveConfig()
  window.removeEventListener('resize', onWindowResize)
  if (rafId != null) cancelAnimationFrame(rafId)
  if (actionErrorTimer) clearTimeout(actionErrorTimer)
})

// ── outputs ──────────────────────────────────────────────────────────────────────
// Rasterize at the FULL export resolution (canvasW × canvasH), not the preview store.
async function rasterizePng(): Promise<Blob | null> {
  const shapes = await renderStudio(doc.value)
  const off = document.createElement('canvas')
  off.width = Math.max(1, Math.round(canvasW.value))
  off.height = Math.max(1, Math.round(canvasH.value))
  const ctx = off.getContext('2d')
  if (!ctx) return null
  // A ONE-SHOT render gets no second chance — warm BEFORE the only draw.
  const paints = studioWarmPaints(shapes, doc.value.background)
  if (hasAsyncPaint(paints)) await warmPaints(paints, { w: off.width, h: off.height })
  drawToCanvas(shapes, ctx, off.width, off.height, studioFramePad(doc.value), doc.value.background)
  return await new Promise<Blob | null>((resolve) => off.toBlob(resolve, 'image/png'))
}

async function exportPng() {
  exporting.value = true
  actionError.value = ''
  try {
    const blob = await rasterizePng()
    if (!blob) throw new Error('rasterize failed')
    const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
    const [filename] = await uploadFrameBatch([blob], 'shape_img')
    if (filename) {
      await recordAsset(activeTab.value?.projectUuid, 'image', filename)
      window.dispatchEvent(new CustomEvent('sailor:shapeStudioOutput', {
        detail: { sourceNodeId: props.nodeId, nodeType: 'Image', widgetOverrides: { image: filename } },
      }))
      closeEditor()
    }
  } catch (e) {
    console.error('[shape-studio] export failed', e)
    setActionError('Export failed — please try again')
  } finally {
    exporting.value = false
  }
}

async function downloadPng() {
  try {
    const blob = await rasterizePng()
    if (blob) downloadBlobAsFile(blob, `shape_${Date.now()}.png`)
  } catch (e) {
    console.error('[shape-studio] PNG download failed', e)
    setActionError('PNG download failed — please try again')
  }
}

async function exportSvg() {
  svgExporting.value = true
  actionError.value = ''
  try {
    const svg = await studioToSvg(doc.value)
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    downloadBlobAsFile(blob, `shape-studio-${doc.value.seed}.svg`)
  } catch (e) {
    console.error('[shape-studio] SVG export failed', e)
    setActionError('SVG export failed — please try again')
  } finally {
    svgExporting.value = false
  }
}
</script>

<template>
  <StudioModalShell
    title="Shape studio"
    :agent="shapeAgent"
    agent-placeholder="Describe the mark — e.g. more clones, sharper overlap, warmer fill…"
    @close="closeEditor"
  >
    <!-- Left rail: the stack of shape layers (same component the other studios use). -->
    <template #aside>
      <StudioLayerStack
        :layers="railLayers"
        :active-index="activeLayer"
        :max="LAYER_MAX"
        @select="onSelectLayer"
        @add="addLayer"
        @remove="removeLayer"
        @duplicate="duplicateLayer"
        @reorder="reorderLayer"
        @toggle="toggleLayer"
      />
    </template>

    <template #preview>
      <div class="relative flex h-full w-full items-center justify-center">
        <!-- Checkered backdrop (cosmetic only — the exported PNG/SVG stay transparent). -->
        <canvas
          ref="canvas"
          class="max-h-full max-w-full rounded-lg shadow-2xl"
          style="background-image:linear-gradient(45deg,#3a3a3f 25%,transparent 25%),linear-gradient(-45deg,#3a3a3f 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#3a3a3f 75%),linear-gradient(-45deg,transparent 75%,#3a3a3f 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0px;background-color:#242427"
        />
      </div>
    </template>
    <template #actions>
      <StudioActionsFooter :spec="{
        status: { saving: autoSaving, saved: autoSaved, error: actionError || null },
        downloads: [
          { label: 'Download SVG', onClick: exportSvg, busy: svgExporting },
          { label: 'Download PNG', onClick: downloadPng },
        ],
        canvas: [{ label: 'As image', onClick: exportPng, busy: exporting }],
      }" />
    </template>
    <template #controls>
      <!-- ══ A LAYER IS SELECTED → edit that layer's mark ══ -->
      <template v-if="isSelected">
        <!-- Seed + Re-roll (of the selected layer's mark) -->
        <div class="flex items-center justify-between rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
          <div class="flex flex-col">
            <span class="text-[10px] uppercase tracking-wide text-white/30">Seed · {{ layerLabel(activeLayer) }}</span>
            <span class="font-mono text-[11px] text-white/70">{{ activeMark.seed }}</span>
          </div>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded bg-action px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-action/85"
            @click="rerollConfig"
          >
            <Dices class="h-3.5 w-3.5" /> Re-roll
          </button>
        </div>

        <!-- Placement — where this whole mark sits in the shared frame. -->
        <StudioSection title="Placement">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Offset X</label>
              <input v-model.number="activeLayerObj.offset.x" type="number" step="1"
                     class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20" />
            </div>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Offset Y</label>
              <input v-model.number="activeLayerObj.offset.y" type="number" step="1"
                     class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20" />
            </div>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Scale</label>
              <input v-model.number="activeLayerObj.offset.scale" type="number" min="0.05" max="8" step="0.05"
                     class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20" />
            </div>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Rotate</label>
              <input v-model.number="activeLayerObj.offset.rotate" type="number" step="1"
                     class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20" />
            </div>
          </div>
        </StudioSection>

        <!-- Schema-driven inspector for the selected layer's mark. -->
        <StudioControlPanel
          :controls="panelGeoControls"
          :order="GEO_SECTIONS"
          :value="paramValue"
          :visible="controlVisible"
          @set="setGeoControl"
        >
          <template #control-fill>
            <FillControl allow-image :show-anchor="false" :model-value="activeMark.fill" @update:model-value="setGeoControl('fill', $event)" />
          </template>
          <template #control-overlapFill>
            <FillControl allow-image :show-anchor="false" :model-value="activeMark.overlapFill" @update:model-value="setGeoControl('overlapFill', $event)" />
          </template>
          <template #control-stroke>
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-white/55">Stroke</span>
              <StudioSwitch v-model="strokeEnabled" />
            </div>
            <StudioColorField v-if="strokeEnabled" label="Stroke color" v-model="strokeHex" />
          </template>
        </StudioControlPanel>

        <!-- Seed-engine palette → discrete fills. Shown regardless of fillStrategy —
             applying a family flips fillStrategy off 'single' itself, so the picker
             must stay reachable even from the (default) single-fill state.
             All three panes route through the same discrete applyGeoPalette path:
             the seed pane emits apply-family (and apply-literal-stops alongside
             it — both bound here to the same hexes, since setGeoControl writes
             here aren't paired with an explicit recordHistory()/commit() the way
             the Compositor's distributePaletteToSelection is, so a same-value
             re-write from the second event isn't the doubled-undo hazard that
             made the Compositor drop that binding); gallery/harmony emit
             apply-stops only. -->
        <PalettePicker mode="stops" class="mt-2" @apply-family="applyPaletteToFills"
          @apply-stops="(stops: GradientStop[]) => applyGeoPalette(stops.map(s => s.color))"
          @apply-literal-stops="(stops: GradientStop[]) => applyGeoPalette(stops.map(s => s.color))" />

        <!-- Fills list editor — under the Paint card when fillStrategy isn't 'single'. -->
        <div v-if="activeMark.fillStrategy !== 'single'" class="mt-2 space-y-2">
          <div v-for="(f, i) in activeMark.fills" :key="i" data-row
               class="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 transition-shadow"
               :class="fillDrag.over === i && fillDrag.from !== i ? 'ring-1 ring-white/40' : ''"
               @dragover="fillDragOver(i, $event)" @drop="fillDrop(i)">
            <div class="flex items-center gap-1.5">
              <span draggable="true" @dragstart="fillDragStart(i, $event)" @dragend="fillDragEnd"
                    class="shrink-0 cursor-grab text-white/25 hover:text-white/60 active:cursor-grabbing" title="Drag to reorder" aria-label="Drag to reorder">
                <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="4" r="1" /><circle cx="7.5" cy="4" r="1" /><circle cx="2.5" cy="8" r="1" /><circle cx="7.5" cy="8" r="1" /><circle cx="2.5" cy="12" r="1" /><circle cx="7.5" cy="12" r="1" /></svg>
              </span>
              <span class="w-3 shrink-0 text-center text-[10px] tabular-nums text-white/30">{{ i + 1 }}</span>
              <FillControl class="flex-1" allow-image :show-anchor="false" :model-value="f" @update:model-value="(v: Paint) => updateFill(i, v)" />
              <button v-if="activeMark.fills.length > 1" type="button" @click="removeFill(i)" aria-label="Remove fill"
                      class="shrink-0 rounded p-1 text-white/30 hover:bg-white/10 hover:text-rose-300">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
              </button>
            </div>
          </div>
          <button type="button" @click="addFill"
                  class="w-full rounded border border-dashed border-white/15 py-1.5 text-[11px] text-white/50 hover:border-white/30 hover:text-white/80">+ Add fill</button>
          <p class="text-[10px] leading-relaxed text-white/35">Shapes cycle through these colours, in the chosen colour order.</p>
        </div>

        <!-- Overlap-fills list editor — pieces mode, overlapSeparate on. -->
        <div v-if="activeMark.fillStrategy === 'pieces' && activeMark.overlapSeparate" class="mt-3 space-y-2">
          <p class="text-[10px] font-medium uppercase tracking-wide text-white/40">Overlap colours</p>
          <div v-for="(f, i) in activeMark.overlapFills" :key="'ov' + i"
               class="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <div class="flex items-center gap-1.5">
              <span class="w-3 shrink-0 text-center text-[10px] tabular-nums text-white/30">{{ i + 2 }}</span>
              <FillControl class="flex-1" allow-image :show-anchor="false" :model-value="f" @update:model-value="(v: Paint) => updateOverlapFill(i, v)" />
              <button v-if="activeMark.overlapFills.length > 1" type="button" @click="removeOverlapFill(i)" aria-label="Remove overlap colour"
                      class="shrink-0 rounded p-1 text-white/30 hover:bg-white/10 hover:text-rose-300">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
              </button>
            </div>
          </div>
          <button type="button" @click="addOverlapFill"
                  class="w-full rounded border border-dashed border-white/15 py-1.5 text-[11px] text-white/50 hover:border-white/30 hover:text-white/80">+ Add overlap colour</button>
          <p class="text-[10px] leading-relaxed text-white/35">By how many shapes cross — 2-deep, 3-deep, …</p>
        </div>
      </template>

      <!-- ══ NOTHING SELECTED → composite properties (Frame; Intersections in Phase 2) ══ -->
      <template v-else>
        <p class="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-white/45">
          No layer selected — editing the whole composite. Pick a layer on the left to edit its shape.
        </p>

        <!-- Frame: the single padding lever around the whole composite. -->
        <StudioControlPanel
          :controls="stackControls"
          :order="['Frame']"
          :value="stackValue"
          :visible="() => true"
          @set="setStackControl"
        />

        <!-- Intersections — colour the regions where layers cross, from a palette +
             an order-logic (the same "pieces" system, but across whole layers). -->
        <StudioSection title="Intersections">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-white/55">Colour intersections</span>
            <StudioSwitch v-model="doc.overlap.enabled" />
          </div>
          <template v-if="doc.overlap.enabled">
            <p class="text-[10px] leading-relaxed text-white/35">
              Where two or more layers overlap, paint that region from these colours.
            </p>
            <div class="space-y-2">
              <div v-for="(f, i) in doc.overlap.fills" :key="'ix' + i"
                   class="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
                <div class="flex items-center gap-1.5">
                  <span class="w-3 shrink-0 text-center text-[10px] tabular-nums text-white/30">{{ i + 1 }}</span>
                  <FillControl class="flex-1" allow-image :show-anchor="false" :model-value="f" @update:model-value="(v: Paint) => updateOverlapPaletteFill(i, v)" />
                  <button v-if="doc.overlap.fills.length > 1" type="button" @click="removeOverlapPaletteFill(i)" aria-label="Remove intersection colour"
                          class="shrink-0 rounded p-1 text-white/30 hover:bg-white/10 hover:text-rose-300">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
                  </button>
                </div>
              </div>
              <button type="button" @click="addOverlapPaletteFill"
                      class="w-full rounded border border-dashed border-white/15 py-1.5 text-[11px] text-white/50 hover:border-white/30 hover:text-white/80">+ Add intersection colour</button>
            </div>
            <StudioSelect label="Colour order" v-model="doc.overlap.order" :options="OVERLAP_ORDERS" />
            <StudioSelect label="Crossings" v-model="doc.overlap.crossingMode" :options="OVERLAP_CROSSINGS" />
          </template>
        </StudioSection>

        <!-- Background — full-composite fill behind every layer. `null` = transparent. -->
        <StudioSection title="Background">
          <FillControl
            allow-none
            allow-image
            :model-value="doc.background ?? 'none'"
            @update:model-value="setBackground"
          />
        </StudioSection>

        <!-- Canvas (export dimensions — not part of the doc) -->
        <StudioSection title="Canvas">
          <StudioSelect label="Aspect" v-model="aspectKey" :options="ASPECT_OPTIONS" />
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Width</label>
              <input v-model.number="canvasW" type="number" min="64" max="4096" step="1"
                     class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20" />
            </div>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Height</label>
              <input v-model.number="canvasH" type="number" min="64" max="4096" step="1"
                     class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20" />
            </div>
          </div>
        </StudioSection>
      </template>
    </template>
  </StudioModalShell>
</template>
