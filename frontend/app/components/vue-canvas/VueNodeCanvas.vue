<script setup lang="ts">
// force HMR reload
import { VueFlow, useVueFlow, type NodeTypesObject, type EdgeTypesObject } from '@vue-flow/core'
import { MiniMap } from '@vue-flow/minimap'
import { toast } from 'vue-sonner'
import { describeQueueRefusal } from '~/lib/queueRefusal'
import { ARTIFACT_NODE_COMPONENTS, ARTIFACT_NODE_FOR_OUTPUT, fetchObjectInfo, getVueFlowType, getWidgetDefs, isSubgraphType, subgraphToLiteGraph, useVueNodes } from '~/composables/useVueNodes'
import { useSubgraphNavigation } from '~/composables/useSubgraphNavigation'
import { matchStylesInText, type CanvasSnapshot, type StyleLite } from '~/lib/agent/surfaces/canvas'
import { planFrameFromSelection, MAX_FRAME_LAYERS } from '~/lib/canvas/combineFrame'
import { computeRunLeafIds } from '~/lib/canvas/runLeaves'
import { edgeTopologyKey } from '~/lib/canvas/edgeTopologyKey'
import type { Command } from '~/lib/agent/commandSurface'
import { buildCatalog, type CatalogEntry } from '~/lib/portIntentCatalog'
import { isTypeCompatible, linkInputPorts, outputPorts, type NodeTypeLite } from '~/lib/portIntent'
import { NODE_BOOST, NODE_KEYWORDS } from '~/lib/nodeKeywords'
import { capabilityBoosts, capabilityKeywords, capabilityNodeTypes, studioNodeTypes, supersededNodeTypes } from '~/lib/agent/capabilities'
import { studioTunerFor } from '~/lib/agent/studioTune'
import type { ProposedChange } from '~/composables/useLayoutAgent'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { registerWireDrag } from '~/composables/useWireDrag'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import { useCanvasHistory } from '~/composables/useCanvasHistory'
import { useCanvasGroups, GROUP_COLORS, type CanvasGroup } from '~/composables/useCanvasGroups'
import { useCanvasAnnotations, STICKY_COLORS, STICKY_PAPER, type Annotation, type ArrowEndpoint } from '~/composables/useCanvasAnnotations'
import { applyArtifactLocks, applyVariantFanOut, backfillStandaloneArtifactImages, buildFilteredWorkflow, collectKeepSet, realignWidgetValues, setNamedWidget } from '~/composables/useFilteredPrompt'
import { type LocalLayer, ensureLayerFonts, ensureLayerImages, bakeOverlay, createImageLayer, parseIdeogramLayers, parseSeedreamLayers, drawWiredImageLayer, drawLayerSilhouette } from '~/composables/useCompositorLayers'
import { framePresentKeys, legacyWiredFlagsActive } from '~/lib/compositor/frameStack'
import { wiredClonerWidgetEntries } from '~/composables/useCloner'
import { readWiredTreatments } from '~/composables/useWiredTreatments'
import { planWiredMaskJobs } from '~/composables/wiredMaskPlan'
import { resolveClipSource, type ClipSource } from '~~/shared/timeline/resolveClipSource'
import { onCharacterEvent, emitCharacterEvent, type CharacterBusEvents } from '~/lib/characters/bus'
import { summarizeNodeErrors } from '~/lib/validationErrors'
import { resolveWiredInput } from '~/lib/shaderstudio/source'
import { ensureVarsInput } from '~/lib/collection/varsInput'
import { wiredTargets, pushVarPreview } from '~/lib/collection/preview'
import { BINDINGS_PROP, COLLECTION_PROP, LOOKUP_TYPE, VARS_TYPE, type VarBindings } from '~/lib/collection/types'
import { injectSmartLayoutVars } from '~/lib/collection/injectVars'
import { BATCH_PROP, type BatchGridPayload } from '~/lib/collection/matrix'
import { applyRefPromptTokens, materializeReferenceNodes } from '~/lib/refs/injectWorkflow'
import { resolveRefFilename, type RefRegistry } from '~/lib/refs/registry'
import { isRefBinding } from '~/lib/refs/binding'
import { createCollection } from '~/lib/collection/model'
import { autoMatchColumns, reconcileLinks } from '~/lib/collection/lookup'
import { promoteLayoutElement } from '~/lib/collection/layoutBinding'
import { promoteControl } from '~/composables/useStudioVarBindings'
import type { StudioControlDesc } from '~/lib/collection/studioBindables'
import { migrateEditState } from '~~/shared/timeline/types'
import { useTimelineStore, addSpaceTypeClipToEditState } from '~/composables/useTimelineStore'
import type { SpaceTypeState } from '~/lib/spacetype/state'
import { useNodeSearch } from '~/composables/useNodeSearch'
import { useNodeClipboard } from '~/composables/useNodeClipboard'
import { buildTake, appendTake, refreshTakeDisplay, takeHasContent, tagTakeFromRunMeta } from '~/composables/useTakes'
import { LIVE_PREVIEW_NODE_TYPES } from '~/lib/livePreviewNodes'
import { draftMetaFor, consumePendingPromote } from '~/lib/draft/runMeta'
import { getRun } from '~/lib/graph/runRegistry'
import { nodeGenParams } from '~/lib/artifact/takeProvenance'
import { sketchPadPromptOverrides } from '~/lib/sketch/sketchPadPrompt'
import { cleanSketchPrompt } from '~/lib/sketch/sketchIntent'
import { SKETCH_PROP, MAX_SKETCH_ITEMS, KEEP_CARD_SIZE, buildSketchPilePayload, refreshSketchPile, planKeptCard, type SketchPilePayload } from '~/lib/sketch/sketchPile'
import { annotatedImageValueFromViewUrl } from '~/lib/promoteTempImages'
import { applyMoodboardWireEffects, applyMoodboardToRestyleNode, clearMoodboardFromGenerateNode, syncMoodboardWidgets } from '~/lib/graph/moodboardApply'
import { IMAGE_MODELS_BY_ID } from '~/data/image-models'
import { useMoodboards } from '~/composables/useMoodboards'
import type { MoodboardEntry } from '~~/shared/taste/moodboard'
import ComfyNode from '~/components/vue-canvas/ComfyNode.vue'
import ComfyNoteNode from '~/components/vue-canvas/ComfyNoteNode.vue'
import ComfyEdge from '~/components/vue-canvas/ComfyEdge.vue'
import ComfyGateNode from '~/components/vue-canvas/ComfyGateNode.vue'
import ArtifactImageNode from '~/components/vue-canvas/ArtifactImageNode.vue'
import ArtifactTextNode from '~/components/vue-canvas/ArtifactTextNode.vue'
import ArtifactAudioNode from '~/components/vue-canvas/ArtifactAudioNode.vue'
import ArtifactVideoNode from '~/components/vue-canvas/ArtifactVideoNode.vue'
import ArtifactFrameNode from '~/components/vue-canvas/ArtifactFrameNode.vue'
import ArtifactTimelineNode from '~/components/vue-canvas/ArtifactTimelineNode.vue'
import PoseMannequinNode from '~/components/vue-canvas/PoseMannequinNode.vue'
import ShaderEffectNode from '~/components/vue-canvas/ShaderEffectNode.vue'
import Artifact3DNode from '~/components/vue-canvas/Artifact3DNode.vue'
import SpaceTypeNode from '~/components/vue-canvas/SpaceTypeNode.vue'
import GradientStudioNode from '~/components/vue-canvas/GradientStudioNode.vue'
import ShaderStudioNode from '~/components/vue-canvas/ShaderStudioNode.vue'
import TextureStudioNode from '~/components/vue-canvas/TextureStudioNode.vue'
import ShapeStudioNode from '~/components/vue-canvas/ShapeStudioNode.vue'
import VectorTypeNode from '~/components/vue-canvas/VectorTypeNode.vue'
import Scene3DStudioNode from '~/components/vue-canvas/Scene3DStudioNode.vue'
import ShotDirectorNode from '~/components/vue-canvas/ShotDirectorNode.vue'
import ShotDirectorSurface from '~/components/vue-canvas/ShotDirectorSurface.vue'
import LipSyncStudioNode from '~/components/vue-canvas/LipSyncStudioNode.vue'
import LipSyncSurface from '~/components/vue-canvas/LipSyncSurface.vue'
import CharacterNode from '~/components/vue-canvas/CharacterNode.vue'
import CollectionNode from './CollectionNode.vue'
import BatchGridNode from './BatchGridNode.vue'
import SketchPileNode from './SketchPileNode.vue'
import MoodboardNode from './MoodboardNode.vue'
import ReferenceNode from '~/components/vue-canvas/ReferenceNode.vue'
import { buildFilmShotPatch, findShotTarget } from '~/lib/shotdirector/dispatch'
import { hydrateShotSheet, addRef } from '~/lib/shotdirector/hydrate'
import { compileShot } from '~/lib/shotdirector/compile'
import { syncCast, wireCastFor } from '~/lib/shotdirector/castEdges'
import { getProfile } from '~/lib/shotdirector/profiles'
import { hydrateLipSyncSheet } from '~/lib/lipsync/hydrate'
import { compileLipSync } from '~/lib/lipsync/compile'
import { materializeCast } from '~/lib/shotdirector/cast'
import { uploadRefFile } from '~/lib/shotdirector/refUpload'
import { useCharacters } from '~/composables/useCharacters'
import { defaultState, identityRefs, normalizeStateId } from '#shared/characters/types'
import { upstreamSeedScope } from '~/lib/artifact/nextSteps'
import { runStudioCascade, planStudiosToBakeForRun, hasStudioBaker, isStudioNode, isArtifactNode, type CascadeDeps } from '~/lib/studio/cascade'
import { emitCanvasOcclusion } from '~/lib/studio/occlusion'
import { getScene3DRebaker } from '~/lib/scene3d/rebake'
import SubgraphIONode from '~/components/vue-canvas/SubgraphIONode.vue'
import SubgraphBreadcrumb from '~/components/vue-canvas/SubgraphBreadcrumb.vue'
import PortIntentPopover from '~/components/vue-canvas/PortIntentPopover.vue'
import LookupMatchPicker from '~/components/vue-canvas/LookupMatchPicker.vue'
import type { PortAnchor } from '~/lib/portIntent'
import { schemaInputsFromInfo, schemaOutputsFromInfo, syncNodeInputsWithSchema, syncNodeOutputsWithSchema } from '~/utils/syncNodeOutputs'
import { bestPortPair, findCompatiblePortIndex, typesCompatible } from '~/utils/portTypes'
import { usePortIntent } from '~/composables/usePortIntent'
import CanvasGroupView from '~/components/vue-canvas/CanvasGroup.vue'
import StickyAnnotation from '~/components/vue-canvas/StickyAnnotation.vue'
import ChecklistAnnotationView from '~/components/vue-canvas/ChecklistAnnotation.vue'
import PinImageAnnotationView from '~/components/vue-canvas/PinImageAnnotation.vue'
import PinResultAnnotationView from '~/components/vue-canvas/PinResultAnnotation.vue'
import ArrowsLayer, { type ResolvedArrow } from '~/components/vue-canvas/ArrowsLayer.vue'
import CanvasContextMenu, { type MenuItem } from '~/components/vue-canvas/CanvasContextMenu.vue'
import { Play, EyeOff, Ban, Copy, Trash2, Group, SquareDashedMousePointer, Palette, Edit3, Frame, Maximize2, PlusSquare, Boxes, ChevronsUpDown, ChevronsDownUp, Lock, Unlock, Flag, StickyNote, ListChecks, Image as ImageIcon, ArrowRight, Check } from 'lucide-vue-next'
import { useBlockLibrary } from '~/composables/useBlockLibrary'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'

const props = defineProps<{
  workflow: any
  activeTool?: string // 'select' | 'hand'
  activeWorker?: number // parallel-run pool: the worker this canvas's tab runs on (0 = default)
  displayedCanvasId?: string | null // multi-canvas: which doc canvas is on screen
  runningCanvasId?: string | null // multi-canvas: which doc canvas the in-flight run was queued from
}>()

// prompt_id → the node that run is currently executing. Concurrent runs
// (spill-to-pool singles, parallel takes) each animate independently; an
// executing/complete event only touches its own run's glow. This is now the
// single source of truth for "what's running" — the old per-worker map was
// removed because DIRECT-mode re-broadcast made event.source unusable for
// worker attribution (see the prompt_id routing in handleBridgeMessage).
// Uses globalThis.Map (lucide's Map icon shadows the global in this scope).
const runningNodeByPrompt = new globalThis.Map<string, string>()

// prompt_id → the canvasId the run was dispatched from (Task 6 Part C). LOCAL
// cache mirroring the registry entry's canvasId, because default.vue's window
// 'message' handler (registered first, in the parent layout) calls finishRun()
// synchronously on execution_complete/error — DELETING the registry entry —
// BEFORE this component's own 'message' handler reads getRun() for the SAME
// dispatched event. So getRun() returns null on terminal events and per-run
// canvas routing would never fire on them. We populate this cache the first
// time we see a live entry for a prompt (on 'executing') and resolve from it
// on ALL events, so terminal events still find the canvas after finishRun
// dropped the entry. Entry is deleted after the terminal event consumes it.
// (globalThis.Map — lucide's Map icon shadows the global here too.)
const canvasByPrompt = new globalThis.Map<string, string>()
// Multi-canvas: does the in-flight run belong to the canvas on screen? Node
// ids are small sequential ints that collide across a project's canvases, so
// "find node by id" is only safe when the displayed canvas IS the run's
// canvas. Null on either side (legacy paths, single-canvas docs not yet
// loaded) means no scoping info — behave as before.
const runScopeMatches = computed(() =>
  props.runningCanvasId == null
  || props.displayedCanvasId == null
  || props.runningCanvasId === props.displayedCanvasId,
)

// Re-light the nodes still running on the displayed canvas, so switching to a
// still-running canvas shows its animation instead of going blank. Rebuilt from
// runningNodeByPrompt (the per-run registry replaces the old per-worker map):
// each in-flight prompt_id whose run belongs to the displayed canvas contributes
// its executing node. A run's canvas comes from the registry entry's canvasId;
// entries without one (pre-Task-6) or with no registry record fall back to the
// legacy tab-level runScopeMatches gate so nothing regresses.
function applyRunningForActiveWorker() {
  const targets = new globalThis.Set<string>()
  for (const [promptId, nodeIdForRun] of runningNodeByPrompt) {
    const runCanvasId = canvasByPrompt.get(promptId) ?? getRun(promptId)?.canvasId ?? null
    const belongs = runCanvasId != null
      ? (props.displayedCanvasId == null || runCanvasId === props.displayedCanvasId)
      : runScopeMatches.value
    if (belongs) targets.add(nodeIdForRun)
  }
  for (const n of nodes.value as any[]) {
    const should = targets.has(n.id)
    if (!!n.data?.running !== should) n.data = { ...n.data, running: should }
  }
  for (const e of edges.value as any[]) {
    const should = targets.has(e.source)
    if (!!e.data?.running !== should) e.data = { ...e.data, running: should }
  }
}
watch(() => props.activeWorker, () => nextTick(applyRunningForActiveWorker))

// 'executed' results that arrived while their canvas wasn't on screen, keyed
// by the run's canvas id. Applied (and cleared) when that canvas is shown
// again — see the workflow prop watch. Without this, a run finishing on a
// background canvas would either lose its result or, worse, deliver it to a
// same-id node on the displayed canvas.
const pendingTakesByCanvas: Record<string, Array<{ nodeId: string, take: any }>> = {}

function applyPendingTakesForDisplayedCanvas() {
  const canvasId = props.displayedCanvasId
  if (!canvasId || !pendingTakesByCanvas[canvasId]?.length) return
  const pending = pendingTakesByCanvas[canvasId]
  delete pendingTakesByCanvas[canvasId]
  for (const { nodeId, take } of pending) {
    const target = (nodes.value as any[]).find((n: any) => n.id === nodeId)
    if (target) {
      // Scrub-preview node: display-only refresh, no take (same exclusion as
      // the live 'executed' path — see LIVE_PREVIEW_NODE_TYPES).
      if (LIVE_PREVIEW_NODE_TYPES.has(String(target.data?.nodeType))) {
        target.data = refreshTakeDisplay({ ...target.data }, take)
        continue
      }
      take.params = { ...(take.params ?? {}), ...nodeGenParams(target) } // provenance for breeding
      const tagged = tagTakeFromRunMeta(take, String(target.id), { draftMetaFor, consumePendingPromote })
      target.data = appendTake({ ...target.data }, tagged)
    }
  }
}

// Groups round-trip through useVueNodes via a bridge object. Methods are
// reassigned below once useCanvasGroups is instantiated; this dance avoids
// the circular dep (useVueNodes wants the bridge, useCanvasGroups wants
// the nodes ref that useVueNodes creates).
const groupsBridge = { load: (_: any[] | undefined | null) => {}, export: () => [] as any[] }
// Same dance for annotations — they live under workflow.extra.sailor.
const annotationsBridge = { load: (_: unknown) => {}, export: () => ({}) as unknown }

const { nodes, edges, objectInfo, convertFromLiteGraph, convertToLiteGraph } = useVueNodes({ groupsBridge, annotationsBridge })

// ── Canvas agent (Phase 3) — perceive + mutate the graph ─────────────────────
// agentSnapshot() maps the live Vue Flow refs into the pure CanvasSnapshot the
// agent reads (edge handles "output-<i>"/"input-<i>" → port names; widgetDefs[i]
// ↔ widgetsValues[i]) PLUS a trimmed palette of addable node types (buildCatalog,
// anchored on the selection + the request). applyCanvasOps() MATERIALISES
// validated commands onto the live graph — undo comes free from the deep-watch
// history. Both exposed for the canvas prompt.

// Background dot-grid "thinking" animation, driven by the prompt's agent.
const { thinking: agentThinking } = useAgentActivity()

// Stable VueFlow config. These MUST be constant references: an inline object/array
// literal in the <VueFlow> template binding is rebuilt on every render, and VueFlow
// treats a new node-types/edge-types reference as "types changed" → it remounts
// EVERY node. Combined with any idle re-render, that reads as constant canvas
// flicker. Hoisted here so re-renders never churn VueFlow's type registration.
const nodeTypes = {
  comfy: markRaw(ComfyNode), note: markRaw(ComfyNoteNode), gate: markRaw(ComfyGateNode),
  'artifact-image': markRaw(ArtifactImageNode), 'artifact-text': markRaw(ArtifactTextNode),
  'artifact-audio': markRaw(ArtifactAudioNode), 'artifact-video': markRaw(ArtifactVideoNode),
  'artifact-frame': markRaw(ArtifactFrameNode), 'artifact-timeline': markRaw(ArtifactTimelineNode),
  'pose-mannequin': markRaw(PoseMannequinNode), 'shader-effect': markRaw(ShaderEffectNode),
  'artifact-3d': markRaw(Artifact3DNode), 'space-type': markRaw(SpaceTypeNode),
  'gradient-studio': markRaw(GradientStudioNode), 'shader-studio': markRaw(ShaderStudioNode),
  'texture-studio': markRaw(TextureStudioNode), 'shape-studio': markRaw(ShapeStudioNode),
  'vector-type': markRaw(VectorTypeNode),
  'scene3d-studio': markRaw(Scene3DStudioNode),
  'shot-director': markRaw(ShotDirectorNode),
  'subgraph-io': markRaw(SubgraphIONode), 'character': markRaw(CharacterNode),
  'lip-sync': markRaw(LipSyncStudioNode),
  'collection': markRaw(CollectionNode),
  'reference': markRaw(ReferenceNode),
  'batch-grid': markRaw(BatchGridNode),
  'sketch-pile': markRaw(SketchPileNode),
  'moodboard': markRaw(MoodboardNode),
} as NodeTypesObject
const edgeTypes = { comfy: markRaw(ComfyEdge) } as EdgeTypesObject
const defaultEdgeOptions = { type: 'comfy' }
const connectionLineStyle = { stroke: 'var(--action)', strokeWidth: 2 }
const snapGrid: [number, number] = [16, 16]

// NodeTypeLite[] = the cached /object_info nodes (incl. the backend generators +
// Compositor/SmartLayout) PLUS the frontend-only studios (which have no
// /object_info, so they're synthesized from the capability registry).
function agentNodeTypes(): NodeTypeLite[] {
  const oi = (objectInfo.value || {}) as Record<string, any>
  // Drop raw nodes a capability supersedes (e.g. provider upscalers → UpscaleImageNode)
  // so the agent never offers a redundant low-level node over the curated one.
  const hidden = supersededNodeTypes()
  const fromInfo = Object.keys(oi).filter(name => !hidden.has(name)).map((name) => {
    const info = oi[name]
    return {
      name,
      displayName: info?.display_name || name,
      description: info?.description || '',
      category: info?.category || '',
      inputs: linkInputPorts(info),
      outputs: outputPorts(info),
    }
  })
  return [...studioNodeTypes(), ...fromInfo]
}
// Palette for addNode/connect: nodes compatible with the selection's output (or
// a wildcard when nothing's selected) + intent-matched nodes for the phrase.
// Capability intents/boosts make the studios + generators surface and rank above
// raw ComfyUI nodes for creative requests.
// The user's TRAINED styles & characters (runnable trained LoRAs), surfaced to the
// agent so "in my <style>" / "my character X" resolve to a real lora_name + trigger.
// Fetched once (rarely changes); agentSnapshot reads the cached value.
const agentStyles = ref<StyleLite[]>([])
// The user's last request phrase — a recovery signal for the lora backstop on nodes
// with NO prompt widget (RestyleWithLoRANode captions internally), where the style
// is named in the REQUEST ("restyle this in my watercolor style"), not the prompt.
let lastAgentPhrase = ''
async function refreshAgentStyles() {
  try {
    const res = await $fetch<{ loras: any[] }>('/api/loras-local')
    agentStyles.value = (res?.loras ?? [])
      .filter(l => l && l.canGenerateCover) // has a runnable trained (Replicate) model
      .map(l => ({
        name: String(l.name || l.filename),
        kind: (l.kind === 'character' ? 'character' : 'style') as 'character' | 'style',
        ...(l.trigger ? { trigger: String(l.trigger) } : {}),
        file: String(l.filename),
        ...(l.model ? { model: String(l.model) } : {}),
      }))
  } catch { /* no styles / offline — agent just won't offer personal styles */ }
}
onMounted(refreshAgentStyles)

// Backstop for trained-LoRA generators: the model reliably puts a style's TRIGGER
// WORD in the prompt but sometimes forgets (or mis-types) the lora_name picker. If
// the lora widget isn't a valid library file, recover it from the trigger word (or
// style name) present in the prompt — so the right LoRA is actually loaded.
const LORA_GEN_TYPES = new Set(['FluxLoRARemoteNode', 'RestyleWithLoRANode', 'FluxMultiLoRARemoteNode'])
function ensureLoraSelected(node: any) {
  const nt = node?.data?.nodeType
  if (!LORA_GEN_TYPES.has(nt) || !agentStyles.value.length) return
  const defs = (node.data?.widgetDefs ?? []) as any[]
  const vals = (node.data?.widgetsValues ?? []) as any[]
  const idxOf = (name: string) => defs.findIndex(d => d?.name === name)
  const pIdx = idxOf('prompt')
  const prompt = String(pIdx >= 0 ? vals[pIdx] ?? '' : '')
  // Search the node's prompt (trigger word, for generators) AND the user's request
  // (style name, for restyle nodes that have no prompt) so either path recovers.
  const known = (v: string) => agentStyles.value.some(s => s.file === v)
  const matches = matchStylesInText(`${prompt} ${lastAgentPhrase}`, agentStyles.value)
  if (!matches.length) return
  const setVal = (i: number, v: unknown) => {
    if (!Array.isArray(node.data.widgetsValues)) node.data.widgetsValues = []
    while (node.data.widgetsValues.length <= i) node.data.widgetsValues.push(null)
    node.data.widgetsValues[i] = v
  }
  // name widget → its matching url-override widget (lora_url "wins over lora_name").
  const urlFor: Record<string, string> = {
    lora_name: 'lora_url',
    lora_a: 'lora_a_url',
    lora_b: 'lora_b_url',
    lora_c: 'lora_c_url',
    lora_d: 'lora_d_url',
  }
  const loraWidgets = nt === 'FluxMultiLoRARemoteNode' ? ['lora_a', 'lora_b', 'lora_c', 'lora_d'] : ['lora_name']
  let ci = 0
  for (const w of loraWidgets) {
    if (ci >= matches.length) break
    const i = idxOf(w)
    if (i < 0) continue
    const m = matches[ci]!
    if (!known(String(vals[i] ?? ''))) setVal(i, m.file) // pick the file (for the picker + sidecar path)
    // Bulletproof: also set the url override to the trained-model ref — the backend
    // resolves that DIRECTLY (its first check), bypassing filename/sidecar lookup.
    const ui = idxOf(urlFor[w] ?? '')
    if (ui >= 0 && m.model) setVal(ui, m.model)
    ci++
  }
}

function agentCatalog(intent?: string): CatalogEntry[] {
  const oi = (objectInfo.value || {}) as Record<string, any>
  if (!Object.keys(oi).length) return []
  const sel = (nodes.value as any[]).find(n => n.selected)
  const out = sel?.data?.outputs?.[0]
  const anchor = { portType: String(out?.type ?? '*'), direction: 'output' as const }
  const keywords = { ...NODE_KEYWORDS, ...capabilityKeywords() }
  const boosts = { ...NODE_BOOST, ...capabilityBoosts() }
  // Pin GenerateImage (bare prompts) + the trained-LoRA generator when the user
  // has styles (so "in my <style>" can always reach it even on a weak intent match).
  const pins = ['GenerateImageNode', ...(agentStyles.value.length ? ['FluxLoRARemoteNode', 'RestyleWithLoRANode'] : [])]
  const entries = buildCatalog(agentNodeTypes(), oi, anchor, { intent, keywords, boosts, maxNodes: 60, maxEnum: 6, maxIntent: 24, alwaysInclude: pins })
  // Tag our curated capabilities so the surface can list them first as "preferred".
  const capSet = capabilityNodeTypes()
  return entries.map(e => (capSet.has(e.type) ? { ...e, capability: true } : e))
}

function agentSnapshot(phrase?: string): CanvasSnapshot {
  lastAgentPhrase = phrase ?? ''
  const ns = nodes.value as any[]
  const byId = new Map(ns.map(n => [String(n.id), n]))
  const portName = (node: any, handle: string | null | undefined, kind: 'output' | 'input'): string | undefined => {
    const arr = kind === 'output' ? node?.data?.outputs : node?.data?.inputs
    const i = parseInt(String(handle ?? '').replace(`${kind}-`, '') || '0')
    return arr?.[i]?.name
  }
  return {
    nodes: ns.map((n) => {
      const defs = (n.data?.widgetDefs ?? []) as any[]
      const vals = (n.data?.widgetsValues ?? []) as any[]
      const widgets: Record<string, unknown> = {}
      const widgetOptions: Record<string, string[]> = {}
      defs.forEach((d, i) => {
        if (d?.name == null) return
        widgets[d.name] = vals[i]
        if (Array.isArray(d.options) && d.options.length) widgetOptions[d.name] = d.options.map((o: unknown) => String(o))
      })
      return {
        id: String(n.id),
        nodeType: String(n.data?.nodeType ?? n.data?.type ?? n.type ?? 'unknown'),
        title: String(n.data?.title ?? ''),
        mode: n.data?.mode,
        widgets,
        ...(Object.keys(widgetOptions).length ? { widgetOptions } : {}),
        inputs: ((n.data?.inputs ?? []) as any[]).map(p => ({ name: p.name, type: String(p.type ?? '*'), optional: !!p.optional })),
        outputs: ((n.data?.outputs ?? []) as any[]).map(p => ({ name: p.name, type: String(p.type ?? '*') })),
        selected: !!n.selected,
      }
    }),
    edges: (edges.value as any[]).map(e => ({
      source: String(e.source),
      sourcePort: portName(byId.get(String(e.source)), e.sourceHandle, 'output'),
      target: String(e.target),
      targetPort: portName(byId.get(String(e.target)), e.targetHandle, 'input'),
    })),
    catalog: agentCatalog(phrase),
    ...(agentStyles.value.length ? { styles: agentStyles.value } : {}),
  }
}

const AGENT_MODE: Record<string, number> = { normal: 0, mute: 2, muted: 2, bypass: 4, bypassed: 4 }

/** First type-compatible (outIndex, inIndex) pair between two live nodes, honouring
 *  any pinned port names. Returns null when nothing connects. */
function resolveLivePorts(fromNode: any, toNode: any, fromPort?: string, toPort?: string): { oi: number; ii: number } | null {
  const outs = (fromNode.data?.outputs ?? []) as any[]
  const ins = (toNode.data?.inputs ?? []) as any[]
  for (let a = 0; a < outs.length; a++) {
    if (fromPort && outs[a]?.name !== fromPort) continue
    for (let b = 0; b < ins.length; b++) {
      if (toPort && ins[b]?.name !== toPort) continue
      if (isTypeCompatible(String(outs[a]?.type ?? '*'), String(ins[b]?.type ?? '*'))) return { oi: a, ii: b }
    }
  }
  return null
}

function wireEdge(from: any, to: any, fromPort?: string, toPort?: string, ghost = false): string | null {
  if (!from || !to || String(from.id) === String(to.id)) return null
  // Cycle guard — the graph is a DAG. Refuse any edge that would close a loop,
  // i.e. `to` already reaches `from` downstream (e.g. an agent wiring an
  // EditImage's output back into the generator that produced its input). Walk
  // downstream from `to`; if we reach `from`, adding from→to would loop.
  {
    const fromId = String(from.id)
    const seen = new Set<string>([String(to.id)])
    const stack = [String(to.id)]
    while (stack.length) {
      const cur = stack.pop() as string
      if (cur === fromId) return null
      for (const e of edges.value as any[]) {
        if (String(e.source) !== cur) continue
        const t = String(e.target)
        if (!seen.has(t)) { seen.add(t); stack.push(t) }
      }
    }
  }
  const pair = resolveLivePorts(from, to, fromPort, toPort)
  if (!pair) return null
  // One link per input slot — drop any existing edge into it first.
  const kept = (edges.value as any[]).filter(e => !(String(e.target) === String(to.id) && e.targetHandle === `input-${pair.ii}`))
  if (kept.length !== edges.value.length) edges.value.splice(0, edges.value.length, ...kept)
  const id = `e-${from.id}-${pair.oi}-${to.id}-${pair.ii}${ghost ? '-ghost' : ''}`
  addEdges([{
    id,
    source: String(from.id), sourceHandle: `output-${pair.oi}`,
    target: String(to.id), targetHandle: `input-${pair.ii}`,
    type: 'comfy', class: ghost ? 'agent-ghost-edge' : undefined,
    data: { dataType: String((from.data?.outputs ?? [])[pair.oi]?.type ?? '*'), ...(ghost ? { ghost: true } : {}) },
  }])
  return id
}

/** Materialise a command list onto the live graph. With { ghost:true } the new
 *  nodes/edges are tagged for the proposal preview (semi-transparent + pastel).
 *  Returns the ids it created so the caller can commit/discard them. */
async function applyCanvasOps(commands: Command[], ghost = false): Promise<{ nodeIds: string[]; edgeIds: string[] }> {
  // Placeholder ids ($new1…) the model assigned in addNode → the real ids we mint
  // here, so a later connect can reference the just-added node. Persisted on the
  // component so hover-highlight can resolve a proposal row back to its ghost node.
  for (const k of Object.keys(agentIdMap)) delete agentIdMap[k]
  const idMap = agentIdMap
  const sel = (nodes.value as any[]).find(n => n.selected)
  const newIds: string[] = []
  const realId = (id: unknown): string => { const s = String(id); return idMap[s] ?? s }
  const findNode = (id: unknown) => (nodes.value as any[]).find(n => String(n.id) === realId(id))

  // Anchor a new node next to the node it will be wired FROM (per a connect
  // command), else the user's selection, else the rightmost existing node — so it
  // lands beside its source, not in the top-left corner. Snapshot existing nodes
  // up front (the list mutates as we add).
  const existing = (nodes.value as any[]).slice()
  const rightmost = existing.reduce<any>((a, n) => ((n.position?.x ?? 0) > (a?.position?.x ?? -Infinity) ? n : a), null)
  function anchorFor(placeholderId: unknown): { x: number; y: number } {
    const wire = commands.find(c => c.op === 'connect' && c.args?.to === placeholderId)
    const src = wire ? existing.find(n => String(n.id) === realId(wire.args?.from)) : null
    const ref = src ?? sel ?? rightmost
    return ref ? { x: (ref.position?.x ?? 0) + 360, y: ref.position?.y ?? 0 } : { x: 400, y: 240 }
  }

  const edgeIds: string[] = []

  // Nudge a candidate position down (then right) until it clears every existing
  // node AND any new node we just placed — so an added node never lands on top of
  // one already on the canvas. Approximate node footprint; conservative on purpose.
  const NODE_W = 360, NODE_H = 320, NUDGE = 200
  const placed: { x: number; y: number }[] = []
  function avoidOverlap(p: { x: number; y: number }): { x: number; y: number } {
    const occupied = (q: { x: number; y: number }) =>
      [...existing, ...placed].some((n: any) => {
        const nx = n.position?.x ?? n.x ?? 0, ny = n.position?.y ?? n.y ?? 0
        return Math.abs(nx - q.x) < NODE_W && Math.abs(ny - q.y) < NODE_H
      })
    let q = { ...p }, guard = 0
    while (occupied(q) && guard++ < 40) q = { x: q.x, y: q.y + NUDGE }
    if (occupied(q)) q = { x: q.x + NODE_W, y: p.y } // column full → start a new column
    return q
  }

  // PHASE 1 — create all new nodes first.
  for (const cmd of commands) {
    if (cmd.op === 'addNode' && typeof cmd.args?.nodeType === 'string') {
      const pos = avoidOverlap(anchorFor(cmd.args?.id))
      let overrides = cmd.args.widgetOverrides as Record<string, unknown> | undefined
      // An agent-added EditImageNode is for surgical repair (anatomy/text), which
      // Nano Banana does best — force it onto a Nano Banana model unless the agent
      // explicitly picked a Nano Banana variant (never leave it on Flux Kontext).
      if (cmd.args.nodeType === 'EditImageNode' && !/nano banana/i.test(String((overrides as any)?.model ?? ''))) {
        overrides = { ...(overrides ?? {}), model: 'Nano Banana 2' }
      }
      const node = createNodeData(cmd.args.nodeType, { x: pos.x, y: pos.y }, overrides)
      placed.push({ x: pos.x, y: pos.y })
      // Unique NUMERIC id — the run serializer parses node ids as numbers, so a
      // hyphenated id (e.g. "171…-0") would be truncated and break its links.
      node.id = String(Date.now() + (agentNodeSeq++))
      ensureLoraSelected(node) // backstop: pick the trained LoRA from the prompt's trigger word
      if (ghost) { node.class = 'agent-ghost'; node.data.ghost = true }
      ;(nodes.value as any[]).push(node)
      if (typeof cmd.args.id === 'string') idMap[cmd.args.id] = node.id
      newIds.push(node.id)
    }
  }
  // PHASE 1b — capture cards. If a connect feeds FROM an existing generator that
  // already holds a result (not itself an artifact loader), insert a result CARD
  // capturing it so a downstream run reuses the result (via the freeze) instead of
  // re-running the generator. Build the card NODE here (pre-nextTick); wire it in
  // phase 2. Maps the connect command → its inserted card.
  const cardForConnect = new Map<Command, any>()
  const newCardIds = new Set<string>() // cards WE created (need a from→card wire); reused ones already are
  const LOADER_FOR_TYPE: Record<string, string> = { IMAGE: 'Image', VIDEO: 'Video', AUDIO: 'Audio' }
  for (const cmd of commands) {
    if (cmd.op !== 'connect') continue
    const from = findNode(cmd.args?.from)
    if (!from || from.data?.ghost) continue // skip just-added nodes (no result yet)
    const nt = String(from.data?.nodeType ?? '')
    if (nt === 'Image' || nt === 'Video' || nt === 'Audio') continue // already a freezable loader
    const outType = String(from.data?.outputs?.[0]?.type ?? '')
    const loader = LOADER_FOR_TYPE[outType]
    if (!loader) continue // not a media producer
    const ref = outType === 'AUDIO' ? from.data?.audios?.[0] : from.data?.images?.[0]
    if (typeof ref !== 'string' || !ref.includes('filename=')) continue // no loadable result
    const hasResult = (n: any) => loader === 'Audio' ? n.data?.audios?.length : n.data?.images?.length
    // Reuse an EXISTING result card this generator already feeds — don't mint a duplicate.
    const existing = (nodes.value as any[]).find(n => String(n.data?.nodeType) === loader && hasResult(n)
      && (edges.value as any[]).some(e => String(e.source) === String(from.id) && String(e.target) === String(n.id)))
    if (existing) { cardForConnect.set(cmd, existing); continue }
    const card = createNodeData(loader, { x: (from.position?.x ?? 0) + 360, y: (from.position?.y ?? 0) + 230 })
    card.id = String(Date.now() + (agentNodeSeq++))
    if (outType === 'AUDIO') card.data.audios = [...(from.data.audios ?? [])]
    else card.data.images = [...(from.data.images ?? [])]
    if (ghost) { card.class = 'agent-ghost'; card.data.ghost = true }
    ;(nodes.value as any[]).push(card)
    newIds.push(card.id)
    newCardIds.add(card.id)
    cardForConnect.set(cmd, card)
  }
  // VueFlow must register the new nodes (and mount their handles) before any edge
  // can attach — otherwise edges referencing them are pruned as invalid. (Same
  // reason spliceAfterNode awaits here.)
  if (newIds.length) await nextTick()

  // PHASE 2 — connects + widget/mode/delete, in command order.
  const wiredInputs = new Set<string>() // `${nodeId}:${inputIndex}` actually wired
  for (const cmd of commands) {
    if (cmd.op === 'connect') {
      const from = findNode(cmd.args?.from)
      const to = findNode(cmd.args?.to)
      const card = cardForConnect.get(cmd)
      if (from && card && to) {
        // generator → card (only if WE made the card; a reused one is already wired)
        // → target. The freeze strips generator→card on a targeted run.
        if (newCardIds.has(String(card.id))) { const e1 = wireEdge(from, card, undefined, undefined, ghost); if (e1) edgeIds.push(e1) }
        const e2 = wireEdge(card, to, undefined, cmd.args?.toPort as string | undefined, ghost)
        if (e2) { wiredInputs.add(String(to.id)); edgeIds.push(e2) }
      } else if (from && to) {
        const eid = wireEdge(from, to, cmd.args?.fromPort as string | undefined, cmd.args?.toPort as string | undefined, ghost)
        if (eid) { wiredInputs.add(String(to.id)); edgeIds.push(eid) }
      }
      continue
    }
    if (cmd.op === 'deleteNode' && cmd.target) { deleteNodes([realId(cmd.target)]); continue }
    if (cmd.op === 'addNode') continue
    const node = findNode(cmd.target)
    if (!node) continue
    if (cmd.op === 'setWidget' && typeof cmd.args?.name === 'string') {
      // Don't let the agent flip an EditImageNode off Nano Banana — that node is
      // for surgical repair, which Nano Banana handles best (see addNode above).
      if (cmd.args.name === 'model' && String(node.data?.nodeType) === 'EditImageNode'
        && !/nano banana/i.test(String(cmd.args.value ?? ''))) continue
      const defs = (node.data?.widgetDefs ?? []) as any[]
      const idx = defs.findIndex(w => w?.name === cmd.args!.name)
      if (idx >= 0) {
        if (!Array.isArray(node.data.widgetsValues)) node.data.widgetsValues = []
        while (node.data.widgetsValues.length <= idx) node.data.widgetsValues.push(null)
        node.data.widgetsValues[idx] = cmd.args!.value
      }
    } else if (cmd.op === 'setMode') {
      setMode([realId(cmd.target)], AGENT_MODE[String(cmd.args?.mode ?? '').toLowerCase()] ?? 0)
    }
  }

  // PHASE 3 — safety net: if a freshly-added node still has an unconnected
  // REQUIRED input and the user had a node selected whose output is compatible,
  // auto-wire it. Covers "do X to this image" when the model forgot the connect.
  if (sel) {
    for (const id of newIds) {
      const node = (nodes.value as any[]).find(n => String(n.id) === id)
      if (!node || String(sel.id) === id || wiredInputs.has(id)) continue
      const ins = (node.data?.inputs ?? []) as any[]
      const hasUnconnectedRequired = ins.some((p, i) => !p.optional
        && !(edges.value as any[]).some(e => String(e.target) === id && e.targetHandle === `input-${i}`))
      if (hasUnconnectedRequired) { const eid = wireEdge(sel, node, undefined, undefined, ghost); if (eid) edgeIds.push(eid) }
    }
  }

  return { nodeIds: newIds, edgeIds }
}

// ── Agent ghost-preview lifecycle ────────────────────────────────────────────
// preview(animate): render the proposal as semi-transparent pastel ghosts. When
// animate, first play a ~1s white "blueprint" draw-in (node hidden, its contour
// traced as an overlay + the edge drawn) before the ghosts settle. commit:
// promote to real nodes/edges + glimm. discard: remove. Source of truth for
// ghost membership = the `data.ghost` tag (race-safe vs id lists).
const canvasRootRef = ref<HTMLElement | null>(null)
interface OverlayRect { left: number; top: number; w: number; h: number; radius: string }
const blueprintRects = ref<OverlayRect[]>([])
const glimmBurst = ref<OverlayRect | null>(null)
// The node(s) the overlays currently sit on — kept so the blueprint rings + glimm
// re-track the cards when the canvas pans/zooms (the overlays are screen-space).
const overlayNodeIds = ref<string[]>([])
// Hover-highlight: ring the node(s) a proposal row points at while it's hovered.
const agentIdMap: Record<string, string> = {} // placeholder id → real ghost node id
const hoverNodeIds = ref<string[]>([])
const hoverRects = ref<OverlayRect[]>([])
// Studio-tune (headless): undo closures for in-place changes the agent made to a
// node's internals (e.g. a Frame's background). Run on Dismiss; cleared on Keep.
let tuneRestores: (() => void)[] = []
const glimmOn = ref(false) // gates the glimm opacity so it fades in/out
const glimmPeriod = ref(0.55) // sweep speed: slow during the blueprint, fast on commit
let ghostDrawTimer = 0
let glimmTimer = 0
let agentNodeSeq = 0 // monotonic offset for unique NUMERIC node ids (see below)
const BLUEPRINT_MS = 1800

function unionRect(rects: OverlayRect[]): OverlayRect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rects) { minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.left + r.w); maxY = Math.max(maxY, r.top + r.h) }
  return { left: minX, top: minY, w: maxX - minX, h: maxY - minY, radius: rects[0]!.radius }
}

// On-screen rect + corner radius of each node's rounded CARD — the component root
// (.comfy-node) or a nested frame, not Vue Flow's square wrapper — relative to the
// canvas root. Used by both the blueprint contours and the commit glimm.
function cardRects(nodeIds: string[]): OverlayRect[] {
  const root = canvasRootRef.value
  if (!nodeIds.length || typeof document === 'undefined' || !root) return []
  const rootRect = root.getBoundingClientRect()
  const zoom = vfViewport.value.zoom
  const cardOf = (nodeEl: HTMLElement): { el: HTMLElement; radius: number } => {
    let best = nodeEl, bestR = parseFloat(getComputedStyle(nodeEl).borderTopLeftRadius) || 0
    nodeEl.querySelectorAll<HTMLElement>('*').forEach((c) => {
      if (c.clientWidth < nodeEl.clientWidth * 0.6) return
      const r = parseFloat(getComputedStyle(c).borderTopLeftRadius) || 0
      if (r > bestR) { bestR = r; best = c }
    })
    return { el: best, radius: bestR }
  }
  const out: OverlayRect[] = []
  for (const id of nodeIds) {
    const nodeEl = document.querySelector(`.vue-flow__node[data-id="${window.CSS?.escape?.(id) ?? id}"]`) as HTMLElement | null
    if (!nodeEl) continue
    const card = cardOf(nodeEl)
    const r = card.el.getBoundingClientRect() // already includes the zoom transform
    // border-radius is authored pre-transform px → scale by zoom for our overlay.
    out.push({ left: r.left - rootRect.left, top: r.top - rootRect.top, w: r.width, h: r.height, radius: `${card.radius * zoom}px` })
  }
  return out
}

function agentDiscard() {
  if (ghostDrawTimer) { clearTimeout(ghostDrawTimer); ghostDrawTimer = 0 }
  if (glimmTimer) { clearTimeout(glimmTimer); glimmTimer = 0 }
  blueprintRects.value = []
  glimmOn.value = false
  overlayNodeIds.value = []
  hoverNodeIds.value = []; hoverRects.value = []
  // NOTE: tune edits are NOT reverted here — agentDiscard also runs on every
  // recompute()/preview refresh, which must not wipe an applied frame edit. The
  // explicit agentTuneRevert() (Dismiss only) undoes them.
  if (!(nodes.value as any[]).some(n => n.data?.ghost) && !(edges.value as any[]).some(e => e.data?.ghost)) return
  ;(nodes.value as any[]).splice(0, nodes.value.length, ...(nodes.value as any[]).filter(n => !n.data?.ghost))
  ;(edges.value as any[]).splice(0, edges.value.length, ...(edges.value as any[]).filter(e => !e.data?.ghost))
}

async function agentPreview(commands: Command[], animate = false) {
  agentDiscard() // clear any prior preview first
  if (!commands.length) return
  await applyCanvasOps(commands, true)
  if (!animate) return
  // Blueprint draw-in: hide the ghost cards, trace their white contours as
  // overlays, and draw the edge; then settle into the steady ghost after ~1s.
  const ghostNodeIds = (nodes.value as any[]).filter(n => n.data?.ghost).map(n => String(n.id))
  for (const n of nodes.value as any[]) if (n.data?.ghost) n.class = 'agent-ghost agent-ghost-hidden'
  for (const e of edges.value as any[]) if (e.data?.ghost) e.data.blueprint = true // white flowing dash on the wire
  await nextTick()
  overlayNodeIds.value = ghostNodeIds // so the overlays re-track on pan/zoom
  const rects = cardRects(ghostNodeIds)
  blueprintRects.value = rects
  // A slow glimm where the node is about to appear (under the white contour).
  if (rects.length) { glimmPeriod.value = 3; glimmBurst.value = unionRect(rects); glimmOn.value = true }
  ghostDrawTimer = window.setTimeout(() => {
    ghostDrawTimer = 0
    blueprintRects.value = []
    glimmOn.value = false // fade the slow glimm out as the node settles in
    overlayNodeIds.value = []
    for (const n of nodes.value as any[]) if (n.data?.ghost) n.class = 'agent-ghost'
    for (const e of edges.value as any[]) if (e.data?.ghost) e.data.blueprint = false // back to the steady ghost dash
  }, BLUEPRINT_MS)
}

function agentCommit() {
  if (ghostDrawTimer) { clearTimeout(ghostDrawTimer); ghostDrawTimer = 0 }
  blueprintRects.value = []
  hoverNodeIds.value = []; hoverRects.value = []
  tuneRestores = [] // keep the in-place studio-tune edits
  const ghostNodeIds = (nodes.value as any[]).filter(n => n.data?.ghost).map(n => String(n.id))
  for (const n of nodes.value as any[]) if (n.data?.ghost) { n.class = undefined; n.data.ghost = false }
  for (const e of edges.value as any[]) if (e.data?.ghost) { e.data.ghost = false; e.data.blueprint = false }
  glimmBurstOver(ghostNodeIds) // just the new node(s), not the connection
  return ghostNodeIds // the just-committed node ids (so the caller can run them)
}

/** Bring the given node(s) into view — used by the agent fast lane, which
 *  places a node at a fixed graph position (not viewport-relative) and skips
 *  the blueprint animation, so the node could otherwise land off-screen. */
function agentFrameNodes(ids: string[]) {
  if (ids.length) fitView({ nodes: ids, padding: 0.4, duration: 250 })
}

/** Glimm "citrus" sweep over the just-committed node(s) — their exact on-screen
 *  box + rounded corners. Brief celebratory finish. */
function glimmBurstOver(nodeIds: string[]) {
  const rects = cardRects(nodeIds)
  if (!rects.length) return
  glimmPeriod.value = 0.55 // quick celebratory sweep
  glimmBurst.value = unionRect(rects)
  glimmOn.value = true
  overlayNodeIds.value = nodeIds // re-track on pan/zoom during the burst
  if (glimmTimer) clearTimeout(glimmTimer)
  glimmTimer = window.setTimeout(() => { glimmOn.value = false; overlayNodeIds.value = [] }, 1150) // keep the rect; fade out via opacity
}

/** Headless studio-tune: for each tuneNode command, run the target node's OWN
 *  agent surface against the request and apply it IN PLACE (the node re-bakes
 *  itself). Returns proposal rows + a notice; pushes undo closures onto
 *  tuneRestores so Dismiss reverts. Studios: Frame, Gradient, Shader, Texture,
 *  Smart Layout (dispatched by nodeType via studioTunerFor). */
async function agentTune(tuneCmds: { target: string; request: string }[], apiKey: string): Promise<{ changes: ProposedChange[]; notice?: string }> {
  const changes: ProposedChange[] = []
  const notices: string[] = []
  const tunedIds: string[] = []
  for (const tc of tuneCmds) {
    // Resolve a just-added node's placeholder id ($new1) → its real ghost id.
    const realId = agentIdMap[String(tc.target)] ?? String(tc.target)
    const node = (nodes.value as any[]).find(n => String(n.id) === realId)
    if (!node) continue
    const tuner = studioTunerFor(node.data?.nodeType)
    if (!tuner) { notices.push(`I can’t tune “${node.data?.title || node.data?.nodeType || 'that node'}” from the canvas yet.`); continue }
    try {
      const res = await tuner(node, tc.request, apiKey)
      if (res.restore) tuneRestores.push(res.restore)
      if (res.notice) notices.push(res.notice)
      if (res.error) notices.push(res.error)
      if (res.ok) {
        tunedIds.push(String(node.id))
        for (const row of res.rows) {
          changes.push({ command: { op: 'tuneNode', target: String(node.id), args: { request: tc.request } }, label: row.label, before: row.before, after: row.after, rationale: row.rationale, rerollable: false, accepted: true })
        }
      }
    } catch (e) { notices.push(e instanceof Error ? e.message : String(e)) }
  }
  if (tunedIds.length) glimmBurstOver(tunedIds) // glimm the frame to show the in-place change
  return { changes, notice: notices.length ? notices.join(' ') : undefined }
}

/** The output image of an agent run, as a data URL, for the visual-review loop.
 *  Picks the most-downstream run node that produced an image. */
function agentResultNode(nodeIds: string[]): any | null {
  const eds = edges.value as any[]
  const byId = (id: string) => (nodes.value as any[]).find(n => String(n.id) === String(id))
  const hasImg = (n: any) => typeof n?.data?.images?.[0] === 'string'

  // 1) Of the nodes we were handed, keep only the DOWNSTREAM-most — drop any that
  //    feed another target. This is what fixes "re-review reads the OLD image": a
  //    fix (e.g. EditImage) is wired result→effect, and the auto-captured INPUT
  //    card (holding the previous image) rides along in the target set; without
  //    this it could win over the freshly-produced output.
  let targets = nodeIds.map(String)
  const tset = new Set(targets)
  targets = targets.filter(id => !eds.some(e => String(e.source) === id && tset.has(String(e.target))))

  // 2) Walk the FULL downstream subgraph from those targets, tracking depth. A
  //    review fix can insert a CHAIN (generator → EditImage → new result card), so
  //    a single hop isn't enough — the freshest result is the DEEPEST node that has
  //    an image. This is what makes a re-critique's scan land on the NEW output
  //    rather than the original card. `seen` guards against cycles.
  const seen = new Set<string>()
  const queue: Array<{ id: string; d: number }> = targets.map(id => ({ id, d: 0 }))
  let best: any = null, bestDepth = -1
  while (queue.length) {
    const { id, d } = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId(id)
    if (hasImg(node) && d >= bestDepth) { best = node; bestDepth = d }
    for (const e of eds) if (String(e.source) === id) queue.push({ id: String(e.target), d: d + 1 })
  }
  return best
}

/** The id of the node whose IMAGE a review of `nodeIds` would judge — i.e. the
 *  OUTPUT/result node, resolved past a generator to its result card. Used to put
 *  the "scanning" overlay on the actual output, not the generator. */
function agentResolveResultNode(nodeIds: string[]): string | null {
  const n = agentResultNode(nodeIds)
  return n ? String(n.id) : null
}

async function agentRunOutputImage(nodeIds: string[]): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const node = agentResultNode(nodeIds)
  const url = node?.data?.images?.[0]
  if (typeof url !== 'string') return null
  try {
    // Cache-bust so a re-review never gets a STALE cached blob (overwritten files
    // can reuse a filename).
    const bust = url + (url.includes('?') ? '&' : '?') + '_r=' + Date.now()
    const res = await fetch(bust)
    if (!res.ok) return null
    const blob = await res.blob()
    // Vision billing is (w × h) / 750 tokens, so a 2K render costs ~5× a 720p one
    // for no gain — hands/text/artifact defects read fine at ~1280px. Cap the long
    // edge before encoding; below the cap, return the original bytes untouched.
    const MAX_REVIEW_EDGE = 1280
    try {
      const bmp = await createImageBitmap(blob)
      const long = Math.max(bmp.width, bmp.height)
      if (long > MAX_REVIEW_EDGE) {
        const scale = MAX_REVIEW_EDGE / long
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bmp.width * scale))
        canvas.height = Math.max(1, Math.round(bmp.height * scale))
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
          bmp.close()
          return canvas.toDataURL('image/webp', 0.9)
        }
      }
      bmp.close()
    } catch { /* not decodable as an image (or bitmap unsupported) → send as-is */ }
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(blob)
    })
  } catch { return null }
}

/** The intent behind a node's result — its own prompt, else the nearest upstream
 *  prompt — so an on-demand "Critique" judges the output against what made it. */
function agentNodeIntent(nodeId: string): string {
  const byId = new Map((nodes.value as any[]).map(n => [String(n.id), n]))
  const PROMPT_KEYS = ['prompt', 'text', 'instruction', 'positive_prompt', 'positive']
  const promptOf = (n: any): string => {
    const defs = (n?.data?.widgetDefs ?? []) as any[]
    const vals = (n?.data?.widgetsValues ?? []) as any[]
    for (const k of PROMPT_KEYS) {
      const i = defs.findIndex(d => d?.name === k)
      if (i >= 0 && typeof vals[i] === 'string' && vals[i].trim()) return String(vals[i]).trim()
    }
    return ''
  }
  const seen = new Set<string>()
  const stack = [String(nodeId)]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const n = byId.get(id)
    const p = promptOf(n)
    if (p) return p
    for (const e of edges.value as any[]) if (String(e.target) === id) stack.push(String(e.source))
  }
  return ''
}

/** Undo all headless studio-tune edits from the current proposal (Dismiss). */
function agentTuneRevert() {
  for (const r of tuneRestores) { try { r() } catch { /* best-effort */ } }
  tuneRestores = []
}

/** Hover a proposal row → ring the node(s) it points at (and brighten its wire).
 *  Pass null to clear. Resolves addNode/connect placeholder ids via agentIdMap. */
function agentHighlight(command: { op?: string; target?: unknown; args?: any } | null) {
  for (const e of edges.value as any[]) if (e.data?.hi) e.data.hi = false // clear prior wire highlight
  if (!command) { hoverNodeIds.value = []; hoverRects.value = []; return }
  const resolve = (id: unknown): string => { const s = String(id); return agentIdMap[s] ?? s }
  const ids: string[] = []
  if (command.op === 'connect') {
    const from = resolve(command.args?.from), to = resolve(command.args?.to)
    const edge = (edges.value as any[]).find(e => String(e.source) === from && String(e.target) === to)
    if (edge) { if (!edge.data) edge.data = {}; edge.data.hi = true }
    if (from) ids.push(from)
    if (to) ids.push(to)
  } else if (command.op === 'addNode') {
    const direct = command.args?.id != null ? agentIdMap[String(command.args.id)] : undefined
    const byType = direct ? null : (nodes.value as any[]).find(n => n.data?.ghost && n.data?.nodeType === command.args?.nodeType)
    const id = direct ?? (byType ? String(byType.id) : undefined)
    if (id) ids.push(id)
  } else if (command.target != null) {
    ids.push(resolve(command.target))
  }
  hoverNodeIds.value = ids
  hoverRects.value = cardRects(ids)
}

const {
  groups,
  createGroupFromSelection,
  nodesInGroup,
  dragGroup,
  resizeGroup,
  updateGroup,
  deleteGroup,
  setGroups,
  toggleCollapse: toggleGroupCollapse,
  hiddenNodeIdsByGroups,
  setStatus: setGroupStatus,
  toggleLock: toggleGroupLock,
  toLiteGraph: groupsToLiteGraph,
  fromLiteGraph: groupsFromLiteGraph,
} = useCanvasGroups(nodes as any)

groupsBridge.load = (raw) => setGroups(groupsFromLiteGraph(raw))
groupsBridge.export = () => groupsToLiteGraph()

const {
  annotations,
  createSticky,
  createChecklist,
  createImagePin,
  createResultPin,
  createArrow,
  update: updateAnnotation,
  move: moveAnnotation,
  resize: resizeAnnotation,
  remove: removeAnnotation,
  removeForGroup: removeAnnotationsForGroup,
  dragGroupAttached: dragGroupAttachedAnnotations,
  setGroupAttachment,
  setAll: setAnnotations,
  exportToExtra: annotationsExportToExtra,
  loadFromExtra: annotationsLoadFromExtra,
} = useCanvasAnnotations(nodes as any)

annotationsBridge.load = (raw) => annotationsLoadFromExtra(raw)
annotationsBridge.export = () => annotationsExportToExtra()

// Make the live graph available to child nodes that need to look up upstream
// data (e.g. MaskExtractor showing its source image as a fallback preview).
provide('vueFlowNodes', nodes)
provide('vueFlowEdges', edges)
// The active run's OUTPUT nodes — run members with no downstream node also in
// the run. Artifact cards use this to keep generation FX (img-fx churn, glimm
// sweep) off intermediate/input cards: only the run's terminal results churn.
// Empty when no run is tracked (legacy paths) — consumers treat empty as
// "no filtering" so those paths keep their old behavior.
const runLeafNodeIds = computed(() => computeRunLeafIds(activeRunNodeIds.value, edges.value as any[]))
provide('runLeafNodeIds', runLeafNodeIds)
const {
  onConnect, addEdges, fitView, fitBounds, zoomIn: vfZoomIn, zoomOut: vfZoomOut,
  project, removeNodes, removeEdges, viewport: vfViewport, onNodeDragStart, onNodeDragStop, onNodeDrag,
  onConnectStart, onConnectEnd, onEdgesChange,
} = useVueFlow()

// Ports label themselves while a compatible wire is being dragged. Bound once,
// here, because there is one canvas and every port reads the same drag.
registerWireDrag()

// Sketch pad (prompt-bar sketching): one disposable hidden generator node per
// canvas, feeding the review strip below (never a visible SketchPile node —
// that's the sketch-NODE flow's own pile, a separate thing). Anchor persists
// across re-sketches/re-rolls so the strip's "keeper spot" stays put.
// padNodeId is the transient GENERATOR node's NATURAL numeric id (minted by
// createNodeData, same convention as every other runnable node) — the run
// pipeline serializes node ids through Number() when building a workflow.
// pileNodeId is retired for this flow (kept in the shape, always null) — no
// pile node is ever created for prompt-bar sketching now.
const sketchPad = reactive<{ anchor: { x: number, y: number } | null, seed: number, prompt: string, promptId: string | null, padNodeId: string | number | null, pileNodeId: string | number | null }>(
  { anchor: null, seed: 0, prompt: '', promptId: null, padNodeId: null, pileNodeId: null },
)

// Prompt-bar sketch REVIEW STRIP: the pad's batch lands here — never as a
// pile node. Docked above the prompt bar; the user reviews all four and
// commits exactly one via Keep or drag-to-place (dropAt), the other three
// are discarded when the strip closes. `sketchPad` above still tracks the
// hidden generator node (padNodeId) and its anchor/prompt/seed for re-roll
// and teardown — only what happens to its OUTPUT changed.
const sketchReview = reactive<{ open: boolean, images: string[], selected: number | null, error: boolean }>(
  { open: false, images: [], selected: null, error: false },
)
// True while a re-roll's run is in flight (Keep/Re-roll disabled) — separate
// from `sketchReview` itself since the strip's own busy/idle-ness isn't part
// of the shape Task 4's live pass verifies.
const sketchReviewBusy = ref(false)

// Dock the review strip directly above the REAL bottom-centre bar stack
// (prompt bar + floating toolbar, layouts/default.vue) instead of a static
// `bottom-*` guess — that stack's height is dynamic (the agent prompt bar
// grows upward when it has a result panel open), so a fixed offset drifts
// out of alignment or overlaps it. Measured live via the stack's testid and
// re-measured on resize/content-growth while the strip is open.
const SKETCH_STRIP_GAP = 12
const SKETCH_STRIP_FALLBACK_BOTTOM = 112 // pre-measurement / no-match fallback (old bottom-28 estimate)
const sketchStripDockStyle = ref<{ bottom: string, left: string, width: string, transform: string }>({
  bottom: `${SKETCH_STRIP_FALLBACK_BOTTOM}px`, left: '50%', width: '400px', transform: 'translateX(-50%)',
})
function updateSketchStripDock(): void {
  const bar = document.querySelector('[data-testid="canvas-bottom-bar-stack"]') as HTMLElement | null
  const rect = bar?.getBoundingClientRect()
  if (!rect || !rect.width) return // no match yet — keep last-known/fallback position
  sketchStripDockStyle.value = {
    bottom: `${Math.max(0, window.innerHeight - rect.top + SKETCH_STRIP_GAP)}px`,
    left: `${rect.left + rect.width / 2}px`,
    width: `${rect.width}px`,
    transform: 'translateX(-50%)',
  }
}
let sketchStripDockObserver: ResizeObserver | null = null
watch(() => sketchReview.open, (open) => {
  if (open) {
    updateSketchStripDock()
    nextTick(updateSketchStripDock) // layout may not have settled on the opening frame
    window.addEventListener('resize', updateSketchStripDock)
    const bar = document.querySelector('[data-testid="canvas-bottom-bar-stack"]')
    if (bar && typeof ResizeObserver !== 'undefined') {
      sketchStripDockObserver = new ResizeObserver(updateSketchStripDock)
      sketchStripDockObserver.observe(bar)
    }
  } else {
    window.removeEventListener('resize', updateSketchStripDock)
    sketchStripDockObserver?.disconnect()
    sketchStripDockObserver = null
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', updateSketchStripDock)
  sketchStripDockObserver?.disconnect()
})

/** Viewport center in graph coords, nudged to the nearest clear spot so the pad
 *  never covers existing cards. Reuses the AABB-nudge from the agent apply path. */
function sketchPadAnchor(): { x: number, y: number } {
  const canvasEl = document.querySelector('.vue-flow') as HTMLElement | null
  const rect = canvasEl?.getBoundingClientRect()
  const centerScreen = rect
    ? { x: rect.width / 2, y: rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const c = project(centerScreen)
  const PILE_W = 220, PILE_H = 190
  // Center the pile on the viewport centre.
  let p = { x: c.x - PILE_W / 2, y: c.y - PILE_H / 2 }
  const PAD_W = PILE_W + 80, PAD_H = PILE_H + 80
  const occupied = (q: { x: number, y: number }) => (nodes.value as any[]).some((n: any) => {
    const pr = n?.data?.properties
    if (pr?.sketchPad || pr?.sketchWarm || pr?.sketchSink || pr?.[SKETCH_PROP]) return false
    const nx = n.position?.x ?? 0, ny = n.position?.y ?? 0
    return Math.abs(nx - q.x) < PAD_W && Math.abs(ny - q.y) < PAD_H
  })
  let guard = 0
  while (occupied(p) && guard++ < 40) p = { x: p.x + PILE_W + 40, y: p.y }
  return p
}

// Re-track the screen-space agent overlays (blueprint rings + glimm) to their
// cards whenever the canvas pans/zooms — otherwise they'd stay pinned to the
// screen while the nodes move under them.
watch(vfViewport, () => {
  if (hoverNodeIds.value.length) hoverRects.value = cardRects(hoverNodeIds.value)
  if (!overlayNodeIds.value.length) return
  const rects = cardRects(overlayNodeIds.value)
  if (!rects.length) return
  if (blueprintRects.value.length) blueprintRects.value = rects
  if (glimmBurst.value) glimmBurst.value = unionRect(rects)
}, { deep: true })

// Selection helpers — Vue Flow marks selected nodes with `selected: true`.
function getSelectedNodeIds(): string[] {
  return (nodes.value as any[]).filter(n => n.selected).map(n => n.id)
}
// Reactive "first selected node" for the right-hand NodeInspector to bind to.
// Exposed so the layout can render the inspector against the live node object;
// edits to node.data.widgetsValues flow straight back into the graph.
const selectedNode = computed(() => (nodes.value as any[]).find(n => n.selected) || null)
// Make a single node the selection (used by the per-node inspector button so the
// inspector binds to it). Vue Flow renders `selected` straight from the node.
function selectNode(id: string) {
  for (const n of nodes.value as any[]) n.selected = String(n.id) === String(id)
}
function getSelectedEdgeIds(): string[] {
  return (edges.value as any[]).filter(e => e.selected).map(e => e.id)
}

const nodeClipboard = useNodeClipboard()

// Undo / redo — snapshots nodes+edges on a short debounce. The `isRestoring`
// guard prevents the watcher from snapshotting our own programmatic restore.
const history = useCanvasHistory()
let isRestoringHistory = false
let snapshotTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSnapshot() {
  if (isRestoringHistory) return
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    history.snapshot({ nodes: nodes.value as any[], edges: edges.value as any[] })
  }, 350)
}

// Deep, because a widget edit mutates a node's `data` in place: only a deep
// watch sees it, and every edit must reach undo-history + autosave.
//
// Deep is also expensive: Vue re-traverses (and re-tracks) every reactive
// property of every node's `data` — and, through each edge's
// `sourceNode`/`targetNode` back-references, the graph again — on every
// change. Measured on a 6-8 node graph: ~30 ms per pointer move with no edges,
// ~250 ms with them. A node drag fires one change per pointer move, so we hold
// this watch paused for the drag (see `onNodeDragStart`) and resume at drop —
// `resume()` re-runs the callback once if anything changed while paused, which
// is exactly the one snapshot + one dirty signal a drag should produce.
const graphWatch = watch([nodes, edges], () => {
  scheduleSnapshot()
  // Signal the layout that the canvas changed — it debounces this into a
  // continuous autosave (sessionStorage + durable mirror). Fired from the same
  // deep watch as undo-history so the two "something changed" notions can't drift.
  // Skipped while a workflow prop is being applied: programmatic application is
  // not a user edit, and dirtying here re-arms the autosave right after load —
  // which is how a just-loaded stale doc got mirrored over the durable copy.
  if (!applyingWorkflow.value) window.dispatchEvent(new CustomEvent('sailor:canvasDirty'))
}, { deep: true })

// Sync node `hidden` flag with collapsed-group membership. Vue Flow honors
// `hidden: true` by removing the node from layout AND auto-hiding any edges
// that touch it, which is exactly what we want when a group folds.
//
// We diff before assigning so we don't trigger an unnecessary update on every
// tick — the watch is deep on `groups` (collapse toggles) and `nodes`
// (positions change → membership can change).
watch(
  [groups, () => (nodes.value as any[]).map(n => `${n.id}:${n.position.x},${n.position.y}`).join('|')],
  () => {
    const hidden = hiddenNodeIdsByGroups()
    for (const n of nodes.value as any[]) {
      // Sketch pad / hidden sink / speculative-warm nodes own their own `hidden`
      // flag (they must stay hidden regardless of group membership). Skipping
      // them here stops this watcher from clobbering `hidden` back to false.
      const p = n?.data?.properties
      if (p?.sketchPad || p?.sketchWarm || p?.sketchSink) continue
      const shouldHide = hidden.has(n.id)
      if (!!n.hidden !== shouldHide) n.hidden = shouldHide
    }
  },
  { deep: true, immediate: true },
)

// Memoized member counts for collapsed groups so we don't re-walk all nodes
// from inside the template on every render.
const groupMemberCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {}
  for (const g of groups.value) {
    counts[g.id] = nodesInGroup(g.id).length
  }
  return counts
})

// Set of collapsed group IDs for cheap membership checks during render.
const collapsedGroupIds = computed<Set<string>>(() => {
  const s = new Set<string>()
  for (const g of groups.value) if (g.collapsed) s.add(g.id)
  return s
})

// Annotations to render: skip non-arrow annotations whose attached group is
// currently collapsed (so they vanish along with their group's contents).
// Arrows handle this implicitly via endpoint resolution — a collapsed group
// still has coordinates, so arrows continue to render to the pill.
const visibleAnnotations = computed(() => {
  return annotations.value.filter(a => {
    if (a.kind === 'arrow') return true
    if (!a.attachedToGroup) return true
    return !collapsedGroupIds.value.has(a.attachedToGroup)
  })
})

// AABB-style hit test: is a point inside any group's rect? Returns the
// containing group's id, preferring the LAST one in the array (top of z-order).
function groupAtPoint(x: number, y: number): string | null {
  for (let i = groups.value.length - 1; i >= 0; i--) {
    const g = groups.value[i]!
    // Use expanded bounds for collapsed groups so an annotation dragged onto
    // the pill still recognizes the underlying group as a drop target.
    const w = g.collapsed ? (g.expandedSize?.width ?? g.width) : g.width
    const h = g.collapsed ? (g.expandedSize?.height ?? g.height) : g.height
    if (x >= g.x && x <= g.x + w && y >= g.y && y <= g.y + h) return g.id
  }
  return null
}

/**
 * Wrap moveAnnotation so that, after the move, we check whether the
 * annotation's new center lies inside a group. If yes, attach it. If it
 * moved OUT of its previously-attached group's bounds, detach.
 *
 * This gives FigJam-like behavior: drop a sticky onto a frame and it
 * "belongs" to the frame, including moving and hiding with it.
 */
function moveAnnotationWithAttach(id: string, dx: number, dy: number) {
  moveAnnotation(id, dx, dy)
  const a = annotations.value.find(x => x.id === id)
  if (!a || a.kind === 'arrow') return
  const cx = a.x + a.width / 2
  const cy = a.y + a.height / 2
  const containing = groupAtPoint(cx, cy)
  if (containing && a.attachedToGroup !== containing) {
    setGroupAttachment(id, containing)
  } else if (!containing && a.attachedToGroup) {
    setGroupAttachment(id, null)
  }
}

// ---- Arrow rendering + creation -------------------------------------------
//
// Arrow endpoints reference groups, annotations, or free points. We resolve
// each to a graph-space (x, y) and pass the list to ArrowsLayer. Resolution
// runs reactively so endpoints follow their referenced object on drag.

function resolveEndpoint(ep: ArrowEndpoint): { x: number; y: number } | null {
  if (ep.kind === 'point') return { x: ep.x, y: ep.y }
  if (ep.kind === 'group') {
    const g = groups.value.find(g => g.id === ep.id)
    if (!g) return null
    // Anchor on the title-bar center — it's the only consistent attach point
    // whether the group is collapsed (pill) or expanded.
    return { x: g.x + g.width / 2, y: g.y + 14 }
  }
  if (ep.kind === 'annotation') {
    const a = annotations.value.find(a => a.id === ep.id)
    if (!a || a.kind === 'arrow') return null
    return { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  }
  return null
}

const resolvedArrows = computed<ResolvedArrow[]>(() => {
  const out: ResolvedArrow[] = []
  for (const a of annotations.value) {
    if (a.kind !== 'arrow') continue
    const from = resolveEndpoint(a.from)
    const to = resolveEndpoint(a.to)
    // Drop arrows with a dangling endpoint — they'd render at (0,0) otherwise.
    // The composable's remove paths already clean these up, but this is a
    // belt-and-suspenders guard against half-loaded state.
    if (!from || !to) continue
    out.push({
      id: a.id,
      fromX: from.x, fromY: from.y,
      toX: to.x, toY: to.y,
      label: a.label,
      color: a.color ?? '#a78bfa',
      curveOffset: a.curveOffset ?? 0,
      thickness: a.thickness ?? 2.5,
      source: a,
    })
  }
  return out
})

// Pending arrow: when set, the next click on a pane / group / annotation
// resolves the `to` endpoint and commits the arrow. ESC cancels.
const pendingArrowFrom = ref<ArrowEndpoint | null>(null)
const pendingArrowCursor = ref<{ x: number; y: number } | null>(null)

function beginArrowFromGroup(groupId: string) {
  pendingArrowFrom.value = { kind: 'group', id: groupId }
  pendingArrowCursor.value = null
}

function beginArrowFromPoint(x: number, y: number) {
  pendingArrowFrom.value = { kind: 'point', x, y }
  pendingArrowCursor.value = { x, y }
}

function cancelPendingArrow() {
  pendingArrowFrom.value = null
  pendingArrowCursor.value = null
}

function completePendingArrow(to: ArrowEndpoint) {
  if (!pendingArrowFrom.value) return
  // Don't draw an arrow to the same endpoint it came from.
  const from = pendingArrowFrom.value
  const sameGroup = from.kind === 'group' && to.kind === 'group' && from.id === to.id
  const sameAnno = from.kind === 'annotation' && to.kind === 'annotation' && from.id === to.id
  if (sameGroup || sameAnno) { cancelPendingArrow(); return }
  createArrow({ from, to })
  cancelPendingArrow()
}

// Live preview of the pending arrow — follows the mouse until the user clicks
// the second endpoint. Rendered as a faint extra entry in resolvedArrows.
const previewArrow = computed<ResolvedArrow | null>(() => {
  if (!pendingArrowFrom.value || !pendingArrowCursor.value) return null
  const from = resolveEndpoint(pendingArrowFrom.value)
  if (!from) return null
  return {
    id: '__pending__',
    fromX: from.x, fromY: from.y,
    toX: pendingArrowCursor.value.x, toY: pendingArrowCursor.value.y,
    color: '#a78bfa',
    curveOffset: 0,
    thickness: 2.5,
    source: { id: '__pending__', kind: 'arrow', from: pendingArrowFrom.value, to: { kind: 'point', x: 0, y: 0 } },
  }
})

const allRenderedArrows = computed<ResolvedArrow[]>(() => {
  if (previewArrow.value) return [...resolvedArrows.value, previewArrow.value]
  return resolvedArrows.value
})

// ---- Arrow selection + editing -------------------------------------------

const selectedArrowId = ref<string | null>(null)

function selectArrow(id: string) {
  selectedArrowId.value = id
  selectedStickyId.value = null
}
function clearArrowSelection() {
  selectedArrowId.value = null
}

// ---- Sticky selection ------------------------------------------------------
// One sticky at a time, mirroring arrows: press selects, empty-canvas click /
// Escape clears, Delete removes (never while typing in the note).
const selectedStickyId = ref<string | null>(null)
function selectSticky(id: string) {
  selectedStickyId.value = id
  selectedArrowId.value = null
}
function clearStickySelection() {
  selectedStickyId.value = null
}
function deleteSelectedSticky() {
  if (!selectedStickyId.value) return
  removeAnnotation(selectedStickyId.value)
  selectedStickyId.value = null
}

// Endpoint drag from ArrowsLayer: handle is reporting graph-space coords.
// We convert the endpoint to a free point (detaching from any group/annotation
// it was anchored to). The user can always redraw to re-anchor.
function onArrowEndpointDrag(id: string, which: 'from' | 'to', x: number, y: number) {
  const arrow = annotations.value.find(a => a.id === id && a.kind === 'arrow')
  if (!arrow) return
  const next = { kind: 'point' as const, x, y }
  if (which === 'from') updateAnnotation(id, { from: next } as any)
  else updateAnnotation(id, { to: next } as any)
}

// Curve handle drag: compute perpendicular offset from the from→to line and
// store it. The arrow path automatically picks up the new curve.
function onArrowCurveDrag(id: string, x: number, y: number) {
  const arrow = annotations.value.find(a => a.id === id && a.kind === 'arrow') as
    Extract<typeof annotations.value[number], { kind: 'arrow' }> | undefined
  if (!arrow) return
  const from = resolveEndpoint(arrow.from)
  const to = resolveEndpoint(arrow.to)
  if (!from || !to) return
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist < 1) return
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const perpX = -dy / dist
  const perpY = dx / dist
  // Scalar projection of (drag - mid) onto the perpendicular axis.
  const offset = (x - mx) * perpX + (y - my) * perpY
  updateAnnotation(id, { curveOffset: offset } as any)
}

// Inline style toolbar position — placed above the selected arrow's curve
// midpoint, in screen coordinates (so it doesn't scale with zoom, stays
// readable). Returns null when there's no selection.
const selectedArrowToolbarPos = computed<{ left: number; top: number; color: string; thickness: number } | null>(() => {
  if (!selectedArrowId.value) return null
  const a = resolvedArrows.value.find(x => x.id === selectedArrowId.value)
  if (!a) return null
  // Curve midpoint in graph space, then transform to screen.
  const dx = a.toX - a.fromX
  const dy = a.toY - a.fromY
  const dist = Math.hypot(dx, dy) || 1
  const mx = (a.fromX + a.toX) / 2
  const my = (a.fromY + a.toY) / 2
  const px = -dy / dist
  const py = dx / dist
  const cx = mx + px * a.curveOffset
  const cy = my + py * a.curveOffset
  const zoom = vfViewport.value.zoom || 1
  const screenX = cx * zoom + vfViewport.value.x
  const screenY = cy * zoom + vfViewport.value.y
  return { left: screenX, top: screenY - 44, color: a.color, thickness: a.thickness }
})

const ARROW_PALETTE = ['#a78bfa', '#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#f87171', '#94a3b8', '#ffffff']
const ARROW_THICKNESSES = [1.5, 2.5, 4]

function setSelectedArrowColor(c: string) {
  if (!selectedArrowId.value) return
  updateAnnotation(selectedArrowId.value, { color: c } as any)
}
function setSelectedArrowThickness(t: number) {
  if (!selectedArrowId.value) return
  updateAnnotation(selectedArrowId.value, { thickness: t } as any)
}
function editSelectedArrowLabel() {
  if (!selectedArrowId.value) return
  const arrow = annotations.value.find(a => a.id === selectedArrowId.value && a.kind === 'arrow') as any
  const next = window.prompt('Arrow label', arrow?.label || '')
  if (next !== null) updateAnnotation(selectedArrowId.value, { label: next.trim() || undefined } as any)
}
function deleteSelectedArrow() {
  if (!selectedArrowId.value) return
  removeAnnotation(selectedArrowId.value)
  selectedArrowId.value = null
}

// Global keyboard: ESC cancels pending arrow; S/C/A spawn annotations at
// the cursor (or viewport center if cursor unknown); F drops a Frame at the
// viewport center. All shortcuts bail when
// focus is on a text input so they don't intercept typing in node widgets.
let lastMouseClient: { x: number; y: number } | null = null
function trackMouseClient(e: MouseEvent) { lastMouseClient = { x: e.clientX, y: e.clientY } }

function isTypingTarget(): boolean {
  const ae = document.activeElement
  if (!(ae instanceof Element)) return false
  return !!(ae.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    || ae.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

function onGlobalKey(e: KeyboardEvent) {
  // ESC: cancel pending arrow first, then clear arrow selection if any.
  if (e.key === 'Escape') {
    if (pendingArrowFrom.value) {
      cancelPendingArrow()
      e.preventDefault()
      return
    }
    if (selectedArrowId.value) {
      clearArrowSelection()
      e.preventDefault()
      return
    }
    if (selectedStickyId.value && !isTypingTarget()) {
      clearStickySelection()
      e.preventDefault()
      return
    }
  }
  // Delete / Backspace removes the selected arrow / sticky. Skip when typing
  // so we don't eat text-editing keystrokes.
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedArrowId.value && !isTypingTarget()) {
    deleteSelectedArrow()
    e.preventDefault()
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedStickyId.value && !isTypingTarget()) {
    deleteSelectedSticky()
    e.preventDefault()
    return
  }
  // Cmd/Ctrl+C copies the selected node(s). Guarded so real text copy in
  // fields (and copying a text selection) still works.
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'c' || e.key === 'C') && !isTypingTarget() && !hasTextSelection()) {
    if (copySelection()) e.preventDefault()
    return
  }
  // NOTE: Cmd/Ctrl+V is deliberately NOT handled here. Node paste lives in
  // handlePaste (the native `paste` event) so that an OS-clipboard image — a
  // pasted screenshot — always takes priority over a stale node in the in-app
  // copy buffer. Calling preventDefault() on the keydown here would suppress
  // the paste event entirely and block image paste (see handlePaste).
  // The rest are creation shortcuts — skip when typing or when modifier keys
  // are held (Cmd/Ctrl combos belong to undo/redo etc.).
  if (isTypingTarget()) return
  if (e.metaKey || e.ctrlKey || e.altKey) return

  // Spawn at cursor location, or viewport center if we haven't seen a mouse
  // event yet this session.
  const screen = lastMouseClient ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const spawn = project(screen)

  if (e.key === 's' || e.key === 'S') {
    createSticky({ x: spawn.x, y: spawn.y })
    e.preventDefault()
  } else if (e.key === 'c' || e.key === 'C') {
    createChecklist({ x: spawn.x, y: spawn.y })
    e.preventDefault()
  } else if (e.key === 'a' || e.key === 'A') {
    beginArrowFromPoint(spawn.x, spawn.y)
    e.preventDefault()
  } else if (e.key === 'f' || e.key === 'F') {
    void createFrameAtCenter()
    e.preventDefault()
  }
}

// F: drop a Frame (Compositor) on the canvas, selected and ready to edit.
// Minted through `createNodeData` — the same path Add ▸ Frame and
// `combineIntoFrame` use — so the node shape is identical. Placement is caller-
// chosen: the F key drops it at the viewport centre (the placement users already
// know from Add ▸ Frame); the pane context menu drops it where the user
// right-clicked. Drag-out framing is deliberately not built here.
async function createFrameAt(pos: { x: number; y: number }) {
  if (!objectInfo.value['Compositor']) await fetchObjectInfo()
  if (!objectInfo.value['Compositor']) {
    toast.error('Couldn’t add a Frame', { description: 'The Compositor node isn’t available — is ComfyUI running?' })
    return
  }
  const frame = createNodeData('Compositor', { x: pos.x, y: pos.y })
  nodes.value.push(frame as any)
  selectNode(frame.id)
}
function createFrameAtCenter() {
  return createFrameAt(project({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
}
onMounted(() => {
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('mousemove', trackMouseClient)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('mousemove', trackMouseClient)
})

async function applyHistoryState(state: { nodes: any[], edges: any[] } | null) {
  if (!state) return
  isRestoringHistory = true
  // Splice in place so Vue Flow's reactivity picks up the change cleanly.
  nodes.value.splice(0, nodes.value.length, ...state.nodes)
  edges.value.splice(0, edges.value.length, ...state.edges)
  await nextTick()
  // Give the debounced snapshot a beat to skip, then release the guard.
  setTimeout(() => { isRestoringHistory = false }, 50)
}

function handleHistoryKey(e: KeyboardEvent) {
  const isUndo = (e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey
  const isRedo = (e.metaKey || e.ctrlKey) && ((e.key === 'Z' && e.shiftKey) || e.key === 'y')
  if (!isUndo && !isRedo) return

  // Don't hijack undo inside text inputs — native input-undo is more useful there.
  const ae = document.activeElement
  if (ae instanceof Element
    && (ae.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
      || ae.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))) {
    return
  }
  e.preventDefault()
  applyHistoryState(isUndo ? history.undo() : history.redo())
}

// Tool mode: select vs hand
// Vue Flow's selection box requires selectionKeyCode === true AND panOnDrag === false
const isHandMode = computed(() => props.activeTool === 'hand')
const panOnDrag = computed(() => isHandMode.value)          // hand: left-click pans; select: false
const selectionKeyCode = computed(() => isHandMode.value ? null : true) // select: enable drag-selection; hand: disable
// Additive multi-select: Shift+click (requested) PLUS the OS default (Cmd on
// mac / Ctrl on win). Vue Flow appends to the selection while ANY listed key is
// held; a key that isn't used on a given OS simply never fires. No platform
// detection needed — listing all three is harmless and covers every case.
const multiSelectionKeyCode = ['Shift', 'Meta', 'Control']

// Subgraph navigation
const { isInsideSubgraph, breadcrumbs, enterSubgraph, exitToLevel, saveCurrentSubgraph, reset: resetNav } = useSubgraphNavigation()
const rootWorkflow = ref<any>(null) // Full workflow with definitions

// ── Node factory ─────────────────────────────────────────────────────────────
// Single source of truth for building a fresh node's data from object_info.
// Used by drag-drop-from-sidebar, the node-search dialog, and wire splicing so
// they never drift (the port/widget derivation used to be copy-pasted).
/** Numeric node id that is unique against the CURRENT canvas. Date.now() alone
 *  collides when two nodes are minted in the same millisecond (e.g. Shot
 *  Director spawning a FilmShotNode and the run-path materializing its video
 *  sink) — LiteGraph then renames one on sync and the filtered run targets a
 *  ghost id ("Prompt has no outputs"). */
function mintNodeId(from = Date.now()): string {
  let id = from
  const taken = new Set((nodes.value as any[]).map(n => String(n.id)))
  while (taken.has(String(id))) id++
  return String(id)
}

function createNodeData(nodeType: string, position: { x: number, y: number }, widgetOverrides?: Record<string, unknown>, propertyOverrides?: Record<string, unknown>) {
  const info = objectInfo.value[nodeType]
  const widgetDefs = getWidgetDefs(nodeType)
  const vueFlowType = getVueFlowType(nodeType)
  const widgetsValues = widgetDefs.map((w: any) => w.default ?? null)
  if (widgetOverrides) {
    for (const [name, value] of Object.entries(widgetOverrides)) {
      const idx = widgetDefs.findIndex((w: any) => w.name === name)
      if (idx >= 0) widgetsValues[idx] = value
    }
  }
  const data = {
    id: mintNodeId(),
    type: vueFlowType,
    position,
    data: {
      nodeType,
      title: info?.display_name || nodeType,
      inputs: [
        ...Object.entries((info?.input?.required ?? {}) as Record<string, any>).map(([n, s]) => ({ n, s, optional: false })),
        ...Object.entries((info?.input?.optional ?? {}) as Record<string, any>).map(([n, s]) => ({ n, s, optional: true })),
      ]
        .filter(({ s }) => {
          const specArr = Array.isArray(s) ? s : [s]
          const type = specArr[0]
          const cfg = specArr[1] || {}
          if (Array.isArray(type)) return false
          if (cfg.forceInput) return true
          return !['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(String(type))
        })
        .map(({ n, s, optional }) => ({
          name: n,
          type: Array.isArray(s) ? String(s[0]) : String(s),
          link: null,
          optional,
        })),
      outputs: (info?.output || []).map((type: string, i: number) => ({
        name: info?.output_name?.[i] || type,
        type,
        links: null,
      })),
      widgetsValues,
      widgetDefs,
      properties: { ...(propertyOverrides || {}) },
      mode: 0,
      size: [220, 120],
      category: info?.category || '',
      outputNode: !!info?.output_node,
      priceBadge: info?.price_badge || null,
      ...(nodeType === 'ComfyGateNode' ? { paused: false, promptId: null } : {}),
    },
  } as any
  // Frontend-only Space Type node has no backend objectInfo, so `outputs` is
  // empty. Give it ONE wildcard output so the generated Image/Video artifact can
  // be wired from it (visual/provenance link only — SpaceType never executes).
  if ((nodeType === 'SpaceType' || nodeType === 'GradientStudio' || nodeType === 'ShaderStudio' || nodeType === 'TextureStudio' || nodeType === 'ShapeStudio' || nodeType === 'VectorType' || nodeType === 'ShotDirector' || nodeType === 'LipSyncStudio') && (!data.data.outputs || data.data.outputs.length === 0)) {
    data.data.outputs = [{ name: 'output', type: '*', links: null }]
  }
  // Shader Studio consumes an image — give it one input handle (input-0).
  if (nodeType === 'ShaderStudio' && (!data.data.inputs || data.data.inputs.length === 0)) {
    data.data.inputs = [{ name: 'image', type: 'IMAGE', link: null }]
  }
  // Character: frontend-only card, one CHARACTER output for casting into a Shot Director.
  if (nodeType === 'Character' && (!data.data.outputs || data.data.outputs.length === 0)) {
    data.data.outputs = [{ name: 'character', type: 'CHARACTER', links: null }]
  }
  // Reference: frontend-only @name shorthand card, one IMAGE output resolved
  // to the registry entry's filename at submit time (Task 10).
  if (nodeType === 'Reference' && (!data.data.outputs || data.data.outputs.length === 0)) {
    data.data.outputs = [{ name: 'image', type: 'IMAGE', links: null }]
  }
  // Character Sheet: optional IMAGE source input + one CHARACTER output, once
  // the sheet is expanded and saved (mirrors Character above).
  if (nodeType === 'CharacterSheet') {
    if (!data.data.inputs || data.data.inputs.length === 0) {
      data.data.inputs = [{ name: 'image', type: 'IMAGE', link: null, optional: true }]
    }
    if (!data.data.outputs || data.data.outputs.length === 0) {
      data.data.outputs = [{ name: 'character', type: 'CHARACTER', links: null }]
    }
  }
  // Shot Director: three optional CHARACTER cast slots (Task 11 syncs them into the shot sheet).
  if (nodeType === 'ShotDirector' && (!data.data.inputs || data.data.inputs.length === 0)) {
    data.data.inputs = [1, 2, 3].map(i => ({ name: `cast_${i}`, type: 'CHARACTER', link: null, optional: true }))
  }
  // Moodboard: pile card referencing a moodboard library entry, with a Python
  // twin since Plan B Task B4 (class_type 'Moodboard' compiles the style block
  // from the hidden reading_json widget). When /object_info carries the twin,
  // the generic derivation above already yields the real schema widgets
  // (hidden internal — the custom 'moodboard' face never renders them) AND the
  // TASTE `style` output; the synthesis below only fills the port in when the
  // backend hasn't been restarted yet (objectInfo lacks the twin), so the wire
  // can at least render. v1 has NO image output (deferred to @refs, Task B5).
  // Persistent state: properties.sailor_moodboard (the library reference id;
  // convertToLiteGraph's curated map drops other data.* fields) + the two
  // widgets synced by name via syncMoodboardWidgets (moodboardApply.ts).
  if (nodeType === 'Moodboard') {
    data.data.inputs = []
    if (!data.data.outputs || data.data.outputs.length === 0) {
      data.data.outputs = [{ name: 'style', type: 'TASTE', links: null }]
    }
    if (typeof data.data.properties.sailor_moodboard !== 'string') {
      data.data.properties.sailor_moodboard = ''
    }
  }
  // Collection: frontend-only data-table node, one VARS output for wiring
  // rows/columns of named variables into a Smart Layout (or other consumer).
  if (nodeType === 'Collection' && (!data.data.outputs || data.data.outputs.length === 0)) {
    data.data.outputs = [{ name: 'vars', type: VARS_TYPE, links: null }]
  }
  // Collection: optional lookup-in target so another Collection's VARS output
  // can wire in and become a lookup table (LOOKUP edge, detected in onConnect).
  if (nodeType === 'Collection' && (!data.data.inputs || data.data.inputs.length === 0)) {
    data.data.inputs = [{ name: 'lookup', type: VARS_TYPE, link: null, optional: true }]
  }
  // Smart Layout: optional VARS input so a Collection's output can wire in
  // (applies to every created node — no-op for anything but SmartLayout).
  ensureVarsInput(data)
  return data
}

// ── Wire splicing ────────────────────────────────────────────────────────────
// Insert a node between two already-connected nodes (drop-on-wire, edge "+"),
// or after a node across all its matching output edges (artifact effect actions).
// Type rules live in utils/portTypes (exact → union/wildcard, never index 0):
// the old "no compatible port → fall back to slot 0" is what wired a
// Timeline's IMAGE `frames` output into SaveVideo's VIDEO-only input.
function outputHandleFor(node: any, wantType?: string): string | null {
  const idx = findCompatiblePortIndex(node?.data?.outputs, wantType || '*')
  return idx >= 0 ? `output-${idx}` : null
}
/** True when no live edge feeds this input slot (saved link refs count too). */
function inputSlotFree(node: any, idx: number): boolean {
  if (node?.data?.inputs?.[idx]?.link != null) return false
  return !(edges.value as any[]).some(
    (e) => e.target === node.id && e.targetHandle === `input-${idx}`,
  )
}
function inputHandleFor(node: any, wantType?: string): string | null {
  const idx = findCompatiblePortIndex(
    node?.data?.inputs,
    wantType || '*',
    (i) => inputSlotFree(node, i),
  )
  return idx >= 0 ? `input-${idx}` : null
}
function typeOfOutputHandle(node: any, handle?: string | null): string {
  const i = parseInt(String(handle ?? '').replace('output-', '') || '0')
  return node?.data?.outputs?.[i]?.type ?? '*'
}
function typeOfInputHandle(node: any, handle?: string | null): string {
  const i = parseInt(String(handle ?? '').replace('input-', '') || '0')
  return node?.data?.inputs?.[i]?.type ?? '*'
}

/** Splice a new node into an existing edge: A→B becomes A→New→B. */
async function spliceIntoEdge(edgeId: string, nodeType: string, widgetOverrides?: Record<string, unknown>) {
  const edge = (edges.value as any[]).find(e => e.id === edgeId)
  if (!edge) return
  if (!objectInfo.value[nodeType]) await fetchObjectInfo()
  const src = (nodes.value as any[]).find(n => n.id === edge.source)
  const tgt = (nodes.value as any[]).find(n => n.id === edge.target)
  if (!src || !tgt) return
  const srcOutType = typeOfOutputHandle(src, edge.sourceHandle)
  const tgtInType = typeOfInputHandle(tgt, edge.targetHandle)
  const pos = {
    x: ((src.position?.x ?? 0) + (tgt.position?.x ?? 0)) / 2 - 110,
    y: ((src.position?.y ?? 0) + (tgt.position?.y ?? 0)) / 2,
  }
  const node = createNodeData(nodeType, pos, widgetOverrides)
  const inHandle = inputHandleFor(node, srcOutType)
  const outHandle = outputHandleFor(node, tgtInType)
  nodes.value.push(node)
  // Wait for VueFlow to register the new node (and mount its handles) before
  // wiring edges to it — otherwise edges referencing it are pruned as invalid.
  await nextTick()
  if (inHandle && outHandle) {
    removeEdges([edgeId])
    addEdges([
      { source: edge.source, sourceHandle: edge.sourceHandle, target: node.id, targetHandle: inHandle, type: 'comfy', data: { dataType: srcOutType } },
      { source: node.id, sourceHandle: outHandle, target: edge.target, targetHandle: edge.targetHandle, type: 'comfy', data: { dataType: tgtInType } },
    ])
    return
  }
  // The node can't sit INSIDE this wire (no type-compatible in/out pair —
  // e.g. SaveVideo dropped on a Timeline frames→X IMAGE wire: SaveVideo has
  // no IMAGE input). Never force slot 0: that poisons the graph with an
  // IMAGE→VIDEO link the backend rejects at run time. Instead, keep the
  // original edge and tap the node off ANY compatible output of the wire's
  // source (exact type first) — the Timeline case lands on `video` (VIDEO).
  const pair = bestPortPair(src.data?.outputs, node.data?.inputs)
  if (pair) {
    const dataType = String(src.data?.outputs?.[pair.outputIndex]?.type ?? '*')
    addEdges([
      { source: edge.source, sourceHandle: `output-${pair.outputIndex}`, target: node.id, targetHandle: `input-${pair.inputIndex}`, type: 'comfy', data: { dataType } },
    ])
  }
  // No compatible pair at all → leave the node placed but unwired.
}

/** Apply a transform after a node: feed it from the node and re-point every
 *  existing matching-type output edge through it (used by artifact-card actions
 *  like "Remove background"). If nothing was downstream, it's just appended.
 *  opts.branch = tap the output WITHOUT re-pointing downstream (escalator
 *  actions like Upscale/Relight: they produce a new deliverable — silently
 *  inserting a paid node into the existing chain would re-bill on every
 *  later run of that chain). Branches offset down so they don't overlap. */
async function spliceAfterNode(nodeId: string, nodeType: string, outType = 'IMAGE', widgetOverrides?: Record<string, unknown>, opts: { branch?: boolean } = {}): Promise<string | null> {
  if (!objectInfo.value[nodeType]) await fetchObjectInfo()
  if (!objectInfo.value[nodeType]) {
    toast.error(`${nodeType} isn't available`, { description: 'Is the ComfyUI backend running with the latest nodes? Restart it and try again.' })
    return null
  }
  const src = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!src) return null
  const hasDownstream = (edges.value as any[]).some(e => e.source === nodeId)
  const pos = {
    x: (src.position?.x ?? 0) + 360,
    y: (src.position?.y ?? 0) + (opts.branch && hasDownstream ? 230 : 0),
  }
  const node = createNodeData(nodeType, pos, widgetOverrides)
  const srcOutHandle = outputHandleFor(src, outType)
  const inHandle = inputHandleFor(node, outType)
  const outHandle = outputHandleFor(node, outType)
  nodes.value.push(node)
  // Wait for VueFlow to register the new node before wiring edges to it.
  await nextTick()
  // No type-compatible feed → just place the node; wiring slot 0 regardless
  // of type would create a link the backend rejects at run time.
  if (!srcOutHandle || !inHandle) return node.id
  const downstream = (edges.value as any[]).filter(e => e.source === nodeId && e.sourceHandle === srcOutHandle)
  const newEdges: any[] = [
    { source: nodeId, sourceHandle: srcOutHandle, target: node.id, targetHandle: inHandle, type: 'comfy', data: { dataType: outType } },
  ]
  // Re-point downstream consumers through the new node only when it has a
  // matching output to hand them; otherwise leave them on the source.
  // Branch mode: never re-point — the existing chain must keep running
  // (and billing) exactly as before.
  if (outHandle && !opts.branch) {
    for (const e of downstream) {
      newEdges.push({ source: node.id, sourceHandle: outHandle, target: e.target, targetHandle: e.targetHandle, type: 'comfy', data: { dataType: outType } })
    }
    if (downstream.length) removeEdges(downstream.map((e: any) => e.id))
  }
  addEdges(newEdges)
  return node.id
}

/** Can this node be spliced into this edge? (compatible in/out ports, and the
 *  node isn't already an endpoint of the edge.) Shared by the splice action and
 *  the drag-over highlight so the highlight always reflects a real drop target. */
function canNodeSpliceEdge(node: any, edge: any): boolean {
  if (!node || !edge || edge.source === node.id || edge.target === node.id) return false
  const src = (nodes.value as any[]).find(n => n.id === edge.source)
  const tgt = (nodes.value as any[]).find(n => n.id === edge.target)
  if (!src || !tgt) return false
  const srcOutType = typeOfOutputHandle(src, edge.sourceHandle)
  const tgtInType = typeOfInputHandle(tgt, edge.targetHandle)
  const hasIn = (node.data?.inputs ?? []).some((i: any) => typesCompatible(i.type, srcOutType))
  const hasOut = (node.data?.outputs ?? []).some((o: any) => typesCompatible(o.type, tgtInType))
  return hasIn && hasOut
}

/** Splice an EXISTING (already-placed) node into an edge it was dragged onto. */
function spliceExistingNodeIntoEdge(nodeId: string, edgeId: string) {
  const edge = (edges.value as any[]).find(e => e.id === edgeId)
  const node = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!edge || !node || !canNodeSpliceEdge(node, edge)) return
  const src = (nodes.value as any[]).find(n => n.id === edge.source)
  const tgt = (nodes.value as any[]).find(n => n.id === edge.target)
  const srcOutType = typeOfOutputHandle(src, edge.sourceHandle)
  const tgtInType = typeOfInputHandle(tgt, edge.targetHandle)
  const inHandle = inputHandleFor(node, srcOutType)
  const outHandle = outputHandleFor(node, tgtInType)
  if (!inHandle || !outHandle) return // canNodeSpliceEdge guarantees these; belt-and-braces
  removeEdges([edgeId])
  addEdges([
    { source: edge.source, sourceHandle: edge.sourceHandle, target: nodeId, targetHandle: inHandle, type: 'comfy', data: { dataType: srcOutType } },
    { source: nodeId, sourceHandle: outHandle, target: edge.target, targetHandle: edge.targetHandle, type: 'comfy', data: { dataType: tgtInType } },
  ])
}

// Find a spliceable wire under a dragged (fully-unconnected) node, or null.
function spliceableEdgeUnderNode(node: any, event: any): string | null {
  if (!node?.id) return null
  const connected = (edges.value as any[]).some(e => e.source === node.id || e.target === node.id)
  if (connected) return null
  const x = (event as MouseEvent)?.clientX, y = (event as MouseEvent)?.clientY
  if (x == null || y == null) return null
  // elementsFromPoint sees through the dragged node to any wire beneath it.
  for (const el of (document.elementsFromPoint(x, y) as HTMLElement[])) {
    const id = el.closest?.('[data-edge-id]')?.getAttribute('data-edge-id')
    if (!id) continue
    const edge = (edges.value as any[]).find(e => e.id === id)
    if (edge && canNodeSpliceEdge(node, edge)) return id
  }
  return null
}

// A node drag only ever moves positions, and the graph deep-watch above is the
// most expensive listener on the canvas (~30 ms per pointer move on a bare node
// set, ~250 ms once edges are wired, because a deep traversal of `edges` walks
// their `sourceNode`/`targetNode` back-references into the whole graph). So we
// hold it paused for the duration of the drag and resume at the end: `resume()`
// re-evaluates the source once and runs the callback if anything changed, so the
// drag still yields exactly one history snapshot and one `sailor:canvasDirty`.
let graphWatchPausedForDrag = false
function pauseGraphWatchForDrag() {
  if (graphWatchPausedForDrag) return
  graphWatchPausedForDrag = true
  graphWatch.pause()
}
function resumeGraphWatchAfterDrag() {
  if (!graphWatchPausedForDrag) return
  graphWatchPausedForDrag = false
  graphWatch.resume()
}
onNodeDragStart(() => pauseGraphWatchForDrag())

// Vue Flow emits `nodeDragStop` from d3-drag's `end`, and d3's listeners are torn
// down if the dragged node's element unmounts mid-drag (or the pointer is lost to
// another window) — in which case `end`, and so `nodeDragStop`, never arrives. A
// paused watch would then swallow every later edit, so a pointer release or a
// window blur resumes it too. Both are no-ops when nothing is paused.
onMounted(() => {
  window.addEventListener('pointerup', resumeGraphWatchAfterDrag)
  window.addEventListener('pointercancel', resumeGraphWatchAfterDrag)
  window.addEventListener('blur', resumeGraphWatchAfterDrag)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerup', resumeGraphWatchAfterDrag)
  window.removeEventListener('pointercancel', resumeGraphWatchAfterDrag)
  window.removeEventListener('blur', resumeGraphWatchAfterDrag)
})

// Live highlight while dragging an unconnected node over a compatible wire.
onNodeDrag(({ event, node }) => {
  dragOverEdgeId.value = spliceableEdgeUnderNode(node, event)
})

// Dropping a fully-unconnected node onto a compatible wire splices it in.
onNodeDragStop(({ event, node }) => {
  resumeGraphWatchAfterDrag()
  const id = spliceableEdgeUnderNode(node, event)
  dragOverEdgeId.value = null
  if (id) spliceExistingNodeIntoEdge(node.id, id)
})

// Edge currently under the cursor during a node drag → drop splices into it.
const dragOverEdgeId = ref<string | null>(null)
provide('spliceDragEdgeId', dragOverEdgeId)
// Edge the "+" affordance targeted → the next node-search pick splices into it.
let pendingSpliceEdgeId: string | null = null
const { openNodeSearch } = useNodeSearch()

function handleCanvasDragOver(event: DragEvent) {
  event.preventDefault()
  const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
  const edgeEl = el?.closest('[data-edge-id]') as HTMLElement | null
  dragOverEdgeId.value = edgeEl?.getAttribute('data-edge-id') ?? null
}

function handleEdgeInsert(e: Event) {
  const { edgeId } = (e as CustomEvent).detail || {}
  if (!edgeId) return
  pendingSpliceEdgeId = String(edgeId)
  openNodeSearch()
}

async function handleApplyEffect(e: Event) {
  const { nodeId, nodeType, output, widgetOverrides, run, focus, branch } = (e as CustomEvent).detail || {}
  if (!nodeId || !nodeType) return
  const newId = await spliceAfterNode(String(nodeId), String(nodeType), output || 'IMAGE', widgetOverrides, { branch: !!branch })
  if (!newId) return
  if (focus) {
    // Bring the freshly spawned node into view so the user can aim it before running.
    fitView({ nodes: [newId], padding: 0.5, duration: 250 })
  }
  if (run) {
    // One-tap actions (Upscale): run the new node immediately; 'self' scope
    // freezes the upstream artifact so it feeds its image instead of re-running
    // (and re-billing) the chain that produced it.
    window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
      detail: { targetIds: [newId], rerollScope: 'self' },
    }))
  }
}

// Handle node drop from sidebar
// ── Assets panel → canvas ──────────────────────────────────────────────────
// Drop (or click) a generation/import from the Assets panel to add a loader
// node for it. Images use LoadImageOutput (output folder) or LoadImage (input);
// video/audio use their matching loaders (best-effort for output media).
interface DroppedAsset { kind: 'image' | 'video' | 'audio'; filename: string; subfolder?: string; type?: string }

function assetViewUrl(a: DroppedAsset): string {
  // No cache-buster: asset-panel files are static, and this matches the panel's
  // own viewUrl() byte-for-byte so the node's preview reuses the thumbnail the
  // browser already cached — the image shows instantly instead of re-downloading.
  const p = new URLSearchParams({ filename: a.filename, type: a.type || 'output' })
  if (a.subfolder) p.set('subfolder', a.subfolder)
  return `/view?${p}`
}

// Copy an output/temp asset into the input folder so a unified artifact node
// (which loads via /upload/image → input — the endpoint is generic for image,
// video and audio) can run it natively. Input assets already live there, so just
// return their filename. This is "Option A": the artifact carries a real,
// loadable file instead of a fragile output reference.
async function ensureInputFilename(a: DroppedAsset): Promise<string> {
  if (a.type === 'input') return a.filename
  try {
    const blob = await (await fetch(assetViewUrl(a))).blob()
    const fd = new FormData()
    fd.append('image', new File([blob], a.filename, { type: blob.type || 'application/octet-stream' }))
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`copy-to-input returned ${res.status}`)
    const json = await res.json()
    return (json?.name as string) ?? a.filename
  } catch (err) {
    console.error('[asset→artifact] copy to input failed:', err)
    return a.filename // fall back; node still shows, user can re-pick
  }
}

// Each medium maps to a unified artifact node + its file-bearing widget.
const ASSET_ARTIFACT_SPEC = {
  image: { nodeType: 'Image', widget: 'image' },
  video: { nodeType: 'Video', widget: 'file' },
  audio: { nodeType: 'Audio', widget: 'audio' },
} as const

async function addAssetNodeData(a: DroppedAsset, position: { x: number, y: number }) {
  // Every medium becomes a unified artifact node that *carries* the file, rather
  // than a brittle Load* node referencing an output-folder name (the source of
  // the "shows a thumbnail but won't run" bug). Output/temp assets are copied
  // into the input folder first so the artifact loads them natively.
  const { nodeType, widget } = ASSET_ARTIFACT_SPEC[a.kind]
  if (!objectInfo.value[nodeType]) await fetchObjectInfo()
  // Input assets are already loadable; output/temp ones need copying into the input
  // folder first. Do that copy in the BACKGROUND so the node lands on the canvas
  // instantly (showing its cached preview) instead of after the upload round-trip —
  // the filename widget is filled in when the copy resolves.
  const node = createNodeData(nodeType, position, { [widget]: a.type === 'input' ? a.filename : '' }) as any
  if (a.kind === 'image') node.data.images = [assetViewUrl(a)] // instant, cache-hit preview
  if (a.type !== 'input') {
    ensureInputFilename(a).then((inputName) => {
      // Mutate the LIVE node in nodes.value (a reactive proxy), not the raw object
      // captured here — a direct mutation of the raw object wouldn't trigger Vue.
      const live = nodes.value.find((n) => n.id === node.id)
      if (!live) return
      const idx = (live.data.widgetDefs as { name: string }[]).findIndex((w) => w.name === widget)
      if (idx >= 0) live.data.widgetsValues[idx] = inputName
    }).catch((err) => console.error('[asset→artifact] background copy to input failed:', err))
  }
  return node
}

async function handleAddAssetNode(e: Event) {
  // offsetX/offsetY (optional, canvas px) cascade batched adds — e.g. the web
  // image-search import — so several nodes don't land exactly on top of each other.
  const a = (e as CustomEvent<DroppedAsset & { offsetX?: number; offsetY?: number }>).detail
  if (!a?.filename) return
  const center = project({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  nodes.value.push(await addAssetNodeData(a, { x: center.x + (a.offsetX ?? 0), y: center.y + (a.offsetY ?? 0) }))
}

async function handleDrop(event: DragEvent) {
  event.preventDefault()
  // Capture before any await: the DOM nulls currentTarget once synchronous
  // dispatch ends, so reading it after `await fetchObjectInfo()` below would
  // return null on every cache-miss drop (e.g. right after a ComfyUI restart).
  const canvasEl = event.currentTarget as HTMLElement
  // Assets panel drops carry our custom MIME type with a JSON payload.
  if (event.dataTransfer?.types.includes('application/x-sailor-asset')) {
    try {
      const a = JSON.parse(event.dataTransfer.getData('application/x-sailor-asset')) as DroppedAsset
      const rect = canvasEl.getBoundingClientRect()
      const position = project({ x: event.clientX - rect.left, y: event.clientY - rect.top })
      nodes.value.push(await addAssetNodeData(a, position))
    } catch { /* malformed payload — ignore */ }
    return
  }
  // Block library drops carry our custom MIME type; route them first since
  // the text/plain payload is just a fallback prefixed with "block:".
  if (event.dataTransfer?.types.includes('application/x-sailor-block')) {
    tryHandleBlockDrop(event)
    return
  }
  const nodeType = event.dataTransfer?.getData('text/plain')
  if (!nodeType) return
  // Defensive: ignore the text/plain fallback that block drags also emit.
  if (nodeType.startsWith('block:')) return

  // Dropped onto a wire → splice the node into that connection (A→B ⇒ A→New→B).
  // Detect the edge at drop time via elementFromPoint — the dragover-tracked id
  // can be cleared by dragenter/leave bubbling races, so this is authoritative.
  const dropEl = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
  const edgeId = dropEl?.closest('[data-edge-id]')?.getAttribute('data-edge-id') || dragOverEdgeId.value
  dragOverEdgeId.value = null
  if (edgeId) {
    await spliceIntoEdge(edgeId, nodeType)
    return
  }

  // Refresh schema if we don't know this node type — protects against the
  // common case of "ComfyUI was restarted with new nodes but the cache is
  // stale," which results in a node rendering without any ports.
  if (!objectInfo.value[nodeType]) {
    await fetchObjectInfo()
  }

  const rect = canvasEl.getBoundingClientRect()
  const position = project({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  })
  nodes.value.push(createNodeData(nodeType, position))
}

// Load workflow when prop changes (ensure object_info is ready first)
// Track the workflow identity to avoid re-processing the same object
let lastWorkflowRef: any = null
// True from "new workflow prop accepted" until the graph rebuild lands. While
// set, getWorkflow() still serializes the PREVIOUS graph — callers that
// snapshot-then-save (tab switch, canvas switch) must check isApplyingWorkflow
// first or they'd write stale content into the wrong slot.
const applyingWorkflow = ref(false)
watch(
  () => props.workflow,
  async (wf) => {
    if (!wf) return
    // Skip if we're inside a subgraph (canvas is self-managing)
    // or if the workflow object hasn't actually changed
    if (isInsideSubgraph.value || wf === lastWorkflowRef) return
    lastWorkflowRef = wf
    rootWorkflow.value = wf
    resetNav()
    applyingWorkflow.value = true
    try {
      await fetchObjectInfo()
      convertFromLiteGraph(wf, wf.definitions)
    } finally {
      applyingWorkflow.value = false
    }
    // Multi-canvas: results that landed while this canvas was off-screen, and
    // the running glow if its run is still in flight (the rebuild wiped both).
    applyPendingTakesForDisplayedCanvas()
    nextTick(() => {
      applyRunningForActiveWorker()
      fitView({ padding: 0.2 })
    })
  },
  { immediate: true },
)

// Re-apply widget defs and sync outputs if object_info loads after the initial conversion
watch(objectInfo, (info) => {
  if (!info || !Object.keys(info).length) return
  for (const n of nodes.value as any[]) {
    if (!n.data?.nodeType) continue
    const nodeInfo = info[n.data.nodeType]
    if (!nodeInfo) continue

    const updates: Record<string, any> = {}

    if (!n.data.widgetDefs?.length) {
      const defs = getWidgetDefs(n.data.nodeType)
      if (defs.length) updates.widgetDefs = defs
    }

    // Sync ports from object_info if the node has fewer than defined
    // (append-only: existing ports keep their link data and indices)
    const synced = syncNodeOutputsWithSchema(n.data.outputs, schemaOutputsFromInfo(nodeInfo))
    if (synced) updates.outputs = synced
    const syncedIn = syncNodeInputsWithSchema(n.data.inputs, schemaInputsFromInfo(nodeInfo))
    if (syncedIn) updates.inputs = syncedIn

    if (!n.data.category && nodeInfo.category) {
      updates.category = nodeInfo.category
    }
    if (!n.data.priceBadge && nodeInfo.price_badge) {
      updates.priceBadge = nodeInfo.price_badge
    }

    if (Object.keys(updates).length) {
      n.data = { ...n.data, ...updates }
    }
  }
})

// Handle new connections.
//
// Vue Flow completes a drag on the CLOSEST handle within its 20px snap
// radius, with zero type awareness — on a Timeline card the IMAGE `frames`
// and VIDEO `video` outputs sit ~25% of the card height apart, so a drop
// aimed between them routinely landed on `frames` and wired IMAGE into
// SaveVideo's VIDEO input. When the snapped pair is type-incompatible but
// the SAME node has a compatible port (exact match first, then ComfyUI
// union/wildcard rules), retarget to it: the snapped end first (that's the
// end the user was imprecise about), then the grabbed end. A mismatch with
// no compatible alternative is kept as the user made it — deliberate wiring
// stays possible, and run-time validation surfaces it (toast + red node).
onConnect((params) => {
  connectionMade = true
  const sourceNode = (nodes.value as any[]).find(n => n.id === params.source)
  const targetNode = (nodes.value as any[]).find(n => n.id === params.target)
  let sourceHandle = params.sourceHandle
  let targetHandle = params.targetHandle
  const srcType = typeOfOutputHandle(sourceNode, sourceHandle)
  const tgtType = typeOfInputHandle(targetNode, targetHandle)
  if (!typesCompatible(srcType, tgtType)) {
    const grabbedSource = connectStartInfo?.handleType === 'source'
    const fixTarget = () => {
      const fixed = inputHandleFor(targetNode, srcType)
      if (fixed) targetHandle = fixed
      return !!fixed
    }
    const fixSource = () => {
      const fixed = outputHandleFor(sourceNode, tgtType)
      if (fixed) sourceHandle = fixed
      return !!fixed
    }
    const fixed = grabbedSource ? (fixTarget() || fixSource()) : (fixSource() || fixTarget())
    if (fixed) {
      console.debug('[Sailor] retargeted snapped connection to type-compatible port:',
        { from: { sourceHandle: params.sourceHandle, targetHandle: params.targetHandle }, to: { sourceHandle, targetHandle } })
    }
  }
  const outputIndex = parseInt(sourceHandle?.replace('output-', '') || '0')
  let dataType = sourceNode?.data?.outputs?.[outputIndex]?.type || '*'
  // Collection → Collection lookup-in ⇒ a LOOKUP edge (not a VARS binding wire).
  const isLookup = sourceNode?.data?.nodeType === 'Collection'
    && targetNode?.data?.nodeType === 'Collection'
    && String(sourceNode.id) !== String(targetNode.id)
  if (isLookup) dataType = LOOKUP_TYPE
  if (sourceNode?.data?.nodeType === 'Collection' && targetNode?.data?.nodeType === 'Collection'
    && String(sourceNode.id) === String(targetNode.id)) {
    return // guard: a collection cannot look up itself
  }
  addEdges([{ ...params, sourceHandle, targetHandle, type: 'comfy', data: { dataType } }])
  if (isLookup) registerLookupLink(String(sourceNode.id), String(targetNode.id), { x: connectStartInfo?.x ?? 0, y: connectStartInfo?.y ?? 0 })
  // Applying IS wiring: a manual TASTE drag onto a generator's style_in fires
  // the same side effects as a chip apply (auto-switch + refs + chip fill —
  // minus the block write; the wire carries the block).
  maybeApplyTasteWire(sourceNode, targetNode, targetHandle)
})

// ── Port intent popover ──────────────────────────────────────────────────────
// Click a port (no drag) or drop a wire on empty canvas → intent popover with
// type-filtered search plus an "Ask AI" escalation (see docs/plans/
// 2026-06-09-port-intent-popover-design.md).
const portIntent = ref<{ anchor: PortAnchor, screen: { x: number, y: number }, dropFlow?: { x: number, y: number } } | null>(null)
const portIntentAiState = ref<'idle' | 'loading' | 'error' | 'done'>('idle')
const portIntentAiError = ref<string | null>(null)
const portIntentAiNote = ref<string | null>(null)
const { suggest: suggestPortIntent } = usePortIntent()

let connectStartInfo: { nodeId: string, handleId: string, handleType: string, x: number, y: number } | null = null
let connectionMade = false

onConnectStart(({ event, nodeId, handleId, handleType }) => {
  connectionMade = false
  const me = event as MouseEvent | undefined
  connectStartInfo = nodeId && handleId && me && 'clientX' in me
    ? { nodeId, handleId, handleType: handleType || 'source', x: me.clientX, y: me.clientY }
    : null
})

onConnectEnd((event) => {
  const start = connectStartInfo
  connectStartInfo = null
  if (!start || connectionMade) return
  const me = event as MouseEvent | undefined
  if (!me || !('clientX' in me)) return
  const anchor = anchorFromHandle(start.nodeId, start.handleId, start.handleType)
  if (!anchor) return
  const travel = Math.hypot(me.clientX - start.x, me.clientY - start.y)
  if (travel <= 6) {
    // Stationary click on the port itself.
    openPortIntent(anchor, { x: start.x + 12, y: start.y + 12 })
    return
  }
  // Wire dragged out and released on empty canvas. Vue Flow disables pointer
  // events during the drag, so the mouseup target is useless (<html>) — test
  // the release point geometrically instead: inside the canvas, not on a node.
  const canvasRect = document.querySelector('.vue-flow')?.getBoundingClientRect()
  const insideCanvas = !!canvasRect
    && me.clientX >= canvasRect.left && me.clientX <= canvasRect.right
    && me.clientY >= canvasRect.top && me.clientY <= canvasRect.bottom
  if (!insideCanvas) return
  const flow = project({ x: me.clientX, y: me.clientY })
  const overNode = (nodes.value as any[]).find((n) => {
    const w = n.dimensions?.width || n.data?.size?.[0] || 220
    const h = n.dimensions?.height || n.data?.size?.[1] || 120
    return flow.x >= n.position.x && flow.x <= n.position.x + w
      && flow.y >= n.position.y && flow.y <= n.position.y + h
  })
  if (overNode) {
    // Wire dropped on a node BODY (outside any handle's snap radius). This
    // used to be a silent dead zone — the wire vanished and users assumed it
    // connected. Complete it onto a TYPE-COMPATIBLE port of that node (exact
    // match first, then union/wildcard; free inputs preferred), never by
    // index. No compatible port → keep the old no-op.
    if (overNode.id !== anchor.nodeId) completeConnectionOnNode(anchor, overNode)
    return
  }
  openPortIntent(anchor, { x: me.clientX + 12, y: me.clientY + 12 }, flow)
})

/** Complete a wire released on a node body: pick the type-compatible port on
 *  `node` for the grabbed anchor (output anchor → node input, input anchor →
 *  node output). Does nothing when nothing on the node is compatible. */
function completeConnectionOnNode(anchor: PortAnchor, node: any) {
  if (anchor.direction === 'output') {
    const targetHandle = inputHandleFor(node, anchor.portType)
    if (!targetHandle) return
    addEdges([{
      source: anchor.nodeId, sourceHandle: `output-${anchor.portIndex}`,
      target: node.id, targetHandle,
      type: 'comfy', data: { dataType: anchor.portType },
    }])
    const srcNode = (nodes.value as any[]).find(n => n.id === anchor.nodeId)
    maybeApplyTasteWire(srcNode, node, targetHandle)
  }
  else {
    const sourceHandle = outputHandleFor(node, anchor.portType)
    if (!sourceHandle) return
    const oIdx = parseInt(sourceHandle.replace('output-', ''))
    addEdges([{
      source: node.id, sourceHandle,
      target: anchor.nodeId, targetHandle: `input-${anchor.portIndex}`,
      type: 'comfy', data: { dataType: String(node.data?.outputs?.[oIdx]?.type ?? '*') },
    }])
    const tgtNode = (nodes.value as any[]).find(n => n.id === anchor.nodeId)
    maybeApplyTasteWire(node, tgtNode, `input-${anchor.portIndex}`)
  }
}

function anchorFromHandle(nodeId: string, handleId: string, handleType: string): PortAnchor | null {
  const node = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!node) return null
  const direction = handleType === 'source' ? 'output' as const : 'input' as const
  const prefix = direction === 'output' ? 'output-' : 'input-'
  if (!handleId.startsWith(prefix)) return null
  const portIndex = parseInt(handleId.slice(prefix.length) || '0')
  const port = direction === 'output' ? node.data?.outputs?.[portIndex] : node.data?.inputs?.[portIndex]
  if (!port) return null
  return { nodeId, nodeType: node.data?.nodeType || '', portName: port.name, portType: port.type || '*', portIndex, direction }
}

function openPortIntent(anchor: PortAnchor, screen: { x: number, y: number }, dropFlow?: { x: number, y: number }) {
  portIntentAiState.value = 'idle'
  portIntentAiError.value = null
  portIntentAiNote.value = null
  portIntent.value = { anchor, screen, dropFlow }
}

/** Insert a validated AI suggestion: lay nodes out from the anchor, wire them up.
 *  The debounced history snapshot makes the whole insert one undo step. */
async function insertSuggestion(result: Awaited<ReturnType<typeof suggestPortIntent>>, anchor: PortAnchor, dropFlow?: { x: number, y: number }) {
  const anchorNode = (nodes.value as any[]).find(n => n.id === anchor.nodeId)
  const dir = anchor.direction === 'output' ? 1 : -1
  const base = dropFlow ?? {
    x: (anchorNode?.position?.x ?? 0) + dir * 360,
    y: anchorNode?.position?.y ?? 0,
  }
  const created = new Map<string, any>()
  result.nodes.forEach((sn, i) => {
    const node = createNodeData(sn.type, { x: base.x + dir * i * 360, y: base.y }, sn.widgetOverrides)
    node.id = `${Date.now()}-${i}` // createNodeData's Date.now() id collides within one tick
    node.selected = true
    created.set(sn.localId, node)
    nodes.value.push(node)
  })
  await nextTick()

  // Resolve a validated suggestion's port by name; if the name misses (model
  // drift), fall back by TYPE compatibility — never blindly to slot 0.
  const portIdx = (ports: any[], name: string | undefined, wantType: string): number => {
    const byName = (ports ?? []).findIndex((p: any) => p.name === name)
    if (byName >= 0) return byName
    // -1 ⇒ caller skips the edge: an unwirable suggestion creates NO edge
    // rather than a wrong one (never blindly slot 0).
    return findCompatiblePortIndex(ports, wantType)
  }
  const newEdges: any[] = []
  for (const e of result.edges) {
    if (e.fromAnchor) {
      const to = created.get(e.toId!)
      if (!to) continue
      const idx = portIdx(to.data.inputs, e.toPort, anchor.portType)
      if (idx < 0) continue
      newEdges.push({ source: anchor.nodeId, sourceHandle: `output-${anchor.portIndex}`, target: to.id, targetHandle: `input-${idx}`, type: 'comfy', data: { dataType: anchor.portType } })
    }
    else if (e.toAnchor) {
      const from = created.get(e.fromId!)
      if (!from) continue
      const idx = portIdx(from.data.outputs, e.fromPort, anchor.portType)
      if (idx < 0) continue
      newEdges.push({ source: from.id, sourceHandle: `output-${idx}`, target: anchor.nodeId, targetHandle: `input-${anchor.portIndex}`, type: 'comfy', data: { dataType: anchor.portType } })
    }
    else {
      const from = created.get(e.fromId!)
      const to = created.get(e.toId!)
      if (!from || !to) continue
      const oIdx = portIdx(from.data.outputs, e.fromPort, '*')
      if (oIdx < 0) continue
      const outType = String(from.data.outputs[oIdx]?.type ?? '*')
      const iIdx = portIdx(to.data.inputs, e.toPort, outType)
      if (iIdx < 0) continue
      newEdges.push({ source: from.id, sourceHandle: `output-${oIdx}`, target: to.id, targetHandle: `input-${iIdx}`, type: 'comfy', data: { dataType: outType } })
    }
  }
  addEdges(newEdges)
}

/** Free tier: a node picked from the fuzzy list, wired straight to the anchor. */
async function handlePortIntentSelect(nodeType: string) {
  const ctx = portIntent.value
  if (!ctx) return
  portIntent.value = null
  if (!objectInfo.value[nodeType]) await fetchObjectInfo()
  const anchor = ctx.anchor
  const anchorNode = (nodes.value as any[]).find(n => n.id === anchor.nodeId)
  const dir = anchor.direction === 'output' ? 1 : -1
  const pos = ctx.dropFlow ?? {
    x: (anchorNode?.position?.x ?? 0) + dir * 360,
    y: anchorNode?.position?.y ?? 0,
  }
  const node = createNodeData(nodeType, pos)
  nodes.value.push(node)
  await nextTick()
  // Wire only onto a type-compatible port (the catalog is type-filtered, but
  // never fall back to slot 0 — a wrong-typed link fails at run time).
  if (anchor.direction === 'output') {
    const targetHandle = inputHandleFor(node, anchor.portType)
    if (targetHandle) {
      addEdges([{ source: anchor.nodeId, sourceHandle: `output-${anchor.portIndex}`, target: node.id, targetHandle, type: 'comfy', data: { dataType: anchor.portType } }])
    }
  }
  else {
    const sourceHandle = outputHandleFor(node, anchor.portType)
    if (sourceHandle) {
      addEdges([{ source: node.id, sourceHandle, target: anchor.nodeId, targetHandle: `input-${anchor.portIndex}`, type: 'comfy', data: { dataType: anchor.portType } }])
    }
  }
}

/** AI tier: resolve the intent, insert the validated result, show the note. */
async function handlePortIntentAi(intent: string) {
  const ctx = portIntent.value
  if (!ctx) return
  portIntentAiState.value = 'loading'
  portIntentAiError.value = null
  try {
    await fetchObjectInfo()
    const result = await suggestPortIntent(intent, ctx.anchor, {
      objectInfo: objectInfo.value,
      nodes: nodes.value as any[],
      edges: edges.value as any[],
    })
    await insertSuggestion(result, ctx.anchor, ctx.dropFlow)
    portIntentAiNote.value = result.note || 'Done'
    portIntentAiState.value = 'done'
    setTimeout(() => { portIntent.value = null }, 2000)
  }
  catch (err: any) {
    portIntentAiState.value = 'error'
    portIntentAiError.value = err?.data?.message || err?.message || 'AI suggestion failed'
  }
}

// Listen for addNode events from NodeSearchDialog
// Test-only escape hatch: patch node.data directly without a real run, so
// Playwright can force a capsule/running/error state instead of paying for a
// generation just to see the collapsed UI. Matches the first node whose
// nodeType contains `detail.match`. Registered only in dev (see onMounted) —
// a no-op in production.
function handleTestSetNodeData(e: Event) {
  const detail = (e as CustomEvent<{ match: string, patch: Record<string, unknown> }>).detail
  if (!detail?.match || !detail.patch) return
  const node = (nodes.value as any[]).find((n) => String(n.data?.nodeType ?? '').includes(detail.match))
  if (!node) return
  Object.assign(node.data, detail.patch)
}

async function handleAddNode(e: Event) {
  const detail = (e as CustomEvent<{ nodeType: string, widgetOverrides?: Record<string, unknown>, propertyOverrides?: Record<string, unknown>, dataOverrides?: Record<string, unknown> }>).detail
  const { nodeType, widgetOverrides, propertyOverrides, dataOverrides } = detail

  // Refresh schema if we don't know this node type.
  if (!objectInfo.value[nodeType]) {
    await fetchObjectInfo()
  }

  // If the search was opened from an edge "+", splice into that edge instead
  // of dropping the node at viewport center.
  if (pendingSpliceEdgeId) {
    const edgeId = pendingSpliceEdgeId
    pendingSpliceEdgeId = null
    await spliceIntoEdge(edgeId, nodeType, widgetOverrides)
    return
  }

  const center = project({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const newNode = createNodeData(nodeType, { x: center.x, y: center.y }, widgetOverrides, propertyOverrides)
  if (dataOverrides && typeof dataOverrides === 'object') {
    newNode.data = { ...newNode.data, ...dataOverrides }
  }
  nodes.value.push(newNode)
  // Frontend-only Space Type node: do NOT auto-open the editor on add. The node
  // card shows a live preview from its saved config; the user clicks Edit to
  // open the authoring modal.
}

// Edit as Frame: convert a layer-splitting node's results into a Frame
// artifact wired next to it. Layerize → background as wired layer1 + the
// Ideogram text containers as editable local text layers; Split-photo →
// clean background (layer1) + subject cutout (layer2) as wired layers. The
// Frame's unified stack then lets any layer reorder above/below any other.
async function handleEditAsFrame(e: Event) {
  const nodeId = String((e as CustomEvent).detail?.nodeId ?? '')
  const src = (nodes.value as any[]).find((n: any) => n.id === nodeId)
  if (!src) return
  if (!objectInfo.value['Compositor']) await fetchObjectInfo()
  if (!objectInfo.value['Compositor']) return

  const isLayerize = src.data?.nodeType === 'LayerizeGraphicNode'
  const isSeedream = src.data?.nodeType === 'SeedreamLayerizeNode'
  const parsed = isLayerize ? parseIdeogramLayers(String(src.data?.text || '')) : null
  const seedream = isSeedream ? parseSeedreamLayers(String(src.data?.text || '')) : null
  if (isLayerize && (!parsed || !parsed.textLayers.length)) {
    console.warn('[EditAsFrame] no usable text layers in layers_json')
    if (!parsed) return
  }
  if (isSeedream && (!seedream || !seedream.imageLayers.length)) {
    console.warn('[EditAsFrame] no usable image layers from Seedream layerize')
    return
  }

  const pos = { x: (src.position?.x ?? 0) + (src.data?.size?.[0] ?? 240) + 120, y: src.position?.y ?? 0 }
  // Artboard size = the resolution Ideogram re-rendered at (its text coords
  // are in that space, NOT the input image's) — or layer-1-driven for splits.
  // Seedream carries its own canvas dims from Task 3's parse.
  const dims = parsed ? { width: parsed.width, height: parsed.height }
    : seedream ? { width: seedream.width, height: seedream.height } : undefined
  const frame = createNodeData('Compositor', pos, dims)
  const frameProps = (frame.data.properties ||= {}) as Record<string, any>

  const wire = (outputIdx: number, inputName: string) => {
    const idx = (frame.data.inputs as any[]).findIndex((i: any) => i.name === inputName)
    if (idx < 0) return
    edges.value.push({
      id: `e-frame-${frame.id}-${inputName}`,
      source: src.id,
      sourceHandle: `output-${outputIdx}`,
      target: frame.id,
      targetHandle: `input-${idx}`,
      type: 'comfy',
      data: { dataType: 'IMAGE' },
    } as any)
  }

  if (seedream) {
    frameProps.sailor_frame = { ...(frameProps.sailor_frame || {}), preset: 'custom' }
    frameProps.sailor_localLayers = seedream.imageLayers
    // All local image layers, already bottom→top by z-index. No wired inputs.
    frameProps.sailor_stackOrder = seedream.imageLayers.map((l) => `l:${l.id}`)
    ensureLayerImages(seedream.imageLayers as any).catch(() => {})
    nodes.value.push(frame as any)
  } else if (parsed) {
    frameProps.sailor_frame = { ...(frameProps.sailor_frame || {}), preset: 'custom' }
    frameProps.sailor_localLayers = parsed.textLayers
    // Background at the bottom of the unified stack, every text layer above.
    frameProps.sailor_stackOrder = ['w:1', ...parsed.textLayers.map((l) => `l:${l.id}`)]
    ensureLayerFonts(parsed.textLayers as any, parsed.width).catch(() => {})
    nodes.value.push(frame as any)
    wire(0, 'layer1') // text-free background
  } else {
    frameProps.sailor_stackOrder = ['w:1', 'w:2']
    nodes.value.push(frame as any)
    wire(1, 'layer1') // clean background plate → bottom
    wire(0, 'layer2') // subject cutout → top
  }
}

// Combine a multi-selection of image nodes into one Frame (Compositor): mint a
// Compositor to the right of the selection and wire each image's output into
// layer1..N as a stacked layer. The Frame lands on the graph selected but does
// NOT auto-open the editor — double-click / Edit when ready to arrange.
// The image-only filtering, position, layer ordering and 16-layer cap live in
// the pure `planFrameFromSelection` (unit-tested); this just mints + wires.
async function combineIntoFrame(ids: string[]) {
  const sel = (nodes.value as any[]).filter((n: any) => ids.includes(n.id))
  const plan = planFrameFromSelection(sel)
  if (!plan.canCombine) return
  if (!objectInfo.value['Compositor']) await fetchObjectInfo()
  if (!objectInfo.value['Compositor']) return

  const frame = createNodeData('Compositor', plan.position)
  const frameProps = (frame.data.properties ||= {}) as Record<string, any>
  // Stack the wired layers bottom-to-top in plan order (layer1 at the bottom).
  frameProps.sailor_stackOrder = plan.layers.map((_, i) => `w:${i + 1}`)
  nodes.value.push(frame as any)

  plan.layers.forEach((layer, i) => {
    const inputName = `layer${i + 1}`
    const idx = (frame.data.inputs as any[]).findIndex((inp: any) => inp.name === inputName)
    if (idx < 0) return
    edges.value.push({
      id: `e-frame-${frame.id}-${inputName}`,
      source: layer.id,
      sourceHandle: `output-${layer.outputIndex}`,
      target: frame.id,
      targetHandle: `input-${idx}`,
      type: 'comfy',
      data: { dataType: 'IMAGE' },
    } as any)
  })

  selectNode(frame.id)
  if (plan.skipped > 0) {
    toast.info(`A Frame holds ${MAX_FRAME_LAYERS} layers`, {
      description: `Combined the first ${plan.layers.length}; skipped ${plan.skipped}.`,
    })
  }
}

// Subgraph navigation: double-click to enter
function handleNodeDoubleClick({ node }: { node: any }) {
  if (!node.data?.isSubgraph || !node.data?.subgraphId) return
  if (!rootWorkflow.value?.definitions) return

  const innerWorkflow = enterSubgraph(
    node.data.subgraphId,
    node.data.subgraphName || node.data.title,
    JSON.parse(JSON.stringify(nodes.value)),
    JSON.parse(JSON.stringify(edges.value)),
    rootWorkflow.value.definitions,
  )
  if (!innerWorkflow) return

  // Render the inner subgraph workflow
  convertFromLiteGraph(innerWorkflow, rootWorkflow.value.definitions)
  nextTick(() => fitView({ padding: 0.2 }))
}

// Subgraph navigation: breadcrumb click to exit
function handleBreadcrumbNavigate(index: number) {
  if (!rootWorkflow.value?.definitions) return

  const restored = exitToLevel(
    index,
    JSON.parse(JSON.stringify(nodes.value)),
    JSON.parse(JSON.stringify(edges.value)),
    rootWorkflow.value.definitions,
    convertToLiteGraph,
  )
  if (!restored) return

  if (index === -1) {
    // Going back to root: re-convert from the root workflow (with updated definitions)
    convertFromLiteGraph(rootWorkflow.value, rootWorkflow.value.definitions)
  } else {
    // Restore the snapshotted state
    nodes.value = restored.nodes
    edges.value = restored.edges
  }
  nextTick(() => fitView({ padding: 0.2 }))
}

// Get workflow with subgraph awareness
function getWorkflowWithSubgraphs() {
  // If inside a subgraph, save current state back to definitions first
  if (isInsideSubgraph.value && rootWorkflow.value?.definitions) {
    saveCurrentSubgraph(
      nodes.value as any[],
      edges.value as any[],
      rootWorkflow.value.definitions,
      convertToLiteGraph,
    )
  }

  // Always return the root workflow with updated definitions
  if (rootWorkflow.value) {
    // If we're at root level, get the current state
    if (!isInsideSubgraph.value) {
      const wf = convertToLiteGraph()
      // Preserve definitions from root
      if (rootWorkflow.value.definitions) {
        ;(wf as any).definitions = rootWorkflow.value.definitions
      }
      return wf
    }
    // If inside a subgraph, return the root workflow (definitions already updated above)
    return rootWorkflow.value
  }

  return convertToLiteGraph()
}

// Build a Take from a bridge 'executed' event, or null if the payload is
// empty (a ui-only `executed` shouldn't pile up blank takes).
function takeFromExecutedEvent(event: MessageEvent): any | null {
  const output = event.data.output
  if (!output) return null
  // Parallel-run pool: a result produced by an extra worker (its iframe is
  // tagged data-worker) lives on THAT worker's origin. The default :8188
  // /view proxy can't see other workers' files and filenames collide, so
  // make those URLs absolute to the producing worker. Worker 0 / single
  // worker → relative (served via the proxy, unchanged).
  let originPrefix = ''
  const src = event.source as Window | null
  if (src) {
    for (const f of document.querySelectorAll('iframe[data-worker]')) {
      const frame = f as HTMLIFrameElement
      if (frame.contentWindow === src) { originPrefix = new URL(frame.src).origin; break }
    }
  }
  const toUrl = (f: any) => {
    const params = new URLSearchParams({ filename: f.filename, type: f.type })
    if (f.subfolder) params.set('subfolder', f.subfolder)
    // Cache-buster: live-preview nodes reuse a fixed filename, so without
    // a unique query the browser would serve the stale cached file.
    params.set('t', String(Date.now()))
    return `${originPrefix}/view?${params}`
  }
  const take = buildTake((event.data as any).prompt_id ?? null, output, toUrl)
  return takeHasContent(take) ? take : null
}

// Listen for execution progress on the window pipe (the layout re-posts
// direct-execution WS events here in the 'sailor-bridge' envelope).
function handleBridgeMessage(event: MessageEvent) {
  if (event.data?.type !== 'sailor-bridge') return
  // Only this window posts onto the pipe — there is no engine iframe any more.
  if (event.source !== window || event.origin !== window.location.origin) return

  const { event: evt, node_id, node, percent, progress: prog } = event.data
  const nodeId = node_id || node // bridge sends node_id, normalize

  // Prompt validation failed before anything ran (bridge `queue_error`
  // carrying ComfyUI's structured node_errors map — type mismatch, missing
  // input, …). Mark each offending node exactly like execution_error does
  // (red ring + persisted message); it clears the same way too — the node's
  // next 'executing' event resets error state below. Handled before the
  // worker/scope gates: no run started, so no run scope or worker applies.
  if (evt === 'queue_error') {
    // Nuxt-proxy metering refusal (moderation / credits / ownership /
    // paused): no node ids exist, so without this toast the refusal is
    // completely silent. (Stage 8.)
    const refusal = describeQueueRefusal(event.data)
    if (refusal) {
      toast.error(refusal.title, {
        description: refusal.description,
        ...(refusal.policyLink ? { action: { label: 'Content policy', onClick: () => window.open('/content-policy', '_blank') } } : {}),
      })
      return
    }
    const { perNode } = summarizeNodeErrors(event.data.node_errors)
    for (const [id, msg] of Object.entries(perNode)) {
      const target = (nodes.value as any[]).find((n: any) => n.id === String(id))
      if (target) {
        target.data = { ...target.data, running: false, error: true, errorMessage: msg }
      }
    }
    return
  }

  // Attribute this event to its run by prompt_id (audit C1/C3/C6). In DIRECT
  // mode every worker's events are re-broadcast as same-window postMessage, so
  // event.source is always this window and the old eventWorker(event.source)
  // gate ALWAYS resolved to worker 0 — dropping executing/progress/complete for
  // a viewed tab pinned to a pool worker (>=1), so its glow never cleared
  // ("second run runs forever"). Route by the run registry instead: the run's
  // own canvasId decides whether its events belong to the displayed graph.
  const promptIdForRoute = (event.data as any).prompt_id ? String((event.data as any).prompt_id) : null
  const entry = promptIdForRoute ? getRun(promptIdForRoute) : null

  // Part C: populate the local canvas cache the FIRST time we see a live entry
  // for this prompt (executing is the earliest per-run event that carries the
  // registry entry — registerRun ran at dispatch, finishRun hasn't yet). This
  // captured value survives finishRun's later deletion so terminal events can
  // still resolve the run's canvas below.
  if (evt === 'executing' && promptIdForRoute && entry?.canvasId && !canvasByPrompt.has(promptIdForRoute)) {
    canvasByPrompt.set(promptIdForRoute, entry.canvasId)
  }

  // Registered run whose canvas is known (Task 6 wires canvasId at register
  // time) and is NOT the one on screen: its node ids collide with the displayed
  // canvas's, so applying glow/results here would light the wrong nodes or
  // deliver a result to a same-id node. Buffer 'executed' for that canvas (it
  // lands when the canvas is shown again) and drop the rest.
  //
  // Resolve from the local cache FIRST (survives finishRun on terminal events),
  // then the live registry entry, then null. Fallback (== null — pre-Task-6, or
  // no registered run e.g. bridge path): preserve today's displayed-canvas
  // behavior, still gated by runScopeMatches so nothing regresses.
  const runCanvasId = (promptIdForRoute ? canvasByPrompt.get(promptIdForRoute) : null)
    ?? entry?.canvasId ?? null

  // Reap the cache entry on terminal events HERE — above the off-screen
  // early-return below. A run dispatched to a non-displayed canvas never
  // reaches the later execution_complete/execution_error blocks (this
  // function returns early for it), so without this the promptId→canvasId
  // mapping would live in `canvasByPrompt` forever (unbounded growth across a
  // session). Deleting it here means it always runs on every terminal path,
  // on-screen or off. The later deletes in the execution_complete/
  // execution_error blocks become redundant no-ops (delete-twice is safe) and
  // are left in place as defense-in-depth / documentation of intent there.
  if ((evt === 'execution_complete' || evt === 'execution_error') && promptIdForRoute) {
    canvasByPrompt.delete(promptIdForRoute)
  }
  if (runCanvasId != null) {
    if (props.displayedCanvasId != null && runCanvasId !== props.displayedCanvasId) {
      if (evt === 'executed' && nodeId && event.data.output) {
        const take = takeFromExecutedEvent(event)
        // Frozen loader re-emission — not a generation; never a take.
        if (take && !frozenRunNodeIds.value.has(String(nodeId))) {
          ;(pendingTakesByCanvas[runCanvasId] ||= []).push({ nodeId: String(nodeId), take })
        }
      }
      return
    }
    // else: runCanvasId matches the displayed canvas → fall through and place.
  } else if (!runScopeMatches.value) {
    // No per-run canvasId available yet: use the legacy tab-level scope prop.
    if (evt === 'executed' && nodeId && event.data.output && props.runningCanvasId) {
      const take = takeFromExecutedEvent(event)
      // Frozen loader re-emission — not a generation; never a take.
      if (take && !frozenRunNodeIds.value.has(String(nodeId))) {
        ;(pendingTakesByCanvas[props.runningCanvasId] ||= []).push({ nodeId: String(nodeId), take })
      }
    }
    return
  }

  if (evt === 'executing') {
    // Concurrent runs (spill-to-pool, parallel takes): each run only clears
    // ITS OWN previous node's glow, keyed by prompt_id — run 2 starting must
    // not extinguish run 1's animation. Events without a prompt_id (legacy
    // paths) keep the old clear-everything behavior.
    const promptId = (event.data as any).prompt_id ? String((event.data as any).prompt_id) : null
    const clearNodeGlow = (id: string) => {
      const prev = (nodes.value as any[]).find((n: any) => n.id === id)
      if (prev?.data?.running) prev.data = { ...prev.data, running: false }
      for (const e of edges.value) {
        if (e.source === id && e.data?.running) e.data = { ...e.data, running: false }
      }
    }
    if (promptId) {
      const prev = runningNodeByPrompt.get(promptId)
      if (prev && prev !== String(nodeId)) clearNodeGlow(prev)
      if (nodeId) runningNodeByPrompt.set(promptId, String(nodeId))
      else { if (prev) clearNodeGlow(prev); runningNodeByPrompt.delete(promptId) }
    } else {
      for (const n of nodes.value) {
        if (n.data?.running) {
          n.data = { ...n.data, running: false }
        }
      }
      for (const e of edges.value) {
        if (e.data?.running) {
          e.data = { ...e.data, running: false }
        }
      }
    }
    if (nodeId) {
      const target = (nodes.value as any[]).find((n: any) => n.id === String(nodeId))
      if (target) {
        // A sketch-output card is a finished pick (an image LOADER), not a
        // generator — never show it "running". When it's pulled into a Develop
        // run as the edit node's source it loads briefly, and marking it running
        // latches the reveal/dither FX onto a card that yields no fresh image, so
        // the FX never tears down (mosaic forever). The backend still loads it
        // (free); we just don't paint a generating state on it.
        if (!(target.data?.properties as any)?.sketchOutput) {
          // runningSince powers the capsule read-out's live elapsed counter.
          // The run-level startedAt in runRegistry measures the whole run, not
          // this node, so a per-node stamp is the only way a capsule can say
          // how long IT has been going.
          //
          // errorMessage clears WITH error, never after it. The two are one
          // fact: the capsule read-out ranks errorMessage above everything
          // else, so leaving the text behind while flipping the flag pins a
          // dead failure over "rendering · 12s" and then over the settings
          // summary — for the rest of the session.
          target.data = {
            ...target.data,
            running: true,
            error: false,
            errorMessage: null,
            runningSince: Date.now(),
          }
        } else if (target.data?.error) {
          // A sketch-output card never paints a running state (see above), but
          // a stale failure on it must still clear when it is touched again.
          target.data = { ...target.data, error: false, errorMessage: null }
        }
        // Light outgoing edges from this node — but only the ones whose
        // target is part of the current run set. A generator fanned out
        // to multiple sinks where only one is targeted should only
        // illuminate the active path. activeRunNodeIds is populated by
        // getFilteredWorkflow / getWorkflow at submission time.
        const activeSet = activeRunNodeIds.value
        for (const e of edges.value) {
          if (e.source !== String(nodeId)) continue
          // Empty active set = no filtering known (e.g. legacy run path);
          // light everything as before so we don't regress that case.
          if (activeSet.size && !activeSet.has(e.target)) continue
          e.data = { ...e.data, running: true }
        }
      }
    }
  }

  if (evt === 'progress') {
    // Route progress to ITS run's node (concurrent runs each carry their own
    // prompt_id); fall back to "the" running node for legacy events without one.
    const promptId = (event.data as any).prompt_id ? String((event.data as any).prompt_id) : null
    const targetId = promptId ? runningNodeByPrompt.get(promptId) : undefined
    const running = targetId
      ? (nodes.value as any[]).find((n: any) => n.id === targetId)
      : (nodes.value as any[]).find((n: any) => n.data?.running)
    if (running) {
      // Bridge sends percent directly, or prog.value/prog.max
      const pct = percent ?? (prog ? Math.round((prog.value / prog.max) * 100) : undefined)
      if (pct !== undefined) running.data = { ...running.data, progress: pct }
    }
  }

  if (evt === 'executed') {
    // Store output images/videos/audio on the node (for PreviewImage, PreviewVideo, PreviewAudio, SaveImage etc.)
    if (nodeId && event.data.output) {
      const target = (nodes.value as any[]).find((n: any) => n.id === String(nodeId))
      if (target) {
        // Takes loop: append this run as a take instead of overwriting.
        // appendTake mirrors the new (active) take onto images/audios/text/
        // animated, so a single run stays behavior-identical while prior results
        // are preserved for compare/switch.
        const take = takeFromExecutedEvent(event)
        if (take) {
          // Speculative warm (Task 7): a throwaway single-output dispatch used
          // only to keep the endpoint hot. Discard outright — return BEFORE
          // appendTake even runs, so the reused hidden warm node accumulates
          // no take (and, in turn, never reaches the sketchPad/sketch routing
          // below) regardless of images.length.
          if (target?.data?.properties?.sketchWarm === true) return
          // Hidden sketch SINK (auto-created just to satisfy ComfyUI's output
          // requirement): its result is a duplicate of the pad's own executed
          // batch — discard it so it never double-materializes the grid.
          if (target?.data?.properties?.sketchSink === true) return
          // Frozen-for-this-run artifact (auto-freeze / user lock): it executed
          // as a passthrough LOADER feeding its held file, not as a generator.
          // Appending its re-emission would activate a junk take pointing at
          // the fixed-name temp preview and clobber the user's filmstrip pick
          // (same guard class as sketchWarm/sketchSink above).
          if (frozenRunNodeIds.value.has(String(target.id))) return
          // Scrub-preview node (Blur, AdjustCurves, … — auto-runs on every
          // widget tweak): its emissions all alias ONE fixed-name temp file,
          // so a filmstrip of them is an illusion — picking an older take
          // shows stale browser-cached pixels while downstream runs read the
          // newest content. Refresh the display, capture no take.
          if (LIVE_PREVIEW_NODE_TYPES.has(String(target.data?.nodeType))) {
            target.data = refreshTakeDisplay({ ...target.data }, take)
            return
          }
          // Provenance: remember HOW this result was made (prompt/seed/model/…) so
          // a later "breed from this take" can perturb around it. (Direction Loop.)
          take.params = { ...(take.params ?? {}), ...nodeGenParams(target) }
          const tagged = tagTakeFromRunMeta(take, String(target.id), { draftMetaFor, consumePendingPromote })
          target.data = appendTake({ ...target.data }, tagged)
          // Prompt-bar sketch pad: the transient hidden pad's batch lands in the
          // ONE pile node (replacing the optimistic skeleton pile), not 4 anchor
          // cards. Routed by the pad's properties.sketchPad marker (id-agnostic —
          // the pad's numeric id is minted per-canvas, not a fixed string) BEFORE
          // the legacy sketch-node fan-out below (Task 8 retires that branch).
          if (target?.data?.properties?.sketchPad === true && tagged.images && tagged.images.length > 1 && sketchPad.anchor) {
            // Batch lands in the review strip (docked above the prompt bar),
            // never a pile node — the user reviews all four and commits
            // exactly one via Keep or drag; Cancel/close discards the rest.
            sketchReview.images = tagged.images.slice(0, MAX_SKETCH_ITEMS)
            sketchReview.selected = null
            sketchReview.open = true
            sketchReview.error = false
            sketchReviewBusy.value = false
            return
          }
          // Sketch NODE (properties.sketch — the node-search preset): its
          // batch also presents as a pile beside the node. The take was
          // already appended above; this only adds the choose-one surface.
          if (target?.data?.properties?.sketch === true && tagged.images && tagged.images.length > 1) {
            materializeSketchPileBeside(target, tagged.images, take.params ?? {})
          }
        }
      }
    }
  }

  if (evt === 'execution_error') {
    if (nodeId) {
      const target = (nodes.value as any[]).find((n: any) => n.id === String(nodeId))
      if (target) {
        // Persist the exception message on the node so the error stays
        // visible (red ring + inline chip) until the next successful run
        // on this node — toasts disappear, this doesn't.
        target.data = {
          ...target.data,
          running: false,
          error: true,
          errorMessage: event.data.exception_message || null,
          runningSince: null,
        }
        // A failed run (first submit OR Re-roll) never reaches the success
        // branch above, so sketchReviewBusy would otherwise stay stuck true —
        // the hidden pad has no visible error ring, so that reads as the
        // strip hanging forever (or, on first submit, an eternal skeleton).
        // Clear busy so Keep/Re-roll re-enable, and flip the strip to its
        // error state — a Re-roll failure still has the prior four takes in
        // sketchReview.images, but the error message + retry affordance take
        // priority over showing stale sketches as if nothing went wrong.
        if (target?.data?.properties?.sketchPad === true) {
          sketchReviewBusy.value = false
          sketchReview.error = true
        }
      }
    }
    // Release this run's glow bookkeeping (mirrors execution_complete) so a
    // failed run can't strand a runningNodeByPrompt entry — sibling runs keep
    // animating, and the edge-filter set resets once nothing is in flight.
    {
      const promptId = (event.data as any).prompt_id ? String((event.data as any).prompt_id) : null
      if (promptId && runningNodeByPrompt.has(promptId)) {
        const nid = runningNodeByPrompt.get(promptId)!
        runningNodeByPrompt.delete(promptId)
        for (const e of edges.value) {
          if (e.source === nid && e.data?.running) e.data = { ...e.data, running: false }
        }
      }
      if (runningNodeByPrompt.size === 0) activeRunNodeIds.value = new Set()
      // Part C: this run is terminal — its routing above already consumed the
      // cached canvas, so drop the entry to keep the cache bounded.
      if (promptId) canvasByPrompt.delete(promptId)
    }
  }

  // (Stale-error clearing used to live here, as a second `evt === 'executing'`
  // pass guarded on `target.data.error`. The first pass above had already set
  // error:false on the same node object, so the guard could only ever be true
  // for a sketch-output card — the one node the first pass skips. Both cases
  // are now handled up there, where `error` is cleared, so errorMessage can
  // never be left behind by a code path that clears only the flag.)

  if (evt === 'execution_complete') {
    const promptId = (event.data as any).prompt_id ? String((event.data as any).prompt_id) : null
    if (promptId && runningNodeByPrompt.has(promptId)) {
      // Only extinguish THIS run's glow — a sibling concurrent run keeps its
      // animation until its own completion event arrives.
      const nid = runningNodeByPrompt.get(promptId)!
      runningNodeByPrompt.delete(promptId)
      const target = (nodes.value as any[]).find((n: any) => n.id === nid)
      if (target?.data && (target.data.running || target.data.progress)) {
        target.data = { ...target.data, running: false, progress: undefined, runningSince: null, hasRun: true }
      }
      for (const e of edges.value) {
        if (e.source === nid && e.data?.running) e.data = { ...e.data, running: false }
      }
    } else if (!promptId) {
      // No prompt_id at all (legacy path): original clear-everything sweep.
      for (const n of nodes.value) {
        if (n.data?.running || n.data?.progress) {
          // Clear runningSince / stamp hasRun here too. This branch is reachable
          // (an executing(null) completion with no preceding execution_start —
          // e.g. a mid-run reload reconnecting the socket), and a node that
          // exits it without them keeps a forever-ticking elapsed counter and
          // never becomes eligible for the after-run collapse tier.
          n.data = { ...n.data, running: false, progress: undefined, runningSince: null, hasRun: true }
        }
      }
      for (const e of edges.value) {
        if (e.data?.running) {
          e.data = { ...e.data, running: false }
        }
      }
      runningNodeByPrompt.clear()
    }
    // else: a prompt_id we already finished — every run completes TWICE
    // (ComfyUI's `executing: null` sentinel AND `execution_success` both map
    // to execution_complete). The duplicate must be a no-op, not a sweep:
    // sweeping here extinguished the sibling run's glow the moment the first
    // run finished.
    // Drop the captured run set once NO runs remain — while a sibling run is
    // still in flight its edge-filtering set stays useful.
    if (runningNodeByPrompt.size === 0) {
      activeRunNodeIds.value = new Set()
      // Watchdog: with nothing in flight, NO node/edge may keep a running
      // flag. The per-prompt clears above only touch the registry's CURRENT
      // node, so a glow lit by a straggler 'executing' (after a run's first
      // completion), a duplicate-completion race, or an HMR that dropped the
      // registry mid-run stays latched forever — and a latched flag keeps the
      // generation FX (dither churn / glimm sweep) running on an idle card.
      // Safe here by construction: the registry is empty, so there is no
      // sibling run whose glow this could extinguish.
      for (const n of nodes.value as any[]) {
        if (n.data?.running || n.data?.progress) {
          n.data = { ...n.data, running: false, progress: undefined }
        }
      }
      for (const e of edges.value as any[]) {
        if (e.data?.running) e.data = { ...e.data, running: false }
      }
    }
    // Part C: drop the cached canvas for this finished run. Guarded on the FIRST
    // complete's presence in runningNodeByPrompt would race the duplicate
    // complete (each run fires execution_complete twice); instead we delete
    // unconditionally here — routing above already resolved runCanvasId for THIS
    // event from the cache before this block, and any duplicate complete is a
    // no-op whose mis-routing (cache-miss → runScopeMatches fallback) touches
    // nothing (its runningNodeByPrompt entry is already gone).
    if (promptId) canvasByPrompt.delete(promptId)
    // Let the agent close its run→look→fix loop (the prompt bar gates on whether a
    // Keep & Run is awaiting review).
    if (import.meta.client) window.dispatchEvent(new CustomEvent('sailor:agentRunComplete'))
  }

  if (evt === 'gate_paused') {
    const promptId = event.data.prompt_id
    const target = (nodes.value as any[]).find((n: any) => n.id === String(nodeId))
    console.log('[Gate] gate_paused handler:', { nodeId, promptId, found: !!target })
    if (target) {
      target.data = { ...target.data, paused: true, promptId, running: false }
      console.log('[Gate] node data after update:', { paused: target.data.paused, promptId: target.data.promptId })
    }
  }

  if (evt === 'execution_start') {
    // Reset gate paused state but keep promptId so the user can
    // re-trigger from the gate after execution completes.
    const startPromptId = event.data.prompt_id
    for (const n of nodes.value) {
      if (n.data?.paused && (!startPromptId || n.data.promptId === startPromptId)) {
        n.data = { ...n.data, paused: false }
      }
    }
  }
}

// Compositor modal state.
const compositorOpenForId = ref<string | null>(null)
function handleOpenCompositor(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) compositorOpenForId.value = String(detail.nodeId)
}
// Method, not an inline template handler — `window` is not in template expression scope
// (same trap documented on closeSpaceTypeEditor). The dispatch tells every Frame card to
// resume its live preview loop (paused while the fullscreen modal occluded it).
function closeCompositorEditor() {
  compositorOpenForId.value = null
  window.dispatchEvent(new CustomEvent('sailor:closeCompositor'))
}

// Space Type editor modal state (frontend-only config node).
const spaceTypeOpenForId = ref<string | null>(null)
function handleOpenSpaceType(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) spaceTypeOpenForId.value = String(detail.nodeId)
}
// Close the Space Type modal. Done in a method, not an inline template handler, because
// `window` is NOT in a Vue template's expression scope — the old inline
// `window.dispatchEvent(...)` threw "undefined.dispatchEvent", which aborted before the
// event fired. That left the node's gate.editing stuck true, so the card (and its downstream
// Frame) froze until a full reload. The dispatch tells SpaceTypeNode to resume its preview.
function closeSpaceTypeEditor() {
  spaceTypeOpenForId.value = null
  window.dispatchEvent(new CustomEvent('sailor:closeSpaceType'))
}

// Space Type CLIP editor (edit-in-place on the timeline). Separate from the node
// editor above: it binds the studio to a clip's state, not a node's. The Timeline
// editor stays mounted underneath — closing this returns to it.
const spaceTypeClipEditId = ref<string | null>(null)
function handleOpenSpaceTypeClip(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.clipId) spaceTypeClipEditId.value = String(detail.clipId)
}
function closeSpaceTypeClipEditor() { spaceTypeClipEditId.value = null }

// Gradient Studio editor open-state (same pattern as Space Type).
const gradientStudioOpenForId = ref<string | null>(null)
function handleOpenGradientStudio(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) gradientStudioOpenForId.value = String(detail.nodeId)
}

// Moodboard modal open-state (same pattern as Gradient Studio). Opened by a
// true click on the MoodboardNode pile (sailor:openMoodboard, Task A6).
const moodboardOpenForId = ref<string | null>(null)
function handleOpenMoodboard(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) moodboardOpenForId.value = String(detail.nodeId)
}

// ── Moodboard taste wiring — "Applying IS wiring" (2026-08-07 amendment) ─────
// Every application of a moodboard to the Generate-an-image node is expressed
// as the REAL TASTE edge (Moodboard.style → style_in): the chip pick
// finds-or-creates the board's node and draws the edge; a manual wire drag
// fires the same side effects; ✕ removes the edge (node stays); a manual edge
// deletion empties the chip. The wire is the single carrier of the prose
// block (styleInject skips style_block when style_in is linked) — refs stay
// property-carried. The chip stays a remote control for the wire: identity
// lives in properties.sailor_moodboard on BOTH ends, so it never needs a
// graph traversal.
const { byId: moodboardById, loaded: moodboardsLoaded, refresh: refreshMoodboards } = useMoodboards()

function generatorStyleInIndex(node: any): number {
  return ((node?.data?.inputs ?? []) as any[]).findIndex((i: any) => i?.name === 'style_in')
}

/** Node types that accept a moodboard style channel — the single source of
 *  truth for the four wire gates below. */
const MOODBOARD_TARGET_TYPES = new Set(['GenerateImageNode', 'RestyleFromImageNode'])
function nodeTakesMoodboard(nodeType: any): boolean {
  return MOODBOARD_TARGET_TYPES.has(String(nodeType))
}

/** Remove any edge feeding a node's `style_image` input — a moodboard overrides
 *  it (2026-08-09 restyle spec). */
function disconnectStyleImageEdge(node: any): void {
  const idx = ((node?.data?.inputs ?? []) as any[]).findIndex((i: any) => i?.name === 'style_image')
  if (idx < 0) return
  const drop = (edges.value as any[]).filter(e2 =>
    String(e2.target) === String(node.id) && e2.targetHandle === `input-${idx}`)
  if (drop.length) removeEdges(drop.map(e2 => e2.id))
}

/** Live edges feeding this generator's style_in input. */
function tasteEdgesInto(generatorId: string): any[] {
  const gen = (nodes.value as any[]).find(n => String(n.id) === String(generatorId))
  const idx = generatorStyleInIndex(gen)
  if (idx < 0) return []
  return (edges.value as any[]).filter(e =>
    String(e.target) === String(generatorId) && e.targetHandle === `input-${idx}`)
}

async function resolveMoodboardEntry(entryId: string): Promise<MoodboardEntry | undefined> {
  if (!moodboardsLoaded.value) await refreshMoodboards().catch(() => {})
  let entry = moodboardById(entryId)
  if (!entry) {
    // Saved elsewhere since our last load (e.g. another window) — one retry.
    await refreshMoodboards().catch(() => {})
    entry = moodboardById(entryId)
  }
  return entry
}

/** The wire-apply side effects shared by the chip pick and a manual TASTE
 *  drag: auto-switch + marker + refs + chip identity — everything EXCEPT the
 *  prose block, which the wire itself carries (single-carrier rule). The
 *  positional model/model_options widget writes live here because the canvas
 *  owns the live node's widgetDefs. */
async function runMoodboardWireEffects(gen: any, entry: MoodboardEntry): Promise<void> {
  let files: string[] = []
  try {
    const res = await fetch(`/api/moodboards/images?folder=${encodeURIComponent(entry.folder)}`)
    if (res.ok) files = ((await res.json()).files ?? []) as string[]
  } catch { /* offline dev — effects proceed ref-less; the wire still styles */ }
  // Restyle: no model switch — its engine (Nano Banana 2) is already
  // multi-image and its selector is not the shared catalog. Attach the board
  // (identity + refs) and disconnect any wired single style image.
  if (gen.data?.nodeType === 'RestyleFromImageNode') {
    applyMoodboardToRestyleNode(gen.data, entry, files)
    disconnectStyleImageEdge(gen)
    return
  }
  const defs = (gen.data?.widgetDefs ?? []) as any[]
  const wv = gen.data?.widgetsValues
  const mIdx = defs.findIndex((d: any) => d?.name === 'model')
  const modelId = mIdx >= 0 && Array.isArray(wv) ? String(wv[mIdx] ?? '') : ''
  const modelTags = (IMAGE_MODELS_BY_ID[modelId]?.tags ?? []) as string[]
  const writes = applyMoodboardWireEffects(gen.data, entry, files, modelId, modelTags)
  if (writes.model && Array.isArray(wv)) {
    // Legible auto-switch (chip notice + Revert via the marker). Mirror the
    // switched-to model's advanced bag into the hidden model_options widget
    // (ModelGalleryModal's sync contract) so the backend doesn't read the
    // previous model's JSON.
    if (mIdx >= 0) wv[mIdx] = writes.model
    const optsIdx = defs.findIndex((d: any) => d?.name === 'model_options')
    if (optsIdx >= 0) wv[optsIdx] = JSON.stringify(gen.data.properties?.modelOptions?.[writes.model] ?? {})
  }
}

/** Chip pick → the REAL taste wire (sailor:moodboardWire, dispatched by
 *  LoraGalleryModal's moodboard confirm): find-or-create the board's
 *  Moodboard node beside the generator, sync its hidden widgets, draw the
 *  TASTE edge into style_in, then run the shared wire side effects. */
async function handleMoodboardWire(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string, entryId: string }>).detail
  if (!detail?.nodeId || !detail?.entryId) return
  const gen = (nodes.value as any[]).find(n => String(n.id) === String(detail.nodeId))
  if (!gen || !nodeTakesMoodboard(gen.data?.nodeType)) return
  const entry = await resolveMoodboardEntry(String(detail.entryId))
  if (!entry) return

  const styleInIdx = generatorStyleInIndex(gen)
  if (styleInIdx < 0) {
    console.warn('[Moodboard] generator has no style_in input (stale backend schema?) — not wired')
    return
  }

  // Find-or-create the board's node — identity is properties.sailor_moodboard.
  let mb = (nodes.value as any[]).find(n =>
    n?.data?.nodeType === 'Moodboard' && n?.data?.properties?.sailor_moodboard === entry.id)
  if (!mb) {
    if (!objectInfo.value['Moodboard']) await fetchObjectInfo()
    mb = createNodeData('Moodboard',
      { x: (gen.position?.x ?? 0) - 320, y: gen.position?.y ?? 0 },
      undefined, { sailor_moodboard: entry.id })
    nodes.value.push(mb)
    // Let vue-flow register the node + its handles before wiring to it —
    // otherwise the edge referencing it is pruned as invalid (splice pattern).
    await nextTick()
  }
  syncMoodboardWidgets(mb.data, entry)

  const styleOutIdx = Math.max(0,
    ((mb.data?.outputs ?? []) as any[]).findIndex((o: any) => o?.name === 'style'))
  const existing = tasteEdgesInto(String(gen.id))
  if (!existing.some(e2 => String(e2.source) === String(mb.id))) {
    addEdges([{
      source: String(mb.id), sourceHandle: `output-${styleOutIdx}`,
      target: String(gen.id), targetHandle: `input-${styleInIdx}`,
      type: 'comfy', data: { dataType: 'TASTE' },
    }])
  }
  // Re-pick replaces: a different board's edge into the same socket goes.
  // (Removed AFTER the new edge exists, so the removal hook's "still wired"
  // check keeps the freshly applied state.)
  const stale = existing.filter(e2 => String(e2.source) !== String(mb.id))
  if (stale.length) removeEdges(stale.map(e2 => e2.id))

  await runMoodboardWireEffects(gen, entry)
}

/** Chip ✕ (sailor:moodboardUnwire, dispatched by ComfyNode) → remove the
 *  TASTE edge(s) into this generator's style_in. The Moodboard node STAYS on
 *  canvas; the property clear happens in ComfyNode + the removal hook below
 *  (both idempotent). */
function handleMoodboardUnwire(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string }>).detail
  if (!detail?.nodeId) return
  const drop = tasteEdgesInto(String(detail.nodeId))
  if (drop.length) removeEdges(drop.map(e2 => e2.id))
}

/** Deleting a wired layer in a Frame (card or modal) has to take the slot's edge
 *  out with it — otherwise the backend keeps compositing pixels the editor no
 *  longer shows. The Frame surfaces dispatch this because only the canvas owns
 *  the graph's edges. `slot` is the 0-based input-port index. */
function handleFrameUnwireSlot(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string; slot: number }>).detail
  if (!detail?.nodeId || !Number.isInteger(detail.slot)) return
  const handle = `input-${detail.slot}`
  const drop = (edges.value as any[]).filter(
    (edge: any) => String(edge.target) === String(detail.nodeId) && edge.targetHandle === handle)
  if (drop.length) removeEdges(drop.map((edge: any) => edge.id))
}

/** Manual TASTE wire completion (drag onto style_in, or a wire dropped on the
 *  generator body that completes onto it): same side effects as a chip apply,
 *  minus the block write. Called from onConnect / completeConnectionOnNode. */
function maybeApplyTasteWire(sourceNode: any, targetNode: any, targetHandle?: string | null) {
  if (sourceNode?.data?.nodeType !== 'Moodboard') return
  if (!nodeTakesMoodboard(targetNode?.data?.nodeType)) return
  const idx = parseInt(String(targetHandle ?? '').replace('input-', ''))
  if (!Number.isFinite(idx) || targetNode.data?.inputs?.[idx]?.name !== 'style_in') return
  void (async () => {
    const entryId = String(sourceNode.data?.properties?.sailor_moodboard ?? '')
    if (!entryId) return // a board-less Moodboard node styles nothing
    const entry = await resolveMoodboardEntry(entryId)
    if (!entry) return
    // Replace semantics: another board's edge into the same socket goes.
    const stale = (edges.value as any[]).filter(e2 =>
      String(e2.target) === String(targetNode.id)
      && e2.targetHandle === `input-${idx}`
      && String(e2.source) !== String(sourceNode.id))
    if (stale.length) removeEdges(stale.map(e2 => e2.id))
    syncMoodboardWidgets(sourceNode.data, entry) // keep the twin's widgets fresh
    await runMoodboardWireEffects(targetNode, entry)
  })()
}

// Manual TASTE wire REMOVAL (edge select + delete, ✕, or deleting the
// Moodboard node) empties the generator's moodboard state so the chip reads
// true. Uses the change hook — NOT an absence watcher — because wholesale
// edge replacement on workflow load (setEdges) emits no remove changes, so a
// legacy property-applied board on a wire-less loaded graph is never cleared.
onEdgesChange((changes) => {
  const genIds = new Set<string>()
  for (const ch of changes as any[]) {
    if (ch?.type !== 'remove' || !ch.target) continue
    const gen = (nodes.value as any[]).find(n => String(n.id) === String(ch.target))
    if (!nodeTakesMoodboard(gen?.data?.nodeType)) continue
    const idx = parseInt(String(ch.targetHandle ?? '').replace('input-', ''))
    if (!Number.isFinite(idx) || gen.data?.inputs?.[idx]?.name !== 'style_in') continue
    genIds.add(String(gen.id))
  }
  if (!genIds.size) return
  // Check after the removal (and any same-tick re-wire) has landed: a board
  // re-pick replaces the edge and keeps state; a bare removal clears it.
  void nextTick().then(() => {
    for (const id of genIds) {
      if (tasteEdgesInto(id).length) continue
      const gen = (nodes.value as any[]).find(n => String(n.id) === String(id))
      if (gen?.data) clearMoodboardFromGenerateNode(gen.data)
    }
  })
})

// Texture Studio editor open-state (same pattern as Gradient Studio).
const textureStudioOpenForId = ref<string | null>(null)
function handleOpenTextureStudio(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) textureStudioOpenForId.value = String(detail.nodeId)
}

// Shape Studio editor open-state (same pattern as Gradient Studio).
const shapeStudioOpenForId = ref<string | null>(null)
function handleOpenShapeStudio(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) shapeStudioOpenForId.value = String(detail.nodeId)
}

// Vector Type editor open-state (same pattern as Shape Studio).
const vectorTypeOpenForId = ref<string | null>(null)
function handleOpenVectorType(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) vectorTypeOpenForId.value = String(detail.nodeId)
}

// Scene3D Studio editor open-state (same pattern as Shape Studio).
const scene3dStudioOpenForId = ref<string | null>(null)
function handleOpenScene3DStudio(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) scene3dStudioOpenForId.value = String(detail.nodeId)
}

// Shader Studio editor open-state (same pattern as Gradient Studio).
const shaderStudioOpenForId = ref<string | null>(null)
const shaderStudioWiredUrl = ref<string | null>(null)
function handleOpenShaderStudio(e: Event) {
  const detail = (e as CustomEvent).detail
  if (!detail?.nodeId) return
  shaderStudioOpenForId.value = String(detail.nodeId)
  // Resolve the wired image (input-0) now, from the canvas source of truth.
  shaderStudioWiredUrl.value = resolveWiredInput(String(detail.nodeId), nodes.value as any[], edges.value as any[])
}

// Shot Director editor open-state (same pattern as Texture Studio).
const shotDirectorOpenForId = ref<string | null>(null)
function handleOpenShotDirector(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) shotDirectorOpenForId.value = String(detail.nodeId)
}

/** "Animate" from an image artifact: upload the image as a Shot Director
 *  reference (input-dir copy — Replicate can't fetch output-dir views), spawn a
 *  ShotDirector node beside the artifact with the ref pre-seeded, and open its
 *  editor so the user aims the shot before any paid run. */
async function handleAnimateArtifact(e: Event) {
  const detail = (e as CustomEvent).detail || {}
  const src = (nodes.value as any[]).find(n => n.id === String(detail.nodeId))
  const imgUrl = src?.data?.images?.[0]
  if (!src || typeof imgUrl !== 'string') return
  try {
    const blob = await (await fetch(imgUrl)).blob()
    const refUrl = await uploadRefFile(new File([blob], 'animate.png', { type: blob.type || 'image/png' }))
    // Reference mode + composition-lock: "this exact picture, brought to life".
    // (firstFrame mode exists on the sheet but has no compile/dispatch wiring yet.)
    const sheet = addRef(hydrateShotSheet(undefined), 'image', refUrl, 'composition-lock')
    const pos = { x: (src.position?.x ?? 0) + 360, y: (src.position?.y ?? 0) }
    const node = createNodeData('ShotDirector', pos, undefined, { sailor_shotDirector: sheet })
    nodes.value.push(node)
    await nextTick()
    fitView({ nodes: [node.id], padding: 0.5, duration: 250 })
    shotDirectorOpenForId.value = String(node.id)
  } catch (err) {
    console.error('[Animate] spawn failed:', err)
    toast.error('Animate failed', { description: String((err as any)?.message || err).slice(0, 120) })
  }
}

// Lip-Sync Studio editor open-state (same pattern as Shot Director).
const lipSyncOpenForId = ref<string | null>(null)
function handleOpenLipSync(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) lipSyncOpenForId.value = String(detail.nodeId)
}

// Lip-Sync Studio Generate: resolve the voice (TTS → audio, else the supplied
// clip), compile the sheet, then find-or-spawn a LipSyncNode render target
// (class_type 'LipSyncNode', distinct from the 'LipSyncStudio' studio node),
// patch its widgets, and run it. Mirrors handleShotDirectorGenerate.
async function handleLipSyncGenerate(e: Event) {
  const detail = (e as CustomEvent<{ sourceNodeId: string }>).detail
  const studio = (nodes.value as any[]).find(n => String(n.id) === String(detail?.sourceNodeId))
  if (!studio) return
  if (!studio.data) studio.data = {}
  studio.data.lipSyncError = null

  const sheet = hydrateLipSyncSheet(studio.data?.properties?.sailor_lipSync)
  const compiled = compileLipSync(sheet)
  const errors = compiled.issues.filter(i => i.level === 'error')
  if (errors.length) { studio.data.lipSyncError = errors[0]!.message; return }

  // Resolve the voice audio.
  let audioUrl = String((compiled.modelOptions as Record<string, unknown>).audio || '')
  if (sheet.voice.kind === 'tts') {
    try {
      const res = await fetch('/api/lipsync/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sheet.voice.text ?? '', voiceId: sheet.voice.voiceId ?? '' }),
      })
      if (!res.ok) { studio.data.lipSyncError = `Voice generation failed (${res.status}).`; return }
      const data = await res.json() as { viewUrl?: string }
      if (!data.viewUrl) { studio.data.lipSyncError = 'Voice generation returned no audio.'; return }
      audioUrl = data.viewUrl
    } catch { studio.data.lipSyncError = 'Voice generation failed.'; return }
  }
  if (!audioUrl) { studio.data.lipSyncError = 'No voice audio to sync.'; return }

  const modelOptions = { ...compiled.modelOptions, audio: audioUrl }
  const patch: Record<string, unknown> = {
    engine: compiled.engine,
    resolution: compiled.resolution,
    sync_mode: sheet.syncMode,
    model_options: JSON.stringify(modelOptions),
  }

  // Find-or-spawn the LipSyncNode render target (remembered on the studio node).
  let targetId: string | null = studio.data?.properties?.sailor_lipSyncTargetId ?? null
  if (targetId && !(nodes.value as any[]).some(n => String(n.id) === String(targetId) && n.data?.nodeType === 'LipSyncNode')) {
    targetId = null
  }
  if (!targetId) {
    const pos = {
      x: (studio.position?.x ?? 0) + (studio.data?.size?.[0] ?? 280) + 80,
      y: studio.position?.y ?? 0,
    }
    const target = createNodeData('LipSyncNode', pos)
    nodes.value.push(target)
    targetId = String(target.id)
    if (!studio.data.properties) studio.data.properties = {}
    studio.data.properties.sailor_lipSyncTargetId = targetId
  }

  const target = (nodes.value as any[]).find(n => String(n.id) === String(targetId))
  if (!target) return

  const wnames = new Set(((target.data?.widgetDefs ?? []) as { name: string }[]).map(w => w.name))
  for (const name of Object.keys(patch)) {
    if (!wnames.has(name)) {
      studio.data.lipSyncError = `LipSyncNode has no '${name}' widget — restart ComfyUI to load it.`
      return
    }
  }
  for (const [name, value] of Object.entries(patch)) setNodeWidget(target, name, value)
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
    detail: { targetIds: [targetId], direction: 'downstream' },
  }))
}

/** Shot Director "Generate": compile the sheet, patch the (found-or-spawned)
 *  FilmShotNode's widgets, and hand off to the normal filtered run. No studio
 *  edge — ShotDirector bakes nothing, so we remember the target id instead. */
function setNodeWidget(node: any, name: string, value: unknown): boolean {
  const defs = (node.data?.widgetDefs ?? []) as { name: string }[]
  const i = defs.findIndex(w => w.name === name)
  if (i < 0) return false
  if (!Array.isArray(node.data.widgetsValues)) node.data.widgetsValues = []
  node.data.widgetsValues[i] = value
  return true
}

async function handleShotDirectorGenerate(e: Event) {
  const detail = (e as CustomEvent<{ sourceNodeId: string }>).detail
  const studio = (nodes.value as any[]).find(n => String(n.id) === String(detail?.sourceNodeId))
  if (!studio) return
  if (!studio.data) studio.data = {}
  studio.data.shotError = null

  const sheet = hydrateShotSheet(studio.data?.properties?.sailor_shotDirector)

  let effectiveSheet = sheet
  let castIssues: import('~/lib/shotdirector/rules').ValidationIssue[] = []
  let castDescriptors: Record<string, string> = {}
  if (sheet.cast.length) {
    const store = useCharacters()
    await store.refresh()  // generate-time truth, same guarantee the old re-fetch gave
    const picks = sheet.cast.map(m => ({ slug: m.slug, stateId: m.stateId }))
    const resolved = store.resolveStateRefs(picks)
    const mat = materializeCast(sheet, resolved, getProfile('seedance-2.0'))
    effectiveSheet = mat.sheet
    castIssues = mat.issues
    castDescriptors = store.stateDescriptors(picks)
  }
  const result = compileShot(effectiveSheet, getProfile('seedance-2.0'), { castDescriptors })
  const errors = [...castIssues, ...result.issues].filter(i => i.level === 'error')
  if (errors.length) {
    studio.data.shotError = errors[0]!.message
    return
  }

  const patch = buildFilmShotPatch(effectiveSheet, result)
  const lite = (nodes.value as any[]).map(n => ({ id: String(n.id), nodeType: n.data?.nodeType as string | undefined }))
  const liteEdges = (edges.value as any[]).map(e => ({ source: String(e.source), target: String(e.target) }))
  let targetId = findShotTarget(lite, liteEdges, String(studio.id), studio.data?.properties?.sailor_shotDirectorTargetId)

  if (!targetId) {
    const pos = {
      x: (studio.position?.x ?? 0) + (studio.data?.size?.[0] ?? 280) + 80,
      y: studio.position?.y ?? 0,
    }
    const film = createNodeData('FilmShotNode', pos)
    nodes.value.push(film)
    targetId = String(film.id)
    if (!studio.data.properties) studio.data.properties = {}
    studio.data.properties.sailor_shotDirectorTargetId = targetId
  }

  const film = (nodes.value as any[]).find(n => String(n.id) === targetId)
  if (!film) return

  // Validate all patch keys exist in film's widgetDefs before writing anything
  const filmWidgetDefs = (film.data?.widgetDefs ?? []) as { name: string }[]
  const filmWidgetNames = new Set(filmWidgetDefs.map(w => w.name))
  for (const name of Object.keys(patch)) {
    if (!filmWidgetNames.has(name)) {
      studio.data.shotError = `FilmShotNode has no '${name}' widget — is the backend catalog stale?`
      return
    }
  }

  // All keys validated; write the patch
  for (const [name, value] of Object.entries(patch)) {
    setNodeWidget(film, name, value)
  }
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
    detail: { targetIds: [targetId], direction: 'downstream' },
  }))
}

/** Reads a Character/CharacterSheet node's single sailor_characterBinding
 *  property, falling back (read-time only) to the three legacy
 *  sailor_character{Slug,Name,VariantId} props for nodes saved before the
 *  binding existed. Writes only ever produce the binding. */
function characterBindingOf(n: any): { slug: string; name: string; stateId: string | null } | null {
  const props = n?.data?.properties
  const b = props?.sailor_characterBinding
  if (b && typeof b.slug === 'string') {
    return { slug: b.slug, name: typeof b.name === 'string' ? b.name : b.slug, stateId: normalizeStateId(b.stateId ?? null) }
  }
  const legacySlug = props?.sailor_characterSlug
  if (typeof legacySlug === 'string') {
    return {
      slug: legacySlug,
      name: props?.sailor_characterName || legacySlug,
      stateId: normalizeStateId(props?.sailor_characterVariantId ?? null),
    }
  }
  return null
}

/** Edge ⇄ cast sync: canvas wires (Character → Shot Director input-N) are one
 *  editor of sheet.cast (via:'wire'); the picker (Task 10) is the other.
 *  Recomputed on every edge/property change so the two stay consistent. */
function syncAllShotDirectorCasts() {
  const liteNodes = (nodes.value as any[]).map(n => ({
    id: String(n.id), nodeType: n.data?.nodeType as string | undefined,
    binding: characterBindingOf(n),
  }))
  const liteEdges = (edges.value as any[]).map(e => ({
    source: String(e.source), target: String(e.target), targetHandle: e.targetHandle ?? null,
  }))
  for (const n of nodes.value as any[]) {
    if (n.data?.nodeType !== 'ShotDirector') continue
    const raw = n.data?.properties?.sailor_shotDirector
    const sheet = hydrateShotSheet(raw)
    const next = syncCast(sheet.cast, wireCastFor(String(n.id), liteNodes, liteEdges))
    if (next) {
      if (!n.data.properties) n.data.properties = {}
      n.data.properties.sailor_shotDirector = { ...sheet, cast: next }
    }
  }
}

/** Uncast from the surface (Task 7's chip 'x'): remove the actual wire so the
 *  canvas stays the source of truth for wired members. */
function handleUncastCharacter(payload: CharacterBusEvents['uncastCharacter']) {
  const { nodeId, slug } = payload ?? {}
  if (!nodeId || !slug) return
  const drop = (edges.value as any[]).filter((ed) => {
    if (String(ed.target) !== String(nodeId)) return false
    const src = (nodes.value as any[]).find(n => String(n.id) === String(ed.source))
    return characterBindingOf(src)?.slug === slug
  })
  if (drop.length) removeEdges(drop.map((d: any) => d.id))
}

// Keyed on edge topology, not on a deep traversal of `edges` (whose objects
// reach back into every node): cast sync only cares about wiring, and the
// deep version re-walked the whole graph on every drag frame.
watch(() => edgeTopologyKey(edges.value as any[]), () => syncAllShotDirectorCasts())

// Space Type "Generate as image/video": create the artifact node to the right of
// the SpaceType node and draw a provenance edge from the SpaceType node's single
// wildcard output into the artifact's primary input (Image=`images`, Video=`source`).
// The artifact still shows its file via the widget regardless of the edge — this
// link is visual only (SpaceType has no backend and never executes).
/** Send a Space Type studio snapshot to a Timeline node as a live clip.
 *
 *  Targeting, in order: the node a Timeline editor is currently open on; else a
 *  selected Timeline node; else the only one on the canvas. With several and no
 *  hint, we ask rather than guess — sending to an arbitrary timeline is worse
 *  than doing nothing.
 *
 *  Two write paths, and the distinction matters: useTimelineStore's `state` is a
 *  module-level singleton that bind() replaces wholesale when an editor opens.
 *  So we mutate the store ONLY for the node it is bound to (otherwise our clip
 *  is discarded on the next open, or persisted onto the wrong node), and write
 *  the target's persisted edit_state directly in every other case. */
function sendSpaceTypeToTimeline(state: SpaceTypeState, sourceNodeId: string) {
  const timelines = (nodes.value as any[]).filter(n => n.data?.nodeType === 'Timeline')
  if (!timelines.length) {
    toast.error('No Timeline node', { description: 'Add a Timeline node to send this clip to.' })
    return
  }

  const store = useTimelineStore()
  const bound = store.boundNodeId()
  const selected = timelines.filter(n => n.selected)

  const target =
    (bound && timelines.find(n => n.id === bound)) ||
    (selected.length === 1 ? selected[0] : null) ||
    (timelines.length === 1 ? timelines[0] : null)

  if (!target) {
    toast.error('Which timeline?', {
      description: `${timelines.length} Timeline nodes — select one, or open its editor, then send again.`,
    })
    return
  }

  // Bound node: the live editor's in-memory state is authoritative, so route
  // through the store (which persists via syncToWidget on the same tick).
  if (bound === target.id) {
    const track = store.state.value.tracks.find(t => t.kind === 'video')
    if (!track) { toast.error('No video track', { description: 'This timeline has no video track.' }); return }
    store.addSpaceTypeClip(track.id, store.playheadFrame.value ?? 0, state, sourceNodeId)
    toast.success('Sent to timeline')
    return
  }

  // Unbound node: read / modify / write its persisted edit_state.
  if (!target.data.properties) target.data.properties = {}
  const result = addSpaceTypeClipToEditState(target.data.properties.edit_state, state, sourceNodeId, 0)
  if (!result) { toast.error('No video track', { description: 'This timeline has no video track.' }); return }
  target.data.properties.edit_state = result.json
  toast.success('Sent to timeline', { description: 'Open the Timeline node to see the clip.' })
}

function handleSpaceTypeOutput(e: Event) {
  const detail = (e as CustomEvent<{ sourceNodeId: string; nodeType: string; widgetOverrides?: Record<string, unknown>; state?: SpaceTypeState }>).detail
  // "Send to timeline" (Type Studio): snapshot the studio state onto a new
  // SpaceTypeClip on the shared timeline store, rather than materializing a
  // new canvas node like the Image/Video branches below.
  if (detail.nodeType === 'TimelineClip') {
    if (!detail.state) { console.warn('spaceTypeOutput: TimelineClip dispatched with no state'); return }
    sendSpaceTypeToTimeline(detail.state, detail.sourceNodeId)
    return
  }
  const src = (nodes.value as any[]).find((n) => n.id === detail.sourceNodeId)
  const pos = src
    ? { x: (src.position?.x ?? 0) + (src.data?.size?.[0] ?? 240) + 80, y: src.position?.y ?? 0 }
    : project({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const node = createNodeData(detail.nodeType, pos, detail.widgetOverrides)
  // The artifact is wired to the frontend-only Space Type node, so its upstream
  // branch suppresses the widget-file fallback. Stamp data.images with the
  // generated file so the card shows it directly (checked before hasUpstream).
  const fname = (detail.widgetOverrides?.image ?? detail.widgetOverrides?.file) as string | undefined
  if (fname) (node.data as any).images = [`/view?${new URLSearchParams({ filename: String(fname), type: 'input' })}`]
  nodes.value.push(node)
  if (src) {
    // Primary input: `images` for Image, `source` for Video — fall back to slot 0.
    const wantInput = detail.nodeType === 'Video' ? 'source' : 'images'
    const ins = (node.data?.inputs ?? []) as any[]
    let inIdx = ins.findIndex((i) => i.name === wantInput)
    if (inIdx < 0) inIdx = ins.length ? 0 : -1
    if (inIdx >= 0) {
      edges.value.push({
        id: `e-spacetype-${node.id}`,
        source: src.id,
        sourceHandle: 'output-0',
        target: node.id,
        targetHandle: `input-${inIdx}`,
        type: 'comfy',
        data: { dataType: ins[inIdx]?.type ?? '*' },
      } as any)
    }
  }
}

// sailor:spawnBeside: spawn a node beside a source node, with optional
// widget/property/data overrides from the event detail. Placement mirrors
// handleSpaceTypeOutput; unlike that handler this draws NO edge (the spawned
// node is an independent, unwired sibling) and never auto-runs — the user
// aims it, then runs it themselves.
function handleSpawnBeside(e: Event) {
  const detail = (e as CustomEvent<{
    sourceNodeId: string
    nodeType: string
    widgetOverrides?: Record<string, unknown>
    propertyOverrides?: Record<string, unknown>
    dataOverrides?: Record<string, unknown>
  }>).detail
  const src = (nodes.value as any[]).find((n) => n.id === detail.sourceNodeId)
  const pos = src
    ? { x: (src.position?.x ?? 0) + (src.data?.size?.[0] ?? 240) + 80, y: src.position?.y ?? 0 }
    : project({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const node = createNodeData(detail.nodeType, pos, detail.widgetOverrides, detail.propertyOverrides)
  if (detail.dataOverrides && typeof detail.dataOverrides === 'object') {
    node.data = { ...node.data, ...detail.dataOverrides }
  }
  nodes.value.push(node)
  nextTick(() => fitView({ nodes: [node.id], padding: 0.5, duration: 250 }))
}

/** Apply a name→value widget bundle onto an EXISTING node in-place (mirrors the
 *  widget-def-index mapping createNodeData does at creation). Used to refresh the
 *  transient sketch pad's prompt/seed on a re-sketch without minting a new node. */
function applyWidgetOverridesTo(node: any, overrides: Record<string, unknown>) {
  const defs = (node.data?.widgetDefs ?? []) as any[]
  const wv = Array.isArray(node.data?.widgetsValues) ? [...node.data.widgetsValues] : []
  for (const [name, value] of Object.entries(overrides)) {
    const idx = defs.findIndex((w: any) => w.name === name)
    if (idx >= 0) wv[idx] = value
  }
  node.data = { ...node.data, widgetsValues: wv }
}

/** Sketch NODE flow: a visible sketch generator's multi-image batch presents
 *  as a pile to its right (the choose-one surface). The node's own take/
 *  filmstrip append stays untouched — provenance and Light Table keep working.
 *  Re-runs refresh the same pile (found by payload.sourceNodeId). */
function materializeSketchPileBeside(source: any, images: string[], params: Record<string, unknown> = {}): void {
  const prompt = typeof params.prompt === 'string' ? params.prompt : ''
  const seed = typeof params.seed === 'number' ? params.seed : 0
  const existing = (nodes.value as any[]).find(
    (n: any) => n?.data?.properties?.[SKETCH_PROP]?.sourceNodeId === String(source.id))
  if (existing) {
    const prev = existing.data.properties[SKETCH_PROP] as SketchPilePayload
    existing.data = {
      ...existing.data,
      properties: { ...existing.data.properties, [SKETCH_PROP]: refreshSketchPile(prev, { images, prompt, seed }) },
    }
    return
  }
  const pos = {
    x: (source.position?.x ?? 0) + (source.data?.size?.[0] ?? 240) + 80,
    y: source.position?.y ?? 0,
  }
  const node = createNodeData('SketchPile', pos, undefined, {
    [SKETCH_PROP]: buildSketchPilePayload({ prompt, seed, sourceNodeId: String(source.id), images }),
  })
  ;(nodes.value as any[]).push(node)
}

/** Prompt-bar entry: render 4 cheap Schnell options for `prompt` at the pad. */
async function startSketch(prompt: string): Promise<void> {
  // Strip the draft/command wrapper ("sketch me a…") so the image is of the
  // SUBJECT, not a literal pencil sketch — the fast-path hands us raw text.
  const clean = cleanSketchPrompt(prompt.trim())
  if (!clean) return
  // A fresh prompt-bar submission (as opposed to Re-roll, which reuses the
  // open strip) replaces whatever the strip was showing. Open it NOW, in its
  // loading state (no images, no error → 4 pulsing skeleton tiles) — a cold
  // Replicate boot can take 10-20s, and the old behaviour of staying closed
  // until the whole batch landed left the user staring at nothing that long.
  // The `executed`/`execution_error` handlers fill it in or flip it to error.
  sketchReview.open = true
  sketchReview.images = []
  sketchReview.selected = null
  sketchReview.error = false
  sketchReviewBusy.value = true
  sketchPad.prompt = clean
  sketchPad.seed = Math.floor(Math.random() * 2_147_483_647)
  if (!sketchPad.anchor) {
    sketchPad.anchor = sketchPadAnchor()
  }

  // Transient hidden pad node drives the proven dispatch pipeline. Reused by
  // its stored NUMERIC id (sketchPad.padNodeId). Created BEFORE the skeleton
  // pile — the pile's payload needs sourceNodeId = String(sketchPad.padNodeId).
  const { widgetOverrides, propertyOverrides } = sketchPadPromptOverrides(clean, sketchPad.seed)
  let pad = sketchPad.padNodeId != null
    ? (nodes.value as any[]).find((n: any) => n.id === sketchPad.padNodeId) as any
    : null
  if (!pad) {
    pad = createNodeData('GenerateImageNode', sketchPad.anchor, widgetOverrides, propertyOverrides)
    // Keep the natural numeric id createNodeData/mintNodeId assigned — do NOT
    // force a string id here (would serialize to NaN and drop from the run).
    pad.hidden = true // VueFlow: kept out of the rendered graph
    ;(nodes.value as any[]).push(pad)
    sketchPad.padNodeId = pad.id
  } else {
    applyWidgetOverridesTo(pad, widgetOverrides)
    pad.position = sketchPad.anchor
  }

  await nextTick()
  // Scoped run of just the pad node (never the whole graph). skipCostConfirm:
  // sketches are the cheap tier; the meter still bills normally.
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds: [sketchPad.padNodeId], direction: 'self', skipCostConfirm: true } }))
}

/** Tear down the transient prompt-bar sketch-pad plumbing — the hidden
 *  generator node and its auto-created hidden sink (materializeAutoImageSinks
 *  wires exactly one, satisfying ComfyUI's "prompt has no outputs" check) —
 *  and reset `sketchPad` to its empty shape. `removeNodes` also drops any
 *  edges touching them (default `removeConnectedEdges`), so the sink's wire
 *  goes with it. Called on every path that ends the review (Keep, dropAt,
 *  Cancel) so no orphan node survives the strip closing. */
function teardownSketchReview(): void {
  const ids: string[] = []
  if (sketchPad.padNodeId != null) {
    ids.push(String(sketchPad.padNodeId))
    for (const e of edges.value as any[]) {
      if (e.source !== String(sketchPad.padNodeId)) continue
      const t = (nodes.value as any[]).find((n: any) => String(n.id) === String(e.target))
      if (t?.data?.properties?.sketchSink === true) ids.push(String(t.id))
    }
  }
  // Defensive: a pile node shouldn't exist under the strip flow, but clean up
  // one left over from an interrupted transition rather than leak it.
  if (sketchPad.pileNodeId != null) ids.push(String(sketchPad.pileNodeId))
  if (ids.length) removeNodes(ids)
  sketchPad.anchor = null
  sketchPad.seed = 0
  sketchPad.prompt = ''
  sketchPad.promptId = null
  sketchPad.padNodeId = null
  sketchPad.pileNodeId = null
}

/** Keep: commit `sketchReview.images[sketchReview.selected]` as a plain Image
 *  card at the keeper spot. Reuses `planKeptCard` — the SAME plan the sketch-
 *  stack overlay's Keep uses per item — so the committed node is identical to
 *  today's kept sketch; there's just no pile node behind it to update. */
function onSketchKeep(): void {
  const idx = sketchReview.selected
  if (idx != null) {
    const anchor = sketchPad.anchor ?? sketchPadAnchor()
    const payload = buildSketchPilePayload({
      prompt: sketchPad.prompt,
      seed: sketchPad.seed,
      sourceNodeId: String(sketchPad.padNodeId ?? ''),
      images: sketchReview.images,
    })
    const plan = planKeptCard(anchor, payload, idx)
    if (plan) {
      const imageWidgetValue = annotatedImageValueFromViewUrl(plan.image)
      const card = createNodeData(plan.nodeType, plan.position,
        imageWidgetValue ? { image: imageWidgetValue } : undefined)
      card.data = { ...card.data, images: [plan.image] }
      ;(nodes.value as any[]).push(card)
    }
  }
  teardownSketchReview()
  sketchReview.open = false
  // Don't let the committed batch linger in memory until the next prompt.
  sketchReview.images = []
  sketchReview.selected = null
}

/** Drag-to-place: commit `sketchReview.images[index]` under the drop point.
 *  Same plain-Image-card construction as Keep (and keepSketchStackItem), just
 *  positioned at the projected cursor point instead of the keeper column —
 *  top-left offset by half the keeper card size so the card is centered
 *  under the cursor, not tucked under its corner. */
function onSketchDropAt(payload: { index: number, clientX: number, clientY: number }): void {
  const src = sketchReview.images[payload.index]
  if (src) {
    const p = project({ x: payload.clientX, y: payload.clientY })
    const half = KEEP_CARD_SIZE / 2
    const position = { x: p.x - half, y: p.y - half }
    const imageWidgetValue = annotatedImageValueFromViewUrl(src)
    const card = createNodeData('Image', position, imageWidgetValue ? { image: imageWidgetValue } : undefined)
    card.data = { ...card.data, images: [src] }
    ;(nodes.value as any[]).push(card)
  }
  teardownSketchReview()
  sketchReview.open = false
  // Don't let the committed batch linger in memory until the next prompt.
  sketchReview.images = []
  sketchReview.selected = null
}

/** Cancel: discard all four, tear down the pad, close the strip. No node. */
function onSketchCancel(): void {
  teardownSketchReview()
  sketchReview.open = false
  // Don't let the discarded batch linger in memory until the next prompt.
  sketchReview.images = []
  sketchReview.selected = null
}

/** Re-roll: fresh seed onto the SAME pad node + the same scoped run the
 *  initial sketch used. The new batch lands back in the strip via the
 *  `executed`-handler diversion above (replacing `sketchReview.images`) — the
 *  strip itself stays open and busy until it does. */
function onSketchReroll(): void {
  if (sketchPad.padNodeId == null) return
  const pad = (nodes.value as any[]).find((n: any) => n.id === sketchPad.padNodeId)
  if (!pad) return
  const seed = Math.floor(Math.random() * 2_147_483_647)
  applyWidgetOverridesTo(pad, { seed })
  sketchPad.seed = seed
  sketchReview.selected = null
  sketchReview.error = false
  sketchReviewBusy.value = true
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
    detail: { targetIds: [sketchPad.padNodeId], direction: 'self', skipCostConfirm: true },
  }))
}

function onSketchSelect(i: number): void { sketchReview.selected = i }

// Speculative warm (Task 7, spec §6 lever 2): a throwaway single-output
// Schnell dispatch fired on prompt-bar focus so the Replicate endpoint isn't
// cold when the user actually submits an idea. Cooldown-gated to at most once
// per 3 minutes, and reuses ONE dedicated hidden node across calls (never
// accumulates). Its result is discarded outright — see the `sketchWarm`
// property check in the `executed` handler (never materializes cards) and the
// matching exclusions in materializeAutoImageSinks (never wires an auto-sink)
// and getWorkflow (never rides a full-canvas Run or a saved doc). The
// call site (CanvasPromptBar) gates this behind a local setting that
// defaults OFF, so this cooldown is the only thing stopping a caller from
// re-firing it — it does NOT re-check that setting itself.
let warmPadNodeId: string | number | null = null
let lastWarm = 0
async function warmSketch(): Promise<void> {
  const now = performance.now()
  if (now - lastWarm < 180_000) return // cooldown: at most once per 3 min
  lastWarm = now
  const seed = Math.floor(Math.random() * 2_147_483_647)
  const widgetOverrides = {
    model: 'flux-schnell',
    prompt: 'warm', // throwaway — content is irrelevant, the result is always discarded
    seed,
    model_options: JSON.stringify({ megapixels: '0.25', num_outputs: 1, output_format: 'webp' }),
  }
  // Off-canvas position: harmless either way since the node is hidden:true and
  // never rendered, but keeps it out from underfoot of sketchPadAnchor's
  // collision nudging for the real (visible) pad.
  const anchor = { x: -100_000, y: -100_000 }
  let pad = warmPadNodeId != null
    ? (nodes.value as any[]).find((n: any) => n.id === warmPadNodeId) as any
    : null
  if (!pad) {
    pad = createNodeData('GenerateImageNode', anchor, widgetOverrides, { sketchWarm: true })
    pad.hidden = true // VueFlow: kept out of the rendered graph
    ;(nodes.value as any[]).push(pad)
    warmPadNodeId = pad.id
  } else {
    applyWidgetOverridesTo(pad, widgetOverrides)
  }
  await nextTick()
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds: [warmPadNodeId], direction: 'self', skipCostConfirm: true } }))
}

// Character Library panel "Use in image": the panel now asks explicitly
// (Task 12) — 'lora' always means the trained FluxLoRARemoteNode (errors if
// the character has no loraName yet, rather than silently falling back to
// the sheet); 'sheet' always means the wired Image → ConsistentFaceNode pair
// seeded from the default variant's cover photo, even for characters that DO
// have a LoRA. No silent fork either way. Always re-fetches the registry
// (same pattern as handleShotDirectorGenerate) rather than trusting the panel's cache.
async function handleAddCharacterImageGen(payload: CharacterBusEvents['addCharacterImageGen']) {
  const { slug, use } = payload ?? {}
  if (!slug) return
  const store = useCharacters()
  await store.refresh()
  const character = store.characters.value.find(c => c.slug === slug)
  if (!character) {
    toast.error('Couldn\'t load the character — try again')
    return
  }

  const pos = project({ x: window.innerWidth / 2, y: window.innerHeight / 2 })

  if (use === 'lora') {
    if (!character.loraName) {
      toast.error(`No trained identity for ${character.name} yet — train one first`)
      return
    }
    nodes.value.push(createNodeData('FluxLoRARemoteNode', pos, {
      prompt: character.trigger ? `${character.trigger}, ` : '',
      lora_name: character.loraName,
      lora_scale: 1.0,
    }))
    return
  }

  const cover = identityRefs(defaultState(character))[0]
  if (!cover) {
    toast.error(`Add a photo to ${character.name} first`)
    return
  }

  // imgNode must be pushed before faceNode is minted: mintNodeId() only
  // dedupes against nodes.value at call time, and both createNodeData calls
  // land in the same millisecond often enough that Date.now() collides —
  // the second call would silently reuse imgNode's id if it ran first.
  const imgNode = createNodeData('Image', pos, { image: cover })
  nodes.value.push(imgNode)
  const faceNode = createNodeData('ConsistentFaceNode', { x: pos.x + (imgNode.data?.size?.[0] ?? 220) + 80, y: pos.y })
  nodes.value.push(faceNode)

  const ins = (faceNode.data?.inputs ?? []) as any[]
  const inIdx = ins.findIndex((i) => i.name === 'reference_image')
  if (inIdx >= 0) {
    edges.value.push({
      id: 'e-' + mintNodeId(),
      source: imgNode.id,
      sourceHandle: 'output-0',
      target: faceNode.id,
      targetHandle: `input-${inIdx}`,
      type: 'comfy',
      data: { dataType: ins[inIdx]?.type ?? 'IMAGE' },
    } as any)
  }
}

// Character Library panel "Cast in shot": drop a picked Character card on the
// canvas so it can be wired into a Shot Director's cast slots (Task 11 syncs the edge).
function handleAddCharacterCastNode(payload: CharacterBusEvents['addCharacterCastNode']) {
  const { slug, name, stateId } = payload ?? {}
  if (!slug || !name) return
  const pos = project({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  nodes.value.push(createNodeData('Character', pos, undefined, {
    sailor_characterBinding: { slug, name, stateId: normalizeStateId(stateId ?? null) },
  }))
  emitCharacterEvent('castEdgesChanged')
}

// Studio render cascade: a studio node's footer "Render" button re-bakes it and
// (for the downstream scope) every chained studio, updating the image node between
// each, then hands any real backend tail to the existing filtered run.
// Side-effect deps for the studio cascade — shared by the footer Render button
// (handleStudioRender) and the pre-run bake (bakeUpstreamStudios).
async function studioCascadeDeps(): Promise<CascadeDeps> {
  const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
  return {
    getNodes: () => nodes.value as any[],
    getEdges: () => edges.value as any[],
    upload: async (blob, prefix) => { const [f] = await uploadFrameBatch([blob], prefix); return f ?? null },
    publish: (studioId, filename) => publishStudioOutput(studioId, filename),
    runBackendDownstream: (startId) => window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds: [startId], direction: 'downstream' } })),
    setBusy: (nodeId, busy) => {
      const n = (nodes.value as any[]).find(x => String(x.id) === String(nodeId))
      if (n) { if (!n.data) n.data = {}; (n.data as any).studioBusy = busy }
    },
  }
}

async function handleStudioRender(e: Event) {
  const detail = (e as CustomEvent<{ sourceNodeId: string; scope?: 'self' | 'upstream' | 'downstream' }>).detail
  if (!detail?.sourceNodeId) return
  const scope = detail.scope ?? 'self'
  const node = (nodes.value as any[]).find(n => String(n.id) === String(detail.sourceNodeId))
  // 3D Studio is a REAL backend node with no server-side renderer: re-bake its
  // three passes client-side (updating the widgets the card + a Run replay), then
  // hand off to the normal downstream backend run so wired consumers get the
  // fresh files. It never goes through the frontend studio cascade.
  if (node?.data?.nodeType === 'Scene3DStudio') {
    const rebake = getScene3DRebaker(detail.sourceNodeId)
    if (rebake) {
      const deps = await studioCascadeDeps()
      deps.setBusy?.(detail.sourceNodeId, true)
      try { await rebake() }
      catch (err) { console.error('[scene3d-render] rebake failed', err) }
      finally { deps.setBusy?.(detail.sourceNodeId, false) }
    }
    if (scope !== 'upstream') {
      window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds: [detail.sourceNodeId], direction: 'downstream' } }))
    }
    return
  }
  await runStudioCascade(detail.sourceNodeId, scope, await studioCascadeDeps())
}

// Bake+publish every studio upstream of a run's targets BEFORE it submits.
// Studios are frontend-only (no backend class_type), so a run strips them — an
// image node fed by an un-baked studio would otherwise run with a null input and
// render nothing (that's the "studio doesn't render the image" bug). Baking each
// (scope 'self' → no backend tail) publishes its output onto the downstream image
// node, which the run then serializes as a real uploaded input. `targetIds`
// omitted = every studio (a global Run loads the whole graph).
async function bakeUpstreamStudios(targetIds?: string[]): Promise<void> {
  const ids = planStudiosToBakeForRun(targetIds, nodes.value as any[], edges.value as any[])
    .filter(hasStudioBaker)   // skip unmounted/off-screen studios (can't bake)
  if (!ids.length) return
  const deps = await studioCascadeDeps()
  for (const id of ids) await runStudioCascade(id, 'self', deps)
}

/** Write a studio's fresh output to its downstream image node(s) (create one if none).
 *  The Frame holds its own composite, so it updates its OWN data.images instead. */
function publishStudioOutput(studioId: string, filename: string) {
  const url = `/view?${new URLSearchParams({ filename, type: 'input' })}`
  const self = (nodes.value as any[]).find(n => String(n.id) === String(studioId))
  if (self && self.type === 'artifact-frame') {
    if (!self.data) self.data = {}
    self.data.images = [url]
    return
  }
  // Every image node fed by this studio's output (usually one).
  const targets = (edges.value as any[])
    .filter(e => String(e.source) === String(studioId) && (e.sourceHandle === 'output-0' || !e.sourceHandle))
    .map(e => (nodes.value as any[]).find(n => String(n.id) === String(e.target)))
    .filter((n): n is any => !!n && (
      n.data?.nodeType === 'Image' || String(n.type).startsWith('artifact-') || isStudioNode(n)
    ))
  if (!targets.length) {
    // No artifact yet — reuse the studio-output handler to create + wire one.
    window.dispatchEvent(new CustomEvent('sailor:spaceTypeOutput', { detail: { sourceNodeId: studioId, nodeType: 'Image', widgetOverrides: { image: filename } } }))
    return
  }
  for (const art of targets) {
    // A downstream *studio* re-resolves its own input from the graph (its live
    // frame source, or an upstream file) — stamping its data.images would be wrong:
    // if it later feeds another node, resolveSrcUrl would hand that node THIS
    // upstream's file instead of the studio's own render. So skip the stamp, but it
    // must still count as a target so the fallback above doesn't spawn a stray node.
    if (isStudioNode(art) && !isArtifactNode(art)) continue
    // A Frame is also skipped: its data.images IS its own composite output, and it
    // composites its wired slots itself (reading an upstream studio live via the
    // shared resolver). Stamping the studio's file here overwrites the composite —
    // the clobber bug where a studio wired to a Frame replaced the Frame's output.
    if (String(art.type) === 'artifact-frame') continue
    if (!art.data) art.data = {}
    art.data.images = [url]
    // Also stamp the `image` widget so a card with an upstream link still shows the new file.
    const wi = art.data.widgetDefs?.findIndex((w: any) => w.name === 'image') ?? -1
    if (wi >= 0) { if (!Array.isArray(art.data.widgetsValues)) art.data.widgetsValues = []; art.data.widgetsValues[wi] = filename }
  }
}

// Inpaint modal state (dedicated editor for an Image artifact).
const inpaintOpenForId = ref<string | null>(null)
const inpaintIntent = ref<'remove' | 'recolor' | null>(null)
function handleOpenInpaint(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) {
    inpaintOpenForId.value = String(detail.nodeId)
    inpaintIntent.value = detail.intent === 'remove' || detail.intent === 'recolor' ? detail.intent : null
  }
}

// Pose Mannequin 3D editor modal state.
const poseOpenForId = ref<string | null>(null)
function handleOpenPose(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) poseOpenForId.value = String(detail.nodeId)
}

// Find (or create) the downstream artifact-image sink wired from a pose node's
// IMAGE output. Returns the sink node. Shared by handlePoseResult (editor path)
// and handlePoseGenerate (image/prompt graph-run path) — materializeAutoImageSinks
// skips PoseMannequin, so we wire the sink ourselves.
function ensurePoseImageSink(poseNode: any): any {
  const nodeId = String(poseNode.id)
  let outIdx = (poseNode.data?.outputs ?? []).findIndex((o: any) => String(o.type).toUpperCase() === 'IMAGE')
  if (outIdx < 0) outIdx = 0
  const handle = `output-${outIdx}`

  for (const ed of edges.value as any[]) {
    if (ed.source !== nodeId || ed.sourceHandle !== handle) continue
    const t = (nodes.value as any[]).find(n => n.id === ed.target)
    if (t && t.data?.nodeType === 'Image') return t
  }

  const srcPos = poseNode.position || { x: 0, y: 0 }
  const srcW = (poseNode.data?.size?.[0] ?? 200) as number
  const sink = createNodeData('Image', { x: srcPos.x + srcW + 80, y: srcPos.y })
  const ei = sink.data.widgetDefs?.findIndex((w: any) => w.name === 'export') ?? -1
  if (ei >= 0) sink.data.widgetsValues[ei] = true
  sink.data.size = [240, 280]
  nodes.value.push(sink)
  edges.value.push({
    id: `e-pose-${sink.id}`,
    source: nodeId, sourceHandle: handle,
    target: sink.id, targetHandle: 'input-0',
    type: 'comfy', data: { dataType: 'IMAGE' },
  } as any)
  return sink
}

// A Pose Mannequin generation finished in the editor: route the result image to
// a downstream artifact-image node (the pose node itself only shows the pose).
// We can't reuse materializeAutoImageSinks here — PoseMannequin is in
// ARTIFACT_NODE_COMPONENTS (for its custom renderer), so that helper skips it.
function handlePoseResult(e: Event) {
  const detail = (e as CustomEvent).detail
  const nodeId = detail?.nodeId ? String(detail.nodeId) : null
  const filename = detail?.filename ? String(detail.filename) : null
  if (!nodeId || !filename) return
  const poseNode = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!poseNode) return

  const sink: any = ensurePoseImageSink(poseNode)

  // Display the result + persist it as the sink's own image.
  sink.data.images = [`/view?${new URLSearchParams({ filename, type: 'input' })}`]
  const wi = sink.data.widgetDefs?.findIndex((w: any) => w.name === 'image') ?? -1
  if (wi >= 0) {
    if (!Array.isArray(sink.data.widgetsValues)) sink.data.widgetsValues = []
    sink.data.widgetsValues[wi] = filename
    const def = sink.data.widgetDefs[wi]
    if (def && Array.isArray(def.options) && !def.options.includes(filename)) def.options.push(filename)
  }
  if (!sink.data.properties) sink.data.properties = {}
  sink.data.properties.locked = true
}

// Image/Prompt pose modes generate via the normal graph-run path. Ensure a
// downstream image sink exists, then scope-run the pose node + that sink so the
// result lands on a visible artifact-image node (live = skip cost-confirm).
function handlePoseGenerate(e: Event) {
  const detail = (e as CustomEvent).detail
  const nodeId = detail?.nodeId ? String(detail.nodeId) : null
  if (!nodeId) return
  const poseNode = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!poseNode) return
  const sink = ensurePoseImageSink(poseNode)
  const rerollScope = detail?.rerollScope as 'self' | undefined
  nextTick(() => {
    window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
      detail: { targetIds: [nodeId, String(sink.id)], live: true, rerollScope },
    }))
  })
}

// Multi-view "3D views" finished: drop each generated angle as a standalone
// locked artifact-image node in a grid beside the pose node (a character sheet
// to feed image-to-3D). Not wired — the pose node has one output; these are an
// independent set of result images.
function handlePoseMultiResult(e: Event) {
  const detail = (e as CustomEvent).detail
  const nodeId = detail?.nodeId ? String(detail.nodeId) : null
  const views: Array<{ label: string; filename: string }> = Array.isArray(detail?.views) ? detail.views : []
  if (!nodeId || !views.length) return
  const poseNode = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!poseNode) return
  const srcPos = poseNode.position || { x: 0, y: 0 }
  const srcW = (poseNode.data?.size?.[0] ?? 200) as number
  const baseTs = Date.now()
  let i = 0
  const byLabel: Record<string, string> = {} // view label → created node id
  for (const v of views) {
    if (!v?.filename) continue
    const sink = createNodeData('Image', { x: srcPos.x + srcW + 80 + (i % 2) * 270, y: srcPos.y + Math.floor(i / 2) * 300 })
    sink.id = String(baseTs + i) // unique numeric ids (Date.now() collides in a tight loop)
    sink.data.size = [240, 280]
    sink.data.title = `3D · ${v.label}`
    const wi = sink.data.widgetDefs?.findIndex((w: any) => w.name === 'image') ?? -1
    if (wi >= 0) {
      sink.data.widgetsValues[wi] = v.filename
      const def = sink.data.widgetDefs[wi]
      if (def && Array.isArray(def.options) && !def.options.includes(v.filename)) def.options.push(v.filename)
    }
    sink.data.images = [`/view?${new URLSearchParams({ filename: v.filename, type: 'input' })}`]
    sink.data.properties = { locked: true }
    nodes.value.push(sink)
    byLabel[v.label] = sink.id
    i++
  }

  // Auto-wire a Hunyuan3D Multi-View node to the four views → hit Run for a GLB.
  // Best-effort: only if the node type is loaded (needs the Comfy backend to have
  // it). Maps each view to the matching input port (front/back/left/right).
  if (objectInfo.value?.['Hunyuan3DMultiViewNode']) {
    const mv = createNodeData('Hunyuan3DMultiViewNode', { x: srcPos.x + srcW + 80 + 2 * 270 + 60, y: srcPos.y + 140 })
    mv.id = String(baseTs + 100)
    nodes.value.push(mv)
    const inputIdxByLabel: Record<string, string> = { front: 'front_image', back: 'back_image', left: 'left_image', right: 'right_image' }
    for (const label in byLabel) {
      const inName = inputIdxByLabel[label]
      const idx = mv.data.inputs?.findIndex((p: any) => p.name === inName) ?? -1
      if (idx < 0) continue
      edges.value.push({
        id: `e-mv-${mv.id}-${label}`,
        source: byLabel[label], sourceHandle: 'output-0',
        target: mv.id, targetHandle: `input-${idx}`,
        type: 'comfy', data: { dataType: 'IMAGE' },
      } as any)
    }

    // And a 3D viewer on the mesh output, so Run → see the model on canvas.
    if (objectInfo.value?.['Model3D']) {
      const viewer = createNodeData('Model3D', { x: mv.position.x + (mv.data?.size?.[0] ?? 220) + 80, y: mv.position.y })
      viewer.id = String(baseTs + 101)
      nodes.value.push(viewer)
      const outIdx = mv.data.outputs?.findIndex((o: any) => o.name === 'glb_url') ?? 0
      const inIdx = viewer.data.inputs?.findIndex((p: any) => p.name === 'glb_url') ?? 0
      edges.value.push({
        id: `e-mv3d-${viewer.id}`,
        source: mv.id, sourceHandle: `output-${outIdx < 0 ? 0 : outIdx}`,
        target: viewer.id, targetHandle: `input-${inIdx < 0 ? 0 : inIdx}`,
        type: 'comfy', data: { dataType: 'STRING' },
      } as any)
    }
  }
}

// Images dropped onto a Frame become owned image layers (LocalLayer kind
// 'image') — uploaded, sized to their aspect, appended to the frame's layers.
// They flow through the same overlay bake/inject path as text & shapes.
async function handleFrameDropImage(e: Event) {
  const detail = (e as CustomEvent).detail
  const nodeId = detail?.nodeId
  const files: FileList | undefined = detail?.files
  if (!nodeId || !files?.length) return
  const node = (nodes.value as any[]).find(n => n.id === String(nodeId))
  if (!node) return
  if (!node.data.properties) node.data.properties = {}
  const existing: any[] = Array.isArray(node.data.properties.sailor_localLayers)
    ? node.data.properties.sailor_localLayers : []
  const added: any[] = []
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue
    try {
      const ts = Date.now()
      const safe = `frame_${ts}_${(file.name || 'image.png').replace(/[^\w.-]+/g, '_')}`
      const fd = new FormData()
      fd.append('image', new File([file], safe, { type: file.type }))
      fd.append('overwrite', 'true')
      const res = await fetch('/upload/image', { method: 'POST', body: fd })
      if (!res.ok) throw new Error(`upload ${res.status}`)
      const name = (await res.json())?.name || safe
      const aspect = await new Promise<number>((resolve) => {
        const im = new Image()
        im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1)
        im.onerror = () => resolve(1)
        im.src = `/view?${new URLSearchParams({ filename: name, type: 'input' })}`
      })
      added.push(createImageLayer(name, aspect))
    } catch (err) {
      console.error('[Frame] image drop failed:', err)
    }
  }
  if (added.length) node.data.properties.sailor_localLayers = [...existing, ...added]
}

// ASCII options drawer state.
const asciiOpenForId = ref<string | null>(null)
function handleOpenAscii(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) asciiOpenForId.value = String(detail.nodeId)
}

// Timeline editor modal state.
const timelineOpenForId = ref<string | null>(null)
function handleOpenTimeline(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) timelineOpenForId.value = String(detail.nodeId)
}

// Crossfade editor modal state.
const crossfadeOpenForId = ref<string | null>(null)
function handleOpenCrossfade(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) crossfadeOpenForId.value = String(detail.nodeId)
}

// Collection bottom drawer state — table editor for VARS/Collection nodes.
const collectionDrawerForId = ref<string | null>(null)
function handleOpenCollection(e: Event) {
  collectionDrawerForId.value = String((e as CustomEvent).detail?.nodeId ?? '') || null
}

// Sweep auto-run handoff (Slice 2a Task 8b): a studio surface's Sweep popover
// appends rows to the wired collection, dispatches `sailor:openCollection`
// to open the drawer for that collection, then immediately dispatches
// `sailor:runSweepRows` with the new row ids + the target studio's node id.
// The drawer that's about to mount (openCollection above) isn't listening yet
// when runSweepRows fires synchronously right after it — both events land in
// the same tick, before Vue has re-rendered `v-if="collectionDrawerForId"`.
// Simplest reliable fix: VueNodeCanvas (always mounted) is the one guaranteed
// listener, so it stashes the pending sweep detail here and hands it to
// CollectionDrawer as a prop; the drawer consumes-and-clears it once mounted
// (see CollectionDrawer's `pendingSweep` prop + onMounted watcher).
const pendingSweep = ref<{ collectionNodeId: string; rowIds: string[]; targetNodeId: string } | null>(null)
function handleRunSweepRows(e: Event) {
  const detail = (e as CustomEvent).detail as { collectionNodeId?: string; rowIds?: string[]; targetNodeId?: string } | undefined
  if (!detail?.collectionNodeId || !detail.rowIds?.length || !detail.targetNodeId) return
  pendingSweep.value = { collectionNodeId: String(detail.collectionNodeId), rowIds: detail.rowIds, targetNodeId: String(detail.targetNodeId) }
}

// Collection row scrub (node scrubber, not the drawer) — push the newly
// scrubbed preview row onto any wired Smart Layout targets' live preview.
function handleCollectionScrub(e: Event) {
  const nodeId = String((e as CustomEvent).detail?.nodeId ?? '')
  if (!nodeId) return
  const allNodes = nodes.value as any[]
  const colNode = allNodes.find(n => String(n.id) === nodeId)
  if (!colNode) return
  pushVarPreview(colNode, wiredTargets(nodeId, allNodes, edges.value as any[]), allNodes)
}

// ── Lookup collections (LOOKUP edges) ───────────────────────────────────────
// Collection ids of the collections a driver has LOOKUP edges from.
function lookupSourceIds(driverId: string): string[] {
  return (edges.value as any[])
    .filter(e => String(e.target) === String(driverId) && e?.data?.dataType === LOOKUP_TYPE)
    .map(e => String(e.source))
}
function collectionDataOf(nodeId: string): any | undefined {
  const n = (nodes.value as any[]).find(x => String(x.id) === String(nodeId))
  return n?.data?.properties?.[COLLECTION_PROP]
}
// After a LOOKUP edge is drawn: auto-match on a shared key, else open the picker.
const lookupPicker = ref<{ sourceId: string; driverId: string; foreign: any[]; local: any[]; anchor: { x: number; y: number } } | null>(null)
function registerLookupLink(sourceId: string, driverId: string, anchor: { x: number; y: number }) {
  const driver = collectionDataOf(driverId); const foreign = collectionDataOf(sourceId)
  if (!driver || !foreign) return
  if (!Array.isArray(driver.links)) driver.links = []
  const match = autoMatchColumns(driver.columns, foreign.columns)
  if (match) {
    driver.links = reconcileLinks(driver.links, lookupSourceIds(driverId), sid =>
      sid === sourceId ? match : (driver.links.find((l: any) => l.collectionId === sid) ?? null))
  } else {
    lookupPicker.value = { sourceId, driverId, foreign: foreign.columns, local: driver.columns, anchor }
  }
}
function applyLookupMatch(v: { matchLocal: string; matchForeign: string }) {
  const p = lookupPicker.value; lookupPicker.value = null
  if (!p) return
  const driver = collectionDataOf(p.driverId); if (!driver) return
  if (!Array.isArray(driver.links)) driver.links = []
  driver.links = reconcileLinks(
    driver.links.filter((l: any) => l.collectionId !== p.sourceId).concat([{ collectionId: p.sourceId, ...v }]),
    lookupSourceIds(p.driverId),
    () => null,
  )
}
function cancelLookupMatch() {
  const p = lookupPicker.value; lookupPicker.value = null
  if (!p) return
  // Remove the just-drawn edge — the user backed out of matching.
  const drop = (edges.value as any[]).filter(e => String(e.source) === p.sourceId && String(e.target) === p.driverId && e?.data?.dataType === LOOKUP_TYPE)
  if (drop.length) removeEdges(drop.map(e => e.id))
}
// Prune links whose LOOKUP edge no longer exists (covers disconnect + delete).
// Topology key rather than a deep watch, for the same reason as the cast sync
// above: only add/remove/rewire can change which LOOKUP edges exist.
watch(() => edgeTopologyKey(edges.value as any[]), () => {
  for (const n of nodes.value as any[]) {
    if (n?.data?.nodeType !== 'Collection') continue
    const c = n.data.properties?.[COLLECTION_PROP]
    if (!c || !Array.isArray(c.links) || !c.links.length) continue
    const ids = lookupSourceIds(String(n.id))
    const next = reconcileLinks(c.links, ids, () => null) // prune-only; never auto-add here
    if (next.length !== c.links.length) c.links = next
  }
})

// Shared "reuse the wired collection, else create one" logic used by BOTH the
// studio-control promote handler and the Smart Layout element promote handler
// below. This is the ONLY place that can create the collection node + VARS
// edge since only the canvas owns `nodes.value`/`edges.value`. Callers pass
// their own `createCollectionNode` callback into `promoteControl`/
// `promoteLayoutElement` — this helper just builds that callback once.
function findOrCreateWiredCollection(targetNode: any): () => any {
  return () => {
    // No wired collection yet — create one beside the target node and wire its
    // VARS output into the node's `vars` input (ensureVarsInput first so that
    // input handle actually exists on legacy/freshly-created nodes).
    ensureVarsInput(targetNode)
    const targetId = String(targetNode.id)
    const pos = { x: (targetNode.position?.x ?? 0) - 260, y: targetNode.position?.y ?? 0 }
    const colNode = createNodeData('Collection', pos)
    if (!colNode.data.properties) colNode.data.properties = {}
    colNode.data.properties[COLLECTION_PROP] = createCollection('Collection')
    nodes.value.push(colNode)

    const varsIndex = ((targetNode.data?.inputs ?? []) as any[]).findIndex(i => i.name === 'vars')
    if (varsIndex >= 0) {
      edges.value.push({
        id: `e-vars-${colNode.id}-${targetId}`,
        source: colNode.id,
        sourceHandle: 'output-0',
        target: targetId,
        targetHandle: `input-${varsIndex}`,
        type: 'comfy',
        data: { dataType: VARS_TYPE },
      } as any)
    }
    return colNode
  }
}

// After a promote call creates/reuses a wired collection, push the fresh
// preview onto every wired target and open the collection drawer. Shared by
// both promote handlers below.
function pushPreviewAndOpenCollection(targetId: string) {
  const allNodes = nodes.value as any[]
  const allEdges = edges.value as any[]
  const collectionId = allEdges.find(ed => String(ed.target) === targetId && ed?.data?.dataType === VARS_TYPE)?.source
  const collectionNode = collectionId ? allNodes.find(n => String(n.id) === String(collectionId)) : undefined
  if (collectionNode) {
    pushVarPreview(collectionNode, wiredTargets(String(collectionId), allNodes, allEdges), allNodes)
    window.dispatchEvent(new CustomEvent('sailor:openCollection', { detail: { nodeId: String(collectionId) } }))
  }
}

// Promote a studio control to a Collection column. Fired by useStudioVarBindings'
// `promote()` when the calling surface has no `createCollectionNode` accessor of
// its own (i.e. every studio surface today — they only know their own nodeId).
// Mirrors promoteControl's own "reuse the wired collection, else create one"
// logic, but this is the ONLY place that can create the collection node + VARS
// edge since only the canvas owns `nodes.value`/`edges.value`.
function handlePromoteControl(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string; control: StudioControlDesc; currentValue: string | number }>).detail
  if (!detail?.nodeId || !detail.control) return
  const studioId = String(detail.nodeId)
  const studio = (nodes.value as any[]).find(n => String(n.id) === studioId)
  if (!studio) return

  const result = promoteControl(
    () => nodes.value as any[],
    () => edges.value as any[],
    studioId,
    detail.control,
    detail.currentValue,
    findOrCreateWiredCollection(studio),
  )
  if (!result) return

  // The just-promoted control's collection is whichever node the studio's vars
  // input now traces back to (freshly created above, or the one already wired).
  pushPreviewAndOpenCollection(studioId)
}

// Promote a Smart Layout text/image element to a Collection column. Fired by
// the editor's context-menu "Turn into variable" action (Task 3) once the
// element's content has been tokenized to `{{ props.<socketName> }}`. Mirrors
// handlePromoteControl above, sharing the same find-or-create-collection logic,
// but binds `props.<socketName>` instead of `params.<control.key>`.
function handlePromoteLayoutElement(e: Event) {
  const detail = (e as CustomEvent<{
    nodeId: string
    socketName: string
    columnLabel: string
    currentValue: string | number
    kind: 'text' | 'image'
  }>).detail
  if (!detail?.nodeId || !detail.socketName) return
  const layoutId = String(detail.nodeId)
  const layoutNode = (nodes.value as any[]).find(n => String(n.id) === layoutId)
  if (!layoutNode) return

  const result = promoteLayoutElement(
    () => nodes.value as any[],
    () => edges.value as any[],
    layoutId,
    detail.socketName,
    detail.columnLabel,
    detail.currentValue,
    detail.kind,
    findOrCreateWiredCollection(layoutNode),
  )
  if (!result) return

  pushPreviewAndOpenCollection(layoutId)
}

// Fallback binder for surfaces that only have a control's `path`/`columnKey`
// and no live accessor into the composable (e.g. cross-component triggers).
// Surfaces with direct access to useStudioVarBindings should call its own
// bind/write-through helpers instead — this event exists so nothing is stuck
// if only the DOM is reachable.
function handleBindControl(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string; path: string; columnKey: string }>).detail
  if (!detail?.nodeId || !detail.path || !detail.columnKey) return
  const node = (nodes.value as any[]).find(n => String(n.id) === String(detail.nodeId))
  if (!node) return
  const edge = (edges.value as any[]).find(ed => String(ed.target) === String(detail.nodeId) && ed?.data?.dataType === VARS_TYPE)
  const colNode = edge ? (nodes.value as any[]).find(n => String(n.id) === String(edge.source)) : undefined
  const c = colNode?.data?.properties?.[COLLECTION_PROP]
  if (!c) return

  if (!node.data.properties) node.data.properties = {}
  const bindings = (node.data.properties[BINDINGS_PROP] ?? {}) as VarBindings
  const row = c.rows?.[c.previewRow]
  const lastLiteral = row?.values?.[detail.columnKey]
  bindings[detail.path] = { collectionId: c.id, columnKey: detail.columnKey, ...(lastLiteral !== undefined ? { lastLiteral } : {}) }
  node.data.properties[BINDINGS_PROP] = bindings
}

// Fallback unbinder mirroring handleBindControl — deletes the binding entry
// only. Surfaces with direct composable access should call unbind() there
// instead (it also freezes the control's last value); this event is the
// no-composable fallback and intentionally does not attempt that freeze.
function handleUnbindControl(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string; path: string }>).detail
  if (!detail?.nodeId || !detail.path) return
  const node = (nodes.value as any[]).find(n => String(n.id) === String(detail.nodeId))
  const bindings = node?.data?.properties?.[BINDINGS_PROP] as VarBindings | undefined
  if (!bindings) return
  delete bindings[detail.path]
}

// SmartLayout editor modal state — the visual layout editor that mounts over
// the canvas when the user clicks "Edit layout" on a SmartLayout node.
const smartLayoutOpenForId = ref<string | null>(null)
function handleOpenSmartLayout(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.nodeId) smartLayoutOpenForId.value = String(detail.nodeId)
}

// Batch export sheet state — cartesian render across formats × bound
// variables, opened from the SmartLayout node body or the editor modal.
const batchExportOpenForId = ref<string | null>(null)
// Live editor draft passed by SmartLayoutEditorModal — the node widget only
// updates on Save & close, so the sheet prefers this when present.
const batchExportTemplate = ref<any | null>(null)
function handleOpenBatchExport(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string; template?: any }>).detail
  if (!detail?.nodeId) return
  batchExportTemplate.value = detail.template ?? null
  batchExportOpenForId.value = String(detail.nodeId)
}

// Gallery for a BatchGrid node — canvas-owned (node-local modal state
// wouldn't survive Vue Flow node re-renders).
const batchGalleryForId = ref<string | null>(null)
function handleOpenBatchGallery(e: Event) {
  const detail = (e as CustomEvent<{ nodeId: string }>).detail
  if (detail?.nodeId) batchGalleryForId.value = String(detail.nodeId)
}
const batchGalleryPayload = computed<BatchGridPayload | null>(() => {
  if (!batchGalleryForId.value) return null
  const n = (nodes.value as any[]).find(x => String(x.id) === batchGalleryForId.value)
  return n?.data?.properties?.[BATCH_PROP] ?? null
})

/** Spawn a BatchGrid node beside the source Smart Layout with the results.
 *  Always a fresh node — batches are compared side by side, never refreshed. */
function handleBatchSpawn(payload: BatchGridPayload) {
  const src = (nodes.value as any[]).find(n => String(n.id) === payload.sourceNodeId)
  const pos = src
    ? { x: (src.position?.x ?? 0) + ((src.data?.size?.[0] ?? 260) as number) + 80, y: (src.position?.y ?? 0) + 40 }
    : { x: 200, y: 200 }
  const gridNode = createNodeData('BatchGrid', pos)
  if (!gridNode.data.properties) gridNode.data.properties = {}
  gridNode.data.properties[BATCH_PROP] = payload
  gridNode.data.title = `Batch · ${payload.layoutName}`
  nodes.value.push(gridNode)
}

// Sketch stack overlay — canvas-owned (same convention as the BatchGrid
// gallery). Opened by sailor:openSketchStack from the pile node; the payload
// computed stays live off the node so a re-roll's items swap in place.
const sketchStackForId = ref<string | null>(null)
const sketchStackOrigin = ref<{ x: number, y: number, width: number, height: number } | null>(null)

function handleOpenSketchStack(e: Event) {
  const detail = (e as CustomEvent<{ nodeId?: string }>).detail
  if (!detail?.nodeId) return
  // Morph origin: the pile COVER's rendered rect (includes canvas zoom — the
  // stack items render at this same width, so the morph is translate-only).
  const el = document.querySelector(
    `.vue-flow__node[data-id="${detail.nodeId}"] .pile-cover, .vue-flow__node[data-id="${detail.nodeId}"] .pile-skeleton`,
  ) as HTMLElement | null
  const r = el?.getBoundingClientRect()
  sketchStackOrigin.value = r
    ? { x: r.left, y: r.top, width: r.width, height: r.height }
    : { x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 75, width: 200, height: 150 }
  sketchStackForId.value = String(detail.nodeId)
}

function sketchStackPile(): any | null {
  if (!sketchStackForId.value) return null
  return (nodes.value as any[]).find((n: any) => String(n.id) === sketchStackForId.value) ?? null
}
const sketchStackPayload = computed<SketchPilePayload | null>(() => {
  if (!sketchStackForId.value) return null
  const n = (nodes.value as any[]).find((x: any) => String(x.id) === sketchStackForId.value)
  return n?.data?.properties?.[SKETCH_PROP] ?? null
})
// Re-roll needs the payload's source generator to still exist. A pad-flow
// pile loses its hidden pad on save/reload (getWorkflow strips it), so the
// overlay disables the button instead of letting it silently no-op.
const sketchStackCanReroll = computed<boolean>(() => {
  const srcId = sketchStackPayload.value?.sourceNodeId
  if (!srcId) return false
  return (nodes.value as any[]).some((n: any) => String(n.id) === srcId)
})

/** Keep item `index` as an ordinary Image card in the keeper column left of
 *  the pile. Returns the created card (Develop wires its finisher from it). */
function keepSketchStackItem(index: number): any | null {
  const pile = sketchStackPile()
  const payload = pile?.data?.properties?.[SKETCH_PROP] as SketchPilePayload | undefined
  if (!pile || !payload) return null
  const plan = planKeptCard(pile.position, payload, index)
  if (!plan) return null
  const imageWidgetValue = annotatedImageValueFromViewUrl(plan.image)
  // No propertyOverrides on purpose — planKeptCard's contract is a PLAIN card.
  const card = createNodeData(plan.nodeType, plan.position,
    imageWidgetValue ? { image: imageWidgetValue } : undefined)
  card.data = { ...card.data, images: [plan.image] }
  ;(nodes.value as any[]).push(card)
  pile.data = {
    ...pile.data,
    properties: { ...pile.data.properties, [SKETCH_PROP]: { ...payload, keptCount: plan.nextKeptCount } },
  }
  return card
}

/** Develop: the picked image lands as a plain Image card in clear space
 *  right of the pile, a DevelopImageNode (the dedicated resolution-only
 *  finisher; polish prompt lives in the backend) is spliced from it —
 *  branched, NEVER auto-run — and the camera travels to the pair. Closes
 *  the overlay. */
async function developSketchStackItem(index: number) {
  const pile = sketchStackPile()
  const payload = pile?.data?.properties?.[SKETCH_PROP] as SketchPilePayload | undefined
  const item = payload?.items?.[index]
  if (!pile || !payload || !item) return
  // Clear space for the card + its editor as ONE pair: spliceAfterNode puts
  // the editor at card.x + 360, so both slots must be free — the old keeper-
  // column placement (left of the pile) landed the editor exactly on top of
  // the pile. Slide down the column right of the pile, then start another.
  const occupiedAt = (q: { x: number, y: number }) => (nodes.value as any[]).some((n: any) => {
    if (n.id === pile.id || n.hidden) return false
    const nx = n.position?.x ?? 0, ny = n.position?.y ?? 0
    return Math.abs(nx - q.x) < 360 && Math.abs(ny - q.y) < 320
  })
  const pairFree = (q: { x: number, y: number }) => !occupiedAt(q) && !occupiedAt({ x: q.x + 360, y: q.y })
  let p = { x: pile.position.x + 300, y: pile.position.y }
  let guard = 0
  while (!pairFree(p) && guard++ < 40) p = { x: p.x, y: p.y + 230 }
  if (!pairFree(p)) p = { x: pile.position.x + 1060, y: pile.position.y }

  const imageWidgetValue = annotatedImageValueFromViewUrl(item.image)
  const card = createNodeData('Image', p, imageWidgetValue ? { image: imageWidgetValue } : undefined)
  card.data = { ...card.data, images: [item.image] }
  ;(nodes.value as any[]).push(card)
  sketchStackForId.value = null
  await nextTick()
  // Splice directly (not via sailor:applyEffect) so we get the editor's id
  // back and can travel the camera to the PAIR, not just the editor.
  // DevelopImageNode is the dedicated one-dial node (resolution only) — the
  // polish instruction is baked into the backend, not exposed as a prompt.
  const editorId = await spliceAfterNode(String(card.id), 'DevelopImageNode', 'IMAGE', undefined, { branch: true })
  // Vue Flow measures new nodes via ResizeObserver AFTER they render; a
  // fitView issued before that sees 0×0 dimensions and silently no-ops.
  // Wait (bounded) until both nodes carry real dimensions, then travel.
  const targets = (editorId ? [card.id, editorId] : [card.id]).map(String)
  for (let i = 0; i < 20; i++) {
    const picked = (nodes.value as any[]).filter((n: any) => targets.includes(String(n.id)))
    if (picked.length === targets.length && picked.every((n: any) => (n.dimensions?.width ?? 0) > 0)) break
    await new Promise<void>(r => requestAnimationFrame(() => r()))
  }
  fitView({ nodes: targets, padding: 0.4, duration: 300 })
}

/** Re-roll the whole batch: fresh seed onto the payload's source generator +
 *  the same scoped run both flows already use. The executed handler routes the
 *  new batch back into this pile (pad branch or sketch-node branch). */
function rerollSketchStack() {
  const pile = sketchStackPile()
  const payload = pile?.data?.properties?.[SKETCH_PROP] as SketchPilePayload | undefined
  if (!pile || !payload) return
  const src = (nodes.value as any[]).find((n: any) => String(n.id) === payload.sourceNodeId)
  if (!src) return
  const seed = Math.floor(Math.random() * 2_147_483_647)
  applyWidgetOverridesTo(src, { seed })
  if (src.data?.properties?.sketchPad === true) sketchPad.seed = seed // keep pad bookkeeping coherent
  pile.data = {
    ...pile.data,
    properties: { ...pile.data.properties, [SKETCH_PROP]: { ...payload, seed, loading: true } },
  }
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
    detail: { targetIds: [src.id], direction: 'self', skipCostConfirm: true },
  }))
}

// Model gallery modal state — opened by the WidgetModelPicker launcher on
// generator nodes. Each gallery has its own open-state ref so two distinct
// modals (image vs video) don't share mount lifecycle; the dispatcher reads
// `detail.kind` and flips the right one.
const modelGalleryOpenForId = ref<string | null>(null)
const videoModelGalleryOpenForId = ref<string | null>(null)
const textEffectGalleryOpenForId = ref<string | null>(null)
const shotPresetGalleryOpenForId = ref<string | null>(null)
const loraGalleryOpenForId = ref<string | null>(null)
const loraGalleryWidgetName = ref<string>('lora_name')
const loraGalleryKind = ref<'character' | 'style' | 'moodboard'>('style')
const voiceGalleryOpenForId = ref<string | null>(null)
const voiceGalleryWidgetName = ref<string>('voice_id')
const voiceGalleryOptions = ref<string[]>([])

// Any full-screen editor/gallery modal that overlays the canvas and owns the
// keyboard while open.
const anyEditorModalOpen = computed(() => !!(
  compositorOpenForId.value || inpaintOpenForId.value ||
  poseOpenForId.value ||
  asciiOpenForId.value || timelineOpenForId.value || crossfadeOpenForId.value ||
  smartLayoutOpenForId.value || batchExportOpenForId.value || modelGalleryOpenForId.value || videoModelGalleryOpenForId.value ||
  textEffectGalleryOpenForId.value || shotPresetGalleryOpenForId.value || loraGalleryOpenForId.value ||
  voiceGalleryOpenForId.value || spaceTypeOpenForId.value || gradientStudioOpenForId.value ||
  shaderStudioOpenForId.value || textureStudioOpenForId.value || shapeStudioOpenForId.value ||
  vectorTypeOpenForId.value || scene3dStudioOpenForId.value ||
  shotDirectorOpenForId.value || !!collectionDrawerForId.value || !!sketchStackForId.value
))
// Vue Flow's built-in delete-key deletes the *selected node* — but when an editor
// modal is open (e.g. the Compositor), the node behind it is still selected, so a
// Delete/Backspace meant for a local layer would wipe the whole Frame node. Disable
// Vue Flow's delete-key whenever a modal owns the keyboard.
const vfDeleteKeyCode = computed<string[] | null>(() =>
  anyEditorModalOpen.value ? null : ['Backspace', 'Delete'])

// Canvas-occlusion contract (single source of truth). A modal counts as OCCLUDING
// only if it covers the WHOLE canvas (fixed/absolute inset-0 or StudioModalShell),
// so canvas-preview render loops (Frame, Space Type, …) can safely pause behind it —
// see ~/lib/studio/occlusion.ts. This list is intentionally NARROWER than
// `anyEditorModalOpen`: the Ascii glyph drawer (right, 340px), the Collection drawer
// (bottom, 320px) and the Inpaint/Crossfade panels leave the canvas partially visible
// beside them, so freezing a card the user can still see would be wrong — they're
// excluded. Every entry here has been checked to render a full-canvas backdrop.
const anyCanvasOccludingModalOpen = computed(() => !!(
  compositorOpenForId.value || spaceTypeOpenForId.value || gradientStudioOpenForId.value ||
  moodboardOpenForId.value || textureStudioOpenForId.value || shaderStudioOpenForId.value ||
  shapeStudioOpenForId.value || vectorTypeOpenForId.value || scene3dStudioOpenForId.value ||
  shotDirectorOpenForId.value || lipSyncOpenForId.value || poseOpenForId.value ||
  timelineOpenForId.value || smartLayoutOpenForId.value || batchExportOpenForId.value ||
  batchGalleryPayload.value || sketchStackPayload.value || modelGalleryOpenForId.value ||
  videoModelGalleryOpenForId.value || textEffectGalleryOpenForId.value ||
  shotPresetGalleryOpenForId.value || loraGalleryOpenForId.value || voiceGalleryOpenForId.value
))
// Emit the one canonical signal every gate component subscribes to. `flush: 'post'`
// so the emit lands after the modal has actually mounted/torn down this tick.
watch(anyCanvasOccludingModalOpen, (open) => emitCanvasOcclusion(open), { flush: 'post' })

function handleOpenModelGallery(e: Event) {
  const detail = (e as CustomEvent).detail
  const nodeId = detail?.nodeId ? String(detail.nodeId) : null
  if (!nodeId) return
  if (detail?.kind === 'video') videoModelGalleryOpenForId.value = nodeId
  else if (detail?.kind === 'text_effect') textEffectGalleryOpenForId.value = nodeId
  else if (detail?.kind === 'shot_preset') shotPresetGalleryOpenForId.value = nodeId
  else modelGalleryOpenForId.value = nodeId
}
function handleOpenLoraGallery(e: Event) {
  const detail = (e as CustomEvent).detail || {}
  if (!detail.nodeId) return
  loraGalleryWidgetName.value = detail.widgetName || 'lora_name'
  // 'moodboard' opens the gallery straight on the Moodboards tab (the
  // Generate-an-image chip — moodboards Plan B, Task B2).
  loraGalleryKind.value = detail.kind === 'character' ? 'character'
    : detail.kind === 'moodboard' ? 'moodboard' : 'style'
  loraGalleryOpenForId.value = String(detail.nodeId)
}
function handleOpenVoiceGallery(e: Event) {
  const detail = (e as CustomEvent).detail || {}
  if (!detail.nodeId) return
  voiceGalleryWidgetName.value = detail.widgetName || 'voice_id'
  voiceGalleryOptions.value = Array.isArray(detail.options) ? detail.options : []
  voiceGalleryOpenForId.value = String(detail.nodeId)
}

// Paste an image directly onto the canvas → uploads it to ComfyUI's input/
// folder and spawns a LoadImage node with the filename pre-filled. Supports
// clipboard image blobs (screenshots) and copied image files (from Finder/
// Explorer). Ignored when focus is in an editable element so Cmd+V in
// widget inputs still pastes text normally.
async function handlePaste(e: ClipboardEvent) {
  // Don't hijack paste when the user's typing in a widget/field. `e.target`
  // can be window (for synthetic dispatches) or non-Element nodes; guard
  // before calling Element methods on it.
  const t = e.target as Element | null
  const isEditableTarget =
    t instanceof Element
    && (t.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
      || t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
  if (isEditableTarget) return

  // Skip when the active element is editable (covers focused-but-untargeted
  // inputs, e.g. a focused textarea anywhere on the page).
  const ae = document.activeElement
  if (ae instanceof Element
    && (ae.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
      || ae.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))) {
    return
  }

  // Pull image from items (screenshots, copied images) or files (file drag).
  const items = Array.from(e.clipboardData?.items ?? [])
  let imageFile: File | null = null
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      imageFile = it.getAsFile()
      if (imageFile) break
    }
  }
  if (!imageFile && e.clipboardData?.files?.length) {
    const f = e.clipboardData.files[0]
    if (f.type.startsWith('image/')) imageFile = f
  }
  if (!imageFile) {
    // No OS-clipboard image → fall back to in-app node paste (Cmd+V of copied
    // canvas nodes). This lives here, on the paste event, rather than on the
    // Cmd+V keydown so a pasted screenshot always wins: previously the keydown
    // pasted the buffered node and preventDefault'd, which suppressed this
    // event and silently dropped the image. pasteClipboard() is a no-op (returns
    // false) when the buffer is empty, so a plain paste with nothing to do falls
    // through harmlessly.
    if (pasteClipboard()) e.preventDefault()
    return
  }

  e.preventDefault()

  // Upload to ComfyUI's input folder. Name is best-effort — screenshots arrive
  // as image.png; we prefix a timestamp so multiple pastes don't collide.
  const ts = Date.now()
  const safeName = (imageFile.name && imageFile.name !== 'image.png')
    ? imageFile.name
    : `pasted-${ts}.png`
  const renamed = new File([imageFile], `${ts}_${safeName.replace(/[^\w.-]+/g, '_')}`, {
    type: imageFile.type,
  })

  const fd = new FormData()
  fd.append('image', renamed)
  fd.append('overwrite', 'true')

  let uploadedName: string
  try {
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(await res.text() || `upload ${res.status}`)
    const data = await res.json()
    uploadedName = data?.name || renamed.name
  } catch (err: any) {
    console.error('[paste] upload failed:', err)
    // Silent returns read as "paste is broken" — say what actually happened.
    toast.error('Couldn’t paste the image', { description: 'Uploading it to the backend failed — is ComfyUI running?' })
    return
  }

  // Refresh object_info so the Image artifact's combo includes the just-uploaded
  // file. Cached by default; force a re-fetch.
  await fetchObjectInfo(true)

  // Spawn a unified `Image` artifact node (not a brittle LoadImage) with the
  // uploaded file — it's already in the input folder, so it runs natively.
  window.dispatchEvent(new CustomEvent('sailor:addNode', {
    detail: {
      nodeType: 'Image',
      widgetOverrides: { image: uploadedName },
    },
  }))
}

// Annotate-toolbar dispatcher: the floating toolbar fires `addAnnotation` and
// the canvas owns the spawn position and per-kind logic. We deliberately
// IGNORE the last-cursor position here — when the user clicks the toolbar
// their cursor is *at the toolbar* (bottom-center of the screen), which
// would spawn annotations directly under the toolbar button, where they're
// invisible. Always spawn at the visible center of the canvas instead, so
// every toolbar click produces a visible artifact.
function handleAddAnnotationEvent(event: Event) {
  const detail = (event as CustomEvent).detail
  const kind = detail?.kind
  if (!kind) return
  const screenCenter = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const spawn = project(screenCenter)
  if (kind === 'sticky') createSticky({ x: spawn.x - 100, y: spawn.y - 100 })
  else if (kind === 'checklist') createChecklist({ x: spawn.x - 130, y: spawn.y - 110 })
  else if (kind === 'image') promptImagePin(spawn.x - 120, spawn.y - 120)
  else if (kind === 'arrow') {
    // One-shot: drop a default-length horizontal arrow centered on the viewport.
    // Two-click "draw arrow" mode is still available via the pane context
    // menu, keyboard A, or "Draw Arrow From Here…" on a group — that mode
    // matters for connecting specific things, but for the toolbar it's more
    // useful to just get a visible arrow you can right-click to edit/delete.
    const half = 120
    createArrow({
      from: { kind: 'point', x: spawn.x - half, y: spawn.y },
      to:   { kind: 'point', x: spawn.x + half, y: spawn.y },
    })
  }
}

// Character bus unsubscribe handles (Task 5) — populated in onMounted, torn
// down in onUnmounted alongside the window-event listeners below.
let characterBusOff: Array<() => void> = []

onMounted(() => {
  window.addEventListener('sailor:addNode', handleAddNode)
  if (import.meta.dev) window.addEventListener('sailor:test:setNodeData', handleTestSetNodeData)
  window.addEventListener('sailor:addAssetNode', handleAddAssetNode)
  window.addEventListener('sailor:addAnnotation', handleAddAnnotationEvent)
  window.addEventListener('message', handleBridgeMessage)
  window.addEventListener('sailor:openCompositor', handleOpenCompositor)
  // Frame Compositor output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:compositorOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openSpaceType', handleOpenSpaceType)
  window.addEventListener('sailor:openSpaceTypeClip', handleOpenSpaceTypeClip)
  window.addEventListener('sailor:spaceTypeOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openGradientStudio', handleOpenGradientStudio)
  // Gradient Studio output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:gradientStudioOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openMoodboard', handleOpenMoodboard)
  window.addEventListener('sailor:moodboardWire', handleMoodboardWire)
  window.addEventListener('sailor:moodboardUnwire', handleMoodboardUnwire)
  window.addEventListener('sailor:frameUnwireSlot', handleFrameUnwireSlot)
  window.addEventListener('sailor:openTextureStudio', handleOpenTextureStudio)
  // Texture Studio output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:textureStudioOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openShaderStudio', handleOpenShaderStudio)
  // Shader Studio output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:shaderStudioOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openShapeStudio', handleOpenShapeStudio)
  // Shape Studio output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:shapeStudioOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openVectorType', handleOpenVectorType)
  // Vector Type output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:vectorTypeStudioOutput', handleSpaceTypeOutput)
  // 3D Studio "Export to Canvas": beauty render dropped as an Image node, wired
  // from the node's beauty output (output-0) — generic, reuse the same handler.
  window.addEventListener('sailor:scene3dStudioOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:openScene3DStudio', handleOpenScene3DStudio)
  window.addEventListener('sailor:openShotDirector', handleOpenShotDirector)
  // Shot Director output is generic (sourceNodeId/nodeType/widgetOverrides) — reuse the Space Type handler.
  window.addEventListener('sailor:shotDirectorOutput', handleSpaceTypeOutput)
  window.addEventListener('sailor:shotDirectorGenerate', handleShotDirectorGenerate)
  window.addEventListener('sailor:openLipSync', handleOpenLipSync)
  window.addEventListener('sailor:lipSyncGenerate', handleLipSyncGenerate)
  characterBusOff = [
    onCharacterEvent('castEdgesChanged', syncAllShotDirectorCasts),
    onCharacterEvent('uncastCharacter', handleUncastCharacter),
    onCharacterEvent('addCharacterImageGen', handleAddCharacterImageGen),
    onCharacterEvent('addCharacterCastNode', handleAddCharacterCastNode),
  ]
  window.addEventListener('sailor:studioRender', handleStudioRender)
  window.addEventListener('sailor:editAsFrame', handleEditAsFrame)
  window.addEventListener('sailor:openInpaint', handleOpenInpaint)
  window.addEventListener('sailor:frameDropImage', handleFrameDropImage)
  window.addEventListener('sailor:openAsciiOptions', handleOpenAscii)
  window.addEventListener('sailor:openTimeline', handleOpenTimeline)
  window.addEventListener('sailor:openCrossfade', handleOpenCrossfade)
  window.addEventListener('sailor:openCollection', handleOpenCollection)
  window.addEventListener('sailor:runSweepRows', handleRunSweepRows)
  window.addEventListener('sailor:collectionScrub', handleCollectionScrub)
  window.addEventListener('sailor:promoteControl', handlePromoteControl)
  window.addEventListener('sailor:promoteLayoutElement', handlePromoteLayoutElement)
  window.addEventListener('sailor:bindControl', handleBindControl)
  window.addEventListener('sailor:unbindControl', handleUnbindControl)
  window.addEventListener('sailor:openSmartLayout', handleOpenSmartLayout)
  window.addEventListener('sailor:openBatchExport', handleOpenBatchExport)
  window.addEventListener('sailor:openBatchGallery', handleOpenBatchGallery)
  window.addEventListener('sailor:openSketchStack', handleOpenSketchStack)
  window.addEventListener('sailor:openModelGallery', handleOpenModelGallery)
  window.addEventListener('sailor:openLoraGallery', handleOpenLoraGallery)
  window.addEventListener('sailor:openVoiceGallery', handleOpenVoiceGallery)
  window.addEventListener('sailor:openPose', handleOpenPose)
  window.addEventListener('sailor:poseResult', handlePoseResult)
  window.addEventListener('sailor:poseMultiResult', handlePoseMultiResult)
  window.addEventListener('sailor:poseGenerate', handlePoseGenerate)
  window.addEventListener('sailor:edgeInsert', handleEdgeInsert)
  window.addEventListener('sailor:applyEffect', handleApplyEffect)
  window.addEventListener('sailor:animateArtifact', handleAnimateArtifact)
  window.addEventListener('sailor:spawnBeside', handleSpawnBeside)
  window.addEventListener('paste', handlePaste)
  window.addEventListener('keydown', handleHistoryKey)
  // Fetch object_info on mount so widget defs are available
  fetchObjectInfo()
})
onUnmounted(() => {
  window.removeEventListener('sailor:addNode', handleAddNode)
  if (import.meta.dev) window.removeEventListener('sailor:test:setNodeData', handleTestSetNodeData)
  window.removeEventListener('sailor:addAssetNode', handleAddAssetNode)
  window.removeEventListener('sailor:addAnnotation', handleAddAnnotationEvent)
  window.removeEventListener('message', handleBridgeMessage)
  window.removeEventListener('sailor:openCompositor', handleOpenCompositor)
  window.removeEventListener('sailor:compositorOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:openSpaceType', handleOpenSpaceType)
  window.removeEventListener('sailor:openSpaceTypeClip', handleOpenSpaceTypeClip)
  window.removeEventListener('sailor:openGradientStudio', handleOpenGradientStudio)
  window.removeEventListener('sailor:gradientStudioOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:openMoodboard', handleOpenMoodboard)
  window.removeEventListener('sailor:moodboardWire', handleMoodboardWire)
  window.removeEventListener('sailor:moodboardUnwire', handleMoodboardUnwire)
  window.removeEventListener('sailor:frameUnwireSlot', handleFrameUnwireSlot)
  window.removeEventListener('sailor:openTextureStudio', handleOpenTextureStudio)
  window.removeEventListener('sailor:textureStudioOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:openShaderStudio', handleOpenShaderStudio)
  window.removeEventListener('sailor:shaderStudioOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:openShapeStudio', handleOpenShapeStudio)
  window.removeEventListener('sailor:shapeStudioOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:openVectorType', handleOpenVectorType)
  window.removeEventListener('sailor:vectorTypeStudioOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:scene3dStudioOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:openScene3DStudio', handleOpenScene3DStudio)
  window.removeEventListener('sailor:openShotDirector', handleOpenShotDirector)
  window.removeEventListener('sailor:shotDirectorOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:shotDirectorGenerate', handleShotDirectorGenerate)
  window.removeEventListener('sailor:openLipSync', handleOpenLipSync)
  window.removeEventListener('sailor:lipSyncGenerate', handleLipSyncGenerate)
  characterBusOff.forEach(off => off())
  characterBusOff = []
  window.removeEventListener('sailor:spaceTypeOutput', handleSpaceTypeOutput)
  window.removeEventListener('sailor:studioRender', handleStudioRender)
  window.removeEventListener('sailor:editAsFrame', handleEditAsFrame)
  window.removeEventListener('sailor:openInpaint', handleOpenInpaint)
  window.removeEventListener('sailor:frameDropImage', handleFrameDropImage)
  window.removeEventListener('sailor:openAsciiOptions', handleOpenAscii)
  window.removeEventListener('sailor:openTimeline', handleOpenTimeline)
  window.removeEventListener('sailor:openCrossfade', handleOpenCrossfade)
  window.removeEventListener('sailor:openCollection', handleOpenCollection)
  window.removeEventListener('sailor:runSweepRows', handleRunSweepRows)
  window.removeEventListener('sailor:collectionScrub', handleCollectionScrub)
  window.removeEventListener('sailor:promoteControl', handlePromoteControl)
  window.removeEventListener('sailor:promoteLayoutElement', handlePromoteLayoutElement)
  window.removeEventListener('sailor:bindControl', handleBindControl)
  window.removeEventListener('sailor:unbindControl', handleUnbindControl)
  window.removeEventListener('sailor:openSmartLayout', handleOpenSmartLayout)
  window.removeEventListener('sailor:openBatchExport', handleOpenBatchExport)
  window.removeEventListener('sailor:openBatchGallery', handleOpenBatchGallery)
  window.removeEventListener('sailor:openSketchStack', handleOpenSketchStack)
  window.removeEventListener('sailor:openModelGallery', handleOpenModelGallery)
  window.removeEventListener('sailor:openLoraGallery', handleOpenLoraGallery)
  window.removeEventListener('sailor:openVoiceGallery', handleOpenVoiceGallery)
  window.removeEventListener('sailor:openPose', handleOpenPose)
  window.removeEventListener('sailor:poseResult', handlePoseResult)
  window.removeEventListener('sailor:poseMultiResult', handlePoseMultiResult)
  window.removeEventListener('sailor:poseGenerate', handlePoseGenerate)
  window.removeEventListener('sailor:edgeInsert', handleEdgeInsert)
  window.removeEventListener('sailor:applyEffect', handleApplyEffect)
  window.removeEventListener('sailor:animateArtifact', handleAnimateArtifact)
  window.removeEventListener('sailor:spawnBeside', handleSpawnBeside)
  window.removeEventListener('paste', handlePaste)
  window.removeEventListener('keydown', handleHistoryKey)
  // Revoke any held blob URLs from the client-side compositor previews.
  for (const url of compositorPreviewUrls.values()) URL.revokeObjectURL(url)
  compositorPreviewUrls.clear()
  // Same for Timeline previews; also tear down the hidden <video> elements.
  for (const url of timelinePreviewUrls.values()) URL.revokeObjectURL(url)
  timelinePreviewUrls.clear()
  for (const v of timelinePreviewVideos.values()) {
    try { v.pause(); v.removeAttribute('src'); v.load() } catch {}
  }
  timelinePreviewVideos.clear()
})

// ── Client-side Compositor preview ──────────────────────────────────────────
// The Compositor is just affine transforms + blend ops — we can render it
// instantly in the browser via Canvas instead of running the whole workflow.
// The result becomes the node's preview image via `data.images`.

const compositorPreviewUrls = new Map<string, string>()
const compositorRenderTokens = new Map<string, number>()
const compositorImageCache = new Map<string, HTMLImageElement>()
let compositorRendering = false
let compositorDirty = false
let compositorRafHandle = 0

const BLEND_MAP: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  soft_light: 'soft-light',
  hard_light: 'hard-light',
  difference: 'difference',
  lighten: 'lighten',
  darken: 'darken',
  add: 'lighter',
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = compositorImageCache.get(url)
  if (cached && cached.complete && cached.naturalWidth > 0) return Promise.resolve(cached)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { compositorImageCache.set(url, img); resolve(img) }
    img.onerror = reject
    img.src = url
  })
}

// Multi-output sources (e.g. Split photo into layers: subject=0, background=1)
// mirror ui images in output-slot order, so the wire's source handle picks
// which image the layer shows.
function srcOutputIndex(edge: any): number {
  const m = /^output-(\d+)$/.exec(edge?.sourceHandle ?? '')
  return m ? Number(m[1]) : 0
}
function getUpstreamImageUrl(srcNode: any, edge?: any): string | null {
  if (srcNode?.data?.images?.length) {
    const i = srcOutputIndex(edge)
    return srcNode.data.images[i] ?? srcNode.data.images[0]
  }
  if (srcNode?.data?.nodeType === 'LoadImage' && srcNode?.data?.widgetsValues?.[0]) {
    const filename = srcNode.data.widgetsValues[0]
    return `/view?${new URLSearchParams({ filename, type: 'input' })}`
  }
  return null
}

function collectCompositorLayers(node: any): any[] {
  const defs = node.data?.widgetDefs as any[]
  const wv = node.data?.widgetsValues as any[]
  if (!defs || !wv) return []
  const widgetIdx = (name: string) => defs.findIndex((d: any) => d.name === name)
  const out: any[] = []
  for (let i = 1; i <= 4; i++) {
    const port = node.data.inputs?.find((p: any) => p.name === `layer${i}`)
    if (!port?.link) continue
    const edge = (edges.value as any[]).find((e: any) =>
      e.target === node.id && e.targetHandle === `input-${i - 1}`)
    if (!edge) continue
    const src = (nodes.value as any[]).find((n: any) => n.id === edge.source)
    const url = getUpstreamImageUrl(src, edge)
    if (!url) continue
    out.push({
      url,
      x: wv[widgetIdx(`layer${i}_x`)] ?? 0,
      y: wv[widgetIdx(`layer${i}_y`)] ?? 0,
      rotation: wv[widgetIdx(`layer${i}_rotation`)] ?? 0,
      scale: wv[widgetIdx(`layer${i}_scale`)] ?? 1,
      opacity: wv[widgetIdx(`layer${i}_opacity`)] ?? 1,
      blend: wv[widgetIdx(`layer${i}_blend`)] ?? 'normal',
    })
  }
  return out
}

async function renderComposite(layers: any[], frameDims: { w: number; h: number } | null = null): Promise<string> {
  const images = await Promise.all(layers.map(l => loadImage(l.url)))
  const maxDim = 512
  // Canvas aspect: explicit artboard dims win; else follow layer 1; else square.
  let aspect: number
  if (frameDims && frameDims.w > 0 && frameDims.h > 0) aspect = frameDims.w / frameDims.h
  else if (images[0]) aspect = images[0].naturalWidth / images[0].naturalHeight
  else aspect = 1
  let w: number, h: number
  if (aspect >= 1) { w = maxDim; h = Math.round(maxDim / aspect) }
  else            { h = maxDim; w = Math.round(maxDim * aspect) }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    const img = images[i]
    // Aspect-preserving fit into canvas (matches backend `_fit_to_canvas`).
    const cAspect = w / h
    const iAspect = img.naturalWidth / img.naturalHeight
    let fitW: number, fitH: number
    if (iAspect > cAspect) { fitW = w; fitH = w / iAspect }
    else                   { fitH = h; fitW = h * iAspect }

    ctx.save()
    ctx.globalAlpha = layer.opacity
    ctx.globalCompositeOperation = BLEND_MAP[layer.blend] || 'source-over'
    const cx = w / 2 + layer.x * w
    const cy = h / 2 + layer.y * h
    ctx.translate(cx, cy)
    ctx.rotate((layer.rotation * Math.PI) / 180)
    ctx.scale(layer.scale, layer.scale)
    ctx.drawImage(img, -fitW / 2, -fitH / 2, fitW, fitH)
    ctx.restore()
  }

  // Local layers (text/shapes/images) are NOT baked here — the Frame renders
  // them as a live, interactive overlay on top of this wired composite, and the
  // submit path bakes them via `bakeOverlay`. This keeps `data.images` the
  // wired-only background so inline editing never double-draws.

  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('toBlob returned null'))
      resolve(URL.createObjectURL(blob))
    }, 'image/png')
  })
}

async function renderOneCompositor(node: any) {
  const layers = collectCompositorLayers(node)
  // Explicit artboard dims (width/height widgets), if set.
  const defs = node.data?.widgetDefs as any[] | undefined
  const wv = node.data?.widgetsValues as any[] | undefined
  const wi = defs?.findIndex((d: any) => d.name === 'width') ?? -1
  const hi = defs?.findIndex((d: any) => d.name === 'height') ?? -1
  const fw = wi >= 0 ? Number(wv?.[wi]) || 0 : 0
  const fh = hi >= 0 ? Number(wv?.[hi]) || 0 : 0
  const frameDims = (fw > 0 && fh > 0) ? { w: fw, h: fh } : null
  // Wired-only composite — locals are the Frame's live overlay.
  if (!layers.length) {
    const oldUrl = compositorPreviewUrls.get(node.id)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    compositorPreviewUrls.delete(node.id)
    if (node.data.images?.length) node.data = { ...node.data, images: [] }
    return
  }
  const token = (compositorRenderTokens.get(node.id) || 0) + 1
  compositorRenderTokens.set(node.id, token)
  try {
    const url = await renderComposite(layers, frameDims)
    if (compositorRenderTokens.get(node.id) !== token) {
      URL.revokeObjectURL(url)
      return
    }
    const oldUrl = compositorPreviewUrls.get(node.id)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    compositorPreviewUrls.set(node.id, url)
    node.data = { ...node.data, images: [url] }
  } catch (err) {
    console.warn('[Compositor preview] render failed:', err)
  }
}

// Build a reactive snapshot that includes upstream image identities so the
// watcher fires when LoadImage filenames change or when upstream nodes finish.
function compositorSnapshot(node: any) {
  const inputs = node.data.inputs as any[]
  const sources = inputs.map((port, idx) => {
    if (port?.link == null) return null
    const edge = (edges.value as any[]).find((e: any) =>
      e.target === node.id && e.targetHandle === `input-${idx}`)
    if (!edge) return null
    const src = (nodes.value as any[]).find((n: any) => n.id === edge.source)
    return src?.data?.images?.[0] ?? src?.data?.widgetsValues?.[0] ?? null
  })
  // Locals (text/shape/image) are NOT part of this snapshot: they don't affect
  // the wired-only `data.images`, and the Frame renders them live itself —
  // keeping them out avoids a wired re-render on every drag frame.
  return { id: node.id, widgets: [...(node.data.widgetsValues as any[])], inputs: inputs.map(i => i.link), sources }
}

// Coalesce renders to one per animation frame, with a dirty flag so changes
// during an in-flight render trigger another render immediately after.
// This keeps the preview updating live during a continuous drag — unlike a
// debounce, which would never fire as long as the drag keeps resetting it.
async function maybeRenderCompositors() {
  if (compositorRendering) { compositorDirty = true; return }
  compositorRendering = true
  compositorDirty = false
  try {
    const compositors = (nodes.value as any[]).filter(n => n.data?.nodeType === 'Compositor')
    await Promise.all(compositors.map(renderOneCompositor))
  } finally {
    compositorRendering = false
    if (compositorDirty) maybeRenderCompositors()
  }
}

// Vue's deep watch fires on every reactive change reached by the source,
// *including* our own writes to `node.data.images` — which would feedback-loop
// into another render. JSON-stringifying the snapshot makes Vue compare via
// `===`, so the watch only fires when something we actually care about changes.
watch(
  () => JSON.stringify(
    (nodes.value as any[]).filter(n => n.data?.nodeType === 'Compositor').map(compositorSnapshot)
  ),
  () => {
    if (compositorRafHandle) return
    compositorRafHandle = requestAnimationFrame(() => {
      compositorRafHandle = 0
      maybeRenderCompositors()
    })
  },
  { immediate: true },
)

// At submit time, realise each Frame's unified z-order stack into the backend
// graph. Wired image layers carry a `layer{N}_z` matching their stack depth;
// runs of local text/shape layers are baked into RGBA, uploaded, and injected
// into spare `layer{N}` slots (IMAGE + MASK) at the same depth — so a shape
// dragged *below* a wired image renders below it, matching the live preview.
// (The legacy always-on-top `overlay` input is left untouched; the backend
// still honours it for back-compat, but we no longer populate it.)
// Mutates `workflow` in place; called by the layout right before queueing.
async function injectCompositorOverlays(workflow: any): Promise<void> {
  if (!workflow?.nodes?.length) return
  const compositors = (workflow.nodes as any[]).filter(n => n.type === 'Compositor')
  for (const comp of compositors) {
    if ((comp.mode ?? 0) !== 0) continue // muted/bypassed won't execute
    const liveNode = (nodes.value as any[]).find(n => n.id === String(comp.id))
    if (!liveNode) continue
    if (!Array.isArray(comp.inputs)) comp.inputs = []

    const locals = (comp.properties?.sailor_localLayers as LocalLayer[] | undefined) ?? []

    // Reconcile the saved stack order against what's actually present — the
    // exact reconciliation the Frame renders with. Keys: `w:<slot>` (0-based
    // connected image port) and `l:<id>` (local layer). Order is bottom→top.
    const connectedSlots: number[] = []
    for (let s = 0; s < 16; s++) {
      const port = comp.inputs.find((p: any) => p?.name === `layer${s + 1}`)
      if (port?.link != null) connectedSlots.push(s)
    }
    // Wired keys are 1-based (`w:1` = layer1), matching ArtifactFrameNode and
    // CompositorModal — all three surfaces must agree or saved orders get dropped
    // as "not present", which is why this is the shared builder. On a schema-2
    // frame a connected slot is a LAYER, so it appears once, as `l:<id>`: listing
    // it as `w:` as well gave one layer two depths here AND fed it to `injectRun`
    // to be baked as though it were a local overlay.
    const presentKeys = framePresentKeys(connectedSlots, locals)
    if (!presentKeys.length) continue
    const present = new Set(presentKeys)
    const saved = (comp.properties?.sailor_stackOrder as string[] | undefined) ?? []
    const kept = saved.filter(k => present.has(k))
    const keptSet = new Set(kept)
    const order = [...kept, ...presentKeys.filter(k => !keptSet.has(k))]

    // Phase 2 masking: which wired content slots get a silhouette mask compiled
    // into their layer{N}_mask input at submit (mirroring the editor's masking).
    // `locals` carries the schema-2 wired LAYERS, which own their slot's mask —
    // the registry is only the base (see planWiredMaskJobs).
    const treatments = readWiredTreatments(liveNode)
    const maskJobs = planWiredMaskJobs(treatments, connectedSlots.map(s => s + 1), locals as any)

    // Bake resolution mirrors the Frame's aspect: explicit artboard dims win,
    // else the lowest wired layer's native size, else a square default (a
    // locals-only frame with no preset). Needed when there are locals to bake
    // OR mask jobs to render a silhouette for.
    let W = 0, H = 0
    if (locals.length || maskJobs.length) {
      const defs = liveNode.data?.widgetDefs as any[] | undefined
      const wv = liveNode.data?.widgetsValues as any[] | undefined
      const wi = defs?.findIndex((d: any) => d.name === 'width') ?? -1
      const hi = defs?.findIndex((d: any) => d.name === 'height') ?? -1
      const fw = wi >= 0 ? Number(wv?.[wi]) || 0 : 0
      const fh = hi >= 0 ? Number(wv?.[hi]) || 0 : 0
      if (fw > 0 && fh > 0) {
        W = fw; H = fh
      } else {
        const imgLayers = collectCompositorLayers(liveNode)
        if (imgLayers.length) {
          try {
            const baseImg = await loadImage(imgLayers[0].url)
            W = baseImg.naturalWidth || 1024
            H = baseImg.naturalHeight || 1024
          } catch { /* fall through to square default */ }
        }
        if (!(W > 0 && H > 0)) { W = 1024; H = 1024 }
      }
      if (locals.length) {
        await ensureLayerFonts(locals, W)
        await ensureLayerImages(locals)
      }
    }

    const localById = new Map(locals.map(l => [l.id, l] as [string, LocalLayer]))
    const usedSlots = new Set<number>(connectedSlots) // wired slots are taken

    // Bake one contiguous run of local layers into a spare slot at depth `z`.
    // `blend` is the run's blend mode — non-normal blends bake as single-layer
    // runs so the backend can apply the mode per layer.
    const injectRun = async (run: LocalLayer[], z: number, blend = 'normal') => {
      if (!run.length || !(W > 0 && H > 0)) return
      const blob = await bakeOverlay(run, W, H)
      if (!blob) return
      let slot = -1
      for (let s = 0; s < 16; s++) { if (!usedSlots.has(s)) { slot = s; break } }
      if (slot < 0) { console.warn('[compositor] no spare layer slot for local run'); return }
      usedSlots.add(slot)

      const file = new File([blob], `sailor_local_${comp.id}_${slot}_${Date.now()}.png`, { type: 'image/png' })
      const fd = new FormData()
      fd.append('image', file)
      fd.append('overwrite', 'true')
      let name: string
      try {
        const res = await fetch('/upload/image', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(await res.text() || `upload ${res.status}`)
        name = (await res.json())?.name || file.name
      } catch (err) {
        console.error('[compositor local] upload failed:', err)
        return
      }

      // Resolve / create the layer{N} image + layer{N}_mask ports.
      let imgIdx = comp.inputs.findIndex((p: any) => p?.name === `layer${slot + 1}`)
      if (imgIdx < 0) { comp.inputs.push({ name: `layer${slot + 1}`, type: 'IMAGE', link: null }); imgIdx = comp.inputs.length - 1 }
      let maskIdx = comp.inputs.findIndex((p: any) => p?.name === `layer${slot + 1}_mask`)
      if (maskIdx < 0) { comp.inputs.push({ name: `layer${slot + 1}_mask`, type: 'MASK', link: null }); maskIdx = comp.inputs.length - 1 }

      const loadId = (workflow.last_node_id || 0) + 1
      workflow.last_node_id = loadId
      const imgLink = (workflow.last_link_id || 0) + 1
      const maskLink = imgLink + 1
      workflow.last_link_id = maskLink

      workflow.nodes.push({
        id: loadId,
        type: 'LoadImage',
        pos: [(comp.pos?.[0] ?? 0) - 280, (comp.pos?.[1] ?? 0) + slot * 60],
        size: [220, 280],
        flags: {},
        mode: 0,
        inputs: [],
        outputs: [
          { name: 'IMAGE', type: 'IMAGE', links: [imgLink], slot_index: 0 },
          { name: 'MASK', type: 'MASK', links: [maskLink], slot_index: 1 },
        ],
        properties: {},
        widgets_values: [name, 'image'],
      })
      comp.inputs[imgIdx].link = imgLink
      comp.inputs[maskIdx].link = maskLink
      workflow.links.push([imgLink, loadId, 0, comp.id, imgIdx, 'IMAGE'])
      workflow.links.push([maskLink, loadId, 1, comp.id, maskIdx, 'MASK'])

      // Identity transform (the bake is already canvas-space) + this run's depth.
      setNamedWidget(comp, `layer${slot + 1}_x`, 0, objectInfo.value)
      setNamedWidget(comp, `layer${slot + 1}_y`, 0, objectInfo.value)
      setNamedWidget(comp, `layer${slot + 1}_rotation`, 0, objectInfo.value)
      setNamedWidget(comp, `layer${slot + 1}_scale`, 1, objectInfo.value)
      setNamedWidget(comp, `layer${slot + 1}_opacity`, 1, objectInfo.value)
      setNamedWidget(comp, `layer${slot + 1}_blend`, blend, objectInfo.value)
      setNamedWidget(comp, `layer${slot + 1}_z`, z, objectInfo.value)
    }

    // ── Phase 2 masking: compile each wired content slot's silhouette mask into
    // its layer{N}_mask input, so the SERVER render honours the same masking the
    // editor shows. The Python node folds a = a*(1-mask); LoadImage MASK = 1-alpha
    // of the uploaded PNG. So we upload a PNG whose ALPHA = the mask source's
    // shape → MASK = 1-shape → node keeps content where the source is opaque
    // (destination-in). Local sources that masked something can optionally be
    // hidden from the composite (showSource:false).
    const hiddenLocalMaskSources = new Set<string>() // local layer ids to drop

    // Resolve a wired slot's upstream image URL + transform from the LIVE node
    // (mirrors collectCompositorLayers' edge walk + reads layer{N}_* widgets).
    const liveDefs = liveNode.data?.widgetDefs as any[] | undefined
    const liveWv = liveNode.data?.widgetsValues as any[] | undefined
    const liveWidget = (name: string): any => {
      const i = liveDefs?.findIndex((d: any) => d?.name === name) ?? -1
      return i >= 0 ? liveWv?.[i] : undefined
    }
    const resolveWiredSlot = (slot1: number): { url: string; x: number; y: number; rotation: number; scale: number; opacity: number } | null => {
      const edge = (edges.value as any[]).find((e: any) =>
        e.target === liveNode.id && e.targetHandle === `input-${slot1 - 1}`)
      if (!edge) return null
      const src = (nodes.value as any[]).find((n: any) => n.id === edge.source)
      const url = getUpstreamImageUrl(src, edge)
      if (!url) return null
      return {
        url,
        x: Number(liveWidget(`layer${slot1}_x`)) || 0,
        y: Number(liveWidget(`layer${slot1}_y`)) || 0,
        rotation: Number(liveWidget(`layer${slot1}_rotation`)) || 0,
        scale: Number(liveWidget(`layer${slot1}_scale`)) || 1,
        // Match the editor: the mask silhouette folds in the source's own opacity
        // (drawItemContent uses the layer's real opacity), so a semi-transparent
        // source masks partially rather than as a hard full-shape clip.
        opacity: liveWidget(`layer${slot1}_opacity`) == null ? 1 : Number(liveWidget(`layer${slot1}_opacity`)),
      }
    }

    for (const job of maskJobs) {
      const { contentSlot, sourceKey, showSource } = job
      // Respect a hand-wired mask: never clobber an existing layer{N}_mask link.
      const existingMask = comp.inputs.find((p: any) => p?.name === `layer${contentSlot}_mask`)
      if (existingMask?.link != null) {
        console.log('[compositor mask] slot', contentSlot, 'already has a wired mask — skipping')
        continue
      }
      if (!(W > 0 && H > 0)) continue

      // Render the source's shape (alpha) to a W×H canvas.
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(W))
      canvas.height = Math.max(1, Math.round(H))
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (sourceKey.startsWith('w:')) {
        const srcSlot = Number(sourceKey.slice(2))
        const w = resolveWiredSlot(srcSlot)
        if (!w) { console.warn('[compositor mask] could not resolve wired source', sourceKey); continue }
        let img: HTMLImageElement
        try { img = await loadImage(w.url) } catch { console.warn('[compositor mask] image load failed', w.url); continue }
        // Clean silhouette: full opacity, normal blend — only the shape matters.
        drawWiredImageLayer(ctx, img, { x: w.x, y: w.y, scale: w.scale, rotation: w.rotation, opacity: w.opacity, blend: 'normal' }, canvas.width, canvas.height)
      } else {
        const layer = localById.get(sourceKey.slice(2))
        if (!layer) { console.warn('[compositor mask] could not resolve local source', sourceKey); continue }
        // A migrated wired layer wears an `l:` key but its pixels still come down
        // the wire, not from any local paint: drawing it as a local would silhouette
        // NOTHING and the mask would erase the content it was meant to clip.
        if ((layer as any).kind === 'wired') {
          const w = resolveWiredSlot(((layer as any).slot as number) + 1)
          if (!w) { console.warn('[compositor mask] could not resolve wired-layer source', sourceKey); continue }
          let img: HTMLImageElement
          try { img = await loadImage(w.url) } catch { console.warn('[compositor mask] image load failed', w.url); continue }
          drawWiredImageLayer(ctx, img, { x: w.x, y: w.y, scale: w.scale, rotation: w.rotation, opacity: w.opacity, blend: 'normal' }, canvas.width, canvas.height)
        } else {
          drawLayerSilhouette(ctx, { type: 'local', key: sourceKey, layer }, canvas.width, canvas.height)
        }
      }

      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
      if (!blob) { console.warn('[compositor mask] toBlob returned null for slot', contentSlot); continue }

      const file = new File([blob], `sailor_mask_${comp.id}_${contentSlot}_${Date.now()}.png`, { type: 'image/png' })
      const fd = new FormData()
      fd.append('image', file)
      fd.append('overwrite', 'true')
      let name: string
      try {
        const res = await fetch('/upload/image', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(await res.text() || `upload ${res.status}`)
        name = (await res.json())?.name || file.name
      } catch (err) {
        console.error('[compositor mask] upload failed:', err)
        continue
      }

      // Find-or-create the layer{N}_mask MASK port and wire ONLY the LoadImage's
      // MASK output (slot index 1) into it. The IMAGE output is left unlinked.
      let maskIdx = comp.inputs.findIndex((p: any) => p?.name === `layer${contentSlot}_mask`)
      if (maskIdx < 0) { comp.inputs.push({ name: `layer${contentSlot}_mask`, type: 'MASK', link: null }); maskIdx = comp.inputs.length - 1 }

      const loadId = (workflow.last_node_id || 0) + 1
      workflow.last_node_id = loadId
      const maskLink = (workflow.last_link_id || 0) + 1
      workflow.last_link_id = maskLink

      workflow.nodes.push({
        id: loadId,
        type: 'LoadImage',
        pos: [(comp.pos?.[0] ?? 0) - 520, (comp.pos?.[1] ?? 0) + contentSlot * 60],
        size: [220, 280],
        flags: {},
        mode: 0,
        inputs: [],
        outputs: [
          { name: 'IMAGE', type: 'IMAGE', links: [], slot_index: 0 },
          { name: 'MASK', type: 'MASK', links: [maskLink], slot_index: 1 },
        ],
        properties: {},
        widgets_values: [name, 'image'],
      })
      comp.inputs[maskIdx].link = maskLink
      workflow.links.push([maskLink, loadId, 1, comp.id, maskIdx, 'MASK'])
      console.log('[compositor mask] slot', contentSlot, 'masked by', sourceKey)

      // Hide the source from the composite unless the user opted to keep it.
      if (!showSource) {
        if (sourceKey.startsWith('w:')) {
          setNamedWidget(comp, `layer${Number(sourceKey.slice(2))}_opacity`, 0, objectInfo.value)
        } else {
          // A migrated wired source is hidden the wired way — the stack walker's
          // `kind === 'wired'` branch never consults hiddenLocalMaskSources (it
          // stamps depth and moves on), so adding its id there would do nothing.
          const src = localById.get(sourceKey.slice(2))
          if ((src as any)?.kind === 'wired') {
            setNamedWidget(comp, `layer${((src as any).slot as number) + 1}_opacity`, 0, objectInfo.value)
          } else {
            hiddenLocalMaskSources.add(sourceKey.slice(2))
          }
        }
      }
    }

    // Walk bottom→top: stamp each wired layer's z, accumulating contiguous local
    // runs and flushing them (at the run's bottom depth) when a wired layer or
    // the end interrupts the run. Stack index = z, so all depths are distinct.
    // Hidden layers are skipped entirely; a local layer with a non-normal blend
    // mode bakes as its own single-layer run so the backend applies the mode.
    // LEGACY (schema < 2) only: on a unified frame a wired slot is a layer and its
    // `visible` is the one flag (see the `layer.kind === 'wired'` branch below).
    // The array survives on disk for rollback, so read it on the SAME terms both
    // hosts do — otherwise the submit could hide a slot the editor was showing.
    const hiddenWired = new Set<number>(
      legacyWiredFlagsActive((comp.properties as any) ?? null)
        ? ((comp.properties?.sailor_hiddenWired as number[] | undefined) ?? []).map(Number)
        : [],
    )
    let run: LocalLayer[] = []
    let runZ = 0
    const flush = async () => { if (run.length) { await injectRun(run, runZ); run = [] } }
    for (let zi = 0; zi < order.length; zi++) {
      const key = order[zi]
      if (key.startsWith('w:')) {
        await flush()
        const layerN = Number(key.slice(2)) // 1-based: `w:1` = layer1
        setNamedWidget(comp, `layer${layerN}_z`, zi, objectInfo.value)
        // Hidden wired layer: zero its opacity on the OUTGOING copy only (the
        // live node keeps its real opacity for when the eye toggles back on).
        if (hiddenWired.has(layerN)) setNamedWidget(comp, `layer${layerN}_opacity`, 0, objectInfo.value)
      } else {
        const layer = localById.get(key.slice(2))
        if (!layer) continue
        // A schema-2 WIRED layer reaches the walker under its `l:` key. It is
        // still backend-side a wired slot — the pixels come down the wire, not
        // from a baked overlay — so it takes the same branch its `w:` key used
        // to: flush the run, stamp its depth, and zero its opacity when hidden.
        // Baking it as a local would upload an empty PNG into a spare slot and
        // burn a layer port.
        if (layer.kind === 'wired') {
          await flush()
          const layerN = (layer as any).slot + 1
          setNamedWidget(comp, `layer${layerN}_z`, zi, objectInfo.value)
          if (layer.visible === false) setNamedWidget(comp, `layer${layerN}_opacity`, 0, objectInfo.value)
          continue
        }
        if (layer.visible === false) continue
        // Local layer used as a mask source with showSource:false → drop it.
        if (hiddenLocalMaskSources.has(layer.id)) continue
        const blend = layer.blend && layer.blend !== 'normal' ? layer.blend : null
        if (blend) {
          await flush()
          // Bake with blend stripped — the offscreen blends against nothing;
          // the backend applies the mode against the real backdrop.
          await injectRun([{ ...layer, blend: 'normal' } as LocalLayer], zi, blend)
        } else {
          if (!run.length) runZ = zi
          run.push(layer)
        }
      }
    }
    await flush()
  }
}

// Turnkey "protect in blend": when a Compositor has any layer flagged protect
// AND feeds a Blend Scene whose keep_subject is unconnected, auto-wire the
// Compositor's `protect_mask` output into that keep_subject. Runs on the
// submitted workflow JSON, so the user never wires a mask by hand.
function injectProtectMaskWiring(workflow: any): void {
  if (!workflow?.nodes?.length) return
  if (!Array.isArray(workflow.links)) workflow.links = []
  const liveById = new Map((nodes.value as any[]).map(n => [String(n.id), n]))
  const compositors = (workflow.nodes as any[]).filter(n => n.type === 'Compositor')
  for (const comp of compositors) {
    if ((comp.mode ?? 0) !== 0) continue
    const live = liveById.get(String(comp.id))
    const defs = live?.data?.widgetDefs as any[] | undefined
    const wv = live?.data?.widgetsValues as any[] | undefined
    if (!defs || !wv) continue
    // Any layerN_protect widget truthy?
    const anyProtect = defs.some((d: any, i: number) =>
      /^layer\d+_protect$/.test(d?.name) && !!wv[i])
    if (!anyProtect) continue
    const outIdx = (comp.outputs as any[] | undefined)?.findIndex((o: any) => o?.name === 'protect_mask')
    if (outIdx == null || outIdx < 0) continue
    for (const node of workflow.nodes as any[]) {
      if (node.type !== 'BlendSceneNode' || (node.mode ?? 0) !== 0) continue
      // Only if this Blend Scene is actually fed by this Compositor.
      const fedByComp = (workflow.links as any[]).some(
        (l: any) => Array.isArray(l) && l[1] === comp.id && l[3] === node.id)
      if (!fedByComp) continue
      const ksIdx = (node.inputs as any[] | undefined)?.findIndex((inp: any) => inp?.name === 'keep_subject')
      if (ksIdx == null || ksIdx < 0) continue
      if (node.inputs[ksIdx].link != null) continue // user already wired one — respect it
      const linkId = (workflow.last_link_id || 0) + 1
      workflow.last_link_id = linkId
      workflow.links.push([linkId, comp.id, outIdx, node.id, ksIdx, 'MASK'])
      node.inputs[ksIdx].link = linkId
      if (!Array.isArray(comp.outputs[outIdx].links)) comp.outputs[outIdx].links = []
      comp.outputs[outIdx].links.push(linkId)
    }
  }
}

// Inject each Timeline node's editor state (tracks, clips, keyframes) into its
// hidden `edit_state` widget so the backend render matches the editor preview
// and FFmpeg export — keyframed transforms included. The editor already
// persists this JSON on the node (data.properties.edit_state); we just copy it
// into widgets_values at submit.
//
// Stale-schema handling: if the cached objectInfo predates a ComfyUI restart
// that added the `edit_state` input, setNamedWidget can't find the widget. A
// silent skip here meant the backend ran the legacy full-res path (budget
// refusals on 4K) with zero feedback. Instead we self-heal — force one fresh
// /object_info fetch and retry — and if the widget is STILL missing, throw so
// the caller's toast tells the user the remedy.
//
// Limitation: this heals only the PARENT's cache. If the ComfyUI iframe itself
// was loaded before the restart, its LiteGraph node registry is also stale and
// drops the injected trailing widget value at `configure`; that layer is
// covered by the bridge's warnIfEditStateDropped → `bridge_warning` toast
// (bridge.js), since only a page reload can refresh the iframe's registry.
async function injectTimelineEditState(workflow: any): Promise<void> {
  if (!workflow?.nodes?.length) return
  const timelines = (workflow.nodes as any[]).filter(n => n.type === 'Timeline')
  let schemaRefetched = false
  for (const tl of timelines) {
    if ((tl.mode ?? 0) !== 0) continue // muted/bypassed won't execute
    const liveNode = (nodes.value as any[]).find(n => n.id === String(tl.id))
    const raw = liveNode?.data?.properties?.edit_state ?? tl.properties?.edit_state
    if (!raw) continue
    const json = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (setNamedWidget(tl, 'edit_state', json, objectInfo.value)) continue
    // Cheap self-heal: the cached schema may simply be stale — refetch once
    // (bypassing the once-per-session gate) and retry the lookup.
    if (!schemaRefetched) {
      schemaRefetched = true
      console.warn('[Timeline] edit_state missing from cached schema — forcing /object_info refetch')
      await refreshSchema(true)
      if (setNamedWidget(tl, 'edit_state', json, objectInfo.value)) continue
    }
    throw new Error('Timeline schema is out of date — reload the page (ComfyUI restarted with new node definitions)')
  }
}

// Inject each Compositor node's baked motion params (Kinetic Slates) into its
// `motion_params` widget at submit. The Frame editor's bake persists
// {fps, duration, rendered: [...input PNGs...], source_key} on the node
// (data.properties.sailor_motionParams — see CompositorModal.vue); we pass
// the stored JSON through verbatim. No staleness recompute here — the editor's
// stale badge is the user-facing guard, and the backend gets source_key for
// future use. Same stale-schema self-heal as injectTimelineEditState above.
async function injectCompositorMotionParams(workflow: any): Promise<void> {
  if (!workflow?.nodes?.length) return
  const comps = (workflow.nodes as any[]).filter(n => n.type === 'Compositor')
  let schemaRefetched = false
  for (const comp of comps) {
    if ((comp.mode ?? 0) !== 0) continue // muted/bypassed won't execute
    const liveNode = (nodes.value as any[]).find(n => n.id === String(comp.id))
    const raw = liveNode?.data?.properties?.sailor_motionParams ?? comp.properties?.sailor_motionParams
    if (!raw) continue
    const json = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (setNamedWidget(comp, 'motion_params', json, objectInfo.value)) continue
    if (!schemaRefetched) {
      schemaRefetched = true
      console.warn('[Compositor] motion_params missing from cached schema — forcing /object_info refetch')
      await refreshSchema(true)
      if (setNamedWidget(comp, 'motion_params', json, objectInfo.value)) continue
    }
    throw new Error('Frame schema is out of date — reload the page (ComfyUI restarted with new node definitions)')
  }
}

// Push each Compositor node's wired-layer cloners (editor state on the
// sailor_wiredCloners property — see CompositorModal.vue) into their
// layer{i}_cloner widgets so the backend stamps the same clones the editor
// previews. Only ENABLED cloners are written; absent ⇒ widgets stay at "" (a
// single instance). Same stale-schema self-heal as injectCompositorMotionParams:
// if the widget is still missing after a forced /object_info refetch, ComfyUI
// wasn't restarted with the new node definition → throw a clear remedy.
async function injectCompositorCloners(workflow: any): Promise<void> {
  if (!workflow?.nodes?.length) return
  const comps = (workflow.nodes as any[]).filter(n => n.type === 'Compositor')
  let schemaRefetched = false
  for (const comp of comps) {
    if ((comp.mode ?? 0) !== 0) continue // muted/bypassed won't execute
    const liveNode = (nodes.value as any[]).find(n => n.id === String(comp.id))
    // Legacy registry first (1-based slot → Cloner), then the schema-2 layers on
    // top of it: once a slot is a LAYER, the layer owns its cloner and the
    // registry is a frozen pre-migration copy. Reading only the registry would
    // render the server with a cloner the editor stopped showing.
    const props = liveNode?.data?.properties ?? comp.properties
    const map: Record<string, any> = { ...((props?.sailor_wiredCloners as Record<string, any>) ?? {}) }
    for (const l of ((props?.sailor_localLayers as any[]) ?? [])) {
      if (l?.kind !== 'wired' || !Number.isInteger(l.slot)) continue
      const n = String(l.slot + 1)
      if (l.cloner) map[n] = l.cloner
      else delete map[n]
    }
    const entries = wiredClonerWidgetEntries(map)
    for (const { name, json } of entries) {
      if (setNamedWidget(comp, name, json, objectInfo.value)) continue
      if (!schemaRefetched) {
        schemaRefetched = true
        console.warn('[Compositor] layer_cloner missing from cached schema — forcing /object_info refetch')
        await refreshSchema(true)
        if (setNamedWidget(comp, name, json, objectInfo.value)) continue
      }
      throw new Error('Frame schema is out of date — restart ComfyUI (and reload) to render layer cloners')
    }
  }
}

/** Fold the project's active brand kit into every SmartLayout node at submit.
 *  `kitKv` is the kit serialized as key=value lines (brandKitToKv); empty ⇒
 *  no active kit ⇒ leave every widget untouched (byte-identical submit).
 *  The kit lands in the `brand_kit` widget, which the node merges UNDER any
 *  wired `brand` socket values — the graph stays the ultimate override. */
/** Bake Collection-bound layout vars (element↔column bindings) into each
 *  SmartLayout node's `layout` widget at submit, resolved against the
 *  collection's preview row — so a plain canvas Generate renders the same
 *  values the node-face preview shows instead of the raw `{{ props.… }}`
 *  tokens (the Collection node itself never reaches ComfyUI). */
function injectSmartLayoutCollectionVars(workflow: any): void {
  injectSmartLayoutVars(workflow, objectInfo.value)
}

async function injectSmartLayoutBrand(workflow: any, kitKv: string): Promise<void> {
  if (!kitKv || !workflow?.nodes?.length) return
  const layouts = (workflow.nodes as any[]).filter(n => n.type === 'SmartLayout')
  let schemaRefetched = false
  for (const node of layouts) {
    if ((node.mode ?? 0) !== 0) continue // muted/bypassed won't execute
    if (setNamedWidget(node, 'brand_kit', kitKv, objectInfo.value)) continue
    if (!schemaRefetched) {
      schemaRefetched = true
      console.warn('[SmartLayout] brand_kit missing from cached schema — forcing /object_info refetch')
      await refreshSchema(true)
      if (setNamedWidget(node, 'brand_kit', kitKv, objectInfo.value)) continue
    }
    throw new Error('Smart Layout schema is out of date — reload the page (ComfyUI restarted with new node definitions)')
  }
}

/**
 * Resolve `@refs` into the outgoing workflow, client-side, before submit:
 *  (a) prompt strings: substitute `@name` → the ref's text (Mode 1);
 *  (b) image-loader widgets bound to `@name`: set the 'image' widget to the
 *      resolved input filename.
 * Frontend-only; ComfyUI never sees a reference.
 */
async function injectAssetRegistry(workflow: any, reg: RefRegistry): Promise<void> {
  if (!reg || !Object.keys(reg).length || !workflow?.nodes?.length) return

  // (a0) materialize Reference nodes into real Image loaders so their
  // resolved filename actually reaches ComfyUI
  materializeReferenceNodes(workflow, reg)

  // (a) prompt tokens
  applyRefPromptTokens(workflow, reg)

  // (b) image-loader widgets bound to @name
  for (const node of workflow.nodes as any[]) {
    if ((node.mode ?? 0) !== 0) continue // muted/bypassed won't execute
    const bindings = node.properties?.[BINDINGS_PROP]
    if (!bindings) continue
    for (const b of Object.values(bindings) as any[]) {
      if (!isRefBinding(b)) continue
      const filename = resolveRefFilename(reg, b.refName)
      if (filename) setNamedWidget(node, 'image', filename, objectInfo.value)
    }
  }
}

// ── Client-side Timeline preview ────────────────────────────────────────────
// Mirrors the Compositor pattern but for video sources: each connected clip
// has a hidden <video>; we seek each one to the timeline's middle frame and
// composite them with the same transform/blend math the backend uses. The
// resulting still becomes the node-body preview via `data.images`.

const TIMELINE_FPS = 30
const timelinePreviewUrls = new Map<string, string>()
const timelinePreviewVideos = new Map<string, HTMLVideoElement>()  // keyed `${nodeId}-${slot}`
const timelineRenderTokens = new Map<string, number>()
let timelineRendering = false
let timelineDirty = false
let timelineRafHandle = 0

/** Resolve a Timeline clip port (slot = port_index, 1-based) to a still poster
 *  source. Uses the shared resolver but collapses a baked frame sequence to a
 *  single guaranteed-visible mid frame, and skips the generic images fallback
 *  so the baked poster never tries to render arbitrary upstream nodes. */
function getTimelineClipSource(node: any, slot: number): ClipSource | null {
  const edge = (edges.value as any[]).find((e: any) =>
    e.target === node.id && e.targetHandle === `input-${slot - 1}`)
  if (!edge) return null
  const src = (nodes.value as any[]).find((n: any) => n.id === edge.source)
  return resolveClipSource(src, { kinetic: 'mid', imagesFallback: false })
}

function collectTimelineLayers(node: any): any[] {
  // Prefer the editor's edit_state (workflow clips with real timing) — this is
  // where clips added via the Timeline editor live. Fall back to the legacy
  // flat clip{i}_* widgets for graphs wired without the editor.
  const rawState = node.data?.properties?.edit_state
  if (rawState) {
    try {
      const parsed = typeof rawState === 'string' ? JSON.parse(rawState) : rawState
      const state = migrateEditState(parsed)
      if (state && Array.isArray(state.tracks)) {
        const out: any[] = []
        for (const track of state.tracks) {
          if (track.muted || track.kind === 'audio') continue
          for (const clip of track.clips || []) {
            if (clip.kind !== 'workflow') continue
            const source = getTimelineClipSource(node, Number(clip.port_index ?? 0))
            if (!source) continue
            out.push({
              slot: clip.port_index, url: source.url, srcKind: source.kind,
              start: Number(clip.start_frame ?? 0), length: Number(clip.length ?? 30),
              x: Number(clip.x ?? 0), y: Number(clip.y ?? 0),
              rot: Number(clip.rotation ?? 0), scl: Number(clip.scale ?? 1),
              op: Number(clip.opacity ?? 1), blend: String(clip.blend ?? 'normal'),
              fadeIn: Number(clip.fade_in ?? 0), fadeOut: Number(clip.fade_out ?? 0),
            })
          }
        }
        if (out.length) return out
      }
    } catch { /* fall through to legacy */ }
  }

  const defs = node.data?.widgetDefs as any[]
  const wv = node.data?.widgetsValues as any[]
  if (!defs || !wv) return []
  const idx = (name: string) => defs.findIndex((d: any) => d.name === name)
  const out: any[] = []
  for (let i = 1; i <= 4; i++) {
    const source = getTimelineClipSource(node, i)
    if (!source) continue
    out.push({
      slot: i, url: source.url, srcKind: source.kind,
      start:   Number(wv[idx(`clip${i}_start`)]    ?? 0),
      length:  Number(wv[idx(`clip${i}_length`)]   ?? 30),
      x:       Number(wv[idx(`clip${i}_x`)]        ?? 0),
      y:       Number(wv[idx(`clip${i}_y`)]        ?? 0),
      rot:     Number(wv[idx(`clip${i}_rotation`)] ?? 0),
      scl:     Number(wv[idx(`clip${i}_scale`)]    ?? 1),
      op:      Number(wv[idx(`clip${i}_opacity`)]  ?? 1),
      blend:   String(wv[idx(`clip${i}_blend`)]    ?? 'normal'),
      fadeIn:  Number(wv[idx(`clip${i}_fade_in`)]  ?? 0),
      fadeOut: Number(wv[idx(`clip${i}_fade_out`)] ?? 0),
    })
  }
  return out
}

/** Load an image source for the timeline preview (parallels loadVideoForPreview). */
function loadImageForPreview(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

function loadVideoForPreview(key: string, url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    let v = timelinePreviewVideos.get(key)
    const targetSrc = new URL(url, window.location.href).href
    if (v && v.src === targetSrc && v.readyState >= 2 && v.videoWidth > 0) {
      resolve(v); return
    }
    if (!v) {
      v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      v.preload = 'auto'
      v.crossOrigin = 'anonymous'
      timelinePreviewVideos.set(key, v)
    }
    const cleanup = () => {
      v!.removeEventListener('loadeddata', onLoaded)
      v!.removeEventListener('error', onError)
    }
    const onLoaded = () => { cleanup(); resolve(v!) }
    const onError = () => { cleanup(); reject(new Error('video load failed')) }
    v.addEventListener('loadeddata', onLoaded)
    v.addEventListener('error', onError)
    if (v.src !== targetSrc) {
      v.src = url
      v.load()
    }
    // If already loaded enough, fire the resolve directly on next tick.
    if (v.readyState >= 2 && v.videoWidth > 0) {
      cleanup()
      resolve(v)
    }
  })
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const dur = v.duration
    if (!isFinite(dur) || dur <= 0) { resolve(); return }
    const target = Math.max(0, Math.min(dur, t))
    if (Math.abs(v.currentTime - target) < 0.05) { resolve(); return }
    let done = false
    const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', finish); resolve() }
    v.addEventListener('seeked', finish)
    try { v.currentTime = target } catch { finish(); return }
    // Belt-and-suspenders: don't hang if seek doesn't fire.
    setTimeout(finish, 800)
  })
}

async function renderTimeline(node: any, layers: any[]): Promise<string | null> {
  const defs = node.data?.widgetDefs as any[]
  const wv = node.data?.widgetsValues as any[]
  const idx = (name: string) => defs.findIndex((d: any) => d.name === name)
  const explicit = Number(wv[idx('total_duration')] ?? 0)
  const total = explicit > 0
    ? explicit
    : layers.reduce((m, L) => Math.max(m, L.start + L.length), 1)
  const previewFrame = Math.floor(total / 2)
  const bgColor = String(wv[idx('bg_color')] ?? '#000000')

  // Load each layer's source — video (seeked to its local time) or image.
  const els: (HTMLVideoElement | HTMLImageElement | null)[] = await Promise.all(
    layers.map(async (L) => {
      try {
        if (L.srcKind === 'image') return await loadImageForPreview(L.url)
        const v = await loadVideoForPreview(`${node.id}-${L.slot}`, L.url)
        const inWindow = previewFrame >= L.start && previewFrame < L.start + L.length
        if (inWindow) {
          const localSec = (previewFrame - L.start) / TIMELINE_FPS
          const dur = v.duration
          if (isFinite(dur) && dur > 0) await seekVideo(v, ((localSec % dur) + dur) % dur)
        }
        return v
      } catch { return null }
    }),
  )

  const dimsOf = (el: HTMLVideoElement | HTMLImageElement | null): [number, number] => {
    if (!el) return [0, 0]
    if (el instanceof HTMLVideoElement) return [el.videoWidth, el.videoHeight]
    return [el.naturalWidth, el.naturalHeight]
  }

  // Canvas size from the first valid source, scaled down for thumbnail use.
  const ref = els.find(el => dimsOf(el)[0] > 0)
  if (!ref) return null
  const [rw, rh] = dimsOf(ref)
  const maxDim = 384
  const aspect = rw / rh
  const w = aspect >= 1 ? maxDim : Math.round(maxDim * aspect)
  const h = aspect >= 1 ? Math.round(maxDim / aspect) : maxDim

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]!
    const el = els[i]
    const [sw, sh] = dimsOf(el)
    if (!el || sw === 0) continue
    if (previewFrame < L.start || previewFrame >= L.start + L.length) continue

    // Fade
    const localFrame = previewFrame - L.start
    let fadeAlpha = 1
    if (L.fadeIn > 0 && localFrame < L.fadeIn) fadeAlpha *= localFrame / L.fadeIn
    if (L.fadeOut > 0 && localFrame > L.length - L.fadeOut) {
      fadeAlpha *= (L.length - localFrame) / L.fadeOut
    }
    fadeAlpha = Math.max(0, Math.min(1, fadeAlpha))

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, L.op * fadeAlpha))
    ctx.globalCompositeOperation = BLEND_MAP[L.blend] || 'source-over'
    // Object-contain fit (matches backend `_fit_to_canvas`).
    const cAspect = w / h
    const vAspect = sw / sh
    let fitW: number, fitH: number
    if (vAspect > cAspect) { fitW = w; fitH = w / vAspect }
    else                   { fitH = h; fitW = h * vAspect }
    const cx = w / 2 + L.x * w
    const cy = h / 2 + L.y * h
    ctx.translate(cx, cy)
    ctx.rotate((L.rot * Math.PI) / 180)
    ctx.scale(L.scl, L.scl)
    try { ctx.drawImage(el, -fitW / 2, -fitH / 2, fitW, fitH) } catch {}
    ctx.restore()
  }

  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('toBlob returned null'))
      resolve(URL.createObjectURL(blob))
    }, 'image/png')
  })
}

async function renderOneTimeline(node: any) {
  const layers = collectTimelineLayers(node)
  if (!layers.length) {
    const oldUrl = timelinePreviewUrls.get(node.id)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    timelinePreviewUrls.delete(node.id)
    if (node.data.images?.length) node.data = { ...node.data, images: [] }
    return
  }
  const token = (timelineRenderTokens.get(node.id) || 0) + 1
  timelineRenderTokens.set(node.id, token)
  try {
    const url = await renderTimeline(node, layers)
    if (url == null) return
    if (timelineRenderTokens.get(node.id) !== token) {
      URL.revokeObjectURL(url)
      return
    }
    const oldUrl = timelinePreviewUrls.get(node.id)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    timelinePreviewUrls.set(node.id, url)
    node.data = { ...node.data, images: [url] }
  } catch (err) {
    console.warn('[Timeline preview] render failed:', err)
  }
}

function timelineSnapshot(node: any) {
  const inputs = node.data.inputs as any[]
  const sources = inputs.map((port, i) => {
    if (port?.link == null) return null
    const edge = (edges.value as any[]).find((e: any) =>
      e.target === node.id && e.targetHandle === `input-${i}`)
    if (!edge) return null
    const src = (nodes.value as any[]).find((n: any) => n.id === edge.source)
    // Track file widget value (filename) since that's what changes when the user picks a new clip.
    if (src?.data?.nodeType === 'LoadVideoFrames' || src?.data?.nodeType === 'LoadVideo') {
      const fileIdx = src.data.widgetDefs?.findIndex((d: any) => d.name === 'file') ?? 0
      return src.data.widgetsValues?.[fileIdx >= 0 ? fileIdx : 0] ?? null
    }
    // A Vector Type node migrated from the retired KineticType carries that
    // node's baked frame sequence — track the count + first filename so a
    // re-bake invalidates the poster, exactly as it did before the migration.
    if (src?.data?.nodeType === 'VectorType') {
      const frames = (src.data.properties?.sailor_kineticLegacy as any)?.frames
      const r = Array.isArray(frames) ? frames : []
      if (r.length) return `vt:${r.length}:${r[0] ?? ''}`
    }
    // Universal artifact nodes: track the upload widget so picking a new file
    // invalidates the baked poster (falls back to images[0] post-run).
    if (src?.data?.nodeType === 'Video' || src?.data?.nodeType === 'Image') {
      const widgetName = src.data.nodeType === 'Video' ? 'file' : 'image'
      const wIdx = src.data.widgetDefs?.findIndex((d: any) => d.name === widgetName) ?? -1
      const fn = wIdx >= 0 ? src.data.widgetsValues?.[wIdx] : undefined
      return fn ?? src?.data?.images?.[0] ?? null
    }
    return src?.data?.images?.[0] ?? null
  })
  // Include edit_state so adding/moving clips in the editor triggers a refresh.
  const editState = node.data?.properties?.edit_state
  const editKey = typeof editState === 'string' ? editState : (editState ? JSON.stringify(editState) : '')
  return { id: node.id, widgets: [...(node.data.widgetsValues as any[])], inputs: inputs.map(i => i.link), sources, editKey }
}

async function maybeRenderTimelines() {
  if (timelineRendering) { timelineDirty = true; return }
  timelineRendering = true
  timelineDirty = false
  try {
    const tls = (nodes.value as any[]).filter(n => n.data?.nodeType === 'Timeline')
    await Promise.all(tls.map(renderOneTimeline))
  } finally {
    timelineRendering = false
    if (timelineDirty) maybeRenderTimelines()
  }
}

// Note: the static Timeline preview renderer is left in place but disabled —
// the Timeline node body uses TimelineNodePreview.vue (an embedded animated
// canvas) instead. Helpers above remain available if a future use needs a
// single-frame snapshot.

// Track whether any node is currently running (for background animation)
const isRunning = computed(() => (nodes.value as any[]).some((n: any) => n.data?.running))

// ---------------------------------------------------------------------------
// Context menu state + actions
// ---------------------------------------------------------------------------

interface MenuState { x: number; y: number; items: MenuItem[] }
const menu = ref<MenuState | null>(null)
function closeMenu() { menu.value = null }
function openMenu(x: number, y: number, items: MenuItem[]) { menu.value = { x, y, items } }

// Pending target ids for filtered run — emitted to the parent layout via a
// custom event so the existing runVueWorkflow plumbing can stay one path.
// Pre-flight: a Load* node with no file selected is rejected by ComfyUI's
// validation, but the run path swallows that — so the workflow just "doesn't
// run" with no feedback. Catch it here and name the offending node. (Unified
// artifact nodes are exempt: they can legitimately be empty while capturing an
// upstream result.)
const MEDIA_LOADERS: Record<string, { widget: string, label: string }> = {
  LoadImage: { widget: 'image', label: 'image' },
  LoadImageOutput: { widget: 'image', label: 'image' },
  LoadVideo: { widget: 'video', label: 'video' },
  LoadAudio: { widget: 'audio', label: 'audio' },
}
function preflightMediaInputs(targetIds?: Set<string>): boolean {
  for (const n of nodes.value as any[]) {
    if (targetIds && !targetIds.has(n.id)) continue
    const spec = MEDIA_LOADERS[n.data?.nodeType]
    if (!spec) continue
    if (n.data?.mode === 2 || n.data?.mode === 4) continue // muted / bypassed
    const idx = (n.data?.widgetDefs as any[])?.findIndex((d: any) => d.name === spec.widget) ?? -1
    const val = idx >= 0 ? n.data?.widgetsValues?.[idx] : undefined
    if (!val || (typeof val === 'string' && !val.trim())) {
      const article = /^[aeiou]/.test(spec.label) ? 'an' : 'a'
      toast.error(`Pick ${article} ${spec.label} before running`, {
        description: `"${n.data?.title || n.data?.nodeType}" has no ${spec.label} selected.`,
      })
      return false
    }
  }
  return true
}

function emitRunFiltered(targetIds: string[]) {
  if (!preflightMediaInputs(new Set(targetIds))) return
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds } }))
}
function emitRunAll() {
  if (!preflightMediaInputs()) return
  window.dispatchEvent(new CustomEvent('sailor:runAll'))
}

// Actions that operate on a set of node ids ---------------------------------

function setMode(nodeIds: string[], mode: number) {
  const set = new Set(nodeIds)
  for (const n of nodes.value as any[]) {
    if (set.has(n.id)) n.data = { ...n.data, mode }
  }
}
function toggleMode(nodeIds: string[], mode: number) {
  // If ANY selected node is already at this mode, clear all to 0. Otherwise
  // set all to the requested mode. Matches the "press Tab again to untoggle"
  // user expectation.
  const set = new Set(nodeIds)
  const anyAtMode = (nodes.value as any[]).some(n => set.has(n.id) && (n.data?.mode ?? 0) === mode)
  setMode(nodeIds, anyAtMode ? 0 : mode)
}

function duplicateNodes(nodeIds: string[]) {
  const set = new Set(nodeIds)
  const originals = (nodes.value as any[]).filter(n => set.has(n.id))
  const offset = 32
  for (const orig of originals) {
    const newId = String(Date.now() + Math.floor(Math.random() * 1000))
    nodes.value.push({
      ...orig,
      id: newId,
      position: { x: orig.position.x + offset, y: orig.position.y + offset },
      selected: false,
      data: JSON.parse(JSON.stringify(orig.data || {})),
    })
  }
}

// ---- Copy / paste (Cmd+C / Cmd+V) ----------------------------------------
// True when the user has a real text selection — so Cmd+C copies that text
// instead of the selected node(s).
function hasTextSelection(): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  return !!sel && sel.type === 'Range' && sel.toString().length > 0
}

// Snapshot the selected node(s) + the edges running between them into the
// in-app clipboard. Returns false (so the keydown handler doesn't preventDefault)
// when there's nothing selected to copy.
function copySelection(): boolean {
  const ids = getSelectedNodeIds()
  if (!ids.length) return false
  const set = new Set(ids)
  const clipNodes = (nodes.value as any[])
    .filter(n => set.has(n.id))
    .map(n => ({
      id: n.id,
      type: n.type,
      position: { x: n.position.x, y: n.position.y },
      data: JSON.parse(JSON.stringify(n.data || {})),
    }))
  const clipEdges = (edges.value as any[])
    .filter(ed => set.has(ed.source) && set.has(ed.target))
    .map(ed => ({
      source: ed.source,
      target: ed.target,
      sourceHandle: ed.sourceHandle ?? null,
      targetHandle: ed.targetHandle ?? null,
      type: ed.type,
      data: ed.data ? JSON.parse(JSON.stringify(ed.data)) : undefined,
    }))
  nodeClipboard.write({ nodes: clipNodes, edges: clipEdges })
  // Claim the OS clipboard too (like any app's Copy). Without this, an OLD
  // screenshot on the OS clipboard outranks this fresh node copy forever —
  // handlePaste prefers OS images by design, so Cmd+V would keep pasting the
  // stale image instead of the node. Writing text evicts the image; a
  // screenshot taken AFTER this copy overwrites it and rightfully wins.
  // Best-effort: clipboard access can be denied — the in-app buffer above is
  // the source of truth either way.
  try { navigator.clipboard?.writeText('⎘ Sailor nodes — paste on the canvas') } catch { /* non-secure context */ }
  return true
}

// Drop the clipboard's node(s) at the cursor, preserving relative layout and
// the internal wiring, then select the fresh copies. Repeated Cmd+V keeps
// pasting at the current cursor position. IDs stay numeric — the workflow
// conversion parseInts them (see materializeAutoImageSinks).
function pasteClipboard(): boolean {
  const clip = nodeClipboard.read()
  if (!clip || !clip.nodes.length) return false
  const ox = Math.min(...clip.nodes.map(n => n.position.x))
  const oy = Math.min(...clip.nodes.map(n => n.position.y))
  const screen = lastMouseClient ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const target = project(screen)

  // Clear the existing selection so the pasted nodes become the selection.
  for (const n of (nodes.value as any[])) if (n.selected) n.selected = false

  let seed = Date.now()
  const idMap = new Map<string, string>()
  for (const cn of clip.nodes) {
    const newId = String(seed++)
    idMap.set(cn.id, newId)
    nodes.value.push({
      id: newId,
      type: cn.type,
      position: { x: target.x + (cn.position.x - ox), y: target.y + (cn.position.y - oy) },
      selected: true,
      data: JSON.parse(JSON.stringify(cn.data)),
    } as any)
  }
  for (const ce of clip.edges) {
    const s = idMap.get(ce.source)
    const t = idMap.get(ce.target)
    if (!s || !t) continue
    edges.value.push({
      id: `e-paste-${s}-${t}-${ce.sourceHandle || ''}-${ce.targetHandle || ''}`,
      source: s,
      sourceHandle: ce.sourceHandle ?? undefined,
      target: t,
      targetHandle: ce.targetHandle ?? undefined,
      type: ce.type || 'comfy',
      data: ce.data ? JSON.parse(JSON.stringify(ce.data)) : undefined,
    } as any)
  }
  return true
}

function deleteNodes(nodeIds: string[]) {
  if (!nodeIds.length) return
  removeNodes(nodeIds)
}
function deleteEdges(edgeIds: string[]) {
  if (!edgeIds.length) return
  removeEdges(edgeIds)
}

// Group actions -------------------------------------------------------------

function actionGroupSelection() {
  const ids = getSelectedNodeIds()
  if (!ids.length) return
  createGroupFromSelection(ids)
}

function actionRunGroup(groupId: string) {
  const ids = nodesInGroup(groupId)
  if (!ids.length) return
  emitRunFiltered(ids)
}

function actionGroupModeAll(groupId: string, mode: number) {
  const ids = nodesInGroup(groupId)
  setMode(ids, mode)
}

// Block library — saves the group's contained nodes + internal links as a
// reusable template that can be dragged or clicked back onto any canvas.
const { saveBlock, getBlock } = useBlockLibrary()

/**
 * Insert a saved block at the given graph-space position. Strategy:
 *  1. Snapshot the current canvas into LG format.
 *  2. Assign fresh node IDs to the block's nodes (offset from last_node_id).
 *  3. Translate each block node's position by the drop point.
 *  4. Rebuild the block's internal links with fresh link IDs and the new
 *     node IDs.
 *  5. Add a new group encompassing the inserted nodes.
 *  6. Re-run convertFromLiteGraph against the merged snapshot.
 *
 * Re-running the conversion is destructive (replaces nodes.value / edges.value),
 * but the merged snapshot contains both the existing graph and the inserted
 * block — so the user's pre-existing nodes are preserved. Selection / drag
 * UI-state on existing nodes is cleared as a minor side effect; acceptable
 * for v1, and the history mechanism still lets undo work.
 */
function insertBlock(blockId: string, position: { x: number; y: number }) {
  const block = getBlock(blockId)
  if (!block) return

  const snapshot = convertToLiteGraph() as any
  const baseNodeId = Math.max(0, ...(snapshot.nodes || []).map((n: any) => Number(n.id))) + 1
  const baseLinkId = Math.max(0, ...(snapshot.links || []).map((l: any[]) => Number(l[0]))) + 1

  // old block-node-id → new fresh id
  const idMap = new Map<number, number>()
  block.nodes.forEach((n: any, i: number) => idMap.set(Number(n.id), baseNodeId + i))

  const insertedNodes = block.nodes.map((n: any) => {
    const newId = idMap.get(Number(n.id))!
    return {
      ...JSON.parse(JSON.stringify(n)), // deep clone so we don't mutate the stored block
      id: newId,
      pos: [n.pos[0] + position.x, n.pos[1] + position.y] as [number, number],
    }
  })

  const insertedLinks = (block.links || []).map((link: any[], i: number) => {
    if (!Array.isArray(link) || link.length < 6) return null
    const [, srcId, srcSlot, dstId, dstSlot, type] = link
    const newSrc = idMap.get(Number(srcId))
    const newDst = idMap.get(Number(dstId))
    if (newSrc == null || newDst == null) return null
    return [baseLinkId + i, newSrc, srcSlot, newDst, dstSlot, type]
  }).filter(Boolean)

  // Compute the group's new top-left from the inserted nodes (positions are
  // already absolute now). Width/height come from the stored block bounds.
  const groupOriginX = position.x
  const groupOriginY = position.y
  const newGroupRaw = {
    title: block.name,
    bounding: [groupOriginX, groupOriginY, block.bounds.width, block.bounds.height],
    color: block.color,
    font_size: 24,
  }

  const merged = {
    ...snapshot,
    nodes: [...(snapshot.nodes || []), ...insertedNodes],
    links: [...(snapshot.links || []), ...insertedLinks],
    groups: [...(snapshot.groups || []), newGroupRaw],
    last_node_id: baseNodeId + block.nodes.length - 1,
    last_link_id: baseLinkId + insertedLinks.length - 1,
  }

  convertFromLiteGraph(merged)
}

/** Drop-handler counterpart for block payloads (vs node-type strings). */
function tryHandleBlockDrop(event: DragEvent): boolean {
  const blockId = event.dataTransfer?.getData('application/x-sailor-block')
  if (!blockId) return false
  const canvasEl = event.currentTarget as HTMLElement
  const rect = canvasEl.getBoundingClientRect()
  const dropPos = project({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  })
  insertBlock(blockId, dropPos)
  return true
}

/** Click-to-insert at viewport center. Listens for the panel's custom event. */
function handleInsertBlockEvent(e: Event) {
  const detail = (e as CustomEvent).detail
  const blockId = detail?.blockId as string | undefined
  if (!blockId) return
  // Convert the screen-space viewport center into graph-space.
  const canvasEl = document.querySelector('.vue-flow') as HTMLElement | null
  const rect = canvasEl?.getBoundingClientRect()
  const centerScreen = rect
    ? { x: rect.width / 2, y: rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const centerGraph = project(centerScreen)
  // Anchor the block's group at the center by offsetting half its bounds.
  const block = getBlock(blockId)
  if (!block) return
  insertBlock(blockId, {
    x: centerGraph.x - block.bounds.width / 2,
    y: centerGraph.y - block.bounds.height / 2,
  })
}
onMounted(() => window.addEventListener('sailor:insertBlock', handleInsertBlockEvent))
onBeforeUnmount(() => window.removeEventListener('sailor:insertBlock', handleInsertBlockEvent))

function actionSaveGroupAsBlock(groupId: string) {
  const group = groups.value.find(g => g.id === groupId)
  if (!group) return
  const memberIds = nodesInGroup(groupId)
  if (!memberIds.length) {
    if (typeof window !== 'undefined') window.alert('This group has no nodes to save.')
    return
  }
  const defaultName = group.title && group.title !== 'Group' ? group.title : ''
  const name = window.prompt('Save block as:', defaultName)
  if (!name || !name.trim()) return

  // Build a LiteGraph snapshot of just the group's contents.
  const wf = convertToLiteGraph()
  const memberIdSet = new Set(memberIds.map(Number))
  const blockNodes = (wf.nodes || []).filter((n: any) => memberIdSet.has(n.id))
  // Internal links only — drop anything that crosses the group boundary.
  const blockLinks = (wf.links || []).filter((link: any) => {
    if (!Array.isArray(link) || link.length < 4) return false
    return memberIdSet.has(Number(link[1])) && memberIdSet.has(Number(link[3]))
  })

  saveBlock({
    name: name.trim(),
    color: group.color,
    nodes: blockNodes,
    links: blockLinks,
    bounds: { width: group.width, height: group.height },
    // Subtract this origin from each node's position so the block stores
    // positions relative to the group's top-left corner.
    origin: { x: group.x, y: group.y },
  })
}

/**
 * Toggle a mode across every node in a group: if every node is already at
 * `mode`, reset them all to 0 (normal); otherwise set every node to `mode`.
 * Powers the title-bar bypass/mute icons.
 */
function actionToggleGroupMode(groupId: string, mode: number) {
  const ids = nodesInGroup(groupId)
  if (!ids.length) return
  const set = new Set(ids)
  const allAt = (nodes.value as any[]).filter(n => set.has(n.id)).every(n => (n.data?.mode ?? 0) === mode)
  setMode(ids, allAt ? 0 : mode)
}

/**
 * Returns 'all' if every contained node is at `mode`, 'mixed' if some are,
 * 'none' otherwise. Used to drive the toggle icons' active state.
 */
function groupModeState(groupId: string, mode: number): 'none' | 'mixed' | 'all' {
  const ids = nodesInGroup(groupId)
  if (!ids.length) return 'none'
  const set = new Set(ids)
  let on = 0
  for (const n of nodes.value as any[]) {
    if (set.has(n.id) && (n.data?.mode ?? 0) === mode) on++
  }
  if (on === 0) return 'none'
  if (on === ids.length) return 'all'
  return 'mixed'
}

function colorSubmenuItems(applyColor: (color: string) => void): MenuItem[] {
  return GROUP_COLORS.map(c => ({
    label: c,
    swatch: c,
    action: () => applyColor(c),
  }))
}

// Menu builders -------------------------------------------------------------

function paneMenuItems(x: number, y: number): MenuItem[] {
  // Convert click coords (screen space) to graph space so spawned annotations
  // land where the user clicked, not at viewport origin.
  const spawn = project({ x, y })
  return [
    { label: 'Run All', icon: Play, action: () => emitRunAll() },
    { divider: true },
    {
      label: 'Add Sticky Note',
      icon: StickyNote,
      action: () => createSticky({ x: spawn.x, y: spawn.y }),
      shortcut: 'S',
    },
    {
      label: 'Add Checklist',
      icon: ListChecks,
      action: () => createChecklist({ x: spawn.x, y: spawn.y }),
      shortcut: 'C',
    },
    {
      label: 'Add Image Pin…',
      icon: ImageIcon,
      action: () => promptImagePin(spawn.x, spawn.y),
    },
    {
      label: 'Add Arrow',
      icon: ArrowRight,
      action: () => beginArrowFromPoint(spawn.x, spawn.y),
      shortcut: 'A',
    },
    {
      label: 'Add Frame',
      icon: Frame,
      action: () => createFrameAt({ x: spawn.x, y: spawn.y }),
      shortcut: 'F',
    },
    { divider: true },
    { label: 'Fit View', icon: Maximize2, action: () => fitView({ padding: 0.2 }) },
    { label: 'Select All', icon: SquareDashedMousePointer, action: () => {
      for (const n of nodes.value as any[]) n.selected = true
    } },
  ]
}

// Prompts the user for an image file, reads it as a data URL, then creates
// an image pin at the given graph-space coordinate.
function promptImagePin(x: number, y: number) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        createImagePin({ x, y, src: reader.result, caption: file.name })
      }
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

/** The on-disk file a node currently displays, as a deliverable source.
 *  `data.images[0]` (etc.) are `/view?…` URL strings — not objects — so parse
 *  filename/subfolder/type out of the query. Falls back to the persisted widget
 *  filename (loaded projects). Returns null for transient blob:/data: images. */
function firstNodeOutput(node: any): { filename: string; subfolder?: string; type?: string } | null {
  const d = node?.data
  if (!d) return null
  let raw: any = d.images?.[0] ?? d.gifs?.[0] ?? d.video?.[0] ?? d.audio?.[0]
  if (!raw && d.widgetsValues?.[0]) {
    raw = `/view?${new URLSearchParams({ filename: String(d.widgetsValues[0]), type: 'input' })}`
  }
  if (!raw) return null
  if (typeof raw === 'object') {
    return raw.filename ? { filename: raw.filename, subfolder: raw.subfolder || '', type: raw.type || 'output' } : null
  }
  if (typeof raw !== 'string') return null
  const qi = raw.indexOf('?')
  if (qi === -1) return null // blob:/data: URL — not a referenceable on-disk file
  const p = new URLSearchParams(raw.slice(qi + 1))
  const filename = p.get('filename')
  if (!filename) return null
  return { filename, subfolder: p.get('subfolder') || '', type: p.get('type') || 'output' }
}

function nodeMenuItems(nodeId: string): MenuItem[] {
  const node = (nodes.value as any[]).find(n => n.id === nodeId)
  const mode = node?.data?.mode ?? 0
  const items: MenuItem[] = [
    { label: 'Run from Selection', icon: Play, action: () => emitRunFiltered([nodeId]) },
    { divider: true },
    { label: mode === 4 ? 'Un-Bypass' : 'Bypass', icon: Ban, action: () => toggleMode([nodeId], 4) },
    { label: mode === 2 ? 'Un-Mute' : 'Mute', icon: EyeOff, action: () => toggleMode([nodeId], 2) },
    { divider: true },
  ]
  // For artifact image nodes that have a rendered image, offer pinning the
  // result to the canvas. The pin captures whatever metadata is visible on
  // the node at pin time — seed/prompt/model — by walking upstream.
  if (node?.type === 'artifact-image' && (node.data?.images?.[0] || node.data?.widgetsValues?.[0])) {
    items.push({
      label: 'Pin Result to Canvas',
      icon: ImageIcon,
      action: () => actionPinResultToCanvas(nodeId),
    })
    items.push({ divider: true })
  }
  // Mark an artifact's rendered output as "ready to deliver" (curation shelf).
  if (typeof node?.type === 'string' && node.type.startsWith('artifact-') && node.type !== 'artifact-text') {
    const output = firstNodeOutput(node)
    if (output) {
      items.push({
        label: 'Mark ready',
        icon: Check,
        action: () => window.dispatchEvent(new CustomEvent('sailor:markReady', { detail: { nodeId, output } })),
      })
      items.push({ divider: true })
    }
  }
  items.push(
    { label: 'Duplicate', icon: Copy, action: () => duplicateNodes([nodeId]) },
    { label: 'Delete', icon: Trash2, danger: true, action: () => deleteNodes([nodeId]) },
  )
  return items
}

/**
 * Pin a generated image from an artifact-image node onto the canvas. Walks
 * upstream edges looking for a sampler-shaped node to capture seed/prompt/
 * model metadata. Falls back gracefully if the upstream isn't a recognized
 * generator — caption can be added by the user.
 */
function actionPinResultToCanvas(nodeId: string) {
  const node = (nodes.value as any[]).find(n => n.id === nodeId)
  if (!node) return
  const src = node.data?.images?.[0]
    || (node.data?.widgetsValues?.[0]
      ? `/view?${new URLSearchParams({ filename: String(node.data.widgetsValues[0]), type: 'input' })}`
      : '')
  if (!src) return

  // Best-effort metadata harvest from immediate upstream nodes.
  const metadata: Record<string, any> = { sourceNodeId: nodeId }
  const upstream = (edges.value as any[]).filter(e => e.target === nodeId)
  for (const edge of upstream) {
    const srcNode = (nodes.value as any[]).find(n => n.id === edge.source)
    if (!srcNode) continue
    const t = srcNode.data?.nodeType || srcNode.type
    const w = srcNode.data?.widgetsValues || []
    if (/Sampler/i.test(t)) {
      // Comfy KSampler positions: seed, control, steps, cfg, sampler, scheduler, denoise
      if (typeof w[0] === 'number') metadata.seed = w[0]
      if (typeof w[2] === 'number') metadata.steps = w[2]
      if (typeof w[3] === 'number') metadata.cfg = w[3]
    } else if (/CheckpointLoader|UNETLoader/i.test(t)) {
      if (typeof w[0] === 'string') metadata.model = w[0]
    } else if (/CLIPTextEncode/i.test(t)) {
      // Prefer the first prompt found (positive is usually wired first).
      if (typeof w[0] === 'string' && !metadata.prompt) metadata.prompt = w[0]
    }
  }

  // Drop the pin to the right of the source node so it doesn't overlap.
  const spawnX = (node.position?.x ?? 0) + (node.dimensions?.width ?? 280) + 40
  const spawnY = (node.position?.y ?? 0)
  createResultPin({ x: spawnX, y: spawnY, src, metadata })
}

function selectionMenuItems(): MenuItem[] {
  const ids = getSelectedNodeIds()
  const items: MenuItem[] = [
    { label: `Run Selection (${ids.length})`, icon: Play, action: () => emitRunFiltered(ids) },
    { divider: true },
  ]
  // Offer "Combine into Frame" only when the selection has 2+ image-output nodes.
  const sel = (nodes.value as any[]).filter((n: any) => ids.includes(n.id))
  if (planFrameFromSelection(sel).canCombine) {
    items.push(
      { label: 'Combine into Frame', icon: Frame, action: () => combineIntoFrame(ids) },
      { divider: true },
    )
  }
  items.push(
    { label: 'Group Selection', icon: Group, action: () => actionGroupSelection() },
    { divider: true },
    { label: 'Bypass', icon: Ban, action: () => toggleMode(ids, 4) },
    { label: 'Mute', icon: EyeOff, action: () => toggleMode(ids, 2) },
    { divider: true },
    { label: 'Duplicate', icon: Copy, action: () => duplicateNodes(ids) },
    { label: 'Delete', icon: Trash2, danger: true, action: () => deleteNodes(ids) },
  )
  return items
}

function edgeMenuItems(edgeId: string): MenuItem[] {
  return [
    { label: 'Delete Edge', icon: Trash2, danger: true, action: () => deleteEdges([edgeId]) },
  ]
}

// Wrap dragGroup so annotations attached to the group travel with it.
// Splitting this out keeps the composable agnostic of annotations.
function onDragGroup(groupId: string, dx: number, dy: number) {
  dragGroup(groupId, dx, dy)
  dragGroupAttachedAnnotations(groupId, dx, dy)
}

// Wrap deleteGroup so the group's attached annotations don't outlive it
// as floating orphans.
const deleteGroupWithAnnotations = (groupId: string) => {
  removeAnnotationsForGroup(groupId)
  deleteGroup(groupId)
}

function statusSubmenuItems(groupId: string): MenuItem[] {
  // Tiny dot swatches communicate the chip color so the menu mirrors the chip.
  const opts: { value: CanvasGroup['status']; label: string; swatch: string }[] = [
    { value: null,       label: 'No status', swatch: 'transparent' },
    { value: 'wip',      label: 'WIP',       swatch: '#fbbf24' },
    { value: 'stable',   label: 'Stable',    swatch: '#4ade80' },
    { value: 'broken',   label: 'Broken',    swatch: '#f87171' },
    { value: 'archived', label: 'Archived',  swatch: '#94a3b8' },
  ]
  return opts.map(o => ({
    label: o.label,
    swatch: o.swatch,
    action: () => setGroupStatus(groupId, o.value),
  }))
}

function groupMenuItems(groupId: string): MenuItem[] {
  const g = groups.value.find(g => g.id === groupId)
  const collapsed = !!g?.collapsed
  const locked = !!g?.locked
  return [
    { label: 'Run Group', icon: Play, action: () => actionRunGroup(groupId) },
    { divider: true },
    {
      label: collapsed ? 'Expand Group' : 'Collapse Group',
      icon: collapsed ? ChevronsUpDown : ChevronsDownUp,
      action: () => toggleGroupCollapse(groupId),
    },
    {
      label: locked ? 'Unlock Group' : 'Lock Group',
      icon: locked ? Unlock : Lock,
      action: () => toggleGroupLock(groupId),
    },
    {
      label: 'Status',
      icon: Flag,
      children: statusSubmenuItems(groupId),
    },
    {
      label: 'Draw Arrow From Here…',
      icon: ArrowRight,
      action: () => beginArrowFromGroup(groupId),
    },
    { divider: true },
    { label: 'Bypass Group Nodes', icon: Ban, action: () => actionGroupModeAll(groupId, 4), disabled: locked },
    { label: 'Mute Group Nodes', icon: EyeOff, action: () => actionGroupModeAll(groupId, 2), disabled: locked },
    { label: 'Reset Group Nodes', icon: PlusSquare, action: () => actionGroupModeAll(groupId, 0), disabled: locked },
    { divider: true },
    { label: 'Save as Block…', icon: Boxes, action: () => actionSaveGroupAsBlock(groupId) },
    { divider: true },
    {
      label: 'Color',
      icon: Palette,
      children: colorSubmenuItems(c => updateGroup(groupId, { color: c })),
    },
    {
      label: 'Rename',
      icon: Edit3,
      action: () => {
        const newTitle = window.prompt('Group name', g?.title || 'Group')
        if (newTitle && newTitle.trim()) updateGroup(groupId, { title: newTitle.trim() })
      },
      disabled: locked,
    },
    { divider: true },
    { label: 'Delete Group', icon: Trash2, danger: true, action: () => deleteGroupWithAnnotations(groupId), disabled: locked },
  ]
}

// Event handlers ------------------------------------------------------------

function handlePaneContextMenu(event: MouseEvent) {
  event.preventDefault()
  openMenu(event.clientX, event.clientY, paneMenuItems(event.clientX, event.clientY))
}

function handleNodeContextMenu({ event, node }: { event: MouseEvent; node: any }) {
  event.preventDefault()
  event.stopPropagation()
  // If the right-clicked node is part of a multi-selection, show selection menu.
  const selectedIds = getSelectedNodeIds()
  const inSelection = selectedIds.length > 1 && selectedIds.includes(node.id)
  const items = inSelection ? selectionMenuItems() : nodeMenuItems(node.id)
  openMenu(event.clientX, event.clientY, items)
}

function handleEdgeContextMenu({ event, edge }: { event: MouseEvent; edge: any }) {
  event.preventDefault()
  event.stopPropagation()
  openMenu(event.clientX, event.clientY, edgeMenuItems(edge.id))
}

function handleSelectionContextMenu(payload: { event: MouseEvent; nodes: any[] } | MouseEvent) {
  // Vue Flow emits `{ event, nodes }`. Guard for either shape in case a
  // future version normalizes to MouseEvent directly.
  const event: MouseEvent = (payload as any)?.event ?? (payload as MouseEvent)
  event.preventDefault()
  event.stopPropagation()
  openMenu(event.clientX, event.clientY, selectionMenuItems())
}

function handleGroupContextMenu(groupId: string, x: number, y: number) {
  // If an arrow draw is in progress, prefer completing it on the group rather
  // than opening the context menu — the user's intent is clearly the arrow.
  if (pendingArrowFrom.value) {
    completePendingArrow({ kind: 'group', id: groupId })
    return
  }
  openMenu(x, y, groupMenuItems(groupId))
}

// Click on the empty canvas. Two responsibilities, in priority order:
//   1. If we're drawing an arrow, commit the `to` endpoint as a free point.
//   2. Otherwise, clear any active arrow selection (so the user can dismiss
//      the inline toolbar by clicking empty space).
function handlePaneClick(event: MouseEvent) {
  if (pendingArrowFrom.value) {
    const pos = project({ x: event.clientX, y: event.clientY })
    completePendingArrow({ kind: 'point', x: pos.x, y: pos.y })
    return
  }
  if (selectedArrowId.value) clearArrowSelection()
  if (selectedStickyId.value) clearStickySelection()
}

// Track cursor in graph space while an arrow is pending so the preview path
// follows the mouse. Wired via a window listener that's only active while
// drawing — keeps the mousemove cost zero when no arrow is in flight.
function trackPendingArrowCursor(event: MouseEvent) {
  if (!pendingArrowFrom.value) return
  const pos = project({ x: event.clientX, y: event.clientY })
  pendingArrowCursor.value = { x: pos.x, y: pos.y }
}
watch(pendingArrowFrom, (next, prev) => {
  if (next && !prev) window.addEventListener('mousemove', trackPendingArrowCursor)
  else if (!next && prev) window.removeEventListener('mousemove', trackPendingArrowCursor)
})

// Arrow context menu — small set: edit label, change color, delete.
function handleArrowContextMenu(arrowId: string, x: number, y: number) {
  const arrow = annotations.value.find(a => a.id === arrowId && a.kind === 'arrow') as
    Extract<typeof annotations.value[number], { kind: 'arrow' }> | undefined
  if (!arrow) return
  const ARROW_COLORS = ['#94a3b8', '#a78bfa', '#60a5fa', '#f472b6', '#fbbf24', '#4ade80']
  openMenu(x, y, [
    {
      label: 'Edit Label…',
      icon: Edit3,
      action: () => {
        const next = window.prompt('Arrow label', arrow.label || '')
        if (next !== null) updateAnnotation(arrowId, { label: next.trim() || undefined } as any)
      },
    },
    {
      label: 'Color',
      icon: Palette,
      children: ARROW_COLORS.map(c => ({
        label: c,
        swatch: c,
        action: () => updateAnnotation(arrowId, { color: c } as any),
      })),
    },
    { divider: true },
    { label: 'Delete Arrow', icon: Trash2, danger: true, action: () => removeAnnotation(arrowId) },
  ])
}

// Randomize every seed widget on the live canvas state before the workflow
// snapshot is taken. Seed widgets are detected the same way ComfyUI's bundled
// frontend detects them — INT inputs whose schema config carries
// `control_after_generate`. This is what `getWidgetDefs` already encodes.
// Mutating `nodes.value` (rather than the workflow JSON) means the user
// visibly sees the seed that's about to run, so they can pin one if they
// want by typing into the widget (the next Run randomizes again — locking
// is a follow-up).
// The set of node ids actually executing in the current run. Set by the
// getWorkflow / getFilteredWorkflow exposes right before submission, cleared
// on execution_complete. The executing-event handler uses this to decide
// which outgoing edges to illuminate — a generator fanned out to two sinks
// where only one is targeted should only light that path.
const activeRunNodeIds = ref<Set<string>>(new Set())

// Nodes frozen for the in-flight run (auto-freeze + user locks). A frozen
// artifact executes as a passthrough LOADER — it feeds its held file — so its
// `executed` re-emission is NOT a new generation. Captured at submission
// (getWorkflow / getFilteredWorkflow) and consulted by the take-capture sites:
// appending such an emission as a take would activate it (appendTake activates
// what it appends) and clobber the user's filmstrip pick with the fixed-name
// temp preview (`live_preview_img_<id>.png`) — whose CONTENT is overwritten by
// every later run. That was the "re-rolling Blend Scene reset all my artifacts
// to the last generation" bug: pick → clobbered pointer → next freeze feeds
// the overwritten file.
const frozenRunNodeIds = ref<Set<string>>(new Set())

function userLockedNodeIds(): string[] {
  return (nodes.value as any[])
    .filter((n: any) => n?.data?.properties?.locked)
    .map((n: any) => String(n.id))
}

function captureActiveRunFromTargets(targetIds: string[]) {
  if (!targetIds.length) {
    // Global Run — every non-muted node is part of the active run.
    activeRunNodeIds.value = new Set(
      (nodes.value as any[])
        .filter((n: any) => (n.data?.mode ?? 0) !== 2)
        .map((n: any) => String(n.id)),
    )
    return
  }
  // Filtered Run — keep set is target ids + their transitive upstream deps.
  const wf = getWorkflowWithSubgraphs()
  if (!wf) { activeRunNodeIds.value = new Set(); return }
  const ids = targetIds.map(Number).filter(Number.isFinite)
  const keep = collectKeepSet(wf, ids)
  activeRunNodeIds.value = new Set([...keep].map(String))
}

function randomizeSeedsOnLiveState(onlyNodeIds?: Set<string>) {
  for (const node of nodes.value as any[]) {
    // Scoped re-roll: when a node-only run is requested, randomize seeds on the
    // target node(s) alone so every other node's inputs stay identical → ComfyUI
    // cache-hits all upstream (no regen, no re-billing) and only this node reruns.
    if (onlyNodeIds && !onlyNodeIds.has(node.id)) continue
    const defs = node.data?.widgetDefs as any[] | undefined
    const values = node.data?.widgetsValues as any[] | undefined
    if (!defs || !values) continue
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]
      if (!def || def.type !== 'INT') continue
      // Detect seed widgets uniformly: Comfy-standard ones carry the
      // control_after_generate flag; Replicate / custom-node seeds just have
      // "seed" in the name. We treat both as seed widgets.
      const isComfyStandard = !!def.control_after_generate
      const isSeed = isComfyStandard || /seed/i.test(String(def.name || ''))
      if (!isSeed) continue
      // Lock state lives in different slots depending on convention.
      const fixed = isComfyStandard
        ? values[i + 1] === 'fixed'
        : !!node.data?.properties?.seedLocks?.[def.name]
      if (fixed) continue
      const max = Math.min(Number(def.max) || 2 ** 53 - 1, 2 ** 53 - 1)
      values[i] = Math.floor(Math.random() * max)
    }
  }
}

// Build a filtered workflow snapshot from current canvas + target ids. Used
// by the layout when it receives the runFiltered event.
/** Walk upstream from the run targets and collect artifact (Image) nodes that
 *  already hold a result — these get frozen so a targeted run reuses them instead
 *  of re-executing the generators that produced them. Returns numeric node ids. */
function upstreamArtifactsWithResults(targetIds: string[]): Set<number> {
  const targets = new Set(targetIds.map(String))
  const up = new Set<string>()
  const stack = [...targets]
  while (stack.length) {
    const id = stack.pop()!
    for (const e of edges.value as any[]) {
      if (String(e.target) === id) {
        const s = String(e.source)
        if (!up.has(s)) { up.add(s); stack.push(s) }
      }
    }
  }
  const byId = new Map((nodes.value as any[]).map(n => [String(n.id), n]))
  const out = new Set<number>()
  for (const id of up) {
    if (targets.has(id)) continue
    const n = byId.get(id)
    // Artifact loaders backfill can re-feed: Image/Video (result in data.images[0])
    // and Audio (data.audios[0]) whose result is a loadable view URL (filename=…).
    const nt = n?.data?.nodeType
    const ref = (nt === 'Audio') ? n?.data?.audios?.[0] : n?.data?.images?.[0]
    if ((nt === 'Image' || nt === 'Video' || nt === 'Audio') && typeof ref === 'string' && ref.includes('filename=')) {
      const num = Number(id)
      if (Number.isFinite(num)) out.add(num)
    }
  }
  return out
}

function getFilteredWorkflow(
  targetIds: string[],
  opts: { rerollScope?: 'self' | 'variation'; direction?: 'downstream'; live?: boolean } = {},
) {
  // Seed policy:
  //  • live (auto-run from a live-preview node) = randomize NOTHING. Live runs
  //    fire on every widget/connection tweak; re-rolling would mutate upstream
  //    generators' live seeds — regenerating (and re-billing) images the user
  //    never asked to change, and re-tripping the live-run widget watch (loop).
  //    Same guarantee the full-graph live path gets via getWorkflow({reroll:false}).
  //  • 'downstream' (run here → end) = randomize NOTHING. The point is to push
  //    this node's CURRENT result through the rest of the graph, so neither it
  //    nor anything else should regenerate.
  //  • 'self' (re-roll this node) = randomize only the target's seed; upstream
  //    stays cached.
  //  • 'variation' (Variations ×N) = randomize the target AND its upstream
  //    producers' seeds, stopping at artifacts that hold a result (those get
  //    auto-frozen below) — the producing generator re-runs with a fresh seed.
  //  • default (rebuild from start → here) = randomize every seed in the graph.
  const seedScope = (opts.live || opts.direction === 'downstream')
    ? new Set<string>()
    : opts.rerollScope === 'self'
      ? new Set(targetIds)
      : opts.rerollScope === 'variation'
        ? upstreamSeedScope(targetIds, nodes.value as any[], edges.value as any[])
        : undefined
  randomizeSeedsOnLiveState(seedScope)
  captureActiveRunFromTargets(targetIds)
  const wf = getWorkflowWithSubgraphs()
  if (!wf) return wf
  // Realign widget values against the current schema FIRST — workflows
  // saved against an older schema may have shifted positional slots,
  // which would land e.g. camera_fixed's `false` in resolution's combo
  // slot and break validation. Everything downstream assumes aligned data.
  const aligned = realignWidgetValues(wf, objectInfo.value)
  // "Run this node / run here→end" should reuse upstream results as-is, not
  // re-execute (and re-bill) the chain that made them. Auto-freeze UPSTREAM
  // artifact nodes that already hold a result so they feed it like a locked node —
  // no manual lock needed. Skipped for a full "rebuild from start" (default scope).
  // Live runs freeze too: an auto-run from a layout tweak must never re-execute
  // the paid chain that made its inputs — even against a cold post-restart cache.
  const autoFreeze = (targetIds.length && (opts.live || opts.rerollScope === 'self' || opts.rerollScope === 'variation' || opts.direction === 'downstream'))
    ? upstreamArtifactsWithResults(targetIds)
    : undefined
  // Record the run's full frozen set (auto-freeze + user locks) so the take
  // machinery can ignore these nodes' loader re-emissions — see frozenRunNodeIds.
  frozenRunNodeIds.value = new Set([
    ...(autoFreeze ? [...autoFreeze].map(String) : []),
    ...userLockedNodeIds(),
  ])
  // Then locks drop upstream links so collectKeepSet walks a graph where
  // locked artifacts look like leaves.
  const unlocked = applyArtifactLocks(aligned, nodes.value as any[], autoFreeze)
  const filtered = targetIds.length
    ? buildFilteredWorkflow(unlocked, targetIds, opts.direction === 'downstream' ? 'downstream' : 'upstream')
    : unlocked
  // A standalone artifact card that's *showing* a result (but has nothing wired
  // in) feeds the shown image instead of a black placeholder.
  const backfilled = backfillStandaloneArtifactImages(filtered, nodes.value as any[], objectInfo.value)
  const withFanOut = applyVariantFanOut(backfilled, objectInfo.value)
  forceExportOnCapturedArtifacts(withFanOut)
  return withFanOut
}

// An image/audio/video artifact that's capturing a wired upstream result is,
// by definition, displaying a generation the user wants to keep — so force its
// `export` on at submission. This writes a permanent file to output/ (which the
// Assets page surfaces via its disk listing) instead of only an ephemeral temp
// preview. Stale persisted sinks (saved with export=false) are corrected here
// too. A bare artifact loading from disk (no upstream link) keeps the user's
// own export choice untouched.
const EXPORTABLE_ARTIFACT_TYPES = new Set(['Image', 'Audio', 'Video'])
function forceExportOnCapturedArtifacts(wf: any) {
  if (!wf?.nodes) return
  for (const node of wf.nodes) {
    if (!EXPORTABLE_ARTIFACT_TYPES.has(node.type)) continue
    const hasUpstream = (node.inputs || []).some((i: any) => i?.link != null)
    if (!hasUpstream) continue
    const defs = getWidgetDefs(node.type)
    const ei = defs.findIndex((w: any) => w.name === 'export')
    if (ei < 0) continue
    if (!Array.isArray(node.widgets_values)) {
      node.widgets_values = defs.map((w: any) => w.default ?? null)
    }
    node.widgets_values[ei] = true
  }
}

// One-time-per-session schema refresh, then heal any drifted Compositor nodes.
// The frontend fetches /object_info once at mount; if that happened before the
// backend finished registering the Compositor's Phase-B inputs (per-layer z +
// mask), the cached schema is stale — z-injection silently no-ops (setNamedWidget
// can't find layerN_z, so the unified stack order never reaches the backend) and
// realign aligns arrays to the wrong width. Force one fresh fetch before the
// first run, then realign every live Compositor against the real schema.
let schemaForcedOnce = false
async function refreshSchema(force = false) {
  // `force` bypasses the once-per-session gate: used by stale-schema
  // self-healing (injectTimelineEditState) when a widget that must exist is
  // missing from the cached objectInfo — e.g. ComfyUI restarted with new node
  // definitions after this page session already did its one forced fetch.
  if (force || !schemaForcedOnce) {
    schemaForcedOnce = true
    await fetchObjectInfo(true)
  }
  healCompositorNodes()
}

// Realign each live Compositor's widgetDefs + widgets_values to the current
// schema, in place, so the editor, overlay injection, and submit all read the
// same aligned data. Reuses realignWidgetValues, which pads length drift and
// resets a provably-scrambled array (a number in a blend combo) to defaults.
function healCompositorNodes() {
  const freshDefs = getWidgetDefs('Compositor')
  if (!freshDefs.length) return
  for (const n of nodes.value as any[]) {
    if (n.data?.nodeType !== 'Compositor') continue
    const cur = Array.isArray(n.data.widgetsValues) ? [...n.data.widgetsValues] : []
    const mini = { nodes: [{ id: 1, type: 'Compositor', widgets_values: cur }], links: [] }
    const out = realignWidgetValues(mini as any, objectInfo.value)
    n.data = { ...n.data, widgetDefs: freshDefs, widgetsValues: out.nodes[0].widgets_values }
  }
}

// When the user runs a node that has dangling outputs of an artifact-bearing
// type (IMAGE / AUDIO / VIDEO / STRING), drop a fresh artifact card to its
// right and wire the output to it. The card receives the execution result and
// renders the preview — no need to know that PreviewImage/PreviewAudio/etc.
// exist. Returns the original target list plus the new sink ids so the run
// includes them.
function materializeAutoImageSinks(targetIds: string[]): string[] {
  if (!targetIds.length) return targetIds

  // Build a schema snapshot for each artifact node type we know about, lazily.
  // Skips types whose Comfy node hasn't been reported yet (e.g. a fresh Comfy
  // install that doesn't have the new Audio node loaded).
  const schemas: Record<string, {
    inputs: any[]; outputs: any[]; widgetDefs: any[]; info: any; primaryInputIdx: number;
  }> = {}
  function getSchema(nodeType: string) {
    if (schemas[nodeType]) return schemas[nodeType]
    const info = objectInfo.value[nodeType]
    if (!info) return null
    const widgetDefs = getWidgetDefs(nodeType)
    const inputs = [
      ...Object.entries((info?.input?.required ?? {}) as Record<string, any>).map(([n, s]) => ({ n, s, optional: false })),
      ...Object.entries((info?.input?.optional ?? {}) as Record<string, any>).map(([n, s]) => ({ n, s, optional: true })),
    ]
      .filter(({ s }) => {
        // Same port/widget split as the regular add-node path.
        const specArr = Array.isArray(s) ? s : [s]
        const type = specArr[0]
        const cfg = specArr[1] || {}
        if (Array.isArray(type)) return false
        if (cfg.forceInput) return true
        return !['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(String(type))
      })
      .map(({ n, s, optional }) => ({
        name: n,
        type: Array.isArray(s) ? String(s[0]) : String(s),
        link: null,
        optional,
      }))
    const outputs = (info?.output || []).map((type: string, i: number) => ({
      name: info?.output_name?.[i] || type,
      type,
      links: null,
    }))
    // The "primary" input is the optional pass-through port matching the
    // artifact's medium — that's where the auto-wired upstream connects.
    // Currently every artifact node has exactly one non-widget input; pick
    // the first port and we're good.
    const primaryInputIdx = inputs.length > 0 ? 0 : -1
    if (primaryInputIdx < 0) return null
    schemas[nodeType] = { inputs, outputs, widgetDefs, info, primaryInputIdx }
    return schemas[nodeType]
  }

  const additional: string[] = []
  // Snapshot the current nodes so we don't iterate over ones we just added.
  const snapshot = [...(nodes.value as any[])]
  // Numeric IDs only — the workflow-to-Comfy conversion parseInts the string
  // id, so anything past a non-digit gets dropped and the executed-event echo
  // back from Comfy won't match the Vue Flow node. Each new sink offsets from
  // Date.now() to stay unique within this call.
  let idSeed = Date.now()
  // Skip nodes that are already artifact cards — they ARE the artifact.
  const artifactNodeTypes = new Set(Object.keys(ARTIFACT_NODE_COMPONENTS))

  for (const id of targetIds) {
    const src = snapshot.find((n: any) => n.id === id)
    if (!src) continue
    if (artifactNodeTypes.has(src.data?.nodeType)) continue
    // `sketch` (Task 8: retired user-facing node) never auto-sinks — kept only
    // so a legacy saved doc's old sketch node doesn't grow a stray sink on load.
    if (src.data?.properties?.sketch) continue
    // The prompt-bar sketch pad (`sketchPad`) and the speculative-warm throwaway
    // (`sketchWarm`) ARE generators and DO need a terminal output node, or
    // ComfyUI rejects the run ("Prompt has no outputs"). So they get an auto-sink
    // like any generator — but a HIDDEN one (marked `sketchSink`) so no visible
    // card lands. The pad's own executed event still carries the batch that
    // lands in the review strip (see the executed-handler diversion above);
    // the sink just satisfies validation and saves the files.
    const hiddenSketchSource = !!(src.data?.properties?.sketchPad || src.data?.properties?.sketchWarm)

    const outputs = (src.data?.outputs ?? []) as Array<{ name: string; type: string }>
    const srcW = (src.data?.size?.[0] ?? 220) as number
    const srcPos = src.position || { x: 0, y: 0 }

    let stacked = 0
    for (let i = 0; i < outputs.length; i++) {
      const outType = String(outputs[i].type).toUpperCase()
      const artifactNodeType = ARTIFACT_NODE_FOR_OUTPUT[outType]
      if (!artifactNodeType) continue
      // Layerize's (and Seedream's) layers_json is machine data for "Edit as
      // Frame" (the node carries it in its own result payload) — don't
      // materialize a Text sink that would dump raw JSON on the canvas.
      if ((src.data?.nodeType === 'LayerizeGraphicNode' || src.data?.nodeType === 'SeedreamLayerizeNode')
        && outputs[i].name === 'layers_json') continue
      const schema = getSchema(artifactNodeType)
      if (!schema) continue
      // Skip if anything is already wired from this exact output handle.
      const handle = `output-${i}`
      const alreadyWired = (edges.value as any[]).some((e) => e.source === id && e.sourceHandle === handle)
      if (alreadyWired) continue

      const newId = mintNodeId(idSeed++)
      // Slot multi-output cases vertically so they don't overlap.
      const position = { x: srcPos.x + srcW + 80, y: srcPos.y + stacked * 320 }
      stacked++

      nodes.value.push({
        id: newId,
        type: getVueFlowType(artifactNodeType),
        position,
        // A sketch pad/warm generator's sink stays hidden (self-managed, exempt
        // from the group-collapse watcher) so no visible card appears.
        ...(hiddenSketchSource ? { hidden: true } : {}),
        data: {
          nodeType: artifactNodeType,
          title: schema.info?.display_name || artifactNodeType,
          inputs: schema.inputs.map((p) => ({ ...p })),
          outputs: schema.outputs.map((p: any) => ({ ...p })),
          // Default widgets, but force `export` on: an auto-created sink should
          // SAVE the generated result to output/ so it appears in Assets and
          // survives as a real file (not just an ephemeral temp preview).
          widgetsValues: (() => {
            const wv = schema.widgetDefs.map((w: any) => w.default ?? null)
            const ei = schema.widgetDefs.findIndex((w: any) => w.name === 'export')
            if (ei >= 0) wv[ei] = true
            return wv
          })(),
          widgetDefs: schema.widgetDefs,
          properties: hiddenSketchSource ? { sketchSink: true } : {},
          mode: 0,
          size: [240, 280],
          category: schema.info?.category || '',
          outputNode: !!schema.info?.output_node,
          priceBadge: schema.info?.price_badge || null,
        },
      } as any)

      // Push the edge synchronously so the workflow-conversion in the very
      // next tick sees the link. Vue Flow renders the SVG path on its own
      // schedule — what matters here is that `edges.value` reflects the
      // wire when `getFilteredWorkflow` reads it.
      edges.value.push({
        id: `e-auto-${newId}`,
        source: id,
        sourceHandle: handle,
        target: newId,
        targetHandle: `input-${schema.primaryInputIdx}`,
        type: 'comfy',
        data: { dataType: outType },
      } as any)

      additional.push(newId)
    }
  }

  // Also expand targets to include EXISTING wired artifact sinks downstream
  // of each target. Without this, clicking Run on a generator that's already
  // wired to a sink runs the generator but never invites its sink into the
  // keep set — so the sink's preview never fires. With this, the gesture
  // means "run this AND show me the result", which is what users expect.
  const downstream: string[] = []
  for (const id of [...targetIds, ...additional]) {
    for (const e of edges.value as any[]) {
      if (String(e.source) !== id) continue
      const targetNode = (nodes.value as any[]).find((n: any) => n.id === e.target)
      if (!targetNode) continue
      if (!artifactNodeTypes.has(targetNode.data?.nodeType)) continue
      if (downstream.includes(targetNode.id)) continue
      if (targetIds.includes(targetNode.id)) continue
      downstream.push(targetNode.id)
    }
  }

  const expanded = [...targetIds, ...additional, ...downstream]
  return expanded.length === targetIds.length ? targetIds : expanded
}

/**
 * Shared scaffolding for start-graph seeding (Get Started modal / homepage
 * starter cards): build the node-data blob a Vue-flow node needs from
 * object_info, push a node, and wire a source into a generator on the first
 * matching port-type pair.
 */
function buildStartNodeData(nodeType: string) {
  const info = objectInfo.value[nodeType]
  if (!info) return null
  const widgetDefs = getWidgetDefs(nodeType)
  const inputs = [
    ...Object.entries((info?.input?.required ?? {}) as Record<string, any>).map(([n, s]) => ({ n, s, optional: false })),
    ...Object.entries((info?.input?.optional ?? {}) as Record<string, any>).map(([n, s]) => ({ n, s, optional: true })),
  ]
    .filter(({ s }) => {
      const specArr = Array.isArray(s) ? s : [s]
      const type = specArr[0]
      const cfg = specArr[1] || {}
      if (Array.isArray(type)) return false
      if (cfg.forceInput) return true
      return !['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(String(type))
    })
    .map(({ n, s, optional }) => ({
      name: n,
      type: Array.isArray(s) ? String(s[0]) : String(s),
      link: null,
      optional,
    }))
  const outputs = (info?.output || []).map((type: string, i: number) => ({
    name: info?.output_name?.[i] || type,
    type,
    links: null,
  }))
  return {
    info, widgetDefs, inputs, outputs,
  }
}

type StartNodeData = NonNullable<ReturnType<typeof buildStartNodeData>>

function pushStartNode(opts: {
  id: string
  nodeType: string
  data: StartNodeData
  x: number
  y: number
  size: [number, number]
  /** Prefill the widget named "prompt" so the card runs (or reads) well on first sight. */
  prompt?: string
}) {
  nodes.value.push({
    id: opts.id,
    type: getVueFlowType(opts.nodeType),
    position: { x: opts.x, y: opts.y },
    data: {
      nodeType: opts.nodeType,
      title: opts.data.info?.display_name || opts.nodeType,
      inputs: opts.data.inputs,
      outputs: opts.data.outputs,
      widgetsValues: opts.data.widgetDefs.map((w: any) =>
        (opts.prompt && w.name === 'prompt') ? opts.prompt : (w.default ?? null)),
      widgetDefs: opts.data.widgetDefs,
      properties: {},
      mode: 0,
      size: opts.size,
      category: opts.data.info?.category || '',
      outputNode: !!opts.data.info?.output_node,
      priceBadge: opts.data.info?.price_badge || null,
    },
  } as any)
}

/** Wire source → generator on the first matching type pair (e.g. source IMAGE
 * output to generator's first IMAGE input). No-op when no pair matches. */
function wireStartPair(sourceId: string, sourceData: StartNodeData, generatorId: string, generatorData: StartNodeData) {
  const srcPrimary = sourceData.outputs.findIndex(
    (o: any) => /^(IMAGE|AUDIO|VIDEO|STRING)$/i.test(String(o.type)),
  )
  if (srcPrimary < 0) return
  const srcType = String(sourceData.outputs[srcPrimary].type).toUpperCase()
  const genInputIdx = generatorData.inputs.findIndex(
    (i: any) => String(i.type).toUpperCase() === srcType,
  )
  if (genInputIdx < 0) return
  edges.value.push({
    id: `e-start-${generatorId}`,
    source: sourceId,
    sourceHandle: `output-${srcPrimary}`,
    target: generatorId,
    targetHandle: `input-${genInputIdx}`,
    type: 'comfy',
    data: { dataType: srcType },
  } as any)
}

/**
 * Drop a "start graph" onto an empty canvas — used by the Get Started modal
 * after the user picks a (from, to, model) combo. When `sourceNodeType` is
 * given, a matching artifact card lands to the left of the generator and is
 * wired into it via the first input port whose type matches the source's
 * primary output. Otherwise just the generator is placed (prompt-only path).
 *
 * The plain "Generate an image" pick is special-cased into a showcase tour
 * (several ready-to-run ways to make an image, explained by sticky notes) —
 * see materializeImageShowcase below.
 *
 * Positions are absolute canvas coords — fitView at the end frames whatever
 * we just dropped, so the user doesn't have to zoom around.
 */
function materializeStartGraph(opts: { sourceNodeType?: string; generatorNodeType: string }) {
  const genInfo = objectInfo.value[opts.generatorNodeType]
  if (!genInfo) return false

  if (opts.generatorNodeType === 'GenerateImageNode' && !opts.sourceNodeType) {
    return materializeImageShowcase()
  }

  let idSeed = Date.now()
  const sourceId = opts.sourceNodeType ? String(idSeed++) : null
  const generatorId = String(idSeed++)

  const sourceData = opts.sourceNodeType ? buildStartNodeData(opts.sourceNodeType) : null
  const generatorData = buildStartNodeData(opts.generatorNodeType)
  if (!generatorData) return false

  // Pick canvas-coord positions. Left source, right generator. If no source,
  // generator sits roughly centered.
  if (sourceId && sourceData) {
    pushStartNode({ id: sourceId, nodeType: opts.sourceNodeType!, data: sourceData, x: 80, y: 80, size: [240, 280] })
  }
  pushStartNode({
    id: generatorId,
    nodeType: opts.generatorNodeType,
    data: generatorData,
    x: sourceId ? 420 : 200,
    y: 80,
    size: [220, 120],
  })

  if (sourceId && sourceData) {
    wireStartPair(sourceId, sourceData, generatorId, generatorData)
  }

  // Frame what we just dropped.
  nextTick(() => fitView({ padding: 0.3 }))

  return true
}

/**
 * The "Generate an image" welcome tour: instead of one bare generator, seed a
 * 2×2 grid of ready-to-run ways to make an image, each captioned by a small
 * sticky note (plus one intro sticky up top). Deliberately quiet: one paper
 * colour, zero rotation, caption-length copy, labels left-aligned above their
 * cards on an even grid — the seeded canvas should read as a curated welcome,
 * not a brainstorm wall (the first, louder version did). Ways whose node type
 * is missing from object_info are skipped rather than failing the whole seed;
 * the image-fed ways get an Image card pre-wired in so the canvas also
 * demonstrates wiring. Stickies persist like any user annotation
 * (workflow.extra), so the tour survives save/load and the user deletes
 * pieces as they claim the canvas.
 */
function materializeImageShowcase(): boolean {
  interface ShowcaseWay {
    nodeType: string
    note: string
    prompt?: string
    /** Pre-wire an Image artifact card into the generator's IMAGE input. */
    withImageSource?: boolean
  }
  const ways: ShowcaseWay[] = [
    {
      nodeType: 'GenerateImageNode',
      note: 'Describe it\nType a prompt and press Run.',
      prompt: 'A lighthouse on a rocky coast at golden hour, gouache painting',
    },
    {
      nodeType: 'FluxLoRARemoteNode',
      note: 'Give it a style\nEvery image comes out in one look.',
    },
    {
      nodeType: 'SketchToImageNode',
      note: 'Start from a sketch\nDrop a rough drawing into the card.',
      prompt: 'Turn this sketch into a soft watercolor illustration',
      withImageSource: true,
    },
    {
      nodeType: 'GenerateFromReferencesNode',
      note: 'Start from references\nDrop in photos to blend and remix.',
      prompt: 'Combine these references into one scene',
      withImageSource: true,
    },
  ].filter(w => !!objectInfo.value[w.nodeType])
  if (!ways.length) return false

  // One colour, no tilt — the shared soft-white sticky paper.
  const PAPER = STICKY_PAPER
  const COL_PITCH = 680
  const ROW_PITCH = 560
  const LABEL_H = 84

  const intro = createSticky({
    x: 0,
    y: 0,
    color: PAPER,
    text: 'Four ways to make an image\nEvery card is ready to run — pick one, delete the rest.',
  })
  intro.width = 400
  intro.height = LABEL_H
  intro.rotation = 0

  let idSeed = Date.now()
  const imageSourceData = buildStartNodeData('Image')
  const placedIds: string[] = []
  const stickyRects: { x: number; y: number; width: number; height: number }[] = [intro]

  ways.forEach((way, i) => {
    const qx = (i % 2) * COL_PITCH
    const qy = 150 + Math.floor(i / 2) * ROW_PITCH

    const sticky = createSticky({ x: qx, y: qy, text: way.note, color: PAPER })
    sticky.width = 260
    sticky.height = LABEL_H
    sticky.rotation = 0
    stickyRects.push(sticky)

    const generatorData = buildStartNodeData(way.nodeType)
    if (!generatorData) return

    const contentY = qy + LABEL_H + 28
    let generatorX = qx
    let sourceId: string | null = null
    if (way.withImageSource && imageSourceData) {
      sourceId = String(idSeed++)
      pushStartNode({ id: sourceId, nodeType: 'Image', data: imageSourceData, x: qx, y: contentY, size: [240, 280] })
      placedIds.push(sourceId)
      generatorX = qx + 320
    }

    const generatorId = String(idSeed++)
    pushStartNode({
      id: generatorId,
      nodeType: way.nodeType,
      data: generatorData,
      x: generatorX,
      y: contentY,
      size: [220, 120],
      prompt: way.prompt,
    })
    placedIds.push(generatorId)

    if (sourceId && imageSourceData) {
      wireStartPair(sourceId, imageSourceData, generatorId, generatorData)
    }
  })

  // Frame the whole tour — stickies included, which plain fitView would crop
  // (it only measures vue-flow nodes). Vue Flow measures new nodes via
  // ResizeObserver AFTER they render — bounds computed from stated sizes
  // frame a fraction of the real cards, so wait (bounded) until every card
  // carries real dimensions, then fit the union of cards and stickies.
  ;(async () => {
    await nextTick()
    let picked: any[] = []
    for (let i = 0; i < 20; i++) {
      picked = (nodes.value as any[]).filter((n: any) => placedIds.includes(String(n.id)))
      if (picked.length === placedIds.length && picked.every((n: any) => (n.dimensions?.width ?? 0) > 0)) break
      await new Promise<void>(r => requestAnimationFrame(() => r()))
    }
    const rects = [
      ...stickyRects,
      ...picked.map((n: any) => ({
        x: n.position.x,
        y: n.position.y,
        width: n.dimensions?.width || 240,
        height: n.dimensions?.height || 280,
      })),
    ]
    const minX = Math.min(...rects.map(r => r.x))
    const minY = Math.min(...rects.map(r => r.y))
    const maxX = Math.max(...rects.map(r => r.x + r.width))
    // Extra bottom margin: the floating prompt bar + toolbar overlay the
    // viewport's lower edge, so a tight fit hides the bottom row behind them.
    const maxY = Math.max(...rects.map(r => r.y + r.height)) + 180
    fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { padding: 0.06 })
  })()

  return true
}

// Expose methods and state for parent layout
defineExpose({
  materializeStartGraph,
  // Orphan-glow reaper: clears every run visual (node shimmer, edge glow,
  // progress) and the per-prompt bookkeeping. Called by the layout when the
  // run registry drains to zero — glow state orphaned by an HMR mid-run or a
  // stalled/never-acked run would otherwise animate forever, since per-run
  // completion handling (correctly) no-ops on unknown prompt_ids.
  clearAllRunVisuals: () => {
    for (const n of nodes.value as any[]) {
      if (n.data?.running || n.data?.progress) n.data = { ...n.data, running: false, progress: undefined }
    }
    for (const e of edges.value as any[]) {
      if (e.data?.running) e.data = { ...e.data, running: false }
    }
    runningNodeByPrompt.clear()
    // Also drop the run→canvas routing cache; a watchdog-stalled run that never
    // reaches its execution_success/error handler would otherwise leak one entry.
    canvasByPrompt.clear()
    activeRunNodeIds.value = new Set()
  },
  // Global Run path. Match the per-node Run pre-processing: realign widget
  // values, randomize seeds on the live canvas state, capture the active run
  // set, apply locks, then variant fan-out on the JSON snapshot.
  getWorkflow: (opts?: { reroll?: boolean }) => {
    // Live-preview runs pass reroll:false — re-rolling a seed mutates the live
    // widget state, which re-trips the live-run watch and loops forever (any
    // live-preview node with a seed, e.g. Caustics). A normal Run re-rolls.
    // reroll:false also marks a PERSISTENCE snapshot (autosave/tab switch) —
    // those must not touch the run-tracking sets below: a snapshot firing
    // mid-run would blow activeRunNodeIds out to "everything" (breaking edge
    // glow filtering and the FX leaf gate) and reset frozenRunNodeIds
    // (re-enabling the frozen-loader take clobber for the in-flight run).
    if (opts?.reroll !== false) {
      randomizeSeedsOnLiveState()
      captureActiveRunFromTargets([])
      // Full-graph run: only user-locked artifacts execute as loader leaves.
      frozenRunNodeIds.value = new Set(userLockedNodeIds())
    }
    const wf = getWorkflowWithSubgraphs()
    if (!wf) return wf
    // A hidden sketch pad must never run on a whole-canvas Run (only via its own
    // scoped startSketch dispatch) and must stay out of persisted docs — it is
    // disposable plumbing. The scoped runFiltered([sketchPad.padNodeId]) path
    // uses getFilteredWorkflow, so this full-graph-only filter never strips a
    // targeted pad run. (Unwired, so removing it orphans no links.) The speculative-warm
    // node (`sketchWarm`, Task 7) is the same kind of disposable plumbing —
    // strip it too so it never persists into a saved doc or rides a full Run.
    // Their hidden auto-created sinks (`sketchSink`) are the same disposable
    // plumbing — strip them too (and their now-orphaned wiring edge is dropped
    // by the link reassembly, which skips edges whose endpoints are absent).
    if (Array.isArray((wf as any).nodes)) {
      ;(wf as any).nodes = ((wf as any).nodes as any[]).filter((n: any) => !n?.properties?.sketchPad && !n?.properties?.sketchWarm && !n?.properties?.sketchSink)
    }
    // VARS links (Collection → Smart Layout) are intentionally kept here —
    // getWorkflow output must be persistence-safe (snapshotActiveCanvasIntoDoc
    // saves it verbatim for autosave/durable docs). Stripping happens ONLY at
    // the execution boundary, in runVueWorkflow, right before queuing.
    const aligned = realignWidgetValues(wf, objectInfo.value)
    const unlocked = applyArtifactLocks(aligned, nodes.value as any[])
    const backfilled = backfillStandaloneArtifactImages(unlocked, nodes.value as any[], objectInfo.value)
    const withFanOut = applyVariantFanOut(backfilled, objectInfo.value)
    // Force `export` on for wired artifact sinks — same as getFilteredWorkflow.
    // Without this, a global Run saves captured results to temp only, so they
    // never write to output/ and never register in the Assets panel / durable
    // generation records (which keep type:'output' files only).
    forceExportOnCapturedArtifacts(withFanOut)
    return withFanOut
  },
  getFilteredWorkflow,
  refreshSchema,
  injectCompositorOverlays,
  injectProtectMaskWiring,
  injectTimelineEditState,
  injectCompositorMotionParams,
  injectCompositorCloners,
  injectSmartLayoutBrand,
  injectSmartLayoutCollectionVars,
  injectAssetRegistry,
  materializeAutoImageSinks,
  bakeUpstreamStudios,
  getNodes: () => nodes.value,
  selectedNode,
  selectNode,
  getEdges: () => edges.value,
  getObjectInfo: () => objectInfo.value,
  agentSnapshot,
  agentPreview,
  agentCommit,
  agentFrameNodes,
  agentDiscard,
  agentHighlight,
  agentTune,
  agentTuneRevert,
  agentRunOutputImage,
  agentResolveResultNode,
  agentNodeIntent,
  isApplyingWorkflow: () => applyingWorkflow.value,
  startSketch,
  warmSketch,
  zoomIn: () => vfZoomIn(),
  zoomOut: () => vfZoomOut(),
  fitView: () => fitView({ padding: 0.2 }),
})
</script>

<template>
  <!-- tabindex="-1" makes the canvas root programmatically focusable. After
       a Run, the layout calls `.focus()` here to pull focus out of the
       hidden bridge iframe (which, on macOS, can otherwise capture pinch-
       zoom gestures for itself). focus:outline-none keeps the focus ring
       invisible; we only need the focus state for event routing, not UI. -->
  <div
    ref="canvasRootRef"
    class="vue-node-canvas-root w-full h-full relative bg-[#0a0a0a] focus:outline-none"
    tabindex="-1"
    @dragover.prevent
    @contextmenu.prevent
  >
    <!-- Dot grid behind everything -->
    <VueCanvasAnimatedDotGrid :running="isRunning" :thinking="agentThinking" />

    <!-- Blueprint preview: a white hairline rotating contour over each proposed
         node. TransitionGroup fades each ring in/out. -->
    <TransitionGroup name="bp-fade">
      <div
        v-for="(b, i) in blueprintRects" :key="'bp' + i"
        class="agent-blueprint-ring absolute pointer-events-none z-30"
        :style="{ left: b.left + 'px', top: b.top + 'px', width: b.w + 'px', height: b.h + 'px', borderRadius: b.radius }"
      />
    </TransitionGroup>

    <!-- Hover-highlight: ring the node(s) a hovered proposal row points at. -->
    <TransitionGroup name="bp-fade">
      <div
        v-for="(b, i) in hoverRects" :key="'hi' + i"
        class="agent-hover-ring absolute pointer-events-none z-30"
        :style="{ left: (b.left - 3) + 'px', top: (b.top - 3) + 'px', width: (b.w + 6) + 'px', height: (b.h + 6) + 'px', borderRadius: `calc(${b.radius} + 3px)` }"
      />
    </TransitionGroup>

    <!-- Glimm "citrus" sweep over a just-committed agent node + its connection.
         Persistently mounted; glimmOn fades it via opacity + AgentSweep's eased
         alpha (a v-if + constant active would run AgentSweep's immediate watch
         before the canvas mounts). -->
    <div
      class="absolute pointer-events-none z-30"
      :style="glimmBurst
        ? { left: glimmBurst.left + 'px', top: glimmBurst.top + 'px', width: glimmBurst.w + 'px', height: glimmBurst.h + 'px', clipPath: `inset(0 round ${glimmBurst.radius})`, opacity: glimmOn ? 1 : 0, transition: 'opacity 0.4s ease' }
        : { display: 'none' }"
    >
      <AgentSweep :active="glimmOn" :period="glimmPeriod" />
    </div>

    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :node-types="nodeTypes"
      :edge-types="edgeTypes"
      :default-edge-options="defaultEdgeOptions"
      :pan-on-drag="panOnDrag"
      :selection-key-code="selectionKeyCode"
      :multi-selection-key-code="multiSelectionKeyCode"
      pan-on-scroll
      :zoom-on-pinch="true"
      :zoom-on-scroll="true"
      :prevent-scrolling="true"
      :snap-to-grid="true"
      :snap-grid="snapGrid"
      :min-zoom="0.1"
      :max-zoom="4"
      :connection-line-style="connectionLineStyle"
      :delete-key-code="vfDeleteKeyCode"
      class="vue-node-canvas"
      fit-view-on-init
      @drop="handleDrop"
      @dragover="handleCanvasDragOver"
      @dragleave="dragOverEdgeId = null"
      @node-double-click="handleNodeDoubleClick"
      @pane-context-menu="handlePaneContextMenu"
      @node-context-menu="handleNodeContextMenu"
      @edge-context-menu="handleEdgeContextMenu"
      @selection-context-menu="handleSelectionContextMenu"
      @pane-click="handlePaneClick"
    >
      <MiniMap
        class="!bg-[#1a1a1a] !border-[#2a2a2a] comfy-minimap"
        :node-color="() => '#2a2a2a'"
        :mask-color="'rgba(0, 0, 0, 0.6)'"
      />
    </VueFlow>

    <!-- Group layer: lives outside VueFlow, in screen space, but applies a
         CSS transform that mirrors VueFlow's viewport so its children
         effectively render in graph space. Z-index sits between the dot
         grid (behind) and the VueFlow node layer (in front). -->
    <div
      class="canvas-groups-layer absolute inset-0 overflow-hidden pointer-events-none"
      style="z-index: 1"
    >
      <div
        class="absolute top-0 left-0"
        :style="{
          transform: `translate(${vfViewport.x}px, ${vfViewport.y}px) scale(${vfViewport.zoom})`,
          transformOrigin: '0 0',
        }"
      >
        <CanvasGroupView
          v-for="g in groups"
          :key="g.id"
          :group="g"
          :bypass-state="groupModeState(g.id, 4)"
          :mute-state="groupModeState(g.id, 2)"
          :member-count="groupMemberCounts[g.id]"
          class="pointer-events-auto"
          @drag="(id, dx, dy) => onDragGroup(id, dx, dy)"
          @resize="(id, w, h) => resizeGroup(id, w, h)"
          @title-edit="(id, t) => updateGroup(id, { title: t })"
          @context-menu="handleGroupContextMenu"
          @run="actionRunGroup"
          @toggle-bypass="(id) => actionToggleGroupMode(id, 4)"
          @toggle-mute="(id) => actionToggleGroupMode(id, 2)"
          @save-as-block="actionSaveGroupAsBlock"
          @toggle-collapse="(id) => toggleGroupCollapse(id)"
          @toggle-lock="(id) => toggleGroupLock(id)"
        />
      </div>
    </div>

    <!-- Annotations layer: stickies, checklists, pins, arrows. Sits ABOVE the
         groups layer (so a sticky pinned to a group reads as "on top of" it)
         but BELOW Vue Flow's node layer (so nodes always win for click priority
         on the executable graph). Same viewport-transform trick as groups. -->
    <div
      class="canvas-annotations-layer absolute inset-0 overflow-hidden pointer-events-none"
      style="z-index: 2"
    >
      <div
        class="absolute top-0 left-0"
        :style="{
          transform: `translate(${vfViewport.x}px, ${vfViewport.y}px) scale(${vfViewport.zoom})`,
          transformOrigin: '0 0',
        }"
      >
        <template v-for="a in visibleAnnotations" :key="a.id">
          <StickyAnnotation
            v-if="a.kind === 'sticky'"
            :annotation="(a as any)"
            :selected="a.id === selectedStickyId"
            @select="(id) => selectSticky(id)"
            @drag="(id, dx, dy) => moveAnnotationWithAttach(id, dx, dy)"
            @resize="(id, w, h) => resizeAnnotation(id, w, h)"
            @update="(id, patch) => updateAnnotation(id, patch as any)"
            @remove="(id) => removeAnnotation(id)"
          />
          <ChecklistAnnotationView
            v-else-if="a.kind === 'checklist'"
            :annotation="(a as any)"
            @drag="(id, dx, dy) => moveAnnotationWithAttach(id, dx, dy)"
            @resize="(id, w, h) => resizeAnnotation(id, w, h)"
            @update="(id, patch) => updateAnnotation(id, patch as any)"
            @remove="(id) => removeAnnotation(id)"
          />
          <PinImageAnnotationView
            v-else-if="a.kind === 'pin-image'"
            :annotation="(a as any)"
            @drag="(id, dx, dy) => moveAnnotationWithAttach(id, dx, dy)"
            @resize="(id, w, h) => resizeAnnotation(id, w, h)"
            @update="(id, patch) => updateAnnotation(id, patch as any)"
            @remove="(id) => removeAnnotation(id)"
          />
          <PinResultAnnotationView
            v-else-if="a.kind === 'pin-result'"
            :annotation="(a as any)"
            @drag="(id, dx, dy) => moveAnnotationWithAttach(id, dx, dy)"
            @resize="(id, w, h) => resizeAnnotation(id, w, h)"
            @update="(id, patch) => updateAnnotation(id, patch as any)"
            @remove="(id) => removeAnnotation(id)"
          />
        </template>

        <!-- Arrows: rendered into the same transformed layer so the dashed
             stroke scales naturally with zoom and endpoints stay anchored. -->
        <ArrowsLayer
          :arrows="allRenderedArrows"
          :selected-id="selectedArrowId"
          @context-menu="(id, x, y) => handleArrowContextMenu(id, x, y)"
          @select="(id) => selectArrow(id)"
          @endpoint-drag="(id, which, x, y) => onArrowEndpointDrag(id, which, x, y)"
          @curve-drag="(id, x, y) => onArrowCurveDrag(id, x, y)"
        />
      </div>
    </div>

    <!-- Pending-arrow status hint: appears while the user is drawing an arrow.
         Compact, top-center, dismissable with ESC (handled globally). -->
    <div
      v-if="pendingArrowFrom"
      class="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-full text-xs font-medium pointer-events-none"
      style="background: rgba(167, 139, 250, 0.95); color: rgb(20, 23, 28);"
    >
      Click target to complete arrow · ESC to cancel
    </div>

    <!-- Inline style toolbar for the selected arrow. Positioned at the curve
         midpoint in screen coords so it doesn't scale with zoom — readable
         at any zoom level. The pop floats above the arrow with a small caret. -->
    <div
      v-if="selectedArrowToolbarPos"
      class="arrow-style-toolbar absolute z-50 flex items-center gap-1 px-1.5 py-1 rounded-[10px] bg-[#1a1a1a]/95 border border-[#2a2a2a] shadow-xl"
      :style="{
        left: `${selectedArrowToolbarPos.left}px`,
        top: `${selectedArrowToolbarPos.top}px`,
        transform: 'translateX(-50%)',
      }"
      @pointerdown.stop
      @click.stop
    >
      <!-- Color swatches -->
      <button
        v-for="c in ARROW_PALETTE"
        :key="c"
        type="button"
        class="arrow-style-toolbar__swatch"
        :class="{ 'arrow-style-toolbar__swatch--active': selectedArrowToolbarPos.color.toLowerCase() === c.toLowerCase() }"
        :style="{ background: c }"
        :title="c"
        @click="setSelectedArrowColor(c)"
      />
      <div class="w-px h-5 bg-white/10 mx-0.5" />
      <!-- Thickness -->
      <button
        v-for="t in ARROW_THICKNESSES"
        :key="t"
        type="button"
        class="arrow-style-toolbar__thickness"
        :class="{ 'arrow-style-toolbar__thickness--active': Math.abs(selectedArrowToolbarPos.thickness - t) < 0.1 }"
        :title="`Thickness ${t}`"
        @click="setSelectedArrowThickness(t)"
      >
        <span :style="{ height: `${t}px`, background: selectedArrowToolbarPos.color }" />
      </button>
      <div class="w-px h-5 bg-white/10 mx-0.5" />
      <!-- Label + delete -->
      <button
        type="button"
        class="arrow-style-toolbar__btn"
        title="Edit label"
        @click="editSelectedArrowLabel"
      >
        <Edit3 class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        class="arrow-style-toolbar__btn arrow-style-toolbar__btn--danger"
        title="Delete arrow"
        @click="deleteSelectedArrow"
      >
        <Trash2 class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Context menu (floats in screen space, not graph space) -->
    <CanvasContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @close="closeMenu"
    />

    <!-- Subgraph breadcrumb navigation -->
    <div v-if="isInsideSubgraph" class="absolute top-3 left-3 z-40">
      <SubgraphBreadcrumb :breadcrumbs="breadcrumbs" @navigate="handleBreadcrumbNavigate" />
    </div>

    <!-- Compositor editor modal -->
    <Teleport to="body">
      <VueCanvasCompositorModal
        v-if="compositorOpenForId"
        :node-id="compositorOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="closeCompositorEditor"
      />
    </Teleport>

    <!-- Space Type editor modal (frontend-only config node) -->
    <Teleport to="body">
      <VueCanvasSpaceTypeSurface
        v-if="spaceTypeOpenForId"
        :node-id="spaceTypeOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="closeSpaceTypeEditor"
      />
    </Teleport>

    <!-- Space Type CLIP editor (edit-in-place; teleported over the open Timeline) -->
    <Teleport to="body">
      <VueCanvasSpaceTypeSurface
        v-if="spaceTypeClipEditId"
        :clip-id="spaceTypeClipEditId"
        :nodes="[]"
        @close="closeSpaceTypeClipEditor"
      />
    </Teleport>

    <!-- Gradient Studio editor modal (frontend-only config node) -->
    <Teleport to="body">
      <VueCanvasGradientStudioSurface
        v-if="gradientStudioOpenForId"
        :node-id="gradientStudioOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="gradientStudioOpenForId = null"
      />
    </Teleport>

    <!-- Moodboard modal (brand-guidelines document; the library owns the entry,
         the node only references it via properties.sailor_moodboard) -->
    <Teleport to="body">
      <VueCanvasMoodboardModal
        v-if="moodboardOpenForId"
        :node-id="moodboardOpenForId"
        :nodes="nodes as any[]"
        @close="moodboardOpenForId = null"
      />
    </Teleport>

    <!-- Texture Studio editor modal (frontend-only config node) -->
    <Teleport to="body">
      <VueCanvasTextureStudioSurface
        v-if="textureStudioOpenForId"
        :node-id="textureStudioOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="textureStudioOpenForId = null"
      />
    </Teleport>

    <!-- Shader Studio editor modal (frontend-only config node) -->
    <Teleport to="body">
      <VueCanvasShaderStudioSurface
        v-if="shaderStudioOpenForId"
        :node-id="shaderStudioOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        :wired-url="shaderStudioWiredUrl"
        @close="shaderStudioOpenForId = null"
      />
    </Teleport>

    <!-- Shape Studio editor modal (frontend-only config node) -->
    <Teleport to="body">
      <VueCanvasShapeStudioSurface
        v-if="shapeStudioOpenForId"
        :node-id="shapeStudioOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="shapeStudioOpenForId = null"
      />
    </Teleport>

    <!-- Vector Type editor modal (frontend-only config node). `edges` is passed
         as well as `nodes`: the surface's Collection bind/sweep menu resolves
         its wired collection by walking VARS edges. -->
    <Teleport to="body">
      <VueCanvasVectorTypeSurface
        v-if="vectorTypeOpenForId"
        :node-id="vectorTypeOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="vectorTypeOpenForId = null"
      />
    </Teleport>

    <!-- Dev-only live WebGL context counter (vs the browser cap that, once
         exceeded, silently kills the oldest context — a studio/node "crash"). -->
    <Teleport to="body">
      <VueCanvasWebGLContextBadge />
    </Teleport>

    <!-- Scene3D Studio editor modal (real backend node — bakes into widgets) -->
    <Teleport to="body">
      <VueCanvasScene3DStudioSurface
        v-if="scene3dStudioOpenForId"
        :node-id="scene3dStudioOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="scene3dStudioOpenForId = null"
      />
    </Teleport>

    <!-- Shot Director editor modal (frontend-only config node) -->
    <Teleport to="body">
      <ShotDirectorSurface
        v-if="shotDirectorOpenForId"
        :node-id="shotDirectorOpenForId"
        :nodes="nodes as any[]"
        @close="shotDirectorOpenForId = null"
      />
    </Teleport>

    <!-- Lip-Sync Studio editor modal (frontend-only config node) -->
    <Teleport to="body">
      <LipSyncSurface
        v-if="lipSyncOpenForId"
        :node-id="lipSyncOpenForId"
        :nodes="nodes as any[]"
        @close="lipSyncOpenForId = null"
      />
    </Teleport>

    <!-- Inpaint editor modal -->
    <Teleport to="body">
      <VueCanvasInpaintModal
        v-if="inpaintOpenForId"
        :node-id="inpaintOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        :intent="inpaintIntent"
        @close="inpaintOpenForId = null; inpaintIntent = null"
      />
    </Teleport>

    <!-- Pose Mannequin 3D editor modal -->
    <Teleport to="body">
      <VueCanvasPoseEditorModal
        v-if="poseOpenForId"
        :node-id="poseOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="poseOpenForId = null"
      />
    </Teleport>

    <!-- ASCII options right drawer -->
    <Teleport to="body">
      <VueCanvasAsciiPanel
        v-if="asciiOpenForId"
        :node-id="asciiOpenForId"
        :nodes="nodes as any[]"
        @close="asciiOpenForId = null"
      />
    </Teleport>

    <!-- Timeline editor (full-screen multi-track) -->
    <Teleport to="body">
      <VueCanvasTimelineEditor
        v-if="timelineOpenForId"
        :node-id="timelineOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="timelineOpenForId = null"
      />
    </Teleport>

    <!-- Crossfade editor modal -->
    <Teleport to="body">
      <VueCanvasCrossfadeModal
        v-if="crossfadeOpenForId"
        :node-id="crossfadeOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="crossfadeOpenForId = null"
      />
    </Teleport>

    <!-- Collection bottom drawer (table editor) -->
    <Teleport to="body">
      <VueCanvasCollectionDrawer
        v-if="collectionDrawerForId"
        :key="collectionDrawerForId"
        :node-id="collectionDrawerForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        :pending-sweep="pendingSweep"
        @close="collectionDrawerForId = null"
        @sweep-consumed="pendingSweep = null"
      />
    </Teleport>

    <!-- SmartLayout visual editor modal -->
    <Teleport to="body">
      <VueCanvasSmartLayoutEditorModal
        v-if="smartLayoutOpenForId"
        :node-id="smartLayoutOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        @close="smartLayoutOpenForId = null"
      />
    </Teleport>

    <!-- Smart Layout batch export sheet (cartesian formats × variables) -->
    <Teleport to="body">
      <VueCanvasBatchExportModal
        v-if="batchExportOpenForId"
        :node-id="batchExportOpenForId"
        :nodes="nodes as any[]"
        :edges="edges as any[]"
        :template-override="batchExportTemplate"
        @close="batchExportOpenForId = null; batchExportTemplate = null"
        @spawn="handleBatchSpawn"
      />
    </Teleport>

    <!-- BatchGrid gallery (canvas-owned; opened by sailor:openBatchGallery) -->
    <Teleport to="body">
      <VueCanvasBatchGridModal
        v-if="batchGalleryPayload"
        :payload="batchGalleryPayload"
        @close="batchGalleryForId = null"
      />
    </Teleport>

    <!-- Sketch stack overlay (canvas-owned; opened by sailor:openSketchStack).
         Teleported like the BatchGrid gallery so the prompt bar / toolbar
         (later fixed elements in the canvas tree) can't paint over it. -->
    <Teleport to="body">
      <VueCanvasSketchStackOverlay
        v-if="sketchStackPayload && sketchStackOrigin"
        :payload="sketchStackPayload"
        :origin="sketchStackOrigin"
        :can-reroll="sketchStackCanReroll"
        @develop="developSketchStackItem"
        @keep="keepSketchStackItem"
        @reroll="rerollSketchStack"
        @close="sketchStackForId = null"
      />
    </Teleport>

    <!-- Prompt-bar sketch review strip: four fresh sketches, reviewed before
         any land on the canvas. Teleported like the sketch-stack overlay
         above so the prompt bar / toolbar can't paint over it; docked
         directly above the REAL bottom-center bar stack
         (layouts/default.vue's `[data-testid="canvas-bottom-bar-stack"]`),
         measured live via sketchStripDockStyle since that stack's height is
         dynamic (the agent prompt bar grows upward with a result panel). -->
    <Teleport to="body">
      <div
        v-if="sketchReview.open"
        class="pointer-events-auto fixed z-40"
        :style="sketchStripDockStyle"
      >
        <VueCanvasSketchReviewStrip
          :images="sketchReview.images"
          :selected="sketchReview.selected"
          :busy="sketchReviewBusy"
          :error="sketchReview.error"
          @select="onSketchSelect"
          @keep="onSketchKeep"
          @cancel="onSketchCancel"
          @reroll="onSketchReroll"
          @drop-at="onSketchDropAt"
        />
      </div>
    </Teleport>

    <!-- Model gallery (image generator model picker) -->
    <VueCanvasModelGalleryModal
      v-if="modelGalleryOpenForId"
      :node-id="modelGalleryOpenForId"
      :nodes="nodes as any[]"
      @close="modelGalleryOpenForId = null"
    />

    <!-- LoRA gallery — opened from the FluxLoRARemoteNode lora_name launcher. -->
    <VueCanvasLoraGalleryModal
      v-if="loraGalleryOpenForId"
      :node-id="loraGalleryOpenForId"
      :nodes="nodes as any[]"
      :widget-name="loraGalleryWidgetName"
      :kind="loraGalleryKind"
      @close="loraGalleryOpenForId = null"
    />

    <!-- Voice gallery — opened from the Generate speech voice_id launcher. -->
    <VueCanvasVoiceGalleryModal
      v-if="voiceGalleryOpenForId"
      :node-id="voiceGalleryOpenForId"
      :nodes="nodes as any[]"
      :widget-name="voiceGalleryWidgetName"
      :options="voiceGalleryOptions"
      @close="voiceGalleryOpenForId = null"
    />

    <!-- Video model gallery — opened from the GenerateVideoNode launcher. -->
    <VueCanvasVideoModelGalleryModal
      v-if="videoModelGalleryOpenForId"
      :node-id="videoModelGalleryOpenForId"
      :nodes="nodes as any[]"
      @close="videoModelGalleryOpenForId = null"
    />

    <!-- Text effect gallery — opened from the TextEffectNode launcher. -->
    <VueCanvasTextEffectGalleryModal
      v-if="textEffectGalleryOpenForId"
      :node-id="textEffectGalleryOpenForId"
      :nodes="nodes as any[]"
      @close="textEffectGalleryOpenForId = null"
    />

    <!-- Shot preset gallery — opened from the FilmShotNode launcher. -->
    <VueCanvasShotPresetGalleryModal
      v-if="shotPresetGalleryOpenForId"
      :node-id="shotPresetGalleryOpenForId"
      :nodes="nodes as any[]"
      @close="shotPresetGalleryOpenForId = null"
    />

    <!-- Port intent popover — port click / wire-drop-on-canvas. -->
    <PortIntentPopover
      v-if="portIntent"
      :anchor="portIntent.anchor"
      :screen="portIntent.screen"
      :ai-state="portIntentAiState"
      :ai-error="portIntentAiError"
      :ai-note="portIntentAiNote"
      @select-node="handlePortIntentSelect"
      @ask-ai="handlePortIntentAi"
      @close="portIntent = null"
    />

    <!-- Lookup match-column picker — opened when a LOOKUP edge lands between
         two collections that don't share a same-named key. -->
    <LookupMatchPicker v-if="lookupPicker" :foreign="lookupPicker.foreign" :local="lookupPicker.local"
      :anchor="lookupPicker.anchor" @apply="applyLookupMatch" @close="cancelLookupMatch" />
  </div>
</template>

<style>
/* Override Vue Flow defaults to match Sailor dark theme */
.vue-node-canvas .vue-flow__node {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  box-shadow: none;
}

.vue-node-canvas .vue-flow__node.selected .comfy-node {
  outline: 2px solid var(--action);
  outline-offset: 1px;
}

/* Artifact cards use their own root classes (not .comfy-node), so the rule
   above never reached them — they got selected on click but showed no ring,
   which read as "can't select". Mirror the highlight on every artifact root. */
.vue-node-canvas .vue-flow__node.selected .artifact-image,
.vue-node-canvas .vue-flow__node.selected .artifact-video,
.vue-node-canvas .vue-flow__node.selected .artifact-audio,
.vue-node-canvas .vue-flow__node.selected .artifact-text,
.vue-node-canvas .vue-flow__node.selected .artifact-frame-node,
.vue-node-canvas .vue-flow__node.selected .artifact-timeline {
  outline: 2px solid var(--action);
  outline-offset: 3px;
  border-radius: 12px;
}

/* Studio cards (Type/Gradient/Shader/Shape/Texture/3D/Lip-Sync/Shot Director)
   share the .studio-node root class for the same reason: without it they
   selected on click but showed no ring. */
.vue-node-canvas .vue-flow__node.selected .studio-node {
  outline: 2px solid var(--action);
  outline-offset: 3px;
  border-radius: 12px;
}

/* A capsule that has just expanded must sit above its neighbours, or the card
   it grew into is clipped by whatever is drawn after it. There is no tracked
   hover state on the canvas (hoverNodeIds is the agent proposal highlight, not
   the mouse), so this is done in CSS.
   The `:has(.node-capsule:hover)` half only covers the moment BEFORE the
   click: the instant the card expands, .node-capsule is gone from the subtree
   and the selector stops matching — which is precisely when the raise is
   needed. `.comfy-node-pinned-open` is the class ComfyNode puts on its root
   for as long as an expanded card is pinned, so the second half carries it
   through the state the comment is actually about. */
.vue-flow__node:has(.node-capsule:hover),
.vue-flow__node:has(.comfy-node-pinned-open) {
  z-index: 20 !important;
}

.vue-node-canvas .vue-flow__edge.selected path {
  filter: drop-shadow(0 0 4px currentColor);
}

.vue-node-canvas .vue-flow__handle {
  background: transparent;
  border: none;
}

.vue-node-canvas {
  background-color: transparent;
}

/* Keep the trackpad's horizontal swipe-to-navigate gesture from leaking out
   of the canvas pane and triggering browser back/forward while panning. */
.vue-node-canvas-root,
.vue-node-canvas,
.vue-node-canvas .vue-flow__pane,
.vue-node-canvas .vue-flow__viewport {
  overscroll-behavior: none;
}

/* Connection line while dragging */
.vue-node-canvas .vue-flow__connection-line path {
  stroke: var(--action);
  stroke-width: 2;
  stroke-dasharray: 5;
}

/* MiniMap positioning: sit above the zoom toolbar, right-aligned */
.vue-node-canvas .comfy-minimap.vue-flow__panel {
  bottom: 52px !important;
  right: 0 !important;
  margin-right: 12px !important;
  margin-bottom: 0 !important;
  border-radius: 12px !important;
  overflow: hidden;
}

/* Floating style toolbar shown above the currently-selected arrow. */
.arrow-style-toolbar__swatch {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  transition: transform 80ms, box-shadow 80ms;
}
.arrow-style-toolbar__swatch:hover {
  transform: scale(1.12);
}
.arrow-style-toolbar__swatch--active {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}

/* Thickness button: a horizontal bar at the chosen thickness. Subtle, but
   matches what the bar will look like when applied. */
.arrow-style-toolbar__thickness {
  width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  transition: background 80ms;
}
.arrow-style-toolbar__thickness:hover {
  background: rgba(255, 255, 255, 0.08);
}
.arrow-style-toolbar__thickness--active {
  background: rgba(255, 255, 255, 0.14);
}
.arrow-style-toolbar__thickness > span {
  display: block;
  width: 16px;
  border-radius: 2px;
}

.arrow-style-toolbar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  border-radius: 4px;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: background 80ms, color 80ms;
}
.arrow-style-toolbar__btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}
.arrow-style-toolbar__btn--danger:hover {
  background: rgba(220, 38, 38, 0.3);
  color: rgb(254, 202, 202);
}

</style>
