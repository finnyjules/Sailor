<script setup lang="ts">
/**
 * Full-screen editor for the Vector Type node — real glyph OUTLINES from a
 * variable font, animated as geometry.
 *
 * Modelled on ShapeStudioSurface/GradientStudioSurface: StudioModalShell chrome,
 * a schema-driven StudioControlPanel inspector, useStudioAgent for the tune bar,
 * useStudioVarBindings + useStudioVarMenu for Collection bindings and sweeps, and
 * the same recordAsset -> `sailor:*StudioOutput` emit for the image output path.
 *
 * Two things here are NOT copied from those surfaces, and both are deliberate:
 *
 * 1. The preview loop uses `schedule()`, not a bare `requestAnimationFrame`.
 *    rAF is throttled to ZERO in a hidden tab — exactly the state a headless or
 *    offscreen capture runs in — so a pure rAF loop silently never advances
 *    there. `schedule()` falls back to a timer when `document.hidden`, and it is
 *    called BEFORE the early returns so one empty frame while the font loads
 *    cannot kill the loop forever. (The dev demo at /dev/vectortype established
 *    this pattern; it is the reference implementation.)
 *
 * 2. Every pixel goes through `drawVectorType` in `~/lib/vectortype/canvas`, the
 *    same function the node card, the cascade baker and the frame source call.
 *    Four render surfaces that each grew their own copy is a failure this repo
 *    has already paid for more than once.
 */
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue'
import { Combine } from 'lucide-vue-next'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { DEFAULT_FONT_ID, VARIABLE_FONTS } from '~/data/variable-fonts'
import { loadGoogleCatalog, nearestWeight, type GoogleFont } from '~/data/google-fonts'
import { libraryFamily, libraryToken, resolveLibraryFace } from '~/data/library-fonts'
import { formatVtFontToken, parseVtFontToken, vtFontRefLabel, type VtFontRef } from '~/lib/vectortype/fontToken'
import {
  VT_LAYER_KINDS,
  VT_LAYER_MAX,
  mergeConfig,
  vtBaseAppearance,
  vtLayer,
  type VectorTypeConfig,
  type VtLayerKind,
  type VtMove,
} from '~/lib/vectortype/config'
import { vtLayerLabels } from '~/lib/vectortype/layerLabel'
import { VT_CONTROLS, VT_LAYER_PREFIX, VT_SECTIONS, derivedVtControls, type VtControl } from '~/lib/vectortype/controls'
import { VT_GUIDANCE, vtAgentControls, vtBindableControls } from '~/lib/vectortype/agentControls'
import { VT_APPEARANCE_REMAP, pruneStackTracks } from '~/lib/vectortype/motion'
import {
  VT_PRESET_CAPABILITIES,
  vtStillTime,
} from '~/lib/vectortype/presetMotion'
import { vtAxisPreset } from '~/lib/vectortype/axisPresets'
import { loadVectorFont, type VtAxis, type VtFont } from '~/lib/vectortype/font'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'
import { formatValue } from '~/lib/studio/row'
import { controlKindToVariableType } from '~/lib/collection/studioBindables'
import PresetThumb from '~/components/vue-canvas/motion/PresetThumb.vue'
import VectorTypeThumb from '~/components/vue-canvas/motion/VectorTypeThumb.vue'
import MovesPanel from '~/components/vue-canvas/motion/moves/MovesPanel.vue'
import { vtMovesAdapter } from '~/lib/vectortype/movesAdapter'
import type { Move, MotionClip } from '~/lib/studio/moves/types'
import { drawVectorTypeToCanvas, vectorTypeSVG, vtExportName, vtIsAnimated, type VtBoxOptions, type VtFrame } from '~/lib/vectortype/canvas'
// NEVER FROM THE DRAW LOOP (plan trap 5). `prepareSolidExtrudes` runs paper.js
// boolean unions — orders of magnitude too slow for a frame — so every call site
// here is `await`ed off the loop: two one-shot full-resolution renders (the PNG
// bake and the SVG export, both of which already await other one-shot work) plus
// `runSolidUnion`, the debounced watcher that fills the body cache the preview
// PEEKS at. `render()` itself never calls this and never may.
import { prepareSolidExtrudes } from '~/lib/vectortype/extrudeSolid'
import { DEFAULT_FILL, DEFAULT_SHADER_SPEC, FILL_TYPES, fillIsShader, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { paintIsVector } from '~/lib/paint/toVector'
import { vtExportTier, vtRasterNote } from '~/lib/vectortype/exportTier'
import { isFill } from '~/lib/compositor/paint'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import { LIVE_FIELD_CEILING } from '~/lib/shaderfill/descriptor'
import { onFieldCatalogReady } from '~/lib/shaderfill/field'
import ShaderFillEditor from '~/components/vue-canvas/widgets/ShaderFillEditor.vue'
import StudioModalShell from '~/components/vue-canvas/StudioModalShell.vue'
import StudioActionsFooter from '~/components/vue-canvas/studio/StudioActionsFooter.vue'
import StudioLayerStack from '~/components/vue-canvas/StudioLayerStack.vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioControlPanel from '~/components/vue-canvas/studio/StudioControlPanel.vue'
import FontPicker from '~/components/vue-canvas/FontPicker.vue'
import CanvasContextMenu from '~/components/vue-canvas/CanvasContextMenu.vue'
import SweepPopover from '~/components/vue-canvas/studio/SweepPopover.vue'
import { useStudioAgent } from '~/composables/useStudioAgent'
import { useStudioVarBindings } from '~/composables/useStudioVarBindings'
import { useStudioVarMenu } from '~/composables/useStudioVarMenu'
import { makeConfigParams } from '~/lib/agent/configParams'
import { docAspect } from '~/lib/agent/takeThumbs'
import { mapControlSpecToDesc } from '~/lib/collection/studioControls'
import type { StudioControlDesc } from '~/lib/collection/studioBindables'
import { registerStudioParamBaker, unregisterStudioParamBaker } from '~/lib/studio/cascade'
import { useStudioAutosave } from '~/lib/studio/autosave'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'

const props = withDefaults(defineProps<{ nodeId: string; nodes?: any[]; edges?: any[] }>(), {
  nodes: () => [], edges: () => [],
})
const emit = defineEmits<{ (e: 'close'): void }>()

const { recordAsset } = useProjectGenerations()
const { activeTab } = useTabs()

function currentNode(): any | undefined {
  return props.nodes?.find((n: any) => String(n?.id) === String(props.nodeId))
}

// ── persisted blob ──────────────────────────────────────────────────────────
// A WRAPPER, like Shape Studio's: canvas size and background live OUTSIDE the
// config in every studio, and Task 5 deliberately declared no control for them.
const persisted = currentNode()?.data?.properties?.sailor_vectorType as
  { config?: unknown; canvasW?: number; canvasH?: number; aspectKey?: string; background?: string | null } | undefined

const ASPECTS: Record<string, number> = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '3:2': 3 / 2, '2:3': 2 / 3 }
const ASPECT_OPTIONS = Object.keys(ASPECTS)

const config = ref<VectorTypeConfig>(mergeConfig(persisted?.config))
const aspectKey = ref<string>(persisted?.aspectKey && ASPECTS[persisted.aspectKey] ? persisted.aspectKey : '16:9')
const canvasW = ref<number>(typeof persisted?.canvasW === 'number' ? persisted.canvasW : 1280)
const canvasH = ref<number>(
  typeof persisted?.canvasH === 'number' ? persisted.canvasH : Math.round(1280 / (ASPECTS[aspectKey.value] ?? 1)),
)
const background = ref<string | null>(
  persisted?.background === null ? null : (typeof persisted?.background === 'string' ? persisted.background : '#0b0d12'),
)
const lastBgColor = ref(background.value ?? '#0b0d12')
const bgTransparent = computed({
  get: () => background.value === null,
  set: (v: boolean) => {
    if (v) { if (background.value) lastBgColor.value = background.value; background.value = null }
    else background.value = lastBgColor.value
  },
})
watch(aspectKey, (k) => { canvasH.value = Math.max(16, Math.round(canvasW.value / (ASPECTS[k] ?? 1))) })

function saveConfig() {
  const n = currentNode(); if (!n) return
  n.data ||= {}; n.data.properties ||= {}
  n.data.properties.sailor_vectorType = {
    config: JSON.parse(JSON.stringify(config.value)),
    canvasW: canvasW.value, canvasH: canvasH.value, aspectKey: aspectKey.value,
    background: background.value,
  }
}
function closeEditor() {
  try { saveConfig() } catch (e) { console.error('[vector-type] saveConfig failed', e) }
  emit('close')
}

// Sticky footer status (StudioActionsFooter): real Saving…/Saved ✓ driven by
// useStudioAutosave, debounced off everything `saveConfig` persists — same
// recipe as ShapeStudioSurface/GradientStudioSurface. Vector Type is 2D (no
// camera/orbit to exclude), so every field here is a real user edit.
const { saving: autoSaving, saved: autoSaved } = useStudioAutosave(
  () => ({ config: config.value, canvasW: canvasW.value, canvasH: canvasH.value, aspectKey: aspectKey.value, background: background.value }),
  saveConfig,
)

// ── the font ────────────────────────────────────────────────────────────────
// The axis sliders are DERIVED from the loaded file's own `fvar`, so nothing
// below exists until this resolves. `loadVectorFont` caches the promise, so
// the card, the baker and this surface share one fetch per family.
// shallowRef + markRaw, NOT ref — see the note in VectorTypeNode.vue: Vue's deep
// reactive proxy over a fontkit font object throws on its non-configurable
// `parent` property as soon as a glyph outline is read.
const font = shallowRef<VtFont | null>(null)
const fontError = ref('')
const fontLoading = ref(false)
/** True while the canvas is drawing the DEFAULT font because the user's pick
 *  would not load. `font.value` is Inter then, and Inter's axes are Inter's —
 *  publishing them as the picked font's would put wght/opsz sliders under a
 *  Google static cut and offer them to the agent, which is simply a lie about
 *  what is on screen. */
const fallbackActive = ref(false)
const fontAxes = computed<VtAxis[]>(() => (fallbackActive.value ? [] : font.value?.axes ?? []))

/**
 * The token as a parsed ref, with the default standing in for anything
 * unreadable. `mergeConfig` already gates `fontId` through `isVtFontToken`, so
 * a stored junk token cannot reach here — but a control bound to a Collection
 * column can put ANY string in `config.fontId` at any moment, and the whole
 * font row is derived from this. Never null, so nothing downstream branches.
 */
const fontRef = computed<VtFontRef>(() => parseVtFontToken(config.value.fontId) ?? { kind: 'catalog', id: DEFAULT_FONT_ID })

async function loadFont(token: string) {
  fontLoading.value = true
  fontError.value = ''
  fallbackActive.value = false
  try {
    const f = await loadVectorFont(token)
    // A slow load for a family the user has since switched away from must not
    // win the race and repaint with the wrong outlines.
    if (config.value.fontId === token) font.value = markRaw(f)
  } catch {
    // A font that will not load must never leave a blank canvas — that is the
    // whole difference between "any font" and "any font that happens to work".
    // The user's own token STAYS in `config`: a Google cut that lost a race
    // with the network heals on the next load, and silently rewriting their
    // pick to Inter would take that chance away and hide that anything went
    // wrong. So the canvas draws Inter meanwhile and the row says so.
    if (config.value.fontId !== token) return
    // The token's own label when it parses, the RAW string when it does not —
    // an unparseable token can only have arrived from a bound column or an
    // agent patch, and naming the default in both halves of the sentence
    // ("Couldn't load Inter — showing Inter.") would hide exactly what went in.
    const parsed = parseVtFontToken(token)
    fontError.value = `Couldn't load ${parsed ? vtFontRefLabel(parsed) : token} — showing ${vtFontRefLabel({ kind: 'catalog', id: DEFAULT_FONT_ID })}.`
    try {
      const fallback = await loadVectorFont(DEFAULT_FONT_ID)
      if (config.value.fontId === token) { font.value = markRaw(fallback); fallbackActive.value = true }
    } catch {
      if (config.value.fontId === token) font.value = null
    }
  } finally {
    if (config.value.fontId === token) fontLoading.value = false
  }
}
watch(() => config.value.fontId, token => { void loadFont(token) }, { immediate: true })

// ── the font row ────────────────────────────────────────────────────────────
/**
 * The shared `FontPicker` needs the catalog for one thing this surface owns: a
 * freshly-picked family has to be pinned to a REAL shipped weight, and the
 * Weight row's options are that family's `weights`. `loadGoogleCatalog` is
 * module-cached, so this is the picker's own fetch, not a second one.
 */
const googleCatalog = ref<GoogleFont[]>([])
loadGoogleCatalog().then((c) => { googleCatalog.value = c })
const googleEntry = (family: string) => googleCatalog.value.find(f => f.family === family) ?? null

/** The ten curated variable families, above the catalog under the "Sailor"
 *  header — they are the only fonts here with live axes, so they lead.
 *  `variable: true` for all ten: they ARE the curated variable families the
 *  spec means by "pinned … badged `var`" — every one of them has live axes. */
const pinnedFonts = VARIABLE_FONTS.map(f => ({ label: f.label, value: f.id, variable: true }))

/**
 * Two strings, because the picker uses `modelValue` for BOTH the trigger text
 * and the row highlight, and for a curated pick those want different words: it
 * highlights a pinned row by comparing against its `value` (the catalog id,
 * `big-shoulders`) while the trigger should read "Big Shoulders Display". A
 * Google or library pick highlights by FAMILY, and the family is also what the
 * trigger should read — the weight has its own row directly below, so repeating
 * it here would only say the same thing twice.
 */
const fontPickerValue = computed(() => (fontRef.value.kind === 'catalog' ? fontRef.value.id : fontRef.value.family))
const fontPickerDisplay = computed(() => (fontRef.value.kind === 'catalog' ? vtFontRefLabel(fontRef.value) : fontRef.value.family))

/**
 * A pick from the shared picker, turned into a token. Each branch seeds a REAL
 * shipped weight rather than a hopeful 400: the file route is fail-closed on
 * both sides, and a token naming a cut the family does not ship is a load
 * failure, not a near miss.
 */
function onFontSelect(payload:
  | { kind: 'google'; family: string }
  | { kind: 'pinned'; value: string }
  | { kind: 'library'; family: string; foundry: string }) {
  if (payload.kind === 'pinned') { setControl('fontId', payload.value); return }
  if (payload.kind === 'google') {
    // The ten pinned families are REAL Google families, so each of them also
    // appears in the catalog rows below — two rows, one font. The curated id is
    // the better of the two by a mile: it loads the VARIABLE file, with live
    // axes. Picking "Inter" from the catalog must land on the same font as
    // picking it from the pinned list, not on a static 400 cut that quietly
    // drops every axis the user came for.
    const curated = VARIABLE_FONTS.find(f => f.label === payload.family)
    if (curated) { setControl('fontId', curated.id); return }
    const entry = googleEntry(payload.family)
    setControl('fontId', formatVtFontToken({ kind: 'google', family: payload.family, weight: entry ? nearestWeight(entry, 400) : 400 }))
    return
  }
  // `italic: false` so a family that ships both slants opens UPRIGHT: nearest-
  // by-weight alone can hand back the italic when it happens to sit closer to
  // 400, and nobody picks a family expecting to land in its italic. A family
  // with no uprights at all still resolves — `resolveLibraryFace` falls back to
  // the other slant rather than returning null.
  setControl('fontId', libraryToken(payload.family, resolveLibraryFace(payload.family, 400, false)?.weight))
}

/**
 * The cuts the current family actually ships — Google from the catalog,
 * library from the manifest. `null` for a curated family, which is what hides
 * the row: its weight is a continuous AXIS in the Axes group, and offering a
 * second, coarser weight control beside it would be two dials for one thing.
 */
const fontWeightCuts = computed<{ values: number[]; labels: string[] } | null>(() => {
  const ref = fontRef.value
  if (ref.kind === 'catalog') return null
  // The CURRENT weight is always an option, even when the family does not ship
  // it. The token can come from an agent patch or a bound column, and a select
  // whose value matches none of its options renders blank — the row would then
  // be reporting nothing about a font that is loading perfectly well (the file
  // routes snap an unshipped weight to the nearest). Showing the token's own
  // number keeps the row an honest readout of `fontId`.
  const cuts = (shipped: number[], w: number) => [...new Set([...shipped, w])].sort((a, b) => a - b)
  if (ref.kind === 'google') {
    // Before the catalog resolves the row still draws, holding the one weight
    // the token names — a select that briefly offers only the current value is
    // honest; one that offers nothing looks broken.
    const values = cuts(googleEntry(ref.family)?.weights ?? [], ref.weight)
    return { values, labels: values.map(String) }
  }
  const fam = libraryFamily(ref.family)
  const w = ref.weight ?? resolveLibraryFace(ref.family, 400)?.weight ?? 400
  if (!fam) return { values: [w], labels: [String(w)] }
  const values = cuts(fam.faces.map(f => f.weight), w)
  // The foundry's own name for the cut ("Book", "Heavy"), which is what the
  // user bought — the number beside it because Pangram's weights are not the
  // usual 100-step ladder (Book is 375) and the name alone cannot be ordered.
  return { values, labels: values.map(v => { const f = resolveLibraryFace(ref.family, v, ref.italic); return f ? `${v} ${f.style}` : String(v) }) }
})

/** A runtime spec, not a registry entry: `fontWeight` is not a config key —
 *  the TOKEN carries the weight, and this row only re-tokens `fontId`. Not
 *  bindable for the same reason (there is nothing to bind to; `fontId` itself
 *  is the bindable control, and its binding rides on the picker above). */
const fontWeightSpec = computed<ControlSpec>(() => ({
  key: 'fontWeight',
  label: 'Weight',
  kind: 'select',
  options: (fontWeightCuts.value?.values ?? []).map(String),
  optionLabels: fontWeightCuts.value?.labels,
  default: '400',
  group: 'Font',
}))
const fontWeightValue = computed(() => {
  const ref = fontRef.value
  if (ref.kind === 'catalog') return ''
  return String(ref.weight ?? resolveLibraryFace(ref.family, 400)?.weight ?? 400)
})
function setFontWeight(value: string) {
  const ref = fontRef.value
  if (ref.kind === 'catalog') return
  const weight = Number(value)
  if (!Number.isFinite(weight)) return
  setControl('fontId', formatVtFontToken({ ...ref, weight }))
}

// ── inspector ───────────────────────────────────────────────────────────────
const inspectorTab = ref<'design' | 'motion'>('design')
const onDesign = computed(() => inspectorTab.value === 'design')
const onMotion = computed(() => inspectorTab.value === 'motion')

const DESIGN_SECTIONS = VT_SECTIONS.filter(s => s !== 'Motion')

/** The full inspector vocabulary: the declared frame plus the loaded font's own
 *  axes. One list, so the panel, the agent and the sweep menu cannot drift. */
const allControls = computed<ControlSpec[]>(() => [...VT_CONTROLS, ...derivedVtControls(config.value, fontAxes.value)])
// The ACTIVE layer's index is passed, not defaulted: `vtAgentControls` gates the
// `layer.*` vocabulary on `appearance[active]`, so a stroke selected in the aside
// is what makes `layer.width` offerable to the agent.
const activeAgentControls = computed(() => vtAgentControls(config.value, fontAxes.value, activeLayerIndex.value))

const { getLocalSetting } = useLocalSettings()
/**
 * Which appearance layer the `layer.*` controls address — the aside stack's
 * selection.
 *
 * The index is handed to THREE consumers and they must all get the same one:
 * `makeConfigParams` (which resolves a `layer.` key against it, so it is what
 * the panel WRITES to), `visibleVtControls` via `controlVisible` (which decides
 * which controls to SHOW), and `vtAgentControls` (the agent's vocabulary).
 * Gating on layer 0 while writing to layer N is the failure `controls.ts`'s own
 * header warns about: controls that appear and disappear for the wrong reasons.
 */
const activeLayerIndex = ref(0)
/** The layer those controls address, for the `when` predicates and the shader
 *  editor. Never null in practice; the stack may legitimately be empty. */
const activeLayer = computed(() => config.value.appearance?.[activeLayerIndex.value] ?? null)
/** Names for the aside rows, derived from what each layer IS. Never positional —
 *  see `lib/vectortype/layerLabel.ts` for why that matters to motion. */
const layerNames = computed(() => vtLayerLabels(config.value.appearance))
// A stack that shrank under the selection (Import settings, or the agent
// rewriting `appearance`) would leave the panel addressing a layer that is not
// there — every `layer.*` control silently reading its declared default.
watch(() => config.value.appearance?.length ?? 0, (n) => {
  if (activeLayerIndex.value > n - 1) activeLayerIndex.value = Math.max(0, n - 1)
})
/** ═══ TASK 3 BRIDGE ═══ the base fill the export-tier notes describe. The same
 *  collapse `canvas.ts` draws with, so the warning and the picture agree. */
const baseFill = computed(() => vtBaseAppearance(config.value).fill)

const agentParams = makeConfigParams(() => config.value, () => activeLayerIndex.value, 'appearance')
const vtAgent = useStudioAgent({
  controls: () => activeAgentControls.value,
  params: agentParams,
  label: () => 'Vector Type',
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  guidance: () => VT_GUIDANCE,
  // Four Takes: the thumbnail adapter + a Params view over a COPY of this config
  // (same `appearance` list key the live proxy above uses).
  takes: {
    studio: 'vectortype',
    config: () => config.value,
    // Same as Shape: the canvas shape is node state, not config state.
    aspect: () => docAspect(canvasW.value, canvasH.value),
    paramsOf: c => makeConfigParams(() => c, () => activeLayerIndex.value, 'appearance'),
  },
})

// ── Collection variable bindings + sweeps ───────────────────────────────────
/**
 * What a Collection column may be bound to, from the LIVE config.
 *
 * Deliberately not `controlsForStudio(currentNode())` — that resolver reads the
 * node's PERSISTED blob, which this surface only writes on close, so adding a
 * layer left the bindable list describing the stack as it was when the studio
 * opened. It is still the right answer for the Collection drawer (which is
 * looking at a node, not at an open editor); here the config is in hand.
 *
 * `vtBindableControls` id-addresses the stack (`appearance.Lstroke.width`)
 * rather than offering the active-layer-relative `layer.*` keys — see its own
 * doc for why a persisted binding must never mean "whichever layer is selected".
 * It recomputes as the stack changes, so a deleted layer's keys leave this list
 * and any binding made against them degrades to ignored.
 */
const studioControls = computed<StudioControlDesc[]>(() =>
  vtBindableControls(config.value, fontAxes.value).map(mapControlSpecToDesc))

const paramsProxy = makeConfigParams(() => config.value, () => activeLayerIndex.value, 'appearance')

/**
 * The key a BINDING is made against, for a control the panel is showing.
 *
 * The panel's `layer.*` controls follow the selection, which is what an
 * inspector should do and what a persisted binding must not do. So promoting or
 * binding one names the layer it was promoted FROM: `layer.width` on the active
 * stroke becomes `appearance.Lstroke.width`, labelled `Stroke · Stroke width`.
 * Everything else passes through untouched.
 */
function bindableControl(c: ControlSpec): ControlSpec {
  if (!c.key.startsWith(VT_LAYER_PREFIX)) return c
  const id = activeLayer.value?.id
  if (!id) return c
  const key = `appearance.${id}.${c.key.slice(VT_LAYER_PREFIX.length)}`
  const name = layerNames.value[activeLayerIndex.value]
  return { ...c, key, label: name ? `${name} · ${c.label}` : c.label } as ControlSpec
}
const bindableKey = (key: string): string =>
  bindableControl({ key } as ControlSpec).key

/**
 * Read a control's live value, falling back to its declared default.
 *
 * `config.axes` is SPARSE BY DESIGN — an absent tag means "the font's own
 * default for that axis" — so `paramsProxy['axes.wght']` is `undefined` until
 * something writes one, and a slider fed `Number(undefined)` shows NaN and
 * refuses to drag. The derived control's `default` IS the font's declared
 * default, so this is not a guess: it is the same value `resolveCoords` will
 * use at render time.
 */
const controlDefaults = computed(() => {
  const m = new Map<string, string | number>()
  for (const c of allControls.value) m.set(c.key, (c as { default: string | number }).default)
  return m
})
function controlValue(key: string): string | number {
  const v = paramsProxy[key]
  if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) {
    // An id-addressed stack key (`appearance.Lstroke.width`, minted by
    // `bindableControl`) has no entry of its own — its default is the one
    // declaration it was expanded from, `layer.width`.
    const m = /^appearance\.[^.]+\.(.+)$/.exec(key)
    const declared = m ? `${VT_LAYER_PREFIX}${m[1]}` : key
    return controlDefaults.value.get(key) ?? controlDefaults.value.get(declared) ?? 0
  }
  return v as string | number
}

const { boundColumnFor, boundColumnKeyFor, onEdit, promote, unbind } = useStudioVarBindings(
  props.nodeId,
  () => studioControls.value,
  (key, value) => { paramsProxy[key] = value },
  { nodes: () => props.nodes ?? [], edges: () => props.edges ?? [] },
)
// `boundColumnKeyFor` is handed straight through: the sweep writer needs the
// column's stable KEY, and passing the display label instead is the bug that
// silently baked N identical frames across five surfaces.
//
// Every key crossing this boundary goes through `bindableKey` first: the panel
// asks about `layer.width`, the BINDING is stored against the active layer's own
// `appearance.<id>.width`, and the two must agree or the chip never appears on
// the control the user just bound.
const { sweepPopover, applySweep, varMenu, openVarMenu, goToCollection } = useStudioVarMenu({
  nodeId: () => props.nodeId,
  nodes: () => props.nodes ?? [],
  edges: () => props.edges ?? [],
  liveValue: controlValue,
  boundColumnFor: (k: string) => boundColumnFor(bindableKey(k)),
  boundColumnKeyFor: (k: string) => boundColumnKeyFor(bindableKey(k)),
  promote,
  unbind: (k: string, v: string | number) => unbind(bindableKey(k), v),
})
/** The panel's own binding chip, same translation as the menu above. */
const boundFor = (key: string): string | null => boundColumnFor(bindableKey(key))

/**
 * Keys on the `Fill` arm that a SHADER fill does not read.
 *
 * `fill.a`/`fill.b` are the flat/tiling colours; a shader fill paints
 * `spec.input` instead (edited by ShaderFillEditor's nested FillControl), so
 * leaving them in the panel is a control the user can drag with no effect —
 * the exact thing `controls.ts` withholds `stroke` and `fill.b` for elsewhere.
 * `fill.angle`/`fill.density` are already hidden by their own `when`
 * predicates on the `shader` type, and are listed here so the rule reads as
 * one rule rather than two half-rules.
 *
 * REDUNDANT AS OF THE AGENT-VOCABULARY TASK, AND KEPT ON PURPOSE. This set was
 * originally the whole rule, living here rather than in `VT_CONTROLS` because
 * `controls.ts` was landed/verified — with the stated cost that the AGENT could
 * still write `fill.a` on a shader fill and see nothing happen, since
 * `vtAgentControls`/`animatableTargets`/the Collection resolver all read `when`
 * and never this predicate. That cost has since been paid: `fillIsFill` and
 * `fillNeedsB` in `controls.ts` now exclude the `shader` type, so all four
 * consumers agree and every key in this set is already withheld by its own
 * `when`. The set stays as a second net — if a future edit loosens one of those
 * predicates, the panel does not silently regain a control that paints nothing.
 */
const SHADER_INERT_FILL_KEYS = new Set(['layer.paint.a', 'layer.paint.b', 'layer.paint.angle', 'layer.paint.density'])

/** The fill is TYPED shader — the question the panel asks, deliberately not
 *  "has a ShaderSpec". `setControl` seeds the spec on the same tick the type
 *  changes, but gating the editor on the spec would mean a config that somehow
 *  arrived typed-shader with no spec shows no editor at all and no way to make
 *  one, which is unrecoverable from inside the UI. */
const fillTypeIsShader = computed(() => {
  const f = activeLayer.value?.paint
  return isFill(f) && f.type === 'shader'
})

/**
 * What an SVG export will actually do with the whole APPEARANCE STACK.
 *
 * The studio's claim is that its output is real, editable vector — "no raster,
 * no `<image>`, nothing traced". Six of the nine fill types keep that promise;
 * `ombre`, `noise` and `shader` cannot, because a per-pixel hash and a fragment
 * program have no geometric description to recover, so the export embeds a
 * picture instead. All nine were shipped knowing that. The deal is that the
 * product SAYS so — before the file is opened in Illustrator, not after.
 *
 * With a stack that becomes a FOLD: one raster-tier layer makes the whole export
 * raster, and the note names WHICH layer, because "this file contains a raster"
 * is not something the owner of a six-layer stack can act on. Extrude layers are
 * glyph outlines like any other, so an extruded gradient still reports `vector`.
 *
 * The Compositor's SVG writer (`useVectorSvg.ts`) is the anti-pattern this is
 * correcting: it collapses every rich fill to a flat representative colour and
 * tells the user nothing. Silent degradation is the exact failure mode here.
 *
 * Everything below is DERIVED from `exportTier`, which is itself derived from
 * what the emitter returns — no list of kind names is maintained on this side,
 * so a fill that gains (or loses) a vector form changes this copy on the same
 * day, not the day someone remembers.
 */
const stackExportTier = computed(() => vtExportTier(config.value, layerNames.value))
/** One sentence naming the layer(s) that force a raster export, else `null` —
 *  which is also the flag both notes below are rendered on. */
const rasterNote = computed(() => vtRasterNote(stackExportTier.value))
/** The other six, named from the catalog rather than typed out, so the sentence
 *  cannot claim a kind exports as vector after it stops doing so. */
const vectorFillList = computed(() => {
  const kinds = FILL_TYPES.filter(t => paintIsVector({ ...DEFAULT_FILL, type: t }))
  const last = kinds[kinds.length - 1]
  const head = kinds.slice(0, -1).join(', ')
  const list = head ? `${head} and ${last}` : String(last ?? '')
  return list.charAt(0).toUpperCase() + list.slice(1)
})
const svgExportTitle = computed(() => (rasterNote.value
  ? `Real outlines — one editable path per glyph. ${rasterNote.value}.`
  : 'Real outlines — one editable path per glyph, no raster'))

/** Two-way binding for ShaderFillEditor. `DEFAULT_SHADER_SPEC` is only ever the
 *  READ fallback (a clone lands in the config on the type switch itself, and on
 *  the first edit here) — the editor never mutates its `modelValue` in place,
 *  it emits a fresh spread, so the shared module constant cannot be written
 *  through even on that path. */
const shaderSpec = computed<ShaderSpec>({
  get: () => {
    const f = activeLayer.value?.paint
    return isFill(f) && fillIsShader(f) ? f.shader : DEFAULT_SHADER_SPEC
  },
  set: (v: ShaderSpec) => {
    const f = activeLayer.value?.paint
    if (isFill(f)) f.shader = v
  },
})

// Pre-existing gap widened here rather than left for this task to trip over:
// `StudioControlPanel`'s `set` event is typed `string | number | boolean`
// (its emitter never narrows to what a given control kind actually uses),
// but no VT_CONTROLS entry is ever boolean-valued — `controls.ts`'s own
// `toggleSolid` note: "`ControlSpec` has no boolean kind". The cast below is
// therefore type-only, not a behaviour change: every real caller still ever
// passes a string or a number.
function setControl(key: string, value: string | number | boolean) {
  const v = value as string | number
  // Switching the fill type INTO 'shader' seeds a real ShaderSpec so
  // ShaderFillEditor has something to bind to the instant it mounts —
  // otherwise the picker/params/speed read the module-level default while the
  // config still has no `shader` at all, and the first edit is the one that
  // creates it. STRUCTURED-CLONED, never spread: `DEFAULT_SHADER_SPEC` is a
  // shared module constant, and Task 2 already paid for the version of this bug
  // where a shallow copy let frame values leak into the module default (which
  // is what `clonePaint` exists for).
  if (key === 'layer.paint.type' && value === 'shader') {
    const f = activeLayer.value?.paint
    if (isFill(f) && !f.shader) f.shader = structuredClone(DEFAULT_SHADER_SPEC)
  }
  paramsProxy[key] = v
  onEdit(key, v)
}
// Promotes the ACTIVE layer's own key, not the relative one — `bindableControl`.
function promoteControl(c: ControlSpec) {
  const b = bindableControl(c)
  promote(b, controlValue(b.key))
}
function controlVisible(c: ControlSpec): boolean {
  const vc = c as VtControl
  if (SHADER_INERT_FILL_KEYS.has(vc.key) && fillTypeIsShader.value) return false
  // The ACTIVE layer, not `appearance[0]`: `when` falls back to the first layer
  // when it is not told which, which is right headlessly and wrong here.
  return !vc.when || vc.when(config.value, activeLayer.value)
}
function slotControl(slotProps: unknown): ControlSpec {
  return (slotProps as { control: ControlSpec }).control
}

// ── the appearance stack ────────────────────────────────────────────────────
/**
 * Add / remove / duplicate / reorder / toggle, behind the shared
 * `StudioLayerStack` in the `#aside` slot — the same component Gradient and
 * Shader mount, not a fork of it.
 *
 * ## Reorder is a NO-OP for motion, and that is by construction
 *
 * `animatableTargets` addresses the stack by the layer's own stable ID
 * (`appearance.Lstroke.width`), so splicing the array moves the layer and the
 * track's path still names it. Nothing to rewrite, nothing to forget at a future
 * mutation site.
 *
 * `VT_APPEARANCE_REMAP` is still called, and it is not vestigial: it matches only
 * `appearance.<digits>.…`, which is what a track saved before ids — and what
 * `migrateLegacyAppearance` writes for a legacy `strokeWidth` animation — looks
 * like. It leaves an id path alone (a no-op on every track this editor mints
 * itself — `animatableTargets` only ever emits `appearance.<id>.…`). So both
 * vintages follow their layer.
 *
 * REMOVE is the one mutation an id cannot absorb: the layer is gone, so
 * `pruneStackTracks` drops the tracks that pointed at it rather than leaving a
 * timeline row that animates nothing. `applyMotion` would ignore them anyway —
 * that is the guarantee, never a wrong layer — this is the tidy-up.
 *
 * A track's home moved from a flat `motion.tracks` array to the `tracks`
 * array a `'tracks'`-kind MOVE owns (`~/lib/vectortype/config.ts`'s
 * `VtMotionConfig.moves` doc), so this now walks `config.value.motion.moves`
 * and remaps each such move's own tracks in place, rather than one flat list.
 */
function remapLayerTracks(kind: 'move' | 'insert' | 'remove', a: number, b?: number): void {
  for (const mv of config.value.motion.moves) {
    if (mv.kind !== 'tracks' || !mv.tracks?.length) continue
    mv.tracks = kind === 'remove'
      ? VT_APPEARANCE_REMAP.onRemove(mv.tracks, a)
      : kind === 'insert'
        ? VT_APPEARANCE_REMAP.onInsert(mv.tracks, a)
        : VT_APPEARANCE_REMAP.onReorder(mv.tracks, a, b!)
  }
}

/**
 * Colours a NEW layer's paint cycles through.
 *
 * `DEFAULT_FILL` is white, and a second white fill over the first is a layer the
 * user added, cannot see, and reasonably concludes did nothing — the same
 * complaint that made the old zero-width stroke look like "there is no stroke".
 * Gradient's `addLayer` overrides its new layer's blend and opacity for exactly
 * this reason. One click changes it; zero clicks must not hide it.
 */
const NEW_LAYER_COLORS = ['#ff2200', '#00c8ff', '#ffee00', '#22ff88', '#ff5bd0']

/** What each kind is, in the add menu — a kind is a decision about the picture,
 *  not a synonym for "layer". */
const LAYER_KIND_HINT: Record<VtLayerKind, string> = {
  fill: 'Paints the letterform itself.',
  stroke: 'An outline around it. Visible immediately.',
  extrude: 'Offset copies behind it — a block shadow.',
}

const addMenuOpen = ref(false)
function openAddMenu() { addMenuOpen.value = config.value.appearance.length < VT_LAYER_MAX }
// Closed by the next pointer down anywhere else. The menu itself stops that
// event, so choosing a kind is not swallowed by the dismissal.
let offAddMenu: (() => void) | null = null
watch(addMenuOpen, (open) => {
  offAddMenu?.()
  offAddMenu = null
  if (!open) return
  const close = () => { addMenuOpen.value = false }
  window.addEventListener('pointerdown', close)
  offAddMenu = () => window.removeEventListener('pointerdown', close)
})
onBeforeUnmount(() => { offAddMenu?.(); offAddMenu = null })

/**
 * A new layer, of the kind the user asked for.
 *
 * A NEW STROKE IS VISIBLE IMMEDIATELY. `vtLayer` seeds `width` from
 * `VT_DEFAULT_STROKE_WIDTH`, which is non-zero precisely because the old flat
 * `strokeWidth` defaulted to 0 with its colour control gated behind a non-zero
 * width — so the stroke was invisible, its controls were hidden, and users
 * concluded the studio had no stroke at all. That is the bug this whole feature
 * exists to fix; it must not be recreated at the add site.
 */
function addLayer(kind: VtLayerKind) {
  addMenuOpen.value = false
  if (config.value.appearance.length >= VT_LAYER_MAX) return
  const a = NEW_LAYER_COLORS[config.value.appearance.length % NEW_LAYER_COLORS.length] as string
  config.value.appearance.push(vtLayer({ kind, paint: { ...DEFAULT_FILL, a } }))
  // Appended at the TOP of the stack (array end = front), so nothing already in
  // the file is re-ordered by adding — Illustrator's Appearance panel does the
  // same. No track can be pointing past the old end, so there is nothing to remap.
  activeLayerIndex.value = config.value.appearance.length - 1
  onEdit('appearance', config.value.appearance.length)
  restartPreview()
}
function removeLayer(i: number) {
  if (config.value.appearance.length <= 1) return
  config.value.appearance.splice(i, 1)
  remapLayerTracks('remove', i)
  // …and the id-addressed tracks the positional remap does not see.
  config.value.motion.moves = pruneStackTracks(config.value)
  activeLayerIndex.value = Math.min(activeLayerIndex.value, config.value.appearance.length - 1)
}
function duplicateLayer(i: number) {
  if (config.value.appearance.length >= VT_LAYER_MAX) return
  const src = config.value.appearance[i]
  if (!src) return
  // A FRESH id, never the source's: `vtSolidKey` addresses a solid extrude's
  // precomputed body by layer id, so two layers sharing one id would hand the
  // copy the original's geometry.
  config.value.appearance.splice(i + 1, 0, vtLayer({ ...structuredClone(toRaw(src)), id: '' }))
  remapLayerTracks('insert', i + 1)
  activeLayerIndex.value = i + 1
}
function reorderLayer(from: number, to: number) {
  const [moved] = config.value.appearance.splice(from, 1)
  if (!moved) return
  config.value.appearance.splice(to, 0, moved)
  remapLayerTracks('move', from, to)
  activeLayerIndex.value = to
}
// `enabled` is a real persisted boolean (`VtAppearanceLayer.enabled`), not view
// state — the renderer skips a disabled layer, the SVG export omits it, and the
// export tier stops counting it.
function toggleLayer(i: number) {
  const L = config.value.appearance[i]
  if (L) L.enabled = L.enabled === false
}

/**
 * FUSE — an extrude's copies united into one body, toggled per row.
 *
 * ## Why this is a stack row and not a control
 *
 * `layer.solid` is deliberately absent from `VT_CONTROLS` (see `controls.ts`).
 * `ControlSpec` has no boolean kind, and the house workaround — a `select` over
 * `['off','on']` — works in Space Type only because its params are strings. Here
 * `mergeLayer` reads `typeof o.solid === 'boolean'`, so a select would store
 * `'on'`, the merge would drop it, and the user would get a toggle that works
 * until they reopen the file. A control that forgets is strictly worse than no
 * control, so `solid` lives beside `enabled` — the OTHER real boolean on this
 * layer that the schema deliberately does not declare — in the row that owns it.
 *
 * It is written to the layer as a real boolean and saved by `saveConfig`'s
 * `JSON.stringify` like every other field, which is what makes the round-trip
 * work rather than merely appear to.
 *
 * ## What it turns on
 *
 * `solid` is the CAPABILITY, not the appearance: fusing gives the layer a single
 * outer contour, which is what `layer.width` and `layer.strokeColor` need to
 * exist at all (both are gated on `layerIsSolidExtrude`). So the two silhouette
 * controls appear in the inspector the moment this is on — and, on an extrude
 * stored before the silhouette landed, at a width of 0 rather than the backfilled
 * 3 that field used to carry; see `mergedWidth` in `config.ts` for why that
 * normalisation is in the merge and not here.
 *
 * The union itself is NOT run here: `solidExtrudeSig` already watches the whole
 * config, so flipping this schedules the debounced off-loop `prepareSolidExtrudes`
 * on its own. The next frames draw the un-fused stack until the body lands.
 */
function toggleSolid(i: number) {
  const L = config.value.appearance[i]
  if (!L || L.kind !== 'extrude') return
  L.solid = L.solid !== true
}

// ── motion: the shared moves panel ──────────────────────────────────────────
/**
 * What this studio can draw, stated ONCE, in the library. `VT_PRESET_CAPABILITIES`
 * is `blur` + `axes` — everything the engine knows except `copies`, which
 * `VtGlyphMotion` has no field for. Handed to `PresetThumb` in the gallery's
 * `#thumb` slot below so a tile's preview can never promise a capability the
 * renderer will ignore.
 */
const VT_CAPABILITIES = [...VT_PRESET_CAPABILITIES]

/** How the moves panel names the font in prose ("Weight In · Inter Tight 700").
 *  The token's own label, so a Google cut and a library face read as themselves
 *  instead of collapsing to "This font" the moment the pick left the ten. */
const fontLabel = computed(() => vtFontRefLabel(fontRef.value))

/**
 * The shared moves panel's driver for this studio — see `~/lib/vectortype
 * /movesAdapter.ts` and the contract it implements, `~/lib/studio/moves
 * /adapter.ts`. `_cfg` is not read by the factory itself (every adapter
 * method gets its own fresh `cfg` at call time — the factory's own header
 * says so); this only needs to stay reactive to the font (`fontAxes`/
 * `fontLabel`) and a whole-config replacement (Import settings).
 */
const movesAdapter = computed(() => vtMovesAdapter(config.value, fontAxes.value, fontLabel.value))
/** Which card is expanded — a controlled prop the panel asks this surface to
 *  hold (`MovesPanel.vue`'s own `set-open` doc). */
const openMoveId = ref<string | null>(null)

function onPatchClip(partial: Partial<Pick<MotionClip, 'duration' | 'fps'>>) {
  if (partial.duration !== undefined) setControl('motion.duration', partial.duration)
  if (partial.fps !== undefined) setControl('motion.fps', partial.fps)
}

/** Flatten a nested `patch-cfg` partial (`{ motion: { blink: { amount: 0.5 } } }`)
 *  into leaf dotted-path/value pairs, so each one can go through `setControl`
 *  — the same write path every Design-tab control already takes, which is
 *  what makes a Collection column bound to e.g. `motion.blink.amount` keep
 *  writing through when the value changes from a card body instead of the
 *  old always-on slider. */
function flattenPatch(obj: Record<string, unknown>, prefix = ''): Array<[string, string | number]> {
  const out: Array<[string, string | number]> = []
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenPatch(v as Record<string, unknown>, path))
    else out.push([path, v as string | number])
  }
  return out
}
function onPatchCfg(patch: Record<string, unknown>) {
  for (const [key, value] of flattenPatch(patch)) setControl(key, value)
}

/**
 * A tile picked from the gallery. Blink and Scatter are MARKERS (see
 * `movesAdapter.ts`'s `derivedMoves` doc) — picking one never pushes into
 * `clip.moves`, it turns the effect on at its own config leaf (spec §1:
 * "Adding the Blink move sets `blink.amount` to 0.3 … Same for Scatter with
 * `spread` 0.4"), and `derivedMoves` then synthesizes the card on its own.
 * Everything else (a preset move, a Custom/preset `'tracks'` move) is a real
 * stored move and is pushed.
 *
 * The freshly-picked move should open — `MovesPanel`'s own `onGalleryAdd`
 * already emits `set-open(move.id)` right after `add-move`, but for Blink/Scatter
 * that id is the gallery's freshly-minted candidate id, not the FIXED
 * `__blink`/`__scatter` id the derived card actually carries. `nextTick`
 * corrects `openMoveId` after that synchronous `set-open` has already run.
 */
function onAddMove(move: Move) {
  if (move.kind === 'blink') {
    setControl('motion.blink.amount', 0.3)
    void nextTick(() => { openMoveId.value = '__blink' })
    restartPreview()
    return
  }
  if (move.kind === 'scatter') {
    setControl('motion.scatter.spread', 0.4)
    void nextTick(() => { openMoveId.value = '__scatter' })
    restartPreview()
    return
  }
  config.value.motion.moves.push(move as VtMove)
  if (move.kind === 'tracks') playing.value = true
  else restartPreview()
}

/** The full move, not just an id — a derived Blink/Scatter marker has no
 *  `clip.moves` entry to splice (`MovesPanel.vue`'s `remove-move` doc). */
function onRemoveMove(move: Move) {
  if (move.kind === 'blink') { setControl('motion.blink.amount', 0); return }
  if (move.kind === 'scatter') { setControl('motion.scatter.spread', 0); return }
  config.value.motion.moves = config.value.motion.moves.filter(m => m.id !== move.id)
}

/** A derived marker (Blink/Scatter) has no stored entry to patch — its own
 *  dials edit `cfg.motion.blink`/`.scatter` directly through `patch-cfg`
 *  instead (the card body never emits a bare `patch` for one), so a `patch`
 *  that names an id not in `moves` is simply a no-op here. */
function onPatchMove(move: Move, partial: Partial<Move>) {
  const idx = config.value.motion.moves.findIndex(m => m.id === move.id)
  if (idx === -1) return
  config.value.motion.moves[idx] = { ...config.value.motion.moves[idx], ...partial } as VtMove
}

/**
 * "Change" on a move's card, resolved by `MovesPanel` itself (its own
 * `replace-move` doc): the gallery reopens pre-aimed at the move's phase,
 * and the pick comes back here already merged — `newMove.id === oldMove.id`
 * always, with `duration`/`ease`/`play` carried over from the old move
 * unless the pick landed in a different phase. This handler just splices
 * `clip.moves` at that id, immutably, same as `onPatchMove` — `MoveCard.vue`
 * only offers "Change" for a plain `'tracks'` move (no `cardBody`), so a
 * preset/blink/scatter move never reaches this handler.
 */
function onReplaceMove(oldMove: Move, newMove: Move) {
  const idx = config.value.motion.moves.findIndex(m => m.id === oldMove.id)
  if (idx === -1) return
  config.value.motion.moves[idx] = { ...newMove, id: oldMove.id } as VtMove
  playing.value = true
}

// ── preview loop ────────────────────────────────────────────────────────────
const canvas = ref<HTMLCanvasElement | null>(null)
const playing = ref(true)
const stats = ref({ glyphs: 0, shapings: 0, staggered: false, commands: 0 })
const previewTime = ref(0)
/**
 * Shader fields this frame had to freeze at t=0 because the frame asked for
 * more live fields than `LIVE_FIELD_CEILING` allows — read from the frame
 * `drawVectorType` returns, so it is what the renderer ACTUALLY decided rather
 * than a second guess at the same rule.
 *
 * Surfaced for the same reason Space Type and Shape Studio surface theirs: a
 * field truncated without a word reads as "my shader stopped working".
 */
const frozenFieldCount = ref(0)
/**
 * What the STRETCH pipeline actually did on the last frame — read off the frame
 * `drawVectorType` returns, for the same reason `frozenFieldCount` is: it is the
 * renderer's own decision, not a second guess at the same rule.
 *
 * Two things in the panel depend on it. `fit: width` SOLVES the width dial, so
 * the Stretch row must show the solved number rather than the one the user left
 * behind — and must stop pretending to be a slider. And when both dials are
 * pushed the engine receives a softened second axis (the range policy), which is
 * invisible in the picture unless the panel says so.
 */
const lastStretch = ref<VtFrame['stretch'] | null>(null)
/** The solved width dial, or null when `fit` is off / the solve was inert. */
const fittedStretch = computed(() => (
  config.value.fit === 'width' && lastStretch.value?.fitted != null ? lastStretch.value.fitted : null
))
/** Both dials pushed — the engine got a damped second axis. */
const stretchEased = computed(() => lastStretch.value?.damped === true)
/**
 * The Stretch row while `fit` owns it. `kind: 'text'` is chosen for its
 * BEHAVIOUR, exactly as ComfyNodeWidget's seed row chooses it: it keeps
 * StudioRow from adding the drag gesture, the fill band and the slider role,
 * all of which would promise an edit that `fit` immediately overwrites. The
 * `#value` slot then draws the solved number in place of the registry's field.
 */
const fittedStretchSpec = {
  ...(VT_CONTROLS.find(c => c.key === 'stretch') as ControlSpec),
  kind: 'text',
  hint: 'Solved by Fit so the run fills the box — follows the text. Set Fit to off to take the dial back. A bound column is ignored while Fit is on.',
} as ControlSpec
/**
 * The hint above promises the dial comes back "at the value it was solved
 * to" the moment Fit turns off — this is what keeps that promise. The frame
 * is pure and never writes its solve back into `config`, so left alone the
 * Stretch row would repaint the STALE `config.stretch` it held before Fit
 * turned on, and the run would snap to a width the composition was never
 * tuned for. So on the width→off edge (and ONLY that edge — never off→width,
 * never the initial mount, which is why this is a `watch` and not
 * `immediate`) we read `lastStretch.value.fitted` — the frame's own last
 * report, not `fittedStretch`, which has already gone null by the time this
 * callback runs, since `fit` has already flipped to `'off'` — and write it
 * through `setControl`, the same path the dial itself drags through, so
 * undo/persistence see this exactly like a hand-drag.
 */
watch(() => config.value.fit, (fit, prevFit) => {
  if (prevFit !== 'width' || fit !== 'off') return
  const solved = lastStretch.value?.fitted
  if (typeof solved !== 'number' || !Number.isFinite(solved)) return
  setControl('stretch', Number(solved.toFixed(2)))
})
let timer = 0
let startedAt = 0
let disposed = false
const PREVIEW_MAX = 900

const animated = computed(() => vtIsAnimated(config.value))

/**
 * requestAnimationFrame is throttled to ZERO in a hidden/background tab — which
 * is exactly the state a headless or offscreen render runs in — so a pure rAF
 * loop silently never advances there. Fall back to a timer when the document is
 * hidden. Called BEFORE `draw`'s early returns, so a frame skipped while the
 * font loads cannot kill the loop permanently.
 */
function schedule() {
  if (disposed) return
  if (typeof document !== 'undefined' && document.hidden) {
    timer = window.setTimeout(draw, 1000 / 30) as unknown as number
  } else {
    timer = requestAnimationFrame(draw)
  }
}
function stopLoop() {
  cancelAnimationFrame(timer)
  clearTimeout(timer)
  timer = 0
}

function previewBox() {
  const el = canvas.value
  const wrap = el?.parentElement
  const ar = Math.max(0.05, canvasW.value / Math.max(1, canvasH.value))
  const availW = wrap?.clientWidth || PREVIEW_MAX
  const availH = wrap?.clientHeight || Math.round(PREVIEW_MAX / ar)
  let cssW = Math.min(availW, PREVIEW_MAX)
  let cssH = cssW / ar
  if (cssH > availH) { cssH = availH; cssW = availH * ar }
  return { cssW: Math.max(1, Math.round(cssW)), cssH: Math.max(1, Math.round(cssH)) }
}

/**
 * One scheduled tick: re-arm the loop, then paint.
 *
 * Split from `render` so a nudge that is NOT the loop (the catalog landing,
 * below) can force a repaint without forking a second loop — calling `draw()`
 * for that would arm a second `schedule()` and the two would double every
 * frame from then on.
 */
function draw() {
  schedule()
  render()
}

/**
 * ── THE SOLID-EXTRUDE UNION, OFF THE DRAW LOOP ──────────────────────────────
 *
 * A `solid: true` extrude wants its offset copies fused into one body. The
 * fusion is a paper.js boolean union at **~1.3 ms per copy** — 575× the cost of
 * drawing one — so a deep extrude united on a draw frame drops 67 consecutive
 * frames and the studio feels broken. That is why `canvas.ts` cannot reach paper
 * at all (asserted by an import-graph test) and why the renderer's only access
 * to a body is a synchronous PEEK at an already-filled cache.
 *
 * Somebody still has to fill it, and the surface is the natural owner: it is the
 * thing that knows when a parameter settled, and it is already where the bake
 * and the export await the same function. So:
 *
 *   the draw loop READS  (`peekSolidBody`, a `Map.get`, on the frame)
 *   this watcher WRITES  (`prepareSolidExtrudes`, awaited, off the frame)
 *
 * A miss is not an error and nothing waits for a hit: the frame draws the
 * un-unioned stack — the picture the preview has always shown — and the fused
 * body appears on some later frame. Exactly `resolveField`'s posture with a
 * shader field that is still cooking.
 *
 * ## Coalescing — three separate guards, because a slider drag is three problems
 *
 * Dragging `depth` from 1 to 32 emits ~200 `input` events. Without coalescing
 * that is 200 unions of up to 800 copies each, i.e. minutes of queued work for a
 * value the user passed through in 300 ms.
 *
 *  1. **A trailing debounce.** The timer is cleared and re-armed on every change,
 *     so the whole drag collapses to ONE run, fired after the value settles.
 *     Nothing runs mid-drag at all.
 *  2. **One at a time.** A union already in flight is never joined by a second:
 *     the new request sets `solidUnionPending` and the in-flight run re-arms the
 *     debounce when it finishes. Depth is 1, not N.
 *  3. **The cache itself.** `prepareSolidExtrudes` memoises on the union's whole
 *     geometric input, so a run whose geometry has not moved since the last one
 *     is a handful of map lookups and no paper at all. Re-running is cheap on
 *     purpose — that is what lets the trigger be conservative rather than clever
 *     about deciding when it is needed.
 */
const SOLID_UNION_DEBOUNCE_MS = 160

/**
 * A stable signature of everything that could move a solid extrude's geometry —
 * or the EMPTY STRING when the stack holds no solid extrude at all, which is the
 * overwhelmingly common case and must cost nothing.
 *
 * It is the whole config rather than a hand-picked list of fields because the
 * union's inputs are the placed outlines: text, size, tracking, axes, the motion
 * stack and the extrude's own four controls all move them. A list would be a
 * second, incomplete answer to "what feeds this geometry" — and a field left off
 * it would show as a silhouette that stopped tracking one particular slider,
 * which is a bug nobody would think to look for here.
 */
const solidExtrudeSig = computed(() => {
  const layers = config.value.appearance ?? []
  const anySolid = layers.some(
    l => l?.kind === 'extrude' && l.solid === true && Math.round(Number(l.depth) || 0) > 0,
  )
  return anySolid ? JSON.stringify(config.value) : ''
})

let solidUnionTimer = 0
let solidUnionRunning = false
let solidUnionPending = false
let lastSolidBoxSig = ''
/** The draw options the LAST frame actually used. The union must be prepared in
 *  the same output box and pixel ratio the preview is drawing in, or its bodies
 *  are keyed to a placement nothing will ask for and the cache never hits. */
let solidUnionOpts: VtBoxOptions | null = null

function scheduleSolidUnion() {
  if (!solidExtrudeSig.value) return
  clearTimeout(solidUnionTimer)
  solidUnionTimer = window.setTimeout(runSolidUnion, SOLID_UNION_DEBOUNCE_MS) as unknown as number
}

async function runSolidUnion() {
  if (disposed) return
  const f = font.value
  const opts = solidUnionOpts
  if (!f || !opts || !solidExtrudeSig.value) return
  if (solidUnionRunning) { solidUnionPending = true; return }
  solidUnionRunning = true
  try {
    // The result is discarded on purpose: the CACHE is the channel, and the draw
    // loop reads it directly. Handing the map to the preview would mean the
    // preview held geometry from a frame it is no longer drawing.
    await prepareSolidExtrudes(f, config.value, previewTime.value, opts)
  } catch (e) {
    // A failed union is a solid extrude that renders as its un-unioned stack —
    // visible and recoverable. It must never take the preview down with it.
    console.warn('[vector-type] solid extrude union failed', e)
  } finally {
    solidUnionRunning = false
    if (solidUnionPending) { solidUnionPending = false; scheduleSolidUnion() }
  }
}

watch(solidExtrudeSig, () => { scheduleSolidUnion() })

function render() {
  const el = canvas.value
  const f = font.value
  if (!el || !f) return

  if (animated.value && playing.value) {
    if (!startedAt) startedAt = performance.now()
    const dur = Math.max(0.1, config.value.motion?.duration ?? 4)
    previewTime.value = ((performance.now() - startedAt) / 1000) % dur
  }

  const { cssW, cssH } = previewBox()
  el.style.width = `${cssW}px`
  el.style.height = `${cssH}px`
  const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2)
  // Render the LOGICAL output box scaled down to the preview, so what you see is
  // the composition the bake produces — not a differently laid-out one.
  const k = (cssW / Math.max(1, canvasW.value)) * dpr
  const drawOpts = {
    width: canvasW.value, height: canvasH.value, background: background.value, pixelRatio: k,
  }
  // The union's inputs include the PLACEMENT, so the body cache is keyed to this
  // exact box and pixel ratio. A resize (or a move between a 1× and a 2× display)
  // invalidates every warm body, and nothing in the config changed to say so —
  // hence this second trigger alongside the config watcher. It fires only when
  // the box actually moves, so a steady preview asks once and never again.
  solidUnionOpts = drawOpts
  if (solidExtrudeSig.value) {
    const boxSig = `${drawOpts.width}x${drawOpts.height}@${k}`
    if (boxSig !== lastSolidBoxSig) { lastSolidBoxSig = boxSig; scheduleSolidUnion() }
  }
  try {
    const frame = drawVectorTypeToCanvas(el, f, config.value, previewTime.value, drawOpts)
    if (frame) {
      let cmds = 0
      for (const g of frame.outlines.glyphs) cmds += g.commands.length
      stats.value = {
        glyphs: frame.outlines.glyphs.length,
        shapings: frame.shapings,
        staggered: frame.staggered,
        commands: cmds,
      }
      frozenFieldCount.value = frame.frozenFields
      lastStretch.value = frame.stretch
    }
  } catch (e) {
    console.error('[vector-type] preview render failed', e)
  }
}

/**
 * Pause HOLDS the frame; it does not rewind to 0.
 *
 * This mattered the moment there was a vector export: both exports write the
 * frame at `previewTime`, so if pausing snapped the clock back to zero there was
 * no way to export any frame but the first — you could see frame 37 and only
 * ever save frame 0. Resuming rebases `startedAt` so the clock continues from
 * where it stopped instead of jumping.
 *
 * Losing the tracks entirely is different: there is no clip left, so t = 0 is
 * the only meaningful time.
 */
watch(animated, (a) => { startedAt = 0; if (!a) previewTime.value = 0 })
watch(playing, (p) => { startedAt = p ? performance.now() - previewTime.value * 1000 : 0 })

/**
 * Rewind and play — used only when a PRESET slot changes.
 *
 * An entrance is over by t = 0.8s and the preview clock runs a 4s loop, so
 * assigning `Slide Up` at t = 3.1 would show the user nothing at all and read
 * as a dead control. Track edits deliberately do NOT do this: a track spans the
 * whole clip, so scrubbing back would just fight the user mid-drag.
 */
function restartPreview() {
  previewTime.value = 0
  startedAt = 0
  playing.value = true
}

/**
 * The shader-effect catalog, pulled once when the studio opens.
 *
 * Two separate jobs, and both are needed:
 *
 * 1. **The fetch.** `getEffectSync` — which `resolveField` is built on — only
 *    ever returns non-null once SOMETHING on the page has awaited
 *    `fetchShaderFxCatalog()`. `field.ts` self-heals via `kickCatalogFetch` on
 *    a miss, but that costs the user a visibly wrong first frame (the shader's
 *    input fill, not the shader) every time the studio opens. Asking up front
 *    means the very first frame usually has it.
 * 2. **The nudge.** `onFieldCatalogReady` fires once the catalog lands, and
 *    forces ONE repaint. This is the fix for Task 3's hand-off #2: a `speed: 0`
 *    shader fill is deliberately NOT animation (`vtIsAnimated` says so, or a
 *    frozen field would be inexpressible), so nothing about it re-triggers a
 *    draw on its own — on a cold load its one frame is drawn before the
 *    catalog exists and the fallback would stand forever. `render()`, not
 *    `draw()`: see `draw`'s doc.
 *
 * The surface's own loop happens to be unconditional today (`schedule()` runs
 * at the top of every tick regardless of `animated`), so it would eventually
 * self-heal too — but "eventually, because an unrelated loop happens to still
 * be running" is not a fix, and the loop is exactly what Chrome's intensive
 * throttling kills in a backgrounded tab.
 */
let offCatalogReady: (() => void) | null = null

onMounted(() => {
  registerStudioParamBaker(props.nodeId, renderBlobWithOverrides)
  offCatalogReady = onFieldCatalogReady(() => { if (!disposed) render() })
  void fetchShaderFxCatalog()
    .then(() => { if (!disposed) render() })
    .catch(() => { /* offline/backend down — a shader fill shows its input fill, same as before */ })
  schedule()
})
onBeforeUnmount(() => {
  saveConfig()
  disposed = true
  stopLoop()
  // A debounced union armed by the last edit before the studio closed would
  // otherwise fire into a torn-down component.
  clearTimeout(solidUnionTimer)
  offCatalogReady?.()
  offCatalogReady = null
  unregisterStudioParamBaker(props.nodeId)
})

// ── outputs ─────────────────────────────────────────────────────────────────
const exporting = ref(false)
const actionError = ref('')
let actionErrorTimer: ReturnType<typeof setTimeout> | null = null
function setActionError(msg: string) {
  actionError.value = msg
  if (actionErrorTimer) clearTimeout(actionErrorTimer)
  actionErrorTimer = setTimeout(() => { actionError.value = '' }, 5000)
}

/** Full-res render into a throwaway canvas. Shared by Export PNG and the
 *  Collection param baker, so the two can never disagree about framing. */
async function renderFullResBlob(t: number): Promise<Blob | null> {
  const f = font.value ?? await loadVectorFont(config.value.fontId)
  // A ONE-SHOT render gets no second chance: unlike the live preview (which
  // re-resolves every tick and self-heals the moment field.ts's own catalog
  // fetch lands), this draws once and uploads whatever it got. Awaiting the
  // catalog first is what stops a shader fill from silently exporting its input
  // fill. Cheap — the fetch is memoized, so after the first call this resolves
  // on the next microtask.
  await fetchShaderFxCatalog().catch(() => { /* offline — falls back, same as before */ })
  const off = document.createElement('canvas')
  const box = { width: canvasW.value, height: canvasH.value }
  // SOLID EXTRUDE — the boolean union, and the ONLY kind of place it may happen
  // (plan trap 5). It is far too slow for the preview loop above, so the screen
  // shows the un-unioned stack and this one-shot render awaits the fused bodies.
  // The two differ only where translucent copies overlapped and double-darkened,
  // which is the entire point of the flag. Resolves instantly (an empty map, no
  // paper.js loaded at all) unless the stack actually holds a solid extrude.
  const solid = await prepareSolidExtrudes(f, config.value, t, box)
  drawVectorTypeToCanvas(off, f, config.value, t, {
    // `bake` opts a shader fill's field out of the 512px live-preview clamp, so the
    // exported PNG carries the field at the output's own resolution.
    ...box, background: background.value, bake: true, solid,
  })
  return await new Promise<Blob | null>(resolve => off.toBlob(b => resolve(b), 'image/png'))
}

async function exportPng() {
  exporting.value = true
  actionError.value = ''
  try {
    const blob = await renderFullResBlob(previewTime.value)
    if (!blob) throw new Error('canvas produced no blob')
    const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
    const [filename] = await uploadFrameBatch([blob], 'vectortype_img')
    if (filename) {
      await recordAsset(activeTab.value?.projectUuid, 'image', filename)
      window.dispatchEvent(new CustomEvent('sailor:vectorTypeStudioOutput', {
        detail: { sourceNodeId: props.nodeId, nodeType: 'Image', widgetOverrides: { image: filename } },
      }))
      closeEditor()
    }
  } catch (e) {
    console.error('[vector-type] export failed', e)
    setActionError('Export failed — please try again')
  } finally {
    exporting.value = false
  }
}

// ── real file download (distinct from exportPng, which is the canvas "As
// image" action: it uploads + drops an Image node + closes the studio). This
// one just saves a PNG, sharing renderFullResBlob so the two never disagree
// on framing. ─────────────────────────────────────────────────────────────
async function downloadPng() {
  try {
    const blob = await renderFullResBlob(previewTime.value)
    if (!blob) return
    downloadBlobAsFile(blob, `vectortype_${Date.now()}.png`)
  } catch (e) {
    console.error('[vector-type] PNG download failed', e)
    setActionError('Download failed — please try again')
  }
}

/**
 * Export SVG — Sailor's first vector deliverable.
 *
 * Three things about this are decisions, not defaults:
 *
 * 1. **It exports `previewTime`, not the base config.** Every other output on
 *    this surface does too, and the alternative is worse than it sounds: with a
 *    track running, "export" would silently hand back frame 0 while the screen
 *    shows frame 37. Pause and the file matches the paused frame exactly.
 * 2. **It goes to the user's disk, not to the canvas.** The image output path
 *    (`recordAsset` -> `sailor:vectorTypeStudioOutput`) publishes a *filename a
 *    ComfyUI image node can load*, and no node in the product consumes SVG —
 *    routing vector through it would produce a broken image node, not a
 *    deliverable. Export PNG remains the canvas hand-off; this is the one that
 *    opens in Illustrator.
 * 3. **The whole document is built by `vectorTypeSVG`**, the same function that
 *    would be called headlessly, sharing `vectorTypeFrame` + `vtPlacement` with
 *    the preview loop. So the file is the frame on screen, not a second
 *    interpretation of the config.
 */
const svgExporting = ref(false)
async function exportSvg() {
  svgExporting.value = true
  actionError.value = ''
  try {
    const f = font.value ?? await loadVectorFont(config.value.fontId)
    // Same one-shot reasoning as `renderFullResBlob` (:694) and the param baker
    // (:807), and it applies here MORE than to either: the two PNG paths draw
    // through the live canvas resolver, which self-heals on the next tick if the
    // catalog lands late. `vectorTypeSVG` writes a FILE — there is no next tick.
    // Without this, Export SVG clicked in the first few hundred ms of a cold
    // page embeds the shader's INPUT paint instead of the field: `resolveField`
    // returns null, `resolveShaderFill` degrades gracefully, and the file looks
    // entirely plausible while being the wrong picture.
    await fetchShaderFxCatalog().catch(() => { /* offline — falls back, same as before */ })
    // SOLID EXTRUDE — the same one-shot union `renderFullResBlob` awaits, and it
    // matters MORE here: a PNG of eight stacked copies at least looks like the
    // preview, while an SVG of them is eight overlapping paths a designer has to
    // select and merge by hand. With the bodies, a solid extrude is ONE `<path>`
    // per letter. Resolves instantly (an empty map, no paper.js loaded) unless the
    // stack actually holds a solid extrude.
    const solid = await prepareSolidExtrudes(f, config.value, previewTime.value, {
      width: canvasW.value, height: canvasH.value,
    })
    const { svg, frame } = vectorTypeSVG(f, config.value, previewTime.value, {
      width: canvasW.value, height: canvasH.value, background: background.value, solid,
    })
    if (!frame.outlines.glyphs.length) throw new Error('nothing to export — the run has no glyphs')
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${vtExportName(config.value)}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (e) {
    console.error('[vector-type] SVG export failed', e)
    setActionError('SVG export failed — please try again')
  } finally {
    svgExporting.value = false
  }
}

/**
 * Collection sweep baker: apply one row's `params.*` overrides, render one
 * full-res frame, restore in `finally`. Reference:
 * GradientStudioSurface.renderBlobWithOverrides — with two departures, both
 * found by watching a real sweep produce five identical PNGs.
 *
 * 1. **A swept path's motion track is suppressed for the bake.** This studio's
 *    headline animatable parameters are exactly the ones a user is most likely
 *    to sweep — the font axes. With an `axes.wght` track present, `applyMotion`
 *    runs AFTER the override is written and overwrites it with the track's value
 *    at t=0, so all N rows bake the same frame. The sweep is the more specific
 *    instruction ("render these five weights"), so it wins for the paths it
 *    names; every other track keeps animating and is evaluated at t=0 as before.
 *
 * 2. **The whole config is snapshotted, not just the overridden keys.** A
 *    per-key restore cannot undo a sparse axis: `config.axes.GRAD` legitimately
 *    has NO value until something writes one, so its snapshot is `undefined`,
 *    the "restore only if defined" rule skips it, and the last row's value stays
 *    behind in the user's config forever. Deep-cloning a config this small costs
 *    nothing and restores sparseness exactly.
 */
async function renderBlobWithOverrides(overrides: Record<string, string | number>): Promise<Blob | null> {
  const keys = Object.keys(overrides)
  const snapshot = JSON.parse(JSON.stringify(config.value)) as VectorTypeConfig
  try {
    // Suppress tracks aimed at a swept path (see 1 above) BEFORE the overrides
    // land, so nothing can re-derive them mid-render. A track's home is a
    // 'tracks'-kind move's own `tracks` array now, not a flat list — filter
    // each such move's tracks and drop a move left with none (the same
    // "empty move is not a state we keep" rule `pruneStackTracks` follows).
    const swept = new Set(keys)
    config.value.motion.moves = config.value.motion.moves
      .map(mv => (mv.kind === 'tracks' && mv.tracks
        ? { ...mv, tracks: mv.tracks.filter(t => !swept.has(t.path)) }
        : mv))
      .filter(mv => mv.kind !== 'tracks' || (mv.tracks?.length ?? 0) > 0)
    for (const key of keys) paramsProxy[key] = overrides[key]!
    // A row may sweep `fontId` — the new family must be parsed before it can be
    // shaped, and the loaded `font` ref still holds the old one.
    const f = await loadVectorFont(config.value.fontId).catch(() => font.value)
    if (!f) return null
    // Same one-shot reasoning as `renderFullResBlob` — a sweep row renders once
    // and is uploaded; there is no later frame to correct it.
    await fetchShaderFxCatalog().catch(() => { /* offline — falls back, same as before */ })
    const off = document.createElement('canvas')
    // A sweep row is a STILL, and with an entrance preset `t = 0` is deliberately
    // empty — every row would bake blank. `vtStillTime` is the resting frame.
    const stillT = vtStillTime(config.value)
    const box = { width: canvasW.value, height: canvasH.value }
    // Same one-shot union as `renderFullResBlob` — a sweep row is a bake, so a
    // solid extrude fuses here too. A sweep of `layer.depth` would otherwise
    // produce rows whose extrude is solid in the export and stacked in the
    // preview, which is the surface-drift this studio keeps one render path for.
    const solid = await prepareSolidExtrudes(f, config.value, stillT, box)
    drawVectorTypeToCanvas(off, f, config.value, stillT, {
      // A sweep row is a full-resolution EXPORT, not a preview — `bake` opts a
      // shader fill's field out of the 512px live clamp so the uploaded PNG
      // carries the field at the row's own output size rather than an upscale.
      // (Task 3 wired the two PNG sites; this is the third full-res site.)
      ...box, background: background.value, bake: true, solid,
    })
    return await new Promise<Blob | null>(resolve => off.toBlob(b => resolve(b), 'image/png'))
  } catch (e) {
    console.error('[vector-type] param-baker render failed', e)
    return null
  } finally {
    config.value = snapshot
    // Same reason as the import above: the last frame drawn was the sweep row's
    // config, not the restored one, so its solve must not survive the restore.
    lastStretch.value = null
  }
}

// ── settings import / export ────────────────────────────────────────────────
function exportSettings() {
  const blob = new Blob([JSON.stringify(config.value)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `vector-type-${config.value.fontId}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
const importInput = ref<HTMLInputElement | null>(null)
function triggerImport() { importInput.value?.click() }
async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    config.value = mergeConfig(JSON.parse(await file.text()))
    // A whole new config: the frame's last solve belongs to the old one, and the
    // fit-off watch below would write it over the imported stretch.
    lastStretch.value = null
    actionError.value = ''
  } catch (err) {
    console.error('[vector-type] import settings failed', err)
    setActionError('Could not read settings file')
  } finally {
    input.value = ''
  }
}

const frameCount = computed(() => Math.round((config.value.motion.fps || 30) * (config.value.motion.duration || 4)))

/** The Motion tab badge and the header readout — "the number of moves"
 *  (design spec §"Tab badge"). Blink and Scatter count too, even though
 *  neither is a `clip.moves` entry — the same `derivedMoves` gating
 *  `movesAdapter.ts` uses to decide whether to show their card at all. */
const derivedMoveCount = computed(() =>
  (config.value.motion.blink.amount > 0 ? 1 : 0) + (config.value.motion.scatter.spread > 0 ? 1 : 0))
const motionMoveCount = computed(() => config.value.motion.moves.length + derivedMoveCount.value)
</script>

<template>
  <StudioModalShell
    title="Vector Type"
    :agent="vtAgent"
    agent-placeholder="Describe the type — e.g. heavier and wider, letters cascading in…"
    @close="closeEditor"
  >
    <!-- THE APPEARANCE STACK. Illustrator's Appearance panel: an ordered list of
         fills, strokes and extrudes, top of the list = front of the picture.
         Until now this array was reachable only from a settings-JSON import or
         the agent. Shared component, mounted exactly as Gradient and Shader
         mount it — never forked. -->
    <template #aside>
      <div class="relative flex h-full w-full min-h-0 flex-col">
        <StudioLayerStack
          :layers="config.appearance.map((l, i) => ({ label: layerNames[i] ?? `Layer ${i + 1}`, enabled: l.enabled !== false }))"
          :active-index="activeLayerIndex"
          :max="VT_LAYER_MAX"
          @select="activeLayerIndex = $event"
          @add="openAddMenu"
          @remove="removeLayer"
          @duplicate="duplicateLayer"
          @reorder="reorderLayer"
          @toggle="toggleLayer"
        >
          <!-- FUSE, beside the eye. The shared component's `row-extra` slot —
               added for this and passed only the row index, so Gradient and
               Shader (which fill it with nothing) render exactly as before.
               EXTRUDE ROWS ONLY: a fill or a stroke has no copies to unite, and
               a toggle that is present but inert on two thirds of the stack is
               the dead control this studio's schema exists to prevent. -->
          <template #row-extra="{ index }">
            <button
              v-if="config.appearance[index]?.kind === 'extrude'"
              type="button"
              :data-testid="`vt-solid-toggle-${index}`"
              :data-solid="config.appearance[index]?.solid === true ? 'on' : 'off'"
              :aria-pressed="config.appearance[index]?.solid === true"
              aria-label="Fuse extrude copies"
              :title="config.appearance[index]?.solid === true
                ? 'Fused — one body. Click to keep the copies separate.'
                : 'Separate copies. Click to fuse them into one body (adds the silhouette outline controls).'"
              class="shrink-0 transition"
              :class="config.appearance[index]?.solid === true ? 'text-blue-400 hover:text-blue-300' : 'text-white/30 hover:text-white/80'"
              @click.stop="toggleSolid(index)"
            >
              <Combine class="h-3.5 w-3.5" />
            </button>
          </template>
        </StudioLayerStack>
        <!-- The one thing StudioLayerStack cannot express: this stack's `add` is
             a CHOICE of three kinds, and its `add` event carries none. Rather
             than fork the component (or cycle kinds behind one button), the
             choice is rendered here, in the slot this surface owns.
             OVERLAY HYGIENE: the root is `pointer-events-none` and only the menu
             itself takes pointer events — an absolutely-positioned pane over the
             modal that swallowed events would eat wire drags on the canvas
             beneath it. -->
        <div v-if="addMenuOpen" class="pointer-events-none absolute inset-0 z-30">
          <div class="pointer-events-auto absolute right-2 top-9 w-52 rounded-lg border border-white/15 bg-neutral-900/95 p-1 shadow-xl backdrop-blur"
               data-testid="vt-add-layer-menu" @pointerdown.stop>
            <button
              v-for="k in VT_LAYER_KINDS" :key="k" type="button"
              :data-testid="`vt-add-layer-${k}`"
              class="flex w-full flex-col rounded px-2 py-1.5 text-left transition hover:bg-white/10"
              @click="addLayer(k)"
            >
              <span class="text-[11px] capitalize text-white/90">{{ k }}</span>
              <span class="text-[9.5px] leading-tight text-white/40">{{ LAYER_KIND_HINT[k] }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>

    <template #preview>
      <div class="relative flex h-full w-full flex-col items-center justify-center gap-2">
        <canvas ref="canvas" class="max-h-full max-w-full rounded-lg shadow-2xl" />
        <!-- No failure banner over the canvas any more. A font that will not load now
             falls back to Inter and the picture is real — a red "failed to load" slab
             across a perfectly good render would be describing a blank canvas that no
             longer happens. The note lives in the Font row, next to the pick it is
             about (`data-testid="vt-font-note"`). -->
        <div v-if="fontLoading && !font" class="absolute inset-0 flex items-center justify-center text-[11px] text-white/40">
          Loading outlines…
        </div>
        <!-- Never truncate a shader silently: past LIVE_FIELD_CEILING live
             fields the rest freeze at t=0, and a frozen field is visually
             indistinguishable from a broken one. Same wording and placement as
             Shape Studio / Space Type. -->
        <div v-if="frozenFieldCount > 0"
             class="pointer-events-none absolute inset-x-3 bottom-3 rounded-md border border-amber-400/30 bg-black/70 px-3 py-2 text-[11px] text-amber-200/90">
          {{ frozenFieldCount }} shader fill{{ frozenFieldCount > 1 ? 's' : '' }} frozen — too many live shader
          fields at once (limit {{ LIVE_FIELD_CEILING }}). Remove a shader fill for full motion.
        </div>
        <!-- Not decoration: `shapings` is how many DISTINCT axis positions this
             frame shaped. 1 means the whole word shares one clock; anything more
             means the per-glyph stagger path really ran. -->
        <div class="pointer-events-none flex shrink-0 gap-3 font-mono text-[10px] text-white/35">
          <span>{{ stats.glyphs }} glyphs</span>
          <span>{{ stats.commands }} commands</span>
          <span>{{ stats.shapings }} shaping{{ stats.shapings === 1 ? '' : 's' }}</span>
          <span v-if="stats.staggered" class="text-white/60">wave</span>
          <span>t {{ previewTime.toFixed(2) }}s</span>
          <span v-if="motionMoveCount" class="text-white/60">{{ motionMoveCount }} move{{ motionMoveCount === 1 ? '' : 's' }}</span>
        </div>
      </div>
    </template>

    <template #actions>
      <input ref="importInput" type="file" accept="application/json" class="hidden" @change="onImportFile" />
      <StudioActionsFooter :spec="{
        status: { saving: autoSaving, saved: autoSaved, error: actionError || null },
        utilities: [
          ...(animated ? [{ label: playing ? 'Pause' : 'Play', onClick: () => { playing = !playing } }] : []),
          { label: 'Import settings', onClick: triggerImport },
          { label: 'Export settings', onClick: exportSettings },
        ],
        downloads: [
          { label: 'Download PNG', onClick: downloadPng, disabled: !font },
          // WHERE THE CONSEQUENCE LANDS. Same fact as the Paint-section note
          // (`vt-export-tier-note`), said again on the row that produces the
          // file — a user who set the fill an hour ago is not expected to
          // remember. `svgExportTitle` folds the raster caveat, if any, into
          // one sentence; `subtitle` is StudioFooterMenu's dim second line,
          // the same slot SpaceTypeSurface uses for its transparent-video caveat.
          { label: 'Download SVG', onClick: exportSvg, busy: svgExporting, disabled: !font, subtitle: svgExportTitle },
        ],
        canvas: [{ label: 'As image', onClick: exportPng, busy: exporting, disabled: !font }],
      }" />
    </template>

    <template #controls>
      <!-- Design | Motion — the same split Gradient, Space Type and 3D use. -->
      <div class="flex gap-1 rounded-lg border border-white/[0.07] bg-white/[0.03] p-1">
        <button type="button" class="flex-1 rounded px-2 py-1 text-[11px] transition"
                :class="onDesign ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                @click="inspectorTab = 'design'">Design</button>
        <button type="button" class="flex-1 rounded px-2 py-1 text-[11px] transition"
                :class="onMotion ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                @click="inspectorTab = 'motion'">
          <!-- The number of moves — Blink and Scatter count too (design spec
               §"Tab badge"), so the tab never reads "Motion" with no number
               while an effect is running. -->
          Motion<span v-if="motionMoveCount" class="ml-1 text-white/40">{{ motionMoveCount }}</span>
        </button>
      </div>

      <!-- Design: Text · Font · Axes · Layout · Paint. The Axes section is
           declared empty in VT_SECTIONS and filled by the loaded font's own
           fvar — that is the "declare the frame, derive the contents" rule. -->
      <template v-if="onDesign">
        <StudioControlPanel
          :controls="allControls"
          :order="DESIGN_SECTIONS"
          :value="controlValue"
          :visible="controlVisible"
          :bound-for="boundFor"
          :go-to-collection="goToCollection"
          @set="setControl"
          @promote="promoteControl"
          @menu="(e: MouseEvent, c: ControlSpec) => openVarMenu(e, bindableControl(c))"
        >
          <!-- `kind: 'text'` has no default renderer in StudioControlPanel. -->
          <template #control-text="slotProps">
            <label class="mb-1 block text-[11px] text-white/55">{{ slotControl(slotProps).label }}</label>
            <div v-if="boundColumnFor('text')" class="flex items-center justify-between gap-2 rounded bg-white/[0.04] px-2 py-1.5">
              <span class="truncate text-[12px]" style="color: var(--var-accent-text)">{{ boundColumnFor('text') }}</span>
              <button type="button" class="shrink-0 rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white" @click="goToCollection?.()">Edit in table</button>
            </div>
            <input
              v-else
              :value="config.text"
              type="text"
              maxlength="120"
              placeholder="Type something"
              class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              @input="setControl('text', ($event.target as HTMLInputElement).value)"
            />
          </template>

          <!-- THE FONT ROW IS THE SHARED PICKER. `fontId` is declared `kind: 'text'`
               (a token can no longer be enumerated as a select), and the panel would
               draw that as a free-text field — so this slot replaces it with the same
               `FontPicker` row Space Type mounts: the Google catalog, the licensed
               library, and the ten curated variable families pinned on top because they
               are the only ones here with live axes.

               The Weight row rides underneath, and only for a static cut: it is not a
               config key of its own — the TOKEN carries the weight — so it re-tokens
               `fontId` through `setControl`, the same path a hand-edit takes. A curated
               family shows no row; its weight is a continuous axis in the Axes group.

               Right-click is NOT stopped at this wrapper, unlike the Stretch row below,
               and the difference is which element carries the handler. StudioRow's own
               root emits `menu` for a right-click anywhere on the row, so Stretch has to
               stop the native event from ALSO reaching the panel's slot wrapper. The
               picker has no such body handler — only its variable glyph, which already
               stops the event itself — so the wrapper is what gives this row the
               right-click-to-bind menu every other row has. The Weight row below does
               stop it: it is a runtime row for a value that is not a control, so its
               right-click must not open `fontId`'s menu by bubbling into it. -->
          <template #control-fontId="slotProps">
            <div>
              <FontPicker
                :model-value="fontPickerValue"
                :display="fontPickerDisplay"
                label="Font"
                :pinned="pinnedFonts"
                :bound="boundFor('fontId')"
                @select="onFontSelect"
                @promote="promoteControl(slotControl(slotProps))"
                @menu="(e: MouseEvent) => openVarMenu(e, bindableControl(slotControl(slotProps)))"
                @go-to-collection="goToCollection()"
              />
              <!-- Hidden when `fontId` is bound to a Collection column: `applyParamsPreview`
                   (app/composables/useStudioVarBindings.ts) pushes the bound value back onto
                   live state on every preview row, so a weight picked here would be written,
                   autosaved, and then immediately stomped by the next preview tick. -->
              <div v-if="fontWeightCuts && !boundFor('fontId')" class="mt-1.5" data-testid="vt-font-weight" @contextmenu.stop>
                <StudioRow
                  :spec="fontWeightSpec"
                  :model-value="fontWeightValue"
                  :bindable="false"
                  @update:model-value="(v: string | number | boolean) => setFontWeight(String(v))"
                />
                <!-- This row exists ONLY for a static cut (it is hidden for a curated
                     family, whose weight is a live axis instead), so the Axes group
                     below is empty and there is nothing on screen saying why. -->
                <p class="mt-1 text-[10px] leading-snug text-white/30">Static cut — no live axes. The pinned families have them.</p>
              </div>
              <!-- The fallback, said out loud. The canvas is drawing Inter and the row
                   still shows the font the user picked — without this line those two
                   facts contradict each other on screen. -->
              <p v-if="fontError" data-testid="vt-font-note"
                 class="mt-1.5 rounded border border-amber-300/25 bg-amber-300/[0.06] px-2 py-1.5 text-[10px] leading-snug text-amber-100/70">
                {{ fontError }}
              </p>
            </div>
          </template>

          <!-- FIT OWNS THE STRETCH DIAL. `fit: width` solves the width stretch so the
               run fills the box, and the solve wins over whatever the dial says — so the
               row shows the number the RENDERER decided (`frame.stretch.fitted`) and
               stops offering the drag that would be overwritten on the next frame. The
               read-only form is StudioRow with a `kind: 'text'` spec and a `#value`
               slot — the same override ComfyNodeWidget's seed row uses, chosen for the
               behaviour: no drag gesture, no fill band, no slider role. Right-click is
               stopped here too: a binding on a dial `fit` writes would never be read. -->
          <template #control-stretch="slotProps">
            <div v-if="fittedStretch !== null" data-testid="vt-stretch-fitted" @contextmenu.stop>
              <StudioRow :spec="fittedStretchSpec" :model-value="fittedStretch" :bindable="false">
                <template #value>
                  <span class="font-mono text-[11px] tabular-nums text-white/45">{{ formatValue(fittedStretch, 0.01) }}</span>
                </template>
              </StudioRow>
            </div>
            <!-- Fit off: the ordinary schema row, wired exactly as StudioSectionTree
                 wires every other one (the slot replaces that branch, so the wiring
                 has to be repeated here). `@contextmenu.stop` on the wrapper stops the
                 native event from also reaching the panel's own slot wrapper — StudioRow
                 already emits `menu` for both the row body's right-click and the pink
                 glyph's click/right-click, so wiring `@menu` here directly makes StudioRow
                 the single source; without the stop, a right-click on the row body would
                 bubble past StudioRow's root and fire the panel wrapper's own handler too,
                 opening the menu twice. -->
            <div v-else @contextmenu.stop>
              <StudioRow
                :spec="slotControl(slotProps)"
                :model-value="controlValue('stretch')"
                :bound="boundFor('stretch')"
                :bindable="slotControl(slotProps).bindable !== false && controlKindToVariableType(slotControl(slotProps).kind) !== null"
                @update:model-value="(v: string | number | boolean) => setControl('stretch', v as string | number)"
                @promote="promoteControl(slotControl(slotProps))"
                @menu="(e: MouseEvent) => openVarMenu(e, bindableControl(slotControl(slotProps)))"
                @go-to-collection="goToCollection()"
              />
            </div>
          </template>

          <!-- Both dials pushed: the engine received a softened second axis, and
               nothing in the picture says so. `frame.stretch.damped` is the renderer's
               own report, not a re-derivation of the rule. -->
          <template #section-Layout>
            <p v-if="stretchEased" data-testid="vt-stretch-eased" class="text-[10px] leading-snug text-white/30">
              eased — both dials are pushed, so the second is softened for the letters
            </p>
          </template>

          <template #section-Axes>
            <p v-if="fontLoading && !fontAxes.length" class="text-[11px] text-white/30">Reading the font's axes…</p>
            <p v-else-if="!fontAxes.length" class="text-[11px] text-white/30">This font declares no variable axes.</p>
            <p v-else class="text-[10px] leading-snug text-white/30">
              {{ fontAxes.length }} axes from the file's own fvar. These interpolate the OUTLINE, not a bitmap.
            </p>
          </template>

          <!-- Paint: the shader-fill editor. Dynamically-keyed per-effect params
               and a recursive nested fill — no fixed ControlSpec fits, so it is
               a bespoke block in the section slot, exactly as Shape Studio
               mounts the SAME component (never a fork of it). -->
          <template #section-Paint>
            <!-- WHERE THE CHOICE IS MADE. A user picking a shader fill finds out
                 here, not after opening the file in Illustrator. Amber note, the
                 same voice the axis-unavailable and stagger notes use — this is
                 information, not a scolding, and for plenty of work an embedded
                 picture is exactly the right answer. -->
            <p v-if="rasterNote" data-testid="vt-export-tier-note"
               class="rounded border border-amber-300/25 bg-amber-300/[0.06] px-2 py-1.5 text-[10px] leading-snug text-amber-100/70">
              <span class="text-amber-100">{{ rasterNote }}, not editable vector.</span>
              The glyph outlines stay real paths — it is the paint inside them that becomes a picture,
              written at the export's own resolution. One such layer is enough to make the whole file a
              mixed document. {{ vectorFillList }} export as real vector.
            </p>
            <template v-if="fillTypeIsShader">
              <ShaderFillEditor v-model="shaderSpec" />
              <!-- TWO anchors are live at once and they are not the same anchor.
                   Said out loud because two controls a section apart, both
                   labelled "anchor", is otherwise a trap: the user changes the
                   wrong one and concludes the other is broken. -->
              <p class="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[10px] leading-snug text-white/50">
                <span class="text-white/75">Two anchors, two jobs.</span>
                The editor's <em>Anchor</em> decides where the shader itself is pinned — to each
                letter, or to the frame. <em>Fill anchor</em> above decides which box the letters
                sample it through. A frame-anchored shader stays put no matter what Fill anchor says.
              </p>
            </template>
          </template>
        </StudioControlPanel>

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
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-white/55">Transparent background</span>
            <StudioSwitch v-model="bgTransparent" />
          </div>
          <StudioColorField
            v-if="!bgTransparent"
            label="Background"
            v-model="lastBgColor"
            @update:model-value="(v: string) => { background = v }"
          />
        </StudioSection>
      </template>

      <!-- Motion: the shared moves panel — see ~/lib/vectortype/movesAdapter.ts
           and ~/components/vue-canvas/motion/moves/MovesPanel.vue. -->
      <template v-else>
        <MovesPanel
          :clip="config.motion"
          :adapter="movesAdapter"
          :cfg="config"
          :open-move-id="openMoveId"
          @patch-clip="onPatchClip"
          @patch-cfg="onPatchCfg"
          @add-move="onAddMove"
          @remove-move="onRemoveMove"
          @patch-move="onPatchMove"
          @replace-move="onReplaceMove"
          @set-open="(id: string | null) => (openMoveId = id)"
        >
          <!-- Real outlines for an axis preset (the letterforms themselves are
               the picture — "Weight In" drawn as a growing rectangle is
               indistinguishable from "Grow In"); the engine's own live-preview
               card for everything else it has one for; a plain 2-letter tile
               (MoveGallery's own fallback) for a track preset, Blink or
               Scatter, none of which has a preview render of its own. -->
          <template #thumb="{ offer }">
            <VectorTypeThumb
              v-if="offer.kind === 'preset' && vtAxisPreset(offer.phase, offer.presetId)"
              :preset-id="offer.presetId!" :slot-kind="offer.phase"
              :font-id="config.fontId" :text="config.text" :axes="config.axes" :font="font" :fill="baseFill ?? '#ffffff'"
            />
            <PresetThumb
              v-else-if="offer.kind === 'preset'"
              :preset-id="offer.presetId!" :slot-kind="offer.phase" :capabilities="VT_CAPABILITIES"
            />
            <span v-else class="text-[9px] text-white/25">{{ offer.label.slice(0, 2).toUpperCase() }}</span>
          </template>
        </MovesPanel>
      </template>
    </template>
  </StudioModalShell>

  <CanvasContextMenu v-if="varMenu" :x="varMenu.x" :y="varMenu.y" :items="varMenu.items" @close="varMenu = null" />
  <SweepPopover
    v-if="sweepPopover"
    :control="sweepPopover.control"
    :anchor="sweepPopover.anchor"
    @apply="applySweep"
    @close="sweepPopover = null"
  />
</template>
