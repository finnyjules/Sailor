<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue'
import { Dices, Lock, Minus, Plus, Trash2, Unlock } from 'lucide-vue-next'
import { gradientFx } from '~/lib/gradientfx/renderer'
import { LIQUID_PRESETS, buildConfig, defaultConfig, liquidConfig, liquidPresetConfig, meshConfig, reroll, rippleConfig, stackConfig, type RerollScope } from '~/lib/gradientfx/randomize'
import { MESH_MAX_POINTS, buildMeshPoints, defaultMesh, recolorMeshPoints } from '~/lib/gradientfx/mesh'
import { randomSeed } from '~/lib/gradientfx/rng'
import { ensureSpaceTypeBake } from '~/lib/spacetype/bake'
import { encodeFrames } from '~/lib/engine/encodeVideo'
import { useStudioAutosave } from '~/lib/studio/autosave'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'
import { animatableTargets, dropTracksForLayer, remapTracksOnInsert, remapTracksOnReorder } from '~/lib/gradientfx/motion'
import { layerLabels } from '~/lib/gradientfx/layerLabel'
import StudioModalShell from '~/components/vue-canvas/StudioModalShell.vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioLayerStack from '~/components/vue-canvas/StudioLayerStack.vue'
import CurveHandleEditor from '~/components/vue-canvas/CurveHandleEditor.vue'
import StudioActionsFooter from '~/components/vue-canvas/studio/StudioActionsFooter.vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import BindableRow from '~/components/vue-canvas/studio/BindableRow.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import CanvasContextMenu from '~/components/vue-canvas/CanvasContextMenu.vue'
import StudioControlPanel from '~/components/vue-canvas/studio/StudioControlPanel.vue'
import {
  GRADIENT_PANEL_SECTIONS, gradientPanelControls, panelValue, panelWriteSeed,
} from '~/lib/gradientfx/panelPresentation'
import { DEFAULT_POST } from '~/lib/studio/post/settings'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { useStudioAgent } from '~/composables/useStudioAgent'
import { useStudioVarBindings } from '~/composables/useStudioVarBindings'
import { useStudioVarMenu } from '~/composables/useStudioVarMenu'
import { makeConfigParams } from '~/lib/agent/configParams'
import { GRADIENT_GUIDANCE, gradientAgentControls, gradientGuidance } from '~/lib/gradientfx/agentControls'
import { buildGradientPreset } from '~/lib/gradientfx/presets'
import { materializeRecipe, summarizeConfig } from '~/lib/gradientfx/recipes'
import { controlsForStudio } from '~/lib/collection/studioControls'
import type { StudioControlDesc } from '~/lib/collection/studioBindables'
import { registerStudioParamBaker, unregisterStudioParamBaker } from '~/lib/studio/cascade'
import { showIfVisible } from '~/lib/studio/sections'
import SweepPopover from '~/components/vue-canvas/studio/SweepPopover.vue'
import { exportEmbedHtml, downloadEmbed } from '~/lib/embed/export'
import type { GradientEmbedConfig } from '~/lib/embed/surfaces/gradient'
import { clampExportDims } from '~/lib/gradientfx/exportDims'
import {
  ASPECTS, CURVE_DEFAULTS, DEFAULT_CENTER, DEFAULT_FOCUS, DEFAULT_LIGHT, DIRECTIONS, GRADIENT_DIRS, LAYER_MAX, LAYOUTS, LAYOUT_LABELS, MAPPINGS, MIRROR_KINDS, RAMP_DEFAULTS, RING_SHAPES, SHAPE_KINDS,
  aspectRatio, cloneConfig, effectiveLayout, ensureConfigDefaults, type GradientConfig, type LayoutKind, type MeshConfig, type ShapeKind,
} from '~/lib/gradientfx/types'

const props = defineProps<{ nodeId: string; nodes: any[]; edges?: any[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// Record generated stills/videos as the current project's assets (Assets panel).
const { recordAsset } = useProjectGenerations()
const { activeTab } = useTabs()

function currentNode() { return props.nodes.find((n: any) => n.id === props.nodeId) }

// ── config (single source of truth) ─────────────────────────────────────────
const config = ref<GradientConfig>(defaultConfig('#default0'))
const activeLayer = ref(0)
const layer = computed(() => config.value.layers[activeLayer.value] ?? config.value.layers[0]!)
const animatable = computed(() => animatableTargets(config.value))
// The active layer's own layout override, else the canvas default (layer 0 always
// anchors to canvas.layout — see setLayout). Every layout-gated computed below reads
// THIS, not config.value.canvas.layout, so the inspector reflects whichever layer is
// selected in the layer stack, not just layer 0.
const activeLayout = computed(() => effectiveLayout(config.value, activeLayer.value))
// The three the SURFACE still reads: the preview's mesh handles and curve editor, and
// the Flow card's open-by-default rule. Every other layout predicate the hand-written
// inspector carried now lives in the schema's `when` / gradientPanelVisible.
const isLiquid = computed(() => activeLayout.value === 'liquid')
const isMesh = computed(() => activeLayout.value === 'mesh')
const isCurve = computed(() => activeLayout.value === 'curve')
// Layers are named for what they are ("Wave", "Bands"), not their position, so a
// reorder moves a recognisable name instead of renumbering the whole stack.
const layerNames = computed(() => layerLabels(config.value))

// Inspector tabs — Design (everything that shapes the still frame) vs Motion (tracks
// + timing), matching Space Type and 3D Studio. Export stays on Design: it writes a
// still, while Motion owns the animation the Render footer bakes to video.
const inspectorTab = ref<'design' | 'motion'>('design')
const onDesign = computed(() => inspectorTab.value === 'design')
const onMotion = computed(() => inspectorTab.value === 'motion')
// Focus (soft-focus/DoF) is an optional, additive config. Guarantee it exists on
// the current config so the Focus section's v-models are always non-null — presets
// replace the whole config and defaultConfig() omits it. Runs before render.
watch(config, (c) => { if (c && !c.focus) c.focus = { ...DEFAULT_FOCUS } }, { immediate: true, flush: 'sync' })
// Same guarantee for post: defaultConfig()/randomize.ts's builders always set it now,
// but a config loaded from an OLDER saved node blob (pre-this-task) or a not-yet-
// updated preset would otherwise leave config.value.post undefined until the next
// ensureConfigDefaults pass, and the Post panel's v-models need it non-null immediately.
watch(config, (c) => { if (c && !c.post) c.post = { ...DEFAULT_POST } }, { immediate: true, flush: 'sync' })

// In-product agent — "tune" the gradient in natural language (Phase 1). The
// studio's nested `config` is bridged to a flat Params via makeConfigParams; only
// the controls that apply to the current layout are offered to the model.
const { getLocalSetting } = useLocalSettings()
const agentParams = makeConfigParams(() => config.value, () => activeLayer.value)
const activeAgentControls = computed(() => gradientAgentControls(config.value))
// The shell renders the prompt + results from this object (see StudioModalShell).
const gradientAgent = useStudioAgent({
  controls: () => activeAgentControls.value, params: agentParams, label: () => 'Gradient studio',
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  // Preset-LESS guidance, matching the preset-less vocabulary above. The two must
  // move together: guidance teaching PRESET-FIRST against a list with no `preset`
  // made the model answer with a key validatePatch silently dropped, leaving a
  // rationale that described a look nothing applied.
  guidance: () => gradientGuidance(),
  render: () => renderGradientForReview(),
  // ── Four Takes ────────────────────────────────────────────────────────────
  // The takes ask gets a WIDER vocabulary than the single tune: the `preset`
  // macro, the only control that can change the base look at all. Safe here and
  // not there — a take is previewed non-destructively and committed only by an
  // explicit Keep, whereas a single tune applies the moment it lands, and a
  // whole-config swap arriving unbidden is the silent-wipe hazard the shader
  // macro already taught us about.
  takes: {
    studio: 'gradient',
    config: () => config.value,
    // Clamped against the config it is GIVEN, not the live one: a preset base can
    // have fewer layers than the stack on screen, and an unclamped `layer.` path
    // on the thumbnail clone resolves to a layer that does not exist — so the
    // tile's recolours are silently dropped and it shows a bare preset while the
    // live preview shows the recoloured one.
    paramsOf: c => makeConfigParams(
      () => c,
      () => Math.max(0, Math.min(activeLayer.value, ((c as GradientConfig)?.layers?.length ?? 1) - 1)),
    ),
    controls: () => gradientAgentControls(config.value, { includePreset: true }),
    guidance: () => GRADIENT_GUIDANCE,
    setConfig: (c) => {
      config.value = ensureConfigDefaults(cloneConfig(c as GradientConfig))
      // A preset's base may have fewer layers than the one on screen.
      activeLayer.value = Math.min(activeLayer.value, config.value.layers.length - 1)
    },
    // …and the clamp is undone with the config: without this, one hover of a
    // one-layer preset permanently moves the user's selection to layer 0.
    captureView: () => activeLayer.value,
    restoreView: (v) => { activeLayer.value = Math.min(Number(v) || 0, config.value.layers.length - 1) },
    // ── compose and pick ──────────────────────────────────────────────────
    // The model composes from our menu of looks and moods and never names a
    // control key; this turns each recipe into a real config through the same
    // preset machinery the macro path uses.
    compose: {
      summarize: c => summarizeConfig(c as GradientConfig),
      materialize: (recipe, own, seed) => materializeRecipe(recipe, own as GradientConfig, cloneConfig, seed),
    },
    // The ONE repair a broken promise may make here. Gradient is the only one of
    // the four studios that offers a key which aims the whole picture: flow.angle
    // for a field layout, layer.ramp.angle for a ramp one. Both are written and
    // whichever the current layout does not offer is dropped by validation, so
    // nothing is invented. 90° reads top-to-bottom, 0° side-to-side (measured
    // against the studio, not assumed). radial/none get no patch — this studio
    // has no key that produces them on demand, so those are labelled instead.
    repair: {
      directionPatch: (dir) => {
        const angle = dir === 'vertical' ? 90 : dir === 'horizontal' ? 0 : null
        const patch: Record<string, string | number> = {}
        if (angle !== null) { patch['flow.angle'] = angle; patch['layer.ramp.angle'] = angle }
        return patch
      },
    },
    macro: {
      key: 'preset',
      apply: name => buildGradientPreset(name),
      // A preset can change how many colour stops exist, so the take's remaining
      // colour changes are validated against the SWAPPED config's list — and
      // against the layer that list will actually be written through.
      recontrol: c => gradientAgentControls(c as GradientConfig, { includePreset: true }),
    },
  },
})

// Collections variable binding (Slice 2a, Task 6) — Gradient is the first inline-
// markup surface to get promote/bind chips. Controls are hardcoded `v-model`s into
// the nested `config` ref rather than a data-driven loop, so — unlike Space Type —
// there's no single ControlSpec[] driving the template; `studioControls` mirrors
// what the agent tuner already offers (via `controlsForStudio`, loaded once since
// the composable wants a synchronous accessor) purely for the bind-menu's control
// descriptions (label/kind/min/max/step/options), matched by dotted key.
const studioControls = ref<StudioControlDesc[]>([])
onMounted(async () => { studioControls.value = await controlsForStudio(currentNode()) })

// The SAME dotted-path proxy the canvas agent tuner reads/writes (`canvas.margin`,
// `flow.intensity`, `layer.color.stops.0.color`…) — reused here so onEdit/promote/
// unbind's "live value" reads and applyParam's writes address identical keys. Writing
// through this proxy mutates `config` directly, so the surface's existing `deep`
// watcher on `config` (see `watch(config, ...)` above) re-renders the preview — no
// extra watcher needed, and per the loop-safety note, nothing here calls onEdit from
// a config watch (only the explicit control handlers below do).
const paramsProxy = makeConfigParams(() => config.value, () => activeLayer.value)
const { boundColumnFor, boundColumnKeyFor, onEdit, promote, unbind } = useStudioVarBindings(
  props.nodeId,
  () => studioControls.value,
  (key, value) => { paramsProxy[key] = value },
  { nodes: () => props.nodes, edges: () => props.edges ?? [] },
)

const { wiredColumns, sweepPopover, applySweep, varMenu, openVarMenu, goToCollection } = useStudioVarMenu({
  nodeId: () => props.nodeId,
  nodes: () => props.nodes,
  edges: () => props.edges ?? [],
  liveValue: (key) => paramsProxy[key] as string | number,
  boundColumnFor, boundColumnKeyFor, promote, unbind,
})

// ── the inspector panel ───────────────────────────────────────────────────────
/** A param row (e.g. Bloom's strength/radius/threshold) only shows once its effect's
 *  own switch is on. The rule itself lives in ~/lib/studio/sections — it used to be
 *  copy-pasted here and in SpaceTypeSurface, and missing from Texture and Shape. */
function postControlVisible(c: ControlSpec): boolean {
  return showIfVisible(c, k => paramsProxy[k])
}
// Design rows + the post stack in ONE list, already filtered, re-titled and re-ordered
// to what the hand-written inspector drew. See ~/lib/gradientfx/panelPresentation.ts.
const panelControls = computed(() =>
  gradientPanelControls(config.value, activeLayer.value, { postVisible: postControlVisible }))

// The mesh block is layer-0-only in the renderer, and the shipped Mesh card edited
// layer 0 whatever was selected — `paramsProxy`'s `layer.` prefix resolves against the
// ACTIVE layer, so mesh keys need a proxy pinned to the base layer or a second layer
// over a mesh canvas would write points nothing reads.
const layer0Params = makeConfigParams(() => config.value, () => 0)
const paramsFor = (key: string) => (key.startsWith('layer.mesh.') ? layer0Params : paramsProxy)
const controlValue = (key: string) =>
  panelValue(key, paramsFor(key)[key] as string | number | boolean | undefined)

/** Seed the WHOLE optional container before writing one field into it. A dotted write
 *  creates a bare `{}`, which stops the renderer's `L.ramp ?? RAMP_DEFAULTS` fallback
 *  firing and leaves the sibling fields undefined — the reason the shipped rows went
 *  through `onRamp`/`onCurve` and the `??=` proxies instead of writing directly.
 *  `flow` is deliberately absent from the table — see panelWriteSeed for why that gap
 *  is safe and what makes it so. */
function seedContainer(key: string) {
  const seed = panelWriteSeed(key)
  if (!seed) return
  const L = layer.value
  if (seed.path === 'ramp') { if (!L.ramp) L.ramp = { ...RAMP_DEFAULTS } }
  else if (seed.path === 'curve') { if (!L.curve) L.curve = { ...CURVE_DEFAULTS, start: { ...CURVE_DEFAULTS.start }, end: { ...CURVE_DEFAULTS.end } } }
  else if (seed.path === 'center') { config.value.canvas.center ??= { ...DEFAULT_CENTER } }
  else if (seed.path === 'light') { config.value.relief.light ??= { ...DEFAULT_LIGHT } }
  else ensureMesh()
}
function setControl(key: string, value: string | number | boolean) {
  seedContainer(key)
  paramsFor(key)[key] = value as string | number
  onEdit(key, value as string | number)
}
function promoteControl(c: ControlSpec) {
  promote(c, paramsFor(c.key)[c.key] as string | number)
}
/** Right-click opens the promote/bind menu — but only where a binding is possible.
 *  StudioRow gates its VariableGlyph on `bindable !== false` and yet emits `menu` from
 *  the row's contextmenu UNCONDITIONALLY, so without this the 16 rows that declare
 *  `bindable: false` would offer through right-click exactly the binding their own
 *  glyph withholds — and the shipped panel offered none of them (canvas.layout was a
 *  bare button grid, every Shape slider carried `:bindable="false"`, and a bound
 *  canvas.layout would write past setLayout's stack/mesh seeding). The bespoke-block
 *  anchors are covered by the same test: they are positions, not parameters, and
 *  `gradientPanelControls` builds them with `bindable: false`. */
function onControlMenu(e: MouseEvent, c: ControlSpec) {
  if (c.bindable === false) return
  openVarMenu(e, c)
}
/** Section badges/open-states, keyed by the ON-SCREEN card title the remap produced.
 *  The post stack's own cards drive their open state from their `sectionToggle`, so
 *  the "Color" entry here reaches the design card only. */
const sectionChrome = computed<Record<string, { badge?: string; open?: boolean }>>(() => {
  const layerName = layerNames.value[activeLayer.value] ?? `Layer ${activeLayer.value + 1}`
  return {
    Canvas: { badge: 'both layers' },
    Color: { badge: isMesh.value ? 'mesh palette' : layerName },
    Curve: { open: true },
    Flow: { badge: 'all layouts', open: isLiquid.value || isMesh.value },
    'Depth & light': { badge: 'liquid' },
    'Liquid surface': { badge: 'liquid', open: true },
    Mesh: { badge: 'layer 1', open: true },
    Relief: { open: false },
    Focus: { badge: 'both layers', open: false },
    Layer: { open: false },
    Shape: { badge: layerName },
  }
})

// Render the current gradient to a PNG for the agent's visual self-review.
function renderGradientForReview(): string | null {
  if (typeof document === 'undefined') return null
  try {
    const ar = aspectRatio(config.value.canvas.aspect)
    const W = ar >= 1 ? 1024 : Math.round(1024 * ar)
    const H = ar >= 1 ? Math.round(1024 / ar) : 1024
    const off = document.createElement('canvas'); off.width = W; off.height = H
    const ctx = off.getContext('2d'); if (!ctx) return null
    ctx.drawImage(gradientFx.render(config.value, W, H, 0), 0, 0)
    return off.toDataURL('image/png')
  } catch { return null }
}

// Layer-0 mesh block, guaranteed to exist (created on demand). The mesh layout only
// ever reads layer 0, so all mesh editing targets it.
function ensureMesh(): MeshConfig {
  const L0 = config.value.layers[0]!
  if (!L0.mesh) L0.mesh = defaultMesh(L0.color.stops, config.value.seed)
  return L0.mesh
}
const mesh = computed(() => (isMesh.value ? ensureMesh() : (config.value.layers[0]?.mesh ?? defaultMesh([], '#x'))))
function addMeshPoint() {
  const m = ensureMesh()
  if (m.points.length >= MESH_MAX_POINTS) return
  m.points.push({ x: 0.5, y: 0.5, color: '#ffffff' })
}
function removeMeshPoint(i: number) {
  const m = ensureMesh()
  if (m.points.length > 2) m.points.splice(i, 1)
}
function scatterMesh() {
  const m = ensureMesh()
  m.points = buildMeshPoints(m.points.length, config.value.layers[0]!.color.stops, randomSeed())
}

// ── rolls history (session-scoped) ──────────────────────────────────────────
interface Roll { seed: string; thumb: string; cfg: GradientConfig }
const rolls = reactive<Roll[]>([])
const ROLL_CAP = 48

// ── preview ─────────────────────────────────────────────────────────────────
const canvas = ref<HTMLCanvasElement | null>(null)
const baking = ref(false)
const bakeMsg = ref('')
const embedMsg = ref('')
const embedErr = ref(false)
const embedding = ref(false)
const glError = ref<string | null>(null)
let raf = 0
let start = 0
const PREVIEW_MAX_W = 880

// Size the preview to its on-screen box, then render the backing store at the display's
// physical pixel density (dpr). Rendering at a fixed 880px and letting the browser scale
// it (esp. 2× on Retina) resampled the fine film grain into a faint moiré; backing =
// CSS-size × dpr means 1 render pixel maps to 1 physical pixel — crisp grain, no moiré.
function previewDims() {
  const el = canvas.value
  const ar = aspectRatio(config.value.canvas.aspect)
  const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2)
  const wrap = el?.parentElement
  const availW = wrap?.clientWidth || PREVIEW_MAX_W
  const availH = wrap?.clientHeight || Math.round(PREVIEW_MAX_W / ar)
  let cssW = Math.min(availW, PREVIEW_MAX_W)
  let cssH = cssW / ar
  if (cssH > availH) { cssH = availH; cssW = availH * ar }
  cssW = Math.round(cssW); cssH = Math.round(cssH)
  return { cssW, cssH, w: Math.max(1, Math.round(cssW * dpr)), h: Math.max(1, Math.round(cssH * dpr)) }
}

// Screen box of the canvas (relative to the preview container), so the mesh drag
// handles overlay exactly on top of it.
// Preview zoom (visual scale of the canvas) + pan offset. 1 = 100%, 25%..400%.
// When zoomed in, scrolling over the preview pans (translate) the scaled canvas;
// pan is clamped so the canvas can't be scrolled entirely out of view.
const zoom = ref(1)
const pan = reactive({ x: 0, y: 0 })
function clampPan() {
  const el = canvas.value
  if (!el) { pan.x = 0; pan.y = 0; return }
  const maxX = Math.max(0, (el.clientWidth * (zoom.value - 1)) / 2)
  const maxY = Math.max(0, (el.clientHeight * (zoom.value - 1)) / 2)
  pan.x = Math.min(maxX, Math.max(-maxX, pan.x))
  pan.y = Math.min(maxY, Math.max(-maxY, pan.y))
}
function zoomBy(f: number) {
  zoom.value = Math.min(4, Math.max(0.25, Math.round(zoom.value * f * 100) / 100))
  clampPan()
}
function resetZoom() { zoom.value = 1; pan.x = 0; pan.y = 0 }
function onPreviewWheel(e: WheelEvent) {
  if (zoom.value <= 1) return           // 100% or below: leave normal scroll alone
  e.preventDefault()
  pan.x -= e.deltaX
  pan.y -= e.deltaY
  clampPan()
}

const meshOverlay = ref({ left: 0, top: 0, w: 0, h: 0 })
function syncOverlay() {
  const el = canvas.value
  if (!el) return
  // The canvas is CSS-scaled about its centre then panned; move+scale the mesh
  // overlay the same way (offsetLeft/clientWidth are layout values that ignore the
  // transform) so the drag handles stay aligned with the zoomed/panned canvas.
  const z = zoom.value
  const w = el.clientWidth * z, h = el.clientHeight * z
  const cx = el.offsetLeft + el.clientWidth / 2, cy = el.offsetTop + el.clientHeight / 2
  meshOverlay.value = { left: cx - w / 2 + pan.x, top: cy - h / 2 + pan.y, w, h }
}
watch([zoom, pan], syncOverlay, { deep: true })

function renderFrame(t: number) {
  const el = canvas.value
  if (!el) return
  const { cssW, cssH, w, h } = previewDims()
  el.style.width = `${cssW}px`
  el.style.height = `${cssH}px`
  if (el.width !== w || el.height !== h) { el.width = w; el.height = h }
  try { el.getContext('2d')!.drawImage(gradientFx.render(config.value, w, h, t), 0, 0); glError.value = null }
  catch (e: any) { glError.value = String(e?.message ?? e) }
  syncOverlay()
}

// ── mesh point dragging (handles overlaid on the preview) ──────────────────────
const dragPoint = ref<number | null>(null)
function onHandleDown(i: number, e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  dragPoint.value = i
  window.addEventListener('pointermove', onHandleMove)
  window.addEventListener('pointerup', onHandleUp)
}
function onHandleMove(e: PointerEvent) {
  const i = dragPoint.value
  const el = canvas.value
  if (i == null || !el) return
  const r = el.getBoundingClientRect()
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)))
  const y = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)))
  const pt = config.value.layers[0]?.mesh?.points[i]
  if (pt) { pt.x = x; pt.y = y }
}
function onHandleUp() {
  dragPoint.value = null
  window.removeEventListener('pointermove', onHandleMove)
  window.removeEventListener('pointerup', onHandleUp)
}

// Animate when there are motion tracks OR a living drift is active (mesh point drift,
// or a flow speed that has a warp to move).
const animated = computed(() => {
  if ((config.value.motion?.tracks?.length ?? 0) > 0) return true
  const fl = config.value.flow
  const flowAnim = (fl?.speed ?? 0) > 0 && (fl?.intensity ?? 0) > 0
  const meshAnim = isMesh.value && (config.value.layers[0]?.mesh?.drift ?? 0) > 0
  return flowAnim || meshAnim
})
function loop(ts: number) {
  if (!start) start = ts
  const dur = Math.max(0.1, config.value.motion?.duration ?? 4)
  renderFrame(((ts - start) / 1000) % dur)
  raf = requestAnimationFrame(loop)
}
function startPreview() {
  cancelAnimationFrame(raf); start = 0
  if (animated.value) raf = requestAnimationFrame(loop)
  else renderFrame(0)
}
function stopPreview() { cancelAnimationFrame(raf); raf = 0 }

watch(config, () => { if (!animated.value) renderFrame(0) }, { deep: true })
watch(animated, startPreview)

// ── randomize + rolls ────────────────────────────────────────────────────────
function makeThumb(cfg: GradientConfig): string {
  try { return gradientFx.render(cfg, 132, Math.round(132 / aspectRatio(cfg.canvas.aspect)), 0).toDataURL('image/jpeg', 0.7) }
  catch { return '' }
}
function pushRoll(cfg: GradientConfig) {
  rolls.unshift({ seed: cfg.seed, thumb: makeThumb(cfg), cfg: cloneConfig(cfg) })
  if (rolls.length > ROLL_CAP) rolls.length = ROLL_CAP
}
function randomize(scope: RerollScope) {
  config.value = reroll(config.value, scope, randomSeed())
  pushRoll(config.value)
}

// Preset: the 3D-embossed rainbow orbit (the reference look).
function applyRipple() {
  config.value = rippleConfig(randomSeed())
  activeLayer.value = 0
  pushRoll(config.value)
}

// Preset: stacked rotated-gradient circles (the reference's real construction).
function applyStack() {
  config.value = stackConfig(randomSeed())
  activeLayer.value = 0
  pushRoll(config.value)
}

// Preset: warm marble liquid flow.
function applyLiquid() {
  config.value = liquidConfig(randomSeed())
  activeLayer.value = 0
  pushRoll(config.value)
}

// Preset: soft Stripe-style point mesh.
function applyMesh() {
  config.value = meshConfig(randomSeed())
  activeLayer.value = 0
  pushRoll(config.value)
}

// Preset: one of the named liquid looks (marble/oil/ink/lava/satin).
function applyLiquidPreset(name: (typeof LIQUID_PRESETS)[number]) {
  config.value = liquidPresetConfig(name, randomSeed())
  activeLayer.value = 0
  pushRoll(config.value)
}

// ── locks ─────────────────────────────────────────────────────────────────
function toggleLock(key: string) {
  const locks = (config.value.locks ||= {})
  locks[key] = !locks[key]
}
const locked = (key: string) => !!config.value.locks?.[key]

// ── layers ──────────────────────────────────────────────────────────────────
function addLayer() {
  if (config.value.layers.length >= LAYER_MAX) return
  const extra = buildConfig(randomSeed()).layers[0]!
  // Normal blend at partial opacity so the new layer is immediately visible over
  // layer 1 (a random dark palette under 'lighten' looked invisible — its controls
  // then appeared to do nothing). The user can switch to lighten/screen/etc.
  extra.blend = 'normal'; extra.opacity = 0.65
  config.value.layers.push(extra)
  activeLayer.value = config.value.layers.length - 1
}
function removeLayer(i: number) {
  if (config.value.layers.length <= 1) return
  config.value.layers.splice(i, 1)
  config.value.motion.tracks = dropTracksForLayer(config.value.motion.tracks, i)
  activeLayer.value = Math.min(activeLayer.value, config.value.layers.length - 1)
}
function duplicateLayer(i: number) {
  if (config.value.layers.length >= LAYER_MAX) return
  const clone = structuredClone(toRaw(config.value.layers[i]!))
  config.value.layers.splice(i + 1, 0, clone)
  config.value.motion.tracks = remapTracksOnInsert(config.value.motion.tracks, i + 1)
  activeLayer.value = i + 1
}
function reorderLayer(from: number, to: number) {
  const [moved] = config.value.layers.splice(from, 1)
  config.value.layers.splice(to, 0, moved!)
  config.value.motion.tracks = remapTracksOnReorder(config.value.motion.tracks, from, to)
  activeLayer.value = to
}

// Layer visibility is a real persisted `LayerConfig.enabled` field (absent/true =
// shown, false = hidden). Reading/writing it directly keeps the eye icon reactive
// and durable across save/reload, and the renderer skips a disabled layer — so
// hiding the base layer promotes the next enabled one, matching the shader studio.
function layerEnabled(i: number) {
  return config.value.layers[i]?.enabled !== false
}
function toggleLayer(i: number) {
  const L = config.value.layers[i]
  if (L) L.enabled = L.enabled === false
}

// ── color stops ─────────────────────────────────────────────────────────────
function addStop() {
  const stops = layer.value.color.stops
  stops.push({ color: '#ffffff', pos: stops.length ? 1 : 0 })
}
function removeStop(i: number) {
  const stops = layer.value.color.stops
  if (stops.length > 2) stops.splice(i, 1)
}
/** Replace the active layer's stops from a colour-theory harmony. */
function applyPaletteStops(stops: { pos: number; color: string }[]) {
  layer.value.color.stops = stops.map(s => ({ color: s.color, pos: s.pos }))
  stops.forEach((s, i) => onEdit(`layer.color.stops.${i}.color`, s.color))
}
// The seed-engine path: stops arrive already in their final colors+lightness,
// so this must not re-launder them through toStops. Reuse applyPaletteStops
// for the ramp, then recolor the mesh points too — the mesh layout renders
// from layer.mesh.points, not color.stops (the "Molten Rust came out blue" bug).
function applyLiteralStops(stops: { pos: number; color: string }[]) {
  applyPaletteStops(stops)
  const l = layer.value
  if (l.mesh?.points?.length) {
    l.mesh.points = recolorMeshPoints(l.mesh.points, stops, 'seed#meshcol')
  }
}

// ── motion tracks ─────────────────────────────────────────────────────────────
function addTrack() {
  const a = animatable.value.find(t => /\.shape\.phase$/.test(t.path)) ?? animatable.value[0]
  if (!a) return
  config.value.motion.tracks.push({
    path: a.path, from: a.min, to: a.max,
    // pingpong loops seamlessly (frame 0 == frame N) — this section exports
    // looping video, so a linear default would hard-cut at the loop boundary.
    easing: 'pingpong', loops: 1, hold: 0, cycleOffset: 0, delay: 0,
  })
  onEdit('motion.tracks', config.value.motion.tracks.length)
}
function removeTrack(i: number) { config.value.motion.tracks.splice(i, 1) }

// ── export ────────────────────────────────────────────────────────────────────
const EXPORT_RES = [{ label: '2K', w: 2048 }, { label: '4K', w: 4096 }, { label: '8K', w: 8192 }]
const exportFormat = ref<'png' | 'jpg'>('png')
const exportResW = ref(2048)
const exportDims = computed(() => {
  const ar = aspectRatio(config.value.canvas.aspect)
  return { w: exportResW.value, h: Math.round(exportResW.value / ar) }
})
function downloadExport() {
  const { w, h } = exportDims.value
  const out = gradientFx.render(config.value, w, h, 0)
  const a = document.createElement('a')
  a.href = out.toDataURL(exportFormat.value === 'png' ? 'image/png' : 'image/jpeg', 0.95)
  a.download = `gradient-${config.value.seed.replace('#', '')}.${exportFormat.value}`
  a.click()
}

// ── config persistence ────────────────────────────────────────────────────────
function loadConfig() {
  const c = currentNode()?.data?.properties?.sailor_gradientStudio
  if (c && typeof c === 'object') config.value = ensureConfigDefaults(cloneConfig(c))
}
function saveConfig() {
  const n = currentNode(); if (!n) return
  if (!n.data) n.data = {}
  if (!n.data.properties) n.data.properties = {}
  n.data.properties.sailor_gradientStudio = cloneConfig(config.value)
}

// Sticky footer status (StudioActionsFooter): real Saving…/Saved ✓ driven by
// useStudioAutosave, debounced off `config` — the studio's single source of
// truth, which saveConfig() clones straight onto the node (never written back
// into `config`, so there's no watch loop). Nothing mutates `config` on a
// per-frame/rAF cadence (renderFrame/loop only READ it to draw the preview),
// so watching the live ref directly (rather than a serialized signature, as
// Space Type/Scene3D need for their reactive sibling refs) is safe here.
const { saving: autoSaving, saved: autoSaved } = useStudioAutosave(() => config.value, saveConfig)

// Copy the current config JSON to the clipboard — for teaching the agent: build
// the look you want, click Copy, paste it back with the prompt it should satisfy.
const copied = ref(false)
async function copyConfig() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(config.value))
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch (e) { console.error('[gradient] copy config failed', e) }
}
// Save must never block closing — swallow any persistence error so the user can
// always exit the modal.
function closeEditor() {
  try { saveConfig() } catch (e) { console.error('[gradient] saveConfig failed', e) }
  emit('close')
}

// ── outputs (mirror Space Type) ───────────────────────────────────────────────
async function generateImage() {
  baking.value = true; bakeMsg.value = 'Rendering…'
  stopPreview()
  try {
    const blob = await renderCurrentBlob()
    if (!blob) { bakeMsg.value = ''; return }
    const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
    const [filename] = await uploadFrameBatch([blob], 'gradient_img')
    if (filename) {
      const n = currentNode()
      if (n) { n.data ||= {}; n.data.properties ||= {}; saveConfig() }
      await recordAsset(activeTab.value?.projectUuid, 'image', filename)
      window.dispatchEvent(new CustomEvent('sailor:gradientStudioOutput', {
        detail: { sourceNodeId: props.nodeId, nodeType: 'Image', widgetOverrides: { image: filename } },
      }))
      // Clear the in-flight message on success so the footer's `notice` (no longer
      // gated behind `baking` now that StudioActionsFooter reads it unconditionally)
      // doesn't keep showing "Rendering…" after the fact. closeEditor() unmounts this
      // surface in normal use, but clear it anyway rather than depend on that timing.
      bakeMsg.value = ''
      closeEditor()
    } else {
      // uploadFrameBatch swallows a failed upload and returns [] — surface it instead of
      // leaving the footer stuck on "Rendering…" forever.
      bakeMsg.value = 'Upload failed — see console.'
    }
  } catch (e) { console.error('[gradient] image generate failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

// Shared full-res blob capture — same render call `generateImage` uses, factored
// out so the param baker below (and any future caller) stays byte-identical.
async function renderCurrentBlob(): Promise<Blob | null> {
  const { w, h } = exportDims.value
  const { w: cw, h: ch } = clampExportDims(w, h)
  return await gradientFx.renderToBlob(config.value, cw, ch, 0)
}

// Studio param-baker (Slice 2a Task 8b) — bakes ONE frame with a set of
// `params.*` overrides applied (a collection sweep/generate row), without
// disturbing the studio's live on-screen config: snapshot the current value
// of every overridden key via the same dotted-path proxy the agent/onEdit
// paths use (`paramsProxy`), write the overrides through that same proxy
// (mutating the reactive `config` — identical to a user edit), render one
// full-res frame, then restore the snapshots in `finally` regardless of
// success/failure. `gradientFx.renderToBlob` draws straight to its own
// internal canvas (not the on-screen preview `<canvas>` ref) and is fully
// synchronous up to the `toBlob` callback, so there's no Vue render tick to
// wait out here — writing `config` then calling `renderToBlob` immediately
// sees the new values with no `nextTick`/rAF needed.
async function renderBlobWithOverrides(overrides: Record<string, string | number>): Promise<Blob | null> {
  const keys = Object.keys(overrides)
  // Pin the active layer at entry: `paramsProxy`'s `layer.`-scoped keys resolve
  // against activeLayer.value LIVE, so if the user switches layers while this
  // awaits renderCurrentBlob(), the module-level proxy would snapshot/restore
  // against a DIFFERENT layer than the one the overrides were meant for. Build
  // a local proxy pinned to the layer active at call time and use it for the
  // snapshot, the override application, and the restore.
  const pinned = activeLayer.value
  const pinnedParams = makeConfigParams(() => config.value, () => pinned)
  const snapshot = new Map<string, string | number | undefined>()
  for (const key of keys) snapshot.set(key, pinnedParams[key] as string | number | undefined)
  try {
    for (const key of keys) pinnedParams[key] = overrides[key]!
    return await renderCurrentBlob()
  } catch (e) {
    console.error('[gradient] param-baker render failed', e)
    return null
  } finally {
    for (const key of keys) {
      const prev = snapshot.get(key)
      if (prev !== undefined) pinnedParams[key] = prev
    }
  }
}

/** Bake the current Gradient state to frames at `motion.fps`/`motion.duration`
 *  and encode server-side to a video file under input/. Shared by generateVideo()
 *  (dispatches a Video node onto the canvas) and downloadVideoFile() (saves the
 *  file locally) so this frame-bake exists in exactly one place. Callers own
 *  baking.value/stopPreview/startPreview. A bake-stage failure (ensureSpaceTypeBake)
 *  propagates to the caller; an encode-stage failure is caught here (mirrors the
 *  original generateVideo's nested try/catch) and reported via bakeMsg, returning
 *  null so callers treat it as "nothing to dispatch/download" without their own
 *  catch firing a second, more generic message. */
async function bakeGradientVideo(): Promise<{ filename: string; ext: 'mp4' | 'webm' } | null> {
  const m = config.value.motion
  const { w, h } = { w: m.size && aspectRatio(config.value.canvas.aspect) >= 1 ? Math.round(m.size * aspectRatio(config.value.canvas.aspect)) : m.size, h: m.size }
  const total = Math.max(1, Math.round(m.fps * m.duration))
  const bakeCfg = { fps: m.fps, loopDuration: m.duration, W: w, H: h, seed: config.value.seed, sig: JSON.stringify(config.value) }
  const bake = await ensureSpaceTypeBake(bakeCfg as any, undefined, {
    renderFrame: async (i) => {
      bakeMsg.value = `Baking ${i + 1}/${total}`
      return gradientFx.renderToBlob(config.value, w, h, (i / m.fps))
    },
  })
  bakeMsg.value = 'Encoding…'
  try {
    return await encodeFrames({ frames: bake.frames, fps: m.fps, width: w, height: h })
  } catch (encErr) {
    bakeMsg.value = 'Encode failed — restart ComfyUI to load the encoder.'
    console.error('[gradient] encode failed', encErr)
    return null
  }
}

async function generateVideo() {
  baking.value = true
  stopPreview()
  try {
    const encoded = await bakeGradientVideo()
    if (!encoded) return
    await recordAsset(activeTab.value?.projectUuid, 'video', encoded.filename)
    window.dispatchEvent(new CustomEvent('sailor:gradientStudioOutput', {
      detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: encoded.filename } },
    }))
    bakeMsg.value = ''
    closeEditor()
  } catch (e) { console.error('[gradient] video generate failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

/** Download the current full-res still as a PNG — same render call generateImage()
 *  uses (renderCurrentBlob), just saved locally instead of dispatched to the canvas. */
async function downloadPng() {
  const blob = await renderCurrentBlob()
  if (blob) downloadBlobAsFile(blob, `gradient_${Date.now()}.png`)
}

/** Same bake as generateVideo(), but saves the encoded file locally instead of
 *  dispatching a Video node onto the canvas. Unlike generateVideo/generateImage,
 *  this never calls closeEditor() — the modal stays open (see the plan) — so
 *  bakeMsg MUST be cleared on success here, or the footer's notice would show a
 *  stale "Encoding…" forever instead of returning to idle. */
async function downloadVideoFile() {
  baking.value = true
  stopPreview()
  try {
    const encoded = await bakeGradientVideo()
    if (!encoded) return
    // NOT `/input/${filename}` — that path isn't in the Nuxt dev server's
    // comfyui-proxy PROXY_PREFIXES (server/middleware/comfyui-proxy.ts only
    // proxies /view, /upload, etc.) and 404s; verified live. ComfyUI's own
    // /view endpoint (proxied) serves the same input/ file by filename+type.
    const res = await fetch(`/view?${new URLSearchParams({ filename: encoded.filename, type: 'input' })}`)
    if (!res.ok) throw new Error(`/view returned ${res.status}`)
    downloadBlobAsFile(await res.blob(), `gradient_${Date.now()}.${encoded.ext}`)
    bakeMsg.value = ''
  } catch (e) { console.error('[gradient] video download failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

async function exportWebEmbed() {
  // Disabled while in flight (see the button below): a double-click otherwise
  // starts two full-resolution GL bakes and downloads two files.
  if (embedding.value) return
  embedding.value = true
  embedErr.value = false
  embedMsg.value = 'Building…'
  try {
    // Same sizing as the still-image export path (downloadExport/renderCurrentBlob
    // above) — do not invent new sizing logic here. clampExportDims scales both
    // axes together so a non-square aspect (e.g. 9:16 at 4K) doesn't get
    // squashed into a square by an independent per-axis clamp.
    const { w, h } = exportDims.value
    const { w: ew, h: eh } = clampExportDims(w, h)
    // Matches the studio's own loop(): frameSource.ts always derives duration
    // from cfg.motion.duration.
    const duration = config.value.motion?.duration ?? 4

    // Gradient is fully procedural — no source image, no EffectDefs to filter —
    // so unlike the shader adapter's config, this is just the config plus the
    // loop duration. See GradientEmbedConfig in ~/lib/embed/surfaces/gradient.
    const embedConfig: GradientEmbedConfig = {
      cfg: structuredClone(toRaw(config.value)),
      duration,
    }

    const html = await exportEmbedHtml({
      kind: 'gradient',
      config: embedConfig,
      duration,
      width: ew,
      height: eh,
    })

    // Size is shown BEFORE the download, not discovered later. Still one
    // action — no confirmation dialog.
    const kb = (new Blob([html]).size / 1024).toFixed(0)
    embedMsg.value = `${kb} KB — downloading…`
    await nextTick()
    downloadEmbed('sailor-gradient-embed.html', html)
    embedMsg.value = `Downloaded — ${kb} KB`
  } catch (err) {
    console.error('[GradientStudio] embed export failed:', err)
    embedErr.value = true
    embedMsg.value = err instanceof Error ? err.message : 'Export failed'
  } finally {
    embedding.value = false
  }
}

// ── keyboard shortcuts ────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  if (e.code === 'Space') { e.preventDefault(); randomize('all') }
  else if (e.key === 'c' || e.key === 'C') randomize('colors')
  else if (e.key === 's' || e.key === 'S') randomize('structure')
  else if (e.key === 'e' || e.key === 'E') downloadExport()
  else if (e.key === 'Escape') closeEditor()
}

// Re-render the static preview when its container resizes, so the dpr-matched backing
// stays 1:1 with the display (otherwise a resize would scale the old backing → moiré).
let resizeObs: ResizeObserver | null = null
function watchPreviewResize() {
  const wrap = canvas.value?.parentElement
  if (!wrap || typeof ResizeObserver === 'undefined') return
  resizeObs = new ResizeObserver(() => { if (!animated.value) renderFrame(0) })
  resizeObs.observe(wrap)
}

onMounted(() => {
  loadConfig()
  startPreview()
  watchPreviewResize()
  window.addEventListener('keydown', onKey)
  registerStudioParamBaker(props.nodeId, renderBlobWithOverrides)
})
onBeforeUnmount(() => {
  saveConfig(); stopPreview()
  resizeObs?.disconnect(); resizeObs = null
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointermove', onHandleMove)
  window.removeEventListener('pointerup', onHandleUp)
  unregisterStudioParamBaker(props.nodeId)
})

function setLayout(l: LayoutKind) {
  // Layer 0 has no override of its own — it anchors to canvas.layout, so writing
  // there (and clearing any stray layers[0].layout) is how layer 0 changes layout.
  // Layers 1+ get their own per-layer override; canvas.layout is untouched.
  if (activeLayer.value === 0) {
    config.value.canvas.layout = l
    delete config.value.layers[0]!.layout
  } else {
    config.value.layers[activeLayer.value]!.layout = l
  }
  // Backfill stack params so the sliders + render agree the moment you switch to Stack.
  if (l === 'stack') {
    const s = layer.value.shape
    if (s.rotStep == null) s.rotStep = 8
    if (s.pivot == null) s.pivot = 0.1
    if (s.ringScale == null) s.ringScale = 1
    if (s.ringShape == null) s.ringShape = 'circle'
  }
  // Mesh reads layer-0 points; create them (from the current palette) on first switch.
  // Excluded from the picker on layers 1+ (see LAYOUTS filter below), so this only
  // ever fires with activeLayer already 0 — the guard just documents that invariant.
  if (l === 'mesh' && activeLayer.value === 0) { ensureMesh() }
}
function setShape(s: ShapeKind) { layer.value.shape.type = s }

// The sink for CurveHandleEditor's drag emits (the handles overlaid on the preview):
// `path` arrives as 'layer.curve.start.x', 'layer.curve.mode', etc. — the two Vec2
// fields are written component-by-component; everything else writes straight onto the
// curve object by its remaining key. Seeds the FULL CURVE_DEFAULTS, with fresh
// start/end objects (not shared references), on first touch, for the same reason
// seedContainer does: `layer.curve` is optional for back-compat and isn't backfilled
// by setLayout (only ensureConfigDefaults does that, at load).
function onCurve(path: string, value: number | string) {
  const L = layer.value
  if (!L.curve) L.curve = { ...CURVE_DEFAULTS, start: { ...CURVE_DEFAULTS.start }, end: { ...CURVE_DEFAULTS.end } }
  const rest = path.replace(/^layer\.curve\./, '')
  if (rest === 'start.x') L.curve.start.x = value as number
  else if (rest === 'start.y') L.curve.start.y = value as number
  else if (rest === 'end.x') L.curve.end.x = value as number
  else if (rest === 'end.y') L.curve.end.y = value as number
  else (L.curve as any)[rest] = value
  onEdit(path, value)
}
</script>

<template>
  <StudioModalShell
    title="Gradient studio"
    :agent="gradientAgent"
    agent-placeholder="Describe the look — e.g. warmer, more liquid, calmer…"
    @close="closeEditor"
  >
    <template #aside>
      <StudioLayerStack
        :layers="config.layers.map((l, i) => ({ label: layerNames[i] ?? `Layer ${i + 1}`, enabled: layerEnabled(i) }))"
        :active-index="activeLayer" :max="LAYER_MAX"
        @select="activeLayer = $event"
        @add="addLayer" @remove="removeLayer" @duplicate="duplicateLayer"
        @reorder="reorderLayer" @toggle="toggleLayer" />
    </template>

    <template #preview>
      <div class="relative flex h-full w-full items-center justify-center overflow-hidden" @wheel="onPreviewWheel">
        <canvas ref="canvas" class="max-h-full max-w-full rounded-lg shadow-2xl"
                :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }" />
        <!-- Mesh drag handles: one per color point, overlaid exactly on the canvas.
             z-30 lifts the handles above the floating randomize toolbar so points near
             the top stay grabbable; the container is pointer-events-none so the toolbar
             buttons still receive clicks everywhere a handle isn't. -->
        <div v-if="isMesh" class="pointer-events-none absolute z-30"
             :style="{ left: meshOverlay.left + 'px', top: meshOverlay.top + 'px', width: meshOverlay.w + 'px', height: meshOverlay.h + 'px' }">
          <button v-for="(pt, i) in (config.layers[0]?.mesh?.points ?? [])" :key="i"
                  class="pointer-events-auto absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white shadow-md ring-1 ring-black/40 transition active:cursor-grabbing"
                  :class="dragPoint === i ? 'scale-125' : 'hover:scale-110'"
                  :style="{ left: pt.x * 100 + '%', top: pt.y * 100 + '%', background: pt.color }"
                  :title="`Point ${i + 1} — drag to move`"
                  @pointerdown="onHandleDown(i, $event)" /></div>
        <!-- Curve layout: draggable start/end/curvature handles overlaid on the
             preview, writing straight into layer.curve.* (see onCurve above). Uses
             the canvas element directly (same getBoundingClientRect tracking as
             StringPathEditor/LoftSpineEditor) so it stays aligned through the
             preview's own pan/zoom CSS transform. -->
        <CurveHandleEditor v-if="isCurve" class="z-30" :model-value="layer.curve ?? CURVE_DEFAULTS" :canvas="canvas" @edit="onCurve" />
        <!-- Zoom controls (default z: the pointer-events-none mesh-handle overlay
             above lets clicks fall through here, and handles stay grabbable). -->
        <div class="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-white/10 bg-neutral-900/80 p-0.5 shadow-lg backdrop-blur">
          <button class="rounded p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30" title="Zoom out" :disabled="zoom <= 0.25" @click="zoomBy(1 / 1.25)">
            <Minus class="h-3.5 w-3.5" />
          </button>
          <button class="min-w-[3.25rem] rounded px-1 py-1 text-center text-xs tabular-nums text-white/70 transition hover:bg-white/10 hover:text-white" title="Reset to 100%" @click="resetZoom">
            {{ Math.round(zoom * 100) }}%
          </button>
          <button class="rounded p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30" title="Zoom in" :disabled="zoom >= 4" @click="zoomBy(1.25)">
            <Plus class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </template>

    <template #actions>
      <StudioActionsFooter :spec="{
        status: {
          saving: autoSaving, saved: autoSaved,
          error: glError || (embedErr ? embedMsg : null),
          notice: (!embedErr && embedMsg) ? embedMsg : (bakeMsg || null),
        },
        utilities: [{ label: copied ? '✓ Copied' : 'Copy config', onClick: copyConfig }],
        downloads: [
          { label: 'Download PNG', onClick: downloadPng },
          { label: 'Download video', onClick: downloadVideoFile, busy: baking },
          { label: 'Export embed', onClick: exportWebEmbed, busy: embedding },
        ],
        canvas: [
          { label: 'As image', onClick: generateImage, busy: baking },
          { label: 'As video', onClick: generateVideo, busy: baking },
        ],
      }" />
    </template>

    <template #controls>
      <!-- Design | Motion — same split as Space Type and 3D Studio. -->
      <div class="flex shrink-0 gap-1 rounded-lg bg-white/[0.04] p-1 text-[11px]">
        <button type="button" class="flex-1 rounded px-2 py-1"
                :class="onDesign ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                @click="inspectorTab = 'design'">Design</button>
        <button type="button" class="flex-1 rounded px-2 py-1"
                :class="onMotion ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                @click="inspectorTab = 'motion'">
          Motion<span v-if="config.motion.tracks.length" class="ml-1 text-white/40">{{ config.motion.tracks.length }}</span>
        </button>
      </div>

      <!-- The whole design inspector, drawn from GRADIENT_CONTROLS through the shared
           panel: the design cards (Canvas … Shape) and the post stack's own cards
           (Bloom/Color/Duotone/…), one invocation. `panelControls` is the presentation
           remap — see ~/lib/gradientfx/panelPresentation.ts — which carries the shipped
           card titles, row order and dynamic captions; the bespoke blocks the schema
           never described come back in through the slots below. -->
      <StudioControlPanel
        v-show="onDesign"
        :controls="panelControls"
        :order="GRADIENT_PANEL_SECTIONS"
        :value="controlValue"
        :sections="sectionChrome"
        :bound-for="boundColumnFor"
        :go-to-collection="goToCollection"
        @set="setControl"
        @promote="promoteControl"
        @menu="onControlMenu"
      >
        <template #control-canvas.aspect>
          <BindableRow control-key="canvas.aspect" label="Aspect ratio" kind="select" :bound="boundColumnFor('canvas.aspect')" @menu="openVarMenu" @promote="(control) => promote(control, paramsProxy[control.key] as string | number)">
            <label class="mb-1 flex items-center justify-between text-xs text-white/60">
              <span>Aspect ratio</span>
              <button class="text-white/30 hover:text-white/70" @click="toggleLock('aspect')"><component :is="locked('aspect') ? Lock : Unlock" class="h-3 w-3" /></button>
            </label>
            <select v-model="config.canvas.aspect" class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs" @change="onEdit('canvas.aspect', config.canvas.aspect)">
              <option v-for="a in ASPECTS" :key="a" :value="a">{{ a }}</option>
            </select>
          </BindableRow>
        </template>

        <template #control-canvas.layout>
          <label class="mb-1 flex items-center justify-between text-xs text-white/60">
            <span>Layout</span>
            <button class="text-white/30 hover:text-white/70" @click="toggleLock('layout')"><component :is="locked('layout') ? Lock : Unlock" class="h-3 w-3" /></button>
          </label>
          <div class="grid grid-cols-3 gap-1">
            <button v-for="l in (activeLayer > 0 ? LAYOUTS.filter((x) => x !== 'mesh') : LAYOUTS)" :key="l" class="rounded px-1 py-1 text-[11px] transition"
                    :class="activeLayout === l ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="setLayout(l)">{{ LAYOUT_LABELS[l] }}</button>
          </div>
        </template>

        <!-- Colour stops: runtime cardinality (N stops, add/remove) plus the harmony
             picker, so it was never a ControlSpec row. -->
        <template #control-ui.color.stops>
          <p v-if="isMesh" class="mb-2 text-[11px] leading-snug text-white/40">The palette mesh points are sampled from when you scatter or randomize colours.</p>
          <div class="space-y-1">
            <div v-for="(stop, i) in layer.color.stops" :key="i" class="flex items-center gap-1.5">
              <BindableRow :control-key="`layer.color.stops.${i}.color`" :label="`Colour ${i + 1}`" kind="color" :bound="boundColumnFor(`layer.color.stops.${i}.color`)" @menu="openVarMenu" @promote="(control) => promote(control, paramsProxy[control.key] as string | number)">
                <StudioColor v-model="stop.color" @update:model-value="(v: string) => onEdit(`layer.color.stops.${i}.color`, v)" />
              </BindableRow>
              <input v-studio-reset v-model.number="stop.pos" type="range" min="0" max="1" step="0.01" class="studio-range min-w-0 flex-1" />
              <span class="w-9 shrink-0 text-right text-[10px] text-white/40">{{ Math.round(stop.pos * 100) }}%</span>
              <button v-if="layer.color.stops.length > 2" class="shrink-0 text-white/30 hover:text-white/70" @click="removeStop(i)"><Trash2 class="h-3 w-3" /></button>
            </div>
            <button class="mt-1 flex items-center gap-1 rounded bg-white/[0.06] px-2 py-1 text-[11px] text-white/60 hover:text-white" @click="addStop"><Plus class="h-3 w-3" /> Add stop</button>
          </div>
          <div class="mt-2 border-t border-white/[0.06] pt-2">
            <PalettePicker mode="stops" :stop-count="layer.color.stops.length" :seed="layer.color.stops[0]?.color ?? '#4f8ad9'" @apply-stops="applyPaletteStops" @apply-literal-stops="applyLiteralStops" />
          </div>
        </template>

        <!-- Gradient direction (u_gradHoriz) and Mapping (u_mapping) are read ONLY by
             linear/radial/orbit in the shader. STACK derives its axis from ring rotation
             (rotStep/pivot) and never reads either uniform; simple primitives / curve /
             liquid / mesh don't read them either. The anchor's own gate says so. -->
        <template #control-ui.color.direction>
          <label class="mb-1 block text-xs text-white/60">Gradient direction</label>
          <div class="mb-2 grid grid-cols-2 gap-1">
            <button v-for="gd in GRADIENT_DIRS" :key="gd" class="rounded px-1 py-1 text-[11px] capitalize transition"
                    :class="layer.color.gradientDir === gd ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="layer.color.gradientDir = gd">{{ gd }}</button>
          </div>
          <label class="mb-1 block text-xs text-white/60">Mapping</label>
          <div class="grid grid-cols-3 gap-1">
            <button v-for="mp in MAPPINGS" :key="mp" class="rounded px-1 py-1 text-[11px] capitalize transition"
                    :class="layer.color.mapping === mp ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="layer.color.mapping = mp">{{ mp }}</button>
          </div>
        </template>

        <template #control-ui.flow.intro>
          <p class="text-[11px] leading-snug text-white/40">Warps the gradient into liquid swirls. At 0 intensity the gradient is undistorted.</p>
        </template>
        <template #section-Flow>
          <p class="text-[10px] leading-snug text-white/30">Living drift — the warp flows over the loop. Export as video to capture the motion.</p>
        </template>

        <template #control-ui.liquid.presets>
          <label class="mb-1 block text-xs text-white/60">Presets</label>
          <div class="grid grid-cols-3 gap-1">
            <button v-for="p in LIQUID_PRESETS" :key="p" class="rounded bg-white/[0.04] px-1 py-1 text-[11px] capitalize text-white/60 transition hover:bg-white/10 hover:text-white"
                    @click="applyLiquidPreset(p)">{{ p }}</button>
          </div>
        </template>

        <template #control-ui.liquid.intro>
          <p class="text-[11px] leading-snug text-white/40">Push the smoky warp toward real fluid — marbled veins, a wet rippling skin, glassy refraction, and viscosity.</p>
        </template>

        <!-- Mesh points: one colour + position per point, add/remove/scatter. -->
        <template #control-ui.mesh.points>
          <p class="mb-2 text-[11px] leading-snug text-white/40">Drag the dots on the preview to move points. Colours come from the palette below — scatter re-samples them.</p>
          <div class="space-y-1">
            <div v-for="(pt, i) in mesh.points" :key="i" class="flex items-center gap-1.5">
              <BindableRow :control-key="`layer.mesh.points.${i}.color`" :label="`Colour ${i + 1}`" kind="color" :bound="boundColumnFor(`layer.mesh.points.${i}.color`)" @menu="openVarMenu" @promote="(control) => promote(control, paramsProxy[control.key] as string | number)">
                <StudioColor v-model="pt.color" @update:model-value="(v: string) => onEdit(`layer.mesh.points.${i}.color`, v)" />
              </BindableRow>
              <span class="min-w-0 flex-1 truncate text-[11px] text-white/40">Point {{ i + 1 }} · {{ Math.round(pt.x * 100) }},{{ Math.round(pt.y * 100) }}</span>
              <button v-if="mesh.points.length > 2" class="shrink-0 text-white/30 hover:text-white/70" @click="removeMeshPoint(i)"><Trash2 class="h-3 w-3" /></button>
            </div>
            <div class="mt-1 flex gap-1.5">
              <button v-if="mesh.points.length < MESH_MAX_POINTS" class="flex items-center gap-1 rounded bg-white/[0.06] px-2 py-1 text-[11px] text-white/60 hover:text-white" @click="addMeshPoint"><Plus class="h-3 w-3" /> Add point</button>
              <button class="flex items-center gap-1 rounded bg-white/[0.06] px-2 py-1 text-[11px] text-white/60 hover:text-white" @click="scatterMesh"><Dices class="h-3 w-3" /> Scatter</button>
            </div>
          </div>
        </template>

        <template #control-ui.shape.kind>
          <div class="grid grid-cols-4 gap-1">
            <button v-for="s in SHAPE_KINDS" :key="s" class="rounded px-1 py-1 text-[11px] capitalize transition"
                    :class="layer.shape.type === s ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="setShape(s)">{{ s }}</button>
          </div>
        </template>

        <template #control-ui.shape.ringShape>
          <label class="mb-1 block text-xs text-white/60">Ring shape</label>
          <div class="grid grid-cols-3 gap-1">
            <button v-for="rs in RING_SHAPES" :key="rs" class="rounded px-1 py-1 text-[11px] capitalize transition"
                    :class="(layer.shape.ringShape ?? 'circle') === rs ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="layer.shape.ringShape = rs">{{ rs }}</button>
          </div>
        </template>

        <template #control-ui.shape.direction>
          <label class="mb-1 block text-xs text-white/60">Direction</label>
          <div class="grid grid-cols-4 gap-1">
            <button v-for="d in DIRECTIONS" :key="d" class="rounded py-1 text-xs transition"
                    :class="layer.shape.direction === d ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="layer.shape.direction = d">{{ { up: '↑', right: '→', down: '↓', left: '←' }[d] }}</button>
          </div>
        </template>

        <template #control-ui.shape.mirror>
          <label class="mb-1 block text-xs text-white/60">Mirror</label>
          <div class="grid grid-cols-4 gap-1">
            <button v-for="mk in MIRROR_KINDS" :key="mk" class="rounded px-1 py-1 text-[11px] capitalize transition"
                    :class="layer.shape.mirror === mk ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/55 hover:bg-white/10'"
                    @click="layer.shape.mirror = mk">{{ mk === 'horizontal' ? 'Horiz' : mk === 'vertical' ? 'Vert' : mk }}</button>
          </div>
        </template>
      </StudioControlPanel>

      <!-- Motion -->
      <StudioSection v-show="onMotion" title="Motion" :open="onMotion">
        <template #badge>
          <button class="flex items-center gap-1 normal-case text-white/40 hover:text-white" @click.stop="addTrack"><Plus class="h-3 w-3" /> Track</button>
        </template>
        <p v-if="!config.motion.tracks.length" class="text-[11px] text-white/30">Add a track to animate a parameter and export video.</p>
        <div v-for="(tk, i) in config.motion.tracks" :key="i" class="mb-2 rounded border border-white/10 p-2">
          <div class="mb-1 flex items-center gap-1">
            <select v-model="tk.path" class="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[11px]">
              <option v-if="tk.path && !animatable.some(a => a.path === tk.path)" :value="tk.path">{{ tk.path }}</option>
              <option v-for="a in animatable" :key="a.path" :value="a.path">{{ a.label }}</option>
            </select>
            <button class="text-white/30 hover:text-white/70" @click="removeTrack(i)"><Trash2 class="h-3 w-3" /></button>
          </div>
          <div class="mb-1 flex items-center gap-1 text-[11px] text-white/50">
            <span>from</span><input v-model.number="tk.from" type="number" step="0.05" class="w-14 rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5" />
            <span>to</span><input v-model.number="tk.to" type="number" step="0.05" class="w-14 rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5" />
          </div>
          <div class="flex items-center gap-1">
            <select v-model="tk.easing" class="rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[11px]">
              <option value="linear">Linear</option><option value="pingpong">Ping-pong</option><option value="easeinout">Ease</option>
            </select>
            <select v-model.number="tk.loops" class="rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[11px]">
              <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option>
            </select>
            <span class="text-[11px] text-white/40">loops</span>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <div>
            <StudioSlider label="Duration" :min="1" :max="12" :step="0.5" :bindable="false"
              :model-value="config.motion.duration"
              @update:model-value="(v: number) => { config.motion.duration = v }" />
          </div>
          <div>
            <label class="mb-1 block text-[11px] text-white/60">FPS</label>
            <select v-model.number="config.motion.fps" class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[11px]">
              <option :value="24">24</option><option :value="30">30</option><option :value="60">60</option>
            </select>
          </div>
        </div>
        <div class="mt-1 text-[10px] text-white/30">{{ Math.round(config.motion.fps * config.motion.duration) }} frames</div>
      </StudioSection>
      <!-- Export -->
      <StudioSection v-show="onDesign" title="Export" :open="false">
        <div class="grid grid-cols-2 gap-1.5">
          <button v-for="f in (['png', 'jpg'] as const)" :key="f" class="rounded border px-2 py-1.5 text-xs transition"
                  :class="exportFormat === f ? 'border-white/30 bg-white/15 text-white' : 'border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/[0.08]'"
                  @click="exportFormat = f">{{ f.toUpperCase() }}</button>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          <button v-for="r in EXPORT_RES" :key="r.w" class="rounded border px-1 py-1.5 text-xs transition"
                  :class="exportResW === r.w ? 'border-white/30 bg-white/15 text-white' : 'border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/[0.08]'"
                  @click="exportResW = r.w">{{ r.label }}</button>
        </div>
        <div class="text-[10px] text-white/30">{{ exportDims.w }} × {{ exportDims.h }} · {{ exportFormat.toUpperCase() }}</div>
        <button class="w-full rounded bg-white/10 px-3 py-2 text-xs text-white/80 transition hover:bg-white/20" @click="downloadExport">
          Export {{ exportFormat.toUpperCase() }} <span class="text-white/30">E</span>
        </button>
      </StudioSection>
    </template>
  </StudioModalShell>
  <CanvasContextMenu
    v-if="varMenu"
    :x="varMenu.x"
    :y="varMenu.y"
    :items="varMenu.items"
    @close="varMenu = null"
  />
  <SweepPopover
    v-if="sweepPopover"
    :control="sweepPopover.control"
    :anchor="sweepPopover.anchor"
    @apply="applySweep"
    @close="sweepPopover = null"
  />
</template>
