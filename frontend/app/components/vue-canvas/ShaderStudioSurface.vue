<!-- frontend/app/components/vue-canvas/ShaderStudioSurface.vue -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { ChevronRight, Plus, Trash2 } from 'lucide-vue-next'
import CatalogModal from '~/components/CatalogModal.vue'
import StudioModalShell from '~/components/vue-canvas/StudioModalShell.vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioLayerStack from '~/components/vue-canvas/StudioLayerStack.vue'
import StudioActionsFooter from '~/components/vue-canvas/studio/StudioActionsFooter.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
// Explicit paths: Nuxt auto-import silently no-ops these row adapters here (the known
// duplicated-path-segment gotcha), so import them by full path like ComfyNodeWidget does.
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
import BindableRow from '~/components/vue-canvas/studio/BindableRow.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import CanvasContextMenu from '~/components/vue-canvas/CanvasContextMenu.vue'
import { assetUrl, fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import { resolveValues, resolveUniforms } from '~/lib/shaderfx/params'
import { shaderFx } from '~/lib/shaderfx/renderer'
import type { EffectDef, GradientStop, ParamValue, ShaderFxCatalog } from '~/lib/shaderfx/types'
import { matchesShowWhen } from '~/lib/shaderfx/showWhen'
import { composePasses, type EffectTextureBundle } from '~/lib/shaderstudio/passes'
import { stackWantsClock } from '~/lib/shaderstudio/clock'
import { migrateShaderConfig } from '~/lib/shaderstudio/migrate'
import { ANIMATABLE, applyMotion } from '~/lib/shaderstudio/motion'
import { ADJUST_PRESETS, applyAdjustPreset, EFFECT_LOOKS } from '~/lib/shaderstudio/presets'
import { assertEmbeddableSource, exportClock, makeImageSource, makeLiveSource, motionConfigFor, resolveSourceKind, type ResolvedSource } from '~/lib/shaderstudio/resolve'
import { frameSourceEpoch } from '~/lib/studio/frameSource'
import { loadImage } from '~/lib/shaderstudio/source'
import { BLEND_MODES } from '~/lib/studio/blend'
import { cloneConfig, defaultConfig, defaultMask, hydrateConfig, LAYER_MAX, newLayerId, outputDims, type EffectMask, type MaskShape, type MotionTrack, type ShaderStudioConfig, type StudioEffect } from '~/lib/shaderstudio/types'
import { ensureSpaceTypeBake } from '~/lib/spacetype/bake'
import { encodeFrames } from '~/lib/engine/encodeVideo'
import { useStudioAgent } from '~/composables/useStudioAgent'
import { useStudioVarBindings } from '~/composables/useStudioVarBindings'
import { useStudioVarMenu } from '~/composables/useStudioVarMenu'
import { makeConfigParams } from '~/lib/agent/configParams'
import { shaderAgentControls } from '~/lib/shaderstudio/agentControls'
import { controlsForStudio } from '~/lib/collection/studioControls'
import type { StudioControlDesc } from '~/lib/collection/studioBindables'
import { registerStudioParamBaker, unregisterStudioParamBaker } from '~/lib/studio/cascade'
import { makeListRemap } from '~/lib/studio/listRemap'
import { useStudioAutosave } from '~/lib/studio/autosave'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'
import SweepPopover from '~/components/vue-canvas/studio/SweepPopover.vue'
import { exportEmbedHtml, downloadEmbed } from '~/lib/embed/export'
import type { ShaderEmbedConfig } from '~/lib/embed/surfaces/shader'

const props = defineProps<{ nodeId: string; nodes: any[]; edges?: any[]; wiredUrl?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { recordAsset } = useProjectGenerations()
const { activeTab } = useTabs()
function currentNode() { return props.nodes.find((n: any) => n.id === props.nodeId) }

const config = ref<ShaderStudioConfig>(defaultConfig())
const catalog = ref<ShaderFxCatalog | null>(null)
const resolved = ref<ResolvedSource | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const glError = ref<string | null>(null)
const baking = ref(false)
const bakeMsg = ref('')
const embedMsg = ref('')
const embedErr = ref(false)
const embedding = ref(false)
// Preview backing-store cap. Kept high so grid-based effects (ASCII, halftone,
// dither) render enough pixels-per-cell to stay crisp on retina displays and at
// fine Size values — at 880 a dense ASCII grid mushed out. Export still upscales
// to the user's chosen resolution separately.
const PREVIEW_MAX_W = 1600
// Generative effects (aurora, plasma, mesh_gradient, …) synthesize their output
// from scratch — they never sample the source image — so they don't need one to
// render. shaderFx.render still requires *a* base texture argument even though
// generative shaders ignore its pixels, so a tiny neutral canvas stands in (mirrors
// ShaderEffectNode's `baseImage.value ?? placeholder` fallback). Output size has
// no source to derive from either, so it defaults to a square, matching
// ShaderEffectNode's default resolution (768) at its default 1:1 aspect.
const GENERATIVE_DIM = 768
const GENERATIVE_BASE = (() => {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 8
  c.getContext('2d')!.fillRect(0, 0, 8, 8)
  return c
})()

// Active effect — selected via the aside StudioLayerStack. The Stylized Effects
// section (picker/params/blend/opacity) and the agent tuner are both scoped to
// this index; motion tracks address a specific effect by dotted path
// (`effects.<idx>.params.<uniform>`), remapped on add/remove/reorder below.
const activeEffect = ref(0)
const activeEffectCfg = computed<StudioEffect>(() => config.value.effects[activeEffect.value] ?? config.value.effects[0]!)
/** Catalog lookup by (possibly legacy) id — the resolver composePasses, the active
 *  def and the preview clock all read through. */
function defForId(id: string): EffectDef | null {
  return catalog.value?.effects.find(e => e.id === resolveEffectId(id)) ?? null
}
const effectDef = computed<EffectDef | null>(() => defForId(activeEffectCfg.value?.id ?? ''))
// Generative effects synthesize their own output and don't require a source
// image — see ShaderEffectNode's `isGenerative`, which this mirrors.
const isGenerative = computed(() => !!effectDef.value?.generative)
// The inspector reads the resolved VALUES (a number, a hex string, or a stop
// list) — not `resolveUniforms`, whose colour/gradient output is already expanded
// into vec3s and indexed arrays for GL and has no control to bind to.
const effectValues = computed(() =>
  effectDef.value ? resolveValues(effectDef.value, activeEffectCfg.value?.params ?? {}) : {})
/** Aside layer-stack label: the catalog def's display name, or 'Empty' if unpicked. */
function effectLabel(e: StudioEffect): string {
  return catalog.value?.effects.find(d => d.id === resolveEffectId(e.id))?.name ?? 'Empty'
}

// In-product agent — "tune" the shader in natural language (Phase 1). The nested
// `config` is bridged to a flat Params; only the controls for currently-enabled
// stages (plus the active effect's float uniforms) are offered to the model.
const { getLocalSetting } = useLocalSettings()
const agentParams = makeConfigParams(() => config.value, () => activeEffect.value)
const activeAgentControls = computed(() => shaderAgentControls(config.value, effectDef.value, activeEffect.value))
// The shell renders the prompt + results from this object (see StudioModalShell).
const shaderAgent = useStudioAgent({
  controls: () => activeAgentControls.value, params: agentParams, label: () => 'Shader studio',
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  // Force a fresh synchronous render of the current config to the preview canvas,
  // then export it for the agent's visual self-review.
  render: async () => { await renderFrame(0); return canvas.value?.toDataURL('image/png') ?? null },
  // Four Takes: the thumbnail adapter + a Params view over a COPY of this config.
  takes: { studio: 'shader', config: () => config.value, paramsOf: c => makeConfigParams(() => c, () => activeEffect.value) },
})

// Collections variable binding (Slice 2a, Task 7a) — same recipe as Gradient Studio
// (Task 6): `studioControls` mirrors what the agent tuner offers (via
// `controlsForStudio`, loaded once since the composable wants a synchronous
// accessor) purely for the bind-menu's control descriptions (label/kind/min/max/
// step/options), matched by dotted key. The SAME dotted-path proxy the canvas
// agent tuner reads/writes (`agentParams` above) is reused here so onEdit/promote/
// unbind's "live value" reads and applyParam's writes address identical keys.
// Writing through this proxy mutates `config` directly, so the surface's existing
// `deep` watcher on `config` re-renders the preview — no extra watcher needed, and
// per the loop-safety note, nothing here calls onEdit from a config watch (only
// the explicit control handlers below do).
const studioControls = ref<StudioControlDesc[]>([])
onMounted(async () => { studioControls.value = await controlsForStudio(currentNode()) })

const { boundColumnFor, boundColumnKeyFor, onEdit, promote, unbind } = useStudioVarBindings(
  props.nodeId,
  () => studioControls.value,
  (key, value) => { agentParams[key] = value },
  { nodes: () => props.nodes, edges: () => props.edges ?? [] },
)

const { wiredColumns, sweepPopover, applySweep, varMenu, openVarMenu } = useStudioVarMenu({
  nodeId: () => props.nodeId,
  nodes: () => props.nodes,
  edges: () => props.edges ?? [],
  liveValue: (key) => agentParams[key] as string | number,
  boundColumnFor, boundColumnKeyFor, promote, unbind,
})

// ── effect textures (mirror ShaderEffectNode) ───────────────────────────────
const textureImages = new Map<string, HTMLImageElement>()

// ASCII "Custom" shape: rasterize the user's characters into a 1-row glyph atlas
// (COLS glyphs at CW×CH, matching the shader consts), auto-sorted dark→bright by
// ink coverage — same ramp logic as the baked sets. Cached by string so the same
// canvas object is reused (the renderer keys its texture cache on object identity).
const CUSTOM_CW = 192, CUSTOM_CH = 288, CUSTOM_COLS = 10
const customAtlasCache = new Map<string, HTMLCanvasElement>()
function buildCustomAtlas(raw: string): HTMLCanvasElement {
  const chars = raw && raw.length ? raw : ' .:-=+*#%@'
  const hit = customAtlasCache.get(chars)
  if (hit) return hit
  const px = Math.round(CUSTOM_CH * 0.9)
  const scored = [...new Set([...chars])].map((ch) => {
    const c = document.createElement('canvas'); c.width = CUSTOM_CW; c.height = CUSTOM_CH
    const x = c.getContext('2d')!
    x.fillStyle = '#000'; x.fillRect(0, 0, CUSTOM_CW, CUSTOM_CH)
    x.fillStyle = '#fff'; x.font = `${px}px Menlo, Monaco, "Courier New", monospace`
    x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText(ch, CUSTOM_CW / 2, CUSTOM_CH / 2)
    const d = x.getImageData(0, 0, CUSTOM_CW, CUSTOM_CH).data
    let ink = 0; for (let i = 0; i < d.length; i += 4) ink += d[i]
    return { ink, canvas: c }
  }).sort((a, b) => a.ink - b.ink)
  const atlas = document.createElement('canvas'); atlas.width = CUSTOM_COLS * CUSTOM_CW; atlas.height = CUSTOM_CH
  const ax = atlas.getContext('2d')!
  ax.fillStyle = '#000'; ax.fillRect(0, 0, atlas.width, atlas.height)
  for (let i = 0; i < CUSTOM_COLS; i++) {
    const idx = scored.length > 1 ? Math.round(i * (scored.length - 1) / (CUSTOM_COLS - 1)) : 0
    if (scored[idx]) ax.drawImage(scored[idx].canvas, i * CUSTOM_CW, 0)
  }
  customAtlasCache.set(chars, atlas)
  if (customAtlasCache.size > 16) customAtlasCache.delete(customAtlasCache.keys().next().value!)
  return atlas
}
// `layer` is the specific stacked effect being composited; omitted only by the
// catalog thumbnail renderer, which previews a def with default params.
function texBundle(def: EffectDef | null, layer?: StudioEffect): EffectTextureBundle {
  const sources: Record<string, TexImageSource> = {}
  const uniforms: Record<string, number> = {}
  if (!def) return { sources, uniforms }
  for (const t of def.textures) {
    const img = textureImages.get(t.file)
    if (img?.complete) sources[t.uniform] = img
    else if (!img) { const el = new Image(); el.onload = () => renderFrame(0); el.src = assetUrl(t.file, t.v); textureImages.set(t.file, el) }
    for (const [k, v] of Object.entries(t.extraUniforms ?? {})) uniforms[k] = v
  }
  // ASCII "Custom" shape (u_shape == 14) → bind the runtime glyph atlas. Resolve the
  // shape AND the glyph chars from THIS layer (not the active one) so a stacked or
  // non-active ASCII effect composites its own glyphs.
  const shape = layer?.params['u_shape'] ?? def.params.find(p => p.uniform === 'u_shape')?.default ?? 0
  if (def.id === 'ascii_dither' && Math.round(Number(shape)) === 14) {
    sources['u_customGlyphs'] = buildCustomAtlas(layer?.customChars ?? '')
  }
  return { sources, uniforms }
}

// ── preview ──────────────────────────────────────────────────────────────────
const animated = computed(() => (config.value.motion?.tracks?.length ?? 0) > 0)
/** Animate when EITHER our own tracks run or the source itself moves (mirrors ShaderStudioNode). */
const sourceAnimated = computed(() => (resolved.value?.duration ?? 0) > 0)
/** …or the picture itself is drawn off the clock: an effect in the stack has its own
 *  Speed dial up (or a Motion mode running). Without this the preview rendered a
 *  single frame at u_time = 0, so every such dial looked dead in the studio while
 *  the very same effect animated as a Frame fill. */
const effectAnimated = computed(() => stackWantsClock(config.value.effects, defForId))
const shouldLoop = computed(() => animated.value || sourceAnimated.value || effectAnimated.value)

/** Seconds per loop — the upstream source's clock when it has one, else our own. */
function clockDuration(): number {
  const src = resolved.value
  if (src && src.duration > 0) return src.duration
  return Math.max(0.1, config.value.motion.duration)
}

async function renderFrame(t01: number) {
  const el = canvas.value
  if (!el) return
  const src = resolved.value
  if (!src && !isGenerative.value) return
  const { w, h } = src
    ? outputDims(src.width, src.height, PREVIEW_MAX_W)
    : { w: GENERATIVE_DIM, h: GENERATIVE_DIM }
  if (el.width !== w || el.height !== h) { el.width = w; el.height = h }
  try {
    const base = src ? await src.getFrame(t01, w, h) : GENERATIVE_BASE
    // A bake (generateImage/generateVideo) may have started while this frame was
    // suspended at the await above — bail before touching the shared shaderFx
    // canvas so a resumed preview frame can't corrupt the export's toBlob read.
    if (baking.value) return
    // The clock is normalized 0..1, but motion tracks and u_time run in seconds.
    const dur = clockDuration()
    const t = t01 * dur
    // motionConfigFor is REQUIRED, not cosmetic: applyMotion divides by
    // cfg.motion.duration, so passing upstream-derived seconds against our own
    // (different) duration would run every track at the wrong rate.
    const cfg = animated.value ? applyMotion(motionConfigFor(config.value, dur), t) : config.value
    const passes = composePasses(cfg, defForId, t, (def, layer) => texBundle(def, layer))
    el.getContext('2d')!.drawImage(shaderFx.render(passes, base, w, h), 0, 0)
    glError.value = null
  } catch (e: any) { glError.value = String(e?.message ?? e) }
  measureMaskBox()
}

let raf = 0, start = 0, inFlight = false
function loop(ts: number) {
  if (!start) start = ts
  // getFrame is async; skip a tick rather than queueing, so a slow upstream
  // degrades to a lower frame rate instead of unbounded lag.
  if (!inFlight) {
    inFlight = true
    const dur = clockDuration()
    void renderFrame((((ts - start) / 1000) % dur) / dur).finally(() => { inFlight = false })
  }
  raf = requestAnimationFrame(loop)
}
function startPreview() {
  cancelAnimationFrame(raf); start = 0; inFlight = false
  if (shouldLoop.value) raf = requestAnimationFrame(loop)
  else void renderFrame(0)
}
function stopPreview() { cancelAnimationFrame(raf); raf = 0; inFlight = false }
watch(config, () => { if (!shouldLoop.value) void renderFrame(0) }, { deep: true })
watch(shouldLoop, startPreview)

// ── source loading ────────────────────────────────────────────────────────────
// Descriptor first (pure), then load if it is a file — mirrors ShaderStudioNode's
// resolution so the card and modal never disagree about what's wired in. A live
// upstream studio (e.g. Gradient Studio with flow.speed > 0) wins over the node's
// own file-based fallbacks. `wiredUrl` is intentionally NOT consulted here — it
// was the old image-only resolution and is null for a live upstream studio.
const sourceKind = computed(() => {
  frameSourceEpoch.value  // re-resolve when any studio (un)registers a frame source
  return resolveSourceKind(props.nodeId, props.nodes ?? [], props.edges ?? [])
})

const ownSourceUrl = computed(() => config.value.source.dataUrl
  ?? (config.value.source.asset
    ? `/view?${new URLSearchParams({ filename: config.value.source.asset, type: 'input' })}`
    : null))

watch([sourceKind, ownSourceUrl], async ([kind, ownUrl]) => {
  resolved.value = null
  if (kind?.kind === 'live') { resolved.value = makeLiveSource(kind.source); startPreview(); return }
  const url = kind?.kind === 'url' ? kind.url : ownUrl
  if (!url) return
  try { resolved.value = makeImageSource(await loadImage(url)); startPreview() }
  catch { glError.value = 'Could not load source image' }
}, { immediate: true })

function onUpload(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => { config.value.source = { kind: 'upload', dataUrl: String(reader.result) } }
  reader.readAsDataURL(file)
}

// Re-rolls the field/tears/grain seed. The deep `watch(config, …)` below already
// re-renders on any config mutation, so this only has to set the value.
function rerollSeed() {
  config.value.seed = Math.floor(Math.random() * 9999) + 1
}

// ── effect picker (CatalogModal) ───────────────────────────────────────────────
const pickerOpen = ref(false)
const pickerSearch = ref('')
const pickerFilter = ref('all')
const thumbs = ref<Record<string, string>>({})
const thumbCache: Record<string, string> = ((globalThis as any).__shaderStudioThumbs ??= {})
function titleCase(s: string): string { return s.replace(/(^|[_\s])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).trim() }
// Base image every gallery thumbnail is rendered over. Starts as a gradient and
// is replaced with the finn_shader sample once it loads (see below).
const placeholder = (() => { const c = document.createElement('canvas'); c.width = 192; c.height = 108; const g = c.getContext('2d')!; const lg = g.createLinearGradient(0, 0, 192, 108); lg.addColorStop(0, '#444'); lg.addColorStop(1, '#999'); g.fillStyle = lg; g.fillRect(0, 0, 192, 108); return c })()
;(() => {
  const img = new Image()
  img.onload = () => {
    const g = placeholder.getContext('2d')!
    const s = Math.min(img.width / 192, img.height / 108)  // cover-fit square → 16:9
    const sw = 192 * s, sh = 108 * s
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, 192, 108)
    for (const k of Object.keys(thumbCache)) delete thumbCache[k]  // bust stale gradient thumbs
    thumbs.value = {}
    if (pickerOpen.value) for (const def of catalog.value?.effects ?? []) ensureThumb(def)
    if (effectDef.value) ensureThumb(effectDef.value)
  }
  img.src = '/finn_shader.png'
})()
// Picker sections: image-transforming families first, generators last as
// their own shelf. Items are sorted in this order so keyboard nav follows
// the visual grouping.
const SHADER_SECTIONS = [
  { id: 'distortion', label: 'Distortion' },
  { id: 'stylize', label: 'Stylize' },
  { id: 'color', label: 'Color' },
  { id: 'lens', label: 'Lens' },
  { id: 'blur', label: 'Blur' },
  { id: 'glow', label: 'Glow' },
  { id: 'generative', label: 'Generative' },
]
const pickerFilters = computed(() => {
  const counts = new Map<string, number>()
  for (const e of catalog.value?.effects ?? []) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  const total = (catalog.value?.effects ?? []).length
  return [{ id: 'all', label: 'All', count: total }, ...[...counts].map(([id, count]) => ({ id, label: titleCase(id), count }))]
})
const pickerItems = computed<EffectDef[]>(() => {
  const q = pickerSearch.value.trim().toLowerCase()
  return (catalog.value?.effects ?? []).filter(e =>
    (pickerFilter.value === 'all' || e.category === pickerFilter.value)
    && (!q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)))
    .sort((a, b) =>
      SHADER_SECTIONS.findIndex(s => s.id === a.category)
      - SHADER_SECTIONS.findIndex(s => s.id === b.category))
})
function renderThumb(def: EffectDef): string {
  const b = texBundle(def)
  if (def.textures.length && Object.keys(b.sources).length < def.textures.length) return ''
  try {
    const out = shaderFx.render([{ id: def.id, source: def.source, uniforms: { ...resolveUniforms(def, {}), u_time: 1.2, u_seed: 42, u_hasInput: 1, ...b.uniforms }, textures: b.sources }], placeholder, 192, 108)
    return out.toDataURL('image/jpeg', 0.82)
  } catch { return '' }
}
function ensureThumb(def: EffectDef | null | undefined) { if (!def || thumbCache[def.id]) return; const t = renderThumb(def); if (t) { thumbCache[def.id] = t; thumbs.value = { ...thumbCache } } }
function openPicker() { pickerSearch.value = ''; pickerFilter.value = 'all'; pickerOpen.value = true; for (const def of catalog.value?.effects ?? []) ensureThumb(def) }
function pickEffect(id: string) {
  // TWIN of `switchStudioEffect` in ~/lib/shaderstudio/types.ts (the agent's
  // effect macro goes through that one). The reset-field set below is pinned
  // equal to its EFFECT_SWITCH_RESET_FIELDS by tests/unit/shader-agent-vocab —
  // a new StudioEffect field that a switch must clear has to be added in BOTH.
  // The pin covers the field SET only, not behaviour, and the two already
  // differ: switchStudioEffect no-ops when `id` is unchanged, so the agent
  // cannot wipe a hand-tuned layer by re-asserting its current effect. This
  // function has no such guard — re-picking the ALREADY-ACTIVE effect here
  // still resets params to defaults. Open item, not intentional.
  // Preserve layerId/blend/opacity/enabled (and motion-track addressing, which
  // targets this effect by array index); only the id/params/customChars reset.
  config.value.effects[activeEffect.value] = { ...config.value.effects[activeEffect.value]!, id, params: {}, customChars: '' }
  pickerOpen.value = false
  renderFrame(0)
}
const currentThumb = computed(() => (effectDef.value ? thumbs.value[effectDef.value.id] ?? '' : ''))

// ── duotone / adjust presets ────────────────────────────────────────────────
function applyDuotonePalette({ shadow, highlight }: { shadow: string; highlight: string }) {
  config.value.duotone.ink = shadow; config.value.duotone.paper = highlight; config.value.duotone.enabled = true
  onEdit('duotone.ink', shadow); onEdit('duotone.paper', highlight)
}

function applyGradientStops(stops: { pos: number; color: string }[]) {
  config.value.gradientMap.stops = stops.map(s => ({ pos: s.pos, color: s.color }))
  config.value.gradientMap.enabled = true
}
function applyEffectGradient(uniform: string, v: GradientStop[], maxStops = 8) {
  setParam(uniform, v.slice(0, maxStops).map(s => ({ pos: s.pos, color: s.color })))
}
function rampCss(stops: { pos: number; color: string }[]): string {
  const s = [...stops].sort((a, b) => a.pos - b.pos)
  if (!s.length) return 'transparent'
  return `linear-gradient(to right, ${s.map(x => `${x.color} ${Math.round(x.pos * 100)}%`).join(', ')})`
}
const gradientMapRampCss = computed(() => rampCss(config.value.gradientMap.stops))
function pickAdjustPreset(name: string) { const p = ADJUST_PRESETS.find(x => x.name === name); if (p) { applyAdjustPreset(config.value.adjust, p); config.value.adjust.enabled = true } }

// ── effect looks: one-click param bundles for effects that declare them ──────
const CUSTOM_LOOK = 'Custom'
const effectLooks = computed(() => (effectDef.value ? EFFECT_LOOKS[effectDef.value.id] ?? [] : []))
// The row shows the look the current params match, or Custom once any slider moved.
// A colour entry matches by hex (case-blind); a number by value; a gradient entry
// (a Look that IS a palette, like Culture's ink roles) by its whole stop list, in
// order, since the order is what gives each ink its role.
function lookParamMatches(k: string, v: ParamValue): boolean {
  if (Array.isArray(v)) {
    const cur = effectValues.value[k]
    if (!Array.isArray(cur) || cur.length !== v.length) return false
    return v.every((s, i) => Math.abs((cur[i] as GradientStop).pos - s.pos) < 1e-6
      && String((cur[i] as GradientStop).color).toLowerCase() === String(s.color).toLowerCase())
  }
  if (typeof v === 'string') return String(effectValues.value[k] ?? '').toLowerCase() === v.toLowerCase()
  return Math.abs(numValue(k) - v) < 1e-6
}
const currentLook = computed(() =>
  effectLooks.value.find(l => Object.entries(l.params).every(([k, v]) => lookParamMatches(k, v)))?.name ?? CUSTOM_LOOK)
function pickEffectLook(name: string) {
  const look = effectLooks.value.find(l => l.name === name)
  if (!look) return
  for (const [k, v] of Object.entries(look.params)) setParam(k, v)
}

// ── focus-point drag pad ────────────────────────────────────────────────────
let draggingFocus = false
function onFocusDown(ev: PointerEvent) { draggingFocus = true; (ev.target as HTMLElement).setPointerCapture(ev.pointerId); onFocusMove(ev) }
function onFocusMove(ev: PointerEvent) {
  if (!draggingFocus || !canvas.value) return
  const r = canvas.value.getBoundingClientRect()
  config.value.post.blur.focusX = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1)
  config.value.post.blur.focusY = Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1)
}
function onFocusUp() { draggingFocus = false }

// ── mask on-canvas handles ───────────────────────────────────────────────────
// The overlay is positioned to cover the letterboxed <canvas> exactly (via its
// offset box within the shared `relative` container), so handle positions and
// the region outline line up with what the shader draws. Drag mapping matches
// the focus-point handler above (normalize against the canvas' client rect).
const maskBox = ref({ left: 0, top: 0, w: 0, h: 0 })
function measureMaskBox() {
  const el = canvas.value
  if (!el) return
  maskBox.value = { left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
}
const showMaskHandles = computed(() => maskOn.value && !!resolved.value && maskBox.value.w > 0)
/** Image aspect (w/h) — the shader aspect-corrects x by this, so the outline must too. */
const maskAr = computed(() => { const s = resolved.value; return s && s.height ? s.width / s.height : 1 })
const maskCenterPx = computed(() => ({ x: maskCfg.value.cx * maskBox.value.w, y: maskCfg.value.cy * maskBox.value.h }))
// Region half-extents in canvas px. A `size`-radius circle in the shader's
// aspect-corrected space is `size * imageHeight` px in each axis (x also × aspect).
const maskRadPx = computed(() => ({ x: maskCfg.value.size * maskBox.value.h * maskCfg.value.aspect, y: maskCfg.value.size * maskBox.value.h }))
/** Size handle sits on the region's local +Y edge (the rotate group orients it). */
const maskSizeHandlePx = computed(() => ({ x: maskCenterPx.value.x, y: maskCenterPx.value.y + maskRadPx.value.y }))

function maskNormFromEvent(ev: PointerEvent): { x: number; y: number } {
  const r = canvas.value!.getBoundingClientRect()
  const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)
  return { x: clamp01((ev.clientX - r.left) / r.width), y: clamp01((ev.clientY - r.top) / r.height) }
}
let maskDrag: null | 'center' | 'size' = null
function onMaskDown(kind: 'center' | 'size', ev: PointerEvent) {
  ev.stopPropagation()
  maskDrag = kind;(ev.target as HTMLElement).setPointerCapture(ev.pointerId); onMaskMove(ev)
}
function onMaskMove(ev: PointerEvent) {
  if (!maskDrag || !canvas.value) return
  const n = maskNormFromEvent(ev)
  if (maskDrag === 'center') { setMask('cx', n.x); setMask('cy', n.y) }
  else {
    // size = distance from centre in the shader's aspect-corrected metric, so the
    // handle tracks the true region edge for any aspect ratio.
    const dx = (n.x - maskCfg.value.cx) * maskAr.value
    const dy = (n.y - maskCfg.value.cy)
    setMask('size', Math.min(Math.max(Math.hypot(dx, dy), 0.02), 1))
  }
}
function onMaskUp() { maskDrag = null }

// ── motion tracks ────────────────────────────────────────────────────────────
const animatablePaths = computed(() => [
  // Fixed-section paths are gated by their section's enable flag — a disabled
  // section's uniform is never uploaded, so animating it would be a dead track.
  ...ANIMATABLE.filter((a) => {
    if (a.path.startsWith('adjust.')) return config.value.adjust.enabled
    if (a.path.startsWith('post.blur.')) return config.value.post.blur.enabled
    if (a.path.startsWith('post.chromatic.')) return config.value.post.chromatic.enabled
    if (a.path.startsWith('post.bloom.')) return config.value.post.bloom.enabled
    return true
  }),
  ...(effectDef.value?.params ?? [])
    .filter(p => p.type !== 'enum')
    .map(p => ({ path: `effects.${activeEffect.value}.params.${p.uniform}`, label: `Effect · ${p.label}`, min: p.min ?? 0, max: p.max ?? 1 })),
  // Mask region params — animate the region itself (e.g. sweep the effect across).
  ...(maskOn.value ? ([
    { path: `effects.${activeEffect.value}.mask.cx`, label: 'Mask · Center X', min: 0, max: 1 },
    { path: `effects.${activeEffect.value}.mask.cy`, label: 'Mask · Center Y', min: 0, max: 1 },
    { path: `effects.${activeEffect.value}.mask.size`, label: 'Mask · Size', min: 0.02, max: 1 },
    { path: `effects.${activeEffect.value}.mask.feather`, label: 'Mask · Feather', min: 0, max: 1 },
    { path: `effects.${activeEffect.value}.mask.angle`, label: 'Mask · Angle', min: -3.14159, max: 3.14159 },
  ]) : []),
])
function addTrack() {
  const a = animatablePaths.value[0]!
  config.value.motion.tracks.push({ path: a.path, from: a.min, to: a.max, easing: 'pingpong', loops: 1, delay: 0, hold: 0, cycleOffset: 0 } as MotionTrack)
}
function removeTrack(i: number) { config.value.motion.tracks.splice(i, 1) }

// ── persistence ────────────────────────────────────────────────────────────────
function loadConfig() {
  const c = currentNode()?.data?.properties?.sailor_shaderStudio
  if (!c || typeof c !== 'object') return
  const hydrated = hydrateConfig(migrateShaderConfig(c))
  // Rewrite any legacy effect id to its current one, so the next saveConfig() persists the
  // new id and the alias in catalogStore.ts's LEGACY_EFFECT_IDS can eventually be retired.
  for (const e of hydrated.effects) e.id = resolveEffectId(e.id)
  config.value = hydrated
}
function saveConfig() { const n = currentNode(); if (!n) return; n.data ||= {}; n.data.properties ||= {}; n.data.properties.sailor_shaderStudio = cloneConfig(config.value) }
function closeEditor() { try { saveConfig() } catch (e) { console.error('[shader-studio] saveConfig failed', e) } emit('close') }

// Sticky footer status (StudioActionsFooter): real Saving…/Saved ✓ driven by
// useStudioAutosave, debounced off `config` — the studio's single source of
// truth, which saveConfig() clones straight onto the node (never written back
// into `config`, so there's no watch loop). Mirrors Gradient Studio (Task 6).
const { saving: autoSaving, saved: autoSaved } = useStudioAutosave(() => config.value, saveConfig)

// ── outputs (mirror Gradient Studio) ───────────────────────────────────────────
async function renderBlob(t01: number): Promise<Blob> {
  const src = resolved.value
  const { w, h } = src
    ? outputDims(src.width, src.height, config.value.resolution, { upscale: true })
    : { w: GENERATIVE_DIM, h: GENERATIVE_DIM }
  const dur = clockDuration()
  const t = t01 * dur
  const cfg = animated.value ? applyMotion(motionConfigFor(config.value, dur), t) : config.value
  const base = src ? await src.getFrame(t01, w, h) : GENERATIVE_BASE
  shaderFx.render(composePasses(cfg, defForId, t, (def, layer) => texBundle(def, layer)), base, w, h)
  const c = shaderFx.outputCanvas!
  return await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png', 0.95))
}

// Studio param-baker (Slice 2a Task 8c) — bakes ONE frame with a set of
// `params.*` overrides applied (a collection sweep/generate row), without
// disturbing the studio's live on-screen config: snapshot the current value
// of every overridden key via the same dotted-path proxy onEdit/promote use
// (`agentParams` — single-arg `makeConfigParams`, no layer scoping unlike
// Gradient, so no pinning is needed here), write the overrides through that
// same proxy (mutating the reactive `config` — identical to a user edit),
// render one full-res frame via the shared `renderBlob` capture path, then
// restore the snapshots in `finally` regardless of success/failure.
// `renderBlob` calls `shaderFx.render(...)` directly with `cfg` as an
// argument (not read off a watcher) and only awaits the `toBlob` callback —
// same as Gradient's `renderToBlob`, so no `nextTick`/rAF wait is needed
// between the override-write and the capture call.
async function renderBlobWithOverrides(overrides: Record<string, string | number>): Promise<Blob | null> {
  // Guard the shared shaderFx canvas the same way generateImage/generateVideo
  // do: a straggling async preview renderFrame bails right after its await if
  // baking.value is set, so it can't corrupt the bake this function performs
  // for a collection sweep. Set before the (synchronous) snapshot loop so no
  // window exists where a resumed preview frame could slip in.
  baking.value = true
  const keys = Object.keys(overrides)
  const snapshot = new Map<string, string | number | undefined>()
  for (const key of keys) snapshot.set(key, agentParams[key] as string | number | undefined)
  try {
    for (const key of keys) agentParams[key] = overrides[key]!
    return await renderBlob(0)
  } catch (e) {
    console.error('[shader-studio] param-baker render failed', e)
    return null
  } finally {
    for (const key of keys) {
      const prev = snapshot.get(key)
      if (prev !== undefined) agentParams[key] = prev
    }
    baking.value = false
  }
}

async function generateImage() {
  if (!resolved.value && !isGenerative.value) { bakeMsg.value = 'Add a source first'; return }
  baking.value = true; bakeMsg.value = 'Rendering…'; stopPreview()
  try {
    const blob = await renderBlob(0)
    const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
    const [filename] = await uploadFrameBatch([blob], 'shader_img')
    if (filename) {
      saveConfig()
      await recordAsset(activeTab.value?.projectUuid, 'image', filename)
      window.dispatchEvent(new CustomEvent('sailor:shaderStudioOutput', { detail: { sourceNodeId: props.nodeId, nodeType: 'Image', widgetOverrides: { image: filename } } }))
      // Clear the in-flight message on success so the footer's `notice` (no longer
      // gated behind `baking` now that StudioActionsFooter reads it unconditionally)
      // doesn't keep showing "Rendering…" after the fact. closeEditor() unmounts this
      // surface in normal use, but clear it anyway rather than depend on that timing.
      bakeMsg.value = ''
      closeEditor()
    } else {
      // uploadFrameBatch swallows a failed upload and returns [] — surface it instead
      // of leaving the footer stuck on "Rendering…" forever.
      bakeMsg.value = 'Upload failed — see console.'
    }
  } catch (e) { console.error('[shader-studio] image failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

/** Bake the current Shader Studio state to frames (at the upstream source's own
 *  clock, or our own Motion duration/fps when the source is still) and encode
 *  server-side to a video file under input/. Shared by generateVideo() (dispatches
 *  a Video node onto the canvas) and downloadVideoFile() (saves the file locally)
 *  so this frame-bake exists in exactly one place. Callers own baking.value/
 *  stopPreview/startPreview and the "Add a source first" guard. A bake-stage
 *  failure (ensureSpaceTypeBake) propagates to the caller; an encode-stage failure
 *  is caught here (mirrors the original generateVideo's nested try/catch) and
 *  reported via bakeMsg, returning null so callers treat it as "nothing to
 *  dispatch/download" without their own catch firing a second, more generic
 *  message. Mirrors Gradient Studio's bakeGradientVideo (Task 6). */
async function bakeShaderVideo(): Promise<{ filename: string; ext: 'mp4' | 'webm' } | null> {
  const src = resolved.value
  // Whoever supplies the frames owns the clock: an animated upstream (e.g. a
  // Gradient Studio loop) overrides our own duration/fps; a still source
  // leaves our own Motion controls in charge. A generative effect with no
  // source (null src) hits the same "still" branch — exportClock already
  // treats a null resolved source as "no upstream clock" and falls back to
  // ownDuration/ownFps, so it self-animates via u_time over our own Motion
  // clock (renderBlob(i/total) below already varies t per frame). See
  // resolve.ts's exportClock.
  const clock = exportClock(src, config.value.motion.duration, config.value.motion.fps)
  const { w, h } = src
    ? outputDims(src.width, src.height, config.value.resolution, { upscale: true })
    : { w: GENERATIVE_DIM, h: GENERATIVE_DIM }
  const total = Math.max(1, Math.round(clock.fps * clock.duration))
  const bakeCfg = { fps: clock.fps, loopDuration: clock.duration, W: w, H: h, seed: 'shader', sig: JSON.stringify(config.value) }
  const bake = await ensureSpaceTypeBake(bakeCfg as any, undefined, {
    // Normalized (i / total), not i / fps: renderBlob now takes 0..1 so the
    // last frame lands just before the loop point instead of duplicating
    // frame 0 — this is what keeps a seamless upstream loop closing on itself.
    renderFrame: async (i) => { bakeMsg.value = `Baking ${i + 1}/${total}`; return await renderBlob(i / total) },
  })
  bakeMsg.value = 'Encoding…'
  try {
    return await encodeFrames({ frames: bake.frames, fps: clock.fps, width: w, height: h })
  } catch (encErr) {
    bakeMsg.value = 'Encode failed — restart ComfyUI to load the encoder.'
    console.error('[shader-studio] encode failed', encErr)
    return null
  }
}

async function generateVideo() {
  if (!resolved.value && !isGenerative.value) { bakeMsg.value = 'Add a source first'; return }
  baking.value = true; stopPreview()
  try {
    const encoded = await bakeShaderVideo()
    if (!encoded) return
    await recordAsset(activeTab.value?.projectUuid, 'video', encoded.filename)
    window.dispatchEvent(new CustomEvent('sailor:shaderStudioOutput', { detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: encoded.filename } } }))
    bakeMsg.value = ''
    closeEditor()
  } catch (e) { console.error('[shader-studio] video failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

/** Download the current full-res still as a PNG — same render call generateImage()
 *  uses (renderBlob), just saved locally instead of uploaded/dispatched. Guards +
 *  sets baking.value like every other renderBlob caller: renderFrame's preview
 *  loop bails on baking.value mid-await specifically so it can't corrupt the
 *  shared shaderFx canvas this capture reads from (see renderFrame's comment). */
async function downloadPng() {
  if (!resolved.value && !isGenerative.value) { bakeMsg.value = 'Add a source first'; return }
  baking.value = true; bakeMsg.value = 'Rendering…'; stopPreview()
  try {
    const blob = await renderBlob(0)
    downloadBlobAsFile(blob, `shader_${Date.now()}.png`)
    bakeMsg.value = ''
  } catch (e) { console.error('[shader-studio] png download failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

/** Same bake as generateVideo(), but saves the encoded file locally instead of
 *  dispatching a Video node onto the canvas. Unlike generateVideo/generateImage,
 *  this never calls closeEditor() — the modal stays open — so bakeMsg MUST be
 *  cleared on success here, or the footer's notice would show a stale
 *  "Encoding…" forever instead of returning to idle. */
async function downloadVideoFile() {
  if (!resolved.value && !isGenerative.value) { bakeMsg.value = 'Add a source first'; return }
  baking.value = true; stopPreview()
  try {
    const encoded = await bakeShaderVideo()
    if (!encoded) return
    // NOT `/input/${filename}` — that path isn't in the Nuxt dev server's
    // comfyui-proxy PROXY_PREFIXES (server/middleware/comfyui-proxy.ts only
    // proxies /view, /upload, etc.) and 404s; verified live in Gradient Studio
    // (Task 6). ComfyUI's own /view endpoint (proxied) serves the same input/
    // file by filename+type.
    const res = await fetch(`/view?${new URLSearchParams({ filename: encoded.filename, type: 'input' })}`)
    if (!res.ok) throw new Error(`/view returned ${res.status}`)
    downloadBlobAsFile(await res.blob(), `shader_${Date.now()}.${encoded.ext}`)
    bakeMsg.value = ''
  } catch (e) { console.error('[shader-studio] video download failed', e); bakeMsg.value = 'Failed — see console.' }
  finally { baking.value = false; startPreview() }
}

async function exportWebEmbed() {
  if (embedding.value) return
  if (!resolved.value && !isGenerative.value) { embedErr.value = true; embedMsg.value = 'Add a source first'; return }
  embedding.value = true
  embedErr.value = false
  embedMsg.value = 'Building…'
  try {
    const src = resolved.value
    // An animated upstream (Gradient/Space Type wired in) would export as a
    // single frozen base frame looping for a duration chosen because the source
    // moves. Refuse before any expensive work happens. See resolve.ts. A
    // generative effect has no upstream to refuse — nothing to check, and
    // assertEmbeddableSource only throws when a live/animated source is wired
    // in, which is impossible with a null src.
    if (src) assertEmbeddableSource(src)
    const clock = exportClock(src, config.value.motion.duration, config.value.motion.fps)
    const { w, h } = src
      ? outputDims(src.width, src.height, config.value.resolution, { upscale: true })
      : { w: GENERATIVE_DIM, h: GENERATIVE_DIM }

    // Inline the source image — the exported file must not fetch it. `src` is
    // the ResolvedSource wrapper (getFrame/width/height/...), not itself
    // drawable, so pull an actual frame the same way renderFrame/renderBlob do
    // (resolve.ts:201/396) before handing it to the 2D canvas. Drawing through
    // a 2D canvas gives a data: URI regardless of whether the frame arrived as
    // an <img>, a canvas, or a bitmap. No source → the same neutral
    // GENERATIVE_BASE canvas the preview/renderBlob paths use.
    const frame = src ? await src.getFrame(0, w, h) : GENERATIVE_BASE
    const flat = document.createElement('canvas')
    flat.width = w
    flat.height = h
    flat.getContext('2d')!.drawImage(frame as CanvasImageSource, 0, 0, w, h)

    // Only the defs actually referenced by enabled layers travel with the export.
    const ids = new Set(config.value.effects.filter(e => e.enabled && e.id).map(e => e.id))
    const defs = (catalog.value?.effects ?? []).filter(d => ids.has(d.id))

    // `source` is stripped, not cloned: it carries the FULL original upload as
    // base64 (a 4MB JPEG becomes ~5.3MB of JSON), and the adapter never reads
    // cfg.source — the pixels travel as `baseDataUrl`, already re-encoded at
    // export resolution. Everything else stays: composePasses reads effects,
    // duotone, gradientMap, adjust and post, and applyMotion reads motion.
    const cfg = structuredClone(toRaw(config.value))
    cfg.source = { kind: 'none' }

    const embedConfig: ShaderEmbedConfig = {
      cfg,
      defs,
      duration: clock.duration,
      baseDataUrl: flat.toDataURL('image/png'),
    }

    const html = await exportEmbedHtml({
      kind: 'shader',
      config: embedConfig,
      duration: clock.duration,
      width: w,
      height: h,
    })

    // Size is shown BEFORE the download, not discovered later when a page takes
    // eight seconds to load. Still one action — no confirmation dialog.
    const mb = (new Blob([html]).size / 1_048_576).toFixed(1)
    embedMsg.value = `${mb} MB — downloading…`
    await nextTick()
    downloadEmbed('sailor-shader-embed.html', html)
    embedMsg.value = `Downloaded — ${mb} MB`
  } catch (err) {
    console.error('[ShaderStudio] embed export failed:', err)
    embedErr.value = true
    embedMsg.value = err instanceof Error ? err.message : 'Export failed'
  } finally {
    embedding.value = false
  }
}

const RESOLUTIONS = [1024, 1536, 2048, 4096]

// Live readout of the baked output size (the preview is a fixed-size proxy, so
// this is the only place the resolution choice is visible before exporting).
const outputSizeLabel = computed(() => {
  const src = resolved.value
  if (!src) return null
  const { w, h } = outputDims(src.width, src.height, config.value.resolution, { upscale: true })
  return `${w} × ${h}`
})

// Derived export clock, shown beside the Motion duration/fps controls when a
// live upstream studio is driving the loop (those controls are disabled then —
// see the Motion section below and exportClock in resolve.ts).
const clockLabel = computed(() => {
  const src = resolved.value
  if (!src || src.duration <= 0) return null
  const frames = Math.max(1, Math.round(src.fps * src.duration))
  return `${src.duration.toFixed(1)}s · ${frames} frames — from upstream`
})

let maskRO: ResizeObserver | null = null
onMounted(async () => {
  loadConfig(); catalog.value = await fetchShaderFxCatalog().catch(() => null); startPreview()
  registerStudioParamBaker(props.nodeId, renderBlobWithOverrides)
  // Keep the mask overlay aligned with the letterboxed canvas as the modal resizes
  // (the canvas is max-w/h-full, so a container resize moves its box without a re-render).
  await nextTick()
  if (canvas.value) { maskRO = new ResizeObserver(() => measureMaskBox()); maskRO.observe(canvas.value); measureMaskBox() }
})
onBeforeUnmount(() => { saveConfig(); stopPreview(); unregisterStudioParamBaker(props.nodeId); maskRO?.disconnect() })

function setParam(uniform: string, value: ParamValue) { const e = activeEffectCfg.value; if (e) e.params = { ...e.params, [uniform]: value } }

// ── per-effect mask (spatial region confining the active effect) ─────────────
const MASK_SHAPE_LABELS: Record<MaskShape, string> = { radius: 'Radius', band: 'Band', linear: 'Linear' }
const MASK_LABEL_SHAPE: Record<string, MaskShape> = { Radius: 'radius', Band: 'band', Linear: 'linear' }
/** Lazily attach a default mask to the active effect the first time it's touched. */
function ensureMask(): EffectMask {
  const e = activeEffectCfg.value
  if (!e.mask) e.mask = defaultMask()
  return e.mask
}
function setMask<K extends keyof EffectMask>(k: K, v: EffectMask[K]) { ensureMask()[k] = v }
const maskOn = computed({
  get: () => !!activeEffectCfg.value?.mask?.enabled,
  set: (v: boolean) => { ensureMask().enabled = v },
})
const maskCfg = computed<EffectMask>(() => activeEffectCfg.value?.mask ?? defaultMask())
/** Angle stored in radians; edited in degrees for legibility. */
const maskAngleDeg = computed({
  get: () => Math.round((activeEffectCfg.value?.mask?.angle ?? 0) * 180 / Math.PI),
  set: (d: number) => setMask('angle', d * Math.PI / 180),
})

/** Narrowing helpers for the template — `effectValues` is a ParamValue union. */
function numValue(uniform: string): number { const v = effectValues.value[uniform]; return typeof v === 'number' ? v : 0 }
function stopsValue(uniform: string): GradientStop[] { const v = effectValues.value[uniform]; return Array.isArray(v) ? v : [] }

// ── effect stack (aside StudioLayerStack) ───────────────────────────────────
function addEffect() {
  if (config.value.effects.length >= LAYER_MAX) return
  config.value.effects.push({ layerId: newLayerId(), id: '', params: {}, enabled: true, blend: 'normal', opacity: 1 })
  activeEffect.value = config.value.effects.length - 1
}
function removeEffect(i: number) {
  if (config.value.effects.length <= 1) return
  config.value.effects.splice(i, 1)
  remapEffectTracks('remove', i)
  activeEffect.value = Math.min(activeEffect.value, config.value.effects.length - 1)
}
function duplicateEffect(i: number) {
  if (config.value.effects.length >= LAYER_MAX) return
  const clone = { ...structuredClone(toRaw(config.value.effects[i]!)), layerId: newLayerId() }
  config.value.effects.splice(i + 1, 0, clone)
  remapEffectTracks('insert', i + 1)
  activeEffect.value = i + 1
}
function reorderEffect(from: number, to: number) {
  const [m] = config.value.effects.splice(from, 1)
  config.value.effects.splice(to, 0, m!)
  remapEffectTracks('move', from, to)
  activeEffect.value = to
}
function toggleEffect(i: number) { const e = config.value.effects[i]!; e.enabled = !e.enabled }

// Rewrites motion track `path`s of the form `effects.<idx>.params.<uniform>` to
// follow an effect through add/remove/reorder. These three used to be inline
// copies of gradientfx/motion.ts's; both now share ~/lib/studio/listRemap.
// `requireLeaf` reproduces the original matcher exactly — it was
// `/^effects\.(\d+)\.params\.(.+)$/`, i.e. a non-empty single-line uniform name,
// not a bare prefix (pinned in tests/unit/studio-list-remap.unit.spec.ts).
const EFFECT_REMAP = makeListRemap({ list: 'effects', mid: 'params', requireLeaf: true })
function remapEffectTracks(kind: 'move' | 'insert' | 'remove', a: number, b?: number): void {
  const tracks = config.value.motion.tracks
  config.value.motion.tracks = kind === 'remove'
    ? EFFECT_REMAP.onRemove(tracks, a)
    : kind === 'insert'
      ? EFFECT_REMAP.onInsert(tracks, a)
      : EFFECT_REMAP.onReorder(tracks, a, b!)
}
</script>

<template>
  <StudioModalShell
    title="Shader studio" :breadcrumb="effectDef?.name"
    :agent="shaderAgent"
    agent-placeholder="Describe the look — e.g. punchier, warmer, more glow…"
    @close="closeEditor"
  >
    <template #aside>
      <StudioLayerStack
        :layers="config.effects.map((e, i) => ({ label: effectLabel(e), enabled: e.enabled }))"
        :active-index="activeEffect" :max="LAYER_MAX"
        @select="activeEffect = $event"
        @add="addEffect" @remove="removeEffect" @duplicate="duplicateEffect"
        @reorder="reorderEffect" @toggle="toggleEffect" />
    </template>

    <template #preview>
      <div class="relative flex h-full w-full items-center justify-center">
        <canvas ref="canvas" class="max-h-full max-w-full rounded-lg shadow-2xl" />
        <!-- Focus point overlay when lens blur is on -->
        <div v-if="config.post.blur.enabled"
          class="nopan nodrag absolute size-3 -ml-1.5 -mt-1.5 cursor-move rounded-full border-2 border-white bg-black/30"
          :style="{ left: `${config.post.blur.focusX * 100}%`, top: `${config.post.blur.focusY * 100}%` }"
          @pointerdown="onFocusDown" @pointermove="onFocusMove" @pointerup="onFocusUp" />
        <!-- Mask region overlay: outline + draggable centre/size handles, sized to
             cover the letterboxed canvas exactly. Root is pointer-events-none so it
             never blocks the canvas; only the handles opt back in. -->
        <svg v-if="showMaskHandles" class="nopan nodrag pointer-events-none absolute overflow-visible"
          :style="{ left: `${maskBox.left}px`, top: `${maskBox.top}px`, width: `${maskBox.w}px`, height: `${maskBox.h}px` }"
          :viewBox="`0 0 ${maskBox.w} ${maskBox.h}`"
          @pointermove="onMaskMove" @pointerup="onMaskUp">
          <g :transform="`rotate(${maskAngleDeg} ${maskCenterPx.x} ${maskCenterPx.y})`">
            <g fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="1.5" stroke-dasharray="5 4">
              <ellipse v-if="maskCfg.shape === 'radius'" :cx="maskCenterPx.x" :cy="maskCenterPx.y" :rx="maskRadPx.x" :ry="maskRadPx.y" />
              <template v-else>
                <line :x1="-maskBox.w" :x2="2 * maskBox.w" :y1="maskCenterPx.y - maskRadPx.y" :y2="maskCenterPx.y - maskRadPx.y" />
                <line v-if="maskCfg.shape === 'band'" :x1="-maskBox.w" :x2="2 * maskBox.w" :y1="maskCenterPx.y + maskRadPx.y" :y2="maskCenterPx.y + maskRadPx.y" />
              </template>
            </g>
            <circle class="cursor-ns-resize" style="pointer-events:auto"
              :cx="maskSizeHandlePx.x" :cy="maskSizeHandlePx.y" r="6"
              fill="#fff" stroke="rgba(0,0,0,0.4)" stroke-width="1.5" @pointerdown="onMaskDown('size', $event)" />
          </g>
          <circle class="cursor-move" style="pointer-events:auto" :cx="maskCenterPx.x" :cy="maskCenterPx.y" r="7"
            fill="rgba(0,0,0,0.35)" stroke="#fff" stroke-width="2" @pointerdown="onMaskDown('center', $event)" />
        </svg>
        <span v-if="!resolved && !isGenerative" class="absolute text-xs text-white/40">Add a source image to begin</span>
      </div>
    </template>

    <template #actions>
      <StudioActionsFooter :spec="{
        status: {
          saving: autoSaving, saved: autoSaved,
          error: glError || (embedErr ? embedMsg : null),
          notice: (!embedErr && embedMsg) ? embedMsg : (bakeMsg || null),
        },
        downloads: [
          { label: 'Download PNG', onClick: downloadPng, disabled: !resolved && !isGenerative },
          { label: 'Download video', onClick: downloadVideoFile, busy: baking, disabled: !resolved && !isGenerative },
          { label: 'Export embed', onClick: exportWebEmbed, busy: embedding },
        ],
        canvas: [
          { label: 'As image', onClick: generateImage, busy: baking, disabled: !resolved && !isGenerative },
          { label: 'As video', onClick: generateVideo, busy: baking, disabled: !resolved && !isGenerative },
        ],
      }" />
    </template>

    <template #controls>
      <!-- Source -->
      <StudioSection title="Source">
        <p v-if="wiredUrl" class="mb-2 text-[11px] text-white/50">Using wired input</p>
        <label class="mb-1 block cursor-pointer rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-center text-[11px] text-white/80 hover:bg-white/20">
          Upload image<input type="file" accept="image/*" class="hidden" @change="onUpload" />
        </label>
        <div class="mt-2 flex items-center gap-2">
          <StudioButton variant="secondary" @click="rerollSeed">New variation</StudioButton>
          <div class="min-w-0 flex-1">
            <StudioSlider v-model="config.seed" label="Variation" :min="1" :max="9999" :step="1" :default="42" :bindable="false" />
          </div>
        </div>
      </StudioSection>

      <!-- Stylized Effects -->
      <StudioSection title="Stylized Effects">
        <template #badge><StudioSwitch v-model="activeEffectCfg.enabled" /></template>
        <button class="mb-2 flex w-full items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left hover:bg-white/[0.08]" @click="openPicker">
          <span class="size-5 overflow-hidden rounded bg-white/[0.06]"><img v-if="currentThumb" :src="currentThumb" class="h-full w-full object-cover" /></span>
          <span class="min-w-0 flex-1 truncate text-[11px] text-white/90">{{ effectDef?.name ?? 'Pick an effect' }}</span>
          <ChevronRight class="size-3.5 shrink-0 text-white/30" />
        </button>
        <div v-if="effectLooks.length" class="mb-1.5">
          <StudioSelect
            label="Look"
            :options="[CUSTOM_LOOK, ...effectLooks.map(l => l.name)]"
            :model-value="currentLook"
            @update:model-value="pickEffectLook"
          />
        </div>
        <template v-for="p in effectDef?.params ?? []" :key="p.uniform">
          <div v-if="matchesShowWhen(p.showWhen, numValue)" class="mb-1.5">
            <!-- enum → select row (map the manifest's numeric value ⟷ its label) -->
            <StudioSelect
              v-if="p.type === 'enum'"
              :label="p.label"
              :options="(p.options ?? []).map(o => o.label)"
              :model-value="(p.options ?? []).find(o => o.value === numValue(p.uniform))?.label ?? ((p.options ?? [])[0]?.label ?? '')"
              @update:model-value="(lbl: string) => setParam(p.uniform, (p.options ?? []).find(o => o.label === lbl)?.value ?? 0)"
            />
            <!-- color → colour row (label left, swatch/hex right) -->
            <StudioColorField
              v-else-if="p.type === 'color'"
              :label="p.label"
              :model-value="String(effectValues[p.uniform] ?? '#000000')"
              @update:model-value="(v: string) => setParam(p.uniform, v)"
            />
            <!-- Same editor as the post-processing Gradient Map section below: a ramp
                 preview plus the shared PalettePicker. The stop list it emits IS what
                 gets stored, so there is one representation, not a UI copy. A multi-stop
                 editor isn't a single-value row, so it keeps its own labelled block. -->
            <div v-else-if="p.type === 'gradient'">
              <div class="mb-1 text-[11px] text-white/72">{{ p.label }}</div>
              <div class="mb-2 h-6 overflow-hidden rounded-[6px] border border-white/10" :style="{ background: rampCss(stopsValue(p.uniform)) }" />
              <PalettePicker
                mode="stops"
                :stop-count="stopsValue(p.uniform).length || 3"
                :seed="stopsValue(p.uniform)[0]?.color ?? '#4f8ad9'"
                @apply-stops="(v: GradientStop[]) => applyEffectGradient(p.uniform, v, p.maxStops ?? 8)"
                @apply-literal-stops="(v: GradientStop[]) => applyEffectGradient(p.uniform, v, p.maxStops ?? 8)"
              />
            </div>
            <!-- float → the 28px row-as-track slider (was a bare label + <input type=range>).
                 No manifest step ⇒ fine 0.01 default so a 0..1 float isn't quantised to its ends. -->
            <StudioSlider
              v-else
              :label="p.label" :min="p.min ?? 0" :max="p.max ?? 1" :step="p.step ?? 0.01" :default="typeof p.default === 'number' ? p.default : undefined" :bindable="false"
              :model-value="numValue(p.uniform)"
              @update:model-value="(v: number) => setParam(p.uniform, v)"
            />
            <div v-if="effectDef?.id === 'ascii_dither' && p.uniform === 'u_shape' && Math.round(numValue(p.uniform)) === 14" class="mt-1.5">
              <label class="mb-0.5 block text-[11px] text-white/40">Characters (sorted by density)</label>
              <input
                v-model="activeEffectCfg.customChars" type="text" spellcheck="false" placeholder=" .:-=+*#%@"
                class="w-full rounded-[6px] border border-white/[0.08] bg-white/[0.04] px-2 py-1 font-mono text-xs tracking-wider"
              />
            </div>
          </div>
        </template>
        <!-- Blend/opacity for the active non-base effect — effect 0 is the base
             layer (chains straight from the source), matching the gradient studio. -->
        <template v-if="activeEffect > 0">
          <label class="mb-0.5 block text-[11px] text-white/60">Blend</label>
          <select v-model="activeEffectCfg.blend" class="mb-2 w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs capitalize">
            <option v-for="b in BLEND_MODES" :key="b" :value="b">{{ b }}</option>
          </select>
          <StudioSlider v-model="activeEffectCfg.opacity" label="Opacity" :min="0" :max="1" :step="0.01" :bindable="false" />
        </template>

        <!-- Mask — confine this effect to a region (radius / band / linear falloff).
             Off by default; enabling it adds one masked-composite pass. -->
        <template v-if="effectDef">
          <div class="mb-1.5 mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5">
            <span class="text-[11px] font-medium text-white/70">Mask</span>
            <StudioSwitch v-model="maskOn" />
          </div>
          <div v-if="maskOn" class="space-y-1.5">
            <StudioSelect
              label="Shape"
              :options="['Radius', 'Band', 'Linear']"
              :model-value="MASK_SHAPE_LABELS[maskCfg.shape]"
              @update:model-value="(lbl: string) => setMask('shape', MASK_LABEL_SHAPE[lbl] ?? 'radius')"
            />
            <StudioSlider
              label="Center X" :min="0" :max="1" :step="0.01" :default="0.5" :bindable="false"
              :model-value="maskCfg.cx" @update:model-value="(v: number) => setMask('cx', v)"
            />
            <StudioSlider
              label="Center Y" :min="0" :max="1" :step="0.01" :default="0.5" :bindable="false"
              :model-value="maskCfg.cy" @update:model-value="(v: number) => setMask('cy', v)"
            />
            <StudioSlider
              label="Size" :min="0.02" :max="1" :step="0.01" :default="0.4" :bindable="false"
              :model-value="maskCfg.size" @update:model-value="(v: number) => setMask('size', v)"
            />
            <StudioSlider
              label="Feather" :min="0" :max="1" :step="0.01" :default="0.3" :bindable="false"
              :model-value="maskCfg.feather" @update:model-value="(v: number) => setMask('feather', v)"
            />
            <StudioSlider
              v-if="maskCfg.shape === 'radius'"
              label="Aspect" :min="0.25" :max="4" :step="0.01" :default="1" :bindable="false"
              :model-value="maskCfg.aspect" @update:model-value="(v: number) => setMask('aspect', v)"
            />
            <StudioSlider
              v-if="maskCfg.shape !== 'radius'"
              label="Angle" :min="-180" :max="180" :step="1" :default="0" :bindable="false"
              :model-value="maskAngleDeg" @update:model-value="(v: number) => (maskAngleDeg = v)"
            />
            <div class="flex items-center justify-between pt-0.5">
              <span class="text-[11px] text-white/60">Invert</span>
              <StudioSwitch :model-value="maskCfg.invert" @update:model-value="(v: boolean) => setMask('invert', v)" />
            </div>
          </div>
        </template>
      </StudioSection>

      <!-- Duotone -->
      <StudioSection title="Duotone" :open="false">
        <template #badge><StudioSwitch v-model="config.duotone.enabled" /></template>
        <template v-if="config.duotone.enabled">
          <div class="mb-2 flex items-center gap-2">
            <label class="text-[11px] text-white/60">Ink</label>
            <BindableRow control-key="duotone.ink" label="Ink" kind="color" :bound="boundColumnFor('duotone.ink')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
              <StudioColor v-model="config.duotone.ink" @update:model-value="(v: string) => onEdit('duotone.ink', v)" />
            </BindableRow>
            <label class="text-[11px] text-white/60">Paper</label>
            <BindableRow control-key="duotone.paper" label="Paper" kind="color" :bound="boundColumnFor('duotone.paper')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
              <StudioColor v-model="config.duotone.paper" @update:model-value="(v: string) => onEdit('duotone.paper', v)" />
            </BindableRow>
          </div>
          <PalettePicker mode="duotone" :seed="config.duotone.paper" @apply-duotone="applyDuotonePalette" />
        </template>
      </StudioSection>

      <!-- Gradient Map -->
      <StudioSection title="Gradient Map" :open="false">
        <template #badge><StudioSwitch v-model="config.gradientMap.enabled" /></template>
        <template v-if="config.gradientMap.enabled">
          <div class="mb-2 h-6 overflow-hidden rounded border border-white/10" :style="{ background: gradientMapRampCss }" />
          <PalettePicker mode="stops" :stop-count="config.gradientMap.stops.length" :seed="config.gradientMap.stops[0]?.color ?? '#4f8ad9'" @apply-stops="applyGradientStops" @apply-literal-stops="applyGradientStops" />
          <div class="mt-3">
            <StudioSlider
              :model-value="config.gradientMap.mix"
              @update:model-value="(v) => { config.gradientMap.mix = v; onEdit('gradientMap.mix', config.gradientMap.mix) }"
              label="Mix" :min="0" :max="1" :step="0.01" :bindable="false"
            />
          </div>
        </template>
      </StudioSection>

      <!-- Adjustments -->
      <StudioSection title="Adjustments" :open="false">
        <template #badge><StudioSwitch v-model="config.adjust.enabled" /></template>
        <template v-if="config.adjust.enabled">
          <select class="mb-2 w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs" @change="pickAdjustPreset(($event.target as HTMLSelectElement).value)">
            <option v-for="p in ADJUST_PRESETS" :key="p.name" :value="p.name">{{ p.name }}</option>
          </select>
          <template v-for="f in ([['exposure','Exposure',-2,2],['brightness','Brightness',-1,1],['contrast','Contrast',-1,1],['saturation','Saturation',-1,1],['hue','Hue',-180,180],['temperature','Temperature',-1,1],['tint','Tint',-1,1]] as const)" :key="f[0]">
            <BindableRow :control-key="`adjust.${f[0]}`" :label="f[1]" kind="slider" :min="f[2]" :max="f[3]" :step="0.01" :bound="boundColumnFor(`adjust.${f[0]}`)" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
              <StudioSlider :model-value="(config.adjust as any)[f[0]]" @update:model-value="(v) => { (config.adjust as any)[f[0]] = v; onEdit(`adjust.${f[0]}`, (config.adjust as any)[f[0]]) }" :label="f[1]" :min="f[2]" :max="f[3]" :step="0.01" :bindable="false" />
            </BindableRow>
          </template>
        </template>
      </StudioSection>

      <!-- Post-processing -->
      <StudioSection title="Post-processing" :open="false">
        <div class="mb-1 flex items-center justify-between"><span class="text-xs text-white/70">Lens Blur</span><StudioSwitch v-model="config.post.blur.enabled" /></div>
        <template v-if="config.post.blur.enabled">
          <BindableRow control-key="post.blur.range" label="Focus range" kind="slider" :min="0" :max="1" :step="0.01" :bound="boundColumnFor('post.blur.range')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.blur.range" @update:model-value="(v) => { config.post.blur.range = v; onEdit('post.blur.range', config.post.blur.range) }" label="Focus range" :min="0" :max="1" :step="0.01" :bindable="false" />
          </BindableRow>
          <BindableRow control-key="post.blur.aperture" label="Aperture" kind="slider" :min="0" :max="1" :step="0.01" :bound="boundColumnFor('post.blur.aperture')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.blur.aperture" @update:model-value="(v) => { config.post.blur.aperture = v; onEdit('post.blur.aperture', config.post.blur.aperture) }" label="Aperture" :min="0" :max="1" :step="0.01" :bindable="false" />
          </BindableRow>
          <BindableRow control-key="post.blur.maxBlur" label="Max blur" kind="slider" :min="0" :max="40" :step="1" :bound="boundColumnFor('post.blur.maxBlur')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.blur.maxBlur" @update:model-value="(v) => { config.post.blur.maxBlur = v; onEdit('post.blur.maxBlur', config.post.blur.maxBlur) }" label="Max blur" :min="0" :max="40" :step="1" :bindable="false" />
          </BindableRow>
        </template>
        <div class="mb-1 mt-2 flex items-center justify-between"><span class="text-xs text-white/70">Chromatic</span><StudioSwitch v-model="config.post.chromatic.enabled" /></div>
        <template v-if="config.post.chromatic.enabled">
          <BindableRow control-key="post.chromatic.amount" label="Chromatic amount" kind="slider" :min="0" :max="1" :step="0.01" :bound="boundColumnFor('post.chromatic.amount')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.chromatic.amount" @update:model-value="(v) => { config.post.chromatic.amount = v; onEdit('post.chromatic.amount', config.post.chromatic.amount) }" label="Amount" :min="0" :max="1" :step="0.01" :bindable="false" />
          </BindableRow>
        </template>

        <div class="mb-1 mt-2 flex items-center justify-between"><span class="text-xs text-white/70">Bloom</span><StudioSwitch v-model="config.post.bloom.enabled" /></div>
        <template v-if="config.post.bloom.enabled">
          <BindableRow control-key="post.bloom.threshold" label="Bloom threshold" kind="slider" :min="0" :max="1" :step="0.01" :bound="boundColumnFor('post.bloom.threshold')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.bloom.threshold" @update:model-value="(v) => { config.post.bloom.threshold = v; onEdit('post.bloom.threshold', config.post.bloom.threshold) }" label="Threshold" :min="0" :max="1" :step="0.01" :bindable="false" />
          </BindableRow>
          <BindableRow control-key="post.bloom.intensity" label="Bloom intensity" kind="slider" :min="0" :max="3" :step="0.01" :bound="boundColumnFor('post.bloom.intensity')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.bloom.intensity" @update:model-value="(v) => { config.post.bloom.intensity = v; onEdit('post.bloom.intensity', config.post.bloom.intensity) }" label="Intensity" :min="0" :max="3" :step="0.01" :bindable="false" />
          </BindableRow>
          <BindableRow control-key="post.bloom.radius" label="Bloom radius" kind="slider" :min="4" :max="200" :step="2" :bound="boundColumnFor('post.bloom.radius')" @menu="openVarMenu" @promote="(control) => promote(control, agentParams[control.key] as string | number)">
            <StudioSlider :model-value="config.post.bloom.radius" @update:model-value="(v) => { config.post.bloom.radius = v; onEdit('post.bloom.radius', config.post.bloom.radius) }" label="Radius" :min="4" :max="200" :step="2" :bindable="false" />
          </BindableRow>
        </template>
      </StudioSection>

      <!-- Output -->
      <StudioSection title="Output" :open="false">
        <label class="mb-1 block text-xs text-white/60">Resolution (long edge)</label>
        <select v-model.number="config.resolution" class="mb-1 w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs">
          <option v-for="r in RESOLUTIONS" :key="r" :value="r">{{ r }}px</option>
        </select>
        <p v-if="outputSizeLabel" class="text-[11px] text-white/40">Output: {{ outputSizeLabel }}px</p>
      </StudioSection>

      <StudioSection title="Motion" :open="false">
        <template #badge><button class="flex items-center gap-1 normal-case text-white/40 hover:text-white" @click.stop="addTrack"><Plus class="h-3 w-3" /> Track</button></template>
        <p v-if="clockLabel" class="mb-2 text-[11px] text-white/40">{{ clockLabel }}</p>
        <p v-if="!config.motion.tracks.length" class="text-[11px] text-white/30">Add a track to animate a parameter and export video.</p>
        <div v-for="(tk, i) in config.motion.tracks" :key="i" class="mb-2 rounded border border-white/10 p-2">
          <div class="mb-1 flex items-center gap-1">
            <select v-model="tk.path" class="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[11px]"><option v-for="a in animatablePaths" :key="a.path" :value="a.path">{{ a.label }}</option></select>
            <button class="text-white/30 hover:text-white/70" @click="removeTrack(i)"><Trash2 class="h-3 w-3" /></button>
          </div>
          <div class="flex items-center gap-1 text-[11px] text-white/50">
            <span>from</span><input v-model.number="tk.from" type="number" step="0.05" class="w-14 rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5" />
            <span>to</span><input v-model.number="tk.to" type="number" step="0.05" class="w-14 rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5" />
            <select v-model="tk.easing" class="rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5"><option value="linear">Linear</option><option value="pingpong">Ping-pong</option><option value="easeinout">Ease</option></select>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <div><label class="mb-1 flex justify-between text-[11px] text-white/60"><span>Duration</span><span class="text-white/40">{{ config.motion.duration }}s</span></label><input v-studio-reset v-model.number="config.motion.duration" type="range" min="1" max="12" step="0.5" class="studio-range w-full disabled:cursor-not-allowed disabled:opacity-40" :disabled="sourceAnimated" /></div>
          <div><label class="mb-1 block text-[11px] text-white/60">FPS</label><select v-model.number="config.motion.fps" class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40" :disabled="sourceAnimated"><option :value="24">24</option><option :value="30">30</option><option :value="60">60</option></select></div>
        </div>
      </StudioSection>
    </template>
  </StudioModalShell>

  <CatalogModal :open="pickerOpen" title="Shader Effects" subtitle="Pick an effect to apply"
    :items="pickerItems" :selected-id="activeEffectCfg.id" :filters="pickerFilters" :active-filter-id="pickerFilter" :search-query="pickerSearch"
    :sections="SHADER_SECTIONS" :section-of="(e: any) => e.category"
    search-placeholder="Search effects…" confirm-label="Use effect" empty-message="No effects match your search."
    @close="pickerOpen = false" @confirm="pickEffect(($event as EffectDef).id)" @update:active-filter-id="pickerFilter = $event" @update:search-query="pickerSearch = $event">
    <template #card="{ item }">
      <div class="aspect-video overflow-hidden bg-black/20"><img v-if="thumbs[(item as EffectDef).id]" :src="thumbs[(item as EffectDef).id]" class="h-full w-full object-cover" /></div>
      <div class="px-2 py-1.5"><div class="truncate text-[11px] text-white/85">{{ (item as EffectDef).name }}</div><div class="text-[10px] capitalize text-white/35">{{ (item as EffectDef).category }}</div></div>
    </template>
  </CatalogModal>
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
